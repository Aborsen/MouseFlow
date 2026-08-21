# 21 — MCP server

`mcp/` and `api/mcp.js`. A fourth client, and the first one that is not a person. Every skill on an account
becomes a tool an AI can call; calling one runs it on the machine the skill belongs to, through the local
agent.

Setup, environment variables and the exact client configuration live in [`mcp/README.md`](../../mcp/README.md)
— the same split as [13 — The Chrome extension](13-extension.md) and `extension/README.md`. This document is
what it *is* and what it cannot do.

## Two transports, and why both exist

| | The decider is… | The connection |
|---|---|---|
| **stdio** — `mcp/server.mjs` | on the same machine | the client spawns it and talks over pipes |
| **HTTPS** — `POST /api/mcp` | anywhere | the client posts JSON-RPC; a worker on the machine dials out |

stdio came first and is the simpler thing: the process is already on the machine, so it can reach the agent
on loopback and run anything. Its limit is that it is one person at one terminal.

HTTPS is the same tools reachable from Claude on a phone, in a browser, in someone else's editor — and
*reachable* is the whole problem, because a serverless function cannot dial into anybody's desktop and
nothing on the internet should be able to. **So the desktop dials out.** A `tools/call` becomes a row in
`run_queue`; `mcp/worker.mjs` on the user's own machine claims it, runs it through the agent it can already
reach, and reports back; the waiting request answers with what the worker said. The direction of the
connection never reverses, which is the security property rather than a detail: no inbound path to anybody's
computer exists at all.

A machine with no worker running claims nothing. The endpoint checks that **before** queueing and says so,
because a call that sits in a queue nobody is reading looks exactly like a call that is working.

## Identity, and one account at a time

Every HTTPS request resolves one user through `whoIsCalling` — a session cookie, or the device token the
extension already pairs with — and every query filters on that id inside the `WHERE` clause. There is no
route that takes a user id and no code path that reads one from a body or a query string. A model-supplied
user id is the whole bug class: one hallucinated uuid and this becomes a way to list, or run, somebody
else's skills. The test asserts it from the source rather than trusting the reading.

So **each person in an organisation adds this with their own token and sees their own skills.** The one thing
to be careful of is a connector installed once for a whole organisation with a single shared header:
everyone on it would share one account, which is not multi-tenancy, it is one tenant with many users. OAuth
is what fixes that — so the connector identifies the person rather than the installation — and the 401
already advertises where it will live: `WWW-Authenticate` carries a `resource_metadata` URL, and
`/.well-known/oauth-protected-resource` answers it today with an empty `authorization_servers`, which states
that there is no flow to start yet rather than leaving a client to guess.

## The queue

`db/007_run_queue.sql`. Deliberately not `user_run`: that table is the **log** — what happened, for the
dashboard and the assistant to read — and this is the **queue**, what has been asked for and has not happened
yet. One table for both would mean every reader of the log filtering out work that may never occur, and the
first reader to forget would report a request as an action. A queued job that runs writes `user_run` like any
other run.

`queued → claimed → done | failed | cancelled`, and nothing goes back. A job a worker took and lost is
**failed with a reason** at 45 minutes rather than returned to the pool: a run that may be half-done must not
be repeated blind. The claim is a single `update … where id = (select … limit 1)`, so two workers on one
account cannot take the same job. Cancellation is watched, not pushed — the worker polls the job's state
while it runs, in the same outward direction as everything else.

## What runs it, in both cases

`mcp/run.mjs`, and only that. Two things ask for a run now — the stdio server, and the worker — and a second
copy of the replay path would be a second answer to "how is a skill run". The first divergence would be
invisible: one route raising the recorded window before it clicks and the other not.

## Why it exists

[06 — Skills](06-skills.md) already ended with a tool definition. `web/src/lib/skill-schema.ts` derives one
from any skill and writes it in Anthropic's, OpenAI's or MCP's shape, and the **More → structure** panel
shows you the result. What was missing was both ends of the wire:

- nothing **served** those definitions — they existed in one browser tab, as text to copy;
- nothing **accepted** the call — the agent listens on loopback and never polls the cloud, and the extension
  runs a skill only from its own UI.

So a skill could be described to a model and then had to be run by hand. This is the two ends.

## What it holds, and what it borrows

Two files, no dependencies.

| | |
|---|---|
| `api/mcp.js` | the HTTPS transport, the tool table, the queue, and the worker's three endpoints |
| `api/well-known.js` | RFC 9728 protected-resource metadata, routed from `/.well-known/…` |
| `mcp/server.mjs` | the stdio transport |
| `mcp/worker.mjs` | the machine end: claim, run, report |
| `mcp/run.mjs` | how a skill is run. One copy, both callers |
| `mcp/shared.mjs` | the bridge to the app's own modules |
| `mcp/test-mcp.mjs` | all of it against a fake deployment and a fake agent |

**It reimplements nothing.** That is the design rather than a boast, and `shared.mjs` exists to make it
true:

| Borrowed | From | For |
|---|---|---|
| `structureOf`, `wireFor` | `api/_skill-schema.mjs` | a skill as an MCP tool definition |
| `flowBody` | `web/src/lib/macro.ts` | the five-column body `/replay` eats, `#ctx` lines and all |
| the agent client | `web/src/lib/agent.ts` | `/health`, `/do`, `/replay`, `/replay/status` |
| `runOnDesktop` | `web/src/lib/desktop-engine.ts` | the decision loop for a goal skill |
| `fillGoal`, `missingParams` | `extension/skills.js` | parameters into a goal, and refusing without them |
| `roleOf` | `web/src/lib/flow-role.ts` | skill or recording |

A second copy of any of those would be a second answer to the same question, and the first time one changed
the server would describe a product that no longer exists. Two mechanics make the borrowing work, and both
are why the local half needs **Node 22.18 or newer**: Node strips the types from a `.ts` file rather than
compiling it (these modules use only types and interfaces, so there is nothing else to strip), and a resolve
hook supplies the `.ts` extension that TypeScript's own extensionless imports leave out.

The tool derivation is the exception, and it moved for this: `api/_skill-schema.mjs` is plain JavaScript and
lives beside the API, because a serverless function cannot import out of the web app's source tree with any
confidence about what the bundler traces. Three readers, one file — the Skills panel through a typed shim at
`web/src/lib/skill-schema.ts`, the local server as plain JavaScript, and `/api/mcp` as a sibling. What a
model is told about a skill and what a person reads in the panel are therefore the same sentence, still by
construction.

The one adaptation is a `fetch` shim. Both engines ask the deployment for the configured model and then for
each decision, with a **relative** URL and a cookie — exactly right in a browser tab and meaningless here —
so a path is resolved against the deployment and the device token is attached. Done in `shared.mjs` rather
than by editing the shared files, because those serve the app, and bending them around one extra caller is
how a shared module becomes nobody's.

## The tools

`tools/list` returns the account's skills plus two of the server's own.

| | |
|---|---|
| `mouseflow_status` | whether the agent answered, its version and capability flags, the skill count, how many can run here, how many rows were **not** offered, and whether something is already running |
| `mouseflow_stop` | stop a replay or a run. With nothing running here it still sends the abort, because the agent is a machine-wide service and something else may have started one |

Each skill's definition is `wireFor('mcp', structureOf(flow))` — the same JSON the Skills panel shows. What a
model is told about a skill and what a person can read about it are therefore the same sentence, by
construction.

**Recorded** skills take `repeat` and `speed`, the two knobs `flowBody` really has. **Created** skills take
the parameters their goal declares, required exactly when the author left no example to fall back on — the
same test `missingParams()` applies, so a call with a hole in it is refused by name rather than run.

## The two run paths

**A recorded desktop skill** raises the window it was recorded in first — `action=activate` with the process
and title from `payload.windows[0]`, the same thing the Record page does before playing a row, for the same
reason: a replay is coordinates and has no idea what is under them. Then `flowBody` → `/replay`, and the
server **waits**, polling `/replay/status`, because a tool that returns before the work happened has told the
caller nothing. The answer reports what was sent, what could not be played, and how many clicks `#ctx`
re-aimed.

**A created skill** fills its goal and hands it to `runOnDesktop` — screenshot, decide, act, one action a
turn, in waves. That path types, and adapts to a window that has moved, at the cost of a model call per step.

Either way the run is logged to the account (`kind: 'replay'` or `'agent'`, with `flowId`), so the dashboard
and the assistant see it like any other.

## What it will not do

- **No arbitrary-goal tool.** There is no `run_this_sentence_on_my_desktop`. A skill is bounded by what its
  author recorded or wrote; a free-text goal is bounded by nothing, and that difference is the whole reason
  this is safe to hand to a model. If it is ever wanted it should arrive deliberately, with its own consent
  story, rather than inherited from this file.
- **Extension skills refuse**, with the reason: they aim at page elements and the extension is the half that
  can replay them. They are still listed — being told you have eleven skills and offered four is worse than
  useless, which is the same reason `/api/sync` returns both halves to both clients.
- **Typing in a recorded skill does not replay.** Keystroke content is never stored ([17 — Privacy](17-privacy-security.md)),
  so the agent counts what it could not play and this reports the number instead of calling the run a
  success. A created skill types fine: the model writes the text.
- **Unstamped rows are not offered.** The Skills page lists a row with no `payload.role` *as* a skill, so
  that nobody's library empties ([06 — Skills](06-skills.md)). A tool list is read by something that will
  **call** what is in it, so "probably a skill" is not good enough here. The count is in `mouseflow_status`,
  so nothing is missing silently.
- **One at a time.** There is one mouse.
- **A replay holds input, not outcome.** Nothing stored says whether the screen did what was wanted, and the
  answer says only what was sent.

## Access, both directions

Outward, to the account: a **device token**, the same credential the extension pairs with, minted under
Settings → My account. It never touches the repository — it arrives in the environment. A token that is
refused says so and names the remedy.

Inward, to the machine: **none, and not because of this.** The local agent has no authentication at all
([19 — Limits](19-limits-and-known-gaps.md)), so anything already running on the computer can drive it. What
this server adds is not new access but a new **decider**, which is the point of it and the reason the tool
list is bounded rather than open. It is also the strongest argument yet for giving the agent a credential.

## Tested

`node mcp/test-mcp.mjs` — 75 checks. It stands up a fake deployment answering the exact shape `api/sync.js`
returns and a fake agent answering the exact shape both real agents do, spawns the server, and drives the
real protocol over stdio: the handshake and its version echo, the tool list against an account holding a
recording and an unstamped row as well as skills, a replay checked down to its `#ctx` lines, an unplayable
count reported rather than swallowed, a goal run through the decision loop with its parameter filled, every
refusal, and that nothing but JSON ever reaches stdout.

It then spawns the **worker** and watches it claim a job, run it through the same path and report the same
sentence a local caller would have received. The HTTPS route's isolation is asserted from its source: every
`user_id` in every query comes from the credential, every helper call passes it, and nothing reads one out of
a request.

Not covered: a real replay on real hardware, which needs a machine and a mouse; and the HTTPS route against a
real database, which needs an account and a token. `mouseflow_status` over stdio has been run against the real
macOS agent 0.8.2.
