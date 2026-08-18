/* Three places, matching the extension: Desktop, Skills, Gallery.
 *
 * The app used to be only the desktop-agent console, which made it look like a different product from
 * the extension rather than the other half of the same one.
 *
 * Routed by hash so a tab is linkable and survives a refresh - and so the OAuth callback can send
 * someone back to the tab they signed in from. Views are mounted lazily: the gallery costs a request
 * and the desktop console is what most visits want, so neither should pay for the other.
 */

import { mountGallery } from './gallery-view.js';
import { mountSkills } from './skills-view.js';
import { mountCreate } from './create-view.js';
import { requireAccount } from './gate.js';

const VIEWS = ['desktop', 'create', 'skills', 'gallery'];
const TITLES = {
  desktop: 'Desktop', create: 'Create the flow', skills: 'Skills', gallery: 'Gallery',
};
const mounted = {};

function viewFromHash() {
  // The extension's sign-in button lands here; the account panel it needs is in Skills.
  if (new URLSearchParams(location.search).get('pair') === 'extension' && !location.hash) return 'skills';
  const hash = location.hash.replace(/^#/, '');
  // A skill arriving from the extension carries #publish=…, which means the gallery.
  if (hash.startsWith('publish=')) return 'gallery';
  const name = hash.split(/[?&]/)[0];
  return VIEWS.includes(name) ? name : 'desktop';
}

function mount(view) {
  if (mounted[view]) return;
  if (view === 'gallery') mounted.gallery = mountGallery(document.getElementById('gallery-root'));
  if (view === 'skills') mounted.skills = mountSkills(document.getElementById('skills-root'));
  if (view === 'create') mounted.create = mountCreate(document.getElementById('create-root'));
  // The desktop console is rendered by app.js on load; there is nothing to mount.
  if (view === 'desktop') mounted.desktop = true;
}

function show(view) {
  for (const name of VIEWS) {
    const el = document.getElementById('view-' + name);
    if (el) el.hidden = name !== view;
  }
  for (const tab of document.querySelectorAll('#tabs .tab')) {
    const on = tab.dataset.view === view;
    tab.classList.toggle('tab--on', on);
    tab.setAttribute('aria-current', on ? 'page' : 'false');
  }
  /* The agent's setup panel belongs to the desktop console. Left visible on the other tabs it reads
   * as "the gallery needs a local agent", which it does not. */
  for (const el of document.querySelectorAll('.view-desktop-only')) {
    el.classList.toggle('hidden-by-tab', view !== 'desktop');
  }
  // The sidebar took the brand, so the top bar says where you are.
  const title = document.getElementById('topbar-title');
  if (title) title.textContent = TITLES[view] || 'MouseFlow';
  mount(view);
}

for (const tab of document.querySelectorAll('#tabs .tab')) {
  tab.addEventListener('click', () => {
    // Through the hash rather than directly, so the address bar and the view cannot disagree.
    location.hash = '#' + tab.dataset.view;
  });
}

addEventListener('hashchange', () => show(viewFromHash()));

/* ---------------------------------------------------------------------------- the sidebar */

/* Collapsing is remembered, because it is a preference about this screen rather than about this
 * visit - reverting on every load would be the app forgetting something the user told it. */
const side = document.getElementById('side');
const TIGHT = 'mouseflow.side.tight';

function setTight(tight) {
  side.classList.toggle('side--tight', tight);
  const toggle = document.getElementById('side-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', String(!tight));
  try { localStorage.setItem(TIGHT, tight ? '1' : '0'); } catch (_) { /* private mode */ }
}

try { if (localStorage.getItem(TIGHT) === '1') setTight(true); } catch (_) {}

document.getElementById('side-toggle').addEventListener('click', () => setTight(true));
document.getElementById('side-open').addEventListener('click', () => setTight(false));

/* "New flow" opens Create, and puts the cursor in the box. Describing what you want is the way in
 * that needs no equipment - recording needs the desktop agent running, and installing needs somebody
 * else to have published something. */
document.getElementById('side-new').addEventListener('click', () => {
  location.hash = '#create';
  const box = document.getElementById('c-goal');
  if (box) box.focus();
});

/* What you were working on - which means what you RAN, not what you happen to have saved.
 *
 * It used to list flows by when they were last edited, and most of them are recordings whose names are
 * taken from the page they were made on. So "Recent" read as a list of websites: a sidebar full of
 * places rather than of work. Runs are the honest signal - a flow you ran an hour ago is what you were
 * doing, and one you saved in March and never ran is not.
 *
 * From the account rather than from this browser, because the point of an account is that the
 * extension's runs and the desktop agent's runs are one history.
 */
async function fillRecent() {
  let body = null;
  try {
    const res = await fetch('/api/sync', { credentials: 'same-origin' });
    if (!res.ok) return;
    body = await res.json();
  } catch (_) {
    return;                       // a sidebar is not worth an error message
  }

  const flows = Array.isArray(body.flows) ? body.flows : [];
  const runs = Array.isArray(body.runs) ? body.runs : [];
  const byId = new Map(flows.map((flow) => [flow.id, flow]));

  const stat = document.getElementById('side-stat');
  if (stat) {
    stat.hidden = false;
    document.getElementById('side-runs').textContent = String(runs.length);
  }

  /* Runs come back newest first. One entry per thing run - a flow you ran five times is one line, at
   * the time of the latest of them, not five lines pushing everything else out. */
  const seen = new Set();
  const recent = [];
  for (const run of runs) {
    const flow = run.flowId ? byId.get(run.flowId) : null;
    const label = flow ? (flow.name || 'Untitled') : (run.goal || '').trim();
    if (!label) continue;                       // a replay with nothing to name it
    const key = run.flowId || label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recent.push({
      label,
      source: flow ? flow.source : (run.extension ? 'web' : 'desktop'),
      when: run.startedAt || run.finishedAt || null,
      outcome: run.outcome,
      saved: !!flow,
    });
    if (recent.length >= 12) break;
  }

  if (!recent.length) {
    document.getElementById('side-recent').hidden = true;
    return;
  }

  const list = document.getElementById('side-recent-list');
  list.textContent = '';
  for (const entry of recent) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = entry.label;
    /* Which half ran it, in one word. A flow aimed at page elements and one aimed at screen
     * coordinates are not interchangeable, and this list is where that gets decided. */
    const tag = document.createElement('span');
    tag.className = 'side-src';
    tag.textContent = entry.source === 'desktop' ? 'desktop' : 'web';
    button.appendChild(tag);
    button.title = entry.label +
      (entry.when ? ' \u2014 ran ' + new Date(entry.when).toLocaleString() : '') +
      (entry.outcome && entry.outcome !== 'ok' ? ' (' + entry.outcome + ')' : '') +
      (entry.saved ? '' : ' \u2014 not saved as a skill');
    // A saved flow lives in Skills; a one-off run has nowhere else to be, so it reopens Create.
    button.addEventListener('click', () => { location.hash = entry.saved ? '#skills' : '#create'; });
    item.appendChild(button);
    list.appendChild(item);
  }
  document.getElementById('side-recent').hidden = false;
}

/* ------------------------------------------------------------------------------ my account */

/* The theme is remembered here rather than on the account, because it is about this screen: the same
 * person at a bright desk and on a dark laptop wants different answers. `system` is the absence of a
 * choice, so it removes the attribute instead of setting a third value. */
const THEME = 'mouseflow.theme';

function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  for (const button of document.querySelectorAll('#sheet-theme .seg-btn')) {
    button.classList.toggle('on', button.dataset.theme === (choice || 'system'));
  }
  try { localStorage.setItem(THEME, choice || 'system'); } catch (_) {}
}

let storedTheme = 'system';
try { storedTheme = localStorage.getItem(THEME) || 'system'; } catch (_) {}
applyTheme(storedTheme);

for (const button of document.querySelectorAll('#sheet-theme .seg-btn')) {
  button.addEventListener('click', () => applyTheme(button.dataset.theme));
}

const sheet = document.getElementById('account-panel');
const said = document.getElementById('sheet-said');

function say(message, kind) {
  said.textContent = message || '';
  said.classList.toggle('is-bad', kind === 'bad');
  said.classList.toggle('is-good', kind === 'good');
}

function closeAccount() {
  sheet.hidden = true;
  say('');
  disarmDelete();
}

/* What else is signed in as you, and the way to take one away. A device token is a credential, so the
 * list of them is the only place its existence is visible - the token itself is shown once, at
 * minting, and stored only as a hash. */
async function loadDevices() {
  const list = document.getElementById('sheet-devices');
  const note = document.getElementById('sheet-devices-note');
  list.textContent = '';
  let body = null;
  try {
    const res = await fetch('/api/sync?tokens=1', { credentials: 'same-origin' });
    body = await res.json();
    if (!res.ok) throw new Error((body && body.error && body.error.message) || 'HTTP ' + res.status);
  } catch (err) {
    note.textContent = 'Could not list your devices: ' + err.message;
    return;
  }

  const devices = (body && body.devices) || [];
  note.textContent = devices.length
    ? 'Extensions and agents signed in as you. Revoking one stops it syncing at once.'
    : 'Nothing paired yet. Connect an extension from the Skills tab.';

  for (const device of devices) {
    const item = document.createElement('li');
    const who = document.createElement('div');
    who.className = 'sheet-dev';
    who.appendChild(Object.assign(document.createElement('strong'), {
      textContent: device.label || 'Device',
    }));
    who.appendChild(Object.assign(document.createElement('span'), {
      textContent: device.lastUsedAt
        ? 'last used ' + new Date(device.lastUsedAt).toLocaleString()
        : 'never used since it was created',
    }));

    const revoke = document.createElement('button');
    revoke.className = 'btn btn--sm btn--ghost';
    revoke.textContent = 'Revoke';
    revoke.addEventListener('click', async () => {
      revoke.disabled = true;
      const res = await fetch('/api/sync?token=' + encodeURIComponent(device.id), {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const answer = await res.json().catch(() => null);
      if (!res.ok) {
        revoke.disabled = false;
        say((answer && answer.error && answer.error.message) || 'could not revoke that device', 'bad');
        return;
      }
      say('Revoked. That device will have to be paired again.', 'good');
      loadDevices();
    });

    item.append(who, revoke);
    list.appendChild(item);
  }
}

/* Deleting asks twice, in the same button. A confirm() is easy to click through and a second dialog
 * is easy to lose behind the first; changing the button into the consequence is not. */
let armed = false;
const deleteButton = document.getElementById('sheet-delete');

function disarmDelete() {
  armed = false;
  deleteButton.classList.remove('is-armed');
  deleteButton.textContent = 'Delete my data';
}

deleteButton.addEventListener('click', async () => {
  if (!armed) {
    armed = true;
    deleteButton.classList.add('is-armed');
    deleteButton.textContent = 'Delete everything — press again';
    say('This cannot be undone. Press again within a few seconds to go ahead.', 'bad');
    setTimeout(() => { if (armed) { disarmDelete(); say(''); } }, 6000);
    return;
  }

  deleteButton.disabled = true;
  say('Deleting…');
  let body = null;
  try {
    const res = await fetch('/api/account?erase=1', { method: 'DELETE', credentials: 'same-origin' });
    body = await res.json();
    if (!res.ok) throw new Error((body && body.error && body.error.message) || 'HTTP ' + res.status);
  } catch (err) {
    deleteButton.disabled = false;
    disarmDelete();
    say('Nothing was deleted: ' + err.message, 'bad');
    return;
  }

  const gone = body.deleted || {};
  say(gone.flows + ' flows, ' + gone.runs + ' runs and ' + gone.devices +
    ' devices deleted' + (gone.withdrawn ? ', ' + gone.withdrawn + ' withdrawn from the gallery' : '') +
    '. Signing out…', 'good');
  setTimeout(signOut, 1200);
});

async function signOut() {
  await fetch('/api/auth/sign-out', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => {});
  location.href = location.origin + '/';
}

function openAccount() {
  sheet.hidden = false;
  say('');
  disarmDelete();
  loadDevices();
  document.getElementById('sheet-close').focus();
}

document.getElementById('sheet-close').addEventListener('click', closeAccount);
document.getElementById('sheet-signout').addEventListener('click', signOut);
// The backdrop closes it; a click inside the card must not.
sheet.addEventListener('click', (event) => { if (event.target === sheet) closeAccount(); });
addEventListener('keydown', (event) => { if (event.key === 'Escape' && !sheet.hidden) closeAccount(); });

/* Nothing is mounted, fetched or shown until there is an account. requireAccount never resolves while
 * signed out, so everything below this line happens for somebody identifiable. */
const me = await requireAccount();

const badge = document.getElementById('account-badge');
if (badge) {
  const label = me.name || me.email || 'Signed in';
  badge.hidden = false;
  document.getElementById('side-name').textContent = label;
  document.getElementById('side-avatar').textContent = (label.trim()[0] || '?').toUpperCase();
  document.getElementById('side-plan').textContent = me.email && me.name ? me.email : 'View account';
  badge.title = 'Your account';
  badge.addEventListener('click', openAccount);
  document.getElementById('sheet-email').textContent = me.email || me.name || 'signed in';
}

show(viewFromHash());
fillRecent();
