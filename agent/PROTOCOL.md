# The local agent protocol

What any MouseFlow desktop agent must implement, whatever it is written in. Extracted from the two things
that already agree on it: `agent/mouseflow-agent.ps1` (the Windows implementation) and
`web/src/lib/agent.ts` (the only client).

This file exists because there is now going to be a second implementation. Until there was, the contract
lived in a PowerShell comment block and in a TypeScript file, and neither knew it was a contract.

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
| GET | `/health` | 4s | `{ok, version, screen:{w,h}, recording, playing}` |
| GET | `/shot` | 12s | `{ok, png, format, bytes, w, h, scale, originX, originY}` |
| GET | `/shot?w=640` | 12s | the same, smaller — asked for after a 413 upstream |
| GET | `/pulse` | 5s | `{ok, grid}` — 64×36 greyscale samples as a short string |
| GET | `/windows` | 5s | `{ok, windows:[{title, process, active, minimized, x, y, w, h}]}` |
| POST | `/do` | 20s | `{ok}` — one action, body is `key=value` text (below) |
| POST | `/record/start` | 5s | `{ok}` |
| GET | `/record/status` | 2.5s | `{recording, count, elapsedMs}` |
| POST | `/record/stop` | 15s | **text/plain**, one event per line (`.mmmacro`) |
| POST | `/replay` | 5s | `{ok}` — starts a replay, returns immediately |
| GET | `/replay/status` | 2.5s | `{playing, step, steps, pass, passes, index, total}` |
| POST | `/replay/abort` | 4s | `{ok}` |
| POST | `/autostart/enable` | 8s | `{ok}` — needs the agent to exist as a file on disk |
| POST | `/autostart/disable` | — | `{ok}` |

`version` is checked by the client against `AGENT_WANTS` in `web/src/lib/agent.ts`, which currently wants
**0.5.0**. An older agent is reported to the user as needing an update, with the command to get the current
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

`delayMs` is the wait **before** the event. Recording is bounded: the hook may stay installed for the
agent's lifetime, but events are only stored between `/record/start` and `/record/stop`. Nothing is captured
unasked — that is a product decision, not an implementation detail.

**Typing is deliberately not recorded.** The Windows agent installs a mouse hook only. A recording that
silently drops text is worse than one that never claimed to carry it, and capturing keystrokes without a
redaction design captures passwords. Do not add a keyboard hook to a new agent without that decision being
made first.

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

## macOS notes for whoever picks this up

Not requirements — the things that will dominate the work, so they are not discovered late:

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
