/* Which model drives a run, asked of the deployment instead of compiled into the bundle.
 *
 * The desktop engine and the plan preview each carried their own `const MODEL` - two constants with the
 * same value and nothing tying them together, baked into the SPA at build time. Changing the model meant
 * a deploy, and the run log recorded a third, separate constant that nobody updated. Now the admin panel
 * writes one setting, GET /api/claude serves it, and this asks on the way into a run.
 *
 * Cached for a minute, not forever: a run should not pay a request per step (the engine asks the model
 * dozens of times), but an admin's change should reach the NEXT run without anybody reloading tabs. The
 * hardcoded names remain as the fallback for a deployment whose endpoint cannot answer - the engines must
 * not refuse to start because a probe failed. */

const FALLBACK = 'claude-opus-5';
const TTL_MS = 60_000;

interface Served { model: string; planModel: string; extensionModel: string }

let cached: Served | null = null;
let fetchedAt = 0;

async function serve(): Promise<Served> {
  const now = Date.now();
  if (cached && now - fetchedAt < TTL_MS) return cached;
  try {
    const res = await fetch('/api/claude', { credentials: 'same-origin' });
    const body = (await res.json()) as { model?: string; planModel?: string };
    const model = typeof body.model === 'string' && body.model ? body.model : FALLBACK;
    cached = {
      model,
      planModel: typeof body.planModel === 'string' && body.planModel ? body.planModel : model,
      extensionModel: model,
    };
    fetchedAt = now;
  } catch (_) {
    /* An unreachable probe keeps the last answer, or the fallback - never a refusal to run. */
    cached = cached ?? { model: FALLBACK, planModel: FALLBACK, extensionModel: FALLBACK };
    fetchedAt = now;
  }
  return cached;
}

/** The model the desktop engine should drive its next run with. */
export const desktopModel = async (): Promise<string> => (await serve()).model;

/** The model the plan preview should outline with. */
export const planModel = async (): Promise<string> => (await serve()).planModel;
