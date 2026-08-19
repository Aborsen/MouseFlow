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
 */
import type { FlowStep, RecordedEvent, Recording } from './store';

export function parseMacro(text: string): { events: RecordedEvent[]; problems: string[] } {
  const events: RecordedEvent[] = [];
  const problems: string[] = [];

  /* Context for the NEXT event line, from a `#ctx` comment above it. Comment lines were always skipped, so
   * this reads what newer agents add without breaking on what older ones do not write. */
  let pending: RecordedEvent['context'] | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      if (line.startsWith('#ctx')) {
        /* Tab-separated key=value, deliberately not JSON: a window title can contain a quote, a brace or a
         * colon, and a format with no encoder has nothing to get wrong. Only the keys we know are read - an
         * agent that adds one is not a parse error. */
        const found: Record<string, string> = {};
        for (const field of line.slice(4).split('\t')) {
          const at = field.indexOf('=');
          if (at <= 0) continue;
          const key = field.slice(0, at).trim();
          const value = field.slice(at + 1).trim();
          if (value) found[key] = value;
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
    if (!Number.isFinite(event.delayMs) || event.delayMs < 0) event.delayMs = 0;
    /* Attached to this event and cleared, so a context line can never be read as belonging to two events -
     * which is how a click would come to claim the window of the click before it. */
    events.push(pending ? { ...event, context: pending } : event);
    pending = undefined;
  }

  return { events, problems };
}

export function flowBody(
  flow: FlowStep[],
  recordings: Recording[],
  opts: { startDelayMs: number; flowRepeat: number; flowForever: boolean },
): string {
  const lines: string[] = [];
  lines.push(`startDelay=${Math.max(0, opts.startDelayMs)}`);
  lines.push(`flowRepeat=${opts.flowForever ? 'forever' : Math.max(1, opts.flowRepeat)}`);

  for (const step of flow) {
    const rec = recordings.find((r) => r.id === step.recordingId);
    if (!rec) continue;                       // a step whose recording was deleted is simply skipped
    lines.push(`STEP repeat=${step.repeat} speed=${step.speed} delayAfter=${step.delayAfterMs}`);
    rec.events.forEach((e, i) => {
      lines.push(`${i + 1} | ${e.x} | ${e.y} | ${e.delayMs} | ${e.action}`);
    });
  }

  return lines.join('\n');
}

export function exportMacro(rec: Recording): string {
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
      if (fields.length) lines.push(`#ctx	${fields.join('	')}`);
    }
    lines.push(`${i + 1} | ${e.x} | ${e.y} | ${e.delayMs} | ${e.action}`);
  });
  return lines.join('\n');
}

export interface Summary {
  count: number;
  clicks: number;
  moves: number;
  durationMs: number;
}

export function summarize(events: RecordedEvent[]): Summary {
  let clicks = 0;
  let moves = 0;
  let durationMs = 0;
  for (const e of events) {
    durationMs += Math.max(0, e.delayMs || 0);
    if (/Click Down/i.test(e.action)) clicks++;
    else if (/Movement/i.test(e.action)) moves++;
  }
  return { count: events.length, clicks, moves, durationMs };
}

export const fmtMs = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
