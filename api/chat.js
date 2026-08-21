/* Ask about your own history, answered from your own rows.
 *
 *   POST /api/chat   { question, model?, history? }
 *                 -> { ok, answer, citations, used, usage, provider, model }
 *   GET  /api/chat   what this deployment can serve, and which providers it has a key for
 *
 * The rule that makes this worth trusting: the model EXPLAINS the data, it never recalls it. It has no
 * memory of this account and cannot have one, so it is given read-only tools, this route runs the SQL,
 * and the model writes prose over the rows that came back. Every lookup is listed in `used` and every
 * run those lookups touched is listed in `citations`, so an answer can be checked instead of believed.
 * That is the difference between a grounded answer and a confident one.
 *
 * Scoping is not negotiable and not delegated. Every query filters on the user id whoIsCalling()
 * returned, inside the WHERE clause, and not one tool takes a user id as an argument. A model-supplied
 * user id is the whole bug class here: one hallucinated uuid and this becomes a route that reads
 * somebody else's history. The schemas below say `additionalProperties: false` as a hint to the model,
 * but the real guarantee is that no code path reads an id from a tool input.
 *
 * The transcript is rebuilt from the caller's `history` as TEXT TURNS ONLY - never as tool calls and
 * tool results. A caller that could post tool results could hand the model invented rows and have them
 * answered as though they had come from the database, which is exactly the property this route exists
 * to provide.
 *
 * Both providers, one shape: every model call goes through api/_provider.js, which normalises the
 * conversation and - the part that matters more - normalises how a turn ENDED. A truncated turn and a
 * refusal are not answers, and this route returns an error for both rather than presenting half a
 * sentence as a finding. Both decision loops in this product have already filed a truncated turn as a
 * successful run once; this does not repeat it.
 *
 * PRIVACY, said plainly because it is a fact about the user's data and not a detail.
 *
 * Everything a tool returns is put into a prompt and sent to the model provider - Anthropic or OpenAI,
 * whichever serves the chosen model, named back in `provider`. That includes goals exactly as typed,
 * which routinely carry an email address and the text of a message, and step inputs, which carry
 * whatever was typed into a page. There is no way to answer "what did I do last week" without sending
 * what was done, so this is a property of the feature rather than an oversight in it. What IS held
 * back is the one class where sending it is never needed to answer anything: text shaped like a
 * credential - see redact(). Email addresses are deliberately not masked, because "who did I write
 * to" is a fair question about one's own history and masking would make it unanswerable.
 *
 * WHAT THIS CANNOT ANSWER, and says so rather than estimating:
 *
 *   - Time inside a desktop run. A desktop run's steps carry only the tool and its input; there is no
 *     per-step timing and no window title in them. Only the whole-run duration is known.
 *   - What the model said while running. user_run.said is empty on most rows, and this route never sends
 *     its contents to a model - only whether a row has any. It does NOT claim the column has never been
 *     written: api/insights.js counts it over the same window and found rows that carry commentary, so a
 *     flat "always empty" here would be this route contradicting the dashboard beside it. `summary` is the
 *     only wording about a run that anything here reads.
 *   - Skill-by-skill totals over the whole history. user_run.flow_id was NULL for every historical row
 *     and is only now being written, so anything grouped by skill covers recent runs only.
 *   - Near-duplicate work. find_repeated matches identical goal text; two goals differing by one name
 *     are not clustered, because there is no similarity index here and a LIKE-based guess would be
 *     presented as a finding.
 *
 * It deliberately does not import api/insights.js. Sharing those queries would be tidier, but a static
 * import of a file that may not be on a given deploy takes this route down with it, and this route
 * has to be able to say "I cannot tell from what is stored" rather than 500.
 */

import { neon } from '@neondatabase/serverless';
import { whoIsCalling } from './_session.js';
import { ask, MODELS, DEFAULT_MODEL, PROVIDERS, providerFor, keyFor, ProviderError } from './_provider.js';
import { recordingTools } from './_recording-tools.js';
import { readSettings } from './admin.js';

/* The assistant's model when the caller named none: the admin's choice first, then the provider default -
 * OpenAI when this deployment has that key, Anthropic otherwise. One function, because the GET probe and
 * the POST fallback answered this differently for months and only luck hid it. */
function configuredDefault(settings) {
  const chosen = settings['model.chat_default'];
  if (chosen && providerFor(chosen) && keyFor(providerFor(chosen))) return chosen;
  return keyFor('openai') ? DEFAULT_MODEL.openai : DEFAULT_MODEL.anthropic;
}

/* At most six rounds of lookups per question. Six is enough for "find the runs, open the worst one,
 * check what else that day looked like" and small enough that one question cannot quietly become
 * thirty model calls. On the seventh call no lookup will run whatever the model asks for, so a model
 * still wanting data gets one chance to answer from what it has - and the answer says that is what
 * happened. */
const MAX_ROUNDS = 6;

const QUESTION_MAX = 2000;
const HISTORY_MAX = 16;             // turns kept from the caller's history
const HISTORY_TEXT_MAX = 4000;
const BODY_MAX_BYTES = 120_000;
const ANSWER_TOKENS = 2000;

/* Bounds on what one lookup can put in the prompt. A run's steps array can be hundreds of entries and
 * a transcript that grows without limit costs money and then gets cut off by the provider - which
 * arrives here as `truncated`, i.e. as no answer at all. */
const TOOL_OUTPUT_MAX = 12_000;
const ROWS_MAX = 50;
const STEPS_RETURNED = 60;
const GROUPS_MAX = 30;

/* Per-account rate limit, in the style of api/claude.js and with the same honesty about it: a
 * serverless instance holds its own window, so the real ceiling is this times however many instances
 * are warm. It stops a stuck client and casual abuse, not a determined one.
 *
 * Counted per QUESTION rather than per model call, because one question is up to seven calls plus a
 * handful of queries. Twelve questions in five minutes is a conversation; more than that is a loop. */
const RATE_WINDOW_MS = 300_000;
const RATE_MAX = 12;
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  /* No Allow-Credentials, as everywhere else here: the page is same-origin so CORS does not apply to
   * it, and the extension sends an explicit header. Not setting it is what stops a cross-site page
   * spending someone's session. */
  res.setHeader('Access-Control-Max-Age', '86400');
}

const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'chat_error', message } });

/* A turn that ended without an answer. Separate from ProviderError because nothing went wrong
 * upstream - the model simply did not produce something showable, and showing it anyway is the
 * failure mode this route is built to avoid. */
class NotAnAnswer extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'NotAnAnswer';
    this.status = status;
  }
}

/* ------------------------------------------------------------------------- small helpers */

const text = (value, max) => (value == null ? null : String(value).slice(0, max));

const clamp = (value, lo, hi, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), lo), hi) : fallback;
};

/* Counts and sums come back from the driver as STRINGS - Postgres bigint and numeric have no safe
 * JavaScript number, so pg's default parsers hand back text. Coerced at the edge, because "3" + 1 is
 * "31" and that arithmetic would end up in an answer looking like a fact.
 *
 * SQL NULL stays null and is not coerced. Got wrong once: Number(null) is 0, so a `sum(...)` over a
 * window where nothing was timable came back as `seconds: 0`, and a `jsonb_array_length` that was
 * deliberately left null for a payload with no events came back as `events: 0`. Both read as measured
 * zeroes. "Not measured" and "measured, and it was none" are different answers and this cannot be the
 * place they get confused. */
const int = (value) => {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
};

const asList = (value) => (Array.isArray(value) ? value.filter(Boolean).map(String) : []);

const hostOf = (url) => {
  if (!url) return null;
  try { return new URL(String(url)).host; } catch (_) { return null; }
};

/** Seconds a run took, or null when it cannot be known.
 *
 * The same guard as hoursOf() in web/src/lib/api.ts, and repeated in SQL in the aggregates below: a
 * negative or twelve-hour-plus span means two machines' clocks disagreed, and a run that is still
 * `running` has no finish at all. Both come back as null rather than as a number, because a fictional
 * duration is worse than a gap the answer can name. */
function secondsOf(started, finished) {
  if (!started || !finished) return null;
  const ms = +new Date(finished) - +new Date(started);
  if (!(ms > 0) || ms >= 12 * 3600 * 1000) return null;
  return Math.round(ms / 1000);
}

/* Credential-shaped text, held back before anything is sent to the provider.
 *
 * A goal is typed prose - "sign in as me, password hunter2, then export the report" is a realistic
 * one - and no question about one's own history needs the password to be answered. This is a filter on
 * the obvious shapes, not a guarantee: it cannot recognise a secret that looks like an ordinary word.
 * Said here so nobody reads it as one.
 *
 * The unquoted value class excludes quotes, commas and semicolons rather than being "any non-space".
 * That is not tidiness: the first version of this ran over the ENCODED result and `\S{3,80}` walked
 * straight past the closing quote of the goal, eating the model, outcome and step count that came
 * after it. The model was handed a truncated row and had no way to know. Hence both halves of the fix -
 * a bounded value class, and redactDeep below applying it to values instead of to JSON. */
const SECRETY = /\b(password|passwd|pwd|passcode|secret|api[-_ ]?key|token|otp|2fa|cvv|pin)\b\s*(?:is|=|:)?\s*("[^"]{3,80}"|'[^']{3,80}'|[^\s"',;]{3,80})/gi;

function redact(value) {
  return String(value).replace(SECRETY, (whole, label) => {
    /* What this actually does, said accurately because the first version of this comment claimed the
     * opposite: the word AFTER the keyword is masked whenever there is one, so "password reset page"
     * becomes "password: [redacted] page". A mangled description, not a kept secret - and that is the
     * direction chosen on purpose, since the alternative is telling a real password from an English
     * word, which nothing here can do. A keyword with nothing after it ("my password.") is left alone,
     * because the value class needs three characters; so is a punctuation-only tail, which is what the
     * check below is for. A value one filler word away ("pin to 4821") is missed entirely - the header's
     * "not a guarantee" is meant literally. */
    const tail = whole.slice(label.length);
    if (!/[A-Za-z0-9]/.test(tail)) return whole;
    return label + ': [redacted]';
  });
}

/** redact() over every string in a result, leaving the structure alone. */
function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  /* A timestamp arrives as a Date, not a string: the driver parses timestamptz through pg's type
   * parsers before this sees it. Got wrong first time round - Object.entries(new Date()) is EMPTY, so
   * walking a Date as a plain object turned every startedAt, finishedAt, firstAt and lastAt into `{}`
   * and handed the model rows with no dates in them, in a feature whose commonest question is "what did
   * I do last week". Encoded here exactly as JSON.stringify would have done on the way out. */
  if (value instanceof Date) return Number.isFinite(+value) ? value.toISOString() : null;
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = redactDeep(inner);
    return out;
  }
  // Keys are this file's own fixed names, so only values are walked.
  return value;
}

/** A step's input, flattened to something readable and short. */
function describeInput(input) {
  if (input == null) return null;
  if (typeof input !== 'object') return text(input, 200);
  const parts = [];
  for (const [key, value] of Object.entries(input)) {
    if (value == null || value === '') continue;
    const shown = typeof value === 'object' ? JSON.stringify(value) : String(value);
    parts.push(key + '=' + shown.slice(0, 120));
    if (parts.length >= 6) break;
  }
  return parts.length ? parts.join(' ') : null;
}

/* ----------------------------------------------------------------------------- the tools */

/* All five are read-only, all five filter on the caller's user id, and none of them takes one.
 *
 * Each returns { data, runIds }: `data` is what the model gets to read, `runIds` are the run ids it
 * touched, collected into `citations` so the answer can be traced back to rows. The ids are the
 * client's own run ids - the same `Run.id` the app already holds in memory from /api/sync - so the
 * view can resolve one to a name without another round trip.
 *
 * The window is always `coalesce(started_at, synced_at)`. started_at can be null: a client may sync a
 * run without one, and filtering on started_at alone silently drops those rows from every count.
 * synced_at is never null, so it stands in - later than the truth, but present. */

const TOOLS = {
  search_runs: {
    description:
      'Find runs of this account, newest first. Use it to locate the runs a question is about before '
      + 'saying anything about them. Returns each run id, its goal, model, outcome, measured duration '
      + 'and step count. A replay has no goal - it repeats a recording.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days: { type: 'integer', description: 'How far back to look, in days. Default 30, max 365.' },
        outcome: { type: 'string', enum: ['ok', 'failed', 'stopped', 'running'], description: 'Only runs that ended this way.' },
        flowId: { type: 'string', description: 'Only runs of one skill, by the skill id list_skills returned.' },
        contains: { type: 'string', description: 'Case-insensitive text to look for in the goal, the summary or the error.' },
        limit: { type: 'integer', description: 'How many runs to return. Default 20, max 50.' },
      },
    },
    async run(input, { sql, userId }) {
      const days = clamp(input.days, 1, 365, 30);
      const limit = clamp(input.limit, 1, ROWS_MAX, 20);
      const outcome = ['ok', 'failed', 'stopped', 'running'].includes(input.outcome) ? input.outcome : null;
      const flowId = text(input.flowId, 80) || null;
      const contains = text(input.contains, 200) || null;

      /* Optional filters as "the parameter is null, or it matches", rather than by concatenating
       * predicates. The neon template tag parameterises every interpolation and cannot compose
       * fragments, and building SQL by hand to get around that is how a text search becomes an
       * injection. */
      const rows = await sql`
        select client_id, kind, goal, model, flow_id, outcome, summary, error,
               started_at, finished_at, extension,
               case when jsonb_typeof(steps) = 'array' then jsonb_array_length(steps) else 0 end as step_count
        from user_run
        where user_id = ${userId}
          and coalesce(started_at, synced_at) > now() - make_interval(days => ${days}::int)
          and (${outcome}::text is null or outcome = ${outcome}::text)
          and (${flowId}::text is null or flow_id = ${flowId}::text)
          and (${contains}::text is null or (
                coalesce(goal, '')    ilike '%' || ${contains}::text || '%'
             or coalesce(summary, '') ilike '%' || ${contains}::text || '%'
             or coalesce(error, '')   ilike '%' || ${contains}::text || '%'))
        order by coalesce(started_at, synced_at) desc
        limit ${limit}::int
      `;

      const runs = rows.map((r) => ({
        id: r.client_id,
        kind: r.kind,
        goal: r.goal,
        model: r.model,
        skillId: r.flow_id,
        outcome: r.outcome,
        summary: r.summary,
        error: r.error,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        seconds: secondsOf(r.started_at, r.finished_at),
        steps: int(r.step_count),
      }));

      return {
        data: {
          window: 'the last ' + days + ' days',
          found: runs.length,
          more: runs.length === limit
            ? 'this is the limit, so there may be more - narrow the window or raise limit'
            : 'this is all of them within the window',
          runs,
        },
        runIds: runs.map((r) => r.id),
      };
    },
  },

  get_run: {
    description:
      'Everything stored about one run, including its step trace. Use it before describing what a run '
      + 'actually did. A browser run\'s steps carry per-step timing and the page they acted on; a '
      + 'desktop run\'s steps carry only the tool and its input, so there is no timing inside one.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        runId: { type: 'string', description: 'The run id search_runs returned.' },
      },
      required: ['runId'],
    },
    async run(input, { sql, userId }) {
      const runId = text(input.runId, 80);
      if (!runId) {
        return { data: { error: 'runId is required - use an id search_runs returned.' }, runIds: [] };
      }

      const rows = await sql`
        select client_id, kind, goal, model, flow_id, outcome, summary, error, steps,
               extension, started_at, finished_at, synced_at,
               case when jsonb_typeof(said) = 'array' then jsonb_array_length(said) else 0 end as said_count
        from user_run
        where user_id = ${userId} and client_id = ${runId}
        limit 1
      `;
      if (!rows.length) {
        return {
          data: { found: false, note: 'no run with that id on this account - say so rather than guessing what it was' },
          runIds: [],
        };
      }

      const row = rows[0];
      const all = Array.isArray(row.steps) ? row.steps : [];
      /* Long traces are cut from the MIDDLE. The first steps say how a run started and the last say
       * how it ended or failed; the hundred in between are usually the same three tools repeating. */
      const kept = all.length <= STEPS_RETURNED
        ? all
        : [...all.slice(0, STEPS_RETURNED / 2), ...all.slice(-STEPS_RETURNED / 2)];

      const steps = kept.map((s, i) => ({
        n: int(s && s.n) ?? i + 1,
        at: (s && s.at) || null,
        /* Some builds wrote `name` where later ones write `tool`. Both are read, because a trace from
         * an older extension is still a trace and rendering it as "undefined" would look like a bug
         * in the run rather than in this reader. */
        tool: (s && (s.tool || s.name)) || null,
        ok: s && typeof s.ok === 'boolean' ? s.ok : null,
        ms: s && Number.isFinite(Number(s.ms)) ? Number(s.ms) : null,
        on: hostOf(s && s.url),
        wentTo: hostOf(s && s.wentTo),
        input: describeInput(s && s.input),
        /* A step's result is not always a string. extension/background.js stores what summariseResult()
         * returned, and that is an OBJECT for read_page and for any tool whose result carried the page
         * back - which is most successful browser steps. String() on one of those is "[object Object]":
         * a field the model can read and learn nothing from, on the majority of the trace. Encoded
         * instead, so what the step actually reported survives the trip. */
        result: s && s.result != null
          ? text(typeof s.result === 'object' ? JSON.stringify(s.result) : s.result, 200)
          : null,
        error: text(s && s.error, 200),
      }));

      const timed = steps.filter((s) => s.ms != null);

      return {
        data: {
          run: {
            id: row.client_id,
            kind: row.kind,
            goal: row.goal,
            model: row.model,
            skillId: row.flow_id,
            outcome: row.outcome,
            summary: row.summary,
            error: row.error,
            extension: row.extension,
            startedAt: row.started_at,
            finishedAt: row.finished_at,
            seconds: secondsOf(row.started_at, row.finished_at),
          },
          stepCount: all.length,
          stepsShown: steps.length,
          stepsCutFromMiddle: all.length > steps.length,
          stepTimingAvailable: timed.length > 0,
          msInSteps: timed.length ? timed.reduce((sum, s) => sum + s.ms, 0) : null,
          steps,
          /* Kept in the output on purpose: a model not told what it cannot see will invent the commentary
           * it expected to find. The count is reported and the contents are not - `said` is not even
           * selected above - so both branches say the same thing about what is READABLE, which is nothing.
           * The empty branch does not claim the column has never been written: api/insights.js counts
           * non-empty ones over the same window, and two halves of one product must not disagree about a
           * fact as checkable as that. */
          commentary: int(row.said_count)
            ? 'this run has ' + int(row.said_count) + ' stored commentary entries and none of them are included here, so do not quote or characterise them - the summary is the only wording you have'
            : 'nothing is stored in user_run.said for this run. Some builds never wrote that column, so an empty one is not evidence that the run said nothing - the summary is the only wording you have',
          timingNote: timed.length
            ? 'ms is per step and covers the step only, not the model deciding between steps, so the step total is less than the run duration'
            : 'this run has no per-step timing - desktop runs record only the tool and its input, so only the whole-run duration is known',
        },
        runIds: [row.client_id],
      };
    },
  },

  summarize_time: {
    description:
      'Where measured time went, grouped by day, by application, or by skill. Day and skill measure '
      + 'whole runs from start to finish. Application is derived from the pages browser steps acted '
      + 'on and can only cover runs whose steps carry a url, which desktop runs do not.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days: { type: 'integer', description: 'How far back to look, in days. Default 30, max 365.' },
        groupBy: { type: 'string', enum: ['day', 'application', 'skill'], description: 'How to group it.' },
      },
      required: ['groupBy'],
    },
    async run(input, { sql, userId }) {
      const days = clamp(input.days, 1, 365, 30);
      const groupBy = ['day', 'application', 'skill'].includes(input.groupBy) ? input.groupBy : 'day';

      if (groupBy === 'day') {
        /* The twelve-hour guard is the SQL half of secondsOf(). It has to be repeated rather than
         * shared, because the neon tag cannot compose fragments - if one is ever changed, change
         * both, or the totals and the per-run durations will disagree. */
        const rows = await sql`
          select to_char(date_trunc('day', coalesce(started_at, synced_at)), 'YYYY-MM-DD') as day,
                 count(*) as runs,
                 count(*) filter (where outcome = 'ok') as ok,
                 count(*) filter (where outcome = 'failed') as failed,
                 count(*) filter (where started_at is null or finished_at is null) as untimed,
                 sum(case when started_at is not null and finished_at > started_at
                            and finished_at - started_at < interval '12 hours'
                          then extract(epoch from (finished_at - started_at)) end) as seconds,
                 (array_agg(client_id order by coalesce(started_at, synced_at) desc))[1:5] as examples
          from user_run
          where user_id = ${userId}
            and coalesce(started_at, synced_at) > now() - make_interval(days => ${days}::int)
          group by 1
          order by 1 desc
          limit 366
        `;
        const byDay = rows.map((r) => ({
          day: r.day,
          runs: int(r.runs),
          ok: int(r.ok),
          failed: int(r.failed),
          untimed: int(r.untimed),
          seconds: int(r.seconds),
          exampleRunIds: asList(r.examples),
        }));
        return {
          data: {
            groupBy: 'day',
            window: 'the last ' + days + ' days',
            days: byDay,
            note: 'seconds is measured start to finish. `untimed` runs are missing a start or a finish - '
              + 'usually still running - and contribute nothing to seconds; do not average them in. Days '
              + 'with no runs are absent rather than zero.',
          },
          runIds: byDay.flatMap((d) => d.exampleRunIds),
        };
      }

      if (groupBy === 'skill') {
        const rows = await sql`
          select r.flow_id,
                 f.name as skill_name, f.kind as skill_kind, f.source as skill_source,
                 count(*) as runs,
                 count(*) filter (where r.outcome = 'ok') as ok,
                 count(*) filter (where r.outcome = 'failed') as failed,
                 sum(case when r.started_at is not null and r.finished_at > r.started_at
                            and r.finished_at - r.started_at < interval '12 hours'
                          then extract(epoch from (r.finished_at - r.started_at)) end) as seconds,
                 (array_agg(r.client_id order by coalesce(r.started_at, r.synced_at) desc))[1:5] as examples
          from user_run r
          left join user_flow f on f.user_id = r.user_id and f.client_id = r.flow_id
          where r.user_id = ${userId}
            and coalesce(r.started_at, r.synced_at) > now() - make_interval(days => ${days}::int)
          group by r.flow_id, f.name, f.kind, f.source
          order by count(*) desc
          limit ${GROUPS_MAX}
        `;
        const skills = rows.map((r) => ({
          skillId: r.flow_id,
          /* Three different things, and they must not share one label. A deleted flow is TOMBSTONED
           * rather than removed - see deleted_at in db/002_user_data.sql - so it still joins and still
           * has its name, which is right: the run did happen. An empty join means the run points at a
           * flow this account never synced. And `name` is `not null default ''`, so a present but
           * unnamed flow arrives as an empty string, which the first version of this handed to the model
           * as "no longer on the account" - a statement about the account that was simply untrue. */
          skill: r.flow_id
            ? (r.skill_name == null ? '(a skill this account has not synced)' : (r.skill_name || '(unnamed)'))
            : null,
          kind: r.skill_kind || null,
          source: r.skill_source || null,
          runs: int(r.runs),
          ok: int(r.ok),
          failed: int(r.failed),
          seconds: int(r.seconds),
          exampleRunIds: asList(r.examples),
        }));
        const unlinked = skills.find((s) => !s.skillId);
        return {
          data: {
            groupBy: 'skill',
            window: 'the last ' + days + ' days',
            skills,
            unattributed: unlinked ? unlinked.runs : 0,
            note: 'a run is only linked to a skill if it recorded a flow id. Every historical row had none, '
              + 'and it is only now being written, so the row with skillId null is not "ad-hoc work" - it is '
              + 'mostly older runs whose skill is simply not recorded. Say that rather than reporting it as a '
              + 'category.',
          },
          runIds: skills.flatMap((s) => s.exampleRunIds),
        };
      }

      /* By application, which means: by the host a browser step ACTED ON.
       *
       * `url` first and `wentTo` only as a fallback, which is the rule api/insights.js applies and for its
       * reason: wentTo is where a click landed you, so it is the NEXT step's page. Preferring it files this
       * step's milliseconds under the page it navigated to, and the dashboard and this chat then name
       * different applications for the same run, both looking authoritative. Got that way round first.
       *
       * This is the one grouping that is NOT a whole-run measure. It sums per-step ms, which exists
       * only on extension runs. Everything between steps - the model deciding what to do next, which is
       * most of a slow run - belongs to no host and is not counted anywhere. The note says so, because a
       * total that silently excludes the majority of a run's wall clock would be read as one that does not.
       *
       * The type is checked before the cast rather than after: a single step written by some other build
       * with a non-numeric ms would fail the whole query, and a chat that cannot answer is worse than one
       * that reports the steps it could time. jsonb_typeof rather than a `^[0-9]+$` match on the text,
       * which was the earlier guard here and quietly dropped a fractional ms - api/insights.js counts
       * those, so the two routes reported different seconds for the same steps. */
      const rows = await sql`
        select substring(coalesce(s->>'url', s->>'wentTo') from '^[a-z]+://([^/]+)') as host,
               count(*) as steps,
               count(*) filter (where jsonb_typeof(s->'ms') = 'number') as timed_steps,
               sum(case when jsonb_typeof(s->'ms') = 'number' then greatest(0, (s->>'ms')::numeric) end) as ms,
               count(distinct r.client_id) as runs,
               (array_agg(distinct r.client_id))[1:5] as examples
        from user_run r
          /* The type check is INSIDE the argument, not in the WHERE clause. A predicate is applied
           * after the FROM list, so a single row whose steps is an object rather than an array would
           * make jsonb_array_elements throw before the filter ever ran, and one malformed row would
           * take out the whole breakdown. A run with no usable steps simply contributes no rows. */
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(r.steps) = 'array' then r.steps else '[]'::jsonb end) s
        where r.user_id = ${userId}
          and coalesce(r.started_at, r.synced_at) > now() - make_interval(days => ${days}::int)
        group by 1
        order by ms desc nulls last, steps desc
        limit ${GROUPS_MAX}
      `;

      const applications = rows
        .filter((r) => r.host)
        .map((r) => ({
          application: r.host,
          steps: int(r.steps),
          timedSteps: int(r.timed_steps),
          seconds: r.ms == null ? null : Math.round(Number(r.ms) / 1000),
          runs: int(r.runs),
          exampleRunIds: asList(r.examples),
        }));
      const noHost = rows.find((r) => !r.host);

      return {
        data: {
          groupBy: 'application',
          window: 'the last ' + days + ' days',
          applications,
          stepsWithNoApplication: noHost ? int(noHost.steps) : 0,
          runsWithNoApplication: noHost ? int(noHost.runs) : 0,
          note: 'an application here is the host of the page a step acted on. Time is the sum of per-step '
            + 'ms, so it counts the steps only - not the model thinking between them - and it is always '
            + 'less, often much less, than the run durations from groupBy day. Steps with no application '
            + 'are desktop steps: they record the tool and its input and neither a page nor a duration, so '
            + 'desktop work cannot be broken down by application at all.',
        },
        runIds: applications.flatMap((a) => a.exampleRunIds),
      };
    },
  },

  list_skills: {
    description:
      'Everything the user has made, newest first - recordings AND skills, because both are rows of the '
      + 'same table and only `kind` separates them: `recorded` is a captured recording, `created` is a '
      + 'skill written as a goal. Filter by kind when the question names one, and say which you counted - '
      + '"you have 2 recordings" and "you have 2 skills" are different answers and this tool can give '
      + 'either. `source` is web for the extension, desktop for the local agent, and each half can only '
      + 'replay its own.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['recorded', 'created'], description: 'Only one kind.' },
        limit: { type: 'integer', description: 'How many to return. Default 30, max 50.' },
      },
    },
    async run(input, { sql, userId }) {
      const kind = ['recorded', 'created'].includes(input.kind) ? input.kind : null;
      const limit = clamp(input.limit, 1, ROWS_MAX, 30);

      /* jsonb_array_length only after checking the type. A payload whose `events` is an object rather
       * than an array is old or hand-edited, and an error from one row would take out the list. */
      const rows = await sql`
        select client_id, source, kind, name, description, origins, created_at, updated_at,
               case when jsonb_typeof(payload->'events') = 'array'
                    then jsonb_array_length(payload->'events') end as events,
               case when jsonb_typeof(payload->'windows') = 'array'
                    then jsonb_array_length(payload->'windows') end as windows
        from user_flow
        where user_id = ${userId}
          and deleted_at is null
          and (${kind}::text is null or kind = ${kind}::text)
        order by updated_at desc
        limit ${limit}::int
      `;

      return {
        data: {
          skills: rows.map((r) => ({
            id: r.client_id,
            name: r.name || '(unnamed)',
            description: r.description || null,
            kind: r.kind,
            source: r.source,
            events: int(r.events),
            windows: int(r.windows),
            origins: asList(r.origins),
            created: r.created_at,
            updated: r.updated_at,
          })),
          note: 'deleted skills are excluded. `events` is how many recorded steps a recording holds - it is '
            + 'a size, not a duration: an event carries only the delay since the one before it, so a '
            + 'recording\'s length could be reconstructed but nothing here has done that.',
        },
        // Skills have their own ids, and citations are runs; nothing to cite from this one.
        runIds: [],
      };
    },
  },

  find_repeated: {
    description:
      'Work that came round more than once: identical goals typed again, and skills run again. Use it '
      + 'for "what should I automate" and "what am I repeating". It matches exact goal text only.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        days: { type: 'integer', description: 'How far back to look, in days. Default 90, max 365.' },
      },
    },
    async run(input, { sql, userId }) {
      const days = clamp(input.days, 1, 365, 90);

      /* Grouped on the goal with whitespace collapsed and case dropped, which catches "the same thing
       * typed again" and nothing cleverer. POSIX [[:space:]] rather than \s deliberately: this pattern
       * is a JavaScript string literal first, where a backslash-s is just an s - a regex that would
       * quietly match the letter instead of whitespace. */
      const goals = await sql`
        select lower(regexp_replace(btrim(goal), '[[:space:]]+', ' ', 'g')) as normalised,
               count(*) as times,
               count(*) filter (where outcome = 'ok') as ok,
               count(*) filter (where outcome = 'failed') as failed,
               min(coalesce(started_at, synced_at)) as first_at,
               max(coalesce(started_at, synced_at)) as last_at,
               sum(case when started_at is not null and finished_at > started_at
                          and finished_at - started_at < interval '12 hours'
                        then extract(epoch from (finished_at - started_at)) end) as seconds,
               (array_agg(client_id order by coalesce(started_at, synced_at) desc))[1:5] as examples
        from user_run
        where user_id = ${userId}
          and goal is not null and btrim(goal) <> ''
          and coalesce(started_at, synced_at) > now() - make_interval(days => ${days}::int)
        group by 1
        having count(*) > 1
        order by count(*) desc
        limit 20
      `;

      /* Skills, separately, and not folded into the numbers above. A replay has no goal because it
       * repeats a recording, so counting replays as "repeated work" would be circular - of course they
       * repeat, that is what they are. What is worth knowing is which skill is carrying the load. */
      const skills = await sql`
        select r.flow_id, f.name as skill_name, f.source as skill_source,
               count(*) as times,
               count(*) filter (where r.outcome = 'ok') as ok,
               max(coalesce(r.started_at, r.synced_at)) as last_at,
               sum(case when r.started_at is not null and r.finished_at > r.started_at
                          and r.finished_at - r.started_at < interval '12 hours'
                        then extract(epoch from (r.finished_at - r.started_at)) end) as seconds,
               (array_agg(r.client_id order by coalesce(r.started_at, r.synced_at) desc))[1:5] as examples
        from user_run r
          left join user_flow f on f.user_id = r.user_id and f.client_id = r.flow_id
        where r.user_id = ${userId}
          and r.flow_id is not null
          and coalesce(r.started_at, r.synced_at) > now() - make_interval(days => ${days}::int)
        group by r.flow_id, f.name, f.source
        having count(*) > 1
        order by count(*) desc
        limit 20
      `;

      const repeatedGoals = goals.map((r) => ({
        goal: r.normalised,
        times: int(r.times),
        ok: int(r.ok),
        failed: int(r.failed),
        firstAt: r.first_at,
        lastAt: r.last_at,
        seconds: int(r.seconds),
        exampleRunIds: asList(r.examples),
      }));
      const repeatedSkills = skills.map((r) => ({
        skillId: r.flow_id,
        // The same three cases as summarize_time by skill, labelled the same way and for the same reason.
        skill: r.skill_name == null ? '(a skill this account has not synced)' : (r.skill_name || '(unnamed)'),
        source: r.skill_source || null,
        times: int(r.times),
        ok: int(r.ok),
        lastAt: r.last_at,
        seconds: int(r.seconds),
        exampleRunIds: asList(r.examples),
      }));

      return {
        data: {
          window: 'the last ' + days + ' days',
          repeatedGoals,
          repeatedSkills,
          note: 'goals are grouped on exact text, case and spacing aside. Two goals that differ by one name '
            + 'or one address are NOT grouped, because there is no similarity index here and guessing which '
            + 'ones are "really the same" would be presenting an assumption as a finding. So this is a floor '
            + 'on repeated work, never a complete picture - say so if the answer leans on it. Repeated skills '
            + 'only cover runs that recorded a flow id, which older runs did not. The Insights page counts '
            + 'the same thing more loosely - it replaces addresses, urls and quoted phrases before grouping - '
            + 'so its "worth automating" list can show a higher count than this for the same work. That is '
            + 'the two measures differing, not either being wrong; if the person quotes a number from that '
            + 'page, do not contradict it.',
        },
        runIds: [
          ...repeatedGoals.flatMap((g) => g.exampleRunIds),
          ...repeatedSkills.flatMap((s) => s.exampleRunIds),
        ],
      };
    },
  },
};

/* The lookups above are the same for everybody, so they live at module scope. The recording tools are not:
 * recordingTools() takes the caller's own sql and user id and closes over them, and throws if either is
 * missing - a tool bound to nobody cannot be called by accident, which is a better guarantee than passing an
 * id in on every call and hoping. So the table is assembled per request.
 *
 * Names and specs are derived from the ASSEMBLED table, not from the static half. Deriving them from the
 * static half is exactly how a tool gets registered and then never offered to the model. */
function toolsFor(ctx) {
  const table = { ...TOOLS };
  for (const tool of recordingTools({ sql: ctx.sql, userId: ctx.userId })) {
    table[tool.name] = tool;
  }
  return table;
}

const spec = (table) => Object.keys(table).map((name) => ({
  name,
  description: table[name].description,
  schema: table[name].schema,
}));

/* What the GET probe reports it can do. The static half only - listing the rest would need a caller, and the
 * probe deliberately has none. The note says so rather than implying this is everything. */
const TOOL_NAMES = Object.keys(TOOLS);

/* --------------------------------------------------------------------------- the prompt */

function systemPrompt(today) {
  return [
    'You answer questions about ONE person\'s own MouseFlow history: the recordings they captured, the',
    'skills they built, and the runs of both. You are not a general assistant in this conversation.',
    '',
    'How to answer:',
    '- Look it up first. Every number, date, name, id and outcome you state must have come from a tool',
    '  result in this conversation. If you did not read it from a tool, you do not know it.',
    '- Never estimate, never round a figure you did not count, never fill a gap with something',
    '  plausible. If the tools cannot answer, say exactly: "I cannot tell from what is stored." Then say',
    '  what would have to be recorded for it to be answerable.',
    '- Cite the runs a claim rests on by their id, in square brackets, like [run-4f21a]. Cite the ones',
    '  that carry the point, not everything you read.',
    '- Today is ' + today + '. Read "this week", "yesterday" and "last month" against that date.',
    '- Lead with the answer. Be short. No preamble, no restating the question, no closing offer of help.',
    '- Plain text only. No markdown: no **bold**, no #headings, no bullet characters, no tables. Nothing',
    '  renders it where your answer is displayed, so a ** arrives as two asterisks around a number.',
    '',
    'What the stored data does and does not hold. Do not paper over any of these:',
    '- A run has a start and a finish, so its duration is measured, not guessed. A run still marked',
    '  running has no finish and therefore no duration.',
    '- Steps from a browser run carry per-step timing and the page they acted on. Steps from a desktop',
    '  run carry only the tool and its input: no timing, no window, no page. "Where did the time go',
    '  inside this desktop run" has no answer here.',
    '- Per-step time never adds up to the run duration. The gaps are the model deciding what to do',
    '  next, and they belong to no application.',
    '- A run\'s running commentary is not readable here: it is never handed to you, even for a row',
    '  that stores some. The summary is the only wording you have. So say the commentary is not',
    '  available - never that the run said nothing, which is a claim about the run and not about what',
    '  you can see.',
    '- A run is linked to the skill it ran only if it recorded a skill id. Older runs did not, so',
    '  anything grouped by skill covers recent runs only. Say so when it changes the answer.',
    '- A replay has no goal - it repeats a recording. Only agent runs carry a typed goal.',
    '- find_repeated matches identical goal text. It is a floor on repeated work, not a survey of it.',
    '',
    'If a question is not about this account\'s history, say that is not what you can see here, and stop.',
  ].join('\n');
}

/* The seventh call. The model has spent its lookups and still wants more, so it is asked to answer with
 * what it has - and told to say that is what it is doing, because an answer built on a search that
 * stopped early and presents itself as complete is the same failure as an invented number. */
const CEILING_NOTE = [
  '',
  'You have used every lookup available for this question and no more tools will run. Answer from what',
  'you already have. Open by saying you ran out of lookups, then give the partial answer, then name the',
  'one thing you would have checked next. Do not fill the gap with anything you did not read.',
  'The tools are still listed, because the conversation cannot be sent without them, but none of them',
  'will run on this turn - do not call one. A call made now is discarded, and a turn spent calling',
  'rather than writing leaves the question with no answer at all.',
].join('\n');

/* ------------------------------------------------------------------------------ the loop */

async function answerQuestion({ sql, userId, model, question, history }) {
  /* The table is built here, once, and travels in the context - so the tools the model is OFFERED and the
   * tools that can be RUN are the same object. Two lists derived separately is how a model comes to call
   * something that no longer exists. */
  const tools = toolsFor({ sql, userId });
  const ctx = { sql, userId, tools, specs: spec(tools) };
  const system = systemPrompt(new Date().toISOString().slice(0, 10));
  const messages = buildTranscript(history, question);

  const used = [];
  const cited = new Set();
  const usage = { input: 0, output: 0, rounds: 0, tools: 0 };
  let hitCeiling = false;
  let answer = '';

  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const outOfRounds = round === MAX_ROUNDS;

    const reply = await ask({
      model,
      system: outOfRounds ? system + '\n' + CEILING_NOTE : system,
      messages,
      /* The tools stay DECLARED on the last call even though none of them will run. Getting this wrong
       * is a known trap in this codebase - see the seam between waves in web/src/lib/desktop-engine.ts:
       * a request whose history contains tool_use blocks and no tool definitions is rejected, and by the
       * time this route reaches the last round the history always contains them, since every earlier
       * round asked for a lookup. Sending [] here would have turned the one path that exists to answer
       * honestly at the ceiling into a 400 from the provider, every time.
       *
       * The loop still cannot be extended by asking again: `outOfRounds` is what decides whether calls
       * are run, not whether they were offered, and any call made on this turn is discarded. */
      tools: ctx.specs,
      maxTokens: ANSWER_TOKENS,
    });

    usage.rounds += 1;
    usage.input += reply.usage.input;
    usage.output += reply.usage.output;

    /* Neither of these is an answer, and both have been shown as one before. Truncated means the
     * sentence stops mid-air; refused means the model declined. Returning either as `answer` would put
     * an unfinished or absent finding in front of someone who asked a factual question. */
    if (reply.stopReason === 'truncated') {
      throw new NotAnAnswer(
        'the model ran out of room before finishing the answer, so there is nothing complete to show. '
        + 'Ask something narrower, or over a shorter window.', 502);
    }
    if (reply.stopReason === 'refused') {
      throw new NotAnAnswer('the model declined to answer that one. Nothing was made up in its place.', 502);
    }

    if (!outOfRounds && reply.calls.length) {
      // The assistant turn goes back verbatim, calls included, or the results have nothing to attach to.
      messages.push({ role: 'assistant', text: reply.text, calls: reply.calls });
      const results = [];
      for (const call of reply.calls) {
        results.push(await runOneTool(call, ctx, used, cited));
        usage.tools += 1;
      }
      /* All of a turn's results in ONE user message - see the note in api/_provider.js. Splitting them
       * teaches the model to stop asking for things in parallel. */
      messages.push({ role: 'user', results });
      continue;
    }

    answer = reply.text;
    hitCeiling = outOfRounds;
    break;
  }

  if (!answer) {
    /* Two ways to arrive here, and they are not the same fault. At the ceiling the tools are still
     * declared - they have to be, see the call above - so a model can spend its last turn asking for a
     * lookup that will never run, and that is worth saying plainly rather than reporting as silence. */
    throw new NotAnAnswer(hitCeiling
      ? 'the model spent its last turn asking for another lookup, and there were none left, so it never '
        + 'wrote an answer. Ask something narrower, or over a shorter window.'
      : 'the model came back with nothing at all - no answer and no reason.', 502);
  }
  if (hitCeiling) {
    /* Said by this route as well as asked of the model, because the instruction is a request and this
     * is a fact: the lookups ran out, and the reader is entitled to know it before the first sentence. */
    answer = 'I ran out of lookups for this question (' + MAX_ROUNDS + ' is the limit), so this rests on '
      + 'what I had found by then.\n\n' + answer;
  }

  return {
    answer,
    /* Every run the lookups touched, not only the ones the prose cites. Deliberately a superset: the
     * model is asked to cite in words, and this is the list the view can resolve against the runs it
     * already holds from /api/sync, so an answer can be opened and checked. */
    citations: Array.from(cited).slice(0, 60),
    used,
    usage,
  };
}

/** History, rebuilt as text turns, plus the new question as the last one. */
function buildTranscript(history, question) {
  const turns = [];
  for (const turn of history) {
    const role = turn && turn.role === 'assistant' ? 'assistant' : 'user';
    const body = text(turn && turn.text, HISTORY_TEXT_MAX);
    if (!body || !body.trim()) continue;
    turns.push({ role, text: body.trim() });
  }
  turns.push({ role: 'user', text: question });

  /* A transcript must open with a user turn, and consecutive turns of one role are a provider-side
   * 400 on at least one of the two paths. A client that replays its own view of the conversation will
   * hand over both - a history starting with a greeting from the assistant, or the last question still
   * unanswered - so both are fixed here rather than blamed on the caller. */
  while (turns.length && turns[0].role === 'assistant') turns.shift();

  const merged = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) last.text += '\n\n' + turn.text;
    else merged.push({ ...turn });
  }
  return merged;
}

/** One tool call: run it, record it, and hand the model back something it can read. */
async function runOneTool(call, ctx, used, cited) {
  const table = ctx.tools || TOOLS;
  const tool = table[call.name];
  if (!tool) {
    used.push({ tool: String(call.name), input: call.input || {}, ok: false, note: 'no such tool' });
    return {
      id: call.id,
      output: 'There is no tool called ' + String(call.name) + '. The ones that exist are: '
        + Object.keys(table).join(', ') + '.',
      isError: true,
    };
  }

  try {
    const input = call.input && typeof call.input === 'object' ? call.input : {};
    const out = await tool.run(input, ctx);
    for (const id of out.runIds || []) if (id) cited.add(String(id));

    /* The last gate before anything leaves the database. redactDeep() strips credential-shaped text
     * from every string in the result; the rest - goals as typed, step inputs, page hosts - goes to
     * the provider, which is the privacy fact described at the top of this file and named back to the
     * caller in `provider`. Redaction happens BEFORE encoding, for the reason at redact(). */
    const encoded = JSON.stringify(redactDeep(out.data));
    const clipped = encoded.length > TOOL_OUTPUT_MAX
      /* Cutting a JSON string leaves it unparseable, and the model reads it as text anyway. The note
       * matters more than the syntax: without it a half-delivered result looks like a whole one. */
      ? encoded.slice(0, TOOL_OUTPUT_MAX) + ' ...[CUT: too long to send in full. Ask for a shorter '
        + 'window or fewer rows; what is above is complete only as far as it goes.]'
      : encoded;

    used.push({ tool: call.name, input, ok: true, bytes: clipped.length });
    return { id: call.id, output: clipped, isError: false };
  } catch (err) {
    /* The real message, not a generic one. This is the owner's own deployment and their own data; a
     * lookup that failed because a column is missing after a half-applied migration is something both
     * the model and the person reading `used` need to see, rather than an answer built as though the
     * lookup had returned nothing. */
    used.push({ tool: call.name, input: call.input || {}, ok: false, note: err.message });
    return {
      id: call.id,
      output: 'That lookup failed: ' + err.message + '. Do not answer as though it returned no rows - '
        + 'say the lookup failed.',
      isError: true,
    };
  }
}

/* --------------------------------------------------------------------------- the route */

/* Can this deployment answer anything, and on whose models?
 *
 * Worth being able to ask before a demo rather than finding out from the first question. Reports only
 * whether a key is PRESENT - never the key, never a prefix, never a length, since any of those narrow
 * a guess. Same rule as the probe in api/claude.js. */
async function probe(res) {
  const configured = {};
  for (const provider of PROVIDERS) configured[provider] = !!keyFor(provider);
  return res.status(200).json({
    ok: true,
    configured,
    models: MODELS,
    /* _provider.js's own default, not this file's opinion of it - it reads the deployment's environment for
     * the OpenAI half, so restating a guess here is how a picker comes to preselect a model the route would
     * not have chosen.
     *
     * OpenAI first when this deployment has that key, because OPENAI_MODEL is where the owner states which
     * model they want the assistant to be; Anthropic is the fallback for a deployment with only that key. */
    default: configuredDefault(await readSettings(neon(process.env.DATABASE_URL))),
    database: !!process.env.DATABASE_URL,
    rounds: MAX_ROUNDS,
    /* The shared lookups only. The per-recording tools need a caller to bind to and this probe deliberately
     * has none, so listing them here would report a capability this response cannot prove. */
    tools: TOOL_NAMES,
    perRecordingTools: 'bound to the caller, so listed only on an answered question',
  });
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method === 'GET') return await probe(res);
  if (req.method !== 'POST') return fail(res, 405, 'POST a question, or GET to see what this deployment can serve');

  if (!process.env.DATABASE_URL) {
    return fail(res, 503, 'This deployment has no database configured, so there is no history to answer from.');
  }

  const sql = neon(process.env.DATABASE_URL);

  /* Who is asking, and whose rows those are. The page is same-origin so its session cookie comes
   * along by itself; the extension presents the device token it was paired with. */
  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (err) {
    return fail(res, 500, 'could not check who is calling: ' + err.message);
  }
  if (!who) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return fail(res, 401, 'sign in on the web app, or pair this extension with a device token - this '
      + 'answers questions about one account\'s history, and there is no account here');
  }

  // This spends money on a shared key, so it is counted per account. An IP is not a person.
  if (rateLimited(who.id)) {
    res.setHeader('Retry-After', '60');
    return fail(res, 429, 'too many questions in a row - one question is up to ' + (MAX_ROUNDS + 1)
      + ' model calls, so this is capped at ' + RATE_MAX + ' every five minutes. Wait a minute.');
  }

  const body = req.body && typeof req.body === 'object' ? req.body : null;
  if (!body) return fail(res, 400, 'expected a JSON body: { question, model?, history? }');

  const encoded = JSON.stringify(body);
  if (encoded.length > BODY_MAX_BYTES) {
    return fail(res, 413, 'request too large: ' + Math.round(encoded.length / 1024) + 'KB, limit '
      + Math.round(BODY_MAX_BYTES / 1024) + 'KB. The history does not need to be the whole conversation.');
  }

  const question = (text(body.question, QUESTION_MAX) || '').trim();
  if (!question) return fail(res, 400, 'ask a question - `question` was empty');

  /* An allowlist, not a passthrough, for the same reason api/claude.js has one: an unbounded model
   * name is an unbounded price. _provider.js owns the list, and it owns the wording for a provider
   * this deployment has no key for, so neither is restated here. */
  /* The same configured default the GET advertises. These two used to disagree - GET promised OpenAI when
   * that key existed while POST fell back to Anthropic - and the only reason nobody hit it is that the web
   * client always names a model. The embedded dashboard panel takes whatever this says, so this is also
   * where the admin's chat choice lands. */
  const model = body.model
    ? String(body.model).slice(0, 80)
    : configuredDefault(await readSettings(sql));
  const provider = providerFor(model);
  if (!provider) {
    return fail(res, 400, 'not a model this route will call: ' + model + '. It serves '
      + PROVIDERS.map((p) => p + ' (' + MODELS[p].join(', ') + ')').join(' and ') + '.');
  }

  /* Text turns only. Anything else the caller sends - tool calls, tool results, a role of its own
   * invention - is dropped in buildTranscript, because accepting a tool result from the client would
   * let it plant rows that never came out of the database. */
  const history = Array.isArray(body.history) ? body.history.slice(-HISTORY_MAX) : [];

  try {
    const out = await answerQuestion({ sql, userId: who.id, model, question, history });
    return res.status(200).json({
      ok: true,
      answer: out.answer,
      citations: out.citations,
      used: out.used,
      usage: out.usage,
      // Named so the caller knows where their goals and step inputs went. See the header.
      provider,
      model,
    });
  } catch (err) {
    if (err instanceof NotAnAnswer) return fail(res, err.status || 502, err.message);
    // ProviderError already carries the upstream's own words and the right status, including the 503.
    if (err instanceof ProviderError) return fail(res, err.status || 502, err.message);
    return fail(res, 500, err.message);
  }
}
