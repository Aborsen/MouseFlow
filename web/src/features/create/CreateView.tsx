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
import { ChevronDown, CircleDot, Crosshair, Mic, MicOff, Monitor, Send, Sparkles, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@insightis/ui/DropdownMenu';
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
import { AGENT_WANTS, localMachine, shot, windows } from '@/lib/agent';
import { askExtension, watchBridge } from '@/lib/bridge';
import { type LiveJob, keepArtifact, liveJobs, push, scheduleAdd, scheduleRemove } from '@/lib/api';
import {
  type GateAnswer,
  MAX_WAVES,
  type RunEvent,
  WAVE_TURNS,
  mediaType,
  runOnDesktop,
} from '@/lib/desktop-engine';
import { useAgent, useConsole } from '@/lib/store';
import {
  type DictatedRun, dictatedSkillIdFor, hasSkillForRun, saveDictatedAsGoalSkill,
} from '@/features/record/save-as-skill';
import { langName, useDictation } from './dictation';
import { SaveDictatedSkill } from './SaveDictatedSkill';
import { useAccount } from '@/shell/AccountProvider';
import { usePageChrome } from '@/shell/Surface';
import { type Plan, askForPlan } from '@/lib/plan';
import { EarlierPanel } from './EarlierPanel';
import { describe } from './describe';
import { Earlier } from './Earlier';
/* Сказать о конце прогона тому, кто на эту вкладку не смотрит. Смысл прогона в том, что человек уходит
 * заниматься другим - вкладка позади других окон НАМЕРЕННО, - и результат, живущий только на экране, никто не
 * видит до момента, когда сам решит проверить. */
import { announceFinished, askToNotify } from './finished';
import { desktopModel } from '@/lib/model-config';

type Target = 'browser' | 'desktop';
const KEY = 'mouseflow.create.target';

/* Что делает главная кнопка: строит план или запускает прогон. Тип, а не булево, потому что читается это
 * в шести местах и `starts === true` не сказало бы, что именно true. */
type StartWith = 'plan' | 'run';

/* Обе половинки выбора, вместе с тем, что каждая на самом деле делает. Ровно одна строчка описания на
 * каждую, и обе говорят про последствия, а не про механику: разница между ними в том, произойдёт ли
 * что-нибудь на настоящем экране до того, как человек это увидел. */
const START_WITH: { id: StartWith; label: string; detail: string }[] = [
  { id: 'plan', label: 'Plan it', detail: 'Says what it will do. Nothing happens yet.' },
  { id: 'run', label: 'Run it', detail: 'Starts working straight away, with no checkpoints.' },
];

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
  /* ЧЕМ ЭТОТ ПРОГОН БЫЛ, оставленное для того, чтобы из него можно было сделать скилл.
   *
   * Заполняется только когда прогон закончился успешно и записался на аккаунт: скилл делается из
   * ДОКАЗАННОГО флоу, а прогон, который не доехал до аккаунта, доказывает только то, что было на этом
   * экране. Пусто - кнопки нет, и это честнее кнопки, которая отвечает «не получилось». */
  proved?: DictatedRun;
  /** Намерение, с которым этот прогон начинался, если план спрашивали. Остаётся над фидом, чтобы «сказала»
   * и «сделала» читались рядом. Цикл его не видел. */
  plan?: Plan;
  /** Работа была ограничена окном, которое было впереди — и каким именно. */
  pinned?: string | null;
  /** Прогон, которого эта страница НЕ начинала: машина взяла его сама - по расписанию или из чата. */
  byItself?: { scheduleId: string | null };
  /** Цель отложена, и вот расписание, которым: чтобы отменить можно было ЗДЕСЬ, а не на другой странице. */
  scheduled?: { id: string; nextSaid: string };
}

const SUGGESTIONS = [
  'open my inbox, find the message from Ann about the invoice and reply that it is approved',
  'download this month’s invoices from the billing page and put them in Downloads',
  'in the spreadsheet on screen, fill the total column and save it',
];

export const CreateView = () => {
  const [state] = useConsole();
  const { health, stale } = useAgent();
  const { reload, flows, runs } = useAccount();
  /* Открытый диалог сохранения, вместе с прогоном, который он сохраняет. Держится здесь, а не в самом
   * ходе: ход перерисовывается фидом, а диалог не должен закрываться оттого, что пришёл ещё один шаг. */
  const [saving, setSaving] = useState<
    { run: NonNullable<Turn['proved']>; goal: string } | null
  >(null);
  const navigate = useNavigate();

  const [target, setTarget] = useState<Target>(() => {
    try { return localStorage.getItem(KEY) === 'desktop' ? 'desktop' : 'browser'; } catch (_) { return 'browser'; }
  });
  const [goal, setGoal] = useState('');

  /* Готовые куски речи ДОПИСЫВАЮТСЯ к тому, что уже набрано, а не заменяют его: диктовка - это ещё один
   * способ набирать в то же поле, а не отдельный режим ввода. Пробел ставится здесь, потому что
   * распознавание отдаёт фразы без него. */
  const dictation = useDictation((text) => {
    const said = text.trim();
    if (!said) return;
    setGoal((now) => (now.trim() ? `${now.replace(/\s+$/, '')} ${said}` : said));
  });
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

  /* Переключать ли окно на браузер, когда прогон кончится. По умолчанию нет: уведомление ничего не отбирает,
   * а активация окна отбирает фокус - и если человек в это время печатает в другом приложении, это хуже
   * пропущенного уведомления. Помнится между прогонами, потому что это предпочтение, а не решение про один
   * прогон. */
  const [bringForward, setBringForward] = useState(() => {
    try { return localStorage.getItem('mouseflow.bringForward') === '1'; } catch (_) { return false; }
  });
  const wantsForward = useCallback((on: boolean) => {
    setBringForward(on);
    try { localStorage.setItem('mouseflow.bringForward', on ? '1' : '0'); } catch (_) { /* private mode */ }
  }, []);

  /* С ЧЕГО НАЧИНАЕТСЯ НАЖАТИЕ - план или сразу прогон.
   *
   * Раньше это была не настройка, а расхождение: кнопка говорила «Plan it», Enter отправлял, и разницу
   * объясняла строчка под полем. Строчку читают один раз, а Enter жмут каждый раз, так что настоящим
   * умолчанием было не то, что написано на кнопке. Теперь выбор один и он виден: что написано на кнопке,
   * то и происходит - от нажатия мышью, от Enter, всегда.
   *
   * Помнится между прогонами, как и остальные предпочтения здесь: человек, который водит один и тот же
   * рабочий стол каждый день, не должен выбирать это заново каждое утро. По умолчанию план - один лишний
   * вызов модели ловит непонимание до того, как что-то нажато на настоящем экране. */
  const [startWith, setStartWith] = useState<StartWith>(() => {
    try { return localStorage.getItem('mouseflow.startWith') === 'run' ? 'run' : 'plan'; } catch (_) { return 'plan'; }
  });
  const wantsToStart = useCallback((how: StartWith) => {
    setStartWith(how);
    try { localStorage.setItem('mouseflow.startWith', how); } catch (_) { /* private mode */ }
  }, []);

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

  /* ПРОГОНЫ, КОТОРЫЕ МАШИНА ДЕЛАЕТ САМА.
   *
   * «В 20:10 открой аутлук» стало расписанием, и в 20:10 агент выполнил его - через облачный путь, мимо этой
   * страницы. В приложении при этом не было ничего: ни ленты, ни объявления, ни возврата вкладки, о котором
   * человек просил галочкой, ни строки в истории до перезагрузки. Он прочитал это как «сделал молча», и был
   * прав. Отсюда опрос: каждые несколько секунд страница спрашивает, что машина взяла сама, рисует это той же
   * карточкой, что и свой прогон, и когда оно кончается - объявляет теми же тремя путями и перечитывает
   * историю. Пять секунд: агент сам спрашивает работу каждые три, а у маршрута общий потолок в минуту на
   * аккаунт, и две открытые вкладки не должны его исчерпать. */
  const seenJobs = useRef<Map<string, LiveJob['state']>>(new Map());
  useEffect(() => {
    let stop = false;
    const look = async () => {
      let jobs: LiveJob[];
      try {
        jobs = (await liveJobs()).jobs;
      } catch (_) {
        return; // сеть не ответила - карточки остаются какими были
      }
      if (stop) return;
      for (const job of jobs) {
        const turnId = `q_${job.id}`;
        const feed: RunEvent[] = job.steps.map((step) => ({
          type: 'tool' as const, name: step.tool, input: step.input,
          spent: step.ms ? { shot: step.ms.shot, model: step.ms.model } : undefined,
        }));
        const finished = job.state === 'done' || job.state === 'failed';
        const before = seenJobs.current.get(job.id);
        /* Законченное до того, как страница его увидела идущим, - не показывается: это история, и она уже
         * в списке справа. Карточка - для того, что происходит или только что произошло НА ГЛАЗАХ. */
        if (before === undefined && finished) { seenJobs.current.set(job.id, job.state); continue; }
        seenJobs.current.set(job.id, job.state);

        const turnState: Turn['state'] = !finished ? 'running' : job.ok ? 'ok' : 'failed';
        const note = finished ? (job.said ?? (job.ok ? 'Done.' : 'It stopped without finishing.')) : undefined;
        setTurns((prev) => {
          const have = prev.find((t) => t.id === turnId);
          if (!have) {
            return [...prev, {
              id: turnId,
              goal: job.goal ?? job.name,
              target: 'desktop',
              at: job.startedAt ?? new Date().toISOString(),
              feed,
              state: turnState,
              note,
              byItself: { scheduleId: job.scheduleId },
            }];
          }
          return prev.map((t) => (t.id === turnId ? { ...t, feed, state: turnState, note } : t));
        });

        /* Кончилось на глазах - сказать вслух и перечитать историю. Один раз: состояние сравнивается с тем,
         * что было увидено раньше, а не с «finished». */
        if (finished && before !== undefined && before !== job.state) {
          void announceFinished({
            outcome: job.ok ? 'ok' : 'failed',
            said: job.said,
            port: state.port,
            bringForward,
          });
          void reload();
        }
      }
    };
    void look();
    const timer = setInterval(() => { void look(); }, 5000);
    return () => { stop = true; clearInterval(timer); };
  }, [bringForward, reload, state.port]);

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
    const approved = plan && plan.for === text ? plan.plan : undefined;

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
      plan: approved,
      pinned,
    }]);
    setGoal('');
    setPlan(null);
    setPlanProblem(null);

    if (target === 'desktop') {
      abort.current = false;
      setRunning(true);
      /* Спрошено здесь, одним кликом после «Run it»: у запроса есть контекст, и он показывается, потому что
       * это всё ещё жест пользователя. Ответ не проверяется - announceFinished сам решает, что ему доступно. */
      void askToNotify();

      /** Что прогон говорил по дороге. Собирается по ходу, пишется в конце. */
      const commentary: string[] = [];

      void runOnDesktop({
        /* Шлюзы — только когда план действительно спрашивали. Без плана нет границ, и инструмент чекпоинта
         * даже не предлагается модели. */
        checkpoints: approved?.checkpoints,
        onCheckpoint: approved
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
        machine: localMachine(state.port),
        /* Что этот аккаунт делал прямо перед этим - фон, не задание. Только прогоны цели, только с этого
         * аккаунта, и уже отсортированы новыми вперёд. Формулируется в мозге (earlierRuns), потому что
         * облачный драйвер отдаёт модели то же самое теми же словами. */
        earlier: runs.filter((run) => run.kind === 'agent'),
        onEvent: (event) => {
          /* СЛОВА ПРОГОНА, отложенные для записи на аккаунт.
           *
           * `user_run.said` существует с самого начала и на этом пути никогда не заполнялся - api/insights.js
           * даже вынужден объяснять, что пустая колонка не значит «прогон молчал». Заполняется отсюда, а не
           * из фида: фид живёт в состоянии компонента и его к этому моменту может уже не быть, а слова -
           * единственное, что делает историю прогона читаемой человеком. Итоговая фраза не здесь: она
           * уходит в `summary`, и дублировать её значило бы напечатать её дважды подряд. */
          if (event.type === 'text' && event.text) commentary.push(event.text);
          updateLive((t) => ({ ...t, feed: [...t.feed, event] }));
        },
        isAborted: () => abort.current,
        /* КАДРЫ, КОТОРЫЕ ЧТО-ТО ДОКАЗЫВАЮТ. Цикл решает, какие; кладёт их сюда страница, потому что цикл
         * ведёт машину, а не аккаунт (см. onArtifact в desktop-engine.ts).
         *
         * `void` и без ожидания: прогон не должен ждать сети ради картинки, и потерянная картинка не повод
         * останавливать работу на чьём-то компьютере. Id прогона тот же, что уедет в push ниже - иначе
         * кадры оказались бы привязаны к строке, которой нет. */
        onArtifact: ({ kind, stepNo, said, frame }) => {
          void keepArtifact({
            runId: `dr_${startedAt.replace(/\D/g, '').slice(-12)}`,
            stepNo, kind, said,
            mime: frame.format || 'image/jpeg',
            w: frame.w, h: frame.h,
            bytes: frame.png,
          }).catch(() => { /* кадр потерян, прогон - нет */ });
        },
      })
        .then(async (result) => {
          /* ОТЛОЖЕНО, А НЕ СДЕЛАНО. Цель назвала время впереди («в 19:41 …»), и модель вместо таймера из
           * PowerShell позвала defer_until. Здесь у цели ещё нет скилла - она надиктована, - поэтому она
           * сохраняется как скилл-цель тем же saveDictatedAsGoalSkill, что и кнопка «Save as skill», и на
           * него ставится разовое расписание. В журнал прогонов не пишется: прогона не было, и зелёная
           * строка о нём была бы ложью того вида, против которого написан весь цикл. Дальше работает
           * расписание: в назначенный час курьер агента ставит обычный прогон, если машина не спит. */
          if (result.deferred) {
            const { at, zone } = result.deferred;
            const runId = `dr_${startedAt.replace(/\D/g, '').slice(-12)}`;
            const label = text.split('\n')[0].trim().slice(0, 80) || 'Scheduled goal';
            let note: string;
            let ok = true;
            try {
              const where = await windows(state.port)
                .then((r) => r.windows.map((w) => w.title).filter(Boolean))
                .catch(() => [] as string[]);
              await saveDictatedAsGoalSkill(
                { runId, windows: where, steps: result.steps, at: startedAt },
                { name: label, goal: text, params: [] },
              );
              const made = await scheduleAdd({ flowId: dictatedSkillIdFor(runId), once: at, zone, label });
              note = `Set aside until ${made.schedule.nextSaid ?? at}. It runs then, if this computer is awake `
                + 'and the agent is running — the schedule is on the Skills page, and a time that passes with '
                + 'nothing listening is recorded there as missed.';
              updateLive((t) => ({
                ...t, scheduled: { id: made.schedule.id, nextSaid: made.schedule.nextSaid ?? at },
              }));
            } catch (err) {
              ok = false;
              note = `The goal asked to wait until ${at}, but it could not be scheduled: `
                + `${err instanceof Error ? err.message : 'the account did not answer'}. Nothing was done.`;
            }
            updateLive((t) => ({ ...t, state: ok ? 'ok' : 'failed', note }));

            /* СКАЗАТЬ ВСЛУХ - по тем же трём путям, что и всякое другое окончание, и это исправление.
             *
             * Отложенный прогон возвращался здесь раньше времени, минуя и объявление, и запись: человек
             * ставил задачу на 19:41, уходил в другое окно и не получал ни уведомления, ни возврата
             * вкладки, о котором сам же попросил галочкой. Окончание - оно и есть окончание, каким бы
             * коротким ни было: прогон посмотрел на экран, назвал час и остановился. */
            void announceFinished({
              outcome: ok ? 'ok' : 'failed',
              said: note,
              port: state.port,
              bringForward,
            });

            /* И В ИСТОРИЮ. Прогон был: модель получила снимок, приняла решение и стоила денег за него -
             * поэтому в журнале ему место, со своим единственным шагом. Не записывать его значило потерять
             * единственное свидетельство того, ЧТО было решено и почему прогон кончился ничем; в фиде это
             * жило до перезагрузки страницы, и человек, вернувшийся к «58 runs», нового не находил.
             *
             * `ok`, и это не выдача отложенного за выполненное: summary начинается с «Set aside until …»,
             * то есть первое, что читается в строке, - что цель ещё не сделана. Ложным зелёным был бы
             * прогон, назвавший успехом недостигнутую цель молча. */
            try {
              await push({
                runs: [{
                  id: runId,
                  kind: 'agent',
                  goal: text,
                  model: await desktopModel().catch(() => 'claude-opus-5'),
                  outcome: ok ? 'ok' : 'failed',
                  summary: note,
                  error: ok ? null : note,
                  steps: result.steps,
                  said: commentary.slice(0, 200),
                  startedAt,
                  finishedAt: new Date().toISOString(),
                }],
              });
              await reload();
            } catch (_) {
              // Расписание поставлено, и это важнее строки в журнале.
            }
            return;
          }

          updateLive((t) => ({
            ...t,
            state: result.ok ? 'ok' : 'failed',
            note: result.ok ? result.said ?? 'Done.' : result.error ?? 'It stopped without finishing.',
          }));

          /* Сказать вслух, если вкладка не на виду. До записи прогона на аккаунт: сеть может отвечать
           * секунды, а человек ждёт ответа, а не журнала. */
          void announceFinished({
            outcome: result.ok ? 'ok' : /^stopped$/i.test(result.error ?? '') ? 'stopped' : 'failed',
            said: result.ok ? result.said ?? null : result.error ?? null,
            port: state.port,
            bringForward,
          });

          /* The model that ACTUALLY drove the run - the same cached answer the engine resolved on its way
           * in - never a constant. The old hardcoded string meant a model change made every logged run lie,
           * and the chat assistant then reported the lie back with confidence. */
          const loggedModel = await desktopModel().catch(() => 'claude-opus-5');
          /* Один id на две вещи: строку прогона и скилл, который из неё сделают. Считался он раньше прямо
           * в теле push(), и «сделать скилл из этого прогона» тогда не на что было бы сослаться. */
          const runId = `dr_${startedAt.replace(/\D/g, '').slice(-12)}`;
          /* Logged to the account, best effort: the sidebar's hours, the Hours screen and the Insights page
           * are built from runs, so a desktop run that went unrecorded would make them quietly wrong. */
          try {
            await push({
              runs: [{
                id: runId,
                kind: 'agent',
                goal: text,
                model: loggedModel,
                outcome: result.ok ? 'ok' : /^stopped$/i.test(result.error ?? '') ? 'stopped' : 'failed',
                summary: result.said ?? result.error ?? null,
                error: result.ok ? null : result.error ?? null,
                steps: result.steps,
                /* Сошлись ли утверждения - отдельной колонкой, а не внутри исхода: прогон может выполниться
                 * целиком и при этом обнаружить, что продукт ведёт себя не так. См. db/019. */
                checks: result.checks ?? null,
                /* Обрезано так же, как режет api/sync.js: он берёт первые 200 в любом случае, и отправлять
                 * больше значило бы отправить то, что заведомо выбросят. */
                said: commentary.slice(0, 200),
                startedAt,
                finishedAt: new Date().toISOString(),
              }],
            });
            await reload();
            /* Ставится ПОСЛЕ успешного push: до него прогона на аккаунте нет, а скилл ссылается на него как
             * на своё свидетельство. Ссылка на строку, которой не существует, - это не половина связи, это
             * сломанная связь, и обнаружится она через неделю у другого человека. */
            if (result.ok) {
              /* Окна СПРАШИВАЮТСЯ у машины, а не берутся из фида: фид - это то, что модель решала, а
               * origins скилла - это где он применим. Не ответила - пустой список, потому что скилл без
               * origins просто не сужен, а скилл с выдуманными origins врёт. */
              const where = await windows(state.port)
                .then((r) => r.windows.map((w) => w.title).filter(Boolean))
                .catch(() => [] as string[]);
              updateLive((t) => ({
                ...t, proved: { runId, steps: result.steps, windows: where, at: startedAt },
              }));
            }
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

  /* Высоту страницы даёт оболочка, а не собственная копия числа - см. Surface.tsx. Копия здесь и была
   * третьей, о которой тот файл писал, и она же была неверной на тринадцать пикселей. */
  const page = usePageChrome();

  const engine = target === 'desktop'
    ? health ? `agent ${health.version}${stale ? ' · out of date' : ''}` : 'agent offline'
    : extension.present ? `extension ${extension.version ?? ''}` : 'extension not found';

  /* Есть ли план ИМЕННО для того текста, что сейчас в поле. Спрашивают об этом трое - карточка плана, сама
   * кнопка и стрелка выбора рядом с ней, - и это должно быть одним значением: пока каждый считал сам,
   * кнопка могла говорить одно, а клавиша делать другое, что и произошло. Дописал слово к уже построенному
   * плану - план перестал быть про эту формулировку, и все трое узнают об этом разом. */
  /* ДВЕ ПРАВКИ НАД УЖЕ ЗАПИСАННЫМ ПРОГОНОМ, обе через тот же push, что и всё остальное на этой странице.
   *
   * Бросают, а не возвращают ok/не-ok: у обеих ровно один вызывающий, и ему нужно показать причину рядом с
   * той строкой, которую правили. `problems` в ответе - это то, что сервер отказался сделать при HTTP 200
   * (например, «такого прогона на этом аккаунте нет»), и молча проглотить его значило бы нарисовать
   * успех - строка вернулась бы на место при следующей перезагрузке аккаунта, и никто бы не понял почему.
   *
   * reload() ПОСЛЕ, а не оптимистично: список читается с аккаунта, и второй, местной копии, которая могла
   * бы с ним разойтись, у этой страницы нет - см. заголовок Earlier.tsx. */
  const renameRun = useCallback(async (id: string, name: string | null) => {
    const saved = await push({ renamedRuns: [{ id, name }] });
    if (saved.problems?.length) throw new Error(saved.problems[0]);
    await reload();
  }, [reload]);

  const deleteRun = useCallback(async (id: string) => {
    const saved = await push({ deletedRuns: [id] });
    if (saved.problems?.length) throw new Error(saved.problems[0]);
    await reload();
  }, [reload]);

  /* Прогоны, показанные живьём в этой же сессии. Считается один раз на оба вида истории - колонку и
   * ленту, - чтобы они не могли разойтись в том, что уже показано. */
  const earlierHide = useMemo(
    () => new Set(turns.map((t) => t.proved?.runId).filter(Boolean) as string[]),
    [turns],
  );

  const planned = !!plan && plan.for === goal.trim();

  /* ЧТО СЕЙЧАС СДЕЛАЕТ КНОПКА - и, значит, что сделает Enter, потому что это одно и то же действие.
   *
   * Пока план уже построен для этой формулировки, выбирать нечего: карточка плана на экране, и нажатие
   * его запускает. В остальное время решает переключатель. */
  const wants: StartWith = planned ? 'run' : startWith;

  /* То, что делает кнопка, и то, что делает Enter, - одно выражение. Пока их было два, они разошлись. */
  const act = () => (wants === 'run' ? send() : makePlan());

  return (
    /* Two columns on a wide window: what is happening now, and what happened before. The shell gives this
     * route a header and nothing else, so each column owns its own height and scrolls on its own.
     *
     * The right one used to hold a thumbnail of the desktop - see EarlierPanel for why it does not any
     * more. Below xl there is no second column at all, and the history moves to the top of the thread. */
    <div className={cn('flex gap-4', page.height)}>
      <div className="flex min-w-0 flex-1 flex-col">
      <Thread>
        {/* ЧТО БЫЛО РАНЬШЕ - наверху ленты, из записи на аккаунте, а не из второй копии рядом с ней.
          *
          * ТОЛЬКО НА УЗКОМ ОКНЕ. С xl та же история стоит колонкой справа, где она видна сразу и не
          * соревнуется за место с тем, что происходит сейчас; ниже xl колонки нет вовсе, и без этой ленты
          * история стала бы недостижимой на ноутбуке поменьше. Один источник, два вида - см. run-history.ts.
          *
          * Развёрнуто, когда живых ходов нет: человек, открывший пустую страницу Create, пришёл либо
          * начать новое, либо найти старое. Свёрнуто, когда он уже работает.
          *
          * `hide` - прогоны, показанные живьём в этой же сессии. После удачного прогона страница
          * перечитывает аккаунт, и без этого он появился бы в ленте дважды: один раз как ход, второй раз
          * как история этого же хода. */
        <div className="xl:hidden">
          <Earlier
            runs={runs}
            flows={flows}
            hide={earlierHide}
            openByDefault={turns.length === 0}
            onAskAgain={setGoal}
            onSaveAsSkill={(run, goal) => setSaving({ run, goal })}
            onRename={renameRun}
            onDelete={deleteRun}
          />
        </div>}

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
                  meta={`${turn.byItself
                    ? (turn.byItself.scheduleId ? 'by itself, from a schedule' : 'by itself, asked from a chat')
                    : turn.target === 'desktop' ? 'on this computer' : 'in this browser'} · ${
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
                          : event.type === 'check'
                            /* Три исхода, три вида: «проверить не удалось» - не «не прошло». */
                            ? (event.pass === true ? 'pass' : event.pass === false ? 'fail' : 'unchecked')
                            : event.type === 'error' ? 'error'
                              : event.type === 'wave' ? 'wave'
                                : event.type === 'handoff' ? 'handoff'
                                  : 'say'
                      }
                    >
                      {event.type === 'tool'
                        ? (
                          <>
                            {describe(event, health?.platform)}
                            {/* Читается только когда есть что читать. Разбивка нужна тому, кто смотрит на
                              * бегущий прогон и думает «почему так медленно» - и отвечает она сразу: почти
                              * всё время уходит на решение, а не на картинку. */}
                            {event.spent && (
                              <span className="ms-1.5 text-ink-inactive tabular-nums">
                                {(event.spent.model / 1000).toFixed(1)}s
                                {event.spent.shot >= 100 && ` · shot ${(event.spent.shot / 1000).toFixed(1)}s`}
                              </span>
                            )}
                          </>
                        )
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

                  {/* ОТМЕНИТЬ - ЗДЕСЬ. «А как отменить флоу, который уже стал в очередь?» - спросил человек,
                    * глядя на карточку, которая отсылала его на страницу Skills. Отсылка - не кнопка. Отмена
                    * снимает расписание тем же DELETE, что и корзина на Skills; скилл-цель остаётся, и это
                    * сказано. Кнопки нет, когда расписание уже сработало: карточка прогона тогда - другая. */}
                  {turn.scheduled && turn.state === 'ok' && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        leftSlot={<Square className="size-4" />}
                        onClick={async () => {
                          const was = turn.scheduled!;
                          try {
                            await scheduleRemove(was.id);
                            setTurns((prev) => prev.map((t) => (t.id === turn.id ? {
                              ...t,
                              scheduled: undefined,
                              note: `Cancelled — nothing will run at ${was.nextSaid}. The skill it would have `
                                + 'run stays on the Skills page.',
                            } : t)));
                          } catch (err) {
                            setTurns((prev) => prev.map((t) => (t.id === turn.id ? {
                              ...t,
                              note: `It could not be cancelled: ${err instanceof Error ? err.message : 'the account did not answer'}. `
                                + 'It can also be removed on the Skills page.',
                            } : t)));
                          }
                        }}
                      >
                        Cancel it
                      </Button>
                      <Typography variant="span" className="text-[0.8rem] text-ink-inactive">
                        or pause and resume it on the Skills page
                      </Typography>
                    </div>
                  )}

                  {/* Появляется только на доказанном прогоне - и исчезает, когда скилл уже сделан, потому
                    * что второе приглашение сделать то же самое читается как «первое не сработало». */}
                  {turn.state === 'ok' && turn.proved && (
                    hasSkillForRun(flows, turn.proved.runId) ? (
                      <Typography variant="p" className="mt-2 text-ink-inactive text-[0.82rem]">
                        Saved as a skill.
                      </Typography>
                    ) : (
                      <div className="mt-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          leftSlot={<Sparkles className="size-4" />}
                          onClick={() => setSaving({ run: turn.proved!, goal: turn.goal })}
                        >
                          Save as skill
                        </Button>
                      </div>
                    )
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
                    // Through mediaType() for the same reason plan.ts does: `format` is already a full MIME type.
                    setGateShot(`data:${mediaType(picture.format)};base64,${picture.png}`);
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
      {plan && planned && (
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
        /* Справка под полем: бюджет шагов, версия агента, куда уходит речь. Ни одно из этого не решение,
         * которое принимают, набирая задачу - а в строке управления они выдавливали кнопку на второй ряд.
         *
         * Про Enter здесь больше ничего не написано, и это не упущение: пока разницу между кнопкой и
         * клавишей приходилось объяснять словами, разница и была багом. Теперь объяснять нечего - Enter
         * делает то, что написано на кнопке, а что там написано, выбирают стрелкой рядом с ней. */
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
            {/* ГДЕ ОКАЗЫВАЕТСЯ ЗВУК, сказанное до нажатия. Chrome по умолчанию отправляет речь на свои
              * серверы, а этот продукт обещает говорить, что уходит с машины - значит и это тоже.
              * Скачиваемый пакет предлагается как кнопка, потому что это единственное, что отделяет
              * человека от распознавания, которое никуда не отправляет. */}
            {dictation.supported && !running && (
              <span className="flex items-center gap-1.5">
                <Mic className="size-3.5" />
                {dictation.where === 'on-this-computer'
                  ? `dictation stays on this computer · ${langName(dictation.lang)}`
                  : dictation.where === 'downloadable' ? (
                    <>
                      {`dictation would go to Google · ${langName(dictation.lang)}`}
                      <button
                        type="button"
                        onClick={() => void dictation.install()}
                        className="underline underline-offset-2 hover:text-ink-body"
                      >
                        keep it on this computer
                      </button>
                    </>
                  ) : 'dictation is sent to Google to be recognised'}
                {/* ЯЗЫК ВЫБИРАЕТСЯ, а не берётся из браузера молча. `navigator.language` - это список
                  * предпочитаемых языков, а не язык, на котором говорят вслух: на первой же живой машине
                  * интерфейс был русский, а оттуда пришёл английский, и русская речь распозналась как
                  * английская. Выбор запоминается на этой машине. */}
                <select
                  value={dictation.lang}
                  onChange={(ev) => dictation.setLang(ev.target.value)}
                  aria-label="Language to dictate in"
                  className={cn(
                    'rounded border-stroke border bg-surface-card2 px-1 py-0.5 text-[0.72rem]',
                    'text-ink-body',
                  )}
                >
                  {dictation.choices.map((tag) => (
                    <option key={tag} value={tag}>{langName(tag)}</option>
                  ))}
                </select>
              </span>
            )}
            {/* A run is meant to be left alone - the agent drives the real desktop, so the tab is behind
              * other windows on purpose. A finish is therefore announced: the tab title changes and, if the
              * browser was allowed to, a system notification appears; clicking it brings this tab forward.
              *
              * This switch is the louder option, and off by default. A notification takes nothing away; an
              * activated window takes the focus - and doing that while somebody is typing in another
              * application is worse than a notification they missed. */}
            {target === 'desktop' && (
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={bringForward}
                  onChange={(ev) => wantsForward(ev.target.checked)}
                  className="size-3.5 accent-brand-primary"
                />
                switch to this tab when it finishes
              </label>
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

            {/* ОГРАНИЧЕНИЕ, а не контекст - и название теперь это говорит.
                *
                * Скриншот и список открытых окон уходят модели каждый шаг без всякой просьбы, так что «дать ей
                * посмотреть на экран» здесь нечего: это запрет уходить с окна, которое впереди. Поэтому он и
                * не может быть умолчанием - «открой мою почту и ответь Анне» стало бы невыполнимым, а окно,
                * которое впереди в момент нажатия, почти всегда наш же интерфейс, потому что задачу печатают
                * в браузере и кнопку жмут в браузере.
                *
                * Только для desktop: расширение целится в элементы страницы, и «это окно» для него не та
                * единица, в которой оно работает. */}
            {target === 'desktop' && (
              <button
                type="button"
                disabled={running}
                aria-pressed={pinScreen}
                title="Keep the work on whichever window is in front when you press Run — it will not launch or switch to anything else, and will stop and say so if what the task needs is not there. Leave it off when the task involves finding or opening something."
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
                Stay on this window
              </button>
            )}

            {/* Действие - у правого края. Раньше его отжимала туда справка, стоявшая между ним и тумблерами;
                справка ушла под поле, и кнопка съехала к настройкам, то есть перестала быть там, где её
                ищут. Обёртка на все три состояния сразу, чтобы четвёртое не пришлось вспоминать. */}
            <span className="ms-auto flex items-center gap-2">
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
              /* ОДНА КНОПКА, И НА НЕЙ НАПИСАНО, ЧТО ПРОИЗОЙДЁТ.
                 *
                 * Стрелка рядом - не второе действие, а выбор того, чем эта кнопка является. Пока плана нет,
                 * выбирать есть из чего; когда план уже на экране, выбора нет - карточка построена, и
                 * нажатие её запускает, - поэтому стрелка тогда и не показывается. Кнопка, которая
                 * предлагает выбор, ничего не меняющий, хуже, чем её отсутствие. */
              <span className="flex items-stretch">
                <Button
                  size="sm"
                  leftSlot={wants === 'run' ? <Send className="size-4" /> : <Sparkles className="size-4" />}
                  isLoading={planning}
                  disabled={!!blocked || !goal.trim()}
                  onClick={() => void act()}
                  className={cn(!planned && 'rounded-e-none')}
                >
                  {wants === 'run' ? 'Run it' : 'Plan it'}
                </Button>

                {!planned && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="sm"
                        aria-label="Choose what this button does"
                        disabled={!!blocked}
                        /* Тонкая грань между половинками, иначе это читается как одна широкая кнопка. */
                        className="rounded-s-none border-s border-s-black/25 px-1.5"
                      >
                        <ChevronDown className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    {/* Вверх, потому что строка управления стоит у нижнего края окна. */}
                    <DropdownMenuContent align="end" side="top">
                      <DropdownMenuRadioGroup
                        value={startWith}
                        onValueChange={(how) => wantsToStart(how as StartWith)}
                      >
                        {START_WITH.map((how) => (
                          <DropdownMenuRadioItem key={how.id} value={how.id} className="py-2">
                            <span className="flex min-w-0 flex-col">
                              <span className="font-semibold text-ink-primary">{how.label}</span>
                              <span className="text-[0.78rem] text-ink-inactive">{how.detail}</span>
                            </span>
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </span>
            )}

            {/* Микрофон стоит в одном ряду с остальным вводом, потому что это и есть ввод - другой способ
              * набрать то же поле. Прятать его, пока не спросили разрешение, было бы кнопкой, которая
              * появляется после того, как понадобилась. */}
            {dictation.supported && !running && (
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={dictation.listening}
                aria-label={dictation.listening ? 'Stop dictating' : 'Dictate the goal'}
                leftSlot={dictation.listening
                  ? <MicOff className="size-4" />
                  : <Mic className="size-4" />}
                onClick={() => (dictation.listening ? dictation.stop() : dictation.start())}
                className={cn(dictation.listening && 'text-fb-red-text')}
              >
                {dictation.listening ? 'Stop' : 'Dictate'}
              </Button>
            )}
            </span>
          </>
        }
      >
        <textarea
          value={goal}
          onChange={(ev) => setGoal(ev.target.value)}
          onKeyDown={(ev) => {
            /* Enter делает ровно то, что написано на кнопке - что бы там ни было написано.
             *
             * Раньше кнопка говорила «Plan it», а Enter отправлял; разницу объясняла строчка под полем.
             * Строчку читают один раз, а Enter жмут каждый раз - и человек, напечатавший задачу, по
             * привычке запускал агента по настоящему рабочему столу, ничего не подтвердив. Плана нет -
             * значит нет и чекпоинтов, то есть остановить его посреди дела нечем.
             *
             * Shift+Enter по-прежнему перевод строки. */
            if (ev.key !== 'Enter' || ev.shiftKey) return;
            ev.preventDefault();
            void act();
          }}
          disabled={running}
          rows={2}
          placeholder={running
            ? 'Working…'
            : dictation.listening
              ? 'Listening — say what it should do'
              : 'open my inbox and reply to Ann that the invoice is approved'}
          className={cn(
            'max-h-[9rem] min-h-[3rem] w-full resize-none bg-transparent px-1.5 py-1 text-ink-primary',
            'placeholder:text-ink-inactive focus:outline-none disabled:opacity-disabled',
          )}
        />

        {/* Ещё не решённое слово - отдельной строкой и приглушённо, а НЕ в самом поле.
          *
          * Промежуточный результат переписывается на каждом слоге. Дописывать его в цель значило бы, что
          * текст под курсором пляшет, пока человек говорит, и правìть его в этот момент невозможно. Сюда
          * попадает только то, что распознавание объявило окончательным. */}
        {dictation.listening && dictation.interim && (
          <Typography variant="p" className="px-1.5 text-ink-inactive text-[0.86rem] italic">
            {dictation.interim}
          </Typography>
        )}
        {dictation.problem && (
          <Typography variant="p" className="px-1.5 text-fb-red-text text-[0.82rem]">
            {dictation.problem}
          </Typography>
        )}
      </Composer>
      </div>

      {/* История прогонов. Своя высота и свой скроллер, чтобы длинный список не тянул ленту.
        *
        * Одинаковая для обоих исполнителей, в отличие от того, что здесь стояло раньше: прогон в браузере
        * и прогон на машине - это одна и та же просьба, записанная одной и той же строкой, и делить их
        * колонкой значило бы прятать половину своей истории за положением тумблера. */}
      <div className="hidden w-[24rem] shrink-0 py-4 pr-5 xl:flex xl:flex-col">
        <EarlierPanel
          runs={runs}
          flows={flows}
          hide={earlierHide}
          onAskAgain={setGoal}
          onSaveAsSkill={(run, goal) => setSaving({ run, goal })}
          onRename={renameRun}
          onDelete={deleteRun}
        />
      </div>

      {saving && (
        <SaveDictatedSkill
          run={saving.run}
          goal={saving.goal}
          onClose={() => setSaving(null)}
          onSaved={() => {
            setSaving(null);
            /* Перечитать аккаунт: hasSkillForRun() смотрит в `flows`, и без этого кнопка осталась бы на
             * месте до следующей загрузки страницы - предлагая сделать то, что только что сделали. */
            void reload();
          }}
        />
      )}
    </div>
  );
};
