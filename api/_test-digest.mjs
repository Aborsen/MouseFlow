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
