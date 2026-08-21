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
import { Check, Keyboard, Loader2, X } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import type { Recording } from '@/lib/store';
import { saveAsGoalSkill } from './save-as-skill';

/* ------------------------------------------------------------------ what the transcript sends */

interface TStep {
  n?: number;
  action?: string;
  what?: string;
  target?: string | null;
  /** Typing only, and null when the resolver could not read the field. Absent means "not known". */
  control?: string | null;
  controlType?: string | null;
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
  keys: number;
  where: string | null;
}

/* ------------------------------------------------------------------ what the wizard decides */

type Fill = 'ask' | 'fixed' | 'skip';

interface Blank {
  /** The step this belongs to, so a dropped step drops its blank. */
  n: number;
  control: string | null;
  keys: number;
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

/* ------------------------------------------------------------------ the wizard */

const STAGES = ['What it did', 'What to type', 'Name it'] as const;

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
  const [touchedGoal, setTouchedGoal] = useState(false);
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
          const param = paramFromControl(l.control, taken);
          taken.add(param);
          return {
            n: l.n,
            control: l.control,
            keys: l.keys,
            /* Asking is the default, because that is what makes this a tool rather than a macro. */
            fill: 'ask' as Fill,
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

  const derived = useMemo(
    () => (lines ? buildGoal(lines, kept, blanks) : ''),
    [lines, kept, blanks],
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

  const edit = useCallback((n: number, patch: Partial<Blank>) => {
    setBlanks((was) => was.map((b) => (b.n === n ? { ...b, ...patch } : b)));
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
                  click, a scroll that was only looking. {typing.length > 0 && (
                    <>The <span className="text-ink-body">highlighted</span> rows are where you typed;
                    what you typed was never stored, so the next screen asks.</>
                  )}
                </Typography>
                <ul className="grid gap-1">
                  {lines.map((line) => {
                    const isTyping = line.action === 'type';
                    const on = kept.has(line.n);
                    return (
                      <li key={line.n}>
                        <label
                          className={cn(
                            'flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-1.5',
                            'hover:bg-state-hover',
                            isTyping && 'bg-brand-primary/10',
                            !on && 'opacity-45',
                          )}
                        >
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
                          {isTyping && <Keyboard aria-hidden className="mt-0.5 size-4 shrink-0 text-brand-primary" />}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {lines && stage === 1 && (
              typing.length === 0 ? (
                <Typography variant="p" className="text-ink-body text-[0.88rem] leading-relaxed">
                  Nothing was typed in the steps you kept, so there is nothing to fill in. The skill will
                  click its way through on its own.
                </Typography>
              ) : (
                <>
                  <Typography variant="p" className="mb-3 text-ink-inactive text-[0.85rem] leading-relaxed">
                    MouseFlow records that a key was pressed and when, never which key — so what you typed is
                    not in the recording and cannot be. Say what the skill should type instead.
                  </Typography>
                  <div className="grid gap-2.5">
                    {typing.map((b) => (
                      <div key={b.n} className="rounded-lg border border-stroke p-3">
                        <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="font-medium text-[0.9rem] text-ink-primary">
                            {b.control ? `Into “${b.control}”` : 'Into a field it could not name'}
                          </span>
                          <span className="text-[0.76rem] text-ink-inactive">
                            step {b.n}{b.keys ? ` · ${b.keys} keystrokes` : ''}
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
              )
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
                  {typing.filter((b) => b.fill === 'ask').length > 0 ? (
                    <>
                      It will ask for{' '}
                      <span className="font-mono text-ink-body">
                        {typing.filter((b) => b.fill === 'ask').map((b) => b.param).join(', ')}
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
              {stage === 1 && typing.length > 0 ? `${typing.filter((b) => b.fill === 'ask').length} will be asked for` : ''}
            </Typography>
            <div className="ms-auto flex items-center gap-2">
              {stage > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setStage(stage - 1)}>Back</Button>
              )}
              {stage < STAGES.length - 1 ? (
                <Button size="sm" disabled={!canGo} onClick={() => setStage(stage + 1)}>Next</Button>
              ) : (
                <Button size="sm" disabled={!canGo} isLoading={saving} onClick={() => void save()}>
                  <Check className="size-4" /> Save the skill
                </Button>
              )}
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
