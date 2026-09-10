/* Record: the recorder, the recordings, and the flow. Three things, which is all this page is for.
 *
 * Ported from app.js. What it keeps from that version, because each was a bug once:
 *
 *   - Record stays enabled with no agent, and pressing it goes to Connections. A disabled button is a
 *     dead end: it says no and not why.
 *   - While recording, the front window is sampled once a second, so a recording can be named after where
 *     it happened - "Outlook (PWA) - 6 clicks" rather than "Recording 3" - and a skill made from it can
 *     say what it does.
 *   - A recording is a draft in this browser until it is kept as a skill, which is what puts it on the
 *     account and in reach of the other half.
 */
import { useNavigate } from '@tanstack/react-router';
import { Play, Square } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import {
  type AgentWindow,
  doAction,
  recordDrain,
  recordStart,
  recordStatus,
  recordStop,
  replay,
  replayAbort,
  replayStatus,
  windows,
} from '@/lib/agent';
import { type Flow, pull, push } from '@/lib/api';
import { askAbout } from '@/features/chat/ask-about';
import { SKILL_ROLE, roleOf } from '@/lib/flow-role';
import { dropOwnTail, flowBody, fmtMs, hasPlayable, parseMacro, summarize } from '@/lib/macro';
/* ПЕРЕПРИВЯЗКА ПЕРЕД ПОВТОРОМ - общий модуль, без сети и без DOM, проверяемый вычислением
 * (api/_test-anchor.mjs). Здесь только то, чего у него нет: спросить у агента, где окна сейчас. */
import { anchoredSaid, matchWindow, reanchorAll, whichWindow } from '../../../../api/_anchor.mjs';
import {
  type RecordedEvent, type Recording, refreshAgent, uid, useAgent, useConsole,
  persistTrouble,
} from '@/lib/store';
import { useAccount } from '@/shell/AccountProvider';
import { Page } from '@/shell/Surface';
import { hasSkillFor } from './save-as-skill';
import { RecordingsTable, replayOf } from './RecordingsTable';
import { CUT_AT_EVENTS, FIT_TARGET_BYTES, splitIntoRecordings } from './long-session';
import { TranscriptPanel } from './TranscriptPanel';
import { SkillWizard } from './SkillWizard';
import type { GoalSkillSource } from './save-as-skill';
import { WaitingForThisMac } from './WaitingForThisMac';
import { flowFor } from './flow-for';
import { claim, release } from './sending';
import { eventsAreHere, eventsFor } from './events-for';
/* Payload записи догружается по просьбе: список его больше не везёт. */
import { payloadOf } from '@/lib/api';

/* mm:ss, for the readout beside the disc.
 *
 * fmtMs() is the right thing everywhere else - it says "1.4s" and "2m 12s", which is how a DURATION reads in
 * prose - and it is the wrong thing for a clock: idle, it printed "0ms", which is a stopwatch reporting its
 * own precision instead of showing zero. A clock counts. */
const clock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/* Sixteen bars, driven by the event count rather than by a clock.
 *
 * The reference this follows shows an audio waveform; there is no audio in this product, and bars that moved
 * because time passed would be a meter measuring nothing. These are the one thing the recorder knows while it
 * runs - how many events have arrived - so they move when input moves and stand still when it stops. A still
 * meter over a running clock means the recorder is seeing nothing, which is a thing worth noticing.
 *
 * The shape is a deterministic function of the count, not random: the same count draws the same bars, so the
 * movement is the data changing rather than an animation running.
 */
const BARS = 16;

const LiveSignal = ({ live, count }: { live: boolean; count: number }) => (
  <div className="flex h-12 shrink-0 items-end gap-[3px]" aria-hidden>
    {Array.from({ length: BARS }, (_, i) => {
      /* Idle: a flat, dim floor. Live: a height that depends on both the bar and the count, so the pattern
       * travels as events arrive. Sine rather than random so it is smooth and repeatable. */
      const height = live
        ? 22 + Math.abs(Math.sin((count / 7) + i * 0.7)) * 78
        : 14 + Math.abs(Math.sin(i * 0.9)) * 10;
      return (
        <span
          key={i}
          className={cn(
            'w-[5px] rounded-full transition-[height] duration-300 ease-out',
            live ? 'bg-brand-primary' : 'bg-stroke',
          )}
          style={{ height: `${height}%` }}
        />
      );
    })}
  </div>
);

/* The recorder: one card, one height, three states.
 *
 * It used to be three shapes. Idle it carried a paragraph and up to two warnings; recording it carried none
 * of them; after a stop it grew again by the height of a note. So the card changed size whenever capture
 * started or stopped, and what moved was the whole list underneath it.
 *
 * So there is one skeleton and a footer that is ALWAYS present. What varies inside it is words - never
 * whether a block exists - and the footer reserves its height, so the longest state and the shortest state
 * are the same card.
 *
 * The disc's box is a fixed 128px on every state, which is what lets the button itself grow when capture
 * starts: 56px idle, 80px live, in a container that does not change. The waves are the state - they render
 * only while live, so the DOM says what the screen says - and prefers-reduced-motion drops the ripples while
 * keeping the red ring and the running clock, because somebody who asked for less movement still has to be
 * able to tell.
 */
const RecorderCard = ({ live, screen, elapsedMs, events, windows, onToggle, footer }: {
  live: boolean;
  screen: { w: number; h: number } | null;
  elapsedMs: number;
  events: number;
  windows: number;
  onToggle: () => void;
  footer: ReactNode;
}) => (
  <section className="rounded-xl border-stroke border bg-surface-card p-4">
    <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
      <div className="min-w-0 flex-1">
        <Typography variant="span" className="block text-[0.7rem] uppercase tracking-wide text-ink-inactive">
          Recorder
        </Typography>
        <div className="mt-0.5 flex items-center gap-2">
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              live ? 'animate-pulse bg-fb-red' : 'bg-ink-inactive/60',
            )}
          />
          <Typography variant="span" weight="semibold" className="text-[1.15rem]">
            {live ? 'Recording' : 'Ready to record'}
          </Typography>
        </div>
        {/* Measured, not decorative. The reference this follows shows "System audio"; there is no audio in
          * this product, and a status line that names something it does not do is worse than a shorter one. */}
        <Typography variant="p" className="mt-1 font-mono text-[0.78rem] text-ink-inactive tabular-nums">
          {clock(elapsedMs)}
          {screen ? ` · ${screen.w}×${screen.h}` : ''}
          {live
            ? ` · ${events} events · ${windows} window${windows === 1 ? '' : 's'}`
            : ' · mouse and keystroke timing, no text'}
        </Typography>
      </div>

      <LiveSignal live={live} count={events} />

      {/* Last in the row, and a fixed box either way.
        *
        * Fixed because the button inside grows when recording starts, and a row that resizes with it is the
        * jumping card this component was written to stop. Last because the control belongs at the edge the
        * hand reaches for - the reading order is what happened, then how much of it, then the thing that
        * changes it. */}
      <div className="relative grid size-32 shrink-0 place-items-center">
        {live && [0, 1, 2].map((i) => (
          <span
            key={i}
            aria-hidden
            className="absolute size-full animate-ping rounded-full border-fb-red/45 border-2 motion-reduce:hidden"
            // Staggered, so they read as waves leaving the button rather than one thing breathing.
            style={{ animationDelay: `${i * 0.6}s`, animationDuration: '1.8s' }}
          />
        ))}
        <span
          aria-hidden
          className={cn(
            'absolute size-full rounded-full border-2 transition-colors duration-base',
            live ? 'border-fb-red/60' : 'border-stroke',
          )}
        />
        <span
          aria-hidden
          className={cn(
            'absolute size-24 rounded-full border transition-colors duration-base',
            live ? 'border-fb-red/35' : 'border-stroke/60',
          )}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={live ? 'Stop and save this recording' : 'Start recording'}
          className={cn(
            'relative grid place-items-center rounded-full transition-all duration-base',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
            live
              ? 'size-20 bg-fb-red shadow-[0_0_0_8px_rgba(239,68,68,0.14)] hover:bg-fb-red/90'
              : 'size-14 bg-brand-primary hover:bg-brand-primary/90',
          )}
        >
          {/* A shape in the middle of each state, saying what pressing it will DO.
            *
            * A dot said nothing - it was the same mark the status light uses, in the middle of a control.
            * A triangle and a square are the two shapes every player anybody has ever used agrees on, so
            * they need no label and survive every language. */}
          {/* White on the RED stop, navy on the LIME start: the two states are two different
            * backgrounds, and one colour cannot be right on both. */}
          {live
            ? <Square className="size-7 fill-current text-white" />
            : <Play className="on-accent size-7 fill-current ps-1" />}
        </button>
      </div>
    </div>

    {/* Always here, whatever state the card is in. This is the whole reason the card stops changing height:
      * what varies is the words inside a block that is not conditional. The minimum height holds two lines,
      * which is the longest thing that goes in it. */}
    <div className="mt-3 min-h-[3.25rem] border-stroke/60 border-t pt-3">
      {footer}
    </div>
  </section>
);

export interface RecordViewProps {
  /* Whether to draw the recorder itself, or only what has been recorded.
   *
   * True everywhere in the app. False in exactly one place: the browser extension's side panel, which has a
   * recorder of its own - it captures inside web pages through content scripts, where this one captures the
   * whole desktop through the agent - and two Start buttons on one screen is a question nobody should have
   * to answer twice. The list below is one list either way: a recording is a recording once it exists. */
  recorder?: boolean;
}

export const RecordView = ({ recorder = true }: RecordViewProps = {}) => {
  const [state, update] = useConsole();
  /* Читается на каждом ререндере консоли, а не хранится: это факт про последнюю попытку записи на диск, и
   * useConsole уже будит компонент ровно тогда, когда такая попытка была. */
  const trouble = persistTrouble();
  const { health } = useAgent();
  const { reload, flows } = useAccount();
  const navigate = useNavigate();

  const [live, setLive] = useState<{ count: number; elapsedMs: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The name of the recording being replayed, or null. Drives Escape and the status poll. */
  const [playing, setPlaying] = useState<string | null>(null);
  const seenWindows = useRef<{ title: string; process: string }[]>([]);
  /* When the current recording began. A ref rather than state: nothing renders it, and a re-render between
   * the press and the stop must not lose it. Null until something is being recorded. */
  const startedAt = useRef<string | null>(null);

  /* СЕССИЙ БОЛЬШЕ НЕТ, и на этом месте стоит сказать, что здесь было. Запись, которая могла выйти длинной,
   * требовала выбрать ДО старта «резать каждые 30/60 минут»; части ехали с меткой session, таблица их
   * намеренно не показывала, показывала отдельная полоса, читавшая леджер в localStorage. Пять часов,
   * записанные обычной записью, эту конструкцию опровергли: выбирать было уже поздно, а нарезанные части
   * «доехали и пропали» - леджер никто не записал. Теперь причина резать одна - размер, - решение принимает
   * не человек заранее, а счётчик по ходу, и отрезанное - обычная запись в общем списке. */
  /** The agent's clock at the last automatic cut, so the card's timer restarts from zero. */
  const lastCutAt = useRef(0);
  /** One cut at a time. The poller runs four times a second and a drain is not instant. */
  const cutting = useRef(false);
  /* What the poller needs, held where its dependencies cannot reach.
   *
   * The effect below is keyed on WHETHER a recording is live and nothing else - there is a paragraph on it
   * there, because it once depended on the object it was itself rewriting four times a second, rebuilt both
   * intervals every tick, and the one-second window sampler never lived to its first tick. Adding `autoCut`
   * and `end` to those dependencies would bring the same illness back more slowly: `end` changes identity
   * with every recording made, `autoCut` with every account reload. So they travel by ref, like everything
   * else that effect only writes. It also settles the ordering question - `end` is declared below the
   * effect and cannot be named from inside it. */
  const autoCutNow = useRef<((agentElapsedMs: number) => Promise<void>) | null>(null);
  const endNow = useRef<(() => Promise<void>) | null>(null);

  const port = state.port;

  const begin = useCallback(async () => {
    if (!health) {
      void navigate({ to: '/connect' });
      setNote('The agent is not running yet — here is how to start it.');
      return;
    }
    if (health.recording) { setNote('Already recording.'); return; }
    try {
      await recordStart(port);
      /* The one moment this answer exists. Read at the press rather than reckoned at the stop - see the note
       * on `startedAt` in store.ts. */
      startedAt.current = new Date().toISOString();
      seenWindows.current = [];
      lastCutAt.current = 0;
      setLive({ count: 0, elapsedMs: 0 });
      setNote(null);
      refreshAgent();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'could not start recording');
    }
  }, [health, navigate, port]);

  /* Отрезать полную часть от живой записи, не останавливая её.
   *
   * Порядок прежний, и он важен: события забираются у агента ПЕРВЫМИ, аккаунт спрашивается ВТОРЫМ. Дрейн
   * необратим - после него события существуют только здесь, - поэтому неудачная отправка оставляет их
   * обычной НЕсинхронизированной записью в сторе: Reconciler и так перепосылает всякую локальную запись без
   * штампа, и отдельного механизма повторов у отрезов больше нет.
   *
   * Отрезанное - обычная запись: имя по моменту отреза, как у всякой остановки. На успехе локальная строка
   * едет в стор БЕЗ событий (eventsOnAccount) - события уже на аккаунте, а держать 6МБ здесь значило бы
   * воспроизвести нехватку места, ради которой отрез и существует. Таймер и счётчик начинаются с нуля сами:
   * буфер агента пустеет от дрейна, часы карточки считаются от lastCutAt. */
  const autoCut = useCallback(async (agentElapsedMs: number) => {
    /* Дрейн есть только у агента 0.8.0+. Старый резать на ходу не умеет - его запись просто копится, а
     * слишком большую разрежет остановка: end() ниже режет всё, что не влезает одной строкой. */
    if (health?.canDrain !== true) return;
    const text = await recordDrain(port);
    const { events } = parseMacro(text);
    /* Окна, увиденные ЗА ЭТУ ЧАСТЬ, не с начала записи: часть - это срез времени, и её список окон должен
     * описывать срез, иначе шестнадцатая часть дня заявляет все приложения смены. */
    const where = seenWindows.current.slice();
    seenWindows.current = [];
    lastCutAt.current = agentElapsedMs;
    if (!events.length) return;

    const at = new Date();
    const two = (v: number) => String(v).padStart(2, '0');
    const name = `MouseFlow ${two(at.getDate())}/${two(at.getMonth() + 1)} ${
      two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
    const made: Recording = {
      id: uid(),
      name,
      created: at.toISOString(),
      startedAt: startedAt.current ?? undefined,
      events,
      windows: where,
    };
    /* «Таймер с нуля» - это и startedAt следующей части: она началась сейчас. */
    startedAt.current = at.toISOString();

    const mine = claim([made.id]);
    try {
      const saved = await push({ flows: [flowFor(made, health)] });
      if (saved.problems.length) throw new Error(saved.problems.join('; '));
      const said = saved.stamped?.find((one) => one.id === made.id)?.updated;
      update((prev) => ({
        recordings: [...prev.recordings, {
          ...made,
          events: [],
          eventsOnAccount: true,
          summary: summarize(events),
          syncedAt: said ?? new Date().toISOString(),
        }],
      }));
      setNote(`Full — “${name}” saved to your account (${events.length} events). Recording carries on from zero.`);
      await reload();
    } catch (err) {
      /* События остаются в сторе несинхронизированной записью - Reconciler перепошлёт. Каждая часть по
       * построению меньше потолка, так что этот повтор не может отравить батч, как отравляла бы одна
       * слишком большая строка. */
      update((prev) => ({ recordings: [...prev.recordings, made] }));
      setNote(`Full — “${name}” is cut and kept here (${events.length} events); the account did not take it `
        + `yet (${err instanceof Error ? err.message : 'network'}). It retries on its own; recording carries on.`);
    } finally {
      release(mine);
    }
  }, [health, port, reload, update]);

  /* Whether a recording is running, which is not the same as whether THIS component knows about it: the
   * agent keeps recording across a remount, a reload and a tab left for an hour, and `health` is how the
   * page finds that out. Declared here rather than beside the markup that shows it, because the poller
   * below is keyed on it and a value used by an effect belongs above the effect. */
  const recording = live !== null || !!health?.recording;

  /* Two pollers while recording, at different cadences on purpose: the counter should feel live, and the
   * window list needs one sample a second at most - an application you passed through for half a second is
   * not what the flow is about.
   *
   * Keyed on WHETHER a recording is live, never on the live object. The counter below calls setLive() with a
   * fresh object every 250ms, so an effect depending on `live` tore itself down and rebuilt both intervals
   * four times a second - and the 1000ms sampler never reached its first tick. Every desktop recording came
   * out with payload.windows empty and a transcript saying "No window was recorded", which is why this is
   * worth a paragraph: the bug was invisible in the thing it broke. Nothing here reads the object, only
   * writes it, so the dependency was inherited rather than needed.
   *
   * AND KEYED ON `recording`, WHICH IS WHAT THE CARD SAYS - not on `live`, which is what this component
   * happens to remember. Those are two different questions and the answer differed exactly when it mattered:
   * `live` is state, so it is null after any remount, while the recording itself belongs to the agent and
   * runs on. Leave this page and come back, reload the tab, or start from the macOS menu bar, and the card
   * read "Recording · 00:00 · 0 events" and stayed there - because `recording` is true through `health` and
   * lights the word up, while the only thing that could have moved the clock was gated on `live` and never
   * started. A frozen clock over a running recorder is worse than no clock: the number is not missing, it
   * is wrong, and the one thing somebody watches it for is whether the recording is still going.
   *
   * The elapsed time survives the remount because it was never this tab's to keep - /record/status carries
   * the agent's own session clock, so the first tick after a reload answers with the real figure. */
  useEffect(() => {
    if (!recording) return;

    const counter = setInterval(async () => {
      try {
        const s = await recordStatus(port);
        if (!s.recording && s.count > 0) {
          /* The agent ended this recording itself - the macOS menu bar's "Stop and Save" - and HOLDS the
           * events: recording:false with count>0 is a state a stop from this page never leaves behind.
           * Collected through the same door as the Stop button, so it lands on the account identically,
           * without the user ever bringing this tab forward. end() carries its own mutex. */
          if (endNow.current) await endNow.current();
          return;
        }
        /* ЧАСЫ С НУЛЯ ПОСЛЕ КАЖДОГО ОТРЕЗА. Агент ведёт один свой счётчик на всю запись; карточка
         * показывает время ЭТОЙ части - вычитанием, а не вторым таймером, которому было бы с чего
         * разъезжаться. Счётчик событий обнуляется сам: дрейн опустошает буфер агента. */
        setLive({ count: s.count, elapsedMs: Math.max(0, s.elapsedMs - lastCutAt.current) });
        if (!s.recording) setLive(null);

        /* Отрез едет на том же опросе, который и так спрашивает. Одна причина резать - РАЗМЕР: `count` -
         * буфер агента, и когда он дорос до порога, часть отрезается сама, без выбора заранее. Часы были
         * прокси размера и умерли вместе с выбором «каждые 30/60 минут».
         *
         * The guard is a ref, not state: this runs four times a second, a drain takes longer than that, and
         * two overlapping drains would hand the same events to two parts. */
        if (s.count >= CUT_AT_EVENTS && !cutting.current && autoCutNow.current) {
          cutting.current = true;
          try {
            await autoCutNow.current(s.elapsedMs);
          } finally {
            cutting.current = false;
          }
        }
      } catch (_) {
        /* One failed poll is not a stopped recording. Nulling `live` used to end the polling too - the
         * effect was keyed on it - so a single blip left the counter dead until the page was reloaded.
         * Now it only clears the numbers, and the next tick 250ms later puts them back. */
        setLive(null);
      }
    }, 250);

    const sampler = setInterval(async () => {
      try {
        const seen = await windows(port);
        const front = seen.windows.find((w) => w.active);
        const label = front?.title || front?.process;
        if (!label) return;
        if (!seenWindows.current.some((w) => w.title === label)) {
          seenWindows.current.push({ title: label, process: front?.process ?? '' });
        }
      } catch (_) {
        // An agent too old to list windows records without the context, exactly as before.
      }
    }, 1000);

    return () => {
      clearInterval(counter);
      clearInterval(sampler);
    };
  }, [recording, port]);

  const end = useCallback(async () => {
    /* One mutex for every door into stopping: the Stop button, the poller's collect of an agent-side stop,
     * and the mounted held-check below. Two concurrent stops meant two recordStop calls - the loser took an
     * empty body, said "Nothing was captured." over the winner's note, and in a session could commit a
     * ledger missing the tail part the winner had just pushed. */
    if (cutting.current) return;
    cutting.current = true;
    try {
    try {
      const text = await recordStop(port);
      setLive(null);
      /* ЧЕМ ЗАПИСЬ ОСТАНОВИЛИ - НЕ ЧАСТЬ ЗАПИСИ. Кнопка «Стоп» стоит в НАШЕМ окне, и клик по ней попадал в
       * запись: повтор в конце поднимал MouseFlow и нажимал Стоп ещё раз - то есть начинал новую запись.
       * Свой хвост в трее агент снимает сам, но про кнопку в приложении знает только приложение, поэтому
       * оно и передаёт свой заголовок. Правило целиком - в api/_macro.mjs.
       *
       * Отрез стоит ДО проверки «есть что записать»: запись из одного клика по «Стоп» - это пустая запись,
       * и сказать про неё «Nothing was captured.» вернее, чем сохранить строку, которая при повторе
       * нажимает Стоп. */
      const { events } = dropOwnTail(parseMacro(text).events, document.title);
      /* «НИЧЕГО» - ЭТО НЕ ТОЛЬКО ПУСТОЙ СПИСОК. Найдено на живой записи: после отреза остановки осталось
       * одно событие «Focus» - пометка о смене окна, которую и сам агент на повторе считает несыгранной.
       * Проверка на length сохраняла такую запись на аккаунт. */
      if (!hasPlayable(events)) { setNote('Nothing was captured.'); return; }

      const where = seenWindows.current.slice();
      const s = summarize(events);
      /* Named by WHEN, to the SECOND: "MouseFlow 21/08 13:34:07" reads as a moment and sorts like one.
       * Minutes were tried and were not enough - three recordings inside one minute came out with three
       * identical names, which is the same uselessness as "Recording 3" wearing a timestamp. */
      const at = new Date();
      const two = (v: number) => String(v).padStart(2, '0');
      const name = `MouseFlow ${two(at.getDate())}/${two(at.getMonth() + 1)} ${
        two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;

      const made = {
        id: uid(),
        name,
        created: new Date().toISOString(),
        startedAt: startedAt.current ?? undefined,
        events,
        windows: where,
      };

      /* СТОП ТОЖЕ РЕЖЕТ. Автоотрез требует агента с дрейном; со старым агентом - или когда отрез по любой
       * причине не успел - остановка встречает больше событий, чем аккаунт берёт одной строкой. Раньше это
       * был отказ «unpacks to more than 7813KB» в момент, когда выбирать уже поздно, - пять часов работы,
       * повисшие на открытой вкладке. Теперь то же лезвие, что у «положить обратно» и импорта. */
      if (JSON.stringify(events).length > FIT_TARGET_BYTES) {
        const { recs, flows: partFlows } = splitIntoRecordings({ rec: made, events, health });
        const mine = claim(recs.map((r) => r.id));
        setNote(`Sending ${s.count} events to your account as ${recs.length} parts…`);
        try {
          const saved = await push({ flows: partFlows });
          if (saved.problems.length) throw new Error(saved.problems.join('; '));
          update((prev) => ({
            recordings: [...prev.recordings, ...recs.map((r) => ({
              ...r, events: [], eventsOnAccount: true, syncedAt: new Date().toISOString(),
            }))],
          }));
          setNote(`${s.count} events captured (${fmtMs(s.durationMs)}) — more than one row holds, so they `
            + `are on your account as ${recs.length} recordings, “${made.name} · part 1…${recs.length}”.`);
          await reload();
        } catch (err) {
          /* Части остаются здесь С событиями, несинхронизированными: каждая меньше потолка, Reconciler
           * перепошлёт их поодиночке. Целая запись на их месте отравляла бы каждый батч синхронизации. */
          update((prev) => ({ recordings: [...prev.recordings, ...recs] }));
          setNote(`Captured ${s.count} events as ${recs.length} parts, but syncing failed: ${
            err instanceof Error ? err.message : 'unknown error'}. They retry on their own.`);
        } finally {
          release(mine);
        }
        return;
      }

      update((prev) => ({ recordings: [...prev.recordings, made] }));
      /* Счёт событий - НЕ здесь, а после того, как аккаунт подтвердит. Раньше эта строка говорила «54157
       * events captured» ровно в тот момент, когда загрузка ещё не начиналась, и читалась как «готово»:
       * человек жал View, панель спрашивала у аккаунта строку, которой там ещё нет, и получала «нет такой
       * записи». Окно длиной в секунды и целиком невидимое. */

      /* And onto the account, at once.
       *
       * This used to wait until the recording was kept as a skill - the note at the top of this file said a
       * recording was a draft in this browser - and that was coherent until the transcript and the dashboard
       * started reading recordings from the account. The transcript is derived server-side from the stored
       * payload, so a recording that never left the browser has no transcript to show and View answered 404.
       *
       * What this means, plainly: the events, the window titles and the control names go to the user's own
       * account. That is the same data that already travelled when a recording was kept as a skill, and the
       * same rows the dashboard counts - but it now travels earlier, which is the trade for being able to ask
       * questions about a recording straight after making it.
       *
       * Best effort: the recording is safe in the browser either way, and a failed sync is worth a line of
       * text rather than losing what was just captured. */
      /* Заявка на эту запись - до отправки, снимается в `finally` ниже. Без неё Reconciler, разбуженный
       * записью в стор двадцатью строками выше, отправит те же байты вторым запросом, пока этот ещё в
       * полёте. См. sending.ts: это измерено, а не предположено. */
      const mine = claim([made.id]);
      setNote(`Sending ${s.count} events to your account…`);
      try {
        const saved = await push({ flows: [flowFor(made, health)] });
        if (saved.problems.length) {
          setNote(`Captured, but the account refused it: ${saved.problems.join('; ')}`);
        } else {
          setNote(`${s.count} events captured (${fmtMs(s.durationMs)})${
            where.length ? ` in ${where.length} window${where.length === 1 ? '' : 's'}` : ''
          }`);
          /* Stamped only on a clean push, because the stamp is a fact about the ACCOUNT: it is what later
           * separates "this exists only here, send it" from "this was deleted on another machine, drop it".
           * Setting it hopefully would make the second reconciliation delete a recording that never
           * arrived. */
          /* ОТМЕТКА СЕРВЕРА, А НЕ СВОЯ. Она едет обратно как `updated` и сравнивается там с `updated_at`,
           * который ставит Postgres; до этого обе стороны сравнения приходили с разных часов, и браузер,
           * отстающий от сервера, получал «older here than on the account» навсегда - починить это было
           * нечем, потому что ответ не нёс отметки, которую можно было бы принять за свою.
           *
           * Свои часы остаются запасным вариантом ровно для старого деплоя, который поля не шлёт. */
          const said = saved.stamped?.find((one) => one.id === made.id)?.updated;
          update((prev) => ({
            recordings: prev.recordings.map((rec) => (
              rec.id === made.id ? { ...rec, syncedAt: said ?? new Date().toISOString() } : rec
            )),
          }));
        }
        await reload();
      } catch (err) {
        setNote(`Captured ${s.count} events, but syncing failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }. The transcript needs the recording on your account.`);
      } finally {
        release(mine);
      }
    } catch (err) {
      setLive(null);
      setNote(err instanceof Error ? err.message : 'could not stop recording');
    }
    } finally {
      cutting.current = false;
    }
    /* `health` and `cut` are real dependencies: without them a page that loaded before the agent answered
     * keeps a stale closure where health is null, and every recording it collects is stamped
     * canName:false/canKeys:false - the transcript then asserts "the keyboard was not watched" about an
     * agent that watched it fine. The refs-effect below re-points endNow on every change, so the poller
     * keeps a stable ref regardless. */
  }, [port, state.recordings.length, update, health, reload]);

  /* The refs the poller reads, pointed at this render's functions. In an effect rather than inline, so a
   * render that is thrown away cannot leave a ref aimed at a closure that never committed. */
  useEffect(() => {
    autoCutNow.current = autoCut;
    endNow.current = end;
  }, [autoCut, end]);

  /* A recording the agent ended while this page was away - the menu bar's "Stop and Save" with the tab
   * closed or elsewhere - is still HELD by the agent (spilled to its disk, so even an agent restart keeps
   * it), and /record/start answers 409 until somebody takes delivery. Collected through end(), the same
   * door as the Stop button - which also means a huge overnight tail is SPLIT there rather than pushed as
   * one giant row the account refuses. Сессий с их леджером здесь больше нет: хвост - это просто запись. */
  const collectHeld = useCallback(async () => {
    if (cutting.current) return;
    let s;
    try { s = await recordStatus(port); } catch { return; }
    if (s.recording || s.count === 0) return;
    if (endNow.current) await endNow.current();
  }, [port]);

  /* Checked every few seconds while this page is open and nothing is live here - not only on the agent's
   * first appearance, because a held recording can arrive at any moment (the poller dies with its own error
   * handling, the agent restarts, the menu is pressed while this page shows idle). The check is one status
   * read; collection is guarded by the same mutex as every other stop. */
  const agentUp = health != null;
  useEffect(() => {
    if (!agentUp || recording) return;
    void collectHeld();
    const check = setInterval(() => { void collectHeld(); }, 3000);
    return () => clearInterval(check);
  }, [agentUp, recording, collectHeld]);

  /* Which recording's transcript is open. One at a time, and owned here rather than in the table, because the
   * panel is a sibling of the whole page rather than of a row. */
  const [viewing, setViewing] = useState<string | null>(null);
  /* The name of the recording being looked at, in one place. Three things ask for it - the panel's own
   * heading, the assistant's subject, and the wizard's fallback name - and a PART of a long session is
   * deliberately not among the local recordings, so the session ledger is the second place to look.
   * Written out three times before this, and the third copy is what a fourth reader would have copied. */
  const viewingName = useMemo(() => (viewing
    ? state.recordings.find((rec) => rec.id === viewing)?.name
      ?? flows.find((flow) => flow.id === viewing)?.name
      ?? 'Recording'
    : 'Recording'), [viewing, state.recordings, flows]);

  /* Play one recording now. A row is a one-step flow, which is why its repeat and speed are the step's - the
   * alternative was a second replay path that could disagree with the flow builder's. */
  const playOne = useCallback(async (rec: Recording) => {
    if (!health) { setNote('The agent is not running.'); return; }
    const settings = replayOf(rec);
    /* События - откуда бы они ни лежали. Запись, выложенную на аккаунт из-за нехватки места, надо забрать
     * прежде, чем играть: без этого повтор проиграл бы пустоту и отчитался об успехе. См. events-for.ts. */
    let events: RecordedEvent[];
    try {
      if (!eventsAreHere(rec)) setNote(`Fetching "${rec.name}" back from your account…`);
      events = await eventsFor(rec);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'those events could not be fetched');
      return;
    }
    const playing = { ...rec, events };
    try {
      /* Bring the application this was recorded in to the front first.
       *
       * A replay is coordinates and clicks: it has no idea what is under them. If the window has been
       * minimised, or something else is in front, every click lands on whatever happens to be there - and the
       * failure looks like the recording being wrong rather than the desktop having moved on.
       *
       * Best effort on purpose: a window that has since closed should not stop a replay the user asked for -
       * they may be about to open it. The message says what was tried.
       *
       * КАКОЕ ОКНО ПОДНЯТЬ - ТО, В КОТОРОМ ЗАПИСАНЫ КЛИКИ, а не первое, которое увидел сэмплер.
       *
       * Раньше здесь стояло `rec.windows[0]`, и это систематически было НЕ ТО ОКНО: запись начинают
       * кнопкой в MouseFlow, значит впереди в этот момент сам MouseFlow, значит первым в его списке стоит
       * он. Найдено прогоном: запись в Chrome, у которой windows[0] = {"title":"MouseFlow"}; повтор
       * поднимал MouseFlow и клацал в него - и перепривязка координат этого не спасала, потому что
       * развёрнутый MouseFlow накрывает окно Chrome, а клик достаётся тому, кто сверху.
       *
       * Заголовок берётся ТЕКУЩИЙ, а не записанный: у вкладки он меняется, а activate ищет по нему. */
      let open = await windows(port).then((it) => it.windows).catch(() => [] as AgentWindow[]);
      const want = whichWindow(playing.events);
      /* СВЁРНУТОЕ ОКНО - ЭТО ТО, КОТОРОЕ И НАДО ПОДНЯТЬ, и потому здесь evenMinimized. Найдено прогоном:
       * запись в терминале, терминал свернули - matchWindow отказывал, потому что у свёрнутого окна
       * прямоугольник условный, вызывающий откатывался на первое окно сэмплера (то есть на MouseFlow), и
       * клики уходили в чужое приложение. Прямоугольники ниже перечитываются ПОСЛЕ подъёма. */
      const named = want ? matchWindow(want, open, { evenMinimized: true }) : null;
      /* НЕ НАШЛИ НАЗВАННОЕ - НЕ ПОДМЕНЯЕМ ЕГО ЧУЖИМ. Откат на rec.windows[0] и был той самой ловушкой:
       * первое окно сэмплера - это MouseFlow, потому что запись начинают кнопкой в MouseFlow. Поднять СЕБЯ
       * хуже, чем не поднять ничего: развёрнутое окно приложения накрывает то, в которое надо клацать.
       *
       * Поэтому: клики назвали окно - поднимаем только его; клики не назвали ничего (бывает - все клики по
       * панели задач) - берём первое окно сэмплера, КРОМЕ нашего. */
      const ourWindow = (one: { title?: string } | undefined) => {
        const title = String(one?.title || '').trim();
        const own = document.title.trim();
        return !!title && !!own && (title.includes(own) || own.includes(title));
      };
      const sampled = want ? undefined : rec.windows?.find((one) => !ourWindow(one));
      const front = named || sampled || null;
      /* И СКАЗАТЬ, ЕСЛИ ОКНА НЕТ. Повтор всё равно играется - человек мог собираться его открыть, - но
       * молчаливый повтор по координатам в чужое окно и есть та поломка, о которой сообщили. */
      const missing = want && !named ? want.window : '';
      const title = front && 'title' in front ? front.title : undefined;
      const process = front && 'process' in front ? front.process : undefined;
      if (front && (title || process)) {
        try {
          await doAction(port, `action=activate ${process ? `process=${process} ` : ''}` +
            `${title ? `title=${title}` : ''}`.trim());
          // Windows takes a moment to actually raise it; clicking into a window still coming forward misses.
          await new Promise((done) => setTimeout(done, 350));
          /* И ПЕРЕЧИТАТЬ ОКНА ПОСЛЕ ПОДНЯТИЯ: свёрнутое окно до этого отдавало условный прямоугольник
           * 160x28, по которому пересчитывать нечего, - а восстановленное отдаёт настоящий. */
          open = await windows(port).then((it) => it.windows).catch(() => open);
        } catch (_) {
          setNote(`Could not bring ${title || process} to the front — replaying anyway.`);
        }
      }

      /* ПЕРЕПРИВЯЗКА К ОКНАМ, КАКИЕ ОНИ СЕЙЧАС.
       *
       * Записанная точка верна ровно до первого переезда окна: человек сдвинул его на другой монитор,
       * развернул, поменял разрешение - и клик уходит в пустоту или в соседнюю кнопку. Агент это умеет
       * лечить сам, прицеливаясь по имени контрола (Retarget в mouseflow-agent.ps1, Accessibility.aim в
       * .swift), но начинает он с ЗАПИСАННОЙ точки - а она после переезда лежит в чужом окне, где нужного
       * имени нет никогда. Поэтому здесь делается ровно то, чего ему не хватало: точка возвращается ВНУТРЬ
       * правильного окна, а до контрола её доводит он.
       *
       * Спрашивается один раз на повтор, а не на клик: /windows отдаёт весь список сразу. Не удалось
       * спросить - играем как записано; повтор, отказавшийся из-за неудачного запроса о окнах, был бы хуже
       * повтора по координатам. */
      let aimed = playing.events;
      let anchored = '';
      try {
        const put = reanchorAll(playing.events, open);
        aimed = put.events as RecordedEvent[];
        anchored = anchoredSaid(put.counts);
      } catch (_) {
        anchored = '';
      }

      await replay(port, flowBody(
        [{ recordingId: rec.id, repeat: settings.repeat, speed: settings.speed, delayAfterMs: 0 }],
        /* `playing`, а не `rec`: у записи, выложенной на аккаунт, `rec.events` пуст, и flowBody построил бы
         * тело повтора без единого события - агент отчитался бы о безупречном прогоне, не сделав ничего. */
        [{ ...playing, events: aimed }],
        { startDelayMs: state.startDelayMs, flowRepeat: 1, flowForever: settings.loop },
      ));
      setPlaying(rec.name);
      /* СКАЗАТЬ, ЧТО ИМЕННО СДЕЛАЛИ. Повтор, тихо сыгравший по записанным координатам, - это ровно та
       * хрупкость, которую перепривязка убирает; молчащий об этом отчёт оставляет человека выяснять её из
       * результата. Сколько кликов агент довёл до контролов по имени, скажет он сам, когда кончит. */
      setNote(`Replaying "${rec.name}" — press Escape to stop.${anchored ? ` ${anchored}` : ''}`
        + (missing ? ` The window these clicks were in — ${missing} — is not open, so nothing was raised.` : ''));
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'could not start the replay');
    }
  }, [health, port, state.startDelayMs]);

  /* Escape stops a replay. The pointer is not the user's while one runs, so the keyboard has to be enough -
   * this was the flow builder's, and it has to survive the flow builder. */
  useEffect(() => {
    if (!playing) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      void replayAbort(port).catch(() => {});
      setPlaying(null);
      setNote('Stopped.');
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [playing, port]);

  /* And a poll while it runs, so the page knows when it is over rather than claiming a replay forever. */
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(async () => {
      try {
        const status = await replayStatus(port);
        if (!status.playing) {
          setPlaying(null);
          /* ЧТО МАШИНА СДЕЛАЛА СВЕРХ ЗАПИСАННОГО, её же числами. Оба агента считают, сколько кликов они
           * довели до контрола по имени вместо записанной точки (retargeted), и сколько событий сыграть не
           * смогли - записанное нажатие клавиши агент не воспроизводит. Оба числа ехали на страницу с
           * 0.12.0 и не читались ни одним экраном: повтор, который перенаправил половину кликов, выглядел
           * точно так же, как повтор, где всё село на место. */
          const aimed = Number(status.retargeted) || 0;
          const skipped = Number(status.unplayable) || 0;
          /* И СКОЛЬКО КЛИКОВ ПО ПАНЕЛИ ЗАДАЧ СЫГРАНО КАК «ПОКАЗАТЬ ОКНО» (агент 0.27.0). Названо отдельно,
           * потому что это единственное место, где повтор сделал НЕ ТО, что записано, - намеренно. */
          const switched = Number(status.switched) || 0;
          setNote(`Finished "${playing}".`
            + (aimed ? ` The machine aimed ${aimed} click${aimed === 1 ? '' : 's'} at ${aimed === 1 ? 'its control' : 'their controls'} by name.` : '')
            + (switched ? ` ${switched} taskbar click${switched === 1 ? '' : 's'} ${switched === 1 ? 'was' : 'were'} played as "show that window" instead.` : '')
            + (skipped ? ` ${skipped} event${skipped === 1 ? '' : 's'} could not be played back.` : ''));
        }
      } catch (_) {
        // The agent went away mid-replay; the health poller will say so.
        setPlaying(null);
      }
    }, 700);
    return () => clearInterval(timer);
  }, [playing, port]);

  /* Which recording the wizard is open over. It replaced a window.prompt() for a name and a one-press
   * literal copy: the row has one skill button now, and it opens this - and so does Create skill in the
   * transcript panel, which used to make a skill of its own instead.
   *
   * GoalSkillSource, not Recording, because the second caller may not have one: a recording opened from a
   * session ledger is on the account and not in this browser. See openWizard below. */
  const [wizardFor, setWizardFor] = useState<GoalSkillSource | null>(null);

  /* Clicking the page closes the transcript - and "the page" means the parts of it that do nothing.
   *
   * NOT A BACKDROP, which is the obvious implementation and the wrong one here. This panel is deliberately
   * not modal: the comment where it is mounted says the page scrolls behind it, because the whole point is
   * looking at one recording without losing the list you found it in. A transparent sheet over the page
   * would take that away - the list would stop scrolling, and switching to another recording's transcript
   * would cost two clicks where it costs one now.
   *
   * So the test is what was clicked rather than where. Anything that does something on its own press is left
   * alone: a control, a link, and a ROW - a row unfolds when it is clicked, and a press that both unfolded a
   * row and closed the panel would read as the page having a mind of its own. What is left is background,
   * headings and whitespace, which is what was asked for.
   *
   * pointerdown, not click: a click that begins on the page and ends on the panel - a drag, a mis-aimed
   * press - should still count as a press on the page, and the panel should be gone before the mouse comes
   * up rather than after. Suspended while the wizard is open, because the wizard is opened FROM the panel
   * and cancelling it should put you back where you were rather than on the bare list. */
  useEffect(() => {
    if (!viewing || wizardFor) return;
    const away = (ev: PointerEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-transcript]')) return;
      if (target.closest('a,button,input,select,textarea,label,[role="checkbox"],[role="button"],[data-row]')) return;
      setViewing(null);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [viewing, wizardFor]);

  /* Open the wizard for a recording named by id, wherever that recording is.
   *
   * In the store when this browser holds it, which is the ordinary case and costs nothing. Pulled from the
   * account when it does not: a part of a long session is pushed up and never kept locally, and its
   * transcript is openable, so Create skill has to work there too. The panel's own builder used to do this
   * same read on the same press - the cost has not moved, only what it is spent on.
   *
   * `origins` and not payload.windows: the flow states where it ran in its own field, and the payload's
   * `windows` is the browser half's and is empty for a desktop recording. Only the titles are read. */
  const openWizard = useCallback(async (flowId: string, fallbackName: string) => {
    const here = state.recordings.find((rec) => rec.id === flowId);
    if (here) { setWizardFor(here); return; }
    setNote(null);
    try {
      const account = await pull();
      const flow = (account.flows ?? []).find((candidate) => candidate.id === flowId);
      if (!flow) throw new Error('this recording is no longer on your account');
      setWizardFor({
        id: flow.id,
        name: flow.name || fallbackName,
        created: flow.created ?? new Date().toISOString(),
        windows: (flow.origins ?? []).map((title) => ({ title, process: '' })),
      });
    } catch (err) {
      setNote(`No skill was started: ${err instanceof Error ? err.message : 'the account could not be read'}`);
    }
  }, [state.recordings]);

  const importFiles = useCallback(async (files: FileList) => {
    let added = 0;
    const made: Recording[] = [];
    for (const file of Array.from(files)) {
      const { events } = parseMacro(await file.text());
      if (!events.length) continue;
      const rec: Recording = {
        id: uid(),
        name: file.name.replace(/\.[^.]+$/, ''),
        created: new Date().toISOString(),
        events,
        /* Empty, and not recoverable: `.mmmacro` has five columns and comment lines. The #ctx comments come
         * back, so every click keeps the application and control it landed on - but the once-a-second window
         * SAMPLE was never in the file, and neither was what the agent could do when it recorded. The
         * transcript reads both absences correctly rather than guessing at them. */
        windows: [],
      };
      made.push(rec);
      update((prev) => ({ recordings: [...prev.recordings, rec] }));
      added++;
    }
    setNote(added ? `Imported ${added} recording${added === 1 ? '' : 's'}.` : 'Nothing in those files parsed.');

    /* And onto the account, which importing did not used to do.
     *
     * Export a recording, import it back, press View, and it offered to put it back on your account - the
     * right answer for a recording that WAS there and is not, and the wrong one for a recording that has
     * never been, where putting it there is simply the next step. Same helper as the stop path, because it is
     * the same operation: a recording that only exists in this browser has no transcript, and every screen
     * that reads one asks the account. */
    if (!made.length) return;
    const mine = claim(made.map((rec) => rec.id));
    try {
      /* ТОТ ЖЕ ПОТОЛОК, ЧТО И У ОСТАНОВКИ, и то же лезвие.
       *
       * Файл, выгруженный из записи, которая не влезла одной строкой, при импорте не влезет тоже - причина
       * в весе событий, а не в том, каким путём они пришли. Слишком большой файл становится обычными
       * записями «· part N» - в общем списке, безо всяких сессий. Оригинал в стор не попадает вовсе: его
       * события уезжают частями, а девять мегабайт, которые никогда не влезут одной строкой, отравляли бы
       * каждый батч синхронизации (штамп успеха ставится на батч целиком). */
      const singles: Recording[] = [];
      const split: { rec: Recording; recs: Recording[]; flows: ReturnType<typeof splitIntoRecordings>['flows'] }[] = [];
      for (const rec of made) {
        if (JSON.stringify(rec.events).length <= FIT_TARGET_BYTES) { singles.push(rec); continue; }
        const fit = splitIntoRecordings({ rec, events: rec.events, health });
        split.push({ rec, recs: fit.recs, flows: fit.flows });
      }
      const saved = await push({
        flows: [...singles.map((rec) => flowFor(rec, health)), ...split.flatMap((s) => s.flows)],
      });
      if (saved.problems.length) {
        setNote(`Imported ${added}, but the account refused ${saved.problems.length}: ${saved.problems.join('; ')}`);
      } else if (split.length) {
        update((prev) => ({
          recordings: [
            ...prev.recordings.filter((r) => !split.some((x) => x.rec.id === r.id)),
            ...split.flatMap((x) => x.recs.map((r) => ({
              ...r, events: [], eventsOnAccount: true, syncedAt: new Date().toISOString(),
            }))),
          ],
        }));
        setNote(`Imported ${added}. ${split.map((x) => `"${x.rec.name}" was too big for a single row and `
          + `is on your account as ${x.recs.length} recordings, “… · part N”`).join('; ')} — right here in `
          + 'the list, each with its own transcript.');
      }
      await reload();
    } catch (err) {
      setNote(`Imported ${added} into this browser, but syncing failed: ${
        err instanceof Error ? err.message : 'unknown error'
      }. View needs the recording on your account.`);
    } finally {
      release(mine);
    }
  }, [update, health, reload]);

  /* Put a recording back on the account.
   *
   * It is the same push that happens on stop - api/sync.js upserts and clears deleted_at - so this is not a
   * special recovery path, it is the ordinary save applied again. Worth having as a button because the
   * failure it fixes is invisible otherwise: a recording is deleted in Skills, where it looks like a skill,
   * and the only sign is that View stops working over here. */
  const restore = useCallback(async (id: string) => {
    const rec = state.recordings.find((r) => r.id === id);
    if (!rec) throw new Error('this browser no longer holds that recording, so there is nothing to put back');
    const mine = claim([rec.id]);
    try {
      /* СЛИШКОМ БОЛЬШАЯ ЕДЕТ ЧАСТЯМИ, а не отказом по второму разу.
       *
       * Живой случай: пять часов, 154 975 событий, аккаунт отвечает «unpacks to more than 7813KB» - и эта
       * кнопка повторяла ту же отправку и получала тот же ответ. Повторять то, что уже не сработало по
       * причине, которая не изменится, - это не «попробовать ещё раз», это отнимать время. Части получают
       * детерминированные id, поэтому второе нажатие перезапишет те же строки, а не удвоит пять часов. */
      const fits = JSON.stringify(rec.events).length <= FIT_TARGET_BYTES;
      if (fits) {
        const saved = await push({ flows: [flowFor(rec, health)] });
        if (saved.problems.length) throw new Error(saved.problems.join('; '));
      } else {
        const { recs, flows, bytes } = splitIntoRecordings({ rec, events: rec.events, health });
        const saved = await push({ flows });
        if (saved.problems.length) throw new Error(saved.problems.join('; '));
        /* Части - обычные записи в общем списке, оригинал уходит: его события теперь на аккаунте, а
         * девять мегабайт, которые никогда не влезут одной строкой, отравляли бы каждый батч
         * синхронизации. Панель открывает первую часть - пять часов работы видно сразу, а не после
         * поисков. */
        update((prev) => ({
          recordings: [
            ...prev.recordings.filter((r) => r.id !== rec.id),
            ...recs.map((r) => ({
              ...r, events: [], eventsOnAccount: true, syncedAt: new Date().toISOString(),
            })),
          ],
        }));
        setViewing(recs[0]?.id ?? null);
        setNote(`"${rec.name}" is ${(bytes / 1024 / 1024).toFixed(1)}MB of events — more than one row holds, `
          + `so it is on your account as ${recs.length} recordings, “${rec.name} · part 1…${recs.length}” — `
          + 'right here in the list, each with its own transcript.');
      }
      await reload();
    } finally {
      release(mine);
    }
  }, [state.recordings, health, reload, update]);

  /* Забрать осиротевшую запись в этот браузер — под ЕЁ id.
   *
   * `adoptRecording` существует для другого: скилл, взятый из Skills или из галереи, кладётся под
   * `from_<id>`, чтобы копия для проигрывания не путалась с оригиналом на аккаунте. Здесь копии нет - это та
   * же запись, и под новым id она осталась бы сиротой: строка аккаунта по-прежнему ни с чем не совпадает,
   * полоса не уходит, дашборд считает её дважды. На этом и попалось в браузере. */
  const adoptOrphan = useCallback(async (flow: Flow) => {
    if (state.recordings.some((rec) => rec.id === flow.id)) return;
    /* Догружается: список перестал везти события записей - см. payloadOf. Проверка «уже здесь» подняте
     * ВЫШЕ загрузки, потому что тащить два мегабайта ради того, чтобы выяснить, что они уже лежат в этом
     * браузере, - это ровно та трата, от которой уходим. */
    let payload;
    try {
      payload = await payloadOf(flow);
    } catch (_) {
      setNote(`"${flow.name}" could not be loaded from your account just now. Try again.`);
      return;
    }
    const events = payload?.events as RecordedEvent[] | undefined;
    if (!Array.isArray(events) || !events.length) {
      setNote(`"${flow.name}" has no events stored, so there is nothing to bring here.`);
      return;
    }
    update((prev) => ({
      recordings: [...prev.recordings, {
        id: flow.id,
        name: flow.name || 'From the account',
        created: flow.created ?? new Date().toISOString(),
        events,
        windows: (payload?.windows as { title: string; process: string }[] | undefined) ?? [],
      }],
    }));
  }, [state.recordings, update]);


  return (
    /* One column, not two: a row of a recording carries a name, three replay controls, a date and six
     * actions, and squeezing that into a 1fr column beside the recorder is what made it wrap to three lines
     * and push the page sideways. The recorder is small; it goes above. */
    <Page className="flex flex-col gap-4">
      {/* Above everything, because it is about something that is already waiting rather than about anything
        * on this page - and because the alternative was a person hunting through settings for a switch they
        * had no reason to know existed. Renders nothing at all unless a request is genuinely queued and this
        * computer is not taking work. */}
      <WaitingForThisMac
        health={health ?? null}
        port={state.port}
        onDone={(said) => setNote(said)}
      />

      {recorder && (
      <>
      {/* One component, one height, three states - see RecorderCard. The footer is what varies, and it is a
        * slot that always exists rather than three blocks that come and go, which is what made this card
        * change size every time capture started or stopped. */}
      <RecorderCard
        live={recording}
        screen={health?.screen ?? null}
        elapsedMs={live?.elapsedMs ?? 0}
        events={live?.count ?? 0}
        windows={seenWindows.current.length}
        onToggle={() => { if (recording) void end(); else void begin(); }}
        footer={
          note ? (
            <Typography variant="p" className="text-ink-secondary text-[0.85rem]">{note}</Typography>
          ) : health && health.canName !== true ? (
            /* Said BEFORE the recording rather than discovered in the transcript afterwards. An agent
              * without the resolver records perfectly good coordinates and nothing that says what they were
              * aimed at, and nine seconds of work is cheap to redo while nine minutes is not. */
            <Typography variant="p" className="text-fb-attention text-[0.85rem]">
              This agent does not read what you click on, so a recording will be coordinates only — no
              application, window or control names, and no typing. Restart it with the command behind the
              agent chip above.
            </Typography>
          ) : health?.canKeys === false ? (
            /* A narrower case: the agent is current but Windows refused the keyboard hook. Everything else
              * records; only the typing does not, and a transcript that said "nothing was typed" would then
              * be wrong rather than empty. */
            <Typography variant="p" className="text-fb-attention text-[0.85rem]">
              This agent could not install its keyboard hook, so time spent typing will be missing from the
              transcript — it will look like a pause. Everything else records normally.
            </Typography>
          ) : (
            /* One line at this width, and the session control on the same line.
              *
              * The caption carried an 86ch measure, which is right for running prose and wrong for a caption
              * in a status card - the card is 1424px and the sentence was capped at a third of it, so it
              * wrapped to three lines of small print. The long form of all of this is in the transcript's own
              * `captured` line, where somebody reading a recording actually meets it.
              *
              * The chooser lives in this slot deliberately: it is the slot that exists so the card cannot
              * change height, and a control that appears above the caption when idle and vanishes when
              * recording would undo exactly that. Idle shows the choice; a running session shows its
              * readout; one slot, one height. */
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Typography variant="p" className="min-w-0 flex-1 text-ink-inactive text-[0.85rem]">
                {/* «Куда это уезжает» - вслух, здесь, а не только в документе.
                  *
                  * docs/product/17-privacy-security.md утверждал, что страница Record говорит это в
                  * интерфейсе, и подавал это как позицию продукта - не оставлять такое на самостоятельное
                  * открытие. Предложение существовало только комментарием в коде. Документ описывал
                  * намерение, а читался как описание того, что человек увидит. */}
                {recording
                  ? 'Capturing every click, drag, scroll and keystroke — press stop when the task is done.'
                  : 'Captures every click, drag and scroll, with the application, window and control each '
                    + 'one landed on. Typing is timed, never read. When you stop, all of that — including '
                    + 'window titles and control names — is saved to your account.'}
              </Typography>

              {recording ? null : health?.canDrain === true ? (
                /* Одна строка вместо выбора «резать каждые 30/60 минут». Выбор требовал знать ДО старта,
                 * что запись выйдет длинной, - пять часов, записанные обычной записью, показали, что этого
                 * не знает никто. Теперь решает размер: дошли до лимита - отрезали в обычную запись, таймер
                 * с нуля, запись продолжается. Сообщать тут нечего, кроме того, что можно не думать. */
                <span className="shrink-0 text-[0.8rem] text-ink-inactive">
                  Cuts itself into ordinary recordings when full — it can run all day.
                </span>
              ) : (
                /* Said rather than hidden. An agent older than 0.8.0 has no way to hand over events without
                  * stopping - its recording is split when you stop instead. */
                <span className="shrink-0 text-[0.8rem] text-ink-inactive">
                  {health
                    ? 'This agent hands events over only on stop — a recording too big for one row is split then.'
                    : ''}
                </span>
              )}
            </div>
          )
        }
      />

      {/* What the last reconciliation did, when it did anything.
        *
        * Recordings appearing needs no announcement. Recordings DISAPPEARING does: they were deleted on
        * another machine, and somebody who does not know that will think this one lost them. Shown once, for
        * the reconciliation that just happened rather than forever. */}
      {state.lastSync && Date.now() - Date.parse(state.lastSync.at) < 60_000
        && (state.lastSync.pulled || state.lastSync.forgotten || state.lastSync.pushed) > 0 && (
        <Typography variant="p" className="text-ink-inactive text-[0.84rem]">
          {/* Assembled from the parts that happened, rather than glued together with commas and hope: the
            * dash belonged to the first clause, and when the first clause did not happen the sentence began
            * with a comma. */}
          {[
            'Synced with your account',
            [
              state.lastSync.pulled ? `${state.lastSync.pulled} brought here` : '',
              state.lastSync.pushed ? `${state.lastSync.pushed} sent up` : '',
              state.lastSync.forgotten
                ? `${state.lastSync.forgotten} removed because another device deleted ${
                  state.lastSync.forgotten === 1 ? 'it' : 'them'}`
                : '',
            ].filter(Boolean).join(', '),
          ].filter(Boolean).join(' — ')}
          {/* WHAT THE 3MB ACTUALLY IS, because this sentence named the wrong thing and a person acts on
            * it. It said "this browser holds about 3MB of recordings" — a capacity, next to a number that
            * is a DOWNLOAD BUDGET FOR ONE PASS. `spent` in reconcile() starts at zero every pass and never
            * counts what the browser already holds (rows already here `continue` before the size is
            * charged), so a browser holding 20MB is not full and told nothing of the sort.
            *
            * The difference is what somebody does next. Told the browser is full, they go and delete
            * recordings to make room. Told the rest arrive on the next sync, they wait — which is correct,
            * because a deferred row is deferred by exactly ONE pass: measured against a 400KB row and a
            * 3.3MB row, pass one pulled the first and pass two the second. The `Bring it here` button only
            * ever did sooner what the next pass would have done anyway. */}
          {state.lastSync.left
            ? `. ${state.lastSync.left} older ${state.lastSync.left === 1 ? 'one' : 'ones'} stayed for the `
              + 'next sync — about 3MB comes down at a time. The transcript reads them from your account '
              + 'meanwhile, so nothing is waiting on them.'
            : '.'}
        </Typography>
      )}

      {/* ЧТО СЛУЧИЛОСЬ С ДИСКОМ, если случилось - и раньше об этом не говорилось ничего.
        *
        * Консоль пишется одной строкой на весь браузер, и четырёхчасовая запись в неё не помещается. Раньше
        * это был пустой catch: запись оставалась в памяти, на диск не попадала, и человек узнавал об этом,
        * перезагрузив вкладку и не найдя своих записей. Хуже: строка одна, так что одна непомещающаяся
        * запись роняла запись и всего остального - штампов, квитанций, других записей той же сессии.
        *
        * Две разные беды и два разных предложения. Ни одно не извиняется и ни одно не говорит «потеряно»
        * про то, что лежит на аккаунте. */}
      {trouble?.kind === 'no-storage' && (
        <Typography variant="p" className="text-ink-inactive text-[0.84rem]">
          This browser is not letting anything be saved to disk — private browsing, or storage turned off for
          this site. Recordings still work and still go to your account; this tab just will not remember them
          after a reload.
        </Typography>
      )}
      {trouble?.kind === 'too-big' && (
        <Typography variant="p" className="text-ink-inactive text-[0.84rem]">
          {trouble.stillFailing
            ? 'There is no room left in this browser and nothing could be written to disk, so this session '
              + `is being held in memory only.${trouble.atRisk.length
                ? ` ${trouble.atRisk.length} recording${trouble.atRisk.length === 1 ? '' : 's'} `
                  + `${trouble.atRisk.length === 1 ? 'has' : 'have'} not reached your account yet — do not `
                  + 'close this tab until they do.'
                : ' Everything here is already on your account, so nothing is at risk of being lost.'}`
            : `${trouble.freed.length} recording${trouble.freed.length === 1 ? '' : 's'} `
              + `${trouble.freed.length === 1 ? 'is' : 'are'} now kept on your account rather than in this `
              + 'browser — there was no room here. Nothing was lost: playing or exporting one fetches it '
              + 'back from your account first.'}
        </Typography>
      )}

      </>
      )}

      <RecordingsTable
        viewing={viewing}
        /* Answered here because this is the half that can see the account. Save as skill writes a separate
         * row under `dr_<id>`, so the question is whether that row exists - not whether the recording
         * carries a flag, which it does not and should not: two objects, two lifetimes. */
        hasSkill={(rec) => hasSkillFor(flows, rec.id)}
        /* Recordings the account has and this browser does not - the leftovers of a delete that never
         * propagated, plus anything recorded on another machine. Only ROLE-recording rows, or unstamped ones
         * that are not skills: a skill on the account is not a missing recording. */
        orphans={flows.filter((flow) => (
          flow.kind === 'recorded'
          && roleOf(flow) !== SKILL_ROLE
          && !flow.id.startsWith('dr_')
          && !state.recordings.some((rec) => rec.id === flow.id)
        ))}
        onAdopt={(flow) => { void adoptOrphan(flow); }}
        onImport={(files) => { void importFiles(files); }}
        /* Over on the Skills page, not here.
         *
         * The wizard makes a SKILL, and the place skills live is where somebody expects to end up holding
         * one — opening it over the recordings list left people on Record with a new skill they could not
         * see, and the only sign it had worked was a toast. The recording travels as an id in the address,
         * so the page can be reloaded, linked and gone back from. */
        onMakeSkill={(rec) => {
          void navigate({ to: '/skills', search: { make: rec.id } as never });
        }}
        onView={(rec) => setViewing((open) => (open === rec.id ? null : rec.id))}
        onPlay={(rec) => { void playOne(rec); }}
      />

      {/* The transcript, beside the list rather than inside a row: it is long, and a row that expands to
        * three hundred lines stops being a row. Same shape as the dashboard's assistant panel - fixed to the
        * right, the page scrolls behind it - because they are the same gesture, looking at one thing in
        * detail without losing the list you found it in.
        *
        * data-transcript is what the click-away effect above looks for: a press inside here is not a press
        * on the page, and the panel is a lot of surface to get that wrong about. */}
      {viewing && (
        <aside
          data-transcript=""
          className="fixed inset-y-0 right-0 z-40 flex w-[34rem] max-w-full flex-col border-stroke border-l bg-surface-card2 shadow-dropdown"
        >
          <TranscriptPanel
            flowId={viewing}
            name={viewingName}
            /* Offered only when this browser actually holds the events. Without them there is nothing to put
             * back, and a button that cannot work is worse than the plain 404. */
            onRestore={state.recordings.some((rec) => rec.id === viewing)
              ? () => restore(viewing)
              : undefined}
            onAnalyze={() => {
              askAbout(viewing, viewingName);
              void navigate({ to: '/dashboard' });
            }}
            /* Тот же переход, другая просьба - см. ask-about.ts: намерение едет вместе с записью, иначе
               вторая кнопка была бы первой с другой надписью. */
            onDocument={() => {
              askAbout(viewing, viewingName, 'document');
              void navigate({ to: '/dashboard' });
            }}
            /* One flow, and it is the same one the row's skill button opens. */
            onMakeSkill={() => openWizard(viewing, viewingName)}
            onClose={() => setViewing(null)}
            onRemoved={() => {
              /* Removed on the account, so it goes from the browser too - otherwise the row stays, View
               * answers 404, and the only way back is a reload. */
              update((prev) => ({ recordings: prev.recordings.filter((rec) => rec.id !== viewing) }));
              setViewing(null);
              void reload();
            }}
          />
        </aside>
      )}

      {wizardFor && (
        <SkillWizard
          rec={wizardFor}
          onClose={() => setWizardFor(null)}
          onSaved={(made) => {
            setWizardFor(null);
            /* And the transcript with it, when that is where this started. The note below is on the page,
               and the panel covers the page - so leaving it open means saving a skill and being shown the
               same transcript with nothing said about it. Harmless from a row, where nothing is open. */
            setViewing(null);
            void reload();
            setNote(`"${made}" is a skill now — it asks for what it needs and types it. `
              + 'The recording is untouched.');
          }}
        />
      )}
    </Page>
  );
};
