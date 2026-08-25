/* Whether the app on screen is still the app that is deployed.
 *
 * WHY THIS EXISTS. An open tab never re-fetches its own JavaScript. A deployment therefore reaches nobody
 * who already has the page up - and every constant baked into it stays as it was, AGENT_WANTS included. The
 * failure that made this necessary: somebody sat looking at a pill saying their agent was current, while a
 * newer agent had been out for an hour and the page whose job it was to say so was itself a version behind.
 * It could not know. Nothing in it said which version it was.
 *
 * So the build is stamped in at build time and also served as a file, and the two are compared.
 *
 * NOT A RELOAD, A NOTICE. Reloading somebody's page for them throws away whatever they were doing - a goal
 * half typed, a wizard three steps in - to deliver a change they did not ask for and may not need. The page
 * says a newer one exists and leaves the moment to them.
 */
declare const __BUILD__: string;

/** The build this page was made from. `dev` outside a deployment, which makes the check inert locally. */
export const BUILD: string = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

/* Ten minutes, and again whenever the tab is looked at.
 *
 * The interval alone is the wrong shape: the tab that matters is the one left open for days, and the moment
 * that matters is when somebody comes back to it. Focus is when they are about to act on what it says. */
const EVERY_MS = 10 * 60 * 1000;

let deployed: string | null = null;
let asking = false;

async function look(): Promise<void> {
  if (asking || BUILD === 'dev') return;
  asking = true;
  try {
    /* `no-store`, or the check answers with the copy it is trying to detect the staleness of. */
    const res = await fetch('/build.json', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return;
    const body = (await res.json()) as { build?: string } | null;
    const said = body && typeof body.build === 'string' ? body.build : null;
    /* Only ever set to something DIFFERENT. A deployment that matches leaves this null, so `newer()` stays
     * false rather than reporting the build it already is. */
    if (said && said !== BUILD) deployed = said;
  } catch (_) {
    /* Offline, or a deployment mid-swap. Neither is worth a word on screen: the page still works, and the
     * question will be asked again in ten minutes. */
  } finally {
    asking = false;
  }
}

/** The newer build, when there is one. Null until the check has both seen one and found it different. */
export const newerBuild = () => deployed;

/** Start looking. Idempotent - a second caller joins the first rather than starting a second timer. */
let started = false;
export function watchForNewBuild(onFound: () => void): () => void {
  const tick = () => void look().then(() => { if (deployed) onFound(); });
  if (!started) {
    started = true;
    tick();
  }
  const timer = window.setInterval(tick, EVERY_MS);
  const onFocus = () => tick();
  window.addEventListener('focus', onFocus);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener('focus', onFocus);
  };
}
