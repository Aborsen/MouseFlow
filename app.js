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
};

let health = null;         // last /health payload, or null when offline
let recordTimer = null;
let replayTimer = null;
let healthTimer = null;

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

/* ------------------------------------------------------------ agent transport */

function agentBase() {
  return 'http://127.0.0.1:' + state.port;
}

async function agentReq(path, { method = 'GET', body = null, timeout = 4000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(agentBase() + path, {
      method,
      body,
      headers: body == null ? undefined : { 'Content-Type': 'text/plain' },
      mode: 'cors',
      cache: 'no-store',
      signal: ctl.signal,
    });
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

  if (online) {
    const s = health.screen;
    label.textContent = 'Agent ' + health.version + ' · ' + s.w + '×' + s.h;
  } else {
    label.textContent = 'Agent offline';
  }

  const busy = online && (health.recording || health.playing);
  $('#btn-record').disabled = !online || busy;
  $('#btn-run').disabled = !online || busy || state.flow.length === 0;
}

async function pollHealth() {
  try {
    const data = await agentReq('/health', { timeout: 2500 });
    const wasOffline = !health;
    health = data;
    if (wasOffline) {
      $('#agent-setup').hidden = true;
      $('#agent-pill').setAttribute('aria-expanded', 'false');
      if (!data.hook) toast('Agent is up but the mouse hook failed to install.', 'bad');
    }
    // Recover UI if the agent is mid-operation (page reload, second tab).
    if (data.recording && !recordTimer) startRecordPolling();
    if (data.playing && !replayTimer) startReplayPolling();
  } catch (_) {
    health = null;
  }
  setAgentUi();
}

/* ------------------------------------------------------------------ recording */

function startRecordPolling() {
  $('#rec-idle').hidden = true;
  $('#rec-live').hidden = false;
  clearInterval(recordTimer);
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
    addRecording('Recording ' + (state.recordings.length + 1), events);
    const s = summarize(events);
    toast(s.count + ' events captured (' + fmtMs(s.duration) + ')', 'good');
  } catch (err) {
    stopRecordPolling();
    toast('Could not stop recording: ' + err.message, 'bad');
  }
}

function addRecording(name, events) {
  state.recordings.push({ id: uid(), name, created: new Date().toISOString(), events });
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
  clearInterval(replayTimer);
  replayTimer = null;
  $('#replay-panel').hidden = true;
  document.querySelectorAll('.step--active').forEach((n) => n.classList.remove('step--active'));
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
    const panel = $('#agent-setup');
    panel.hidden = !panel.hidden;
    $('#agent-pill').setAttribute('aria-expanded', String(!panel.hidden));
  });

  $('#agent-port').addEventListener('change', (ev) => {
    const v = parseInt(ev.target.value, 10);
    if (!Number.isFinite(v) || v < 1 || v > 65535) {
      ev.target.value = String(state.port);
      return;
    }
    state.port = v;
    save();
    updateSetupCmd();
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

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-copy]');
    if (!btn) return;
    const text = $(btn.dataset.copy).textContent;
    navigator.clipboard.writeText(text).then(
      () => toast('Copied.', 'good'),
      () => toast('Could not copy - select the text instead.', 'bad')
    );
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

function updateSetupCmd() {
  const origin = location.protocol === 'https:' ? location.origin : null;
  $('#agent-cmd').textContent =
    'powershell -ExecutionPolicy Bypass -File .\\mouseflow-agent.ps1' +
    (state.port !== 8787 ? ' -Port ' + state.port : '') +
    (origin ? ' -AllowOrigin ' + origin : '');
}

function init() {
  load();
  $('#agent-port').value = String(state.port);
  $('#start-delay').value = String(state.startDelay);
  $('#flow-repeat').value = String(state.flowRepeat);
  $('#flow-forever').checked = state.flowForever;
  $('#flow-repeat').disabled = state.flowForever;

  updateSetupCmd();
  wire();
  renderLibrary();
  renderFlow();
  setAgentUi();

  pollHealth();
  healthTimer = setInterval(pollHealth, 2000);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
