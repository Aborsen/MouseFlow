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

import { lastRunModel, runGoal } from './agent.js';
import {
  skillFromRecording, skillFromRun, importSkills, exportSkill, exportMany, fillGoal, missingParams, flowFor,
  publishLink,
} from './skills.js';

/* Kept in step with the manifest by hand, and asserted in the tests: the popup compares the two to
 * tell the user when the worker it is talking to is an older build. A stale constant here would make
 * that warning cry wolf. */
const VERSION = '0.16.2';
// Where the gallery lives. The same deployment that serves the shared Claude key.
const APP_URL = 'https://mouseflowapp.vercel.app';
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
let keepAliveHolders = 0;

/* An MV3 worker is torn down when idle, and a run spends most of its life inside setTimeout,
 * which does not count as activity. Touching a chrome API on a timer keeps it resident.
 *
 * Reference counted, because recording, replay and an agent run can overlap and each needs the
 * worker alive. A plain on/off flag meant whichever finished FIRST switched the keepalive off
 * underneath the others.
 */
function holdWorker(on) {
  keepAliveHolders = Math.max(0, keepAliveHolders + (on ? 1 : -1));
  if (keepAliveHolders > 0 && !keepAlive) {
    keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), KEEPALIVE_MS);
  } else if (keepAliveHolders === 0 && keepAlive) {
    clearInterval(keepAlive);
    keepAlive = null;
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* A wait that notices a stop.
 *
 * Replay honours the pauses in a recording, and a recorded pause can be seconds long. Waiting it
 * out with a single sleep meant Stop appeared to do nothing, then performed one more action before
 * ending. Returns false if the run was aborted while waiting.
 */
async function pausableSleep(ms, aborted) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (aborted()) return false;
    await sleep(Math.min(60, Math.max(1, deadline - Date.now())));
  }
  return !aborted();
}

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

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return null; }
}

/* What a person already knows about the app they are in.
 *
 * The agent is good at deciding what to do next and bad at guessing an application's conventions.
 * It spent twenty steps failing to add a Cc in Gmail: Cc is a control that only appears once the
 * recipient row has focus, and the shortcut that opens it directly was being dropped on the floor
 * by our own press_key.
 *
 * This is the static half of that problem - knowledge that does not change from run to run, handed
 * over when the run is actually on that site. Deliberately short: these are hints, and a long list
 * would crowd out what the page itself is saying. Matched by host suffix.
 */
const SITE_NOTES = [
  {
    host: 'mail.google.com',
    notes: [
      'Cc: Control+Shift+C. Bcc: Control+Shift+B. Use these rather than hunting for the Cc control, which only appears once the recipient row has focus.',
      'Send: Control+Enter.',
      'To reply: open the thread; the reply box is at the BOTTOM of it.',
      'A recipient field takes an address followed by Enter, which turns it into a chip. Check the chip appeared before moving on.',
      'Do not use the pop-out or full-screen buttons; they replace the dialog you are working in.',
    ],
  },
];

function siteNotes(url) {
  const host = hostOf(url) || '';
  const found = SITE_NOTES.find((s) => host === s.host || host.endsWith('.' + s.host));
  return found ? found.notes : null;
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
  /* A double click arrives as a second pointerdown that the page flags as such. Upgrade the
   * click already recorded rather than appending another step - two steps would replay as three
   * clicks. Motion between the two halves is a few pixels at most, so a `path` event in between
   * is skipped over rather than treated as a break. */
  if (ev.action === 'dblclick') {
    for (let i = rec.events.length - 1; i >= 0; i--) {
      const prev = rec.events[i];
      if (prev.action === 'path') continue;
      if (prev.action === 'click' && prev.tab === tabKey && prev.selector === ev.selector) {
        prev.action = 'dblclick';
        rec.lastAt = now;
        return rec.events.length;
      }
      break;
    }
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

  /* A recording exists only as rec.events in this worker's memory, so it must keep the worker
   * resident - alone among the three run kinds it did not, and an idle teardown discarded the
   * whole recording while the badge still read REC. */
  holdWorker(true);
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
  holdWorker(false);
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

/* ---------------------------------------------------------------------- skills */

/* A finished flow, kept and named. See skills.js for the format and why the two kinds differ.
 *
 * Local storage rather than session: a skill is meant to outlive the browser, and eventually to
 * leave the machine entirely.
 */
const SKILLS_MAX = 200;

async function listSkills() {
  const { skills = [] } = await chrome.storage.local.get('skills');
  return skills;
}

async function putSkills(skills) {
  await chrome.storage.local.set({ skills: skills.slice(0, SKILLS_MAX) });
}

/* Saves a skill from whichever kind of flow produced it.
 *
 * A recording is named by the user, so it is taken as it stands. An agent run brings its goal,
 * which is both the description and - once the variable parts are lifted out of it - the source of
 * the skill's parameters.
 */
async function saveSkill(msg) {
  const now = new Date().toISOString();
  let skill;

  if (msg.from === 'recording') {
    const pending = (await chrome.storage.local.get('pending')).pending || [];
    const rec = pending.find((r) => r.id === msg.id) || pending[pending.length - 1];
    if (!rec) throw new Error('no recording to save');
    skill = skillFromRecording(rec, now);
  } else if (msg.from === 'run') {
    /* The last agent run. Read from the trace, not from session storage: a skill is worth making
     * from the run you did yesterday, and session storage does not survive the browser closing. */
    const { agentTrace, agentTraceHistory = [] } = await chrome.storage.local
      .get(['agentTrace', 'agentTraceHistory']);
    const run = agentTrace && agentTrace.finished ? agentTrace : agentTraceHistory[0];
    if (!run || !run.goal) throw new Error('no completed run to save');
    const result = run.result || {};
    if (!result.ok) throw new Error('that run did not succeed, so there is nothing to save yet');
    skill = skillFromRun({ goal: run.goal, steps: result.steps || [] }, now);
  } else {
    throw new Error('unknown skill source ' + msg.from);
  }

  if (msg.name) skill.name = String(msg.name).slice(0, 80);
  if (msg.description) skill.description = String(msg.description).slice(0, 400);

  const skills = await listSkills();
  skills.unshift(skill);
  await putSkills(skills);
  return { ok: true, skill };
}

/* Runs a skill, which means something different for each kind.
 *
 * A recorded skill goes to the replay engine as an ordinary flow. A created skill goes to the agent
 * as a goal with its parameters filled in - which is the point of it: the same errand, different
 * details. It costs an API call per step, and that is the trade for it still working when the page
 * has moved.
 */
async function runSkill(msg) {
  const skills = await listSkills();
  const skill = skills.find((s) => s.id === msg.id);
  if (!skill) throw new Error('that skill is no longer here');

  const stamped = skills.map((s) =>
    (s.id === skill.id ? Object.assign({}, s, { lastRun: new Date().toISOString() }) : s));
  await putSkills(stamped);

  if (skill.kind === 'recorded') {
    return replayStart(flowFor(skill, { loop: !!msg.loop }));
  }
  /* A skill from the gallery carries no example values, so a field left blank has nothing to fall back
   * on. Refuse by name rather than running a goal with a hole in it. */
  const missing = missingParams(skill, msg.values || {});
  if (missing.length) {
    return {
      ok: false,
      error: missing.length === 1
        ? `This skill needs ${missing[0]}. Fill it in and run it again.`
        : `This skill needs ${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}. ` +
          'Fill them in and run it again.',
    };
  }
  /* The skill's identity travels with the run. Without it the account has a run and a skill and no way
   * to say the run WAS that skill - and it cannot be worked out afterwards, so it has to be carried now. */
  return agentStart(fillGoal(skill, msg.values || {}), {
    flowId: skill.id,
    skillVersion: skill.version || skill.created || null,
  });
}

/* ------------------------------------------------------------------------ sync */

/* One account, so a skill made here is also there.
 *
 * The extension cannot hold a session: signing in inside an extension needs an OAuth client tied to
 * its id, and an unpacked extension's id comes from its folder path - different on every machine. So
 * the web app mints a device token, the user pastes it in once, and it goes in the Authorization
 * header from then on. The same pairing a CLI uses, for the same reason.
 *
 * Sync is push-then-pull in one call, and deliberately manual rather than continuous: it is somebody
 * else's data allowance and somebody else's battery, and a flow is not urgent. Nothing is sent until
 * a token exists, so the unpaired extension makes no network calls at all.
 */
const SYNC_URL = APP_URL + '/api/sync';

async function syncToken() {
  const { syncToken: token } = await chrome.storage.local.get('syncToken');
  return typeof token === 'string' && token.startsWith('mf_') ? token : null;
}

async function syncStatus() {
  const token = await syncToken();
  const { syncedAt, syncWho } = await chrome.storage.local.get(['syncedAt', 'syncWho']);
  return { ok: true, paired: !!token, syncedAt: syncedAt || null, who: syncWho || null };
}

async function syncPair(raw) {
  const token = String(raw || '').trim();
  if (!token) throw new Error('paste the token from the web app');
  if (!token.startsWith('mf_')) {
    throw new Error('that does not look like a MouseFlow device token - it should start with mf_');
  }
  /* Checked against the server before it is kept, so a mistyped token fails here rather than at the
   * next sync, when the user is no longer thinking about it. */
  const res = await fetch(SYNC_URL, { headers: { authorization: 'Bearer ' + token } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((body && body.error && body.error.message) || 'the server rejected that token');
  }
  const who = (body && body.you) || null;
  await chrome.storage.local.set({ syncToken: token, syncWho: who });
  return { ok: true, who };
}

async function syncUnpair() {
  // Only forgotten here. Revoking it properly is done from the web app, which is where the account is.
  await chrome.storage.local.remove(['syncToken', 'syncWho', 'syncedAt']);
  return { ok: true };
}

/* A local skill as the account stores a flow. Everything from here is `web`: these steps point at
 * page elements, so only the extension can replay them. */
function flowFromSkill(skill) {
  return {
    id: skill.id,
    source: 'web',
    kind: skill.kind === 'created' ? 'created' : 'recorded',
    name: skill.name,
    description: skill.description || '',
    origins: skill.origins || [],
    created: skill.created || null,
    payload: skill,
  };
}

/* The runs worth keeping: what was asked for, what came back, and every step. Taken from the trace
 * history rather than kept separately - it is already the fullest record there is. */
async function runsToPush() {
  const { agentTrace, agentTraceHistory = [] } = await chrome.storage.local
    .get(['agentTrace', 'agentTraceHistory']);
  const all = [agentTrace].concat(agentTraceHistory).filter((r) => r && r.goal && r.startedAt);
  const seen = new Set();
  const out = [];
  for (const run of all) {
    // startedAt is the only id a trace has, and it is unique per run.
    const id = 'run_' + run.startedAt;
    if (seen.has(id)) continue;
    seen.add(id);
    const result = run.result || {};
    out.push({
      id,
      kind: 'agent',
      goal: run.goal,
      // Which skill this run WAS, when it was one. The column and its index have existed all along.
      flowId: run.flowId || null,
      model: lastRunModel,
      outcome: !run.finished ? 'running' : result.ok ? 'ok' : result.error === 'stopped' ? 'stopped' : 'failed',
      summary: result.summary || null,
      error: result.ok ? null : result.error || null,
      steps: run.steps || [],
      extension: run.version || VERSION,
      startedAt: run.startedAt,
      finishedAt: run.finished ? (run.steps && run.steps.length
        ? run.steps[run.steps.length - 1].at : run.startedAt) : null,
    });
  }
  return out;
}

async function syncNow() {
  const token = await syncToken();
  if (!token) throw new Error('not paired yet - add a device token from the web app');

  const skills = await listSkills();
  const { syncDeleted = [] } = await chrome.storage.local.get('syncDeleted');

  const push = await fetch(SYNC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({
      flows: skills.map(flowFromSkill),
      runs: await runsToPush(),
      deleted: syncDeleted,
    }),
  });
  const pushed = await push.json().catch(() => null);
  if (!push.ok) {
    throw new Error((pushed && pushed.error && pushed.error.message) || 'could not push (HTTP ' + push.status + ')');
  }
  // Tombstones are only needed until the server has them.
  await chrome.storage.local.set({ syncDeleted: [] });

  const pull = await fetch(SYNC_URL, { headers: { authorization: 'Bearer ' + token } });
  const remote = await pull.json().catch(() => null);
  if (!pull.ok) {
    throw new Error((remote && remote.error && remote.error.message) || 'could not pull (HTTP ' + pull.status + ')');
  }

  /* Merge by id. A flow the account has and this machine does not is adopted - which is the whole
   * point - but only if this half can run it: a desktop flow is screen coordinates and replaying it
   * here would click at meaningless positions. It is still visible in the web app, which can. */
  const known = new Set(skills.map((s) => s.id));
  let adopted = 0;
  const incoming = [];
  for (const flow of (remote && remote.flows) || []) {
    if (flow.source !== 'web' || known.has(flow.id) || !flow.payload) continue;
    try {
      const [skill] = importSkills(JSON.stringify(flow.payload));
      skill.id = flow.id;            // keep the account's identity, so it does not re-sync as new
      skill.name = flow.name || skill.name;
      incoming.push(skill);
      adopted++;
    } catch (_) {
      // A flow this build cannot read is left alone rather than dropped from the account.
    }
  }
  if (incoming.length) await putSkills(incoming.concat(skills));

  const who = (remote && remote.you) || null;
  const at = new Date().toISOString();
  await chrome.storage.local.set({ syncedAt: at, syncWho: who });

  return {
    ok: true,
    pushed: { flows: pushed.flows, runs: pushed.runs, problems: pushed.problems || [] },
    adopted,
    desktopFlows: ((remote && remote.flows) || []).filter((f) => f.source === 'desktop').length,
    who,
    syncedAt: at,
  };
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
      if (ctx.touched) ctx.touched.add(tabId);
    }

    await chrome.tabs.update(tabId, { active: true });
    /* Back to the page this step was recorded on. Without it a looped flow plays its second lap
     * into whatever page the first lap navigated to, so every element the lap needs is gone.
     * goTo is a no-op when the tab is already there, and navigating a tab we were given is still
     * mirroring - it never creates one. */
    if (ev.url && !isRestricted(ev.url)) {
      await goTo(tabId, ev.url).catch(() => {});
    }
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
  /* Every tab the whole run touched. ctx.map is rebuilt each pass, so clearing the drawn cursor
   * from it at the end only ever covered the final pass - a looped flow left a cursor stranded in
   * every other tab it had visited. */
  const touched = new Set();
  const ctx = { map: {}, current: null, cursor: null, opts: DEFAULT_SETTINGS, touched };
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
            // Checked while waiting, not only between events, so Stop lands inside a long pause.
            if (!(await pausableSleep(Math.round((ev.delay || 0) / speed), () => play.abort))) break;

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

          if (step.delayAfter > 0) {
            if (!(await pausableSleep(step.delayAfter, () => play.abort))) break;
          }
        }
      }
    }
  } catch (err) {
    play.error = err.message;
  } finally {
    play.active = false;
    holdWorker(false);
    hideCursors([...touched, ctx.current]);
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
  snapshotId: null,   // which frame's snapshot the current refs belong to
  trace: [],      // one entry per tool call: page, outcome, timing - see tracedTool
  startedAt: null,
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

/* ------------------------------------------------------------- the agent's trace */

/* A step-by-step record of what the agent actually did.
 *
 * The log used to be only what the UI needed to draw a feed - a tool name and its input - which
 * says what was ASKED for but not where it landed. When a run wandered off a Gmail compose window
 * into the Play Store there was nothing to explain it: no page per step, no tool result, no
 * timing. So each step now records the URL it acted on, where it ended up if that changed, what
 * came back, and how long it took.
 *
 * Kept in local storage, not session: the worker is torn down when idle and session storage dies
 * with the browser, and the run you want to explain is usually the one from before you closed it.
 */
const TRACE_MAX_STEPS = 300;
const TRACE_MAX_RUNS = 3;
const TRACE_MAX_TEXT = 300;

// read_page returns a whole page snapshot; storing it would swamp the trace and tell you little.
function summariseResult(name, result) {
  if (result == null) return null;
  /* An action now carries the page back with it. Recording that whole snapshot in the trace would
   * bury the step it belongs to, so it is reduced the same way read_page's is. */
  if (name !== 'read_page' && result.page) {
    return {
      done: result.done,
      scrolled: result.scrolled,
      after: {
        elements: result.page.shown == null ? undefined : result.page.shown,
        of: result.page.total,
        dialog: result.page.dialog || undefined,
      },
    };
  }
  if (name !== 'read_page') return result;
  return {
    url: result.url,
    title: result.title,
    // shown/total, because "120 of 840" is the fact that explains an agent acting half-blind.
    elements: result.shown == null ? (result.elements || []).length : result.shown,
    of: result.total == null ? undefined : result.total,
    dialog: result.dialog || undefined,
    frame: agent.frameId == null ? '(not read yet)'
      : agent.frameId === 0 ? 'main' : 'frame ' + agent.frameId,
    truncated: !!result.truncated,
  };
}

async function currentUrl() {
  if (agent.tabId == null) return null;
  const tab = await chrome.tabs.get(agent.tabId).catch(() => null);
  return tab ? tab.url : null;
}

async function saveTrace(done) {
  const run = {
    goal: agent.goal,
    startedAt: agent.startedAt,
    version: VERSION,
    flowId: agent.flowId || null,
    skillVersion: agent.skillVersion || null,
    steps: agent.trace,
    result: done ? agent.result : null,
    finished: !!done,
  };
  try {
    await chrome.storage.local.set({ agentTrace: run });
    if (done) {
      const { agentTraceHistory = [] } = await chrome.storage.local.get('agentTraceHistory');
      agentTraceHistory.unshift(run);
      await chrome.storage.local.set({ agentTraceHistory: agentTraceHistory.slice(0, TRACE_MAX_RUNS) });
    }
  } catch (_) {
    // Storage full or unavailable; the run itself must not fail over logging.
  }
}

/* Wraps every tool call so the trace is a property of running one, not something each case has
 * to remember to do. `execute` is handed this, never runAgentTool directly. */
async function tracedTool(name, input) {
  const step = {
    n: agent.trace.length + 1,
    at: new Date().toISOString(),
    tool: name,
    input: input && input.text
      ? Object.assign({}, input, { text: String(input.text).slice(0, TRACE_MAX_TEXT) })
      : input,
    url: await currentUrl(),
  };

  const started = Date.now();
  let outcome;
  try {
    outcome = await runAgentTool(name, input);
  } catch (err) {
    outcome = { ok: false, error: err.message };
  }
  step.ms = Date.now() - started;
  step.ok = !!outcome.ok;
  if (outcome.ok) {
    step.result = summariseResult(name, outcome.result);
  } else {
    step.error = outcome.error;
    /* Surfaced as an event, not just recorded in the trace. runGoal's onEvent only ever emitted
     * say/act/done - never a tool OUTCOME - so a run failing every single step looked in the popup
     * exactly like one working, right up to the final summary. */
    agent.log.push({ type: 'error', text: '\u2717 ' + name + ' failed: ' + outcome.error });
  }

  /* Where did it end up? A click can navigate, and that is exactly how a run goes astray
   * without any single step looking wrong.
   *
   * Only counts as a move if there was somewhere to move FROM. The first step of a run has no
   * tab yet, so without that guard it always claims to have moved - a false marker on step one,
   * precisely where someone reading the trace is looking for the real one. */
  const after = await currentUrl();
  if (after && step.url && after !== step.url) step.wentTo = after;

  agent.trace.push(step);
  if (agent.trace.length > TRACE_MAX_STEPS) agent.trace.shift();
  await saveTrace(false);
  return outcome;
}

/* One tool call from the model.
 *
 * The tab is resolved per case rather than up front. It used to be one call to `activeTabId()`
 * here - a function that does not exist, so every tool threw ReferenceError before doing
 * anything and the mode had never once worked. Resolving inside each case also means
 * `open_tab` no longer needs an existing usable tab, which is exactly the state it is for.
 */
/* Waiting, without spending a step.
 *
 * The agent used to have no way to wait at all: faced with a page that was loading, generating or
 * streaming an answer, its only options were to call read_page again - a full snapshot, a model call,
 * one of a limited number of steps - or to click around it. A long wait could eat a whole run.
 *
 * So the worker waits on the agent's behalf and polls the page directly, which costs nothing: the
 * content script answers `agent/pulse` with a few numbers, and this returns as soon as they have held
 * still for a couple of looks. One tool call covers what used to take a dozen.
 */
const PULSE_MS = 1200;
const PULSE_QUIET = 2;          // consecutive still looks before calling it settled
const WAIT_CAP_MS = 120000;

function samePulse(a, b) {
  if (!a || !b) return false;
  return a.state === b.state && a.chars === b.chars && a.elements === b.elements &&
    a.busy === b.busy && a.head === b.head && a.tail === b.tail;
}

async function waitForQuiet(limitMs) {
  const tabId = await agentTab();
  const started = Date.now();
  let last = null;
  let still = 0;

  while (Date.now() - started < limitMs) {
    if (agent.abort) break;
    await sleep(PULSE_MS);

    let pulse = null;
    try {
      await ensureContent(tabId);
      pulse = await send(tabId, { mf: 'agent/pulse' }, agent.frameId);
    } catch (_) {
      // A navigation in progress tears the content script down; that is itself "not settled yet".
      last = null;
      still = 0;
      continue;
    }
    if (!pulse || !pulse.ok) { last = null; still = 0; continue; }

    /* Something visibly working counts as movement even if the numbers happen to match - a spinner on
     * an otherwise static page is exactly the case worth waiting through. */
    if (samePulse(last, pulse) && !pulse.busy) {
      still++;
      if (still >= PULSE_QUIET) {
        return { ok: true, settled: true, waitedMs: Date.now() - started };
      }
    } else {
      still = 0;
    }
    last = pulse;
  }

  return { ok: true, settled: false, waitedMs: Date.now() - started };
}

async function runAgentTool(name, input) {
  switch (name) {
    /* Free by design: see waitForQuiet. The answer says which happened, because "quiet after four
     * seconds" and "still moving after two minutes" call for different next moves. */
    case 'wait': {
      const limit = Math.min(WAIT_CAP_MS, Math.max(500, Number(input && input.ms) || 3000));
      const outcome = await waitForQuiet(limit);
      return {
        ok: true,
        result: outcome.settled
          ? { settled: true, waited: Math.round(outcome.waitedMs / 1000) + 's',
              note: 'The page has stopped changing.' }
          : { settled: false, waited: Math.round(outcome.waitedMs / 1000) + 's',
              note: 'Still changing. Wait again with a longer limit if it needs longer.' },
      };
    }
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
      // Conventions of this particular app, if we know any.
      const notes = siteNotes(best.page && best.page.url);
      if (notes) best.page.notes = notes;
      /* Frame 0 is the main frame, and a perfectly valid target. `|| null` collapsed it to
       * null - and null means "unknown" to send(), which then broadcasts to EVERY frame. A
       * broadcast resolves with whichever frame answers first, and refs only mean anything in
       * the frame that produced them, so an iframe would answer with its own ref list and the
       * click would land on a different element entirely. */
      agent.frameId = best.frameId;
      /* The snapshot the refs came from. Every frame was just snapshotted, so every frame holds
       * refs; stamping the action means only this snapshot's frame will act on it. */
      agent.snapshotId = best.page && best.page.snapshotId ? best.page.snapshotId : null;
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
      agent.snapshotId = null;
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
        { mf: 'agent/act', command, from: agent.cursor, opts: agent.opts,
          snapshotId: agent.snapshotId },
        agent.frameId
      );
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'no response from the page' };
      if (res.cursor) agent.cursor = res.cursor;

      /* The page as it is after the action, so the model does not have to spend a turn asking.
       * These refs replace the ones it was working from, so the snapshot id moves with them -
       * otherwise the next action would be stamped with a snapshot that no longer exists. */
      let after = null;
      if (res.page) {
        agent.snapshotId = res.page.snapshotId || agent.snapshotId;
        const notes = siteNotes(res.page.url);
        if (notes) res.page.notes = notes;
        after = res.page;
      }
      // A click often navigates; give the page a moment before the next read_page.
      // A click already waited for the page to settle, in the page itself.
      await sleep(name === 'click' ? 100 : 150);
      return {
        ok: true,
        result: after
          ? { done: name, scrolled: res.scrolled, page: after }
          : { done: name, scrolled: res.scrolled },
      };
    }
    default:
      return { ok: false, error: 'unknown tool ' + name };
  }
}

async function agentStart(goal, from) {
  if (agent.running) throw new Error('already running');
  if (!goal || !goal.trim()) throw new Error('describe what you want done');
  /* No key is not an error any more: without one the run goes through the shared demo
   * endpoint, which attaches a key server-side. A saved key takes precedence and goes direct.
   * See SHARED_URL in agent.js. */
  const { apiKey } = await chrome.storage.local.get('apiKey');

  Object.assign(agent, {
    running: true, abort: false, goal: goal.trim(), log: [], result: null, cursor: null,
    tabId: null, frameId: null, snapshotId: null, trace: [],
    startedAt: new Date().toISOString(),
    opts: await loadSettings(),
    // Null for a goal typed by hand: there is no skill to point at, and inventing one would be worse.
    flowId: (from && from.flowId) || null,
    skillVersion: (from && from.skillVersion) || null,
  });
  holdWorker(true);
  await chrome.action.setBadgeText({ text: 'AI' });
  await chrome.action.setBadgeBackgroundColor({ color: '#8957e5' });
  // Same as replay: while it runs, the icon is the stop button.
  await chrome.action.setPopup({ popup: '' });

  runGoal({
    goal: agent.goal,
    apiKey,
    // Only used on the shared endpoint, which will not spend the demo key for an unknown caller.
    authToken: await syncToken(),
    execute: tracedTool,
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
      // And the full trace, in local storage, so a run can still be explained tomorrow.
      await saveTrace(true);
    });

  return { ok: true };
}

function agentStatus() {
  return {
    ok: true,
    running: agent.running,
    goal: agent.goal,
    log: agent.log.slice(-12),
    /* The last few steps with their pages, so a run drifting somewhere unexpected is visible
     * while it happens rather than only afterwards in a copied log. */
    steps: agent.trace.slice(-6).map((s) => ({
      n: s.n, tool: s.tool, ok: s.ok,
      host: hostOf(s.wentTo || s.url),
      moved: !!s.wentTo,
    })),
    result: agent.result,
  };
}

/* ---------------------------------------------------------------------- the wall */

/* Nobody drives a browser through this anonymously.
 *
 * The popup shows a sign-in screen, but a popup is a suggestion: the worker is reachable from any
 * extension page and from a content script, so the check has to be HERE, at the one door every
 * command comes through. What identifies the user is the device token - the same one sync uses - so
 * "signed in" and "attached to an account" are one state rather than two that can disagree.
 *
 * Open without an account, and only these:
 *
 *   ping, sync/status       answer questions about this extension, not about the user
 *   auth/*                  how you get in; refusing these would lock the door from both sides
 *   sync/pair, sync/unpair  the manual way in, and the way out
 *   settings/*              pointer and trail, kept locally, no account involved
 *   capture/*               a content script streaming into a recording that cannot have started
 *
 * Everything else - recording, replay, the agent, skills, the gallery - needs an account.
 */
const OPEN_WITHOUT_ACCOUNT = new Set([
  'ping', 'auth/start', 'auth/paired', 'auth/who',
  'sync/status', 'sync/pair', 'sync/unpair',
  'settings/get', 'settings/set',
  'capture/event', 'capture/moves',
]);

/* Which pages may hand a token in. The bridge content script runs only on the app's own origin
 * (see the manifest), and this is the other half of that: a message claiming to be the bridge is
 * checked against where it actually came from. */
const BRIDGE_ORIGINS = new Set([APP_URL]);
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function fromBridge(sender) {
  if (!sender || !sender.tab) return false;               // a real page, not an extension view
  const origin = sender.origin || (sender.url ? new URL(sender.url).origin : '');
  // localhost on any port too, for development against a local copy of the app.
  return BRIDGE_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin);
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
  /* Signing in IS pairing with the account - one click instead of copying a token by hand.
   *
   * This opens the app, which is where a session can actually live: it is the app's own origin, so
   * Google's callback can set a first-party cookie there. Once signed in, the page mints a device
   * token and hands it to the bridge content script, which brings it back here. The user never sees
   * the token. Pasting one by hand still works, and is the fallback for when the handover cannot
   * happen - a different browser, or the app open in a profile without the extension. */
  'auth/start': async () => {
    await chrome.tabs.create({ url: APP_URL + '/?pair=extension#skills', active: true });
    return { ok: true };
  },
  'auth/who': () => syncStatus(),
  /* The handover. Only from the app's own origin: a token is a credential, and this is the one
   * route that accepts one from a web page. */
  'auth/paired': async (msg, sender) => {
    if (!fromBridge(sender)) throw new Error('not available to this page');
    const res = await syncPair(msg.token);
    // Straight into a sync, so the first thing the user sees is their own skills rather than none.
    const synced = await syncNow().catch(() => null);
    return { ok: true, who: res.who, synced: synced ? synced.pushed : null };
  },
  /* The web app's console. Same run, same worker, same agent - reached from the app's own page
   * instead of from the popup, because a page cannot act on another page and this half can.
   *
   * Separate route names rather than letting the app call agent/* directly: the page's surface should
   * be readable as its own list, and it should be impossible to widen it by accident while editing
   * something the popup uses. Each one refuses a sender that is not our own origin. */
  'page/run': async (msg, sender) => {
    if (!fromBridge(sender)) throw new Error('not available to this page');
    return agentStart(msg.goal);
  },
  'page/status': async (msg, sender) => {
    if (!fromBridge(sender)) throw new Error('not available to this page');
    return agentStatus();
  },
  'page/abort': async (msg, sender) => {
    if (!fromBridge(sender)) throw new Error('not available to this page');
    agent.abort = true;
    return { ok: true };
  },
  'skills/list': async () => ({ ok: true, skills: await listSkills() }),
  'sync/status': () => syncStatus(),
  'sync/pair': (msg) => syncPair(msg.token),
  'sync/unpair': () => syncUnpair(),
  'sync/now': () => syncNow(),
  'skills/save': (msg) => saveSkill(msg),
  'skills/run': (msg) => runSkill(msg),
  'skills/rename': async (msg) => {
    const skills = await listSkills();
    const skill = skills.find((s) => s.id === msg.id);
    if (!skill) throw new Error('that skill is no longer here');
    if (msg.name) skill.name = String(msg.name).slice(0, 80);
    if (msg.description != null) skill.description = String(msg.description).slice(0, 400);
    await putSkills(skills);
    return { ok: true, skill };
  },
  'skills/delete': async (msg) => {
    await putSkills((await listSkills()).filter((s) => s.id !== msg.id));
    /* Remembered until the account has been told. Without this the next sync pulls it straight back
     * down, and deleting anything would look broken. */
    const { syncDeleted = [] } = await chrome.storage.local.get('syncDeleted');
    if (!syncDeleted.includes(msg.id)) {
      await chrome.storage.local.set({ syncDeleted: syncDeleted.concat(msg.id) });
    }
    return { ok: true };
  },
  /* Browsing the gallery from inside the extension.
   *
   * Reading the gallery needs no session - it is public - so the extension can fetch it directly and
   * install with one click, rather than sending someone to a page to copy JSON and paste it back.
   * The whole point of a gallery is that taking something out of it is easy.
   */
  'gallery/list': async (msg) => {
    const url = APP_URL + '/api/gallery' +
      (msg.q ? '?q=' + encodeURIComponent(String(msg.q).slice(0, 80)) : '');
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error((body && body.error && body.error.message) ||
        'the gallery is not answering (HTTP ' + res.status + ')');
    }
    return { ok: true, skills: (body && body.skills) || [] };
  },

  /* Installing is fetching the payload and putting it through the same door a pasted skill uses -
   * importSkills validates and rebuilds field by field. A skill from the gallery is no more trusted
   * than one from a colleague: it came off the internet, and it is about to drive a browser. */
  'gallery/install': async (msg) => {
    const id = String(msg.id || '');
    if (!id) throw new Error('which skill?');
    const res = await fetch(APP_URL + '/api/gallery?id=' + encodeURIComponent(id),
      { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.skill || !body.skill.payload) {
      throw new Error((body && body.error && body.error.message) ||
        'could not fetch that skill (HTTP ' + res.status + ')');
    }
    const incoming = importSkills(JSON.stringify(body.skill.payload));
    const skills = await listSkills();
    // Remember where it came from, so a listing can say so and a duplicate install is visible.
    for (const skill of incoming) skill.from = { gallery: id, name: body.skill.name };
    await putSkills(incoming.concat(skills));
    return { ok: true, added: incoming.length, skill: incoming[0] };
  },

  /* Publishing opens the gallery page with the skill in the fragment, rather than posting from
   * here. The page holds the session - and a fragment never reaches a server, so the skill does not
   * travel through a request log on its way to being published. */
  'skills/publish': async (msg) => {
    const skills = await listSkills();
    const skill = skills.find((s) => s.id === msg.id);
    if (!skill) throw new Error('that skill is no longer here');
    const url = publishLink(skill, APP_URL);
    await chrome.tabs.create({ url, active: true });
    return { ok: true };
  },
  'skills/export': async (msg) => {
    const skills = await listSkills();
    if (msg.id) {
      const skill = skills.find((s) => s.id === msg.id);
      if (!skill) throw new Error('that skill is no longer here');
      return { ok: true, text: exportSkill(skill) };
    }
    if (!skills.length) throw new Error('there are no skills to export');
    return { ok: true, text: exportMany(skills) };
  },
  'skills/import': async (msg) => {
    // importSkills validates and rebuilds field by field; anything pasted in is untrusted.
    const incoming = importSkills(msg.text);
    const skills = await listSkills();
    await putSkills(incoming.concat(skills));
    return { ok: true, added: incoming.length, skills: incoming };
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
    .then(async () => {
      if (!OPEN_WITHOUT_ACCOUNT.has(msg.mf) && !(await syncToken())) {
        /* A flag rather than a message the caller has to pattern-match: the popup puts the wall
         * back up when it sees this, wherever in the UI the command came from. */
        return { ok: false, signedOut: true, error: 'Sign in to use MouseFlow.' };
      }
      return handler(msg, sender);
    })
    .then((res) => respond(res))
    .catch((err) => respond({ ok: false, error: err.message }));
  return true;   // responding asynchronously
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => route(msg, sender, respond));
/* The external channel is NOT the popup channel.
 *
 * externally_connectable lets the deployed app and localhost post messages here, and they were
 * handed to the same unauthenticated dispatcher the popup uses - so any page on localhost could
 * start an agent run, which drives the browser and spends the shared API key, by posting one
 * message. Until the app bridge is actually built and has something to authenticate with, only
 * harmless questions are answerable from outside.
 */
const EXTERNAL_ALLOWED = new Set(['ping']);
function externalListener(msg, sender, respond) {
  if (!msg || typeof msg.mf !== 'string' || !EXTERNAL_ALLOWED.has(msg.mf)) {
    respond({ ok: false, error: 'not available to web pages' });
    return true;
  }
  return route(msg, sender, respond);
}
chrome.runtime.onMessageExternal.addListener(externalListener);

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

/* ------------------------------------------------------------------ orphaned runs
 *
 * A worker torn down mid-run - browser closed, extension reloaded, worker crashed - never gets to write a
 * finished trace, and saveTrace's last write is always `finished: false`. That run then syncs as outcome
 * 'running' and stays that way for good: nothing else ever revisits it.
 *
 * The worker starting again is proof that whatever was running is not running any more. Say so, once, at
 * startup - before anything else can look at the trace. A row that admits it was interrupted is more use
 * than one that claims to still be going.
 */
async function reapInterruptedRun() {
  try {
    const { agentTrace } = await chrome.storage.local.get('agentTrace');
    if (!agentTrace || agentTrace.finished) return;
    const closed = Object.assign({}, agentTrace, {
      finished: true,
      result: {
        ok: false,
        error: 'The browser or the extension stopped before this run finished.',
        steps: agentTrace.steps || [],
      },
    });
    await chrome.storage.local.set({ agentTrace: closed });
    const { agentTraceHistory = [] } = await chrome.storage.local.get('agentTraceHistory');
    if (!agentTraceHistory.some((r) => r && r.startedAt === closed.startedAt)) {
      agentTraceHistory.unshift(closed);
      await chrome.storage.local.set({ agentTraceHistory: agentTraceHistory.slice(0, TRACE_MAX_RUNS) });
    }
  } catch (_) {
    // Storage unavailable: a stale row is not worth failing a startup over.
  }
}

/* Both events, because neither fires reliably on its own: onStartup misses an extension reload, and
 * onInstalled misses a browser restart. Reaping twice is harmless - the second call sees `finished`. */
chrome.runtime.onStartup.addListener(reapInterruptedRun);
chrome.runtime.onInstalled.addListener(reapInterruptedRun);
reapInterruptedRun();
