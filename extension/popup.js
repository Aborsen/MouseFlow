/* Popup: pick a mode, then drive it.
 *
 *   Record the flow — capture the exact sequence, repeat it in the tabs already open.
 *   Create the flow — describe the goal, let the agent work it out per step.
 *
 * The worker owns all state (recording buffer, replay progress, agent run) so closing
 * this window never interrupts anything; the popup only polls and renders.
 */

'use strict';

const APP_URL = 'https://mouse-agent.vercel.app';
const $ = (id) => document.getElementById(id);

let recPoll = null;
let playPoll = null;
let agentPoll = null;

const fmt = (ms) => (ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's');
const ask = (mf, extra) => chrome.runtime.sendMessage(Object.assign({ mf }, extra));
const getPending = async () => (await chrome.storage.local.get('pending')).pending || [];

/* ------------------------------------------------------------------ navigation */

function show(which) {
  for (const id of ['home', 'record', 'create']) $(id).hidden = id !== which;
  if (which !== 'record') { clearInterval(playPoll); playPoll = null; }
  if (which !== 'create') { clearInterval(agentPoll); agentPoll = null; }
  chrome.storage.session.set({ popupView: which }).catch(() => {});
}

$('go-record').addEventListener('click', () => { show('record'); refreshRecordView(); });
$('go-create').addEventListener('click', () => { show('create'); refreshAgent(); });
document.querySelectorAll('[data-home]').forEach((b) => b.addEventListener('click', () => show('home')));

/* -------------------------------------------------------------- mode A: record */

function setRecording(on) {
  $('live').hidden = !on;
  $('btn-record').hidden = on;
  $('btn-stop').hidden = !on;
  clearInterval(recPoll);
  recPoll = on ? setInterval(refreshRecording, 400) : null;
}

async function refreshRecording() {
  const s = await ask('record/status');
  $('count').textContent = s.count + (s.tabs > 1 ? ' · ' + s.tabs + ' tabs' : '');
  $('elapsed').textContent = fmt(s.elapsedMs);
  if (!s.recording) { setRecording(false); showSaved(); }
}

$('btn-record').addEventListener('click', async () => {
  $('rec-note').textContent = '';
  const res = await ask('record/start');
  if (!res.ok) { $('rec-note').textContent = res.error; return; }
  setRecording(true);
  refreshRecording();
});

$('btn-stop').addEventListener('click', async () => {
  const res = await ask('record/stop');
  setRecording(false);
  if (!res.ok) { $('rec-note').textContent = res.error; return; }
  $('rec-note').textContent = res.saved
    ? res.saved.events.length + ' events saved.'
    : 'Nothing was captured.';
  showSaved();
});

async function showSaved() {
  const pending = await getPending();
  const last = pending[pending.length - 1];
  $('saved').hidden = !last;
  if (!last) return;
  const tabs = last.tabs || 1;
  $('saved-name').textContent = last.name + (tabs > 1 ? ' · ' + tabs + ' tabs' : '');
  $('saved-count').textContent = last.events.length + ' events';
  $('saved-name').title = (last.origins || []).join('\n') || 'origin unknown';
}

function setPlaying(on) {
  $('btn-replay').hidden = on;
  $('btn-abort').hidden = !on;
  clearInterval(playPoll);
  playPoll = on ? setInterval(refreshReplay, 300) : null;
}

async function refreshReplay() {
  const s = await ask('replay/status');
  if (s.playing) { $('rec-note').textContent = 'Repeating ' + s.index + '/' + s.total; return; }
  setPlaying(false);

  if (s.error) { $('rec-note').textContent = 'Stopped: ' + s.error; return; }
  if (!s.performed) {
    const { lastRun } = await chrome.storage.session.get('lastRun');
    $('rec-note').textContent = lastRun && lastRun.error
      ? 'Stopped: ' + lastRun.error
      : 'Nothing was performed. Reload the extension and try once more.';
    return;
  }
  $('rec-note').textContent = 'Repeated ' + s.performed + ' event(s)' +
    (s.failed ? ', ' + s.failed + ' failed' : ' cleanly') + '.';
}

$('btn-replay').addEventListener('click', async () => {
  const pending = await getPending();
  const last = pending[pending.length - 1];
  if (!last) return;

  $('rec-note').textContent = 'Starting…';
  const res = await ask('replay', {
    flow: {
      startDelay: 400,
      flowRepeat: 1,
      steps: [{ events: last.events, repeat: 1, speed: 1, delayAfter: 0 }],
    },
  });
  if (!res.ok) { $('rec-note').textContent = res.error; return; }
  setPlaying(true);
  refreshReplay();
});

$('btn-abort').addEventListener('click', async () => {
  await ask('replay/abort');
  setPlaying(false);
  $('rec-note').textContent = 'Aborted.';
});

$('copy-log').addEventListener('click', async (ev) => {
  ev.preventDefault();
  const pending = await getPending();
  const { lastRun } = await chrome.storage.session.get('lastRun');
  const report = {
    recording: pending[pending.length - 1] || null,
    lastRun: lastRun || null,
    status: await ask('replay/status'),
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    $('rec-note').textContent = 'Log copied — paste it into the chat.';
  } catch (_) {
    console.log('[MouseFlow] report', report);
    $('rec-note').textContent = 'Clipboard blocked; the log is in this popup’s console.';
  }
});

$('clear-saved').addEventListener('click', async (ev) => {
  ev.preventDefault();
  await chrome.storage.local.remove('pending');
  $('saved').hidden = true;
  $('rec-note').textContent = 'Saved recordings cleared.';
});

async function refreshRecordView() {
  const s = await ask('ping');
  setRecording(!!s.recording);
  setPlaying(!!s.playing);
  if (s.recording) refreshRecording();
  if (s.playing) refreshReplay();
  await showSaved();
}

/* -------------------------------------------------------------- mode B: create */

function renderFeed(log) {
  const feed = $('feed');
  feed.hidden = !log.length;
  feed.textContent = '';
  for (const event of log) {
    const line = document.createElement('div');
    if (event.type === 'act') {
      line.className = 'act';
      const detail = event.input && (event.input.url || event.input.text ||
        (event.input.ref != null ? 'ref ' + event.input.ref : ''));
      line.textContent = '· ' + event.name + (detail ? ' ' + String(detail).slice(0, 44) : '');
    } else {
      line.textContent = event.text;
    }
    feed.appendChild(line);
  }
  feed.scrollTop = feed.scrollHeight;
}

function setAgentRunning(on) {
  $('btn-run-goal').hidden = on;
  $('btn-stop-goal').hidden = !on;
  $('goal').disabled = on;
  clearInterval(agentPoll);
  agentPoll = on ? setInterval(refreshAgent, 700) : null;
}

async function refreshAgent() {
  const s = await ask('agent/status');
  renderFeed(s.log || []);

  if (s.running) {
    setAgentRunning(true);
    $('ai-note').textContent = 'Working…';
    return;
  }
  setAgentRunning(false);

  const result = s.result || (await chrome.storage.session.get('lastAgentRun')).lastAgentRun?.result;
  if (!result) { $('ai-note').textContent = ''; return; }

  if (!result.ok) {
    $('ai-note').textContent = result.error === 'stopped' ? 'Stopped.' : result.error;
    return;
  }
  $('ai-note').textContent = (result.needsUser ? 'Ready for you: ' : '') + result.summary +
    (result.steps && result.steps.length ? '\n(' + result.steps.length + ' actions taken)' : '');
}

$('btn-run-goal').addEventListener('click', async () => {
  $('ai-note').textContent = '';
  const res = await ask('agent/start', { goal: $('goal').value });
  if (!res.ok) {
    $('ai-note').textContent = res.error;
    if (/API key/i.test(res.error)) $('key-box').open = true;
    return;
  }
  setAgentRunning(true);
  refreshAgent();
});

$('btn-stop-goal').addEventListener('click', async () => {
  await ask('agent/abort');
  $('ai-note').textContent = 'Stopping after the current step…';
});

$('btn-save-key').addEventListener('click', async () => {
  const key = $('api-key').value.trim();
  if (!key) return;
  await chrome.storage.local.set({ apiKey: key });
  $('api-key').value = '';
  $('key-box').open = false;
  $('ai-note').textContent = 'Key saved.';
});

/* ----------------------------------------------------------------------- init */

(async () => {
  $('open-app').href = APP_URL;
  chrome.action.setBadgeText({ text: '' }).catch(() => {});

  const [{ apiKey }, session, ping] = await Promise.all([
    chrome.storage.local.get('apiKey'),
    chrome.storage.session.get('popupView'),
    ask('ping'),
  ]);
  $('api-key').placeholder = apiKey ? 'sk-ant-… (saved — paste to replace)' : 'sk-ant-...';

  // Land on whatever is actually happening; otherwise on the last mode used.
  if (ping.recording || ping.playing) { show('record'); refreshRecordView(); }
  else if (ping.agentRunning) { show('create'); refreshAgent(); }
  else if (session.popupView === 'record') { show('record'); refreshRecordView(); }
  else if (session.popupView === 'create') { show('create'); refreshAgent(); }
  else show('home');
})();
