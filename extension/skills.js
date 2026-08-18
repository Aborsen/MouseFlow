/* Skills — a finished flow, named and made reusable.
 *
 * A recording is literal and fixed. A skill has a name, a description, and where it makes sense
 * PARAMETERS, so the thing you did once can be done again with different details. That is the whole
 * difference, and it is why a skill is worth handing to someone else.
 *
 * The two modes produce genuinely different skills, and pretending otherwise would make both worse:
 *
 *   recorded — the mouse path and clicks, replayed literally into tabs already open. Free, exact,
 *             and brittle: it breaks when the page changes. Recording deliberately captures no
 *             text, so there is nothing to parameterise. A named, repeatable macro.
 *
 *   created — the GOAL, re-run by the agent. Costs an API call per step and will not do the same
 *             thing twice in exactly the same way, but survives a redesign and takes different
 *             values each run. The steps the successful run took are kept alongside as evidence of
 *             what it did - not as the thing replayed, because replaying them would throw away the
 *             adaptability that is the entire reason to have used the agent.
 *
 * Kept as its own module because it is all pure data handling: no chrome APIs, no DOM. That means
 * the format, the parameter extraction and the import validation can be tested directly, which
 * matters for the part of the product intended to leave one machine and arrive on another.
 */

export const SKILL_FORMAT = 'mouseflow.skill/1';

/* ------------------------------------------------------------------------ parameters */

/* Turning a one-off goal into something reusable.
 *
 * The goal is where the variable parts already are - the user wrote them there. So rather than
 * asking anyone to author a template, the obvious variables are lifted out of the sentence they
 * typed: email addresses first, because between two runs of the same errand that is what changes,
 * then URLs, then quoted phrases, which is how people write out a subject line or a message.
 *
 * Order matters. Emails are extracted before quoted text so that an address inside quotes is
 * recognised as an address rather than as a phrase.
 */
const PATTERNS = [
  { type: 'email', name: 'recipient', re: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g },
  { type: 'url', name: 'url', re: /https?:\/\/[^\s"'<>]+/g },
  { type: 'quoted', name: 'text', re: /"([^"\n]{2,120})"/g },
];

function paramName(base, taken) {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(base + n)) n++;
  return base + n;
}

/* Finds the variable parts of a goal and returns a template plus what fills it.
 *
 * The same value appearing twice becomes ONE parameter used twice - "reply to X and cc X" should
 * ask once, not twice. */
export function parameterise(goal) {
  const text = String(goal || '');
  const taken = new Set();
  const params = [];
  const byValue = new Map();
  let template = text;

  for (const pattern of PATTERNS) {
    const found = text.match(new RegExp(pattern.re.source, 'g')) || [];
    for (const raw of found) {
      // A quoted match includes its quotes; the value is what is inside them.
      const value = pattern.type === 'quoted' ? raw.slice(1, -1) : raw;
      if (!value || byValue.has(value)) continue;
      // Do not parameterise something already replaced as part of a longer match.
      if (!template.includes(value)) continue;

      const name = paramName(pattern.name, taken);
      taken.add(name);
      byValue.set(value, name);
      params.push({ name, type: pattern.type, example: value });
      template = template.split(value).join('{{' + name + '}}');
    }
  }

  return { template, params };
}

// Substitutes values into a template. A parameter with no value keeps its example, so a half-filled
// form still produces a runnable goal rather than a sentence with holes in it.
export function fillGoal(skill, values) {
  let out = String(skill.goalTemplate || skill.goal || '');
  for (const param of skill.params || []) {
    const given = values && values[param.name];
    const value = given == null || given === '' ? param.example : given;
    out = out.split('{{' + param.name + '}}').join(value == null ? '' : String(value));
  }
  return out;
}

/* -------------------------------------------------------------------------- naming */

// A short handle from the goal or recording name, for the gallery and for reading a list quickly.
export function suggestName(source) {
  const words = String(source || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  const name = words.join(' ').trim();
  return name || 'Untitled skill';
}

/* -------------------------------------------------------------------------- building */

function id() {
  return Math.random().toString(36).slice(2, 10);
}

export function skillFromRecording(rec, now) {
  const events = rec.events || [];
  return {
    format: SKILL_FORMAT,
    id: id(),
    kind: 'recorded',
    name: rec.name || suggestName('recording'),
    description: describeRecording(events, rec.tabs),
    created: now,
    origins: rec.origins || [],
    tabs: rec.tabs || 1,
    events,
    params: [],
  };
}

export function skillFromRun(run, now) {
  const goal = String(run.goal || '').trim();
  const { template, params } = parameterise(goal);
  return {
    format: SKILL_FORMAT,
    id: id(),
    kind: 'created',
    name: suggestName(goal),
    description: goal,
    created: now,
    goalTemplate: template,
    params,
    // What the successful run actually did. Evidence, and a hint for whoever reads the skill -
    // not the thing replayed.
    steps: (run.steps || []).map((s) => ({ name: s.name, input: s.input })),
    origins: run.origins || [],
  };
}

// What a recording contains, in the terms someone reading a gallery listing would want.
export function describeRecording(events, tabs) {
  let clicks = 0;
  let moveMs = 0;
  let scrolls = 0;
  let pages = 0;
  for (const e of events || []) {
    if (e.action === 'click' || e.action === 'dblclick') clicks++;
    else if (e.action === 'path') moveMs += (e.points || []).reduce((n, p) => n + Math.max(0, p.dt || 0), 0);
    else if (e.action === 'scroll') scrolls++;
    else if (e.action === 'focus' || e.action === 'navigate') pages++;
  }
  const parts = [clicks + ' click' + (clicks === 1 ? '' : 's')];
  if (moveMs >= 100) parts.push((moveMs / 1000).toFixed(1) + 's of movement');
  if (scrolls) parts.push(scrolls + ' scroll' + (scrolls === 1 ? '' : 's'));
  if (pages) parts.push(pages + ' page change' + (pages === 1 ? '' : 's'));
  if (tabs > 1) parts.push(tabs + ' tabs');
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ leaving the machine */

/* Sharing, without a server.
 *
 * A gallery needs somewhere to put things and someone to say who you are. Until both exist a skill
 * still has to be able to reach another person, so it serialises to one self-contained block of
 * text: copy it, send it however you like, paste it in the other end. No account, no upload, and it
 * works offline.
 */
export function exportSkill(skill) {
  return JSON.stringify(withoutRuntime(skill), null, 2);
}

export function exportMany(skills) {
  return JSON.stringify({
    format: SKILL_FORMAT,
    exported: skills.length,
    skills: skills.map(withoutRuntime),
  }, null, 2);
}

function withoutRuntime(skill) {
  // `lastRun` is this machine's history and means nothing to anyone else.
  const copy = Object.assign({}, skill);
  delete copy.lastRun;
  return copy;
}

/* Anything arriving from outside is untrusted input, so it is rebuilt field by field rather than
 * merged. A pasted skill is data; it must not be able to introduce keys the rest of the code will
 * later act on. */
export function importSkills(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch (_) {
    throw new Error('That is not a skill - it is not valid JSON.');
  }

  const list = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed && parsed.skills) ? parsed.skills
    : [parsed];

  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.format !== SKILL_FORMAT) {
      throw new Error('Unrecognised skill format' + (raw.format ? ' "' + raw.format + '"' : '') +
        ' - this needs MouseFlow ' + SKILL_FORMAT + '.');
    }
    const kind = raw.kind === 'created' ? 'created' : 'recorded';
    const skill = {
      format: SKILL_FORMAT,
      id: id(),                                   // local identity; two people may hold the same skill
      kind,
      name: String(raw.name || 'Imported skill').slice(0, 80),
      description: String(raw.description || '').slice(0, 400),
      created: typeof raw.created === 'string' ? raw.created : null,
      imported: true,
      origins: Array.isArray(raw.origins) ? raw.origins.filter((o) => typeof o === 'string') : [],
      params: cleanParams(raw.params),
    };

    if (kind === 'recorded') {
      if (!Array.isArray(raw.events) || !raw.events.length) {
        throw new Error('"' + skill.name + '" is a recorded skill with no steps in it.');
      }
      skill.events = raw.events;
      skill.tabs = Number(raw.tabs) > 0 ? Number(raw.tabs) : 1;
    } else {
      const goal = String(raw.goalTemplate || raw.goal || '').trim();
      if (!goal) throw new Error('"' + skill.name + '" is a created skill with no goal in it.');
      skill.goalTemplate = goal;
      skill.steps = Array.isArray(raw.steps) ? raw.steps.slice(0, 200) : [];
    }
    out.push(skill);
  }

  if (!out.length) throw new Error('No skills found in that.');
  return out;
}

function cleanParams(params) {
  if (!Array.isArray(params)) return [];
  return params
    .filter((p) => p && typeof p.name === 'string' && /^[a-zA-Z][\w]{0,30}$/.test(p.name))
    .slice(0, 12)
    .map((p) => ({
      name: p.name,
      type: ['email', 'url', 'quoted', 'text'].includes(p.type) ? p.type : 'text',
      example: p.example == null ? '' : String(p.example).slice(0, 200),
    }));
}

/* ------------------------------------------------------------------- to the gallery */

/* A skill handed to the gallery page through the URL FRAGMENT.
 *
 * A fragment is never sent to a server, so a skill on its way to being published does not pass
 * through a request log on the way, and the extension needs no session of its own - the page is
 * already signed in, and it does the publishing.
 *
 * base64url rather than plain base64 because this ends up in a URL, where + / and = have meanings.
 */
export function publishLink(skill, appUrl) {
  const json = exportSkill(skill);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64url = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return String(appUrl).replace(/\/$/, '') + '/gallery.html#publish=' + base64url;
}

/* --------------------------------------------------------------------------- running */

// What a recorded skill needs to become a flow the replay engine understands.
export function flowFor(skill, options) {
  const opts = options || {};
  return {
    startDelay: 0,
    flowRepeat: opts.loop ? 0 : 1,
    steps: [{
      events: skill.events || [],
      repeat: 1,
      speed: opts.speed > 0 ? opts.speed : 1,
      delayAfter: opts.loop ? 1000 : 0,
    }],
  };
}
