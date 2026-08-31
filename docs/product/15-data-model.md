# 15 — Data model

Neon Postgres, migrations in `db/` applied by `scripts/migrate.mjs`. Plus `localStorage` in the browser and
`chrome.storage` in the extension, which hold different things on purpose.

## One rule that shapes every table

**The user id comes from Neon Auth (`neon_auth."user"`) and is never a foreign key into it.** That schema is
managed by Neon, and a hard constraint into someone else's migrations is a good way to have a deploy fail at
an awkward moment. Where a user's name or picture is needed for a listing, it is **denormalised** for the same
reason: a listing should render from one table.

## `gallery_skill` — the shared gallery

`db/001_gallery.sql`

| Column | Notes |
|---|---|
| `id` | text, primary key — server-chosen; this is published, not synced |
| `author_id`, `author_name`, `author_image` | uuid + denormalised display fields |
| `name`, `description` | |
| `kind` | `recorded` (replays events literally) or `created` (re-runs a goal) |
| `payload` | jsonb — **the skill exactly as the extension exports it**, kept whole rather than shredded into columns: the format is versioned and owned by `extension/skills.js`, and re-deriving it from columns on the way out would give two definitions of the same thing that could disagree |
| `origins` | text[] — cheap to filter on without opening the payload |
| `installs` | integer |
| `published_at`, `updated_at` | |
| `withdrawn_at` | **soft delete** — an unpublished skill somebody already installed should not become a broken link |

Indexes: newest-first excluding withdrawn (the gallery's only real query), by author, and a GIN full-text
index over **name and description only**. The payload is not searchable **on purpose**: a goal can contain an
address or a document title, and a gallery is public.

## `user_flow` — recordings and skills

`db/002_user_data.sql`, `db/003_flow_source.sql`

| Column | Notes |
|---|---|
| `user_id`, `client_id` | **composite primary key.** The client owns identity, because a flow is made and renamed on the client — so syncing the same flow twice updates it rather than accumulating copies |
| `kind` | `recorded` \| `created` |
| `source` | `web` \| `desktop` — **which half can run it.** Defaulted to `web` when the column was added, because everything that existed then came from the extension |
| `name`, `description` | |
| `payload` | jsonb — the whole thing, in the format `extension/skills.js` owns. For a recorded flow the payload's events **are** the pointer path, clicks and scrolls |
| `origins` | text[] |
| `created_at`, `updated_at` | |
| `deleted_at` | **tombstone**, so a delete on one machine can propagate instead of the flow reappearing from the next machine that syncs |

Indexes: recent-and-alive per user, and per `(user, source)` — "my desktop flows" / "my web flows" is the
query both clients make on load.

### The payload, as this product writes it

Nothing validates the payload's inner shape on the way in (`api/sync.js` stores it as sent), so every reader
guards every access. What the writers put there:

```js
{
  version: 1,
  kind: 'recorded',
  agent: 'desktop',            // or absent for a web flow
  role: 'recording' | 'skill', // which page lists it, and which delete is safe
  recorder: {                  // what the agent said about ITSELF, at the moment of recording
    version: '0.8.2',
    canName: true | false | null,   // null = no agent answered. Absent stays not-known.
    canKeys: true | false | null,
  },
  session: {                   // only on a session part
    id, part, atMs, startedAt, everyMinutes, moveMs,
  },
  name, events, windows, created,
  edits: {                     // written by POST /api/transcript
    revision, removed, at, action,
    history: [ …previous payloads… ],   // capped at 5, trimmed to fit 380 KB
  },
}
```

`recorder` exists because later nothing can reconstruct it: **"nothing was typed" and "the keyboard was not
being watched" produce an identical recording**, and the transcript was asserting the first without being able
to tell. A 0.6.0 agent names every click it lands on and hooks no keyboard at all, so the named clicks it was
reasoning from proved nothing. Read from `/health` at the moment of recording, which is the only moment the
answer exists.

`canName` / `canKeys` are `null` rather than `false` when **no agent answered** — "the keyboard was not
watched" and "nobody asked" are different facts, and the transcript asserts the first out loud. (This was
`false` until 0.8.2; a health flap mid-session used to stamp the wrong one.)

### Id conventions

| Prefix | Written by |
|---|---|
| `r…` | a recording made by the web app |
| `ses_…` | a session (ledger only, never a row) |
| `dr_…` | a skill saved from a recording, or a desktop run's id |
| `from_…` | a copy adopted into the Record console from a skill |
| `gal_…` | a copy installed from the gallery |
| `c…` | a chat thread |

Each prefix is load-bearing somewhere: `dr_` is how "does this recording have a skill?" is answered, `from_`
keeps a play copy from colliding with the original on the account, and `gal_` makes installing twice overwrite
one copy instead of making a second.

## `user_run` — the logs half

`db/002_user_data.sql`

| Column | Notes |
|---|---|
| `id` | bigserial |
| `user_id`, `client_id` | unique together, so a retried sync is idempotent |
| `kind` | `agent` (a goal was carried out) \| `replay` (a recording was repeated) |
| `goal`, `model` | null for a replay, which has no prompt |
| `flow_id` | which `user_flow` it ran, when it ran one |
| `outcome` | `ok` \| `failed` \| `stopped` \| `running` |
| `summary`, `error` | |
| `steps` | jsonb — per step the tool, the page, where it ended up, the outcome and the timing. **Kept as sent** rather than shredded, for the same reason as the payload |
| `said` | jsonb — anything the model said in words |
| `extension` | which build produced it, for reading old runs honestly |
| `started_at`, `finished_at`, `synced_at` | |

An extension run's steps carry a per-step `ms` and the page each acted on, which is **the only per-application
timing anywhere in the schema**. A desktop run's steps carry `{ tool, input }` and no timing at all — which is
why "where did the time go inside a desktop run" is in the Dashboard's gaps rather than on its chart.

## `flow_digest` — what a recording amounts to, derived once

`db/014_flow_digest.sql`, derived by `api/_digest.mjs`

**A measurement, not a preference.** `/api/insights` used to answer by unnesting every event of every
recording in the window. On the live account that is 44 recordings, 421,883 events and 28.5 MB of payload:
2880 ms for the per-application query alone, and a second scan for the behaviour block added 1700 more. The
cost is linear in recordings, so at 200 it is around thirteen seconds — and the inputs change only when a
recording is written, which is the textbook case for deriving once and keeping the answer. Measured after:
**60 ms instead of 1700**, and 44 rows occupy **32 KB against 28.5 MB**.

**Not a second copy of the recording.** There is no event in here, no window title, no control name — counts,
durations, and one sequence of application names, which is what the Dashboard already showed. Keeping the
privacy rules in one place is the reason: a table added for speed that also held content would put them in
two.

| Column | Notes |
|---|---|
| `user_id`, `client_id` | composite primary key — **the same key `user_flow` uses**, because a client id is generated on the machine that made the recording and is unique to a person, not to the table |
| `version` | **which formula produced this row.** The thresholds are chosen rather than discovered and will be argued with; bumping this re-derives every row on the next read, with no migration and no backfill script. A cache with no version needs a person to remember to clear it, which is the same as having no way to change the formula. **Used once so far**, 1 → 2, to case-fold application names: 44 rows went stale the moment the constant changed and converged in three requests (2462 ms, 512, 127), the totals came back identical to the digit, and `claude` 201 min plus `Claude` 37 min became `claude` 238. One line of SQL, no migration — which is the entire argument for the column |
| `events` | |
| `active_ms`, `waiting_ms`, `away_ms` | three parts of one measured time, and they **add up to it by construction**: every millisecond of every gap lands in exactly one of them. `numeric`, because the source is a sum over hundreds of thousands of rows |
| `by_kind` | jsonb — `{"click": 5125, "key": 23493, "move": 361241, …}`. Pointer movement is a key like any other here and is separated by the *reader*: 86% of events are movement, and a writer that dropped it would make `events` disagree with the sum of its own parts |
| `top_actions` | jsonb — `[{"action": "Key Backspace", "n": 3631}, …]`, movement excluded, the tail cut. The kind says keys were pressed; the action says which |
| `apps` | jsonb — where the time went **inside this recording**. The Dashboard's own per-application query keeps its own scan: it also attributes agent step time and handles the one-name-for-a-whole-recording case, and reproducing that here would be a second derivation of the same number |
| `pattern` | text — `chrome -> explorer -> chrome`, consecutive repeats collapsed, capped at a few steps. The question is whether one process repeated, not what the recording contains |
| `derived_at` | |

### Staleness is a fact, not a hope

A digest is recomputed when it is **missing**, **behind `version`**, or **older than the recording it
describes**. The third case is the one that matters: a recording can be *edited* — `api/transcript.js` and
the assistant's `remove_steps` both rewrite `user_flow.payload` — so without comparing `derived_at` against
`updated_at`, the Dashboard would keep reporting steps somebody had deleted.

Bringing rows up to date happens **before** the read-only transaction (it writes, so it cannot be inside
one) and in a bounded portion, `TOP_UP_MAX` = 20, so a first read on an account with hundreds of recordings
does not pay for all of them at once. A 44-recording account converged in three requests — 2423 ms, 357, 63
— and then never runs again. Failure here does not break the page: the response carries `digest.stale`, and
the Dashboard prints how many recordings its behaviour blocks do *not* cover.

One join direction is load-bearing: the upsert joins **from the stale rows**, not from the aggregates. A
recording with no events has no row in any grouping, and joining the other way would leave it stale for
ever — recomputed on every request and never satisfying the counter.

## `flow_text` — what a recording touched, by name

`db/016_flow_text.sql`, derived by `api/_search.mjs`

**Why a second table and not more columns on `flow_digest`.** That table deliberately holds no text from
anybody's screen, and its own migration says so, because a table added for speed that also held content
would put the privacy rules in two places. This one holds text *on purpose*, so its rules live beside it —
a rule you cannot reach by reading only one of the two files is a rule in two places again.

**What is in it.** The names of things that were touched: window titles, control names, the container a
control sat in, application names, page origins. Every one of them is already shown by the transcript and by
`list_recordings`, and window titles are already on the team dashboard. **Nothing new becomes visible; what
changes is that it can be found.**

**What cannot be in it**, and not because it is filtered: the recorder stores that a key was pressed and
which key, and no sentence anybody wrote exists in this product at all. A search here finds the *name of the
field* somebody typed into and can never find the words they put in it. The tool says so in its own
description and again in every result, because a model that does not know this answers "I could not find it"
where the honest answer is "that does not exist".

| Column | Notes |
|---|---|
| `user_id`, `client_id` | composite primary key, the same key `user_flow` and `flow_digest` use |
| `version` | which formula produced the row — same mechanism as `flow_digest.version` |
| `words` | every distinct phrase, lowercased, newline-separated. **A text blob rather than a `tsvector`**, and that is a decision: control names are interface labels in whatever language the application is in — the live account has `Снимок экрана` and `Prompt` inside one recording — and full-text search must be told a language before it can stem. A substring needs no language, no extension and no configuration, and finds `накладную` inside `накладные`. The cost is an index it cannot use, over a table of 80 kB where the payloads are 28.5 MB |
| `phrases` | the commonest few in their **original spelling**, so a result can say *why* it matched rather than only that it did |
| `distinct_n` | how many distinct names there were **before** the cap on `words`, so a truncated index says it is truncated instead of quietly answering "nothing found" |
| `derived_at` | |

**Normalised in JavaScript, not in SQL**, and this is the one place that ordering matters. The names are
already normalised once — `plainName` and `plainTitle` in `api/_names.mjs` — and that is the definition the
transcript *displays*: Chrome hands over a tab name as a whole sentence with a memory reading inside it, and
the transcript strips that before showing it. Writing those rules again in SQL would give two definitions of
one name, and the index would then be searchable by text nobody was ever shown. So SQL groups the raw names
(a few hundred rows per recording rather than a payload) and the module that owns the rules applies them.

### The batch is picked once, and that was a data-losing bug

It used to be picked twice: the names query took `limit N` of the stale recordings, and a second query then
took `limit N` of whatever was **still** stale and wrote an *empty* index for each. Every batch quietly
ruined as many recordings as it indexed — they stopped being stale with nothing in them, so they were never
re-derived and could never be found again.

Measured: `снимок экрана` appears in 81 events of three recordings and appeared in none of the 45 index
rows; after the fix the account holds **2326 distinct names against 906**, so 61% of them were being lost.
The batch is now a list of ids, everything works from that list, and a recording in it gets a row whether or
not it had a single name — which is the other half of the same rule, and the one `flow_digest` had to learn
from the opposite direction.

## `run_queue` — work asked for in one place and done in another

`db/007_run_queue.sql`, plus `db/010_run_queue_loop.sql`

An MCP call cannot reach into somebody's desktop, and nothing in the design should let it: the agent does
not accept connections from the internet. So the desktop asks instead. A tool call becomes a **row** here, a
claimer on the user's own machine takes it, and the outcome is written back. The direction of the connection
never reverses — that is the security property, and a machine with nothing listening simply never claims
anything.

| Column | Notes |
|---|---|
| `id` | text, primary key |
| `user_id` | uuid |
| `flow_id` | the skill, by the client id `user_flow` is keyed on. **Not a foreign key** — a skill deleted between the ask and the claim should fail the job with a reason, not fail the delete |
| `tool_name`, `args` | what was asked for |
| `state` | `queued` → `claimed` → `done` \| `failed` |
| `claimed_by`, `claimed_at`, `finished_at` | |
| `ok`, `said` | the outcome, in the words the tool result will use |
| `created_at` | |
| `loop` | jsonb — the decision loop's conversation, for a goal driven from the cloud |
| `stepping` | boolean — that the cloud path is driving this job |

**Nothing goes back.** A job a machine took and lost is expired by the claim age, never returned to the
pool: a run that may be half-done must not be repeated blind.

**`loop` never holds a picture.** A goal is a model deciding what to do next from a screenshot, and a
serverless function has nowhere to keep a conversation between two requests — the instance that decided step
4 may not be the one that decides step 5. So the conversation lives in the row. But at 161 KB a step and up
to 240 steps a run, keeping the images would turn the queue into a picture album, so `api/_step.mjs` strips
every image before writing the state back. There is nothing to keep: the agent sends a fresh picture with
every request.

The column is called `loop` rather than `state` because **`state` is already this table's
queued/claimed/done**.

### What it writes to the log

A queued job that runs writes `user_run` like any other run. Two things identify one driven from the cloud:
`extension: 'cloud'`, and `client_id` set to the queue id. A run somebody **stopped** is logged too, with
`outcome: 'stopped'` — a cancellation is a fact about the run, not an absence of one.

> **Why not `user_run`.** That table is the LOG — what happened, for the dashboard and the assistant to
> read. This is a QUEUE — what has been asked for and has not happened yet. One table would mean every
> reader of the log filtering out work that may never occur, and the first reader to forget would report a
> request as an action.

## `device_token` — pairing the extension

`db/002_user_data.sql`. `id`, `user_id`, `token_hash` (unique), `label`, `created_at`, `last_used_at`,
`revoked_at`. **Only a hash is stored**: if this table leaks, what leaks should not be usable. The plaintext
is shown once, at creation, and never again.

## `chat_thread` / `chat_message` — conversations

`db/004_chat.sql`

- **The client chooses both ids**, including the message index `n`, which is part of the key: a conversation
  exists in the page before it has ever been saved, and re-saving a turn must overwrite it rather than append
  a second copy (the page saves after every reply).
- `title` is the first question, trimmed. **A conversation names itself**; nothing asks anybody to title one.
- `meta` holds what the reply was grounded on — the tools that ran and the runs it cited — so a reopened
  conversation shows the same "based on" panel it showed when it was new. An answer without its evidence is a
  claim.
- **`delete` removes the row**, and the messages go with it on cascade. Unlike `user_flow`: a flow is
  tombstoned because two machines sync it and a delete has to propagate; a conversation is written by one
  client, read by one person, and reconciled by nothing. Asking for a conversation to be forgotten and keeping
  it with a flag set would be the wrong answer to a reasonable request.

## `localStorage` (the web app)

One key holds the console; the rest are single preferences.

### `mouseflow` — the console

```ts
{
  port: 8787,
  recordings: Recording[],   // events live here, as drafts
  sessions: Session[],       // LEDGERS — counts, never events
  lastSync: { at, pulled, pushed, forgotten, left } | null,
  flow: FlowStep[],          // { recordingId, repeat, speed, delayAfterMs }
  startDelayMs: 3000,
  flowRepeat: 1,
  flowForever: false,
}
```

Read defensively — it is data an older build wrote, so every array is checked for being an array and `port`
for being finite. One copy in memory shared by every component that asks, so two lists of recordings can never
disagree about what is in them. A write failure (private mode, full quota) is swallowed: the session still
works, only persistence is lost.

**Sessions hold no events.** Sixteen half-hour parts is a few megabytes, and one origin gets about **5 MB for
every recording together** — so the events live on the account, which is where the transcript reads every
recording from anyway, and the ledger is the receipt. `PULL_BUDGET_BYTES` (3 MB) bounds how much of the
account this browser will hold, and what was left behind is **said** rather than silently truncated.

### The other keys

| Key | Holds |
|---|---|
| `mouseflow.theme` | `light` \| `dark`, or **absent** for system |
| `mouseflow.side.tight` | `'1'` when the sidebar is collapsed |
| `mouseflow.create.target` | `browser` \| `desktop` |
| `mouseflow.bringForward` | `'1'` to activate this tab when a run finishes |
| `mouseflow.insights.assistant` | whether the assistant panel is open |
| `mouseflow.insights.assistant.width` | its width |

## The two-way sync rules

| Fact | Where it lives | What it decides |
|---|---|---|
| `syncedAt` | on the recording, in `localStorage` | Whether an absence on the account means "send it up" or "it was deleted elsewhere" |
| `payload.role` | on the row | Which page lists it, and therefore which delete button can reach it |
| `source` | on the row | Which half is offered a Run button |
| `deleted_at` | on the row | A delete that propagates instead of being undone by the next sync |
| `payload.session` | on the row | That this row is a session part, and where in the session |

The interaction worth stating once more, because it is the one that can lose data: **`POST /api/sync` clears
`deleted_at` on upsert.** That is what makes "put it back on the account" work, and it is why re-pushing an id
the account has forgotten would resurrect it. `syncedAt` is the only thing that separates those two cases.
See [04 — Record § reconciliation](04-record.md#cross-device-reconciliation).

## Extension storage

The extension keeps its own recordings, skills, settings and run traces in `chrome.storage`. It cannot see the
page's `localStorage` and the page cannot see its storage: a page and an extension are separate origins with
separate storage, which is a browser guarantee. The **account** is the only place they meet.

Run traces are kept in `chrome.storage.local` specifically, so they survive the service worker being torn down
and the browser being closed; the last three runs are retained.
