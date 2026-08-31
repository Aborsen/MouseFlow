/* Дашборд СОБИРАЕТСЯ, а не только правильно написан.
 *
 * Этот файл существует из-за одной отправленной в production ошибки: `behaviour` была объявлена `async`,
 * поэтому в массив `sql.transaction([...])` попадал Promise вместо объекта запроса, Neon отвергал массив
 * целиком, и КАЖДЫЙ запрос дашборда отвечал 500 - «transaction() expects an array of queries».
 *
 * Почему её не поймало ничто из имевшегося:
 *   - проверки по тексту исходника прошли: там всё написано правильно, ошибка была в типе значения;
 *   - замер прошёл: объект запроса Neon - thenable, поэтому `await behaviour(...)` в отдельном скрипте
 *     разворачивал Promise, натыкался на thenable и исполнял его. 60 мс, верные числа, сломанный маршрут;
 *   - `node --check` прошёл: синтаксис был безупречен.
 *
 * Единственное, что ловит этот класс ошибок, - ИСПОЛНЕНИЕ. Поддельный `sql` ниже соблюдает тот же
 * договор, что настоящий: тегированный шаблон отдаёт объект запроса, а transaction() отказывается от
 * массива, в котором лежит что-то другое, теми же словами. Тот же урок, ради которого из этого же файла
 * когда-то вынесли shapeScope, - и файлу пришлось выучить его дважды.
 */
import { gather, shapeScope } from './insights.js';
import { behaviour, staleCount, topUp } from './_digest.mjs';

let pass = 0;
let fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log('  ok   ' + what); return; }
  fail++;
  console.log('  FAIL ' + what + (detail ? '  -> ' + String(detail).slice(0, 300) : ''));
};
const group = (name) => console.log('\n' + name);

/* ------------------------------------------------------------------ поддельный Neon
 *
 * Договор скопирован с настоящего, а не придуман: тегированный шаблон возвращает ОБЪЕКТ, объект thenable
 * (иначе `await sql\`...\`` в staleCount не работал бы и здесь), а transaction() отвергает массив, в
 * котором лежит не объект запроса, - тем же сообщением, которое видел живой дашборд.
 *
 * Строки отдаются пустыми нарочно: пустой аккаунт - реальный случай (первый день), и сборка обязана его
 * переживать. Заодно это значит, что подделке не нужно знать, какой запрос какой, - иначе тест превратился
 * бы во вторую копию SQL, спорящую с первой. */
const NEON_QUERY = Symbol('neon query');

function fakeNeon({ rows = () => [] } = {}) {
  const seen = { queries: 0, transactions: 0, readOnly: [] };
  const make = (text) => {
    const q = {
      [NEON_QUERY]: true,
      text,
      /* thenable, как у настоящего объекта запроса - и именно эта черта прятала ошибку. */
      then(resolve) { return Promise.resolve(rows(text)).then(resolve); },
    };
    seen.queries += 1;
    return q;
  };
  const sql = (strings, ...values) => make(String(strings.raw ? strings.raw.join('?') : strings));
  sql.transaction = async (arr, opts) => {
    seen.transactions += 1;
    seen.readOnly.push(!!(opts && opts.readOnly));
    /* СЛОВО В СЛОВО то, что ответил живой Neon. Тест, отказывающий по своей формулировке, не доказывает,
     * что отказала бы библиотека. */
    if (!Array.isArray(arr)) {
      throw new Error('transaction() expects an array of queries, or a function returning an array of queries');
    }
    for (const q of arr) {
      if (!q || !q[NEON_QUERY]) {
        throw new Error('transaction() expects an array of queries, or a function returning an array of queries');
      }
    }
    return arr.map((q) => rows(q.text));
  };
  sql.seen = seen;
  return sql;
}

const IDS = ['00000000-0000-0000-0000-000000000001'];
const TO = new Date('2026-08-31T00:00:00.000Z');
const FROM = new Date('2026-08-24T00:00:00.000Z');

group('функция, возвращающая запрос, возвращает ЗАПРОС');
{
  /* Прямая проверка того, что упало. Promise здесь - это 500 на каждом запросе дашборда. */
  const sql = fakeNeon();
  const q = behaviour(sql, IDS, FROM.toISOString(), TO.toISOString());
  check('behaviour отдаёт объект запроса, а не Promise',
    !(q instanceof Promise) && !!q && !!q[NEON_QUERY], Object.prototype.toString.call(q));
  const u = topUp(sql, IDS, 20);
  check('topUp тоже - у двух функций одного назначения одна форма',
    !(u instanceof Promise) && !!u && !!u[NEON_QUERY], Object.prototype.toString.call(u));
  /* И обе при этом остаются ожидаемыми: вызывающая сторона решает, исполнить сразу или сложить в
   * транзакцию, и оба способа обязаны работать. */
  check('и то, что возвращает запрос, можно просто дождаться',
    typeof q.then === 'function' && typeof u.then === 'function');
  /* staleCount ЧИТАЕТ строки, поэтому он async - и это единственное различие, которое здесь осмысленно. */
  check('а staleCount читает строки и потому отдаёт Promise',
    staleCount(fakeNeon(), IDS) instanceof Promise);
}

group('транзакция принимает то, что маршрут в неё кладёт');
{
  const sql = fakeNeon();
  let problem = null;
  try {
    await sql.transaction(
      [sql`select 1`, behaviour(sql, IDS, FROM.toISOString(), TO.toISOString()), topUp(sql, IDS, 20)],
      { readOnly: true },
    );
  } catch (e) { problem = e.message; }
  check('массив с behaviour и topUp проходит', problem === null, problem);

  /* А подделка действительно отказывает - иначе она доказывала бы только собственную снисходительность.
   * Это проверка проверки: ровно та ошибка, что была отправлена, воспроизводится и ловится. */
  const asAsync = async () => behaviour(sql, IDS, FROM.toISOString(), TO.toISOString());
  let refused = null;
  try {
    await sql.transaction([sql`select 1`, await Promise.resolve(asAsync())], { readOnly: true });
  } catch (e) { refused = e.message; }
  check('и Promise в массиве она отвергает теми же словами, что живой Neon',
    /transaction\(\) expects an array of queries/.test(String(refused)), refused);
}

group('сборка ответа доезжает до конца');
{
  /* ВЕСЬ gather, на пустых строках. До этого файла единственным способом его исполнить была живая база,
   * живая сессия и живой запрос - то есть production. */
  const sql = fakeNeon();
  let out = null;
  let problem = null;
  try {
    out = await gather(sql, IDS, FROM.toISOString(), TO.toISOString(), false, IDS);
  } catch (e) { problem = e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e); }
  check('gather проходит на пустом аккаунте, а не падает', problem === null, problem);

  if (out) {
    /* Каждое поле, которое читает страница. Поле, пропавшее из ответа, - это пустое место на дашборде, и
     * до сих пор об этом узнавали, открыв дашборд. */
    for (const field of ['totals', 'byOutcome', 'byDay', 'applications', 'unattributed', 'attention',
      'actions', 'patterns', 'previous', 'previousBehaviour', 'digest', 'repeated', 'slowestSteps',
      'failures', 'skills', 'gaps', 'caps']) {
      check('ответ содержит ' + field, Object.prototype.hasOwnProperty.call(out, field), field);
    }
    /* Три части внимания складываются в измеренное время - на нулях тоже, и без NaN: доля от нуля должна
     * быть нулём, а не «0/0». */
    const a = out.attention;
    check('внимание собрано и складывается само с собой',
      a && a.measuredSeconds === 0
        && [a.active, a.waiting, a.away].every((p) => p && p.seconds === 0 && p.share === 0),
      JSON.stringify(a));
    check('и границы названы в ответе, а не только в коде',
      a && a.activeUnderMs > 0 && a.awayOverMs > a.activeUnderMs);
    check('действия и узоры - пустые, но существуют',
      out.actions && out.actions.total === 0 && Array.isArray(out.actions.byKind)
        && out.patterns && out.patterns.total === 0 && Array.isArray(out.patterns.repeated));
    check('и ответ говорит, чем блоки обеспечены',
      out.digest && typeof out.digest.version === 'number' && typeof out.digest.stale === 'number');
    /* Знаменатель у узоров - повторные, а не все. Проверено исполнением, а не поиском по тексту. */
    check('порог узоров считает повторные, а не все',
      out.caps && out.caps.patterns && out.caps.patterns.total === out.patterns.repeatedTotal,
      JSON.stringify(out.caps && out.caps.patterns));
    /* Ни одного NaN и ни одного undefined в числах: и то и другое уезжает в JSON как null или как "NaN"
     * и рисуется на странице как прочерк, который читатель принимает за «нет данных». */
    const bad = [];
    const walk = (node, path) => {
      if (typeof node === 'number') { if (!Number.isFinite(node)) bad.push(path); return; }
      if (Array.isArray(node)) { node.forEach((v, i) => walk(v, path + '[' + i + ']')); return; }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, path + '.' + k);
      }
    };
    walk(out, '');
    check('и в ответе нет ни одного нечисла', bad.length === 0, bad.join(', '));
  }

  check('и это была ОДНА read-only транзакция',
    sql.seen.transactions === 1 && sql.seen.readOnly[0] === true,
    JSON.stringify(sql.seen.readOnly));
}

group('приведение дайджестов в порядок идёт вне транзакции');
{
  /* Оно ПИШЕТ, поэтому не может ехать в read-only транзакции, и должно идти до чтения - иначе первый
   * запрос на новом аккаунте прочитает пустоту и покажет ноль часов. Порядок проверяется исполнением:
   * подделка запоминает, что было до чего. */
  const order = [];
  const sql = fakeNeon({ rows: (text) => { order.push(/insert into flow_digest/.test(text) ? 'write' : 'read'); return []; } });
  sql.transaction = async (arr) => { order.push('transaction'); return arr.map(() => []); };
  await gather(sql, IDS, FROM.toISOString(), TO.toISOString(), false, IDS);
  const firstTx = order.indexOf('transaction');
  check('запись дайджестов случается до транзакции',
    order.includes('write') && firstTx > order.indexOf('write'), order.join(' -> '));
}

group('и отказ дайджеста не роняет остальную страницу');
{
  /* Неполный блок хуже полного и лучше отсутствующего дашборда. Проверяется тем, что подделка отказывает
   * ровно на дайджестовых запросах, а ответ всё равно собирается и НЕСЁТ ПРИЧИНУ. */
  const sql = fakeNeon({
    rows: (text) => {
      if (/flow_digest/.test(text)) throw new Error('flow_digest is on fire');
      return [];
    },
  });
  let out = null;
  let problem = null;
  try {
    out = await gather(sql, IDS, FROM.toISOString(), TO.toISOString(), false, IDS);
  } catch (e) { problem = e.message; }
  check('страница собирается, несмотря на отказ дайджеста', problem === null, problem);
  check('и причина отказа названа в ответе, а не проглочена',
    out && out.digest && /on fire/.test(String(out.digest.problem)),
    out && JSON.stringify(out.digest));
}

group('и отказ НЕ дайджеста не выдаётся за отказ дайджеста');
{
  /* Самое опасное место новой развязки: повтор без двух запросов мог бы превратить любую поломку в
   * «дайджест не прочитался» и тихо отдать страницу с молчащими разделами вместо честной пятисотки.
   * Поэтому проверяется именно это: отказ у ДРУГОГО запроса уходит наружу, и уходит своими словами. */
  const sql = fakeNeon({
    rows: (text) => {
      if (/from user_run/.test(text)) throw new Error('user_run is the one on fire');
      return [];
    },
  });
  let thrown = null;
  try {
    await gather(sql, IDS, FROM.toISOString(), TO.toISOString(), false, IDS);
  } catch (e) { thrown = e.message; }
  check('поломка в другом запросе доходит наружу, а не превращается в отчёт о дайджесте',
    /user_run is the one on fire/.test(String(thrown)), thrown);
  check('и транзакция была попробована дважды, а не проглочена с первого раза',
    sql.seen.transactions === 2, String(sql.seen.transactions));
}

group('shapeScope - тот же урок, выученный раньше');
{
  /* Он уже стоил одного production 500 по той же причине: код, который нельзя было исполнить без базы,
   * сессии и команды. Здесь он исполняется на обычных аргументах. */
  const said = shapeScope({
    scope: { kind: 'team', team: { id: 't_1', name: 'Ops' }, role: 'owner', members: [{ id: 'u1', role: 'owner' }], person: 'u1' },
    people: new Map([['u1', { name: 'Vic', email: 'v@example.dev' }]]),
    rows: [{ id: 'u1', runs: 3, recordings: 2 }],
    callerId: 'u1',
  });
  check('shapeScope собирает команду и называет выбранного',
    said.kind === 'team' && said.person && said.person.name === 'Vic' && said.people.length === 1
      && said.people[0].role === 'owner' && said.people[0].you === true, JSON.stringify(said));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
