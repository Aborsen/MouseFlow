/* The handover between the app and the extension.
 *
 * The problem it solves: an extension cannot sign in with Google. That needs an OAuth client tied to
 * the extension's id, and an unpacked extension's id is derived from its folder path - different on
 * every machine. The app CAN sign in, because it is an ordinary origin. So the app signs in, mints a
 * device token for its own account, and this script carries that token the last few centimetres into
 * the extension. What the user sees is one click, not a token.
 *
 * Why a content script rather than externally_connectable: a page can only message an extension whose
 * id it knows, and for an unpacked build nobody knows it in advance. A content script has no such
 * problem - it is injected BY the extension, so chrome.runtime is simply there.
 *
 * The trust boundary, stated plainly:
 *
 *   This runs only on the app's own origin (see "content_scripts" in the manifest), and it accepts a
 *   token only from `window` itself at that same origin. So what it trusts is the app's own page
 *   scripts - the same code that already holds the session cookie. Script running on that origin
 *   could already mint a token by calling /api/sync?issue=1 with the session; being able to also
 *   hand one to the extension adds nothing it could not already do.
 *
 *   The background worker checks the sender's origin again on arrival, because a message claiming to
 *   come from here is not evidence that it did.
 */

const HELLO = 'mouseflow:extension';     // extension -> page: "I am here", with a version
const ASK = 'mouseflow:hello?';          // page -> extension: "are you there?"
const PAIR = 'mouseflow:pair';           // page -> extension: here is a device token
const PAIRED = 'mouseflow:paired';       // extension -> page: how that went
const CMD = 'mouseflow:cmd';             // page -> extension: do one of the things below
const RESULT = 'mouseflow:cmd-result';   // extension -> page: what it answered

/* What the app may ask for, by name.
 *
 * "Create the flow" in the web app is this list: the page describes a goal, the worker runs it in a
 * real tab, and the page asks how it is going. Everything else - recording, replay, editing skills,
 * the gallery - stays inside the extension, because the app has its own way to do those and two paths
 * to one outcome is how they drift apart.
 *
 * An allowlist rather than a pass-through. This channel starts a process that drives a logged-in
 * browser and spends the shared key; what it can reach should be readable in one line.
 */
const FORWARDABLE = new Set(['ping', 'page/run', 'page/status', 'page/abort']);

/* The announcement carries whether the extension is already attached to an account, so the app can
 * offer to connect one that is not and simply say so about one that is - rather than minting a
 * second token every time the page is opened. */
async function announce() {
  let version = '';
  try { version = chrome.runtime.getManifest().version; } catch (_) { return; }
  const status = await chrome.runtime.sendMessage({ mf: 'sync/status' }).catch(() => null);
  window.postMessage({
    mf: HELLO,
    version,
    paired: !!(status && status.paired),
    who: (status && status.who) || null,
  }, location.origin);
}

/* Announced on load AND answered on request. Which of the two runs first is a race - the page's
 * listener may not exist yet at document_idle, and the page may load before this script - so both
 * halves ask and both halves answer. */
announce();

window.addEventListener('message', async (event) => {
  // Same window, same origin: not another frame, not another site embedding this one.
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.mf === ASK) { announce(); return; }

  if (data.mf === CMD) {
    const cmd = String(data.cmd || '');
    if (!FORWARDABLE.has(cmd)) {
      window.postMessage({ mf: RESULT, id: data.id,
        res: { ok: false, error: 'not available to the app: ' + cmd } }, location.origin);
      return;
    }
    let res;
    try {
      const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
      res = await chrome.runtime.sendMessage(Object.assign({ mf: cmd }, payload));
    } catch (err) {
      res = { ok: false, error: 'the extension is not answering - reload it' };
    }
    window.postMessage({ mf: RESULT, id: data.id, res: res || null }, location.origin);
    return;
  }

  if (data.mf !== PAIR) return;

  let res;
  try {
    res = await chrome.runtime.sendMessage({ mf: 'auth/paired', token: String(data.token || '') });
  } catch (err) {
    /* An orphaned content script - the extension was reloaded and this injection belongs to a
     * generation that no longer exists. Nothing here can recover; say so in terms the user can act
     * on rather than reporting a lost message. */
    res = { ok: false, error: 'the extension is not answering - reload it and try again' };
  }
  window.postMessage({
    mf: PAIRED,
    ok: !!(res && res.ok),
    who: (res && res.who) || null,
    error: (res && res.error) || null,
  }, location.origin);
  // So anything else on the page sees the new state without asking.
  if (res && res.ok) announce();
});
