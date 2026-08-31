/* Process documents: list, read, save, revert, delete.
 *
 * SCOPING. Every statement filters on the id whoIsCalling() returned, inside the WHERE clause, and no code
 * path reads an account id from the request. A document belonging to somebody else and a document that does
 * not exist answer the same 404 on purpose: different answers would confirm that an id exists.
 *
 * WHAT THIS ROUTE DOES NOT DO. It does not WRITE a document - that is api/_recording-tools.js's
 * write_process_doc, because writing one means reading a transcript, calling a model, and paying for it, and
 * all three belong where the assistant's own rules and budgets already apply. This route is the page's half:
 * reading what was written and keeping the edits.
 *
 * EVERY SAVE KEEPS THE PREVIOUS TEXT. A generated procedure is wrong somewhere - that is its normal
 * condition - so the edit that corrects it has to be reversible without trusting anybody's memory of what
 * was there before. `revision` is bumped and the new text is appended to user_doc_version; nothing is
 * overwritten in place except the row that says which revision is current.
 */
import { neon } from '@neondatabase/serverless';

import { whoIsCalling } from './_session.js';
import { report, wrap } from './_report.js';
import { cors } from './_cors.mjs';
import { titleOf } from './_docs.mjs';

/* A document is Markdown a person edits, so the ceiling is generous - and it exists, because a body with no
 * ceiling is a column somebody can fill with a video. 400 KB is far past any procedure and far short of a
 * problem. */
const BODY_MAX = 400_000;
const TITLE_MAX = 200;

/* How many documents the list returns. The page shows them all; this is the guard against an account that
 * has generated a thousand. */
const LIST_MAX = 200;

/* How many past revisions travel with one document. The page offers them as "put this back"; a hundred is
 * more history than anybody reads and still bounded. */
const VERSIONS_MAX = 100;

const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'docs_error', message } });

/* The same shape the id is minted in - letters, digits and underscore - checked here rather than trusted.
 * A route that interpolates an unchecked id into a query is the shape of the bug this whole file avoids by
 * parameterising, but the check also keeps the 404 honest: a malformed id is not "not found on this
 * account", it is not an id. */
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

const iso = (at) => (at ? new Date(at).toISOString() : null);

/* One row, shaped for the page. `flowIds` travels as an array of the ids the citations point into, so the
 * page can offer "open the recording this came from" without a second request. */
const shape = (row) => ({
  id: row.id,
  title: row.title || '',
  body: row.body || '',
  flowIds: Array.isArray(row.flow_ids) ? row.flow_ids : [],
  model: row.model || null,
  effort: row.effort || null,
  revision: Number(row.revision) || 1,
  created: iso(row.created_at),
  updated: iso(row.updated_at),
});

/* THE LIST CARRIES NO BODIES, and that is measured rather than tidy: the same lesson api/sync.js learned
 * about recordings, where 28 payloads were 3213 KB on every load. A procedure is a few kilobytes, but a
 * hundred of them on a page that only shows titles is the same mistake in miniature. What the list needs is
 * enough to choose one - the title, when it changed, which recording it came from, and how long it is. */
async function list(res, sql, userId) {
  const rows = await sql`
    select d.id, d.title, d.flow_ids, d.model, d.effort, d.revision,
           d.created_at, d.updated_at,
           length(d.body) as bytes,
           /* Первая строка после заголовка, чтобы в списке было видно, о чём документ, а не только как он
              назван. Считается здесь, а не в браузере: тянуть тело ради одной строки - это та же трата,
              от которой список и уходит. */
           (regexp_match(d.body, '\\n##\\s+What this process does\\s*\\n+([^\\n]+)'))[1] as opening
    from user_doc d
    where d.user_id = ${userId}::uuid and d.deleted_at is null
    order by d.updated_at desc
    limit ${LIST_MAX}
  `;
  return res.status(200).json({
    ok: true,
    docs: rows.map((row) => ({
      id: row.id,
      title: row.title || '',
      opening: row.opening ? String(row.opening).slice(0, 300) : null,
      flowIds: Array.isArray(row.flow_ids) ? row.flow_ids : [],
      model: row.model || null,
      effort: row.effort || null,
      revision: Number(row.revision) || 1,
      bytes: Number(row.bytes) || 0,
      created: iso(row.created_at),
      updated: iso(row.updated_at),
    })),
    caps: { docs: LIST_MAX, versions: VERSIONS_MAX, bodyBytes: BODY_MAX },
  });
}

/* One document with its history. The revisions carry their bodies, because the one thing somebody does with
 * a version list is read a version - a list that only names them would need a request per click. */
async function one(res, sql, userId, id) {
  const rows = await sql`
    select id, title, body, flow_ids, model, effort, revision, created_at, updated_at
    from user_doc
    where user_id = ${userId}::uuid and id = ${id} and deleted_at is null
    limit 1
  `;
  if (!rows.length) return fail(res, 404, 'no document with that id on this account');

  const versions = await sql`
    select revision, title, body, written_by, at
    from user_doc_version
    where doc_id = ${id}
    order by revision desc
    limit ${VERSIONS_MAX}
  `;
  return res.status(200).json({
    ok: true,
    doc: shape(rows[0]),
    versions: versions.map((v) => ({
      revision: Number(v.revision) || 0,
      title: v.title || '',
      body: v.body || '',
      /* 'model' or 'person'. The distinction is the point of keeping versions at all: a reader following a
       * line needs to know whether it came off a recording or was typed by a colleague. */
      writtenBy: v.written_by === 'model' ? 'model' : 'person',
      at: iso(v.at),
    })),
  });
}

/* Save an edit. Bumps the revision and appends; never overwrites a version.
 *
 * THE TITLE IS TAKEN FROM THE BODY, the same rule the generator follows: two fields for one name is two
 * names, and the one somebody edits is the heading they can see. A body whose heading was deleted keeps the
 * title it had rather than becoming untitled - a row nobody can find is a worse answer than a stale name.
 */
async function save(req, res, sql, userId, id) {
  const body = req.body && typeof req.body === 'object' ? req.body : null;
  if (!body || typeof body.body !== 'string') {
    return fail(res, 400, 'expected a JSON body: { body: "<markdown>" }');
  }
  const text = body.body.slice(0, BODY_MAX);
  const truncated = body.body.length > BODY_MAX;

  const mine = await sql`
    select id, title, revision from user_doc
    where user_id = ${userId}::uuid and id = ${id} and deleted_at is null
    limit 1
  `;
  if (!mine.length) return fail(res, 404, 'no document with that id on this account');

  /* WHAT THE CALLER LAST SAW, when they say. Two tabs open on one document is not exotic - it is what
   * happens when somebody opens the version they want to copy from beside the one they are editing - and
   * without this the second save silently replaces the first. Optional, so an older client keeps working,
   * and refused rather than merged: this route has no idea which half of two edits is the wanted one. */
  const saw = Number(body.revision);
  if (Number.isFinite(saw) && saw !== Number(mine[0].revision)) {
    return fail(res, 409, 'this document was saved somewhere else since you opened it - it is now at '
      + 'revision ' + mine[0].revision + ' and you were editing ' + saw + '. Re-open it and apply your '
      + 'change again; nothing here has been overwritten.');
  }

  const next = Number(mine[0].revision) + 1;
  const title = (titleOf(text) || mine[0].title || '').slice(0, TITLE_MAX);

  await sql`
    update user_doc
    set body = ${text}, title = ${title}, revision = ${next}, updated_at = now()
    where user_id = ${userId}::uuid and id = ${id}
  `;
  await sql`
    insert into user_doc_version (doc_id, revision, title, body, written_by)
    values (${id}, ${next}, ${title}, ${text}, 'person')
    on conflict (doc_id, revision) do nothing
  `;
  return res.status(200).json({
    ok: true,
    id,
    title,
    revision: next,
    /* Said, not silent. A body cut at the ceiling and reported as saved is the one way this route could
     * lose somebody's work without erroring. */
    truncated,
  });
}

/* Put a past revision back. NOT by rewriting history - by writing it forward as a new revision, so the
 * thing that was reverted from is still there to go back to. A revert that erased what it replaced would be
 * the same as not keeping versions. */
async function revert(req, res, sql, userId, id) {
  const body = req.body && typeof req.body === 'object' ? req.body : null;
  const want = Number(body && body.revision);
  if (!Number.isFinite(want) || want < 1) {
    return fail(res, 400, 'expected a JSON body: { revision: <number> }');
  }
  const mine = await sql`
    select revision from user_doc
    where user_id = ${userId}::uuid and id = ${id} and deleted_at is null
    limit 1
  `;
  if (!mine.length) return fail(res, 404, 'no document with that id on this account');

  const past = await sql`
    select title, body from user_doc_version where doc_id = ${id} and revision = ${want} limit 1
  `;
  if (!past.length) return fail(res, 404, 'this document has no revision ' + want + ' kept');

  const next = Number(mine[0].revision) + 1;
  await sql`
    update user_doc
    set body = ${past[0].body}, title = ${past[0].title}, revision = ${next}, updated_at = now()
    where user_id = ${userId}::uuid and id = ${id}
  `;
  await sql`
    insert into user_doc_version (doc_id, revision, title, body, written_by)
    values (${id}, ${next}, ${past[0].title}, ${past[0].body}, 'person')
    on conflict (doc_id, revision) do nothing
  `;
  return res.status(200).json({ ok: true, id, revision: next, restoredFrom: want });
}

/* Soft delete, like gallery_skill.withdrawn_at: a document somebody linked to should not become a broken
 * link, and the versions stay - a delete is not an argument for destroying the history of what was written.
 */
async function remove(res, sql, userId, id) {
  const gone = await sql`
    update user_doc set deleted_at = now(), updated_at = now()
    where user_id = ${userId}::uuid and id = ${id} and deleted_at is null
    returning id
  `;
  if (!gone.length) return fail(res, 404, 'no document with that id on this account');
  return res.status(200).json({ ok: true, id, deleted: true });
}

async function handler(req, res) {
  cors(req, res, 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!process.env.DATABASE_URL) return fail(res, 503, 'This deployment has no database configured.');

  const sql = neon(process.env.DATABASE_URL);
  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (err) {
    await report(err, req, { route: 'docs' });
    return fail(res, 500, 'could not check who is calling: ' + err.message);
  }
  if (!who) return fail(res, 401, 'sign in first');

  const asked = String((req.query && req.query.doc) || '').trim();
  if (asked && !ID.test(asked)) return fail(res, 400, 'that is not a document id');

  try {
    if (req.method === 'GET') return asked ? one(res, sql, who.id, asked) : list(res, sql, who.id);
    if (req.method === 'POST') {
      if (!asked) return fail(res, 400, 'which document? pass ?doc=<id>');
      /* One route, two verbs, told apart by the body rather than by a path: a revert IS a save, of somebody
       * else's earlier text, and splitting them into two endpoints would duplicate the ownership check and
       * the revision bump. */
      return req.body && req.body.revision !== undefined && req.body.body === undefined
        ? revert(req, res, sql, who.id, asked)
        : save(req, res, sql, who.id, asked);
    }
    if (req.method === 'DELETE') {
      if (!asked) return fail(res, 400, 'which document? pass ?doc=<id>');
      return remove(res, sql, who.id, asked);
    }
    return fail(res, 405, 'GET, POST or DELETE');
  } catch (err) {
    await report(err, req, { route: 'docs' });
    return fail(res, 500, 'could not reach the document store: ' + err.message);
  }
}

export default wrap(handler, 'docs');
