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
