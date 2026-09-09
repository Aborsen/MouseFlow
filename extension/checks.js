/* Проверка, которую решает СТРАНИЦА, а не модель, - и её вердикт как доказательство.
 *
 * ЗАЧЕМ ЭТО ОТДЕЛЬНО ОТ api/_expect.mjs, который делает то же самое для десктопа. Потому что доказательства
 * разной силы, и разница не косметическая: там разбирается ответ дерева доступности (`tree`), здесь -
 * настоящий документ (`dom`). У DOM есть то, чего у дерева нет вовсе: точное число совпадений, адрес
 * страницы, текст элемента как он есть. Поэтому здесь на три вида проверки больше, а уровень называется
 * `dom` - самый сильный из четырёх (см. docs/product/25-tests.md).
 *
 * ЗАЧЕМ ЭТО ЛЕЖИТ В extension/, а не в api/. Расширение загружается из этой папки и импортировать что-либо
 * выше неё не может - ни в MV3, ни вообще. Поэтому общий код живёт ЗДЕСЬ, а сервер и веб-приложение
 * импортируют его отсюда: ровно так же уже сделан extension/skills.js, у которого три читателя.
 *
 * ФАКТЫ И ВЕРДИКТ - РАЗНЫЕ ВЕЩИ, и они нарочно разделены. Страница (content.js) отвечает только фактами:
 * сколько совпало, что видно, какой текст, какой адрес. Вердикт выносит чистая функция здесь - её можно
 * прогнать без браузера, чем и занимается extension/check-extension.mjs. Пока это был один кусок кода
 * внутри страницы, проверить правило «не удалось проверить - это не провал» было нечем.
 *
 * ТРИ ИСХОДА, А НЕ ДВА - то же правило, что у десктопа: `pass: null` значит «проверить не удалось». Страница,
 * которая не отвечает, и элемент, которого действительно нет, - разные факты, и слить их значит однажды
 * покрасить зелёным то, что ничего не доказало.
 */

/** Виды проверок, которые умеет DOM. Первые шесть - те же, что на десктопе; последние три есть только здесь. */
export const DOM_CHECKS = [
  'present', 'absent', 'text_is', 'text_contains', 'enabled', 'disabled',
  'url_is', 'url_contains', 'count_is',
];

/** Каким проверкам нужен `text`, иначе они ничего не утверждают. */
const NEEDS_TEXT = new Set(['text_is', 'text_contains', 'url_is', 'url_contains', 'count_is']);

/** А каким не нужно имя элемента: они про страницу целиком. */
const PAGE_WIDE = new Set(['url_is', 'url_contains']);

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const cut = (value, max = 120) => {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/**
 * Чего не хватает утверждению, чтобы его вообще можно было проверить, или null.
 * Одна проверка на страницу тестов, на тул и на цикл: список, принятый одним и отвергнутый другим, - это
 * два разных представления о том, что такое проверка.
 */
export function whyNotCheckable(want) {
  const one = want && typeof want === 'object' ? want : {};
  const asked = str(one.check);
  /* Оба написания - см. judgeDom: кейс с `value_is`, написанный для десктопа, на веб-скилле обязан
   * работать, а не отказывать из-за буквы. */
  const check = asked === 'value_is' ? 'text_is' : asked === 'value_contains' ? 'text_contains' : asked;
  if (!DOM_CHECKS.includes(check)) {
    return `"${check || '(nothing)'}" is not a kind of check. One of ${DOM_CHECKS.join(', ')}.`;
  }
  if (!PAGE_WIDE.has(check) && !str(one.name)) return `${check} needs the name of the thing to look at.`;
  if (NEEDS_TEXT.has(check) && !str(one.text)) {
    return check === 'count_is'
      ? 'count_is needs `text` - how many there should be, as a number.'
      : `${check} needs \`text\` - the value it must hold.`;
  }
  return null;
}

/**
 * Вердикт по фактам страницы.
 *
 * @param {{check: string, name?: string, text?: string, why?: string}} want
 * @param {{count?: number, name?: string, role?: string, text?: string, value?: string,
 *          disabled?: boolean, url?: string, title?: string, error?: string}} facts
 *   Как их вернула страница. `error` - страница не смогла ответить: это `pass: null`, а не «нет элемента».
 * @returns {{pass: boolean|null, how: string, evidence: string}}
 */
export function judgeDom(want, facts) {
  const one = want && typeof want === 'object' ? want : {};
  /* Два написания одного утверждения принимаются взаимно - см. judge в api/_expect.mjs: на десктопе у
   * контрола значение, в документе у элемента текст, и кейс, написанный для одной поверхности, не должен
   * отказывать на другой из-за буквы. */
  const asked = str(one.check);
  const check = asked === 'value_is' ? 'text_is' : asked === 'value_contains' ? 'text_contains' : asked;
  const name = str(one.name);
  const wanted = str(one.text);
  const seen = facts && typeof facts === 'object' ? facts : {};
  const cannot = (evidence) => ({ pass: null, how: 'dom', evidence });

  const bad = whyNotCheckable(one);
  if (bad) return cannot(`could not check: ${bad}`);
  if (str(seen.error)) return cannot(`could not check: ${str(seen.error)}`);

  const count = Number.isFinite(Number(seen.count)) ? Number(seen.count) : null;

  if (check === 'url_is' || check === 'url_contains') {
    const url = str(seen.url);
    if (!url) return cannot('could not check: the tab did not say what page it is on');
    const hit = check === 'url_is' ? url === wanted : url.includes(wanted);
    return {
      pass: hit,
      how: 'dom',
      evidence: hit
        ? `the page is ${cut(url, 160)}`
        : `the page is ${cut(url, 160)}, not ${check === 'url_is' ? '' : 'containing '}"${cut(wanted)}"`,
    };
  }

  if (check === 'count_is') {
    const asked = Math.round(Number(wanted));
    if (!Number.isFinite(asked)) return cannot(`could not check: "${cut(wanted, 40)}" is not a number`);
    if (count == null) return cannot('could not check: the page did not say how many matched');
    return {
      pass: count === asked,
      how: 'dom',
      evidence: `${count} thing${count === 1 ? '' : 's'} on the page ${count === 1 ? 'is' : 'are'} called `
        + `"${cut(name)}"${count === asked ? '' : `, not ${asked}`}`,
    };
  }

  if (count == null) return cannot('could not check: the page did not answer');

  if (check === 'absent') {
    return {
      pass: count === 0,
      how: 'dom',
      evidence: count === 0
        ? `nothing visible on the page is called "${cut(name)}"`
        : `"${cut(name)}" is still there${count > 1 ? ` (${count} of them)` : ''}`,
    };
  }

  /* Дальше всем нужен ровно один элемент: утверждение про один из пяти одноимённых - это утверждение о
   * случайно выбранном, а такое ничего не доказывает. Ноль - это честный провал у `present` и «не удалось»
   * у всего остального: «текст поля, которого нет» - не ложь, а невозможный вопрос. */
  if (count === 0) {
    return check === 'present'
      ? { pass: false, how: 'dom', evidence: `nothing visible on the page is called "${cut(name)}"` }
      : cannot(`could not check: nothing visible on the page is called "${cut(name)}"`);
  }
  if (count > 1 && check !== 'present') {
    return cannot(`could not check: ${count} things are called "${cut(name)}", so this would be a claim `
      + 'about whichever one came first');
  }

  const where = str(seen.role) || 'element';
  if (check === 'present') {
    return {
      pass: true,
      how: 'dom',
      evidence: `${where} "${cut(str(seen.name) || name)}" is on the page`
        + (count > 1 ? ` (${count} of them)` : ''),
    };
  }

  if (check === 'enabled' || check === 'disabled') {
    if (typeof seen.disabled !== 'boolean') {
      return cannot(`could not check: the page did not say whether "${cut(name)}" can be used`);
    }
    const hit = check === 'enabled' ? !seen.disabled : seen.disabled;
    return {
      pass: hit,
      how: 'dom',
      evidence: `${where} "${cut(name)}" is ${seen.disabled ? 'disabled' : 'enabled'}`,
    };
  }

  /* text_is / text_contains. Значение поля важнее его подписи: у input читается value, у остального - текст.
   * Пароль страница не отдаёт вовсе, и тогда это «не удалось», а не «не совпало». */
  if (seen.secret) return cannot(`could not check: "${cut(name)}" is a password field and is never read`);
  const held = seen.value != null && seen.value !== '' ? String(seen.value) : String(seen.text == null ? '' : seen.text);
  const holds = held.replace(/\s+/g, ' ').trim();
  if (!holds) {
    return cannot(`could not check: "${cut(name)}" holds nothing that can be read`);
  }
  const hit = check === 'text_is' ? holds === wanted : holds.includes(wanted);
  return {
    pass: hit,
    how: 'dom',
    evidence: hit
      ? `"${cut(name)}" holds "${cut(holds, 160)}"`
      : `"${cut(name)}" holds "${cut(holds, 160)}", not ${check === 'text_is' ? '' : 'containing '}"${cut(wanted)}"`,
  };
}

/**
 * Что модель прочитает про свою проверку. Слово в слово по форме с expectSaid в api/_expect.mjs: две
 * половины продукта не должны учить модель двум разным привычкам.
 */
export function checkSaid(want, verdict) {
  const one = want && typeof want === 'object' ? want : {};
  const head = verdict.pass === true ? 'PASS' : verdict.pass === false ? 'FAIL' : 'CANNOT CHECK';
  const tail = verdict.pass === false
    ? ' A failed check does not end the run: decide what it means for the goal, and say so.'
    : verdict.pass === null
      ? ' Not a failure - nothing was proven. Try another way of asking, or say in finish that it could '
        + 'not be checked.'
      : '';
  return `${head} - ${verdict.evidence}. (recorded as evidence, tier ${verdict.how})`
    + `${str(one.why) ? ` What it proves: ${str(one.why)}.` : ''}${tail}`;
}

/**
 * СВОДКА ПРОВЕРОК ПРОГОНА - одна на все три драйвера.
 *
 * Жила в api/_expect.mjs и переехала сюда, когда проверки появились в расширении: оно не может
 * импортировать ничего выше своей папки, а второй счёт «сколько проверок прошло» - это второй ответ на один
 * вопрос, и однажды они расходятся. Сервер и веб читают её отсюда (api/_expect.mjs её реэкспортирует).
 *
 * Шаг зовётся `tool` у десктопных драйверов и `name` у расширения - историческая разница форм, и здесь она
 * просто учтена: спрашивать «как называется поле с именем инструмента» дешевле, чем переписывать одну из
 * двух форм и всё, что её читает.
 */
/**
 * Вид кадра по тому, что этот ход доказал. Один ход - один кадр, поэтому вердиктов может быть несколько.
 *
 * Здесь, а не в api/_artifact.mjs (который её реэкспортирует), по той же причине, что и checksOf: кадры
 * оставляет и расширение. Одно правило на две поверхности - иначе они разойдутся на «не удалось проверить».
 *
 * @param {{pass: boolean|null}[]} verdicts
 */
export function kindOf(verdicts) {
  const all = Array.isArray(verdicts) ? verdicts : [];
  if (!all.length) return 'check';
  /* Провалом ход считается, если хоть одно утверждение не сошлось. «Не удалось проверить» провалом НЕ
   * считается - но и зачётом тоже: кадр всё равно сохраняется, потому что именно по нему потом и разбирают,
   * почему прочитать не вышло. */
  return all.some((v) => v && v.pass === false) ? 'failure' : 'check';
}

/** Слова к кадру: что этот ход доказал, коротко и по-человечески. */
export function saidOf(verdicts) {
  return (Array.isArray(verdicts) ? verdicts : [])
    .map((v) => `${v.pass === true ? 'PASS' : v.pass === false ? 'FAIL' : 'CANNOT CHECK'}: ${v.evidence}`)
    .join('; ')
    .slice(0, 2000);
}

export function checksOf(steps) {
  let passed = 0;
  let failed = 0;
  let unchecked = 0;
  const tiers = {};
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== 'object') continue;
    const which = step.tool || step.name;
    if (which !== 'expect' || !step.outcome) continue;
    if (step.outcome.pass === true) passed++;
    else if (step.outcome.pass === false) failed++;
    else unchecked++;
    const tier = String(step.outcome.how || 'picture');
    tiers[tier] = (tiers[tier] || 0) + 1;
  }
  if (!passed && !failed && !unchecked) return null;
  return { passed, failed, unchecked, tiers };
}
