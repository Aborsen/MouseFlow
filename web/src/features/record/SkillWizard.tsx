/* Turning a recording into a skill somebody else can run — including the part we deliberately did not watch.
 *
 * A recording knows where every click landed, in which application, on which named control, and that a key
 * was pressed and when. It does not know WHICH key, anywhere, ever: the hooks read that a key went down and
 * never touch the code, because a hook that reads key codes has captured a password whether or not it stores
 * one (docs/product/17-privacy-security.md). That is the design, and this is what it costs: a replay of a
 * recording that typed presses nothing, and reports the skipped events as `unplayable`.
 *
 * The answer is not to start capturing. A captured string is one INSTANCE - "Weekly report, 21 Aug" - and a
 * skill that always types last week's subject line is not a skill. To be a tool it needs a PARAMETER, and a
 * parameter has to be declared by somebody who knows what varies. So this asks, once, at the moment the
 * skill is made: you typed into "Subject" - should the skill ask for that each time, or always type the same
 * thing?
 *
 * WHAT COMES OUT IS A GOAL, NOT A MACRO, and that is the load-bearing decision here.
 *
 *   - The five-column replay format has no "type" action. Its vocabulary is mouse plus `Focus` and
 *     `Key Down`, and `Key Down` carries no key. Adding one means changing the parser in BOTH agents.
 *   - `/do` does type, but `/replay` is one shot: a hybrid would need a client orchestrating
 *     replay-segment, type, replay-segment, which is a third execution path to keep correct.
 *   - The goal path already types, because the model writes the text; already re-reads the screen, so a
 *     window that moved stops mattering; and already reaches an AI through the MCP server with its
 *     parameters typed and required. Nothing in either agent has to change.
 *
 * The cost is a model call per step - slower, and not free - which is exactly the trade `api/_skill-schema.mjs`
 * already states to a model in words: one is fragile and the other is slow. The literal replay stays where it
 * was, on the same menu, for the recordings that do not need to adapt.
 *
 * THE SKELETON IS DERIVED, NEVER GUESSED. Every step here comes from GET /api/transcript, which is the one
 * place that turns a payload into steps - the same numbering the panel shows and the assistant edits by. The
 * typing rows use `control` and `keys`, which that endpoint sends as FIELDS. Reading the field name back out
 * of its own prose was the alternative, and it would break the first time a sentence was reworded.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@insightis/ui/Popover';
import { CheckCheck, Keyboard, Loader2, X } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { type GoalSkillSource, saveAsGoalSkill } from './save-as-skill';
/* Which typing runs are fields and which are somebody pressing Enter. Lives beside the API rather than here
 * because the suite runs it for real against measured recordings, and a .tsx cannot be imported by Node. */
import { classifyTyping, type TypingVerdict } from './typing';
import type { Conflict, Unplaced } from '../../../../api/_compose.mjs';

/* ------------------------------------------------------------------ what the transcript sends */

interface TStep {
  n?: number;
  action?: string;
  what?: string;
  target?: string | null;
  /** Typing only, and null when the resolver could not read the field. Absent means "not known". */
  control?: string | null;
  controlType?: string | null;
  /** The UNLOCALISED accessibility role. `controlType` is the same thing in the reader's own language and
   *  is useless to classify on - see api/_typing.mjs. Absent on Windows, whose agent writes no role. */
  role?: string | null;
  keys?: number;
  /** The key's own name, for a step the recorder could name. Absent for anonymous typing. */
  pressed?: string | null;
}

interface TSegment {
  n?: number;
  where?: { kind?: string; label?: string; detail?: string };
  steps?: TStep[];
}

interface Transcript {
  ok?: true;
  segments?: TSegment[];
  summary?: { keys?: number };
}

/** A step with the segment it belongs to folded in, because the wizard reads them as one list. */
interface Line {
  n: number;
  action: string;
  what: string;
  target: string | null;
  control: string | null;
  controlType: string | null;
  role: string | null;
  keys: number;
  where: string | null;
  pressed: string | null;
}

/* ------------------------------------------------------------------ what the wizard decides */

type Fill = 'ask' | 'fixed' | 'skip';

interface Blank {
  /** The step this belongs to, so a dropped step drops its blank. */
  n: number;
  control: string | null;
  role: string | null;
  keys: number;
  /** Is this a place a skill could type, and was that read or guessed? From classifyTyping(). */
  verdict: TypingVerdict;
  fill: Fill;
  /** Which of the runs into this same control this one is, and how many there are. 0 when it is the only
   *  one, or when this is not a field at all. Nine runs into one "Prompt" made nine identical cards. */
  nth: number;
  of: number;
  /** For `ask`: the parameter's name and type. For `fixed`: the text to type. */
  param: string;
  type: 'quoted' | 'email' | 'url';
  fixed: string;
}

/* A field name is written for a person - "To", "Subject line", "Search the web" - and a parameter name is
 * written for a schema. Slugged rather than invented, so the two are recognisably the same thing. */
const slugOf = (control: string | null) => String(control || 'text')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 24) || 'text';

/* Two DIFFERENT controls can slug to the same word, and two parameters with one name is a skill that asks
 * for one thing and fills two. Separate from the numbering below, which is about the same control typed
 * into repeatedly - that one is numbered from 1, this one only breaks a tie. */
const unique = (want: string, taken: Set<string>) => {
  if (!taken.has(want)) return want;
  let n = 2;
  while (taken.has(`${want}${n}`)) n++;
  return `${want}${n}`;
};

const paramFromControl = (control: string | null, taken: Set<string>) => unique(slugOf(control), taken);

/* The three types `parameterise()` emits and `api/_skill-schema.mjs` knows how to describe. Guessed from the
 * field's own name, and only where the name is unambiguous: "To" and "Cc" in a mail window are addresses,
 * an address bar is a URL, everything else is text. A wrong guess is one click to fix and the schema says
 * what it means, which is why guessing at all is worth it. */
const typeFromControl = (control: string | null): Blank['type'] => {
  const name = String(control || '').toLowerCase();
  if (/^(to|cc|bcc|recipient|email|e-mail|from)\b/.test(name)) return 'email';
  if (/\b(url|address|link)\b/.test(name)) return 'url';
  return 'quoted';
};

const TYPE_LABEL: Record<Blank['type'], string> = {
  quoted: 'text',
  email: 'an email address',
  url: 'a URL',
};

/* ------------------------------------------------------------------ the goal */

/* Whether a step can become an instruction at all.
 *
 * A goal is carried out by a model reading the screen, so every line has to NAME what it acts on. The
 * transcript's `target` on a desktop click is the coordinate, not the control - "click 1030,1053" would put
 * back exactly the fragility this path exists to escape, and it would do it while looking like a sentence.
 * So a click contributes only when the resolver read a name for it, and a step that cannot be described is
 * said to be undescribable in the list rather than quietly dropped. */
function describable(line: Line): boolean {
  if (line.action === 'type') return true;
  if (line.action === 'scroll') return true;
  /* No control needed. Every other action here has to say what it landed on, because a click with no name
   * is a coordinate. A named key is not: "press Enter" determines itself. */
  if (line.action === 'press') return !!line.pressed;
  return !!line.control && ['click', 'dblclick', 'tab', 'drag', 'page'].includes(line.action);
}

/** One line of the goal, built from FIELDS rather than from the transcript's prose. */
/* MouseFlow's OWN recording controls, which are in the recording because of how it was made.
 *
 * Every recording started from the app ends with a click on "Stop and save this recording", and many begin
 * with a click on Start. Those clicks are bookkeeping ABOUT the recording, not part of the work it caught -
 * and a skill that faithfully repeats them ends by pressing Stop on a recorder nobody started, which is
 * what the first goal skill made here actually did.
 *
 * NARROW ON PURPOSE. Only the recorder's controls, not everything in MouseFlow: a click on "Make a skill"
 * or "Delete" is somebody USING the app, which is unlikely to be the task but is at least something they
 * did. Stopping the recording is the one action that is guaranteed not to be.
 *
 * Matched by name, which is safe HERE and nowhere else in this file: these are our own labels in our own
 * product, taken from our own source, and unlike a platform's control type they are not translated. The
 * strings are the ones the web app and both agents actually use - the app's button, the macOS menu-bar item
 * and the Windows tray item. */
const OWN_RECORDER_CONTROLS = new Set([
  'stop and save this recording',
  'stop and save recording',
  'start recording',
  'mouseflow agent - recording',
]);

const isOwnRecorderControl = (line: Line) =>
  OWN_RECORDER_CONTROLS.has(String(line.control || '').trim().toLowerCase());

/* Worth putting in front of somebody, as opposed to merely expressible.
 *
 * A scroll IS describable - `instruction()` turns it into "scroll to bring the next part into view" - and
 * it is still not worth a line. This kind of skill is carried out by a model reading the screen: it scrolls
 * when it needs to see something, and being told to scroll at step 14 tells it nothing it will not work out
 * for itself. One recording here held 1,732 wheel notches; as steps that is a wall, and in the goal it is a
 * wall the model reads too.
 *
 * So scrolls join the pointer moves and the unnamed clicks in the fold: left out by default, listed by
 * count, and one click away from being put back for the recording where a scroll really is the point. */
const worthShowing = (line: Line) =>
  describable(line) && line.action !== 'scroll' && !isOwnRecorderControl(line);

function instruction(line: Line, blank: Blank | undefined): string | null {
  if (line.action === 'type') {
    if (!blank || blank.fill === 'skip') return null;
    const value = blank.fill === 'ask' ? `{{${blank.param}}}` : blank.fixed.trim();
    if (!value) return null;
    const where = line.control ? ` into "${line.control}"` : '';
    return `type ${blank.fill === 'ask' ? value : `"${value}"`}${where}`;
  }
  const named = line.control ? `"${line.control}"` : null;
  switch (line.action) {
    case 'click': return named ? `click ${named}` : null;
    case 'dblclick': return named ? `double-click ${named}` : null;
    case 'tab': return named ? `switch to ${named}` : null;
    case 'drag': return named ? `drag ${named}` : null;
    case 'page': return named ? `open ${named}` : null;
    case 'scroll': return 'scroll to bring the next part into view';
    /* A key that was NAMED is an instruction, and usually the most important one in the recording: it is
     * where the work was committed. Without it a skill types the message and never sends it, which is a
     * failure nobody sees until it runs on a real machine.
     *
     * It stands without a control name, unlike a click. "Press Enter" is complete; "click" is not - a click
     * needs to say what it landed on, and that is why every other branch here returns null without one. */
    case 'press': return line.pressed
      ? `press ${line.pressed}${line.control ? ` in "${line.control}"` : ''}`
      : null;
    /* `wait`, `move`, `key` and `other` are things that HAPPENED, not things to do. A goal that told a model
     * to reproduce a pause would spend a step on it - and anonymous typing cannot say what to type. */
    default: return null;
  }
}

/* The goal in PIECES, because two callers want different halves of it.
 *
 * The wizard wants the finished sentence. /api/compose wants the steps with their own numbers still on
 * them, because a note is placed by saying which step it follows - and the numbers are the recording's,
 * with gaps in them where steps were dropped, not positions in a list. Building the string and then
 * parsing the numbers back out of it is the mistake this file's header already warns about once. */
function goalParts(lines: Line[], kept: Set<number>, blanks: Blank[]) {
  const byStep = new Map(blanks.map((b) => [b.n, b]));
  const wheres = [...new Set(lines.filter((l) => kept.has(l.n) && l.where).map((l) => l.where as string))];
  const steps: { n: number; instruction: string }[] = [];
  for (const line of lines) {
    if (!kept.has(line.n)) continue;
    const said = instruction(line, byStep.get(line.n));
    if (said) steps.push({ n: line.n, instruction: said });
  }
  const opening = wheres.length
    ? `In ${wheres.slice(0, 2).join(' and ')}, do this:`
    : 'Do this on the computer:';
  return { opening, steps };
}

/* A ceiling on the goal, and one that cannot bite the thing it is meant to protect.
 *
 * The field capped typing at 4,000 characters while the DERIVED goal has no cap at all: buildGoal joins
 * however many steps were ticked. A long recording therefore arrived in the box already over the line, and
 * the first keystroke anywhere in it silently threw away everything past 4,000 - steps the person had just
 * chosen, gone, with no way to tell from the screen.
 *
 * So it only ever stops the text GROWING past the limit. Text that is already longer can still be edited,
 * shortened and rearranged; what it cannot do is get longer. The limit itself is generous enough that
 * nothing derived reaches it - it is a guard against a paste of a novel, not a budget. */
const GOAL_MAX = 20_000;

const capped = (next: string, was: string) => {
  if (next.length <= GOAL_MAX) return next;
  /* Already over the line before this keystroke. Editing, shortening and rearranging all still work;
   * growth is REFUSED rather than trimmed, because trimming here is the original bug at a higher number -
   * the first version of this fix still cut 25,000 characters down to 20,000 on one keypress. */
  if (was.length > GOAL_MAX) return next.length <= was.length ? next : was;
  /* It was under, and this one change put it over: a paste of something enormous. Trimmed rather than
   * refused, so something visibly arrives instead of the field appearing to ignore the paste. */
  return next.slice(0, GOAL_MAX);
};

function buildGoal(lines: Line[], kept: Set<number>, blanks: Blank[]): string {
  const { opening, steps } = goalParts(lines, kept, blanks);
  if (!steps.length) return '';
  return `${opening}\n${steps
    .map((s, i) => `${i + 1}. ${s.instruction[0].toUpperCase()}${s.instruction.slice(1)}.`)
    .join('\n')}`;
}

/* Whatever the person added in their own words, on the end of the derived steps.
 *
 * It goes into the GOAL rather than into a field of its own, and that is the whole reason this is worth
 * anything: a skill made here is a goal skill — the sentence is what a model reads and carries out, one
 * action at a time. So "then press Save", or "type today's date in the reference box", is executed, not
 * decoration. Text in a field nobody executes would be a note to self dressed up as a feature.
 *
 * Appended rather than woven in, because the steps above are derived and this is not: keeping them apart
 * means the derived half can be rebuilt when a checkbox moves without touching what somebody wrote. */
function withNotes(base: string, notes: string): string {
  const said = notes.trim();
  if (!said) return base;
  if (!base) return said;
  return `${base}\n\nAlso:\n${said}`;
}

/* ------------------------------------------------------------------ the wizard */

/* Saying what was typed, on the step it happened, in a popover.
 *
 * WHY HERE AND NOT ONLY ON STEP 2. Step 2 is a screen of cards away from the thing each card is about: a
 * card says Into "Prompt" and the recording said `typed for 31.5s - 136 keystrokes into "Prompt" in Claude`,
 * and the second one is the sentence somebody recognises. Answering beside the sentence is answering a
 * question you can still see the context of.
 *
 * THE TEXT BOX IS THE PRIMARY CONTROL, and that is the whole point of the shape. The old screen led with
 * three abstract choices - ask / always the same / nothing - which is a question about parameters asked of
 * somebody who has never met one. Here the first thing is a box and the question above it is "what did you
 * type here?", which anybody can answer. The three choices are underneath, and typing into the box picks
 * one of them for you.
 *
 * Step 2 keeps its cards. This is not a replacement for it - somebody who wants to see every blank at once,
 * or set all of them together, still has that - and both edit the same Blank, so the two screens can never
 * disagree.
 */
const CHIP_TEXT_MAX = 22;

function chipOf(b: Blank): { label: string; set: boolean } {
  if (b.fill === 'skip') return { label: 'types nothing', set: true };
  if (b.fill === 'fixed') {
    const said = b.fixed.trim();
    if (!said) return { label: 'what was typed?', set: false };
    const short = said.length > CHIP_TEXT_MAX ? `${said.slice(0, CHIP_TEXT_MAX - 1)}…` : said;
    return { label: `“${short}”`, set: true };
  }
  return { label: 'will ask each time', set: true };
}

const WhatWasTyped = ({ blank, onEdit }: {
  blank: Blank;
  onEdit: (patch: Partial<Blank>) => void;
}) => {
  /* A typing run that is NOT a field gets a chip too, and this is a fix rather than a decoration.
   *
   * Without one the row looked identical to a field's - highlighted, keyboard icon - and simply had nowhere
   * to answer. The first person to see it asked why some typing rows could be filled in and others could
   * not, which is the screen failing to say something it knows. It knows exactly why: the keys went to a
   * dialog, or to something with no name, and `verdict.why` is that sentence already. */
  const isField = blank.verdict.field;
  const chip = isField ? chipOf(blank) : { label: 'keys, not text', set: true };
  /* Typing picks "always this text" for you - but only from the untouched state. Somebody who deliberately
   * chose "ask" and then types a note to themselves must not have that choice taken back off them, so the
   * switch fires on the first keystroke into an empty box and never again. */
  const write = (value: string) => {
    const first = blank.fill === 'ask' && !blank.fixed;
    onEdit({ fixed: value, ...(first && value ? { fill: 'fixed' as Fill } : {}) });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'shrink-0 rounded-md border px-2 py-0.5 text-[0.76rem] transition-colors duration-fast',
            'max-w-[13rem] truncate',
            /* Three weights, and the order is deliberate: the one that WANTS an answer is loudest, the one
             * that has an answer is quiet, and the one that is only explaining itself barely a control at
             * all - it is there to be read, and clickable in case the reading is wrong. */
            !isField
              ? 'border-transparent text-ink-inactive hover:bg-state-hover'
              : chip.set
                ? 'border-stroke bg-surface-card2 text-ink-secondary hover:bg-state-hover'
                : 'border-brand-primary/45 bg-brand-primary/10 text-brand-primary hover:bg-brand-primary/20',
          )}
        >
          {chip.label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[19rem]">
        {!isField ? (
          <>
            <Typography variant="span" weight="semibold" className="block text-[0.88rem]">
              Nothing to type here
            </Typography>
            <Typography variant="p" className="mt-1 text-[0.82rem] text-ink-inactive leading-relaxed">
              {blank.keys
                ? `${blank.keys === 1 ? 'That 1 keystroke' : `Those ${blank.keys} keystrokes`} went to `
                : 'The keys went to '}
              {blank.control ? `“${blank.control}”` : 'something with no name'} — {blank.verdict.why}
              {blank.verdict.sure ? '' : ', as far as it could tell'}. Enter, Tab and keyboard shortcuts
              land like that, so there is nothing here for the skill to type.
            </Typography>
            <Button
              variant="secondary"
              size="xs"
              className="mt-2.5"
              onClick={() => onEdit({ fill: 'ask', verdict: { ...blank.verdict, field: true } })}
            >
              It is a field →
            </Button>
          </>
        ) : (
        <>
        <Typography variant="span" weight="semibold" className="block text-[0.88rem]">
          What did you type here?
        </Typography>
        <Typography variant="p" className="mt-0.5 mb-2 truncate text-[0.78rem] text-ink-inactive">
          {blank.control ? `into “${blank.control}”` : 'the field could not be named'}
          {blank.of > 1 ? ` ${blank.nth} of ${blank.of}` : ''}
          {blank.keys ? ` · ${blank.keys} keystroke${blank.keys === 1 ? '' : 's'}` : ''}
        </Typography>

        <input
          autoFocus
          value={blank.fixed}
          onChange={(e) => write(e.target.value)}
          placeholder="the text"
          className={cn(
            'h-9 w-full rounded-md border border-stroke bg-surface-card2 px-2.5 text-[0.85rem]',
            'text-ink-primary placeholder:text-ink-inactive focus:border-brand-primary focus:outline-none',
            blank.fill !== 'fixed' && 'opacity-60',
          )}
        />

        <div className="mt-2.5 grid grid-cols-[minmax(0,1fr)] gap-1.5">
          {([
            ['fixed', 'Type this every time'],
            ['ask', 'Ask each time it runs'],
            ['skip', 'Type nothing'],
          ] as [Fill, string][]).map(([f, label]) => (
            <label key={f} className="flex cursor-pointer items-center gap-2 text-[0.82rem] text-ink-body">
              <input
                type="radio"
                name={`fill-${blank.n}`}
                checked={blank.fill === f}
                onChange={() => onEdit({ fill: f })}
                className="size-3.5 shrink-0 accent-brand-primary"
              />
              {label}
            </label>
          ))}
        </div>

        {/* Only under the choice it belongs to. A parameter name shown next to "type nothing" is a control
          * for something that is not happening. */}
        {blank.fill === 'ask' && (
          <div className="mt-2 border-stroke/60 border-t pt-2">
            <Typography variant="span" className="block text-[0.76rem] text-ink-inactive">
              It becomes an input on the skill, called:
            </Typography>
            <input
              value={blank.param}
              onChange={(e) => onEdit({ param: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })}
              placeholder="what to call it"
              className={cn(
                'mt-1 h-8 w-full rounded-md border border-stroke bg-surface-card2 px-2',
                'font-mono text-[0.8rem] text-ink-primary focus:border-brand-primary focus:outline-none',
              )}
            />
          </div>
        )}
        </>
        )}
      </PopoverContent>
    </Popover>
  );
};

/* "What to type" was the name while the step could only ever be about the recorded typing — and when a
 * recording had none, it was a screen with a sentence on it and nothing to do. It takes instructions in
 * general now, of which "type this here" is one. */
const STAGES = ['What it did', 'Instructions', 'Name it'] as const;

interface Props {
  /** Four fields, not a whole Recording - see GoalSkillSource. The steps come from
   *  /api/transcript, keyed on rec.id, so this works for a recording this browser does not hold. */
  rec: GoalSkillSource;
  onClose: () => void;
  onSaved: (name: string) => void;
}

export const SkillWizard = ({ rec, onClose, onSaved }: Props) => {
  const [stage, setStage] = useState(0);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [kept, setKept] = useState<Set<number>>(new Set());
  const [blanks, setBlanks] = useState<Blank[]>([]);
  const [name, setName] = useState(rec.name);
  const [goal, setGoal] = useState('');
  /* Anything the recording could not say. Free text, in the person's own words, appended to the goal. */
  const [notes, setNotes] = useState('');
  /* Как понять, что получилось. Отдельно от заметок и НЕ в тексте цели.
   *
   * Заметки исполняются - они дописываются в цель, и модель делает то, что там написано. Признак
   * готовности исполнять нельзя: это проверка, а не шаг, и модель, получившая её одной строкой вместе с
   * целью, начнёт её выполнять. Поэтому своё поле и своя дорога до самого низа. */
  const [success, setSuccess] = useState('');
  const [touchedGoal, setTouchedGoal] = useState(false);
  /* The folded-away keypresses, shut by default. Open is the exception - it exists so a wrong classification
   * is correctable, not so everybody reads a list of Enters. */
  const [showAside, setShowAside] = useState(false);
  /* Whether the steps that cannot be described are on screen. Shut by default: on a 546-step recording they
   * are the majority of the list, each carrying three lines saying the same thing, and a person scrolling
   * past four hundred of them is not reading any of them. */
  const [showAll, setShowAll] = useState(false);
  /* What /api/compose made of the notes, when it was asked and answered. `plan` holds only the two things
   * that are NOT applied - what clashes and what could not be placed - because everything else it decided
   * is already in the goal text below. Null means the plain append was used. */
  const [plan, setPlan] = useState<null | { conflicts: Conflict[]; unplaced: Unplaced[]; placed: number }>(null);
  const [composing, setComposing] = useState(false);
  /* Why it fell back, when it did. Shown as one quiet line: a model that was busy is not an error somebody
   * has to act on, but it does change what the goal on the next screen says, so it is not silent either. */
  const [composeNote, setComposeNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const res = await fetch(`/api/transcript?flow=${encodeURIComponent(rec.id)}`, {
          credentials: 'same-origin',
        });
        if (res.status === 404) {
          throw new Error('This recording has not reached your account yet, and the steps are read from '
            + 'there. It syncs on its own; try again in a moment.');
        }
        const body = (await res.json()) as Transcript;
        if (!res.ok || !body || !body.ok) throw new Error('The steps could not be read.');
        if (gone) return;

        const flat: Line[] = [];
        for (const segment of body.segments ?? []) {
          const where = segment.where && segment.where.label ? segment.where.label : null;
          for (const step of segment.steps ?? []) {
            if (typeof step.n !== 'number') continue;
            flat.push({
              n: step.n,
              action: step.action ?? 'other',
              what: step.what ?? '',
              target: step.target ?? null,
              control: step.control ?? null,
              controlType: step.controlType ?? null,
              role: step.role ?? null,
              keys: step.keys ?? 0,
              pressed: step.pressed ?? null,
              where,
            });
          }
        }
        setLines(flat);
        /* Everything DESCRIBABLE is in to start with. A step whose target had no name cannot become an
         * instruction, so leaving it on would put a tick beside a row that contributes nothing - which reads
         * as "this is in the skill" and is not. It stays in the list, switched off, saying why. */
        setKept(new Set(flat.filter(worthShowing).map((l) => l.n)));

        /* Is this a field, or is it Enter? See api/_typing.mjs - on a measured 6,617-event recording nine
         * of thirteen typing runs were one text box and the other four were keys pressed at a dialog. */
        const typed = flat.filter((l) => l.action === 'type');
        /* WHAT ENDED EACH RUN, taken from the FULL list rather than from the typing runs alone.
         *
         * A run committed with Return is a field as a matter of fact, not of guesswork - nobody presses
         * Enter at a canvas. That evidence only exists from agent 0.9.4, which is the build that names the
         * keys carrying no text, and it matters most on Windows, whose agent writes no accessibility role
         * at all and therefore always took the guess path. Read off `flat`, because in `typed` the next
         * entry is the next typing run and the commit between them has been filtered out. */
        const after = new Map<number, string | null>();
        for (let i = 0; i < flat.length; i++) {
          if (flat[i].action !== 'type') continue;
          const next = flat[i + 1];
          after.set(flat[i].n, next && next.action === 'press' ? next.pressed ?? null : null);
        }
        const verdicts = new Map(
          typed.map((l) => [l.n, classifyTyping(l, l.where, after.get(l.n) ?? null)]),
        );

        /* How many FIELD runs share a control, counted before any of them is named.
         *
         * The same box typed into nine times is nine runs, and they are not the same value: nine prompts in
         * a chat are nine different sentences. So they stay nine parameters - but they have to be tellable
         * apart, and `prompt, prompt2, prompt3` is a list where only the first is unnumbered, which reads as
         * if it were the odd one out. Counted first so that the first of several can be `prompt1`, which is
         * only knowable once the total is. */
        const totals = new Map<string, number>();
        for (const l of typed) {
          if (!verdicts.get(l.n)?.field) continue;
          const base = slugOf(l.control);
          totals.set(base, (totals.get(base) ?? 0) + 1);
        }

        const soFar = new Map<string, number>();
        const taken = new Set<string>();
        setBlanks(typed.map((l) => {
          const verdict = verdicts.get(l.n) as TypingVerdict;
          const base = slugOf(l.control);
          const of = verdict.field ? (totals.get(base) ?? 1) : 0;
          const nth = verdict.field ? (soFar.get(base) ?? 0) + 1 : 0;
          if (verdict.field) soFar.set(base, nth);
          /* A parameter name is only spent on something that could take one. Numbering them from the whole
           * list would give the first real field a name like `text4`, counted off three keypresses. */
          const param = verdict.field ? unique(of > 1 ? `${base}${nth}` : base, taken) : '';
          if (param) taken.add(param);
          return {
            n: l.n,
            control: l.control,
            role: l.role,
            keys: l.keys,
            verdict,
            nth,
            of,
            /* Asking is the default for a FIELD, because that is what makes this a tool rather than a macro.
             * For everything else it is `skip`, and the screen says so in one line rather than in a card:
             * offering to parameterise an Enter keypress is how nineteen questions happened. That default is
             * stated, never silent - the objection to it was always the silence, not the choice. */
            fill: (verdict.field ? 'ask' : 'skip') as Fill,
            param,
            type: typeFromControl(l.control),
            fixed: '',
          };
        }));
      } catch (err) {
        if (!gone) setProblem(err instanceof Error ? err.message : 'The steps could not be read.');
      }
    })();
    return () => { gone = true; };
  }, [rec.id]);

  const typing = useMemo(() => blanks.filter((b) => kept.has(b.n)), [blanks, kept]);
  /* The two halves of step 2. `fields` get a card each and a real question; `aside` gets one line saying how
   * many there were and that nothing will be typed at them, with a way in for the rare case the classifier
   * was wrong. Splitting on the STORED verdict rather than re-running the classifier keeps the card a person
   * is looking at from moving underneath them when they rename a control. */
  /* Step 1 asks each row for its blank. A Map rather than a find() per row: a 546-step recording renders
   * 546 rows, and a linear scan inside each of them is the kind of thing that turns a list into a stutter. */
  const blankOf = useMemo(() => new Map(blanks.map((b) => [b.n, b])), [blanks]);
  /* The steps that can become instructions, and the ones that cannot. A step with no name under it is not
   * a step a skill can be told to do - `instruction()` returns null for it either way - so hiding it hides
   * nothing that was going to happen. */
  const describables = useMemo(() => (lines ?? []).filter(worthShowing), [lines]);
  const hidden = (lines?.length ?? 0) - describables.length;
  const shown = showAll ? (lines ?? []) : describables;
  const fields = useMemo(() => typing.filter((b) => b.verdict.field), [typing]);
  const aside = useMemo(() => typing.filter((b) => !b.verdict.field), [typing]);
  const asked = useMemo(() => typing.filter((b) => b.fill === 'ask'), [typing]);

  const derived = useMemo(
    () => (lines ? withNotes(buildGoal(lines, kept, blanks), notes) : ''),
    [lines, kept, blanks, notes],
  );

  /* The goal follows the choices until somebody edits it, and then it is theirs. Overwriting a sentence
   * a person wrote because a checkbox moved is the kind of helpfulness that loses work.
   *
   * A composed goal counts as theirs too: it is the answer to what they wrote, and rebuilding it from the
   * checkboxes would throw that away the moment any state below it changed. Going Back clears it, which is
   * what makes a second pass possible. */
  useEffect(() => { if (!touchedGoal && !plan) setGoal(derived); }, [derived, touchedGoal, plan]);

  const toggle = useCallback((n: number) => {
    setKept((was) => {
      const next = new Set(was);
      if (next.has(n)) next.delete(n); else next.add(n);
      return next;
    });
  }, []);

  /* Keep everything, or keep nothing, in one click.
   *
   * The list opens with only the steps that could be described ticked, which is the right default and the
   * wrong amount of work for the commonest case there is: repeat what I just did, all of it. Fourteen
   * checkboxes to say "yes" is a form standing between somebody and a replay of their own recording — and
   * a long recording makes it thirty.
   *
   * "None" is here because the pair is what makes either one safe to press: having taken everything, the
   * way back to a considered selection should not be fourteen clicks either. */
  /* "Everything" means everything that can be described. A tick beside a step that contributes nothing to
   * the goal reads as "this is in the skill" and is not - which is the same lie the list already avoids by
   * starting them unticked. */
  const allKept = describables.length > 0 && describables.every((line) => kept.has(line.n));
  const keepAll = useCallback(() => {
    setKept(new Set((lines ?? []).filter(worthShowing).map((line) => line.n)));
  }, [lines]);
  const keepNone = useCallback(() => setKept(new Set()), []);

  const edit = useCallback((n: number, patch: Partial<Blank>) => {
    setBlanks((was) => was.map((b) => {
      if (b.n !== n) return b;
      const next = { ...b, ...patch };
      /* Anything switched to "ask" needs a name, and a blank the classifier folded away was never given one -
       * spending parameter names on keypresses is what this change exists to stop. Derived at the moment it
       * becomes needed, against the names already taken, so overriding the classifier does not hand somebody
       * an empty box and a disabled Next button with no explanation. */
      if (next.fill === 'ask' && !next.param.trim()) {
        const taken = new Set(was.filter((o) => o.n !== n && o.param).map((o) => o.param));
        next.param = paramFromControl(next.control, taken);
      }
      return next;
    }));
  }, []);

  const unnamed = typing.some((b) => b.fill === 'ask' && !b.param.trim());
  const unfilled = typing.some((b) => b.fill === 'fixed' && !b.fixed.trim());

  /* Ask /api/compose to put the notes onto the steps, on the way to the last screen.
   *
   * Here rather than at run time, and that is the whole design: "finish by pressing Send, not Save" is a
   * change to the PLAN, and the thing that carries a goal out decides one action at a time on somebody's
   * real computer - it may well have clicked Save before it reads the sentence saying not to. Done now, the
   * person who just did the work is still on screen and sees the result before it becomes a skill.
   *
   * Every failure path ends in the plain append, which is what this did before the route existed. A model
   * being busy must not be able to stop somebody saving a skill. */
  const compose = async () => {
    if (!lines) return;
    const said = notes.trim();
    const { opening, steps } = goalParts(lines, kept, blanks);
    if (!said || !steps.length) return;

    setComposing(true);
    setComposeNote(null);
    try {
      const res = await fetch('/api/compose', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ steps, notes: said, opening }),
      });
      const body = await res.json();
      if (body && body.ok && typeof body.text === 'string' && body.text.trim()) {
        setGoal(body.text);
        setPlan({
          conflicts: Array.isArray(body.conflicts) ? body.conflicts : [],
          unplaced: Array.isArray(body.unplaced) ? body.unplaced : [],
          placed: Array.isArray(body.inserted) ? body.inserted.length : 0,
        });
      } else {
        setPlan(null);
        setGoal(withNotes(buildGoal(lines, kept, blanks), notes));
        setComposeNote(typeof body?.why === 'string' ? body.why : 'the notes were added as written');
      }
    } catch (_) {
      /* Offline, or the route is not on this deployment. Same answer either way. */
      setPlan(null);
      setGoal(withNotes(buildGoal(lines, kept, blanks), notes));
      setComposeNote('the notes were added as written');
    }
    setComposing(false);
  };

  const save = async () => {
    if (!lines) return;
    setSaving(true);
    setProblem(null);
    try {
      const params = typing
        .filter((b) => b.fill === 'ask')
        .map((b) => ({
          name: b.param.trim(),
          type: b.type,
          /* No example. An example is the AUTHOR's own value and fillGoal falls back to it, so a skill
           * with one runs somebody else's errand when a field is left blank. A parameter with no example
           * is REQUIRED, which is what asking each time means. */
          example: null,
        }));
      const steps = lines
        .filter((l) => kept.has(l.n))
        .map((l) => ({ name: l.what || l.action, input: l.control }));
      await saveAsGoalSkill(rec, {
        name: name.trim() || rec.name, goal: goal.trim(), params, steps, success: success.trim() || null,
      });
      onSaved(name.trim() || rec.name);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'It could not be saved.');
      setSaving(false);
    }
  };

  const canGo = stage === 0
    ? !!lines && kept.size > 0
    : stage === 1
      ? !unnamed && !unfilled
      : !!goal.trim() && !!name.trim();

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55" />
        <Dialog.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex w-[min(760px,calc(100vw-2rem))] -translate-x-1/2',
            '-translate-y-1/2 flex-col overflow-hidden rounded-xl border border-stroke bg-surface-card',
            'shadow-dropdown',
          )}
        >
          {/* Название и шаги - на разных строках. В один ряд они помещались только на широком экране, а на
            * узком фишки уезжали под заголовок и читались как продолжение имени записи. */}
          <header className="border-stroke border-b px-4 py-3">
            <div className="flex items-start gap-3">
              <Dialog.Title asChild>
                <Typography variant="h2" weight="semibold" className="min-w-0 flex-1 truncate text-[1rem]">
                  Make a skill from “{rec.name}”
                </Typography>
              </Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="xs" aria-label="Close"><X className="size-4" /></Button>
              </Dialog.Close>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {STAGES.map((label, i) => (
                <span
                  key={label}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[0.72rem] whitespace-nowrap',
                    i === stage ? 'on-accent bg-brand-primary font-semibold'
                      : i < stage ? 'text-ink-secondary' : 'text-ink-inactive',
                  )}
                >
                  {i + 1}. {label}
                </span>
              ))}
            </div>
          </header>

          {/* One height, always.
            *
            * It used to be `max-h-60vh min-h-280px`, which is a range, and a range means the dialog was a
            * different size on every recording and on every step of the same one: a four-step list opened
            * short, a 546-step list opened tall, and moving between steps 1, 2 and 3 resized it under the
            * cursor - with Next moving as it went. Fixed, so the only thing that changes when a step
            * changes is what is inside it. Bounded top and bottom for a small window and a very tall one. */}
          <div className="h-[60vh] max-h-[34rem] min-h-[20rem] overflow-auto px-4 py-3.5">
            {problem && (
              <div className="mb-3 rounded-lg border border-toast-border-error bg-toast-bg-error px-3 py-2.5 text-[0.85rem] text-fb-red-text">
                {problem}
              </div>
            )}

            {!lines && !problem && (
              <div className="flex items-center gap-2 text-ink-inactive text-[0.88rem]">
                <Loader2 className="size-4 animate-spin" /> Reading what this recording did…
              </div>
            )}

            {lines && stage === 0 && (
              <>
                <Typography variant="p" className="mb-3 text-ink-inactive text-[0.85rem] leading-relaxed">
                  This is the recording, step by step. Leave out anything the skill should not do — a stray
                  click, a scroll that was only looking. {fields.length > 0 && (
                    <>The <span className="text-ink-body">highlighted</span> rows are where you typed — what
                    you typed was never recorded, so say it here.</>
                  )}
                </Typography>
                {/* Above the list, where the eye lands before it starts ticking. */}
                <div className="mb-2 flex items-center gap-2">
                  <Button
                    variant={allKept ? 'secondary' : 'ghost'}
                    size="xs"
                    onClick={keepAll}
                    title="Keep every step — repeat the recording exactly as it was"
                    leftSlot={<CheckCheck className="size-3.5" />}
                  >
                    Select all
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={keepNone}
                    disabled={kept.size === 0}
                    title="Untick everything and start from nothing"
                  >
                    None
                  </Button>
                  <Typography variant="span" className="ms-auto text-[0.76rem] text-ink-inactive">
                    {kept.size} of {describables.length} kept
                  </Typography>
                </div>
                {/* Everything folded away, which is a real recording and not an error state.
                  *
                  * A recording whose only step is the click that stopped it produces an empty list once the
                  * recorder's own controls are folded - and an empty list under a disabled Next, with no
                  * sentence, reads as a broken screen. It is not: there is genuinely nothing here that could
                  * become a skill, and saying which is the difference between a dead end and an answer. */}
                {shown.length === 0 && (
                  <Typography variant="p" className="rounded-lg border border-stroke bg-surface-card2 px-3 py-2.5 text-[0.85rem] text-ink-body leading-relaxed">
                    Nothing in this recording can become a skill.{' '}
                    {lines.length === hidden && hidden > 0
                      ? 'All of it is pointer movement, waiting, scrolling, or starting and stopping the '
                        + 'recording itself.'
                      : 'Every step was left out.'}
                    {' '}Record the work you want repeated, then make a skill from that.
                  </Typography>
                )}
                <ul className="grid grid-cols-[minmax(0,1fr)] gap-1">
                  {shown.map((line) => {
                    const isTyping = line.action === 'type';
                    const on = kept.has(line.n);
                    /* Only a FIELD gets the chip. Offering "what did you type here?" beside an Enter keypress
                     * is the same nineteen questions the folding on step 2 exists to remove, just moved. */
                    const blank = blankOf.get(line.n);
                    /* Every KEPT typing step, field or not. A row that was dropped from the skill has
                     * nothing to say about what it types, so it keeps the plain icon. */
                    const askable = !!blank && on;
                    return (
                      /* The chip sits OUTSIDE the label. Inside it, every click on it would also reach the
                       * label and toggle the checkbox — the row would drop out of the skill at the exact
                       * moment somebody opened the popover to say what it types. */
                      <li
                        key={line.n}
                        className={cn(
                          /* Wrapping below `sm`: the chip that says what a step types does not shrink, and
                             beside it the step's own description was squeezed to 56px in the panel. There
                             the chip goes under the line it belongs to. */
                          'flex flex-wrap items-start gap-2 rounded-lg px-2.5 py-1.5',
                          'hover:bg-state-hover',
                          isTyping && 'bg-brand-primary/10',
                          !on && 'opacity-45',
                        )}
                      >
                        <label className="flex min-w-0 flex-1 basis-full cursor-pointer items-start gap-2.5 sm:basis-auto">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggle(line.n)}
                            className="mt-1 size-3.5 shrink-0 accent-brand-primary"
                          />
                          <span className="w-6 shrink-0 pt-px text-right text-[0.75rem] text-ink-inactive tabular-nums">
                            {line.n}
                          </span>
                          <span className="min-w-0 flex-1 text-[0.86rem] text-ink-body">
                            {line.what || line.action}
                            {!describable(line) && (
                              <span className="block text-[0.76rem] text-ink-inactive">
                                Nothing there had a name the agent could read, so this cannot be described to
                                the skill — only its coordinates were recorded, and those are what this kind
                                of skill exists to stop depending on.
                              </span>
                            )}
                          </span>
                        </label>
                        {askable
                          ? <WhatWasTyped blank={blank} onEdit={(patch) => edit(line.n, patch)} />
                          : isTyping
                            ? <Keyboard aria-hidden className="mt-0.5 size-4 shrink-0 text-brand-primary" />
                            : null}
                      </li>
                    );
                  })}
                </ul>
                {/* What was left out, said rather than simply absent.
                  *
                  * These are pointer moves, waits, and clicks on things the accessibility layer could not
                  * name. None of them can become an instruction - a goal is carried out by a model reading
                  * the screen, and "click 1030,1053" would put back exactly the fragility this kind of skill
                  * exists to escape - so hiding them hides nothing that was going to happen.
                  *
                  * But a recording of 546 steps that shows 90 is a claim about what was recorded, and the
                  * page has to make that claim out loud. One line, with the count and a way in. */}
                {hidden > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-stroke bg-surface-card2 px-3 py-2">
                    <Typography variant="span" className="text-[0.82rem] text-ink-inactive">
                      {hidden} more step{hidden === 1 ? '' : 's'} left out — pointer moves, waits,
                      scrolls, clicks on things with no name, and starting or stopping this recording.
                      Show them to put any back.
                    </Typography>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="ms-auto"
                      onClick={() => setShowAll((was) => !was)}
                    >
                      {showAll ? 'Hide' : 'Show'}
                    </Button>
                  </div>
                )}
              </>
            )}

            {lines && stage === 1 && (
              <>
                {/* Anything the recording could not say, in the person's own words.
                  *
                  * This step used to be a dead end whenever nothing had been typed: one sentence explaining
                  * that there was nothing to fill in, and no field at all. But a recording is coordinates
                  * and timings — it cannot know that the second box wants today's date, that the dialog is
                  * skipped when a row already exists, or which button ends the job. That knowledge only
                  * exists in the head of the person who just did it, and this is the moment they are here.
                  *
                  * It goes into the goal, which for a skill made here is the sentence a model reads and
                  * carries out. So this is executed rather than filed. */}
                <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
                  <Typography variant="span" weight="semibold" className="text-[0.86rem]">
                    Anything else it should know
                  </Typography>
                  <Typography variant="p" className="text-ink-inactive text-[0.82rem] leading-relaxed">
                    Optional. The recording has the clicks; this is for what it cannot see.
                  </Typography>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value.slice(0, 2000))}
                    rows={6}
                    placeholder={'Add instructions in your own words — including any text it should type.\n\n'
                      + 'For example:\n'
                      + '• Type today’s date in the reference box\n'
                      + '• If a row for this client already exists, stop and say so\n'
                      + '• Finish by pressing Save, not Send'}
                    className="w-full resize-y rounded-lg border border-stroke bg-surface-card2 px-3 py-2 text-[0.86rem] text-ink-primary leading-relaxed placeholder:text-ink-inactive focus:border-brand-primary focus:outline-none"
                  />
                  <Typography variant="span" className="text-[0.78rem] text-ink-inactive">
                    This is added to the skill’s instructions, which you can read and edit on the next step.
                  </Typography>
                </div>

                {/* НЕ инструкция, а проверка - поэтому отдельное поле, а не ещё один абзац в заметках.
                  *
                  * Что оно даёт и чего не даёт, стоит держать в голове: сравнивать экран до и после никто
                  * не будет, цикл этого не умеет. Меняется смысл слова «получилось»: без этого поля прогон
                  * успешен потому, что так сказала модель, и опровергнуть это нечем; с ним модель
                  * утверждает названное условие, и человек, читающий журнал, может сказать «нет, этого не
                  * произошло». */}
                <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
                  <Typography variant="span" weight="semibold" className="text-[0.86rem]">
                    How you can tell it worked
                  </Typography>
                  <Typography variant="p" className="text-ink-inactive text-[0.82rem] leading-relaxed">
                    Optional, and it is checked rather than carried out — one thing that is true at the end
                    and was not true at the start.
                  </Typography>
                  <textarea
                    value={success}
                    onChange={(e) => setSuccess(e.target.value.slice(0, 400))}
                    rows={2}
                    placeholder={'For example: the message appears in Sent, with today’s date.'}
                    className="w-full resize-y rounded-lg border border-stroke bg-surface-card2 px-3 py-2 text-[0.86rem] text-ink-primary leading-relaxed placeholder:text-ink-inactive focus:border-brand-primary focus:outline-none"
                  />
                  <Typography variant="span" className="text-[0.78rem] text-ink-inactive">
                    The agent is told this before it starts and checks it before saying it finished. It does
                    not compare the screen for you — it makes “done” a claim you can disagree with.
                  </Typography>
                </div>

                {/* Под свободным текстом, а не над ним.
                  *
                  * Свободный текст можно написать всегда и про любую запись. Карточки ниже - ответ на
                  * вопрос, который задаёт САМА запись, и их может не быть вовсе: у записи без набора
                  * текста их ноль. Экран, начинавшийся с карточек, начинался с частного случая и прятал
                  * под ним то, что нужно всем. */}
                {/* The recorded typing, when there was any. A blank is a place the recording KNOWS
                  * something was typed and cannot know what; it is a different thing from the free text
                  * below, which is anything the recording could not know at all. */}
                {fields.length > 0 && (
                <div className="mt-5 border-stroke border-t pt-4">
                  {/* Setting them one at a time is fine for two and absurd for nineteen — and nineteen is
                    * what a long recording produces. A skill that asks for eighteen inputs before it will
                    * run is a skill nobody calls, so the way out of that has to be one click. */}
                  <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-stroke bg-surface-card2 px-3 py-2">
                    <span className="text-[0.8rem] text-ink-secondary">Set all {fields.length}:</span>
                    {(['ask', 'fixed', 'skip'] as Fill[]).map((f) => (
                      <Button
                        key={f}
                        variant="ghost"
                        size="xs"
                        /* Fields only. Sweeping the folded-away keypresses into "ask" alongside them would
                         * undo the split in one click and put the nineteen questions straight back. */
                        onClick={() => setBlanks((was) => was.map(
                          (b) => (kept.has(b.n) && b.verdict.field ? { ...b, fill: f } : b),
                        ))}
                      >
                        {f === 'ask' ? 'Ask each time' : f === 'fixed' ? 'Always the same' : 'Type nothing'}
                      </Button>
                    ))}
                  </div>

                  {/* The number that decides whether this skill is usable, said where it is still cheap to
                    * change. The footer counts it too, but by then somebody has scrolled past nineteen
                    * cards. */}
                  {asked.length > 4 && (
                    <Typography variant="p" className="mb-3 rounded-lg border border-fb-attention/40 bg-fb-attention/5 px-3 py-2 text-[0.82rem] text-ink-body leading-relaxed">
                      This skill will ask for{' '}
                      <strong>{asked.length} separate inputs</strong> every
                      time it runs, which is a lot to fill in. Keep <em>Ask each time</em> for the one or two
                      that really change, and set the rest to <em>Always the same</em> or <em>Type nothing</em>.
                    </Typography>
                  )}

                  <div className="grid grid-cols-[minmax(0,1fr)] gap-2.5">
                    {fields.map((b) => (
                      <div key={b.n} className="rounded-lg border border-stroke p-3">
                        <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          {/* A long name is a WINDOW TITLE, not a field: the recorder names the only thing
                            * it could see, and on a screen with no named control that is the window. Cut
                            * rather than wrapped, because three lines of somebody else's window title is
                            * worse than an ellipsis. */}
                          <span
                            title={b.control || undefined}
                            className="max-w-[26rem] truncate font-medium text-[0.9rem] text-ink-primary"
                          >
                            {b.control ? `Into “${b.control}”` : 'Into a field it could not name'}
                          </span>
                          {/* Which of them this is, in a span of its own so the truncation above can never
                            * eat it. Nine cards all headed Into “Prompt” are nine cards nobody can tell
                            * apart, and the total is half the answer: knowing this is the second of nine is
                            * what makes the list navigable. */}
                          {b.of > 1 && (
                            <span className="shrink-0 font-medium text-[0.9rem] text-ink-primary">
                              {b.nth} of {b.of}
                            </span>
                          )}
                          <span className="text-[0.76rem] text-ink-inactive">
                            step {b.n}{b.keys ? ` · ${b.keys} keystroke${b.keys === 1 ? '' : 's'}` : ''}
                          </span>
                        </div>

                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {(['ask', 'fixed', 'skip'] as Fill[]).map((f) => (
                            <button
                              key={f}
                              type="button"
                              onClick={() => edit(b.n, { fill: f })}
                              className={cn(
                                'rounded-md px-2.5 py-1 text-[0.8rem] transition-colors duration-fast',
                                b.fill === f
                                  ? 'on-accent bg-brand-primary font-medium'
                                  : 'text-ink-secondary hover:bg-state-hover',
                              )}
                            >
                              {f === 'ask' ? 'Ask each time' : f === 'fixed' ? 'Always the same' : 'Type nothing'}
                            </button>
                          ))}
                        </div>

                        {b.fill === 'ask' && (
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              value={b.param}
                              onChange={(e) => edit(b.n, { param: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })}
                              placeholder="what to call it"
                              className="h-9 w-[190px] rounded-md border border-stroke bg-surface-card2 px-2.5 font-mono text-[0.82rem] text-ink-primary focus:border-brand-primary focus:outline-none"
                            />
                            <select
                              value={b.type}
                              onChange={(e) => edit(b.n, { type: e.target.value as Blank['type'] })}
                              className="h-9 rounded-md border border-stroke bg-surface-card2 px-2 text-[0.82rem] text-ink-primary focus:border-brand-primary focus:outline-none"
                            >
                              {(['quoted', 'email', 'url'] as Blank['type'][]).map((t) => (
                                <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                              ))}
                            </select>
                            <span className="text-[0.76rem] text-ink-inactive">
                              asked for on every run, and required
                            </span>
                          </div>
                        )}

                        {b.fill === 'fixed' && (
                          <input
                            value={b.fixed}
                            onChange={(e) => edit(b.n, { fixed: e.target.value })}
                            placeholder="the text to type, every time"
                            className="h-9 w-full rounded-md border border-stroke bg-surface-card2 px-2.5 text-[0.85rem] text-ink-primary placeholder:text-ink-inactive focus:border-brand-primary focus:outline-none"
                          />
                        )}

                        {b.fill === 'skip' && (
                          <p className="text-[0.8rem] text-ink-inactive">
                            The skill will leave this field alone.
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                )}

                {/* What was NOT a field, in one line instead of one card each.
                  *
                  * This is the whole point of api/_typing.mjs. On the recording that prompted this, four of
                  * thirteen typing runs were Enter and Escape pressed at a dialog - and the old screen asked
                  * a three-way question about each of them, naming the dialog's own title as though it were a
                  * text box. They are stated rather than hidden, because a skill that quietly declined to
                  * type somewhere is a skill that looks broken on its first run, and one click opens them. */}
                {aside.length > 0 && (
                  <div className={cn('rounded-lg border border-stroke bg-surface-card2 px-3 py-2.5',
                    fields.length > 0 && 'mt-3')}
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Keyboard aria-hidden className="size-4 shrink-0 text-ink-inactive" />
                      <Typography variant="span" className="text-[0.83rem] text-ink-body">
                        {aside.length} other place{aside.length === 1 ? '' : 's'} where keys were pressed —
                        Enter, Tab, shortcuts. The skill leaves {aside.length === 1 ? 'it' : 'them'} alone.
                      </Typography>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="ms-auto"
                        onClick={() => setShowAside((was) => !was)}
                      >
                        {showAside ? 'Hide' : 'Show'}
                      </Button>
                    </div>
                    {showAside && (
                      <ul className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-1 border-stroke border-t pt-2">
                        {aside.map((b) => (
                          <li key={b.n} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="text-[0.78rem] text-ink-inactive tabular-nums">step {b.n}</span>
                            <span
                              title={b.control || undefined}
                              className="max-w-[22rem] truncate text-[0.82rem] text-ink-secondary"
                            >
                              {b.control || 'no name'}
                            </span>
                            <span className="text-[0.76rem] text-ink-inactive">
                              {b.keys} keystroke{b.keys === 1 ? '' : 's'} · {b.verdict.why}
                              {/* Read off the role, or guessed from the shape of the run. The difference
                                * matters to somebody deciding whether to override it, so it is shown. */}
                              {b.verdict.sure ? '' : ' (a guess)'}
                            </span>
                            <button
                              type="button"
                              /* The verdict moves with it. Setting only `fill` would leave the blank on this
                                * list, asked for on every run and with nowhere to name it - a required
                                * parameter with no card is a Next button that will not light up. */
                              onClick={() => edit(b.n, { fill: 'ask', verdict: { ...b.verdict, field: true } })}
                              className="ms-auto rounded-md px-2 py-0.5 text-[0.78rem] text-ink-secondary hover:bg-state-hover"
                            >
                              It is a field →
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* The reference half, last.
                  *
                  * It was at the top, where it was the first thing on the step and pushed the cards - the
                  * part somebody is here to USE - below the fold. Six lines of explanation standing in front
                  * of the controls they explain is a screen that has to be scrolled past before it can be
                  * worked, and the person who reported it could not see that there were cards at all.
                  *
                  * Kept rather than cut: without it the three buttons are unlabelled and the only way to
                  * learn what they do is to save the skill and run it. Reference material belongs where
                  * reference material is looked up - underneath, when a word on a button is not enough. */}
                {fields.length > 0 && (
                  <div className="mt-5 border-stroke/60 border-t pt-3">
                    <Typography variant="p" className="mb-2 text-ink-inactive text-[0.82rem] leading-relaxed">
                      MouseFlow records that a key was pressed and when, never which key — so what you typed
                      is not in the recording and cannot be. Each card above is one place the recording knows
                      you typed something and cannot know what.
                    </Typography>
                    <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5 text-[0.8rem] text-ink-inactive leading-relaxed">
                      <li><span className="text-ink-body">Ask each time</span> — becomes an input on the
                        skill; whoever runs it has to supply the text.</li>
                      <li><span className="text-ink-body">Always the same</span> — you write it once here and
                        the skill types that on every run.</li>
                      <li><span className="text-ink-body">Type nothing</span> — the skill leaves that field
                        alone.</li>
                    </ul>
                  </div>
                )}
              </>
            )}

            {lines && stage === 2 && (
              <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
                <label className="grid grid-cols-[minmax(0,1fr)] gap-1">
                  <span className="text-[0.8rem] text-ink-secondary">Name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value.slice(0, 80))}
                    className="h-10 rounded-lg border border-stroke bg-surface-card2 px-3 text-[0.9rem] text-ink-primary focus:border-brand-primary focus:outline-none"
                  />
                </label>
                <label className="grid grid-cols-[minmax(0,1fr)] gap-1">
                  <span className="text-[0.8rem] text-ink-secondary">
                    What it will do — edit it freely, this is what the skill carries out
                  </span>
                  <textarea
                    value={goal}
                    onChange={(e) => { setTouchedGoal(true); setGoal(capped(e.target.value, goal)); }}
                    rows={10}
                    className="rounded-lg border border-stroke bg-surface-card2 p-3 font-mono text-[0.82rem] text-ink-primary leading-relaxed focus:border-brand-primary focus:outline-none"
                  />
                </label>
                {/* What the compiler did with what you wrote, above the goal rather than under it.
                  *
                  * Only the two things it did NOT apply. Everything it placed is already in the text below,
                  * and listing that too would be asking somebody to read the same change twice. A conflict
                  * is shown because BOTH survive - the recorded step was not rewritten, deliberately - so
                  * the only way the person learns their sentence disagreed with the recording is here. */}
                {plan && (plan.conflicts.length > 0 || plan.unplaced.length > 0) && (
                  <div className="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border border-fb-attention/40 bg-fb-attention/5 px-3 py-2.5">
                    {plan.conflicts.map((c) => (
                      <div key={`c${c.n}`} className="text-[0.82rem] leading-relaxed">
                        <span className="text-ink-body">You wrote “{c.note}”</span>
                        {/* Numbered in the GOAL's numbering, which is the one on screen, and quoted as well
                          * — a quotation cannot drift out of step with a renumbering. */}
                        <span className="text-ink-inactive"> — {c.why}. Step {c.at ?? c.n} below
                          {c.instruction ? ` (“${c.instruction}”)` : ''} was left as recorded; edit it if
                          your version is the right one.</span>
                      </div>
                    ))}
                    {plan.unplaced.map((u) => (
                      <div key={u.note} className="text-[0.82rem] leading-relaxed">
                        <span className="text-ink-body">“{u.note}”</span>
                        <span className="text-ink-inactive"> was not placed — {u.why}. Add it to the goal
                          below if it should happen.</span>
                      </div>
                    ))}
                  </div>
                )}
                {plan && plan.placed > 0 && plan.conflicts.length === 0 && plan.unplaced.length === 0 && (
                  <Typography variant="p" className="text-[0.8rem] text-ink-inactive">
                    Your {plan.placed === 1 ? 'instruction was' : `${plan.placed} instructions were`} placed
                    among the steps below.
                  </Typography>
                )}
                {composeNote && (
                  <Typography variant="p" className="text-[0.8rem] text-ink-inactive">
                    Your instructions are at the end rather than in place — {composeNote}.
                  </Typography>
                )}
                <Typography variant="p" className="text-ink-inactive text-[0.8rem] leading-relaxed">
                  {asked.length > 0 ? (
                    <>
                      It will ask for{' '}
                      <span className="font-mono text-ink-body">
                        {asked.map((b) => b.param).join(', ')}
                      </span>
                      {' '}every time it runs — including when an AI calls it, where those become required
                      arguments.{' '}
                    </>
                  ) : null}
                  This runs on your own machine: the agent reads the screen and decides each step, so it
                  adapts to a window that has moved. Slower than a literal replay, and it can type.
                </Typography>
              </div>
            )}
          </div>

          <footer className="flex items-center gap-2 border-stroke border-t px-4 py-3">
            <Typography variant="span" className="text-[0.78rem] text-ink-inactive">
              {stage === 0 && lines ? `${kept.size} of ${describables.length} steps kept` : ''}
              {stage === 1 && fields.length > 0 ? `${asked.length} will be asked for` : ''}
              {/* The step can now be used with no blanks at all, so the footer had nothing to say on the
                * commonest path through it. */}
              {stage === 1 && fields.length === 0
                ? (notes.trim() ? 'Your instructions will be added' : 'Optional — you can go straight on')
                : ''}
            </Typography>
            <div className="ms-auto flex items-center gap-2">
              {stage > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  /* Going back throws away what the compiler made of the notes. It has to: the notes or the
                   * steps are about to change, and a goal composed against the old ones would look current
                   * and be stale. Clearing it is also what lets the next Next ask again. */
                  onClick={() => { setPlan(null); setComposeNote(null); setStage(stage - 1); }}
                >
                  Back
                </Button>
              )}
              {/* Save carries NO icon. The Button lays its children out in a row that wraps, and at this
                * width the tick came out on a line of its own above the words — a two-line button that
                * reads as a rendering fault. The word is doing the work. */}
              {stage < STAGES.length - 1 ? (
                <Button
                  size="sm"
                  disabled={!canGo || composing}
                  isLoading={composing}
                  onClick={() => {
                    /* Only on the way OFF the instructions step, and only when something was written. */
                    if (stage === 1) void compose().then(() => setStage(2));
                    else setStage(stage + 1);
                  }}
                >
                  Next
                </Button>
              ) : (
                <Button size="sm" disabled={!canGo} isLoading={saving} onClick={() => void save()}>
                  Save the skill
                </Button>
              )}
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
