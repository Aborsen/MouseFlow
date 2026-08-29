/* Recording, in the panel, beside the page being recorded.
 *
 * This is the reason the panel exists at all. A popup closes the moment somebody clicks the page, and
 * recording a flow IS clicking the page - so the old surface could show a timer only until the first
 * thing worth recording happened.
 *
 * The worker owns the recording; this shows it. Every number here is read from `record/status` rather
 * than counted locally, because the worker keeps recording while this panel is closed and a count that
 * lived here would restart at zero when it opened again.
 *
 * AND THE LIST BELOW IS WHY THIS SCREEN WAS HALF A FEATURE. Stop wrote the recording into the worker's
 * storage and this screen said "Saved. It is on the Record page in the app" - which it was not, and could
 * not become: sync pushes skills and runs, never recordings. Nothing in the panel could list one, play one,
 * name one, keep one or throw one away. The engine that does all four was already written and had no
 * caller. So the list is that caller, and the sentence now names the place the recording actually is,
 * which is right here.
 */
import { useCallback, useEffect, useState } from 'react';
import { CircleDot, Play, Square, Trash2, Wand2 } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { ArmedButton } from '@/components/ArmedButton';
import { Pill } from '@/components/Pill';
import { Said, type SaidNote } from '@/components/Said';
import { ask } from './worker';

interface Status {
  recording?: boolean;
  count?: number;
  moves?: number;
  elapsedMs?: number;
}

/** One recording the worker is holding. Never carries its events - see pendingList in background.js. */
interface Held {
  id: string;
  name: string;
  created: string;
  origins: string[];
  tabs: number;
  events: number;
}

interface Playing {
  playing?: boolean;
  step?: number;
  steps?: number;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/* The sites it touched, said the way a person would recognise them. The worker stores whole origins; a
 * panel column is about thirty characters wide, and "mail.google.com" is the recognisable part of
 * "https://mail.google.com". */
const site = (origin: string) => origin.replace(/^https?:\/\//, '').replace(/\/$/, '');

const where = (rec: Held) => {
  if (!rec.origins.length) return `${rec.tabs} tab${rec.tabs === 1 ? '' : 's'}`;
  const first = site(rec.origins[0]);
  return rec.origins.length === 1 ? first : `${first} +${rec.origins.length - 1} more`;
};

export const RecordScreen = () => {
  const [status, setStatus] = useState<Status>({});
  const [held, setHeld] = useState<Held[]>([]);
  const [play, setPlay] = useState<Playing>({});
  const [note, setNote] = useState<SaidNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [arming, setArming] = useState<string | null>(null);

  const read = useCallback(async () => {
    const [state, list, playing] = await Promise.all([
      ask('record/status'),
      ask('record/list'),
      ask('replay/status'),
    ]);
    if (state.ok) setStatus(state as Status);
    if (list.ok) setHeld((list.recordings as Held[]) ?? []);
    if (playing.ok) setPlay(playing as Playing);
  }, []);

  /* Polled rather than pushed. The worker already answers `record/status` for the popup, and a panel that
   * asked for a new channel would be a second way to learn the same fact - which is how two surfaces come
   * to disagree about whether a recording is running. */
  useEffect(() => {
    void read();
    const timer = setInterval(read, 500);
    return () => clearInterval(timer);
  }, [read]);

  const start = async () => {
    setBusy(true);
    setNote(null);
    const res = await ask('record/start');
    setBusy(false);
    if (!res.ok) setNote({ text: res.error ?? 'It would not start.', kind: 'bad' });
    else void read();
  };

  const stop = async () => {
    setBusy(true);
    const res = await ask('record/stop');
    setBusy(false);
    setNote(res.ok
      /* Names where it IS. The previous sentence named the Record page in the app, which is not where a
       * browser recording goes and never was. */
      ? { text: 'Saved here. Play it back, or keep it as a skill to put it on your account.', kind: 'good' }
      : { text: res.error ?? 'It would not stop.', kind: 'bad' });
    void read();
  };

  const playOne = async (rec: Held) => {
    setBusy(true);
    setNote(null);
    const res = await ask('record/play', { id: rec.id });
    setBusy(false);
    if (!res.ok) setNote({ text: res.error ?? 'It would not play.', kind: 'bad' });
    void read();
  };

  const keep = async (rec: Held) => {
    setBusy(true);
    setNote(null);
    const res = await ask('record/keep', { id: rec.id });
    setBusy(false);
    if (!res.ok) {
      setNote({ text: res.error ?? 'It would not be kept.', kind: 'bad' });
    } else {
      /* TWO OUTCOMES, AND THE SECOND ONE IS RED ON PURPOSE.
       *
       * Kept-but-not-pushed is genuinely between the two colours Said has: the skill exists, so it is not a
       * failure, and it is not on the account, so it is not what was asked for either. Red, by the same
       * rule this screen was just fixed under - a false red is visible and can be argued with, a false
       * green is neither - and the sentence leads with the half that DID happen so nobody thinks the
       * recording was lost. */
      /* НАЗЫВАЕТ ОБА ФАКТА, и второй важнее первого. Строка исчезает из списка выше - она больше не
       * запись, - и человек, увидевший пустой список, читает это как потерю быстрее, чем успевает
       * прочесть похвалу. Поэтому предложение начинается с того, ГДЕ она теперь. */
      setNote(res.synced
        ? { text: `"${rec.name}" is now a skill on your account — look in Skills. It has left this list `
            + 'because it is no longer a recording.', kind: 'good' }
        : {
            text: `"${rec.name}" is now a skill on this browser and has left this list, but it has not `
              + 'reached your account'
              + (res.syncError ? ` — ${String(res.syncError)}` : '') + '. It is safe here; sync again later.',
            kind: 'bad',
          });
    }
    void read();
  };

  const forget = async (rec: Held) => {
    setBusy(true);
    const res = await ask('record/forget', { id: rec.id });
    setBusy(false);
    if (!res.ok) setNote({ text: res.error ?? 'It would not go.', kind: 'bad' });
    void read();
  };

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <Typography variant="h2" weight="semibold" className="text-[1.05rem]">This browser</Typography>
        {status.recording
          ? <Pill tone="bad">Recording</Pill>
          : <Pill>Ready</Pill>}
      </header>

      <Typography variant="p" className="text-ink-inactive text-[0.8rem] leading-relaxed">
        Inside web pages, through this extension — no agent needed. Clicks, drags, scrolling and the path
        the pointer took. Typing is timed, never read: nothing about what was typed is in a recording.
        The whole computer is the recorder below.
      </Typography>

      {/* Three numbers, the same three the popup showed, because they are what tells somebody the
          recording is actually seeing them. */}
      <div className="grid grid-cols-3 gap-1.5">
        {[
          { n: status.count ?? 0, of: 'actions' },
          { n: status.moves ?? 0, of: 'motion' },
          { n: status.elapsedMs ? seconds(status.elapsedMs) : '0.0s', of: 'elapsed' },
        ].map(({ n, of }) => (
          <div key={of} className="rounded-lg border border-stroke/45 bg-surface-card2 px-2 py-1.5 text-center">
            <div className="font-semibold text-[1.05rem] text-ink-primary tabular-nums">{n}</div>
            <div className="text-[0.68rem] text-ink-inactive">{of}</div>
          </div>
        ))}
      </div>

      {status.recording ? (
        <Button variant="destructive" onClick={stop} disabled={busy} leftSlot={<Square className="size-4" />}>
          Stop and save
        </Button>
      ) : (
        <Button onClick={start} disabled={busy} leftSlot={<CircleDot className="size-4" />}>
          Start recording
        </Button>
      )}

      <Said note={note} onDismiss={() => setNote(null)} />

      {/* A REPLAY IS THE ONE THING HERE THAT DRIVES THE BROWSER, so it gets its own line and its own stop.
          The pointer is moving on its own while this shows, and reaching a Stop through a list row would
          mean chasing it. */}
      {play.playing && (
        <div className="flex items-center gap-2 rounded-lg border border-stroke/45 bg-surface-card2 px-2.5 py-2">
          <Pill tone="bad">Playing</Pill>
          <span className="text-[0.78rem] text-ink-secondary tabular-nums">
            step {play.step ?? 0} of {play.steps ?? 0}
          </span>
          <Button
            size="sm"
            variant="destructiveTertiary"
            className="ml-auto"
            onClick={() => { void ask('replay/abort').then(read); }}
          >
            Stop
          </Button>
        </div>
      )}

      {held.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <Typography variant="h3" weight="semibold" className="text-[0.85rem] text-ink-secondary">
            Recorded here
          </Typography>
          {held.map((rec) => (
            <div
              key={rec.id}
              className="flex flex-col gap-1.5 rounded-lg border border-stroke/45 bg-surface-card2 px-2.5 py-2"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-[0.85rem] text-ink-primary">{rec.name}</div>
                <div className="truncate text-[0.7rem] text-ink-inactive tabular-nums">
                  {rec.events} action{rec.events === 1 ? '' : 's'} · {where(rec)}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={busy || !!play.playing || !!status.recording}
                  onClick={() => { void playOne(rec); }}
                  leftSlot={<Play className="size-3.5" />}
                >
                  Play
                </Button>
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => { void keep(rec); }}
                  leftSlot={<Wand2 className="size-3.5" />}
                >
                  Keep as skill
                </Button>
                <ArmedButton
                  label="Delete"
                  armedLabel="Delete — press again"
                  armed={arming === rec.id}
                  onArm={() => setArming(rec.id)}
                  onDisarm={() => setArming(null)}
                  onConfirm={() => { setArming(null); void forget(rec); }}
                  busy={busy}
                  size="xs"
                  icon={<Trash2 className="size-3.5" />}
                  className="ml-auto"
                />
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
};
