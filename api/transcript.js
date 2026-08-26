/* One recording, read back as something a person can check - and edited when it is wrong.
 *
 *   GET  /api/transcript?flow=<clientId>
 *        -> { ok, flow, story, summary, segments, gaps }
 *
 *   POST /api/transcript?flow=<clientId>   { remove: [3, 4, 5] }
 *                                         { keep:   [1, 2, 9] }
 *                                         { undo:   true }
 *        -> { ok, removed, remaining, revision, undo: { revision } | null }
 *
 * The Record screen used to say "142 events", which is a number nobody can act on. This route hands
 * back the reading of it: what was clicked, where, how long each part took, and - the part that makes
 * it worth trusting - what the stored data cannot say. None of that prose is written here. The
 * numbering, the segmenting and the honesty about what was never captured all live in _transcript.js,
 * as pure functions over the payload, and this file only fetches a row, checks whose it is, and writes
 * one back. That split is not tidiness: `remove: [3, 4]` has to mean the steps the reader saw numbered
 * 3 and 4, so the code that numbers them and the code that drops them must be the same code.
 *
 * SCOPING. Every query filters on the id whoIsCalling() returned, inside the WHERE clause, and a flow
 * that is not the caller's is a 404 rather than a 403. Whether somebody else's flow id exists is not
 * something this route will confirm - the ids are chosen by the client, so a 403 would turn this into
 * an oracle for guessing them.
 *
 * WHY AN EDIT IS KEPT IN THE PAYLOAD, and not in a table of its own.
 *
 * A removal writes user_flow.payload with the surviving events and stamps the payload with
 * `edits: { revision, removed, at, action, history }`. The previous payload goes into `history`, so the
 * edit can be undone; nothing is destroyed by an edit.
 *
 * The reason to keep the stamp there rather than in a side table is that the stamp and the events have
 * to travel together, always. They are one claim about reality: "this is 139 of the 142 things that
 * happened". /api/sync hands the payload to whichever client asks, and both clients overwrite the
 * whole payload when the user saves that recording again (see the upsert in api/sync.js). If the stamp
 * lived in a table of its own it would survive a client push that restored the original events, and
 * the transcript would then say "edited, 3 steps removed" over a recording holding all 142 - a
 * sentence that is not true and that nobody could disprove from the page. Kept in the payload, the two
 * go back together: an overwrite loses the edit AND the claim, which reads as the original recording,
 * which is then what it is. That failure is recoverable; the other one is a quiet lie.
 *
 * The cost is real and worth writing down: history competes for room with the recording itself,
 * because api/sync.js refuses a pushed payload over 400KB. So the history is capped at the last
 * HISTORY_MAX edits AND trimmed until the whole payload fits PAYLOAD_BUDGET_BYTES, oldest first. A
 * recording whose kept version has been trimmed away says so by carrying no `undo` in the response,
 * rather than offering one that would fail - and a long recording already near that ceiling therefore
 * gets no undo at all, which is the honest consequence of the choice above. Keeping only the removed
 * events and putting them back by index would be small enough to always fit, but this file does not
 * know which events a step was made of - only _transcript.js does, which is the entire reason the
 * removal is delegated - and inventing that mapping here is how the numbers stop agreeing. And a
 * client that re-saves the recording replaces the history, so an undo is a way back from the edit you
 * just made in this app, not an archive.
 *
 * One place the two files have to agree: something has to say "edited, 3 steps removed", or an edited
 * recording reads as the original - which is the one sentence this whole feature must not print.
 * _transcript.js does not read `payload.edits` (the key is not in it), so the GET says it here, in the
 * gaps, where the rest of what a recording cannot tell you already is: see editedGap(). The POST
 * reports the revision back as well, so an edit is never silent either way.
 *
 * If this ever has to be an archive - who edited what, months back, across clients - it needs a table
 * (db/004_flow_edit.sql: user_id, client_id, revision, the removed events, when), and then the
 * transcript has to read both and reconcile them. That is the right shape for an audit trail and the
 * wrong shape for one claim about one recording, so it is not written yet.
 *
 * WHAT AN EDIT DOES NOT DO. It does not touch created_at - when the recording was made is a fact about
 * the past - and it does not rewrite name or description. A client-authored description ("Repeats 142
 * recorded actions") goes stale after an edit and is left stale on purpose: this route is not in the
 * business of writing prose about someone's recording, and the transcript beside it carries the counts
 * that are actually true.
 */

import { neon } from '@neondatabase/serverless';
import { whoIsCalling } from './_session.js';
/* Потолок теперь считается в базе, а не в памяти процесса - см. api/_spend.mjs. Здешний Map жил в
 * ОДНОМ тёплом инстансе, а сколько их, решает трафик: то есть настоящий предел умножался ровно тогда,
 * когда был нужнее всего. Комментарий рядом со старым счётчиком это признавал. */
import { overSpend, spentWhy } from './_spend.mjs';
import { transcribe, removeSteps } from './_transcript.js';
/* Server-side crashes reach Sentry from here. See api/_report.js — no dependency, and it
 * deliberately sends the route and the message, never the query string or the body. */
import { report, wrap } from './_report.js';
/* Один заголовочный набор на все маршруты - см. api/_cors.mjs. Семь копий этих строк разошлись
 * ровно в том месте, где это стоило дороже всего: chats.js отражал ЛЮБОЙ origin и выдавал
 * Allow-Credentials, то есть чужая страница читала разговоры человека его же кукой. */
import { cors } from './_cors.mjs';

const ID_MAX = 80;                    // the width api/sync.js stores a client id at
const BODY_MAX_BYTES = 100_000;
const STEPS_MAX = 5_000;              // step numbers accepted in one call

/* The last five edits, and no more, for a reason that is about the recording rather than the edits:
 * every kept version is a copy of the events, and api/sync.js refuses a payload over 400KB. The budget
 * is under that ceiling so an edited recording still syncs - if the cap there changes, this has to
 * change with it, or editing a large recording silently stops it reaching the other client. */
const HISTORY_MAX = 5;
const PAYLOAD_BUDGET_BYTES = 380_000;

const NAMED_MAX = 20;                 // how many offenders a refusal spells out before "and N more"

/* Per-account, POST only. A removal rewrites a whole payload, so a stuck client looping on it would
 * rewrite the same row hundreds of times; the GET is one row and a pure function over it, which is
 * cheaper than the sync the page already does on load, so it is not counted. Same construction as
 * api/insights.js and the same honesty about it: a serverless instance holds its own window, so the
 * real ceiling is this times however many instances are warm. It stops a loop, not a determined
 * caller. */
/* Потолок на звонящего переехал в api/_spend.mjs и считается в базе.
 *
 * Здесь стоял Map в области модуля, и его собственный комментарий признавал главное: на serverless
 * каждый тёплый инстанс держит своё окно, так что настоящий предел был этим числом, умноженным на
 * количество проснувшихся - то есть он рос ровно тогда, когда был нужнее всего. Шесть маршрутов
 * повторяли эту конструкцию, каждый со своей копией и своим признанием.
 *
 * Числа не потерялись: они перечислены в LIMITS одним списком, где их наконец можно сравнить. */


const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'transcript_error', message } });

/* A stop with a status on it. Every refusal below is thrown rather than returned, so that no path
 * through an edit can fall out of a validation check and carry on to the write. */
class Halt extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'Halt';
    this.status = status;
  }
}
const halt = (status, message) => new Halt(status, message);

/* ------------------------------------------------------------------------- small helpers */

const text = (value, max) => (value == null ? null : String(value).slice(0, max));
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

// Names the offenders in a refusal, but not all of them - a message longer than the screen is not read.
const list = (values) => {
  const shown = values.slice(0, NAMED_MAX).join(', ');
  return values.length > NAMED_MAX ? shown + ' and ' + (values.length - NAMED_MAX) + ' more' : shown;
};

/* The payload is client-written and nothing validates its inner shape on the way in - api/sync.js
 * checks that it is an object and that it is not too large, and stores it. So every read of it here is
 * guarded, and a payload that is not an object at all becomes an empty one rather than a 500. */
function payloadOf(stored) {
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) return stored;
  if (typeof stored === 'string') {
    try {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) {
      // Not JSON. Treated as an empty payload, and the transcript will say it found nothing in it.
    }
  }
  return {};
}

/* The row, in the words the contract uses. The database's column names stop at the edge of this file:
 * _transcript.js is handed { id, name, kind, source, created, origins, payload } because those are the
 * names it hands back, and a builder that had to know about client_id and created_at would be coupled
 * to a schema it never reads. */
function flowInput(row, payload) {
  return {
    id: String(row.client_id),
    name: String(row.name || ''),
    kind: row.kind === 'created' ? 'created' : 'recorded',
    source: row.source === 'desktop' ? 'desktop' : 'web',
    description: String(row.description || ''),
    created: iso(row.created_at),
    updated: iso(row.updated_at),
    origins: Array.isArray(row.origins) ? row.origins.map((o) => String(o)) : [],
    payload,
  };
}

/* What the payload says about having been edited. Guarded like everything else in there, and defaulting
 * to "never edited", because absent and malformed mean the same thing to a reader: no edit is being
 * claimed.
 *
 * `removed` is cumulative - how many steps are missing compared with what was recorded - not how many
 * the last edit took. That is the number a transcript needs in order to say "edited, 3 steps removed",
 * and it is a count of what went at the time each edit was made, not a subtraction from the current
 * numbering: the steps that survive get renumbered by the transcript afterwards. */
function editsOf(payload) {
  const e = payload && typeof payload.edits === 'object' && payload.edits && !Array.isArray(payload.edits)
    ? payload.edits : {};
  return {
    revision: Number.isInteger(e.revision) && e.revision > 0 ? e.revision : 0,
    removed: Number.isInteger(e.removed) && e.removed > 0 ? e.removed : 0,
    // A date only if it reads as one. This one is printed to a person, so a malformed stamp is
    // left unsaid rather than shown as itself.
    at: typeof e.at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(e.at) ? e.at.slice(0, 10) : null,
    history: Array.isArray(e.history)
      ? e.history.filter((h) => h && typeof h === 'object' && !Array.isArray(h)) : [],
  };
}

/* The version an undo would restore, minus its own history. Keeping the nested history would make each
 * kept version hold every version before it, so five edits would carry the recording thirty-odd times
 * over and the payload would pass the sync limit on a recording nowhere near it.
 *
 * A DEEP copy, and it has to be. A shallow one shares the events array with the payload that
 * removeSteps() is handed, and nothing in this file can promise another file's function does not
 * splice that array in place - in which case the kept version would end up holding the trimmed
 * events, and an undo would hand back exactly what it had just undone with nothing on the page to
 * give it away. The payload came out of jsonb and is about to go back into it, so a JSON round trip
 * loses nothing that was ever in there. */
function snapshotOf(payload) {
  const copy = JSON.parse(JSON.stringify(payload));
  if (copy.edits && typeof copy.edits === 'object' && !Array.isArray(copy.edits)) {
    const edits = { ...copy.edits };
    delete edits.history;
    copy.edits = edits;
  }
  return copy;
}

/* Trims history, oldest first, until the payload fits. A recording that is over the budget on its own
 * events is still written: refusing would leave somebody unable to trim the very recording that is too
 * large, which is the opposite of useful. It simply ends up with no undo, and the response says so by
 * carrying none. */
function fit(payload) {
  const history = payload.edits.history;
  while (history.length > HISTORY_MAX) history.shift();
  while (history.length && JSON.stringify(payload).length > PAYLOAD_BUDGET_BYTES) history.shift();
  return payload;
}

/* ------------------------------------------------------------------------------ the route */

async function handler(req, res) {
  cors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return fail(res, 405, 'GET a transcript, or POST to remove steps from one');
  }
  if (!process.env.DATABASE_URL) {
    return fail(res, 503, 'This deployment has no database configured, so there are no recordings to read.');
  }

  const sql = neon(process.env.DATABASE_URL);

  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (err) {
    await report(err, req, { route: 'transcript' });
    return fail(res, 500, 'could not check who is calling: ' + err.message);
  }
  if (!who) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return fail(res, 401, 'sign in on the web app, or pair this extension with a device token - a '
      + 'recording belongs to one account, and there is no account here');
  }

  /* A repeated query parameter arrives as an array, and String(['a','b']) is "a,b" - an id that matches
   * nothing, so the caller would get a 404 about a recording they never asked for. */
  const raw = req.query && req.query.flow;
  const flowId = text(Array.isArray(raw) ? raw[0] : raw, ID_MAX);
  if (!flowId) return fail(res, 400, 'which recording? pass ?flow=<id>');

  try {
    if (req.method === 'GET') return await show(res, sql, who.id, flowId);
    const budget = await overSpend(sql, who.id, 'transcript');
    if (!budget.ok) {
      res.setHeader('Retry-After', String(Math.ceil(budget.retryInMs / 1000)));
      return fail(res, 429, spentWhy(budget, 'edits'));
    }

    return await edit(req, res, sql, who.id, flowId);
  } catch (err) {
    if (err instanceof Halt) return fail(res, err.status, err.message);
    await report(err, req, { route: 'transcript' });
    return fail(res, 500, err.message);
  }
}

/* --------------------------------------------------------------------------- reading one */

async function readFlow(sql, userId, flowId) {
  /* The owner check is inside the WHERE clause so no code path can forget it, and deleted_at is null
   * so a tombstoned flow reads as gone rather than as editable. */
  const rows = await sql`
    select client_id, source, kind, name, description, payload, origins, created_at, updated_at
    from user_flow
    where user_id = ${userId} and client_id = ${flowId} and deleted_at is null
    limit 1
  `;
  return rows[0] || null;
}

// Says nothing about whether that id exists elsewhere. See the header.
const notThere = (res) => fail(res, 404, 'no recording with that id on this account');

/* transcribe() is another file's work, and a seam between two files is where a mismatch shows up as a
 * half-written response. So its output is checked against the contract before it is served: a missing
 * key is a 500 that names it, rather than a body the page would read as "this recording has no steps". */
function build(flow) {
  let t;
  try {
    t = transcribe(flow);
  } catch (err) {
    throw halt(500, 'could not read that recording: ' + err.message);
  }
  if (!t || typeof t !== 'object') throw halt(500, 'the transcript builder returned nothing');

  const missing = [];
  if (!t.flow || typeof t.flow !== 'object') missing.push('flow');
  if (!t.summary || typeof t.summary !== 'object') missing.push('summary');
  if (!Array.isArray(t.segments)) missing.push('segments');
  if (!Array.isArray(t.gaps)) missing.push('gaps');
  /* Checked because it was NOT, and that is exactly how it went missing: this route enumerates the keys it
   * serves rather than passing the builder's result through, so a key the check does not name is a key
   * that can be built and then quietly dropped here. It was, for one deploy - the page rendered no
   * narrative at all and looked like the feature had not shipped. Anything added to the contract belongs
   * in this list on the same commit. */
  if (!Array.isArray(t.story)) missing.push('story');
  if (missing.length) {
    throw halt(500, 'the transcript builder returned no ' + missing.join(', ')
      + ' for this recording, so there is nothing safe to show');
  }
  return t;
}

// Every step number the reader can see, in the order the transcript numbers them.
function stepsIn(t) {
  const numbers = [];
  for (const segment of t.segments) {
    if (!segment || typeof segment !== 'object' || !Array.isArray(segment.steps)) continue;
    for (const step of segment.steps) {
      if (step && typeof step === 'object' && Number.isInteger(step.n)) numbers.push(step.n);
    }
  }
  /* Distinct and in order, because everything downstream counts entries here as steps: "it has N
   * steps, numbered X to Y", and the refusal to remove all of them. Two steps numbered the same
   * would be a bug in the transcript, but it must not turn into a miscounted refusal here. */
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/* An edited recording has to say so, and this is the only place that can say it.
 *
 * A removal stores the surviving events, so a transcript built from that payload counts what is left
 * and reads exactly like a recording that was made that way - which is the one sentence this whole
 * feature must not print. _transcript.js does not look at payload.edits (the key appears nowhere in
 * it) and the GET's shape is fixed, so the stamp is said here as a GAP: the same { question, why }
 * shape as the rest of them, in the list a reader already reads for what the recording cannot tell
 * them. Appended rather than prepended, so the builder's own gaps keep the order it chose. If the
 * builder ever starts reading the stamp itself, this comes out - two files saying it is worse than
 * neither.
 *
 * Nothing about WHO edited it: no column holds that, and this is not the place to guess. */
function editedGap(payload) {
  const e = editsOf(payload);
  if (!e.removed) return [];
  return [{
    question: 'Is this everything that was recorded?',
    why: 'No: ' + e.removed + (e.removed === 1 ? ' step has' : ' steps have') + ' been removed from '
      + 'this recording in this app since it was made'
      + (e.at ? ', the last of them on ' + e.at : '')
      + (e.revision ? ' (revision ' + e.revision + ')' : '') + '. Every count and every timing above '
      + 'is of what is left, so this transcript is shorter than what happened at the machine. '
      + (e.history.length
        ? 'The version before that removal is still kept here, so it can be undone.'
        : 'No earlier version is kept any more, so it cannot be undone here - the machine that made '
          + 'the recording may still hold the original.'),
  }];
}

async function show(res, sql, userId, flowId) {
  const row = await readFlow(sql, userId, flowId);
  if (!row) return notThere(res);

  const payload = payloadOf(row.payload);
  const t = build(flowInput(row, payload));
  const gaps = t.gaps.concat(editedGap(payload));
  return res.status(200).json({
    ok: true,
    flow: t.flow,
    // The recording in words, and the reason somebody opened this. Served before the steps it summarises.
    story: t.story,
    /* `summary.gaps` is a count of the list below it, and this route APPENDS to that list - so the
     * count is recomputed here rather than passed through. Served as the builder wrote it, an edited
     * recording came back saying eight gaps over a list of nine, and the one it was not counting was
     * the one saying steps had been removed. */
    summary: { ...t.summary, gaps: gaps.length },
    segments: t.segments,
    gaps,
  });
}

/* --------------------------------------------------------------------------- editing one */

async function edit(req, res, sql, userId, flowId) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body) {
    throw halt(400, 'expected a JSON body: { remove: [3, 4] }, { keep: [1, 2] } or { undo: true }');
  }
  const encoded = JSON.stringify(body);
  if (encoded.length > BODY_MAX_BYTES) {
    throw halt(413, 'request too large: ' + Math.round(encoded.length / 1024) + 'KB, limit '
      + Math.round(BODY_MAX_BYTES / 1024) + 'KB. Remove steps in batches.');
  }

  const wantsUndo = body.undo === true;
  const hasRemove = body.remove !== undefined;
  const hasKeep = body.keep !== undefined;
  if (hasRemove && hasKeep) {
    throw halt(400, 'send `remove` or `keep`, not both - they would have to agree, and if they agreed '
      + 'one of them is unnecessary');
  }
  if (wantsUndo && (hasRemove || hasKeep)) {
    throw halt(400, 'send `undo` on its own - undoing and editing in one call has no order that is '
      + 'obviously the right one');
  }
  if (!wantsUndo && !hasRemove && !hasKeep) {
    throw halt(400, 'nothing asked for: send { remove: [...] }, { keep: [...] } or { undo: true }');
  }

  const row = await readFlow(sql, userId, flowId);
  if (!row) return notThere(res);

  /* A created skill is a goal and its parameters. The steps kept alongside it are evidence of what the
   * run that produced it did, not the thing replayed (see extension/skills.js) - editing them would be
   * editing the evidence, so this refuses rather than obliging. */
  if (row.kind !== 'recorded') {
    throw halt(409, 'this is a created skill, not a recording - it has no recorded steps to remove');
  }

  const payload = payloadOf(row.payload);
  return wantsUndo
    ? await undoLast(res, sql, userId, flowId, row, payload)
    : await removeFrom(res, sql, userId, flowId, row, payload, body, hasKeep);
}

/* The numbers as asked for. Digits in a string are accepted because these arrive from a chat message
 * as often as from a click, and a model that writes ["3","4"] means the same thing as [3, 4]. Anything
 * else is refused BY NAME: a step number quietly dropped from a `keep` list would delete a step the
 * caller meant to keep.
 *
 * What it does NOT do is decide which numbers are plausible. It used to refuse anything below 1,
 * which is this file holding a second opinion about a numbering that belongs to _transcript.js: on a
 * transcript that began at 0, step 0 came back as "not a step number". Whether a number exists is
 * settled against the transcript's own steps in removeFrom(), which says "no step 0 in this
 * recording - it has 12 steps, numbered 1 to 12" instead, and that is an answer a person can act on. */
function stepNumbers(value, label) {
  if (!Array.isArray(value)) {
    throw halt(400, '`' + label + '` must be an array of step numbers, as the transcript numbers them');
  }
  if (value.length > STEPS_MAX) {
    throw halt(413, '`' + label + '` has ' + value.length + ' entries, more than the ' + STEPS_MAX
      + ' this will take at once');
  }

  const asked = [];
  const unusable = [];
  for (const entry of value) {
    const n = typeof entry === 'number' && Number.isInteger(entry) ? entry
      : typeof entry === 'string' && /^\s*\d+\s*$/.test(entry) ? Number(entry.trim())
      : null;
    if (n == null) {
      unusable.push(String(JSON.stringify(entry === undefined ? null : entry)).slice(0, 40));
    } else {
      asked.push(n);
    }
  }
  if (unusable.length) throw halt(400, 'these are not step numbers: ' + list(unusable));

  // Deduplicated: asking twice for the same step is one removal, not two, and `removed` has to say so.
  return [...new Set(asked)].sort((a, b) => a - b);
}

async function removeFrom(res, sql, userId, flowId, row, payload, body, hasKeep) {
  const flow = flowInput(row, payload);
  /* The transcript is built BEFORE anything is removed and the step numbers are resolved against it,
   * because that is the numbering the caller was looking at. Resolving them any other way - against
   * event indices, say - would remove step 4 from a list that showed something else as step 4. */
  const known = stepsIn(build(flow));
  if (!known.length) {
    throw halt(409, 'this recording has no steps to remove - the transcript found nothing in it');
  }
  const set = new Set(known);

  const asked = stepNumbers(hasKeep ? body.keep : body.remove, hasKeep ? 'keep' : 'remove');
  const unknown = asked.filter((n) => !set.has(n));
  if (unknown.length) {
    /* Read off the ends rather than spread into Math.min: `known` holds one entry per step, a long
     * recording holds thousands, and an argument list that long throws instead of answering. stepsIn()
     * sorts it, so the first and the last ARE the range - which is how remove_steps reads the same
     * numbering in api/_recording-tools.js. */
    throw halt(400, 'no step ' + list(unknown.map(String)) + ' in this recording - it has '
      + known.length + ' steps, numbered ' + known[0] + ' to ' + known[known.length - 1]);
  }

  const keep = new Set(asked);
  const remove = hasKeep ? known.filter((n) => !keep.has(n)) : asked;
  if (!remove.length) {
    throw halt(400, hasKeep
      ? 'that keeps every step, so there is nothing to remove'
      : '`remove` was empty - name the steps to remove');
  }
  if (remove.length >= known.length) {
    /* Deliberately refused. An empty recording is not an edited recording, it is a deletion wearing
     * one's name - and deleting a flow is api/sync.js's job, where it tombstones the row so the delete
     * propagates instead of the flow coming back from the next machine that syncs. */
    throw halt(400, 'that would remove all ' + known.length + ' steps. A recording with no steps is a '
      + 'deletion, not an edit - delete the recording instead');
  }

  const before = editsOf(payload);
  /* Copied before anything is removed, for the reason in snapshotOf(): what an undo gives back must
   * not be reachable from the events removeSteps() is about to work on. */
  const kept = snapshotOf(payload);
  const next = withoutSteps(payload, remove, flow.source);

  /* Counted from the transcript of the edited payload rather than by subtraction, and built before the
   * write for a second reason: an edit that produced a payload the transcript cannot read would leave
   * somebody with a recording they can no longer open, so it is refused instead of stored. */
  const remaining = stepsIn(build({ ...flow, payload: next })).length;
  if (!remaining) {
    throw halt(409, 'that removal leaves a recording the transcript can read nothing in, so it has not '
      + 'been saved');
  }
  /* The one check that says the edit did what was asked, in steps, which is the unit it was asked in.
   * A removal can leave the event count alone - see withoutSteps() - but it cannot leave the reading
   * of the recording alone, and a payload stamped "3 steps removed" that still transcribes to the
   * same steps is the one thing that must never be stored. */
  if (remaining >= known.length) {
    throw halt(500, 'the transcript still reads ' + remaining + ' steps after removing '
      + remove.length + ' of ' + known.length + ', so nothing has been changed');
  }

  const at = new Date().toISOString();
  next.edits = fitted(next, {
    revision: before.revision + 1,
    // Cumulative, against what was recorded - see editsOf().
    removed: before.removed + remove.length,
    at,
    action: 'remove',
    history: before.history.concat([{
      // The revision an undo would put this recording back to, and what it would give back.
      revision: before.revision,
      at,
      removed: remove.length,
      payload: kept,
    }]),
  });

  await save(sql, userId, flowId, next, before.revision);
  return res.status(200).json(said(next, remaining));
}

async function undoLast(res, sql, userId, flowId, row, payload) {
  const before = editsOf(payload);
  const entry = before.history[before.history.length - 1];
  const kept = entry && entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
    ? entry.payload : null;
  if (!kept) {
    throw halt(409, before.revision
      ? 'this recording was edited, but the version before it is no longer kept - only the last '
        + HISTORY_MAX + ' are, and a client that re-saves the recording replaces them'
      : 'this recording has not been edited, so there is nothing to undo');
  }

  const restored = { ...kept };
  const remaining = stepsIn(build(flowInput(row, restored))).length;
  if (!remaining) {
    throw halt(500, 'the kept version reads as empty, so it has not been restored - the recording is '
      + 'left as it is');
  }

  const back = editsOf(restored);
  /* The revision keeps going up, even as the events go back. A number that went 2 -> 1 would say two
   * different payloads were both revision 1, and anything caching by revision would serve the wrong
   * one. What tells a reader the recording is whole again is `removed` reaching nought: "revision 3,
   * nothing missing" is a true sentence, and "back to revision 1" is not. */
  restored.edits = fitted(restored, {
    revision: before.revision + 1,
    removed: back.removed,
    at: new Date().toISOString(),
    action: 'undo',
    // The entry just used is dropped, so undo is a way back rather than a switch to press twice.
    history: before.history.slice(0, -1),
  });

  await save(sql, userId, flowId, restored, before.revision);
  return res.status(200).json(said(restored, remaining));
}

/* Delegated, because the numbering is _transcript.js's: it knows which events a step was made of, and
 * this file must not hold a second opinion about that.
 *
 * The return is read tolerantly. The contract between these two files fixes the HTTP shape and not the
 * internal one, so all three returns that satisfy it are accepted - the surviving events, a payload
 * carrying them, or a result carrying either. Anything else stops here loudly rather than being
 * written: the one outcome worth avoiding is a stored payload stamped "3 steps removed" that still
 * holds all of them.
 *
 * `source` is handed in from the row rather than left to be worked out from the payload. It has to be:
 * user_flow.source is what says which half made a recording, api/sync.js refuses to infer it and
 * db/003_flow_source.sql says why, and transcribe() numbered these steps with it. Left out, the
 * builder falls back to reading the events - and a desktop recording that carries one action word the
 * browser half also uses (parseMacro() takes the word verbatim from an imported .mmmacro file) is then
 * read as a browser recording, where a press and its release are two steps instead of one drag. The
 * numbering shifts, and the step that goes is not the step the caller pointed at. */
function withoutSteps(payload, numbers, source) {
  /* Counted BEFORE the call. Read after it, this would be the length of whatever removeSteps() left
   * behind, so an implementation that worked in place would be compared with itself. */
  const had = Array.isArray(payload.events) ? payload.events.length : 0;
  let out;
  try {
    out = removeSteps(payload, numbers, source);
  } catch (err) {
    throw halt(500, 'could not remove those steps: ' + err.message);
  }

  const carried = out && typeof out === 'object' && !Array.isArray(out)
    && out.payload && typeof out.payload === 'object' && !Array.isArray(out.payload) ? out.payload : null;
  const events = Array.isArray(out) ? out
    : out && typeof out === 'object' && Array.isArray(out.events) ? out.events
    : carried && Array.isArray(carried.events) ? carried.events
    : null;
  if (!events) {
    throw halt(500, 'the transcript builder did not say which events were left, so nothing has been changed');
  }

  /* Only GROWTH is impossible. This used to refuse an unchanged event count as well, which is wrong
   * and would have made the commonest edit of all fail: a step that is a pause owns no event of its
   * own - removing it clears the delay carried by the event that followed - so the step goes and the
   * event count stays exactly where it was. Whether anything actually went is settled in the unit the
   * request was made in, by counting steps, back in removeFrom(). */
  if (had && events.length > had) {
    throw halt(500, 'removing those steps left more events than the recording had, which cannot be '
      + 'right - nothing has been changed');
  }

  // The surviving events, and everything else the payload carried: windows, version, name, the lot.
  return { ...(carried || payload), events };
}

// Stamped, then trimmed to what will still sync, with the payload it belongs to weighed whole. See fit().
function fitted(payload, edits) {
  payload.edits = edits;
  return fit(payload).edits;
}

/* The write. created_at is not in it - when the recording was made does not change - and the guard on
 * the revision is what stops two edits made in two open tabs from each writing a payload built from a
 * version the other has already replaced. It compares the revision rather than updated_at because
 * updated_at comes back from Postgres with microseconds and a JavaScript Date has milliseconds, so a
 * round-tripped timestamp would never match and every edit would 409. The cast is to numeric rather
 * than to int so that a payload carrying 1.5 in there fails the comparison instead of failing the
 * query.
 *
 * What it does not catch, said plainly: a caller whose transcript was read BEFORE somebody else's
 * edit. Its step numbers are resolved against the payload as it stands now, and the revision it was
 * looking at is not in the GET response for it to send back here, so a stale reading can remove
 * steps its reader never saw and this route cannot tell. The undo is the way back from that. Closing
 * it properly means the transcript carrying the revision it was built from and the caller returning
 * it with the edit. */
async function save(sql, userId, flowId, payload, expectedRevision) {
  const rows = await sql`
    update user_flow
       set payload = ${JSON.stringify(payload)}, updated_at = now()
     where user_id = ${userId} and client_id = ${flowId} and deleted_at is null
       and coalesce(
             case when jsonb_typeof(payload->'edits'->'revision') = 'number'
               then (payload->'edits'->>'revision')::numeric end, 0) = ${expectedRevision}
    returning updated_at
  `;
  if (!rows.length) {
    throw halt(409, 'this recording was edited somewhere else while this edit was being worked out, '
      + 'so nothing has been changed - reload the transcript and ask again');
  }
}

/* What the caller is told. `removed` is how many steps are missing compared with what was recorded -
 * cumulative, so an undo that puts everything back reports nought - and `remaining` is what the
 * transcript now shows. `undo` is the revision the next undo would go back to, or null when the kept
 * version has been trimmed away, so nothing offers a way back that would not work. */
function said(payload, remaining) {
  const edits = payload.edits;
  const entry = edits.history[edits.history.length - 1];
  return {
    ok: true,
    removed: edits.removed,
    remaining,
    revision: edits.revision,
    undo: entry && Number.isInteger(entry.revision) ? { revision: entry.revision } : null,
  };
}

/* The outer net: anything thrown before or around the handler's own try block. */
export default wrap(handler, 'transcript');
