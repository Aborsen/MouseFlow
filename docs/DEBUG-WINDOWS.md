# Debugging the Windows agent

Written on a Mac, for the machine that has Windows. The macOS half of this project was written on Windows
and had never run there; `docs/DEBUG-MAC.md` is what made the first session on a real Mac productive
instead of archaeological. This is the same document pointing the other way.

## Start here: get the facts

```powershell
irm https://mouseflowapp.vercel.app/agent/mouseflow-agent.ps1 | iex
```

That is the ordinary install - it fetches and runs in memory, nothing is written to disk. The banner it
prints is the first diagnosis: version, port, origin, whether the tray came up, and whether a recording is
being held from a previous run.

```powershell
# what it is and what it may do
curl.exe -s http://127.0.0.1:8787/health

# is anything listening
Get-NetTCPConnection -LocalPort 8787 -State Listen
```

## Where the work stands

**Verified, on real machines:** everything the Windows agent did before 0.8.2 - recording, replay, `#ctx`
naming (70.8% of clicks named, 146/151 in Chrome), `/shot`, `/windows`, the contract suite. And on macOS
(2026-08-21): the whole protocol including the tray-equivalent menu bar, the held-recording handover, and
the permission self-recovery.

**Verified on a real Windows machine, 2026-08-21:** the **tray icon added in 0.8.2** and the held-recording
mechanism behind it. It was written on a Mac with no Windows machine to run it on, and worked on the first
run there - after one compile error found by reading rather than by running (`_icon.ContextMenuStrip`,
mangled by a blanket type-qualification pass; `Add-Type` would have refused the entire block and the agent
would not have started at all). What was NOT separately measured on that run: the naming rate (see below),
and every failure path - a broken tray, a held recording surviving a restart, the 409 over a hold.

**If the C# block ever stops compiling,** `Add-Type` reports its errors with line numbers relative to the
`-TypeDefinition` string, which starts at the `Add-Type` line in the `.ps1`. Suspects, in the order they
are likely:

- **Ambiguous type names.** `System.Windows.Forms` and `System.Drawing` are deliberately NOT in the
  `using` list, and every type inside `class Tray` is written out in full (`System.Windows.Forms.Timer`,
  `System.Drawing.Icon`). That is not style: this file already uses `System.Windows.Automation`, and a
  global `using System.Windows.Forms` makes `Timer`, `Point`, `Color` and `Application` ambiguous across
  2600 lines of C# that were written without them. If you add a type to the tray, qualify it.
- **The referenced assemblies.** `System.Windows.Forms` was added to `-ReferencedAssemblies`; on PowerShell
  7 (which is .NET, not .NET Framework) that assembly resolves differently. If it fails there, try Windows
  PowerShell 5.1 first to separate "the tray is wrong" from "the runtime is different".
- **`Icon.FromHandle` leaks a GDI handle** by design here (two icons, once, for the life of the process).
  That is deliberate, not an oversight - `DestroyIcon` on a handle a `NotifyIcon` is still showing is worse.

## The tray, and why it is built the way it is

The console window used to be the whole interface: it showed the banner and closing it stopped the agent.
That is a stop button which cannot say whether a recording is running, cannot start one, and has to stay
open. macOS had the opposite problem - a login item with no window and no way to stop it at all - and grew
a menu bar item; this is the same answer for the same reason.

**It runs on its own STA thread with its own `Application.Run`, and that is load-bearing.** `NotifyIcon`
and `ContextMenuStrip` need an STA thread with a message pump. There IS already a pump in this agent -
`Hook.PumpThread` - and the tray must never use it: a low-level hook whose thread stalls past
`LowLevelHooksTimeout` (300ms) is silently removed by Windows, and drawing a menu is exactly the kind of
stall that does it. `ServeForever` owns the main thread. So the tray gets a third thread of its own, and
both menu actions hand their work to yet another thread, because `EndFromTray` waits up to 1.5s for the
resolver to finish naming the clicks that just opened the menu.

**What to check, and what the first real run on Windows already confirmed (2026-08-21) - items 1-5 passed:**

1. The icon appears in the notification area (it may be hidden behind the chevron - Windows hides new tray
   icons by default; drag it out, or check Settings > Taskbar > System tray icons).
2. The icon changes while recording - a ring when idle, a filled dot when recording, updated once a second.
3. Right-click shows: Start Recording (only when idle, nothing held, and the hook is installed), Stop and
   Save Recording (only while recording), the held note (only when a recording waits), Quit.
4. Clicking Start actually records: `curl.exe -s http://127.0.0.1:8787/record/status` should show
   `recording:true` and a rising count.
5. Clicking Stop and Save shows a balloon, and then `/record/status` says `recording:false` with `count>0`.
   **That state is the whole contract** - see `agent/PROTOCOL.md`, "A recording may end at the AGENT". The
   web app's Record page collects it within a quarter second if open, or within three seconds of being
   opened, with no client change: the same code already collects macOS-held recordings.
6. The spill file: `%LOCALAPPDATA%\MouseFlow\held-recording.mmmacro` exists while a recording is held, and
   is gone after the app collects it. Kill the agent while a recording is held, restart it, and the banner
   should say a recording is waiting - that file is why no restart can lose it.

## The three things most likely to be wrong

Not predictions - the places a Mac-written Windows feature has no way to be right by accident. None of
these were hit on the first run, which means they are untested rather than disproved:

1. **The tray never appears and the agent runs fine.** The banner says so: `tray NOT shown: <message>` is
   printed from `[MouseFlow.Tray]::LastError`, which is set by the catch around the whole pump. The agent
   deliberately survives a broken tray - the HTTP half is the product.
2. **The menu appears but a click does nothing.** The click handlers hand off to a background thread; if
   `Agent.RecordStart(0)` is refused (a hold waiting) it returns a string that the tray currently discards,
   because the item is hidden in that state. If the item is somehow visible and does nothing, that is why.
3. **The held recording is never collected.** Check `/record/status` first: `recording:false` with
   `count>0` is what the client watches for. If the count is 0, `EndFromTray` found an empty buffer and
   deliberately held nothing (the log line says so). If the count is right and the app still does not
   collect, the bug is on the client and `web/src/features/record/RecordView.tsx` (`collectHeld`) is where
   it lives - but that code is shared with macOS, where it is verified, so suspect this side first.

## Exercising it by hand

Everything is plain HTTP on loopback, and PowerShell's `Invoke-WebRequest` sends an `Origin` header that
the agent echoes rather than checks.

```powershell
# start, click a few things, then stop
curl.exe -s -X POST "http://127.0.0.1:8787/record/start"
curl.exe -s -X POST "http://127.0.0.1:8787/record/stop"

# the tray's stop, by hand: there is no endpoint for it - that is the point.
# Use the menu, then watch what /record/status says.
curl.exe -s http://127.0.0.1:8787/record/status

# what is open
curl.exe -s http://127.0.0.1:8787/windows

# refuse to start over a held recording (should answer 409 with a sentence, not a code)
curl.exe -s -X POST "http://127.0.0.1:8787/record/start"
```

## Are the names still coming through?

The Windows agent is the BASELINE the macOS one is measured against, so a regression here is worth more
than an improvement there. Record a few clicks in Chrome, stop, and count:

```powershell
$m = curl.exe -s -X POST http://127.0.0.1:8787/record/stop
($m -split "`n" | Select-String '#ctx').Count
```

Measured baseline: **70.8% of all recorded clicks carry a control name, and in Chrome 146 of 151.** macOS
reaches 81.8% overall since 0.8.2 but loses Chrome's tab strip entirely - if Windows ever drops near that,
something in the resolver has regressed rather than improved.

## Tests that run anywhere

```powershell
node agent/test-contract.mjs     # both agents against the one contract in PROTOCOL.md
cd web; npx tsc --noEmit         # the shared client
```

The contract test parses the route table out of `PROTOCOL.md` and asserts both implementations answer every
path, that `/health` carries the same field names, that the event words match, and that neither reads a key
code. It cannot run PowerShell or compile C# - which is exactly why it checks the things that can be
checked without either.

## What is deliberately not there

- **A hidden console.** The tray exists, so hiding the console window is now possible - and it was left
  visible on purpose until the tray is verified on a real machine. Hide it before then and a tray that
  failed to appear leaves a running agent with no interface at all.
- **A login item.** The Windows agent is fetched and run in memory with nothing installed, which is the
  whole shape of its install story; macOS needed a login item because it needed a bundle to hold a
  permission. `/autostart/enable` exists for the case where the agent does live on disk.
- **Typed text.** Same as everywhere: a keystroke is recorded as an event with a timestamp and nothing
  else. Not a redaction design - there is nothing to redact, and that is the point.
