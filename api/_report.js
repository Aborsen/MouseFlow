/* Server-side crash reporting, in about a hundred lines and no dependency.
 *
 * WHY NOT @sentry/node, WHICH IS THE OBVIOUS ANSWER. It was installed, measured and removed. On this
 * machine it costs 280ms to import and another 48ms to initialise, against 9.5ms for
 * @neondatabase/serverless — the only dependency these functions had. Vercel bundles per function, so that
 * is a third of a second added to the cold start of every route here, and it lands on the two paths where
 * latency is actually felt: the MCP server calling in, and the agent polling the run queue with a 25-second
 * wait. It also puts 57MB of OpenTelemetry into every function to send what is, in the end, one HTTP POST.
 *
 * So this sends the POST. What it gives up is real and worth naming: no breadcrumbs, no tracing, no
 * automatic context, no release health. If any of that is wanted later, swapping this file for the SDK is a
 * contained change — every caller uses `report()` and `wrap()` and neither signature mentions Sentry.
 *
 * THE FORMAT IS NOT GUESSED. It was read off the official SDK: @sentry/node 10.70.0 was installed, given a
 * transport that captured what it was about to send, and asked to report a real exception. The three lines
 * below are the shape it produced. That matters, because a hand-written wire format that was reasoned about
 * rather than observed is a thing that silently sends nothing.
 *
 *   line 1   envelope header  { event_id, sent_at, sdk }
 *   line 2   item header      { type: "event" }
 *   line 3   the event        { exception: { values: [...] }, level, platform, timestamp, ... }
 *
 * Sent to `https://<host>/api/<project>/envelope/?sentry_key=<key>&sentry_version=7`, which is the part of
 * the DSN's anatomy this file depends on. Envelope v7 has been stable for years; if Sentry ever moves off
 * it, the symptom is events silently not arriving, and the fix is to swap in the SDK.
 *
 * NOTHING HERE THROWS, and nothing here blocks a response for long. A crash reporter that turns a handled
 * 500 into an unhandled one, or that adds a second to every error response, is worse than no reporter.
 */

const TIMEOUT_MS = 2_000;

/* Same variable the browser build reads. Vercel puts every project variable into the function runtime
 * regardless of prefix, so there is no second DSN to configure — and SENTRY_DSN is honoured first in case
 * the server is ever pointed at a project of its own. */
const dsnOf = () => process.env.SENTRY_DSN || process.env.VITE_SENTRY_DSN || '';

/** `https://<key>@<host>/<project>` → the pieces the ingest URL is built from, or null. */
function parseDsn(raw) {
  try {
    const url = new URL(raw);
    const project = url.pathname.replace(/^\//, '');
    if (!url.username || !url.host || !project) return null;
    /* The scheme comes FROM the DSN rather than being assumed https. Every sentry.io DSN is https, so this
     * looks like pedantry — but hardcoding it makes a self-hosted Sentry on http unreachable, and it makes
     * this file impossible to point at a local server, which is how the envelope below was checked. */
    return { protocol: url.protocol, key: url.username, host: url.host, project };
  } catch (_) {
    return null;
  }
}

const hex32 = () => {
  let out = '';
  for (let i = 0; i < 32; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
};

/* `at fn (/var/task/api/insights.js:512:19)` and the bare `at /var/task/... ` form, which is what a top-level
 * frame looks like. Sentry draws the trace with the innermost frame LAST, and Node writes it first, so the
 * list is reversed on the way out. */
const FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

function framesOf(stack) {
  if (typeof stack !== 'string') return [];
  const frames = [];
  for (const line of stack.split('\n').slice(1)) {
    const m = FRAME.exec(line);
    if (!m) continue;
    const filename = m[2];
    frames.push({
      filename,
      function: m[1] || '?',
      lineno: Number(m[3]),
      colno: Number(m[4]),
      /* Ours, or the runtime's. Sentry greys out everything that is not in_app, which is the difference
       * between a readable trace and forty frames of node internals. */
      in_app: !filename.startsWith('node:') && !filename.includes('node_modules'),
    });
  }
  return frames.reverse();
}

/* What is safe to say about the request that failed.
 *
 * Method and route only. NOT the query string, NOT the body, NOT the headers — those carry session cookies,
 * bearer tokens and, on /api/chat, the question somebody typed. The browser reporter scrubs a query string
 * by allowlist; here the answer is simpler, because nothing downstream needs it: the route and the message
 * are what identify a bug. */
function requestOf(req) {
  if (!req) return undefined;
  const path = String(req.url || '').split('?')[0];
  return { method: req.method, url: path };
}

async function send(event) {
  const dsn = parseDsn(dsnOf());
  if (!dsn) return false;

  const id = event.event_id || hex32();
  const envelope = [
    JSON.stringify({ event_id: id, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify({ ...event, event_id: id }),
  ].join('\n');

  try {
    const res = await fetch(
      `${dsn.protocol}//${dsn.host}/api/${dsn.project}/envelope/?sentry_key=${dsn.key}&sentry_version=7`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-sentry-envelope' },
        body: envelope,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    return res.ok;
  } catch (_) {
    /* Silent on purpose. The caller is already handling a failure; a reporter that logged its own failure
     * on top would double every incident in the function log. */
    return false;
  }
}

/**
 * Report one error. Awaited by the caller BEFORE it responds, because a serverless function can be frozen
 * the instant it returns and an in-flight request dies with it — the reason the SDK has `flush()` at all.
 *
 * `extra` carries three optional things beyond the route tag:
 *   where   a sentence about the place, kept for the callers that already pass one
 *   detail  fields to put beside the event — the caller's job, not this file's, because the one thing
 *           that must never travel is the query string, and only the caller knows which of ITS values
 *           are safe to name. Nothing here reads req beyond method and path.
 *   level   'warning' for a failure that is somebody's circumstance rather than our fault — an
 *           abandoned sign-in is not a defect, but we still want to see how often it happens.
 */
export async function report(err, req, extra) {
  if (!dsnOf()) return;
  const error = err instanceof Error ? err : new Error(String(err && err.message ? err.message : err));
  const beside = extra && (extra.where || extra.detail)
    ? { ...(extra.where ? { where: extra.where } : {}), ...(extra.detail || {}) }
    : undefined;
  await send({
    level: extra && extra.level === 'warning' ? 'warning' : 'error',
    platform: 'node',
    timestamp: Date.now() / 1000,
    environment: process.env.VERCEL_ENV || 'development',
    release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
    server_name: undefined,
    exception: {
      values: [{
        type: error.name || 'Error',
        value: String(error.message || '').slice(0, 1000),
        stacktrace: { frames: framesOf(error.stack) },
      }],
    },
    request: requestOf(req),
    tags: extra && extra.route ? { route: extra.route } : undefined,
    extra: beside,
  });
}

/**
 * A crash that happened somewhere else and was told to us.
 *
 * The agents are the case this exists for: a Swift binary under launchd and a PowerShell script in a
 * window, both on somebody else's computer, both of which fail into a log file nobody is looking at. They
 * already dial this deployment with a device token, so the cheapest honest reporter is to let them say what
 * happened and to forward it from here - which also means no DSN inside a program a user downloads, and a
 * crash that arrives already attached to an account.
 *
 * THE STACK IS NOT PARSED, deliberately. framesOf() reads V8's format; a Swift backtrace and PowerShell's
 * ScriptStackTrace are neither that nor each other, and a parser that half-recognises a foreign format
 * produces a trace that is confidently wrong. It travels as text under `extra`, where it is readable and
 * cannot be mistaken for something this side worked out.
 */
export async function reportSaid(said) {
  if (!dsnOf()) return false;
  const type = String((said && said.type) || 'AgentError').slice(0, 80);
  const message = String((said && said.message) || '').slice(0, 1000);
  if (!message) return false;
  const stack = said && said.stack ? String(said.stack).slice(0, 4000) : '';

  return send({
    level: said && said.level === 'warning' ? 'warning' : 'error',
    /* Not 'node'. What ran was Swift or PowerShell, and saying otherwise would put every agent crash in the
     * same bucket as this deployment's own. */
    platform: 'other',
    timestamp: Date.now() / 1000,
    environment: process.env.VERCEL_ENV || 'development',
    exception: { values: [{ type, value: message }] },
    tags: said && said.tags ? said.tags : undefined,
    /* ЧЕЙ ЭТО КРАШ. Только id, никогда не почта: sendDefaultPii здесь выключен намеренно, и смысл этого
     * поля не в том, чтобы узнать человека, а в том, чтобы «агент упал у троих» отличалось от «агент упал
     * триста раз у одного». Без него api/mcp.js обосновывал свой маршрут тем, что приходящее «уже привязано
     * к аккаунту и машине», - и не привязывал. */
    user: said && said.user && said.user.id ? { id: String(said.user.id).slice(0, 64) } : undefined,
    extra: stack ? { ...(said.extra || {}), stack } : (said && said.extra) || undefined,
  });
}

/**
 * The outer net: an exception that escapes a handler entirely.
 *
 * Most routes here catch their own errors and answer 500 themselves — which is exactly why `report()` is
 * called from inside those catch blocks rather than only here. This wrapper is for the ones that do not,
 * and for anything thrown before a route's own try block is reached.
 */
export function wrap(handler, route) {
  return async function reported(req, res) {
    try {
      return await handler(req, res);
    } catch (err) {
      await report(err, req, { route });
      if (!res.headersSent) {
        res.status(500).json({ error: { type: 'server_error', message: 'something failed on the server' } });
      }
      return undefined;
    }
  };
}
