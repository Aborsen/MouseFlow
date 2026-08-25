/* Who is signed in, and what is on their account.
 *
 * One place asks, everyone reads - the vanilla version had three separate fetches of /api/sync (the
 * sidebar's count, the Skills list, the Hours screen) which could and did disagree with each other.
 *
 * It also owns the wall: until there is an account, nothing else renders. That is a front door rather
 * than access control - the enforcement is in the API, which checks a session or a device token on every
 * request and cannot be talked out of it. A gate in a page is a suggestion; those checks are the rule.
 */
import {
  createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { type Account, type Flow, type Run, pull, signOut, whoAmI } from '@/lib/api';
import { type MailState, type TeamList, type TeamRow, callTeams } from '@/lib/teams';
import { KEPT_ACCOUNT, KEPT_TEAMS, forget, keep, kept } from '@/lib/kept';
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
  /* Whether `flows` and `runs` are worth putting on screen: because the account answered, or because the
   * last thing it answered was kept on disk.
   *
   * NOT the same question as `loaded`, and the difference is the whole reason both exist. Anything that
   * COMPARES this browser against the account asks `loaded` - the reconciliation, the tour - because a kept
   * answer is the last thing that was true and not a statement about now. Anything that merely RENDERS asks
   * this, because a list from four seconds ago beats "Reading…" for a second and a half. */
  known: boolean;
  /** True when the last read of the account failed. See the note where it is set. */
  readFailed: boolean;
  reload: () => Promise<void>;
  leave: () => Promise<void>;
  /** Why the last log-out did not happen, if it did not. Null while nothing has gone wrong. */
  leaveProblem: string | null;

  /* ------------------------------------------------------------------------------ teams
   *
   * The list this account is in, read ONCE and kept. Two screens asked for it independently - the Teams
   * page and the dashboard's scope picker - each with its own fetch and its own copy, so opening both read
   * it twice and coming back to either read it again. On the deployment that is 0.4-0.7s of function boot
   * plus two Neon round trips every time, spent on a list that had not changed, and the Teams page sat on
   * "Reading…" for all of it.
   *
   * `null` means NOT READ YET, and it is not the same as an empty array - which is the mistake the Skills
   * page made with `flows`. Nothing renders "you are not in a team" off a null.
   */
  teams: TeamRow[] | null;
  /** Whether an invitation would actually be delivered. Arrives with the list; only the Teams page reads it. */
  teamsMail: MailState | null;
  /** The endpoint's own words when the read failed, or null. `teams` stays null, so nothing claims emptiness. */
  teamsProblem: string | null;
  /** Read the list if nobody has yet. Called by `useTeams`; harmless to call again. */
  ensureTeams: () => Promise<void>;
  /** Read it again because something changed it - a team made, a member removed. The only thing that re-reads. */
  refreshTeams: () => Promise<void>;
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

/* The teams this account is in.
 *
 * A hook rather than a field on `useAccount`, because it does something on mount: the first screen that
 * asks starts the read. Reading `useAccount().teams` directly would hand back a null that nothing had
 * arranged to fill, which is the kind of API that works in whichever screen was tested first.
 *
 * `refresh` is for a change - a team made, a member removed. Nothing else re-reads; a list that expired on
 * a timer would put "Reading…" back for no reason anybody could see.
 */
export const useTeams = () => {
  const { teams, teamsMail, teamsProblem, ensureTeams, refreshTeams } = useAccount();
  useEffect(() => { void ensureTeams(); }, [ensureTeams]);
  return { teams, mail: teamsMail, problem: teamsProblem, refresh: refreshTeams };
};

export const AccountProvider = ({ children }: { children: ReactNode }) => {
  const [account, setAccount] = useState<Account | null>(null);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [checked, setChecked] = useState(false);

  /* What a Google round trip came back saying, read in a STATE INITIALISER — that is, during the first
   * render, before any effect runs.
   *
   * The effect below strips ?auth= and ?why= out of the address so a refresh does not repeat the message,
   * and it fires while `checked` is still false. The redirect to /sign-in only happens once `checked` is
   * true, which is afterwards — so reading the address there found nothing, and a failed sign-in bounced
   * back to a clean sign-in page with no reason on it. Which is precisely what "it reloads the login page
   * and nothing happens" looks like from the outside. Captured here, before anything can delete it. */
  const [arrived] = useState(() => {
    try {
      const q = new URLSearchParams(location.search);
      return { auth: q.get('auth'), why: q.get('why') };
    } catch (_) {
      return { auth: null as string | null, why: null as string | null };
    }
  });
  const [loaded, setLoaded] = useState(false);
  const [known, setKnown] = useState(false);
  const [readFailed, setReadFailed] = useState(false);

  /* What was kept, read ONCE and synchronously. It cannot be applied yet - it is keyed to an account and
   * nobody has said who this is - but reading it here means the answer is in hand the moment whoAmI does. */
  const [onDisk] = useState(() => ({
    account: (id: string | null) => kept<{ flows: Flow[]; runs: Run[] }>(KEPT_ACCOUNT, id),
    teams: (id: string | null) => kept<TeamList>(KEPT_TEAMS, id),
  }));

  /* Whose account the kept copies belong to. A ref because `keep` is called from callbacks that must not be
   * rebuilt when the account arrives, and because it is never rendered. */
  const accountId = useRef<string | null>(null);

  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [teamsMail, setTeamsMail] = useState<MailState | null>(null);
  const [teamsProblem, setTeamsProblem] = useState<string | null>(null);
  /* Whether the read has been STARTED, which is not the same question as whether it has finished, and is why
   * this is a ref and not state: two consumers mounting in the same commit would both see a `false` piece of
   * state and both fetch, and it must not cause a render of its own either. */
  const startedTeams = useRef(false);

  const refreshTeams = useCallback(async () => {
    startedTeams.current = true;
    try {
      const body = await callTeams<TeamList>('');
      setTeams(body.teams);
      setTeamsMail(body.mail ?? null);
      setTeamsProblem(null);
      keep(KEPT_TEAMS, accountId.current, body);
    } catch (err) {
      /* `teams` is left ALONE - null if it was never read, and the list that is on screen if it was. A failed
       * refresh after removing somebody should not blank the page it happened on, and it must never come out
       * as an empty array: "you are not in a team" is a different sentence from "that could not be read". */
      setTeamsProblem(err instanceof Error ? err.message : 'your teams could not be read');
    }
  }, []);

  /* LAZY on purpose. An account that never opens Teams or the dashboard should not pay for this, and most of
   * the app never mentions a team - putting it in the mount path would make every page load carry it. */
  const ensureTeams = useCallback(async () => {
    if (startedTeams.current) return;
    await refreshTeams();
  }, [refreshTeams]);

  /* What is done with a sync answer, in one place: the boot path and every later refresh apply it the same
   * way, and both keep it. Two copies of this drifted once already - see the file's opening note. */
  const applySync = useCallback((body: Awaited<ReturnType<typeof pull>>) => {
    setFlows(body.flows);
    setRuns(body.runs);
    /* The account's own answer about the person. Kept beside the flows because it arrives with them and
     * is needed at the same moment - the first render after signing in. */
    if (body.you) setAccount((was) => (was ? { ...was, prefs: body.you.prefs ?? {} } : was));
    setLoaded(true);
    setKnown(true);
    setReadFailed(false);
    keep(KEPT_ACCOUNT, accountId.current, { flows: body.flows, runs: body.runs });
  }, []);

  const reload = useCallback(async () => {
    try {
      applySync(await pull());
    } catch (_) {
      /* Not worth a banner over the whole app - a blip on a page that is already showing everything would
       * be noise. But it IS worth recording, because on a machine with nothing in local storage a failed
       * read is indistinguishable from an empty account, and the honest difference between "you have no
       * recordings" and "yours could not be read" is the difference between shrugging and worrying. Whoever
       * would otherwise render "nothing here" asks this first. */
      setReadFailed(true);
    }
  }, [applySync]);

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

      /* BOTH AT ONCE, and that is the whole of it: /api/sync does not need whoAmI's ANSWER in order to be
       * STARTED - it needs the session cookie, which the browser is already holding. Serialised, the app
       * waited out two cold functions end to end and the second could not begin until the first came back:
       * 0.9-1.4s measured before anything from the account could be on screen, against 0.4-0.7s for one.
       *
       * Judged in the old order, which is the part that must not change. `checked` still flips on whoAmI,
       * because that is the question the wall asks. And a 401 for a visitor with no session is not a failed
       * read - it is the expected answer to a question we should not have asked - so it is only ever looked
       * at when there turns out to have been somebody to ask for. */
      const syncing = pull().then((body) => ({ body }), () => null);

      const me = await whoAmI();
      setAccount(me);
      accountId.current = me?.id ?? null;
      setChecked(true);
      if (!me) return;

      /* The last answer, on screen now rather than in a second and a half. Only if it was THIS person's -
       * see lib/kept.ts - and `loaded` stays false, so the reconciliation still waits for the real one. */
      const before = onDisk.account(me.id);
      if (before) {
        setFlows(before.flows);
        setRuns(before.runs);
        setKnown(true);
      }
      const teamsBefore = onDisk.teams(me.id);
      if (teamsBefore) {
        setTeams(teamsBefore.teams);
        setTeamsMail(teamsBefore.mail ?? null);
      }

      const answer = await syncing;
      if (answer) applySync(answer.body);
      else setReadFailed(true);
    })();
  }, [applySync, onDisk]);

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
    /* Dropped on the way out, so the next person on this machine starts from nothing. The account key would
     * refuse to match theirs anyway - that is what it is for - but data nobody will ever read again has no
     * business sitting in a browser. */
    forget(KEPT_ACCOUNT);
    forget(KEPT_TEAMS);
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
    () => ({
      account, flows, runs, loaded, known, readFailed, reload, leave, leaveProblem: leaving,
      teams, teamsMail, teamsProblem, ensureTeams, refreshTeams,
    }),
    [
      account, flows, runs, loaded, known, readFailed, reload, leave, leaving,
      teams, teamsMail, teamsProblem, ensureTeams, refreshTeams,
    ],
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
     * show them — read from `arrived`, which captured them before the address was cleaned. */
    if (arrived.auth && arrived.auth !== 'ok') {
      to.set('auth', arrived.auth);
      if (arrived.why) to.set('why', arrived.why);
    }
    const query = to.toString();
    if (location.pathname !== '/sign-in') location.replace(`/sign-in${query ? `?${query}` : ''}`);
    return null;
  }

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
};
