/* The desktop agents are single files, and the app serves them: the start command pipes one straight from
 * this origin, and the macOS installer curls the other from it. They live at ../agent - one copy each, which
 * the README and the extension also point at - so they are copied into public/ at build time rather than
 * duplicated in the tree.
 *
 * Runs before dev and before build, so the dev server serves the same files the deployment will.
 *
 * A missing file is a failure, not a skip. The whole install path on either platform is "fetch this from the
 * origin", and a deployment that silently shipped without one of them would answer 404 to the only command
 * the Connections screen offers.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const files = [
  'mouseflow-agent.ps1',   // Windows: fetched and run in memory by the one-liner
  'mouseflow-agent.swift', // macOS: fetched and compiled on the machine by the installer
  'install-mac.sh',        // macOS: the installer itself
];

for (const name of files) {
  const from = resolve(here, '../../agent/', name);
  const to = resolve(here, '../public/agent/', name);
  if (!existsSync(from)) {
    console.error(`agent/${name} is missing - the install command for that platform would 404`);
    process.exit(1);
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

console.log(`agents copied into public/agent (${files.join(', ')})`);
