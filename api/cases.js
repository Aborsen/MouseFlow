/* Тест-кейсы: перечислить, записать, поправить, запустить, забыть.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МАРШРУТ, если те же действия есть тулами в api/mcp.js - по той же причине, что у
 * api/schedules.js: у них разные предъявители. MCP приходит с токеном устройства или OAuth-доступом,
 * страница - с сессионной кукой, и `whoIsCalling` здесь единственное, что решает, чьи это кейсы. Один
 * маршрут на два доверия означал бы одну проверку прав на два разных входа.
 *
 * ВЕРДИКТ НЕ ХРАНИТСЯ, А СЧИТАЕТСЯ - одной функцией с тулами и со страницей (api/_case.mjs). Хранимый
 * вердикт при изменённом правиле его чтения - это отчёт, спорящий сам с собой: старые ночи покрашены по
 * старому правилу, новые по новому, и ни на одном экране об этом не сказано.
 *
 * ШАГИ ПРОГОНОВ В ПЕРЕЧЕНЬ НЕ ЕДУТ. Один прогон - это до сотен килобайт шагов; тридцать ночей по десятку
 * кейсов превратили бы список в десятки мегабайт на каждое открытие страницы. Поэтому перечень спрашивает у
 * базы ровно то, что нужно вердикту: исход, сводку проверок и ЧИСЛО починенных шагов. Шаги приезжают только
 * когда открыли один кейс.
 *
 * SCOPING. Каждый запрос фильтрует по id, который вернул whoIsCalling, ВНУТРИ условия. Чужой кейс и
 * несуществующий отвечают одинаковым 404 - тем же способом, что api/schedules.js и api/docs.js, и по той же
 * причине: разные ответы подтверждали бы, что такой id существует.
 */
import { neon } from '@neondatabase/serverless';

import { whoIsCalling } from './_session.js';
import { report, wrap } from './_report.js';
import { cors } from './_cors.mjs';
import { CASE_KEY, caseVerdict, checksFor, lateBound, readExpects } from './_case.mjs';
import { queueOne } from './_queue.mjs';

const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'case_error', message } });

/* Та же форма id, в которой он выдаётся, - проверяется, а не принимается на слово (см. api/schedules.js). */
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/* Сколько последних прогонов держит строка кейса. Десять - это две недели ночных прогонов на экране в одну
 * строку: достаточно, чтобы увидеть «сломалось позавчера», и мало, чтобы строка стала графиком. */
const DOTS = 10;
/* И сколько прогонов отдаётся, когда кейс раскрыли. Шаги здесь уже едут, поэтому число скромнее. */
const RUNS = 20;

/** На чём проверяется этот навык. Одно место на весь маршрут, чтобы ответ не зависел от того, кто спросил. */
const surfaceOf = (flow) => (flow && flow.source && flow.source !== 'desktop' ? 'browser' : 'desktop');

const caseId = () => `cs_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const NAME_MAX = 120;

/** Один кейс в том виде, в котором его читает страница. */
const shape = (row, extra = {}) => ({
  id: row.id,
  name: row.name,
  flowId: row.flow_id,
  arguments: row.args && typeof row.args === 'object' ? row.args : {},
  expects: Array.isArray(row.expects) ? row.expects : [],
  machine: row.machine || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...extra,
});

/** Один прогон кейса - без шагов, если их не просили. */
const runShape = (row, withSteps, expects) => ({
  id: row.client_id,
  caseId: row.case_id,
  outcome: row.outcome,
  summary: row.summary || null,
  error: row.error || null,
  checks: row.checks || null,
  repairs: Number(row.repairs) || 0,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  /* Вердикт считается ЗДЕСЬ и едет готовым: страница рисует то же слово, что тул сказал в чате, потому что
   * оба взяли его у одной функции. */
  verdict: caseVerdict({
    outcome: row.outcome, checks: row.checks, repairs: Number(row.repairs) || 0,
  }),
  ...(withSteps ? { steps: Array.isArray(row.steps) ? row.steps : [], said: Array.isArray(row.said) ? row.said : [] } : {}),
  /* ПРИВЯЗАННЫЕ ПРОВЕРКИ, СДЕЛАННЫЕ ВСЁ РАВНО В КОНЦЕ - только там, где шаги на руках.
   *
   * В перечень кейсов это не едет НАРОЧНО, и по той же причине, по которой там же считается запросом число
   * починенных шагов: шаги весят до сотен килобайт, и тащить их за одним числом в список из тридцати ночей
   * значило бы качать мегабайты на страницу. Выражением в SQL это не выписать - правило сопоставляет шаг с
   * утверждением кейса, - поэтому в списке числа просто нет, и отсутствие здесь значит «не спрашивали», а
   * не «ноль». */
  ...(withSteps ? { late: lateBound(row.steps, expects) } : {}),
});

/* ЧИСЛО ПОЧИНЕННЫХ ШАГОВ считается ЗАПРОСОМ, а не перекачкой шагов в браузер, и выражение выписано в оба
 * запроса дословно. Не константой с `sql.unsafe`: непроверенный приём драйвера в этом проекте не
 * используется НИГДЕ, и вводить его ради экономии одной строки - это менять повтор, который видно, на риск,
 * которого не видно (тот же довод стоит над запросами в api/schedules.js). jsonb_typeof перед разбором -
 * тоже нарочно: шаги пишут три драйвера, и прогон, у которого там окажется не массив, обязан дать ноль, а
 * не 500. */

/**
 * Кейсы этого человека и последние прогоны каждого.
 *
 * Экспортируется, потому что тулы в api/mcp.js спрашивают то же самое: перечень кейсов с последними
 * вердиктами - это один вопрос, и два запроса к нему разошлись бы в том, что считается прогоном кейса.
 */
export async function casesFor(sql, userId) {
  const rows = await sql`
    select id, name, flow_id, args, expects, machine, created_at, updated_at
    from user_case
    where user_id = ${userId} and deleted_at is null
    order by updated_at desc
    limit 200
  `;
  if (!rows.length) return { cases: [], runs: new Map(), names: new Map(), next: new Map() };

  const ids = rows.map((one) => one.id);
  /* Последние DOTS прогонов КАЖДОГО кейса одним запросом. Окно, а не запрос на кейс: тридцать кейсов - это
   * тридцать обращений к базе из одного маршрута, и первый же аккаунт с библиотекой это заметит. */
  const runs = await sql`
    select case_id, client_id, outcome, summary, error, checks, started_at, finished_at, repairs
    from (
      select case_id, client_id, outcome, summary, error, checks, started_at, finished_at,
             case when jsonb_typeof(steps) = 'array'
                  then (select count(*) from jsonb_array_elements(steps) e
                        where coalesce(e->>'repaired', 'false') <> 'false')
                  else 0 end as repairs,
             row_number() over (partition by case_id order by started_at desc nulls last) as n
      from user_run
      where user_id = ${userId} and case_id = any(${ids}) and deleted_at is null
    ) ordered
    where n <= ${DOTS}
    order by started_at desc nulls last
  `;
  const byCase = new Map();
  for (const run of runs) {
    if (!byCase.has(run.case_id)) byCase.set(run.case_id, []);
    byCase.get(run.case_id).push(runShape(run, false));
  }

  /* Имя скилла, который кейс гоняет, и его следующий срок - оба нужны в строке, и оба лежат не здесь. */
  const flows = await sql`
    select client_id, name, kind, source from user_flow
    where user_id = ${userId} and client_id = any(${rows.map((one) => one.flow_id)}) and deleted_at is null
  `;
  const names = new Map(flows.map((one) => [one.client_id, { name: one.name, kind: one.kind, source: one.source }]));

  /* РАСПИСАНИЕ КЕЙСА - это обычное расписание, у которого в аргументах стоит его id. Отдельной таблицы нет
   * нарочно: пауза, снятие с паузы, пропуски и «три провала подряд» уже написаны один раз (api/_schedule.mjs),
   * и вторая их копия для кейсов означала бы два разных представления о том, что такое «каждую ночь». */
  const sched = await sql`
    select id, label, kind, every_minutes, at_minutes, days, zone, next_at, paused, paused_why,
           last_at, last_said, runs, misses, fails, args
    from user_schedule
    where user_id = ${userId} and deleted_at is null
      and args -> ${CASE_KEY}::text ->> 'id' = any(${ids})
      and coalesce(paused_why, '') <> 'it was a one-off, and it has run'
    order by paused, next_at nulls last
  `;
  const next = new Map();
  for (const one of sched) {
    const key = one.args && one.args[CASE_KEY] ? String(one.args[CASE_KEY].id || '') : '';
    if (!key || next.has(key)) continue;
    next.set(key, one);
  }
  return { cases: rows, runs: byCase, names, next };
}

/** Прогоны одного кейса - с шагами: это то, что читают, когда разбираются, почему красное. */
export async function runsForCase(sql, userId, id, limit = RUNS) {
  /* УТВЕРЖДЕНИЯ КЕЙСА СПРАШИВАЮТСЯ ЗДЕСЬ, а не параметром, и это выбор в пользу одного места: правило
   * «проверка сделана не в свой момент» сопоставляет шаг с утверждением, а значит нужны оба - и три
   * вызывающих, каждый со своей копией этого знания, разошлись бы первым же изменением правила. Один
   * лишний дешёвый select против трёх мест, которые обязаны помнить, что его надо сделать. */
  const own = await sql`
    select expects from user_case
    where id = ${id} and user_id = ${userId} and deleted_at is null
    limit 1
  `;
  const expects = own.length && Array.isArray(own[0].expects) ? own[0].expects : [];
  const rows = await sql`
    select case_id, client_id, outcome, summary, error, checks, steps, said, started_at, finished_at,
           case when jsonb_typeof(steps) = 'array'
                then (select count(*) from jsonb_array_elements(steps) e
                      where coalesce(e->>'repaired', 'false') <> 'false')
                else 0 end as repairs
    from user_run
    where user_id = ${userId} and case_id = ${id} and deleted_at is null
    order by started_at desc nulls last
    limit ${Math.max(1, Math.min(50, Math.round(limit)))}
  `;
  return rows.map((row) => runShape(row, true, expects));
}

async function list(res, sql, userId) {
  const { cases, runs, names, next } = await casesFor(sql, userId);
  return res.status(200).json({
    ok: true,
    cases: cases.map((one) => {
      const sch = next.get(one.id) || null;
      const flow = names.get(one.flow_id) || null;
      return shape(one, {
        skill: flow ? flow.name : null,
        /* НА ЧЁМ ЭТО ИДЁТ - и это не подробность устройства, а условие исполнения: десктопный кейс
         * идёт, пока не спит машина с агентом, а веб-кейс - пока открыт Chrome с расширением. Обещать
         * одно вместо другого значит обещать прогон, которого не будет. */
        surface: surfaceOf(flow),
        /* «Скилл удалён» - положительным фактом, а не пустым именем: кейс, чей скилл удалили, ночью
         * упадёт на заборе, и человек обязан узнать это раньше, чем наступит ночь. */
        skillGone: !flow,
        runs: runs.get(one.id) || [],
        schedule: sch
          ? {
            id: sch.id,
            paused: sch.paused,
            pausedWhy: sch.paused_why || null,
            nextAt: sch.next_at,
            lastAt: sch.last_at,
            lastSaid: sch.last_said || null,
            misses: sch.misses,
            fails: sch.fails,
          }
          : null,
      });
    }),
  });
}

async function one(res, sql, userId, id) {
  const rows = await sql`
    select id, name, flow_id, args, expects, machine, created_at, updated_at
    from user_case where id = ${id} and user_id = ${userId} and deleted_at is null
  `;
  if (!rows.length) return fail(res, 404, 'no case with that id on this account');
  const runs = await runsForCase(sql, userId, id);
  return res.status(200).json({ ok: true, case: shape(rows[0], { runs }) });
}

/** Скилл кейса: существует, принадлежит этому человеку, и его вообще можно гонять по цели. */
async function skillFor(sql, userId, flowId) {
  const rows = await sql`
    select client_id, name, kind, source, payload from user_flow
    where user_id = ${userId} and client_id = ${flowId} and deleted_at is null limit 1
  `;
  if (!rows.length) return { why: 'no skill with that id on this account' };
  /* ЗАПИСЬ КЕЙСОМ БЫТЬ НЕ МОЖЕТ, и отказать надо сейчас, а не ночью. Запись воспроизводится агентом без
   * модели: экран никто не читает, expect вызывать некому, и «проверки в конце» выполнить нечем. Облачный
   * драйвер отказывает такой работе теми же словами - здесь это сказано на день раньше. */
  if (rows[0].kind !== 'created') {
    return { why: 'that skill is a recording - it is replayed, not decided, so nothing in it can check '
      + 'anything. Make a skill from it on the Skills page and build the case on that.' };
  }
  return { skill: rows[0] };
}

async function add(req, res, sql, userId) {
  const body = req.body || {};
  const flowId = String(body.flowId || '').trim();
  if (!ID.test(flowId)) return fail(res, 400, 'which skill? pass flowId');
  const name = String(body.name || '').trim().slice(0, NAME_MAX);
  if (!name) return fail(res, 400, 'a case needs a name - it is what a report is read by');

  /* СКИЛЛ СНАЧАЛА, УТВЕРЖДЕНИЯ ПОТОМ, и порядок здесь значит вот что: что можно утверждать, зависит от
   * того, где это будет проверяться. У окна приложения нет адреса, поэтому url_contains на десктопном
   * скилле - не опечатка, а проверка, которую нечем сделать, и сказать это надо при записи. */
  const found = await skillFor(sql, userId, flowId);
  if (found.why) return fail(res, found.why.startsWith('no skill') ? 404 : 400, found.why);

  const read = readExpects(body.expects, checksFor(surfaceOf(found.skill)));
  if (read.why) return fail(res, 400, read.why);

  const id = caseId();
  await sql`
    insert into user_case (id, user_id, name, flow_id, args, expects)
    values (${id}, ${userId}, ${name}, ${flowId},
            ${JSON.stringify(body.arguments || {})}, ${JSON.stringify(read.expects)})
  `;
  const made = await sql`
    select id, name, flow_id, args, expects, machine, created_at, updated_at
    from user_case where id = ${id} and user_id = ${userId}
  `;
  return res.status(200).json({
    ok: true,
    case: shape(made[0], {
      skill: found.skill.name,
      skillGone: false,
      surface: surfaceOf(found.skill),
      runs: [],
      schedule: null,
    }),
  });
}

async function edit(req, res, sql, userId, id) {
  const rows = await sql`
    select id, name, flow_id, args, expects from user_case
    where id = ${id} and user_id = ${userId} and deleted_at is null
  `;
  if (!rows.length) return fail(res, 404, 'no case with that id on this account');
  const body = req.body || {};
  const name = body.name === undefined ? rows[0].name : String(body.name || '').trim().slice(0, NAME_MAX);
  if (!name) return fail(res, 400, 'a case needs a name');
  /* Утверждения правятся целиком или не правятся вовсе: частичная правка списка («поменяй третье») - это
   * способ прислать индекс, которого уже нет, и проверять не то, что показано на экране. */
  let expects = rows[0].expects;
  if (body.expects !== undefined) {
    const on = await skillFor(sql, userId, rows[0].flow_id);
    const read = readExpects(body.expects, checksFor(on.skill ? surfaceOf(on.skill) : 'desktop'));
    if (read.why) return fail(res, 400, read.why);
    expects = read.expects;
  }
  const args = body.arguments === undefined ? rows[0].args : (body.arguments || {});
  await sql`
    update user_case
    set name = ${name}, args = ${JSON.stringify(args)}, expects = ${JSON.stringify(expects)},
        updated_at = now()
    where id = ${id} and user_id = ${userId}
  `;
  const after = await sql`
    select id, name, flow_id, args, expects, machine, created_at, updated_at
    from user_case where id = ${id} and user_id = ${userId}
  `;
  const runs = await runsForCase(sql, userId, id);
  return res.status(200).json({ ok: true, case: shape(after[0], { runs }) });
}

/**
 * Запустить кейс сейчас.
 *
 * ЧЕРЕЗ ТУ ЖЕ ОЧЕРЕДЬ, ЧТО ВСЁ ОСТАЛЬНОЕ, и это главное решение здесь. Кейс мог бы гоняться страницей, как
 * это делает Create, - тогда человек видел бы шаги мгновенно. Но кейс существует ради того, чтобы идти
 * ночью, когда страницы нет; путь, которым он идёт по кнопке, обязан быть тем же, которым он пойдёт в 02:00,
 * иначе кнопка проверяет не то, что случится ночью. Ответ отдаётся сразу - id работы, - а смотреть за ней
 * человек идёт на Activity, где она уже видна как всякая другая.
 */
async function run(res, sql, userId, id) {
  const rows = await sql`
    select id, name, flow_id, expects from user_case
    where id = ${id} and user_id = ${userId} and deleted_at is null
  `;
  if (!rows.length) return fail(res, 404, 'no case with that id on this account');
  if (!Array.isArray(rows[0].expects) || !rows[0].expects.length) {
    return fail(res, 400, 'this case has no checks, so there is nothing it could prove');
  }
  const found = await skillFor(sql, userId, rows[0].flow_id);
  if (found.why) return fail(res, found.why.startsWith('no skill') ? 404 : 400, found.why);

  /* Значения параметров НЕ КОПИРУЮТСЯ в работу: их читает драйвер из строки кейса в момент старта - как и
   * утверждения, и по той же причине. В работе едет только указатель. */
  const put = await queueOne(sql, userId, {
    flowId: rows[0].flow_id,
    /* Имя работы - имя кейса, а не «mouseflow_run»: на Activity человек читает строку «Outlook still
     * sends», а не имя тула, которым её поставили. */
    toolName: `case:${rows[0].name}`.slice(0, 80),
    args: { [CASE_KEY]: { id } },
  });
  if (put.why) return fail(res, 409, put.why);
  /* УСЛОВИЕ ИСПОЛНЕНИЯ - СВОЁ У КАЖДОЙ ПОВЕРХНОСТИ, и оно в ответе, а не в мелком шрифте:
   * веб-кейс ждёт не агента на машине, а открытый Chrome с расширением, и человек, ждущий не того, чего
   * надо, решит, что продукт сломан. */
  const web = surfaceOf(found.skill) === 'browser';
  return res.status(200).json({ ok: true, queued: put.id, said: `Queued "${rows[0].name}". `
    + (web
      ? 'It runs as soon as that Chrome takes it - the extension has to be on, with "Let my AI run skills '
        + 'in this browser" switched on. Watch it on Activity.'
      : 'It runs as soon as that machine takes it - watch it on Activity.') });
}

async function remove(res, sql, userId, id) {
  const gone = await sql`
    update user_case set deleted_at = now(), updated_at = now()
    where id = ${id} and user_id = ${userId} and deleted_at is null
    returning id
  `;
  if (!gone.length) return fail(res, 404, 'no case with that id on this account');
  /* РАСПИСАНИЕ КЕЙСА УХОДИТ ВМЕСТЕ С НИМ. Оставленное, оно каждую ночь ставило бы работу, которая падает на
   * заборе «the case was deleted between the ask and the run» - и человек, удаливший кейс, получал бы от
   * него письма ещё месяц. Прогоны остаются: они - запись о том, что было. */
  await sql`
    update user_schedule set deleted_at = now(), updated_at = now()
    where user_id = ${userId} and deleted_at is null and args -> ${CASE_KEY}::text ->> 'id' = ${id}
  `.catch(() => {});
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
    await report(err, req, { route: 'cases' });
    return fail(res, 500, 'could not check who is calling: ' + err.message);
  }
  if (!who) return fail(res, 401, 'sign in first');

  const asked = String((req.query && req.query.case) || '').trim();
  if (asked && !ID.test(asked)) return fail(res, 400, 'that is not a case id');

  try {
    if (req.method === 'GET') return asked ? one(res, sql, who.id, asked) : list(res, sql, who.id);
    if (req.method === 'POST') {
      if (!asked) return add(req, res, sql, who.id);
      /* Один маршрут, три намерения над одним кейсом, различаемые НАМЕРЕНИЕМ в запросе, а не путём:
       * запустить - это `?run=1`, всё остальное - правка. */
      if (req.query && req.query.run) return run(res, sql, who.id, asked);
      return edit(req, res, sql, who.id, asked);
    }
    if (req.method === 'DELETE') {
      if (!asked) return fail(res, 400, 'which case? pass ?case=<id>');
      return remove(res, sql, who.id, asked);
    }
    return fail(res, 405, 'GET, POST or DELETE');
  } catch (err) {
    /* Таблицы может не быть - миграция не применена на этом деплое. Сказать это прямо, а не «500»:
     * страница иначе выглядит сломанной, а сломана только установка. */
    if (/user_case|case_id/.test(String(err.message))) {
      return fail(res, 503, 'Test cases need db/021_user_case.sql applied on this deployment.');
    }
    await report(err, req, { route: 'cases' });
    return fail(res, 500, err.message);
  }
}

export default wrap(handler, 'cases');
