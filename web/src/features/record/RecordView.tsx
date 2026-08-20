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
import { Circle, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
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
import { flowBody, fmtMs, parseMacro, summarize } from '@/lib/macro';
import { type Recording, refreshAgent, uid, useAgent, useConsole } from '@/lib/store';
import { useAccount } from '@/shell/AccountProvider';
import { RecordingsTable, replayOf } from './RecordingsTable';
import { TranscriptPanel } from './TranscriptPanel';

export const RecordView = () => {
  const [state, update] = useConsole();
  const { health } = useAgent();
  const { reload } = useAccount();
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
        const saved = await push({
          flows: [{
            id: made.id,
            // `desktop`, which decides who can replay it: these are screen coordinates, not page elements.
            source: 'desktop',
            kind: 'recorded',
            name: made.name.slice(0, 80),
            description: `${s.count} events · ${s.clicks} click${s.clicks === 1 ? '' : 's'} · ${fmtMs(s.durationMs)}`,
            origins: where.map((w) => w.title).filter(Boolean).slice(0, 12),
            created: made.created,
            payload: {
              version: 1,
              kind: 'recorded',
              agent: 'desktop',
              /* What the agent said about ITSELF, now, because later nothing can reconstruct it.
               *
               * "Nothing was typed" and "the keyboard was not being watched" produce an identical
               * recording, and the transcript was asserting the first without being able to tell - a 0.6.0
               * agent names every click it lands on and hooks no keyboard at all, so the named clicks it
               * was reasoning from proved nothing. Written from /health at the moment of recording, which
               * is the only moment the answer exists. */
              recorder: {
                version: health?.version ?? null,
                canName: health?.canName === true,
                canKeys: health?.canKeys === true,
              },
              name: made.name.slice(0, 80),
              events: made.events,
              windows: made.windows,
              created: made.created,
            },
          }],
        });
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
    for (const file of Array.from(files)) {
      const { events } = parseMacro(await file.text());
      if (!events.length) continue;
      update((prev) => ({
        recordings: [
          ...prev.recordings,
          {
            id: uid(),
            name: file.name.replace(/\.[^.]+$/, ''),
            created: new Date().toISOString(),
            events,
            windows: [],
          },
        ],
      }));
      added++;
    }
    setNote(added ? `Imported ${added} recording${added === 1 ? '' : 's'}.` : 'Nothing in those files parsed.');
  }, [update]);

  const recording = live !== null || !!health?.recording;

  return (
    /* One column, not two: a row of a recording carries a name, three replay controls, a date and six
     * actions, and squeezing that into a 1fr column beside the recorder is what made it wrap to three lines
     * and push the page sideways. The recorder is small; it goes above. */
    <div className="flex flex-col gap-4 p-5">
      <section className="max-w-[46rem] rounded-xl border-stroke border bg-surface-card p-4">
        <Typography variant="h2" weight="semibold" className="mb-3 text-[0.95rem] uppercase tracking-wide text-ink-secondary">
          Record
        </Typography>

        {recording ? (
          <div>
            <div className="mb-3 flex items-center gap-2">
              <span className="size-2.5 animate-pulse rounded-full bg-fb-red" />
              <Typography variant="span" weight="semibold">Recording</Typography>
              <span className="ms-auto font-mono text-ink-secondary text-sm tabular-nums">
                {fmtMs(live?.elapsedMs ?? 0)}
              </span>
            </div>
            <div className="mb-3 grid grid-cols-2 gap-2 text-center">
              {[
                { value: live?.count ?? 0, label: 'events' },
                { value: seenWindows.current.length, label: 'windows' },
              ].map(({ value, label }) => (
                <div key={label} className="rounded-md border-stroke border bg-surface-chips px-2 py-1.5">
                  <strong className="block tabular-nums">{value}</strong>
                  <span className="text-[0.75rem] text-ink-secondary">{label}</span>
                </div>
              ))}
            </div>
            <Button variant="destructive" fullWidth leftSlot={<Square className="size-4" />} onClick={end}>
              Stop and save
            </Button>
          </div>
        ) : (
          <div>
            <Button fullWidth leftSlot={<Circle className="size-3.5 fill-current" />} onClick={begin}>
              Start recording
            </Button>
            <Typography variant="p" className="mt-2 text-ink-inactive text-[0.85rem]">
              Everything you click, drag and scroll gets captured until you press Stop.
              {' '}
              {health?.canName
                ? 'Each click also records which application and window it landed in, and the name of what '
                  + 'was under the pointer, so the transcript reads as work rather than as coordinates.'
                : 'Which applications you work in is noted too, so a recording can name itself.'}
              {health?.canKeys && ' Typing is timed and counted - that a key was pressed and when, never '
                + 'which key, so no text is captured and none can be.'}
            </Typography>

            {/* Said BEFORE the recording rather than discovered in the transcript afterwards. An agent
              * without the resolver records perfectly good coordinates and nothing that says what they
              * were aimed at, and nine seconds of work is cheap to redo while nine minutes is not. */}
            {health && health.canName !== true && (
              <Typography variant="p" className="mt-2 text-fb-attention text-[0.8rem]">
                This agent does not read what you click on, so this recording will be coordinates only -
                no application, no window, no control names, and no typing. Restart it with the command
                behind the agent chip in the header first; it takes a few seconds.
              </Typography>
            )}

            {/* A separate case, and a much narrower one: the agent is current but Windows refused the
              * keyboard hook. Everything else records; only the typing does not, and a transcript that
              * said "nothing was typed" would then be wrong rather than empty. */}
            {health?.canName === true && health.canKeys === false && (
              <Typography variant="p" className="mt-2 text-fb-attention text-[0.8rem]">
                This agent could not install its keyboard hook, so time spent typing will be missing from
                the transcript - it will look like a pause. Everything else records normally.
              </Typography>
            )}
          </div>
        )}

        {note && (
          <Typography variant="p" className="mt-3 text-ink-secondary text-[0.85rem]">
            {note}
          </Typography>
        )}
      </section>

      <RecordingsTable
        viewing={viewing}
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
