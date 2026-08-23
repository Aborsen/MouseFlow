/* Who is signed in, and what is on their account.
 *
 * One place asks, everyone reads - the vanilla version had three separate fetches of /api/sync (the
 * sidebar's count, the Skills list, the Hours screen) which could and did disagree with each other.
 *
 * It also owns the wall: until there is an account, nothing else renders. That is a front door rather
 * than access control - the enforcement is in the API, which checks a session or a device token on every
 * request and cannot be talked out of it. A gate in a page is a suggestion; those checks are the rule.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { type Account, type Flow, type Run, pull, signOut, whoAmI } from '@/lib/api';
import { LANDINGS } from '@/features/auth/shared';

interface AccountValue {
  account: Account | null;
  flows: Flow[];
  runs: Run[];
  /* Whether the account has actually ANSWERED, as opposed to `flows` being empty because nothing has been
   * asked yet.
   *
   * The difference is not academic. Anything that compares this browser against the account has to know it -
   * the reconciliation read an empty `flows` on the first render and concluded that every local recording had
   * been deleted on another machine. They came back when the answer arrived, so the damage was invisible;
   * had the request failed, they would simply have gone. */
  loaded: boolean;
  /** True when the last read of the account failed. See the note where it is set. */
  readFailed: boolean;
  reload: () => Promise<void>;
  leave: () => Promise<void>;
  /** Why the last log-out did not happen, if it did not. Null while nothing has gone wrong. */
  leaveProblem: string | null;
}

/* The pages that are their own front door. Exported because two places need the same list: the wall, which
 * must not cover them, and the layout, which must not frame them in an app shell nobody is inside yet. */
export const AUTH_PATHS = ['/sign-in', '/sign-up', '/reset-password'];

export const isAuthPath = (path: string) => AUTH_PATHS.includes(path.replace(/\/+$/, '') || '/');

/* Pages that are readable with no account at all, and are NOT a way in.
 *
 * Different from AUTH_PATHS in the half that matters: an auth page is redirected AWAY from once somebody is
 * signed in, because a sign-in form shown to somebody who already has a session reads as having been logged
 * out. A public page is simply public - it renders the same either way.
 *
 * /mcp is here because of who reads it: somebody deciding whether to have an account, and the administrator
 * who will never sign in but has to approve connecting an AI to one. A wall in front of the page that
 * explains the product is a door that only opens from inside. */
export const PUBLIC_PATHS = ['/mcp'];

export const isPublicPath = (path: string) => PUBLIC_PATHS.includes(path.replace(/\/+$/, '') || '/');

/* Where to go after signing in, when something sent us here mid-flow.
 *
 * Exactly ONE destination is allowed: the OAuth consent page. Not "any same-origin path", not "anything
 * starting with a slash" - an open redirect is built out of a rule that sounds reasonable, and the only
 * thing that legitimately parks a person at the sign-in page and wants them back is /api/oauth?do=authorize.
 * Anything else falls through to the app, which is where a sign-in goes anyway. */
export function nextAfterSignIn(search: string): string | null {
  const asked = new URLSearchParams(search).get('next');
  if (!asked) return null;
  /* Two kinds of destination, and both are allowlisted rather than pattern-matched. The OAuth consent page
   * is the one thing outside the app that legitimately parks somebody at sign-in and wants them back. The
   * rest are this app's own pages, listed in one place shared with the sign-up view — the wall used to
   * render OVER whatever page you asked for, so there was nothing to carry; now that signing out sends you
   * to /sign-in, the page you were trying to reach has to travel with you or every sign-in ends on Record.
   *
   * An allowlist because `next` arrives in links anybody can write — an invitation email, a shared URL —
   * and "any path starting with a slash" is what an open redirect is built out of. */
  if (asked.startsWith('/api/oauth?')) return asked;
  return LANDINGS.includes(asked) ? asked : null;
}

const AccountContext = createContext<AccountValue | null>(null);

export const useAccount = () => {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount outside the provider');
  return value;
};

export const AccountProvider = ({ children }: { children: ReactNode }) => {
  const [account, setAccount] = useState<Account | null>(null);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [checked, setChecked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [readFailed, setReadFailed] = useState(false);

  const reload = useCallback(async () => {
    try {
      const body = await pull();
      setFlows(body.flows);
      setRuns(body.runs);
      /* The account's own answer about the person. Kept beside the flows because it arrives with them and
       * is needed at the same moment - the first render after signing in. */
      if (body.you) setAccount((was) => (was ? { ...was, prefs: body.you.prefs ?? {} } : was));
      /* Only on success. A failed read leaves `loaded` false, so nothing that compares the two sides runs at
       * all - which is the right answer: an account that could not be read has told us nothing about what it
       * holds. */
      setLoaded(true);
      setReadFailed(false);
    } catch (_) {
      /* Not worth a banner over the whole app - a blip on a page that is already showing everything would
       * be noise. But it IS worth recording, because on a machine with nothing in local storage a failed
       * read is indistinguishable from an empty account, and the honest difference between "you have no
       * recordings" and "yours could not be read" is the difference between shrugging and worrying. Whoever
       * would otherwise render "nothing here" asks this first. */
      setReadFailed(true);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const outcome = new URLSearchParams(location.search).get('auth');
      if (outcome) {
        // Cleared so a refresh does not repeat the message; anything else in the query is left alone.
        const rest = new URLSearchParams(location.search);
        rest.delete('auth');
        rest.delete('why');
        const query = rest.toString();
        history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
      }

      const me = await whoAmI();
      setAccount(me);
      setChecked(true);
      if (me) await reload();
    })();
  }, [reload]);

  const [leaving, setLeaving] = useState<string | null>(null);

  /* Log out, and CHECK.
   *
   * Both halves of this were missing and both mattered. signOut() swallowed every error, so a 403 from the
   * auth service was indistinguishable from success; and nothing read the session back afterwards, so even
   * an honest 200 was taken on trust. A sign-out response can succeed and still leave the browser signed in
   * - it clears cookies by name, path and partition, and any of those can fail to match the one that is
   * actually held. The only proof is asking who is signed in, after.
   *
   * The redirect only happens once that answer is nobody. Otherwise the message stays on screen next to the
   * button, which is the difference between a bug somebody can report and one that looks like nothing
   * happening. */
  const leave = useCallback(async () => {
    setLeaving(null);
    try {
      await signOut();
    } catch (err) {
      setLeaving((err instanceof Error ? err.message : 'the sign-out request failed')
        + ' \u2014 you are still signed in.');
      return;
    }

    const still = await whoAmI();
    if (still) {
      setLeaving('The sign-out was accepted but the session is still here, so you are still signed in. '
        + 'Closing the browser will end it; the session cookie is the thing that did not clear.');
      return;
    }
    location.href = location.origin + '/';
  }, []);

  /* A page the browser kept.
   *
   * Back and Forward can restore this app from the back/forward cache with its JavaScript frozen: no effect
   * runs again, so whatever it concluded about the session when it loaded is what it still shows. A page
   * restored from before a sign-in therefore shows the wall to somebody who now has a session - one half of
   * "press Back and it asks for the password again".
   *
   * Only that half is acted on. Reloading because the check came back EMPTY would be wrong: whoAmI answers
   * null for a network blip as readily as for a real sign-out, and taking a working app away over a blip is
   * worse than showing it a moment longer. Nothing leaks by waiting, either - the API checks the session on
   * every request and a page with no session gets nothing out of it. */
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted || account) return;
      void whoAmI().then((me) => { if (me) location.reload(); });
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [account]);

  const value = useMemo(
    () => ({ account, flows, runs, loaded, readFailed, reload, leave, leaveProblem: leaving }),
    [account, flows, runs, loaded, readFailed, reload, leave, leaving],
  );

  // Nothing renders while the answer is unknown: a flash of the app before the wall is worse than a pause.
  if (!checked) return null;

  /* The pages that EXIST to be seen signed out. Showing the wall over the sign-up page would be a door
   * that only opens from inside, and the reset link from an email lands here with no session by
   * definition. Matched on the real path rather than through the router, because this sits above it. */
  if (!account && (isAuthPath(location.pathname) || isPublicPath(location.pathname))) {
    return <>{children}</>;
  }

  /* Signed in, and looking at a door.
   *
   * Two ways to get here that both happen: Back onto a sign-in page the browser still has in history, and a
   * bookmark of /sign-in made before there was an account. Showing the form to somebody who already has a
   * session is the other half of "press Back and it asks for the password again" - the session was never
   * gone; the page simply asked. Replaced rather than pushed, so Back does not bounce between the two.
   *
   * A reset link is the exception: it arrives WITH a token, and whoever is holding one means to use it,
   * signed in or not. */
  if (isAuthPath(location.pathname) && !new URLSearchParams(location.search).get('token')) {
    /* Unless something is waiting to be finished. Somebody already signed in who arrives here from the OAuth
     * consent page has to be sent ON, not into the app - otherwise the flow they started ends silently at
     * the Record screen and the client that sent them waits forever. */
    location.replace(nextAfterSignIn(location.search) ?? '/record');
    return null;
  }

  /* Signed out: go to the sign-in PAGE, carrying where you were trying to get to.
   *
   * This used to render a sign-in card in place, leaving the address as /record — which meant the product
   * had two sign-in screens (that card, and /sign-in) with different designs, and the one people actually
   * met was the one with no address to link to, no way through to sign-up until recently, and a URL that
   * said "record" while showing a password field. One screen, at its own address, is the whole change.
   *
   * `replace` rather than assign, so Back does not bounce between the page and the door. */
  if (!account) {
    const to = new URLSearchParams();
    if (LANDINGS.includes(location.pathname)) to.set('next', location.pathname);
    /* A failed Google round trip comes back on whatever page it started from, carrying ?auth= and ?why=.
     * Those are the only words anybody gets about why it did not work, so they travel to the page that can
     * show them rather than being dropped on the way. */
    const asked = new URLSearchParams(location.search);
    for (const key of ['auth', 'why']) {
      const value = asked.get(key);
      if (value) to.set(key, value);
    }
    const query = to.toString();
    if (location.pathname !== '/sign-in') location.replace(`/sign-in${query ? `?${query}` : ''}`);
    return null;
  }

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
};
