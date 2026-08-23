/* The sidebar, following insightis/apps/web's AppSidebar.
 *
 * Their order, minus their first item. Theirs opens with New Chat because a chat is the only way in; here
 * the way in is Record, which is a place rather than an action, so a sidebar button that starts a recording
 * was a second door to a room that already has one. Record's own button does it, on the page that shows
 * what is being recorded. Below the places: what it is costing you, in hours, and who you are.
 *
 * Every row is RAIL square: one declared size, used by the nav, the collapse toggle and the avatar alike.
 * They each sized themselves before - 34px, 32px, 24px - which is why the collapsed rail looked ragged.
 *
 * Collapsing is remembered - it is a preference about this screen rather than about this visit.
 */
import { Link, useRouterState } from '@tanstack/react-router';
import {
  ChartNoAxesColumn,
  ChevronsUpDown,
  CircleDot,
  FolderOpen,
  LayoutGrid,
  PanelLeft,
  Sparkles,
  Users,
  Wallet,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@insightis/ui/Badge';
import { cn } from '@insightis/ui/cn';
import { Typography } from '@insightis/ui/Typography';
import { hoursOf } from '@/lib/api';
import { useAccount } from '@/shell/AccountProvider';

const TIGHT = 'mouseflow.side.tight';

const NAV = [
  { to: '/record', label: 'Record', icon: CircleDot },
  /* Beta on Create alone: of the five things this product does, it is the one that acts on a real machine
   * from a model's decisions, so it is the one that can be wrong in a way that costs something. Saying so is
   * more use than a uniform confidence nobody believes. */
  { to: '/create', label: 'Create', icon: Sparkles, beta: true },
  { to: '/skills', label: 'Skills', icon: FolderOpen },
  { to: '/gallery', label: 'Gallery', icon: LayoutGrid },
  // Asking about the numbers happens on the page that shows them, not at its own address.
  { to: '/dashboard', label: 'Dashboard', icon: ChartNoAxesColumn },
  /* Last, and a place rather than a setting. It was the fourth pane of the settings dialog, which was the
   * right size for a roster you fill in once and the wrong one for what it now is: several teams, people
   * being added and moved, invitations to chase, and a dashboard scoped to each. A dialog also cannot be
   * linked to, and "open Teams" is what an invitation email has to be able to say. */
  { to: '/team', label: 'Teams', icon: Users },
] as const;

/* One row height, one glyph box, one gap - so a lucide glyph that draws lighter than its neighbours still
 * occupies the same square, and the collapsed rail is a column of identical buttons rather than a stack of
 * whatever each element happened to measure. */
const ROW = 'flex h-9 items-center gap-2.5 rounded-md';
const SQUARE = 'grid size-9 shrink-0 place-items-center rounded-md';
const GLYPH = 'size-[18px] shrink-0';

interface Props {
  onOpenSettings: (screen?: 'account' | 'connections' | 'hours') => void;
}

export const AppSidebar = ({ onOpenSettings }: Props) => {
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
      <div className={cn('mb-1 flex items-center gap-1 pb-1', tight ? 'justify-center' : 'ps-2.5')}>
        {/* gap-2.5, the nav's gap: at gap-2 the wordmark started two pixels left of every label below it. */}
        <Link to="/record" className="flex min-w-0 items-center gap-2.5 text-ink-primary" title="MouseFlow">
          <svg viewBox="0 0 24 24" aria-hidden className={cn(GLYPH, 'text-logo-mark')}>
            {/* Centred on 12,12. It used to span y 3..19 in a 24 box - a whole unit high - which is
                invisible on its own and obvious in the extension's rail beside four centred glyphs. */}
            <path d="M5 4l14 8-6 1.6L10.5 20z" fill="currentColor" />
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
            className={cn(SQUARE, 'ms-auto text-ink-inactive hover:bg-state-hover hover:text-ink-primary')}
          >
            <PanelLeft className={GLYPH} />
          </button>
        )}
      </div>

      {tight && (
        <button
          type="button"
          onClick={() => toggle(false)}
          title="Show the sidebar"
          aria-label="Show the sidebar"
          className={cn(SQUARE, 'mb-0.5 text-ink-inactive hover:bg-state-hover hover:text-ink-primary')}
        >
          <PanelLeft className={GLYPH} />
        </button>
      )}

      <nav className={cn('flex shrink-0 flex-col gap-0.5', tight && 'items-center')}>
        {NAV.map((row) => {
          const { to, label, icon: Icon } = row;
          const on = path.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
              title={label}
              /* What the first-run tour points at. TanStack's Link spreads what it does not consume onto
               * the anchor, so this needs no wrapper element. */
              data-tour={to}
              className={cn(
                ROW,
                'text-[0.92rem] text-ink-body hover:bg-state-hover hover:text-ink-primary',
                on && 'bg-state-pressed font-semibold text-ink-primary',
                tight ? 'w-9 justify-center' : 'w-full px-2.5',
              )}
            >
              <Icon className={cn(GLYPH, on && 'text-brand-primary')} />
              {!tight && (
                <>
                  <span className="truncate">{label}</span>
                  {'beta' in row && row.beta && (
                    <Badge variant="attention" size="xs" rounded="full" className="ms-auto shrink-0">
                      Beta
                    </Badge>
                  )}
                </>
              )}
            </Link>
          );
        })}
      </nav>

      <div className={cn(
        'mt-auto flex w-full flex-col gap-0.5 border-stroke border-t pt-2',
        // Collapsed, the account square has to sit in the same column as the nav's; the footer is what
        // decides that, and left to itself it aligned the square to the left edge instead.
        tight && 'items-center',
      )}>
        {/* Their balance row, in hours. Clicking it opens the screen it summarises, as theirs does. */}
        {!tight && account && (
          <button
            type="button"
            onClick={() => onOpenSettings('hours')}
            title="Hours these runs took — wall clock, not time saved"
            className={cn(ROW, 'w-full justify-between px-2.5 hover:bg-state-hover')}
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
            title="Your account, connections and hours"
            className={cn(
              ROW,
              'text-left hover:bg-state-hover',
              tight ? 'w-9 justify-center' : 'w-full px-2.5',
            )}
          >
            {/* 18px, like every other glyph in this column: at 22 it sat two pixels wide of them expanded
                and pushed its own label four pixels past the nav's. */}
            <span className="grid size-[18px] shrink-0 place-items-center on-accent rounded-full bg-brand-tertiary font-semibold text-[0.625rem]">
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
