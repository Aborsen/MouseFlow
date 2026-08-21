# MouseFlow as tools an AI can call

An MCP server. Every skill on a MouseFlow account becomes a tool; calling one runs it here, on this
machine, through the local agent.

Two files and no dependencies. `server.mjs` speaks the protocol; `shared.mjs` borrows the app's own
modules so that nothing in this directory is a second copy of anything.

## What you need

1. **The agent running.** The same one the Record page uses — `bash agent/install-mac.sh` on a Mac, the
   PowerShell one-liner on Windows. Connections in the app has the command, and `mouseflow_status` will
   tell you whether it answered.
2. **A device token.** In the app: **Settings → My account → Pair a device**, or the Skills page under
   *Connect the extension*. It starts with `mf_` and is shown once. It is a credential: it identifies your
   account to the deployment, and only a hash of it is stored server-side.
3. **Node 22.18 or newer.** This server runs the app's TypeScript modules directly rather than a compiled
   copy of them, which needs a Node that strips types. 24 LTS is the safe answer. `shared.mjs` says why.

## Adding it

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

| Variable | Default | |
|---|---|---|
| `MOUSEFLOW_TOKEN` | — | required; the device token |
| `MOUSEFLOW_URL` | `https://mouse-agent.vercel.app` | the deployment holding the account |
| `MOUSEFLOW_AGENT_PORT` | `8787` | where the local agent listens |

## What it offers

`tools/list` returns your skills plus two of its own:

- **`mouseflow_status`** — whether the agent is running, what it can do, how many skills are on the
  account, and how many rows were *not* offered. Ask this first when something refuses.
- **`mouseflow_stop`** — stop a replay or a run.

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

Outward, to your account: the device token, and nothing else. It never touches this directory — it arrives
in the environment.

Inward, to your machine: **the local agent has no authentication at all.** That is true with or without
this server (`docs/product/19-limits-and-known-gaps.md` says so), so anything already running on your
computer can drive it. What this adds is not new access, it is a new *decider* — which is the point of it,
and the reason the tool list is bounded rather than open.

## Testing it

```bash
node mcp/test-mcp.mjs
```

Stands up a fake deployment and a fake agent, spawns the server, and drives the real protocol over stdio —
the handshake, the tool list, a replay with its `#ctx` lines, a goal run through the decision loop, and every
refusal. No account and no agent needed.
