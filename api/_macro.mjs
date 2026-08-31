/* The .mmmacro format, both ways.
 *
 * Mini Mouse Macro's layout, which the agent speaks and which people already have files of:
 *
 *   index | X | Y | delayMs | action
 *
 * where delayMs is the wait BEFORE the event. A flow adds a header per step:
 *
 *   startDelay=3000
 *   flowRepeat=forever
 *   STEP repeat=2 speed=1.0 delayAfter=500
 *
 * Ported unchanged from app.js. Keeping the format means an import from Mini Mouse Macro still works and
 * an export is still useful to somebody who has never seen this app.
 *
 * WHY THIS FILE IS IN api/. It used to be web/src/lib/macro.ts, read only by the Record screen. It has
 * three readers now: that screen, the local MCP server, and /api/mcp - which needs `parseMacro` because the
 * agent can stop a recording without a browser being open anywhere, and the five-column body it hands back
 * has to become a row somewhere. A serverless function cannot import out of the web app's source tree with
 * any confidence about what the bundler traces, so the module lives beside the API, the web app reaches it
 * through a shim that keeps its TypeScript types, and there is still exactly one parser. The alternative was
 * a second parser for the same format, which is the thing this arrangement exists to prevent.
 */

/* Имя без приписки приложения. Одно определение на всех читателей - см. api/_names.mjs. */
import { plainName } from './_names.mjs';
export function parseMacro(text) {
  const events = [];
  const problems = [];
  /* Context for the NEXT event line, from a `#ctx` comment above it. Comment lines were always skipped, so
  * this reads what newer agents add without breaking on what older ones do not write. */
  let pending;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line)
      continue;
    if (line.startsWith('#')) {
      if (line.startsWith('#ctx')) {
        /* Tab-separated key=value, deliberately not JSON: a window title can contain a quote, a brace or a
        * colon, and a format with no encoder has nothing to get wrong. Only the keys we know are read - an
        * agent that adds one is not a parse error. */
        const found = {};
        for (const field of line.slice(4).split('\t')) {
          const at = field.indexOf('=');
          if (at <= 0)
            continue;
          const key = field.slice(0, at).trim();
          const value = field.slice(at + 1).trim();
          if (value)
            found[key] = value;
        }
        /* Nine keys, not four.
         *
         * The agent has been writing `role`, `subrole`, `in` and `inName` since 0.8.0 and this dropped all
         * four on the floor - so a click that named nothing arrived as bare coordinates even though the
         * agent had said it was a button, and two clicks that resolved to the same row name arrived
         * indistinguishable even though one was the row and one was a control inside it. The wire names are
         * short because the format is; the object spells them out. */
        const context = {
          app: found.app,
          window: found.window,
          control: found.control,
          /* HOW LONG A NAME WAS THAT WAS NOT RECORDED, from agent 0.13.0. Never present beside `control` -
           * the agent writes one or the other - and absent on every recording made before it. */
          nameLength: found.namelen,
          type: found.type,
          role: found.role,
          subrole: found.subrole,
          container: found.in,
          containerName: found.inName,
          /* Origin and path, cut in the agent - see PROTOCOL.md. Carried through untouched here: this is
           * a parser, and a parser that also edited values would be a second place the rule lived. */
          url: found.url,
          /* МОДИФИКАТОРЫ, ЗАЖАТЫЕ ВО ВРЕМЯ ЖЕСТА - `Shift`, `Cmd+Shift`, `Alt`. Отсутствуют, если ничего не
           * держали или запись сделана агентом, который их ещё не писал.
           *
           * Одной строкой ровно такой формы: сборщик соответствия в agent/test-contract.mjs собирает эти
           * пары регуляркой `^\s+(\w+): found\.(\w+),$`, и разложенная на две строки или через
           * деструктуризацию форма молча выпадает из проверки соответствия. */
          modifiers: found.mods,
          /* ГДЕ ЭТО БЫЛО, когда сказать ЧТО не получилось — подпись ближайшего элемента управления и
           * сторона. Есть только у шага без имени; см. Ev.Near в агенте о том, почему это отдельное поле
           * и почему нельзя было «искать имя усерднее». */
          near: found.near,
          side: found.side,
        };
        pending = Object.values(context).some(Boolean) ? context : undefined;
      }
      continue;
    }
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 5) {
      problems.push(line.slice(0, 40));
      continue;
    }
    const [, x, y, delay, ...rest] = parts;
    const action = rest.join('|').trim();
    const event = {
      x: parseInt(x, 10),
      y: parseInt(y, 10),
      delayMs: parseInt(delay, 10),
      action,
    };
    if (!Number.isFinite(event.x) || !Number.isFinite(event.y) || !action) {
      problems.push(line.slice(0, 40));
      continue;
    }
    if (!Number.isFinite(event.delayMs) || event.delayMs < 0)
      event.delayMs = 0;
    /* Attached to this event and cleared, so a context line can never be read as belonging to two events -
    * which is how a click would come to claim the window of the click before it. */
    events.push(pending ? { ...event, context: pending } : event);
    pending = undefined;
  }
  return { events, problems };
}
export function flowBody(flow, recordings, opts) {
  const lines = [];
  lines.push(`startDelay=${Math.max(0, opts.startDelayMs)}`);
  lines.push(`flowRepeat=${opts.flowForever ? 'forever' : Math.max(1, opts.flowRepeat)}`);
  for (const step of flow) {
    const rec = recordings.find((r) => r.id === step.recordingId);
    if (!rec)
      continue; // a step whose recording was deleted is simply skipped
    lines.push(`STEP repeat=${step.repeat} speed=${step.speed} delayAfter=${step.delayAfterMs}`);
    rec.events.forEach((e, i) => {
      /* The context travels with the replay, not only with the export.
      *
      * This used to send five columns and nothing else, which meant a replay had coordinates while the
      * recording it came from knew the NAME of the thing it clicked. That is the difference between opening
      * the tab you recorded and opening whichever tab is now at those coordinates - a tab strip re-lays-out
      * every time the number of tabs changes. Comment lines were always skipped by every reader of this
      * format, so this could always have travelled; it simply was not sent. */
      if (e.context) {
        const fields = [];
        if (e.context.app)
          fields.push(`app=${e.context.app}`);
        if (e.context.window)
          fields.push(`window=${plainName(e.context.window)}`);
        /* ИМЯ, ПО КОТОРОМУ БУДУТ ЦЕЛИТЬСЯ, - без приписки, которую приложение к нему приклеило.
         *
         * Выше сказано, что разбор ничего не редактирует, и это остаётся правдой: там имя КЛАДЁТСЯ в
         * объект как пришло. Здесь оно ДОСТАЁТСЯ, чтобы агент нашёл по нему живой элемент, и это другая
         * операция. Chrome пишет в имя вкладки расход памяти, а число мегабайт меняется каждую минуту -
         * значит записанное «448 МБ» не совпадёт с живым «512 МБ», и прицел, написанный ради вкладок, на
         * вкладках отказывал. Обрезанное имя совпадает по префиксу, который sameName в агенте и проверяет.
         *
         * Форму «X - Memory usage - 299 MB» это чинит целиком. Форму «Вкладка "X" использует 448 МБ» - нет:
         * там приписка стоит и СЛЕВА, так что префикс не сойдётся, пока агент не чистит живое имя тоже.
         * Это правка в агенте, и она ждёт своей версии. */
        if (e.context.control)
          fields.push(`control=${plainName(e.context.control)}`);
        if (e.context.type)
          fields.push(`type=${e.context.type}`);
        /* Written back under the wire names the agent uses, so a body this produced and a body the agent
         * produced are the same document - which is what lets a replay be re-aimed by anything that reads
         * either. Unknown keys are skipped by every reader of this format, so an older one loses nothing. */
        if (e.context.role)
          fields.push(`role=${e.context.role}`);
        if (e.context.subrole)
          fields.push(`subrole=${e.context.subrole}`);
        if (e.context.container)
          fields.push(`in=${e.context.container}`);
        if (e.context.containerName)
          fields.push(`inName=${e.context.containerName}`);
        if (e.context.url)
          fields.push(`url=${e.context.url}`);
        /* Последним, в том же порядке, в каком пишут агенты. Значение проходит НЕТРОНУТЫМ - ни plainName,
         * ни приведения регистра: это набор токенов, а не имя. Проверка на пустоту обязательна: `mods=` с
         * пустым значением - это поле, которое каждому читателю пришлось бы отдельно оговаривать. */
        if (e.context.modifiers)
          fields.push(`mods=${e.context.modifiers}`);
        /* И ориентир, следом: экспорт с последующим импортом иначе молча снимает у шага единственное, что о
         * нём было известно, и перечитанная копия беднее оригинала без всякого видимого повода. Сторона
         * перед именем, в том же порядке, в каком пишет агент. */
        if (e.context.side)
          fields.push(`side=${e.context.side}`);
        if (e.context.near)
          fields.push(`near=${e.context.near}`);
        if (fields.length)
          lines.push(`#ctx	${fields.join('	')}`);
      }
      lines.push(`${i + 1} | ${e.x} | ${e.y} | ${e.delayMs} | ${e.action}`);
    });
  }
  return lines.join('\n');
}
export function exportMacro(rec) {
  const lines = [
    `# ${rec.name}`,
    `# recorded ${rec.created}`,
    ...(rec.windows.length ? [`# in ${rec.windows.map((w) => w.title).join(', ')}`] : []),
  ];
  rec.events.forEach((e, i) => {
    /* Context back out the way it came in, or an export-then-import round trip would quietly strip it and the
    * transcript of the reimported copy would be poorer than the original for no visible reason. */
    if (e.context) {
      const fields = [
        e.context.app && `app=${e.context.app}`,
        e.context.window && `window=${e.context.window}`,
        e.context.control && `control=${plainName(e.context.control)}`,
        e.context.type && `type=${e.context.type}`,
        /* И модификаторы, иначе экспорт с последующим импортом молча превращает каждый Shift-клик в клик:
         * перечитанный файл разбирается безупречно и беднее оригинала на то, чего в нём уже нет.
         *
         * Здесь же видно, что этот писатель теряет `role`, `subrole`, `in`, `inName` и `url` с тех пор, как
         * каждое из них появилось, - вопреки собственному комментарию про круговой путь. Это по одной
         * строке на каждое и ни одной правки у читателей, но это изменение поведения существующего формата
         * файла, и оно заслуживает отдельного решения, а не попутного. */
        e.context.modifiers && `mods=${e.context.modifiers}`,
      ].filter(Boolean);
      if (fields.length)
        lines.push(`#ctx	${fields.join('	')}`);
    }
    lines.push(`${i + 1} | ${e.x} | ${e.y} | ${e.delayMs} | ${e.action}`);
  });
  return lines.join('\n');
}
export function summarize(events) {
  let clicks = 0;
  let moves = 0;
  let durationMs = 0;
  for (const e of events) {
    durationMs += Math.max(0, e.delayMs || 0);
    if (/Click Down/i.test(e.action))
      clicks++;
    else if (/Movement/i.test(e.action))
      moves++;
  }
  return { count: events.length, clicks, moves, durationMs };
}
/* A duration, in the largest unit that still says something.
*
* Four branches rather than two, because the two it had printed "28800.0s" for eight hours - a number the
* reader has to divide twice before it means anything. While the longest recording here was 37 seconds that
* never came up; a session that runs a working day puts it on screen as the first thing anybody sees.
*
* Minutes carry seconds and hours carry minutes, but neither carries three units: "8h 04m 12s" is a
* stopwatch reading, and nobody reading "how long was this session" wants the seconds. */
export const fmtMs = (ms) => {
  if (!Number.isFinite(ms) || ms < 0)
    return '0ms';
  if (ms < 1000)
    return `${Math.round(ms)}ms`;
  /* 59_950, not 60_000: at 59.99 seconds the branch is chosen on the raw value and the digits are then
  * rounded, so the old boundary printed "60.0s" - a minute, said in the unit below a minute. */
  if (ms < 59_950)
    return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60)
    return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
};
