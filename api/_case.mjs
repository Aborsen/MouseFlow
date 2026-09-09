/* Тест-кейс: что запустить, что должно быть верно, и как назвать то, что получилось.
 *
 * ЗАВИСИМОСТЕЙ НЕТ НАРОЧНО - как у _brain.mjs, _schedule.mjs и _expect.mjs. Этот модуль читают с трёх
 * сторон: облачный драйвер (api/mcp.js, ?worker=step) дописывает проверки к цели, маршрут страницы
 * (api/cases.js) проверяет утверждения и считает вердикт, и браузер (web/src/features/tests) рисует тот же
 * вердикт теми же словами. Три вычисления одного вердикта разошлись бы первым же изменением правила, и
 * разошлись бы молча: отчёт, который на странице зелёный, а в чате красный, хуже отсутствующего.
 * Типы для браузера - в _case.d.mts, править вместе.
 *
 * ЧЕТЫРЕ ИСХОДА, А НЕ ДВА, и это тот же принцип, что три исхода у одной проверки (см. _expect.mjs):
 *
 *   pass     - процедура прошла, и все утверждения сошлись. Единственный зелёный.
 *   fail     - утверждение НЕ сошлось. Это найденный дефект продукта, и он не прячется ни за чем.
 *   blocked  - вердикта о продукте нет: агент не довёл процедуру, или проверить не удалось, или прогон
 *              вообще ничего не утверждал. Это НЕ красный: это «мы не узнали».
 *   pass_with_repairs - прошло, но шаг починила модель. Дремлет до пункта 4 плана (гибридный реплей): чинить
 *              шаги сегодня некому, и ни один прогон так пока не помечается. Считается всё равно - место
 *              для него в словаре важнее, чем аккуратность «добавим, когда понадобится»: без него первый
 *              починенный прогон приехал бы в отчёт зелёным.
 *
 * Смешать blocked с fail - самая дорогая из возможных ошибок здесь. Ночь, в которую агент не смог открыть
 * приложение, покрасила бы отчёт красным наравне с найденным дефектом; через неделю таких ночей отчёт
 * перестают читать, и вместе с ним перестают замечать настоящие дефекты.
 */

import { CHECKS } from './_expect.mjs';

/** Ключ, под которым кейс едет в аргументах работы. Двойное подчёркивание - «это не параметр скилла». */
export const CASE_KEY = '__case';

/* СКОЛЬКО УТВЕРЖДЕНИЙ НА КЕЙС. Не техническое ограничение, а то же, что у чек-листа: восемь проверок в
 * конце одного прогона человек ещё читает, тридцать - уже нет, и кейс на тридцать утверждений почти всегда
 * означает, что это должно было быть тремя кейсами. Отказ называет число. */
export const EXPECTS_MAX = 8;

/* Длины - те же, что принимает шаг: имя контрола, искомый текст, процесс, «что это доказывает». Обрезать
 * молча было бы хуже: утверждение, у которого отрезали хвост, проверяет не то, что написали. */
const NAME_MAX = 200;
const TEXT_MAX = 400;
const WHY_MAX = 300;

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Разобрать присланные утверждения. Одна проверка на маршрут страницы и на тул: список утверждений,
 * который приняла одна дверь и отвергла другая, - это два разных представления о том, что такое кейс.
 *
 * @returns {{ expects: object[], why: string }} why непустой - список не принят, и в нём сказано почему.
 */
export function readExpects(input) {
  const list = Array.isArray(input) ? input : [];
  if (!list.length) {
    return {
      expects: [],
      /* Кейс без утверждений - это скилл с расписанием, и ровно этим он и должен быть. Отказ прямой:
       * тихо принятый пустой кейс каждую ночь выдавал бы «passed», ничего не проверив. */
      why: 'a case needs at least one check - without one it is a skill on a schedule, and every night it '
        + 'would report "passed" having proven nothing. Add what must be true when the run is done.',
    };
  }
  if (list.length > EXPECTS_MAX) {
    return { expects: [], why: `${EXPECTS_MAX} checks is the most one case takes; this has ${list.length}. `
      + 'More than that is usually several cases wearing one name.' };
  }
  const expects = [];
  for (let i = 0; i < list.length; i++) {
    const one = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const check = str(one.check);
    const name = str(one.name).slice(0, NAME_MAX);
    const text = str(one.text).slice(0, TEXT_MAX);
    const process = str(one.process).slice(0, NAME_MAX);
    const why = str(one.why).slice(0, WHY_MAX);
    const at = `check ${i + 1}`;
    if (!CHECKS.includes(check)) {
      return { expects: [], why: `${at}: "${check || '(nothing)'}" is not a kind of check. `
        + `One of ${CHECKS.join(', ')}.` };
    }
    if (!name) return { expects: [], why: `${at}: which control? Name it as it appears on screen.` };
    /* Текст обязателен там, где без него утверждение бессмысленно: «value_is» без значения не утверждает
     * ничего, а прошёл бы как утверждение. */
    if ((check === 'value_is' || check === 'value_contains') && !text) {
      return { expects: [], why: `${at}: ${check} needs \`text\` - the value it must hold.` };
    }
    /* «Что это доказывает» - не украшение: это единственная строка, которую человек читает в красном
     * отчёте в девять утра. Утверждение без неё оставляет его с именем контрола и догадкой. */
    if (!why) {
      return { expects: [], why: `${at}: say what it proves, in the goal's own words - it is what somebody `
        + 'reads in the report.' };
    }
    expects.push({ check, name, ...(text ? { text } : {}), ...(process ? { process } : {}), why });
  }
  return { expects, why: '' };
}

/** Одно утверждение словами - тем же порядком, в котором его написали. */
export const expectLine = (want) => {
  const one = want && typeof want === 'object' ? want : {};
  const check = str(one.check) || 'present';
  const bits = [`${check} "${str(one.name)}"`];
  if (str(one.text)) bits.push(`= "${str(one.text)}"`);
  if (str(one.process)) bits.push(`in ${str(one.process)}`);
  return `${bits.join(' ')}${str(one.why) ? ` - ${str(one.why)}` : ''}`;
};

/**
 * Цель прогона кейса: та же цель скилла плюс проверки, которые обязаны быть сделаны в конце.
 *
 * СЛОВАМИ, А НЕ ПОЛЕМ. Утверждения могли бы ехать в цикл отдельным полем и превращаться в вызовы expect
 * механически, без модели, - и это правильная форма для v2, где проверка привязана к шагу. Здесь они
 * дописаны к цели, потому что в конце прогона машина находится там, куда её привёл сам прогон: «Sent Items»
 * может быть за одним щелчком, а может требовать открыть папку, и решить это может только тот, кто видит
 * экран. Модель обязана ВЫЗВАТЬ expect - в brain уже сказано, что проверку решает машина, а не картинка, -
 * и вердикт считается по записанным шагам, а не по словам модели. Соврать в отчёте ей нечем.
 */
export function caseGoal(goal, expects) {
  const list = Array.isArray(expects) ? expects : [];
  if (!list.length) return String(goal || '');
  const lines = list.map((want, i) => `${i + 1}. ${expectLine(want)}`);
  return `${String(goal || '')}\n\n`
    + 'THIS IS A TEST CASE. When the goal above is done, and before finish, check every one of these with '
    + 'the expect tool - one call each, all of them, even when the screen makes the answer look obvious:\n'
    + `${lines.join('\n')}\n`
    + 'A failed check does not end the run: say what it means and finish. Do not decide any of them by '
    + 'looking at the picture, and do not skip one because the goal appeared to succeed - a check nobody '
    + 'made is the whole reason a suite stops being trusted.';
}

/** Аргументы скилла без служебных ключей: скилл не знает и не должен знать, что его гоняет кейс. */
export function stripCase(args) {
  const out = {};
  for (const key of Object.keys(args && typeof args === 'object' ? args : {})) {
    if (key.startsWith('__')) continue;
    out[key] = args[key];
  }
  return out;
}

/** Id кейса из аргументов работы, если работа - прогон кейса. */
export function caseIdOf(args) {
  const it = args && typeof args === 'object' ? args[CASE_KEY] : null;
  const id = it && typeof it === 'object' ? str(it.id) : '';
  return id || null;
}

/* Шаги, которые починила модель. Пункт 4 плана помечает такой шаг сам; здесь считается по признаку, а не по
 * его отсутствию - «нет пометки» значит «не чинили», и это тот же случай, что отсутствующий флаг агента. */
export function repairsOf(steps) {
  let n = 0;
  for (const step of Array.isArray(steps) ? steps : []) {
    if (step && typeof step === 'object' && step.repaired) n++;
  }
  return n;
}

/**
 * Вердикт одного прогона кейса.
 *
 * ПОРЯДОК ПРОВЕРОК - ЭТО И ЕСТЬ ПРАВИЛО. Провал утверждения идёт ПЕРВЫМ, раньше «агент не довёл»: прогон,
 * в котором проверка не сошлась и после этого агент сдался, - это найденный дефект, а не потерянная ночь, и
 * спрятать его в blocked значило бы потерять единственное, ради чего всё это гоняется.
 */
export function caseVerdict(run) {
  const it = run && typeof run === 'object' ? run : {};
  const checks = it.checks && typeof it.checks === 'object' ? it.checks : null;
  const failed = checks ? Number(checks.failed) || 0 : 0;
  const passed = checks ? Number(checks.passed) || 0 : 0;
  const unchecked = checks ? Number(checks.unchecked) || 0 : 0;

  if (failed > 0) return 'fail';
  /* Не «ok» - вердикта о продукте нет. Сюда попадает и прогон, который ещё идёт. */
  if (it.outcome !== 'ok') return 'blocked';
  /* Прошло, но НИЧЕГО не утверждало, или утверждать не удалось. Зелёным это быть не может: кейс без
   * доказательства - это ровно тот ложный зелёный, против которого написан весь этот файл. */
  if (!passed || unchecked > 0) return 'blocked';
  /* Число ПОЧИНЕННЫХ ШАГОВ или сами шаги - смотря что есть у того, кто спрашивает. Перечень кейсов считает
   * его запросом (шаги прогона весят до сотен килобайт, и тащить их ради одного признака в список из
   * тридцати ночей значило бы качать мегабайты на страницу), а один раскрытый прогон уже держит шаги в
   * руках. Одно правило, два входа - иначе список и раскрытая строка однажды скажут разное. */
  const repairs = Number.isFinite(Number(it.repairs)) && it.repairs != null
    ? Number(it.repairs) : repairsOf(it.steps);
  if (repairs > 0) return 'pass_with_repairs';
  return 'pass';
}

/* Слова вердикта - одни для страницы, для тула и для отчёта. `word` короткое, для чипа; `why` - строка,
 * которую человек читает, когда хочет знать, что это значит. */
export const VERDICTS = {
  pass: { word: 'passed', why: 'the procedure ran and every check held' },
  pass_with_repairs: {
    word: 'passed · repaired',
    why: 'every check held, but the model had to repair a step - a case that needs repairing is not yet '
      + 'stable enough to trust unattended',
  },
  fail: { word: 'failed a check', why: 'the run finished and something that must be true was not' },
  blocked: {
    word: 'no verdict',
    why: 'nothing was proven about the product: the run did not finish, or a check could not be evaluated, '
      + 'or it made none',
  },
};

/** Вердикт словами. Неизвестное имя отвечает своим именем, а не «pass». */
export const verdictSaid = (verdict) =>
  (VERDICTS[verdict] ? `${VERDICTS[verdict].word} - ${VERDICTS[verdict].why}` : String(verdict || 'unknown'));

/** Сводка по прогонам кейса: сколько чего. Считает один раз тот, кто их и так прочитал. */
export function tallyOf(verdicts) {
  const out = { pass: 0, pass_with_repairs: 0, fail: 0, blocked: 0 };
  for (const one of Array.isArray(verdicts) ? verdicts : []) {
    if (out[one] === undefined) continue;
    out[one]++;
  }
  return out;
}
