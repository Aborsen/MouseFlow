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
import { makeRunner } from './run.mjs';
import { help } from '../api/_help.mjs';

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

/* The documentation, on this transport too.
 *
 * Duplicated as a definition and shared as an implementation, which is how STATUS and STOP are already
 * arranged here: the wording differs because what is true differs (there, the agent is a machine somewhere;
 * here it is this one), but nobody wants two answers to "what does MouseFlow record". The text comes from
 * api/_help.mjs, which fetches the site - see the note at the top of that file for why it is not a copy.
 *
 * WHY IT IS WORTH A TOOL ON THE STDIO SIDE AS WELL. Everything else on this list is about the account and
 * this machine, and the first question anybody asks is neither: it is what this is and what it captures. An
 * assistant with no way to look that up answers anyway, and gets the load-bearing parts wrong. */
const HELP_TOOL = {
  name: 'mouseflow_help',
  description: 'The MouseFlow documentation itself, fetched from mouse-flow.vercel.app/docs. Use it to answer any '
    + 'question about how MouseFlow works - what the recorder captures and what it never captures, skills '
    + 'and how they differ, the agent, the extension, privacy, limits - INSTEAD of answering from memory. '
    + 'Ask a question to get the sections that answer it, name a page to read it whole, or call it with '
    + 'nothing to see the list of pages.',
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'What the person wants to know, in their own words. Keep their nouns - the words the '
          + 'documentation uses are the ones that find it.',
      },
      page: {
        type: 'string',
        description: 'A page id from an earlier answer (for example "record-a-flow" or "privacy-and-data") '
          + 'to read that page whole.',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

/* ------------------------------------------------------------------------------- running things */

/* One at a time. The agent refuses a second replay with a 409 and the decision loop would be interleaving
 * two goals through one mouse, so the refusal belongs here where it can say which run is in the way. */
let inFlight = null;

/* The running itself is mcp/run.mjs, shared with the worker. There are two things that ask for a run now -
 * this, where the decider is on the same machine, and the worker, where it is in the cloud - and a second
 * copy of the replay path would be a second answer to "how is a skill run". The first divergence would be
 * invisible: one route raising the window before it clicks and the other not. */
let runner = null;

/* ------------------------------------------------------------------------------- the protocol */

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
const refuse = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });
const text = (body, isError = false) => ({ content: [{ type: 'text', text: body }], isError });

let announced = null;

async function toolList(lib) {
  const { skills, unstamped } = await skillsNow(lib);
  const table = tableOf(lib, skills);
  const tools = [HELP_TOOL, STATUS_TOOL, STOP_TOOL];
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

  /* Before the account is touched: the documentation is public, and a question about how the product
   * works should be answerable whether or not the token works. */
  if (asked === HELP_TOOL.name) {
    return text(await help({ question: String(args.question || ''), page: String(args.page || '') }));
  }

  if (asked === STATUS_TOOL.name) {
    const h = await runner.health();
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
    const done = await runner.call(entry, args, () => !!(inFlight && inFlight.abort));
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

  runner = makeRunner({ lib, port: CONFIG.port, base: CONFIG.base, token: CONFIG.token, say });

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
