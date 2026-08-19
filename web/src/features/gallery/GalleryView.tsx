/* The gallery: skills other people have published.
 *
 * Reading it needs no account - it is public, which is what lets the extension install from it in one click
 * - but installing here puts a copy on YOUR account, so that is a signed-in act. The copy is yours: rename
 * it, run it, change it.
 */
import { useNavigate } from '@tanstack/react-router';
import { Download, Monitor, Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/ui/components/Button';
import { Typography } from '@/ui/components/Typography';
import { cn } from '@/ui/lib/utils';
import { type GallerySkill, galleryGet, galleryList, push } from '@/lib/api';
import { useAccount } from '@/shell/AccountProvider';
import { adoptRecording } from '@/features/record/adopt';

export const GalleryView = () => {
  const { reload } = useAccount();
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [skills, setSkills] = useState<GallerySkill[] | null>(null);
  const [said, setSaid] = useState<{ text: string; kind: 'good' | 'bad' } | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    setSkills(null);
    try {
      const body = await galleryList(q || undefined);
      setSkills(body.skills);
    } catch (err) {
      setSkills([]);
      setSaid({ text: err instanceof Error ? err.message : 'could not reach the gallery', kind: 'bad' });
    }
  }, []);

  useEffect(() => { void load(''); }, [load]);

  // Debounced, because every keystroke is a request otherwise.
  useEffect(() => {
    const timer = setTimeout(() => { void load(term.trim()); }, 250);
    return () => clearTimeout(timer);
  }, [term, load]);

  const install = useCallback(async (skill: GallerySkill) => {
    setInstalling(skill.id);
    setSaid(null);
    try {
      const body = await galleryGet(skill.id);
      const payload = body.skill.payload as { events?: unknown[]; agent?: string } | undefined;
      if (!payload) throw new Error('that skill has no payload');

      /* Which half can run it is decided by what it points at, not by where it came from: a payload with
       * an `agent: desktop` marker or raw coordinates is a desktop flow, and the extension must not be
       * offered as a way to replay it. */
      const source = payload.agent === 'desktop' ? 'desktop' : 'web';

      const flow = {
        id: `gal_${skill.id}`,
        source,
        kind: body.skill.kind,
        name: body.skill.name,
        description: body.skill.description,
        origins: [] as string[],
        created: body.skill.publishedAt,
        payload,
      };

      const saved = await push({ flows: [flow] });
      if (saved.problems.length) throw new Error(saved.problems.join('; '));
      await reload();
      setSaid({
        text: `Installed "${body.skill.name}". It is in Skills — the copy is yours.`,
        kind: 'good',
      });
    } catch (err) {
      setSaid({ text: err instanceof Error ? err.message : 'could not install that', kind: 'bad' });
    } finally {
      setInstalling(null);
    }
  }, [reload]);

  return (
    <div className="p-5">
      <div className="mb-4 flex max-w-[900px] items-center gap-3">
        <label className="relative min-w-0 flex-1">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-inactive" />
          <input
            value={term}
            onChange={(ev) => setTerm(ev.target.value)}
            placeholder="Search shared skills…"
            className="w-full rounded-md border-stroke border bg-surface-card2 py-2 pl-8 pr-3 text-ink-primary placeholder:text-ink-inactive focus:border-brand-primary focus:outline-none"
          />
        </label>
      </div>

      {said && (
        <Typography
          variant="p"
          className={cn('mb-3 text-[0.86rem]', said.kind === 'bad' ? 'text-fb-red-text' : 'text-fb-green')}
        >
          {said.text}
        </Typography>
      )}

      {skills === null ? (
        <Typography variant="p" className="text-ink-inactive">Loading…</Typography>
      ) : skills.length === 0 ? (
        <Typography variant="p" className="max-w-[60ch] text-ink-inactive">
          {term ? 'Nothing matches that.' : 'Nothing published yet. Publish one of your own from Skills.'}
        </Typography>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {skills.map((skill) => (
            <li key={skill.id} className="flex flex-col rounded-xl border-stroke border bg-surface-card p-3.5">
              <div className="mb-1 flex items-start gap-2">
                <Typography variant="h3" weight="semibold" className="min-w-0 flex-1 text-[0.95rem]">
                  {skill.name}
                </Typography>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[0.7rem] font-semibold',
                    skill.kind === 'created' ? 'bg-brand-tertiary/20 text-brand-tertiary' : 'bg-brand-primary/15 text-brand-primary',
                  )}
                >
                  {skill.kind}
                </span>
              </div>

              <Typography variant="p" className="mb-3 flex-1 text-ink-secondary text-[0.85rem]">
                {skill.description}
              </Typography>

              <div className="mb-2.5 text-[0.76rem] text-ink-inactive">
                by {skill.author.name} · {skill.installs} install{skill.installs === 1 ? '' : 's'} ·{' '}
                {new Date(skill.publishedAt).toLocaleDateString()}
              </div>

              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  leftSlot={<Download className="size-4" />}
                  isLoading={installing === skill.id}
                  onClick={() => void install(skill)}
                >
                  Install
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  leftSlot={<Monitor className="size-4" />}
                  onClick={async () => {
                    try {
                      const body = await galleryGet(skill.id);
                      const payload = body.skill.payload as { events?: unknown[] } | undefined;
                      if (!payload?.events) {
                        setSaid({ text: 'That one has nothing a replay can use.', kind: 'bad' });
                        return;
                      }
                      adoptRecording({
                        id: `gal_${skill.id}`,
                        source: 'desktop',
                        kind: body.skill.kind,
                        name: body.skill.name,
                        description: body.skill.description,
                        origins: [],
                        created: body.skill.publishedAt,
                        payload,
                      });
                      void navigate({ to: '/record' });
                    } catch (err) {
                      setSaid({ text: err instanceof Error ? err.message : 'could not fetch it', kind: 'bad' });
                    }
                  }}
                >
                  Try in Record
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
