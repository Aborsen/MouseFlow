/* The four numbers, in the panel.
 *
 * NOT the app's dashboard. That page unrolls every event of every recording to answer "what is worth
 * automating", draws a week of activity and holds an assistant beside it; none of that fits in 400px and
 * none of it is what somebody glances at while working on a page. What they glance at is whether the runs
 * are going through - so that is what is here, and "Open the full dashboard" is one press away.
 */
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { Said, type SaidNote } from '@/components/Said';
import { api, openApp } from './worker';

interface Totals {
  runs: number;
  ok: number;
  failed: number;
  stopped: number;
  recordings: number;
  createdSkills: number;
  agentHours: number;
}
interface Previous { had?: boolean; runs?: number }

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

/* A delta only when there is something to compare with. `had` is sent for exactly this reason - a zero
 * cannot tell "no runs last week" from "no previous week measured", and one of those supports a delta. */
const delta = (now: number, before: Previous | null) => {
  if (!before?.had || !before.runs) return null;
  const change = Math.round(((now - before.runs) / before.runs) * 100);
  return `${change >= 0 ? '+' : ''}${change}% vs previous`;
};

export const DashboardScreen = () => {
  const [totals, setTotals] = useState<Totals | null>(null);
  const [previous, setPrevious] = useState<Previous | null>(null);
  const [note, setNote] = useState<SaidNote | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    setBusy(true);
    try {
      /* The app's own endpoint, read by the names it actually uses - `totals` and `previous`, from
       * api/insights.js. Guessed field names are how a dashboard shows four confident zeroes. */
      const body = await api<{ totals?: Totals; previous?: Previous }>('/api/insights?days=7');
      setTotals(body.totals ?? null);
      setPrevious(body.previous ?? null);
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'Could not read the account.', kind: 'bad' });
    }
  }, []);

  useEffect(() => { void read(); }, [read]);

  const runs = totals?.runs ?? 0;
  const cards = [
    { label: 'runs', value: runs, note: delta(runs, previous) },
    { label: 'agent time', value: totals ? `${totals.agentHours}h` : '—', note: 'wall clock' },
    { label: 'success', value: totals ? `${pct(totals.ok, runs)}%` : '—', note: `${totals?.ok ?? 0} finished` },
    { label: 'failed', value: totals?.failed ?? 0, note: totals?.stopped ? `${totals.stopped} stopped` : null },
    { label: 'recordings', value: totals?.recordings ?? 0, note: null },
    { label: 'skills made', value: totals?.createdSkills ?? 0, note: null },
  ];

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-2">
        <Typography variant="h2" weight="semibold" className="text-[1.05rem]">Dashboard</Typography>
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="xs" onClick={() => void read()} disabled={busy}
                  aria-label="Read it again" leftSlot={<RefreshCw className="size-3.5" />} />
          <Button
            variant="ghost"
            size="xs"
            title="Activity, what is worth automating and what went wrong — opens the app in a tab"
            onClick={() => openApp('/dashboard')}
            leftSlot={<ExternalLink className="size-3.5" />}
          >
            All of it
          </Button>
        </span>
      </header>

      <Typography variant="p" className="text-ink-inactive text-[0.78rem]">
        The last seven days, both halves — this browser and any machine on the account.
      </Typography>

      <div className="grid grid-cols-2 gap-1.5">
        {cards.map(({ label, value, note: hint }) => (
          <div key={label} className="rounded-lg border border-stroke/45 bg-surface-card2 px-2.5 py-2">
            <div className="font-semibold text-[1.15rem] text-ink-primary tabular-nums">{value}</div>
            <div className="text-[0.7rem] text-ink-inactive">{label}</div>
            {hint && <div className="text-[0.66rem] text-ink-inactive/80">{hint}</div>}
          </div>
        ))}
      </div>

      <Said note={note} onDismiss={() => setNote(null)} />
    </div>
  );
};
