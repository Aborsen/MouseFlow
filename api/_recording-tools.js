/* One recording, read in detail and edited - the tools that scope the assistant to a single flow.
 *
 * This is a module, not a route. api/chat.js registers whatever recordingTools() returns alongside
 * its own lookups, so everything here obeys that file's rules rather than inventing new ones:
 *
 *   - The caller's user id arrives ONCE, as the factory argument, and every query filters on it
 *     inside the WHERE clause. Not one tool takes a user id and no code path reads one from tool
 *     input. A model-supplied user id is the whole bug class: one hallucinated uuid and this becomes
 *     a way to read - or edit - somebody else's recordings.
 *   - Each run() returns { data, runIds }, because that is the shape chat.js's runOneTool reads.
 *     runIds is always empty here: citations are runs, and a recording is not a run.
 *   - Nothing here estimates. Where the stored rows cannot answer, the answer says so in place, in
 *     the tool result, where the model will actually read it - a comment cannot stop a confident
 *     narration of data that does not exist.
 *
 * WHY THE DERIVATION IS NOT REPEATED HERE. api/_transcript.js turns a payload into a transcript, and
 * it is the only thing that does. A second derivation in this file would drift from it, and then the
 * panel on the Record screen and the assistant beside it would describe the same recording
 * differently, both looking authoritative, with no way for a reader to tell which half is wrong.
 * That module also owns STEP NUMBERING, which matters more than it sounds: a step can be forty motion
 * samples or a press-move-release triple, and a `wait` is not an event at all - so the numbers the
 * model quotes back and the numbers an edit resolves must come from one place. Both entry points it
 * offers are PURE functions over a payload:
 *
 *   transcribe(flow)                       -> { flow, story, summary, segments, gaps }
 *   removeSteps(payload, numbers, source)  -> { payload, removed, remaining }, or it throws
 *
 * It is imported LAZILY. api/chat.js says plainly why it does not statically import api/insights.js:
 * a static import of a file that may not be on a given deploy takes the importing route down with it.
 * This module IS imported by chat.js, so a static import here would move that failure into the whole
 * assistant - one missing file would stop "what did I do last week" being answerable at all. Loaded on
 * first use instead, and a load failure is reported as one tool that cannot run.
 *
 * WHERE AN EDIT IS STORED, and the one duplication in this file. api/transcript.js owns the storage
 * shape: a removal writes user_flow.payload with the surviving events and stamps it with
 * `edits: { revision, removed, at, action, history }`, the previous payload going into `history` so the
 * edit can be undone. Those helpers are internal to that route and it exports only its handler, so the
 * stamp is MIRRORED here rather than shared - deliberately, and it is a cost worth naming: if that
 * file changes the shape and this one does not, an edit made in the chat and an edit made in the panel
 * will disagree about what "revision 3" is, and an undo will restore the wrong thing. The two must be
 * changed together until the helpers move to a file both can import. Reaching the route over HTTP
 * instead was the alternative and it is not available: the route authenticates the caller from the
 * request, and a tool has a user id but no credentials to present.
 *
 * THE ONE WRITE. remove_steps is the only tool in the assistant that changes anything, so it carries
 * the weight of that. The failure it is built around is not a database error: it is a model that
 * misread the numbering and removed steps 4 to 6 of the wrong list. Four things guard it.
 *
 *   1. The numbers are resolved against a transcript built from the payload as it stands NOW, and an
 *      out-of-range number aborts the WHOLE call. A number the transcript does not have is evidence
 *      that the numbering in play is not this recording's, and quietly applying the half that happened
 *      to be in range is exactly the accident. Nothing is written, and the message says the real range.
 *   2. The result describes what was removed in the recording's own words - the action and the target
 *      of each removed step - rather than echoing the numbers it was asked for. A wrong removal is then
 *      visible in the answer, to someone who was there, instead of staying invisible until the next
 *      replay.
 *   3. The write is conditional on the revision the payload carried when it was read, so an edit made
 *      in the panel between the reading and the writing makes this fail instead of overwriting it.
 *   4. Nothing is destroyed: the previous payload is kept and undo_edit puts it back. The last five
 *      versions are kept, and no more, because they compete for room with the recording itself - see
 *      HISTORY_MAX. So a long conversation that removes steps six times cannot undo all of it, and the
 *      result of every removal says how far back the undo reaches rather than implying it is unlimited.
 *
 * Removing steps also RENUMBERS what is left, so a second edit against the old numbers would hit the
 * wrong steps. That is said in the result of every successful removal, because it is the one way a
 * careful model still gets it wrong.
 */

/* Loaded once per instance, failure included: a file that is not on the deploy will not appear
 * mid-instance, and retrying the import on every question would spend the time to fail again. */
const TRANSCRIPT_MODULE = './_transcript.js';
let loaded = null;

const LIST_MAX = 40;
const WHERE_SHOWN = 6;              // pages or applications named per row; the rest are counted, not listed
const REMOVE_MAX = 100;             // one call is an edit; more than this is a rewrite
const WHY_MAX = 400;

/* A gap's `why` is prose the engine wrote to be read whole, so it is NOT trimmed by bounded(), which
 * cuts every string at 300. Two of them run past that on every recording - "Is anything missing from
 * this recording?" on the desktop half and "Did anything happen in a tab I cannot see here?" on the
 * web half - and both put the clause that says what to do about it at the END, so a 300-character cut
 * took the answer and left the warning. The Record screen's panel prints these whole; a model reading
 * half of the same sentence is the two halves of the product disagreeing about what the recording
 * cannot tell you. The full set is about 2.5KB, so keeping them costs a few hundred bytes of
 * TRANSCRIPT_BUDGET, and the budget loop below thins steps to pay for it. */
const GAP_WHY_MAX = 560;
/* Столько же, и по той же причине: `captured` - это то, что запись про себя ОБЕЩАЕТ, и обещание, обрезанное
 * на трёхстах знаках, теряет ровно оговорку, ради которой написано. Длиннее самой длинной ветки. */
const CAPTURED_MAX = 700;
const GAPS_MAX = 16;

/* Mirrored from api/transcript.js, and they have to match it. Five kept versions, and a payload
 * budget under the 400KB api/sync.js will accept, so an edited recording still syncs to the other
 * client. If the cap there changes, both files change with it. */
const HISTORY_MAX = 5;
const PAYLOAD_BUDGET_BYTES = 380_000;

/* What one get_transcript result may put in the prompt. Deliberately below chat.js's own
 * TOOL_OUTPUT_MAX of 12000: that limit cuts the encoded JSON mid-string and appends a note, which
 * leaves the model reading a transcript that stops mid-step. Summarising here instead means the cut
 * is made where a cut can be explained - between steps, with the missing numbers named.
 *
 * Not right up against 12000, because this is measured before chat.js redacts credential-shaped text
 * from every string on the way out, and a masked value can be longer than what it replaced. The
 * headroom is what keeps that from turning a result that fitted into one that gets clipped anyway. */
const TRANSCRIPT_BUDGET = 10_500;
const SEGMENTS_MIN = 4;             // never thin so hard that the shape of the recording is gone
const MISSING_MAX = 12;             // ranges named in one result; the rest are counted, not listed

/* ------------------------------------------------------------------------- small helpers */

const text = (value, max) => (value == null ? null : String(value).slice(0, max));

const clamp = (value, lo, hi, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), lo), hi) : fallback;
};

/* Counts come back from the neon driver as STRINGS - Postgres bigint has no safe JavaScript number,
 * so pg's parsers hand back text. Coerced at the edge, for the reason api/chat.js gives: "3" + 1 is
 * "31", and that arithmetic would end up in an answer looking like a fact. SQL NULL stays null,
 * because "not measured" and "measured, and it was none" are different answers. */
const int = (value) => {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
};

/* Timestamps arrive from the driver as Date objects. Encoded here rather than left to
 * JSON.stringify, because chat.js walks tool output before encoding it and a Date walked as a plain
 * object comes out as {} - which is how a result loses its dates entirely. */
const iso = (value) => {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(+value) ? value.toISOString() : null;
  return String(value);
};

/** Trim to `max` items, keeping order, dropping blanks and duplicates. */
function uniq(values, max) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = typeof value === 'string' ? value.trim() : value;
    if (!item) continue;
    if (out.includes(item)) continue;
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/** A step's number, or null. Never invented - see the `numbering` note in get_transcript. */
function stepNumber(step) {
  const n = Number(step && step.n);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/* Bounds on anything that came out of the transcript. It is derived from a client-written payload that
 * nothing validates, so a label can be a 40KB string and a list can hold one entry per event. Trimmed
 * rather than trusted, and the trim says so where it happens. */
function bounded(value, depth = 0) {
  if (value == null) return null;
  if (value instanceof Date) return iso(value);
  if (typeof value === 'string') return value.length > 300 ? value.slice(0, 300) + '...' : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (depth >= 4) return null;
  if (Array.isArray(value)) {
    const kept = value.slice(0, 16).map((item) => bounded(item, depth + 1));
    if (value.length > 16) kept.push('...' + (value.length - 16) + ' more, not listed');
    return kept;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value).slice(0, 40)) {
      const shown = bounded(inner, depth + 1);
      if (shown !== null && shown !== '') out[key] = shown;
    }
    return out;
  }
  return null;
}

const bytes = (value) => JSON.stringify(value).length;

/* An empty list is not a datum on the half that does not record one: a browser recording has no
 * window titles and a desktop recording has no pages, and `windows: []` beside a desktop
 * recording's name reads as "looked, and there were none". Left out entirely instead. */
const nonEmpty = (value) => (Array.isArray(value) && value.length ? value : null);

/** Every step of a transcript, by its own number. The numbering is the transcript's, never a count. */
function stepsByNumber(transcript) {
  const out = new Map();
  const segments = transcript && Array.isArray(transcript.segments) ? transcript.segments : [];
  for (const segment of segments) {
    const where = segment && segment.where && typeof segment.where === 'object' ? segment.where : null;
    for (const step of Array.isArray(segment && segment.steps) ? segment.steps : []) {
      const n = stepNumber(step);
      if (n != null && !out.has(n)) out.set(n, { step, where: where ? text(where.label, 120) : null });
    }
  }
  return out;
}

/* The transcript's own gaps, kept whole - see GAP_WHY_MAX. Capped in NUMBER as well, because the list
 * is derived from a client-written payload: the engine produces at most nine, and a longer one means
 * something this file does not understand is in there. */
function gapList(gaps) {
  const out = [];
  for (const gap of Array.isArray(gaps) ? gaps : []) {
    const question = text(gap && gap.question, 200);
    const why = text(gap && gap.why, GAP_WHY_MAX);
    if (!question && !why) continue;
    out.push({ question: question || undefined, why: why || undefined });
    if (out.length >= GAPS_MAX) break;
  }
  return out;
}

/** How many steps a transcript holds, counted from it rather than reported by anything. */
function countSteps(transcript) {
  const segments = transcript && Array.isArray(transcript.segments) ? transcript.segments : [];
  return segments.reduce(
    (sum, segment) => sum + (Array.isArray(segment && segment.steps) ? segment.steps.length : 0), 0);
}

/* ------------------------------------------------------------- reaching api/_transcript.js */

async function transcriptModule() {
  if (loaded) return loaded;
  try {
    const mod = await import(TRANSCRIPT_MODULE);
    loaded = {
      transcribe: typeof mod.transcribe === 'function' ? mod.transcribe : null,
      removeSteps: typeof mod.removeSteps === 'function' ? mod.removeSteps : null,
      error: null,
    };
    if (!loaded.transcribe || !loaded.removeSteps) {
      loaded.error = 'api/_transcript.js is on this deployment but does not export both transcribe '
        + 'and removeSteps, so a recording cannot be read or edited here. Say the feature is not '
        + 'wired up rather than describing the recording from anything else.';
    }
  } catch (err) {
    loaded = {
      transcribe: null,
      removeSteps: null,
      error: 'the transcript module is not available on this deployment ('
        + (err && err.message ? err.message : String(err)) + '), so a recording cannot be read in '
        + 'detail here. Say that; everything else about this account still works.',
    };
  }
  return loaded;
}

const looksLikeTranscript = (value) =>
  !!value && typeof value === 'object'
  && (Array.isArray(value.segments) || !!value.flow || !!value.summary);

/** transcribe() over one row, with its failure turned into words rather than a throw. */
async function readTranscript(row, payload) {
  const { transcribe, error } = await transcriptModule();
  if (!transcribe) return { transcript: null, error };
  let out;
  try {
    out = transcribe(flowInput(row, payload));
  } catch (err) {
    return {
      transcript: null,
      error: 'the transcript could not be built for that recording ('
        + (err && err.message ? err.message : String(err)) + '). Do not answer as though the '
        + 'recording were empty - say the transcript could not be built.',
    };
  }
  if (!looksLikeTranscript(out)) {
    return {
      transcript: null,
      error: 'the transcript module returned nothing usable for that recording. Do not answer as '
        + 'though the recording were empty - say the transcript could not be built.',
    };
  }
  return { transcript: out, error: null };
}

/* -------------------------------------------------------------------------- the flow row
 *
 * Read here, and not only because the payload is needed. It answers the three things a pure
 * transcript function cannot be asked: whether this id is this caller's at all, whether it was
 * deleted, and whether it is a recording rather than a created skill. Without it, a flow belonging to
 * somebody else and a flow that does not exist would be indistinguishable.
 */
async function flowRow(sql, userId, flowId) {
  const rows = await sql`
    select client_id, source, kind, name, description, payload, origins,
           created_at, updated_at, deleted_at
    from user_flow
    where user_id = ${userId} and client_id = ${flowId}
    limit 1
  `;
  return rows.length ? rows[0] : null;
}

/* The row in the words the transcript contract uses. The column names stop at the edge of this file,
 * the same way they stop at the edge of api/transcript.js - _transcript.js is handed the names it
 * hands back, and is not coupled to a schema it never reads. */
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

/** The same three answers as words, or null when the row is a recording this caller can be shown. */
function unusable(row) {
  if (!row) {
    return 'no recording with that id on this account. Use list_recordings and take the id from '
      + 'there - do not describe a recording you have not read.';
  }
  if (row.deleted_at) {
    return 'that recording was deleted on ' + iso(row.deleted_at) + '. The row is kept as a tombstone '
      + 'so the delete propagates between machines, and its transcript is not served.';
  }
  if (row.kind !== 'recorded') {
    return 'that is a created skill, not a recording: it holds a goal and its parameters, not '
      + 'captured events, so there is no transcript of it. list_skills covers created skills.';
  }
  return null;
}

/* --------------------------------------------------------------------- the payload and its edits
 *
 * These five mirror api/transcript.js - the payload guard, the edit stamp, the kept copy, the trim and
 * the conditional write. See the header for why that duplication exists and what breaks if the two
 * drift apart. editsOf() reads two fields more than the route's does - when the last edit happened and
 * what it was - because this file says out loud that a recording has been edited, and the route's
 * caller can see that for itself.
 */

/* The payload is client-written and nothing validates its inner shape on the way in - api/sync.js
 * checks that it is an object and not too large, and stores it. So every read of it is guarded, and a
 * payload that is not an object at all becomes an empty one rather than a 500. */
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

/* What the payload says about having been edited, defaulting to "never edited" - because absent and
 * malformed mean the same thing to a reader: no edit is being claimed. `removed` is cumulative, how
 * many steps are missing against what was recorded, not how many the last edit took. */
function editsOf(payload) {
  const e = payload && typeof payload.edits === 'object' && payload.edits && !Array.isArray(payload.edits)
    ? payload.edits : {};
  return {
    revision: Number.isInteger(e.revision) && e.revision > 0 ? e.revision : 0,
    removed: Number.isInteger(e.removed) && e.removed > 0 ? e.removed : 0,
    /* A date only if it reads as one, the same test api/transcript.js applies. This one is printed
     * back as `lastEditAt`, and payload.edits sits in a client-written payload - so a stamp that is
     * not a date is left unsaid rather than shown as itself under a field name that claims it is. */
    at: typeof e.at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(e.at) ? e.at.slice(0, 40) : null,
    action: e.action === 'remove' || e.action === 'undo' ? e.action : null,
    history: Array.isArray(e.history)
      ? e.history.filter((h) => h && typeof h === 'object' && !Array.isArray(h)) : [],
  };
}

/* The version an undo would restore, minus its own history: keeping the nested history would make each
 * kept version hold every version before it, and five edits would carry the recording thirty times
 * over. A DEEP copy, because a shallow one shares the events array with the payload removeSteps() is
 * about to work on - and then the kept version would hold the trimmed events and an undo would give
 * back exactly what it had just undone, with nothing to give it away. */
function snapshotOf(payload) {
  const copy = JSON.parse(JSON.stringify(payload));
  if (copy.edits && typeof copy.edits === 'object' && !Array.isArray(copy.edits)) {
    const edits = { ...copy.edits };
    delete edits.history;
    copy.edits = edits;
  }
  return copy;
}

/* Stamped, then trimmed oldest-first until the whole payload will still sync. A recording already over
 * the budget on its own events is still written - refusing would leave somebody unable to trim the
 * very recording that is too large - it simply ends up with no undo, and the result says so instead of
 * offering one that would not work. */
function stamped(payload, edits) {
  payload.edits = edits;
  const history = payload.edits.history;
  while (history.length > HISTORY_MAX) history.shift();
  while (history.length && JSON.stringify(payload).length > PAYLOAD_BUDGET_BYTES) history.shift();
  return payload.edits;
}

/* The write, conditional on the revision the payload carried when it was read. That is what stops an
 * edit worked out here from overwriting one made in the panel a moment ago: the numbers this tool
 * resolved belong to a payload that is no longer there, so the update matches no row and says so.
 * Compared as numeric rather than int so a payload carrying 1.5 in there fails the comparison instead
 * of failing the query. created_at is not touched - when the recording was made does not change. */
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
  return rows.length > 0;
}

/* What the transcript itself does not say. api/_transcript.js derives from the events and does not
 * read payload.edits, so its wording never mentions that steps were taken out; this does, from the
 * stamp, because "142 recorded actions" beside a recording somebody trimmed is the one sentence this
 * feature must not print. */
function editedNote(edits) {
  if (!edits.revision) return null;
  const back = edits.history.length
    ? ' undo_edit can go back ' + edits.history.length + ' step'
      + (edits.history.length === 1 ? '' : 's') + '.'
    : ' No kept version remains, so this cannot be undone here.';
  return {
    revision: edits.revision,
    stepsRemovedInTotal: edits.removed,
    lastEditAt: edits.at,
    lastAction: edits.action,
    undoReachesBack: edits.history.length,
    /* Two different states, and they must not share one sentence. A recording whose removals have all
     * been undone is WHOLE, and describing it as "edited, 0 steps removed" reads as a caveat on a
     * transcript that does not need one. What matters to a reader is whether anything is missing. */
    note: edits.removed
      ? 'this recording has been edited through this app: ' + edits.removed + ' step'
        + (edits.removed === 1 ? '' : 's') + ' removed in total, over ' + edits.revision + ' revision'
        + (edits.revision === 1 ? '' : 's') + '. The transcript below is of what is left, and its own '
        + 'wording does not mention the edit - so if the recording is being described to somebody, say '
        + 'it was edited.' + back
      : 'this recording was edited through this app and everything removed has since been put back, so '
        + 'nothing is missing against what was recorded. There is no need to caveat the transcript '
        + 'below.',
  };
}

/* What the stored data cannot say about a recording, by the half that made it.
 *
 * In the tool result rather than only in this file, because the model reads results and not comments.
 * Each of these has a specific way of going wrong in an answer: a transcript that lists clicks reads
 * like a complete account of the work, and the commonest thing a reader assumes is that the words
 * typed into the fields are in there somewhere. */
function limitsFor(source) {
  const shared = [
    /* «No step carries what was typed» было сказано плоско, на обе половины, и на десктопной половине это
     * неправда - вернее, было неправдой до 0.9.7. Агент читал kAXValue, чтобы НАЗВАТЬ элемент, а у
     * текстового поля kAXValue и есть его содержимое: клик по полю записывал набранное как имя. Модель
     * получала это утверждение в том же результате, который содержимое и вёз.
     *
     * Точная оговорка - в summary.captured, которая считает её по версии агента этой записи. Здесь
     * сказано то, что верно про ЛЮБУЮ запись, и читателя отсылают туда, где стоит ответ про эту. */
    'The keyboard is never read: on both halves a keystroke is counted and timed, never identified, so '
    + 'no step says which key was pressed. A `keys` count above nought means steps from an older build '
    + 'or an imported file are in here, and the transcript counts their characters rather than printing '
    + 'them. Read `summary.captured` before saying anything about what was typed: on a desktop recording '
    + 'made by an agent older than 0.9.7 a QUOTED CONTROL NAME may be the contents of the field that was '
    + 'clicked, and `captured` says whether that applies to this one. Treat such a name as the user\'s '
    + 'own text: do not quote it back unless they asked about it, and never present it as a fact about '
    + 'what they typed.',
    'A step\'s `ms` is the pause before it plus how long the action itself took, both measured from '
    + 'the recording rather than estimated. A long one is mostly pause, and the data cannot tell '
    + 'reading from thinking from waiting on a page from being away from the desk - so do not name '
    + 'one of those.',
  ];
  if (source === 'desktop') {
    return shared.concat([
      'This is a desktop recording. Its events are screen coordinates and delays: no element, no '
      + 'selector and no window per step. Which application a step happened in is NOT recorded per '
      + 'step - the recording as a whole lists the windows it touched, in first-touched order, '
      + 'sampled once a second. So "step 12 was in Excel" is not something this data supports.',
      'A desktop recording made while an elevated (admin) window had focus is silently INCOMPLETE: '
      + 'the input hook cannot see input while such a window is in the foreground, and nothing in the '
      + 'stored events marks the hole. Steps can simply be missing, and a gap that looks like a pause '
      + 'may be work that was never recorded. Say so when the timing carries the answer.',
    ]);
  }
  return shared.concat([
    'This is a browser recording. A pointer step carries the element\'s selector and its visible '
    + 'text; the page is known only from the focus events, which are what carry the url. Steps before '
    + 'the first focus event belong to no known page.',
    'A click is recorded, not its effect. What a click DID - whether it saved, failed or opened '
    + 'something - is not in a recording at all. Only a run records outcomes; search_runs has those.',
  ]);
}

/* ------------------------------------------------------------- packing one transcript small
 *
 * A ten-minute errand is a few hundred steps, and a few hundred steps do not fit in a tool result.
 * So the steps are thinned in stages, and WHICH ONES WENT is reported by number - both because a
 * summary that hides its own gaps gets read as complete, and because those numbers are what a
 * follow-up call needs in order to ask for the missing stretch.
 */

function compactStep(step) {
  const out = { n: stepNumber(step) };
  if (step && step.at != null) out.at = bounded(step.at);
  const ms = Number(step && step.ms);
  if (Number.isFinite(ms)) out.ms = Math.round(ms);
  for (const key of ['action', 'what', 'target', 'note']) {
    const value = text(step && step[key], key === 'note' ? 240 : 160);
    if (value) out[key] = value;
  }
  return out;
}

/** The first `head` and last `tail` steps of a list, and the numbers that were dropped between. */
function thin(steps, head, tail) {
  if (steps.length <= head + tail) return { kept: steps, dropped: [] };
  const kept = [...steps.slice(0, head), ...steps.slice(steps.length - tail)];
  const gone = steps.slice(head, steps.length - tail);
  const first = stepNumber(gone[0]);
  const last = stepNumber(gone[gone.length - 1]);
  return {
    kept,
    dropped: [{
      steps: gone.length,
      from: first,
      to: last,
      note: first && last
        ? 'steps ' + first + ' to ' + last + ' are not shown'
        : 'these steps carry no number, so they cannot be asked for individually',
    }],
  };
}

/* How many steps of each stretch survive, stage by stage - the first and the last of it, since a
 * stretch's first step says what it began with and its last says what it ended with.
 *
 * Fine-grained on purpose, and the fineness is the fix rather than the decoration. Two ways a coarse
 * ladder went wrong, both found by measuring real shapes rather than by reasoning about them:
 *
 *   - Three stages that ended at nothing meant a couple of hundred steps fell straight past all of
 *     them to the stage with no steps at all. With many short stretches the per-stretch overhead
 *     dominates, so halving the steps per stretch barely moves the total, and a 120-step recording came
 *     back as stretch headings and nothing else - which is not a transcript.
 *   - Starting at six-and-three wasted most of the budget on the commonest shape there is: a recording
 *     that never left one page is ONE stretch, and nine steps of eight hundred was all it showed while
 *     there was room for eighty.
 *
 * So the ladder starts generous and gets mean, and the loop below takes the first stage that fits. */
const SHAPES = [
  null, [60, 20], [30, 10], [15, 6], [8, 4], [6, 3], [4, 2], [3, 1], [2, 1], [1, 1], [1, 0], [0, 0],
];
const LAST_SHAPE = SHAPES.length - 1;

function packSegments(segments, level) {
  const shape = SHAPES[level];
  const omitted = [];

  const packed = segments.map((segment) => {
    const steps = Array.isArray(segment && segment.steps) ? segment.steps : [];
    const where = segment && segment.where && typeof segment.where === 'object' ? segment.where : null;
    const seconds = Number(segment && segment.seconds);
    const out = {
      n: int(segment && segment.n),
      where: {
        kind: (where && text(where.kind, 20)) || 'unknown',
        label: (where && text(where.label, 160)) || '(not recorded)',
        detail: (where && text(where.detail, 200)) || undefined,
        /* И АДРЕС, если запись его знает. Он проходит упаковщик наравне с остальным - то есть занимает
           место в потолке, - потому что документ без ссылок на то, куда человек заходил, читается как
           недописанный: именно так это и назвали. Без строки запроса; отрезано в api/_transcript.js. */
        url: (where && text(where.url, 300)) || undefined,
      },
      startMs: int(segment && segment.startMs),
      seconds: Number.isFinite(seconds) ? Math.round(seconds) : null,
      steps: steps.length,
    };
    const note = text(segment && segment.note, 240);
    if (note) out.note = note;

    if (!shape) {
      out.stepList = steps.map(compactStep);
    } else if (shape[0] === 0 && shape[1] === 0) {
      /* No steps at all at this stage, so the stretch carries the numbers it covers instead of filing
       * one entry per stretch in `missing`. Two numbers on the row they belong to is both smaller -
       * which buys more stretches inside the same budget - and less confusing to read than a list
       * saying "every step of stretch 1 is missing" beside a stretch that says it has seven. */
      out.stepsFrom = stepNumber(steps[0]);
      out.stepsTo = stepNumber(steps[steps.length - 1]);
    } else {
      const { kept, dropped } = thin(steps, shape[0], shape[1]);
      out.stepList = kept.map(compactStep);
      for (const gap of dropped) omitted.push({ segment: out.n, ...gap });
    }
    return out;
  });

  return { packed, omitted };
}

/* ------------------------------------------------------------------------------ the tools */

/* Поиск живёт в отдельном файле по причине, записанной в нём же: flow_digest нарочно не держит текста с
 * экрана, а flow_text держит - и правила про него стоят рядом с ним. Импорт СТАТИЧЕСКИЙ, в отличие от
 * расшифровки ниже: расшифровка приходит из файла, которого может не быть на данном развёртывании, а этот
 * модуль лежит здесь же, и его отсутствие - авария сборки, а не состояние развёртывания. */
import {
  PHRASES_SHOWN, TEXT_TOP_UP_MAX, searchRecordings, textStaleCount, textTopUp,
} from './_search.mjs';
import { randomBytes } from 'node:crypto';
import { DOC_MODEL, DOC_TRANSCRIPT_BUDGET, newDocId, writeDoc } from './_docs.mjs';

/* Насколько длинное имя доезжает до модели. Заголовки окон бывают абзацами - на живом аккаунте есть имя
 * в 200 символов про merge request, - и десяток таких в одном результате это страница текста вместо ответа.
 * Само имя в индексе не обрезано, обрезано только показанное. */
const SHOWN_NAME_MAX = 90;

export function recordingTools({ sql, userId }) {
  /* Loud rather than lenient. A tool bound to no user, or to no database, must not exist at all -
   * every guarantee in this file rests on the id being the one the session resolved to. */
  if (!sql || !userId) {
    throw new TypeError('recordingTools needs the caller\'s own sql and user id');
  }

  /* СВОИ ЖЕ ИНСТРУМЕНТЫ ПО ИМЕНИ, и это нужно ровно одному из них.
   *
   * write_process_doc обязан читать расшифровку ТЕМ ЖЕ get_transcript, которым её читает ассистент: тот
   * уже решает, что влезает, прореживает стретчи под потолок и СООБЩАЕТ, что выбросил. Написать здесь свою
   * упаковку значило бы получить второе мнение о том, какие шаги существуют, - а ссылки [step N] в
   * документе именно на том и стоят, что мнение одно.
   *
   * Присваивается после массива, потому что инструмент, который зовёт соседа, объявлен внутри этого же
   * массива. К моменту вызова run() карта уже заполнена: собрать таблицу и вызвать инструмент нельзя в
   * одном такте. */
  let byName = new Map();

  const list = [
    {
      /* ЧЕГО НЕ БЫЛО ВООБЩЕ. search_runs ищет по тому, что человек НАПЕЧАТАЛ АГЕНТУ - по цели, сводке и
       * ошибке прогона. По самим записям поиска не было: чтобы ответить «в какой записи я работал с
       * накладными», надо было читать расшифровки по одной, а их на живом аккаунте сорок пять.
       *
       * ЧТО ИМЕННО ИЩЕТСЯ, и это сказано модели в описании, а не только здесь: имена того, до чего
       * дотрагивались - заголовки окон, названия элементов, контейнер, приложение, источник страницы.
       * Всё это расшифровка и list_recordings показывают и так; новым становится не видимость, а
       * находимость.
       *
       * И НАПЕЧАТАННОГО ЗДЕСЬ НЕТ - не потому, что отфильтровано, а потому, что его нет в продукте:
       * записывается, что клавиша была нажата и какая, и ни одного слова из написанного. Поиск найдёт
       * имя поля, в которое печатали, и никогда - предложение, которое напечатали. */
      /* ДОКУМЕНТ - ОБЪЕКТ, а не ответ в чате, и это было решением: процедуру правят, с ней спорят, её
       * исправляет тот, кто действительно делает эту работу, и читают снова через квартал. Ответ в чате
       * читают один раз и прокручивают дальше. Только вторая форма выдерживает «оно неверно, поправьте», а
       * для сгенерированной процедуры это нормальный случай, а не сбой.
       *
       * МОДЕЛЬ ДРУГАЯ, И ЭТО ПРОСИЛИ: документы на gpt-5.6-terra с усилием medium, ассистент остаётся на
       * Anthropic. И то и другое пришпилено в api/_docs.mjs и записывается в строку - «кто это написал»
       * первый вопрос к любой сгенерированной процедуре. */
      name: 'write_process_doc',
      description:
        'Write a process document from ONE recording and save it, so it can be read, edited and exported '
        + 'later. Use it when somebody asks to document a process, write a procedure, or produce '
        + 'instructions from a recording - not for answering a question about one, which get_transcript '
        + 'does. Every line of the document cites the step it came from. The document says plainly what it '
        + 'cannot tell anybody: typed text is never recorded, and any step ranges the transcript could not '
        + 'deliver in full are named. Returns the document id and its title; the person reads it at '
        + '/docs. It is written by a different model from you, on purpose.',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flowId: { type: 'string', description: 'The recording id list_recordings returned.' },
          focus: {
            type: 'string',
            description: 'Optional. What the document should be about, in the asker\'s own words - use '
              + 'this to pass on what they said rather than a summary of it.',
          },
        },
        required: ['flowId'],
      },
      async run(input) {
        const flowId = text(input.flowId, 80);
        if (!flowId) {
          return { data: { error: 'flowId is required - use an id list_recordings returned.' }, runIds: [] };
        }

        /* THE SAME READER THE ASSISTANT USES. See the note on byName: a second packer would disagree with
         * this one about which steps exist, and the citations rest on there being one answer. */
        const reader = byName.get('get_transcript');
        if (!reader) {
          return { data: { error: 'the transcript tool is not registered, so nothing can be documented.' }, runIds: [] };
        }
        /* С БОЛЬШИМ ПОТОЛКОМ - см. DOC_TRANSCRIPT_BUDGET. Без него сюда приезжали заголовки стретчей без
         * единого шага, и документ выходил ровно таким, каким его и увидели: «individual execution steps
         * are not available in the supplied transcript». */
        const read = await reader.run({ flowId, budget: DOC_TRANSCRIPT_BUDGET }, {});
        if (!read.data || read.data.found === false || read.data.error) {
          return { data: { error: read.data && read.data.error
            ? String(read.data.error)
            : 'that recording could not be read, so there is nothing to document.' }, runIds: [] };
        }

        const row = await flowRow(sql, userId, flowId);
        let written;
        try {
          written = await writeDoc({
            transcript: read.data,
            name: row && row.name,
            focus: text(input.focus, 400),
          });
        } catch (err) {
          /* БРОСОК, А НЕ ВОЗВРАТ, и это исправление по живому отчёту.
           *
           * Отказ возвращался как успешный результат инструмента: used[] писал ok:true, а причина - точное
           * сообщение OpenAI, которое api/_provider.js передаёт дословно - существовала только внутри
           * данных, то есть жила лишь в пересказе модели. Модель пересказала её как «the document service
           * returned an error», и человек остался без единственного, что можно было сделать.
           *
           * Бросок включает то, что уже написано в runOneTool: настоящее сообщение попадает в used[], где
           * его видно на экране, а модели передаётся «That lookup failed: <причина>. Do not answer as
           * though it returned no rows» - то есть запрет замазывать. Ничего не сохранено и без этого:
           * вставка стоит ниже. */
          throw new Error('the process document was not written and nothing was saved. The reason, in the '
            + 'provider own words: '
            + (err && err.message ? String(err.message).slice(0, 400) : 'unknown error')
            + '. Quote that reason to the person - it is the only thing they can act on.');
        }

        const id = newDocId(randomBytes(8).toString('hex'));
        await sql`
          insert into user_doc (id, user_id, title, body, flow_ids, model, effort, revision)
          values (${id}, ${userId}::uuid, ${written.title}, ${written.body},
                  ${[flowId]}::text[], ${written.model}, ${written.effort}, 1)
        `;
        /* Первая ревизия пишется сразу, а не при первой правке: иначе у документа, отредактированного один
         * раз, не было бы версии с тем, что написала модель, - то есть нельзя было бы отличить её текст от
         * чужого. */
        await sql`
          insert into user_doc_version (doc_id, revision, title, body, written_by)
          values (${id}, 1, ${written.title}, ${written.body}, 'model')
        `;

        return {
          data: {
            written: true,
            docId: id,
            title: written.title,
            model: written.model,
            effort: written.effort,
            /* Сколько шагов документ на себя ссылается - счёт, а не список: он говорит, опирается ли
             * процедура на запись или пересказывает её общими словами. */
            citedSteps: citedCount(written.body),
            words: written.body.split(/\s+/).filter(Boolean).length,
            readAt: '/docs/' + id,
            note: 'Saved. Tell the person the title and that it is at /docs, and that it can be edited '
              + 'there - a generated procedure is usually wrong somewhere, and the person who does the job '
              + 'is the one who knows where. Do not paste the whole document into your answer.',
          },
          runIds: [],
        };
      },
    },
    {
      name: 'search_recordings',
      description:
        'Find recordings by the NAMES OF THINGS THEY TOUCHED: window titles, control names, the container '
        + 'a control sat in, applications, page origins. Use it for "which recording was I working with X '
        + 'in" - it is the only way to reach the recordings by text, since search_runs searches what was '
        + 'typed at an agent instead. A substring match, so a stem finds its longer forms. IT CANNOT FIND '
        + 'WHAT ANYBODY TYPED: the recorder stores that a key was pressed and when, plus the name of a key '
        + 'that cannot spell anything (Enter, Tab, Ctrl+S) and never a character, and no sentence '
        + 'written by a person exists in this product at all - so this finds the name of a field somebody '
        + 'typed into, never the words they put in it. Take a flowId from the result into get_transcript to '
        + 'read what was actually done.',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: {
            type: 'string',
            description: 'The text to look for, matched anywhere inside a name, case-insensitively. Use a '
              + 'stem rather than a full word - "invoic" finds invoice and invoices.',
          },
          limit: { type: 'integer', description: 'How many recordings to return. Default 10, max 25.' },
        },
        required: ['text'],
      },
      async run(input) {
        /* ОБРЕЗАЕТСЯ И ПО ПРОБЕЛАМ: text() режет только по длине, поэтому «   » проходило дальше как
         * настоящий запрос - искались три пробела внутри имён, а в ответе стояло lookedFor: "   ".
         * Пустая же строка совпала бы с каждым индексом, то есть вернула бы «всё» под видом находки. */
        const needle = String(text(input.text, 80) || '').trim();
        if (!needle) {
          return { data: { error: 'text is required - a word or a stem to look for in the names.' }, runIds: [] };
        }
        const limit = clamp(input.limit, 1, 25, 10);

        /* ИНДЕКС ПРИВОДИТСЯ В ПОРЯДОК ДО ПОИСКА, порцией, по той же причине, по которой это делает
         * дашборд: первый поиск на аккаунте с сотнями записей иначе заплатил бы за все сразу. Отказ
         * здесь не отменяет поиска - он делает его неполным, и это сказано в ответе, а не проглочено. */
        let indexProblem = null;
        let notIndexed = 0;
        try {
          if (await textStaleCount(sql, [userId]) > 0) await textTopUp(sql, [userId], TEXT_TOP_UP_MAX);
          notIndexed = await textStaleCount(sql, [userId]);
        } catch (err) {
          indexProblem = err && err.message ? String(err.message).slice(0, 200) : 'the index could not be built';
        }

        const rows = await searchRecordings(sql, [userId], needle, limit);
        return {
          data: {
            lookedFor: needle,
            found: rows.length,
            recordings: rows.map((r) => ({
              flowId: r.client_id,
              name: r.name || null,
              source: r.source || null,
              at: r.at ? new Date(r.at).toISOString() : null,
              /* СКОЛЬКО ИМЁН совпало, а не сколько раз встретилось слово: второе - факт о длине самого
               * длинного имени, первое - о записи. По нему и отсортировано. */
              matchedNames: int(r.matches),
              distinctNames: int(r.distinct_n),
              /* Те самые имена, чтобы результат объяснял себя. В нижнем регистре - так их держит индекс. */
              matched: (Array.isArray(r.matched) ? r.matched : [])
                .map((one) => String(one).slice(0, SHOWN_NAME_MAX)),
              /* И самые частые имена этой записи, в исходном написании: они говорят, о чём она вообще,
               * а не только чем совпала. */
              commonest: (Array.isArray(r.phrases) ? r.phrases : [])
                .slice(0, PHRASES_SHOWN)
                .map((p) => ({ name: String(p && p.t || '').slice(0, SHOWN_NAME_MAX), times: int(p && p.n) })),
            })),
            notIndexed,
            problem: indexProblem,
            note: 'Matched against the names of things that were touched. Nothing anybody typed is stored '
              + 'anywhere in this product, so no search can reach it. '
              + (notIndexed > 0
                ? notIndexed + ' recording(s) are not indexed yet and were not searched - ask again to '
                  + 'catch up further.'
                : 'Every recording on this account is indexed.'),
          },
          runIds: [],
        };
      },
    },
    {
      name: 'list_recordings',
      description:
        'The recordings on this account, newest first, with where each one ran and how many events it '
        + 'holds. Use it to find the recording a question is about, and take the id from here. It '
        + 'lists captured recordings only - a created skill holds a goal rather than events and is in '
        + 'list_skills.',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', description: 'How many to return. Default 20, max 40.' },
          source: {
            type: 'string',
            enum: ['web', 'desktop'],
            description: 'Only one half: web is the browser extension, desktop is the local agent.',
          },
        },
      },
      async run(input) {
        const limit = clamp(input.limit, 1, LIST_MAX, 20);
        const source = ['web', 'desktop'].includes(input.source) ? input.source : null;

        /* Counted in SQL rather than by fetching every payload: this list exists to find a recording,
         * and pulling a few hundred kilobytes of events per row to count them would make choosing one
         * more expensive than reading it. jsonb_array_length only after checking the type, since a
         * payload whose `events` is an object is old or hand-edited and one error would take out the
         * whole list. The windows are unrolled WITH ORDINALITY rather than through
         * array_agg(distinct ...): payload.windows is in first-touched order, which is the only
         * sequence information a desktop recording carries, and a distinct aggregate throws it away. */
        const rows = await sql`
          select f.client_id, f.source, f.name, f.description, f.origins,
                 f.created_at, f.updated_at,
                 case when jsonb_typeof(f.payload->'events') = 'array'
                      then jsonb_array_length(f.payload->'events') end as events,
                 case when jsonb_typeof(f.payload->'edits'->'revision') = 'number'
                      then (f.payload->'edits'->>'revision')::numeric end as revision,
                 case when jsonb_typeof(f.payload->'edits'->'removed') = 'number'
                      then (f.payload->'edits'->>'removed')::numeric end as removed,
                 (
                   select coalesce(array_agg(w.title order by w.ord), '{}'::text[])
                   from (
                     select left(nullif(trim(e.v->>'title'), ''), 80) as title, e.ord
                     from jsonb_array_elements(
                       case when jsonb_typeof(f.payload->'windows') = 'array'
                            then f.payload->'windows' else '[]'::jsonb end
                     ) with ordinality as e(v, ord)
                   ) w
                   where w.title is not null
                 ) as windows
          from user_flow f
          where f.user_id = ${userId}
            and f.deleted_at is null
            and f.kind = 'recorded'
            and (${source}::text is null or f.source = ${source}::text)
          order by f.updated_at desc
          limit ${limit}::int
        `;

        const recordings = rows.map((r) => {
          /* Deduped in full first, then cut - and the cut is reported. A silently shortened list of
           * applications reads as the whole list: a recording that touched eleven of them came back
           * naming six, and "this recording touched six applications" is then a sentence with a number
           * in it that nothing measured. The full count is cheap here because the titles are already
           * in hand; only how many travel to the model is capped. */
          const allWindows = uniq(r.windows, 400);
          const allOrigins = uniq(r.origins, 400);
          const windows = allWindows.slice(0, WHERE_SHOWN);
          const origins = allOrigins.slice(0, WHERE_SHOWN);
          const revision = int(r.revision);
          return {
            id: r.client_id,
            name: r.name || '(unnamed)',
            description: r.description || null,
            source: r.source,
            events: int(r.events),
            created: iso(r.created_at),
            updated: iso(r.updated_at),
            /* One field, and it says which kind of answer it is holding. Pages and applications are
             * not interchangeable, and a single "where" that hid the difference would let an answer
             * put a desktop recording on a website. */
            ranOn: r.source === 'desktop'
              ? {
                kind: 'applications',
                windows,
                windowsRecorded: allWindows.length,
                note: !windows.length
                  ? 'no window titles were recorded for this one'
                  : allWindows.length > windows.length
                    ? 'the first ' + windows.length + ' of ' + allWindows.length + ' window titles this '
                      + 'recording touched - the rest are not listed here; get_transcript lists more of them'
                    : null,
              }
              : {
                kind: 'pages',
                origins,
                originsRecorded: allOrigins.length,
                note: !origins.length
                  ? 'no page was recorded for this one'
                  : allOrigins.length > origins.length
                    ? 'the first ' + origins.length + ' of ' + allOrigins.length + ' sites this '
                      + 'recording touched - the rest are not listed here; get_transcript lists more of them'
                    : null,
              },
            /* Only when there is one. A field reading "revision 0, nothing removed" on every
             * untouched recording would train a reader to skip the line that matters. */
            edited: revision
              ? { revision, stepsRemovedInTotal: int(r.removed) || 0 }
              : undefined,
          };
        });

        const edited = recordings.filter((r) => r.edited).length;

        return {
          data: {
            found: recordings.length,
            more: recordings.length === limit
              ? 'this is the limit, so there may be more - raise limit'
              : 'this is all of them',
            recordings,
            note: '`events` is a size, not a duration, and it is not a step count: get_transcript '
              + 'groups events into steps its own way - a pointer path is one step, a run of scroll '
              + 'notches is one step - so a transcript always shows fewer steps than there are events. '
              + 'Never quote an event count as a number of steps, and never assume step n is event n. '
              + 'For a desktop recording the windows belong to the recording as a whole - '
              + 'first-touched order, sampled once a second - so they say which applications were '
              + 'touched, never which one a given step was in.'
              + (edited
                ? ' ' + edited + ' of these have been edited in this app, and `events` counts what is '
                  + 'left rather than what was recorded.'
                : ''),
          },
          runIds: [],
        };
      },
    },

    {
      name: 'get_transcript',
      description:
        'The readable transcript of ONE recording: what was done, in order, grouped by the '
        + 'application or page it happened in, with how long each stretch took. Read this before '
        + 'saying anything about what a recording does, and before removing anything from it. A long '
        + 'recording comes back summarised, and the result says which step numbers were left out - '
        + 'ask again with fromStep and toStep to read a missing stretch in full. The step numbers in '
        + 'the result are the only numbers remove_steps accepts.',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flowId: { type: 'string', description: 'The recording id list_recordings returned.' },
          fromStep: { type: 'integer', description: 'Only steps numbered this or higher.' },
          toStep: { type: 'integer', description: 'Only steps numbered this or lower.' },
        },
        required: ['flowId'],
      },
      async run(input) {
        const flowId = text(input.flowId, 80);
        if (!flowId) {
          return { data: { error: 'flowId is required - use an id list_recordings returned.' }, runIds: [] };
        }

        const row = await flowRow(sql, userId, flowId);
        const problem = unusable(row);
        if (problem) return { data: { found: false, error: problem }, runIds: [] };

        const payload = payloadOf(row.payload);
        const edits = editsOf(payload);
        const { transcript, error } = await readTranscript(row, payload);
        if (!transcript) {
          return {
            data: {
              found: true,
              recording: { id: row.client_id, name: row.name || '(unnamed)', source: row.source },
              error,
            },
            runIds: [],
          };
        }

        const fromStep = clamp(input.fromStep, 1, 1_000_000, null);
        const toStep = clamp(input.toStep, 1, 1_000_000, null);
        const windowed = [];
        let unnumbered = 0;

        for (const segment of Array.isArray(transcript.segments) ? transcript.segments : []) {
          const steps = Array.isArray(segment && segment.steps) ? segment.steps : [];
          const kept = steps.filter((step) => {
            const n = stepNumber(step);
            if (n == null) { unnumbered += 1; return fromStep == null && toStep == null; }
            if (fromStep != null && n < fromStep) return false;
            if (toStep != null && n > toStep) return false;
            return true;
          });
          /* A stretch whose steps all fall outside the asked-for window is dropped. With no window
           * asked for it is kept even when empty, because a stretch the transcript recorded as having
           * no steps is itself worth seeing rather than tidied away. */
          if (kept.length || (fromStep == null && toStep == null)) {
            windowed.push({ ...segment, steps: kept });
          }
        }

        /* Identity from the ROW, the rest from the transcript. The row is what the id was checked
         * against, so it is the half that decides what this recording is called and which half of the
         * product made it. */
        const flow = bounded(transcript.flow) || {};
        const stepsInTranscript = countSteps(transcript);
        /* How many steps the asked-for range actually holds, counted before any thinning: `stepsShown`
         * below is nought both when the range matched nothing and when the recording was too long to
         * send a single step of, and those two must not share a sentence. */
        const stepsMatched = windowed.reduce((sum, segment) => sum + segment.steps.length, 0);
        const asked = fromStep != null || toStep != null;

        /* The whole result is what gets measured, not just the step list. Got that wrong first time
         * round: the segments were thinned to fit and then the notes, the limits and the
         * missing-ranges list were added on top, so a result built to fit left here half again as
         * large and chat.js cut it mid-string - which is the one outcome this budget exists to
         * prevent. */
        const assemble = (level, segmentLimit, prose = true) => {
          const { packed, omitted } = packSegments(windowed, level);
          const kept = packed.slice(0, segmentLimit);
          const segmentsCut = packed.length - kept.length;
          const numbersKept = new Set(kept.map((segment) => segment.n));
          const gaps = omitted.filter((gap) => gap.segment == null || numbersKept.has(gap.segment));
          const shown = kept.reduce(
            (sum, segment) => sum + (Array.isArray(segment.stepList) ? segment.stepList.length : 0), 0);

          return {
            recording: {
              id: row.client_id,
              name: row.name || '(unnamed)',
              source: row.source,
              created: iso(row.created_at),
              origins: nonEmpty(flow.origins) || nonEmpty(uniq(row.origins, WHERE_SHOWN)) || undefined,
              windows: nonEmpty(flow.windows) || undefined,
            },
            edited: editedNote(edits) || undefined,
            /* The narrative, first. It is the recording told in order - four short paragraphs where the
             * step list is hundreds of lines - so a model answering "what did I do here" has the answer
             * before it starts reading coordinates. It goes through the same budget as everything else:
             * `assemble` measures the whole result, so this competes for room rather than being added on
             * top of a result already built to fit. */
            /* ПЕРВОЕ, ЧЕМ ЖЕРТВУЮТ. Рассказ - проза о том же, что говорят шаги; при шагах он избыточен,
               а без них оставался единственным, что доезжало. Измерено на записи из 73 шагов: 2823 байта
               рассказа против НУЛЯ шагов. */
            story: prose ? nonEmpty(bounded(transcript.story)) || undefined : undefined,
            /* `captured` НЕ через общий bounded, и это не вкусовщина.
             *
             * bounded режет любую строку на 300 знаках, а `captured` у десктопной записи с контекстом
             * длиннее пятисот - и отрезается ровно вторая половина, та, где счёт нажатий и оговорка про
             * то, что набранное могло попасть в имена. То есть модель получала успокаивающее начало и не
             * получала предупреждения: обрезка превращала честное предложение в ложное.
             *
             * То же исключение, что gapList() уже делает для GAP_WHY_MAX, и по той же причине: бюджет
             * ниже всё равно померяет результат целиком, так что длина здесь ничего не ломает - она
             * просто не даёт этой строке потерять смысл на полуслове. */
            summary: transcript.summary
              ? { ...bounded(transcript.summary), captured: text(transcript.summary.captured, CAPTURED_MAX) }
              : null,
            segments: kept,
            detail: {
              stepsInTranscript,
              stepsShown: shown,
              window: asked
                ? {
                  fromStep,
                  toStep,
                  stepsInRange: stepsMatched,
                  note: stepsMatched
                    ? 'only steps in this range were read'
                    : 'no step of this recording is numbered in that range, so nothing was read. It has '
                      + stepsInTranscript + ' steps in it - ask again inside that, or without a range. '
                      + 'This is not an empty recording.',
                }
                : null,
              summarised: level > 0 || segmentsCut > 0,
              /* Named plainly. A model handed a thinned transcript with no word for what was thinned
               * will describe the recording as though it had read all of it. A range that was asked for
               * is a form of leaving out too: "nothing was left out" beside forty steps of eight
               * hundred was true of the thinning and false of the result. */
              how: asked && !stepsMatched
                ? 'nothing was read at all: no step of this recording is numbered inside the range that '
                  + 'was asked for. Do not describe this recording as empty - see `window` below.'
                : level === 0 && !segmentsCut
                  ? (asked
                    ? 'every step inside the range that was asked for is here in full. Steps outside it '
                      + 'were not read - see `window` below.'
                    : 'nothing was left out')
                  : level === LAST_SHAPE
                    ? 'this recording is too long to send step by step, so only the stretches are '
                      + 'listed and no individual step is included - each stretch says which step '
                      + 'numbers it covers. Say that no steps were read, and read a stretch with '
                      + 'fromStep and toStep before describing any step of it.'
                    : 'too long to send in full, so the middle of each stretch was left out. The start '
                      + 'and the end of each one are exact.',
              /* The unit, said once. `at` and `ms` are bare numbers, and a model that reads `at: 154000`
               * as a clock time will put the recording in 1970. */
              clock: 'both numbers on a step are milliseconds, measured from the recording itself: `at` '
                + 'is how far into the recording that step begins, and `ms` is how long it took - the '
                + 'pause folded into it plus the action itself. Neither is a time of day; `created` '
                + 'above is the only real date here.',
              /* Сказано, что проза убрана: её отсутствие иначе читается как «рассказывать было нечего». */
              proseDropped: prose ? undefined
                : 'the narrative overview and the "what this recording cannot tell you" list were left out '
                  + 'to make room for the steps themselves - the steps are the evidence. Ask again with a '
                  + 'narrower step range if the overview is wanted.',
              missing: gaps.slice(0, MISSING_MAX),
              missingNotListed: gaps.length > MISSING_MAX ? gaps.length - MISSING_MAX : undefined,
              segmentsNotListed: segmentsCut || undefined,
              howToSeeMore: gaps.length || segmentsCut || level === LAST_SHAPE
                ? 'call get_transcript again with fromStep and toStep to read a missing stretch in full'
                : undefined,
            },
            /* Two lists, kept apart on purpose: `gaps` is what the transcript reports about THIS
             * recording, `limits` is what is true of every recording of this kind. Merged, there
             * would be no way to tell a fact about this row from a fact about the format. */
            /* Второе. «Чего эта запись не говорит» - настоящая честность, но 3266 байт её вытесняли все
               доказательства целиком, а detail.how и без неё говорит, чего в ответе нет. */
            gaps: prose ? gapList(transcript.gaps) : undefined,
            /* А ЭТО ОСТАЁТСЯ ВСЕГДА: здесь написано, что клавиатура никогда не читается - условие
               правильного чтения всего остального, а не комментарий к нему. Документ, потерявший эту
               строку, опишет ввод текста как записанный. */
            limits: limitsFor(row.source),
            numbering: unnumbered
              ? unnumbered + ' of the steps in this transcript carry no number, so they cannot be '
                + 'removed and must not be referred to by position - counting them yourself produces '
                + 'numbers remove_steps does not recognise.'
              : 'the `n` on each step is the number remove_steps accepts. It is the transcript\'s own '
                + 'numbering: do not renumber it, do not count positions yourself, and do not carry '
                + 'numbers over from an earlier version of this transcript.',
          };
        };

        /* ПОТОЛОК - ПАРАМЕТР, и по умолчанию тот же, что был.
         *
         * TRANSCRIPT_BUDGET выбран под чат: результат инструмента остаётся в контексте на все круги
         * разговора, и 10.5 КБ на вызов - это про то, чтобы шесть таких не вытеснили сам разговор.
         * Написание документа - другой случай: один вызов, ни одного круга после него, и модель принимает
         * на порядок больше. Пока потолок был константой, документ получал те же 10.5 КБ и, как измерено,
         * НОЛЬ шагов - то есть заголовки стретчей и просьбу описать по ним процедуру.
         *
         * Не в схеме инструмента: модели этот параметр не предлагается. Его передаёт вызывающий код,
         * который знает, сколько может себе позволить. */
        const budget = Math.max(2000, Math.min(Number(input.budget) || TRANSCRIPT_BUDGET, 400_000));

        /* ПОРЯДОК ЖЕРТВ, и он был обратным нужному.
         *
         * Сначала всё. Не влезло - убирается ПРОЗА, потому что она пересказывает шаги. Только потом
         * прореживается то, что она пересказывает. Пока проза была неприкосновенна, запись из 73 шагов
         * приезжала как рассказ, границы и примечания - и ни одного шага, - а модель честно отвечала, что
         * отдельных шагов в расшифровке нет. */
        let prose = true;
        let level = 0;
        let data = assemble(0, Infinity, prose);
        if (bytes(data) > budget) {
          prose = false;
          data = assemble(0, Infinity, prose);
        }
        while (bytes(data) > budget && level < LAST_SHAPE) {
          level += 1;
          data = assemble(level, Infinity, prose);
        }
        /* Still too long with no steps in it at all means hundreds of stretches. Dropped from the END,
         * so what survives is the beginning of the recording in order rather than a scattering of it,
         * and how many went is reported. */
        let limit = data.segments.length;
        while (bytes(data) > budget && limit > SEGMENTS_MIN) {
          /* Scaled by how far over it is, rather than one stretch at a time: a recording with a
           * thousand stretches would otherwise be re-packed a thousand times to shed the overshoot,
           * and this runs inside a request somebody is waiting on. */
          const over = bytes(data) / budget;
          limit = Math.max(SEGMENTS_MIN, Math.min(limit - 1, Math.floor(limit / over)));
          data = assemble(level, limit, prose);
        }

        return { data, runIds: [] };
      },
    },

    {
      name: 'remove_steps',
      description:
        'Remove steps from one recording. This CHANGES the recording, so call it only when the person '
        + 'has asked for those steps to go, and call get_transcript first: the numbers must be the '
        + 'ones that transcript showed. Nothing is destroyed - the version before the edit is kept and '
        + 'undo_edit restores it. In your answer, state which steps you removed and what each one was, '
        + 'using the wording this tool returns rather than the numbers you asked for, and say that '
        + 'undo_edit reverses it. What remains is renumbered, so read the transcript again before any '
        + 'further edit.',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flowId: { type: 'string', description: 'The recording id list_recordings returned.' },
          steps: {
            type: 'array',
            items: { type: 'integer' },
            description: 'The step numbers to remove, as get_transcript numbered them.',
          },
          why: {
            type: 'string',
            description: 'Why, in the person\'s own terms. Kept with the edit so it can be read later.',
          },
        },
        required: ['flowId', 'steps', 'why'],
      },
      async run(input) {
        const flowId = text(input.flowId, 80);
        const why = (text(input.why, WHY_MAX) || '').trim();
        if (!flowId) {
          return { data: { error: 'flowId is required - use an id list_recordings returned.' }, runIds: [] };
        }
        if (!why) {
          return {
            data: {
              error: 'why is required, and it is stored with the edit. A removal nobody can explain '
                + 'afterwards is not an improvement to the recording - ask the person what they want '
                + 'gone and why, then call this again.',
            },
            runIds: [],
          };
        }

        /* Deduped, ordered, integers only. Asking twice for the same step is one removal, not two, and
         * what this reports back has to say so.
         *
         * Numbers and plain digit strings, and nothing else. Coercing with Number() alone was wrong on
         * the one tool here that writes: Number(true) is 1 and Number([2]) is 2, so a model that put a
         * boolean or a nested array in the list had step 1 removed from somebody's recording without
         * ever having named it. Anything that is not recognisably a step number is dropped, and if that
         * empties the list the call is refused below rather than guessed at. */
        const asked = uniq(
          (Array.isArray(input.steps) ? input.steps : [])
            .map((value) => {
              if (typeof value === 'number') return Number.isInteger(value) ? value : null;
              if (typeof value === 'string' && /^\s*\d{1,7}\s*$/.test(value)) return Number(value.trim());
              return null;
            })
            .filter((n) => n != null && n > 0),
          REMOVE_MAX + 1,
        ).sort((a, b) => a - b);

        if (!asked.length) {
          return {
            data: {
              error: 'no usable step numbers were given, so nothing was removed. They must be whole '
                + 'numbers from the transcript.',
            },
            runIds: [],
          };
        }
        if (asked.length > REMOVE_MAX) {
          /* "More than", not a count. The list stopped being read at REMOVE_MAX + 1, so how many steps
           * were actually asked for is not known here, and printing the length of a truncated list as
           * though it were the request is the kind of small invented number this file exists to avoid. */
          return {
            data: {
              removed: 0,
              error: 'that is more than ' + REMOVE_MAX + ' steps, and one call removes at most '
                + REMOVE_MAX + '. More than that is not an edit to a recording, it is a different '
                + 'recording - remove a stretch at a time and check the transcript between, or '
                + 're-record it.',
            },
            runIds: [],
          };
        }

        const { transcribe, removeSteps: removeFromPayload, error: noModule } = await transcriptModule();
        if (!transcribe || !removeFromPayload) {
          return { data: { removed: 0, error: noModule }, runIds: [] };
        }

        const row = await flowRow(sql, userId, flowId);
        const problem = unusable(row);
        if (problem) return { data: { removed: 0, error: problem }, runIds: [] };

        const payload = payloadOf(row.payload);
        const before = editsOf(payload);
        const read = await readTranscript(row, payload);
        if (!read.transcript) {
          return {
            data: {
              removed: 0,
              error: read.error + ' Nothing was removed: an edit is only made against a transcript '
                + 'that could be read.',
            },
            runIds: [],
          };
        }

        /* Resolved against the transcript of the payload as it stands NOW - the numbering the person
         * was looking at. Any other resolution would remove step 4 from a list that showed something
         * else as step 4. */
        const byNumber = stepsByNumber(read.transcript);
        if (!byNumber.size) {
          return {
            data: {
              removed: 0,
              error: 'this transcript has no numbered steps in it, so there is nothing this tool can '
                + 'address safely and nothing was removed.',
            },
            runIds: [],
          };
        }

        const numbers = Array.from(byNumber.keys()).sort((a, b) => a - b);
        const lowest = numbers[0];
        const highest = numbers[numbers.length - 1];
        const missing = asked.filter((n) => !byNumber.has(n));

        if (missing.length) {
          /* The WHOLE call is refused, not the missing part of it. See the header: a number this
           * transcript does not have means the numbering in play is not this transcript's, and
           * applying the half that happened to land is the accident this tool exists to avoid. */
          return {
            data: {
              removed: 0,
              refused: true,
              notInThisTranscript: missing,
              transcriptNumbersStepsFrom: lowest,
              transcriptNumbersStepsTo: highest,
              error: 'step ' + missing.join(', ') + ' is not in this transcript, which numbers steps '
                + lowest + ' to ' + highest + '. NOTHING was removed, on purpose: a number that is '
                + 'not here means the numbering you are using is not this recording\'s, and removing '
                + 'the rest of the request would have taken the wrong steps out. Read the transcript '
                + 'again, confirm with the person which steps they mean, then call this again.',
            },
            runIds: [],
          };
        }

        if (asked.length >= byNumber.size) {
          return {
            data: {
              removed: 0,
              refused: true,
              error: 'that is every step in the recording. Removing all of them leaves a recording '
                + 'that replays nothing, which is a deletion wearing an edit\'s clothes - if the '
                + 'recording should go, the person can delete it on the Record screen, where the row '
                + 'is tombstoned so the delete reaches their other machines. Nothing was removed.',
            },
            runIds: [],
          };
        }

        /* What is about to go, in words, taken BEFORE the write. After the edit these steps are no
         * longer in the transcript to describe. */
        const removing = asked.map((n) => {
          const entry = byNumber.get(n);
          const compact = compactStep(entry.step);
          return {
            n,
            /* The transcript's own wording, kept whole. `what` already reads as a sentence - "clicked
             * "Save row 0"" - so prefixing the action to it produced "click clicked ...", which is
             * this file rewriting a description that was already right. */
            was: compact.what || compact.action || '(the transcript records no description of this step)',
            target: compact.target,
            where: entry.where,
            ms: compact.ms == null ? null : compact.ms,
          };
        });

        /* Copied before anything is removed: what an undo gives back must not be reachable from the
         * events removeSteps() is about to work on. See snapshotOf(). */
        const kept = snapshotOf(payload);

        /* The source is passed because this row HAS it - api/sync.js keeps it in a column precisely
         * because guessing it from a payload is unreliable, and a desktop recording edited as though
         * it were a browser one would drop the wrong events. */
        let edited;
        try {
          edited = removeFromPayload(payload, asked, row.source === 'desktop' ? 'desktop' : 'web');
        } catch (err) {
          /* removeSteps() refuses rather than guesses, and its message names what it would not do.
           * Nothing has been written at this point, which is worth saying: the recording is exactly as
           * it was. */
          return {
            data: {
              removed: 0,
              refused: true,
              error: 'the removal was refused: ' + (err && err.message ? err.message : String(err))
                + ' Nothing was written, so the recording is unchanged.',
            },
            runIds: [],
          };
        }

        const nextPayload = edited && typeof edited === 'object' && !Array.isArray(edited)
          && edited.payload && typeof edited.payload === 'object' && !Array.isArray(edited.payload)
          ? edited.payload : null;
        const hadEvents = Array.isArray(payload.events) ? payload.events.length : 0;
        const nowEvents = nextPayload && Array.isArray(nextPayload.events)
          ? nextPayload.events.length : null;
        if (!nextPayload || nowEvents == null) {
          return {
            data: {
              removed: 0,
              error: 'the removal did not say which events were left, so nothing has been written. Say '
                + 'the edit did not go through rather than reporting the steps as gone.',
            },
            runIds: [],
          };
        }
        /* Only GROWTH is impossible. This refused an UNCHANGED event count as well, which was wrong and
         * made the commonest edit of all fail: a `wait` step owns no event of its own - removing it
         * clears the delay stored on the event that FOLLOWED it - so the step goes and the event count
         * stays exactly where it was. Somebody asking for the two-minute pause to come out of a
         * recording was told the edit had not gone through, which was itself untrue. api/transcript.js
         * carries the same correction, and the same reason, at withoutSteps(). Whether anything
         * actually went is settled below, in steps, which is the unit the request was made in. */
        if (hadEvents && nowEvents > hadEvents) {
          return {
            data: {
              removed: 0,
              error: 'removing those steps left more events than the recording had, which cannot be '
                + 'right, so nothing has been written. Say the edit did not go through rather than '
                + 'reporting the steps as gone.',
            },
            runIds: [],
          };
        }

        /* Counted from the transcript of the EDITED payload rather than by subtraction, and before the
         * write: an edit that produced something the transcript cannot read would leave somebody with
         * a recording they can no longer open, so it is refused instead of stored. */
        const after = await readTranscript(row, nextPayload);
        const remaining = after.transcript ? countSteps(after.transcript) : 0;
        if (!remaining) {
          return {
            data: {
              removed: 0,
              error: 'that removal leaves a recording the transcript can read nothing in, so it has '
                + 'not been saved. The recording is unchanged.',
            },
            runIds: [],
          };
        }
        /* The check the event count cannot make, in the unit the request was made in. A payload stamped
         * "3 steps removed" that still transcribes to the same steps is the one thing that must never be
         * stored - and now that an unchanged event count is allowed above, this is the only place that
         * would catch it. api/transcript.js makes the same comparison at removeFrom(). */
        if (remaining >= byNumber.size) {
          return {
            data: {
              removed: 0,
              error: 'the transcript still reads ' + remaining + ' steps after removing ' + asked.length
                + ' of ' + byNumber.size + ', so nothing has been written. Say the edit did not go '
                + 'through rather than reporting the steps as gone.',
            },
            runIds: [],
          };
        }

        const at = new Date().toISOString();
        const stamp = stamped(nextPayload, {
          revision: before.revision + 1,
          // Cumulative, against what was recorded - so an undo that puts everything back reaches nought.
          removed: before.removed + asked.length,
          at,
          action: 'remove',
          history: before.history.concat([{
            // The revision an undo would put this recording back to, and what it would give back.
            revision: before.revision,
            at,
            removed: asked.length,
            why,
            payload: kept,
          }]),
        });

        const written = await save(sql, userId, flowId, nextPayload, before.revision);
        if (!written) {
          return {
            data: {
              removed: 0,
              error: 'this recording was edited somewhere else while this was being worked out, so '
                + 'nothing has been changed - the step numbers you had may point at different steps '
                + 'now. Read the transcript again and ask the person to confirm before retrying.',
            },
            runIds: [],
          };
        }

        const undoEntry = stamp.history[stamp.history.length - 1];
        return {
          data: {
            ok: true,
            recording: { id: row.client_id, name: row.name || '(unnamed)' },
            /* Asked and done, side by side. When they disagree the answer has to say which one
             * happened, and it is the second - the first is only what was requested. */
            asked: asked.length,
            removedNow: asked.length,
            removedSteps: removing,
            stepsBefore: byNumber.size,
            remaining,
            removedInTotal: stamp.removed,
            revision: stamp.revision,
            /* Null rather than a promise when the kept version had to be trimmed to keep the payload
             * inside what api/sync.js will accept. Offering an undo that would fail is worse than
             * saying there is none. */
            undo: undoEntry && undoEntry.payload
              ? {
                tool: 'undo_edit',
                flowId: row.client_id,
                backToRevision: undoEntry.revision,
                versionsKept: stamp.history.length,
                note: 'the version before this edit is kept. undo_edit on this recording puts it back.',
              }
              : null,
            undoNote: undoEntry && undoEntry.payload
              ? undefined
              : 'no version could be kept for this recording - it is close enough to the size limit '
                + 'that keeping a copy would stop it syncing - so this edit CANNOT be undone here. '
                + 'Say that plainly.',
            why,
            renumbered: 'the steps that remain are renumbered from the top. Numbers from the '
              + 'transcript you read before this edit no longer point at the same steps, so call '
              + 'get_transcript again before removing anything else.',
            sayThis: 'state which steps you removed and what each one was, from removedSteps, and say '
              + 'whether it can be undone. Do not describe the removal by the numbers you asked for - '
              + 'the person is looking at the transcript, and the wording is the part they can check.',
          },
          runIds: [],
        };
      },
    },

    {
      name: 'undo_edit',
      description:
        'Put back the version of one recording from before the last remove_steps on it. Use it when '
        + 'the person says the removal was wrong. It undoes ONE edit and only the last five are kept, '
        + 'so say what was restored rather than promising the recording is back to how it began.',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flowId: { type: 'string', description: 'The recording id list_recordings returned.' },
        },
        required: ['flowId'],
      },
      async run(input) {
        const flowId = text(input.flowId, 80);
        if (!flowId) {
          return { data: { error: 'flowId is required - use an id list_recordings returned.' }, runIds: [] };
        }

        const row = await flowRow(sql, userId, flowId);
        const problem = unusable(row);
        if (problem) return { data: { restored: false, error: problem }, runIds: [] };

        const payload = payloadOf(row.payload);
        const before = editsOf(payload);
        const entry = before.history[before.history.length - 1];
        const kept = entry && entry.payload && typeof entry.payload === 'object'
          && !Array.isArray(entry.payload) ? entry.payload : null;

        if (!kept) {
          /* Three different facts, and none of them may borrow another's wording. Never edited; edited
           * and already put back, which is not a loss at all; or edited with steps still missing and no
           * kept version to go back to, which is. All three change nothing, and only the third is
           * worth sounding sorry about. */
          const why = !before.revision
            ? 'this recording has not been edited through this app, so there is nothing to undo.'
            : !before.removed
              ? 'everything that was removed from this recording has already been put back, so there '
                + 'is nothing left to undo - nothing is missing against what was recorded.'
              : 'this recording was edited and ' + before.removed + ' step'
                + (before.removed === 1 ? ' is' : 's are') + ' still missing, but no version before '
                + 'the edit is kept any more - only the last ' + HISTORY_MAX + ' are, and a client '
                + 'that re-saves the recording replaces them. That edit cannot be undone here.';
          return {
            data: {
              restored: false,
              revision: before.revision || null,
              stillMissing: before.removed,
              error: why + ' Nothing was changed.',
            },
            runIds: [],
          };
        }

        const restored = { ...kept };
        const read = await readTranscript(row, restored);
        const remaining = read.transcript ? countSteps(read.transcript) : 0;
        if (!remaining) {
          return {
            data: {
              restored: false,
              error: 'the kept version reads as empty, so it has not been put back - the recording is '
                + 'left exactly as it is.',
            },
            runIds: [],
          };
        }

        const back = editsOf(restored);
        /* The revision keeps going up even as the events go back. A number that went 2 -> 1 would say
         * two different payloads were both revision 1, and anything caching by revision would serve
         * the wrong one. What tells a reader the recording is whole again is `removed` reaching
         * nought: "revision 3, nothing missing" is true, "back to revision 1" is not. */
        const stamp = stamped(restored, {
          revision: before.revision + 1,
          removed: back.removed,
          at: new Date().toISOString(),
          action: 'undo',
          // The entry just used is dropped, so undo is a way back rather than a switch to press twice.
          history: before.history.slice(0, -1),
        });

        const written = await save(sql, userId, flowId, restored, before.revision);
        if (!written) {
          return {
            data: {
              restored: false,
              error: 'this recording was edited somewhere else while this undo was being worked out, '
                + 'so nothing has been changed. Read the transcript again before trying anything.',
            },
            runIds: [],
          };
        }

        return {
          data: {
            ok: true,
            recording: { id: row.client_id, name: row.name || '(unnamed)' },
            restored: true,
            steps: remaining,
            putBack: int(entry.removed),
            whyItWasRemoved: text(entry.why, WHY_MAX) || null,
            revision: stamp.revision,
            stillMissing: stamp.removed,
            furtherUndos: stamp.history.length,
            note: stamp.removed
              ? 'that edit is undone, but this recording has been edited more than once and ' +
                stamp.removed + ' step' + (stamp.removed === 1 ? ' is' : 's are') + ' still missing '
                + 'against what was recorded. ' + (stamp.history.length
                  ? 'undo_edit can go back ' + stamp.history.length + ' more.'
                  : 'No further version is kept, so the rest cannot be put back here.')
              : 'that edit is undone and nothing is missing against what was recorded.',
            renumbered: 'the numbering is the restored version\'s again. Read the transcript before '
              + 'any further edit.',
          },
          runIds: [],
        };
      },
    },
  ];

  /* Заполняется ПОСЛЕ массива - см. объявление выше. */
  byName = new Map(list.map((tool) => [tool.name, tool]));
  return list;
}

/* Сколько шагов текст на себя ссылается. Здесь, а не в _docs.mjs, потому что это нужно ровно для одной
 * строки в ответе инструмента; сама разборка ссылок живёт там, где живёт их формат. */
function citedCount(body) {
  const found = new Set();
  for (const m of String(body || '').matchAll(/\[step\s+(\d+)\]/gi)) found.add(m[1]);
  for (const m of String(body || '').matchAll(/\[steps\s+(\d+)\s*-\s*(\d+)\]/gi)) {
    found.add(m[1]);
    found.add(m[2]);
  }
  return found.size;
}
