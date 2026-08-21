#!/usr/bin/env node
/* The machine end of the HTTPS server. It asks for work; nothing ever asks it.
 *
 * /api/mcp turns a tools/call into a row in run_queue and waits. This claims that row, runs the skill
 * through the local agent - the same way mcp/server.mjs does, out of the same module, so the two cannot
 * drift - and reports what happened. The direction of the connection never reverses, which is the whole
 * security property: no inbound path to this computer exists, and a machine with this not running simply
 * claims nothing and the caller is told so.
 *
 * LONG POLL, not a fast loop. The claim request holds open for up to 25 seconds with nothing to do, so an
 * idle worker costs one request every half minute rather than one every three seconds. An idle wait is not
 * billed as CPU at either end.
 *
 * ONE JOB AT A TIME, because there is one mouse. The endpoint refuses to queue a second while one is
 * outstanding, and this claims serially, so the rule is stated in both places - the endpoint so the caller
 * gets a sentence instead of a wait, and here so it is true even if two workers are started by accident.
 *
 *   MOUSEFLOW_TOKEN        required; the same device token the stdio server uses
 *   MOUSEFLOW_URL          the deployment (default https://mouse-agent.vercel.app)
 *   MOUSEFLOW_AGENT_PORT   where the local agent listens (default 8787)
 *   MOUSEFLOW_WORKER_NAME  what to call this machine in the queue (default: the hostname)
 */
import { hostname } from 'node:os';
import { load, installFetch } from './shared.mjs';
import { makeRunner } from './run.mjs';

const CONFIG = {
  token: process.env.MOUSEFLOW_TOKEN || '',
  base: (process.env.MOUSEFLOW_URL || 'https://mouse-agent.vercel.app').replace(/\/$/, ''),
  port: Number(process.env.MOUSEFLOW_AGENT_PORT || 8787),
  name: (process.env.MOUSEFLOW_WORKER_NAME || hostname() || 'worker').slice(0, 60),
  /* Set by the test, which cannot wait 25 seconds a poll. Not documented above on purpose: it exists to
   * make the loop testable, not to be tuned. */
  wait: Number(process.env.MOUSEFLOW_WORKER_WAIT || 25),
  once: process.env.MOUSEFLOW_WORKER_ONCE === '1',
};

const say = (...parts) => process.stderr.write(`[mouseflow worker] ${parts.join(' ')}\n`);

/* How long to wait after a failed request, doubling to a ceiling. A worker that hammers a deployment which
 * is down is a worker that makes the outage worse. */
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const CANCEL_POLL_MS = 2_000;

const post = async (action, body) => {
  const res = await fetch(`${CONFIG.base}/api/mcp?worker=${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CONFIG.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('the device token was refused - mint a new one in the app under Settings → My account');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ?worker=${action}`);
  return res.json();
};

async function main() {
  if (!/^mf_/.test(CONFIG.token)) {
    say(CONFIG.token
      ? 'MOUSEFLOW_TOKEN does not start with "mf_", so it is not a MouseFlow device token.'
      : 'MOUSEFLOW_TOKEN is not set. Mint a device token in the app under Settings → My account.');
    process.exit(2);
  }

  installFetch({ base: CONFIG.base, token: CONFIG.token });
  const parts = await load();
  const lib = {
    schema: parts.schema, macro: parts.macro, agent: parts.agent,
    engine: parts.engine, skills: parts.skills,
  };
  const runner = makeRunner({ lib, port: CONFIG.port, base: CONFIG.base, token: CONFIG.token, say });

  const health = await runner.health();
  say(health.ok
    ? `listening for work as "${CONFIG.name}" — agent ${health.health.version} on 127.0.0.1:${CONFIG.port}`
    : `listening for work as "${CONFIG.name}" — but ${health.why}`);

  let backoff = BACKOFF_MIN_MS;
  for (;;) {
    let claimed;
    try {
      claimed = await post('claim', { worker: CONFIG.name, wait: CONFIG.wait });
      backoff = BACKOFF_MIN_MS;
    } catch (err) {
      say(`${err.message} — waiting ${Math.round(backoff / 1000)}s`);
      await new Promise((done) => setTimeout(done, backoff));
      backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
      continue;
    }

    const job = claimed && claimed.job;
    if (!job) {
      if (CONFIG.once) return;
      continue;
    }

    say(`running ${job.toolName || job.id}`);

    /* Cancellation, watched rather than pushed - the same direction as everything else here. The flag is
     * read synchronously by the run, which polls it several times a second, so the check has to be cheap. */
    let cancelled = false;
    const watch = setInterval(async () => {
      try {
        const res = await fetch(`${CONFIG.base}/api/mcp?worker=state&id=${encodeURIComponent(job.id)}`, {
          headers: { authorization: `Bearer ${CONFIG.token}` },
        });
        const body = await res.json();
        if (body && body.state && body.state !== 'claimed') cancelled = true;
      } catch (_) { /* a failed check is not a cancellation */ }
    }, CANCEL_POLL_MS);

    let outcome;
    try {
      /* Two kinds of job, and the difference is whether there is a skill. A command carries an instruction
       * for the agent - start recording, stop recording - and arrives with `flow: null`, which is why the
       * endpoint marks it rather than leaving this to infer it from a missing field. */
      outcome = job.command
        ? await runner.command(job.command, job.args || {})
        : await runner.call(
          { flow: job.flow, structure: lib.schema.structureOf(job.flow) },
          job.args || {},
          () => cancelled,
        );
    } catch (err) {
      outcome = { ok: false, text: `The run threw: ${err.message}` };
    } finally {
      clearInterval(watch);
    }

    say(outcome.ok ? `done: ${job.toolName || job.id}` : `failed: ${outcome.text.split('\n')[0]}`);

    try {
      const recorded = await post('report', {
        id: job.id,
        ok: outcome.ok,
        said: outcome.text,
        /* A stopped recording travels as the agent gave it. The server parses it and writes the row, and
         * the sentence the caller reads is written there, from what was actually saved. */
        ...(outcome.body != null ? { body: outcome.body, health: outcome.health || null } : {}),
      });
      if (recorded && recorded.recorded === false) {
        say('the answer was not recorded - the job had already been cancelled');
      }
    } catch (err) {
      /* The work happened and the report did not. Said out loud, because the caller is being told "nothing
       * picked this up" while something did. */
      say(`the outcome could not be reported: ${err.message}`);
    }

    if (CONFIG.once) return;
  }
}

main().catch((err) => {
  say(err.stack || err.message);
  process.exit(1);
});
