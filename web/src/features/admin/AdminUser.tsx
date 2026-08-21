/* One person's screen: what they hold, and — on a click — what is in it.
 *
 * Metadata renders at once; the CONTENT of a recording, a run or a chat is its own request with that
 * thing's id in it. Not theatre: it is the difference between operating a product and reading over
 * everyone's shoulder by default, and it keeps this screen fast when somebody has four hundred runs.
 */
import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { CARD, NotFound, ROW, TD, Tag, adminGet, useAdmin, when } from './shell';
import type { UserRow } from './AdminUsers';

interface Detail {
  who: UserRow;
  flows: { client_id: string; kind: string; source: string; name: string; events: number; updated_at: string }[];
  runs: { client_id: string; model: string | null; outcome: string; goal: string; started_at: string | null }[];
  chats: { id: string; title: string | null; messages: number; updated_at: string }[];
  devices: { id: string; label: string; created_at: string; last_used_at: string | null }[];
  prefs: { key: string; value: string }[];
}

const Panel = ({ title, count, children }: { title: string; count: number; children: React.ReactNode }) => (
  <div className={cn(CARD, 'overflow-hidden')}>
    <div className="flex items-baseline gap-2 border-stroke border-b px-3.5 py-2.5">
      <Typography variant="h3" weight="semibold" className="text-[0.9rem]">{title}</Typography>
      <span className="text-[0.78rem] text-ink-inactive">{count}</span>
    </div>
    {count ? (
      <div className="max-h-[340px] overflow-auto"><table className="w-full">{children}</table></div>
    ) : (
      <div className="px-3.5 py-3 text-[0.82rem] text-ink-inactive">Nothing here.</div>
    )}
  </div>
);

export const AdminUser = () => {
  const { id } = useParams({ from: '/admin/users/$id' });
  const { data, failed, refused } = useAdmin<Detail>('user', { id });
  const [shown, setShown] = useState<{ title: string; text: string } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  const open = async (title: string, view: string, thingId: string) => {
    setLoading(thingId);
    try {
      const body = await adminGet<Record<string, unknown>>(view, { user: id, id: thingId });
      setShown({ title, text: JSON.stringify(body.content ?? body.messages ?? body, null, 2) });
    } catch (e) {
      setShown({ title, text: e instanceof Error ? e.message : 'could not load' });
    } finally {
      setLoading(null);
    }
  };

  if (refused) return <NotFound />;
  if (failed) {
    return <Typography variant="p" className="text-fb-red-text text-[0.88rem]">{failed}</Typography>;
  }
  if (!data) return <Typography variant="p" className="text-ink-inactive">Loading…</Typography>;

  const { who } = data;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Link
          to="/admin/users"
          className="flex items-center gap-1.5 text-[0.85rem] text-ink-inactive hover:text-ink-primary"
        >
          <ArrowLeft className="size-4" /> All users
        </Link>
        <Typography variant="h2" weight="semibold" className="text-[1.05rem]">
          {who.name || who.email || who.id}
        </Typography>
        <span className="text-[0.84rem] text-ink-inactive">{who.email}</span>
        {who.verified === false && <Tag tone="bad">unverified</Tag>}
        {who.banned && <Tag tone="bad" title={who.banReason ?? undefined}>banned</Tag>}
        {who.role && who.role !== 'user' && <Tag tone="quiet">{who.role}</Tag>}
        <span className="ms-auto text-[0.78rem] text-ink-inactive">joined {when(who.created, true)}</span>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Recordings and skills" count={data.flows.length}>
          <tbody>
            {data.flows.map((f) => (
              <tr key={f.client_id} className={ROW}>
                <td className={TD}>
                  <div className="text-ink-primary">{f.name || f.client_id}</div>
                  <div className="text-[0.76rem] text-ink-inactive">
                    {f.kind} · {f.source} · {f.events} events
                  </div>
                </td>
                <td className={cn(TD, 'whitespace-nowrap text-right text-ink-inactive')}>{when(f.updated_at)}</td>
                <td className={cn(TD, 'text-right')}>
                  <Button
                    variant="ghost" size="xs" isLoading={loading === f.client_id}
                    onClick={() => void open(f.name || 'Recording', 'flow', f.client_id)}
                  >
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Panel>

        <Panel title="Runs" count={data.runs.length}>
          <tbody>
            {data.runs.map((r) => (
              <tr key={r.client_id} className={ROW}>
                <td className={TD}>
                  <div className="max-w-[280px] truncate text-ink-primary" title={r.goal}>{r.goal || '—'}</div>
                  <div className="text-[0.76rem] text-ink-inactive">{r.model ?? 'model not recorded'}</div>
                </td>
                <td className={cn(TD, 'text-right')}>
                  {r.outcome === 'ok'
                    ? <Tag tone="good">ok</Tag>
                    : <Tag tone={r.outcome === 'failed' ? 'bad' : 'quiet'}>{r.outcome}</Tag>}
                </td>
                <td className={cn(TD, 'whitespace-nowrap text-right text-ink-inactive')}>{when(r.started_at)}</td>
                <td className={cn(TD, 'text-right')}>
                  <Button
                    variant="ghost" size="xs" isLoading={loading === r.client_id}
                    onClick={() => void open('Run', 'run', r.client_id)}
                  >
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Panel>

        <Panel title="Chats" count={data.chats.length}>
          <tbody>
            {data.chats.map((c) => (
              <tr key={c.id} className={ROW}>
                <td className={TD}>
                  <div className="max-w-[300px] truncate text-ink-primary">{c.title || c.id}</div>
                  <div className="text-[0.76rem] text-ink-inactive">{c.messages} messages</div>
                </td>
                <td className={cn(TD, 'whitespace-nowrap text-right text-ink-inactive')}>{when(c.updated_at)}</td>
                <td className={cn(TD, 'text-right')}>
                  <Button
                    variant="ghost" size="xs" isLoading={loading === c.id}
                    onClick={() => void open(c.title || 'Chat', 'chat', c.id)}
                  >
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Panel>

        <Panel title="Devices and preferences" count={data.devices.length + data.prefs.length}>
          <tbody>
            {data.devices.map((d) => (
              <tr key={d.id} className={ROW}>
                <td className={TD}>{d.label || d.id}</td>
                <td className={cn(TD, 'text-right text-ink-inactive')}>made {when(d.created_at)}</td>
                <td className={cn(TD, 'text-right text-ink-inactive')}>used {when(d.last_used_at)}</td>
              </tr>
            ))}
            {data.prefs.map((p) => (
              <tr key={p.key} className={ROW}>
                <td className={TD}>{p.key}</td>
                <td className={cn(TD, 'text-right text-ink-inactive')} colSpan={2}>{p.value}</td>
              </tr>
            ))}
          </tbody>
        </Panel>
      </div>

      {shown && (
        <div className={cn(CARD, 'overflow-hidden')}>
          <div className="flex items-center justify-between border-stroke border-b px-3.5 py-2.5">
            <Typography variant="h3" weight="semibold" className="text-[0.9rem]">{shown.title}</Typography>
            <Button variant="ghost" size="xs" onClick={() => setShown(null)}>Close</Button>
          </div>
          <pre className="max-h-[460px] overflow-auto whitespace-pre-wrap p-3.5 text-[0.78rem] leading-relaxed text-ink-body">
            {shown.text}
          </pre>
        </div>
      )}
    </div>
  );
};
