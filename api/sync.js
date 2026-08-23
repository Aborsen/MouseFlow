/* One account, one set of flows and runs, wherever you are looking from.
 *
 *   GET    /api/sync              your flows and your recent runs
 *   POST   /api/sync              push flows and runs (upsert)
 *   POST   /api/sync?issue=1      mint a device token, shown once  (session only)
 *   GET    /api/sync?tokens=1     list your paired devices          (session only)
 *   DELETE /api/sync?token=<id>   revoke one                        (session only)
 *
 * The extension holds skills in its own storage and the page holds its own; neither can see the
 * other, because a page and an extension are separate origins with separate storage. That is a
 * browser guarantee, not an oversight - so the only place they can meet is an account.
 *
 * A flow carries the half it came from: `web` from the extension, which points at page elements, and
 * `desktop` from the local agent, which points at screen coordinates. Both sync, both are returned to
 * both clients, and each client offers Run only on the ones it can actually replay.
 *
 * Everything here is private to its owner. Nothing is served without a session or a device token
 * that identifies one, and there is no route that lists another user's anything. Publishing to the
 * gallery stays a separate, deliberate act; see api/gallery.js.
 *
 * Minting a token requires a SESSION specifically, not a device token. A device that could mint
 * another device would turn one leaked token into permanent access, and revoking the one you knew
 * about would achieve nothing.
 */

import { neon } from '@neondatabase/serverless';
import { randomBytes } from 'node:crypto';
import { whoIsCalling, hashToken, DEVICE_TOKEN_PREFIX } from './_session.js';
/* Server-side crashes reach Sentry from here. See api/_report.js — no dependency, and it
 * deliberately sends the route and the message, never the query string or the body. */
import { report, wrap } from './_report.js';

const FLOWS_MAX = 300;        // per push
const RUNS_MAX = 100;
const RUNS_RETURNED = 60;
const PAYLOAD_MAX_BYTES = 400_000;

function cors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin',
    /^chrome-extension:\/\//.test(origin) ? origin : 'https://mouse-agent.vercel.app');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  /* No Allow-Credentials, as everywhere else here: the page is same-origin so CORS does not apply to
   * it, and the extension sends an explicit header. Not setting it is what stops a cross-site page
   * spending someone's session. */
  res.setHeader('Access-Control-Max-Age', '86400');
}

const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'sync_error', message } });

const text = (value, max) => (value == null ? null : String(value).slice(0, max));

async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!process.env.DATABASE_URL) return fail(res, 503, 'This deployment has no database configured.');

  const sql = neon(process.env.DATABASE_URL);
  const query = req.query || {};

  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (err) {
    await report(err, req, { route: 'sync' });
    return fail(res, 500, 'could not check who is calling: ' + err.message);
  }
  if (!who) {
    return fail(res, 401, 'sign in on the web app, or pair this extension with a device token');
  }

  try {
    if (query.issue) {
      if (who.via !== 'session') return fail(res, 403, 'only a signed-in browser can pair a device');
      return await issueToken(req, res, sql, who);
    }
    if (query.tokens) {
      if (who.via !== 'session') return fail(res, 403, 'only a signed-in browser can list devices');
      return await listTokens(res, sql, who);
    }
    if (req.method === 'DELETE') {
      if (who.via !== 'session') return fail(res, 403, 'only a signed-in browser can revoke a device');
      return await revokeToken(req, res, sql, who);
    }
    if (req.method === 'GET') return await pull(res, sql, who);
    if (req.method === 'PATCH') return await setPref(req, res, sql, who);
    if (req.method === 'POST') return await push(req, res, sql, who);
    return fail(res, 405, 'GET, POST or DELETE');
  } catch (err) {
    await report(err, req, { route: 'sync' });
    return fail(res, 500, err.message);
  }
}

/* ------------------------------------------------------------------ pairing a device */

async function issueToken(req, res, sql, who) {
  const label = text((req.body && req.body.label) || 'Chrome extension', 60);
  /* 32 bytes, which is not a number anyone guesses. Shown once and never stored: only its hash goes
   * in the table, so this response is the single moment the token exists in readable form. */
  const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const id = 'dev_' + randomBytes(6).toString('hex');

  await sql`
    insert into device_token (id, user_id, token_hash, label)
    values (${id}, ${who.id}, ${hashToken(token)}, ${label})
  `;
  return res.status(201).json({
    ok: true,
    token,
    device: { id, label, createdAt: new Date().toISOString() },
    note: 'This is shown once. Paste it into the extension under Skills.',
  });
}

/* One preference, written by the person it belongs to.
 *
 * Deliberately narrow: a key and a short string, both bounded. This is a place for "the tour has been
 * seen", not a general store somebody can put a megabyte in. */
async function setPref(req, res, sql, who) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const key = String(body.key || '').slice(0, 60);
  const value = String(body.value == null ? '' : body.value).slice(0, 200);
  if (!/^[a-z0-9_.-]+$/i.test(key)) return fail(res, 400, 'which preference?');
  await sql`
    insert into user_pref (user_id, key, value) values (${who.id}, ${key}, ${value})
    on conflict (user_id, key) do update set value = excluded.value, updated_at = now()
  `;
  return res.status(200).json({ ok: true });
}

async function listTokens(res, sql, who) {
  const rows = await sql`
    select id, label, created_at, last_used_at from device_token
    where user_id = ${who.id} and revoked_at is null
    order by created_at desc limit 20
  `;
  return res.status(200).json({
    ok: true,
    devices: rows.map((r) => ({
      id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at,
    })),
    you: { name: who.name, image: who.image },
  });
}

async function revokeToken(req, res, sql, who) {
  const id = String((req.query && req.query.token) || '');
  if (!id) return fail(res, 400, 'which device?');
  // The owner check is inside the WHERE clause so no code path can forget it.
  const rows = await sql`
    update device_token set revoked_at = now()
    where id = ${id} and user_id = ${who.id} and revoked_at is null
    returning id
  `;
  if (!rows.length) return fail(res, 404, 'not your device, or already revoked');
  return res.status(200).json({ ok: true, revoked: id });
}

/* ----------------------------------------------------------------------- reading */

async function pull(res, sql, who) {
  const flows = await sql`
    select client_id, source, kind, name, description, payload, origins, created_at, updated_at
    from user_flow
    where user_id = ${who.id} and deleted_at is null
    order by updated_at desc
  `;
  const runs = await sql`
    select client_id, kind, goal, model, flow_id, outcome, summary, error,
           steps, said, extension, started_at, finished_at
    from user_run
    where user_id = ${who.id}
    order by started_at desc nulls last limit ${RUNS_RETURNED}
  `;
  /* Facts about the PERSON, not their work. Small enough to ride along with every read rather than earn a
   * request of its own, and the first of them - whether the introduction has been seen - is needed on the
   * first render of the app, which is exactly when this answer arrives.
   *
   * Wrapped, and the reason is a bug this caused: the table arrived in a migration, the code arrived in a
   * deploy, and for the hours between them this line threw - which failed the WHOLE read. The app then
   * showed no recordings at all on any machine that did not already have them in local storage, and said
   * nothing, because a failed account read is deliberately quiet. A preference is the least important thing
   * in this response and must never be able to take the rest of it down. */
  let prefs = [];
  try {
    prefs = await sql`select key, value from user_pref where user_id = ${who.id}`;
  } catch (_) {
    /* No table yet, or no permission. Absent preferences mean the defaults, which is what a deployment
     * that has never had them should do. */
  }
  return res.status(200).json({
    ok: true,
    you: {
      name: who.name,
      image: who.image,
      prefs: Object.fromEntries(prefs.map((p) => [p.key, p.value])),
    },
    /* `source` says which half made it, and therefore which half can run it. Both are returned to
     * both clients on purpose: being told you have eleven flows and shown four is worse than
     * useless. Each client shows them all and offers Run only on its own. */
    flows: flows.map((f) => ({
      id: f.client_id, source: f.source, kind: f.kind, name: f.name, description: f.description,
      payload: f.payload, origins: f.origins, created: f.created_at, updated: f.updated_at,
    })),
    runs: runs.map((r) => ({
      id: r.client_id, kind: r.kind, goal: r.goal, model: r.model, flowId: r.flow_id,
      outcome: r.outcome, summary: r.summary, error: r.error, steps: r.steps, said: r.said,
      extension: r.extension, startedAt: r.started_at, finishedAt: r.finished_at,
    })),
  });
}

/* ----------------------------------------------------------------------- writing */

/* Upsert on (user, client id).
 *
 * The client owns identity here, because a flow is made and renamed on the client. That makes a
 * repeated push idempotent - which matters, because the extension pushes whenever something changes
 * and a retry after a dropped connection must not double anything.
 */
async function push(req, res, sql, who) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const flows = Array.isArray(body.flows) ? body.flows.slice(0, FLOWS_MAX) : [];
  const runs = Array.isArray(body.runs) ? body.runs.slice(0, RUNS_MAX) : [];
  const removed = Array.isArray(body.deleted) ? body.deleted.slice(0, FLOWS_MAX) : [];

  const problems = [];
  let savedFlows = 0;
  let savedRuns = 0;

  for (const flow of flows) {
    const clientId = text(flow && flow.id, 80);
    const payload = flow && flow.payload;
    if (!clientId || !payload || typeof payload !== 'object') {
      problems.push('a flow arrived without an id or a payload');
      continue;
    }
    const encoded = JSON.stringify(payload);
    if (encoded.length > PAYLOAD_MAX_BYTES) {
      problems.push('"' + (flow.name || clientId) + '" is too large to sync (' +
        Math.round(encoded.length / 1024) + 'KB)');
      continue;
    }
    const kind = flow.kind === 'created' ? 'created' : 'recorded';
    /* Which half made it. Not inferred from the payload: the shapes are similar enough that a guess
     * would sometimes be wrong, and a flow labelled runnable by the wrong half is a broken button. */
    const source = flow.source === 'desktop' ? 'desktop' : 'web';
    const origins = Array.isArray(flow.origins)
      ? flow.origins.filter((o) => typeof o === 'string').slice(0, 12) : [];

    await sql`
      insert into user_flow
        (user_id, client_id, source, kind, name, description, payload, origins, created_at, updated_at)
      values
        (${who.id}, ${clientId}, ${source}, ${kind}, ${text(flow.name, 80) || ''},
         ${text(flow.description, 400) || ''}, ${encoded}, ${origins},
         ${flow.created || null}, now())
      on conflict (user_id, client_id) do update set
        source = excluded.source, kind = excluded.kind, name = excluded.name,
        description = excluded.description, payload = excluded.payload, origins = excluded.origins,
        updated_at = now(), deleted_at = null
    `;
    savedFlows++;
  }

  /* Tombstoned rather than removed, so a delete on one machine propagates instead of the flow
   * reappearing from the next machine that syncs. */
  for (const id of removed) {
    const clientId = text(id, 80);
    if (!clientId) continue;
    await sql`
      update user_flow set deleted_at = now(), updated_at = now()
      where user_id = ${who.id} and client_id = ${clientId} and deleted_at is null
    `;
  }

  for (const run of runs) {
    const clientId = text(run && run.id, 80);
    if (!clientId) { problems.push('a run arrived without an id'); continue; }
    const kind = run.kind === 'replay' ? 'replay' : 'agent';
    const outcome = ['ok', 'failed', 'stopped', 'running'].includes(run.outcome)
      ? run.outcome : 'failed';
    const steps = Array.isArray(run.steps) ? run.steps.slice(0, 400) : [];
    const said = Array.isArray(run.said) ? run.said.slice(0, 200) : [];

    await sql`
      insert into user_run
        (user_id, client_id, kind, goal, model, flow_id, outcome, summary, error,
         steps, said, extension, started_at, finished_at)
      values
        (${who.id}, ${clientId}, ${kind}, ${text(run.goal, 4000)}, ${text(run.model, 60)},
         ${text(run.flowId, 80)}, ${outcome}, ${text(run.summary, 2000)}, ${text(run.error, 2000)},
         ${JSON.stringify(steps)}, ${JSON.stringify(said)}, ${text(run.extension, 20)},
         ${run.startedAt || null}, ${run.finishedAt || null})
      on conflict (user_id, client_id) do update set
        outcome = excluded.outcome, summary = excluded.summary, error = excluded.error,
        steps = excluded.steps, said = excluded.said, finished_at = excluded.finished_at,
        synced_at = now()
    `;
    savedRuns++;
  }

  return res.status(200).json({
    ok: true,
    flows: savedFlows,
    runs: savedRuns,
    deleted: removed.length,
    // Reported rather than thrown: one bad flow should not lose the rest of the push.
    problems,
  });
}

/* The outer net: anything thrown before or around the handler's own try block. */
export default wrap(handler, 'sync');
