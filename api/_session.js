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
    image: row.image ? String(row.image).slice(0, 500) : null,
    via: 'device',
  };
}

/* The device token is tried FIRST when one is presented, because it is unambiguous - it carries our
 * prefix - and because trying the issuer first would mean a network round trip to answer "no" for
 * every extension request. */
export async function whoIsCalling(req, sql) {
  const header = String(req.headers.authorization || '');
  if (header.includes(DEVICE_TOKEN_PREFIX)) {
    const byToken = await fromDeviceToken(req, sql);
    if (byToken) return byToken;
  }
  return fromNeonAuth(req);
}
