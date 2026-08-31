/* What a recording amounts to, derived once. The formula, and the one statement that applies it.
 *
 * WHY THIS FILE EXISTS is measured and is written in db/014_flow_digest.sql: unnesting every event of
 * every recording costs 2880 ms for the per-application query alone on the live account, and the cost is
 * linear in recordings. The inputs change only when a recording is written.
 *
 * WHY THE DERIVATION IS SQL AND NOT JAVASCRIPT. api/_transcript.js is the one thing that turns a payload
 * into prose, and a second derivation of the same numbers is exactly what that file warns about - the panel
 * and the dashboard describing one recording differently, both looking authoritative. This is not that
 * second derivation: it computes what SQL was already computing in api/insights.js, moved to where the
 * answer can be kept. The alternative - calling transcribe() per recording - would pull 28 MB of payload
 * into a serverless function to produce four numbers.
 *
 * The cost of that choice, named rather than left to be discovered: the thresholds below now exist in SQL
 * only. If they ever need to agree with something in _transcript.js, they will have to be passed rather
 * than duplicated.
 *
 * ONE DEFINITION OF EACH THRESHOLD. api/insights.js imports them from here rather than declaring its own,
 * because the per-application query's cap on a gap and this file's boundary between "away" and "waiting"
 * are the SAME number - and two copies of it would let the dashboard's applications pie and its attention
 * split disagree about the same two minutes.
 */

/* WHICH FORMULA PRODUCED A ROW. Bump this and every digest is recomputed on the next read - no migration,
 * no backfill script. A cache with no version needs a person to remember to clear it.
 *
 * 1 -> 2: application names are case-folded. Until then "claude" and "Claude" were two applications, two
 * rows and two patterns. This is the first time the mechanism has actually been used, and using it is the
 * whole argument for having built it: the change is one line of SQL and no migration.
 *
 * 2 -> 3: the shape - sixteen bucket counts - is derived too, so the Record screen can draw a recording it
 * does not hold the events of. */
export const DIGEST_VERSION = 3;

/* A gap longer than this inside a recording is somebody away from the machine, not time spent in an
 * application. Counting it would let one abandoned recording claim three hours in a CRM. */
export const EVENT_GAP_MAX_MS = 120_000;

/* And the boundary between doing and waiting. CHOSEN, NOT MEASURED, and that is worth saying because the
 * number decides a headline share: under five seconds a pause is inside an action - reading a label,
 * aiming - and over it, between two actions. Two seconds would call half of ordinary work waiting; ten
 * would hide reading an email. Measured consequence on the live account, so the choice can be argued with:
 * 45% active, 25% waiting, 29% away out of 20.9 hours. */
export const ACTIVE_MAX_MS = 5_000;

/* Per recording. Ten is enough to see what somebody actually pressed and short enough that a digest stays
 * a digest - the tail of a 424,730-event account is one press each. */
export const TOP_ACTIONS = 10;

/* How much of an account the assistant is handed WITHOUT asking, and every one of these is a token cost
 * paid on every question in the conversation - so each is a deliberate ceiling and not a round number.
 *
 * Twelve recordings, because the point is orientation and not inventory: the assistant needs to know what
 * this person records and roughly when, and it has list_recordings for the rest. Eight actions and five
 * patterns for the same reason. The whole block comes to about a page - enough that "what do I keep doing"
 * is answerable before a single lookup, small enough that a long conversation is not paying for a catalogue
 * on every turn. */
/* СКОЛЬКО ПОЛОСОК У ФОРМЫ ЗАПИСИ. Шестнадцать - потому что столько рисует web/src/components/Signal.tsx, и
 * это ОДНО число на обе стороны: сервер отдаёт шестнадцать, а тот, кому нужно меньше, складывает соседние.
 * Отдавать по запросу произвольное количество значило бы считать форму заново на каждый вид. */
export const SHAPE_BARS = 16;

export const SUMMARY_RECORDINGS = 12;
export const SUMMARY_ACTIONS = 8;
export const SUMMARY_PATTERNS = 5;

/* Applications named per recording, and steps of its pattern. The pattern is capped because the question is
 * whether ONE PROCESS repeated, and a sequence of twenty steps never repeats. */
export const APPS_PER_FLOW = 12;
export const PATTERN_STEPS = 8;

/* How many recordings one request may bring up to date. Bounded because a first read on an account with
 * hundreds of recordings would otherwise pay for all of them at once - which is the cost this whole file
 * exists to remove. Twenty converges a 44-recording account in three requests and then never runs again. */
export const TOP_UP_MAX = 20;

/* Recordings whose digest is missing, stale by formula, or older than the recording it describes.
 *
 * THE THIRD CASE IS THE ONE THAT MATTERS. A recording can be EDITED - api/transcript.js and the
 * assistant's remove_steps both rewrite user_flow.payload - and a digest derived before that edit
 * describes a recording that no longer exists. Comparing derived_at against updated_at makes that a fact
 * rather than a hope; without it the dashboard would keep reporting the removed steps forever.
 */
export async function staleCount(sql, ids) {
  const rows = await sql`
    select count(*)::int as n
    from user_flow f
    left join flow_digest d on d.user_id = f.user_id and d.client_id = f.client_id
    where f.user_id = any(${ids}::uuid[]) and f.deleted_at is null and f.kind = 'recorded'
      and (d.user_id is null or d.version < ${DIGEST_VERSION} or d.derived_at < f.updated_at)
  `;
  return rows[0] ? rows[0].n : 0;
}

/* Derive the digests that are missing or stale, newest first, at most `limit` of them.
 *
 * Newest first on purpose: the recordings somebody is most likely to ask about are the ones they just
 * made, so an account still catching up answers about this week before it answers about last month.
 *
 * ONE STATEMENT, and it is an upsert rather than a delete-and-insert: a reader running concurrently sees
 * either the old digest or the new one, never neither. Returns what it derived, so a caller can say so
 * instead of guessing whether anything happened.
 */
/* Also a plain function, for the same reason and to make the rule visible rather than remembered: in this
 * file, a name that RETURNS a query is not async, and a name that READS ROWS (staleCount) is. `await
 * topUp(...)` keeps working either way - the query object is thenable - but the two shapes no longer differ
 * for no reason, which is what let the bug above look normal. */
export function topUp(sql, ids, limit = TOP_UP_MAX) {
  return sql`
    with stale as (
      select f.user_id, f.client_id, f.payload, f.origins, f.source
      from user_flow f
      left join flow_digest d on d.user_id = f.user_id and d.client_id = f.client_id
      where f.user_id = any(${ids}::uuid[]) and f.deleted_at is null and f.kind = 'recorded'
        and (d.user_id is null or d.version < ${DIGEST_VERSION} or d.derived_at < f.updated_at)
      order by f.updated_at desc
      limit ${limit}
    ),
    /* Materialized because five groupings read it, and a CTE with several references may be evaluated
       again - which here means unnesting the payload again and re-running the correlated subquery over the
       pointer path. That subquery is the most expensive thing in this statement. */
    ev as materialized (
      select s.user_id, s.client_id, e.ord,
             nullif(trim(e.v->>'action'), '') as action,
             /* The gap before this event, in both spellings: the extension writes delay, the desktop
                recorder writes delayMs, and reading one would give the other half a duration of zero.
                No backticks anywhere inside these templates - the first one closes the query string, which
                is the third time this session that trap has cost a broken module. */
             greatest(0, case
               when jsonb_typeof(e.v->'delay')   = 'number' then (e.v->>'delay')::numeric
               when jsonb_typeof(e.v->'delayMs') = 'number' then (e.v->>'delayMs')::numeric
               else 0
             end) as delay_ms,
             /* A path event's own duration: the samples inside it each carry their dt. */
             coalesce((
               select sum(greatest(0, (p->>'dt')::numeric))
               from jsonb_array_elements(
                 case when jsonb_typeof(e.v->'points') = 'array' then e.v->'points' else '[]'::jsonb end
               ) p
               where jsonb_typeof(p->'dt') = 'number'
             ), 0) as move_ms,
             /* What this event names. A browser recording names a page on every focus and navigate; a
                desktop recording names an application on every click and every Focus marker. */
             case
               when e.v->>'url' ~ '^https?://'
                 then left(lower(regexp_replace(e.v->>'url', '^(https?://[^/?#]+).*$', '\\1')), 120)
               /* lower(), like the url branch immediately above it, and for the same reason rather than
                  for tidiness: "claude" and "Claude" are ONE application named twice, and on the live
                  account they were two rows of 201 and 37 minutes. Windows reports a process name and is
                  already lowercase; macOS reports a display name and is capitalised.
                  NOT the same thing as "chrome" against "Google Chrome" - those are different STRINGS, and
                  folding them would need a table somebody types, where one wrong row silently merges two
                  real applications. That one is left alone and written down in the limits. This one is the
                  same string, so folding it cannot merge anything that was not already one thing. */
               when nullif(trim(e.v->'context'->>'app'), '') is not null
                 then left(lower(trim(e.v->'context'->>'app')), 120)
             end as origin
      from stale s
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(s.payload->'events') = 'array' then s.payload->'events' else '[]'::jsonb end
      ) with ordinality as e(v, ord)
    ),
    /* Three parts of one measured time. They add up to it by construction: every millisecond of every gap
       lands in exactly one, and time the pointer spent moving is activity by definition. */
    timing as (
      select user_id, client_id,
             count(*)::int as events,
             sum(least(delay_ms, ${ACTIVE_MAX_MS}::numeric) + move_ms) as active_ms,
             sum(greatest(0, least(delay_ms, ${EVENT_GAP_MAX_MS}::numeric)
                             - ${ACTIVE_MAX_MS}::numeric))              as waiting_ms,
             sum(greatest(0, delay_ms - ${EVENT_GAP_MAX_MS}::numeric))  as away_ms
      from ev group by 1, 2
    ),
    /* The kind of each action, decided by the start of the string rather than a lookup table: the two
       agents and the extension spell them differently ("Left Click Down", "Key Ctrl+V", "path"). */
    acted as materialized (
      select user_id, client_id, action,
             case
               when action is null then 'other'
               when action ilike 'mouse movement%' or action = 'path' then 'move'
               when action ilike '%click%' then 'click'
               when action ilike 'key %' or action = 'Key Down' then 'key'
               when action ilike 'scroll%' then 'scroll'
               when action ilike '%drag%' then 'drag'
               when action = 'Focus' then 'focus'
               else 'other'
             end as kind
      from ev
    ),
    kinds as (
      select user_id, client_id, jsonb_object_agg(kind, n) as by_kind
      from (select user_id, client_id, kind, count(*)::int as n from acted group by 1, 2, 3) k
      group by 1, 2
    ),
    ranked as (
      select user_id, client_id, action, n,
             row_number() over (partition by user_id, client_id order by n desc, action) as rn
      from (
        select user_id, client_id, action, count(*)::int as n
        from acted where kind <> 'move' and action is not null group by 1, 2, 3
      ) a
    ),
    tops as (
      select user_id, client_id,
             jsonb_agg(jsonb_build_object('action', action, 'n', n) order by n desc, action) as top_actions
      from ranked where rn <= ${TOP_ACTIONS} group by 1, 2
    ),
    /* Carry the naming forward: an event that names an application owns the events after it until the next
       one does. Events before the first naming belong to no known application and stay null on purpose -
       attributing them to the first name that turns up would be a guess dressed as a measurement. */
    carried as (
      select user_id, client_id, ord, origin,
             least(delay_ms, ${EVENT_GAP_MAX_MS}::numeric) + move_ms as ms,
             count(origin) over (
               partition by user_id, client_id order by ord
               rows between unbounded preceding and current row
             ) as grp
      from ev
    ),
    placed as (
      select user_id, client_id, ms,
             first_value(origin) over (partition by user_id, client_id, grp order by ord) as at_origin
      from carried
    ),
    /* ФОРМА: тот же расчёт, что в web/src/components/Signal.tsx, перенесённый туда, где лежат события.
       Накопленная задержка - это часы: каждое событие несёт паузу ПЕРЕД собой, поэтому его место во времени
       есть сумма задержек до него. Дальше пролёт делится на равные части и считается, сколько событий в
       каждую попало.
       Потолок паузы здесь НЕ применяется - намеренно. Он существует, чтобы отсутствие человека не
       записывалось приложению как работа; форма же показывает, когда события происходили, и двухчасовой
       перерыв в середине записи - это правда о ней, а не искажение. Обрезав его, картинка сказала бы, что
       работа шла непрерывно. */
    clock as (
      select user_id, client_id, ord,
             sum(delay_ms) over (partition by user_id, client_id order by ord) as at
      from ev
    ),
    span as (
      select user_id, client_id, max(at) as total, count(*)::int as n from clock group by 1, 2
    ),
    bucket as (
      select c.user_id, c.client_id,
             least(${SHAPE_BARS} - 1,
                   floor((c.at / nullif(sp.total, 0)) * ${SHAPE_BARS})::int) as slot,
             count(*)::bigint as n
      from clock c join span sp on sp.user_id = c.user_id and sp.client_id = c.client_id
      where sp.total > 0
      group by 1, 2, 3
    ),
    /* generate_series, чтобы у формы всегда было ровно SHAPE_BARS чисел: массив переменной длины заставил
       бы читателя догадываться, какая часть записи пропущена, а пустая часть - это ноль, а не отсутствие. */
    shape as (
      select keys.user_id, keys.client_id,
             jsonb_agg(coalesce(b.n, 0) order by g.slot) as shape
      from (select distinct user_id, client_id from bucket) keys
      cross join generate_series(0, ${SHAPE_BARS} - 1) as g(slot)
      left join bucket b on b.user_id = keys.user_id and b.client_id = keys.client_id
        and b.slot = g.slot
      group by 1, 2
    ),
    app_ms as (
      select user_id, client_id, at_origin as name, sum(ms)::numeric as ms,
             row_number() over (partition by user_id, client_id order by sum(ms) desc, at_origin) as rn
      from placed where at_origin is not null group by 1, 2, 3
    ),
    apps as (
      select user_id, client_id,
             jsonb_agg(jsonb_build_object('name', name, 'ms', round(ms)) order by ms desc) as apps
      from app_ms where rn <= ${APPS_PER_FLOW} group by 1, 2
    ),
    /* The pattern: applications in the order they appeared, consecutive repeats collapsed. Without the
       collapse "chrome, chrome, chrome" and "chrome, chrome" would be different patterns and one process
       would scatter into a dozen unrelated ones. */
    named as (
      select user_id, client_id, ord, origin,
             lag(origin) over (partition by user_id, client_id order by ord) as prev
      from ev where origin is not null
    ),
    turns as (
      select user_id, client_id, origin,
             row_number() over (partition by user_id, client_id order by ord) as step
      from named where prev is distinct from origin
    ),
    pattern as (
      select user_id, client_id, string_agg(origin, ' -> ' order by step) as pattern
      from turns where step <= ${PATTERN_STEPS} group by 1, 2
    )
    insert into flow_digest (
      user_id, client_id, version, events,
      active_ms, waiting_ms, away_ms, by_kind, top_actions, apps, pattern, shape, derived_at
    )
    select s.user_id, s.client_id, ${DIGEST_VERSION},
           coalesce(t.events, 0),
           coalesce(t.active_ms, 0), coalesce(t.waiting_ms, 0), coalesce(t.away_ms, 0),
           coalesce(k.by_kind, '{}'::jsonb),
           coalesce(p.top_actions, '[]'::jsonb),
           coalesce(a.apps, '[]'::jsonb),
           g.pattern,
           /* Null, not sixteen zeros, when the recording has no timed events: a row of zeros is a picture
              of a recording where nothing happened, and null is what "there is no shape to draw" is. The
              reader distinguishes them - see web/src/components/Signal.tsx. */
           h.shape,
           now()
    /* LEFT JOINed from stale, not from timing: a recording with an empty events list has no row in any
       aggregate above, and joining the other way round would leave it stale forever - re-derived on every
       request, never satisfying the reader, costing a scan each time. It gets a digest of zeros instead,
       which is the true answer about it. */
    from stale s
    left join timing  t on t.user_id = s.user_id and t.client_id = s.client_id
    left join kinds   k on k.user_id = s.user_id and k.client_id = s.client_id
    left join tops    p on p.user_id = s.user_id and p.client_id = s.client_id
    left join apps    a on a.user_id = s.user_id and a.client_id = s.client_id
    left join pattern g on g.user_id = s.user_id and g.client_id = s.client_id
    left join shape   h on h.user_id = s.user_id and h.client_id = s.client_id
    on conflict (user_id, client_id) do update set
      version     = excluded.version,
      events      = excluded.events,
      active_ms   = excluded.active_ms,
      waiting_ms  = excluded.waiting_ms,
      away_ms     = excluded.away_ms,
      by_kind     = excluded.by_kind,
      top_actions = excluded.top_actions,
      apps        = excluded.apps,
      pattern     = excluded.pattern,
      shape       = excluded.shape,
      derived_at  = excluded.derived_at
    returning client_id, events
  `;
}

/* The behaviour block, read from the digests rather than from payloads.
 *
 * This is the whole point of the table: what cost 1700 ms of payload unnesting is now a group-by over one
 * short row per recording. The window is applied to the RECORDING's own date, the same way every other
 * query in api/insights.js applies it, so the two cannot disagree about which recordings are in scope.
 */
/* NOT `async`, and that is the whole contract of this function.
 *
 * The result goes into `sql.transaction([...])`, which takes an array of QUERY OBJECTS - unexecuted. An
 * `async` wrapper makes it a Promise instead, Neon rejects the whole array with "transaction() expects an
 * array of queries", and every request to the dashboard answers 500. It shipped that way.
 *
 * What hid it: a Neon query object is thenable. So `await behaviour(...)` in a standalone script unwraps
 * the Promise, finds the thenable, and runs it - the measurement passed at 60 ms while the only path the
 * endpoint actually uses was broken. A function returning a query must be a plain function, and awaiting
 * one still works because of that same thenability. */
export function behaviour(sql, ids, fromIso, toIso) {
  return sql`
    with mine as (
      select d.*
      from flow_digest d
      join user_flow f on f.user_id = d.user_id and f.client_id = d.client_id
      where d.user_id = any(${ids}::uuid[]) and f.deleted_at is null and f.kind = 'recorded'
        and coalesce(f.created_at, f.updated_at) >= ${fromIso}
        and coalesce(f.created_at, f.updated_at) <= ${toIso}
    ),
    kind_rows as (
      select k.key as label, sum((k.value)::text::numeric)::bigint as n
      from mine, jsonb_each(mine.by_kind) k group by 1
    ),
    top_rows as (
      select t->>'action' as label, sum((t->>'n')::numeric)::bigint as n
      from mine, jsonb_array_elements(mine.top_actions) t group by 1
    ),
    pattern_rows as (
      /* AT LEAST TWO STEPS, and this filter is the difference between a finding and a tautology.
         A one-step pattern says only that a recording never left one application - true, and not a
         process. Under the heading "a process done by hand more than once" it read as "you did the Chrome
         process six times", which is not a claim the data supports and not one anybody can act on.
         Filtered HERE rather than when writing: a single-application recording is a real fact and the
         column keeps it. What this query answers is "which SEQUENCE repeated", and a sequence needs a
         second step to be one. */
      select pattern as label, count(*)::bigint as n
      from mine where pattern is not null and position(' -> ' in pattern) > 0 group by 1
    )
    select 'attention'::text as kind, 'active'::text as label, 0::bigint as n,
           coalesce(sum(active_ms), 0)::numeric as ms from mine
    union all select 'attention', 'waiting', 0, coalesce(sum(waiting_ms), 0)::numeric from mine
    union all select 'attention', 'away',    0, coalesce(sum(away_ms), 0)::numeric    from mine
    union all select 'action', label, n, 0::numeric from kind_rows
    union all select 'top',    label, n, 0::numeric from top_rows
    union all select 'pattern', label, n, 0::numeric from pattern_rows
  `;
}


/* ------------------------------------------------------------------ what this account is, without asking
 *
 * WHY THIS EXISTS. The assistant used to start every conversation blind: it knew the rules and had tools,
 * and "what do I keep doing by hand?" cost it three lookups before it could say anything. Handing it the
 * shape of the account up front is what the digests made affordable - three short queries over one row per
 * recording, where the same thing over payload was 28 MB and several seconds.
 *
 * ALL TIME, and that is stated rather than implied. A summary that silently meant "the last month" would
 * have the assistant answer questions about June with April's numbers, and it has no way to notice. The
 * range the summary covers travels with it, so the prompt can say which dates it is true of.
 *
 * ONE READ-ONLY TRANSACTION. The three parts are one picture: a summary whose totals came from before a
 * sync and whose recording list came from after it describes an account that never existed. And the
 * transaction takes QUERY OBJECTS - which is why `behaviour` and the two below are plain functions. That
 * distinction cost a production outage once; see the comment on `behaviour`.
 */
function summaryTotals(sql, ids) {
  return sql`
    select count(*)::int                          as recordings,
           coalesce(sum(d.events), 0)::bigint     as events,
           coalesce(sum(d.active_ms), 0)::numeric as active_ms,
           coalesce(sum(d.waiting_ms), 0)::numeric as waiting_ms,
           coalesce(sum(d.away_ms), 0)::numeric   as away_ms,
           min(coalesce(f.created_at, f.updated_at)) as first_at,
           max(coalesce(f.created_at, f.updated_at)) as last_at
    from flow_digest d
    join user_flow f on f.user_id = d.user_id and f.client_id = d.client_id
    where d.user_id = any(${ids}::uuid[]) and f.deleted_at is null and f.kind = 'recorded'
  `;
}

/* The most recent few, by the same date the rest of the product places a recording by.
 *
 * A LEFT JOIN, so a recording with no digest yet still appears - with nulls where its numbers would be.
 * Dropping it would make the newest recording, which is the one somebody is most likely to ask about,
 * the one the assistant cannot see. */
function summaryRecent(sql, ids, limit) {
  return sql`
    select f.client_id, f.name, f.source,
           coalesce(f.created_at, f.updated_at) as at,
           d.events, d.active_ms, d.waiting_ms, d.away_ms, d.pattern, d.apps
    from user_flow f
    left join flow_digest d on d.user_id = f.user_id and d.client_id = f.client_id
    where f.user_id = any(${ids}::uuid[]) and f.deleted_at is null and f.kind = 'recorded'
    order by coalesce(f.created_at, f.updated_at) desc
    limit ${limit}
  `;
}

/* Everything the assistant is told before it asks anything. Returns plain data; the wording is the
 * caller's, because the prompt's voice belongs to the prompt and not to a SQL module.
 *
 * `stale` rides along for the same reason the dashboard shows it: a summary drawn from part of an account,
 * presented as the account, reads identically to one drawn from all of it. */
export async function accountSummary(sql, ids, options = {}) {
  const recent = Math.max(1, Math.min(options.recordings || SUMMARY_RECORDINGS, 50));
  /* All time. Not "a very long window" - the two ends are the widest instants Postgres will compare
   * against a timestamptz here, so nothing is silently outside them. */
  const from = '0001-01-01T00:00:00.000Z';
  const to = '9999-12-31T23:59:59.999Z';

  const [totalsRows, recentRows, blockRows] = await sql.transaction(
    [summaryTotals(sql, ids), summaryRecent(sql, ids, recent), behaviour(sql, ids, from, to)],
    { readOnly: true },
  );

  const t = totalsRows[0] || {};
  const n = (v) => {
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const of = (kind) => blockRows.filter((r) => r.kind === kind);
  const att = { active: 0, waiting: 0, away: 0 };
  for (const r of of('attention')) if (r.label in att) att[r.label] = n(r.ms);
  const measured = att.active + att.waiting + att.away;

  return {
    recordings: n(t.recordings),
    events: n(t.events),
    firstAt: t.first_at ? new Date(t.first_at).toISOString() : null,
    lastAt: t.last_at ? new Date(t.last_at).toISOString() : null,
    attention: {
      measuredSeconds: Math.round(measured / 1000),
      activeSeconds: Math.round(att.active / 1000),
      waitingSeconds: Math.round(att.waiting / 1000),
      awaySeconds: Math.round(att.away / 1000),
      activeUnderMs: ACTIVE_MAX_MS,
      awayOverMs: EVENT_GAP_MAX_MS,
    },
    /* Movement separated here rather than by the caller, because every reader of this wants it separated
     * and one of them would forget. */
    moves: n((of('action').find((r) => r.label === 'move') || {}).n),
    byKind: of('action')
      .filter((r) => r.label !== 'move')
      .map((r) => ({ kind: r.label, count: n(r.n) }))
      .sort((a, b) => b.count - a.count),
    topActions: of('top')
      .map((r) => ({ action: r.label, count: n(r.n) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, options.actions || SUMMARY_ACTIONS),
    /* Only the repeated ones. A pattern seen once is a recording, not a finding, and the assistant has
     * the recording list right above it. */
    patterns: of('pattern')
      .map((r) => ({ steps: r.label, recordings: n(r.n) }))
      .filter((p) => p.recordings > 1)
      .sort((a, b) => b.recordings - a.recordings)
      .slice(0, options.patterns || SUMMARY_PATTERNS),
    recent: recentRows.map((r) => ({
      id: r.client_id,
      name: r.name || null,
      source: r.source || null,
      at: r.at ? new Date(r.at).toISOString() : null,
      /* Null, not nought, when this recording has no digest yet: nought seconds reads as an empty
       * recording, which is a claim about the recording rather than about what has been derived. */
      summarised: r.events != null,
      events: r.events == null ? null : n(r.events),
      activeSeconds: r.active_ms == null ? null : Math.round(n(r.active_ms) / 1000),
      awaySeconds: r.away_ms == null ? null : Math.round(n(r.away_ms) / 1000),
      pattern: r.pattern || null,
      apps: Array.isArray(r.apps) ? r.apps.slice(0, 4).map((a) => a && a.name).filter(Boolean) : [],
    })),
  };
}


/* WHERE THE RECORDED TIME WENT, BY APPLICATION - out of the digests, and it answers a question the
 * dashboard's own per-application query cannot.
 *
 * THE TWO ARE NOT RIVALS AND MUST NOT BE READ AS ONE. api/insights.js groups application time out of
 * RUNS, and only runs whose steps carry a url - which desktop runs do not - plus agent step time. This
 * groups out of RECORDINGS, every one of them, desktop included. So "where did my time go" has two honest
 * answers over two different bodies of evidence, and the only way that becomes a contradiction is if
 * either one forgets to say which it is. Both descriptions say it.
 *
 * A plain function returning a query, like everything else here that goes into a transaction. */
export function appsByRecording(sql, ids, fromIso, toIso) {
  return sql`
    with mine as (
      select d.apps
      from flow_digest d
      join user_flow f on f.user_id = d.user_id and f.client_id = d.client_id
      where d.user_id = any(${ids}::uuid[]) and f.deleted_at is null and f.kind = 'recorded'
        and coalesce(f.created_at, f.updated_at) >= ${fromIso}
        and coalesce(f.created_at, f.updated_at) <= ${toIso}
    )
    select a->>'name' as name,
           sum((a->>'ms')::numeric)::numeric as ms,
           count(*)::int as recordings
    from mine, jsonb_array_elements(mine.apps) a
    where nullif(trim(a->>'name'), '') is not null
    group by 1
    order by ms desc nulls last
  `;
}

/* Один дайджест, по идентификатору записи. Проверка владения - в WHERE по user_id, как у всего остального
 * в этом файле: идентификатор записи приходит от модели и сам по себе не является правом. */
export function digestOf(sql, ids, flowId) {
  return sql`
    select f.client_id, f.name, f.source, coalesce(f.created_at, f.updated_at) as at,
           d.version, d.events, d.active_ms, d.waiting_ms, d.away_ms,
           d.by_kind, d.top_actions, d.apps, d.pattern, d.derived_at, f.updated_at
    from user_flow f
    left join flow_digest d on d.user_id = f.user_id and d.client_id = f.client_id
    where f.user_id = any(${ids}::uuid[]) and f.client_id = ${flowId} and f.deleted_at is null
    limit 1
  `;
}
