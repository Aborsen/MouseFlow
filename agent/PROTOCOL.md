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
| POST | `/account` | 5s | `{ok, linked, taking}` — attaches this machine to an account; `DELETE` detaches |
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

### A recording may end at the AGENT

Since 0.8.2, an agent may end a recording itself - on macOS that is the menu bar's **Stop and Save
Recording**, for the person who started a flow in the app and does not want to dig the browser back out to
stop it. The agent stops capturing and **holds the events**: `/record/status` answers `recording:false`
with `count>0` - a state a client-driven stop never leaves behind, so it is the whole signal - and
`/record/stop` delivers them exactly as always. `/record/start` answers **409** while a held recording
waits, because starting over it would destroy the one thing the stop promised to save. The hold is spilled
to the agent's own disk the moment it exists and reloaded at startup, so no restart - a crash, a logout,
the permission watcher's own self-restart - can destroy it; the file is deleted on delivery. The menu says
a hold is waiting, because "I pressed Save and nothing visible happened" reads as loss.

**Since 0.26.0 the agent's own menu is not in the recording.** The click that opened the tray menu and the
click on **Stop and Save Recording** were both captured, so replaying that recording ended by opening the
menu and pressing the same item - which, the item being in the same place, STARTED A NEW RECORDING. The
agent now marks its buffer when its menu opens (`ContextMenuStrip.Opening` on Windows, `menuNeedsUpdate` on
macOS), at the last press before that, and truncates there - BEFORE `count` and the "something is held" flag
are computed from it, so a recording consisting only of the stop is delivered as nothing rather than as one
event. Trailing `Mouse Movement` goes with it: a recording ending in the road to the tray sends the cursor
to that corner on replay. The mark is taken at menu-open rather than by a clock, and only this door reads
it - the client's Stop button is the client's own tail to cut, because only the client knows its own title.

The agent itself never touches the account - it has no credentials, which is a design and not a gap. The
client's Record page takes delivery through the same path as its own Stop button: while open, its status
poll notices within a quarter second; on arrival, one status read collects what was held while the page was
away. An agent that never ends recordings itself is still a valid implementation of this section - the
client only ever reacts to the state, and never requires it.

Both agents implement it as of 0.8.2: macOS from its menu bar item, Windows from a notification-area icon.
Where the two platforms differ is only in what the icon has to solve. On macOS the agent is a login item
with no window and no way to stop it; on Windows the console window was the only interface, which could
neither say that a recording was running nor start one. Same answer, opposite complaints.

### `/account` — the machine asks, nothing reaches in

`POST /account` with `token=mf_… base=https://…` attaches this machine to an account. `DELETE /account`
detaches it. `/health` then answers two more facts: `linked` (attached at all) and `taking` (attached AND
switched on). Absent on any agent that cannot do it, and absent means *cannot*, not *off*.

The reason it exists is a direction. The agent listens on loopback and nothing on the internet can reach it —
deliberately, and that does not change. So an instruction from somewhere else has to be **asked for**: the
agent asks the account for a job, does it, and reports. There is no inbound path to the machine at any
point, and an agent that is not taking work makes no outbound call at all — not a poll, not a heartbeat.

It **asks and sleeps** rather than holding the connection open, and that is a hosting fact rather than a
preference: a held request is billed for its whole length, and a serverless function is not allowed to live
as long as a useful hold. Holding 25 seconds against a ten-second ceiling meant every idle poll was cut in
flight - about 50 function-seconds a wall minute, and a log line calling each cut a failure to reach the
account. A claim with no wait answers in about four tenths of a second; with three seconds between asks that
is nearer 7. The endpoint still honours a requested wait, capped at 6 seconds, so an agent built before this
gets a clean answer instead of a cut one.

Three rules that are part of the contract rather than of one implementation:

- **Off until somebody switches it on**, and visible while it is on. Everything else an agent does happens
  because something on that machine asked. This is the one thing it would do because a service said so, and
  that difference belongs in front of the person, in the agent's own menu — not in a setting on another
  screen.
- **The token is handed over, never typed.** The app is signed in as the person; it mints a device token and
  posts it across loopback, the same pairing the extension gets over its bridge. A credential somebody has to
  carry is a credential somebody mislays.
- **A refused token switches taking off.** Retrying a revoked credential for ever is a log nobody reads.

What the agent has to understand from a claimed job is deliberately small: `#record.start`, `#record.stop`,
and a replay `body` in the format it already speaks, with an optional `activate` instruction for the window.
Everything that makes a skill a skill — its events, its parameters, its tool definition — stays on the
deployment, which is what keeps this a few hundred lines rather than a second client.

### `?worker=step` — carrying out a goal without a model on the machine

A **recorded** skill is a body to replay and an agent has always been able to do it alone. A **created**
skill is a *goal*: a sentence a model carries out by looking at the screen and choosing one action at a
time. There is no model in an agent, so until 0.9.0 those jobs needed a separate node process on the same
machine — the worker — whose only real qualification was that it could reach `127.0.0.1`.

Since 0.9.0 the agent does them itself, by being the hands rather than the head:

```
agent  ──POST /api/mcp?worker=step  { id, shot, windows, results }──►  deployment decides (~7s)
agent  ◄─────────────────  { actions: [ … ] }  ─────────────────────
       does them, takes a new picture, posts again
```

One request per step, and nothing reconnects between steps because there is no gap between them: the reply
to one step is what produces the next. The request is deliberately allowed to be slow — that is the model
thinking, not a stall.

- **`shot`** is exactly what `/shot` returns, spliced in whole. **`windows`** is the ARRAY from `/windows`,
  not the wrapper — both agents send the array, because a wrapper on one side is invisible until the model
  is told nothing is open.
- **`results`** is what came of the last `actions`: `{ id, output }`, or `{ id, isError: true, output }`.
  A `wait` answers with NUMBERS — `{ id, quiet, waited, quietFor }` — never a sentence: the wording the
  model reads is composed at the deployment so both agents cannot phrase it differently.
- The answer is one of **`{ actions }`**, **`{ shrink: <width> }`** (that picture was too large to send —
  take a smaller one and ask again; nothing was done, so send no results) or **`{ done: true }`** (finished,
  cancelled, or the job is gone).
- An action is `{ id, kind: "do", body }` — a `/do` line the agent already speaks — or
  `{ id, kind: "wait", ms }`.
- **The deployment closes the job itself** on the step that ends it. An agent must NOT also `?worker=report`
  a run it drove, or it overwrites what the run said. It reports only when it gives up part-way.
- A claimer is given goal jobs only if it says it can take them: `steps: true` in the `?worker=claim` body.
  An older agent goes on not being offered them, which is why the declaration is on the claimer.
- **When a worker and a step-capable agent are both listening, the agent gets the goal.** There is one
  mouse, and both long-poll the same endpoint, so the queue decides rather than the race: a worker is not
  offered a goal while an agent has asked for work in the last 90 seconds, and starts taking them again by
  itself if that agent stops. A machine with only a worker is unaffected.
- **A stop is noticed inside a wait.** A wait can last two minutes, which is far too long for "cancelled" to
  mean nothing, so every third look at the screen the agent also asks `?worker=state&id=`. If the job is no
  longer `claimed` it abandons the rest of the turn and posts what it has; the deployment answers `done`,
  writes the run to the account and clears the row. No answer to that question is not an answer — the next
  step finds out anyway.

Waiting is done at the agent, with the same numbers the app's own loop uses: the 64×36 fingerprint from
`/pulse`, 1.5s between looks, two still frames, and a mean difference above 3/255 counting as movement.
They agree on purpose — "the screen stopped" must not mean two things.

### `?worker=crash` and `/crash-test` — an agent that can say it fell over

An agent runs under launchd, or in a window, on somebody else's computer. Until 0.9.0 the only trace of a
fault was a line in a log nobody opens. Both agents now report through the ACCOUNT — `POST
/api/mcp?worker=crash` with `{ type, message, where, level, platform, version, stack }` — and not to Sentry
directly. That is the design, not a shortcut: the agent already dials the deployment with a device token, so
it needs no DSN of its own inside a program people download, and what arrives is already attached to an
account and to a build.

Three rules, both implementations:

- **Once per process per thing.** A hook that will not install fails every time it is tried.
- **Silent when unpaired.** No account, nowhere to send it, nobody to attach it to.
- **Never blocks, never throws, ten-second timeout.** The courier waits ninety seconds because it
  long-polls; a crash report that held a thread that long would be a second fault.

What cannot travel this way is a failure whose cause is *cannot reach the deployment*. That stays in the
agent's own log, and saying so is part of the contract.

`POST /crash-test` sends one event on purpose and WAITS for the answer: `{ ok, reported }`, where
`reported` is true only if Sentry itself took the event. 409 when the machine is not attached to an
account. Fire-and-forget is right for a real fault and useless for a test — "sent" would mean "handed
to a socket", which is exactly the answer that lets a silent reporter live. It exists because a real fault cannot be arranged on demand, and "we would have
heard about it" is exactly the assumption that lets a silent reporter survive for months.

### The capability flags

The `can*` flags exist because a version number could not answer the question that mattered. An
agent started before the click resolver existed and one started after it reported the same `0.5.0`, and the
difference was the whole transcript — a list of coordinates against a list of named actions. So each
capability is stated: `canSee` (screenshots), `canWindows` (`/windows`), `canName` (`#ctx` on a click),
`canAnchor` (the window and element rectangles on that line - see "`#ctx` — where a click landed"),
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
action=click x=1074 y=159 name=Netflix
action=move x=400 y=300
action=scroll x=400 y=300 amount=-3
action=type text=hello there
action=type enc=b64 nl=shift text=<base64 UTF-8>
action=key key=Enter ctrl=0 shift=0 alt=0
action=activate title=Outlook
action=activate process=outlook
```

Ten more arrived between 0.10.0 and 0.12.0, and both agents carry all of them from 0.16.0:

```
action=capture scale=1 ox=0 oy=0 [process=chrome] [title=Inbox]
action=capture x=100 y=100 w=400 h=300
action=clipread
action=clipwrite enc=b64 text=<base64 UTF-8>
action=open url=https://docs.new
action=open app=Google Chrome
action=read scale=1 ox=0 oy=0 [process=finder] [title=Documents]
action=find scale=1 ox=0 oy=0 [process=finder] title=<the name to look for>
action=scrollto scale=1 ox=0 oy=0 [x=400 y=300] to=end | to=start | to=<name>
action=drag x=100 y=100 tx=400 ty=300
action=refresh [process=chrome] [title=Inbox]
action=waitwindow ms=20000 until=appears|disappears [process=chrome] [title=Save]
```

`scale`, `ox` and `oy` are **the model's coordinate system, sent inward so answers can come back out in
it**. Every other coordinate on this wire has already been converted from screenshot pixels to screen
pixels by the caller, in one place, so nobody can forget the origin — which on a second monitor to the left
is negative. The four actions that answer WITH coordinates travel the other way, and they apply the same
formula in reverse: `shot = (screen - o) * scale`. The alternative is a conversation with two coordinate
systems in it, and a wrong click on any scaled screenshot.

Note the fields each one spends its free text on. `find` takes the **name** in `title=`, not a window
title — the wire has exactly one field that may contain spaces, and `find` spends it on what it is looking
for; narrow the window with `process=` instead. `scrollto` reads `to=` as a plain token, so a multi-word
name is trimmed at the first space.

Parsing rules that matter, both of them learned the hard way:

**`mods` — the modifiers a gesture was made with.** `mods=Shift`, `mods=Cmd+Shift`, `mods=Alt`: a `+`-joined
token list in a fixed order — `Cmd`, `Ctrl`, `Alt`, `Shift` — spelled as a keyboard chord already spells
them. Absent means none were held; never written empty. An unknown token is data rather than an error, like
every other value here.

`Ctrl` in this value is the **literal Control key**, and that deliberately differs from `ctrl=` in the
action grammar, where it means the command modifier because the grammar was written on Windows. This value
says what a person physically held: a Control-click on macOS opens a context menu, and replaying it as a
Command-click performs a different gesture and reports a clean run. The known cost, said out loud: a Windows
recording of Ctrl-click (multi-select) replays on macOS as Control-click. There is no correct translation
without knowing which platform wrote the line, and the body does not say. Live from 0.23.0, when Windows
started writing the field — before that the cost was one-directional and theoretical.

`Cmd` is **the platform's system modifier in that position**: Command on macOS, the Windows key on Windows.
A token has to mean the same KIND of key on both sides or a recording does not survive crossing platforms,
and Windows has no Command to name. The reader on each side maps it to its own: `maskCommand` there, VK_LWIN
here.

**How the modifier is applied on replay differs between the platforms, and only one of them is free.** On
macOS the flags ride on the posted event and that is *sufficient* — measured, with a window reporting the
`NSEvent.modifierFlags` it saw: an event sent with flags only was indistinguishable from one sent with the
key physically held. So no key is pressed there. A Windows `MOUSEINPUT` has **no field for a modifier**:
`SendInput` cannot say "with Shift", so the only way to make a click a Shift-click is to hold the real key
down — which is global machine state rather than a property of the event. Three consequences for anyone
implementing this on a third platform, all of them found the hard way on one of these two:

- whatever is already held has to be released **first**, or a foreign latch is *added* to the gesture: a
  Shift-click under a stuck Ctrl is a Ctrl+Shift-click, and it reports success;
- what was pressed has to be released when the gesture closes **and** unconditionally when the replay ends,
  or a modifier outlives the run — invisibly, changing every keystroke the person makes next;
- the release order is not free either. Windows releases the modifier **after** the button, because a
  button-up that arrives without Alt ends an Alt-drag as a move rather than a copy; macOS releases it
  first, because its button-up carries its own flags and is unaffected.

**`near` and `side` — where a step was, when saying what it was did not work.** `side=below`
`near=Address Bar`: the label of the nearest **control** and which side of it the point fell on — `in`,
`above`, `below`, `left`, `right`. Written only on a step with no `control`, which is either a name the tree
never gave or a name dropped for being content.

It is never what was clicked, and that is why it is two separate keys rather than a fallback value in
`control`: a reader who finds a name in `control` concludes the click landed on it, and a replay aims by
`control`. Neither must happen here.

**Why not simply look harder for a name.** Measured on a live Chrome window: under the pointer is an unnamed
group, the first named ancestor is the document title, and the only named element *containing* the point is a
`Text` node carrying the paragraph the person is reading. Raising the search limits would start recording
content — which is the leak the name-length rule exists to prevent. So the search looks for something
else: a **landmark**, and the set of control types that may serve as one is measured rather than chosen
(twelve live windows; `Text`, `ListItem`, `DataItem` and `Group` are excluded because their short examples
look like labels and their long ones are somebody's text). Two further rules, both from the same
measurement: a name that repeats within the window is not a landmark (`Header` appears five times, `Select a
message` on sixteen checkboxes), and an element larger than a quarter of the screen does not localise
anything.

**Only on a button-down and on a scroll.** Not on a movement, not on a release, not on a key. Not for file
size: a per-move sample of global keyboard state, intersected with the per-keystroke timeline this format
already stores, recovers the shift-and-compose mask of text the format promises not to keep. A release needs
none because a replay holds the modifier from the press to its pair; a scroll carries its own because it has
no pair. What this does not catch, said rather than left to be found: a modifier pressed or released
*mid-drag* is not recorded.

**A `#ctx` line may carry `mods` and nothing else** — a Command+scroll is never sent for name resolution at
all. Every guard that decides whether such a line exists has to allow for it.

- `text=`, `title=` and `app=` take **the rest of the line**, unsplit — they contain spaces. The macOS
  agent adds `name=` to that list, because it is the half that reads the click label; the Windows agent
  ignores the field, so there is nothing there for it to split. Whichever marker comes first wins the rest
  of the line, so no two can both claim it.
- A missing entry in that list is not cosmetic. `app=` was absent on the macOS side until 0.16.0, so `open
  app=Google Chrome` arrived as "Google" — an application nobody has — and `open app=Terminal -e whoami`
  arrived as a bare "Terminal" and **opened it**, walking straight past the refusal in the same file that
  exists to stop exactly that. Found by running it, not by reading it.
- `name=` is what the caller believes it is clicking, in the words on screen, and it is a HINT rather than a
  target: hit-test the point, and only if something else is under it, look for that name nearby. A coordinate
  read off a downscaled screenshot is a point; a name is the thing. They part company the moment anything
  re-lays-out, which a tab strip does every time the number of tabs changes.
- A field marker only counts at the **start of a token**, or `subtitle=` matches `title=` and the parse
  begins four characters into the wrong word.
- `enc=b64` carries UTF-8 base64 so multi-line text survives. `nl=enter` presses Enter between lines,
  `nl=shift` presses Shift+Enter — which is the difference between sending an email and typing a paragraph
  into one. Give the application a moment after a line break; typing straight through loses characters.

**Report failed injection.** The Windows agent originally ignored the return value of `SendInput`, so input
that never arrived was reported as success and the model built its next decision on a lie. Whatever your
platform's equivalent is, check it, and say what went wrong: on Windows, error 5 means an elevated window
owns the foreground and error 0 means the screen is locked.

### What an action answers with

`{ id, output: "done", moved: true | false | null }`. `moved` is the 64×36 fingerprint compared either side
of the action, taken **after** the 350 ms the agent already waits — compared before it, every action is
judged before the screen has had a chance to react and all of them look inert.

It is a **fact, not a sentence**: the wording the model reads is composed at the deployment, the same rule
the wait follows, because two agents phrasing this differently teach the model two different habits. `null`
means the fingerprint could not be taken, and "could not tell" is not "did not move" — the deployment reads
it as an ordinary `done`.

Why it exists: a run spent a minute renaming a spreadsheet through ten actions, none of which landed,
because the caret was never in the field. `do` has no return value and never has, so the only evidence was
the next screenshot. Some actions correctly change nothing — a copy to the clipboard, a click on something
already selected — so this is reported as an observation and the reading is left to the model.

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

`/shot` returns a base64 picture sized to a megapixel budget rather than a fixed width — a vision payload
is priced in pixels. `format` is a **full MIME type** — `image/jpeg`, quality ~85 — and not an extension:
the client hands it to a model request verbatim, where anything but `image/jpeg`, `image/png`,
`image/gif` or `image/webp` is a 400. This line used to say `'jpeg'`, the second implementation
followed it, and generating a flow answered 400 on that machine until somebody tried it. `?w=` is the client asking for less after an upstream
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

`Focus` — **the foreground window changed**, either because a different application came forward *or
because the same one changed what it is showing.* Not an action; a marker saying the work moved, so a step
that hit-tests nothing can still be placed.

The second half arrived at 0.9.5 and is the reason a transcript can now say where a link led. A browser
navigating from one page to the next keeps the same window and the same process, so nothing fired: a
recording could name the link that was clicked and never the page it opened, and a run that ended on a
search results page ended, as far as the transcript knew, on the page before it.

So the title is watched too, on two clocks and never on the tick. It is read at most every **400 ms** — on
macOS the question is an accessibility round trip, and the resolver polls sixty-six times a second — and a
title that differs must still be saying the same thing **700 ms** later before it is marked. A page in
flight shows two or three titles on the way to the one it keeps, and marking each would put places in a
recording that nobody visited. An application change is never delayed this way: that one is a fact the
moment it happens. It is the only per-step answer for a scroll, a wait or a run of
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
pointer), `type` (its control type), `url` (the page it landed on, when it landed on one). Unknown keys are
ignored rather than being an error, so an agent may add one; a value that is empty is the same as absent.

**And the anchor: `wx wy ww wh` for the window, `ex ey ew eh` for the named element**, in screen pixels, at
the moment of the click. Eight integers, written by an agent that says `canAnchor` in `/health`, and the
point of them is one sentence: a recorded coordinate is true until the window moves.

```
#ctx	app=OUTLOOK	window=Inbox — Outlook	control=Send	type=button	wx=1000	wy=100	ww=1200	wh=800	ex=1050	ey=140	ew=60	eh=30
7 | 1074 | 159 | 240 | Left Click Down
```

Both agents already aim by NAME on a replayed press, and that was not enough on its own: the aim starts from
the recorded point, and after the window has moved the recorded point is inside a different window, where the
name is never among the neighbours. With the anchor the client puts the point back **inside the right window**
first (`api/_anchor.mjs`, and the app does it before it sends the body) and the agent's own aim then takes it
to the control. Two levels, each where the data for it is.

Rules, and they are the same two rules the rest of this line follows:

- **Read on the work that is already happening.** The window rectangle comes from the window manager
  (`GetWindowRect` on Windows, the `CGWindowList` entry that already answered "which window is under the
  point" on macOS). The element rectangle comes from the hit test that produced `control` - UIA's
  `BoundingRectangle`, AX's position and size. **No second traversal**: the ban on walking the tree on the
  input path applies here exactly as it does to naming.
- **The rectangle belongs to the element whose name was recorded**, not to whatever the point landed on. A
  replay looks the name up; measuring something else would describe a different thing. It is written only
  when the name was actually kept - a name dropped by the length rule is content, and there is nothing to
  look up.
- Absent means not measured. An older agent writes neither pair, and a replay then plays the recorded point
  and **says so** rather than pretending it re-anchored anything.

**`url` is origin and path only, and the cut happens in the AGENT.** A query string is where a session token,
a one-time sign-in link and whatever somebody typed into a search box live. Everything past the agent copies
the payload around — it is pushed to the account, handed to a model, written into files people download and
forward — and a value that never entered the recording cannot leak from any of them; cutting it later would
mean every one of those paths had to remember to. Read it off the element that actually has one (`AXWebArea`
and its UIA equivalent) on the walk that is already looking for a container, never as a second traversal.

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
- One bounded amendment to "never walk the tree", and it now applies on **both** platforms: when the climb
  comes back nameless, a **frame-checked descent to the point** is permitted. Only children whose rectangle
  contains the point are opened, so this follows a path down rather than sweeping a subtree - which is what
  the rule forbids and what costs seconds. It runs only after every cheaper answer came back empty, so it
  cannot make a step that is named today any worse.

  The bounds and the tie-break differ per platform, because the thing each was written for differs:

  **And a second amendment, on the same rule, measured in 0.11.0.** The 0.6-4.4s figure is about a
  RECURSION FROM THE AGENT'S PROCESS - GetFirstChild, GetNextSibling, one cross-process call per element -
  and it is still true: an uncapped ControlViewWalker recursion over a 241-element window measured 347ms
  here and grows with the tree. A single `FindAll(TreeScope.Descendants, ...)` with the condition on the
  PROVIDER's side is a different call: it walks its own tree in its own process and answers once. Measured
  across eighteen real top-level windows - dbForge, Outlook, Teams, Chrome, File Explorer, an Electron app -
  it ran 0-319ms, and a full `read_window` including the property reads is 570-850ms once the four wanted
  properties are asked for with a `CacheRequest` (2.0-2.7s without one: reading them afterwards is a
  cross-process call per property per element). So a model-requested lookup is permitted; a per-click one is
  still not.

  Two things that only a measurement would have told you, and both are in the code:
  - **An application can stop answering entirely.** dbForge answered this call in 187ms one hour and not at
    all the next, from any thread. So every search has a deadline, the window that missed it is muted for a
    minute rather than asked again, and at most three may be outstanding.
  - **A global lock is the wrong fix for the leaked thread.** The first attempt used one, and a single hung
    application then refused reads of every OTHER window for the rest of the session. Mute by handle.

  | | macOS (since 0.9.3) | Windows (since 0.9.9) |
  |---|---|---|
  | depth | 4 levels, plus 2 steps back OUT and down again | 6 levels |
  | per level | 60 children scanned, 3 smallest containing kept | 40 children scanned, every containing one opened |
  | winner | first name found, depth first | smallest named rectangle overall |
  | written for | Chromium's tab strip | the Windows 11 taskbar |

  Chromium hit-tests a tab to an unnamed group covering the whole strip, with the tab three levels below -
  and one of that group's twins has no children at all, which is why macOS also steps back out. Windows 11
  answers a taskbar click with `Shell_TrayWnd`, the entire 1920x48 window, and keeps the button four levels
  down inside a XAML island the shell's HWND provider will not hit-test into. **Smallest-rectangle rather
  than first-found is the measured part**: `Shell_TrayWnd` lists a leftover `ReBarWindow32` before the
  island, and it has a named child - "Running applications" - so depth-first returns the strip and stops one
  step short of the icon. Cost measured over every taskbar button, the tray, Start and the clock: 32
  elements read, 37 ms warm, 153 ms on the first call of a session.
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

**`#ctx` travels with a replay too, and aiming by it is the difference between opening the tab you recorded
and opening whichever tab is now at those coordinates.** The lines above an event are the same ones a
recording carries, so nothing new has to be parsed - and a replay that has them should hit-test the point
before pressing, and when the thing under it is not the one named, look for that name among the siblings of
whatever IS under it. One level, not a tree walk: the protocol forbids walking on the input path because it
costs seconds, and the same arithmetic applies here - but a re-laid-out row of tabs, buttons or list rows
keeps its neighbours exactly there, which is the case that fails.

Two rules make it safe. Aim only on the PRESS, and let the release follow wherever the press went - releasing
at the recorded coordinate after pressing somewhere else turns one click into a drag across the window. And
count the corrections, reporting them as `retargeted` on `/replay/status` — and, since 0.27.0, `switched`:
how many presses on the taskbar were played as **show that window** rather than as a click. A taskbar button
toggles — it raises a window that is behind and *minimises* one that is in front — so a recorded "raise"
replayed on a window the client has already raised minimised it, and every click after that landed on
whatever was underneath. The agent recognises the taskbar by the class of the top-level window under the
press (`Shell_TrayWnd`, `Shell_SecondaryTrayWnd` — a class, not a button caption, which depends on the system
language), reads which window the press brought forward from the `Focus` line the recording itself wrote right
after it, and calls the same idempotent `Activate` the `/do` route uses — **by title only**, never by process,
because matching by process would hand back the first window of that process, which in a browser is as
likely to be MouseFlow as the one wanted. Its own console is refused exactly as in `/do`. Anything that does
not line up — no `Focus`, no such window, a refusal — plays the press as recorded; the release of a press that
was switched is skipped, because a release with no press is an event in its own right (below). On macOS a Dock
click of the frontmost application does not minimise it, so the Dock needs no translation.

**A replay ends by releasing what it held, not every button (0.27.0).** The finish used to send
`MOUSEEVENTF_RIGHTUP` unconditionally, and Windows turns `WM_RBUTTONUP` into `WM_CONTEXTMENU` with no press
required — so every replay ended with the browser's context menu open at the cursor's final position. It was
reported from a run and visible on the screenshot; the recording itself held no right click. `Emit` now marks
each button it presses and clears the mark on its release, and the finish releases the marks. The macOS agent
had always done this (`holding = down`), and it is the case where the two should have been compared sooner.
Counting: a replay that quietly moved where
it clicked is a replay whose report cannot be trusted.

**Abort must be immediate and must release what it holds.** Check the stop flag before every event *and*
inside every sleep, and release every held button and key on every exit path, including the failure paths —
a replay that dies holding the left mouse button leaves the machine unusable. The Windows agent also honours
a held ESC as a hardware-level escape hatch, which is worth copying.

## Saying, on the machine itself, that the machine is being driven

**Since 0.22.0 the agent draws a border round every screen while something is driving this computer.** A
run starts silently: the pointer moves on its own, a window rises, text appears in a field. The person
sitting at the machine used to learn about it by discovering that the mouse had stopped obeying them —
which is the moment they are already fighting the run and the run is already fighting them. A page in a
browser on another monitor is not an answer to that, and a courier run arrives from the account with no
browser open at all. So it is said here, on the screen being driven.

`/health` reports the same fact as `acting`: a list of who is driving, empty when nobody is. It exists so
the behaviour can be checked from outside without looking at the screen, and so a person can ask "is that
the agent moving my mouse, or is something broken".

**Three drivers, and only two of them have edges.**

| driver | lit from | until |
|---|---|---|
| `goal` | the courier claims a goal job | `drive()` returns, on every exit path |
| `replay` | a replay begins | the same `defer` that releases held buttons |
| `action` | any action begins — **inside `doAction`**, not in the `/do` route | a short lease, refreshed by each action |

**The lease belongs in `doAction`, not in the `/do` route**, and that is a correction rather than a
preference. `doAction` has three callers: a step of a goal run (already held by `goal`), the `/do` route,
and the courier's `carry`, which performs the action in a claimed job's `activate` field *before* starting
the replay. Put in the route, the third one held nothing: a window was brought to the front — the real jump
`SetForegroundWindow` makes — with no border on any screen, while `/health` answered that nobody was
driving. The start of an action is `doAction`, the one place all three pass through.

`action` is a lease and not a hold because **the browser driver never tells the agent that a run is
happening.** What the agent sees is `/shot`, `/windows`, then up to 75 seconds of silence while the model
thinks, then `/do`. So on that path the border lights per action and goes out a few seconds after the last
one — it pulses through a run rather than burning steadily. This is an honest limit, not an oversight: a
lease long enough to bridge a model turn would make "lit" accurate and "out" a lie for a minute and a
quarter after the run had finished, and an indicator that lies *after* the end is worse than one that
blinks. It becomes steady when the driver says where a run starts and stops, which is an addition to this
document and a change to the client, not something an agent can infer.

**A second implementation must clear the same six traps.** The first four were measured rather than
reasoned about; the last two were found by auditing the first implementation of the second agent, and both
were real. These are the ways an agent's own window breaks the agent:

- **The window list must not contain it.** `/windows` and the click resolver both drop anything whose layer
  is not a normal application window; on macOS a window at `CGShieldingWindowLevel()` reports layer
  2147483628 and is dropped with no filtering added. An implementation whose overlay lands in `/windows`
  has given the model a full-screen target to aim at.
- **Clicks must pass through it.** macOS: `ignoresMouseEvents`. Windows: `WS_EX_TRANSPARENT`. Measured with
  a synthetic click posted at a point covered by the border, onto a window underneath.
- **It must not take focus.** Raise it without activating (`orderFrontRegardless`; `WS_EX_NOACTIVATE`), or
  the run's next keystroke goes to the border instead of the field it was aimed at.
- **It must not appear in the agent's own screenshots.** Two locks, deliberately: the window is marked
  unshareable (`NSWindowSharingType.none`; `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`), *and* the
  agent excludes its own windows from the capture filter. Measured on macOS with a second, independently
  permissioned agent as the camera and a positive control built with sharing left on: the control moved the
  outer ring of the 64×36 fingerprint by +11.89/255, the shipping build by +0.02. Where the platform cannot
  do this at all, the `action` driver must not light the border — see the note on stillness below.
- **It must follow the screens.** The set of borders is built when the border goes up, and a goal run lasts
  minutes: a monitor docked, unplugged or re-resolutioned mid-run leaves the new screen unmarked and the old
  one carrying a window sized to bounds that no longer exist. Subscribe to the platform's screen-change
  event (`NSApplication.didChangeScreenParametersNotification`; `SystemEvents.DisplaySettingsChanged`) and
  rebuild while lit.
- **It must not depend on a decoration.** The Windows border first lived on the tray's thread, ninety lines
  into a `try` whose `catch` exists precisely to swallow a tray that will not draw — and was skipped
  entirely by `-NoTray`, whose own documentation promises the HTTP half is identical either way. Both meant
  the machine fully drivable with nothing on screen saying so, while `/health` still answered
  `acting:["goal"]`. A safety indicator that can be silently absent is worse than none, because `/health` is
  how the absence would have been noticed. Give it its own thread and start it unconditionally.

**And it must not move.** No pulsing, no breathing, no animation. The 64×36 fingerprint that both sides use
to decide "the screen moved" and "it has settled" compares two consecutive frames: a still border subtracts
from itself and means nothing, while a pulsing one would mean the screen is always moving — every wait
would sit out its full limit and every action would report that it had worked. This is not a decoration
that was declined; it is a decoration that would break the run.

**"Still" is a property of the driver, not only of the drawing**, and this is the subtlety that has to be
said out loud. `goal` and `replay` hold across a whole run, so the border is constant through every
comparison inside it. `action` does not: its lease is six seconds and a model turn is eight to fifty, so on
the browser-driven path the border is *out* when the driver takes its `before` fingerprint and *up* when it
takes `after` — it animates across the one comparison that decides whether an action did anything, on every
turn. That is harmless only because the border is excluded from capture. Where it cannot be — Windows older
than 10 2004 has no `WDA_EXCLUDEFROMCAPTURE` — the `action` driver must not light it at all: a border that
breaks the run it is warning about is worse than no border, and `goal` and `replay`, which cannot animate,
still show one.

The colour is the product's own accent (`#bdff7a`), not red: this is not a failure and not a system alert.

## Who may talk to the agent

**The origin is checked, and until 0.9.7 it was not.** This section used to say authentication was "none",
that `-AllowOrigin` defaulted to `*` and was "only echoed as a response header, never used to reject", and
that a new agent should leave a seam and wait for a design. That reading cost the whole machine: a listener
on 127.0.0.1 that carries out `action=key`, `action=type` and `action=click` will do so for **any page open
in the user's browser**, because CORS stops a page *reading a reply*, not a request being sent and executed —
and a keystroke needs no reply. A page in Safari or Firefox could open Spotlight, type a shell command and
press Return.

Enforcing the pin was never a new scheme. It is the scheme both agents already shipped, already documented
and already reported on `/health` as `originPinned`; the only thing missing was the `if`.

The rule, identical in both agents (`originAllowed` in Swift, `OriginAllowed` in C#), applied **once, before
routing** — never per route, so a route added later inherits the check rather than forgetting it:

| Request | Verdict |
|---|---|
| No `Origin` header | **allowed** — not a browser (curl, `mcp/worker.mjs`, node fetch). A page cannot omit it; the browser sets it. A local process could, and a local process can already read `account.json` and press keys itself. |
| Pin set, `Origin` equals it | allowed |
| Pin set, anything else | **403**, and no CORS headers on the reply |
| No pin, `Origin` is one of the product's own | allowed |
| No pin, `Origin` is loopback (`localhost`, `127.0.0.1`, `::1`, http or https, host compared whole) | allowed — this is `npm run dev` |
| No pin, anything else | **403** |
| Pin is `*` | allowed — the check is off, and the banner says so |

**Default is not `*` any more.** An agent started with no arguments answers the product's own pages and
loopback. `*` still means "do not check", but it has to be asked for.

**Autostart needs an explicit pin** on both agents — not merely a default. Installing a KeepAlive job that
survives logout is a heavier decision than answering a request, so the threshold is different: not "a page we
answer" but "an operator who named the page". The Windows agent always required this; macOS now does too, as
the documentation had claimed all along.

**`DELETE` belongs in `Access-Control-Allow-Methods`.** Without it the browser refuses its own preflight and
Detach cannot be pressed at all — the one control that revokes "let my AI drive this PC" was unreachable
while the agent stayed attached.

What remains true, and is the reason this is a threshold and not an authentication scheme: **any process on
the machine** can still POST `/do`. That is not something an origin check can address, and a process that far
in has better tools than this port.

## macOS — what the second implementation chose

`agent/mouseflow-agent.swift`, installed by `agent/install-mac.sh`. The notes below were written before it
existed and each one turned into a decision; the decision is recorded next to the note so the next reader
does not re-open a settled question.

**Packaging: compiled on the machine, not downloaded.** A prebuilt binary arrives quarantined and
Gatekeeper refuses an unnotarised one — the user would have to strip the quarantine attribute by hand,
which is worse advice and worse security than the alternative. A binary compiled locally is never
quarantined. The cost is Xcode Command Line Tools, which the installer names in one command if they are
missing. Since 0.8.2 the installer signs with a **Developer ID Application** identity when the machine has
one in its keychain (ad-hoc otherwise, exactly as before) — and then the permission grants survive
rebuilds, because TCC keys the grant to the certificate's stable identity rather than to one build's hash.
A signed AND notarised prebuilt `.app` — no compiler on the user's machine at all — is the next step now
that a certificate exists, and it is a distribution project, not an installer flag.

**It has to be an .app, and that is not packaging taste.** On macOS a bare executable is not its own subject
as far as permissions go: TCC blames the RESPONSIBLE process, which for anything launched from a terminal is
the terminal. So a loose binary gets no Accessibility prompt of its own, never appears in the System Settings
list, and the only way to give it anything is to grant Accessibility to the terminal emulator - a far larger
permission, and one nobody finds. A binary inside a bundle, launched with `open`, is its own responsible
process: it gets a prompt naming itself and a switch of its own. The installer therefore builds a minimal
bundle (a plist, `LSUIElement`, ad-hoc signed over the whole thing) and starts it detached. This was found
the way everything in this file was found: it compiled, it ran, and it could not be granted anything.

**A menu bar item, because stopping must not require a terminal.** On Windows the agent dies with the console
window that runs it; on macOS it is a login item with no window, `pkill` is resurrected by KeepAlive, and
closing the terminal that installed it never owned it - so a user's only way out was a `launchctl` command
nobody knows. The status item (`LSUIElement` is exactly the mode for one) says the recorder exists and offers
the two honest exits: **Stop Until Next Login** (launchd forgets the job for this session, sign-in brings it
back) and **Quit and Turn Off Start at Login** (the login item is removed too). The HTTP loop moved to its
own thread to give AppKit the main one; nothing else changed shape.

**Permissions are the install story, and there are two.** Accessibility for the event tap, for reading any
other application's tree, and for posting input; Screen Recording for `/shot`, `/pulse`, and for other
applications' window TITLES in `/windows`. Both are reported on `/health` under `permissions`, so the
Connections screen ticks them individually and live. A rebuild invalidates the grant — TCC keys on the exact
binary — so the installer says the user may be asked again.

**A grant is not reliably usable until the process restarts, so the agent restarts itself to collect one.**
Verified on a real machine and consistent with Apple's own model: Screen Recording's verdict never refreshed
in a running process (ten minutes, twice), and while Accessibility's sometimes does, a tap that failed to
install while untrusted stays uninstalled —
System Settings offers windowed apps a "Quit & Reopen" dialog for exactly this reason, and an agent with no
window gets nothing. So while a permission is missing, the agent asks a fresh child of its own binary
(`--probe`, one line of JSON from a process young enough to know) every few seconds, plus the TCC store's
mtime as a backstop signal, and when the answer changes it exits cleanly so launchd's `KeepAlive` starts it
again — granted, tap installed, `/health` green, nothing pressed. Never mid-recording or mid-replay, at most
once a minute, and only when the process actually is the launchd job; a `--foreground` run prints an
instruction instead of silently dying. The client needs nothing for this: it was already polling `/health`.

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
