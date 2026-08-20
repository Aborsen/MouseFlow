/* What the gallery is grouped into, and why those groups and not the ones a mockup shows.
 *
 * The design this was built from has three rows - Featured, Most liked, Recently added - and two of the
 * three cannot be told the truth here:
 *
 *   Featured    is an editorial pick, and nobody curates this gallery. A row labelled Featured would be
 *               ordinary rows in a hat.
 *   Most liked  needs likes. There is no likes column, there is an installs column, and "people installed
 *               this" is a stronger claim than "people liked it" anyway - it is the same shape of row,
 *               ranked by something that actually happened.
 *
 * The third group in its place is the one the data can do that a mockup cannot: flows that touch the
 * applications THIS person already records in. `origins` on a listing and the windows on a recording are
 * both real, so the overlap is real.
 *
 * A group appears only when it says something the group above it did not. With four published flows,
 * "most installed" and "recently added" are the same four cards twice, and a page that shows them twice is
 * padding pretending to be a library.
 */
import type { GallerySkill } from '@/lib/api';
import type { Recording } from '@/lib/store';

export type CollectionId = 'popular' | 'yours' | 'recent';

export interface Collection {
  id: CollectionId;
  /** On the row, and as the heading when it is opened on its own. */
  title: string;
  /** One line under the title. Says what the ordering means, not that the flows are good. */
  said: string;
  pick: (all: GallerySkill[], myApps: string[]) => GallerySkill[];
}

/* An application's name out of whatever a listing happens to carry.
 *
 * `origins` holds two different things depending on which half published: the extension records the sites a
 * flow ran on ("https://mail.google.com/..."), the desktop agent records window titles ("Inbox - Outlook").
 * Both are real and neither is a name, so both get reduced to the one word a person would use.
 */
export const appLabel = (origin: string): string => {
  const raw = (origin || '').trim();
  if (!raw) return '';

  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).hostname.replace(/^www\./i, '').slice(0, 40);
    } catch {
      /* A malformed URL is not worth losing the whole label over - fall through and treat it as text. */
    }
  }

  /* Windows puts the application last: "Inbox - Outlook", "book.xlsx - Excel". The em dash is what Chrome
   * uses and the hyphen is what everything else uses, so both count. */
  const tail = raw.split(/\s+[—–-]\s+/).pop() || raw;
  return tail.trim().slice(0, 40);
};

/* How big a listing is, in the unit that KIND of flow is measured in.
 *
 * A recorded flow has events; a created one has a goal and the inputs that goal asks for. Reporting "0
 * steps" for the second would describe a flow that does nothing, which is the opposite of true - so the two
 * are counted in different units and said in different words, and `actions: null` (a created flow, or a
 * listing from a deployment that predates the count) is distinct from `actions: 0`.
 *
 * Here rather than on the card: what a flow is measured in is a fact about the flow, not about the layout,
 * and in a .tsx next to React it could only ever be checked by grepping for the string instead of running
 * it. */
export const sizeOf = (skill: GallerySkill): string => {
  if (skill.kind === 'recorded') {
    const n = skill.actions;
    if (n === null || n === undefined) return 'recorded actions';
    return `${n} recorded action${n === 1 ? '' : 's'}`;
  }
  const n = skill.params.length;
  if (!n) return 'a goal, no inputs';
  return `a goal with ${n} input${n === 1 ? '' : 's'}`;
};

/** Distinct applications across a set of listings, the most common first. */
export const appsOf = (skills: GallerySkill[]): { app: string; n: number }[] => {
  const seen = new Map<string, number>();
  for (const skill of skills) {
    /* Once per listing, not once per origin: a flow that visits Gmail eleven times is one flow that uses
     * Gmail, and counting the visits would put a busy flow's app at the top of the list on its own. */
    const here = new Set(skill.origins.map(appLabel).filter(Boolean));
    for (const app of here) seen.set(app, (seen.get(app) ?? 0) + 1);
  }
  return [...seen.entries()]
    .map(([app, n]) => ({ app, n }))
    .sort((a, b) => b.n - a.n || a.app.localeCompare(b.app));
};

/** The applications this person's own recordings touch, so the gallery can say which flows meet them. */
export const myAppsOf = (recordings: Recording[]): string[] => {
  const seen = new Set<string>();
  for (const rec of recordings) {
    for (const w of rec.windows ?? []) {
      const fromTitle = appLabel(w.title || '');
      if (fromTitle) seen.add(fromTitle.toLowerCase());
      /* The process name as well as the title: "chrome" never appears in "Inbox - Outlook", and a flow
       * published from a browser lists hostnames that no window title will match. */
      const proc = (w.process || '').replace(/\.exe$/i, '').trim();
      if (proc) seen.add(proc.toLowerCase());
    }
  }
  return [...seen];
};

/* Does this listing touch anything this person works in?
 *
 * Loose on purpose, and one-directional: a hostname ("mail.google.com") contains the word somebody's
 * window title reduced to ("google"), never the other way round, so the test is containment either way with
 * a floor on the length. Two characters would match "in" against everything. */
const meets = (skill: GallerySkill, myApps: string[]): boolean => {
  if (!myApps.length) return false;
  const theirs = skill.origins.map((o) => appLabel(o).toLowerCase()).filter((a) => a.length >= 3);
  return theirs.some((t) => myApps.some((m) => m.length >= 3 && (t.includes(m) || m.includes(t))));
};

const byInstalls = (a: GallerySkill, b: GallerySkill) => b.installs - a.installs;
const byNewest = (a: GallerySkill, b: GallerySkill) =>
  Date.parse(b.publishedAt || '') - Date.parse(a.publishedAt || '') || 0;

export const COLLECTIONS: Collection[] = [
  /* First, and deliberately. When two rows would show the same four cards the later one is dropped, and if
   * "most installed" sat above this the personal claim would be the one that vanished - which is backwards:
   * "these run in your Outlook" says more than "these get installed a lot", and when both are true of the
   * same four flows, the one about the reader is the one worth keeping. Somebody with no recordings has no
   * such row at all, and then the gallery opens on Most installed without a second branch to write. */
  {
    id: 'yours',
    title: 'In the apps you use',
    said: 'Published flows that touch the applications your own recordings do.',
    pick: (all, myApps) => all.filter((s) => meets(s, myApps)).sort(byInstalls),
  },
  {
    id: 'popular',
    title: 'Most installed',
    said: 'Flows people kept a copy of.',
    /* Only the ones somebody actually installed. A ranking where every value is zero is not a ranking, and
     * "Most installed" over four untouched flows is a claim about them that nothing supports. */
    pick: (all) => all.filter((s) => s.installs > 0).sort(byInstalls),
  },
  {
    id: 'recent',
    title: 'Recently added',
    said: 'Newest first, whoever published them.',
    pick: (all) => [...all].sort(byNewest),
  },
];

export const collectionById = (id: CollectionId): Collection =>
  COLLECTIONS.find((c) => c.id === id) ?? COLLECTIONS[COLLECTIONS.length - 1];

/* Rows worth drawing.
 *
 * The first version of this dropped a row whose flows had all appeared above it, and that was the wrong
 * test - it deleted "Recently added" from a full library, because a gallery of fourteen where thirteen have
 * been installed puts nearly everything in "Most installed" first. But a row is not there to introduce new
 * flows. It is there to make a CLAIM about an ordering: most installed, in your applications, newest. Three
 * orderings of overlapping sets is what a library looks like.
 *
 * What a reader does notice is the same four cards in the same order twice. So the test is on the visible
 * slice, not on the set: a row is dropped when the cards it would actually show are the ones a row above is
 * already showing, in the same order.
 */
export const rowsFor = (all: GallerySkill[], myApps: string[], shown = 4) => {
  const rows: { collection: Collection; skills: GallerySkill[] }[] = [];
  const drawnSlices: string[] = [];

  for (const collection of COLLECTIONS) {
    const skills = collection.pick(all, myApps);
    if (!skills.length) continue;
    /* The slice a reader will see, as one string, so "same cards in the same order" is one comparison
     * rather than a loop that gets the edge cases wrong. */
    const slice = skills.slice(0, shown).map((s) => s.id).join('|');
    if (drawnSlices.includes(slice)) continue;
    drawnSlices.push(slice);
    rows.push({ collection, skills });
  }
  return rows;
};
