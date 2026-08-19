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
  reload: () => Promise<void>;
  leave: () => Promise<void>;
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
  const [problem, setProblem] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const body = await pull();
      setFlows(body.flows);
      setRuns(body.runs);
    } catch (_) {
      /* An account with nothing in it and an account that could not be read look the same from here, and
       * neither is worth a message over the top of the app. */
    }
  }, []);

  useEffect(() => {
    (async () => {
      const outcome = new URLSearchParams(location.search).get('auth');
      if (outcome && outcome !== 'ok') {
        setProblem(
          outcome === 'missing-verifier'
            ? 'Google came back without a verifier, so sign-in could not be completed.'
            : outcome === 'rejected'
              ? 'The sign-in was rejected - the attempt may have expired. Try again.'
              : `Sign-in did not complete (${outcome}).`,
        );
      }
      if (outcome) {
        // Cleared so a refresh does not repeat the message; anything else in the query is left alone.
        const rest = new URLSearchParams(location.search);
        rest.delete('auth');
        const query = rest.toString();
        history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
      }

      const me = await whoAmI();
      setAccount(me);
      setChecked(true);
      if (me) await reload();
    })();
  }, [reload]);

  const leave = useCallback(async () => {
    await signOut();
    location.href = location.origin + '/';
  }, []);

  const value = useMemo(
    () => ({ account, flows, runs, reload, leave }),
    [account, flows, runs, reload, leave],
  );

  // Nothing renders while the answer is unknown: a flash of the app before the wall is worse than a pause.
  if (!checked) return null;

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
