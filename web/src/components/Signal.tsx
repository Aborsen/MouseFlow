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

export const Signal = ({ events, bars = BARS, className }: {
  events: RecordedEvent[];
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
