/* Activity: что машина делает сейчас, что она собирается сделать, и что она сделала - с кнопкой там, где вещь.
 *
 * ЗАЧЕМ СТРАНИЦА. Прогон по расписанию шёл всю ночь, каждые четверть часа, и вопрос «как это отменить»
 * упирался в то, что ответ был рассыпан по трём местам: одноразовое расписание лежало на Skills в полосе
 * «Runs by itself», ждущая работа была видна только тулу mouseflow_status, а история - только в панели справа
 * на Create, и только пока открыта Create. Ни одно из трёх не отвечало на вопрос целиком, и ни в одном не
 * было кнопки у той вещи, о которой спрашивали.
 *
 * ТРИ КАРТОЧКИ, КАК НА SKILLS. Каждая - в своём ободке, с зазором, с окном на шесть-семь строк и прокруткой
 * справа; строки внутри - те же скруглённые плашки, что у библиотеки и у «Ready to become a skill». Первая
 * версия рисовала историю таблицей во всю ширину, и на 1920 пикселях цель прогона растягивалась в строку на
 * весь экран: страница читалась как чужая. Одинаковые блоки - это не украшение, это то, что позволяет
 * человеку не перечитывать правила чтения на каждой странице.
 *
 * ИСТОРИЯ - ЖУРНАЛ ПЛЮС ОЧЕРЕДЬ. Отменённое до запуска и упавшее на заборе прогоном не стало и в user_run его
 * нет, а человек, спрашивающий «что стало с моей просьбой из чата», обязан увидеть и это.
 *
 * СЛОВА - ИЗ ОДНОГО СЛОВАРЯ (status.ts), и два вопроса никогда не делят один чип: «довёл ли агент» и «прошёл
 * ли продукт». У прогона может стоять «ok» и рядом «1 check failed» - это найденный дефект, а не путаница.
 */
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, Clock, Pause, RotateCcw, Search, Square } from 'lucide-react';
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

/* ОКНО СПИСКА - семь строк, дальше прокрутка. Зазор тот же, что у библиотеки на Skills (0.375rem, gap-1.5);
 * высота строки - СВОЯ, измеренная на этой странице: строка истории однострочная и ниже библиотечной (44px
 * против 58.3px), и с чужой высотой в окно влезало восемь строк, а не семь - снимок доки это и показал. Семь
 * строк - потолок, меньше - список короче сам. Не clamp по высоте окна, как у библиотеки: здесь три таких
 * блока друг под другом, и общий их рост должен быть предсказуем. */
const LIST_ROW = 2.75;   // rem — 44px measured on this page's single-line rows
const LIST_GAP = 0.375;  // rem — gap-1.5, as on Skills
const rowsToRem = (n: number) => n * LIST_ROW + (n - 1) * LIST_GAP;
const LIST_HEIGHT = `${rowsToRem(7)}rem`;

/* Та же плашка, что у строк «Ready to become a skill»: скруглённая, с тонким ободком, на surface-card2. */
const ROW = 'rounded-lg border-stroke/45 border bg-surface-card2 px-3 py-2';

/* ЦЕЛЬ ОБРЕЗАЕТСЯ. На широком экране колонка с именем занимала всё, что оставалось, и «каждые 15 минут
 * проверяй…» тянулась на полтора метра. Сорок два rem - это около семидесяти знаков: достаточно, чтобы узнать
 * прогон, и мало, чтобы он подвинул статус за край. Целиком - по раскрытии и в title. */
const TITLE = 'min-w-0 max-w-[42rem] truncate text-[0.9rem] text-ink-primary';

/* Сколько суток очереди подмешивается в историю. Столько же, сколько живут кадры (ARTIFACT_KEEP_DAYS): дальше
 * назад разбирать всё равно нечем. */
const HISTORY_DAYS = 30;

/* ТРИ ФИЛЬТРА ВМЕСТО ОДНОГО ПЕРЕКЛЮЧАТЕЛЯ. «Failed» и «By itself» - разные оси, и один сегментный контрол
 * заставлял выбирать между ними. Статус, источник и время - независимы; поиск - по имени и цели. */
type StatusFilter = 'all' | 'ok' | 'bug' | 'failed' | 'stopped' | 'cancelled' | 'deferred';
type SourceFilter = 'all' | 'you' | 'schedule' | 'chat' | 'extension';
type PeriodFilter = '1' | '7' | '30' | 'all';

const STATUSES: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'Any status' },
  { id: 'ok', label: 'ok' },
  { id: 'bug', label: 'ok · a check failed' },
  { id: 'failed', label: 'could not finish' },
  { id: 'stopped', label: 'stopped by you' },
  { id: 'cancelled', label: 'cancelled · never ran' },
  { id: 'deferred', label: 'set aside' },
];
const SOURCES: { id: SourceFilter; label: string }[] = [
  { id: 'all', label: 'Any source' },
  { id: 'you', label: 'you' },
  { id: 'schedule', label: 'schedule' },
  { id: 'chat', label: 'chat' },
  { id: 'extension', label: 'extension' },
];
const PERIODS: { id: PeriodFilter; label: string }[] = [
  { id: '1', label: 'Last 24 hours' },
  { id: '7', label: 'Last 7 days' },
  { id: '30', label: 'Last 30 days' },
  { id: 'all', label: 'All time' },
];

const SELECT = 'h-8 rounded-md border-stroke border bg-surface-card2 px-2 text-[0.82rem] text-ink-body focus:border-input-focus focus:outline-none';

const Chip = ({ label, tone }: { label: string; tone: Parameters<typeof chipClass>[0] }) => (
  <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[0.72rem] font-semibold whitespace-nowrap', chipClass(tone))}>
    {label}
  </span>
);

/** Одна строка истории - прогон из журнала, или работа из очереди, которая прогоном не стала. */
type Entry =
  | { kind: 'run'; id: string; at: string | null; run: Run; job: LiveJob | null }
  | { kind: 'job'; id: string; at: string | null; job: LiveJob };

/* ПЕРЕЗАПУСК - ЧЕРЕЗ CREATE, тем же путём, что «Ask again» в панели истории: цель ложится в композер, и человек
 * нажимает Run сам. Не в очередь напрямую: очередь ждёт машину, которая может спать, а человек, нажавший
 * Relaunch, смотрит на экран и хочет видеть, как оно идёт. Передача через sessionStorage, потому что цель -
 * это текст на несколько строк, и в адресной строке ему не место. */
export const RELAUNCH_KEY = 'mouseflow.relaunch';

const statusOf = (e: Entry): StatusFilter => {
  if (e.kind === 'job') return e.job.state === 'cancelled' ? 'cancelled' : 'failed';
  const first = runChips(e.run)[0]?.label ?? '';
  if (first.startsWith('set aside')) return 'deferred';
  if (e.run.outcome === 'ok') return e.run.checks && e.run.checks.failed > 0 ? 'bug' : 'ok';
  if (e.run.outcome === 'stopped') return 'stopped';
  return 'failed';
};

export const ActivityView = () => {
  const { runs, reload } = useAccount();
  const { health } = useAgent();
  const live = useLive();
  const navigate = useNavigate();

  const [upcoming, setUpcoming] = useState<Schedule[]>([]);
  const [queueHistory, setQueueHistory] = useState<LiveJob[]>([]);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [source, setSource] = useState<SourceFilter>('all');
  const [period, setPeriod] = useState<PeriodFilter>('30');
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

  const shown = useMemo(() => {
    const since = period === 'all' ? 0 : Date.now() - Number(period) * 86_400_000;
    const needle = term.trim().toLowerCase();
    return entries.filter((e) => {
      if (since && (Date.parse(e.at ?? '') || 0) < since) return false;
      if (status !== 'all' && statusOf(e) !== status) return false;
      const from = e.kind === 'run' ? sourceOf(e.run, e.job) : (e.job.scheduleId ? 'schedule' : 'chat');
      if (source !== 'all' && from !== source) return false;
      if (!needle) return true;
      const text = (e.kind === 'run' ? `${e.run.name ?? ''} ${e.run.goal ?? ''}` : `${e.job.goal ?? ''} ${e.job.name}`).toLowerCase();
      return text.includes(needle);
    });
  }, [entries, status, source, period, term]);

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

  const relaunch = (goal: string) => {
    try { sessionStorage.setItem(RELAUNCH_KEY, goal); } catch (_) { /* private mode: the composer stays empty */ }
    void navigate({ to: '/create' });
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
            what happened, run it again.
          </Typography>
        </div>
      </header>

      <Said note={said} onDismiss={() => setSaid(null)} className="mb-4 max-w-[86ch]" />

      {/* ------------------------------------------------------------------ RUNNING NOW */}
      <section className="mb-4 rounded-xl border-stroke border bg-surface-card p-4">
        <div className="flex items-baseline gap-2.5">
          <span className={cn('size-2 self-center rounded-full', running.length ? 'bg-fb-attention shadow-[0_0_0_4px_rgba(255,105,0,.18)]' : 'bg-ink-inactive')} />
          <Typography variant="span" className={LABEL}>Running now</Typography>
          <Typography variant="span" className="text-[0.78rem] text-ink-inactive tabular-nums">
            {running.length ? `${running.length} run${running.length === 1 ? '' : 's'}` : 'nothing'}
          </Typography>
        </div>
        {running.length === 0 ? (
          <Typography variant="p" className="mt-2 text-[0.88rem] text-ink-inactive">
            Nothing is running{health ? '.' : ' — and no agent is listening on this computer, so nothing can.'}
          </Typography>
        ) : (
          <ul className="mt-3 flex flex-col gap-1.5 overflow-y-auto pe-1" style={{ maxHeight: LIST_HEIGHT }}>
            {running.map((job) => (
              <li key={job.id} className={ROW}>
                <div className="flex items-center gap-3">
                  <span className="size-2 shrink-0 rounded-full bg-fb-attention" />
                  <span className={cn(TITLE, 'flex-1 font-semibold')} title={job.goal ?? job.name}>{job.goal ?? job.name}</span>
                  <Chip
                    label={job.source === 'you' ? 'you · on this computer' : job.source === 'schedule' ? 'by itself · schedule' : 'by itself · chat'}
                    tone={job.source === 'you' ? 'neutral' : 'accent'}
                  />
                  <span className="text-[0.76rem] text-ink-inactive tabular-nums">step {job.steps.length} · {when(job.startedAt)}</span>
                  <Button
                    variant="destructiveOutline"
                    size="xs"
                    isLoading={busy === job.id}
                    leftSlot={<Square className="size-3" />}
                    onClick={() => void act(job.id, () => cancelJob(job.id), 'Stopping.')}
                  >
                    Stop
                  </Button>
                </div>
                <div className="mt-2 flex flex-col gap-0.5 ps-5">
                  {job.steps.slice(-4).map((step, i) => (
                    <StepLine key={i} kind={verdictKind(step)}>
                      {describe(asDid(step), health?.platform)}
                      {evidenceOf(step)}
                    </StepLine>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------------------ WAITING: queue + coming up */}
      <section className="mb-4 rounded-xl border-stroke border bg-surface-card p-4">
        <div className="flex items-baseline gap-2.5">
          <Typography variant="span" className={LABEL}>Waiting</Typography>
          <Typography variant="span" className="text-[0.78rem] text-ink-inactive tabular-nums">
            {queued.length + upcoming.length
              ? [queued.length && `${queued.length} queued`, upcoming.length && `${upcoming.length} coming up`].filter(Boolean).join(' · ')
              : 'nothing'}
          </Typography>
        </div>
        {queued.length + upcoming.length === 0 ? (
          <Typography variant="p" className="mt-2 text-[0.88rem] text-ink-inactive">
            Nothing is waiting. Schedules that are paused stay on <button type="button" className="text-brand-primary underline-offset-2 hover:underline" onClick={() => void navigate({ to: '/skills' })}>Skills → Runs by itself</button>.
          </Typography>
        ) : (
          <ul className="mt-3 flex flex-col gap-1.5 overflow-y-auto pe-1" style={{ maxHeight: LIST_HEIGHT }}>
            {queued.map((job) => (
              <li key={job.id} className={cn(ROW, 'grid grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-center gap-3')}>
                <span className="size-2 justify-self-center rounded-full bg-ink-inactive" />
                <div className="min-w-0">
                  <div className={TITLE} title={job.goal ?? job.name}>{job.goal ?? job.name}</div>
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
              <li key={one.id} className={cn(ROW, 'grid grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-center gap-3')}>
                <Clock className="size-3.5 justify-self-center text-brand-primary" />
                <div className="min-w-0">
                  <div className={TITLE} title={one.label || one.flowId}>{one.label || one.flowId}</div>
                  <div className="truncate text-[0.76rem] text-ink-inactive tabular-nums">
                    {one.nextSaid} · {one.rule} · runs only while this computer is awake
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
                  <Button size="xs" variant="ghost" isLoading={busy === one.id} leftSlot={<Pause className="size-3" />}
                    onClick={() => void act(one.id, () => schedulePause(one.id, true), `Paused "${one.label}". Resume it on the Skills page.`)}>
                    Pause
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------------------ HISTORY */}
      <section className="rounded-xl border-stroke border bg-surface-card p-4">
        <div className="mb-3 flex flex-wrap items-end gap-x-3 gap-y-3">
          <div className="min-w-0 flex-1 basis-full lg:basis-auto">
            <Typography variant="span" className={cn(LABEL, 'block')}>
              History · {shown.length === entries.length ? `${entries.length} run${entries.length === 1 ? '' : 's'}` : `${shown.length} of ${entries.length}`}
            </Typography>
            <Typography variant="h2" weight="semibold" className="mt-0.5 text-[1.35rem]">Everything that ran</Typography>
          </div>
          <div className="relative min-w-[12rem] flex-1 sm:max-w-[18rem]">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-inactive" />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search by name…"
              aria-label="Search runs by name"
              className="h-8 w-full rounded-md border-stroke border bg-surface-card2 ps-8 pe-2.5 text-[0.85rem] text-ink-primary placeholder:text-ink-inactive focus:border-input-focus focus:outline-none"
            />
          </div>
          {/* Три независимые оси, а не один переключатель: статус, источник, время. */}
          <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status" className={SELECT}>
            {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value as SourceFilter)} aria-label="Source" className={SELECT}>
            {SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <select value={period} onChange={(e) => setPeriod(e.target.value as PeriodFilter)} aria-label="Period" className={SELECT}>
            {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>

        {shown.length === 0 ? (
          <Typography variant="p" className="py-6 text-center text-[0.88rem] text-ink-inactive">
            {entries.length ? 'Nothing matches these filters.' : 'Nothing has run yet.'}
          </Typography>
        ) : (
          <ul className="flex flex-col gap-1.5 overflow-y-auto pe-1" style={{ maxHeight: open ? undefined : LIST_HEIGHT }}>
            {shown.map((e) => {
              const isOpen = open === e.id;
              const chips = e.kind === 'run' ? runChips(e.run) : [jobChip(e.job)];
              const tone = e.kind === 'run' ? runTone(e.run) : jobChip(e.job).tone;
              const title = e.kind === 'run' ? titleOf(e.run) : (e.job.goal ?? e.job.name);
              const from = e.kind === 'run' ? sourceOf(e.run, e.job) : (e.job.scheduleId ? 'schedule' : 'chat');
              const length = e.kind === 'run' ? took(e.run) : '';
              const goal = e.kind === 'run' ? e.run.goal : e.job.goal;
              const finished = e.kind === 'job' || e.run.outcome !== 'running';
              return (
                <li key={e.id} className={ROW}>
                  <div
                    onClick={(ev) => {
                      if ((ev.target as HTMLElement).closest('button,a')) return;
                      setOpen(isOpen ? null : e.id);
                    }}
                    className="grid cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto_5.5rem_9rem_4rem_auto_1.25rem] items-center gap-3"
                  >
                    <span className={cn('size-2 justify-self-center rounded-full', dotClass(tone))} />
                    <span className={TITLE} title={goal ?? title}>{title}</span>
                    <span className="flex flex-wrap justify-end gap-1">
                      {chips.map((chip) => <Chip key={chip.label} {...chip} />)}
                    </span>
                    <span className="text-[0.78rem] text-ink-secondary">{from}</span>
                    <span className="text-[0.78rem] text-ink-inactive tabular-nums">{when(e.at)}</span>
                    <span className="text-[0.78rem] text-ink-inactive tabular-nums">{length || '—'}</span>
                    {/* ПЕРЕЗАПУСК - у всего, что кончилось и у чего есть цель: та же дверь, что «Ask again»
                      * в панели истории, чтобы одна и та же вещь не делалась двумя путями. */}
                    {finished && goal ? (
                      <Button size="xs" variant="ghost" leftSlot={<RotateCcw className="size-3" />} title="Put this goal into Create, ready to run again"
                        onClick={() => relaunch(goal)}>
                        Relaunch
                      </Button>
                    ) : <span />}
                    {isOpen ? <ChevronDown className="size-3.5 text-ink-inactive" /> : <ChevronRight className="size-3.5 text-ink-inactive" />}
                  </div>

                  {isOpen && (
                    <div className="mt-2 ms-[1.25rem] flex flex-col gap-1 border-stroke/60 border-s ps-3 pe-2 pb-1">
                      {goal && goal !== title && (
                        <Typography variant="p" className="text-ink-inactive text-[0.78rem] italic">asked for: {goal}</Typography>
                      )}
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
