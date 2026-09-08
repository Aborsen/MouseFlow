/* Вердикт по проверке, проверенный исполнением.
 *
 * ПОЧЕМУ ЭТО ОБЯЗАНО БЫТЬ ИСПОЛНЯЕМЫМ НАБОРОМ, а не пинами по исходнику. На `expect` стоит регрессионное
 * тестирование, то есть решение «прошло / не прошло», которое человек НЕ будет перепроверять руками -
 * в этом весь смысл ночного прогона. Значит единственное место, где эта функция может соврать, - разбор
 * ответа агента, и он обязан проверяться так же, как арифметика расписаний: вычислением, на настоящих
 * строках, которые агенты действительно печатают.
 *
 * Строки ниже - ДОСЛОВНО из FindElement (agent/mouseflow-agent.ps1) и его пары в .swift. Если агент когда-то
 * изменит формулировку, упадёт здесь - и это единственное место, где такое изменение можно поймать до того,
 * как ночной прогон начнёт красить зелёным то, что он больше не понимает.
 *
 * Run: node api/_test-expect.mjs
 */
import { CHECKS, checksOf, expectSaid, judge, readFound } from './_expect.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

/* ---------------------------------------------------------------- то, что печатает агент, дословно */

const ONE = 'found button "Send" at 1074,159 240x32, centre 1194,175 - click the centre';
const ONE_VALUE = 'found edit "Subject" at 200,100 400x24 = "Invoice 41" , centre 400,112 - click the centre';
const ONE_EMPTY = 'found edit "Subject" at 200,100 400x24 = "" , centre 400,112 - click the centre';
const ONE_DISABLED = 'found button "Send" at 1074,159 240x32 (disabled), centre 1194,175 - click the centre';
const ONE_SECRET = 'found edit "Password" at 10,10 200x24 = (password, not read), centre 110,22 - click the centre';
const NONE = 'nothing on that window is called "Saved". Read the window to see what it does call things, '
  + 'or look at the screenshot - it may not be there at all';
const SEVERAL = '3 things match "Delete", so the name alone does not say which: button "Delete" at 10,20 '
  + '80x24, centre 50,32; button "Delete all" at 10,60 80x24, centre 50,72; menu item "Delete" at 300,400 '
  + '100x20, centre 350,410. Pick by position, or use a longer name';
const CANNOT = 'could not read that window';

group('ответ агента разбирается в факты, а не в догадки');
{
  const one = readFound(ONE);
  check('одно совпадение: роль, имя и место', one.kind === 'one' && one.role === 'button'
    && one.name === 'Send' && one.at[0] === 1074 && one.at[1] === 159, JSON.stringify(one));
  check('значение поля читается', readFound(ONE_VALUE).value === 'Invoice 41', JSON.stringify(readFound(ONE_VALUE)));
  /* ПУСТОЕ ПОЛЕ И ПОЛЕ БЕЗ ЗНАЧЕНИЯ - РАЗНЫЕ ФАКТЫ. Кнопка не имеет значения вовсе; пустое поле имеет, и
   * оно пустое. Схлопнуть их значит однажды ответить «поле пусто» про кнопку. */
  check('пустое поле - это пустая строка, а не «нет значения»', readFound(ONE_EMPTY).value === '');
  check('а у кнопки значения нет вовсе', readFound(ONE).value === null);
  check('«(disabled)» читается как выключенное', readFound(ONE_DISABLED).enabled === false);
  check('и его отсутствие - как включённое', readFound(ONE).enabled === true);
  check('пароль помечен, а не прочитан', readFound(ONE_SECRET).secret === true);
  check('«такого нет» - это отдельный вид ответа', readFound(NONE).kind === 'none');
  check('несколько совпадений посчитаны', readFound(SEVERAL).kind === 'several' && readFound(SEVERAL).count === 3);
  /* И САМОЕ ВАЖНОЕ РАЗЛИЧИЕ ВО ВСЁМ ФАЙЛЕ. */
  check('«не смог прочитать окно» - это НЕ «такого нет»', readFound(CANNOT).kind === 'cannot');
  check('и пустой ответ - тоже не «такого нет»', readFound('').kind === 'cannot');
}

group('present и absent: есть ли это на окне');
{
  check('есть - прошло, с местом в доказательстве',
    judge({ check: 'present', name: 'Send' }, ONE).pass === true
      && /button "Send" at 1074,159/.test(judge({ check: 'present', name: 'Send' }, ONE).evidence));
  check('нет - не прошло', judge({ check: 'present', name: 'Saved' }, NONE).pass === false);
  /* Несколько - это ЕСТЬ. Неоднозначность важна для следующего шага, а не для вердикта. */
  check('несколько - прошло, и неоднозначность названа',
    judge({ check: 'present', name: 'Delete' }, SEVERAL).pass === true
      && /3 things match/.test(judge({ check: 'present', name: 'Delete' }, SEVERAL).evidence));
  check('absent зеркально: нет - прошло', judge({ check: 'absent', name: 'Saved' }, NONE).pass === true);
  check('absent: есть - не прошло', judge({ check: 'absent', name: 'Send' }, ONE).pass === false);
  /* И ОКНО, КОТОРОЕ НЕ ЧИТАЕТСЯ, НЕ ДОКАЗЫВАЕТ ОТСУТСТВИЯ. Иначе «проверь, что ошибки нет» проходило бы
   * на любом окне, которое агент не смог прочитать, - то есть тест был бы зелёным, ничего не проверив. */
  check('нечитаемое окно НЕ доказывает отсутствия',
    judge({ check: 'absent', name: 'Error' }, CANNOT).pass === null);
  check('и наличия тоже', judge({ check: 'present', name: 'Send' }, CANNOT).pass === null);
  check('ошибка агента - тоже «не проверено», а не «не прошло»',
    judge({ check: 'present', name: 'Send' }, 'the window went away', true).pass === null);
}

group('value_is и value_contains: что лежит в поле');
{
  check('точное совпадение', judge({ check: 'value_is', name: 'Subject', text: 'Invoice 41' }, ONE_VALUE).pass === true);
  check('и пробелы по краям не считаются различием',
    judge({ check: 'value_is', name: 'Subject', text: '  Invoice 41 ' }, ONE_VALUE).pass === true);
  check('другое значение - не прошло, и в доказательстве видно ЧТО там лежит',
    judge({ check: 'value_is', name: 'Subject', text: 'Invoice 42' }, ONE_VALUE).pass === false
      && /holds "Invoice 41"/.test(judge({ check: 'value_is', name: 'Subject', text: 'Invoice 42' }, ONE_VALUE).evidence));
  check('contains - по части, без учёта регистра',
    judge({ check: 'value_contains', name: 'Subject', text: 'invoice' }, ONE_VALUE).pass === true);
  check('и «не содержит» - это не прошло, а не «не проверено»',
    judge({ check: 'value_contains', name: 'Subject', text: 'receipt' }, ONE_VALUE).pass === false);
  check('пустое поле против непустого ожидания - не прошло',
    judge({ check: 'value_is', name: 'Subject', text: 'x' }, ONE_EMPTY).pass === false);
  check('а против пустого - прошло', judge({ check: 'value_is', name: 'Subject', text: '' }, ONE_EMPTY).pass === true);
  /* НЕСКОЛЬКО ОДНОИМЁННЫХ ПОЛЕЙ - «не проверено». Утверждение о поле, выбранном наугад, доказывает не то,
   * о чём просили, и зелёный на нём - это ложное доказательство, а не мелкая неточность. */
  check('несколько одноимённых - не проверено, а не «первое подойдёт»',
    judge({ check: 'value_is', name: 'Delete', text: 'x' }, SEVERAL).pass === null);
  check('у кнопки значения нет - не проверено',
    judge({ check: 'value_is', name: 'Send', text: 'x' }, ONE).pass === null);
  check('пароль не читается нарочно - и это тоже не проверено',
    judge({ check: 'value_is', name: 'Password', text: 'x' }, ONE_SECRET).pass === null
      && /deliberately not read/.test(judge({ check: 'value_is', name: 'Password', text: 'x' }, ONE_SECRET).evidence));
  check('без text проверить нечего', judge({ check: 'value_is', name: 'Subject' }, ONE_VALUE).pass === null);
  check('и отсутствующее поле не доказывает значения',
    judge({ check: 'value_is', name: 'Saved', text: 'x' }, NONE).pass === null);
}

group('enabled и disabled - из той же строки, без нового действия на проводе');
{
  check('включено', judge({ check: 'enabled', name: 'Send' }, ONE).pass === true);
  check('выключено', judge({ check: 'disabled', name: 'Send' }, ONE_DISABLED).pass === true);
  check('и наоборот', judge({ check: 'enabled', name: 'Send' }, ONE_DISABLED).pass === false
    && judge({ check: 'disabled', name: 'Send' }, ONE).pass === false);
  check('чего нет - не проверено', judge({ check: 'enabled', name: 'Saved' }, NONE).pass === null);
}

group('незнакомая проверка отвергается, а не считается пройденной');
{
  const out = judge({ check: 'looks_nice', name: 'Send' }, ONE);
  check('вердикт - «не проверено»', out.pass === null);
  check('и в доказательстве перечислено, что вообще можно проверить',
    CHECKS.every((c) => out.evidence.includes(c)), out.evidence);
}

group('то, что читает модель: исход первым словом');
{
  const said = (want, output) => expectSaid(want, judge(want, output));
  check('PASS первым словом', said({ check: 'present', name: 'Send', why: 'the mail can be sent' }, ONE).startsWith('PASS (tree):'));
  check('FAIL первым словом', said({ check: 'present', name: 'Saved', why: 'it saved' }, NONE).startsWith('FAIL (tree):'));
  check('и «не проверено» названо словами, а не молчанием',
    said({ check: 'present', name: 'Send', why: 'x' }, CANNOT).startsWith('CANNOT CHECK (tree):'));
  check('к FAIL приложено, что делать - иначе модель прекращает прогон',
    /recorded as a failed check/.test(said({ check: 'present', name: 'Saved', why: 'x' }, NONE)));
  check('а к «не проверено» - что это не зачёт',
    /records it as unchecked rather than as a pass/.test(said({ check: 'present', name: 'x', why: 'y' }, CANNOT)));
  check('и то, ЗАЧЕМ проверяли, попадает в строку - её читает человек',
    /checking: the mail can be sent/.test(said({ check: 'present', name: 'Send', why: 'the mail can be sent' }, ONE)));
}

group('сводка прогона: три числа и уровни доказательства');
{
  const steps = [
    { tool: 'click', input: {} },
    { tool: 'expect', input: {}, outcome: { pass: true, how: 'tree', evidence: 'a' } },
    { tool: 'expect', input: {}, outcome: { pass: false, how: 'tree', evidence: 'b' } },
    { tool: 'expect', input: {}, outcome: { pass: null, how: 'tree', evidence: 'c' } },
    { tool: 'expect', input: {}, outcome: { pass: true, how: 'picture', evidence: 'd' } },
    /* Проверка без вердикта - прогон оборвался до ответа. Не считается никак: ни зачётом, ни провалом. */
    { tool: 'expect', input: {} },
  ];
  const sum = checksOf(steps);
  check('прошло, не прошло и не проверено - раздельно',
    sum.passed === 2 && sum.failed === 1 && sum.unchecked === 1, JSON.stringify(sum));
  check('и уровни доказательства посчитаны', sum.tiers.tree === 3 && sum.tiers.picture === 1, JSON.stringify(sum.tiers));
  /* NULL, А НЕ НУЛИ. «Прогон ничего не утверждал» и «прогон утверждал, и всё провалилось» - разные факты, и
   * колонка обязана их различать: иначе всякий обычный прогон читался бы как тест с нулём проверок. */
  check('прогон без проверок - null, а не нули', checksOf([{ tool: 'click', input: {} }]) === null);
  check('и пустой список - тоже null', checksOf([]) === null && checksOf(null) === null);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
