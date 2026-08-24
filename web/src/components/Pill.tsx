/* The small rounded label beside a row: "Desktop", "Ready", "Published", a count.
 *
 * WHY NOT THE DESIGN SYSTEM'S <Badge>, which exists and is used elsewhere in this app. Two reasons, and
 * both are about not fighting upstream:
 *
 *   ITS TONES ARE NOT THESE TONES. Badge offers primary, secondary, attention, success, error and accent.
 *   These labels are tinted with the app's OWN colours - brand-tertiary for a skill, brand-primary for a
 *   count, `state-hover` for a neutral - and two of those have no Badge variant at all. Bending them into
 *   the nearest one would change what the colours mean rather than where they are written.
 *
 *   ITS SIZES ARE FIXED HEIGHTS. A Badge is h-5 or h-7; these sit inside table rows whose rhythm is set by
 *   the row, and a fixed height changed the spacing of every list they appear in.
 *
 * So: Badge keeps the design system's semantics - a role, a state it defines - and this keeps the app's own
 * labels, in one place instead of twelve. Where the two agree, use Badge.
 */
import type { ReactNode } from 'react';
import { cn } from '@insightis/ui/cn';

/** Named for what the label MEANS, never for the colour, so a palette change does not rename anything. */
export type PillTone =
  /** No judgement - which half made it, what it is called. */
  | 'neutral'
  /** It worked, it is ready, it is out there. */
  | 'good'
  /** It failed, and somebody has to look. */
  | 'bad'
  /** A number worth noticing: how many, how often. */
  | 'count'
  /** A skill, which is the one thing this app tints with the second accent. */
  | 'skill';

const TONES: Record<PillTone, string> = {
  neutral: 'bg-state-hover text-ink-secondary',
  good: 'bg-fb-green/12 text-fb-green font-semibold',
  bad: 'bg-fb-red/15 text-fb-red-text font-semibold',
  count: 'bg-brand-primary/12 text-brand-primary font-semibold tabular-nums',
  skill: 'bg-brand-tertiary/15 text-brand-tertiary font-semibold',
};

export interface PillProps {
  tone?: PillTone;
  children: ReactNode;
  title?: string;
  className?: string;
}

export const Pill = ({ tone = 'neutral', children, title, className }: PillProps) => (
  <span
    title={title}
    className={cn(
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.72rem] whitespace-nowrap',
      TONES[tone],
      className,
    )}
  >
    {children}
  </span>
);
