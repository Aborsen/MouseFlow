# MouseFlow as tools an AI can call

Every skill on a MouseFlow account becomes a tool; calling one runs it on the machine the skill belongs to,
through the local agent.

**Two ways to connect, and the difference is where the decider sits.**

| | The decider is… | Add it with | Needs |
|---|---|---|---|
| **stdio** — `mcp/server.mjs` | on this machine | `claude mcp add … -- node …/server.mjs` | the agent running here |
| **HTTPS** — `/api/mcp` | anywhere: a phone, a browser, someone else's editor | a URL, and your ordinary sign-in | the agent running on the machine, attached to your account |

The HTTPS half cannot reach into your computer, and nothing on the internet should be able to. So the
computer dials out: a call becomes a queued job, the **agent** claims it, runs it, and reports back. A
machine that is not taking work claims nothing, and the caller is told exactly that rather than left
waiting. Only a *created* skill — a goal, which needs a model in the loop — still wants `mcp/worker.mjs`.

The full account of all this, with pictures of every step, is
[`docs/product/21-mcp.md`](../docs/product/21-mcp.md), and the page people are sent to is
[`/mcp`](https://mouseflowapp.vercel.app/mcp).

No dependencies anywhere. `shared.mjs` borrows the app's own modules so that nothing in this directory is a
second copy of anything, and `run.mjs` is the one way a skill is run, used by both halves.

## What you need

1. **The agent running.** The same one the Record page uses — `bash agent/install-mac.sh` on a Mac, the
   PowerShell one-liner on Windows. Connections in the app has the command, and `mouseflow_status` will
   tell you whether it answered.
2. **A device token.** In the app: **Settings → My account → Pair a device**, or the Skills page under
   *Connect the extension*. It starts with `mf_` and is shown once. It is a credential: it identifies your
   account to the deployment, and only a hash of it is stored server-side.
3. **Node 22.18 or newer.** This server runs the app's TypeScript modules directly rather than a compiled
   copy of them, which needs a Node that strips types. 24 LTS is the safe answer. `shared.mjs` says why.

## Adding it — HTTPS

Give the client the URL and let it sign you in:

```
https://mouseflowapp.vercel.app/api/mcp
```

The client gets a 401, follows it to `/.well-known/oauth-protected-resource`, registers itself, and opens a
browser at MouseFlow's own sign-in — **Google, or your email and password, whichever you already use**. You
approve once on a consent page that says exactly what the client will be able to do, and what it ends up
holding identifies *you*, not the installation. Take it back any time under **Settings → My account**.

That is the answer for a connector an organisation installs once: each person authorises it themselves and
sees only their own skills.

A **device token** still works, and is simpler where there is no browser — a CI job, a headless box:

```bash
claude mcp add --transport http mouseflow https://mouseflowapp.vercel.app/api/mcp --header "Authorization: Bearer mf_your_token_here"
```

Never put a token in the URL — the MCP authorization spec forbids access tokens in a query string, and this
server does not read one from there.

**Reading needs nothing else.** The analysis tools answer from the account, so they work the moment the
connector is added — no agent, no worker, nothing running.

**Doing** needs a machine, because recording and replaying are things only the agent can do — and there is
nothing extra to install for it. In the app: **avatar → Connections → "Let Claude drive this computer"**.
That mints a device token, hands it to the agent across loopback and never shows it; from then on the agent
asks your account for work. It is switched off again in the agent's own menu bar, under **"Let My AI Act On
This Mac"**.

`mouseflow_status` says whether a machine is being heard.

The one exception is a **created** skill, which is a goal and needs a model deciding each step. The agent has
no model, so those still want the worker. Register it as a login item once and forget it:

```bash
bash mcp/install-worker-mac.sh
```

It asks for the device token without echoing it, writes a launchd job, and starts it. From then on it comes
up when you sign in and comes back if it dies — the same KeepAlive the agent uses. `--status` says whether
it is up and shows its last few lines; `--uninstall` takes it off. Or run it in a terminal, if you would
rather see it:

```bash
MOUSEFLOW_TOKEN=mf_your_token_here node mcp/worker.mjs
```

**Each person sees their own skills**, whichever credential they used. That is the whole of the isolation:
the account is resolved from the credential on every request, every query filters on it, and no route takes
a user id. The difference between the two credentials is *who they identify* — a shared header identifies an
installation, and everyone behind it shares one account; an OAuth grant identifies a person. That is why the
OAuth route exists and why it is the one to prefer for anything more than one person at one terminal.

## Adding it — stdio

Claude Code:

```bash
claude mcp add mouseflow --env MOUSEFLOW_TOKEN=mf_your_token_here -- node /absolute/path/to/Mouse/mcp/server.mjs
```

Anything that reads a config file — Claude Desktop, an editor extension:

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

Both `server.mjs` and `worker.mjs` read the same environment:

| Variable | Default | |
|---|---|---|
| `MOUSEFLOW_TOKEN` | — | required; the device token |
| `MOUSEFLOW_URL` | `https://mouse-agent.vercel.app` | the deployment holding the account |
| `MOUSEFLOW_AGENT_PORT` | `8787` | where the local agent listens |
| `MOUSEFLOW_WORKER_NAME` | the hostname | what to call this machine in the queue (worker only) |

## What it offers

`tools/list` returns your skills plus these.

**Reading — works with nothing running:**

| | |
|---|---|
| `mouseflow_recordings` | what is on the account: recordings and skills, sizes, where and when |
| `mouseflow_transcript` | one recording step by step in words, and what it cannot answer |
| `mouseflow_runs` | what was asked for, which model drove it, how it ended, how long it took |
| `mouseflow_activity` | the account in numbers over a window, and which applications the work was in |

**Doing — needs a machine that is taking work:**

| | |
|---|---|
| `mouseflow_start_recording` | start the timer on the paired machine |
| `mouseflow_stop_recording` | stop it and save what was captured to the account |
| *your skills* | run one |

And the three that are about the machinery itself:

- **`mouseflow_status`** — over stdio: whether the agent is running and what it can do. Over HTTPS: whether
  a machine is listening for work, and what is queued — it cannot see the agent, which is loopback on
  somebody else's computer, and it says so rather than guessing. Both report how many rows were *not*
  offered. Ask this first when something refuses.
- **`mouseflow_stop`** — stop a replay or a run.
- **`mouseflow_run_status`** (HTTPS only) — how a run that outlasted the request is getting on.

Each skill's definition is the app's own: `structureOf()` derives it and `wireFor('mcp')` writes it, which
is the same JSON the **More → structure** panel shows you on the Skills page. So what a model is told about
a skill and what you can read about it are the same sentence, by construction.

A **recorded** skill takes `repeat` and `speed`. A **created** one takes the parameters its goal declares —
`{{recipient}}` becomes a required `recipient` of type `email`, and required exactly when its author left no
example to fall back on.

## What it will not do, and why

- **No arbitrary-goal tool.** There is no `run_this_sentence_on_my_desktop`. A skill is bounded by what its
  author recorded or wrote; a free-text goal is bounded by nothing, and that difference is the whole reason
  this is safe to hand to a model. Adding one should be a deliberate decision with its own consent story.
- **Extension skills refuse.** They aim at elements in a page, and the browser extension is the half that
  can replay them. They are still *listed*, with the reason in the refusal — being told you have eleven
  skills and offered four is worse than useless.
- **Typing in a recorded skill does not replay.** MouseFlow never stores what you typed, anywhere, on
  purpose. A recording that contained typing replays without it; the agent counts what it could not play
  and this reports the number rather than calling the run a success. A **created** skill types fine — the
  model writes the text.
- **Unstamped rows are not offered.** A row written before rows said whether they were a recording or a
  skill is listed as a skill by the Skills page, so that nobody's library empties. A tool list is read by
  something that will *call* what is in it, so "probably a skill" is not good enough here. The count is in
  `mouseflow_status`, so nothing is missing silently.
- **One at a time.** There is one mouse.
- **A replay holds input, not outcome.** Nothing stored says whether the screen did what was wanted. The
  answer says what was sent.

## Access, in both directions

Outward, to your account: over HTTPS, whichever credential the client holds — an **OAuth token issued to a
person** (the one to prefer) or a device token. Over stdio, a device token, and nothing else; it never
touches this directory — it arrives in the environment.

Inward, to your machine: **the local agent has no authentication at all.** That is true with or without
this server (`docs/product/19-limits-and-known-gaps.md` says so), so anything already running on your
computer can drive it. What this adds is not new access, it is a new *decider* — which is the point of it,
and the reason the tool list is bounded rather than open.

## Testing it

```bash
node mcp/test-mcp.mjs
```

Over a hundred checks. Stands up a fake deployment and a fake agent, spawns the stdio server and drives the real
protocol — the handshake, the tool list, a replay with its `#ctx` lines, a goal run through the decision
loop, every refusal — then spawns the **worker** and watches it claim a job, run it and report. It also
asserts the HTTPS route's isolation from its source: that every `user_id` in every query comes from the
credential and nothing reads one out of a request. No account and no agent needed.
