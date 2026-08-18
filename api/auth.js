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
 *
 * The subpath arrives as ?authpath=… from a rewrite in vercel.json rather than from a filesystem
 * catch-all. A catch-all file reached this function for a one-segment path and 404'd at the platform
 * for two, because this project has no framework preset and so no framework-aware routing; an
 * explicit rewrite works the same at every depth.
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

/* Headers describing OUR hop, which the upstream must not see.
 *
 * Forwarding x-forwarded-host told Neon Auth the request was for mouse-agent.vercel.app, which is
 * not a host it serves, and it answered 400 "Invalid hostname header" for every single call. The
 * x-vercel-* set is the same kind of thing: true of the hop, false of the request being forwarded. */
const OUR_HOP = /^(x-forwarded-|x-vercel-|x-real-ip$|forwarded$|cdn-loop$)/i;

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

  const subpath = String((req.query && req.query.authpath) || '').replace(/^\/+/, '');
  if (!subpath) {
    res.status(404).json({ error: 'no auth path given' });
    return;
  }
  /* The caller's own query string, minus the parameter the rewrite added. Better Auth needs the
   * original query intact - the OAuth callback carries `code` and `state` there. */
  const incoming = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
  incoming.delete('authpath');
  const query = incoming.toString();
  const target = AUTH_BASE.replace(/\/$/, '') + '/' + subpath + (query ? '?' + query : '');

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const name = key.toLowerCase();
    if (!HOP_BY_HOP.has(name) && !OUR_HOP.test(name)) headers[key] = value;
  }
  /* Better Auth checks the request origin against its trusted list. Our own origin is what is
   * trusted (see scripts/auth-origin.mjs), so it is stated explicitly rather than left to whatever
   * the hop happened to carry. */
  headers.origin = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'mouse-agent.vercel.app');
  // Same reasoning as OUR_HOP: the upstream should see a plain request, not a proxied one.
  delete headers.referer;

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
