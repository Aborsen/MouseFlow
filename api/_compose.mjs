/* Putting what somebody WROTE onto the steps a recording DERIVED.
 *
 * The wizard produces two things that do not know about each other. The steps are derived: clicks and
 * typing runs turned into numbered instructions, with the field names the accessibility layer read. The
 * notes are written by hand - "type today's date in the reference box", "if a row already exists, stop and
 * say so", "finish by pressing Save, not Send" - and they are the only place where knowledge the recording
 * could not have lives at all.
 *
 * Until now they were STAPLED: the notes went on the end under "Also:", and the model carrying the goal out
 * had to reconcile them live, one action at a time, on somebody's real computer with nobody watching. That
 * is the wrong moment for it. "Finish with Send, not Save" is a change to the PLAN, and a runner that
 * decides one action per turn may well have clicked Save before it reads the sentence that says not to.
 *
 * So the merge happens once, when the skill is made, while the person who just did the work is still on
 * the screen and can see the result before it becomes a skill. That is the whole argument for this file.
 *
 * WHAT THE MODEL IS AND IS NOT ALLOWED TO DO.
 *
 *   INSERT   a note that describes an action becomes a new instruction, at a stated position.
 *   FLAG     a note that contradicts a recorded step is reported. Both survive.
 *   REPORT   a note it could not place at all is handed back, not swallowed.
 *
 * It may not remove a recorded step and it may not rewrite one. That is a decision, not an oversight: the
 * recording is evidence of something that actually happened, and a compiler that quietly deletes a step
 * because a sentence seemed to contradict it destroys the one thing here that is not a guess. Flagging
 * costs a person one glance. Dropping costs them a skill that silently does less than they recorded, and
 * they find out on a real machine.
 *
 * Which is why applying the plan below is plain code, not more model: the model decides WHERE a sentence
 * goes and WHETHER something clashes, and this file decides what the goal text ends up being. Anything the
 * model returns that does not fit - a position that is not a step, an empty instruction - is dropped here
 * and reported as unplaced rather than trusted.
 */

/* A long recording makes a long list, and the whole list has to go in the prompt for a note to be placed
 * against the right part of it. Capped, and the cap is REPORTED rather than applied quietly: a compiler
 * that silently considered the first 300 of 546 steps would place "finish by pressing Save" against
 * whatever step 300 happened to be. */
export const MAX_STEPS = 300;
export const MAX_NOTES = 2000;

/** The shape the model is made to answer in. Given to it as a tool, which is what forces the structure. */
export const PLAN_TOOL = {
  name: 'place_the_instructions',
  description: 'Report where each of the person’s written instructions belongs among the recorded steps.',
  schema: {
    type: 'object',
    properties: {
      insert: {
        type: 'array',
        description: 'Instructions to add, each derived from something the person wrote.',
        items: {
          type: 'object',
          properties: {
            after: {
              type: 'integer',
              description: 'The step number this comes after. Use 0 to put it before the first step.',
            },
            instruction: {
              type: 'string',
              description: 'One imperative line, in the same voice as the recorded steps. No numbering.',
            },
            from: { type: 'string', description: 'The sentence the person wrote that this came from.' },
          },
          required: ['after', 'instruction', 'from'],
          additionalProperties: false,
        },
      },
      conflicts: {
        type: 'array',
        description: 'Where something written contradicts a recorded step. Report it; change nothing.',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer', description: 'The recorded step number that clashes.' },
            note: { type: 'string', description: 'The sentence that clashes with it.' },
            why: { type: 'string', description: 'One clause saying what the clash is.' },
          },
          required: ['n', 'note', 'why'],
          additionalProperties: false,
        },
      },
      unplaced: {
        type: 'array',
        description: 'Anything written that does not belong to any particular step, or that you could not '
          + 'place. Do not invent a position to avoid this list.',
        items: {
          type: 'object',
          properties: {
            note: { type: 'string' },
            why: { type: 'string', description: 'One clause saying why it could not be placed.' },
          },
          required: ['note', 'why'],
          additionalProperties: false,
        },
      },
    },
    required: ['insert', 'conflicts', 'unplaced'],
    additionalProperties: false,
  },
};

export const SYSTEM = [
  'You are turning one person’s notes into steps of a skill that will be carried out on their own computer.',
  '',
  'You are given the steps derived from a screen recording, numbered, and the notes that person wrote in',
  'their own words. The recording knows where every click landed and what each control was called. It does',
  'NOT know what was typed - keystrokes are counted, never read - and it cannot know why anything was done.',
  'The notes are the only place that knowledge exists.',
  '',
  'Place each thing they wrote:',
  '- If it describes an action, add it with `insert`, after the step it follows. Write it in the same voice',
  '  as the recorded steps: one imperative line, naming the control in quotes when you know its name.',
  '- If it contradicts a recorded step, report it in `conflicts`. Do NOT rewrite or remove the step.',
  '- If it belongs to no particular step, or you are unsure where it goes, put it in `unplaced`.',
  '',
  'Rules that matter more than being helpful:',
  '- Never invent a step that nothing in the notes asks for.',
  '- Never place a note against a step just to avoid the unplaced list. Unplaced is a normal answer.',
  '- Placeholders like {{subject}} in a step are inputs the skill will ask for. Leave them exactly as they',
  '  are and never inline a value for one.',
  '- One sentence may produce nothing at all if it is context rather than an instruction.',
].join('\n');

const clean = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

/** The prompt, built from what the wizard has on screen. */
export function promptFor({ steps, notes }) {
  const kept = (Array.isArray(steps) ? steps : []).slice(0, MAX_STEPS);
  const dropped = Math.max(0, (Array.isArray(steps) ? steps.length : 0) - kept.length);
  const listed = kept.map((s) => `${s.n}. ${clean(s.instruction, 300)}`).join('\n');
  const said = String(notes || '').slice(0, MAX_NOTES).trim();
  const user = [
    'The recorded steps:',
    listed || '(none)',
    dropped ? `\n(${dropped} further steps are not listed here.)` : '',
    '',
    'What the person wrote:',
    said,
  ].filter(Boolean).join('\n');
  return { system: SYSTEM, user, dropped };
}

/* Applying it. Plain code on purpose - see the header.
 *
 * `after` is matched against the step numbers actually present rather than against an index, because the
 * numbers are the recording's own and have gaps in them: the wizard drops the steps nobody kept. An
 * `after` that names no kept step cannot be honoured, and the instruction it carried is reported as
 * unplaced rather than dropped on the floor or appended somewhere plausible. */
export function applyPlan({ steps, opening }, plan) {
  const rows = Array.isArray(steps) ? steps : [];
  const known = new Set(rows.map((s) => s.n));
  const raw = plan && typeof plan === 'object' ? plan : {};

  const inserted = [];
  const unplaced = [];
  for (const item of Array.isArray(raw.unplaced) ? raw.unplaced : []) {
    const note = clean(item && item.note, 400);
    if (note) unplaced.push({ note, why: clean(item && item.why, 200) || 'it did not belong to a step' });
  }
  for (const item of Array.isArray(raw.insert) ? raw.insert : []) {
    const instruction = clean(item && item.instruction, 300);
    const from = clean(item && item.from, 400);
    if (!instruction) continue;
    const after = Number(item && item.after);
    /* 0 means "before everything", which is a real answer and not a missing one. */
    if (!Number.isInteger(after) || (after !== 0 && !known.has(after))) {
      unplaced.push({
        note: from || instruction,
        why: `it was put after step ${item && item.after}, which is not one of the steps kept`,
      });
      continue;
    }
    inserted.push({ after, instruction, from });
  }

  const flagged = [];
  for (const item of Array.isArray(raw.conflicts) ? raw.conflicts : []) {
    const n = Number(item && item.n);
    const note = clean(item && item.note, 400);
    if (!note) continue;
    /* A conflict against a step nobody kept is not a conflict any more. */
    if (!Number.isInteger(n) || !known.has(n)) continue;
    flagged.push({ n, note, why: clean(item && item.why, 200) || 'it disagrees with this step' });
  }

  /* Splice. Stable within one position: two inserts after the same step keep the order the model gave. */
  const out = [];
  const at = new Map();
  const put = (after) => {
    for (const add of inserted) if (add.after === after) out.push({ instruction: add.instruction, from: 'yours' });
  };
  put(0);
  for (const step of rows) {
    out.push({ instruction: step.instruction, from: 'recorded' });
    /* Where this recorded step ENDED UP. The two numberings are different and both are on screen: `n` is the
     * recording's, with gaps where steps were dropped, and the goal is renumbered 1..N with the inserts in
     * it. Reporting a clash as "step 6" in the first numbering sends somebody to a different line of the
     * second - which is exactly what it did until this was looked at rather than reasoned about. */
    at.set(step.n, out.length);
    put(step.n);
  }

  const conflicts = flagged.map((c) => ({
    ...c,
    at: at.get(c.n) ?? null,
    /* Quoted as well as numbered, because a quotation cannot drift out of step with a renumbering. */
    instruction: (rows.find((r) => r.n === c.n) || {}).instruction || '',
  }));

  const body = out.map((line, i) => {
    const said = line.instruction;
    return `${i + 1}. ${said[0] ? said[0].toUpperCase() + said.slice(1) : said}`;
  });
  const text = out.length
    ? `${opening || 'Do this on the computer:'}\n${body.map((l) => (/[.!?]$/.test(l) ? l : `${l}.`)).join('\n')}`
    : '';

  return { text, lines: out, inserted, conflicts, unplaced };
}
