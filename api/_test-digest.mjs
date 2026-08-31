/* Дайджест записи: формула, свежесть и то, что читатель берёт её, а не payload.
 *
 * Плюс две проверки, которые к дайджесту не относятся и стоят здесь потому, что именно на нём выяснилось,
 * чего в наборе не было: обратная кавычка внутри SQL-шаблона и синтаксис маршрутов вообще. За одну сессию
 * первый капкан сломал три файла - api/_brain.mjs, api/insights.js и api/_digest.mjs, - и каждый раз это
 * выглядело как «модуль не импортируется», а не как «в комментарии не та кавычка».
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;

const check = (what, ok, detail) => {
  if (ok) { pass++; console.log('  ok   ' + what); return; }
  fail++;
  console.log('  FAIL ' + what + (detail ? '  -> ' + String(detail).slice(0, 200) : ''));
};
const group = (name) => console.log('\n' + name);
const read = (p) => readFileSync(join(here, p), 'utf8').replace(/\r\n/g, '\n');

const digest = read('_digest.mjs');
const insights = read('insights.js');
const migration = readFileSync(join(here, '..', 'db', '014_flow_digest.sql'), 'utf8');
/* Читаются из web/ по той же причине, по которой этот файл читает db/: посчитанное поле, которого никто
 * не показывает, - это не готовая работа, а фикстура, спорящая с собой, учит страницу рисовать состояние,
 * которого не бывает. */
const outside = (...parts) => readFileSync(join(here, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');
const page = outside('web', 'src', 'features', 'insights', 'InsightsView.tsx');
const fixture = outside('web', 'src', 'dev', 'mock-api.ts');

group('одно определение каждого порога');
{
  /* Потолок на паузу у запроса по приложениям и граница «отсутствовал» у разбиения времени - ОДНО число.
   * Две копии позволили бы круговой диаграмме и разбиению времени разойтись в оценке одних и тех же двух
   * минут, и обе выглядели бы авторитетно. */
  check('пороги объявлены в _digest.mjs',
    /export const EVENT_GAP_MAX_MS = 120_000;/.test(digest)
      && /export const ACTIVE_MAX_MS = 5_000;/.test(digest));
  check('и insights.js их импортирует, а не объявляет заново',
    /import \{[\s\S]{0,400}?EVENT_GAP_MAX_MS[\s\S]{0,400}?\} from '\.\/_digest\.mjs';/.test(insights)
      && !/^const EVENT_GAP_MAX_MS/m.test(insights)
      && !/^const ACTIVE_MAX_MS/m.test(insights));
  /* Версия формулы существует и участвует в решении о свежести. Без неё изменить границу можно только
   * миграцией или скриптом, то есть на практике никогда. */
  check('у формулы есть версия, и свежесть считается по ней',
    /export const DIGEST_VERSION = \d+;/.test(digest)
      && /d\.version < \$\{DIGEST_VERSION\}/.test(digest));
}

group('свежесть, и случай, который легко пропустить');
{
  /* ТРЕТИЙ СЛУЧАЙ - главный. Запись можно ОТРЕДАКТИРОВАТЬ: api/transcript.js и remove_steps у ассистента
   * оба перезаписывают payload. Дайджест, посчитанный до правки, описывает запись, которой больше нет, и
   * без сравнения времён дашборд вечно показывал бы удалённые шаги. */
  const staleWhere = digest.slice(digest.indexOf('export async function staleCount'),
    digest.indexOf('export async function topUp'));
  check('устаревшим считается и отсутствующий, и по версии, и СТАРШЕ записи',
    /d\.user_id is null/.test(staleWhere) && /d\.version </.test(staleWhere)
      && /d\.derived_at < f\.updated_at/.test(staleWhere), staleWhere.slice(0, 200));
  /* Те же три условия у пишущего запроса: расхождение значило бы, что считающий и спрашивающий «сколько
   * осталось» не согласны, и счётчик никогда не дошёл бы до нуля. */
  const topUpBody = digest.slice(digest.indexOf('export async function topUp'),
    digest.indexOf('export async function behaviour'));
  check('и у пишущего запроса условие ТО ЖЕ',
    /d\.user_id is null or d\.version < \$\{DIGEST_VERSION\} or d\.derived_at < f\.updated_at/
      .test(topUpBody));
  check('порция ограничена, и предел передаётся, а не зашит',
    /limit \$\{limit\}/.test(topUpBody) && /export const TOP_UP_MAX = \d+;/.test(digest));
  /* Пустая запись. Соединение ОТ `stale`, а не от агрегатов: у записи без событий нет строки ни в одной
   * группировке, и соединение в другую сторону оставило бы её устаревшей навсегда - пересчитываемой на
   * каждом запросе и никогда не удовлетворяющей счётчик. */
  check('запись без событий получает дайджест из нулей, а не пересчитывается вечно',
    /from stale s\s*\n\s*left join timing/.test(topUpBody)
      && /coalesce\(t\.events, 0\)/.test(topUpBody));
  /* Upsert, а не удалить-и-вставить: читатель рядом видит либо старый дайджест, либо новый, но не пустоту. */
  check('и запись обновляется на месте',
    /on conflict \(user_id, client_id\) do update set/.test(topUpBody));
}

group('читатель берёт дайджест, а не payload');
{
  const readerBody = digest.slice(digest.indexOf('export async function behaviour'));
  check('блок поведения читает flow_digest',
    /from flow_digest d/.test(readerBody) && !/payload/.test(readerBody));
  /* Окно применяется к дате ЗАПИСИ, тем же способом, что у всех прочих запросов файла: иначе два запроса
   * разошлись бы в том, какие записи попали в период. */
  check('и окно применяется к дате записи, как везде в insights.js',
    /coalesce\(f\.created_at, f\.updated_at\) >= /.test(readerBody));
  check('а сам дашборд его и вызывает',
    /behaviour\(sql, ids, fromIso, toIso\), behaviour\(sql, ids, prevFromIso, fromIso\)/.test(insights));
  /* Приведение в порядок ПИШЕТ, значит не может ехать в read-only транзакции - и должно идти до чтения,
   * иначе первый запрос на новом аккаунте прочитает пустоту и покажет ноль часов. */
  check('приведение в порядок идёт до транзакции, а не внутри неё',
    insights.indexOf('await topUp(sql, ids, TOP_UP_MAX)') > 0
      && insights.indexOf('await topUp(sql, ids, TOP_UP_MAX)')
         < insights.indexOf('await sql.transaction(asked'));
  /* И отказ дайджеста не роняет страницу: неполный блок хуже полного и лучше отсутствующего дашборда. */
  check('и его отказ не роняет остальную страницу',
    /catch \(e\) \{\s*\n\s*digestProblem =/.test(insights));
  /* Сколько записей ещё не разобрано - ОТДЕЛЬНОЕ поле ответа, а не примечание: «делал 45%» по половине
   * записей выглядит на странице точно так же, как по всем. */
  check('и ответ говорит, сколько записей ещё не разобрано',
    /digest: \{[\s\S]{0,300}?stale,/.test(insights));
}

group('таблица не становится второй копией записи');
{
  /* В дайджесте нет ни события, ни заголовка окна, ни имени элемента - счёты, длительности и одна
   * последовательность имён приложений. Иначе таблица, заведённая ради скорости, стала бы вторым местом,
   * где лежит содержимое чужого экрана, и правила приватности пришлось бы держать в двух местах. */
  for (const forbidden of ['events jsonb', 'payload', 'control', 'title text', 'text_content']) {
    check('в таблице нет ' + forbidden, !new RegExp(forbidden, 'i').test(
      migration.replace(/--[^\n]*/g, '')), forbidden);
  }
  check('но есть версия формулы и время вывода',
    /version\s+integer\s+not null/.test(migration) && /derived_at\s+timestamptz/.test(migration));
  check('и ключ тот же, что у user_flow',
    /primary key \(user_id, client_id\)/.test(migration));
}

group('дашборд показывает то, что посчитал');
{
  /* Поле, которое отдаёт маршрут и не читает страница, - это работа, законченная на девяносто процентов
   * и выглядящая как законченная целиком. Проверяется чтение КАЖДОГО из четырёх, а не наличие раздела:
   * раздел можно оставить, потеряв в нём одно поле, и на экране это будет просто пустое место. */
  for (const field of ['attention', 'actions', 'patterns', 'previousBehaviour', 'digest']) {
    check('страница читает ' + field,
      new RegExp('data(\\?)?\\.' + field + '\\b').test(page)
        || new RegExp('data\\.' + field + '\\?').test(page), field);
  }
  /* Устаревшие записи названы вслух. «Делал 45%» по половине записей выглядит на экране точно так же, как
   * по всем, и это единственное место, где число на дашборде может быть частичной правдой. */
  check('и говорит, сколько записей ещё не разобрано',
    /digest\.stale > 0/.test(page) && /not\n?\s*summarised yet/.test(page));
  check('и отказ дайджеста показывается, а не проглатывается',
    /digest\?\.problem \?/.test(page));
  /* Разница долей - в ПУНКТАХ, и одним словом на всю страницу. Плитка успеха печатает «points»; второе
   * написание той же единицы рядом читается как другая единица. */
  check('разница долей считается в пунктах, а не в процентах',
    /\$\{Math\.abs\(diff\)\} points`/.test(page) && !/\} pts`/.test(page));
  /* Срез живёт в адресе - то же правило, что уже действует для команды. Иначе его нельзя ни переслать,
   * ни вернуть перезагрузкой. */
  check('окно живёт в адресе в обе стороны',
    /const windowFromAddress = /.test(page)
      && /windowFromAddress\(window\.location\.search\)/.test(page)
      && /url\.searchParams\.set\('from', window_\.from\.toISOString\(\)\)/.test(page));
  check('и взаимоисключающие параметры не остаются вдвоём',
    /url\.searchParams\.delete\('days'\)/.test(page)
      && /url\.searchParams\.delete\('from'\)/.test(page));
  /* Столбик графика режется по UTC, потому что по UTC его и посчитали. Местная полночь вернула бы другой
   * набор запусков, чем тот, который столбик показывал. */
  check('провал в день режется по UTC, как и сама ось',
    /T00:00:00\.000Z/.test(page) && /const dayWindow = /.test(page));
}

group('порог описывает тот список, который обрезал');
{
  /* `total` - это ВСЕ узоры, включая одиночные, а `shown` - повторные. Один как знаменатель другого дал бы
   * «показаны 8 из 28 повторных» там, где повторных восемь: число верное, фраза ложная, и по экрану этого
   * не видно. */
  check('знаменатель у узоров - повторные, а не все',
    /total: behaviourNow\.patterns\.repeatedTotal/.test(insights)
      && !/patterns: \{ shown: behaviourNow\.patterns\.repeated\.length, total: behaviourNow\.patterns\.total/
        .test(insights));
  check('и он посчитан до обрезки',
    /const repeatedAll = patternRows\.filter\(\(p\) => p\.recordings > 1\);/.test(insights)
      && /repeated: repeatedAll\.slice\(0, PATTERNS_MAX\)/.test(insights)
      && /repeatedTotal: repeatedAll\.length/.test(insights));
}

group('фикстура не противоречит сама себе');
{
  /* У этого файла своё правило, записанное в нём же: доли складываются в единицу, столбцы дней дают итог.
   * Три новых блока живут по тому же правилу, и проверяется оно арифметикой, а не комментарием. */
  const blockOf = (name) => {
    const i = fixture.indexOf('      ' + name + ': {');
    return i < 0 ? '' : fixture.slice(i, fixture.indexOf('\n      },', i));
  };
  const nums = (body, re) => [...body.matchAll(re)].map((m) => Number(m[1]));

  for (const [what, body] of [['внимание', blockOf('attention')],
    ['прошлое внимание', blockOf('previousBehaviour')]]) {
    const measured = Number((body.match(/measuredSeconds: (\d+)/) || [])[1]);
    const parts = nums(body, /seconds: (\d+), share:/g);
    const shares = nums(body, /share: ([\d.]+) \}/g);
    check(what + ': части складываются в измеренное время',
      parts.length === 3 && parts.reduce((a, b) => a + b, 0) === measured,
      parts.join('+') + ' vs ' + measured);
    check(what + ': доли складываются в единицу',
      shares.length === 3 && Math.abs(shares.reduce((a, b) => a + b, 0) - 1) < 1e-9, shares.join('+'));
  }

  const acts = blockOf('actions');
  const moves = Number((acts.match(/moves: (\d+)/) || [])[1]);
  const total = Number((acts.match(/total: (\d+)/) || [])[1]);
  const kinds = new Map([...acts.matchAll(/kind: '(\w+)', count: (\d+)/g)].map((m) => [m[1], Number(m[2])]));
  const named = new Map([...acts.matchAll(/action: '([^']+)', count: (\d+)/g)].map((m) => [m[1], Number(m[2])]));
  check('действия: движение плюс рода дают итог',
    moves + [...kinds.values()].reduce((a, b) => a + b, 0) === total,
    moves + '+' + [...kinds.values()].reduce((a, b) => a + b, 0) + ' vs ' + total);
  /* Имя не может быть больше своего рода: страница рисует список имён против списка родов, и имя,
   * переросшее род, было бы столбиком длиннее шкалы. */
  check('действия: имена не перерастают свой род',
    named.get('Key Down') + named.get('Key Backspace') === kinds.get('key')
      && named.get('Scroll Down') + named.get('Scroll Up') === kinds.get('scroll')
      && named.get('Left Click Down') + named.get('Left Click Release') === kinds.get('click'));

  const pat = blockOf('patterns');
  const repeatedTotal = Number((pat.match(/repeatedTotal: (\d+)/) || [])[1]);
  const onceSeen = Number((pat.match(/once: (\d+)/) || [])[1]);
  const allSeen = Number((pat.match(/total: (\d+)/) || [])[1]);
  check('узоры: повторные плюс одиночные дают все',
    repeatedTotal + onceSeen === allSeen, repeatedTotal + '+' + onceSeen + ' vs ' + allSeen);
  check('узоры: перечислено ровно столько, сколько повторных',
    [...pat.matchAll(/steps: '/g)].length === repeatedTotal);
  /* Не ноль нарочно - по той же причине, по которой в этом файле есть команда, существующая чтобы её
   * отказали: фикстура, где всё полно, никогда не покажет фразу о неполноте. */
  check('и в фикстуре есть неразобранные записи, иначе эта фраза не рисуется никогда',
    /digest: \{ version: \d+, derived: \d+, stale: [1-9]/.test(fixture));
  /* Окно, о котором спросили, и окно, о котором ответили, - одно окно. Иначе кнопка говорит «Aug 30», а
   * строка под ней «24 авг - 31 авг», и страница спорит сама с собой. */
  check('и фикстура отвечает тем окном, о котором спросили',
    /window: \{ days, from, to, timeZone: 'UTC' \}/.test(fixture)
      && /const ranged = /.test(fixture));
}

/* ------------------------------------------------------------------ капканы, а не дайджест */

group('обратная кавычка внутри SQL-шаблона');
{
  /* ТРИЖДЫ ЗА ОДНУ СЕССИЮ. В этих файлах SQL и промпты пишутся template literal, и первая же обратная
   * кавычка внутри - хоть в комментарии - закрывает строку. Дальше модуль не разбирается, и сообщение
   * говорит про случайное слово («Unexpected identifier union»), а не про кавычку.
   *
   * Проверка простая и потому надёжная: у каждого файла число обратных кавычек должно быть ЧЁТНЫМ, а
   * внутри шаблона, начинающегося с sql`, их быть не должно вовсе. Второе и ловит комментарий. */
  const files = readdirSync(here).filter((f) => /\.(js|mjs)$/.test(f) && !f.startsWith('_test-'));
  let dirty = [];
  for (const file of files) {
    const text = read(file);
    /* Поиск шаблонов запроса: sql` ... ` - и внутри ищется то, чего там быть не может. Кавычка внутри
     * закрыла бы шаблон, поэтому «внутри» здесь означает «до следующей кавычки», и тогда незакрытый
     * комментарий /* без *\/ - это и есть признак. */
    const parts = text.split(/(?:sql|prompt)`/).slice(1);
    for (const part of parts) {
      const body = part.slice(0, part.indexOf('`'));
      const opens = (body.match(/\/\*/g) || []).length;
      const closes = (body.match(/\*\//g) || []).length;
      if (opens !== closes) dirty.push(file);
    }
  }
  dirty = [...new Set(dirty)];
  check('ни в одном шаблоне запроса нет незакрытого комментария', dirty.length === 0, dirty.join(', '));
}

group('каждый маршрут разбирается');
{
  /* Синтаксис, а не выполнение: node --check разбирает файл и ничего не запускает, поэтому проверка
   * безопасна для маршрутов, которым нужны переменные окружения. Именно это и падало трижды. */
  const files = readdirSync(here).filter((f) => /\.(js|mjs)$/.test(f) && !f.startsWith('_test-'));
  const broken = [];
  for (const file of files) {
    try { execFileSync(process.execPath, ['--check', join(here, file)], { stdio: 'pipe' }); }
    catch (e) {
      broken.push(file + ': ' + String((e.stderr || '').toString()).split('\n')
        .find((l) => /Error|Unexpected/.test(l) || '').trim());
    }
  }
  check(files.length + ' файлов в api/ разбираются без ошибок', broken.length === 0, broken.join(' | '));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
