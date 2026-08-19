#!/usr/bin/env node
/* Re-copy the Insightis design system into vendor/insightis-ui.
 *
 *   node scripts/sync-design-system.mjs                 # master
 *   node scripts/sync-design-system.mjs --ref v1.2.3    # a tag, branch or commit
 *   node scripts/sync-design-system.mjs --from ../../..  # an existing checkout of the repo
 *   node scripts/sync-design-system.mjs --check         # say what would change, touch nothing
 *
 * Why a script and not a git submodule or a published package: the upstream is a pnpm workspace behind
 * Devart's GitLab, and @insightis/ui depends on sibling workspace packages for its tooling. A submodule
 * would drag the whole monorepo in and still need a build step; npm cannot install from it at all. A copy
 * is what actually works - so the copy is made reproducible instead of made by hand.
 *
 * The rules that keep it updatable:
 *
 *   * The copy is VERBATIM and the whole package, its own layout intact. Nothing is rewritten on the way
 *     in - not a path, not an import, not a config. Every internal `./src/lib/constants` and every
 *     `@insightis/ui/Typography` still means what it meant upstream, which is why re-running this is a
 *     wholesale replace rather than a merge. The app bends to the package (see the aliases in
 *     vite.config.ts and tsconfig.json), never the other way round.
 *   * Local edits are therefore lost on the next sync, so this refuses to run when the vendored tree has
 *     uncommitted changes. Fix things upstream; that is where the design system lives.
 *   * What was taken is written to vendor/insightis-ui/vendored.json - repo, ref, commit, date - so
 *     "which version is this?" has an answer that does not depend on anybody's memory.
 *
 * Needs network and your Devart GitLab credentials, unless --from points at a checkout you already have.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://git.devart.com/devart/ai-innovations-team/simplebi/insightis.git';

/* Two packages, because @insightis/ui's own tsconfig extends the workspace's shared one by package name.
 * Vite's esbuild pass finds that tsconfig when it transforms a vendored file and resolves its `extends`
 * through node_modules - so the shared config has to be installable, which is what the file: dependency in
 * package.json is for. Copying it as well is cheaper than editing the tsconfig we promised not to touch. */
const PACKAGES = [
  { from: 'frontend/packages/ui', to: 'vendor/insightis-ui' },
  { from: 'frontend/packages/typescript-config', to: 'vendor/insightis-typescript-config' },
];
const PACKAGE = PACKAGES[0].from;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? null : (args[i + 1] ?? '');
};
const has = (name) => args.includes('--' + name);
const ref = flag('ref') || 'master';
const check = has('check');

const git = (cwd, ...rest) =>
  execFileSync('git', ['-c', 'core.longpaths=true', ...rest], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();

/* Uncommitted work in the vendored tree would be destroyed by the copy, and it is the kind of edit somebody
 * makes at 6pm to unblock themselves and expects to still be there tomorrow. Refuse instead. */
function assertClean() {
  let dirty = '';
  try {
    const root = git(WEB, 'rev-parse', '--show-toplevel');
    const paths = PACKAGES.map((p) => relative(root, join(WEB, p.to)));
    dirty = git(WEB, 'status', '--porcelain', '--', ...paths);
  } catch (_) {
    return; // Not a git checkout: nothing to protect and nothing to compare against.
  }
  if (dirty && !has('force')) {
    console.error('The vendored copy has uncommitted changes:\n' + dirty);
    console.error('\nA sync replaces it wholesale, so those edits would be lost. Commit or revert them,');
    console.error('or pass --force if losing them is the point. Changes to the design system belong');
    console.error('upstream: ' + REPO);
    process.exit(1);
  }
}

/** A checkout of the upstream repo containing frontend/packages/ui, and what commit it is. */
function fetchUpstream() {
  const from = flag('from');
  if (from) {
    const root = resolve(from);
    for (const pkg of PACKAGES) {
      if (!existsSync(join(root, pkg.from))) throw new Error(`${root} has no ${pkg.from}`);
    }
    return { root, commit: git(root, 'rev-parse', 'HEAD'), date: git(root, 'log', '-1', '--format=%ad', '--date=short'), ref: 'local:' + root };
  }

  /* Blobless and sparse: the monorepo is large and all that is wanted is one package. --depth 1 as well,
   * because history of a copy is the copy's own history from here on. */
  const tmp = mkdtempSync(join(tmpdir(), 'insightis-ui-'));
  console.log(`fetching ${REPO} @ ${ref} …`);
  git(tmp, 'clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', ref, REPO, 'repo');
  const root = join(tmp, 'repo');
  git(root, 'sparse-checkout', 'set', ...PACKAGES.map((p) => p.from));
  return { root, commit: git(root, 'rev-parse', 'HEAD'), date: git(root, 'log', '-1', '--format=%ad', '--date=short'), ref, tmp };
}

const files = (dir, base = dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name === '.turbo' || entry.name === 'dist') return [];
    return entry.isDirectory() ? files(full, base) : [relative(base, full).replace(/\\/g, '/')];
  });

assertClean();
const upstream = fetchUpstream();

console.log(`\n${upstream.ref} → ${upstream.commit.slice(0, 12)} (${upstream.date})`);

let total = 0;
for (const pkg of PACKAGES) {
  const source = join(upstream.root, pkg.from);
  const target = join(WEB, pkg.to);

  const before = existsSync(target) ? files(target).filter((f) => f !== 'vendored.json') : [];
  const after = files(source);
  const added = after.filter((f) => !before.includes(f));
  const removed = before.filter((f) => !after.includes(f));
  const changed = after.filter((f) => {
    if (!before.includes(f)) return false;
    const a = join(target, f);
    const b = join(source, f);
    return statSync(a).size !== statSync(b).size || readFileSync(a, 'utf8') !== readFileSync(b, 'utf8');
  });
  total += added.length + changed.length + removed.length;

  console.log(
    `\n${pkg.to}: ${after.length} files — ${added.length} added, ${changed.length} changed, ` +
      `${removed.length} removed`,
  );
  const lines = [...added.map((f) => '+ ' + f), ...changed.map((f) => '~ ' + f), ...removed.map((f) => '- ' + f)];
  for (const line of lines.slice(0, 30)) console.log('  ' + line);
  if (lines.length > 30) console.log(`  … and ${lines.length - 30} more`);

  if (check) continue;

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, {
    recursive: true,
    // Both separators: cpSync hands the filter native paths, which on Windows means backslashes.
    filter: (src) => !/[\\/](node_modules|\.turbo|dist)$/.test(src),
  });
  writeFileSync(
    join(target, 'vendored.json'),
    JSON.stringify(
      {
        note: 'Written by web/scripts/sync-design-system.mjs. Do not edit this tree by hand — see vendor/VENDORED.md.',
        repo: REPO,
        package: pkg.from,
        ref: upstream.ref,
        commit: upstream.commit,
        commitDate: upstream.date,
        files: after.length,
      },
      null,
      2,
    ) + '\n',
  );
}

if (check) {
  console.log(`\n--check: ${total} difference(s), nothing written.`);
} else {
  console.log(`\nVendored at ${upstream.commit.slice(0, 12)}. Run npm run check-types and npm run build next.`);
}

if (upstream.tmp) rmSync(upstream.tmp, { recursive: true, force: true });
