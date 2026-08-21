/* The admin's own shell: the app's furniture, a different building.
 *
 * Same sidebar shape, same header, same tokens as the product - because an admin who has to learn a second
 * interface to run the first one has been given two problems. What it is NOT is a screen inside the app:
 * the product's sidebar leads to Record and Gallery, which is not where somebody goes to answer "how many
 * people signed up this week". So it borrows the frame and states plainly, in the header, that this is the
 * back office.
 *
 * The pieces live here rather than in each screen so the screens are only their own content, and so the
 * one thing every screen needs - a fetch that says "not found" the same way the endpoint does - is written
 * once.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { ChartNoAxesColumn, Cpu, Users, ArrowLeft } from 'lucide-react';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';

/* ---------------------------------------------------------------- the wire */

/** Thrown when the endpoint refuses. Carried so a screen can render the not-found state rather than a
 *  message about a status code. */
export class Refused extends Error {}

export async function adminGet<T>(view: string, params: Record<string, string> = {}): Promise<T> {
  const q = new URLSearchParams({ view, ...params });
  const res = await fetch(`/api/admin?${q}`, { credentials: 'same-origin' });
  const body = await res.json().catch(() => null);
  if (res.status === 404) throw new Refused('not found');
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body as T;
}

export async function adminPatch(key: string, value: string): Promise<void> {
  const res = await fetch('/api/admin', {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
}

/** One place that turns a load into the three states a screen can be in. */
export function useAdmin<T>(view: string, params: Record<string, string> = {}) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const key = JSON.stringify([view, params]);
  useEffect(() => {
    let gone = false;
    adminGet<T>(view, params)
      .then((b) => { if (!gone) setData(b); })
      .catch((e) => {
        if (gone) return;
        if (e instanceof Refused) setRefused(true);
        else setFailed(e instanceof Error ? e.message : 'could not load');
      });
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { data, failed, refused, setData };
}

/* ---------------------------------------------------------------- shared bits */

export const CARD = 'rounded-xl border border-stroke bg-surface-card';
export const TH = 'px-3 py-2 text-left font-semibold text-[0.72rem] text-ink-inactive uppercase tracking-wide';
export const TD = 'px-3 py-2.5 text-[0.85rem] text-ink-body';
export const ROW = 'border-stroke border-t hover:bg-state-hover';

export const when = (iso: string | null | undefined, withYear = false) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const two = (n: number) => String(n).padStart(2, '0');
  const date = `${two(d.getDate())}.${two(d.getMonth() + 1)}${withYear ? `.${d.getFullYear()}` : ''}`;
  return `${date} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

export const Tag = ({ tone, children, title }: { tone: 'bad' | 'quiet' | 'good'; children: ReactNode; title?: string }) => (
  <span
    title={title}
    className={cn(
      'rounded px-1.5 py-0.5 text-[0.7rem] leading-none',
      tone === 'bad' && 'bg-toast-bg-error text-fb-red-text',
      tone === 'quiet' && 'bg-state-pressed text-ink-body',
      tone === 'good' && 'bg-brand-primary/15 text-brand-primary',
    )}
  >
    {children}
  </span>
);

/** The counter tiles every overview wants. */
export const Stat = ({ label, value, note }: { label: string; value: ReactNode; note?: string }) => (
  <div className={cn(CARD, 'p-3.5')}>
    <div className="text-[0.72rem] text-ink-inactive uppercase tracking-wide">{label}</div>
    <div className="mt-0.5 font-semibold text-[1.4rem] text-ink-primary leading-tight">{value}</div>
    {note && <div className="text-[0.74rem] text-ink-inactive">{note}</div>}
  </div>
);

/** What a screen shows when the endpoint says no - the same words a wrong address gets. */
export const NotFound = () => (
  <div className="grid min-h-[60vh] place-items-center">
    <div className="text-center">
      <Typography variant="h2" weight="semibold" className="text-[1.1rem]">Not found</Typography>
      <Typography variant="p" className="mt-1 text-ink-inactive text-[0.85rem]">
        This page belongs to whoever runs the deployment.
      </Typography>
    </div>
  </div>
);

/* ---------------------------------------------------------------- the frame */

const NAV = [
  { to: '/admin', label: 'Overview', icon: ChartNoAxesColumn, exact: true },
  { to: '/admin/users', label: 'Users', icon: Users, exact: false },
  { to: '/admin/models', label: 'Models', icon: Cpu, exact: false },
] as const;

const TITLES: Record<string, string> = {
  '/admin': 'Overview',
  '/admin/users': 'Users',
  '/admin/models': 'Models',
};

export const AdminShell = () => {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const title = TITLES[path] ?? (path.startsWith('/admin/users/') ? 'User' : 'Admin');

  return (
    <div className="flex min-h-screen items-stretch bg-surface-page">
      <aside className="sticky top-0 flex h-screen w-[214px] shrink-0 flex-col self-start border-stroke border-e px-3 py-3">
        <div className="mb-3 flex items-center gap-2 px-1.5">
          <span className="text-brand-primary">▸</span>
          <Typography variant="h2" weight="semibold" className="text-[0.95rem]">MouseFlow</Typography>
          <Tag tone="quiet">admin</Tag>
        </div>

        <nav className="flex shrink-0 flex-col gap-0.5">
          {NAV.map(({ to, label, icon: Icon, exact }) => {
            const on = exact ? path === to : path.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-[0.92rem]',
                  'text-ink-body transition-colors duration-base hover:bg-state-hover hover:text-ink-primary',
                  on && 'bg-state-pressed font-semibold text-ink-primary',
                )}
              >
                <Icon className={cn('size-[18px] shrink-0', on && 'text-brand-primary')} />
                <span className="truncate">{label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Out of the back office and into the product - the trip an admin makes constantly. */}
        <div className="mt-auto border-stroke border-t pt-2">
          <Link
            to="/record"
            className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-[0.88rem] text-ink-inactive transition-colors duration-base hover:bg-state-hover hover:text-ink-primary"
          >
            <ArrowLeft className="size-[18px] shrink-0" />
            <span className="truncate">Back to the app</span>
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-stroke border-b bg-surface-page/85 px-5 py-3 backdrop-blur">
          <Typography variant="h1" weight="semibold" className="text-[0.98rem]">{title}</Typography>
          <span className="ms-auto text-[0.78rem] text-ink-inactive">
            everyone’s data — handle accordingly
          </span>
        </header>

        <main className="min-w-0 flex-1 p-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
