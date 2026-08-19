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
}

export interface Device {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface GallerySkill {
  id: string;
  name: string;
  description: string;
  kind: 'recorded' | 'created';
  author: string;
  installs: number;
  published: string;
  payload?: unknown;
}

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (!res.ok) {
    throw new ApiError(body?.error?.message ?? `HTTP ${res.status}`, res.status);
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

export const signOut = () =>
  call<{ ok?: boolean }>('/api/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => ({}));

export const pull = () => call<{ ok: true; flows: Flow[]; runs: Run[]; you: Account }>('/api/sync');

export const push = (payload: { flows?: unknown[]; runs?: unknown[]; deleted?: string[] }) =>
  call<{ ok: true; saved: { flows: number; runs: number }; problems: string[] }>('/api/sync', {
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

export const galleryList = (q?: string) =>
  call<{ ok: true; skills: GallerySkill[] }>(`/api/gallery${q ? `?q=${encodeURIComponent(q)}` : ''}`);

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
