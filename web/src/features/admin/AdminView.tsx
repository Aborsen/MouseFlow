/* The deployment's own view of itself: who is here, what they hold, and which models do the work.
 *
 * Reached by its address, not by the sidebar - an admin knows where their door is, and a nav item for a
 * page that answers 404 to everyone else is furniture that lies. The SERVER is the gate: this page can be
 * opened by anybody, and for anybody who is not on ADMIN_EMAILS it renders the same not-found state the
 * endpoint returns. Hiding the page would add nothing; the endpoint refusing is what protects the data.
 *
 * Metadata first, content on a click - deliberately. The lists show names, counts and dates at once;
 * somebody's actual recording, chat text or run log is one more explicit click with that thing's id in the
 * request. Operating a product does not require reading over everyone's shoulder by default.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';

/* ---------------------------------------------------------------- the wire */

const get = async <T,>(view: string, params: Record<string, string> = {}): Promise<T> => {
  const q = new URLSearchParams({ view, ...params });
  const res = await fetch(`/api/admin?${q}`, { credentials: 'same-origin' });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body as T;
};

interface Summary { users: number; flows: { n: number; recordings: number; skills: number }; runs: { n: number; week: number }; chats: number; published: number }
interface UserRow {
  id: string; name: string | null; email: string | null; image: string | null;
  created: string | null; verified: boolean | null;
  recordings: number; skills: number; runs: number; chats: number; published: number; devices: number;
  lastRun: string | null;
}
interface Setting { key: string; about: string; value: string | null; choices: string[] }
interface Detail {
  who: UserRow;
  flows: { client_id: string; kind: string; source: string; name: string; events: number; updated_at: string }[];
  runs: { client_id: string; model: string | null; outcome: string; goal: string; started_at: string | null }[];
  chats: { id: string; title: string | null; messages: number; updated_at: string }[];
  devices: { id: string; label: string; created_at: string; last_used_at: string | null }[];
  prefs: { key: string; value: string }[];
}

const when = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : '—';
};

const CARD = 'rounded-xl border border-stroke bg-surface-card';
const TH = 'px-3 py-2 text-left text-[0.72rem] font-semibold uppercase tracking-wide text-ink-inactive';
const TD = 'px-3 py-2 text-[0.85rem] text-ink-body';

/* ---------------------------------------------------------------- content viewer */

const ContentPane = ({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) => (
  <div className={cn(CARD, 'mt-3 p-4')}>
    <div className="mb-2 flex items-center justify-between">
      <Typography variant="h3" weight="semibold" className="text-[0.95rem]">{title}</Typography>
      <Button variant="ghost" size="xs" onClick={onClose}>Close</Button>
    </div>
    <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-page p-3 text-[0.78rem] leading-relaxed">
      {children}
    </pre>
  </div>
);

/* ---------------------------------------------------------------- one user */

const UserPanel = ({ id, onBack }: { id: string; onBack: () => void }) => {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [content, setContent] = useState<{ title: string; text: string } | null>(null);

  useEffect(() => {
    get<Detail>('user', { id }).then(setDetail).catch((e) => setFailed(e.message));
  }, [id]);

  const show = async (title: string, view: string, thingId: string) => {
    try {
      const body = await get<Record<string, unknown>>(view, { user: id, id: thingId });
      setContent({ title, text: JSON.stringify(body.content ?? body.messages ?? body, null, 2) });
    } catch (e) {
      setContent({ title, text: e instanceof Error ? e.message : 'could not load' });
    }
  };

  if (failed) return <Typography variant="p" className="text-fb-red-text">{failed}</Typography>;
  if (!detail) return <Typography variant="p" className="text-ink-inactive">Loading…</Typography>;

  const { who } = detail;
  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>← All users</Button>
        <Typography variant="h2" weight="semibold" className="text-[1.05rem]">
          {who.name ?? who.email ?? who.id}
        </Typography>
        <span className="text-ink-inactive text-[0.82rem]">{who.email}</span>
        {who.verified === false && (
          <span className="rounded bg-toast-bg-error px-1.5 py-0.5 text-[0.7rem] text-fb-red-text">unverified</span>
        )}
        <span className="ms-auto text-ink-inactive text-[0.78rem]">joined {when(who.created)}</span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className={cn(CARD, 'p-3')}>
          <Typography variant="h3" weight="semibold" className="mb-2 text-[0.9rem]">
            Flows · {detail.flows.length}
          </Typography>
          <table className="w-full"><tbody>
            {detail.flows.map((f) => (
              <tr key={f.client_id} className="border-stroke border-t">
                <td className={TD}>{f.name || f.client_id}</td>
                <td className={cn(TD, 'text-ink-inactive')}>{f.kind} · {f.source} · {f.events} events</td>
                <td className={cn(TD, 'text-ink-inactive')}>{when(f.updated_at)}</td>
                <td className={cn(TD, 'text-right')}>
                  <Button variant="ghost" size="xs" onClick={() => void show(`Flow: ${f.name || f.client_id}`, 'flow', f.client_id)}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody></table>
        </div>

        <div className={cn(CARD, 'p-3')}>
          <Typography variant="h3" weight="semibold" className="mb-2 text-[0.9rem]">
            Runs · {detail.runs.length}
          </Typography>
          <table className="w-full"><tbody>
            {detail.runs.map((r) => (
              <tr key={r.client_id} className="border-stroke border-t">
                <td className={cn(TD, 'max-w-[260px] truncate')} title={r.goal}>{r.goal || '—'}</td>
                <td className={cn(TD, 'text-ink-inactive')}>{r.model ?? '—'}</td>
                <td className={cn(TD, r.outcome === 'ok' ? 'text-brand-primary' : 'text-ink-inactive')}>{r.outcome}</td>
                <td className={cn(TD, 'text-ink-inactive')}>{when(r.started_at)}</td>
                <td className={cn(TD, 'text-right')}>
                  <Button variant="ghost" size="xs" onClick={() => void show('Run', 'run', r.client_id)}>Open</Button>
                </td>
              </tr>
            ))}
          </tbody></table>
        </div>

        <div className={cn(CARD, 'p-3')}>
          <Typography variant="h3" weight="semibold" className="mb-2 text-[0.9rem]">
            Chats · {detail.chats.length}
          </Typography>
          <table className="w-full"><tbody>
            {detail.chats.map((c) => (
              <tr key={c.id} className="border-stroke border-t">
                <td className={TD}>{c.title || c.id}</td>
                <td className={cn(TD, 'text-ink-inactive')}>{c.messages} messages</td>
                <td className={cn(TD, 'text-ink-inactive')}>{when(c.updated_at)}</td>
                <td className={cn(TD, 'text-right')}>
                  <Button variant="ghost" size="xs" onClick={() => void show(`Chat: ${c.title ?? c.id}`, 'chat', c.id)}>Open</Button>
                </td>
              </tr>
            ))}
          </tbody></table>
        </div>

        <div className={cn(CARD, 'p-3')}>
          <Typography variant="h3" weight="semibold" className="mb-2 text-[0.9rem]">
            Devices & prefs
          </Typography>
          <table className="w-full"><tbody>
            {detail.devices.map((d) => (
              <tr key={d.id} className="border-stroke border-t">
                <td className={TD}>{d.label || d.id}</td>
                <td className={cn(TD, 'text-ink-inactive')}>made {when(d.created_at)}</td>
                <td className={cn(TD, 'text-ink-inactive')}>used {when(d.last_used_at)}</td>
              </tr>
            ))}
            {detail.prefs.map((p) => (
              <tr key={p.key} className="border-stroke border-t">
                <td className={TD}>{p.key}</td>
                <td className={cn(TD, 'text-ink-inactive')} colSpan={2}>{p.value}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      </div>

      {content && (
        <ContentPane title={content.title} onClose={() => setContent(null)}>{content.text}</ContentPane>
      )}
    </div>
  );
};

/* ---------------------------------------------------------------- the page */

export const AdminView = () => {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [settings, setSettings] = useState<Setting[] | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    get<{ summary: Summary }>('summary').then((b) => setSummary(b.summary)).catch(() => setGone(true));
    get<{ users: UserRow[] }>('users').then((b) => setUsers(b.users)).catch(() => setGone(true));
    get<{ settings: Setting[] }>('settings').then((b) => setSettings(b.settings)).catch(() => setGone(true));
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (key: string, value: string) => {
    setNote(null);
    try {
      const res = await fetch('/api/admin', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
      setNote(value ? `${key} → ${value}. The next run uses it; no deploy needed.` : `${key} cleared - back to the default.`);
      get<{ settings: Setting[] }>('settings').then((b) => setSettings(b.settings)).catch(() => {});
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'could not save');
    }
  };

  /* The endpoint answers 404 to non-admins, and so does this page - the same words a wrong URL gets. */
  if (gone) {
    return (
      <div className="p-8">
        <Typography variant="h2" weight="semibold">Not found</Typography>
      </div>
    );
  }

  return (
    <div className="p-5">
      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            ['Users', summary.users],
            ['Recordings', summary.flows.recordings],
            ['Skills', summary.flows.skills],
            ['Runs · 7d', `${summary.runs.n} · ${summary.runs.week}`],
            ['Chats', summary.chats],
          ].map(([label, n]) => (
            <div key={String(label)} className={cn(CARD, 'p-3')}>
              <div className="text-[0.72rem] text-ink-inactive uppercase tracking-wide">{label}</div>
              <div className="text-[1.3rem] font-semibold text-ink-primary">{n}</div>
            </div>
          ))}
        </div>
      )}

      {settings && (
        <div className={cn(CARD, 'mb-4 p-4')}>
          <Typography variant="h3" weight="semibold" className="mb-1 text-[0.95rem]">Models</Typography>
          <Typography variant="p" className="mb-3 text-ink-inactive text-[0.8rem]">
            What each part of the product thinks with. A change reaches the next run everywhere — the web
            app, the extension, the dashboard assistant — without a deploy.
          </Typography>
          {note && <Typography variant="p" className="mb-2 text-[0.82rem] text-brand-primary">{note}</Typography>}
          <div className="grid gap-3 lg:grid-cols-2">
            {settings.map((s) => (
              <div key={s.key} className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[0.85rem] font-medium text-ink-primary">{s.key}</div>
                  <div className="text-[0.76rem] text-ink-inactive leading-snug">{s.about}</div>
                </div>
                <select
                  className="h-8 rounded-md border border-stroke bg-surface-input px-2 text-[0.82rem] text-ink-primary"
                  value={s.value ?? ''}
                  onChange={(e) => void save(s.key, e.target.value)}
                >
                  <option value="">default</option>
                  {s.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {opened ? (
        <UserPanel id={opened} onBack={() => setOpened(null)} />
      ) : (
        <div className={cn(CARD, 'overflow-x-auto')}>
          <table className="w-full">
            <thead>
              <tr>
                {['User', 'Email', 'Joined', 'Recordings', 'Skills', 'Runs', 'Chats', 'Published', 'Devices', 'Last run', ''].map((h) => (
                  <th key={h} className={TH}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((u) => (
                <tr key={u.id} className="border-stroke border-t hover:bg-state-hover">
                  <td className={TD}>
                    {u.name ?? '—'}
                    {u.verified === false && (
                      <span className="ms-1.5 rounded bg-toast-bg-error px-1 py-0.5 text-[0.65rem] text-fb-red-text">unverified</span>
                    )}
                  </td>
                  <td className={cn(TD, 'text-ink-inactive')}>{u.email ?? '—'}</td>
                  <td className={cn(TD, 'text-ink-inactive')}>{when(u.created)}</td>
                  <td className={TD}>{u.recordings}</td>
                  <td className={TD}>{u.skills}</td>
                  <td className={TD}>{u.runs}</td>
                  <td className={TD}>{u.chats}</td>
                  <td className={TD}>{u.published}</td>
                  <td className={TD}>{u.devices}</td>
                  <td className={cn(TD, 'text-ink-inactive')}>{when(u.lastRun)}</td>
                  <td className={cn(TD, 'text-right')}>
                    <Button variant="ghost" size="xs" onClick={() => setOpened(u.id)}>Open</Button>
                  </td>
                </tr>
              ))}
              {users && !users.length && (
                <tr><td className={TD} colSpan={11}>Nobody yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
