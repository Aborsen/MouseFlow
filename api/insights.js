/* What actually happened, counted in the database.
 *
 *   GET /api/insights?days=30
 *
 * Every number the app shows today is summed in the browser from /api/sync, which returns the last
 * 60 runs. That makes "how many runs failed last quarter" unanswerable: the answer is not in the
 * window, and nothing in the page can tell the difference between "no runs" and "not sent". So the
 * counting happens here, over the whole window, in SQL - one round trip, and the browser only
 * formats what it is handed.
 *
 * One transaction, read-only, for a reason beyond tidiness: the totals, the day series and the
 * per-application split have to agree with each other. Eight separate queries with a sync landing
 * between two of them produces a page whose header and chart contradict each other, and there is no
 * way for a reader to tell which half is wrong.
 *
 * WHAT THIS ENDPOINT WILL NOT DO is invent a field. The tables hold runs and flows, and that is all;
 * several things a dashboard like this usually claims - time saved against a human baseline, the
 * passive hours between runs, per-step timing for desktop runs - are simply not in there. Those are
 * in `gaps`, with the real counts, and the page shows them. A dashboard that hides its own blind
 * spots is worse than one that names them, because the blind spots are exactly where someone will
 * put weight.
 *
 * Where the time numbers come from, precisely:
 *
 *   a recording   payload.events carry a delay since the previous event, and a `path` event's points
 *                 carry a dt each. The sum of both is real, measured, elapsed time.
 *                 The two halves spell the delay differently - the extension writes `delay`, the
 *                 desktop recorder writes `delayMs` - so both keys are read. Assuming one would
 *                 silently give the other half a duration of zero.
 *   a run         started_at to finished_at is wall clock. An extension run's steps also carry a
 *                 per-step `ms` and the page the step acted on, which is the only per-application
 *                 timing anywhere in the schema. A desktop run's steps carry { tool, input } and
 *                 nothing else - no timing at all.
 *
 * Anything that cannot be attributed to a named application is put in ONE bucket and reported, not
 * spread proportionally over the applications that could be named. Spreading it would make every
 * number slightly untrue and none of them checkable.
 */

import { neon } from '@neondatabase/serverless';
import { whoIsCalling } from './_session.js';

const DAYS_DEFAULT = 30;
const DAYS_MAX = 365;                 // a year of runs is a lot of jsonb to unroll; past that, ask again

/* Every list is capped, and every cap is reported back with the total it was cut from, so the page
 * can say "top 12 of 34" instead of implying it is everything. An uncapped list here is a response
 * whose size is decided by whoever recorded the most. */
const APPS_MAX = 12;
const REPEATED_MAX = 10;
const SLOWEST_MAX = 10;
const SLOWEST_MIN_CALLS = 2;          // a "median" over one call is that one call wearing a hat
const FAILURES_MAX = 10;
const SKILLS_MAX = 20;

/* A run longer than this is two machines' clocks disagreeing, not a run. The same rule as hoursOf()
 * in web/src/lib/api.ts, deliberately - if it changes it has to change in both, or the page and this
 * endpoint will report different hours for the same run and both will look authoritative. */
const RUN_MAX_SECONDS = 12 * 3600;

/* A gap longer than this inside a recording is somebody away from the machine, not time spent in an
 * application. Counting it would let one abandoned recording claim three hours in the CRM. The part
 * of the gap beyond this is dropped rather than bucketed - it is not activity at all - and how much
 * was dropped is reported in `gaps`, so the drop is visible rather than quietly flattering. */
const EVENT_GAP_MAX_MS = 120_000;

/* Per-account, best effort, and for one honest reason: this endpoint unrolls every event of every
 * recording in the window, which is the most expensive read in the product. Same construction as
 * api/claude.js - a serverless instance holds its own window, so the real limit is this times the
 * number of warm instances. It stops a stuck client, not a determined one. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const hits = new Map();

function rateLimited(key) {
  const now = Date.now();
  const seen = (hits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  seen.push(now);
  hits.set(key, seen);
  // Unbounded growth would outlive the instance; drop windows nobody is using.
  if (hits.size > 500) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  }
  return seen.length > RATE_MAX;
}

function cors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin',
    /^chrome-extension:\/\//.test(origin) ? origin : 'https://mouse-agent.vercel.app');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  /* No Allow-Credentials, as everywhere else here: the page is same-origin so CORS does not apply to
   * it, and the extension sends an explicit header. Not setting it is what stops a cross-site page
   * reading someone's history. */
  res.setHeader('Access-Control-Max-Age', '86400');
}

const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'insights_error', message } });

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (v, places) => {
  const factor = 10 ** places;
  return Math.round(num(v) * factor) / factor;
};
/* Timestamps come back from the driver as Date objects and days come back as strings. Both have to
 * leave here as one shape, because a client that has to guess will guess wrong once. */
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const share = (part, whole) => (num(whole) > 0 ? round(num(part) / num(whole), 4) : 0);

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') return fail(res, 405, 'GET only');
  if (!process.env.DATABASE_URL) return fail(res, 503, 'This deployment has no database configured.');

  const sql = neon(process.env.DATABASE_URL);

  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (err) {
    return fail(res, 500, 'could not check who is calling: ' + err.message);
  }
  if (!who) {
    return fail(res, 401, 'sign in on the web app, or pair this extension with a device token');
  }

  if (rateLimited(who.id)) {
    res.setHeader('Retry-After', '60');
    return fail(res, 429, 'too many insight requests - wait a minute');
  }

  const asked = Number.parseInt(String((req.query && req.query.days) || ''), 10);
  const days = Math.min(Math.max(Number.isFinite(asked) ? asked : DAYS_DEFAULT, 1), DAYS_MAX);
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const fromIso = from.toISOString();

  try {
    const out = await gather(sql, who.id, fromIso);
    return res.status(200).json({
      ok: true,
      window: {
        days,
        from: fromIso,
        to: to.toISOString(),
        /* Days are UTC days, because date_trunc uses the database's time zone and Neon's is UTC. A
         * run at 01:00 local time therefore lands on the previous day for somebody in Kyiv. Said
         * here so the page can label the axis honestly rather than implying local days. */
        timeZone: 'UTC',
      },
      ...out,
    });
  } catch (err) {
    return fail(res, 500, err.message);
  }
}

/* ------------------------------------------------------------------------ the counting */

async function gather(sql, userId, fromIso) {
  /* A run's timestamp is coalesce(started_at, synced_at) throughout. started_at is nullable and some
   * runs arrived without one; those runs happened, so dropping them would quietly undercount, and
   * synced_at is never null. How many needed the fallback is reported in `gaps`. */

  const totalsQ = sql`
    with raw as (
      select outcome, flow_id, said, steps, started_at, finished_at,
             case when started_at is not null and finished_at is not null
               then extract(epoch from (finished_at - started_at))::float8 end as span
      from user_run
      where user_id = ${userId} and coalesce(started_at, synced_at) >= ${fromIso}
    ),
    r as (
      select raw.*,
             case when span > 0 and span < ${RUN_MAX_SECONDS} then span end as secs,
             /* Does this run carry per-step timing at all? Extension runs do; desktop runs carry
              * { tool, input } and nothing else, which is why slowestSteps is browser-only. */
             exists (
               select 1
               from jsonb_array_elements(
                 case when jsonb_typeof(raw.steps) = 'array' then raw.steps else '[]'::jsonb end
               ) s
               where jsonb_typeof(s->'ms') = 'number'
             ) as timed
      from raw
    )
    select
      count(*)::int                                              as runs,
      count(*) filter (where outcome = 'ok')::int                 as ok,
      count(*) filter (where outcome = 'failed')::int             as failed,
      count(*) filter (where outcome = 'stopped')::int            as stopped,
      count(*) filter (where outcome = 'running')::int            as running,
      coalesce(sum(secs), 0)::float8                              as agent_seconds,
      count(*) filter (where secs is null)::int                   as no_wall_clock,
      count(*) filter (where not timed)::int                      as no_step_timing,
      count(*) filter (where flow_id is null)::int                as without_flow,
      count(*) filter (
        where jsonb_typeof(said) = 'array' and jsonb_array_length(said) > 0
      )::int                                                      as with_said
    from r
  `;

  const flowsQ = sql`
    select
      count(*) filter (where kind = 'recorded')::int as recordings,
      count(*) filter (where kind = 'created')::int  as created_skills
    from user_flow
    where user_id = ${userId} and deleted_at is null
      /* created_at is nullable - the client sends it and older builds did not - so a flow with no
       * creation date is placed by when it was last written rather than dropped. */
      and coalesce(created_at, updated_at) >= ${fromIso}
  `;

  /* Every day in the window, whether or not anything ran. A series with holes in it draws a chart
   * that lies about its own shape, and the page cannot fill the missing days itself without knowing
   * which time zone the boundaries were cut on. */
  const byDayQ = sql`
    with raw as (
      select date_trunc('day', coalesce(started_at, synced_at)) as day, outcome,
             case when started_at is not null and finished_at is not null
               then extract(epoch from (finished_at - started_at))::float8 end as span
      from user_run
      where user_id = ${userId} and coalesce(started_at, synced_at) >= ${fromIso}
    ),
    r as (
      select day, outcome, case when span > 0 and span < ${RUN_MAX_SECONDS} then span end as secs
      from raw
    ),
    d as (
      select generate_series(
        date_trunc('day', ${fromIso}::timestamptz), date_trunc('day', now()), interval '1 day'
      ) as day
    )
    select to_char(d.day, 'YYYY-MM-DD')                        as day,
           count(r.day)::int                                   as runs,
           count(*) filter (where r.outcome = 'ok')::int        as ok,
           count(*) filter (where r.outcome = 'failed')::int    as failed,
           coalesce(sum(r.secs), 0)::float8                     as agent_seconds
    from d left join r on r.day = d.day
    group by d.day
    order by d.day
  `;

  /* -------------------------------------------------------------- where the time went
   *
   * The heart of it, and the part that is easiest to fake. The attribution rules, in order:
   *
   *   an extension recording   events carry a url on every focus, so the origin in force is carried
   *                            forward and each event's own milliseconds go to the page it happened
   *                            on. This is the only genuinely per-moment attribution in the schema.
   *   a desktop recording      events from an 0.6.0 agent onwards carry the application the click
   *                            landed in (`context.app`), and a `Focus` event names the new one every
   *                            time the foreground window changes. So the application in force is
   *                            carried forward exactly as an origin is, and each event's own
   *                            milliseconds go to it. This is per-moment, and it is why a desktop
   *                            recording has time in this table at all: before it, the only datum
   *                            was payload.windows - a once-a-second sample for the recording as a
   *                            WHOLE - so the rule was "one named application gets everything,
   *                            several gets bucketed", and every real recording touches several.
   *   an older desktop one     no event names anything, so that older rule still applies underneath:
   *                            exactly one sampled window takes the recording's time, several takes
   *                            none of it. Splitting a sample across a recording would be a guess
   *                            dressed as a measurement.
   *   an agent run             each step's `ms` goes to the origin of the page the step ACTED on
   *                            (`url`), not to `wentTo` - wentTo is where a click landed you, which
   *                            is the next step's page and not this one's.
   *   the rest of a run        wall clock minus the step time that could be placed. That absorbs
   *                            model thinking time, untimed desktop steps and steps with no page, in
   *                            one bucket, with nothing double-counted: a run's placed step time
   *                            plus its remainder comes to its wall clock. The exception is a run
   *                            whose steps are timed but whose start-and-finish pair is not usable:
   *                            there is no wall clock to divide up, so its step time stands on its
   *                            own, and `gaps` says how many runs that is.
   */
  const appsQ = sql`
    with flow as (
      select client_id, source, origins, payload
      from user_flow
      where user_id = ${userId} and deleted_at is null and kind = 'recorded'
        and coalesce(created_at, updated_at) >= ${fromIso}
    ),
    ev_raw as (
      select f.client_id, f.source, e.ord,
             /* The gap before this event. Both spellings, because the two recorders disagree and
              * reading only one would give the other half a duration of zero. */
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
             /* What this event names, on either half.
              *
              * A browser recording names a page on every focus and navigate; a desktop recording names
              * an APPLICATION on every click and on every Focus marker, from an 0.6.0 agent onwards.
              * They go in one column because everything downstream carries it forward identically -
              * the only difference is the word used for it, which the kind column decides below. */
             case
               when e.v->>'url' ~ '^https?://'
                 then left(lower(regexp_replace(e.v->>'url', '^(https?://[^/?#]+).*$', '\\1')), 120)
               when nullif(trim(e.v->'context'->>'app'), '') is not null
                 then left(trim(e.v->'context'->>'app'), 120)
             end as origin
      from flow f,
        /* The payload is client-written JSON and nothing validates its inner shape on the way in, so
         * every unrolling here is guarded by jsonb_typeof. One malformed row must not 500 the page. */
        jsonb_array_elements(
          case when jsonb_typeof(f.payload->'events') = 'array' then f.payload->'events' else '[]'::jsonb end
        ) with ordinality as e(v, ord)
    ),
    ev as (
      select client_id, source, ord, origin,
             least(delay_ms, ${EVENT_GAP_MAX_MS}::numeric) + move_ms as ms,
             greatest(0, delay_ms - ${EVENT_GAP_MAX_MS}::numeric)    as dropped_ms
      from ev_raw
    ),
    /* Carry the origin forward: a running count of the events that named one forms the groups, and
     * within a group the first row is the one that named it. Events before the first focus event
     * belong to no known page and stay null on purpose. */
    carried as (
      select client_id, source, ord, ms, dropped_ms, origin,
             count(origin) over (
               partition by client_id order by ord rows between unbounded preceding and current row
             ) as grp
      from ev
    ),
    placed as (
      select client_id, source, ms, dropped_ms,
             first_value(origin) over (partition by client_id, grp order by ord) as at_origin
      from carried
    ),
    /* The one name a whole recording can be attributed to, when its events do not say. Exactly one,
     * or none: "several" is not an answer to "where did this happen". */
    solo as (
      select f.client_id,
             case when f.source = 'desktop' then (
               select case when count(distinct t.title) = 1 then min(t.title) end
               from (
                 select nullif(trim(w->>'title'), '') as title
                 from jsonb_array_elements(
                   case when jsonb_typeof(f.payload->'windows') = 'array'
                     then f.payload->'windows' else '[]'::jsonb end
                 ) w
               ) t
               where t.title is not null
             ) else (
               select case when count(distinct o.origin) = 1 then min(o.origin) end
               from (select nullif(trim(x), '') as origin from unnest(f.origins) x) o
               where o.origin is not null
             ) end as only_name
      from flow f
    ),
    flow_time as (
      select p.client_id,
             (case when p.source = 'desktop' then 'app' else 'origin' end)::text as kind,
             left(coalesce(p.at_origin, s.only_name), 120) as name,
             p.ms, p.dropped_ms
      from placed p join solo s on s.client_id = p.client_id
    ),
    wall as (
      select client_id, steps,
             case when started_at is not null and finished_at is not null
                    and extract(epoch from (finished_at - started_at)) > 0
                    and extract(epoch from (finished_at - started_at)) < ${RUN_MAX_SECONDS}
               then extract(epoch from (finished_at - started_at))::float8
               else 0 end as secs
      from user_run
      where user_id = ${userId} and coalesce(started_at, synced_at) >= ${fromIso}
    ),
    step as (
      select w.client_id,
             case when jsonb_typeof(s->'ms') = 'number' then greatest(0, (s->>'ms')::numeric) end as ms,
             case when s->>'url' ~ '^https?://'
               then left(lower(regexp_replace(s->>'url', '^(https?://[^/?#]+).*$', '\\1')), 120)
             end as origin
      from wall w,
        jsonb_array_elements(
          case when jsonb_typeof(w.steps) = 'array' then w.steps else '[]'::jsonb end
        ) s
    ),
    run_left as (
      select w.client_id,
             greatest(0, w.secs - coalesce(sum(
               case when st.origin is not null and st.ms is not null then st.ms else 0 end
             ), 0) / 1000.0)::float8 as secs
      from wall w left join step st on st.client_id = w.client_id
      group by w.client_id, w.secs
    ),
    combined as (
      select name, kind,
             count(distinct client_id)::int as recordings,
             0::int                         as runs,
             (sum(ms) / 1000.0)::float8     as seconds
      from flow_time where name is not null group by name, kind
      union all
      select origin as name, 'origin'::text as kind,
             0::int, count(distinct client_id)::int, (sum(ms) / 1000.0)::float8
      from step where origin is not null and ms is not null group by origin
    ),
    rolled as (
      select name, kind, sum(recordings)::int as recordings, sum(runs)::int as runs,
             sum(seconds)::float8 as seconds
      from combined group by name, kind
      union all
      -- Everything real that could not be given a name.
      select null::text, 'none'::text, 0::int, 0::int, (
        (select coalesce(sum(ms), 0) from flow_time where name is null) / 1000.0
        + (select coalesce(sum(secs), 0) from run_left)
      )::float8
      union all
      -- And time dropped as "away from the machine": out of the totals, but still reported.
      select null::text, 'idle'::text, 0::int, 0::int,
             ((select coalesce(sum(dropped_ms), 0) from flow_time) / 1000.0)::float8
    )
    select name, kind, recordings, runs, seconds,
           /* Both computed before the LIMIT, so the shares are shares of everything and the count is
            * the count of everything - which is what lets the page say "top 12 of 34". Idle time is
            * out of the denominator: it was dropped, not attributed. */
           sum(case when kind = 'idle' then 0 else seconds end) over ()::float8   as all_seconds,
           count(*) filter (where kind not in ('none', 'idle')) over ()::int      as groups
    from rolled
    -- The two bucket rows sort to the front so the cap can never eat them.
    order by (kind in ('none', 'idle')) desc, seconds desc, name
    limit ${APPS_MAX + 2}
  `;

  /* --------------------------------------------------------------- what keeps happening
   *
   * The signature is the GOAL, lowercased, with the three kinds of value that vary between two runs
   * of the same errand replaced: email addresses, urls, and quoted phrases.
   *
   * Why that and not something else. The alternatives were the flow id, which is null on every
   * historical run and so would find almost nothing; the ordered set of origins, which makes "check
   * the mail" and "close the account" one workflow because both happen on one site; and the raw goal,
   * which makes "invoice to a@x" and "invoice to b@y" two workflows and so never counts anything
   * twice. The three patterns are deliberately the SAME three extension/skills.js already
   * parameterises when it turns a run into a skill - so "this happened 14 times, automate it" and the
   * skill that automating it would produce agree about what varies.
   *
   * A replay has no goal, so it is grouped by the flow it replayed, which for a replay IS the
   * workflow. A run with neither is counted nowhere here, and how many that is is in `gaps`.
   */
  const repeatedQ = sql`
    with base as (
      select r.client_id, r.flow_id, r.kind,
             coalesce(r.started_at, r.synced_at) as at,
             nullif(trim(r.goal), '')            as goal,
             nullif(trim(f.name), '')            as flow_name,
             case
               when r.kind = 'agent' and nullif(trim(r.goal), '') is not null then
                 'goal:' || left(trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
                   lower(r.goal),
                   '[\\w.+-]+@[\\w-]+\\.[\\w.-]{2,}', '{email}', 'g'),
                   'https?://[^\\s"'']+',             '{url}',   'g'),
                   '"[^"]{2,120}"',                   '{text}',  'g'),
                   '\\s+',                            ' ',       'g')), 200)
               when r.flow_id is not null then 'flow:' || r.flow_id
             end as signature
      from user_run r
      left join user_flow f on f.user_id = r.user_id and f.client_id = r.flow_id
      where r.user_id = ${userId} and coalesce(r.started_at, r.synced_at) >= ${fromIso}
    )
    select signature,
           count(*)::int as times,
           max(at)       as last_at,
           -- The most recent wording, so the page shows something a person recognises.
           left((array_agg(coalesce(goal, flow_name, flow_id, 'a replay') order by at desc))[1], 160) as label,
           coalesce(array_agg(distinct flow_id) filter (where flow_id is not null), '{}') as flow_ids,
           count(*) over ()::int as groups
    from base
    where signature is not null
    group by signature
    having count(*) > 1
    order by times desc, last_at desc
    limit ${REPEATED_MAX}
  `;

  /* Extension runs only, and not by choice: a desktop run's steps carry { tool, input } with no
   * timing, so there is nothing to take a median of. Both key spellings are read because the two
   * producers disagree - extension/background.js writes `tool`, extension/agent.js writes `name`. */
  const slowestQ = sql`
    with s as (
      select left(coalesce(nullif(trim(e->>'tool'), ''), nullif(trim(e->>'name'), ''), '(unnamed)'), 60) as tool,
             (e->>'ms')::numeric as ms
      from user_run r,
        jsonb_array_elements(
          case when jsonb_typeof(r.steps) = 'array' then r.steps else '[]'::jsonb end
        ) e
      where r.user_id = ${userId} and coalesce(r.started_at, r.synced_at) >= ${fromIso}
        and jsonb_typeof(e->'ms') = 'number'
    )
    select tool,
           count(*)::int                                            as calls,
           percentile_cont(0.5) within group (order by ms)::float8    as median_ms,
           percentile_cont(0.9) within group (order by ms)::float8    as p90_ms,
           count(*) over ()::int                                     as groups
    from s
    group by tool
    having count(*) >= ${SLOWEST_MIN_CALLS}
    order by median_ms desc
    limit ${SLOWEST_MAX}
  `;

  /* Failures grouped by what went wrong rather than by run. Numbers are flattened to 'n' so
   * "used all 24 steps" and "used all 12 steps" are recognised as one recurring problem; the example
   * keeps the real text, so nothing is lost by the grouping. */
  const failuresQ = sql`
    with f as (
      select client_id, coalesce(started_at, synced_at) as at,
             coalesce(nullif(trim(error), ''), '(no reason recorded)') as error,
             left(trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
               coalesce(nullif(trim(error), ''), '(no reason recorded)'),
               'https?://[^\\s"'']+',             '{url}',   'g'),
               '[\\w.+-]+@[\\w-]+\\.[\\w.-]{2,}', '{email}', 'g'),
               '[0-9]+',                          'n',       'g'),
               '\\s+',                            ' ',       'g')), 140) as reason
      from user_run
      where user_id = ${userId} and coalesce(started_at, synced_at) >= ${fromIso}
        and (outcome = 'failed' or nullif(trim(error), '') is not null)
        /* Except somebody pressing Stop. Both halves record a stopped run by writing the single word
         * "stopped" as its error - extension/agent.js and web/src/lib/desktop-engine.ts both do, and
         * both map exactly that word to outcome 'stopped' - so without this line the commonest thing
         * that "went wrong" is a deliberate stop, while the header beside it counts only the runs
         * that failed, and the two look like they are counting different things. A stopped run that
         * carries a real message is still a failure with a reason, and still appears. */
        and not (outcome = 'stopped' and lower(trim(coalesce(error, ''))) = 'stopped')
    )
    select reason,
           count(*)::int as times,
           max(at)       as last_at,
           (array_agg(client_id order by at desc))[1]        as run_id,
           left((array_agg(error order by at desc))[1], 400) as example_error,
           count(*) over ()::int as groups
    from f
    group by reason
    order by times desc, last_at desc
    limit ${FAILURES_MAX}
  `;

  /* Per skill, from the runs that name one. An inner join on flow_id, so this is "flows that ran",
   * not "flows you have" - the second is what /api/sync is for. flow_id was null on every historical
   * row and is only now being written, so this finds recent runs only; how many runs it could not
   * place is in `gaps`. */
  const skillsQ = sql`
    with r as (
      select r.client_id, r.flow_id, r.outcome,
             coalesce(r.started_at, r.synced_at) as at,
             case when r.started_at is not null and r.finished_at is not null
                    and extract(epoch from (r.finished_at - r.started_at)) > 0
                    and extract(epoch from (r.finished_at - r.started_at)) < ${RUN_MAX_SECONDS}
               then extract(epoch from (r.finished_at - r.started_at))::float8 end as secs
      from user_run r
      where r.user_id = ${userId} and coalesce(r.started_at, r.synced_at) >= ${fromIso}
        and r.flow_id is not null
    )
    select f.client_id                                             as flow_id,
           coalesce(nullif(trim(f.name), ''), '(unnamed)')         as name,
           f.kind, f.source,
           count(*)::int                                           as runs,
           count(*) filter (where r.outcome = 'ok')::int            as ok,
           count(*) filter (where r.outcome = 'failed')::int        as failed,
           -- Null rather than nought when no run of it was timed: nought would read as instant.
           (percentile_cont(0.5) within group (order by r.secs)
             filter (where r.secs is not null))::float8             as median_seconds,
           max(r.at)                                               as last_run_at,
           count(*) over ()::int                                    as groups
    from r
    join user_flow f on f.user_id = ${userId} and f.client_id = r.flow_id
    group by f.client_id, f.name, f.kind, f.source
    order by runs desc, last_run_at desc
    limit ${SKILLS_MAX}
  `;

  const [totalsRows, flowRows, dayRows, appRows, repeatedRows, slowRows, failureRows, skillRows] =
    await sql.transaction(
      [totalsQ, flowsQ, byDayQ, appsQ, repeatedQ, slowestQ, failuresQ, skillsQ],
      { readOnly: true },
    );

  const t = totalsRows[0] || {};
  const f = flowRows[0] || {};

  const totals = {
    runs: num(t.runs),
    ok: num(t.ok),
    failed: num(t.failed),
    stopped: num(t.stopped),
    running: num(t.running),
    recordings: num(f.recordings),
    createdSkills: num(f.created_skills),
    agentHours: round(num(t.agent_seconds) / 3600, 2),
  };

  /* Shaped from the same counts the header uses rather than counted again, so the chart and the
   * header can never disagree about how many runs failed. */
  const byOutcome = ['ok', 'failed', 'stopped', 'running'].map((outcome) => ({
    outcome,
    runs: totals[outcome],
    share: share(totals[outcome], totals.runs),
  }));

  const byDay = dayRows.map((r) => ({
    day: String(r.day),
    runs: num(r.runs),
    ok: num(r.ok),
    failed: num(r.failed),
    agentSeconds: round(r.agent_seconds, 1),
  }));

  /* all_seconds and groups are the same on every row - they are window totals taken before the cap -
   * so any row will do, and the buckets are pulled out by kind rather than by position. */
  const allSeconds = appRows.length ? num(appRows[0].all_seconds) : 0;
  const appGroups = appRows.length ? num(appRows[0].groups) : 0;
  const bucketSeconds = num((appRows.find((r) => r.kind === 'none') || {}).seconds);
  const idleSeconds = num((appRows.find((r) => r.kind === 'idle') || {}).seconds);

  /* `share` is a share of ALL measured time, the unattributable bucket included - so the shares of
   * `applications` plus `unattributed.share` come to one, and a dataset where most time cannot be
   * placed looks like one. Dividing by attributed time only would make a 1% slice read as 30% and
   * there would be nothing on the page to give that away. */
  const applications = appRows
    .filter((r) => r.kind === 'app' || r.kind === 'origin')
    .map((r) => ({
      name: String(r.name || '(unnamed)'),
      kind: r.kind === 'app' ? 'app' : 'origin',
      recordings: num(r.recordings),
      runs: num(r.runs),
      seconds: round(r.seconds, 1),
      share: share(r.seconds, allSeconds),
    }));

  const repeated = repeatedRows.map((r) => ({
    signature: String(r.signature),
    label: String(r.label || '(no wording kept)'),
    times: num(r.times),
    lastAt: iso(r.last_at),
    flowIds: Array.isArray(r.flow_ids) ? r.flow_ids.map(String) : [],
  }));

  const slowestSteps = slowRows.map((r) => ({
    tool: String(r.tool),
    calls: num(r.calls),
    medianMs: round(r.median_ms, 0),
    p90Ms: round(r.p90_ms, 0),
  }));

  const failures = failureRows.map((r) => ({
    reason: String(r.reason),
    times: num(r.times),
    lastAt: iso(r.last_at),
    example: {
      runId: r.run_id == null ? null : String(r.run_id),
      error: String(r.example_error || ''),
    },
  }));

  const skills = skillRows.map((r) => ({
    flowId: String(r.flow_id),
    name: String(r.name),
    kind: r.kind === 'created' ? 'created' : 'recorded',
    source: r.source === 'desktop' ? 'desktop' : 'web',
    runs: num(r.runs),
    ok: num(r.ok),
    failed: num(r.failed),
    medianSeconds: r.median_seconds == null ? null : round(r.median_seconds, 1),
    lastRunAt: iso(r.last_run_at),
  }));

  return {
    totals,
    byOutcome,
    byDay,
    applications,
    /* Named, not spread. This is real measured time that the stored data cannot attribute to any
     * application: multi-application desktop recordings, agent steps with no page or no timing, and
     * the thinking time between a run's steps. Its share completes the applications pie, which is
     * the whole point of keeping it visible. */
    unattributed: {
      seconds: round(bucketSeconds, 1),
      share: share(bucketSeconds, allSeconds),
      why: 'Time that happened but cannot be placed: agent steps with no page or no timing, the model '
        + 'thinking between steps, the part of a recording before anything named where it was, and '
        + 'desktop recordings made by an agent older than 0.6.0 that touched more than one application '
        + '- those have only a once-a-second sample of the front window, for the recording as a whole, '
        + 'and splitting that across it would be a guess dressed as a measurement.',
    },
    repeated,
    slowestSteps,
    failures,
    skills,
    gaps: gapsFor(t, idleSeconds),
    caps: {
      days: DAYS_MAX,
      applications: { shown: applications.length, total: appGroups, limit: APPS_MAX },
      repeated: {
        shown: repeated.length,
        total: repeatedRows.length ? num(repeatedRows[0].groups) : 0,
        limit: REPEATED_MAX,
      },
      slowestSteps: {
        shown: slowestSteps.length,
        total: slowRows.length ? num(slowRows[0].groups) : 0,
        limit: SLOWEST_MAX,
        minCalls: SLOWEST_MIN_CALLS,
      },
      failures: {
        shown: failures.length,
        total: failureRows.length ? num(failureRows[0].groups) : 0,
        limit: FAILURES_MAX,
      },
      skills: {
        shown: skills.length,
        total: skillRows.length ? num(skillRows[0].groups) : 0,
        limit: SKILLS_MAX,
      },
    },
  };
}

/* ---------------------------------------------------------------------------- the gaps
 *
 * First-class, not a footnote. Each one is a question somebody will ask of this page, and the reason
 * the stored data cannot answer it - with the real count from this window wherever there is one, so
 * a gap that has stopped mattering shows a nought rather than a warning nobody rereads.
 */
function gapsFor(t, idleSeconds) {
  const runs = num(t.runs);
  return [
    {
      question: 'How much time did this save me?',
      why: 'Nothing here holds how long the same task takes by hand, and there is no field for it in '
        + 'user_run. Agent hours are measured wall clock; "time saved" would be a number this '
        + 'endpoint made up, so it does not report one.',
    },
    {
      question: 'Why is my mail time listed under a browser?',
      why: 'Because the application a click landed in is a PROCESS name, read from the window manager, '
        + 'and a web app hosted in a browser is that browser: Outlook as a PWA counts as chrome, and '
        + 'two different sites in two tabs are one name here. The window TITLE says "Outlook" and the '
        + 'transcript of the recording shows it per step - but picking a product out of a title to '
        + 'relabel this table would be a guess dressed as a measurement, which is the thing this '
        + 'endpoint refuses to do everywhere else.',
    },
    {
      question: 'Where did the rest of my day go?',
      why: 'Only runs and recordings are timed. The hours between them are recorded nowhere, so these '
        + 'day totals are activity, not a working day - and whatever a pause inside a recording runs '
        + 'past two minutes is dropped rather than counted as time in an application ('
        + round(idleSeconds / 60, 1) + ' minutes of it in this window).',
    },
    {
      question: 'Which step of a desktop run was slow?',
      why: "A desktop run's steps carry { tool, input } and no timing at all - only extension runs "
        + 'carry a per-step ms. ' + num(t.no_step_timing) + ' of ' + runs + ' runs in this window '
        + 'carry no per-step timing, so the slowest-step table is browser runs only.',
    },
    {
      question: 'What did the agent say while it worked?',
      /* This used to state as a fact that nothing has ever written user_run.said, and then print a
       * count beside it that contradicted the claim - on the test account 6 of 12 runs in the window
       * carry commentary. The count is the whole claim now, because it is the part that stays true
       * whichever build wrote the row. */
      why: num(t.with_said) + ' of ' + runs + ' runs in this window have anything in user_run.said, '
        + 'so an empty one is not evidence that the run said nothing - some builds never wrote the '
        + 'column at all. Either way this endpoint counts rather than quotes, so no commentary from '
        + 'a run is reproduced on this page.',
    },
    {
      question: 'Which skill did each run replay?',
      why: 'user_run.flow_id was null for every historical row and is only now being written. '
        + num(t.without_flow) + ' of ' + runs + ' runs in this window carry no flow id, so the '
        + 'per-skill table and any flow-based repetition see recent runs only.',
    },
    {
      question: 'Exactly when did an older run start?',
      why: num(t.no_wall_clock) + ' of ' + runs + ' runs have no usable start-and-finish pair, so '
        + 'they are placed in the day series by when they synced and contribute no hours.',
    },
    {
      question: 'Did the run actually do the right thing?',
      why: 'outcome is what the client reported when it stopped. A run that finished "ok" having done '
        + 'the wrong thing is stored as ok, and nothing in these tables can contradict it.',
    },
  ];
}
