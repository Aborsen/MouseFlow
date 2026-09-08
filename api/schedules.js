/* Расписания: перечислить, поставить, остановить, забыть.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МАРШРУТ, если те же три действия уже есть тулами в api/mcp.js. Потому что у них разные
 * предъявители: MCP приходит с токеном устройства или OAuth-доступом, а страница - с сессионной кукой, и
 * `whoIsCalling` здесь единственное, что решает, чьи это расписания. Один маршрут на два способа входа
 * означал бы одну проверку прав на два разных доверия.
 *
 * ЧТО ЗДЕСЬ НЕ ПРОИСХОДИТ: ни одного собственного представления о времени. Правило разбирает `readRule`,
 * следующий срок считает `firstAt` - те же функции, что у тулов и у проверки на claim, - потому что
 * расписание, поставленное со страницы, и расписание, поставленное голосом, обязаны означать одно и то же.
 *
 * SCOPING. Каждый запрос фильтрует по id, который вернул whoIsCalling, ВНУТРИ условия. Чужое расписание и
 * несуществующее отвечают одинаковым 404 - тем же способом, которым это делает api/docs.js, и по той же
 * причине: разные ответы подтверждали бы, что такой id существует.
 */
import { neon } from '@neondatabase/serverless';

import { whoIsCalling } from './_session.js';
import { report, wrap } from './_report.js';
import { cors } from './_cors.mjs';
import { firstAt, readRule, ruleOf, ruleSaid, whenSaid } from './_schedule.mjs';

const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'schedule_error', message } });

/* Та же форма id, в которой он выдаётся, - проверяется, а не принимается на слово. Маршрут, подставляющий
 * непроверенный id в запрос, - это форма ошибки, от которой здесь защищает параметризация; но проверка
 * ещё и делает 404 честным: неправильной формы id - это не «нет такого на аккаунте», это не id. */
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/** Всё, что странице нужно показать в строке, включая местное время следующего запуска. */
const row = (one) => {
  const rule = ruleOf(one);
  return {
    id: one.id,
    flowId: one.flow_id,
    label: one.label || '',
    rule: ruleSaid(rule),
    zone: rule.zone,
    nextAt: one.next_at,
    nextSaid: one.paused ? null : whenSaid(one.next_at ? new Date(one.next_at).getTime() : null, rule.zone),
    paused: one.paused,
    pausedWhy: one.paused_why || null,
    lastAt: one.last_at,
    lastSaid: one.last_said || null,
    runs: one.runs,
    misses: one.misses,
    fails: one.fails,
  };
};

/* Колонки выписаны в каждом запросе, а не собраны в константу с `sql.unsafe`. Дословно, потому что
 * `unsafe` в этом проекте не используется НИГДЕ, и вводить непроверенный приём драйвера в три места ради
 * экономии трёх строк - это менять повтор, который видно, на риск, которого не видно. */

async function list(res, sql, userId) {
  const rows = await sql`
    select id, flow_id, tool_name, label, kind, every_minutes, at_minutes, days, zone,
           next_at, paused, paused_why, last_at, last_said, runs, misses, fails
    from user_schedule
    where user_id = ${userId} and deleted_at is null
    order by paused, next_at nulls last
  `;
  return res.status(200).json({ ok: true, schedules: rows.map(row) });
}

async function add(req, res, sql, userId) {
  const body = req.body || {};
  const flowId = String(body.flowId || '').trim();
  if (!ID.test(flowId)) return fail(res, 400, 'which skill? pass flowId');

  const read = readRule(body);
  if (read.why) return fail(res, 400, read.why);
  const rule = read.rule;
  /* Зона у времени суток обязательна, и отказ здесь тот же, что у тула: сервер её знать не может, а «09:00»
   * по UTC - это для того, кто просил девять утра, середина ночи. Страница присылает свою: браузер знает. */
  if (rule.kind === 'daily' && !body.zone) {
    return fail(res, 400, 'a time of day needs a zone - the browser knows its own');
  }

  /* Скилл должен существовать и принадлежать этому человеку. Иначе расписание встанет на паузу при первом
   * же срабатывании, и человек узнает об этом через час вместо того, чтобы узнать сейчас. */
  const flow = await sql`
    select client_id, name from user_flow
    where user_id = ${userId} and client_id = ${flowId} and deleted_at is null limit 1
  `;
  if (!flow.length) return fail(res, 404, 'no skill with that id on this account');

  const at = firstAt(rule, Date.now());
  if (at == null || at < Date.now() - 60_000) {
    return fail(res, 400, 'that time has already passed');
  }

  /* Зона запоминается на аккаунте - единственный способ для облачного прогона узнать, который час у
   * человека (см. startLoop в api/_step.mjs). Настройка, а не колонка: одна строка user_pref, перезаписывается
   * последней присланной. Фон: не записалось - расписание всё равно поставлено. */
  if (body.zone) {
    await sql`
      insert into user_pref (user_id, key, value) values (${userId}, 'zone', ${String(body.zone).slice(0, 64)})
      on conflict (user_id, key) do update set value = excluded.value, updated_at = now()
    `.catch(() => {});
  }

  const id = `sch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await sql`
    insert into user_schedule (
      id, user_id, flow_id, tool_name, args, label,
      kind, every_minutes, at_minutes, days, zone, next_at
    ) values (
      ${id}, ${userId}, ${flowId}, 'mouseflow_run', ${JSON.stringify(body.arguments || {})},
      ${String(body.label || flow[0].name || '').slice(0, 80)},
      ${rule.kind}, ${rule.everyMinutes ?? null}, ${rule.atMinutes ?? null},
      ${rule.days || 'all'}, ${rule.zone}, ${new Date(at).toISOString()}
    )
  `;
  const made = await sql`
    select id, flow_id, tool_name, label, kind, every_minutes, at_minutes, days, zone,
           next_at, paused, paused_why, last_at, last_said, runs, misses, fails
    from user_schedule where id = ${id} and user_id = ${userId}
  `;
  return res.status(200).json({ ok: true, schedule: row(made[0]) });
}

async function pause(req, res, sql, userId, id) {
  const rows = await sql`
    select id, flow_id, tool_name, label, kind, every_minutes, at_minutes, days, zone,
           next_at, paused, paused_why, last_at, last_said, runs, misses, fails
    from user_schedule
    where id = ${id} and user_id = ${userId} and deleted_at is null
  `;
  if (!rows.length) return fail(res, 404, 'no schedule with that id on this account');
  const paused = req.body?.paused !== false;
  const rule = ruleOf(rows[0]);
  /* Снятие с паузы ПЕРЕСЧИТЫВАЕТ срок. Сохранённый за время паузы утёк в прошлое: без пересчёта расписание
   * либо сработает в тот же миг, либо - при большой паузе - отметится пропущенным ровно тогда, когда его
   * возобновили. Ни то, ни другое не является тем, о чём просил человек, нажавший «Resume». */
  const next = paused ? rows[0].next_at : firstAt(rule, Date.now());
  await sql`
    update user_schedule
    set paused = ${paused}, paused_why = ${paused ? 'paused by hand' : null},
        next_at = ${next ? new Date(typeof next === 'number' ? next : next).toISOString() : null},
        updated_at = now()
    where id = ${id} and user_id = ${userId}
  `;
  const after = await sql`
    select id, flow_id, tool_name, label, kind, every_minutes, at_minutes, days, zone,
           next_at, paused, paused_why, last_at, last_said, runs, misses, fails
    from user_schedule where id = ${id} and user_id = ${userId}
  `;
  return res.status(200).json({ ok: true, schedule: row(after[0]) });
}

async function remove(res, sql, userId, id) {
  const gone = await sql`
    update user_schedule set deleted_at = now(), updated_at = now()
    where id = ${id} and user_id = ${userId} and deleted_at is null
    returning id
  `;
  if (!gone.length) return fail(res, 404, 'no schedule with that id on this account');
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
    await report(err, req, { route: 'schedules' });
    return fail(res, 500, 'could not check who is calling: ' + err.message);
  }
  if (!who) return fail(res, 401, 'sign in first');

  const asked = String((req.query && req.query.schedule) || '').trim();
  if (asked && !ID.test(asked)) return fail(res, 400, 'that is not a schedule id');

  try {
    if (req.method === 'GET') return list(res, sql, who.id);
    if (req.method === 'POST') {
      /* Один маршрут, два намерения, различаемые НАЛИЧИЕМ id, а не путём: пауза - это правка
       * существующего, постановка - создание нового, и разделять их на два эндпоинта значило бы дважды
       * написать проверку владения. */
      return asked ? pause(req, res, sql, who.id, asked) : add(req, res, sql, who.id);
    }
    if (req.method === 'DELETE') {
      if (!asked) return fail(res, 400, 'which schedule? pass ?schedule=<id>');
      return remove(res, sql, who.id, asked);
    }
    return fail(res, 405, 'GET, POST or DELETE');
  } catch (err) {
    /* Таблицы может не быть - миграция не применена на этом деплое. Сказать это прямо, а не «500»:
     * страница иначе выглядит сломанной, а сломана только установка. */
    if (/user_schedule/.test(String(err.message))) {
      return fail(res, 503, 'Schedules need db/018_user_schedule.sql applied on this deployment.');
    }
    await report(err, req, { route: 'schedules' });
    return fail(res, 500, err.message);
  }
}

export default wrap(handler, 'schedules');
