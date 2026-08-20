/* Create the flow, as a conversation.
 *
 * It used to be one block: a switch, a textarea, a button, and a scrolling log underneath that was replaced
 * every time you asked for something. Asking for two things in a row left no trace of the first, which is
 * the wrong shape for the thing this actually is - you say what you want, something goes and does it, you
 * see what it did, you ask for the next thing. So it is a thread now, following insightis's chat (see
 * components/chat), with the two executors as a switch inside the composer rather than a mode above it:
 *
 *   In this browser   the extension drives a tab. It aims at page ELEMENTS - it reads the accessibility
 *                     tree - so it clicks "the Send button" rather than a position and survives the page
 *                     moving underneath it. It cannot leave the browser. Default, for that reason.
 *   On this computer  the local agent drives the whole desktop from a picture of the screen, so it reaches
 *                     Excel, Explorer, a native dialog. The decision loop lives here; see desktop-engine.
 *
 * The turns are kept in memory only, deliberately: a run is already recorded on the account (that is what
 * the Insights page reads), and persisting a second copy here would give two records that can disagree.
 * Reloading the page clears the thread and loses nothing that matters.
 */
import { useNavigate } from '@tanstack/react-router';
import { CircleDot, Monitor, Send, Sparkles, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import {
  AgentTurn,
  Composer,
  Opener,
  Segmented,
  StepLine,
  Suggestion,
  Thread,
  UserTurn,
} from '@/components/chat';
import { AGENT_WANTS } from '@/lib/agent';
import { askExtension, watchBridge } from '@/lib/bridge';
import { push } from '@/lib/api';
import { MAX_WAVES, type RunEvent, WAVE_TURNS, runOnDesktop } from '@/lib/desktop-engine';
import { useAgent, useConsole } from '@/lib/store';
import { useAccount } from '@/shell/AccountProvider';
import { LiveContext } from './LiveContext';

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

/** One exchange: what was asked for, and what happened. */
interface Turn {
  id: string;
  goal: string;
  target: Target;
  at: string;
  feed: RunEvent[];
  state: 'running' | 'ok' | 'failed';
  note?: string;
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

const SUGGESTIONS = [
  'open my inbox, find the message from Ann about the invoice and reply that it is approved',
  'download this month’s invoices from the billing page and put them in Downloads',
  'in the spreadsheet on screen, fill the total column and save it',
];

export const CreateView = () => {
  const [state] = useConsole();
  const { health, stale } = useAgent();
  const { reload } = useAccount();
  const navigate = useNavigate();

  const [target, setTarget] = useState<Target>(() => {
    try { return localStorage.getItem(KEY) === 'desktop' ? 'desktop' : 'browser'; } catch (_) { return 'browser'; }
  });
  const [goal, setGoal] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [blocked, setBlocked] = useState<string | null>('Looking for what can carry this out…');
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [extension, setExtension] = useState<{ present: boolean; version: string | null }>({ present: false, version: null });

  const abort = useRef(false);
  const live = useRef<string | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);

  /** Only ever the turn being run; a finished turn is never rewritten. */
  const updateLive = useCallback((change: (turn: Turn) => Turn) => {
    setTurns((prev) => prev.map((t) => (t.id === live.current ? change(t) : t)));
  }, []);

  useEffect(() => {
    try { localStorage.setItem(KEY, target); } catch (_) { /* private mode */ }
  }, [target]);

  useEffect(() => watchBridge((bridge) => setExtension({ present: bridge.present, version: bridge.version })), []);

  useEffect(() => { threadEnd.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [turns]);

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
    if (!status) {
      updateLive((t) => ({ ...t, state: 'failed', note: 'The extension stopped answering. Reload this tab.' }));
      setRunning(false);
      return false;
    }
    if (status.signedOut) {
      setBlocked('The extension is installed but not signed in. Open it and press Continue with Google.');
      updateLive((t) => ({ ...t, state: 'failed', note: 'The extension is not signed in.' }));
      setRunning(false);
      return false;
    }

    const feed = (status.log ?? []).map((e) => ({
      type: e.type as RunEvent['type'], name: e.name, text: e.text, message: e.message,
    }));
    setRunning(!!status.running);
    if (status.running) {
      updateLive((t) => ({ ...t, feed }));
      return true;
    }
    if (status.result) {
      updateLive((t) => ({
        ...t,
        feed,
        state: status.result!.ok ? 'ok' : 'failed',
        note: status.result!.ok
          ? status.result!.summary ?? status.result!.said ?? 'Done.'
          : status.result!.error ?? 'It stopped without finishing.',
      }));
    }
    return false;
  }, [updateLive]);

  useEffect(() => {
    if (target !== 'browser' || !running) return;
    const timer = setInterval(() => { void pollExtension(); }, 900);
    return () => clearInterval(timer);
  }, [target, running, pollExtension]);

  const send = useCallback(async () => {
    const text = goal.trim();
    if (!text || running) return;

    const id = `t${Date.now()}`;
    const startedAt = new Date().toISOString();
    live.current = id;
    setTurns((prev) => [...prev, { id, goal: text, target, at: startedAt, feed: [], state: 'running' }]);
    setGoal('');

    if (target === 'desktop') {
      abort.current = false;
      setRunning(true);

      void runOnDesktop({
        goal: text,
        port: state.port,
        onEvent: (event) => updateLive((t) => ({ ...t, feed: [...t.feed, event] })),
        isAborted: () => abort.current,
      })
        .then(async (result) => {
          updateLive((t) => ({
            ...t,
            state: result.ok ? 'ok' : 'failed',
            note: result.ok ? result.said ?? 'Done.' : result.error ?? 'It stopped without finishing.',
          }));

          /* Logged to the account, best effort: the sidebar's hours, the Hours screen and the Insights page
           * are built from runs, so a desktop run that went unrecorded would make them quietly wrong. */
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
      }
      updateLive((t) => ({
        ...t,
        state: 'failed',
        note: res?.error ?? 'The extension did not take the goal.',
      }));
      return;
    }
    setRunning(true);
    void pollExtension();
  }, [goal, running, target, state.port, reload, pollExtension, updateLive]);

  const stop = useCallback(async () => {
    setStopping(true);
    if (target === 'desktop') { abort.current = true; return; }
    await askExtension('page/abort');
    void pollExtension();
  }, [target, pollExtension]);

  const engine = target === 'desktop'
    ? health ? `agent ${health.version}${stale ? ' · out of date' : ''}` : 'agent offline'
    : extension.present ? `extension ${extension.version ?? ''}` : 'extension not found';

  return (
    /* Two columns on a wide window: the thread, and what the executor can see. The shell gives this route a
     * header and nothing else, so the thread owns the height and only it scrolls.
     *
     * The panel is desktop-only, and it says so rather than disappearing. The browser half drives a tab
     * through the extension and aims at page ELEMENTS, so a screenshot of the desktop there would be a
     * picture of something the executor does not use - and a column that vanishes when you flip a toggle
     * raises a worse question than one that explains itself. */
    <div className="flex h-[calc(100dvh-3.25rem)] gap-4">
      <div className="flex min-w-0 flex-1 flex-col">
      <Thread>
        {turns.length === 0 ? (
          <Opener
            title="Say what you want done"
            note={
              target === 'desktop'
                ? 'It works from a picture of your screen, so it reaches Excel, Explorer or any window — not only a browser tab. Each step sends that picture to the model.'
                : 'The extension drives a tab in this browser. It aims at page elements rather than positions, so it survives the page moving underneath it — but it cannot leave the browser.'
            }
          >
            {SUGGESTIONS.map((text) => (
              <Suggestion key={text} icon={<Sparkles />} onClick={() => setGoal(text)}>
                {text.length > 52 ? `${text.slice(0, 52)}…` : text}
              </Suggestion>
            ))}
          </Opener>
        ) : (
          turns.map((turn) => {
            const lastTurnEvent = [...turn.feed].reverse().find((e) => e.type === 'turn');
            const lastEvent = turn.feed[turn.feed.length - 1];
            const waiting = lastEvent?.type === 'waiting' ? lastEvent : null;
            const shown = turn.feed.filter((e) => e.type !== 'turn' && e.type !== 'waiting');

            return (
              <div key={turn.id} className="flex flex-col gap-3">
                <UserTurn
                  meta={`${turn.target === 'desktop' ? 'on this computer' : 'in this browser'} · ${
                    new Date(turn.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  }`}
                >
                  {turn.goal}
                </UserTurn>

                <AgentTurn
                  tone={turn.state === 'running' ? 'running' : turn.state}
                  header={
                    turn.state === 'running' ? (
                      <div className="flex items-center gap-2 text-[0.82rem] text-ink-secondary">
                        <CircleDot className="size-3.5 animate-pulse text-brand-primary" />
                        {lastTurnEvent
                          ? [
                            `step ${lastTurnEvent.n}${(lastTurnEvent.wave ?? 1) > 1
                              ? ` (wave ${lastTurnEvent.wave}, ${lastTurnEvent.inWave} of ${lastTurnEvent.of})`
                              : ` of ${lastTurnEvent.of}`}`,
                            waiting ? `waiting ${Math.round((waiting.ms ?? 0) / 1000)}s for the screen to settle` : null,
                          ].filter(Boolean).join(' · ')
                          : 'starting…'}
                      </div>
                    ) : undefined
                  }
                >
                  {shown.length === 0 && turn.state === 'running' && (
                    <StepLine kind="waiting">Working out the first step…</StepLine>
                  )}

                  {shown.map((event, i) => (
                    <StepLine
                      key={i}
                      kind={
                        event.type === 'tool' ? 'tool'
                          : event.type === 'error' ? 'error'
                            : event.type === 'wave' ? 'wave'
                              : event.type === 'handoff' ? 'handoff'
                                : 'say'
                      }
                    >
                      {event.type === 'tool'
                        ? describe(event)
                        : event.type === 'wave'
                          ? `Wave ${event.n} — carrying on from what it wrote down`
                          : event.text ?? event.message ?? ''}
                    </StepLine>
                  ))}

                  {turn.note && (
                    <Typography
                      variant="p"
                      className={cn(
                        'mt-1 text-[0.88rem]',
                        turn.state === 'ok' && 'text-fb-green',
                        turn.state === 'failed' && 'text-fb-red-text',
                      )}
                    >
                      {turn.note}
                    </Typography>
                  )}
                </AgentTurn>
              </div>
            );
          })
        )}
        <div ref={threadEnd} />
      </Thread>

      {blocked && (
        <div className="shrink-0 px-4 pb-2">
          <div className="mx-auto w-full max-w-[46rem]">
            <div className="flex flex-wrap items-center gap-3 rounded-md border-stroke border bg-surface-card2 px-3 py-2.5 text-[0.86rem] text-ink-secondary">
              <span className="max-w-[64ch]">{blocked}</span>
              <Button variant="ghost" size="sm" onClick={() => void check()}>Check again</Button>
              {target === 'desktop' && !health && (
                <Button variant="ghost" size="sm" onClick={() => void navigate({ to: '/connect' })}>
                  Open the guide
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      <Composer
        footer={
          <>
            {/* The choice of executor lives with the message it applies to, not in a mode above the page:
                the same goal typed against the browser and against the desktop is two different requests. */}
            <Segmented<Target>
              value={target}
              disabled={running}
              onChange={(id) => { setTarget(id); void check(); }}
              options={[
                { id: 'browser', label: 'In this browser', title: 'The extension drives a tab. Steadier, and cannot leave the browser.' },
                { id: 'desktop', label: 'On this computer', title: 'The local agent drives the whole desktop from a picture of the screen.' },
              ]}
            />

            <span className="flex items-center gap-1.5 font-mono text-[0.74rem] text-ink-inactive">
              <Monitor className="size-3.5" />
              {engine}
            </span>

            <span className="ms-auto text-[0.74rem] text-ink-inactive">
              {target === 'desktop'
                ? `${WAVE_TURNS} steps a wave, up to ${MAX_WAVES}`
                : 'aims at elements, not positions'}
            </span>

            {/* It has always sent on Enter and never said so. A keyboard shortcut nobody is told about is a
              * shortcut for whoever wrote it. */}
            {!running && (
              <span className="hidden text-[0.74rem] text-ink-inactive sm:inline">
                <kbd className="rounded border-stroke border bg-surface-card2 px-1 py-0.5 font-mono text-[0.7rem]">Enter</kbd>
                {' to run'}
              </span>
            )}

            {running ? (
              <Button
                variant="destructive"
                size="sm"
                leftSlot={<Square className="size-4" />}
                onClick={stop}
                disabled={stopping}
              >
                {stopping ? 'Stopping…' : 'Stop'}
              </Button>
            ) : (
              <Button
                size="sm"
                leftSlot={<Send className="size-4" />}
                disabled={!!blocked || !goal.trim()}
                onClick={send}
              >
                Do it
              </Button>
            )}
          </>
        }
      >
        <textarea
          value={goal}
          onChange={(ev) => setGoal(ev.target.value)}
          onKeyDown={(ev) => {
            // Enter sends, Shift+Enter breaks the line - what a chat does. A goal is usually one sentence.
            if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void send(); }
          }}
          disabled={running}
          rows={2}
          placeholder={running ? 'Working…' : 'open my inbox and reply to Ann that the invoice is approved'}
          className={cn(
            'max-h-[9rem] min-h-[3rem] w-full resize-none bg-transparent px-1.5 py-1 text-ink-primary',
            'placeholder:text-ink-inactive focus:outline-none disabled:opacity-disabled',
          )}
        />
      </Composer>
      </div>

      {/* Its own scroller, so a long window list cannot push the thread's height around. */}
      <div className="hidden w-[24rem] shrink-0 overflow-y-auto py-4 pr-5 xl:block">
        {target === 'desktop' ? (
          <LiveContext port={state.port} enabled={!!health && !health.recording} />
        ) : (
          <aside className="rounded-xl border-stroke border bg-surface-card p-3.5">
            <Typography variant="span" className="block text-[0.7rem] uppercase tracking-wide text-ink-inactive">
              Live context
            </Typography>
            <Typography variant="span" weight="semibold" className="mt-1.5 block text-[0.9rem]">
              Not used in this browser
            </Typography>
            <Typography variant="p" className="mt-1 text-ink-inactive text-[0.8rem]">
              The extension aims at page elements rather than at positions on a screen, so it does not work
              from a picture and there is nothing here to show it. Switch to <strong>On this computer</strong>
              {' '}to see what the agent sees.
            </Typography>
          </aside>
        )}
      </div>
    </div>
  );
};
