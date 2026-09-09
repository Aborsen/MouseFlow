/* Activity: что машина делает сейчас, что она собирается сделать, и что она сделала - с кнопкой там, где вещь.
 *
 * ЗАЧЕМ СТРАНИЦА. Прогон по расписанию шёл всю ночь, каждые четверть часа, и вопрос «как это отменить»
 * упирался в то, что ответ был рассыпан по трём местам: одноразовое расписание лежало на Skills в полосе
 * «Runs by itself», ждущая работа была видна только тулу mouseflow_status, а история - только в панели справа
 * на Create, и только пока открыта Create. Ни одно из трёх не отвечало на вопрос целиком, и ни в одном не
 * было кнопки у той вещи, о которой спрашивали.
 *
 * ТРИ СЕКЦИИ, И КАЖДАЯ ЧЕСТНО СКЛАДЫВАЕТСЯ. «Running now» - одна карточка или одна строка «ничего не идёт».
 * «Waiting» - очередь и ближайшие расписания, и её нет вовсе, когда ждать нечего. «History» - всё, что было,
 * включая то, что прогоном НЕ стало: отменённое до запуска и упавшее на заборе живёт только в очереди, и
 * человек, спрашивающий «что стало с моей просьбой из чата», обязан увидеть и это.
 *
 * СЛОВА - ИЗ ОДНОГО СЛОВАРЯ (status.ts), и два вопроса никогда не делят один чип: «довёл ли агент» и «прошёл
 * ли продукт». У прогона может стоять «ok» и рядом «1 check failed» - это найденный дефект, а не путаница.
 */
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, Clock, Pause, Search, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { Said } from '@/components/Said';
import { StepLine } from '@/components/chat';
import {
  type LiveJob, type Run, type Schedule, cancelJob, liveJobs, schedulePause, scheduleRemove, schedules,
} from '@/lib/api';
import { refreshLive, useLive } from '@/lib/live';
import { useAgent } from '@/lib/store';
import { useAccount } from '@/shell/AccountProvider';
import { Page } from '@/shell/Surface';
import { asDid, describe } from '@/features/create/describe';
import { evidenceOf, verdictKind } from '@/features/create/verdict';
import { Frames } from '@/features/create/Frames';
import { stepsOf, titleOf, took, when, wordsOf } from '@/features/create/run-history';
import { chipClass, dotClass, jobChip, runChips, runTone, scheduleChip, sourceOf } from './status';

const LABEL = 'text-[0.7rem] uppercase tracking-wide text-ink-inactive';

/* Сколько суток очереди подмешивается в историю. Столько же, сколько живут кадры (ARTIFACT_KEEP_DAYS): дальше
 * назад разбирать всё равно нечем. */
const HISTORY_DAYS = 30;

type Filter = 'all' | 'done' | 'failed' | 'stopped' | 'checks' | 'itself';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
  { id: 'stopped', label: 'Stopped' },
  { id: 'checks', label: 'With checks' },
  { id: 'itself', label: 'By itself' },
];

const Chip = ({ label, tone }: { label: string; tone: Parameters<typeof chipClass>[0] }) => (
  <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[0.72rem] font-semibold whitespace-nowrap', chipClass(tone))}>
    {label}
  </span>
);

/** Одна строка истории - прогон из журнала, или работа из очереди, которая прогоном не стала. */
type Entry =
  | { kind: 'run'; id: string; at: string | null; run: Run; job: LiveJob | null }
  | { kind: 'job'; id: string; at: string | null; job: LiveJob };

export const ActivityView = () => {
  const { runs, reload } = useAccount();
  const { health } = useAgent();
  const live = useLive();
  const navigate = useNavigate();

  const [upcoming, setUpcoming] = useState<Schedule[]>([]);
  const [queueHistory, setQueueHistory] = useState<LiveJob[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; kind: 'good' | 'bad' } | null>(null);

  /* Расписания и история очереди - один раз при открытии и после каждого действия здесь. Не по таймеру: они
   * меняются от рук, а руки здесь; живое - идущее и ждущее - крутит общий опрос (useLive). */
  const loadStill = useCallback(async () => {
    const [sch, hist] = await Promise.all([
      schedules().catch(() => null),
      liveJobs(HISTORY_DAYS).catch(() => null),
    ]);
    if (sch) setUpcoming(sch.schedules.filter((one) => !one.paused && one.nextAt));
    if (hist) setQueueHistory(hist.jobs);
  }, []);
  useEffect(() => { void loadStill(); }, [loadStill]);

  const running = useMemo(() => live.filter((job) => job.state === 'claimed'), [live]);
  const queued = useMemo(() => live.filter((job) => job.state === 'queued'), [live]);

  /* ИСТОРИЯ - журнал плюс очередь, без дублей. Работа, которая стала прогоном, есть в журнале под тем же id
   * (user_run.client_id = run_queue.id), и строка очереди у неё - только источник. Работа, которая прогоном
   * не стала, стоит сама за себя. */
  const entries = useMemo<Entry[]>(() => {
    const byId = new Map(queueHistory.map((job) => [job.id, job]));
    const list: Entry[] = runs
      .filter((run) => run.kind === 'agent')
      .map((run) => ({ kind: 'run', id: run.id, at: run.startedAt, run, job: byId.get(run.id) ?? null }));
    const seen = new Set(runs.map((run) => run.id));
    for (const job of queueHistory) {
      if (seen.has(job.id)) continue;
      if (job.state === 'queued' || job.state === 'claimed') continue; // они выше, живьём
      list.push({ kind: 'job', id: job.id, at: job.finishedAt ?? job.startedAt, job });
    }
    return list.sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0));
  }, [runs, queueHistory]);

  const counts = useMemo(() => {
    const n = { all: entries.length, done: 0, failed: 0, stopped: 0, checks: 0, itself: 0 };
    for (const e of entries) {
      if (e.kind === 'job') { n.failed += e.job.state === 'failed' ? 1 : 0; n.itself++; continue; }
      if (e.run.outcome === 'ok') n.done++;
      if (e.run.outcome === 'failed') n.failed++;
      if (e.run.outcome === 'stopped') n.stopped++;
      if (e.run.checks) n.checks++;
      if (sourceOf(e.run, e.job) !== 'you') n.itself++;
    }
    return n;
  }, [entries]);

  const shown = useMemo(() => entries.filter((e) => {
    const text = (e.kind === 'run' ? `${e.run.name ?? ''} ${e.run.goal ?? ''}` : `${e.job.goal ?? ''} ${e.job.name}`).toLowerCase();
    if (term.trim() && !text.includes(term.trim().toLowerCase())) return false;
    if (filter === 'all') return true;
    if (e.kind === 'job') return filter === 'failed' ? e.job.state === 'failed' : filter === 'itself';
    if (filter === 'done') return e.run.outcome === 'ok';
    if (filter === 'failed') return e.run.outcome === 'failed';
    if (filter === 'stopped') return e.run.outcome === 'stopped';
    if (filter === 'checks') return !!e.run.checks;
    return sourceOf(e.run, e.job) !== 'you';
  }), [entries, filter, term]);

  const act = async (key: string, what: () => Promise<{ said?: string } | unknown>, fallback: string) => {
    setBusy(key);
    try {
      const out = await what();
      const text = out && typeof out === 'object' && 'said' in out && typeof out.said === 'string' ? out.said : fallback;
      setSaid({ text, kind: 'good' });
      await Promise.all([refreshLive(), loadStill(), reload()]);
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : 'that did not work', kind: 'bad' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page>
      <header className="mb-5 flex flex-wrap items-start gap-5">
        <div className="min-w-0 flex-1 basis-full sm:min-w-[22rem] sm:basis-auto">
          <Typography variant="span" className={cn(LABEL, 'block')}>Activity</Typography>
          <Typography variant="h2" weight="semibold" className="mt-1 text-[1.7rem] leading-tight tracking-tight">
            What your machine is doing
          </Typography>
          <Typography variant="p" className="mt-1.5 max-w-[74ch] text-ink-inactive text-[0.86rem] leading-relaxed">
            Everything that runs on your computer — started by you, by a schedule, or from a chat — with the
            one thing each of them can have done to it: stop what is running, cancel what is waiting, read
            what happened.
          </Typography>
        </div>
        {/* Машина, как её видит страница: та же плашка, что в шапке Create. Без неё «ничего не идёт» читается
          * двояко - нечего делать или некому. */}
        <div className="flex shrink-0 items-center gap-2 rounded-full border-stroke border bg-surface-card px-3 py-1.5 text-[0.78rem] text-ink-secondary">
          <span className={cn('size-1.5 rounded-full', health ? 'bg-fb-green' : 'bg-ink-inactive')} />
          {health ? `Agent ${health.version}` : 'No agent on this computer'}
        </div>
      </header>

      <Said note={said} onDismiss={() => setSaid(null)} className="mb-4 max-w-[86ch]" />

      {/* ------------------------------------------------------------------ RUNNING NOW */}
      <section className="mb-4 rounded-xl border-stroke border bg-surface-card p-4">
        <div className="flex items-center gap-2.5">
          <span className={cn('size-2 rounded-full', running.length ? 'bg-fb-attention shadow-[0_0_0_4px_rgba(255,105,0,.18)]' : 'bg-ink-inactive')} />
          <Typography variant="span" className={LABEL}>Running now</Typography>
        </div>
        {running.length === 0 ? (
          <Typography variant="p" className="mt-2 text-[0.88rem] text-ink-inactive">
            Nothing is running{health ? '.' : ' — and no agent is listening on this computer, so nothing can.'}
          </Typography>
        ) : running.map((job) => (
          <div key={job.id} className="mt-3 flex items-start gap-3.5">
            <div className="min-w-0 flex-1">
              <Typography variant="p" weight="semibold" className="text-[0.95rem] leading-snug">
                {job.goal ?? job.name}
              </Typography>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Chip label={job.scheduleId ? 'by itself · from a schedule' : 'by itself · asked from a chat'} tone="accent" />
                <span className="text-[0.76rem] text-ink-inactive tabular-nums">
                  step {job.steps.length} · started {when(job.startedAt)}
                </span>
              </div>
              <div className="mt-2.5 flex flex-col gap-0.5">
                {job.steps.slice(-6).map((step, i) => (
                  <StepLine key={i} kind={verdictKind(step)}>
                    {describe(asDid(step), health?.platform)}
                    {evidenceOf(step)}
                  </StepLine>
                ))}
              </div>
            </div>
            <Button
              variant="destructiveOutline"
              size="sm"
              isLoading={busy === job.id}
              leftSlot={<Square className="size-3.5" />}
              onClick={() => void act(job.id, () => cancelJob(job.id), 'Stopping.')}
            >
              Stop
            </Button>
          </div>
        ))}
      </section>

      {/* ------------------------------------------------------------------ WAITING: queue + coming up */}
      {(queued.length > 0 || upcoming.length > 0) && (
        <section className="mb-4 rounded-xl border-stroke border bg-surface-card p-4">
          <div className="flex items-baseline gap-2.5">
            <Typography variant="span" className={LABEL}>Waiting</Typography>
            <Typography variant="span" className="text-[0.78rem] text-ink-inactive tabular-nums">
              {[queued.length && `${queued.length} queued`, upcoming.length && `${upcoming.length} coming up`].filter(Boolean).join(' · ')}
            </Typography>
          </div>
          <ul className="mt-3 flex flex-col gap-1.5">
            {queued.map((job) => (
              <li key={job.id} className="grid grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg bg-surface-card2 px-3 py-2.5">
                <span className="size-2 justify-self-center rounded-full bg-ink-inactive" />
                <div className="min-w-0">
                  <div className="truncate text-[0.9rem]">{job.goal ?? job.name}</div>
                  <div className="text-[0.76rem] text-ink-inactive">
                    queued · {job.scheduleId ? 'from a schedule' : 'asked from a chat'}
                    {running.length ? ' · waits for the run above to finish' : ' · waits for a machine to take it'}
                  </div>
                </div>
                <Chip label="queued" tone="neutral" />
                <Button size="xs" variant="ghost" isLoading={busy === job.id}
                  onClick={() => void act(job.id, () => cancelJob(job.id), 'Cancelled.')}>
                  Cancel
                </Button>
              </li>
            ))}
            {upcoming.map((one) => (
              <li key={one.id} className="grid grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg bg-surface-card2 px-3 py-2.5">
                <Clock className="size-3.5 justify-self-center text-brand-primary" />
                <div className="min-w-0">
                  <div className="truncate text-[0.9rem]">{one.label || one.flowId}</div>
                  <div className="text-[0.76rem] text-ink-inactive tabular-nums">
                    {one.nextSaid} · {one.rule}
                    {one.rule.startsWith('once') && one.lastSaid ? ` · ${one.lastSaid}` : ''}
                    {' · runs only while this computer is awake'}
                  </div>
                </div>
                <Chip label={scheduleChip(one).label} tone={scheduleChip(one).tone} />
                {/* Одноразовое отменяется здесь - оно кончается этим одним разом и ничем больше. Повторяющееся
                  * здесь ПАУЗИТСЯ: удалить правило, стоящее на Skills, с другой страницы одной кнопкой было бы
                  * слишком легко; убрать его совсем - корзина там, где оно живёт. */}
                {one.rule.startsWith('once') ? (
                  <Button size="xs" variant="ghost" isLoading={busy === one.id}
                    onClick={() => void act(one.id, () => scheduleRemove(one.id), `Cancelled — nothing will run at ${one.nextSaid}.`)}>
                    Cancel
                  </Button>
                ) : (
                  <Button size="xs" variant="ghost" isLoading={busy === one.id} leftSlot={<Pause className="size-3.5" />}
                    onClick={() => void act(one.id, () => schedulePause(one.id, true), `Paused "${one.label}". Resume it on the Skills page.`)}>
                    Pause
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {upcoming.some((one) => !one.rule.startsWith('once')) && (
            <Typography variant="p" className="mt-2.5 text-[0.78rem] text-ink-inactive">
              Repeating schedules are edited and removed on{' '}
              <button type="button" className="text-brand-primary underline-offset-2 hover:underline" onClick={() => void navigate({ to: '/skills' })}>
                Skills → Runs by itself
              </button>.
            </Typography>
          )}
        </section>
      )}

      {/* ------------------------------------------------------------------ HISTORY */}
      <section className="rounded-xl border-stroke border bg-surface-card p-4">
        <div className="mb-3 flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-full lg:basis-auto">
            <Typography variant="span" className={cn(LABEL, 'block')}>History · {entries.length} run{entries.length === 1 ? '' : 's'}</Typography>
            <Typography variant="h2" weight="semibold" className="mt-0.5 text-[1.35rem]">Everything that ran</Typography>
          </div>
          <div className="relative min-w-[12rem] flex-1 sm:max-w-[20rem]">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-inactive" />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search what you asked for…"
              className="h-8 w-full rounded-md border-stroke border bg-surface-card2 ps-8 pe-2.5 text-[0.85rem] text-ink-primary placeholder:text-ink-inactive focus:border-input-focus focus:outline-none"
            />
          </div>
          {/* Считаны, чтобы выбор не был гаданием - как фильтры библиотеки на Skills. */}
          <div className="flex w-full items-center gap-0.5 rounded-md border-stroke border bg-surface-card2 p-0.5 sm:w-auto sm:shrink-0">
            {FILTERS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                className={cn(
                  'h-7 rounded-md px-2.5 text-[0.8rem] tabular-nums transition-colors',
                  filter === id ? 'bg-surface-card text-ink-primary font-semibold shadow-sm' : 'text-ink-inactive hover:text-ink-secondary',
                )}
              >
                {label} {counts[id]}
              </button>
            ))}
          </div>
        </div>

        {shown.length === 0 ? (
          <Typography variant="p" className="py-6 text-center text-[0.88rem] text-ink-inactive">
            {entries.length ? 'Nothing matches.' : 'Nothing has run yet.'}
          </Typography>
        ) : (
          <ul className="flex flex-col">
            {shown.map((e) => {
              const isOpen = open === e.id;
              const chips = e.kind === 'run' ? runChips(e.run) : [jobChip(e.job)];
              const tone = e.kind === 'run' ? runTone(e.run) : jobChip(e.job).tone;
              const title = e.kind === 'run' ? titleOf(e.run) : (e.job.goal ?? e.job.name);
              const source = e.kind === 'run' ? sourceOf(e.run, e.job) : (e.job.scheduleId ? 'schedule' : 'chat');
              const length = e.kind === 'run' ? took(e.run) : '';
              return (
                <li key={e.id} className="border-stroke/40 border-b last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : e.id)}
                    aria-expanded={isOpen}
                    className={cn(
                      'grid w-full grid-cols-[1rem_minmax(0,1fr)_auto_5.5rem_7rem_4rem_1.25rem] items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-state-hover',
                      isOpen && 'bg-state-hover',
                    )}
                  >
                    <span className={cn('size-2 justify-self-center rounded-full', dotClass(tone))} />
                    <span className="truncate text-[0.9rem] text-ink-primary">{title}</span>
                    <span className="flex flex-wrap justify-end gap-1">
                      {chips.map((chip) => <Chip key={chip.label} {...chip} />)}
                    </span>
                    <span className="text-[0.78rem] text-ink-secondary">{source}</span>
                    <span className="text-[0.78rem] text-ink-inactive tabular-nums">{when(e.at)}</span>
                    <span className="text-[0.78rem] text-ink-inactive tabular-nums">{length || '—'}</span>
                    {isOpen ? <ChevronDown className="size-3.5 text-ink-inactive" /> : <ChevronRight className="size-3.5 text-ink-inactive" />}
                  </button>

                  {isOpen && (
                    <div className="ms-[1.25rem] mb-3 flex flex-col gap-1 border-stroke/60 border-s ps-3 pe-2">
                      {e.kind === 'run' ? (
                        <>
                          {wordsOf(e.run).map((word, i) => <StepLine key={`w${i}`} kind="say">{word}</StepLine>)}
                          {stepsOf(e.run).map((step, i) => (
                            <StepLine key={`s${i}`} kind={verdictKind(step)}>
                              {describe(asDid(step), health?.platform)}
                              {evidenceOf(step)}
                            </StepLine>
                          ))}
                          {e.run.summary && (
                            <Typography variant="p" className={cn('mt-1 text-[0.86rem]', e.run.outcome === 'ok' ? 'text-fb-green' : 'text-fb-red-text')}>
                              {e.run.summary}
                            </Typography>
                          )}
                          <Frames runId={e.run.id} />
                        </>
                      ) : (
                        <Typography variant="p" className="text-[0.86rem] text-ink-secondary">
                          {e.job.said ?? 'It never ran.'}
                        </Typography>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Page>
  );
};

/* Экспорт для сайдбара: сколько идёт или ждёт прямо сейчас. Здесь, а не в live.ts, чтобы слово «waiting»
 * определялось в одном месте с страницей, которая его показывает. */
export const useActivityCount = () => {
  const live = useLive();
  return live.filter((job) => job.state === 'claimed' || job.state === 'queued').length;
};
