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
import { accountBlock, systemPrompt, toolsFor } from './chat.js';
import { accountSummary, behaviour, staleCount, topUp } from './_digest.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const readHere = (p) => readFileSync(join(here, p), 'utf8').replace(/\r\n/g, '\n');
const digest = readHere('_digest.mjs');
const insights = readHere('insights.js');

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

/* ------------------------------------------------------- то, что ассистент знает не спрашивая */

group('сводка аккаунта собирается тем же путём, что и дашборд');
{
  /* Три её запроса тоже едут в sql.transaction, значит на них действует то же правило: функция,
   * возвращающая запрос, - не async. Тот же класс ошибки, который снял дашборд, снял бы и это. */
  const sql = fakeNeon();
  let out = null;
  let problem = null;
  try {
    out = await accountSummary(sql, IDS);
  } catch (e) { problem = e && e.message ? e.message : String(e); }
  check('accountSummary проходит на пустом аккаунте', problem === null, problem);
  check('и это одна read-only транзакция',
    sql.seen.transactions === 1 && sql.seen.readOnly[0] === true, JSON.stringify(sql.seen));
  if (out) {
    check('на пустом аккаунте сводка - нули и пустые списки, а не отсутствие полей',
      out.recordings === 0 && Array.isArray(out.recent) && Array.isArray(out.patterns)
        && Array.isArray(out.topActions) && out.attention && out.attention.measuredSeconds === 0,
      JSON.stringify(out));
  }
}

group('блок промпта: то, что модель прочитает');
{
  /* Промпт - это текст, и проверяется он чтением. Фикстура нарочно содержит всё, что может исказиться:
   * шестизначный счёт, запись без дайджеста, узор из одного шага. */
  const summary = {
    recordings: 44,
    events: 421883,
    firstAt: '2026-08-25T09:00:00.000Z',
    lastAt: '2026-08-31T17:00:00.000Z',
    attention: {
      measuredSeconds: 75060, activeSeconds: 34128, waitingSeconds: 18864, awaySeconds: 22068,
      activeUnderMs: 5000, awayOverMs: 120000,
    },
    moves: 361241,
    byKind: [{ kind: 'key', count: 28336 }, { kind: 'scroll', count: 18480 }],
    topActions: [{ action: 'Key Down', count: 23493 }, { action: 'Key Backspace', count: 3631 }],
    patterns: [{ steps: 'chrome -> explorer -> powershell', recordings: 2 }],
    recent: [
      { id: 'r20hqqpqt', name: 'MouseFlow 31/08', source: 'desktop', at: '2026-08-31T16:59:41.000Z',
        summarised: true, events: 81846, activeSeconds: 900, awaySeconds: 120,
        pattern: 'chrome -> explorer', apps: ['chrome', 'explorer'] },
      { id: 'rfresh1', name: 'just now', source: 'desktop', at: '2026-08-31T17:00:00.000Z',
        summarised: false, events: null, activeSeconds: null, awaySeconds: null, pattern: null, apps: [] },
    ],
  };
  const text = accountBlock(summary, 2);

  /* САМАЯ ВАЖНАЯ строка блока. Он не может знать, о каком окне спросят, поэтому «всё время» должно быть
   * сказано до первой цифры - иначе эти итоги будут процитированы в ответе про прошлую неделю, и ничто
   * на экране этого не покажет. */
  check('первым делом сказано, что это ВСЁ ВРЕМЯ и никакое другое окно',
    /ALL TIME/.test(text) && text.indexOf('ALL TIME') < text.indexOf('421,883')
      && /use the tools/.test(text), text.slice(0, 200));
  check('и назван период, который блок покрывает',
    /2026-08-25 to 2026-08-31/.test(text));
  check('шестизначные счёты разделены по разрядам',
    /421,883/.test(text) && /361,241/.test(text) && !/421883/.test(text), text.slice(0, 400));
  check('движение вынесено отдельно от остальных родов',
    /361,241 of the events were the pointer moving/.test(text));
  check('три части времени названы и сказано, что они складываются',
    /doing/.test(text) && /waiting or reading/.test(text) && /away from the machine/.test(text)
      && /add up to the measured time exactly/.test(text));
  check('границы названы числами, а не словами «короткая пауза»',
    /under 5 s/.test(text) && /over 2 min/.test(text));
  /* Идентификаторы - те, что берёт get_transcript, и сказано об этом: идентификатор, чьё применение
   * неочевидно, не применяет никто. */
  check('идентификаторы записей есть, и сказано, каким инструментом их открыть',
    /r20hqqpqt/.test(text) && /get_transcript takes/.test(text));
  /* Не разобранная запись - null, а не ноль: «0 событий» это утверждение о ЗАПИСИ, а не о том, что
   * посчитано. Самая свежая запись - как раз та, о которой скорее всего спросят. */
  check('не разобранная запись названа таковой, а не показана как пустая',
    /rfresh1/.test(text) && /not summarised yet/.test(text) && !/rfresh1.*0 events/.test(text));
  check('и сказано, сколько записей ещё не разобрано',
    /2 recordings are not summarised yet/.test(text));
  check('узор сопровождён оговоркой, что совпадение - не доказательство',
    /not proof they were the same task/.test(text));
  /* Пустой аккаунт не получает блока вовсе: «0 записей, 0 событий» это страница инструкций, тратящая
   * токены на каждом вопросе, чтобы сообщить модели ничего. */
  check('на пустом аккаунте блока нет вообще',
    accountBlock({ recordings: 0 }, 0) === '' && accountBlock(null, 0) === '');
}

group('правило про источники названо, а не обойдено');
{
  /* Правило «только из инструмента» - самое сильное в этом промпте. У модели появился второй источник,
   * и ослабить правило можно ровно одним способом: назвать этот источник и его границу. */
  const withBlock = systemPrompt('2026-08-31', null, null, '\nWHAT IS ON THIS ACCOUNT. ...');
  const without = systemPrompt('2026-08-31', null, null, '');
  check('с блоком правило называет сводку вторым источником',
    /OR from the account summary/.test(withBlock) && /The summary is ALL TIME/.test(withBlock));
  check('и требует инструмента для любого окна',
    /for any question about a window[\s\S]{0,120}look it up/.test(withBlock), withBlock.slice(0, 60));
  check('без блока правило остаётся прежним и строгим',
    /If you did not read it from a tool, you do not know it\./.test(without)
      && !/account summary/.test(without));
  /* Блок идёт ПОСЛЕДНИМ: он длиннее всех правил и является данными, а не инструкцией. Выше правил он
   * вытеснял бы их из внимания модели. */
  check('и блок стоит в конце, после правил',
    withBlock.indexOf('WHAT IS ON THIS ACCOUNT') > withBlock.indexOf('Lead with the answer'));
  /* Командная беседа блока не получает. Её инструменты - белый список ровно для того, чтобы то, что один
   * экран может сложить о чужой работе, решалось в одном месте; второй маршрут к тем же данным не был бы
   * рассмотрен как таковой. */
  const chat = readFileSync(join(here, 'chat.js'), 'utf8');
  /* Не расстоянием в символах - оно разъезжается от первого же дописанного комментария, - а тем, что
   * вызов ОДИН и он под защитой. Второй вызов где-нибудь ещё и был бы тем самым вторым маршрутом. */
  check('в командной области блок не собирается вовсе',
    /if \(!team\) \{/.test(chat)
      && (chat.match(/await accountSummary\(/g) || []).length === 1
      && /if \(!team\) \{[\s\S]*?await accountSummary\(/.test(chat));
  check('и его отказ не отменяет ответа',
    /catch \(_\) \{ account = ''; \}/.test(chat));
}

/* ------------------------------------------------------- инструменты поверх дайджестов */

const TOOL_CTX = (sql) => ({ sql, ids: IDS, userId: IDS[0], team: null });
const toolTable = (sql) => toolsFor({ sql, userId: IDS[0], team: null });

group('инструменты зарегистрированы там, где им положено');
{
  const personal = toolTable(fakeNeon());
  check('в личной области есть оба новых',
    !!personal.summarize_recordings && !!personal.recording_details,
    Object.keys(personal).join(', '));
  /* Командная таблица собирается из белого списка, а не из личной с вычетом: инструмент, которого в
   * таблице нет, нельзя вызвать никаким уточнением схемы. */
  const asTeam = toolsFor({ sql: fakeNeon(), userId: IDS[0], team: { id: 't1', name: 'Ops' } });
  check('в командной есть сводка по записям',
    !!asTeam.summarize_recordings, Object.keys(asTeam).join(', '));
  check('и НЕТ ни одной записи по идентификатору',
    !asTeam.recording_details && !asTeam.get_transcript && !asTeam.list_recordings,
    Object.keys(asTeam).join(', '));
  /* Описание - единственное, по чему модель выбирает инструмент. Два «где ушло время» без сказанного
   * различия - это выбор наугад, а потом ответ, ссылающийся не на то тело доказательств. */
  check('и описание говорит, чем эта сводка отличается от summarize_time',
    /RECORDINGS/.test(personal.summarize_recordings.description)
      && /summarize_time/.test(personal.summarize_recordings.description)
      && /desktop/.test(personal.summarize_recordings.description));
  check('а описание одной записи говорит, когда дешевле оно, а когда нужна расшифровка',
    /get_transcript/.test(personal.recording_details.description)
      && /without reading what is inside/.test(personal.recording_details.description));
}

group('сводка по записям вызывается и складывается');
{
  const sql = fakeNeon();
  let out = null;
  let problem = null;
  try {
    out = await toolTable(sql).summarize_recordings.run({ days: 7, compare: true }, TOOL_CTX(sql));
  } catch (e) { problem = e && e.message ? e.message : String(e); }
  /* Её запросы тоже едут в транзакцию - значит appsByRecording обязан быть обычной функцией. Тот класс
   * ошибки, который снял дашборд, снял бы и этот инструмент. */
  check('summarize_recordings проходит на пустом аккаунте', problem === null, problem);
  check('и это одна транзакция, read-only, с четырьмя запросами при compare',
    sql.seen.transactions === 1 && sql.seen.readOnly[0] === true, JSON.stringify(sql.seen));

  if (out) {
    const d = out.data;
    check('окно названо в результате, а не подразумевается',
      d.window && d.window.days === 7 && !!d.window.from && !!d.window.to);
    check('три части времени есть и на нулях, и доли не NaN',
      d.attention && d.attention.doingPercent === 0 && d.attention.waitingPercent === 0
        && d.attention.awayPercent === 0 && d.measuredSeconds === 0, JSON.stringify(d.attention));
    /* Границы - в РЕЗУЛЬТАТЕ. «Сколько я ждал» бессмысленно, пока не сказано, с какой паузы пауза
     * считается ожиданием, и число без своего определения читается как объективное. */
    check('границы названы числами прямо в результате',
      d.boundaries && d.boundaries.pauseUnderMsCountsAsDoing > 0
        && d.boundaries.pauseOverMsCountsAsAway > d.boundaries.pauseUnderMsCountsAsDoing);
    check('и сказано, что это время ВНУТРИ записей, а не рабочий день',
      /not a working day/.test(String(d.boundaries.note)));
    check('движение отделено от остальных родов',
      Object.prototype.hasOwnProperty.call(d, 'pointerMoves') && Array.isArray(d.byKind));
    /* Пустое предыдущее окно ОТМЕЧЕНО, а не оставлено нулями: ноль без признака нельзя отличить от «не
     * мерили», и модель прочитает его как падение до нуля. */
    check('предыдущее окно есть и говорит, было ли в нём что-то вообще',
      d.previous && d.previous.window && d.previous.hadRecordings === false, JSON.stringify(d.previous));
    check('а без compare предыдущего окна нет вовсе',
      !(await toolTable(fakeNeon()).summarize_recordings.run({ days: 7 }, TOOL_CTX(fakeNeon())))
        .data.previous);
  }
}

group('одна запись: чего нет и что не посчитано - разные ответы');
{
  /* Отсутствие и НЕДОСТУПНОСТЬ отвечаются одинаково нарочно: WHERE фильтрует по владельцу, и разные
   * ответы на «нет такой» и «не ваша» рассказали бы, что чужая запись с таким идентификатором есть. */
  const empty = fakeNeon();
  const missing = await toolTable(empty).recording_details.run({ flowId: 'nope' }, TOOL_CTX(empty));
  check('чужой или несуществующий идентификатор - один и тот же ответ',
    missing.data.found === false && /No recording of this account has that id/.test(missing.data.error),
    JSON.stringify(missing.data));
  check('и без идентификатора инструмент говорит, откуда его взять',
    /list_recordings/.test(
      (await toolTable(empty).recording_details.run({}, TOOL_CTX(empty))).data.error));

  /* НЕ РАЗОБРАННАЯ запись - словами, а не нулями. «0 событий» это утверждение о ЗАПИСИ, а не о том, что
   * посчитано, и самая свежая запись - как раз та, о которой скорее всего спросят. */
  const fresh = fakeNeon({
    rows: (text) => (/from user_flow f/.test(text) && /flow_digest/.test(text)
      ? [{ client_id: 'rfresh', name: 'just now', source: 'desktop', at: '2026-08-31T17:00:00.000Z',
        version: null, events: null, active_ms: null, waiting_ms: null, away_ms: null,
        by_kind: null, top_actions: null, apps: null, pattern: null }]
      : []),
  });
  const notYet = await toolTable(fresh).recording_details.run({ flowId: 'rfresh' }, TOOL_CTX(fresh));
  check('найденная но не разобранная запись говорит это, а не отдаёт нули',
    notYet.data.found === true && notYet.data.summarised === false
      && !Object.prototype.hasOwnProperty.call(notYet.data, 'events')
      && /has not been summarised yet/.test(notYet.data.note), JSON.stringify(notYet.data));
  check('и подсказывает, что расшифровка читается всё равно',
    /get_transcript/.test(notYet.data.note));
}

group('имя приложения не зависит от регистра');
{
  /* «claude 201 мин» и «Claude 37 мин» были двумя приложениями. Регистр - НЕ догадка: это та же строка,
   * и свёртка не может склеить ничего, что не было одним. В отличие от «chrome» против «Google Chrome» -
   * разных строк, для которых нужна таблица, и она оставлена в границах.
   *
   * Проверяются ОБА файла: писатель дайджестов и запрос дашборда. Один без другого значил бы, что
   * ассистент и страница называют одно приложение по-разному. */
  for (const [what, src] of [['писатель дайджестов', digest], ['запрос дашборда', insights]]) {
    check(what + ' приводит имя приложения к нижнему регистру',
      /then left\(lower\(trim\(e\.v->'context'->>'app'\)\), 120\)/.test(src), what);
  }
  /* Формула изменилась - значит версия. Иначе на живом аккаунте остались бы строки, посчитанные по старому
   * правилу, и «claude» с «Claude» жили бы дальше рядом с исправленным кодом.
   *
   * Проверяется НЕ НОМЕР, а история: пин на числе падал бы при каждом законном поднятии, то есть требовал
   * бы правки ради правки и учил бы править его не думая. Здесь можно поднять версию - и нельзя поднять её
   * МОЛЧА: у каждого шага обязана быть строка о том, что изменилось. */
  const version = Number((digest.match(/export const DIGEST_VERSION = (\d+);/) || [])[1]);
  check('версия формулы объявлена числом и больше единицы', version >= 2, String(version));
  const undocumented = [];
  for (let was = 1; was < version; was++) {
    if (!digest.includes(was + ' -> ' + (was + 1) + ':')) undocumented.push(was + ' -> ' + (was + 1));
  }
  check('и у каждого поднятия записано, что изменилось',
    undocumented.length === 0, undocumented.join(', '));
  /* И конкретно то, ради чего версия поднималась в этой сессии - чтобы причина не потерялась при
   * следующем поднятии. */
  check('в истории есть свёртка регистра и вывод формы',
    /application names are case-folded/.test(digest) && /the shape/.test(digest));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
