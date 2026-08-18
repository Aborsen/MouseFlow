/* The gallery page: sign in, browse, install, publish.
 *
 * Auth is same-origin — everything under /api/auth/* is proxied to Neon Auth (see
 * api/auth/[...path].js), so the session cookie belongs to this site and the browser simply sends
 * it. That means no token handling here at all: `credentials: 'same-origin'` is the whole of it.
 *
 * Publishing from the extension arrives as a URL fragment. A fragment never leaves the browser, so
 * a skill on its way to being published is not sitting in a server log somewhere, and the extension
 * needs no session of its own.
 */

'use strict';

const $ = (id) => document.getElementById(id);
const AUTH = '/api/auth';
const API = '/api/gallery';

let me = null;
let pending = null;      // a skill handed over by the extension, waiting on sign-in

/* ------------------------------------------------------------------- plumbing */

async function json(url, options) {
  const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, options));
  let body = null;
  try { body = await res.json(); } catch (_) { /* an empty or non-JSON body is still a status */ }
  return { ok: res.ok, status: res.status, body };
}

function say(text, kind) {
  const box = $('status');
  if (!text) { box.textContent = ''; return; }
  box.innerHTML = '';
  const note = document.createElement('div');
  note.className = 'note' + (kind ? ' ' + kind : '');
  note.textContent = text;
  box.appendChild(note);
}

const when = (iso) => {
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  return then.toLocaleDateString();
};

/* ----------------------------------------------------------------------- auth */

const GOOGLE_MARK = `<svg viewBox="0 0 48 48" aria-hidden="true">
  <path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-4H24v8h12c-.2 2-1.5 5-4.7 7l6.4 5C41.4 36.2 45 30.7 45 24z"/>
  <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.4-5C30 37 27.3 38 24 38c-6 0-11-4-12.8-9.5l-6.7 5.2C8.1 41 15.4 46 24 46z"/>
  <path fill="#FBBC05" d="M11.2 28.5C10.7 27 10.4 25.5 10.4 24s.3-3 .8-4.5l-6.7-5.2C3 17.3 2 20.5 2 24s1 6.7 2.5 9.7l6.7-5.2z"/>
  <path fill="#EA4335" d="M24 10c3.4 0 6.4 1.2 8.8 3.4l5.7-5.7C34.9 4.4 29.9 2 24 2 15.4 2 8.1 7 4.5 14.3l6.7 5.2C13 14 18 10 24 10z"/>
</svg>`;

async function whoAmI() {
  const res = await json(AUTH + '/get-session');
  // Better Auth answers null - not an error - when nobody is signed in.
  return res.ok && res.body && res.body.user ? res.body.user : null;
}

async function signIn() {
  const button = $('signin');
  if (button) { button.disabled = true; button.textContent = 'Opening Google…'; }

  /* A skill waiting to be published cannot travel through the sign-in round trip in the URL: the
   * callback is completed by a server, and a fragment is never sent to one. So it is parked here and
   * picked up on the way back. sessionStorage is per-tab and per-origin, which is exactly the scope
   * of one sign-in. */
  if (pending) {
    try { sessionStorage.setItem('mouseflow.pending', JSON.stringify(pending)); } catch (_) {}
  }

  /* The callback lands on /api/auth/finish, not on this page. Completing an OAuth sign-in means
   * exchanging a one-time verifier for a session cookie, and only a server can do that - see
   * api/auth.js. It sends the browser back here afterwards. */
  const res = await json(AUTH + '/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'google',
      callbackURL: location.origin + '/api/auth/finish?to=' +
        encodeURIComponent(location.pathname),
    }),
  });

  if (res.body && res.body.url) { location.href = res.body.url; return; }

  const why = (res.body && (res.body.message || res.body.code)) || 'HTTP ' + res.status;
  say('Could not start sign-in: ' + why +
    (String(why).includes('CALLBACK') ? '. This origin is not trusted by Neon Auth yet — run ' +
      'scripts/auth-origin.mjs with it.' : ''), 'bad');
  if (button) { button.disabled = false; button.textContent = 'Sign in with Google'; }
}

async function signOut() {
  await json(AUTH + '/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  location.href = location.origin + location.pathname;
}

function renderAccount() {
  const box = $('account');
  box.innerHTML = '';
  if (!me) {
    const button = document.createElement('button');
    button.id = 'signin';
    button.className = 'google';
    button.innerHTML = GOOGLE_MARK + '<span>Sign in with Google</span>';
    button.addEventListener('click', signIn);
    box.appendChild(button);
    return;
  }

  const who = document.createElement('div');
  who.className = 'who';
  if (me.image) {
    const img = document.createElement('img');
    img.src = me.image;
    img.alt = '';
    who.appendChild(img);
  }
  const name = document.createElement('span');
  name.textContent = me.name || me.email || 'Signed in';
  const out = document.createElement('button');
  out.textContent = 'Sign out';
  out.addEventListener('click', signOut);
  who.append(name, out);
  box.appendChild(who);
}

/* -------------------------------------------------------------------- publish */

/* A skill arrives from the extension as #publish=<base64url of the skill JSON>.
 *
 * Read once and removed from the address bar immediately: leaving it there means a refresh offers to
 * publish again, and it keeps someone's flow out of the browser history. */
function takePendingFromUrl() {
  const match = location.hash.match(/[#&]publish=([^&]+)/);
  if (!match) {
    // Coming back from sign-in: the skill was parked before leaving, because a fragment cannot
    // survive a server-side redirect.
    try {
      const parked = sessionStorage.getItem('mouseflow.pending');
      if (parked) {
        sessionStorage.removeItem('mouseflow.pending');
        const skill = JSON.parse(parked);
        if (skill && skill.format === 'mouseflow.skill/1') return skill;
      }
    } catch (_) {
      // nothing parked, or storage unavailable
    }
    return null;
  }
  history.replaceState(null, '', location.origin + location.pathname);
  try {
    const base64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const text = new TextDecoder().decode(
      Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    );
    const skill = JSON.parse(text);
    if (skill && skill.format === 'mouseflow.skill/1') return skill;
    say('That link carried something that is not a MouseFlow skill.', 'bad');
  } catch (_) {
    say('That link could not be read. Try Publish again from the extension.', 'bad');
  }
  return null;
}

function renderPublishBox() {
  const box = $('publish-box');
  box.innerHTML = '';
  if (!pending) return;

  const note = document.createElement('div');
  note.className = 'note';
  const title = document.createElement('strong');
  title.textContent = 'Ready to publish: ' + (pending.name || 'Untitled skill');
  const detail = document.createElement('div');
  detail.className = 'muted';
  detail.textContent = (pending.kind === 'created' ? 'created' : 'recorded') +
    (pending.description ? ' · ' + pending.description : '');
  note.append(title, detail);

  const row = document.createElement('div');
  row.style.marginTop = '11px';
  row.style.display = 'flex';
  row.style.gap = '8px';
  row.style.flexWrap = 'wrap';

  if (!me) {
    const hint = document.createElement('span');
    hint.className = 'muted';
    hint.textContent = 'Sign in to publish it.';
    row.appendChild(hint);
  } else {
    const go = document.createElement('button');
    go.className = 'primary';
    go.textContent = 'Publish to the gallery';
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = 'Publishing…';
      const res = await json(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skill: pending }),
      });
      if (res.status === 201) {
        pending = null;
        renderPublishBox();
        say('Published. It is at the top of the list.', 'good');
        load();
        return;
      }
      const why = (res.body && res.body.error && res.body.error.message) || 'HTTP ' + res.status;
      say('Could not publish: ' + why, 'bad');
      go.disabled = false;
      go.textContent = 'Publish to the gallery';
    });
    row.appendChild(go);
  }

  const drop = document.createElement('button');
  drop.textContent = 'Discard';
  drop.addEventListener('click', () => { pending = null; renderPublishBox(); say(''); });
  row.appendChild(drop);

  note.appendChild(row);
  box.appendChild(note);
}

/* --------------------------------------------------------------------- browse */

function card(skill) {
  const el = document.createElement('div');
  el.className = 'card';

  const head = document.createElement('h2');
  head.textContent = skill.name;
  const tag = document.createElement('span');
  tag.className = 'tag tag-' + skill.kind;
  tag.textContent = skill.kind;
  tag.style.marginLeft = '8px';
  tag.title = skill.kind === 'created'
    ? 'Re-runs its goal through the agent: adapts, costs an API call per step'
    : 'Repeats exactly what was recorded: free, but breaks if the page changes';
  head.appendChild(tag);

  const body = document.createElement('p');
  body.textContent = skill.description || '';

  const foot = document.createElement('footer');
  const by = document.createElement('span');
  by.textContent = 'by ' + (skill.author && skill.author.name ? skill.author.name : 'someone') +
    ' · ' + when(skill.publishedAt) +
    (skill.installs ? ' · ' + skill.installs + (skill.installs === 1 ? ' install' : ' installs') : '');
  foot.appendChild(by);

  if (skill.params && skill.params.length) {
    const asks = document.createElement('span');
    asks.textContent = '· asks for ' + skill.params.map((p) => p.name).join(', ');
    foot.appendChild(asks);
  }

  foot.appendChild(Object.assign(document.createElement('span'), { className: 'spacer' }));

  const get = document.createElement('button');
  get.textContent = 'Copy to install';
  get.title = 'Copies the skill; paste it into the extension under Skills';
  get.addEventListener('click', async () => {
    get.disabled = true;
    const res = await json(API + '?id=' + encodeURIComponent(skill.id));
    if (!res.ok || !res.body || !res.body.skill) {
      say('Could not fetch that skill: ' +
        ((res.body && res.body.error && res.body.error.message) || 'HTTP ' + res.status), 'bad');
      get.disabled = false;
      return;
    }
    const text = JSON.stringify(res.body.skill.payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      say('Copied “' + skill.name + '”. In the extension: Skills → Paste one in.', 'good');
    } catch (_) {
      // Clipboard needs a permission the page may not have; show it instead of failing silently.
      const pre = document.createElement('pre');
      pre.textContent = text;
      el.appendChild(pre);
      say('Clipboard was blocked, so the skill is shown below — copy it by hand.', 'bad');
    }
    get.disabled = false;
    get.textContent = 'Copy to install';
  });
  foot.appendChild(get);

  if (me && skill.author && skill.mine) {
    const pull = document.createElement('button');
    pull.textContent = 'Withdraw';
    pull.addEventListener('click', async () => {
      const res = await json(API + '?id=' + encodeURIComponent(skill.id), { method: 'DELETE' });
      if (res.ok) { say('Withdrawn.', 'good'); load(); }
      else say((res.body && res.body.error && res.body.error.message) || 'could not withdraw', 'bad');
    });
    foot.appendChild(pull);
  }

  el.append(head, body, foot);
  return el;
}

async function load() {
  const term = $('search').value.trim();
  const res = await json(API + (term ? '?q=' + encodeURIComponent(term) : ''));
  const list = $('list');
  list.innerHTML = '';

  if (!res.ok) {
    const why = (res.body && res.body.error && res.body.error.message) || 'HTTP ' + res.status;
    list.innerHTML = '<p class="empty">The gallery is not answering: ' + why + '</p>';
    return;
  }

  const skills = (res.body && res.body.skills) || [];
  // Which of these are the signed-in user's, so Withdraw can be offered on those only.
  if (me) {
    const own = await json(API + '?mine=1');
    const ids = new Set(((own.body && own.body.skills) || []).map((s) => s.id));
    for (const s of skills) s.mine = ids.has(s.id);
  }

  if (!skills.length) {
    list.innerHTML = term
      ? '<p class="empty">Nothing matches “' + term.replace(/[<>&]/g, '') + '”.</p>'
      : '<p class="empty">No skills published yet. Save one in the extension, then press Publish.</p>';
    return;
  }
  for (const skill of skills) list.appendChild(card(skill));
}

/* ----------------------------------------------------------------------- boot */

let searchTimer = null;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(load, 220);
});

/* What the sign-in round trip reports back, since a redirect cannot say anything else.
 * Cleared from the address bar so a refresh does not repeat the message. */
function readSignInOutcome() {
  const params = new URLSearchParams(location.search);
  const outcome = params.get('auth');
  if (!outcome) return;
  history.replaceState(null, '', location.origin + location.pathname);
  if (outcome === 'ok') return;
  const why = {
    'missing-verifier': 'Google came back without a verifier, so the sign-in could not be completed.',
    'no-session-cookie': 'The sign-in was accepted but no session came back. Try again.',
    rejected: 'Neon Auth rejected the sign-in. The session may have expired - try again.',
    unreachable: 'Could not reach the sign-in service to finish signing in.',
  }[outcome] || 'Sign-in did not complete (' + outcome + ').';
  say(why, 'bad');
}

(async () => {
  readSignInOutcome();
  pending = takePendingFromUrl();
  try {
    me = await whoAmI();
  } catch (_) {
    say('Could not reach the sign-in service.', 'bad');
  }
  renderAccount();
  renderPublishBox();
  await load();
})();
