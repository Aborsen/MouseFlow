/* The popup: the same panel, in the window the toolbar icon opens.
 *
 * TWO SURFACES, ONE IMPLEMENTATION. This renders <Panel />, the identical component the side panel mounts -
 * so there is nothing to keep in step, and a fix to a screen is a fix in both places. What differs is the
 * frame around it: a popup is a fixed box that Chrome sizes to its content, so one is given here.
 *
 * WHY BOTH EXIST. The popup is where a browser extension is expected to be, and for reading a list or
 * pressing Run it is the shortest path there is. The side panel is for the two things a popup cannot do at
 * all: it closes the moment somebody clicks the page, and recording a flow - or describing one while
 * looking at it - IS clicking the page. So the popup carries a way through to the panel rather than
 * pretending it can do everything.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PanelRight } from 'lucide-react';
import '@/globals.css';
import { installApiBridge } from './api-bridge';
import { Panel } from './Panel';

installApiBridge();

const openPanel = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
    /* Closed by hand: two windows showing the same thing is one too many, and the panel is the one that
     * survives the next click. */
    window.close();
  } catch (_) {
    /* Refused, almost always for want of a gesture Chrome believes in. Nothing to say - the popup is
     * perfectly usable, which is the point of it rendering the whole panel. */
  }
};

const Popup = () => (
  /* 24rem x 36rem: inside Chrome's 600px ceiling with room for the rail, and the same height whichever
   * screen is open - a window that resized itself between Record and Skills used to jump under the
   * pointer, which is the lesson the old popup wrote into its own stylesheet. */
  <div className="relative h-[36rem] w-[24rem] overflow-hidden">
    <button
      type="button"
      onClick={openPanel}
      title="Open in the side panel — it stays open while you work on the page"
      aria-label="Open in the side panel"
      className="absolute top-1.5 right-1.5 z-30 grid size-7 place-items-center rounded-md text-ink-inactive transition-colors duration-base hover:bg-state-hover hover:text-ink-primary"
    >
      <PanelRight className="size-4" />
    </button>
    <Panel />
  </div>
);

createRoot(document.getElementById('root')!).render(<StrictMode><Popup /></StrictMode>);
