# 25 — Checks, and what makes a run a test

A run that *did* something and a run that *proved* something are different things, and until September 2026
this product could only do the first. `expect` is the second.

This page is the anchor for the work in [`docs/QA-ROADMAP.md`](../QA-ROADMAP.md), which takes the agent from
"reliable on short tasks" to nightly regression testing. Two rules are written here first, because
everything after them depends on being able to say what a green report is worth.

## The two rules

**An assertion is only as strong as its evidence tier.** Four tiers, strongest first:

| Tier | Decided by | Where it comes from |
|---|---|---|
| `dom` | a selector against the real document | the browser extension; a DevTools connection to an Electron app |
| `tree` | UI Automation (Windows) / Accessibility (macOS) | `expect` today |
| `ocr` | text recognised on screen | not built yet |
| `picture` | a model looked and said so | `finish`'s own sentence, `note` |

Every recorded check names its tier. A case whose checks are all `picture` is **exploratory testing, not
regression** — it may be useful, and it is not something to gate a release on.

**Every step a model decided is marked as such.** A model decision is a source of variance: the same case
can pass today and fail tomorrow for reasons that have nothing to do with the product. A regression case
with unmarked model decisions cannot be trusted to be flake-free. (Recorded steps are deterministic; the
repair path in roadmap item 4 marks what it repaired for exactly this reason.)

## `expect`

One tool, in the same vocabulary as the rest (`api/_brain.mjs`):

| `check` | Asks | Needs |
|---|---|---|
| `present` | is this control on the window at all | `name` |
| `absent` | is it gone | `name` |
| `value_is` | does this field hold exactly this | `name`, `text` |
| `value_contains` | does it contain this | `name`, `text` |
| `enabled` | can it be used | `name` |
| `disabled` | is it unavailable | `name` |

Plus `why` — **required** — which is what the check proves, in the goal's own words. It is what a person
reads in the report a week later, and a check nobody can read is a check nobody will trust.

Names are matched the way `find_element` matches them: exactly first, then case-insensitively as part of a
name. So `present` with the text of a message is how "the words *Saved* are on screen" is asserted.

**It rides on `action=find`, deliberately.** The wire needs nothing new: the agent's find answer already
carries everything a verdict needs — whether the name is there, how many match, what a field holds, and
whether it is disabled (`Line()` in both agents prints `= "…"` and `(disabled)`). So checks work on **every
agent that can already find**, with nothing to install on anybody's machine — and asking somebody to update
their agent is the most expensive request this product has.

**A failed check does not end the run.** The model is told what happened and decides what it means for the
goal. Ending the run on a failed assertion would make the agent the judge of its own errand.

## Three outcomes, not two

`pass: true`, `pass: false`, and **`pass: null` — could not be checked**.

This is the same principle every other absence here follows: a missing capability flag means "too old to
say", a missing `#ctx` means "not known". A window that could not be read and a window in which the named
thing is genuinely missing are **different facts**. Merged, the first would eventually be painted green — a
check that proved nothing, counted as a check that passed — and that single confusion is what would make a
regression suite worse than having none.

What produces `CANNOT CHECK`:

- the window could not be read, or the agent answered with an error;
- `value_is` where several controls share the name (a claim about a field picked at random proves something
  else);
- `value_is` on a control with no value, or on a password field, which is deliberately never read;
- a check name the deployment does not know.

The arithmetic is `judge()` in `api/_expect.mjs`, and it is checked **by execution** in
`api/_test-expect.mjs` — 47 checks against the exact strings both agents print. If an agent ever rewords its
find answer, that suite fails, which is the only place such a change can be caught before a nightly run
starts painting green the thing it no longer understands.

## What is recorded

Each check becomes a step in the run:

```json
{ "tool": "expect",
  "input": { "check": "present", "name": "Send", "why": "the mail can be sent" },
  "outcome": { "pass": true, "how": "tree", "evidence": "button \"Send\" at 1074,159" } }
```

And the run gets a summary in `user_run.checks` (`db/019_run_checks.sql`):

```json
{ "passed": 3, "failed": 1, "unchecked": 0, "tiers": { "tree": 4 } }
```

**`checks` is not `outcome`, and this separation is the whole point.** `outcome` answers *did the agent carry
the procedure through*. `checks` answers *did the product behave as the person said it should*. They come
apart in the case that matters most, and for a test it is the ordinary case rather than an edge: the agent
did everything asked, and the thing it checked was wrong. That run is `ok` with a failed check, and it is
the most valuable row in the table — **it is a found bug**.

Collapsing them would force a choice between two lies: call it `failed` and the report blames the agent for
the defect it just found, so nobody can tell a broken product from broken automation; call it `ok` and the
nightly regression is green while the product is on fire.

`checks` is **null** on any run that asserted nothing, which is most of them. Absent means "this run made no
claims", never "its claims failed".

## Kept frames

A failed check in words is a claim about a screen nobody can look at any more. *"Saved is not on the window"*
is exactly as trustworthy as the parser that said it — which is the point of `expect` — but the person
reading a red line at nine in the morning wants to know **why** it was not there, and no amount of words
gets them there. A regression suite whose failures cannot be diagnosed ends one way: people stop reading it.

So a few frames are kept (`db/020_run_artifact.sql`), and only the ones that prove something:

| Kind | When |
|---|---|
| `check` | a turn that asserted something and every assertion held |
| `failure` | a turn with a failed check in it, or the screen a run ended badly on — **any** bad ending: a failed `finish`, six turns with nothing moving, the step ceiling, a model refusal |
| `final` | the last screen of a successful run **that made checks** — a green report with no picture is nothing to check against |

**One frame per turn, not per check.** A turn can make five checks in one batch; they were all decided from
one screen, and five copies would be five times the storage for the same evidence. So the frame's `step_no`
names the first step it covers, and its `said` carries what that whole turn proved.

**A failure frame is never the one thrown away.** Twelve frames per run (`ARTIFACTS_PER_RUN`), and when a
run goes over, the oldest **passing** checks go first — they confirm what is already green. Failures and the
final frame stay; they are what the table exists for. The rule is `dropWhich()` in `api/_artifact.mjs` and
it is checked by execution in `api/_test-artifact.mjs`, because a cap that silently discarded exactly the
picture somebody needed is the kind of loss noticed a month later.

Numbers, so nobody has to work them out: **250 KB** a frame at most (a heavier one is *declined with a
sentence*, never silently downscaled — there is nothing here to downscale with, and a cropped picture in a
report is not what was on screen), **12** frames a run, kept **30 days**. That is up to 3 MB for the most
talkative run and two frames for an ordinary one. The prune runs on the way past the next insert — the same
"lazy cron" as schedules, and for the same reason: a cron in the cloud is a second mechanism that can fail
where nobody looks.

**Both drivers, one rule.** The loop decides *which* frame to keep and says so (`out.keep`); it never
touches the database, because it is run by a test suite with no network. The cloud path writes it inside
`?worker=step`, which is the only place with both the picture and the database; the page hands it to
`/api/artifacts` through the `onArtifact` callback. Two rules would mean one run has a picture of its
failure and an identical one does not.

**It is somebody's screen.** A frame contains the whole screen, including windows that have nothing to do
with the run. It lives under that person's account, is deleted with it (`run_artifact` is in the erase
transaction, and the answer counts it), and is served `private` with no sharing path of any kind. See
[17 — Privacy and security](17-privacy-security.md).

Without `db/020` applied, runs work exactly as before and no frames are kept: the route says which migration
is missing rather than answering 500, and the cloud writer swallows the error entirely.

## What a person sees

In the live feed on the Create page and in the run's history, a check reads as an assertion with its
evidence, coloured by outcome:

- **check that "Send" is there** — button "Send" at 1074,159 (tree) — green
- **check that "Saved" is there** — "Saved" is not on the window (tree) — red
- **check that "Error" is gone** — could not check: could not read that window (tree) — amber

Three colours because there are three outcomes. The words come from one place
(`web/src/features/create/verdict.ts`) for both history lists, so the two can never disagree about what
amber means.

Under a run's steps in the history panel is a strip of the frames it kept — one button per frame, labelled
by step and by what it is (*what it proved*, *where it failed*, *the last screen*), the failures in red.
Clicking one opens the full screen with the evidence under it. The strip asks for the list only when a run is
expanded, and only the list: the pictures themselves are fetched one at a time, because twelve frames are up
to 3 MB and the panel shows ten runs.

## One thing this does not close yet

**Applications that name nothing in the accessibility tree.** Electron apps (Slack, Teams, VS Code, and
most internal tools built the same way) frequently do, and there `expect` answers `CANNOT CHECK` — honestly,
and uselessly. Four layers close it, and they are in
[`docs/QA-ROADMAP.md`](../QA-ROADMAP.md) → Appendix A: forcing Chromium to build its full accessibility
tree, OCR from the operating system, a DevTools connection, and image anchors for unlabelled icons.

Until then, the rule at the top of this page is the guard: a case that can only be proven by `picture` is
exploratory, and it should not be the thing a release is gated on.

## Where the reasoning is written

| | |
|---|---|
| `api/_expect.mjs` | the verdict, the three outcomes, and why an unreadable window is not an absence |
| `api/_artifact.mjs`, `api/_test-artifact.mjs` | which frames survive a full run, and why a failure is never the one dropped |
| `db/020_run_artifact.sql` | why the pictures are a row and not a blob store, and why one per turn |
| `api/artifacts.js` | the page's door to them, and why listing and reading are two requests |
| `api/_test-expect.mjs` | 47 executable checks against the strings the agents actually print |
| `api/_brain.mjs` | the tool, the rule in the system prompt, why it rides on `find`, and `LOOKS_ONLY` |
| `api/_step.mjs`, `web/src/lib/desktop-engine.ts` | the two drivers, judging with one parser |
| `db/019_run_checks.sql` | why `checks` is not `outcome` |
| `docs/QA-ROADMAP.md` | the remaining seven items, and what each one closes |
