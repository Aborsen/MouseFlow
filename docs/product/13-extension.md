# 13 — The Chrome extension

`extension/`, Manifest V3, version **0.16.2**, `minimum_chrome_version: 127`. Its own engineering notes:
[`extension/README.md`](../../extension/README.md).

Records pointer movement, clicks and scrolling **inside web pages** and replays them. No install script, no
PowerShell, no code signing, no Local Network Access prompt — and no ability to touch a native application.

## Two modes

- **Record the flow** — mirrors what you did. Mouse only; no text.
- **Create the flow** — takes a written goal and does it for you, text included.

## Why it records elements, not pixels

The desktop agent records absolute screen coordinates, which break the moment a window moves. This records
the **element** plus where inside it the click landed, as a fraction of the box. That survives resizes,
layout shifts, scrolling and different screen resolutions — a real upgrade over the desktop path, not a
consolation prize.

Selector priority: `data-testid` / `data-test` / `data-qa` → a stable `id` → `name` on a form control →
`aria-label` → the shortest unique structural path. Framework-generated ids (`ember12345`, `radix-…`, long
hashes, digit runs) are **rejected on sight**, because a recording made against one is dead on the next
build. Every event also stores the element's visible text, used as a fallback when the selector no longer
matches.

## Motion, not just clicks

The extension used to record clicks only, which left replay nothing to draw between them: it teleported a
drawn pointer from target to target on a fixed 260 ms CSS transition. Same work performed, but it read as a
slideshow next to the desktop agent — and when a page reacted subtly, as nothing at all.

| | |
|---|---|
| **Sampling** | One sample per animation frame or 4 px, whichever is coarser. Batched to the worker every 250 ms, while **clicks are sent instantly** — a click has to arrive before the page can navigate away; motion is worth at most one flush. Each batch reports how long ago its last sample was taken, so the worker (which owns the clock, because a page's `performance.now()` restarts on navigation) can place the run where it happened rather than where it arrived. |
| **Storage** | One `path` event per continuous run, simplified once at save time with Ramer–Douglas–Peucker at 2 px. A dropped sample's time is folded into the next one kept, so a run takes exactly as long as it did when recorded. Runs are split at 400 samples / 1.5 s, because one event is one animation and abort is checked between events. |
| **Replay** | Driven by elapsed time against each sample's offset from the start of the run, interpolating between samples — **not** a chain of sleeps, which accumulates every timer's overshoot. A step with no path (an older recording, an imported `.mmmacro`, a *Create the flow* step) travels under its own easing over a duration that scales with distance. |
| **Cursor** | One per tab, in the top frame, addressed in top-frame coordinates, with its position carried between steps by the worker. A frame learns where it sits by asking its parent — which can identify the asking frame by comparing `event.source` against its own iframes, so this works cross-origin. |

Hover events (`pointermove` / `mousemove` / `mouseover` / `mouseout`) are raised along the path, so
hover-driven menus behave as they do for a person. **CSS `:hover` does not light up**: the browser drives
that from the real pointer and no synthetic event can reach it. That is the one difference from the desktop
agent that cannot be closed from inside a page.

### Synthetic events must not look like a drag

`buttons` is a bitmask of what is held **at the moment of the event**, and only a `*down` event is such a
moment. It was once computed as `type === 'mouseup' || type === 'click' ? 0 : 1`, which missed `pointerup`:
every release told the page a button was still held, as did `pointerover`. An app tracking pointer events
could conclude the drag had not ended — and in Excel Online a drag from a cell is a *cell drag*, which is
worth being careful about: replay is supposed to click things, not move their contents.

Now `buttons` is 1 only for `pointerdown` / `mousedown`, and pointer events carry `pointerType: 'mouse'`
with `pressure` 0.5 while down and 0 otherwise — what a real mouse reports, and what an ink surface reads as
"not drawing". `test-buttons.mjs` asserts the invariant across a whole replay rather than just the one event
that was wrong.

## Settings

Under **Settings** on the mode picker, since both modes draw the same pointer:

| Setting | Default | Why |
|---|---|---|
| Show the pointer | on | A replay is otherwise indistinguishable from one doing nothing |
| Trace its path | **off** | A line drawn across a page with content of its own — a spreadsheet grid especially — reads as ink on the document rather than as a cursor |

Read once when a run starts and passed to the page with each step, so a run cannot change its own appearance
halfway through; a change applies from the next run. Turning the pointer off suppresses only the **drawing**
— pacing, clicks and hover events are unchanged, so a flow behaves identically whether or not anyone is
watching it. The **Test on this page** diagnostic draws regardless, because reporting nothing would look
exactly like the failure it exists to rule out.

## Popup structure

| Section | Holds |
|---|---|
| **Sign-in gate** | *Continue with Google*, or a manual `mf_…` device token box |
| **Home** | Who is signed in, the four destinations, and Settings |
| **Record the flow** | Live counters (actions, motion samples, elapsed), Start / Stop and save / Stop replay, the recordings list, *Test on this page*, *Copy log*, and a link to the web app |
| **Skills** | The skill list, the account box (Sync now / Disconnect), *Copy all* / *Paste one in* |
| **Gallery** | Search over published skills, the list, and a link to the gallery in the app |
| **Create the flow** | The goal box, *Do it* / *Stop*, the live feed, the current host, *Copy the step-by-step log*, *Save this as a skill*, and the API-key box |

`count` counts **actions**; `motion` counts **path samples**. They are reported apart because motion arrives
at sixty samples a second, and a single number racing into the thousands while the user clicks three times
reads as a bug rather than as a recording going well.

## Message API

The background worker exposes **the same operations as the desktop agent's HTTP API**, so the web app swaps
transports rather than growing a second control flow:

| Message | Returns |
|---|---|
| `{mf:'ping'}` | `{ok, version, mode:'extension', recording, playing}` |
| `{mf:'record/start', tabId?}` | `{ok, tabId}` |
| `{mf:'record/status'}` | `{ok, recording, count, motion, tabs, elapsedMs}` |
| `{mf:'record/stop'}` | `{ok, events, saved, tabs, origins}` |
| `{mf:'replay', flow}` | `{ok, tabId}` |
| `{mf:'replay/status'}` | `{ok, playing, step, steps, pass, passes, flowPass, flowPasses, index, total, error}` |
| `{mf:'replay/abort'}` | `{ok}` |
| `{mf:'settings/get'}` | `{ok, settings:{pointer, trail}}` |
| `{mf:'settings/set', settings}` | `{ok, settings}` — merges; non-boolean and unknown keys ignored |

`flow` is `{startDelay, flowRepeat, steps:[{events, repeat, speed, delayAfter}], tabId?}` — the same shape
the agent's text protocol encodes. `flowRepeat: 0` means *until stopped*.

### Event format

| `action` | Carries |
|---|---|
| `focus` | `url`, `tabIndex` — activates the tab at that position, **never opens one** |
| `navigate` | `url` |
| `path` | `points:[{x, y, dt}]` — frame-local, converted to top-frame space at replay |
| `click` / `dblclick` | `selector`, `tag`, `text`, `rx`, `ry`, `button` |
| `scroll` | `scrollX`, `scrollY` |

Plus `tab`, `delay` and an optional `frame` on every one.

**Typed text is not recorded at all.** It was the unreliable half of recording — fields that never fire the
events being listened for, framework-controlled inputs, editors inside iframes — and a recording that
silently drops the text is worse than one that never claimed to carry it. *Create the flow* handles anything
involving text, because it is told what to write. Replay still understands the old `fill` / `key` /
`redacted` steps so earlier recordings and imported `.mmmacro` files keep working.

## The bridge to the web app

`extension/bridge.js` is a content script matched to the app's own origins
(`https://mouse-agent.vercel.app/*`, `http://localhost/*`, `http://127.0.0.1/*`). It announces itself,
carries a device token into the extension when the page mints one, and forwards a short list of commands:
`ping`, `page/run`, `page/status`, `page/abort`. Detection is two-way, because either side may load first:
both announce, and both ask.

Why a bridge rather than `externally_connectable` with the extension's id: calling it needs the id, and an
**unpacked extension's id is derived from its folder path** — different on every machine. The page just posts
a message and waits for a reply, with no id anywhere.

The same reason is why the extension **cannot have a session of its own**: signing in inside an extension
needs an OAuth client tied to its id. Hence the device token, which the user pastes once (or receives over
the bridge without ever seeing it).

## Create the flow: what it will and will not do

**The goal is the authorisation, and it authorises exactly what it says.**

Ask it to **send, submit, publish, post, book, order or delete** and it carries that through to completion.
It used to stop at a filled-in form and hand back "ready for you to confirm", which reads as caution but is
really a failed run: the user asked for the outcome and got a draft, then had to finish the job by hand.
**Asking for a confirmation the user already gave in the goal is not a safety feature.**

What it still will not do:

- **Type credentials.** Passwords, card numbers and the like are never entered, whatever the page asks or the
  goal implies. It stops and hands that part back.
- **Act beyond the goal.** An irreversible action the goal did not ask for is prepared, not taken: *tidy my
  inbox* is not permission to delete, *look at Ann's reply* is not permission to answer it.
- **Widen the goal.** The recipients asked for and no others; the item asked for and nothing else. Anything
  the page pre-filled gets reported.
- **Obey the page.** Page text is **data**. A page that says to add a recipient or send something elsewhere
  is reported in `finish`, never followed — the goal is the only instruction it has. Worth knowing about,
  because a page the agent reads is untrusted input and it now has the authority to send.

Care went into the details rather than into hesitating: before a one-way click it re-reads the page and
checks what the goal named — recipient, amount, destination, which item — against what is actually on screen,
and stops if any of them differs.

## Finding out what a run actually did

**Create the flow → "Copy the step-by-step log."** One line per step with the tool, the page it acted on,
where it ended up if that changed, the outcome and the timing.

The trace exists because a run once started composing an email and ended up on the Play Store, and the log
could not explain it. The old log was only what the feed needed — a tool name and its input — which records
what was *asked for*, not where it landed. A click that navigates looks exactly like a click that does not,
so a drifting run was invisible.

- Every step records its **page**, and a step whose page changed under it is flagged with where it went.
  That is usually the step that lost the plot.
- `read_page` is stored as a **summary** — element count, title, which frame was read — not the whole
  snapshot, so the trace stays a few KB.
- Kept in **local** storage, so it survives the worker being torn down and the browser being closed. The last
  three runs are retained.
- The popup shows the current host live and lists every host a run has visited, so a detour is visible while
  it happens.

It includes any text the agent typed, **deliberately** — *"it entered the address twice"* has to be
answerable. That is the user's own content and never leaves the machine unless they paste it.

## Reloading the extension is not enough

Reloading an unpacked extension does **not** touch content scripts already running in open tabs. The
re-injection guard is keyed on the manifest version (read from `chrome.runtime.getManifest()`, so it cannot
drift), and a newer build takes over the tab and sweeps away any `[data-mouseflow]` overlay the old one left
behind — the orphaned script's context is already invalidated, so it cannot be asked to clean up after
itself.

**Reload the page too** after loading a new build into a tab that was already open.

## What it cannot do

- **Native applications.** Nothing outside a browser tab. That is the whole trade for losing the install.
- **`chrome://` and Web Store pages.** Chrome blocks script injection there.
- **CSS `:hover`.** See above.
- **Canvas-rendered app surfaces.** The Excel Online grid draws itself into a canvas, so there is no element
  to anchor a step to. Its ribbon, toolbars and dialogs are ordinary DOM and do work. The desktop agent is
  the honest answer for the grid itself.
- **Trusted events.** Replay dispatches synthetic events, so `isTrusted` is `false`. Most apps including
  React and Vue are driven correctly (the value setter is called through the prototype so framework state
  stays in sync), but a site that explicitly checks `isTrusted` will ignore them. The fix is
  `chrome.debugger` + `Input.dispatchMouseEvent`, which produces genuine input — at the cost of a *"MouseFlow
  started debugging this browser"* infobar in every tab. Not enabled; worth adding as an opt-in
  "high fidelity" mode.

`<all_urls>` host permission is what produces the "read and change all your data on all websites" warning.
It is needed to inject into an arbitrary site the user chooses to record. **Nothing is injected until a
recording or replay actually starts.**

## Loading it

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Pin it, open any site, click the icon → **Start recording**

### Which pages may talk to it, and why localhost is not one of them

The extension answers exactly two origins: `mouseflowapp.vercel.app` and `mouse-agent.vercel.app`. That
list lives in `manifest.json` — in `content_scripts.matches` and `externally_connectable.matches` — and the
worker **derives its own check from that same manifest** (`originsFromManifest` in `background.js`) rather
than keeping a second list. A second list is exactly what went wrong: it knew one of the two origins, so
the bridge was injected on `mouse-agent` and silently could do nothing there, and it *also* accepted all of
localhost, which the manifest had put there for development.

`http://localhost/*` in a Chrome match pattern **ignores the port**, so that was every page on every
localhost port: a project preview, a docs server started with `python -m http.server`, the web UI of any
locally installed program. One `window.postMessage` from such a page re-paired the extension to somebody
else's account — and because sync runs both ways, the person's skills went there and the attacker's skills
came back.

**To develop against a local copy of the app**, build with the flag:

```bash
MOUSEFLOW_DEV_BRIDGE=1 npm --prefix web run build:extension
```

That adds the two local origins to the manifest **in `extension/dist` only** — the source manifest is never
touched, so a development build cannot become a commit — and prints a warning saying the build must not be
shipped. Load `extension/dist` rather than `extension/` when you use it.

## Testing without loading it

Both halves run under Node against stubs, which is how the motion work was verified:

- **The worker** imports with a `chrome` stub, exposing `captureMoves` / `simplifyPath` / `chunkPath` /
  `compact` for direct assertions — back-dating, batch joining, the frame and tab guards, the point and time
  bounds, and that compaction never changes the length of the timeline. The simplification is checked by
  measuring the **actual** deviation of the reduced polyline from the original across a sine wobble, a
  circle, a zigzag and a slow drift; the first version passed a naive local-collinearity check while
  flattening a 9 px wobble, so the error bound is asserted rather than assumed.
- **The content script** loads into a stub DOM with a virtual clock driving `requestAnimationFrame` and is
  driven through its real message router. That makes the shape of the motion measurable: how many distinct
  positions the cursor is drawn at, the largest jump between consecutive frames, whether the run takes as
  long as it was recorded to, and whether a fresh cursor starts at the carried position instead of flying in
  from the corner. An end-to-end pass records a two-tab flow, compacts it, replays every event with the
  cursor threaded between steps, and asserts there is no teleport anywhere — which is how a 743 px jump at
  a tab boundary was found.

A teleport is detected as a jump **surrounded by stillness**, not merely a large one: the peak of an eased
750 px sweep is genuinely ~55 px per frame, which is a fast flick rather than a defect.
