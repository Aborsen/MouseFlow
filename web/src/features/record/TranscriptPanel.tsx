/* The transcript of one recording: what was done, where, in what order, and where the time went.
 *
 * The Record screen used to describe a recording as "142 events". That is a number nobody can act on -
 * it says a thing was recorded and nothing about whether it is worth automating, which is the entire
 * point of recording it. This panel is the readable form: segments for where the work happened, steps
 * inside them for what was done, and an elapsed clock down the left so a two-minute wait in the middle
 * of a task is visible rather than averaged away.
 *
 * Everything shown is a field /api/transcript sent. Nothing here derives a fact from another fact, and
 * that is the one rule this file cannot bend: a recording holds far less than a reader assumes it does -
 * no typed text on either half, no per-event window on the desktop half - so a confident sentence about
 * something that was never captured is worse than a blank. Where the endpoint says it cannot know, this
 * prints that in place, and its `gaps` list gets its own heading rather than a footnote.
 *
 * Two things it does NOT read from the transcript, deliberately:
 *
 *   the raw events    the transcript describes a recording, it does not carry the events that replay it,
 *                     so Create skill fetches the flow itself from /api/sync. That is a whole-account
 *                     read for one payload, which is the cost of there being no per-flow read; it happens
 *                     on the press, not on open.
 *   the step numbers  POST /api/transcript can drop steps, and the assistant on the dashboard is where
 *                     that is driven from ("remove those steps"). The Remove in this footer deletes the
 *                     whole recording, which is a different act, and it is armed in the button rather
 *                     than behind a confirm().
 */
import {
  AppWindow,
  CircleDashed,
  Clock,
  Globe,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { pull, push } from '@/lib/api';

/* ---------------------------------------------------------------- the endpoint's shape
 *
 * Declared here because this panel is the endpoint's only reader; it belongs beside Flow and Run in
 * lib/api.ts the moment a second one appears.
 *
 * The contract fixes the field NAMES. It does not state a type for every one of them, and several are
 * genuinely ambiguous: `summary.applications` / `summary.pages` read equally well as a count or as the
 * list of names, and `summary.captured` / `summary.gaps` as a flag, a count or a sentence. Those are
 * typed `unknown` and read through count() / names() / str() below rather than betting on one reading -
 * betting wrong prints a wrong number, or renders an object as a React child, which is a blank panel.
 */

interface TranscriptFlow {
  id?: string;
  name?: string;
  kind?: string;
  source?: string;
  created?: string | null;
  origins?: string[];
  windows?: { title?: string; process?: string }[];
}

interface Summary {
  events?: number;
  clicks?: number;
  scrolls?: number;
  drags?: number;
  keys?: number;
  seconds?: number;
  applications?: unknown;
  pages?: unknown;
  captured?: unknown;
  gaps?: unknown;
}

interface Where {
  kind?: 'app' | 'page' | 'unknown' | string;
  label?: string;
  detail?: string;
}

interface Step {
  n?: number;
  /** When it happened. A number is milliseconds from the start of the recording; a string is already
   *  written for reading, so it is printed as it came. */
  at?: number | string;
  /** How long this step itself took, in milliseconds. */
  ms?: number;
  action?: string;
  what?: string;
  target?: string;
  note?: string;
}

interface Segment {
  n?: number;
  where?: Where;
  startMs?: number;
  seconds?: number;
  steps?: Step[];
  note?: string;
}

interface Gap {
  question?: string;
  why?: string;
}

interface Transcript {
  ok: true;
  flow?: TranscriptFlow;
  summary?: Summary;
  segments?: Segment[];
  gaps?: Gap[];
}

/* Arrays are read through this rather than trusted: a section that renders as nothing is a far better
 * failure than the whole panel replaced by a React crash because one key was absent. */
const list = <T,>(value: T[] | undefined | null): T[] => (Array.isArray(value) ? value : []);

/** A trimmed string, or null. Guards against an object arriving where prose was expected - React throws
 *  on an object child, which is a blank panel with nothing on it to explain itself. */
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** A count, from either reading of an ambiguous field: the number itself, or the length of the list. */
const count = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  return null;
};

/** The names, when the field turned out to be a list of them. Empty when it was a count. */
const names = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((entry) => str(entry)).filter((entry): entry is string => entry !== null)
    : [];

/* -------------------------------------------------------------------------- formatting */

/** 7m 42s, not 462. A copy of the one in InsightsView: two screens do not justify a shared module, and
 *  the wording is part of each page rather than a utility. */
const fmtSeconds = (total: number | null): string => {
  if (total == null || !Number.isFinite(total) || total <= 0) return '—';
  const secs = Math.round(total);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    const rest = secs % 60;
    return rest ? `${mins}m ${rest}s` : `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
};

/** A step's own duration. Often under a second, where rounding to whole seconds throws away the whole
 *  difference between a click and a wait. Empty rather than an em-dash: this sits in a dense column and
 *  a dash on every fast row is noise. */
const fmtMs = (ms: number | null): string => {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return fmtSeconds(ms / 1000);
};

/** 0:04, 1:23, 12:03 - a transcript clock, so the column reads down as a timeline. */
const fmtClock = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(total / 60);
  return `${mins}:${String(total % 60).padStart(2, '0')}`;
};

const fmtAt = (at: number | string | undefined): string => {
  if (typeof at === 'number' && Number.isFinite(at)) return fmtClock(at);
  return str(at) ?? '—';
};

const fmtWhen = (iso: string | null | undefined): string => {
  const when = str(iso);
  if (!when) return '';
  const then = +new Date(when);
  if (!Number.isFinite(then)) return '';
  return new Date(then).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

/* `captured` has no stated type. A sentence is printed as it came; a flag is stated plainly; a bare
 * number is NOT rendered at all, because nothing says what it counts and a label invented here would be
 * read as the endpoint's. */
const capturedNote = (captured: unknown): string | null => {
  const sentence = str(captured);
  if (sentence) return sentence;
  if (typeof captured === 'boolean') {
    return captured
      ? 'Capture was complete.'
      : 'Capture was incomplete — some of what happened is missing from this recording.';
  }
  return null;
};

/* ------------------------------------------------------------------ a skill, locally
 *
 * A COPY of extension/skills.js. That module is the definition of the skill format and this must not
 * drift from it: the extension reads the same skill back out of the account (see flowFromSkill and
 * importSkills in extension/background.js), so a field invented or dropped here is a skill the other
 * half cannot read.
 *
 * Why a copy rather than the import the format deserves: `../../../../extension/skills.js` resolves as a
 * path but not as types - it is plain JavaScript outside this project's tsconfig `include`, so tsc
 * reports TS7016 under strict and `npm run build` runs `tsc --noEmit` first. Turning on allowJs, or
 * writing a declaration for it, changes the project's own configuration for the sake of one call.
 */

const SKILL_FORMAT = 'mouseflow.skill/1';

const skillId = () => Math.random().toString(36).slice(2, 10);

interface WebEventish {
  action?: string;
  points?: { dt?: number }[];
}

interface Skill {
  format: string;
  id: string;
  kind: 'recorded';
  name: string;
  description: string;
  created: string;
  origins: string[];
  tabs: number;
  events: unknown[];
  params: unknown[];
}

/** What a recording contains, in the terms someone reading a listing would want. The same behaviour as
 *  describeRecording, action names included - and it recognises the EXTENSION's action names only, which
 *  is why a desktop recording is described from the transcript instead (see create() below). */
function describeRecording(events: unknown[], tabs: number): string {
  let clicks = 0;
  let moveMs = 0;
  let scrolls = 0;
  let pages = 0;
  for (const raw of events) {
    const event = (raw ?? {}) as WebEventish;
    if (event.action === 'click' || event.action === 'dblclick') clicks++;
    else if (event.action === 'path') {
      moveMs += list(event.points).reduce((n, point) => n + Math.max(0, point?.dt ?? 0), 0);
    } else if (event.action === 'scroll') scrolls++;
    else if (event.action === 'focus' || event.action === 'navigate') pages++;
  }
  const parts = [`${clicks} click${clicks === 1 ? '' : 's'}`];
  if (moveMs >= 100) parts.push(`${(moveMs / 1000).toFixed(1)}s of movement`);
  if (scrolls) parts.push(`${scrolls} scroll${scrolls === 1 ? '' : 's'}`);
  if (pages) parts.push(`${pages} page change${pages === 1 ? '' : 's'}`);
  if (tabs > 1) parts.push(`${tabs} tabs`);
  return parts.join(' · ');
}

function skillFromRecording(
  rec: { name?: string | null; events?: unknown[]; origins?: string[]; tabs?: number },
  now: string,
): Skill {
  const events = list(rec.events);
  // `rec.tabs || 1` there, and the same here: a stored 0 must not travel as a tab count of 0.
  const tabs = rec.tabs && rec.tabs > 0 ? rec.tabs : 1;
  return {
    format: SKILL_FORMAT,
    id: skillId(),
    kind: 'recorded',
    /* The extension falls back to suggestName('recording'), which for that input returns exactly
     * 'recording'. Copying the whole naming function for one constant would be the drift, not this. */
    name: str(rec.name) ?? 'recording',
    description: describeRecording(events, tabs),
    created: now,
    origins: list(rec.origins),
    tabs,
    events,
    params: [],
  };
}

/** The description for a desktop recording. describeRecording answers "0 clicks" for one - it reads the
 *  extension's action names and a desktop event carries Mini Mouse Macro's - and a skill that states it
 *  contains nothing is worse than one with a plain description. These counts are the endpoint's. */
function describeFromSummary(summary: Summary | undefined): string {
  const parts: string[] = [];
  const clicks = count(summary?.clicks);
  const drags = count(summary?.drags);
  const scrolls = count(summary?.scrolls);
  const seconds = count(summary?.seconds);
  const events = count(summary?.events);
  if (clicks != null) parts.push(`${clicks} click${clicks === 1 ? '' : 's'}`);
  if (drags) parts.push(`${drags} drag${drags === 1 ? '' : 's'}`);
  if (scrolls) parts.push(`${scrolls} scroll${scrolls === 1 ? '' : 's'}`);
  if (seconds) parts.push(`${fmtSeconds(seconds)} in all`);
  if (!parts.length && events != null) {
    parts.push(`${events} recorded action${events === 1 ? '' : 's'}`);
  }
  return parts.join(' · ') || 'A recorded desktop macro.';
}

/* -------------------------------------------------------------------------- furniture */

const Quiet = ({ children }: { children: ReactNode }) => (
  <Typography variant="p" className="text-ink-inactive text-[0.84rem]">
    {children}
  </Typography>
);

const Chip = ({ value, label }: { value: string; label: string }) => (
  <span className="inline-flex items-baseline gap-1 rounded-md bg-surface-chips px-1.5 py-0.5">
    <strong className="font-semibold text-[0.8rem] text-ink-primary tabular-nums">{value}</strong>
    <span className="text-[0.72rem] text-ink-inactive">{label}</span>
  </span>
);

const WhereIcon = ({ kind }: { kind: string }) => {
  if (kind === 'app') return <AppWindow className="size-4 shrink-0 text-ink-secondary" />;
  if (kind === 'page') return <Globe className="size-4 shrink-0 text-ink-secondary" />;
  return <CircleDashed className="size-4 shrink-0 text-ink-inactive" />;
};

/* --------------------------------------------------------------------------- one step */

/* A step is scanned rather than read, so the row is fixed: number, clock, sentence, duration. The
 * duration is coloured once it passes five seconds, because a long step in the middle of a task is the
 * thing this whole panel exists to make findable - and it is the step's own `ms`, not something worked
 * out here. */
const StepRow = ({ step }: { step: Step }) => {
  const ms = count(step.ms);
  /* The endpoint's number or none at all - never this row's position.
   *
   * A step number is what you name to the assistant ("remove steps 4 and 5"), and POST /api/transcript
   * resolves it against the same numbering the transcript printed. A position counted here is not that
   * number: it would sit under a heading that says 4 while the endpoint knows a different step as 4, and
   * the removal would take the wrong one. So an unnumbered step is shown as unnumbered, and says why when
   * you point at it. */
  const number = count(step.n);
  const what = str(step.what);
  const action = str(step.action);
  const sentence = what ?? action ?? 'This step was recorded without a description.';
  /* The action name beside the sentence only when the sentence does not already contain it. Printing
   * "click" twice on one row is noise; dropping it entirely loses the one word that makes a column of
   * steps scannable. */
  const tag = action && what && !what.toLowerCase().includes(action.toLowerCase()) ? action : null;
  const target = str(step.target);
  const note = str(step.note);
  const slow = ms != null && ms >= 5000;

  return (
    <li className="flex gap-2 px-3 py-1.5 odd:bg-surface-chips/40">
      <span
        className="w-7 shrink-0 pt-px text-right text-[0.72rem] text-ink-inactive tabular-nums"
        title={number == null ? 'This step has no number, so it cannot be removed by number.' : undefined}
      >
        {number ?? '—'}
      </span>
      <span className="w-11 shrink-0 pt-px font-mono text-[0.72rem] text-ink-inactive tabular-nums">
        {fmtAt(step.at)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-[0.85rem] text-ink-body">
          {tag && (
            <span className="me-1.5 rounded bg-state-hover px-1 font-mono text-[0.7rem] text-ink-secondary">
              {tag}
            </span>
          )}
          {sentence}
        </span>
        {target && (
          <span
            className="mt-0.5 block truncate font-mono text-[0.72rem] text-ink-inactive"
            title={target}
          >
            {target}
          </span>
        )}
        {/* The endpoint's own words about what this step does not tell you. Quiet, and never reworded. */}
        {note && (
          <span className="mt-0.5 block break-words text-[0.75rem] text-ink-inactive">{note}</span>
        )}
      </span>
      <span
        className={cn(
          'w-14 shrink-0 pt-px text-right text-[0.74rem] tabular-nums',
          slow ? 'font-semibold text-fb-attention' : 'text-ink-inactive',
        )}
      >
        {fmtMs(ms)}
      </span>
    </li>
  );
};

/* ------------------------------------------------------------------------ one segment */

const SegmentBlock = ({
  segment,
  index,
  ofSeconds,
}: {
  segment: Segment;
  index: number;
  ofSeconds: number;
}) => {
  const steps = list(segment.steps);
  const seconds = count(segment.seconds);
  const label = str(segment.where?.label);
  const detail = str(segment.where?.detail);
  const note = str(segment.note);
  const kind = str(segment.where?.kind) ?? 'unknown';
  const share = ofSeconds > 0 && seconds != null ? Math.min(1, Math.max(0, seconds / ofSeconds)) : 0;

  return (
    <section className="rounded-lg border-stroke border bg-surface-card">
      <header className="border-stroke border-b px-3 py-2">
        <div className="flex items-start gap-2">
          <WhereIcon kind={kind} />
          <div className="min-w-0 flex-1">
            <Typography variant="span" weight="semibold" className="block break-words text-[0.88rem]">
              {label ?? 'Where this happened was not recorded'}
            </Typography>
            {detail && <span className="block break-words text-[0.75rem] text-ink-inactive">{detail}</span>}
            {/* Only when the endpoint left all three blank: the reader has to be told that the blank is
              * the recording's, not this panel's. */}
            {!label && !detail && !note && (
              <span className="block text-[0.75rem] text-ink-inactive">
                The recording does not say which application or page these steps happened in.
              </span>
            )}
          </div>
          <div className="shrink-0 text-right">
            <span className="block font-semibold text-[0.82rem] text-ink-primary tabular-nums">
              {fmtSeconds(seconds)}
            </span>
            <span className="block text-[0.72rem] text-ink-inactive tabular-nums">
              {steps.length} step{steps.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        {/* This segment's share of the whole recording. The bar is the message and the seconds beside it
          * are the check. Drawn only when there is a total for it to be a share of. */}
        {share > 0 && (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-state-hover">
            <div className="h-full rounded-full bg-brand-primary/70" style={{ width: `${share * 100}%` }} />
          </div>
        )}

        {note && (
          <Typography variant="p" className="mt-1.5 break-words text-ink-inactive text-[0.76rem]">
            {note}
          </Typography>
        )}
      </header>

      {steps.length === 0 ? (
        <div className="px-3 py-2">
          <Quiet>No steps were described for this stretch.</Quiet>
        </div>
      ) : (
        <ol className="py-1">
          {/* Keyed on position, not on `n`: `n` is optional, and two steps without one gave two rows the
            * same key - React then reuses one row's DOM for the other. */}
          {steps.map((step, i) => (
            <StepRow key={`${index}-${i}`} step={step} />
          ))}
        </ol>
      )}
    </section>
  );
};

/* ---------------------------------------------------------------------------- the panel */

interface Props {
  flowId: string;
  name: string;
  onClose: () => void;
  onRemoved?: () => void;
}

export const TranscriptPanel = ({ flowId, name, onClose, onRemoved }: Props) => {
  const [data, setData] = useState<Transcript | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  /* Bumped to ask for the same transcript again. A state value rather than calling the loader directly,
   * so the effect stays the only thing that starts a request and its abort always matches it. */
  const [attempt, setAttempt] = useState(0);

  const [note, setNote] = useState<{ text: string; kind: 'good' | 'bad' } | null>(null);
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState(false);
  const [armed, setArmed] = useState(false);
  const [removing, setRemoving] = useState(false);

  /* A different recording is a different panel: nothing about the last one still applies, the transcript
   * least of all.
   *
   * This cleared the notes and left `data` alone, which was the one thing on screen a reader would act on:
   * switching recordings kept the previous transcript up - its name, its counts, its steps, dimmed but
   * readable - while the footer's Remove already pointed at the new flowId, and Create skill described the
   * new recording with the old one's numbers. Keyed on flowId only, so `attempt` re-reads the same
   * recording without blanking the transcript the reader still has in front of them. */
  useEffect(() => {
    setData(null);
    setNote(null);
    setMade(false);
    setArmed(false);
  }, [flowId]);

  useEffect(() => {
    const stop = new AbortController();
    setBusy(true);
    setProblem(null);
    (async () => {
      try {
        const res = await fetch(`/api/transcript?flow=${encodeURIComponent(flowId)}`, {
          credentials: 'same-origin',
          signal: stop.signal,
        });
        const body = (await res.json().catch(() => null)) as
          | (Transcript & { error?: { message?: string } })
          | null;
        /* The endpoint's own words, not a status code dressed up as prose. It knows whether this is a
         * missing session, somebody else's recording or a deployment with no database; repeating
         * "something went wrong" here would throw away the only useful thing on the screen. */
        if (!res.ok || !body) throw new Error(body?.error?.message ?? `the server answered ${res.status}`);
        setData(body);
      } catch (err) {
        if (stop.signal.aborted) return; // a switch to another recording, not a failure
        setProblem(err instanceof Error ? err.message : 'the transcript could not be read');
      } finally {
        if (!stop.signal.aborted) setBusy(false);
      }
    })();
    return () => stop.abort();
  }, [flowId, attempt]);

  // Armed only briefly: a destructive button left cocked is one stray click away from being pressed.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(timer);
  }, [armed]);

  const summary = data?.summary;
  const flow = data?.flow;
  const segments = useMemo(() => list(data?.segments), [data]);
  const totalSeconds = count(summary?.seconds);
  const stepCount = useMemo(
    () => segments.reduce((n, segment) => n + list(segment.steps).length, 0),
    [segments],
  );
  const eventCount = count(summary?.events);

  /* Where it ran, from the segments themselves - that is the only place the endpoint attributes a step to
   * an application or a page. The recording-level names stand in when no segment named one, which is
   * exactly the desktop case: windows are sampled once a second per recording, never per event. Anything
   * the summary sent as a list of names is a last resort, since it may have arrived as a count instead. */
  const where = useMemo(() => {
    const seen: string[] = [];
    const add = (value: string | null) => {
      if (value && !seen.includes(value)) seen.push(value);
    };
    for (const segment of segments) add(str(segment.where?.label));
    if (seen.length) return seen;
    for (const window of list(flow?.windows)) add(str(window?.title) ?? str(window?.process));
    for (const origin of list(flow?.origins)) add(str(origin));
    if (seen.length) return seen;
    for (const named of names(summary?.applications)) add(named);
    for (const named of names(summary?.pages)) add(named);
    return seen;
  }, [segments, flow, summary]);

  const title = str(flow?.name) ?? str(name) ?? 'This recording';
  const source = str(flow?.source);
  const kind = str(flow?.kind);
  const created = fmtWhen(flow?.created);
  const captured = capturedNote(summary?.captured);
  const clicks = count(summary?.clicks);
  const drags = count(summary?.drags);
  const scrolls = count(summary?.scrolls);
  const keys = count(summary?.keys);

  const create = useCallback(async () => {
    setMaking(true);
    setNote(null);
    try {
      /* The events, from the flow itself. The transcript describes a recording and does not carry the
       * events that replay it, and a skill without them is a name with nothing behind it. /api/sync is
       * the only read that returns a payload, so this is a whole-account read for one flow - paid on the
       * press rather than on every open. */
      const account = await pull();
      const mine = list(account.flows).find((candidate) => candidate.id === flowId);
      if (!mine) throw new Error('this recording is no longer on your account');

      const raw = (mine.payload ?? {}) as { events?: unknown[]; tabs?: unknown };
      const events = list(raw.events);
      if (!events.length) {
        throw new Error('this recording holds no events, so there would be nothing to replay');
      }

      const skill = skillFromRecording(
        {
          name: str(mine.name) ?? title,
          events,
          origins: list(mine.origins),
          tabs: count(raw.tabs) ?? 1,
        },
        new Date().toISOString(),
      );
      if (mine.source === 'desktop') skill.description = describeFromSummary(summary);

      const body = await push({
        flows: [
          {
            /* The skill's own id, as extension/background.js's flowFromSkill uses it. A prefix of our own
             * would leave the extension's sync unable to recognise the flow as the skill inside it, and it
             * would push the same skill straight back under a second id. */
            id: skill.id,
            /* Carried from the recording, never guessed: `desktop` steps are screen coordinates, and the
             * extension must not be offered a Run that clicks at meaningless positions in a page. */
            source: mine.source,
            /* `recorded`, the same as Save as skill on the Record screen. `created` means a skill the
             * agent re-runs from a goal, and this is a macro - calling it created would put a Run button
             * in front of it that no agent can honour. */
            kind: 'recorded',
            name: skill.name.slice(0, 80),
            description: skill.description.slice(0, 400),
            origins: skill.origins.slice(0, 12),
            created: skill.created,
            payload: skill,
          },
        ],
      });
      const problems = list(body.problems);
      if (problems.length) throw new Error(problems.join('; '));

      setMade(true);
      setNote({
        text: `Saved "${skill.name}" as a skill. It is in Skills, on this and any other browser you sign in from.`,
        kind: 'good',
      });
    } catch (err) {
      setNote({
        text: `No skill was made: ${err instanceof Error ? err.message : 'unknown error'}`,
        kind: 'bad',
      });
    } finally {
      setMaking(false);
    }
  }, [flowId, summary, title]);

  const remove = useCallback(async () => {
    /* Asked in the button, the way MyAccountScreen asks. A confirm() is easy to click through without
     * reading and a second dialog is easy to lose behind the first; turning the button into the
     * consequence is not. */
    if (!armed) {
      setArmed(true);
      setNote({
        text: 'This deletes the recording and this transcript with it. Press again to go ahead.',
        kind: 'bad',
      });
      return;
    }
    setRemoving(true);
    try {
      const body = await push({ deleted: [flowId] });
      const problems = list(body.problems);
      if (problems.length) throw new Error(problems.join('; '));
      /* Both, in this order: the caller refreshes its list, then the panel goes - it is describing a
       * recording that is no longer there. A caller whose onRemoved already closes it loses nothing by
       * being asked twice. */
      onRemoved?.();
      onClose();
    } catch (err) {
      setRemoving(false);
      setArmed(false);
      setNote({
        text: `Nothing was deleted: ${err instanceof Error ? err.message : 'unknown error'}`,
        kind: 'bad',
      });
    }
  }, [armed, flowId, onClose, onRemoved]);

  const gaps = list(data?.gaps);

  return (
    /* Three bands: a header that does not move, a body that scrolls, a footer with the two things you can
     * do about what you have just read. A long transcript is the normal case, so the name and the total
     * are the parts that have to stay on screen. The max-height is the shell's viewport minus its top
     * bar, so the panel still scrolls inside itself if a caller renders it unconstrained. */
    <aside className="flex h-full max-h-[calc(100dvh-3.25rem)] min-h-0 w-full flex-col overflow-hidden border-stroke border-s bg-surface-card2">
      <header className="shrink-0 border-stroke border-b px-4 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Typography variant="h3" weight="semibold" className="break-words text-[1rem]">
              {title}
            </Typography>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.76rem] text-ink-inactive">
              {source && <span>{source === 'desktop' ? 'Desktop recording' : 'Browser recording'}</span>}
              {kind && kind !== 'recorded' && <span>· {kind}</span>}
              {created && <span>· recorded {created}</span>}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Close the transcript"
            leftSlot={<X className="size-4" />}
            onClick={onClose}
          >
            Close
          </Button>
        </div>

        {data && (
          <>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <Chip value={fmtSeconds(totalSeconds)} label="in all" />
              <Chip value={String(stepCount)} label={stepCount === 1 ? 'step' : 'steps'} />
              {clicks != null && <Chip value={String(clicks)} label={clicks === 1 ? 'click' : 'clicks'} />}
              {!!drags && <Chip value={String(drags)} label={drags === 1 ? 'drag' : 'drags'} />}
              {!!scrolls && <Chip value={String(scrolls)} label={scrolls === 1 ? 'scroll' : 'scrolls'} />}
              {/* Keys only when there were any. A "0 keys" chip beside the rest reads as "they typed
                * nothing", which is not what an empty count means here - neither recorder captures
                * typing at all, and the gaps list below says so in the endpoint's own words. */}
              {!!keys && <Chip value={String(keys)} label={keys === 1 ? 'key' : 'keys'} />}
            </div>

            {/* Where it ran. The first three, because a header is scanned - the rest are visible in the
              * segments below, which is where they belong. */}
            {where.length > 0 ? (
              <Typography variant="p" className="mt-2 break-words text-ink-secondary text-[0.78rem]">
                In {where.slice(0, 3).join(', ')}
                {where.length > 3 ? ` and ${where.length - 3} more` : ''}
              </Typography>
            ) : (
              !busy && (
                <Typography variant="p" className="mt-2 text-ink-inactive text-[0.78rem]">
                  Nothing in this recording says which application or site it happened in.
                </Typography>
              )
            )}

            {/* Said plainly rather than left as two numbers that do not match. Steps are what you can
              * read; events are what was stored, and there are usually more of the second. */}
            {eventCount != null && eventCount !== stepCount && (
              <Typography variant="p" className="mt-1 text-ink-inactive text-[0.74rem]">
                {eventCount} recorded event{eventCount === 1 ? '' : 's'}, described here as {stepCount} step
                {stepCount === 1 ? '' : 's'}.
              </Typography>
            )}

            {captured && (
              <Typography variant="p" className="mt-1 break-words text-ink-inactive text-[0.74rem]">
                {captured}
              </Typography>
            )}
          </>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {problem && (
          <section className="rounded-xl border-fb-red/40 border bg-surface-card p-4">
            <div className="flex items-center gap-1.5">
              <TriangleAlert className="size-4 text-fb-red-text" />
              <Typography variant="span" weight="semibold" className="text-[0.9rem] text-fb-red-text">
                The transcript could not be read
              </Typography>
            </div>
            <Typography variant="p" className="mt-1 break-words text-ink-secondary text-[0.85rem]">
              {problem}
            </Typography>
            <Button size="sm" className="mt-3" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </section>
        )}

        {!data && !problem && <Quiet>Reading this recording…</Quiet>}

        {data && (
          <div className={cn('space-y-3', busy && 'opacity-60 transition-opacity duration-base')}>
            {segments.length === 0 ? (
              <section className="rounded-lg border-stroke border bg-surface-card p-4">
                <Typography variant="h3" weight="semibold" className="text-[0.92rem]">
                  Nothing to read here
                </Typography>
                <Typography variant="p" className="mt-1 max-w-[60ch] text-ink-secondary text-[0.85rem]">
                  This recording holds no steps the transcript could describe. That happens when a
                  recording was stopped before anything was captured — and, on the desktop half, when what
                  happened happened over a window the recorder cannot see into.
                </Typography>
              </section>
            ) : (
              segments.map((segment, i) => (
                <SegmentBlock
                  // Position in the key as well: `n` is optional, and two segments without one collide.
                  key={`${i}-${count(segment.n) ?? 'n'}`}
                  segment={segment}
                  index={i}
                  ofSeconds={totalSeconds ?? 0}
                />
              ))
            )}

            {/* --------------------------------------------------------------- the gaps
              *
              * Quiet on purpose. These are not errors and they are not warnings: they are the things this
              * recording genuinely cannot tell you, printed so nobody has to wonder whether an absence
              * means nought. A guess in their place would be believed. */}
            {gaps.length > 0 && (
              <section className="rounded-lg border-stroke border bg-surface-chips p-3.5">
                <div className="mb-1 flex items-center gap-1.5">
                  <CircleDashed className="size-4 text-ink-inactive" />
                  <Typography variant="h3" weight="semibold" className="text-[0.88rem] text-ink-secondary">
                    What this recording cannot tell you
                  </Typography>
                </div>
                <Typography variant="p" className="mb-2.5 text-ink-inactive text-[0.78rem]">
                  Everything above was read from something that was recorded. These were not, so they are
                  listed rather than estimated.
                </Typography>
                <dl className="space-y-2">
                  {gaps.map((gap, i) => (
                    <div key={str(gap.question) ?? i}>
                      <dt className="break-words text-[0.82rem] text-ink-body">
                        {str(gap.question) ?? 'Something this recording does not hold'}
                      </dt>
                      {str(gap.why) && (
                        <dd className="break-words text-[0.78rem] text-ink-inactive">{str(gap.why)}</dd>
                      )}
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </div>
        )}
      </div>

      <footer className="shrink-0 border-stroke border-t px-4 py-3">
        {note && (
          <Typography
            variant="p"
            className={cn(
              'mb-2 break-words text-[0.8rem]',
              note.kind === 'good' ? 'text-fb-green' : 'text-fb-red-text',
            )}
          >
            {note.text}
          </Typography>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            leftSlot={<Sparkles className="size-4" />}
            isLoading={making}
            /* Disabled once it has been made rather than left pressable: a second press would put a
              * second copy of the same macro on the account under a new id. */
            disabled={made || removing || !!problem}
            onClick={() => void create()}
          >
            {made ? 'Skill created' : 'Create skill'}
          </Button>
          <Button
            variant={armed ? 'destructive' : 'destructiveOutline'}
            size="sm"
            leftSlot={<Trash2 className="size-4" />}
            isLoading={removing}
            onClick={() => void remove()}
          >
            {armed ? 'Remove — press again' : 'Remove'}
          </Button>
          <span className="ms-auto flex items-center gap-1 text-[0.74rem] text-ink-inactive">
            <Clock className="size-3.5" />
            {fmtSeconds(totalSeconds)}
          </span>
        </div>
      </footer>
    </aside>
  );
};
