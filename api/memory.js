/* Память приложений, со страницы: перечислить, научить, поправить, забыть. MEMORY-PLAN.md §4.12, §5 шаг 5.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ДВЕРЬ, а не тул в api/mcp.js и не `?memory=1` рядом с `?live=1` там же. Читает и пишет
 * СЕССИОННАЯ КУКА страницы, а не токен устройства или OAuth-доступ MCP - тот же довод, что у schedules.js
 * и cases.js: `whoIsCalling` единственное, что решает, чей это аккаунт, и одна проверка прав на два разных
 * предъявителя - это два мнения о том же вопросе, которые однажды расходятся. `api/mcp.js` и без этого
 * самый большой файл в проекте (roadmap говорит то же самое) - не туда.
 *
 * ЧТО ЗДЕСЬ НЕ ПРОИСХОДИТ: редакция. Она уже написана один раз, в `writeMemory` (api/_memory.mjs, §5 шаг
 * 2), и этот маршрут её не повторяет и не обходит - отказ формы это её отказ, слово в слово.
 *
 * ЧЕГО ЭТА ДВЕРЬ ПОКА НЕ ДЕЛАЕТ. `derived` не отдаёт: он считается на чтении из записей (§5 шаг 3,
 * api/_memory-derive.mjs), а не хранится, и живой запрос к нему с этой страницы - это отдельная проводка,
 * которую §5 шаг 5 не называет и которую эта дверь не изобретает молча. `learned` - только читается
 * (для пустоты сегодня); approve/reject - шаг 6, "или никогда" по самому плану, и здесь не построены.
 */
import { neon } from '@neondatabase/serverless';

import { whoIsCalling } from './_session.js';
import { report, wrap } from './_report.js';
import { cors } from './_cors.mjs';
import { builtinEntries, writeMemory } from './_memory.mjs';

const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'memory_error', message } });

/* Та же форма id, что у schedules.js/cases.js - проверяется, а не принимается на слово, и по той же
 * причине делает 404 честным: неправильная форма - это не «нет такого на аккаунте», это не id. */
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/** Строка для страницы - ровно то, что нужно ledger-карточке (4.12): не сырая строка базы. */
const row = (one) => ({
  id: one.id,
  key: one.key,
  provenance: one.provenance,
  body: one.body,
  version: one.version,
  runId: one.run_id,
  state: one.state,
  createdAt: one.created_at,
  updatedAt: one.updated_at,
});

async function list(res, sql, userId) {
  const rows = await sql`
    select id, key, provenance, body, version, run_id, state, created_at, updated_at
    from app_memory
    where user_id = ${userId} and deleted_at is null
    order by provenance, created_at desc
  `;
  /* builtin - код, не строки: показывается всегда, независимо от того, применена ли миграция вообще
   * (см. НЕ ПРИМЕНЕНА в db/023). Ledger, читающий только базу, не увидел бы эти четыре факта нигде. */
  return res.status(200).json({ ok: true, entries: rows.map(row), builtin: builtinEntries() });
}

/** Научить: создать - или, если пришёл id, поправить свою же taught-запись. Отказ - словами redaction'а. */
async function teach(req, res, sql, userId) {
  const body = req.body || {};
  const askedId = String(body.id || '').trim();

  const written = writeMemory({ key: body.key, provenance: 'taught', body: body.body });
  if (!written.ok) return fail(res, 400, written.why);

  if (askedId) {
    if (!ID.test(askedId)) return fail(res, 400, 'that is not a memory id');
    const updated = await sql`
      update app_memory
      set key = ${written.entry.key}, body = ${written.entry.body}, updated_at = now()
      where id = ${askedId} and user_id = ${userId} and provenance = 'taught' and deleted_at is null
      returning id, key, provenance, body, version, run_id, state, created_at, updated_at
    `;
    /* Не найдено значит либо не своя, либо не taught, либо удалена - три разные вещи снаружи выглядят
     * одинаково, и это правильно: сказать какая из них подтвердило бы, что чужой id существует. */
    if (!updated.length) return fail(res, 404, 'no taught fact with that id on this account');
    return res.status(200).json({ ok: true, entry: row(updated[0]) });
  }

  const id = `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const inserted = await sql`
    insert into app_memory (id, user_id, key, provenance, body, state)
    values (${id}, ${userId}, ${written.entry.key}, 'taught', ${written.entry.body}, 'live')
    returning id, key, provenance, body, version, run_id, state, created_at, updated_at
  `;
  return res.status(201).json({ ok: true, entry: row(inserted[0]) });
}

/** Забыть: soft-delete, и только свою taught-запись - как правка, тем же способом ограниченную. */
async function remove(res, sql, userId, id) {
  const gone = await sql`
    update app_memory set deleted_at = now(), updated_at = now()
    where id = ${id} and user_id = ${userId} and provenance = 'taught' and deleted_at is null
    returning id
  `;
  if (!gone.length) return fail(res, 404, 'no taught fact with that id on this account');
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
    await report(err, req, { route: 'memory' });
    return fail(res, 500, 'could not check who is calling: ' + err.message);
  }
  if (!who) return fail(res, 401, 'sign in first');

  const asked = String((req.query && req.query.memory) || '').trim();
  if (asked && !ID.test(asked)) return fail(res, 400, 'that is not a memory id');

  try {
    if (req.method === 'GET') return list(res, sql, who.id);
    if (req.method === 'POST') return teach(req, res, sql, who.id);
    if (req.method === 'DELETE') {
      if (!asked) return fail(res, 400, 'which fact? pass ?memory=<id>');
      return remove(res, sql, who.id, asked);
    }
    return fail(res, 405, 'GET, POST or DELETE');
  } catch (err) {
    /* Таблицы может не быть - миграция 023 не применена на этом деплое (см. НЕ ПРИМЕНЕНА в её файле).
     * Сказать это прямо, а не «500»: страница иначе выглядит сломанной, а сломана только установка. */
    if (/app_memory/.test(String(err.message))) {
      return fail(res, 503, 'Application memory needs db/023_app_memory.sql applied on this deployment.');
    }
    await report(err, req, { route: 'memory' });
    return fail(res, 500, err.message);
  }
}

export default wrap(handler, 'memory');
