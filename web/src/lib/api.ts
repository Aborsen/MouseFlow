/* The account: flows, runs, the gallery, and who is signed in.
 *
 * Same-origin throughout, so the session cookie travels by itself - which is the whole reason auth is
 * proxied through /api/auth/* rather than called at the issuer directly. Nothing here handles a token.
 */

export interface Flow {
  id: string;
  source: 'web' | 'desktop';
  kind: 'recorded' | 'created';
  name: string;
  description: string;
  origins: string[];
  created: string | null;
  updated?: string | null;
  /* МОЖЕТ НЕ ПРИЕХАТЬ - и тип об этом говорит, потому что молчащий тип здесь стоил бы часа чужой работы.
   *
   * Пока здесь стояло обязательное поле, каждое место, читающее payload записи, получало бы undefined
   * молча: публикация ушла бы пустой, переименование пришло бы на сервер без событий, «скопировать JSON»
   * скопировал бы ничто. Ни одно из них не выглядит как ошибка на экране. Сделав поле необязательным,
   * компилятор перечислил их все за секунду. */
  payload?: {
    version?: number;
    kind?: string;
    agent?: string;
    name?: string;
    events?: unknown[];
    windows?: { title: string; process: string }[];
  };
  /* НЕ ПРИСЛАЛИ - положительным признаком, а не отсутствием поля.
   *
   * Список перестал везти `events` записей: 28 записей на живом аккаунте это 3213КБ на каждую загрузку
   * приложения, а четыре скилла - 5КБ. Скиллы payload везут по-прежнему (их запускают прямо из списка);
   * записи - нет.
   *
   * Флаг именно положительный, потому что `payload.events === undefined` читается и как «не приехало», и
   * как «пусто», и место, которое перепутает их и запушит обратно, сотрёт час работы. Переименование в
   * Skills делает ровно `{ ...flow.payload, name }` - и Skills показывает записи тоже.
   *
   * Всё, что собирается ОТПРАВИТЬ payload обратно, обязано пройти через payloadOf(). Сервер это же
   * проверяет у себя (api/sync.js отказывается писать пустые events поверх непустых), потому что «клиент
   * не забудет» - надежда, а не гарантия. */
  payloadOmitted?: boolean;
  /** То, на чём принимают решения, не открывая payload. Отсутствует у ответа старого развёртывания. */
  summary?: {
    events: number;
    bytes: number;
    windows: { title: string; process: string }[];
    session: { id?: string; part?: number } | null;
    role: string | null;
    /* КОГДА события этой записи происходили - шестнадцать счётчиков по равным частям её длины.
     *
     * Здесь, а не в payload, потому что payload записей этот ответ намеренно не везёт, а столбец Signal
     * рисуется из событий - то есть для всякой записи с аккаунта ему было нечем рисовать. Шестьдесят байт
     * против нескольких сотен килобайт.
     *
     * null значит «формы нет» и НЕ значит «ничего не происходило»: дайджест мог быть ещё не посчитан. */
    shape?: number[] | null;
  };
}

export interface Run {
  id: string;
  kind: 'agent' | 'replay';
  goal: string | null;
  /* КАК ЧЕЛОВЕК НАЗВАЛ ЭТОТ ПРОГОН, если называл. Рядом с целью, а не вместо неё: цель - то, что
   * действительно ушло в работу, и её же посылает «Ask again». Переписывать её значило бы менять запись о
   * том, что произошло, ради подписи. Пусто - показывается цель. См. db/013_run_named.sql. */
  name?: string | null;
  model: string | null;
  flowId: string | null;
  outcome: 'ok' | 'failed' | 'stopped' | 'running';
  summary: string | null;
  error: string | null;
  extension: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Сошлись ли утверждения - отдельно от `outcome`, который говорит лишь, выполнилась ли процедура.
   *  Null у прогона, который ничего не проверял, и это большинство. См. db/019 и api/_expect.mjs. */
  checks?: { passed: number; failed: number; unchecked: number; tiers: Record<string, number> } | null;
  /* ЧТО ПРОГОН СДЕЛАЛ И ЧТО СКАЗАЛ. Обе колонки были на проводе с самого начала - api/sync.js отдаёт их в
   * том же ответе, - и обе не были объявлены здесь, поэтому единственный способ узнать, что они есть, был
   * прочитать SQL. Это и есть причина, по которой история прогонов год выглядела невозможной: данные
   * приезжали в браузер и молча выбрасывались типом.
   *
   * Форма шагов принадлежит тому, кто прогон записал: у десктопного цикла это {tool, input, ms}, у
   * расширения своя. Поэтому unknown[], а не выдуманный общий тип - см. looksLikeDesktopRun в Earlier. */
  steps?: unknown[];
  /** Слова прогона: попутные и итоговые. Пусто там, где сборка их не писала - см. api/insights.js. */
  said?: unknown[];
}

export interface Account {
  id: string;
  name?: string;
  email?: string;
  image?: string | null;
  /* Small facts about the person rather than their work - whether the introduction has been seen, so far.
   * Absent on the session read (/api/auth/get-session answers about identity); present on /api/sync, which
   * is what the app reads on its way in. */
  prefs?: Record<string, string>;
}

export interface Device {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/* Exactly what api/gallery.js hands out - read from the endpoint, not from memory, because the first
 * version of this interface said `author: string` and `published`, and the view then rendered an object
 * straight into JSX. React throws on an object child, which is a blank page with no clue on it. */
export interface GallerySkill {
  id: string;
  name: string;
  description: string;
  kind: 'recorded' | 'created';
  /** An object, not a name: the endpoint sends who published it and their picture. */
  author: { name: string; image: string | null };
  origins: string[];
  /** Names and types only: the author's example values do not leave api/gallery.js. */
  params: { name: string; type: string }[];
  installs: number;
  publishedAt: string;
  withdrawn: boolean;
  /* How many events a recorded skill holds. null on a created one, which has a goal instead of events -
   * distinct from 0, which would describe a recorded skill that does nothing. Absent on a listing from an
   * older deployment. */
  actions?: number | null;
  payload?: unknown;
}

class ApiError extends Error {
  status: number;

  /** The upstream's machine-readable code, when it sent one. Matching on prose is how a message change
   *  silently turns a handled failure into an unhandled one. */
  code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/* Two failure shapes reach this client, because it talks to two different things.
 *
 *   ours          { error: { type, message } }   - api/sync.js, api/insights.js, api/chat.js
 *   the auth one  { error: "Invalid callbackURL", code: "INVALID_CALLBACKURL" }
 *
 * Reading only the first is how the sign-in page came to show "HTTP 403" for a failure whose cause and fix
 * were both sitting in the body: `error` was a string, so `error.message` was undefined and the status-code
 * fallback fired. */
interface Failure {
  error?: { message?: string; type?: string; code?: string } | string;
  code?: string;
  message?: string;
}

function reasonOf(body: Failure | null, status: number): { message: string; code: string | null } {
  const error = body?.error;
  const fromString = typeof error === 'string' ? error : null;
  const fromObject = error && typeof error === 'object' ? error.message : undefined;
  return {
    message: fromString || fromObject || body?.message || `HTTP ${status}`,
    code: body?.code
      ?? (error && typeof error === 'object' ? error.code ?? error.type ?? null : null)
      ?? null,
  };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const body = (await res.json().catch(() => null)) as (T & Failure) | null;
  if (!res.ok) {
    const { message, code } = reasonOf(body, res.status);
    throw new ApiError(message, res.status, code);
  }
  return body as T;
}

/** Null when nobody is signed in - Better Auth answers null rather than erroring, and so does this. */
export async function whoAmI(): Promise<Account | null> {
  try {
    const body = await call<{ user?: Account } | null>('/api/auth/get-session');
    return body?.user ?? null;
  } catch (_) {
    return null;
  }
}

export async function signInWithGoogle(returnTo: string): Promise<string> {
  /* The callback lands on /api/auth/finish, which exchanges the one-time verifier for a session cookie -
   * only a server can do that - and sends the browser back where it started. */
  const body = await call<{ url?: string; message?: string }>('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'google',
      callbackURL: `${location.origin}/api/auth/finish?to=${encodeURIComponent(returnTo)}`,
    }),
  });
  if (!body.url) throw new Error(body.message ?? 'sign-in could not be started');
  return body.url;
}

/* Throws, like everything else here.
 *
 * It used to end in `.catch(() => ({}))`, and that one clause is why a broken sign-out looked like a working
 * one for as long as it did: the endpoint was answering 403 INVALID_ORIGIN, the error went in the bin, the
 * caller redirected, and the app came back still signed in. A sign-out that cannot report failure cannot be
 * debugged from the outside - there is nothing to see. */
export const signOut = () =>
  call<{ success?: boolean }>('/api/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

export const pull = () => call<{ ok: true; flows: Flow[]; runs: Run[]; you: Account }>('/api/sync');

/** One preference, remembered against the ACCOUNT rather than the browser. Best effort by design: a tour
 *  that shows twice because a write failed is a smaller harm than a page that will not load without it. */
export const setPref = (key: string, value: string) =>
  call<{ ok: true }>('/api/sync', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, value }),
  }).catch(() => undefined);

/* Ниже этого размера сжимать нечего: gzip небольшого объекта стоит асинхронного шага и экономит
 * килобайты. Записи, из-за которых всё это писалось, на два порядка больше. */
const COMPRESS_OVER_BYTES = 100_000;

/** Сжат ли этот браузер вообще умеет. Отсутствие - не ошибка, а старый браузер: payload поедет как был. */
const canCompress = () => typeof CompressionStream === 'function';

async function gzipToBase64(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  /* По кускам, а не String.fromCharCode(...bytes): развернуть мегабайтный массив в аргументы - это
   * переполнение стека ровно на тех записях, ради которых сжатие и делается. */
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/* ЗАПИСЬ ЕДЕТ СЖАТОЙ, и это не оптимизация, а то, что делает длинную запись возможной.
 *
 * Полтора часа работы - 34 722 события - весят 2098КБ в JSON. У платформы тело запроса ограничено 4.5МБ,
 * так что без сжатия потолок записи упирался бы в три часа независимо от того, какое число стоит на
 * сервере. События мыши повторяются почти дословно и жмутся примерно в десять раз (замерено на настоящих
 * записях аккаунта: 381КБ → 35КБ, 125КБ → 13КБ), так что шестичасовая запись едет мегабайтом.
 *
 * Сжимается ЗДЕСЬ, в единственном месте, откуда флоу уходят на аккаунт. Строитель payload'а один
 * (api/_flow-for.mjs) и четыре вызывающих; трогать его значило бы, что каждый из четырёх должен помнить
 * про сжатие, а забудет тот, который вызовут реже всех. */
async function packFlows(flows: unknown[]): Promise<unknown[]> {
  if (!canCompress()) return flows;
  return Promise.all(flows.map(async (flow) => {
    const row = flow as { payload?: unknown } | null;
    if (!row || !row.payload || typeof row.payload !== 'object') return flow;
    const text = JSON.stringify(row.payload);
    if (text.length < COMPRESS_OVER_BYTES) return flow;
    try {
      const { payload: _dropped, ...rest } = row as Record<string, unknown>;
      return { ...rest, payloadZ: await gzipToBase64(text) };
    } catch (_) {
      /* Не сжалось - едет как было. Отказаться отправлять то, что раньше отправлялось, было бы худшим
       * из возможных ответов на «не удалось сэкономить трафик». */
      return flow;
    }
  }));
}

/* ОДИН PAYLOAD, КОГДА ОН ДЕЙСТВИТЕЛЬНО НУЖЕН.
 *
 * Кэш на время жизни страницы: за один сеанс одну и ту же запись открывают, переименовывают и публикуют, и
 * возить два мегабайта трижды - это ровно та трата, ради устранения которой список перестал их возить.
 * Ключ - id и только id: payload меняется через push, а push сам чистит запись отсюда. */
const loaded = new Map<string, Promise<Flow['payload']>>();

export const fetchPayload = (id: string): Promise<Flow['payload']> => {
  const have = loaded.get(id);
  if (have) return have;
  const asked = call<{ ok: true; id: string; payload: Flow['payload'] }>(
    `/api/sync?flow=${encodeURIComponent(id)}`,
  ).then((body) => body.payload);
  loaded.set(id, asked);
  /* Неудача не кэшируется: сеть моргнула - следующая попытка должна быть попыткой, а не тем же отказом. */
  void asked.catch(() => loaded.delete(id));
  return asked;
};

/**
 * Payload этого флоу, откуда бы он ни взялся.
 *
 * ЧЕРЕЗ ЭТО ОБЯЗАН ИДТИ КАЖДЫЙ, кто собирается payload прочитать целиком или отправить обратно. Скилл
 * отдаёт свой сразу - он приехал со списком; запись догружается. Разница видна здесь и больше нигде, что и
 * есть смысл этой функции.
 */
export const payloadOf = async (flow: Flow): Promise<Flow['payload']> => {
  if (!flow.payloadOmitted && flow.payload) return flow.payload;
  return fetchPayload(flow.id);
};

export const push = async (payload: {
  flows?: unknown[];
  runs?: unknown[];
  deleted?: string[];
  /* Две операции над уже записанным прогоном. Не через `runs`: тот путь пишет прогон целиком и требует
   * всего, что о нём известно, а этим двум нужен только id. */
  renamedRuns?: { id: string; name: string | null }[];
  deletedRuns?: string[];
}) =>
  /* The shape api/sync.js actually sends. It used to say `saved: { flows, runs }`, which is not on the wire
   * at all - the counts are top-level - and nothing noticed because the only field anybody reads is
   * `problems`, which is top-level in both. A test reading `flows` off a real response is what found it. */
  call<{
    ok: true; flows: number; runs: number; deleted: number;
    renamedRuns: number; deletedRuns: number; problems: string[];
    /* Отметка, которую база поставила каждой записанной строке. Клиент кладёт ЕЁ вместо своего
     * `new Date()`: сервер сравнивает присланное `updated` со своим `updated_at`, и до этого поля две
     * стороны сравнения приходили с разных часов - браузер, отстающий от сервера, получал отказ навсегда,
     * и починить его было нечем.
     *
     * Необязательное: старый деплой этого не шлёт, и клиент тогда ведёт себя ровно как раньше. */
    stamped?: { id: string; updated: string }[];
  }>('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload.flows
      ? { ...payload, flows: await packFlows(payload.flows) }
      : payload),
  }).then((body) => {
    /* Что записали - то больше не то, что лежит в кэше. Чистится ПОСЛЕ ответа, а не до: отказ ничего не
     * изменил, и выбрасывать из-за него верный payload значило бы платить за неудачу лишним запросом. */
    for (const flow of payload.flows ?? []) {
      const id = (flow as { id?: unknown } | null)?.id;
      if (typeof id === 'string') loaded.delete(id);
    }
    for (const id of payload.deleted ?? []) loaded.delete(id);
    return body;
  });

/* ------------------------------------------------------------------ расписания
 *
 * Тонкие обёртки над /api/schedules. Форму строки задаёт сервер (см. `row` там), потому что местное время
 * следующего запуска считается по зоне РАСПИСАНИЯ, а не по зоне браузера, который его показывает: человек,
 * поставивший «09:00 Europe/Kiev» и открывший приложение в Лондоне, должен видеть киевские девять. */
export interface Schedule {
  id: string;
  flowId: string;
  label: string;
  rule: string;
  zone: string;
  nextAt: string | null;
  nextSaid: string | null;
  paused: boolean;
  pausedWhy: string | null;
  lastAt: string | null;
  lastSaid: string | null;
  runs: number;
  misses: number;
  fails: number;
}

export const schedules = () => call<{ ok: true; schedules: Schedule[] }>('/api/schedules');

/* Прогоны, которые машина делает САМА - по расписанию или по просьбе из чата, - и о которых страница иначе
 * не узнала бы. Шаги в форме десктопного цикла: {tool, input, ms}. */
export interface LiveJob {
  id: string;
  state: 'queued' | 'claimed' | 'done' | 'failed';
  ok: boolean | null;
  said: string | null;
  name: string;
  goal: string | null;
  scheduleId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  steps: { tool: string; input: Record<string, unknown>; ms?: { shot: number; model: number; act: number } }[];
}
export const liveJobs = () => call<{ ok: true; jobs: LiveJob[] }>('/api/mcp?live=1');

export const scheduleAdd = (body: {
  flowId: string;
  label?: string;
  every?: string;
  at?: string;
  days?: 'all' | 'weekdays';
  once?: string;
  zone?: string;
  arguments?: Record<string, unknown>;
}) => call<{ ok: true; schedule: Schedule }>('/api/schedules', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const schedulePause = (id: string, paused: boolean) =>
  call<{ ok: true; schedule: Schedule }>(`/api/schedules?schedule=${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paused }),
  });

export const scheduleRemove = (id: string) =>
  call<{ ok: true; deleted: true }>(`/api/schedules?schedule=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

export const devices = () => call<{ ok: true; devices: Device[] }>('/api/sync?tokens=1');

export const mintDeviceToken = (label: string) =>
  call<{ ok: true; token: string; device: Device }>('/api/sync?issue=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });

export const revokeDevice = (id: string) =>
  call<{ ok: true }>(`/api/sync?token=${encodeURIComponent(id)}`, { method: 'DELETE' });

/* Числа настоящие, и их четырнадцать, а не четыре. Маршрут удалял четыре таблицы из четырнадцати, что
 * держат содержимое человека, и отвечал «удалено всё»; теперь удаляет все и умеет это назвать. */
export const eraseAccount = () =>
  call<{
    ok: true;
    deleted: {
      flows: number; runs: number; devices: number; conversations: number; messages: number;
      preferences: number; queuedRuns: number; teamMemberships: number; teamShares: number;
      invitations: number; teamsClosed: number; connectors: number; withdrawn: number;
    };
    note: string;
  }>(
    '/api/account?erase=1',
    { method: 'DELETE' },
  );

/* ------------------------------------------------------------------ conversations with the assistant
 *
 * The page owns the ids. A conversation exists before it has ever been saved - somebody types a question,
 * the reply arrives, and only then is there anything worth keeping - so asking the server for an id first
 * would mean a round-trip before the first message could be attached to anything, and a failed round-trip
 * would mean a conversation that cannot be saved at all. Same reasoning as a recording's id.
 */
export interface ThreadRow {
  id: string;
  title: string;
  messages: number;
  created: string | null;
  updated: string | null;
}

/** What a reply was grounded on, as the page renders it. Opaque to the store; see api/chats.js. */
export interface StoredMeta {
  citations?: string[];
  used?: unknown[];
  usage?: { input?: number; output?: number } | null;
  provider?: string | null;
}

export interface StoredMessage {
  n: number;
  role: 'user' | 'assistant';
  text: string;
  meta: StoredMeta | null;
}

/** Distinctive enough not to collide across machines, short enough to read in a log. */
export const newThreadId = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const listChats = () =>
  call<{ ok: true; threads: ThreadRow[] }>('/api/chats').then((body) => body.threads ?? []);

export const readChat = (thread: string) =>
  call<{ ok: true; thread: ThreadRow; messages: StoredMessage[] }>(
    `/api/chats?thread=${encodeURIComponent(thread)}`,
  );

export const saveChat = (thread: string, title: string, messages: StoredMessage[]) =>
  call<{ ok: true; saved: number }>('/api/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ thread, title, messages }),
  });

/** Gone, not flagged: api/chats.js deletes the row and the messages go with it. A conversation has no sync
 * contract to keep a tombstone for, and a request to forget one should be honoured. */
export const deleteChat = (thread: string) =>
  call<{ ok: true; deleted: string }>(`/api/chats?thread=${encodeURIComponent(thread)}`, {
    method: 'DELETE',
  });

/* `total` counts the matches before the endpoint's own limit, so a page can say "50 of 148" instead of
 * calling the fifty that arrived the whole library. Optional: a deployment older than that count does not
 * send it, and the array length is then the only honest number. */
export const galleryList = (q?: string) =>
  call<{ ok: true; skills: GallerySkill[]; total?: number; shown?: number }>(
    `/api/gallery${q ? `?q=${encodeURIComponent(q)}` : ''}`,
  );

export const galleryGet = (id: string) =>
  call<{ ok: true; skill: GallerySkill }>(`/api/gallery?id=${encodeURIComponent(id)}`);

/* `source` travels beside the payload rather than inside it: a flow's own row carries which half made it,
 * the payload does not, and the gallery has to know - a desktop skill cannot run in a browser and the
 * extension now lists only what it can actually install. */
export const galleryPublish = (skill: unknown, source?: 'extension' | 'desktop') =>
  call<{ ok: true; skill: GallerySkill }>('/api/gallery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skill, source }),
  });

/* Take your own listing out of the gallery. `DELETE /api/gallery?id=…`, and the author check lives in the
 * endpoint's WHERE clause rather than in a branch, so this cannot take down somebody else's.
 *
 * IT IS NOT A DELETE, and the difference matters to whoever installed it: the row keeps its `withdrawn_at`
 * and every copy already installed goes on working. Withdrawing hides the listing; it does not reach into
 * other people's accounts.
 *
 * ALREADY GONE IS NOT A FAILURE. The endpoint answers 404 for "not your skill, or already withdrawn" - one
 * status for two cases, and from here they cannot be told apart - but somebody pressing Withdraw on a
 * listing that is no longer there wants the same outcome either way, and wants this app's record of it
 * cleared most of all. So a 404 comes back as `alreadyGone`, and anything else still throws.
 */
export const galleryWithdraw = async (id: string): Promise<{ ok: true; alreadyGone: boolean }> => {
  try {
    await call<{ ok: true; withdrawn: string }>(
      `/api/gallery?id=${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    return { ok: true, alreadyGone: false };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { ok: true, alreadyGone: true };
    throw err;
  }
};

/* ---------------------------------------------------------------------------- hours */

/** Hours a run took. Measured, not estimated - every run has a start and a finish. */
export function hoursOf(run: Run): number {
  if (!run.startedAt || !run.finishedAt) return 0;
  const ms = +new Date(run.finishedAt) - +new Date(run.startedAt);
  // A negative or absurd span means two machines' clocks disagreed; not worth propagating.
  return ms > 0 && ms < 12 * 3600 * 1000 ? ms / 3600000 : 0;
}
