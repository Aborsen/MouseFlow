/* POST /api/compose - put what somebody wrote onto the steps their recording derived.
 *
 * One model call, made ONCE when a skill is being created, while the person who did the work is still on
 * the screen. Why then and not at run time is argued in api/_compose.mjs; the short version is that "finish
 * with Send, not Save" is a change to the plan, and the thing that carries a goal out decides one action at
 * a time and may already have clicked Save.
 *
 * WHAT THIS ROUTE IS ALLOWED TO COST. It spends the deployment's own key, so it is behind whoIsCalling like
 * /api/chat: an endpoint that spends money for anyone who finds the URL is an endpoint with no owner. The
 * caps are the same shape - a capped step list, capped notes, a rate limit per account.
 *
 * AND IT IS ALLOWED TO FAIL. Every refusal here answers with a body the wizard can use: `ok: false` plus a
 * reason, never a 500 that leaves somebody unable to save a skill because a model was busy. The wizard
 * falls back to appending the notes verbatim, which is what it did before this route existed, so the worst
 * case is the old behaviour rather than a dead end.
 */
import { neon } from '@neondatabase/serverless';
import { whoIsCalling } from './_session.js';
/* Потолок теперь считается в базе, а не в памяти процесса - см. api/_spend.mjs. Здешний Map жил в
 * ОДНОМ тёплом инстансе, а сколько их, решает трафик: то есть настоящий предел умножался ровно тогда,
 * когда был нужнее всего. Комментарий рядом со старым счётчиком это признавал. */
import { overSpend, spentWhy } from './_spend.mjs';
import { ask, DEFAULT_MODEL, ProviderError } from './_provider.js';
import { applyPlan, promptFor, PLAN_TOOL, MAX_STEPS } from './_compose.mjs';
import { report, wrap } from './_report.js';

/* Потолок на звонящего переехал в api/_spend.mjs и считается в базе.
 *
 * Здесь стоял Map в области модуля, и его собственный комментарий признавал главное: на serverless
 * каждый тёплый инстанс держит своё окно, так что настоящий предел был этим числом, умноженным на
 * количество проснувшихся - то есть он рос ровно тогда, когда был нужнее всего. Шесть маршрутов
 * повторяли эту конструкцию, каждый со своей копией и своим признанием.
 *
 * Числа не потерялись: они перечислены в LIMITS одним списком, где их наконец можно сравнить. */

function cors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin',
    /^chrome-extension:\/\//.test(origin) ? origin : 'https://mouse-agent.vercel.app');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/* Never an error status. The wizard treats every one of these as "use the plain append", and a 4xx or 5xx
 * would make an ordinary, expected outcome look like a bug in the browser console. */
const no = (res, why) => res.status(200).json({ ok: false, why });

async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') return no(res, 'POST a step list and some notes');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const steps = (Array.isArray(body.steps) ? body.steps : [])
    .filter((s) => s && Number.isInteger(s.n) && typeof s.instruction === 'string' && s.instruction.trim())
    .map((s) => ({ n: s.n, instruction: s.instruction }));
  const notes = typeof body.notes === 'string' ? body.notes : '';
  const opening = typeof body.opening === 'string' ? body.opening : '';

  /* Nothing written means nothing to place, and a model call would be spent to answer "no changes". */
  if (!notes.trim()) return no(res, 'nothing was written, so there is nothing to place');
  if (!steps.length) return no(res, 'no steps were kept, so there is nowhere to place anything');

  if (!process.env.DATABASE_URL) return no(res, 'this deployment has no database, so nobody can be identified');
  const sql = neon(process.env.DATABASE_URL);

  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (err) {
    await report(err, req, { route: 'compose' });
    return no(res, 'could not check who is calling');
  }
  if (!who) return no(res, 'sign in first — this spends the deployment’s own model key');
  const budget = await overSpend(sql, who.id, 'compose');
  if (!budget.ok) return no(res, spentWhy(budget, 'of these') + ' The notes were added as written instead.');

  const { system, user, dropped } = promptFor({ steps, notes });

  let reply;
  try {
    reply = await ask({
      model: process.env.ANTHROPIC_API_KEY ? DEFAULT_MODEL.anthropic : DEFAULT_MODEL.openai,
      system,
      messages: [{ role: 'user', text: user }],
      tools: [PLAN_TOOL],
      maxTokens: 4000,
    });
  } catch (err) {
    /* A missing key is a deployment fact, not a crash: it means this feature is off here. Anything else is
     * worth a report, because a provider that starts refusing is not something a user can tell us about. */
    if (!(err instanceof ProviderError)) await report(err, req, { route: 'compose' });
    return no(res, err instanceof ProviderError && err.status === 503
      ? 'this deployment has no model key, so the notes were added as written'
      : 'the model could not be reached, so the notes were added as written');
  }

  const call = (reply.calls || []).find((c) => c.name === PLAN_TOOL.name);
  if (!call) return no(res, 'the model did not answer in the shape asked for');

  const applied = applyPlan({ steps, opening }, call.input);
  if (!applied.text) return no(res, 'nothing came back that could be placed');

  return res.status(200).json({
    ok: true,
    ...applied,
    /* Said rather than swallowed: a compiler that quietly considered the first 300 of 546 steps would place
     * "finish by pressing Save" against whatever step 300 happened to be. */
    dropped,
    limit: MAX_STEPS,
  });
}

export default wrap(handler, 'compose');
