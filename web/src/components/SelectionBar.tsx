/* Ticking several rows and doing one thing to them, in one place.
 *
 * Three lists in this app grew this bar independently - recordings, skills, and a team's roster - and by
 * the third it was the same twenty lines three times, with the same two lessons written into each of them
 * as comments. A fix applied to one copy is a fix two screens still do not have, which is the whole reason
 * this is a component rather than a pattern.
 *
 * WHAT THE THREE HAD IN COMMON, and what is therefore here:
 *
 *   A FIXED HEIGHT. The controls appear when something is ticked, and without a reserved line the list
 *   below jumps down the moment somebody ticks the first box - which moves the row they were about to tick
 *   next out from under the pointer.
 *
 *   ARMING, NOT A DIALOG. A confirm() is easy to click through and easy to lose behind another one. The
 *   button asks twice instead, and disarms itself after six seconds: a destructive button left cocked is
 *   one stray click from being pressed.
 *
 *   CLEAR DISARMS. This was a real bug in the first copy: clearing the selection hid the bar with `armed`
 *   still true behind it, so ticking something again brought the delete back ALREADY COCKED, one click
 *   from taking several things off an account, with nothing on screen to say so. Here it cannot happen -
 *   the arming lives in this component, and the component is not rendered when nothing is selected, so the
 *   state goes with it.
 *
 * WHAT IS DELIBERATELY NOT HERE: which rows are selected. Each list decides what "on screen" means - a
 * search, a filter, a roster you may not remove yourself from - and the moment this component held the set
 * it would have to know about all three. It is given two numbers and three callbacks.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Trash2, X } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';

export interface SelectionBarProps {
  /** How many rows are currently on screen and could be ticked. */
  total: number;
  /** How many of those are ticked. */
  selected: number;
  /** Ticks everything on screen, or clears - the bar knows which, because it knows both numbers. */
  onSelectAll: (all: boolean) => void;
  /** Clears the selection. The bar disarms itself by unmounting, so this need only clear. */
  onClear: () => void;
  /** The destructive act, once it has been asked for twice. */
  onConfirm: () => void;
  /** "Delete" on a library, "Remove" on a roster: the same act, and not the same word. */
  verb?: string;
  /** Shown instead of the verb while the act is running. */
  busy?: boolean;
  /** What to say while it runs. Passed rather than derived from `verb`: "Delete" -> "Deleting" happens to
   *  work and "Cancel" -> "Canceling" happens not to, and a rule that is right twice by luck is a rule
   *  somebody will trust a third time. */
  busyLabel?: string;
  /** Anything else that can be done to a selection - Export, on the recordings table. */
  children?: ReactNode;
  size?: 'sm' | 'xs';
  /** The list's own count line, which each page words for itself: "6 recordings", "3 members". */
  label?: ReactNode;
  className?: string;
}

/** How long a cocked button stays cocked. Long enough to read the label, short enough not to outlive it. */
const DISARM_MS = 6000;

export const SelectionBar = ({
  total, selected, onSelectAll, onClear, onConfirm,
  verb = 'Delete', busy = false, busyLabel = 'Working…', children, size = 'sm', label, className,
}: SelectionBarProps) => {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), DISARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <div className={cn('flex min-h-8 flex-wrap items-center gap-3 text-[0.8rem]', className)}>
      {label}

      {total > 0 && (
        <button
          type="button"
          className="text-brand-primary hover:underline"
          onClick={() => onSelectAll(selected !== total)}
        >
          {selected === total ? 'Clear selection' : 'Select all'}
        </button>
      )}

      {selected > 0 && (
        <span className="ms-auto flex flex-wrap items-center gap-1.5">
          <Typography variant="span" className="text-ink-secondary">
            {selected} selected
          </Typography>

          {children}

          <Button
            variant={armed ? 'destructive' : 'destructiveTertiary'}
            size={size}
            disabled={busy}
            leftSlot={<Trash2 className={size === 'xs' ? 'size-3.5' : 'size-4'} />}
            onClick={() => {
              if (!armed) { setArmed(true); return; }
              onConfirm();
            }}
          >
            {busy ? busyLabel : armed ? `${verb} ${selected} — press again` : verb}
          </Button>

          <Button
            variant="ghost"
            size={size}
            leftSlot={<X className={size === 'xs' ? 'size-3.5' : 'size-4'} />}
            onClick={() => { setArmed(false); onClear(); }}
          >
            Clear
          </Button>
        </span>
      )}
    </div>
  );
};
