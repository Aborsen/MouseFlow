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
- **Windows integrity levels cut both ways.** A medium-integrity agent cannot inject into an elevated window
  **and cannot see input while one has focus**. A recording made over an admin app is silently incomplete —
  the events never arrive, so nothing downstream can detect the hole. The UAC secure desktop is unreachable
  either way.
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
| The Windows worker installer | **Written, never run.** No Windows on this machine, so `mcp/install-worker-windows.ps1` has not been executed. Its contract is held against the macOS installer by the suite — token shape, no-echo prompt, Node floor, the three settings, status and uninstall — but that compares text, not behaviour. Unlike launchd there is no KeepAlive: a Startup-folder item is started once at sign-in and not restarted, which the script says out loud. |
| Windows `/account` and the courier | **Written, never compiled or run.** The machine this was written on has no Windows, no PowerShell and no C# toolchain, so the C# was never put through a compiler. What *was* checked: the route table in `agent/PROTOCOL.md` now lists `/account` and `agent/test-contract.mjs` holds both agents to it; braces and parentheses balance across the 3,171-line C# block; the three new classes sit at namespace level; the JSON reader's algorithm was transcribed to JS and run against a real claim response — multi-line replay body, non-ASCII window title, `\u` escapes, truncated input — 13 of 13. None of that is a compiler. The first run on a real PC is the test that matters, and the likely failure is a typing error at `Add-Type`, which would stop the agent starting rather than misbehave quietly. |
| Team invitation emails | **Configured, not yet observed delivering.** `RESEND_API_KEY` and `MAIL_FROM` are set on production against the verified domain `kuswise.com`, so the send path is live — but no invitation has been watched arriving in a real inbox yet, and "the request returned 200" and "it landed in an inbox" are different claims. The message builder and the unconfigured path are covered by the suite. Invitations work either way: the row is the invitation, and if a send fails the screen says so with the provider's own words. |
| The team dashboard at a large team | **Not measured past a handful of accounts.** `/api/insights?team=` unrolls every event of every recording for every member in one read-only transaction, and it is already the most expensive read in the product for one account. A 200-person team — the schema's cap — has never been tried, and the rate limit (30/min) counts requests, not accounts. If it becomes slow, the fix is to bound the per-application unrolling by member count rather than to raise a timeout. |

---

## Defects found while writing this documentation

Reported rather than fixed, because documenting was the task. Each is small and each has a named site.

### 1. `image/${format}` produces `image/image/jpeg` — three sites

Both agents send `format: "image/jpeg"` on `/shot` — a **full MIME type**, which is what
[`agent/PROTOCOL.md`](../../agent/PROTOCOL.md) requires and what `desktop-engine.ts` handles correctly through
`mediaType()`. Three other places still treat it as a bare extension and prefix `image/` again:

| Site | Consequence |
|---|---|
| [`web/src/lib/plan.ts:95`](../../web/src/lib/plan.ts) | `media_type: "image/image/jpeg"` in the model request. The API accepts four exact strings; anything else is an **HTTP 400** — so *Plan it* fails whenever **Stay on this window** is on, which is the only case that attaches a screenshot. |
| [`web/src/features/create/CreateView.tsx:633`](../../web/src/features/create/CreateView.tsx) | `data:image/image/jpeg;base64,…` for the checkpoint gate's *Look at the screen* thumbnail. |
| [`web/src/features/create/LiveContext.tsx:126`](../../web/src/features/create/LiveContext.tsx) | The same, for the Live Context thumbnail. |

The two `<img src>` cases depend on how tolerant the browser is about a malformed data-URL MIME type; the
model request is a hard 400. **This is the exact bug class the protocol document already carries a paragraph
about** — "This line used to say `'jpeg'`, the second implementation followed it, and generating a flow
answered 400 on that machine until somebody tried it" — and the fix is the existing helper:
`mediaType(shot.format)` for the request, and `data:${mediaType(shot.format)};base64,…` for the two images.

### 2. The service worker is dead code

[`web/public/sw.js`](../../web/public/sw.js) is served, and **nothing registers it** — there is no
`navigator.serviceWorker` call anywhere in `web/src` or `web/index.html`. Its shell list also still names
`app.css` and `app.js`, which were the pre-React build's files and no longer exist, so registering it as-is
would cache a 404 into the install step. The app is installable (the manifest and icons are real) but has no
offline behaviour.

### 3. Two deployment hostnames in the tree

The API's CORS fallback origin and the Vite dev proxy target are `https://mouse-agent.vercel.app`, while the
macOS installer's default origin and the documented deployment are `https://mouseflowapp.vercel.app`. The
page is same-origin so the fallback never bites it, and every install command is built from `location.origin`
— but the two names disagree, and the CORS fallback is the one that would matter to a non-browser caller.

### 4. Stale instructions about stopping the Windows agent

Both of these predate the 0.8.2 tray icon and are now wrong, or at least incomplete:

- [`ConnectView.tsx`](../../web/src/features/connect/ConnectView.tsx), Windows step 2: *"Leave it open
  afterwards — closing it is how you stop the agent, and there is no other off switch."* There is now: the
  tray's **Quit MouseFlow Agent**.
- [`AppLayout.tsx`](../../web/src/shell/AppLayout.tsx), the agent pill's tooltip: *"To stop it, close its
  PowerShell window."* Shown on **both** platforms, so on macOS it names a window that does not exist.

### 5. `AGENT_WANTS` trails the agents

`AGENT_WANTS` is `0.8.0`; both agents report `0.8.2`. That is coherent — 0.8.0 is the build that satisfies
everything the client *requires* — but a 0.8.0 agent reads as "current" while lacking the tray, the menu bar
and the ability to end a recording itself. Nothing breaks (the client only ever reacts to the held state and
never requires it), so this is a judgement call to make deliberately rather than a defect.

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
