/* The skills this browser can run, in reach of the page they run on.
 *
 * Deliberately NOT the app's library. The app lists everything on the account, desktop and browser alike,
 * with structure, publishing and SKILL.md; this lists what can run HERE and gives it one button. A 400px
 * panel is a bad place to read a definition and a good place to press "run".
 *
 * The same selection bar, pills and search box the app uses - literally the same files - because a skill
 * row should not be a different object in the two places somebody meets it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, MousePointerClick, Play, Sparkles } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Checkbox } from '@insightis/ui/Checkbox';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { Said, type SaidNote } from '@/components/Said';
import { SearchField } from '@/components/SearchField';
import { SelectionBar } from '@/components/SelectionBar';
import { ask, openApp } from './worker';

interface Skill {
  id: string;
  name: string;
  kind?: 'recorded' | 'created';
  description?: string;
  goal?: string;
  goalTemplate?: string;
  lastRun?: string;
}

export const SkillsScreen = () => {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [term, setTerm] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<SaidNote | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const read = useCallback(async () => {
    const res = await ask('skills/list');
    if (res.ok) setSkills((res.skills as Skill[]) ?? []);
  }, []);

  useEffect(() => { void read(); }, [read]);

  const shown = useMemo(() => {
    const needle = term.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((s) => `${s.name} ${s.description ?? ''}`.toLowerCase().includes(needle));
  }, [skills, term]);

  /* The same rule as every list in the app: a tick only counts while its row is on screen. */
  const live = useMemo(
    () => new Set([...picked].filter((id) => shown.some((s) => s.id === id))),
    [picked, shown],
  );

  const run = async (skill: Skill) => {
    setBusy(skill.id);
    setNote(null);
    const res = await ask('skills/run', { id: skill.id });
    setBusy(null);
    setNote(res.ok
      ? { text: `Running "${skill.name}".`, kind: 'good' }
      : { text: res.error ?? 'It would not run.', kind: 'bad' });
  };

  const removePicked = async () => {
    const going = shown.filter((s) => live.has(s.id));
    setBusy('selection');
    let gone = 0;
    const failed: string[] = [];
    /* One at a time, and what failed is named - the worker deletes by id and has no list form. */
    for (const skill of going) {
      const res = await ask('skills/delete', { id: skill.id });
      if (res.ok) gone += 1; else failed.push(skill.name);
    }
    setBusy(null);
    setPicked(new Set());
    await read();
    setNote(failed.length
      ? { text: `Deleted ${gone}. Could not delete ${failed.join(', ')}.`, kind: 'bad' }
      : { text: `Deleted ${gone} skill${gone === 1 ? '' : 's'}.`, kind: 'good' });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <header className="flex items-center justify-between gap-2">
        <Typography variant="h2" weight="semibold" className="text-[1.05rem]">Skills</Typography>
        <Button
          variant="ghost"
          size="xs"
          title="The whole library, with structure and publishing — opens the app in a tab"
          onClick={() => openApp('/skills')}
          leftSlot={<ExternalLink className="size-3.5" />}
        >
          All of them
        </Button>
      </header>

      <SearchField value={term} onChange={setTerm} placeholder="Search skills…" />

      <SelectionBar
        size="xs"
        total={shown.length}
        selected={live.size}
        onSelectAll={(all) => setPicked(all ? new Set(shown.map((s) => s.id)) : new Set())}
        onClear={() => setPicked(new Set())}
        onConfirm={() => void removePicked()}
        busy={busy === 'selection'}
        busyLabel="Deleting…"
        label={(
          <Typography variant="span" className="text-ink-secondary">
            {shown.length} skill{shown.length === 1 ? '' : 's'}
            {shown.length !== skills.length ? ` of ${skills.length}` : ''}
          </Typography>
        )}
      />

      <Said note={note} onDismiss={() => setNote(null)} />

      {shown.length === 0 ? (
        <Typography variant="p" className="py-6 text-center text-ink-inactive text-[0.82rem]">
          {term
            ? `Nothing matches “${term}”.`
            : 'Nothing here yet. Record a flow, or make one on the Create screen, and keep it as a skill.'}
        </Typography>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
          {shown.map((skill) => {
            const ticked = live.has(skill.id);
            return (
              <li key={skill.id}>
                <div
                  className={cn(
                    'flex items-center gap-2 rounded-lg border border-stroke/45 bg-surface-card px-2.5 py-2',
                    'transition-colors duration-fast hover:border-card-border-hover',
                    ticked && 'border-brand-primary bg-state-pressed',
                  )}
                >
                  <Checkbox
                    checked={ticked}
                    aria-label={`Select ${skill.name}`}
                    onCheckedChange={() => setPicked((was) => {
                      const next = new Set(was);
                      if (!next.delete(skill.id)) next.add(skill.id);
                      return next;
                    })}
                  />
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-card2">
                    {skill.kind === 'created'
                      ? <Sparkles className="size-3.5 text-brand-tertiary" />
                      : <MousePointerClick className="size-3.5 text-brand-primary" />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
                    <span className="truncate font-semibold text-[0.84rem] text-ink-primary">{skill.name}</span>
                    <span className="truncate text-[0.72rem] text-ink-inactive">
                      {skill.description || (skill.kind === 'created' ? 'A goal, carried out here' : 'A recording, replayed here')}
                    </span>
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Run ${skill.name}`}
                    title="Run it on this page"
                    disabled={busy === skill.id}
                    onClick={() => void run(skill)}
                    leftSlot={<Play className="size-3.5" />}
                  >
                    Run
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
