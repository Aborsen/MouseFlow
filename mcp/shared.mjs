/* The bridge to the app's own code. Nothing in this directory reimplements MouseFlow.
 *
 * The point of this file is that the MCP server holds NO copy of anything. Deriving a tool definition from
 * a skill, turning a recorded skill into a replay body, filling a goal template, driving the local agent -
 * all four already exist and are already the versions the product ships. A second copy of any of them here
 * would be a second answer to the same question, and the first time one changed the server would quietly
 * describe a product that no longer exists. So they are imported:
 *
 *   web/src/lib/skill-schema.ts    structureOf, wireFor  - a skill as a tool definition, in MCP's shape
 *   web/src/lib/macro.ts           flowBody              - the five-column body /replay eats
 *   web/src/lib/agent.ts           the local agent client
 *   web/src/lib/desktop-engine.ts  runOnDesktop          - the decision loop for a goal
 *   extension/skills.js            fillGoal, missingParams
 *
 * TWO THINGS MAKE THAT POSSIBLE, and both are worth naming because both are why this needs a recent Node.
 *
 * TYPES ARE STRIPPED, not compiled. Node runs a .ts file by removing the annotations, which works because
 * these four modules use only types and interfaces - no enums, no namespaces, no parameter properties. That
 * is not luck, it is what the files already were. The alternative was a build step producing a copy of the
 * app's lib next to this server, which is the duplication this file exists to avoid, only with an extra
 * chance to be stale.
 *
 * EXTENSIONLESS IMPORTS NEED A HOOK. `import { doAction } from './agent'` is what TypeScript writes and
 * what bundlers resolve; Node does not, and the failure is a bare "Cannot find module". The resolve hook
 * below appends `.ts` for a relative specifier with no extension coming from a .ts file, and only when
 * that file actually exists. It is registered before anything is imported, which is why the imports here
 * are dynamic: static ones hoist above it.
 *
 * THE FETCH SHIM. The two engines ask the deployment for things - the configured model, then each decision -
 * with a RELATIVE url and a cookie, because in a browser tab that is exactly right. Here there is no origin
 * and no cookie, so a path is resolved against the deployment and the device token is attached. That is the
 * whole adaptation, and it is done here rather than by editing the shared files: those serve the app, and
 * bending them around one extra caller is how a shared module becomes nobody's.
 */
import module from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = new URL('../web/src/lib/', import.meta.url);

if (typeof module.registerHooks !== 'function') {
  throw new Error(
    'This needs Node 22.18 or newer: it runs the app\'s own TypeScript modules rather than a copy of them, '
    + `and this Node (${process.version}) has no module.registerHooks. Node 24 LTS is the safe answer.`,
  );
}

module.registerHooks({
  resolve(specifier, context, next) {
    const from = context.parentURL;
    if (from && from.endsWith('.ts') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      const guess = new URL(`${specifier}.ts`, from);
      if (existsSync(fileURLToPath(guess))) return { url: guess.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

/** Everything the server borrows, loaded once. */
export async function load() {
  try {
    const [schema, macro, agent, engine, skills] = await Promise.all([
      import(new URL('skill-schema.ts', LIB).href),
      import(new URL('macro.ts', LIB).href),
      import(new URL('agent.ts', LIB).href),
      import(new URL('desktop-engine.ts', LIB).href),
      import(pathToFileURL(fileURLToPath(new URL('../extension/skills.js', import.meta.url))).href),
    ]);
    return { schema, macro, agent, engine, skills };
  } catch (err) {
    /* Named for what it is. A stripping failure and a missing file read identically otherwise, and the
     * remedies are nothing alike. */
    throw new Error(
      `Could not load MouseFlow's own modules from this checkout: ${err.message}. `
      + 'This server runs the app\'s code directly, so it has to sit inside the repository, on Node 22.18 '
      + 'or newer.',
    );
  }
}

/* -------------------------------------------------------------------------------- the fetch shim */

/** Resolve the app's relative /api calls against the deployment, and sign them as this device. */
export function installFetch({ base, token }) {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    /* Only a bare path is ours to rewrite. Absolute urls, data: urls and Request objects are passed
     * through exactly as given - the engine fetches a data: url to turn a screenshot into a blob, and
     * quietly reinterpreting that would be a bug with no symptom. */
    if (typeof input !== 'string' || !input.startsWith('/')) return real(input, init);
    const headers = new Headers((init && init.headers) || undefined);
    if (input.startsWith('/api/') && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${token}`);
    }
    /* `credentials` means nothing here and there are no cookies to send; dropped rather than left to be
     * read as though it did something. */
    const { credentials: _ignored, ...rest } = init || {};
    return real(base.replace(/\/$/, '') + input, { ...rest, headers });
  };
}
