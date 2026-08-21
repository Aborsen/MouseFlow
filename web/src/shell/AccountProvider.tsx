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
import { type Account, type Flow, type Run, pull, signInWithGoogle, signOut, whoAmI } from '@/lib/api';
import { SignInWall } from './SignInWall';

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
  reload: () => Promise<void>;
  leave: () => Promise<void>;
  /** Why the last log-out did not happen, if it did not. Null while nothing has gone wrong. */
  leaveProblem: string | null;
}

/* The pages that are their own front door. Exported because two places need the same list: the wall, which
 * must not cover them, and the layout, which must not frame them in an app shell nobody is inside yet. */
export const AUTH_PATHS = ['/sign-in', '/sign-up', '/reset-password'];

export const isAuthPath = (path: string) => AUTH_PATHS.includes(path.replace(/\/+$/, '') || '/');

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
  const [problem, setProblem] = useState<string | null>(null);

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
    } catch (_) {
      /* An account with nothing in it and an account that could not be read look the same from here, and
       * neither is worth a message over the top of the app. */
    }
  }, []);

  useEffect(() => {
    (async () => {
      const outcome = new URLSearchParams(location.search).get('auth');
      const why = new URLSearchParams(location.search).get('why');
      if (outcome && outcome !== 'ok') {
        /* `why` is what the auth service itself said, forwarded by /api/auth/finish. Shown rather than
         * summarised: "the attempt may have expired" was a guess this code was making on the user's
         * behalf, and it is the wrong guess on a phone, where the usual cause is the sign-in starting in
         * one browser and returning to another. */
        const detail = why ? ` (${why})` : '';
        setProblem(
          outcome === 'missing-verifier'
            ? 'Google came back without a verifier, so sign-in could not be completed.'
            : outcome === 'rejected'
              ? 'The sign-in service rejected this attempt' + detail + '. This usually means the sign-in '
                + 'started in one browser and came back in another - on a phone, opening the link in the '
                + 'same browser you started in is what fixes it. Trying again here is safe.'
              : `Sign-in did not complete (${outcome}${detail}).`,
        );
      }
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

  const value = useMemo(
    () => ({ account, flows, runs, loaded, reload, leave, leaveProblem: leaving }),
    [account, flows, runs, loaded, reload, leave, leaving],
  );

  // Nothing renders while the answer is unknown: a flash of the app before the wall is worse than a pause.
  if (!checked) return null;

  /* The pages that EXIST to be seen signed out. Showing the wall over the sign-up page would be a door
   * that only opens from inside, and the reset link from an email lands here with no session by
   * definition. Matched on the real path rather than through the router, because this sits above it. */
  if (!account && isAuthPath(location.pathname)) {
    return <>{children}</>;
  }

  if (!account) {
    return (
      <SignInWall
        problem={problem}
        onSignIn={async () => {
          const url = await signInWithGoogle(location.pathname + location.search + location.hash);
          location.href = url;
        }}
      />
    );
  }

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
};
