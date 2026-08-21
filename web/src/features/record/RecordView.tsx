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
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import {
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
import { type Flow, push } from '@/lib/api';
import { askAbout } from '@/features/chat/ask-about';
import { SKILL_ROLE, roleOf } from '@/lib/flow-role';
import { flowBody, fmtMs, parseMacro, summarize } from '@/lib/macro';
import {
  type RecordedEvent, type Recording, refreshAgent, uid, useAgent, useConsole,
} from '@/lib/store';
import { useAccount } from '@/shell/AccountProvider';
import { hasSkillFor, saveAsSkill } from './save-as-skill';
import { RecordingsTable, replayOf } from './RecordingsTable';
import { SessionStrip } from './SessionStrip';
import {
  CHUNK_CHOICES, type ChunkMinutes, EVENTS_MAX_PER_PART, LONG_MOVE_MS, PENDING_MAX_EVENTS, type Session,
  ledgerEntry, partFlow, partHeader, partName, sessionOf, shouldCut,
} from './long-session';
import { TranscriptPanel } from './TranscriptPanel';
import { flowFor } from './flow-for';

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
          {live
            ? <Square className="size-7 fill-current text-white" />
            : <Play className="size-7 fill-current text-white ps-1" />}
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

export const RecordView = () => {
  const [state, update] = useConsole();
  const { health } = useAgent();
  const { reload, flows } = useAccount();
  const navigate = useNavigate();

  const [live, setLive] = useState<{ count: number; elapsedMs: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The name of the recording being replayed, or null. Drives Escape and the status poll. */
  const [playing, setPlaying] = useState<string | null>(null);
  const seenWindows = useRef<{ title: string; process: string }[]>([]);

  /* A long session, while one is running, and the parts that have not reached the account yet.
   *
   * The ledger is in the store, because it has to survive a reload - a session is hours long and a browser
   * that was refreshed halfway must still show what it recorded. The unsent parts are NOT in the store: they
   * carry events, and events in localStorage is the thing the whole mechanism exists to avoid. So a reload
   * loses an unsent part, and the ledger says so rather than pretending it arrived. */
  const [session, setSession] = useState<Session | null>(null);
  const pending = useRef<{ part: ReturnType<typeof ledgerEntry>; name: string; events: RecordedEvent[]; windows: { title: string; process: string }[] }[]>([]);
  /** Chosen before the recording starts; it cannot change while one is running. */
  const [everyMinutes, setEveryMinutes] = useState<ChunkMinutes | null>(null);
  /** The session clock at the last cut, so "how long since" is asked of the agent rather than of wall time. */
  const lastCutAt = useRef(0);
  /** One cut at a time. The poller runs four times a second and a drain is not instant. */
  const cutting = useRef(false);
  /** Earliest moment collectHeld may try the account again - see the pacing note inside it. */
  const retryAt = useRef(0);
  /* What the poller needs, held where its dependencies cannot reach.
   *
   * The effect below is keyed on WHETHER a recording is live and nothing else - there is a paragraph on it
   * there, because it once depended on the object it was itself rewriting four times a second, rebuilt both
   * intervals every tick, and the one-second window sampler never lived to its first tick. Adding `session`,
   * `cut` and `end` to those dependencies would bring the same illness back more slowly: `end` changes
   * identity with every recording made, `cut` with every account reload. So they travel by ref, like
   * everything else that effect only writes. It also settles the ordering question - `end` is declared below
   * the effect and cannot be named from inside it. */
  const sessionNow = useRef<Session | null>(null);
  const cutNow = useRef<((why: 'clock' | 'size' | 'stop', current: Session) => Promise<{ session: Session; note: string | null; stop: boolean }>) | null>(null);
  const endNow = useRef<(() => Promise<void>) | null>(null);

  const port = state.port;

  const begin = useCallback(async () => {
    if (!health) {
      void navigate({ to: '/connect' });
      setNote('The agent is not running yet — here is how to start it.');
      return;
    }
    if (health.recording) { setNote('Already recording.'); return; }
    /* `pending` can now hold the ONLY copy of a collected recording - a held tail whose agent-side spill
     * was already taken and whose push has not landed yet. Wiping it below would silently destroy the exact
     * thing "Stop and Save" promised to keep, so starting waits until the retry gets it onto the account. */
    if (pending.current.length) {
      setNote('Parts of the last session are still on their way to the account — retrying. '
        + 'Wait a moment, then press Record again.');
      return;
    }
    try {
      /* A long session thins the pointer path, and that is not a preference - it is what makes the parts fit.
       * See long-session.ts: movement is 93.75% of the events and 88.6% of the bytes, and at the agent's
       * 10ms default a half-hour chunk is several times the size the account accepts. */
      const long = everyMinutes !== null && health.canDrain === true;
      await recordStart(port, long ? LONG_MOVE_MS : undefined);
      seenWindows.current = [];
      pending.current = [];
      lastCutAt.current = 0;
      setSession(long && everyMinutes
        ? {
          id: `ses_${uid()}`,
          startedAt: new Date().toISOString(),
          endedAt: null,
          everyMinutes,
          moveMs: LONG_MOVE_MS,
          parts: [],
        }
        : null);
      setLive({ count: 0, elapsedMs: 0 });
      setNote(long
        ? `Recording as a session — a part is written every ${everyMinutes} minutes, so this can run all day.`
        : null);
      refreshAgent();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'could not start recording');
    }
  }, [everyMinutes, health, navigate, port]);

  /* Cut one part off a running session.
   *
   * The order matters and is the opposite of tempting: the events are taken from the agent FIRST and the
   * account is asked SECOND. Draining is the irreversible half - once the agent has handed them over they
   * exist nowhere else - so a failed push keeps the part in memory and retries, rather than a failed push
   * meaning the drain never happened. */
  const cut = useCallback(async (why: 'clock' | 'size' | 'stop', current: Session) => {
    const text = why === 'stop' ? await recordStop(port) : await recordDrain(port);
    const { events } = parseMacro(text);
    const head = partHeader(text);
    /* The agent's own part number, and the ledger's length as the fallback: an agent that does not write the
     * `#part` line still produces countable parts. */
    const n = head.n ?? current.parts.length + 1;
    const atMs = head.elapsedMs ?? 0;

    /* The windows seen DURING this part, not since the session began. A part is a slice of time and its
     * window list should describe that slice - otherwise part sixteen claims every application of the day. */
    const where = seenWindows.current.slice();
    seenWindows.current = [];
    lastCutAt.current = atMs;

    if (!events.length) {
      /* Half an hour with nothing in it is a real answer - the machine was idle - and writing an empty row
       * for it would put a recording of nothing on the account every half hour. */
      return { session: current, note: null as string | null, stop: false };
    }

    const id = uid();
    const name = partName({ windows: where, n, startedAt: current.startedAt });
    const entry = ledgerEntry({ id, n, name, events, atMs, onAccount: false });

    /* Everything not yet delivered, oldest first, so a part that failed an hour ago is not overtaken by the
     * one just cut. */
    pending.current.push({ part: entry, name, events, windows: where });

    let sent: string[] = [];
    let problem: string | null = null;
    try {
      const flows = pending.current.map((p) => partFlow({
        part: p.part, session: current, name: p.name, events: p.events, windows: p.windows, health,
      }));
      const saved = await push({ flows });
      if (saved.problems.length) problem = saved.problems.join('; ');
      else sent = pending.current.map((p) => p.part.id);
      if (sent.length) pending.current = [];
      await reload();
    } catch (err) {
      problem = err instanceof Error ? err.message : 'the account could not be reached';
    }

    const delivered = new Set(sent);
    const parts = [...current.parts, entry].map((p) => (
      delivered.has(p.id) ? { ...p, onAccount: true } : p
    ));
    const next = { ...current, parts };

    const waitingEvents = pending.current.reduce((sum, p) => sum + p.events.length, 0);
    /* Past this the session stops rather than holding a whole shift in memory - which is the thing being
     * avoided. Said as what it is, with the count, because the parts are still recoverable until the tab
     * closes. */
    const tooMuch = waitingEvents > PENDING_MAX_EVENTS;

    return {
      session: next,
      note: problem
        ? `Part ${n} is recorded but has not reached your account (${problem}). It will be retried with the next part.${
          tooMuch ? ' Stopping the session — too much is waiting to be sent.' : ''}`
        : `Part ${n} saved — ${events.length} events${where.length ? ` in ${where.length} window${where.length === 1 ? '' : 's'}` : ''}.`,
      stop: tooMuch,
    };
  }, [health, port, reload]);

  /* Two pollers while recording, at different cadences on purpose: the counter should feel live, and the
   * window list needs one sample a second at most - an application you passed through for half a second is
   * not what the flow is about.
   *
   * Keyed on WHETHER a recording is live, never on the live object. The counter below calls setLive() with a
   * fresh object every 250ms, so an effect depending on `live` tore itself down and rebuilt both intervals
   * four times a second - and the 1000ms sampler never reached its first tick. Every desktop recording came
   * out with payload.windows empty and a transcript saying "No window was recorded", which is why this is
   * worth a paragraph: the bug was invisible in the thing it broke. Nothing here reads the object, only
   * writes it, so the dependency was inherited rather than needed. */
  const capturing = live !== null;
  useEffect(() => {
    if (!capturing) return;

    const counter = setInterval(async () => {
      try {
        const s = await recordStatus(port);
        if (!s.recording && (s.count > 0 || sessionNow.current)) {
          /* The agent ended this recording itself - the macOS menu bar's "Stop and Save" - and HOLDS the
           * events: recording:false with count>0 is a state a stop from this page never leaves behind.
           * Collected through the same door as the Stop button, so it lands on the account identically,
           * without the user ever bringing this tab forward. A running SESSION goes through the same door
           * even when the count is zero: an empty tail is a real answer, but "the session finished" still
           * has to be said and its pending parts still have to be flushed. end() carries its own mutex. */
          if (endNow.current) await endNow.current();
          return;
        }
        setLive({ count: s.count, elapsedMs: s.elapsedMs });
        if (!s.recording) setLive(null);

        /* The cut rides the poller that is already asking. `count` is the agent's buffer - what is in THIS
         * part - and `elapsedMs` is the session clock, so "how long since the last cut" is a subtraction
         * rather than a second timer that could drift away from the recording it is timing.
         *
         * The guard is a ref, not state: this runs four times a second, a drain takes longer than that, and
         * two overlapping drains would hand the same events to two parts. */
        const running = sessionNow.current;
        if (running && !cutting.current && cutNow.current) {
          const why = shouldCut({
            sinceLastCutMs: s.elapsedMs - lastCutAt.current,
            eventsBuffered: s.count,
            everyMinutes: running.everyMinutes,
          });
          if (why) {
            let mustStop = false;
            let after: Session | null = null;
            cutting.current = true;
            try {
              const out = await cutNow.current(why, running);
              setSession(out.session);
              if (out.note) setNote(out.note);
              mustStop = out.stop;
              after = out.session;
            } finally {
              cutting.current = false;
            }
            /* Too much waiting to be sent: stop rather than hold a whole shift in memory. The stop takes
             * the tail with it, so nothing recorded so far is lost by stopping. AFTER the mutex is
             * released, because end() takes the same one - held across this call, the emergency stop was a
             * silent no-op and the session it existed to end recorded on. And the ref is flushed BY HAND
             * first: setSession only reaches sessionNow at the next React commit, which cannot happen
             * before this same-task call - end() would cut against the pre-cut session and drop the part
             * just written from the ledger, orphaning its row on the account. */
            if (mustStop && endNow.current) {
              if (after) sessionNow.current = after;
              await endNow.current();
            }
          }
        }
      } catch (_) {
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
  }, [capturing, port]);

  const end = useCallback(async () => {
    /* One mutex for every door into stopping: the Stop button, the poller's collect of an agent-side stop,
     * and the mounted held-check below. Two concurrent stops meant two recordStop calls - the loser took an
     * empty body, said "Nothing was captured." over the winner's note, and in a session could commit a
     * ledger missing the tail part the winner had just pushed. */
    if (cutting.current) return;
    cutting.current = true;
    try {
    /* A session ends by cutting its tail, not by making a recording out of it.
     *
     * What /record/stop returns during a session is only what happened since the last cut - everything
     * before it has already been handed over - so treating it as a whole recording would leave sixteen parts
     * plus one row that looks like a seventeenth and behaves like something else. */
    const running = sessionNow.current;
    if (running) {
      try {
        const out = await cut('stop', running);
        const done = { ...out.session, endedAt: new Date().toISOString() };
        setSession(null);
        setLive(null);
        update((prev) => ({
          sessions: [...(prev.sessions as Session[]).filter((x) => x.id !== done.id), done],
        }));
        const totals = done.parts.reduce((n, p) => n + p.events, 0);
        const waiting = done.parts.filter((p) => !p.onAccount).length;
        setNote(done.parts.length
          ? `Session finished — ${done.parts.length} part${done.parts.length === 1 ? '' : 's'}, ${totals} events.${
            waiting ? ` ${waiting} could not be sent and is only in this tab.` : ''}`
          : 'Session finished, and nothing was captured in it.');
      } catch (err) {
        setLive(null);
        setSession(null);
        setNote(err instanceof Error ? err.message : 'could not stop the session');
      }
      return;
    }

    try {
      const text = await recordStop(port);
      setLive(null);
      const { events } = parseMacro(text);
      if (!events.length) { setNote('Nothing was captured.'); return; }

      const where = seenWindows.current.slice();
      const s = summarize(events);
      /* Named by WHEN: "MouseFlow 21/08 13:07" reads as a moment, sorts like one, and two recordings made
       * a minute apart stay tellable-apart - which "Recording 3" and a window title both failed at. */
      const at = new Date();
      const two = (v: number) => String(v).padStart(2, '0');
      const name = `MouseFlow ${two(at.getDate())}/${two(at.getMonth() + 1)} ${
        two(at.getHours())}:${two(at.getMinutes())}`;

      const made = { id: uid(), name, created: new Date().toISOString(), events, windows: where };
      update((prev) => ({ recordings: [...prev.recordings, made] }));
      setNote(`${s.count} events captured (${fmtMs(s.durationMs)})${
        where.length ? ` in ${where.length} window${where.length === 1 ? '' : 's'}` : ''
      }`);

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
      try {
        const saved = await push({ flows: [flowFor(made, health)] });
        if (saved.problems.length) {
          setNote(`Captured, but the account refused it: ${saved.problems.join('; ')}`);
        } else {
          /* Stamped only on a clean push, because the stamp is a fact about the ACCOUNT: it is what later
           * separates "this exists only here, send it" from "this was deleted on another machine, drop it".
           * Setting it hopefully would make the second reconciliation delete a recording that never
           * arrived. */
          update((prev) => ({
            recordings: prev.recordings.map((rec) => (
              rec.id === made.id ? { ...rec, syncedAt: new Date().toISOString() } : rec
            )),
          }));
        }
        await reload();
      } catch (err) {
        setNote(`Captured ${s.count} events, but syncing failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }. The transcript needs the recording on your account.`);
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
  }, [port, state.recordings.length, update, cut, health]);

  /* The refs the poller reads, pointed at this render's functions. In an effect rather than inline, so a
   * render that is thrown away cannot leave a ref aimed at a closure that never committed. */
  useEffect(() => {
    sessionNow.current = session;
    cutNow.current = cut;
    endNow.current = end;
  }, [session, cut, end]);

  /* A recording the agent ended while this page was away - the menu bar's "Stop and Save" with the tab
   * closed or elsewhere - is still HELD by the agent (spilled to its disk, so even an agent restart keeps
   * it), and /record/start answers 409 until somebody takes delivery.
   *
   * A SESSION's held tail is filed into its session, never as a standalone recording: the ledger row with
   * endedAt:null is the session it belongs to, the tail is pushed as that session's final parts - sliced
   * under the payload cap, which is the entire reason sessions exist - and the row is finally stamped
   * ended. Without the slicing, an overnight tail would be one giant push the account refuses. A dangling
   * session with nothing held is stamped too: "still running" would otherwise be pinned on this page
   * forever. Plain recordings go through end(), the same door as the Stop button. */
  const collectHeld = useCallback(async () => {
    if (cutting.current) return;
    /* Paced by a timestamp, not by the effect: a failed push below calls update(), update() remakes
     * state.sessions, that remakes this callback, and the effect re-runs it AT ONCE - an unpaced hot loop
     * hammering an account that may be down precisely because it is overloaded. The stamp makes every
     * retry wait its three seconds no matter how many times the effect fires. */
    if (Date.now() < retryAt.current) return;
    let s;
    try { s = await recordStatus(port); } catch { return; }
    if (s.recording) return;
    /* The NEWEST dangling session, not the first: a row orphaned by an old crash must not swallow a tail
     * that belongs to yesterday evening's session. */
    const dangling = ((state.sessions as Session[] | undefined) ?? [])
      .filter((x) => !x.endedAt)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
    if (s.count > 0 && !dangling) {
      if (endNow.current) await endNow.current();
      return;
    }
    if (!dangling) return;
    cutting.current = true;
    try {
      let sess = dangling;

      /* Taking delivery is irreversible - the agent deletes its spill - so the events are staged into
       * `pending` BEFORE the account is asked, exactly the order cut() documents: a failed push keeps the
       * part in memory and retries on the next tick, rather than a failed push meaning the delivery never
       * happened. The ledger rows are written at once (onAccount:false) so retries never duplicate them. */
      if (s.count > 0) {
        const text = await recordStop(port);
        const { events } = parseMacro(text);
        const head = partHeader(text);
        if (events.length) {
          let n = head.n ?? sess.parts.length + 1;
          const atMs = head.elapsedMs ?? s.elapsedMs
            ?? sess.parts.reduce((m, p) => Math.max(m, p.atMs), 0);
          for (let i = 0; i < events.length; i += EVENTS_MAX_PER_PART) {
            const slice = events.slice(i, i + EVENTS_MAX_PER_PART);
            const name = partName({ windows: [], n, startedAt: sess.startedAt });
            const entry = ledgerEntry({ id: uid(), n, name, events: slice, atMs, onAccount: false });
            pending.current.push({ part: entry, name, events: slice, windows: [] });
            sess = { ...sess, parts: [...sess.parts, entry] };
            n += 1;
          }
        }
      }

      /* Everything waiting - the tail just taken AND any parts an earlier cut failed to send - in one push.
       * The session is stamped finished only when nothing is left waiting; until then it stays honestly
       * open and this same check retries every few seconds. */
      let problem: string | null = null;
      let flipped = false;
      if (pending.current.length) {
        try {
          const flows = pending.current.map((p) => partFlow({
            part: p.part, session: sess, name: p.name, events: p.events, windows: p.windows, health,
          }));
          const saved = await push({ flows });
          if (saved.problems.length) {
            problem = saved.problems.join('; ');
          } else {
            const sent = new Set(pending.current.map((p) => p.part.id));
            pending.current = [];
            sess = { ...sess, parts: sess.parts.map((p) => (sent.has(p.id) ? { ...p, onAccount: true } : p)) };
            flipped = true;
          }
        } catch (err) {
          problem = err instanceof Error ? err.message : 'the account could not be reached';
        }
      }
      const finished = problem === null;
      retryAt.current = finished ? 0 : Date.now() + 3000;
      /* The store is written when something material changed - new ledger entries, a delivery, the stamp.
       * A retry that failed AGAIN changed nothing, and writing an identical session with a fresh identity
       * would both churn localStorage and re-arm the effect that calls this. */
      const staged = sess !== dangling;
      if (!staged && !flipped && !finished) return;
      const done = finished ? { ...sess, endedAt: new Date().toISOString() } : sess;
      update((prev) => ({
        sessions: [...((prev.sessions as Session[]) ?? []).filter((x) => x.id !== done.id), done],
      }));
      setNote(finished
        ? `A session stopped at the agent was collected — ${done.parts.length} part${
          done.parts.length === 1 ? '' : 's'} on the account.`
        : `Collected from the agent, but the account did not take it: ${problem}. Kept here — retrying.`);
      if (finished) await reload();
    } finally {
      cutting.current = false;
    }
  }, [port, state.sessions, health, update, reload]);

  /* Checked every few seconds while this page is open and nothing is live here - not only on the agent's
   * first appearance, because a held recording can arrive at any moment (the poller dies with its own
   * error handling, the agent restarts, the menu is pressed while this page shows idle). The check is one
   * status read; collection is guarded by the same mutex as every other stop. */
  const agentUp = health != null;
  useEffect(() => {
    if (!agentUp || capturing) return;
    void collectHeld();
    const check = setInterval(() => { void collectHeld(); }, 3000);
    return () => clearInterval(check);
  }, [agentUp, capturing, collectHeld]);

  /* The ledger, kept in the store on every change rather than at the end.
   *
   * A session runs for hours. A browser reloaded in the middle of one must still show the parts it already
   * wrote - they are on the account, and a receipt that only appears when the session ends would make eight
   * hours of recording look like nothing until the moment it finished. */
  useEffect(() => {
    if (!session) return;
    update((prev) => ({
      sessions: [
        ...(prev.sessions as Session[]).filter((s) => s.id !== session.id),
        session,
      ],
    }));
  }, [session, update]);

  /* Remove a session: its parts off the account, then the receipt.
   *
   * That order, because the reverse loses the only list of what to delete. If the tombstones fail the ledger
   * stays and the row can be pressed again - which is recoverable - whereas a ledger dropped first would
   * leave sixteen rows on the account that nothing on this page knows how to name. */
  const forgetSession = useCallback(async (gone: Session) => {
    const ids = gone.parts.filter((p) => p.onAccount).map((p) => p.id);
    try {
      if (ids.length) {
        const saved = await push({ deleted: ids });
        if (saved.problems.length) throw new Error(saved.problems.join('; '));
        await reload();
      }
      update((prev) => ({
        sessions: (prev.sessions as Session[]).filter((x) => x.id !== gone.id),
      }));
      setNote(`Session removed — ${ids.length} part${ids.length === 1 ? '' : 's'} deleted from your account.`);
    } catch (err) {
      setNote(`The session is still on your account: ${
        err instanceof Error ? err.message : 'the account could not be reached'}`);
    }
  }, [reload, update]);

  /* Which recording's transcript is open. One at a time, and owned here rather than in the table, because the
   * panel is a sibling of the whole page rather than of a row. */
  const [viewing, setViewing] = useState<string | null>(null);

  /* Play one recording now. A row is a one-step flow, which is why its repeat and speed are the step's - the
   * alternative was a second replay path that could disagree with the flow builder's. */
  const playOne = useCallback(async (rec: Recording) => {
    if (!health) { setNote('The agent is not running.'); return; }
    const settings = replayOf(rec);
    try {
      /* Bring the application this was recorded in to the front first.
       *
       * A replay is coordinates and clicks: it has no idea what is under them. If the window has been
       * minimised, or something else is in front, every click lands on whatever happens to be there - and the
       * failure looks like the recording being wrong rather than the desktop having moved on. The recorder
       * already noted which applications were in front (this page samples the foreground window every
       * second), so the first one is where this recording belongs.
       *
       * Best effort on purpose: a window that has since closed should not stop a replay the user asked for -
       * they may be about to open it. The message says what was tried.
       */
      const front = rec.windows?.[0];
      if (front && (front.title || front.process)) {
        try {
          await doAction(port, `action=activate ${front.process ? `process=${front.process} ` : ''}` +
            `${front.title ? `title=${front.title}` : ''}`.trim());
          // Windows takes a moment to actually raise it; clicking into a window still coming forward misses.
          await new Promise((done) => setTimeout(done, 350));
        } catch (_) {
          setNote(`Could not bring ${front.title || front.process} to the front — replaying anyway.`);
        }
      }

      await replay(port, flowBody(
        [{ recordingId: rec.id, repeat: settings.repeat, speed: settings.speed, delayAfterMs: 0 }],
        [rec],
        { startDelayMs: state.startDelayMs, flowRepeat: 1, flowForever: settings.loop },
      ));
      setPlaying(rec.name);
      setNote(`Replaying "${rec.name}" — press Escape to stop.`);
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
          setNote(`Finished "${playing}".`);
        }
      } catch (_) {
        // The agent went away mid-replay; the health poller will say so.
        setPlaying(null);
      }
    }, 700);
    return () => clearInterval(timer);
  }, [playing, port]);

  const keepAsSkill = useCallback(async (rec: Recording) => {
    const name = prompt('Name this skill', rec.name);
    if (name === null) return;
    try {
      /* Общая реализация - см. save-as-skill.ts. Skills предлагает то же самое со своей страницы, и payload,
       * написанный в двух местах, однажды разойдётся: это уже случалось с flowFor. */
      await saveAsSkill(rec, name);
      await reload();
      setNote('Saved as a skill. It is in Skills, on this and any other browser you sign in from.');
    } catch (err) {
      setNote(`Could not save it as a skill: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }, [reload]);

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
    try {
      const saved = await push({ flows: made.map((rec) => flowFor(rec, health)) });
      if (saved.problems.length) {
        setNote(`Imported ${added}, but the account refused ${saved.problems.length}: ${saved.problems.join('; ')}`);
      }
      await reload();
    } catch (err) {
      setNote(`Imported ${added} into this browser, but syncing failed: ${
        err instanceof Error ? err.message : 'unknown error'
      }. View needs the recording on your account.`);
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
    const saved = await push({ flows: [flowFor(rec, health)] });
    if (saved.problems.length) throw new Error(saved.problems.join('; '));
    await reload();
  }, [state.recordings, health, reload]);

  /* Забрать осиротевшую запись в этот браузер — под ЕЁ id.
   *
   * `adoptRecording` существует для другого: скилл, взятый из Skills или из галереи, кладётся под
   * `from_<id>`, чтобы копия для проигрывания не путалась с оригиналом на аккаунте. Здесь копии нет - это та
   * же запись, и под новым id она осталась бы сиротой: строка аккаунта по-прежнему ни с чем не совпадает,
   * полоса не уходит, дашборд считает её дважды. На этом и попалось в браузере. */
  const adoptOrphan = useCallback((flow: Flow) => {
    const events = flow.payload?.events as RecordedEvent[] | undefined;
    if (!Array.isArray(events) || !events.length) {
      setNote(`"${flow.name}" has no events stored, so there is nothing to bring here.`);
      return;
    }
    if (state.recordings.some((rec) => rec.id === flow.id)) return;
    update((prev) => ({
      recordings: [...prev.recordings, {
        id: flow.id,
        name: flow.name || 'From the account',
        created: flow.created ?? new Date().toISOString(),
        events,
        windows: (flow.payload?.windows as { title: string; process: string }[] | undefined) ?? [],
      }],
    }));
  }, [state.recordings, update]);

  const recording = live !== null || !!health?.recording;

  return (
    /* One column, not two: a row of a recording carries a name, three replay controls, a date and six
     * actions, and squeezing that into a 1fr column beside the recorder is what made it wrap to three lines
     * and push the page sideways. The recorder is small; it goes above. */
    <div className="flex flex-col gap-4 p-5">
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
                {recording
                  ? 'Capturing every click, drag, scroll and keystroke — press stop when the task is done.'
                  : 'Captures every click, drag and scroll, with the application, window and control each one landed on. Typing is timed, never read.'}
              </Typography>

              {session ? (
                <span className="shrink-0 text-[0.8rem] text-ink-secondary tabular-nums">
                  Session · part {session.parts.length + 1} · {session.parts.length} written · a cut every{' '}
                  {session.everyMinutes} min
                </span>
              ) : recording ? null : health?.canDrain !== true ? (
                /* Said rather than hidden. An agent older than 0.8.0 has no way to hand over events without
                  * stopping, so a session cannot be offered at all - and a control that simply is not there
                  * reads as a feature this product does not have. */
                <span className="shrink-0 text-[0.8rem] text-ink-inactive">
                  {health
                    ? 'Long sessions need agent 0.8.0 — this one stops to hand over what it recorded.'
                    : ''}
                </span>
              ) : (
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[0.8rem] text-ink-inactive">Write a part every</span>
                  {([null, ...CHUNK_CHOICES] as (ChunkMinutes | null)[]).map((choice) => (
                    <button
                      key={String(choice)}
                      type="button"
                      onClick={() => setEveryMinutes(choice)}
                      className={cn(
                        'rounded-md border px-2 py-1 text-[0.78rem] transition-colors duration-base',
                        everyMinutes === choice
                          ? 'border-brand-primary/40 bg-brand-primary/15 font-semibold text-brand-primary'
                          : 'border-stroke text-ink-secondary hover:bg-state-hover',
                      )}
                    >
                      {choice === null ? 'One recording' : `${choice} min`}
                    </button>
                  ))}
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
          {state.lastSync.left
            ? `. ${state.lastSync.left} older ${state.lastSync.left === 1 ? 'one' : 'ones'} stayed on the `
              + 'account — this browser holds about 3MB of recordings, and the transcript reads them from '
              + 'the account anyway.'
            : '.'}
        </Typography>
      )}

      {/* Sessions above the recordings table: a session is the bigger object, and its parts are on the
        * account rather than in this browser, so they do not appear in the table below at all. */}
      <SessionStrip
        sessions={state.sessions as Session[]}
        onView={(partId) => setViewing((was) => (was === partId ? null : partId))}
        onForget={(gone) => { void forgetSession(gone); }}
      />

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
          /* A session part is on the account and not in this browser BY DESIGN - that is the whole mechanism -
           * so calling it a stray is technically true and substantively wrong. Worse, the strip offers to
           * "bring them here", which for sixteen parts is exactly the several megabytes of events that made
           * eight hours impossible in the first place. */
          && !sessionOf(flow.payload)
        ))}
        onAdopt={(flow) => adoptOrphan(flow)}
        onImport={(files) => { void importFiles(files); }}
        onSaveAsSkill={(rec) => { void keepAsSkill(rec); }}
        onView={(rec) => setViewing((open) => (open === rec.id ? null : rec.id))}
        onPlay={(rec) => { void playOne(rec); }}
      />

      {/* The transcript, beside the list rather than inside a row: it is long, and a row that expands to
        * three hundred lines stops being a row. Same shape as the dashboard's assistant panel - fixed to the
        * right, the page scrolls behind it - because they are the same gesture, looking at one thing in
        * detail without losing the list you found it in. */}
      {viewing && (
        <aside className="fixed inset-y-0 right-0 z-40 flex w-[34rem] max-w-full flex-col border-stroke border-l bg-surface-card2 shadow-dropdown">
          <TranscriptPanel
            flowId={viewing}
            /* A part is not among the local recordings - deliberately - so its name comes from the session
              * ledger. Without this every part's transcript was headed "Recording". */
            name={state.recordings.find((rec) => rec.id === viewing)?.name
              ?? (state.sessions as Session[])
                .flatMap((s) => s.parts).find((p) => p.id === viewing)?.name
              ?? 'Recording'}
            /* Offered only when this browser actually holds the events. Without them there is nothing to put
             * back, and a button that cannot work is worse than the plain 404. */
            onRestore={state.recordings.some((rec) => rec.id === viewing)
              ? () => restore(viewing)
              : undefined}
            onAnalyze={() => {
              askAbout(viewing, state.recordings.find((rec) => rec.id === viewing)?.name
                ?? (state.sessions as Session[])
                  .flatMap((s) => s.parts).find((p) => p.id === viewing)?.name
                ?? 'Recording');
              void navigate({ to: '/dashboard' });
            }}
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
    </div>
  );
};
