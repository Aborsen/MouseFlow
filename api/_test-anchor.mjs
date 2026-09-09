/* Перепривязка клика - вычислением, потому что проверить её глазами можно только один раз и на одном окне.
 *
 * ЗДЕСЬ ДВЕ ВАЖНЫЕ ПРОВЕРКИ:
 *
 *   ПОРЯДОК ОТВЕТОВ. Найденный по имени контрол побеждает пересчёт по окну, а пересчёт - записанную точку.
 *   Перепутать первые два значит проиграть переверстанное окно по старой геометрии, то есть нажать не туда,
 *   имея в руках правильный ответ.
 *
 *   «RAW» НАЗЫВАЕТСЯ RAW. Повтор, который тихо сыграл по записанным координатам, - это ровно та хрупкость,
 *   которую всё это убирает. Если такой клик посчитать перепривязанным, отчёт соврёт именно там, где его
 *   читают - и следующая поломка окажется необъяснимой.
 *
 * Run: node api/_test-anchor.mjs
 */
import {
  anchorOf, anchoredSaid, findKey, matchWindow, reanchor, reanchorAll, rectOf, whatToFind,
} from './_anchor.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

/** Клик в 1074,159 внутри окна 1000,100 1200x800; контрол «Send» - прямоугольник вокруг точки. */
const click = (extra = {}) => ({
  x: 1074,
  y: 159,
  action: 'Left Click Down',
  context: {
    app: 'OUTLOOK',
    window: 'Inbox — Outlook',
    control: 'Send',
    anchor: { win: [1000, 100, 1200, 800], el: [1050, 140, 60, 30] },
    ...extra,
  },
});

group('НАЙДЕННЫЙ КОНТРОЛ ПОБЕЖДАЕТ ВСЁ - это ответ на тот вопрос, который задавали записью');
{
  const out = reanchor(click(), { x: 1000, y: 100, w: 1200, h: 800 }, { x: 300, y: 900 });
  check('точка - из find, а не из геометрии', out.x === 300 && out.y === 900, JSON.stringify(out));
  check('и это названо element', out.how === 'element', out.how);
  /* Даже если окно НЕ двигалось: кнопка могла переехать внутри - переверстка это и есть. */
  const still = reanchor(click(), { x: 1000, y: 100, w: 1200, h: 800 }, { x: 111, y: 222 });
  check('и побеждает даже у неподвижного окна - контрол мог переехать внутри',
    still.how === 'element' && still.x === 111, JSON.stringify(still));
  check('в «почему» сказано, что нашли по имени', /found by name/.test(out.why), out.why);
}

group('окно переехало - точка пересчитывается относительно окна');
{
  /* Окно сдвинулось на +400 по X и на -50 по Y, размер тот же: точка обязана сдвинуться так же. */
  const out = reanchor(click(), { x: 1400, y: 50, w: 1200, h: 800 }, null);
  check('сдвиг переносится один в один', out.x === 1474 && out.y === 109, JSON.stringify(out));
  check('и это названо window', out.how === 'window', out.how);
  check('и сказано, что окно переехало', out.why === 'its window moved', out.why);
}

group('окно РАСТЯНУЛИ - и тогда доля, а не смещение');
{
  /* Клик стоял на 74/1200 ширины и 59/800 высоты. Окно стало вдвое шире и вдвое выше от того же угла:
   * точка обязана уехать вдвое дальше от угла, иначе она попадёт в другую часть интерфейса. */
  const out = reanchor(click(), { x: 1000, y: 100, w: 2400, h: 1600 }, null);
  check('доля от ширины и высоты сохранена', out.x === 1148 && out.y === 218, JSON.stringify(out));
  check('и в «почему» сказано про размер', /changed size/.test(out.why), out.why);
  /* Половинный размер - в другую сторону, тем же правилом. */
  const half = reanchor(click(), { x: 0, y: 0, w: 600, h: 400 }, null);
  check('и в обратную сторону тоже', half.x === 37 && half.y === 30, JSON.stringify(half));
}

group('«RAW» НАЗЫВАЕТСЯ RAW - иначе отчёт соврёт там, где его читают');
{
  const gone = reanchor(click(), null, null);
  check('окна нет - играем как записано', gone.x === 1074 && gone.y === 159 && gone.how === 'raw',
    JSON.stringify(gone));
  check('и сказано, что окно не открыто', /not open now/.test(gone.why), gone.why);

  /* Окно НА МЕСТЕ - перепривязывать нечего, и это тоже raw: «перепривязано» было бы работой, которой не
   * было. */
  const still = reanchor(click(), { x: 1000, y: 100, w: 1200, h: 800 }, null);
  check('окно на месте - тоже raw, потому что ничего не пересчитывали',
    still.how === 'raw' && still.x === 1074, JSON.stringify(still));
  check('и сказано именно это', /has not moved/.test(still.why), still.why);
  /* Сдвиг на пиксель - то же окно: дрожание границ не повод пересчитывать. */
  const jitter = reanchor(click(), { x: 1001, y: 100, w: 1200, h: 801 }, null);
  check('пиксель туда-сюда - то же окно', jitter.how === 'raw', JSON.stringify(jitter));

  const bare = reanchor({ x: 5, y: 6, action: 'Left Click Down' }, { x: 0, y: 0, w: 100, h: 100 }, null);
  check('у записи без якоря (старый агент) - raw, и это не ошибка',
    bare.how === 'raw' && bare.x === 5 && bare.y === 6, JSON.stringify(bare));
  check('и сказано, что привязываться было не к чему', /nothing was recorded/.test(bare.why), bare.why);
}

group('якорь читается только настоящий');
{
  check('четыре числа - прямоугольник', JSON.stringify(rectOf([1, 2, 3, 4])) === '{"x":1,"y":2,"w":3,"h":4}');
  check('нулевая ширина - не прямоугольник', rectOf([1, 2, 0, 4]) === null);
  check('три числа - не прямоугольник', rectOf([1, 2, 3]) === null);
  check('строки - не прямоугольник', rectOf(['a', 'b', 'c', 'd']) === null);
  check('мусор вместо якоря', anchorOf({ context: { anchor: { win: 'нет' } } }) === null);
  check('только элемент, без окна - тоже якорь',
    JSON.stringify(anchorOf({ context: { anchor: { el: [1, 2, 3, 4] } } }))
      === '{"win":null,"el":{"x":1,"y":2,"w":3,"h":4}}');
  check('события без контекста', anchorOf({ x: 1, y: 2 }) === null && anchorOf(null) === null);
}

group('один поиск на контрол, а не на клик');
{
  const events = [click(), click(), click({ control: 'Discard' }),
    { x: 1, y: 1, context: { app: 'OUTLOOK', window: 'Inbox — Outlook' } },
    { x: 2, y: 2 }];
  const ask = whatToFind(events);
  check('двадцать нажатий на Send - один вопрос', ask.length === 2, JSON.stringify(ask.map((a) => a.control)));
  check('и у вопроса есть окно и приложение', ask[0].app === 'OUTLOOK' && ask[0].window === 'Inbox — Outlook');
  check('клик без контрола ни о чём не спрашивает', ask.every((a) => a.control));
  check('ключ ответа совпадает с ключом вопроса', findKey(events[0]) === ask[0].key, findKey(events[0]));
  check('а у клика без имени ключа нет', findKey(events[4]) === null);
}

group('и человек читает, как именно всё сыгралось');
{
  check('три числа словами',
    anchoredSaid({ element: 12, window: 3, raw: 1 })
      === '12 clicks re-anchored to their controls, 3 to their windows, 1 replayed as recorded.',
    anchoredSaid({ element: 12, window: 3, raw: 1 }));
  check('единственное число - без «s»',
    anchoredSaid({ element: 1 }) === '1 click re-anchored to its control.');
  check('нули не упоминаются', anchoredSaid({ element: 0, window: 2, raw: 0 })
    === '2 clicks to their windows.');
  check('и когда нечего сказать - ничего не говорится', anchoredSaid({}) === '' && anchoredSaid(null) === '');
}

group('ТО ЖЕ ОКНО СЕЙЧАС - три ступени, и ни одной дальше');
{
  const win = (title, process, extra = {}) => ({ title, process, x: 0, y: 0, w: 800, h: 600, ...extra });
  const ctx = { app: 'OUTLOOK', window: 'Inbox — Outlook' };

  check('тот же заголовок целиком',
    matchWindow(ctx, [win('Something else', 'chrome'), win('Inbox — Outlook', 'OUTLOOK')]).process === 'OUTLOOK');
  /* Заголовок МЕНЯЕТСЯ - это обычное дело, а не край: «3 unread — Outlook» это то же окно. */
  check('и то же приложение с изменившейся головой заголовка',
    matchWindow(ctx, [win('3 unread — Outlook', 'OUTLOOK'), win('Chrome', 'chrome')]) !== null);
  check('одно окно этого приложения - сомнений нет',
    matchWindow({ app: 'notepad', window: 'was.txt' }, [win('now.txt', 'notepad')]) !== null);
  /* А ТРИ окна одного приложения - выбор наугад, и промах наугад хуже честного «как записано». */
  check('три окна одного приложения - лучше ничего, чем наугад',
    matchWindow({ app: 'chrome', window: 'gone' },
      [win('one', 'chrome'), win('two', 'chrome'), win('three', 'chrome')]) === null);
  /* ОБЩИЙ КРАЙ, А НЕ «СОДЕРЖИТ»: два окна одного приложения, и у одного из них заголовок сменился в
   * голове - это то же окно; а «one» и «gone» роднит только вхождение, и по нему нажали бы не туда. */
  check('короткое случайное совпадение окном не считается',
    matchWindow({ app: 'chrome', window: 'gone' },
      [win('one', 'chrome'), win('two', 'chrome'), win('three', 'chrome')]) === null);
  check('а длинный общий хвост - считается',
    matchWindow({ app: 'OUTLOOK', window: 'Inbox — Outlook' },
      [win('3 unread — Outlook', 'OUTLOOK'), win('Nothing alike', 'OUTLOOK')]) !== null);
  check('свёрнутое окно не годится: его прямоугольник по соглашению врёт',
    matchWindow(ctx, [win('Inbox — Outlook', 'OUTLOOK', { minimized: true })]) === null);
  check('и окно без прямоугольника тоже',
    matchWindow(ctx, [{ title: 'Inbox — Outlook', process: 'OUTLOOK' }]) === null);
  check('пустой список', matchWindow(ctx, []) === null && matchWindow(ctx, null) === null);
}

group('вся запись целиком - и счёт, который человек прочитает');
{
  const win = (title, process, box) => ({ title, process, ...box });
  const events = [
    /* Клик с якорем в переехавшем окне. */
    click(),
    /* Отпускание без контекста - его не привязывают и в счёт не берут. */
    { x: 1074, y: 159, action: 'Left Click Release' },
    /* Движение - тем более. */
    { x: 500, y: 500, action: 'Mouse Movement' },
    /* Клик в окне, которого больше нет. */
    { x: 20, y: 30, action: 'Left Click Down',
      context: { app: 'gone', window: 'Gone', anchor: { win: [0, 0, 100, 100] } } },
  ];
  const { events: out, counts } = reanchorAll(events,
    [win('Inbox — Outlook', 'OUTLOOK', { x: 1400, y: 50, w: 1200, h: 800 })]);

  check('переехавший клик пересчитан', out[0].x === 1474 && out[0].y === 109, JSON.stringify(out[0]));
  check('и посчитан как window', counts.window === 1, JSON.stringify(counts));
  check('клик в исчезнувшем окне сыгран как записан',
    out[3].x === 20 && out[3].y === 30 && counts.raw === 1, JSON.stringify(counts));
  /* САМОЕ ВАЖНОЕ: то, у чего якоря нет, вообще не попадает в счёт - иначе отчёт говорил бы о сотнях
   * «сыграно как записано», которых никто и не собирался привязывать. */
  check('движения и отпускания в счёт не идут',
    counts.window + counts.raw === 2, JSON.stringify(counts));
  check('и остаются теми же объектами - ничего не переписано зря',
    out[1] === events[1] && out[2] === events[2]);
  check('сдвинутых событий столько же, сколько пересчитанных', counts.moved === 1, String(counts.moved));
  check('мусор на входе ничего не ломает',
    JSON.stringify(reanchorAll(null, null).counts) === '{"window":0,"raw":0,"moved":0}');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
