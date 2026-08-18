/* Neon Auth, served from our own origin.
 *
 * Neon Auth lives on a Neon hostname. Talking to it directly from the page would make its session
 * cookie a THIRD-PARTY cookie for mouse-agent.vercel.app, which Chrome is progressively refusing to
 * carry - so sign-in would work one day and quietly stop the next, in a way that looks like our bug.
 *
 * So everything under /api/auth/* is forwarded to Neon Auth and the Set-Cookie on the way back has
 * its Domain attribute stripped. The cookie then belongs to this site: first-party, carried without
 * argument, and no cross-site exemption needed anywhere.
 *
 * A deliberately dumb proxy. It does not interpret Better Auth's protocol, because a proxy that
 * understands the thing it forwards is a second implementation to keep in step with the first.
 */

const AUTH_BASE = process.env.NEON_AUTH_BASE_URL;

/* Headers that describe the hop rather than the request. Forwarding these breaks things in ways that
 * are hard to see: a stale content-length truncates the body, and the original host makes the
 * upstream build redirect URLs pointing back at the wrong place. */
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authorization', 'proxy-authenticate', 'te', 'trailer',
  'content-length', 'accept-encoding',
]);

// Vercel has already parsed the body by the time we see it, so it is rebuilt rather than streamed.
function bodyFor(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const body = req.body;
  if (body == null) return undefined;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  return JSON.stringify(body);
}

export default async function handler(req, res) {
  if (!AUTH_BASE) {
    res.status(503).json({
      error: 'This deployment has no auth configured. NEON_AUTH_BASE_URL is unset.',
    });
    return;
  }

  const segments = Array.isArray(req.query.path) ? req.query.path : [req.query.path].filter(Boolean);
  const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const target = AUTH_BASE.replace(/\/$/, '') + '/' + segments.join('/') + search;

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
  }
  /* Better Auth checks the request origin against its trusted list. Our own origin is what is
   * trusted (see scripts/auth-origin.mjs), so it is stated explicitly rather than left to whatever
   * the hop happened to carry. */
  headers.origin = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'mouse-agent.vercel.app');

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: bodyFor(req),
      redirect: 'manual',        // a redirect is part of the flow; the browser must see it
    });
  } catch (err) {
    res.status(502).json({ error: 'could not reach the auth service: ' + err.message });
    return;
  }

  for (const [key, value] of upstream.headers) {
    const name = key.toLowerCase();
    if (name === 'set-cookie' || name === 'content-encoding' || name === 'content-length') continue;
    res.setHeader(key, value);
  }

  /* The point of the whole file.
   *
   * Drop Domain so the cookie is host-only for this site, and drop SameSite=None, which only exists
   * because the cookie used to be cross-site. Lax is both correct now and required for the
   * OAuth callback: a redirect arriving from Google is a cross-site GET, which Strict would refuse
   * to send the cookie on, leaving the user signed in everywhere except the page they landed on.
   */
  const cookies = typeof upstream.headers.getSetCookie === 'function'
    ? upstream.headers.getSetCookie()
    : [upstream.headers.get('set-cookie')].filter(Boolean);
  if (cookies.length) {
    res.setHeader('Set-Cookie', cookies.map((cookie) => cookie
      .replace(/;\s*Domain=[^;]*/i, '')
      .replace(/;\s*SameSite=None/i, '; SameSite=Lax')));
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.status(upstream.status).send(buffer);
}
