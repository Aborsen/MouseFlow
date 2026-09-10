/* A procedure in words — the readable half of `mouseflow.skill/2`.
 *
 * WHY THIS EXISTS. A `mouseflow.skill/1` recorded skill *is* its events: the skill was a copy of the
 * recording, so the only thing anybody could do with it was replay it. Two problems came out of that at
 * once. A person handed such a skill cannot tell what it does without running it - and running it is the
 * expensive, destructive way to find out. And the documentation product has no artifact at all: "record
 * what you did, get a document" needs the document to exist somewhere, and it existed nowhere.
 *
 * So a `/2` skill carries a PROCEDURE - what this does, in sentences - and points at the recording as
 * reference material rather than swallowing it. One artifact then serves both products, which is the whole
 * reason for the version: `steps` read as documentation, `verification` runs as checks (it is literally the
 * `expects` shape from api/_case.mjs), and `pitfalls` is the shelf the application memory will fill.
 *
 * WHY IT LIVES IN THE EXTENSION rather than beside the API, where the transcript lives. Because this is
 * the only side that ever DERIVES one. A skill is made here (`skillFromRecording`) and a `/1` skill is
 * upgraded here, on import; the server only ever READS what is stored - `structureOf` counts
 * `procedure.steps` when they are there and events when they are not, and `gallery.js` checks that one or
 * the other exists. Neither derives, so there is no second implementation to drift from this one. If that
 * ever changes, this file is dependency-free on purpose and can move to `api/` the way `_macro.mjs` did.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: invent a check. See `verification` below.
 */

/* Sentences, not a transcript. A procedure is read by somebody deciding whether to run this, so the
 * movement between the clicks is not in it - `path` events are the mouse travelling, and "moved the
 * pointer 340px" is noise in a document about what the work WAS. */
const NOT_A_STEP = new Set(['path']);

/** How many sentences a procedure carries. Past this it stops being a procedure and becomes a log. */
export const STEPS_MAX = 40;
/** And how long one sentence may be, so a page's whole paragraph cannot become a "step". */
const SAID_MAX = 160;

const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

/* The visible text of a control, trimmed to something that reads as a label rather than as content.
 *
 * `visibleText` in content.js already caps what it records, but a button is not the only thing anybody
 * clicks: a click on a paragraph brings back the paragraph. A label is short, so a long one is treated as
 * not being a label at all - which is the same rule the desktop recorder's landmark search follows, and for
 * the same reason: the alternative is a procedure that quotes somebody's mail back at them. */
const LABEL_MAX = 60;
const labelOf = (event) => {
  const said = clean(event && event.text);
  if (!said || said.length > LABEL_MAX) return '';
  return said;
};

/* What to call a thing that named nothing. The tag is what we honestly have, and "the button" beats
 * "something": a reader can find a button. */
const KIND_WORDS = {
  a: 'link',
  button: 'button',
  input: 'field',
  textarea: 'field',
  select: 'menu',
  option: 'option',
  li: 'list item',
  td: 'cell',
  th: 'column heading',
  img: 'image',
  label: 'label',
  summary: 'expander',
};
const kindOf = (event) => KIND_WORDS[clean(event && event.tag).toLowerCase()] || 'element';

/** Just the host, so a step says "Go to mail.google.com" rather than reciting a query string. */
function hostOf(url) {
  const said = clean(url);
  if (!said) return '';
  try {
    return new URL(said).host || '';
  } catch (_) {
    /* Not a URL we can parse is not an error here - it is a step that will not name a host. */
    return '';
  }
}

/* ------------------------------------------------------------------ one event, in words */

/* Returns null for an event that is not a step. Null rather than an empty sentence, so the caller can tell
 * "nothing to say about this" from "something went wrong saying it". */
function sentenceFor(event, paramFor) {
  if (!event || NOT_A_STEP.has(event.action)) return null;
  const label = labelOf(event);

  if (event.action === 'click' || event.action === 'dblclick') {
    const twice = event.action === 'dblclick' ? 'Double-click' : 'Click';
    return label ? `${twice} "${label}"` : `${twice} the ${kindOf(event)}`;
  }

  /* TYPING IS THE ONE STEP THAT NAMES A PARAMETER, and that is the point of the tier.
   *
   * The recorder never keeps what was typed - it keeps that a field was typed into (`blank`). So the
   * sentence cannot say the value, and it must not pretend to: it names the PARAMETER whose value the
   * person will supply at run time. That makes the procedure and the run form describe the same thing in
   * the same words, which is what stops "field 2" from appearing in a document somebody is meant to read. */
  if (event.action === 'blank') {
    const where = clean(event.field) || (label ? `"${label}"` : `the ${kindOf(event)}`);
    const named = paramFor && paramFor(event);
    const what = named ? `{{${named}}}` : 'the value';
    return `Type ${what} into ${where.startsWith('"') ? where : `"${where}"`}`;
  }

  if (event.action === 'navigate' || event.action === 'focus') {
    const host = hostOf(event.url);
    if (event.action === 'focus' && event.opened) return host ? `Open ${host}` : 'Open a new tab';
    return host ? `Go to ${host}` : null;
  }

  if (event.action === 'scroll') return 'Scroll';

  /* An action this file has not been taught. Named as itself rather than dropped: a procedure missing a
   * step is a procedure that lies about the work, and a reader seeing an unfamiliar verb at least knows
   * something happened there. */
  const verb = clean(event.action);
  return verb ? verb.charAt(0).toUpperCase() + verb.slice(1) : null;
}

/* ------------------------------------------------------------------ the procedure */

/**
 * Distil a recording into a procedure.
 *
 * @param {object[]} events  the recording's events, in order
 * @param {object}   meta    `{ origins, params }` - what the skill already knows about itself
 * @returns {{ whenToUse: string|null, steps: object[], pitfalls: object[], verification: object[] }}
 */
export function procedureFrom(events, meta) {
  const list = Array.isArray(events) ? events : [];
  const about = meta && typeof meta === 'object' ? meta : {};

  /* The parameter a typed field belongs to, by selector - the same map `flowFor` uses to put values back
   * on the events. Read from the skill's own params rather than recomputed, so a procedure cannot name a
   * parameter the run form does not offer. */
  const bySelector = new Map();
  for (const param of Array.isArray(about.params) ? about.params : []) {
    if (param && typeof param.selector === 'string' && typeof param.name === 'string') {
      bySelector.set(param.selector, param.name);
    }
  }
  const paramFor = (event) => bySelector.get(event && event.selector) || null;

  const steps = [];
  for (const event of list) {
    const said = sentenceFor(event, paramFor);
    if (!said) continue;

    /* CONSECUTIVE SCROLLS ARE ONE STEP. Eleven of them are one act - "scroll down to the bottom" - and
     * eleven sentences saying "Scroll" is the log this is meant to replace. Folded here rather than
     * filtered above, because folding needs to know what came before. */
    const last = steps[steps.length - 1];
    if (last && last.said === 'Scroll' && said === 'Scroll') continue;

    steps.push({
      n: steps.length + 1,
      said: said.slice(0, SAID_MAX),
      /* WHICH EVENT THIS SENTENCE CAME FROM, so the two halves of the artifact stay tied together: a
       * reader who wants the exact thing can go to it, and a later pass can attach a check to a step
       * without guessing which one it meant. The selector, not the index - indices move when a
       * recording is re-cut. */
      ...(event.selector ? { selector: String(event.selector).slice(0, 300) } : {}),
      ...(paramFor(event) ? { param: paramFor(event) } : {}),
    });
    if (steps.length >= STEPS_MAX) break;
  }

  /* WHERE THIS APPLIES, AND WHAT IT ENDS BY DOING - the two facts somebody deciding whether to run this
   * actually needs. Absent when there are no origins, rather than a sentence that says nothing: a
   * `whenToUse` reading "Use it." is worse than no field, because a reader spends attention on it before
   * discovering it is empty.
   *
   * The LAST step, not the first. The first is almost always "open the page", which the origins have
   * already said; the last is the outcome, and the outcome is what makes this decidable - "it ends by
   * clicking Send" is the difference between running it and not. Skipped when there is only one step,
   * because then the procedure and this sentence would say the same thing twice. */
  const origins = (Array.isArray(about.origins) ? about.origins : [])
    .map((one) => clean(one)).filter(Boolean).slice(0, 3);
  const ends = steps.length > 1 ? steps[steps.length - 1].said : '';
  const whenToUse = origins.length
    ? `Use it in ${origins.join(', ')}.${ends ? ` It ends by: ${ends.charAt(0).toLowerCase()}${ends.slice(1)}.` : ''}`
    : null;

  return {
    whenToUse,
    steps,
    /* EMPTY, AND EMPTY ON PURPOSE. Pitfalls are things learned about an application - "this dialog opens
     * behind the window", "the list needs a moment before it is clickable" - and nothing here has learned
     * any. This is the shelf the application memory fills (MEMORY-PLAN §4); inventing entries to make the
     * field look furnished would put guesses where facts are meant to go. */
    pitfalls: [],
    /* ALSO EMPTY, AND THIS ONE IS A DECISION RATHER THAN A GAP.
     *
     * It would be easy to derive a check - the last URL a recording reached, say - and it would be wrong
     * to. A check asserts what MUST be true, and it carries `why`: the one line somebody reads in a red
     * report at nine in the morning, in the goal's own words. Nothing here knows the goal, so a derived
     * check would arrive with a `why` nobody wrote, asserting a condition nobody chose. That is the
     * "no false greens" rule pointed the other way: a check nobody meant either passes and proves
     * nothing, or fails and wastes a morning.
     *
     * So the field exists to be FILLED - by the author, or by the case flow, in the `expects` shape from
     * api/_case.mjs - and `readExpects` there stays the one judge of whether an entry is valid. This side
     * transports; it does not judge. */
    verification: [],
  };
}

/* ------------------------------------------------------------------ reading one back */

/** Sentences only - what the Skills page and a shared document show. */
export const stepsSaid = (procedure) =>
  (procedure && Array.isArray(procedure.steps) ? procedure.steps : []).map((s) => clean(s && s.said))
    .filter(Boolean);

/** Whether a stored procedure has anything a reader would call a procedure. */
export const hasProcedure = (procedure) =>
  !!(procedure && typeof procedure === 'object'
    && Array.isArray(procedure.steps) && procedure.steps.length > 0);
