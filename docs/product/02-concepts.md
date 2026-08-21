# 02 — Concepts and vocabulary

These words mean specific things throughout the product, and several of them were separated precisely
because conflating them caused a bug.

## Recording

Input as it happened, in order, with the pause before each event. Lives in `localStorage` as a draft the
moment it is captured **and** on the account (pushed immediately on stop — the transcript is derived
server-side, so a recording that never left the browser has no transcript and `View` answered 404).

A recording carries:

| Field | Meaning |
|---|---|
| `id` | Client-chosen (`r` + 8 random base-36 chars). The client owns identity because a recording is made and renamed on the client. |
| `name` | Default is the moment it was made, to the second: `MouseFlow 21/08 13:34:07`. Editable in place. |
| `created` | ISO timestamp. |
| `events[]` | `{ x, y, delayMs, action, context? }` — `delayMs` is the wait **before** the event. |
| `windows[]` | Which applications were in front while recording, first-touched order, sampled once a second. |
| `syncedAt` | When the account last acknowledged it. **Absent means never** — the one fact that separates "send this up" from "this was deleted elsewhere". |
| `replay` | `{ repeat, speed, loop }` — how a replay of *this* recording behaves. |

`context` is present on clicks only, and only when the agent could resolve it: `{ app, window, control,
type }`. **Absent means not known**, never "nothing there" — an elevated Windows window is invisible to a
medium-integrity agent and Electron applications name almost nothing.

## Event vocabulary

Five words come from the mouse and two do not:

```
Mouse Movement
Left|Right|Middle Click Down      Left|Right|Middle Click Release
Scroll Up      Scroll Down
Focus       the foreground window changed — a marker, not an action
Key Down    a key was pressed, and when. Never which key.
```

`Focus` is what lets a scroll, a wait or a run of typing be placed at all: without it those sit in
whichever segment a click last opened. It is never emitted between a press and its release, because the
transcript pairs a click by looking at the very next event.

## Session, and part

A **session** is a recording meant to last hours. It is cut into **parts** every 30 or 60 minutes (or
earlier, at 4,500 events), each part becoming its own row on the account. What the browser keeps is a
**ledger** — counts, never events — so a sixteen-part day costs a few kilobytes of `localStorage`
instead of several megabytes it does not have.

Why it has to work this way is arithmetic, not taste. Measured over the recordings this project has
actually made: **69 bytes an event, 23–42 events a second**, so 1.5–2.9 KB/s. Three walls, in the order
they are hit:

1. `api/sync.js` refuses a payload over **400 KB** — about three minutes of ordinary work.
2. One origin gets about **5 MB** of `localStorage` for every recording together.
3. Before agent 0.8.0 the only way events left the agent was `/record/stop` — eight hours meant
   ~830,000 events held in memory and returned in one string.

All three go away the same way: nothing anywhere ever holds more than one part.
See [04 — Record](04-record.md#long-sessions).

## Flow

A row in `user_flow`. Both recordings and skills are flows — same table, keyed by
`(user_id, client_id)` — and two fields say which is which and who can run it:

- **`payload.role`** — `'recording'` or `'skill'`. Stamped by whatever writes the row. Without it the
  Skills page listed recordings, and deleting that card deleted the recording *and its transcript*. A row
  written before the stamp existed is treated as a skill, **except** when this browser holds a recording
  under the same id — the one dangerous case that can be known for certain.
- **`source`** — `'web'` (extension, page elements) or `'desktop'` (agent, screen coordinates). Not
  inferred from the payload: the shapes are similar enough that a guess would sometimes be wrong, and a
  flow labelled runnable by the wrong half is a broken button. Both halves are returned to both clients
  and each offers Run only on its own — being told you have eleven flows and shown four is worse than
  useless.

There is also a *kind*: `'recorded'` (replays events literally) or `'created'` (re-runs a goal through
the agent, and therefore may do it differently each time).

## Skill

A flow with a name, a description and — where the goal had variable parts — **parameters**. A skill made
from a recording lives at id `dr_<recording id>`, which is what makes "does this recording have a skill?"
answerable and makes saving twice update one row instead of accumulating copies. Its events are
**copied** into it, so deleting the recording it came from does not hollow it out.

A created skill's goal is parameterised by lifting the obvious variables out of the sentence somebody
typed — email addresses first, then URLs, then quoted phrases — leaving a template with `{{recipient}}`
in it. The same value appearing twice becomes one parameter used twice.

## Run

One execution, of either kind, in `user_run`:

- `kind: 'agent'` — a goal was carried out. Has `goal`, `model`, a step trace, and whatever the model
  said in words.
- `kind: 'replay'` — a recording was repeated. No prompt.

`outcome` is one of `ok | failed | stopped | running`. **Success has to be claimed**: the decision loop
requires an explicit `finish(ok: true)`, because a run that gave up used to report as green.

## Transcript

A recording read back as something a person can check: a summary, a **story** in prose, **segments**
(where the work happened), **steps** inside them, and **gaps** — the questions this recording cannot
answer, with the real count from this recording beside each.

Derived, deterministically and purely, from the events themselves by `api/_transcript.js`. Nothing about
it is stored. That purity is load-bearing: `remove: [3, 4]` has to mean the steps the reader saw numbered
3 and 4, so the code that numbers them and the code that drops them must be the same code.
See [16 — Transcript engine](16-transcript.md).

## Hold (a recording ended at the agent)

Since 0.8.2 an agent can end a recording itself — the macOS menu bar or the Windows tray. It has no
account and gets no credentials, so it **holds** the events instead: `/record/status` answers
`recording: false` with `count > 0`, which is a state a client-driven stop never leaves behind, and
therefore the whole signal. The hold is spilled to the agent's own disk immediately, so no restart can
destroy what the button promised to save, and `/record/start` refuses with **409** until somebody takes
delivery. The web app collects it through the same door as its own Stop button.

## Identity, and who owns it

| Object | Id chosen by | Why |
|---|---|---|
| Recording, flow, skill | the client | It is made and renamed on the client; a repeated push must be idempotent rather than accumulate copies. |
| Session, part | the client | The ledger has to name parts before the account has acknowledged them. |
| Chat thread and message index | the client | A conversation exists in the page before it has ever been saved; a first save must not round-trip for an id. |
| Run | the client (`client_id`), plus a server `bigserial` | A retried sync of the same run is idempotent. |
| Gallery listing | the server | It is published, not synced. |
| User | Neon Auth | Referenced by uuid, deliberately **not** a foreign key — that schema is managed by Neon, and a hard constraint into someone else's migrations is a good way to have a deploy fail at an awkward moment. |
