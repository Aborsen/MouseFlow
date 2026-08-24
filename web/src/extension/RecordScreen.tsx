/* Recording, in the panel, beside the page being recorded.
 *
 * This is the reason the panel exists at all. A popup closes the moment somebody clicks the page, and
 * recording a flow IS clicking the page - so the old surface could show a timer only until the first
 * thing worth recording happened.
 *
 * The worker owns the recording; this shows it. Every number here is read from `record/status` rather
 * than counted locally, because the worker keeps recording while this panel is closed and a count that
 * lived here would restart at zero when it opened again.
 */
import { useCallback, useEffect, useState } from 'react';
import { CircleDot, Square } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { Pill } from '@/components/Pill';
import { Said, type SaidNote } from '@/components/Said';
import { ask } from './worker';

interface Status {
  recording?: boolean;
  count?: number;
  moves?: number;
  elapsedMs?: number;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export const RecordScreen = () => {
  const [status, setStatus] = useState<Status>({});
  const [note, setNote] = useState<SaidNote | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    const res = await ask('record/status');
    if (res.ok) setStatus(res as Status);
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
      ? { text: 'Saved. It is on the Record page in the app, and in Skills once you make one from it.', kind: 'good' }
      : { text: res.error ?? 'It would not stop.', kind: 'bad' });
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
    </div>
  );
};
