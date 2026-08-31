/* Поиск по расшифровкам: что он находит, чего не может найти, и одна ошибка, которая уже случилась.
 *
 * ОНА СТОИТ ОТДЕЛЬНОГО АБЗАЦА, потому что тихо теряла данные. Порция выбиралась ДВАЖДЫ: запрос имён брал
 * `limit N` от устаревших, а следом второй запрос брал ещё `limit N` от того, что осталось устаревшим, и
 * вписывал им ПУСТОЙ индекс. Каждая порция портила столько записей, сколько индексировала: они переставали
 * быть устаревшими с words = '' и больше никогда не пересчитывались.
 *
 * Замерено на живом аккаунте: «снимок экрана» есть в 81 событии трёх записей и не было ни в одной строке
 * индекса; после исправления различных имён стало 2326 против 906, то есть терялось 61%.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PHRASES_PER_FLOW, PHRASES_SHOWN, SEARCH_VERSION, TEXT_TOP_UP_MAX,
  searchRecordings, textStaleCount, textTopUp,
} from './_search.mjs';
import { recordingTools } from './_recording-tools.js';
import { toolsFor } from './chat.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8').replace(/\r\n/g, '\n');
const search = read('_search.mjs');
const tools = read('_recording-tools.js');

let pass = 0;
let fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log('  ok   ' + what); return; }
  fail++;
  console.log('  FAIL ' + what + (detail ? '  -> ' + String(detail).slice(0, 300) : ''));
};
const group = (name) => console.log('\n' + name);

/* ------------------------------------------------------------------ поддельный Neon
 * Договор тот же, что в _test-insights.mjs: тегированный шаблон отдаёт объект, объект thenable. Здесь он
 * ещё и ЗАПОМИНАЕТ каждый запрос, потому что проверяемое - порядок и число обращений. */
const NEON_QUERY = Symbol('neon query');
function fakeNeon({ rows = () => [] } = {}) {
  const seen = [];
  const sql = (strings, ...values) => {
    const text = String(strings.raw ? strings.raw.join('?') : strings);
    seen.push({ text, values });
    return { [NEON_QUERY]: true, text, then(resolve) { return Promise.resolve(rows(text, values)).then(resolve); } };
  };
  sql.transaction = async (arr) => {
    for (const q of arr) {
      if (!q || !q[NEON_QUERY]) throw new Error('transaction() expects an array of queries');
    }
    return arr.map((q) => rows(q.text, []));
  };
  sql.seen = seen;
  return sql;
}

const IDS = ['00000000-0000-0000-0000-000000000001'];

group('порция выбирается ОДИН раз - та самая ошибка');
{
  /* Признак ошибки в исходнике: `limit` не должен встречаться у запроса, который ВСТАВЛЯЕТ. Пока вставка
   * сама выбирала себе строки, она выбирала не те. */
  const insertAt = search.indexOf('insert into flow_text');
  const insertBody = search.slice(insertAt, search.indexOf('`;', insertAt));
  check('вставка не выбирает себе строки сама', !/limit/.test(insertBody), insertBody.slice(0, 200));
  check('и она в файле одна, а не две',
    (search.match(/insert into flow_text/g) || []).length === 1,
    String((search.match(/insert into flow_text/g) || []).length));
  /* И положительный признак: порция называется списком идентификаторов, и имена спрашиваются ПО НЕМУ. */
  check('порция - это список идентификаторов',
    /async function stalePick\(/.test(search)
      && /const clientIds = picked\.map\(\(row\) => row\.client_id\);/.test(search)
      && /namesFor\(sql, clientIds\)/.test(search));
  check('и имена спрашиваются по этому списку, а не заново по устаревшим',
    /where f\.client_id = any\(\$\{clientIds\}::text\[\]\)/.test(search)
      && !/(namesFor[\s\S]{0,900}?)flow_text/.test(search));
  /* КАЖДАЯ выбранная запись получает строку, даже если имён у неё нет: иначе она остаётся устаревшей
   * навсегда - пересчитывается на каждом поиске и никогда не доводит счётчик до нуля. Это та же ловушка,
   * что у дайджеста, но с другой стороны. */
  check('каждая выбранная запись получает строку, даже без имён',
    /for \(const row of picked\) \{\s*\n\s*bags\.set\(/.test(search)
      && /if \(!picked\.length\) return \[\];/.test(search));
}

group('условие устаревания написано дважды и совпадает дословно');
{
  /* Обещано в комментарии этого модуля: neon-тег не умеет составлять фрагменты SQL, поэтому предикат
   * существует в двух местах. Расхождение значит, что считающий «сколько осталось» и выбирающий порцию не
   * согласны, и счётчик никогда не дойдёт до нуля. Дублирование превращается в проверяемое условие. */
  const predicate = /\(x\.user_id is null or x\.version < \$\{SEARCH_VERSION\} or x\.derived_at < f\.updated_at\)/g;
  const found = search.match(predicate) || [];
  check('оба вхождения предиката есть и они дословно одни и те же',
    found.length === 2 && found[0] === found[1], String(found.length));
  /* И оба фильтруют по одному и тому же набору записей: kind = recorded и не удалённые. Предикат
   * совпадающий, а область разная - это то же расхождение другими словами. */
  const wheres = search.match(/where f\.user_id = any\(\$\{ids\}::uuid\[\]\) and f\.deleted_at is null and f\.kind = 'recorded'/g) || [];
  check('и область у обоих одна', wheres.length === 2, String(wheres.length));
}

group('индексируется то, что расшифровка показывает');
{
  /* Имена нормализуются ТЕМИ ЖЕ правилами, что применяет расшифровка, и берутся из того же модуля.
   * Написать их заново в SQL значило бы сделать индекс находимым по тексту, которого никто не видел. */
  check('нормализация берётся из общего модуля, а не пишется заново',
    /import \{ plainName, plainTitle \} from '\.\/_names\.mjs';/.test(search));
  check('и порядок правил тот же, что в ctxOf: сначала имя, потом заголовок',
    /plainTitle\(plainName\(row\.said\)\)/.test(search));
  /* Все пять мест, где имя может стоять. Пропущенное место - это запись, которую не найти по тому, что в
   * ней очевидно было. */
  for (const kind of ['control', 'container', 'window', 'app', 'near', 'page']) {
    check("индексируется '" + kind + "'", new RegExp("\\('" + kind + "'", 'm').test(search), kind);
  }
  /* Оба написания контейнера: агент пишет коротко, разобранный объект - словами. */
  check('контейнер читается под двумя написаниями',
    /containerName', ev\.event->'context'->>'inName'/.test(search));
  /* Только источник страницы, без пути: строка запроса - это место, где оказывается идентификатор. */
  check('от адреса берётся только источник, без пути и запроса',
    /\^\(https\?:\/\/\[\^\/\?#\]\+\)\.\*\$/.test(search));
}

group('чего этот поиск не может, сказано в его собственном ответе');
{
  const table = recordingTools({ sql: fakeNeon(), userId: IDS[0] });
  const tool = table.find((t) => t.name === 'search_recordings');
  check('инструмент есть', !!tool);
  /* САМОЕ ВАЖНОЕ в описании: он не ищет напечатанное, и не потому что отфильтровано, а потому что этого
   * нет. Модель, не знающая этого, ответит «не нашёл» там, где надо ответить «этого не существует». */
  check('описание говорит, что напечатанного не найти НИКАК',
    /CANNOT FIND WHAT ANYBODY TYPED/.test(tool.description)
      && /no sentence written by a person exists in this product/.test(tool.description));
  check('и чем он отличается от search_runs',
    /search_runs/.test(tool.description));
  check('и куда идти дальше за содержимым',
    /get_transcript/.test(tool.description));
  check('текст обязателен по схеме', tool.schema.required.includes('text'));
}

group('инструмент вызывается и отвечает');
{
  const table = recordingTools({ sql: fakeNeon(), userId: IDS[0] });
  const tool = table.find((t) => t.name === 'search_recordings');
  /* Пустая строка совпала бы с каждым индексом, то есть вернула бы «всё» под видом находки. */
  const empty = await tool.run({ text: '   ' }, {});
  check('пустой запрос отказан, и сказано, что нужно',
    /text is required/.test(String(empty.data.error)), JSON.stringify(empty.data));

  const out = await tool.run({ text: 'invoic' }, {});
  check('на пустом аккаунте поиск отвечает нулём, а не падает',
    out.data.found === 0 && Array.isArray(out.data.recordings), JSON.stringify(out.data).slice(0, 160));
  check('и говорит, что искал', out.data.lookedFor === 'invoic');
  /* Не проиндексированное - ОТДЕЛЬНОЕ поле и отдельная фраза: «ничего не найдено» по половине записей
   * выглядит на экране точно так же, как по всем. */
  check('и сколько записей ещё не в индексе',
    Object.prototype.hasOwnProperty.call(out.data, 'notIndexed')
      && /indexed/.test(out.data.note));
  check('и в примечании снова сказано про напечатанное',
    /Nothing anybody typed is stored/.test(out.data.note));
}

group('и он не достаёт чужих записей');
{
  /* Личная область только. Он называет запись по идентификатору - это шаг к её содержимому, а не сводка,
   * и в командной беседе такие инструменты не регистрируются вовсе. */
  const asTeam = toolsFor({ sql: fakeNeon(), userId: IDS[0], team: { id: 't1', name: 'Ops' } });
  check('в командной области инструмента нет', !asTeam.search_recordings,
    Object.keys(asTeam).join(', '));
  const personal = toolsFor({ sql: fakeNeon(), userId: IDS[0], team: null });
  check('а в личной есть', !!personal.search_recordings);
  /* Идентификатор пользователя приходит ОДИН раз, фабрикой, и ни один запрос не берёт его из входа
   * инструмента - то же правило, на котором стоит весь этот файл. */
  check('идентификатор аккаунта не читается из входа инструмента',
    !/input\.(userId|user_id|account)/.test(tools));
  check('и запросы поиска фильтруют по нему',
    /searchRecordings\(sql, \[userId\], needle, limit\)/.test(tools)
      && /textStaleCount\(sql, \[userId\]\)/.test(tools));
}

group('таблица объявлена как держащая текст, в отличие от соседней');
{
  const migration = readFileSync(join(here, '..', 'db', '016_flow_text.sql'), 'utf8');
  /* flow_digest нарочно не держит текста с экрана и об этом сказано в его миграции. Эта - держит, и
   * сказать об этом обязана она сама: правило, до которого нельзя дойти, читая только один файл, - это
   * правило в двух местах. */
  check('миграция говорит, что текст здесь НАРОЧНО',
    /holds text ON PURPOSE/.test(migration) && /flow_digest/.test(migration));
  check('и что напечатанного в ней быть не может',
    /never a word of what was written/.test(migration));
  check('и что нового не становится видно, становится находимо',
    /Nothing new becomes visible/.test(migration));
  check('версия формулы есть, как у дайджеста',
    /version\s+integer\s+not null/.test(migration) && /export const SEARCH_VERSION = \d+;/.test(search));
  check('и ключ тот же, что у user_flow',
    /primary key \(user_id, client_id\)/.test(migration));
  /* Потолок на блоб есть, и сколько имён было ДО него - тоже: обрезанный индекс должен говорить, что он
   * обрезан, а не тихо отвечать «не найдено». */
  check('потолок объявлен, и число имён до потолка хранится',
    /export const PHRASES_PER_FLOW = \d+;/.test(search) && /distinct_n/.test(migration)
      && /distinct_n: all\.length/.test(search.replace(/\s+/g, ' ').replace('${all.length}', 'all.length'))
      || /\$\{all\.length\}/.test(search));
}

group('каждый файл в api/ по-прежнему разбирается');
{
  /* Обратная кавычка внутри sql-шаблона за эту сессию сломала четыре модуля, и _search.mjs был четвёртым.
   * Проверка та же, что в _test-digest.mjs, и стоит здесь потому, что новый файл добавлен именно сюда. */
  const files = readdirSync(here).filter((f) => /\.(js|mjs)$/.test(f) && !f.startsWith('_test-'));
  const dirty = [];
  for (const file of files) {
    const body = read(file);
    const parts = body.split(/(?:sql|prompt)`/).slice(1);
    for (const part of parts) {
      const inner = part.slice(0, part.indexOf('`'));
      if ((inner.match(/\/\*/g) || []).length !== (inner.match(/\*\//g) || []).length) dirty.push(file);
    }
  }
  check(files.length + ' файлов: ни одного незакрытого комментария в шаблоне',
    dirty.length === 0, [...new Set(dirty)].join(', '));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
