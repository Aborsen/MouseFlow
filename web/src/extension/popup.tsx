/* The popup, which now has one job: open the panel and get out of the way.
 *
 * It stays because the toolbar icon has to do SOMETHING, and because `chrome.sidePanel.open()` may only be
 * called while handling a user gesture - a click in here is one. Everything that was in this window has
 * moved next door, where it survives a click on the page.
 */
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PanelRight } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import '@/globals.css';

const openPanel = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  } catch (_) {
    /* Refused - almost always because the gesture was lost. The button below is still there to press. */
  }
};

const Popup = () => {
  /* Opened on sight, because the only reason to be here is to be next door. The button below is what
   * happens when Chrome refuses the automatic one for want of a gesture it believes in. */
  useEffect(() => { void openPanel(); }, []);

  return (
    <div className="flex w-[15rem] flex-col items-center gap-2.5 bg-surface-page p-4 text-center text-ink-primary">
      <Typography variant="span" weight="semibold" className="text-[0.9rem]">MouseFlow</Typography>
      <Typography variant="p" className="text-ink-inactive text-[0.78rem] leading-relaxed">
        Recording, Create and Skills live in the side panel now — it stays open while you work on the page.
      </Typography>
      <Button size="sm" onClick={openPanel} leftSlot={<PanelRight className="size-4" />}>
        Open the panel
      </Button>
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<StrictMode><Popup /></StrictMode>);
