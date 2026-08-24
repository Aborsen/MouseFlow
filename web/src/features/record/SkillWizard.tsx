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
import type { Recording } from '@/lib/store';
import { saveAsGoalSkill } from './save-as-skill';
/* Which typing runs are fields and which are somebody pressing Enter. Lives beside the API rather than here
 * because the suite runs it for real against measured recordings, and a .tsx cannot be imported by Node. */
import { classifyTyping, type TypingVerdict } from './typing';

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
  /** For `ask`: the parameter's name and type. For `fixed`: the text to type. */
  param: string;
  type: 'quoted' | 'email' | 'url';
  fixed: string;
}

/* A field name is written for a person - "To", "Subject line", "Search the web" - and a parameter name is
 * written for a schema. Slugged rather than invented, so the two are recognisably the same thing. */
const paramFromControl = (control: string | null, taken: Set<string>) => {
  const base = String(control || 'text')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'text';
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
};

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
  return !!line.control && ['click', 'dblclick', 'tab', 'drag', 'page'].includes(line.action);
}

/** One line of the goal, built from FIELDS rather than from the transcript's prose. */
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
    /* `wait`, `move`, `key` and `other` are things that HAPPENED, not things to do. A goal that told a model
     * to reproduce a pause would spend a step on it. */
    default: return null;
  }
}

function buildGoal(lines: Line[], kept: Set<number>, blanks: Blank[]): string {
  const byStep = new Map(blanks.map((b) => [b.n, b]));
  const wheres = [...new Set(lines.filter((l) => kept.has(l.n) && l.where).map((l) => l.where as string))];
  const steps: string[] = [];
  for (const line of lines) {
    if (!kept.has(line.n)) continue;
    const said = instruction(line, byStep.get(line.n));
    if (said) steps.push(said);
  }
  if (!steps.length) return '';
  const opening = wheres.length
    ? `In ${wheres.slice(0, 2).join(' and ')}, do this:`
    : 'Do this on the computer:';
  return `${opening}\n${steps.map((s, i) => `${i + 1}. ${s[0].toUpperCase()}${s.slice(1)}.`).join('\n')}`;
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
  const chip = chipOf(blank);
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
            chip.set
              ? 'border-stroke bg-surface-card2 text-ink-secondary hover:bg-state-hover'
              : 'border-brand-primary/45 bg-brand-primary/10 text-brand-primary hover:bg-brand-primary/20',
          )}
        >
          {chip.label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[19rem]">
        <Typography variant="span" weight="semibold" className="block text-[0.88rem]">
          What did you type here?
        </Typography>
        <Typography variant="p" className="mt-0.5 mb-2 truncate text-[0.78rem] text-ink-inactive">
          {blank.control ? `into “${blank.control}”` : 'the field could not be named'}
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

        <div className="mt-2.5 grid gap-1.5">
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
      </PopoverContent>
    </Popover>
  );
};

/* "What to type" was the name while the step could only ever be about the recorded typing — and when a
 * recording had none, it was a screen with a sentence on it and nothing to do. It takes instructions in
 * general now, of which "type this here" is one. */
const STAGES = ['What it did', 'Instructions', 'Name it'] as const;

interface Props {
  rec: Recording;
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
  const [touchedGoal, setTouchedGoal] = useState(false);
  /* The folded-away keypresses, shut by default. Open is the exception - it exists so a wrong classification
   * is correctable, not so everybody reads a list of Enters. */
  const [showAside, setShowAside] = useState(false);
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
              where,
            });
          }
        }
        setLines(flat);
        /* Everything DESCRIBABLE is in to start with. A step whose target had no name cannot become an
         * instruction, so leaving it on would put a tick beside a row that contributes nothing - which reads
         * as "this is in the skill" and is not. It stays in the list, switched off, saying why. */
        setKept(new Set(flat.filter(describable).map((l) => l.n)));

        const taken = new Set<string>();
        setBlanks(flat.filter((l) => l.action === 'type').map((l) => {
          /* Is this a field, or is it Enter? See api/_typing.mjs - on a measured 6,617-event recording nine
           * of thirteen typing runs were one text box and the other four were keys pressed at a dialog. */
          const verdict = classifyTyping(l, l.where);
          /* A parameter name is only spent on something that could take one. Numbering them from the whole
           * list would give the first real field a name like `text4`, counted off three keypresses. */
          const param = verdict.field ? paramFromControl(l.control, taken) : '';
          if (param) taken.add(param);
          return {
            n: l.n,
            control: l.control,
            role: l.role,
            keys: l.keys,
            verdict,
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
  const fields = useMemo(() => typing.filter((b) => b.verdict.field), [typing]);
  const aside = useMemo(() => typing.filter((b) => !b.verdict.field), [typing]);
  const asked = useMemo(() => typing.filter((b) => b.fill === 'ask'), [typing]);

  const derived = useMemo(
    () => (lines ? withNotes(buildGoal(lines, kept, blanks), notes) : ''),
    [lines, kept, blanks, notes],
  );

  /* The goal follows the choices until somebody edits it, and then it is theirs. Overwriting a sentence
   * a person wrote because a checkbox moved is the kind of helpfulness that loses work. */
  useEffect(() => { if (!touchedGoal) setGoal(derived); }, [derived, touchedGoal]);

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
  const allKept = !!lines && lines.length > 0 && lines.every((line) => kept.has(line.n));
  const keepAll = useCallback(() => {
    setKept(new Set((lines ?? []).map((line) => line.n)));
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
      await saveAsGoalSkill(rec, { name: name.trim() || rec.name, goal: goal.trim(), params, steps });
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

          <div className="max-h-[60vh] min-h-[280px] overflow-auto px-4 py-3.5">
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
                    {kept.size} of {lines.length} kept
                  </Typography>
                </div>
                <ul className="grid gap-1">
                  {lines.map((line) => {
                    const isTyping = line.action === 'type';
                    const on = kept.has(line.n);
                    /* Only a FIELD gets the chip. Offering "what did you type here?" beside an Enter keypress
                     * is the same nineteen questions the folding on step 2 exists to remove, just moved. */
                    const blank = blankOf.get(line.n);
                    const askable = !!blank && blank.verdict.field && on;
                    return (
                      /* The chip sits OUTSIDE the label. Inside it, every click on it would also reach the
                       * label and toggle the checkbox — the row would drop out of the skill at the exact
                       * moment somebody opened the popover to say what it types. */
                      <li
                        key={line.n}
                        className={cn(
                          'flex items-start gap-2 rounded-lg px-2.5 py-1.5',
                          'hover:bg-state-hover',
                          isTyping && 'bg-brand-primary/10',
                          !on && 'opacity-45',
                        )}
                      >
                        <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
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
              </>
            )}

            {lines && stage === 1 && (
              <>
                {/* The recorded typing, when there was any. A blank is a place the recording KNOWS
                  * something was typed and cannot know what; it is a different thing from the free text
                  * below, which is anything the recording could not know at all. */}
                {fields.length > 0 && (
                <>
                  <Typography variant="p" className="mb-2 text-ink-inactive text-[0.85rem] leading-relaxed">
                    MouseFlow records that a key was pressed and when, never which key — so what you typed is
                    not in the recording and cannot be. Each card below is one place the recording knows you
                    typed something and cannot know what.
                  </Typography>
                  {/* What the three buttons MEAN for the finished skill. Without this the screen is three
                    * unlabelled choices repeated N times, and the only way to find out what they do is to
                    * save and run it. */}
                  <ul className="mb-3 grid gap-0.5 text-[0.82rem] text-ink-inactive leading-relaxed">
                    <li><span className="text-ink-body">Ask each time</span> — becomes an input on the skill;
                      whoever runs it has to supply the text.</li>
                    <li><span className="text-ink-body">Always the same</span> — you write it once here and
                      the skill types that on every run.</li>
                    <li><span className="text-ink-body">Type nothing</span> — the skill leaves that field
                      alone.</li>
                  </ul>

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

                  <div className="grid gap-2.5">
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
                </>
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
                      <ul className="mt-2 grid gap-1 border-stroke border-t pt-2">
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
                <div className={cn('grid gap-1.5', typing.length > 0 && 'mt-5 border-stroke border-t pt-4')}>
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
              </>
            )}

            {lines && stage === 2 && (
              <div className="grid gap-3">
                <label className="grid gap-1">
                  <span className="text-[0.8rem] text-ink-secondary">Name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value.slice(0, 80))}
                    className="h-10 rounded-lg border border-stroke bg-surface-card2 px-3 text-[0.9rem] text-ink-primary focus:border-brand-primary focus:outline-none"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-[0.8rem] text-ink-secondary">
                    What it will do — edit it freely, this is what the skill carries out
                  </span>
                  <textarea
                    value={goal}
                    onChange={(e) => { setTouchedGoal(true); setGoal(e.target.value.slice(0, 4000)); }}
                    rows={10}
                    className="rounded-lg border border-stroke bg-surface-card2 p-3 font-mono text-[0.82rem] text-ink-primary leading-relaxed focus:border-brand-primary focus:outline-none"
                  />
                </label>
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
              {stage === 0 && lines ? `${kept.size} of ${lines.length} steps kept` : ''}
              {stage === 1 && fields.length > 0 ? `${asked.length} will be asked for` : ''}
              {/* The step can now be used with no blanks at all, so the footer had nothing to say on the
                * commonest path through it. */}
              {stage === 1 && fields.length === 0
                ? (notes.trim() ? 'Your instructions will be added' : 'Optional — you can go straight on')
                : ''}
            </Typography>
            <div className="ms-auto flex items-center gap-2">
              {stage > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setStage(stage - 1)}>Back</Button>
              )}
              {/* Save carries NO icon. The Button lays its children out in a row that wraps, and at this
                * width the tick came out on a line of its own above the words — a two-line button that
                * reads as a rendering fault. The word is doing the work. */}
              {stage < STAGES.length - 1 ? (
                <Button size="sm" disabled={!canGo} onClick={() => setStage(stage + 1)}>Next</Button>
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
