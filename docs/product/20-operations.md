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

- **`SENTRY_AUTH_TOKEN` is deliberately not in Production**, and putting it back costs four minutes a
  deploy. With it, three builds in a row took 3m, 3m and 5m; without it, the next one took **23s** — same
  commit, nothing else changed. Build CPU Minutes are 87% of this project's bill, so that one variable is
  worth about eight times everything else on it. `VITE_SENTRY_DSN` stays, so the browser still reports
  errors; what is lost is readable stack traces. The cost is not the upload (0.368s in the log) and not the
  maps (no measurable cost, even with the heap held to 640MB) — it is the Vite plugin's own pass over the
  output. See the long note in `web/vite.config.ts` before changing this.

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

### Backup and restore

**What Neon gives you is not a backup.** On the free plan the *Restore from history* window is six hours,
there are no snapshots and no schedule, and all of it lives inside the same project. It covers "I deleted the
wrong rows half an hour ago". It does not cover a mistake noticed the next day, a deleted project, or an
account that stops working. A copy that lives inside the system it insures is not insurance.

Measured, so the numbers are not guesses: the database is **15 MB**, of which 5.4 MB is `user_flow` (166
recordings). A compressed custom-format dump is a few megabytes, which means a daily backup kept for ninety
days is a few hundred megabytes - inside every free object-storage tier there is.

```bash
node scripts/backup.mjs                 # dump → encrypt → bucket → verify
node scripts/backup.mjs --local         # dump to this folder, no bucket (before a migration)
node scripts/backup.mjs --list          # what the bucket holds
```

Daily at 02:17 UTC by `.github/workflows/backup.yml`, and by hand from the Actions tab.

**Three decisions in it worth knowing:**

- **It encrypts with a public key** (`age --recipient`), so the job that makes the backups cannot read them.
  A passphrase in a secret would have given CI both write and read; the private key is in a password manager
  and is needed only to restore. A dump carries what [17 - Privacy](17-privacy-security.md) calls sensitive -
  window titles, control names, page addresses, the wording of goals - so this is the right asymmetry.
- **It will not silently upload plaintext.** With no recipient configured it stops and says what is missing.
  `--plaintext` exists, only alongside `--local`, and has to be typed.
- **It dumps through the unpooled host.** `DATABASE_URL` from Vercel is the `-pooler` one; Neon's own advice
  for `pg_dump` is a direct connection, so the script rewrites the host rather than making anybody keep a
  second connection string.

The bucket is Backblaze B2 (S3-compatible), and the key it is reached with matters as much as the bucket.

**In the B2 web interface, make the key *Read and Write*.** Not *Write Only*: the script `HEAD`s the object
it has just uploaded and compares the size, because an upload that answered 200 and stored nothing looks like
success until the day it is needed - and `--list` reads the bucket too. Leave *Allow List All Bucket Names*
unchecked (nothing here calls S3 `ListBuckets`; listing objects *inside* a bucket is a different right), and
leave *Duration* empty - a key that expires turns a daily backup into a silent one.

**Three traps that each cost a failed run:**

- **A bucket name with capitals cannot be addressed the usual way.** B2 lets you create `MouseFlow`; the
  normal S3 address puts the name into the *hostname*, and hostnames are case-insensitive, so every request
  comes back `NoSuchBucket` while the bucket plainly exists. The script detects a name that is not DNS-safe
  and switches to path-style (`https://<endpoint>/<bucket>/<key>`), which keeps the case - B2 and R2 both
  support it. A new bucket is still better named in lowercase; an existing one cannot be renamed.

- **The account master key does not work with the S3-compatible API at all.** It answers
  `InvalidAccessKeyId`, which reads like a typo rather than a category error. Use *Add a New Application Key*.
- **`keyID` and the key itself are two different values.** `BACKUP_S3_KEY_ID` wants the short one. And they
  must come from **the same** key: the keyID stays visible in the list forever while the key is shown once,
  so pairing a fresh keyID with last attempt's key is the easy mistake. It answers `SignatureDoesNotMatch`,
  which reads like a region problem and is not one.

**A key that cannot delete is worth having, and the web interface cannot make one** - it offers only Read and
Write / Read Only / Write Only. Granular capabilities need the CLI:

```bash
b2 key create --bucket mouseflow-db-backups mouseflow-backup listBuckets,listFiles,readFiles,writeFiles
```

No `deleteFiles`, so a key leaked out of CI can add backups and cannot destroy the ones already there. Do it
once the first run has succeeded; expiry is then handled by a **lifecycle rule on the bucket** (delete after
90 days), which is server-side and needs no delete rights on any key.

#### The six secrets

`Settings → Secrets and variables → Actions → New repository secret`, in `Aborsen/Mouse`:

| Secret | Where it comes from |
|---|---|
| `DATABASE_URL` | `vercel env pull`, or the Neon connection string |
| `BACKUP_S3_ENDPOINT` | the bucket's S3 endpoint, e.g. `s3.eu-central-003.backblazeb2.com` |
| `BACKUP_S3_BUCKET` | the bucket name |
| `BACKUP_S3_KEY_ID` | B2 *App Keys* → keyID |
| `BACKUP_S3_APP_KEY` | the key itself, shown once |
| `BACKUP_AGE_RECIPIENT` | the public half of `age-keygen -o backup-key.txt` (`age1…`) |

**On Windows, `winget install FiloSottile.age` does not put it on `PATH`** - `age-keygen` answers *"is not
recognized as the name of a cmdlet"* while the package is installed. The binaries land in
`%LOCALAPPDATA%\Microsoft\WinGet\Packages\FiloSottile.age_*\age\`. Call `age-keygen.exe` there by its
full path once to make the key, and give the script `AGE_BIN=<path to age.exe>` rather than editing `PATH`.
The GitHub runner installs it from apt, where it is on the path like anything else.

The region is read out of the endpoint name; there is no seventh secret for it.

#### Restoring

Needs the **private** age key, which is deliberately not anywhere near CI.

```bash
node scripts/backup.mjs --list                      # pick the one you want
curl --aws-sigv4 "aws:amz:<region>:s3" \
  --user "$BACKUP_S3_KEY_ID:$BACKUP_S3_APP_KEY" \
  -o backup.dump.age \
  "https://<bucket>.<endpoint>/mouseflow/2026/09/2026-09-01T021700Z.dump.age"

age --decrypt --identity backup-key.txt -o backup.dump backup.dump.age
pg_restore --dbname "<target connection string>" --no-owner --no-privileges --clean backup.dump
```

**Restore into a fresh Neon branch, never over the live one**, until you have looked at what came back. A
branch is free, and the difference between "the backup is fine" and "the backup was fine" is which database
you found out on.

> [!IMPORTANT]
> **A backup nobody has restored is not a backup.** Same argument as the check nobody has watched fail: the
> only evidence a dump is usable is a `pg_restore` that finished and a row count that matches. Do it once now,
> into a throwaway branch, and once a quarter after that.

**What is not automated yet:** that restore rehearsal. It could be a monthly job - restore the newest dump
into a scratch Neon branch, compare row counts, drop the branch - and it needs a Neon API key, which is a
decision rather than a line of code.

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

## The documentation's screenshots

```bash
node scripts/shoot-docs.mjs
```

Regenerates every picture in `docs/img` from the running app — twenty-seven of them, in about two minutes.
Run it after any change to a screen these documents show, and **look at the results before committing**: the
script cannot tell a rendered page from a rendered error, and a screenshot is a claim.

It starts the dev server itself with the account fixture (`MOCK_API=1`) and serves it over HTTPS **under the
deployment's own hostname**, resolved to loopback by the browser it launches — without that, every picture
shows `localhost:4400` as the address to paste into an AI client, which is worse than no picture. Two shots
are staged, with only the agent's `/health` and `/api/mcp?pending=1` stubbed, because they show a computer
that is *not* attached to an account and any machine this runs on is. The consent page is rendered from
`consentPage()` in `api/oauth.js` rather than mocked up.

Needs Google Chrome and, for the downscale at the end, macOS `sips`. The script's own header explains the
three non-obvious things it does; each of them was a bug first.

`node mcp/test-mcp.mjs` checks that every screenshot a document references actually exists, which is the half
that can be automated.

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
