/* The search box above a list.
 *
 * Four of these were written by hand - recordings, skills, and the gallery twice - and by then they had
 * drifted in three ways that all matter and none of which anybody chose: the gallery's focus ring was the
 * brand colour where the other two used the input's own, its height came from padding rather than a fixed
 * `h-9` so it sat a pixel off beside its neighbours, and it had NO `aria-label`, which is the difference
 * between "search this collection" and an unnamed text box.
 *
 * That is the argument for the component rather than the pattern: nobody decided any of it.
 */
import type { ChangeEvent } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@insightis/ui/cn';

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Shown in the empty field. */
  placeholder: string;
  /** What it is for, said to a screen reader. Defaults to the placeholder, which is usually the same
   *  sentence - but it is a separate prop because a placeholder disappears the moment somebody types and a
   *  label does not. */
  label?: string;
  /** Two sizes, both named. The gallery's page-level box is genuinely larger than the one above a table -
   *  it is the first thing on that screen - and two deliberate sizes are not the same thing as the four
   *  accidental ones this replaced. */
  size?: 'md' | 'lg';
  className?: string;
}

export const SearchField = ({
  value, onChange, placeholder, label, size = 'md', className,
}: SearchFieldProps) => (
  <label className={cn('relative block', className)}>
    <Search
      className={cn(
        'absolute top-1/2 size-4 -translate-y-1/2 text-ink-inactive',
        size === 'lg' ? 'left-3' : 'left-2.5',
      )}
    />
    <input
      value={value}
      onChange={(ev: ChangeEvent<HTMLInputElement>) => onChange(ev.target.value)}
      placeholder={placeholder}
      aria-label={label ?? placeholder}
      className={cn(
        'w-full border-stroke border bg-surface-card2 pr-3',
        'text-[0.88rem] text-ink-primary placeholder:text-ink-inactive',
        'focus:border-input-focus focus:outline-none',
        size === 'lg' ? 'h-11 rounded-lg pl-9' : 'h-9 rounded-md pl-8',
      )}
    />
  </label>
);
