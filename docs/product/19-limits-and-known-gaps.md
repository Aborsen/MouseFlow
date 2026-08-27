# 19 — Limits and known gaps

Three different kinds of thing, kept apart on purpose: what cannot work, what has not been verified, and
what is currently wrong.

---

## Inherent limits

These are not bugs and no amount of work inside the current design removes them.

### Coordinate recording (the desktop half)

- **Absolute coordinates.** A recording is pixel positions on the screen it was made on. Move the target
  window, resize it, change resolution or plug in a second monitor and the replay clicks whatever now sits at
  those pixels. Aiming by `#ctx` name corrects a *re-laid-out neighbour*, not a moved window.
- **Display scaling.** Input injection happens in physical pixels; a recording made at one DPI scale replays
  wrong at another.
- **A taskbar click is named but not aimed.** Since 0.9.9 the transcript says which icon was clicked; the
  replay still clicks the recorded coordinate. Aiming by name works by hit-testing the point and looking
  among the siblings of whatever is there, and on the taskbar the point hit-tests to `Shell_TrayWnd` - the
  whole window - whose siblings are other top-level windows. So a taskbar rearranged between recording and
  replay opens the wrong application, silently. It was equally true before naming worked; what is new is
  that the transcript now shows the name, which makes the gap easy to mistake for closed.
- **Windows integrity levels cut both ways.** A medium-integrity agent cannot inject into an elevated window
  **and cannot see input while one has focus**. A recording made over an admin app is silently incomplete —
  the events never arrive, so nothing downstream can detect the hole. The UAC secure desktop is unreachable
  either way.
- **`capture_window`, the clipboard and `open_url`/`open_app` are Windows only.** They landed in 0.10.0 on
  the Windows agent; the macOS equivalents (`NSPasteboard`, `CGWindowListCreateImage`, `NSWorkspace.open`)
  are not written. The macOS agent answers those four actions by name and says so, which is deliberately
  different from "no such action": a model told an action does not exist looks for a way round — in the run
  this came from, that meant opening a terminal and writing a screen-capture tool — and a model told the
  platform lacks it stops and reports.
- **A captured picture stays on the machine.** `capture_window` writes a PNG under
  `%LOCALAPPDATA%\MouseFlow\captures` (pruned to 200 files and 7 days) and puts it on the clipboard. That is
  enough to paste it into a document, which is what the failing scenario needed, but the bytes never reach
  the run's record on the account — so a report on our side cannot show the picture, only name the path.
  Carrying attachments up to the account needs a table, an upload path and a size cap, and is a piece of
  work of its own rather than a corner of this one.
- **The self-window guard protects a process, not a window.** Windows Terminal keeps every window of a
  profile in one process, so a SECOND Terminal window is refused along with the one hosting the agent. The
  refusal says so and names the way round (a different terminal application, or autostart, where the agent
  has no terminal at all). Erring this way is deliberate: the alternative is failing to protect the window
  that matters.
- **macOS captures one display.** ScreenCaptureKit takes the display the cursor is on. Bounds checking still
  uses the union of all displays, because a click on the second monitor is a legitimate click even when the
  agent cannot see it.
- **macOS `/shot` and `/pulse` need macOS 14+.** `CGWindowListCreateImage` is *unavailable* on macOS 15, not
  merely deprecated, and cannot be kept behind an `#available`.

### Element recording (the extension)

- **No native applications.** Nothing outside a browser tab.
- **No `chrome://` or Web Store pages** — Chrome blocks injection.
- **CSS `:hover` never lights up.** The browser drives that from the real pointer and no synthetic event can
  reach it. The one difference from the desktop agent that cannot be closed from inside a page.
- **Canvas app surfaces have nothing to anchor to.** The Excel Online grid draws itself into a canvas; its
  ribbon and dialogs are ordinary DOM and do work.
- **`isTrusted` is false.** Most apps including React and Vue are driven correctly, but a site that checks
  `isTrusted` will ignore synthetic events. The fix is `chrome.debugger`, at the cost of a *"MouseFlow started
  debugging this browser"* infobar in every tab.

### Both halves

- **No typed text, anywhere.** Deliberate; see [17 — Privacy](17-privacy-security.md). The consequence is
  that a recording containing typing cannot be replayed faithfully, and the replay says so as `unplayable`.
- **A recording holds input, not outcome.** Nothing stored says whether anything on the screen did what was
  wanted. Replaying it is the only way to find out.
- **Electron applications name almost nothing** in either accessibility tree.
- **Safari cannot reach the agent.** It has no Local Network Access permission to grant and blocks the
  loopback hop outright. The desktop half is Chrome/Edge in practice.
- **No agent authentication.** Any process on the machine can drive the agent while it runs; `-AllowOrigin`
  is echoed, never enforced. A design is being chosen.
- **The rate limits are per serverless instance**, so the real ceiling is the stated number times however many
  are warm. They stop a stuck client, not a determined caller.
- **`find_repeated` matches identical goal text.** Two goals differing by one name are not clustered.
- **Time saved cannot be reported.** Nothing holds how long the same task takes by hand.

---

## Not verified

"It works" and "it was tested" are different claims, and this section keeps them apart.

| Area | State |
|---|---|
| Web app, Windows agent (pre-0.8.2) | **Verified** on real machines. 94 contract checks, plus suites for the transcript, the sessions, the reconciliation and the gallery. |
| Windows tray + held recordings (0.8.2) | **Verified** on a real Windows machine, 2026-08-21 — items 1–5 of the DEBUG-WINDOWS checklist. |
| Windows: naming rate at 0.8.2 | **Not re-measured.** The 70.8% / 146-of-151 baseline predates the tray work. |
| Windows: the tray's failure paths | **Untested rather than disproved** — a tray that fails to appear, a held recording surviving a restart of the agent, the 409 that refuses to record over one. |
| macOS: recording, `#ctx` naming, `/shot`, `/pulse`, `/windows`, both permissions, the permission self-recovery, the menu bar, the held-recording handover, a Developer ID rebuild keeping the grants | **Verified** on a real Mac (macOS 26.5, arm64), 2026-08-20 and 2026-08-21. |
| macOS: **replay, and aiming by name** | **Never observed working.** |
| macOS: Chrome's tab strip | Measured and **still nameless**: the hit test returns an unnamed group, climbing finds nothing, and the bounded child descent reached no tabs either (8 tab clicks, 0 named). The tabs must live in another branch, likely an `AXTabGroup` under the window. Finding it needs an AX-tree inspection of a real Chrome, not another guess. |
| The OpenAI provider path | **Written, never run from here.** No `OPENAI_API_KEY` on the deployment. Structured so a wrong assumption fails loudly with the upstream's own message rather than silently degrading. |
| Antivirus / EDR behaviour | **Untested.** A global mouse hook plus `SendInput` looks exactly like a RAT. |
| **The Windows agent at 0.9.2** | **Written, never run there.** The step loop (`?worker=step`) and the crash reporter (`?worker=crash`, `/crash-test`) were both written on a Mac and have not executed on Windows once. The contract suite holds them against the macOS implementation, but that compares **text, not behaviour** — it would pass an implementation that returns the right shapes and moves no mouse. |
| The Windows worker installer | **Written, never run.** No Windows on this machine, so `mcp/install-worker-windows.ps1` has not been executed. Its contract is held against the macOS installer by the suite — token shape, no-echo prompt, Node floor, the three settings, status and uninstall — but that compares text, not behaviour. Unlike launchd there is no KeepAlive: a Startup-folder item is started once at sign-in and not restarted, which the script says out loud. **It now matters less than it did**: nobody needs the worker for a goal skill since 0.9.0. |
| Windows `/account` and the courier | **Verified on a real PC, 2026-08-23.** Attached from the app, `/health` answered `"linked":true,"taking":true,"platform":"windows"`, and a recording was started and stopped from a chat over MCP — the full path, chat to account to queue to the machine and back. It failed to compile on the first attempt: `HookInstalled` was declared a second time and `Add-Type` refused the whole block, which is the loud failure rather than a quiet one. `agent/check-csharp.mjs` runs in `npm test` now and catches that class of mistake. |
| Team invitation emails | **Configured, not yet observed delivering.** `RESEND_API_KEY` and `MAIL_FROM` are set on production against the verified domain `kuswise.com`, so the send path is live — but no invitation has been watched arriving in a real inbox yet, and "the request returned 200" and "it landed in an inbox" are different claims. The message builder and the unconfigured path are covered by the suite. Invitations work either way: the row is the invitation, and if a send fails the screen says so with the provider's own words. |
| The team dashboard at a large team | **Not measured past a handful of accounts.** `/api/insights?team=` unrolls every event of every recording for every member in one read-only transaction, and it is already the most expensive read in the product for one account. A 200-person team — the schema's cap — has never been tried, and the rate limit (30/min) counts requests, not accounts. If it becomes slow, the fix is to bound the per-application unrolling by member count rather than to raise a timeout. |

---

### The stop-inside-a-wait path is written and not observed

A wait can last two minutes, so the agent asks `?worker=state&id=` every third look at the screen and
abandons the turn if the job is no longer `claimed`. That code has **never run**, because the model did not
call `wait` in any of the verification runs — and it cannot be made to. Asking for a goal that ought to need
waiting is not the same as getting a `wait`, and a path proven by a test that forces the call is a path
proven against the test rather than against the model.

The cancellation that *was* measured took a different route: the run was between steps, and the row was
tidied in 0.2 s.

### `api/mcp.js` still has no executable coverage

This is the honest headline. The route that queues work, hands it to a machine, drives the loop and closes
the job is checked by **regexes over its own source** and by nothing that runs it.

Four bugs shipped from it in one day, and every one was found by watching a real run rather than by a suite:

| | |
|---|---|
| A cancelled job kept its conversation | so the next claim resumed something the user had stopped |
| A log entry written under `q_q_…` | the queue id prefixed twice |
| A three-minute run recorded as eleven seconds | the wrong timestamp closed it |
| A helper declared after the branch that called it | which answered a cancelling agent with HTTP 500 |

The regexes now guard all four, which is worth something and is not the same thing as coverage: each one was
written after the fact, from a bug already understood. A regex cannot find the fifth.

What it would take is a harness that stands a queue up, claims from it, steps through a scripted loop and
cancels part-way — the same shape as the existing suites, against a route that currently has none.

## Defects found while writing this documentation

Reported rather than fixed, because documenting was the task. Each is small and each has a named site.

### 1. `image/${format}` produces `image/image/jpeg` — three sites — **closed**

Both agents send `format: "image/jpeg"` on `/shot` — a **full MIME type**, which is what
[`agent/PROTOCOL.md`](../../agent/PROTOCOL.md) requires. Three places treated it as a bare extension and
prefixed `image/` again: the model request in `plan.ts`, the checkpoint gate's thumbnail in `CreateView.tsx`,
and the Live Context panel. The first was a hard **HTTP 400** — *Plan it* failed whenever **Stay on this
window** was on, which is the only case that attaches a screenshot; the other two depended on how tolerant a
browser is about a malformed data-URL MIME type.

All three now go through the existing helper — `mediaType(shot.format)` for the request and
`data:${mediaType(shot.format)};base64,…` for the images — and the third site no longer exists at all: the
Live Context panel was removed when the Create page's right column became the run history. **This is the
exact bug class the protocol document already carries a paragraph about** — "This line used to say `'jpeg'`,
the second implementation followed it, and generating a flow answered 400 on that machine until somebody
tried it" — which is why it is worth leaving written down rather than deleting.

### 2. The service worker is dead code

[`web/public/sw.js`](../../web/public/sw.js) is served, and **nothing registers it** — there is no
`navigator.serviceWorker` call anywhere in `web/src` or `web/index.html`. Its shell list also still names
`app.css` and `app.js`, which were the pre-React build's files and no longer exist, so registering it as-is
would cache a 404 into the install step. The app is installable (the manifest and icons are real) but has no
offline behaviour.

### 3. Two deployment hostnames in the tree — and in the extension it was not cosmetic

The API's CORS fallback origin and the Vite dev proxy target are `https://mouse-agent.vercel.app`, while the
macOS installer's default origin and the documented deployment are `https://mouseflowapp.vercel.app`. The
page is same-origin so the fallback never bites it, and every install command is built from `location.origin`
— but the two names disagree, and the CORS fallback is the one that would matter to a non-browser caller.

**Fixed for the extension on 2026-08-25, where the same disagreement was breaking a feature.** Its
`content_scripts.matches` and `externally_connectable.matches` listed only `mouse-agent.vercel.app`, which is
an alias that 307s to `mouseflowapp.vercel.app` and serves nothing itself. A match pattern is tested against
the page's FINAL url, so `bridge.js` never loaded on the live app and the one-click "connect the extension"
handover could not work in production — the redirect that makes the old name look alive is exactly what hides
this. Both names are listed now, and `APP_URL` in `popup.js`/`background.js` plus `SHARED_URL` in `agent.js`
point at the real one.

### 4. Stale instructions about stopping the Windows agent

Both of these predate the 0.8.2 tray icon and are now wrong, or at least incomplete:

- [`ConnectView.tsx`](../../web/src/features/connect/ConnectView.tsx), Windows step 2: *"Leave it open
  afterwards — closing it is how you stop the agent, and there is no other off switch."* There is now: the
  tray's **Quit MouseFlow Agent**.
- [`AppLayout.tsx`](../../web/src/shell/AppLayout.tsx), the agent pill's tooltip: *"To stop it, close its
  PowerShell window."* Shown on **both** platforms, so on macOS it names a window that does not exist.

### 5. `AGENT_WANTS` trails the agents — **fixed**

`AGENT_WANTS` is `0.9.2` (`web/src/lib/agent.ts`), which is what both agents report.

The reasoning changed rather than the number merely catching up. It used to be a judgement call: 0.8.0 was
the build that satisfied everything the client *required*, so trailing was defensible. Now the nudge is
**deliberate and load-bearing** — an update prompt is the only way somebody on 0.8.x learns that the install
step is gone and a goal skill no longer needs a worker beside the agent. A client that quietly accepted the
old build would leave them installing a second program for nothing.

### 6. The macOS agent's four new `#ctx` keys are emitted and never read

`role`, `subrole`, `in` and `inName` are written above every click the macOS agent resolves. `parseMacro`
([`web/src/lib/macro.ts`](../../web/src/lib/macro.ts)) and `ctxOf`
([`api/_transcript.js`](../../api/_transcript.js)) both keep only `app`, `window`, `control` and `type`, so
the new keys are dropped before a recording reaches the account.

Harmless — the format's unknown-key rule is exactly what makes it so — but it is half a feature until the
consuming side lands, and the half that landed is the one that costs a rebuild to change. The point of the
role tokens is that `type` is localised (`kAXRoleDescription` says *"кнопка папки с закладками"* on a Russian
Mac), so the transcript is the half that needs them most.

### 7. Stale sections in the older documents

- [`README.md`](../../README.md) still describes the pre-React app (*"index.html app.css app.js — the whole
  UI, no framework, no build"*), lists *"Windows only"* under known limits, and carries an agent API table
  without `/shot`, `/pulse`, `/windows`, `/do` or `/record/drain`. The deploy section also says the app is
  static with no build step, which `vercel.json` contradicts.
- [`extension/README.md`](../../extension/README.md) has a *"Still to wire"* section saying the web app cannot
  talk to the extension yet and that a content-script bridge is the fix. That bridge exists
  (`extension/bridge.js`, `web/src/lib/bridge.ts`) and is what Create's browser mode runs on.

---

## Where this would go next

Carried over from the project's own notes, and still current:

- **A signed per-user installer** for Windows, replacing both start paths: one byte-identical signed binary
  (so it accumulates SmartScreen hash reputation — a per-user-unique build never can), the pairing token in
  the URL rather than baked into the file, a `mouseflow://` scheme for relaunch, and the autostart task
  registered at install time. This is what removes the PowerShell paste entirely.
- **A notarised, prebuilt macOS `.app`** — no compiler on the user's machine at all. A Developer ID now exists
  and the installer prefers it; notarisation is the remaining step, and it is a distribution project rather
  than an installer flag.
- **Anchored desktop recording.** Capture the target window handle, title and client-relative coordinates
  alongside the screen position, then re-resolve the window at replay time. This removes the single biggest
  fragility.
- **Agent authentication.** One seam, one scheme.
- **Text for the steps that need it**, if it can be done safely. Keystroke *timing* is captured; the content
  is not, and adding it needs a redaction design rather than a hook. The alternative already works: a created
  skill is told what to write.
- **A Tauri build** — the same UI as a ~5 MB desktop app, which removes the agent install, the loopback bridge
  and the Safari limitation in one move.
- **Shared flows** as documents rather than account rows.

Ruled out along the way, so nobody re-opens them: `ms-appinstaller:` (disabled by default since App Installer
1.21.3421.0, December 2023, after it was abused to bypass SmartScreen) and ClickOnce (unsupported by Chrome).
