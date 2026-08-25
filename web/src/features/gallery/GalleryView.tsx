/* The gallery: skills other people have published.
 *
 * Reading it needs no account - it is public, which is what lets the extension install from it in one click
 * - but installing here puts a copy on YOUR account, so that is a signed-in act. The copy is yours: rename
 * it, run it, change it.
 *
 * Two views of the same data, and the second exists because the first cannot be both. Browsing wants rows:
 * a few from each grouping, side by side, so somebody who does not know what they are looking for can see
 * the shape of the library. Looking for something wants a grid: all of one grouping, filtered, sorted,
 * paged. A page that tries to do both ends up with twelve cards in no order anybody chose.
 *
 * Which one is open is local state rather than a URL. Nothing else in this app reads search params - there
 * is no validateSearch anywhere in main.tsx - and adding that machinery for one panel would leave the
 * gallery routed in a different style from every other screen.
 */
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowLeft, ArrowRight, Share2, Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { Said } from '@/components/Said';
import { SearchField } from '@/components/SearchField';
import { type GallerySkill, galleryGet, galleryList, push } from '@/lib/api';
import { useConsole } from '@/lib/store';
import { useAccount } from '@/shell/AccountProvider';
import { Page } from '@/shell/Surface';
import { adoptRecording } from '@/features/record/adopt';
import { FlowCard } from './FlowCard';
import {
  type CollectionId, appLabel, appsOf, collectionById, myAppsOf, rowsFor,
} from './collections';

/* Four to a row while browsing, twelve to a page inside a collection. The second is three rows of the
 * first, so a collection opened from a row keeps the rhythm the row had. */
const PER_ROW = 4;
const PER_PAGE = 12;

type Sort = 'installs' | 'newest' | 'name';

const SORTS: { id: Sort; label: string }[] = [
  { id: 'installs', label: 'Most installed' },
  { id: 'newest', label: 'Newest first' },
  { id: 'name', label: 'Name, A to Z' },
];

const sortBy = (skills: GallerySkill[], how: Sort): GallerySkill[] => {
  const out = [...skills];
  if (how === 'installs') return out.sort((a, b) => b.installs - a.installs);
  if (how === 'newest') {
    return out.sort((a, b) => Date.parse(b.publishedAt || '') - Date.parse(a.publishedAt || '') || 0);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

/* Searching what is already loaded, over everything a card shows.
 *
 * The server searches name and description only, and that is right for finding a flow nobody has scrolled
 * to yet. Inside a collection the question is a different one - "which of these touches Excel" - and the app
 * chain on the card is part of what somebody just read, so it has to be part of what they can search. */
const matches = (skill: GallerySkill, term: string): boolean => {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  const haystack = [
    skill.name,
    skill.description,
    skill.author.name,
    ...skill.origins.map(appLabel),
  ].join(' ').toLowerCase();
  return haystack.includes(t);
};

export const GalleryView = () => {
  const { flows, reload } = useAccount();
  const [local] = useConsole();
  const navigate = useNavigate();

  const [term, setTerm] = useState('');
  const [skills, setSkills] = useState<GallerySkill[] | null>(null);
  const [total, setTotal] = useState(0);
  const [said, setSaid] = useState<{ text: string; kind: 'good' | 'bad' } | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  /* Which grouping is open on its own, and the controls that only exist while one is. Reset together when a
   * different collection opens: a page number and a filter carried over from the last one are answers to a
   * question nobody asked here. */
  const [open, setOpen] = useState<CollectionId | null>(null);
  const [inner, setInner] = useState('');
  const [app, setApp] = useState('');
  const [sort, setSort] = useState<Sort>('installs');
  const [page, setPage] = useState(1);

  const load = useCallback(async (q: string) => {
    setSkills(null);
    try {
      const body = await galleryList(q || undefined);
      setSkills(body.skills);
      /* The endpoint counts the matches before its own limit, so "50 of 148" is a fact rather than the
       * length of whatever array happened to arrive. An older deployment does not send it, and then the
       * array length is the only number there is - claiming more would be inventing it. */
      setTotal(typeof body.total === 'number' ? body.total : body.skills.length);
    } catch (err) {
      setSkills([]);
      setTotal(0);
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

      /* Which half can run it is decided by what it points at, not by where it came from: a payload with an
       * `agent: desktop` marker or raw coordinates is a desktop flow, and the extension must not be offered
       * as a way to replay it. */
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

  const tryIt = useCallback(async (skill: GallerySkill) => {
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
  }, [navigate]);

  /* Already on the account. The id is derived from the gallery id, so this is a lookup rather than a guess -
   * and it changes what the button should say: installing again overwrites that copy instead of making a
   * second one. */
  const installed = useMemo(
    () => new Set(flows.map((f) => f.id).filter((id) => id.startsWith('gal_'))),
    [flows],
  );

  const all = skills ?? [];
  const myApps = useMemo(() => myAppsOf(local.recordings), [local.recordings]);
  const apps = useMemo(() => appsOf(all), [all]);
  const rows = useMemo(() => rowsFor(all, myApps), [all, myApps]);

  const openCollection = (id: CollectionId) => {
    setOpen(id);
    setInner('');
    setApp('');
    setSort(id === 'recent' ? 'newest' : 'installs');
    setPage(1);
  };

  const card = (skill: GallerySkill) => (
    <FlowCard
      key={skill.id}
      skill={skill}
      installed={installed.has(`gal_${skill.id}`)}
      installing={installing === skill.id}
      onInstall={() => void install(skill)}
      onTry={() => void tryIt(skill)}
    />
  );

  // ------------------------------------------------------------------ one collection, on its own
  if (open) {
    const collection = collectionById(open);
    const picked = collection.pick(all, myApps);
    const filtered = picked
      .filter((s) => matches(s, inner))
      .filter((s) => !app || s.origins.some((o) => appLabel(o) === app));
    const sorted = sortBy(filtered, sort);
    const pages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
    const here = Math.min(page, pages);
    const shown = sorted.slice((here - 1) * PER_PAGE, here * PER_PAGE);

    return (
      <Page>
        <button
          type="button"
          onClick={() => setOpen(null)}
          className="mb-3 inline-flex items-center gap-1.5 text-[0.86rem] text-brand-primary hover:underline"
        >
          <ArrowLeft className="size-4" /> Back to Gallery
        </button>

        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <Typography variant="span" className="block text-[0.7rem] uppercase tracking-[0.14em] text-brand-tertiary">
              Community collection
            </Typography>
            <Typography variant="h2" weight="semibold" className="mt-1 text-[1.8rem] leading-tight tracking-tight">
              {collection.title}
            </Typography>
            <Typography variant="p" className="mt-1 max-w-[62ch] text-ink-secondary text-[0.88rem]">
              {collection.said}
            </Typography>
          </div>

          {/* Two numbers, and each is a different fact: what is on this page, and what the collection holds.
            * The third line appears only when the endpoint capped the fetch - saying "12 of 148" while 50 is
            * what actually arrived would be the useful-looking version of a wrong number. */}
          <Typography variant="p" className="shrink-0 text-ink-inactive text-[0.84rem] tabular-nums">
            <strong className="text-ink-primary">{shown.length}</strong> of {sorted.length} in this
            collection
            {total > all.length && (
              <span className="block text-[0.78rem]">
                {all.length} of {total} published flows loaded
              </span>
            )}
          </Typography>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {/* Switching collection without going back up: the groupings are the same library seen three ways,
            * and climbing out to come back in to compare them is a trip nobody needs. */}
          <div className="flex flex-wrap items-center gap-1">
            {rows.map(({ collection: c }) => (
              <button
                key={c.id}
                type="button"
                onClick={() => openCollection(c.id)}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-[0.84rem] transition-colors duration-base',
                  c.id === open
                    ? 'border-brand-primary/40 border bg-brand-primary/15 font-semibold text-brand-primary'
                    : 'text-ink-secondary hover:bg-state-hover',
                )}
              >
                {c.title}
              </button>
            ))}
          </div>

          <SearchField
            className="min-w-0 flex-1"
            value={inner}
            onChange={(next) => { setInner(next); setPage(1); }}
            placeholder="Search this collection"
          />

          {apps.length > 0 && (
            <select
              value={app}
              onChange={(ev) => { setApp(ev.target.value); setPage(1); }}
              className="rounded-md border-stroke border bg-surface-card2 px-2.5 py-2 text-[0.84rem] text-ink-primary focus:border-brand-primary focus:outline-none"
            >
              <option value="">All applications</option>
              {apps.map(({ app: name, n }) => (
                <option key={name} value={name}>{name} ({n})</option>
              ))}
            </select>
          )}

          <select
            value={sort}
            onChange={(ev) => setSort(ev.target.value as Sort)}
            className="rounded-md border-stroke border bg-surface-card2 px-2.5 py-2 text-[0.84rem] text-ink-primary focus:border-brand-primary focus:outline-none"
          >
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>

        <Said note={said} className="mb-3" />

        {shown.length === 0 ? (
          <Typography variant="p" className="text-ink-inactive">
            {inner || app ? 'Nothing in this collection matches that.' : 'Nothing in this collection yet.'}
          </Typography>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {shown.map(card)}
          </ul>
        )}

        {/* Only when there is a second page. One page with a lone "1" under it is a control that does
          * nothing, and a reader has to look at it to find that out. */}
        {pages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-1.5">
            <button
              type="button"
              disabled={here === 1}
              onClick={() => setPage(here - 1)}
              className="grid size-8 place-items-center rounded-md border-stroke border text-ink-secondary enabled:hover:bg-state-hover disabled:text-ink-inactive/50"
            >
              <ArrowLeft className="size-4" />
            </button>
            {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setPage(n)}
                className={cn(
                  'grid size-8 place-items-center rounded-md border text-[0.84rem] tabular-nums',
                  n === here
                    ? 'border-brand-primary/40 bg-brand-primary/15 font-semibold text-brand-primary'
                    : 'border-stroke text-ink-secondary hover:bg-state-hover',
                )}
              >
                {n}
              </button>
            ))}
            <button
              type="button"
              disabled={here === pages}
              onClick={() => setPage(here + 1)}
              className="grid size-8 place-items-center rounded-md border-stroke border text-ink-secondary enabled:hover:bg-state-hover disabled:text-ink-inactive/50"
            >
              <ArrowRight className="size-4" />
            </button>
          </div>
        )}
      </Page>
    );
  }

  // ------------------------------------------------------------------ browsing
  const visible = app ? all.filter((s) => s.origins.some((o) => appLabel(o) === app)) : all;
  const drawn = rowsFor(visible, myApps);

  return (
    <Page>
      <div className="mb-4 grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,26rem)] xl:items-start">
        <div className="min-w-0">
          <Typography variant="span" className="block text-[0.7rem] uppercase tracking-[0.14em] text-brand-tertiary">
            Community library
          </Typography>
          <Typography variant="h2" weight="semibold" className="mt-1.5 max-w-[24ch] text-[2rem] leading-[1.12] tracking-tight">
            Discover flows that already work.
          </Typography>
          <Typography variant="p" className="mt-2 max-w-[58ch] text-ink-secondary text-[0.9rem]">
            Install a published flow, try it in Record before you trust it, and change the copy however you
            like — it lands on your account, not in a shared folder.
          </Typography>
        </div>

        <SearchField
          className="min-w-0"
          size="lg"
          value={term}
          onChange={setTerm}
          placeholder="Search every published flow"
        />
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {/* Applications, not categories. The design this follows has Productivity / Research / Email / Data
          * entry along here, and nothing in the data says which of those a flow is - but `origins` says
          * which applications it moves through, which is both true and the thing somebody is actually
          * reaching for when they reach for a category. */}
        {apps.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setApp('')}
              className={cn(
                'rounded-full border px-3 py-1.5 text-[0.84rem] transition-colors duration-base',
                app === ''
                  ? 'border-brand-primary/40 bg-brand-primary/15 font-semibold text-brand-primary'
                  : 'border-stroke text-ink-secondary hover:bg-state-hover',
              )}
            >
              All
            </button>
            {apps.slice(0, 6).map(({ app: name }) => (
              <button
                key={name}
                type="button"
                onClick={() => setApp(name === app ? '' : name)}
                className={cn(
                  'max-w-[12rem] truncate rounded-full border px-3 py-1.5 text-[0.84rem] transition-colors duration-base',
                  app === name
                    ? 'border-brand-primary/40 bg-brand-primary/15 font-semibold text-brand-primary'
                    : 'border-stroke text-ink-secondary hover:bg-state-hover',
                )}
              >
                {name}
              </button>
            ))}
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ms-auto"
          leftSlot={<Share2 className="size-4" />}
          onClick={() => void navigate({ to: '/skills' })}
        >
          Share your flow
        </Button>
      </div>

      <Said note={said} className="mb-3" />

      {skills === null ? (
        <Typography variant="p" className="text-ink-inactive">Loading…</Typography>
      ) : all.length === 0 ? (
        <Typography variant="p" className="max-w-[70ch] text-ink-inactive">
          {term ? 'Nothing matches that.' : 'Nothing published yet. Publish one of your own from Skills.'}
        </Typography>
      ) : visible.length <= PER_ROW || drawn.length < 2 ? (
        /* One grid, not three rows, when the rows would be the same cards over again. A library of five has
         * no "most installed" that differs from its "recently added", and stacking both reads as a bigger
         * gallery than there is. */
        <>
          <div className="mb-2 flex items-baseline gap-2">
            {/* Named for what is under it. With a search running this said "Everything published" over one
              * card out of fourteen - the heading claiming the library while the grid held a result. */}
            <Typography variant="h3" weight="semibold" className="text-[1rem]">
              {term.trim()
                ? `Matching “${term.trim()}”${app ? ` in ${app}` : ''}`
                : app ? `Published flows in ${app}` : 'Everything published'}
            </Typography>
            <span className="text-[0.8rem] text-ink-inactive tabular-nums">
              {visible.length}
              {total > all.length ? ` of ${total}` : ''}
            </span>
          </div>
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {sortBy(visible, 'installs').map(card)}
          </ul>
        </>
      ) : (
        drawn.map(({ collection, skills: picked }) => (
          <section key={collection.id} className="mb-5 last:mb-0">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <div className="min-w-0">
                <Typography variant="h3" weight="semibold" className="text-[1rem]">
                  {collection.title}
                </Typography>
                <Typography variant="p" className="text-ink-inactive text-[0.82rem]">
                  {collection.said}
                </Typography>
              </div>
              {/* Only when the row is holding some back. "See all" over a row that is already all of it is a
                * promise of more that opens the same four cards. */}
              {picked.length > PER_ROW && (
                <button
                  type="button"
                  onClick={() => openCollection(collection.id)}
                  className="inline-flex shrink-0 items-center gap-1 text-[0.84rem] text-brand-primary hover:underline"
                >
                  See all {picked.length} <ArrowRight className="size-3.5" />
                </button>
              )}
            </div>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {picked.slice(0, PER_ROW).map(card)}
            </ul>
          </section>
        ))
      )}

      {all.length > 0 && (
        <Typography variant="p" className="mt-5 border-stroke/60 border-t pt-3 text-ink-inactive text-xs">
          <Sparkles className="mb-0.5 inline size-3.5" /> Installing puts a copy on your account and leaves
          the published one alone. Nothing here runs until you run it.
        </Typography>
      )}
    </Page>
  );
};
