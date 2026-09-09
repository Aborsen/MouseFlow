# 14 — HTTP API

Vercel serverless functions in `api/`. Files beginning with an underscore are **not routes** — they are
importable without being reachable.

## Who is calling

`api/_session.js`, one definition used by every route that needs one. There are three kinds of caller and
they cannot all present the same thing:

| Caller | Presents | Verified by |
|---|---|---|
| The web page | the session cookie, automatically — it is same-origin because auth is proxied through `/api/auth/*` | asking Neon Auth `/get-session` |
| The extension, a CLI, the agent | `Authorization: Bearer mf_…`, a **device token** | our own `device_token` table, **by hash** |
| An MCP connector | `Authorization: Bearer …`, an **OAuth access token** issued to a person | our own `oauth_token` table, by hash, and not expired |
| Nobody | nothing | returns `null`, which is a valid answer and the reason this does not throw |

The result carries `via: 'session' | 'device' | 'oauth'`, which two routes act on: the OAuth consent page,
where only a session may agree to anything, and the session-only routes below.

A session is verified by **asking the issuer**, never by decoding anything locally: if Neon Auth says the
session is good it is, and this code holds no signing key. A device token is ours, so it is checked against
our own table by SHA-256 — a token is a credential, and what leaks from a table should not be usable.

The device token is tried **first** when one is presented, because it carries our prefix and is unambiguous,
and because trying the issuer first would mean a network round trip to answer "no" for every extension
request. `last_used_at` is updated but deliberately **not awaited**: bookkeeping should not add latency to
every call.

### Session-only routes

Minting a device token, listing devices, revoking one, and erasing the account **require a session**, never a
device token. A device that could mint another device would turn one leaked token into permanent access, and
revoking the one you knew about would achieve nothing. The same reasoning applies to erasure: it would let one
leaked token destroy the data it was granted to read.

## CORS, and what it is not

Every route sets `Access-Control-Allow-Origin` to the requesting origin when it is `chrome-extension://…`,
and to the deployment origin otherwise. **No route sets `Allow-Credentials`.**

That is the load-bearing part: the page is same-origin, so CORS does not apply to it at all, and the
extension sends an explicit `Authorization` header rather than an ambient cookie. Not setting
`Allow-Credentials` is what stops a cross-site page spending someone's session — and it is what makes these
routes immune to CSRF.

CORS is **not the access control** anywhere here. It governs what a *browser* will let a page read; anything
that is not a browser can POST regardless. What bounds these endpoints is the validation and the session
check. (An unpacked extension's id comes from its folder path, so extension origins cannot be listed
individually — any extension origin is accepted.)

---

## `/api/auth/*`

A deliberately dumb proxy to Neon Auth. It does not interpret Better Auth's protocol, because a proxy that
understands the thing it forwards is a second implementation to keep in step with the first.

**Why it exists:** Neon Auth lives on a Neon hostname. Talking to it directly from the page would make its
session cookie a **third-party** cookie for this site, which Chrome is progressively refusing to carry — so
sign-in would work one day and quietly stop the next, in a way that looks like our bug. Everything under
`/api/auth/*` is forwarded, and the `Set-Cookie` on the way back has its `Domain` attribute stripped. The
cookie then belongs to this site: first-party, carried without argument, no cross-site exemption needed.

Details that each fixed a real failure:

- **`SameSite=None` is rewritten to `Lax`** — required, not tidier: the OAuth callback arrives from Google as
  a cross-site GET, and `Strict` would withhold the cookie on exactly that request, signing the user in
  everywhere except the page they land on.
- **Hop-by-hop headers are dropped** (`host`, `connection`, `content-length`, `accept-encoding`, …). A stale
  content-length truncates the body; the original host makes the upstream build redirect URLs pointing at the
  wrong place.
- **Our own hop's headers are dropped** (`x-forwarded-*`, `x-vercel-*`, `x-real-ip`, `forwarded`,
  `cdn-loop`). Forwarding `x-forwarded-host` told Neon Auth the request was for our hostname, which it does
  not serve, and it answered 400 *"Invalid hostname header"* for **every** call.
- **The subpath arrives as `?authpath=…`** from a rewrite in `vercel.json`, not from a filesystem catch-all:
  a catch-all file reached the function for a one-segment path and 404'd at the platform for two, because
  this project has no framework preset and so no framework-aware routing.

`GET /api/auth/finish?to=<path>` exchanges the one-time verifier for a session cookie — only a server can do
that — and redirects to `to` with `?auth=ok` (or a reason). `to` is kept **relative**, so this cannot be
turned into an open redirect, and the outcome is merged into the query properly rather than appended, because
appending `?auth=ok` to a destination that already had a query or a fragment produced
`/?pair=extension#skills?auth=ok`, where nothing ever reads the parameter.

Trusted origins are configured in `neon_auth.project_config`; see `scripts/auth-origin.mjs` in
[20 — Operations](20-operations.md).

---

## `/api/sync`

The account: flows, runs and device tokens.

| Call | Auth | Does |
|---|---|---|
| `GET /api/sync` | session or device | Your flows (all of them, both halves, `deleted_at is null`) and your last 60 runs |
| `POST /api/sync` | session or device | Upsert flows and runs, tombstone deletions |
| `POST /api/sync?issue=1` | **session** | Mint a device token, shown once |
| `GET /api/sync?tokens=1` | **session** | List your paired devices |
| `DELETE /api/sync?token=<id>` | **session** | Revoke one |

The extension holds skills in its own storage and the page holds its own; neither can see the other, because
a page and an extension are separate origins with separate storage. That is a browser guarantee, not an
oversight — so **the only place they can meet is an account.**

### POST body and caps

```json
{ "flows": [ … ], "runs": [ … ], "deleted": [ "clientId", … ] }
```

| Cap | Value |
|---|---|
| Flows per push | 300 |
| Runs per push | 100 |
| Runs returned by GET | 60 |
| **One payload** | **400,000 bytes** |
| Client id | 80 chars |
| Name / description | 80 / 400 chars |
| Origins | 12 |
| Steps / said per run | 400 / 200 entries |
| Goal / summary / error | 4,000 / 2,000 / 2,000 chars |

**Upsert on `(user_id, client_id)`.** The client owns identity because a flow is made and renamed on the
client, which makes a repeated push idempotent — the extension pushes whenever something changes, and a retry
after a dropped connection must not double anything.

Two behaviours to know:

- **The upsert clears `deleted_at`.** This is what makes a restore work, and it is also the resurrection trap
  the [reconciler](04-record.md#cross-device-reconciliation) is built around.
- **A delete tombstones** rather than removing, so a delete on one machine propagates instead of the flow
  reappearing from the next machine that syncs.

`source` is taken from the body (`'desktop'` or defaulting to `'web'`), **never inferred from the payload**:
the shapes are similar enough that a guess would sometimes be wrong, and a flow labelled runnable by the
wrong half is a broken button.

**Problems are reported rather than thrown.** The response is
`{ ok, flows, runs, deleted, problems: [ … ] }` with the counts **top level** — one bad flow should not lose
the rest of the push. A payload over the cap names itself and its size.

### Minting

32 random bytes, prefixed `mf_` so a session token pasted into the wrong box fails clearly. Only the **hash**
is stored; the response is the single moment the token exists in readable form, and it says so.

---

## `/api/transcript`

One recording, read back and edited.

```
GET  /api/transcript?flow=<clientId>
  -> { ok, flow, story, summary, segments, gaps }

POST /api/transcript?flow=<clientId>   { remove: [3, 4, 5] }
                                       { keep:   [1, 2, 9] }
                                       { undo:   true }
  -> { ok, removed, remaining, revision, undo: { revision } | null }
```

**Scoping:** every query filters on the caller's id inside the `WHERE` clause, and a flow that is not the
caller's is a **404 rather than a 403**. Whether somebody else's flow id exists is not something this route
will confirm — the ids are chosen by the client, so a 403 would turn this into an oracle for guessing them.

The prose is not written here. The numbering, the segmenting and the honesty about what was never captured
all live in `api/_transcript.js` as pure functions over the payload; this file fetches a row, checks whose it
is, and writes one back. That split is not tidiness: **`remove: [3, 4]` has to mean the steps the reader saw
numbered 3 and 4**, so the code that numbers them and the code that drops them must be the same code.

### How an edit is stored, and why in the payload

A removal writes `user_flow.payload` with the surviving events and stamps it with
`edits: { revision, removed, at, action, history }`; the previous payload goes into `history`, so the edit can
be undone. Nothing is destroyed by an edit.

The stamp lives in the payload rather than in a side table because **the stamp and the events have to travel
together, always**. They are one claim about reality: *"this is 139 of the 142 things that happened."*
`/api/sync` hands the payload to whichever client asks, and both clients overwrite the whole payload when the
user saves that recording again. A stamp in its own table would survive a client push that restored the
original events, and the transcript would then say *"edited, 3 steps removed"* over a recording holding all
142 — a sentence that is not true and that nobody could disprove from the page. Kept in the payload, the two
go back together: an overwrite loses the edit **and** the claim, which reads as the original recording, which
is then what it is. That failure is recoverable; the other one is a quiet lie.

The cost is real and worth writing down: history competes for room with the recording itself. So it is capped
at the last **5** edits *and* trimmed until the whole payload fits **380,000 bytes** (under sync's 400 KB),
oldest first. A recording whose kept version has been trimmed away carries **no `undo`** in the response
rather than offering one that would fail — so a long recording already near that ceiling gets no undo at all,
which is the honest consequence of the choice above.

An edit does **not** touch `created_at` — when a recording was made is a fact about the past — and does not
rewrite the name or description. A client-authored description goes stale after an edit and is left stale on
purpose: this route is not in the business of writing prose about someone's recording, and the transcript
beside it carries the counts that are actually true.

Something has to say *"edited, 3 steps removed"*, or an edited recording reads as the original — which is the
one sentence this feature must not print. The GET says it in the **gaps**, where the rest of what a recording
cannot tell you already is.

| Limit | Value |
|---|---|
| Body | 100,000 bytes |
| Step numbers per call | 5,000 |
| Rate | 20 POSTs per minute per account (the GET is not counted — it is one row and a pure function, cheaper than the sync the page already does on load) |

---

## `/api/insights`

```
GET /api/insights?days=30
GET /api/insights?from=<iso>&to=<iso>
GET /api/insights?days=30&team=t_ab12
GET /api/insights?days=30&team=t_ab12&person=<uuid>
```

`days` defaults to 30, maximum 365 — a year of runs is a lot of `jsonb` to unroll. `from`/`to` name the two
ends instead, and the explicit pair wins: a day boundary belongs to the caller's own clock and this end never
guesses a time zone it was not told about. The span is bounded by the same ceiling, and `window.days` comes
back as a real number rather than as the parameter that was sent — a custom range of 36 hours is not "1 day".

One read-only transaction, so the totals, the day series and the per-application split agree with each other.
Rate: 30/min per account, because this unrolls every event of every recording in the window and is **the most
expensive read in the product**.

**One write happens before that transaction**, and it is the reason the behaviour blocks are affordable:
recordings whose `flow_digest` row is missing, behind the formula version or older than the recording itself
are brought up to date, at most 20 per request. It writes, so it cannot be inside a read-only transaction,
and it goes first so the read sees fresh rows.

**A digest failure degrades the page rather than replacing it**, and on both halves of the path — which took
a production 500 to get right. Catching the write was easy; the two *reads* of `flow_digest` travel inside
the transaction, and a transaction is indivisible, so one failing query rejects all twelve. A missing
`flow_digest` — code deployed ahead of its migration, an ordinary deploy order — therefore answered 500 on
every request instead of leaving three sections empty. The read is now retried **without those two queries
only**: if something else failed, the retry fails too and the *first* error is what surfaces, so the extra
round trip is paid only on failure and one component's outage cannot be reported as another's.
`digest.problem` carries the reason either way.

`team` counts every member of that team instead of the caller alone, and is accepted **only from an owner or
an admin of it**: `api/_team-scope.js` turns the id into a set of accounts or into a refusal — `403` with a
reason for a member of the team, `404` for somebody who is not in it, which does not confirm that it exists.
`person` narrows that to one member of the same team — checked against its membership, so a uuid in the
query string is no more a permission than a team id is. Without either parameter the scope is one account,
so every existing caller and every bookmark asks exactly the question it always asked.

Response: `scope`, `window`, `totals`, `byOutcome`, `byDay`, `applications`, `unattributed`, `attention`,
`actions`, `patterns`, `previous`, `previousBehaviour`, `digest`, `repeated`, `slowestSteps`, `failures`,
`skills`, `gaps`, `caps`. `scope` says whose the numbers are, and in a team scope carries one row per member —
counts and dates only. See [08 — Dashboard](08-dashboard.md) for what each means and every cap, and
[22 — Teams](22-teams.md#the-teams-dashboard) for the roles.

Three of those are derived from `flow_digest` rather than from the runs:

| Field | Holds |
|---|---|
| `attention` | `measuredSeconds`, and `active` / `waiting` / `away` each as `{ seconds, share }`. The three **add up to `measuredSeconds`** by construction. `activeUnderMs` and `awayOverMs` are the two boundaries, sent rather than left in the code, because a share of "waiting" means nothing until the reader knows how long a pause has to be |
| `actions` | `total`, `moves` (pointer movement, held out of both lists but counted in `total`), `byKind`, and `top` by action name |
| `patterns` | `repeated` (sequences seen in more than one recording), `repeatedTotal` before the cap, `once`, `total` |
| `previousBehaviour` | the same three for the window immediately before, so a share can be compared rather than only read |
| `digest` | `version`, `derived` (how many this request caught up), `stale` (how many are still to be summarised), `perRequest`, `problem`. **`stale` is a response field and not a log line**: "46% doing" over half the recordings looks exactly like "46% doing" over all of them |

---

## `/api/chat`

```
POST /api/chat  { question, model?, history?, team?, person? }
  -> { ok, answer, citations, used, usage, provider, model }
GET  /api/chat
  -> what this deployment can serve, and which providers it holds a key for
```

The grounded assistant. Read-only tools, the SQL run here, every lookup listed. Rate: 20/min per account.

The tools it may run are listed in [08 — Dashboard](08-dashboard.md#the-tools). Two of them read the
per-recording digests rather than the runs: `summarize_recordings` (the doing/waiting/away split, the
actions, the applications and the repeated sequences, optionally against the previous window of the same
length) and `recording_details` (one recording's measured shape without its contents). The first is on the
team whitelist because the team dashboard already shows those blocks over those accounts; the second is
not, because it names one colleague's recording by id.

In a **personal** scope the request also carries an account summary into the system prompt — all-time
counts, how the recorded time was spent, the commonest actions, the repeated application sequences, and the
12 most recent recordings with the ids `get_transcript` takes. Three short queries over `flow_digest`, about
730 tokens, and inside one `catch`: without it the assistant looks everything up, which is slower and not
broken. A **team** scope does not get it — that conversation keeps its tool whitelist, so what one screen
can add up about somebody else's work stays decided in one place.

`team` and `person` scope it exactly as they scope `/api/insights`, through the same `api/_team-scope.js`
check, so the panel beside the dashboard can only read what that dashboard was allowed to count. In a team
scope the tool table is a **whitelist** of aggregate lookups: nothing that reads a transcript, and nothing
that writes — see [08 — Dashboard](08-dashboard.md#the-assistant-follows-the-scope).
Full description, tool list, limits and the privacy statement: [08 — Dashboard](08-dashboard.md#the-assistant).

The GET reports the **allowlist** keyed by provider plus which providers are configured — it is not a list of
models the caller may choose freely, and reading it as one is how the model picker came to list nothing while
blaming the deployment for having no keys.

---

## `/api/chats`

Saved conversations.

| Call | Does |
|---|---|
| `GET /api/chats` | List your threads, most recent first |
| `GET /api/chats?thread=<id>` | One thread and its messages |
| `POST /api/chats` | `{ thread, title, messages }` — upsert by `(thread_id, n)` |
| `DELETE /api/chats?thread=<id>` | **Delete**, not tombstone — the messages go with it on cascade |

---

## `/api/claude`

The shared demo key, held server-side.

```
GET  /api/claude   -> { ok, configured, model, maxTokens }
POST /api/claude   -> forwarded to https://api.anthropic.com/v1/messages
```

**Why it exists:** the demo needs every attendee to use one key without each of them pasting one in. The
obvious way — put the key in the extension — does not work, because an extension ships as **readable source**:
anyone it is handed to can open the folder, or `chrome://extensions`, and read the key out. A key distributed
that way is a key published, and it stays valid until somebody notices. Anthropic and GitHub both scan for
exposed keys and revoke them, so it is also likely to simply stop working mid-demo.

So the key lives in a Vercel environment variable and this route attaches it. It can be rotated or switched
off from the dashboard without touching any installed extension.

**It is no longer anonymous.** Every call must identify a person — a session, or a device token — because a
shared key anyone who finds the URL can spend is a key with no owner and no way to tell whose run cost what.
The rate limit is per **account** rather than per IP for the same reason: an IP is not a person, and a room
full of people at a demo shares one. This is also what makes the extension's sign-in wall more than a screen:
the wall can be walked around by anyone willing to edit readable extension source; this cannot.

It spends money for anyone who can reach it, so it is deliberately narrow:

| Bound | Value |
|---|---|
| Models | `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001` |
| `max_tokens` | clamped to 16,000 |
| Messages per request | 120 — a runaway loop hits this long before it hits the balance |
| Body | 4,000,000 bytes — vision turns carry a picture, and the platform allows ~4.5 MB. A 1.5 MB cap made this proxy the tightest gate in the chain at a third of what the platform permits, and the failure it produced said only "request too large". |
| Rate | 30/min per account |

The payload is rebuilt field by field rather than forwarded wholesale, so a caller cannot smuggle in options
it is not meant to pay for.

The GET reports a **boolean and nothing else** — a prefix, a suffix or even a length would narrow a guess —
and costs nothing upstream.

Every rate limiter here is honest about itself: **a serverless instance holds its own window**, so the real
ceiling is the stated number times however many instances are warm. It stops a stuck client and casual abuse,
not a determined one.

---

## `/api/gallery`

```
GET    /api/gallery            newest published skills          (public)
GET    /api/gallery?q=…        search name and description       (public)
GET    /api/gallery?id=…       one skill, with its payload, and counts an install
GET    /api/gallery?mine=1     the caller's own, including withdrawn   (session)
POST   /api/gallery            publish                                (session)
DELETE /api/gallery?id=…       withdraw your own                      (session)
```

Reading is public, because a gallery nobody can see is not a gallery. Writing needs a session, so a skill has
an author and can be withdrawn by the person who published it. Page maximum 50; payload maximum 400,000 bytes
— a long recording is large, and a skill is not a file store.

Listings carry `total` (the matches before the endpoint's own limit) so a page can say "50 of 148" instead of
calling the fifty that arrived the whole library. Parameter **names and types** travel; the author's example
values do not.

Withdrawal is a soft delete. **Search covers name and description only** — the payload is not searchable on
purpose: a goal can contain an address or a document title, and a gallery is public.

---

## `/api/account`

```
DELETE /api/account?erase=1     (session only)
```

| Table | What happens |
|---|---|
| `user_flow` | Every flow, both halves, **hard-deleted** rather than tombstoned. A tombstone means "the client should stop showing this"; erasing an account is not that. |
| `user_run` | Every run: goals, models, steps, what the model said |
| `device_token` | Every paired device, so nothing keeps syncing into a deleted account |
| `gallery_skill` | **Withdrawn, not deleted.** A published skill may already be installed by other people, and the copies they hold are theirs; withdrawing takes it out of the gallery and off the author's name, which is what the author can actually decide. |

**What it cannot delete:** the Google account, and the sign-in record Neon Auth keeps for it. That row belongs
to the issuer, not to this application, and reaching into another system's tables to remove it would be worse
than saying plainly that it is not ours. Signing out afterwards is the client's job, and the response says so.

---

## `/api/artifacts`

```
GET  /api/artifacts?run=<id>     the frames a run kept — WITHOUT the pictures
GET  /api/artifacts?id=<frame>   one frame, with the picture
POST /api/artifacts              keep one (session or device token)
```

The few screenshots that prove something: a turn that made a check, and the screen a run ended badly on. See
[25 — Checks and tests](25-tests.md) for which and why.

| | |
|---|---|
| Why the page needs a door at all | a run driven from the Create page goes past the cloud entirely — the model is called through `/api/claude`, the actions go to the agent over loopback, and only the outcome reaches the account through `/api/sync`. The cloud path writes its own frames inside `?worker=step`, where it already has both the picture and the database |
| Listing and reading are separate | twelve frames are up to 3 MB, and the history panel shows ten runs; the list weighs a kilobyte |
| One frame | served `private, max-age=86400` — a frame's content never changes, it is a snapshot of a moment |
| Over the cap | the oldest **passing** checks are deleted first; a `failure` frame is never the one dropped (`dropWhich`) |
| Over 250 KB | answered `{ ok: true, kept: false, why }` — declined with a sentence, never silently cropped |
| Pruning | anything older than 30 days for that account, on the way past an insert. No cron |
| Scoping | every statement filters on the caller's id inside the `WHERE`; a foreign frame and a missing one get the same 404 |
| Without `db/020_run_artifact.sql` | 503 naming the migration, and it says runs are unaffected |

---

## `/api/schedules`

```
GET    /api/schedules                    the account's schedules, paused ones last
POST   /api/schedules                    create one
POST   /api/schedules?schedule=<id>      pause it ({ paused: true }) or resume it ({ paused: false })
DELETE /api/schedules?schedule=<id>      soft-delete it
```

Serves the **Skills page** and nothing else. The three actions also exist as MCP tools, and this is not a
duplicate of them: the two have different bearers — the page arrives with a session cookie, MCP with a device
token or an OAuth access token — and `whoIsCalling` is the only thing that decides whose schedules these are.
One route for two kinds of trust would be one permission check for two different ways in.

| | |
|---|---|
| Create body | `flowId` **(required)** · `label` · `arguments` · `zone` · and one of `every` (`"1h"`), `at` (`"09:00"`) with `days`, or `once` (an ISO instant) |
| Rule parsing | `readRule` / `firstAt` from `api/_schedule.mjs` — **the same functions the MCP tools and the due check use**, so a schedule set on the page and one set by voice mean the same thing |
| A time of day with no `zone` | **400.** The server has no zone; the browser sends its own |
| A skill that is not on the account | 404 at creation, rather than a schedule that pauses itself an hour later |
| A time already past | 400 |
| Resume | **recomputes** `next_at` — the saved one leaked into the past while it was paused |
| Scoping | every statement filters on the caller's id **inside the `WHERE`**; a foreign id and a missing one get the same 404, so a different answer cannot confirm an id exists |
| Without `db/018_user_schedule.sql` | 503 naming the migration, not a 500 that looks like a broken page |

The whole feature — what ticks it, what it does when the machine was asleep, and why there is no cron — is
[24 — Schedules](24-schedules.md).

---

## `/api/mcp`

```
POST   /api/mcp                    JSON-RPC 2.0: initialize, ping, tools/list, tools/call
GET    /api/mcp                    a short document about the server — no credential needed
GET    /api/mcp?live=1             (session) what the machine is doing by itself: queued and claimed jobs with their steps, and jobs finished in the last three minutes
GET    /api/mcp?live=1&days=N      (session) the same, plus every queue row that ended in the last N days (≤30) — including cancelled ones that never became a run; the Activity page's history
POST   /api/mcp?cancel=<jobId>     (session) cancel one queued job, or stop one running job at its next step; same answer for a foreign or missing id
GET    /api/mcp?pending=1          "is anything waiting for a machine?"  (any credential)
POST   /api/mcp?worker=claim       a machine takes the next job          (answers at once; ≤ 6 s if a wait is asked for)
POST   /api/mcp?worker=report      …and says how it went
GET    /api/mcp?worker=state&id=   …and asks whether it was cancelled meanwhile
POST   /api/mcp?worker=step        a machine carries out one turn of a goal   (holds while the model decides)
POST   /api/mcp?worker=crash       …and says when it fell over
```

`?worker=step` is how a goal skill runs without a model on the machine. The agent posts
`{ id, shot, windows, results }` and gets back one of `{ actions }`, `{ shrink: <width> }` — that picture was
too large, take a smaller one and ask again, nothing was done — or `{ done: true }`. One request per step, and
nothing reconnects between them because the reply to one step is what produces the next. The request is
deliberately allowed to be slow: that is the model thinking, not a stall. `windows` is the ARRAY from
`/windows` and not the wrapper.

**The deployment closes the job itself** on the step that ends it. An agent must NOT also `?worker=report` a
run it drove, or it overwrites what the run said — it reports only when it gives up part-way. The full
contract is in [`agent/PROTOCOL.md`](../../agent/PROTOCOL.md) and [10 — the agent protocol](10-agent-protocol.md).

Everything about it — every tool, what it refuses, how a request reaches somebody's desktop — is
[21 — MCP](21-mcp.md). Three things belong here, beside the other routes:

- **`GET` with no query is answerable without a credential**, so an address opened in a browser explains
  itself instead of returning 401. Every *other* `GET` therefore has to be excluded by name, and that is a
  sharp edge that has already cut once: `?pending=1` fell into the information document and came back
  `{name, version}` — no error, no 401, just the wrong answer — and the banner that reads `waiting` from it
  silently never appeared.
- **A missing or bad credential answers 401 with `WWW-Authenticate`** naming the protected-resource
  document, which is how a client discovers where to sign somebody in.
- **A failure inside a tool is a tool answer, not a transport error.** The client should see a sentence it
  can act on.

---

## `/api/oauth`

```
POST   /api/oauth?do=register       RFC 7591 dynamic client registration
GET    /api/oauth?do=authorize      the consent page, behind the ordinary sign-in wall
POST   /api/oauth?do=approve        "yes, this client may act as me" -> a code
POST   /api/oauth?do=token          code + verifier -> tokens; also the refresh grant
POST   /api/oauth?do=revoke         RFC 7009
GET    /api/oauth?do=grants         what I have authorised            (session only)
DELETE /api/oauth?do=grants&client= take one back                     (session only)
```

MouseFlow is its own authorisation server because the hosted auth service behind `/api/auth` is not ours to
add plugins to — but the **session** it issues is. So the authentication stays entirely theirs and only the
consent and the token are ours. PKCE with `S256` is required; redirect addresses are matched by exact string;
codes are single-use and burnt before validation; refresh tokens rotate; every token is stored as a hash.
Only a caller whose `via` is `session` may consent. Details in [21 — MCP](21-mcp.md#who-it-lets-in).

`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` are `api/well-known.js`,
routed by `vercel.json` rewrites.

---

## `/api/team`

Teams, their members and what they may see: [22 — Teams](22-teams.md) has the routes, the roles and the much
longer list of what a team deliberately does **not** open. The rule this document cares about is the same one
everywhere else: the caller's identity comes from the credential, a team id in a query string is a claim
rather than a permission, and `roleOf()` is the only thing that turns one into the other. It lives in
`api/_team-scope.js` and is imported by both endpoints that need it — this one and `/api/insights` — because
a second copy of it would be a second place for it to be right.

Adding somebody emails them (`api/_mail.js`), and the response says whether that happened and why not. The
link in the message is **a deep link, not a token**: membership is decided by the address on the account that
opens the page, so a forwarded message hands nobody a seat. Capped at 25 invitations per account per hour.

---

## `/api/models`

```
GET /api/models     (session only)
```

A **diagnostic**, not part of the product. It asks each provider for its own model list and returns what
looks like a current chat model, so the allowlist in `api/_provider.js` can be set from fact rather than from
memory — which is exactly how a wrong model id ships and fails at the first real request.

Per provider it reports `hasKey`, the `allowlisted` ids, the full `upstream` list (sorted, so a name that
does not match the guessed pattern is still visible — the whole point is to stop guessing), the `likely`
subset, and which allowlisted ids are `reachable` / `missing`.

Session-required because it proves which keys this deployment holds — a fact worth knowing but not worth
publishing. It spends nothing: `/models` is not a completion.

---

## `api/_provider.js` — one shape for two providers

Not a general-purpose SDK. It exists because the two decision loops keep the **provider's own reply object**
as their working memory — raw Anthropic content blocks in a transcript, tool output returned as
`tool_result` blocks inside a *user* message keyed by `tool_use_id`, with Anthropic's `is_error` flag. That is
the real coupling, and it is the one thing a "provider interface" is usually specified without: normalising
observations, actions and receipts does not help if the conversation itself is one vendor's data structure.

```
Message   { role: 'user' | 'assistant', text?, calls?, results? }
Call      { id, name, input }
Result    { id, output, isError }
Answer    { text, calls, stopReason, usage, raw }
```

`stopReason` is one of **`end` | `tools` | `truncated` | `refused`**. Those four are what a caller has to
branch on, and every provider expresses them differently — which is exactly how both loops came to file a
truncated turn as a successful run.

| | |
|---|---|
| Anthropic | `https://api.anthropic.com/v1/messages`. Exercised by this product every day. |
| OpenAI | `https://api.openai.com/v1/responses` — the **Responses** API, not Chat Completions, because the model this deployment would serve is called with `reasoning: { effort }`. **Written but never run from here**: there is no `OPENAI_API_KEY` on the deployment. Structured so a wrong assumption fails loudly with the upstream's own message rather than silently degrading, and commented so the mapping can be checked against current documentation rather than trusted. |

Model allowlists are per provider, first entry is the default, and the OpenAI default comes from
`OPENAI_MODEL` / `OPENAI_REASONING_EFFORT` so changing it is an environment variable rather than a deploy.
An allowlist rather than a passthrough for the same reason `/api/claude` has one: this spends somebody's
money, and an unbounded model name is an unbounded price.

It carries what a grounded chat and a tool loop need, and nothing else: no streaming, no images (the decision
loops still call `/api/claude` directly for those), no parallel-tool subtleties beyond returning several
calls at once.
