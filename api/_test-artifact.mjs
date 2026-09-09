/* Какие кадры остаются, когда их стало больше потолка, - проверено вычислением.
 *
 * ЗДЕСЬ РОВНО ОДНА ВАЖНАЯ ПРОВЕРКА, и всё остальное вокруг неё: КАДР ПРОВАЛА НЕ ВЫБРАСЫВАЕТСЯ. Ради него
 * таблица и существует - провалившаяся проверка в словах это утверждение об экране, на который больше
 * нельзя посмотреть, - и потолок, выбросивший именно его, оставил бы отчёт с одиннадцатью картинками
 * прошедших проверок и без единой картинки того, что сломалось. Это ровно тот вид тихой потери, который
 * замечают через месяц, поэтому он проверяется исполнением, а не чтением.
 *
 * Run: node api/_test-artifact.mjs
 */
import {
  ARTIFACTS_PER_RUN, ARTIFACT_KEEP_DAYS, ARTIFACT_MAX_BYTES, KINDS,
  artifactId, dropWhich, kindOf, saidOf, tooBig,
} from './_artifact.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

const rows = (spec) => spec.map(([id, kind, step_no]) => ({ id, kind, step_no }));

group('пока места хватает, ничего не выбрасывается');
{
  check('пустой прогон', dropWhich([], 1).length === 0);
  check('и почти полный', dropWhich(rows([['a', 'check', 1]]), 1).length === 0);
  const full = rows(new Array(ARTIFACTS_PER_RUN - 1).fill(0).map((_, i) => ['c' + i, 'check', i]));
  check('ровно до потолка', dropWhich(full, 1).length === 0, String(dropWhich(full, 1).length));
}

group('когда места нет, уходят самые старые ПРОШЕДШИЕ проверки');
{
  const full = rows(new Array(ARTIFACTS_PER_RUN).fill(0).map((_, i) => ['c' + i, 'check', i]));
  const drop = dropWhich(full, 1);
  check('выбрасывается ровно один', drop.length === 1, JSON.stringify(drop));
  check('и это самый ранний шаг', drop[0] === 'c0', drop[0]);
  const dropTwo = dropWhich(full, 3);
  check('добавляем три - уходят три самых ранних',
    dropTwo.length === 3 && dropTwo.join(',') === 'c0,c1,c2', dropTwo.join(','));
}

group('А ПРОВАЛ НЕ ВЫБРАСЫВАЕТСЯ - ради него всё это и существует');
{
  /* Провал на первом шаге - то есть самый «старый» из всех - и одиннадцать прошедших проверок после него. */
  const mixed = rows([
    ['boom', 'failure', 0],
    ...new Array(ARTIFACTS_PER_RUN - 1).fill(0).map((_, i) => ['c' + i, 'check', i + 1]),
  ]);
  const drop = dropWhich(mixed, 1);
  check('уходит проверка, а не провал', !drop.includes('boom'), drop.join(','));
  check('и именно самая ранняя из проверок', drop[0] === 'c0', drop[0]);

  /* И даже когда добавляется столько, что уйти должны почти все. */
  const many = dropWhich(mixed, 10);
  check('десять новых - провал всё равно остаётся', !many.includes('boom'), many.join(','));
  check('а финал уходит только после всех проверок',
    dropWhich(rows([['fin', 'final', 5], ['boom', 'failure', 0],
      ...new Array(ARTIFACTS_PER_RUN - 2).fill(0).map((_, i) => ['c' + i, 'check', i + 1])]), 2)
      .every((id) => id.startsWith('c')));
  /* Порядок выбрасывания сказан константой, а не выведен из кода: его читают, решая, что добавить. */
  check('и порядок назван в модуле, от самого нужного к необязательному',
    KINDS[0] === 'failure' && KINDS[KINDS.length - 1] === 'check', KINDS.join(','));
}

group('незнакомый вид не считается ценнее провала');
{
  const drop = dropWhich(rows([
    ['weird', 'something-new', 0], ['boom', 'failure', 1],
    ...new Array(ARTIFACTS_PER_RUN - 2).fill(0).map((_, i) => ['c' + i, 'check', i + 2]),
  ]), 1);
  /* Неизвестный вид уходит ПЕРВЫМ - раньше даже проверок: то, о чём этот модуль ничего не знает, он не
   * имеет права предпочесть тому, о чём знает. */
  check('он уходит первым', drop[0] === 'weird', drop.join(','));
}

group('вид кадра по тому, что ход доказал');
{
  check('всё сошлось - это проверка', kindOf([{ pass: true }, { pass: true }]) === 'check');
  check('хоть одно не сошлось - провал', kindOf([{ pass: true }, { pass: false }]) === 'failure');
  /* «Не удалось проверить» - НЕ провал; но кадр всё равно сохраняется, потому что именно по нему потом и
   * разбирают, почему прочитать не вышло. */
  check('«не удалось проверить» - не провал', kindOf([{ pass: null }]) === 'check');
  check('и пустой ход - тоже проверка, а не провал', kindOf([]) === 'check' && kindOf(null) === 'check');
}

group('слова к кадру - те же, что читает человек');
{
  const said = saidOf([{ pass: true, evidence: 'a' }, { pass: false, evidence: 'b' }, { pass: null, evidence: 'c' }]);
  check('исход первым словом у каждого', said === 'PASS: a; FAIL: b; CANNOT CHECK: c', said);
  check('и длина ограничена - это колонка, а не журнал',
    saidOf(new Array(200).fill({ pass: true, evidence: 'x'.repeat(50) })).length <= 2000);
}

group('тяжёлый кадр откладывается с причиной, а не режется молча');
{
  check('обычный проходит', tooBig('x'.repeat(1000)) === null);
  const why = tooBig('x'.repeat(ARTIFACT_MAX_BYTES + 1));
  check('слишком тяжёлый - отказ', typeof why === 'string');
  check('и в отказе сказано, сколько и сколько можно', /KB is over the \d+KB/.test(why), why);
  /* САМОЕ ВАЖНОЕ В ЭТОМ ОТКАЗЕ: он говорит, что прогон при этом цел. Иначе человек читает его как поломку. */
  check('и что прогон это не задело', /run and its words are unaffected/.test(why), why);
}

group('потолки названы числами, которые можно сравнить глазами');
{
  check('вес кадра - четверть мегабайта', ARTIFACT_MAX_BYTES === 250_000);
  check('кадров на прогон - двенадцать', ARTIFACTS_PER_RUN === 12);
  check('живут тридцать суток', ARTIFACT_KEEP_DAYS === 30);
  /* Потолок на прогон, умноженный на вес, - это то, что человек прикидывает, глядя на счёт за базу. */
  check('то есть до трёх мегабайт на самый разговорчивый прогон',
    ARTIFACTS_PER_RUN * ARTIFACT_MAX_BYTES === 3_000_000);
}

group('id кадра - свой, и его нельзя спутать с прогоном или расписанием');
{
  check('своя приставка', artifactId().startsWith('art_'));
  check('и два подряд не совпадают', artifactId() !== artifactId());
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
