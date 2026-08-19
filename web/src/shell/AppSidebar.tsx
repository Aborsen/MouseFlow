/* The sidebar, following insightis/apps/web's AppSidebar.
 *
 * Their order, and for their reasons: the thing you came to do at the top, then the places you go, then
 * what it is costing you, then who you are. Theirs starts a chat and counts credits; this starts a
 * recording and counts hours, because a tool that does work for you is measured in time.
 *
 * Collapsing is remembered - it is a preference about this screen rather than about this visit.
 */
import { Link, useRouterState } from '@tanstack/react-router';
import {
  ChevronsUpDown,
  CirclePlus,
  Circle,
  FolderOpen,
  LayoutGrid,
  PanelLeft,
  Sparkles,
  Wallet,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/ui/lib/utils';
import { Typography } from '@/ui/components/Typography';
import { hoursOf } from '@/lib/api';
import { useAccount } from '@/shell/AccountProvider';

const TIGHT = 'mouseflow.side.tight';

const NAV = [
  { to: '/record', label: 'Record', icon: Circle },
  { to: '/create', label: 'Create', icon: Sparkles },
  { to: '/skills', label: 'Skills', icon: FolderOpen },
  { to: '/gallery', label: 'Gallery', icon: LayoutGrid },
] as const;

interface Props {
  onNewRecording: () => void;
  onOpenSettings: (screen?: 'account' | 'connections' | 'hours') => void;
}

export const AppSidebar = ({ onNewRecording, onOpenSettings }: Props) => {
  const [tight, setTight] = useState(() => {
    try {
      return localStorage.getItem(TIGHT) === '1';
    } catch (_) {
      return false;
    }
  });
  const { account, runs } = useAccount();
  const path = useRouterState({ select: (s) => s.location.pathname });

  const toggle = useCallback((next: boolean) => {
    setTight(next);
    try {
      localStorage.setItem(TIGHT, next ? '1' : '0');
    } catch (_) { /* private mode */ }
  }, []);

  // Below this a 236px sidebar and a two-column view do not fit at once; the rail is the honest answer.
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 820px)');
    const apply = () => { if (narrow.matches) setTight(true); };
    apply();
    narrow.addEventListener('change', apply);
    return () => narrow.removeEventListener('change', apply);
  }, []);

  const hours = runs.reduce((sum, run) => sum + hoursOf(run), 0);
  const name = account?.name ?? account?.email ?? 'Signed in';
  const initial = (name.trim()[0] ?? '?').toUpperCase();

  return (
    <aside
      data-tight={tight ? 'true' : 'false'}
      className={cn(
        'sticky top-0 z-30 flex h-screen shrink-0 flex-col self-start',
        'border-stroke border-r bg-surface-card2 transition-[width] duration-150',
        tight ? 'w-14 items-center px-2 py-3' : 'w-[236px] px-2.5 py-3',
      )}
    >
      <div className={cn('flex items-center gap-2 px-1 pb-2', tight && 'justify-center px-0')}>
        <Link to="/record" className="flex min-w-0 items-center gap-2 p-0.5 text-ink-primary">
          <svg viewBox="0 0 24 24" aria-hidden className="size-5 shrink-0 text-logo-mark">
            <path d="M5 3l14 8-6 1.6L10.5 19z" fill="currentColor" />
          </svg>
          {!tight && (
            <Typography variant="span" weight="semibold" className="truncate">
              MouseFlow
            </Typography>
          )}
        </Link>

        {!tight && (
          <button
            type="button"
            onClick={() => toggle(true)}
            title="Collapse the sidebar"
            aria-label="Collapse the sidebar"
            className="ms-auto grid size-7 place-items-center rounded-md text-ink-inactive hover:bg-state-hover hover:text-ink-primary"
          >
            <PanelLeft className="size-4" />
          </button>
        )}
      </div>

      {tight && (
        <button
          type="button"
          onClick={() => toggle(false)}
          title="Show the sidebar"
          aria-label="Show the sidebar"
          className="mb-1 grid size-8 place-items-center rounded-md text-ink-inactive hover:bg-state-hover hover:text-ink-primary"
        >
          <PanelLeft className="size-4" />
        </button>
      )}

      <nav className={cn('flex shrink-0 flex-col gap-0.5', tight && 'items-center')}>
        {/* Where their New Chat sits, and it does the thing rather than navigating to where the thing is. */}
        <button
          type="button"
          onClick={onNewRecording}
          title="Start a new recording"
          className={cn(
            'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left font-semibold text-ink-primary',
            'hover:bg-state-hover',
            tight && 'w-auto justify-center px-2',
          )}
        >
          <CirclePlus className="size-[18px] shrink-0 text-brand-primary" />
          {!tight && <span className="truncate text-[0.92rem]">New recording</span>}
        </button>

        {NAV.map(({ to, label, icon: Icon }) => {
          const on = path.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
              title={label}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-[0.92rem] text-ink-body',
                'hover:bg-state-hover hover:text-ink-primary',
                on && 'bg-state-pressed font-semibold text-ink-primary',
                tight && 'w-auto justify-center px-2',
              )}
            >
              <Icon className={cn('size-[18px] shrink-0', on && 'text-brand-primary')} />
              {!tight && <span className="truncate">{label}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto w-full border-stroke border-t pt-2">
        {/* Their balance row, in hours. Clicking it opens the screen it summarises, as theirs does. */}
        {!tight && account && (
          <button
            type="button"
            onClick={() => onOpenSettings('hours')}
            title="Hours of work these flows have run"
            className="mb-0.5 flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-state-hover"
          >
            <span className="font-medium text-[0.688rem] text-ink-secondary">Hours</span>
            <span className="flex items-center gap-1.5 text-[0.688rem] text-ink-primary tabular-nums">
              <Wallet className="size-4 shrink-0 rounded-full bg-state-hover p-[0.1875rem]" />
              {hours >= 10 ? hours.toFixed(0) : hours.toFixed(1)} h
            </span>
          </button>
        )}

        {account && (
          <button
            type="button"
            onClick={() => onOpenSettings('account')}
            className={cn(
              'flex w-full items-center gap-2 rounded-md p-1 text-left hover:bg-state-hover',
              tight && 'justify-center',
            )}
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-tertiary font-semibold text-[0.6875rem] text-white">
              {initial}
            </span>
            {!tight && (
              <>
                <span className="flex min-w-0 flex-1 flex-col gap-px overflow-hidden leading-[1.15]">
                  <strong className="truncate font-semibold text-[0.84rem] text-ink-primary">{name}</strong>
                  <span className="truncate text-[0.72rem] text-ink-secondary">{account.email}</span>
                </span>
                <ChevronsUpDown className="ms-auto size-4 shrink-0 text-ink-inactive" />
              </>
            )}
          </button>
        )}
      </div>
    </aside>
  );
};
