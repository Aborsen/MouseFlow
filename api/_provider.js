/* One shape for talking to a model, whoever serves it.
 *
 * The two decision loops in this product keep the provider's own reply object AS their working memory -
 * raw Anthropic content blocks pushed into a transcript, tool output returned as `tool_result` blocks inside
 * a *user* message keyed by `tool_use_id`, with Anthropic's `is_error` flag. That is the real coupling, and
 * it is the one thing a "provider interface" is usually specified without: normalising observations, actions
 * and receipts does not help if the conversation itself is one vendor's data structure.
 *
 * So this file defines the conversation, and each provider translates in and out of it:
 *
 *   Message   { role: 'user' | 'assistant', text?, calls?, results? }
 *   Call      { id, name, input }              what the model wants run
 *   Result    { id, output, isError }          what running it produced
 *   Answer    { text, calls, stopReason, usage, raw }
 *
 * stopReason is one of: 'end' | 'tools' | 'truncated' | 'refused'. Those four are what a caller has to
 * branch on, and every provider expresses them differently - which is exactly how both loops came to file a
 * truncated turn as a successful run.
 *
 * Not a general-purpose SDK. It carries what a grounded chat and a tool loop need, and nothing else: no
 * streaming, no images (the decision loops still call Anthropic directly for those - see api/claude.js),
 * no parallel-tool subtleties beyond returning several calls at once.
 *
 * IMPORTANT, and deliberately visible: the Anthropic path is exercised by this product every day. The
 * OpenAI path is written against the Chat Completions shape and has NOT been run against the live API from
 * here - there is no OPENAI_API_KEY on the deployment yet. It is structured so that a wrong assumption
 * fails loudly with the upstream's own message rather than silently degrading, and the mapping is
 * commented so it can be checked against current documentation rather than trusted.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
/* The Responses API, not Chat Completions. The model this deployment serves - gpt-5.6-luna with reasoning
 * effort - is called as `client.responses.create({ model, reasoning: { effort }, input })`, which is a
 * different endpoint and a different body from the one this file first mapped. There is one OpenAI transport
 * rather than two half-verified ones. */
const OPENAI_URL = 'https://api.openai.com/v1/responses';

/* What the deployment says it wants, where it says it. Vercel already carries OPENAI_MODEL and
 * OPENAI_REASONING_EFFORT, so reading them here is one statement of the default rather than two that can
 * disagree - and changing the model becomes an environment variable rather than a deploy. */
const OPENAI_DEFAULT = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
export const DEFAULT_EFFORT = process.env.OPENAI_REASONING_EFFORT || 'high';

/* Room the model may spend THINKING, on top of the room the caller asked for.
 *
 * Every caller in this repo passes `maxTokens` meaning "how long may the ANSWER be" - api/chat.js names its
 * number ANSWER_TOKENS, and that is what the number is for. On Anthropic that is exactly what max_tokens
 * means, because no thinking budget is sent alongside it. On the OpenAI Responses API it is not:
 * `max_output_tokens` bounds reasoning AND the answer together, and reasoning is invisible, uncapped by
 * anything else, and at effort 'high' routinely longer than whatever the model then writes.
 *
 * So the assistant on this deployment - gpt-5.6 at effort high, ANSWER_TOKENS = 2000 - spent the entire
 * ceiling reasoning and came back `status: incomplete, reason: max_output_tokens` carrying no text at all.
 * Read below as 'truncated', refused by api/chat.js as not an answer, and shown to the person as "the model
 * ran out of room before finishing the answer. Ask something narrower" - advice that could not have helped,
 * because the question was never the problem. Every one of those reasoning tokens was paid for first.
 *
 * A CEILING IS NOT A SPEND. Adding room costs nothing on a question answered in four hundred tokens; what
 * it stops is the answers that were bought and then thrown away. The reserve is per effort because that is
 * what decides how much thinking there is to hold, and the figures follow OpenAI's own guidance on leaving
 * reasoning room. Anthropic is untouched: without a thinking budget its ceiling really is the answer's.
 */
const ROOM_TO_THINK = { low: 4_000, medium: 12_000, high: 25_000 };
const roomToThink = (effort) => (effort ? ROOM_TO_THINK[effort] ?? ROOM_TO_THINK.medium : 0);

/* Which models this file will talk to, per provider. An allowlist rather than a passthrough for the same
 * reason api/claude.js has one: this spends somebody's money, and an unbounded model name is an unbounded
 * price. The first entry is the default.
 *
 * api/models.js asks each provider for its own list, which is how this stops being a guess: anything here
 * that the provider does not list shows up as `missing` there. */
export const MODELS = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  openai: [...new Set([OPENAI_DEFAULT, 'gpt-5.6-luna', 'gpt-5.1', 'gpt-4.1'])],
};

/** The model this deployment reaches for when a caller does not name one. */
export const DEFAULT_MODEL = {
  anthropic: MODELS.anthropic[0],
  openai: MODELS.openai[0],
};

export const PROVIDERS = Object.keys(MODELS);

/** The provider a model belongs to, or null if it is not one we will call. */
export function providerFor(model) {
  for (const [name, list] of Object.entries(MODELS)) {
    if (list.includes(model)) return name;
  }
  return null;
}

/** The key for a provider, and whether this deployment actually has one. */
export function keyFor(provider) {
  if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY || null;
  if (provider === 'openai') return process.env.OPENAI_API_KEY || null;
  return null;
}

export class ProviderError extends Error {
  constructor(message, status, provider) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
  }
}

/* ------------------------------------------------------------------------ anthropic */

function toAnthropic({ system, messages, tools, maxTokens, model }) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const content = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const call of m.calls || []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input || {} });
      }
      out.push({ role: 'assistant', content });
      continue;
    }
    /* Tool output goes back as blocks inside a USER message - Anthropic's shape, and the reason a
     * transcript built for it cannot be handed to another provider unchanged. All of a turn's results go in
     * ONE message: splitting them teaches the model to stop calling tools in parallel. */
    const content = [];
    for (const r of m.results || []) {
      content.push({
        type: 'tool_result',
        tool_use_id: r.id,
        content: String(r.output ?? ''),
        ...(r.isError ? { is_error: true } : {}),
      });
    }
    if (m.text) content.push({ type: 'text', text: m.text });
    out.push({ role: 'user', content });
  }

  return {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    ...(tools && tools.length
      ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })) }
      : {}),
    messages: out,
  };
}

function fromAnthropic(body) {
  const blocks = body.content || [];
  const reason = body.stop_reason;
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim(),
    calls: blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input || {} })),
    stopReason: reason === 'refusal' ? 'refused'
      : reason === 'max_tokens' ? 'truncated'
        : reason === 'tool_use' ? 'tools'
          : 'end',
    usage: {
      input: (body.usage && body.usage.input_tokens) || 0,
      output: (body.usage && body.usage.output_tokens) || 0,
    },
    raw: body,
  };
}

/* -------------------------------------------------------------------------- openai */

function toOpenAI({ system, messages, tools, maxTokens, model, effort }) {
  const input = [];

  /* No `system` field on this API: the instruction is either the top-level `instructions` or a message with
   * role 'system' in the input. It is sent as `instructions` below, which is what the API documents for it. */

  for (const m of messages) {
    if (m.role === 'assistant') {
      /* An assistant turn's text is an output_text part, not input_text - the part types are directional on
       * this API, and using the input type for something the model said is rejected rather than ignored. */
      if (m.text) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.text }] });
      }
      /* A tool call is its own top-level item, not a field on the message. `arguments` is a JSON string
       * here as it is on Chat Completions, and `call_id` is what the result must quote back. */
      for (const call of m.calls || []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input || {}),
        });
      }
      continue;
    }

    /* And a result is an item too - `function_call_output` - rather than a message with a special role.
     * There is no error flag on it, so a failure is said in words, which is why Result.isError becomes a
     * prefix instead of being dropped. */
    for (const r of m.results || []) {
      input.push({
        type: 'function_call_output',
        call_id: r.id,
        output: (r.isError ? 'ERROR: ' : '') + String(r.output ?? ''),
      });
    }
    if (m.text) input.push({ role: 'user', content: [{ type: 'input_text', text: m.text }] });
  }

  return {
    model,
    input,
    ...(system ? { instructions: system } : {}),
    /* `max_output_tokens`, not max_tokens and not max_completion_tokens - and not the caller's number
     * either, because on this API the ceiling covers the model's private reasoning as well as its answer.
     * See ROOM_TO_THINK: `maxTokens` stays what every caller means by it, room for the answer. */
    max_output_tokens: maxTokens + roomToThink(effort),
    /* Reasoning effort as a nested object, which is the whole reason this endpoint is in use. Sent only when
     * asked for: a model that does not reason refuses the field rather than ignoring it. */
    ...(effort ? { reasoning: { effort } } : {}),
    /* Flat, unlike Chat Completions - name and parameters sit on the tool itself rather than under a
     * `function` key. Sending the nested shape here is accepted as a tool with no name. */
    ...(tools && tools.length
      ? {
        tools: tools.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.schema,
        })),
      }
      : {}),
  };
}

function fromOpenAI(body) {
  const items = body.output || [];

  /* `output_text` is the documented convenience field for the whole reply as a string. Falling back to
   * walking the output items rather than trusting it to exist, because a reply that carried only a tool call
   * has no text at all and an absent field must not read as an empty answer. */
  const text = typeof body.output_text === 'string' && body.output_text.trim()
    ? body.output_text.trim()
    : items
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content || [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text)
      .join('')
      .trim();

  const calls = items
    .filter((item) => item.type === 'function_call')
    .map((item) => {
      let parsed = {};
      try { parsed = JSON.parse(item.arguments || '{}'); } catch (_) { parsed = {}; }
      // call_id is what a result has to quote back; id is the item's own identity and is not interchangeable.
      return { id: item.call_id || item.id, name: item.name, input: parsed };
    });

  /* Termination lives in two places here rather than one enum. `status: 'incomplete'` with a reason is the
   * truncation case - the one both decision loops in this product used to file as a successful run - and a
   * refusal arrives as a content part of type 'refusal'. */
  const refused = items
    .flatMap((item) => item.content || [])
    .some((part) => part && part.type === 'refusal');
  const truncated = body.status === 'incomplete' &&
    (body.incomplete_details || {}).reason === 'max_output_tokens';

  return {
    text,
    calls,
    stopReason: refused ? 'refused'
      : truncated ? 'truncated'
        : calls.length ? 'tools'
          : 'end',
    usage: {
      input: (body.usage && body.usage.input_tokens) || 0,
      output: (body.usage && body.usage.output_tokens) || 0,
    },
    raw: body,
  };
}

/* ---------------------------------------------------------------------------- ask */

/**
 * One turn. Returns the normalised Answer above.
 *
 * @param {object} opts
 * @param {string} opts.model      must be in MODELS
 * @param {string} [opts.system]
 * @param {Array}  opts.messages   Message[] in this file's shape
 * @param {Array}  [opts.tools]    [{ name, description, schema }]
 * @param {number} [opts.maxTokens]
 * @param {string}  [opts.effort]     'low' | 'medium' | 'high' - reasoning effort, where the provider has one
 * @param {AbortSignal} [opts.signal]
 */
export async function ask(opts) {
  const provider = providerFor(opts.model);
  if (!provider) throw new ProviderError(`unknown model ${opts.model}`, 400, null);

  const key = keyFor(provider);
  if (!key) {
    throw new ProviderError(
      provider === 'openai'
        ? 'This deployment has no OpenAI key, so it can only run on Anthropic models.'
        : 'This deployment has no Anthropic key.',
      503,
      provider,
    );
  }

  const maxTokens = Math.min(Math.max(Number(opts.maxTokens) || 2000, 256), 16000);
  /* Anthropic expresses this as a thinking budget rather than a word, and mapping one to the other would be
   * a guess dressed as a translation - so it is passed to OpenAI and dropped for Anthropic, on purpose.
   * Unset means the deployment's own default, which is what OPENAI_REASONING_EFFORT is for. */
  const asked = opts.effort ?? (provider === 'openai' ? DEFAULT_EFFORT : null);
  const effort = ['low', 'medium', 'high'].includes(asked) ? asked : null;
  const shaped = { ...opts, maxTokens, effort };

  const url = provider === 'anthropic' ? ANTHROPIC_URL : OPENAI_URL;
  const headers = provider === 'anthropic'
    ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  const payload = provider === 'anthropic' ? toAnthropic(shaped) : toOpenAI(shaped);

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: opts.signal,
  });

  const text = await res.text();
  if (!res.ok) {
    /* The upstream's own message, verbatim. A wrong assumption in the mapping above shows up here as the
     * provider explaining what it did not like, which is far more use than a generic failure. */
    let detail = text.slice(0, 400);
    try {
      const body = JSON.parse(text);
      detail = body.error?.message || body.message || detail;
    } catch (_) { /* not JSON: the raw text is the best available */ }
    throw new ProviderError(detail, res.status, provider);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    throw new ProviderError('the provider sent something unreadable', 502, provider);
  }

  return provider === 'anthropic' ? fromAnthropic(body) : fromOpenAI(body);
}
