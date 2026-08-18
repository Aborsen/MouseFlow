/* The shared skill gallery.
 *
 *   GET  /api/gallery            newest published skills (public)
 *   GET  /api/gallery?id=…       one skill, with its payload, and counts an install
 *   GET  /api/gallery?mine=1     the caller's own, including withdrawn (needs a session)
 *   POST /api/gallery            publish (needs a session)
 *   DELETE /api/gallery?id=…     withdraw your own (needs a session)
 *
 * Reading is public because a gallery nobody can see is not a gallery. Writing needs a session, so
 * that a skill has an author and can be withdrawn by the person who published it.
 *
 * WHO the caller is comes from Neon Auth, which is Better Auth behind a Neon endpoint. The browser
 * holds the session cookie; this route cannot read it (different origin), so the page sends the
 * session token and the token is verified by asking Neon Auth. Verifying with the issuer rather than
 * decoding something ourselves means a forged or expired token fails, and it means this file holds
 * no signing key of any kind.
 */

import { neon } from '@neondatabase/serverless';

const AUTH_BASE = process.env.NEON_AUTH_BASE_URL;
const PAGE_MAX = 50;
const PAYLOAD_MAX_BYTES = 400_000;   // a long recording is large; a skill is not a file store

function cors(req, res) {
  /* The extension publishes directly, and an unpacked extension's id is derived from its folder
   * path, so it cannot be listed - any extension origin is allowed. The gallery page is same-origin
   * and needs nothing. As on the Claude proxy, CORS is not the access control here: the session is.
   * Credentials are deliberately NOT allowed, because the session arrives as an explicit header
   * rather than as an ambient cookie, which is what keeps this route immune to CSRF. */
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin',
    /^chrome-extension:\/\//.test(origin) ? origin : 'https://mouse-agent.vercel.app');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'gallery_error', message } });

/* Who is calling, according to Neon Auth. Null when nobody is.
 *
 * The token is passed straight to the issuer rather than inspected here. That keeps the trust in one
 * place: if Neon Auth says the session is good, it is, and if it says nothing then neither does this
 * route. */
async function caller(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !AUTH_BASE) return null;

  let res;
  try {
    res = await fetch(AUTH_BASE + '/get-session', {
      headers: { authorization: 'Bearer ' + token, cookie: 'better-auth.session_token=' + token },
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
  };
}

/* A published skill is only ever handed out through this shape, so a column added later cannot leak
 * into a public response by accident. */
const listed = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  kind: row.kind,
  author: { name: row.author_name, image: row.author_image },
  origins: row.origins || [],
  installs: row.installs,
  publishedAt: row.published_at,
  withdrawn: !!row.withdrawn_at,
  params: (row.payload && row.payload.params) || [],
});

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!process.env.DATABASE_URL) {
    fail(res, 503, 'This deployment has no database configured.');
    return;
  }
  const sql = neon(process.env.DATABASE_URL);

  try {
    if (req.method === 'GET') return await get(req, res, sql);
    if (req.method === 'POST') return await publish(req, res, sql);
    if (req.method === 'DELETE') return await withdraw(req, res, sql);
    return fail(res, 405, 'GET, POST or DELETE');
  } catch (err) {
    // The reason matters more than tidiness when a demo is failing.
    return fail(res, 500, err.message);
  }
}

async function get(req, res, sql) {
  const { id, mine, q } = req.query || {};

  if (id) {
    const rows = await sql`
      select * from gallery_skill where id = ${String(id)} and withdrawn_at is null
    `;
    if (!rows.length) return fail(res, 404, 'no such skill');
    /* Counting the install here rather than on a separate route: fetching the payload IS the
     * install, and a counter that needs a second call is a counter that undercounts. */
    await sql`update gallery_skill set installs = installs + 1 where id = ${String(id)}`;
    return res.status(200).json({ ok: true, skill: Object.assign(listed(rows[0]), {
      payload: rows[0].payload,
    }) });
  }

  if (mine) {
    const who = await caller(req);
    if (!who) return fail(res, 401, 'sign in to see your own skills');
    const rows = await sql`
      select * from gallery_skill where author_id = ${who.id}
      order by published_at desc limit ${PAGE_MAX}
    `;
    return res.status(200).json({ ok: true, skills: rows.map(listed), you: who });
  }

  const term = String(q || '').trim().slice(0, 80);
  const rows = term
    ? await sql`
        select * from gallery_skill
        where withdrawn_at is null
          and to_tsvector('english', name || ' ' || description) @@ websearch_to_tsquery('english', ${term})
        order by published_at desc limit ${PAGE_MAX}
      `
    : await sql`
        select * from gallery_skill where withdrawn_at is null
        order by published_at desc limit ${PAGE_MAX}
      `;
  return res.status(200).json({ ok: true, skills: rows.map(listed) });
}

async function publish(req, res, sql) {
  const who = await caller(req);
  if (!who) return fail(res, 401, 'sign in to publish');

  const body = req.body && typeof req.body === 'object' ? req.body : null;
  const payload = body && body.skill;
  if (!payload || typeof payload !== 'object') return fail(res, 400, 'expected { skill }');

  /* Validated here as well as in the extension. The extension is the friendly path, not the only
   * one - anything can POST - so the rules the gallery depends on are enforced where the gallery
   * is. */
  if (payload.format !== 'mouseflow.skill/1') {
    return fail(res, 400, 'unrecognised skill format');
  }
  const kind = payload.kind === 'created' ? 'created' : 'recorded';
  if (kind === 'recorded' && (!Array.isArray(payload.events) || !payload.events.length)) {
    return fail(res, 400, 'a recorded skill needs steps in it');
  }
  if (kind === 'created' && !String(payload.goalTemplate || '').trim()) {
    return fail(res, 400, 'a created skill needs a goal in it');
  }

  const encoded = JSON.stringify(payload);
  if (encoded.length > PAYLOAD_MAX_BYTES) {
    return fail(res, 413, 'that skill is too large to publish (' +
      Math.round(encoded.length / 1024) + 'KB, limit ' + Math.round(PAYLOAD_MAX_BYTES / 1024) + 'KB)');
  }

  const name = String(body.name || payload.name || 'Untitled skill').trim().slice(0, 80);
  const description = String(body.description || payload.description || '').trim().slice(0, 400);
  const origins = Array.isArray(payload.origins)
    ? payload.origins.filter((o) => typeof o === 'string').slice(0, 12)
    : [];

  /* The gallery mints the id. A client-supplied id would let one publisher overwrite another's
   * entry, and the id the extension carries is only meaningful on the machine that made it. */
  const id = 'sk_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

  await sql`
    insert into gallery_skill
      (id, author_id, author_name, author_image, name, description, kind, payload, origins)
    values
      (${id}, ${who.id}, ${who.name}, ${who.image}, ${name}, ${description}, ${kind},
       ${JSON.stringify(payload)}, ${origins})
  `;

  const rows = await sql`select * from gallery_skill where id = ${id}`;
  return res.status(201).json({ ok: true, skill: listed(rows[0]) });
}

async function withdraw(req, res, sql) {
  const who = await caller(req);
  if (!who) return fail(res, 401, 'sign in to withdraw a skill');
  const id = String((req.query && req.query.id) || '');
  if (!id) return fail(res, 400, 'which skill?');

  /* Withdrawn, not deleted: someone may already have installed it, and turning their skill into a
   * dead link is not an improvement. The author check is in the WHERE clause so it cannot be
   * skipped by a code path that forgets it. */
  const rows = await sql`
    update gallery_skill set withdrawn_at = now(), updated_at = now()
    where id = ${id} and author_id = ${who.id} and withdrawn_at is null
    returning id
  `;
  if (!rows.length) return fail(res, 404, 'not your skill, or already withdrawn');
  return res.status(200).json({ ok: true, withdrawn: id });
}
