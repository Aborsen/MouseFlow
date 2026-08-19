/* Settings, following insightis/features/user-profile: a 176px nav down the left of the dialog, groups
 * under a small muted label, Log out pinned to the bottom with a red glyph.
 *
 * Three screens rather than one long scroll:
 *
 *   My account    who you are, the theme, what is paired with you, and the way out of all of it
 *   Connections   the local agent: what it is doing, the one command that changes it, how to stop it
 *   Hours         their Balance screen, in the unit that means something for a tool that does work
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
import { Button } from '@/ui/components/Button';
import { Typography } from '@/ui/components/Typography';
import { cn } from '@/ui/lib/utils';
import { useAccount } from './AccountProvider';
import { MyAccountScreen } from './settings/MyAccountScreen';
import { ConnectionsScreen } from './settings/ConnectionsScreen';
import { HoursScreen } from './settings/HoursScreen';

export type SettingsScreen = 'account' | 'connections' | 'hours';

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
  const { leave } = useAccount();
  const [said, setSaid] = useState<{ text: string; kind: 'good' | 'bad' } | null>(null);

  // A message belongs to the screen it was said on; carrying it across reads as an error about the wrong thing.
  useEffect(() => setSaid(null), [screen]);

  const item = (id: SettingsScreen, label: string, Icon: typeof User) => (
    <button
      key={id}
      type="button"
      onClick={() => onScreen(id)}
      className={cn(
        'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ink-body text-sm',
        'hover:bg-state-hover hover:text-ink-primary',
        id === screen && 'bg-state-pressed font-semibold text-ink-primary',
      )}
    >
      <Icon className="size-[18px] shrink-0" />
      <span>{label}</span>
    </button>
  );

  const link = (href: string, label: string, Icon: typeof User) => (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-ink-body text-sm hover:bg-state-hover hover:text-ink-primary"
    >
      <Icon className="size-[18px] shrink-0" />
      <span>{label}</span>
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
              className="mt-auto flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-ink-body text-sm hover:bg-state-hover max-sm:mt-0 max-sm:ms-auto max-sm:w-auto"
            >
              <LogOut className="size-[18px] shrink-0 text-fb-red-text" />
              <span>Log out</span>
            </button>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
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

            <div className="min-h-[280px] p-4">
              {screen === 'account' && <MyAccountScreen say={setSaid} />}
              {screen === 'connections' && <ConnectionsScreen say={setSaid} onClose={onClose} />}
              {screen === 'hours' && <HoursScreen />}

              {said && (
                <Typography
                  variant="p"
                  className={cn(
                    'mt-3.5 text-sm',
                    said.kind === 'bad' ? 'text-fb-red-text' : 'text-fb-green',
                  )}
                >
                  {said.text}
                </Typography>
              )}
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
