# 12 — The macOS agent

`agent/mouseflow-agent.swift`, one file, ~2,390 lines, compiled on the machine by
`agent/install-mac.sh`. Version **0.8.2**. Debugging notes:
[`docs/DEBUG-MAC.md`](../DEBUG-MAC.md).

It implements the same protocol as the Windows agent, on the same port, with the same table. The only
per-platform difference the client is allowed to see is which install command the Connections screen shows.

## The installer

```bash
curl -fsSL https://<origin>/agent/install-mac.sh | bash -s -- --origin https://<origin>
```

What it does, in order: fetch the source, compile it (`swiftc -O`), wrap it in a minimal `.app`, sign it,
register a LaunchAgent, start it, and then **ask `/health` whether it actually answered** rather than
reporting "started".

| Flag | Meaning |
|---|---|
| `--origin URL` | The page the agent will answer (default `https://mouseflowapp.vercel.app`) |
| `--port N` | Loopback port (default 8787) |
| `--no-login` | Do not register it as a login item |
| `--no-run` | Install and stop; do not start it now |
| `--foreground` | Run it in this window so its output is visible. **Note what that costs**: launched as a child of Terminal it inherits *Terminal's* permissions rather than having its own — use it to see compiler and runtime output, never to test permissions. |
| `--fix-permissions` | Reset the TCC entries and restart it, for when System Settings shows it switched on and the agent still says it has no access |
| `--doctor` | Print everything about the install in one paste |
| `--uninstall` | Stop it, remove the login item and the installed files |
| `--help`, `-h` | The above |

The agent binary itself takes `--port`, `--allow-origin`, `--move-throttle-ms`, `--move-min-px`, `--help`,
and `--probe` (see the permission watcher below).

### `--doctor`

Written because "it does not work" is not a diagnosis, and because the failures on this platform are
**indistinguishable from outside**: a missing permission, a permission granted to a *previous build*, a login
item that never registered, and a process that is not the kind that can hold a permission at all **all look
like an agent that says no**.

One paste contains: the macOS version and architecture, whether `swiftc` is there, where the bundle is and
**what signature it carries** (identifier, signature kind, authority, cdhash), the bundle id (or the news
that there is no `Info.plist`, meaning this is a loose binary that cannot hold a permission), the last build
log if it had output, the plist and its `KeepAlive` and arguments, what launchd says (state and pid), any
matching processes, whether anything is listening on the port, the whole of `/health` including both
permissions, and the tail of the agent's own log.

Run it **before reasoning about anything**.

## Packaging, and why it is like this

### Compiled on the machine, not downloaded

A prebuilt binary arrives **quarantined** and Gatekeeper refuses an unnotarised one — the user would have to
strip the quarantine attribute by hand, which is worse advice and worse security. A locally compiled binary
is never quarantined. The cost is Xcode Command Line Tools, which the installer names in one command
(`xcode-select --install`) if they are missing.

### It has to be an `.app`, and that is not packaging taste

On macOS a bare executable **is not its own subject** as far as permissions go: TCC blames the *responsible*
process, which for anything launched from a terminal is the terminal. So a loose binary gets no Accessibility
prompt of its own, never appears in the System Settings list, and the only way to give it anything is to
grant Accessibility to the terminal emulator — a far larger permission, and one nobody finds.

A binary inside a bundle, launched with `open`, is its own responsible process: it gets a prompt naming
itself and a switch of its own. So the installer builds a minimal bundle — an `Info.plist`, `LSUIElement`,
signed over the whole thing — and starts it detached.

This was found the way everything on this platform was found: it compiled, it ran, and it could not be
granted anything.

### Code signing, and the thing it fixes

The installer signs with a **Developer ID Application** identity when the machine's keychain holds one, and
ad-hoc otherwise. Not cosmetics: **TCC keys a grant to the signature**, and an ad-hoc signature means the
binary's cdhash — so every rebuild used to cost a round of re-granting both permissions.

**Measured on 2026-08-21:** rebuilt under the same Developer ID identity, the cdhash changed
(`7883b789` → `1a6ddcaa`, a genuinely different binary) and **both permissions stayed granted**. That is the
whole reason the certificate is worth having, and it is now a fact rather than a plan.

A marker file remembers what the last build was signed as, so the TCC reset still happens exactly when the
subject actually changed: every ad-hoc build, and the one build that first switches to the certificate. The
hardened runtime (`--options runtime`) rides along so a future notarised build is the same signature shape.

**The keychain trap, for the record**, because it costs twenty minutes: a Developer ID certificate downloaded
from Apple is **inert** until the Developer ID G2 intermediate CA sits alongside it
(`https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer`). Until then
`security find-identity -v -p codesigning` reports "0 valid identities" with the certificate plainly
installed, which reads as a broken certificate and is not one.

The next milestone is a signed **and notarised** prebuilt `.app` — no compiler on the user's machine at all.
That is a distribution project, not an installer flag.

## Permissions

Two, and neither can be granted by any code:

| Permission | Needed for | Reported as |
|---|---|---|
| **Accessibility** | The event tap, reading any other application's tree, and posting input | `canName`, `canKeys`, `permissions.accessibility` |
| **Screen Recording** | `/shot`, `/pulse`, and other applications' window **titles** in `/windows` | `canSee`, `permissions.screenRecording` |

Both are on `/health` so the Connections screen can tick them individually and live. Without that, the
failure is a working agent, a black screenshot and no explanation.

The agent **asks at the moment the permission is needed** — `/record/start` asks for Accessibility,
`/shot` asks for Screen Recording — not only at startup. Asking only at startup is not enough, and a login
item makes it worse rather than better: launchd starts the agent when somebody logs in, minutes or hours
before they open the app and press Record, so the dialog is shown to an empty chair and nothing ever asks
again. `/record/start` then retries installing the tap, which is what removes the restart step entirely.

### "Granted, and it still says no" — two causes that look identical

**1. The grant landed while the agent was running.** The verdict is read **once, at process start** —
measured: Screen Recording's never refreshed in a running process (ten minutes, twice), Accessibility's
sometimes did, and a tap that failed to install while untrusted stayed uninstalled either way. macOS knows
this: System Settings offers windowed apps a "Quit & Reopen" dialog for exactly this reason, and an agent
with no window gets nothing.

So since 0.8.1 **the agent watches for the grant and restarts itself**:

- While a permission is missing, it asks a **fresh child of its own binary** (`--probe`, one line of JSON
  from a process young enough to know) every few seconds.
- The TCC store's mtime is the backstop signal.
- When the answer changes it **exits cleanly**, so launchd's `KeepAlive` starts it again — granted, tap
  installed, `/health` green, nobody pressing anything. **Measured end to end: switch flipped to green
  `/health` in under fifteen seconds.**
- Never mid-recording, mid-replay or under an in-flight response; at most once a minute; and only when the
  process actually **is** the launchd job. A `--foreground` run prints an instruction instead of silently
  dying.
- The client needed nothing for this: it was already polling `/health`.

By hand: `launchctl kickstart -k gui/$(id -u)/com.mouseflow.agent`.

**2. The grant belongs to a previous build.** Ad-hoc signature ⇒ cdhash ⇒ a rebuild is a different app to
TCC. The entry stays in System Settings, still switched on, and the new binary is not the one it was granted
to. **And the folk remedy does not work**: toggling the switch off and on was tried on a real machine and the
verdict stayed false — the entry keeps the requirement recorded when the app was first added, so only a reset
rebinds it.

```bash
bash <(curl -fsSL https://<origin>/agent/install-mac.sh) --fix-permissions
# or, by hand:
tccutil reset Accessibility com.mouseflow.agent
tccutil reset ScreenCapture com.mouseflow.agent
```

The installer does this automatically after any **real** rebuild. With a Developer ID installed, cause 2
stops happening.

## The menu bar item

The one thing users could not do was **stop the agent**: no window, `pkill` resurrected by `KeepAlive`, and
the terminal that installed it never owned it — so the only way out was a `launchctl` command nobody knows.
`LSUIElement` is exactly the mode for a status item, and the HTTP loop moved to its own thread to give AppKit
the main one. Nothing else changed shape.

| Item | When |
|---|---|
| `MouseFlow Agent 0.8.2` | always (header) |
| `Records only between Start and Stop` | always |
| **Start Recording** | idle |
| **Stop and Save Recording** | while recording |
| *a line saying a recording is waiting* | while a hold exists |
| **Stop Until Next Login** | always — launchd forgets the job for this session; signing in brings it back |
| **Quit and Turn Off Start at Login** | always — the login item is removed too |

The icon doubles as the recording light. Stopping from here **holds** the events; see
[10 — Agent protocol § A recording may end at the AGENT](10-agent-protocol.md#a-recording-may-end-at-the-agent).
The spill lives at `~/Library/Application Support/MouseFlow/held-recording.mmmacro`.

Starting from here is the mirror: the same start the HTTP route runs, the tap installed if it can be, held
recordings refused atomically, and the frontmost application primed.

### The double-launch handover

The same investigation produced this: the "Quit & Reopen" dialog relaunches the bundle with `open` and **no
arguments**, and that stray instance used to win the port while the real launchd job crash-looped behind it.
An argument-less double now starts the job and steps aside — once something actually answers the port — and
`/autostart/enable` on a hand-launched instance hands over too, instead of leaving the new job to die
against its own socket forever.

## Platform specifics

| | |
|---|---|
| Recording | `CGEvent.tapCreate`, **listen-only**. Not an optimisation: a tap that can alter events is a tap that can drop them, and a recorder must not change what the person is doing while it watches. |
| Replay | `CGEvent` posting, in global display **points** |
| Naming | `AXUIElementCopyElementAtPosition`, then `kAXTitleAttribute` / `kAXRoleDescriptionAttribute` / `kAXParentAttribute` for the climb, plus `AXTitleUIElement` and `AXHelp`. `NSWorkspace.frontmostApplication` gives *Microsoft Outlook* rather than a process called `outlook`, which is better than Windows manages. |
| Keystroke target | `AXFocusedUIElement` |
| Screenshots | **ScreenCaptureKit** (`SCShareableContent` + `SCContentFilter` + `SCScreenshotManager`) |
| Windows | `CGWindowListCopyWindowInfo` |

### Four traps worth knowing

- **`CGWindowListCreateImage` is not deprecated on macOS 15, it is *unavailable*** — and it cannot even be
  kept behind an `#available`, because referencing it fails to compile against that SDK. So `/shot` and
  `/pulse` need macOS 14 or newer; everything else works below it.
- **ScreenCaptureKit captures ONE display.** A multi-monitor desk is a real limitation: the agent captures
  the display the cursor is on and reports **that** display's bounds as `originX`/`originY`, so a point
  measured on the picture still maps back onto the right screen — but the other monitor is invisible to it.
  Bounds checking still uses the union of all displays, because a click on the second monitor is a legitimate
  click even when the agent cannot see it.
- **A drag is its own event type.** macOS sends `leftMouseDragged`, not `mouseMoved` with a button down.
  Subscribing only to moves gives a press, no motion and a release — a drag that replays as a click.
- **A bare modifier is not a keystroke here.** `keyDown` excludes modifiers on macOS (they arrive as
  `flagsChanged`), so holding Shift alone is not counted as typing, where on Windows it is. Both are
  defensible, and the transcript reads only density and duration.

`minimized` is reported for anything not visible: macOS cannot distinguish "minimised" from "on another
Space" through the window list, and to the caller they mean the same thing — it is open, it is not visible,
and `action=activate` is what gets to it. When Screen Recording is not granted, the owning application's name
is used as the fallback title, which is a real answer rather than a blank row that reads as "nothing is open".

Chromium is asked for its tree when **Record is pressed** rather than after the first click came up empty,
via `AXManualAccessibility` alone unless unsupported — `AXEnhancedUserInterface` is VoiceOver's flag and
AppKit resizes windows strangely under it.

### Measured naming rate

**81.8% of clicks named overall, 77.8% in Chrome** (22 clicks, 2026-08-21) — above the Windows overall
baseline of 70.8%, below its Chrome figure of 146/151.

Every remaining nameless click is **Chrome's tab strip**: the hit test returns an unnamed group covering the
whole strip, climbing up finds nothing, and the bounded child descent was measured against it too (8 tab
clicks, 0 named), so that group exposes no frame-matching children either. The tabs must live in a different
branch — likely an `AXTabGroup` under the window — and finding it needs an AX-tree inspection of a real
Chrome rather than another guess, because every rebuild used to cost the user a permission round.

## Verified, and not

**Verified on a real Mac (macOS 26.5, arm64):** it compiles and runs; recording with `#ctx` names; `/shot`
with the correct MIME type and scale; `/pulse`; `/windows`; both permissions detected and reported; the
permission self-recovery end to end; the menu bar including the held-recording handover; and that a Developer
ID rebuild keeps the grants.

**Not verified:** replay, and aiming by name, on macOS.

## Log, and the reason it was empty once

```bash
tail -f ~/Library/Logs/mouseflow-agent.log
```

Swift's `print` **block-buffers** when its output is not a terminal, and this process never exits — so under
launchd the startup banner sat in a buffer that was never flushed. The banner is the one thing worth reading
when nothing works: it says whether the event tap installed and whether this process is even the kind that
can be granted anything. An empty log read as "it printed nothing", which was wrong. `setvbuf(stdout, nil,
_IOLBF, 0)` fixed it.
