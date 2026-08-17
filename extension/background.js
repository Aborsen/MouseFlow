/* MouseFlow background worker.
 *
 * Exposes the SAME operations as the desktop agent's HTTP API - ping, record/start,
 * record/status, record/stop, replay, replay/status, replay/abort - so the web app swaps
 * one transport for another instead of growing a second control flow.
 *
 * Cross-tab recording. A flow is not one tab: the user works in tab A, switches to tab B,
 * then C. So a recording is a single ordered event stream in which each event is tagged
 * with a logical tab KEY (0, 1, 2 in order of first appearance), and switching tabs is
 * itself an event. Real Chrome tab ids are useless across a record/replay boundary - they
 * differ every run - so the key plus the tab's URL is what travels, and replay rebuilds
 * the tabs from that.
 *
 * Reachable from the popup (chrome.runtime.sendMessage) and, once wired, from the deployed
 * web app (chrome.runtime.sendMessage(EXTENSION_ID, ...) via externally_connectable).
 */

import { runGoal } from './agent.js';

const VERSION = '0.3.0';
const KEEPALIVE_MS = 20000;

const rec = {
  active: false,
  activeTabId: null,          // the real tab currently focused and recording
  tabKeys: {},                // realTabId -> logical key
  nextKey: 0,
  startedAt: 0,
  lastAt: 0,
  events: [],
};

const play = {
  active: false, abort: false,
  step: 0, steps: 0, pass: 0, passes: 0,
  flowPass: 0, flowPasses: 0, index: 0, total: 0,
  error: null,
  log: [],
};

let keepAlive = null;

/* An MV3 worker is torn down when idle, and a replay spends most of its life inside
 * setTimeout, which does not count as activity. Touching a chrome API on a timer keeps it
 * resident for the duration. */
function holdWorker(on) {
  if (on && !keepAlive) {
    keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), KEEPALIVE_MS);
  } else if (!on && keepAlive) {
    clearInterval(keepAlive);
    keepAlive = null;
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const RESTRICTED = /^(chrome|edge|about|chrome-extension|devtools|view-source):/i;
const isRestricted = (url) => !url || RESTRICTED.test(url);

function originOf(url) {
  try { return new URL(url).origin; } catch (_) { return null; }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('no active tab');
  if (isRestricted(tab.url)) {
    throw new Error('browser pages cannot be automated - switch to a normal site first');
  }
  return tab;
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

// Resolves when the tab next reports 'complete'. Listener is attached before the caller
// triggers navigation, so the load cannot slip through between the two.
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

// For a freshly created tab, whose load may already be under way: poll instead of racing
// a listener against a load that started before we could attach one.
async function pollComplete(tabId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error('tab was closed while loading');
    if (t.status === 'complete') return;
    await sleep(150);
  }
  throw new Error('the page did not finish loading in ' + timeoutMs + 'ms');
}

// Replaying a `navigate` step drives the tab, not the page: a content script cannot
// outlive the navigation it triggers.
async function goTo(tabId, url) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url === url) return;
  const loaded = waitForLoad(tabId);
  await chrome.tabs.update(tabId, { url });
  await loaded;
}

/* ------------------------------------------------------------------ recording */

// Assigns a logical key the first time a real tab is recorded into.
function keyForTab(tabId) {
  if (rec.tabKeys[tabId] === undefined) {
    rec.tabKeys[tabId] = rec.nextKey++;
    return { key: rec.tabKeys[tabId], isNew: true };
  }
  return { key: rec.tabKeys[tabId], isNew: false };
}

async function ensureCapturing(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await chrome.tabs.sendMessage(tabId, { mf: 'capture/start' });
}

// Appends one event, tagged with its logical tab, and computes the gap since the previous
// event. Consecutive edits to the same rich-text field in the same tab collapse to one.
function pushEvent(ev, tabKey) {
  const now = Date.now();
  const last = rec.events[rec.events.length - 1];

  /* Typing arrives one event per keystroke. Collapse a burst on the same field into a
   * single step carrying the final text, so "hello world" is one step and not eleven -
   * and so the recorded delay is the pause before the field was touched, not the gap
   * between two letters. Applies to plain inputs and rich-text editors alike. */
  if (last && ev.action === 'fill' && last.action === 'fill' &&
      last.selector === ev.selector && last.tab === tabKey &&
      !!last.editable === !!ev.editable) {
    last.value = ev.value;
    return rec.events.length;
  }
  rec.events.push(Object.assign({
    delay: rec.events.length === 0 ? 0 : now - rec.lastAt,
    tab: tabKey,
  }, ev));
  rec.lastAt = now;
  return rec.events.length;
}

// An event arriving from a content script. Only the focused recorded tab is trusted -
// a background tab can still fire script-driven events, which would land out of order.
function captureFromPage(ev, senderTabId) {
  if (!rec.active) return { ok: false, error: 'not recording' };
  if (senderTabId !== rec.activeTabId) return { ok: true, ignored: true };
  const key = rec.tabKeys[senderTabId];
  if (key === undefined) return { ok: true, ignored: true };
  return { ok: true, count: pushEvent(ev, key) };
}

async function recordStart(tabId) {
  const tab = tabId ? await chrome.tabs.get(tabId) : await activeTab();

  rec.active = true;
  rec.activeTabId = tab.id;
  rec.tabKeys = {};
  rec.nextKey = 0;
  rec.startedAt = Date.now();
  rec.lastAt = Date.now();
  rec.events = [];

  const { key } = keyForTab(tab.id);
  // Opening step for tab 0, so replay starts from a known page instead of whatever
  // happens to be focused.
  pushEvent({ action: 'focus', url: tab.url, opened: true, tabIndex: tab.index }, key);
  await ensureCapturing(tab.id);

  await chrome.action.setBadgeText({ text: 'REC' });
  await chrome.action.setBadgeBackgroundColor({ color: '#f85149' });
  // With no popup assigned, an icon click fires onClicked instead of opening the popup -
  // that is what lets the icon act as Stop while a recording is running.
  await chrome.action.setPopup({ popup: '' });
  return { ok: true, tabId: tab.id };
}

async function recordStatus() {
  const tabs = new Set(rec.events.map((e) => e.tab)).size;
  // Distinct fields typed into, surfaced live so the user can see text being captured
  // while they type rather than discovering afterwards that it wasn't.
  const fields = new Set(
    rec.events.filter((e) => e.action === 'fill').map((e) => e.selector)
  ).size;
  return {
    ok: true,
    recording: rec.active,
    count: rec.events.length,
    tabs,
    fields,
    elapsedMs: rec.active ? Date.now() - rec.startedAt : 0,
  };
}

async function recordStop() {
  if (!rec.active) return { ok: true, events: [], saved: null };

  rec.active = false;
  // Stop capture in every tab this recording touched.
  for (const realId of Object.keys(rec.tabKeys)) {
    chrome.tabs.sendMessage(Number(realId), { mf: 'capture/stop' }).catch(() => {});
  }
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setPopup({ popup: 'popup.html' });

  const events = rec.events;
  rec.events = [];
  rec.activeTabId = null;
  if (!events.length) return { ok: true, events: [], saved: null };

  // Every distinct origin the recording spans, for display and sanity.
  const origins = [...new Set(events.filter((e) => e.action === 'focus').map((e) => originOf(e.url)).filter(Boolean))];
  const tabCount = new Set(events.map((e) => e.tab)).size;

  // Persisted here, not in the popup: the icon-as-Stop path has no popup open, and a
  // recording must never depend on a window being visible.
  const { pending = [] } = await chrome.storage.local.get('pending');
  const saved = {
    id: Math.random().toString(36).slice(2, 10),
    name: 'Web recording ' + (pending.length + 1),
    created: new Date().toISOString(),
    kind: 'web',
    origins,
    tabs: tabCount,
    events,
  };
  pending.push(saved);
  await chrome.storage.local.set({ pending });

  return { ok: true, events, saved, tabs: tabCount, origins };
}

/* --------------------------------------------------------------------- replay */

async function replayStart(flow) {
  if (play.active) throw new Error('already playing');
  const steps = (flow && flow.steps || []).filter((s) => s.events && s.events.length);
  if (!steps.length) throw new Error('flow contains no events');

  Object.assign(play, {
    active: true, abort: false, error: null,
    step: 0, steps: steps.length, pass: 0, passes: 0,
    flowPass: 0, flowPasses: flow.flowRepeat == null ? 1 : flow.flowRepeat,
    index: 0, total: 0, log: [],
  });
  holdWorker(true);
  await chrome.action.setBadgeText({ text: 'RUN' });
  await chrome.action.setBadgeBackgroundColor({ color: '#4c8dff' });

  // Not awaited: the caller gets an immediate ack and polls replay/status.
  runFlow(steps, flow).catch((err) => { play.error = err.message; });
  return { ok: true };
}

// Carries the logical-tab -> real-tab mapping across the whole flow. `current` is the tab
// the next non-focus event acts on.
async function performEvent(ev, ctx) {
  /* Mirroring, not re-creating.
   *
   * "Record the flow" replays the exact sequence into the tabs that are already open:
   * a tab switch activates the tab sitting at the recorded position, and never opens a
   * new one. Creating tabs made a two-tab recording spawn two fresh tabs on every run,
   * which is not what "simply repeat it" means. If the tab is gone, say so instead of
   * quietly substituting a new one and clicking into the wrong page.
   */
  if (ev.action === 'focus') {
    const key = ev.tab || 0;
    let tabId = ctx.map[key];

    if (tabId == null) {
      const index = ev.tabIndex == null ? key : ev.tabIndex;
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const match = tabs.find((t) => t.index === index) || tabs[index];
      if (!match) {
        throw new Error('this step needs the tab at position ' + (index + 1) +
          ', and this window only has ' + tabs.length + ' - open it first');
      }
      if (isRestricted(match.url)) {
        throw new Error('the tab at position ' + (index + 1) + ' is a browser page, which cannot be automated');
      }
      tabId = match.id;
      ctx.map[key] = tabId;
    }

    await chrome.tabs.update(tabId, { active: true });
    ctx.current = tabId;
    return;
  }

  // Old single-tab recordings carry no focus events; fall back to the active tab.
  if (ctx.current == null) ctx.current = (await activeTab()).id;

  if (ev.action === 'navigate') {
    await goTo(ctx.current, ev.url);
    return;
  }

  const res = await send(ctx.current, { mf: 'replay/event', event: ev });
  if (!res || !res.ok) throw new Error((res && res.error) || 'no response from the page');
}

async function runFlow(steps, flow) {
  const ctx = { map: {}, current: null };
  try {
    await sleep(flow.startDelay || 0);

    const flowForever = !flow.flowRepeat;
    const flowTarget = flowForever ? Infinity : flow.flowRepeat;

    for (let fp = 1; fp <= flowTarget && !play.abort; fp++) {
      play.flowPass = fp;
      // Each flow pass rebuilds its tabs, so a looped flow does not pile up windows or
      // reuse a tab the previous pass left on the wrong page.
      ctx.map = {};
      ctx.current = null;

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
            try {
              await performEvent(ev, ctx);
              ok = true;
            } catch (err) {
              error = err.message;
            }

            const entry = {
              n: i + 1,
              action: ev.action,
              tab: ev.tab == null ? 0 : ev.tab,
              target: ev.selector || ev.url || (ev.action === 'scroll' ? 'window' : '?'),
              ok,
              error,
            };
            play.log.push(entry);
            console[ok ? 'log' : 'warn']('[MouseFlow]', entry);

            if (!ok) throw new Error('step ' + (s + 1) + ', event ' + (i + 1) + ' (' + ev.action + '): ' + error);
            play.index = i + 1;
          }

          if (step.delayAfter > 0) await sleep(step.delayAfter);
        }
      }
    }
  } catch (err) {
    play.error = err.message;
  } finally {
    play.active = false;
    holdWorker(false);
    chrome.action.setBadgeText({ text: '' });
    chrome.storage.session.set({
      lastRun: { at: Date.now(), error: play.error, log: play.log.slice(-80) },
    }).catch(() => {});
  }
}

function replayStatus() {
  const performed = play.log.length;
  const failed = play.log.filter((e) => !e.ok).length;
  return {
    ok: true,
    playing: play.active,
    step: play.step, steps: play.steps,
    pass: play.pass, passes: play.passes,
    flowPass: play.flowPass, flowPasses: play.flowPasses,
    index: play.index, total: play.total,
    error: play.error,
    performed, failed,
    log: play.log.slice(-20),
  };
}

/* ------------------------------------------------------- agent mode (describe) */

const agent = { running: false, abort: false, goal: '', log: [], result: null };

// One tool call from the model, executed against the active tab.
async function runAgentTool(name, input) {
  const tabId = await activeTabId();

  switch (name) {
    case 'read_page': {
      const res = await send(tabId, { mf: 'agent/snapshot', limit: 120 });
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'could not read the page' };
      return { ok: true, result: res.page };
    }
    case 'navigate': {
      await goTo(tabId, input.url);
      return { ok: true, result: { navigated: input.url } };
    }
    case 'open_tab': {
      const created = await chrome.tabs.create({ url: input.url, active: true });
      try { await pollComplete(created.id); } catch (_) { /* the next read_page will show it */ }
      return { ok: true, result: { opened: input.url } };
    }
    case 'click':
    case 'type_text':
    case 'press_key':
    case 'scroll': {
      const command = Object.assign({}, input, {
        action: name === 'type_text' ? 'type' : name,
      });
      const res = await send(tabId, { mf: 'agent/act', command });
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'no response from the page' };
      // A click often navigates; give the page a moment before the next read_page.
      await sleep(name === 'click' ? 500 : 150);
      return { ok: true, result: { done: name } };
    }
    default:
      return { ok: false, error: 'unknown tool ' + name };
  }
}

async function agentStart(goal) {
  if (agent.running) throw new Error('already running');
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) throw new Error('no API key saved - add one in Create a flow');
  if (!goal || !goal.trim()) throw new Error('describe what you want done');

  Object.assign(agent, { running: true, abort: false, goal: goal.trim(), log: [], result: null });
  holdWorker(true);
  await chrome.action.setBadgeText({ text: 'AI' });
  await chrome.action.setBadgeBackgroundColor({ color: '#8957e5' });

  runGoal({
    goal: agent.goal,
    apiKey,
    execute: runAgentTool,
    isAborted: () => agent.abort,
    onEvent: (event) => {
      agent.log.push(event);
      console.log('[MouseFlow agent]', event);
    },
  })
    .then((res) => { agent.result = res; })
    .catch((err) => { agent.result = { ok: false, error: err.message, steps: [] }; })
    .finally(async () => {
      agent.running = false;
      holdWorker(false);
      await chrome.action.setBadgeText({ text: '' });
      // Kept so the popup can show the outcome after the worker is torn down.
      chrome.storage.session.set({ lastAgentRun: { goal: agent.goal, log: agent.log.slice(-40), result: agent.result } }).catch(() => {});
    });

  return { ok: true };
}

function agentStatus() {
  return {
    ok: true,
    running: agent.running,
    goal: agent.goal,
    log: agent.log.slice(-12),
    result: agent.result,
  };
}

/* -------------------------------------------------------------------- routing */

const ROUTES = {
  ping: async () => ({
    ok: true, version: VERSION, mode: 'extension',
    recording: rec.active, playing: play.active, agentRunning: agent.running,
  }),
  'capture/event': async (msg, sender) => captureFromPage(msg.event, sender && sender.tab && sender.tab.id),
  'record/start': (msg) => recordStart(msg.tabId),
  'record/status': () => recordStatus(),
  'record/stop': () => recordStop(),
  replay: (msg) => replayStart(msg.flow || {}),
  'replay/status': async () => replayStatus(),
  'replay/abort': async () => { play.abort = true; return { ok: true }; },
  'agent/start': (msg) => agentStart(msg.goal),
  'agent/status': async () => agentStatus(),
  'agent/abort': async () => { agent.abort = true; return { ok: true }; },
};

function route(msg, sender, respond) {
  if (!msg || typeof msg.mf !== 'string') return false;
  if (msg.mf === 'content/ready') return false;

  const handler = ROUTES[msg.mf];
  if (!handler) {
    respond({ ok: false, error: 'unknown command ' + msg.mf });
    return true;
  }
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((res) => respond(res))
    .catch((err) => respond({ ok: false, error: err.message }));
  return true;   // responding asynchronously
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => route(msg, sender, respond));
chrome.runtime.onMessageExternal.addListener((msg, sender, respond) => route(msg, sender, respond));

/* Follow the user across tabs while recording.
 *
 * Switching to a tab is recorded as a `focus` step - a new logical tab the first time,
 * a return to a known one otherwise - and capture is (re)started there. Switching to a
 * browser page just parks recording until the user returns to a real site. */
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!rec.active) return;
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (_) { return; }
  if (isRestricted(tab.url)) { rec.activeTabId = null; return; }

  rec.activeTabId = tabId;
  const { key, isNew } = keyForTab(tabId);
  // tabIndex is what replay uses to find this tab again: mirroring activates the tab
  // sitting in that position, it never creates one.
  pushEvent({ action: 'focus', url: tab.url, opened: isNew, tabIndex: tab.index }, key);
  try { await ensureCapturing(tabId); } catch (err) {
    console.warn('[MouseFlow] could not start capture in switched tab:', err.message);
  }
});

/* Keep capturing across page loads within a recorded tab, and record the navigation as
 * its own step so replay can drive the tab there rather than hunt for elements that have
 * not loaded. Only the focused tab's navigations are recorded, to keep the stream ordered. */
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!rec.active || info.status !== 'complete') return;
  if (rec.tabKeys[tabId] === undefined) return;
  if (isRestricted(tab.url)) return;

  if (tabId === rec.activeTabId) {
    const last = rec.events[rec.events.length - 1];
    if (!last || last.action !== 'navigate' || last.url !== tab.url) {
      pushEvent({ action: 'navigate', url: tab.url }, rec.tabKeys[tabId]);
    }
  }
  try {
    await ensureCapturing(tabId);
  } catch (err) {
    console.warn('[MouseFlow] could not resume capture after navigation:', err.message);
  }
});

// Closing the actively recorded tab ends the recording; events already streamed are kept.
// Closing any other recorded tab just drops it from the set.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!rec.active) return;
  if (tabId === rec.activeTabId) {
    await recordStop().catch(() => {});
  } else {
    delete rec.tabKeys[tabId];
  }
});

/* Icon click while recording = Stop, then show the result.
 *
 * onClicked only fires when no popup is assigned, which recordStart arranges. Stopping
 * restores the popup and reopens it so the user lands on the saved recording. openPopup
 * needs Chrome 127+; without it the recording is still saved and the next click opens
 * the popup normally. */
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
