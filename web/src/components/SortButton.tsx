/* A column heading that sorts the list under it.
 *
 * Two tables have these and the block was character-for-character the same in both, down to the comment
 * explaining why the arrow is drawn at all: a highlight says WHICH column is deciding and leaves which way
 * to be guessed, so the arrow is the half that carries the answer.
 *
 * One column, not the row of them: the two headers put different things around their buttons - a spacer for
 * the tick, an "Actions" label that does not sort - and a component that owned the whole row would have to
 * know about those.
 */
import { ChevronUp } from 'lucide-react';
import { cn } from '@insightis/ui/cn';

export interface SortButtonProps {
  label: string;
  /** True when this column is the one deciding the order. */
  active: boolean;
  /** Which way, when it is. */
  asc: boolean;
  onClick: () => void;
  /** Says what sorting by this column means, where the label alone does not. */
  title?: string;
  className?: string;
}

export const SortButton = ({ label, active, asc, onClick, title, className }: SortButtonProps) => (
  <button
    type="button"
    onClick={onClick}
    title={title ?? `Sort by ${label.toLowerCase()}`}
    className={cn(
      'flex items-center gap-1 text-left uppercase tracking-wide',
      'transition-colors duration-base hover:text-ink-secondary',
      active && 'text-brand-primary',
      className,
    )}
  >
    {label}
    {active && <ChevronUp className={cn('size-3 shrink-0', !asc && 'rotate-180')} />}
  </button>
);
