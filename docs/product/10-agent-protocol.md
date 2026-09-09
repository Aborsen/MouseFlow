# 10 — Agent protocol

The loopback HTTP contract every desktop agent implements. The normative version is
[`agent/PROTOCOL.md`](../../agent/PROTOCOL.md); this is the guided tour of it. Two implementations agree on
it today: `agent/mouseflow-agent.ps1` (Windows) and `agent/mouseflow-agent.swift` (macOS), with
`web/src/lib/agent.ts` as the only client.

**If you are writing a third agent: implement this and nothing else.** Do not change `web/src/lib/agent.ts`,
`web/src/lib/desktop-engine.ts` or the Connections screen — they are shared. If your platform cannot honour
something here, propose the change to the document rather than implementing a variant of it.

## Shape

A plain HTTP server on `127.0.0.1`, default port **8787**, no TLS, no framework. **Loopback only** — never
bind `0.0.0.0`. Responses are JSON `{ ok: true, … }` except `/record/stop` and `/record/drain`, which return
`text/plain`. Failures return a non-2xx status and `{ error: "…" }`; the client surfaces that message to the
user **verbatim**, so write it for a person.

Every endpoint has a client-side deadline. Exceeding it is reported as the agent being unreachable, so **a
slow answer is worse than a refusal**.

## The endpoints

| Method | Path | Deadline | Returns |
|---|---|---|---|
| GET | `/health` | 4 s | `{ ok, version, platform, screen:{x,y,w,h}, cursor, hook, recording, playing, autostart, canAutostart, originPinned, canSee, canWindows, canName, canKeys, canDrain, permissions }` |
| GET | `/shot` | 12 s | `{ ok, png, format, bytes, w, h, scale, originX, originY }` |
| GET | `/shot?w=640` | 12 s | the same, smaller — asked for after a 413 upstream |
| GET | `/pulse` | 5 s | `{ ok, grid }` — 64×36 greyscale samples as a short string, ~3 KB |
| GET | `/windows` | 5 s | `{ ok, windows:[{ title, process, active, minimized, x, y, w, h }] }` |
| POST | `/do` | 20 s | `{ ok }` — one action, body is `key=value` text |
| POST | `/record/start` | 5 s | `{ ok, moveMs }`; **409** while a held recording waits |
| POST | `/record/start?moveMs=250` | 5 s | thins the pointer path for a long session |
| GET | `/record/status` | 2.5 s | `{ recording, count, part, moveMs, elapsedMs }` |
| POST | `/record/drain` | 15 s | **text/plain**, what has piled up; **the recording continues**. 409 when nothing is recording |
| POST | `/record/stop` | 15 s | **text/plain**, one event per line (`.mmmacro`) |
| POST | `/replay` | 5 s | `{ ok }` — starts a replay and returns immediately |
| GET | `/replay/status` | 2.5 s | `{ playing, step, steps, pass, passes, flowPass, flowPasses, index, total, unplayable, retargeted }` |
| POST | `/replay/abort` | 4 s | `{ ok }` |
| POST | `/account` | 5 s | `{ ok, linked: true, taking }` — body `token=mf_… base=https://…`, and optionally `taking=0` |
| DELETE | `/account` | 5 s | `{ ok, linked: false }` |
| POST | `/autostart/enable` | 8 s | `{ ok }` — needs the agent to exist as a file on disk |
| POST | `/autostart/disable` | — | `{ ok }` |
| POST | `/crash-test` | 15 s | `{ ok, reported }` — sends one crash on purpose and **waits** for the answer. **409** when the machine is not attached to an account |

## Capability flags

A version number could not answer the question that mattered: an agent started before the click resolver
existed and one started after it both reported `0.5.0`, and the difference was the whole transcript — a list
of coordinates against a list of named actions. So each capability is **stated**.

| Flag | Means |
|---|---|
| `canSee` | Screenshots work (`/shot`, `/pulse`) |
| `canWindows` | `/windows` works |
| `canName` | A click carries `#ctx` — the application, window, control and type it landed on |
| `canAnchor` | …and the rectangles of that window and that control, so a replay survives the window moving |
| `canKeys` | Typing is recorded as an event (that a key was pressed, and when) |
| `canDrain` | A recording can outlast one response (`/record/drain`) — i.e. long sessions are possible |
| `platform` | `windows` or `macos`. Used for **exactly one thing**: which install command the Connections screen shows. Never to decide what an agent can do — that is what the `can*` flags are for. |
| `permissions` | `{ accessibility, screenRecording }`, macOS only. On Windows both are unconditionally true and there is nothing to report. |

**A missing flag is an answer**: the agent predates it. `canKeys` is the one that can be `false` rather than
absent — the keyboard hook may fail to install, and the agent runs without it rather than refusing to start.
On macOS `canSee` follows Screen Recording and `canName` follows Accessibility, so the flags are answers
rather than constants there.

`version` is compared against `AGENT_WANTS` in `web/src/lib/agent.ts`, numerically part by part. A new
implementation should report a version it can honour the **whole** of this table at.

## Coordinates

Everything — `/shot`, `/do`, `/replay` — works in **virtual-desktop coordinates**: one space covering all
monitors, which on Windows can start at a negative origin. `/shot` reports `scale` (and `originX` /
`originY`) so a point measured on the returned picture maps back onto the screen. `desktop-engine.ts` does
that conversion in exactly one place (`actionBody`), and a second implementation must not need a second one.

Two platform traps, stated because Windows hit both:

- **Input injection happens in physical pixels.** A recording made at one display scale replays wrong at
  another unless the units are pinned.
- **Coordinates outside the desktop are clamped by the OS rather than refused**, so an out-of-bounds click
  lands somewhere real. Bounds-check before acting, and report the refusal.

On macOS the same trap arrives from the other direction: CGEvent works in global display **points**, a
capture comes back in backing **pixels** (twice that on Retina). Same answer: `scale` is picture-pixels per
point.

## `/shot` and `/pulse`

`/shot` returns a base64 picture sized to a **megapixel budget** rather than a fixed width — a vision
payload is priced in pixels.

**`format` is a full MIME type** — `image/jpeg`, quality ~85 — and not an extension. The client hands it to
a model request verbatim, where anything but `image/jpeg`, `image/png`, `image/gif` or `image/webp` is a
400. The protocol line used to say `'jpeg'`, the second implementation followed it, and generating a flow
answered 400 on that machine until somebody tried it. The client now promotes and falls back rather than
forwarding a remote value to be refused (`mediaType()`).

`/pulse` exists so **waiting is cheap**: a 64×36 greyscale grid the client polls to notice the screen has
stopped changing. Without it every "is it done yet?" costs a full screenshot and a model call. A client that
finds no `/pulse` falls back to fingerprinting screenshots, so it is optional but strongly wanted.

## `/windows` — why it exists

A screenshot is not the whole truth: an application that is minimised or behind another window is invisible
to a picture, and something acting only on pictures will happily launch a second copy of a program that is
already running. **That is not hypothetical — it is what happened.** `/windows` says what is open, and
`action=activate` gets to it without opening anything.

Enumerate real top-level windows only, and expect the fiddly cases to matter — on Windows those were
DWM-cloaked Store windows, owned dialogs, helper windows too small to be real, and the desktop shell itself.
`title` and `process` are what the model reasons about, so they must be the names a person would recognise.

## `/do` — the action body

`Content-Type: text/plain`, one action per request, `key=value` separated by spaces:

```
action=click x=1074 y=159 button=left double=0
action=click x=1074 y=159 name=Netflix
action=move x=400 y=300
action=scroll x=400 y=300 amount=-3
action=type text=hello there
action=type enc=b64 nl=shift text=<base64 UTF-8>
action=key key=Enter ctrl=0 shift=0 alt=0
action=activate title=Outlook
action=activate process=outlook
```

Parsing rules that matter, all learned the hard way:

- **`text=`, `title=` and `name=` take the rest of the line, unsplit** — they contain spaces. Therefore
  `process=` must come before `title=`, or the title swallows it.
- **`name=` is a hint, not a target.** It is what the caller believes it is clicking, in the words on screen.
  Hit-test the point, and only if something else is under it, look for that name nearby. A coordinate read
  off a downscaled screenshot is a point; a name is the thing. They part company the moment anything
  re-lays-out, which a tab strip does every time the number of tabs changes.
- **A field marker only counts at the start of a token**, or `subtitle=` matches `title=` and the parse
  begins four characters into the wrong word.
- **`enc=b64` carries UTF-8 base64** so multi-line text survives. `nl=enter` presses Enter between lines,
  `nl=shift` presses Shift+Enter — the difference between sending an email and typing a paragraph into one.
  Give the application a moment after a line break; typing straight through loses characters.
- **`ctrl=` means Command on macOS.** A deliberate translation: the grammar was written on Windows where
  Ctrl+C is copy, and on macOS the same intention is Cmd+C — posting a literal Control+C would send an
  interrupt to a terminal. `cmd=` and `meta=` are accepted as themselves, and `raw-ctrl=` asks for the
  literal Control key.

**Report failed injection.** The Windows agent originally ignored the return value of `SendInput`, so input
that never arrived was reported as success and the model built its next decision on a lie. Check your
platform's equivalent and say what went wrong: on Windows, error 5 means an elevated window owns the
foreground and error 0 means the screen is locked.

## The recording format

`/record/stop` and `/record/drain` return Mini Mouse Macro layout, one event per line, `#` for comments:

```
index | X | Y | delayMs | action
1 | 1074 | 159 | 791 | Left Click Down
2 | 1074 | 159 | 63 | Left Click Release
```

`delayMs` is the wait **before** the event. Recording is bounded: the hooks may stay installed for the
agent's lifetime, but events are only stored between `/record/start` and `/record/stop`. **Nothing is
captured unasked** — a product decision, not an implementation detail.

### The seven action words

Five come from the mouse:

```
Mouse Movement
Left|Right|Middle Click Down     Left|Right|Middle Click Release
Scroll Up     Scroll Down
```

And two do not:

**`Focus` — the foreground window changed.** Not an action; a marker saying the work moved, so a step that
hit-tests nothing can still be placed. It is the only per-step answer for a scroll, a wait or a run of
typing; without it those sit in whichever segment a click last opened. Two rules: **never emit one between a
press and its release** (the transcript pairs a click by looking at the very next event, so a marker there
becomes an unreleased press plus a stray release), and **emit one at `/record/start`**, so a recording says
where it began.

**`Key Down` — a key was pressed, and when. Never which key.** This is the whole design and it is not
negotiable: *"five of those ten minutes went on typing in Outlook"* needs the timing and nothing else, and a
hook that reads key codes has captured a password whether or not it stores one. The Windows agent marshals
`KBDLLHOOKSTRUCT` to read a **single flag** — whether the key was injected, so a replay pressing keys is not
recorded as a person typing — and never touches `vkCode` or `scanCode`. Auto-repeat arrives as ordinary
key-downs and is kept: holding a key is time spent typing, and filtering it would need the identity this
deliberately does not have.

Both are `#ctx`-bearing lines in the five-column format, so nothing that reads `.mmmacro` needs to know they
exist.

**A replay cannot perform either, and must say so.** A keystroke has no key in it and a `Focus` is a note.
Both are named explicitly in the action switch rather than dropped through `default`, counted, and reported
as **`unplayable`** on `/replay/status` — a replay that pressed nothing for the two minutes somebody spent
typing must not come back looking like a clean run. The pause before each event is still waited out, so the
replay keeps the shape of the original. Work that has to type belongs in a created skill, which is told what
to write.

### `#ctx` — where a click landed

```
#ctx	app=chrome	window=Inbox — Outlook	control=Send	type=button
7 | 1074 | 159 | 240 | Left Click Down
```

Tab-separated `key=value`, on the line **above** its event, attaching to exactly one event. Keys: `app`
(process or application name), `window` (title), `control` (the accessible name of the thing under the
pointer), `type` (its control type). Unknown keys are ignored rather than being an error; an empty value is
the same as absent.

**Eight more, the anchor:** `wx wy ww wh` — where the window was — and `ex ey ew eh` — where the named
control was — in screen pixels, at the moment of the click. Both agents write them from the work they were
already doing (the window manager for one, the hit test that produced `control` for the other), never from a
second traversal, and they announce it as `canAnchor`. A replay uses them to put the point back inside the
right window before the agent aims it at the control by name; see [04 — Record](04-record.md) and
`api/_anchor.mjs`. Absent on every older recording, and absent is the answer.

**Four more keys, macOS only and newer than the four above:** `role`, `subrole`, `in` (the role of the
container the click was in) and `inName` (that container's name). They exist because of a problem `type`
has: `type` is `kAXRoleDescription`, which is **the language of the machine** — a Russian Mac says
*"кнопка папки с закладками"* where an English one says *"bookmark folder button"* — so anything reading it
has to be a translator. `role`, `subrole` and `in` are **role tokens**: the same words on every machine,
which is what lets a transcript say *where* a click landed without speaking the user's language. `inName` is
the exception and is content rather than vocabulary — quoted, never matched.

Only containers a person would recognise as somewhere are named: `AXToolbar`, `AXMenuBar`, `AXMenu`,
`AXTabGroup`, `AXList`, `AXOutline`, `AXTable`, `AXWebArea`, `AXSheet`, `AXDrawer`. `AXGroup` is scaffolding
and says nothing. The container is looked for on the **same walk** that looks for a name and a little past
it — the name usually turns up within a level or two and the toolbar holding it a level or two above that,
and eight is where a browser's page wrapper gives way to the window, which is recorded already.

These are **emitted but not yet consumed**: `parseMacro` in `web/src/lib/macro.ts` and `ctxOf` in
`api/_transcript.js` both read only the original four keys, so the new ones are dropped before a recording
reaches the account. The unknown-keys rule is what makes that harmless — an older reader loads the recording
exactly as before — but nothing downstream is using them yet.

This is what turns *"clicked at 1074,159"* into *"clicked **Send** in Outlook"*, and it is the only
per-event answer to "which application was this in" — `payload.windows` is sampled once a second at the
**recording** level, so it says which applications appeared, never which one a given click hit.

Rules, all learned the hard way:

- **Clicks only, and only the button-down.** A move has no target worth naming and there are hundreds of
  them; the release is the same target a moment later.
- **Absent means NOT KNOWN, never "nothing there".** A transcript has to keep that difference, so never emit
  a `#ctx` line with invented or placeholder values.
- **Never resolve on the input path.** On Windows a low-level hook that overruns `LowLevelHooksTimeout`
  (300 ms by default) is removed without telling anybody, and the first accessibility call on a thread costs
  ~120 ms. The hook queues the coordinates; a worker resolves them. If the worker falls behind, drop the
  **context**, never the event. The macOS event tap has its own timeout, for the same reason.
- **Never walk the tree.** Hit-test the point and climb for a name — measured on Windows, a full
  control-view walk is 0.6–4.4 seconds per window, and caching makes it worse.
- One bounded amendment, measured on macOS: when the climb and one awaken retry both come back nameless, at
  most **two frame-checked steps down** through the hit element's children are allowed (60 children per
  level, hidden ones skipped, smallest containing frame wins). Chromium hit-tests a tab to an unnamed group
  covering the whole strip, with the tab one level below — reachable by a person's eye and by this, never by
  climbing up.

Blind spots are similar on both platforms: Electron applications expose almost nothing (on Windows, ChatGPT
desktop offers 34 characters of control names in the entire app), and an elevated window is invisible to a
medium-integrity Windows process. **Say so in the transcript; do not paper over it.**

### The `#part` line

A chunk from `/record/drain` carries its metadata the same way `#ctx` travels, so every existing reader of
the format loads a chunk as an ordinary recording:

```
#part	n=3	elapsedMs=5400123	events=812	moveMs=250	dropped=0
```

## `/record/drain` — a session that lasts a working day

Added in 0.8.0, and the reason is arithmetic rather than taste: **69 bytes an event, 23–42 events a second**
(measured), so 1.5–2.9 KB/s; the app refuses a payload over 400 KB, which arrives around the third minute.
Before this, `/record/stop` was the only way events left an agent, so eight hours meant ~830,000 events held
in memory and returned in one string.

`/record/drain` takes what has piled up and **keeps recording**. What it must **not** touch is the whole
point, and every omission is load-bearing:

- **the clock runs on**, so `elapsedMs` stays the time of the SESSION. A chunk knows its own length from its
  events; only the session can say how far in it is.
- **the last-event timestamp and position stay**, or one unthrottled burst of movement gets through at the
  start of every chunk.
- **the held-button count stays**, or a drain landing mid-drag lets a `Focus` marker split the next chunk's
  press from its release.
- **the last foreground window stays**, so an unchanged window is not re-announced every chunk.

**409 when nothing is recording**, not an empty body: "nothing happened in the last half hour" and "there is
no recording" have to be distinguishable, or a chunker writes an empty part every half hour for as long as
the tab stays open.

`?moveMs=` on `/record/start` is the other half of fitting — see [04 — Record](04-record.md#long-sessions).
**Per session, not global**: a plain `/record/start` afterwards records at the default again.

## A recording may end at the AGENT

Since 0.8.2. On macOS that is the menu bar's **Stop and Save Recording**; on Windows the notification-area
icon's. For the person who started a flow in the app and does not want to dig the browser back out.

The agent stops capturing and **holds the events**:

- `/record/status` answers `recording: false` with `count > 0` — a state a client-driven stop never leaves
  behind, so it is the whole signal.
- `/record/stop` delivers them exactly as always.
- `/record/start` answers **409** while a hold waits, because starting over it would destroy the one thing
  the stop promised to save. The refusal comes from inside `start()`, atomically.
- The hold is **spilled to the agent's own disk** the moment it exists and reloaded at startup, so no restart
  — a crash, a logout, the permission watcher's own self-restart — can destroy it. The file is deleted on
  delivery.
- The hold carries the same `#part` line a drain writes, so the session clock and part number survive an
  agent restart with it.
- The menu says a hold is waiting, because "I pressed Save and nothing visible happened" reads as loss.
- **Since 0.26.0 the menu interaction itself is cut out of the hold.** Opening the menu and pressing the
  item were both captured, so a replay of that recording opened the menu and pressed the same item again —
  starting a new recording, because the item is in the same place. The agent marks its buffer at
  `ContextMenuStrip.Opening` / `menuNeedsUpdate`, at the last press before it, and truncates there **before**
  `count` and the hold flag are computed — so a recording consisting only of the stop is delivered as
  nothing rather than as one event. Trailing `Mouse Movement` goes with it. Only this door reads the mark;
  the client's own Stop button is the client's tail to cut, because only the client knows its title. See
  [04 — Record](04-record.md).

**The agent itself never touches the account** — it has no credentials, which is a design and not a gap.
An agent that never ends recordings itself is still a valid implementation of this section: the client only
ever reacts to the state and never requires it.

Two defects were found and fixed here by reading one implementation against the other, and both are true of
any agent doing this:

1. **Declare the hold in the same critical section that drops the recording flag.** Taking the buffer after
   the resolver wait left up to 1.5 s where the agent answered `recording:false` with `count>0` while nothing
   was held yet; the client lands there, calls `/record/stop`, and gets the live path — the events survive by
   that ordinary door, but the spill never happens and the agent then reports that nothing was captured.
2. **Serialize and spill OUTSIDE the lock the input path takes.** A long session is hundreds of thousands of
   events plus a multi-megabyte write, and holding that across a lock a mouse move needs is precisely the
   hook-timeout hazard the rest of the file is built to avoid.

## `/replay` — the flow body

```
# comments allowed
startDelay=3000
flowRepeat=forever
STEP repeat=2 speed=1.0 delayAfter=500
1 | 1074 | 159 | 791 | Left Click Down
2 | 1074 | 159 | 63 | Left Click Release
STEP repeat=1 speed=2.0 delayAfter=0
1 | 908 | 174 | 17 | Mouse Movement
```

`repeat` and `flowRepeat` take a count or the word `forever` (`0` means the same). `flowRepeat` restarts the
whole sequence when it ends; `repeat` on a step loops just that step.

### Aiming a replay by name

**`#ctx` travels with a replay too, and aiming by it is the difference between opening the tab you recorded
and opening whichever tab is now at those coordinates.** The lines above an event are the same ones a
recording carries, so nothing new has to be parsed. A replay that has them should hit-test the point before
pressing, and when the thing under it is not the one named, look for that name among the siblings of whatever
**is** under it. One level, not a tree walk — the same arithmetic as the resolver — but a re-laid-out row of
tabs, buttons or list rows keeps its neighbours exactly there, which is the case that fails.

Two rules make it safe:

- **Aim only on the PRESS**, and let the release follow wherever the press went. Releasing at the recorded
  coordinate after pressing somewhere else turns one click into a drag across the window.
- **Count the corrections** and report them as `retargeted`. A replay that quietly moved where it clicked is
  a replay whose report cannot be trusted.

### Abort

**Immediate, and it releases what it holds.** Check the stop flag before every event *and* inside every
sleep, and release every held button and key on every exit path, including the failure paths — a replay that
dies holding the left mouse button leaves the machine unusable. The Windows agent also honours a held ESC as
a hardware-level escape hatch, which is worth copying.

## `/account` — the machine asks, and nothing reaches in

From 0.8.3. Everything else in this table is the app telling the agent what to do **now**, over loopback,
because a person pressed something. This is the one route that changes what the agent does when nobody is
looking: attached, it asks the account whether there is work — a recording to start, a recording to stop, a
replay to run — takes it, does it through the very same code paths above, and reports back.

`POST /account` with `token=mf_… base=https://…` attaches it; `DELETE /account` detaches it. `/health` then
carries two more facts, and they are two rather than one on purpose:

| | |
|---|---|
| `linked` | attached to an account at all |
| `taking` | attached **and** currently asking for work |

Attached-and-not-taking is the ordinary resting state, and collapsing the pair would make the app offer to
pair a machine that is already paired. **Absent** means the agent is too old to do this at all — which is
"cannot", not "off", and the app reads it that way.

Three properties are the design rather than details of it:

- **The connection only ever goes outward.** There is no inbound path, in either state. Switched off, the
  agent makes no outbound call either — not a poll, not a heartbeat.
- **The token is handed over across loopback and never shown.** The app is signed in as the person, mints
  one, and passes it here. A credential somebody has to carry is a credential somebody mislays.
- **A refused token switches taking off**, rather than retrying a revoked credential for ever into a log
  nobody reads.

`agent/PROTOCOL.md` is normative for this route; [21 — MCP](21-mcp.md#letting-it-act-on-your-computer) is
what it is for.


## Carrying out a goal — `?worker=step`

A **recorded** skill is a body to replay, and an agent has always been able to do that alone. A **created**
skill is a *goal*: a sentence a model carries out by looking at the screen and choosing one action at a
time. There is no model in an agent, so until 0.9.0 those jobs needed a second node process on the same
machine — the worker — whose only real qualification was that it could reach `127.0.0.1`.

Since 0.9.0 the agent does them itself, by being the hands rather than the head:

```
agent  ──POST /api/mcp?worker=step  { id, shot, windows, results }──►  deployment decides (~7s)
agent  ◄─────────────────  { actions: [ … ] }  ─────────────────────
       does them, takes a new picture, posts again
```

One request per step, and nothing reconnects between them because there is no gap: the reply to one step is
what produces the next. The request is deliberately allowed to be slow — that is the model thinking, not a
stall.

| | |
|---|---|
| **`shot`** | Exactly what `/shot` returns, spliced in whole |
| **`windows`** | The **ARRAY** from `/windows`, not the wrapper. Both agents send the array, because a wrapper on one side is invisible until the model is told nothing is open |
| **`results`** | What came of the last `actions`: `{ id, output }`, or `{ id, isError: true, output }` |

**A `wait` answers with numbers** — `{ id, quiet, waited, quietFor }` — and never a sentence. The wording the
model reads is composed at the deployment, so the two agents cannot phrase the same outcome differently.

The answer is one of **`{ actions }`**, **`{ shrink: <width> }`** (that picture was too large to send — take
a smaller one and ask again; nothing was done, so send no results) or **`{ done: true }`** (finished,
cancelled, or the job is gone). An action is `{ id, kind: "do", body }` — a `/do` line the agent already
speaks — or `{ id, kind: "wait", ms }`.

Four rules that are easy to get wrong:

- **The deployment closes the job itself** on the step that ends it. An agent must NOT also
  `?worker=report` a run it drove, or it overwrites what the run said. It reports only when it gives up
  part-way.
- **A claimer is offered goals only if it says it can take them** — `steps: true` in the `?worker=claim`
  body. An older agent goes on not being offered them, which is why the declaration is on the claimer
  rather than inferred from a version.
- **When a worker and a step-capable agent are both listening, the agent gets the goal.** There is one
  mouse and both long-poll the same endpoint, so the queue decides rather than the race: a worker is not
  offered a goal while an agent has asked for work in the last 90 seconds, and starts taking them again by
  itself if that agent stops. A machine with only a worker is unaffected.
- **A stop is noticed inside a wait.** A wait can last two minutes, which is far too long for "cancelled"
  to mean nothing, so every third look at the screen the agent also asks `?worker=state&id=`. If the job is
  no longer `claimed` it abandons the rest of the turn and posts what it has. No answer to that question is
  not an answer — the next step finds out anyway.

**Waiting happens at the agent now**, with the same numbers the app's own loop uses: the 64×36 fingerprint
from `/pulse`, 1.5 s between looks, two still frames, and a mean difference above 3/255 counting as
movement. They agree on purpose — "the screen stopped" must not mean two things.

## Saying it fell over — `?worker=crash` and `/crash-test`

An agent runs under launchd, or in a window, on somebody else's computer. Until 0.9.0 the only trace of a
fault was a line in a log nobody opens.

Both agents now report **through the account** — `POST /api/mcp?worker=crash` with
`{ type, message, where, level, platform, version, stack }` — and never to Sentry directly. That is the
design rather than a shortcut: the agent already dials the deployment with a device token, so it needs no
DSN of its own inside a program people download, and what arrives is already attached to an account and to
a build.

Three rules, both implementations:

- **Once per process per thing.** A hook that will not install fails every time it is tried.
- **Silent when unpaired.** No account, nowhere to send it, nobody to attach it to.
- **Never blocks, never throws, ten-second timeout.** The courier waits ninety seconds because it
  long-polls; a crash report that held a thread that long would be a second fault.

What cannot travel this way is a failure whose cause is *cannot reach the deployment*. That stays in the
agent's own log, and saying so is part of the contract.

`POST /crash-test` sends one event on purpose and **waits** for the answer: `{ ok, reported }`, where
`reported` is true only if Sentry itself took the event. Fire-and-forget is right for a real fault and
useless for a test — "sent" would mean "handed to a socket", which is exactly the answer that lets a silent
reporter live for months.

## Authentication

**Today: none.** Any process on the machine can POST `/do` and inject input, or GET `/shot` and capture
every monitor. `-AllowOrigin` defaults to `*` and is only echoed as a response header, never used to reject.

A design is being chosen. Note that `/account` does not change this: the token it stores is what the agent
presents *outward* to the account, and it authenticates nothing inward. Until a design lands, a new agent
should implement the table above **without** auth and leave a single seam for it — one function every route calls before doing anything. Do not design a scheme in
parallel: two agents with two schemes is worse than one agent with none.

See [17 — Privacy and security](17-privacy-security.md) for what that means in practice.
