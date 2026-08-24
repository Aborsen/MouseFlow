/* Describing a flow in words, beside the page it is about.
 *
 * The agent lives in the worker (extension/agent.js): it reads the page, decides one action at a time and
 * carries them out in the browser. This screen is the conversation around it - the goal going in, and what
 * it is doing coming back.
 *
 * WHY THE LOG IS POLLED. `agent/status` returns the last dozen lines and the last six steps, and the run
 * continues whether or not this panel is open. Holding the transcript here would mean a run that started
 * before the panel was opened has no history, which is exactly the case a side panel makes common.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { Pill } from '@/components/Pill';
import { Said, type SaidNote } from '@/components/Said';
import { ask } from './worker';

interface Step { n: number; tool: string; ok: boolean; host?: string; moved?: boolean }
interface Status {
  running?: boolean;
  goal?: string;
  log?: string[];
  steps?: Step[];
  result?: { ok?: boolean; said?: string } | null;
}

export const CreateScreen = () => {
  const [goal, setGoal] = useState('');
  const [status, setStatus] = useState<Status>({});
  const [note, setNote] = useState<SaidNote | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const read = useCallback(async () => {
    const res = await ask('agent/status');
    if (res.ok) setStatus(res as Status);
  }, []);

  useEffect(() => {
    void read();
    const timer = setInterval(read, 800);
    return () => clearInterval(timer);
  }, [read]);

  /* Follows the log down, which is what somebody watching a run wants and what somebody reading back
   * through it does not - so only while it is running. */
  useEffect(() => {
    if (status.running) bottom.current?.scrollIntoView({ block: 'end' });
  }, [status.log, status.running]);

  const send = async () => {
    const text = goal.trim();
    if (!text) return;
    setNote(null);
    const res = await ask('agent/start', { goal: text });
    if (!res.ok) { setNote({ text: res.error ?? 'It would not start.', kind: 'bad' }); return; }
    setGoal('');
    void read();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <header className="flex items-center gap-2">
        <Typography variant="h2" weight="semibold" className="text-[1.05rem]">Create</Typography>
        {status.running ? <Pill tone="count">Working</Pill> : <Pill>Idle</Pill>}
      </header>

      {!status.running && !status.log?.length && (
        <Typography variant="p" className="text-ink-inactive text-[0.8rem] leading-relaxed">
          Say what you want done on this page and it is carried out here, in this browser — one action at a
          time, reading the page between them. It types, so it can fill things in; a recording cannot.
        </Typography>
      )}

      {/* What it is doing, while it does it. */}
      {(status.log?.length || status.steps?.length) ? (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-stroke/45 bg-surface-card2 p-2.5">
          {status.goal && (
            <Typography variant="p" className="mb-2 text-[0.8rem] text-ink-body">
              {status.goal}
            </Typography>
          )}
          <ul className="flex flex-col gap-1">
            {(status.steps ?? []).map((step) => (
              <li key={step.n} className="flex items-center gap-1.5 text-[0.76rem]">
                <Pill tone={step.ok ? 'good' : 'bad'}>{step.tool}</Pill>
                {step.host && <span className="truncate text-ink-inactive">{step.host}</span>}
              </li>
            ))}
            {(status.log ?? []).map((line, i) => (
              <li key={`log-${i}`} className="break-words text-[0.76rem] text-ink-inactive">{line}</li>
            ))}
          </ul>
          <div ref={bottom} />
        </div>
      ) : null}

      {status.result?.said && !status.running && (
        <Said
          note={{ text: status.result.said, kind: status.result.ok ? 'good' : 'bad' }}
          variant="inline"
        />
      )}

      <Said note={note} onDismiss={() => setNote(null)} />

      <div className="flex items-end gap-1.5">
        <textarea
          value={goal}
          onChange={(ev) => setGoal(ev.target.value)}
          onKeyDown={(ev) => {
            /* Enter sends, Shift+Enter is a new line - the same as the app's composer, and the same as
             * every chat box somebody has used this week. */
            if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void send(); }
          }}
          rows={2}
          placeholder="What should happen on this page?"
          aria-label="What should happen on this page?"
          className="min-h-[2.75rem] flex-1 resize-none rounded-md border-stroke border bg-surface-card2 px-2.5 py-1.5 text-[0.85rem] text-ink-primary placeholder:text-ink-inactive focus:border-input-focus focus:outline-none"
        />
        {status.running ? (
          <Button
            variant="destructive"
            size="sm"
            aria-label="Stop"
            onClick={() => { void ask('agent/abort'); }}
            leftSlot={<Square className="size-4" />}
          >
            Stop
          </Button>
        ) : (
          <Button size="sm" aria-label="Send" onClick={send} disabled={!goal.trim()} leftSlot={<Send className="size-4" />}>
            Run
          </Button>
        )}
      </div>
    </div>
  );
};
