# MouseFlow Chrome extension

Records pointer movement, clicks and scrolling **inside web pages** and replays them. No
install, no PowerShell, no signing, no Local Network Access prompt — and no ability to touch
native apps.

Two modes: **Record the flow** mirrors what you did (mouse only — no text), and **Create the
flow** takes a written goal and does it for you, text included.

## Load it

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `extension/` folder
3. Pin it, open any site, click the icon → **Start recording**

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

## Message API

The background worker exposes the **same operations as the desktop agent's HTTP API**, so the
web app swaps transports rather than growing a second control flow:

| Message | Returns |
|---|---|
| `{mf:'ping'}` | `{ok, version, mode:'extension', recording, playing}` |
| `{mf:'record/start', tabId?}` | `{ok, tabId}` |
| `{mf:'record/status'}` | `{ok, recording, count, motion, tabs, elapsedMs}` |
| `{mf:'record/stop'}` | `{ok, events, saved, tabs, origins}` |
| `{mf:'replay', flow}` | `{ok, tabId}` |
| `{mf:'replay/status'}` | `{ok, playing, step, steps, pass, passes, flowPass, flowPasses, index, total, error}` |
| `{mf:'replay/abort'}` | `{ok}` |

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

## Still to wire

The app at `mouse-agent.vercel.app` cannot talk to this yet. `externally_connectable` is
declared, but calling it needs the extension's ID, and an unpacked extension's ID is derived
from its folder path — different on every machine.

The fix is **not** to make users paste an ID: add a content script matched to the app's own
origin that bridges `window.postMessage` ↔ `chrome.runtime.sendMessage`. The page then just
posts a message and waits for a reply, with no ID anywhere. Pinning the ID with a manifest
`key` is the alternative, and is worth doing anyway before publishing.

## Testing without loading it

Both halves run under Node against stubs, which is how the motion work was verified:

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
