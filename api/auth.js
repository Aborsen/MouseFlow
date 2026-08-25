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

import { report } from './_report.js';

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

/* THE session cookie - the long-lived one, and the only cookie here that has no cross-site work left
 * to do once it exists. Everything else in this flow is short-lived OAuth machinery whose whole
 * purpose is to come back from somewhere else.
 *
 * Matched on `session_token`, which is also what api/_session.js looks for when it decides whether a
 * request carries a session at all - one name, checked the same way in both places. */
const SESSION_COOKIE = /session_token/i;

/* Makes an upstream cookie belong to THIS site.
 *
 * Domain is dropped from everything: these cookies are set through our own origin, and a Domain
 * attribute naming the upstream's host is one the browser would refuse from us anyway.
 *
 * `Partitioned` is dropped from everything, which is what Neon's own reference proxy does
 * (`parsedCookie.partitioned = void 0`). A partitioned cookie is keyed to the top-level site it was
 * set under; these are set under ours and only ever read on ours, so the attribute can do nothing
 * here except confuse a browser mid-redirect.
 *
 * SameSite is Lax for the SESSION and None for everything else, and the split is narrower than it
 * looks. The only non-session cookie that matters is the OAuth challenge, and its whole job is to be
 * present when the browser lands back on OUR /api/auth/finish - which it reaches from the auth
 * service, cross-site, at the end of a redirect chain. `Lax` is documented to travel on a top-level
 * cross-site GET and Chrome obliges; Safari does not do it at the end of a CHAIN (WebKit 196375,
 * 219650, still open), which is what 400 SESSION_CHALLENGE_COOKIE_NOT_FOUND was.
 *
 * Two corrections to earlier guesses in this file, both worth keeping written down. The upstream sends
 * `session_challenge` AND `session_challange` - the misspelling is deliberate and named
 * LEGACY_SESSION_CHALLENGE_COOKIE_NAME in the SDK - so a rule that matches cookie NAMES will always
 * miss one. And starting OAuth needs no cookie from us at all: the `/sign-in/social/init?token=` hop
 * works with an empty jar and sets its own `state` and `aid` first-party to the auth service's hosts.
 * So a `state_mismatch` is NOT this function's doing - it happens on the auth service's own shared
 * host, with its own cookies, before anything here is consulted.
 */
const firstParty = (cookie) => {
  const name = String(cookie).split('=', 1)[0].trim();
  const owned = cookie
    .replace(/;\s*Domain=[^;]*/i, '')
    .replace(/;\s*Partitioned/i, '');
  if (SESSION_COOKIE.test(name)) {
    return owned.replace(/;\s*SameSite=None/i, '; SameSite=Lax');
  }
  /* SameSite=None is only honoured on a Secure cookie, so the two travel together: a cookie that has
   * one without the other is a cookie the browser drops without saying so. */
  const cross = /;\s*SameSite=(Lax|Strict)/i.test(owned)
    ? owned.replace(/;\s*SameSite=(Lax|Strict)/i, '; SameSite=None')
    : (/;\s*SameSite=None/i.test(owned) ? owned : owned + '; SameSite=None');
  return /;\s*Secure/i.test(cross) ? cross : cross + '; Secure';
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

  /* Every way this can fail ends here, and it REPORTS BEFORE IT REDIRECTS.
   *
   * The reason used to exist only in the address bar, which meant it existed only until the person who
   * saw it closed the tab. From the database a failed sign-in looks like three sessions in twenty-two
   * seconds - the round trip completes, the hand-off does not, and the user simply tries again - and not
   * one of those rows says why. Asking somebody to reproduce it with a screenshot is asking them to be
   * our instrumentation. So the reason now travels on its own.
   *
   * WHAT GOES: the outcome, whatever the upstream called the refusal, where the browser was headed, and
   * the browser itself. The last one is not decoration - a failure that clusters on one engine is a
   * different bug from one that does not, and nothing else here would show that.
   *
   * WHAT DOES NOT: the verifier. It is a one-time credential; report() drops the query string, and
   * nothing below hands any piece of it over by another route. Nor the cookies, nor the address.
   *
   * A `warning` is a circumstance rather than a defect: somebody closed the Google tab, or came back in
   * a different browser from the one they left in. Still worth counting, not worth paging anyone.
   */
  const bounced = async (outcome, why, level) => {
    await report(
      new Error('sign-in did not complete: ' + outcome + (why ? ' — ' + why : '')),
      req,
      {
        route: 'auth/finish',
        level,
        detail: {
          outcome,
          why: why || null,
          to: back.slice(0, 120),
          browser: String(req.headers['user-agent'] || '').slice(0, 200),
        },
      },
    );
    res.writeHead(302, { location: landing(outcome, why) });
    res.end();
  };

  if (!verifier) return bounced('missing-verifier', '', 'warning');

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
    /* An error, not a warning: the auth service being unreachable from our own function is ours. */
    return bounced('unreachable', String(err && err.message ? err.message : err).slice(0, 60), 'error');
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
    /* "Answered ok and set no cookie" is the upstream breaking its own contract, so that one is an error.
     * A plain refusal carries the upstream's own code and is counted rather than escalated. */
    return upstream.ok
      ? bounced('no-session-cookie', why, 'error')
      : bounced('rejected', why, 'warning');
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
