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
/* Every command goes through here, so this is also where a locked door is noticed: the worker
 * answers `signedOut` when the extension is not attached to an account, and the wall goes back up
 * wherever in the UI the command came from. */
const ask = async (mf, extra) => {
  const res = await chrome.runtime.sendMessage(Object.assign({ mf }, extra));
  if (res && res.signedOut) showGate(res.error);
  return res;
};
const getPending = async () => (await chrome.storage.local.get('pending')).pending || [];

/* ------------------------------------------------------------------ navigation */

function show(which) {
  for (const id of ['gate', 'home', 'record', 'create', 'skills', 'gallery']) {
    $(id).hidden = id !== which;
  }
  /* The rail is the navigation, so it has to agree with what is showing - including on the wall,
   * where there is nothing to navigate to and it is not there at all. */
  $('rail').hidden = which === 'gate';
  // Each screen starts at its own top. Carrying the last one's scroll position over lands the user
  // halfway down a page they have not seen yet.
  $('pane').scrollTop = 0;
  for (const button of document.querySelectorAll('.rail-btn')) {
    button.classList.toggle('on', button.dataset.go === which);
  }
  if (which !== 'record') { clearInterval(playPoll); playPoll = null; }
  if (which !== 'create') { clearInterval(agentPoll); agentPoll = null; }
  chrome.storage.session.set({ popupView: which }).catch(() => {});
}

$('go-record').addEventListener('click', () => { show('record'); refreshRecordView(); });
$('go-create').addEventListener('click', () => { show('create'); refreshAgent(); });
$('go-skills').addEventListener('click', () => { show('skills'); renderSkills(); refreshAccount(); });
$('go-gallery').addEventListener('click', () => OPENERS.gallery());
document.querySelectorAll('[data-home]').forEach((b) => b.addEventListener('click', () => show('home')));

/* One handler for the rail: the buttons name the view they open, so adding one is markup only. */
const OPENERS = {
  // The mark at the top of the rail. Back to every option, which is where the popup starts.
  home: () => { show('home'); refreshAccount(); },
  record: () => { show('record'); refreshRecordView(); },
  create: () => { show('create'); refreshAgent(); },
  skills: () => { show('skills'); renderSkills(); refreshAccount(); },
  gallery: () => { show('gallery'); renderGallery(); },
};

for (const button of document.querySelectorAll('.rail-btn')) {
  button.addEventListener('click', () => OPENERS[button.dataset.go]());
}

/* The account sits at the foot of the rail, as in the app. It opens Skills with the account panel
 * already unfolded, which is where syncing and signing out live. */
$('rail-avatar').addEventListener('click', () => {
  show('skills');
  renderSkills();
  $('account-box').open = true;
  refreshAccount();
});

/* ----------------------------------------------------------------------- the wall */

/* This popup is read from disk every time it opens; the background worker is not - it keeps running
 * the build it started with until the extension is reloaded. So the two can disagree, and when they
 * do the symptom is a button that does nothing: the popup sends a command the old worker has no
 * route for. Both halves of the check live here, because only this half can see both versions.
 */
const staleWorker = (res) => !!(res && typeof res.error === 'string' && /unknown command/.test(res.error));

async function versionNote() {
  const ping = await chrome.runtime.sendMessage({ mf: 'ping' }).catch(() => null);
  if (!ping || !ping.version) return null;
  const mine = chrome.runtime.getManifest().version;
  if (ping.version === mine) return null;
  return 'This extension was updated to ' + mine + ' but is still running ' + ping.version + '. ' +
    'Open chrome://extensions and press Reload on MouseFlow.';
}

/* Signing in is pairing: one click opens the app, which is the only place a Google session can
 * live, and the token comes back on its own through the bridge content script. See bridge.js.
 *
 * While the wall is up nothing else is reachable - not because this hides it, but because the
 * worker refuses every other command. This is the face of that rule, not the rule. */
let gatePoll = null;

/* Who is signed in, in the two places that say so: the line on the mode picker and the avatar at
 * the foot of the rail. */
function showWho(name) {
  const initial = (String(name || '?').trim()[0] || '?').toUpperCase();
  $('who').hidden = false;
  $('who-name').textContent = name;
  $('who-mark').textContent = initial;
  /* The disc inside the button, not the button itself: writing textContent onto the button would delete the
     element that draws the circle, which is why the rail's account is one box with a disc in it now. */
  $('rail-initial').textContent = initial;
  $('rail-avatar').title = 'Signed in as ' + name;
}

async function showGate(message) {
  show('gate');
  // A version mismatch explains every other failure on this screen, so it outranks any other message.
  $('gate-note').textContent = (await versionNote()) || message || '';
  clearInterval(gatePoll);
  /* The handover happens in a tab, and finishes while the user is looking at that tab. If the popup
   * is still open when it lands, it should notice by itself rather than needing a click. */
  gatePoll = setInterval(async () => {
    const s = await chrome.runtime.sendMessage({ mf: 'sync/status' }).catch(() => null);
    if (s && s.paired) { clearInterval(gatePoll); gatePoll = null; enter(s); }
  }, 1500);
}

/* Past the wall. */
function enter(status) {
  clearInterval(gatePoll);
  gatePoll = null;
  const name = (status && status.who && status.who.name) || 'your account';
  showWho(name);
  show('home');
  renderSkills().catch(() => {});
}

$('gate-google').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ mf: 'auth/start' }).catch(() => null);
  /* Reporting only what happened. Announcing "finish signing in on the tab that just opened" without
   * checking whether a tab opened is how a dead button looks like a working one - and the button was
   * dead, because the worker was still an older build that had never heard of auth/start. */
  if (!res || !res.ok) {
    $('gate-note').textContent = staleWorker(res)
      ? 'This extension has been updated but is still running the old version. Open ' +
        'chrome://extensions, press Reload on MouseFlow, then try again.'
      : 'Could not open the sign-in tab: ' + ((res && res.error) || 'no answer from the extension');
    return;
  }
  $('gate-note').textContent = 'Finish signing in on the tab that just opened. This connects ' +
    'itself when you do — reopen this popup if it has closed.';
});

$('btn-gate-pair').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({
    mf: 'sync/pair', token: $('gate-token').value,
  });
  if (!res || !res.ok) { $('gate-note').textContent = (res && res.error) || 'could not connect'; return; }
  $('gate-token').value = '';
  const status = await chrome.runtime.sendMessage({ mf: 'sync/status' });
  enter(status);
});

$('who-out').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ mf: 'sync/unpair' });
  $('who').hidden = true;
  showGate('Signed out here. Your flows are still on your account.');
});

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

    const keep = document.createElement('button');
    keep.textContent = 'Save as skill';
    keep.title = 'Keep this under a name, ready to run again or share';
    keep.addEventListener('click', async () => {
      const res = await ask('skills/save', { from: 'recording', id: rec.id, name: rec.name });
      $('rec-note').textContent = res && res.ok
        ? 'Saved \u201c' + res.skill.name + '\u201d as a skill. See Skills on the first screen.'
        : (res && res.error) || 'could not save that';
    });

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
    item.append(name, meta, tools, keep);
    keep.style.width = '100%';
    keep.style.marginTop = '6px';
    keep.style.fontSize = '12px';
    keep.style.fontWeight = '500';
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

/* ------------------------------------------------------------------- skills */

/* A kept flow, with the controls that make it worth keeping: run it, fill in what varies, share it,
 * throw it away. Built from the same list pattern as recordings so the two read alike. */
async function renderSkills() {
  const res = await ask('skills/list');
  const skills = (res && res.skills) || [];
  const list = $('skill-list');
  list.textContent = '';
  $('skills-empty').hidden = skills.length > 0;
  $('skills-count').textContent = skills.length
    ? skills.length + (skills.length === 1 ? ' skill' : ' skills') + ' kept, ready to run or share.'
    : 'Flows you have kept, ready to run again or share.';

  for (const skill of skills) {
    const item = document.createElement('li');
    item.className = 'item';

    const name = document.createElement('input');
    name.className = 'item-name';
    name.value = skill.name;
    name.setAttribute('aria-label', 'Skill name');
    name.addEventListener('change', async () => {
      const next = name.value.trim();
      if (!next) { name.value = skill.name; return; }
      await ask('skills/rename', { id: skill.id, name: next });
      skill.name = next;
    });

    const kind = document.createElement('span');
    kind.className = 'tag tag-' + skill.kind;
    kind.textContent = skill.kind === 'created' ? 'created' : 'recorded';
    kind.title = skill.kind === 'created'
      ? 'Re-runs its goal through the agent: adapts, costs an API call per step'
      : 'Repeats exactly what was recorded: free, but breaks if the page changes';

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = (skill.description || '') +
      (skill.from && skill.from.gallery ? ' · from the gallery' : '');
    meta.title = (skill.origins || []).join('\n');

    /* What varies between runs, asked for at the point of running rather than stored. The example
     * from the original goal is the placeholder, so leaving a field blank repeats the original. */
    const values = {};
    for (const param of skill.params || []) {
      const row = document.createElement('div');
      row.className = 'param';
      const label = document.createElement('label');
      label.textContent = param.name;
      const input = document.createElement('input');
      /* No example means nothing to fall back on - a skill from the gallery, whose author's values did not
         travel with it - so the field is required rather than optional. */
      const needed = !(param.example && String(param.example).trim());
      input.placeholder = needed ? 'needed' : param.example;
      input.required = needed;
      input.setAttribute('aria-label', param.name);
      input.addEventListener('input', () => { values[param.name] = input.value.trim(); });
      row.append(label, input);
      item.appendChild(row);
    }

    const tools = document.createElement('div');
    tools.className = 'item-tools';

    const run = document.createElement('button');
    run.textContent = 'Run';
    run.addEventListener('click', async () => {
      const res2 = await ask('skills/run', { id: skill.id, values });
      if (!res2 || !res2.ok) { $('skills-note').textContent = (res2 && res2.error) || 'could not run it'; return; }
      // A recorded skill replays; a created one hands over to the agent, which has its own view.
      if (skill.kind === 'created') { show('create'); refreshAgent(); }
      else { show('record'); refreshRecordView(); }
    });

    const publish = document.createElement('button');
    publish.textContent = 'Publish';
    publish.title = 'Open the gallery to publish this skill for others';
    publish.addEventListener('click', async () => {
      const res2 = await ask('skills/publish', { id: skill.id });
      if (!res2 || !res2.ok) {
        $('skills-note').textContent = (res2 && res2.error) || 'could not open the gallery';
        return;
      }
      $('skills-note').textContent = 'Opened the gallery — sign in there and press Publish.';
    });

    const share = document.createElement('button');
    share.textContent = 'Share';
    share.title = 'Copy this skill as text — paste it to anyone with the extension';
    share.addEventListener('click', async () => {
      const res2 = await ask('skills/export', { id: skill.id });
      if (!res2 || !res2.ok) { $('skills-note').textContent = (res2 && res2.error) || 'could not export'; return; }
      try {
        await navigator.clipboard.writeText(res2.text);
        $('skills-note').textContent = 'Copied. Paste it to anyone with the extension.';
      } catch (_) {
        console.log('[MouseFlow] skill\n' + res2.text);
        $('skills-note').textContent = 'Clipboard blocked; the skill is in this popup\u2019s console.';
      }
    });

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '\u2715';
    del.title = 'Delete this skill';
    del.addEventListener('click', async () => {
      await ask('skills/delete', { id: skill.id });
      $('skills-note').textContent = 'Deleted \u201c' + skill.name + '\u201d.';
      renderSkills();
    });

    tools.append(run, share, publish, del);
    item.insertBefore(meta, item.firstChild);
    item.insertBefore(name, item.firstChild);
    name.after(kind);
    item.appendChild(tools);
    list.appendChild(item);
  }
}

/* The account.
 *
 * Pairing is a pasted token rather than a sign-in button, because an extension cannot hold a session -
 * see the note in background.js. Syncing is a button rather than automatic: it is somebody else's
 * data allowance, and a flow is not urgent. */
async function refreshAccount() {
  const s = await ask('sync/status');
  const paired = !!(s && s.paired);
  $('btn-sync').hidden = !paired;
  $('btn-unpair').hidden = !paired;
  $('account-summary').textContent = paired
    ? 'Account — ' + ((s.who && s.who.name) || 'connected') +
      (s.syncedAt ? ', synced ' + new Date(s.syncedAt).toLocaleTimeString() : '')
    : 'Account — not connected';
}

$('btn-sync').addEventListener('click', async () => {
  $('btn-sync').disabled = true;
  $('sync-note').textContent = 'Syncing…';
  const res = await ask('sync/now');
  $('btn-sync').disabled = false;
  if (!res || !res.ok) { $('sync-note').textContent = (res && res.error) || 'sync failed'; return; }

  const bits = ['sent ' + res.pushed.flows + ' skill' + (res.pushed.flows === 1 ? '' : 's')];
  if (res.pushed.runs) bits.push(res.pushed.runs + ' run' + (res.pushed.runs === 1 ? '' : 's'));
  if (res.adopted) bits.push('brought back ' + res.adopted);
  // Desktop flows are mentioned rather than hidden: they are in the account, and this half cannot
  // run them, and saying so is better than a number that does not add up.
  if (res.desktopFlows) bits.push(res.desktopFlows + ' desktop flow' +
    (res.desktopFlows === 1 ? '' : 's') + ' (run those in the app)');
  $('sync-note').textContent = bits.join(' · ') +
    (res.pushed.problems.length ? '\n' + res.pushed.problems.join('\n') : '');
  refreshAccount();
  renderSkills();
});

$('btn-unpair').addEventListener('click', async () => {
  await ask('sync/unpair');
  // Disconnecting is signing out: without an account there is nothing here to use.
  $('who').hidden = true;
  showGate('Disconnected here. Revoke the token in the app to retire it for good.');
});

$('account-box').addEventListener('toggle', () => {
  if ($('account-box').open) refreshAccount();
});

/* The gallery, inside the popup.
 *
 * Reading it needs no account, so the extension can fetch it directly - install is one click rather
 * than a trip to a web page to copy JSON out and paste it back in. */
let galleryTimer = null;

async function renderGallery() {
  const list = $('gallery-list');
  const term = $('gallery-q').value.trim();
  list.textContent = '';
  $('gallery-note').textContent = 'Loading…';

  const res = await ask('gallery/list', term ? { q: term } : {});
  if (!res || !res.ok) {
    $('gallery-note').textContent = (res && res.error) || 'could not reach the gallery';
    return;
  }
  const skills = res.skills || [];
  $('gallery-note').textContent = skills.length
    ? ''
    : (term ? 'Nothing matches that.' : 'Nothing published yet.');

  for (const skill of skills) {
    const item = document.createElement('li');
    item.className = 'item';

    const name = document.createElement('div');
    name.style.fontWeight = '600';
    name.textContent = skill.name;
    const kind = document.createElement('span');
    kind.className = 'tag tag-' + skill.kind;
    kind.textContent = skill.kind;
    name.appendChild(kind);

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = [
      skill.description,
      'by ' + ((skill.author && skill.author.name) || 'someone'),
      skill.params && skill.params.length
        ? 'asks for ' + skill.params.map((p) => p.name).join(', ') : null,
    ].filter(Boolean).join(' · ');

    const tools = document.createElement('div');
    tools.className = 'item-tools';
    const get = document.createElement('button');
    get.textContent = 'Install';
    get.addEventListener('click', async () => {
      get.disabled = true;
      get.textContent = 'Installing…';
      const done = await ask('gallery/install', { id: skill.id });
      if (!done || !done.ok) {
        $('gallery-note').textContent = (done && done.error) || 'could not install that';
        get.disabled = false;
        get.textContent = 'Install';
        return;
      }
      get.textContent = 'Installed';
      $('gallery-note').textContent = 'Installed “' + done.skill.name + '”.';
      renderSkills();
    });
    tools.appendChild(get);

    item.append(name, meta, tools);
    list.appendChild(item);
  }
}

$('gallery-q').addEventListener('input', () => {
  clearTimeout(galleryTimer);
  galleryTimer = setTimeout(renderGallery, 250);
});

$('skills-export').addEventListener('click', async (ev) => {
  ev.preventDefault();
  const res = await ask('skills/export', {});
  if (!res || !res.ok) { $('skills-note').textContent = (res && res.error) || 'nothing to export'; return; }
  try {
    await navigator.clipboard.writeText(res.text);
    $('skills-note').textContent = 'All skills copied.';
  } catch (_) {
    console.log('[MouseFlow] skills\n' + res.text);
    $('skills-note').textContent = 'Clipboard blocked; they are in this popup\u2019s console.';
  }
});

/* Import is two clicks on purpose: the first reveals the box, the second reads it. Reading the
 * clipboard without being asked to is not something a popup should do. */
$('skills-import').addEventListener('click', async (ev) => {
  ev.preventDefault();
  const box = $('skills-paste');
  if (box.hidden) {
    box.hidden = false;
    box.focus();
    $('skills-note').textContent = 'Paste the skill, then press Paste one in again.';
    return;
  }
  const text = box.value.trim();
  if (!text) { $('skills-note').textContent = 'Nothing pasted yet.'; return; }
  const res = await ask('skills/import', { text });
  if (!res || !res.ok) { $('skills-note').textContent = (res && res.error) || 'could not read that'; return; }
  box.value = '';
  box.hidden = true;
  $('skills-note').textContent = 'Added ' + res.added + (res.added === 1 ? ' skill.' : ' skills.');
  renderSkills();
});

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
      const detail = stepDetail(event.input);
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
  // A run that worked is worth keeping; one that did not is not.
  $('btn-save-skill').hidden = false;
  $('ai-note').textContent = (result.needsUser ? 'Ready for you: ' : '') + result.summary +
    (result.steps && result.steps.length ? '\n(' + result.steps.length + ' actions taken)' : '');
}

/* What an action was aimed at, in a few characters. A press_key showed nothing at all, which made
 * six keyboard steps in a row unreadable - and whether a shortcut was even tried was the question. */
function stepDetail(input) {
  if (!input) return '';
  if (input.key) {
    return [input.ctrl && 'Ctrl', input.shift && 'Shift', input.alt && 'Alt', input.meta && 'Meta',
      input.key].filter(Boolean).join('+');
  }
  if (input.url) return input.url;
  if (input.text) return input.text;
  if (input.direction) return input.direction + (input.amount ? ' ' + input.amount : '');
  if (input.ref != null) return 'ref ' + input.ref;
  return '';
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
    const detail = stepDetail(s.input);
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

/* Offered only after a run that worked. A skill made from a failed run would carry a goal that is
 * known not to work, which is worse than having no skill. */
$('btn-save-skill').addEventListener('click', async () => {
  const res = await ask('skills/save', { from: 'run' });
  if (!res || !res.ok) { $('ai-note').textContent = (res && res.error) || 'could not save that'; return; }
  const params = (res.skill.params || []).map((p) => p.name);
  $('btn-save-skill').hidden = true;
  $('ai-note').textContent = 'Saved as \u201c' + res.skill.name + '\u201d' +
    (params.length ? ', asking for ' + params.join(', ') + ' each run.' : '.') +
    ' See Skills on the first screen.';
});

$('btn-run-goal').addEventListener('click', async () => {
  $('ai-note').textContent = '';
  $('btn-use-shared').hidden = true;
  $('btn-save-skill').hidden = true;
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
  // Through the app shell, so the gallery arrives with the sidebar rather than on its own page.
  $('skills-gallery').href = APP_URL + '/#gallery';
  chrome.action.setBadgeText({ text: '' }).catch(() => {});

  /* Asked before anything is rendered, because everything below it needs an account - and asked
   * through sendMessage rather than ask(), which would recurse into showGate. */
  const status = await chrome.runtime.sendMessage({ mf: 'sync/status' }).catch(() => null);
  if (!status || !status.paired) { showGate(); return; }

  showWho((status.who && status.who.name) || 'your account');

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
