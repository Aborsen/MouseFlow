/* Who is calling. One definition, used by every route that needs one.
 *
 * There are three kinds of caller and they cannot all present the same thing:
 *
 *   the page       same-origin, so the browser just sends the session cookie (auth is proxied
 *                  through /api/auth/*, which is what makes that cookie first-party)
 *   the extension  has no cookie for this site and cannot get one - signing in inside an extension
 *                  needs an OAuth client tied to its id, and an unpacked extension's id comes from
 *                  its folder path, different on every machine. So it presents a DEVICE TOKEN the
 *                  user pastes in once, the same way a CLI does
 *   nobody         which is a valid answer, and the reason this returns null rather than throwing
 *
 * A session is verified by asking Neon Auth, never by decoding anything here: if the issuer says the
 * session is good it is, and this file holds no signing key. A device token is ours, so it is checked
 * against our own table - by hash, because a token is a credential and what leaks from a table should
 * not be usable.
 *
 * Files in api/ beginning with an underscore are not routes, so this is importable without being
 * reachable.
 */

import { createHash } from 'node:crypto';

const AUTH_BASE = process.env.NEON_AUTH_BASE_URL;

export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

// Ours, and recognisable as ours - so a session token pasted into the wrong box fails clearly.
export const DEVICE_TOKEN_PREFIX = 'mf_';

async function fromNeonAuth(req) {
  if (!AUTH_BASE) return null;
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const cookie = String(req.headers.cookie || '');
  if (!bearer && !cookie.includes('session_token')) return null;

  let res;
  try {
    res = await fetch(AUTH_BASE.replace(/\/$/, '') + '/get-session', {
      headers: bearer
        ? { authorization: 'Bearer ' + bearer, cookie: 'better-auth.session_token=' + bearer }
        : { cookie },
    });
  } catch (_) {
    return null;
  }
  if (!res.ok) return null;

  let body;
  try { body = await res.json(); } catch (_) { return null; }
  const user = body && body.user;
  if (!user || !user.id) return null;
  return {
    id: user.id,
    name: String(user.name || user.email || 'Someone').slice(0, 120),
    /* Carried for the one check that needs it - whether this person is on the admin list. Never sent back
     * to a client wholesale; every response builds its own shape. */
    email: user.email ? String(user.email).slice(0, 200) : null,
    image: user.image ? String(user.image).slice(0, 500) : null,
    via: 'session',
  };
}

async function fromDeviceToken(req, sql) {
  const header = String(req.headers.authorization || '');
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented.startsWith(DEVICE_TOKEN_PREFIX)) return null;

  const rows = await sql`
    select t.user_id, u.name, u.email, u.image
    from device_token t
    left join neon_auth."user" u on u.id = t.user_id
    where t.token_hash = ${hashToken(presented)} and t.revoked_at is null
    limit 1
  `;
  if (!rows.length) return null;

  /* Recorded so a stale device is visible and can be revoked deliberately. Deliberately not awaited:
   * a bookkeeping write should not add latency to every call, and losing one on a cold start costs
   * nothing. */
  sql`update device_token set last_used_at = now() where token_hash = ${hashToken(presented)}`
    .catch(() => {});

  const row = rows[0];
  return {
    id: row.user_id,
    name: String(row.name || row.email || 'Someone').slice(0, 120),
    email: row.email ? String(row.email).slice(0, 200) : null,
    image: row.image ? String(row.image).slice(0, 500) : null,
    via: 'device',
  };
}

/* An OAuth access token, from api/oauth.js.
 *
 * The third way to be somebody here, and the one that scales past a single person: a device token is a
 * secret somebody carries to wherever the AI runs, which is fine for one terminal and wrong for a connector
 * an organisation installs once - then everyone shares one credential and therefore one account. An OAuth
 * token is issued per PERSON, after they sign in the way they already do.
 *
 * Read here rather than in /api/mcp so that every route gains it at once and none of them has to know there
 * are three kinds of caller. The cost is one query, and only for a bearer that is not a device token. */
async function fromOAuth(req, sql) {
  const header = String(req.headers.authorization || '');
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented || presented.startsWith(DEVICE_TOKEN_PREFIX)) return null;

  const rows = await sql`
    select t.user_id, t.expires_at, u.name, u.email, u.image
    from oauth_token t
    left join neon_auth."user" u on u.id = t.user_id
    where t.token_hash = ${hashToken(presented)} and t.kind = 'access' and t.revoked_at is null
    limit 1
  `;
  if (!rows.length) return null;
  const row = rows[0];
  // An expired token is not a caller. Left in the table so the person can still see it was there.
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

  sql`update oauth_token set last_used_at = now() where token_hash = ${hashToken(presented)}`
    .catch(() => {});

  return {
    id: row.user_id,
    name: String(row.name || row.email || 'Someone').slice(0, 120),
    email: row.email ? String(row.email).slice(0, 200) : null,
    image: row.image ? String(row.image).slice(0, 500) : null,
    via: 'oauth',
  };
}

/* The device token is tried FIRST when one is presented, because it is unambiguous - it carries our
 * prefix - and because trying the issuer first would mean a network round trip to answer "no" for
 * every extension request. An OAuth token is tried next, because it is OURS and answers locally; the
 * issuer, which is a network hop, is last. */
export async function whoIsCalling(req, sql) {
  const header = String(req.headers.authorization || '');
  if (header.includes(DEVICE_TOKEN_PREFIX)) {
    const byToken = await fromDeviceToken(req, sql);
    if (byToken) return byToken;
  }
  if (header.startsWith('Bearer ')) {
    try {
      const byOAuth = await fromOAuth(req, sql);
      if (byOAuth) return byOAuth;
    } catch (_) {
      /* No table on this deployment yet. A missing OAuth table must not be able to break the two ways of
       * signing in that predate it. */
    }
  }
  return fromNeonAuth(req);
}
