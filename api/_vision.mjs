/* Spending the shared key on a conversation that carries pictures.
 *
 * api/_provider.js is the general way to talk to a model and it deliberately carries no images - the note at
 * its head says so, and points here. This is the other path: the decision loop's turn, which is a screenshot
 * plus a tool schema, and which has always gone straight to Anthropic.
 *
 * It lived inside api/claude.js, which is the endpoint the BROWSER calls. The cloud step has to make the same
 * call from inside another function, and calling our own HTTP endpoint to do it would be a second invocation,
 * a second authentication and a second set of caps that can drift from these. So the call moved here and both
 * use it. The caps are the point of the file as much as the fetch is: this spends money for anyone who can
 * reach it, so what ONE request can cost is bounded here, once.
 */

const UPSTREAM = 'https://api.anthropic.com/v1/messages';

// Only what the loops use, and only within these bounds.
export const ALLOWED_MODELS = new Set(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
export const MAX_TOKENS_CAP = 16000;
export const MAX_MESSAGES = 120;         // a runaway loop hits this long before it hits the balance
/* Vision turns carry a picture, and the platform allows ~4.5MB. A cap of 1.5MB made this the tightest gate
 * in the chain at a third of what the platform permits - and the failure it produced said only "request too
 * large". The agents send JPEG now, which is where the real saving is; this is the backstop, and it reports
 * the size so the number is not a mystery. */
export const MAX_BODY_BYTES = 4_000_000;

/* Rebuilt field by field rather than forwarded wholesale, so a caller cannot smuggle in options this is not
 * meant to pay for. */
export function payloadFor(body) {
  const payload = {
    model: body.model,
    max_tokens: Math.min(Number(body.max_tokens) || 4096, MAX_TOKENS_CAP),
    messages: body.messages,
  };
  if (typeof body.system === 'string') payload.system = body.system;
  if (Array.isArray(body.tools)) payload.tools = body.tools;
  if (body.tool_choice) payload.tool_choice = body.tool_choice;
  if (body.fallbacks) payload.fallbacks = body.fallbacks;
  return payload;
}

/**
 * One turn, upstream. Never throws: every way this can fail is a field, because both callers have to say
 * something specific about each and an exception says the same thing about all of them.
 *
 * @returns {Promise<{status:number, text:string, contentType:string, bytes:number,
 *                    tooLarge?:boolean, unreachable?:string}>}
 */
export async function callModel(body, key, signal) {
  const encoded = JSON.stringify(payloadFor(body));
  if (encoded.length > MAX_BODY_BYTES) {
    return { status: 413, text: '', contentType: 'application/json', bytes: encoded.length, tooLarge: true };
  }

  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        /* Opus 5's safety classifiers can decline a request; this re-runs it on the recommended fallback
         * server-side instead of handing back a dead end. */
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: encoded,
    });
  } catch (err) {
    return {
      status: 502, text: '', contentType: 'application/json', bytes: encoded.length,
      unreachable: err && err.message ? err.message : 'the request failed',
    };
  }

  return {
    status: upstream.status,
    text: await upstream.text(),
    contentType: upstream.headers.get('content-type') || 'application/json',
    bytes: encoded.length,
  };
}
