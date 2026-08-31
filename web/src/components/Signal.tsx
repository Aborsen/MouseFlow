/* When the events of a recording happened, drawn as bars.
 *
 * Derived, not decorative, and that is the only reason it earns the width: the recording's own span split
 * into buckets, with each bar's height from the events that fell in it. A recording that was one long pause
 * looks like one; a dense one looks dense. The same picture every time, because it is a function of the data
 * rather than an animation.
 *
 * Cumulative delay is the clock. Every event carries the gap BEFORE it, so an event's position in time is the
 * sum of the delays up to it - the same arithmetic api/_transcript.js does to place a step.
 *
 * Shared by the recordings table and the skills library, which is why it lives here: the two pages show the
 * same fact about the same events, and two implementations of that would eventually disagree about it.
 */
import { useMemo } from 'react';
import { cn } from '@insightis/ui/cn';
import type { RecordedEvent } from '@/lib/store';

const BARS = 16;

/* ABSENT IS NOT QUIET, and until this prop existed the two were drawn identically.
 *
 * An empty `events` array produced sixteen bars at the 8% floor - which is exactly the picture of a
 * recording where nothing much happened. But the commonest reason for an empty array is not a quiet
 * recording: when this browser runs out of room, the shed ladder in lib/store.ts moves the events of the
 * biggest recordings to the account and leaves `events: []` behind with `eventsOnAccount: true`. So the one
 * column that claims to show the shape of a recording was asserting "almost nothing happened" about a
 * four-hour session.
 *
 * The comment on the bars below already forbids this confusion one bar at a time. This is the same rule
 * applied to the whole picture.
 *
 * An em-dash, because that is what this codebase already uses for "not measured" - see fmtSeconds in the
 * dashboard, where null comes back as one for the same reason. `title` says which of the two it is, since
 * a dash on its own is only honest, not informative. */
export const Signal = ({ events, here = true, shape, bars = BARS, className }: {
  events: RecordedEvent[];
  /** False when the events are not in this browser. Callers use eventsAreHere() rather than testing again. */
  here?: boolean;
  /* The same picture, counted where the events actually are - api/_digest.mjs, delivered by api/sync.js.
   * Read only when the events are NOT here: a recording that holds its own events draws from them, so the
   * two derivations of one picture are never both in play for one row. */
  shape?: number[] | null;
  bars?: number;
  className?: string;
}) => {
  const buckets = useMemo(() => {
    const out = new Array(bars).fill(0);
    if (!events.length) return out;
    let at = 0;
    const stamps = events.map((e) => {
      at += Math.max(0, Number(e.delayMs) || 0);
      return at;
    });
    const span = stamps[stamps.length - 1] || 1;
    for (const stamp of stamps) {
      out[Math.min(bars - 1, Math.floor((stamp / span) * bars))] += 1;
    }
    return out;
  }, [events, bars]);

  const peak = Math.max(1, ...buckets);

  /* SERVED SHAPE, folded down to however many bars this caller wants. Summing adjacent buckets rather
   * than asking the server for a different count: the shape is derived once, at SHAPE_BARS, and a second
   * derivation per view is exactly what the digest exists to avoid. 16 into 10 does not divide evenly, so
   * the fold is by proportion of the source - which is the same arithmetic the bucketing above does. */
  const served = useMemo(() => {
    if (here || events.length || !Array.isArray(shape) || shape.length === 0) return null;
    const out = new Array(bars).fill(0);
    shape.forEach((n, i) => {
      out[Math.min(bars - 1, Math.floor((i / shape.length) * bars))] += Math.max(0, Number(n) || 0);
    });
    return out;
  }, [here, events.length, shape, bars]);

  if (served) {
    const top = Math.max(1, ...served);
    return (
      <div
        className={cn('flex h-6 items-end gap-[2px]', className)}
        title={`When the ${served.reduce((a, b) => a + b, 0)} recorded events happened, across the length of the recording. Read from your account — the events themselves are not in this browser.`}
      >
        {served.map((n, i) => (
          <span
            key={i}
            className={cn('w-[3px] rounded-full', n > 0 ? 'bg-brand-primary/80' : 'bg-stroke')}
            style={{ height: `${8 + (n / top) * 92}%` }}
          />
        ))}
      </div>
    );
  }

  if (!here && !events.length) {
    return (
      <span
        className={cn('flex h-6 items-center text-ink-inactive text-[0.8rem] tabular-nums', className)}
        title="The shape of this recording has not been worked out yet. Its events are kept on your account because there was no room in this browser, and the account derives the shape the next time the dashboard or the assistant reads it. Opening the recording fetches the events back."
      >
        —
      </span>
    );
  }

  return (
    <div
      className={cn('flex h-6 items-end gap-[2px]', className)}
      title={`When the ${events.length} recorded event${events.length === 1 ? '' : 's'} happened, across the length of the recording`}
    >
      {buckets.map((n, i) => (
        <span
          key={i}
          /* A floor rather than nothing: "no events in this stretch" and "there is no bar here" must not look
           * the same, or a gap reads as a rendering fault. */
          className={cn('w-[3px] rounded-full', n > 0 ? 'bg-brand-primary/80' : 'bg-stroke')}
          style={{ height: `${8 + (n / peak) * 92}%` }}
        />
      ))}
    </div>
  );
};
