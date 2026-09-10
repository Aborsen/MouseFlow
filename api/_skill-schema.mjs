/* A skill, as a tool definition. The one derivation, and now it lives where BOTH ends can reach it.
 *
 * A skill on an account is already the same thing as a tool call: a named, described unit of work with the
 * variable parts pulled out of it. `extension/skills.js` does that pulling - `parameterise()` lifts the
 * addresses, URLs and quoted phrases out of the goal somebody typed and leaves a template with
 * `{{recipient}}` in it. This is the last step: saying so in the shape the APIs expect.
 *
 * WHY THIS FILE IS IN api/ AND NOT IN web/src/lib. It used to be `web/src/lib/skill-schema.ts`, read only by
 * the Skills panel. Three things read it now - that panel, the local MCP server, and /api/mcp, which serves
 * these definitions to a client that may be a phone - and a serverless function cannot import out of the web
 * app's source tree with any confidence about what the bundler traces. Beside the API it is bundled for
 * certain, the MCP server imports it as plain JavaScript with nothing to strip, and the web app reaches it
 * through a one-line shim that keeps its TypeScript types. Three readers, one answer. A copy per reader is
 * the thing this arrangement exists to prevent: the first time one changed, a model would be told about a
 * product that no longer exists.
 *
 * Three wire formats, and the differences between them are real rather than cosmetic:
 *
 *   anthropic  { name, description, input_schema }        Messages API
 *   openai     { type: 'function', name, description, parameters }
 *                                                         Responses API - flat, not nested under
 *                                                         `function`, which is what api/_provider.js sends
 *   mcp        { name, description, inputSchema }          what an MCP server advertises in tools/list
 *
 * All three carry the same JSON Schema; only the key it sits under changes. That is deliberately the whole
 * difference, because it is the whole difference in the APIs - and api/_provider.js already proves it by
 * mapping one internal tool table onto both.
 *
 * What this does NOT do is claim a skill can be executed by a model on its own. A skill runs on the user's
 * own machine, through the agent or the extension, and the schema says so in its description. A tool
 * definition is how something is offered and asked for; it is not a promise about who does the work. Who
 * does it is docs/product/21-mcp.md.
 */

/** @typedef {{ name: string, type: string, example: string | null, about: string | null }} SkillParam */

/* JSON Schema for what `parameterise()` produces. The types it emits are the three patterns it looks for,
 * and each maps onto a string with a format rather than onto a type of its own - which is what both
 * providers want, and what keeps a value that looks like an address from being validated as one when the
 * user meant it literally. */
const PARAM_SCHEMA = {
  email: { type: 'string', format: 'email', what: 'an email address' },
  url: { type: 'string', format: 'uri', what: 'a URL' },
  quoted: { type: 'string', what: 'a phrase the goal quotes - a subject line, a message' },
};

/** Tool names are constrained: `^[a-zA-Z0-9_-]{1,64}$` on both providers, and a skill is named by a person
 *  in a sentence. Slugged, then suffixed with part of the id, because two skills may legitimately share a
 *  name and a tool table cannot - a duplicate name is silently the last one on both APIs. */
export function toolNameFor(name, id) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  const tail = String(id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toLowerCase();
  if (!slug) return `skill_${tail || 'unnamed'}`;
  return tail ? `${slug}_${tail}` : slug;
}

const str = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

function paramsOf(payload) {
  const raw = Array.isArray(payload.params) ? payload.params : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = str(item.name);
    // A parameter with no name cannot be a property. Dropped rather than named for the reader.
    if (!name || seen.has(name)) continue;
    seen.add(name);
    /* WHAT THIS PARAMETER IS, in the author's words. The one honestly empty slot in this format: every
     * `quoted` parameter is otherwise described to every model by the same canned sentence below, so a
     * skill taking a subject line and a body describes both identically and the caller has no way to tell
     * them apart. Null when nobody said, which is the honest state and reads as the canned sentence. */
    out.push({
      name, type: str(item.type) ?? 'quoted', example: str(item.example), about: str(item.about),
    });
  }
  return out;
}

function stepsOf(payload) {
  const raw = Array.isArray(payload.steps) ? payload.steps : [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = str(item.name);
    if (!name) continue;
    out.push({ name, input: str(item.input) });
  }
  return out;
}

/* The replay knobs a recorded skill really has. Not invented for this: `flowBody()` writes
 * `STEP repeat=2 speed=1.0` into the body the agent replays, and the recordings table already offers all
 * three. A tool definition that left them out would describe less than the product does. */
const REPLAY_PROPERTIES = {
  repeat: {
    type: 'integer',
    minimum: 1,
    maximum: 999,
    default: 1,
    description: 'How many times to replay the sequence. 1 unless asked for more.',
  },
  speed: {
    type: 'number',
    enum: [0.5, 1, 1.5, 2, 4],
    default: 1,
    description: 'Playback speed. Faster than 1 shortens every recorded pause, which some applications '
      + 'cannot keep up with.',
  },
};

/* Сколько шагов процедуры уходит на экран и в описание. Больше десятка пунктов в панели - это уже
 * журнал, а панель раскрывают, чтобы решить, запускать ли; остаток назван числом. */
const STEPS_SHOWN = 12;

const saidSteps = (procedure, limit) =>
  (procedure && Array.isArray(procedure.steps) ? procedure.steps : [])
    .map((one) => (one && typeof one.said === 'string' ? one.said.trim() : ''))
    .filter(Boolean)
    .slice(0, limit);

export function structureOf(flow) {
  const payload = flow.payload ?? {};
  const kind = flow.kind === 'created' ? 'created' : 'recorded';
  const runner = flow.source === 'desktop' ? 'agent' : 'extension';
  const params = kind === 'created' ? paramsOf(payload) : [];
  const goalTemplate = str(payload.goalTemplate) ?? str(payload.goal);
  const events = Array.isArray(payload.events) ? payload.events.length : 0;
  /* СКОЛЬКО ШАГОВ У ЭТОГО СКИЛЛА - предложениями, если они есть, и событиями иначе.
   *
   * Порядок именно такой, и это не вкус. Событий у одного человеческого шага бывает десяток - движение,
   * нажатие, отпускание, - поэтому «42 recorded actions» отвечает не на тот вопрос, который читатель
   * задал: он хочет знать, сколько тут РАБОТЫ, а не сколько событий её описывают. Процедура из `/2`
   * отвечает ровно на это, и там, где она есть, она и есть правда о размере.
   *
   * Событий не выводим и не считаем заново: у `/1` их и так только события, и это верный ответ для него. */
  const words = payload.procedure && typeof payload.procedure === 'object'
    && Array.isArray(payload.procedure.steps) ? payload.procedure.steps.length : 0;
  const origins = Array.isArray(flow.origins) ? flow.origins.filter((o) => !!str(o)) : [];

  const properties = {};
  const required = [];

  if (kind === 'created') {
    for (const param of params) {
      const shape = PARAM_SCHEMA[param.type] ?? { type: 'string', what: 'a value' };
      properties[param.name] = {
        type: shape.type,
        ...(shape.format ? { format: shape.format } : {}),
        /* The example goes in the description rather than into `default`. It is the author's real value -
         * their address, their file - and a default is sent when nothing else is, which would run somebody
         * else's errand for them. fillGoal() falls back to it locally, on the author's own machine, which
         * is a different thing from putting it on the wire. */
        /* The author's own words when there are any, and the canned clause only as the fallback. A model
         * choosing between two string arguments is choosing on this sentence and nothing else. */
        description: (param.about || shape.what)
          + (param.example ? `. The author's own run used something like "${param.example}"` : ''),
      };
      // Required when there is no example to fall back on - the same test missingParams() applies.
      if (!param.example) required.push(param.name);
    }
  } else {
    Object.assign(properties, REPLAY_PROPERTIES);
  }

  const said = str(flow.description);
  /* The description a recording already carries names the count, the clicks, the duration and the windows -
   * describeRecording() wrote it for exactly this kind of reading. Prepending another count produced
   * "Replays 2 recorded actions: Repeats 42 recorded actions...", two numbers disagreeing inside one
   * sentence, so the stored one wins and the synthesised one is only the fallback. */
  const what = kind === 'created'
    ? (goalTemplate ? `Carries out: ${goalTemplate}` : (said ?? 'A created skill with no goal recorded.'))
    : (said ?? (words
      ? `Carries out ${words} step${words === 1 ? '' : 's'}: ${saidSteps(payload.procedure, 6).join('; ')}.`
      : `Replays ${events} recorded action${events === 1 ? '' : 's'}.`));
  // And the origins only when they are not already in there, for the same reason.
  const named = origins.some((origin) => what.includes(origin));
  const where = origins.length && !named ? ` Works in ${origins.slice(0, 3).join(', ')}.` : '';
  /* Where a model needs the difference stated, because it changes what a call means. A recorded skill aims
   * at fixed positions or elements and does the same thing whether or not the screen still matches; a
   * created one re-reads the screen and decides, which is why one is fragile and the other is slow. */
  const how = kind === 'created'
    ? (runner === 'agent'
      ? ' Runs on the user\'s own machine: the agent re-runs this goal, deciding each step from what is on '
        + 'screen, so it adapts to a window that has moved or changed.'
      : ' Runs in the user\'s own browser: the extension re-runs this goal, deciding each step from the '
        + 'page, so it adapts to a page that has changed.')
    : (runner === 'agent'
      ? ' Runs on the user\'s own machine through the MouseFlow agent, replaying by screen position - the '
        + 'same windows have to be open and in the same places.'
      : ' Runs in the user\'s own browser through the MouseFlow extension, replaying against page '
        + 'elements.');

  return {
    toolName: toolNameFor(flow.name, flow.id),
    kind,
    runner,
    runsHow: kind === 'created'
      ? (runner === 'agent'
        ? 'the local agent, which re-runs the goal and decides each step from the screen'
        : 'the extension, which re-runs the goal and decides each step from the page')
      : (runner === 'agent'
        ? 'the local agent, replaying the recorded sequence by screen position'
        : 'the extension, replaying the recorded sequence against page elements'),
    goalTemplate,
    /* WHAT DONE LOOKS LIKE, in the author's words.
     *
     * Not verification, and it must not be sold as such: nothing compares the screen before and after, and
     * the loop cannot - it keeps only the newest picture. What it changes is what `ok` MEANS. Without it a
     * run succeeds because the model says so, which is unfalsifiable; with it the model is asserting a
     * named condition, and a person reading the log can say "that did not happen". A claim somebody can
     * disagree with is worth more than a claim nobody can. */
    success: str(payload.success) ?? null,
    params,
    steps: stepsOf(payload),
    /* ПРОЦЕДУРА СЛОВАМИ - то, что человек читает вместо счёта событий (mouseflow.skill/2).
     *
     * Отдаётся ОТДЕЛЬНО от `description`, хотя описание её уже пересказывает первыми шестью шагами.
     * Потому что это два разных читателя: `description` уезжает модели одной строкой, а это - список,
     * который рисуется на экране пунктами, и склеивать его точками с запятой для показа значило бы
     * отдавать глазу то, что готовили для промпта.
     *
     * Пусто у `/1` и у всего, что процедуры не несёт, - и пусто честно: экран тогда показывает счёт
     * событий, как показывал всегда, а не пустой заголовок «Процедура». */
    procedure: {
      whenToUse: str(payload.procedure && payload.procedure.whenToUse) ?? null,
      steps: saidSteps(payload.procedure, STEPS_SHOWN),
      /* Сколько НЕ показано - числом, потому что «и ещё» читается как «и ничего важного». */
      more: Math.max(0, words - STEPS_SHOWN),
    },
    events,
    origins,
    /* A description assembled from clauses has to read as sentences, and a stored one may not end in a
     * full stop - so one is added when it is missing rather than assumed. */
    description: (what.trim().replace(/([^.!?])$/, '$1.') + where + how).slice(0, 1024),
    schema: { type: 'object', properties, required, additionalProperties: false },
  };
}

export const WIRE_FORMATS = ['anthropic', 'openai', 'mcp'];

export const WIRE_LABELS = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  mcp: 'MCP',
};

/** Where each format expects the schema, and what else it wants beside it. */
export function wireFor(format, skill) {
  if (format === 'anthropic') {
    return { name: skill.toolName, description: skill.description, input_schema: skill.schema };
  }
  if (format === 'mcp') {
    return { name: skill.toolName, description: skill.description, inputSchema: skill.schema };
  }
  /* Flat - `name` and `parameters` sit on the tool itself rather than under a `function` key. The nested
   * Chat Completions shape is accepted by the Responses API as a tool with no name, which is the bug
   * api/_provider.js carries a comment about. `strict` only when every property is required, because that
   * is what strict mode means: it rejects a definition with optional properties in it. */
  const strict = Object.keys(skill.schema.properties).length === skill.schema.required.length;
  return {
    type: 'function',
    name: skill.toolName,
    description: skill.description,
    parameters: skill.schema,
    ...(strict ? { strict: true } : {}),
  };
}

/** All of them, for somebody who wants to see the difference rather than pick one. */
export function everyWire(skill) {
  return {
    anthropic: wireFor('anthropic', skill),
    openai: wireFor('openai', skill),
    mcp: wireFor('mcp', skill),
  };
}
