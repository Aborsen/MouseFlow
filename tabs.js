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

/* Four places, named after what you do in them.
 *
 * "Desktop" described the machinery rather than the task, and the page underneath it had four jobs -
 * recording, the start command, the recordings, the flow - which is why it read as clutter. Recording is
 * what that page is for; the setup and the command moved behind the agent pill.
 */
/* Four in the sidebar, five that exist. `connect` is setup rather than a place you work, so it is
 * reachable and not listed: from the account panel, from the status pill, and by pressing Record with no
 * agent running - which is the moment anyone actually needs it. */
const VIEWS = ['record', 'create', 'skills', 'gallery', 'connect'];
const TITLES = {
  record: 'Record', create: 'Create the flow', skills: 'Skills', gallery: 'Gallery',
  connect: 'Connections',
};
// #desktop is what every link and bookmark in this project used to say. Kept as an alias, not a view.
const ALIASES = { desktop: 'record' };
const mounted = {};

function viewFromHash() {
  // The extension's sign-in button lands here; the account panel it needs is in Skills.
  if (new URLSearchParams(location.search).get('pair') === 'extension' && !location.hash) return 'skills';
  const hash = location.hash.replace(/^#/, '');
  // A skill arriving from the extension carries #publish=…, which means the gallery.
  if (hash.startsWith('publish=')) return 'gallery';
  const name = hash.split(/[?&]/)[0];
  if (ALIASES[name]) return ALIASES[name];
  return VIEWS.includes(name) ? name : 'record';
}

function mount(view) {
  if (mounted[view]) return;
  if (view === 'gallery') mounted.gallery = mountGallery(document.getElementById('gallery-root'));
  if (view === 'skills') mounted.skills = mountSkills(document.getElementById('skills-root'));
  if (view === 'create') mounted.create = mountCreate(document.getElementById('create-root'));
  // Record is rendered by app.js on load; there is nothing to mount.
  if (view === 'record') mounted.record = true;
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
  // The sidebar took the brand, so the top bar says where you are.
  const title = document.getElementById('topbar-title');
  if (title) title.textContent = TITLES[view] || 'MouseFlow';
  mount(view);
  /* Mounting happens once; arriving happens repeatedly. A view that depends on something outside the
   * page - Create needs an extension or a local agent - has to look again rather than show what was
   * true the first time it was opened. */
  if (view === 'create' && mounted.create && typeof mounted.create.reload === 'function') {
    mounted.create.reload();
  }
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


/* The footer's numbers come from fillHours now - the account's runs, measured in the unit the sidebar
 * shows. This is kept as its name because tabs.js calls it once on load, and because a count that nothing
 * displays is a request nobody needs. */
async function fillRunCount() {
  return fillHours();
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

/* One dialog, several screens, as in Insightis: a nav down the left and a pane on the right. Settings
 * that used to be one long scroll is now Account, Connections and Hours - which is also the answer to
 * "where is the connection page in the menu": it is here, in the menu everything else lives in.
 *
 * The screen is part of the URL, so a link can open the dialog on the right page and a refresh does not
 * lose your place. */
const SCREENS = { account: 'My account', connections: 'Connections', hours: 'Hours' };

function showScreen(name) {
  const screen = SCREENS[name] ? name : 'account';
  for (const pane of document.querySelectorAll('.sheet-screen')) {
    pane.hidden = pane.dataset.screen !== screen;
  }
  for (const item of document.querySelectorAll('.sheet-nav-item[data-screen]')) {
    item.classList.toggle('is-on', item.dataset.screen === screen);
  }
  document.getElementById('sheet-title').textContent = SCREENS[screen];
  say('');
  if (screen === 'connections') fillConnections();
  if (screen === 'hours') fillHours();
}

for (const item of document.querySelectorAll('.sheet-nav-item[data-screen]')) {
  item.addEventListener('click', () => showScreen(item.dataset.screen));
}

/* ---- Connections: the state of the agent, and the command that changes it ---- */

function fillConnections() {
  /* Read from the console's own state rather than asking again: app.js polls /health every couple of
   * seconds and puts the answer in the pill, so the dialog can just agree with it - one source of truth
   * about whether the agent is up, and no second poll running behind a modal. */
  const label = document.getElementById('agent-label');
  const pill = document.getElementById('agent-pill');
  const online = pill && pill.classList.contains('pill--ok');
  const stale = pill && pill.classList.contains('pill--warn');

  document.getElementById('sheet-agent-label').textContent = label ? label.textContent : 'Agent offline';
  const dot = document.getElementById('sheet-agent-pill');
  dot.classList.toggle('pill--ok', online && !stale);
  dot.classList.toggle('pill--warn', !!stale);
  dot.classList.toggle('pill--bad', !online);

  document.getElementById('sheet-agent-state').textContent = stale
    ? 'Running, but older than this app expects — the command below fetches the current one.'
    : (online
      ? 'Running on this computer and answering. To stop it, close its PowerShell window.'
      : 'Not running. Nothing on this page can start it for you, so paste the command below.');

  // The command itself is built by app.js, which owns the port and the origin.
  const code = document.querySelector('#start-command code');
  document.getElementById('sheet-command').textContent = code ? code.textContent : '';
}

document.getElementById('sheet-copy-command').addEventListener('click', async () => {
  const text = document.getElementById('sheet-command').textContent;
  try {
    await navigator.clipboard.writeText(text);
    say('Copied — paste it into PowerShell.', 'good');
  } catch (_) {
    say('The clipboard was blocked. Select the command and copy it.', 'bad');
  }
});

document.getElementById('sheet-open-guide').addEventListener('click', () => {
  closeAccount();
  location.hash = '#connect';
});

/* ---- Hours: their Balance screen, in the unit that means something here ----
 *
 * Insightis counts credits, because a question costs tokens. This counts hours, because a flow costs
 * time it would otherwise have cost you - and the number is measured, not estimated: every run on the
 * account has a start and a finish.
 */
let hoursCache = null;

function hoursOf(run) {
  if (!run.startedAt || !run.finishedAt) return 0;
  const ms = new Date(run.finishedAt) - new Date(run.startedAt);
  // A negative or absurd span means clocks disagreed across machines; it is not worth propagating.
  return ms > 0 && ms < 12 * 3600 * 1000 ? ms / 3600000 : 0;
}

async function fillHours() {
  if (!hoursCache) {
    try {
      const res = await fetch('/api/sync', { credentials: 'same-origin' });
      hoursCache = res.ok ? await res.json() : { flows: [], runs: [] };
    } catch (_) {
      hoursCache = { flows: [], runs: [] };
    }
  }

  const runs = (hoursCache.runs || []).filter((r) => hoursOf(r) > 0);
  const flows = hoursCache.flows || [];
  const total = runs.reduce((sum, r) => sum + hoursOf(r), 0);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const month = runs
    .filter((r) => new Date(r.startedAt) >= monthStart)
    .reduce((sum, r) => sum + hoursOf(r), 0);

  const fmt = (h) => (h >= 10 ? h.toFixed(0) : h.toFixed(1));
  document.getElementById('hours-total').textContent = fmt(total);
  document.getElementById('hours-month').textContent = fmt(month);
  document.getElementById('hours-runs').textContent = String((hoursCache.runs || []).length);
  document.getElementById('hours-flows').textContent = String(flows.length);

  const oldest = runs.length ? runs[runs.length - 1].startedAt : null;
  document.getElementById('hours-since').textContent = oldest
    ? 'since ' + new Date(oldest).toLocaleDateString() : '';

  const body = document.getElementById('hours-rows');
  body.textContent = '';
  const rows = runs.slice(0, 12);
  document.getElementById('hours-empty').hidden = rows.length > 0;

  for (const run of rows) {
    const tr = document.createElement('tr');
    const what = run.kind === 'replay'
      ? 'Replay'
      : (run.goal ? run.goal.slice(0, 48) + (run.goal.length > 48 ? '…' : '') : 'Created flow');
    tr.append(
      Object.assign(document.createElement('td'), {
        textContent: new Date(run.startedAt).toLocaleDateString(undefined,
          { year: 'numeric', month: 'short', day: 'numeric' }),
      }),
      Object.assign(document.createElement('td'), { className: 'hours-what', textContent: what }),
      Object.assign(document.createElement('td'), {
        className: 'hours-num', textContent: hoursOf(run).toFixed(2),
      }),
    );
    body.appendChild(tr);
  }

  // The sidebar row says the same number the screen does.
  const meter = document.getElementById('side-hours');
  if (meter) {
    meter.hidden = false;
    document.getElementById('side-hours-value').textContent = fmt(total) + ' h';
  }
}

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

function openAccount(screen) {
  sheet.hidden = false;
  disarmDelete();
  loadDevices();
  showScreen(screen || 'account');
  document.getElementById('sheet-close').focus();
}

document.getElementById('sheet-close').addEventListener('click', closeAccount);
// The balance row opens the screen it summarises, exactly as it does in Insightis.
document.getElementById('side-hours').addEventListener('click', () => openAccount('hours'));
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
  document.getElementById('side-plan').textContent = me.email || 'View account';
  badge.title = 'Your account';
  badge.addEventListener('click', openAccount);
  document.getElementById('sheet-email').textContent = me.email || me.name || 'signed in';
}

show(viewFromHash());
fillRunCount();
// The meter is part of the furniture, so it is filled without waiting for the dialog to be opened.
fillHours();
