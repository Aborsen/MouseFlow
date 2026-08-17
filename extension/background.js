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

const rec = { active: false, tabId: null, startedAt: 0, count: 0 };
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

/* ------------------------------------------------------------------ recording */

async function recordStart(tabId) {
  const target = tabId || await activeTabId();
  await send(target, { mf: 'capture/start' });
  rec.active = true;
  rec.tabId = target;
  rec.startedAt = Date.now();
  rec.count = 0;
  await chrome.action.setBadgeText({ text: 'REC' });
  await chrome.action.setBadgeBackgroundColor({ color: '#f85149' });
  return { ok: true, tabId: target };
}

async function recordStatus() {
  if (rec.active && rec.tabId != null) {
    try {
      const res = await chrome.tabs.sendMessage(rec.tabId, { mf: 'capture/count' });
      if (res && res.ok) rec.count = res.count;
    } catch (_) {
      // tab navigated or closed; keep the last count
    }
  }
  return {
    ok: true,
    recording: rec.active,
    count: rec.count,
    elapsedMs: rec.active ? Date.now() - rec.startedAt : 0,
  };
}

async function recordStop() {
  if (!rec.active) return { ok: true, events: [] };
  let events = [];
  try {
    const res = await chrome.tabs.sendMessage(rec.tabId, { mf: 'capture/stop' });
    if (res && res.ok) events = res.events || [];
  } catch (err) {
    rec.active = false;
    await chrome.action.setBadgeText({ text: '' });
    throw new Error('the recorded tab is gone: ' + err.message);
  }
  rec.active = false;
  rec.count = 0;
  await chrome.action.setBadgeText({ text: '' });

  // Which page this was recorded against. Element selectors are only meaningful on the
  // site they came from, so the origin travels with the recording and is checked on replay.
  let url = null;
  try { url = (await chrome.tabs.get(rec.tabId)).url; } catch (_) {}
  return { ok: true, events, url, origin: originOf(url) };
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

            const res = await send(tabId, { mf: 'replay/event', event: ev });
            const ok = !!(res && res.ok);
            const entry = {
              n: i + 1,
              action: ev.action,
              target: ev.selector || (ev.action === 'scroll' ? 'window' : '?'),
              ok,
              error: ok ? null : ((res && res.error) || 'no response from the page'),
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

// A closed or navigated-away tab silently ends a recording; surface it rather than
// leaving a REC badge and a recording that will never produce events.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (rec.active && rec.tabId === tabId) {
    rec.active = false;
    chrome.action.setBadgeText({ text: '' });
  }
});
