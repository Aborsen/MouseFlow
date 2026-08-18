/* MouseFlow - record mouse actions, replay them, chain them into flows.
 *
 * The browser half owns the UI, the recording library and the flow model.
 * The local agent owns the two things a page cannot do: a global mouse hook
 * and real input injection. Everything crossing that line is the plain-text
 * event format Mini Mouse Macro uses:
 *
 *     index | X | Y | delayMs | action
 */

'use strict';

const STORE_KEY = 'mouseflow.v1';
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 3, 5];

const state = {
  port: 8787,
  recordings: [],
  flow: [],
  startDelay: 3000,
  flowRepeat: 1,
  flowForever: false,
  onboarding: { copied: false, autostartSkipped: false, ranOnce: false },
};

// null = follow the onboarding state, true/false = the user opened or closed it by hand
let setupOverride = null;

let health = null;         // last /health payload, or null when offline

/* The build this app needs on the other end.
 *
 * The agent gains abilities faster than anyone restarts it, and an old one fails in ways that look like
 * bugs rather than like being old: /shot and /do missing (it cannot act at all), /windows missing (it
 * opens a second copy of a program that is already running), text arriving as one inline paragraph.
 * Stated once here, compared against what answers, and the fix - the command - offered on the spot
 * rather than left for someone to find.
 */
const AGENT_WANTS = '0.5.0';

const olderThanWanted = (running) => {
  if (!running) return false;
  const mine = String(running).split('.').map((part) => parseInt(part, 10) || 0);
  const want = AGENT_WANTS.split('.').map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(mine.length, want.length); i++) {
    if ((mine[i] || 0) < (want[i] || 0)) return true;
    if ((mine[i] || 0) > (want[i] || 0)) return false;
  }
  return false;
};
let recordTimer = null;
let replayTimer = null;
let healthTimer = null;
let healthFailures = 0;

/* ------------------------------------------------------------------ helpers */

const $ = (sel) => document.querySelector(sel);

function h(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v != null) node.setAttribute(k, String(v));
    }
  }
  for (const child of [].concat(children || [])) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function fmtMs(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  return m + 'm ' + Math.round((ms % 60000) / 1000) + 's';
}

function toast(message, kind) {
  const node = h('div', { class: 'toast' + (kind ? ' toast--' + kind : ''), text: message });
  $('#toasts').appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .3s';
    setTimeout(() => node.remove(), 320);
  }, kind === 'bad' ? 6500 : 3200);
}

/* ------------------------------------------------------- .mmmacro text format */

const LINE_RX = /^\s*(\d+)\s*\|\s*(-?\d+)\s*\|\s*(-?\d+)\s*\|\s*(-?\d+)\s*\|\s*(.+?)\s*$/;

function parseMacro(text) {
  const events = [];
  let skipped = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = LINE_RX.exec(line);
    if (!m) { skipped++; continue; }
    events.push({
      x: parseInt(m[2], 10),
      y: parseInt(m[3], 10),
      delay: parseInt(m[4], 10),
      action: m[5],
    });
  }
  return { events, skipped };
}

function serializeMacro(events) {
  return events
    .map((e, i) => [i + 1, e.x, e.y, e.delay, e.action].join(' | '))
    .join('\n');
}

function summarize(events) {
  let duration = 0, clicks = 0, moves = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const e of events) {
    duration += e.delay;
    if (e.action === 'Mouse Movement') moves++;
    else if (/Down$/.test(e.action)) clicks++;
    if (e.x < minX) minX = e.x;
    if (e.x > maxX) maxX = e.x;
    if (e.y < minY) minY = e.y;
    if (e.y > maxY) maxY = e.y;
  }
  return { duration, clicks, moves, minX, maxX, minY, maxY, count: events.length };
}

/* ------------------------------------------------- local network access (LNA) */

/* Chrome 142 shipped Local Network Access, which replaced Private Network Access:
 * reaching 127.0.0.1 from a PUBLIC origin now needs a user permission, and the old
 * Access-Control-Allow-Private-Network response header no longer grants anything.
 *
 * A loopback page talking to loopback is same-address-space and never prompts, so this
 * is invisible in local development and only appears once the app is deployed.
 *
 * The prompt therefore has to be provoked from a real click. Firing it from the
 * background health poll risks it being auto-dismissed, and a page that quietly sits at
 * "Agent offline" because a permission was never granted is unrecoverable from the UI.
 */

const PAGE_IS_LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);

let lnaGranted = PAGE_IS_LOOPBACK;   // nothing to grant when the page is itself loopback

async function refreshLnaState() {
  if (PAGE_IS_LOOPBACK) return true;
  if (!navigator.permissions || !navigator.permissions.query) return lnaGranted;
  try {
    const status = await navigator.permissions.query({ name: 'local-network-access' });
    lnaGranted = status.state === 'granted';
    status.onchange = () => {
      lnaGranted = status.state === 'granted';
      if (lnaGranted) pollHealth().then(scheduleHealth);
      else renderOnboarding();
    };
  } catch (_) {
    // Permission not queryable (or not implemented) - fall back to click-to-connect.
  }
  return lnaGranted;
}

// Runs inside a click, so the permission prompt gets user activation behind it.
async function connectToAgent() {
  await pollHealth();
  lnaGranted = lnaGranted || !!health;
  if (health) {
    scheduleHealth();
  } else {
    toast('No agent answered on port ' + state.port + '. Check the PowerShell window is ' +
          'still open, and that you allowed local network access.', 'bad');
    renderOnboarding();
  }
}

/* ------------------------------------------------------------ agent transport */

function agentBase() {
  return 'http://127.0.0.1:' + state.port;
}

async function agentReq(path, { method = 'GET', body = null, timeout = 4000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const init = {
    method,
    body,
    headers: body == null ? undefined : { 'Content-Type': 'text/plain' },
    mode: 'cors',
    cache: 'no-store',
    signal: ctl.signal,
    // Declares the request as loopback-bound for Local Network Access, and doubles as the
    // mixed-content exemption for an https page reaching http://127.0.0.1.
    targetAddressSpace: 'loopback',
  };
  try {
    let res;
    try {
      res = await fetch(agentBase() + path, init);
    } catch (err) {
      // Browsers that do not know the enum reject the init object outright.
      if (!(err instanceof TypeError) || !('targetAddressSpace' in init)) throw err;
      delete init.targetAddressSpace;
      res = await fetch(agentBase() + path, init);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try { detail = JSON.parse(text).error || text; } catch (_) {}
      throw new Error(detail || ('agent returned ' + res.status));
    }
    const type = res.headers.get('content-type') || '';
    return type.includes('json') && text ? JSON.parse(text) : text;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ persistence */

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      port: state.port,
      recordings: state.recordings,
      flow: state.flow,
      startDelay: state.startDelay,
      flowRepeat: state.flowRepeat,
      flowForever: state.flowForever,
      onboarding: state.onboarding,
    }));
  } catch (err) {
    toast('Could not save: ' + err.message + '. Export anything you need to keep.', 'bad');
  }
}

function load() {
  let raw;
  try { raw = localStorage.getItem(STORE_KEY); } catch (_) { return; }
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (Number.isFinite(data.port)) state.port = data.port;
    if (Array.isArray(data.recordings)) state.recordings = data.recordings;
    if (Array.isArray(data.flow)) state.flow = data.flow;
    if (Number.isFinite(data.startDelay)) state.startDelay = data.startDelay;
    if (Number.isFinite(data.flowRepeat)) state.flowRepeat = data.flowRepeat;
    state.flowForever = !!data.flowForever;
    if (data.onboarding && typeof data.onboarding === 'object') {
      Object.assign(state.onboarding, data.onboarding);
    }
    // A recording referenced by a step may have been deleted in another tab.
    const ids = new Set(state.recordings.map((r) => r.id));
    state.flow = state.flow.filter((s) => ids.has(s.recordingId));
  } catch (_) {
    toast('Saved data was unreadable and has been ignored.', 'bad');
  }
}

const findRec = (id) => state.recordings.find((r) => r.id === id);

/* ------------------------------------------------------------------ health poll */

function setAgentUi() {
  const pill = $('#agent-pill');
  const label = $('#agent-label');
  const online = !!health;

  pill.classList.toggle('pill--ok', online);
  pill.classList.toggle('pill--bad', !online);

  const stale = online && olderThanWanted(health.version);
  pill.classList.toggle('pill--warn', stale);

  if (online) {
    const s = health.screen;
    label.textContent = stale
      ? 'Agent ' + health.version + ' · update to ' + AGENT_WANTS
      : 'Agent ' + health.version + ' · ' + s.w + '×' + s.h;
    pill.title = stale
      ? 'This app expects ' + AGENT_WANTS + '. Click for the command that starts the current one.'
      : 'The local agent is connected';
  } else {
    label.textContent = 'Agent offline';
    pill.title = 'Click for the command that starts it';
  }

  renderStartCommand(stale);

  const busy = online && (health.recording || health.playing);
  $('#btn-record').disabled = !online || busy;
  $('#btn-run').disabled = !online || busy || state.flow.length === 0;

  renderOnboarding();
}

async function pollHealth() {
  try {
    const data = await agentReq('/health', { timeout: 2500 });
    const wasOffline = !health;
    health = data;
    if (wasOffline && !data.hook) {
      toast('Agent is up but the mouse hook failed to install.', 'bad');
    }
    // Recover UI if the agent is mid-operation (page reload, second tab).
    if (data.recording && !recordTimer) startRecordPolling();
    if (data.playing && !replayTimer) startReplayPolling();
    healthFailures = 0;
  } catch (_) {
    health = null;
    healthFailures++;
  }
  setAgentUi();
}

// Poll briskly while someone is actively trying to connect, then back off. Each failed
// probe logs a console error the page cannot suppress, so idle tabs should stay quiet.
function scheduleHealth() {
  clearTimeout(healthTimer);
  const eager = health || healthFailures < 8 || !$('#agent-setup').hidden;
  healthTimer = setTimeout(async () => {
    await pollHealth();
    scheduleHealth();
  }, eager ? 2000 : 15000);
}

/* ------------------------------------------------------------------ recording */

/* Which applications you were in while recording, in the order you first touched them.
 *
 * A desktop recording is otherwise a list of coordinates: "Recording 3, 14 clicks" tells nobody what it
 * does, which is why these recordings never became skills worth keeping. The agent already knows which
 * window is in front, and this poll is already running - so the context comes for free, and a saved
 * skill can say "Outlook (PWA), Excel" instead of nothing.
 *
 * Sampled once a second rather than per event: an application you passed through for half a second is
 * not what the flow is about.
 */
let recordWindows = [];
let windowSampler = null;

async function sampleWindow() {
  try {
    const seen = await agentReq('/windows', { timeout: 2000 });
    const front = (seen.windows || []).find((w) => w.active);
    if (!front) return;
    const label = front.title || front.process;
    if (!label) return;
    // Kept once, in first-touched order. Alt-tabbing back and forth should not fill the list.
    if (!recordWindows.some((w) => w.title === label)) {
      recordWindows.push({ title: label, process: front.process || '' });
    }
  } catch (_) {
    // An agent too old to list windows records without the context, exactly as before.
  }
}

function startRecordPolling() {
  $('#rec-idle').hidden = true;
  $('#rec-live').hidden = false;
  clearInterval(recordTimer);
  recordWindows = [];
  clearInterval(windowSampler);
  windowSampler = setInterval(sampleWindow, 1000);
  sampleWindow();
  recordTimer = setInterval(async () => {
    try {
      const s = await agentReq('/record/status', { timeout: 2500 });
      $('#rec-count').textContent = s.count;
      $('#rec-elapsed').textContent = fmtMs(s.elapsedMs);
      if (!s.recording) stopRecordPolling();
    } catch (_) {
      stopRecordPolling();
    }
  }, 250);
}

function stopRecordPolling() {
  clearInterval(recordTimer);
  recordTimer = null;
  clearInterval(windowSampler);
  windowSampler = null;
  $('#rec-idle').hidden = false;
  $('#rec-live').hidden = true;
  $('#rec-count').textContent = '0';
  $('#rec-clicks').textContent = '0';
  $('#rec-moves').textContent = '0';
  $('#rec-elapsed').textContent = '0.0s';
}

async function beginRecording() {
  try {
    await agentReq('/record/start', { method: 'POST' });
    startRecordPolling();
  } catch (err) {
    toast('Could not start recording: ' + err.message, 'bad');
  }
}

async function endRecording() {
  try {
    const text = await agentReq('/record/stop', { method: 'POST', timeout: 15000 });
    stopRecordPolling();
    const { events } = parseMacro(text);
    if (!events.length) {
      toast('Nothing was captured.', 'bad');
      return;
    }
    /* Named after what you were working in, not after how many recordings there are. "Outlook (PWA)"
     * is a thing you can find again in a week; "Recording 3" is not. */
    const s = summarize(events);
    const where = recordWindows.map((w) => w.title);
    const shortest = where.length
      ? where[0].split(/\s+[-\u2013\u2014|]\s+/)[0].slice(0, 40)
      : '';
    const name = shortest
      ? shortest + ' \u00b7 ' + s.clicks + ' click' + (s.clicks === 1 ? '' : 's')
      : 'Recording ' + (state.recordings.length + 1);
    addRecording(name, events, where);
    toast(s.count + ' events captured (' + fmtMs(s.duration) + ')' +
      (where.length ? ' in ' + where.length + ' window' + (where.length === 1 ? '' : 's') : ''), 'good');
  } catch (err) {
    stopRecordPolling();
    toast('Could not stop recording: ' + err.message, 'bad');
  }
}

function addRecording(name, events, windows) {
  state.recordings.push({
    id: uid(), name, created: new Date().toISOString(), events,
    // Where it happened, for naming it and for saying what a skill made from it actually does.
    windows: Array.isArray(windows) ? windows : [],
  });
  save();
  renderLibrary();
  setAgentUi();
}

/* ------------------------------------------------------------------ library ui */

function renderLibrary() {
  const list = $('#library');
  list.textContent = '';
  $('#library-empty').hidden = state.recordings.length > 0;

  for (const rec of state.recordings) {
    const s = summarize(rec.events);
    const bounds = s.count
      ? ' · x ' + s.minX + '–' + s.maxX + ', y ' + s.minY + '–' + s.maxY
      : '';

    list.appendChild(h('li', { class: 'rec' }, [
      h('div', { class: 'rec-main' }, [
        h('input', {
          class: 'rec-name',
          value: rec.name,
          'aria-label': 'Recording name',
          onchange: (ev) => {
            rec.name = ev.target.value.trim() || rec.name;
            ev.target.value = rec.name;
            save();
            renderFlow();
          },
        }),
        h('div', {
          class: 'rec-meta',
          text: s.count + ' events · ' + s.clicks + ' clicks · ' + fmtMs(s.duration) + bounds,
        }),
      ]),
      h('div', { class: 'rec-tools' }, [
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Play', onclick: () => playOne(rec) }),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Add', onclick: () => addToFlow(rec.id) }),
        h('button', {
          class: 'btn btn--ghost btn--sm', type: 'button', text: 'Save as skill',
          title: 'Keep this on your account under a name, ready to run again or publish',
          onclick: () => saveAsSkill(rec),
        }),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Export', onclick: () => exportRec(rec) }),
        h('button', {
          class: 'btn btn--ghost btn--sm', type: 'button', text: 'Delete',
          onclick: () => {
            const inFlow = state.flow.filter((f) => f.recordingId === rec.id).length;
            const warn = inFlow ? ' It is used by ' + inFlow + ' flow step(s).' : '';
            if (!confirm('Delete "' + rec.name + '"?' + warn)) return;
            state.recordings = state.recordings.filter((r) => r.id !== rec.id);
            state.flow = state.flow.filter((f) => f.recordingId !== rec.id);
            save();
            renderLibrary();
            renderFlow();
          },
        }),
      ]),
    ]));
  }
}

/* A recording becomes a skill.
 *
 * The extension has always been able to do this with a browser recording; a desktop recording could only
 * be exported to a file, so the fastest way anyone has of building a library - just do the thing once -
 * stopped at the edge of this half. Now both halves feed the same list.
 *
 * Pushed straight to the account rather than kept locally: a skill that lives in one browser is a skill
 * nobody else can run, and publishing to the gallery starts from the account.
 */
async function saveAsSkill(rec) {
  const s = summarize(rec.events);
  const where = (rec.windows || []).map((w) => w.title).filter(Boolean);
  const name = prompt('Name this skill', rec.name);
  if (name === null) return;

  const described = 'Repeats ' + s.count + ' recorded actions' +
    (s.clicks ? ' (' + s.clicks + ' click' + (s.clicks === 1 ? '' : 's') + ')' : '') +
    ' over ' + fmtMs(s.duration) +
    (where.length ? ', in ' + where.slice(0, 3).join(', ') : '') + '.';

  const flow = {
    id: 'dr_' + rec.id,
    /* `desktop`, which decides who can run it: these are screen coordinates, so the extension must not
     * offer to replay them in a page - it would click at meaningless positions. */
    source: 'desktop',
    kind: 'recorded',
    name: (name || rec.name).slice(0, 80),
    description: described.slice(0, 400),
    origins: where.slice(0, 12),
    created: rec.created,
    payload: {
      version: 1,
      kind: 'recorded',
      agent: 'desktop',
      name: (name || rec.name).slice(0, 80),
      description: described.slice(0, 400),
      events: rec.events,
      windows: rec.windows || [],
      created: rec.created,
    },
  };

  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flows: [flow] }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error && body.error.message) || 'HTTP ' + res.status);
    const problems = (body && body.problems) || [];
    if (problems.length) throw new Error(problems.join('; '));
    toast('Saved as a skill. It is in Skills, on this and any other browser you sign in from.', 'good');
  } catch (err) {
    toast('Could not save it as a skill: ' + err.message, 'bad');
  }
}

/* The way back: a desktop skill, from Skills or from the gallery, into this console ready to play.
 *
 * A custom event rather than an import, because Skills is a module and this console is not - and because
 * the only thing they need to agree on is the shape of a flow. */
addEventListener('mouseflow:adopt', (event) => {
  const flow = event.detail;
  if (!flow || !flow.payload || !Array.isArray(flow.payload.events)) {
    toast('That skill has no recorded actions to play.', 'bad');
    return;
  }
  if (state.recordings.some((r) => r.id === 'from_' + flow.id)) {
    toast('That one is already here, in Recordings.', 'good');
    return;
  }
  state.recordings.push({
    id: 'from_' + flow.id,
    name: flow.name || 'From a skill',
    created: new Date().toISOString(),
    events: flow.payload.events,
    windows: flow.payload.windows || [],
  });
  save();
  renderLibrary();
  setAgentUi();
  toast('"' + (flow.name || 'It') + '" is in Recordings, ready to play.', 'good');
});

function exportRec(rec) {
  const safe = rec.name.replace(/[^\w\-. ]+/g, '_').trim() || 'recording';
  const blob = new Blob([serializeMacro(rec.events) + '\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: safe + '.mmmacro' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function importFiles(files) {
  let added = 0;
  let pending = files.length;
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = () => {
      const { events, skipped } = parseMacro(reader.result);
      if (events.length) {
        addRecording(file.name.replace(/\.(mmmacro|txt)$/i, ''), events);
        added++;
        if (skipped) toast(file.name + ': ' + skipped + ' line(s) could not be parsed.', 'bad');
      } else {
        toast(file.name + ': no valid event lines found.', 'bad');
      }
      if (--pending === 0 && added) toast('Imported ' + added + ' recording(s).', 'good');
    };
    reader.onerror = () => {
      toast('Could not read ' + file.name, 'bad');
      pending--;
    };
    reader.readAsText(file);
  }
}

/* ------------------------------------------------------------------ flow ui */

function addToFlow(recordingId) {
  state.flow.push({ id: uid(), recordingId, repeat: 1, speed: 1, delayAfter: 0 });
  save();
  renderFlow();
  setAgentUi();
}

function renderFlow() {
  const list = $('#flow');
  list.textContent = '';
  $('#flow-empty').hidden = state.flow.length > 0;

  state.flow.forEach((step, i) => {
    const rec = findRec(step.recordingId);
    if (!rec) return;
    const s = summarize(rec.events);
    const perPass = step.speed > 0 ? s.duration / step.speed : s.duration;

    list.appendChild(h('li', { class: 'step', 'data-step': String(i + 1) }, [
      h('span', { class: 'step-num', text: String(i + 1) }),
      h('div', { class: 'step-name' }, [
        rec.name,
        h('div', {
          class: 'step-sub',
          text: s.count + ' events · ' + fmtMs(Math.round(perPass)) + ' per pass',
        }),
      ]),
      h('label', { class: 'field' }, [
        h('span', { text: 'Repeat' }),
        h('input', {
          type: 'number', min: '0', step: '1', value: String(step.repeat),
          title: '0 means loop this step until you stop the flow',
          onchange: (ev) => {
            const v = parseInt(ev.target.value, 10);
            step.repeat = Number.isFinite(v) && v >= 0 ? v : 1;
            ev.target.value = String(step.repeat);
            save();
            renderFlow();
          },
        }),
      ]),
      h('label', { class: 'field' }, [
        h('span', { text: 'Speed' }),
        h('select', {
          onchange: (ev) => {
            step.speed = parseFloat(ev.target.value) || 1;
            save();
            renderFlow();
          },
        }, SPEEDS.map((sp) => h('option', {
          value: String(sp),
          text: sp + 'x',
          selected: sp === step.speed,
        }))),
      ]),
      h('label', { class: 'field' }, [
        h('span', { text: 'Then wait' }),
        h('input', {
          type: 'number', min: '0', step: '100', value: String(step.delayAfter),
          onchange: (ev) => {
            const v = parseInt(ev.target.value, 10);
            step.delayAfter = Number.isFinite(v) && v >= 0 ? v : 0;
            ev.target.value = String(step.delayAfter);
            save();
          },
        }),
      ]),
      h('div', { class: 'rec-tools' }, [
        h('button', {
          class: 'btn btn--ghost btn--sm', type: 'button', text: '↑',
          'aria-label': 'Move up', disabled: i === 0,
          onclick: () => moveStep(i, -1),
        }),
        h('button', {
          class: 'btn btn--ghost btn--sm', type: 'button', text: '↓',
          'aria-label': 'Move down', disabled: i === state.flow.length - 1,
          onclick: () => moveStep(i, 1),
        }),
        h('button', {
          class: 'btn btn--ghost btn--sm', type: 'button', text: '✕',
          'aria-label': 'Remove step',
          onclick: () => {
            state.flow.splice(i, 1);
            save();
            renderFlow();
            setAgentUi();
          },
        }),
      ]),
    ]));
  });
}

function moveStep(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.flow.length) return;
  const [item] = state.flow.splice(index, 1);
  state.flow.splice(target, 0, item);
  save();
  renderFlow();
}

/* ------------------------------------------------------------------ replay */

function buildFlowBody(steps, { startDelay, flowRepeat }) {
  const lines = [
    '# MouseFlow',
    'startDelay=' + startDelay,
    'flowRepeat=' + (flowRepeat <= 0 ? 'forever' : flowRepeat),
  ];
  for (const step of steps) {
    const rec = findRec(step.recordingId);
    if (!rec || !rec.events.length) continue;
    lines.push(
      'STEP repeat=' + (step.repeat <= 0 ? 'forever' : step.repeat) +
      ' speed=' + step.speed +
      ' delayAfter=' + step.delayAfter
    );
    lines.push(serializeMacro(rec.events));
  }
  return lines.join('\n') + '\n';
}

async function startReplay(steps, opts) {
  const body = buildFlowBody(steps, opts);
  try {
    await agentReq('/replay', { method: 'POST', body });
    startReplayPolling();
  } catch (err) {
    toast('Could not start replay: ' + err.message, 'bad');
  }
}

function playOne(rec) {
  startReplay(
    [{ recordingId: rec.id, repeat: 1, speed: 1, delayAfter: 0 }],
    { startDelay: state.startDelay, flowRepeat: 1 }
  );
}

function runFlow() {
  if (!state.flow.length) return;
  startReplay(state.flow, {
    startDelay: state.startDelay,
    flowRepeat: state.flowForever ? 0 : state.flowRepeat,
  });
}

function startReplayPolling() {
  $('#replay-panel').hidden = false;
  $('#replay-title').textContent = 'Starting in ' + fmtMs(state.startDelay) + ' – switch to your target window';
  $('#replay-bar').style.width = '0%';
  clearInterval(replayTimer);
  replayTimer = setInterval(async () => {
    try {
      const s = await agentReq('/replay/status', { timeout: 2500 });
      if (!s.playing) { finishReplay(); return; }
      paintReplay(s);
    } catch (_) {
      finishReplay();
    }
  }, 200);
}

function paintReplay(s) {
  const step = state.flow[s.step - 1];
  const rec = step ? findRec(step.recordingId) : null;
  const parts = [];

  if (s.step > 0) parts.push('Step ' + s.step + '/' + s.steps);
  if (rec) parts.push(rec.name);
  if (s.passes === 0 && s.pass > 0) parts.push('pass ' + s.pass + ' of ∞');
  else if (s.passes > 1) parts.push('pass ' + s.pass + '/' + s.passes);
  if (s.flowPasses === 0 && s.flowPass > 0) parts.push('loop ' + s.flowPass);
  else if (s.flowPasses > 1) parts.push('loop ' + s.flowPass + '/' + s.flowPasses);
  if (s.total > 0) parts.push(s.index + '/' + s.total + ' events');

  $('#replay-title').textContent = parts.length ? parts.join(' · ') : 'Running';
  $('#replay-bar').style.width = (s.total ? (s.index / s.total) * 100 : 0).toFixed(1) + '%';

  document.querySelectorAll('.step').forEach((node) => {
    node.classList.toggle('step--active', node.dataset.step === String(s.step));
  });
}

function finishReplay() {
  const wasRunning = replayTimer !== null;
  clearInterval(replayTimer);
  replayTimer = null;
  $('#replay-panel').hidden = true;
  document.querySelectorAll('.step--active').forEach((n) => n.classList.remove('step--active'));

  if (wasRunning && !state.onboarding.ranOnce) {
    state.onboarding.ranOnce = true;
    save();
    renderOnboarding();
  }
}

async function abortReplay() {
  try { await agentReq('/replay/abort', { method: 'POST' }); } catch (_) {}
  finishReplay();
}

/* ------------------------------------------------------------------ wiring */

function wire() {
  $('#btn-record').addEventListener('click', beginRecording);
  $('#btn-stop-record').addEventListener('click', endRecording);
  $('#btn-run').addEventListener('click', runFlow);
  $('#btn-abort').addEventListener('click', abortReplay);

  $('#agent-pill').addEventListener('click', () => {
    setupOverride = $('#agent-setup').hidden;
    renderOnboarding();
  });

  $('#agent-port').addEventListener('change', (ev) => {
    const v = parseInt(ev.target.value, 10);
    if (!Number.isFinite(v) || v < 1 || v > 65535) {
      ev.target.value = String(state.port);
      return;
    }
    state.port = v;
    save();
    health = null;
    setAgentUi();
    pollHealth();
  });

  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', (ev) => {
    if (ev.target.files.length) importFiles([...ev.target.files]);
    ev.target.value = '';
  });

  $('#btn-clear-flow').addEventListener('click', () => {
    if (!state.flow.length) return;
    if (!confirm('Remove all ' + state.flow.length + ' step(s) from the flow?')) return;
    state.flow = [];
    save();
    renderFlow();
    setAgentUi();
  });

  $('#start-delay').addEventListener('change', (ev) => {
    const v = parseInt(ev.target.value, 10);
    state.startDelay = Number.isFinite(v) && v >= 0 ? v : 3000;
    ev.target.value = String(state.startDelay);
    save();
  });

  $('#flow-repeat').addEventListener('change', (ev) => {
    const v = parseInt(ev.target.value, 10);
    state.flowRepeat = Number.isFinite(v) && v >= 1 ? v : 1;
    ev.target.value = String(state.flowRepeat);
    save();
  });

  $('#flow-forever').addEventListener('change', (ev) => {
    state.flowForever = ev.target.checked;
    $('#flow-repeat').disabled = state.flowForever;
    save();
  });

  // Drag and drop import
  const zone = $('#dropzone');
  let depth = 0;
  window.addEventListener('dragenter', (ev) => {
    if (![...ev.dataTransfer.types].includes('Files')) return;
    depth++;
    zone.classList.add('on');
  });
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) { depth = 0; zone.classList.remove('on'); }
  });
  window.addEventListener('drop', (ev) => {
    ev.preventDefault();
    depth = 0;
    zone.classList.remove('on');
    const files = [...(ev.dataTransfer.files || [])];
    if (files.length) importFiles(files);
  });

  // Esc is handled natively by the agent, but mirror it when the page has focus.
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && replayTimer) abortReplay();
  });
}

/* ------------------------------------------------------------- onboarding */

// Fetches the agent straight into a PowerShell scriptblock, so nothing has to be
// downloaded, unblocked, or exempted from the execution policy first.
function oneLineCommand() {
  return '& ([scriptblock]::Create((irm ' + location.origin + '/agent/mouseflow-agent.ps1)))' +
    (state.port !== 8787 ? ' -Port ' + state.port : '') +
    ' -AllowOrigin ' + location.origin;
}

/* Runs the downloaded copy WITHOUT `-File`.
 *
 * `-File` is what you would expect to use, and it fails on any machine whose execution
 * policy comes from Group Policy: the MachinePolicy/UserPolicy scopes outrank the
 * `-ExecutionPolicy Bypass` argument, so an AllSigned estate refuses an unsigned .ps1
 * outright. Handing the script text to a scriptblock never loads a file, so the policy
 * never engages - and unlike the piped one-liner, the code being run is the local copy
 * the user can read first.
 */
function localFileCommand() {
  return '& ([scriptblock]::Create((Get-Content "$env:USERPROFILE\\Downloads\\mouseflow-agent.ps1" -Raw)))' +
    (state.port !== 8787 ? ' -Port ' + state.port : '') +
    ' -AllowOrigin ' + location.origin;
}

function startCommand() {
  return state.onboarding.usedDownload ? localFileCommand() : oneLineCommand();
}

/* The start command, permanently reachable.
 *
 * It used to live in onboarding step one and vanish the moment the agent connected - so the moment it
 * was needed AGAIN, to restart an agent that had fallen behind, there was nowhere to get it. Now it sits
 * in the Desktop console whatever the state, and says which of the two things it is for. */
function renderStartCommand(stale) {
  const box = $('#start-command');
  if (!box) return;
  box.textContent = '';

  const online = !!health;
  box.classList.toggle('start--stale', !!stale);

  const heading = stale
    ? 'Update the agent to ' + AGENT_WANTS
    : (online ? 'Start command' : 'Start the agent');
  const why = stale
    ? 'Version ' + health.version + ' is running. Close that PowerShell window, then paste this into a ' +
      'new one - it fetches the current agent and starts it.'
    : (online
      ? 'Paste this into PowerShell after a restart, or on another computer. Nothing is installed: it ' +
        'fetches the agent and runs it in one go.'
      : 'Paste this into PowerShell and press Enter. Leave the window open - closing it stops the agent.');

  box.append(
    h('div', { class: 'start-head' }, [
      h('strong', { text: heading }),
      h('span', { class: 'start-why', text: why }),
    ]),
    h('div', { class: 'code-row' }, [
      h('code', { text: startCommand() }),
      h('button', {
        class: 'btn btn--sm ' + (stale || !online ? 'btn--primary' : 'btn--ghost'),
        type: 'button', text: 'Copy',
        onclick: () => copyText(startCommand(), 'Copied — paste it into PowerShell.'),
      }),
    ]),
  );
}

function copyText(text, okMessage) {
  return navigator.clipboard.writeText(text).then(
    () => toast(okMessage || 'Copied.', 'good'),
    () => toast('Could not copy — select the command and copy it manually.', 'bad')
  );
}

function downloadAgent() {
  const a = h('a', { href: 'agent/mouseflow-agent.ps1', download: 'mouseflow-agent.ps1' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  state.onboarding.copied = true;
  state.onboarding.usedDownload = true;
  save();
  renderOnboarding();
  toast('Downloaded. The command below now runs your local copy.', 'good');
}

async function enableAutostart() {
  try {
    await agentReq('/autostart/enable', { method: 'POST' });
    await pollHealth();
    toast('The agent will start automatically when you log in.', 'good');
  } catch (err) {
    toast(err.message, 'bad');
  }
  renderOnboarding();
}

function onboardingSteps() {
  const online = !!health;
  const newest = state.recordings[state.recordings.length - 1];
  const ob = state.onboarding;

  return [
    {
      title: 'Copy the start command',
      done: ob.copied,
      note: 'One line. It downloads the agent and starts it in one go — nothing to install, ' +
            'nothing to unblock.',
      build: () => [
        h('div', { class: 'code-row' }, [
          h('code', { text: startCommand() }),
          h('button', {
            class: 'btn btn--primary btn--sm', type: 'button', text: 'Copy command',
            onclick: () => copyText(startCommand(), 'Copied — paste it into PowerShell.').then(() => {
              state.onboarding.copied = true;
              save();
              renderOnboarding();
            }),
          }),
        ]),
        h('div', { class: 'ob-actions' }, [
          h('button', {
            class: 'link-btn link-btn--quiet', type: 'button',
            text: 'or download the file instead',
            onclick: downloadAgent,
          }),
        ]),
      ],
    },
    {
      title: 'Paste it into PowerShell and press Enter',
      done: online,
      note: lnaGranted
        ? 'Press Win+X then I to open a PowerShell window. Leave it open afterwards — ' +
          'closing it stops the agent.'
        : 'Press Win+X then I to open a PowerShell window, paste, and press Enter. Then press ' +
          'Connect below — your browser will ask whether this site may reach devices on your ' +
          'local network, which is how it talks to the agent. Choose Allow.',
      build: () => {
        const actions = [];

        if (lnaGranted) {
          actions.push(h('div', { class: 'ob-waiting' }, [
            h('span', { class: 'ob-spinner' }),
            'Watching 127.0.0.1:' + state.port + ' for the agent…',
          ]));
        }

        const buttons = [];
        if (!lnaGranted) {
          buttons.push(h('button', {
            class: 'btn btn--primary btn--sm', type: 'button', text: 'Connect to agent',
            onclick: connectToAgent,
          }));
        }
        buttons.push(h('button', {
          class: 'btn btn--ghost btn--sm', type: 'button', text: 'Copy command again',
          onclick: () => copyText(startCommand()),
        }));
        actions.push(h('div', { class: 'ob-actions' }, buttons));

        if (!lnaGranted) {
          actions.push(h('p', { class: 'ob-note' },
            'Clicked Block by mistake? Reset it under Settings → Privacy and security → ' +
            'Site settings → Local network access, then press Connect again.'));
        }

        actions.push(h('p', { class: 'ob-note' },
          '"…is not digitally signed" means your execution policy comes from Group Policy, ' +
          'which outranks -ExecutionPolicy Bypass. Use the command above as-is — it hands the ' +
          'script to a scriptblock instead of loading a file, so the policy never applies.'));

        return actions;
      },
      doneNote: online && health.screen
        ? 'Agent ' + health.version + ' connected · ' + health.screen.w + '×' + health.screen.h
        : null,
    },
    {
      title: 'Keep it running after you log in',
      done: (online && health.autostart) || state.onboarding.autostartSkipped,
      note: online && health.canAutostart
        ? 'Adds MouseFlowAgent.cmd to your Startup folder so you never have to do steps 1 and 2 ' +
          'again. Deleting that file undoes it.'
        : 'Only available when the agent was started from a downloaded file with a pinned ' +
          'origin — a piped start leaves nothing for the launcher to point at.',
      build: () => {
        const actions = [];
        if (online && health.canAutostart) {
          actions.push(h('button', {
            class: 'btn btn--primary btn--sm', type: 'button', text: 'Enable autostart',
            onclick: enableAutostart,
          }));
        } else if (online) {
          actions.push(h('button', {
            class: 'btn btn--ghost btn--sm', type: 'button', text: 'Download the file instead',
            onclick: downloadAgent,
          }));
        }
        actions.push(h('button', {
          class: 'link-btn link-btn--quiet', type: 'button', text: 'skip this',
          onclick: () => {
            state.onboarding.autostartSkipped = true;
            save();
            renderOnboarding();
          },
        }));
        return [h('div', { class: 'ob-actions' }, actions)];
      },
      doneNote: online && health.autostart
        ? 'On — delete MouseFlowAgent.cmd from your Startup folder to undo'
        : 'Skipped — you will start the agent by hand each time',
    },
    {
      title: 'Record something',
      done: state.recordings.length > 0,
      note: 'Click Start, do a few clicks in any application, then press Stop. Everything you ' +
            'click, drag and scroll is captured.',
      build: () => [
        h('div', { class: 'ob-actions' }, [
          h('button', {
            class: 'btn btn--primary btn--sm', type: 'button',
            text: health && health.recording ? 'Recording…' : 'Start recording',
            disabled: !online || health.recording || health.playing,
            onclick: beginRecording,
          }),
          h('button', {
            class: 'link-btn link-btn--quiet', type: 'button', text: 'or import a .mmmacro file',
            onclick: () => $('#file-import').click(),
          }),
        ]),
      ],
      doneNote: state.recordings.length + ' recording(s) saved',
    },
    {
      title: 'Add it to the flow',
      done: state.flow.length > 0,
      note: 'A flow is an ordered list of recordings. Each step gets its own repeat count, ' +
            'speed and trailing pause, so several recordings can run back to back.',
      build: () => [
        h('div', { class: 'ob-actions' }, [
          h('button', {
            class: 'btn btn--primary btn--sm', type: 'button',
            text: newest ? 'Add "' + newest.name + '" to the flow' : 'Add to flow',
            disabled: !newest,
            onclick: () => newest && addToFlow(newest.id),
          }),
        ]),
      ],
      doneNote: state.flow.length + ' step(s) in the flow',
    },
    {
      title: 'Run it',
      done: state.onboarding.ranOnce,
      note: 'You get ' + fmtMs(state.startDelay) + ' to switch to the target window before it ' +
            'starts. Hold Esc at any point to abort. Tick "Restart forever when it ends" below ' +
            'to keep the whole sequence looping.',
      build: () => [
        h('div', { class: 'ob-actions' }, [
          h('button', {
            class: 'btn btn--primary btn--sm', type: 'button', text: 'Run flow',
            disabled: !online || state.flow.length === 0 || health.recording || health.playing,
            onclick: runFlow,
          }),
        ]),
      ],
    },
  ];
}

function renderOnboarding() {
  const steps = onboardingSteps();
  const doneCount = steps.filter((s) => s.done).length;
  const activeIndex = steps.findIndex((s) => !s.done);
  const complete = activeIndex === -1;

  const panel = $('#agent-setup');
  panel.hidden = setupOverride === null ? complete : !setupOverride;
  $('#agent-pill').setAttribute('aria-expanded', String(!panel.hidden));

  $('#setup-progress').textContent = doneCount + ' / ' + steps.length;
  $('#setup-title').textContent = complete ? 'Setup complete' : 'Set up MouseFlow';
  $('#setup-lede').textContent = complete
    ? 'Everything is connected. Reopen this any time from the status pill.'
    : 'Six steps, mostly buttons. A browser tab cannot see mouse events outside its own window ' +
      'or inject real clicks, so one small helper runs on your machine — it talks to this page ' +
      'over loopback only.';

  const list = $('#onboarding');
  list.textContent = '';

  steps.forEach((step, i) => {
    const cls = step.done ? 'is-done' : i === activeIndex ? 'is-active' : 'is-todo';
    const body = [h('h3', { class: 'ob-title', text: step.title })];

    if (step.done && step.doneNote) {
      body.push(h('div', { class: 'ob-done-note', text: step.doneNote }));
    }
    if (!step.done) {
      body.push(h('p', { class: 'ob-note', text: step.note }));
      if (i === activeIndex) body.push(...step.build());
    }

    list.appendChild(h('li', { class: 'ob-step ' + cls }, [
      h('span', { class: 'ob-marker', text: step.done ? '✓' : String(i + 1) }),
      h('div', { class: 'ob-body' }, body),
    ]));
  });
}

function init() {
  load();
  $('#agent-port').value = String(state.port);
  $('#start-delay').value = String(state.startDelay);
  $('#flow-repeat').value = String(state.flowRepeat);
  $('#flow-forever').checked = state.flowForever;
  $('#flow-repeat').disabled = state.flowForever;

  wire();
  renderLibrary();
  renderFlow();
  setAgentUi();

  // Only probe loopback unprompted when doing so cannot raise a permission dialog.
  // Otherwise wait for the Connect click in step 2.
  refreshLnaState().then((granted) => {
    if (granted) pollHealth().then(scheduleHealth);
    else renderOnboarding();
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
