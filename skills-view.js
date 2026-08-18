/* Skills, on the web.
 *
 * A skill is made in the extension, which is where the browser is driven from. This tab is where you
 * keep, read and pass them around from a full window rather than a 320px popup: paste one in, look at
 * what it actually does, copy it out, send it to the gallery.
 *
 * What it deliberately does NOT claim: these are the skills stored HERE, in this browser's local
 * storage for this site. It cannot see into the extension - a page and an extension have separate
 * storage, by design - so a skill saved in the extension appears here only once it is synced through
 * the account. Until that exists, the honest description is "kept on this page", and that is what it
 * says.
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
          Kept on this page. A skill is made in the extension — this is where you read one properly,
          pass it on, or paste one in from the gallery.
        </p>
      </div>
      <div class="g-row s-tools">
        <button class="btn btn--sm s-paste" type="button">Paste one in</button>
        <button class="btn btn--sm btn--ghost s-copy" type="button">Copy all</button>
      </div>
    </div>
    <textarea class="s-box" placeholder="Paste a skill here, then press Add" hidden></textarea>
    <div class="g-row s-boxrow" hidden>
      <button class="btn btn--primary btn--sm s-add" type="button">Add</button>
      <button class="btn btn--ghost btn--sm s-cancel" type="button">Cancel</button>
    </div>
    <div class="g-status s-status"></div>
    <div class="s-list"></div>
  `;

  const el = {
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

  function render() {
    const all = read();
    el.list.innerHTML = '';
    if (!all.length) {
      el.list.appendChild(Object.assign(document.createElement('p'), {
        className: 'empty',
        textContent: 'Nothing here yet. Copy a skill from the gallery, or from the extension ' +
          'under Skills, and paste it in.',
      }));
      return;
    }
    all.forEach((skill, i) => el.list.appendChild(card(skill, i)));
  }

  render();
  return { reload: render };
}
