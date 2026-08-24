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
import { ask, openApp } from './worker';

interface Totals { runs?: number; ok?: number; failed?: number; stopped?: number; hours?: number }

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

export const DashboardScreen = () => {
  const [totals, setTotals] = useState<Totals | null>(null);
  const [note, setNote] = useState<SaidNote | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    setBusy(true);
    const res = await ask('app/read', { what: 'insights', days: 7 });
    setBusy(false);
    if (!res.ok) { setNote({ text: res.error ?? 'Could not read the account.', kind: 'bad' }); return; }
    const body = res.body as Record<string, unknown> | undefined;
    /* Read defensively: this is the app's own payload and it is shaped for the app's page. What the panel
     * needs is four numbers, and a shape change there should leave this showing dashes rather than
     * throwing inside a side panel somebody cannot see the console of. */
    const t = (body?.totals ?? body?.runs ?? {}) as Record<string, number>;
    setTotals({
      runs: Number(t.runs ?? t.total ?? 0),
      ok: Number(t.ok ?? 0),
      failed: Number(t.failed ?? 0),
      stopped: Number(t.stopped ?? 0),
      hours: Number((body?.hours as number) ?? 0),
    });
  }, []);

  useEffect(() => { void read(); }, [read]);

  const runs = totals?.runs ?? 0;
  const cards = [
    { label: 'runs', value: runs },
    { label: 'finished', value: totals?.ok ?? 0 },
    { label: 'failed', value: totals?.failed ?? 0 },
    { label: 'success', value: totals ? `${pct(totals.ok ?? 0, runs)}%` : '—' },
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
        {cards.map(({ label, value }) => (
          <div key={label} className="rounded-lg border border-stroke/45 bg-surface-card2 px-2.5 py-2">
            <div className="font-semibold text-[1.15rem] text-ink-primary tabular-nums">{value}</div>
            <div className="text-[0.7rem] text-ink-inactive">{label}</div>
          </div>
        ))}
      </div>

      <Said note={note} onDismiss={() => setNote(null)} />
    </div>
  );
};
