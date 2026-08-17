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
 * actually needs are passed through. That bounds the damage if the URL gets around; it does
 * not make the endpoint private. For anything beyond a demo, put auth in front of it.
 */

const UPSTREAM = 'https://api.anthropic.com/v1/messages';

// Only what the agent uses, and only within these bounds.
const ALLOWED_MODELS = new Set(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
const MAX_TOKENS_CAP = 16000;
const MAX_MESSAGES = 120;              // a runaway loop should hit this, not the credit balance
const MAX_BODY_BYTES = 1_500_000;

function cors(req, res) {
  const origin = req.headers.origin || '';
  /* The extension's origin is chrome-extension://<id>, and an unpacked extension's id is
   * derived from its folder path - different on every machine - so it cannot be listed here.
   * Any extension origin is accepted; the request is bounded by the limits above rather than
   * by who is asking. */
  const allowed = /^chrome-extension:\/\//.test(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin)
    ? origin
    : 'https://mouse-agent.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function fail(res, status, message) {
  res.status(status).json({ error: { type: 'proxy_error', message } });
}

export default async function handler(req, res) {
  cors(req, res);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  /* Is this deployment ready to serve a demo?
   *
   * Worth being able to answer before walking into one, rather than finding out from the first
   * failed run. Reports only whether a key is present - never the key, never a prefix, never a
   * length, since any of those narrow a guess.
   */
  if (req.method === 'GET') {
    res.status(200).json({
      ok: true,
      configured: !!process.env.ANTHROPIC_API_KEY,
      model: [...ALLOWED_MODELS][0],
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

  // Rebuilt field by field rather than forwarded wholesale, so a caller cannot smuggle in
  // options this endpoint is not meant to pay for.
  const payload = {
    model: body.model,
    max_tokens: Math.min(Number(body.max_tokens) || 4096, MAX_TOKENS_CAP),
    messages: body.messages,
  };
  if (typeof body.system === 'string') payload.system = body.system;
  if (Array.isArray(body.tools)) payload.tools = body.tools;
  if (body.tool_choice) payload.tool_choice = body.tool_choice;
  if (body.fallbacks) payload.fallbacks = body.fallbacks;

  const encoded = JSON.stringify(payload);
  if (encoded.length > MAX_BODY_BYTES) { fail(res, 413, 'request too large'); return; }

  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // Opus 5's safety classifiers can decline a request; this re-runs it on the
        // recommended fallback server-side instead of handing back a dead end.
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: encoded,
    });
  } catch (err) {
    fail(res, 502, 'could not reach the API: ' + err.message);
    return;
  }

  const text = await upstream.text();
  // Passed through as-is: the agent already reads Anthropic's error shape, and rewriting it
  // here would hide the real reason a run failed.
  res.status(upstream.status);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
  res.send(text);
}
