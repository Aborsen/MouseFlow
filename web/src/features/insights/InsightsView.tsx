/* Insights: what was actually done on this account, and where the time went.
 *
 * This page is scanned rather than read, so it is built in that order - the shape of the window first (how
 * many runs, how they ended, how long they took), then the things that want a decision (a failure that keeps
 * repeating, a task done fourteen times by hand), then the flat tables. Anything asking for attention is
 * given a shape as well as a number: a bar you can compare without reading it, a colour that means the same
 * thing everywhere on the page.
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
  CircleDashed,
  Clock,
  Film,
  RefreshCw,
  Repeat2,
  Sparkles,
  Timer,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';

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
  example: { runId: string; error: string } | null;
}

interface SkillRow {
  flowId: string;
  name: string;
  kind: string;
  runs: number;
  ok: number;
  failed: number;
  medianSeconds: number;
  lastRunAt: string | null;
}

interface GapRow {
  question: string;
  why: string;
}

interface Insights {
  ok: true;
  window: { days: number; from: string; to: string };
  totals: Totals;
  /* The endpoint sends this as well as the per-outcome fields on `totals`, and the two should agree. Only
   * `totals` has a documented field per outcome, so that is what a key missing here falls back to. */
  byOutcome: Record<string, number>;
  byDay: DayRow[];
  applications: AppRow[];
  repeated: RepeatedRow[];
  slowestSteps: StepRow[];
  failures: FailureRow[];
  skills: SkillRow[];
  gaps: GapRow[];
}

/* Arrays are read through this rather than trusted, because a section that renders as nothing is a far
 * better failure than a whole page replaced by a React crash when one key is absent. */
const list = <T,>(value: T[] | undefined | null): T[] => (Array.isArray(value) ? value : []);

async function fetchInsights(days: number, signal: AbortSignal): Promise<Insights> {
  const res = await fetch(`/api/insights?days=${days}`, { credentials: 'same-origin', signal });
  const body = (await res.json().catch(() => null)) as (Insights & { error?: { message?: string } }) | null;
  /* The endpoint's own words, not a status code dressed up as prose: it knows why it refused and this page
   * does not. Only when it says nothing at all does the status stand in. */
  if (!res.ok || !body) throw new Error(body?.error?.message ?? `the server answered ${res.status}`);
  return body;
}

/* -------------------------------------------------------------------------- formatting */

/** 7m 42s, not 462. Nobody divides by sixty in their head while scanning a table. */
const fmtSeconds = (total: number): string => {
  if (!Number.isFinite(total) || total <= 0) return '—';
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

const Tile = ({
  icon,
  value,
  label,
  note,
}: {
  icon: ReactNode;
  value: string;
  label: string;
  note?: string;
}) => (
  <div className="rounded-lg border-stroke border bg-surface-chips px-3 py-2.5">
    <div className="mb-0.5 flex items-center gap-1.5 text-ink-inactive">
      {icon}
      <span className="text-[0.76rem] uppercase tracking-wide">{label}</span>
    </div>
    <strong className="block font-semibold text-[1.5rem] text-ink-primary tabular-nums leading-tight tracking-tight">
      {value}
    </strong>
    {note && <span className="text-[0.76rem] text-ink-inactive">{note}</span>}
  </div>
);

const Section = ({
  title,
  icon,
  note,
  children,
  tone = 'plain',
}: {
  title: string;
  icon?: ReactNode;
  note?: string;
  children: ReactNode;
  tone?: 'plain' | 'attention';
}) => (
  <section
    className={cn(
      'rounded-xl border bg-surface-card p-4',
      tone === 'attention' ? 'border-fb-red/30' : 'border-stroke',
    )}
  >
    <div className="mb-2 flex items-center gap-1.5">
      {icon}
      <Typography variant="h3" weight="semibold" className="text-[0.95rem]">
        {title}
      </Typography>
    </div>
    {note && (
      <Typography variant="p" className="mb-2.5 max-w-[70ch] text-ink-inactive text-[0.8rem]">
        {note}
      </Typography>
    )}
    {children}
  </section>
);

const Quiet = ({ children }: { children: ReactNode }) => (
  <Typography variant="p" className="text-ink-inactive text-[0.84rem]">
    {children}
  </Typography>
);

/* One column per day, stacked so the column's height is the run count and its colours are the outcomes.
 * The grey segment is runs minus finished minus failed - stopped, or still going. It is drawn rather than
 * dropped, because a column shorter than its own label would be a lie about how much ran that day. */
const DayBars = ({ days }: { days: DayRow[] }) => {
  const tallest = Math.max(1, ...days.map((d) => d.runs));
  return (
    <div className="flex h-24 items-end gap-px" role="img" aria-label="runs per day">
      {days.map((day) => {
        const other = Math.max(0, day.runs - day.ok - day.failed);
        const height = (day.runs / tallest) * 100;
        return (
          <div
            key={day.day}
            className="flex min-w-[2px] flex-1 flex-col justify-end"
            style={{ height: '100%' }}
            title={`${fmtDay(day.day)} — ${day.runs} run${day.runs === 1 ? '' : 's'}, ${day.ok} finished, ${day.failed} failed, ${fmtSeconds(day.agentSeconds)} of agent time`}
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
          </div>
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

/* --------------------------------------------------------------------------- the page */

const RANGES = [7, 30, 90];

export const InsightsView = () => {
  const navigate = useNavigate();
  const [days, setDays] = useState(30);
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
        const body = await fetchInsights(days, stop.signal);
        setData(body);
      } catch (err) {
        if (stop.signal.aborted) return; // a range switch, not a failure
        setProblem(err instanceof Error ? err.message : 'the insights could not be read');
      } finally {
        if (!stop.signal.aborted) setBusy(false);
      }
    })();
    return () => stop.abort();
  }, [days, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const totals = data?.totals;
  const counts = useMemo(() => {
    if (!totals) return null;
    return OUTCOMES.map((outcome) => ({
      ...outcome,
      count: data?.byOutcome?.[outcome.key] ?? totals[outcome.key],
    })).filter((row) => Number.isFinite(row.count));
  }, [data, totals]);

  const runs = totals?.runs ?? 0;
  const byDay = list(data?.byDay);
  const nothingYet = !!totals && runs === 0 && totals.recordings === 0 && totals.createdSkills === 0;

  return (
    <div className="p-5">
      <header className="mb-4 flex max-w-[1100px] flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <Typography variant="h2" weight="semibold" className="text-[1.05rem]">
            What happened, and where the time went
          </Typography>
          <Typography variant="p" className="mt-0.5 max-w-[72ch] text-ink-inactive text-[0.85rem]">
            Read from your own recordings and runs.{' '}
            {data
              ? `${new Date(data.window.from).toLocaleDateString()} to ${new Date(data.window.to).toLocaleDateString()}.`
              : 'Nothing here leaves your account.'}
          </Typography>
        </div>

        {/* The range is a control, not a filter to be found in a menu: it is the first thing anyone changes. */}
        <div className="flex items-center gap-1 rounded-lg border-stroke border bg-surface-card p-1">
          {RANGES.map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => setDays(range)}
              aria-pressed={days === range}
              className={cn(
                'rounded-md px-2.5 py-1 text-[0.82rem] font-medium transition-colors duration-fast',
                days === range
                  ? 'bg-brand-primary text-content-on-solid'
                  : 'text-ink-secondary hover:bg-state-hover',
              )}
            >
              {range} days
            </button>
          ))}
        </div>

        <Button variant="ghost" size="sm" leftSlot={<RefreshCw className="size-4" />} isLoading={busy} onClick={reload}>
          Refresh
        </Button>
      </header>

      {/* A real failure, in the endpoint's own words. It knows what went wrong; repeating "something went
        * wrong" here would throw away the only useful thing on the screen. */}
      {problem && (
        <section className="mb-4 max-w-[1100px] rounded-xl border-fb-red/40 border bg-surface-card p-4">
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
        <div className={cn('max-w-[1100px] space-y-4', busy && 'opacity-60 transition-opacity duration-base')}>
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
                <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                  <Tile
                    icon={<Timer className="size-3.5" />}
                    label="runs"
                    value={String(runs)}
                    note={`${totals?.ok ?? 0} finished, ${totals?.failed ?? 0} failed`}
                  />
                  <Tile
                    icon={<Clock className="size-3.5" />}
                    label="agent time"
                    value={fmtSeconds((totals?.agentHours ?? 0) * 3600)}
                    note="wall clock, start of a run to its finish"
                  />
                  <Tile
                    icon={<Film className="size-3.5" />}
                    label="recordings"
                    value={String(totals?.recordings ?? 0)}
                    note="tasks captured as you did them"
                  />
                  <Tile
                    icon={<Sparkles className="size-3.5" />}
                    label="skills made"
                    value={String(totals?.createdSkills ?? 0)}
                    note="from a recording or a described goal"
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

              {/* --------------------------------------------------------------- by day */}
              <Section
                title="Day by day"
                note="Column height is how many runs that day; green finished, red failed, grey stopped or still going. The line below is the agent time those runs took."
              >
                {byDay.length === 0 ? (
                  <Quiet>No runs fell inside this window.</Quiet>
                ) : (
                  <>
                    <DayBars days={byDay} />
                    <Sparkline values={byDay.map((day) => day.agentSeconds)} />
                    <div className="mt-1 flex justify-between text-[0.76rem] text-ink-inactive">
                      <span>{fmtDay(byDay[0]?.day ?? '')}</span>
                      <span>{fmtDay(byDay[byDay.length - 1]?.day ?? '')}</span>
                    </div>
                  </>
                )}
              </Section>

              {/* ------------------------------------------- what wants a decision, next */}
              <div className="grid gap-4 lg:grid-cols-2">
                <Section
                  title="Worth automating"
                  icon={<Repeat2 className="size-4 text-brand-primary" />}
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
                </Section>

                <Section
                  title="What went wrong"
                  icon={<TriangleAlert className="size-4 text-fb-red-text" />}
                  tone={list(data.failures).length > 0 ? 'attention' : 'plain'}
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
                </Section>
              </div>

              {/* ------------------------------------------------------------ where the time went */}
              <Section
                title="Where the time went"
                icon={<AppWindow className="size-4 text-ink-secondary" />}
                note="By application or site, across recordings and runs together. The bar is the share of the window's time."
              >
                {list(data.applications).length === 0 ? (
                  <Quiet>Nothing in this window said which application it was in.</Quiet>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] border-collapse text-[0.85rem]">
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
                            <td className="px-2.5 py-2 text-right text-ink-secondary tabular-nums">
                              {row.recordings}
                            </td>
                            <td className="px-2.5 py-2 text-right text-ink-secondary tabular-nums">{row.runs}</td>
                            <td className="px-2.5 py-2 text-right text-ink-primary tabular-nums">
                              {fmtSeconds(row.seconds)}
                            </td>
                            <td className="w-[26%] px-2.5 py-2">
                              <div className="flex items-center gap-2">
                                <Meter fraction={asFraction(row.share)} fill="bg-brand-primary" />
                                <span className="shrink-0 text-[0.78rem] text-ink-inactive tabular-nums">
                                  {pct(asFraction(row.share))}
                                </span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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
              </Section>

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
                    <table className="w-full min-w-[560px] border-collapse text-[0.85rem]">
                      <thead>
                        <tr className="bg-table-header-bg text-ink-secondary">
                          <th className="rounded-l-md px-2.5 py-2 text-left font-medium">Skill</th>
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
                            <tr key={row.flowId} className="border-stroke border-b last:border-0">
                              <td className="px-2.5 py-2">
                                <span className="text-ink-primary">{row.name || 'Untitled'}</span>
                                <span className="ms-2 rounded-full bg-state-hover px-1.5 py-0.5 text-[0.7rem] text-ink-secondary">
                                  {row.kind}
                                </span>
                              </td>
                              <td className="px-2.5 py-2 text-right text-ink-secondary tabular-nums">{row.runs}</td>
                              <td className="w-[24%] px-2.5 py-2">
                                <div className="flex items-center gap-2">
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
                              <td className="px-2.5 py-2 text-right text-ink-primary tabular-nums">
                                {fmtSeconds(row.medianSeconds)}
                              </td>
                              <td className="px-2.5 py-2 text-right text-ink-secondary">
                                {fmtWhen(row.lastRunAt)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>

              {/* --------------------------------------------------------------- the gaps
                *
                * Quiet on purpose. These are not errors and they are not warnings: they are questions the
                * stored data genuinely cannot answer, printed so that nobody has to wonder whether the
                * absence of an answer means zero. A guessed number here would be believed. */}
              {list(data.gaps).length > 0 && (
                <section className="rounded-xl border-stroke border bg-surface-chips p-4">
                  <div className="mb-1 flex items-center gap-1.5">
                    <CircleDashed className="size-4 text-ink-inactive" />
                    <Typography variant="h3" weight="semibold" className="text-[0.9rem] text-ink-secondary">
                      What this page cannot tell you yet
                    </Typography>
                  </div>
                  <Typography variant="p" className="mb-3 max-w-[74ch] text-ink-inactive text-[0.8rem]">
                    Every number above is read from something that was recorded. These questions are not —
                    answering them would need data nothing has written yet, so they are listed rather than
                    estimated.
                  </Typography>
                  <dl className="space-y-2.5">
                    {list(data.gaps).map((gap) => (
                      <div key={gap.question}>
                        <dt className="text-[0.85rem] text-ink-body">{gap.question}</dt>
                        <dd className="text-[0.8rem] text-ink-inactive">{gap.why}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
