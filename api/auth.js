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

/* The name Neon Auth gives the one-time value that completes an OAuth sign-in. */
const VERIFIER = 'neon_auth_session_verifier';

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

/* Cookies that have to survive a CROSS-SITE return, and therefore keep SameSite=None.
 *
 * The OAuth challenge is the whole example. It is written when the sign-in starts and read when the
 * browser comes back - and it comes back from Google, through the auth service, as a navigation from
 * ANOTHER SITE. `Lax` is documented to be sent on a top-level cross-site GET, and Chrome does send
 * it; Safari on iOS does not send it at the end of a cross-site redirect CHAIN, which is exactly the
 * shape of this flow. The result was a sign-in that worked on every desktop and failed on a phone
 * with 400 SESSION_CHALLENGE_COOKIE_NOT_FOUND - the cookie was never withheld from us, it was
 * withheld from the request that needed it.
 *
 * So these keep the attribute the upstream chose. It is a short-lived, single-purpose value that
 * exists to be returned cross-site, which is the case SameSite=None is for; the session cookie that
 * follows is still pinned to Lax below. */
const CROSS_SITE_COOKIE = /(challenge|state|nonce|pkce|verifier|oauth)/i;

/* Makes an upstream cookie belong to THIS site.
 *
 * Drop Domain so it is host-only here. SameSite=None becomes Lax for everything that lives on this
 * site afterwards - the session - because there is no longer any cross-site request for it to be
 * carried on, and Lax is the smaller permission.
 */
const firstParty = (cookie) => {
  const name = String(cookie).split('=', 1)[0].trim();
  const owned = cookie.replace(/;\s*Domain=[^;]*/i, '');
  if (CROSS_SITE_COOKIE.test(name)) {
    /* SameSite=None is only honoured on a Secure cookie, and an upstream that sent None has already
     * set Secure - but a cookie that lost one of the two is a cookie silently dropped, so it is
     * stated rather than assumed. */
    return /;\s*Secure/i.test(owned) ? owned : owned + '; Secure';
  }
  return owned.replace(/;\s*SameSite=None/i, '; SameSite=Lax');
};

// Vercel has already parsed the body by the time we see it, so it is rebuilt rather than streamed.
function bodyFor(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const body = req.body;
  if (body == null) return undefined;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  return JSON.stringify(body);
}

/* Exchanges the verifier for a session, then sends the browser where it was going.
 *
 * The exchange IS a get-session call: it carries the challenge cookie from the browser, and the
 * upstream answers with the Set-Cookie that establishes the real session. Nothing here interprets
 * that cookie - it is rewritten to be first-party and passed on, exactly as every other response is.
 */
async function finishSignIn(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'mouse-agent.vercel.app';
  const here = new URL(req.url, 'https://' + host);
  const verifier = here.searchParams.get(VERIFIER);
  // Where the user was going. Kept relative so this cannot be turned into an open redirect.
  const to = (here.searchParams.get('to') || '/').replace(/^[^/]*\/\//, '/');
  const back = to.startsWith('/') ? to : '/' + to;

  /* The outcome has to go in the QUERY, which means taking `back` apart: appending "?auth=ok" to a
   * destination that already has a query or a fragment produced "/?pair=extension#skills?auth=ok",
   * where the parameter lands inside the fragment and nothing ever reads it. */
  const landing = (outcome, why) => {
    const url = new URL(back, 'https://' + host);
    url.searchParams.set('auth', outcome);
    if (why) url.searchParams.set('why', why);
    return url.pathname + url.search + url.hash;
  };

  if (!verifier) {
    res.writeHead(302, { location: landing('missing-verifier') });
    res.end();
    return;
  }

  let upstream;
  try {
    upstream = await fetch(AUTH_BASE.replace(/\/$/, '') + '/get-session?' + VERIFIER + '=' +
      encodeURIComponent(verifier), {
      headers: {
        cookie: req.headers.cookie || '',
        origin: 'https://' + host,
        accept: 'application/json',
      },
    });
  } catch (err) {
    res.writeHead(302, { location: landing('unreachable') });
    res.end();
    return;
  }

  const cookies = typeof upstream.headers.getSetCookie === 'function'
    ? upstream.headers.getSetCookie()
    : [upstream.headers.get('set-cookie')].filter(Boolean);

  if (!upstream.ok || !cookies.length) {
    /* No cookie means no session, and redirecting as though it worked would leave the page saying
     * "signed out" with no explanation. Say which half failed - and, when the upstream refused, say
     * what IT said.
     *
     * This used to redirect with a bare "rejected" and drop the upstream's own answer on the floor,
     * which is how a sign-in that works on a desktop and fails on a phone stayed unexplained: the
     * one machine that knew the reason threw it away. The code is short, safe to put in a query -
     * it names a failure mode, never a token - and it is the difference between "try again" and
     * knowing which thing to fix. */
    let why = '';
    if (!upstream.ok) {
      try {
        const said = await upstream.text();
        const parsed = said && said.trim().startsWith('{') ? JSON.parse(said) : null;
        why = String(parsed?.code || parsed?.error?.code || parsed?.message || '')
          .slice(0, 60).replace(/[^A-Za-z0-9 _.-]/g, '');
      } catch (_) { /* An upstream that cannot even be read is described by its status alone. */ }
      why = why ? upstream.status + ' ' + why : String(upstream.status);
    }
    res.writeHead(302, { location: landing(upstream.ok ? 'no-session-cookie' : 'rejected', why) });
    res.end();
    return;
  }

  res.setHeader('Set-Cookie', cookies.map(firstParty));
  res.writeHead(302, { location: landing('ok') });
  res.end();
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

  /* Finishing an OAuth sign-in is the one thing here that is not a plain forward.
   *
   * Google redirects to Neon's own host, not ours - the redirect_uri is fixed to their domain - so
   * Neon completes its half and then sends the browser to our callbackURL carrying a one-time
   * verifier. Turning that verifier into a session needs a SERVER: the exchange reads the
   * session-challenge cookie set when sign-in began, and a static page cannot set the session cookie
   * that comes back. Landing the callback here rather than on the page is what makes that possible.
   */
  if (subpath === 'finish') {
    await finishSignIn(req, res);
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
  if (cookies.length) res.setHeader('Set-Cookie', cookies.map(firstParty));

  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.status(upstream.status).send(buffer);
}
