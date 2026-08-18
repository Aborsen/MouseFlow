/* Skills, on the web.
 *
 * A skill is made in the extension, which is where the browser is driven from. This tab is where you
 * keep, read and pass them around from a full window rather than a 320px popup: paste one in, look at
 * what it actually does, copy it out, send it to the gallery.
 *
 * Two sources, kept visibly apart:
 *
 *   the account   flows synced from the extension and from the desktop agent. Each carries the half
 *                 that made it, because that decides what can run it: a `web` flow points at page
 *                 elements and only the extension can replay it, a `desktop` flow points at screen
 *                 coordinates and only the agent can.
 *
 *   this page     anything pasted in directly. Local storage for this site, nothing more.
 *
 * A page and an extension cannot see each other's storage - a browser guarantee, not an oversight -
 * so the account is the only place the two halves meet.
 */

const STORE = 'mouseflow.skills';

function read() {
  try {
    const raw = localStorage.getItem(STORE);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function write(list) {
  try { localStorage.setItem(STORE, JSON.stringify(list.slice(0, 200))); } catch (_) {}
}

/* Anything pasted in is untrusted, so it is rebuilt field by field rather than merged - the same rule
 * the extension applies, for the same reason: a skill must not be able to introduce keys that the
 * code around it will later act on. */
function accept(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch (_) {
    throw new Error('That is not a skill — it is not valid JSON.');
  }
  const list = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed && parsed.skills) ? parsed.skills
    : [parsed];

  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.format !== 'mouseflow.skill/1') {
      throw new Error('Unrecognised skill format' + (raw.format ? ' "' + raw.format + '"' : '') + '.');
    }
    const kind = raw.kind === 'created' ? 'created' : 'recorded';
    const skill = {
      format: 'mouseflow.skill/1',
      id: Math.random().toString(36).slice(2, 10),
      kind,
      name: String(raw.name || 'Imported skill').slice(0, 80),
      description: String(raw.description || '').slice(0, 400),
      created: typeof raw.created === 'string' ? raw.created : null,
      origins: Array.isArray(raw.origins) ? raw.origins.filter((o) => typeof o === 'string') : [],
      params: Array.isArray(raw.params)
        ? raw.params
          .filter((p) => p && typeof p.name === 'string' && /^[a-zA-Z][\w]{0,30}$/.test(p.name))
          .slice(0, 12)
          .map((p) => ({
            name: p.name,
            type: ['email', 'url', 'quoted', 'text'].includes(p.type) ? p.type : 'text',
            example: p.example == null ? '' : String(p.example).slice(0, 200),
          }))
        : [],
    };
    if (kind === 'recorded') {
      if (!Array.isArray(raw.events) || !raw.events.length) {
        throw new Error('“' + skill.name + '” is a recorded skill with no steps in it.');
      }
      skill.events = raw.events;
      skill.tabs = Number(raw.tabs) > 0 ? Number(raw.tabs) : 1;
    } else {
      const goal = String(raw.goalTemplate || raw.goal || '').trim();
      if (!goal) throw new Error('“' + skill.name + '” is a created skill with no goal in it.');
      skill.goalTemplate = goal;
      skill.steps = Array.isArray(raw.steps) ? raw.steps.slice(0, 200) : [];
    }
    out.push(skill);
  }
  if (!out.length) throw new Error('No skills found in that.');
  return out;
}

export function mountSkills(root) {
  root.innerHTML = `
    <div class="g-head">
      <div>
        <h2 class="card-title">Skills</h2>
        <p class="g-lede">
          Your flows from both halves — the extension and the desktop agent. A skill is made in one of
          them; this is where you read one properly, pass it on, or paste one in.
        </p>
      </div>
      <div class="g-row s-tools">
        <button class="btn btn--sm s-paste" type="button">Paste one in</button>
        <button class="btn btn--sm btn--ghost s-copy" type="button">Copy all</button>
      </div>
    </div>
    <div class="s-account"></div>
    <textarea class="s-box" placeholder="Paste a skill here, then press Add" hidden></textarea>
    <div class="g-row s-boxrow" hidden>
      <button class="btn btn--primary btn--sm s-add" type="button">Add</button>
      <button class="btn btn--ghost btn--sm s-cancel" type="button">Cancel</button>
    </div>
    <div class="g-status s-status"></div>
    <div class="s-list"></div>
  `;

  const el = {
    account: root.querySelector('.s-account'),
    paste: root.querySelector('.s-paste'),
    copy: root.querySelector('.s-copy'),
    box: root.querySelector('.s-box'),
    boxrow: root.querySelector('.s-boxrow'),
    add: root.querySelector('.s-add'),
    cancel: root.querySelector('.s-cancel'),
    status: root.querySelector('.s-status'),
    list: root.querySelector('.s-list'),
  };

  function say(text, kind) {
    el.status.innerHTML = '';
    if (!text) return;
    el.status.appendChild(Object.assign(document.createElement('div'), {
      className: 'g-note' + (kind ? ' g-note--' + kind : ''),
      textContent: text,
    }));
  }

  function showBox(on) {
    el.box.hidden = !on;
    el.boxrow.hidden = !on;
    if (on) el.box.focus();
  }

  el.paste.addEventListener('click', () => { showBox(true); say(''); });
  el.cancel.addEventListener('click', () => { el.box.value = ''; showBox(false); });

  el.add.addEventListener('click', () => {
    try {
      const incoming = accept(el.box.value);
      write(incoming.concat(read()));
      el.box.value = '';
      showBox(false);
      say('Added ' + incoming.length + (incoming.length === 1 ? ' skill.' : ' skills.'), 'good');
      render();
    } catch (err) {
      say(err.message, 'bad');
    }
  });

  el.copy.addEventListener('click', async () => {
    const all = read();
    if (!all.length) { say('There is nothing here to copy yet.', 'bad'); return; }
    const text = JSON.stringify({ format: 'mouseflow.skill/1', exported: all.length, skills: all }, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      say('Copied ' + all.length + (all.length === 1 ? ' skill.' : ' skills.'), 'good');
    } catch (_) {
      say('The clipboard was blocked. Open one and use Copy on it instead.', 'bad');
    }
  });

  /* ------------------------------------------------------------------ the extension handover
   *
   * An extension cannot sign in with Google - that needs an OAuth client tied to its id, and an
   * unpacked extension's id comes from its folder path. This page CAN, so it does the signing in and
   * hands the extension a device token minted for this account. extension/bridge.js is the other
   * end: a content script that runs only on this origin.
   *
   * Detection is two-way on purpose. Either side may load first, so both announce and both ask.
   */
  const bridge = { present: false, version: null, paired: false, who: null };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.mf !== 'mouseflow:extension') return;
    bridge.present = true;
    bridge.version = data.version || null;
    bridge.paired = !!data.paired;
    bridge.who = data.who || null;
    renderAccount();
  });
  window.postMessage({ mf: 'mouseflow:hello?' }, location.origin);

  /* Push a token across and wait for the extension to say whether it took. Resolves to null if
   * nothing answers, which is the case the manual paste exists for. */
  function handover(token) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { window.removeEventListener('message', onDone); resolve(null); }, 4000);
      function onDone(event) {
        if (event.source !== window || event.origin !== location.origin) return;
        if (!event.data || event.data.mf !== 'mouseflow:paired') return;
        clearTimeout(timer);
        window.removeEventListener('message', onDone);
        resolve(event.data);
      }
      window.addEventListener('message', onDone);
      window.postMessage({ mf: 'mouseflow:pair', token }, location.origin);
    });
  }

  /* What the account holds. Auth is same-origin (api/auth.js), so this is a plain request carrying the
   * cookie - there is no token handling on this side at all. */
  let me = null;
  let remote = { flows: [], runs: [] };
  /* "The extension sent me here": set by background.js when its sign-in button opens this page. */
  const WANTS_PAIR = new URLSearchParams(location.search).get('pair') === 'extension';
  let autoTried = false;
  let autoRan = false;

  async function api(url, options) {
    const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, options));
    let body = null;
    try { body = await res.json(); } catch (_) { /* a status is still an answer */ }
    return { ok: res.ok, status: res.status, body };
  }

  async function loadAccount() {
    const session = await api('/api/auth/get-session');
    me = session.ok && session.body && session.body.user ? session.body.user : null;
    if (me) {
      const sync = await api('/api/sync');
      remote = sync.ok && sync.body
        ? { flows: sync.body.flows || [], runs: sync.body.runs || [] }
        : { flows: [], runs: [] };
    } else {
      remote = { flows: [], runs: [] };
    }
    renderAccount();
    render();
  }

  function renderAccount() {
    el.account.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'g-note';

    if (!me) {
      note.append(
        Object.assign(document.createElement('strong'), { textContent: 'Not signed in' }),
        Object.assign(document.createElement('div'), {
          className: 'muted',
          textContent: 'Sign in to see the flows on your account and to connect the extension.',
        }),
      );
      el.account.appendChild(note);
      return;
    }

    const web = remote.flows.filter((f) => f.source === 'web').length;
    const desk = remote.flows.filter((f) => f.source === 'desktop').length;
    note.append(
      Object.assign(document.createElement('strong'), {
        textContent: 'Signed in as ' + (me.name || me.email),
      }),
      Object.assign(document.createElement('div'), {
        className: 'muted',
        textContent: remote.flows.length
          ? web + ' from the extension, ' + desk + ' from the desktop agent, ' +
            remote.runs.length + ' run' + (remote.runs.length === 1 ? '' : 's') + ' logged'
          : 'Nothing synced yet. Connect the extension below, then press Sync now in it.',
      }),
    );

    /* Arriving from the extension's sign-in button. The click that started this was made in the
     * extension, and a Google sign-in has just been completed, so there is nothing left to confirm -
     * connect it and say so. Only when the extension says it is not already attached, so reopening
     * this page does not mint a token every time. */
    if (WANTS_PAIR && bridge.present && !bridge.paired && !autoTried) {
      autoTried = true;
      note.appendChild(Object.assign(document.createElement('div'), {
        className: 'muted', textContent: 'Connecting your extension\u2026',
      }));
    }

    if (bridge.present) {
      note.appendChild(Object.assign(document.createElement('div'), {
        className: 'muted',
        textContent: bridge.paired
          ? 'The extension in this browser is connected' +
            (bridge.version ? ' (v' + bridge.version + ')' : '') + '.'
          : 'The extension is installed in this browser but not connected yet.',
      }));
    }

    const row = document.createElement('div');
    row.className = 'g-row';

    /* Minting shows the token exactly once, because only its hash is stored. Saying so matters: a
     * value that cannot be shown again is worth copying now rather than later. */
    const pair = document.createElement('button');
    pair.className = 'btn btn--sm';
    pair.textContent = bridge.present && !bridge.paired
      ? 'Connect this browser\u2019s extension'
      : 'Connect an extension';
    pair.addEventListener('click', () => connect(pair));

    async function connect(button) {
      button.disabled = true;
      const res = await api('/api/sync?issue=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: bridge.present ? 'Chrome extension' : 'Device' }),
      });
      button.disabled = false;
      if (res.status !== 201 || !res.body || !res.body.token) {
        say((res.body && res.body.error && res.body.error.message) || 'could not create a token', 'bad');
        return;
      }

      /* With the extension present the token never has to be seen, let alone copied: it goes
       * straight across and the user is done. It is only printed when nothing answered. */
      if (bridge.present) {
        const done = await handover(res.body.token);
        if (done && done.ok) {
          bridge.paired = true;
          say('The extension is connected' +
            (done.who && done.who.name ? ' as ' + done.who.name : '') + '.', 'good');
          loadAccount();
          return;
        }
        say((done && done.error) || 'the extension did not answer - paste the token in by hand', 'bad');
      }

      const box = document.createElement('div');
      box.className = 'g-note g-note--good';
      box.appendChild(Object.assign(document.createElement('strong'), {
        textContent: 'Paste this into the extension, under Skills - Account',
      }));
      box.appendChild(Object.assign(document.createElement('pre'), { textContent: res.body.token }));
      box.appendChild(Object.assign(document.createElement('div'), {
        className: 'muted',
        textContent: 'Shown once - only its hash is stored, so it cannot be shown again. Make another ' +
          'any time.',
      }));
      el.account.appendChild(box);
      try {
        await navigator.clipboard.writeText(res.body.token);
        say('Token copied.', 'good');
      } catch (_) {
        // It is on screen either way.
      }
    }

    const refresh = document.createElement('button');
    refresh.className = 'btn btn--sm btn--ghost';
    refresh.textContent = 'Refresh';
    refresh.addEventListener('click', loadAccount);

    row.append(pair, refresh);
    note.appendChild(row);
    el.account.appendChild(note);

    // Deliberately after the panel is in the DOM, so the outcome has somewhere to be written.
    if (autoTried && !autoRan) { autoRan = true; connect(pair); }
  }

  function accountCard(flow) {
    const box = document.createElement('div');
    box.className = 'g-card';

    const head = document.createElement('h3');
    head.textContent = flow.name || 'Untitled';
    const kind = document.createElement('span');
    kind.className = 'g-tag g-tag--' + (flow.kind === 'created' ? 'created' : 'recorded');
    kind.textContent = flow.kind;
    /* The tag that decides what can run this. Shown on every row rather than only where it differs,
     * because a missing badge reads as "unknown" rather than "the other one". */
    const src = document.createElement('span');
    src.className = 'g-tag g-tag--' + flow.source;
    src.textContent = flow.source;
    src.title = flow.source === 'web'
      ? 'Points at page elements - run it from the extension'
      : 'Points at screen coordinates - run it from the Desktop tab';
    head.append(kind, src);

    const foot = document.createElement('div');
    foot.className = 'g-foot';
    foot.appendChild(Object.assign(document.createElement('span'), {
      textContent: 'on your account' +
        (flow.updated ? ' - updated ' + new Date(flow.updated).toLocaleDateString() : ''),
    }));
    foot.appendChild(Object.assign(document.createElement('span'), { className: 'g-spacer' }));

    const copy = document.createElement('button');
    copy.className = 'btn btn--sm';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(flow.payload, null, 2));
        say('Copied it.', 'good');
      } catch (_) {
        say('The clipboard was blocked.', 'bad');
      }
    });
    foot.appendChild(copy);

    box.append(head, Object.assign(document.createElement('p'), {
      textContent: flow.description || '',
    }), foot);
    return box;
  }

  function card(skill, index) {
    const box = document.createElement('div');
    box.className = 'g-card';

    const head = document.createElement('h3');
    head.textContent = skill.name;
    const tag = document.createElement('span');
    tag.className = 'g-tag g-tag--' + skill.kind;
    tag.textContent = skill.kind;
    head.appendChild(tag);

    const what = document.createElement('p');
    what.textContent = skill.description || '';

    const foot = document.createElement('div');
    foot.className = 'g-foot';
    foot.appendChild(Object.assign(document.createElement('span'), {
      textContent: (skill.params && skill.params.length
        ? 'asks for ' + skill.params.map((p) => p.name).join(', ')
        : skill.kind === 'created' ? 'no parameters' : (skill.events || []).length + ' steps'),
    }));
    foot.appendChild(Object.assign(document.createElement('span'), { className: 'g-spacer' }));

    /* What it actually does, in full. A skill is a thing you are about to let drive your browser -
     * being able to read it before running it is the point, and it is why the goal and the steps are
     * shown rather than summarised away. */
    const look = document.createElement('button');
    look.className = 'btn btn--sm btn--ghost';
    look.textContent = 'Look inside';
    let open = false;
    const detail = document.createElement('pre');
    detail.hidden = true;
    detail.textContent = skill.kind === 'created'
      ? 'goal:\n  ' + skill.goalTemplate +
        (skill.steps && skill.steps.length
          ? '\n\nwhat it did when it worked:\n' +
            skill.steps.map((s, i) => '  ' + (i + 1) + '. ' + s.name +
              (s.input && s.input.text ? ' — ' + String(s.input.text).slice(0, 60) : '')).join('\n')
          : '')
      : (skill.events || []).map((e, i) => '  ' + (i + 1) + '. ' + e.action +
          (e.selector ? ' ' + e.selector : '') + (e.url ? ' ' + e.url : '')).join('\n');
    look.addEventListener('click', () => {
      open = !open;
      detail.hidden = !open;
      look.textContent = open ? 'Hide' : 'Look inside';
    });

    const copy = document.createElement('button');
    copy.className = 'btn btn--sm';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(skill, null, 2));
        say('Copied “' + skill.name + '”.', 'good');
      } catch (_) {
        say('The clipboard was blocked.', 'bad');
      }
    });

    const del = document.createElement('button');
    del.className = 'btn btn--sm btn--ghost';
    del.textContent = '✕';
    del.title = 'Remove from this page';
    del.addEventListener('click', () => {
      const all = read();
      all.splice(index, 1);
      write(all);
      say('Removed “' + skill.name + '”.');
      render();
    });

    foot.append(look, copy, del);
    box.append(head, what, foot, detail);
    return box;
  }

  const heading = (text) => Object.assign(document.createElement('h3'), {
    className: 's-group', textContent: text,
  });

  function render() {
    const local = read();
    el.list.innerHTML = '';

    if (remote.flows.length) {
      el.list.appendChild(heading('On your account'));
      for (const flow of remote.flows) el.list.appendChild(accountCard(flow));
    }
    if (local.length) {
      if (remote.flows.length) el.list.appendChild(heading('Kept on this page'));
      local.forEach((skill, i) => el.list.appendChild(card(skill, i)));
    }
    if (!remote.flows.length && !local.length) {
      el.list.appendChild(Object.assign(document.createElement('p'), {
        className: 'empty',
        textContent: me
          ? 'Nothing on your account yet. Connect the extension above, then press Sync now in it.'
          : 'Nothing here yet.',
      }));
    }
  }

  render();
  loadAccount();
  return { reload: loadAccount };
}
