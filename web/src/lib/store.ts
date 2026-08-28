/* What this browser remembers, and how the app hears about the agent.
 *
 * Two small pieces of state, both of which used to be module-scoped variables in a 1000-line script:
 *
 *   the console   recordings, the flow being built, the agent port. Local to this browser, because a
 *                 recording is a draft until you keep it as a skill.
 *   the agent     whether it is answering, which version, how big the screen is. One poller, shared,
 *                 rather than every component asking - the old code had three polls at three cadences.
 *
 * Kept in hand-written hooks over a state library: two stores do not earn a dependency, and the shapes
 * here are the ones the old code already proved it needed.
 */
import { freeingOrder } from '../../../api/_quota.mjs';
import { summarize } from '../../../api/_macro.mjs';
import { useCallback, useEffect, useState } from 'react';
import { type AgentHealth, health, type LoopbackTrouble, loopbackTrouble, olderThan } from './agent';

const KEY = 'mouseflow';

export interface RecordedEvent {
  x: number;
  y: number;
  delayMs: number;
  action: string;
  /* Where this happened, when the agent could resolve it - the application, the window, and the name and
   * kind of the control under the pointer, read from the accessibility tree at the moment of the click.
   *
   * Present on clicks only: a pointer move has no target worth naming and there are hundreds of them. Absent
   * means NOT KNOWN, never "nothing there" - an elevated window is invisible to the agent, an Electron
   * application often names nothing, and a build older than this one resolved nothing at all. */
  context?: {
    app?: string;
    window?: string;
    control?: string;
    type?: string;
    /* What was actually hit, as the accessibility tree calls it, and what it sits in. Written by the agent
     * since 0.8.0 and read since the parser stopped dropping them: `role` is what lets an unnamed click say
     * "a button" instead of only coordinates, and `container` is what tells two identically-named rows
     * apart. Absent means not known, as everywhere else here. */
    role?: string;
    subrole?: string;
    container?: string;
    containerName?: string;
  };
}

export interface Recording {
  /* ВЗЯТО НА ВРЕМЯ, а не записано здесь.
   *
   * «Try in Record» кладёт чужой скилл - из Skills или из галереи - в консоль под `from_<id>`, чтобы его
   * можно было проиграть. Reconciler же считает любую местную запись без штампа, которой нет на аккаунте,
   * своей и никем не виденной, и на следующем такте отправляет её наверх: чужой скилл появлялся на аккаунте
   * человека как запись, которую он якобы сделал. Он её не делал, и в счётчиках дашборда ей не место.
   *
   * Отдельным полем, а не по приставке `from_`: приставка это деталь именования, и первый же, кто заведёт
   * вторую, унаследует не признак, а его отсутствие. */
  borrowed?: boolean;
  id: string;
  name: string;
  created: string;
  /* When recording BEGAN, stamped at the press.
   *
   * `created` is stamped when it STOPS - that is the moment the row is built - and for a sixty-four minute
   * recording the difference between the two is sixty-four minutes. The transcript can reckon the start by
   * subtracting the span it measured, and does when this is absent, but a number that was recorded beats a
   * number that was worked out: the subtraction also carries the gap between the last event and the press
   * that ended it.
   *
   * Optional because every recording made before this field existed has none, and because an IMPORTED
   * .mmmacro has no honest answer - the file says nothing about when the work happened. Absent stays
   * absent rather than being filled with the import's own clock. */
  startedAt?: string;
  events: RecordedEvent[];
  /* СОБЫТИЯ ЛЕЖАТ НА АККАУНТЕ, А НЕ ЗДЕСЬ - и это не потеря, а место хранения.
   *
   * Консоль пишется на диск ОДНОЙ строкой, а localStorage даёт около 5000КБ на весь origin. Четырёхчасовая
   * запись - 5850КБ сама по себе, то есть не помещается вовсе; и поскольку строка одна, одна такая запись
   * ломала запись ВСЕГО остального - штампа `syncedAt`, квитанции о синхронизации и любой другой записи,
   * сделанной в той же сессии.
   *
   * Поэтому при переполнении события самых больших записей, КОТОРЫЕ УЖЕ НА АККАУНТЕ, выкладываются из
   * слота, а строка остаётся: у неё есть имя, счётчики, окна и штамп. Возвращаются они с аккаунта по
   * требованию - см. api.fetchPayload.
   *
   * Записи БЕЗ штампа это не касается никогда: у неё нет второй копии, и выложить её события значит их
   * потерять. Если поместиться можно только за её счёт - не помещаемся и говорим об этом. */
  eventsOnAccount?: boolean;
  /* Числа, снятые с событий ПЕРЕД тем, как их выложили. Есть только у записи с `eventsOnAccount`.
   *
   * Иначе строка в таблице показала бы «0 событий, 0 кликов, 0 секунд» - и это было бы не «мы не знаем», а
   * НЕВЕРНОЕ ЧИСЛО, поданное как факт: ровно то, чего в этом продукте стараются не делать. Учить пять
   * потребителей отвечать «неизвестно» было бы хуже и дороже, чем один раз сохранить то, что известно. */
  summary?: { count: number; clicks: number; moves: number; durationMs: number };
  /** Which applications were in front while this was recorded, in first-touched order. */
  windows: { title: string; process: string }[];
  /* When the account last acknowledged this recording, or absent if it never has.
   *
   * The one fact that separates "this exists only here, send it up" from "this was deleted on another
   * machine, drop it" - and without it a two-way sync resurrects every delete, because api/sync.js clears
   * `deleted_at` on upsert. Absent on every recording made before this field existed; features/record/
   * reconcile.ts says what it does about that. */
  syncedAt?: string;
  /* How a replay of THIS recording should behave. On the recording rather than only on a flow step, so that
   * pressing Play on its row and adding it to a flow mean the same thing - which they did not when the row
   * had no answer to "how many times, how fast, does it loop". Optional because every recording made before
   * this existed has none, and the defaults are read through replayOf(). */
  replay?: { repeat: number; speed: number; loop: boolean };
}

export interface FlowStep {
  recordingId: string;
  repeat: number;
  speed: number;
  delayAfterMs: number;
}

/* A long session, as this browser remembers it: counts, never events.
 *
 * Sixteen half-hour parts is a few megabytes of events, and one origin gets about five for EVERY recording
 * together - so the events live on the account, which is where the transcript reads every recording from
 * anyway, and this is the receipt. The shape is defined in features/record/long-session.ts, next to the
 * arithmetic that explains why it exists; the store only has to persist it.
 *
 * `unknown[]` rather than the type: lib/ is below features/ here, and importing upward to name a field would
 * be the first such edge in this codebase. The one place that reads these casts once, on the way out. */
export interface Console {
  port: number;
  recordings: Recording[];
  /** Long recording sessions and their parts. See features/record/long-session.ts for the shape. */
  sessions: unknown[];
  /* What the last reconciliation with the account did.
   *
   * Kept because one of its outcomes has to be said out loud: recordings appearing is welcome, recordings
   * DISAPPEARING because another machine deleted them is something somebody needs told once. Null until a
   * reconciliation has run. */
  lastSync: {
    at: string;
    pulled: number;
    pushed: number;
    forgotten: number;
    left: number;
  } | null;
  flow: FlowStep[];
  startDelayMs: number;
  flowRepeat: number;
  flowForever: boolean;
}

const EMPTY: Console = {
  port: 8787,
  recordings: [],
  sessions: [],
  lastSync: null,
  flow: [],
  startDelayMs: 3000,
  flowRepeat: 1,
  flowForever: false,
};

/* ЧЬИ ЭТО ЗАПИСИ. По слоту на аккаунт, и указатель на последний - синхронно.
 *
 * lib/kept.ts уже носит и механизм, и предупреждение: «кэш чужих скилов, отданный следующему, кто вошёл на
 * этой машине, - это не медленная страница, это утечка». И там же сказано, что ЭТО хранилище по человеку
 * не ключуется. Последствие было хуже, чем показ чужого: Reconciler считает местную запись без штампа
 * работой того, кто сейчас вошёл, и отправляет её наверх - то есть записи A появлялись на аккаунте B.
 * Достаточно было, чтобы одна из них не проштамповалась (например, не влезла в потолок синхронизации),
 * а A вышел и B вошёл на том же ноутбуке.
 *
 * ПОЧЕМУ НЕ ПРОСТО «ЧИТАТЬ, КОГДА УЗНАЕМ, КТО ВОШЁЛ». Чтение здесь синхронное, на загрузке модуля, и
 * ровно поэтому страница Record открывается сразу со всем, что на ней есть. Ждать сессию значило бы
 * менять утечку на секунду ожидания для КАЖДОГО - при том, что общий браузер редок.
 *
 * Поэтому указатель. Пересечение аккаунтов случается по пути «A вышел → B вошёл», а выход - это наш
 * собственный код: он указатель стирает, и следующая загрузка начинает с пустого. Если A не выходил,
 * пересечения и нет - сессия по-прежнему его.
 *
 * И на всякий случай второй замок: claimStore() сверяет слот с настоящим id, когда тот приезжает, а
 * Reconciler до этого наверх ничего не шлёт. */
const WHO = 'mouseflow.who';
const slotFor = (id: string) => `${KEY}:${id}`;

/** Кем этот браузер пользовались в прошлый раз. Стирается выходом - см. AccountProvider.leave. */
function lastWho(): string | null {
  try { return localStorage.getItem(WHO); } catch (_) { return null; }
}

/** Чей слот сейчас в памяти. null - ничей: либо ещё не знаем, либо предыдущий вышел. */
let heldFor: string | null = null;

function readSlot(key: string): Console | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<Console>;
    return {
      ...EMPTY,
      ...saved,
      // Trusted only as far as its shape: this is data an older build wrote.
      recordings: Array.isArray(saved.recordings) ? saved.recordings : [],
      sessions: Array.isArray(saved.sessions) ? saved.sessions : [],
      lastSync: saved.lastSync && typeof saved.lastSync === 'object' ? saved.lastSync : null,
      flow: Array.isArray(saved.flow) ? saved.flow : [],
      port: Number.isFinite(saved.port) ? (saved.port as number) : 8787,
    };
  } catch (_) {
    return null;
  }
}

function read(): Console {
  const who = lastWho();
  if (who) {
    heldFor = who;
    const mine = readSlot(slotFor(who));
    if (mine) return mine;
  }
  /* Ничего под указателем - но под старым общим ключом может лежать то, что писали до этой правки.
   * Забирается ОДИН раз, тем, кто первым назовёт себя (см. claimStore): выбросить это значило бы стереть
   * чужие записи при обновлении, а раздавать всем подряд - то, что здесь и чинится. */
  return EMPTY;
}

/* One copy in memory, shared by every component that asks, so two lists of recordings can never disagree
 * about what is in them. */
let current = read();

/**
 * Кто это на самом деле - как только аккаунт ответил.
 *
 * Совпало с указателем - ничего не происходит, страница уже открыта с их записями. Не совпало - в памяти
 * оказывается ИХ слот, а чужой остаётся на диске нетронутым: человек, вернувшийся на этот ноутбук, найдёт
 * свои записи там, где оставил.
 */
export function claimStore(id: string | null): void {
  if (!id) return;
  if (heldFor === id) return;
  const mine = readSlot(slotFor(id));
  /* Наследство от сборки без слотов. Достаётся первому, кто назвался, и только если своего слота у него
   * ещё нет: сегодня эти записи видит КТО УГОДНО, кто откроет страницу, так что забрать их однажды - строго
   * лучше, чем оставить как есть, и ничего не теряет. */
  const legacy = mine ? null : readSlot(KEY);
  heldFor = id;
  try { localStorage.setItem(WHO, id); } catch (_) { /* private mode */ }
  if (legacy) { try { localStorage.removeItem(KEY); } catch (_) { /* ignore */ } }
  commit(mine ?? legacy ?? EMPTY);
}

/** Чей слот сейчас в памяти. Reconciler спрашивает это, прежде чем что-либо отправить. */
export const storeHeldFor = (): string | null => heldFor;

/** На выходе: в памяти пусто, указателя нет, диск не тронут. */
export function releaseStore(): void {
  heldFor = null;
  try { localStorage.removeItem(WHO); } catch (_) { /* private mode */ }
  commit(EMPTY);
}
const listeners = new Set<() => void>();

/* ЧТО СЛУЧИЛОСЬ С ЗАПИСЬЮ НА ДИСК, если что-то случилось.
 *
 * Раньше здесь стоял пустой catch с комментарием «только персистентность потеряна». Это было неправдой
 * дважды: терялась не только персистентность этой записи, но и всего, что писалось после неё, - слот один,
 * и одна непомещающаяся запись роняла каждую следующую попытку; и «потеряна» никому не сообщалось, так что
 * человек узнавал об этом, перезагрузив вкладку и не найдя своих записей.
 *
 * НЕ персистится само - по определению: это факт про то, что записать не удалось. */
export type PersistTrouble =
  /** Диск не отвечает вовсе: приватный режим, отключённое хранилище. Размер тут ни при чём. */
  | { kind: 'no-storage' }
  /** Не поместилось. `freed` - записи, чьи события выложены на аккаунт, чтобы поместилось остальное. */
  | { kind: 'too-big'; freed: string[]; stillFailing: boolean };

let trouble: PersistTrouble | null = null;

/** Что не так с диском прямо сейчас, или null. Экран читает это, чтобы сказать. */
export const persistTrouble = (): PersistTrouble | null => trouble;

function tryWrite(key: string, value: Console): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

/* ПРИВАТНЫЙ РЕЖИМ ИЛИ ПЕРЕПОЛНЕНИЕ - и отличить их по имени ошибки нельзя.
 *
 * Safari в приватном режиме бросает то же QuotaExceededError с квотой ноль, Firefox зовёт это
 * NS_ERROR_DOM_QUOTA_REACHED, а код 22 против 1014 отличается по браузерам. Надёжный вопрос один: а
 * КРОШЕЧНОЕ значение записывается? Не записывается - хранилища нет вообще; записывается - дело в размере. */
function storageWorks(): boolean {
  try {
    localStorage.setItem(PROBE, '1');
    localStorage.removeItem(PROBE);
    return true;
  } catch (_) {
    return false;
  }
}

const PROBE = 'mouseflow.probe';

/* НА ДИСК, И С ОТСТУПЛЕНИЕМ ВМЕСТО МОЛЧАНИЯ.
 *
 * Порядок отступления: самые большие записи, УЖЕ ЛЕЖАЩИЕ НА АККАУНТЕ, отдают свои события - по одной,
 * начиная с самой большой, пока не поместится. Что не отдаёт события НИКОГДА: запись без штампа. У неё нет
 * второй копии, и выложить её события значит их потерять - то есть сделать ровно то, ради предотвращения
 * чего всё это написано. Если поместиться можно только за её счёт, не помещаемся и говорим об этом.
 *
 * И НЕ «выбросить самые старые», хотя это короче: человек не давал согласия терять записи, а тот, кто
 * молча удаляет данные, чтобы влезть в квоту, второй раз доверия не получит. */
function persist(next: Console): void {
  if (!heldFor) return;
  const key = slotFor(heldFor);

  if (tryWrite(key, next)) { trouble = null; return; }

  if (!storageWorks()) { trouble = { kind: 'no-storage' }; return; }

  /* Правило - в api/_quota.mjs, чтобы его можно было ВЫПОЛНИТЬ в тесте: единственный запрет в нём стоит
   * между «освободили место» и «стёрли единственную копию чужой работы», а регулярка над исходником
   * сказала бы только, что функция похожа на правильную. */
  const freed: string[] = [];
  let attempt = next;
  for (const id of freeingOrder(next.recordings)) {
    freed.push(id);
    attempt = {
      ...attempt,
      recordings: attempt.recordings.map((rec) => (
        rec.id === id
          ? { ...rec, events: [], eventsOnAccount: true, summary: rec.summary ?? summarize(rec.events) }
          : rec
      )),
    };
    if (tryWrite(key, attempt)) {
      /* В памяти события ОСТАЮТСЯ: выложено то, что на диске, а не то, что в руках. Вкладка, которую не
       * перезагружали, работает как работала. */
      trouble = { kind: 'too-big', freed, stillFailing: false };
      return;
    }
  }

  trouble = { kind: 'too-big', freed, stillFailing: true };
}

function commit(next: Console) {
  current = next;
  /* В слот того, чьё это. Пока никто не назвался, на диск не пишется вовсе: запись, сделанная до того,
   * как аккаунт ответил, не знает, чья она, и класть её в общий ключ значило бы завести ровно ту кучу,
   * из-за которой всё это переписано. В памяти она есть и никуда не денется - claimStore её сохранит. */
  persist(next);
  for (const listener of listeners) listener();
}

export function useConsole() {
  const [, bump] = useState(0);

  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const update = useCallback((patch: Partial<Console> | ((prev: Console) => Partial<Console>)) => {
    const next = typeof patch === 'function' ? patch(current) : patch;
    commit({ ...current, ...next });
  }, []);

  return [current, update] as const;
}

export const consoleState = () => current;

/* ------------------------------------------------------------------------- the agent, polled once */

export interface AgentStatus {
  health: AgentHealth | null;
  /** Running, but older than this app expects: it will fail in ways that look like bugs. */
  stale: boolean;
  /** How many polls in a row have failed - used to slow down rather than hammer a machine with no agent. */
  failures: number;
  /** Whether anything has been asked yet. False means "not looked", which is not "not there". */
  asked: boolean;
  /** Why the last look failed, when the browser rather than the machine is the reason. */
  trouble: LoopbackTrouble | null;
}

/* WHETHER THE FIRST LOOPBACK CALL MAY HAPPEN ON ITS OWN.
 *
 * On a public origin - the deployed app - Chrome 142+ raises a permission prompt for the first request to
 * 127.0.0.1. A prompt raised by a background health poll is a prompt with no visible cause: it appears on
 * page load, beside nothing the user did, and dismissing it is the obvious move. Dismissed once it becomes
 * `denied`, every later request fails instantly with no prompt at all, and the app says "Agent offline"
 * for a machine whose agent answers curl perfectly well. There is no way back from inside the page.
 *
 * So nothing is polled until a gesture asks for it — WHEN A PROMPT COULD ACTUALLY APPEAR. That last part is
 * the whole condition, and leaving it out is a bug of its own: somebody who granted the permission weeks ago
 * has nothing to be prompted about, and making them press a button on every page load to be told what the
 * browser already knows is friction with no purpose. It also reads as broken — a pill saying "Check for
 * agent" beside a running agent looks like a failure, not like a question.
 *
 * Two cases need no gesture, and both mean "no prompt can be raised":
 *
 *   A LOOPBACK PAGE. Loopback talking to loopback is the same address space; no permission exists to ask
 *   for. Making development wait for a click would be waiting for something that is never coming.
 *
 *   AN ALREADY-GRANTED PERMISSION, which the browser will tell us before we ask for anything. `granted` is
 *   the one state the query answers reliably — the unreliable direction is `denied`, which it reports both
 *   before anyone has been asked and on loopback pages where requests demonstrably work. Reading it to
 *   decide "no prompt is coming, go ahead" is safe; reading it to decide "do not bother trying" is not, and
 *   is why this never gates a call, only releases one.
 */
const sameAddressSpace = () =>
  /^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost)$/i.test(location.hostname);

let armed = sameAddressSpace();

let status: AgentStatus = {
  health: null, stale: false, failures: 0, asked: armed, trouble: null,
};
const watchers = new Set<() => void>();
let timer: number | null = null;

async function poll() {
  const port = current.port;
  try {
    const body = await health(port);
    status = { health: body, stale: olderThan(body.version), failures: 0, asked: true, trouble: null };
  } catch (_) {
    /* Asked only on the FIRST failure of a run. The answer cannot change while the failures continue -
     * a granted permission does not un-grant itself mid-poll - and asking on every tick would query a
     * permission every two seconds for as long as the machine has no agent. */
    const trouble = status.trouble ?? await loopbackTrouble();
    status = { health: null, stale: false, failures: status.failures + 1, asked: true, trouble };
  }
  for (const watcher of watchers) watcher();

  /* Eager while it matters - answering, or a run of failures short enough that someone is probably still
   * setting up - and slow otherwise, because a machine with no agent should not be polled every two
   * seconds forever. */
  const eager = status.health !== null || status.failures < 8;
  timer = window.setTimeout(poll, eager ? 2000 : 15000);
}

export function useAgent(): AgentStatus {
  const [, bump] = useState(0);

  useEffect(() => {
    const watcher = () => bump((n) => n + 1);
    watchers.add(watcher);
    /* `armed`, not just "no timer yet": mounting this hook is not a gesture. On the deployed app the first
     * request waits for askAgent(), which a button calls — unless the browser says no prompt is coming. */
    if (timer === null && armed) {
      timer = window.setTimeout(poll, 0);
    } else if (!armed) {
      armIfNothingToAsk();
    }
    return () => {
      watchers.delete(watcher);
      if (watchers.size === 0 && timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, []);

  return status;
}

/* Ask now rather than waiting for the next tick - after starting the agent, say.
 *
 * Does nothing while unarmed, so the "no loopback call before a gesture" rule holds however this is
 * called. Every caller today IS inside a gesture; making the rule depend on that staying true is how it
 * would quietly stop being true. Use askAgent() to look for the first time. */
export function refreshAgent() {
  if (!armed) return;
  if (timer !== null) clearTimeout(timer);
  timer = window.setTimeout(poll, 0);
}

/* Look for the agent because somebody asked to.
 *
 * MUST BE CALLED FROM A GESTURE on the deployed app, because the permission prompt it may raise is only
 * comprehensible while the user still remembers pressing something. Calling it from an effect would put
 * back exactly the bug this arrangement removes.
 *
 * Idempotent, and it also clears the remembered trouble: someone who has just granted the permission and
 * pressed the button again is owed a fresh answer, not the reason the last attempt failed.
 */
/* Release the first call when the browser has already told us no prompt is coming.
 *
 * Asked once per page, and only ever ARMS - it never disarms, never reports a failure, and never stops a
 * later gesture from doing what it would have done anyway. `silent` is what loopbackTrouble() answers for a
 * granted permission and for a browser that has no such permission to grant; both mean nothing can pop up.
 */
let probedPermission = false;
function armIfNothingToAsk() {
  if (armed || probedPermission) return;
  probedPermission = true;
  void loopbackTrouble().then((verdict) => {
    if (verdict === 'silent' && !armed) askAgent();
  });
}

export function askAgent() {
  armed = true;
  status = { ...status, trouble: null };
  refreshAgent();
}

/** Whether the first look is still waiting on a gesture. */
export const agentArmed = () => armed;

export const uid = () => 'r' + Math.random().toString(36).slice(2, 10);
