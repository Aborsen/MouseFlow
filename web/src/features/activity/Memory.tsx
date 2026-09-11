/* «What MouseFlow has learned» — MEMORY-PLAN.md §4.12, §5 шаг 5. Третья карточка на Activity, тем же
 * ободком и той же высотой окна, что у остальных двух (см. заголовок ActivityView.tsx).
 *
 * ЧЕТЫРЕ ПРОВЕНАНСА, НЕ ОДИН СПИСОК. `builtin` - код, читается статикой (`builtinEntries`, api/_memory.mjs),
 * его не редактируют и не удаляют. `taught` - редактируется и удаляется, потому что это правка человека.
 * `derived`/`learned` показаны, но без кнопок правки (derived пересчитывается само; learned без
 * approve/reject - шаг 6, "или никогда" по самому плану, здесь не построен) - таблица 4.4 говорит это
 * прямо: approval нужен только learned, а его здесь пока не бывает вовсе.
 *
 * ОТКАЗ ФОРМЫ - СЛОВАМИ СЕРВЕРА, а не проверкой на странице: редакция (writeMemory) одна, на сервере, и
 * страница не пытается угадать, что она скажет, - то же решение, что у ScheduleFor с `why`.
 */
import { Brain, Pencil, Trash2, TriangleAlert } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { type AppMemoryEntry, type BuiltinMemoryEntry, appMemory, forgetMemory, teachMemory } from '@/lib/api';

const ROW = 'rounded-lg border-stroke/45 border bg-surface-card2 px-3 py-2';
/* Шесть строк, как у Schedules - тот же довод: список, у которого нет своей страницы, не должен расти
 * без предела внутри той, у которой их несколько. */
const LIST_HEIGHT = 'calc(6 * 5.5rem)';

const PROVENANCE_LABEL: Record<AppMemoryEntry['provenance'], string> = {
  taught: 'taught',
  derived: 'derived',
  learned: 'learned',
};

const Chip = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' }) => (
  <span
    className={cn(
      'inline-flex items-center rounded-full px-2 py-0.5 text-[0.72rem] font-semibold whitespace-nowrap',
      tone === 'accent' ? 'bg-brand-primary/12 text-brand-primary' : 'bg-surface-chips text-ink-inactive',
    )}
  >
    {children}
  </span>
);

export const Memory = ({ reloadKey }: { reloadKey: number }) => {
  const [entries, setEntries] = useState<AppMemoryEntry[]>([]);
  const [builtin, setBuiltin] = useState<BuiltinMemoryEntry[]>([]);
  const [gone, setGone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [key, setKey] = useState('');
  const [body, setBody] = useState('');
  const [why, setWhy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await appMemory();
      setEntries(res.entries);
      setBuiltin(res.builtin);
      setGone(null);
    } catch (err) {
      /* НЕ ПРИМЕНЕНА МИГРАЦИЯ читается тем же путём, что и у Schedules: сервер отвечает 503 своими
       * словами (см. api/memory.js), и здесь их достаточно показать, не изобретая вторых. */
      setGone(err instanceof Error ? err.message : 'the memory could not be read');
    }
  }, []);

  useEffect(() => { void load(); }, [load, reloadKey]);

  const resetForm = () => { setKey(''); setBody(''); setWhy(null); setEditing(null); setShowForm(false); };

  const startEdit = (entry: AppMemoryEntry) => {
    setEditing(entry.id);
    setKey(entry.key);
    setBody(entry.body);
    setWhy(null);
    setShowForm(true);
  };

  const submit = async () => {
    setSaving(true);
    setWhy(null);
    try {
      await teachMemory({ key: key.trim(), body: body.trim(), ...(editing ? { id: editing } : {}) });
      resetForm();
      await load();
    } catch (err) {
      /* Отказ показывается тут же, у полей: он почти всегда про то, что только что набрали
       * (координата, адрес почты, ключ не той формы), и читать его надо не отрываясь от формы. */
      setWhy(err instanceof Error ? err.message : 'it could not be remembered');
    } finally {
      setSaving(false);
    }
  };

  const removeOne = async (entry: AppMemoryEntry) => {
    if (!window.confirm(`Forget this about ${entry.key}?\n\n"${entry.body}"`)) return;
    setBusy(entry.id);
    try {
      await forgetMemory(entry.id);
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (gone) {
    return (
      <section className="mb-4 rounded-xl border-fb-red/40 border bg-surface-card p-4">
        <div className="flex items-center gap-1.5">
          <TriangleAlert className="size-4 text-fb-red-text" />
          <Typography variant="span" weight="semibold" className="text-[0.9rem] text-fb-red-text">
            The memory could not be read
          </Typography>
        </div>
        <Typography variant="p" className="mt-1 max-w-[70ch] break-words text-ink-secondary text-[0.85rem]">
          {gone}
        </Typography>
        <Button size="sm" variant="secondary" className="mt-2.5" onClick={() => void load()}>Try again</Button>
      </section>
    );
  }

  const total = entries.length + builtin.length;

  return (
    <section className="mb-4 rounded-xl border-stroke border bg-surface-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Brain className="size-4 shrink-0 text-brand-primary" aria-hidden />
        <Typography variant="h2" weight="semibold" className="text-[1rem]">
          What MouseFlow has learned
        </Typography>
        <Typography variant="span" className="text-[0.8rem] text-ink-inactive">
          {total} fact{total === 1 ? '' : 's'}
        </Typography>
        <Button size="xs" variant="ghost" className="ms-auto" onClick={() => (showForm ? resetForm() : setShowForm(true))}>
          {showForm ? 'Cancel' : '+ Teach it something'}
        </Button>
      </div>
      <Typography variant="p" className="mt-1 max-w-[80ch] text-ink-secondary text-[0.84rem]">
        Names of controls, the stable part of a title, where an unnamed press lands — never a coordinate, a
        typed value, or a password field. Applied only to the applications open when a run acts, never to a
        check that judges one.
      </Typography>

      {showForm && (
        <div className="mt-2.5 rounded-lg border-stroke/45 border bg-surface-card2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="win32:Outlook, web:mail.google.com…"
              aria-label="Which application — win32:, darwin: or web: followed by the process or origin"
              className="h-8 w-full rounded-md border-stroke border bg-surface-card px-2.5 font-mono text-[0.82rem] text-ink-primary focus:border-input-focus focus:outline-none sm:w-[16rem]"
            />
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder='The send button has no name; it sits just right of "Attach".'
            aria-label="What to remember about it"
            rows={2}
            className="mt-2 w-full rounded-md border-stroke border bg-surface-card px-2.5 py-1.5 text-[0.85rem] text-ink-primary focus:border-input-focus focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" isLoading={saving} disabled={!key.trim() || !body.trim()} onClick={() => void submit()}>
              {editing ? 'Save' : 'Remember it'}
            </Button>
            <Button size="sm" variant="ghost" onClick={resetForm}>Cancel</Button>
          </div>
          {why && (
            <Typography variant="p" className="mt-1.5 max-w-[80ch] break-words text-fb-red-text text-[0.8rem]">
              {why}
            </Typography>
          )}
        </div>
      )}

      {total === 0 ? (
        <Typography variant="p" className="mt-2 text-[0.88rem] text-ink-inactive">
          Nothing yet — this fills in on its own from recordings, or you can teach it something above.
        </Typography>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5 overflow-y-auto pe-1" style={{ maxHeight: LIST_HEIGHT }}>
          {entries.map((entry) => (
            <li key={entry.id} className={cn(ROW, 'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1')}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="truncate font-mono text-[0.8rem] text-ink-primary">{entry.key}</span>
                  <Chip tone={entry.provenance === 'taught' ? 'accent' : 'neutral'}>
                    {PROVENANCE_LABEL[entry.provenance]}
                    {entry.provenance === 'derived' && entry.version ? ` v${entry.version}` : ''}
                    {entry.state !== 'live' ? ` · ${entry.state}` : ''}
                  </Chip>
                </div>
                <div className="mt-0.5 break-words text-[0.82rem] text-ink-secondary">{entry.body}</div>
              </div>
              {entry.provenance === 'taught' && (
                <span className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="xs" aria-label={`Edit what is remembered about ${entry.key}`} onClick={() => startEdit(entry)}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="destructiveOutline"
                    size="xs"
                    isLoading={busy === entry.id}
                    aria-label={`Forget this about ${entry.key}`}
                    onClick={() => void removeOne(entry)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </span>
              )}
            </li>
          ))}
          {builtin.map((entry, i) => (
            <li key={`builtin-${i}`} className={cn(ROW, 'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 opacity-80')}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="truncate font-mono text-[0.8rem] text-ink-primary">{entry.scope}</span>
                  <Chip>built in</Chip>
                </div>
                <div className="mt-0.5 break-words text-[0.82rem] text-ink-secondary">{entry.body}</div>
              </div>
              <span />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
