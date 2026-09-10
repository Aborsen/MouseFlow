/* Вердикт кейса - вычислением, потому что читать его глазами уже нечестно.
 *
 * ЗДЕСЬ ОДНА ВАЖНАЯ ПРОВЕРКА, и остальные вокруг неё: НИ ОДИН ПРОГОН БЕЗ ДОКАЗАТЕЛЬСТВА НЕ ЗЕЛЁНЫЙ. Прогон,
 * который дошёл до finish ok:true и не сделал ни одной проверки, - самый вероятный способ получить ложный
 * зелёный в этом продукте: модель говорит «сделал», кейс говорит «passed», и ночь за ночью отчёт светится,
 * ничего не проверяя. Поэтому таких случаев здесь больше, чем прошедших.
 *
 * И вторая: ПРОВАЛ ПРОВЕРКИ НЕ ПРЯЧЕТСЯ ЗА «агент не довёл». Дефект, найденный в прогоне, который потом
 * сдался, - это дефект, а не потерянная ночь.
 *
 * Run: node api/_test-case.mjs
 */
import {
  CASE_KEY, EXPECTS_MAX, VERDICTS, caseGoal, caseIdOf, caseVerdict, expectLine, lateBound, readExpects,
  repairsOf, stripCase, tallyOf, verdictSaid,
} from './_case.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

const checks = (passed, failed = 0, unchecked = 0) => ({ passed, failed, unchecked, tiers: {} });

group('ПРОГОН БЕЗ ДОКАЗАТЕЛЬСТВА НЕ ЗЕЛЁНЫЙ - ни одним путём');
{
  check('finish ok:true и ни одной проверки - это «вердикта нет», а не «прошло»',
    caseVerdict({ outcome: 'ok', checks: null, steps: [] }) === 'blocked',
    caseVerdict({ outcome: 'ok', checks: null, steps: [] }));
  check('и пустая сводка проверок - тоже',
    caseVerdict({ outcome: 'ok', checks: checks(0), steps: [] }) === 'blocked');
  check('проверка, которую НЕ УДАЛОСЬ сделать, зелёным не считается',
    caseVerdict({ outcome: 'ok', checks: checks(2, 0, 1) }) === 'blocked',
    caseVerdict({ outcome: 'ok', checks: checks(2, 0, 1) }));
  check('всё непроверяемо - тем более',
    caseVerdict({ outcome: 'ok', checks: checks(0, 0, 3) }) === 'blocked');
  check('а вот две сошлись и ничего не осталось - это единственный зелёный',
    caseVerdict({ outcome: 'ok', checks: checks(2) }) === 'pass');
}

group('ПРОВАЛ ПРОВЕРКИ ИДЁТ ПЕРВЫМ - его не заслоняет ничто');
{
  check('прошло и одна не сошлась - это дефект продукта',
    caseVerdict({ outcome: 'ok', checks: checks(3, 1) }) === 'fail');
  check('агент сдался ПОСЛЕ провала - всё равно дефект, а не потерянная ночь',
    caseVerdict({ outcome: 'failed', checks: checks(1, 1) }) === 'fail',
    caseVerdict({ outcome: 'failed', checks: checks(1, 1) }));
  check('человек остановил после провала - тоже дефект',
    caseVerdict({ outcome: 'stopped', checks: checks(0, 1) }) === 'fail');
  check('и починка не отменяет провала',
    caseVerdict({ outcome: 'ok', checks: checks(1, 1), steps: [{ repaired: true }] }) === 'fail');
}

group('а «не довёл» - это blocked, и это не красный');
{
  check('упал без проверок', caseVerdict({ outcome: 'failed', checks: null }) === 'blocked');
  check('остановлен человеком', caseVerdict({ outcome: 'stopped', checks: checks(2) }) === 'blocked');
  check('ещё идёт', caseVerdict({ outcome: 'running', checks: null }) === 'blocked');
  check('и прогон, которого нет вовсе', caseVerdict(null) === 'blocked');
}

group('починенный шаг виден отдельно - место для пункта 4 плана');
{
  check('шаг с пометкой считается',
    repairsOf([{ tool: 'click' }, { tool: 'click', repaired: true }]) === 1);
  check('без пометки - не считается (отсутствие это не «чинили»)',
    repairsOf([{ tool: 'click' }, { tool: 'type' }]) === 0);
  check('мусор вместо шагов ничего не ломает', repairsOf('нет') === 0 && repairsOf(null) === 0);
  check('прошло с починкой - свой вердикт, не pass',
    caseVerdict({ outcome: 'ok', checks: checks(2), steps: [{ repaired: true }] }) === 'pass_with_repairs');
  check('и сегодня так не помечается ни один прогон - вердикт дремлет',
    caseVerdict({ outcome: 'ok', checks: checks(2), steps: [{ tool: 'click' }] }) === 'pass');
  /* Список кейсов не тащит шаги - он спрашивает у базы одно число. Правило обязано быть одним. */
  check('готовое число починок читается вместо шагов',
    caseVerdict({ outcome: 'ok', checks: checks(2), repairs: 1 }) === 'pass_with_repairs');
  check('и ноль починок - это pass, а не «нет данных»',
    caseVerdict({ outcome: 'ok', checks: checks(2), repairs: 0 }) === 'pass');
  check('строка «2» из драйвера базы тоже число',
    caseVerdict({ outcome: 'ok', checks: checks(2), repairs: '2' }) === 'pass_with_repairs');
}

group('четыре вердикта - четыре РАЗНЫХ слова, иначе отчёт нечитаем');
{
  const words = Object.values(VERDICTS).map((v) => v.word);
  check('их четыре', words.length === 4, words.join(', '));
  check('и все различны', new Set(words).size === 4, words.join(', '));
  check('у каждого сказано, что это значит',
    Object.values(VERDICTS).every((v) => v.why && v.why.length > 20));
  check('«blocked» не называется провалом ни одним словом',
    !/fail/i.test(VERDICTS.blocked.word) && !/^the product/i.test(VERDICTS.blocked.why),
    VERDICTS.blocked.word);
  check('а fail говорит про продукт, а не про агента', /check/.test(VERDICTS.fail.word));
  check('вердикт словами склеивается', verdictSaid('fail').startsWith('failed a check - '));
  check('незнакомое имя отвечает собой, а не зелёным', verdictSaid('nonsense') === 'nonsense');
}

group('сводка по прогонам');
{
  const t = tallyOf(['pass', 'pass', 'fail', 'blocked', 'nonsense']);
  check('считает по видам', t.pass === 2 && t.fail === 1 && t.blocked === 1, JSON.stringify(t));
  check('и не выдумывает вид', t.pass_with_repairs === 0);
}

group('утверждения проверяются на входе - одинаково для страницы и для тула');
{
  check('пустой список отвергается словами про ложный зелёный',
    readExpects([]).why.includes('proven nothing'), readExpects([]).why);
  check('больше потолка - отказ называет число',
    readExpects(new Array(EXPECTS_MAX + 1).fill({ check: 'present', name: 'x', why: 'y' }))
      .why.includes(String(EXPECTS_MAX)));
  check('неизвестный вид проверки перечисляет известные',
    readExpects([{ check: 'looks_right', name: 'Save', why: 'x' }]).why.includes('value_contains'));
  check('без имени контрола - отказ',
    readExpects([{ check: 'present', name: ' ', why: 'x' }]).why.includes('which control'));
  check('value_is без значения - отказ, а не утверждение ни о чём',
    readExpects([{ check: 'value_is', name: 'Subject', why: 'x' }]).why.includes('needs `text`'));
  check('без «что это доказывает» - отказ: это единственное, что читают в красном отчёте',
    readExpects([{ check: 'present', name: 'Save', why: '' }]).why.includes('what it proves'));
  const good = readExpects([
    { check: 'present', name: 'Sent Items', why: 'the reply left the outbox', extra: 'ignored' },
    { check: 'value_contains', name: 'Subject', text: 'Re: invoice', process: 'OUTLOOK', why: 'the right one' },
  ]);
  check('годный список принимается', good.why === '' && good.expects.length === 2, good.why);
  check('и в нём остаются только известные поля',
    Object.keys(good.expects[0]).join(',') === 'check,name,why', Object.keys(good.expects[0]).join(','));
  check('а пустой text не превращается в поле',
    good.expects[0].text === undefined && good.expects[1].text === 'Re: invoice');
}

group('цель кейса - цель скилла плюс проверки словами');
{
  const goal = caseGoal('reply to Ann that the invoice is approved', [
    { check: 'present', name: 'Sent Items', why: 'the reply left the outbox' },
    { check: 'value_contains', name: 'Subject', text: 'Re: invoice', why: 'the right thread' },
  ]);
  check('цель осталась целиком', goal.startsWith('reply to Ann that the invoice is approved'));
  check('проверки пронумерованы', goal.includes('1. present "Sent Items"') && goal.includes('2. value_contains "Subject" = "Re: invoice"'));
  check('сказано, чем их делать - тулом, а не глазами',
    /with the expect tool/.test(goal) && /not decide any of them by looking/.test(goal));
  check('и что провал не повод бросить прогон', /does not end the run/.test(goal));
  check('и что пропустить проверку нельзя, даже если и так видно', /do not skip one/.test(goal));
  check('без утверждений цель не меняется вовсе',
    caseGoal('just do it', []) === 'just do it' && caseGoal('just do it', null) === 'just do it');
  check('одно утверждение словами читается как утверждение',
    expectLine({ check: 'absent', name: 'Error', process: 'OUTLOOK', why: 'nothing broke' })
      === 'absent "Error" in OUTLOOK - nothing broke');
  /* У проверки про страницу целиком имени нет: пустые кавычки читаются как забытое поле - в том числе
   * моделью, которой эту строку и выполнять. */
  check('а у проверки про страницу целиком имени нет, и пустых кавычек тоже',
    expectLine({ check: 'url_contains', name: '', text: 'example.com', why: 'the tab went there' })
      === 'url_contains = "example.com" - the tab went there',
    expectLine({ check: 'url_contains', name: '', text: 'example.com', why: 'the tab went there' }));
}

group('служебный ключ не доезжает до скилла');
{
  const args = { who: 'Ann', [CASE_KEY]: { id: 'case_1' }, __other: 1 };
  check('id кейса читается из аргументов', caseIdOf(args) === 'case_1');
  check('а из обычных аргументов - нет', caseIdOf({ who: 'Ann' }) === null);
  check('мусор под ключом не становится id',
    caseIdOf({ [CASE_KEY]: 'case_1' }) === null && caseIdOf({ [CASE_KEY]: { id: '  ' } }) === null);
  const clean = stripCase(args);
  check('скилл получает только свои аргументы',
    Object.keys(clean).join(',') === 'who' && clean.who === 'Ann', Object.keys(clean).join(','));
  check('и ничего не ломается на мусоре', Object.keys(stripCase(null)).length === 0);
}

group('МОМЕНТ ПРОВЕРКИ - 5-v2: часть утверждений проверяется по ходу, а не в конце');
{
  /* ПОЧЕМУ ФРАЗА, А НЕ НОМЕР ЧЕКПОИНТА, написано в _case.mjs: у сохранённого скилла плана нет, а
   * облачный драйвер получает toolsFor(false) - без reached_checkpoint, потому что чекпоинт
   * останавливает прогон, а на том конце никого. Номер указывал бы в пустоту. */
  const bound = { check: 'present', name: 'Sent Items', why: 'the reply left the outbox',
    after: 'the message has been sent' };
  const atEnd = { check: 'value_is', name: 'Subject', text: 'Re: hi', why: 'it kept the subject' };
  const kinds = ['present', 'value_is'];

  const read = readExpects([bound, atEnd], kinds);
  check('момент принимается и сохраняется', read.expects[0].after === 'the message has been sent',
    JSON.stringify(read.expects[0]));
  check('а без момента поля нет вовсе - отсутствие остаётся отсутствием',
    !('after' in read.expects[1]), JSON.stringify(read.expects[1]));
  /* СТАРЫЙ КЕЙС НЕ МЕНЯЕТ ПОВЕДЕНИЯ: v1 писал утверждения без момента, и они по-прежнему в конце. */
  const v1 = caseGoal('Reply to Ann', [atEnd]);
  check('кейс без моментов не упоминает их ни словом',
    !/MOMENT|when:/.test(v1) && /When the goal above is done/.test(v1), v1.slice(0, 120));

  const goal = caseGoal('Reply to Ann', read.expects);
  check('в цели две группы, и обе названы',
    /belong to a MOMENT/.test(goal) && /And these belong to the end/.test(goal));
  check('момент напечатан рядом со своим утверждением',
    /1[.] present "Sent Items".*\[when: the message has been sent\]/.test(goal),
    (goal.match(/^1[.].*$/m) || [])[0]);
  /* НУМЕРАЦИЯ СКВОЗНАЯ. «Проверка 2» в отчёте обязана значить вторую В КЕЙСЕ, а не вторую в группе -
   * иначе красная строка отчёта указывает не на то утверждение, которое не сошлось. */
  check('нумерация сквозная по кейсу, а не по группе',
    /^2[.] value_is "Subject"/m.test(goal), (goal.match(/^2[.].*$/m) || [])[0]);
  /* И МОДЕЛИ СКАЗАНО, ЧТО ОТЛОЖИТЬ ИХ НА КОНЕЦ - ДРУГОЙ ТЕСТ. Без этой фразы `after` был бы намёком. */
  check('и сказано, почему нельзя отложить на конец',
    /leaving them all to the end is a different test/.test(goal));

  /* ВСЕ УТВЕРЖДЕНИЯ ПРИВЯЗАНЫ - тогда группы конца нет, и фраза про конец не печатается. */
  const allBound = caseGoal('Reply to Ann', readExpects([bound], kinds).expects);
  check('кейс целиком из привязанных не выдумывает группу конца',
    /belong to a MOMENT/.test(allBound) && !/belong to the end/.test(allBound));
}

group('И ПРИВЯЗКА НЕ СЛОВО БЕЗ ПОСЛЕДСТВИЙ: проверка, сделанная всё равно в конце, посчитана');
{
  /* Сделать все проверки в конце - другой тест, чем сделать их по ходу: «Sent Items» пуста до отправки
   * и после неё же и проверяется. Признак: за проверкой «на месте» следует хоть одно ДЕЙСТВИЕ. */
  const expects = [
    { check: 'present', name: 'Sent Items', why: 'x', after: 'the message has been sent' },
    { check: 'value_is', name: 'Subject', text: 'Re: hi', why: 'y' },
  ];
  const step = (name, input = {}) => ({ name, input });
  const sent = { check: 'present', name: 'Sent Items' };
  const subj = { check: 'value_is', name: 'Subject', text: 'Re: hi' };

  check('за привязанной проверкой было действие - она на месте',
    lateBound([step('click'), step('expect', sent), step('click'), step('expect', subj),
      step('finish')], expects) === 0);
  check('а если после неё только проверки и finish - она в конце',
    lateBound([step('click'), step('expect', sent), step('expect', subj), step('finish')],
      expects) === 1);
  /* finish ДЕЙСТВИЕМ НЕ СЧИТАЕТСЯ: прогон, кончившийся проверкой и finish, сделал её в конце. */
  check('finish не спасает проверку от «в конце»',
    lateBound([step('click'), step('expect', sent), step('finish')], expects) === 1);
  /* НЕПРИВЯЗАННЫЕ НЕ СЧИТАЮТСЯ НИКОГДА: их место - конец, это и есть их правило. */
  check('проверка без момента в счёт не идёт',
    lateBound([step('expect', subj), step('finish')], [expects[1]]) === 0);
  check('и кейс без моментов не считается вовсе',
    lateBound([step('expect', subj), step('finish')], []) === 0);
  check('мусор на входе отвечает нулём, а не падает',
    lateBound(null, expects) === 0 && lateBound([], null) === 0);

  /* И ВЕРДИКТ ЭТИМ НЕ МЕНЯЕТСЯ. Одна запоздавшая проверка не отменяет найденного дефекта и не красит
   * зелёное в серое: отчёт число называет, вердикт считается по доказательствам. */
  check('вердикт от запоздавшей проверки не меняется',
    caseVerdict({ outcome: 'ok', checks: checks(2), steps: [] }) === 'pass');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
