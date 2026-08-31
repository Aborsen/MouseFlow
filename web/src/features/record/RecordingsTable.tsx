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
import { Checkbox } from '@insightis/ui/Checkbox';
import { Pill } from '@/components/Pill';
import { SearchField } from '@/components/SearchField';
import { SelectionBar } from '@/components/SelectionBar';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { ArmedButton } from '@/components/ArmedButton';
import { SortButton } from '@/components/SortButton';
import {
  Cloud, Download, Eye, Loader2, Play, Repeat, Check, Ellipsis, Sparkles, Upload, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { exportMacro, fmtMs, summarize } from '@/lib/macro';
import { Signal } from '@/components/Signal';
import { type Flow, push } from '@/lib/api';
import { useAccount } from '@/shell/AccountProvider';
import { type RecordedEvent, type Recording, useConsole } from '@/lib/store';
import { eventsAreHere, eventsFor } from './events-for';
import { useSending } from './sending';

/* How many rows before Load more. Ten is theirs, and it is about the point where a list stops being
 * scannable rather than a number with a reason behind it. */
const PAGE = 10;

const SPEEDS = [0.5, 1, 1.5, 2, 4];

/* One grid template for the header and every row, which is what makes a label sit over the column it names.
 * The name column is the only one that flexes; everything else is FIXED, including the actions.
 *
 * The actions column was `auto` first, and that is why the header and the rows disagreed by 280px while being
 * exactly the same width: `auto` sizes to content, the header's word ACTIONS is narrow, four buttons are not,
 * so the 1fr name column absorbed a different amount of space in each. A shared template only shares if every
 * track but one is fixed. */
/* The wide shape, and only where it fits - see the same note in SkillsView. Under `md` the row stacks,
 * which is what makes this table readable in a narrow window and in the extension's side panel. */
const COLUMNS = 'md:grid-cols-[1.25rem_minmax(11rem,1fr)_7rem_6.5rem_7rem_16.5rem]';

/* Sortable columns, the same arrangement the skills table uses.
 *
 * `Signal` is a sparkline, and there is nothing alphabetical about a picture - it sorts on how much is IN
 * the recording, which is what somebody scanning that column is actually reading off it. */
type SortKey = 'name' | 'size' | 'created' | 'status';

const SORTABLE: { key: SortKey; label: string; title?: string }[] = [
  { key: 'name', label: 'Recording' },
  { key: 'size', label: 'Signal', title: 'Sort by how much was recorded' },
  { key: 'created', label: 'Captured' },
  { key: 'status', label: 'Status', title: 'Sort by whether a skill has been made from it' },
];

export interface RecordingsTableProps {
  /** Recordings the ACCOUNT has that this browser does not. Answered by the caller, which is the half that
   * can see both. Empty when there are none, and then nothing is shown. */
  orphans?: Flow[];
  /** Pull one into this browser, events and all. */
  onAdopt?: (flow: Flow) => void;
  /** Whether a skill has been made from this recording. Answered by the caller, which is the half that can
   * see the account - the skill is a separate row, not a flag on the recording. Absent means "cannot tell",
   * which reads as Ready rather than as no. */
  hasSkill?: (rec: Recording) => boolean;
  /** Save as skill lives on the page, because it also has to report what happened. */
  /* The other way to make one: the wizard, which asks for the text a recording is not allowed to hold and
   * produces a skill with parameters. Offered beside the literal copy rather than instead of it - the two
   * are different things, and a recording that already has one may still want the other. */
  onMakeSkill: (rec: Recording) => void;
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
  onMakeSkill,
  onView,
  onPlay,
  onImport,
  viewing,
  hasSkill,
  orphans,
  onAdopt,
}: RecordingsTableProps) => {
  /* Что прямо сейчас едет на аккаунт. Список смотрит на все строки, поэтому подписка на весь
   * реестр - см. useSending против useIsSending в sending.ts. */
  const sending = useSending();
  const [state, update] = useConsole();
  const { reload, readFailed } = useAccount();
  const [term, setTerm] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /* Delete arms in the button rather than in a confirm() - the same pattern MyAccountScreen uses, and for the
   * same reason: a dialog is easy to click through and a second one is easy to lose behind the first. */
  const [armed, setArmed] = useState<string | null>(null);
  /* Which row has its replay controls open. One at a time: two open panels push the list twice and the
   * second one is never the one being looked at. */
  const [openRow, setOpenRow] = useState<string | null>(null);
  /* Что пошло не так с этой строкой - и раньше это было только про удаление. Теперь ещё и про экспорт,
   * который не смог забрать события с аккаунта: тихо скачать файл на 1КБ вместо четырёхчасовой записи
   * значило бы отдать пустой экспорт под видом успешного. Сообщения об успехе по-прежнему нет: удалённая
   * строка это и есть вся обратная связь. */
  const [gone, setGone] = useState<string | null>(null);
  /* Разоружается сам через шесть секунд: кнопка, снимающая несколько записей с аккаунта, не должна оставаться
   * взведённой, пока человек читает, что она делает. */
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!clearing) return;
    const timer = setTimeout(() => setClearing(false), 6000);
    return () => clearTimeout(timer);
  }, [clearing]);
  const fileInput = useRef<HTMLInputElement>(null);

  /* Newest at the top to begin with: the recording someone is looking for is almost always the one they
   * just made, and the store appends, so raw order buried it at the bottom of the scroll. Clicking a
   * column takes over from there. */
  const [sort, setSort] = useState<{ by: SortKey; asc: boolean }>({ by: 'created', asc: false });
  const sortBy = useCallback((by: SortKey) => {
    setSort((was) => (was.by === by ? { by, asc: !was.asc } : { by, asc: by === 'name' }));
  }, []);

  const rows = useMemo(() => {
    const needle = term.trim().toLowerCase();
    const kept = needle
      ? state.recordings.filter((rec) => {
        const where = rec.windows.map((w) => `${w.title} ${w.process}`).join(' ');
        return `${rec.name} ${where}`.toLowerCase().includes(needle);
      })
      : [...state.recordings];

    /* numeric, so "MouseFlow 24/08 9:00" sorts before "… 10:00" rather than after it - every default name
     * this app writes is a date and a time. */
    const cmp = (a: Recording, b: Recording) => {
      switch (sort.by) {
        case 'name':
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        case 'size':
          return (a.summary?.count ?? a.events.length) - (b.summary?.count ?? b.events.length);
        case 'status':
          return Number(!!hasSkill?.(a)) - Number(!!hasSkill?.(b));
        default:
          return (a.created ?? '').localeCompare(b.created ?? '');
      }
    };
    return kept.sort((a, b) => (sort.asc ? cmp(a, b) : cmp(b, a)));
  }, [state.recordings, term, sort, hasSkill]);

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

  /* Deleting a recording deletes it in both places.
   *
   * This used to touch localStorage only, so the account kept the row and everything that reads the account
   * went on seeing it - the assistant, the dashboard, get_transcript. Which is what somebody hit: they
   * deleted recordings, the list emptied, and the assistant still listed six. Nothing was wrong with the
   * assistant; the delete had never left the browser.
   *
   * Local first, because that is what was asked for and it must not wait on the network. Then the tombstone,
   * which is the same push the Skills page uses - a delete has to be able to PROPAGATE rather than have the
   * recording reappear from the next machine that syncs, which is why the row is stamped rather than erased.
   *
   * A failed push is said out loud. Silence here means "the assistant can still see it", and that is exactly
   * the confusion this is fixing. */
  const remove = useCallback(async (ids: string[]) => {
    update((prev) => ({
      recordings: prev.recordings.filter((rec) => !ids.includes(rec.id)),
      /* Flows are not being built at the moment, but the store still carries the field and a step pointing at
       * a recording that no longer exists would fail at replay time and say nothing. Cheaper to keep tidy
       * than to remember later. */
      flow: prev.flow.filter((step) => !ids.includes(step.recordingId)),
    }));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    setArmed(null);
    setGone(null);

    try {
      const saved = await push({ deleted: ids });
      if (saved.problems.length) throw new Error(saved.problems.join('; '));
      await reload();
    } catch (err) {
      setGone(`Removed ${ids.length === 1 ? 'it' : `${ids.length} of them`} from this browser, but the `
        + `account still has ${ids.length === 1 ? 'it' : 'them'}: ${
          err instanceof Error ? err.message : 'the sync failed'
        }. The assistant and the dashboard read the account, so they will still count `
        + `${ids.length === 1 ? 'it' : 'them'}.`);
    }
  }, [update, reload]);

  const exportOne = useCallback(async (rec: Recording) => {
    /* Забрать с аккаунта, если здесь их нет: файл на 1 КБ вместо четырёхчасовой записи выглядит как
     * успешный экспорт и обнаруживается через неделю. См. events-for.ts. */
    let events: RecordedEvent[];
    try {
      events = await eventsFor(rec);
    } catch (err) {
      setGone(err instanceof Error ? err.message : 'those events could not be fetched');
      return;
    }
    const blob = new Blob([exportMacro({ ...rec, events })], { type: 'text/plain' });
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
        /* Two different facts, said differently. "You have none" and "yours could not be read" look
         * identical from here and mean opposite things - and on a machine that holds nothing locally, which
         * is every newly signed-in phone, the second one is the one that matters. */
        readFailed ? (
          <div className="grid gap-2">
            <Typography variant="p" className="text-ink-body text-[0.88rem]">
              Your recordings could not be read from your account, so this list is showing only what is on
              this device — which may be nothing. They are not lost.
            </Typography>
            <div>
              <Button variant="secondary" size="sm" onClick={() => { void reload(); }}>
                Try again
              </Button>
            </div>
          </div>
        ) : (
          <Typography variant="p" className="text-ink-inactive text-[0.88rem]">
            No recordings yet. Press <strong>Start recording</strong>, or import a <code>.mmmacro</code>
            {' '}file from Mini Mouse Macro.
          </Typography>
        )
      ) : (
        <>
          {/* Строки, оставшиеся на аккаунте без локальной копии.
            *
            * Их не было видно нигде: таблица рисует то, что в браузере, а дашборд и ассистент читают аккаунт -
            * поэтому «я удалил, а он всё равно их видит». Два выхода, и ни одного автоматического: сирота
            * может быть записью с другой машины, которую как раз и хотят получить здесь. */}
          {orphans && orphans.length > 0 && (
            <div className="mt-3 rounded-lg border-stroke/60 border bg-surface-card2 px-3 py-2">
              <Typography variant="p" className="max-w-[80ch] text-ink-inactive text-[0.82rem]">
                {/* No longer an offer to sync, because signing in already does that - and an offer was the
                  * problem: it meant two devices could quietly hold different sets. What is left here is
                  * what reconciling deliberately did NOT bring: rows with no events stored, and older ones
                  * this browser has no room for. */}
                <strong className="text-ink-primary">{orphans.length}</strong>
                {' '}recording{orphans.length === 1 ? '' : 's'} on your account {orphans.length === 1 ? 'is' : 'are'}{' '}
                not held here — either nothing was stored with {orphans.length === 1 ? 'it' : 'them'}, or this
                browser has no room. The dashboard counts {orphans.length === 1 ? 'it' : 'them'} and the
                assistant can read {orphans.length === 1 ? 'it' : 'them'} either way.
              </Typography>
              <div className="mt-2 flex flex-wrap gap-2">
                {/* Still offered, because one of the two reasons is fixable by hand: a row this browser had
                  * no room for can be fetched deliberately if that is the one somebody wants. */}
                {onAdopt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => orphans.forEach((flow) => onAdopt(flow))}
                  >
                    Bring {orphans.length === 1 ? 'it' : 'them'} here
                  </Button>
                )}

                <ArmedButton
                  label="Remove from the account"
                  armedLabel={`Remove ${orphans.length} from the account — press again`}
                  armed={clearing}
                  onArm={() => setClearing(true)}
                  onDisarm={() => setClearing(false)}
                  onConfirm={() => {
                    setClearing(false);
                    void remove(orphans.map((f) => f.id));
                  }}
                />
              </div>
            </div>
          )}

          {gone && (
            <Typography variant="p" className="mb-2.5 max-w-[80ch] break-words text-fb-attention text-[0.8rem]">
              {gone}
            </Typography>
          )}

          <SearchField
            className="mb-2.5 block"
            value={term}
            onChange={(next) => { setTerm(next); setShown(PAGE); }}
            placeholder="Search recordings…"
          />

          <SelectionBar
            className="mb-2"
            total={rows.length}
            selected={live.size}
            onSelectAll={(all) => setSelected(all ? new Set(rows.map((r) => r.id)) : new Set())}
            onClear={() => setSelected(new Set())}
            onConfirm={() => void remove([...live])}
            busyLabel="Deleting…"
            label={(
              <Typography variant="span" className="text-ink-secondary">
                {rows.length} recording{rows.length === 1 ? '' : 's'}
                {term && state.recordings.length !== rows.length ? ` of ${state.recordings.length}` : ''}
              </Typography>
            )}
          >
            {/* The one action a list has that the other two do not: several recordings as several files. */}
            <Button
              variant="ghost"
              size="sm"
              leftSlot={<Download className="size-4" />}
              onClick={() => { void Promise.all(rows.filter((r) => live.has(r.id)).map(exportOne)); }}
            >
              Export
            </Button>
          </SelectionBar>

          {rows.length === 0 ? (
            <Typography variant="p" className="py-6 text-center text-ink-inactive text-[0.88rem]">
              Nothing matches “{term}”.
            </Typography>
          ) : (
            /* The row is wide by nature - a name, three replay controls, a date and the actions - so when the
               window cannot hold it, this scrolls rather than the page. A page that slides sideways is the
               worse of the two. */
            <div className="overflow-x-auto pb-1">
              <div className="md:min-w-[52rem]">
              {/* The labels the controls were missing. Same template as the rows, so they line up rather than
                  approximately line up. */}
              {/* Hidden with the grid: headings over a stack of cards name nothing. */}
              <div
                className={cn(
                  COLUMNS,
                  'hidden w-full items-center gap-x-3 px-3 pb-1.5 md:grid',
                  'text-[0.7rem] uppercase tracking-wide text-ink-inactive',
                )}
              >
                <span />
                {SORTABLE.map(({ key, label, title }) => (
                  <SortButton
                    key={key}
                    label={label}
                    title={title}
                    active={sort.by === key}
                    asc={sort.asc}
                    onClick={() => sortBy(key)}
                  />
                ))}
                <span className="text-right">Actions</span>
              </div>

              <ul
                className="flex flex-col gap-1.5"
                data-has-selection={live.size > 0 ? '' : undefined}
              >
              {visible.map((rec) => {
                /* Сохранённые числа, когда события выложены на аккаунт: считать их по пустому массиву
                   значило бы показать «0 событий» как факт про четырёхчасовую запись. См. `summary` в
                   store.ts. */
                const s = rec.summary ?? summarize(rec.events);
                const replay = replayOf(rec);
                const where = rec.windows.map((w) => w.title).filter(Boolean).join(', ');
                const isSelected = live.has(rec.id);
                const isViewing = viewing === rec.id;

                return (
                  <li key={rec.id}>
                    {/* The row opens what the "..." opens, and nothing more.
                        This used to say "no whole-row click", and what had actually been rejected was the
                        CHAT row's whole treatment: a press-scale that made the row bounce under the pointer,
                        and a click that navigated away. Neither is here. The click unfolds the panel this
                        row already has, View is still the way to the transcript, and anything that is
                        itself a control - the name field, the tick, every button - has already done its own
                        job before this handler is reached. */}
                    <div
                      /* Read by RecordView's click-away: a row is not empty space - clicking one unfolds it,
                       * and that press must not also dismiss the transcript panel. */
                      data-row=""
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('button,input,select,a,[role="checkbox"]')) return;
                        setOpenRow((open) => (open === rec.id ? null : rec.id));
                      }}
                      className={cn(
                        COLUMNS,
                        'flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-1.5',
                        'md:grid md:flex-nowrap',
                        'border border-stroke/45 bg-surface-card shadow-rest transition-colors duration-fast',
                        'hover:border-card-border-hover',
                        isSelected && 'border-brand-primary bg-state-pressed',
                        isViewing && !isSelected && 'border-brand-primary',
                      )}
                    >
                      <span className="flex items-center">
                        <Checkbox
                          checked={isSelected}
                          aria-label={`Select ${rec.name}`}
                          onCheckedChange={() => toggle(rec.id)}
                        />
                      </span>

                      {/* The name is editable in place, as it was. Renaming a recording is the commonest thing
                          anybody does to one, and a dialog for it would be three clicks.

                          CAPPED, because `w-full` in a 1fr column made the field as wide as the column - on a
                          1920 screen with the transcript closed that is around 900px of editable box holding
                          a 24-character name, and the hover border drew all of it. 22rem is comfortably more
                          than the longest default name ("MouseFlow 27/08 17:08:57" is about 180px) and leaves
                          room for a renamed one; `w-full` stays underneath it so a narrow window still fits
                          rather than overflowing. */}
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <input
                          value={rec.name}
                          onChange={(ev) => update((prev) => ({
                            recordings: prev.recordings.map((r) => (r.id === rec.id
                              ? { ...r, name: ev.target.value }
                              : r)),
                          }))}
                          aria-label="Recording name"
                          className={cn(
                            'w-full max-w-[22rem] rounded-md border border-transparent bg-transparent px-1 py-0.5',
                            'font-semibold text-ink-primary hover:border-stroke',
                            'focus:border-input-focus focus:outline-none',
                          )}
                        />
                        <span className="px-1 text-[0.76rem] text-ink-inactive">
                          {s.count} events · {s.clicks} clicks · {fmtMs(s.durationMs)}
                          {where ? ` · ${where.slice(0, 48)}` : ''}
                        </span>
                      </span>

                      {/* Derived from this recording's own events - see Signal. `here` comes from the
                          same helper the export path uses, rather than testing `eventsOnAccount` again:
                          two answers to "are the events here" is how one of them comes to be wrong. */}
                      <span className="flex items-center">
                        <Signal events={rec.events} here={eventsAreHere(rec)} shape={rec.shape} />
                      </span>

                      <span className="text-[0.76rem] text-ink-secondary tabular-nums">
                        {new Date(rec.created).toLocaleDateString()}
                      </span>

                      {/* Read from the account rather than from a flag here: Save as skill writes a separate
                          row, so this asks whether that row exists. "Ready" when it cannot see one, which is
                          also what a skill created from the transcript panel shows - that mints its own id,
                          and under-reporting is a smaller error than claiming a skill that may not be there. */}
                      <span>
                        {/* «Отправляется» ПЕРЕД всем остальным, потому что это единственное состояние, в
                            котором остальные подписи неверны: пока запись едет, её нет на аккаунте, а
                            «Ready» и «Skill saved» оба утверждают, что она там. Секунды на короткой записи
                            и заметное время на четырёхчасовой - см. sending.ts. */}
                        {sending(rec.id) ? (
                          <Pill tone="neutral" title="Still going up to your account">
                            <Loader2 className="size-3 animate-spin" />
                            Sending…
                          </Pill>
                        ) : rec.eventsOnAccount ? (
                          /* НЕ «Ready», потому что «Ready» здесь значит «лежит в этом браузере», а она не
                             лежит: для неё не нашлось места на диске, и её события остались на аккаунте.
                             Сказать «готово» значило бы обещать то, чего в браузере нет. */
                          <Pill tone="neutral" title="Its events are on your account, not in this browser — there was no room here">
                            <Cloud className="size-3" />
                            On your account
                          </Pill>
                        ) : hasSkill?.(rec) ? (
                          <Pill tone="skill">
                            <Sparkles className="size-3" />
                            Skill saved
                          </Pill>
                        ) : (
                          <Pill tone="good">
                            <Check className="size-3" />
                            Ready
                          </Pill>
                        )}
                      </span>

                      {/* Visible rather than revealed on hover: these were asked for as labels, and nobody
                          hovers a row to find out that Export exists. */}
                      {/* Wraps under md, where the row is a card and these are the last line of it. Without it
                          the actions run off the right of a narrow panel and take a scrollbar with them. */}
                      <span className="flex flex-wrap items-center justify-start gap-1 md:flex-nowrap md:justify-end">
                        {/* Play lives in the panel below, beside the repeat, speed and loop it obeys.
                            Up here it was a button that did something different depending on settings you
                            could not see from it - and the row already carries the one that opens them. */}
                        <Button
                          variant={isViewing ? 'secondary' : 'ghost'}
                          size="sm"
                          leftSlot={<Eye className="size-4" />}
                          onClick={() => onView(rec)}
                        >
                          View
                        </Button>
                        {/* ONE skill button, and it makes the kind worth making.
                            *
                            * There were two: "Skill" copied the recording as a literal replay, and an
                            * unlabelled sparkle opened the wizard. Two buttons a word apart in meaning, one
                            * of them wordless, and the wordless one was the better answer nearly every time
                            * - a goal skill re-reads the screen, so it survives a window that moved and it
                            * can type, which a coordinate replay cannot.
                            *
                            * The literal copy is gone from the Skills page too now: one word, one act,
                            * everywhere it is offered. */}
                        <Button
                          variant="ghost" size="sm" leftSlot={<Sparkles className="size-4" />}
                          title="Make a skill — it asks what went into each field, and adapts to a window that moved"
                          onClick={() => onMakeSkill(rec)}
                        >
                          Skill
                        </Button>
                        <Button variant="ghost" size="sm" leftSlot={<Download className="size-4" />} onClick={() => { void exportOne(rec); }}>
                          Export
                        </Button>
                        {/* Everything that is not reached for while scanning: the three replay knobs, and
                            Delete - which belongs behind one deliberate click rather than beside Export. */}
                        <Button
                          variant={openRow === rec.id ? 'secondary' : 'ghost'}
                          size="sm"
                          aria-label={`More for ${rec.name}`}
                          aria-expanded={openRow === rec.id}
                          title="Repeat, speed, loop and delete"
                          className="!size-8 !p-0"
                          onClick={() => setOpenRow((open) => (open === rec.id ? null : rec.id))}
                        >
                          <Ellipsis className="size-4" />
                        </Button>
                      </span>
                    </div>

                    {/* Under the row, not over it. A popover needs positioning, a click-outside, a focus trap
                        and a scroll listener to stay where it was put; this needs none of them and cannot end
                        up half off the screen. The list moving when one opens is honest - something opened. */}
                    {openRow === rec.id && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border-stroke/45 border bg-surface-card2 px-3 py-2.5">
                        <label className="flex items-center gap-1.5 text-[0.78rem] text-ink-secondary">
                          <Repeat className="size-3.5 shrink-0" />
                          Repeat
                          <input
                            type="number"
                            min={1}
                            max={999}
                            value={replay.repeat}
                            aria-label="Repeat"
                            onChange={(ev) => setReplay(rec.id, { repeat: Math.max(1, Number(ev.target.value) || 1) })}
                            className="w-14 rounded border-stroke border bg-surface-card px-1.5 py-0.5 text-ink-primary tabular-nums focus:border-input-focus focus:outline-none"
                          />
                        </label>

                        <label className="flex items-center gap-1.5 text-[0.78rem] text-ink-secondary">
                          Speed
                          <select
                            value={replay.speed}
                            aria-label="Speed"
                            onChange={(ev) => setReplay(rec.id, { speed: Number(ev.target.value) || 1 })}
                            className="rounded border-stroke border bg-surface-card px-1.5 py-0.5 text-ink-primary focus:border-input-focus focus:outline-none"
                          >
                            {SPEEDS.map((speed) => (
                              <option key={speed} value={speed}>{speed}×</option>
                            ))}
                          </select>
                        </label>

                        <label className="flex items-center gap-2 text-[0.78rem] text-ink-secondary">
                          <Checkbox
                            checked={replay.loop}
                            aria-label="Loop"
                            onCheckedChange={(next) => setReplay(rec.id, { loop: next === true })}
                          />
                          Loop until stopped
                        </label>

                        {/* The point of this panel. The three controls beside it are what a replay obeys, and
                            the row's play button is an icon at the far end of the actions - so the place the
                            settings are set gets a Play that says what it will do with them. The icon on the
                            row stays: it is the one you want when you have not touched anything, and removing
                            it would turn a one-click replay into a three-click replay. */}
                        <Button
                          variant="secondary"
                          size="sm"
                          leftSlot={<Play className="size-4" />}
                          title={`Replay ${rec.name} ${replay.loop ? 'until you stop it' : `${replay.repeat} time${replay.repeat === 1 ? '' : 's'}`} at ${replay.speed}× speed`}
                          onClick={() => onPlay(rec)}
                        >
                          Play {replay.loop
                            ? 'on a loop'
                            : `${replay.repeat}×`} at {replay.speed}×
                        </Button>

                        {/* The way out of a cocked delete, said out loud rather than waited for. There IS a
                            timer now - ArmedButton owns it, which is how the four copies of this stopped
                            disagreeing about whether one exists - but six seconds of a cocked destructive
                            button is still six seconds, and "press Cancel" beats "wait and it will pass". */}
                        {armed === rec.id && (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="ms-auto"
                            onClick={() => setArmed(null)}
                          >
                            Cancel
                          </Button>
                        )}

                        {/* Behind one deliberate click, and armed in the button rather than a confirm() -
                            the pattern the rest of the app settled on. */}
                        <ArmedButton
                          label="Delete"
                          className={cn(armed !== rec.id && 'ms-auto')}
                          armed={armed === rec.id}
                          onArm={() => setArmed(rec.id)}
                          onDisarm={() => setArmed(null)}
                          onConfirm={() => void remove([rec.id])}
                        />

                        {/* Closing disarms. A panel that reopened with its delete still cocked would be one
                            click from deleting something, with nothing on screen saying so. */}
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Close these settings"
                          title="Close"
                          className="!size-8 !p-0"
                          onClick={() => { setArmed(null); setOpenRow(null); }}
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                    )}
                  </li>
                );
                })}
                </ul>
              </div>
            </div>
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
