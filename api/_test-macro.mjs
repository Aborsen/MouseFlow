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
import { dropOwnTail, hasPlayable, parseMacro, summarize } from './_macro.mjs';

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

group('НЕ НАШЛИ ОСТАНОВКУ - НЕ ТРОГАЕМ НИЧЕГО, даже хвост движений');
{
  /* НАЙДЕНО НА ЖИВОЙ ЗАПИСИ (rnbf8qji9): запись остановили из чата, кнопку никто не нажимал - а первая
   * версия правила сняла бы двенадцать движений из двадцати семи. Движения снимаются только как ДОРОГА к
   * найденной кнопке; не найдя кнопки, снимать их не за что. */
  const events = [...clickIn('Gmail — Google Chrome'), move(600, 700), move(900, 900)];
  const out = dropOwnTail(events, OWN);
  check('хвост движений без нашего нажатия остаётся', out.dropped === 0 && out.events.length === 4,
    String(out.dropped));
  check('и список отдан тем же, а не пересобранным', out.events === events || out.events.length === 4);

  /* А С НАШИМ НАЖАТИЕМ - снимается и оно, и дорога к нему. */
  const withStop = [...clickIn('Gmail — Google Chrome'), move(600, 700), move(900, 900),
    ...clickIn('MouseFlow — Google Chrome', 960, 940)];
  const cut = dropOwnTail(withStop, OWN);
  check('а вместе с ним уходит и дорога', cut.dropped === 4 && cut.events.length === 2,
    String(cut.dropped));

  /* И ДРОЖАНИЕ ПОСЛЕ НАЖАТИЯ не мешает найти пару: мышь дёргается на кнопке, это норма. */
  const shaky = [...clickIn('Gmail — Google Chrome'), move(900, 900),
    ...clickIn('MouseFlow — Google Chrome', 960, 940), move(961, 941)];
  const out3 = dropOwnTail(shaky, OWN);
  check('дрожание после нажатия правило не сбивает', out3.dropped === 4 && out3.events.length === 2,
    String(out3.dropped));
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

group('«НИЧЕГО НЕ ЗАПИСАНО» - ЭТО НЕ ТОЛЬКО ПУСТОЙ СПИСОК');
{
  /* НАЙДЕНО НА ЖИВОЙ ЗАПИСИ (rq2pjkuxw, 61 событие, один клик): человек нажал «Стоп» в приложении, и
   * после отреза осталось РОВНО ОДНО событие - «Focus», пометка о смене переднего окна. Проверка на
   * длину списка её пропускала, и на аккаунт уезжала запись, которая при повторе не делает ничего и
   * отчитывается «1 событие сыграть не удалось». Сам агент относится к Focus так же: на повторе он идёт
   * в _unplayable вместе с Key Down. */
  const focus = { x: 1, y: 1, delayMs: 0, action: 'Focus', context: { app: 'powershell' } };
  check('одна пометка - это ничего', hasPlayable([focus]) === false);
  check('и три пометки тоже', hasPlayable([focus, focus, focus]) === false);
  check('пустой список - тем более', hasPlayable([]) === false && hasPlayable(null) === false);

  /* А ВОТ ЧТО ПОМЕТКОЙ НЕ ЯВЛЯЕТСЯ, и ни одно из этого терять нельзя. */
  check('движение - действие: оно сдвигает курсор', hasPlayable([focus, move()]) === true);
  check('набор - действие: содержимое не записано, а ВРЕМЯ записано, и повтор его выжидает',
    hasPlayable([focus, { x: 0, y: 0, delayMs: 5, action: 'Key Down' }]) === true);
  check('и клик, разумеется', hasPlayable([focus, ...clickIn('Gmail')]) === true);

  /* И ВМЕСТЕ С ОТРЕЗОМ - ровно та живая запись: одна пометка, дорога к кнопке, нажатие в нашем окне. */
  const asItWas = [focus, move(900, 900), move(950, 940), ...clickIn('MouseFlow', 960, 940)];
  const cut = dropOwnTail(asItWas, OWN);
  check('от записи из одного «Стоп» остаётся одна пометка',
    cut.dropped === 4 && cut.events.length === 1 && cut.events[0].action === 'Focus',
    JSON.stringify(cut.events));
  check('и она считается за «ничего не записано»', hasPlayable(cut.events) === false);
}

group('ПОМЕТКА ПОСЛЕ НАЖАТИЯ НЕ ПРЯЧЕТ ЕГО - самая живучая из трёх поломок');
{
  /* СООБЩЕНО С ПРОГОНА, ХВОСТ ЗАПИСИ rwheys2rm БЫЛ РОВНО ТАКОЙ:
   *
   *   Left Click Down    window=MouseFlow  control="Stop and save this recording"
   *   Left Click Release
   *   Focus              window=MouseFlow          <- последнее событие
   *
   * Клик по «Стоп» ВЕРНУЛ ФОКУС в наше окно, агент дописал пометку ПОСЛЕ пары - и правило, искавшее пару
   * на самом конце, находило там Focus и уходило ни с чем. Остановка оставалась в записи, и повтор в
   * конце снова её нажимал, то есть начинал новую запись. Пометка тут неизбежна: именно этот клик и
   * меняет переднее окно, так что мимо неё надо СМОТРЕТЬ, а не надеяться, что её не будет. */
  const focus = (window) => ({ x: 1, y: 1, delayMs: 0, action: 'Focus', context: { window } });

  const asItWas = [...clickIn('Windows PowerShell', 400, 300), move(1800, 250), move(1814, 248),
    ...clickIn('MouseFlow', 1814, 246), focus('MouseFlow')];
  const cut = dropOwnTail(asItWas, OWN);
  check('пометка после нажатия не мешает найти остановку', cut.dropped === 5, String(cut.dropped));
  check('и уходит вместе с ней - она про то же самое переключение',
    cut.events.length === 2 && cut.events.at(-1).action === 'Left Click Release',
    JSON.stringify(cut.events.at(-1)));
  check('а работа в терминале остаётся на месте',
    cut.events[0].context.window === 'Windows PowerShell');

  /* И НЕСКОЛЬКО ПОМЕТОК ПОДРЯД, вперемешку с дрожанием, - тоже не прячут. */
  check('пометки и дрожание в любом порядке',
    dropOwnTail([...clickIn('Gmail'), ...clickIn('MouseFlow'), focus('MouseFlow'), move(2, 2),
      focus('MouseFlow')], OWN).dropped === 5);

  /* НО ПОМЕТКА САМА ПО СЕБЕ НИЧЕГО НЕ РАЗРЕШАЕТ: не найдя нашего нажатия, правило по-прежнему не
   * снимает ничего - ни пометку, ни движения. Это и есть та осторожность, которую добавили до этого. */
  const noStop = [...clickIn('Gmail'), move(600, 700), focus('Gmail')];
  check('без нашего нажатия пометка остаётся, и движения тоже',
    dropOwnTail(noStop, OWN).dropped === 0);

  /* И ЧУЖОЕ НАЖАТИЕ ПОД ПОМЕТКОЙ - по-прежнему чужое. Пропуск пометок расширяет ПОИСК, а не право резать. */
  check('чужое нажатие под пометкой не снимается',
    dropOwnTail([...clickIn('MouseFlow'), ...clickIn('Gmail'), focus('Gmail')], OWN).dropped === 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
