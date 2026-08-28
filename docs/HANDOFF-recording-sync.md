# Work order: the path from Stop to a readable transcript

**Written:** 2026-08-27, against `Aborsen/Mouse` at `7171b1f`.
**Covers:** `web/src/features/record/`, `web/src/lib/store.ts`, `api/sync.js`, `api/transcript.js`.
**Does not cover:** the pull budget in `reconcile.ts` — see §3, it was measured and it is not broken.

This file is written to be executed without the conversation that produced it. Everything in §1 is a fact
you can re-measure. §2 is the work, one fix per commit, each with the check that proves it. §3 is the list
of things that look wrong and are not — read it before you start, because two of them cost a day of chasing.

---

## 0. What happened

A 1h42m recording was made on Windows. The row appeared in the table with its counts, the recorder said
`54157 events captured (1h 42m) in 30 windows`, and the sync line said `Synced with your account — 1 sent
up`. Opening it showed two sentences at once, in the same panel:

> **"MouseFlow 26/08 17:07:31" is older here than on the account, so it was not written. Sync down first —
> something else changed it after this copy.**
>
> **The transcript could not be read** — no recording with that id on this account.

Reloading several times changed nothing. A couple of minutes later a banner appeared offering *Bring it
here*; pressing it fetched the recording and the transcript then worked.

A second recording was running on a Mac at the same time, on the same account.

None of the fixes below depend on knowing the exact order those screens happened in. Each one is a defect
on its own terms, provable from the tree, and worth doing whether or not it caused that particular evening.

---

## 1. Facts you can re-measure

### 1.1 Every recording is written to the account twice — **THIS SECTION IS WRONG, see Fix 1 above**

Left in place rather than deleted, because the reasoning error is worth seeing: a column was read without
checking what it measured, and the conclusion was then repeated as fact for a day.


Run this against the production database (read-only, metadata only — no payload contents):

```sql
select client_id, name,
       octet_length(payload::text) as bytes,
       coalesce(jsonb_array_length(payload->'events'), 0) as events,
       created_at, updated_at,
       round(extract(epoch from (updated_at - created_at))::numeric, 3) as rewritten_after_s
from user_flow
where kind = 'recorded'
order by created_at desc
limit 12;
```

Measured 2026-08-27. Every row without exception:

| name | bytes | events | rewritten after |
|---|---:|---:|---:|
| MouseFlow 27/08 16:36:33 | 5850 KB | 85423 | **+3.4 s** |
| MouseFlow 27/08 12:22:16 | 3591 KB | 51807 | **+5.5 s** |
| MouseFlow 26/08 18:28:58 | 906 KB | 13203 | **+3.1 s** |
| MouseFlow 26/08 17:08:13 | 440 KB | 6511 | **+1.9 s** |
| MouseFlow 26/08 17:07:31 | 3536 KB | 54157 | **+5.3 s** |
| MouseFlow 26/08 13:26:09 | 21 KB | 278 | **+1.3 s** |
| MouseFlow 26/08 11:06:31 | 2382 KB | 34722 | **+724 s** ← the odd one out, see §3.3 |

A row is created and then rewritten a few seconds later, and the gap grows with the payload. That is a
second upload of the same bytes arriving behind the first.

**Confirm it directly before you fix it:** open DevTools → Network, filter `sync`, make a short recording,
press Stop. You should see **two** `POST /api/sync`, not one, both carrying the payload.

### 1.2 Where the second one comes from

| | |
|---|---|
| [`RecordView.tsx:567`](../web/src/features/record/RecordView.tsx) | `end()` writes the new recording into the shared store… |
| [`RecordView.tsx:587`](../web/src/features/record/RecordView.tsx) | …twenty lines *before* its own `push` resolves. |
| [`Reconciler.tsx:31-35`](../web/src/features/record/Reconciler.tsx) | The Reconciler's effect keys on a signature built from `local.recordings` and each one's `syncedAt`. The write above changes it. |
| [`reconcile.ts:161`](../web/src/features/record/reconcile.ts) | The brand-new recording has no `syncedAt` and is not on the account yet, so it is classified `push` — "it only exists here". |
| [`Reconciler.tsx:66`](../web/src/features/record/Reconciler.tsx) | The identical payload goes up again while the first request is still in flight. |

Both carry `updated: null` ([`_flow-for.mjs:36`](../api/_flow-for.mjs) — a fresh recording has no
`syncedAt`), so neither is refused; the later write wins `updated_at`.

### 1.3 Two ceilings, and where today sits against them

| ceiling | value | today's 4-hour recording |
|---|---|---|
| `PAYLOAD_MAX_BYTES` — the account refuses above this ([`_payload.mjs:32`](../api/_payload.mjs), enforced [`sync.js:343`](../api/sync.js)) | 8 000 KB | 5850 KB — **73%** |
| localStorage, per origin, for **every recording together** | ~5 000 KB | does not fit at all |

At the measured rate (~24 KB per minute of recording) the account ceiling is about **5½ hours**.

---

## 2. The work

One fix per commit. Do them in this order — the first two share a mechanism, and doing 2 without 1 means
building a progress indicator for two uploads instead of one.

### Fix 1 — one stop, one upload — **DONE 2026-08-28, but §1.1 below is WRONG and its number is unfounded**

**Read this before believing §1.1.** That section offers `rewritten_after_s` as proof that every recording
is written twice. It is not proof of anything of the kind. `api/sync.js` inserts with
`created_at = ${when(flow.created)}` — *the browser's stamp, taken when the recording stopped* — and
`updated_at = now()`, the database clock. The column therefore measures **stop-to-server latency plus clock
skew**, and a single insert can never make it zero. Every number in that table is consistent with upload
duration: 1 KB at 1.1s, 3591 KB at 5.5s. The check the section proposes ("`rewritten_after_s` should be
`0.000`") was impossible to pass.

The "11.7 MB of traffic instead of 5.85" figure that follows from it is **unfounded**. Nobody measured it.

**What was actually measured, 2026-08-28**, using `pg_stat_user_tables` around one recording made by hand:

```
before : n_tup_ins 307  n_tup_upd 319
after  : n_tup_ins 308  n_tup_upd 319      →  inserts +1, updates +0
```

One write. That is the first measurement in this defect's history that answers the question asked. It was
taken *after* Fix 1 shipped, so it does not settle whether the duplicate ever occurred — only that it does
not occur now. The mechanism traced in §1.2 remains plausible from the code and the fix is a legitimate
guard against a race the code plainly allows; it is no longer described as a cure for a measured disease.


Implemented as `web/src/features/record/sending.ts`: a module-level registry, `claim` before every push and
`release` in a `finally`. Five senders claim (stop, the two session-part pushes, import, restore) and the
Reconciler claims its own batch as well. The filter sits at the Reconciler's call site, so `reconcile()`
stays a pure function of `(flows, local)` and its rules are still runnable in a test. The Reconciler
releases **after** `reload()`, not after the push — in between, a released recording gets picked up by the
next pass as "only here", which is the same second request in a longer form. Held by
`agent/test-contract.mjs`, group *одна остановка - одна загрузка*, all twelve mutations caught.


**Now:** every stop uploads the payload twice, concurrently (§1.1, §1.2). Today that was ~11.7 MB of
traffic for a 5.85 MB recording, on the worst possible connection moment.

**Should be:** the Reconciler does not pick up a recording whose push is already in flight.

**Suggested shape.** A module-level registry of ids currently being pushed — `claim(id)` before a push,
`release(id)` in a `finally`. `reconcile()` stays a pure function of `(flows, local)`; the filter goes
*after* it, at the Reconciler's call site, so the rules remain runnable in a test:

```ts
plan.push = plan.push.filter((rec) => !sending.has(rec.id));
```

Every caller of `push` that sends a recording must claim: `RecordView.tsx:587` (stop),
`RecordView.tsx:361` and `:696` (session parts), `RecordView.tsx:949` (import), `RecordView.tsx:970`
(restore). The Reconciler's own push at `Reconciler.tsx:66` should claim too, or two Reconciler passes can
race each other the same way.

**Do not** fix this by delaying the store write until the push resolves. The store write is what puts the
recording in front of the person who just made it; a failed upload must not also mean an empty table.

**Check:** DevTools → Network on a stop shows exactly one `POST /api/sync`. Then re-run the query in §1.1
on a freshly made recording: `rewritten_after_s` should be `0.000`, or the column should be null-ish
because `updated_at = created_at`.

---

### Fix 2 — say that it is still going up — **DONE 2026-08-28**

The recorder card now says `Sending 54157 events to your account…` and only announces the count once the
account has acknowledged it; the row's status cell shows `Sending…` with a spinner, ahead of both `Ready`
and `Skill saved`, because while it is in flight both of those claim it is on the account; and the
transcript panel shows *Still going up to your account* instead of the 404 block and its *Put it back*
button, and re-reads itself when the upload lands rather than waiting for *Try again*. The panel subscribes
to one id (`useIsSending`) rather than the whole registry, so a long session cutting parts does not wake it
on every one.


**Now:** [`RecordView.tsx:567`](../web/src/features/record/RecordView.tsx) puts the row in the table and
[`:568`](../web/src/features/record/RecordView.tsx) says `54157 events captured` — which reads as finished
— and only then does the upload start. During those seconds *View* works, the panel asks the account for a
row that is not there yet, and `api/transcript.js` answers `no recording with that id on this account`.
For a 4-hour recording that window is seconds long and entirely invisible.

**Should be:** a recording the account has not acknowledged yet looks unfinished, and the transcript says
*not yet* rather than *not there*.

**Suggested shape.** The registry from Fix 1 already knows this. Use it for:

- the row's status cell in `RecordingsTable.tsx` — `Sending…` with a spinner instead of `Ready`;
- the recorder card's note — `Sending 54157 events to your account…`, then the count when it lands;
- `TranscriptPanel` — when the id is in the registry, show *still being sent to your account* and retry by
  itself, instead of the 404 block and its *Put it back on my account* button.

**Check:** with the network throttled to Slow 3G, stop a recording of a few thousand events and press View
immediately. You should see the sending state, and the transcript should appear on its own when the upload
lands — with no error at any point.

---

### Fix 3 — a recording too large for localStorage must not be lost in silence — **DONE 2026-08-28**

The write retreats instead of swallowing. Private mode is told apart from a full quota by writing a
one-byte probe, not by the error's name — Safari's private mode throws the same `QuotaExceededError` with a
quota of zero, and the codes differ between browsers. `persistTrouble()` then carries the fact, and the
Record screen says which of the two happened in two different sentences.

The retreat: the biggest recordings **that are already on the account** give up their local `events`, one at
a time, until the console fits. A recording with no `syncedAt` never does — it is the only copy, and
freeing it is the loss this was written to prevent; if the console only fits at its expense it does not fit,
and the screen says *do not close this tab until it syncs*. That rule lives in `api/_quota.mjs` as a pure
function precisely so it can be **executed** by `api/_test-quota.mjs` rather than read.

Two things that had to come with it. The counts are stashed on the row before the events go, so the table
still shows `54157 events` rather than `0` — a wrong number presented as a fact is worse than the failure
it describes. And `api/_flow-for.mjs` now **refuses** to build a row for an emptied recording: the payload
is built from `rec.events`, so pushing one up would overwrite the account's good payload with nothing —
destroying the last copy by way of an action called "save". The refusal sits at the single payload builder
because it has four callers.

Not done, and deliberately: the plain Record path still does not fall back to `long-session.ts` above a
threshold. That is the larger and better fix and it is a separate commit, as this document already says.


**Now:** [`store.ts:237-247`](../web/src/lib/store.ts) serialises the **whole** console — every recording
together — into one localStorage slot, and swallows the failure:

```ts
} catch (_) {
  // Private mode, or a full quota. The session still works; only persistence is lost.
}
```

Today's 4-hour recording is 5.85 MB on its own, against roughly 5 MB for the whole origin. It is on the
account and in memory; it is almost certainly not on disk. Nothing anywhere says so. Worse: because the
slot is one string, one oversized recording makes **every later write fail too** — the `syncedAt` stamp,
the `lastSync` receipt, and any other recording made in the same session.

**Verify first, in one minute:** on the machine that made the 4-hour recording, reload the tab. If the
recording drops out of the table and comes back as *N recordings on your account are not held here*, the
write failed.

**Should be:** persistence failure is a fact the app knows and can say. At minimum the catch has to
distinguish `QuotaExceededError` from private mode and record it; a recording that could not be persisted
should be shown as living on the account rather than pretending to be local, and the write should be
retried without it rather than abandoned so that everything else in the console still persists.

**Do not** solve it by silently dropping the oldest recordings. The machinery for splitting a long
recording already exists — `long-session.ts`, parts every 30 or 60 minutes — and the plain Record path
neither uses it nor warns that it should have been used. Making the plain path fall back to it above a
threshold is the larger and better fix; it is a separate commit from making the failure visible.

**Check:** make a recording large enough to exceed the quota, reload, and confirm the app says what
happened rather than showing an empty table.

---

### Fix 4 — a failed "Put it back" must not leave the old error underneath the new one

**Now:** [`TranscriptPanel.tsx:818-832`](../web/src/features/record/TranscriptPanel.tsx). A **successful**
restore bumps `attempt`, which re-reads the transcript. A **failed** one only calls `setNote`. The body
keeps its 404, its explanatory prose and its button exactly as they were, and `note` is cleared only when
`flowId` changes. So the panel renders one sentence about the row's state now and another about its state
minutes ago, with nothing to tell them apart.

That is what put those two contradictory sentences on one screen.

**Should be:** the failure path clears `problem` too, or bumps `attempt` so the body is re-read.

**Check:** force a restore failure (temporarily make `restore()` throw) and confirm the old 404 block
disappears when the new error appears.

---

### Fix 5 — the 404 says three different things in one sentence

**Now:** [`transcript.js:278-290`](../api/transcript.js). `readFlow`'s `WHERE` has three conjuncts — owner,
id, not tombstoned — and any of them failing yields the same words: `no recording with that id on this
account`. The panel then regex-matches those words at
[`TranscriptPanel.tsx:806`](../web/src/features/record/TranscriptPanel.tsx) and prints a specific causal
claim it never checked:

> This browser still has it. A recording and a skill made from it are the same thing on your account, so
> deleting it in Skills takes the recording with it — putting it back is the same save that happens when
> you stop recording.

For a row that has simply not been written yet, every clause of that is wrong. The cure it advertises no
longer works either: `sync.js` now refuses a push against a tombstone rather than clearing `deleted_at`.

**Should be:** three answers — *not yours*, *not there*, *deleted* — and prose that follows the one that
applies. `api/_recording-tools.js` already separates these cases against the same table; copy that shape.

**Check:** each of the three cases produces different words, and the *Put it back* button appears only for
the one it can actually fix.

---

### Fix 6 — `syncedAt` is the browser's clock, compared against the database's

**Now:** [`_flow-for.mjs:36`](../api/_flow-for.mjs) sends `updated: rec.syncedAt`, which is stamped with
`new Date()` in the browser after a clean push ([`RecordView.tsx:597`](../web/src/features/record/RecordView.tsx),
[`Reconciler.tsx:136`](../web/src/features/record/Reconciler.tsx)). [`sync.js:413`](../api/sync.js) compares
it against `updated_at`, which Postgres stamps with `now()`. Two clock domains in one `<`.

It is only reachable from the *Put it back on my account* button — every automatic push sends
`updated: null` — but on that path a browser clock behind the server's makes the refusal permanent, and no
code path anywhere can repair it: the push response carries no timestamp for the client to adopt, and the
Reconciler deliberately preserves an existing stamp (`rec.syncedAt ?? now`).

**Should be:** the push response returns the `updated_at` the server actually wrote, and the client stores
that. Then both sides of the comparison come from the same clock.

**Check:** set the machine's clock back five minutes, press *Put it back on my account*, and confirm it
still works.

---

## 3. Things that look wrong and are not

### 3.1 The pull budget is not permanent — do not "fix" it

`PULL_BUDGET_BYTES = 3_000_000` in [`reconcile.ts:38`](../web/src/features/record/reconcile.ts) defers a
large recording by **exactly one pass**, not forever. Rows already held locally `continue` before the size
is charged, and the first missing row of every pass is exempt at any size. Measured by running the function
against a 400 KB row and a 3.3 MB row:

```
pass 1: pull=[mac]  left=[win]
pass 2: pull=[win]  left=[]
```

The *Bring it here* button only did sooner what the next pass would have done anyway.

What **is** wrong there is one line of copy: the receipt says *this browser holds about 3MB of recordings*
([`RecordView.tsx:1145-1149`](../web/src/features/record/RecordView.tsx)) next to a number that means
something else — `spent` restarts at zero each pass and never counts what the browser already holds. Fix
the sentence, not the budget.

### 3.2 The transcript reading the account is not a bug

The transcript is derived server-side from the stored payload. A recording that has not reached the account
has no transcript to show, and that is by design. Fix 2 is about *saying so*, not about reading locally.

### 3.3 The `+724 s` row is unexplained

`MouseFlow 26/08 11:06:31` was rewritten twelve minutes after it was created — not the few seconds every
other row shows. That is a third write from somewhere: a *Put it back* press, a skill made from it, or the
other machine. It is the only row of twelve like that. Do not build a theory on it; if it happens again,
capture the network log at the time.

### 3.4 What the incident sequence was, exactly

Not established. Two readings survive — the push had not landed when the panel asked, or something rewrote
the row between the two moments — and the screenshots cannot separate them. Every fix above stands without
choosing one, which is why they are written as six independent defects rather than one story.

---

## 4. When you are done

Re-run the query in §1.1. On recordings made after Fix 1, `rewritten_after_s` should be `0.000`.

`npm test` at the repo root, and `npm run build` in `web/`. The suites that touch this path are
`agent/test-contract.mjs` (which reads these files as text — expect to update the regexes if you move a
line it pins) and `mcp/test-mcp.mjs`.
