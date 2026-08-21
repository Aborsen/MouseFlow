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
        const context = {
          app: found.app,
          window: found.window,
          control: found.control,
          type: found.type,
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
          fields.push(`window=${e.context.window}`);
        if (e.context.control)
          fields.push(`control=${e.context.control}`);
        if (e.context.type)
          fields.push(`type=${e.context.type}`);
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
        e.context.control && `control=${e.context.control}`,
        e.context.type && `type=${e.context.type}`,
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
