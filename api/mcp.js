/* MouseFlow over HTTPS, so the decider can be anywhere and still only ever see one account.
 *
 *   POST /api/mcp                    JSON-RPC 2.0. initialize, ping, tools/list, tools/call
 *   GET  /api/mcp                    a sentence for whoever opened the URL in a browser
 *   POST /api/mcp?worker=claim       a worker on somebody's machine takes the next job  (long-polls)
 *   POST /api/mcp?worker=report      ...and says how it went
 *   GET  /api/mcp?worker=state&id=   ...and asks whether it has been cancelled meanwhile
 *
 * WHY THIS EXISTS BESIDE mcp/server.mjs. That one runs on the user's machine over stdio, which is why it can
 * run anything: the agent listens on loopback and only something on that machine can reach it. It also means
 * one person, one terminal. This is the same tools reachable from Claude on a phone, in a browser, in
 * somebody else's editor - and reachable is the whole problem, because a serverless function cannot dial into
 * anybody's desktop and nothing on the internet should be able to.
 *
 * So the desktop dials out. A tools/call becomes a row in run_queue; a worker on the user's own machine
 * claims it, runs it through the agent it can already reach, and reports back; this waits and answers with
 * what the worker said. The direction of the connection never reverses. A machine with no worker running
 * claims nothing, and the caller is told exactly that rather than left waiting.
 *
 * IDENTITY IS THE POINT. Every request resolves ONE user through whoIsCalling - a session cookie, or the
 * device token the extension already pairs with - and every query filters on that id inside the WHERE
 * clause. There is no route here that takes a user id, and no code path that reads one from the request
 * body. A model-supplied user id is the whole bug class: one hallucinated uuid and this becomes a way to
 * list, or run, somebody else's skills. So the id arrives once, from the credential, and the credential is
 * the only thing that says who anybody is.
 *
 * That is also the answer to "each person in an organisation sees only themselves": each person adds this
 * with their OWN token, and sees their own skills. The one thing to be careful of is a connector installed
 * once for a whole organisation with a single shared header - everyone on it would share one account, which
 * is not multi-tenancy, it is one tenant with many users. The fix for that is OAuth, so the connector
 * identifies the person rather than the installation; the 401 below already advertises where that will live
 * (RFC 9728), and until it exists this is per-person-token.
 *
 * WHAT IT CANNOT SEE. The local agent. Whether it is running, what version, whether a replay is playing -
 * all of that is loopback and this is not on that machine. `mouseflow_status` reports what the ACCOUNT
 * knows and says plainly which half it cannot see, rather than guessing.
 */

import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { whoIsCalling } from './_session.js';
import { structureOf, wireFor } from './_skill-schema.mjs';
import { flowBody, parseMacro, summarize } from './_macro.mjs';
import { flowFor } from './_flow-for.mjs';

const SPOKEN = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const NEWEST = '2025-06-18';
const SERVER = { name: 'mouseflow', version: '0.2.0' };

/* How long a tools/call waits for a machine to do the work before it answers "still going". Bounded well
 * under the function's own limit, because an answer that arrives as a gateway timeout is not an answer. */
const CALL_WAIT_MS = 110_000;
const CALL_POLL_MS = 1_500;
/* And how long a worker's claim request may hold open with nothing to do. One request every half minute
 * beats one every three seconds, and an idle loop is not billed as CPU. */
const CLAIM_WAIT_MAX_MS = 25_000;
const CLAIM_POLL_MS = 1_000;
/* A job a worker took and never reported. Not returned to the pool - a run that may be half-done must not
 * be repeated blind - so it is failed with a reason. */
const CLAIM_STALE_MS = 45 * 60 * 1000;

function cors(req, res) {
  const origin = req.headers.origin || '';
  /* An MCP client is not a browser page and sends no Origin; the ones that do are our own app and the
   * extension. Same rule as every other route here, and no Allow-Credentials, which is what stops a
   * cross-site page spending somebody's session. */
  res.setHeader('Access-Control-Allow-Origin',
    /^chrome-extension:\/\//.test(origin) ? origin : 'https://mouse-agent.vercel.app');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, mcp-session-id, mcp-protocol-version');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/** RFC 6750 / RFC 9728: say it is a bearer resource and where the authorisation server will be found. */
function unauthorized(req, res, why) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'mouse-agent.vercel.app';
  const resource = `https://${host}/api/mcp`;
  res.setHeader('WWW-Authenticate',
    `Bearer realm="MouseFlow", resource_metadata="https://${host}/.well-known/oauth-protected-resource"`
    + (why ? `, error="invalid_token", error_description="${why}"` : ''));
  res.status(401).json({
    error: why || 'missing_token',
    resource,
    hint: 'Send Authorization: Bearer <device token>. Mint one in the app under Settings → My account. '
      + 'Each person uses their own, and sees only their own skills.',
  });
}

const rpc = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const say = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

/* ------------------------------------------------------------------------------- the account */

const STATUS_TOOL = {
  name: 'mouseflow_status',
  description: 'What this MouseFlow account holds and whether a machine is listening for work: the number '
    + 'of skills, whether a worker has been seen recently, and anything queued or running. Ask this first '
    + 'when a skill call says nothing picked it up.',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

const STOP_TOOL = {
  name: 'mouseflow_stop',
  description: 'Cancel MouseFlow work that is queued or running on the user\'s machine. Safe to call when '
    + 'nothing is happening.',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

const RUN_STATUS_TOOL = {
  name: 'mouseflow_run_status',
  description: 'How a run that was still going is getting on. Only needed when a skill call came back '
    + 'saying it had not finished; it names the run id to pass here.',
  inputSchema: {
    type: 'object',
    properties: { run: { type: 'string', description: 'The run id the earlier answer named.' } },
    required: ['run'],
    additionalProperties: false,
  },
};

/* ------------------------------------------------------------------------------- reading the account
 *
 * These need nothing on anybody's machine. A recording, a run and the time they took are rows, and rows are
 * here - so the analysis half of this server works the moment a connector is added, with no worker, no
 * agent, and nothing to keep running. That is worth stating because it is the opposite of the run half,
 * which cannot happen without a machine, and the two arriving through one connector would otherwise look
 * like one capability with an intermittent fault.
 *
 * Metadata and prose, never a payload. There is no tool here that hands over raw events: the transcript is
 * the derivation api/_transcript.js already makes for the panel, which is written to be read.
 */

const RECORDINGS_TOOL = {
  name: 'mouseflow_recordings',
  description: 'What is on this MouseFlow account: recordings, and the skills made from them. Names, sizes, '
    + 'where they happened and when. Start here when the question is "what have I got".',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['all', 'recording', 'skill'],
        default: 'all',
        description: 'A recording is what was captured; a skill is a copy of one meant to be handed over.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
    required: [],
    additionalProperties: false,
  },
};

const TRANSCRIPT_TOOL = {
  name: 'mouseflow_transcript',
  description: 'One recording, step by step, in words: what was clicked, in which application and window, '
    + 'how long each part took, and what the recording cannot answer. Takes an id from mouseflow_recordings.',
  inputSchema: {
    type: 'object',
    properties: {
      recording: { type: 'string', description: 'The id from mouseflow_recordings.' },
      steps: { type: 'integer', minimum: 1, maximum: 400, default: 120, description: 'How many steps to return.' },
    },
    required: ['recording'],
    additionalProperties: false,
  },
};

const RUNS_TOOL = {
  name: 'mouseflow_runs',
  description: 'Runs on this account: what was asked for, which model drove it, how it ended and how long it '
    + 'took. The record of what has actually been automated, as opposed to what could be.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
      outcome: { type: 'string', enum: ['any', 'ok', 'failed', 'stopped'], default: 'any' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
    required: [],
    additionalProperties: false,
  },
};

const ACTIVITY_TOOL = {
  name: 'mouseflow_activity',
  description: 'The account in numbers over a window: how much was recorded and for how long, how many runs '
    + 'and how they ended, and which applications the work happened in. For "where is my time going".',
  inputSchema: {
    type: 'object',
    properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
    required: [],
    additionalProperties: false,
  },
};

/* ------------------------------------------------------------------------------- the timer
 *
 * Recording is the one thing on this list that is not a row: it is the agent watching the machine, so it
 * goes through the queue exactly as a skill run does, and needs the same thing listening. The two tools are
 * separate rather than one with a boolean, because "stop" is the one somebody reaches for in a hurry and a
 * tool that could start a recording when they meant to stop one is a bad trade for one fewer entry. */

const START_TOOL = {
  name: 'mouseflow_start_recording',
  description: 'Start recording on the machine this account is paired with — the timer the app shows. It '
    + 'captures clicks, drags, scrolls and pointer movement, and THAT a key was pressed, never which key. '
    + 'Nothing is captured until this is called and it stops the moment recording stops.',
  inputSchema: {
    type: 'object',
    properties: {
      moveMs: {
        type: 'integer', minimum: 0, maximum: 1000, default: 0,
        description: 'How coarsely to sample pointer movement, in milliseconds. 0 keeps every sample; 40 is '
          + 'plenty for a long session and keeps it small.',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

const STOP_RECORDING_TOOL = {
  name: 'mouseflow_stop_recording',
  description: 'Stop the recording running on the paired machine and save it to this account. Answers with '
    + 'what was captured.',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

/* A queue job that is an instruction to the agent rather than a skill. Marked by the flow id, so the claim
 * path can tell at a glance that there is no flow to look up. */
const AGENT_JOBS = {
  [START_TOOL.name]: '#record.start',
  [STOP_RECORDING_TOOL.name]: '#record.stop',
};

const READ_TOOLS = [RECORDINGS_TOOL, TRANSCRIPT_TOOL, RUNS_TOOL, ACTIVITY_TOOL];

/** The caller's skills, stamped ones only, with their derived tool definitions. */
async function skillsOf(sql, userId) {
  const rows = await sql`
    select client_id, source, kind, name, description, payload, origins
    from user_flow
    where user_id = ${userId} and deleted_at is null
    order by updated_at desc
  `;
  const skills = [];
  let unstamped = 0;
  for (const row of rows) {
    const role = row.payload && typeof row.payload.role === 'string' ? row.payload.role : null;
    if (role === 'recording') continue;
    /* Stamped skills only, and deliberately stricter than the Skills page, which lists an unstamped row AS
     * a skill so that nothing anybody made before the stamp existed vanishes from their library. That
     * default is right for a page somebody reads and wrong for a tool list, which is read by something that
     * will CALL what is in it. The count is reported by mouseflow_status, so what is left out is visible. */
    if (role !== 'skill') { unstamped++; continue; }
    skills.push({
      id: row.client_id,
      source: row.source,
      kind: row.kind,
      name: row.name,
      description: row.description,
      payload: row.payload,
      origins: row.origins,
    });
  }
  return { skills, unstamped };
}

/** Tool name -> skill. Names are near-unique by construction; a collision is still handled. */
function tableOf(skills) {
  const table = new Map();
  for (const flow of skills) {
    const structure = structureOf(flow);
    let name = structure.toolName;
    if (table.has(name)) {
      let n = 2;
      while (table.has(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
    }
    table.set(name, { flow, structure });
  }
  return table;
}

/* ------------------------------------------------------------------------------- the queue */

/* Said in three different failures, so it is written once: an instruction that drifts between messages is
 * an instruction somebody follows to two different places. */
const WHERE = 'open MouseFlow, click your avatar at the bottom of the sidebar, then Connections, then '
  + '"Let Claude drive this computer"';

const jobId = () => `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Whether a machine has asked for work lately, and when. */
async function workerSeen(sql, userId) {
  try {
    const rows = await sql`
      select value from user_pref where user_id = ${userId} and key = 'worker.seen'
    `;
    if (!rows.length) return null;
    const at = new Date(rows[0].value);
    return Number.isFinite(at.getTime()) ? at : null;
  } catch (_) {
    /* No table on this deployment yet. Absent is not false: it means nothing is known, and the caller is
     * told that rather than told there is no worker. */
    return undefined;
  }
}

async function stampWorker(sql, userId) {
  try {
    await sql`
      insert into user_pref (user_id, key, value) values (${userId}, 'worker.seen', ${new Date().toISOString()})
      on conflict (user_id, key) do update set value = excluded.value, updated_at = now()
    `;
  } catch (_) { /* the stamp is a convenience, never a precondition */ }
}

/* ------------------------------------------------------------------------------- the tools */

/* ------------------------------------------------------------------------------- the read tools */

const ago = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : 'unknown');

async function readRecordings(sql, who, args) {
  const want = ['recording', 'skill'].includes(args.kind) ? args.kind : 'all';
  const limit = Math.min(200, Math.max(1, Math.round(Number(args.limit) || 50)));
  const rows = await sql`
    select client_id, name, description, source, kind, origins, updated_at,
           payload->>'role' as role,
           jsonb_array_length(coalesce(payload->'events', '[]'::jsonb)) as events
    from user_flow
    where user_id = ${who.id} and deleted_at is null
    order by updated_at desc limit ${limit}
  `;
  const kindOf = (r) => (r.role === 'skill' ? 'skill' : r.role === 'recording' ? 'recording' : 'unmarked');
  const shown = rows.filter((r) => want === 'all' || kindOf(r) === want);
  if (!shown.length) return say(want === 'all' ? 'Nothing on this account yet.' : `No ${want}s on this account.`);

  const lines = shown.map((r) => {
    const where = Array.isArray(r.origins) && r.origins.length ? ` in ${r.origins.slice(0, 3).join(', ')}` : '';
    return `${r.client_id}  ${r.name || 'untitled'}\n`
      + `    ${kindOf(r)} · ${r.source || 'unknown'} · ${r.events} events${where} · ${day(r.updated_at)}`
      + (r.description ? `\n    ${r.description}` : '');
  });
  return say(`${shown.length} of ${rows.length} shown, newest first.\n\n${lines.join('\n')}`);
}

async function readTranscript(sql, who, args) {
  const id = String(args.recording || '');
  if (!id) return say('Which recording? Pass an id from mouseflow_recordings.', true);
  const [row] = await sql`
    select client_id, name, kind, source, payload, origins
    from user_flow where user_id = ${who.id} and client_id = ${id} and deleted_at is null
  `;
  if (!row) return say(`There is nothing called "${id}" on this account.`, true);

  /* Lazily, for the reason api/chat.js states about the same module: a static import of a file that may not
   * be on a given deploy takes the importing route down with it, and one missing file must not stop the
   * tools that have nothing to do with transcripts. */
  let transcribe;
  try {
    ({ transcribe } = await import('./_transcript.js'));
  } catch (err) {
    return say(`The transcript engine could not be loaded on this deployment: ${err.message}`, true);
  }

  const t = transcribe(row);
  const cap = Math.min(400, Math.max(1, Math.round(Number(args.steps) || 120)));
  const out = [];
  out.push(`${t.flow?.name || row.name} — ${t.summary?.events ?? 0} events, `
    + `${t.summary?.clicks ?? 0} clicks, ${t.summary?.seconds ?? 0}s, `
    + `${t.summary?.applications ?? 0} applications.`);

  let shown = 0;
  let dropped = 0;
  for (const seg of t.segments || []) {
    const where = seg.where && seg.where.label ? seg.where.label : 'somewhere';
    out.push(`\n— ${where}`);
    for (const step of seg.steps || []) {
      if (shown >= cap) { dropped++; continue; }
      shown++;
      out.push(`  ${step.n}. ${step.what}${step.control ? ` [${step.control}]` : ''}`);
    }
  }
  /* Silent truncation reads as "that is all of it". */
  if (dropped) out.push(`\n${dropped} further steps not shown — ask for more with a bigger \`steps\`.`);

  if ((t.gaps || []).length) {
    out.push('\nWhat this recording cannot answer:');
    for (const gap of t.gaps) out.push(`  · ${gap.question} — ${gap.why}`);
  }
  return say(out.join('\n'));
}

async function readRuns(sql, who, args) {
  const days = Math.min(365, Math.max(1, Math.round(Number(args.days) || 30)));
  const limit = Math.min(200, Math.max(1, Math.round(Number(args.limit) || 50)));
  const wanted = ['ok', 'failed', 'stopped'].includes(args.outcome) ? args.outcome : null;
  const rows = await sql`
    select client_id, kind, goal, model, flow_id, outcome, summary, error, started_at, finished_at
    from user_run
    where user_id = ${who.id} and started_at >= ${ago(days)}
      and (${wanted}::text is null or outcome = ${wanted})
    order by started_at desc limit ${limit}
  `;
  if (!rows.length) return say(`No runs in the last ${days} days${wanted ? ` that ended "${wanted}"` : ''}.`);

  const lines = rows.map((r) => {
    const took = r.started_at && r.finished_at
      ? `${Math.max(0, Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000))}s`
      : 'unknown';
    return `${day(r.started_at)}  ${r.outcome.padEnd(7)} ${took.padStart(6)}  ${r.kind}`
      + `${r.model ? ` · ${r.model}` : ''}\n    ${(r.goal || '(no goal recorded)').slice(0, 160)}`
      + (r.error ? `\n    failed: ${String(r.error).slice(0, 200)}` : '');
  });
  return say(`${rows.length} runs in the last ${days} days, newest first.\n\n${lines.join('\n')}`);
}

async function readActivity(sql, who, args) {
  const days = Math.min(365, Math.max(1, Math.round(Number(args.days) || 30)));
  const since = ago(days);
  const [made] = await sql`
    select count(*) filter (where payload->>'role' is distinct from 'skill')::int as recordings,
           count(*) filter (where payload->>'role' = 'skill')::int as skills,
           coalesce(sum(jsonb_array_length(coalesce(payload->'events', '[]'::jsonb))), 0)::int as events
    from user_flow where user_id = ${who.id} and deleted_at is null and updated_at >= ${since}
  `;
  const outcomes = await sql`
    select outcome, count(*)::int as n,
           coalesce(sum(extract(epoch from (finished_at - started_at))), 0)::int as seconds
    from user_run where user_id = ${who.id} and started_at >= ${since}
    group by outcome order by n desc
  `;
  const apps = await sql`
    select lower(o) as app, count(*)::int as n
    from user_flow, unnest(coalesce(origins, array[]::text[])) as o
    where user_id = ${who.id} and deleted_at is null and updated_at >= ${since}
    group by lower(o) order by n desc limit 8
  `;

  const runs = outcomes.reduce((n, r) => n + r.n, 0);
  const ok = outcomes.find((r) => r.outcome === 'ok');
  const seconds = outcomes.reduce((n, r) => n + r.seconds, 0);
  const lines = [
    `Last ${days} days.`,
    `Recorded: ${made.recordings} recording${made.recordings === 1 ? '' : 's'} and ${made.skills} `
      + `skill${made.skills === 1 ? '' : 's'}, ${made.events} events between them.`,
    runs
      ? `Runs: ${runs}, of which ${ok ? ok.n : 0} finished ok`
        + ` (${outcomes.map((r) => `${r.outcome} ${r.n}`).join(', ')}), `
        + `${Math.round(seconds / 60)} minutes of running time.`
      : 'Runs: none.',
    apps.length ? `Where the work was: ${apps.map((a) => `${a.app} (${a.n})`).join(', ')}.` : '',
    /* Named rather than left to be inferred from a small number: this counts what the account HOLDS, and a
     * recording deleted last week is not in it. */
    'Counted from what the account holds now — anything deleted since is not in these numbers.',
  ].filter(Boolean);
  return say(lines.join('\n'));
}

/* ------------------------------------------------------------------------------- the tools */

async function callTool(sql, who, params, req) {
  const asked = params && params.name;
  const args = (params && params.arguments) || {};

  if (asked === RECORDINGS_TOOL.name) return readRecordings(sql, who, args);
  if (asked === TRANSCRIPT_TOOL.name) return readTranscript(sql, who, args);
  if (asked === RUNS_TOOL.name) return readRuns(sql, who, args);
  if (asked === ACTIVITY_TOOL.name) return readActivity(sql, who, args);

  if (asked === STATUS_TOOL.name) {
    const { skills, unstamped } = await skillsOf(sql, who.id);
    const seen = await workerSeen(sql, who.id);
    const busy = await sql`
      select id, tool_name, state, created_at from run_queue
      where user_id = ${who.id} and state in ('queued', 'claimed')
      order by created_at limit 10
    `;
    const lines = [];
    lines.push(`${skills.length} skill${skills.length === 1 ? '' : 's'} on this account, of which `
      + `${skills.filter((s) => s.source === 'desktop').length} run on a desktop and `
      + `${skills.filter((s) => s.source !== 'desktop').length} in the browser extension.`);
    if (seen === undefined) {
      lines.push('Whether a machine is listening cannot be read on this deployment.');
    } else if (!seen) {
      lines.push('No machine has ever asked this account for work. To let one, ' + WHERE + '. '
        + 'It takes one click and nothing is typed or copied.');
    } else {
      const ago = Math.round((Date.now() - seen.getTime()) / 1000);
      lines.push(ago < 90
        ? `A machine is listening for work (last asked ${ago}s ago).`
        : `No machine has asked for work in ${Math.round(ago / 60)} minutes, so a call would sit in the `
          + 'queue. That computer may be asleep or off, or it may have stopped taking work - the switch is '
          + "in the MouseFlow agent's own menu bar, the cursor icon at the top of the screen.");
    }
    if (busy.length) {
      lines.push(`Queued or running: ${busy.map((b) => `${b.tool_name || b.id} (${b.state})`).join(', ')}.`);
    }
    if (unstamped) {
      lines.push(`${unstamped} row${unstamped === 1 ? '' : 's'} on the account are not marked as either a `
        + 'recording or a skill, and are not offered as tools. Saving them again in the app stamps them.');
    }
    lines.push('What this cannot see: the agent itself. It listens on the machine\'s own loopback, and this '
      + 'is not on that machine.');
    return say(lines.join('\n'));
  }

  if (asked === STOP_TOOL.name) {
    const killed = await sql`
      update run_queue set state = 'cancelled', finished_at = now(),
             ok = false, said = 'cancelled before it finished'
      where user_id = ${who.id} and state in ('queued', 'claimed')
      returning id
    `;
    return say(killed.length
      ? `Cancelled ${killed.length} job${killed.length === 1 ? '' : 's'}. A run already under way stops at `
        + 'the next step the worker checks, which is within a second or two.'
      : 'Nothing was queued or running.');
  }

  if (asked === RUN_STATUS_TOOL.name) {
    const id = String(args.run || '');
    const rows = await sql`
      select state, ok, said, finished_at from run_queue where id = ${id} and user_id = ${who.id}
    `;
    if (!rows.length) return say(`There is no run "${id}" on this account.`, true);
    const job = rows[0];
    if (job.state === 'queued') return say('Still waiting for a machine to pick it up.');
    if (job.state === 'claimed') return say('A machine has it and is working on it.');
    return say(job.said || (job.ok ? 'Done.' : 'It did not finish.'), !job.ok);
  }

  /* The timer, and skills. Both are the same thing from here: something only a machine can do, so it goes
   * on the queue and this waits for the answer. */
  if (AGENT_JOBS[asked]) {
    return queueAndWait(sql, who, { flowId: AGENT_JOBS[asked], toolName: asked, args });
  }

  const { skills } = await skillsOf(sql, who.id);
  const entry = tableOf(skills).get(asked);
  if (!entry) {
    return say(`There is no skill called "${asked}" on this account any more. The list of skills has `
      + 'changed; ask for the tool list again.', true);
  }
  if (entry.structure.runner !== 'agent') {
    return say(`"${entry.flow.name}" aims at elements in a web page, so the MouseFlow browser extension is `
      + 'the half that can replay it. A worker drives the desktop agent, which has no page to aim at. Ask '
      + 'the user to run it from the extension.', true);
  }
  return queueAndWait(sql, who, { flowId: entry.flow.id, toolName: asked, args });
}

/* Put it on the queue and wait for the machine.
 *
 * One path for a skill and for the timer, because the difference between them is what the worker does with
 * the row, not how it gets there. Waiting rather than returning an id is the point: a tool that comes back
 * before the work happened has told the caller nothing, and the answer says plainly when the wait ran out
 * rather than reporting a success nobody saw. */
async function queueAndWait(sql, who, { flowId, toolName, args }) {
  const seen = await workerSeen(sql, who.id);
  if (seen === null) {
    /* The whole of what somebody has to do, in the answer they are already reading.
     *
     * This used to name a worker and a command. That was true for a week and is the wrong advice now - and a
     * stale instruction in a failure message is worse than none: it sends the person somewhere that does not
     * exist, and they conclude the product is broken rather than that the sentence is. */
    return say('This account has no computer listening, so there is nothing to run this on. To let one: '
      + WHERE + ". It takes one click - nothing to type, nothing to copy - and the agent's own menu bar is "
      + 'where you switch it off again. Nothing was queued.', true);
  }

  const already = await sql`
    select id, tool_name from run_queue where user_id = ${who.id} and state in ('queued', 'claimed') limit 1
  `;
  if (already.length) {
    return say(`MouseFlow is already busy on that machine (${already[0].tool_name || already[0].id}). One `
      + 'thing at a time - there is one mouse. Wait for it, or call mouseflow_stop.', true);
  }

  const id = jobId();
  await sql`
    insert into run_queue (id, user_id, flow_id, tool_name, args)
    values (${id}, ${who.id}, ${flowId}, ${toolName}, ${JSON.stringify(args || {})})
  `;

  const until = Date.now() + CALL_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((done) => setTimeout(done, CALL_POLL_MS));
    const rows = await sql`select state, ok, said from run_queue where id = ${id}`;
    if (!rows.length) break;
    const job = rows[0];
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') {
      return say(job.said || (job.ok ? 'Done.' : 'It did not finish.'), !job.ok);
    }
  }

  const now = await sql`select state from run_queue where id = ${id}`;
  const state = now.length ? now[0].state : 'gone';
  return say(state === 'queued'
    ? `Nothing on the machine picked this up within ${Math.round(CALL_WAIT_MS / 1000)} seconds, and it is `
      + `still queued as ${id}. The MouseFlow worker is probably not running there. Call `
      + `mouseflow_run_status with that id, or mouseflow_stop to take it off the queue.`
    : `It is still running on the machine as ${id}. Call mouseflow_run_status with that id for the outcome.`,
  state === 'queued');
}

/* One stopped recording, as a row.
 *
 * parseMacro and flowFor are the app's own, imported rather than repeated - flowFor's comment says why there
 * is one of them, and this is its fourth caller. The `windows` a replay needs are derived from the events'
 * own `#ctx` instead of from polling the foreground window: more faithful, and available to something that
 * was not watching while the recording ran, which is exactly the case here.
 */
async function saveRecording(sql, who, macro, health) {
  const { events, problems } = parseMacro(macro);
  if (!events.length) {
    return { ok: false, said: 'It stopped, and nothing had been captured. Nothing was saved.' };
  }

  const seen = new Map();
  for (const event of events) {
    const ctx = event && event.context;
    if (!ctx || (!ctx.app && !ctx.window)) continue;
    const key = `${ctx.app || ''}\u0000${ctx.window || ''}`;
    if (!seen.has(key)) seen.set(key, { title: ctx.window || ctx.app || '', process: ctx.app || '' });
  }
  const windows = [...seen.values()].slice(0, 12);

  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const rec = {
    id: `r${Math.random().toString(36).slice(2, 10)}`,
    name: `MouseFlow ${two(now.getDate())}/${two(now.getMonth() + 1)} `
      + `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`,
    created: now.toISOString(),
    events,
    windows,
  };
  const row = flowFor(rec, health);

  await sql`
    insert into user_flow
      (user_id, client_id, source, kind, name, description, payload, origins, created_at, updated_at)
    values
      (${who.id}, ${row.id}, 'desktop', 'recorded', ${row.name}, ${row.description},
       ${JSON.stringify(row.payload)}, ${row.origins}, ${row.created}, now())
    on conflict (user_id, client_id) do update set
      name = excluded.name, description = excluded.description, payload = excluded.payload,
      origins = excluded.origins, updated_at = now(), deleted_at = null
  `;

  const s = summarize(events);
  const where = windows.map((w) => w.title).filter(Boolean).slice(0, 3);
  return {
    ok: true,
    said: `Saved as "${rec.name}" (${rec.id}): ${s.count} events, ${s.clicks} `
      + `click${s.clicks === 1 ? '' : 's'}`
      + (where.length ? `, in ${where.join(', ')}` : '') + '.'
      + (problems.length ? ` ${problems.length} lines could not be read and were skipped.` : '')
      + ' Nothing about what was typed is in it, by design.',
  };
}

/* ------------------------------------------------------------------------------- the worker side */

async function workerRoute(action, req, res, sql, who) {
  if (action === 'claim') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
    await stampWorker(sql, who.id);

    /* Anything a worker took and never came back from. Failed rather than requeued: a run that may be
     * half-done must not be repeated blind, and a person can ask for it again knowing what happened. */
    await sql`
      update run_queue set state = 'failed', ok = false, finished_at = now(),
             said = 'the machine took this job and never reported back'
      where user_id = ${who.id} and state = 'claimed'
        and claimed_at < now() - ${`${Math.round(CLAIM_STALE_MS / 1000)} seconds`}::interval
    `;

    const by = String((req.body && req.body.worker) || 'worker').slice(0, 60);
    const wait = Math.min(CLAIM_WAIT_MAX_MS, Math.max(0, Number((req.body && req.body.wait) || 0) * 1000));
    const until = Date.now() + wait;

    for (;;) {
      /* One statement, so two workers on one account cannot take the same job: the row is selected and
       * claimed in the same update. */
      const took = await sql`
        update run_queue set state = 'claimed', claimed_by = ${by}, claimed_at = now()
        where id = (
          select id from run_queue
          where user_id = ${who.id} and state = 'queued'
          order by created_at limit 1
        )
        returning id, flow_id, tool_name, args
      `;
      if (took.length) {
        const job = took[0];
        /* An agent job carries an instruction, not a skill, so there is nothing to look up. Marked by the
         * flow id rather than by a column, because it is the flow id that is absent. */
        if (String(job.flow_id || '').startsWith('#')) {
          return res.status(200).json({
            ok: true,
            job: { id: job.id, toolName: job.tool_name, args: job.args || {}, command: job.flow_id, flow: null },
          });
        }
        const flow = await sql`
          select client_id, source, kind, name, description, payload, origins
          from user_flow where user_id = ${who.id} and client_id = ${job.flow_id} and deleted_at is null
        `;
        if (!flow.length) {
          await sql`
            update run_queue set state = 'failed', ok = false, finished_at = now(),
                   said = 'the skill was deleted between the ask and the run'
            where id = ${job.id}
          `;
          continue;
        }
        const row = flow[0];
        const payload = row.payload || {};
        const args = job.args || {};

        /* A replay body, built HERE.
         *
         * The claimer used to be a Node process that could import flowBody; now it can be the agent, which
         * is a small program that speaks the five-column format and knows nothing about skills, payloads or
         * parameters. Building it here is what lets that be true - and it is the same builder the Record
         * page uses, so a replay asked for by a chat and one asked for by the button are the same document.
         *
         * Only for a RECORDED skill: a created one is a goal, and a goal needs a model in the loop, which is
         * not something the agent has. The worker still handles those, and says so when it cannot. */
        let body = null;
        let activate = null;
        if (row.kind !== 'created' && Array.isArray(payload.events) && payload.events.length) {
          const allowed = [0.5, 1, 1.5, 2, 4];
          const asked = Number(args.speed);
          body = flowBody(
            [{
              recordingId: row.client_id,
              repeat: Math.min(999, Math.max(1, Math.round(Number(args.repeat) || 1))),
              speed: allowed.includes(asked) ? asked : 1,
              delayAfterMs: 0,
            }],
            [{ id: row.client_id, name: row.name, events: payload.events, windows: payload.windows || [] }],
            { startDelayMs: 0, flowRepeat: 1, flowForever: false },
          );
          /* The window it was recorded in, as the instruction that raises it - the same thing the Record
           * page sends before it plays a row, for the same reason: a replay is coordinates and has no idea
           * what is under them. */
          const front = Array.isArray(payload.windows) ? payload.windows[0] : null;
          if (front && (front.title || front.process)) {
            activate = `action=activate ${front.process ? `process=${front.process} ` : ''}`
              + `${front.title ? `title=${front.title}` : ''}`.trim();
          }
        }

        return res.status(200).json({
          ok: true,
          job: {
            id: job.id,
            toolName: job.tool_name,
            args,
            /* Both shapes, because there are two kinds of claimer. The agent reads `body` and `activate` and
             * needs nothing else; the worker reads `flow`, which it needs for a goal skill. */
            body,
            activate: activate ? activate.trim() : null,
            flow: {
              id: row.client_id, source: row.source, kind: row.kind, name: row.name,
              description: row.description, payload: row.payload, origins: row.origins,
            },
          },
        });
      }
      if (Date.now() >= until) return res.status(200).json({ ok: true, job: null });
      await new Promise((done) => setTimeout(done, CLAIM_POLL_MS));
    }
  }

  if (action === 'report') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
    const body = req.body || {};
    const id = String(body.id || '');
    let ok = body.ok === true;
    let said = body.said == null ? null : String(body.said).slice(0, 4000);

    /* A stopped recording arrives as the five-column body the agent hands back, and turning it into a row
     * happens HERE rather than on the machine.
     *
     * That is the whole point of doing it this way: the agent can then be the thing that claims the job, and
     * an agent is a small program that speaks its own format and knows nothing about accounts, payload
     * shapes or flow ids. Everything it would otherwise have to learn - parseMacro, flowFor, the stamp that
     * says this row is a recording - already exists here, in one copy, shared with the app. */
    if (body.body != null) {
      const [job] = await sql`select flow_id from run_queue where id = ${id} and user_id = ${who.id}`;
      if (job && job.flow_id === '#record.stop') {
        const saved = await saveRecording(sql, who, String(body.body), body.health || null);
        ok = saved.ok;
        said = saved.said;
      }
    }

    const done = await sql`
      update run_queue set state = ${ok ? 'done' : 'failed'}, ok = ${ok}, said = ${said},
             finished_at = now()
      where id = ${id} and user_id = ${who.id} and state = 'claimed'
      returning id
    `;
    /* A job cancelled while it ran is not 'claimed' any more, so nothing is updated - and that is the right
     * answer, not an error: the cancellation is what the person asked for and it stands. */
    return res.status(200).json({ ok: true, recorded: done.length === 1 });
  }

  if (action === 'state') {
    const id = String((req.query && req.query.id) || '');
    const rows = await sql`select state from run_queue where id = ${id} and user_id = ${who.id}`;
    return res.status(200).json({ ok: true, state: rows.length ? rows[0].state : 'gone' });
  }

  return res.status(400).json({ error: `no worker action "${action}"` });
}

/* ------------------------------------------------------------------------------- the route */

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (req.method === 'GET' && !(req.query && req.query.worker)) {
    /* Whoever opened this in a browser. Deliberately answerable without a token: it says nothing about
     * anybody and saves a person guessing why a URL returns 401. */
    res.status(200).json({
      name: SERVER.name,
      version: SERVER.version,
      protocol: 'MCP over HTTP POST, JSON-RPC 2.0',
      auth: 'Bearer <device token> — mint one in the app under Settings → My account',
      note: 'Running a skill needs the MouseFlow worker on the machine the skill belongs to. See '
        + 'docs/product/21-mcp.md.',
    });
    return;
  }

  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'This deployment has no database configured.' });
    return;
  }
  const sql = neon(process.env.DATABASE_URL);

  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (_) {
    who = null;
  }
  if (!who) return unauthorized(req, res);

  /* "Is anything waiting for a machine?" - asked by the app, answered without a job id.
   *
   * The app is the only place a person can say yes, and it cannot offer to unless it knows there is
   * something to say yes TO. Without this the failure is silent in the one window that could fix it: a
   * command sits in a queue, the chat says nothing picked it up, and the app - open on the same screen -
   * shows an ordinary Record page. */
  if (req.method === 'GET' && req.query && req.query.pending) {
    const rows = await sql`
      select id, tool_name, created_at from run_queue
      where user_id = ${who.id} and state = 'queued'
      order by created_at limit 5
    `;
    res.status(200).json({
      ok: true,
      waiting: rows.length,
      oldest: rows.length ? rows[0].created_at : null,
      tools: rows.map((r) => r.tool_name).filter(Boolean),
    });
    return;
  }

  const action = req.query && req.query.worker;
  if (action) return workerRoute(String(action), req, res, sql, who);

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST' });
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : null;
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    res.status(400).json(rpcError(body && body.id, -32600, 'not a JSON-RPC 2.0 request'));
    return;
  }

  const { id, method, params } = body;

  /* A notification has no id and gets no body - 202 is the documented answer, and replying to one would
   * put an unmatched response into the client's stream. */
  if (method.startsWith('notifications/')) {
    res.status(202).end();
    return;
  }

  try {
    if (method === 'initialize') {
      const asked = params && params.protocolVersion;
      res.setHeader('Mcp-Session-Id', randomUUID());
      res.status(200).json(rpc(id, {
        protocolVersion: SPOKEN.has(asked) ? asked : NEWEST,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: 'Each tool other than mouseflow_status, mouseflow_stop and mouseflow_run_status is one '
          + 'skill on this person\'s MouseFlow account, and calling it moves the real mouse and keyboard on '
          + 'their computer. Two consequences worth holding on to: the actions cannot be undone from here, '
          + 'and a missing argument should be asked for rather than guessed. Nothing runs unless a worker is '
          + 'listening on that machine; mouseflow_status says whether one is.',
      }));
      return;
    }

    if (method === 'ping') {
      res.status(200).json(rpc(id, {}));
      return;
    }

    if (method === 'tools/list') {
      const { skills } = await skillsOf(sql, who.id);
      const tools = [
        ...READ_TOOLS,
        START_TOOL, STOP_RECORDING_TOOL,
        STATUS_TOOL, STOP_TOOL, RUN_STATUS_TOOL,
      ];
      for (const [name, entry] of tableOf(skills)) {
        tools.push({ ...wireFor('mcp', entry.structure), name });
      }
      res.status(200).json(rpc(id, { tools }));
      return;
    }

    if (method === 'tools/call') {
      res.status(200).json(rpc(id, await callTool(sql, who, params, req)));
      return;
    }

    res.status(200).json(rpcError(id, -32601, `no method "${method}"`));
  } catch (err) {
    /* A thrown error is still a tool answer when it happened inside one: the client should see a sentence
     * it can act on, not a transport failure it cannot. */
    if (method === 'tools/call') {
      res.status(200).json(rpc(id, say(`That did not work: ${err.message}`, true)));
      return;
    }
    res.status(200).json(rpcError(id, -32603, err.message));
  }
}
