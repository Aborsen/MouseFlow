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
 * no backfill script. A cache with no version needs a person to remember to clear it. */
export const DIGEST_VERSION = 1;

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
export async function topUp(sql, ids, limit = TOP_UP_MAX) {
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
               when nullif(trim(e.v->'context'->>'app'), '') is not null
                 then left(trim(e.v->'context'->>'app'), 120)
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
      active_ms, waiting_ms, away_ms, by_kind, top_actions, apps, pattern, derived_at
    )
    select s.user_id, s.client_id, ${DIGEST_VERSION},
           coalesce(t.events, 0),
           coalesce(t.active_ms, 0), coalesce(t.waiting_ms, 0), coalesce(t.away_ms, 0),
           coalesce(k.by_kind, '{}'::jsonb),
           coalesce(p.top_actions, '[]'::jsonb),
           coalesce(a.apps, '[]'::jsonb),
           g.pattern,
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
export async function behaviour(sql, ids, fromIso, toIso) {
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
      select pattern as label, count(*)::bigint as n from mine where pattern is not null group by 1
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
