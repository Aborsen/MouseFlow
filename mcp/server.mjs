#!/usr/bin/env node
/* MouseFlow as tools an AI can call.
 *
 * A skill on a MouseFlow account is already the same thing as a tool call: a named, described unit of work
 * with its variable parts lifted out. web/src/lib/skill-schema.ts has said so for a while and can already
 * write it in MCP's exact shape. What was missing was both ends of the wire - nothing SERVED those
 * definitions, and nothing ACCEPTED the call that came back - so the only way to use a skill from a model
 * was for a person to copy JSON out of a panel and, when the model asked for the skill by name, run it by
 * hand. This is those two ends.
 *
 *   tools/list   the skills on the account, each as a tool, from structureOf() + wireFor('mcp')
 *   tools/call   run it here, on this machine, through the local agent
 *
 * WHAT THIS IS NOT. There is no tool that takes an arbitrary goal. A skill is bounded by what its author
 * recorded or wrote; "do whatever this sentence says on the user's desktop" is not bounded by anything, and
 * the difference between the two is the whole of why this is safe to hand to a model. If that tool is ever
 * wanted it should be added deliberately, with its own consent story, not inherited from this file.
 *
 * WHAT IT CANNOT DO, said here because a tool list is a promise:
 *
 *   - Extension skills. They aim at page elements, and the browser extension is the half that can replay
 *     them. They are listed and they refuse, by name, with the reason - being told you have eleven skills
 *     and offered four is worse than useless, which is the same reason /api/sync returns both halves.
 *   - Typing, in a RECORDED skill. Keystroke CONTENT is never stored anywhere in MouseFlow, by design, so a
 *     recording that contained typing replays without it. The agent counts what it could not play and this
 *     reports the number rather than calling the run a success.
 *   - Anything the coordinates no longer fit. A recorded desktop skill is pixel positions; the front window
 *     is raised first, exactly as the Record page does it, and that is as far as it goes.
 *
 * AUTHENTICATION, both directions. Outward: a device token, the same credential the extension pairs with,
 * minted in the app under Settings and never stored here - it arrives in the environment. Inward: none, and
 * that is not this file's doing. The local agent has no authentication at all (docs/product/19 says so),
 * so anything already running on the machine can drive it. This adds no new local access; what it adds is a
 * new DECIDER, which is the point of it and the reason the tool list is bounded above.
 */
import { createInterface } from 'node:readline';
import { load, installFetch } from './shared.mjs';

const NAME = 'mouseflow';
const VERSION = '0.1.0';

/* Versions of the protocol this speaks. The client's is echoed when it is one of them, because that is what
 * the handshake is for; anything else gets the newest known, and the client decides whether to go on. */
const SPOKEN = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const NEWEST = '2025-06-18';

const CONFIG = {
  token: process.env.MOUSEFLOW_TOKEN || '',
  base: process.env.MOUSEFLOW_URL || 'https://mouse-agent.vercel.app',
  port: Number(process.env.MOUSEFLOW_AGENT_PORT || 8787),
};

/* stdout belongs to the protocol. Every word of diagnostics goes to stderr, where a client shows it as the
 * server's log; one stray console.log on the other stream corrupts a frame and the session ends with a
 * parse error naming nothing. */
const say = (...parts) => process.stderr.write(`[mouseflow] ${parts.join(' ')}\n`);

/* ------------------------------------------------------------------------------- the account */

const SKILLS_TTL_MS = 30_000;
let cache = { at: 0, skills: [], unstamped: 0, you: null };

/** The account's skills, and how many rows were not offered. */
async function skillsNow(lib, { force = false } = {}) {
  if (!force && Date.now() - cache.at < SKILLS_TTL_MS) return cache;

  const res = await fetch(`${CONFIG.base.replace(/\/$/, '')}/api/sync`, {
    headers: { authorization: `Bearer ${CONFIG.token}` },
  });
  const body = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) {
    throw new Error('The device token was refused. Mint a new one in the app under Settings → My account '
      + 'and put it in MOUSEFLOW_TOKEN.');
  }
  if (!res.ok || !body || !body.ok) {
    throw new Error(`The account could not be read: HTTP ${res.status}`
      + `${body && body.error ? ` - ${body.error}` : ''}`);
  }

  const flows = Array.isArray(body.flows) ? body.flows : [];
  /* STAMPED SKILLS ONLY, and deliberately stricter than the Skills page, which lists an unstamped row as a
   * skill so that nothing anybody made before the stamp existed disappears from their library. That default
   * is right for a page somebody is reading and wrong for a tool list: a tool list is read by something that
   * will CALL what is in it, and "probably a skill" is not a thing to offer. The count is reported by
   * mouseflow_status instead, so what is left out is visible rather than silently missing. */
  const skills = [];
  let unstamped = 0;
  for (const flow of flows) {
    const role = lib.role.roleOf(flow);
    if (role === 'recording') continue;
    if (role !== 'skill') { unstamped++; continue; }
    skills.push(flow);
  }

  cache = { at: Date.now(), skills, unstamped, you: body.you || null };
  return cache;
}

/** Tool name -> { flow, structure }. Names are near-unique by construction; a collision is still handled. */
function tableOf(lib, skills) {
  const table = new Map();
  for (const flow of skills) {
    const structure = lib.schema.structureOf(flow);
    let name = structure.toolName;
    if (table.has(name)) {
      /* toolNameFor already suffixes part of the id, so this is close to unreachable - but two tools with
       * one name means the last one silently wins on every provider, which is a wrong answer rather than a
       * missing one. */
      let n = 2;
      while (table.has(`${name}_${n}`)) n++;
      say(`two skills derived the tool name "${name}"; the second is offered as "${name}_${n}"`);
      name = `${name}_${n}`;
    }
    table.set(name, { flow, structure });
  }
  return table;
}

/* ------------------------------------------------------------------------------- the fixed tools */

const STATUS_TOOL = {
  name: 'mouseflow_status',
  description: 'Whether the MouseFlow agent is running on this machine and what it can do, plus how many '
    + 'skills are on the account. Ask this first when a skill call fails, and when the answer to "can you '
    + 'do this on my computer" depends on whether the agent is up.',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

const STOP_TOOL = {
  name: 'mouseflow_stop',
  description: 'Stop whatever MouseFlow is doing on this machine right now - a replay or a goal run. Safe '
    + 'to call when nothing is running.',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

/* ------------------------------------------------------------------------------- running things */

/* One at a time. The agent refuses a second replay with a 409 and the decision loop would be interleaving
 * two goals through one mouse, so the refusal belongs here where it can say which run is in the way. */
let inFlight = null;

const REPLAY_POLL_MS = 700;
const REPLAY_MAX_MS = 30 * 60 * 1000;

const nowIso = () => new Date().toISOString();
const runId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Best effort, and reported. A run whose outcome never reached the account makes the dashboard wrong. */
async function logRun(run) {
  try {
    const res = await fetch(`${CONFIG.base.replace(/\/$/, '')}/api/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CONFIG.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runs: [run] }),
    });
    if (!res.ok) say(`the run was not logged to the account: HTTP ${res.status}`);
  } catch (err) {
    say(`the run was not logged to the account: ${err.message}`);
  }
}

async function healthOf(lib) {
  try {
    return { ok: true, health: await lib.agent.health(CONFIG.port) };
  } catch (err) {
    const offline = err && err.offline;
    return {
      ok: false,
      why: offline
        ? `No MouseFlow agent answered on 127.0.0.1:${CONFIG.port}. It has to be running on this machine `
          + 'for anything here to happen - the app\'s Connections screen has the one-line install command.'
        : `The agent answered with an error: ${err.message}`,
    };
  }
}

/** A recorded desktop skill: raise the window it belongs to, then replay it. */
async function replaySkill(lib, { flow, structure }, args) {
  const payload = flow.payload || {};
  const events = Array.isArray(payload.events) ? payload.events : [];
  if (!events.length) {
    return { ok: false, text: 'This skill holds no events, so there is nothing to replay.' };
  }

  const repeat = Math.min(999, Math.max(1, Math.round(Number(args.repeat) || 1)));
  const allowed = [0.5, 1, 1.5, 2, 4];
  const asked = Number(args.speed);
  const speed = allowed.includes(asked) ? asked : 1;
  const notes = [];
  if (args.speed !== undefined && speed !== asked) {
    notes.push(`speed ${args.speed} is not one of ${allowed.join(', ')}, so it ran at 1.`);
  }

  /* The window this was recorded in, brought forward first.
   *
   * A replay is coordinates and clicks and has no idea what is under them. The Record page does exactly
   * this before playing a row, for exactly this reason, and a skill payload carries the same `windows` the
   * recording did. Best effort: a window that has since closed should not refuse a run the caller asked
   * for, and the note says what was tried. */
  const front = Array.isArray(payload.windows) ? payload.windows[0] : null;
  if (front && (front.title || front.process)) {
    const body = `action=activate ${front.process ? `process=${front.process} ` : ''}`
      + `${front.title ? `title=${front.title}` : ''}`.trim();
    try {
      await lib.agent.doAction(CONFIG.port, body.trim());
      await new Promise((done) => setTimeout(done, 350));
    } catch (_) {
      notes.push(`${front.title || front.process} could not be brought to the front; it may not be open.`);
    }
  }

  const recording = { id: flow.id, name: flow.name, events, windows: payload.windows || [] };
  const body = lib.macro.flowBody(
    [{ recordingId: flow.id, repeat, speed, delayAfterMs: 0 }],
    [recording],
    { startDelayMs: 0, flowRepeat: 1, flowForever: false },
  );

  const startedAt = nowIso();
  try {
    await lib.agent.replay(CONFIG.port, body);
  } catch (err) {
    return { ok: false, text: `The agent would not start the replay: ${err.message}` };
  }

  /* Wait for it, because a tool that returns before the work happened has told the caller nothing. */
  let last = null;
  const until = Date.now() + REPLAY_MAX_MS;
  while (Date.now() < until) {
    if (inFlight && inFlight.abort) break;
    await new Promise((done) => setTimeout(done, REPLAY_POLL_MS));
    try {
      last = await lib.agent.replayStatus(CONFIG.port);
    } catch (_) {
      /* A status that cannot be read is not a failed replay - the agent may be busy injecting. Keep
       * waiting; the deadline is the backstop. */
      continue;
    }
    if (!last.playing) break;
  }

  const stopped = !!(inFlight && inFlight.abort);
  const timedOut = !stopped && last && last.playing;
  const played = last ? last.index : events.length;
  const unplayable = last ? last.unplayable : 0;
  const retargeted = last ? last.retargeted : 0;

  if (unplayable) {
    notes.push(`${unplayable} event${unplayable === 1 ? '' : 's'} could not be played. Keystroke content is `
      + 'never stored by MouseFlow, so typing in a recording is not replayed - if this skill needed to type '
      + 'something, that part did not happen.');
  }
  if (retargeted) {
    notes.push(`${retargeted} click${retargeted === 1 ? ' was' : 's were'} re-aimed by name because what `
      + 'was recorded there had moved.');
  }

  const outcome = stopped ? 'stopped' : timedOut ? 'failed' : 'ok';
  await logRun({
    id: runId('mcp'),
    kind: 'replay',
    flowId: flow.id,
    goal: `${flow.name} (called as ${structure.toolName})`,
    outcome,
    summary: notes.join(' ') || null,
    error: timedOut ? 'the replay was still running after 30 minutes' : null,
    startedAt,
    finishedAt: nowIso(),
  });

  const head = stopped
    ? `Stopped. ${played} of ${events.length} events had been replayed.`
    : timedOut
      ? 'The replay was still running after 30 minutes and is no longer being waited for. '
        + 'Call mouseflow_stop to end it.'
      : `Replayed "${flow.name}" — ${events.length} event${events.length === 1 ? '' : 's'}`
        + `${repeat > 1 ? `, ${repeat} times` : ''}${speed !== 1 ? `, at ${speed}×` : ''}.`;

  /* A replay holds input, not outcome: nothing stored says whether the screen did what was wanted, and the
   * only honest report is what was sent, plus what could not be. */
  const caveat = outcome === 'ok'
    ? ' What the applications did with it is not something MouseFlow can see; the actions were sent.'
    : '';
  return { ok: outcome === 'ok', text: [head + caveat, ...notes].join('\n') };
}

/** A skill written as a goal: fill its template, then let the decision loop drive. */
async function runGoalSkill(lib, { flow, structure }, args) {
  const payload = flow.payload || {};
  /* extension/skills.js owns both of these. missingParams first, as its own comment instructs: fillGoal
   * substitutes an empty string for anything it cannot resolve, so calling it alone turns a missing
   * argument into a goal with a hole in it and a run that does something almost right. */
  const skill = { ...payload, id: flow.id, name: flow.name, params: payload.params || [] };
  const missing = lib.skills.missingParams(skill, args);
  if (missing.length) {
    return {
      ok: false,
      text: `This skill needs ${missing.join(', ')}. `
        + 'Ask the user for the missing value rather than guessing one: the goal is carried out on their '
        + 'real computer and cannot be undone from here.',
    };
  }

  const goal = lib.skills.fillGoal(skill, args);
  if (!goal || !goal.trim()) {
    return { ok: false, text: 'This skill has no goal text to carry out.' };
  }

  const startedAt = nowIso();
  const seen = [];
  let result;
  try {
    result = await lib.engine.runOnDesktop({
      goal,
      port: CONFIG.port,
      onEvent: (event) => {
        if (event.type === 'tool' && event.name) seen.push(event.name);
        if (event.type === 'error') say(`run: ${event.message || 'error'}`);
      },
      isAborted: () => !!(inFlight && inFlight.abort),
    });
  } catch (err) {
    result = { ok: false, error: err.message, steps: [] };
  }

  const outcome = inFlight && inFlight.abort ? 'stopped' : result.ok ? 'ok' : 'failed';
  await logRun({
    id: runId('mcp'),
    kind: 'agent',
    flowId: flow.id,
    goal,
    outcome,
    summary: result.said || null,
    error: result.ok ? null : result.error || null,
    steps: result.steps || [],
    startedAt,
    finishedAt: nowIso(),
  });

  const took = `${(result.steps || []).length} action${(result.steps || []).length === 1 ? '' : 's'}`;
  if (outcome === 'stopped') return { ok: false, text: `Stopped after ${took}.` };
  if (!result.ok) {
    return {
      ok: false,
      text: `The run did not finish: ${result.error || 'no reason was given'}. It took ${took}`
        + `${seen.length ? ` (${[...new Set(seen)].join(', ')})` : ''}.`,
    };
  }
  return { ok: true, text: `${result.said || 'Done.'} (${took})` };
}

async function callSkill(lib, entry, args) {
  if (entry.structure.runner !== 'agent') {
    return {
      ok: false,
      text: `"${entry.flow.name}" aims at elements in a web page, so the MouseFlow browser extension is the `
        + 'half that can replay it. This server drives the desktop agent, which has no page to aim at. Ask '
        + 'the user to run it from the extension.',
    };
  }
  const h = await healthOf(lib);
  if (!h.ok) return { ok: false, text: h.why };

  return entry.structure.kind === 'created'
    ? runGoalSkill(lib, entry, args)
    : replaySkill(lib, entry, args);
}

/* ------------------------------------------------------------------------------- the protocol */

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
const refuse = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });
const text = (body, isError = false) => ({ content: [{ type: 'text', text: body }], isError });

let announced = null;

async function toolList(lib) {
  const { skills, unstamped } = await skillsNow(lib);
  const table = tableOf(lib, skills);
  const tools = [STATUS_TOOL, STOP_TOOL];
  for (const [name, entry] of table) {
    /* wireFor('mcp') is the app's own answer for this exact shape - { name, description, inputSchema } -
     * and the name is overridden only in the collision case tableOf handles. */
    const wire = lib.schema.wireFor('mcp', entry.structure);
    tools.push({ ...wire, name });
  }
  return { tools, table, unstamped };
}

async function handleCall(lib, params) {
  const asked = params && params.name;
  const args = (params && params.arguments) || {};

  if (asked === STATUS_TOOL.name) {
    const h = await healthOf(lib);
    const { skills, unstamped, you } = await skillsNow(lib, { force: true });
    const lines = [];
    if (h.ok) {
      const can = Object.entries({
        sees: h.health.canSee, names: h.health.canName, keys: h.health.canKeys,
        windows: h.health.canWindows, 'long sessions': h.health.canDrain,
      }).filter(([, v]) => v).map(([k]) => k);
      lines.push(`The agent is running: version ${h.health.version}`
        + `${h.health.platform ? ` on ${h.health.platform}` : ''}, screen `
        + `${h.health.screen.w}×${h.health.screen.h}.`);
      lines.push(`It ${can.length ? `can: ${can.join(', ')}` : 'reports no optional capabilities'}.`);
      if (h.health.recording) lines.push('It is recording right now.');
      if (h.health.playing) lines.push('It is replaying right now.');
    } else {
      lines.push(h.why);
    }
    lines.push(`${skills.length} skill${skills.length === 1 ? '' : 's'} on the account`
      + `${you && you.name ? ` (${you.name})` : ''}, of which `
      + `${skills.filter((f) => f.source === 'desktop').length} can run here.`);
    if (unstamped) {
      lines.push(`${unstamped} row${unstamped === 1 ? '' : 's'} on the account are not marked as either a `
        + 'recording or a skill, and are not offered as tools. They were made before rows said which they '
        + 'were; saving them again in the app stamps them.');
    }
    if (inFlight) lines.push(`A run is in progress: ${inFlight.what}.`);
    return text(lines.join('\n'), !h.ok);
  }

  if (asked === STOP_TOOL.name) {
    if (!inFlight) {
      /* The agent may still be replaying something this server never started - it is a machine-wide
       * service, not ours alone - so the abort is sent regardless and the answer says which it was. */
      try {
        await lib.agent.replayAbort(CONFIG.port);
        return text('Nothing was running here, and a stop was sent to the agent in case something else '
          + 'had started a replay.');
      } catch (err) {
        return text(`Nothing was running here, and the agent could not be reached: ${err.message}`);
      }
    }
    inFlight.abort = true;
    try { await lib.agent.replayAbort(CONFIG.port); } catch (_) { /* the loop checks the flag too */ }
    return text(`Stopping ${inFlight.what}.`);
  }

  const { table } = await toolList(lib);
  const entry = table.get(asked);
  if (!entry) {
    /* A stale name means the account changed under a cached tool list, which is worth saying plainly - the
     * client is holding a list that is no longer true and the remedy is to ask for it again. */
    return text(`There is no skill called "${asked}" on this account any more. The list of skills has `
      + 'changed; ask for the tool list again.', true);
  }

  if (inFlight) {
    return text(`MouseFlow is already busy: ${inFlight.what}. One thing at a time - there is one mouse. `
      + 'Wait for it, or call mouseflow_stop.', true);
  }

  inFlight = { what: `"${entry.flow.name}"`, abort: false };
  try {
    const done = await callSkill(lib, entry, args);
    return text(done.text, !done.ok);
  } finally {
    inFlight = null;
  }
}

async function handle(lib, message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    const asked = params && params.protocolVersion;
    const version = SPOKEN.has(asked) ? asked : NEWEST;
    reply(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: NAME, version: VERSION },
      instructions: 'Each tool other than mouseflow_status and mouseflow_stop is one skill on the user\'s '
        + 'MouseFlow account, and calling it moves the real mouse and keyboard on their computer. Two '
        + 'consequences worth holding on to: the actions cannot be undone from here, and a missing argument '
        + 'should be asked for rather than guessed.',
    });
    return;
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') { reply(id, {}); return; }

  if (method === 'tools/list') {
    try {
      const { tools } = await toolList(lib);
      announced = tools.map((t) => t.name).join('\n');
      reply(id, { tools });
    } catch (err) {
      /* An account that cannot be read still leaves the two fixed tools usable, and one of them explains
       * why the rest are missing. An empty list with no explanation is the version of this that wastes
       * somebody's afternoon. */
      say(`the tool list is incomplete: ${err.message}`);
      reply(id, { tools: [STATUS_TOOL, STOP_TOOL] });
    }
    return;
  }

  if (method === 'tools/call') {
    try {
      reply(id, await handleCall(lib, params));
    } catch (err) {
      reply(id, text(`That did not work: ${err.message}`, true));
    }
    return;
  }

  /* Everything else, including resources/* and prompts/*, which this server does not offer and says so in
   * its capabilities. Answering -32601 is the documented way to say "not this server". */
  if (id !== undefined && id !== null) refuse(id, -32601, `no method "${method}"`);
}

/* A skill saved while a client is connected should become callable without reconnecting. Five minutes,
 * unref'd so it never keeps the process alive, and it speaks only when the set actually changed. */
function watch(lib) {
  const timer = setInterval(async () => {
    try {
      const { tools } = await toolList(lib);
      const names = tools.map((t) => t.name).join('\n');
      if (announced !== null && names !== announced) {
        announced = names;
        out({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      }
    } catch (_) { /* a failed poll is not news */ }
  }, 5 * 60 * 1000);
  timer.unref();
}

async function main() {
  if (!CONFIG.token) {
    say('MOUSEFLOW_TOKEN is not set. Mint a device token in the app under Settings → My account, or on the '
      + 'Skills page under "Connect the extension", and pass it in the environment. Without it there is no '
      + 'account to read.');
    process.exit(2);
  }
  if (!/^mf_/.test(CONFIG.token)) {
    say('MOUSEFLOW_TOKEN does not start with "mf_", so it is not a MouseFlow device token. A session cookie '
      + 'is not one; the token is the string the app shows once when you pair a device.');
    process.exit(2);
  }

  installFetch({ base: CONFIG.base, token: CONFIG.token });

  const parts = await load();
  const lib = {
    schema: parts.schema,
    macro: parts.macro,
    agent: parts.agent,
    engine: parts.engine,
    skills: parts.skills,
    role: await import(new URL('../web/src/lib/flow-role.ts', import.meta.url).href),
  };

  say(`serving ${CONFIG.base} against the agent on 127.0.0.1:${CONFIG.port}`);
  watch(lib);

  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (_) {
      /* No id to answer to, so there is nowhere to send an error. Recorded and skipped. */
      say('a line arrived that was not JSON and was ignored');
      continue;
    }
    /* Sequential on purpose. Two skills through one mouse is the thing inFlight refuses, and answering
     * requests out of order would only make that refusal arrive at a confusing moment. */
    try {
      await handle(lib, message);
    } catch (err) {
      say(`unhandled: ${err.stack || err.message}`);
      if (message && message.id !== undefined && message.id !== null) {
        refuse(message.id, -32603, err.message);
      }
    }
  }
}

main().catch((err) => {
  say(err.stack || err.message);
  process.exit(1);
});
