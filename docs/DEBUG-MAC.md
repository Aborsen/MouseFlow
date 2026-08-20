# Debugging the macOS agent

## Start here: get the facts

```bash
bash <(curl -fsSL https://mouseflowapp.vercel.app/agent/install-mac.sh) --doctor
```

One paste, and everything about the install is in it: macOS version, whether the compiler is there, where the
bundle is and what signature it carries, whether the login item registered, whether anything is listening on
the port, the whole of `/health` including both permissions, and the tail of the agent's own log.

Run this before reasoning about anything. The failures on this platform are indistinguishable from outside -
a missing permission, a permission granted to a *previous build*, a login item that never registered, and a
process that is not the kind that can hold a permission at all **all look like an agent that says no**.

## Where the work stands

Written down because a session on this machine has none of the history.

**Verified, on real machines:** the web app and the Windows agent (94 contract checks, plus suites for the
transcript, the sessions, the reconciliation and the gallery). The macOS agent compiles and runs - that took
three rounds of a compiler on a Mac reporting errors this machine could not have found.

**Not verified:** everything the macOS agent does once running. Recording, replay, aiming by name, screenshots
through ScreenCaptureKit, and the accessibility naming have never been observed working. The last known state
is that permissions were granted and the agent still reported no access, which is the stale-grant case below -
but that is a hypothesis until `--doctor` says so.

**The one measurement to compare against:** on Windows 70.8% of recorded clicks carry a control name, and in
Chrome 146 of 151. If macOS is far below that, the accessibility half is broken rather than limited.

**Do not** change `web/src/lib/agent.ts`, `web/src/lib/desktop-engine.ts` or the Connections screen to make
the Mac work. They are shared with the Windows agent and with two other surfaces; `agent/PROTOCOL.md` is the
contract, and if the platform cannot honour something there, change the document in the same commit.

## Moving the work to this machine

A Claude Code session does not travel between machines - the transcript lives on the one that ran it. The
repository does, and it has been kept deliberately self-describing for exactly this: `agent/PROTOCOL.md` is
the contract both agents implement, and the commit messages say why each decision is the way it is rather
than what changed.

```bash
git clone https://github.com/Aborsen/Mouse.git
cd Mouse
npm --prefix web install
```

Then start a session in that directory and give it this as the first message:

> The macOS agent in this repo (`agent/mouseflow-agent.swift`) was written on Windows and has never run
> there. Read `docs/DEBUG-MAC.md` and `agent/PROTOCOL.md` first, then run
> `bash agent/install-mac.sh --doctor` and work from what it says. Do not change the shared client to make
> the Mac work.

That is enough. Everything else it needs is in the two documents and in the commit messages - `git log` on
this repository reads as an account of why each thing is the way it is, which is the part a transcript would
otherwise have carried.

## Installing and running it

```bash
curl -fsSL https://mouseflowapp.vercel.app/agent/install-mac.sh | bash -s -- \
  --origin https://mouseflowapp.vercel.app
```

It fetches the source, compiles it here, wraps it in an `.app`, makes it a login item and starts it. Nothing
to launch by hand afterwards, ever.

For a build you are iterating on, point it at a local copy instead of the deployment:

```bash
python3 -m http.server 8000 --directory .      # serves ./agent/mouseflow-agent.swift
bash agent/install-mac.sh --origin http://localhost:8000 --no-login --foreground
```

`--foreground` runs it in the terminal so its output is visible. Note what that costs: launched as a child of
Terminal it inherits **Terminal's** permissions rather than having its own, which is the whole reason the
installer builds a bundle. Use it to see compiler and runtime output, not to test permissions.

## The three things that go wrong, in the order they go wrong

### 1. It compiles nowhere

The installer prints the compiler's own words and keeps the log:

```bash
cat ~/Library/Application\ Support/MouseFlow/build.log
```

Two errors have already been met and are worth recognising:

- `'CGWindowListCreateImage' is unavailable` - removed in macOS 15. Screenshots go through
  `SCScreenshotManager`, which starts at macOS 14. There is no keeping the old call behind an `#available`;
  referencing it fails to compile at all.
- `the compiler is unable to type-check this expression in reasonable time` - a long chain of `|` over
  `1 << rawValue`. Swift searches every overload of both operators for every term. A list and a loop.

### 2. A permission is granted and does not work

This is the one that wastes the most time, and it is not macOS lying.

TCC stores a grant against the app's **code signature**, and an ad-hoc signature means the binary's cdhash.
Rebuild, and the hash changes: the entry stays in System Settings, still switched on, and the new binary is
not the one it was granted to.

```bash
bash <(curl -fsSL https://mouseflowapp.vercel.app/agent/install-mac.sh) --fix-permissions
```

That resets the entries so macOS **asks again** instead of showing a switch that does nothing. The installer
does it automatically after any real rebuild; you need it by hand only when the state is already wrong.

Manual equivalents:

```bash
tccutil reset Accessibility com.mouseflow.agent
tccutil reset ScreenCapture com.mouseflow.agent
```

### 3. It is running and something is missing

Ask it, rather than guessing. `/health` reports each permission separately, and the two `can*` flags that
follow from them:

```bash
curl -s http://127.0.0.1:8787/health | python3 -m json.tool
```

`canName` follows Accessibility, `canSee` follows Screen Recording. Under launchd the agent's own startup
banner - which says whether the event tap installed, and if not, why - goes to a log:

```bash
tail -f ~/Library/Logs/mouseflow-agent.log
```

## Exercising it by hand

Every endpoint is plain HTTP on loopback, so nothing needs the app to be open.

```bash
# what it is and what it may do
curl -s http://127.0.0.1:8787/health

# record for a few seconds, then read the .mmmacro back
curl -s -X POST 'http://127.0.0.1:8787/record/start?moveMs=250'
sleep 5
curl -s -X POST http://127.0.0.1:8787/record/stop

# a long session: drain and keep recording
curl -s -X POST http://127.0.0.1:8787/record/start
curl -s -X POST http://127.0.0.1:8787/record/drain     # chunk, recording continues
curl -s http://127.0.0.1:8787/record/status            # part increments, clock does not reset

# what is open, and bringing one forward
curl -s http://127.0.0.1:8787/windows | python3 -m json.tool
curl -s -X POST -d 'action=activate process=Google Chrome' http://127.0.0.1:8787/do

# clicking by name rather than by coordinate
curl -s -X POST -d 'action=click x=400 y=48 name=Netflix' http://127.0.0.1:8787/do

# seeing
curl -s 'http://127.0.0.1:8787/shot?w=640' | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["format"], d["w"], d["h"], d["scale"], len(d["png"]))'
```

The two things most worth checking after a change:

- **`format` must be a full MIME type.** `image/jpeg`, not `jpeg`. The client hands it to a model request
  verbatim, where anything else is an HTTP 400 - which is exactly how Create broke once.
- **`scale` must be measured off the picture that arrived**, not off the width that was asked for. It is
  picture-pixels per screen POINT, and a wrong one is every click landing next to its target.

## Are the names coming through?

The single best signal of whether the accessibility half is working. Record a few clicks in a browser, stop,
and look for `#ctx` lines:

```bash
curl -s -X POST http://127.0.0.1:8787/record/start
# click a few things
curl -s -X POST http://127.0.0.1:8787/record/stop | grep '#ctx' | head
```

`#ctx app=... window=... control=Send type=button` above a click is the good case. `app` and `window` with no
`control` in a browser means Chromium has not been asked for its tree - the agent sets
`AXManualAccessibility` lazily on first failure, so if this persists that call is not landing.

Measured baseline to compare against: on Windows, 70.8% of all recorded clicks carry a control name, and in
Chrome specifically 146 of 151. Anything far below that on macOS is a bug, not a limitation.

## Tests that run anywhere

Kept in the repo rather than in a scratch directory, so they work on either machine.

```bash
node agent/test-contract.mjs     # both agents against the one contract in PROTOCOL.md
cd web && npx tsc --noEmit       # the shared client
```

The contract test is the one that matters here: it parses the route table out of `PROTOCOL.md` and asserts
both implementations answer every path, that `/health` carries the same field names, that the event words
match, and that neither reads a key code. It cannot compile Swift - nothing on Windows can - which is exactly
why it checks the things that can be checked without a compiler.

## What is deliberately not there

- **Typed text.** A keystroke is recorded as an event with a timestamp and nothing else. Not a redaction
  design: there is nothing to redact, and that is the point.
- **Multiple monitors, on macOS.** ScreenCaptureKit captures one display, so `/shot` takes the one the
  cursor is on and reports that display's bounds. Bounds checking still uses the union of all displays,
  because a click on the second monitor is a legitimate click even when the agent cannot see it.
- **A notarised app.** There is no Apple Developer certificate in this project. When there is one, a signed
  `.app` is the better answer and the permission grants survive updates - which they do not here.
