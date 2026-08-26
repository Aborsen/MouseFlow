/* Conversations with the assistant, kept between reloads.
 *
 *   GET    /api/chats                 -> { ok, threads: [{ id, title, messages, updated, created }] }
 *   GET    /api/chats?thread=<id>     -> { ok, thread: { id, title, ... }, messages: [...] }
 *   POST   /api/chats                 { thread, title?, messages: [{ n, role, text, meta? }] }
 *                                     -> { ok, saved }
 *   DELETE /api/chats?thread=<id>     -> { ok, deleted }
 *
 * Nothing here interprets a conversation. It stores what the page rendered and hands it back, which is why
 * `meta` is jsonb and not columns: what a reply was grounded on - the tools that ran, the runs it cited - is
 * the page's shape, it changes when the assistant changes, and a migration per field would be a schema
 * tracking a UI. What this file owns instead is whose it is, how big it may be, and that a delete is a
 * delete.
 *
 * SCOPING. Every statement filters on the id whoIsCalling() returned, inside the WHERE clause. A thread that
 * is not the caller's is a 404 rather than a 403, the same as api/transcript.js and for the same reason: the
 * ids are chosen by the client, so a 403 would turn this into an oracle for guessing them.
 *
 * WHY A DELETE REALLY DELETES. user_flow tombstones because two clients sync it and a delete has to
 * propagate rather than have the flow reappear from whichever machine syncs next. A conversation has no such
 * contract - one client writes it, one person reads it, nothing reconciles it - so `delete` removes the row
 * and chat_message goes with it on cascade. Someone asking for a conversation to be forgotten and getting a
 * flag set instead is the wrong answer to a reasonable request.
 *
 * WHY THE CLIENT OWNS THE IDS. A conversation exists in the page before it has ever been saved: somebody
 * types a question and the reply arrives, and only then is there anything to keep. Handing out ids from here
 * would mean a round-trip before the first message could be attached to anything, and a failed round-trip
 * would mean a conversation that cannot be saved at all. Same reasoning as user_flow.client_id.
 */
import { neon } from '@neondatabase/serverless';
import { whoIsCalling } from './_session.js';
/* Server-side crashes reach Sentry from here. See api/_report.js — no dependency, and it
 * deliberately sends the route and the message, never the query string or the body. */
import { report, wrap } from './_report.js';
/* Один заголовочный набор на все маршруты - см. api/_cors.mjs. Семь копий этих строк разошлись
 * ровно в том месте, где это стоило дороже всего: chats.js отражал ЛЮБОЙ origin и выдавал
 * Allow-Credentials, то есть чужая страница читала разговоры человека его же кукой. */
import { cors } from './_cors.mjs';


const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'chat_store_error', message } });

/* Caps, and every one of them is because this table is written by a client and nothing else bounds it.
 *
 * A conversation is small - a few hundred words a turn - so these are generous enough never to be met by
 * ordinary use and low enough that a loop in the page cannot fill a database. THREADS_MAX is enforced by
 * pruning the oldest rather than by refusing the newest: refusing to save the conversation somebody is
 * having, because of conversations they had months ago, is the wrong one to lose. */
const THREADS_MAX = 200;
const MESSAGES_MAX = 400;
const TEXT_MAX = 20_000;
const TITLE_MAX = 120;
const META_MAX_BYTES = 20_000;
const ID_MAX = 80;

const oneLine = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

/** An id the client chose. Constrained because it goes in a primary key and comes off the wire. */
function idOf(value) {
  const id = String(value == null ? '' : value).trim();
  if (!id || id.length > ID_MAX) return null;
  return /^[A-Za-z0-9_.:-]+$/.test(id) ? id : null;
}

/* What a reply was grounded on, as the page renders it. Stored as sent, size-capped, and only when it is an
 * object: a `meta` that is a string or an array would be a client bug, and keeping it would spread that bug
 * into every read afterwards. */
function metaOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let text;
  try {
    text = JSON.stringify(value);
  } catch (_) {
    return null;   // circular, which cannot have come from a parsed request body but costs nothing to guard
  }
  if (text.length > META_MAX_BYTES) return null;
  return value;
}

function messagesOf(body) {
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const n = Number(item.n);
    if (!Number.isInteger(n) || n < 0 || n > MESSAGES_MAX) continue;
    // Position is the key inside a thread, so a repeat in one request is the client contradicting itself.
    if (seen.has(n)) continue;
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
    if (!role) continue;
    seen.add(n);
    out.push({ n, role, text: String(item.text == null ? '' : item.text).slice(0, TEXT_MAX), meta: metaOf(item.meta) });
  }
  return out.sort((a, b) => a.n - b.n);
}

async function list(res, sql, userId) {
  const rows = await sql`
    select t.id, t.title, t.created_at, t.updated_at,
           (select count(*) from chat_message m where m.thread_id = t.id) as messages
    from chat_thread t
    where t.user_id = ${userId}
    order by t.updated_at desc
    limit ${THREADS_MAX}
  `;
  return res.status(200).json({
    ok: true,
    threads: rows.map((r) => ({
      id: r.id,
      title: r.title || 'Untitled',
      messages: Number(r.messages) || 0,
      created: r.created_at ? new Date(r.created_at).toISOString() : null,
      updated: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    })),
  });
}

async function one(res, sql, userId, threadId) {
  const rows = await sql`
    select id, title, created_at, updated_at
    from chat_thread
    where user_id = ${userId} and id = ${threadId}
  `;
  if (!rows.length) return fail(res, 404, 'no conversation with that id on this account');

  const messages = await sql`
    select n, role, text, meta
    from chat_message
    where user_id = ${userId} and thread_id = ${threadId}
    order by n
    limit ${MESSAGES_MAX}
  `;
  return res.status(200).json({
    ok: true,
    thread: {
      id: rows[0].id,
      title: rows[0].title || 'Untitled',
      created: rows[0].created_at ? new Date(rows[0].created_at).toISOString() : null,
      updated: rows[0].updated_at ? new Date(rows[0].updated_at).toISOString() : null,
    },
    messages: messages.map((m) => ({
      n: Number(m.n),
      role: m.role,
      text: m.text || '',
      meta: m.meta ?? null,
    })),
  });
}

async function save(req, res, sql, userId) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body) return fail(res, 400, 'expected a JSON body: { thread, title, messages: [...] }');

  const threadId = idOf(body.thread);
  if (!threadId) {
    return fail(res, 400, 'thread must be an id of letters, digits, dot, dash, colon or underscore');
  }
  const messages = messagesOf(body);
  if (!messages.length) return fail(res, 400, 'no usable messages in that request, so nothing was saved');

  /* The title is the first question, and it is only set on INSERT.
   *
   * On conflict it is left alone: a conversation's name comes from how it started, and rewriting it from
   * whatever the client happens to send on a later save would rename somebody's history under them. */
  const title = oneLine(body.title || messages.find((m) => m.role === 'user')?.text || '', TITLE_MAX);

  await sql`
    insert into chat_thread (id, user_id, title, updated_at)
    values (${threadId}, ${userId}, ${title}, now())
    on conflict (id) do update set updated_at = now()
    where chat_thread.user_id = ${userId}
  `;

  /* Whose it is, checked rather than assumed. The insert above is a no-op when the id belongs to somebody
   * else - `where chat_thread.user_id = …` on the update path - and without this read that would look like a
   * success while the messages below went nowhere, or worse, into their thread. */
  const mine = await sql`select 1 from chat_thread where id = ${threadId} and user_id = ${userId}`;
  if (!mine.length) return fail(res, 404, 'no conversation with that id on this account');

  for (const m of messages) {
    await sql`
      insert into chat_message (thread_id, n, user_id, role, text, meta)
      values (${threadId}, ${m.n}, ${userId}, ${m.role}, ${m.text}, ${m.meta ? JSON.stringify(m.meta) : null}::jsonb)
      on conflict (thread_id, n) do update
        set role = excluded.role, text = excluded.text, meta = excluded.meta
    `;
  }

  /* Oldest first, over the cap. Pruning rather than refusing: a limit that rejects the conversation somebody
   * is having, because of ones they had months ago, loses the wrong one. */
  await sql`
    delete from chat_thread
    where user_id = ${userId}
      and id not in (
        select id from chat_thread where user_id = ${userId}
        order by updated_at desc limit ${THREADS_MAX}
      )
  `;

  return res.status(200).json({ ok: true, saved: messages.length, thread: threadId });
}

async function remove(res, sql, userId, threadId) {
  // Really deleted - see the note at the top - and the messages go with it on cascade.
  const gone = await sql`
    delete from chat_thread where user_id = ${userId} and id = ${threadId} returning id
  `;
  if (!gone.length) return fail(res, 404, 'no conversation with that id on this account');
  return res.status(200).json({ ok: true, deleted: gone[0].id });
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
    await report(err, req, { route: 'chats' });
    return fail(res, 500, 'could not check who is calling: ' + err.message);
  }
  if (!who) return fail(res, 401, 'sign in first');

  const asked = req.query && req.query.thread ? idOf(req.query.thread) : null;
  if (req.query && req.query.thread && !asked) return fail(res, 400, 'that is not a conversation id');

  try {
    if (req.method === 'GET') return asked ? one(res, sql, who.id, asked) : list(res, sql, who.id);
    if (req.method === 'POST') return save(req, res, sql, who.id);
    if (req.method === 'DELETE') {
      if (!asked) return fail(res, 400, 'which conversation? pass ?thread=<id>');
      return remove(res, sql, who.id, asked);
    }
  } catch (err) {
    /* The message, not a generic failure: this endpoint's errors are almost always a shape the client sent,
     * and "could not save that conversation" with nothing after it is a bug report nobody can act on. */
    await report(err, req, { route: 'chats' });
    return fail(res, 500, 'could not reach the conversation store: ' + err.message);
  }
  return fail(res, 405, 'GET, POST or DELETE');
}

/* The outer net: anything thrown before or around the handler's own try block. */
export default wrap(handler, 'chats');
