/* MouseFlow background worker.
 *
 * Deliberately exposes the SAME operations as the desktop agent's HTTP API - ping,
 * record/start, record/status, record/stop, replay, replay/status, replay/abort - so the
 * web app swaps one transport for another instead of growing a second control flow.
 *
 * Reachable two ways:
 *   - the popup, via chrome.runtime.sendMessage
 *   - the deployed web app, via chrome.runtime.sendMessage(EXTENSION_ID, ...) allowed by
 *     the externally_connectable entry in the manifest
 */

const VERSION = '0.1.0';
const KEEPALIVE_MS = 20000;

const rec = { active: false, tabId: null, startedAt: 0, lastAt: 0, events: [], origin: null, url: null };
const play = {
  active: false, abort: false,
  step: 0, steps: 0, pass: 0, passes: 0,
  flowPass: 0, flowPasses: 0, index: 0, total: 0,
  error: null,
  log: [],
};

let keepAlive = null;

/* An MV3 worker is torn down when idle, and a replay spends most of its life inside
 * setTimeout, which does not count as activity. Touching a chrome API on a timer keeps
 * it resident for the duration. */
function holdWorker(on) {
  if (on && !keepAlive) {
    keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), KEEPALIVE_MS);
  } else if (!on && keepAlive) {
    clearInterval(keepAlive);
    keepAlive = null;
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('no active tab');
  if (/^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url || '')) {
    throw new Error('browser pages cannot be automated - switch to a normal site first');
  }
  return tab;
}

async function activeTabId() {
  return (await activeTab()).id;
}

function originOf(url) {
  try { return new URL(url).origin; } catch (_) { return null; }
}

// Content script is injected on demand, and re-injected after a navigation wipes it.
async function ensureContent(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { mf: 'ping' });
    if (pong && pong.ok) return;
  } catch (_) {
    // not there yet
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await sleep(60);
}

async function send(tabId, message) {
  await ensureContent(tabId);
  return chrome.tabs.sendMessage(tabId, message);
}

function waitForLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('the page did not finish loading in ' + timeoutMs + 'ms'));
    }, timeoutMs);
    function onUpdated(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// Replaying a `navigate` step drives the tab rather than the page: a content script
// cannot outlive the navigation it triggers.
async function goTo(tabId, url) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url === url) return;
  const loaded = waitForLoad(tabId);
  await chrome.tabs.update(tabId, { url });
  await loaded;
}

/* ------------------------------------------------------------------ recording */

async function recordStart(tabId) {
  const tab = tabId ? await chrome.tabs.get(tabId) : await activeTab();
  await send(tab.id, { mf: 'capture/start' });

  rec.active = true;
  rec.tabId = tab.id;
  rec.startedAt = Date.now();
  rec.lastAt = Date.now();
  rec.events = [];
  rec.url = tab.url || null;
  rec.origin = originOf(tab.url);

  await chrome.action.setBadgeText({ text: 'REC' });
  await chrome.action.setBadgeBackgroundColor({ color: '#f85149' });
  // With no popup assigned, an icon click fires onClicked instead of opening the popup,
  // which is what lets the icon act as Stop while a recording is running.
  await chrome.action.setPopup({ popup: '' });
  return { ok: true, tabId: tab.id };
}

// One captured event arriving from the page.
function captureEvent(ev) {
  if (!rec.active) return { ok: false, error: 'not recording' };
  const now = Date.now();

  const last = rec.events[rec.events.length - 1];
  if (last && ev.action === 'fill' && ev.editable && last.action === 'fill' &&
      last.editable && last.selector === ev.selector) {
    last.value = ev.value;       // still typing into the same rich-text field
    return { ok: true, count: rec.events.length };
  }

  rec.events.push(Object.assign({
    delay: rec.events.length === 0 ? 0 : now - rec.lastAt,
  }, ev));
  rec.lastAt = now;
  return { ok: true, count: rec.events.length };
}

async function recordStatus() {
  return {
    ok: true,
    recording: rec.active,
    count: rec.events.length,
    elapsedMs: rec.active ? Date.now() - rec.startedAt : 0,
  };
}

async function recordStop() {
  if (!rec.active) return { ok: true, events: [], saved: null };

  rec.active = false;
  try { await chrome.tabs.sendMessage(rec.tabId, { mf: 'capture/stop' }); } catch (_) {
    // Tab closed or navigated. Events were streamed as they happened, so they are safe.
  }
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setPopup({ popup: 'popup.html' });

  const events = rec.events;
  rec.events = [];
  if (!events.length) return { ok: true, events: [], saved: null };

  // Persisted here rather than in the popup, because the icon-as-Stop path has no popup
  // open to do it, and a recording must never depend on a window being visible.
  const { pending = [] } = await chrome.storage.local.get('pending');
  const saved = {
    id: Math.random().toString(36).slice(2, 10),
    name: 'Web recording ' + (pending.length + 1),
    created: new Date().toISOString(),
    kind: 'web',
    url: rec.url,
    origin: rec.origin,
    events,
  };
  pending.push(saved);
  await chrome.storage.local.set({ pending });

  return { ok: true, events, saved, url: rec.url, origin: rec.origin };
}

/* --------------------------------------------------------------------- replay */

async function replayStart(flow) {
  if (play.active) throw new Error('already playing');
  const steps = (flow && flow.steps || []).filter((s) => s.events && s.events.length);
  if (!steps.length) throw new Error('flow contains no events');

  const tab = await activeTab();
  const tabId = flow.tabId || tab.id;

  /* Selectors recorded on one site are meaningless on another, and worse than
   * meaningless: a path like `button:nth-of-type(3)` can resolve on an unrelated page,
   * click something harmless, and report success. That is a silent wrong answer, so
   * refuse rather than "succeed" against the wrong origin. */
  const here = originOf(tab.url);
  if (flow.origin && here && flow.origin !== here) {
    throw new Error('recorded on ' + flow.origin + ' but the active tab is ' + here +
      ' - switch to the right tab and try again');
  }

  Object.assign(play, {
    active: true, abort: false, error: null,
    step: 0, steps: steps.length, pass: 0, passes: 0,
    flowPass: 0, flowPasses: flow.flowRepeat == null ? 1 : flow.flowRepeat,
    index: 0, total: 0, log: [],
  });
  holdWorker(true);
  await chrome.action.setBadgeText({ text: 'RUN' });
  await chrome.action.setBadgeBackgroundColor({ color: '#4c8dff' });

  // Intentionally not awaited: the caller gets an immediate ack and polls replay/status.
  runFlow(tabId, steps, flow).catch((err) => { play.error = err.message; });
  return { ok: true, tabId };
}

async function runFlow(tabId, steps, flow) {
  try {
    await sleep(flow.startDelay || 0);

    const flowForever = !flow.flowRepeat;
    const flowTarget = flowForever ? Infinity : flow.flowRepeat;

    for (let fp = 1; fp <= flowTarget && !play.abort; fp++) {
      play.flowPass = fp;

      for (let s = 0; s < steps.length && !play.abort; s++) {
        const step = steps[s];
        const stepForever = !step.repeat;
        const stepTarget = stepForever ? Infinity : step.repeat;
        const speed = step.speed > 0 ? step.speed : 1;

        for (let p = 1; p <= stepTarget && !play.abort; p++) {
          play.step = s + 1;
          play.pass = p;
          play.passes = stepForever ? 0 : step.repeat;
          play.total = step.events.length;
          play.index = 0;

          for (let i = 0; i < step.events.length; i++) {
            if (play.abort) break;
            const ev = step.events[i];
            await sleep(Math.round((ev.delay || 0) / speed));

            let ok = false;
            let error = null;
            if (ev.action === 'navigate') {
              try { await goTo(tabId, ev.url); ok = true; } catch (err) { error = err.message; }
            } else {
              const res = await send(tabId, { mf: 'replay/event', event: ev });
              ok = !!(res && res.ok);
              error = ok ? null : ((res && res.error) || 'no response from the page');
            }

            const entry = {
              n: i + 1,
              action: ev.action,
              target: ev.selector || ev.url || (ev.action === 'scroll' ? 'window' : '?'),
              ok,
              error,
            };
            play.log.push(entry);
            // Mirrored to the worker console so a failing replay can be read from
            // chrome://extensions -> service worker without any extra tooling.
            console[ok ? 'log' : 'warn']('[MouseFlow]', entry);

            if (!ok) throw new Error('step ' + (s + 1) + ', event ' + (i + 1) + ' (' + ev.action + '): ' + entry.error);
            play.index = i + 1;
          }

          if (step.delayAfter > 0) await sleep(step.delayAfter);
        }
      }
    }
  } catch (err) {
    // Recorded here, not in the caller's .catch(), so the finally below stores it.
    play.error = err.message;
  } finally {
    play.active = false;
    holdWorker(false);
    chrome.action.setBadgeText({ text: '' });
    // Survives the worker being torn down, so the popup can still explain the last run.
    chrome.storage.session.set({
      lastRun: { at: Date.now(), error: play.error, log: play.log.slice(-60) },
    }).catch(() => {});
  }
}

function replayStatus() {
  const done = play.log.length;
  const failed = play.log.filter((e) => !e.ok).length;
  return {
    ok: true,
    playing: play.active,
    step: play.step, steps: play.steps,
    pass: play.pass, passes: play.passes,
    flowPass: play.flowPass, flowPasses: play.flowPasses,
    index: play.index, total: play.total,
    error: play.error,
    performed: done,
    failed,
    log: play.log.slice(-20),
  };
}

/* -------------------------------------------------------------------- routing */

const ROUTES = {
  ping: async () => ({ ok: true, version: VERSION, mode: 'extension', recording: rec.active, playing: play.active }),
  'capture/event': async (msg) => captureEvent(msg.event),
  'record/start': (msg) => recordStart(msg.tabId),
  'record/status': () => recordStatus(),
  'record/stop': () => recordStop(),
  replay: (msg) => replayStart(msg.flow || {}),
  'replay/status': async () => replayStatus(),
  'replay/abort': async () => { play.abort = true; return { ok: true }; },
};

function route(msg, respond) {
  if (!msg || typeof msg.mf !== 'string') return false;
  if (msg.mf === 'content/ready') return false;

  const handler = ROUTES[msg.mf];
  if (!handler) {
    respond({ ok: false, error: 'unknown command ' + msg.mf });
    return true;
  }
  Promise.resolve()
    .then(() => handler(msg))
    .then((res) => respond(res))
    .catch((err) => respond({ ok: false, error: err.message }));
  return true;   // responding asynchronously
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => route(msg, respond));
chrome.runtime.onMessageExternal.addListener((msg, sender, respond) => route(msg, respond));

/* Keep capturing across page loads.
 *
 * A navigation destroys the content script, so without this the recording stops at the
 * first link or form submit while the badge still says REC. The navigation is also
 * recorded as its own step, so a replay can put the browser back on the right page
 * instead of blindly hunting for elements that are not there yet.
 */
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!rec.active || tabId !== rec.tabId || info.status !== 'complete') return;
  if (/^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url || '')) return;

  const last = rec.events[rec.events.length - 1];
  if (!last || last.action !== 'navigate' || last.url !== tab.url) {
    captureEvent({ action: 'navigate', url: tab.url });
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, { mf: 'capture/start' });
  } catch (err) {
    console.warn('[MouseFlow] could not resume capture after navigation:', err.message);
  }
});

// A closed tab ends the recording. Events already streamed here are kept.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (rec.active && rec.tabId === tabId) {
    await recordStop().catch(() => {});
  }
});

/* Icon click while recording = Stop, then show the result.
 *
 * onClicked only fires when no popup is assigned, which recordStart arranges. Stopping
 * restores the popup and reopens it so the user lands on the saved recording without a
 * second click. openPopup needs Chrome 127+; if it is unavailable the recording is still
 * safely saved and the next click opens the popup normally.
 */
chrome.action.onClicked.addListener(async () => {
  if (!rec.active) {
    await chrome.action.setPopup({ popup: 'popup.html' });
    try { await chrome.action.openPopup(); } catch (_) {}
    return;
  }
  const res = await recordStop().catch((err) => ({ ok: false, error: err.message }));
  if (res && res.saved) {
    await chrome.action.setBadgeText({ text: String(res.saved.events.length) });
    await chrome.action.setBadgeBackgroundColor({ color: '#2ea043' });
  }
  try { await chrome.action.openPopup(); } catch (_) {}
});
