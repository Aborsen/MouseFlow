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
[the tradeoff](#the-one-liner-tradeoff). To run a copy you downloaded and read first:

```powershell
& ([scriptblock]::Create((Get-Content "$env:USERPROFILE\Downloads\mouseflow-agent.ps1" -Raw))) -AllowOrigin https://your-app.vercel.app
```

**Do not use `-File`.** On any machine whose execution policy comes from Group Policy — most
corporate estates — the `MachinePolicy` and `UserPolicy` scopes outrank the
`-ExecutionPolicy Bypass` argument, so an AllSigned estate refuses an unsigned `.ps1` with
*"is not digitally signed"* no matter what you pass. Handing the script text to a scriptblock
never loads a file, so the policy never engages. Check yours with `Get-ExecutionPolicy -List`.

Autostart is unavailable on either path, because both leave `$PSCommandPath` empty and the
logon launcher needs a real file to point at. A signed installer is the fix; see
[where this would go next](#where-this-would-go-next).

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

### Local network access

Chrome 142 replaced Private Network Access with **Local Network Access**, a user permission.
Reaching `127.0.0.1` from a public origin — i.e. from the deployed app — now prompts, and the
old `Access-Control-Allow-Private-Network` response header grants nothing. Chrome 147 extended
enforcement to WebSockets.

This is invisible in local development, because a loopback page talking to loopback is
same-address-space and never prompts. It only appears once deployed, which makes it an easy
thing to ship broken.

What the app does about it:

- Requests carry `targetAddressSpace: 'loopback'`, which also serves as the mixed-content
  exemption for an `https` page reaching `http://127.0.0.1`.
- The **first** loopback request comes from the *Connect* button in step 2, never from the
  background health poll — a permission prompt raised by a background fetch can be dismissed
  without the user understanding what it was for, and a page stuck on "Agent offline" because
  of an ungranted permission has no way back.
- Step 2 pre-explains the prompt and shows the reset path (Settings → Privacy and security →
  Site settings → Local network access) for anyone who clicks Block.
- `navigator.permissions.query({name: 'local-network-access'})` is used when available, but only
  as an optimisation: it reports `denied` before a grant, and reports `denied` on loopback pages
  where requests actually work. Never gate functionality on it alone.

Managed fleets can skip the prompt with the `LocalNetworkAccessAllowedForUrls` Chrome policy.

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
- **No typed text.** The keyboard hook records *that* a key was pressed and when, never which — so a
  transcript can say "47s and 132 keystrokes into the Subject field" and can never say what was written.
  The consequence is that a recording containing typing cannot be replayed faithfully: the replay waits out
  the typing and presses nothing, and reports how many events it skipped. Work that has to type belongs in
  a created skill, which is told what to write.
- **Windows only**, and Chrome/Edge only in practice — Safari has no Local Network Access
  permission to grant and blocks the loopback hop outright.
- **Integrity levels cut both ways.** A normal (medium-integrity) agent cannot inject into an
  elevated window *and* cannot see input while an elevated window is in the foreground — UIPI
  applies to the hook as well as to `SendInput`. So a recording made over an admin app is
  silently incomplete, not just unreplayable. Run the agent elevated if any target app is, and
  note that the UAC secure desktop is unreachable either way. This is the failure mode that
  demos fine for weeks and then dies live on one elevated app.
- **Antivirus and EDR are untested.** A process that installs a global mouse hook and calls
  `SendInput` looks exactly like a RAT. Nothing here has been run against Defender, CrowdStrike
  or SentinelOne. Test that before putting it in front of a corporate machine.

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

## On "why not make it fully web-based"

Because it cannot be done, and the reason is worth stating precisely: no shipped or proposed web
API lets a page observe pointer input outside its own viewport with button state, or author input
that Windows or a native app accepts. The nearest thing that ever shipped is Captured Surface
Control (Chrome 136+), which forwards *wheel and zoom* to a captured **tab** and whose explainer
says forwarding clicks is not foreseen. WebHID refuses the Generic Desktop mouse/keyboard
collections by name, on the stated grounds that raw access "enables the creation of input
loggers" — which is, precisely, what this tool is. That is the sandbox working as designed, not a
gap waiting to be filled.

Two shapes do get to zero install, and both work by moving the *target* into the browser:

- **Web-only targets** — a browser extension driving CDP can record and replay inside Chrome
  tabs. It cannot touch a native app, and `chrome.debugger` plants a *"MouseFlow started
  debugging this browser"* infobar in every tab until dismissed.
- **A streamed desktop** — host Windows in the cloud, bake this agent into the image, and the
  user drives it through a canvas. Genuinely zero install, full fidelity *inside the image*, and
  it makes you a DaaS vendor. AWS AppStream bundles the Microsoft RDS SAL at ~$4.19/user/month,
  which is the cheapest compliant route; Azure Windows 11 images require a per-user M365 or VDA
  entitlement the customer already holds.

For automating apps on the user's *own* machine, a local helper is not a shortcut — it is the
only option. The honest goal is therefore to make the install small, signed and once-only, not
to eliminate it. Also ruled out along the way: `ms-appinstaller:` (disabled by default since App
Installer 1.21.3421.0, December 2023, after it was abused to bypass SmartScreen) and ClickOnce
(unsupported by Chrome).

## Where this would go next

- **A signed per-user installer**, replacing both start paths. One byte-identical signed binary
  (so it accumulates SmartScreen hash reputation — a per-user-unique build never can), with the
  pairing token carried in the URL rather than baked into the file, a `mouseflow://` scheme for
  relaunch, and the autostart task registered at install time. Azure Artifact Signing is ~$10/mo
  and does not need an EV certificate; identity validation takes 1–20 business days, so start it
  early. This is what removes the PowerShell paste entirely.
- **Anchored recording.** Capture the target window handle, title and client-relative
  coordinates alongside the screen position, then re-resolve the window at replay time. This
  removes the single biggest fragility.
- **Text for the steps that need it**, if it can be done safely. Keystroke *timing* is captured now; the
  content is not, and adding it needs a redaction design rather than a hook. The alternative already
  works: a created skill is told what to write.
- **Tauri build.** The same UI shipped as a ~5 MB desktop app removes the agent install, the
  loopback bridge, and the Safari limitation in one move.
- **Shared flows.** Recordings are small plain text; a flow could be a shareable document
  rather than a `localStorage` entry.
