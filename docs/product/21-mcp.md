# 21 — MCP: MouseFlow as tools an AI can call

`api/mcp.js`, `api/oauth.js`, `api/well-known.js` and `mcp/`. A fourth client, and the first one that is not
a person. It is what "add MouseFlow to Claude" means: a connector that can read everything the account holds
and — when you have said so — start the recorder on your computer, stop it, and run a skill you made.

There is a page in the product about this, at [`/mcp`](https://mouseflowapp.vercel.app/mcp). It is public,
readable without an account, and it is the thing to send somebody who is deciding whether to connect this.

![The /mcp page](../img/mcp-page.png)

## What is in this document

| | |
|---|---|
| [Connecting it](#connecting-it) | the three ways in, with what you see at each step |
| [What you can ask for](#what-you-can-ask-for) | every tool, its arguments, and what comes back |
| [Skills as tools](#skills-as-tools) | which skills are offered, what they take, which refuse |
| [Who it lets in](#who-it-lets-in) | sessions, device tokens, OAuth; isolation; taking it back |
| [Letting it act on your computer](#letting-it-act-on-your-computer) | the queue, the agent, the consent banner, the switch |
| [What it will not do](#what-it-will-not-do) | the refusals, and why each one is deliberate |
| [Every answer it can give, and what to do](#every-answer-it-can-give-and-what-to-do) | the troubleshooting table |
| [Reference](#reference) | endpoints, headers, protocol versions, limits, environment |
| [How it is tested](#how-it-is-tested) | and what is not covered |

## Two transports, and why both exist

| | The decider is… | The connection |
|---|---|---|
| **HTTPS** — `POST /api/mcp` | anywhere: a phone, a browser, someone else's editor | the client posts JSON-RPC; your computer dials out for the work |
| **stdio** — `mcp/server.mjs` | on the same machine | the client spawns it and talks over pipes |

stdio came first and is the simpler thing: the process is already on the machine, so it can reach the agent
on loopback and run anything. Its limit is that it is one person at one terminal.

HTTPS is the same tools reachable from Claude on a phone, in a browser, in someone else's editor — and
*reachable* is the whole problem, because a serverless function cannot dial into anybody's desktop and
nothing on the internet should be able to. **So the desktop dials out.** A `tools/call` becomes a row in
`run_queue`; the MouseFlow agent on your own machine claims it, does the work through the same code path the
app uses, and reports back; the waiting request answers with what it said. The direction of the connection
never reverses, which is the security property rather than a detail: **no inbound path to anybody's computer
exists at all.**

---

## Connecting it

The address is the same in every case, and it is on **Settings → Connections** in the app so that nobody has
to come here to find it:

```
https://mouseflowapp.vercel.app/api/mcp
```

![Connections, with the MCP address](../img/settings-connections-mcp.png)

![The same address on the connection guide](../img/connect-guide-ai.png)

### 1. Claude, on the web or in the desktop app

The one to use unless you have a reason not to. Nothing is copied and no secret is kept anywhere.

1. In Claude: **Settings → Connectors → Add custom connector**.
2. Paste the address above.
3. Claude registers itself, discovers where to sign you in, and opens **MouseFlow's own sign-in** — Google,
   or your email and password, whichever you already use.
4. You land on a consent page that says exactly what the connector will be able to do:

   ![The consent page](../img/oauth-consent.png)

5. **Allow**, and it is connected. What Claude holds from then on identifies *you*, not the installation.

That last sentence is the whole reason OAuth is here. A team adds one address; each person authorises it
themselves; each sees only their own recordings, their own skills and their own machine.

![The three ways in](../img/mcp-connect.png)

### 2. Claude Code

The same sign-in, from a terminal:

```bash
claude mcp add --transport http mouseflow https://mouseflowapp.vercel.app/api/mcp
```

Then `/mcp` inside Claude Code and choose to authenticate — a browser opens on the same consent page.

### 3. A device token, where there is no browser

CI, a headless box, or a client that cannot do OAuth. **Settings → My account → Pair a device** mints one;
it begins `mf_`, and it is shown once because only its hash is stored.

![Pair a device](../img/settings-account-token.png)

```bash
claude mcp add --transport http mouseflow https://mouseflowapp.vercel.app/api/mcp \
  --header "Authorization: Bearer mf_your_token_here"
```

Never put a token in the URL — the MCP authorization specification forbids access tokens in a query string,
and this server does not read one from there.

A device token identifies an **installation**, not a person, which is exactly why a connector an
organisation installs once for everybody should not use one: everyone behind it would share a single
account. That is one tenant with many users rather than many tenants, and it is the failure OAuth exists to
prevent.

### 4. stdio, on your own machine

```bash
claude mcp add mouseflow --env MOUSEFLOW_TOKEN=mf_your_token_here \
  -- node /absolute/path/to/Mouse/mcp/server.mjs
```

Anything that reads a configuration file — Claude Desktop, an editor extension:

```json
{
  "mcpServers": {
    "mouseflow": {
      "command": "node",
      "args": ["/absolute/path/to/Mouse/mcp/server.mjs"],
      "env": { "MOUSEFLOW_TOKEN": "mf_your_token_here" }
    }
  }
}
```

This half needs **Node 22.18 or newer**: it runs the app's own TypeScript modules rather than a compiled
copy of them, which needs a Node that strips types. `mcp/shared.mjs` says why in full.

### What connects, and what does not, at each stage

| You have… | Reading works | Recording and running work |
|---|---|---|
| the connector added | **yes**, immediately | no |
| …and the agent installed | yes | no — it is not attached to your account |
| …and the computer attached | yes | **yes** |
| …and the agent's switch off | yes | no — jobs queue and say so |

Reading answers from the account, so it works with your computer asleep, off, or somewhere else entirely.
This is not a subtlety worth discovering later: the two halves fail in completely different ways, and a
connector where half the tools work looks like an intermittent fault rather than a design.

---

## What you can ask for

Nine built-in tools, plus one for every skill on the account.

![The tools, on the product page](../img/mcp-tools.png)

### Reading — nothing has to be running

A recording, a run and the time it took are rows on the account. Metadata and prose only: **there is no
tool that hands over raw events.**

| Tool | Arguments | What comes back |
|---|---|---|
| `mouseflow_recordings` | `kind`: `all` \| `recording` \| `skill` (all) · `limit`: 1–200 (50) | One line per row: id, name, what it is, where it came from, event count, the applications it happened in, the date, and its description. Newest first, and it says how many of how many are shown. |
| `mouseflow_transcript` | `recording`: id **(required)** · `steps`: 1–400 (120) | The recording as prose steps, grouped by the place they happened, from the same `transcribe()` the app's own panel uses — plus, at the end, **what the recording cannot answer**. Truncation is stated rather than silent. |
| `mouseflow_runs` | `days`: 1–365 (30) · `outcome`: `any` \| `ok` \| `failed` \| `stopped` · `limit`: 1–200 (50) | When it started, how it ended, how long it took, what kind of run it was, which model drove it, the goal, and the error if there was one. |
| `mouseflow_activity` | `days`: 1–365 (30) | Totals for the window: recordings and skills made, events between them, runs by outcome, minutes of running time, and the applications the work happened in. It also says the numbers are counted from what the account holds *now*. |

`mouseflow_transcript` is the same derivation you can read yourself in the app, which is the point —
the model is not given a different account of what happened than you are:

![The transcript panel](../img/record-transcript.png)

### Doing — your computer has to be listening

| Tool | Arguments | What it does |
|---|---|---|
| `mouseflow_start_recording` | `moveMs`: 0–1000 (0) | Starts the recorder on the attached machine — the same timer the Record page shows. `moveMs` is how coarsely to sample pointer movement; 0 keeps every sample, 40 is plenty for a long session and keeps it small. |
| `mouseflow_stop_recording` | — | Stops it and saves what was captured to the account. Answers with the name it was given, its id, the event and click counts, and the applications it happened in. |

They are two tools rather than one with a boolean because **stop** is the one somebody reaches for in a
hurry, and a tool that could start a recording when they meant to stop one is a bad trade for one fewer
entry in a list.

What a stop looks like from the other side, verbatim:

> Saved as "MouseFlow 22/08 13:10:16" (r3ft71w43): 46 events, 12 clicks, in MouseFlow, YouTube Music.
> Nothing about what was typed is in it, by design.

### The machinery itself

| Tool | Arguments | What it answers |
|---|---|---|
| `mouseflow_status` | — | How many skills the account holds and how many run on a desktop rather than in the extension; whether a machine has asked for work lately and how long ago; anything queued or running; how many rows are **not** offered because they are unstamped; and, plainly, that it cannot see the agent itself. |
| `mouseflow_stop` | — | Cancels everything queued or running for this account. Safe when nothing is happening. A run already under way stops at the next step its claimer checks, which is a second or two. |
| `mouseflow_run_status` | `run`: the id an earlier answer named **(required)** | Whether it is still queued, being worked on, or finished — and what it said. |

`mouseflow_status` is the one to ask first when something did not happen. It is written to distinguish the
three states that look identical from a chat: no machine has *ever* asked for work, no machine has asked
*recently*, and this deployment cannot tell.

---

## Skills as tools

A skill on an account is already the same shape as a tool call: a named, described unit of work with the
variable parts pulled out of it. `api/_skill-schema.mjs` is the one derivation, and **three things read it**
— the Skills page, the stdio server, and `/api/mcp`. So what a model is told about a skill and what you can
read about it are the same sentence, by construction.

You can see the exact JSON in the app: **Skills → ⋯ → Structure**, then the **MCP** tab.

![A skill's MCP tool definition](../img/skills-structure.png)

| | Offered as | Arguments |
|---|---|---|
| **Recorded** skill | one tool | `repeat` (1–999) and `speed` (0.5, 1, 1.5, 2, 4) — the two knobs `flowBody` really has |
| **Created** skill (a goal in words) | one tool | the parameters its goal declares. A parameter with no example the author left behind is **required**, so a call with a hole in it is refused by name rather than run with a guess |
| **Extension** skill | listed, and refuses | it aims at elements in a web page, and the extension is the half that can replay it |
| **Unstamped** row | **not offered** | see below |

The wizard on the Record page is where a recorded skill gets the context a replay cannot carry — because
keystroke content is never stored, the skill has to be *told* what went into each field:

![The skill wizard, step one](../img/record-skill-wizard.png)

![The skill wizard, step two](../img/record-skill-wizard-2.png)

**Unstamped rows are deliberately not offered.** The Skills page lists a row with no `payload.role` *as* a
skill so that nobody's library empties ([06 — Skills](06-skills.md)). That default is right for a page
somebody reads and wrong for a tool list, which is read by something that will **call** what is in it.
`mouseflow_status` reports the count, so nothing goes missing silently; saving the row again in the app
stamps it.

---

## Who it lets in

Every request resolves **one** user, and every query filters on that id inside its `WHERE` clause. There is
no route here that takes a user id and no code path that reads one from a body or a query string. That is
not defensive habit: the thing calling these tools is a language model, and a model-supplied user id is the
whole bug class — one hallucinated uuid and this becomes a way to list, or run, somebody else's skills. The
test asserts it from the source rather than trusting the reading.

![Who it lets in, on the product page](../img/mcp-identity.png)

### Three ways to be somebody

| | Presented as | Used by | Identifies |
|---|---|---|---|
| **Session** | the site's own cookie | the app in a browser tab | the person |
| **Device token** | `Authorization: Bearer mf_…` | the extension, a CLI, the stdio server, CI | the installation |
| **OAuth access token** | `Authorization: Bearer …` | an MCP connector | the person |

`api/_session.js` tries them in that order of certainty: a device token is unambiguous because it carries
our prefix and answers from our own table; an OAuth token is ours too and also answers locally; the session
is last, because verifying it is a network hop to the auth service.

### Why MouseFlow is its own authorisation server

The hosted auth service behind `/api/auth` is not ours to add plugins to, so an OIDC provider cannot be
switched on there. What *is* ours is the session it issues. `/api/oauth?do=authorize` is an ordinary page
behind this app's ordinary sign-in wall; once somebody is through it, saying "this client may act as me" is
a row in a table. **The authentication stays entirely theirs. Only the consent and the token are ours.**

### The flow, in the order it happens

1. The client posts to `/api/mcp` with no token and gets **401** with
   `WWW-Authenticate: Bearer realm="MouseFlow", resource_metadata="…"`.
2. It reads `/.well-known/oauth-protected-resource` (RFC 9728), which names the authorisation server.
3. It reads `/.well-known/oauth-authorization-server` (RFC 8414), which names the endpoints.
4. It registers itself at `/api/oauth?do=register` (RFC 7591) and gets a `client_id`. No client secret —
   nothing here can keep one.
5. It sends the person to `/api/oauth?do=authorize` with PKCE. Not signed in? They are sent to `/sign-in`
   and brought back afterwards.
6. They approve — a **POST from a page they looked at**, so a link cannot authorise anything on its own —
   and a single-use code goes back to the client's registered address.
7. The client exchanges the code plus its verifier at `/api/oauth?do=token` for an access token and a
   refresh token.

### What is enforced, and what is refused

| | |
|---|---|
| PKCE | **required**, and `S256` only. No `plain`. A public client cannot keep a secret, so the verifier is the whole of what proves the token request came from whoever started the flow |
| `redirect_uri` | matched by **exact string** against what the client registered — never by prefix or host. A prefix match is how `https://good.example/cb` comes to accept `https://good.example/cb.evil.test` |
| Codes | single use, and burnt **before** anything is checked against them, so a replay racing the first exchange cannot mint a second set of tokens |
| Refresh tokens | rotate: the old one dies as the new one is born, so a stolen one is worth one use and the theft surfaces as the real client suddenly being refused |
| Storage | tokens are stored as SHA-256 hashes. What leaks from the table is not usable |
| Consent | only a **session** may give it. A device token or an OAuth token presenting itself at the consent page is nobody |
| Grants that never existed | revoking one answers exactly like revoking a real one (RFC 7009), so this cannot be used to find out which strings are tokens |

### Lifetimes and limits

| | |
|---|---|
| Authorisation code | 5 minutes, single use |
| Access token | 30 days |
| Refresh token | 180 days, rotated on every use |
| Redirect addresses per client | 10 |
| Redirect schemes accepted | `https:`, or `http:` on `127.0.0.1`, `[::1]`, `localhost` |

### Taking it back

Everything you have authorised is listed under **Settings → My account**, grouped by client rather than by
token — nobody thinks in access tokens, they think "that thing I connected". Revoking takes **every** token
for that client, access and refresh together: revoking the access token alone would leave the client able to
mint another within the minute, which is the same as not revoking anything.

![My account](../img/settings-account.png)

The same screen lists paired devices, which are revoked the same way and mean something different: a device
is a machine you paired, a grant is a client you let act as you.

---

## Letting it act on your computer

Reading is a database question. Recording and replaying are not — they happen on a real machine with a real
mouse — so they take a different path, and it is worth understanding before you connect anything.

![How a request reaches your machine](../img/mcp-doing.png)

### 1. The request becomes a job on your account

`db/007_run_queue.sql`. Deliberately not `user_run`: that table is the **log** — what happened, for the
dashboard and the assistant to read — and this is the **queue**, what has been asked for and has not
happened yet. One table for both would mean every reader of the log filtering out work that may never occur,
and the first reader to forget would report a request as an action.

`queued → claimed → done | failed | cancelled`, and nothing goes back. The claim is a single
`update … where id = (select … limit 1)`, so two claimers on one account cannot take the same job. A job
somebody took and never reported is **failed with a reason** at 45 minutes rather than returned to the pool:
a run that may be half-done must not be repeated blind.

### 2. Your computer asks whether there is any

The MouseFlow agent — the one already running for the Record button — asks your account for work, takes the
job, does it, and reports back. There is no second program to install: **Settings → Connections → "Let
Claude drive this computer"** mints a device token, hands it to the agent across loopback and never shows
it. Nothing is typed and nothing is copied.

![Connections, before the machine is attached](../img/settings-connections-attach.png)

What the agent has to understand is deliberately small: `#record.start`, `#record.stop`, and a replay
**body** in the five-column format it already speaks, with an `activate` line for the window. `/api/mcp`
builds that body with the same `flowBody` the Record page uses, so a replay asked for by a chat and one
asked for by the button are the same document. Everything that makes a skill a skill — its events, its
parameters, its tool definition — stays on the deployment.

### 3. The app asks you, at the moment it matters

If nothing on that computer is listening yet, the request does not fail silently in a queue nobody is
reading. A banner appears in MouseFlow saying what was asked for, with one button:

![Claude asked to start a recording here](../img/record-waiting.png)

It never nags. Nothing is shown unless something is genuinely queued **and** this computer is not taking
work; the moment either stops being true it goes away by itself. **Let it through** attaches this computer
and the queued request starts within seconds.

This exists because the failure it replaces was silent and was the product's fault: somebody said "start
recording", the request sat in the queue, the chat said so in a sentence they had to go looking to act on,
and the app — open on the same screen — showed an ordinary Record page with no hint that anything was
waiting.

### 4. And you switch it off where you can see it

The agent's own menu — the cursor icon at the top of the screen — carries **"Let My AI Act On This Mac"**.
Off, it makes **no outbound call at all**: no polling, no heartbeat. There is no inbound path in either
state, so switching it off is not a lock on a door; it is the absence of the only conversation there was.
The same switch is in the app under **Settings → Connections**, where you turned it on.

![Connections](../img/settings-connections.png)

### 5. The answer waits for the work

A tool that returned before anything happened would have told the caller nothing, so a call **waits** —
about 25 seconds, polling every 1.5. If the work runs longer, the answer names the run id and says which
tool to ask with. That number is not arbitrary: it was just under two minutes, which is well inside the
function's own limit and well outside what an MCP client will hold a request open for, and the first real
call died as "Connection closed" while the job sat happily in the queue.

**One at a time.** There is one mouse. A second request while something is running is refused with what is
already going rather than queued behind it.

### The two run paths

**A recorded desktop skill** raises the window it was recorded in first — `action=activate` with the process
and title from `payload.windows[0]`, the same thing the Record page does before playing a row, for the same
reason: a replay is coordinates and has no idea what is under them. Then the body goes to `/replay` and the
server polls `/replay/status` until it finishes. The answer reports what was sent, what could not be played,
and how many clicks `#ctx` re-aimed.

**A created skill** is a goal: screenshot, decide, act, one action a turn, in waves. That path types, and
adapts to a window that has moved, at the cost of a model call per step. The claim says which kind a job is
rather than leaving the claimer to guess.

**Since agent 0.9.0 nobody has to install anything else for it.** The decision loop needed to be on the
machine for one reason — it talked to `127.0.0.1` — and it does not any more: the agent posts the screen to
`?worker=step`, the deployment decides, the agent does the action and posts the next screen. One request per
step. See `agent/PROTOCOL.md`.

`mcp/worker.mjs` still exists and still works. It is now a choice, not a requirement, and there is exactly
one reason to want it: the decision loop runs on your own machine, so the screenshot never leaves it. Every
other reason it used to have is gone.

| | |
|---|---|
| macOS | `bash mcp/install-worker-mac.sh` — a launchd job, with `KeepAlive`, so it comes back if it dies |
| Windows | `powershell -ExecutionPolicy Bypass -File mcp\install-worker-windows.ps1` — a Startup-folder item |

Both take the token without echoing it, refuse anything that is not a `mf_` device token, refuse a Node
older than 22.18, and answer `--status` / `-Status` and `--uninstall` / `-Uninstall`. They differ in one way
that is a platform fact rather than an omission: launchd restarts a job that dies and the Startup folder does
not, so the Windows one says so and `-Status` is how you find out.

**When both are running, the agent takes the goal.** They both long-poll the same endpoint and there is one
mouse, so the queue decides rather than the race: a worker is not offered a goal while a step-capable agent
has asked for work in the last 90 seconds, and starts taking them again by itself if that agent stops
asking. A machine with only a worker is unaffected.

Either way the run is logged to the account (`kind: 'replay'` or `'agent'`, with `flowId`), so the dashboard
and the assistant see it like any other.

---

## What it will not do

![The refusals](../img/mcp-limits.png)

- **No arbitrary-goal tool.** There is no `run_this_sentence_on_my_desktop`. A skill is bounded by what its
  author recorded or wrote; a free-text goal is bounded by nothing, and that difference is the whole reason
  this is safe to hand to a model. If it is ever wanted it should arrive deliberately, with its own consent
  story, rather than inherited from this file.
- **It cannot read what you typed.** The recorder captures *that* a key was pressed and when, never which
  key ([17 — Privacy](17-privacy-security.md)). Nothing anywhere holds the text, so nothing can hand it
  over — including this. A recorded skill therefore cannot replay typing either: the agent counts what it
  could not play and the answer reports the number rather than calling the run a success. A created skill
  types fine, because the model writes the text.
- **No raw events.** Tools answer with metadata and prose. There is no way to pull the recorded stream of
  coordinates and clicks out of an account through here.
- **Extension skills refuse**, with the reason. They are still *listed*, because being told you have eleven
  skills and offered four is worse than useless — the same reason `/api/sync` returns both halves to both
  clients.
- **Unstamped rows are not offered**, and the count is in `mouseflow_status`.
- **One at a time.** There is one mouse.
- **A replay holds input, not outcome.** Nothing stored says whether the screen did what was wanted, and the
  answer says only what was sent.
- **It cannot see your agent.** The agent listens on the machine's own loopback and this server is not on
  that machine. `mouseflow_status` reports what the *account* knows and says which half it cannot see,
  rather than guessing.

---

## Every answer it can give, and what to do

The server answers in sentences rather than error codes, on purpose. These are the ones worth recognising.

| What it says | What happened | What to do |
|---|---|---|
| *"This account has no computer listening, so there is nothing to run this on…"* | No machine has ever asked this account for work | Open MouseFlow → avatar → **Connections** → **Let Claude drive this computer**. One click; nothing was queued |
| *"Nothing on the machine picked this up within 25 seconds, and it is still queued as `q_…`"* | The job is on the queue and nobody claimed it | The computer is probably asleep, off, or has the switch off. `mouseflow_run_status` with that id, or `mouseflow_stop` to take it off |
| *"It is still running on the machine as `q_…`"* | It was claimed and is taking longer than the wait | `mouseflow_run_status` with that id |
| *"MouseFlow is already busy on that machine (…)"* | Something is queued or running | Wait, or `mouseflow_stop` |
| *"…aims at elements in a web page, so the MouseFlow browser extension is the half that can replay it"* | An extension skill was called | Run it from the extension |
| *"There is no skill called `…` on this account any more"* | The tool list is stale | Ask for `tools/list` again |
| *"It stopped, and nothing had been captured. Nothing was saved."* | Stop arrived with an empty recording | Nothing to do; the timer had captured no events |
| **401** with `WWW-Authenticate` | No credential, or one that is not valid any more | Re-authenticate. A revoked grant and an expired token both land here |
| *"This deployment has no database configured."* (503) | `DATABASE_URL` is missing | An operator question, not a user one |

---

## Reference

### Endpoints

| | |
|---|---|
| `POST /api/mcp` | JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`. Notifications get **202** and no body |
| `GET /api/mcp` | A short document about the server, answerable **without** a token, so an address opened in a browser does not just 401 |
| `GET /api/mcp?pending=1` | "Is anything waiting for a machine?" — asked by the app, for the banner. Authenticated; returns a count and the tool names, never a job |
| `POST /api/mcp?worker=claim` | A claimer takes the next job (long-polls, ≤25s) |
| `POST /api/mcp?worker=report` | …and says how it went. A stopped recording arrives here as a five-column body and is turned into a row **here**, not on the machine |
| `GET /api/mcp?worker=state&id=` | …and asks whether it has been cancelled meanwhile |
| `POST /api/oauth?do=register` | RFC 7591 dynamic client registration |
| `GET /api/oauth?do=authorize` | the consent page, behind the ordinary sign-in wall |
| `POST /api/oauth?do=approve` | "yes, this client may act as me" → a code |
| `POST /api/oauth?do=token` | code + verifier → tokens; also the refresh grant |
| `POST /api/oauth?do=revoke` | RFC 7009 |
| `GET`/`DELETE /api/oauth?do=grants` | what this person has authorised, and taking one back |
| `/.well-known/oauth-protected-resource` | RFC 9728 |
| `/.well-known/oauth-authorization-server` | RFC 8414 |

### Protocol

| | |
|---|---|
| Versions spoken | `2024-11-05`, `2025-03-26`, `2025-06-18`; an unknown one is answered with the newest |
| Server identity | `mouseflow` 0.2.0 |
| Capabilities | `tools`, `listChanged: false` |
| Session header | `Mcp-Session-Id` is issued on `initialize` and exposed to browsers |
| Errors | `-32600` not JSON-RPC, `-32601` no such method, `-32603` internal. A failure **inside** a tool comes back as a tool answer with `isError`, not as a transport error — the client should see a sentence it can act on |
| CORS | An MCP client is not a browser page and sends no `Origin`. The ones that do are this app and the extension, and there is no `Allow-Credentials`, which is what stops a cross-site page spending somebody's session |

### Tuning constants

| | | |
|---|---|---|
| `CALL_WAIT_MS` | 25s | how long a `tools/call` waits for the machine before answering "still going" |
| `CALL_POLL_MS` | 1.5s | how often it looks |
| `CLAIM_WAIT_MAX_MS` | 25s | how long a claimer may hold a request open with nothing to do |
| `CLAIM_POLL_MS` | 1s | how often it looks |
| `CLAIM_STALE_MS` | 45 min | after which a claimed job is failed with a reason |

### Environment — `mcp/server.mjs` and `mcp/worker.mjs`

| Variable | Default | |
|---|---|---|
| `MOUSEFLOW_TOKEN` | — | required; the device token |
| `MOUSEFLOW_URL` | `https://mouse-agent.vercel.app` | the deployment holding the account |
| `MOUSEFLOW_AGENT_PORT` | `8787` | where the local agent listens |
| `MOUSEFLOW_WORKER_NAME` | the hostname | what to call this machine in the queue (worker only) |

### What it holds, and what it borrows

| | |
|---|---|
| `api/mcp.js` | the HTTPS transport, the tool table, the queue, and the claimer's three endpoints |
| `api/oauth.js` | the authorisation server |
| `api/well-known.js` | both discovery documents |
| `mcp/server.mjs` | the stdio transport |
| `mcp/worker.mjs` | a machine end for goal skills, which need a model in the loop |
| `mcp/run.mjs` | how a skill is run. One copy, both callers |
| `mcp/shared.mjs` | the bridge to the app's own modules |
| `mcp/test-mcp.mjs` | all of it, against a fake deployment and a fake agent |
| `web/src/features/mcp/facts.ts` | what the app and the product page say about all this — checked against `api/mcp.js` by the suite |

**It reimplements nothing**, and `shared.mjs` exists to make that true:

| Borrowed | From | For |
|---|---|---|
| `structureOf`, `wireFor` | `api/_skill-schema.mjs` | a skill as an MCP tool definition |
| `flowBody`, `parseMacro`, `summarize` | `api/_macro.mjs` | the five-column body `/replay` eats, `#ctx` lines and all |
| `flowFor` | `api/_flow-for.mjs` | a stopped recording, as a row |
| the agent client | `web/src/lib/agent.ts` | `/health`, `/do`, `/replay`, `/replay/status` |
| `runOnDesktop` | `web/src/lib/desktop-engine.ts` | the decision loop for a goal skill |
| `fillGoal`, `missingParams` | `extension/skills.js` | parameters into a goal, and refusing without them |
| `roleOf` | `api/_flow-role.mjs` | skill or recording |
| `transcribe` | `api/_transcript.js` | a recording as prose |

A second copy of any of those would be a second answer to the same question, and the first time one changed
the server would describe a product that no longer exists.

---

## How it is tested

`node mcp/test-mcp.mjs` — over a hundred checks. It stands up a fake deployment answering the exact shape
`api/sync.js` returns and a fake agent answering the exact shape both real agents do, spawns the server, and
drives the real protocol over stdio: the handshake and its version echo, the tool list against an account
holding a recording and an unstamped row as well as skills, a replay checked down to its `#ctx` lines, an
unplayable count reported rather than swallowed, a goal run through the decision loop with its parameter
filled, every refusal, and that nothing but JSON ever reaches stdout.

It then spawns the **worker** and watches it claim a job, run it through the same path and report the same
sentence a local caller would have received. The HTTPS route's isolation is asserted from its source: every
`user_id` in every query comes from the credential, every helper call passes it, and nothing reads one out
of a request. The OAuth server is asserted the same way — PKCE required, exact redirect match, codes burnt
before validation, refresh rotation, hashed storage, and that revoking a grant takes every token.

**Not covered:** a real replay on real hardware, which needs a machine and a mouse; and the HTTPS route
against a real database, which needs an account and a token. Both halves *have* been driven end to end by
hand on a real Mac — a recording started from a chat and stopped by hand, saved to the account with its
applications derived from the events' own `#ctx`.

---

## See also

- [`mcp/README.md`](../../mcp/README.md) — the setup notes that live beside the code
- [06 — Skills](06-skills.md) — what a skill is, and where tool definitions come from
- [09 — Connections](09-connections.md) — installing the agent
- [14 — HTTP API](14-http-api.md) — every other route, and the same auth rules
- [17 — Privacy and security](17-privacy-security.md) — what is captured and what deliberately is not
