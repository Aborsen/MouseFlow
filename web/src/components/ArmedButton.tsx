/* A destructive button that asks twice.
 *
 * Four screens do this and each wrote its own: press once and the button changes into the sentence it is
 * about to carry out, press again and it happens. A confirm() would be easy to click through and easy to
 * lose behind another one; the second press is the same guard without a second window.
 *
 * WHAT WAS ACTUALLY DIFFERENT between the copies, and is now not:
 *
 *   THE TIMER. Two of them disarmed themselves after six seconds and two did not - the recordings table
 *   says so in its own comment and works around it with a Cancel button beside the delete. A cocked
 *   destructive button that outlives the intention behind it is the hazard the second press exists to
 *   prevent, so the timer belongs to the button rather than to whoever remembered it.
 *
 * ARMED IS CONTROLLED, and that is deliberate rather than an oversight. A list keeps ONE cocked button at a
 * time - `armed` holds a row id, and arming another row disarms the first - which a button owning its own
 * state cannot do, because it cannot see its neighbours. So the page keeps the state and this keeps the
 * protocol.
 */
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@insightis/ui/Button';

/** How long a cocked button stays cocked. Long enough to read what it says, short enough not to outlive it. */
export const DISARM_MS = 6000;

export interface ArmedButtonProps {
  /** What it says at rest, and the verb the armed sentence is built from. */
  label: string;
  /** The whole armed sentence, when "<label> — press again" is not specific enough about what happens. */
  armedLabel?: string;
  armed: boolean;
  /** Asked for the first press. */
  onArm: () => void;
  /** Both the second press and the timer come through here, so a caller cannot handle one and forget the
   *  other. */
  onDisarm: () => void;
  /** The second press. */
  onConfirm: () => void;
  busy?: boolean;
  /** How it looks BEFORE it is armed; armed is always the solid destructive. */
  restingVariant?: 'destructiveTertiary' | 'destructiveOutline' | 'ghost';
  size?: 'lg' | 'sm' | 'xs';
  icon?: ReactNode;
  className?: string;
  title?: string;
  'aria-label'?: string;
}

export const ArmedButton = ({
  label, armedLabel, armed, onArm, onDisarm, onConfirm, busy = false,
  restingVariant = 'destructiveTertiary', size = 'sm', icon, className, title, ...rest
}: ArmedButtonProps) => {
  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(onDisarm, DISARM_MS);
    return () => clearTimeout(timer);
  }, [armed, onDisarm]);

  return (
    <Button
      variant={armed ? 'destructive' : restingVariant}
      size={size}
      disabled={busy}
      isLoading={busy}
      leftSlot={icon ?? <Trash2 className={size === 'xs' ? 'size-3.5' : 'size-4'} />}
      className={className}
      title={armed ? undefined : title}
      aria-label={rest['aria-label']}
      onClick={() => {
        if (!armed) { onArm(); return; }
        onConfirm();
      }}
    >
      {armed ? (armedLabel ?? `${label} — press again`) : label}
    </Button>
  );
};
