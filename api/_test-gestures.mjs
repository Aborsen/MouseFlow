/* Модифицированные жесты - читающая половина, ИСПОЛНЕНИЕМ.
 *
 * Shift-клик, Cmd-клик, Option-перетаскивание и Cmd+прокрутку нельзя было ни сделать, ни ЗАПИСАТЬ. Запись
 * человека, делавшего такое, воспроизводилась как жест БЕЗ модификатора и отчитывалась о чистом прогоне -
 * не потому, что повтор его срезал, а потому, что запись его не видела.
 *
 * Здесь проверяется путь чтения: разбор, круговой путь через экспорт, тело повтора и слова транскрипта.
 * Регулярка над исходником сказала бы, что поле упомянуто; выполнение говорит, что оно доезжает.
 *
 * Запуск: node api/_test-gestures.mjs
 */
import { exportMacro, flowBody, parseMacro } from './_macro.mjs';
import { transcribe } from './_transcript.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

const BODY = [
  '#ctx\tapp=Finder\twindow=Documents\tcontrol=Report.pdf\tmods=Shift',
  '1 | 10 | 20 | 0 | Left Click Down',
  '2 | 10 | 20 | 80 | Left Click Release',
  '#ctx\tmods=Cmd',
  '3 | 300 | 300 | 200 | Scroll Down',
].join('\n');

group('модификатор доезжает от файла до объекта и обратно');
const parsed = parseMacro(BODY);
check('разбирается с остальным контекстом',
  parsed.events[0].context.modifiers === 'Shift', JSON.stringify(parsed.events[0].context));
/* Строка с ОДНИМИ модификаторами - обычное дело: Cmd+прокрутка на разрешение имён не отправляется вовсе,
 * а Shift-клик по безымянному элементу не разрешает ничего. Раньше такая строка выбрасывалась целиком. */
check('строка с одними модификаторами не выбрасывается',
  parsed.events[2].context && parsed.events[2].context.modifiers === 'Cmd',
  JSON.stringify(parsed.events[2].context));

const rec = { id: 'p', name: 'probe', windows: [], events: parsed.events };
const exported = exportMacro(rec);
check('экспорт его выписывает', /mods=Shift/.test(exported) && /mods=Cmd/.test(exported));
/* Экспорт с последующим импортом - поддержанный путь; без этого он молча превращал Shift-клик в клик, и
 * перечитанный файл разбирался безупречно. */
check('и круговой путь его не теряет',
  JSON.stringify(parseMacro(exported).events.map((e) => (e.context && e.context.modifiers) || null))
    === JSON.stringify(['Shift', null, 'Cmd']));

const body = flowBody([{ recordingId: 'p', repeat: 1, speed: 1, delayAfterMs: 0 }], [rec],
  { startDelayMs: 0, flowRepeat: 1, flowForever: false });
check('и тело повтора несёт его агенту',
  /#ctx\tapp=Finder\twindow=Documents\tcontrol=Report\.pdf\tmods=Shift/.test(body)
    && /#ctx\tmods=Cmd/.test(body), JSON.stringify(body.split('\n').filter((l) => l.startsWith('#ctx'))));

group('транскрипт называет жест тем, чем он был');
const ev = (x, y, action, delayMs, context) => ({ x, y, action, delayMs, ...(context ? { context } : {}) });
const said = transcribe({
  id: 'p', name: 'probe', kind: 'recorded', source: 'desktop', created: '2026-08-28T00:00:00.000Z',
  payload: {
    version: 1, kind: 'recorded', agent: 'desktop',
    recorder: { version: '0.20.0', canName: true, canKeys: true },
    windows: [{ title: 'Finder', process: 'Finder' }],
    events: [
      ev(10, 10, 'Left Click Down', 0, { app: 'Finder', control: 'Report.pdf', modifiers: 'Shift' }),
      ev(10, 10, 'Left Click Release', 80),
      ev(10, 10, 'Left Click Down', 400, { app: 'Finder', control: 'Report.pdf', modifiers: 'Alt' }),
      ev(40, 60, 'Mouse Movement', 20), ev(120, 180, 'Mouse Movement', 20),
      ev(120, 180, 'Left Click Release', 60),
      ev(300, 300, 'Scroll Down', 300, { modifiers: 'Cmd' }),
      ev(300, 300, 'Scroll Down', 60, { modifiers: 'Cmd' }),
      ev(300, 300, 'Scroll Down', 60),
    ],
  },
});
const steps = said.segments.flatMap((s) => s.steps).map((s) => s.what);
check('Shift-клик назван Shift-кликом', steps.some((w) => /^Shift-clicked "Report\.pdf"/.test(w)), steps[0]);
/* Перетаскивание и прокрутка строят фразу сами, мимо actWords - приставка, добавленная только туда,
 * оставила бы два из четырёх жестов читаться ровно как сегодня. */
check('перетаскивание тоже, хотя фразу строит само',
  steps.some((w) => /^Alt-dragged \d+px from/.test(w)), JSON.stringify(steps));
check('и прокрутка тоже', steps.some((w) => /^Cmd-scrolled down/.test(w)), JSON.stringify(steps));
/* Три Cmd-прокрутки и три обычные - это два разных жеста: один зумит, второй листает. */
check('модифицированная прокрутка не сливается с обычной',
  steps.filter((w) => /scrolled down/.test(w)).length === 2, JSON.stringify(steps));
check('и обычная остаётся без приставки',
  steps.some((w) => /^scrolled down$/.test(w)), JSON.stringify(steps));

group('счёт мест не сбивается строкой, которая места не называет');
/* `#ctx` с одними модификаторами НЕ называет места. Считать его местом значит напечатать арифметику,
 * противоречащую себе: «для 7 из 5 кликов агент прочитал и то, что было под курсором». */
const only = transcribe({
  id: 'q', name: 'probe2', kind: 'recorded', source: 'desktop', created: '2026-08-28T00:00:00.000Z',
  payload: {
    version: 1, kind: 'recorded', agent: 'desktop',
    recorder: { version: '0.20.0', canName: true, canKeys: true }, windows: [],
    events: [
      ev(10, 10, 'Left Click Down', 0, { modifiers: 'Cmd' }),
      ev(10, 10, 'Left Click Release', 80),
    ],
  },
});
/* Наблюдаемое здесь - фраза `captured`: она говорит, ЧТО запись о себе знает. Если строку с одними
 * модификаторами счесть местом, эта фраза начнёт утверждать, что агент читал приложение и элемент под
 * каждым кликом, - а он не прочитал ничего, кроме модификатора. Проверять `summary.ctxClicks` бессмысленно:
 * его в сводке нет, и такая проверка проходила бы всегда. */
check('запись не начинает утверждать, что читала места',
  /No element names at all/.test(only.summary.captured), only.summary.captured.slice(0, 120));
check('и транскрипт всё равно построился', Array.isArray(only.segments) && only.segments.length > 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
