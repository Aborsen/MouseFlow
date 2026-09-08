/* Проверка, которую решает машина, а не модель по картинке.
 *
 * ЗАЧЕМ ЭТО ОТДЕЛЬНЫЙ ЧИСТЫЙ МОДУЛЬ. `expect` - это единственное место во всём продукте, где ответ обязан
 * быть ДОКАЗАТЕЛЬСТВОМ, а не мнением: на нём стоит регрессионное тестирование, а тест, который «прошёл,
 * потому что модель посмотрела и решила», не стоит того, чтобы его гонять ночью. Значит решение принимается
 * разбором ответа дерева доступности, разбор один на оба драйвера, и он проверяется исполнением - как
 * арифметика расписаний в _schedule.mjs и по той же причине.
 *
 * ТРИ ИСХОДА, А НЕ ДВА. `pass: true`, `pass: false` и `pass: null` - «проверить не удалось». Это тот же
 * принцип, что «absent значит не знаю, а не нет», которым здесь живут флаги агента и `#ctx`: окно, которое
 * не удалось прочитать, и окно, в котором названного нет, - разные факты, и схлопнуть их значит однажды
 * покрасить зелёным тест, который ничего не проверил. Сводка прогона считает их тремя числами.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: обращения к экрану, к базе и к модели. На входе - то, что попросили проверить, и строка,
 * которой ответил агент на `action=find`; на выходе - вердикт и доказательство словами. Всё.
 */

/** Что можно утверждать. Пять слов, а не язык выражений: утверждение, которое нельзя прочитать вслух, нельзя и проверить глазами. */
export const CHECKS = ['present', 'absent', 'value_is', 'value_contains', 'enabled', 'disabled'];

/** Уровень доказательства, от сильного к слабому. Пишется в шаг: тест, доказанный картинкой, слабее. */
export const TIERS = ['dom', 'tree', 'ocr', 'picture'];

/* Ответы агента на `action=find`, дословно (см. FindElement в mouseflow-agent.ps1 и его пару в .swift -
 * оба агента говорят это ОДНИМИ словами, и на этом разбор стоит):
 *
 *   found <kind> "<name>" at X,Y WxH [= "<value>" | = (password, not read)] [(disabled)], centre CX,CY - click the centre
 *   N things match "<wanted>", so the name alone does not say which: <line>; <line>. Pick by position, or use a longer name
 *   nothing on that window is called "<wanted>". Read the window to see what it does call things, ...
 *   find needs a name to look for | could not read that window | <problem>
 */

/** Разобрать ответ find в факты. `how: null` значит «это вообще не ответ find». */
export function readFound(output) {
  const said = String(output == null ? '' : output).trim();
  if (!said) return { kind: 'cannot', why: 'the machine said nothing' };

  if (/^nothing on that window is called/.test(said)) {
    return { kind: 'none', why: said };
  }
  const several = said.match(/^(\d+) things match/);
  if (several) {
    return { kind: 'several', count: Number(several[1]), why: said, lines: linesOf(said) };
  }
  if (/^found /.test(said)) {
    const one = linesOf(said)[0] || {};
    return { kind: 'one', why: said, ...one };
  }
  /* Всё остальное - отказ прочитать, а не отсутствие. «Окно не читается» и «в окне такого нет» - разные
   * факты, и второй, выданный за первый, это зелёный тест, который ничего не проверил. */
  return { kind: 'cannot', why: said };
}

/** Значения из строк вида `element "Name" at 1,2 3x4 = "text" (disabled), centre 5,6`. */
function linesOf(said) {
  const out = [];
  const re = /(?:^|[:;]\s*)(?:found\s+)?([A-Za-z][\w -]*?)\s+"([^"]*)"\s+at\s+(-?\d+),(-?\d+)\s+(\d+)x(\d+)((?:\s*=\s*(?:"[^"]*"|\(password, not read\)))?)((?:\s*\(disabled\))?)/g;
  let m = re.exec(said);
  while (m) {
    const valuePart = (m[7] || '').trim();
    out.push({
      role: m[1],
      name: m[2],
      at: [Number(m[3]), Number(m[4])],
      size: [Number(m[5]), Number(m[6])],
      /* `null` - поля нет или оно не читается; `''` - поле есть и пустое. Разные факты. */
      value: valuePart.startsWith('= "') ? valuePart.slice(3, -1) : null,
      secret: /\(password, not read\)/.test(valuePart),
      enabled: !(m[8] || '').includes('(disabled)'),
    });
    m = re.exec(said);
  }
  return out;
}

/**
 * Вердикт по одной проверке.
 *
 * @param {{check: string, name: string, text?: string}} want
 * @param {string|undefined} output   что ответил агент на find
 * @param {boolean} [isError]         агент ответил ошибкой
 * @returns {{pass: boolean|null, how: string, evidence: string}}
 */
export function judge(want, output, isError = false) {
  const check = String((want && want.check) || '');
  const name = String((want && want.name) || '');
  const text = want && want.text != null ? String(want.text) : null;
  const how = 'tree';

  if (!CHECKS.includes(check)) {
    return { pass: null, how, evidence: `"${check}" is not a check I know: ${CHECKS.join(', ')}` };
  }
  if (isError) {
    return { pass: null, how, evidence: `the machine could not look: ${String(output || 'no reason given')}` };
  }

  const found = readFound(output);

  if (found.kind === 'cannot') {
    return { pass: null, how, evidence: `could not check: ${found.why}` };
  }

  if (check === 'present') {
    if (found.kind === 'none') return { pass: false, how, evidence: `"${name}" is not on the window` };
    if (found.kind === 'several') {
      /* Несколько - это ЕСТЬ, и неоднозначность названа: она важна для следующего шага, а не для вердикта. */
      return { pass: true, how, evidence: `"${name}" is on the window (${found.count} things match)` };
    }
    return { pass: true, how, evidence: whereSaid(found, name) };
  }

  if (check === 'absent') {
    if (found.kind === 'none') return { pass: true, how, evidence: `nothing on the window is called "${name}"` };
    const n = found.kind === 'several' ? `${found.count} things` : whereSaid(found, name);
    return { pass: false, how, evidence: `"${name}" IS on the window: ${n}` };
  }

  /* Значение поля. Несколько совпадений - «не удалось»: какое из них? Утверждение о поле, выбранном
   * наугад, доказывает не то, что просили. */
  if (check === 'value_is' || check === 'value_contains') {
    if (text == null) return { pass: null, how, evidence: `${check} needs the text to compare against` };
    if (found.kind === 'none') return { pass: null, how, evidence: `could not check: "${name}" is not on the window` };
    if (found.kind === 'several') {
      return { pass: null, how, evidence: `could not check: ${found.count} things are called "${name}", so which one holds the value is not decided` };
    }
    if (found.secret) return { pass: null, how, evidence: `"${name}" is a password field and is deliberately not read` };
    if (found.value == null) return { pass: null, how, evidence: `"${name}" is a ${found.role || 'control'} with no value to read` };
    const got = found.value;
    const ok = check === 'value_is'
      ? got.trim() === text.trim()
      : got.toLowerCase().includes(text.toLowerCase());
    return {
      pass: ok, how,
      evidence: ok
        ? `"${name}" holds "${got}"`
        : `"${name}" holds "${got}", ${check === 'value_is' ? 'not' : 'which does not contain'} "${text}"`,
    };
  }

  /* enabled / disabled: агент печатает «(disabled)» в строке, поэтому это читается из того же ответа и НЕ
   * требует нового действия. Отсутствие пометки значит «включено» - так печатает Line() в обоих агентах. */
  if (found.kind === 'none') return { pass: null, how, evidence: `could not check: "${name}" is not on the window` };
  if (found.kind === 'several') {
    return { pass: null, how, evidence: `could not check: ${found.count} things are called "${name}"` };
  }
  const wantEnabled = check === 'enabled';
  return {
    pass: found.enabled === wantEnabled, how,
    evidence: `"${name}" is ${found.enabled ? 'enabled' : 'disabled'}`,
  };
}

const whereSaid = (found, name) =>
  `${found.role || 'element'} "${found.name || name}" at ${found.at ? found.at.join(',') : '?'}`;

/** Что читает модель. PASS/FAIL/CANNOT первым словом: это единственное, что обязано быть замечено. */
export function expectSaid(want, result) {
  const head = result.pass === true ? 'PASS' : result.pass === false ? 'FAIL' : 'CANNOT CHECK';
  const why = want && want.why ? ` (checking: ${String(want.why).slice(0, 200)})` : '';
  const tail = result.pass === false
    ? ' — this is recorded as a failed check. Say what you will do about it, or finish with ok false.'
    : result.pass === null
      ? ' — nothing was proven either way, and the run records it as unchecked rather than as a pass.'
      : '';
  return `${head} (${result.how}): ${result.evidence}${why}.${tail}`;
}

/**
 * Сводка по прогону из его шагов. Три числа, а не два, и уровни доказательства рядом: прогон, все проверки
 * которого доказаны картинкой, - это не регрессионный тест, и сводка обязана позволять это увидеть.
 */
export function checksOf(steps) {
  let passed = 0;
  let failed = 0;
  let unchecked = 0;
  const tiers = {};
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || step.tool !== 'expect' || !step.outcome) continue;
    if (step.outcome.pass === true) passed++;
    else if (step.outcome.pass === false) failed++;
    else unchecked++;
    const tier = String(step.outcome.how || 'picture');
    tiers[tier] = (tiers[tier] || 0) + 1;
  }
  if (!passed && !failed && !unchecked) return null;
  return { passed, failed, unchecked, tiers };
}
