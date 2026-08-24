/* Shared demo key, held server-side.
 *
 * The demo needs every attendee to use ONE key without each of them pasting one in. The
 * obvious way - put the key in the extension - does not work, because an extension is
 * shipped as readable source: anyone it is handed to can open the folder, or
 * chrome://extensions, and read the key straight out of agent.js. A key distributed that way
 * is a key published, and it stays valid until someone notices. Anthropic and GitHub both
 * scan for exposed keys and revoke them, so it is also likely to simply stop working
 * mid-demo.
 *
 * So the key lives here, in a Vercel environment variable, and this route forwards requests
 * to Anthropic with it attached. The extension calls this endpoint and never sees the key.
 * It can be rotated or switched off from the Vercel dashboard without touching the extension
 * anyone has installed.
 *
 * This endpoint spends money for anyone who can reach it, so it is deliberately narrow:
 * one model, a capped max_tokens, a capped conversation size, and only the fields the agent
 * actually needs are passed through. That bounds what ONE request can cost.
 *
 * And it is no longer anonymous. Every call must identify a person - a signed-in session from the
 * app, or a device token from a paired extension - because a shared key that anyone who finds the
 * URL can spend is a key with no owner and no way to tell whose run cost what. The rate limit is
 * counted per account rather than per IP for the same reason: an IP is not a person, and a room full
 * of people at a demo shares one.
 *
 * This is also what makes the extension's sign-in wall more than a screen. The wall can be walked
 * around by anyone willing to edit the extension's own source, which is readable; this cannot.
 */

import { neon } from '@neondatabase/serverless';
import { whoIsCalling } from './_session.js';
import { readSettings } from './admin.js';
/* Server-side crashes reach Sentry from here. See api/_report.js — no dependency, and it
 * deliberately sends the route and the message, never the query string or the body. */
import { report, wrap } from './_report.js';
import { ALLOWED_MODELS, MAX_BODY_BYTES, MAX_MESSAGES, MAX_TOKENS_CAP, callModel } from './_vision.mjs';

/* The call itself, the caps on it, and the key it spends live in api/_vision.mjs - because the cloud step
 * makes the same call from inside another function, and a second copy of the caps is a second copy that can
 * drift. What is left here is what an ENDPOINT owes: CORS, who is calling, and a rate limit per account. */

/* Per-caller rate limit.
 *
 * The caps above bound what ONE request can cost; they do nothing about ten thousand of them, and
 * the earlier comment claiming they protected the credit balance was overstating it. This is
 * best-effort by construction: a serverless instance holds its own window, so the real limit is
 * this multiplied by however many instances are warm. It stops a stuck client and casual abuse,
 * not a determined one - put real auth in front of this if it outlives the demo.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const hits = new Map();

function rateLimited(key) {
  const now = Date.now();
  const seen = (hits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  seen.push(now);
  hits.set(key, seen);
  // Unbounded growth would outlive the instance; drop windows nobody is using.
  if (hits.size > 500) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  }
  return seen.length > RATE_MAX;
}

function cors(req, res) {
  const origin = req.headers.origin || '';
  /* CORS is not a security control here and should not be mistaken for one: it governs what a
   * BROWSER will let a page read, and anything that is not a browser can POST regardless. What
   * actually bounds this endpoint is the validation below. What CORS is for is not handing a
   * browsable credential to every local dev server on the machine - localhost used to be
   * reflected, which let any page on any local port read the responses.
   *
   * The extension's origin is chrome-extension://<id>, and an unpacked extension's id is derived
   * from its folder path, so it cannot be listed - any extension origin is accepted. */
  const allowed = /^chrome-extension:\/\//.test(origin)
    ? origin
    : 'https://mouse-agent.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function fail(res, status, message) {
  res.status(status).json({ error: { type: 'proxy_error', message } });
}

async function handler(req, res) {
  cors(req, res);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  /* Is this deployment ready to serve a demo?
   *
   * Worth being able to answer before walking into one, rather than finding out from the first
   * failed run. Reports only whether a key is present - never the key, never a prefix, never a
   * length, since any of those narrow a guess.
   */
  if (req.method === 'GET') {
    /* `model` is what the desktop engine, the plan preview and the extension should use for their next
     * run - they ask here rather than shipping a constant, so changing it in the admin panel changes the
     * next run everywhere without a deploy. The admin's choice is validated against ALLOWED_MODELS on
     * write; the intersection here is belt and braces for a stale row. `planModel` and `extensionModel`
     * fall back to `model`, so one setting moves everything unless the admin split them on purpose. */
    const settings = process.env.DATABASE_URL
      ? await readSettings(neon(process.env.DATABASE_URL))
      : {};
    const pick = (key) => {
      const v = settings[key];
      return v && ALLOWED_MODELS.has(v) ? v : null;
    };
    const engine = pick('model.desktop') ?? [...ALLOWED_MODELS][0];
    res.status(200).json({
      ok: true,
      configured: !!process.env.ANTHROPIC_API_KEY,
      model: engine,
      planModel: pick('model.plan') ?? engine,
      extensionModel: pick('model.extension') ?? engine,
      maxTokens: MAX_TOKENS_CAP,
    });
    return;
  }

  if (req.method !== 'POST') { fail(res, 405, 'POST only'); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    fail(res, 503, 'This deployment has no shared key configured. Set ANTHROPIC_API_KEY in the ' +
      'Vercel project, or add your own key in the extension.');
    return;
  }

  /* Who is spending the shared key. The extension presents the device token it was paired with;
   * the app is same-origin, so its session cookie comes along by itself. */
  if (!process.env.DATABASE_URL) {
    fail(res, 503, 'This deployment cannot check who is calling, so the shared key is switched off. ' +
      'Add your own API key in the extension.');
    return;
  }
  let who;
  try {
    who = await whoIsCalling(req, neon(process.env.DATABASE_URL));
  } catch (err) {
    fail(res, 503, 'could not check who is calling: ' + err.message);
    return;
  }
  if (!who) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    fail(res, 401, 'Sign in to use the shared key: open the extension and press Continue with ' +
      'Google, or add your own Anthropic key.');
    return;
  }

  if (rateLimited(who.id)) {
    res.setHeader('Retry-After', '60');
    fail(res, 429, 'too many requests on the shared demo key - wait a minute, or add your ' +
      'own API key in the extension');
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : null;
  if (!body) { fail(res, 400, 'expected a JSON body'); return; }

  if (!ALLOWED_MODELS.has(body.model)) {
    fail(res, 400, 'model not allowed here: ' + String(body.model));
    return;
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    fail(res, 400, 'messages must be a non-empty array');
    return;
  }
  if (body.messages.length > MAX_MESSAGES) {
    fail(res, 413, 'conversation too long for the demo proxy (' + body.messages.length +
      ' messages, limit ' + MAX_MESSAGES + ')');
    return;
  }

  // callModel rebuilds the payload field by field, so a caller cannot smuggle in options this endpoint is
  // not meant to pay for.
  const answer = await callModel(body, key);
  if (answer.tooLarge) {
    fail(res, 413, 'request too large: ' + Math.round(answer.bytes / 1024) + 'KB, limit ' +
      Math.round(MAX_BODY_BYTES / 1024) + 'KB');
    return;
  }
  if (answer.unreachable) {
    fail(res, 502, 'could not reach the API: ' + answer.unreachable);
    return;
  }

  // Passed through as-is: the agent already reads Anthropic's error shape, and rewriting it
  // here would hide the real reason a run failed.
  res.status(answer.status);
  res.setHeader('Content-Type', answer.contentType);
  res.send(answer.text);
}

/* The outer net: anything thrown before or around the handler's own try block. */
export default wrap(handler, 'claude');
