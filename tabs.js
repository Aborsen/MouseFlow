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
import { requireAccount } from './gate.js';

const VIEWS = ['desktop', 'skills', 'gallery'];
const TITLES = { desktop: 'Desktop', skills: 'Skills', gallery: 'Gallery' };
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

/* "New flow" is not a fourth place - it is the Desktop console with the recorder in view. Making it
 * a separate view would leave two ways to reach one thing. */
document.getElementById('side-new').addEventListener('click', () => {
  location.hash = '#desktop';
  const recorder = document.getElementById('rec-idle');
  const card = (recorder && recorder.closest('.card')) || document.querySelector('#view-desktop .card');
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('is-called');
    setTimeout(() => card.classList.remove('is-called'), 1200);
  }
});

/* What you were working on, from the account rather than from this browser: the point of an account
 * is that the extension's flows and the desktop agent's flows are one list. */
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

  const stat = document.getElementById('side-stat');
  if (stat) {
    stat.hidden = false;
    document.getElementById('side-runs').textContent = String(runs.length);
  }

  if (!flows.length) return;
  const list = document.getElementById('side-recent-list');
  list.textContent = '';
  const recent = flows
    .slice()
    .sort((a, b) => String(b.updated || b.created || '').localeCompare(String(a.updated || a.created || '')))
    .slice(0, 12);

  for (const flow of recent) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = flow.name || 'Untitled';
    /* Which half made it, in one letter. A flow that points at page elements and one that points at
     * screen coordinates are not interchangeable, and the list is where that is decided. */
    const tag = document.createElement('span');
    tag.className = 'side-src';
    tag.textContent = flow.source === 'desktop' ? 'desktop' : 'web';
    button.appendChild(tag);
    button.title = (flow.name || 'Untitled') + ' \u2014 ' +
      (flow.source === 'desktop' ? 'recorded by the desktop agent' : 'recorded in the browser');
    button.addEventListener('click', () => { location.hash = '#skills'; });
    item.appendChild(button);
    list.appendChild(item);
  }
  document.getElementById('side-recent').hidden = false;
}

/* Nothing is mounted, fetched or shown until there is an account. requireAccount never resolves while
 * signed out, so everything below this line happens for somebody identifiable. */
const me = await requireAccount();

const badge = document.getElementById('account-badge');
if (badge) {
  const label = me.name || me.email || 'Signed in';
  badge.hidden = false;
  document.getElementById('side-name').textContent = label;
  document.getElementById('side-avatar').textContent = (label.trim()[0] || '?').toUpperCase();
  document.getElementById('side-plan').textContent = me.email && me.name ? me.email : 'Signed out with a click';
  badge.title = 'Signed in' + (me.email ? ' as ' + me.email : '') + ' — click to sign out';
  badge.addEventListener('click', async () => {
    await fetch('/api/auth/sign-out', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    location.href = location.origin + '/';
  });
}

show(viewFromHash());
fillRecent();
