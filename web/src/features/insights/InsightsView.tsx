/* Insights: what was actually done on this account, and where the time went.
 *
 * This page is scanned rather than read, so it is built in that order - the shape of the window first (how
 * many runs, how they ended, how long they took), then the things that want a decision (a failure that keeps
 * repeating, a task done fourteen times by hand), then the flat tables. Anything asking for attention is
 * given a shape as well as a number: a bar you can compare without reading it, a colour that means the same
 * thing everywhere on the page.
 *
 * WHOSE NUMBERS. Yours, unless you switch. An owner or an admin of a team can point this page at that whole
 * team - every member's recordings, runs and skills, counted the same way - which is the only place in the
 * product where one person's screen adds up somebody else's work. Three things keep that honest:
 *
 *   the switch is only OFFERED to somebody who owns or administers a team, and the endpoint checks the role
 *     again on every request, because a control that is merely hidden is not a rule;
 *   the scope is written into the address, so a screenshot of "47 runs" can be traced back to whose;
 *   nothing on the team view is content. Counts, durations, application names, skill names - every one of
 *     them was already visible on the team roster. There is no path from here to a colleague's transcript.
 *
 * Two deliberate absences, both honest rather than accidental:
 *
 *  - No chart library. Every mark here is a div or a line of inline SVG. A dependency for eight bars would
 *    be the largest thing in the bundle.
 *  - No derived arithmetic. Everything shown is a field /api/insights sent. Where the stored data cannot
 *    answer a question, the endpoint says so in `gaps` and this page prints it under its own heading -
 *    inventing a plausible number is worse than admitting the gap, because a made-up number gets believed.
 */
import { useNavigate } from '@tanstack/react-router';
import {
  AppWindow,
  ArrowRight,
  CalendarDays,
  Clock,
  Film,
  Hourglass,
  MessageSquareText,
  MousePointerClick,
  RefreshCw,
  Repeat2,
  Route,
  ShieldCheck,
  Sparkles,
  Timer,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { DateRangePicker } from '@insightis/ui/Datepicker';
import type { DateRange } from 'react-day-picker';
import { ChatView } from '@/features/chat/ChatView';
import { usePageChrome } from '@/shell/Surface';
import { useTeams } from '@/shell/AccountProvider';
import { openingQuestion, takeAsk } from '@/features/chat/ask-about';

/* ------------------------------------------------------------------ the endpoint's shape
 *
 * Declared here rather than in lib/api.ts because this page is the endpoint's only reader. The moment a
 * second one appears it should move there, next to Flow and Run, so the two cannot drift apart.
 */

type Outcome = 'ok' | 'failed' | 'stopped' | 'running';

interface Totals {
  runs: number;
  ok: number;
  failed: number;
  stopped: number;
  running: number;
  recordings: number;
  createdSkills: number;
  /** Wall clock across every run in the window, as hours - the same measure the Hours screen shows. */
  agentHours: number;
}

interface DayRow {
  day: string;
  runs: number;
  ok: number;
  failed: number;
  agentSeconds: number;
}

interface AppRow {
  name: string;
  kind: string;
  recordings: number;
  runs: number;
  seconds: number;
  /** See asFraction below: the unit is not stated, so both readings are handled. */
  share: number;
}

interface RepeatedRow {
  signature: string;
  label: string;
  times: number;
  /** Agent time these runs took. Not a saving: nothing stored says what the task costs by hand. */
  seconds: number;
  /** How many of them had a usable clock, so a partial total can say so. */
  timed: number;
  lastAt: string | null;
  flowIds: string[];
}

interface StepRow {
  tool: string;
  calls: number;
  medianMs: number;
  p90Ms: number;
}

interface FailureRow {
  reason: string;
  times: number;
  lastAt: string | null;
  /* `example` is always an object, but its runId is nullable: the endpoint takes the most recent run of
   * the group and a row can carry no client id. Typed nullable rather than asserted, since the whole
   * point of the example is to be openable and a missing id has to read as "not this one". */
  example: { runId: string | null; error: string } | null;
}

interface SkillRow {
  flowId: string;
  /** Whose it is. Only ever needed in the team scope, where two people can have a skill of one name. */
  ownerId?: string | null;
  name: string;
  kind: string;
  source: string;
  runs: number;
  ok: number;
  failed: number;
  /* Null when no run of this skill had a usable start-and-finish pair. Nought would read as instant,
   * which is why the endpoint sends null and this keeps it null all the way to fmtSeconds. */
  medianSeconds: number | null;
  lastRunAt: string | null;
}

interface GapRow {
  question: string;
  why: string;
}

/* One row per outcome, sent as an ARRAY rather than a map. The endpoint shapes it from the same counts
 * `totals` carries, so the chart and the header cannot disagree - but it is a list of
 * { outcome, runs, share }, and reading it as a lookup by key (which the first version of this file did)
 * silently found nothing on every row and fell through to `totals` for the whole legend. */
interface OutcomeRow {
  outcome: string;
  runs: number;
  share: number;
}

/** A capped list: what was shown, what it was cut from, and the cap that cut it. */
interface Cap {
  shown: number;
  total: number;
  limit: number;
}

/* HOW THE MEASURED TIME WAS SPENT, and it is three parts of one whole rather than three numbers.
 *
 * The endpoint guarantees they add up to `measuredSeconds` by construction - every millisecond of every
 * gap lands in exactly one of them - which is why this page draws them as one bar and not as three tiles.
 * Three tiles would let a reader add them up and get something other than the total, and the arithmetic
 * that failed would be theirs rather than ours.
 *
 * `activeUnderMs` and `awayOverMs` are the two boundaries, sent rather than hard-coded here. A share of
 * "waiting" is meaningless until you know how long a pause has to be to count as waiting, and a number
 * whose definition is not on the screen gets read as objective. */
interface Attention {
  measuredSeconds: number;
  active: { seconds: number; share: number };
  waiting: { seconds: number; share: number };
  away: { seconds: number; share: number };
  activeUnderMs: number;
  awayOverMs: number;
}

/* WHAT WAS ACTUALLY DONE. `moves` is separate from everything else because pointer movement is 86% of all
 * events on a real account: in one list with the clicks it is not a summary, it is noise. `total` still
 * counts it, so the parts and the whole agree. */
interface Actions {
  moves: number;
  total: number;
  byKind: { kind: string; count: number }[];
  /** By name - "Key Backspace", "Scroll Down" - because the kind says keys were pressed and this says which. */
  top: { action: string; count: number }[];
}

/* ONE PROCESS, DONE MORE THAN ONCE. A pattern is the sequence of applications a recording moved through,
 * consecutive repeats collapsed. `repeated` is the answer to the only question it exists for: did the same
 * process happen in more than one recording? `once` and `total` are there so a short list can say what it
 * was cut from without implying the rest were repeats. */
interface Patterns {
  repeated: { steps: string; recordings: number }[];
  /* The repeated ones BEFORE the cap. Separate from `total`, which counts every distinct pattern: the cap
   * note needs the denominator of the list it cut, and `total` would make eight repeats out of an account
   * that had eight repeats and twenty singletons. */
  repeatedTotal?: number;
  once: number;
  total: number;
}

/* WHAT THE THREE BLOCKS ABOVE ARE MADE OF, said out loud.
 *
 * They are read from a per-recording digest, and a recording made a minute ago may not have one yet. Then
 * "45% doing" is the truth about SOME of the recordings, and presenting it as the truth about all of them
 * would look identical on screen to inventing it. `stale` is how many are still to be summarised.
 *
 * `problem` is set when deriving failed outright: the rest of the page is still real, so the page renders,
 * and this says which part of it to distrust. */
interface Digest {
  version: number;
  derived: number;
  stale: number;
  perRequest: number;
  problem: string | null;
}

interface Insights {
  ok: true;
  /** timeZone is the zone the day boundaries were cut on - UTC, since that is Neon's. */
  window: { days: number; from: string; to: string; timeZone?: string };
  totals: Totals;
  byOutcome: OutcomeRow[];
  byDay: DayRow[];
  applications: AppRow[];
  /* The three behaviour blocks, optional because a deploy where the page is newer than the endpoint is
   * ordinary and a dashboard that renders an error over a missing section is not. */
  attention?: Attention;
  actions?: Actions;
  patterns?: Patterns;
  /** The same three for the window before this one, so a share can be compared instead of just read. */
  previousBehaviour?: { attention?: Attention; actions?: Actions; patterns?: Patterns };
  digest?: Digest;
  /* Real measured time that cannot be attributed to any application. Its share completes the
   * applications table, which is the only reason the shares there can be read as shares of anything. */
  unattributed?: { seconds: number; share: number; why: string };
  repeated: RepeatedRow[];
  slowestSteps: StepRow[];
  /** The window immediately before this one, same length. `had` is stated rather than inferred, because "no
   * runs then" and "no previous window" both come back as nought and only one of them supports a delta. */
  previous?: {
    from?: unknown;
    to?: unknown;
    had?: unknown;
    runs?: unknown;
    ok?: unknown;
    failed?: unknown;
    stopped?: unknown;
    agentHours?: unknown;
  };
  failures: FailureRow[];
  skills: SkillRow[];
  gaps: GapRow[];
  scope?: ScopeSaid;
  /* The endpoint's own count of what each cap cut, because this page only ever sees the rows that
   * survived one and so cannot work it out for itself. */
  caps?: {
    days: number;
    /** `steps` is how many applications a pattern is cut to, which is why two long processes can look alike. */
    patterns?: Cap & { steps: number };
    actions?: { shown: number; limit: number };
    applications: Cap;
    repeated: Cap;
    slowestSteps: Cap & { minCalls: number };
    failures: Cap;
    skills: Cap;
  };
}

/** One member of a team, over the same window as everything else on the page. Counts and dates only. */
interface PersonRow {
  id: string;
  name: string | null;
  email: string | null;
  role: 'owner' | 'admin' | 'member';
  /** The reader themselves, marked by the endpoint rather than compared here against an account id. */
  you: boolean;
  recordings: number;
  createdSkills: number;
  runs: number;
  ok: number;
  failed: number;
  stopped: number;
  agentHours: number;
  lastRun: string | null;
  lastMade: string | null;
}

/* Who the numbers on this page belong to, in the endpoint's own words rather than in what this page asked
 * for. The two can differ - a request naming a team the caller has since been removed from is refused, not
 * quietly answered about them - and the one worth rendering is the answer. */
interface ScopeSaid {
  kind: 'personal' | 'team';
  team?: { id: string; name: string };
  role?: 'owner' | 'admin';
  /** Set when the view is narrowed to one member — everything else on the page is then theirs alone. */
  person?: { id: string; name: string | null; email: string | null; you: boolean };
  people: PersonRow[];
}

/** A skill's owner, named from the people the same response already listed. */
const whose = (ownerId: string | null | undefined, people: PersonRow[]): string => {
  if (!ownerId) return '—';
  const found = people.find((p) => p.id === ownerId);
  if (!found) return '—';
  if (found.you) return 'you';
  return found.name || found.email || 'somebody';
};

/* Arrays are read through this rather than trusted, because a section that renders as nothing is a far
 * better failure than a whole page replaced by a React crash when one key is absent. */
const list = <T,>(value: T[] | undefined | null): T[] => (Array.isArray(value) ? value : []);

/* And numbers, for the same reason and one more: null has to survive as null. The endpoint sends it for
 * "never measured", and coercing that to nought would turn "no runs were timed" into "they took no time",
 * which is the difference between an absence and a measurement. */
const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

/* What the page is asking about. `days` counts back from now - the old shape, and still what the preset
 * buttons use. `from`/`to` name the ends, which is the only honest way to say "today": a day starts at
 * midnight on the PERSON'S clock, and the server has no idea what theirs is. So the boundary is computed
 * here, in their own time zone, and sent as two instants. */
export type Window =
  | { kind: 'days'; days: number }
  | { kind: 'range'; from: Date; to: Date; label: string };

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

export const todayWindow = (): Window => {
  const now = new Date();
  return { kind: 'range', from: startOfDay(now), to: now, label: 'Today' };
};

/* ONE DAY OF THE CHART, and its boundaries are UTC on purpose.
 *
 * Every other window on this page is cut on the reader's own clock, because "today" belongs to them. This
 * one is not: it comes from a column of the day chart, and that axis is UTC - the endpoint says so in
 * `window.timeZone`, because date_trunc uses the database's zone and Neon's is UTC. Cutting the drill-down
 * on local midnight would hand back a different set of runs from the ones the column counted, and the two
 * numbers would disagree by a few hours' worth with nothing on the screen to explain it.
 *
 * The end is clamped to now for the same reason the picker refuses future dates: asking for the rest of
 * today returns the same rows and labels the window with an hour that has not happened. */
const dayWindow = (day: string): Window | null => {
  const start = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(+start)) return null;
  const end = new Date(start.getTime() + 86_400_000 - 1);
  const now = new Date();
  return { kind: 'range', from: start, to: end > now ? now : end, label: fmtDay(day) };
};

const asQuery = (w: Window) => (w.kind === 'days'
  ? `days=${w.days}`
  : `from=${encodeURIComponent(w.from.toISOString())}&to=${encodeURIComponent(w.to.toISOString())}`);

/* Which account, or which team. `mine` sends nothing, so every existing caller and every bookmark keeps
 * asking exactly the question it always asked. */
export type Scope =
  | { kind: 'mine' }
  /** `person` narrows a team view to one of its members; the endpoint checks they are in it. */
  | { kind: 'team'; id: string; person?: string };

/* THE WINDOW, READ BACK OUT OF THE ADDRESS - the same three parameters the endpoint itself accepts, so a
 * link pasted into a chat opens the numbers the person was looking at rather than the last seven days.
 *
 * `days` and `from`/`to` are both understood because both are what `asQuery` writes; an unparseable pair
 * falls through to the default rather than rendering an error, since a mistyped address is not a failure
 * of the dashboard. The default is stated in one place - the caller's - so this returns null for "nothing
 * in the address" instead of inventing a window of its own. */
const windowFromAddress = (search: string): Window | null => {
  try {
    const q = new URLSearchParams(search);
    const from = q.get('from');
    const to = q.get('to');
    if (from && to) {
      const a = new Date(from);
      const b = new Date(to);
      if (Number.isFinite(+a) && Number.isFinite(+b) && b > a) {
        /* "Today" is recovered rather than re-derived: it is the one label the preset row highlights, and
         * a window that IS today wearing a date label would leave every preset unpressed. */
        const now = new Date();
        const isToday = +a === +startOfDay(now) && b >= startOfDay(now);
        if (isToday) return { kind: 'range', from: a, to: b, label: 'Today' };
        /* AND A WHOLE UTC DAY IS RECOVERED TOO, because that is what a column of the day chart writes.
         *
         * Without this the same window has two names: "Aug 30" while it is being looked at, and
         * "30.08 - 31.08" after a reload - since the end of a UTC day falls on the next LOCAL date for
         * anybody east of Greenwich, and labelFor reads local dates. One window, two labels, and the
         * reader's only conclusion is that the reload changed something. */
        /* Starts at UTC midnight and lasts at most a UTC day: that IS one UTC day, whether it runs to
         * 23:59:59.999 or was clamped to now because the day in question is today. Both are what a column
         * of the chart writes, and both have to come back with the column's own label. */
        const wholeUtcDay = a.getUTCHours() === 0 && a.getUTCMinutes() === 0
          && a.getUTCSeconds() === 0 && a.getUTCMilliseconds() === 0
          && +b - +a <= 86_400_000;
        return {
          kind: 'range',
          from: a,
          to: b,
          label: wholeUtcDay ? fmtDay(a.toISOString().slice(0, 10)) : labelFor(a, b),
        };
      }
    }
    const days = Number.parseInt(String(q.get('days') || ''), 10);
    if (Number.isFinite(days) && days > 0) return { kind: 'days', days };
  } catch (_) { /* an address nobody can parse is a default window, not an error */ }
  return null;
};

const asScope = (scope: Scope) => (scope.kind === 'team'
  ? `&team=${encodeURIComponent(scope.id)}${scope.person ? `&person=${encodeURIComponent(scope.person)}` : ''}`
  : '');

async function fetchInsights(window: Window, scope: Scope, signal: AbortSignal): Promise<Insights> {
  const res = await fetch(`/api/insights?${asQuery(window)}${asScope(scope)}`,
    { credentials: 'same-origin', signal });
  const body = (await res.json().catch(() => null)) as (Insights & { error?: { message?: string } }) | null;
  /* The endpoint's own words, not a status code dressed up as prose: it knows why it refused and this page
   * does not. Only when it says nothing at all does the status stand in. */
  if (!res.ok || !body) throw new Error(body?.error?.message ?? `the server answered ${res.status}`);
  return body;
}

/* -------------------------------------------------------------------------- formatting */

/** 7m 42s, not 462. Nobody divides by sixty in their head while scanning a table.
 *
 * Takes null because the endpoint sends null for "never measured" - a median over runs none of which
 * were timable, for instance - and an em-dash is the honest rendering of that. Number.isFinite(null) is
 * false, so the guard below already handled it; the type is what was wrong. */
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

/* Step timings arrive in milliseconds and are often under a second, where rounding to whole seconds throws
 * away the entire difference between a fast tool and a slow one. */
const fmtMs = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return fmtSeconds(ms / 1000);
};

const fmtWhen = (iso: string | null): string => {
  if (!iso) return 'never';
  const then = +new Date(iso);
  if (!Number.isFinite(then)) return 'unknown';
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const fmtDay = (day: string): string => {
  const at = +new Date(day);
  if (!Number.isFinite(at)) return day;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/* `share` arrives without a stated unit. Both readings are handled rather than betting on one: read a
 * percentage as a fraction and every bar is drawn a hundred times too short, which looks like no data. */
const asFraction = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? Math.min(value / 100, 1) : value;
};

const pct = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;

/* 361,241 rather than 361241. Event counts here reach six figures - the account this was measured on has
 * 424,730 of them - and at that size an unseparated run of digits is read wrong more often than it is read.
 * The reader's own locale, because the separator is a convention and this page has no business picking one. */
const fmtCount = (n: number): string => (Number.isFinite(n) ? n.toLocaleString() : '—');

/* A difference between two SHARES, in points and never as a percentage.
 *
 * "45% this week against 38% last week" is a difference of seven POINTS, and printing it as "+18%" - which
 * is what dividing one by the other gives - is the single commonest way a dashboard misleads without
 * containing a false number. Null rather than nought when there is nothing to compare against, so an empty
 * previous window shows no delta instead of a confident "no change". */
const points = (now: number, then: number | null): string | null => {
  if (then == null || !Number.isFinite(then) || !Number.isFinite(now)) return null;
  const diff = Math.round((now - then) * 1000) / 10;
  if (Math.abs(diff) < 0.5) return null;
  /* "points", spelled the same way the success-rate tile spells it. Two spellings of one unit on one
   * screen read as two different units. */
  return `${diff > 0 ? '+' : '−'}${Math.abs(diff)} points`;
};

/* --------------------------------------------------------------------------- the marks */

const OUTCOMES: { key: Outcome; label: string; fill: string; text: string }[] = [
  { key: 'ok', label: 'finished', fill: 'bg-fb-green', text: 'text-fb-green' },
  { key: 'failed', label: 'failed', fill: 'bg-fb-red', text: 'text-fb-red-text' },
  /* text-fb-attention, not the fb-attention-text pair the red row uses: the vendored stylesheet defines
   * --fb-attention-text only inside .dark, and points it at --orange-attention-text-dark, which this copy
   * never defines at all. So that class resolves to nothing in either theme and the count would silently
   * fall back to inherited ink while its dot stayed orange. --fb-attention is defined in both. */
  { key: 'stopped', label: 'stopped', fill: 'bg-fb-attention', text: 'text-fb-attention' },
  { key: 'running', label: 'still running', fill: 'bg-brand-primary', text: 'text-brand-primary' },
];

/* A number, and what it is worth comparing with.
 *
 * `delta` is a rendered string rather than a number, because the three kinds are not the same arithmetic and
 * pretending otherwise is how a percentage-point difference gets printed as a percentage: runs compare as a
 * PERCENTAGE, a rate compares in POINTS, and a duration compares as a duration. `tone` says which way is
 * good, which is not always up - more failed runs is not an improvement - so the caller decides rather than
 * the sign of the number.
 */
const Tile = ({
  icon,
  value,
  label,
  note,
  delta,
  tone = 'flat',
  title,
}: {
  icon: ReactNode;
  value: string;
  label: string;
  note?: string;
  delta?: string | null;
  tone?: 'up' | 'down' | 'flat';
  title?: string;
}) => (
  <div className="rounded-lg border-stroke border bg-surface-chips px-3 py-2.5" title={title}>
    <div className="mb-0.5 flex items-center gap-1.5 text-ink-inactive">
      {icon}
      <span className="text-[0.76rem] uppercase tracking-wide">{label}</span>
    </div>
    <div className="flex flex-wrap items-baseline gap-x-2">
      <strong className="font-semibold text-[1.5rem] text-ink-primary tabular-nums leading-tight tracking-tight">
        {value}
      </strong>
      {delta && (
        <span
          className={cn(
            'text-[0.78rem] font-semibold tabular-nums',
            tone === 'up' ? 'text-fb-green' : tone === 'down' ? 'text-fb-red-text' : 'text-ink-inactive',
          )}
        >
          {delta}
        </span>
      )}
    </div>
    {note && <span className="block text-[0.76rem] text-ink-inactive">{note}</span>}
  </div>
);

/* `badge` is the one number a section is worth glancing at without reading it. It is a string, and the
 * caller formats it, because the honest badge is different for every section and a component that computed
 * one would have to know what each section measures. `badgeTitle` is where the definition goes - a figure
 * beside a heading gets read as whatever the heading implies, so the ones that could be mistaken for a saving
 * say what they are on hover. */
const Section = ({
  title,
  icon,
  note,
  children,
  tone = 'plain',
  badge,
  badgeTone = 'plain',
  badgeTitle,
  aside,
}: {
  title: string;
  icon?: ReactNode;
  note?: string;
  children: ReactNode;
  tone?: 'plain' | 'attention';
  badge?: string | null;
  badgeTone?: 'plain' | 'attention' | 'good';
  badgeTitle?: string;
  aside?: ReactNode;
}) => (
  <section
    className={cn(
      'rounded-xl border bg-surface-card p-4',
      tone === 'attention' ? 'border-fb-red/30' : 'border-stroke',
    )}
  >
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {icon}
      <Typography variant="h3" weight="semibold" className="text-[0.95rem]">
        {title}
      </Typography>
      {badge && (
        <span
          title={badgeTitle}
          className={cn(
            'ms-auto shrink-0 rounded-full px-2 py-0.5 text-[0.74rem] font-semibold tabular-nums',
            badgeTone === 'attention' ? 'bg-fb-red/12 text-fb-red-text'
              : badgeTone === 'good' ? 'bg-fb-green/12 text-fb-green'
                : 'bg-brand-primary/12 text-brand-primary',
          )}
        >
          {badge}
        </span>
      )}
      {aside && <span className="ms-auto shrink-0">{aside}</span>}
    </div>
    {note && (
      <Typography variant="p" className="mb-2.5 max-w-[70ch] text-ink-inactive text-[0.8rem]">
        {note}
      </Typography>
    )}
    {children}
  </section>
);

/* ONE MEASURED WHOLE, DRAWN AS ONE BAR. Used for the attention split, where the three parts are guaranteed
 * to add up to the total and drawing them apart would invite a reader to add them up themselves.
 *
 * `flexGrow` on the segments rather than a width in percent: the parts then divide exactly the space they
 * have, so three shares that sum to one cannot leave a sliver of background showing because of rounding.
 * A part with nothing in it is not drawn - a zero-width segment with a border is a mark that means nothing. */
const Split = ({
  parts,
}: {
  parts: { key: string; label: string; fill: string; text: string; value: string; share: number; delta?: string | null; note?: string }[];
}) => {
  const drawn = parts.filter((p) => p.share > 0);
  return (
    <>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-state-hover" role="img"
        aria-label={parts.map((p) => `${p.label} ${pct(p.share)}`).join(', ')}
      >
        {drawn.map((part) => (
          <div key={part.key} className={part.fill} style={{ flexGrow: part.share }} />
        ))}
      </div>
      <div className="mt-2.5 grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-3">
        {parts.map((part) => (
          <div key={part.key} className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={cn('size-2 shrink-0 rounded-full', part.fill)} />
              <span className="text-[0.76rem] uppercase tracking-wide text-ink-inactive">{part.label}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
              <strong className={cn('font-semibold text-[1.15rem] tabular-nums leading-tight', part.text)}>
                {pct(part.share)}
              </strong>
              <span className="text-[0.8rem] text-ink-secondary tabular-nums">{part.value}</span>
              {part.delta && (
                <span className="text-[0.76rem] font-semibold text-ink-inactive tabular-nums">{part.delta}</span>
              )}
            </div>
            {part.note && <span className="block text-[0.74rem] text-ink-inactive">{part.note}</span>}
          </div>
        ))}
      </div>
    </>
  );
};

const Quiet = ({ children }: { children: ReactNode }) => (
  <Typography variant="p" className="text-ink-inactive text-[0.84rem]">
    {children}
  </Typography>
);

/* "the top 12 of 34". The endpoint counts the groups BEFORE it applies its cap and sends both numbers,
 * because a truncated table that does not say it is truncated reads as the whole picture. Silent when
 * nothing was cut, so a short list is not decorated with a reassurance nobody asked for. */
const CapNote = ({ cap, what }: { cap?: Cap; what: string }) =>
  cap && cap.total > cap.shown ? (
    <Typography variant="p" className="mt-2.5 text-ink-inactive text-[0.76rem]">
      Showing the top {cap.shown} of {cap.total} {what}.
    </Typography>
  ) : null;

/* One column per day, stacked so the column's height is the run count and its colours are the outcomes.
 * The grey segment is runs minus finished minus failed - stopped, or still going. It is drawn rather than
 * dropped, because a column shorter than its own label would be a lie about how much ran that day.
 *
 * EVERY COLUMN IS A BUTTON, and that is a drill-down and an accessibility fix in the same change. The
 * container used to be one `role="img"` with a single label, which made every column's own `title` -
 * the day, the counts, the agent time - unreachable to a screen reader, since role="img" makes its
 * children presentational. A button carries that same sentence as its accessible name and can also be
 * pressed, which is what narrows the whole page to that day.
 *
 * `onPick` optional and the fallback a plain div: a column that looks pressable and does nothing is worse
 * than a column that does not look pressable. */
const DayBars = ({ days, onPick }: { days: DayRow[]; onPick?: (day: string) => void }) => {
  const tallest = Math.max(1, ...days.map((d) => d.runs));
  return (
    <div className="flex h-24 items-end gap-px">
      {days.map((day) => {
        const other = Math.max(0, day.runs - day.ok - day.failed);
        const height = (day.runs / tallest) * 100;
        const said = `${fmtDay(day.day)} — ${day.runs} run${day.runs === 1 ? '' : 's'}, ${day.ok} finished, ${day.failed} failed, ${fmtSeconds(day.agentSeconds)} of agent time`;
        const Column = onPick ? 'button' : 'div';
        return (
          <Column
            key={day.day}
            {...(onPick
              ? {
                type: 'button' as const,
                onClick: () => onPick(day.day),
                'aria-label': `${said}. Show this day only.`,
              }
              : {})}
            className={cn(
              'flex min-w-[2px] flex-1 flex-col justify-end',
              onPick && 'rounded-sm transition-opacity duration-fast hover:opacity-70'
                + ' focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1'
                + ' focus-visible:outline-brand-primary',
            )}
            style={{ height: '100%' }}
            title={said}
          >
            <div className="flex flex-col justify-end rounded-sm overflow-hidden" style={{ height: `${height}%` }}>
              {day.failed > 0 && (
                <div className="bg-fb-red" style={{ flexGrow: day.failed, minHeight: '2px' }} />
              )}
              {other > 0 && (
                <div className="bg-ink-inactive/45" style={{ flexGrow: other, minHeight: '2px' }} />
              )}
              {day.ok > 0 && <div className="bg-fb-green" style={{ flexGrow: day.ok, minHeight: '2px' }} />}
            </div>
            {/* Outside the stack, not inside it: a day with no runs scales that box to height 0 and it
              * clips its own children, so a hairline in there was invisible and a quiet day looked the
              * same as a day the window does not cover. */}
            {day.runs === 0 && <div className="h-px bg-stroke" />}
          </Column>
        );
      })}
    </div>
  );
};

/* Agent time under the run counts: the same x-axis, so a tall day of cheap runs and a quiet day of one
 * long one are told apart without reading either number. Non-scaling stroke because the viewBox is
 * stretched to the container's width and an ordinary stroke would be stretched with it. */
const Sparkline = ({ values }: { values: number[] }) => {
  if (values.length < 2) return null;
  const top = Math.max(1, ...values);
  const points = values
    .map((value, i) => `${(i / (values.length - 1)) * 100},${28 - (Math.max(0, value) / top) * 26}`)
    .join(' ');
  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      className="h-8 w-full text-brand-primary"
      role="img"
      aria-label="agent time per day"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

/** A plain proportion bar. Width is the whole encoding, so the number beside it is a check, not the message. */
const Meter = ({ fraction, fill }: { fraction: number; fill: string }) => (
  <div className="h-1.5 w-full overflow-hidden rounded-full bg-state-hover">
    <div className={cn('h-full rounded-full', fill)} style={{ width: pct(Math.min(1, Math.max(0, fraction))) }} />
  </div>
);

/* A table that becomes a list of cards where there is no room to be a table.
 *
 * Above `md` these are the same tables they were and none of this applies. Below it the SHAPE changes
 * rather than the width: seven columns in the 260px the extension's panel can give them is not a narrow
 * table, it is a row you scroll sideways to read, which is not reading. So the row becomes a card, every
 * cell carries its own heading from `data-label`, and the header row goes - a heading over a stack of
 * cards names nothing.
 *
 * The same change ce04fca made to the skill and member rows. Those are grids, so a `md:grid-cols-[…]` was
 * enough; a real <table> has to have its display overridden instead, which is the rest of this. ONE
 * constant for three tables - the alternative was a second rendering of every row, and a second copy of a
 * row is a copy that drifts.
 *
 * EVERY CELL NEEDS `data-label`, and this is the one thing to get wrong: `attr()` on a missing attribute
 * is the empty string, so a forgotten one does not fail, it renders a number with nothing naming it -
 * worse than the table it replaced. The first cell of each row is the name, opts out by having no label,
 * and takes the whole width above the rest.
 */
const CARD_ROWS_BELOW_MD = [
  'max-md:block',
  '[&_thead]:max-md:hidden',
  '[&_tbody]:max-md:block',
  /* No border below md: the row's own `border-b last:border-0` would leave the last card with none, and
     fighting it with another border rule is two rules for one edge. A card is its background instead. */
  '[&_tr]:max-md:mb-1.5 [&_tr]:max-md:block [&_tr]:max-md:rounded-lg [&_tr]:max-md:border-0',
  '[&_tr]:max-md:bg-surface-card2 [&_tr]:max-md:px-3 [&_tr]:max-md:py-2',
  '[&_tr:last-child]:max-md:mb-0',
  '[&_td]:max-md:flex [&_td]:max-md:items-center [&_td]:max-md:justify-between [&_td]:max-md:gap-3',
  /* break-words, because the first column is a name and a name here can be a URL: app.hubspot.com as
     one unbreakable token was 20px past the edge of its own card. */
  '[&_td]:max-md:w-auto [&_td]:max-md:break-words [&_td]:max-md:px-0 [&_td]:max-md:py-0.5',
  '[&_td]:max-md:before:shrink-0 [&_td]:max-md:before:text-[0.76rem] [&_td]:max-md:before:font-normal',
  '[&_td]:max-md:before:text-ink-inactive [&_td]:max-md:before:content-[attr(data-label)]',
  '[&_td:first-child]:max-md:mb-1 [&_td:first-child]:max-md:block',
].join(' ');


/* --------------------------------------------------------------------------- the page */

/* Today, 7 days, and a calendar. 30 and 90 were here and are gone: three presets plus Custom is four
 * controls answering one question, and the two long ones were the least used - a quarter of runs is a
 * question you ask with real dates, not with a button. Custom still reaches 365, which is the server's cap. */
const RANGES = [7];

const PRESET = 'rounded-md px-2.5 py-1 text-[0.82rem] font-medium transition-colors duration-fast';
/* The selected preset sits ON the accent, which is now lime - a light colour - so its label is the
 * theme-independent near-black rather than --content-on-solid, which is white by design and right
 * where it sits over a dark surface. See src/mouseflow-palette.css. */
const PRESET_ON = 'on-accent bg-brand-primary';
const PRESET_OFF = 'text-ink-secondary hover:bg-state-hover';

/* Two dates as one short label. The same day says itself once - "21.08", not "21.08 – 21.08", which reads
 * as a range somebody got wrong. */
const labelFor = (from: Date, to: Date) => {
  const d = (x: Date) => `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}`;
  return d(from) === d(to) ? d(from) : `${d(from)} – ${d(to)}`;
};

const ASSISTANT_KEY = 'mouseflow.insights.assistant';
const ASSISTANT_WIDTH_KEY = 'mouseflow.insights.assistant.width';
/* 26rem was a guess about every answer. A reply with a table in it needs room, so the width is the user's -
 * clamped so the dashboard beside it cannot be squeezed into a column of wrapped words. */
const WIDTH_MIN = 320;
const WIDTH_MAX = 900;
const WIDTH_DEFAULT = 416;

export const InsightsView = () => {
  /* A recording handed over by the transcript panel, read once. In a state initialiser rather than an
   * effect, because the assistant wants its opening question on the first render - an effect would give it
   * an empty thread and then, a frame later, a question, which reads as the app talking to itself. */
  /* Which of the two assistant shells to render - and only one of them, which was not true before.
   *
   * The wide one lives in a resizable aside and the narrow one in a full-screen overlay, and the choice used
   * to be `hidden max-xl:flex`: a CSS class, so BOTH were mounted, both ran their effects, both probed the
   * model list. Wasteful then; wrong now that a conversation is saved, because two mounted assistants hold
   * two thread ids and write the same exchange twice as two different conversations.
   *
   * 1280px is Tailwind's `xl`, which is the breakpoint the classes used. Kept in sync by being the only
   * place either of them is decided. */
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1280px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1280px)');
    const listen = (ev: MediaQueryListEvent) => setWide(ev.matches);
    mq.addEventListener('change', listen);
    return () => mq.removeEventListener('change', listen);
  }, []);

  /* What page chrome this surface expects. As a route this screen IS the page - it fills the window below
   * the top bar and scrolls inside itself, so the assistant beside it can stay put. In the extension's
   * panel <main> already does both, the assistant column is hidden below xl anyway, and asking for a
   * second scroller inside the first is how the panel came to have two vertical scrollbars. */
  const page = usePageChrome();

  const [asked] = useState(() => takeAsk());
  const opening = asked ? openingQuestion(asked) : undefined;
  const navigate = useNavigate();
  /* 7 days, matching the only preset that remains. It was 30, which stopped being a preset and so would
   * have opened the page on a range no button was showing as selected.
   *
   * And the address wins over that default, for the same reason the team scope does: a slice of this page
   * is worth sending to somebody, and a link that opens the last seven days instead of the day being
   * discussed is a link that argues with its own sender. */
  const [window_, setWindow] = useState<Window>(
    () => windowFromAddress(window.location.search) ?? { kind: 'days', days: 7 },
  );

  /* WHOSE numbers, kept in the address rather than only in state.
   *
   * Read from the query string on the way in, so the Teams page can link straight to a team's dashboard and
   * so a link somebody pastes opens what they were looking at. Written back with replaceState rather than
   * through the router: /dashboard declares no search schema, and adding one to type a single optional
   * string would push validation into every other caller of this route.
   *
   * The scope named here is a REQUEST. What the page renders is `data.scope`, which is the endpoint's
   * answer - a team the reader has since been removed from is refused, not answered about. */
  const [scope, setScope] = useState<Scope>(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const id = q.get('team');
      const person = q.get('person');
      return id ? { kind: 'team', id, person: person || undefined } : { kind: 'mine' };
    } catch (_) {
      return { kind: 'mine' };
    }
  });

  /* WHOSE and WHICH WINDOW, both written back. One effect rather than two: they land in the same address,
   * and two effects racing to replaceState the same URL is how one of them loses its parameter.
   *
   * The parameters written are exactly the ones the endpoint reads, so the address is not a second
   * language - it is the request. `days` and `from`/`to` are mutually exclusive there, so the unused pair
   * is deleted rather than left behind, or a switch from a custom range back to 7 days would leave the old
   * dates in the link and reopen the range that was just dismissed. */
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (scope.kind === 'team') url.searchParams.set('team', scope.id);
      else url.searchParams.delete('team');
      if (scope.kind === 'team' && scope.person) url.searchParams.set('person', scope.person);
      else url.searchParams.delete('person');
      if (window_.kind === 'days') {
        url.searchParams.set('days', String(window_.days));
        url.searchParams.delete('from');
        url.searchParams.delete('to');
      } else {
        url.searchParams.set('from', window_.from.toISOString());
        url.searchParams.set('to', window_.to.toISOString());
        url.searchParams.delete('days');
      }
      window.history.replaceState(null, '', url.toString());
    } catch (_) { /* nothing on this page depends on the address being right */ }
  }, [scope, window_]);

  /* The teams this person may point the page at: the ones they own or administer, and no others. A member
   * is not offered a switch at all, because the only thing it could do is be refused - and their own
   * numbers are already what they are looking at.
   *
   * Failure is still silence, and now it is the provider's silence: `teams` stays null and this reads as an
   * empty list, so the picker is simply not offered. That is the right answer for a CONTROL - a dashboard
   * that renders an error because the team list could not be read would be broken by something it does not
   * need.
   *
   * The fetch that used to be here was the second copy of the same read: this page and the Teams page each
   * had one, so opening both read the list twice and returning to either read it again. */
  const { teams: allTeams } = useTeams();
  const teams = useMemo(
    () => (allTeams ?? []).filter((t) => t.role === 'owner' || t.role === 'admin'),
    [allTeams],
  );
  /* The calendar is a panel rather than a mode: it opens over the controls, sets a range and closes. */
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  /* Open by default on a wide screen: an assistant nobody notices is an assistant nobody uses. Remembered,
   * because whether you want it is a preference about this page rather than about this visit. */
  /* Three states, not a boolean, now that the panel carries its own controls:
   *
   *   open     the column beside the dashboard
   *   min      a rail on the right edge — out of the way, one click back, conversation intact
   *   closed   gone, with a small button in the corner to bring it back
   *
   * Minimise and close both have to leave a way in, or they are the same control with two labels. The old
   * '1'/'0' values are still read, so nobody who had it hidden finds it open again. */
  const [assistant, setAssistant] = useState<'open' | 'min' | 'closed'>(() => {
    try {
      const saved = localStorage.getItem(ASSISTANT_KEY);
      if (saved === 'min' || saved === 'closed' || saved === 'open') return saved;
      return saved === '0' ? 'closed' : 'open';
    } catch (_) { return 'open'; }
  });

  useEffect(() => {
    try { localStorage.setItem(ASSISTANT_KEY, assistant); } catch (_) { /* private mode */ }
  }, [assistant]);

  const [panelWidth, setPanelWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(ASSISTANT_WIDTH_KEY));
      return Number.isFinite(saved) && saved >= WIDTH_MIN ? Math.min(saved, WIDTH_MAX) : WIDTH_DEFAULT;
    } catch (_) {
      return WIDTH_DEFAULT;
    }
  });

  /* Dragging the panel's edge. Pointer events rather than mouse events so a trackpad or a pen works, and
   * capture on the handle so the drag survives the pointer crossing the iframe-less dashboard beneath it. */
  const drag = useCallback((down: React.PointerEvent<HTMLDivElement>) => {
    down.preventDefault();
    const handle = down.currentTarget;
    handle.setPointerCapture(down.pointerId);
    const startX = down.clientX;
    const startWidth = panelWidth;

    const move = (ev: PointerEvent) => {
      // Dragging left widens: the handle is on the panel's left edge.
      const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, startWidth - (ev.clientX - startX)));
      setPanelWidth(next);
    };
    const up = () => {
      handle.releasePointerCapture(down.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      setPanelWidth((width) => {
        try { localStorage.setItem(ASSISTANT_WIDTH_KEY, String(width)); } catch (_) { /* private mode */ }
        return width;
      });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }, [panelWidth]);
  const [data, setData] = useState<Insights | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  /* Bumped to ask for the same window again. A state value rather than calling load() directly, so the
   * effect stays the only thing that starts a request and the abort below always matches it. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const stop = new AbortController();
    setBusy(true);
    setProblem(null);
    (async () => {
      try {
        const body = await fetchInsights(window_, scope, stop.signal);
        setData(body);
      } catch (err) {
        if (stop.signal.aborted) return; // a range switch, not a failure
        setProblem(err instanceof Error ? err.message : 'the insights could not be read');
      } finally {
        if (!stop.signal.aborted) setBusy(false);
      }
    })();
    return () => stop.abort();
  }, [window_, scope, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const totals = data?.totals;
  const counts = useMemo(() => {
    if (!totals) return null;
    /* byOutcome is a list, so it is turned into a lookup here rather than indexed as though it were one.
     * `totals` still stands in for an outcome the endpoint did not send a row for: it has a documented
     * field per outcome, and the two are shaped from the same counts, so they cannot contradict. */
    const sent = new Map(list(data?.byOutcome).map((row) => [row.outcome, row.runs]));
    return OUTCOMES.map((outcome) => ({
      ...outcome,
      count: sent.get(outcome.key) ?? totals[outcome.key],
    })).filter((row) => Number.isFinite(row.count));
  }, [data, totals]);

  const runs = totals?.runs ?? 0;
  const byDay = list(data?.byDay);
  const nothingYet = !!totals && runs === 0 && totals.recordings === 0 && totals.createdSkills === 0;

  /* ------------------------------------------------------------------ comparing with the window before
   *
   * Three different arithmetics, kept apart on purpose. Runs compare as a percentage, a rate compares in
   * POINTS - printing "+8%" for eight points is the classic way a dashboard lies quietly - and a duration
   * compares as a duration. Every one of them returns null rather than a zero when there is nothing to
   * compare against, so an empty previous window shows no delta instead of a confident "0%".
   */
  const prev = data?.previous;
  const hadPrev = prev?.had === true;

  const pace = useMemo(() => {
    const nowRuns = num(data?.totals?.runs) ?? 0;
    const thenRuns = num(prev?.runs) ?? 0;
    const nowTime = (num(data?.totals?.agentHours) ?? 0) * 3600;
    const thenTime = (num(prev?.agentHours) ?? 0) * 3600;
    const since = hadPrev && prev?.from
      ? `Compared with ${new Date(String(prev.from)).toLocaleDateString()} to ${new Date(String(prev.to)).toLocaleDateString()}`
      : 'Nothing ran in the window before this one, so there is nothing to compare with.';

    if (!hadPrev || thenRuns === 0) return { runs: null, runsTone: 'flat' as const, time: null, since };

    const change = Math.round(((nowRuns - thenRuns) / thenRuns) * 100);
    const timeChange = Math.round(nowTime - thenTime);
    return {
      runs: `${change > 0 ? '+' : ''}${change}% vs previous`,
      /* More runs is not automatically better - it can mean more retries - so this stays neutral. The rate
       * tile is the one that knows which direction is good. */
      runsTone: 'flat' as const,
      time: Math.abs(timeChange) < 30 ? null
        : `${timeChange > 0 ? '+' : '−'}${fmtSeconds(Math.abs(timeChange))} vs previous`,
      since,
    };
  }, [data?.totals?.runs, data?.totals?.agentHours, prev?.runs, prev?.agentHours, prev?.from, prev?.to, hadPrev]);

  const rate = useMemo(() => {
    const decided = (t?: { ok?: unknown; failed?: unknown }) => {
      const ok = num(t?.ok) ?? 0;
      const failed = num(t?.failed) ?? 0;
      return ok + failed > 0 ? Math.round((ok / (ok + failed)) * 100) : null;
    };
    const now = decided(data?.totals);
    const then = hadPrev ? decided(prev) : null;
    const stopped = num(data?.totals?.stopped) ?? 0;
    const running = num(data?.totals?.running) ?? 0;
    const aside = [
      stopped ? `${stopped} stopped` : null,
      running ? `${running} still going` : null,
    ].filter(Boolean).join(', ');

    return {
      now,
      delta: now != null && then != null
        ? `${now - then > 0 ? '+' : ''}${now - then} points`
        : null,
      /* Up is good here, and it is the only tile where that is true without qualification. */
      tone: (now != null && then != null
        ? (now > then ? 'up' : now < then ? 'down' : 'flat')
        : 'flat') as 'up' | 'down' | 'flat',
      note: now == null
        ? 'no run has finished or failed yet'
        : `of ${(num(data?.totals?.ok) ?? 0) + (num(data?.totals?.failed) ?? 0)} decided${aside ? ` · ${aside}` : ''}`,
    };
  }, [data?.totals, prev, hadPrev]);

  /* Runs, not reasons. Four reasons over four runs and four reasons over forty are the same list and very
   * different weeks, so the badge counts what was affected rather than what was grouped. */
  const affected = useMemo(
    () => list(data?.failures).reduce((sum, row) => sum + (num(row.times) ?? 0), 0),
    [data?.failures],
  );

  /* What the endpoint says it counted, which is the only thing worth putting on screen. `scope` above is
   * what was asked for; these two agree except in the moment between switching and the answer arriving,
   * and during a refusal - when the page must keep saying "yours", because that is what is on it. */
  const showing = data?.scope;
  const teamShown = showing?.kind === 'team' ? showing : null;
  const people = useMemo(() => list(teamShown?.people), [teamShown]);
  /* One member, when the view is narrowed to them. Read from the ANSWER rather than from `scope`, so the
   * header never names somebody the endpoint did not actually count. */
  const personShown = teamShown?.person ?? null;
  const personName = personShown ? (personShown.name || personShown.email || 'one member') : null;

  /* ------------------------------------------------------------------ the three behaviour blocks
   *
   * Shaped for drawing and nothing more: the shares, the boundaries and the comparison all arrive from the
   * endpoint, and this turns them into the rows the bar and the legend take. The one piece of arithmetic
   * here is the SUBTRACTION of two shares, and it is in points - see `points` above for why that is not a
   * detail.
   *
   * Null when there is no measured time at all. A three-part bar of noughts is a bar that says a working
   * day was zero seconds long, which is not what "no recordings in this window" means. */
  const attention = data?.attention;
  const prevAttention = data?.previousBehaviour?.attention;
  const spent = useMemo(() => {
    if (!attention || !(attention.measuredSeconds > 0)) return null;
    const secs = (ms: number) => Math.round(ms / 1000);
    const mins = (ms: number) => Math.round(ms / 60000);
    /* The two boundaries in words, under the numbers they decide. A share of "waiting" is not readable
     * until the reader knows how long a pause has to be before it counts as waiting. */
    const under = `${secs(attention.activeUnderMs)}s`;
    const over = `${mins(attention.awayOverMs)} min`;
    return [
      {
        key: 'active',
        label: 'doing',
        fill: 'bg-brand-primary',
        text: 'text-brand-primary',
        value: fmtSeconds(attention.active.seconds),
        share: asFraction(attention.active.share),
        delta: points(asFraction(attention.active.share),
          prevAttention ? asFraction(prevAttention.active.share) : null),
        note: `pauses under ${under} count as inside an action`,
      },
      {
        key: 'waiting',
        label: 'waiting or reading',
        fill: 'bg-fb-attention',
        text: 'text-fb-attention',
        value: fmtSeconds(attention.waiting.seconds),
        share: asFraction(attention.waiting.share),
        delta: points(asFraction(attention.waiting.share),
          prevAttention ? asFraction(prevAttention.waiting.share) : null),
        note: `between ${under} and ${over} of nothing happening`,
      },
      {
        /* Grey, the same grey the applications table gives to time it cannot place - because this is the
         * same kind of thing: measured, real, and not work. */
        key: 'away',
        label: 'away from the machine',
        fill: 'bg-ink-inactive/45',
        text: 'text-ink-secondary',
        value: fmtSeconds(attention.away.seconds),
        share: asFraction(attention.away.share),
        delta: points(asFraction(attention.away.share),
          prevAttention ? asFraction(prevAttention.away.share) : null),
        note: `pauses over ${over}`,
      },
    ];
  }, [attention, prevAttention]);

  /* WHAT WAS PRESSED, with movement held out of the ranking and stated on its own.
   *
   * `tallest` is the largest kind EXCLUDING movement, because movement is 86% of events: measured against
   * it every other bar is a hairline, and a chart where nothing is comparable is a chart nobody reads. */
  const doing = useMemo(() => {
    const a = data?.actions;
    if (!a || !(a.total > 0)) return null;
    const kinds = list(a.byKind).filter((k) => (num(k.count) ?? 0) > 0);
    const tallest = Math.max(1, ...kinds.map((k) => num(k.count) ?? 0));
    const top = list(a.top).filter((t) => (num(t.count) ?? 0) > 0);
    const loudest = Math.max(1, ...top.map((t) => num(t.count) ?? 0));
    return {
      total: a.total,
      moves: num(a.moves) ?? 0,
      /* The share movement takes of everything, said once here rather than left for the reader to divide. */
      moveShare: a.total > 0 ? (num(a.moves) ?? 0) / a.total : 0,
      kinds: kinds.map((k) => ({ ...k, of: (num(k.count) ?? 0) / tallest })),
      top: top.map((t) => ({ ...t, of: (num(t.count) ?? 0) / loudest })),
    };
  }, [data?.actions]);

  /* The agent time already spent on goals that ran more than once. Not a saving - see the tile. */
  const repeatCost = useMemo(
    () => list(data?.repeated).reduce((sum, row) => sum + (num(row.seconds) ?? 0), 0),
    [data?.repeated],
  );

  return (
    /* Two columns, because the questions somebody wants to ask are about the numbers next to them. The
     * dashboard scrolls; the assistant does not move. Below 1280px there is not room for both, so the panel
     * becomes a toggle over the page rather than a column beside it. */
    <div className={cn('flex min-h-0', page.height)}>
      <div className={cn('min-w-0 flex-1', page.scroll, page.gutter)}>
      <header className="mb-4 flex flex-wrap items-end gap-3">
        {/* A wrap threshold rather than min-w-0 - but only at a width where 20rem is a width this column
         * can actually have.
         *
         * The controls beside it cannot shrink below their own buttons, so with a bare `min-w-0` this column
         * was the only thing that could give, and it gave all of it: with the assistant panel open, the
         * heading came out one word per line down a 60px gutter. 20rem is the width at which the sentence
         * still reads.
         *
         * Below `sm` there is no such width - the extension's side panel hands this screen 236px in total -
         * so the threshold stops being a threshold and becomes a floor 84px wider than the page, which is
         * what put a sideways scrollbar under the dashboard. There `basis-full` does the same job from the
         * other side: this column takes a row of its own, and the controls wrap under it because nothing is
         * left on the line, which is what `flex-wrap` was there to do. */}
        <div className="min-w-0 flex-1 basis-full sm:min-w-[20rem] sm:basis-auto">
          <Typography variant="span" className="block text-[0.7rem] uppercase tracking-wide text-ink-inactive">
            {teamShown
              ? `${teamShown.team?.name ?? 'Team'} · ${personName ?? 'everybody'}`
              : 'Work pulse'}
          </Typography>
          <Typography variant="h2" weight="semibold" className="mt-0.5 text-[1.5rem] leading-tight tracking-tight">
            What happened, and where the leverage is
          </Typography>
          <Typography variant="p" className="mt-1 max-w-[76ch] text-ink-inactive text-[0.85rem]">
            Activity, reliability and repeated work, read from{' '}
            {teamShown
              ? (personName
                ? `${personName}’s recordings and runs — one member of ${teamShown.team?.name ?? 'the team'}.`
                : `every member’s recordings and runs — ${people.length} ${people.length === 1 ? 'person' : 'people'}.`)
              : 'your own recordings and runs.'}{' '}
            {data
              ? `${new Date(data.window.from).toLocaleDateString()} to ${new Date(data.window.to).toLocaleDateString()}.`
              : 'Nothing here leaves your account.'}
          </Typography>
        </div>

        {/* --------------------------------------------------------------- whose numbers
          *
          * Offered only to somebody who owns or administers a team. Not a permission - the endpoint checks
          * the role again on every request, and would refuse this by name - but a control that can only
          * ever be refused is worse than no control.
          *
          * A segmented pair while there is one team to switch to, a select past that: five teams as five
          * buttons is a control that wraps under the range picker and pushes the page down a line. */}
        {teams.length > 0 && (
          /* Wrapping, and the selects allowed to shrink: this group is only ever three controls wide when
            * a team is being shown, and then it was 324px of min-content in a 236px header. Two lines is
            * the honest answer at that width; the `max-w` above keeps it one line wherever it fits. */
          <div className="flex flex-wrap items-center gap-1 rounded-lg border-stroke border bg-surface-card p-1">
            <button
              type="button"
              onClick={() => setScope({ kind: 'mine' })}
              aria-pressed={scope.kind === 'mine'}
              title="Only what you recorded and ran"
              className={cn(PRESET, scope.kind === 'mine' ? PRESET_ON : PRESET_OFF)}
            >
              Mine
            </button>

            {teams.length === 1 ? (
              <button
                type="button"
                onClick={() => setScope({ kind: 'team', id: teams[0].id })}
                aria-pressed={scope.kind === 'team'}
                title={`Everybody in ${teams[0].name}. Owners and admins only.`}
                className={cn(PRESET, 'flex min-w-0 items-center gap-1.5 max-w-[14rem]',
                  scope.kind === 'team' ? PRESET_ON : PRESET_OFF)}
              >
                <Users className="size-3.5 shrink-0" />
                <span className="truncate">{teams[0].name}</span>
              </button>
            ) : (
              <select
                value={scope.kind === 'team' ? scope.id : ''}
                onChange={(e) => setScope(e.target.value ? { kind: 'team', id: e.target.value } : { kind: 'mine' })}
                aria-label="Which team’s numbers"
                className={cn(PRESET, 'min-w-0 max-w-[14rem] cursor-pointer',
                  scope.kind === 'team' ? PRESET_ON : PRESET_OFF)}
              >
                <option value="">A team…</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}

            {/* And which member, once a team is being shown.
              *
              * Its options come from the ANSWER's roster, which the endpoint keeps whole even while the
              * counting is narrowed to one person — otherwise choosing somebody would leave a picker with
              * only them in it, and no way back to anybody else. */}
            {teamShown && people.length > 0 && (
              <select
                value={scope.kind === 'team' ? (scope.person ?? '') : ''}
                onChange={(e) => setScope((was) => (was.kind === 'team'
                  ? { kind: 'team', id: was.id, person: e.target.value || undefined }
                  : was))}
                aria-label="Which member’s numbers"
                title="Narrow every number on this page to one member of the team"
                className={cn(PRESET, 'min-w-0 max-w-[13rem] cursor-pointer border-stroke border-s ps-2',
                  personShown ? PRESET_ON : PRESET_OFF)}
              >
                <option value="">Everybody</option>
                {people.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name || row.email || 'somebody'}{row.you ? ' (you)' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* The range is a control, not a filter to be found in a menu: it is the first thing anyone changes. */}
        <div className="relative flex items-center gap-1 rounded-lg border-stroke border bg-surface-card p-1">
          <button
            type="button"
            onClick={() => { setPicking(false); setWindow(todayWindow()); }}
            aria-pressed={window_.kind === 'range' && window_.label === 'Today'}
            className={cn(PRESET, window_.kind === 'range' && window_.label === 'Today'
              ? PRESET_ON : PRESET_OFF)}
          >
            Today
          </button>
          {RANGES.map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => { setPicking(false); setWindow({ kind: 'days', days: range }); }}
              aria-pressed={window_.kind === 'days' && window_.days === range}
              className={cn(PRESET, window_.kind === 'days' && window_.days === range
                ? PRESET_ON : PRESET_OFF)}
            >
              {range} days
            </button>
          ))}
          {/* Custom shows the dates once they are chosen, because "Custom" alone makes somebody open the
            * calendar again just to remember what they asked for. */}
          <button
            type="button"
            onClick={() => {
              setDraft(window_.kind === 'range' && window_.label !== 'Today'
                ? { from: window_.from, to: window_.to }
                : undefined);
              setPicking((p) => !p);
            }}
            aria-expanded={picking}
            className={cn(PRESET, 'flex items-center gap-1.5',
              window_.kind === 'range' && window_.label !== 'Today' ? PRESET_ON : PRESET_OFF)}
          >
            <CalendarDays className="size-3.5" />
            {window_.kind === 'range' && window_.label !== 'Today' ? window_.label : 'Custom'}
          </button>

          {picking && (
            <div
              /* Bounded and scrollable: two months of calendar is taller than a short window, and a
                * confirm button below the fold is a picker that cannot be used. */
              className="absolute end-0 top-[calc(100%+6px)] z-30 max-h-[min(70vh,520px)] overflow-auto rounded-xl border border-stroke bg-surface-card p-2 shadow-lg"
              role="dialog"
              aria-label="Choose a date range"
            >
              <DateRangePicker
                selected={draft}
                confirmLabel="Show these dates"
                /* Nothing past today: a dashboard of the future is an empty dashboard with a confusing
                 * label on it. */
                endMonth={new Date()}
                onSelect={setDraft}
                onConfirm={(range) => {
                  if (!range?.from) { setPicking(false); return; }
                  /* One tapped day means that whole day, not a zero-length instant. */
                  const from = startOfDay(range.from);
                  const to = endOfDay(range.to ?? range.from);
                  setWindow({ kind: 'range', from, to, label: labelFor(from, to) });
                  setPicking(false);
                }}
              />
            </div>
          )}
        </div>

        <Button variant="ghost" size="sm" leftSlot={<RefreshCw className="size-4" />} isLoading={busy} onClick={reload}>
          Refresh
        </Button>

        {/* No "Hide the assistant" here any more: a control for the panel, living outside the panel, on a
          * header row that already carries the scope switch, the member picker and the range. It closes
          * and minimises from its own title bar now, and this button only brings it back. */}
        {/* Only when there is no other way back. Minimised on a wide screen there IS one — the rail on the
          * right edge — and showing both put two "Ask about this" affordances on screen at once. */}
        {(assistant === 'closed' || (assistant === 'min' && !wide)) && (
          <Button
            variant="ghost"
            size="sm"
            leftSlot={<MessageSquareText className="size-4" />}
            onClick={() => setAssistant('open')}
          >
            Ask about this
          </Button>
        )}
      </header>

      {/* A real failure, in the endpoint's own words. It knows what went wrong; repeating "something went
        * wrong" here would throw away the only useful thing on the screen. */}
      {problem && (
        <section className="mb-4 rounded-xl border-fb-red/40 border bg-surface-card p-4">
          <div className="flex items-center gap-1.5">
            <TriangleAlert className="size-4 text-fb-red-text" />
            <Typography variant="span" weight="semibold" className="text-[0.9rem] text-fb-red-text">
              The insights could not be read
            </Typography>
          </div>
          <Typography variant="p" className="mt-1 max-w-[70ch] text-ink-secondary text-[0.85rem]">
            {problem}
          </Typography>
          <Button size="sm" className="mt-3" onClick={reload}>
            Try again
          </Button>
        </section>
      )}

      {!data && !problem && <Quiet>Reading your history…</Quiet>}

      {data && (
        <div className={cn('space-y-4', busy && 'opacity-60 transition-opacity duration-base')}>
          {nothingYet ? (
            <section className="rounded-xl border-stroke border bg-surface-card p-5">
              <Typography variant="h3" weight="semibold" className="text-[0.95rem]">
                Nothing to look at yet
              </Typography>
              <Typography variant="p" className="mt-1 max-w-[62ch] text-ink-secondary text-[0.87rem]">
                This page is built from what you have recorded and run, and in the last {data.window.days} days
                there is neither. Record a task you do often, or describe a goal in Create and let an agent
                try it — either one gives this page something to read.
              </Typography>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" leftSlot={<Film className="size-4" />} onClick={() => void navigate({ to: '/record' })}>
                  Record something
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  leftSlot={<Sparkles className="size-4" />}
                  onClick={() => void navigate({ to: '/create' })}
                >
                  Describe a goal
                </Button>
              </div>
            </section>
          ) : (
            <>
              {/* ------------------------------------------------------- the summary, first */}
              <section className="rounded-xl border-stroke border bg-surface-card p-4">
                {/* Six, in two rows of three: what there is, then how it went. Three-up rather than
                  * six-up because a tile is a number and a label and a note, and six of those across a
                  * 1280px page leaves every note wrapping to three lines.
                  *
                  * EVERY ONE OF THEM IS THIS WINDOW, not all time, and each says so in its own note. The
                  * page has one window and one scope; a lifetime total sitting in the same row as a
                  * seven-day count is the tile somebody screenshots and misreads. */}
                <div className="grid grid-cols-[minmax(0,1fr)] gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  <Tile
                    icon={<Film className="size-3.5" />}
                    label="recordings"
                    value={String(totals?.recordings ?? 0)}
                    note="made in this window"
                    title="Recordings whose creation date falls inside this window. A recording made earlier and edited now counts here, because the stored creation date is nullable and the endpoint places such a flow by when it was last written rather than dropping it."
                  />
                  <Tile
                    icon={<Sparkles className="size-3.5" />}
                    label="skills made"
                    value={String(totals?.createdSkills ?? 0)}
                    note="written from a goal, not recorded"
                    title="Flows of kind 'created' — the ones written from a described goal in Create. Recordings are the tile beside this one; nothing is counted in both."
                  />
                  <Tile
                    icon={<Timer className="size-3.5" />}
                    label="agent runs"
                    value={String(runs)}
                    delta={pace.runs}
                    tone={pace.runsTone}
                    note={`${totals?.ok ?? 0} finished, ${totals?.failed ?? 0} failed`}
                    title={pace.since}
                  />
                  <Tile
                    icon={<Clock className="size-3.5" />}
                    label="agent time"
                    value={fmtSeconds((totals?.agentHours ?? 0) * 3600)}
                    delta={pace.time}
                    tone="flat"
                    note="wall clock, start of a run to its finish"
                    title={pace.since}
                  />
                  {/* The denominator is the honest part, and it is on screen rather than in a comment: a
                    * stopped run is a decision and a running one has not happened yet, so counting either
                    * would let somebody move this number by stopping runs. */}
                  <Tile
                    icon={<ShieldCheck className="size-3.5" />}
                    label="success rate"
                    value={rate.now == null ? '—' : `${rate.now}%`}
                    delta={rate.delta}
                    tone={rate.tone}
                    note={rate.note}
                    title="Finished divided by finished plus failed. Stopped and still-running are left out of both halves."
                  />
                  {/* Where the reference says "Could save 18m/week". This endpoint has never reported a
                    * saving, because nothing stored says how long the same task takes by hand - it says so in
                    * its own gaps list. The measured number is the agent time already spent on the repeats. */}
                  <Tile
                    icon={<Sparkles className="size-3.5" />}
                    label="worth automating"
                    value={String(list(data.repeated).length)}
                    note={repeatCost
                      ? `${fmtSeconds(repeatCost)} of agent time on repeats`
                      : 'no goal ran more than once'}
                    title="Goals that ran more than once in this window. The time is what those runs took — not a saving, which nothing here can measure."
                  />
                </div>

                {counts && runs > 0 && (
                  <div className="mt-4">
                    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-state-hover">
                      {counts.map((row) =>
                        row.count > 0 ? (
                          <div key={row.key} className={row.fill} style={{ flexGrow: row.count }} />
                        ) : null,
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {counts.map((row) => (
                        <span key={row.key} className="flex items-center gap-1.5 text-[0.8rem]">
                          <span className={cn('size-2 rounded-full', row.fill)} />
                          <strong className={cn('font-semibold tabular-nums', row.text)}>{row.count}</strong>
                          <span className="text-ink-secondary">{row.label}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              {/* --------------------------------------------------------------- who did what
                *
                * Only on the team view, and it is the reason the team view exists: the header says ninety
                * runs, and the question immediately after it is whose. Sorted busiest first by the
                * endpoint rather than here, so two readers of the same window see the same order.
                *
                * COUNTS AND DATES. Every column here was already on the team roster - there is nothing in
                * this table that a manager could not see before, and no way from it to what somebody
                * actually recorded. */}
              {/* Not while the page is narrowed to one member: a one-row "who did what" under a header
                * that already names them is noise, and a table still summing the whole team under a
                * header counting one person is a contradiction. The picker above holds the roster. */}
              {teamShown && !personShown && (
                <Section
                  title="Who did what"
                  icon={<Users className="size-4 text-ink-secondary" />}
                  badge={`${people.length} ${people.length === 1 ? 'person' : 'people'}`}
                  note="Counts for this window only, so a quiet fortnight shows as noughts rather than as an absence. Nothing here opens a recording: a skill becomes visible to the team only when its owner shares that one skill."
                >
                  {people.length === 0 ? (
                    <Quiet>This team has nobody in it yet.</Quiet>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className={cn('w-full border-collapse text-[0.85rem] md:min-w-[620px]', CARD_ROWS_BELOW_MD)}>
                        <thead>
                          <tr className="bg-table-header-bg text-ink-secondary">
                            <th className="rounded-l-md px-2.5 py-2 text-left font-medium">Person</th>
                            <th className="px-2.5 py-2 text-right font-medium">Recordings</th>
                            <th className="px-2.5 py-2 text-right font-medium">Skills</th>
                            <th className="px-2.5 py-2 text-right font-medium">Runs</th>
                            <th className="px-2.5 py-2 text-left font-medium">Finished</th>
                            <th className="px-2.5 py-2 text-right font-medium">Agent time</th>
                            <th className="rounded-r-md px-2.5 py-2 text-right font-medium">Last run</th>
                          </tr>
                        </thead>
                        <tbody>
                          {people.map((row) => {
                            const settled = row.ok + row.failed;
                            const rate = settled > 0 ? row.ok / settled : 0;
                            return (
                              <tr key={row.id} className="border-stroke border-b last:border-0">
                                <td className="px-2.5 py-2">
                                  <span className="text-ink-primary">
                                    {row.name || row.email || 'Somebody'}
                                  </span>
                                  {row.you && (
                                    <span className="ms-1.5 text-[0.74rem] text-ink-inactive">you</span>
                                  )}
                                  <span className="ms-2 rounded-full bg-state-hover px-1.5 py-0.5 text-[0.7rem] text-ink-secondary">
                                    {row.role}
                                  </span>
                                </td>
                                <td data-label="Recordings" className="px-2.5 py-2 text-right text-ink-secondary tabular-nums">{row.recordings}</td>
                                <td data-label="Skills" className="px-2.5 py-2 text-right text-ink-secondary tabular-nums">{row.createdSkills}</td>
                                <td data-label="Runs" className="px-2.5 py-2 text-right text-ink-primary tabular-nums">{row.runs}</td>
                                <td data-label="Finished" className="px-2.5 py-2 md:w-[20%]">
                                  <div className="flex items-center gap-2 max-md:min-w-0 max-md:flex-1">
                                    <Meter
                                      fraction={rate}
                                      fill={row.failed > 0 && rate < 0.8 ? 'bg-fb-attention' : 'bg-fb-green'}
                                    />
                                    <span
                                      className={cn(
                                        'shrink-0 text-[0.78rem] tabular-nums',
                                        row.failed > 0 ? 'text-fb-red-text' : 'text-ink-inactive',
                                      )}
                                    >
                                      {settled > 0 ? `${row.ok}/${settled}` : '—'}
                                    </span>
                                  </div>
                                </td>
                                <td data-label="Agent time" className="px-2.5 py-2 text-right text-ink-primary tabular-nums">
                                  {row.agentHours > 0 ? `${row.agentHours.toFixed(row.agentHours >= 10 ? 0 : 1)} h` : '—'}
                                </td>
                                <td data-label="Last run" className="px-2.5 py-2 text-right text-ink-secondary">
                                  {fmtWhen(row.lastRun)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Section>
              )}

              {/* --------------------------------------------------------------- by day */}
              <Section
                title="Activity by day"
                /* Three colours with nothing naming them is a puzzle every reader solves again. The same
                 * COUNTS the header's bar uses, so the two can never disagree about what failed. */
                aside={counts ? (
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {counts.filter((row) => row.key !== 'running').map((row) => (
                      <span key={row.key} className="flex items-center gap-1 text-[0.72rem] text-ink-inactive">
                        <span className={cn('size-2 rounded-full', row.fill)} />
                        {row.label}
                      </span>
                    ))}
                  </span>
                ) : undefined}
                /* The zone is named because the endpoint cuts its day boundaries in UTC, so a run at one
                 * in the morning in Kyiv lands on the previous column. Labelling the axis "days" without
                 * saying whose days is how someone comes to distrust the whole chart over one run. */
                note={`Column height is how many runs that day; green finished, red failed, grey stopped or still going. The line below is the agent time those runs took.${data.window.timeZone ? ` Days are ${data.window.timeZone} days.` : ''}`}
              >
                {byDay.length === 0 ? (
                  <Quiet>No runs fell inside this window.</Quiet>
                ) : (
                  <>
                    {/* A column narrows the whole page to that day - and to the column own UTC day
                      * rather than to local midnight, so the window holds exactly the runs the column
                      * counted. See dayWindow for why that asymmetry is the honest one. */}
                    <DayBars
                      days={byDay}
                      onPick={(day) => {
                        const only = dayWindow(day);
                        if (only) setWindow(only);
                      }}
                    />
                    <Sparkline values={byDay.map((day) => day.agentSeconds)} />
                    <div className="mt-1 flex justify-between text-[0.76rem] text-ink-inactive">
                      <span>{fmtDay(byDay[0]?.day ?? '')}</span>
                      <span>{fmtDay(byDay[byDay.length - 1]?.day ?? '')}</span>
                    </div>
                  </>
                )}
              </Section>

              {/* ----------------------------------------- how the time went, and what was done
                *
                * Both read from the per-recording digests rather than from the runs, which is why they can
                * be empty while the rest of the page is full: a window with runs but no RECORDINGS has
                * nothing to summarise, and the empty state says that rather than "no data".
                *
                * Side by side because they are one question in two halves - how the time was spent, and
                * what it was spent doing - and one under the other puts a screen between them. */}
              {(spent || doing) && (
                <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-2">
                  <Section
                    title="How the time was spent"
                    icon={<Hourglass className="size-4 text-ink-secondary" />}
                    badge={attention ? fmtSeconds(attention.measuredSeconds) : null}
                    badgeTitle="Every second inside a recording in this window. The three parts below add up to exactly this, by construction — each gap between two events falls into one of them and no other."
                    note="Measured from the gaps between events inside your recordings. Not a working day: the hours when nothing was being recorded are stored nowhere, so this is the shape of the time that WAS captured."
                  >
                    {!spent ? (
                      <Quiet>No recording in this window has been summarised yet.</Quiet>
                    ) : (
                      <>
                        <Split parts={spent} />
                        {/* The comparison, named rather than implied: a delta beside a share is unreadable
                          * until the reader knows what it is a delta against. */}
                        <Typography variant="p" className="mt-3 max-w-[70ch] text-ink-inactive text-[0.76rem]">
                          {prevAttention && prevAttention.measuredSeconds > 0
                            ? `Points are the change against the ${data.window.days === 1 ? 'day' : `${data.window.days} days`} before this window, which held ${fmtSeconds(prevAttention.measuredSeconds)} of recorded time.`
                            : 'Nothing was recorded in the window before this one, so there is nothing to compare these shares with.'}
                        </Typography>
                        {/* WHAT THESE THREE BLOCKS ARE MADE OF. Printed once, and it says it covers all
                          * three - the same sentence under each would read as three separate problems.
                          *
                          * A recording made a minute ago may not be summarised yet, and then these shares
                          * are the truth about SOME of the window. On screen that looks exactly like the
                          * truth about all of it, which is why the count is on the page and not in a log. */}
                        {data.digest?.problem ? (
                          <Typography variant="p" className="mt-1.5 max-w-[70ch] text-fb-red-text text-[0.76rem]">
                            This block and the two beside it could not be brought up to date: {data.digest.problem}
                          </Typography>
                        ) : data.digest && data.digest.stale > 0 ? (
                          <Typography variant="p" className="mt-1.5 max-w-[70ch] text-ink-inactive text-[0.76rem]">
                            {data.digest.stale} recording{data.digest.stale === 1 ? ' is' : 's are'} not
                            summarised yet, so this block, the actions beside it and the repeated processes
                            below cover the rest. Up to {data.digest.perRequest} are caught up on each visit,
                            so refreshing finishes it.
                          </Typography>
                        ) : null}
                      </>
                    )}
                  </Section>

                  {/* --------------------------------------------------------- what was done */}
                  <Section
                    title="What was actually done"
                    icon={<MousePointerClick className="size-4 text-ink-secondary" />}
                    /* No badge. Section renders one shrink-0 and deliberately so - a figure that wraps
                      * beside a heading is worse than none - and "138,310 events" is not a figure that
                      * fits beside a heading in the 236px this screen gets in the extension's panel. The
                      * total is the first thing in the body instead, where the share of it that is
                      * pointer movement can stand next to it. */
                    note="By kind, and then the individual actions by name. Typed text is never stored — a key press is recorded as which key, so this can say how often Backspace was pressed and can never say what was written."
                  >
                    {!doing ? (
                      <Quiet>No recording in this window has been summarised yet.</Quiet>
                    ) : (
                      <>
                        {/* Movement first and on its own, because it is most of the total and belongs in
                          * NEITHER list: ranked with the clicks it buries them, dropped from the total it
                          * makes the parts disagree with the whole. */}
                        <Typography variant="p" className="mb-2.5 text-ink-secondary text-[0.8rem]">
                          <strong className="font-semibold text-ink-primary tabular-nums">{fmtCount(doing.total)}</strong>{' '}
                          events, of which{' '}
                          <strong className="font-semibold text-ink-primary tabular-nums">{fmtCount(doing.moves)}</strong>{' '}
                          were the pointer moving — {pct(doing.moveShare)} of everything, and left out of both
                          lists below.
                        </Typography>

                        {doing.kinds.length === 0 ? (
                          <Quiet>Nothing but pointer movement was recorded here.</Quiet>
                        ) : (
                          <ul className="space-y-1.5">
                            {doing.kinds.map((kind) => (
                              /* Fixed label and count columns ABOVE md only, and no bar at all below it.
                                * 5.5rem + 4.5rem is 160px of unshrinkable width, and this screen is handed
                                * 236px in the extension's side panel - the width that has already put a
                                * sideways scrollbar under this dashboard once. Down there the name and the
                                * number are the whole of the information; twenty pixels of bar are not. */
                              <li key={kind.kind} className="flex items-center gap-2">
                                <span className="min-w-0 flex-1 truncate text-[0.82rem] text-ink-primary md:w-[5.5rem] md:flex-none">
                                  {kind.kind}
                                </span>
                                <span className="hidden min-w-0 flex-1 md:block">
                                  <Meter fraction={kind.of} fill="bg-brand-primary" />
                                </span>
                                <span className="shrink-0 text-right text-[0.78rem] text-ink-secondary tabular-nums md:w-[4.5rem]">
                                  {fmtCount(kind.count)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}

                        {doing.top.length > 0 && (
                          <>
                            <Typography variant="span" className="mt-3.5 block text-[0.72rem] uppercase tracking-wide text-ink-inactive">
                              the individual actions
                            </Typography>
                            <ul className="mt-1.5 space-y-1.5">
                              {doing.top.map((row) => (
                                <li key={row.action} className="flex items-center gap-2">
                                  <span className="min-w-0 flex-1 truncate text-[0.82rem] text-ink-primary" title={row.action}>
                                    {row.action}
                                  </span>
                                  <span className="hidden min-w-0 flex-1 md:block">
                                    <Meter fraction={row.of} fill="bg-fb-attention" />
                                  </span>
                                  <span className="shrink-0 text-right text-[0.78rem] text-ink-secondary tabular-nums md:w-[4.5rem]">
                                    {fmtCount(row.count)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                            {data.caps?.actions && data.caps.actions.shown >= data.caps.actions.limit && (
                              <Typography variant="p" className="mt-2.5 text-ink-inactive text-[0.76rem]">
                                The {data.caps.actions.limit} commonest, per recording. The tail on a busy
                                account is one press each.
                              </Typography>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </Section>
                </div>
              )}

              {/* ------------------------------------------- what wants a decision, next */}
              <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
                <Section
                  title="Worth automating"
                  icon={<Repeat2 className="size-4 text-brand-primary" />}
                  /* Measured, and labelled as measured. The macro this follows puts "18m/week" here, which
                   * would be a saving - and nothing stored says what these tasks cost by hand, which is why
                   * the gaps list has said so from the beginning. This is what the repeats already took. */
                  badge={repeatCost ? fmtSeconds(repeatCost) : null}
                  badgeTitle="Agent time these repeated runs already took. Not a saving — nothing here holds what the same task costs by hand."
                  note="The same task, done more than once in this window. Each of these is time you would get back by running it instead of doing it."
                >
                  {list(data.repeated).length === 0 ? (
                    <Quiet>Nothing repeated itself here. Come back after a busier week.</Quiet>
                  ) : (
                    <ul className="space-y-2.5">
                      {list(data.repeated).map((row) => (
                        <li
                          key={row.signature}
                          className="rounded-lg border-stroke border bg-surface-chips px-3 py-2.5"
                        >
                          <div className="flex items-start gap-2">
                            <Typography
                              variant="span"
                              weight="semibold"
                              className="min-w-0 flex-1 break-words text-[0.88rem]"
                            >
                              {row.label || row.signature}
                            </Typography>
                            <span className="shrink-0 rounded-full bg-brand-primary/15 px-2 py-0.5 text-[0.72rem] font-semibold text-brand-primary tabular-nums">
                              {row.times}×
                            </span>
                          </div>
                          {/* The next step in words, because a count on its own is a fact and not a
                            * suggestion - and the suggestion differs depending on whether a skill for it
                            * already exists. */}
                          <Typography variant="p" className="mt-1 text-ink-secondary text-[0.82rem]">
                            {row.flowIds.length > 0
                              ? 'This is a candidate for automation — a skill for it already exists, so run that instead of repeating it.'
                              : 'This is a candidate for automation — save it once as a skill and every repeat after that is one click.'}
                          </Typography>
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <span className="text-[0.76rem] text-ink-inactive">last {fmtWhen(row.lastAt)}</span>
                            <Button
                              variant="ghost"
                              size="xs"
                              rightSlot={<ArrowRight className="size-3" />}
                              onClick={() =>
                                void navigate({ to: row.flowIds.length > 0 ? '/skills' : '/create' })
                              }
                            >
                              {row.flowIds.length > 0 ? 'Open in Skills' : 'Make it a skill'}
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <CapNote cap={data.caps?.repeated} what="repeated tasks" />
                </Section>

                <Section
                  title="What went wrong"
                  icon={<TriangleAlert className="size-4 text-fb-red-text" />}
                  tone={list(data.failures).length > 0 ? 'attention' : 'plain'}
                  /* Runs affected, not reasons listed. Four reasons over four runs and four reasons over
                   * forty are the same list and very different weeks. */
                  badge={affected ? `${affected} affected` : null}
                  badgeTone="attention"
                  badgeTitle="How many runs these reasons account for, across every reason listed."
                  note="Grouped by reason, most frequent first. A reason that keeps coming back is usually one fix, not many."
                >
                  {list(data.failures).length === 0 ? (
                    <Quiet>Nothing failed in this window.</Quiet>
                  ) : (
                    <ul className="space-y-2.5">
                      {list(data.failures).map((row) => (
                        <li key={row.reason} className="rounded-lg border-stroke border bg-surface-chips px-3 py-2.5">
                          <div className="flex items-start gap-2">
                            <Typography
                              variant="span"
                              weight="semibold"
                              className="min-w-0 flex-1 break-words text-[0.88rem] text-fb-red-text"
                            >
                              {row.reason}
                            </Typography>
                            <span className="shrink-0 rounded-full bg-fb-red/15 px-2 py-0.5 text-[0.72rem] font-semibold text-fb-red-text tabular-nums">
                              {row.times}×
                            </span>
                          </div>
                          {row.example?.error && (
                            <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[0.74rem] text-ink-secondary">
                              {row.example.error}
                            </pre>
                          )}
                          <div className="mt-1.5 flex flex-wrap gap-x-3 text-[0.76rem] text-ink-inactive">
                            <span>last {fmtWhen(row.lastAt)}</span>
                            {row.example?.runId && <span>run {row.example.runId}</span>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <CapNote cap={data.caps?.failures} what="reasons" />
                </Section>
              </div>

              {/* --------------------------------------------- one process, done more than once
                *
                * "Worth automating" above asks this of the RUNS: a goal an agent was given twice. This asks
                * it of the RECORDINGS, which is the earlier half of the same question - work being done by
                * hand more than once, before anybody has written a skill for it. A pattern is the sequence
                * of applications a recording moved through, consecutive repeats collapsed.
                *
                * ONLY THE REPEATS ARE LISTED. A pattern seen once is a recording, not a finding, and a list
                * where one line in ten means something teaches people to skip the list. How many were seen
                * once is still said, so a short list is not read as "nothing else happened".
                *
                * WHAT IT DOES NOT CLAIM. Two recordings with the same sequence of applications are not
                * necessarily the same task - the same three applications in the same order can be two
                * different jobs - which is why this offers a candidate to look at rather than a saving to
                * count. The heading says "look alike" for that reason. */}
              {data.patterns && data.patterns.total > 0 && (
                <Section
                  title="Processes that look alike"
                  icon={<Route className="size-4 text-brand-primary" />}
                  badge={data.patterns.repeated.length ? `${data.patterns.repeated.length} repeated` : null}
                  badgeTitle="Sequences of applications that appear in more than one recording. A candidate to turn into a skill, not a measured saving."
                  note="The applications a recording moved through, in order, with runs of the same application collapsed. Two recordings sharing a sequence is the sign that a process was done by hand twice — it is not proof they were the same task."
                >
                  {data.patterns.repeated.length === 0 ? (
                    <Quiet>
                      {data.patterns.total === 1
                        ? 'One recording here, so nothing can repeat yet.'
                        : `${data.patterns.total} recordings, and no two moved through the same applications in the same order.`}
                    </Quiet>
                  ) : (
                    <>
                      <ul className="space-y-2">
                        {data.patterns.repeated.map((row) => (
                          <li
                            key={row.steps}
                            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border-stroke border bg-surface-chips px-3 py-2"
                          >
                            {/* The arrows are drawn rather than left as the endpoint own "->", so the
                              * sequence reads as a path and wraps at a step instead of mid-arrow. */}
                            {/* A MINIMUM WIDTH, and it is what makes the wrap work at all. `flex-1` is
                              * `flex: 1 1 0%`, so the path shrinks to nothing before the row ever runs out
                              * of space and the unshrinkable count beside it simply hangs over the edge.
                              * With a floor on the path, the count is what wraps - onto its own line, which
                              * is the readable answer in a narrow panel. */}
                            <span className="flex min-w-[9rem] flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
                              {row.steps.split('->').map((step, i) => (
                                <span key={`${row.steps}:${i}`} className="flex items-center gap-1.5">
                                  {i > 0 && <ArrowRight className="size-3 shrink-0 text-ink-inactive" />}
                                  <span className="text-[0.85rem] text-ink-primary">{step.trim()}</span>
                                </span>
                              ))}
                            </span>
                            <span className="shrink-0 rounded-full bg-brand-primary/15 px-2 py-0.5 text-[0.72rem] font-semibold text-brand-primary tabular-nums">
                              {row.recordings} recordings
                            </span>
                          </li>
                        ))}
                      </ul>
                      <Typography variant="p" className="mt-2.5 max-w-[74ch] text-ink-inactive text-[0.76rem]">
                        {data.patterns.once > 0
                          ? `${data.patterns.once} other ${data.patterns.once === 1 ? 'sequence appeared' : 'sequences appeared'} once each and are left out.`
                          : 'Every sequence in this window appeared more than once.'}
                        {data.caps?.patterns
                          ? ` A sequence is cut to ${data.caps.patterns.steps} steps, so two long processes that begin alike are counted as one.`
                          : ''}
                      </Typography>
                      <CapNote cap={data.caps?.patterns} what="repeated sequences" />
                    </>
                  )}
                </Section>
              )}

              {/* Two halves of one question, side by side: where the time went, and what was slow while
                * it went. One under the other puts a screen and a half between them, and comparing them is
                * the whole point. Each keeps its own horizontal scroller, so a table in half the width
                * scrolls itself rather than the page. */}
              {/* The single column is stated, and that is not decoration: a grid with no `grid-cols` has
                * one IMPLICIT `auto` track, and `auto` cannot go below its content's min-content width. The
                * card below holds a 560px table, so the track became 560px and took the page with it.
                * `minmax(0,1fr)` is what lets that table scroll inside its own card instead. */}
              <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-2">
                {/* ------------------------------------------------------------ where the time went */}
                <Section
                  title="Where the time went"
                  icon={<AppWindow className="size-4 text-ink-secondary" />}
                  note="By application or site, across recordings and runs together. The bar is the share of the window's time."
                >
                  {list(data.applications).length === 0 && !(data.unattributed && data.unattributed.seconds > 0) ? (
                    <Quiet>Nothing in this window said which application it was in.</Quiet>
                  ) : (
                    <>
                    <div className="overflow-x-auto">
                      <table className={cn('w-full border-collapse text-[0.85rem] md:min-w-[520px]', CARD_ROWS_BELOW_MD)}>
                        <thead>
                          <tr className="bg-table-header-bg text-ink-secondary">
                            <th className="rounded-l-md px-2.5 py-2 text-left font-medium">Where</th>
                            <th className="px-2.5 py-2 text-right font-medium">Recordings</th>
                            <th className="px-2.5 py-2 text-right font-medium">Runs</th>
                            <th className="px-2.5 py-2 text-right font-medium">Time</th>
                            <th className="rounded-r-md px-2.5 py-2 text-left font-medium">Share</th>
                          </tr>
                        </thead>
                        <tbody>
                          {list(data.applications).map((row) => (
                            <tr key={`${row.kind}:${row.name}`} className="border-stroke border-b last:border-0">
                              <td className="px-2.5 py-2">
                                <span className="text-ink-primary">{row.name}</span>
                                <span className="ms-2 rounded-full bg-state-hover px-1.5 py-0.5 text-[0.7rem] text-ink-secondary">
                                  {row.kind}
                                </span>
                              </td>
                              <td data-label="Recordings" className="px-2.5 py-2 text-right text-ink-secondary tabular-nums">
                                {row.recordings}
                              </td>
                              <td data-label="Runs" className="px-2.5 py-2 text-right text-ink-secondary tabular-nums">{row.runs}</td>
                              <td data-label="Time" className="px-2.5 py-2 text-right text-ink-primary tabular-nums">
                                {fmtSeconds(row.seconds)}
                              </td>
                              <td data-label="Share" className="px-2.5 py-2 md:w-[26%]">
                                <div className="flex items-center gap-2 max-md:min-w-0 max-md:flex-1">
                                  <Meter fraction={asFraction(row.share)} fill="bg-brand-primary" />
                                  <span className="shrink-0 text-[0.78rem] text-ink-inactive tabular-nums">
                                    {pct(asFraction(row.share))}
                                  </span>
                                </div>
                              </td>
                            </tr>
                          ))}

                          {/* The endpoint's own bucket, printed as a row rather than dropped. Without it
                            * the Share column adds up to less than everything with no explanation on the
                            * page for the difference, and a reader's only way to account for it is to
                            * assume one of the rows above is wrong. */}
                          {data.unattributed && data.unattributed.seconds > 0 && (
                            <tr className="border-stroke border-b last:border-0">
                              <td className="px-2.5 py-2">
                                <span className="text-ink-secondary">Could not be placed</span>
                              </td>
                              <td data-label="Recordings" className="px-2.5 py-2 text-right text-ink-inactive tabular-nums">—</td>
                              <td data-label="Runs" className="px-2.5 py-2 text-right text-ink-inactive tabular-nums">—</td>
                              <td data-label="Time" className="px-2.5 py-2 text-right text-ink-secondary tabular-nums">
                                {fmtSeconds(data.unattributed.seconds)}
                              </td>
                              <td data-label="Share" className="px-2.5 py-2 md:w-[26%]">
                                <div className="flex items-center gap-2 max-md:min-w-0 max-md:flex-1">
                                  <Meter fraction={asFraction(data.unattributed.share)} fill="bg-ink-inactive/45" />
                                  <span className="shrink-0 text-[0.78rem] text-ink-inactive tabular-nums">
                                    {pct(asFraction(data.unattributed.share))}
                                  </span>
                                </div>
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    {data.unattributed && data.unattributed.seconds > 0 && (
                      <Typography variant="p" className="mt-2 max-w-[74ch] text-ink-inactive text-[0.76rem]">
                        {data.unattributed.why}
                      </Typography>
                    )}
                    <CapNote cap={data.caps?.applications} what="applications and sites" />
                    </>
                  )}
                </Section>

                {/* ------------------------------------------------------------- slowest steps */}
                <Section
                  title="The slowest steps"
                  icon={<Clock className="size-4 text-ink-secondary" />}
                  note="Per tool: the typical call and the slow tail. Only runs that recorded per-step timing can appear here — a desktop run's steps carry no clock, so its tools are absent rather than counted as instant."
                >
                  {list(data.slowestSteps).length === 0 ? (
                    <Quiet>No run in this window recorded per-step timing.</Quiet>
                  ) : (
                    (() => {
                      const worst = Math.max(1, ...list(data.slowestSteps).map((step) => step.p90Ms));
                      return (
                        <ul className="space-y-2.5">
                          {list(data.slowestSteps).map((step) => (
                            <li key={step.tool}>
                              <div className="flex items-baseline gap-2">
                                <span className="min-w-0 flex-1 truncate font-mono text-[0.82rem] text-ink-primary">
                                  {step.tool}
                                </span>
                                <span className="text-[0.78rem] text-ink-secondary tabular-nums">
                                  {fmtMs(step.medianMs)} typical
                                </span>
                                <span className="text-[0.78rem] text-ink-inactive tabular-nums">
                                  {fmtMs(step.p90Ms)} at worst
                                </span>
                                <span className="text-[0.76rem] text-ink-inactive tabular-nums">
                                  {step.calls} call{step.calls === 1 ? '' : 's'}
                                </span>
                              </div>
                              {/* Two marks on one track: the solid part is the typical call, the faint part
                                * how much further the slow tail reaches. A tool whose tail dwarfs its median
                                * is unreliable rather than slow, and that reads off the shape. */}
                              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-state-hover">
                                <div
                                  className="h-full rounded-full bg-fb-attention/35"
                                  style={{ width: pct(Math.min(1, step.p90Ms / worst)) }}
                                >
                                  <div
                                    className="h-full rounded-full bg-brand-primary"
                                    style={{
                                      width: step.p90Ms > 0 ? pct(Math.min(1, step.medianMs / step.p90Ms)) : '0%',
                                    }}
                                  />
                                </div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      );
                    })()
                  )}
                  <CapNote cap={data.caps?.slowestSteps} what="tools" />
                </Section>
              </div>

              {/* -------------------------------------------------------------- per skill */}
              <Section
                title="How each skill is doing"
                icon={<Sparkles className="size-4 text-ink-secondary" />}
                note="Only runs that recorded which flow they ran can appear here. That link was not written for older runs, so this list reaches back less far than the rest of the page."
              >
                {list(data.skills).length === 0 ? (
                  <Quiet>
                    No run in this window said which skill it was running. Newer runs record it, so this fills
                    in from here on.
                  </Quiet>
                ) : (
                  <div className="overflow-x-auto">
                    <table className={cn('w-full border-collapse text-[0.85rem] md:min-w-[560px]', CARD_ROWS_BELOW_MD)}>
                      <thead>
                        <tr className="bg-table-header-bg text-ink-secondary">
                          <th className="rounded-l-md px-2.5 py-2 text-left font-medium">Skill</th>
                          {teamShown && !personShown && (
                            <th className="px-2.5 py-2 text-left font-medium">Whose</th>
                          )}
                          <th className="px-2.5 py-2 text-right font-medium">Runs</th>
                          <th className="px-2.5 py-2 text-left font-medium">Finished</th>
                          <th className="px-2.5 py-2 text-right font-medium">Typical</th>
                          <th className="rounded-r-md px-2.5 py-2 text-right font-medium">Last run</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list(data.skills).map((row) => {
                          const settled = row.ok + row.failed;
                          const rate = settled > 0 ? row.ok / settled : 0;
                          return (
                            /* Keyed by owner AND id on the team view: two people can each have a skill
                             * with the same client id, and React would render one of them. */
                            <tr key={`${row.ownerId ?? ''}:${row.flowId}`} className="border-stroke border-b last:border-0">
                              <td className="px-2.5 py-2">
                                <span className="text-ink-primary">{row.name || 'Untitled'}</span>
                                <span className="ms-2 rounded-full bg-state-hover px-1.5 py-0.5 text-[0.7rem] text-ink-secondary">
                                  {row.kind}
                                </span>
                              </td>
                              {teamShown && !personShown && (
                                <td data-label="Whose" className="px-2.5 py-2 text-ink-secondary">
                                  {whose(row.ownerId, people)}
                                </td>
                              )}
                              <td data-label="Runs" className="px-2.5 py-2 text-right text-ink-secondary tabular-nums">{row.runs}</td>
                              <td data-label="Finished" className="px-2.5 py-2 md:w-[24%]">
                                <div className="flex items-center gap-2 max-md:min-w-0 max-md:flex-1">
                                  <Meter
                                    fraction={rate}
                                    fill={row.failed > 0 && rate < 0.8 ? 'bg-fb-attention' : 'bg-fb-green'}
                                  />
                                  <span
                                    className={cn(
                                      'shrink-0 text-[0.78rem] tabular-nums',
                                      row.failed > 0 ? 'text-fb-red-text' : 'text-ink-inactive',
                                    )}
                                  >
                                    {settled > 0 ? `${row.ok}/${settled}` : '—'}
                                  </span>
                                </div>
                              </td>
                              <td data-label="Typical" className="px-2.5 py-2 text-right text-ink-primary tabular-nums">
                                {fmtSeconds(row.medianSeconds)}
                              </td>
                              <td data-label="Last run" className="px-2.5 py-2 text-right text-ink-secondary">
                                {fmtWhen(row.lastRunAt)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <CapNote cap={data.caps?.skills} what="skills" />
              </Section>

              {/* The gaps used to be printed here, at the bottom of every dashboard, unasked for - and they
                * read as a disclaimer rather than as what they are, which is answers. They are still in the
                * endpoint's response and the assistant reads them, so "why does this not tell me what I
                * saved" gets those exact words at the moment somebody asks it. That is where an answer
                * belongs. */}
            </>
          )}
        </div>
      )}
      </div>

      {/* The assistant reads the same account this page does, so what it answers about is what is on screen.
        * Rendered inside the page rather than as its own destination: a separate screen would make somebody
        * retype the window and the numbers they are looking at. */}
      {assistant === 'open' && wide && (
        <aside
          className="relative flex shrink-0 flex-col border-stroke border-l bg-surface-card2 max-xl:hidden"
          style={{ width: panelWidth }}
        >
          {/* The handle. Its own hit area is wider than the line it draws, because a 1px target is a target
              nobody hits. Double-click restores the default, which is the way back from a bad drag. */}
          <div
            role="separator"
            aria-label="Resize the assistant"
            aria-orientation="vertical"
            onPointerDown={drag}
            onDoubleClick={() => {
              setPanelWidth(WIDTH_DEFAULT);
              try { localStorage.setItem(ASSISTANT_WIDTH_KEY, String(WIDTH_DEFAULT)); } catch (_) { /* private mode */ }
            }}
            className={cn(
              'absolute top-0 -left-1 z-10 h-full w-2 cursor-col-resize',
              'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent',
              'hover:after:bg-brand-primary',
            )}
          />
          <ChatView
            /* Remounted when the scope changes, which starts a fresh thread. One conversation holding
             * answers about your own account and then about a whole team is a transcript whose numbers
             * cannot be placed later, by the reader or by the model reading its own history back. */
            key={`${teamShown?.team?.id ?? 'mine'}:${personShown?.id ?? 'all'}`}
            embedded
            opening={opening}
            team={teamShown?.team ?? null}
            person={personShown}
            onMinimize={() => setAssistant('min')}
            onClose={() => setAssistant('closed')}
          />
        </aside>
      )}

      {/* Minimised: a rail, so it is still on screen and one click wide. */}
      {assistant === 'min' && wide && (
        <button
          type="button"
          onClick={() => setAssistant('open')}
          title="Open the assistant"
          className={cn(
            'flex w-10 shrink-0 flex-col items-center gap-3 border-stroke border-l bg-surface-card2 py-3',
            'text-ink-inactive hover:text-ink-primary',
          )}
        >
          <MessageSquareText className="size-4 shrink-0" />
          <span className="text-[0.72rem] tracking-wide [writing-mode:vertical-rl]">Ask about this</span>
        </button>
      )}

      {/* Narrow: the same panel, over the page, because 26rem beside a dashboard leaves neither readable. */}
      {assistant === 'open' && !wide && (
        <div className="fixed inset-0 z-40 flex flex-col bg-surface-page">
          {/* No title bar of its own any more: the panel's header names itself and carries a close button,
            * and two rows of chrome saying the same thing was the overlay repeating the panel. No minimise
            * here — there is no rail to minimise into at this width. */}
          <ChatView
            key={`${teamShown?.team?.id ?? 'mine'}:${personShown?.id ?? 'all'}`}
            embedded
            opening={opening}
            team={teamShown?.team ?? null}
            person={personShown}
            onClose={() => setAssistant('closed')}
          />
        </div>
      )}
    </div>
  );
};
