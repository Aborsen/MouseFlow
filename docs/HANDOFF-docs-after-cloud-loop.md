# Work order: the product docs, after the decision loop moved off the machine

**Written:** 2026-08-24, against `Aborsen/Mouse` at `e13bb97`.
**Covers:** `docs/product/*` — the internal documentation. The *public* site is a different job with its own
file, [`HANDOFF-public-docs-update.md`](HANDOFF-public-docs-update.md); do not do both in one pass.

This file is written to be executed without the conversation that produced it. Everything in §1 is a fact
you can check in the tree; everything in §2 is a file with something false in it.

---

## 0. What happened

Fifteen commits, `6c4f7d6..e13bb97`, all on 2026-08-24. A **goal skill** — the kind the wizard makes, where
a model looks at the screen and chooses one action at a time — used to require a second program installed
beside the agent (`mcp/worker.mjs`), for one reason: the loop talked to `127.0.0.1`. It does not any more.

```
BEFORE   mouseflow_run → run_queue row → the WORKER claims it → runs the loop → agent on 127.0.0.1
NOW      mouseflow_run → run_queue row → the AGENT claims it  → posts the screen → the deployment decides
```

Verified end to end on a real Mac with no worker installed: 31 decisions, the wave seam crossed in the
cloud, 8.7–8.8 s per step against 7.0–8.6 s for the old local path.

---

## 1. The seven facts every edit below follows from

1. **A goal skill no longer needs a worker.** Agent 0.9.0+ posts `{ id, shot, windows, results }` to
   `POST /api/mcp?worker=step` and gets back `{ actions }`, `{ shrink }` or `{ done }`. One request per
   step; nothing reconnects between steps, because the reply to one step is what produces the next.
2. **There are now two drivers over one brain.** `api/_brain.mjs` holds the system prompt, the tool schemas,
   the picture message, the encoding of an action, and what a refusal or a truncated answer means.
   `web/src/lib/desktop-engine.ts` drives it with a for-loop in the browser; `api/_step.mjs` drives it one
   turn per request. Neither owns the prompt any more.
3. **The loop's state lives in a row**, `run_queue.loop` (jsonb, migration `db/010_run_queue_loop.sql`),
   because the instance that decides step 4 may not be the one that decides step 5. **It never holds a
   picture** — every state written strips images, and the agent sends a fresh one with each request.
   `run_queue.stepping` (boolean) records that the cloud path is driving.
4. **Both agents are 0.9.2** and they report their own crashes: `POST /api/mcp?worker=crash`, through the
   account, never to Sentry directly — so no DSN sits inside a program people download, and a crash arrives
   attached to an account and a build. `POST /crash-test` on the agent proves the pipe and answers
   `{ ok, reported }`, where `reported` is true only if Sentry itself took the event.
5. **When a worker and a step-capable agent are both listening, the agent gets the goal.** They both
   long-poll the same endpoint and there is one mouse. A worker is not offered a goal while an agent has
   asked for work in the last 90 seconds, and takes them again by itself if that agent stops asking. A
   machine with only a worker is unaffected. (This reverses decision D5 in
   [`PLAN-worker-to-cloud.md`](PLAN-worker-to-cloud.md); the reasoning is written there and in `api/mcp.js`.)
6. **A stop is noticed inside a wait.** A wait can last two minutes. Every third look at the screen the
   agent also asks `?worker=state&id=`; if the job is no longer `claimed` it abandons the turn and posts
   what it has. Measured: a cancellation tidied the row in 0.2 s.
7. **`AGENT_WANTS` is `0.9.2`** (`web/src/lib/agent.ts`). The update nudge is the only way somebody on
   0.8.x learns the install step is gone.

### The one correction to carry carefully

For a few hours today the installers and `21-mcp.md` said that with a worker *the screenshots never leave
the machine*. **That is false and has been retracted.** `runOnDesktop` asks `/api/claude` for every
decision, and the fetch shim in `mcp/shared.mjs` points that at the deployment — so the picture reaches the
deployment on both paths. What the worker actually keeps local is the **conversation**: the transcript lives
in that process and is gone when the run ends, where the cloud path holds it in `run_queue.loop` until the
run finishes. If the docs anywhere imply the stronger claim, remove it. Neither path gives "the screen never
leaves this computer" today; that would need the loop calling Anthropic directly with the user's own key.

---

## 2. File by file

Already corrected — **do not redo**: `docs/product/21-mcp.md` (the worker sections), `docs/product/12-agent-macos.md`
(version), `agent/PROTOCOL.md` (the full `?worker=step` and `?worker=crash` sections — **read it before
writing §2.3 below; it is the source**).

### 2.1 `docs/product/14-http-api.md` — the endpoint list is missing two routes

Line 370. The block lists `?worker=claim`, `?worker=report`, `?worker=state` and stops. Add:

```
POST   /api/mcp?worker=step        a machine carries out one turn of a goal   (holds while the model decides)
POST   /api/mcp?worker=crash       …and says when it fell over
```

Say what `step` takes and returns (fact 1), and that the deployment closes the job itself on the step that
ends it — **an agent must not also `?worker=report` a run it drove**, or it overwrites what the run said.

### 2.2 `docs/product/21-mcp.md` — same table, line 486

The worker prose is fixed; the endpoint table at 486–488 is not. Add the same two rows.

### 2.3 `docs/product/10-agent-protocol.md` — the agent gained a second job

This file mirrors `agent/PROTOCOL.md`, which is already updated. The endpoint table at line 22 needs
`POST /crash-test` (returns `{ ok, reported }`; 409 when the machine is not attached to an account). Then a
new section for the step loop, taken from `agent/PROTOCOL.md`: the diagram, that `windows` is the **array**
and not the wrapper, that a `wait` answers with numbers (`{ id, quiet, waited, quietFor }`) and never a
sentence — the wording the model reads is composed at the deployment so the two agents cannot phrase it
differently — and the four rules under fact 4, 5 and 6 above.

Also: waiting happens at the agent now, with the same numbers the app's loop uses — 1.5 s between looks, two
still frames, a mean difference above 3/255 counting as movement. They agree on purpose.

### 2.4 `docs/product/05-create.md` line 122 — "The desktop decision loop"

It says the loop is `web/src/lib/desktop-engine.ts` and that deciding what to do next "is this file's job".
That is now half of the truth. Rewrite around fact 2: the same loop runs in two places over one brain, and
the file is the *browser* driver. The Shape table (model, `WAVE_TURNS = 24`, `MAX_WAVES = 10`, 1280px, 413
halving, 1.5 s settle) is still correct — but those constants live in `api/_brain.mjs` now, so point there.

### 2.5 `docs/product/15-data-model.md` — `run_queue` is not documented at all

Grep it: the queue is missing from a file that otherwise describes every table. Add it, with the full column
list from `db/007_run_queue.sql` plus the two from `db/010_run_queue_loop.sql`, and carry the two rules that
matter: **nothing goes back** (a job a machine took and lost is expired by the claim age, never returned to
the pool, because a run that may be half-done must not be repeated blind), and **`loop` never holds an
image**. Say why the column is called `loop` and not `state`: `state` is already this table's
queued/claimed/done.

Also note that a run driven from the cloud is logged to `user_run` with `extension: 'cloud'` and
`client_id` = the queue id, and that a run somebody **stopped** is logged too, with `outcome: 'stopped'`.

### 2.6 `docs/product/11-agent-windows.md` — version

Lines 4 and 67 say `0.8.2`. Both agents are `0.9.2`. Note what the Windows agent gained (facts 1, 4, 6) and
that **none of it has been run on a real Windows machine yet** — see §2.7.

### 2.7 `docs/product/19-limits-and-known-gaps.md` — three edits

- **"Not verified" table (line 59).** Add: *the Windows agent at 0.9.2* — the step loop and the crash
  reporter are both written and never run there; the contract test holds them against the macOS
  implementation, but that compares text, not behaviour. Update the *Windows worker installer* row: it is
  still never-run, and it now matters less, because nobody needs the worker.
- **Add a new gap:** the stop-inside-a-wait path (fact 6) is written and **not observed** — the model did
  not call `wait` in any of the verification runs, and it cannot be made to.
- **Defect 5, `AGENT_WANTS` trails the agents (line 128): fixed.** It is `0.9.2` now, and the reasoning
  changed — the nudge is deliberate, because it is how somebody learns the worker is no longer needed.

Worth adding to the same file, because it is the honest headline of the day: **`api/mcp.js` still has no
executable coverage.** Four bugs shipped from that route today and every one was found by watching a real
run — a cancelled job that kept its conversation, a log entry under `q_q_…`, a three-minute run recorded as
eleven seconds, and a helper declared after the branch that calls it, which answered a cancelling agent with
HTTP 500. Regexes over the source caught none of them and now guard all four.

### 2.8 `docs/product/01-overview.md` — the capability table (line ~105)

Add a row: **Carry out a goal skill** — desktop agent: *yes, on its own since 0.9.0*; extension: as it is
today. The architecture diagram at line 65 says "worker + content script" about the **extension's** service
worker, which is a different thing entirely — do not touch it.

### 2.9 `docs/product/18-configuration.md` — one line

`VITE_SENTRY_DSN` (line 17) now also carries **agent** crashes: the agents have no DSN and report through
`/api/mcp?worker=crash`, so this one variable covers browser, server and both agents. Reporting stays off
wherever it is not set.

---

## 3. Screenshots

**They were retaken today** — commit `c371a75`, 20:58, 29 files — so they are current for everything except
one thing this work changed.

| | |
|---|---|
| `docs/img/settings-connections.png` | **Check and probably retake.** It shows the running agent's version, which was 0.8.2 when it was shot and is 0.9.2 now. If the shot includes the version line, redo it. |
| Everything else | Current. Nothing this work changed is visible in the app. |

To retake:

```bash
node scripts/shoot-docs.mjs
```

Then check what actually changed before committing — `git status docs/img` — and do not commit a re-encode
of 29 unchanged pictures.

---

## 4. What NOT to change

- **The worker stays in the repository.** It is optional, not gone. `mcp/worker.mjs`, both installers and
  their tests are current and were deliberately kept.
- **Historical notes are true.** "Since 0.8.2 an agent can end a recording itself" and similar sentences are
  about when something arrived, not about what is current. Leave them.
- **`docs/product/02-concepts.md`** was checked and says nothing false about the worker.
- The extension's **service worker** is unrelated to `mcp/worker.mjs`. Several files mention both.

---

## 5. When you are done

Each of these should print nothing, or print exactly what the comment says.

```bash
# nothing claims a goal needs the worker on the machine — expect no output
grep -rn "worker\.mjs. on the machine\|still needs .mcp/worker" docs/product/ mcp/README.md mcp/install-worker-*

# nothing sells the worker as keeping the screen local. The ONE allowed hit is the retraction in
# 21-mcp.md, which says neither path gives that today — expect that line and nothing else
grep -rn "screen never leaves\|screenshots never leave" docs/product/ mcp/README.md mcp/install-worker-*

# both endpoint lists name the two new routes — expect at least 2 in each (21-mcp starts at 1, in prose)
grep -c "worker=step\|worker=crash" docs/product/14-http-api.md docs/product/21-mcp.md

# the two agent pages agree with the agents — expect 0.9.2 in each, and any 0.8.2 left should be
# a sentence about when something ARRIVED, not about what is current
grep -n "0\.8\.2\|0\.9\.2" docs/product/11-agent-windows.md docs/product/12-agent-macos.md
```

For reference, the truth at the time of writing: `12-agent-macos.md` is already correct (0.9.2 at lines 4
and 163); `11-agent-windows.md` still says 0.8.2 at lines 4 and 67; `14-http-api.md` and `21-mcp.md` both
name **none** of the two new routes in their tables.

`npm test` covers none of this — the product docs are prose. The one automated check that touches them is in
`mcp/test-mcp.mjs`: every screenshot referenced from `docs/product/*.md` must exist in `docs/img`. Keep that
true.
