/* The desktop agent is a single PowerShell file, and the app serves it: the start command pipes it
 * straight from this origin. It lives at ../agent - one copy, which the README and the extension also
 * point at - so it is copied into public/ at build time rather than duplicated in the tree.
 *
 * Runs before dev and before build, so the dev server serves the same file the deployment will.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(here, '../../agent/mouseflow-agent.ps1');
const to = resolve(here, '../public/agent/mouseflow-agent.ps1');

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log('agent copied into public/agent');
