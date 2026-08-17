# MouseFlow Chrome extension

Records clicks, typing and scrolling **inside web pages** and replays them. No install, no
PowerShell, no signing, no Local Network Access prompt — and no ability to touch native apps.

## Load it

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `extension/` folder
3. Pin it, open any site, click the icon → **Start recording**

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

Passwords are **never stored**. A password field records as a `redacted` step that stops the
replay and asks the user to type it.

## What it cannot do

- **Native apps.** Nothing outside a browser tab. That is the whole trade for losing the install.
- **`chrome://` and Web Store pages.** Chrome blocks script injection there.
- **Cross-origin iframes.** Only the top frame is instrumented today.
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
| `{mf:'record/status'}` | `{ok, recording, count, elapsedMs}` |
| `{mf:'record/stop'}` | `{ok, events}` |
| `{mf:'replay', flow}` | `{ok, tabId}` |
| `{mf:'replay/status'}` | `{ok, playing, step, steps, pass, passes, flowPass, flowPasses, index, total, error}` |
| `{mf:'replay/abort'}` | `{ok}` |

`flow` is `{startDelay, flowRepeat, steps:[{events, repeat, speed, delayAfter}], tabId?}` —
the same shape the agent's text protocol encodes.

## Still to wire

The app at `mouse-agent.vercel.app` cannot talk to this yet. `externally_connectable` is
declared, but calling it needs the extension's ID, and an unpacked extension's ID is derived
from its folder path — different on every machine.

The fix is **not** to make users paste an ID: add a content script matched to the app's own
origin that bridges `window.postMessage` ↔ `chrome.runtime.sendMessage`. The page then just
posts a message and waits for a reply, with no ID anywhere. Pinning the ID with a manifest
`key` is the alternative, and is worth doing anyway before publishing.

## Testing without loading it

The selector and replay logic is plain DOM code with no extension APIs, so it can be exercised
directly: fetch `content.js`, cut it at the `messages` marker, `new Function(...)` the
remainder, and call `selectorFor` / `perform` / `resolve` against a fixture. That is how the
current logic was verified — selector priority, generated-id rejection, unique structural
fallback, click and fill dispatch, text fallback, and the password refusal.
