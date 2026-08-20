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
import { Square } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import {
  doAction,
  recordStart,
  recordStatus,
  recordStop,
  replay,
  replayAbort,
  replayStatus,
  windows,
} from '@/lib/agent';
import { push } from '@/lib/api';
import { askAbout } from '@/features/chat/ask-about';
import { RECORDING_ROLE, SKILL_ROLE } from '@/lib/flow-role';
import { flowBody, fmtMs, parseMacro, summarize } from '@/lib/macro';
import { type AgentStatus, type Recording, refreshAgent, uid, useAgent, useConsole } from '@/lib/store';
import { useAccount } from '@/shell/AccountProvider';
import { RecordingsTable, replayOf } from './RecordingsTable';
import { TranscriptPanel } from './TranscriptPanel';

/* One recording, as a row on the account.
 *
 * Two callers: the push on stop, and the restore when a recording has been deleted from Skills - which is
 * the same row, since recordings and skills share a table. They must build the identical payload or a
 * restored recording quietly stops matching the one that was saved, so there is one of these rather than
 * two literals that look alike.
 */
function flowFor(rec: Recording, health: AgentStatus['health']) {
  const s = summarize(rec.events);
  const where = rec.windows ?? [];
  return {
    id: rec.id,
    // `desktop`, which decides who can replay it: these are screen coordinates, not page elements.
    source: 'desktop' as const,
    kind: 'recorded' as const,
    name: rec.name.slice(0, 80),
    description: `${s.count} events · ${s.clicks} click${s.clicks === 1 ? '' : 's'} · ${fmtMs(s.durationMs)}`,
    origins: where.map((w) => w.title).filter(Boolean).slice(0, 12),
    created: rec.created,
    payload: {
      version: 1,
      kind: 'recorded',
      agent: 'desktop',
      /* What this row IS, so the Skills page can stop listing it. Recordings and skills share a table and
       * nothing used to say which a row was, so a recording appeared under Skills looking like a skill and
       * deleting that card deleted the recording - and the transcript with it. */
      role: RECORDING_ROLE,
      /* What the agent said about ITSELF, now, because later nothing can reconstruct it.
       *
       * "Nothing was typed" and "the keyboard was not being watched" produce an identical recording, and the
       * transcript was asserting the first without being able to tell - a 0.6.0 agent names every click it
       * lands on and hooks no keyboard at all, so the named clicks it was reasoning from proved nothing.
       * Read from /health at the moment of recording, which is the only moment the answer exists.
       *
       * On a RESTORE this is whatever the agent says now, which may differ from what recorded it. Better
       * than nothing and honest either way: the flags describe an agent, and the transcript only ever uses
       * them to decide whether "no typing" means none happened. */
      recorder: {
        version: health?.version ?? null,
        canName: health?.canName === true,
        canKeys: health?.canKeys === true,
      },
      name: rec.name.slice(0, 80),
      events: rec.events,
      windows: rec.windows,
      created: rec.created,
    },
  };
}

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
      {/* A fixed box, so the button inside it can change size and the row cannot. */}
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
          {live
            // A square, which is what a stop control is everywhere else a person has ever used one.
            ? <Square className="size-7 fill-current text-white" />
            : <span className="size-5 rounded-full bg-white/95" />}
        </button>
      </div>

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
      seenWindows.current = [];
      setLive({ count: 0, elapsedMs: 0 });
      setNote(null);
      refreshAgent();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'could not start recording');
    }
  }, [health, navigate, port]);

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
        setLive({ count: s.count, elapsedMs: s.elapsedMs });
        if (!s.recording) setLive(null);
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
    try {
      const text = await recordStop(port);
      setLive(null);
      const { events } = parseMacro(text);
      if (!events.length) { setNote('Nothing was captured.'); return; }

      const where = seenWindows.current.slice();
      const s = summarize(events);
      /* Named after what you were working in. "Outlook (PWA)" is a thing you can find again in a week;
       * "Recording 3" is not. */
      const first = where[0]?.title.split(/\s+[-–—|]\s+/)[0]?.slice(0, 40);
      const name = first
        ? `${first} · ${s.clicks} click${s.clicks === 1 ? '' : 's'}`
        : `Recording ${state.recordings.length + 1}`;

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
  }, [port, state.recordings.length, update]);

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
    const s = summarize(rec.events);
    const where = rec.windows.map((w) => w.title).filter(Boolean);
    const name = prompt('Name this skill', rec.name);
    if (name === null) return;

    const described =
      `Repeats ${s.count} recorded actions` +
      (s.clicks ? ` (${s.clicks} click${s.clicks === 1 ? '' : 's'})` : '') +
      ` over ${fmtMs(s.durationMs)}` +
      (where.length ? `, in ${where.slice(0, 3).join(', ')}` : '') + '.';

    try {
      const body = await push({
        flows: [{
          id: `dr_${rec.id}`,
          /* `desktop`, which decides who can run it: these are screen coordinates, so the extension must
           * not offer to replay them in a page - it would click at meaningless positions. */
          source: 'desktop',
          kind: 'recorded',
          name: (name || rec.name).slice(0, 80),
          description: described.slice(0, 400),
          origins: where.slice(0, 12),
          created: rec.created,
          payload: {
            version: 1,
            kind: 'recorded',
            agent: 'desktop',
            // A skill, and a self-contained one: it carries its own copy of the events below, so deleting
            // the recording it came from does not empty it either.
            role: SKILL_ROLE,
            name: (name || rec.name).slice(0, 80),
            description: described.slice(0, 400),
            events: rec.events,
            windows: rec.windows,
            created: rec.created,
          },
        }],
      });
      if (body.problems.length) throw new Error(body.problems.join('; '));
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
            /* One line at this width. It carried an 86ch measure, which is right for running prose and wrong
              * for a caption in a status card - the card is 1424px and the sentence was capped at a third of
              * it, so it wrapped to three lines of small print. The long form of all of this is in the
              * transcript's own `captured` line, where somebody reading a recording actually meets it. */
            <Typography variant="p" className="text-ink-inactive text-[0.85rem]">
              {recording
                ? 'Capturing every click, drag, scroll and keystroke — press stop when the task is done.'
                : 'Captures every click, drag and scroll, with the application, window and control each one landed on. Typing is timed, never read.'}
            </Typography>
          )
        }
      />

      <RecordingsTable
        viewing={viewing}
        /* Answered here because this is the half that can see the account. Save as skill writes a separate
         * row under `dr_<id>`, so the question is whether that row exists - not whether the recording
         * carries a flag, which it does not and should not: two objects, two lifetimes. */
        hasSkill={(rec) => flows.some((flow) => flow.id === `dr_${rec.id}`)}
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
            name={state.recordings.find((rec) => rec.id === viewing)?.name ?? 'Recording'}
            /* Offered only when this browser actually holds the events. Without them there is nothing to put
             * back, and a button that cannot work is worse than the plain 404. */
            onRestore={state.recordings.some((rec) => rec.id === viewing)
              ? () => restore(viewing)
              : undefined}
            onAnalyze={() => {
              askAbout(viewing, state.recordings.find((rec) => rec.id === viewing)?.name ?? 'Recording');
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
