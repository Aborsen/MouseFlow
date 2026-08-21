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
  payload: {
    version?: number;
    kind?: string;
    agent?: string;
    name?: string;
    events?: unknown[];
    windows?: { title: string; process: string }[];
  };
}

export interface Run {
  id: string;
  kind: 'agent' | 'replay';
  goal: string | null;
  model: string | null;
  flowId: string | null;
  outcome: 'ok' | 'failed' | 'stopped' | 'running';
  summary: string | null;
  error: string | null;
  extension: string | null;
  startedAt: string | null;
  finishedAt: string | null;
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

export const push = (payload: { flows?: unknown[]; runs?: unknown[]; deleted?: string[] }) =>
  /* The shape api/sync.js actually sends. It used to say `saved: { flows, runs }`, which is not on the wire
   * at all - the counts are top-level - and nothing noticed because the only field anybody reads is
   * `problems`, which is top-level in both. A test reading `flows` off a real response is what found it. */
  call<{ ok: true; flows: number; runs: number; deleted: number; problems: string[] }>('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
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

export const eraseAccount = () =>
  call<{ ok: true; deleted: { flows: number; runs: number; devices: number; withdrawn: number }; note: string }>(
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

export const galleryPublish = (skill: unknown) =>
  call<{ ok: true; skill: GallerySkill }>('/api/gallery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skill }),
  });

/* ---------------------------------------------------------------------------- hours */

/** Hours a run took. Measured, not estimated - every run has a start and a finish. */
export function hoursOf(run: Run): number {
  if (!run.startedAt || !run.finishedAt) return 0;
  const ms = +new Date(run.finishedAt) - +new Date(run.startedAt);
  // A negative or absurd span means two machines' clocks disagreed; not worth propagating.
  return ms > 0 && ms < 12 * 3600 * 1000 ? ms / 3600000 : 0;
}
