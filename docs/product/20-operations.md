# 20 — Operations

## Repository layout

```
agent/
  mouseflow-agent.ps1      the Windows agent, one file
  mouseflow-agent.swift    the macOS agent, one file
  install-mac.sh           fetches, compiles, signs, registers and starts it
  PROTOCOL.md              the normative agent contract
  test-contract.mjs        94 checks, both agents against that contract
api/                       Vercel serverless functions (_-prefixed files are not routes)
db/                        SQL migrations, applied in order
docs/
  DEBUG-MAC.md             per-platform debugging: what is verified, what is not
  DEBUG-WINDOWS.md
  product/                 this documentation
extension/                 the Chrome extension (MV3)
scripts/
  migrate.mjs              the migration runner
  auth-origin.mjs          trusted origins for Neon Auth
web/
  src/                     the app: shell/, features/, lib/, components/
  public/agent/            the agent files, copied in at build time
  vendor/insightis-ui/     the vendored design system, verbatim
  scripts/                 copy-agent, dev-mock, sync-design-system
vercel.json                headers, rewrites, build command
```

## Deploying

Point a Vercel project at the repository root.

| Setting | Value |
|---|---|
| Framework preset | **Other** |
| Build command | `cd web && npm install --no-audit --no-fund && npm run build` |
| Output directory | `web/dist` |

Two things that have gone wrong before and will again:

- **A `null` framework preset deploys "Ready" and serves `NOT_FOUND`.** Set it to *Other* in project
  settings.
- **`vercel redeploy` is the wrong tool on this project.** Redeploying the last production deployment has
  produced a Ready build with the static output and **no serverless function**, so `/api/*` began answering
  Vercel's `NOT_FOUND` while the site root served fine. That reads like a routing problem and is actually a
  missing build step. **Push a commit** — the Git integration builds the same commit correctly.

Adding or rotating an environment variable also needs a new build: a function reads `process.env` from its own
deployment's captured environment, so a variable added afterwards does not reach the deployment already
serving. `GET /api/claude` reports `configured: false` until then.

Check a deployment before relying on it:

```bash
curl https://<origin>/api/claude
```

`{"ok":true,"configured":true,…}` means a key is set. It reports a boolean and nothing else — a prefix, a
suffix or even a length would narrow a guess — and costs nothing upstream.

## The database

```bash
vercel env pull .env.local        # DATABASE_URL, gitignored
node scripts/migrate.mjs          # apply anything outstanding
node scripts/migrate.mjs --list   # what has run and what has not
```

A plain runner rather than a migration framework: there are four SQL files and the project has no build step,
so a framework would be more machinery than the thing it manages. What it does have is the part that matters —
**a record of what has already run**, so applying twice is a no-op and a half-finished run can be resumed.

`DATABASE_URL` is read from the environment, or from `.env.local` if `vercel env pull` wrote one.

### Sign-in will not work until an origin is trusted

Neon Auth is Better Auth behind a Neon endpoint, and it will only issue a sign-in redirect for a callback URL
whose origin it trusts. A fresh resource trusts nothing, so `/sign-in/social` answers `INVALID_CALLBACKURL`
for every origin.

```bash
node scripts/auth-origin.mjs                       # show what is trusted
node scripts/auth-origin.mjs https://example.com   # trust that origin too
node scripts/auth-origin.mjs --remove https://…    # stop trusting it
```

Additive and idempotent. It writes the same `neon_auth.project_config` row the Neon Console writes — not a
shortcut around the console, but repeatable, reviewable, and not dependent on finding a panel that has moved.

**The shape matters:** the column holds objects (`[{ "domain": "https://example.com" }]`), not strings. This
script once assumed strings, and every consequence was a failure that **reported success** — the listing
printed `[object Object]`, an add compared a string against an object and always "added" a bare string Neon
then ignored, and a remove filtered on a comparison no object satisfies. A malformed entry sat there unseen
and unfixable.

## Developing the web app

```bash
cd web
npm install
npm run dev          # port 4400, /api proxied to the deployment
npm run dev:mock     # port 4400, /api served from an in-memory fixture
npm run build        # tsc --noEmit, then vite build
npm run check-types
```

The dev proxy targets the **deployment** rather than a local server, because these endpoints are Vercel
functions with a database and an OAuth issuer behind them — reproducing that locally would be a second
environment to keep in step, and the point of the dev server is the UI.

`dev:mock` exists so the UI can be worked on **without a session**. It is dev-server middleware and has no
path into a build. Either the proxy or the mock, never both: Vite installs the proxy before plugin
middleware, so a mock behind a live proxy is a mock that never answers.

**The mock's shapes are the real ones.** A mock shaped differently from the endpoint it stands for teaches the
UI to expect the wrong thing, which is how a fake becomes worse than nothing.

`npm run dev` and `npm run build` both run `scripts/copy-agent.mjs` first, which copies the three agent files
into `web/public/agent/`. A missing file is a **failure, not a skip**: the whole install path on either
platform is "fetch this from the origin", and a deployment that silently shipped without one would answer 404
to the only command the Connections screen offers.

## The vendored design system

`web/vendor/insightis-ui` is a **verbatim copy** of the Insightis `@insightis/ui` package, its own layout
intact. Nothing is rewritten on the way in — not a path, not an import, not a config — so every internal
`./src/lib/constants` and every `@insightis/ui/Typography` still means what it meant upstream. **The app bends
to the package** (the aliases in `vite.config.ts` and `tsconfig.json`), never the other way round.

```bash
cd web
npm run sync:ui                    # re-copy from master
npm run sync:ui -- --ref v1.2.3    # a tag, branch or commit
npm run sync:ui -- --from ../../..  # an existing checkout
npm run sync:ui:check              # say what would change, touch nothing
```

Why a script and not a submodule or a published package: the upstream is a pnpm workspace behind Devart's
GitLab, and `@insightis/ui` depends on sibling workspace packages for its tooling. A submodule would drag the
whole monorepo in and still need a build step; npm cannot install from it at all. A copy is what actually
works — so the copy is made **reproducible** instead of made by hand.

**Local edits are lost on the next sync**, so the script refuses to run when the vendored tree has
uncommitted changes. Fix things upstream; that is where the design system lives. What was taken is recorded in
`vendor/insightis-ui/vendored.json` — repo, ref, commit, date — so "which version is this?" has an answer that
does not depend on anybody's memory.

## Tests

```bash
node agent/test-contract.mjs     # 94 checks: both agents against PROTOCOL.md
cd web && npx tsc --noEmit       # the shared client
```

The contract suite is the one that matters across platforms. It **parses the route table out of
`PROTOCOL.md`** and asserts that both implementations answer every path, that `/health` carries the same field
names, that the event words match, and that neither reads a key code. It cannot compile Swift or run
PowerShell — which is exactly why it checks the things that can be checked without either. It has caught real
regressions, including a stop command that stopped working when the macOS agent became a login item with
`KeepAlive`.

The extension's own halves run under Node against stubs; see [13 — The extension](13-extension.md#testing-without-loading-it).

**Current state: 94 passed, 0 failed.**

## Debugging a platform

Start with the platform's own document; each opens with one command that collects the facts.

```bash
# macOS
bash <(curl -fsSL https://<origin>/agent/install-mac.sh) --doctor
```

```powershell
# Windows
irm https://<origin>/agent/mouseflow-agent.ps1 | iex   # the banner is the first diagnosis
curl.exe -s http://127.0.0.1:8787/health
```

Both documents also record **what is verified and what is not**, which is what makes a first session on an
unfamiliar machine productive instead of archaeological.

## Moving the work to another machine

A session does not travel between machines; the repository does, and it has been kept deliberately
self-describing for exactly this. `agent/PROTOCOL.md` is the contract both agents implement, the two DEBUG
documents say where things stand per platform, and **the commit messages say why each decision is the way it
is** rather than what changed — `git log` on this repository reads as an account of the reasoning.

```bash
git clone https://github.com/Aborsen/Mouse.git
cd Mouse
npm --prefix web install
```

That approach has been tested in the strongest way available: the Windows tray icon was written on a Mac,
against a machine it could not touch, and worked on the first run there — after one compile error found by
reading rather than by running.
