# MouseFlow Chrome extension

Records pointer movement, clicks and scrolling **inside web pages** and replays them. No
install, no PowerShell, no signing, no Local Network Access prompt — and no ability to touch
native apps.

Two modes: **Record the flow** mirrors what you did (mouse only — no text), and **Create the
flow** takes a written goal and does it for you, text included.

## Load it

The panel is built from the app's own components, so there is a build step now — and what Chrome loads is
the OUTPUT, not this folder.

```bash
npm run build:extension
```

From the repository root — it runs the web build for you. (`cd web && npm run build:extension` works too,
which is the same command one directory down and the reason the root one exists: typing `cd web` while
already in `web` is a mistake that looks like a build failure and is not.)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `extension/dist`
3. Pin it, open any site, click the icon → the **side panel** opens

### Why a build, and why dist

The panel renders the same Button, Pill, Said, SearchField and SelectionBar the web app does — literally the
same files, from `web/src` — on the same palette. The alternative was a second copy of the design, and a
second copy is one that drifts: the app had four search boxes that had quietly stopped agreeing about their
focus ring, their height and whether they had an accessible name at all.

What is bundled and what is not:

| | |
|---|---|
| bundled | `sidepanel.html`, `popup.html` and everything they import — React, the design system, the palette |
| copied whole | `manifest.json`, `background.js`, `content.js`, `bridge.js`, `agent.js`, `skills.js`, `icons/` |

The service worker and the content scripts stay hand-written: they run in worlds where a module graph is a
liability, and they have no UI. `web/vite.extension.config.ts` is the whole arrangement, with the reasoning
in its header.

### Connecting, without a button

The panel attaches itself. When it opens unattached it asks the worker (`auth/auto`), which finds a tab on
the app's origin - or opens one in the background and closes it again - and has `bridge.js` mint a device
token **with the session already in this browser**. Nothing to copy, nothing to press, and no second login:
it is the same MouseFlow account you are signed in to over there.

The only case that needs a person is not being signed in at all, and then the panel says so and offers the
sign-in rather than reporting a failure.

Two things worth knowing:

- **A tab opened before the extension was loaded cannot answer.** Its content script belongs to a generation
  that no longer exists. That is the ordinary case right after installing, so it is not treated as an error:
  the worker opens a fresh tab, which is guaranteed to have a live script in it.
- **This is not a new power.** `bridge.js` already minted and handed over a token when somebody pressed
  "Connect extension"; what changed is who starts it. Anything running on the app's origin holds the session
  and could mint one anyway - which is the trust boundary that file's header describes.

### The panel, not the popup

A popup closes the moment you click the page — and recording a flow, or describing one while looking at it,
IS clicking the page. Both live in the side panel now, which stays open while you work. The toolbar icon
still opens a popup; its one job is to open the panel.

## Motion, not just clicks

The desktop agent hooks `WM_MOUSEMOVE` and keeps a sample every 10ms / 3px, so a replay walks
the real cursor along the path the user actually took. This extension used to record clicks
only, which left replay nothing to draw between them: it teleported a drawn pointer from target
to target on a fixed 260ms CSS transition. Same work performed, but it read as a slideshow next
to the desktop — and when a page reacted subtly, as nothing at all.

It now records the path too, on the same principle as the agent (a sample per animation frame
or 4px, whichever is coarser) and replays it as interpolated animation:

- **Sampling** is batched to the worker every 250ms, while clicks are still sent instantly —
  a click has to arrive before the page can navigate away, motion is worth at most one flush.
  Each batch reports how long ago its last sample was taken, so the worker (which owns the
  clock, because a page's `performance.now()` restarts on navigation) can place the run where
  it happened rather than where it arrived.
- **Storage** keeps one `path` event per continuous run, simplified once at save time with
  Ramer–Douglas–Peucker at a 2px tolerance. A dropped sample's time is folded into the next
  one kept, so a run still takes exactly as long as it did when recorded. Runs are split at
  400 samples / 1.5s, because one event is one animation and abort is checked between events.
- **Replay** is driven by elapsed time against each sample's offset from the start of the run,
  interpolating between samples — not a chain of sleeps, which would accumulate every timer's
  overshoot. A step carrying no path (older recordings, imported `.mmmacro`, *Create the flow*)
  travels under its own easing instead, over a duration that scales with distance.
- **One cursor per tab**, in the top frame, addressed in top-frame coordinates, with its
  position carried between steps by the worker. A frame learns where it sits by asking its
  parent — which can identify the asking frame by comparing `event.source` against its own
  iframes, so this works cross-origin.

Hover events (`pointermove`/`mousemove`/`mouseover`/`mouseout`) are raised along the path, so
hover-driven menus behave as they do for a person. CSS `:hover` does **not** light up: the
browser drives that from the real pointer and no synthetic event can reach it. That is the one
difference from the desktop agent that cannot be closed from inside a page.

### Settings

Under **Settings** on the mode picker, since both modes draw the same pointer:

| Setting | Default | |
|---|---|---|
| Show the pointer | on | A replay is otherwise indistinguishable from one doing nothing |
| Trace its path | **off** | A line drawn across a page with content of its own — a spreadsheet grid especially — reads as ink on the document rather than as a cursor |

Read once when a run starts and passed to the page with each step, so a run cannot change its
own appearance halfway through; a change applies from the next run. Turning the pointer off
suppresses only the **drawing** — pacing, clicks and hover events are unchanged, so a flow
behaves identically whether or not anyone is watching it. The **Test on this page** diagnostic
draws regardless, because reporting nothing would look exactly like the failure it exists to
rule out.

## Why it records elements, not pixels

The desktop agent records absolute screen coordinates, which break the moment a window moves.
This records the **element** plus where inside it the click landed, as a fraction of the box.
That survives resizes, layout shifts, scrolling and different screen resolutions — a real
upgrade over the desktop path, not a consolation prize.

Selector priority: `data-testid`/`data-test`/`data-qa` → stable `id` → `name` on a form control
→ `aria-label` → shortest unique structural path. Framework-generated ids (`ember12345`,
`radix-…`, long hashes, digit runs) are rejected on sight, because a recording made against one
is dead on the next build. Every event also stores the element's visible text, used as a
fallback when the selector no longer matches.

Typed text is **not recorded** at all. It was the unreliable half of recording (fields that
never fire the events we listened for, framework-controlled inputs, editors inside iframes), and
a recording that silently drops the text is worse than one that never claimed to carry it.
*Create the flow* handles anything involving text, because it is told what to write. Replay
still understands the old `fill` / `key` / `redacted` steps so earlier recordings and imported
`.mmmacro` files keep working.

## Reloading the extension is not enough

Reloading an unpacked extension does **not** touch the content scripts already running in open
tabs. The re-injection guard used to be a bare `window.__mouseflowContent = true`, so a fresh
copy of a new build injected into such a tab bailed out immediately and the tab went on running
the old code until the page itself was reloaded — which makes a fix look like it did nothing.

The guard is now keyed on the manifest version (read from `chrome.runtime.getManifest()`, so it
cannot drift), and a newer build takes over the tab and sweeps away any `[data-mouseflow]`
overlay the old one left behind — the orphaned script's context is already invalidated, so it
cannot be asked to clean up after itself.

**Reload the page too** after loading a new build into a tab that was already open.

## Synthetic events must not look like a drag

`buttons` is a bitmask of what is held down *at the moment of the event*, and only a `*down`
event is such a moment. It used to be computed as `type === 'mouseup' || type === 'click' ? 0 : 1`,
which missed `pointerup`: every release told the page a button was still held, as did
`pointerover`. An app that tracks pointer events could therefore conclude the drag had not
ended. In Excel Online a drag from a cell is a cell drag, which is worth being careful about —
replay is supposed to click things, not move their contents.

Now `buttons` is 1 only for `pointerdown`/`mousedown`, and pointer events also carry
`pointerType: 'mouse'` with `pressure` 0.5 while down and 0 otherwise, which is what a real
mouse reports and what an ink surface reads as "not drawing". `test-buttons.mjs` asserts the
invariant across a whole replay rather than just the one event that was wrong.

## What it cannot do

- **Native apps.** Nothing outside a browser tab. That is the whole trade for losing the install.
- **`chrome://` and Web Store pages.** Chrome blocks script injection there.
- **CSS `:hover`.** Synthetic events cannot reach it; see above.
- **Canvas-rendered app surfaces.** The Excel Online grid draws itself into a canvas, so there
  is no element to anchor a step to. Its ribbon, toolbars and dialogs are ordinary DOM and do
  work. The desktop agent is the honest answer for the grid itself.
- **Trusted events.** Replay dispatches synthetic events, so `isTrusted` is `false`. Most apps
  including React and Vue are driven correctly (the value setter is called through the
  prototype so framework state stays in sync), but a site that explicitly checks `isTrusted`
  will ignore them. The fix is `chrome.debugger` + `Input.dispatchMouseEvent`, which produces
  genuine input — at the cost of a *"MouseFlow started debugging this browser"* infobar in every
  tab. Not enabled; worth adding as an opt-in "high fidelity" mode.

`<all_urls>` host permission is what produces the "read and change all your data on all
websites" warning. It is needed to inject into an arbitrary site the user chooses to record.
Nothing is injected until a recording or replay actually starts.

## Finding out what a run actually did

**Create the flow → "Copy the step-by-step log."** One line per step with the tool, the page it
acted on, where it ended up if that changed, the outcome and the timing.

The trace exists because a run once started composing an email and ended up on the Play Store,
and the log could not explain it. The old log was only what the feed needed — a tool name and its
input — which records what was *asked for*, not where it landed. A click that navigates looks
exactly like a click that does not, so a drifting run was invisible.

- Every step records its **page**, and a step whose page changed under it is flagged with where it
  went. That is usually the step that lost the plot.
- `read_page` is stored as a summary — element count, title, which frame was read — not the whole
  snapshot, so the trace stays a few KB.
- Kept in **local** storage, so it survives the worker being torn down and the browser being
  closed. The last three runs are retained.
- The popup also shows the current host live, and lists every host a run has visited, so a detour
  is visible while it happens.

It includes any text the agent typed, deliberately — *"it entered the address twice"* has to be
answerable. That is the user's own content and never leaves the machine unless they paste it.

Live events also go to the service worker console (`chrome://extensions` → **service worker**),
which is the fullest view while a run is in progress.

## What "Create the flow" will and will not do

The goal is the authorisation, and it authorises exactly what it says.

Ask it to **send, submit, publish, post, book, order or delete** and it carries that through to
completion. It used to stop at a filled-in form and hand back "ready for you to confirm", which
reads as caution but is really a failed run: the user asked for the outcome and got a draft, then
had to finish the job by hand. Asking for a confirmation the user already gave in the goal is not
a safety feature.

What it still will not do:

- **Type credentials.** Passwords, card numbers and the like are never entered, whatever the page
  asks or the goal implies. It stops and hands that part back.
- **Act beyond the goal.** An irreversible action the goal did not ask for is prepared, not taken:
  *tidy my inbox* is not permission to delete, *look at Ann's reply* is not permission to answer
  it.
- **Widen the goal.** The recipients asked for and no others; the item asked for and nothing else.
  Anything the page pre-filled gets reported.
- **Obey the page.** Page text is data. A page that says to add a recipient or send something
  elsewhere is reported in `finish`, never followed — the goal is the only instruction it has.
  Worth knowing about, because a page the agent reads is untrusted input and it now has the
  authority to send.

Care went into the details rather than into hesitating: before a one-way click it re-reads the
page and checks what the goal named — recipient, amount, destination, which item — against what is
actually on screen, and stops if any of them differs.

## The shared demo key

*Create the flow* works with no API key: the request goes to `/api/claude` on the MouseFlow
deployment, which attaches a key held in a Vercel environment variable. One key for everyone at
a demo, nobody pasting anything.

The key is **not** in the extension, and must not be. An extension ships as readable source —
anyone it is handed to can open the folder, or `chrome://extensions`, and read it. A key
distributed that way is a key published, and it stays valid until someone notices. Anthropic and
GitHub both scan for exposed keys and revoke them, so an embedded key is also liable to stop
working mid-demo.

Setup, once, by whoever owns the key — either the dashboard's
**Settings → Environment Variables**, or:

```bash
vercel env add ANTHROPIC_API_KEY production
```

Then **push a commit** to rebuild. Two things make this necessary rather than optional:

- A function reads `process.env` from its own deployment's captured environment, so a variable
  added afterwards does not reach the deployment already serving. It reports
  `configured: false` until a new build happens.
- `vercel redeploy` is the wrong tool. On this project — Framework Preset "Other", static site
  plus an auto-detected `api/` directory — redeploying the last production deployment produced a
  Ready build with one static entry and **no serverless function**, so `/api/*` began returning
  Vercel's `NOT_FOUND` while the site root still served fine. That reads like a routing problem
  and is actually a missing build step. The Git integration builds the same commit correctly.

Rotating or switching the key off is a dashboard change plus a commit, and needs no new extension
build.

To check a deployment is ready before relying on it:

```bash
curl https://mouse-agent.vercel.app/api/claude
```

`{"ok":true,"configured":true,...}` means a key is set. It reports a boolean and nothing else —
a prefix, a suffix or even a length would narrow a guess — and costs nothing upstream.

`api/claude.js` spends money for anyone who can reach it, so it is deliberately narrow: one
model from an allowlist, `max_tokens` clamped to 16000, at most 120 messages per request, and
the payload rebuilt field by field rather than forwarded wholesale, so a caller cannot smuggle
in options it is not meant to pay for. That bounds the damage if the URL gets around; it does
**not** make the endpoint private. Put auth in front of it for anything past a demo.

Saving a personal key overrides all of this: the run goes straight to `api.anthropic.com` on
that key, and the proxy is not involved. The popup's key box says which one is in use, because
it decides whose quota is spent.

## Message API

The background worker exposes the **same operations as the desktop agent's HTTP API**, so the
web app swaps transports rather than growing a second control flow:

| Message | Returns |
|---|---|
| `{mf:'ping'}` | `{ok, version, mode:'extension', recording, playing}` |
| `{mf:'record/start', tabId?}` | `{ok, tabId}` |
| `{mf:'record/status'}` | `{ok, recording, count, motion, tabs, elapsedMs}` |
| `{mf:'record/stop'}` | `{ok, events, saved, tabs, origins}` |
| `{mf:'record/list'}` | `{ok, recordings:[{id, name, created, origins, tabs, events}]}` — newest first, `events` is a COUNT |
| `{mf:'record/play', id?, loop?}` | `{ok, tabId}` — plays one without keeping it; newest when no id |
| `{mf:'record/keep', id?, name?}` | `{ok, skill, synced, syncError}` — saves it, pushes it, drops it from the list |
| `{mf:'record/forget', id}` | `{ok, left}` |
| `{mf:'skills/run', id, loop?, values?}` | `{ok, tabId}` — this is how a saved recording is replayed |
| `{mf:'replay/status'}` | `{ok, playing, step, steps, pass, passes, flowPass, flowPasses, index, total, error}` |
| `{mf:'replay/abort'}` | `{ok}` |
| `{mf:'settings/get'}` | `{ok, settings:{pointer, trail}}` |
| `{mf:'settings/set', settings}` | `{ok, settings}` — merges; non-boolean and unknown keys ignored |

This table is the part the app's transports care about, not the whole vocabulary: `ROUTES` in
`background.js` has thirty-three entries, including the whole of skills and the gallery. `route()` is
the authority — and everything not listed in `OPEN_WITHOUT_ACCOUNT` answers `{ok:false, signedOut:true}`
until this browser is paired.

`flow` is `{startDelay, flowRepeat, steps:[{events, repeat, speed, delayAfter}], tabId?}` —
the same shape the agent's text protocol encodes. `flowRepeat: 0` means *until stopped*.

`count` counts actions; `motion` counts path samples. They are reported apart because motion
arrives at sixty samples a second, and a single number racing into the thousands while the user
clicks three times reads as a bug rather than as a recording going well.

An event is one of:

| `action` | Carries |
|---|---|
| `focus` | `url`, `tabIndex` — activates the tab at that position, never opens one |
| `navigate` | `url` |
| `path` | `points:[{x, y, dt}]` — frame-local, converted to top-frame space at replay |
| `click` / `dblclick` | `selector`, `tag`, `text`, `rx`, `ry`, `button` |
| `scroll` | `scrollX`, `scrollY` |

plus `tab`, `delay` and an optional `frame` on every one.

## What happens to a recording after Stop

Stop writes the recording into the worker's own storage, and the panel's **Recorded here** list is
what reaches it: play it back, keep it as a skill, or throw it away. Keeping it also pushes it to
the account, which is where the Skills list in the panel reads from — without that push the skill
existed on this browser and the list that was meant to show it never could.

That list is newer than most of this file, and the reason it exists is worth writing down. For a
while the panel could start and stop a recording and do nothing else with it: the four commands
(`record/list`, `record/play`, `record/keep`, `record/forget`) did not exist, the replay engine and
`skills.js` had no caller from this UI, and the screen said *"Saved. It is on the Record page in the
app"* — which was not true and could not become true, because sync pushes skills and runs and never
recordings. The engine was already written and already right. What was missing was a caller.

## Still to wire

Nothing about reaching the app: the bridge is built. `bridge.js` is a content script matched to the
app's own origin and turns `window.postMessage` ↔ `chrome.runtime.sendMessage`, so the page posts a
message and waits for a reply with no extension ID anywhere — which is what Create's browser mode
runs on. (Pinning the ID with a manifest `key` is still worth doing before publishing; that is a
distribution job, not a wiring one.)

What IS still to wire is measured in `docs/product/19-limits-and-known-gaps.md`: this half has nine
tools where the desktop brain has twenty-one, no checkpoints, no stillness rule, no pruning of old
page snapshots, and nothing on the account can start a run in here — `api/mcp.js` refuses a browser
skill outright and tells the user to run it from the extension themselves.

## Testing without loading it

`node extension/check-extension.mjs`, which runs as part of `npm test`. It imports `background.js`
whole with a stub in place of `chrome`, and sends messages through the REAL `route()` — the same one
the panel's messages arrive at, account gate included — so what is checked is the path rather than
the presence of a function. It also runs `runGoal` against a stubbed model to prove that a turn
calling no tool is reported as a failure, which is the rule this side had backwards.

Both halves also run under Node against stubs, which is how the motion work was verified:

- **The worker** imports with a `chrome` stub, exposing `captureMoves` / `simplifyPath` /
  `chunkPath` / `compact` for direct assertions — back-dating, batch joining, the frame and
  tab guards, the point and time bounds, and that compaction never changes the length of the
  timeline. The simplification is checked by measuring the **actual** deviation of the reduced
  polyline from the original across a sine wobble, a circle, a zigzag and a slow drift; the
  first version of it passed a naive local-collinearity check while flattening a 9px wobble,
  so the error bound is asserted rather than assumed.
- **The content script** loads into a stub DOM with a virtual clock driving
  `requestAnimationFrame`, and is driven through its real message router. That makes the shape
  of the motion measurable: how many distinct positions the cursor is drawn at, how large the
  largest jump between consecutive frames is, whether the run takes as long as it was recorded
  to, and whether a fresh cursor starts at the carried position instead of flying in from the
  corner. An end-to-end pass records a two-tab flow, compacts it, replays every event with the
  cursor threaded between steps, and asserts there is no teleport anywhere — which is how the
  743px jump at the tab boundary was found.

A teleport is detected as a jump *surrounded by stillness*, not merely a large one: the peak of
an eased 750px sweep is genuinely ~55px per frame, which is a fast flick rather than a defect.
