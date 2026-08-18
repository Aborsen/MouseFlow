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

const VIEWS = ['desktop', 'skills', 'gallery'];
const mounted = {};

function viewFromHash() {
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
  mount(view);
}

for (const tab of document.querySelectorAll('#tabs .tab')) {
  tab.addEventListener('click', () => {
    // Through the hash rather than directly, so the address bar and the view cannot disagree.
    location.hash = '#' + tab.dataset.view;
  });
}

addEventListener('hashchange', () => show(viewFromHash()));
show(viewFromHash());
