# Where MouseFlow stands — 2026-09-11

A handover, written to be read on a machine that has never seen this project. It says what changed on
9–11 September, what is true now, what to do next, and what only the owner can supply.

**Live right now:** app `https://mouseflowapp.vercel.app` (commit `741985c`), docs site
`https://mouse-flow.vercel.app`, agents at **0.29.0**. Whole suite green: **3,065 checks across 26 suites**
(`npm test`), `tsc --noEmit` clean, `web/` builds, and the agent's C# compiles for real.

**The QA roadmap is closed.** Items 1, 2, 3, 5, 6, 7 and 8 are done and item 4 is parked. What is left of
that plan is one small lever and one measurement, both named in §4. The work now moves to the **memory of
applications** and the **split into two products**.

**The four planning documents, and which to read when:**

| | |
|---|---|
| **this file** | where things are, what is next, and how to start on a new machine |
| [`QA-ROADMAP.md`](QA-ROADMAP.md) | the eight-item QA direction. **Section 0 is the house rules — read it before touching anything** |
| [`MEMORY-PLAN.md`](MEMORY-PLAN.md) | skills as a tiered artifact, and a memory of applications. Also holds the shell/tooling notes section 0 of the roadmap lacks |
| [`SITE-DEBT.md`](SITE-DEBT.md) | what the public site owes the product. Site and code are now updated in separate passes |

---

## 1. Starting on a new machine

Two repositories, both on `D:` by convention:

```bash
git clone https://github.com/Aborsen/MouseFlow.git     # the app  → poc/mouse-flow
git clone https://github.com/Aborsen/MouseLanding.git  # the site → D:/MouseLanding
```

**The app repo was renamed `Mouse` → `MouseFlow` at some point, and this checkout's remote still says the
old name.** It works only because GitHub 301-redirects a renamed repository; `git remote -v` on the machine
this was written from still prints `Aborsen/Mouse.git`, and so did the push output that produced the wrong
URL in the first draft of this file. Use `MouseFlow`. If you keep an old checkout,
`git remote set-url origin https://github.com/Aborsen/MouseFlow.git` stops it depending on a redirect.

**`MouseLanding` is private**, so cloning it needs credentials — a GitHub login in the credential manager,
or `gh auth login`. The app repo is public. (An unauthenticated API request for `MouseLanding` answers 404,
which is what a private repository looks like from outside; the repo is there.)

The site's working branch is **`codex/mouseflow-landing`**, not `main`. Then `npm install` in the app root,
in `web/`, and in the site.

### Three things the clone does not carry, and only the owner can

1. **`.env.local` in the app root.** Gitignored, holds `DATABASE_URL` and the rest of the Neon connection.
   Get it from the Vercel or Neon dashboard (or copy it from the old machine). Nothing works against real
   data without it: `npm run migrate -- --list`, the read-only probes, and the local MCP server all read it.
   **Never paste key values into a file that is tracked, and never into a chat.**
2. **The agent, installed and running.** Open the app → **Connect** and use the command it prints; it pipes
   the script straight into a scriptblock, so there is no file to unblock. The page shows the running
   version — it must say **0.28.0**, because the fixes from 9–11 September are agent-side, `clickname`
   among them.
3. **The Chrome extension — BUILT, then loaded unpacked.** This said "select the `extension/` folder",
   and that is the wrong folder: `extension/` is the source, and what Chrome loads is **`extension/dist`**
   — built by `npm run build:extension` in `web/`, gitignored, so a fresh clone does not have it at all.
   Load the source folder and you get the old hand-written popup, no side panel, and a manifest pointing at
   a `sidepanel.html` that only exists in the build.

   ```
   npm run build:extension        # from the repo root; writes extension/dist
   ```

   From the **root**, not from `web/` — the root script exists precisely so nobody has to `cd` first. And
   with no `&&`: the usual shell here is Windows PowerShell 5.1, where `&&` is a parse error, not a
   separator. If you do want two commands, PowerShell joins them with `;`.

   Then `chrome://extensions` → developer mode → **Load unpacked** → select **`extension/dist`**. Its id is
   derived from the folder path, so it differs on every machine; that is expected and the app handles it.
   Rebuild after any change to the extension — Chrome loads the build, not the source.

### Verify the machine before starting work

```bash
npm test
```

Expect zero FAIL. `check-swift` prints `0 passed, 0 failed` — that is correct on Windows, `swiftc` does not
exist there. Then `npx tsc --noEmit -p web/tsconfig.json` and `npm run build` in `web/`.

Read [`MEMORY-PLAN.md`](MEMORY-PLAN.md) §0 next: it holds the shell quirks (the Bash tool needs its `PATH`
set on every call; heredocs with backticks break; how to compile the agent's C# for real) that cost time
before they were written down.

---

## 2. What shipped on 9–11 September

Twenty commits over three days. Eight closed roadmap items; the rest were defects found by *playing recordings back on a real
desktop*, which is the pattern worth keeping — none of them were visible from reading the code.

| commit | what |
|---|---|
| `bcdb9ae` | **Roadmap item 8**: web QA through the extension — `dom`-tier checks, frames, cases Chrome can claim |
| `58e10c6` | **Roadmap item 3**: a recorded click carries its window and element rectangles, and a replay puts the point back inside the window before the agent aims by name |
| `71d1246` | A replay raises the window the **clicks** name, not the sampler's first (which is always MouseFlow); the press that stopped a recording is no longer in it |
| `e240a3d` | "Nothing was captured" is decided by what can be **played**, not by list length — a real recording came back holding one `Focus` note |
| `10c02ff` | The stop trim finds the press or removes **nothing** — the first version stripped trailing movement unconditionally and would have cut 12 of 27 events from a chat-stopped recording |
| `28a20b6` | A **minimised** window is the one to raise; a window that is not open raises nothing and says so |
| `8cb0819` | A `Focus` note written *after* the stop press no longer hides it — this was why the stop was still in the recording after two fixes |
| `339790d` | A taskbar press replays as "show that window"; a replay's finish releases only the buttons it **held** (a bare right-button release was opening a context menu at the end of every replay) |
| `53fb0a4` | [`MEMORY-PLAN.md`](MEMORY-PLAN.md) |
| `4e9f017` | **Roadmap item 5-v2**: a case's check can name the moment it belongs to |
| `6711318` | **Roadmap item 6, lever 1**: the turn's unchanging prefix is cached; two of the item's five levers dropped on measurement |
| `86aed7e` | **Roadmap item 6, lever 2**: `click_named` — one action where "find the button, then click it" was two turns. Agents at 0.28.0 |
| `0600b31` | …and it may go **second** in a turn, so "type the value, then click Save" is one turn too. The batch rule's one pressing exception |
| `045a4f4` | **`mouseflow.skill/2`**, tiers 0 and 1: a skill carries a **procedure in words**, so it can say what it does instead of only being able to do it |
| `c6b4ba1` | **A web recording no longer dies with the worker holding it** — the reported fault, reproduced and fixed |
| `da714b4` | **Roadmap item 7, part 1**: the agent can demand a pairing key; only `/health` answers without it. Agents at 0.29.0 |
| `ae315ca` | **Roadmap item 7, parts 2–3**: a case can name the machine it belongs to, and the QA-machine recipe |
| `e807605` | **The built extension had an import into nothing, and had since item 8** — plus the closure check that will not let it happen again |
| `741985c` | The build command in this file was written for the wrong shell |

### The two things worth carrying forward from that work

**Replaying recorded coordinates is a losing game, and the evidence is four fixes in one day.** Every one
was correct and every one uncovered the next: which window to raise, minimised windows, the taskbar toggle,
the button release. A recorded point is a claim about a screen that no longer exists, and the list of "what
the click actually meant" has no end. **Decision: coordinate replay is frozen, not deleted** — it keeps
working, it keeps its docs page, it stops being invested in and comes off the headline.

**A turn costs the same whatever it does.** Measured over ninety days: median model decision **5,035 ms**,
and it barely moves between actions (`click` 5,238 · `press_key` 5,848 · `type_text` 5,504). The screenshot
is **196 ms**. So the cost is the unchanging prefix re-sent every turn, and the only two levers worth pulling
were caching it and **removing whole turns** — both now done, and everything that chased the 196 ms was
dropped instead of built. The general form of the lesson, which outlives this item: **measure before
optimising, and be willing to delete a planned task on the measurement.** Two of five levers here were
worth more struck than shipped.

---

## 3. The QA roadmap now

| item | state |
|---|---|
| 1 · `expect` | done |
| 2 · artifacts (kept frames) | done |
| 3 · anchored recording | done (`58e10c6`) |
| 4 · hybrid replay | **parked.** It was the bridge between coordinates and the model; with replay frozen the bridge is not needed. [`MEMORY-PLAN.md`](MEMORY-PLAN.md) proposes an application memory instead. **Not struck — the owner's call** |
| 5-v1 · a case as an entity | done |
| 5-v2 · checks bound to a step | done (`4e9f017`), **not as specified** — see below |
| 6 · speed | levers 1 and 2 done; **3 and 5 dropped on measurement**; only lever 4 is left, and it is small. The item's done-condition is a *measurement* — re-run it in October, see below |
| 7 · isolation | **done.** Loopback key in both agents (off by default, on with -RequireKey), a case pinned to a machine, and the QA-machine recipe. Three of the item's own premises were wrong and are corrected in it |
| 8 · web QA via the extension | done (`bcdb9ae`) |

**Three places the roadmap was wrong, now corrected in it:**

- **5-v2 could not be built as written.** It said `expects[i].after` would be a checkpoint *title* "bound to
  the plan's checkpoints". Checkpoints reach the browser driver as a parameter from the Create wizard; a
  **saved skill carries none**, and the unattended cloud driver is handed `toolsFor(false, …)` — no
  `reached_checkpoint` at all, because a checkpoint stops the run until a person answers and on that path
  there is nobody. A number would have pointed at nothing. So the moment is a **sentence** the case's author
  writes, and whoever sees the screen decides when it has come.
- **Item 6's premise was a guessed number.** "~8 s a step" was never measured; it is 5,035 ms. And two of
  its five levers chase the 196 ms screenshot — under 4 % of a turn — so they were dropped rather than done.
- **The next free migration number** was recorded as 019. It is **022**.

---

## 4. What to do next

**The QA roadmap has nothing open left.** Items 1, 2, 3, 5, 6, 7 and 8 are done; 4 is parked as superseded.
Two small things remain *of that plan*, and neither blocks anything:

- **Item 6, lever 4** — `claude-haiku-4-5-20251001` for the wave hand-off and the plan preview. Small, and
  last on purpose: a cheaper model must not be anywhere near a decision that aims a click.
- **The October measurement.** Item 6's done-condition is the median `model` ms under 4,000, and it cannot
  be read yet — the thirty-day window still holds mostly runs decided before prompt caching and before
  `click_named`. Re-run the query in [`QA-ROADMAP.md`](QA-ROADMAP.md) §6 in October, and read **two**
  numbers: the median (where caching shows) and **steps per successful run** (where `click_named` shows).

### The real queue, in order

1. **The memory of applications** — [`MEMORY-PLAN.md`](MEMORY-PLAN.md) §4, built in the order given there:
   `derived` from the 58 recordings already on the account first, `taught` second, `learned` last or never.
   Ships behind a flag and is judged by one number — turns per successful run — or is rolled back. This is
   the next substantial piece of work.
2. **`mouseflow.skill/2` tier 2** — the recording as a *pointer* rather than a copy. Deliberately split off
   from tiers 0–1 because it changes the **replay path**, not the artifact. [`MEMORY-PLAN.md`](MEMORY-PLAN.md)
   §3 names what it needs and the one hazard already found by reading: `mouseflow_run` (`api/mcp.js`, near
   the `row.kind !== 'created'` branch) answers with `body: null, goal: false` the moment a `/2` skill stops
   carrying events — an agent reads that as "not a goal, and nothing to do". Today unreachable; reachable
   the moment tier 2 lands, and it must **refuse with words** rather than quietly do nothing.
3. **Splitting the product in two** — the owner's decision, 2026-09-11. A documentation product (record work
   → a process document) and a QA product (goal loop + checks + verdicts), on one engine. `skill/2` was
   built to serve both: `procedure.steps` read as documentation, `procedure.verification` runs as checks.
4. **The site pass** — [`SITE-DEBT.md`](SITE-DEBT.md), and the `.mmmacro` positioning question belongs
   here rather than to an engineering cleanup (§5).

### The extension is being narrowed, not grown

**Owner's decision, 2026-09-11: the extension is a tool for recording skills, not a second application.**
Part of it will be cut. Do not add screens to it. Two consequences for whoever picks this up:

- The **side panel** is the right surface for what remains, and it already exists — a popup closes the
  moment you click the page, and recording a flow *is* clicking the page. It needed no work, only a build.
- The recording path is the part that survives the cut, which is why `c6b4ba1` was worth doing properly
  rather than patching.

## 5. Open questions that need the owner, not code

1. **Is roadmap item 4 struck?** Everything above assumes it is superseded. Say so and it comes out of the
   roadmap; say no and it goes back in the queue.
2. **Which of the two products leads?** It decides whose vocabulary gets the site's front page — and the
   answer shapes the site pass in [`SITE-DEBT.md`](SITE-DEBT.md) §2.
3. **The name.** `MouseFlow` describes the mechanism rather than the outcome, and there is an established
   product called Mouseflow (mouseflow.com, behaviour analytics — worth verifying) whose adjacency is a real
   collision for the documentation product. Cheap to change now, expensive later.
4. **The web memory key** — [`MEMORY-PLAN.md`](MEMORY-PLAN.md) §4.3. Proposed default: two tiers,
   `win32:chrome` for the browser shell and `web:<origin>` for the page. Needs a yes or a different answer
   before that plan's step 3.
5. **Migration `db/022_queue_machine.sql` is approved but NOT YET APPLIED** — the one thing left over from
   this session, and it needs a machine that has the database.

   The owner approved it on 2026-09-11; it could not be run because this machine has no `.env.local`, which
   is the connection string and one of the three things a clone does not carry (§1). On a machine that has
   it, from the repo root:

   ```
   npm run migrate
   npm run migrate -- --list
   ```

   Until it runs, pinning a case to a machine is **inert and says so** when a pinned case is queued — the
   code was deliberately written to work without the column rather than to require it. Nothing is broken by
   waiting.

   **The memory plan's own migration was renumbered 022 → `023_app_memory.sql`** because item 7 took 022.
   Never reuse a number: `migrate.mjs` walks the files in name order and records what it ran by name, so
   two files sharing one means the second silently never runs.
6. **`.mmmacro` compatibility** — asked and **answered on 2026-09-11: leave it alone for now**, and revisit
   it with the site pass rather than as an engineering cleanup. The analysis is in
   [`SITE-DEBT.md`](SITE-DEBT.md)'s neighbourhood: storage is already JSON, there is exactly one parser, and
   the five-column wire earns its keep. Two findings from it are still open — `exportMacro` silently drops
   `role`, `subrole`, `in`, `inName`, `url`, `side` and `near` that `flowBody` sends, so an
   export→import round trip is lossy today; and the growing `#ctx` sidecar, not Mini Mouse Macro, is the
   actual design smell.

---

## 6. Conventions that will bite a fresh session

All of these are load-bearing here, and all were learned the hard way:

- **Push when green, without being asked.** Green means `npm test` with zero FAIL, `tsc --noEmit` clean,
  `npm run build` in `web/` ok. Then wait for the deploy — `/build.json` shows the commit — and tell the
  owner **one concrete thing to check**. Not green: do not push, and say what failed.
- **A pin that was never seen failing is not a pin.** Break the rule it guards, watch it FAIL, restore.
  Every pin added on 9–10 September was proven this way.
- **No false greens.** Success is *claimed* and, where possible, checked. `blocked` is never collapsed into
  `fail`; absence is never rendered as a negative fact.
- **One implementation, many readers.** When a rule is added, it is added once and imported — the brain is
  shared by two drivers, `_case.mjs` by three readers.
- **A step's name is `step.tool || step.name`.** The extension writes one, both desktop drivers write the
  other. Reading a single field silently returns zero on web runs; that was a real defect, fixed in
  `4e9f017`.
- **Commits here and in MouseLanding are authored as `raudar.aborsen@gmail.com`.**
- **The shell here is Windows PowerShell 5.1, and `&&` is a parse error in it** — not a chain. Join with
  `;`, or use two lines. This cost a round trip on 2026-09-11 because a command in this very file was
  written in bash. Where a root-level npm script exists, use it rather than `cd`-ing: `build:extension`
  exists at the root precisely so nobody has to.
- **Chrome loads `extension/dist`, never `extension/`.** The source folder is the hand-written half plus a
  legacy popup; the panel and the bundled UI only exist after `npm run build:extension`. `extension/dist`
  is gitignored, so a fresh clone has none of it. **Rebuild after every extension change** — Chrome is
  running the build, not the files you edited.
- **The extension build copies its hand-written half BY NAME** (`COPY` in `web/vite.extension.config.ts`).
  A new file that an already-copied file imports is otherwise shipped nowhere, and it fails in Chrome at
  module load rather than at build time — which had been true of `checks.js` since roadmap item 8 shipped,
  meaning the built worker did not start at all. A closure check in `extension/check-extension.mjs` now
  fails `npm test` if any copied file imports something the build would leave out. Add the name when you
  add the file.
- **Read Swift edits twice; compile the C# for real.** `swiftc` does not exist on Windows, so the macOS
  agent is guarded by text pins only — a second read found a genuine compile error on 2026-09-11
  (a top-level `var` used above its declaration, which `main.swift` refuses). The Windows agent's C# *can*
  be compiled, and should be for any non-trivial edit — see [`MEMORY-PLAN.md`](MEMORY-PLAN.md) §0.
- **A pin that passes with and without the fix is not a pin.** One was written on 2026-09-11 to guard a
  race the harness cannot reproduce (the old module instance never dies, so the message goes to the old
  worker either way). It was **removed and replaced by a source pin that says why**, rather than left green
  for appearance. Two others were caught matching their own explanatory comments — check code, not prose
  about code.
