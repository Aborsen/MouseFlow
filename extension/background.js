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

const VERSION = '0.6.0';
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

/* ------------------------------------------------------------------- settings */

/* What the drawn pointer does, as user settings rather than as taste baked into the code.
 *
 * The pointer is on because a replay is otherwise indistinguishable from one doing nothing.
 * The trail is off: it reads as ink on a page that has content of its own - a line drawn
 * across a spreadsheet grid looks like part of the document, not like a cursor.
 *
 * Read once when a run starts and passed to the page with each step, so a run cannot change
 * its own appearance halfway through.
 */
const DEFAULT_SETTINGS = { pointer: true, trail: false };

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULT_SETTINGS, settings || {});
}

async function saveSettings(patch) {
  const next = Object.assign(await loadSettings(), {});
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key];
  }
  await chrome.storage.local.set({ settings: next });
  return next;
}

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

/* Injected into EVERY frame, not just the top one.
 *
 * Excel Online, Google Docs, Teams and most embedded editors put the actual application
 * inside nested iframes. Injecting only the main frame meant none of them were ever
 * instrumented: clicks in the grid were never captured, and the drawn cursor went into a
 * shell document the user could not see it in. This was the real cause behind several
 * failures blamed on capture, on text, and on the cursor.
 *
 * The script's own `__mouseflowContent` guard makes re-injection a no-op in the page, so
 * this is cheap enough to call before every step and removes the stale-ping race that
 * the previous version could lose after a navigation.
 */
async function ensureContent(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content.js'],
  });
}

/* Messages go to ONE frame when we know which, because a broadcast resolves with
 * whichever frame answers first - and in an iframed app that is usually the wrong one. */
async function send(tabId, message, frameId) {
  await ensureContent(tabId);
  const options = frameId == null ? undefined : { frameId };
  return chrome.tabs.sendMessage(tabId, message, options);
}

// The drawn cursor lives in the page, so it has to be told to go away when a run ends -
// in every tab the run touched, not just the last one.
function hideCursors(tabIds) {
  for (const id of new Set(tabIds.filter((v) => v != null))) {
    chrome.tabs.sendMessage(id, { mf: 'cursor/hide' }).catch(() => {});
  }
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

// Capture starts in every frame, so a click inside an iframed app is recorded by the
// frame that actually owns the element.
async function ensureCapturing(tabId) {
  await ensureContent(tabId);
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  const ids = frames ? frames.map((f) => f.frameId) : [0];
  await Promise.all(ids.map((frameId) =>
    chrome.tabs.sendMessage(tabId, { mf: 'capture/start' }, { frameId }).catch(() => {})
  ));
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
// The sending frame travels with the event so replay can go back to that same frame.
function captureFromPage(ev, sender) {
  if (!rec.active) return { ok: false, error: 'not recording' };
  const senderTabId = sender && sender.tab && sender.tab.id;
  if (senderTabId !== rec.activeTabId) return { ok: true, ignored: true };
  const key = rec.tabKeys[senderTabId];
  if (key === undefined) return { ok: true, ignored: true };

  const frameId = sender.frameId || 0;
  if (frameId) ev.frame = frameId;
  return { ok: true, count: pushEvent(ev, key) };
}

/* A batch of motion samples.
 *
 * Stored as ONE `path` event per continuous run rather than one event per sample. The page
 * replays a whole run as a single animation, so this keeps the event stream - and the step
 * log, and the counts the popup shows - about ACTIONS, with motion as a property of the gap
 * between them. Ten seconds of mouse movement must not read as six hundred steps.
 */
function captureMoves(msg, sender) {
  if (!rec.active) return { ok: false, error: 'not recording' };
  const senderTabId = sender && sender.tab && sender.tab.id;
  if (senderTabId !== rec.activeTabId) return { ok: true, ignored: true };
  const key = rec.tabKeys[senderTabId];
  if (key === undefined) return { ok: true, ignored: true };

  const points = (msg.points || [])
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: p.x, y: p.y, dt: Math.max(0, Math.round(p.dt || 0)) }));
  if (!points.length) return { ok: true, count: rec.events.length };

  const frame = sender.frameId || 0;

  /* Undo the flush lag. The batch carries how long ago its last sample was taken, so the
   * run can be placed where it actually happened instead of where it arrived - otherwise
   * every batch would push a quarter second of dead time into the replay. */
  const lastAt = Date.now() - Math.max(0, Math.round(msg.age || 0));
  const span = points.slice(1).reduce((sum, p) => sum + p.dt, 0);
  const gap = Math.max(0, lastAt - span - rec.lastAt);

  // Consecutive batches from the same frame are one continuous movement; join them so the
  // page animates a single path instead of restarting four times a second.
  const last = rec.events[rec.events.length - 1];
  if (last && last.action === 'path' && last.tab === key && (last.frame || 0) === frame &&
      gap < MOVE_JOIN_MS && last.points.length + points.length <= PATH_MAX_POINTS) {
    points[0].dt = gap;
    last.points.push(...points);
    rec.lastAt = lastAt;
    return { ok: true, count: rec.events.length };
  }

  // First sample's own gap is carried by the event's `delay`, so it must not be waited twice.
  points[0].dt = 0;
  const ev = { action: 'path', points, tab: key };
  if (frame) ev.frame = frame;
  rec.events.push(Object.assign({ delay: rec.events.length === 0 ? 0 : gap }, ev));
  rec.lastAt = lastAt;
  return { ok: true, count: rec.events.length };
}

/* ------------------------------------------------------------- motion, tidied up */

/* Recorded motion is stored raw and cleaned up once, at save time. Two reasons to bother:
 * a sample the path would pass through anyway costs storage and buys nothing, and a single
 * long run is a single animation, which is how long a Stop can take to be noticed. */
const PATH_MAX_POINTS = 400;   // per stored path event
const PATH_MAX_MS = 1500;      // and per event, so Stop is never far away
const MOVE_JOIN_MS = 400;      // gap under which two batches are the same movement
const SIMPLIFY_PX = 2;         // drop samples this close to the line between their neighbours

// Distance from p to the SEGMENT ab - clamped, not the infinite line, so a sample beyond an
// endpoint is not credited with being close to a path that never reaches it.
function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/* Ramer-Douglas-Peucker: keep the samples the shape needs and drop the rest.
 *
 * The tolerance has to be measured against the polyline that will REMAIN, which is what
 * makes this recursive. Comparing each sample to the short line between its immediate
 * neighbours instead - the obvious cheap version - measures local smoothness, and any
 * smooth curve passes: an earlier cut of this flattened a 9px hand wobble into a straight
 * line while nominally enforcing a 2px tolerance.
 */
function keepIndices(points, tol) {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    let worst = 0;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSegment(points[i], points[lo], points[hi]);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol && at > 0) {
      keep[at] = 1;
      stack.push([lo, at], [at, hi]);
    }
  }
  return keep;
}

/* A dropped sample's time is folded into the next one kept, so the run still takes exactly
 * as long as it did when recorded - dropping the time along with the point would speed the
 * replay up in proportion to how straight the movement was. */
function simplifyPath(points) {
  if (points.length < 3) return points;
  const keep = keepIndices(points, SIMPLIFY_PX);
  const out = [];
  let carry = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const dt = Math.max(0, p.dt || 0);
    if (!keep[i]) { carry += dt; continue; }
    out.push({ x: p.x, y: p.y, dt: dt + carry });
    carry = 0;
  }
  return out;
}

// Splits a long run into events of bounded length. One event is one animation, and abort is
// checked between events, so this is what keeps the icon responsive during a long sweep.
function chunkPath(ev) {
  const chunks = [];
  let points = [];
  let ms = 0;
  let delay = ev.delay || 0;

  const flush = () => {
    if (!points.length) return;
    const out = { action: 'path', delay, tab: ev.tab, points };
    if (ev.frame) out.frame = ev.frame;
    chunks.push(out);
    points = [];
    ms = 0;
  };

  for (const p of ev.points) {
    // Tested BEFORE taking the sample, or a chunk overshoots the bound by one sample's
    // worth of time. The length guard keeps a lone long-gap sample from looping.
    if (points.length && (points.length >= PATH_MAX_POINTS || ms + p.dt > PATH_MAX_MS)) {
      const carried = p.dt;
      flush();
      delay = carried;                       // the gap moves onto the new event
      points.push({ x: p.x, y: p.y, dt: 0 });
      continue;
    }
    points.push(p);
    ms += p.dt;
  }
  flush();
  return chunks;
}

function compact(events) {
  const out = [];
  let carry = 0;
  for (const ev of events) {
    if (ev.action !== 'path') {
      out.push(carry ? Object.assign({}, ev, { delay: (ev.delay || 0) + carry }) : ev);
      carry = 0;
      continue;
    }
    const points = simplifyPath(ev.points || []);
    if (points.length < 2) {
      // One sample is a twitch, not a movement - but the time it occupied still belongs to
      // the timeline, so it moves onto whatever comes next.
      carry += (ev.delay || 0) + points.reduce((sum, p) => sum + p.dt, 0);
      continue;
    }
    out.push(...chunkPath(Object.assign({}, ev, { points, delay: (ev.delay || 0) + carry })));
    carry = 0;
  }
  return out;
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
  /* Actions and motion counted apart. Motion arrives at sixty samples a second, so a
   * single number would race into the thousands while the user is only clicking a few
   * times - which reads as a bug rather than as a recording going well. */
  let actions = 0;
  let motion = 0;
  for (const e of rec.events) {
    if (e.action === 'path') motion += e.points.length;
    else actions++;
  }
  return {
    ok: true,
    recording: rec.active,
    count: actions,
    motion,
    tabs,
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

  // Motion is cleaned up once, here, rather than on every replay.
  const events = compact(rec.events);
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
  const looping = !flow.flowRepeat;
  await chrome.action.setBadgeText({ text: looping ? 'LOOP' : 'RUN' });
  await chrome.action.setBadgeBackgroundColor({ color: looping ? '#8957e5' : '#4c8dff' });
  /* Clearing the assigned popup makes the icon fire onClicked instead of opening the
   * popup, which turns the toolbar icon into the stop button for the duration. That
   * matters most for a loop: it never ends on its own, and the popup closes the moment
   * the user clicks anywhere in the page. */
  await chrome.action.setPopup({ popup: '' });

  // Not awaited: the caller gets an immediate ack and polls replay/status.
  runFlow(steps, flow).catch((err) => { play.error = err.message; });
  return { ok: true };
}

// Carries the logical-tab -> real-tab mapping across the whole flow. `current` is the tab
// the next non-focus event acts on, and `cursor` is where the drawn pointer was left.
async function performEvent(ev, ctx, speed) {
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

  /* The cursor is drawn per tab, in the top frame of that tab, but its POSITION has to be
   * continuous across tabs and frames or it appears from nowhere at every boundary. So the
   * position lives here, between steps: each step is told where the pointer was left and
   * reports back where it ended. */
  const channel = ev.action === 'path' ? 'replay/path' : 'replay/event';
  const event = ev.action === 'path' && speed !== 1 ? Object.assign({}, ev, { speed }) : ev;

  // Back to the frame that recorded it. A step captured inside an iframed app is
  // meaningless in the shell document, and vice versa.
  const res = await send(
    ctx.current,
    { mf: channel, event, from: ctx.cursor, opts: ctx.opts },
    ev.frame
  );
  if (!res || !res.ok) throw new Error((res && res.error) || 'no response from the page');
  if (res.cursor) ctx.cursor = res.cursor;
}

async function runFlow(steps, flow) {
  // `cursor` deliberately survives each pass: a loop should look like one continuous run,
  // not like the pointer being re-summoned at the top of every lap.
  const ctx = { map: {}, current: null, cursor: null, opts: DEFAULT_SETTINGS };
  try {
    // Read once, so a long run keeps the appearance it started with.
    ctx.opts = await loadSettings();
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
              await performEvent(ev, ctx, speed);
              ok = true;
            } catch (err) {
              error = err.message;
            }

            const entry = {
              n: i + 1,
              action: ev.action,
              tab: ev.tab == null ? 0 : ev.tab,
              target: ev.selector || ev.url ||
                (ev.action === 'path' ? ev.points.length + ' samples' : '') ||
                (ev.action === 'scroll' ? 'window' : '?'),
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
    hideCursors(Object.values(ctx.map).concat(ctx.current));
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setPopup({ popup: 'popup.html' });
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

const agent = {
  running: false, abort: false, goal: '', log: [], result: null, frameId: null,
  cursor: null,   // where the drawn pointer was left, so it travels instead of teleporting
  tabId: null,    // the tab this run is working in, held so a user tab switch cannot divert it
  opts: DEFAULT_SETTINGS,
};

/* The tab the agent is working in.
 *
 * Resolved lazily and then remembered. Lazily, because the agent's first act is often to open
 * a tab and it would be absurd to refuse the job for want of a usable tab it is about to
 * create. Remembered, because otherwise every step re-reads whatever is focused now - so the
 * user switching tabs mid-run would quietly hand the agent a different page to act on.
 */
async function agentTab() {
  if (agent.tabId != null) {
    const tab = await chrome.tabs.get(agent.tabId).catch(() => null);
    if (tab) return tab.id;
    agent.tabId = null;      // closed under us; fall through and adopt another
  }
  const tab = await activeTab();
  agent.tabId = tab.id;
  return tab.id;
}

/* One tool call from the model.
 *
 * The tab is resolved per case rather than up front. It used to be one call to `activeTabId()`
 * here - a function that does not exist, so every tool threw ReferenceError before doing
 * anything and the mode had never once worked. Resolving inside each case also means
 * `open_tab` no longer needs an existing usable tab, which is exactly the state it is for.
 */
async function runAgentTool(name, input) {
  switch (name) {
    case 'read_page': {
      const tabId = await agentTab();
      /* Read every frame and keep the richest one.
       *
       * In an iframed app - Excel Online, Google Docs, Teams - the top document is a
       * shell with almost nothing in it, so a snapshot of the main frame shows the model
       * an empty page. Whichever frame has the most interactive elements is the app, and
       * subsequent clicks are aimed there. */
      await ensureContent(tabId);
      const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
      const ids = frames ? frames.map((f) => f.frameId) : [0];

      let best = null;
      for (const frameId of ids) {
        const res = await chrome.tabs
          .sendMessage(tabId, { mf: 'agent/snapshot', limit: 120 }, { frameId })
          .catch(() => null);
        if (!res || !res.ok) continue;
        const count = res.page.elements.length;
        if (!best || count > best.count) best = { count, frameId, page: res.page };
      }

      if (!best) return { ok: false, error: 'could not read the page' };
      agent.frameId = best.frameId || null;
      return { ok: true, result: best.page };
    }
    case 'navigate': {
      await goTo(await agentTab(), input.url);
      return { ok: true, result: { navigated: input.url } };
    }
    case 'open_tab': {
      const created = await chrome.tabs.create({ url: input.url, active: true });
      // The new tab becomes the one the agent works in - otherwise the next step would act
      // on whatever was focused before, which is not the page it just asked for.
      agent.tabId = created.id;
      agent.frameId = null;      // refs from the old page mean nothing here
      try { await pollComplete(created.id); } catch (_) { /* the next read_page will show it */ }
      return { ok: true, result: { opened: input.url } };
    }
    case 'click':
    case 'type_text':
    case 'press_key':
    case 'scroll': {
      const tabId = await agentTab();
      const command = Object.assign({}, input, {
        action: name === 'type_text' ? 'type' : name,
      });
      // Aimed at whichever frame read_page found the elements in - refs only mean
      // anything in the frame that produced them. `from` keeps the drawn cursor continuous
      // across steps, exactly as replay does.
      const res = await send(
        tabId,
        { mf: 'agent/act', command, from: agent.cursor, opts: agent.opts },
        agent.frameId
      );
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'no response from the page' };
      if (res.cursor) agent.cursor = res.cursor;
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
  if (!goal || !goal.trim()) throw new Error('describe what you want done');
  /* No key is not an error any more: without one the run goes through the shared demo
   * endpoint, which attaches a key server-side. A saved key takes precedence and goes direct.
   * See SHARED_URL in agent.js. */
  const { apiKey } = await chrome.storage.local.get('apiKey');

  Object.assign(agent, {
    running: true, abort: false, goal: goal.trim(), log: [], result: null, cursor: null,
    tabId: null, frameId: null,
    opts: await loadSettings(),
  });
  holdWorker(true);
  await chrome.action.setBadgeText({ text: 'AI' });
  await chrome.action.setBadgeBackgroundColor({ color: '#8957e5' });
  // Same as replay: while it runs, the icon is the stop button.
  await chrome.action.setPopup({ popup: '' });

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
      // The agent roams across tabs, so clear the cursor from every one that still has it.
      try {
        const tabs = await chrome.tabs.query({});
        hideCursors(tabs.map((t) => t.id));
      } catch (_) {}
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setPopup({ popup: 'popup.html' });
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
  'capture/event': async (msg, sender) => captureFromPage(msg.event, sender),
  'capture/moves': async (msg, sender) => captureMoves(msg, sender),
  // The worker owns the defaults so the popup cannot drift from them.
  'settings/get': async () => ({ ok: true, settings: await loadSettings() }),
  'settings/set': async (msg) => ({ ok: true, settings: await saveSettings(msg.settings || {}) }),
  'record/start': (msg) => recordStart(msg.tabId),
  'record/status': () => recordStatus(),
  'record/stop': () => recordStop(),
  replay: (msg) => replayStart(msg.flow || {}),
  'replay/status': async () => replayStatus(),
  'replay/abort': async () => { play.abort = true; return { ok: true }; },
  /* Does the extension reach this page at all?
   *
   * Every failure so far has looked the same from the popup - a run that reports
   * something while the page appears untouched. This separates the layers and names the
   * one that broke, rather than leaving the user to infer it. */
  selftest: async () => {
    let tab;
    try {
      tab = await activeTab();
    } catch (err) {
      return { ok: false, stage: 'tab', error: err.message };
    }
    try {
      await ensureContent(tab.id);
    } catch (err) {
      return {
        ok: false, stage: 'inject',
        error: 'Cannot run on this page: ' + err.message +
          ' (host permissions, a Web Store page, or a PDF viewer will all do this)',
      };
    }
    await sleep(80);

    // Demo in every frame. In an iframed app the top document is a shell the user cannot
    // see the cursor in, which is exactly how Excel Online looked like a failure.
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => null);
    const ids = frames ? frames.map((f) => f.frameId) : [0];
    const answered = [];
    for (const frameId of ids) {
      const res = await chrome.tabs
        .sendMessage(tab.id, { mf: 'cursor/demo' }, { frameId })
        .catch(() => null);
      if (res && res.ok) answered.push({ frameId, url: res.url, viewport: res.viewport });
    }

    if (!answered.length) {
      return { ok: false, stage: 'message', error: 'Injected into ' + ids.length +
        ' frame(s), but none answered' };
    }
    return { ok: true, frames: ids.length, answered };
  },
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
  // Whatever is running, the icon stops it. A loop has no other exit once the popup
  // has closed, so this is the one control that must always work.
  if (play.active) {
    play.abort = true;
    await chrome.action.setPopup({ popup: 'popup.html' });
    try { await chrome.action.openPopup(); } catch (_) {}
    return;
  }

  if (agent.running) {
    agent.abort = true;
    await chrome.action.setPopup({ popup: 'popup.html' });
    try { await chrome.action.openPopup(); } catch (_) {}
    return;
  }

  if (rec.active) {
    const res = await recordStop().catch((err) => ({ ok: false, error: err.message }));
    if (res && res.saved) {
      await chrome.action.setBadgeText({ text: String(res.saved.events.length) });
      await chrome.action.setBadgeBackgroundColor({ color: '#2ea043' });
    }
    try { await chrome.action.openPopup(); } catch (_) {}
    return;
  }

  await chrome.action.setPopup({ popup: 'popup.html' });
  try { await chrome.action.openPopup(); } catch (_) {}
});
