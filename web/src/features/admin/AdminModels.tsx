/* What each part of the product thinks with.
 *
 * Four engines, four choices, and a change reaches the NEXT run everywhere - the web app, the extension,
 * the dashboard assistant - without a deploy. Before this they were five constants in three artifacts, two
 * of which only wrote the model name into the run log and were never updated with the others, so changing
 * a model made the history lie.
 */
import { useState } from 'react';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { CARD, NotFound, adminPatch, useAdmin } from './shell';

interface Setting { key: string; about: string; value: string | null; choices: string[] }

const LABELS: Record<string, string> = {
  'model.desktop': 'Desktop engine',
  'model.plan': 'Plan preview',
  'model.extension': 'Browser extension',
  'model.chat_default': 'Assistant default',
};

export const AdminModels = () => {
  const { data, failed, refused, setData } = useAdmin<{ settings: Setting[] }>('settings');
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const save = async (key: string, value: string) => {
    setSaving(key);
    setNote(null);
    setProblem(null);
    /* Shown as chosen straight away, then confirmed - a select that snaps back while a request is in
     * flight reads as a control that does not work. */
    setData((was) => (was
      ? { settings: was.settings.map((s) => (s.key === key ? { ...s, value: value || null } : s)) }
      : was));
    try {
      await adminPatch(key, value);
      setNote(value
        ? `${LABELS[key] ?? key} → ${value}. The next run uses it.`
        : `${LABELS[key] ?? key} back to the built-in default.`);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'could not save');
      /* Put back what the server still holds. */
      try {
        const fresh = await fetch('/api/admin?view=settings', { credentials: 'same-origin' });
        const body = await fresh.json();
        if (body && body.settings) setData({ settings: body.settings });
      } catch (_) { /* leave the optimistic value; the note says it failed */ }
    } finally {
      setSaving(null);
    }
  };

  if (refused) return <NotFound />;
  if (failed) {
    return <Typography variant="p" className="text-fb-red-text text-[0.88rem]">{failed}</Typography>;
  }
  if (!data) return <Typography variant="p" className="text-ink-inactive">Loading…</Typography>;

  return (
    <div className="grid max-w-[860px] gap-3">
      <Typography variant="p" className="text-ink-inactive text-[0.86rem] leading-relaxed">
        A change reaches the next run everywhere — the web app, the extension and the dashboard assistant —
        without a deploy. <span className="text-ink-body">default</span> means the model compiled into the
        code, so clearing a choice is always a way back.
      </Typography>

      {note && <div className="rounded-lg border border-brand-primary/40 bg-brand-primary/10 px-3.5 py-2.5 text-[0.85rem] text-ink-body">{note}</div>}
      {problem && <div className="rounded-lg border border-toast-border-error bg-toast-bg-error px-3.5 py-2.5 text-[0.85rem] text-fb-red-text">{problem}</div>}

      {data.settings.map((s) => (
        <div key={s.key} className={cn(CARD, 'flex flex-wrap items-center gap-3 p-3.5')}>
          <div className="min-w-[240px] flex-1">
            <div className="font-medium text-[0.92rem] text-ink-primary">{LABELS[s.key] ?? s.key}</div>
            <div className="text-[0.79rem] text-ink-inactive leading-snug">{s.about}</div>
            <div className="mt-0.5 font-mono text-[0.72rem] text-ink-inactive">{s.key}</div>
          </div>
          <select
            value={s.value ?? ''}
            disabled={saving === s.key}
            onChange={(e) => void save(s.key, e.target.value)}
            className="h-9 min-w-[220px] rounded-md border border-stroke bg-surface-input px-2.5 text-[0.86rem] text-ink-primary focus:border-brand-primary focus:outline-none disabled:opacity-60"
          >
            <option value="">default</option>
            {s.choices.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
};
