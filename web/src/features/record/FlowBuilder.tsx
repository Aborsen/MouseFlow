/* The flow: recordings in order, each with its own repeat, speed and pause, run as one thing.
 *
 * The controls are the ones the .mmmacro flow body carries, because inventing a control the agent cannot
 * honour is how a UI starts lying. Escape aborts, which is the one control that has to work when a replay
 * is driving the mouse and the pointer is not yours to move.
 */
import { ArrowDown, ArrowUp, Play, Square, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { replay, replayAbort, replayStatus } from '@/lib/agent';
import { flowBody, fmtMs, summarize } from '@/lib/macro';
import { useAgent, useConsole } from '@/lib/store';

export const FlowBuilder = () => {
  const [state, update] = useConsole();
  const { health } = useAgent();
  const [running, setRunning] = useState<{ step: number; steps: number; index: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const port = state.port;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      try {
        const s = await replayStatus(port);
        if (!s.playing) { setRunning(null); return; }
        setRunning({ step: s.step, steps: s.steps, index: s.index, total: s.total });
      } catch (_) {
        setRunning(null);
      }
    }, 300);
    return () => clearInterval(timer);
  }, [running, port]);

  const abort = useCallback(async () => {
    try { await replayAbort(port); } catch (_) { /* it may already have finished */ }
    setRunning(null);
    setNote('Stopped.');
  }, [port]);

  // Escape, while it runs. The pointer is not the user's during a replay, so the keyboard has to be enough.
  useEffect(() => {
    if (!running) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') void abort(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [running, abort]);

  const run = useCallback(async () => {
    if (!health) { setNote('The agent is not running.'); return; }
    if (!state.flow.length) { setNote('Add a recording to the flow first.'); return; }
    setNote(null);
    try {
      await replay(port, flowBody(state.flow, state.recordings, {
        startDelayMs: state.startDelayMs,
        flowRepeat: state.flowRepeat,
        flowForever: state.flowForever,
      }));
      setRunning({ step: 1, steps: state.flow.length, index: 0, total: 0 });
      setNote(`Starting in ${(state.startDelayMs / 1000).toFixed(1)}s — press Escape to stop.`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'could not start the flow');
    }
  }, [health, port, state]);

  const move = (from: number, to: number) => update((prev) => {
    if (to < 0 || to >= prev.flow.length) return {};
    const flow = prev.flow.slice();
    const [step] = flow.splice(from, 1);
    if (step) flow.splice(to, 0, step);
    return { flow };
  });

  return (
    <section className="rounded-xl border-stroke border bg-surface-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Typography variant="h2" weight="semibold" className="text-[0.95rem] uppercase tracking-wide text-ink-secondary">
          Flow
        </Typography>
        {state.flow.length > 0 && (
          <Button variant="ghost" size="sm" className="ms-auto" leftSlot={<Trash2 className="size-4" />}
                  onClick={() => update({ flow: [] })}>
            Clear
          </Button>
        )}
      </div>

      {state.flow.length === 0 ? (
        <Typography variant="p" className="text-ink-inactive text-[0.88rem]">
          Nothing in the flow. Add a recording above — a flow is recordings in order, each with its own
          repeat and speed, run as one thing.
        </Typography>
      ) : (
        <ul className="mb-4 flex flex-col gap-2">
          {state.flow.map((step, i) => {
            const rec = state.recordings.find((r) => r.id === step.recordingId);
            const s = rec ? summarize(rec.events) : null;
            const active = running && running.step === i + 1;
            return (
              <li
                key={`${step.recordingId}-${i}`}
                className={`flex flex-wrap items-center gap-3 rounded-lg border p-2.5 ${
                  active ? 'border-brand-primary bg-surface-accent' : 'border-stroke bg-surface-chips'
                }`}
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-state-hover text-[0.75rem] text-ink-secondary tabular-nums">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <strong className="block truncate font-semibold text-[0.9rem]">
                    {rec?.name ?? 'A recording that is no longer here'}
                  </strong>
                  {s && (
                    <span className="text-[0.76rem] text-ink-inactive">
                      {s.count} events · {fmtMs(s.durationMs)} per pass
                    </span>
                  )}
                </div>

                <label className="flex items-center gap-1.5 text-[0.72rem] text-ink-secondary">
                  Repeat
                  <input
                    type="number" min={1} max={999} value={step.repeat}
                    onChange={(ev) => update((prev) => ({
                      flow: prev.flow.map((f, j) => j === i
                        ? { ...f, repeat: Math.max(1, parseInt(ev.target.value, 10) || 1) } : f),
                    }))}
                    className="w-14 rounded-md border-stroke border bg-surface-card px-1.5 py-1 text-ink-primary tabular-nums"
                  />
                </label>

                <label className="flex items-center gap-1.5 text-[0.72rem] text-ink-secondary">
                  Speed
                  <select
                    value={step.speed}
                    onChange={(ev) => update((prev) => ({
                      flow: prev.flow.map((f, j) => j === i ? { ...f, speed: Number(ev.target.value) } : f),
                    }))}
                    className="rounded-md border-stroke border bg-surface-card px-1.5 py-1 text-ink-primary"
                  >
                    {[0.5, 1, 1.5, 2, 4].map((v) => <option key={v} value={v}>{v}×</option>)}
                  </select>
                </label>

                <label className="flex items-center gap-1.5 text-[0.72rem] text-ink-secondary">
                  Then wait
                  <input
                    type="number" min={0} step={100} value={step.delayAfterMs}
                    onChange={(ev) => update((prev) => ({
                      flow: prev.flow.map((f, j) => j === i
                        ? { ...f, delayAfterMs: Math.max(0, parseInt(ev.target.value, 10) || 0) } : f),
                    }))}
                    className="w-20 rounded-md border-stroke border bg-surface-card px-1.5 py-1 text-ink-primary tabular-nums"
                  />
                </label>

                <div className="flex gap-1">
                  <Button variant="ghost" size="xs" aria-label="Move up" onClick={() => move(i, i - 1)}>
                    <ArrowUp className="size-4" />
                  </Button>
                  <Button variant="ghost" size="xs" aria-label="Move down" onClick={() => move(i, i + 1)}>
                    <ArrowDown className="size-4" />
                  </Button>
                  <Button
                    variant="destructiveTertiary" size="xs" aria-label="Remove"
                    onClick={() => update((prev) => ({ flow: prev.flow.filter((_, j) => j !== i) }))}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <label className="text-[0.72rem] text-ink-secondary">
          Start delay
          <span className="mt-1 flex items-center gap-1">
            <input
              type="number" min={0} step={500} value={state.startDelayMs}
              onChange={(ev) => update({ startDelayMs: Math.max(0, parseInt(ev.target.value, 10) || 0) })}
              className="w-24 rounded-md border-stroke border bg-surface-card px-2 py-1.5 text-ink-primary tabular-nums"
            />
            <span>ms</span>
          </span>
        </label>

        <label className="text-[0.72rem] text-ink-secondary">
          Repeat whole flow
          <span className="mt-1 flex items-center gap-1">
            <input
              type="number" min={1} value={state.flowRepeat} disabled={state.flowForever}
              onChange={(ev) => update({ flowRepeat: Math.max(1, parseInt(ev.target.value, 10) || 1) })}
              className="w-20 rounded-md border-stroke border bg-surface-card px-2 py-1.5 text-ink-primary tabular-nums disabled:opacity-disabled"
            />
            <span>×</span>
          </span>
        </label>

        <label className="flex items-center gap-2 text-[0.8rem] text-ink-body">
          <input
            type="checkbox" checked={state.flowForever}
            onChange={(ev) => update({ flowForever: ev.target.checked })}
            className="size-4 accent-brand-primary"
          />
          Restart forever when it ends
        </label>

        {running ? (
          <Button variant="destructive" className="ms-auto" leftSlot={<Square className="size-4" />} onClick={abort}>
            Stop (Escape)
          </Button>
        ) : (
          <Button className="ms-auto" leftSlot={<Play className="size-4" />} disabled={!health || !state.flow.length} onClick={run}>
            Run flow
          </Button>
        )}
      </div>

      {running && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-[0.78rem] text-ink-secondary">
            <span>Step {running.step} of {running.steps}</span>
            <span className="tabular-nums">{running.total ? `${running.index}/${running.total} events` : ''}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-state-hover">
            <div
              className="h-full bg-brand-primary transition-[width] duration-150"
              style={{ width: `${running.total ? (running.index / running.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {note && (
        <Typography variant="p" className="mt-3 text-ink-secondary text-[0.85rem]">
          {note}
        </Typography>
      )}
    </section>
  );
};
