# 11 — The Windows agent

`agent/mouseflow-agent.ps1`, one file, ~2,440 lines of PowerShell wrapping a C# type definition. Version
**0.8.2**. Debugging notes: [`docs/DEBUG-WINDOWS.md`](../DEBUG-WINDOWS.md).

## How it runs

Fetched and executed **in memory** — nothing installed, nothing written to disk, nothing to unblock:

```powershell
& ([scriptblock]::Create((irm https://<origin>/agent/mouseflow-agent.ps1))) -AllowOrigin https://<origin>
```

`Add-Type -ReferencedAssemblies 'System.Drawing','System.Windows.Forms','UIAutomationClient',
'UIAutomationTypes','WindowsBase'` compiles the C# on first run. That compile is why there is no Windows
equivalent of a "download and run" binary and no need for one.

## Parameters

| Flag | Default | Meaning |
|---|---|---|
| `-Port` | `8787` | Loopback port to listen on |
| `-AllowOrigin` | `'*'` | Origin echoed in `Access-Control-Allow-Origin`. `'*'` echoes whatever asks, which lets **any** site you visit drive your mouse while the agent runs. Pin it to your deployment for anything past a local demo. |
| `-MoveThrottleMs` | `10` | Minimum gap between recorded move events |
| `-MoveMinPx` | `3` | Minimum cursor travel before a move is recorded |
| `-NoTray` | off | Run without the notification-area icon. For a headless run, or while debugging the tray itself; the HTTP half is identical either way. |

`?moveMs=` on `/record/start` overrides the throttle **for that recording only**.

The two throttles exist because the raw hook fires hundreds of events per second, and only moves far enough
apart in **both** time and space carry information.

## How it records and replays

| | |
|---|---|
| Recording | `SetWindowsHookEx(WH_MOUSE_LL)` plus a keyboard hook, on a dedicated message-pump thread |
| Replay | `SendInput` with absolute virtual-desktop coordinates |
| Naming a click | UI Automation: `AutomationElement.FromPoint`, then a climb of up to five levels for a name |
| Naming a keystroke's target | `AutomationElement.FocusedElement`, resolved once per **run** of typing |
| Screenshots | `System.Drawing`, JPEG at ~85 quality (`image/png` only if no JPEG encoder exists, which is close to impossible) |
| Windows | `EnumWindows`, filtered for real top-level windows |

**Resolution never happens on the input path.** A low-level hook that overruns `LowLevelHooksTimeout`
(300 ms by default) is silently removed by Windows, and the first accessibility call on a thread costs
~120 ms. The hook queues coordinates; a resolver thread names them. If the resolver falls behind it drops the
**context**, never the event.

The keyboard hook marshals `KBDLLHOOKSTRUCT` to read **one flag** — whether the event was injected, so a
replay pressing keys is not recorded as a person typing — and never touches `vkCode` or `scanCode`.

### Measured naming rate

**70.8% of all recorded clicks carry a control name; in Chrome, 146 of 151.** This is the **baseline** the
macOS agent is measured against, so a regression here is worth more than an improvement there.

## The tray icon (0.8.2)

Before this, the console window was the whole interface: it showed the banner, and closing it stopped the
agent. That is a stop button which cannot say whether a recording is running, cannot start one, and has to
stay open.

Right-click menu:

| Item | When it shows |
|---|---|
| `MouseFlow agent 0.8.2` | always (header, disabled) |
| `Records only between Start and Stop` | always (disabled) |
| **Start Recording** | idle, nothing held, and the hook is installed |
| **Stop and Save Recording** | while recording |
| *"Recording saved here — the app collects it (N events)"* | while a recording is held |
| **Quit MouseFlow Agent** | always |

The icon doubles as the recording light: a **ring** when idle, a **filled dot** while recording, updated once
a second. A balloon tip confirms a save.

**Stopping from the tray holds the events** rather than dropping them — the agent has no account and gets no
credentials. See [10 — Agent protocol § A recording may end at the AGENT](10-agent-protocol.md#a-recording-may-end-at-the-agent).
The hold spills to `%LOCALAPPDATA%\MouseFlow\held-recording.mmmacro` and is reloaded at startup, so no
restart can destroy what the menu promised to save, and `/record/start` refuses with 409 while one waits.

**The web client needed no change at all** for this: the same code already collects macOS-held recordings,
which is what a shared contract is for.

### Threading, and why it is that way

Its **own STA thread with its own `Application.Run`** — load-bearing, not tidy. `NotifyIcon` and
`ContextMenuStrip` need an STA thread with a message pump. There is already a pump in this agent, and the
tray must never use it: a hook thread that stalls past `LowLevelHooksTimeout` is silently removed by Windows,
and drawing a menu is exactly that kind of stall. `ServeForever` owns the main thread, so the tray gets a
third. Both menu actions hand off to **yet another** thread, because ending a recording waits up to 1.5 s for
the resolver to finish naming the clicks that just opened the menu.

`System.Windows.Forms` and `System.Drawing` are deliberately **absent from the `using` list**, and every tray
type is written out in full (`System.Windows.Forms.Timer`, `System.Drawing.Icon`). That is not style: the
file already uses `System.Windows.Automation`, and a global `using System.Windows.Forms` makes `Timer`,
`Point`, `Color` and `Application` ambiguous across 2,600 lines of C# written without them. **If you add a
type to the tray, qualify it.**

The agent deliberately **survives a broken tray** — the banner prints `tray NOT shown: <message>` and the
HTTP half is the product. The console window is still visible on purpose: hide it before the tray is
verified on a machine and a tray that failed to appear leaves a running agent with no interface at all.

## Autostart

`POST /autostart/enable` writes `MouseFlowAgent.cmd` into the Startup folder. No admin rights; deleting the
file undoes it.

Two restrictions, because a web page asking a local service to create a persistent launcher is exactly the
shape of an attack:

- **The command is built only from the agent's own launch arguments.** Nothing from the HTTP request reaches
  the file, so a hostile page cannot turn this into "run *my* script at logon".
- **Refused unless `-AllowOrigin` is pinned**, and refused when the agent was started by pipe — there is
  then no local file for the launcher to point at (`$PSCommandPath` is empty). `canAutostart` on `/health`
  reports which case this is, and the Connections screen offers the download instead.

## Platform limits

- **Absolute coordinates.** A recording is pixel positions on the screen it was made on. Move the target
  window, resize it, change resolution or plug in a second monitor and the replay clicks whatever now sits at
  those pixels. Inherent to coordinate recording, not a bug in the replayer.
- **Display scaling.** `SendInput` works in physical pixels; a recording made under a different DPI scale is
  off by the scale ratio.
- **Integrity levels cut both ways.** A normal (medium-integrity) agent cannot inject into an elevated window
  **and cannot see input while an elevated window is in the foreground** — UIPI applies to the hook as well
  as to `SendInput`. So a recording made over an admin app is **silently incomplete**, not merely
  unreplayable: the events never arrive, so nothing downstream can detect the hole (the transcript says so
  rather than reading as though nothing was missing). Run the agent elevated if any target app is; the UAC
  secure desktop is unreachable either way. This is the failure mode that demos fine for weeks and then dies
  live on one elevated app.
- **Electron applications expose almost nothing** to UI Automation — measured: ChatGPT desktop offers 34
  characters of control names in the entire app.
- **Antivirus and EDR are untested.** A process that installs a global mouse hook and calls `SendInput` looks
  exactly like a RAT. Nothing here has been run against Defender, CrowdStrike or SentinelOne. Test that
  before putting it in front of a corporate machine.

## Verified, and not

**Verified on real Windows machines:** everything before 0.8.2 — recording, replay, `#ctx` naming, `/shot`,
`/windows`, the contract suite — and, on 2026-08-21, the **tray icon and the held-recording mechanism**. That
tray was written on a Mac with no Windows machine to run it on and worked on the first run there, after one
compile error found by reading rather than by running.

**Not separately measured on that run:** the naming rate, and every failure path — a tray that fails to
appear, a held recording surviving a restart of the agent, the 409 that refuses to record over one. They are
**untested rather than disproved**.

## Deliberately not there

- **A hidden console** — see above.
- **A login item.** The agent is fetched and run in memory with nothing installed, which is the whole shape
  of its install story. `/autostart/enable` exists for the case where it does live on disk.
- **Typed text.** As everywhere: a keystroke is an event with a timestamp and nothing else.
