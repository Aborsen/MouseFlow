# Where MouseFlow stands — 2026-09-11

A handover, written to be read on a machine that has never seen this project. It says what changed on
9–10 September, what is true now, what to do next, and what only the owner can supply.

**Live right now:** app `https://mouseflowapp.vercel.app` (commit `6711318`), docs site
`https://mouse-flow.vercel.app`, agents at **0.27.0**. Whole suite green: 1251 source pins, 537 contract
checks, 21 executable suites.

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
git clone https://github.com/Aborsen/Mouse.git         # the app  → poc/mouse-flow
git clone https://github.com/Aborsen/MouseLanding.git  # the site → D:/MouseLanding
```

The site's working branch is **`codex/mouseflow-landing`**, not `main`. Then `npm install` in the app root,
in `web/`, and in the site.

### Three things the clone does not carry, and only the owner can

1. **`.env.local` in the app root.** Gitignored, holds `DATABASE_URL` and the rest of the Neon connection.
   Get it from the Vercel or Neon dashboard (or copy it from the old machine). Nothing works against real
   data without it: `npm run migrate -- --list`, the read-only probes, and the local MCP server all read it.
   **Never paste key values into a file that is tracked, and never into a chat.**
2. **The agent, installed and running.** Open the app → **Connect** and use the command it prints; it pipes
   the script straight into a scriptblock, so there is no file to unblock. The page shows the running
   version — it must say **0.27.0**, because three fixes from 9–10 September are agent-side.
3. **The Chrome extension, loaded unpacked.** `chrome://extensions` → developer mode → **Load unpacked** →
   select the `extension/` folder. Its id is derived from the folder path, so it differs on every machine;
   that is expected and the app handles it.

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

## 2. What shipped on 9–10 September

Ten commits. The first three closed roadmap items; the rest were defects found by *playing recordings back
on a real desktop*, which is the pattern worth keeping — none of them were visible from reading the code.

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

### The two things worth carrying forward from that work

**Replaying recorded coordinates is a losing game, and the evidence is four fixes in one day.** Every one
was correct and every one uncovered the next: which window to raise, minimised windows, the taskbar toggle,
the button release. A recorded point is a claim about a screen that no longer exists, and the list of "what
the click actually meant" has no end. **Decision: coordinate replay is frozen, not deleted** — it keeps
working, it keeps its docs page, it stops being invested in and comes off the headline.

**A turn costs the same whatever it does.** Measured over ninety days: median model decision **5,035 ms**,
and it barely moves between actions (`click` 5,238 · `press_key` 5,848 · `type_text` 5,504). The screenshot
is **196 ms**. So the cost is the unchanging prefix re-sent every turn, and the only levers worth pulling
are caching it (done) and **removing whole turns** (next).

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
| 6 · speed | lever 1 done; **levers 3 and 5 dropped on measurement**; lever 2 is the whole remaining item |
| 7 · isolation | open, untouched |
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

**First: lever 2 of item 6 — one action instead of two turns.** Today "find the button, then click it" is
two turns because `click` is aimed at the picture. A new `click_named` (agent action
`action=clickname title=<name> [process=]`, capability flag `canClickName`) resolves and clicks in ~30 ms.
At 5 s a turn and 13 turns a run, removing a third of the turns on form-heavy goals is the largest single
win available anywhere in the project. Both agents; the brain offers the tool only when the flag is present.
**~3 days.** Compile the agent's C# for real before pushing — see [`MEMORY-PLAN.md`](MEMORY-PLAN.md) §0.

**Then, in order of value rather than roadmap number:**

1. **`mouseflow.skill/2`** — [`MEMORY-PLAN.md`](MEMORY-PLAN.md) §3. A skill whose body is a procedure in
   words with the recording as a *pointer*, not a copy. It is what makes the same artifact serve both
   products, and it is the prerequisite for everything in that plan. Every reader of `skill.events` is
   already listed there with what each becomes.
2. **The application memory** — [`MEMORY-PLAN.md`](MEMORY-PLAN.md) §4, built in the order given there:
   `derived` from the 58 recordings already on the account first, `taught` second, `learned` last or never.
   Ships behind a flag and is judged by one number — turns per successful run — or rolled back.
3. **The site pass** — [`SITE-DEBT.md`](SITE-DEBT.md). One entry is a ready-to-paste section plus the stale
   line it replaces; the other is the positioning the site has not caught up with.
4. **Item 7, isolation** — a machine the tests may own. Untouched, and the least urgent of these.

**One thing parked with a diagnosis, not a mystery.** On the owner's machine `TaskbarSwitch` still did not
raise the terminal or Outlook. A read-only probe showed the taskbar *is* recognised (`GA_ROOT =
Shell_TrayWnd` under both press points) and that `WindowMatching("Windows PowerShell", "")` returns the
Windows Terminal process as the only match — very likely the terminal hosting the agent, which `Mine()`
refuses on purpose. The Outlook case is unexplained. Next diagnostic: log `Activate`'s refusal string from
inside `TaskbarSwitch`. Do not spend on it before deciding whether coordinate replay matters at all.

---

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
5. **Migration 022** exists only as SQL in [`MEMORY-PLAN.md`](MEMORY-PLAN.md) §4.11 and is **not applied**.
   It never will be without explicit approval — that is a standing rule.

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
