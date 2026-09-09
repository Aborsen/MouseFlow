# 27 — Test cases

A skill answers *do this*. A case answers *is this still true* — and the difference is in what you do with
the answer: a skill that finished is done, a case that finished has a **verdict**, and thirty verdicts in a
row are the only thing that tells anybody their product still works.

![Tests: cases, the row of nights, and the verdict of each](../img/tests.png)

## What a case is

Three things, and nothing else:

| | |
|---|---|
| **the skill** that performs the steps | one made from a goal — see below |
| **its inputs** | exactly what `mouseflow_run` would take |
| **its checks** | what must be true when the run is done, in the same language as [`expect`](25-tests.md) |

That is the whole of `user_case` (`db/021_user_case.sql`). Its name is the fourth thing, and it matters more
than it looks: *"Outlook still sends"* is what somebody reads at nine in the morning next to a red dot.

**The skill has to be one made from a goal.** A recording is replayed by the agent with no model in the
loop: nothing reads the screen, so there is nothing to call `expect` with. Both doors refuse it — the page
and the tool — with that sentence rather than at two in the morning.

## Four verdicts, and `no verdict` is not a failure

The rule is `caseVerdict()` in `api/_case.mjs`, computed from the run's own `outcome` and `checks`, in this
order:

| Verdict | When | Means |
|---|---|---|
| **failed a check** | any check did not hold | the product did not do what it should — **a found defect** |
| **no verdict** | the run did not finish, or made no checks, or a check could not be evaluated | nothing was proven. Not a red |
| **passed · repaired** | everything held, but a step was repaired by the model | not yet stable enough to trust unattended |
| **passed** | the procedure ran and every check held | the only green |

**A failed check comes first, before "the agent did not finish."** A run where a check failed and the agent
then gave up is a defect, not a lost night; hiding it under *no verdict* would lose the one thing the whole
exercise is for.

**And nothing without evidence is ever green.** A run that reached `finish ok: true` and made no checks is
*no verdict*, not *passed* — that path is the most likely way to get a false green in this product, and it
is checked by execution in `api/_test-case.mjs` (more of its cases are about that than about passing).
Likewise a check that *could not be evaluated* (`pass: null`, see [25](25-tests.md)) never counts as one
that held.

**Mixing `no verdict` into red is the expensive mistake.** A night the agent could not open the application
painted the same colour as a found defect gets a report that nobody reads within a week — and with it, the
real defects stop being noticed. So it is grey, and the word says what it means.

The verdict is **not stored**. It is computed wherever it is shown, by one function that the page, the route
and the MCP tools all import — a stored verdict plus a changed rule for reading one is how a report starts
disagreeing with itself, with the old nights coloured by the old rule and nothing on screen saying so.

## The checks are appended to the goal, in words

A case run is an ordinary run whose goal has the checks written under it:

```
reply to Ann that the invoice is approved

THIS IS A TEST CASE. When the goal above is done, and before finish, check every one of these with the
expect tool - one call each, all of them, even when the screen makes the answer look obvious:
1. present "Sent Items" - the reply left the outbox
2. value_contains "Subject" = "Re: invoice" - it answered the right thread
A failed check does not end the run: say what it means and finish. Do not decide any of them by looking at
the picture, and do not skip one because the goal appeared to succeed - a check nobody made is the whole
reason a suite stops being trusted.
```

**Words rather than a field, and that is a deliberate v1 choice.** The assertions could travel as data and
be turned into `expect` calls mechanically, with no model involved — and that is the right shape for v2,
where a check is bound to a step. At the *end* of a run the machine is wherever the run left it: "Sent
Items" may be one click away or may need a folder opened, and only something looking at the screen can tell.
So the model is told to call the tool, and **the verdict is computed from the recorded steps** — not from
what the model said about them. It has nothing to lie with.

## Running one, and running it every night

Both go through the doors that already exist. `mouseflow_run` and `mouseflow_schedule` take `case` where
they take `skill`; the page has **Run now** and **Nightly**.

**Run now queues it, exactly as its schedule would.** It does not drive the run from the page the way
*Create* does — a button that exercises a different path is a button that proves nothing about what happens
at two in the morning. So it becomes a `run_queue` row, the machine takes it within three seconds, and it is
visible on [Activity](26-activity.md) like any other work, with the same Stop.

**Nightly is one button**: 02:00, weekdays, in the browser's own zone. Two in the morning because a case
moves a real mouse, and nobody should be sitting at that machine when it does. It is an ordinary schedule
row (`user_schedule`) with the case's id in its arguments — there is no separate table for "nightly
regression", because pausing, resuming, missed times, the local-zone arithmetic and *three failures in a row
pause it* are all written once already ([24 — Schedules](24-schedules.md)).

**The pointer, not a copy.** The queue row and the schedule row carry `args.__case = { id }` and nothing
else: the checks and the inputs are read from the case at the moment the run starts. A case edited this
morning is therefore checked tonight in its new form — the alternative silently tests last month's
assertions with nothing on any screen to say so. The cost of that choice is one query per run, and the fence
it needs is the same as for a deleted skill: *the case was deleted between the ask and the run*.

## The page

Two cards, shaped like [Skills](06-skills.md) and [Activity](26-activity.md): the library of cases with a
seven-row window, and the form that writes one down.

![One case open: its checks, its nights, and the check that did not hold](../img/tests-case.png)

Each row carries **the row of nights** — one dot per run, oldest on the left. Not "the last verdict": one
green dot says nothing about whether a case is stable, while *green, green, grey, grey, grey* says a great
deal, and what it says is about the regression rather than about the product. Beside it: what it runs, how
many checks, when it next runs by itself, and how many times its schedule was missed.

Open a row and it holds the checks in the words the model will read, the schedule's next run with the
condition attached (*runs only while that computer is awake and taking work*), and the runs — each of which
opens into its steps, the `expect` lines in green and red with their evidence, and the frames it kept. Those
are the same components the Create page's history uses (`describe`, `verdict.ts`, `Frames`): a second way of
showing steps would mean somebody used to one reads the other more slowly.

**A deleted skill is named on the row.** *the skill it ran has been deleted — this case cannot run*, rather
than a blank where a name should be: that case fails at the gate every night, and finding out before the
night is the point.

**Eight checks per case** (`EXPECTS_MAX`). Not a technical limit — eight checks at the end of one run is
still something a person reads, thirty is not, and a case with thirty assertions is almost always three
cases wearing one name. The refusal says the number.

## What the tools say

Three tools about cases, and **none of them runs anything**: writing one down, listing them, and reading one
case's history are three questions about cases. *Run this* and *have this run by itself* already existed, and
duplicating them for a new kind of work would mean two pairs of tools that have to change together.

| Tool | Answers |
|---|---|
| `mouseflow_case` | writes one down: name, skill, inputs, checks |
| `mouseflow_cases` | every case, what it checks, its next run, and how the last ten ended |
| `mouseflow_case_results` | one case's history, and for a failure **which check** did not hold, in the case's own words |

`mouseflow_case_results` is the answer to *"did anything break last night?"*, so a failed run prints the
assertion and the evidence beside it rather than a count: `1 check failed` sends somebody looking, and
`"Subject" holds "Re: invoce", not "Re: invoice"` is the bug.

Every list ends with the two sentences that keep a report honest: *no verdict is not a failure*, and *a case
runs only while its machine is awake and taking work*.

## What v1 does not do

- **Checks in the middle of a procedure.** All of them run at the end. Binding a check to a checkpoint of a
  plan is v2 (roadmap item 5-v2) and needs unattended runs to pass their own checkpoints.
- **Repairs.** `passed · repaired` is in the vocabulary and computed, and nothing marks a repaired step yet —
  that is roadmap item 4. It is here because the first repaired run must not arrive in a report as plain
  green.
- **Choosing a machine.** `user_case.machine` is a column and nothing reads it; a case runs wherever the
  account's agent is (roadmap item 7).
- **Editing a case from a chat.** The tool writes one; changing and deleting are on the page.
- **A case over a recording.** Refused, for the reason at the top: a replay has no model to check anything.

## Where the reasoning is written

| | |
|---|---|
| `api/_case.mjs` | the four verdicts and their order, the goal text, and why the id travels rather than a copy |
| `api/_test-case.mjs` | executable: no run without evidence is green, and a failed check is never hidden |
| `api/cases.js` | the page's door, and why the list asks the database for a count instead of shipping steps |
| `api/_queue.mjs` | one door into the queue, so *Run now* refuses in the same words the tools do |
| `db/021_user_case.sql` | why the assertions are a field of the case and not of its schedule |
| `web/src/features/tests/TestsView.tsx` | the two cards, the row of nights, and one button for nightly |
| `web/src/features/tests/verdicts.ts` | why `no verdict` is grey |
| `docs/QA-ROADMAP.md` | item 5, and the six items still open |
