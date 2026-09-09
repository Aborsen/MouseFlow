/* Перепривязка клика: во что превращается «1074,159», когда окно переехало.
 *
 * ЗАЧЕМ ЭТО ЕСТЬ. Запись хранит точку на экране, и это верно ровно до первого переезда окна. Человек сдвинул
 * Outlook на другой монитор, развернул его, поменял разрешение - и «нажать в 1074,159» попадает в пустоту
 * или, хуже, в чужую кнопку рядом. Замер не нужен: это происходит с каждой записью, которую проигрывают на
 * следующий день. Пункт 3 плана регрессии - про это.
 *
 * ЧЕТЫРЕ ОТВЕТА, ОТ СИЛЬНОГО К СЛАБОМУ, и порядок здесь и есть правило:
 *
 *   element  - имя контрола нашлось в нужном окне СЕЙЧАС (find_element). Это не пересчёт координат, это
 *              настоящий ответ: «Send» там, где Send теперь. Единственный, который переживает переверстку.
 *   window   - контрол не нашёлся, но окно нашлось: точка пересчитывается относительно окна, с масштабом,
 *              если окно ещё и изменило размер. Держит переезд и растяжение, не держит переверстку.
 *   raw      - ни того, ни другого: играем как записано. Это НЕ ошибка - на неанкоренной записи (старый
 *              агент) так и было всегда, - но об этом говорят словами, потому что именно здесь ломается.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: сети, DOM, агента и часов. На входе - событие с его якорем и то, что известно про экран
 * сейчас; на выходе - точка и КАК она получена. Поэтому это проверяется вычислением (api/_test-anchor.mjs),
 * а не глазами на живом окне: правило «относительно элемента, потом окна, потом как есть» - ровно то, что
 * обязано быть верным, когда никто не смотрит.
 *
 * Типы для браузера - в _anchor.d.mts, править вместе.
 */

/** Насколько окно должно было измениться, чтобы вообще пересчитывать. Пиксель туда-сюда - это то же окно. */
const MOVED = 2;

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

/** Прямоугольник из четырёх чисел, или null - если хоть одно не число или ширина/высота пусты. */
export function rectOf(list) {
  const four = Array.isArray(list) ? list.map(num) : [];
  if (four.length !== 4 || four.some((one) => one === null)) return null;
  const [x, y, w, h] = four;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/** Якорь события, каким его записал агент: окно и (когда было названо) элемент. */
export function anchorOf(event) {
  const ctx = event && typeof event === 'object' && event.context && typeof event.context === 'object'
    ? event.context : null;
  const anchor = ctx && ctx.anchor && typeof ctx.anchor === 'object' ? ctx.anchor : null;
  if (!anchor) return null;
  const win = rectOf(anchor.win);
  const el = rectOf(anchor.el);
  if (!win && !el) return null;
  return { win, el };
}

/** Точка внутри прямоугольника - в долях его ширины и высоты. Ноль-ноль - левый верхний угол. */
const shareIn = (rect, x, y) => ({
  fx: (x - rect.x) / rect.w,
  fy: (y - rect.y) / rect.h,
});

const same = (a, b) => Math.abs(a.x - b.x) <= MOVED && Math.abs(a.y - b.y) <= MOVED
  && Math.abs(a.w - b.w) <= MOVED && Math.abs(a.h - b.h) <= MOVED;

/**
 * Куда на самом деле нажать.
 *
 * @param {{x: number, y: number, context?: object}} event  событие записи
 * @param {{x: number, y: number, w: number, h: number}|null} nowWin  окно с тем же именем СЕЙЧАС
 * @param {{x: number, y: number}|null} hit  центр найденного контрола, если его нашли по имени
 * @returns {{x: number, y: number, how: 'element'|'window'|'raw', why: string}}
 */
export function reanchor(event, nowWin, hit) {
  const x = num(event && event.x);
  const y = num(event && event.y);
  const raw = { x: x === null ? 0 : Math.round(x), y: y === null ? 0 : Math.round(y) };

  /* НАЙДЕННЫЙ КОНТРОЛ ПОБЕЖДАЕТ ВСЁ. Он отвечает на тот вопрос, который человек и задавал записью:
   * «нажать Send», а не «нажать в этой точке». Даже если окно на месте: кнопка могла переехать внутри. */
  const found = hit && num(hit.x) !== null && num(hit.y) !== null
    ? { x: Math.round(num(hit.x)), y: Math.round(num(hit.y)) } : null;
  if (found) {
    return { ...found, how: 'element', why: 'found by name in that window' };
  }

  const anchor = anchorOf(event);
  const then = anchor && anchor.win;
  const now = rectOf(nowWin ? [nowWin.x, nowWin.y, nowWin.w, nowWin.h] : null);
  if (!then || !now || x === null || y === null) {
    return { ...raw, how: 'raw', why: then ? 'that window is not open now' : 'nothing was recorded to anchor to' };
  }

  /* Окно там же и того же размера - пересчитывать нечего, и «raw» здесь честнее, чем «window»: ничего не
   * перепривязывали. Отчёт из-за этого не врёт про работу, которой не было. */
  if (same(then, now)) {
    return { ...raw, how: 'raw', why: 'that window has not moved' };
  }

  /* ОТНОСИТЕЛЬНО ОКНА, С МАСШТАБОМ. Доля от ширины и высоты, а не смещение: развёрнутое окно - это не
   * переезд, а растяжение, и смещение на нём уводит точку тем сильнее, чем дальше она от угла. */
  const share = shareIn(then, x, y);
  const point = {
    x: Math.round(now.x + share.fx * now.w),
    y: Math.round(now.y + share.fy * now.h),
  };
  const moved = Math.abs(then.w - now.w) > MOVED || Math.abs(then.h - now.h) > MOVED;
  return {
    ...point,
    how: 'window',
    why: moved ? 'its window moved and changed size' : 'its window moved',
  };
}

/**
 * Сколько чего получилось - для строки, которую человек читает после повтора.
 *
 * ГОВОРИТЬ ОБ ЭТОМ ОБЯЗАТЕЛЬНО. Повтор, тихо сыгравший по записанным координатам, - это ровно та хрупкость,
 * которую всё это убирает; если он молчит, о ней узнают из результата, а не из отчёта.
 */
export function anchoredSaid(counts) {
  const it = counts && typeof counts === 'object' ? counts : {};
  const element = Math.max(0, Math.round(Number(it.element) || 0));
  const window = Math.max(0, Math.round(Number(it.window) || 0));
  const raw = Math.max(0, Math.round(Number(it.raw) || 0));
  if (!element && !window && !raw) return '';
  /* СЛОВО «CLICKS» - ОДИН РАЗ, у первого числа: «12 clicks re-anchored to their controls, 3 to their
   * windows, 1 replayed as recorded» читается как одна фраза, а трижды повторённое существительное - как
   * машинный отчёт, который пробегают глазами, не читая. */
  const bits = [];
  const first = () => !bits.length;
  const say = (n, tail) => `${n}${first() ? ` click${n === 1 ? '' : 's'}` : ''} ${tail}`;
  if (element) bits.push(say(element, `re-anchored to ${element === 1 ? 'its control' : 'their controls'}`));
  if (window) bits.push(say(window, `to ${window === 1 ? 'its window' : 'their windows'}`));
  if (raw) bits.push(say(raw, 'replayed as recorded'));
  return `${bits.join(', ')}.`;
}

/**
 * ТО ЖЕ ОКНО СЕЙЧАС - или ничего.
 *
 * Заголовок окна МЕНЯЕТСЯ, и это не редкость: «Inbox — Outlook» становится «3 unread — Outlook», документ
 * получает звёздочку, вкладка переключается. Поэтому три ступени, от точной к терпимой, и ни одной дальше:
 *
 *   1. тот же заголовок целиком - самый честный ответ;
 *   2. то же приложение и заголовок, который начинается или кончается тем же, что записанный (у окна
 *      документа меняется голова, у почты - хвост);
 *   3. то же приложение, и у него ровно ОДНО окно - тогда сомнений нет.
 *
 * Дальше - ничего: «то же приложение, три окна» это выбор наугад, а промах наугад хуже честного «сыграно
 * как записано». Свёрнутое окно не годится ни на одной ступени: его прямоугольник по соглашению врёт.
 */
/* ОБЩИЙ КРАЙ ДВУХ ЗАГОЛОВКОВ - сколько знаков совпадает с начала или с конца.
 *
 * Именно край, а не «содержит»: у окна почты меняется голова («Inbox — Outlook» → «3 unread — Outlook»,
 * общий хвост « — Outlook»), у окна документа - хвост («report.txt — Word» → «report.txt* — Word»). А
 * «содержит» роднит «one» с «gone» и любое короткое слово с любым текстом, в котором оно попалось.
 *
 * Шесть знаков и не меньше двух пятых короткого - вместе: шесть отсекает случайные совпадения коротких
 * слов, доля - случай, когда у длинного заголовка совпал десяток знаков по чистой случайности. */
const EDGE_MIN = 6;

function sharesEdge(a, b) {
  const one = String(a || '');
  const two = String(b || '');
  if (!one || !two) return false;
  const short = Math.min(one.length, two.length);
  let head = 0;
  while (head < short && one[head] === two[head]) head++;
  let tail = 0;
  while (tail < short && one[one.length - 1 - tail] === two[two.length - 1 - tail]) tail++;
  const edge = Math.max(head, tail);
  return edge >= EDGE_MIN && edge >= short * 0.4;
}

export function matchWindow(ctx, list) {
  const it = ctx && typeof ctx === 'object' ? ctx : {};
  const wanted = String(it.window || '').trim();
  const app = String(it.app || '').trim().toLowerCase();
  const open = (Array.isArray(list) ? list : []).filter((one) => one && !one.minimized
    && rectOf([one.x, one.y, one.w, one.h]));
  if (!open.length) return null;

  const titleOf = (one) => String(one.title || '').trim();
  const appOf = (one) => String(one.process || '').trim().toLowerCase();

  if (wanted) {
    const exact = open.filter((one) => titleOf(one) === wanted);
    if (exact.length === 1) return exact[0];
    /* Два окна с одинаковым заголовком - это выбор наугад, и лучше спуститься на ступень ниже. */
    if (exact.length > 1 && app) {
      const mine = exact.filter((one) => appOf(one) === app);
      if (mine.length === 1) return mine[0];
    }
  }

  if (app) {
    const mine = open.filter((one) => appOf(one) === app);
    if (wanted && mine.length > 1) {
      const near = mine.filter((one) => sharesEdge(titleOf(one), wanted));
      if (near.length === 1) return near[0];
    }
    if (mine.length === 1) return mine[0];
  }

  return null;
}

/**
 * Перепривязать всю запись перед отправкой на повтор.
 *
 * ПОЧЕМУ ЗДЕСЬ НЕ СПРАШИВАЮТ ПРО КОНТРОЛЫ, хотя план предполагал. Потому что оба агента УЖЕ прицеливаются
 * по имени на нажатии - Retarget в mouseflow-agent.ps1 и Accessibility.aim в .swift, - и делают это лучше,
 * чем это можно сделать отсюда: у них дерево под рукой, у страницы - только провод. Не работало это по
 * одной причине: прицел начинает с ЗАПИСАННОЙ точки, а после переезда окна записанная точка лежит в другом
 * окне, и среди его соседей нужного имени нет никогда.
 *
 * Поэтому здесь делается ровно то, чего агенту не хватало: точка возвращается ВНУТРЬ правильного окна.
 * Дальше агент сам доводит её до контрола по имени и сам считает, сколько раз это получилось
 * (retargeted в /replay/status). Два уровня, каждый там, где у него есть данные, и ни одного лишнего
 * обращения к дереву со стороны страницы.
 */
export function reanchorAll(events, list) {
  const counts = { window: 0, raw: 0, moved: 0 };
  const out = (Array.isArray(events) ? events : []).map((event) => {
    const ctx = event && event.context;
    /* Перепривязывать нечего у того, у чего нет якоря окна: движения, отпускания и записи старых агентов.
     * Они играются как записаны - и в счёт не идут, иначе отчёт говорил бы о сотнях «сыграно как есть»,
     * которых никто и не собирался привязывать. */
    const anchor = anchorOf(event);
    if (!anchor || !anchor.win) return event;
    const now = matchWindow(ctx, list);
    const put = reanchor(event, now ? { x: now.x, y: now.y, w: now.w, h: now.h } : null, null);
    if (put.how === 'window') counts.window++;
    else counts.raw++;
    if (put.x !== event.x || put.y !== event.y) counts.moved++;
    return put.x === event.x && put.y === event.y ? event : { ...event, x: put.x, y: put.y };
  });
  return { events: out, counts };
}

/**
 * Что спросить у агента перед повтором: имена контролов по окнам.
 *
 * ОДИН ВОПРОС НА КОНТРОЛ, А НЕ НА КЛИК. Двадцать нажатий на «Send» в одном окне - это один поиск, и разница
 * не в аккуратности: find стоит обращения к дереву доступности, и на длинной записи их было бы столько же,
 * сколько кликов.
 */
export function whatToFind(events) {
  const wanted = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const ctx = event && event.context;
    if (!ctx || !ctx.control) continue;
    /* Без якоря искать всё равно стоит: имя контрола - это самый сильный ответ, и оно есть у записей,
     * сделанных до того, как появились прямоугольники. */
    const key = `${ctx.app || ''} ${ctx.window || ''} ${ctx.control}`;
    if (wanted.has(key)) continue;
    wanted.set(key, {
      app: ctx.app || null,
      window: ctx.window || null,
      control: ctx.control,
      key,
    });
  }
  return [...wanted.values()];
}

/** Тот же ключ, которым whatToFind собирал вопросы - чтобы ответ нашёлся по событию. */
export const findKey = (event) => {
  const ctx = event && event.context;
  if (!ctx || !ctx.control) return null;
  return `${ctx.app || ''} ${ctx.window || ''} ${ctx.control}`;
};
