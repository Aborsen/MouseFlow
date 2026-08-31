/* What actually happened, counted in the database.
 *
 *   GET /api/insights?days=30
 *   GET /api/insights?from=2026-08-21T00:00:00.000Z&to=2026-08-21T23:59:59.999Z
 *   GET /api/insights?days=30&team=t_ab12          the same counts over everybody in one team
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
 * WHOSE ROWS ARE COUNTED. One account by default - the caller's - which is what every existing caller asks
 * for and gets. With `team`, every member of that team, and ONLY for an owner or an admin of it: the same
 * line db/008_team.sql draws, resolved by api/_team-scope.js so there is one derivation of it rather than
 * one per endpoint. A member who asks for the team scope is refused by name and keeps their own numbers.
 *
 * What that scope does NOT open is content. Everything counted here is a count, a duration or a name that
 * was already in a list a manager could see: how many runs, how they ended, which application, what a skill
 * is called. There is no query in this file that returns an event, a transcript, a goal's page or a chat -
 * so "the team's dashboard" cannot become a way to read a colleague's screen.
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
/* Потолок теперь считается в базе, а не в памяти процесса - см. api/_spend.mjs. Здешний Map жил в
 * ОДНОМ тёплом инстансе, а сколько их, решает трафик: то есть настоящий предел умножался ровно тогда,
 * когда был нужнее всего. Комментарий рядом со старым счётчиком это признавал. */
import { overSpend, spentWhy } from './_spend.mjs';
import { peopleFor, scopeFor } from './_team-scope.js';
/* Server-side crashes reach Sentry from here. See api/_report.js — no dependency, and it
 * deliberately sends the route and the message, never the query string or the body. */
import { report, wrap } from './_report.js';
/* Один заголовочный набор на все маршруты - см. api/_cors.mjs. Семь копий этих строк разошлись
 * ровно в том месте, где это стоило дороже всего: chats.js отражал ЛЮБОЙ origin и выдавал
 * Allow-Credentials, то есть чужая страница читала разговоры человека его же кукой. */
import { cors } from './_cors.mjs';
/* СТАТИЧЕСКИМ импортом, в отличие от api/chat.js, и разница обоснована: там ленивый импорт защищает
 * ассистента от отсутствия ФАЙЛА АНАЛИТИКИ - без него остальные вопросы всё равно отвечаются. Здесь
 * дайджест НЕ дополнение: без него у этого маршрута нет блока про внимание, действия и узоры, и маршрут,
 * который поднялся и отвечает половиной страницы, хуже маршрута, который не поднялся. Пороги при этом
 * приходят отсюда же, чтобы у них было одно определение: у запроса по приложениям потолок на паузу и у
 * разбиения времени граница «отсутствовал» - это ОДНО число, и две копии позволили бы круговой диаграмме
 * и разбиению времени разойтись в оценке одних и тех же двух минут. */
import {
  ACTIVE_MAX_MS, APPS_PER_FLOW, DIGEST_VERSION, EVENT_GAP_MAX_MS, PATTERN_STEPS, TOP_ACTIONS,
  TOP_UP_MAX, behaviour, staleCount, topUp,
} from './_digest.mjs';

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

/* EVENT_GAP_MAX_MS и ACTIVE_MAX_MS живут в ./_digest.mjs - см. импорт выше о том, почему одно определение.
 * Смысл первого здесь не изменился: часть паузы за этим потолком не относится ни к какому приложению, и
 * сколько её было, сказано в `gaps`, чтобы вычитание было видно, а не молча льстило. */

/* ВНИМАНИЕ, ОЖИДАНИЕ И ОТСУТСТВИЕ - три части одного измеренного времени, и до этой волны у дашборда была
 * только первая, причём под именем «активность». Замерено на живом аккаунте: из 20.9 часов записанного
 * времени 6.1 приходится на паузы длиннее двух минут и 5.2 - на промежутки от пяти секунд до двух минут.
 * Всё это ИЗМЕРЕНО, но показывалась только последняя часть, а самая большая жила в `gaps` как оговорка о
 * неточности. Сама формула и обе границы - в ./_digest.mjs. */
const PATTERNS_MAX = 8;

/* Per-account, best effort, and for one honest reason: this endpoint unrolls every event of every
 * recording in the window, which is the most expensive read in the product. Same construction as
 * api/claude.js - a serverless instance holds its own window, so the real limit is this times the
 * number of warm instances. It stops a stuck client, not a determined one. */
/* Потолок на звонящего переехал в api/_spend.mjs и считается в базе.
 *
 * Здесь стоял Map в области модуля, и его собственный комментарий признавал главное: на serverless
 * каждый тёплый инстанс держит своё окно, так что настоящий предел был этим числом, умноженным на
 * количество проснувшихся - то есть он рос ровно тогда, когда был нужнее всего. Шесть маршрутов
 * повторяли эту конструкцию, каждый со своей копией и своим признанием.
 *
 * Числа не потерялись: они перечислены в LIMITS одним списком, где их наконец можно сравнить. */


const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'insights_error', message } });

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (v, places) => {
  const factor = 10 ** places;
  return Math.round(num(v) * factor) / factor;
};
/** An ISO timestamp from the query, or null. Anything unparseable is nothing rather than an error: the
 *  fallback below is a perfectly good window, and refusing the whole request over a stray character would
 *  make a bookmarked URL a dead end. */
function parseWhen(raw) {
  if (!raw) return null;
  const when = new Date(String(raw));
  return Number.isFinite(when.getTime()) ? when : null;
}

/* Timestamps come back from the driver as Date objects and days come back as strings. Both have to
 * leave here as one shape, because a client that has to guess will guess wrong once. */
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const share = (part, whole) => (num(whole) > 0 ? round(num(part) / num(whole), 4) : 0);

async function handler(req, res) {
  cors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') return fail(res, 405, 'GET only');
  if (!process.env.DATABASE_URL) return fail(res, 503, 'This deployment has no database configured.');

  const sql = neon(process.env.DATABASE_URL);

  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (err) {
    await report(err, req, { route: 'insights' });
    return fail(res, 500, 'could not check who is calling: ' + err.message);
  }
  if (!who) {
    return fail(res, 401, 'sign in on the web app, or pair this extension with a device token');
  }

  const budget = await overSpend(sql, who.id, 'insights');
  if (!budget.ok) {
    res.setHeader('Retry-After', String(Math.ceil(budget.retryInMs / 1000)));
    return fail(res, 429, spentWhy(budget, 'reads'));
  }


  /* Two ways to name a window, and the explicit one wins.
   *
   * `days` counts back from now and is what every existing caller sends. `from`/`to` name the two ends,
   * which is the only way to say "today" or "that week in June" HONESTLY: a day boundary belongs to the
   * person's own clock, and the server has no idea what theirs is. The page computes local midnight and
   * sends it; this end never guesses a time zone it was not told about. */
  const asked = Number.parseInt(String((req.query && req.query.days) || ''), 10);
  const wantFrom = parseWhen(req.query && req.query.from);
  const wantTo = parseWhen(req.query && req.query.to);

  let from;
  let to;
  if (wantFrom && wantTo && wantTo > wantFrom) {
    /* Bounded by the same ceiling as `days`, for the same reason: a year of runs is a lot of jsonb to
     * unroll, and an arbitrary pair of dates could ask for a decade. */
    const span = Math.min(wantTo - wantFrom, DAYS_MAX * 86_400_000);
    to = new Date(wantTo.getTime());
    from = new Date(to.getTime() - span);
  } else {
    const n = Math.min(Math.max(Number.isFinite(asked) ? asked : DAYS_DEFAULT, 1), DAYS_MAX);
    to = new Date();
    from = new Date(to.getTime() - n * 86_400_000);
  }
  /* Reported as a real number rather than as the parameter that was sent: a custom range of 36 hours is
   * not "1 day", and the page labels its axis from this. */
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
  const fromIso = from.toISOString();

  /* A team id in the query string is a claim, not a permission - scopeFor turns it into a set of accounts
   * or into a refusal, resolving the caller from the credential every time. */
  let scope;
  try {
    scope = await scopeFor(
      sql,
      who,
      String((req.query && req.query.team) || '').trim() || null,
      String((req.query && req.query.person) || '').trim() || null,
    );
  } catch (err) {
    await report(err, req, { route: 'insights' });
    return fail(res, 500, 'could not check that team: ' + err.message);
  }
  if (scope.error) return fail(res, scope.error.status, scope.error.message);

  try {
    /* Two id sets, and the difference matters. `ids` is what gets COUNTED - one member when the view is
     * filtered to a person. `memberIds` is the whole team, so the per-person breakdown still lists
     * everybody and the filter can be changed to somebody else. */
    const out = await gather(
      sql, scope.ids, fromIso, to.toISOString(), scope.kind === 'team', scope.memberIds,
    );
    /* Who the numbers belong to, sent back rather than assumed by the page. A dashboard that says "47 runs"
     * without saying whose is the one screenshot that gets pasted into a chat and misread. */
    const said = scope.kind === 'team'
      ? shapeScope({
        scope,
        people: await peopleFor(sql, scope.memberIds),
        rows: out.people,
        callerId: who.id,
      })
      : { kind: 'personal', people: [] };
    delete out.people;

    return res.status(200).json({
      ok: true,
      scope: said,
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
    await report(err, req, { route: 'insights' });
    return fail(res, 500, err.message);
  }
}

/* Who the numbers belong to, shaped for the page.
 *
 * A PURE FUNCTION, and exported, for a reason that cost a production 500: this used to be a dozen lines
 * inline in the handler, where the only way to run it was to have a database, a session and a team - so it
 * was never run by anything but a real request. A `const people` referenced one line above its own
 * declaration therefore shipped, and every filtered request answered "Cannot access 'people' before
 * initialization". Out here it takes plain arguments and returns a plain object, so the suite executes it.
 */
export function shapeScope({ scope, people, rows, callerId }) {
  const roles = new Map((scope.members || []).map((m) => [m.id, m.role]));
  const said = { kind: 'team', team: scope.team, role: scope.role, people: [] };

  /* The resolved person rather than the id that was asked for, so the page labels its header from the
   * answer and not from its own request. */
  if (scope.person) {
    const one = people.get(scope.person) || {};
    said.person = {
      id: scope.person,
      name: one.name ?? null,
      email: one.email ?? null,
      you: scope.person === callerId,
    };
  }

  said.people = (rows || []).map((row) => {
    const person = people.get(row.id) || {};
    return {
      ...row,
      role: roles.get(row.id) || 'member',
      name: person.name ?? null,
      email: person.email ?? null,
      you: row.id === callerId,
    };
  /* Busiest first, and a tie broken by name rather than by whatever order the database felt like - a table
   * that reshuffles between two refreshes of the same window looks broken. */
  }).sort((a, b) => (b.runs - a.runs)
    || (b.recordings - a.recordings)
    || String(a.name || a.email || a.id).localeCompare(String(b.name || b.email || b.id)));

  return said;
}

/* ------------------------------------------------------------------------ the counting */

/* EXPORTED so it can be RUN, which is the lesson shapeScope above was extracted for and which this file
 * had to learn twice.
 *
 * The whole of the dashboard's assembly lives in here, and until now the only way to execute it was to have
 * a database, a session and a request - so it was never executed by anything but production. That is how an
 * `async` on a function whose result goes into sql.transaction() shipped: every source-text assertion
 * passed, the standalone measurement passed, and every real request answered 500.
 *
 * api/_test-insights.mjs now calls this with a fake `sql` that enforces Neon's contract - a tagged template
 * gives back a query OBJECT, and transaction() refuses an array holding anything else. */
export async function gather(sql, ids, fromIso, toIso, wantPeople, peopleIds) {
  /* A run's timestamp is coalesce(started_at, synced_at) throughout. started_at is nullable and some
   * runs arrived without one; those runs happened, so dropping them would quietly undercount, and
   * synced_at is never null. How many needed the fallback is reported in `gaps`. */

  /* The window immediately before this one, the same length. Computed here rather than in SQL so the two
   * queries cannot disagree about where the boundary is. */
  const prevFromIso = new Date(
    new Date(fromIso).getTime() - (new Date(toIso).getTime() - new Date(fromIso).getTime()),
  ).toISOString();

  /* Counts only, over the previous window, so a headline number can be compared with something. Same rules as
   * the totals below - the same RUN_MAX_SECONDS clamp, the same coalesce on the timestamp - because a delta
   * between two differently-counted numbers is worse than no delta. */
  const prevTotalsQ = sql`
    with raw as (
      select outcome,
             case when started_at is not null and finished_at is not null
               then extract(epoch from (finished_at - started_at))::float8 end as span
      from user_run
      where user_id = any(${ids}::uuid[])
        and coalesce(started_at, synced_at) >= ${prevFromIso}
        and coalesce(started_at, synced_at) < ${fromIso}
    )
    select
      count(*)::int                                   as runs,
      count(*) filter (where outcome = 'ok')::int      as ok,
      count(*) filter (where outcome = 'failed')::int  as failed,
      count(*) filter (where outcome = 'stopped')::int as stopped,
      coalesce(sum(case when span > 0 and span < ${RUN_MAX_SECONDS} then span end), 0)::float8
        as agent_seconds
    from raw
  `;

  const totalsQ = sql`
    with raw as (
      select outcome, flow_id, said, steps, started_at, finished_at,
             case when started_at is not null and finished_at is not null
               then extract(epoch from (finished_at - started_at))::float8 end as span
      from user_run
      where user_id = any(${ids}::uuid[]) and coalesce(started_at, synced_at) >= ${fromIso}
        and coalesce(started_at, synced_at) <= ${toIso}
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
    where user_id = any(${ids}::uuid[]) and deleted_at is null
      /* created_at is nullable - the client sends it and older builds did not - so a flow with no
       * creation date is placed by when it was last written rather than dropped. */
      and coalesce(created_at, updated_at) >= ${fromIso}
        and coalesce(created_at, updated_at) <= ${toIso}
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
      where user_id = any(${ids}::uuid[]) and coalesce(started_at, synced_at) >= ${fromIso}
        and coalesce(started_at, synced_at) <= ${toIso}
    ),
    r as (
      select day, outcome, case when span > 0 and span < ${RUN_MAX_SECONDS} then span end as secs
      from raw
    ),
    d as (
      select generate_series(
        date_trunc('day', ${fromIso}::timestamptz), date_trunc('day', ${toIso}::timestamptz), interval '1 day'
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
      /* Keyed by ACCOUNT AND client id, not by client id alone.
       *
       * A client id is generated on the machine that made the recording, so it is unique to a person and
       * not to the table. One account asking about itself could never collide; a team scope counts several
       * accounts at once, and two people's recordings sharing an id would have their events interleaved
       * into one partition below and attributed to whichever named an application first. Composing the key
       * costs a concatenation and removes the question. */
      select user_id::text || ':' || client_id as key, source, origins, payload
      from user_flow
      where user_id = any(${ids}::uuid[]) and deleted_at is null and kind = 'recorded'
        and coalesce(created_at, updated_at) >= ${fromIso}
        and coalesce(created_at, updated_at) <= ${toIso}
    ),
    ev_raw as (
      select f.key, f.source, e.ord,
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
      from flow f,
        /* The payload is client-written JSON and nothing validates its inner shape on the way in, so
         * every unrolling here is guarded by jsonb_typeof. One malformed row must not 500 the page. */
        jsonb_array_elements(
          case when jsonb_typeof(f.payload->'events') = 'array' then f.payload->'events' else '[]'::jsonb end
        ) with ordinality as e(v, ord)
    ),
    ev as (
      select key, source, ord, origin,
             least(delay_ms, ${EVENT_GAP_MAX_MS}::numeric) + move_ms as ms,
             greatest(0, delay_ms - ${EVENT_GAP_MAX_MS}::numeric)    as dropped_ms
      from ev_raw
    ),
    /* Carry the origin forward: a running count of the events that named one forms the groups, and
     * within a group the first row is the one that named it. Events before the first focus event
     * belong to no known page and stay null on purpose. */
    carried as (
      select key, source, ord, ms, dropped_ms, origin,
             count(origin) over (
               partition by key order by ord rows between unbounded preceding and current row
             ) as grp
      from ev
    ),
    placed as (
      select key, source, ms, dropped_ms,
             first_value(origin) over (partition by key, grp order by ord) as at_origin
      from carried
    ),
    /* The one name a whole recording can be attributed to, when its events do not say. Exactly one,
     * or none: "several" is not an answer to "where did this happen". */
    solo as (
      select f.key,
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
      select p.key,
             (case when p.source = 'desktop' then 'app' else 'origin' end)::text as kind,
             left(coalesce(p.at_origin, s.only_name), 120) as name,
             p.ms, p.dropped_ms
      from placed p join solo s on s.key = p.key
    ),
    wall as (
      select user_id::text || ':' || client_id as key, steps,
             case when started_at is not null and finished_at is not null
                    and extract(epoch from (finished_at - started_at)) > 0
                    and extract(epoch from (finished_at - started_at)) < ${RUN_MAX_SECONDS}
               then extract(epoch from (finished_at - started_at))::float8
               else 0 end as secs
      from user_run
      where user_id = any(${ids}::uuid[]) and coalesce(started_at, synced_at) >= ${fromIso}
        and coalesce(started_at, synced_at) <= ${toIso}
    ),
    step as (
      select w.key,
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
      select w.key,
             greatest(0, w.secs - coalesce(sum(
               case when st.origin is not null and st.ms is not null then st.ms else 0 end
             ), 0) / 1000.0)::float8 as secs
      from wall w left join step st on st.key = w.key
      group by w.key, w.secs
    ),
    combined as (
      select name, kind,
             count(distinct key)::int as recordings,
             0::int                         as runs,
             (sum(ms) / 1000.0)::float8     as seconds
      from flow_time where name is not null group by name, kind
      union all
      select origin as name, 'origin'::text as kind,
             0::int, count(distinct key)::int, (sum(ms) / 1000.0)::float8
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
             /* The same clamp every duration in this file uses, so a repeat's time is measured the way the
              * headline agent time is. A run with no usable pair of timestamps contributes nothing rather
              * than a guess. */
             case when r.started_at is not null and r.finished_at is not null
               and extract(epoch from (r.finished_at - r.started_at)) > 0
               and extract(epoch from (r.finished_at - r.started_at)) < ${RUN_MAX_SECONDS}
               then extract(epoch from (r.finished_at - r.started_at))::float8 end as secs,
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
      where r.user_id = any(${ids}::uuid[]) and coalesce(r.started_at, r.synced_at) >= ${fromIso}
        and coalesce(r.started_at, r.synced_at) <= ${toIso}
    )
    select signature,
           count(*)::int as times,
           max(at)       as last_at,
           coalesce(sum(secs), 0)::float8 as seconds,
           -- How many of the repeats had a usable clock, so the page can say when the total is partial.
           count(secs)::int as timed,
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
      where r.user_id = any(${ids}::uuid[]) and coalesce(r.started_at, r.synced_at) >= ${fromIso}
        and coalesce(r.started_at, r.synced_at) <= ${toIso}
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
      where user_id = any(${ids}::uuid[]) and coalesce(started_at, synced_at) >= ${fromIso}
        and coalesce(started_at, synced_at) <= ${toIso}
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
      select r.user_id, r.client_id, r.flow_id, r.outcome,
             coalesce(r.started_at, r.synced_at) as at,
             case when r.started_at is not null and r.finished_at is not null
                    and extract(epoch from (r.finished_at - r.started_at)) > 0
                    and extract(epoch from (r.finished_at - r.started_at)) < ${RUN_MAX_SECONDS}
               then extract(epoch from (r.finished_at - r.started_at))::float8 end as secs
      from user_run r
      where r.user_id = any(${ids}::uuid[]) and coalesce(r.started_at, r.synced_at) >= ${fromIso}
        and coalesce(r.started_at, r.synced_at) <= ${toIso}
        and r.flow_id is not null
    )
    select f.client_id                                             as flow_id,
           f.user_id::text                                         as owner_id,
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
    /* The run's OWN owner, not the caller's. Pinning this to the person asking was right while the only
     * possible scope was one account and quietly wrong the moment a team's runs are counted: it would have
     * matched a colleague's run against a same-id flow of the caller's, or dropped it entirely. */
    join user_flow f on f.user_id = r.user_id and f.client_id = r.flow_id
    group by f.user_id, f.client_id, f.name, f.kind, f.source
    order by runs desc, last_run_at desc
    limit ${SKILLS_MAX}
  `;

  /* One row per account in the scope, for the team view: the same counts the header shows, split by the
   * person they belong to.
   *
   * Every id gets a row, including the ones with nothing in the window - a team table that silently omits
   * whoever did not record anything reads as a roster, and then somebody wonders why a colleague is
   * missing. `left join` over the id list, so a quiet fortnight is a line of noughts rather than an
   * absence.
   *
   * COUNTS AND DATES ONLY, which is the same line the roster on the Teams screen draws. There is no column
   * here that could tell you what somebody was working on. */
  /* Over the whole team, NOT over `ids`: when the view is filtered to one person this is still the list
   * every name comes from, and a one-row picker is a filter nobody can leave. */
  const roster = peopleIds && peopleIds.length ? peopleIds : ids;
  const peopleQ = sql`
    with ids as (select unnest(${roster}::uuid[]) as id),
    f as (
      select user_id,
             count(*) filter (where kind = 'recorded')::int as recordings,
             count(*) filter (where kind = 'created')::int  as created_skills,
             max(coalesce(created_at, updated_at))          as last_made
      from user_flow
      where user_id = any(${roster}::uuid[]) and deleted_at is null
        and coalesce(created_at, updated_at) >= ${fromIso}
        and coalesce(created_at, updated_at) <= ${toIso}
      group by user_id
    ),
    r as (
      select user_id,
             count(*)::int                                   as runs,
             count(*) filter (where outcome = 'ok')::int      as ok,
             count(*) filter (where outcome = 'failed')::int  as failed,
             count(*) filter (where outcome = 'stopped')::int as stopped,
             -- The same clamp every duration in this file uses, so a person's hours add up to the header's.
             coalesce(sum(case when started_at is not null and finished_at is not null
               and extract(epoch from (finished_at - started_at)) > 0
               and extract(epoch from (finished_at - started_at)) < ${RUN_MAX_SECONDS}
               then extract(epoch from (finished_at - started_at))::float8 end), 0)::float8 as agent_seconds,
             max(coalesce(started_at, synced_at))            as last_run
      from user_run
      where user_id = any(${roster}::uuid[]) and coalesce(started_at, synced_at) >= ${fromIso}
        and coalesce(started_at, synced_at) <= ${toIso}
      group by user_id
    )
    select ids.id::text                          as id,
           coalesce(f.recordings, 0)::int        as recordings,
           coalesce(f.created_skills, 0)::int    as created_skills,
           coalesce(r.runs, 0)::int              as runs,
           coalesce(r.ok, 0)::int                as ok,
           coalesce(r.failed, 0)::int            as failed,
           coalesce(r.stopped, 0)::int           as stopped,
           coalesce(r.agent_seconds, 0)::float8  as agent_seconds,
           r.last_run, f.last_made
    from ids
    left join f on f.user_id = ids.id
    left join r on r.user_id = ids.id
  `;

  /* ДАЙДЖЕСТЫ ПРИВОДЯТСЯ В ПОРЯДОК ДО ЧТЕНИЯ, и ограниченной порцией.
   *
   * Пишущий запрос не может ехать в read-only транзакции ниже, поэтому он здесь и до неё - тогда чтение
   * видит уже свежие строки. Порция ограничена по той же причине, по которой таблица вообще появилась:
   * первый запрос на аккаунте с сотнями записей иначе заплатил бы за все сразу. Аккаунт из 44 записей
   * сходится за три запроса и больше не платит.
   *
   * Отказ ЗДЕСЬ НЕ РОНЯЕТ СТРАНИЦУ. Не приведённый в порядок дайджест значит неполный блок про поведение,
   * а не отсутствующий дашборд, - и `stale` в ответе говорит, сколько записей ещё не разобрано, чтобы
   * «активность 45%» не читалась как «по всем записям», когда она по половине.
   *
   * ЭТОГО ОБЕЩАНИЯ НЕДОСТАТОЧНО, и держится оно ниже, а не здесь: перехват вокруг записи закрывает только
   * половину пути. Два ЧИТАЮЩИХ запроса блока едут внутри транзакции, а транзакция падает целиком - так что
   * пока это было единственной защитой, отсутствующая таблица flow_digest роняла весь дашборд, а не свои
   * три раздела. Проверено исполнением в api/_test-insights.mjs, а не обещано в комментарии. */
  let derived = 0;
  let stale = 0;
  let digestProblem = null;
  try {
    const done = await topUp(sql, ids, TOP_UP_MAX);
    derived = Array.isArray(done) ? done.length : 0;
    stale = await staleCount(sql, ids);
  } catch (e) {
    digestProblem = e && e.message ? String(e.message).slice(0, 200) : 'the digest could not be derived';
  }

  /* Appended rather than always run: in a personal scope the breakdown is the header with one row under
   * it, and it would be a query the commonest request on this endpoint pays for and nothing reads. */
  /* Названы, а не собраны прямо в литерале массива: ниже их нужно уметь ИЗЪЯТЬ из него, а безымянный
   * вызов изъять нельзя - пришлось бы вырезать по позиции, то есть по числу, которое разъедется с этим
   * массивом при первом же добавленном запросе.
   *
   * Группировка по коротким строкам дайджестов вместо разворота payload - то, ради чего таблица и
   * появилась. Замер до: 1700 мс на окно, и линейно по числу записей. */
  const behaviourNowQ = behaviour(sql, ids, fromIso, toIso);
  const behaviourPrevQ = behaviour(sql, ids, prevFromIso, fromIso);

  const asked = [totalsQ, prevTotalsQ, flowsQ, byDayQ, appsQ, repeatedQ, slowestQ, failuresQ, skillsQ,
    behaviourNowQ, behaviourPrevQ];
  if (wantPeople) asked.push(peopleQ);

  /* ОДНА ТРАНЗАКЦИЯ НА ОБЫЧНОМ ПУТИ, и падение блока про поведение не забирает с собой остальное.
   *
   * Транзакция - неделимая: один отказавший запрос отвергает все двенадцать. Пока это была единственная
   * попытка, `flow_digest`, которого нет - развёрнутый код впереди своей миграции, самый обыкновенный
   * порядок деплоя, - означал 500 на каждый запрос дашборда вместо трёх пустых разделов на нём.
   *
   * Повтор БЕЗ двух дайджестовых запросов, и только он: если отказало что-то другое, повтор откажет
   * снова и наружу уйдёт ПЕРВАЯ ошибка - та, которая настоящая. То есть лишний круг платится только при
   * отказе, обычный путь остаётся одной транзакцией, и подмена причины невозможна: успех повтора и есть
   * доказательство, что виноваты были именно они. */
  const digestAt = asked.indexOf(behaviourNowQ);
  let answered;
  try {
    answered = await sql.transaction(asked, { readOnly: true });
  } catch (first) {
    const without = asked.filter((q) => q !== behaviourNowQ && q !== behaviourPrevQ);
    try {
      answered = await sql.transaction(without, { readOnly: true });
    } catch (_) {
      /* Не дайджест. Наружу уходит первая ошибка - вторая описывает тот же отказ более узким запросом. */
      throw first;
    }
    /* Пустые строки на их местах, чтобы разбор ниже читал ответ по одной и той же схеме и в обоих
     * случаях: разветвление на два способа разбирать один ответ - это второе место, где можно ошибиться. */
    answered.splice(digestAt, 0, [], []);
    if (!digestProblem) {
      digestProblem = first && first.message
        ? String(first.message).slice(0, 200)
        : 'the behaviour blocks could not be read';
    }
  }

  const [totalsRows, prevRows, flowRows, dayRows, appRows, repeatedRows, slowRows, failureRows, skillRows,
    behaviourRows, prevBehaviourRows, peopleRows = []] = answered;

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

  /* The same counts over the window before, and the fact that there WAS one. A caller cannot tell "no runs
   * last month" from "no previous window measured" out of a zero, and one of those supports a delta while the
   * other does not - so `had` is stated rather than inferred from the counts. */
  const p = prevRows[0] || {};
  const previous = {
    from: prevFromIso,
    to: fromIso,
    had: num(p.runs) > 0,
    runs: num(p.runs),
    ok: num(p.ok),
    failed: num(p.failed),
    stopped: num(p.stopped),
    agentHours: round(num(p.agent_seconds) / 3600, 2),
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
    /* The agent time these runs took. NOT a saving - see the gaps list - and partial when `timed` is less
     * than `times`, which the page has to be able to say. */
    seconds: round(num(r.seconds), 1),
    timed: num(r.timed),
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
    /* Whose it is. Always sent, because in a team scope two people can run skills of the same name and the
     * page has to be able to tell them apart - and in a personal scope it is simply the reader. */
    ownerId: r.owner_id == null ? null : String(r.owner_id),
    name: String(r.name),
    kind: r.kind === 'created' ? 'created' : 'recorded',
    source: r.source === 'desktop' ? 'desktop' : 'web',
    runs: num(r.runs),
    ok: num(r.ok),
    failed: num(r.failed),
    medianSeconds: r.median_seconds == null ? null : round(r.median_seconds, 1),
    lastRunAt: iso(r.last_run_at),
  }));

  /* Stripped off by the handler once it has attached names to it - `gather` has no business reading the
   * auth table, and the transaction it runs is read-only over this schema. */
  const people = peopleRows.map((r) => ({
    id: String(r.id),
    recordings: num(r.recordings),
    createdSkills: num(r.created_skills),
    runs: num(r.runs),
    ok: num(r.ok),
    failed: num(r.failed),
    stopped: num(r.stopped),
    agentHours: round(num(r.agent_seconds) / 3600, 2),
    lastRun: iso(r.last_run),
    lastMade: iso(r.last_made),
  }));

  /* ТРИ БЛОКА ИЗ ОДНОГО СОЮЗА, и разбор здесь, а не в браузере, по тому же правилу, что держит весь этот
   * файл: страница показывает поле, которое ей прислали, и ничего не считает сама.
   *
   * `attention` складывается в измеренное время целиком - каждая миллисекунда паузы попадает ровно в одну
   * из трёх частей, - поэтому доли считаются от их суммы, а не от отдельно взятого итога: расхождение
   * между «суммой частей» и «целым» было бы ровно тем, чего в этом файле быть не должно. */
  const behaviourOf = (rows) => {
    const list = Array.isArray(rows) ? rows : [];
    const of = (kind) => list.filter((r) => r.kind === kind);
    const attentionMs = { active: 0, waiting: 0, away: 0 };
    for (const r of of('attention')) {
      if (r.label in attentionMs) attentionMs[r.label] = num(r.ms);
    }
    const measured = attentionMs.active + attentionMs.waiting + attentionMs.away;
    const attention = {
      measuredSeconds: round(measured / 1000, 1),
      active: { seconds: round(attentionMs.active / 1000, 1), share: share(attentionMs.active, measured) },
      waiting: { seconds: round(attentionMs.waiting / 1000, 1), share: share(attentionMs.waiting, measured) },
      away: { seconds: round(attentionMs.away / 1000, 1), share: share(attentionMs.away, measured) },
      /* Границы названы в ответе, а не только в коде: доля «ожидания» бессмысленна, пока читатель не знает,
       * от какой паузы она считается, и число, чью границу нельзя посмотреть, читается как объективное. */
      activeUnderMs: ACTIVE_MAX_MS,
      awayOverMs: EVENT_GAP_MAX_MS,
    };

    const actionRows = of('action');
    const actionsTotal = actionRows.reduce((was, r) => was + num(r.n), 0);
    const moved = actionRows.find((r) => r.label === 'move');
    const actions = {
      /* Движение отдельно и первым полем, потому что его 86% от всех событий: в одном списке с щелчками
       * оно не сведение, а помеха. */
      moves: num(moved && moved.n),
      total: actionsTotal,
      byKind: actionRows
        .filter((r) => r.label !== 'move')
        .map((r) => ({ kind: r.label, count: num(r.n) }))
        .sort((a, b) => b.count - a.count),
      /* Самые частые действия своими именами - «Key Backspace», «Key Ctrl+V», - потому что род говорит,
       * что человек нажимал клавиши, а имя говорит, какие. */
      top: of('top')
        .map((r) => ({ action: r.label, count: num(r.n) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_ACTIONS),
    };

    /* УЗОР - это последовательность приложений, а не список действий, и он отвечает на один вопрос: один
     * и тот же процесс делался несколько раз? Больше одной записи на узор - кандидат в скилл. */
    const patternRows = of('pattern').map((r) => ({ steps: r.label, recordings: num(r.n) }))
      .sort((a, b) => b.recordings - a.recordings || String(a.steps).localeCompare(String(b.steps)));
    /* Counted BEFORE the cap, and reported separately from `total`.
     *
     * `total` is every distinct pattern and `repeated` is the ones seen more than once - two different
     * lists, and the cap belongs to the second. Sending only `total` as the cap's denominator would have
     * the page print "showing the top 8 of 28 repeated sequences" on an account with eight repeats and
     * twenty singletons: a true number, a false sentence, and no way to tell from the screen.
     *
     * once + repeatedTotal = total, by construction - a pattern is seen once or more than once. */
    const repeatedAll = patternRows.filter((p) => p.recordings > 1);
    const patterns = {
      repeated: repeatedAll.slice(0, PATTERNS_MAX),
      repeatedTotal: repeatedAll.length,
      once: patternRows.filter((p) => p.recordings === 1).length,
      total: patternRows.length,
    };

    return { attention, actions, patterns };
  };

  const behaviourNow = behaviourOf(behaviourRows);
  const prevBehaviour = behaviourOf(prevBehaviourRows);

  return {
    people,
    totals,
    byOutcome,
    byDay,
    applications,
    /* КАК ПРОШЛО ВРЕМЯ, ЧТО ДЕЛАЛОСЬ, ЧТО ПОВТОРЯЛОСЬ - и то же за предыдущий период рядом, потому что
     * «активность 41%» без «было 33%» не отвечает ни на один вопрос, который стоило задавать. */
    attention: behaviourNow.attention,
    actions: behaviourNow.actions,
    patterns: behaviourNow.patterns,
    /* ЧЕМ ЭТИ ТРИ БЛОКА ОБЕСПЕЧЕНЫ, отдельным полем и не в `gaps`.
     *
     * Они читаются из дайджестов, а дайджест записи, сделанной минуту назад, может быть ещё не посчитан.
     * Тогда «делал 45%» - правда о ЧАСТИ записей, и подать её как правду обо всех значило бы то же, что
     * придумать число: страница выглядит одинаково в обоих случаях. `stale` - сколько записей ещё не
     * разобрано, `derived` - сколько этот запрос успел посчитать; ноль в обоих значит, что блок полон. */
    digest: {
      version: DIGEST_VERSION,
      derived,
      stale,
      perRequest: TOP_UP_MAX,
      problem: digestProblem,
    },
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
    previous,
    /* Прошлое окно по тем же трём блокам. `had` у `previous` уже говорит, было ли предыдущее окно вообще -
     * ноль без этого признака нельзя отличить от «не измеряли». */
    previousBehaviour: prevBehaviour,
    repeated,
    slowestSteps,
    failures,
    skills,
    gaps: gapsFor(t, idleSeconds),
    caps: {
      days: DAYS_MAX,
      /* The denominator is the repeated ones, which is the list `shown` came out of. `steps` is here
       * because it is the cap that can MERGE two findings rather than cut one: two long processes that
       * begin with the same eight applications are counted as one pattern, and that is not visible from
       * the rows themselves. */
      patterns: { shown: behaviourNow.patterns.repeated.length, total: behaviourNow.patterns.repeatedTotal,
        limit: PATTERNS_MAX, steps: PATTERN_STEPS },
      actions: { shown: behaviourNow.actions.top.length, limit: TOP_ACTIONS },
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

/* The outer net: anything thrown before or around the handler's own try block. */
export default wrap(handler, 'insights');
