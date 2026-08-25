/* POST /api/params — name the inputs a skill asks for, and say what each one is.
 *
 * The argument for the feature is in api/_params.mjs; the short version is that a parameter's description
 * comes from a table keyed on its TYPE, so a skill taking a subject line and a body describes both with the
 * same sentence, and a model choosing between two string arguments is choosing on nothing.
 *
 * Same shape as /api/compose next door, for the same reasons, and deliberately NOT folded into it: that one
 * places what somebody wrote onto the steps, this one says what the blanks are. Two decisions under one
 * call is the arrangement this repository has spent commits taking apart.
 *
 * WHAT IT IS ALLOWED TO COST. It spends the deployment's own key, so it is behind whoIsCalling and rate
 * limited per account: an endpoint that spends money for anyone who finds the URL is an endpoint with no
 * owner.
 *
 * AND IT IS ALLOWED TO FAIL. Every refusal answers 200 with `ok: false` and a reason, never a status the
 * browser console reports as a bug. The wizard keeps the names it derived, which is what it did before this
 * route existed - so the worst case is the old behaviour rather than a dead end.
 */
import { neon } from '@neondatabase/serverless';
import { whoIsCalling } from './_session.js';
import { ask, DEFAULT_MODEL, ProviderError } from './_provider.js';
import { applyNames, promptFor, NAME_TOOL, MAX_PARAMS } from './_params.mjs';
import { report, wrap } from './_report.js';

const RATE_WINDOW_MS = 300_000;
const RATE_MAX = 20;
const hits = new Map();

function tooMany(key) {
  const now = Date.now();
  const seen = (hits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  seen.push(now);
  hits.set(key, seen);
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const no = (res, why) => res.status(200).json({ ok: false, why });

async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') return no(res, 'POST the steps and the blanks in them');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const steps = (Array.isArray(body.steps) ? body.steps : [])
    .filter((s) => s && Number.isInteger(s.n) && typeof s.instruction === 'string')
    .map((s) => ({ n: s.n, instruction: s.instruction }));
  const blanks = (Array.isArray(body.blanks) ? body.blanks : [])
    .filter((b) => b && Number.isInteger(b.n) && typeof b.name === 'string')
    .map((b) => ({
      n: b.n,
      name: b.name,
      control: typeof b.control === 'string' ? b.control : null,
      type: typeof b.type === 'string' ? b.type : 'quoted',
    }));

  /* Nothing to name is not a failure, and a model call spent to be told so is a call spent for nothing. */
  if (!blanks.length) return no(res, 'this skill asks for nothing, so there is nothing to name');
  if (!steps.length) return no(res, 'no steps were kept, so there is nothing to read the blanks against');

  if (!process.env.DATABASE_URL) return no(res, 'this deployment has no database, so nobody can be identified');
  const sql = neon(process.env.DATABASE_URL);

  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (err) {
    await report(err, req, { route: 'params' });
    return no(res, 'could not check who is calling');
  }
  if (!who) return no(res, 'sign in first — this spends the deployment’s own model key');
  if (tooMany(who.id)) return no(res, 'too many of these in a row; the derived names were kept instead');

  const { system, user, dropped } = promptFor({
    opening: typeof body.opening === 'string' ? body.opening : '',
    steps,
    blanks,
  });

  let reply;
  try {
    reply = await ask({
      model: process.env.ANTHROPIC_API_KEY ? DEFAULT_MODEL.anthropic : DEFAULT_MODEL.openai,
      system,
      messages: [{ role: 'user', text: user }],
      tools: [NAME_TOOL],
      maxTokens: 2000,
    });
  } catch (err) {
    if (!(err instanceof ProviderError)) await report(err, req, { route: 'params' });
    return no(res, err instanceof ProviderError && err.status === 503
      ? 'this deployment has no model key, so the derived names were kept'
      : 'the model could not be reached, so the derived names were kept');
  }

  const call = (reply.calls || []).find((c) => c.name === NAME_TOOL.name);
  if (!call) return no(res, 'the model did not answer in the shape asked for');

  /* Applied in plain code, and it never removes a blank: one the model skipped keeps the name it had.
   * See _params.mjs - the model decides what a thing is CALLED, this decides what the skill holds. */
  const named = applyNames(blanks, call.input);

  return res.status(200).json({
    ok: true,
    params: named,
    /* Said rather than swallowed, like compose's: a skill with thirty blanks that silently named the first
     * twenty-four would leave six described by the canned sentence with nothing saying why. */
    dropped,
    limit: MAX_PARAMS,
  });
}

export default wrap(handler, 'params');
