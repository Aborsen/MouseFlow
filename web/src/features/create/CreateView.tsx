/* Create the flow: describe what you want, and one of the two halves does it.
 *
 *   In this browser   the extension drives a tab. It aims at page ELEMENTS - it reads the accessibility
 *                     tree - so it clicks "the Send button" rather than a position and survives the page
 *                     moving underneath it. It cannot leave the browser. Default, for that reason.
 *   On this computer  the local agent drives the whole desktop from a picture of the screen, so it reaches
 *                     Excel, Explorer, a native dialog. The decision loop lives here; see desktop-engine.
 */
import { useNavigate } from '@tanstack/react-router';
import { Play, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { AGENT_WANTS } from '@/lib/agent';
import { askExtension, watchBridge } from '@/lib/bridge';
import { push } from '@/lib/api';
import { MAX_WAVES, type RunEvent, WAVE_TURNS, runOnDesktop } from '@/lib/desktop-engine';
import { useAgent, useConsole } from '@/lib/store';
import { useAccount } from '@/shell/AccountProvider';

type Target = 'browser' | 'desktop';
const KEY = 'mouseflow.create.target';

interface ExtensionStatus {
  ok?: boolean;
  signedOut?: boolean;
  running?: boolean;
  log?: { type: string; name?: string; text?: string; message?: string }[];
  steps?: { host?: string }[];
  result?: { ok: boolean; summary?: string; said?: string; error?: string };
  error?: string;
  version?: string;
}

/** What a step actually did, not just which verb it used - afterwards is when somebody is working out
 *  where a run went wrong. */
function describe(event: RunEvent): string {
  const input = (event.input ?? {}) as Record<string, any>;
  const at = Number.isFinite(input.x) && Number.isFinite(input.y) ? ` at ${input.x},${input.y}` : '';
  switch (event.name) {
    case 'click':
      return `${input.double ? 'double-click' : input.button === 'right' ? 'right-click' : 'click'}${at}`;
    case 'scroll':
      return `scroll ${Number(input.amount) < 0 ? 'down' : 'up'}${at}`;
    case 'type_text': {
      const text = String(input.text ?? '');
      const lines = text.split('\n').length;
      const shown = text.replace(/\n/g, ' ⏎ ');
      return `type "${shown.length > 60 ? `${shown.slice(0, 60)}…` : shown}"${lines > 1 ? ` (${lines} lines)` : ''}`;
    }
    case 'press_key': {
      const mods = [input.ctrl && 'Ctrl', input.shift && 'Shift', input.alt && 'Alt'].filter(Boolean);
      return `press ${[...mods, input.key ?? '?'].join('+')}`;
    }
    case 'activate_window':
      return `switch to ${input.title ?? input.process ?? 'a window'}`;
    case 'wait':
      return 'wait for the screen to settle';
    default:
      return event.name ?? 'step';
  }
}

export const CreateView = () => {
  const [state] = useConsole();
  const { health, stale } = useAgent();
  const { reload } = useAccount();
  const navigate = useNavigate();

  const [target, setTarget] = useState<Target>(() => {
    try { return localStorage.getItem(KEY) === 'desktop' ? 'desktop' : 'browser'; } catch (_) { return 'browser'; }
  });
  const [goal, setGoal] = useState('');
  const [feed, setFeed] = useState<RunEvent[]>([]);
  const [note, setNote] = useState<{ text: string; kind?: 'good' | 'bad' } | null>(null);
  const [blocked, setBlocked] = useState<string | null>('Looking for what can carry this out…');
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [extension, setExtension] = useState<{ present: boolean; version: string | null }>({ present: false, version: null });

  const abort = useRef(false);
  const feedEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { localStorage.setItem(KEY, target); } catch (_) { /* private mode */ }
  }, [target]);

  useEffect(() => watchBridge((bridge) => setExtension({ present: bridge.present, version: bridge.version })), []);

  useEffect(() => { feedEnd.current?.scrollIntoView({ block: 'nearest' }); }, [feed]);

  /* Can the chosen engine be reached? Each is absent in its own way and each needs a different sentence -
   * "it did not work" would leave the user nowhere to go. Re-checked when the tab regains focus, which is
   * exactly when somebody comes back from starting the agent. */
  const check = useCallback(async () => {
    if (target === 'desktop') {
      if (!health) {
        setBlocked('No local agent is answering. Open Connections for the command that starts it — it is ' +
          'the half that can act outside the browser.');
        return;
      }
      if (health.canSee === false) {
        setBlocked(`The agent answering is version ${health.version}, which has no /shot or /do — the eyes ` +
          `and hands this needs. Connections has the command that starts ${AGENT_WANTS}.`);
        return;
      }
      setBlocked(null);
      return;
    }
    const ping = await askExtension<ExtensionStatus>('ping');
    setBlocked(ping
      ? null
      : 'This needs the MouseFlow extension, in this browser. Install it and reload this tab, or switch to ' +
        'On this computer and use the local agent instead.');
  }, [target, health]);

  useEffect(() => { void check(); }, [check]);

  useEffect(() => {
    const onVisible = () => { if (!document.hidden && !running) void check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [check, running]);

  /* A browser run belongs to the extension's worker, which outlives this tab - so its state is polled
   * rather than held here. A desktop run is driven from this page, so this page owns it. */
  const pollExtension = useCallback(async () => {
    const status = await askExtension<ExtensionStatus>('page/status');
    if (!status) { setNote({ text: 'The extension stopped answering. Reload this tab.', kind: 'bad' }); return false; }
    if (status.signedOut) {
      setBlocked('The extension is installed but not signed in. Open it and press Continue with Google.');
      return false;
    }
    setFeed((status.log ?? []).map((e) => ({
      type: e.type as RunEvent['type'], name: e.name, text: e.text, message: e.message,
    })));
    setRunning(!!status.running);
    if (!status.running && status.result) {
      setNote(status.result.ok
        ? { text: status.result.summary ?? status.result.said ?? 'Done.', kind: 'good' }
        : { text: status.result.error ?? 'It stopped without finishing.', kind: 'bad' });
    }
    return !!status.running;
  }, []);

  useEffect(() => {
    if (target !== 'browser' || !running) return;
    const timer = setInterval(() => { void pollExtension(); }, 900);
    return () => clearInterval(timer);
  }, [target, running, pollExtension]);

  const start = useCallback(async () => {
    const text = goal.trim();
    if (!text) { setNote({ text: 'Say what you want done first.', kind: 'bad' }); return; }
    setNote({ text: 'Starting…' });
    setFeed([]);

    if (target === 'desktop') {
      abort.current = false;
      setRunning(true);
      const startedAt = new Date().toISOString();

      void runOnDesktop({
        goal: text,
        port: state.port,
        onEvent: (event) => setFeed((prev) => [...prev, event]),
        isAborted: () => abort.current,
      })
        .then(async (result) => {
          setNote(result.ok
            ? { text: result.said ?? 'Done.', kind: 'good' }
            : { text: result.error ?? 'It stopped without finishing.', kind: 'bad' });

          /* Logged to the account, best effort: the sidebar's hours and the Hours screen are built from
           * runs, so a desktop run that went unrecorded would make them quietly wrong. */
          try {
            await push({
              runs: [{
                id: `dr_${startedAt.replace(/\D/g, '').slice(-12)}`,
                kind: 'agent',
                goal: text,
                model: 'claude-opus-5',
                outcome: result.ok ? 'ok' : /^stopped$/i.test(result.error ?? '') ? 'stopped' : 'failed',
                summary: result.said ?? result.error ?? null,
                error: result.ok ? null : result.error ?? null,
                steps: result.steps,
                startedAt,
                finishedAt: new Date().toISOString(),
              }],
            });
            await reload();
          } catch (_) {
            // The run still happened; losing its log is not worth telling the user about.
          }
        })
        .finally(() => { setRunning(false); setStopping(false); });
      return;
    }

    const res = await askExtension<ExtensionStatus>('page/run', { goal: text });
    if (!res?.ok) {
      if (res?.signedOut) {
        setBlocked('The extension is installed but not signed in. Open it and press Continue with Google.');
        return;
      }
      setNote({ text: res?.error ?? 'The extension did not take the goal.', kind: 'bad' });
      return;
    }
    setRunning(true);
    void pollExtension();
  }, [goal, target, state.port, reload, pollExtension]);

  const stop = useCallback(async () => {
    setStopping(true);
    setNote({ text: 'Stopping after the current step…' });
    if (target === 'desktop') { abort.current = true; return; }
    await askExtension('page/abort');
    void pollExtension();
  }, [target, pollExtension]);

  const lastTurn = [...feed].reverse().find((e) => e.type === 'turn');
  const lastWait = feed[feed.length - 1]?.type === 'waiting' ? feed[feed.length - 1] : null;

  return (
    <div className="p-5">
      <section className="max-w-[900px] rounded-xl border-stroke border bg-surface-card p-4">
        <div className="mb-3 flex items-start gap-4">
          <Typography variant="p" className="max-w-[60ch] text-ink-secondary text-[0.9rem]">
            Say what you want done, and choose what carries it out.
          </Typography>
          <span className="ms-auto shrink-0 font-mono text-[0.78rem] text-ink-inactive">
            {target === 'desktop'
              ? health ? `agent ${health.version}${stale ? ' · out of date' : ''}` : ''
              : extension.present ? `extension ${extension.version ?? ''}` : ''}
          </span>
        </div>

        <div className="grid max-w-[340px] grid-cols-2 gap-0.5 rounded-md border-stroke border bg-surface-card2 p-0.5">
          {(['browser', 'desktop'] as Target[]).map((id) => (
            <button
              key={id}
              type="button"
              disabled={running}
              onClick={() => { setTarget(id); setNote(null); setFeed([]); }}
              className={cn(
                'rounded-[5px] px-2 py-1.5 text-[0.86rem] text-ink-secondary hover:text-ink-primary',
                target === id && 'bg-surface-card font-semibold text-ink-primary shadow-rest',
                running && 'cursor-not-allowed opacity-disabled',
              )}
            >
              {id === 'browser' ? 'In this browser' : 'On this computer'}
            </button>
          ))}
        </div>

        <Typography variant="p" className="mt-2 max-w-[62ch] text-ink-inactive text-[0.82rem]">
          {target === 'desktop'
            ? 'Real clicks and typing anywhere on this computer, so it reaches Excel, Explorer or any window — not only a browser tab. It works from a picture of the screen, and that picture is sent to the model on every step.'
            : 'Drives a tab in this browser through the extension. It aims at page elements rather than coordinates, so it is the steadier of the two — but it cannot leave the browser.'}
        </Typography>

        {blocked && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border-stroke border bg-surface-card2 px-3 py-2.5 text-[0.86rem] text-ink-secondary">
            <span className="max-w-[64ch]">{blocked}</span>
            <Button variant="ghost" size="sm" onClick={() => void check()}>Check again</Button>
            {target === 'desktop' && !health && (
              <Button variant="ghost" size="sm" onClick={() => void navigate({ to: '/connect' })}>
                Open the guide
              </Button>
            )}
          </div>
        )}

        <textarea
          value={goal}
          onChange={(ev) => setGoal(ev.target.value)}
          disabled={running}
          placeholder="open my inbox, find the message from Ann about the invoice and reply that it is approved"
          className="mt-3 min-h-[84px] w-full max-w-[760px] resize-y rounded-md border-stroke border bg-surface-card2 px-3 py-2.5 text-ink-primary placeholder:text-ink-inactive focus:border-brand-primary focus:outline-none disabled:opacity-disabled"
        />

        <div className="mt-2 flex items-center gap-2">
          {running ? (
            <Button variant="destructive" leftSlot={<Square className="size-4" />} onClick={stop} disabled={stopping}>
              {stopping ? 'Stopping…' : 'Stop'}
            </Button>
          ) : (
            <Button leftSlot={<Play className="size-4" />} disabled={!!blocked} onClick={start}>
              Do it
            </Button>
          )}
        </div>

        <Typography variant="p" className="mt-2 max-w-[70ch] text-ink-inactive text-xs">
          {target === 'desktop'
            ? `A step is one decision, and each sends a picture of your screen to the model. ${WAVE_TURNS} steps to a wave, up to ${MAX_WAVES} waves — at the end of a wave it writes down where it got to and carries on. Waiting for something to finish costs nothing.`
            : 'Each step sends the page’s elements to the model, not a picture. Up to 24 steps per wave, and it hands over to a fresh stretch rather than stopping at a wall.'}
        </Typography>

        {feed.length > 0 && (
          <div className="mt-3 max-h-[260px] max-w-[760px] overflow-y-auto rounded-md border-stroke border bg-surface-card2 px-3 py-2 text-[0.85rem]">
            {feed
              .filter((e) => e.type !== 'turn' && e.type !== 'waiting')
              .slice(-16)
              .map((event, i) => (
                <div
                  key={i}
                  className={cn(
                    'py-0.5',
                    event.type === 'tool' && 'font-mono text-[0.8rem] text-ink-secondary',
                    event.type === 'error' && 'text-fb-red-text',
                    event.type === 'wave' && 'mt-2 border-stroke border-t pt-1.5 font-semibold text-ink-primary',
                    event.type === 'handoff' && 'border-brand-primary border-l-2 bg-surface-accent px-2 py-1 text-ink-secondary',
                  )}
                >
                  {event.type === 'tool'
                    ? describe(event)
                    : event.type === 'wave'
                      ? `Wave ${event.n} — carrying on from what it wrote down`
                      : event.text ?? event.message ?? ''}
                </div>
              ))}
            <div ref={feedEnd} />
          </div>
        )}

        {(note || (running && lastTurn)) && (
          <Typography
            variant="p"
            className={cn(
              'mt-3 text-[0.88rem]',
              note?.kind === 'bad' && 'text-fb-red-text',
              note?.kind === 'good' && 'text-fb-green',
              !note?.kind && 'text-ink-secondary',
            )}
          >
            {running && lastTurn
              ? [
                  `step ${lastTurn.n}${(lastTurn.wave ?? 1) > 1 ? ` (wave ${lastTurn.wave}, ${lastTurn.inWave} of ${lastTurn.of})` : ` of ${lastTurn.of}`}`,
                  lastWait ? `waiting ${Math.round((lastWait.ms ?? 0) / 1000)}s for the screen to settle` : null,
                ].filter(Boolean).join(' · ')
              : note?.text}
          </Typography>
        )}
      </section>
    </div>
  );
};
