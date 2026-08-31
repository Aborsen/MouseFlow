# 08 — Dashboard, and the assistant

`/dashboard` (also `/insights`, the old path, kept because it is linked from a published roadmap review).
Files: `web/src/features/insights/InsightsView.tsx`, `web/src/features/chat/ChatView.tsx`,
`api/insights.js`, `api/chat.js`, `api/_recording-tools.js`, `api/chats.js`.

Two things on one page, deliberately: the numbers, and something you can ask about them. They were two
screens once, and a separate address made somebody retype the window they were already looking at.

## The rule the whole page rests on

**No derived arithmetic.** Everything shown is a field `/api/insights` sent. Where the stored data cannot
answer a question, the endpoint says so in `gaps` and the page prints it under its own heading. Inventing a
plausible number is worse than admitting the gap, because a made-up number gets believed.

There is also **no chart library**: every mark is a `div` or a line of inline SVG. A dependency for eight
bars would be the largest thing in the bundle.

![The Dashboard](../img/dashboard.png)

*Every figure is a field `/api/insights` sent; nothing is
derived in the browser.*

## Controls

| Control | Behaviour |
|---|---|
| **Today / 7 days / Custom** | The range. A control, not a filter buried in a menu — it is the first thing anyone changes. 30 and 90 were presets and were removed: three presets plus a calendar is four controls answering one question, and a quarter of runs is a range you pick with real dates. Custom still reaches the server cap of 365. **The window is in the address** (`?days=7`, or `?from=…&to=…`) — the same three parameters the endpoint itself reads, so a link is the request and not a second language. |
| **A column of the day chart** | Narrows the whole page to that day. The window it writes is cut on **UTC** midnight, not local: that axis is UTC because `date_trunc` uses the database's zone, and cutting the drill-down locally would hand back a different set of runs from the ones the column counted, with nothing on the screen to explain the difference. Each column is a real `button` carrying the day, the counts and the agent time as its accessible name — it used to be one `role="img"` for the whole chart, which made every column's own label unreachable to a screen reader. |
| **Refresh** | Re-reads the window. |
| **Ask about this** | Brings the assistant panel back. It is only shown when there is no other way in: the panel carries its own minimise and close, and minimised it leaves a rail on the right edge. The state is remembered (`mouseflow.insights.assistant`: `open`, `min` or `closed`), and so is its width. |
| **Mine / a team** | Whose numbers. Only shown to somebody who owns or administers a team; see [Whose numbers](#whose-numbers). |
| **Everybody / one member** | Narrows a team view to a single person. Appears once a team is being shown. |

## Whose numbers

Yours, unless you switch. An owner or an admin of a team can point this page at that **whole team** — every
member's recordings, runs and skills, counted exactly the same way. It is the only place in the product
where one person's screen adds up somebody else's work, so three things hold it in place:

- **The switch is offered only to somebody who owns or administers a team.** `api/_team-scope.js` checks the
  role again on every request; a control that is merely hidden is not a rule. A member who edits the address
  is refused by name, and a team they are not in at all answers `404` — which does not confirm it exists.
- **The scope is in the address** (`/dashboard?team=t_ab12`), so a link opens what the sender was looking at
  and a screenshot of "47 runs" can be traced back to whose.
- **The team view shows work, not screens.** Precisely — because a vaguer claim was made here first and it
  was too strong. Visible to a team's owners and admins: counts, durations and outcomes; application and
  process names, and for older desktop recordings the *window title* where that is the only thing naming
  one; skill and recording names; the **goal wording** of runs that happened more than once; and the
  **reason text** of failures. Not visible in any scope: the events inside a recording, its transcript, its
  chat, or per-step detail of what was clicked. Nothing anybody typed exists anywhere in this product to be
  shown. The line is *work product a manager can already see on the roster*, not *only numbers*.

The team view adds a **Who did what** table — one row per member, over the window on screen — and gives the
skills table a *Whose* column. Everybody gets a row, including the people with nothing in the window, since
a table that silently omits a quiet fortnight reads as a roster with somebody missing.

### One member at a time

A second control narrows the team view to a single person (`&person=<uuid>`), which is how a manager asks
"and how is one person getting on" without reading nine people's numbers as one. The permission does not
change — it selects a subset of accounts the caller could already count, and `api/_team-scope.js` checks the
id is actually in that team, because a uuid in a query string is no more a permission than a team id is.

Two details that keep it honest. The **roster stays whole** while the counting narrows, so the picker still
offers everybody — a filter you cannot get out of is a dead end. And the **Who did what** table disappears
while one person is selected: a one-row table under a header that already names them is noise, and a table
still summing the whole team under a header counting one person is a contradiction.

### The assistant follows the scope

It used to be switched off on the team view, because it reads one account and would have answered about your
six runs beside a header counting the team's ninety. It now takes the same scope the page does — team, or
one member of it — resolved through the same `api/_team-scope.js` check, so the panel can only ever read
what the page beside it was allowed to count.

What it may reach in a team scope is a **whitelist**, not the personal tool set with the dangerous parts
removed: `summarize_time`, `list_skills`, `find_repeated`, `search_runs` and `team_people`. Three things are
deliberately absent, and each would be a real breach rather than an untidiness:

| Absent | Why |
|---|---|
| `get_run` | returns a run's steps — per-moment detail of a colleague's screen |
| `get_transcript`, `list_recordings` | the transcript of a recording, and window titles out of its payload — the content half of the line `db/008_team.sql` draws |
| `remove_steps`, `undo_edit` | **writes**. An owner editing a colleague's recording from a chat panel is not a reporting feature |

A whitelist because the failure modes are not symmetrical: a tool wrongly left out makes an answer worse, a
tool wrongly left in hands somebody another person's work. New tools are personal-only until somebody adds
them to that list on purpose. The panel also labels whose history it is reading, and its three starter
questions change with the scope — "Where did my time go last week?" is the wrong question to offer beside a
header counting nine people.

The full account of the roles is in [22 — Teams](22-teams.md#the-teams-dashboard).

## What is counted, and how

One read-only transaction per request. Not tidiness: the totals, the day series and the per-application
split have to **agree with each other**. Eight separate queries with a sync landing between two of them
produces a page whose header and chart contradict each other, and no reader can tell which half is wrong.

Where the time numbers come from, precisely:

| | |
|---|---|
| A recording | `payload.events` carry the pause since the previous event, and a browser `path` event's points carry a `dt` each. The sum is real, measured, elapsed time. **Both spellings are read** — the extension writes `delay`, the desktop recorder writes `delayMs` — because assuming one silently gives the other half a duration of zero. |
| A run | `started_at` to `finished_at` is wall clock. An extension run's steps also carry a per-step `ms` and the page each step acted on, which is the only per-application timing anywhere in the schema. A desktop run's steps carry `{ tool, input }` and no timing at all. |

Two thresholds, and both are duplicated in the transcript engine **on purpose** — if one changes without
the other, the Dashboard and a transcript will report different durations for the same recording and both
will look authoritative:

- **`EVENT_GAP_MAX_MS` = 120 s.** A longer gap inside a recording is somebody away from the machine, not
  time in an application. In the per-application split the part beyond it is **dropped**, not bucketed, and
  how much was dropped is reported — so the drop is visible rather than quietly flattering. In *How the
  time was spent* the same threshold is the boundary above which a pause is **away from the machine**, which
  is why it now has exactly one definition (`api/_digest.mjs`) that `api/insights.js` imports: two copies of
  it would let the applications table and the attention split disagree about the same two minutes.
- **`ACTIVE_MAX_MS` = 5 s.** The boundary between doing and waiting, and **chosen rather than measured** —
  worth saying, because it decides a headline share. Under five seconds a pause is inside an action (reading
  a label, aiming); over it, between two actions. Two seconds would call half of ordinary work waiting; ten
  would hide reading an email. Measured consequence on the live account, so the choice can be argued with:
  45% doing, 25% waiting, 29% away, out of 20.9 hours.
- **`RUN_MAX_SECONDS` = 12 h.** A longer run is two machines' clocks disagreeing, not a run.

Anything that cannot be attributed to a named application goes in **one** bucket and is reported. Spreading
it proportionally would make every number slightly untrue and none of them checkable.

## The sections, in the order they are read

The page is scanned rather than read, so it is built in that order: the shape of the window first, then the
things that want a decision, then the flat tables.

| Section | Holds |
|---|---|
| **Header cards** | Six, in two rows of three: **recordings**, **skills made** and runs; then success rate, agent time and the count worth automating. Success rate = finished ÷ (finished + failed) — stopped and still-running are left out of **both** halves. Every one of them is *this window*, not all time, and each says so in its own note: a lifetime total in the same row as a seven-day count is the tile somebody screenshots and misreads. The comparison against the previous window states whether there *was* one rather than inferring it from a zero. |
| **Activity by day** | Runs per day, with the finished/failed split. Bars, scaled to the tallest day. Each bar is also the drill-down into that day — see Controls. |
| **How the time was spent** | The measured time inside recordings, split three ways: **doing**, **waiting or reading**, **away from the machine**. One bar rather than three tiles, because the three parts add up to the whole by construction and drawing them apart invites a reader to add them up and get something else. Both boundaries are printed under the numbers they decide — a share of "waiting" is unreadable until you know how long a pause has to be to count. The comparison with the previous window is in **points**, never as a percentage: 46% against 38% is eight points, and "+18%" is the commonest way a dashboard misleads without containing a false number. |
| **What was actually done** | Events by kind, then the individual actions by name — `Key Backspace`, `Scroll Down`. Pointer movement is held out of both lists and stated on its own line: it is 86% of all events, and ranked beside the clicks it buries them. Typed text is never stored, so this can say how often Backspace was pressed and can never say what was written. |
| **Processes that look alike** | The sequence of applications a recording moved through, consecutive repeats collapsed, listing only the sequences that appear in **more than one** recording *and* that have **at least two steps**. Names are case-folded, so `claude` and `Claude` are one application rather than two. The second condition is not a tidiness: a one-step "pattern" says only that a recording never left one application, and under this heading "6× Google Chrome" read as *you did the Chrome process six times*, which the data does not support and nobody can act on. On the live account that filter removed three of eight repeats, and all three were that. This is *Worth automating* asked of the recordings instead of the runs — work being done by hand twice, before anybody has written a skill for it. It claims a candidate, not a saving: the same three applications in the same order can be two different jobs, which is why the heading says *look alike*. |
| **Worth automating** | Goals that ran more than once in the window, with the times and what those runs took. **Not a saving** — the tooltip says so, and so does the gaps list. Matching is on identical goal text (see the limit below). |
| **What went wrong** | Failure reasons, grouped, with how often and an example run. |
| **Where the time went** | Per application (or per origin for browser flows): recordings, runs, seconds and share. Plus the **unattributed** slice as a named row with its own explanation, so the shares add to one and a dataset where most time cannot be placed *looks* like one. |
| **The slowest steps** | Per tool: calls, median, p90. Only tools called at least twice — a median over one call is that one call wearing a hat. |
| **How each skill is doing** | Per flow: runs, finished, failed, median seconds, last run. |
| **What this cannot tell you** | The gaps, under their own heading. |

Every list is capped and **every cap is reported with the total it was cut from**, so the page can say "top
12 of 34" instead of implying it is everything: applications 12, repeated 10, slowest steps 10, failures 10,
skills 20, repeated sequences 8, individual actions 10.

The denominator has to be the list the cap actually cut, which is subtler than it sounds: the patterns cap
reports the number of **repeated** sequences, not the number of distinct ones. Reporting the latter would
have the page print "showing the top 8 of 28 repeated sequences" on an account with eight repeats and twenty
one-offs — a true number in a false sentence, with nothing on the screen to give it away. One cap merges
rather than truncates and is named for that reason: a sequence is cut to **8 steps**, so two long processes
that begin alike are counted as one.

**Where the three behaviour blocks come from.** Not from the runs — from one derived row per recording
(`flow_digest`, see [15 — Data model](15-data-model.md)). A recording made a minute ago may not have one
yet, and then "46% doing" is the truth about *some* of the window, which looks identical on screen to the
truth about all of it. So the count of recordings still to be summarised is **on the page**, once, saying it
covers all three blocks; and if deriving fails outright the blocks say so in the endpoint's own words while
the rest of the page carries on — see [14 — HTTP API](14-http-api.md#apiinsights) for how that survives the
transaction being indivisible, which it did not at first.

![Activity, the work worth automating, and what went wrong](../img/dashboard-sections.png)

## The gaps

First-class, not a footnote. Each is a question somebody will ask of this page and the reason the stored
data cannot answer it, with the real count from *this* window — so a gap that has stopped applying shows a
nought rather than being a warning nobody rereads.

**They are no longer printed at the bottom of the page.** Read there, unasked for, they came across as a
disclaimer rather than as what they are, which is answers. They are still in the endpoint's response and
the assistant reads them, so "why does this not tell me what I saved" gets those exact words at the moment
somebody asks the question — which is where an answer belongs. Among them:

- **How much time did this save me?** Nothing holds how long the same task takes by hand, and there is no
  field for it. Every "time saved" number in a product like this is a baseline somebody typed.
- **Where did the time go inside a desktop run?** A desktop run's steps carry only the tool and its input.
  Only the whole-run duration is known.
- **What did the model say while running?** `user_run.said` is empty on most rows.
- **Was that really the same task twice?** `find_repeated` matches **identical** goal text. Two goals
  differing by one name are not clustered: there is no similarity index here, and a LIKE-based guess would
  be presented as a finding.
- **Skill-by-skill totals over all history** — `user_run.flow_id` was NULL for every historical row and is
  only now being written, so anything grouped by skill covers recent runs only.

## The assistant

A panel beside the numbers. `POST /api/chat`.

### What makes it worth trusting

**The model explains the data; it never recalls it.** It has no memory of this account and cannot have one.
It is given read-only tools, the server runs the SQL, and the model writes prose over the rows that came
back. Every lookup is listed in `used` and every run those lookups touched is listed in `citations`, so an
answer can be **checked** instead of believed. That is the difference between a grounded answer and a
confident one.

The grounding is part of the answer rather than a disclosure underneath it: each reply shows the tools that
actually ran and the runs it cited, and a citation is a **button** — pressing it prints that run's own id,
goal, outcome and timing, read out of the rows this page already holds. And the corollary, which is why the
warning is worded the way it is: **when the server cites nothing, the screen says the answer is general.**

### It starts knowing what is on the account

The assistant used to open every conversation blind: the rules, the tools, and nothing else — so "what do I
keep doing by hand?" cost it three lookups before it could write a first sentence. It is now handed a
summary of the account up front, which the digests made affordable: three short queries over one row per
recording, where the same thing over `payload` was 28 MB and several seconds. Measured at **208 ms and about
730 tokens**, and the tokens are the reason each part of it is capped rather than generous — 12 recent
recordings, 8 actions, 5 repeated sequences.

What it changes is not speed but the kind of answer available: the assistant can now notice something the
question did not mention.

Four things keep it honest, and each of them is a way it could otherwise mislead:

- **It says ALL TIME in its first line, before any figure.** It cannot know which window a question means,
  so a total quoted at "how was last week" would be wrong with nothing on the screen to reveal it. The
  instruction to use the tools for any window is part of the block, not a nicety beside it.
- **The rule about sources is amended rather than bypassed.** "Every number must come from a tool result" is
  the strongest line in this prompt, and the model now has a second source. So the rule names it — *a tool
  result in this conversation OR the account summary* — because a rule that ignores what the model was
  handed either forbids using it or silently permits everything.
- **The block is last in the prompt.** It is the longest part and the only part that is data rather than
  instruction; above the rules it would push them out of the model's attention.
- **Personal scope only.** A team conversation keeps its whitelist. A block of somebody's recording names
  and ids injected into a colleague's conversation would be a second route to the same data, reached
  differently and never reviewed as one.

It also never decides whether a question can be answered: the top-up write, the count of what is left and
the read are inside one `catch`. Without the summary the assistant is what it was before — it looks
everything up — and that is a slower answer, not a missing one. The failure is not reported to the asker,
because there is nothing they could do about it.

The recording ids in the block are the ones `get_transcript` takes, and the block says so: an id whose use
is not obvious is an id nobody uses.

### Scoping, which is not negotiable and not delegated

Every query filters on the user id `whoIsCalling()` returned, inside the `WHERE` clause, and **not one tool
takes a user id as an argument**. A model-supplied user id is the whole bug class here: one hallucinated
uuid and this becomes a route that reads somebody else's history. The schemas say
`additionalProperties: false` as a hint to the model; the real guarantee is that no code path reads an id
from tool input.

The transcript is rebuilt from the caller's `history` as **text turns only**, never as tool calls and tool
results. A caller who could post tool results could hand the model invented rows and have them answered as
though they came from the database — which is exactly the property this route exists to provide.

### The tools

Account-wide (`api/chat.js`):

| Tool | Arguments |
|---|---|
| `search_runs` | `days` (≤365), `outcome`, `flowId`, `contains`, `limit` (≤50) |
| `get_run` | `runId` — the goal, outcome, timing and up to 60 steps |
| `summarize_time` | `days`, `groupBy: day \| application \| skill` — **runs**, and its applications only from runs whose steps carry a url |
| `summarize_recordings` | `days`, `compare` — **recordings**: the doing/waiting/away split, actions by kind and by name, applications, and the repeated application sequences. Four things in one call |
| `recording_details` | `flowId` — the measured shape of one recording without reading what is in it |
| `list_skills` | `kind`, `limit` |
| `find_repeated` | `days` (default 90) — identical goal text, run more than once |

**`summarize_time` and `summarize_recordings` are not rivals, and the descriptions say so to the model.**
One groups agent runs; the other groups what a person did by hand. `summarize_time`'s application figures
can only cover runs whose steps carry a url, so a desktop run contributes nothing to them;
`summarize_recordings` covers every recording, desktop included. Neither is a subset of the other, so the
two *will* give different answers to "where did my time go" — and that is only a contradiction if either
forgets to name its evidence, which is why both descriptions do.

`summarize_recordings` returns four things at once rather than taking a `groupBy` like its neighbour. Three
of them come out of one query, the model is limited to a handful of **rounds** rather than to bytes, and
"how did my week go" wants all four — so a `groupBy` here would spend three rounds fetching parts of one
picture.

`recording_details` fills the gap between *find a recording* and *read a recording*: it answers how long,
where, and how much of it was waiting, off one short row, where `get_transcript` costs a whole payload. A
recording whose digest is not derived yet is told so **in words** — never as zeros, because "0 events" is a
claim about the recording rather than about what has been counted, and the newest recording is the one most
likely to be asked about.

One recording at a time (`api/_recording-tools.js`, registered alongside):

| Tool | Arguments |
|---|---|
| `search_recordings` | `text`, `limit` (≤25) — find recordings by the **names of things they touched** |
| `list_recordings` | `limit` (≤40), `source: web \| desktop` |
| `get_transcript` | `flowId`, `fromStep`, … — the same derivation the panel shows |
| `remove_steps` | `flowId`, the step numbers — **the only tool in the assistant that writes** |
| `undo_edit` | `flowId` — puts the previous payload back |

**`search_recordings` is the only way to reach the recordings by text**, and until it existed there was
none: `search_runs` searches what somebody typed *at an agent* — the goal, the summary, the error — so "which
recording was I working with invoices in" meant reading transcripts one at a time, and there are 45 of them
on the live account. It matches window titles, control names, the container a control sat in, applications
and page origins, ranks by how many of a recording's names matched, and hands back the matched names so a
result explains itself. A substring, so a stem finds its longer forms; see
[15 — Data model](15-data-model.md) for why not full-text search.

It **cannot** find what anybody typed, and the tool says so twice — in its description and in every result —
because that is the difference between "I could not find it" and "that does not exist". Personal scope only:
it names a recording by id, which is a step towards its contents rather than a count over many.

The derivation is **not repeated** in the tools module. `api/_transcript.js` turns a payload into a
transcript and is the only thing that does; a second derivation would drift, and then the panel on the
Record screen and the assistant beside it would describe the same recording differently, both looking
authoritative. It is imported **lazily**, so a missing file is reported as one tool that cannot run rather
than taking the whole assistant down.

### The one write, and its four guards

`remove_steps` exists because the assistant is where "remove those steps" is actually said. The failure it
is built around is not a database error — it is a model that misread the numbering and removed steps 4 to 6
of the wrong list.

1. The numbers are resolved against a transcript built from the payload **as it stands now**, and an
   out-of-range number aborts the **whole** call. A number the transcript does not have is evidence that the
   numbering in play is not this recording's; applying the half that happened to be in range is exactly the
   accident. Nothing is written, and the message says the real range.
2. The result describes what was removed in the **recording's own words** — the action and target of each
   removed step — rather than echoing the numbers it was asked for. A wrong removal is then visible in the
   answer, to somebody who was there.
3. The write is conditional on the revision the payload carried when it was read, so an edit made in the
   panel in between makes this fail instead of overwriting it.
4. Nothing is destroyed. The previous payload is kept and `undo_edit` puts it back; the last five versions
   are kept, and no more, because they compete for room with the recording itself.

### Limits and shape

| | |
|---|---|
| Rounds of lookups | 6 per question. Enough for "find the runs, open the worst one, check what else that day looked like", small enough that one question cannot become thirty model calls. On the seventh no lookup runs whatever the model asks for, and the answer says that is what happened. |
| Question | 2,000 characters |
| History kept | 16 turns, 4,000 characters each |
| Answer | 2,000 tokens |
| One tool's output | 12,000 characters, ≤50 rows, ≤60 steps, ≤30 groups |
| Providers | Anthropic (exercised daily) and OpenAI (written against the Responses API, **not** run from here — there is no key on the deployment yet) |

Both providers go through `api/_provider.js`, which normalises the conversation and — the part that matters
more — normalises **how a turn ended**: `end | tools | truncated | refused`. A truncated turn and a refusal
are not answers, and this route returns an error for both rather than presenting half a sentence as a
finding. Both decision loops in this product have filed a truncated turn as a successful run once; this does
not repeat it.

### Privacy, said plainly

Everything a tool returns goes into a prompt and is sent to the model provider — named back in `provider`.
That includes goals exactly as typed, which routinely carry an email address and the text of a message, and
step inputs, which carry whatever was typed into a page. **There is no way to answer "what did I do last
week" without sending what was done**, so this is a property of the feature rather than an oversight in it.

What is held back is the one class where sending it is never needed: text shaped like a **credential**.
Email addresses are deliberately not masked — "who did I write to" is a fair question about one's own
history, and masking would make it unanswerable.

## Saved conversations

`api/chats.js`, tables `chat_thread` / `chat_message`. Until these existed a thread lived in React state and
a reload was the end of it, which makes the assistant a calculator rather than something you can come back
to.

- **The client owns the ids** — a conversation exists in the page before it has ever been saved, and the
  first save must not round-trip for an id to attach messages to.
- **A conversation names itself** from its first question, trimmed. Nothing asks anybody to title one.
- The message index `n` is part of the key, so re-saving a turn overwrites it rather than appending a second
  copy: the page saves after every reply, and a retried save must not double the thread.
- **What the reply was grounded on is stored with it** (`meta`), so a reopened conversation shows the same
  "based on" panel it showed when it was new. An answer without its evidence is a claim, and this app's
  whole position on the assistant is that it does not make claims it cannot show the source for.
- **Delete means delete here**, unlike `user_flow`. A flow is tombstoned because two machines sync it and a
  delete has to propagate; a conversation is written by one client, read by one person and reconciled by
  nothing. Asking for a conversation to be forgotten and keeping it with a flag set would be the wrong
  answer to a reasonable request.

## Asking about one recording

The transcript panel's **Ask about this** hands the recording to this assistant and navigates here. The
question names both the recording and its id — the id is what `get_transcript` needs, the name is what a
person will recognise in the reply:

> Analyse my recording "MouseFlow 21/08 13:34:07" (id r7k2x9qa). What happened in it, where did the time
> go, and is there anything in it worth automating or cutting?

Taken exactly **once**. Opening the Dashboard again by hand must not re-ask the last question — that would
put the same request at the top of an empty thread every time somebody navigated here, which reads as the
app deciding what you wanted.

## Deliberately not here

- **Markdown rendering.** The reply is plain pre-wrapped text. No renderer is vendored, and a half-hearted
  regex one turns `**bold**` into noise.
- **What a run said.** `user_run.said` is never handed to the model; a citation shows goal, outcome and
  timing.
