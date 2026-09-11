# Skills as a tiered artifact, and a memory of applications — the plan, in enough detail to be executed

Written 2026-09-10 for whoever picks this up next, in a fresh session, with none of the conversation that
produced it. Everything below was checked against the code on that date; where a claim depends on a line
number, the symbol is named too, so `grep` finds it after the line moves.

**Read `docs/QA-ROADMAP.md` → section 0 first** ("How to work in this repository"), and
[`STATUS.md`](STATUS.md) for what is already done — this file is a plan, not a report, and section 1 below
is only current to 2026-09-10.

## 0. What section 0 of the roadmap does not yet say

Learned on 2026-09-09/10, none of it written anywhere else:

- **The Bash tool here needs its PATH set on every call**:
  `export PATH="/usr/bin:/mingw64/bin:/c/Program Files/nodejs:/c/Program Files/Git/cmd:$PATH";`
- **Heredocs with backticks or nested quotes break in that shell.** Write edit scripts with the Write tool
  and run them with `node`. Working-copy files are often CRLF: normalise the search string
  (`const fix = t => crlf ? t.replace(/\r?\n/g,'\r\n') : t`) and refuse an ambiguous match
  (`s.indexOf(a) !== s.lastIndexOf(a)` → throw). Both bit us more than once.
- **`agent/check-csharp.mjs` is a text proxy, not a compiler.** The C# block *can* be compiled for real on
  this Windows machine: extract the here-string between `-TypeDefinition @'` and `'@` and pass it to
  `Add-Type -ReferencedAssemblies 'System.Drawing','System.Windows.Forms','UIAutomationClient','UIAutomationTypes','WindowsBase'`
  in `powershell.exe`. Do this for any non-trivial agent edit. `swiftc` does not exist here; the Swift half
  is guarded by text pins only (`agent/test-contract.mjs`), so read Swift edits twice.
- **Every new pin is proven by mutation**: break the rule it guards, watch it FAIL, restore. A pin that was
  not seen failing is not a pin. This is how the codebase works; keep to it.
- **Agent version bumps** live in **five** places, and the fifth was found stale by twenty versions on
  2026-09-11 because nothing named it: `Version = "…"` (ps1), `let VERSION = "…"` (swift), `AGENT_WANTS`
  in `web/src/lib/agent.ts`, the pins on it in **both** `mcp/test-mcp.mjs` and `agent/test-contract.mjs`
  (search `AGENT_WANTS = '0\.`), and the table in `docs/product/18-configuration.md`, which is prose and
  so no pin catches it. Agents are at **0.28.0**.
- **Live hosts.** The app is `https://mouseflowapp.vercel.app` (`/build.json` shows the deployed commit);
  the docs site is `https://mouse-flow.vercel.app`. `mouseflow.ai` is parked and not pointed at Vercel.
- **Read-only probes against production data** are how most of yesterday's defects were found. Pattern: a
  throwaway `_probe.mjs` in the repo root (so `@neondatabase/serverless` resolves), `DATABASE_URL` read
  from `.env.local`, queries on `user_flow` by `client_id`; a recording's events are at
  `payload.events` (top level, *not* `payload.recordings[0]`). Delete the probe before committing.
- **Executable suites** are `api/_test-*.mjs`, each added to the `test` script in `package.json`
  (`api/_test-macro.mjs` and `api/_test-anchor.mjs` are the most recent). Source pins: `agent/test-contract.mjs`
  (537 checks) and `mcp/test-mcp.mjs` (1238, includes the expected-routes list and the MCP tool count, 18).

- **A new capability flag** touches six places, all of them small and all of them required for the flag to
  do anything: `/health` in both agents, the `caps` object each agent sends with `?worker=step` (the cloud
  driver has no other way to learn it — nothing on that path may reach into the machine), `AgentHealth` in
  `web/src/lib/agent.ts`, the filter in `toolsFor` (`api/_brain.mjs`, one implementation for both
  drivers), and the `caps` argument threaded through `advance` and `runOnDesktop`. `canClickName` on
  2026-09-11 is the worked example; grep it to see all six at once.

## 1. Where things stand (2026-09-10)

Shipped and live: commits `71d1246 … 339790d`. In order: a recording no longer contains the press that
stopped it (agent-side for the tray, `dropOwnTail` in `api/_macro.mjs` for the app's own button); a replay
raises the window the *clicks* name (`whichWindow`) rather than the sampler's first window; a minimised
window is matched for raising (`matchWindow(ctx, list, { evenMinimized: true })`); a missing window raises
nothing and says so; the replay's finish releases only the buttons it held (`ReleaseHeldButtons`); a taskbar
press is played as "show that window" (`TaskbarSwitch` / `OnTaskbar`, reported as `switched`).

**One thing is parked, not fixed.** On the owner's machine `TaskbarSwitch` still did not raise the terminal
or Outlook. A read-only probe showed `OnTaskbar` is right (`GA_ROOT = Shell_TrayWnd` at both points) and
that `WindowMatching("Windows PowerShell", "")` returns pid 23560 (WindowsTerminal) as the *only* match.
Leading hypothesis: that terminal hosts the agent itself, so `Mine()` refuses it — correctly. The Outlook
case is unexplained (matching found the right Chrome window, not minimised). Next diagnostic: log
`Activate`'s return string inside `TaskbarSwitch` when it refuses. **Do not spend on this before section 2
is read** — it may not matter.

## 2. Decisions taken, and two corrections

**Two products, one engine (2026-09-10).** *Documentation*: record work → a process document; read-only,
no input injection. *QA / an agent acting for you*: goal loop + `expect` checks + verdicts; acts through the
model, not through recorded coordinates. One codebase, one app, one agent install; two doors on the site.

**Coordinate replay is frozen, not deleted.** Four fixes in one day were all one class — a recorded point is
a claim about a screen that no longer exists — and the list of "what the click meant" is endless. Stop
investing; keep it working; take it off the headline. Roadmap item 4 (hybrid replay) is *proposed*
superseded by section 4 below — the owner has not struck it yet.

**Correction 1.** "Three tiers of skill disclosure are nearly free and save prompt tokens" — **wrong**. Skills
are not in the system prompt at all: `SYSTEM` (`api/_brain.mjs`) plus the goal text, and the chosen skill's
goal *is* the goal (`fillGoal` in `extension/skills.js`). Seventeen skills cost what two hundred would. The
tiers matter for a different reason (section 3).

**Correction 2.** "Seed the memory with the four facts fixed yesterday" — **only as ledger entries**. All four
are facts about *Windows* or about *us*, universal and testable; they belong in code and are there. Putting
them in an editable memory duplicates a rule where it can drift from the code that enforces it. They enter
the memory with provenance `builtin`, read-only, shown in the ledger, **never in the prompt** (section 4.9).

## 3. Step 1 — `mouseflow.skill/2`: the skill as a tiered artifact

> **Tiers 0 and 1 shipped 2026-09-11.** The format is `/2`, both versions are read, the newest is written,
> a `/1` is augmented on read and keeps its own version, and the procedure shows on the Skills page above
> the event count. `extension/procedure.js` derives it; the server only reads. New executable suite
> `api/_test-skills.mjs` (47 checks) — the one place that can load both halves of the product and stop the
> two copies of the format string disagreeing. Every pin proven by mutation.
>
> **Tier 2 — `source` as a pointer — is NOT done, and it is the next commit.** It was split off on
> purpose: it changes the replay path rather than the artifact. What it needs, and the one hazard already
> found by reading:
>
> - **The extension has no road back to the events.** `eventsFor` (`web/src/features/record/events-for.ts`)
>   is web-app code using `fetchPayload`; the extension is a separate runtime and reaches the account
>   through its own bridge. So `flowFor` resolving `source.flowId` means giving the extension that road,
>   or resolving before the job is handed over.
> - **`mouseflow_run` would hand out an unrunnable job.** `api/mcp.js` (~1813) builds the replay body only
>   when `payload.events` is non-empty, and then answers with `body: null, goal: false` — an agent reads
>   that as "not a goal, and nothing to do". Today unreachable, because a `/2` skill still carries its
>   events; the moment tier 2 drops them it is reachable, and the honest fix belongs in the same commit:
>   resolve the source flow there, or refuse **with words**. It must not become a job that quietly does
>   nothing and reports done.
> - **A shared `/2` skill points at a flow on the AUTHOR's account**, which the recipient cannot read. That
>   is consistent with two products - a document travels, a run stays on your own account - but it is a
>   product decision worth stating on the Skills page rather than discovering.



### Why

A `kind: 'recorded'` skill today **is** its events: `skillFromRecording` (`extension/skills.js`) copies
`rec.events` into the skill, and every reader consumes them directly. That is what makes a skill a coordinate
replay. Borrowed from Hermes' `SKILL.md` (which is worth borrowing): a skill whose body is a **procedure in
words**, with the recording as **reference material** it points to. The same artifact then serves both
products — `Procedure` reads as documentation, `Verification` runs as checks (it *is* our `expects`),
`Pitfalls` is where application memory will accumulate.

### The format

`SKILL_FORMAT` becomes `'mouseflow.skill/2'`. A `/2` skill has:

| tier | field | what | size |
|---|---|---|---|
| 0 | `name`, `description` | as today | ~40 chars |
| 1 | `procedure` | `{ whenToUse, steps[], pitfalls[], verification[] }` — `steps` are sentences distilled from the transcript (`api/_transcript.js` already produces them); `verification` uses the `expects` shape from `api/_case.mjs` | ~2k chars |
| 2 | `source` | `{ flowId, events: 'onAccount' }` — a **pointer** to the recording, never a copy | one id |

**`/1` stays importable forever.** `importSkills` (`extension/skills.js`, the branch that checks
`raw.events`) accepts both; a `/1` skill is upgraded on read by deriving `procedure` from its events and
keeping `events` as the source. Never rewrite a stored `/1` in place — export must round-trip what was
imported.

### Every reader of `skill.events`, and what each becomes

Found by `grep -n "skill\.events\|payload\.events" extension api`; keep the list current.

| reader | today | with `/2` |
|---|---|---|
| `extension/skills.js` `importSkills` | refuses a recorded skill without `events` | accepts `/2` with `source.flowId`; `/1` as before |
| `extension/skills.js` `flowFor(skill, options)` | maps `skill.events` into the replay body | resolves `source.flowId` → events via the account (`eventsFor` in `web/src/features/record/events-for.ts` is the existing road back) |
| `extension/background.js` (~1081, `flow.steps` filter) | needs `s.events.length` | same resolution, once per job |
| `api/_skill-schema.mjs` `structureOf(flow)` | counts `payload.events` | counts `procedure.steps` when present, events otherwise; the MCP/tool schema wording changes with it (three readers — see the roadmap) |
| `api/gallery.js` (~233) | refuses a recorded skill without events | refuses one without `procedure` **or** events |
| `api/mcp.js` `mouseflow_run` (~1789, `row.kind !== 'created'`) | builds the replay body from `payload.events` | unchanged for `/1`; for `/2` resolves the source flow |
| `api/_flow-role.mjs` `roleOf`, `listedInSkills` | role by kind/fields | must not change meaning; add a pin |

### Tests, pins, docs

- Executable: `api/_test-skills.mjs` — **done**, and one line of this was not buildable as written.
  "`/1` imports and exports unchanged **byte-for-byte**" was never true and could not be: `importSkills`
  has always minted a fresh local `id` and set `imported: true`, because two people may hold the same
  skill. What is pinned instead is the meaning behind it — the **version, the events and the params survive
  the round trip untouched** — plus the derived procedure being added rather than substituted.
  `verification` is **not** validated by `readExpects` inside the extension, either: that module lives in
  `api/` and the extension is a different runtime with no import between them. Duplicating the rule would
  have been two opinions about what a check is — the thing principle 3 forbids — so the extension
  **transports** the six known string fields and judges nothing, and the suite asserts that what it carries
  `readExpects` accepts, on the same data. That is what makes this file worth having in `api/`: it is the
  only place both halves can be loaded at once.
- Pins (`mcp/test-mcp.mjs`): every reader in the table handles both formats; `SKILL_FORMAT` is `/2`;
  `structureOf` counts steps before events.
- Docs: `docs/product/06-skills.md` (format, tiers, the pointer rule), `docs/product/15-data-model.md`,
  `agent/PROTOCOL.md` only if the wire changes (it should not), site `D:/MouseLanding/docs/content/skills.md`.

### Done when

A skill made from `rdimm21n3` (the Gmail recording, 16 clicks) shows a readable procedure on the Skills
page, exports as `/2`, re-imports, and `mouseflow_run` on it still replays — because the events are one
pointer away, not gone.

## 4. Step 2 — a memory of applications

> **Sequence row 2 shipped 2026-09-11: `api/_memory.mjs` (+ `.d.mts`).** Pure, no DB, no UI, exactly as
> specified — `parseKey`/`webKeyFor` enforce the 4.3 key shapes (`web:` is origin only, no path, no query),
> `redactionProblem`/`writeMemory` refuse a coordinate, a name over 60 chars, a URL with a query string and
> a password field (4.5), `fitBlock` evicts the oldest `learned` first and never touches `taught` or
> `derived` (4.10), and `builtinEntries()` holds the four 4.9 lines with `provenance: 'builtin'` so
> `fitBlock` never renders them into a turn's block. New executable suite `api/_test-memory.mjs` (now 53
> checks — 2 more from the email finding below), added to `npm test`. Not done yet: rows 4–6 — the
> `screenMessage()` wiring in both drivers, migration 023 + the ledger card, `learned` staging. No DB
> row shape decided yet beyond 4.11's sketch; nothing calls this module yet.
>
> **Sequence row 3 shipped 2026-09-11: `api/_memory-derive.mjs` (+ `.d.mts`).** `touchesOf(flow, {platform})`
> pulls `{key, title, control, near, side}` out of a recording's events — web keyed unambiguously from
> `context.url`; native (win32/darwin) requires the caller to name the platform, because **nothing in a
> recording says which OS wrote it** (PROTOCOL.md's `mods` section says this outright — "there is no
> correct translation without knowing which platform wrote the line, and the body does not say"). Native
> touches without a named platform are silently skipped rather than guessed. `deriveEntries` computes, per
> key: the stable title edge as the longest common suffix of titles seen (filters out per-item content by
> construction — a subject line never repeats, " - Outlook" always does), the most-pressed named control,
> and the top landmark for nameless presses; every candidate goes through `writeMemory`, so redaction is
> one choke point, not two. New suite `api/_test-memory-derive.mjs` (18 checks).
>
> **Ran once against the owner's real 61 recordings (throwaway probe, deleted after) — found a real
> redaction gap, now fixed.** One event's `context.control` held an email address, not a control name —
> an accessibility tree sometimes hands back typed content as "the name". 4.5 predicted this exactly ("a
> learned entry... will carry a customer's name... unless refused explicitly") and it was not hypothetical.
> `redactionProblem` now also refuses an email address in `body` or `name`. Real output otherwise looked
> right: `win32:chrome` derived to `"Address and search bar" — 488/7716`, `web:mail.google.com` to the
> title edge `"@gmail.com - Gmail - Google Chrome"`; ~61 recordings, ~28k touches, ~55 keys, three refused
> for a malformed native key (a space in the process name — correctly refused, not this module's bug).
>
> **Still open before row 4:** an account's *historical* recordings carry no platform marker, so a real
> `derived` pass over old data can only safely cover `web:` keys until that's added somewhere. A live pass
> run *from* the agent (which knows its own OS via `/health`) could pass `platform` in and cover native
> keys too — untried here, not an owner decision yet, just unbuilt.

> **Sequence row 4 shipped 2026-09-11: `memoryForOpen` (`_memory.mjs`) and the `screenMessage()` wiring,
> both drivers.** `MEMORY_LIVE = false` is the flag — a plain exported constant, not an env read (the
> module stays browser-shareable), flipped in one place, read once inside `memoryForOpen` itself so neither
> driver carries its own copy of the check. `screenMessage(frame, open, saw, clock, memory)` gained a fifth,
> optional argument; the words explaining what the block *is* live only in `api/_brain.mjs`, per the same
> rule that already governs `saw`/`waitReport`. Both drivers now call `memoryForOpen(...)` and pass the
> result in — the cloud driver (`api/_step.mjs`) with `platform: null`, because **nothing in the
> `?worker=step` wire says which OS the agent is on today** (this is the live-turn twin of row 3's finding
> about historical recordings — same gap, different path); the web driver (`desktop-engine.ts`) with a
> `hostOS()` guess, which is honest *there specifically* because the browser and the agent are the same
> machine (Create drives a local agent). Not touched: the Windows/Mac agent binaries themselves — no
> `.ps1`/`.swift` edit landed, since neither can be compiled/verified from this Mac session and the feature
> is dormant behind the flag regardless. `entriesByKey` is an empty `Map` at both call sites — nothing
> reads `app_memory` yet (migration 023, row 5).
>
> New pins in `agent/test-contract.mjs`: the memory prose lives in the brain and nowhere else; both drivers
> call `memoryForOpen` (not their own logic); `_case.mjs`/`_expect.mjs` never import `_memory.mjs` (4.8 —
> memory acts, never judges). `npm test`/`tsc`/`web/` build all green; nothing user-visible changed (flag
> off). Row 3's existing pin on `screenMessage(...)`'s exact signature was updated for the new 5th param —
> the invariant it guards (clock comes from the brain) is unchanged, only the string.
>
> **Next (row 5) needs the owner: apply migration 023**, then build `taught` + the ledger card before
> `MEMORY_LIVE` can flip to true for anything beyond an empty map.

> **Row 5 code shipped 2026-09-11, migration NOT applied — that part is the owner's, same as 022.**
> `db/023_app_memory.sql` (the 4.11 table, `builtin` kept in the CHECK for a future one-query ledger even
> though nothing ever inserts it — `writeMemory` already refuses that provenance at the door). A new page
> route, `api/memory.js` (GET list, POST teach-or-edit, DELETE forget — session-cookie scoped like
> `schedules.js`/`cases.js`, added to the routes pin in `mcp/test-mcp.mjs`), calls `writeMemory` for every
> write rather than re-checking redaction itself. The fourth Activity card, `Memory.tsx` — builtin read-only,
> `taught` with edit/delete, `derived`/`learned` shown without action buttons (no approve/reject exists
> yet; row 6 is "or never"). Client wrappers in `web/src/lib/api.ts` (`appMemory`, `teachMemory`,
> `forgetMemory`). Docs: `docs/product/26-activity.md` gained the fourth-card section.
>
> **Deliberately not built this round:** a live `derived` read through this route (the derive module from
> row 3 only ever ran as a throwaway probe; wiring it into a request path is separate work, not asked for
> here) and `learned` write/approve — nothing produces a `learned` row yet, so there is nothing to approve.
> No test harness added for `api/memory.js` itself: no sibling page route (`schedules.js`, `cases.js`,
> `docs.js`) has one either — this codebase's page routes are exercised live, not mocked, and adding one
> only for this route would be a second convention, not consistency with the rest.
>
> `npm test`/`tsc`/`web/` build all green. **Not runnable yet**: the table does not exist until migration
> 023 is applied, and `api/memory.js` answers 503 with that fact until then (mirrors `schedules.js`'s own
> "needs db/018 applied" message). Once applied: `npm run migrate -- --list` to confirm, then teach one
> fact through the card to close row 5's own done-condition.

### 4.1 The claim it rests on

Two places guess *per application*, and a heuristic cannot know the answer:

- `matchWindow` (`api/_anchor.mjs`): rung 2 is "shared title edge ≥ 6 chars and ≥ 40 %". It works for
  *"Inbox — Outlook" → "3 unread — Outlook"* by luck of form. The fact it lacks: *for OUTLOOK the stable part
  of the title is the trailing " — Outlook"*.
- `Retarget` (ps1) / `Accessibility.aim` (swift): aim by control name. **70.8 % of clicks carry a name on
  Windows, 81.8 % on macOS** (`docs/product/04-record.md`). The rest are the failures. The agents already
  record a landmark for nameless presses (`near`, `side` on the `#ctx` line). The fact nowhere stored: *in
  this application the send button has no name; it sits just right of "Attach"*.

Memory is the accumulated knowledge of names, landmarks and title shapes, **per application**. Not an
agent's diary.

### 4.2 The boundary

**Code holds facts about the platform. Memory holds facts about one application.** Yesterday's four fixes
are platform facts (or about us) and stay in code. Test for a candidate entry: *would this be true of every
application on this OS?* — then it is code.

### 4.3 The key

```
win32:WindowsTerminal        process, platform prefixed — the same app names things differently on macOS
win32:explorer
darwin:com.apple.mail
web:outlook.office.com       a browser is many applications; origin only, no path, no query
web:mail.google.com
```

**Open question, decide before 4.7:** a page keys on `web:<origin>`; where do facts about the *browser
shell* go (tab strip, address bar)? Proposed default: both tiers exist — `win32:chrome` for the shell,
`web:<origin>` for the page — and a reader consults both.

### 4.4 The entry

Text, `§`-delimited, one block per key, **with provenance on every entry**:

```
app: web:outlook.office.com                      budget 600 · used 218
§ taught          The stable part of the title is the trailing " - Outlook"; the head carries a count.
§ derived v1      "Reading Pane" — 47 presses across 6 recordings; the most-named control here.
§ learned r8kd2   The compose window appears ~1.5 s after "New mail"; the run had to wait.
§ builtin         (never in a per-app block — see 4.9)
```

| provenance | written by | recomputable | approval |
|---|---|---|---|
| `derived` | a formula over recordings, versioned | **yes** — the `flow_digest.version` / `flow_text.version` mechanism: bump the number, every row re-derives on read | none |
| `taught` | a person, in the app | never | the author |
| `learned` | the model, at the end of a run | no | **required** — staged, then approved or rejected |
| `builtin` | the code | n/a — it *is* code | none; read-only |

Re-derivation applies to `derived` **only**. A `taught` entry has no formula; treating it as recomputable is
how a person's correction gets overwritten.

### 4.5 What may never be written

Same rules as the recorder, or memory becomes the back door around its redaction:

- **No content** — nothing from inside a field, message or document. A `learned` entry distilled from a
  transcript will carry a customer's name on the first run unless refused explicitly.
- **No name longer than 60 characters** (the recorder's `RecordName` rule, agent 0.13.0, same reason).
- **URLs as origin only** (`PageUrl` already cuts the query; one-time tokens live there).
- **Nothing from a password field** (`judgeDom` in `extension/checks.js` already refuses).
- **No coordinates.** "Click 1814,246" is the fragility this whole plan removes, re-entering by another door.
  Memory holds **names and rules, never points.** Enforce in the module, not in a UI.

### 4.6 Who reads

1. **`screenMessage()` in `api/_brain.mjs`** — a block per turn, **only for the applications currently
   open**. The window list is already known there (`openList(windows, frame)` prints it, with `process`).
   Note `screenMessage(frame, open, saw, clock)` receives `open` as *text*; the memory block needs the
   processes/origins, so the signature grows a parameter and **both drivers change together**
   (`api/_step.mjs`, `web/src/lib/desktop-engine.ts` — `grep -n "screenMessage(" api web/src`). Why the
   brain and not the drivers is written in the code beside it: *"Слова здесь, а не в драйвере: два
   драйвера, сказавшие это по-разному, научат модель двум разным привычкам."* Update `api/_brain.d.mts`.
2. **`matchWindow()`** — the title-shape fact, **passed in** as `opts.memory`; the module stays pure and
   dependency-free, exactly as `list` is passed today. Never fetch from inside `api/_anchor.mjs`.
3. **The transcript / process document** (documentation product) — an application fact turns a click log
   into knowledge.
4. **The agents — not in v1.** It would change the wire format in two languages, and it is not needed: the
   agents already aim by name; the missing knowledge is *which* name, and that is decided where the memory
   lives.

### 4.7 Who writes, in this order (the reverse of what "learns" suggests)

1. **`derived` first.** Pure aggregation over the recordings already on the account (58 on the owner's):
   most-named controls per key with their landmarks; the stable title part as the longest common edge of
   every title seen for that process. No model, nothing to hallucinate, nothing to approve, computed on read.
   **Value on day one from data that exists.**
2. **`taught` second.** One form on the ledger; refuses with words anything 4.5 forbids.
3. **`learned` last — or never.** Staged to a pending state, shown in the ledger, approved or rejected. Build
   only if 1 and 2 leave a measured gap.

### 4.8 The invariant that makes this safe for QA

**Memory is read on the path that ACTS, never on the path that JUDGES.** A nightly verdict means something
only because the case did not change — that is why `args.__case = { id }` is a pointer and not a copy. If
memory could touch `expects` or a verdict, the nightly run would prove nothing.

Pin it, do not declare it: **`api/_case.mjs` and `api/_expect.mjs` never import the memory module.**

### 4.9 The `builtin` entries — the ledger's first four lines

Shown with a `scope` instead of an app key, read-only, **never rendered into a prompt**. Verbatim:

| scope | entry | enforced in |
|---|---|---|
| `platform:win32` | A bare right-button release opens a context menu (`WM_RBUTTONUP` → `WM_CONTEXTMENU`), so a replay releases only the buttons it held. | `ReleaseHeldButtons`, `agent/mouseflow-agent.ps1` |
| `platform:win32` | A taskbar button toggles — it minimises a window already in front — so a recorded taskbar press is played as "show that window", by title only. | `TaskbarSwitch`, `OnTaskbar`, ps1 |
| `platform:win32` | A minimised window reports a placeholder rectangle: fit to raise, never to re-anchor by. | `matchWindow` `evenMinimized`, `api/_anchor.mjs` |
| `self` | MouseFlow is the front window when Record is pressed, so the sampler's first window is us; the replay raises the window the clicks name and never raises itself. | `whichWindow` (`api/_anchor.mjs`), `ourWindow` in `RecordView.tsx` |

### 4.10 Budget and eviction

600 characters per key; at most 6 keys per turn → ≤ 3.6 k chars ≈ 900 tokens (Hermes' whole memory is
~800). When a block is full: **the oldest `learned` goes; `taught` never goes; `derived` is recomputed, so
it never accumulates.** The person is told what was evicted. The budget is discipline, not economy — a
memory that grows without bound stops being read.

### 4.11 Storage

Migration **`db/023_app_memory.sql`** — applied to production **only on the owner's explicit approval**.
**Renumbered from 022 on 2026-09-11**: item 7 of the QA roadmap took 022 for `run_queue.machine`, and
two files sharing a number is the one that gets applied second and silently does not — `migrate.mjs`
walks them in name order and records what it has run by name.

```sql
create table if not exists app_memory (
  id          text        primary key,
  user_id     uuid        not null,
  key         text        not null,              -- 4.3; 'platform:win32' / 'self' for builtin
  provenance  text        not null check (provenance in ('derived','taught','learned','builtin')),
  version     integer,                           -- derived only: the formula that produced it
  run_id      text,                              -- learned only
  body        text        not null,
  state       text        not null default 'live' check (state in ('pending','live','rejected')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists app_memory_owner_key on app_memory (user_id, key) where deleted_at is null;
```

A one-day spike can use `user_pref (user_id, key, value)` with one text blob per key — honest as a draft,
wrong as the product: provenance, approval and edit/delete need rows.

### 4.12 The ledger

A third card in `web/src/features/activity/ActivityView.tsx`, beside **Running now** and **History**: *"What
MouseFlow has learned"* — one line per entry with scope/key, provenance, date; edit and delete for `taught`,
approve/reject for pending `learned`, read-only for `builtin` and `derived`. This is Hermes' `/journey`, in
the place we already have.

**Where the data comes from — checked, because the first draft of this paragraph named a route that does
not exist.** There is no `api/activity.js`. The Activity page reads `/api/mcp?live=1` through
`web/src/lib/live.ts` (`useLive`, `refreshLive`; the module's own header says why it is shared). So the
ledger has two honest options: a `?memory=1` branch beside `?live=1` in `api/mcp.js`, or a new
`api/memory.js` — and **a new route must be added to the expected-routes pin** in `mcp/test-mcp.mjs`.
Prefer the new route: `api/mcp.js` is already the biggest file, and the roadmap says so.

### 4.13 The measurement gate (this is what makes the plan falsifiable)

Step 3 of the sequence ships **behind a flag** and is judged by one number: **turns per successful run**,
i.e. `jsonb_array_length(steps)` on `user_run` where `outcome = 'ok'`, before and after, on the same skills.
Roadmap item 6 (speed: ~8 s a step towards 3) is the ruler. If knowledge about the application does not
reduce the turns, it is not working, and the step is rolled back rather than kept on faith.

## 5. Sequence

| # | what | proof | done when |
|---|---|---|---|
| 1 | Section 3 — `mouseflow.skill/2` | `api/_test-skills.mjs`; pins on every reader; mutation-proven | the `rdimm21n3` skill round-trips and still runs |
| 2 | `api/_memory.mjs` (+ `.d.mts`): key, entry, provenance precedence, budget/eviction, redaction — **pure, no DB, no UI** | `api/_test-memory.mjs`: refuses a coordinate, a 61-char name, a query string, password-field text; evicts `learned` before `taught`; `builtin` never renders | the module has to be right when nobody is looking, like `_anchor.mjs` |
| 3 | `derived` over existing recordings, computed on read, shown read-only | visible on the ledger; zero writes | first day's value |
| 4 | the block in `screenMessage()`, behind a flag; both drivers; `_brain.d.mts` | pin: brain not drivers; the 4.8 import pin | **4.13 measured**; else roll back |
| 5 | migration 023 (approval!), `taught`, the ledger card, the four `builtin` lines | form refuses with words; ledger edits/deletes; route pin | the owner adds one Outlook fact and the next run's block shows it |
| 6 | `learned` with staging and approval | pending → live/rejected; never bypasses 4.5 | **or never** |

Each step ends the roadmap's way: `npm test` green, `npx tsc --noEmit -p web/tsconfig.json` clean,
`npm run build` in `web/` ok; docs page updated with the feature; site page updated and deployed; push;
`build.json` shows the commit; tell the owner one concrete thing to check.

## Appendix — a fresh session's first ten minutes

1. Read `docs/QA-ROADMAP.md` §0, then this file.
2. `git log --oneline -12` in `D:/AI Connecitivty/poc/mouse-flow`; expect `339790d` or later on `main`.
3. `npm test` — expect all suites green (537 contract, 1238 pins, 62 anchor, 36 macro, 26+ others).
4. Confirm the app is on `https://mouseflowapp.vercel.app/build.json`.
5. Ask the owner the one open question (4.3, the web key) — or proceed with the proposed default and say so.
6. Start with step 1 (section 3). Do not touch the parked taskbar issue first.
