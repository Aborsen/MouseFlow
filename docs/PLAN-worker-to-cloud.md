# Plan: move the decision loop into the cloud, and retire the worker

**Written:** 2026-08-24, from `Aborsen/Mouse` at `6d63a42`.
**Why:** the worker is an install step that should not exist. A person installs the agent (one click, from
the Connections screen) and then has to *also* clone this repository and run a node process, or goal skills
have nothing to execute them. That is not an install story for the audience this product is for.

This file is written to be executed without the conversation that produced it.

---

## 1. What is true today

A **goal skill** — the kind the wizard makes — is a sentence a model carries out, one action at a time,
reading the screen between actions. That loop is `runOnDesktop()` in `web/src/lib/desktop-engine.ts`.

```
mouseflow_run  →  run_queue row  →  worker claims it  →  worker runs the loop locally
                                                          ↕ 127.0.0.1:8787
                                                        the agent
```

The loop must sit next to the machine **only because it talks to `127.0.0.1`**. Nothing else about it is
local: the model call already goes out over the network.

A **recorded skill** (a literal replay) does not need any of this. The agent's own courier already claims
those and replays them. It also handles `#record.start` / `#record.stop`. What it cannot do is a goal
skill — there is no model in the agent — which is the entire reason `mcp/worker.mjs` exists.

### The seam, which is much smaller than it looks

`runOnDesktop()` touches the agent in **five places**, through **four functions**, all of which go through
`agentCall(port, path, options)` in `web/src/lib/agent.ts`:

| Line (at `6d63a42`) | Call |
|---|---|
| `desktop-engine.ts:279` | `windows(port)` |
| `desktop-engine.ts:340` | `pulse(port)` |
| `desktop-engine.ts:346` | `shot(port, 640)` |
| `desktop-engine.ts:521` | `shot(port, …)` |
| `desktop-engine.ts:750` | `doAction(port, body)` |

Callers of `runOnDesktop()`: `web/src/features/create/CreateView.tsx:336` (the browser, on the machine) and
`mcp/run.mjs:195` (the worker). Both must keep working.

### Measured, not estimated

Taken on this account on 2026-08-24:

- A screenshot from `/shot` is **161 KB** binary (221 KB as base64 in JSON), captured in **0.24 s**.
- Real goal runs: 7–15 steps, **7.0–8.6 s per step**. Almost all of that is the model call.
- `run_queue` columns: `id, user_id, flow_id, tool_name, args, state, claimed_by, claimed_at, finished_at,
  ok, said, created_at`.
- `CLAIM_WAIT_MAX_MS = 25_000` in `api/mcp.js`.
- `vercel.json` sets no `maxDuration`; the platform default is 300 s.

---

## 2. The design

### 2.1 The channel — and why plain long-poll is enough

The naive version pays a reconnection between every step and would add 0.5–2 s to a 7 s step. It is not
needed, because **the agent's request IS the channel** and the model thinks inside it:

```
agent  ──POST /api/mcp?worker=step  { run, screenshot, lastResult }  ────────────►  server
                                                                     model decides (~7 s)
agent  ◄────────────────────────────  { action: "click 1030,1053" }  ───────────
       does it, captures the next screenshot, POSTs again immediately
```

One request per step. Nothing reconnects between steps, because there is no gap between them — the reply to
step *n* is what tells the agent to produce step *n+1*. **No SSE, no WebSocket.**

Expected cost: one 161 KB upload per step. On 20 Mbit that is ~0.1 s against a 7 s step — **+1–4%**.

**The 300 s function limit is the real constraint.** A held request lasts one step (~7 s), not one run, so
the limit applies per step and there is room. But the model call must not be allowed to run away: cap the
per-step server time (say 120 s) and return "no action, ask again" rather than let the platform kill the
request with the agent waiting.

### 2.2 The seam: a `Machine` instead of a `port`

> **Done at `6c4f7d6`.** `Machine` lives in `web/src/lib/agent.ts` rather than in the engine, so the type
> flows the way the dependency already does; `localMachine(port)` is what both callers pass.


Replace the `port: number` argument with an object. This is the enabling refactor and it changes no
behaviour.

```ts
export interface Machine {
  windows(): Promise<unknown>;
  pulse(): Promise<{ grid: string }>;
  shot(width?: number): Promise<ShotFrame>;
  do(body: string): Promise<unknown>;
}

export function localMachine(port: number): Machine;   // exactly what happens today
```

`runOnDesktop({ goal, machine, … })`. Both existing callers pass `localMachine(port)` and behave identically.

Server-side there is a second implementation whose four methods do not perform anything themselves: they
**return the next action to the agent and wait for its answer**. That is the inversion at the heart of this
plan — the loop believes it is calling a machine; it is really filling in one side of a held HTTP request.

> **This part did not survive contact, and the reason matters.** A `Machine` whose methods block until the
> agent's next request only works if the loop is a live for-loop somewhere — which means holding it in one
> function invocation, which is exactly what D2 rules out. The two cannot both be true. §2.3 is the one that
> was built: the loop is turned inside out into `api/_step.mjs`, and there is no `queuedMachine`.
>
> What that would have cost — two implementations of the prompt, the tool schemas and the reading of a
> reply — is paid instead by `api/_brain.mjs`, which both drivers import. The drivers differ; what the model
> sees does not.

### 2.3 Where the loop runs

In the function that is serving the agent's `?worker=step` request. The loop is *resumed* per step rather
than run to completion: each request advances it by one action.

That means the loop's state has to survive between requests. Two options, and this is **decision D2 below**:

- **(a) Keep the transcript in the row.** Add a `state jsonb` column to `run_queue` holding the model
  conversation so far. Each step rehydrates it, asks the model once, appends, writes back. Stateless
  functions, no affinity, survives an instance dying. Costs a read and a write of a growing JSON blob per
  step — and it holds screenshots, so it must store *references*, not the images.
- **(b) Hold the loop in memory** for the life of one function instance and pin the agent to it. Simpler
  code, and wrong on serverless: any instance recycle loses a run mid-flight.

**(a) is the answer.** Write it down as the reason, because (b) will look tempting when the JSON handling
gets tedious.

### 2.4 What happens to the worker

It stays, and it stops being required. A machine with a worker keeps working exactly as now — that path is
proven and there is no reason to break it. A machine with only the agent gains goal skills.

`api/mcp.js` already asks who is claiming (`kind: 'worker'`, added at `25b1d7a`). Extend it: an agent that
declares it can serve steps (`kind: 'agent'`, `steps: true`) becomes eligible for goal jobs too.

---

## 3. Order of work

Each step is separately shippable and separately verifiable. Do not start the next until the previous is
verified on a real machine.

### Step 1 — the `Machine` seam (no behaviour change)  ✅ `6c4f7d6`

- `web/src/lib/desktop-engine.ts`: introduce `Machine`, replace the five `port` uses.
- `web/src/lib/agent.ts`: add `localMachine(port)` built from the existing `windows/pulse/shot/doAction`.
- Update `CreateView.tsx:336` and `mcp/run.mjs:195` to pass `localMachine(port)`.
- **Verify:** run a goal skill from the browser (Create page) and one through the worker. Both must behave
  exactly as before. This is the whole test — a refactor that changes behaviour has failed.

### Step 2 — the per-step endpoint, with the loop still local  ✅

Built at `fc7e9d8` (the brain) and the commit that follows it (the step and the route).

- `api/_brain.mjs` — the prompt, the tool schemas, the picture message, the encoding of an action, what a
  refusal or a truncated answer means. Imported by **both** drivers; `desktop-engine.ts` re-exports what the
  rest of the app used to get from it.
- `api/_vision.mjs` — the shared-key call with pictures, lifted out of `api/claude.js` so the step does not
  make a second HTTP hop through our own endpoint to reach the same model with a different set of caps.
- `api/_step.mjs` — `startLoop()` and `advance()`: one turn, resumable, with the model call injectable.
- `POST /api/mcp?worker=step` — `{ id, shot, windows, results }` in; `{ actions }`, `{ shrink }` or
  `{ done }` out.
- `db/010_run_queue_loop.sql` — **`loop jsonb`, not `state jsonb`**: `state` is already this table's
  queued/claimed/done. Plus `stepping boolean`, so a machine running both a worker and an agent is on record
  as to which is driving.
- `api/test-step.mjs` — 46 checks driving `advance()` against a scripted model. No database, no key, no
  agent. It is wired into `npm test`.

**Nothing calls it yet**: no agent declares `steps: true`, and the claim filter only relaxes for a claimer
that does.

### Step 3 — the agent side  ✅

Shipped in agent **0.9.0**, both implementations, one build. Verified on a real Mac on 2026-08-24 with the
worker **stopped**: the agent claimed a goal job (`claimed_by: "MacBook Air — Victor"`, `stepping: true`),
took 31 decisions, crossed the wave seam in the cloud — `loop` fell from 67,846 to 28,388 bytes at wave 2,
which is the "the tenth wave costs what the first did" property, observed — and never once held a picture in
the row. It opened the self-chat and typed the message it was given. Cancelling it stopped the machine
within a step.

Two things the live run found that no test had: cancelling left the conversation in the row, and the run was
logged under `q_q_…` because the queue id is already prefixed. Both fixed, both now asserted.

Crash reporting rode along in the same build (see below), because reinstalling an agent is the expensive
part — though on a Mac with a Developer ID certificate the rebuild keeps its permissions, so it is cheaper
than it looks.



Both agents grow a step loop: while a job is claimed, POST a screenshot, receive an action, perform it,
repeat. `/shot` and `/do` already exist — this is a loop around them, next to the existing courier.

- macOS: `agent/mouseflow-agent.swift`, beside `Courier`.
- Windows: `agent/mouseflow-agent.ps1`, beside its courier.
- `agent/PROTOCOL.md`: document `?worker=step` and the loop.
- `agent/test-contract.mjs`: both agents must implement it identically.
- **Verify:** a goal skill on a machine with the worker **stopped**.

### Step 3.5 — an agent that can say it fell over  ✅

Not in the original plan, and it belongs here rather than after: step 3 is exactly the change that fails
silently on somebody else's machine, and the Windows agent has still never been run for real.

- `POST /api/mcp?worker=crash` + `reportSaid()` in `api/_report.js` — the agent carries no DSN; it reports
  through the account it already dials, so a crash arrives attached to an account and a build.
- `POST /crash-test` on both agents, which WAITS and answers `{ reported }` — true only when Sentry itself
  took the event. Verified on this Mac: `{"ok":true,"reported":true}`.
- `api/test-report.mjs` reads the envelope off a socket, because a hand-written wire format that was
  reasoned about rather than observed is a thing that silently sends nothing.

What cannot travel this way, and is written into the protocol: a failure whose cause is "cannot reach the
deployment".

### Step 4 — make the worker optional in the product

- Connections screen and docs stop telling people to install it.
- `mouseflow_status` stops implying a worker is needed when the agent can serve steps.
- `mcp/install-worker-*.{sh,ps1}` stay, documented as "only if you want the local path".

---

## 4. Decisions to make before writing code

| | Decision | Recommendation |
|---|---|---|
| **D1** | Screenshot per step over the network — acceptable? | Yes. 161 KB against a 7 s step. Reconsider only if a step gets much cheaper. |
| **D2** | Loop state: row (`loop jsonb`) or memory? | **Row.** Serverless instances are recycled; memory loses runs mid-flight. Built that way. |
| **D3** | Model key: the deployment's or the user's? | Deployment's, as `/api/chat` already does — but this is a **per-step** cost now, so the rate limit must be per-run, not per-request. |
| **D4** | Cap on steps per run | Yes, and reported. `WAVE_TURNS = 24`, `MAX_WAVES = 10` already exist in the engine; keep them and make the queue enforce a hard ceiling too. |
| **D5** | Who wins when both a worker and a step-capable agent are listening? | The worker. It is fewer round trips and it is proven. |

---

## 5. What could go wrong, written down now

- **The 300 s limit.** Per step, not per run — but a slow model call plus a slow upload could approach it.
  Cap server time per step and answer "ask again" rather than being killed mid-request.
- **A step that never comes back.** The agent dies holding a claimed job. `api/mcp.js` already fails a job
  whose claim went stale (`CLAIM_STALE_MS`); the same has to apply per step.
- **Screenshots in the row.** `state jsonb` must hold references or hashes, never images, or the row grows
  by 161 KB per step and the queue table becomes a picture album.
- **Two loops on one machine.** If the worker and the agent both claim, one run drives one mouse twice.
  D5 settles it, but the code has to enforce it rather than assume it.
- **This changes what an agent is.** Today it is a dumb hand; after this it carries out a model's decisions.
  The privacy story does not change — screenshots already leave the machine on the browser path — but the
  documentation must say plainly that a goal skill sends the screen to the deployment, step by step.

---

## 6. Definition of done

| | Status |
|---|---|
| A machine with **only the agent installed** runs a goal skill through MCP, end to end | ✅ 2026-08-24, worker stopped |
| A run is no more than ~10% slower per step than the local path | ✅ **8.7 s/step** against the local **7.0–8.6 s** measured in §1 |
| `agent/test-contract.mjs` proves both agents implement the step loop | ✅ 13 checks |
| The worker, when present, still takes precedence | ❌ **not enforced** — the claim filter lets both take goals, so it goes to whichever asks first. Step 4. |
| The Connections screen no longer asks anybody to install a worker | ❌ Step 4 |

The per-step number is measured the same way as §1 — `user_run.steps` against the started/finished stamps —
on a stopped run of 11 steps in 95.7 s. It sits at the top of the local range rather than below it, which is
what one 161 KB upload per step costs.

### What the live runs found that no test did

Four, all in the route, and every one of them from watching a real run rather than from reading:

1. Cancelling left the conversation in the row.
2. The run was logged under `q_q_…`, because the queue id is already prefixed.
3. A three-minute run was logged as eleven seconds: `claimed_at` is moved on by every step.
4. **A helper declared after the branch that calls it** — a temporal dead zone, so cancelling answered the
   agent with HTTP 500 and it abandoned the run. `node --check` does not see it and every check over this
   route is a regex, which is the standing gap `api/mcp.js` admits to in its own comments.

All four fixed and guarded. The fourth guard was verified by putting the bug back and watching it fail.
