/* Popup: record, and replay the last recording, without leaving the page being automated.
 *
 * The web app owns the real library and flow builder. This is deliberately the minimum
 * needed to close the loop on its own - record, stop, replay - so the extension is
 * testable and useful before the app bridge exists. Recordings are parked in
 * chrome.storage.local so one is never lost because the app was not open.
 */

'use strict';

const APP_URL = 'https://mouse-agent.vercel.app';
const $ = (id) => document.getElementById(id);

let recPoll = null;
let playPoll = null;

const fmt = (ms) => (ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's');

function ask(mf, extra) {
  return chrome.runtime.sendMessage(Object.assign({ mf }, extra));
}

const getPending = async () => (await chrome.storage.local.get('pending')).pending || [];

/* ------------------------------------------------------------------ recording */

function setRecording(on) {
  $('live').hidden = !on;
  $('record').hidden = on;
  $('stop').hidden = !on;
  clearInterval(recPoll);
  recPoll = on ? setInterval(refreshRecording, 400) : null;
}

async function refreshRecording() {
  const s = await ask('record/status');
  $('count').textContent = s.count;
  $('elapsed').textContent = fmt(s.elapsedMs);
  if (!s.recording) { setRecording(false); showSaved(); }
}

$('record').addEventListener('click', async () => {
  $('note').textContent = '';
  const res = await ask('record/start');
  if (!res.ok) { $('note').textContent = res.error; return; }
  setRecording(true);
  refreshRecording();
});

$('stop').addEventListener('click', async () => {
  const res = await ask('record/stop');
  setRecording(false);
  if (!res.ok) { $('note').textContent = res.error; return; }
  if (!res.events.length) { $('note').textContent = 'Nothing was captured.'; return; }

  const pending = await getPending();
  pending.push({
    id: Math.random().toString(36).slice(2, 10),
    name: 'Web recording ' + (pending.length + 1),
    created: new Date().toISOString(),
    kind: 'web',
    url: res.url || null,
    origin: res.origin || null,
    events: res.events,
  });
  await chrome.storage.local.set({ pending });
  $('note').textContent = res.events.length + ' events saved.';
  showSaved();
});

/* --------------------------------------------------------------------- replay */

async function showSaved() {
  const pending = await getPending();
  const last = pending[pending.length - 1];
  $('saved').hidden = !last;
  if (!last) return;
  $('saved-name').textContent = last.name;
  $('saved-count').textContent = last.events.length + ' events';
  // The site it belongs to, since replaying it anywhere else is refused.
  $('saved-name').title = last.url || 'origin unknown';
  if (last.origin) $('saved-name').textContent = last.name + ' · ' + last.origin.replace(/^https?:\/\//, '');
}

function setPlaying(on) {
  $('replay').hidden = on;
  $('abort').hidden = !on;
  clearInterval(playPoll);
  playPoll = on ? setInterval(refreshReplay, 300) : null;
}

async function refreshReplay() {
  const s = await ask('replay/status');
  if (s.playing) {
    $('note').textContent = 'Replaying ' + s.index + '/' + s.total;
    return;
  }
  setPlaying(false);

  if (s.error) { $('note').textContent = 'Stopped: ' + s.error; return; }

  // "Finished" with nothing performed means the run never really happened - almost
  // always a worker restart or an empty recording. Say so instead of implying success.
  if (!s.performed) {
    const { lastRun } = await chrome.storage.session.get('lastRun');
    $('note').textContent = lastRun && lastRun.error
      ? 'Stopped: ' + lastRun.error
      : 'Nothing was performed. Reload the extension and try once more.';
    return;
  }
  $('note').textContent = 'Replayed ' + s.performed + ' event(s)' +
    (s.failed ? ', ' + s.failed + ' failed' : ' cleanly') + '.';
}

$('replay').addEventListener('click', async () => {
  const pending = await getPending();
  const last = pending[pending.length - 1];
  if (!last) return;

  $('note').textContent = 'Starting…';
  const res = await ask('replay', {
    flow: {
      // Short lead-in so the popup can close and the page settle before the first click.
      startDelay: 400,
      flowRepeat: 1,
      origin: last.origin || null,
      steps: [{ events: last.events, repeat: 1, speed: 1, delayAfter: 0 }],
    },
  });
  if (!res.ok) { $('note').textContent = res.error; return; }
  setPlaying(true);
  refreshReplay();
});

$('abort').addEventListener('click', async () => {
  await ask('replay/abort');
  setPlaying(false);
  $('note').textContent = 'Aborted.';
});

$('clear').addEventListener('click', async (ev) => {
  ev.preventDefault();
  await chrome.storage.local.remove('pending');
  $('saved').hidden = true;
  $('note').textContent = 'Saved recordings cleared.';
});

/* ----------------------------------------------------------------------- init */

(async () => {
  $('open').href = APP_URL;
  const s = await ask('ping');
  setRecording(!!s.recording);
  setPlaying(!!s.playing);
  if (s.recording) refreshRecording();
  if (s.playing) refreshReplay();
  await showSaved();
})();
