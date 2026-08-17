/* Popup: start/stop a recording without leaving the page being recorded.
 *
 * Recordings are handed to the web app, which owns the library and the flow builder.
 * Saving one here parks it in chrome.storage.local until the app collects it, so a
 * recording is never lost just because the app was not open.
 */

'use strict';

const APP_URL = 'https://mouse-agent.vercel.app';
const $ = (id) => document.getElementById(id);

let poll = null;

const fmt = (ms) => (ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's');

function ask(mf, extra) {
  return chrome.runtime.sendMessage(Object.assign({ mf }, extra));
}

function setRecording(on) {
  $('live').hidden = !on;
  $('record').hidden = on;
  $('stop').hidden = !on;
  clearInterval(poll);
  poll = on ? setInterval(refresh, 400) : null;
}

async function refresh() {
  const s = await ask('record/status');
  $('count').textContent = s.count;
  $('elapsed').textContent = fmt(s.elapsedMs);
  if (!s.recording) setRecording(false);
}

$('record').addEventListener('click', async () => {
  $('note').textContent = '';
  const res = await ask('record/start');
  if (!res.ok) { $('note').textContent = res.error; return; }
  setRecording(true);
  refresh();
});

$('stop').addEventListener('click', async () => {
  const res = await ask('record/stop');
  setRecording(false);
  if (!res.ok) { $('note').textContent = res.error; return; }
  if (!res.events.length) { $('note').textContent = 'Nothing was captured.'; return; }

  const { pending = [] } = await chrome.storage.local.get('pending');
  pending.push({
    id: Math.random().toString(36).slice(2, 10),
    name: 'Web recording ' + (pending.length + 1),
    created: new Date().toISOString(),
    kind: 'web',
    events: res.events,
  });
  await chrome.storage.local.set({ pending });
  $('note').textContent = res.events.length + ' events saved. Open the app to build a flow.';
});

(async () => {
  $('open').href = APP_URL;
  const s = await ask('record/status');
  setRecording(s.recording);
  if (s.recording) refresh();
  const { pending = [] } = await chrome.storage.local.get('pending');
  if (pending.length && !s.recording) {
    $('note').textContent = pending.length + ' recording(s) waiting for the app.';
  }
})();
