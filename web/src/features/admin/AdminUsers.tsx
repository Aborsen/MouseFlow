/* Everyone, and what they hold. Searchable, because the list is the thing an admin opens most.
 *
 * Driven off the auth service's user table rather than off the app's own rows: a list built from content
 * only shows the people who made some, and the ones who signed up and never came back are exactly the
 * ones worth noticing.
 */
import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { CARD, NotFound, ROW, TD, TH, Tag, useAdmin, when } from './shell';

export interface UserRow {
  id: string;
  name: string | null;
  email: string | null;
  created: string | null;
  verified: boolean | null;
  role: string | null;
  banned: boolean | null;
  banReason: string | null;
  recordings: number;
  skills: number;
  runs: number;
  chats: number;
  published: number;
  devices: number;
  lastRun: string | null;
}

const COLS = ['User', 'Role', 'Joined', 'Rec.', 'Skills', 'Runs', 'Chats', 'Pub.', 'Devices', 'Last run'];

export const AdminUsers = () => {
  const { data, failed, refused } = useAdmin<{ users: UserRow[] }>('users');
  const [term, setTerm] = useState('');

  const rows = useMemo(() => {
    const needle = term.trim().toLowerCase();
    const all = data?.users ?? [];
    if (!needle) return all;
    return all.filter((u) => `${u.name ?? ''} ${u.email ?? ''}`.toLowerCase().includes(needle));
  }, [data, term]);

  if (refused) return <NotFound />;
  if (failed) {
    return <Typography variant="p" className="text-fb-red-text text-[0.88rem]">{failed}</Typography>;
  }

  return (
    <div className="grid gap-3">
      <div className="relative max-w-[420px]">
        <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-ink-inactive" />
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search by name or email…"
          className="h-10 w-full rounded-lg border border-stroke bg-surface-input ps-9 pe-3 text-[0.88rem] text-ink-primary placeholder:text-ink-inactive focus:border-brand-primary focus:outline-none"
        />
      </div>

      <div className={cn(CARD, 'overflow-x-auto')}>
        <table className="w-full min-w-[880px]">
          <thead>
            <tr>
              {COLS.map((h) => (
                <th key={h} className={cn(TH, h !== 'User' && h !== 'Role' && 'text-right')}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className={ROW}>
                <td className={TD}>
                  <Link to="/admin/users/$id" params={{ id: u.id }} className="group block">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-ink-primary group-hover:underline">
                        {u.name || '—'}
                      </span>
                      {u.verified === false && <Tag tone="bad">unverified</Tag>}
                    </div>
                    <div className="text-[0.78rem] text-ink-inactive">{u.email ?? '—'}</div>
                  </Link>
                </td>
                <td className={TD}>
                  {u.banned
                    ? <Tag tone="bad" title={u.banReason ?? undefined}>banned</Tag>
                    : <span className="text-ink-inactive text-[0.82rem]">{u.role || 'user'}</span>}
                </td>
                <td className={cn(TD, 'text-right text-ink-inactive')}>{when(u.created)}</td>
                <td className={cn(TD, 'text-right')}>{u.recordings}</td>
                <td className={cn(TD, 'text-right')}>{u.skills}</td>
                <td className={cn(TD, 'text-right')}>{u.runs}</td>
                <td className={cn(TD, 'text-right')}>{u.chats}</td>
                <td className={cn(TD, 'text-right')}>{u.published}</td>
                <td className={cn(TD, 'text-right')}>{u.devices}</td>
                <td className={cn(TD, 'text-right text-ink-inactive')}>{when(u.lastRun)}</td>
              </tr>
            ))}
            {data && !rows.length && (
              <tr>
                <td className={cn(TD, 'text-ink-inactive')} colSpan={COLS.length}>
                  {term ? 'Nobody matches that.' : 'Nobody yet.'}
                </td>
              </tr>
            )}
            {!data && (
              <tr><td className={cn(TD, 'text-ink-inactive')} colSpan={COLS.length}>Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {data && (
        <Typography variant="p" className="text-ink-inactive text-[0.78rem]">
          {rows.length} of {data.users.length} shown. Newest activity first.
        </Typography>
      )}
    </div>
  );
};
