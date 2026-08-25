/* Naming the inputs a skill asks for, and saying what each one is.
 *
 * THE ONE HONESTLY EMPTY SLOT. A parameter's name comes from the control it was typed into, and its
 * description comes from a table keyed on its type - so every `quoted` parameter is described to every
 * model by the same sentence, "a phrase the goal quotes - a subject line, a message". A skill that takes a
 * subject line AND a body therefore describes both identically, and a model choosing between two string
 * arguments is choosing on nothing. Worse where the accessibility tree named no control at all: the names
 * fall back to `text` and `text2`, which say even less than the canned sentence.
 *
 * That is a gap a model can fill without inventing anything. It is not being asked what the skill does, or
 * which steps matter, or what to type - it is being asked to look at instructions somebody already approved
 * and say, in words, what the blank at step 14 is for. The answer is derivable from the text in front of it.
 *
 * WHAT IT MAY NOT DO, and these are enforced here rather than asked for in the prompt:
 *
 *   INVENT A PARAMETER. It answers per step number, and a step number that was not sent is dropped. The set
 *   of blanks is the wizard's, decided by a person ticking boxes, and this only ever renames what is there.
 *
 *   LOSE ONE. A blank the model said nothing about keeps the name it had. Silence is not a deletion.
 *
 *   WRITE A SUBSTITUTION. `{{` is stripped from anything it returns. Parameters are declared from the blank
 *   list and substituted by fillGoal; a name carrying braces would reach the runner as literal characters,
 *   because nothing scans a goal for them.
 *
 * The renaming is applied by plain code below, for the same reason api/_compose.mjs applies its plan in
 * code: the model decides WHAT a thing is called, and this file decides what the skill ends up holding.
 */

/** A name a tool schema will accept, and that fillGoal can substitute on. */
const slug = (said) => String(said || '')
  .replace(/\{\{|\}\}/g, '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 24);

const oneLine = (said, max) => String(said || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Enough blanks that a long recording is covered, few enough that the answer stays readable. */
export const MAX_PARAMS = 24;

export const NAME_TOOL = {
  name: 'name_the_inputs',
  description: 'Give each blank a name and say what it is for.',
  schema: {
    type: 'object',
    properties: {
      inputs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer', description: 'The step number this blank belongs to, as given.' },
            name: {
              type: 'string',
              description: 'A short lower_snake_case name for the value, from what the instruction shows '
                + 'it is - "subject", "recipient", "invoice_number". Not the control it was typed into if '
                + 'that says less. Never invent a blank that was not listed.',
            },
            about: {
              type: 'string',
              description: 'One sentence, under 140 characters, telling a model calling this skill what to '
                + 'pass. Say what the value IS, not where it gets typed. If the instructions do not make it '
                + 'clear, say what can be told and no more - a confident wrong sentence is worse than a '
                + 'vague right one, because it will be believed.',
            },
          },
          required: ['n', 'name', 'about'],
          additionalProperties: false,
        },
      },
    },
    required: ['inputs'],
    additionalProperties: false,
  },
};

/**
 * @param {{ opening: string, steps: {n: number, instruction: string}[],
 *           blanks: {n: number, name: string, control: string|null, type: string}[] }} said
 */
export function promptFor(said) {
  const steps = (said.steps || []).slice(0, 200);
  const blanks = (said.blanks || []).slice(0, MAX_PARAMS);
  const dropped = Math.max(0, (said.blanks || []).length - blanks.length);

  const system = 'You are naming the inputs of an automation somebody just recorded. You are shown the '
    + 'instructions they approved and the blanks in them. Name each blank and say what it is for, in the '
    + 'words the instructions use. You are NOT deciding what the automation does, which steps matter, or '
    + 'what should be typed - all of that is already decided. Do not invent a blank that is not listed, and '
    + 'do not answer about one twice. Where the instructions do not say what a value is, say so plainly '
    + 'rather than guessing: this sentence is what another model reads when it decides what to pass, and a '
    + 'confident wrong one gets typed into somebody\'s real application.';

  const user = [
    said.opening ? String(said.opening).slice(0, 300) : '',
    '',
    'The steps:',
    ...steps.map((s) => `${s.n}. ${oneLine(s.instruction, 300)}`),
    '',
    'The blanks, by step number:',
    ...blanks.map((b) => `${b.n}: currently called "${b.name}"`
      + (b.control ? `, typed into "${oneLine(b.control, 80)}"` : ', typed into something unnamed')
      + `, looks like ${b.type}`),
  ].join('\n');

  return { system, user, dropped };
}

/**
 * The answer, applied. Returns one entry per blank GIVEN, in the order given - a blank the model skipped
 * keeps what it had.
 *
 * @param {{n: number, name: string, control: string|null, type: string}[]} blanks
 * @param {unknown} answer  whatever came back in the tool call
 */
export function applyNames(blanks, answer) {
  const said = new Map();
  const list = answer && Array.isArray(answer.inputs) ? answer.inputs : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const n = Number(item.n);
    if (!Number.isInteger(n) || said.has(n)) continue;      // answered twice: the first one stands
    said.set(n, item);
  }

  const taken = new Set();
  return (blanks || []).map((blank) => {
    const got = said.get(Number(blank.n));
    const wanted = got ? slug(got.name) : '';
    /* The old name is the fallback at every step: a model that said nothing, said something empty, or said
     * something that slugged away to nothing leaves the blank exactly as the wizard had it. */
    let name = wanted || slug(blank.name) || 'text';
    /* Two blanks renamed to one word is a skill that asks for one thing and fills two - the same collision
     * the wizard's own numbering guards against, and it has to be guarded again because the names changed. */
    if (taken.has(name)) {
      let i = 2;
      while (taken.has(`${name}${i}`)) i += 1;
      name = `${name}${i}`;
    }
    taken.add(name);
    const about = got ? oneLine(String(got.about || '').replace(/\{\{|\}\}/g, ''), 140) : '';
    return { n: blank.n, name, about: about || null, renamed: name !== blank.name };
  });
}
