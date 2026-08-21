/* What the agent can see right now, before you ask it to do anything.
 *
 * This exists because Create gave no way to tell. You type a goal that will drive your real machine, press
 * send, and the first thing that happens is a model looking at a screenshot you have not seen - so a run that
 * failed because the wrong window was in front looked exactly like a run that failed because the model was
 * confused. Two very different problems, and the fix for the first one is a glance.
 *
 * EVERY FIELD HERE IS MEASURED. No model is called and nothing is inferred:
 *
 *   the picture        GET /shot, asked for small (640px) because it is a thumbnail, not a payload
 *   the active app     GET /windows, the entry with active: true - process name, which is what the model gets
 *   visible windows    the length of that list, minimised ones excluded by the agent
 *   the resolution     GET /health, screen.w x screen.h, in virtual-desktop pixels across all monitors
 *
 * Where the picture goes, said out loud rather than left to be assumed: the agent serves it from 127.0.0.1,
 * so the thumbnail is between the agent and this page. It reaches a model only when a run sends it - which is
 * what "each step sends that picture to the model" on the desktop opener has always meant. Refreshing this
 * panel is not a run and sends nothing anywhere.
 *
 * Polled on demand, never on a timer. A screenshot is the most expensive call the agent has, and a panel that
 * took one every few seconds while somebody typed a sentence would be a webcam nobody asked for.
 */
import { Crosshair, Layers, Monitor, RefreshCw, ScanLine, TriangleAlert } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { type AgentWindow, shot, windows } from '@/lib/agent';
/* `format` from /shot is a full MIME type - "image/jpeg" - so it goes through the helper rather than
 * being prefixed into "image/image/jpeg". Same helper the decision loop uses. */
import { mediaType } from '@/lib/desktop-engine';
import { useAgent } from '@/lib/store';

/* Small on purpose. It is a thumbnail in a 26rem column; asking for the full screen would move a megabyte
 * per refresh to be scaled down by the browser, and /shot takes a width for exactly this reason. */
const THUMB_WIDTH = 640;

interface Seen {
  png: string;
  format: string;
  windows: AgentWindow[];
  at: number;
}

export const LiveContext = ({ port, enabled }: { port: number; enabled: boolean }) => {
  const { health } = useAgent();
  const [seen, setSeen] = useState<Seen | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const look = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      /* Both together. A picture with a window list from four seconds earlier is two facts about two
       * different moments presented as one, which is the sort of thing somebody reasons from and gets
       * wrong. */
      const [picture, open] = await Promise.all([shot(port, THUMB_WIDTH), windows(port)]);
      setSeen({
        png: picture.png,
        format: picture.format || 'jpeg',
        windows: Array.isArray(open.windows) ? open.windows : [],
        at: Date.now(),
      });
    } catch (err) {
      setSeen(null);
      setProblem(err instanceof Error ? err.message : 'the agent did not answer');
    } finally {
      setBusy(false);
    }
  }, [port]);

  /* Once, when the panel becomes usable. Not on a timer - see the note at the top. */
  useEffect(() => {
    if (enabled) void look();
  }, [enabled, look]);

  const active = seen?.windows.find((w) => w.active) ?? null;
  const rows: { icon: ReactNode; label: string; value: string; title?: string }[] = [
    {
      icon: <Monitor className="size-3.5" />,
      label: 'Active app',
      value: active ? (active.process || active.title || 'unnamed') : '—',
      title: active?.title || undefined,
    },
    {
      icon: <Layers className="size-3.5" />,
      label: 'Visible windows',
      value: seen ? String(seen.windows.length) : '—',
      title: seen?.windows.map((w) => w.title).filter(Boolean).slice(0, 8).join('\n') || undefined,
    },
    {
      icon: <ScanLine className="size-3.5" />,
      label: 'Resolution',
      /* Across every monitor, which is what the agent works in and what a coordinate in a run means. */
      value: health?.screen ? `${health.screen.w}×${health.screen.h}` : '—',
      title: 'The whole virtual desktop, across every monitor',
    },
  ];

  return (
    <aside className="flex w-full flex-col rounded-xl border-stroke border bg-surface-card p-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <Typography variant="span" className="text-[0.7rem] uppercase tracking-wide text-ink-inactive">
          Live context
        </Typography>
        <span
          className={cn(
            'ms-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.7rem] font-semibold',
            enabled && seen ? 'bg-fb-green/12 text-fb-green'
              : enabled ? 'bg-state-hover text-ink-secondary'
                : 'bg-state-hover text-ink-inactive',
          )}
        >
          <span className={cn('size-1.5 rounded-full', enabled && seen ? 'bg-fb-green' : 'bg-ink-inactive')} />
          {enabled ? (seen ? 'Available' : busy ? 'Looking…' : 'Not read yet') : 'Agent offline'}
        </span>
      </div>

      <Typography variant="span" weight="semibold" className="mb-1.5 block text-[0.9rem]">
        Current screen
      </Typography>

      {/* A fixed aspect box whatever the state, so the panel does not change height between "looking" and
        * "looked" - the lesson the recorder card just learned. */}
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border-stroke border bg-surface-card2">
        {seen ? (
          <img
            src={`data:${mediaType(seen.format)};base64,${seen.png}`}
            alt="What the agent can see on this machine right now"
            className="size-full object-contain"
          />
        ) : (
          <div className="grid size-full place-items-center px-4 text-center">
            <Typography variant="p" className="text-ink-inactive text-[0.78rem]">
              {problem
                ? problem
                : enabled
                  ? 'Nothing read yet.'
                  : 'The local agent is not answering, so there is nothing to look at. Start it from Connections.'}
            </Typography>
          </div>
        )}
        {busy && (
          <span className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-brand-primary" />
        )}
      </div>

      <dl className="mt-2.5 flex flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2 text-[0.8rem]" title={row.title}>
            <span className="text-ink-inactive">{row.icon}</span>
            <dt className="text-ink-secondary">{row.label}</dt>
            <dd className="ms-auto truncate font-mono text-ink-primary tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-2.5 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          leftSlot={<RefreshCw className="size-3.5" />}
          isLoading={busy}
          disabled={!enabled}
          onClick={() => { void look(); }}
        >
          Look again
        </Button>
        {seen && (
          <span className="text-[0.72rem] text-ink-inactive tabular-nums">
            {new Date(seen.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
      </div>

      {/* Where the picture goes. Said rather than assumed: it is the one question a screenshot in a web page
        * ought to answer before it is asked. */}
      <Typography variant="p" className="mt-2.5 flex gap-1.5 text-ink-inactive text-[0.72rem]">
        <Crosshair className="mt-0.5 size-3 shrink-0" />
        <span>
          Served by the agent on this machine, over 127.0.0.1. It reaches a model only when a run sends it —
          looking here sends nothing anywhere.
        </span>
      </Typography>

      {problem && (
        <Typography variant="p" className="mt-2 flex gap-1.5 text-fb-attention text-[0.74rem]">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          <span>{problem}</span>
        </Typography>
      )}
    </aside>
  );
};
