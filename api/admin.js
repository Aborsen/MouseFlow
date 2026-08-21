/* The admin's view: every user, what they hold, and the deployment's own settings.
 *
 * This endpoint reads across users, which is a deliberate reversal of the rule every other function in
 * this directory follows - and that is exactly why the gate is the way it is. Who may call this is decided
 * by ADMIN_EMAILS, an environment variable, and nothing else: not a database row, not a preference, not a
 * flag an endpoint could set. A role the database can grant is a role database access can grant itself;
 * the environment can only be changed by whoever already controls the deployment. No variable, no admins,
 * and the endpoint answers 404 to everyone - closed by default, and invisible rather than tantalising.
 *
 * Device tokens are refused outright. A token is a credential for syncing ONE user's own data from a
 * machine; the blast radius of a leaked one must stay that one user, never everyone.
 *
 * Reads come in two depths on purpose. Lists and counts arrive at once; the CONTENT of somebody's work -
 * recorded events, chat text, a run's step log - is its own request with the thing's id in it. The
 * difference is not security theatre: it is the difference between operating a product and reading over
 * everyone's shoulder by default, and it also keeps the hot path fast.
 */

import { neon } from '@neondatabase/serverless';
import { whoIsCalling } from './_session.js';
import { MODELS, PROVIDERS, providerFor } from './_provider.js';

/* ---------------------------------------------------------------- the gate */

function adminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/* ---------------------------------------------------------------- settings

 * The model settings and their meaning. An allow-list rather than a free namespace: a setting nothing
 * reads is a lie waiting to be believed, so the only writable keys are the ones the code actually obeys.
 * Values are validated against the model lists the providers already declare - this endpoint spends other
 * people's money by proxy, and an unbounded model name is an unbounded price. */
export const SETTING_KEYS = {
  'model.desktop': 'The desktop engine: every step of a flow that drives the real mouse (Create → On this computer).',
  'model.plan': 'The plan preview: the outline shown before a desktop flow runs.',
  'model.extension': 'The browser extension engine: flows that act inside a tab.',
  'model.chat_default': 'The assistant when nothing was picked: the dashboard panel and first-time chat.',
};

const ANTHROPIC_ONLY = ['model.desktop', 'model.plan', 'model.extension'];

function validSetting(key, value) {
  if (!(key in SETTING_KEYS)) return 'not a setting this deployment has: ' + key;
  if (ANTHROPIC_ONLY.includes(key)) {
    /* These three run through /api/claude, which is Anthropic-only by design. */
    return MODELS.anthropic.includes(value)
      ? null
      : 'that engine only runs Anthropic models: ' + MODELS.anthropic.join(', ');
  }
  return providerFor(value)
    ? null
    : 'not a model this deployment serves. It has ' +
      PROVIDERS.map((p) => p + ' (' + MODELS[p].join(', ') + ')').join(' and ') + '.';
}

/** What the rest of the code reads. Missing table or missing rows both mean "the defaults" - a deployment
 *  that has never been configured must behave exactly as it did before this table existed. */
export async function readSettings(sql) {
  try {
    const rows = await sql`select key, value from app_setting`;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch (_) {
    return {};
  }
}

/* ---------------------------------------------------------------- views */

async function summary(sql) {
  const [users] = await sql`select count(*)::int as n from neon_auth."user"`;
  const [flows] = await sql`
    select count(*)::int as n,
           count(*) filter (where kind = 'recorded')::int as recordings,
           count(*) filter (where kind = 'created')::int as skills
    from user_flow where deleted_at is null
  `;
  const [runs] = await sql`
    select count(*)::int as n,
           count(*) filter (where coalesce(started_at, synced_at) > now() - interval '7 days')::int as week
    from user_run
  `;
  const [chats] = await sql`select count(*)::int as threads from chat_thread`;
  const [gallery] = await sql`select count(*)::int as n from gallery_skill where withdrawn_at is null`;
  return { users: users.n, flows, runs, chats: chats.threads, published: gallery.n };
}

async function listUsers(sql) {
  /* Driven off neon_auth."user", never off the app tables - a list built from content only shows the users
   * who have some, and the ones who signed up and bounced are exactly the ones worth noticing.
   *
   * to_jsonb(u) because that table belongs to the auth service and its exact columns are not this repo's
   * to assume; whatever is there arrives, and the response builds its own shape from the fields it knows.
   * The left joins each aggregate once per table - the shape api/insights.js already uses. */
  const rows = await sql`
    select to_jsonb(u) as who,
           coalesce(f.recordings, 0)::int as recordings,
           coalesce(f.skills, 0)::int     as skills,
           coalesce(r.runs, 0)::int       as runs,
           coalesce(c.threads, 0)::int    as chats,
           coalesce(g.published, 0)::int  as published,
           coalesce(d.devices, 0)::int    as devices,
           r.last_run
    from neon_auth."user" u
    left join (
      select user_id,
             count(*) filter (where kind = 'recorded') as recordings,
             count(*) filter (where kind = 'created')  as skills
      from user_flow where deleted_at is null group by user_id
    ) f on f.user_id = u.id
    left join (
      select user_id, count(*) as runs, max(coalesce(started_at, synced_at)) as last_run
      from user_run group by user_id
    ) r on r.user_id = u.id
    left join (select user_id, count(*) as threads from chat_thread group by user_id) c on c.user_id = u.id
    left join (
      select author_id, count(*) as published from gallery_skill
      where withdrawn_at is null group by author_id
    ) g on g.author_id = u.id
    left join (
      select user_id, count(*) as devices from device_token
      where revoked_at is null group by user_id
    ) d on d.user_id = u.id
    order by r.last_run desc nulls last
    limit 500
  `;
  return rows.map((r) => ({
    id: r.who.id,
    name: r.who.name ?? null,
    email: r.who.email ?? null,
    image: r.who.image ?? null,
    /* Better Auth's conventional columns, taken when present rather than assumed: the table is the auth
     * service's own and may gain or lose fields without telling this repo. */
    created: r.who.created_at ?? r.who.createdAt ?? null,
    verified: r.who.email_verified ?? r.who.emailVerified ?? null,
    recordings: r.recordings,
    skills: r.skills,
    runs: r.runs,
    chats: r.chats,
    published: r.published,
    devices: r.devices,
    lastRun: r.last_run,
  }));
}

/* One user, metadata only: what they have, named and dated, but never the content itself - that is a
 * separate request per thing, so looking at somebody's work is always a deliberate act with an id in it. */
async function userDetail(sql, id) {
  const [who] = await sql`select to_jsonb(u) as u from neon_auth."user" u where u.id = ${id} limit 1`;
  if (!who) return null;
  const flows = await sql`
    select client_id, kind, source, name, description, created_at, updated_at,
           jsonb_array_length(coalesce(payload->'events', '[]'::jsonb)) as events
    from user_flow where user_id = ${id} and deleted_at is null
    order by updated_at desc limit 200
  `;
  const runs = await sql`
    select client_id, kind, model, outcome, extension, started_at, finished_at,
           left(coalesce(goal, ''), 120) as goal
    from user_run where user_id = ${id}
    order by started_at desc nulls last limit 100
  `;
  const chats = await sql`
    select t.id, t.title, t.created_at, t.updated_at, count(m.n)::int as messages
    from chat_thread t left join chat_message m on m.thread_id = t.id
    where t.user_id = ${id}
    group by t.id order by t.updated_at desc limit 100
  `;
  const devices = await sql`
    select id, label, created_at, last_used_at, revoked_at
    from device_token where user_id = ${id} order by created_at desc limit 20
  `;
  const prefs = await sql`select key, value, updated_at from user_pref where user_id = ${id}`;
  return {
    who: {
      id: who.u.id, name: who.u.name ?? null, email: who.u.email ?? null, image: who.u.image ?? null,
      created: who.u.created_at ?? who.u.createdAt ?? null,
      verified: who.u.email_verified ?? who.u.emailVerified ?? null,
    },
    flows, runs, chats, devices, prefs,
  };
}

/* The content, one thing at a time. `goal` in a run and the text of a chat are the private halves; a
 * recording's payload carries the shape of somebody's real work. Each answer names its owner so the UI can
 * keep saying whose screen it is showing. */
async function flowContent(sql, userId, clientId) {
  const [row] = await sql`
    select name, kind, source, payload, origins, created_at
    from user_flow where user_id = ${userId} and client_id = ${clientId} limit 1
  `;
  return row ?? null;
}

async function runContent(sql, userId, clientId) {
  const [row] = await sql`
    select client_id, kind, goal, model, flow_id, outcome, summary, error, steps, said,
           extension, started_at, finished_at
    from user_run where user_id = ${userId} and client_id = ${clientId} limit 1
  `;
  return row ?? null;
}

async function chatContent(sql, userId, threadId) {
  const rows = await sql`
    select m.n, m.role, m.text, m.created_at
    from chat_message m
    join chat_thread t on t.id = m.thread_id
    where t.id = ${threadId} and t.user_id = ${userId}
    order by m.n asc limit 500
  `;
  return rows;
}

/* ---------------------------------------------------------------- handler */

function fail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');

  const admins = adminEmails();
  /* No list, no admin surface: 404 rather than 403, because an endpoint that answers "forbidden" has
   * already answered "present". */
  if (!admins.length) return fail(res, 404, 'not found');

  const sql = neon(process.env.DATABASE_URL);
  const who = await whoIsCalling(req, sql);
  if (!who || who.via !== 'session') return fail(res, 404, 'not found');
  if (!who.email || !admins.includes(who.email.toLowerCase())) return fail(res, 404, 'not found');

  try {
    if (req.method === 'GET') {
      const view = String((req.query && req.query.view) || 'summary');
      if (view === 'summary') {
        return res.status(200).json({ ok: true, summary: await summary(sql) });
      }
      if (view === 'users') {
        return res.status(200).json({ ok: true, users: await listUsers(sql) });
      }
      if (view === 'user') {
        const id = String(req.query.id || '');
        if (!id) return fail(res, 400, 'which user?');
        const detail = await userDetail(sql, id);
        if (!detail) return fail(res, 404, 'no such user');
        return res.status(200).json({ ok: true, ...detail });
      }
      if (view === 'flow' || view === 'run') {
        const userId = String(req.query.user || '');
        const id = String(req.query.id || '');
        if (!userId || !id) return fail(res, 400, 'which one?');
        const content = view === 'flow'
          ? await flowContent(sql, userId, id)
          : await runContent(sql, userId, id);
        if (!content) return fail(res, 404, 'not found for that user');
        return res.status(200).json({ ok: true, content });
      }
      if (view === 'chat') {
        const userId = String(req.query.user || '');
        const id = String(req.query.id || '');
        if (!userId || !id) return fail(res, 400, 'which thread?');
        return res.status(200).json({ ok: true, messages: await chatContent(sql, userId, id) });
      }
      if (view === 'settings') {
        const current = await readSettings(sql);
        return res.status(200).json({
          ok: true,
          settings: Object.entries(SETTING_KEYS).map(([key, about]) => ({
            key,
            about,
            value: current[key] ?? null,
            /* What the key may be set to, so the UI offers real choices instead of a text box. */
            choices: ANTHROPIC_ONLY.includes(key) ? MODELS.anthropic : PROVIDERS.flatMap((p) => MODELS[p]),
          })),
        });
      }
      return fail(res, 400, 'no such view');
    }

    if (req.method === 'PATCH') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const key = String(body.key || '');
      const value = String(body.value || '');
      /* An empty value clears the row: back to the code's own default, said as an action rather than left
       * as a magic string. */
      if (!(key in SETTING_KEYS)) return fail(res, 400, 'not a setting this deployment has');
      if (value === '') {
        await sql`delete from app_setting where key = ${key}`;
        return res.status(200).json({ ok: true, cleared: key });
      }
      const bad = validSetting(key, value);
      if (bad) return fail(res, 400, bad);
      await sql`
        insert into app_setting (key, value, updated_by) values (${key}, ${value}, ${who.id})
        on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by
      `;
      return res.status(200).json({ ok: true, saved: key });
    }

    return fail(res, 405, 'GET or PATCH');
  } catch (err) {
    return fail(res, 500, 'admin query failed: ' + (err && err.message ? err.message : 'unknown'));
  }
}
