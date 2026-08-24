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
import { Rail, type Screen } from './Rail';
import { RecordScreen } from './RecordScreen';
import { CreateScreen } from './CreateScreen';
import { SkillsScreen } from './SkillsScreen';
import { DashboardScreen } from './DashboardScreen';
import { TeamsScreen } from './TeamsScreen';
import { GalleryScreen } from './GalleryScreen';
import { ask, inExtension, openApp } from './worker';

/* Which screen was last open, kept across closings of the panel. A panel that always opened on Record
 * would be a panel that forgets what somebody was in the middle of. */
const LAST = 'mf.panel.screen';

export const Panel = () => {
  const [screen, setScreen] = useState<Screen>(
    () => (localStorage.getItem(LAST) as Screen) || 'record',
  );
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  const go = useCallback((next: Screen) => {
    setScreen(next);
    localStorage.setItem(LAST, next);
  }, []);

  const check = useCallback(async () => {
    if (!inExtension) { setSignedIn(true); return; }   // opened as a page, to be looked at
    const res = await ask('sync/status');
    setSignedIn(!!res.ok && res.paired === true);
  }, []);

  useEffect(() => { void check(); }, [check]);

  return (
    <div className="flex h-screen items-stretch bg-surface-page text-ink-primary">
      <Rail screen={screen} onGo={go} />

      <main className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {signedIn === false ? (
          /* The wall. The same sentence the popup used, and the same one act: this extension cannot sign
           * in with Google - that needs an OAuth client tied to an id an unpacked build does not have - so
           * the app signs in and hands a token across. See extension/bridge.js. */
          <div className="m-auto flex max-w-[22rem] flex-col items-center gap-3 text-center">
            <Typography variant="h2" weight="semibold" className="text-[1.05rem]">
              Connect this browser
            </Typography>
            <Typography variant="p" className="text-ink-inactive text-[0.82rem] leading-relaxed">
              Sign in to the app once and press “Connect extension” there. It hands this a token — nothing
              to copy, nothing to type.
            </Typography>
            <Button onClick={() => openApp('/skills')}>Open the app</Button>
            <Button variant="ghost" size="sm" onClick={() => void check()}>I have done that</Button>
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
    </div>
  );
};
