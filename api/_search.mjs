/* Finding a recording by the names of the things it touched.
 *
 * WHY THIS IS A SEPARATE FILE FROM _digest.mjs. Not tidiness: flow_digest holds no text from anybody's
 * screen and says so in its own migration, because a table added for speed that also held content would put
 * the privacy rules in two places. This one holds text on purpose, so its rules live here, beside it, where
 * somebody reading only the other file cannot miss them.
 *
 * WHAT IT CAN AND CANNOT FIND. Window titles, control names, the container a control sat in, application
 * names, page origins - every one of them already shown by the transcript and by list_recordings. It can
 * never find what somebody typed: the recorder stores that a key was pressed and which key, and no sentence
 * anybody wrote exists anywhere in this product to be indexed. So "find where I typed the invoice number"
 * has no answer here, and "find the recording with the Invoice field in it" has one.
 *
 * WHY THE NAMES ARE NORMALISED IN JAVASCRIPT AND NOT IN SQL. Because they are already normalised once, in
 * api/_names.mjs, and that is the definition the transcript displays: Chrome hands over a tab name as a
 * whole sentence with a memory reading inside it, and the transcript strips that before showing it. Writing
 * those rules again in SQL would give two definitions of one name, and the index would then be searchable
 * by text nobody was ever shown. So SQL does what SQL is for - unrolling the events and grouping the raw
 * names, which is a few hundred rows per recording rather than a payload - and the rules are applied by the
 * one module that owns them.
 */
import { plainName, plainTitle } from './_names.mjs';

/* WHICH FORMULA PRODUCED A ROW. Same mechanism, same argument as DIGEST_VERSION: bump it and every row is
 * re-derived on the next read, no migration and no script. */
export const SEARCH_VERSION = 1;

/* A ceiling on the blob, so one pathological recording cannot make this table the size of the payloads it
 * exists to avoid reading. 400 distinct names is far past any recording measured here - the busiest on the
 * live account touched 142 window titles - and how many were actually there is stored beside it, so a
 * truncated index says it is truncated rather than quietly answering "no". */
export const PHRASES_PER_FLOW = 400;

/* How many phrases a search result carries, so it can say WHY it matched. The rest are in "words" and still
 * findable; this is only what is shown. */
export const PHRASES_SHOWN = 12;

/* How many recordings one request may index. Bounded for the reason the digest's own ceiling exists: a first
 * search on an account with hundreds of recordings must not pay for all of them at once. */
export const TEXT_TOP_UP_MAX = 12;

/* Разделитель имён в блобе. Объявлен константой, потому что то же самое значение стоит в SQL
 * поиска как chr(10): два написания одного разделителя - это два способа разойтись. */
const NL = String.fromCharCode(10);

/* ---------------------------------------------------------------------------- staleness
 *
 * THE PREDICATE IS THE SAME THREE CASES flow_digest uses, and the third is the one that matters: a
 * recording can be EDITED - api/transcript.js and the assistant's remove_steps both rewrite the payload -
 * so an index derived before that edit describes a recording that no longer exists.
 *
 * IT IS WRITTEN TWICE, HERE AND IN THE COUNT BELOW, and that is a real cost rather than an oversight: the
 * neon template tag parameterises every interpolation and cannot compose SQL fragments, so a shared
 * predicate is not expressible. api/_test-search.mjs asserts the two are character-for-character identical,
 * which turns the duplication into something a test can hold. If they ever drift, the counter and the writer
 * disagree about what is left and the count never reaches zero.
 */
export async function textStaleCount(sql, ids) {
  const rows = await sql`
    select count(*)::int as n
    from user_flow f
    left join flow_text x on x.user_id = f.user_id and x.client_id = f.client_id
    where f.user_id = any(${ids}::uuid[]) and f.deleted_at is null and f.kind = 'recorded'
      and (x.user_id is null or x.version < ${SEARCH_VERSION} or x.derived_at < f.updated_at)
  `;
  return rows[0] ? rows[0].n : 0;
}

/* WHICH RECORDINGS THIS BATCH WILL INDEX, decided once and by itself.
 *
 * IT USED TO BE DECIDED TWICE, and that was a data-losing bug rather than an inefficiency. The names query
 * took `limit N` of the stale recordings; a second query then took `limit N` of whatever was STILL stale and
 * wrote an EMPTY index for each - meaning every batch quietly ruined as many recordings as it indexed. They
 * stopped being stale with no words in them, so they were never re-derived and could never be found again.
 * Measured: "снимок экрана" appears in 81 events of three recordings and in none of the 45 index rows.
 *
 * So the batch is a list of ids, and everything after this works from that list. A recording in it gets a
 * row whether or not it had a single name - which is the OTHER half of the same rule, and the one the digest
 * had to learn from the opposite direction: a recording with nothing to index has no group in the names
 * query, and without a row of its own it stays stale for ever, re-read on every search.
 */
async function stalePick(sql, ids, limit) {
  return sql`
    select f.user_id, f.client_id
    from user_flow f
    left join flow_text x on x.user_id = f.user_id and x.client_id = f.client_id
    where f.user_id = any(${ids}::uuid[]) and f.deleted_at is null and f.kind = 'recorded'
      and (x.user_id is null or x.version < ${SEARCH_VERSION} or x.derived_at < f.updated_at)
    order by f.updated_at desc
    limit ${limit}
  `;
}

/* The distinct raw names of NAMED recordings, for exactly the batch above.
 *
 * ONE ROW PER (recording, name), not per event: a four-hour recording has 81846 events and a couple of
 * hundred distinct names, and the whole point of grouping in the database is that only the second number
 * crosses the wire.
 */
async function namesFor(sql, clientIds) {
  return sql`
    with picked as (
      select f.user_id, f.client_id, f.payload
      from user_flow f
      where f.client_id = any(${clientIds}::text[]) and f.deleted_at is null
    ),
    ev as materialized (
      select p.user_id, p.client_id, e.v as event
      from picked p
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(p.payload->'events') = 'array' then p.payload->'events' else '[]'::jsonb end
      ) as e(v)
    ),
    /* Every place a name can sit, as one column. Read under both spellings where the wire has two - the
       agent writes "in"/"inName" short and the parsed object spells them out - because a payload written by
       either has to index the same. */
    named as (
      select user_id, client_id, kind, said from ev,
        lateral (values
          ('control',   ev.event->'context'->>'control'),
          ('container', coalesce(ev.event->'context'->>'containerName', ev.event->'context'->>'inName')),
          ('window',    coalesce(ev.event->'context'->>'window', ev.event->>'title')),
          ('app',       ev.event->'context'->>'app'),
          ('near',      ev.event->'context'->>'near'),
          /* The origin only, not the path: a query string is where an identifier ends up, and this table is
             for finding a recording rather than for keeping addresses. */
          ('page',      case when ev.event->>'url' ~ '^https?://'
                              then regexp_replace(ev.event->>'url', '^(https?://[^/?#]+).*$', '\\1') end)
        ) as v(kind, said)
      where nullif(trim(said), '') is not null
    )
    select user_id, client_id, kind, left(trim(said), 200) as said, count(*)::bigint as n
    from named
    group by 1, 2, 3, 4
    /* Commonest first, so the JS cap below keeps what a recording is actually about rather than whatever
       the database happened to return. */
    order by user_id, client_id, n desc, said
  `;
}

/* Index the recordings that need it. Returns the client ids it wrote.
 *
 * THE NAMES ARE NORMALISED IN JAVASCRIPT, which is why this is not one statement: the rules live in
 * api/_names.mjs and are applied to what a person READS, so the index has to be built from the same strings
 * the transcript shows. Writing them again in SQL would give two definitions of one name, and the index
 * would then be searchable by text nobody was ever shown.
 *
 * What crosses the wire is names and counts - a few hundred rows per recording - not payloads.
 */
export async function textTopUp(sql, ids, limit = TEXT_TOP_UP_MAX) {
  const picked = await stalePick(sql, ids, limit);
  if (!picked.length) return [];

  const clientIds = picked.map((row) => row.client_id);
  const rows = await namesFor(sql, clientIds);

  /* Every picked recording starts with an empty bag, so one with no names at all still ends up with a row.
   * Filling only what the names query returned is exactly how the bug above got in. */
  const bags = new Map();
  for (const row of picked) {
    bags.set(row.client_id, { userId: row.user_id, clientId: row.client_id, seen: new Map() });
  }

  for (const row of rows) {
    const bag = bags.get(row.client_id);
    /* Not in the batch. Cannot happen while client ids are unique per account, and dropped rather than
     * trusted, because the alternative is writing one recording's names onto another. */
    if (!bag) continue;

    /* THE SAME TWO RULES THE TRANSCRIPT APPLIES, in the same order, and the order is not cosmetic: a
     * window title carries the application own suffix AND may carry an address, and plainTitle expects the
     * first to be gone already. See ctxOf in api/_transcript.js, which does exactly this. */
    const cleaned = row.kind === 'window'
      ? plainTitle(plainName(row.said))
      : plainName(row.said);
    const said = String(cleaned || '').trim();
    if (!said) continue;

    /* Merged on the LOWERCASED form, because that is what a search compares, and two spellings of one
     * label are one thing to somebody looking for it. The spelling kept is the commonest one - the rows
     * arrive count-descending, so the first spelling seen is the one to keep. */
    const key = said.toLowerCase();
    const had = bag.seen.get(key);
    if (had) {
      had.n += Number(row.n) || 0;
      /* A phrase found as both a control and a window is recorded as both, in the order met - the kind is
       * a label on a result and not an identity. */
      if (!had.kinds.includes(row.kind)) had.kinds.push(row.kind);
    } else {
      bag.seen.set(key, { said, n: Number(row.n) || 0, kinds: [row.kind] });
    }
  }

  const written = [];
  for (const bag of bags.values()) {
    const all = [...bag.seen.values()].sort((a, b) => b.n - a.n || a.said.localeCompare(b.said));
    const kept = all.slice(0, PHRASES_PER_FLOW);
    /* Newline-separated and lowercased: the separator is not searchable text, so a search for one name
     * cannot match across the boundary into the next. */
    const words = kept.map((p) => p.said.toLowerCase()).join(NL);
    const phrases = kept.slice(0, PHRASES_SHOWN).map((p) => ({ t: p.said, n: p.n, k: p.kinds[0] }));

    await sql`
      insert into flow_text (user_id, client_id, version, words, phrases, distinct_n, derived_at)
      values (${bag.userId}::uuid, ${bag.clientId}, ${SEARCH_VERSION}, ${words},
              ${JSON.stringify(phrases)}::jsonb, ${all.length}, now())
      on conflict (user_id, client_id) do update set
        version    = excluded.version,
        words      = excluded.words,
        phrases    = excluded.phrases,
        distinct_n = excluded.distinct_n,
        derived_at = excluded.derived_at
    `;
    written.push(bag.clientId);
  }

  return written;
}

/* ---------------------------------------------------------------------------- the search
 *
 * A SUBSTRING MATCH, and it is chosen rather than settled for. Control names are interface labels in
 * whatever language the application is in - the live account has "Снимок экрана" and "Prompt" inside one
 * recording - and full-text search has to be told a language before it can stem. A substring needs no
 * language, no extension and no configuration, and it finds "накладную" inside "накладные", which is the
 * commonest shape of this question. What it costs is an index it cannot use; what it scans is a table of a
 * few hundred kilobytes where the payloads are 28 MB.
 *
 * Ranked by how many of a recording's phrases match, then by recency - a recording that mentions the word
 * in six places is more likely the one being looked for than one that mentions it once.
 */
export function searchRecordings(sql, ids, needle, limit) {
  return sql`
    with hit as (
      select x.user_id, x.client_id, x.words, x.phrases, x.distinct_n,
             f.name, f.source, coalesce(f.created_at, f.updated_at) as at
      from flow_text x
      join user_flow f on f.user_id = x.user_id and f.client_id = x.client_id
      where x.user_id = any(${ids}::uuid[]) and f.deleted_at is null and f.kind = 'recorded'
        and x.words like '%' || lower(${needle}) || '%'
    ),
    /* One row per matching NAME, not per matching character: "matched in six of its names" is a fact about
       the recording, where "the word appears nine times in the blob" is a fact about how long its longest
       name happens to be. */
    matched as (
      select h.client_id, w.one
      from hit h, unnest(string_to_array(h.words, chr(10))) as w(one)
      where w.one like '%' || lower(${needle}) || '%'
    )
    select h.client_id, h.name, h.source, h.at, h.phrases, h.distinct_n,
           count(m.one)::int as matches,
           /* The names that actually matched, so a result explains itself rather than only asserting.
              Taken from the blob and not from "phrases", because the match is often outside the commonest
              few - which is the whole reason "words" is uncapped where "phrases" is not. Lowercased, since
              that is how the blob stores them; "phrases" carries the original spellings. */
           (array_agg(m.one order by m.one))[1:8] as matched
    from hit h
    left join matched m on m.client_id = h.client_id
    group by 1, 2, 3, 4, 5, 6
    order by matches desc, h.at desc
    limit ${limit}
  `;
}
