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
import { CircleDot, Crosshair, Monitor, Send, Sparkles, Square } from 'lucide-react';
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
import { AGENT_WANTS, shot, windows } from '@/lib/agent';
import { askExtension, watchBridge } from '@/lib/bridge';
import { push } from '@/lib/api';
import {
  type GateAnswer,
  MAX_WAVES,
  type RunEvent,
  WAVE_TURNS,
  runOnDesktop,
} from '@/lib/desktop-engine';
import { useAgent, useConsole } from '@/lib/store';
import { useAccount } from '@/shell/AccountProvider';
import { type Plan, askForPlan } from '@/lib/plan';
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
  /** Намерение, с которым этот прогон начинался, если план спрашивали. Остаётся над фидом, чтобы «сказала»
   * и «сделала» читались рядом. Цикл его не видел. */
  plan?: Plan;
  /** Работа была ограничена окном, которое было впереди — и каким именно. */
  pinned?: string | null;
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

  /* План для ТЕКУЩЕГО текста в поле. `for` обязателен: план, оставшийся от прежней формулировки, - это
   * намерение по другой задаче, и запускать по нему хуже, чем не иметь плана вообще. */
  const [plan, setPlan] = useState<{ for: string; plan: Plan } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planProblem, setPlanProblem] = useState<string | null>(null);
  /* Ограничить работу тем окном, что впереди сейчас. Только для desktop: расширение целится в элементы
   * страницы, и «текущий экран» для него ничего не значит. */
  const [pinScreen, setPinScreen] = useState(false);
  /* Открытый шлюз: цикл стоит и ждёт, пока `answer` не будет вызван. `null`, когда никто не ждёт. */
  const [gate, setGate] = useState<
    { n: number; title: string; said: string; answer: (a: GateAnswer) => void } | null
  >(null);
  /* Снимок экрана, если на паузе его попросили. Единственный способ проверить заявление о состоянии машины -
   * увидеть машину. */
  const [gateShot, setGateShot] = useState<string | null>(null);

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

  /* Намерение, до цикла.
   *
   * Один вызов, ничего не выполняется. Скриншот прикладывается только если человек попросил ограничить работу
   * текущим экраном - иначе план строится по формулировке, что и правильно: модель, которой без просьбы дали
   * картинку, начинает планировать по тому, что на ней открыто, а не по тому, о чём попросили. */
  const makePlan = useCallback(async () => {
    const text = goal.trim();
    if (!text || planning || running) return;
    setPlanning(true);
    setPlanProblem(null);
    try {
      let screen: { png: string; format: string } | null = null;
      if (target === 'desktop' && pinScreen) {
        try {
          const shotNow = await shot(state.port, 900);
          screen = { png: shotNow.png, format: shotNow.format || 'jpeg' };
        } catch (_) {
          /* Без картинки план всё равно полезен - он про формулировку. Отказ снимка не должен отменять
           * план, но и молчать о нём нельзя: человек просил учесть экран. */
          setPlanProblem('The screen could not be read, so this plan is from the wording alone.');
        }
      }
      const asked = await askForPlan(text, target, screen);
      if (asked.plan) setPlan({ for: text, plan: asked.plan });
      else setPlanProblem(asked.error ?? 'no plan came back');
    } finally {
      setPlanning(false);
    }
  }, [goal, planning, running, target, pinScreen, state.port]);

  const send = useCallback(async () => {
    const text = goal.trim();
    if (!text || running) return;

    /* Имя окна, закреплённого на время работы. Читается СЕЙЧАС, а не при включении тумблера: между тем и
     * этим человек кликнул в браузер, чтобы нажать кнопку, и «текущее окно» успело поменяться. Названное
     * окно даёт прогону возможность отказаться вместо того, чтобы работать не с тем. */
    let pinned: string | null = null;
    if (target === 'desktop' && pinScreen) {
      try {
        const open = await windows(state.port);
        const front = open.windows.find((w) => w.active);
        pinned = front ? (front.title || front.process || null) : null;
      } catch (_) {
        pinned = null;
      }
    }

    /* План именно этого прогона, до того как состояние очистится. И цикл, и turn берут его отсюда, чтобы
     * показанное и переданное не могли разойтись. */
    const planned = plan && plan.for === text ? plan.plan : undefined;

    const id = `t${Date.now()}`;
    const startedAt = new Date().toISOString();
    live.current = id;
    setTurns((prev) => [...prev, {
      id,
      goal: text,
      target,
      at: startedAt,
      feed: [],
      state: 'running',
      /* План остаётся в turn'е, над фидом: сверху то, что она собиралась сделать, снизу то, что делала.
       * Сопоставления шагов с чекпоинтами здесь нет - это было бы гарантией на самоотчёте. */
      plan: planned,
      pinned,
    }]);
    setGoal('');
    setPlan(null);
    setPlanProblem(null);

    if (target === 'desktop') {
      abort.current = false;
      setRunning(true);

      void runOnDesktop({
        /* Шлюзы — только когда план действительно спрашивали. Без плана нет границ, и инструмент чекпоинта
         * даже не предлагается модели. */
        checkpoints: planned?.checkpoints,
        onCheckpoint: planned
          ? (at) => new Promise<GateAnswer>((resolve) => {
            setGateShot(null);
            setGate({ ...at, answer: (a) => { setGate(null); setGateShot(null); resolve(a); } });
          })
          : undefined,
        /* Ограничение области, а не картинка: снимок цикл делает каждый шаг и без просьбы. Смысл в том, чтобы
         * НЕ уходить с этого окна - и окно названо, чтобы прогон мог отказаться, а не молча взяться за
         * соседнее. */
        goal: pinned
          ? `${text}\n\nWork on the window that is in front right now — "${pinned}". Do not launch, `
            + 'activate or switch to anything else. If what this needs is not on that window, call finish '
            + 'and say so rather than going to look for it.'
          : text,
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
    /* Если цикл стоит на шлюзе, он ждёт промиса, а не флага - Stop должен разрешить его, иначе прогон
     * остановится только формально и будет ждать вечно. */
    gate?.answer('stop');
    if (target === 'desktop') { abort.current = true; return; }
    await askExtension('page/abort');
    void pollExtension();
  }, [target, pollExtension, gate]);

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

                {/* Намерение, с которым этот прогон начинался. Над фидом, потому что весь смысл в том, чтобы
                    «сказала» и «сделала» читались рядом - без сопоставления чекпоинтов со шагами, которое
                    было бы гарантией на самоотчёте. */}
                {(turn.plan || turn.pinned) && (
                  <div className="rounded-lg border-stroke/60 border bg-surface-card2 px-3 py-2.5">
                    {turn.pinned && (
                      <Typography variant="p" className="mb-1.5 flex items-center gap-1.5 text-[0.78rem] text-ink-secondary">
                        <Crosshair className="size-3.5 shrink-0 text-brand-primary" />
                        Kept to the window that was in front: <strong className="font-semibold">{turn.pinned}</strong>
                      </Typography>
                    )}

                    {turn.plan && (
                      <>
                        <Typography variant="span" className="mb-1 block text-[0.7rem] uppercase tracking-wide text-ink-inactive">
                          What it said it would do
                        </Typography>
                        <ol className="space-y-1">
                          {turn.plan.checkpoints.map((point, i) => (
                            <li key={`${i}-${point.title}`} className="flex gap-2 text-[0.8rem]">
                              <span className="shrink-0 font-mono text-[0.7rem] text-ink-inactive tabular-nums">
                                {String(i + 1).padStart(2, '0')}
                              </span>
                              <span className="min-w-0 text-ink-secondary">{point.title}</span>
                            </li>
                          ))}
                        </ol>
                        <Typography variant="p" className="mt-1.5 text-ink-inactive text-[0.72rem]">
                          Its intention before it started. It decided each step from the screen as it went and
                          never saw this — what it did is below.
                        </Typography>
                      </>
                    )}
                  </div>
                )}

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

      {/* Цикл стоит и ждёт.
        *
        * Это заявление модели, а не факт: она объявила чекпоинт, и подпись говорит именно так. Кнопка «Look
        * at the screen» здесь потому, что проверить заявление о состоянии машины можно только увидев машину. */}
      {gate && (
        <section className="mx-auto mb-3 w-full max-w-[46rem] rounded-xl border-fb-attention/50 border bg-surface-card p-3.5">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="size-2 shrink-0 animate-pulse rounded-full bg-fb-attention" />
            <Typography variant="span" weight="semibold" className="min-w-0 flex-1 text-[0.95rem]">
              Waiting at checkpoint {gate.n} — {gate.title}
            </Typography>
          </div>

          <Typography variant="p" className="mb-2 max-w-[70ch] text-ink-secondary text-[0.85rem]">
            It says: “{gate.said}”
          </Typography>

          {gateShot && (
            <img
              src={gateShot}
              alt="The screen as it is at this checkpoint"
              className="mb-2 max-h-64 w-full rounded-lg border-stroke border object-contain"
            />
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              leftSlot={<Send className="size-4" />}
              onClick={() => gate.answer('go')}
            >
              Carry on
            </Button>
            <Button
              variant="destructive"
              size="sm"
              leftSlot={<Square className="size-4" />}
              onClick={() => gate.answer('stop')}
            >
              Stop here
            </Button>
            {!gateShot && (
              <Button
                variant="ghost"
                size="sm"
                leftSlot={<Crosshair className="size-4" />}
                onClick={async () => {
                  try {
                    const picture = await shot(state.port, 900);
                    setGateShot(`data:image/${picture.format || 'jpeg'};base64,${picture.png}`);
                  } catch (_) {
                    /* Отказ снимка не должен закрывать шлюз: решение всё равно за человеком, просто без
                     * картинки. */
                  }
                }}
              >
                Look at the screen
              </Button>
            )}
            <span className="ms-auto text-[0.74rem] text-ink-inactive">
              It is a claim, not a fact — it announced this itself. Nothing moves until you answer.
            </span>
          </div>
        </section>
      )}

      {/* Намерение, до того как что-нибудь произойдёт.
        *
        * Подпись говорит ровно то, что есть: цикл решает каждый шаг заново по экрану и этого плана не видит.
        * Чекпоинты с номерами, читающиеся как программа, были бы худшим видом полировки - выглядят как
        * гарантия и ею не являются. */}
      {plan && plan.for === goal.trim() && (
        <section className="mx-auto mb-3 w-full max-w-[46rem] rounded-xl border-brand-primary/40 border bg-surface-card p-3.5">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Sparkles className="size-4 shrink-0 text-brand-primary" />
            <Typography variant="span" weight="semibold" className="min-w-0 flex-1 text-[0.95rem]">
              {plan.plan.title}
            </Typography>
            <Button variant="ghost" size="sm" onClick={() => setPlan(null)}>
              Edit the wording
            </Button>
            <Button size="sm" leftSlot={<Send className="size-4" />} onClick={() => void send()}>
              Run it
            </Button>
          </div>

          <ol className="mb-2 space-y-1.5">
            {plan.plan.checkpoints.map((point, i) => (
              <li key={`${i}-${point.title}`} className="flex gap-2.5">
                <span className="mt-0.5 shrink-0 font-mono text-[0.72rem] text-ink-inactive tabular-nums">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold text-[0.85rem] text-ink-primary">{point.title}</span>
                  <span className="block text-[0.8rem] text-ink-inactive">{point.detail}</span>
                </span>
              </li>
            ))}
          </ol>

          {/* Единственная строка, которая обязана быть здесь. */}
          <Typography variant="p" className="text-ink-inactive text-[0.76rem]">
            What it says it will do. It decides each step from the screen as it goes and never sees this plan,
            so the run can differ — nothing has happened yet.
          </Typography>
        </section>
      )}

      {planProblem && (
        <Typography
          variant="p"
          className="mx-auto mb-2 w-full max-w-[46rem] text-fb-attention text-[0.8rem]"
        >
          {planProblem}
        </Typography>
      )}

      <Composer
        /* Справка под полем: бюджет шагов, версия агента и то, что делает Enter. Ни одно из этого не решение,
         * которое принимают, набирая задачу - а в строке управления они выдавливали кнопку на второй ряд. */
        hint={(
          <>
            <span className="flex items-center gap-1.5">
              <Monitor className="size-3.5" />
              <span className="font-mono">{engine}</span>
            </span>
            <span>
              {target === 'desktop'
                ? `${WAVE_TURNS} steps a wave, up to ${MAX_WAVES}`
                : 'aims at elements, not positions'}
            </span>
            {!running && (
              <span>
                <kbd className="rounded border-stroke border bg-surface-card2 px-1 py-0.5 font-mono text-[0.7rem]">Enter</kbd>
                {' runs it without a plan'}
              </span>
            )}
          </>
        )}
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

            {/* Не «дать картинку» - снимок цикл делает каждый шаг и так. Это ограничение области: работать на
                том окне, что впереди, и никуда не уходить. Только для desktop: расширение целится в элементы
                страницы, и «текущий экран» для него ничего не значит. */}
            {target === 'desktop' && (
              <button
                type="button"
                disabled={running}
                aria-pressed={pinScreen}
                title="Keep the work on the window that is in front when you press Run — do not launch or switch to anything else"
                onClick={() => setPinScreen((on) => !on)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[0.76rem] transition-colors duration-base',
                  'disabled:opacity-disabled',
                  pinScreen
                    ? 'border-brand-primary/50 bg-brand-primary/12 font-semibold text-brand-primary'
                    : 'border-stroke text-ink-secondary hover:bg-state-hover',
                )}
              >
                <Crosshair className="size-3.5" />
                Use current screen
              </button>
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
            ) : plan && plan.for === goal.trim() ? (
              <Button
                size="sm"
                leftSlot={<Send className="size-4" />}
                disabled={!!blocked}
                onClick={send}
              >
                Run it
              </Button>
            ) : (
              /* План по умолчанию, а Enter остаётся быстрым путём: одно нажатие - и прогон, без плана.
                 Стоит один лишний вызов модели, и он ловит непонимание до того, как что-то нажато. */
              <Button
                size="sm"
                leftSlot={<Sparkles className="size-4" />}
                isLoading={planning}
                disabled={!!blocked || !goal.trim()}
                onClick={() => void makePlan()}
              >
                Plan it
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
