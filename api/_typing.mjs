/* Which of a recording's typing runs is actually a FIELD, and which is somebody pressing Enter.
 *
 * WHY THIS EXISTS. A long recording produces a lot of typing runs, and the skill wizard used to put one card
 * on screen for every one of them - nineteen cards, each asking a three-way question, and eighteen of them
 * defaulting to "ask each time", which is a skill that demands eighteen arguments before it will run. That is
 * not a form anybody fills in; it is a wall somebody closes the app in front of.
 *
 * Most of those runs are not fields. Measured on a real 6,617-event recording from this account - thirteen
 * runs, 656 keystrokes:
 *
 *     9 runs   AXTextArea    "Prompt"                    60, 70, 53, 116, 3, 261, 15, 1, 61 keys
 *     4 runs   AXGroup       the dialog's own title       7, 6, 2, 1 keys
 *
 * The four AXGroup runs are Enter and Escape pressed inside a dialog. The accessibility hit-test named the
 * DIALOG, because a dialog is what was under the caret - which is how "Into “Make a skill from …”" ended up
 * on a card looking like a text box you could name a parameter after.
 *
 * ROLE IS THE SIGNAL, AND IT IS THE ONLY ONE THAT TRAVELS. The obvious alternative is `type`, and `type` is
 * LOCALISED: the same account above produced "область ввода текста", "кнопка", "диалоговое окно" and, from a
 * second machine, Ukrainian - "область прокручування", "Вміст HTML". A list of English control-type words
 * would have classified every one of those as unknown. `role` is the unlocalised AX/UIA role and reads
 * `AXTextArea` on every machine in every language.
 *
 * WHAT THIS DOES NOT KNOW. The Windows agent does not write `role` (agent/PROTOCOL.md names app, window,
 * control and type; `role` and `subrole` arrived with the macOS agent at 0.8.0). So there is a second path
 * below for a step with no role, and it is a GUESS - it says so in its verdict, and the wizard shows a guess
 * differently from a fact. The right long-term fix is for the Windows agent to write the UIA control TYPE ID
 * alongside the localised name; that is a change in two places and is not this change.
 */

/* Somewhere text goes. AX spellings, which is what the macOS agent writes; the UIA equivalents are listed
 * beside them so a future Windows agent that emits a role lands here too rather than in the guess path. */
const TEXT_ROLES = new Set([
  'AXTextArea',        // Edit, multi-line
  'AXTextField',       // Edit
  'AXSearchField',     // Edit with a search filter
  'AXSecureTextField', // Edit, password - see the note in classifyTyping
  'AXComboBox',        // ComboBox, the editable kind
]);

/* Roles that are unambiguously NOT a text box. Kept as a list rather than "anything not in TEXT_ROLES",
 * because a role nobody has seen yet should come back as a guess and not as a confident no. */
const NOT_TEXT_ROLES = new Set([
  'AXGroup', 'AXWindow', 'AXSheet', 'AXDialog', 'AXStaticText', 'AXButton', 'AXLink',
  'AXImage', 'AXScrollArea', 'AXToolbar', 'AXMenu', 'AXMenuItem', 'AXMenuBar', 'AXList',
  'AXTable', 'AXRow', 'AXCell', 'AXTabGroup', 'AXSplitGroup', 'AXUnknown',
]);

/* Below this, a run is almost certainly a keypress rather than typing: Enter to submit, Tab between fields,
 * a shortcut. Only consulted when the role is unknown - run 7 in the measurement above is three keystrokes
 * into a genuine text box, so this would have got that one wrong if it outranked the role. */
const SHORTCUT_KEYS = 2;

const same = (a, b) => !!a && !!b && String(a).trim() === String(b).trim();

/**
 * @param {{ control?: string|null, role?: string|null, keys?: number }} step  one typing run
 * @param {string|null} [windowTitle]  the title of the window it happened in, when known
 * @returns {{ field: boolean, sure: boolean, why: string }}
 *   `field`  is this a place a skill could be told to type?
 *   `sure`   was that read off the accessibility role, or guessed from the shape of the run?
 *   `why`    one clause, for the screen - never a sentence, the caller frames it
 */
/* Keys that END a field rather than continue it.
 *
 * Pressing Return after typing is what a person does to a BOX - a search field, an address bar, a message.
 * Nobody commits a canvas, a game or a keyboard shortcut that way. Tab is the same gesture with the cursor
 * moving on. So a run terminated by one of these is a field as a matter of fact, not of guesswork.
 *
 * This only became knowable at agent 0.9.4, which is the build that names the keys that cannot spell
 * anything. Before it every keystroke was anonymous and this evidence did not exist. */
const COMMIT_KEYS = new Set(['enter', 'return', 'tab']);

const commits = (key) => {
  if (!key) return false;
  const parts = String(key).split('+');
  return COMMIT_KEYS.has(parts[parts.length - 1].trim().toLowerCase());
};

/**
 * @param {string|null} committedBy  the key pressed IMMEDIATELY after this run, when it was named
 */
export function classifyTyping(step, windowTitle = null, committedBy = null) {
  const role = step && step.role ? String(step.role).trim() : '';
  const control = step && step.control ? String(step.control).trim() : '';
  const keys = Number(step && step.keys) || 0;

  if (TEXT_ROLES.has(role)) {
    /* A password box is a text box and is reported as one. It is NOT filtered out here: the wizard's own
     * choices already cover it - "always the same" would put a password in a skill payload, and the honest
     * answer for that field is "ask each time", which is the default. Silently hiding it would leave a skill
     * that types nothing into the password box and looks broken instead. */
    return { field: true, sure: true, why: 'a text box' };
  }
  if (NOT_TEXT_ROLES.has(role)) {
    return { field: false, sure: true, why: 'keys pressed here, not typed into a box' };
  }

  /* Typed, and then committed. This runs BELOW the two role checks on purpose - a role read off the
   * accessibility tree is a fact about what the thing IS, and should not be overturned by an inference
   * about what was done to it. Below them it does the one job worth having: it turns the guess path into a
   * fact, which is the path Windows always takes, because that agent writes no role at all. */
  if (commits(committedBy)) {
    return { field: true, sure: true, why: 'typed, then committed with ' + committedBy };
  }

  /* No role, or one nobody has catalogued. Everything from here down is a guess. */
  if (!control) {
    /* Nothing to aim at. Even if this WERE a field, `instruction()` could only emit a bare "type {{x}}" with
     * no target, which is an instruction a model cannot carry out reliably - so the answer is the same. */
    return { field: false, sure: false, why: 'nothing there had a name' };
  }
  if (same(control, windowTitle)) {
    /* The name read back is the window's own. That is the AXGroup case above, arriving without a role: the
     * hit-test found the container because there was no smaller named thing under the caret. Language
     * independent, which is the whole reason it is here rather than a list of words for "dialog". */
    return { field: false, sure: false, why: 'that is the window’s name, not a field in it' };
  }
  if (keys <= SHORTCUT_KEYS) {
    return { field: false, sure: false, why: `only ${keys} keystroke${keys === 1 ? '' : 's'}` };
  }
  return { field: true, sure: false, why: 'looks like a field' };
}

/**
 * Split a recording's typing runs into the ones worth asking about and the ones to fold away.
 * Order is preserved inside each list, because a step number is how the wizard and the transcript agree.
 */
export function splitTyping(steps, windowTitleFor = () => null) {
  const fields = [];
  const aside = [];
  const list = steps || [];
  for (let i = 0; i < list.length; i++) {
    const step = list[i];
    /* What came next, when the caller handed us the whole sequence. `steps` here is sometimes only the
     * typing runs, in which case the neighbour is another run and commits() says no - which is the right
     * answer rather than a wrong one. */
    const next = list[i + 1];
    const committedBy = next && next.action === 'press' && next.pressed ? next.pressed : null;
    const verdict = classifyTyping(step, windowTitleFor(step), committedBy);
    (verdict.field ? fields : aside).push({ ...step, verdict });
  }
  return { fields, aside };
}
