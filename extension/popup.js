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

// A stop is a request, not an event: the run ends between steps. These keep the UI honest about
// the difference between "asked to stop" and "stopped".
let playStopping = false;
let agentStopping = false;

const fmt = (ms) => (ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's');

/* What a recording contains, in the user's terms. Recording is mouse-only now, so this
 * counts clicks, motion, scrolls and page changes; `fill`/`key` appear only in older
 * recordings and imported .mmmacro files, which replay still honours.
 *
 * Motion is reported as seconds of movement, not as a sample count: the number of samples
 * is an implementation detail, while "4.2s of movement" is the thing the user will watch. */
function summarize(events) {
  const n = { click: 0, scroll: 0, page: 0, legacy: 0 };
  let moveMs = 0;
  for (const e of events || []) {
    if (e.action === 'click' || e.action === 'dblclick') n.click++;
    else if (e.action === 'path') {
      moveMs += (e.points || []).reduce((sum, p) => sum + Math.max(0, p.dt || 0), 0);
    } else if (e.action === 'scroll') n.scroll++;
    else if (e.action === 'focus' || e.action === 'navigate') n.page++;
    else n.legacy++;
  }
  const parts = [];
  parts.push(n.click + ' click' + (n.click === 1 ? '' : 's'));
  if (moveMs >= 100) parts.push((moveMs / 1000).toFixed(1) + 's of movement');
  if (n.scroll) parts.push(n.scroll + ' scroll' + (n.scroll === 1 ? '' : 's'));
  if (n.page) parts.push(n.page + ' page change' + (n.page === 1 ? '' : 's'));
  if (n.legacy) parts.push(n.legacy + ' text/key step' + (n.legacy === 1 ? '' : 's'));
  return parts.join(' · ');
}

const savePending = (list) => chrome.storage.local.set({ pending: list });
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

/* ------------------------------------------------------------------- settings */

/* Applies to both modes, so it lives on the mode picker rather than inside one of them.
 * The worker holds the defaults; this only reflects and edits them. */
const OPTS = { pointer: 'opt-pointer', trail: 'opt-trail' };

async function refreshSettings() {
  const res = await ask('settings/get');
  if (!res || !res.ok) return;
  for (const [key, id] of Object.entries(OPTS)) $(id).checked = !!res.settings[key];
}

for (const [key, id] of Object.entries(OPTS)) {
  $(id).addEventListener('change', async () => {
    const res = await ask('settings/set', { settings: { [key]: $(id).checked } });
    if (!res || !res.ok) { $('settings-note').textContent = 'Could not save that.'; return; }
    // Nothing to restart: settings are read when a run starts, so this takes effect on the
    // next Repeat rather than mid-flow.
    $('settings-note').textContent = 'Saved. Applies to the next run.';
    setTimeout(() => { $('settings-note').textContent = ''; }, 2200);
  });
}

/* -------------------------------------------------------------- mode A: record */

function setRecording(on) {
  $('live').hidden = !on;
  $('btn-record').hidden = on;
  $('btn-stop').hidden = !on;
  $('list').hidden = on;
  clearInterval(recPoll);
  recPoll = on ? setInterval(refreshRecording, 400) : null;
}

async function refreshRecording() {
  const s = await ask('record/status');
  $('count').textContent = s.count + (s.tabs > 1 ? ' · ' + s.tabs + ' tabs' : '');
  // Motion is shown as a live sample count so it is visibly being picked up - the path is
  // the part with no other outward sign that it is being recorded.
  $('motion').textContent = s.motion ? s.motion.toLocaleString() : '0';
  $('elapsed').textContent = fmt(s.elapsedMs);
  if (!s.recording) { setRecording(false); renderList(); }
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
    ? 'Saved: ' + summarize(res.saved.events)
    : 'Nothing was captured.';
  renderList();
});

/* Every recording, each renameable, repeatable and deletable in place. Showing only the
 * newest made anything captured before it unreachable from the extension. */
async function renderList() {
  const pending = await getPending();
  const list = $('list');
  list.textContent = '';
  $('list-empty').hidden = pending.length > 0;

  pending.forEach((rec, i) => {
    const item = document.createElement('li');
    item.className = 'item';

    const name = document.createElement('input');
    name.className = 'item-name';
    name.value = rec.name;
    name.setAttribute('aria-label', 'Recording name');
    name.addEventListener('change', async () => {
      const next = name.value.trim();
      if (!next) { name.value = rec.name; return; }
      const all = await getPending();
      if (all[i]) { all[i].name = next; await savePending(all); }
      rec.name = next;
    });

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    const tabs = rec.tabs || 1;
    meta.textContent = summarize(rec.events) + (tabs > 1 ? ' · ' + tabs + ' tabs' : '');
    meta.title = (rec.origins || []).join('\n') || '';

    const tools = document.createElement('div');
    tools.className = 'item-tools';

    const repeat = document.createElement('button');
    repeat.textContent = 'Repeat';
    repeat.title = 'Run through once';
    repeat.addEventListener('click', () => replay(rec, false));

    const loop = document.createElement('button');
    loop.textContent = 'Loop ∞';
    loop.title = 'Restart automatically until you stop it — click the toolbar icon to stop';
    loop.addEventListener('click', () => replay(rec, true));

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Delete this recording';
    del.addEventListener('click', async () => {
      const all = await getPending();
      all.splice(i, 1);
      await savePending(all);
      $('rec-note').textContent = 'Deleted “' + rec.name + '”.';
      renderList();
    });

    tools.append(repeat, loop, del);
    item.append(name, meta, tools);
    list.appendChild(item);
  });
}

function setPlaying(on) {
  $('list').hidden = on;
  $('btn-record').hidden = on;
  $('btn-abort').hidden = !on;
  clearInterval(playPoll);
  playPoll = on ? setInterval(refreshReplay, 300) : null;
}

async function replay(rec, forever) {
  $('rec-note').textContent = forever ? 'Looping — click the toolbar icon to stop.' : 'Starting…';
  const res = await ask('replay', {
    flow: {
      startDelay: 400,
      // 0 means "until stopped" to the worker.
      flowRepeat: forever ? 0 : 1,
      // A breather between passes, so a loop is watchable and does not hammer the page.
      steps: [{ events: rec.events, repeat: 1, speed: 1, delayAfter: forever ? 1000 : 0 }],
    },
  });
  if (!res.ok) { $('rec-note').textContent = res.error; return; }
  setPlaying(true);
  refreshReplay();
}

async function refreshReplay() {
  const s = await ask('replay/status');
  if (s.playing) {
    // flowPasses 0 means looping until stopped; show which pass it is on.
    const lap = s.flowPasses === 0 ? 'Loop ' + s.flowPass + ' · ' : '';
    $('rec-note').textContent = lap + 'step ' + s.index + '/' + s.total +
      (s.flowPasses === 0 ? '\nClick the toolbar icon to stop.' : '');
    return;
  }
  setPlaying(false);

  if (s.error) { $('rec-note').textContent = 'Stopped: ' + s.error; return; }
  if (!s.performed) {
    const { lastRun } = await chrome.storage.session.get('lastRun');
    $('rec-note').textContent = lastRun && lastRun.error
      ? 'Stopped: ' + lastRun.error
      : 'Nothing was performed. Reload the extension and try once more.';
    return;
  }
  // Break the result down by action, so a run that "worked" but skipped the typing
  // cannot look identical to one that did everything.
  const byAction = {};
  for (const entry of s.log || []) {
    const key = entry.action + (entry.ok ? '' : ' (failed)');
    byAction[key] = (byAction[key] || 0) + 1;
  }
  const detail = Object.entries(byAction).map(([k, v]) => v + ' ' + k).join(', ');
  $('rec-note').textContent = 'Repeated ' + s.performed + ' event(s)' +
    (s.failed ? ', ' + s.failed + ' failed' : ' cleanly') + '.' +
    (detail ? '\n' + detail : '');
}

$('btn-abort').addEventListener('click', async () => {
  // Only a request. replay/abort sets a flag the run checks between steps, so the run is still
  // going for a moment - saying "Aborted." here claimed something that was not true yet, and left
  // the retry to die on a raw "already playing".
  playStopping = true;
  await ask('replay/abort');
  $('rec-note').textContent = 'Stopping after the current step…';
  setPlaying(false);
  $('rec-note').textContent = 'Aborted.';
});

$('selftest').addEventListener('click', async (ev) => {
  ev.preventDefault();
  $('rec-note').textContent = 'Testing…';
  const res = await ask('selftest');
  if (!res.ok) {
    $('rec-note').textContent = 'Failed at the "' + res.stage + '" stage:\n' + res.error;
    return;
  }
  // Frame count is the useful number here: an iframed app like Excel Online reports
  // several, and the cursor should appear in the one showing the document.
  const where = res.answered
    .map((f) => (f.frameId ? 'frame ' + f.frameId : 'main') + ' · ' +
      f.url.replace(/^https?:\/\//, '').split('/')[0] + ' ' + f.viewport)
    .join('\n');
  $('rec-note').textContent = 'Reachable in ' + res.answered.length + ' of ' + res.frames +
    ' frame(s):\n' + where;
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

async function refreshRecordView() {
  const s = await ask('ping');
  /* Order matters, and used to be wrong. setPlaying(false) un-hides #btn-record and #list, so
   * running it AFTER setRecording(true) put "Start recording" back on screen during a live
   * recording - and clicking it calls record/start, which clears rec.events and silently
   * discards the recording in progress. A recording, if there is one, has the final say. */
  setPlaying(!!s.playing);
  setRecording(!!s.recording);
  if (s.recording) refreshRecording();
  if (s.playing) refreshReplay();
  await renderList();
}

/* -------------------------------------------------------------- mode B: create */

function renderFeed(log) {
  const feed = $('feed');
  feed.hidden = !log.length;
  feed.textContent = '';
  for (const event of log) {
    const line = document.createElement('div');
    if (event.type === 'error') {
      // A failed step used to be invisible, so a run failing every step looked like one working.
      line.className = 'bad';
      line.textContent = event.text;
    } else if (event.type === 'act') {
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

  /* Which page each step is actually on. A run that drifts somewhere unrelated - a compose
   * window one step, the Play Store the next - is otherwise invisible until afterwards, and the
   * feed alone cannot show it because a click that navigates looks like any other click. */
  const steps = s.steps || [];
  const last = steps[steps.length - 1];
  const hosts = [...new Set(steps.map((x) => x.host).filter(Boolean))];
  $('where').textContent = last && last.host
    ? 'on ' + last.host + (hosts.length > 1 ? '  (visited: ' + hosts.join(', ') + ')' : '')
    : '';

  if (s.running) {
    setAgentRunning(true);
    $('ai-note').textContent = agentStopping ? 'Stopping after the current step…' : 'Working…';
    return;
  }
  agentStopping = false;
  setAgentRunning(false);

  const result = s.result || (await chrome.storage.session.get('lastAgentRun')).lastAgentRun?.result;
  if (!result) { $('ai-note').textContent = ''; return; }

  if (!result.ok) {
    $('ai-note').textContent = result.error === 'stopped' ? 'Stopped.' : result.error;
    /* A failure with a known fix offers it here rather than describing it. The saved key wins
     * over the shared one, so a rejected key is a dead end unless you know to go and delete it -
     * and the key box is collapsed, so you cannot even see which key is in play. */
    if (result.recover === 'drop-key') {
      $('btn-use-shared').hidden = false;
      $('key-box').open = true;
    }
    return;
  }
  $('btn-use-shared').hidden = true;
  $('ai-note').textContent = (result.needsUser ? 'Ready for you: ' : '') + result.summary +
    (result.steps && result.steps.length ? '\n(' + result.steps.length + ' actions taken)' : '');
}

/* The whole trace, as text, for pasting somewhere. One line per step with the page it acted on
 * and where it ended up, which is what explains a run going somewhere unexpected.
 *
 * Includes any text the agent typed, because "it entered the address twice" is exactly the kind
 * of thing this has to be able to answer. That text is the user's own content and never leaves
 * the machine unless they paste it. */
$('copy-ai-log').addEventListener('click', async (ev) => {
  ev.preventDefault();
  const { agentTrace, agentTraceHistory = [] } = await chrome.storage.local
    .get(['agentTrace', 'agentTraceHistory']);
  const run = agentTrace || agentTraceHistory[0];
  if (!run) { $('ai-note').textContent = 'No run recorded yet.'; return; }

  const lines = [
    'MouseFlow "Create the flow" — step log',
    'extension ' + (run.version || '?') + '   started ' + (run.startedAt || '?'),
    'goal: ' + run.goal,
    run.finished ? '' : '(this run did not finish)',
    '',
  ];
  for (const s of run.steps || []) {
    const detail = s.input && (s.input.url || s.input.text ||
      (s.input.ref != null ? 'ref ' + s.input.ref : ''));
    lines.push(
      String(s.n).padStart(3) + '. ' + s.tool + (detail ? ' — ' + detail : ''),
      '     on   ' + (s.url || '(no tab yet)'),
      s.wentTo ? '     ➜ ended on ' + s.wentTo : null,
      '     ' + (s.ok ? 'ok' : 'FAILED: ' + s.error) + '  (' + s.ms + 'ms)',
      s.ok && s.result ? '     ' + JSON.stringify(s.result) : null,
    );
  }
  if (run.result) {
    lines.push('', 'outcome: ' + (run.result.ok
      ? (run.result.needsUser ? '[waiting on user] ' : '') + run.result.summary
      : 'failed — ' + run.result.error));
  }
  const text = lines.filter((l) => l !== null && l !== undefined).join('\n');

  try {
    await navigator.clipboard.writeText(text);
    $('ai-note').textContent = 'Step log copied (' + (run.steps || []).length +
      ' steps) — paste it into the chat.';
  } catch (_) {
    console.log('[MouseFlow] agent trace\n' + text);
    $('ai-note').textContent = 'Clipboard blocked; the log is in this popup’s console.';
  }
});

// Drops the rejected key and re-runs the same goal, so recovery is one click and not a
// sequence the user has to work out.
$('btn-use-shared').addEventListener('click', async () => {
  await chrome.storage.local.remove('apiKey');
  $('api-key').value = '';
  $('api-key').placeholder = 'sk-ant-...';
  $('key-box').querySelector('summary').textContent =
    'Anthropic API key (using the shared demo key)';
  $('btn-clear-key').hidden = true;
  $('btn-use-shared').hidden = true;
  $('key-box').open = false;

  /* Reopening the popup empties the textarea, so the retry silently did nothing at exactly the
   * moment the user had asked for it. The worker still knows the goal of the last run. */
  let goal = $('goal').value.trim();
  if (!goal) {
    const status = await ask('agent/status');
    goal = (status && status.goal) || '';
    if (goal) $('goal').value = goal;
  }
  if (!goal) { $('ai-note').textContent = 'Key removed. Runs now use the shared demo key.'; return; }
  $('ai-note').textContent = 'Key removed. Retrying with the shared demo key…';
  const res = await ask('agent/start', { goal });
  if (!res.ok) { $('ai-note').textContent = res.error; return; }
  setAgentRunning(true);
  refreshAgent();
});

$('btn-run-goal').addEventListener('click', async () => {
  $('ai-note').textContent = '';
  $('btn-use-shared').hidden = true;
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
  // The poll rewrites the note every 700ms, so the message has to survive in state, not just be
  // written once here.
  agentStopping = true;
  await ask('agent/abort');
  $('ai-note').textContent = 'Stopping after the current step…';
});

$('btn-save-key').addEventListener('click', async () => {
  const key = $('api-key').value.trim();
  if (!key) return;
  await chrome.storage.local.set({ apiKey: key });
  $('api-key').value = '';
  $('key-box').open = false;
  $('key-box').querySelector('summary').textContent = 'Anthropic API key (using yours)';
  $('btn-clear-key').hidden = false;
  $('ai-note').textContent = 'Key saved. Runs now go straight to Anthropic on your quota.';
});

$('btn-clear-key').addEventListener('click', async () => {
  await chrome.storage.local.remove('apiKey');
  $('api-key').value = '';
  $('api-key').placeholder = 'sk-ant-...';
  $('key-box').querySelector('summary').textContent =
    'Anthropic API key (using the shared demo key)';
  $('btn-clear-key').hidden = true;
  $('ai-note').textContent = 'Key removed. Runs now use the shared demo key.';
});

/* ----------------------------------------------------------------------- init */

(async () => {
  $('open-app').href = APP_URL;
  chrome.action.setBadgeText({ text: '' }).catch(() => {});

  const [{ apiKey }, session, ping] = await Promise.all([
    chrome.storage.local.get('apiKey'),
    chrome.storage.session.get('popupView'),
    ask('ping'),
    refreshSettings(),
  ]);
  // Which key a run will use is worth stating outright, since it decides whose quota is spent.
  $('api-key').placeholder = apiKey ? 'sk-ant-… (saved — paste to replace)' : 'sk-ant-...';
  $('key-box').querySelector('summary').textContent =
    apiKey ? 'Anthropic API key (using yours)' : 'Anthropic API key (using the shared demo key)';
  $('btn-clear-key').hidden = !apiKey;

  // The last goal, so Create the flow reopens where the user left it - and so the recovery retry
  // has something to re-run.
  if (!$('goal').value) {
    const status = await ask('agent/status');
    if (status && status.goal) $('goal').value = status.goal;
  }

  // Land on whatever is actually happening; otherwise on the last mode used.
  if (ping.recording || ping.playing) { show('record'); refreshRecordView(); }
  else if (ping.agentRunning) { show('create'); refreshAgent(); }
  else if (session.popupView === 'record') { show('record'); refreshRecordView(); }
  else if (session.popupView === 'create') { show('create'); refreshAgent(); }
  else show('home');
})();
