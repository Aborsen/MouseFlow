/* Something worth keeping between page loads, and whose it was.
 *
 * WHY THIS EXISTS. Recordings have always been on disk - lib/store.ts, read synchronously - which is why the
 * Record page opens with everything on it. The account's own answer did not: `flows`, `runs` and the team
 * list lived in React state only, so every reload started from nothing and sat on "Reading…" until the
 * network came back. Two cold functions end to end, measured at 0.9-1.4s, to show a list that had not
 * changed since the last look.
 *
 * WHOSE IT WAS IS PART OF THE RECORD, and it is the one thing here that is not convenience. The recordings
 * store is not keyed by person, and a cache of somebody's skills handed to the next person who signs in on
 * the same machine is not a slow page, it is a leak. So everything kept says which account it belonged to,
 * and a reader that cannot match it gets nothing.
 *
 * IT IS NEVER THE TRUTH, only the last thing that was true. Whoever reads this renders it and asks the
 * account anyway; nothing that COMPARES the two sides may treat it as an answer - see `loaded` in
 * AccountProvider, and the reconciliation bug its note describes.
 */

interface Kept<T> { forAccount: string; value: T }

/** What was kept under this key, or null - including when it belonged to somebody else. */
export function kept<T>(key: string, forAccount: string | null): T | null {
  if (!forAccount) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Kept<T> | null;
    if (!parsed || parsed.forAccount !== forAccount) return null;
    return parsed.value;
  } catch (_) {
    /* Private mode, a quota, or something older than this shape. All of them mean the same thing to a
     * caller - there is nothing kept - and none of them is worth failing a page load over. */
    return null;
  }
}

/** Keep this, against this account. Failure is silent: persistence is a nicety, the session still works. */
export function keep<T>(key: string, forAccount: string | null, value: T): void {
  if (!forAccount) return;
  try {
    localStorage.setItem(key, JSON.stringify({ forAccount, value } satisfies Kept<T>));
  } catch (_) { /* full, or private mode */ }
}

/** Drop it. Called on the way out, so the next person on this machine starts from nothing. */
export function forget(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (_) { /* nothing to do about it, and nothing depends on it */ }
}

/** The account's flows and runs, as `/api/sync` last answered them. */
export const KEPT_ACCOUNT = 'mouseflow.account';
/** The teams this account is in, as `/api/team` last listed them. */
export const KEPT_TEAMS = 'mouseflow.teams';
