/* Telling somebody a run has finished when they are not looking at this tab.
 *
 * This matters here more than it would in most apps, and for a specific reason: the agent drives the actual
 * desktop, so the whole point of a run is that the person goes and does something else while it happens.
 * The tab is behind other windows by design. A result that only exists on screen is a result nobody sees
 * until they wonder how it went and switch back to check.
 *
 * Three ways to say it, in the order they are worth having:
 *
 *   1. A system notification. Works while the tab is hidden, which is the only case that matters, and
 *      clicking it brings the tab forward - a page cannot focus itself, but it can focus itself from a
 *      notification click, which is a user gesture.
 *   2. The tab title. Free, needs no permission, and a browser tab strip is somewhere people already look.
 *      This is the fallback when notifications are refused, and it runs alongside them when they are not.
 *   3. Asking the AGENT to bring the browser forward. Only this product can do that - there is a process on
 *      the machine that activates windows for a living. It is also the rudest of the three, so it never
 *      happens unless it was asked for: switching somebody's window while they are typing in another
 *      application is worse than a missed notification.
 *
 * Permission is asked when a run STARTS, not when the page loads. A prompt at load has no context and gets
 * refused for the whole origin, permanently; a prompt one click after "Run it" is about the thing that just
 * began. It also needs a user gesture to be shown at all in some browsers, and pressing Run is one.
 */
import { doAction } from '@/lib/agent';

export type Outcome = 'ok' | 'failed' | 'stopped';

const TITLE = 'MouseFlow';

/* Whether asking is even possible. Not the same as "allowed": a browser with no Notification API, an
 * insecure origin, and a user who said no are three different situations, and only the last one is a
 * decision. */
const canNotify = () => typeof Notification !== 'undefined' && typeof window !== 'undefined';

/** Ask, once, at the moment it makes sense. Returns what the answer is now, whether or not we asked. */
export async function askToNotify(): Promise<NotificationPermission | 'unsupported'> {
  if (!canNotify()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch (_) {
    /* Older Safari resolves this through a callback and throws on the promise form. Refusing to notify is
     * the right answer either way - it is a nicety, not the run. */
    return Notification.permission;
  }
}

/* The tab title, as a flag.
 *
 * Restored on the next focus rather than on a timer: the point is that somebody who is elsewhere sees it
 * when they come back, and a title that tidies itself up after ten seconds is a title nobody read. */
let restoreTitle: (() => void) | null = null;

const flagTitle = (mark: string) => {
  if (typeof document === 'undefined') return;
  restoreTitle?.();
  const was = document.title;
  document.title = `${mark} ${was === TITLE ? TITLE : was}`;
  const undo = () => {
    document.title = was;
    window.removeEventListener('focus', undo);
    document.removeEventListener('visibilitychange', onVisible);
    restoreTitle = null;
  };
  const onVisible = () => { if (!document.hidden) undo(); };
  restoreTitle = undo;
  window.addEventListener('focus', undo);
  document.addEventListener('visibilitychange', onVisible);
};

const words = (outcome: Outcome, said: string | null) => {
  const head = outcome === 'ok'
    ? 'Finished'
    : outcome === 'stopped'
      ? 'Stopped'
      : 'Did not finish';
  /* The model's own sentence, when there is one. "Finished" alone sends somebody back to the tab to find out
   * what it did, which is the trip this is meant to save. */
  const body = (said ?? '').trim();
  return {
    title: `${head} — ${TITLE}`,
    body: body ? body.slice(0, 220) : (outcome === 'ok' ? 'The run finished.' : 'The run ended early.'),
    mark: outcome === 'ok' ? '✓' : outcome === 'stopped' ? '■' : '!',
  };
};

/* Say it. Called on every finish, and it decides what is available rather than the caller.
 *
 * `bringForward` is the opt-in: with it, the agent is asked to activate the browser window, which actually
 * switches the person's screen. Without it, nothing steals focus.
 */
export async function announceFinished(
  { outcome, said, port, bringForward }:
  { outcome: Outcome; said: string | null; port: number; bringForward?: boolean },
): Promise<void> {
  /* Nothing at all while the tab is in front: the result is already on screen, and a notification for
   * something somebody is looking at is noise. */
  const hidden = typeof document === 'undefined' ? false : document.hidden || !document.hasFocus();
  if (!hidden && !bringForward) return;

  const { title, body, mark } = words(outcome, said);

  if (hidden) flagTitle(mark);

  if (canNotify() && Notification.permission === 'granted' && hidden) {
    try {
      const note = new Notification(title, {
        body,
        /* One per tag, so a run that finishes while an older notification is still up replaces it instead of
         * stacking. */
        tag: 'mouseflow-run',
        /* Only a failure is worth insisting on. A clean finish can wait to be noticed - and a run somebody
         * STOPPED themselves needs no insisting at all: they know, they did it. `!== 'ok'` caught the stop
         * along with the failure, which would have left a notification demanding attention for news its own
         * reader had made. */
        requireInteraction: outcome === 'failed',
      });
      note.onclick = () => {
        /* A page cannot focus itself, but it can from inside a notification click - that counts as the
         * user's own gesture. */
        window.focus();
        note.close();
      };
    } catch (_) {
      // A notification that could not be constructed is not worth failing a run over.
    }
  }

  if (bringForward) {
    /* The thing only this product can do: there is an agent on the machine whose job includes activating
     * windows. Best effort and deliberately vague about which browser - the title is what the window list
     * matches on, and "MouseFlow" is in the tab title of every browser showing this page. */
    try {
      await doAction(port, 'action=activate title=MouseFlow');
    } catch (_) {
      // It stays in the background; the notification and the title still said so.
    }
  }
}
