/* What a recording actually says, in order, in words somebody can act on.
 *
 *   transcribe(flow)                 a user_flow row -> { flow, summary, segments, gaps }
 *   removeSteps(payload, numbers)    the same numbering, backwards: which events a step was made of
 *
 * The Record screen used to say "142 events", which answers nothing anybody asks. What a person wants
 * from a recording they are about to replay - or about to improve - is: where did this happen, what
 * did I do there, in what order, how long did each part take, and where did the time go. That is what
 * this derives, and it derives it from the events themselves rather than from a description written
 * alongside them, because a description drifts and events do not.
 *
 * PURE, and deterministic, on purpose. No database, no network, no model, no Date.now(), nothing
 * random. The same recording reads the same way every time it is opened, because a transcript
 * somebody is going to reason about - and then edit - must not change under them between two looks.
 * It is also what lets removeSteps() trust the numbering: it re-derives the transcript to find out
 * which underlying events step 7 was made of, and that is only sound if step 7 is always step 7.
 *
 * WHAT IT REFUSES TO DO is narrate data that is not there, which is the one failure that would make
 * the whole feature worthless: a confident sentence about a window title, or a typed value, that the
 * recorder never captured. So, said once here and repeated in `gaps` where a reader will actually see
 * it:
 *
 *   typing is not captured   on either half, by design. extension/content.js stopped capturing text
 *                            (framework-controlled fields and editors inside iframes dropped it
 *                            silently) and the desktop agent installs WH_MOUSE_LL only. A step that
 *                            came from an older build or an imported file can still carry a value;
 *                            this counts its characters rather than printing them.
 *   a desktop event has no   the .mmmacro line is `index | X | Y | delayMs | action`. There is no
 *   element and no window    element, no selector and no window in it. Which applications were touched
 *                            is known at the RECORDING level only - payload.windows, sampled once a
 *                            second - so a desktop recording that touched three applications gets one
 *                            segment naming all three and no claim about which step was in which.
 *   a desktop recording can  a medium-integrity agent cannot see input while an elevated window has
 *   be silently incomplete   focus (UIPI applies to the hook, not just to SendInput - see README).
 *                            The events never arrive, so nothing here can detect the hole. It says so
 *                            rather than reading as though nothing was missing.
 *   payload is client-written and nothing validates its inner shape on the way in (api/sync.js stores
 *   it as sent), so every access here is guarded. A row whose events are not a list gets a transcript
 *   that says exactly that, and no counts.
 *
 * Time is measured, never estimated. Both halves record the pause BEFORE each event - the extension
 * writes `delay`, the desktop recorder writes `delayMs`, and reading only one would give the other
 * half a duration of nought - and a browser `path` event's samples each carry a dt. The sum of those
 * is elapsed time that really elapsed.
 *
 * Files in api/ beginning with an underscore are not routes, so this is importable without being
 * reachable.
 */

/* A pause longer than this is somebody away from the machine, not work. The part past it is dropped
 * from every number here and reported in `gaps`, exactly as api/insights.js does - the constant is
 * EVENT_GAP_MAX_MS there. It is duplicated rather than imported because api/insights.js is a ROUTE:
 * importing it would tie this helper's presence to that endpoint's. If one of the two changes, the
 * dashboard and the transcript will report different durations for the same recording and both will
 * look authoritative, so they change together or not at all. */
const IDLE_MAX_MS = 120_000;

/* A pause worth its own line. Below this it is folded into the step it precedes, because "waited
 * 0.3s" between every click is how a transcript becomes unreadable; above it, waiting IS what
 * happened and hiding it would misplace the time. */
const WAIT_MIN_MS = 1_500;

/* How close together two of the same thing have to be to read as one thing. Both are deliberately
 * short: a join is only ever allowed to swallow a gap smaller than this, which is what stops a
 * collapsed step from quietly containing a pause. */
const SCROLL_JOIN_MS = 1_000;
const MOVE_JOIN_MS = 1_000;

/* Longer than the other two on purpose. A person pauses mid-sentence - to think, to read back what they
 * wrote - and cutting a typing run at every one of those turns two minutes of writing an email into
 * fourteen steps that each say "typed". Two seconds is still typing; past that, the pause is what
 * happened and gets its own line. */
const TYPE_JOIN_MS = 2_000;

/* The same numbers extension/content.js uses to recognise a double click, for the same reason: two
 * presses that close together in time and place are one gesture as far as the application receiving
 * them is concerned. The desktop recorder does not fold them itself - it has no idea what it is
 * pointing at - so this does. */
const DOUBLE_MS = 400;
const DOUBLE_PX = 6;

/* Below this, a press-move-release is a click with a wobble in it, not a drag. */
const DRAG_MIN_PX = 12;

/* A recording this sparse over this long is worth flagging: either most of it was reading, or the
 * recorder was not seeing the input (an elevated window on the desktop side, a browser page the
 * extension is not allowed into on the web side). Flagged as a question, never as a diagnosis. */
const THIN_MIN_MS = 60_000;
const THIN_PER_MINUTE = 6;

/* Caps on TEXT, not on steps. No step is ever dropped or summarised away: a transcript that hides a
 * click is worse than a long one, and the number of steps is already bounded upstream by
 * PAYLOAD_MAX_BYTES in api/sync.js. What is capped is how much of one string travels, because a
 * click on a table row records the whole row's text. */
const LABEL_MAX = 80;
const TARGET_MAX = 200;
const NOTE_MAX = 400;
const DETAIL_MAX = 300;
const WINDOWS_MAX = 24;
const ORIGINS_MAX = 12;

/* ------------------------------------------------------------------ reading a payload */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clamp0 = (n) => (n > 0 ? n : 0);

// Every string that leaves here is one line: a selector or an element's text can contain newlines,
// and a transcript whose rows are three lines tall cannot be scanned.
const oneLine = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

const round1 = (v) => Math.round(num(v) * 10) / 10;
const secondsOf = (ms) => round1(num(ms) / 1000);

/* How long something took, said the way a person would say it. */
function spanText(ms) {
  const total = clamp0(Math.round(num(ms)));
  if (total < 60_000) return round1(total / 1000).toFixed(1) + 's';
  const minutes = Math.floor(total / 60_000);
  const rest = Math.round((total - minutes * 60_000) / 1000);
  return minutes + 'm' + (rest ? ' ' + rest + 's' : '');
}

const pxText = (px) => Math.round(clamp0(px)) + 'px';

/* Timestamps arrive as Date objects from the driver and as strings from a client. Both leave as one
 * shape, because a caller that has to guess will guess wrong once. */
function isoOf(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = oneLine(value, 40);
  return text || null;
}

/* The payload as an object. The neon driver hands jsonb back already parsed, so the string case is
 * only reached by a caller that read the column as text - and telling that caller "this recording has
 * no events" would be a wrong story about their data rather than a wrong shape in their code. A string
 * that does not parse is left as one, which lands in the "cannot read this payload" transcript. */
/* What the agent said about ITSELF when it recorded this.
 *
 * Written by the client from /health at the moment of recording, because it is the only way to answer a
 * question the events cannot: "nothing was typed" and "the keyboard was not being watched" produce an
 * identical recording, and which one it was decides whether a transcript may say the work involved no
 * typing. Guessing from the events was wrong in a way worth remembering - an 0.6.0 agent resolves what
 * every click landed on and hooks no keyboard at all, so named clicks proved nothing about typing.
 *
 * Absent on every recording made before this was written, and absent has to stay answerable as "not
 * known" rather than collapsing into either yes or no. */
function recorderOf(payload) {
  const raw = payload && typeof payload.recorder === 'object' && payload.recorder !== null
    ? payload.recorder : null;
  if (!raw) return { version: null, canName: null, canKeys: null };
  const flag = (value) => (value === true ? true : value === false ? false : null);
  return {
    version: oneLine(raw.version, 20) || null,
    canName: flag(raw.canName),
    canKeys: flag(raw.canKeys),
  };
}

function payloadOf(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {
      return null;
    }
  }
  return null;
}

/* Null - not [] - when the events are not a list, because "no events" and "a payload this cannot
 * read" are different facts and the second one is worth telling somebody. */
function eventsOf(payload) {
  const events = payload && typeof payload === 'object' ? payload.events : null;
  return Array.isArray(events) ? events : null;
}

/* The front windows this recording saw, and HOW MANY there were.
 *
 * The two are separate because WINDOWS_MAX caps the list: a long recording of somebody moving between
 * documents collects a new title per document, and thirty of them in one `detail` string is not
 * readable. The count is not capped, because it used to be - `summary.applications` read 24 for a
 * recording that touched thirty windows, and an under-count presented as a fact is the failure this
 * file exists to avoid. Listing fewer than were seen is fine as long as the transcript says so. */
function windowsOf(payload) {
  const raw = payload && typeof payload === 'object' && Array.isArray(payload.windows)
    ? payload.windows : [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const title = oneLine(entry && entry.title, LABEL_MAX);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    if (out.length < WINDOWS_MAX) out.push({ title, process: oneLine(entry && entry.process, 60) });
  }
  return { windows: out, total: seen.size };
}

function originsOf(row, payload) {
  const raw = Array.isArray(row.origins) ? row.origins
    : Array.isArray(payload.origins) ? payload.origins : [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    // A string, or nothing. oneLine() stringifies whatever it is given, and payload.origins is
    // client-written, so this used to turn a stray `1` in the list into an origin called "1".
    if (typeof entry !== 'string') continue;
    const value = oneLine(entry, TARGET_MAX);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= ORIGINS_MAX) break;
  }
  return out;
}

/* The closed set of actions the extension records. Anything else in a `web` payload came from an
 * import or from a build older than this one, and is reported as unrecognised rather than guessed at. */
const WEB_ACTIONS = new Set([
  'click', 'dblclick', 'path', 'scroll', 'focus', 'navigate', 'fill', 'redacted', 'key',
]);

/* Which half made this, and therefore how to read an event.
 *
 * api/sync.js stores `source` per flow and warns against inferring it from the payload - the shapes
 * are similar enough that a guess would sometimes be wrong, and a flow labelled runnable by the wrong
 * half is a broken button. So the row's own column wins whenever there is one, and this only guesses
 * for removeSteps(), whose signature carries a payload and no row. The guess is made on the two
 * things that genuinely cannot coexist: a web-only action name, or a numeric screen coordinate on
 * every single event.
 */
function sourceOf(row, payload, events) {
  if (row && (row.source === 'desktop' || row.source === 'web')) return row.source;
  if (payload && payload.agent === 'desktop') return 'desktop';
  const list = Array.isArray(events) ? events : [];
  let webNamed = 0;
  let placed = 0;
  for (const raw of list) {
    const event = raw && typeof raw === 'object' ? raw : {};
    const action = typeof event.action === 'string' ? event.action : '';
    // `scroll` and `key` are spelled by both halves, so neither is evidence of anything.
    if (WEB_ACTIONS.has(action) && action !== 'scroll' && action !== 'key') webNamed++;
    if (Number.isFinite(Number(event.x)) && Number.isFinite(Number(event.y))
      && event.delayMs !== undefined) placed++;
  }
  if (webNamed > 0) return 'web';
  if (placed > 0 && placed === list.length) return 'desktop';
  return 'web';
}

/* ---------------------------------------------------------------------- the clock */

function newState() {
  return {
    steps: [],
    segments: [],
    current: null,
    at: 0,
    /* A pause too short to deserve a line of its own, waiting to be added to the step it precedes.
     * Carried rather than dropped so the segment durations still add up to the total. */
    carry: 0,
    /* Event indices belonging to no step of their own - a `Focus` marker, which names a place rather than
     * describing an action. Carried onto the next step for the same reason `carry` is: removeSteps() reads
     * `from.events`, and an event in no step's list can neither be removed nor accounted for. */
    carryEvents: [],
    droppedMs: 0,
    droppedPauses: 0,
  };
}

function openSegment(state, where, note) {
  const segment = {
    n: state.segments.length + 1,
    where,
    /* Where the previous segment ended, so the segments tile the recording with no holes and no
     * overlaps: startMs plus the sum of a segment's step durations is the next one's startMs. A pause
     * too short for a line of its own therefore lands in the segment AFTER it, which is off by up to
     * a second and a half at a page change - the alternative was arithmetic that does not add up, and
     * a reader can check arithmetic. */
    startMs: Math.round(state.at),
    steps: [],
    note: note == null || note === '' ? null : oneLine(note, NOTE_MAX),
  };
  state.segments.push(segment);
  state.current = segment;
  return segment;
}

/* One line of the transcript.
 *
 * `from` is how the numbering survives an edit: the underlying event indices this step was made of,
 * including the ones a collapse folded in, and for a `wait` the event whose pause it was. Stripped
 * before the step leaves this file - the route sees the contract's shape - but removeSteps() reads it,
 * which is why every event in the payload has to end up in exactly one step's `from`.
 */
function emit(state, spec) {
  const own = clamp0(Math.round(num(spec.own)));
  const carried = clamp0(Math.round(state.carry));
  const step = {
    n: state.steps.length + 1,
    /* `at` is where this step's slice of the recording BEGINS - the pause folded into it included -
     * so at + ms is always where the next step begins. It used to be the moment the action itself
     * happened, which reads better in isolation and then makes at + ms overshoot the clock by the
     * length of the fold: the desktop double-click test, which measures the gap between two steps,
     * came out negative on every pair. Anything that needs the moment of the action wants
     * at + pause. */
    at: Math.round(state.at),
    ms: carried + own,
    // The two halves of `ms`, kept because the gap between two actions is own-then-pause, not ms.
    pause: carried,
    own,
    action: spec.action,
    what: oneLine(spec.what, 300),
    target: spec.target == null || spec.target === '' ? null : oneLine(spec.target, TARGET_MAX),
    note: spec.note == null || spec.note === '' ? null : oneLine(spec.note, NOTE_MAX),
    segment: state.current ? state.current.n : 0,
    /* Structured, for the narrator. All three are already IN `what` as prose, and a sentence generator
     * that read its own sentences back would break the first time one was reworded. Stripped by
     * publicStep, like `segment` and `from`. */
    ctx: spec.ctx || null,
    keys: clamp0(num(spec.keys)),
    /* The key's own name. Listed here because this object is built field by field: anything a caller
     * passes and this does not name is dropped, silently, and the step arrives looking like an anonymous
     * keystroke - which is exactly what it is not. */
    pressed: spec.pressed == null || spec.pressed === '' ? null : oneLine(spec.pressed, 40),
    notches: clamp0(num(spec.notches)),
    px: clamp0(num(spec.px)),
    direction: spec.direction || null,
    from: {
      events: state.carryEvents.concat(Array.isArray(spec.events) ? spec.events : []),
      zeroDelay: spec.zeroDelay == null ? null : spec.zeroDelay,
    },
  };
  state.at = state.at + carried + own;
  state.carry = 0;
  state.carryEvents = [];
  state.steps.push(step);
  if (state.current) state.current.steps.push(step);
  return step;
}

/* The pause before an event, and what to do with it.
 *
 * It either becomes a `wait` step or is added to the carry. The part of a pause past two minutes is
 * not activity at all: it is dropped from the clock and counted for `gaps`, and when that happens the
 * wait step says the real length out loud rather than reporting the clamp as though it were the pause.
 */
function takePause(state, index, delay) {
  const total = clamp0(num(delay));
  const over = clamp0(total - IDLE_MAX_MS);
  const kept = total - over;
  if (over > 0) {
    state.droppedMs += over;
    state.droppedPauses += 1;
  }
  if (kept < WAIT_MIN_MS && over === 0) {
    state.carry += kept;
    return;
  }
  emit(state, {
    action: 'wait',
    what: over > 0 ? 'was away for ' + spanText(total) : 'waited ' + spanText(kept),
    target: null,
    note: over > 0
      ? 'the pause ran ' + spanText(total) + ' - only the first two minutes of it are counted here, '
        + 'the same rule api/insights.js uses, because being away from the machine is not time spent '
        + 'in an application'
      : 'nothing was captured for this long. Reading, thinking, and an application the recorder '
        + 'could not see all look the same here.',
    own: kept,
    events: [],
    zeroDelay: index,
  });
}

/* A pause INSIDE a collapsed group. It is only ever reached across a gap the join already proved
 * small, but it goes through the same clamp and the same accounting so no path can count time the
 * rest of the file has agreed not to count. */
function clampedPause(state, delay) {
  const total = clamp0(num(delay));
  const over = clamp0(total - IDLE_MAX_MS);
  if (over > 0) {
    state.droppedMs += over;
    state.droppedPauses += 1;
  }
  return total - over;
}

/* -------------------------------------------------------------- reading one event */

function webEvent(raw) {
  const event = raw && typeof raw === 'object' ? raw : {};
  const action = typeof event.action === 'string' ? event.action : '';
  const points = Array.isArray(event.points) ? event.points : [];
  let moveMs = 0;
  let travel = 0;
  let lastX = null;
  let lastY = null;
  for (const point of points) {
    if (!point || typeof point !== 'object') continue;
    moveMs += clamp0(num(point.dt));
    const x = num(point.x);
    const y = num(point.y);
    if (lastX !== null) travel += Math.hypot(x - lastX, y - lastY);
    lastX = x;
    lastY = y;
  }
  /* Two urls, not one, because conflating them threw away a datum and then reported it missing.
   *
   * `recordedUrl` is whatever the event actually stored, at any scheme. `url` is the subset of that
   * which is a web page - the only kind the extension can capture inside, and therefore the only kind
   * worth segmenting on or counting in summary.pages.
   *
   * They are different more often than it looks: background.js checks the scheme before recording a
   * tab SWITCH, but recordStart() writes the opening focus event with whatever url the tab has, so a
   * recording begun on a file:// page carries one - as does any imported payload. That url used to be
   * dropped here, and the step then said "switched to a tab this recording does not name" over a note
   * claiming what was on screen is not in the payload, while the url sat in the row. */
  const recordedUrl = typeof event.url === 'string' ? oneLine(event.url, DETAIL_MAX) : '';
  const url = /^https?:\/\//i.test(recordedUrl) ? recordedUrl : null;
  return {
    action,
    // Both spellings, because the two recorders disagree and reading one would zero the other half.
    delay: clamp0(num(event.delay !== undefined ? event.delay : event.delayMs)),
    moveMs,
    travel,
    samples: points.length,
    url,
    recordedUrl: recordedUrl || null,
    opened: event.opened === true,
    tab: event.tab === undefined ? null : num(event.tab),
    frame: clamp0(num(event.frame)),
    button: num(event.button),
    selector: oneLine(event.selector, TARGET_MAX),
    tag: oneLine(event.tag, 30).toLowerCase(),
    text: oneLine(event.text, LABEL_MAX),
    value: typeof event.value === 'string' ? event.value : null,
    key: oneLine(event.key, 30),
    ctrl: event.ctrl === true,
    shift: event.shift === true,
    alt: event.alt === true,
    meta: event.meta === true,
    /* Four keys for two numbers, because the recorder writes the WINDOW's offsets (scrollX/scrollY)
     * when the page scrolled and the ELEMENT's (scrollLeft/scrollTop) when a pane did - reading only
     * one pair would leave every pane scroll with no position and therefore no direction. */
    scrollTop: event.scrollTop !== undefined ? num(event.scrollTop)
      : event.scrollY !== undefined ? num(event.scrollY) : null,
    scrollLeft: event.scrollLeft !== undefined ? num(event.scrollLeft)
      : event.scrollX !== undefined ? num(event.scrollX) : null,
    readable: !!raw && typeof raw === 'object' && action !== '',
  };
}

const TAG_WORDS = {
  a: 'link', button: 'button', input: 'field', textarea: 'text box', select: 'dropdown',
  img: 'image', li: 'list item', tr: 'table row', td: 'cell', th: 'column heading',
  label: 'label', option: 'option', svg: 'icon', path: 'icon', h1: 'heading', h2: 'heading',
  h3: 'heading', summary: 'disclosure', details: 'disclosure',
};

/* What was clicked, in the terms the person clicking it would use. The element's visible text when
 * there is one - that is what they were looking at - and the kind of element when there is not. The
 * selector always travels in `target`, so nothing is lost by preferring the text. */
function webTargetWords(event) {
  if (event.text) return '"' + event.text + '"';
  const word = TAG_WORDS[event.tag];
  if (word) return 'a ' + word;
  if (event.tag) return 'a <' + event.tag + '>';
  return 'something with no name on it';
}

/* Somewhere that is not a web page, named by the url the event recorded. Only when there is no url at
 * all does this fall back to saying so - "a page this recording does not name" was a false sentence
 * every time a chrome://, file:// or extension url was sitting in the event it was written about. */
function unnamedLabel(recordedUrl) {
  return recordedUrl ? oneLine(recordedUrl, 70) : 'a page this recording does not name';
}

function pageLabel(url) {
  const parts = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url || '');
  if (!parts) return oneLine(url, 70) || 'an unnamed page';
  const host = parts[1].replace(/^www\./i, '');
  const path = parts[2] && parts[2] !== '/' ? parts[2] : '';
  return oneLine(host + path, 70);
}

/* ------------------------------------------------ what was under the pointer, when it is known
 *
 * The agent writes a `#ctx` line above a click naming the application, the window, and the accessible
 * name and kind of the control it landed on (agent/PROTOCOL.md, "#ctx - where a click landed").
 * macro.ts parses it onto the event; api/sync.js stores the payload as sent; this is where it becomes
 * words.
 *
 * Absent means NOT KNOWN, never "nothing there". It is resolved for clicks only - a pointer move has no
 * target worth naming and there are hundreds of them - and even for a click it can be missing: an
 * elevated window is invisible to a normal-integrity agent, an Electron application often exposes no
 * name at all, the resolver drops context rather than events when it falls behind, and any agent older
 * than 0.6.0 resolved none of it. So every sentence below has a coordinates-only form and the transcript
 * says which one it is using.
 */
const CTX_MAX = 90;

/* Control kinds that name a shape rather than a thing. UIA's LocalizedControlType is already a human
 * word - "button", "edit box", "list item" - which is why there is no mapping table here, but these
 * particular words tell a reader nothing: "clicked the \"Send\" pane" is worse than "clicked \"Send\"". */
const CTX_VAGUE = new Set(['pane', 'custom', 'group', 'window', 'client', 'unknown', 'separator', '']);

function ctxOf(raw) {
  const src = raw && typeof raw === 'object' ? raw : null;
  if (!src) return null;
  const app = oneLine(src.app, CTX_MAX);
  const window = oneLine(src.window, CTX_MAX);
  const control = oneLine(src.control, CTX_MAX);
  const type = oneLine(src.type, 40);
  /* The four the agent has written since 0.8.0 and nothing read until now. `role` and `subrole` are the
   * UNLOCALISED kind of the thing that was actually hit, which is what lets an application that names none
   * of its controls still say which of them are buttons; `container` and `containerName` are what it sits
   * in, which is what tells two identically-named rows in two lists apart. Read under both spellings: the
   * wire is short (`in`, `inName`) and the parsed object spells them out, and a payload written by either
   * has to read the same. */
  const role = oneLine(src.role, 40);
  const subrole = oneLine(src.subrole, 40);
  const container = oneLine(src.container ?? src.in, 40);
  const containerName = oneLine(src.containerName ?? src.inName, CTX_MAX);
  /* A type on its own is not context: "a button" with no name and no application says nothing a reader
   * could act on, and keeping it would make a step look resolved when it was not. */
  if (!app && !window && !control) return null;
  return {
    app: app || null,
    window: window || null,
    control: control || null,
    type: type || null,
    role: role || null,
    subrole: subrole || null,
    container: container || null,
    containerName: containerName || null,
  };
}

/* Which place a click was in, for segmenting. Application AND window, because one browser is many tabs
 * and "chrome" is not where the work happened. */
const placeKey = (ctx) => (ctx ? (ctx.app || '?') + '\u0000' + (ctx.window || '?') : null);

function ctxWhere(ctx) {
  return {
    kind: 'app',
    label: ctx.window || ctx.app,
    detail: ctx.window && ctx.app ? ctx.app : '',
  };
}

/* A click on a TAB is a move, not an action in the place you were.
 *
 * The window title follows the active tab and updates AFTER the click, so the click that switches tabs is
 * resolved against the old title - which put "switched to Netflix" inside the stretch called "Neon Console".
 * The accessibility type says it outright and says it earlier, so that is what is read.
 *
 * Only the type is trusted. Nothing here claims to know a browser from any other application with tabs; an
 * element of kind "tab item" with a name is a place you moved to, and that reading holds either way. */
const isTabMove = (ctx) => !!ctx && !!ctx.control
  && typeof ctx.type === 'string' && ctx.type.trim().toLowerCase() === 'tab item';

/* Where that click took you. The tab's own name is the place, and the application is kept as the detail -
 * the same shape a window gives, so everything downstream treats it identically. */
const tabPlace = (ctx) => ({ app: ctx.app, window: ctx.control, control: null, type: null });

// ` in OUTLOOK`, or nothing. The application is worth saying even when the control is not known.
const inApp = (ctx) => (ctx && ctx.app ? ' in ' + ctx.app : '');

/* What the accessibility tree called the thing that was actually hit, in words.
 *
 * `type` is kAXRoleDescription and it is LOCALISED - "кнопка" on a Russian system - which is right for a
 * reader and useless as a key. `role` is the unlocalised AXRole and it is what makes an unnamed click say
 * something: an application that names nothing still says its buttons are buttons. Only the roles that add
 * information are here; AXGroup, AXUnknown and a web area say no more than "an element" and are left out on
 * purpose, because a sentence that ends "clicked a group" is worse than one that says the coordinates. */
const ROLE_WORDS = {
  axbutton: 'a button',
  axpopupbutton: 'a menu button',
  axmenuitem: 'a menu item',
  axmenubaritem: 'a menu bar item',
  axcheckbox: 'a checkbox',
  axradiobutton: 'a radio button',
  axslider: 'a slider',
  axtextfield: 'a text field',
  axtextarea: 'a text area',
  axlink: 'a link',
  aximage: 'an image',
  axrow: 'a row',
  axcell: 'a cell',
  axstatictext: 'a piece of text',
  axtab: 'a tab',
  axtabgroup: 'a tab strip',
  axscrollbar: 'a scroll bar',
  axdisclosuretriangle: 'a disclosure triangle',
  axincrementor: 'a stepper',
  axcolorwell: 'a colour well',
};

const roleWords = (ctx) => {
  if (!ctx) return null;
  /* Subrole first: it is the more specific of the two, and it is the one that separates a close button from
   * every other button on a window. */
  const sub = ctx.subrole ? ROLE_WORDS[String(ctx.subrole).toLowerCase()] : null;
  if (sub) return sub;
  return ctx.role ? ROLE_WORDS[String(ctx.role).toLowerCase()] ?? null : null;
};

/* ` in the "Playlist" list`, when the container says something the sentence has not already said.
 *
 * Worth having because a name is only an identity if it is unique, and in a list it usually is not: two
 * rows called "Bad Guy" in two playlists are two different steps and read as one. Suppressed when the
 * container repeats the window - a browser's web area is named after the page - or the control itself. */
function inContainer(ctx) {
  if (!ctx || !ctx.containerName) return '';
  const name = String(ctx.containerName).trim();
  if (!name) return '';
  const said = [ctx.window, ctx.control, ctx.app].map((v) => String(v || '').trim().toLowerCase());
  if (said.includes(name.toLowerCase())) return '';
  const kind = ctx.container && !CTX_VAGUE.has(String(ctx.container).toLowerCase())
    ? ' ' + ctx.container : '';
  return ' in the "' + name + '"' + kind;
}

/* `clicked the "Send" button in OUTLOOK`, degrading one clause at a time down to `clicked at 1030,1053`.
 * The coordinates stay in `target` on every branch, so nothing that replays or edits a step loses them. */
function actWords(verb, ctx, where) {
  if (!ctx || !ctx.control) {
    /* Nothing named it - but the tree still said what KIND of thing it was, and "clicked a button at
     * 725,104" is a step somebody can place. This used to be the coordinates alone. */
    const kind = roleWords(ctx);
    return verb + (kind ? ' ' + kind + ' at ' : ' at ') + where + inApp(ctx);
  }
  const noun = ctx.type && !CTX_VAGUE.has(ctx.type.toLowerCase()) ? ' ' + ctx.type : '';
  return verb + (noun ? ' the' : '') + ' "' + ctx.control + '"' + noun + inContainer(ctx) + inApp(ctx);
}

/* Said on the step itself, because it is the difference between a recording that could not see and one
 * that saw an application naming nothing - and a reader who is told which will not ask twice. */
function ctxNote(ctx) {
  if (!ctx) return '';
  if (ctx.control) return '';
  return (ctx.app || 'the application') + ' was under the pointer, but nothing there had a name the '
    + 'agent could read - which is normal for an Electron application, a canvas, or a window running '
    + 'as administrator';
}

function deskEvent(raw) {
  const event = raw && typeof raw === 'object' ? raw : {};
  const action = oneLine(event.action, 60);
  const low = action.toLowerCase();
  let kind = 'other';
  let button = null;
  let direction = null;
  /** The key's own name, when it had one. Null for anonymous typing, which is most of them. */
  let pressed = null;
  /* Order matters: "Scroll Up" and "Scroll Left" both carry a word that also names a button state, so
   * the wheel has to be recognised before anything looks for one. */
  if (low === 'focus') {
    /* Not an action. The agent writes it when the foreground window changes, so a step that hit-tests
     * nothing can still be placed somewhere - and it is the only marker in the format that describes the
     * world rather than something a person did. */
    kind = 'focus';
  } else if (/movement|mouse move/.test(low)) {
    kind = 'move';
  } else if (/scroll|wheel/.test(low)) {
    kind = 'scroll';
    direction = /up/.test(low) ? 'up' : /down/.test(low) ? 'down'
      : /left/.test(low) ? 'left' : /right/.test(low) ? 'right' : null;
  } else if (/click|button/.test(low)) {
    button = /right/.test(low) ? 'right' : /middle/.test(low) ? 'middle' : 'left';
    kind = /release|up/.test(low) ? 'up' : /down|press/.test(low) ? 'down' : 'other';
  } else if (/key|type/.test(low)) {
    /* A key recorded BY NAME is its own kind, and the distinction is the point.
     *
     * "Key Down" is anonymous typing - a key was pressed, never which - and a hundred of them are one
     * step saying how long and how many. "Key Enter" is a different animal: it is the moment the work was
     * committed, and folding it into "typed for 3.4s - 22 keystrokes" is how a skill made from a recording
     * came to stop one step short of doing the job.
     *
     * The exclusion of "Key Down" is load-bearing, exactly as it is in the agent's replay: read as a name,
     * that legacy action is a key called "Down", and every keystroke somebody typed would read as pressing
     * the down arrow. */
    if (/^key\s+/i.test(action) && action !== 'Key Down') {
      kind = 'press';
      pressed = action.slice(4).trim() || null;
    } else {
      kind = 'key';
    }
  }
  return {
    action,
    kind,
    pressed,
    button,
    direction,
    x: num(event.x),
    y: num(event.y),
    delay: clamp0(num(event.delayMs !== undefined ? event.delayMs : event.delay)),
    ctx: ctxOf(event.context),
    readable: !!raw && typeof raw === 'object' && action !== ''
      && Number.isFinite(Number(event.x)) && Number.isFinite(Number(event.y)),
  };
}

/* ------------------------------------------------------------ a browser recording */

/* Segmented by PAGE, because that is where the work happened and it is the one thing a browser
 * recording knows per event. Any event carrying a url puts that page in force and every event after
 * it inherits it - the same carry-forward api/insights.js does with a window function, for the same
 * reason: only `focus` and `navigate` say where they are, and a click between two of them happened on
 * whatever the last one named.
 *
 * A url-bearing event whose url is the one already in force does NOT open a segment. The extension
 * writes a focus event on every tab switch, so without that rule flipping between two tabs of the
 * same page produced a run of one-step segments, which reads as work moving around when it did not.
 */
function deriveWeb(events) {
  const state = newState();
  const parsed = events.map(webEvent);
  const tabs = new Set(parsed.filter((e) => e.readable && e.tab !== null).map((e) => e.tab));
  const multiTab = tabs.size > 1;
  const pages = new Set();
  const counts = { clicks: 0, scrolls: 0, drags: 0, keys: 0, pages: 0, unreadable: 0 };
  /* The page in force. `undefined` means no event has named one yet, which is deliberately different
   * from `null` - an event that named no page at all. Both exist: the first is a recording that has
   * not started, the second is a switch to somewhere this payload does not identify, and treating
   * them as the same thing left later steps attributed to the page before the switch. */
  let inForce;

  /* Where the last scroll on a given target left it, so the NEXT one has a direction. The recorder
   * stores the position scrolled to, not the movement, so the first scroll in any pane has none and
   * this says so rather than picking one. */
  const scrollAt = new Map();
  const positionOf = (e) => ({ y: e.scrollTop, x: e.scrollLeft });
  /* Which way it went, from two positions of the same pane. Vertical first because that is what
   * "scrolled down" means to a reader, then horizontal, so a sideways scroll of a wide table is not
   * reported as having no direction at all. */
  const wayFrom = (before, now) => {
    if (!before || !now) return null;
    if (before.y !== null && now.y !== null && now.y !== before.y) return now.y > before.y ? 'down' : 'up';
    if (before.x !== null && now.x !== null && now.x !== before.x) return now.x > before.x ? 'right' : 'left';
    return null;
  };
  const endedAt = (position, direction) => {
    if (!position) return '';
    const sideways = direction === 'left' || direction === 'right';
    const value = sideways ? position.x : position.y;
    if (value === null) return '';
    return 'ended at ' + Math.round(value) + 'px ' + (sideways ? 'across' : 'down') + '. ';
  };

  const ensure = () => {
    if (!state.current) {
      openSegment(state, { kind: 'unknown', label: 'a page this recording does not name', detail: '' },
        'These steps arrived before anything named a page. The extension writes a focus event with the '
        + 'url the moment recording starts, so a recording that opens like this was made by an older '
        + 'build or imported - the page they happened on is not in the payload.');
    }
    return state.current;
  };

  let i = 0;
  while (i < parsed.length) {
    const event = parsed[i];

    /* The pause first, and it belongs to the segment in force BEFORE this event: a pause before
     * switching page was spent on the page still being looked at. */
    if (event.delay >= WAIT_MIN_MS) ensure();
    takePause(state, i, event.delay);

    if (!event.readable) {
      ensure();
      counts.unreadable++;
      emit(state, {
        action: 'other',
        what: 'an event this transcript could not read',
        target: null,
        note: 'it is not an object with an action on it. payload.events is written by the client and '
          + 'nothing validates its contents, so this entry is reported rather than skipped - skipping '
          + 'it would hide a step.',
        own: 0,
        events: [i],
      });
      i++;
      continue;
    }

    switch (event.action) {
      case 'focus':
      case 'navigate': {
        const known = event.url !== null;
        /* The place in force is keyed on the url the event RECORDED, at any scheme - not on the web
         * url alone. Both non-web urls used to collapse to null before this comparison, so a switch
         * from a file:// page to a chrome:// one compared equal and the step said "the url is the one
         * already in force, so this is a tab switch that cannot be told apart from staying put" about
         * two demonstrably different places. */
        const here = event.recordedUrl;
        const label = known ? pageLabel(event.url) : unnamedLabel(here);
        const changed = here !== inForce;
        if (changed) {
          inForce = here;
          if (known) {
            openSegment(state, { kind: 'page', label, detail: event.url }, null);
          } else {
            /* Not a web page, so its own segment either way: carrying the last page's name across a
             * switch away from it is exactly the confident sentence this file must not produce. What
             * the segment can SAY differs, though, and both easy sentences here were wrong. "The url
             * is not in the payload" is false whenever the url is merely not http - it is sitting in
             * the row. And "nothing here was captured" is false too: an extension is never allowed
             * into a browser page, but a local file IS recordable when file access is granted, and
             * the steps in this very segment would contradict the claim. So this names the url and
             * leaves the steps below as the only evidence of what was watched. */
            openSegment(state, { kind: 'unknown', label, detail: here || '' }, here
              ? 'The url recorded here is not http or https, so this is not a web page - a browser '
                + 'page, a local file, a viewer. It is named above exactly as the payload stored it. '
                + 'Whether anything inside was captured depends on which: an extension is never '
                + 'allowed into a browser page, so a segment like that holds the switch and nothing '
                + 'else. The steps below are what arrived.'
              : 'The event that led here carries no url at all. background.js writes one on every '
                + 'focus and navigate event, so this came from an import or from a build older than '
                + 'that - and what was on screen is genuinely not in the payload.');
          }
        } else {
          ensure();
        }
        if (known) pages.add(event.url);

        const first = state.steps.length === 0;
        const what = event.action === 'navigate'
          ? (here ? 'the page became ' + label
            : 'the page changed to one this recording does not name')
          : first
            ? (here ? 'started on ' + label : 'started somewhere this recording does not name')
            : changed
              ? (here ? 'switched to ' + label : 'switched to a tab this recording does not name')
              : 'switched to another tab showing ' + label;
        const notes = [];
        if (event.action === 'focus' && event.opened) {
          notes.push('a tab this recording had not touched before');
        }
        if (!known && here) {
          notes.push('the url recorded here is not http or https, so this is not a web page and may '
            + 'be one the extension was not allowed to watch');
        }
        if (!changed && event.action === 'focus') {
          notes.push('the url is the one already in force, so this is a tab switch that cannot be '
            + 'told apart from staying put');
        }
        if (event.action === 'navigate') {
          notes.push('a page load, not a click - it may have been the result of the step before it');
        }
        if (multiTab && event.tab !== null) notes.push('tab ' + (event.tab + 1) + ' of this recording');
        emit(state, {
          action: 'page',
          what,
          /* The url as recorded, whatever its scheme - `where.detail` carries the same string. This is
           * the field a reader copies, and blanking it for a non-web page threw away the only thing
           * that said where the recording had gone. */
          target: here,
          note: notes.join('; '),
          own: 0,
          events: [i],
        });
        i++;
        break;
      }

      case 'path': {
        /* Forty samples are one step: "moved the pointer". background.js already stores a continuous
         * run as ONE path event and compacts it at save time, so this only ever joins runs an older
         * build left adjacent - but it joins them, because two "moved the pointer" lines in a row say
         * nothing the first did not. The join is allowed only across a gap under a second, so it can
         * never swallow a pause. */
        ensure();
        const group = [i];
        let own = event.moveMs;
        let travel = event.travel;
        let samples = event.samples;
        let j = i + 1;
        while (j < parsed.length && parsed[j].readable && parsed[j].action === 'path'
          && parsed[j].delay < MOVE_JOIN_MS) {
          own += clampedPause(state, parsed[j].delay) + parsed[j].moveMs;
          travel += parsed[j].travel;
          samples += parsed[j].samples;
          group.push(j);
          j++;
        }
        emit(state, {
          action: 'move',
          what: travel >= 1 ? 'moved the pointer ' + pxText(travel) : 'moved the pointer',
          target: null,
          note: samples + ' samples' + (group.length > 1 ? ' in ' + group.length + ' runs' : '')
            + '. Motion between actions, kept so a replay walks the path a hand took rather than '
            + 'jumping. It is not itself an action.',
          own,
          events: group,
        });
        i = j;
        break;
      }

      case 'scroll': {
        ensure();
        const key = event.selector || 'window';
        const directionOf = (e) => {
          const now = positionOf(e);
          const before = scrollAt.has(key) ? scrollAt.get(key) : null;
          scrollAt.set(key, now);
          return wayFrom(before, now);
        };
        const first = directionOf(event);
        /* Consecutive scrolls of the same pane in the same direction within a second are one step
         * with a count. Each notch arriving as its own line is the noise that made the old event list
         * unreadable; the pane and the direction both have to match, so nothing that changed course
         * is folded away.
         *
         * The FIRST scroll in a pane has no known direction - there is no earlier position to compare
         * it with - so the group takes its direction from the first scroll that does have one. Without
         * that, an unknown-direction opener matched everything after it and a scroll down followed by
         * a scroll back up collapsed into one step called "scrolled 4 times", which is precisely the
         * kind of quiet fiction this file exists to avoid. */
        let direction = first;
        const group = [i];
        let own = 0;
        let last = event;
        let j = i + 1;
        while (j < parsed.length && parsed[j].readable && parsed[j].action === 'scroll'
          && (parsed[j].selector || 'window') === key && parsed[j].delay < SCROLL_JOIN_MS) {
          const next = directionOf(parsed[j]);
          if (next !== null && direction !== null && next !== direction) {
            /* Put the position back: that event starts the next step, and consuming its direction
             * here would leave that step unable to say which way it went. */
            scrollAt.set(key, positionOf(last));
            break;
          }
          if (next !== null && direction === null) direction = next;
          own += clampedPause(state, parsed[j].delay);
          last = parsed[j];
          group.push(j);
          j++;
        }
        counts.scrolls += group.length;
        const times = group.length > 1 ? ' ' + group.length + ' times' : '';
        emit(state, {
          action: 'scroll',
          what: (direction ? 'scrolled ' + direction : 'scrolled') + times,
          target: event.selector || 'the window',
          note: endedAt(positionOf(last), direction)
            + (direction === null
              ? 'The recorder stores the position scrolled to, not the movement, so the direction of '
                + 'the first scroll in a pane is not recorded.'
              : first === null
                ? 'The first of these had no earlier position to compare with, so the direction here '
                  + 'is the one the scrolls after it took.'
                : ''),
          own,
          events: group,
        });
        i = j;
        break;
      }

      case 'click':
      case 'dblclick': {
        ensure();
        counts.clicks++;
        const verb = event.action === 'dblclick' ? 'double-clicked'
          : event.button === 2 ? 'right-clicked'
            : event.button === 1 ? 'middle-clicked' : 'clicked';
        const notes = [];
        if (!event.text) {
          notes.push('nothing visible names this element, so the selector is the only identity the '
            + 'step has');
        } else if (event.text.length >= LABEL_MAX) {
          notes.push("the label is the element's whole text, capped at 80 characters - clicking a "
            + 'table row records the row');
        }
        if (event.frame) notes.push('inside an embedded frame');
        emit(state, {
          action: event.action === 'dblclick' ? 'dblclick' : 'click',
          what: verb + ' ' + webTargetWords(event),
          target: event.selector || null,
          note: notes.join('; '),
          own: 0,
          events: [i],
        });
        i++;
        break;
      }

      case 'fill':
      case 'redacted': {
        ensure();
        counts.keys++;
        const redacted = event.action === 'redacted';
        emit(state, {
          action: 'type',
          what: redacted
            ? 'typed into a password field'
            : 'typed into ' + webTargetWords(event)
              + (event.value === null ? '' : ' (' + event.value.length + ' characters)'),
          target: event.selector || null,
          note: redacted
            ? 'the text was deliberately never stored, and a replay stops here and asks for it'
            : 'text capture was removed from the recorder, so this step came from an older build or an '
              + 'imported file. The characters are counted rather than printed.',
          own: 0,
          events: [i],
        });
        i++;
        break;
      }

      case 'key': {
        ensure();
        counts.keys++;
        const combo = (event.ctrl ? 'Ctrl+' : '') + (event.alt ? 'Alt+' : '')
          + (event.shift ? 'Shift+' : '') + (event.meta ? 'Meta+' : '') + (event.key || 'a key');
        emit(state, {
          action: 'key',
          what: 'pressed ' + combo,
          target: event.selector || null,
          note: 'the recorder no longer captures keys, so this came from an older build or an '
            + 'imported file',
          own: 0,
          events: [i],
        });
        i++;
        break;
      }

      default: {
        ensure();
        counts.unreadable++;
        emit(state, {
          action: 'other',
          what: 'did "' + event.action + '"',
          target: event.selector || null,
          note: 'not one of the actions this recorder produces (click, dblclick, path, scroll, focus, '
            + 'navigate), so it came from an import or from a build this transcript does not know',
          own: 0,
          events: [i],
        });
        i++;
        break;
      }
    }
  }

  counts.pages = pages.size;
  return { state, counts, tabs: tabs.size };
}

/* ------------------------------------------------------------ a desktop recording */

/* ONE segment, always, and the label carries the honesty.
 *
 * There is nowhere else to put it. A .mmmacro line is `index | X | Y | delayMs | action`: no window,
 * no process, no element. payload.windows is what the front window was, sampled once a second for the
 * whole recording and kept in first-touched order, which answers "what did this touch" and cannot
 * answer "when did it move between them". So one window names the segment; several are all named
 * together with a note saying so; none says that too.
 */
function desktopWhere(windows, total, perStep) {
  /* When clicks carry their own context this segment holds only what came before the first one - the
   * pointer moving toward it, a wait - and every real step below is placed by the click that named it.
   * Saying so here stops the sampled list from being read as the answer when a better one follows. */
  if (perStep) {
    return {
      where: { kind: 'unknown', label: 'before the first click', detail: '' },
      note: 'Whatever happened before anything was clicked: this agent reads the application and window '
        + 'under the pointer at the moment of each click, so the segments below are named by the work '
        + 'itself rather than by the once-a-second sample of the front window. A pointer move names no '
        + 'window, which is why these steps are here and not there.',
    };
  }
  if (total === 1) {
    return {
      where: { kind: 'app', label: windows[0].title, detail: windows[0].process },
      /* "so every step below happened in it" is what this used to say, and it is a stronger claim than
       * a once-a-second sample can carry: a window that had focus for less than a sampling interval
       * never appears at all, so one title means one window SEEN, not one window used. */
      note: 'One window was ever sampled, so as far as this recording can tell the whole of it '
        + 'happened there. The front window is sampled once a second, for the recording as a whole '
        + 'and not per step, so a window that had focus for less than a second between two samples '
        + 'would be missing from this and nothing would mark it.',
    };
  }
  if (total === 0) {
    return {
      where: { kind: 'unknown', label: 'an application this recording does not name', detail: '' },
      note: 'No window was recorded. The web app samples the front window once a second while '
        + 'recording, and an agent too old for /windows records without it, as does an imported '
        + '.mmmacro file. The coordinates below are all there is.',
    };
  }
  /* How many titles are NAMED, worked out rather than assumed. `total` counts every distinct one
   * seen, `windows` is already capped at WINDOWS_MAX, and DETAIL_MAX then trims the joined string - so
   * a note saying "24 of the 30 are named" over a list a reader can count six names in is the same
   * wrong-number-stated-as-fact one level down. Only the titles that fit go in, and the note quotes
   * how many that was. */
  const named = [];
  let width = 0;
  for (const w of windows) {
    const add = (named.length ? 2 : 0) + w.title.length;
    if (width + add > DETAIL_MAX) break;
    named.push(w.title);
    width += add;
  }
  const short = named.length < total;
  return {
    where: { kind: 'unknown', label: total + ' windows', detail: named.join(', ') },
    note: 'These are the windows the recording saw in front, in the order they were first seen - '
      + 'sampled once a second, for the recording as a whole'
      + (short ? ', and only ' + named.length + ' of the ' + total + ' are named here' : '')
      + '. Which step happened in which one is recorded nowhere, so this transcript does not say, and '
      + 'it cannot tell you when the work moved between them either.',
  };
}

function deriveDesktop(events, seen) {
  const state = newState();
  const parsed = events.map(deskEvent);
  const counts = {
    clicks: 0, scrolls: 0, drags: 0, keys: 0, pages: 0, unreadable: 0,
    // Of the clicks: how many named a place, and how many of those named the control as well.
    ctxClicks: 0, ctxNamed: 0,
    /* Typing, as time rather than as text: how long the runs lasted, how many there were, and how many
     * places moved the work without anything being clicked. */
    typedMs: 0, typeRuns: 0, focuses: 0,
  };
  const apps = new Set();
  const perStep = parsed.some((event) => event.readable && event.ctx);
  const opening = desktopWhere(seen.windows, seen.total, perStep);
  openSegment(state, opening.where, opening.note);

  const point = (event) => Math.round(event.x) + ',' + Math.round(event.y);

  /* The place in force, and a segment cut when it changes.
   *
   * Called just before a click is emitted rather than before its pause: the pause happened before
   * anything revealed the new place, so it belongs to the segment the reader was already in. That is the
   * same rule openSegment documents for a page change, and it keeps the segment clocks tiling. */
  let place = null;
  let placeName = null;
  let firstPlace = true;
  const enter = (ctx) => {
    if (!ctx) return;
    if (ctx.app) apps.add(ctx.app);
    const key = placeKey(ctx);
    if (key === place) return;

    /* Одно место, названное дважды.
     *
     * Клик по вкладке называет место её именем; через секунду заголовок окна догоняет и становится
     * «<вкладка> - Google Chrome», и без этой проверки открывался второй отрезок про то же самое. Chrome
     * собирает заголовок именно так, поэтому признак - совпадение по началу строки, в любую сторону: имя
     * вкладки короче заголовка, а после переключения бывает и наоборот. Сравнение строк, а не догадка о том,
     * что это браузер. */
    const named = ctx.window || ctx.app || '';
    if (placeName && named && (named.startsWith(placeName) || placeName.startsWith(named))) {
      /* Место то же, но КЛЮЧ обновляется - иначе следующий настоящий переход обратно на эту вкладку сравнится
       * с устаревшим ключом и отрезок не откроется. */
      place = key;
      if (named.length > placeName.length) placeName = named;
      return;
    }
    place = key;
    placeName = ctx.window || ctx.app || null;
    openSegment(state, ctxWhere(ctx), firstPlace
      ? 'Named by the clicks in it: the application and window under the pointer at the moment of each '
        + 'one, read from the accessibility tree. This is per step, unlike the sampled window list on '
        + 'the recording as a whole - and a step with no name below it is one the agent could not '
        + 'resolve, not one that happened nowhere.'
      : null);
    firstPlace = false;
  };

  let i = 0;
  while (i < parsed.length) {
    const event = parsed[i];
    takePause(state, i, event.delay);

    if (!event.readable) {
      counts.unreadable++;
      emit(state, {
        action: 'other',
        what: 'an event this transcript could not read',
        target: null,
        note: 'a .mmmacro line is index | X | Y | delayMs | action, and this entry does not carry a '
          + 'position and an action. It is reported rather than skipped - skipping it would hide a '
          + 'step.',
        own: 0,
        events: [i],
      });
      i++;
      continue;
    }

    if (event.kind === 'down') {
      /* A press, whatever happened while it was held, and the release. Movement in between belongs to
       * this gesture, so it does not also become a "moved the pointer" step - and whether the gesture
       * was a click or a drag is decided by where the release landed, which is the only thing that
       * separates them in a stream of coordinates. */
      const group = [i];
      let own = 0;
      let travel = 0;
      let lastX = event.x;
      let lastY = event.y;
      let moves = 0;
      let release = null;
      let j = i + 1;
      /* Moves, and focus markers, are both stepped over while looking for the release.
       *
       * The marker is the one that matters and it was not always here. A click that gives a window focus
       * makes the agent's foreground watcher fire while the button is still DOWN, so a `Focus` lands between
       * the press and the release - and pairing that stopped at the first non-move event read one click as an
       * unreleased press followed by an orphan release. Two wrong steps, and a story that apologised twice
       * for them.
       *
       * Stepping over it is also the right reading rather than only the convenient one: the click is what
       * gave that window focus, so the marker is a consequence of this gesture, not something that happened
       * during it - and where the click landed is already on the click's own context. Its index still joins
       * the group, so every event stays in exactly one step's `from`. */
      while (j < parsed.length && parsed[j].readable
        && (parsed[j].kind === 'move' || parsed[j].kind === 'focus')) {
        own += clampedPause(state, parsed[j].delay);
        if (parsed[j].kind === 'move') {
          travel += Math.hypot(parsed[j].x - lastX, parsed[j].y - lastY);
          lastX = parsed[j].x;
          lastY = parsed[j].y;
          moves++;
        }
        group.push(j);
        j++;
      }
      if (j < parsed.length && parsed[j].readable && parsed[j].kind === 'up'
        && parsed[j].button === event.button) {
        release = parsed[j];
        own += clampedPause(state, release.delay);
        travel += Math.hypot(release.x - lastX, release.y - lastY);
        group.push(j);
        j++;
      }

      if (!release) {
        enter(event.ctx);
        /* The moves stay with the press: they happened while the button was down, and calling them a
         * separate movement step would imply it was not. */
        emit(state, {
          action: 'other',
          what: actWords('pressed the ' + event.button + ' button', event.ctx, point(event)),
          target: point(event),
          note: 'no release was recorded for this press. The recording may have been stopped mid-click, '
            + 'or the release happened while a window the agent cannot see had focus.',
          own,
          events: group,
        });
        i = j;
        continue;
      }

      const straight = Math.hypot(release.x - event.x, release.y - event.y);
      if (straight >= DRAG_MIN_PX) {
        counts.drags++;
        enter(event.ctx);
        /* The context belongs to the press, so it says what was picked UP. Where it was dropped is not
         * resolved - the release is not hit-tested - so this never claims a destination it cannot see. */
        const grabbed = event.ctx && event.ctx.control
          ? 'the drag started on "' + event.ctx.control + '"'
            + (event.ctx.type && !CTX_VAGUE.has(event.ctx.type.toLowerCase()) ? ', a ' + event.ctx.type : '')
            + '; what it was dropped on is not recorded'
          : '';
        emit(state, {
          action: 'drag',
          ctx: event.ctx,
          px: Math.round(straight),
          what: 'dragged ' + pxText(straight) + ' from ' + point(event) + ' to ' + point(release)
            + ' over ' + spanText(own) + inApp(event.ctx),
          target: point(event) + ' to ' + point(release),
          note: [
            grabbed,
            travel > straight * 1.3 ? 'the pointer travelled ' + pxText(travel) + ' getting there' : '',
          ].filter(Boolean).join('; '),
          own,
          events: group,
        });
        i = j;
        continue;
      }

      const notes = [];
      const missing = ctxNote(event.ctx);
      if (missing) notes.push(missing);
      if (moves) notes.push('the pointer moved ' + pxText(travel) + ' while the button was down');
      if (own >= WAIT_MIN_MS) notes.push('held for ' + spanText(own));

      /* A tab click opens the segment it took you TO, not the one you were in. See isTabMove: the window
       * title is stale at this moment, and the accessibility type is not. */
      const tab = isTabMove(event.ctx);
      enter(tab ? tabPlace(event.ctx) : event.ctx);

      const verb = event.button === 'left' ? 'clicked' : event.button + '-clicked';
      const step = emit(state, {
        action: tab ? 'tab' : 'click',
        what: tab
          ? 'switched to the tab "' + event.ctx.control + '"' + inApp(event.ctx)
          : actWords(verb, event.ctx, point(event)),
        ctx: event.ctx,
        target: point(event),
        note: tab
          ? [
            'the window title still said "' + (event.ctx.window || 'something else') + '" at this moment - '
              + 'it follows the active tab and updates after the click, so the tab this landed on is what '
              + 'names the stretch below',
            ...notes,
          ].filter(Boolean).join('; ')
          : notes.join('; '),
        own,
        events: group,
      });
      /* Counted as a click, because it was one: the summary's number has to reconcile with the events. What
       * changes is how it READS, not whether it happened. */
      counts.clicks++;
      if (event.ctx) counts.ctxClicks++;
      if (event.ctx && event.ctx.control) counts.ctxNamed++;

      /* Two presses that close together in the same place are one double click as far as the
       * application receiving them is concerned - the same 400ms and 6px extension/content.js uses.
       * The desktop recorder cannot fold them itself because it has no idea what it is pointing at,
       * so they are folded HERE, into the step already emitted, rather than left as two lines that do
       * not say what actually happened. */
      /* Press to press, which is what content.js measures: the previous step's own duration - the
       * time its button was down - plus the pause before this one. A wait step between the two fails
       * the action test below, which is the right answer: a gap long enough for its own line is not a
       * double click. */
      const previous = state.steps[state.steps.length - 2];
      const apart = previous ? previous.own + step.pause : Infinity;
      /* A tab move is never half of a double click: two presses on the same tab are two switches, and
       * folding them would claim a gesture that did not happen. */
      if (!tab && previous && previous.action === 'click' && previous.segment === step.segment
        && previous.button === event.button && apart < DOUBLE_MS
        && Math.abs(event.x - previous.x) <= DOUBLE_PX
        && Math.abs(event.y - previous.y) <= DOUBLE_PX) {
        mergeDouble(state, previous, step, apart, event,
          actWords('double-clicked', event.ctx, point(event)));
        /* All THREE counters, or the summary contradicts itself in print.
         *
         * Two presses become one double-click, so the click count goes down - but the context counters were
         * incremented once per press and were left alone, and the sentence they feed says "for N of the M
         * clicks the agent also read what was under the pointer". With one double-click in a recording that
         * read "for 10 of the 9 clicks", which is the kind of arithmetic a reader notices immediately and
         * cannot unsee. The folded press had its own context, and it is the same context: one click, landing
         * on one thing. */
        counts.clicks--;
        if (event.ctx) counts.ctxClicks--;
        if (event.ctx && event.ctx.control) counts.ctxNamed--;
      } else {
        step.button = event.button;
        step.x = event.x;
        step.y = event.y;
      }
      i = j;
      continue;
    }

    if (event.kind === 'up') {
      emit(state, {
        action: 'other',
        what: actWords('released the ' + event.button + ' button', event.ctx, point(event)),
        target: point(event),
        note: 'no press was recorded before it, so this recording started part-way through a click',
        own: 0,
        events: [i],
      });
      i++;
      continue;
    }

    if (event.kind === 'move') {
      // A run of samples is one step. Ten seconds of movement must not read as six hundred lines.
      const group = [i];
      let own = 0;
      let travel = 0;
      let lastX = event.x;
      let lastY = event.y;
      let j = i + 1;
      while (j < parsed.length && parsed[j].readable && parsed[j].kind === 'move'
        && parsed[j].delay < MOVE_JOIN_MS) {
        own += clampedPause(state, parsed[j].delay);
        travel += Math.hypot(parsed[j].x - lastX, parsed[j].y - lastY);
        lastX = parsed[j].x;
        lastY = parsed[j].y;
        group.push(j);
        j++;
      }
      emit(state, {
        action: 'move',
        what: travel >= 1 ? 'moved the pointer ' + pxText(travel) : 'moved the pointer',
        target: point(event) + ' to ' + Math.round(lastX) + ',' + Math.round(lastY),
        note: group.length + ' samples. Motion between actions, kept so a replay walks the path a hand '
          + 'took rather than jumping. It is not itself an action.',
        own,
        events: group,
      });
      i = j;
      continue;
    }

    if (event.kind === 'scroll') {
      const group = [i];
      let own = 0;
      let j = i + 1;
      while (j < parsed.length && parsed[j].readable && parsed[j].kind === 'scroll'
        && parsed[j].direction === event.direction && parsed[j].delay < SCROLL_JOIN_MS) {
        own += clampedPause(state, parsed[j].delay);
        group.push(j);
        j++;
      }
      counts.scrolls += group.length;
      // One wheel event is one notch here: the hook records one message per detent.
      const notches = group.length > 1 ? ' ' + group.length + ' notches' : '';
      emit(state, {
        action: 'scroll',
        ctx: event.ctx,
        notches: group.length,
        direction: event.direction,
        what: (event.direction ? 'scrolled ' + event.direction : 'scrolled') + notches
          + inApp(event.ctx),
        target: point(event),
        note: event.direction ? '' : 'the recorded action was "' + event.action + '", which does not '
          + 'say which way the wheel turned',
        own,
        events: group,
      });
      i = j;
      continue;
    }

    /* A run of typing, as one step.
     *
     * One line per keystroke would bury a recording - a hundred and thirty of them for one email - and
     * would say nothing a reader wants, since no line can say which key. What is worth having is the
     * shape: how long, how many, and where. */
    /* A key that was named: one step, never folded into a run.
     *
     * Two presses of Return are two things that happened, and a reader wants both. It also carries where it
     * went - "pressed Enter into the Search box" - because a commit is only an instruction when it says
     * what it committed. */
    if (event.kind === 'press') {
      counts.keys += 1;
      enter(event.ctx);
      const into = event.ctx && event.ctx.control
        ? ' in the "' + event.ctx.control + '"'
          + (event.ctx.type && !CTX_VAGUE.has(event.ctx.type.toLowerCase()) ? ' ' + event.ctx.type : '')
        : '';
      emit(state, {
        action: 'press',
        ctx: event.ctx,
        keys: 1,
        pressed: event.pressed,
        what: 'pressed ' + (event.pressed || 'a key') + into + inApp(event.ctx),
        target: null,
        note: 'this key carries no text - Return, Tab, Escape and the arrows spell nothing, and a chord '
          + 'held with Command is an instruction to the application. Which is why it can be named at all, '
          + 'where the letters somebody typed cannot.',
        own: 0,
        events: [i],
      });
      i += 1;
      continue;
    }

    if (event.kind === 'key') {
      const group = [i];
      let own = 0;
      let keys = 1;
      let j = i + 1;
      while (j < parsed.length && parsed[j].readable && parsed[j].kind === 'key'
        && parsed[j].delay < TYPE_JOIN_MS) {
        own += clampedPause(state, parsed[j].delay);
        keys++;
        group.push(j);
        j++;
      }
      counts.keys += keys;
      counts.typedMs += own;
      counts.typeRuns++;
      enter(event.ctx);

      /* Where it went, when the resolver could read it: what had FOCUS, not what was under the pointer -
       * the pointer is wherever it was last left and has nothing to do with the typing. */
      const into = event.ctx && event.ctx.control
        ? ' into the "' + event.ctx.control + '"'
          + (event.ctx.type && !CTX_VAGUE.has(event.ctx.type.toLowerCase()) ? ' ' + event.ctx.type : '')
        : '';
      emit(state, {
        action: 'type',
        ctx: event.ctx,
        keys,
        what: (keys === 1 ? 'pressed a key' : 'typed for ' + spanText(own) + ' - ' + keys + ' keystrokes')
          + into + inApp(event.ctx),
        /* No coordinate. The event carries the last known pointer position because the five-column format
         * demands one, and reporting it here would invite somebody to read it as where the typing went. */
        target: null,
        note: 'which keys is not recorded, deliberately: the agent reads that a key was pressed and when, '
          + 'never which one, so nothing here can carry text - and a replay cannot reproduce it'
          + (keys > 1 && own >= 1000
            ? '. ' + keys + ' keystrokes over ' + spanText(own) + ' is about '
              + round1(keys / (own / 1000)) + ' a second, which includes any key held down'
            : ''),
        own,
        events: group,
      });
      i = j;
      continue;
    }

    /* The work moved. Not a step - it opens a segment and vanishes, its event carried onto whatever is
     * emitted next so the numbering still accounts for it. */
    if (event.kind === 'focus') {
      counts.focuses++;
      enter(event.ctx);
      state.carryEvents.push(i);
      i++;
      continue;
    }

    counts.unreadable++;
    emit(state, {
      action: 'other',
      what: 'did "' + event.action + '"',
      target: point(event),
      note: 'not one of the actions this agent records (movement, the three buttons, the wheel), so it '
        + 'came from an imported .mmmacro file. A replay may refuse it.',
      own: 0,
      events: [i],
    });
    i++;
  }

  return { state, counts, tabs: 0, apps: apps.size, perStep };
}

/* Two clicks becoming one double click. The step already emitted grows to cover both, which keeps
 * every event in exactly one step's `from` - the property removeSteps() depends on. */
function mergeDouble(state, previous, step, apart, event, words) {
  previous.action = 'dblclick';
  previous.what = oneLine(words, 300);
  previous.note = oneLine('two presses ' + Math.round(apart) + 'ms apart in the same place, recorded '
    + 'as two clicks - an application will read them as a double click'
    + (previous.note ? '; ' + previous.note : '') + (step.note ? '; ' + step.note : ''), NOTE_MAX);
  previous.ms += step.ms;
  previous.own += step.ms;
  previous.x = event.x;
  previous.y = event.y;
  previous.from.events = previous.from.events.concat(step.from.events);

  /* Drop the second step and close the numbering over the hole, so the numbers somebody is about to
   * quote back stay 1..n with nothing missing. A third press in the same place therefore starts a
   * fresh click rather than growing this one: `action` is no longer 'click', which is what the test
   * above requires. */
  state.steps.pop();
  if (state.current) state.current.steps.pop();
}

/* --------------------------------------------------------------------- telling the story
 *
 * The same derived steps, read as a sequence rather than as a list. Everything here is a thing that was
 * recorded: a control name appears because one was read, a duration because a clock ran. Where a name was
 * not read, the sentence says how many were not rather than leaving the count to the reader.
 *
 * What it deliberately does NOT do is name outcomes. "Clicked Send" is what happened; "sent the email" is
 * an outcome nothing in a recording can see - the click may have landed on a disabled button, the window
 * may have moved. One paragraph goes past the evidence to read the shape of it, and it is labelled.
 */

const STORY_CLAUSES = 9;

function joinWords(list, last) {
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  return list.slice(0, -1).join(', ') + ' ' + (last || 'and') + ' ' + list[list.length - 1];
}

const quoted = (name) => '"' + name + '"';

/* What UIA and AX call a thing, in the words a person would use.
 *
 * Only the containers are here - the things you click INSIDE rather than ON. A named control needs no
 * translation because its name carries it ("Send", "Inbox"); an unnamed one is only ever describable by what
 * kind of thing it was, and "pane" is a word out of somebody else's dictionary. */
const PLACE_NOUNS = {
  pane: 'the window',
  window: 'the window',
  client: 'the window',
  document: 'the page',
  main: 'the page',
  region: 'the page',
  group: 'the page',
  custom: 'a control with no name',
  list: 'a list',
  table: 'a table',
  tree: 'a tree',
  toolbar: 'the toolbar',
  'menu bar': 'the menu bar',
  'tool bar': 'the toolbar',
  'title bar': 'the title bar',
  'status bar': 'the status bar',
  'scroll bar': 'a scroll bar',
  canvas: 'the canvas',
  image: 'an image',
  'text': 'some text',
  'edit': 'a text box',
  'edit box': 'a text box',
  button: 'a button with no name',
  link: 'a link with no name',
};

/* An unnamed click, said with everything that IS known.
 *
 * Measured over the recordings this project has made: 70.8% of clicks carry a control name, and the rest
 * split three ways - an explorer pane (the Windows desktop or taskbar), a browser window with no control
 * under the pointer, and no context at all from an agent older than 0.7.0. Only the third of those is
 * genuinely unknown, and it was the only one the old sentence described.
 *
 * The place is not repeated: the segment this clause sits in is already titled by application and window, so
 * "clicked in the window" inside "Chrome - MouseFlow" says the useful half without saying it twice. */
/* WHAT the click landed on, when it has no name - or null when even that is unknown.
 *
 * Returned as a fragment rather than a sentence so the caller can put a count in front of it and the
 * coordinates behind it. The first version returned the whole sentence and produced "clicked at a point this
 * recording could not name at 1030,1053": the phrase already said where, so the coordinate said it twice. */
function unnamedWhat(ctx) {
  const type = ctx && ctx.type ? ctx.type.toLowerCase().trim() : '';

  /* An explorer pane with no name is the desktop or the taskbar - nothing else in that shell hit-tests to an
   * unnamed pane - and saying so is the difference between a step a reader can place and one they cannot. */
  if (type === 'pane' && ctx && ctx.app && /^explorer$/i.test(ctx.app)) {
    return 'on the desktop or the taskbar';
  }

  const noun = PLACE_NOUNS[type];
  if (noun) return (noun.startsWith('the ') ? 'in ' : 'on ') + noun;

  /* The unlocalised role, where the localised description gave nothing. An application that names none of
   * its controls still says which of them are buttons, and "on a button" is a step a reader can place. */
  const kind = roleWords(ctx);
  if (kind) return 'on ' + kind;

  /* An application was under the pointer and named nothing in itself: normal for Electron, a canvas, or a
   * window running as administrator. Different from knowing nothing at all, and worth the distinction. */
  if (ctx && ctx.app) return 'on something ' + ctx.app + ' did not name';
  return null;
}

/* The point, when there is nothing better to identify it by.
 *
 * This is the opposite of the complaint that started all of this. That one was "we show ONLY coordinates" - a
 * list of numbers standing in for meaning. A coordinate ADDED to what is known is the reverse: it is the
 * last thing said rather than the only thing, and it appears exactly where the alternative was "something".
 * Two unnamed clicks in different places are two different facts, and without the numbers they read as one. */
function atPoints(points) {
  const seen = [];
  for (const point of points) {
    if (point && !seen.includes(point)) seen.push(point);
  }
  if (!seen.length) return '';
  if (seen.length === 1) return ' at ' + seen[0];
  /* Four is where a list stops being readable. Past that the count carries it, and the first two say
   * whereabouts on the screen the work was. */
  if (seen.length <= 4) return ' at ' + joinWords(seen, 'and');
  return ' at ' + seen.slice(0, 2).join(', ') + ' and ' + (seen.length - 2) + ' other points';
}

/* A run of unnamed clicks, assembled from the parts that are known: how many, what it was, and where.
 *
 * Each part appears only if there is something to put in it, which is what keeps "clicked 6 times at
 * 1030,1053 and 5 other points" from becoming "clicked 6 times at a point this recording could not name at
 * 1030,1053 ...". */
function unnamedClicks(count, ctx, points) {
  const what = unnamedWhat(ctx);
  const where = atPoints(points || []);
  let said = 'clicked';
  // "twice" rather than "2 times": the number is only worth spelling out once it stops having a word.
  if (count === 2) said += ' twice';
  else if (count > 2) said += ' ' + count + ' times';
  if (what) said += ' ' + what;
  /* A comma before the coordinates when something already followed the verb, so the two facts do not run
   * together into one noun phrase. */
  if (where) said += (what ? ',' : '') + where;
  /* Neither a name, nor a kind, nor a coordinate. Only an agent older than the resolver produces this, and
   * saying nothing at all would read as a step that did nothing. */
  if (!what && !where) said += ' somewhere this recording could not name';
  return said;
}

/* One place's paragraph, walked in order. Consecutive clicks with names merge into one clause, because
 * "clicked New mail, then To, then Send" is the sentence a person would say and three clauses is not. */
function placeStory(segment) {
  const clauses = [];
  let namedRun = [];
  let unnamed = 0;
  /* The context of the unnamed run being counted, so the clause can say what KIND of thing it was. The first
   * one's, not the last: a run is only ever collapsed when the clicks are alike, and if they are not, the
   * first is the one the reader is already looking at. */
  let unnamedCtx = null;
  /* Where those clicks landed. Kept because a coordinate is the only thing that distinguishes one unnamed
   * click from another, and the run collapsing was throwing exactly that away. */
  let unnamedAt = [];
  let dropped = 0;

  const flushNamed = () => {
    if (namedRun.length) {
      clauses.push('clicked ' + joinWords(namedRun.map(quoted), 'then'));
      namedRun = [];
    }
    if (unnamed) {
      clauses.push(unnamedClicks(unnamed, unnamedCtx, unnamedAt));
      unnamed = 0;
      unnamedCtx = null;
      unnamedAt = [];
    }
  };

  for (const step of segment.steps) {
    if (clauses.length >= STORY_CLAUSES) { dropped++; continue; }

    /* В рассказе это переход, а не клик: «switched to this tab» рядом с заголовком отрезка, который этой
     * вкладкой и назван. Отдельной ветвью, потому что через namedRun он слился бы с обычными кликами и
     * прочитался бы как «clicked "Netflix"» - то самое, из-за чего это и переписывалось. */
    if (step.action === 'tab') {
      flushNamed();
      clauses.push('switched to this tab');
      continue;
    }

    if (step.action === 'click' || step.action === 'dblclick') {
      const name = step.ctx && step.ctx.control;
      if (name && step.action === 'click') { namedRun.push(name); continue; }
      if (step.action === 'dblclick') {
        flushNamed();
        clauses.push(name
          ? 'double-clicked ' + quoted(name)
          : 'double-clicked ' + unnamedClick(step.ctx).replace(/^clicked /, '')
            + atPoints([step.target]));
        continue;
      }
      /* Counted rather than written out, so five clicks on the same unnamed thing are one clause. The named
       * run is flushed first: "clicked Send, then clicked 3 more times in the page" keeps the order the
       * person worked in. */
      if (namedRun.length) flushNamed();
      if (!unnamed) unnamedCtx = step.ctx || null;
      unnamed++;
      if (step.target) unnamedAt.push(step.target);
      continue;
    }

    /* Movement and a short pause are dropped from the story entirely (`dropped++` below), so flushing the
     * click run on them broke a sentence on something the sentence does not mention - which is what turned
     * six clicks in a row into the same phrase six times. The run now spans them, exactly as a named run
     * spans the moves between "New", "To" and "Send". */
    if (step.action === 'move' || (step.action === 'wait' && step.own < 5_000)) {
      dropped++;
      continue;
    }

    flushNamed();

    if (step.action === 'type') {
      const into = step.ctx && step.ctx.control ? ' in ' + quoted(step.ctx.control) : '';
      clauses.push(step.keys > 1
        ? 'typed for ' + spanText(step.own) + into + ' - ' + step.keys + ' keystrokes'
        : 'pressed a key' + into);
    } else if (step.action === 'scroll') {
      clauses.push((step.direction ? 'scrolled ' + step.direction : 'scrolled')
        + (step.notches > 8 ? ' a long way' : ''));
    } else if (step.action === 'drag') {
      clauses.push('dragged something ' + pxText(step.px));
    } else if (step.action === 'wait') {
      /* Only the long ones reach here: a short wait is the rhythm of working and is dropped above, with the
       * moves, so that neither breaks a run of clicks in half. */
      clauses.push('stopped for ' + spanText(step.own));
    } else {
      /* Its own words, not an apology. These are the `other` steps - a press with no release, a release
       * with no press, an action from an imported file - and every one of them carries a sentence saying
       * exactly what it is. Replacing that with "did something this transcript could not read" was the
       * story telling a reader it knew less than the step list two inches below it. */
      const said = String(step.what || '').trim();
      clauses.push(said || 'did something this transcript could not read');
    }
  }
  flushNamed();

  /* Two identical clauses in a row become one. "Did X and then did X" is what a run of the same unreadable
   * thing produced, and it reads as a stutter rather than as a count. */
  for (let at = clauses.length - 1; at > 0; at--) {
    if (clauses[at] !== clauses[at - 1]) continue;
    let same = 1;
    while (at - same >= 0 && clauses[at - same] === clauses[at]) same++;
    clauses.splice(at - same + 1, same - 1);
    clauses[at - same + 1] = clauses[at - same + 1] + ' (' + same + ' times)';
    at = at - same + 1;
  }

  if (dropped > 0 && clauses.length >= STORY_CLAUSES) {
    clauses.push('and ' + dropped + ' more step' + (dropped === 1 ? '' : 's') + ' the list below has');
  }

  /* The proportions, which are the part a step list cannot show: an hour of clicking and an hour of
   * sitting still look the same in a list and read as completely different work. */
  const own = segment.steps.reduce((sum, step) => sum + step.ms, 0);
  const typed = segment.steps.reduce((sum, step) => sum + (step.action === 'type' ? step.own : 0), 0);
  const idle = segment.steps.reduce((sum, step) => sum + (step.action === 'wait' ? step.own : 0), 0);
  const shape = [];
  if (own > 4_000 && typed / own > 0.4) {
    shape.push('Most of the time here went on typing (' + spanText(typed) + ' of ' + spanText(own) + ')');
  }
  if (own > 8_000 && idle / own > 0.5) {
    shape.push('More than half of it was nobody touching anything - reading, or waiting for something '
      + 'to finish');
  }

  /* «Ничего не произошло» и «двигали мышь, не нажимая» - разные факты. Отрезок попадает сюда потому, что шаги
   * в нём ЕСТЬ; если все они оказались движением или ожиданием, сказать надо это, а не первое. */
  const nothing = dropped > 0
    ? 'Only pointer movement and pauses here — nothing was clicked or typed.'
    : 'Nothing happened here.';

  return (clauses.length ? capitalise(joinWords(clauses, 'and then')) + '.' : nothing)
    + (shape.length ? ' ' + shape.join('. ') + '.' : '');
}

const capitalise = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

function tellStory(segments, counts, totalMs, source) {
  /* No steps, no story. An empty recording used to get an opening line about running 0.0s in a place it
   * could not name, which is a paragraph about nothing - and `summary.captured` already says what happened
   * in one sentence. */
  if (!segments.length) return [];
  const story = [];
  const places = segments.filter((segment) => segment.where && segment.where.kind === 'app'
    || (segment.where && segment.where.kind === 'page'));
  const named = places.map((segment) => segment.where.label).filter(Boolean);

  /* --------------------------------------------------------------- the overview */
  let opening = 'This recording runs ' + spanText(totalMs) + '.';
  const distinct = named.filter((label, i) => named.indexOf(label) === i);
  if (distinct.length > 1) {
    /* Stretches and places are counted separately on purpose: going Outlook, Excel, Outlook is three
     * stretches in two places, and calling it three places would be wrong while calling it two would lose
     * that the work came back. */
    opening += ' The work moves through ' + distinct.length + ' place'
      + (distinct.length === 1 ? '' : 's')
      + (named.length > distinct.length ? ' over ' + named.length + ' stretches' : '')
      + ', starting in ' + named[0] + ' and ending in ' + named[named.length - 1] + '.';
  } else if (distinct.length === 1) {
    opening += ' All of it happened in ' + distinct[0] + '.';
  } else {
    opening += ' Nothing in it names where it happened, so the story below is what was done rather than '
      + 'where.';
  }
  story.push({ kind: 'overview', title: null, text: oneLine(opening, 400) });

  /* --------------------------------------------------------------- one paragraph per place */
  for (const segment of segments) {
    const seconds = segment.steps.reduce((sum, step) => sum + step.ms, 0);
    story.push({
      kind: 'place',
      title: oneLine((segment.where && segment.where.label) || 'Somewhere this recording does not name', 120),
      // Where it sits on the clock, so a paragraph can be found in the step list underneath it.
      at: Math.round(segment.startMs),
      seconds: secondsOf(seconds),
      detail: oneLine((segment.where && segment.where.detail) || '', 120) || null,
      text: oneLine(placeStory(segment), 700),
    });
  }

  /* --------------------------------------------------------------- the reading
   *
   * The one paragraph that says more than was recorded, which is why it says that it is doing so. Built
   * from measured proportions, not from a guess about intent: what the numbers cannot support does not
   * get written. */
  const typedMs = counts.typedMs || 0;
  const bits = [];
  if (typedMs > 0 && totalMs > 0) {
    const share = Math.round((typedMs / totalMs) * 100);
    bits.push(spanText(typedMs) + ' of it - about ' + share + '% - went on typing, in '
      + counts.typeRuns + ' run' + (counts.typeRuns === 1 ? '' : 's'));
  }
  if (counts.clicks > 0) {
    bits.push(counts.clicks + ' click' + (counts.clicks === 1 ? '' : 's')
      + (counts.ctxNamed > 0 ? ', ' + counts.ctxNamed + ' of them on something with a name' : ''));
  }
  if (counts.scrolls > 0) bits.push(counts.scrolls + ' wheel notch' + (counts.scrolls === 1 ? '' : 'es'));
  if (counts.drags > 0) bits.push(counts.drags + ' drag' + (counts.drags === 1 ? '' : 's'));

  if (bits.length) {
    /* Semicolons, not commas. Several of these bits contain a comma of their own - "5 clicks, 4 of them on
     * something with a name" - and joining those with commas produces one flat list of things that are not
     * peers. */
    let reading = bits.join('; ') + '.';
    /* What the shape suggests, in the terms the measurements support and no further. A recording that is
     * mostly typing and mostly named clicks is somebody working; one that is mostly pauses is somebody
     * reading; and a transcript that confidently said which without saying why would be believed. */
    /* Decided on the share of the recording spent waiting, not on a count of clicks. A count cannot be
     * compared across lengths - four clicks in ten seconds is busy and four in ten minutes is not - and
     * judging a short recording quiet because it had few clicks in it was exactly the wrong answer. */
    const idleMs = segments.reduce((sum, segment) => sum + segment.steps
      .reduce((inner, step) => inner + (step.action === 'wait' ? step.own : 0), 0), 0);
    const idle = idleMs / Math.max(1, totalMs);
    reading += idle < 0.4
      ? ' Steady input almost throughout, which is the shape of work being done rather than a screen being '
        + 'watched.'
      : ' ' + Math.round(idle * 100) + '% of the time nothing was touched at all, which is the shape of '
        + 'reading or waiting rather than working - or of something happening in a window the recorder '
        + 'cannot see into.';
    story.push({
      kind: 'reading',
      title: 'Reading it',
      text: oneLine(capitalise(reading), 600),
    });
  }

  return story;
}

/* ------------------------------------------------------------------- the transcript */

export function transcribe(flow) {
  const row = flow && typeof flow === 'object' ? flow : {};
  /* Two different failures, and they get different words: a payload that is not an object at all
   * (a caller handed over something unreadable) and one that is an object with no events list in it
   * (a client wrote a flow that way). Saying "no events" for the first sends whoever reads it looking
   * in the wrong place. */
  const parsedPayload = payloadOf(row.payload);
  const unreadablePayload = row.payload != null && parsedPayload === null;
  const payload = parsedPayload || {};
  const kind = row.kind === 'created' ? 'created' : 'recorded';
  const events = eventsOf(payload);
  const source = sourceOf(row, payload, events);
  const seenWindows = windowsOf(payload);
  const windows = seenWindows.windows;
  const recorder = recorderOf(payload);

  const head = {
    id: oneLine(row.client_id != null ? row.client_id
      : row.clientId != null ? row.clientId
        : row.id != null ? row.id : payload.id, 80) || null,
    name: oneLine(row.name || payload.name, 120) || 'Untitled recording',
    kind,
    source,
    created: isoOf(row.created_at != null ? row.created_at
      : row.created != null ? row.created : payload.created),
    origins: originsOf(row, payload),
    windows,
  };

  /* A created skill is not a recording and must not be transcribed as one. It holds a goal the agent
   * re-runs; the steps kept beside it are evidence of what one successful run did, not events. */
  if (kind === 'created') {
    return {
      flow: head,
      /* A created skill has no story because it has no sequence: it holds a goal, and the run beside it is
       * evidence rather than steps. Empty rather than absent, so nothing has to test for the field. */
      story: [],
      summary: emptySummary(
        'Nothing: this is a created skill, not a recording. It holds a goal the agent re-runs and, '
        + 'beside it, what one successful run did - as evidence, not as steps to replay. There are no '
        + 'recorded events here.', 1),
      segments: [],
      gaps: [{
        question: 'What does this skill actually do?',
        why: 'Its goal is in payload.goalTemplate and the values it takes are in payload.params; its '
          + 'runs are in user_run. None of that is a recording of input, so there is no transcript of '
          + 'it: the agent decides its own steps each time it runs, and they differ between runs.',
      }],
    };
  }

  if (events === null) {
    // Said once, in one voice, and used in both places, so the summary and the gap cannot disagree.
    const trouble = unreadablePayload
      ? 'the stored payload is a ' + typeof row.payload + ' this cannot parse'
      : payload.events === undefined
        ? 'the payload has no events list in it'
        : 'payload.events is a ' + typeof payload.events + ', not a list';
    return {
      flow: head,
      story: [],
      summary: emptySummary(
        'Nothing: ' + trouble + ', so there is nothing to transcribe.', 2),
      segments: [],
      gaps: [
        {
          question: 'What was in this recording?',
          why: 'Not knowable from this row. user_flow.payload is written by the client and nothing '
            + 'validates its inner shape on the way in (api/sync.js stores it as sent), so a flow can '
            + 'arrive with its events missing or not a list. Here, ' + trouble + '. The machine that '
            + 'made it may still hold the original.',
        },
        {
          question: 'Did the recording achieve anything?',
          why: 'A recording holds input, not outcome. Nothing stored here says whether anything on the '
            + 'screen did what was wanted; replaying it is the only way to find out.',
        },
      ],
    };
  }

  const derived = source === 'desktop' ? deriveDesktop(events, seenWindows) : deriveWeb(events);
  const state = derived.state;
  const counts = derived.counts;
  const totalMs = Math.round(state.at);

  const segments = state.segments
    // A segment with no steps in it is a page that was named and then left; the step that named it is
    // in the segment it opened, so an empty one carries nothing a reader could use.
    .filter((segment) => segment.steps.length > 0)
    .map((segment) => ({
      n: segment.n,
      where: segment.where,
      startMs: segment.startMs,
      seconds: secondsOf(segment.steps.reduce((sum, step) => sum + step.ms, 0)),
      steps: segment.steps.map(publicStep),
      note: segment.note,
    }));

  const perStep = source === 'desktop' && !!derived.perStep;
  const captured = source === 'desktop'
    ? (perStep
      ? 'Every click, drag, scroll and pointer movement, as screen coordinates. For '
        + counts.ctxClicks + ' of the ' + counts.clicks + ' click'
        + (counts.clicks === 1 ? '' : 's') + ' the agent also read what was under the pointer - the '
        + 'application, the window, and for ' + counts.ctxNamed + ' of them the name and kind of the '
        + 'control - so those steps say where they happened rather than only where they landed. '
        + (counts.keys > 0
          ? counts.keys + ' keystroke' + (counts.keys === 1 ? '' : 's') + ' over '
            + spanText(counts.typedMs) + ', counted and timed but never read: which key was pressed is '
            + 'not recorded anywhere, so this carries no text. '
          /* Three different sentences, because "no typing" has three different meanings and only the
           * recorder's own answer separates them. Saying the first one unconditionally was a claim this
           * file had no way to support. */
          : recorder.canKeys === true
            ? 'No typing happened: this agent watches the keyboard - it records that a key was pressed '
              + 'and when - and no key was pressed. '
            : recorder.canKeys === false
              ? 'Typing is MISSING rather than absent: this agent could not install its keyboard hook, so '
                + 'any time spent typing is in here as a pause. '
              : 'No typing was captured, and whether that means none happened cannot be told from this '
                + 'recording: it does not say whether the agent was watching the keyboard. ')
        + 'No screenshots.'
      : 'Mouse only, as screen coordinates: every click, drag, scroll and pointer movement, with the '
        + 'windows this recording saw in front but not which step was in which. No element names at '
        + 'all, which means this was recorded by an agent older than 0.6.0 - a current one reads the '
        + 'application and control under each click. Nothing typed, no screenshots.')
    : 'Mouse only: every click, scroll and pointer path in the tab being watched, the page each '
      + 'happened on, and the visible text of what was clicked. Nothing typed, no other page text, '
      + 'no screenshots.';

  const gaps = gapsFor({
    source,
    events: events.length,
    counts,
    totalMs,
    droppedMs: state.droppedMs,
    droppedPauses: state.droppedPauses,
    windows,
    // The true number of distinct titles, which is what the prose has to quote: `windows` is capped.
    windowTotal: seenWindows.total,
    tabs: derived.tabs,
    perStep,
    recorder,
    empty: events.length === 0,
  });

  const story = tellStory(
    state.segments.filter((segment) => segment.steps.length > 0),
    counts,
    totalMs,
    source,
  );

  return {
    flow: head,
    story,
    summary: {
      // The raw event count, so this reconciles with the "142 events" the recorder itself reported.
      events: events.length,
      /* One per click STEP, so a double click counts once - it was one gesture, and counting it twice
       * would make these numbers disagree with the steps a reader can see below. */
      clicks: counts.clicks,
      // Scrolls are counted per EVENT, because a collapsed run says "scrolled down 3 times" in words.
      scrolls: counts.scrolls,
      drags: counts.drags,
      /* Keystrokes, not typing steps: a run of a hundred and thirty is one step and a hundred and
       * thirty keys, and the number a reader wants beside "typed for 47s" is the second one. */
      keys: counts.keys,
      // How much of the recording went on typing, which is the question this was added to answer.
      typedSeconds: secondsOf(counts.typedMs || 0),
      seconds: secondsOf(totalMs),
      /* Which half fills which, and nought rather than one for the other: a browser recording knows
       * pages and nothing about applications, a desktop recording knows applications and nothing
       * about pages. Reporting "1 application" for a browser recording would be this file inventing
       * the browser as a datum the payload does not carry.
       *
       * On the desktop side this is the number of distinct front-window TITLES sampled, which is all
       * payload.windows holds - two documents open in one program are two of these. Said out loud in
       * the "Which application was each step in?" gap, because the word here cannot say it. Not the
       * length of `flow.windows`, which is capped at 24 for readability and used to make this
       * under-report a recording that moved between more windows than that. */
      applications: source === 'desktop'
        ? (derived.apps > 0 ? derived.apps : seenWindows.total)
        : 0,
      pages: source === 'desktop' ? 0 : counts.pages,
      captured: events.length === 0
        ? 'Nothing: payload.events is an empty list, so this recording has no steps in it.'
        : captured,
      // How many questions below this transcript cannot answer. `captured` and this are a pair.
      gaps: gaps.length,
    },
    segments,
    gaps,
  };
}

// The contract's shape, and only it: `segment`, `from` and the desktop double-click bookkeeping are
// this file's own working state and mean nothing to a reader.
/* `ctx` stays stripped - all three of its parts are already in `what` as prose, and a reader does not need
 * them twice. What IS sent is the three fields a MACHINE needs and cannot get from a sentence: which control
 * the typing went into, what KIND of thing that control is, and how many keystrokes. The skill wizard asks "you typed into Subject - what should
 * the skill put there?", and the alternative was parsing that name back out of the prose, which is exactly
 * the mistake the note above warns about: it would break the first time the sentence was reworded.
 *
 * Null on every step that is not typing, and null on typing whose control the resolver could not read -
 * absent means "not known", not "there was no field". */
function publicStep(step) {
  const ctx = step.ctx || null;
  return {
    n: step.n,
    at: step.at,
    ms: step.ms,
    action: step.action,
    what: step.what,
    target: step.target,
    note: step.note,
    control: ctx && ctx.control ? ctx.control : null,
    controlType: ctx && ctx.type ? ctx.type : null,
    /* Carried out to the client, because the wizard turns it into an instruction - "press Enter" - and a
     * step that lost its name here becomes undescribable for a reason nothing on screen could explain. */
    pressed: step.pressed || null,
    /* The UNLOCALISED role, which is the only one of the three a machine can reason about: `type` is what
     * the platform calls the thing in the user's own language, and this account alone has produced Russian
     * and Ukrainian for it. api/_typing.mjs classifies a typing run on this and falls back to guessing when
     * it is absent - which it is on Windows, whose agent does not write one. */
    role: ctx && ctx.role ? ctx.role : null,
    keys: step.action === 'type' ? step.keys || 0 : 0,
  };
}

function emptySummary(captured, gaps) {
  return {
    events: 0,
    clicks: 0,
    scrolls: 0,
    drags: 0,
    keys: 0,
    typedSeconds: 0,
    seconds: 0,
    applications: 0,
    pages: 0,
    captured,
    gaps,
  };
}

/* ---------------------------------------------------------------------------- the gaps
 *
 * First-class, not a footnote, and for the reason api/insights.js keeps its own: every one of these is
 * a question somebody will ask of a transcript, and the answer is that the recording does not hold it.
 * Each carries the real count from THIS recording wherever there is one, so a gap that has stopped
 * applying shows a nought instead of being a warning nobody rereads.
 */
function gapsFor(context) {
  const gaps = [];
  const desktop = context.source === 'desktop';
  const minutes = round1(context.droppedMs / 60_000);

  if (context.empty) {
    gaps.push({
      question: 'Why is this recording empty?',
      why: 'payload.events is a list with nothing in it. Both recorders save nothing when they '
        + 'captured nothing, so an empty one either arrived from an older build - or every step of it '
        + 'was removed from this transcript, which rewrites this same payload.',
    });
  }

  gaps.push({
    question: 'What did I type?',
    why: 'No text, on either half, by design - and on the desktop side that is now a different sentence '
      + 'from "no typing". '
      + (desktop
        ? 'The agent hooks the keyboard to learn THAT a key was pressed and when; the callback reads one '
          + 'flag off the hook struct to tell an injected key from a person\'s and never touches vkCode, '
          + 'which is how the promise is kept by the code not existing rather than by a policy. '
          + (context.counts.keys > 0
            ? 'This recording spent ' + spanText(context.counts.typedMs) + ' on '
              + context.counts.keys + ' keystroke' + (context.counts.keys === 1 ? '' : 's') + ' across '
              + context.counts.typeRuns + ' run' + (context.counts.typeRuns === 1 ? '' : 's')
              + ', and which field each run went into is above where the accessibility tree could name '
              + 'it. What was written is nowhere.'
            /* The same three cases as `captured`, and they have to agree with it: this gap and that
             * sentence used to say different things about the same recording two inches apart. */
            : context.recorder.canKeys === true
              ? 'Nothing was typed during this one, and that is a finding rather than a silence: the '
                + 'agent reported it was watching the keyboard when this was recorded.'
              : context.recorder.canKeys === false
                ? 'The agent could not install its keyboard hook when this was recorded, so time spent '
                  + 'typing is in here as a pause and no count of it exists.'
                : 'Nothing was typed during this one - or it was recorded by an agent that hooked the '
                  + 'mouse only, which is every build before 0.7.0. This recording does not say which, '
                  + 'because it was made before the agent started reporting what it could do.')
        : 'extension/content.js stopped capturing text because framework-controlled fields and editors '
          + 'inside iframes dropped it silently, and a recording that quietly loses half a message is '
          + 'worse than one that never claimed to carry it. '
          + (context.counts.keys > 0
            ? 'The ' + context.counts.keys + ' typing step' + (context.counts.keys === 1 ? '' : 's')
              + ' below came from an older build or an imported file; this counts their characters '
              + 'rather than printing them.'
            : 'There are no typing steps in this one.')),
  });

  /* Only when it applies, and it is the one thing a person is most likely to assume wrongly: everything
   * else in a desktop recording replays exactly, so a recording with typing in it looks like it would
   * too. */
  if (desktop && context.counts.keys > 0) {
    gaps.push({
      question: 'Can this be replayed exactly?',
      why: 'No. The ' + context.counts.typeRuns + ' typing run'
        + (context.counts.typeRuns === 1 ? '' : 's') + ' cannot be reproduced - a replay knows a key was '
        + 'pressed and not which - so it waits out the ' + spanText(context.counts.typedMs)
        + ' and presses nothing, then carries on with the clicks. The agent counts what it skipped and '
        + '/replay/status reports it, so a replay does not come back looking clean. Work that has to type '
        + 'belongs in a created skill, which is told what to write.',
    });
  }

  if (desktop && context.perStep) {
    /* The two desktop gaps this used to open with are answered now, so they are replaced rather than
     * kept: a gap list that still says "not recorded" about something printed on every step below is
     * how a reader learns to stop reading the gaps. What is left is what is genuinely still missing. */
    const unnamed = context.counts.ctxClicks - context.counts.ctxNamed;
    const unresolved = context.counts.clicks - context.counts.ctxClicks;
    gaps.push({
      question: 'Which application was each step in?',
      why: 'Answered for the clicks, and only for the clicks. Each one is hit-tested at the moment it '
        + 'happens, so the segments above are named by the work; ' + context.counts.ctxClicks + ' of '
        + context.counts.clicks + ' carried an answer'
        + (unresolved > 0 ? ' and ' + unresolved + ' did not' : '')
        + '. A pointer move, a scroll and a wait are placed in whichever segment was open, because '
        + 'nothing hit-tests them - so a switch between two applications that involved no click is '
        + 'invisible here.',
    });
    if (unnamed > 0 || unresolved > 0) {
      gaps.push({
        question: 'Why do some steps still show only coordinates?',
        why: (unnamed > 0
          ? unnamed + ' click' + (unnamed === 1 ? '' : 's') + ' named an application but no control: '
            + 'the thing under the pointer had no accessible name. Electron applications expose almost '
            + 'nothing, a canvas or a game exposes nothing at all, and a window running as '
            + 'administrator is invisible to a normal-integrity agent. '
          : '')
          + (unresolved > 0
            ? unresolved + ' click' + (unresolved === 1 ? '' : 's') + ' named nothing at all, which is '
              + 'either that same invisibility or the resolver falling behind - it runs off the input '
              + 'path on purpose, because a mouse hook that takes too long is removed by Windows '
              + 'without warning, and when its queue fills it drops the context rather than the event.'
            : ''),
      });
    }
    gaps.push({
      question: 'Is anything missing from this recording?',
      why: 'Possibly, and nothing here can tell. A normal-integrity agent cannot see input while an '
        + 'ELEVATED window has focus - UIPI applies to the mouse hook as well as to SendInput - so a '
        + 'recording made over an application running as administrator is silently incomplete: the '
        + 'events never arrive and nothing is left where they should have been. If a stretch below '
        + 'reads as though a step is missing, check that first (README, "Integrity levels cut both '
        + 'ways").',
    });
    gaps.push({
      question: 'What did the click actually do?',
      why: 'Not recorded. The name under the pointer says what was aimed at, not what happened next: '
        + 'nothing re-reads the screen afterwards, so a click on a disabled button reads exactly like '
        + 'one that worked, and a control that moved between recording and replay is aimed at by '
        + 'coordinates regardless of its name.',
    });
  } else if (desktop) {
    gaps.push({
      question: 'Which application was each step in?',
      why: 'Not recorded. A .mmmacro line is index | X | Y | delayMs | action, with no window in it; '
        + 'the front window is sampled once a second for the recording as a whole and kept in '
        + 'first-touched order. This one names '
        + (context.windowTotal === 0 ? 'none at all'
          : context.windowTotal === 1 ? 'exactly one, which is why every step is placed in it - though '
            + 'a window that held focus for less than a second between two samples would not be in '
            + 'the list to argue with it'
            : context.windowTotal + ', so no step below is placed in any of them') + '. What is counted '
        + 'is window TITLES: two documents open in one program are two of these, and the same window '
        + 'renamed as its document changed is two as well. An agent from 0.6.0 onwards resolves this '
        + 'per click instead; this recording was made by an older one, so re-recording it would answer '
        + 'the question.',
    });
    gaps.push({
      question: 'Is anything missing from this recording?',
      why: 'Possibly, and nothing here can tell. A normal-integrity agent cannot see input while an '
        + 'ELEVATED window has focus - UIPI applies to the mouse hook as well as to SendInput - so a '
        + 'recording made over an application running as administrator is silently incomplete: the '
        + 'events never arrive and nothing is left where they should have been. If a stretch below '
        + 'reads as though a step is missing, check that first (README, "Integrity levels cut both '
        + 'ways").',
    });
    gaps.push({
      question: 'What did I click on?',
      why: 'A screen position, and nothing else. There is no element, no selector and no text per '
        + 'event, so "clicked at 940,520" is the whole truth - and it stops being true the moment a '
        + 'window moves or the display scale changes.',
    });
  } else {
    gaps.push({
      question: 'What was on the page?',
      why: 'Only the visible text of the element that was clicked, capped at 80 characters, and the '
        + 'url of the page in force. There is no screenshot, no other page text and no record of what '
        + 'changed after a click - so a step that silently did nothing reads exactly like one that '
        + 'worked.',
    });
    gaps.push({
      question: 'Did I drag anything?',
      why: 'Cannot be told from a browser recording. A press is recorded as a click and the motion '
        + 'after it as a separate path, so a drag and a click-then-move look identical. This '
        + 'transcript therefore never claims a drag on a web recording; every drag it names came from '
        + 'a desktop one.',
    });
    gaps.push({
      question: 'Did anything happen in a tab I cannot see here?',
      why: 'Only the tab in front is captured - a background tab can still fire script-driven events, '
        + 'which would land out of order - and browser pages (chrome://, the Web Store, a PDF viewer) '
        + 'are skipped entirely, because an extension is not allowed to run in them. '
        /* "This recording spans 0 tabs" is what this used to say for a payload whose events carry no
         * `tab` key at all - an import, or a build older than cross-tab recording. Nought tabs is not
         * a fact about the recording, it is the absence of one. */
        + (context.tabs === 0
          ? 'How many tabs this one spans is not in the payload: background.js tags every event with '
            + 'the tab it came from, so a recording without those tags was imported or made by an '
            + 'older build.'
          : 'This recording spans ' + context.tabs + ' tab' + (context.tabs === 1 ? '' : 's') + '.')
        + ' Work done anywhere else is absent, and nothing marks the hole.',
    });
  }

  gaps.push({
    question: 'What happened during the long pauses?',
    why: context.droppedPauses === 0
      ? 'No pause in this recording ran past two minutes, so nothing was left out of its duration. '
        + 'Anything longer would be: being away from the machine is not time spent working, and '
        + 'api/insights.js drops it from its totals for the same reason.'
      : context.droppedPauses + ' pause' + (context.droppedPauses === 1 ? '' : 's')
        + ' ran past two minutes. ' + minutes + ' minutes past that limit '
        + (context.droppedPauses === 1 ? 'is' : 'are') + ' left out of every duration here and shown '
        + 'in place as "away from the machine" - but what was happening is not recorded. It could '
        + 'have been reading, or another application entirely.',
  });

  if (context.totalMs >= THIN_MIN_MS) {
    const perMinute = round1(context.events / (context.totalMs / 60_000));
    if (perMinute < THIN_PER_MINUTE) {
      gaps.push({
        question: 'Is this the whole recording?',
        why: context.events + ' events over ' + spanText(context.totalMs) + ' is about ' + perMinute
          + ' a minute, which is sparse. That is what reading or waiting looks like - and also what '
          + (desktop
            ? 'an elevated window looks like, because the hook sees nothing while one has focus.'
            : 'a page the extension is not allowed into looks like, because nothing is captured there.'),
      });
    }
  }

  if (context.counts.unreadable > 0) {
    gaps.push({
      question: 'What are the unreadable steps?',
      why: context.counts.unreadable + ' event' + (context.counts.unreadable === 1 ? '' : 's')
        + ' in this payload are not in a shape this transcript recognises. They are listed in place '
        + 'rather than dropped, because a hidden step is worse than an unexplained one, but what they '
        + 'were meant to do is not recoverable from here. A replay will most likely refuse them.',
    });
  }

  gaps.push({
    question: 'Did the recording achieve anything?',
    why: 'A recording holds input, not outcome. Nothing stored says whether a click landed on the '
      + 'thing it was aimed at, whether the application accepted it, or whether the work finished. '
      + 'Replaying it is the only way to find out, and a replay is recorded as a run in user_run.',
  });

  return gaps;
}

/* --------------------------------------------------------------------------- editing
 *
 * "Remove those steps", in the transcript's own numbering.
 *
 * The numbers a person quotes are the numbers this file printed, which are not event indices: a step
 * can be forty motion samples, a run of scroll notches, or a press-move-release triple, and a `wait`
 * is not an event at all - it is the pause stored on the event that follows it. So the transcript is
 * re-derived here (it is deterministic, which is what makes that sound) and each step's `from` says
 * exactly which events it was made of.
 *
 * It REFUSES rather than guesses. A number that does not resolve to a step throws and nothing is
 * changed, because removing the wrong step of somebody's recording quietly is worse than removing
 * nothing. The caller keeps the old payload for undo; this returns a new object and never mutates the
 * one it was given.
 *
 * `source` is optional and should be passed when the caller has the row: api/sync.js keeps `source`
 * in a column precisely because guessing it from a payload is unreliable. Without it, sourceOf()
 * guesses - which is why the signature accepts it at all.
 */
export function removeSteps(payload, stepNumbers, source) {
  const body = payloadOf(payload);
  const events = eventsOf(body);
  if (!body || events === null) {
    throw new Error('this recording cannot be edited: its payload has no list of events in it');
  }

  const wanted = [];
  for (const raw of Array.isArray(stepNumbers) ? stepNumbers : []) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error('"' + String(raw) + '" is not a step number. Nothing was changed.');
    }
    if (!wanted.includes(n)) wanted.push(n);
  }
  if (!wanted.length) throw new Error('no step numbers were given, so nothing was removed');

  const kindOf = source === 'desktop' || source === 'web' ? source : sourceOf(null, body, events);
  const before = kindOf === 'desktop' ? deriveDesktop(events, windowsOf(body)) : deriveWeb(events);
  const byNumber = new Map(before.state.steps.map((step) => [step.n, step]));

  const missing = wanted.filter((n) => !byNumber.has(n));
  if (missing.length) {
    throw new Error('this recording has no step ' + missing.join(', ') + ' - it has '
      + (before.state.steps.length ? 'steps 1 to ' + before.state.steps.length : 'no steps')
      + '. Nothing was changed.');
  }

  const drop = new Set();
  const zero = new Set();
  for (const n of wanted) {
    const step = byNumber.get(n);
    for (const index of step.from.events) drop.add(index);
    /* A `wait` owns no event: removing it means the pause stored on the event that FOLLOWED it goes,
     * not that event. Removing a step that does own events takes their pauses with them, which is
     * what "remove this step" means for something about to be replayed. */
    if (step.from.zeroDelay != null) zero.add(step.from.zeroDelay);
  }

  const kept = [];
  for (let i = 0; i < events.length; i++) {
    if (drop.has(i)) continue;
    const event = events[i];
    kept.push(zero.has(i) ? withoutDelay(event) : event);
  }

  /* Both recorders write nought for the first event's delay, so a recording whose opening events were
   * removed must not keep the gap that used to lead up to what is left: it was never a pause BETWEEN
   * two surviving steps, and a replay would sit there waiting it out. */
  if (kept.length && drop.has(0)) kept[0] = withoutDelay(kept[0]);

  const after = kindOf === 'desktop' ? deriveDesktop(kept, windowsOf(body)) : deriveWeb(kept);

  return {
    /* A new payload, and everything else in it left exactly as it was. payload.windows and
     * payload.origins describe the recording as a whole, and this cannot know that removing a step
     * stopped an application from being touched - so it does not pretend to. */
    payload: Object.assign({}, body, { events: kept }),
    // Both counted in TRANSCRIPT steps, which is the unit the request was made in.
    removed: wanted.length,
    remaining: after.state.steps.length,
  };
}

/* Whichever spelling the event actually carries, because writing the other one would add a key the
 * recorders never write and leave the real pause in place. */
function withoutDelay(event) {
  if (!event || typeof event !== 'object') return event;
  const copy = Object.assign({}, event);
  if ('delayMs' in copy) copy.delayMs = 0;
  if ('delay' in copy) copy.delay = 0;
  return copy;
}
