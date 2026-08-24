/* Talking to the extension's service worker, typed.
 *
 * The panel is React and the worker is hand-written JavaScript in another world; between them is
 * `chrome.runtime.sendMessage` and a route table (`ROUTES` in extension/background.js). This is that
 * table's shape, written down once, so a screen cannot invent a command name or forget that every reply
 * carries `ok`.
 *
 * SIGNED OUT IS A FLAG, NOT AN ERROR STRING. The worker answers `{ ok: false, signedOut: true }` for any
 * command that needs an account, wherever in the UI it came from - so the panel can put the wall back up
 * without pattern-matching a sentence.
 */

export interface WorkerReply {
  ok: boolean;
  error?: string;
  signedOut?: boolean;
  [key: string]: unknown;
}

/** True in the extension, false when this page is opened in an ordinary tab - which is how it is looked at
 *  during development, and the panel has to survive that rather than throw on the first call. */
export const inExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

export async function ask<T extends WorkerReply = WorkerReply>(
  mf: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  if (!inExtension) {
    return { ok: false, error: 'not running inside the extension' } as T;
  }
  try {
    const res = await chrome.runtime!.sendMessage({ mf, ...extra });
    return (res ?? { ok: false, error: 'the worker did not answer' }) as T;
  } catch (err) {
    /* A worker that has been torn down answers nothing at all. Said as a sentence rather than left as a
     * rejected promise, because every caller here renders it. */
    return { ok: false, error: err instanceof Error ? err.message : 'the worker did not answer' } as T;
  }
}

/** Where the app is, for the parts of the sidebar that are not in here. */
export const APP_URL = 'https://mouseflowapp.vercel.app';

export const openApp = (path: string) => {
  const url = APP_URL + path;
  if (inExtension) void chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
};

/* The app's API, from a panel screen, exactly as the app writes it.
 *
 * `installApiBridge()` has already replaced fetch, so a relative /api path goes through the worker with the
 * device token attached. This is only the two lines of JSON handling every caller was about to write, and
 * the reason the panel's own screens stopped speaking a private command language: `app/read` was a second
 * vocabulary for "GET something from the account", and it went out of date the moment the real one arrived.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `the account answered ${res.status}`);
  }
  return body as T;
}
