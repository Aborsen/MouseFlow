/* A recording that lasts a working day.
 *
 * Eight hours does not fit, and what it does not fit is not a time limit - there is none anywhere in this
 * code - it is BYTES. Measured over the recordings this project has actually made: 69 bytes an event and
 * 23-42 events a second, so 1.5-2.9 KB/s. api/sync.js refuses a payload over 400KB, which arrives around
 * the third minute. The longest recording that exists here is 37 seconds.
 *
 * Three walls, in the order they are hit:
 *
 *   1. the payload cap    400KB, so ~3 minutes of ordinary work in one row.
 *   2. localStorage       one origin gets about 5MB for EVERY recording together, so a day-long one cannot
 *                         be held in the browser either.
 *   3. the agent          before 0.8.0 the only way events left it was /record/stop, which meant holding
 *                         eight hours - roughly 830,000 events - in memory and returning them in one
 *                         string.
 *
 * All three go away the same way: the session is cut into chunks, each chunk becomes its own row on the
 * account, and nothing anywhere ever holds more than one chunk. The agent drains without stopping (its clock
 * runs on, so a part knows how far into the session it is), the browser keeps a LEDGER rather than the
 * events - counts, not payloads, so a sixteen-part day costs a few kilobytes of localStorage - and the
 * transcript reads each part from the account, which is where it reads every recording from already.
 *
 * The other half of fitting is thinning the pointer path. Movement is 93.75% of the events and 88.6% of the
 * bytes - measured, not assumed - and at the agent's 10ms default that is up to a hundred samples a second
 * of a path that nothing reads: the transcript, the story and the analytics all read clicks, scrolls, keys
 * and the change of window. At 250ms the "was somebody at this machine" signal survives and a half-hour
 * chunk fits inside the cap with room over. Replay of a thinned recording is coarser, deliberately: an
 * eight-hour session is recorded to be READ, not replayed.
 */
import type { RecordedEvent, Recording } from '@/lib/store';
import { RECORDING_ROLE } from '@/lib/flow-role';
import type { AgentHealth } from '@/lib/agent';

/** How often a session is cut. Both fit; 30 leaves more room, so it leads. */
export const CHUNK_CHOICES = [30, 60] as const;
export type ChunkMinutes = typeof CHUNK_CHOICES[number];

/** Pointer sampling for a session meant to last hours. See the note above for why this is not the default. */
export const LONG_MOVE_MS = 250;

/* Cut early at this many events, whichever comes first.
 *
 * The clock is not the binding constraint - the cap is - and an hour of unusually busy work would produce a
 * chunk the account refuses, which is the one outcome this whole mechanism exists to avoid. 400,000 bytes
 * over the measured 69 bytes an event is about 5,700 events; 4,500 leaves the payload's own wrapper (name,
 * windows, the recorder's flags) a fifth of the budget it will never need.
 *
 * Read off /record/status, which the page already polls four times a second, so this costs nothing. */
export const EVENTS_MAX_PER_PART = 4500;

/* How much unsent recording is worth holding on to.
 *
 * A part that could not reach the account is kept and retried, because losing half an hour of somebody's day
 * to a dropped connection is not an acceptable answer. But it is held in memory, and holding an entire
 * eight-hour session there is the thing being avoided - so past this the session stops and says so. Two
 * failed half-hour parts at the thinned rate, roughly. */
export const PENDING_MAX_EVENTS = 12_000;

export interface SessionPart {
  /** Its own row on the account. */
  id: string;
  /** 1-based, in the order they were cut. */
  n: number;
  /* What it is called, kept in the ledger although the events are not.
   *
   * The transcript panel takes its heading from the recordings THIS BROWSER holds, and a part is deliberately
   * not one of them - so opening a part's transcript was headed "Recording". A name is a few dozen bytes
   * against the several hundred kilobytes of events that stay on the account; the reason for the ledger does
   * not extend to it. */
  name: string;
  events: number;
  clicks: number;
  ms: number;
  /** The session clock when this part was cut, so a part knows how far in it is. */
  atMs: number;
  cutAt: string;
  /** Whether the account has it. False means it is still in memory, waiting for a retry. */
  onAccount: boolean;
}

export interface Session {
  id: string;
  startedAt: string;
  /** Null while it is still running. */
  endedAt: string | null;
  /* Null when the cuts were NOT by the clock.
   *
   * A session can also be assembled after the fact: a recording made as ONE recording that the account
   * refuses - over PAYLOAD_MAX_BYTES - is cut into parts by SIZE, and claiming "a part every 30 min" about
   * it would be a number nobody chose. See `partsToFit`. */
  everyMinutes: ChunkMinutes | null;
  /** What the agent was sampling the pointer at, so a thin recording can say why it is thin. Null: unknown. */
  moveMs: number | null;
  parts: SessionPart[];
}

const clicksIn = (events: RecordedEvent[]) =>
  events.filter((e) => /click down/i.test(e.action)).length;

const msIn = (events: RecordedEvent[]) =>
  events.reduce((sum, e) => sum + (Number.isFinite(e.delayMs) ? e.delayMs : 0), 0);

/* What the `#part` line the agent writes above a chunk says.
 *
 * Every reader of the .mmmacro format already skips lines starting with `#`, which is how `#ctx` travels, so
 * this parses out of the same text the events do and an older reader is unaffected. Absent fields are absent
 * rather than zero: a chunk from an agent that does not write the line at all still loads. */
export const partHeader = (text: string): { n: number | null; elapsedMs: number | null; moveMs: number | null } => {
  const line = text.split(/\r?\n/).find((l) => l.startsWith('#part'));
  if (!line) return { n: null, elapsedMs: null, moveMs: null };
  const read = (name: string) => {
    const field = line.split('\t').find((f) => f.startsWith(name + '='));
    if (!field) return null;
    const value = Number(field.slice(name.length + 1));
    return Number.isFinite(value) ? value : null;
  };
  return { n: read('n'), elapsedMs: read('elapsedMs'), moveMs: read('moveMs') };
};

/** Is it time to cut? Time OR size, whichever arrives first. */
export const shouldCut = (
  { sinceLastCutMs, eventsBuffered, everyMinutes }:
  { sinceLastCutMs: number; eventsBuffered: number; everyMinutes: ChunkMinutes | null },
): 'clock' | 'size' | null => {
  if (eventsBuffered >= EVENTS_MAX_PER_PART) return 'size';
  /* Без интервала режет только размер: у сессии, собранной постфактум (partsToFit), часов не было, и
   * притворяться, что был, значило бы резать живую запись по числу, которого никто не выбирал. */
  if (everyMinutes !== null && sinceLastCutMs >= everyMinutes * 60_000) return 'clock';
  return null;
};

/* What a part is called.
 *
 * Named after the application it was recorded in, like every other recording here, plus its number - the
 * number is what makes sixteen rows on one day tellable apart, and the application is what makes the day
 * findable in a week. A part with no window seen falls back to the session's own start time rather than to
 * "part 3", which on its own says nothing about which session. */
export const partName = (
  { windows, n, startedAt }: { windows: { title: string }[]; n: number; startedAt: string },
): string => {
  const first = windows[0]?.title.split(/\s+[-–—|]\s+/)[0]?.slice(0, 40);
  if (first) return `${first} · part ${n}`;
  const at = new Date(startedAt);
  const clock = Number.isFinite(at.getTime())
    ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    : 'session';
  return `Session ${clock} · part ${n}`;
};

/** The ledger entry for a part, from the part itself. Counts, never events - that is the whole point. */
export const ledgerEntry = (
  { id, n, name, events, atMs, onAccount }:
  { id: string; n: number; name: string; events: RecordedEvent[]; atMs: number; onAccount: boolean },
): SessionPart => ({
  id,
  n,
  name,
  events: events.length,
  clicks: clicksIn(events),
  ms: msIn(events),
  atMs,
  cutAt: new Date().toISOString(),
  onAccount,
});

/* The row a part becomes on the account.
 *
 * Deliberately `role: recording` and not a role of its own: a part IS a recording - of a slice of time - and
 * that stamp is what keeps it off the Skills page. What marks it as part of a session is `payload.session`,
 * which the Record page reads to group the parts and the orphan strip reads to know these are not strays.
 *
 * `session.everyMinutes` and `session.moveMs` travel with every part rather than living only in the ledger,
 * because the ledger is in one browser and the row is on the account: a transcript derived server-side has
 * to be able to say "the pointer was sampled every 250ms here" without asking the browser that made it. */
export const partFlow = (
  { part, session, name, events, windows, health }: {
    part: SessionPart;
    session: Session;
    name: string;
    events: RecordedEvent[];
    windows: { title: string; process: string }[];
    health: AgentHealth | null;
  },
) => ({
  id: part.id,
  source: 'desktop' as const,
  kind: 'recorded' as const,
  name: name.slice(0, 80),
  description: `part ${part.n} of a session · ${part.events} events · ${part.clicks} click${
    part.clicks === 1 ? '' : 's'}`,
  origins: windows.map((w) => w.title).filter(Boolean).slice(0, 12),
  created: part.cutAt,
  payload: {
    version: 1,
    kind: 'recorded',
    agent: 'desktop',
    role: RECORDING_ROLE,
    recorder: {
      version: health?.version ?? null,
      /* Null when no agent answered, never false - same rule as flow-for.ts: "the keyboard was not watched"
       * and "nobody asked" are different facts, and a health flap mid-session must not stamp the first. */
      canName: health ? health.canName === true : null,
      canKeys: health ? health.canKeys === true : null,
    },
    /* Which session, and where in it. `atMs` is the session clock at the cut, so the parts can be laid end
     * to end without trusting the order they happened to sync in. */
    session: {
      id: session.id,
      part: part.n,
      atMs: part.atMs,
      startedAt: session.startedAt,
      everyMinutes: session.everyMinutes,
      moveMs: session.moveMs,
    },
    name: name.slice(0, 80),
    events,
    windows,
    created: part.cutAt,
  },
});

/** Is this account row part of a session? Read off the payload, so it works for rows made on another machine. */
export const sessionOf = (payload: unknown): { id: string; part: number } | null => {
  const p = payload as { session?: { id?: unknown; part?: unknown } } | null | undefined;
  const s = p && typeof p.session === 'object' && p.session ? p.session : null;
  if (!s || typeof s.id !== 'string' || !s.id) return null;
  const part = typeof s.part === 'number' && Number.isFinite(s.part) ? s.part : 0;
  return { id: s.id, part };
};

/* What a session adds up to.
 *
 * From the LEDGER, not from the parts on the account: the ledger is complete the moment a part is cut, while
 * a part that has not synced yet is not on the account to be counted. A session reporting less than it
 * recorded because the network was slow would be the wrong kind of honest. */
export const sessionTotals = (session: Session) => {
  const events = session.parts.reduce((n, p) => n + p.events, 0);
  const clicks = session.parts.reduce((n, p) => n + p.clicks, 0);
  const waiting = session.parts.filter((p) => !p.onAccount);
  /* The session clock at the last cut, not the sum of the parts: the parts measure the gaps BETWEEN their
   * own events, so summing them loses the gap across every cut - about a second each time, and always
   * downward. */
  const ms = session.parts.length ? Math.max(...session.parts.map((p) => p.atMs)) : 0;
  return { events, clicks, ms, parts: session.parts.length, waiting: waiting.length };
};

/** Rough, and said as rough: how long this session can run before the parts stop fitting. */
export const fitsFor = (everyMinutes: ChunkMinutes, eventsPerSecond: number): string => {
  const perPart = eventsPerSecond * everyMinutes * 60;
  if (perPart <= EVENTS_MAX_PER_PART) return 'every part fits';
  return `parts would be cut early, around every ${Math.max(1, Math.round(EVENTS_MAX_PER_PART / eventsPerSecond / 60))} min`;
};

/** A recording made from one part, for the moment between draining it and sending it. */
export const partRecording = (
  { id, name, events, windows }:
  { id: string; name: string; events: RecordedEvent[]; windows: { title: string; process: string }[] },
): Recording => ({
  id,
  name,
  created: new Date().toISOString(),
  events,
  windows,
});

/* ------------------------------------------------------------------ уже записанное, но не влезшее */

/* Целевой вес одной части, РАЗВЁРНУТЫЙ. Потолок аккаунта 8МБ (api/_payload.mjs); шесть оставляют место
 * обёртке - имени, окнам, флагам рекордера - и запас на то, что вес события в разных записях разный. */
export const FIT_TARGET_BYTES = 6_000_000;

/* ЗАПИСЬ, КОТОРАЯ НЕ ВЛЕЗЛА ОДНОЙ СТРОКОЙ, - в части того же вида.
 *
 * Живой случай: пять часов работы, 154 975 событий, и аккаунт отказал - «unpacks to more than 7813KB».
 * События остались в памяти браузера (в localStorage они тоже не влезли), то есть пять часов держались
 * открытой вкладкой. «Put it back on my account» повторял ту же отправку и упирался в тот же потолок.
 *
 * ПОЧЕМУ НЕ ПОДНЯТЬ ПОТОЛОК. Он и так поднят до 8МБ по замерам, и следующая запись, которая в него не
 * влезет, будет просто длиннее. Резать - это то, что продукт уже умеет: длинные сессии режутся на части, и
 * расшифровка, скиллы и дашборд читают части как обычные записи. Здесь то же самое, только резка не по
 * часам, а по размеру - и постфактум.
 *
 * РАЗМЕР МЕРЯЕТСЯ, А НЕ БЕРЁТСЯ ИЗ ГОЛОВЫ. В long-session.ts стоит 69 байт на событие - оценка по прежним
 * записям, и на этой она бы соврала: 8МБ на 155k событий это ~52 байта. Поэтому события сериализуются один
 * раз, и число событий в части считается из ИХ веса, а не из константы.
 *
 * ID ЧАСТЕЙ ДЕТЕРМИНИРОВАННЫЕ - `<id записи>-p1`, `-p2`, ... Повторное нажатие кнопки перезапишет те же
 * строки (api/sync.js делает upsert), а не создаст второй набор: кнопка, которую нажали дважды, не должна
 * удваивать пять часов работы.
 */
export function partsToFit(
  { rec, events, health, target = FIT_TARGET_BYTES }: {
    rec: Pick<Recording, 'id' | 'name' | 'created' | 'startedAt' | 'windows'>;
    events: RecordedEvent[];
    health: AgentHealth | null;
    target?: number;
  },
): { session: Session; flows: ReturnType<typeof partFlow>[]; perPart: number; bytes: number } {
  const bytes = JSON.stringify(events).length;
  const perPart = Math.max(500, Math.floor(events.length * (target / Math.max(bytes, 1))));

  const session: Session = {
    id: `fit_${rec.id}`,
    startedAt: rec.startedAt ?? rec.created,
    endedAt: rec.created,
    /* Не по часам - см. заметку выше. */
    everyMinutes: null,
    /* Чем сэмплировался указатель, эта запись не сообщает: её делали как одну, без прореживания. */
    moveMs: null,
    parts: [],
  };

  const flows: ReturnType<typeof partFlow>[] = [];
  let atMs = 0;
  let n = 1;
  for (let i = 0; i < events.length; i += perPart) {
    const slice = events.slice(i, i + perPart);
    const name = `${rec.name} · part ${n}`;
    const part = ledgerEntry({ id: `${rec.id}-p${n}`, n, name, events: slice, atMs, onAccount: false });
    session.parts.push(part);
    flows.push(partFlow({ part, session, name, events: slice, windows: rec.windows ?? [], health }));
    atMs += part.ms;
    n += 1;
  }
  return { session, flows, perPart, bytes };
}
