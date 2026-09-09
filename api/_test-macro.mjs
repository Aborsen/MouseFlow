/* Хвост, которым запись остановили, - вычислением.
 *
 * ПОЧЕМУ ЭТО ВООБЩЕ ПРОВЕРЯЕТСЯ ТЕСТОМ, А НЕ ГЛАЗАМИ. Поломку нашли прогоном: повтор записи в конце
 * поднимал MouseFlow и нажимал «Стоп» - то есть начинал новую запись. Увидеть это можно только сыграв
 * запись целиком на живой машине, и увидеть ОТСУТСТВИЕ поломки - тоже. Поэтому правило вынесено в чистую
 * функцию, а её граница держится здесь.
 *
 * ГЛАВНОЕ, ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ, - НЕ «СНИМАЕТ», А «НЕ СНИМАЕТ ЛИШНЕГО»:
 *
 *   Клик по чужому окну последним - остаётся. Иначе правило съедало бы настоящее последнее действие, и
 *   каждая запись играла бы на один шаг короче, чем её записали.
 *
 *   Прокрутка последней - остаётся. У неё есть последствие на экране; она действие, а не дорога к кнопке.
 *
 *   Снимается ОДНО нажатие, а не все наши с конца: человек мог до остановки смотреть что-то в приложении,
 *   и это его работа, а не управление инструментом.
 *
 * Run: node api/_test-macro.mjs
 */
import { dropOwnTail, parseMacro, summarize } from './_macro.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

const OWN = 'MouseFlow';
/** Клик по названному окну: нажали и отпустили, как их пишет агент. */
const clickIn = (window, x = 10, y = 20) => ([
  { x, y, delayMs: 5, action: 'Left Click Down', context: { app: 'chrome', window } },
  { x, y, delayMs: 5, action: 'Left Click Release', context: { app: 'chrome', window } },
]);
const move = (x = 1, y = 1) => ({ x, y, delayMs: 5, action: 'Mouse Movement' });

group('ОСТАНОВ СНЯТ - ровно то, ради чего функция есть');
{
  const events = [
    ...clickIn('Gmail — Google Chrome', 400, 300),
    move(600, 700), move(900, 900),
    /* Человек дошёл до вкладки с приложением и нажал «Стоп». */
    ...clickIn('MouseFlow — Google Chrome', 960, 940),
  ];
  const { events: out, dropped } = dropOwnTail(events, OWN);
  check('снято четыре события - два движения и пара нажатий', dropped === 4, String(dropped));
  check('последним осталось отпускание в Gmail',
    out.length === 2 && out[1].context.window.startsWith('Gmail'), JSON.stringify(out.at(-1)));
  check('и это те же объекты, ничего не переписано', out[0] === events[0] && out[1] === events[1]);
}

group('ЧУЖОЙ КЛИК ПОСЛЕДНИМ НЕ СНИМАЕТСЯ - иначе каждая запись теряла бы свой последний шаг');
{
  const events = [...clickIn('MouseFlow — Google Chrome'), ...clickIn('Gmail — Google Chrome')];
  const { events: out, dropped } = dropOwnTail(events, OWN);
  check('ничего не снято', dropped === 0 && out.length === 4, String(dropped));
}

group('СНИМАЕТСЯ ОДНО НАЖАТИЕ, А НЕ ВСЕ НАШИ С КОНЦА');
{
  /* Человек посмотрел что-то в приложении, потом нажал «Стоп». Первый клик - его работа. */
  const events = [...clickIn('MouseFlow — Google Chrome', 100, 100),
    ...clickIn('MouseFlow — Google Chrome', 960, 940)];
  const { events: out, dropped } = dropOwnTail(events, OWN);
  check('снята одна пара', dropped === 2 && out.length === 2, String(dropped));
  check('и осталась первая', out[0].x === 100, JSON.stringify(out[0]));
}

group('ПРОКРУТКА - ДЕЙСТВИЕ, А НЕ ДОРОГА: она остаётся на месте');
{
  const events = [...clickIn('Gmail — Google Chrome'), { x: 5, y: 5, delayMs: 5, action: 'Scroll Down' }];
  check('прокрутка последней уцелела', dropOwnTail(events, OWN).dropped === 0);

  /* А вот прокрутка ПЕРЕД нашим нажатием ничего не защищает: снимается нажатие, прокрутка остаётся. */
  const withStop = [...events, ...clickIn('MouseFlow — Google Chrome')];
  const out = dropOwnTail(withStop, OWN);
  check('и осталась, когда остановку сняли',
    out.dropped === 2 && out.events.at(-1).action === 'Scroll Down', JSON.stringify(out.events.at(-1)));
}

group('ЗАПИСЬ ИЗ ОДНОГО «СТОП» - ЭТО ПУСТАЯ ЗАПИСЬ, и она должна опустеть');
{
  const events = [move(900, 900), ...clickIn('MouseFlow — Google Chrome', 960, 940)];
  const { events: out } = dropOwnTail(events, OWN);
  check('не осталось ничего', out.length === 0, JSON.stringify(out));
}

group('НЕТ ЗАГОЛОВКА - НЕТ ПРАВИЛА: запись остаётся как записана');
{
  const events = [...clickIn('MouseFlow — Google Chrome')];
  check('пустой заголовок ничего не снимает', dropOwnTail(events, '').dropped === 0);
  check('короткий заголовок ничего не снимает - «MF» стоит внутри половины чужих окон',
    dropOwnTail(events, 'MF').dropped === 0);
  check('мусор на входе не ломается',
    dropOwnTail(null, OWN).events.length === 0 && dropOwnTail(undefined, OWN).dropped === 0);
  check('клик без контекста не считается нашим',
    dropOwnTail([{ x: 1, y: 1, action: 'Left Click Down' },
      { x: 1, y: 1, action: 'Left Click Release' }], OWN).dropped === 0);
}

group('ИМЯ ОКНА КОРОЧЕ НАШЕГО ЗАГОЛОВКА - тоже мы: дерево доступности отдаёт что придётся');
{
  const events = [...clickIn('Gmail — Google Chrome'), ...clickIn('MouseFlow')];
  check('точное совпадение опознано', dropOwnTail(events, OWN).dropped === 2);
  check('и вхождение в другую сторону тоже',
    dropOwnTail([...clickIn('Gmail'), ...clickIn('Mouse')], 'MouseFlow').dropped === 2);
}

group('ПРАВИЛО СТОИТ НА ТОМ ЖЕ ФОРМАТЕ, ЧТО РАЗБИРАЕТ parseMacro - проверено сквозь него');
{
  const text = [
    '1 | 400 | 300 | 5 | Left Click Down',
    '2 | 400 | 300 | 5 | Left Click Release',
    '#ctx\tapp=chrome\twindow=MouseFlow — Google Chrome',
    '3 | 960 | 940 | 5 | Left Click Down',
    '4 | 960 | 940 | 5 | Left Click Release',
  ].join('\n');
  const parsed = parseMacro(text);
  const { events: out, dropped } = dropOwnTail(parsed.events, OWN);
  check('разобрано пять строк в четыре события', parsed.events.length === 4, String(parsed.events.length));
  check('и остановка снята', dropped === 2 && out.length === 2, String(dropped));
  check('сводка считается по остатку', summarize(out).count === 2, JSON.stringify(summarize(out)));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
