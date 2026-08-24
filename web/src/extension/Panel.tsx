/* The side panel: the rail, one screen at a time, and the wall in front of both.
 *
 * WHY A SIDE PANEL AND NOT THE POPUP. A popup closes the moment somebody clicks the page. Two of the three
 * things in here - recording a flow, and describing one while looking at it - ARE clicking the page, so on
 * the old surface they could only be watched until the first interesting thing happened. The popup is still
 * there and now does one thing: it opens this.
 */
import { useCallback, useEffect, useState } from 'react';
import { Typography } from '@insightis/ui/Typography';
import { Loader2 } from 'lucide-react';
import { Rail, type Screen } from './Rail';
import { RecordScreen } from './RecordScreen';
import { CreateScreen } from './CreateScreen';
/* THE APP'S OWN SCREENS, not panel-sized twins of them.
 *
 * This is what the adapter was built for. Skills lists everything on the account - the desktop half
 * included, which is what a browser panel could not otherwise show; the dashboard carries its sentences
 * and not only its numbers; teams are EDITED here rather than read and then opened somewhere else, which
 * is all a twin could ever offer.
 *
 * Record and Create stay the extension's own, and that is not an exception: they are not versions of the
 * app's screens at all. The app records through the desktop agent; this records through content scripts in
 * the page. Same word, different machine. */
import { RecordView } from '@/features/record/RecordView';
/* Pulls recordings the account has and this browser does not into the local store. The app mounts it in
 * its layout for the same reason it is here: a list that only fills when somebody visits the right page is
 * a list that is wrong until they do. Without it the panel's recordings screen is empty on an account full
 * of them, which is exactly what it was. */
import { Reconciler } from '@/features/record/Reconciler';
import { SkillsView } from '@/features/skills/SkillsView';
import { InsightsView } from '@/features/insights/InsightsView';
import { TeamView } from '@/features/team/TeamView';
import { GalleryView } from '@/features/gallery/GalleryView';
import { AccountProvider } from '@/shell/AccountProvider';
import { AssistantScreen } from './AssistantScreen';
import { SignInView } from '@/features/auth/SignInView';
import { SignUpView } from '@/features/auth/SignUpView';
import { Said } from '@/components/Said';
import { cn } from '@insightis/ui/cn';
import { ask, inExtension } from './worker';

/* Which screen was last open, kept across closings of the panel. A panel that always opened on Record
 * would be a panel that forgets what somebody was in the middle of. */
const LAST = 'mf.panel.screen';

export const Panel = () => {
  const [screen, setScreen] = useState<Screen>(
    () => (localStorage.getItem(LAST) as Screen) || 'record',
  );
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);
  const [door, setDoor] = useState<'in' | 'up'>('in');
  const [recordWhere, setRecordWhere] = useState<'browser' | 'desktop'>('browser');

  const go = useCallback((next: Screen) => {
    setScreen(next);
    localStorage.setItem(LAST, next);
  }, []);

  const [connecting, setConnecting] = useState(false);
  const [why, setWhy] = useState<string | null>(null);

  /* Attached, or attach it - without asking anybody to press anything.
   *
   * The old flow needed a click on the app's page to hand a token across, which is a step somebody has
   * already decided by installing this: they are signed in over there, and the token is a thing nobody
   * ever sees. So the panel asks the worker to do it (see `auth/auto`), and only says something when the
   * answer is one a person can act on - not signed in, or the app would not answer. */
  const check = useCallback(async (quiet = false) => {
    if (!inExtension) { setSignedIn(true); return; }   // opened as a page, to be looked at
    const status = await ask('sync/status');
    if (status.ok && status.paired === true) { setSignedIn(true); return; }

    /* Quiet on a retry: see `auth/auto`. The first attempt may open a tab to find a session; the ones that
     * follow every few seconds must not, or signing out starts a tab opening every four seconds. */
    if (!quiet) setConnecting(true);
    const auto = await ask('auth/auto', { quiet });
    setConnecting(false);
    if (auto.ok) { setSignedIn(true); setWhy(null); return; }
    setSignedIn(false);
    /* A quiet retry that found nothing is the ordinary state of a wall waiting to be signed in through,
     * not something to report. Only the loud attempt gets to put words on the screen. */
    if (quiet) return;
    setWhy(auto.signedOut
      ? 'Signing in here connects this browser by itself.'
      : auto.error ?? null);
  }, []);

  useEffect(() => { void check(); }, [check]);

  /* Signing in happens in here or in a tab - the Google button opens one - and the panel has to notice
   * either way. It does NOT poll for it: bridge.js runs on every load of the app's origin and pairs there
   * and then, so the page loading is the notification. What is left here is one cheap local check when
   * this window gets attention again, which is exactly when somebody has come back from doing it. */
  useEffect(() => {
    if (signedIn !== false) return undefined;
    const back = () => { if (!document.hidden) void check(true); };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => {
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('focus', back);
    };
  }, [signedIn, check]);

  /* The app's screens read the account from here - who is signed in, the flows, the runs - and it fills
   * itself from /api/sync through the bridge, exactly as it does in a tab. */
  /* h-full, not h-screen: the panel is mounted in two frames - a side panel, which is the height of the
   * window, and a popup, which is a fixed box that says how tall it is. Filling the parent works in both;
   * measuring the viewport works in one. And `relative`, because the assistant covers this box - rail
   * included - rather than sitting in the column beside it. */
  return (
    <AccountProvider>
      <Reconciler />
      <div className="relative flex h-full items-stretch bg-surface-page text-ink-primary">
      <Rail screen={screen} onGo={go} onAsk={() => setAsking(true)} onDetached={() => setSignedIn(false)} />

      <main className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {signedIn === null || connecting ? (
          <div className="m-auto flex flex-col items-center gap-2 text-center">
            <Loader2 className="size-5 animate-spin text-brand-primary" />
            <Typography variant="p" className="text-ink-inactive text-[0.8rem]">
              {connecting ? 'Connecting this browser…' : 'Reading…'}
            </Typography>
          </div>
        ) : signedIn === false ? (
          /* THE WHOLE CYCLE, IN HERE. These are the app's own sign-in and sign-up screens - the same files
           * the website renders - reached through the fetch bridge, so an email and a password create or
           * open an account without leaving the panel.
           *
           * GOOGLE IS THE ONE THING THAT CANNOT BE, and it is worth saying rather than hiding: signing in
           * with Google needs an OAuth client bound to the extension's id, and an unpacked extension's id
           * comes from the folder it was loaded from - different on every machine. The button in there
           * still works; it opens the app in a tab, and the panel connects itself the moment a session
           * exists over there. That is what the polling below is watching for. */
          <div className="flex flex-1 flex-col">
            <div className="mb-2 flex gap-1">
              {(['in', 'up'] as const).map((which) => (
                <button
                  key={which}
                  type="button"
                  onClick={() => setDoor(which)}
                  className={cn(
                    'flex-1 rounded-md px-2 py-1.5 text-[0.8rem] transition-colors duration-base',
                    door === which
                      ? 'bg-brand-primary/15 font-semibold text-brand-primary'
                      : 'text-ink-secondary hover:bg-state-hover',
                  )}
                >
                  {which === 'in' ? 'Sign in' : 'Create an account'}
                </button>
              ))}
            </div>
            {why && <Said note={{ text: why, kind: 'bad' }} className="mb-2" />}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {door === 'in' ? <SignInView /> : <SignUpView />}
            </div>
          </div>
        ) : (
          <>
            {screen === 'record' && (
              <>
                {/* TWO RECORDERS, ONE AT A TIME. This browser records inside web pages through content
                    scripts; this computer records everything through the agent. Both belong in the panel -
                    it is the one surface where both are in reach - but showing both at once put two Start
                    buttons on one screen, which is a question nobody should have to answer twice.
                    The list below is one list either way: a recording is a recording once it exists. */}
                <div className="flex gap-1 rounded-md border border-stroke bg-surface-card2 p-0.5">
                  {([['browser', 'This browser'], ['desktop', 'This computer']] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setRecordWhere(id)}
                      className={cn(
                        'flex-1 rounded px-2 py-1 text-[0.78rem] transition-colors duration-base',
                        recordWhere === id
                          ? 'bg-brand-primary/15 font-semibold text-brand-primary'
                          : 'text-ink-secondary hover:bg-state-hover',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {recordWhere === 'browser' && <RecordScreen />}
                <RecordView recorder={recordWhere === 'desktop'} />
              </>
            )}
            {screen === 'create' && <CreateScreen />}
            {screen === 'skills' && <SkillsView />}
            {screen === 'dashboard' && <InsightsView />}
            {screen === 'teams' && <TeamView />}
            {screen === 'gallery' && <GalleryView />}
          </>
        )}
      </main>

      {asking && signedIn && <AssistantScreen onClose={() => setAsking(false)} />}
    </div>
    </AccountProvider>
  );
};
