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

import { hasProcedure, procedureFrom } from './procedure.js';

/* ЧТО ПИШЕТСЯ - и что ЧИТАЕТСЯ, а это разные списки, и разделение здесь главное.
 *
 * `/2` добавляет уровень 1 - процедуру словами: что этот навык делает, предложениями. Тем самым один
 * артефакт начинает служить обоим продуктам - `steps` читаются как документ, `verification` исполняется
 * как проверки, - и до этого у продукта-документации артефакта не было вовсе.
 *
 * `/1` ОСТАЁТСЯ ЧИТАЕМЫМ НАВСЕГДА, и это не вежливость, а свойство формата обмена. Навык уже уехал с
 * чьей-то машины в файле; отказаться его читать - значит сломать то, что человек считает своим. Поэтому
 * пишем всегда последний формат, а принимаем оба, и `/1` на чтении ДОПОЛНЯЕТСЯ процедурой, выведенной из
 * его же событий, а не переписывается.
 *
 * Порядок в списке - от нового к старому, чтобы отказ называл первым тот формат, который стоит иметь. */
export const SKILL_FORMAT = 'mouseflow.skill/2';
export const SKILL_FORMATS_READ = ['mouseflow.skill/2', 'mouseflow.skill/1'];

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

/* Parameters this skill cannot run without: no value given, and no example to fall back on.
 *
 * A skill installed from the gallery has no examples by design - the author's real values do not travel
 * (see publicParams in api/gallery.js) - and fillGoal substitutes '' for a parameter it cannot resolve, so
 * without this a blank field produced "email the invoice to " and ran it. Better to be told which field. */
export function missingParams(skill, values) {
  return (skill.params || [])
    .filter((p) => {
      const given = values && values[p.name];
      const hasValue = given != null && String(given).trim() !== '';
      const hasExample = p.example != null && String(p.example).trim() !== '';
      return !hasValue && !hasExample;
    })
    .map((p) => p.name);
}

// Substitutes values into a template. A parameter with no value keeps its example, so a half-filled
// form still produces a runnable goal rather than a sentence with holes in it. Call missingParams first:
// a parameter with neither is substituted with '' here, which is a sentence with a hole in it.
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

/* ПАРАМЕТРЫ ЗАПИСАННОГО НАВЫКА - ИЗ ПОЛЕЙ, В КОТОРЫЕ ПЕЧАТАЛИ.
 *
 * `params: []` стояло здесь безусловно, и это означало, что записанный навык - неизменяемый макрос:
 * весь смысл навыка поверх записи в том, что значение может отличаться от прогона к прогону, а
 * отличаться было нечему. Меняться могло только созданное по цели.
 *
 * Рекордер содержимого полей не пишет и писать не будет - он пишет шаг `blank`: какое поле, как оно
 * называется, сколько нажатий. Одного этого хватает: каждое поле, в которое печатали, становится ровно
 * одним параметром, и человек заполняет его при запуске. Имя берётся у поля - «Search», а не «поле 2», -
 * и повторы схлопываются: печать в одно и то же поле дважды это один параметр, а не два.
 */
function blanksOf(events) {
  const seen = new Map();
  for (const ev of events) {
    if (!ev || ev.action !== 'blank' || !ev.selector) continue;
    if (seen.has(ev.selector)) continue;
    seen.set(ev.selector, {
      selector: ev.selector,
      name: paramName(slug(ev.field || ev.tag || 'field'), new Set([...seen.values()].map((p) => p.name))),
      label: ev.field || null,
      type: 'text',
    });
  }
  return [...seen.values()];
}

/** Имя параметра из подписи поля: «Search query» -> «search_query». */
function slug(text) {
  const out = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return out || 'field';
}

export function skillFromRecording(rec, now) {
  const events = rec.events || [];
  const origins = rec.origins || [];
  const params = blanksOf(events);
  return {
    format: SKILL_FORMAT,
    id: id(),
    kind: 'recorded',
    name: rec.name || suggestName('recording'),
    description: describeRecording(events, rec.tabs),
    created: now,
    origins,
    tabs: rec.tabs || 1,
    events,
    params,
    /* УРОВЕНЬ 1: ЧТО ЭТО ДЕЛАЕТ, СЛОВАМИ. Выводится ЗДЕСЬ, в момент создания, а не при показе - потому
     * что события у нас в руках именно сейчас, и потому что процедура должна уехать вместе с навыком: тот,
     * кому его передали, читает документ, а не запускает макрос, чтобы узнать, что тот делает.
     *
     * `params` передаются внутрь, а не выводятся там заново: шаг, называющий параметр, обязан называть
     * ТОТ параметр, который человеку предложит форма запуска. Два вывода одного имени - это документ,
     * обещающий поле, которого в форме нет. */
    procedure: procedureFrom(events, { origins, params }),
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
    /* The template, not the goal that produced it. A created skill's whole point is that the value varies,
     * so "send a follow-up to {{recipient}}" describes it and "send a follow-up to vic@example.com"
     * describes one run of it - and that value is the author's, which matters once this is published. The
     * name was already scrubbed of emails and URLs by suggestName; this was the one that was not. */
    description: template,
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
    if (!SKILL_FORMATS_READ.includes(raw.format)) {
      throw new Error('Unrecognised skill format' + (raw.format ? ' "' + raw.format + '"' : '') +
        ' - this reads ' + SKILL_FORMATS_READ.join(' and ') + '.');
    }
    const kind = raw.kind === 'created' ? 'created' : 'recorded';
    const skill = {
      /* ТОТ, С КОТОРЫМ ПРИЕХАЛИ - см. заметку выше. Список уже проверен, так что здесь это знакомая
       * строка, а не что попало. */
      format: raw.format,
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
      /* НИ СОБЫТИЙ, НИ ПРОЦЕДУРЫ - вот это отказ, а не «нет событий».
       *
       * У `/1` события были единственным содержимым, и требовать их было то же, что требовать
       * содержимого вообще. У `/2` содержимого два вида, и каждый сам по себе - навык: процедура без
       * событий читается (и это весь продукт-документация), события без процедуры играются (и это каждый
       * `/1`, который уже у кого-то лежит). Отказать надо ровно тому, у чего нет ни того, ни другого, и
       * сказать это словами - иначе человек видит «no steps» про файл, в котором шаги написаны текстом. */
      const events = Array.isArray(raw.events) ? raw.events : [];
      const arrived = readProcedure(raw.procedure);
      if (!events.length && !hasProcedure(arrived)) {
        throw new Error('"' + skill.name + '" is a recorded skill with nothing in it - no procedure to '
          + 'read and no recorded steps to replay.');
      }
      if (events.length) skill.events = events;
      skill.tabs = Number(raw.tabs) > 0 ? Number(raw.tabs) : 1;
      /* `/1` ДОПОЛНЯЕТСЯ, А НЕ ПЕРЕПИСЫВАЕТСЯ. Процедура выводится из его же событий - то есть навык,
       * приехавший старым форматом, сразу читается как документ, - но исходные поля остаются как были,
       * потому что экспорт обязан вернуть то, что импортировали. */
      skill.procedure = hasProcedure(arrived)
        ? arrived
        : procedureFrom(events, { origins: skill.origins, params: skill.params });
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

/* ПРОЦЕДУРА ИЗВНЕ - ПЕРЕСОБИРАЕТСЯ ПОЛЕ ЗА ПОЛЕМ, как и всё остальное в этом файле: вставленный навык -
 * это данные, и он не должен уметь занести ключ, по которому потом кто-то что-то сделает.
 *
 * И ОДНО РЕШЕНИЕ, КОТОРОЕ НАДО НАЗВАТЬ ВСЛУХ: `verification` здесь ПЕРЕВОЗИТСЯ, а не судится.
 *
 * Единственный судья того, годится ли утверждение, - `readExpects` в api/_case.mjs: он знает, какие виды
 * проверок существуют, каким нужен `text`, и что без `why` утверждение бесполезно в отчёте. Повторить это
 * правило здесь значило бы иметь два представления о том, что такое проверка, - ровно то, чего принцип
 * «одна реализация, много читателей» и не допускает, - а импортировать его сюда нельзя: этот файл живёт в
 * расширении, у него нет доступа к api/.
 *
 * Поэтому здесь только ТРАНСПОРТ: шесть известных строковых полей, обрезанных по длине, и ничего больше.
 * Судит та сторона, где проверка будет выполняться. Что эти два уровня согласуются - закреплено
 * ИСПОЛНЕНИЕМ в api/_test-skills.mjs, который может импортировать оба и сверить их на одних данных. */
const VERIFY_MAX = 8;
const PITFALL_MAX = 20;
const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function readProcedure(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).slice(0, 40)
    .map((one, i) => {
      const said = str(one && one.said, 160);
      if (!said) return null;
      return {
        n: i + 1,
        said,
        ...(str(one && one.selector, 300) ? { selector: str(one.selector, 300) } : {}),
        ...(str(one && one.param, 31) ? { param: str(one.param, 31) } : {}),
      };
    })
    .filter(Boolean)
    .map((one, i) => ({ ...one, n: i + 1 }));

  const verification = (Array.isArray(raw.verification) ? raw.verification : []).slice(0, VERIFY_MAX)
    .map((one) => {
      const check = str(one && one.check, 40);
      if (!check) return null;
      return {
        check,
        ...(str(one && one.name, 200) ? { name: str(one.name, 200) } : {}),
        ...(str(one && one.text, 400) ? { text: str(one.text, 400) } : {}),
        ...(str(one && one.process, 200) ? { process: str(one.process, 200) } : {}),
        ...(str(one && one.why, 300) ? { why: str(one.why, 300) } : {}),
        ...(str(one && one.after, 200) ? { after: str(one.after, 200) } : {}),
      };
    })
    .filter(Boolean);

  return {
    whenToUse: str(raw.whenToUse, 300) || null,
    steps,
    pitfalls: (Array.isArray(raw.pitfalls) ? raw.pitfalls : []).slice(0, PITFALL_MAX)
      .map((one) => (typeof one === 'string'
        ? { said: str(one, 300) }
        : { said: str(one && one.said, 300) }))
      .filter((one) => !!one.said),
    verification,
  };
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
  /* /gallery, а не /gallery.html. Страницы с таким именем в проекте нет вовсе - SPA-переписывание отдавало
     index.html, читать фрагмент было некому, и кнопка молча выбрасывала скилл, отвечая ok:true. Приёмная
     половина теперь есть: web/src/features/gallery/GalleryView.tsx. */
  return String(appUrl).replace(/\/$/, '') + '/gallery#publish=' + base64url;
}

/* --------------------------------------------------------------------------- running */

// What a recorded skill needs to become a flow the replay engine understands.
export function flowFor(skill, options) {
  const opts = options || {};
  /* Значения садятся на шаги ЗДЕСЬ, а не в самом навыке: навык - это шаблон, и он один на все прогоны, а
   * значения принадлежат прогону. Записывать их в него значило бы, что второй запуск с другими данными
   * тихо перезаписал первый. */
  const values = opts.values || {};
  const byField = new Map((skill.params || []).map((p) => [p.selector, p]));
  const events = (skill.events || []).map((ev) => {
    if (!ev || ev.action !== 'blank') return ev;
    const param = byField.get(ev.selector);
    if (!param) return ev;
    const given = values[param.name];
    const use = given != null && String(given) !== '' ? String(given) : param.example;
    return use == null ? ev : Object.assign({}, ev, { value: String(use) });
  });
  return {
    startDelay: 0,
    flowRepeat: opts.loop ? 0 : 1,
    steps: [{
      events,
      repeat: 1,
      speed: opts.speed > 0 ? opts.speed : 1,
      delayAfter: opts.loop ? 1000 : 0,
    }],
  };
}
