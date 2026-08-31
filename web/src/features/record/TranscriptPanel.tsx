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
 *   the raw events    the transcript describes a recording, it does not carry the events that replay it.
 *                     So Create skill does not make one here: it asks the caller, which opens SkillWizard -
 *                     the one flow in the product that makes a skill, where the steps are chosen and the
 *                     typed text is supplied. This panel used to build a skill itself, with its own copy of
 *                     the skill format and its own push, which made three ways to create one and two of
 *                     them silent about the steps.
 *   the step numbers  POST /api/transcript can drop steps, and the assistant on the dashboard is where
 *                     that is driven from ("remove those steps"). The Remove in this footer deletes the
 *                     whole recording, which is a different act, and it is armed in the button rather
 *                     than behind a confirm().
 */
import {
  AppWindow,
  FileText,
  ChevronRight,
  CircleDashed,
  Globe,
  Sparkles,
  Trash2,
  Loader2,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { Said } from '@/components/Said';
import { push } from '@/lib/api';
import { useIsSending } from './sending';

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
  /** When recording began, when the recording says so. Absent on anything made before it was stamped. */
  startedAt?: string | null;
  origins?: string[];
  windows?: { title?: string; process?: string }[];
}

interface Summary {
  events?: number;
  clicks?: number;
  scrolls?: number;
  drags?: number;
  keys?: number;
  typedSeconds?: number;
  /* ТРИ ЧИСЛА О ВРЕМЕНИ, а не одно, и это исправление подписи, а не добавление данных.
   *
   * `seconds` - то, что движок МОЖЕТ РАЗМЕСТИТЬ по стретчам ниже: пауза длиннее двух минут обрезается,
   * иначе запись, забытая на ночь, объявила бы восемь часов работы в приложении. Панель печатала именно
   * его - под подписью «in all», то есть «всё», чем оно как раз не является.
   *
   * `spanSeconds` - от первого события до последнего; ровно то, что показывает строка в списке записей.
   * `droppedSeconds` + `seconds` = `spanSeconds`, по построению.
   *
   * Все три необязательны: ответ старого развёртывания несёт только `seconds`, и тогда длина падает
   * обратно на него - два числа совпадают, второй значок не рисуется, и это правда о таком ответе. */
  seconds?: number;
  droppedSeconds?: number;
  droppedPauses?: number;
  spanSeconds?: number;
  applications?: unknown;
  pages?: unknown;
  captured?: unknown;
  gaps?: unknown;
}

/** One paragraph of the recording told as prose. `kind` is what it is for: the opening span-and-places
 * line, one paragraph per place in the order the work moved, and a closing reading of the proportions -
 * which is the only one that says more than was recorded, and says so. */
interface Chapter {
  kind?: string;
  title?: unknown;
  detail?: unknown;
  text?: unknown;
  at?: unknown;
  seconds?: unknown;
}

interface Where {
  kind?: 'app' | 'page' | 'unknown' | string;
  label?: string;
  detail?: string;
  /* Адрес страницы, на которой шёл этот отрезок, если запись его знает. Без строки запроса - отрезана в
   * api/_transcript.js, потому что там живут токены сессии, а расшифровку и документ по ней посылают. */
  url?: string;
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
  story?: Chapter[];
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

/** +0:04, +1:23 - and the plus is the point. Without it the column read as a duration, which is the other
 *  number on the same line; "0:03 · 4s" was two spans where one was an offset. */
const fmtAt = (at: number | string | undefined): string => {
  if (typeof at === 'number' && Number.isFinite(at)) return `+${fmtClock(at)}`;
  return str(at) ?? '—';
};

/* THE TIME OF DAY A STEP HAPPENED, which the transcript could not say at all until now.
 *
 * Every offset here is measured from the first event, which answers "how far in" and not "when". On a
 * sixty-four minute recording those are different questions, and the second one is the one that lets
 * somebody line a step up against a meeting, a message or their own memory.
 *
 * TWO BASES, AND THE ORDER MATTERS.
 *
 *   `startedAt`   recorded at the press. Exact, and preferred whenever it is there.
 *   `created`     the moment recording STOPPED - that is when the row is built - so the start is that
 *                 minus the span the transcript measured. Sound for anything MouseFlow recorded, and it
 *                 carries the seconds between the last event and the press that ended it.
 *
 * Null when neither works, and then nothing is printed. An IMPORTED .mmmacro is the case worth naming: its
 * `created` is when the file was imported, so the subtraction would describe the import rather than the
 * work. Nothing in the row can tell that apart from here, which is exactly why `startedAt` is now recorded
 * and why an import does not get one.
 */
const clockFrom = (flow: TranscriptFlow | undefined, totalMs: number | null) => {
  const stamped = Date.parse(str(flow?.startedAt) ?? '');
  let base = Number.isFinite(stamped) ? stamped : NaN;
  if (!Number.isFinite(base)) {
    const finished = Date.parse(str(flow?.created) ?? '');
    if (Number.isFinite(finished) && totalMs != null && totalMs >= 0) base = finished - totalMs;
  }
  if (!Number.isFinite(base)) return null;
  const exact = Number.isFinite(stamped);
  return {
    /** Whether the base was recorded rather than reckoned - said in a tooltip, never in the number. */
    exact,
    at: (atMs: number) => {
      const when = new Date(base + atMs);
      const two = (v: number) => String(v).padStart(2, '0');
      return `${two(when.getHours())}:${two(when.getMinutes())}:${two(when.getSeconds())}`;
    },
  };
};

type Clock = ReturnType<typeof clockFrom>;

/* WHOSE CLOCK IT IS, and the question is fair: the stamps travel as instants - `startedAt` and `created` are
 * ISO, which is UTC - and the browser renders them in ITS OWN zone. Reading your own recording on the
 * machine that made it, that is exactly the clock you watched. Reading a colleague's from another zone, the
 * instant is still right and the wall time is yours, not theirs. Named rather than left to be assumed. */
const localZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch (_) {
    return null;   // an engine without the zone in resolvedOptions; the times are still right
  }
})();

/** What the clock's own tooltip says, so a reckoned time never passes for a recorded one. */
const clockNote = (clock: NonNullable<Clock>) => (clock.exact
  ? 'The time of day this step happened. Recording began at a moment the recorder stamped.'
  : 'The time of day this step happened, worked out from when the recording stopped minus how long it '
    + 'ran — the recorder did not stamp its start. Off by however long passed between the last event and '
    + 'the press that ended it.')
  + (localZone ? ` Shown in this browser's time zone (${localZone}).` : '');

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

/* -------------------------------------------------------------------------- furniture */

const Quiet = ({ children }: { children: ReactNode }) => (
  <Typography variant="p" className="text-ink-inactive text-[0.84rem]">
    {children}
  </Typography>
);

/* `title` необязателен и есть у одного значка из семи - у того, чья подпись без определения читается как
 * объективная: «placed below» осмысленно только когда сказано, что не поместилось и почему. */
/* ОДНА строка на два места: её ставят при взведении и по ней же узнают, что стирать по таймеру. Две копии
 * этого текста означали бы, что через полгода таймер перестанет узнавать своё предупреждение и оставит его
 * на экране - ровно та ошибка, которую он и чинит.
 *
 * «Press the bin again», а не «Press again»: кнопка не меняет ни размера, ни подписи, поэтому фраза обязана
 * сама указать, что нажимать - «ещё раз» рядом с неизменившейся иконкой это указание без адресата. И про
 * снятие сказано словами, потому что крестик в конце строки иначе читается как «закрыть сообщение», а он
 * здесь отменяет удаление. */
/* КОГДА ШАГИ ПОКАЗЫВАЮТСЯ СРАЗУ.
 *
 * Обе складки ниже были закрыты по доводу, который верен и записан рядом с ними: расшифровка,
 * открывающаяся шестьюстами строками координат, закапывает то, что стоило написать. Но у записи из 73
 * шагов закапывать нечего, а человек, пришедший за последовательностью, находил вместо неё пересказ и две
 * складки - именно это и было в отчёте.
 *
 * Порог, а не переключатель: сколько в записи шагов, известно до отрисовки, и решение принимается один раз
 * за читателя, а не оставляется ему кнопкой.
 *
 * Числа - по измеренным записям: 73 шага в двенадцати стретчах, самый крупный 25. Такая открывается
 * целиком; четырёхчасовая на 6705 шагов остаётся сложенной, как и была. */
const STEPS_OPEN_MAX = 160;
const SEGMENT_OPEN_MAX = 40;

const ARMED_WARNING = 'This deletes the recording and this transcript with it. Press the bin again to go '
  + 'ahead, or dismiss this line to leave it alone.';

const Chip = ({ value, label, title }: { value: string; label: string; title?: string }) => (
  <span
    className="inline-flex items-baseline gap-1 rounded-md bg-surface-chips px-1.5 py-0.5"
    title={title}
  >
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
const StepRow = ({ step, clock }: { step: Step; clock: Clock }) => {
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
      {/* The offset, and the time of day behind it. Not a fourth column: this panel is 34rem beside the
          list and 286px inside the extension, and a step row already carries a number, an offset and a
          sentence that wraps. The clock is what the offset MEANS, so it belongs on the offset. */}
      <span
        className="w-11 shrink-0 pt-px font-mono text-[0.72rem] text-ink-inactive tabular-nums"
        title={clock && typeof step.at === 'number' && Number.isFinite(step.at)
          ? `${clock.at(step.at)} — ${clockNote(clock)}`
          : undefined}
      >
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
  clock,
}: {
  segment: Segment;
  index: number;
  ofSeconds: number;
  clock: Clock;
}) => {
  const steps = list(segment.steps);
  const seconds = count(segment.seconds);
  const label = str(segment.where?.label);
  const detail = str(segment.where?.detail);
  const url = str(segment.where?.url);
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
            {/* САЙТ ССЫЛКОЙ, а не только словом. Отчёт назвал документ без ссылок «незаконченным файлом», и
                то же верно для панели: подпись «secure.2checkout.com» отвечает, ГДЕ это было, и не даёт
                туда попасть.
                `noreferrer` вместе с `noopener`: страница, открытая отсюда, не должна узнать ни адрес этого
                приложения, ни получить ссылку на его окно. */}
            {detail && (
              <span className="block break-words text-[0.75rem] text-ink-inactive">
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={url}
                    className="text-brand-primary hover:underline"
                  >
                    {detail}
                  </a>
                ) : detail}
              </span>
            )}
            {/* Only when the endpoint left all three blank: the reader has to be told that the blank is
              * the recording's, not this panel's. */}
            {!label && !detail && !note && (
              <span className="block text-[0.75rem] text-ink-inactive">
                The recording does not say which application or page these steps happened in.
              </span>
            )}
          </div>
          <div className="shrink-0 text-right">
            {/* When this stretch began, above how long it lasted. The header is the line people read, and
                it could say how long but not when. */}
            {clock && count(segment.startMs) != null && (
              <span
                className="block font-mono text-[0.72rem] text-ink-inactive tabular-nums"
                title={clockNote(clock)}
              >
                {clock.at(count(segment.startMs) ?? 0)}
              </span>
            )}
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
        /* Closed. The header above says where the work was, how long it took and how many steps it holds -
         * which is what somebody reads. The coordinates are for checking one particular step, and a
         * transcript that opens with six hundred lines of them buries the part that was worth writing. */
        <details className="group" open={steps.length <= SEGMENT_OPEN_MAX}>
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[0.78rem] text-ink-inactive hover:bg-state-hover">
            <ChevronRight className="size-3.5 shrink-0 transition-transform duration-base group-open:rotate-90" />
            <span>
              {steps.length} step{steps.length === 1 ? '' : 's'}, with the positions and timings
            </span>
          </summary>
          <ol className="border-stroke border-t py-1">
            {/* Keyed on position, not on `n`: `n` is optional, and two steps without one gave two rows the
              * same key - React then reuses one row's DOM for the other. */}
            {steps.map((step, i) => (
              <StepRow key={`${index}-${i}`} step={step} clock={clock} />
            ))}
          </ol>
        </details>
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
  /** Put this recording back on the account, when the browser still holds its events. Absent when it does
   * not, because a button that cannot work is worse than the plain error. */
  onRestore?: () => Promise<void>;
  /** Hand this recording to the assistant on the Dashboard. The panel does not navigate itself - the caller
   * owns the router - it just says when. */
  onAnalyze?: () => void;
  /* Открыть ассистента с просьбой НАПИСАТЬ процесс. Отдельный проп, а не флаг у
   * onAnalyze: у вызывающей стороны это два разных перехода, и оба она делает сама. */
  onDocument?: () => void;
  /** Make a skill of this recording: the panel says when, the caller opens SkillWizard. A promise for the
   * same reason onRestore is one - the caller may have to read the account first, and the button that was
   * pressed is the right place to show that it is working. */
  onMakeSkill?: () => Promise<void>;
}

export const TranscriptPanel = ({
  flowId, name, onClose, onRemoved, onRestore, onAnalyze, onDocument, onMakeSkill,
}: Props) => {
  const [data, setData] = useState<Transcript | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /* Едет ли эта запись прямо сейчас на аккаунт. Одна запись, а не весь реестр: панель смотрит на одну, и
   * подписка на весь реестр будила бы её на каждую чужую загрузку. */
  const sending = useIsSending(flowId);
  /* ЧИНИТСЯ ЛИ ЭТО НАЖАТИЕМ - один вопрос, один ответ, и раньше его никто не задавал.
   *
   * Кнопка предлагалась по фразе «no recording with that id», которая до Fix 5 покрывала три разные
   * причины сразу. Из них push чинит РОВНО ОДНУ: строку, которой на аккаунте никогда не было. Удалённую он
   * не чинит - sync.js отвергает запись поверх надгробия, иначе удаление, сделанное на одной машине,
   * возвращалось бы с другой; а созданный скилл записью не станет от того, что его отправят ещё раз.
   *
   * Сравнение по началу фразы, а не по всей: слова после первой точки объясняют, и их правят чаще. */
  const canRestore = !!onRestore && !!problem
    && /^no recording with that id on this account/i.test(problem);
  const [busy, setBusy] = useState(true);
  /* Bumped to ask for the same transcript again. A state value rather than calling the loader directly,
   * so the effect stays the only thing that starts a request and its abort always matches it. */
  const [attempt, setAttempt] = useState(0);

  const [note, setNote] = useState<{ text: string; kind: 'good' | 'bad' } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [making, setMaking] = useState(false);
  const [armed, setArmed] = useState(false);
  const [removing, setRemoving] = useState(false);

  /* A different recording is a different panel: nothing about the last one still applies, the transcript
   * least of all.
   *
   * This cleared the notes and left `data` alone, which was the one thing on screen a reader would act on:
   * switching recordings kept the previous transcript up - its name, its counts, its steps, dimmed but
   * readable - while the footer's Remove already pointed at the new flowId. Keyed on flowId only, so
   * `attempt` re-reads the same
   * recording without blanking the transcript the reader still has in front of them. */
  useEffect(() => {
    setData(null);
    setNote(null);
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
  }, [flowId, attempt, sending]);

  /* Armed only briefly: a destructive button left cocked is one stray click away from being pressed.
   *
   * И ПРЕДУПРЕЖДЕНИЕ СНИМАЕТСЯ ВМЕСТЕ СО СОСТОЯНИЕМ, которое оно описывает. Таймер снимал только `armed`,
   * а красная строка оставалась - то есть экран продолжал говорить «нажмите ещё раз, чтобы удалить», когда
   * нажатие уже просто взводило заново. Раньше это отчасти скрывалось тем, что кнопка возвращала себе
   * узкий вид; теперь кнопка не меняет размера вовсе, и слова остались единственным указанием на
   * состояние - то есть единственным, что врало.
   *
   * Снимается ТОЛЬКО своя строка: следом мог прийти отчёт «Nothing was deleted: …», и его стирать нельзя.
   * Сравнение по тексту, а не по kind: «bad» бывает и у отказа. */
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => {
      setArmed(false);
      setNote((was) => (was && was.text === ARMED_WARNING ? null : was));
    }, 6000);
    return () => clearTimeout(timer);
  }, [armed]);

  const summary = data?.summary;
  const flow = data?.flow;
  const segments = useMemo(() => list(data?.segments), [data]);
  /* ТРИ ЧИСЛА, А НЕ ОДНО, и до этого наружу шло только среднее из них - под подписью «in all».
   *
   * `seconds` - время, которое движок МОЖЕТ РАЗМЕСТИТЬ по стретчам ниже: пауза длиннее двух минут
   * обрезается, иначе запись, забытая на ночь, объявила бы восемь часов работы в приложении.
   * `spanSeconds` - от первого события до последнего, то самое, что печатает строка в списке записей.
   * `droppedSeconds` - разница, и она НЕ потеряна.
   *
   * Измерено на живой записи: 3ч19м40с против 4ч54м10с, разница 1ч34м29с в 14 паузах. Список печатал
   * четыре часа, панель три с половиной и называла их «в целом», и ни одно из двух чисел не говорило, чем
   * оно является. Оба верны - неверна была подпись.
   *
   * Старое развёртывание новых полей не пришлёт, поэтому длина падает обратно на размещённое время: тогда
   * два числа совпадают и второй значок не рисуется, что и есть правда о таком ответе. */
  const totalSeconds = count(summary?.seconds);
  const droppedSeconds = count(summary?.droppedSeconds) ?? 0;
  const droppedPauses = count(summary?.droppedPauses) ?? 0;
  const spanSeconds = count(summary?.spanSeconds) ?? totalSeconds;
  /* The time of day, built once for the whole panel - see clockFrom. Depends on the flow head and on the
   * measured span, because the reckoned base is one minus the other. */
  const clock = useMemo(
    () => clockFrom(flow, totalSeconds != null ? Math.round(totalSeconds * 1000) : null),
    [flow, totalSeconds],
  );
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
  const typedSeconds = count(summary?.typedSeconds);

  const remove = useCallback(async () => {
    /* Asked in the button, the way MyAccountScreen asks. A confirm() is easy to click through without
     * reading and a second dialog is easy to lose behind the first; turning the button into the
     * consequence is not. */
    if (!armed) {
      setArmed(true);
      setNote({ text: ARMED_WARNING, kind: 'bad' });
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

  const story = list(data?.story) as Chapter[];

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
          {/* The three things you can do with an open recording, together: make a skill of it, delete it,
            * close it. They used to be a strip along the bottom, which is a permanent border and a permanent
            * padding across the part of the panel where the text is read. */}
          <div className="flex shrink-0 items-center gap-1.5">
            {/* ONE flow, and it is not in here. This used to build a skill on the press - a literal macro,
              * no steps chosen, no typed text asked for - which is a different thing from what the wizard
              * makes, under the same words. Now it opens the wizard, so "Create skill" means the same act
              * wherever it is pressed. */}
            {onMakeSkill && (
              <Button
                size="sm"
                leftSlot={<Sparkles className="size-4" />}
                isLoading={making}
                disabled={removing || !!problem}
                onClick={() => {
                  setMaking(true);
                  void onMakeSkill().finally(() => setMaking(false));
                }}
              >
                Create skill
              </Button>
            )}

            {/* THE SAME SIZE ARMED OR NOT, and that is the fix rather than the styling.
              *
              * Arming it used to grow this button into "Remove — press again" and add a Cancel beside it -
              * some 200px more in a row that cannot shrink, next to a title column that can. In the panel's
              * own width the title was squeezed to about sixty pixels and came out one word per line: the
              * header rearranged itself at the exact moment somebody was being asked a yes-or-no question.
              *
              * So the confirmation lives in the red line under the header instead, where there is a whole
              * width for it, and the way out is that line's own dismiss - see the note below. Colour still
              * changes, because a cocked destructive control has to look different from a resting one;
              * width does not. */}
            <Button
              variant={armed ? 'destructive' : 'destructiveOutline'}
              size="sm"
              className="!size-8 !p-0"
              aria-label={armed ? 'Remove this recording — press again to confirm' : 'Remove this recording'}
              title={armed ? 'Press again to remove it' : 'Remove this recording'}
              isLoading={removing}
              onClick={() => void remove()}
            >
              <Trash2 className="size-4" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              aria-label="Close the transcript"
              className="!size-8 !p-0"
              title="Close"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* Under the actions, where it belongs: at the bottom it pushed up the text somebody was reading at
          * the exact moment it appeared. Transient, so it may change the header's height - which a header can
          * afford and a footer over a scrolling body cannot. */}
        {/* Inline rather than a box: this sits inside a panel whose footer cannot afford one. Announced
            all the same - see the note in Said.
            И ЭТО ЖЕ - ВЫХОД ИЗ ВЗВЕДЁННОГО УДАЛЕНИЯ. `armed` без таймера, поэтому путь назад обязателен;
            он здесь, а не кнопкой в шапке, потому что кнопка в шапке и была тем, что ломало заголовок.
            Только когда взведено: у обычного сообщения об исходе снимать нечего, и крестик рядом с
            «Removed» предлагал бы отменить то, что уже случилось. */}
        <Said
          note={note}
          variant="inline"
          className="mt-1.5"
          onDismiss={armed ? () => { setArmed(false); setNote(null); } : undefined}
        />

        {data && (
          <>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {/* ДЛИНА ЗАПИСИ первой, потому что это то, о чём спрашивают «сколько она шла», и то, что
                * стоит в списке записей. «in all» здесь стояло над обрезанным временем, то есть над
                * числом, которое как раз НЕ всё. */}
              <Chip value={fmtSeconds(spanSeconds)} label="long" />
              {/* И размещённая часть - только когда она меньше, иначе значок сообщал бы то же самое
                * дважды. Разница названа на наведении: доля без своего знаменателя нечитаема. */}
              {droppedSeconds > 0 && (
                <Chip
                  value={fmtSeconds(totalSeconds)}
                  label="placed below"
                  title={`${fmtSeconds(droppedSeconds)} fell in ${droppedPauses} pause${droppedPauses === 1 ? '' : 's'} longer than two minutes — somebody away from the machine rather than time in an application, so it is not attributed to any step.`}
                />
              )}
              <Chip value={String(stepCount)} label={stepCount === 1 ? 'step' : 'steps'} />
              {clicks != null && <Chip value={String(clicks)} label={clicks === 1 ? 'click' : 'clicks'} />}
              {!!drags && <Chip value={String(drags)} label={drags === 1 ? 'drag' : 'drags'} />}
              {!!scrolls && <Chip value={String(scrolls)} label={scrolls === 1 ? 'scroll' : 'scrolls'} />}
              {/* Keys only when there were any. A "0 keys" chip beside the rest reads as "they typed
                * nothing", and an empty count can also mean the agent was not watching - which is what the
                * captured line and the gaps below distinguish, in the endpoint's own words. */}
              {!!keys && <Chip value={String(keys)} label={keys === 1 ? 'key' : 'keys'} />}
              {/* The time, beside the count, because "five of those ten minutes went on typing" is the
                * question this answers and a keystroke count alone does not. */}
              {!!typedSeconds && <Chip value={fmtSeconds(typedSeconds)} label="typing" />}
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
        {/* ЕЩЁ НЕ ДОЕХАЛО - И ЭТО НЕ ОШИБКА, поэтому стоит ПЕРЕД блоком ошибки и вместо него.
          *
          * Транскрипт выводится на сервере из сохранённого payload, так что у записи, не доехавшей до
          * аккаунта, транскрипта нет - это по устройству, а не поломка (см. §3.2 work order'а). Но ответ
          * «no recording with that id on this account» описывает совсем другой случай и предлагал кнопку
          * «Put it back on my account», которая здесь чинит то, что не сломано.
          *
          * Само дочитывается: `attempt` перечитывает транскрипт, а `sending` перестанет быть true, когда
          * загрузка завершится, - значит эффект ниже сработает сам, без единого нажатия. */}
        {sending && (
          <section className="rounded-xl border border-stroke-divider bg-surface-card p-4">
            <div className="flex items-center gap-1.5">
              <Loader2 className="size-4 animate-spin text-brand-primary" />
              <Typography variant="span" weight="semibold" className="text-[0.9rem]">
                Still going up to your account
              </Typography>
            </div>
            <Typography variant="p" className="mt-1 max-w-[60ch] break-words text-ink-secondary text-[0.85rem]">
              The transcript is read from your account, so it appears once the recording has arrived. A long
              recording takes a few seconds. Nothing to do — this reads itself when it lands.
            </Typography>
          </section>
        )}

        {!sending && problem && (
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

            {/* The one failure that has a cure rather than a retry.
              *
              * Recordings and skills are the same table, so a recording deleted from Skills - where it looks
              * like a skill - leaves this page still listing it and this panel answering 404. The events are
              * in the browser, so it is one push from being right, and api/sync.js upserts over a tombstone
              * (deleted_at = null), which makes putting it back the ordinary save applied again. */}
            {canRestore && (
              <>
                <Typography variant="p" className="mt-2 max-w-[60ch] break-words text-ink-inactive text-[0.8rem]">
                  This browser still has it, and the account has never had it — so putting it back is the
                  ordinary save that happens when you stop recording, applied again.
                </Typography>
                <Button
                  size="sm"
                  className="mt-2.5"
                  isLoading={restoring}
                  leftSlot={<Upload className="size-4" />}
                  onClick={async () => {
                    setRestoring(true);
                    try {
                      await onRestore();
                      setAttempt((n) => n + 1);
                    } catch (err) {
                      setNote({
                        text: err instanceof Error ? err.message : 'it could not be put back',
                        kind: 'bad',
                      });
                      /* И ПЕРЕЧИТАТЬ ТЕЛО ТОЖЕ - иначе на экране окажутся две фразы про разные моменты.
                       *
                       * Удачное «положить обратно» двигало `attempt`, то есть перечитывало транскрипт.
                       * Неудачное только ставило `note`, а тело оставалось со своим 404, объяснением и
                       * кнопкой ровно в том виде, в каком было; `problem` же чистится только при смене
                       * `flowId`. Так на одном экране оказывались предложение про состояние строки СЕЙЧАС
                       * и предложение про её состояние несколько минут назад, и ничто не говорило, какое
                       * из них какое. Это и дало ту пару противоречивых сообщений в отчёте. */
                      setAttempt((n) => n + 1);
                    } finally {
                      setRestoring(false);
                    }
                  }}
                >
                  Put it back on my account
                </Button>
              </>
            )}

            <Button
              size="sm"
              variant={canRestore ? 'tertiary' : 'primary'}
              className="mt-3"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </Button>
          </section>
        )}

        {!data && !problem && <Quiet>Reading this recording…</Quiet>}

        {data && (
          <div className={cn('space-y-3', busy && 'opacity-60 transition-opacity duration-base')}>
            {/* --------------------------------------------------------------- the story
              *
              * First, because it is what somebody opening a transcript is asking for: what happened, in
              * order, in words. Every clause under it was derived from a recorded event - no model wrote
              * this - and the step list below is the evidence for each paragraph, which is why the place
              * paragraphs carry the clock offset the segments are labelled with. */}
            {story.length > 0 && (
              <section className="rounded-lg border-stroke border bg-surface-card p-4">
                <Typography variant="h3" weight="semibold" className="mb-2.5 text-[0.92rem]">
                  What happened
                </Typography>
                <div className="space-y-2.5">
                  {story.map((chapter, i) => {
                    const title = str(chapter.title);
                    const detail = str(chapter.detail);
                    const text = str(chapter.text);
                    if (!text) return null;
                    const reading = chapter.kind === 'reading';
                    return (
                      <div
                        key={`${i}-${title ?? chapter.kind ?? ''}`}
                        className={cn(
                          'max-w-[68ch]',
                          reading && 'border-stroke border-t pt-2.5',
                        )}
                      >
                        {title && (
                          <div className="flex flex-wrap items-baseline gap-x-1.5">
                            <Typography variant="span" weight="semibold" className="break-words text-[0.85rem]">
                              {title}
                            </Typography>
                            {detail && (
                              <span className="text-[0.75rem] text-ink-inactive">{detail}</span>
                            )}
                            {count(chapter.at) != null && (
                              <span
                                className="ms-auto shrink-0 font-mono text-[0.72rem] text-ink-inactive tabular-nums"
                                title={clock ? clockNote(clock) : undefined}
                              >
                                {/* When it happened, and how long it took. The offset from the start of the
                                    recording was here too and is gone: with a clock on the left and a
                                    duration on the right it was the one number nobody was asking for, and
                                    "+0:00 · 3s" invited reading two spans as two durations.
                                    It survives on the step rows below, where the column is 44px and there is
                                    no room for a clock - those carry it in the title instead. */}
                                {clock ? clock.at(count(chapter.at) ?? 0) : `+${fmtClock(count(chapter.at) ?? 0)}`}
                                {count(chapter.seconds) ? ` · ${fmtSeconds(count(chapter.seconds) ?? 0)}` : ''}
                              </span>
                            )}
                          </div>
                        )}
                        <Typography
                          variant="p"
                          className={cn(
                            'break-words text-[0.85rem]',
                            reading ? 'text-ink-inactive' : 'text-ink-secondary',
                          )}
                        >
                          {text}
                        </Typography>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

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
              /* One hood over all of it.
                *
                * Eight segment cards stacked down the panel, each with a fold of its own, is the same
                * problem the caveats had: a lot of structure in front of somebody who came for the
                * summary. The story above IS the summary; this is the evidence for it, and evidence
                * belongs behind one door rather than eight. Open the transcript, then open the stretch
                * you want - two clicks to reach a coordinate, and none to read the recording. */
              <details
                className="group rounded-lg border-stroke border bg-surface-card"
                /* `open` как обычный атрибут, а не управляемое состояние: React его не контролирует, поэтому
                   читатель по-прежнему может складку закрыть, и она останется закрытой. */
                open={stepCount <= STEPS_OPEN_MAX}
              >
                <summary className="flex cursor-pointer list-none items-center gap-1.5 p-3.5">
                  <ChevronRight className="size-4 shrink-0 text-ink-inactive transition-transform duration-base group-open:rotate-90" />
                  <Typography variant="span" weight="semibold" className="text-[0.9rem]">
                    Transcript
                  </Typography>
                  <span className="ms-auto shrink-0 text-[0.76rem] text-ink-inactive tabular-nums">
                    {stepCount} step{stepCount === 1 ? '' : 's'} · {segments.length} place
                    {segments.length === 1 ? '' : 's'}
                  </span>
                </summary>
                <div className="space-y-2.5 border-stroke border-t p-3">
                  {segments.map((segment, i) => (
                    <SegmentBlock
                      // Position in the key as well: `n` is optional, and two segments without one collide.
                      key={`${i}-${count(segment.n) ?? 'n'}`}
                      segment={segment}
                      index={i}
                      ofSeconds={totalSeconds ?? 0}
                      clock={clock}
                    />
                  ))}
                </div>
              </details>
            )}

            {/* --------------------------------------------------- ask it something instead
              *
              * This is where "What this recording cannot tell you" used to be: eight paragraphs of caveat,
              * at the bottom of every transcript, that nobody had asked for. Every one of them is still in
              * the endpoint's response and the assistant reads them, which is the right place for an answer
              * to a question - it can say what the recording cannot tell you at the moment somebody asks,
              * rather than pre-emptively, to everybody, forever. */}
            {onAnalyze && (
              <section className="rounded-lg border-stroke border bg-surface-chips p-3.5">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <Typography variant="span" weight="semibold" className="block text-[0.88rem]">
                      Ask about this recording
                    </Typography>
                    <Typography variant="p" className="mt-0.5 max-w-[62ch] text-ink-inactive text-[0.8rem]">
                      The assistant can read this transcript, say where the time went, and remove steps you
                      ask it to. It also knows what the recording does not hold, which is worth asking
                      before trusting a number in it.
                    </Typography>
                  </div>
                  <Button
                    leftSlot={<Sparkles className="size-4" />}
                    onClick={onAnalyze}
                  >
                    Open in AI Assistant
                  </Button>
                </div>

                {/* ВТОРАЯ ПРОСЬБА, отдельной строкой и под первой, а не второй кнопкой в один ряд: это не
                  * вариант того же действия. Первая открывает разговор, вторая ПИШЕТ объект - строку в базе,
                  * которую потом правят, - и стоит модельного вызова. Разные последствия читаются как одно,
                  * когда кнопки стоят рядом одного размера.
                  *
                  * Она всё равно ведёт в ассистента, а не пишет документ здесь: писать значит читать
                  * расшифровку и платить модели, и это живёт там, где уже действуют правила и потолки
                  * ассистента. Кнопка избавляет от печатания просьбы, а не заводит вторую дорогу к
                  * действию. */}
                {onDocument && (
                  <div className="mt-3 flex flex-wrap items-center gap-3 border-stroke border-t pt-3">
                    <div className="min-w-0 flex-1">
                      <Typography variant="span" weight="semibold" className="block text-[0.88rem]">
                        Write it up as a process
                      </Typography>
                      <Typography variant="p" className="mt-0.5 max-w-[62ch] text-ink-inactive text-[0.8rem]">
                        A document with every line citing the step it came from, saved so it can be
                        corrected and exported. It says plainly what the recording cannot show — nothing
                        anybody typed is stored, so the words in a field are never in it.
                      </Typography>
                    </div>
                    <Button
                      variant="secondary"
                      leftSlot={<FileText className="size-4" />}
                      onClick={onDocument}
                    >
                      Write the process document
                    </Button>
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>

    </aside>
  );
};
