/* The gallery, filtered to what this browser can actually run.
 *
 * THE FILTER IS THE POINT. A published skill comes from one of two halves - the extension, which aims at
 * page elements, or the desktop agent, which aims at screen coordinates - and neither runs where the other
 * does. The app lists both because it can hand either to the right place. In here, a desktop skill is a
 * card with a button that cannot work, which is the failure the skills page names in its own header:
 * offering the wrong one is a button that does something meaningless.
 *
 * UNKNOWN IS SHOWN AND LABELLED, not hidden. Every skill published before the gallery recorded which half
 * it came from has no answer (see db/011_gallery_source.sql), and silently hiding them would empty this
 * screen of everything published so far. They are listed with what is true - that nobody recorded where it
 * runs - and installing one is the person's call.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { Pill } from '@/components/Pill';
import { Said, type SaidNote } from '@/components/Said';
import { SearchField } from '@/components/SearchField';
import { ask, openApp } from './worker';

interface Listed {
  id: string;
  name: string;
  description?: string;
  kind?: 'recorded' | 'created';
  source?: 'extension' | 'desktop' | null;
  installs?: number;
  origins?: string[];
}

export const GalleryScreen = () => {
  const [all, setAll] = useState<Listed[]>([]);
  const [term, setTerm] = useState('');
  const [note, setNote] = useState<SaidNote | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const read = useCallback(async (q: string) => {
    const res = await ask('gallery/list', q ? { q } : {});
    if (!res.ok) { setNote({ text: res.error ?? 'The gallery is not answering.', kind: 'bad' }); return; }
    setAll((res.skills as Listed[]) ?? []);
  }, []);

  useEffect(() => { void read(''); }, [read]);

  /* Searched here rather than by asking again on every keystroke: the endpoint takes a `q`, and a request
   * per character is a request per character. The first read brings the page; this narrows it. */
  const shown = useMemo(() => {
    const runnable = all.filter((s) => s.source !== 'desktop');
    const needle = term.trim().toLowerCase();
    if (!needle) return runnable;
    return runnable.filter((s) => `${s.name} ${s.description ?? ''}`.toLowerCase().includes(needle));
  }, [all, term]);

  const hiddenDesktop = all.length - all.filter((s) => s.source !== 'desktop').length;

  const install = async (skill: Listed) => {
    setBusy(skill.id);
    const res = await ask('gallery/install', { id: skill.id });
    setBusy(null);
    setNote(res.ok
      ? { text: `Installed "${skill.name}". It is on the Skills screen.`, kind: 'good' }
      : { text: res.error ?? 'It would not install.', kind: 'bad' });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <header className="flex items-center justify-between gap-2">
        <Typography variant="h2" weight="semibold" className="text-[1.05rem]">Gallery</Typography>
        <Button
          variant="ghost"
          size="xs"
          title="Everything published, both halves — opens the app in a tab"
          onClick={() => openApp('/gallery')}
          leftSlot={<ExternalLink className="size-3.5" />}
        >
          All of it
        </Button>
      </header>

      <SearchField value={term} onChange={setTerm} placeholder="Search the gallery…" />

      <Typography variant="span" className="text-ink-inactive text-[0.74rem]">
        {shown.length} that run in a browser
        {hiddenDesktop > 0 && ` · ${hiddenDesktop} desktop ${hiddenDesktop === 1 ? 'skill' : 'skills'} not shown`}
      </Typography>

      <Said note={note} onDismiss={() => setNote(null)} />

      <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {shown.map((skill) => (
          <li key={skill.id}>
            <div className="flex flex-col gap-1.5 rounded-lg border border-stroke/45 bg-surface-card px-2.5 py-2">
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-semibold text-[0.84rem] text-ink-primary">
                  {skill.name}
                </span>
                {skill.source === 'extension'
                  ? <Pill tone="good">Browser</Pill>
                  : <Pill title="Published before the gallery recorded where a skill runs">Unknown</Pill>}
              </span>
              {skill.description && (
                <span className="line-clamp-2 text-[0.74rem] text-ink-inactive">{skill.description}</span>
              )}
              <span className="flex items-center gap-2">
                <span className="text-[0.7rem] text-ink-inactive tabular-nums">
                  {skill.installs ?? 0} installs
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  className="ms-auto"
                  disabled={busy === skill.id}
                  onClick={() => void install(skill)}
                  leftSlot={<Download className="size-3.5" />}
                >
                  Install
                </Button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};
