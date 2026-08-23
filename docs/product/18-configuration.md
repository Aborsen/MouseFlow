# 18 — Configuration reference

Everything that can be set, in one place.

## Environment variables (Vercel)

| Variable | Required for | Notes |
|---|---|---|
| `DATABASE_URL` | Everything with an account | Neon Postgres. Without it the account routes answer **503** with *"This deployment has no database configured"* rather than failing obscurely. |
| `NEON_AUTH_BASE_URL` | Sign-in, and every session check | The Neon Auth endpoint. Without it `whoIsCalling` cannot verify a session and only device tokens work. |
| `ANTHROPIC_API_KEY` | `/api/claude`, and the Anthropic path of `/api/chat` | The shared demo key. `GET /api/claude` reports `configured: true/false` and nothing more about it. |
| `OPENAI_API_KEY` | The OpenAI path of `/api/chat` | Not set on the deployment; that path is written but has never been run from here. |
| `OPENAI_MODEL` | optional | Default model for the OpenAI provider. Falls back to `gpt-5.6-luna`. |
| `OPENAI_REASONING_EFFORT` | optional | Default reasoning effort. Falls back to `high`. |
| `RESEND_API_KEY` | Team invitation emails | From resend.com; **set on production**, sending from the verified domain `kuswise.com`. Scoped to sending access, not full access. Without it an invitation is still written and still works: nothing is sent, and `GET /api/team` says so rather than implying a message is on its way. See [22 — Teams](22-teams.md#configuring-it). |
| `MAIL_FROM` | Team invitation emails | A verified sender on a domain you own, e.g. `MouseFlow <team@yourdomain>`. **No default on purpose**: a provider's sandbox address delivers only to the address that owns the provider account, which looks like working in testing and reaches nobody in production. |
| `MOCK_API` | local development only | `MOCK_API=1` serves the account endpoints from an in-memory fixture. Dev-server middleware; it has **no path into a build**. |

### The MCP server and worker (`mcp/`, local — not Vercel)

| Variable | Default | |
|---|---|---|
| `MOUSEFLOW_TOKEN` | — | required; the device token this machine signs in with |
| `MOUSEFLOW_URL` | `https://mouse-agent.vercel.app` | the deployment holding the account |
| `MOUSEFLOW_AGENT_PORT` | `8787` | where the local agent listens |
| `MOUSEFLOW_WORKER_NAME` | the hostname | what to call this machine in the queue (worker only) |

**A function reads `process.env` from its own deployment's captured environment**, so a variable added
afterwards does not reach the deployment already serving — it reports `configured: false` until a new build
happens. Push a commit; see [20 — Operations](20-operations.md).

## Agent flags

### Windows (`mouseflow-agent.ps1`)

| Flag | Default |
|---|---|
| `-Port` | `8787` |
| `-AllowOrigin` | `'*'` — permissive; pin it to your deployment for anything past a local demo |
| `-MoveThrottleMs` | `10` |
| `-MoveMinPx` | `3` |
| `-NoTray` | off |

### macOS installer (`install-mac.sh`)

| Flag | Default |
|---|---|
| `--origin URL` | `https://mouseflowapp.vercel.app` |
| `--port N` | `8787` |
| `--no-login` | it **is** a login item by default |
| `--no-run` | it runs by default |
| `--foreground` | detached by default |
| `--fix-permissions` | — |
| `--doctor` | — |
| `--uninstall` | — |
| `--help`, `-h` | — |

### macOS agent binary (`mouseflow-agent.swift`)

`--port N`, `--allow-origin URL`, `--move-throttle-ms N` (10), `--move-min-px N` (3), `--probe`
(one line of JSON with the live permission verdict, used by the agent's own permission watcher), `--help`.

## Agent query parameters

| Parameter | On | Meaning |
|---|---|---|
| `?moveMs=250` | `POST /record/start` | Thin the pointer path for this recording only. Omitted means the agent keeps the default it was started with. |
| `?w=640` | `GET /shot` | A smaller picture, asked for after a 413 upstream. |

## API query parameters

| Route | Parameters |
|---|---|
| `/api/sync` | `?issue=1` (mint), `?tokens=1` (list), `?token=<id>` (revoke, with DELETE) |
| `/api/transcript` | `?flow=<clientId>` |
| `/api/insights` | `?days=N` — default 30, max 365 |
| `/api/gallery` | `?q=<search>`, `?id=<id>`, `?mine=1` |
| `/api/chats` | `?thread=<id>` |
| `/api/account` | `?erase=1` (with DELETE) |
| `/api/auth/*` | `?authpath=<subpath>` (set by the rewrite), `?to=<path>` on `finish`; the redirect back carries `?auth=<outcome>` and, on a failure, `?why=<upstream status and code>` |

## `localStorage` keys (web app)

| Key | Holds |
|---|---|
| `mouseflow` | The console: port, recordings, session ledgers, last sync, the flow being built, start delay, flow repeat |
| `mouseflow.theme` | `light` \| `dark`; **absent** means follow the system |
| `mouseflow.side.tight` | `'1'` when the sidebar is collapsed |
| `mouseflow.create.target` | `browser` \| `desktop` |
| `mouseflow.bringForward` | `'1'` to activate this tab when a run finishes |
| `mouseflow.insights.assistant` | Whether the assistant panel is open |
| `mouseflow.insights.assistant.width` | Its width |
| `mouseflow.onboarded` | `'1'` once the first-run tour has finished or been skipped |

Every write is wrapped: private mode and a full quota are expected, and losing persistence must not lose the
session.

## In-product settings

| Setting | Where | Default |
|---|---|---|
| Theme | Settings → My account | System |
| The first-run tour | runs once by itself; Settings → Connections → Show it again | shown |
| Sidebar collapsed | The sidebar toggle (auto below 820px) | expanded |
| Executor | Create composer | In this browser |
| Stay on this window | Create composer (desktop only) | off |
| Switch to this tab when it finishes | Create composer (desktop only) | off |
| Write a part every … | Record footer | One recording |
| Repeat / Speed / Loop | per recording, in the row's More panel | 1 / 1x / off |
| Dashboard range | Dashboard header | 30 days |
| Gallery sort | inside a collection | Most installed |
| Show the pointer | Extension → Settings | on |
| Trace its path | Extension → Settings | **off** |
| Personal API key | Extension → Create the flow | none (uses the shared key) |

## Tuning constants

Named here because they are the numbers somebody will want to change, and each has a reason attached at its
definition.

### The client (`web/src/lib/`)

| Constant | Value | File |
|---|---|---|
| `AGENT_WANTS` | `0.8.0` | `agent.ts` |
| Per-endpoint deadlines | 2.5 s – 20 s (see [10](10-agent-protocol.md#the-endpoints)) | `agent.ts` |
| Health poll | 2 s while answering or under 8 failures, 15 s after | `store.ts` |
| `WAVE_TURNS` / `MAX_WAVES` | 24 / 10 | `desktop-engine.ts` |
| Model / timeout | `claude-opus-5` / 75 s | `desktop-engine.ts` |
| `max_tokens` per decision | 8,000 | `desktop-engine.ts` |
| Default screenshot width | 1,280 px, halved on 413, floor 320 | `desktop-engine.ts` |
| Settle poll / quiet frames / ceiling | 1.5 s / 2 / 120 s | `desktop-engine.ts` |
| Plan model / timeout / checkpoints | `claude-opus-5` / 45 s / max 6 | `plan.ts` |

### Long sessions (`web/src/features/record/`)

| Constant | Value |
|---|---|
| `CHUNK_CHOICES` | 30, 60 minutes |
| `LONG_MOVE_MS` | 250 ms |
| `EVENTS_MAX_PER_PART` | 4,500 |
| `PENDING_MAX_EVENTS` | 12,000 |
| `PULL_BUDGET_BYTES` | 3,000,000 |
| Held-recording check | every 3 s while the page is open and idle |
| Retry pacing after a failed push | 3 s |

### The server (`api/`)

| Constant | Value | Route |
|---|---|---|
| `PAYLOAD_MAX_BYTES` | 400,000 | `sync.js` |
| `FLOWS_MAX` / `RUNS_MAX` / `RUNS_RETURNED` | 300 / 100 / 60 | `sync.js` |
| `PAYLOAD_BUDGET_BYTES` / `HISTORY_MAX` | 380,000 / 5 | `transcript.js` |
| `BODY_MAX_BYTES` / `STEPS_MAX` | 100,000 / 5,000 | `transcript.js` |
| Rate limit | 20 POST/min per account | `transcript.js` |
| `DAYS_DEFAULT` / `DAYS_MAX` | 30 / 365 | `insights.js` |
| `APPS_MAX` / `REPEATED_MAX` / `SLOWEST_MAX` / `FAILURES_MAX` / `SKILLS_MAX` | 12 / 10 / 10 / 10 / 20 | `insights.js` |
| `SLOWEST_MIN_CALLS` | 2 | `insights.js` |
| `EVENT_GAP_MAX_MS` | 120,000 | `insights.js` |
| `RUN_MAX_SECONDS` | 43,200 (12 h) | `insights.js`, mirrored in `web/src/lib/api.ts` |
| Rate limit | 30/min per account | `insights.js` |
| `MAX_ROUNDS` | 6 | `chat.js` |
| `QUESTION_MAX` / `HISTORY_MAX` / `ANSWER_TOKENS` | 2,000 / 16 turns / 2,000 | `chat.js` |
| `TOOL_OUTPUT_MAX` / `ROWS_MAX` / `STEPS_RETURNED` / `GROUPS_MAX` | 12,000 / 50 / 60 / 30 | `chat.js` |
| Rate limit | 20/min per account | `chat.js` |
| `MAX_TOKENS_CAP` / `MAX_MESSAGES` / `MAX_BODY_BYTES` | 16,000 / 120 / 4,000,000 | `claude.js` |
| Rate limit | 30/min per account | `claude.js` |
| `PAGE_MAX` / `PAYLOAD_MAX_BYTES` | 50 / 400,000 | `gallery.js` |
| `IDLE_MAX_MS` | 120,000 | `_transcript.js` |
| `WAIT_MIN_MS` | 1,500 | `_transcript.js` |
| `SCROLL_JOIN_MS` / `MOVE_JOIN_MS` / `TYPE_JOIN_MS` | 1,000 / 1,000 / 2,000 | `_transcript.js` |
| `DOUBLE_MS` / `DOUBLE_PX` / `DRAG_MIN_PX` | 400 / 6 / 12 | `_transcript.js` |
| `THIN_MIN_MS` / `THIN_PER_MINUTE` | 60,000 / 6 | `_transcript.js` |
| Text caps (label / target / note / detail) | 80 / 200 / 400 / 300 | `_transcript.js` |
| `WINDOWS_MAX` / `ORIGINS_MAX` | 24 / 12 | `_transcript.js` |
| `CALL_WAIT_MS` / `CALL_POLL_MS` | 25,000 / 1,500 | `mcp.js` — how long a `tools/call` waits for a machine |
| `CLAIM_WAIT_MAX_MS` / `CLAIM_POLL_MS` | 25,000 / 1,000 | `mcp.js` — how long a claim may hold open |
| `CLAIM_STALE_MS` | 2,700,000 (45 min) | `mcp.js` — after which a claimed job is failed with a reason |
| `CODE_TTL_MS` | 300,000 (5 min) | `oauth.js` |
| `ACCESS_TTL_MS` / `REFRESH_TTL_MS` | 30 days / 180 days | `oauth.js` |
| `CLIENTS_MAX_URIS` | 10 | `oauth.js` |
| `NAME_MAX` / `TEAMS_PER_PERSON` / `MEMBERS_MAX` | 60 / 20 / 200 | `team.js` |

### Pairs that must change together

| Pair | Because |
|---|---|
| `IDLE_MAX_MS` (`_transcript.js`) and `EVENT_GAP_MAX_MS` (`insights.js`) | Otherwise the Dashboard and a transcript report different durations for the same recording, and both look authoritative |
| `RUN_MAX_SECONDS` (`insights.js`) and `hoursOf()` (`web/src/lib/api.ts`) | Same reason, for hours |
| `PAYLOAD_BUDGET_BYTES` (`transcript.js`) and `PAYLOAD_MAX_BYTES` (`sync.js`) | The edit history has to leave room for the recording, or editing a large recording silently stops it syncing |
| `EVENTS_MAX_PER_PART` (`long-session.ts`) and `PAYLOAD_MAX_BYTES` | A part must fit the cap |
| The edit stamp shape | `transcript.js` and `_recording-tools.js` — otherwise "revision 3" means two things and an undo restores the wrong one |
| `CALL_WAIT_MS` (`mcp.js`) and what an MCP client will hold a request open for | Longer, and a call that is working reports itself as a dropped connection — which is what happened at 110 seconds |
| The tool table in `mcp.js` and `web/src/features/mcp/facts.ts` | The page and the panel describe what the server offers; the suite checks both directions |

## Vercel project settings

| Setting | Value |
|---|---|
| Framework preset | **Other** — a static project with no framework detected can deploy "Ready" and still serve `NOT_FOUND` if the preset is `null` |
| Build command | `cd web && npm install --no-audit --no-fund && npm run build` |
| Output directory | `web/dist` |

`vercel.json` also sets:

- `/agent/*` → `Content-Type: text/plain; charset=utf-8` and `Content-Disposition: attachment`, so the agent
  files download rather than render.
- `/sw.js` → `no-cache, no-store, must-revalidate`.
- `/manifest.webmanifest` → `application/manifest+json`.
- `/api/auth/(.*)` → `/api/auth?authpath=$1`.
- Everything that is not `api/`, `agent/`, `assets/`, `icons/`, `sw.js` or the manifest → `/index.html`, which
  is what makes client-side routing work.
