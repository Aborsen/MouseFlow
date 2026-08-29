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
- **macOS has all twenty-one tools as of 0.16.0 — written, and mostly not yet watched.** Everything added
  from 0.10.0 to 0.12.0 was Windows only for six releases; `capture_window`, `clipboard_read`,
  `clipboard_write`, `open_url`, `open_app`, `read_window`, `find_element`, `scroll_to`, `drag`,
  `refresh_page` and `wait_for_window` all exist on the Swift agent now, and the by-name refusals are gone
  with them. **What that sentence does not say is that they have been run.** They typecheck, the contract
  suite holds them against the Windows implementation, and that compares text and shapes rather than
  behaviour. The three most likely to be wrong on a real Mac, and why:
  - **`read_window` and `find_element`** walk the AX tree breadth-first under three bounds at once (1500
    nodes, depth 12, 2.5s, plus a 4s messaging timeout on the application). Those numbers were chosen from
    the Windows measurements, not measured here. An application that answers slowly will return a short
    list rather than a wrong one, which is the safe direction, but the list may be shorter than it should be.
  - **`capture_window`** uses `SCContentFilter(desktopIndependentWindow:)`, which is better than the Windows
    answer — it photographs the window whatever is in front of it, and unlike `PrintWindow` it does not fail
    on hardware-accelerated surfaces. It needs Screen Recording, and a region capture is at point
    resolution (1 image pixel = 1 screen point), not backing-store resolution.
  - **The sign of the horizontal wheel is a reasoned guess.** On Windows the convention is documented:
    positive `WM_MOUSEHWHEEL` is right. `CGEventTypes.h` does not state one, so the agent follows
    `NSEvent.scrollingDeltaX`, where positive is left, and both halves — the recorder tap and the injector —
    ask one function (`Sideways`) so they cannot disagree with each other. If it is mirrored, it is mirrored
    consistently and one line flips both. **Check:** scroll sideways during a recording in anything with a
    horizontal list, and read whether the transcript says "Scroll Left" or "Scroll Right".
- **A single character typed is invisible to the change detector.** The screen fingerprint is 64x36 grey
  cells, so each one is a 30x30 average: fifteen characters move four cells and one character moves none.
  An action that types one character can therefore be reported as having changed nothing. Nothing on this
  grid can fix that; a finer grid would cost what the fingerprint exists to avoid.
- **A short name that is content cannot be told from a label.** From 0.13.0 a control name longer than 60
  characters is not recorded — measured: the longest name on anything a person presses was 43, and everything
  above 60 in a three-application sample was content. What the rule cannot catch is content that is SHORT: a
  spell-check menu named `Spelling, сторят` carries one typed word in sixteen characters, and nothing in the
  string says whether that is a label or somebody's spelling. Recorded as a name, like any label.
- **Window and page titles are still recorded in full**, minus the query string. A chat title carries the
  other person's name, an email window carries the subject. That is deliberate — the transcript segments the
  work by window, and redacting titles would leave a recording with no structure at all — but it is worth
  knowing before a recording is shared.
- **An application can stop answering its accessibility interface, and then naming does not work at all.**
  Measured: dbForge Studio described itself in 187ms one hour and did not reply at all the next, from any
  thread. `read_window` and `find_element` give it four seconds, then mute that window for a minute and say
  so — the screenshot is the fallback, and the model is told to use it. At most three such searches may be
  outstanding, because a search that never returns keeps its thread.
- **`scroll_to` takes a single-word name.** The wire gives an action one field that may contain spaces and
  `find_element` spends it on the name it is looking for, so a multi-word target is cut at the first space.
  Said in the tool description rather than silently.
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
- **An Electron window still names nothing on macOS, and Chrome now does.** Measured on this Mac with the
  0.16.0 `read` action: a Google Chrome window answers with 27 named things — toolbar, bookmarks bar, Back,
  Forward (correctly reported disabled), Reload, the profile button — while the Claude desktop app answers
  with exactly two, both the size of the window: a group and an `AXWebArea` with no children. `awaken()`
  sets `AXManualAccessibility` and falls back to `AXEnhancedUserInterface` **only when the first is not
  understood**, and an Electron app appears to accept the first and ignore it, so the fallback never fires.
  Setting both unconditionally is the obvious fix and is deliberately not done: `AXEnhancedUserInterface` is
  VoiceOver's own signal and AppKit changes window-geometry behaviour under it, which is why window managers
  toggle it off around every move they make. This is the same shape as the Chrome tab-strip gap below, and
  it affects `#ctx` naming during a recording as well as `read_window`.
- **macOS captures one display.** ScreenCaptureKit takes the display the cursor is on. Bounds checking still
  uses the union of all displays, because a click on the second monitor is a legitimate click even when the
  agent cannot see it.
- **macOS `/shot` and `/pulse` need macOS 14+.** `CGWindowListCreateImage` is *unavailable* on macOS 15, not
  merely deprecated, and cannot be kept behind an `#available`. `capture_window` is on the same floor and
  says so rather than failing obscurely.
- **Until 0.19.0 a modifier stayed pressed after every chord, on macOS, for the whole machine.** This is the
  most consequential defect found so far and it was found by measurement, not by reading. A listen-only
  `CGEventTap` printing the flags of events carrying the agent's mark, after one `press_key` with a modifier:

  ```
  keyDown   mods=Cmd  text=""     <- the chord itself, as asked
  mouseDown mods=Cmd              <- the next click was a Command-click
  scroll    mods=Cmd              <- the next scroll was Command-scroll, i.e. zoom
  keyDown   mods=Cmd  text="z"    <- the next typing was Command+Z, i.e. undo
  ```

  `CGEventSource(stateID: .hidSystemState)` gives a new event the *current* modifier state, and only
  `press_key` set flags explicitly. The state also latched globally: `flagsState(.combinedSessionState)`
  returned `Cmd` indefinitely, so the person's own keyboard was affected too. Typing `mouse test4` after
  Command+S therefore sent Command+M (minimise), Command+O, Command+U, **Command+S (save again — which is
  where the "replace this file?" dialog came from)**, Command+E, Command+T. Nothing reached the field, macOS
  beeped at the combinations that do nothing, and the model's "the typing didn't land" was **correct**.
  Fixed three ways: explicit flags on every posted event, a chord that presses and releases its modifiers as
  keys (chosen by measuring four candidate releases), and `type()` releasing anything still held first.
  **A recording now starts by releasing them as well, and that half is about a promise:** a letter is only
  named when it arrives under Command or Control, so with Command latched every keystroke a person made
  would have arrived as a chord and **the letter would have been named**. The rule is held by an executable
  test that runs the chord order without posting anything.
- **A modifier held by anything else still changes what an action does, and `releaseModifiers` is a blunt
  answer to it.** From 0.20.0 both agents release whatever is held before a chord, before typing, at
  recording start, and at both ends of a replay — because a modifier latched by another application, a stuck
  physical key, or an agent that died mid-chord is *added* to whatever was asked for: `key=w` becomes close
  window, `key=q` quits, `key=delete` in Finder means move to Trash, and `key=r ctrl=1` under a latched
  Shift becomes the hard-reload `refresh` uses. All of those returned "done". The cost of the cure is that
  it cannot tell a stale latch from a finger on a key, so a person physically holding Shift while a run
  types loses it, and there is no field to opt out. During a run that is the right trade — the run must do
  what it was asked, not what somebody's finger made of it — but it is a real behaviour, not a detail.
- **Modified pointer gestures: recorded and replayed on macOS from 0.21.0; Windows and the action grammar
  are not done.** A Shift-click, Command-click, Option-drag or Command+scroll made by a person on a Mac is
  now recorded (`mods=` on the `#ctx` line), narrated (`Shift-clicked "Report.pdf"`, `Alt-dragged 202px`,
  `Cmd-scrolled down 2 notches`) and replayed as the same gesture. **Verified end to end on a real Mac**, in
  both directions: an injected Shift-click recorded as `mods=Shift`, and a replayed Option-drag posted the
  flag on its press, its movement and its release, with the session's modifier state clean afterwards.

  Settled by measurement, against the design's own expectation: on macOS the flags on a posted mouse event
  are **sufficient** — a window reporting what it saw showed `NSEvent.modifierFlags = Alt` identically for
  an event sent with flags only and one sent with the key physically held. So no modifier key is pressed.
  The same measurement found the other half: those flags **latch** the session state exactly as a keyboard
  chord does, so the replay releases them when a gesture closes.

  **Still open:** the Windows recorder and replay (the readers are ready for them, and a `mods` line they do
  not write is simply absent), and the action grammar — the model still cannot ASK for a Shift-click, only
  replay one a person made.
- **Modified pointer gestures could be neither performed nor recorded before 0.21.0, on either platform.** Shift-click to extend a
  selection, Command-click to open a link in a background tab, Option-drag to copy, Command+scroll to zoom:
  `click` reads only `button`, `double` and `name`; `drag` and `scroll` have no modifier field; and the bare
  modifier keys are not in the key table, so the chord cannot be composed by hand either. Recording is the
  half that surprises: a recording of a person doing any of them replays as the **unmodified** gesture and
  reports a clean run — not because the replay strips the modifier, but because the recording never saw it.
  The tap does not subscribe to `flagsChanged`, `Recorder.capture` takes no flags, and the transcript's
  five-column format has no modifier column. Fixing the replay alone would change nothing.
- **The "already open" list was in screen pixels while everything else was in the picture's.** Fixed in
  0.18.0. `/windows` reports rectangles in screen pixels and `openList` printed them as such, one paragraph
  below a screenshot the model clicks in — and on a 1680x1050 Mac the shot goes out 1280 wide, so the two
  differed by 31%. A watched run said so out loud: *"the reported coordinates are offset from the
  screenshot"*, and spent two turns on it. The window reading itself was **verified exact** by drawing the
  agent's reported rectangles onto the real screenshot — every box landed on its element — so the list was
  the half that disagreed. It is converted now, by the same formula everything else uses.
- **A save panel is not a window that can be activated, and it was being offered as one.** Measured with a
  panel on screen: the visible sheet belongs to the *application*, while the separate "Open and Save Panel
  Service" keeps windows of its own, none on screen, and one of them carries the same title AND SORTS
  FIRST. So `activate_window {title: "Открыть"}` matched the scaffolding and got "macOS refused to bring
  Open and Save Panel Service (Pages) forward" — which reads as a fault in macOS and is not one. From
  0.18.0 the off-screen windows of that service are dropped from the list, so the title reaches the real
  sheet. Only the off-screen ones: a panel shown as its own window (`runModal` rather than `begin`) is real
  and must stay aimable.
- **The model does not call `read_window` on its own, so the driver calls it.** Measured across two runs
  after the tool was written, its description rewritten, and two prompt rules added telling the model to use
  it: `read_window` and `find_element` were called **zero times in both**, and both runs stalled on exactly
  what those tools answer. From 0.17.0 the rule is code rather than advice — when a turn reports that
  nothing on screen moved, the driver appends a read of the front window to the next turn's actions and puts
  the answer beside the next screenshot. Both drivers do it at the same moment, from the same
  `shouldPeek(still)` in the brain. **It is not a tool_result** — no `tool_use` block matches it, and the
  API refuses a result with no call — and it is not written into the run log, because the user reads their
  own intentions there. Cost: one accessibility read (0.3–2.5s) on a turn that already went to waste,
  against ~6s for the model turn it saves. **Whether it changes the model's behaviour is not yet measured** —
  it is written and tested, and the next run on a real machine is the observation.
- **`read_window` reports what is in a field; a recording still never does.** From 0.17.0 the two paths are
  separate rules rather than one. A RECORDING takes no typed text on either platform — it is stored,
  exported into a SKILL.md, downloaded and forwarded, and the promise printed on the record screen is about
  that. READING A WINDOW does report it: the model calls it between turns, the answer lives one turn and is
  stored nowhere (a run row holds `{tool, input, ms}`; an action's output never reaches it), and the
  screenshot the model is sent every turn already contains the same text. Measured cause: a 198s run typed
  one file name **four times by three mechanisms** — type, type again, then via the clipboard — because
  nothing could say whether it had landed; nine of that block's fourteen steps were repeats, about sixty
  seconds. Values are clipped to 80 characters, because the value of a document body is the document.
  **A password field is exempt on every path**, checked before anything is read, and it is shown as
  `= (password, not read)` rather than as nothing — an empty field shows nothing too, and a model that
  reads a password box as "empty" will type into it. Both facts were found by probing a live window with
  one plain and one secure field, not by reading the code:
  `text field "" … = "plain-visible-value"; secure text field "" … = (password, not read)`.
  **The Windows half is written, not run** — `ValuePattern.ValueProperty` with `IsPassword` and
  `IsReadOnly` excluded — and one asymmetry is deliberate: the Windows search still requires a non-empty
  Name, so an entirely unnamed field can be missed there where macOS now lists it. Relaxing that condition
  changes the size of every Windows result set and was not worth doing blind.
- **A short name that is content still gets recorded, on both platforms.** From 0.16.0 the macOS agent drops
  any element name over 60 characters and writes `namelen=` instead, which is what Windows has done since
  0.11.0 — the accessibility name of a message element *is* the message. The rule is a length, so it cannot
  catch a spell-check item called "Spelling, сторят", which carries one typed word in sixteen characters.
  Nothing measured separates that from a label.

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
| macOS: **the eleven actions added in 0.16.0** | **Written, typechecked, never run.** `swiftc -typecheck` passes and the contract suite holds each against the Windows implementation — which compares text and shapes, not behaviour. Nothing here has photographed a window, read an AX tree under a deadline, or scrolled sideways on a real Mac. |
| macOS: **the horizontal wheel's sign** | **Reasoned, not measured.** `CGEventTypes.h` does not state one; the agent follows `NSEvent.scrollingDeltaX` (positive is left). Recorder and injector share one constant, so an error is mirrored consistently and costs one line. |
| macOS: **the two recording leaks closed in 0.16.0** | Names over 60 characters and query strings in address-shaped window titles no longer reach a recording. **The rule is checked by the suite; the effect on a real recording is not re-measured.** |
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

## The border that says a machine is being driven, and where it does not yet say it

Since 0.22.0 both agents draw a border round every screen while something is driving the computer. Two
things it does not do yet, stated here rather than left to be discovered:

- **On the browser-driven path it pulses instead of burning steadily.** The browser runs the loop and never
  tells the agent that a run is happening — what the agent sees is `/shot`, `/windows`, up to 75 seconds of
  silence while the model thinks, then `/do`. So the border lights per action and goes out a few seconds
  after the last one. Making it steady is a protocol addition (a run-scoped start/stop) plus a change to
  `web/src/lib/desktop-engine.ts`; the courier path already burns steadily because it has real edges. The
  deliberate choice was a lease short enough that "out" is true over one long enough to bridge a model
  turn, because an indicator that lies *after* the end is worse than one that blinks.
- **On Windows older than 10 2004 a single action does not light the border.**
  `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` is what keeps it out of the agent's own screenshots and
  does not exist there, and the six-second lease is the one driver that would then animate across the
  driver's own before/after comparison — every turn, on the comparison that decides whether an action did
  anything. So on those machines the border is shown for goal runs and replays, which hold steady for a
  whole run and cannot animate, and not for single actions. The agent says which of the two it is in its
  startup banner. macOS has two locks and needs no such rule.

Neither is a reason to hold the feature: a person who cannot tell that their mouse is about to be driven is
a worse problem than a border in a screenshot.

---

## The browser extension against the desktop agents

The extension is a second product driving a second surface, and it has its own brain: `extension/agent.js`
carries its own `SYSTEM`, its own `TOOLS` and its own wave loop rather than reading `api/_brain.mjs`, which
the two desktop drivers share. Everything below follows from that split — improvements to the shared brain
have been landing on the desktop side only.

Four of these were not gaps but faults, and all four are fixed. The first two are struck through in the
table below; these two had no row because nobody had thought to look for them:

- **A turn that called no tool was filed as a success.** Both desktop drivers treat it as a failure and
  carry the model's own prose into the reason; this side returned `ok: true`. It mattered more here than
  there, because `background.js` maps `result.ok` straight to the run's outcome, pushes that to the account,
  and the panel offers a successful run as the basis for a reusable skill — so a run that did nothing became
  a saved skill that does nothing.
- **A recording made in the panel could not be reached.** Stop wrote it into the worker's storage and the
  screen said it was on the Record page in the app, which was not true and could not become true — sync
  pushes skills and runs, never recordings. The panel sent nine messages and none was about a recording;
  the replay engine and `skills.js` were written, correct, and had no caller from this UI. There is now a
  **Recorded here** list with play, keep-as-skill (which also pushes it to the account) and delete.
- **`finish` in the same batch as real work discarded the work.** The turn looked for `finish` among the
  calls before carrying any of them out, so "click Send, then finish" finished without clicking and reported
  the errand done. The model batches `finish` constantly, because it saves a turn.
- **Stop could not stop a turn.** `isAborted` was checked between turns and between actions, and the request
  to the model carried no abort signal — so pressing Stop during the eight-to-fifty seconds a turn takes did
  nothing until the next turn, and there might not be one. There was no timeout either.

What is still open, measured rather than estimated:

| | desktop | extension |
|---|---|---|
| actions the model can ask for | 21 | ~~9~~ 13 |
| sees the screen | screenshots | DOM only — no `captureVisibleTab` anywhere |
| checkpoints | `reached_checkpoint` plus a gate the loop waits on | none, and no plan to gate on |
| gives up when nothing changes | warns at 3, stops at 6 | ~~no equivalent~~ same two thresholds, measured on the DOM |
| caps the actions in one turn | `BATCH_MAX` 6, nothing after a terminal action | ~~none~~ the same 6, and nothing after `wait`/`navigate`/`open_tab` |
| prunes old snapshots | `forgetOldPictures` each turn | ~~none~~ `forgetOldPages`, by size rather than type |
| model timeout, cancellable | yes | ~~no~~ same 75s, and Stop now cancels the request in flight |
| one failed action ends the turn | `notBatched` says so to the model | ~~no~~ yes, with the same sentence to each dropped call |
| `finish` in a batch | acted on in order | ~~found first, discarding the turn's real work~~ in order |
| narrated transcript | `api/_transcript.js` | none |
| run from the account | the courier claims jobs | refused: `api/mcp.js` tells the user to run it themselves |
| modifiers in a recording | `mods` on the `#ctx` line since 0.21.0 | none — every Shift-click replays as a plain click |
| parameters in a recorded skill | derived from typing and the control's name | `params: []`, unconditionally |

**How the three implementations are held in step**, since they cannot share a module: `extension/agent.js`
is copied into the package rather than bundled (see `web/vite.extension.config.ts` on what is built and what
is copied), so it cannot import `api/_brain.mjs`. `extension/check-extension.mjs` therefore holds them in
step the way `agent/test-contract.mjs` holds the two desktop agents — by executing both sides and asserting
they agree. `MODEL_TIMEOUT_MS`, `STILL_WARN`, `STILL_GIVE_UP` and `BATCH_MAX` are checked against the
desktop's on every run.

**Where the two surfaces genuinely differ, and why it is not a translation error.** The desktop decides "the
screen moved" from a 64×36 pixel fingerprint; there are no pixels here, so the extension fingerprints what
an action hands back anyway — address, title, the name of any open dialog, how many elements are shown of
how many, and the element list itself including the value of each field, because text typed into a box is a
change that shows in nothing else. And `scroll` is terminal on the desktop but not here: a desktop action is
aimed at a coordinate that scrolling moves, while a browser action is aimed at an element reference that
survives it.

`hover`, `refresh` and `note` are now there, and `click` grew `button` and `double` — the replay engine
had both from the start and the model could ask for neither. `hover` needed almost no machinery: `travelTo`
in `extension/content.js` already raises `pointerover`/`mouseover` the whole way to its target, so the work
was done and there was simply no tool reaching it. It says in its own description what it cannot do: a menu
drawn purely by the CSS `:hover` rule stays shut, because no synthetic event triggers that. And `navigate`
to the address you are already on no longer claims `{navigated: url}` — `goTo` returns early there, so a
stuck page read as one that had just been reloaded and was still stuck.

Still missing: `capture_window`, `find_element`, `scroll_to`, `drag`, `clipboard_read`, `clipboard_write`,
`open_app`, `activate_window`, `wait_for_window` and `reached_checkpoint`. Of those, `open_app` and
`activate_window` are desktop-only by definition; `capture_window` needs the extension to see pixels at
all, which it deliberately does not.

**Not a gap:** the recording format. The extension anchors a step to a selector and a tab, the desktop to a
coordinate plus `#ctx`. That is a different anchor for a different surface, and the browser's is the better
one there; `api/_macro.mjs` has no notion of a selector and should not grow one.

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
