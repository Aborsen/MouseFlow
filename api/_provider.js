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
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/* Which models this file will talk to, per provider. An allowlist rather than a passthrough for the same
 * reason api/claude.js has one: this spends somebody's money, and an unbounded model name is an unbounded
 * price. The first entry is the default. */
export const MODELS = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5.1', 'gpt-5.1-mini', 'gpt-4.1'],
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

function toOpenAI({ system, messages, tools, maxTokens, model }) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        /* Arguments are a JSON *string* here, where Anthropic sends an object. Forgetting that produces a
         * request the API accepts and a model that reads its own previous call as gibberish. */
        ...(m.calls && m.calls.length
          ? {
            tool_calls: m.calls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
            })),
          }
          : {}),
      });
      continue;
    }
    /* And tool output is its own role with one message PER result, not blocks inside a user message. There
     * is no per-result error flag either, so a failure has to be said in words - which is why Result.isError
     * is turned into a prefix rather than dropped. */
    for (const r of m.results || []) {
      out.push({
        role: 'tool',
        tool_call_id: r.id,
        content: (r.isError ? 'ERROR: ' : '') + String(r.output ?? ''),
      });
    }
    if (m.text) out.push({ role: 'user', content: m.text });
  }

  return {
    model,
    max_completion_tokens: maxTokens,
    ...(tools && tools.length
      ? {
        tools: tools.map((t) => ({
          type: 'function',
          // `parameters`, not `input_schema`.
          function: { name: t.name, description: t.description, parameters: t.schema },
        })),
      }
      : {}),
    messages: out,
  };
}

function fromOpenAI(body) {
  const choice = (body.choices || [])[0] || {};
  const message = choice.message || {};
  const finish = choice.finish_reason;
  return {
    text: String(message.content || '').trim(),
    calls: (message.tool_calls || []).map((c) => {
      let input = {};
      try { input = JSON.parse(c.function?.arguments || '{}'); } catch (_) { input = {}; }
      return { id: c.id, name: c.function?.name, input };
    }),
    stopReason: finish === 'content_filter' ? 'refused'
      : finish === 'length' ? 'truncated'
        : finish === 'tool_calls' ? 'tools'
          : 'end',
    usage: {
      input: (body.usage && body.usage.prompt_tokens) || 0,
      output: (body.usage && body.usage.completion_tokens) || 0,
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
  const shaped = { ...opts, maxTokens };

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
