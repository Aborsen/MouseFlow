/* The gallery, as something that can be mounted anywhere.
 *
 * It appears twice - as its own page, and as a tab in the app - so it is a module with a mount()
 * rather than a script that assumes it owns the document. Two copies of this logic would drift, and
 * the half that drifted would be the half nobody was looking at.
 *
 * Auth is same-origin: everything under /api/auth/* is proxied to Neon Auth (api/auth.js), so the
 * session cookie belongs to this site and the browser simply sends it. There is no token handling
 * here at all.
 */

const AUTH = '/api/auth';
const API = '/api/gallery';
const PARKED = 'mouseflow.pending';

const GOOGLE_MARK = `<svg viewBox="0 0 48 48" aria-hidden="true" width="17" height="17">
  <path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-4H24v8h12c-.2 2-1.5 5-4.7 7l6.4 5C41.4 36.2 45 30.7 45 24z"/>
  <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.4-5C30 37 27.3 38 24 38c-6 0-11-4-12.8-9.5l-6.7 5.2C8.1 41 15.4 46 24 46z"/>
  <path fill="#FBBC05" d="M11.2 28.5C10.7 27 10.4 25.5 10.4 24s.3-3 .8-4.5l-6.7-5.2C3 17.3 2 20.5 2 24s1 6.7 2.5 9.7l6.7-5.2z"/>
  <path fill="#EA4335" d="M24 10c3.4 0 6.4 1.2 8.8 3.4l5.7-5.7C34.9 4.4 29.9 2 24 2 15.4 2 8.1 7 4.5 14.3l6.7 5.2C13 14 18 10 24 10z"/>
</svg>`;

async function json(url, options) {
  const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, options));
  let body = null;
  try { body = await res.json(); } catch (_) { /* an empty body is still a status */ }
  return { ok: res.ok, status: res.status, body };
}

const reason = (body, status) =>
  (body && body.error && body.error.message) || (body && body.message) || 'HTTP ' + status;

const when = (iso) => {
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  return then.toLocaleDateString();
};

/* What the sign-in round trip reports back, since a redirect cannot say anything else. */
function signInOutcome() {
  const params = new URLSearchParams(location.search);
  const outcome = params.get('auth');
  if (!outcome) return null;
  history.replaceState(null, '', location.pathname + location.hash);
  if (outcome === 'ok') return null;
  return {
    'missing-verifier': 'Google came back without a verifier, so sign-in could not be completed.',
    'no-session-cookie': 'Sign-in was accepted but no session came back. Try again.',
    rejected: 'Neon Auth rejected the sign-in — the attempt may have expired. Try again.',
    unreachable: 'Could not reach the sign-in service to finish signing in.',
  }[outcome] || 'Sign-in did not complete (' + outcome + ').';
}

/* A skill on its way to being published.
 *
 * It arrives from the extension as #publish=<base64url>. It is read once and taken out of the address
 * bar, so a refresh does not offer to publish again and someone's flow does not sit in history. It
 * cannot ride through sign-in in the fragment - the callback is completed by a server and a fragment
 * never reaches one - so it is parked in sessionStorage, which is per-tab and per-origin: exactly the
 * scope of one sign-in. */
function takePending() {
  const match = location.hash.match(/[#&]publish=([^&]+)/);
  if (match) {
    history.replaceState(null, '', location.pathname + '#gallery');
    try {
      const base64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
      const text = new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
      const skill = JSON.parse(text);
      if (skill && skill.format === 'mouseflow.skill/1') return skill;
    } catch (_) {
      return null;
    }
    return null;
  }
  try {
    const parked = sessionStorage.getItem(PARKED);
    if (!parked) return null;
    sessionStorage.removeItem(PARKED);
    const skill = JSON.parse(parked);
    return skill && skill.format === 'mouseflow.skill/1' ? skill : null;
  } catch (_) {
    return null;
  }
}

export function mountGallery(root) {
  root.innerHTML = `
    <div class="g-head">
      <div>
        <h2 class="card-title">Skill gallery</h2>
        <p class="g-lede">
          Flows people have kept and shared. A <strong>recorded</strong> skill repeats a sequence of
          clicks exactly, for free. A <strong>created</strong> skill re-runs its goal through the
          agent, so it adapts and can take different details each time.
        </p>
      </div>
      <div class="g-account"></div>
    </div>
    <div class="g-publish"></div>
    <div class="g-status"></div>
    <input type="search" class="g-search" placeholder="Search skills…" autocomplete="off">
    <div class="g-list"><p class="empty">Loading…</p></div>
  `;

  const el = {
    account: root.querySelector('.g-account'),
    publish: root.querySelector('.g-publish'),
    status: root.querySelector('.g-status'),
    search: root.querySelector('.g-search'),
    list: root.querySelector('.g-list'),
  };

  let me = null;
  let pending = null;

  function say(text, kind) {
    el.status.innerHTML = '';
    if (!text) return;
    const note = document.createElement('div');
    note.className = 'g-note' + (kind ? ' g-note--' + kind : '');
    note.textContent = text;
    el.status.appendChild(note);
  }

  async function signIn() {
    const button = el.account.querySelector('button');
    if (button) { button.disabled = true; button.textContent = 'Opening Google…'; }
    if (pending) {
      try { sessionStorage.setItem(PARKED, JSON.stringify(pending)); } catch (_) {}
    }
    /* The callback lands on /api/auth/finish, not here: completing an OAuth sign-in means exchanging
     * a one-time verifier for a session cookie, which needs a server. It redirects back afterwards,
     * to this page and this tab. */
    const back = location.pathname + (location.pathname.endsWith('gallery.html') ? '' : '#gallery');
    const res = await json(AUTH + '/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'google',
        callbackURL: location.origin + '/api/auth/finish?to=' + encodeURIComponent(back),
      }),
    });
    if (res.body && res.body.url) { location.href = res.body.url; return; }
    say('Could not start sign-in: ' + reason(res.body, res.status), 'bad');
    renderAccount();
  }

  async function signOut() {
    await json(AUTH + '/sign-out', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    me = null;
    renderAccount();
    renderPublish();
    load();
  }

  function renderAccount() {
    el.account.innerHTML = '';
    if (!me) {
      const button = document.createElement('button');
      button.className = 'btn btn--google';
      button.innerHTML = GOOGLE_MARK + '<span>Sign in with Google</span>';
      button.addEventListener('click', signIn);
      el.account.appendChild(button);
      return;
    }
    const who = document.createElement('div');
    who.className = 'g-who';
    if (me.image) {
      const img = document.createElement('img');
      img.src = me.image;
      img.alt = '';
      who.appendChild(img);
    }
    who.appendChild(Object.assign(document.createElement('span'), {
      textContent: me.name || me.email || 'Signed in',
    }));
    const out = document.createElement('button');
    out.className = 'btn btn--ghost btn--sm';
    out.textContent = 'Sign out';
    out.addEventListener('click', signOut);
    who.appendChild(out);
    el.account.appendChild(who);
  }

  function renderPublish() {
    el.publish.innerHTML = '';
    if (!pending) return;

    const note = document.createElement('div');
    note.className = 'g-note';
    note.appendChild(Object.assign(document.createElement('strong'), {
      textContent: 'Ready to publish: ' + (pending.name || 'Untitled skill'),
    }));
    note.appendChild(Object.assign(document.createElement('div'), {
      className: 'muted',
      textContent: (pending.kind === 'created' ? 'created' : 'recorded') +
        (pending.description ? ' · ' + pending.description : ''),
    }));

    const row = document.createElement('div');
    row.className = 'g-row';

    if (!me) {
      row.appendChild(Object.assign(document.createElement('span'), {
        className: 'muted', textContent: 'Sign in to publish it.',
      }));
    } else {
      const go = document.createElement('button');
      go.className = 'btn btn--primary';
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
          renderPublish();
          say('Published. It is at the top of the list.', 'good');
          load();
          return;
        }
        say('Could not publish: ' + reason(res.body, res.status), 'bad');
        go.disabled = false;
        go.textContent = 'Publish to the gallery';
      });
      row.appendChild(go);
    }

    const drop = document.createElement('button');
    drop.className = 'btn btn--ghost';
    drop.textContent = 'Discard';
    drop.addEventListener('click', () => { pending = null; renderPublish(); say(''); });
    row.appendChild(drop);

    note.appendChild(row);
    el.publish.appendChild(note);
  }

  function card(skill) {
    const box = document.createElement('div');
    box.className = 'g-card';

    const head = document.createElement('h3');
    head.textContent = skill.name;
    const tag = document.createElement('span');
    tag.className = 'g-tag g-tag--' + skill.kind;
    tag.textContent = skill.kind;
    tag.title = skill.kind === 'created'
      ? 'Re-runs its goal through the agent: adapts, costs an API call per step'
      : 'Repeats exactly what was recorded: free, but breaks if the page changes';
    head.appendChild(tag);

    const foot = document.createElement('div');
    foot.className = 'g-foot';
    foot.appendChild(Object.assign(document.createElement('span'), {
      textContent: 'by ' + ((skill.author && skill.author.name) || 'someone') + ' · ' +
        when(skill.publishedAt) +
        (skill.installs ? ' · ' + skill.installs + (skill.installs === 1 ? ' install' : ' installs') : '') +
        (skill.params && skill.params.length
          ? ' · asks for ' + skill.params.map((p) => p.name).join(', ') : ''),
    }));
    foot.appendChild(Object.assign(document.createElement('span'), { className: 'g-spacer' }));

    const get = document.createElement('button');
    get.className = 'btn btn--sm';
    get.textContent = 'Copy to install';
    get.title = 'Copies the skill; in the extension use Skills → Paste one in';
    get.addEventListener('click', async () => {
      get.disabled = true;
      const res = await json(API + '?id=' + encodeURIComponent(skill.id));
      if (!res.ok || !res.body || !res.body.skill) {
        say('Could not fetch that skill: ' + reason(res.body, res.status), 'bad');
        get.disabled = false;
        return;
      }
      const text = JSON.stringify(res.body.skill.payload, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        say('Copied “' + skill.name + '”. In the extension: Skills → Paste one in.', 'good');
      } catch (_) {
        // The clipboard needs a permission the page may not have; show it rather than fail silently.
        const pre = document.createElement('pre');
        pre.textContent = text;
        box.appendChild(pre);
        say('The clipboard was blocked, so the skill is shown below — copy it by hand.', 'bad');
      }
      get.disabled = false;
    });
    foot.appendChild(get);

    if (skill.mine) {
      const pull = document.createElement('button');
      pull.className = 'btn btn--sm btn--ghost';
      pull.textContent = 'Withdraw';
      pull.addEventListener('click', async () => {
        const res = await json(API + '?id=' + encodeURIComponent(skill.id), { method: 'DELETE' });
        if (res.ok) { say('Withdrawn.', 'good'); load(); }
        else say(reason(res.body, res.status), 'bad');
      });
      foot.appendChild(pull);
    }

    box.append(head, Object.assign(document.createElement('p'), {
      textContent: skill.description || '',
    }), foot);
    return box;
  }

  async function load() {
    const term = el.search.value.trim();
    const res = await json(API + (term ? '?q=' + encodeURIComponent(term) : ''));
    el.list.innerHTML = '';

    if (!res.ok) {
      el.list.appendChild(Object.assign(document.createElement('p'), {
        className: 'empty', textContent: 'The gallery is not answering: ' + reason(res.body, res.status),
      }));
      return;
    }

    const skills = (res.body && res.body.skills) || [];
    // Which are the signed-in user's, so Withdraw is only offered where it would work.
    if (me) {
      const own = await json(API + '?mine=1');
      const ids = new Set(((own.body && own.body.skills) || []).map((s) => s.id));
      for (const s of skills) s.mine = ids.has(s.id);
    }

    if (!skills.length) {
      el.list.appendChild(Object.assign(document.createElement('p'), {
        className: 'empty',
        textContent: term
          ? 'Nothing matches “' + term + '”.'
          : 'No skills published yet. Save one in the extension, then press Publish.',
      }));
      return;
    }
    for (const skill of skills) el.list.appendChild(card(skill));
  }

  let timer = null;
  el.search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 220);
  });

  (async () => {
    const failed = signInOutcome();
    pending = takePending();
    try {
      const res = await json(AUTH + '/get-session');
      // Better Auth answers null - not an error - when nobody is signed in.
      me = res.ok && res.body && res.body.user ? res.body.user : null;
    } catch (_) {
      say('Could not reach the sign-in service.', 'bad');
    }
    renderAccount();
    renderPublish();
    if (failed) say(failed, 'bad');
    await load();
  })();

  return { reload: load };
}
