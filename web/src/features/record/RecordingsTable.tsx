/* The recordings, as a list you can work through - following insightis's Chats Library.
 *
 * They were stacked cards, each with its own row of four buttons: fine for three recordings and unusable at
 * thirty, because every card was as loud as every other and nothing could be done to two of them at once. So
 * this is their list page: a search, a count with Select all, one row per recording with the date on the
 * right, actions on the row, a selection bar when something is ticked, and Load more rather than a wall.
 *
 * Their Card variant="row" is vendored, so the row itself is literally theirs. Two departures, both
 * deliberate:
 *
 *   Their actions hide until the row is hovered (`lg:opacity-0`, revealed by group-hover/row). Ours stay
 *   visible, because these were asked for as labels somebody can see - and because on a demo machine nobody
 *   hovers a row to discover that Export exists.
 *
 *   Ours carry three controls theirs has no equivalent of - repeat, speed, loop - because a recording here is
 *   something you REPLAY, and those are the three questions a replay asks. They live on the recording rather
 *   than on the flow step so that pressing Play on the row and adding it to a flow mean the same thing.
 */
import { Button } from '@insightis/ui/Button';
import { Card } from '@insightis/ui/Card';
import { Checkbox } from '@insightis/ui/Checkbox';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import {
  Download,
  Eye,
  Play,
  Plus,
  Repeat,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { exportMacro, fmtMs, summarize } from '@/lib/macro';
import { type Recording, useConsole } from '@/lib/store';

/* How many rows before Load more. Ten is theirs, and it is about the point where a list stops being
 * scannable rather than a number with a reason behind it. */
const PAGE = 10;

const SPEEDS = [0.5, 1, 1.5, 2, 4];

export interface RecordingsTableProps {
  /** Save as skill lives on the page, because it also has to report what happened. */
  onSaveAsSkill: (rec: Recording) => void;
  /** View opens the transcript panel; the page owns that so only one is open at a time. */
  onView: (rec: Recording) => void;
  /** Play one recording now, with its own repeat/speed/loop. */
  onPlay: (rec: Recording) => void;
  onImport: (files: FileList) => void;
  /** Which recording's transcript is open, so its row can say so. */
  viewing?: string | null;
}

/** What a replay of this recording should do. Held on the recording, so a row and a flow step agree. */
export interface ReplaySettings {
  repeat: number;
  speed: number;
  loop: boolean;
}

export const replayOf = (rec: Recording): ReplaySettings => ({
  repeat: Math.max(1, Number(rec.replay?.repeat) || 1),
  speed: Number(rec.replay?.speed) || 1,
  loop: !!rec.replay?.loop,
});

export const RecordingsTable = ({
  onSaveAsSkill,
  onView,
  onPlay,
  onImport,
  viewing,
}: RecordingsTableProps) => {
  const [state, update] = useConsole();
  const [term, setTerm] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /* Delete arms in the button rather than in a confirm() - the same pattern MyAccountScreen uses, and for the
   * same reason: a dialog is easy to click through and a second one is easy to lose behind the first. */
  const [armed, setArmed] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => {
    const needle = term.trim().toLowerCase();
    if (!needle) return state.recordings;
    return state.recordings.filter((rec) => {
      const where = rec.windows.map((w) => `${w.title} ${w.process}`).join(' ');
      return `${rec.name} ${where}`.toLowerCase().includes(needle);
    });
  }, [state.recordings, term]);

  const visible = rows.slice(0, shown);

  /* Only rows that are actually on screen count as selected. A tick that survives a search which hides its
   * row is how somebody deletes something they cannot see. */
  const live = useMemo(
    () => new Set([...selected].filter((id) => rows.some((r) => r.id === id))),
    [selected, rows],
  );

  const setReplay = useCallback((id: string, change: Partial<ReplaySettings>) => {
    update((prev) => ({
      recordings: prev.recordings.map((rec) => (rec.id === id
        ? { ...rec, replay: { ...replayOf(rec), ...change } }
        : rec)),
    }));
  }, [update]);

  const remove = useCallback((ids: string[]) => {
    update((prev) => ({
      recordings: prev.recordings.filter((rec) => !ids.includes(rec.id)),
      // A flow step pointing at a recording that no longer exists would fail at replay time, silently.
      flow: prev.flow.filter((step) => !ids.includes(step.recordingId)),
    }));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    setArmed(null);
  }, [update]);

  const exportOne = useCallback((rec: Recording) => {
    const blob = new Blob([exportMacro(rec)], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${rec.name.replace(/[^\w.-]+/g, '-')}.mmmacro`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, []);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section className="rounded-xl border-stroke border bg-surface-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Typography variant="h2" weight="semibold" className="text-[0.95rem] uppercase tracking-wide text-ink-secondary">
          Recordings
        </Typography>
        <Button
          variant="ghost"
          size="sm"
          className="ms-auto"
          leftSlot={<Upload className="size-4" />}
          onClick={() => fileInput.current?.click()}
        >
          Import .mmmacro
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".mmmacro,.txt,text/plain"
          multiple
          hidden
          onChange={(ev) => { if (ev.target.files) onImport(ev.target.files); }}
        />
      </div>

      {state.recordings.length === 0 ? (
        <Typography variant="p" className="text-ink-inactive text-[0.88rem]">
          No recordings yet. Press <strong>Start recording</strong>, or import a <code>.mmmacro</code>
          {' '}file from Mini Mouse Macro.
        </Typography>
      ) : (
        <>
          <label className="relative mb-2.5 block">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-inactive" />
            <input
              value={term}
              onChange={(ev) => { setTerm(ev.target.value); setShown(PAGE); }}
              placeholder="Search recordings…"
              aria-label="Search recordings"
              className={cn(
                'h-9 w-full rounded-md border-stroke border bg-surface-card2 pr-3 pl-8',
                'text-ink-primary placeholder:text-ink-inactive',
                'focus:border-input-focus focus:outline-none',
              )}
            />
          </label>

          {/* Their count line, with Select all beside it. */}
          <div className="mb-2 flex flex-wrap items-center gap-3 text-[0.8rem]">
            <Typography variant="span" className="text-ink-secondary">
              {rows.length} recording{rows.length === 1 ? '' : 's'}
              {term && state.recordings.length !== rows.length ? ` of ${state.recordings.length}` : ''}
            </Typography>

            {rows.length > 0 && (
              <button
                type="button"
                className="text-brand-primary hover:underline"
                onClick={() => setSelected(live.size === rows.length
                  ? new Set()
                  : new Set(rows.map((r) => r.id)))}
              >
                {live.size === rows.length ? 'Clear selection' : 'Select all'}
              </button>
            )}

            {live.size > 0 && (
              /* Their selection bar, reduced to what there is to do with several recordings at once. */
              <span className="ms-auto flex flex-wrap items-center gap-1.5">
                <Typography variant="span" className="text-ink-secondary">
                  {live.size} selected
                </Typography>
                <Button
                  variant="ghost"
                  size="sm"
                  leftSlot={<Download className="size-4" />}
                  onClick={() => rows.filter((r) => live.has(r.id)).forEach(exportOne)}
                >
                  Export
                </Button>
                <Button
                  variant={armed === 'selection' ? 'destructive' : 'destructiveTertiary'}
                  size="sm"
                  leftSlot={<Trash2 className="size-4" />}
                  onClick={() => {
                    if (armed !== 'selection') { setArmed('selection'); return; }
                    remove([...live]);
                  }}
                >
                  {armed === 'selection' ? `Delete ${live.size} — press again` : 'Delete'}
                </Button>
                <Button variant="ghost" size="sm" leftSlot={<X className="size-4" />} onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </span>
            )}
          </div>

          {rows.length === 0 ? (
            <Typography variant="p" className="py-6 text-center text-ink-inactive text-[0.88rem]">
              Nothing matches “{term}”.
            </Typography>
          ) : (
            /* The row is wide by nature - a name, three replay controls, a date and the actions - so when the
               window cannot hold it, this scrolls rather than the page. A page that slides sideways is the
               worse of the two. */
            <ul
              className="flex flex-col gap-1.5 overflow-x-auto pb-1"
              data-has-selection={live.size > 0 ? '' : undefined}
            >
              {visible.map((rec) => {
                const s = summarize(rec.events);
                const replay = replayOf(rec);
                const where = rec.windows.map((w) => w.title).filter(Boolean).join(', ');
                const isSelected = live.has(rec.id);
                const isViewing = viewing === rec.id;

                return (
                  <li key={rec.id}>
                    <Card
                      variant="row"
                      fullWidth
                      className={cn(
                        'h-auto min-w-[56rem] gap-x-3 py-1.5',
                        isSelected && 'border-brand-primary bg-state-pressed shadow-sm',
                        isViewing && !isSelected && 'border-brand-primary',
                      )}
                      onClick={() => onView(rec)}
                    >
                      <span onClick={(ev) => ev.stopPropagation()} className="flex flex-none items-center">
                        <Checkbox
                          checked={isSelected}
                          aria-label={`Select ${rec.name}`}
                          onCheckedChange={() => toggle(rec.id)}
                        />
                      </span>

                      {/* The name is editable in place, as it was. Renaming a recording is the commonest thing
                          anybody does to one, and a dialog for it would be three clicks. */}
                      <span className="flex min-w-[12rem] flex-1 flex-col gap-0.5" onClick={(ev) => ev.stopPropagation()}>
                        <input
                          value={rec.name}
                          onChange={(ev) => update((prev) => ({
                            recordings: prev.recordings.map((r) => (r.id === rec.id
                              ? { ...r, name: ev.target.value }
                              : r)),
                          }))}
                          aria-label="Recording name"
                          className={cn(
                            'w-full rounded-md border border-transparent bg-transparent px-1 py-0.5',
                            'font-semibold text-ink-primary hover:border-stroke',
                            'focus:border-input-focus focus:outline-none',
                          )}
                        />
                        <span className="px-1 text-[0.76rem] text-ink-inactive">
                          {s.count} events · {s.clicks} clicks · {fmtMs(s.durationMs)}
                          {where ? ` · ${where.slice(0, 48)}` : ''}
                        </span>
                      </span>

                      {/* The three questions a replay asks, on the row that answers them. */}
                      <span
                        className="flex flex-none items-center gap-2 text-[0.76rem] text-ink-secondary"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <label className="flex items-center gap-1" title="How many times this recording repeats">
                          <Repeat className="size-3.5" />
                          <input
                            type="number"
                            min={1}
                            max={999}
                            value={replay.repeat}
                            aria-label="Repeat"
                            onChange={(ev) => setReplay(rec.id, { repeat: Math.max(1, Number(ev.target.value) || 1) })}
                            className="w-12 rounded border-stroke border bg-surface-card2 px-1 py-0.5 text-ink-primary tabular-nums focus:border-input-focus focus:outline-none"
                          />
                        </label>

                        <label className="flex items-center gap-1" title="Replay speed. The recorded delays are divided by this.">
                          <select
                            value={replay.speed}
                            aria-label="Speed"
                            onChange={(ev) => setReplay(rec.id, { speed: Number(ev.target.value) || 1 })}
                            className="rounded border-stroke border bg-surface-card2 px-1 py-0.5 text-ink-primary focus:border-input-focus focus:outline-none"
                          >
                            {SPEEDS.map((speed) => (
                              <option key={speed} value={speed}>{speed}×</option>
                            ))}
                          </select>
                        </label>

                        <label
                          className="flex items-center gap-1.5"
                          title="Keep repeating until you stop it. The toolbar icon becomes the stop button."
                        >
                          <Checkbox
                            checked={replay.loop}
                            aria-label="Loop"
                            onCheckedChange={(next) => setReplay(rec.id, { loop: next === true })}
                          />
                          Loop
                        </label>
                      </span>

                      <span className="flex-none text-[0.76rem] text-ink-secondary tabular-nums">
                        {new Date(rec.created).toLocaleDateString()}
                      </span>

                      {/* Visible rather than revealed on hover: these were asked for as labels, and nobody
                          hovers a row to find out that Export exists. */}
                      <span className="flex flex-none items-center gap-1" onClick={(ev) => ev.stopPropagation()}>
                        {/* Icon only, with a title: Play and Add to flow are the two that do not need a word,
                            and six labelled buttons wrapped the row onto a third line. The four the owner
                            asked to see as labels - View, Save as skill, Export, Delete - keep them. */}
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Play ${rec.name}`}
                          title={`Play now — ${replay.repeat}x at ${replay.speed}x${replay.loop ? ', looping' : ''}`}
                          className="!size-8 !p-0"
                          onClick={() => onPlay(rec)}
                        >
                          <Play className="size-4" />
                        </Button>
                        <Button
                          variant={isViewing ? 'secondary' : 'ghost'}
                          size="sm"
                          leftSlot={<Eye className="size-4" />}
                          onClick={() => onView(rec)}
                        >
                          View
                        </Button>
                        <Button variant="ghost" size="sm" leftSlot={<Save className="size-4" />} onClick={() => onSaveAsSkill(rec)}>
                          Save as skill
                        </Button>
                        <Button variant="ghost" size="sm" leftSlot={<Download className="size-4" />} onClick={() => exportOne(rec)}>
                          Export
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Add ${rec.name} to the flow`}
                          title="Add to the flow below, with this repeat and speed"
                          className="!size-8 !p-0"
                          onClick={() => update((prev) => ({
                            flow: [...prev.flow, {
                              recordingId: rec.id,
                              repeat: replay.repeat,
                              speed: replay.speed,
                              delayAfterMs: 0,
                            }],
                          }))}
                        >
                          <Plus className="size-4" />
                        </Button>
                        <Button
                          variant={armed === rec.id ? 'destructive' : 'destructiveTertiary'}
                          size="sm"
                          leftSlot={<Trash2 className="size-4" />}
                          onClick={() => {
                            if (armed !== rec.id) { setArmed(rec.id); return; }
                            remove([rec.id]);
                          }}
                        >
                          {armed === rec.id
                            ? (() => {
                              const inFlow = state.flow.filter((f) => f.recordingId === rec.id).length;
                              return inFlow ? `Delete — used by ${inFlow} step(s)` : 'Delete — press again';
                            })()
                            : 'Delete'}
                        </Button>
                      </span>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}

          {rows.length > visible.length && (
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE)}>
                Load more ({rows.length - visible.length} left)
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
};
