# MouseFlow

Record what you do with the mouse, replay it, and chain recordings into repeatable flows.
The UI is an installable web app; a small local agent does the parts a browser cannot.

Compatible with [Mini Mouse Macro](https://www.dopesoft.co.uk/) `.mmmacro` files in both
directions — import an existing recording, or export one for use elsewhere.

## Why there are two pieces

A browser tab can only observe mouse events **inside its own window**, and can only
synthesize events **inside its own DOM**. There is no web API for a global mouse hook or for
injecting real OS input — deliberately, because that is a keylogger primitive.

So the split is not a shortcut, it is the only shape that works:

| | Runs where | Owns |
|---|---|---|
| **Web app** | Vercel, or any static host | UI, recording library, flow model, import/export |
| **Agent** | The user's own machine | `SetWindowsHookEx(WH_MOUSE_LL)` to record, `SendInput` to replay |

They talk over loopback HTTP in one plain-text format — the same one Mini Mouse Macro writes:

```
index | X | Y | delayMs | action
```

`delayMs` is the wait **before** that event. Actions: `Mouse Movement`,
`Left|Right|Middle Click Down`, `Left|Right|Middle Click Release`, `Scroll Up`, `Scroll Down`.

## Quick start

Open the app and follow the six-step panel. It is mostly buttons, and it detects each step
rather than asking you to confirm it:

1. **Copy the start command** — one line, pre-filled with your origin
2. **Paste it into PowerShell** — auto-completes the moment the agent connects
3. **Keep it running after you log in** — one click, or skip
4. **Record something** — starts the recorder
5. **Add it to the flow**
6. **Run it**

The command in step 1 pipes the agent straight into a scriptblock:

```powershell
& ([scriptblock]::Create((irm https://your-app.vercel.app/agent/mouseflow-agent.ps1))) -AllowOrigin https://your-app.vercel.app
```

Nothing is downloaded, unblocked, or exempted from the execution policy — but see
[the tradeoff](#the-one-liner-tradeoff). To run from a file instead:

```powershell
powershell -ExecutionPolicy Bypass -File .\mouseflow-agent.ps1 -AllowOrigin https://your-app.vercel.app
```

Locally, any static server works: `npx --yes serve . -l 4321`

Hold <kbd>Esc</kbd> at any point during replay to abort. The agent releases any held mouse
button when it aborts, so you never get left mid-drag.

### Autostart

Step 3 writes `MouseFlowAgent.cmd` into your Startup folder, so the agent is already running
next time you log in and onboarding never happens again. It needs no admin rights, and
deleting that file undoes it.

Two deliberate restrictions, because a web page asking a local service to create a persistent
launcher is exactly the shape of an attack:

- **The command is built only from the agent's own launch arguments.** Nothing from the HTTP
  request reaches the file, so a hostile page cannot turn this into "run *my* script at logon".
- **It is refused unless `-AllowOrigin` is pinned**, and refused when the agent was started by
  pipe, since there is then no local file for the launcher to point at. The panel detects both
  cases and offers the file download instead.

### The one-liner tradeoff

`irm … | iex` is the fastest path — one copy, one paste — and it is what Rust, Chocolatey, uv
and others use. It also trains people to pipe remote code into a shell, and it means the script
is re-fetched on every start, so whatever is at that URL runs. That is fine when the URL is
your own deployment and you trust your own DNS and hosting; it is not a pattern to use with a
URL someone sent you. The download path exists for anyone who would rather read the file first,
and is the only path that supports autostart.

## Deploying

The app is static — no build step. Point a Vercel project at this directory and deploy.

Two things to get right:

- **Framework preset.** A static project with no framework detected can deploy "Ready" and
  still serve `NOT_FOUND` if the preset is `null`. Set it to *Other* in project settings.
- **`-AllowOrigin`.** Once deployed, run the agent pinned to your origin:

  ```powershell
  .\mouseflow-agent.ps1 -AllowOrigin https://your-app.vercel.app
  ```

  The app shows this exact command, pre-filled with your origin, in the **Agent offline**
  panel. Anyone you share the URL with needs the agent too — the URL alone is just the UI.

## Security

Read this before sharing the link.

- **`-AllowOrigin '*'` is the default and it is permissive.** While the agent runs, *any*
  site open in your browser can reach `127.0.0.1:8787` and drive your mouse. That is fine for
  a demo on your own machine; pin the origin for anything else.
- **The hook is always installed** while the agent runs, but events are only stored between
  `/record/start` and `/record/stop`. Nothing is written to disk and nothing leaves the
  machine — the agent has no outbound network code at all.
- **Recordings live in `localStorage`**, i.e. in the browser, not on a server. Clearing site
  data deletes them. Export anything you want to keep.

## Known limits

- **Absolute coordinates.** A recording is pixel positions on the screen it was made on. Move
  the target window, resize it, change resolution, or plug in a second monitor and the replay
  clicks whatever now sits at those pixels. This is inherent to coordinate recording, not a
  bug in the replayer — a selector- or image-anchored recorder is the fix, and is out of scope
  for this POC.
- **Display scaling.** `SendInput` works in physical pixels. If a recording was made under a
  different DPI scale, every position is off by the scale ratio.
- **Mouse only.** No keyboard capture. The format has room for it; the hook does not install
  `WH_KEYBOARD_LL` yet.
- **Windows only**, and Chrome/Edge only in practice — Safari blocks requests from an HTTPS
  page to loopback, so the agent is unreachable there.
- **Elevated windows.** A non-elevated agent cannot inject input into an elevated window
  (UIPI). Run the agent as admin if the target app is.

## Agent API

Loopback only. All responses carry CORS plus `Access-Control-Allow-Private-Network`.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | `{ok, version, screen, cursor, hook, recording, playing}` |
| `POST` | `/record/start` | `{ok}` |
| `GET` | `/record/status` | `{recording, count, elapsedMs}` |
| `POST` | `/record/stop` | `text/plain` event lines |
| `POST` | `/replay` | `{ok}` — body is a flow (below) |
| `GET` | `/replay/status` | `{playing, step, steps, pass, passes, flowPass, flowPasses, index, total}` |
| `POST` | `/replay/abort` | `{ok}` |
| `POST` | `/autostart/enable` | `{ok}` — writes the Startup launcher, or `409` with the reason |
| `POST` | `/autostart/disable` | `{ok}` — removes it |

Flow body:

```
# comments allowed
startDelay=2000
flowRepeat=forever
STEP repeat=3 speed=2 delayAfter=500
1 | 1285 | 180 | 1573 | Left Click Down
2 | 1285 | 180 | 90 | Left Click Release
STEP repeat=forever speed=1 delayAfter=0
1 | 908 | 174 | 17 | Mouse Movement
```

`repeat` and `flowRepeat` accept a count or `forever` (`0` means the same). `flowRepeat` is
"restart the whole sequence when it ends"; `repeat` on a step loops just that step.

Agent flags: `-Port 8787`, `-AllowOrigin '*'`, `-MoveThrottleMs 10`, `-MoveMinPx 3`. The last
two thin out the move stream — the raw hook fires hundreds of events per second, and only
moves that are far enough apart in both time and space carry information.

## Layout

```
index.html   app.css   app.js        the whole UI, no framework, no build
manifest.webmanifest   sw.js         installable + offline app shell
icons/                               PWA icons
agent/mouseflow-agent.ps1            the local agent, single file
```

## Where this would go next

- **Anchored recording.** Capture the target window handle, title and client-relative
  coordinates alongside the screen position, then re-resolve the window at replay time. This
  removes the single biggest fragility.
- **Keyboard capture** via `WH_KEYBOARD_LL`, with a redaction pass so passwords typed during a
  recording are never stored.
- **Tauri build.** The same UI shipped as a ~5 MB desktop app removes the agent install, the
  loopback bridge, and the Safari limitation in one move.
- **Shared flows.** Recordings are small plain text; a flow could be a shareable document
  rather than a `localStorage` entry.
