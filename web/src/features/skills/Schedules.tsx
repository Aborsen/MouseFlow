/* Расписания: что стоит на самотёк, когда сработает и что было в прошлый раз.
 *
 * ГЛАВНОЕ, ЧТО ЭТОТ ЭКРАН ОБЯЗАН ГОВОРИТЬ, - не «расписание есть», а ЧТО С НИМ СТАЛО. Прогон по расписанию
 * случается только пока машина не спит и берёт работу, значит самый частый исход у любого домашнего
 * расписания - «срок прошёл, никто не слушал», и он не становится прогоном: в истории прогонов его нет.
 * Расписание, которое молча ничего не делает, - это тот вид поломки, который обнаруживают через неделю,
 * поэтому строка везёт последний исход словами и счётчик пропусков рядом со счётчиком запусков.
 *
 * ВРЕМЯ ПОКАЗЫВАЕТСЯ В ЗОНЕ РАСПИСАНИЯ, а не браузера, и его считает сервер. Человек, поставивший «09:00
 * Europe/Kiev» и открывший приложение в Лондоне, должен видеть киевские девять - иначе строка соврёт ему о
 * том, что он сам же и задал.
 *
 * ЧТО ЗДЕСЬ НЕ РИСУЕТСЯ: cron-строка. Правило приезжает уже словами («every day at 09:00 Europe/Kiev») из
 * того же `ruleSaid`, которым его печатает MCP, - чтобы человек и модель читали одну фразу.
 */
import { Clock, Pause, Play, Trash2, TriangleAlert } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { type Schedule, scheduleAdd, schedulePause, scheduleRemove, schedules } from '@/lib/api';

/** Живое ли расписание - от этого зависит и вид строки, и что предлагает кнопка. */
const running = (one: Schedule) => !one.paused;

/* ШЕСТЬ СТРОК, ДАЛЬШЕ СКРОЛЛ - как у библиотеки и у «Ready to become a skill» на этой же странице.
 *
 * За одну ночь прогон, откладывавший себя каждые четверть часа, оставил двадцать расписаний, и полоса
 * вытянулась во весь экран, спрятав библиотеку под собой. Список, который растёт с каждой записью,
 * годится для страницы про этот список; здесь он - одна из трёх секций, и место ему отмерено.
 *
 * Строка - имя с правилом, срок со счётчиками и последний исход - около 5.5rem вместе с зазором; шесть
 * таких - потолок. Не через clamp по высоте окна, как у библиотеки: та делит экран с двумя соседями и
 * растёт до десяти, а здесь просили ровно шесть. */
const LIST_HEIGHT = 'calc(6 * 5.5rem)';

export const Schedules = ({ reloadKey, onNote }: {
  /* Меняется, когда где-то поставили новое: перечитать, а не гадать. */
  reloadKey: number;
  onNote: (text: string, kind: 'good' | 'bad') => void;
}) => {
  const [rows, setRows] = useState<Schedule[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await schedules();
      setRows(body.schedules);
      setGone(null);
    } catch (err) {
      /* Отдельным состоянием, а не пустым списком: «ничего не запланировано» и «спросить не удалось» - разные
       * факты, и второй, показанный как первый, читается как «всё в порядке». */
      setGone(err instanceof Error ? err.message : 'the schedules could not be read');
    }
  }, []);

  useEffect(() => { void load(); }, [load, reloadKey]);

  /* Ничего нет - и ничего не рисуется. Пустая рамка с надписью «здесь будут расписания» это место, занятое
   * обещанием; страница Skills и без неё длинная. Отказ - другое дело, о нём сказать надо. */
  if (gone) {
    return (
      <section className="mb-4 rounded-xl border-fb-red/40 border bg-surface-card p-4">
        <div className="flex items-center gap-1.5">
          <TriangleAlert className="size-4 text-fb-red-text" />
          <Typography variant="span" weight="semibold" className="text-[0.9rem] text-fb-red-text">
            The schedules could not be read
          </Typography>
        </div>
        <Typography variant="p" className="mt-1 max-w-[70ch] break-words text-ink-secondary text-[0.85rem]">
          {gone}
        </Typography>
        <Button size="sm" variant="secondary" className="mt-2.5" onClick={() => void load()}>Try again</Button>
      </section>
    );
  }
  if (!rows || !rows.length) return null;

  const act = async (id: string, what: () => Promise<unknown>, said: string) => {
    setBusy(id);
    try {
      await what();
      await load();
      onNote(said, 'good');
    } catch (err) {
      onNote(err instanceof Error ? err.message : 'that did not work', 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mb-4 rounded-xl border-stroke border bg-surface-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Clock className="size-4 shrink-0 text-brand-primary" aria-hidden />
        <Typography variant="h2" weight="semibold" className="text-[1rem]">
          Runs by itself
        </Typography>
        <Typography variant="span" className="text-[0.8rem] text-ink-inactive">
          {rows.length} schedule{rows.length === 1 ? '' : 's'}
        </Typography>
      </div>
      {/* Условие исполнения - здесь, над строками, а не в подсказке под курсором: расписание, о котором
        * человек думает, что оно сработает при закрытом ноутбуке, хуже отсутствующего. */}
      <Typography variant="p" className="mt-1 max-w-[80ch] text-ink-secondary text-[0.84rem]">
        These run only while that computer is awake and taking work — the machine's own asking is what the
        clock is. A time that passes while nothing is listening is recorded as <em>missed</em> rather than run
        hours late, and three failures in a row pause a schedule.
      </Typography>

      <ul
        className="mt-3 grid grid-cols-[minmax(0,1fr)] content-start gap-2 overflow-y-auto border-stroke border-t pt-3 pe-1"
        style={{ maxHeight: LIST_HEIGHT }}
      >
        {rows.map((one) => (
          <li
            key={one.id}
            className={cn(
              'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 rounded-lg border px-3 py-2',
              running(one) ? 'border-stroke bg-surface-card2' : 'border-stroke/60 bg-surface-card2/50',
            )}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <Typography variant="span" weight="semibold" className="break-words text-[0.9rem]">
                  {one.label || one.flowId}
                </Typography>
                <span className="text-[0.78rem] text-ink-secondary">{one.rule}</span>
                {!running(one) && (
                  <span className="rounded-md bg-surface-chips px-1.5 py-0.5 text-[0.72rem] text-ink-inactive">
                    paused{one.pausedWhy ? ` — ${one.pausedWhy}` : ''}
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[0.78rem] text-ink-inactive tabular-nums">
                {running(one)
                  ? <>next {one.nextSaid ?? 'not scheduled'}</>
                  : <>nothing runs until it is resumed</>}
                {' · '}
                {one.runs} run{one.runs === 1 ? '' : 's'}
                {one.misses > 0 && (
                  /* Пропуски названы своим словом и выделены: это единственный исход, который человек
                    * иначе не увидит нигде - прогоном он не становится. */
                  <span className="text-fb-attention">{` · ${one.misses} missed`}</span>
                )}
                {one.fails > 0 && <span className="text-fb-red-text">{` · ${one.fails} failed`}</span>}
              </div>
              {one.lastSaid && (
                <div className="mt-0.5 break-words text-[0.76rem] text-ink-inactive">
                  last: {one.lastSaid}
                </div>
              )}
            </div>

            <span className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="xs"
                isLoading={busy === one.id}
                leftSlot={running(one) ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                onClick={() => void act(
                  one.id,
                  () => schedulePause(one.id, running(one)),
                  running(one)
                    ? `Paused "${one.label}" — it keeps its rule and runs nothing until resumed.`
                    : `Resumed "${one.label}" — the next run is counted from now.`,
                )}
              >
                {running(one) ? 'Pause' : 'Resume'}
              </Button>
              {/* Удаление за одним нажатием, но подтверждением: расписание - не данные, его потеря стоит
                * настройки заново, а не работы. Скилл при этом не трогается, и это сказано в вопросе. */}
              <Button
                variant="destructiveOutline"
                size="xs"
                aria-label={`Remove the schedule for ${one.label}`}
                onClick={() => {
                  if (!window.confirm(`Stop running "${one.label}" ${one.rule}?\n\n`
                    + 'The skill itself stays; only the schedule goes.')) return;
                  void act(one.id, () => scheduleRemove(one.id), `Removed the schedule for "${one.label}".`);
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
};

/* ------------------------------------------------------------------ ПОСТАВИТЬ РАСПИСАНИЕ НА ОДИН СКИЛЛ
 *
 * Панель в строке, а не модальное окно: в этом приложении модальных окон нет ни одного, и раскрывающаяся
 * панель уже служит и структуре скилла, и «Use in AI». Заводить ради шести полей второй способ вести
 * разговор значило бы выучить пользователю два.
 *
 * ЗОНУ ПРИСЫЛАЕТ БРАУЗЕР, И ОНА ПОКАЗАНА. Единственное, чего сервер знать не может: у него нет ни одной
 * зоны, а «09:00» без зоны молча значит 09:00 UTC. Браузер свою знает - `Intl` отдаёт IANA-имя, - поэтому
 * поле не спрашивают, но и не прячут: человек, поставивший утреннюю задачу в поездке, должен видеть, в
 * КАКИХ девяти утра она встанет.
 *
 * CRON-СТРОКИ ЗДЕСЬ НЕТ НАРОЧНО. Выбор - «раз в столько-то» или «в такое-то время суток», потому что это
 * два вопроса, которые люди задают, и на оба можно ответить фразой, которую потом видно в списке. `0 * * * *`
 * человек, которому за это доверять, прочитать не может.
 */

/** Что предлагается нажать, вместо того чтобы вводить интервал руками. Потолок - тридцать суток. */
const EVERY: Array<{ said: string; label: string }> = [
  { said: '15m', label: '15 min' },
  { said: '1h', label: 'hour' },
  { said: '4h', label: '4 hours' },
  { said: '1d', label: 'day' },
  { said: '7d', label: 'week' },
];

/** Зона этого браузера, IANA-именем. Отказ Intl - не причина ломать панель: UTC и сказано, что UTC. */
const hereZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {
    return 'UTC';
  }
};

const Tab = ({ on, children, onClick }: {
  on: boolean; children: ReactNode; onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'h-7 rounded-md px-2.5 text-[0.8rem] transition-colors',
      on ? 'bg-surface-card text-ink-primary shadow-sm' : 'text-ink-inactive hover:text-ink-secondary',
    )}
  >
    {children}
  </button>
);

export const ScheduleFor = ({ flowId, name, onDone, onCancel }: {
  flowId: string;
  name: string;
  /** Поставлено: сказать словами и перечитать полосу. */
  onDone: (said: string) => void;
  onCancel: () => void;
}) => {
  const [kind, setKind] = useState<'every' | 'daily'>('daily');
  const [every, setEvery] = useState('1h');
  const [at, setAt] = useState('09:00');
  const [days, setDays] = useState<'all' | 'weekdays'>('all');
  const [label, setLabel] = useState(name.slice(0, 80));
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const zone = hereZone();

  const put = async () => {
    setBusy(true);
    setWhy(null);
    try {
      const made = await scheduleAdd({
        flowId,
        label: label.trim() || name,
        zone,
        ...(kind === 'every' ? { every } : { at, days }),
      });
      onDone(`"${made.schedule.label}" runs ${made.schedule.rule}. Next ${made.schedule.nextSaid}.`);
    } catch (err) {
      /* Отказ показывается ЗДЕСЬ, а не общей плашкой наверху: он почти всегда про то поле, которое человек
       * только что выбрал («каждые 5 минут - слишком часто»), и читать его надо не отрываясь от полей. */
      setWhy(err instanceof Error ? err.message : 'it could not be scheduled');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 rounded-lg border-stroke/45 border bg-surface-card2 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-0.5 rounded-md border-stroke border bg-surface-card2 p-0.5">
          <Tab on={kind === 'daily'} onClick={() => setKind('daily')}>At a time of day</Tab>
          <Tab on={kind === 'every'} onClick={() => setKind('every')}>Every so often</Tab>
        </span>

        {kind === 'daily' ? (
          <>
            <input
              type="time"
              value={at}
              onChange={(e) => setAt(e.target.value)}
              aria-label="Time of day"
              className="h-8 rounded-md border-stroke border bg-surface-card px-2.5 text-[0.85rem] text-ink-primary tabular-nums focus:border-input-focus focus:outline-none"
            />
            <span className="flex items-center gap-0.5 rounded-md border-stroke border bg-surface-card2 p-0.5">
              <Tab on={days === 'all'} onClick={() => setDays('all')}>Every day</Tab>
              <Tab on={days === 'weekdays'} onClick={() => setDays('weekdays')}>Weekdays</Tab>
            </span>
          </>
        ) : (
          <span className="flex flex-wrap items-center gap-0.5 rounded-md border-stroke border bg-surface-card2 p-0.5">
            {EVERY.map((one) => (
              <Tab key={one.said} on={every === one.said} onClick={() => setEvery(one.said)}>
                {one.label}
              </Tab>
            ))}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value.slice(0, 80))}
          placeholder="What to call this schedule"
          aria-label="What to call this schedule"
          className="h-8 w-full rounded-md border-stroke border bg-surface-card px-2.5 text-[0.85rem] text-ink-primary focus:border-input-focus focus:outline-none sm:w-[18rem]"
        />
        <Button size="sm" isLoading={busy} onClick={() => void put()}>Schedule it</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>

      {/* Зона - сказанная, а не подразумеваемая; и условие исполнения повторено здесь, потому что решение
        * принимается в этот момент, а полосу со списком человек, ставящий первое расписание, ещё не видел. */}
      <Typography variant="p" className="mt-2 max-w-[80ch] text-ink-inactive text-[0.78rem]">
        {kind === 'daily'
          ? <>Times are read in <strong>{zone}</strong> — this browser&apos;s own zone, kept with the schedule
              so it keeps meaning the same hour if you travel.</>
          : <>Counted from each run, not from the clock.</>}
        {' '}It runs only while that computer is awake and taking work; a time that passes with nothing
        listening is recorded as missed.
      </Typography>

      {why && (
        <Typography variant="p" className="mt-1.5 max-w-[80ch] break-words text-fb-red-text text-[0.8rem]">
          {why}
        </Typography>
      )}
    </div>
  );
};
