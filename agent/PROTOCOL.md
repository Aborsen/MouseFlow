# The local agent protocol

What any MouseFlow desktop agent must implement, whatever it is written in. Extracted from the two things
that already agree on it: `agent/mouseflow-agent.ps1` (the Windows implementation) and
`web/src/lib/agent.ts` (the only client).

This file exists because there are now two implementations: `agent/mouseflow-agent.ps1` (Windows,
PowerShell) and `agent/mouseflow-agent.swift` (macOS, compiled on the machine by `agent/install-mac.sh`).
Until there was a second, the contract lived in a PowerShell comment block and in a TypeScript file, and
neither knew it was a contract.

**If you are writing a new agent: implement this and nothing else.** Do not change `web/src/lib/agent.ts`,
`web/src/lib/desktop-engine.ts` or the Connections screen — they are shared, and a second session editing
them is a merge conflict rather than a feature. If your platform cannot honour something here, say so and
propose the change; do not implement your own variant of it.

## The shape of it

A plain HTTP server on `127.0.0.1`, default port **8787**, no TLS, no framework. Loopback only — never bind
`0.0.0.0`. The client sends `Origin` and expects CORS headers back (see **Authentication** below, which is
being changed and is the one part of this document not yet settled).

Responses are JSON with `{ ok: true, ... }` on success, except `/record/stop`, which returns `text/plain`.
Failures return a non-2xx status and `{ error: "..." }` — the client surfaces that message to the user
verbatim, so write it for a person.

Every endpoint has a client-side deadline (`DEADLINE` in `web/src/lib/agent.ts`). Exceeding it is reported to
the user as the agent being unreachable, so a slow answer is worse than a refusal.

| Method | Path | Deadline | Returns |
|---|---|---|---|
| GET | `/health` | 4s | `{ok, version, screen:{w,h}, recording, playing, canSee, canWindows, canName, canKeys}` |
| GET | `/shot` | 12s | `{ok, png, format, bytes, w, h, scale, originX, originY}` |
| GET | `/shot?w=640` | 12s | the same, smaller — asked for after a 413 upstream |
| GET | `/pulse` | 5s | `{ok, grid}` — 64×36 greyscale samples as a short string |
| GET | `/windows` | 5s | `{ok, windows:[{title, process, active, minimized, x, y, w, h}]}` |
| POST | `/do` | 20s | `{ok}` — one action, body is `key=value` text (below) |
| POST | `/record/start` | 5s | `{ok, moveMs}` — `?moveMs=250` thins the pointer path for a long session |
| GET | `/record/status` | 2.5s | `{recording, count, part, moveMs, elapsedMs}` |
| POST | `/record/drain` | 15s | **text/plain**, what has piled up so far; **the recording continues** |
| POST | `/record/stop` | 15s | **text/plain**, one event per line (`.mmmacro`) |
| POST | `/replay` | 5s | `{ok}` — starts a replay, returns immediately |
| GET | `/replay/status` | 2.5s | `{playing, step, steps, pass, passes, index, total, unplayable}` |
| POST | `/replay/abort` | 4s | `{ok}` |
| POST | `/autostart/enable` | 8s | `{ok}` — needs the agent to exist as a file on disk |
| POST | `/autostart/disable` | — | `{ok}` |

### `/record/drain` and `?moveMs=` — a session that lasts a working day

Added in 0.8.0, and the reason is arithmetic rather than taste. Measured over the recordings this project has
actually made: **69 bytes an event, 23-42 events a second**, so 1.5-2.9 KB/s. The app refuses a payload over
400KB (`api/sync.js`), which arrives around the **third minute** — and `/record/stop` used to be the only way
events left an agent, so eight hours meant ~830,000 events held in memory and returned in one string.

`/record/drain` takes what has piled up and **keeps recording**. What it must NOT touch is the whole point,
and every omission is load-bearing:

- **the clock runs on**, so `elapsedMs` stays the time of the SESSION. A chunk knows its own length from its
  events; only the session can say how far in it is.
- **the last-event timestamp and position stay**, or one unthrottled burst of movement gets through at the
  start of every chunk.
- **the held-button count stays**, or a drain landing mid-drag lets a `Focus` marker split the next chunk's
  press from its release.
- **the last foreground window stays**, so an unchanged window is not re-announced every chunk.

Chunk metadata rides on a `#part` line above the events, the same way `#ctx` travels, so every existing
reader of the format loads a chunk as an ordinary recording:

```
#part	n=3	elapsedMs=5400123	events=812	moveMs=250	dropped=0
```

**409 when nothing is recording**, not an empty body: "nothing happened in the last half hour" and "there is
no recording" have to be distinguishable, or a chunker writes an empty part every half hour for as long as
the tab stays open.

`?moveMs=` on `/record/start` is the other half of fitting. Pointer movement is **93.75% of the events and
88.6% of the bytes** (measured, not assumed), and at the 10ms default that is up to a hundred samples a
second of a path nothing reads — the transcript, the story and the analytics all read clicks, scrolls, keys
and the change of window. At 250ms the "was somebody at this machine" signal survives and a 30-minute chunk
fits inside the 400KB cap. **Per session, not global**: a plain `/record/start` afterwards records at the
default again. Replay of a thinned recording is coarser, deliberately — a day-long session is recorded to be
READ, not replayed.

### The capability flags

The `can*` flags exist because a version number could not answer the question that mattered. An
agent started before the click resolver existed and one started after it reported the same `0.5.0`, and the
difference was the whole transcript — a list of coordinates against a list of named actions. So each
capability is stated: `canSee` (screenshots), `canWindows` (`/windows`), `canName` (`#ctx` on a click),
`canKeys` (typing as an event). An older agent omits a flag, and absent is the answer. `canKeys` is the one
that can be **false** rather than absent: the keyboard hook may fail to install, and the agent runs without
it rather than refusing to start.

Since 0.8.0 there are three more, and two of them are macOS answering questions Windows cannot be asked:

- `canDrain` — whether a recording can outlast one response (`/record/drain`). Without it a session is
  bounded by what fits in memory and in one string, and the app must offer a short recording rather than a
  day-long one it cannot take delivery of.
- `platform` — `windows` or `macos`. Used for exactly one thing: which install command the Connections
  screen shows. Never to decide what an agent can do — that is what the `can*` flags are for.
- `permissions` — `{accessibility, screenRecording}`, macOS only. On Windows both are unconditionally true
  and there is nothing to report; on macOS the user grants them per-binary in System Settings and no code can
  grant either, so `canSee` follows Screen Recording and `canName` follows Accessibility, and this field says
  which switch to flip. Without it the failure is a working agent, a black screenshot and no explanation.

`version` is checked by the client against `AGENT_WANTS` in `web/src/lib/agent.ts`, which currently wants
**0.8.0** — the build that drains without stopping, thins the pointer path on request, and reports its
platform and its permissions. An older agent is reported to the user as needing an update, with the command to get the current
one — so a new implementation should report a version it can actually honour the whole of this table at.

## Coordinates

Everything — `/shot`, `/do`, `/replay` — works in **virtual-desktop coordinates**: one space covering all
monitors, which on Windows can start at a negative origin. `/shot` reports `scale` (and `originX`/`originY`)
so a point measured on the returned picture maps back onto the screen; `desktop-engine.ts` does that
conversion in exactly one place (`actionBody`) and a second implementation must not need a second one.

Two platform traps worth stating because Windows hit both:

- Input injection happens in **physical pixels**. A recording made at one display scale replays wrong at
  another unless the units are pinned.
- Coordinates outside the desktop are clamped by the OS rather than refused, so an out-of-bounds click lands
  somewhere real. Bounds-check before acting and report the refusal.

## `/do` — the action body

`Content-Type: text/plain`, one action per request, `key=value` separated by spaces:

```
action=click x=1074 y=159 button=left double=0
action=move x=400 y=300
action=scroll x=400 y=300 amount=-3
action=type text=hello there
action=type enc=b64 nl=shift text=<base64 UTF-8>
action=key key=Enter ctrl=0 shift=0 alt=0
action=activate title=Outlook
action=activate process=outlook
```

Parsing rules that matter, both of them learned the hard way:

- `text=` and `title=` take **the rest of the line**, unsplit — they contain spaces.
- A field marker only counts at the **start of a token**, or `subtitle=` matches `title=` and the parse
  begins four characters into the wrong word.
- `enc=b64` carries UTF-8 base64 so multi-line text survives. `nl=enter` presses Enter between lines,
  `nl=shift` presses Shift+Enter — which is the difference between sending an email and typing a paragraph
  into one. Give the application a moment after a line break; typing straight through loses characters.

**Report failed injection.** The Windows agent originally ignored the return value of `SendInput`, so input
that never arrived was reported as success and the model built its next decision on a lie. Whatever your
platform's equivalent is, check it, and say what went wrong: on Windows, error 5 means an elevated window
owns the foreground and error 0 means the screen is locked.

## `/windows` — why it exists

A screenshot is not the whole truth: an application that is minimised or behind another window is invisible
to a picture, and something acting only on pictures will happily launch a second copy of a program that is
already running. That is not hypothetical — it is what happened. `/windows` says what is open and
`action=activate` gets to it without opening anything.

Enumerate real top-level windows only, and expect the fiddly cases to matter. On Windows those were:
DWM-cloaked Store windows, owned dialogs, helper windows too small to be real, and the desktop shell itself.
macOS will have its own list; `title` and `process` are what the model reasons about, so they must be the
names a person would recognise.

## `/shot` and `/pulse`

`/shot` returns a base64 picture (`format: 'jpeg'`, quality ~85) sized to a megapixel budget rather than a
fixed width — a vision payload is priced in pixels. `?w=` is the client asking for less after an upstream
413.

`/pulse` exists so waiting is cheap: a 64×36 greyscale grid, about 3KB, that the client polls to notice the
screen has stopped changing. Without it every "is it done yet?" costs a full screenshot and a model call.
A client that finds no `/pulse` falls back to fingerprinting screenshots, so it is optional but strongly
wanted.

## `/record/*` and `/replay`

`/record/stop` returns Mini Mouse Macro layout, one event per line, `#` for comments:

```
index | X | Y | delayMs | action
1 | 1074 | 159 | 791 | Left Click Down
2 | 1074 | 159 | 63 | Left Click Release
```

`delayMs` is the wait **before** the event. Recording is bounded: the hooks may stay installed for the
agent's lifetime, but events are only stored between `/record/start` and `/record/stop`. Nothing is captured
unasked — that is a product decision, not an implementation detail.

Five action words come from the mouse (`Mouse Movement`, `Left/Right/Middle Click Down`, the matching
`Release`, `Scroll Up`/`Scroll Down`) and two do not:

```
#ctx	app=OUTLOOK	window=Inbox — Outlook
1 | 0 | 0 | 0 | Focus
#ctx	app=OUTLOOK	window=Untitled - Message	control=Subject	type=edit box
2 | 0 | 0 | 900 | Key Down
3 | 0 | 0 | 120 | Key Down
```

`Focus` — **the foreground window changed.** Not an action; a marker saying the work moved, so a step that
hit-tests nothing can still be placed. It is the only per-step answer for a scroll, a wait or a run of
typing, and without it those sit in whichever segment a click last opened. The Windows agent polls
`GetForegroundWindow` on the resolver thread, which is already awake between clicks, rather than adding a
second hook and a second message pump. Two rules: never emit one **between a press and its release** — the
transcript pairs a click by looking at the very next event, so a marker there becomes an unreleased press
plus a stray release — and emit one at `/record/start`, so a recording says where it began.

`Key Down` — **a key was pressed, and when. Never which key.** This is the whole design and it is not
negotiable: "five of those ten minutes went on typing in Outlook" needs the timing and nothing else, and a
hook that reads key codes has captured a password whether or not it stores one. The Windows agent marshals
`KBDLLHOOKSTRUCT` to read a single flag — whether the key was injected, so a replay pressing keys is not
recorded as a person typing — and never touches `vkCode` or `scanCode`. Auto-repeat arrives as ordinary
key-downs and is kept: holding a key is time spent typing, and filtering it would need the identity this
deliberately does not have. The `#ctx` above a keystroke answers a different question from the one above a
click: what has **focus** (`AutomationElement.FocusedElement`, or `AXFocusedUIElement` on macOS), not what is
under the pointer, which is wherever it was last left. Resolve once per **run** of typing, not per keystroke.

Both are `#ctx`-bearing lines in a five-column format, so nothing that reads `.mmmacro` needs to know they
exist.

**A replay cannot perform either, and must say so.** A keystroke has no key in it and a `Focus` is a note.
The Windows agent names them explicitly in its action switch rather than dropping them through `default`,
counts them, and reports the count as `unplayable` on `/replay/status` — a replay that pressed nothing for
the two minutes somebody spent typing must not come back looking like a clean run. The pause before each
event is still waited out, so the replay keeps the shape of the original. Work that has to type belongs in a
created skill, which is told what to write.

### `#ctx` — where a click landed

A click may be preceded by a comment line naming what was under it:

```
#ctx	app=chrome	window=Inbox — Outlook	control=Send	type=button
7 | 1074 | 159 | 240 | Left Click Down
```

Tab-separated `key=value`, on the line **above** its event, and it attaches to exactly one event. Keys:
`app` (process or application name), `window` (title), `control` (the accessible name of the thing under the
pointer), `type` (its control type). Unknown keys are ignored rather than being an error, so an agent may add
one; a value that is empty is the same as absent.

This is what turns *"clicked at 1074,159"* into *"clicked **Send** in Outlook"*, and it is the only per-event
answer to "which application was this in" — `payload.windows` is sampled once a second at the recording
level, so it says which applications appeared, never which one a given click hit.

Rules, all of them learned the hard way:

- **Clicks only, and only the button-down.** A move has no target worth naming and there are hundreds of
  them; the release is the same target a moment later.
- **Absent means NOT KNOWN, never "nothing there".** A transcript has to keep that difference, so never emit
  a `#ctx` line with invented or placeholder values.
- **Never resolve on the input path.** On Windows a low-level hook that overruns `LowLevelHooksTimeout`
  (300ms by default) is removed without telling anybody, and the first accessibility call on a thread costs
  ~120ms. The hook queues the coordinates; a worker resolves them. If the worker falls behind, drop the
  *context*, never the event.
- **Never walk the tree.** Hit-test the point and climb for a name — measured on Windows, a full control-view
  walk is 0.6–4.4 seconds per window and caching makes it worse.
- A comment line, because the event line has five columns and every reader of this format would choke on a
  sixth. `#` lines were already skipped, so an older reader loads the recording exactly as before.

**On macOS the mechanism differs and the line does not.** The Windows agent uses UI Automation
(`AutomationElement.FromPoint`, then a climb of up to five levels for a name). The macOS equivalent is the
Accessibility API: `AXUIElementCopyElementAtPosition` for the hit test, `kAXTitleAttribute` /
`kAXRoleDescriptionAttribute` for the name and type, `kAXParentAttribute` for the same climb, and
`NSWorkspace.frontmostApplication` for the application — which is better than Windows manages, since it gives
*Microsoft Outlook* rather than a process called `outlook`. Two differences worth planning for:

- It needs the **Accessibility** TCC permission, granted per-binary by the user in System Settings. Without
  it every call returns nothing, so the agent must detect that and say which permission is missing rather
  than emitting recordings with no context and no explanation.
- The event tap has its own timeout, so the queue-and-worker rule above applies for the same reason.

Blind spots are similar on both: Electron applications expose almost nothing (on Windows, ChatGPT desktop
offers 34 characters of control names in the entire app), and an elevated window is invisible to a
medium-integrity Windows process. Say so in the transcript; do not paper over it.

**Typed text is deliberately not recorded — the keystroke is.** See `Key Down` above. The distinction is
the design: a recording that silently drops half a message is worse than one that never claimed to carry it,
and a hook that reads key codes has captured a password whether or not it stores one. A new agent may record
that a key was pressed and when. It must not record which, and it must not need a redaction design in order
to be safe, because there is nothing to redact.

The replay body is text as well:

```
startDelay=3000
flowRepeat=forever
STEP repeat=2 speed=1.0 delayAfter=500
1 | 1074 | 159 | 791 | Left Click Down
2 | 1074 | 159 | 63 | Left Click Release
```

`repeat` and `flowRepeat` take a count or the word `forever` (`0` means the same).

**Abort must be immediate and must release what it holds.** Check the stop flag before every event *and*
inside every sleep, and release every held button and key on every exit path, including the failure paths —
a replay that dies holding the left mouse button leaves the machine unusable. The Windows agent also honours
a held ESC as a hardware-level escape hatch, which is worth copying.

## Authentication — being replaced, do not invent your own

Today: **none**. Any process on the machine can POST `/do` and inject input, or GET `/shot` and capture every
monitor. `-AllowOrigin` defaults to `*` and is only echoed as a response header, never used to reject.

A design is being chosen now. Until it lands, a new agent should implement the table above **without** auth
and leave a single seam for it — one function every route calls before doing anything. Do not design a scheme
in parallel; two agents with two schemes is worse than one agent with none.

## macOS — what the second implementation chose

`agent/mouseflow-agent.swift`, installed by `agent/install-mac.sh`. The notes below were written before it
existed and each one turned into a decision; the decision is recorded next to the note so the next reader
does not re-open a settled question.

**Packaging: compiled on the machine, not downloaded.** There is no Apple Developer certificate in this
project, so a prebuilt binary arrives quarantined and Gatekeeper refuses it — the user would have to strip
the quarantine attribute by hand, which is worse advice and worse security than the alternative. A binary
compiled locally is never quarantined. The cost is Xcode Command Line Tools, which the installer names in
one command if they are missing; the gain is no certificate, no notarisation, no Gatekeeper dialog. If a
Developer ID ever exists, a signed and notarised `.app` is a better answer and the permission grants survive
updates — which they do not here, see below.

**It has to be an .app, and that is not packaging taste.** On macOS a bare executable is not its own subject
as far as permissions go: TCC blames the RESPONSIBLE process, which for anything launched from a terminal is
the terminal. So a loose binary gets no Accessibility prompt of its own, never appears in the System Settings
list, and the only way to give it anything is to grant Accessibility to the terminal emulator - a far larger
permission, and one nobody finds. A binary inside a bundle, launched with `open`, is its own responsible
process: it gets a prompt naming itself and a switch of its own. The installer therefore builds a minimal
bundle (a plist, `LSUIElement`, ad-hoc signed over the whole thing) and starts it detached. There is no window
to close; `pkill -f mouseflow-agent` stops it. This was found the way everything in this file was found: it
compiled, it ran, and it could not be granted anything.

**Permissions are the install story, and there are two.** Accessibility for the event tap, for reading any
other application's tree, and for posting input; Screen Recording for `/shot`, `/pulse`, and for other
applications' window TITLES in `/windows`. Both are reported on `/health` under `permissions`, so the
Connections screen ticks them individually and live. A rebuild invalidates the grant — TCC keys on the exact
binary — so the installer says the user may be asked again.

**`ctrl=` in the action body means COMMAND on macOS.** A deliberate translation, not an oversight: the
grammar was written on Windows where Ctrl+C is copy, and on macOS the same intention is Cmd+C. Posting a
literal Control+C would send an interrupt to a terminal instead. `cmd=` and `meta=` are accepted as
themselves, and `raw-ctrl=` asks for the literal Control key.

**Screenshots go through ScreenCaptureKit, and that costs one monitor.**
`CGWindowListCreateImage` is not deprecated on macOS 15, it is *unavailable* - "Please use ScreenCaptureKit
instead" - and it cannot even be kept behind an `#available`, because referencing it fails to compile against
that SDK. So `/shot` and `/pulse` need macOS 14 or newer, and everything else works below it. ScreenCaptureKit
captures ONE DISPLAY, so a multi-monitor desk is a real limitation: the agent captures the display the cursor
is on and reports THAT display's bounds as `originX`/`originY`, so a point measured on the picture still maps
back onto the right screen - but the other monitor is invisible to it. Bounds checking still uses the union of
all displays, because a click on the second monitor is a legitimate click even when the agent cannot see it.

**Coordinates are points, and a screenshot is pixels.** CGEvent works in global display points; a capture
comes back in backing pixels, twice that on a Retina display. Same trap as Windows from the other direction,
same answer: `/shot` reports `scale` as picture-pixels-per-point and the client converts in one place.

**A drag is its own event type.** macOS sends `leftMouseDragged`, not `mouseMoved` with a button down.
Subscribing only to moves gives a press, no motion and a release — a drag that replays as a click.

**A bare modifier is not a keystroke here.** `keyDown` excludes modifiers on macOS (they arrive as
`flagsChanged`), so holding Shift alone is not counted as typing, where on Windows it is. Both are
defensible and the transcript reads only density and duration.

**The tap is listen-only.** Not an optimisation: a tap that can alter events is a tap that can drop them,
and a recorder must not change what the person is doing while it watches.

**Windows and titles.** `title` and `process` come from `CGWindowListCopyWindowInfo`, with the owning
application's name as the fallback title when Screen Recording is not granted — a real answer rather than a
blank row that reads as "nothing is open". macOS cannot distinguish "minimised" from "on another Space"
through that list, and to the caller they mean the same thing: it is open, it is not visible, and
`action=activate` is what gets to it.

### The original notes, for context

Not requirements — the things that dominated the work, so they were not discovered late:

- **Permissions are the install story.** Posting synthetic events needs Accessibility; capturing the screen
  needs Screen Recording; reading other applications' window titles needs Screen Recording too. All are
  granted by the user in System Settings, per-binary, and cannot be granted programmatically. Whatever the
  agent is, it must detect that it lacks each one and say which, because the failure otherwise looks like
  the agent working and the screen being empty.
- **There is no equivalent of the PowerShell one-liner.** The Windows agent is fetched and run in memory with
  nothing installed. On macOS the honest options are a signed and notarised `.app` (which the permission
  grants can attach to) or a script the user must then grant permissions to, which is a rougher first run.
  This is a product decision, not a packaging detail.
- **`process` and `title`** should come from the same place a person reads them, and beware that the browser
  the user thinks of as "Outlook" may be a PWA hosted by Chrome — the Windows agent hit exactly that, and
  the window list is what made it solvable.
- Keep the port and the whole table identical. The client is shared, and the only per-platform difference
  should be the command shown on the Connections screen.
