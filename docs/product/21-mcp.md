# 21 — MCP server

`mcp/`. A fourth client, and the first one that is not a person. Every skill on an account becomes a tool an
AI can call; calling one runs it on the machine the server is running on, through the local agent.

Setup, environment variables and the exact client configuration live in [`mcp/README.md`](../../mcp/README.md)
— the same split as [13 — The Chrome extension](13-extension.md) and `extension/README.md`. This document is
what it *is* and what it cannot do.

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
| `mcp/server.mjs` | the protocol, the tool table, the two run paths |
| `mcp/shared.mjs` | the bridge to the app's own modules |
| `mcp/test-mcp.mjs` | the whole thing against a fake deployment and a fake agent |

**It reimplements nothing.** That is the design rather than a boast, and `shared.mjs` exists to make it
true:

| Borrowed | From | For |
|---|---|---|
| `structureOf`, `wireFor` | `web/src/lib/skill-schema.ts` | a skill as an MCP tool definition |
| `flowBody` | `web/src/lib/macro.ts` | the five-column body `/replay` eats, `#ctx` lines and all |
| the agent client | `web/src/lib/agent.ts` | `/health`, `/do`, `/replay`, `/replay/status` |
| `runOnDesktop` | `web/src/lib/desktop-engine.ts` | the decision loop for a goal skill |
| `fillGoal`, `missingParams` | `extension/skills.js` | parameters into a goal, and refusing without them |
| `roleOf` | `web/src/lib/flow-role.ts` | skill or recording |

A second copy of any of those would be a second answer to the same question, and the first time one changed
the server would describe a product that no longer exists. Two mechanics make the borrowing work, and both
are why this needs **Node 22.18 or newer**: Node strips the types from a `.ts` file rather than compiling it
(these modules use only types and interfaces, so there is nothing else to strip), and a resolve hook supplies
the `.ts` extension that TypeScript's own extensionless imports leave out.

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

`node mcp/test-mcp.mjs` — 51 checks. It stands up a fake deployment answering the exact shape `api/sync.js`
returns and a fake agent answering the exact shape both real agents do, spawns the server, and drives the
real protocol over stdio: the handshake and its version echo, the tool list against an account holding a
recording and an unstamped row as well as skills, a replay checked down to its `#ctx` lines, an unplayable
count reported rather than swallowed, a goal run through the decision loop with its parameter filled, every
refusal, and that nothing but JSON ever reaches stdout.

Not covered: a real replay on real hardware, which needs a machine and a mouse. `mouseflow_status` has been
run against the real macOS agent 0.8.2.
