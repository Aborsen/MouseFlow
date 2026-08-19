/* A skill, as a tool definition.
 *
 * A skill on this account is already the same thing a tool call is: a named, described unit of work with
 * the variable parts pulled out of it. `extension/skills.js` does that pulling - `parameterise()` lifts the
 * addresses, URLs and quoted phrases out of the goal somebody typed and leaves a template with
 * `{{recipient}}` in it. What was missing was the last step: saying so in the shape the two providers this
 * app already speaks to expect, so a skill can be handed to a model rather than only to a replay.
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
 * definition is how something is offered and asked for; it is not a promise about who does the work.
 */
import type { Flow } from './api';

export interface SkillParam {
  name: string;
  type: string;
  example: string | null;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, {
    type: string;
    format?: string;
    description?: string;
    enum?: (string | number)[];
    minimum?: number;
    maximum?: number;
    default?: number;
  }>;
  required: string[];
  additionalProperties: false;
}

export interface SkillStructure {
  /** The name a model would call. Slugged and suffixed - see toolNameFor. */
  toolName: string;
  kind: 'recorded' | 'created';
  /** Which half can actually run it. Not a detail: a desktop flow aims at screen positions. */
  runner: 'agent' | 'extension';
  /** How it runs, in one phrase. Depends on the kind as much as the half: a recorded skill aims at
   * something and a created one re-runs a sentence, which is a different promise about what happens when
   * the screen has changed since. */
  runsHow: string;
  /** For a created skill: the sentence with its variable parts lifted out. */
  goalTemplate: string | null;
  params: SkillParam[];
  /** What one successful run did. Evidence beside a created skill, never the thing replayed. */
  steps: { name: string; input: string | null }[];
  /** For a recorded skill: how many events it replays. */
  events: number;
  origins: string[];
  description: string;
  schema: JsonSchema;
}

/* JSON Schema for what `parameterise()` produces. The types it emits are the three patterns it looks for,
 * and each maps onto a string with a format rather than onto a type of its own - which is what both
 * providers want, and what keeps a value that looks like an address from being validated as one when the
 * user meant it literally. */
const PARAM_SCHEMA: Record<string, { type: string; format?: string; what: string }> = {
  email: { type: 'string', format: 'email', what: 'an email address' },
  url: { type: 'string', format: 'uri', what: 'a URL' },
  quoted: { type: 'string', what: 'a phrase the goal quotes - a subject line, a message' },
};

/** Tool names are constrained: `^[a-zA-Z0-9_-]{1,64}$` on both providers, and a skill is named by a person
 * in a sentence. Slugged, then suffixed with part of the id, because two skills may legitimately share a
 * name and a tool table cannot - a duplicate name is silently the last one on both APIs. */
export function toolNameFor(name: string, id: string): string {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  const tail = String(id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toLowerCase();
  if (!slug) return `skill_${tail || 'unnamed'}`;
  return tail ? `${slug}_${tail}` : slug;
}

const str = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

function paramsOf(payload: Record<string, unknown>): SkillParam[] {
  const raw = Array.isArray(payload.params) ? payload.params : [];
  const seen = new Set<string>();
  const out: SkillParam[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = str(record.name);
    // A parameter with no name cannot be a property. Dropped rather than named for the reader.
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      type: str(record.type) ?? 'quoted',
      example: str(record.example),
    });
  }
  return out;
}

function stepsOf(payload: Record<string, unknown>): { name: string; input: string | null }[] {
  const raw = Array.isArray(payload.steps) ? payload.steps : [];
  const out: { name: string; input: string | null }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = str(record.name);
    if (!name) continue;
    out.push({ name, input: str(record.input) });
  }
  return out;
}

/* The replay knobs a recorded skill really has. Not invented for this: `flowBody()` writes
 * `STEP repeat=2 speed=1.0` into the body the agent replays, and the recordings table already offers all
 * three. A tool definition that left them out would describe less than the product does. */
const REPLAY_PROPERTIES: JsonSchema['properties'] = {
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

export function structureOf(flow: Flow): SkillStructure {
  const payload = (flow.payload ?? {}) as Record<string, unknown>;
  const kind = flow.kind === 'created' ? 'created' : 'recorded';
  const runner = flow.source === 'desktop' ? 'agent' : 'extension';
  const params = kind === 'created' ? paramsOf(payload) : [];
  const goalTemplate = str(payload.goalTemplate) ?? str(payload.goal);
  const events = Array.isArray(payload.events) ? payload.events.length : 0;
  const origins = Array.isArray(flow.origins) ? flow.origins.filter((o) => !!str(o)) : [];

  const properties: JsonSchema['properties'] = {};
  const required: string[] = [];

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
        description: shape.what
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
    : (said ?? `Replays ${events} recorded action${events === 1 ? '' : 's'}.`);
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
    params,
    steps: stepsOf(payload),
    events,
    origins,
    /* A description assembled from clauses has to read as sentences, and a stored one may not end in a
     * full stop - so one is added when it is missing rather than assumed. */
    description: (what.trim().replace(/([^.!?])$/, '$1.') + where + how).slice(0, 1024),
    schema: { type: 'object', properties, required, additionalProperties: false },
  };
}

export const WIRE_FORMATS = ['anthropic', 'openai', 'mcp'] as const;
export type WireFormat = typeof WIRE_FORMATS[number];

export const WIRE_LABELS: Record<WireFormat, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  mcp: 'MCP',
};

/** Where each format expects the schema, and what else it wants beside it. */
export function wireFor(format: WireFormat, skill: SkillStructure): unknown {
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
export function everyWire(skill: SkillStructure): Record<WireFormat, unknown> {
  return {
    anthropic: wireFor('anthropic', skill),
    openai: wireFor('openai', skill),
    mcp: wireFor('mcp', skill),
  };
}
