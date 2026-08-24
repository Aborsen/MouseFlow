/* Settings, following insightis/features/user-profile: a 176px nav down the left of the dialog, groups
 * under a small muted label, Log out pinned to the bottom with a red glyph.
 *
 * One size for all three, rather than a dialog that grows and shrinks as you move between them: the body
 * is a declared height and each screen is written to fit it, which is why Hours shows six rows and not
 * twelve. Nav rows share a height and a glyph box for the same reason the sidebar's do.
 *
 * Three screens rather than one long scroll:
 *
 *   My account    who you are, the theme, what is paired with you, and the way out of all of it
 *   Connections   the local agent: what it is doing, the one command that changes it, how to stop it
 *   Hours         their Balance screen, in the unit that means something for a tool that does work
 *
 * Teams WAS a fourth one and is now its own page, in the sidebar. It outgrew this dialog the moment it
 * stopped being a roster you fill in once: several teams, people being added and moved, invitations to
 * chase, and a dashboard scoped to each. None of that fits 560 declared pixels, and none of it is a
 * setting. A dialog also has no address, and the invitation email has to be able to link somewhere.
 */
import * as Dialog from '@radix-ui/react-dialog';
import {
  Clock,
  ExternalLink,
  LogOut,
  MessageSquare,
  Monitor,
  ShieldQuestion,
  User,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { Said } from '@/components/Said';
import { useAccount } from './AccountProvider';
import { MyAccountScreen } from './settings/MyAccountScreen';
import { ConnectionsScreen } from './settings/ConnectionsScreen';
import { HoursScreen } from './settings/HoursScreen';

export type SettingsScreen = 'account' | 'connections' | 'hours';

/* The one height all three screens are written to fit (see BODY below), and the row metrics the nav shares
 * with the sidebar's. Declared once rather than inferred from whichever screen happened to be tallest.
 *
 * 560px because that is what the tallest screen needs, measured rather than guessed: My account comes to
 * ~490px of content once the list of paired devices is bounded. The cap keeps it inside a short window - a
 * dialog taller than the viewport cannot be closed by the button at its top.
 *
 * A class and not an inline style: an inline height would win over max-sm:h-auto, and on a phone the dialog
 * goes column so a fixed height there would be 560px of dialog on a 600px screen. */
const BODY = 'h-[560px] max-h-[calc(100dvh-4rem)] max-sm:h-auto';
const ROW = 'flex h-9 shrink-0 items-center gap-2 rounded-md px-2 text-sm';
const GLYPH = 'size-[18px] shrink-0';

const TITLES: Record<SettingsScreen, string> = {
  account: 'My account',
  connections: 'Connections',
  hours: 'Hours',
};

interface Props {
  open: boolean;
  screen: SettingsScreen;
  onScreen: (screen: SettingsScreen) => void;
  onClose: () => void;
}

export const SettingsDialog = ({ open, screen, onScreen, onClose }: Props) => {
  const { leave, leaveProblem } = useAccount();
  const [said, setSaid] = useState<{ text: string; kind: 'good' | 'bad' } | null>(null);

  // A message belongs to the screen it was said on; carrying it across reads as an error about the wrong thing.
  useEffect(() => setSaid(null), [screen]);

  const item = (id: SettingsScreen, label: string, Icon: typeof User) => (
    <button
      key={id}
      type="button"
      onClick={() => onScreen(id)}
      className={cn(
        ROW,
        'w-full text-left text-ink-body hover:bg-state-hover hover:text-ink-primary',
        id === screen && 'bg-state-pressed font-semibold text-ink-primary',
      )}
    >
      <Icon className={GLYPH} />
      <span className="truncate">{label}</span>
    </button>
  );

  const link = (href: string, label: string, Icon: typeof User) => (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className={cn(ROW, 'w-full text-ink-body hover:bg-state-hover hover:text-ink-primary')}
    >
      <Icon className={GLYPH} />
      <span className="truncate">{label}</span>
      <ExternalLink className="ms-auto size-[15px] shrink-0 text-ink-inactive" />
    </a>
  );

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55" />
        <Dialog.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex w-[min(680px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2',
            'overflow-hidden rounded-xl border-stroke border bg-surface-card shadow-dropdown',
            'max-sm:flex-col',
          )}
        >
          <aside className="flex w-44 shrink-0 flex-col gap-4 border-stroke border-r bg-surface-card p-3 max-sm:w-full max-sm:flex-row max-sm:border-r-0 max-sm:border-b">
            <div className="flex flex-col gap-1">
              <Typography variant="span" className="px-2 text-ink-secondary text-xs max-sm:hidden">
                Account
              </Typography>
              <nav className="flex flex-col gap-0.5 max-sm:flex-row">
                {item('account', 'My account', User)}
                {item('connections', 'Connections', Monitor)}
                {item('hours', 'Hours', Clock)}
              </nav>
            </div>

            <div className="flex flex-col gap-1 max-sm:hidden">
              <Typography variant="span" className="px-2 text-ink-secondary text-xs">
                Support
              </Typography>
              <nav className="flex flex-col gap-0.5">
                {link('https://github.com/Aborsen/Mouse/issues/new', 'Leave feedback', MessageSquare)}
                {link('https://github.com/Aborsen/Mouse#readme', 'Resources', ShieldQuestion)}
              </nav>
            </div>

            <button
              type="button"
              onClick={leave}
              className={cn(
                ROW,
                'mt-auto w-full text-left text-ink-body hover:bg-state-hover',
                'max-sm:mt-0 max-sm:ms-auto max-sm:w-auto',
              )}
            >
              <LogOut className={cn(GLYPH, 'text-fb-red-text')} />
              <span>Log out</span>
            </button>

            {/* Beside the button that failed, because the alternative is what this replaced: a redirect that
              * looked like it had worked, back to an app the person was still signed in to. */}
            {leaveProblem && (
              <Typography variant="p" className="mt-1.5 max-w-[22rem] break-words text-fb-red-text text-[0.78rem]">
                {leaveProblem}
              </Typography>
            )}
          </aside>

          <div className={cn('flex min-w-0 flex-1 flex-col', BODY)}>
            <div className="flex items-center gap-4 border-stroke border-b p-4">
              <Dialog.Title asChild>
                <Typography variant="h2" weight="semibold" className="text-[1.05rem]">
                  {TITLES[screen]}
                </Typography>
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="ms-auto grid size-7 place-items-center rounded-md text-ink-secondary hover:bg-state-hover hover:text-ink-primary"
                >
                  <X className="size-[17px]" />
                </button>
              </Dialog.Close>
            </div>

            {/* Fixed above, so this is the same rectangle on every screen. It scrolls only if something
                unusual is in it - a long list of paired devices - because a clipped control cannot be
                reached at all, and each screen is written to fit without one. */}
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {screen === 'account' && <MyAccountScreen say={setSaid} />}
              {screen === 'connections' && <ConnectionsScreen say={setSaid} onClose={onClose} />}
              {screen === 'hours' && <HoursScreen />}

              <Said note={said} className="mt-3.5" />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export type Say = (said: { text: string; kind: 'good' | 'bad' } | null) => void;

/** A labelled row with something on the right, which is the shape every settings line here takes. */
export const Row = ({
  label,
  note,
  children,
  danger,
}: {
  label: string;
  note?: string;
  children?: React.ReactNode;
  danger?: boolean;
}) => (
  <div
    className={cn(
      'flex items-start gap-4 py-2.5',
      danger && 'mt-2 border-stroke border-t pt-3.5',
    )}
  >
    <div className="min-w-0 flex-1">
      <Typography variant="span" weight="semibold" className="block text-[0.9rem]">
        {label}
      </Typography>
      {note && (
        <Typography variant="p" className="mt-0.5 max-w-[46ch] text-ink-inactive text-[0.82rem]">
          {note}
        </Typography>
      )}
    </div>
    {children && <div className="shrink-0">{children}</div>}
  </div>
);

export { Button };
