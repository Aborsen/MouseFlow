/* The side panel: the rail, one screen at a time, and the wall in front of both.
 *
 * WHY A SIDE PANEL AND NOT THE POPUP. A popup closes the moment somebody clicks the page. Two of the three
 * things in here - recording a flow, and describing one while looking at it - ARE clicking the page, so on
 * the old surface they could only be watched until the first interesting thing happened. The popup is still
 * there and now does one thing: it opens this.
 */
import { useCallback, useEffect, useState } from 'react';
import { Typography } from '@insightis/ui/Typography';
import { Button } from '@insightis/ui/Button';
import { Loader2 } from 'lucide-react';
import { Rail, type Screen } from './Rail';
import { RecordScreen } from './RecordScreen';
import { CreateScreen } from './CreateScreen';
import { SkillsScreen } from './SkillsScreen';
import { DashboardScreen } from './DashboardScreen';
import { TeamsScreen } from './TeamsScreen';
import { GalleryScreen } from './GalleryScreen';
import { AssistantScreen } from './AssistantScreen';
import { ask, inExtension, openApp } from './worker';

/* Which screen was last open, kept across closings of the panel. A panel that always opened on Record
 * would be a panel that forgets what somebody was in the middle of. */
const LAST = 'mf.panel.screen';

export const Panel = () => {
  const [screen, setScreen] = useState<Screen>(
    () => (localStorage.getItem(LAST) as Screen) || 'record',
  );
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);

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
  const check = useCallback(async () => {
    if (!inExtension) { setSignedIn(true); return; }   // opened as a page, to be looked at
    const status = await ask('sync/status');
    if (status.ok && status.paired === true) { setSignedIn(true); return; }

    setConnecting(true);
    const auto = await ask('auth/auto');
    setConnecting(false);
    if (auto.ok) { setSignedIn(true); setWhy(null); return; }
    setSignedIn(false);
    setWhy(auto.signedOut
      ? 'Sign in to MouseFlow in this browser and this connects itself.'
      : auto.error ?? null);
  }, []);

  useEffect(() => { void check(); }, [check]);

  return (
    /* h-full, not h-screen: the panel is mounted in two frames now - a side panel, which is the height of
     * the window, and a popup, which is a fixed box that says how tall it is. Filling the parent works in
     * both; measuring the viewport works in one. */
    /* `relative`, because the assistant covers this box - rail included - rather than sitting in the
     * column beside it. */
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
          /* The wall. The same sentence the popup used, and the same one act: this extension cannot sign
           * in with Google - that needs an OAuth client tied to an id an unpacked build does not have - so
           * the app signs in and hands a token across. See extension/bridge.js. */
          <div className="m-auto flex max-w-[22rem] flex-col items-center gap-3 text-center">
            <Typography variant="h2" weight="semibold" className="text-[1.05rem]">
              Connect this browser
            </Typography>
            <Typography variant="p" className="text-ink-inactive text-[0.82rem] leading-relaxed">
              {why ?? 'This browser is not attached to a MouseFlow account yet.'}
            </Typography>
            <Button onClick={() => openApp('/skills')}>Sign in</Button>
            <Button variant="ghost" size="sm" onClick={() => void check()}>Try again</Button>
          </div>
        ) : (
          <>
            {screen === 'record' && <RecordScreen />}
            {screen === 'create' && <CreateScreen />}
            {screen === 'skills' && <SkillsScreen />}
            {screen === 'dashboard' && <DashboardScreen />}
            {screen === 'teams' && <TeamsScreen />}
            {screen === 'gallery' && <GalleryScreen />}
          </>
        )}
      </main>

      {asking && signedIn && <AssistantScreen onClose={() => setAsking(false)} />}
    </div>
  );
};
