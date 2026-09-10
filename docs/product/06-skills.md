# 06 — Skills

`/skills`. The flows on your account, from both halves, plus the way to connect the extension. File:
`web/src/features/skills/SkillsView.tsx`.

A skill is a flow with a name, a description and — where the goal had variable parts — parameters. It is
what makes something you did once worth handing to somebody else.

![The Skills page](../img/skills.png)

## What is listed here, and what is not

Recordings and skills share one table (`user_flow`), which is the right design: both are "a thing on your
account with a payload", both sync the same way, both tombstone the same way. What was missing is that
nothing said which one a row **is** — so the Skills page listed every flow, a recording appeared here
looking like a skill, and deleting that card deleted the recording *and* its transcript, which the Record
page then discovered as a 404.

So the writer stamps `payload.role`, and each page lists only its own kind
(`web/src/lib/flow-role.ts`):

| Row | Listed in Skills? |
|---|---|
| `role: 'skill'` | yes |
| `role: 'recording'` | no |
| no role, and this browser holds a recording under the same id | **no** — the one dangerous case that can be known for certain |
| no role, anything else | yes |

An unstamped row defaults to *skill* on purpose: treating them as recordings would empty the Skills page of
every skill anybody had already made. A recording made on another machine still shows here; the warning on
the delete covers that, and it stops mattering as soon as a recording is made by a build that stamps.

A delete button on this page can therefore only ever be over a skill — which is a guarantee rather than a
warning about a mistake somebody is about to make.

## Ready to become a skill

The block above the library: recordings this browser holds that have no skill yet, newest first, each with
**Save as skill**.

It is a **fixed-size block** — six rows is both the maximum (the rest are on Record) and the minimum
height. Without the floor it lost a row on every *Save as skill*: the page jumped under the cursor exactly
as somebody reached for the next button, and the second press landed somewhere else. The row height and the
list height are derived from one number (a measured 57.33px per row), because two similar literals would
drift apart silently and clip the last row.

When more exist than are shown, it says so — *"4 older ones are on the Record page"* — because silent
truncation reads as "this is all of them". The ones hidden are the **oldest**, which is what makes the
truncation acceptable.

### One outcome, and the wizard

![The wizard, step one](../img/record-skill-wizard.png)

![The wizard, step two](../img/record-skill-wizard-2.png)

![Where the recording could not see what was picked, answered](../img/record-skill-wizard-picked.png)

There were two. **Repeat it exactly** copied the recording's events and replayed them by screen position:
free, fast, literal — and unable to type, because keystroke content is never stored
([17 — Privacy](17-privacy-security.md)), so a recording that typed replayed without the typing and reported
the skipped events as `unplayable`. It is **gone**, with both buttons that offered it and the `saveAsSkill`
builder behind them. Two outcomes under one word is a choice somebody makes before they know the difference,
and the literal one broke whenever a window moved.

What is left of it: the `dr_<recording id>` prefix, because skills made that way are on accounts already and
`hasSkillFor()` has to recognise them — otherwise their recording returns to *Ready to become a skill* and
invites the same work twice.

**Make a skill** opens the wizard (`features/record/SkillWizard.tsx`), which asks for the part that was
deliberately never watched. Three screens:

1. **What it did** — the recording's steps, from `GET /api/transcript`, which is the one place that turns a
   payload into steps. Anything can be left out, and three kinds are left out for you, counted in one line
   rather than silently: pointer moves, waits and scrolls; clicks on something the resolver could not name
   (a goal made of coordinates would put back the fragility this path exists to escape); and **MouseFlow's
   own recorder controls** — the click that started or stopped this very recording. The last of those is
   bookkeeping about the recording rather than part of the work, and it is unexecutable besides: the agent
   refuses to drive its own windows, so a skill told to press *Stop and Save Recording* stops there. It is
   matched by containment and not by equality, because Windows names that button in the taskbar as the
   application plus the window title — `"MouseFlow agent MouseFlow agent - recording"`.
2. **Instructions** — free text first (*"Anything else it should know"*), then one card per typing run,
   naming the field it went into and how many keystrokes it was. Each is *ask each time* (a parameter, name
   and type prefilled from the field), *always the same* (a fixed string), or *type nothing*.
   **And one card per place the recording could not see a choice**: where a named click is followed by
   clicks that land on a container — `document`, `pane`, `group` — the accessibility layer reports the name
   of the *page*, so what was picked in the filter, the menu or the date picker is nowhere in the recording.
   That step carries a quiet chip on screen one and a row here; what somebody writes is appended to the step
   (*"click \"Add filter\", then choose dates from the 1st to today"*). It is an offer, not a question: empty
   means the step stays as it was, and nothing waits on it. `api/_choices.mjs` holds both rules, and requires
   the named opener immediately before the run — without that, a 6,705-step recording produced 144 of these,
   almost all of them clicks on empty space.
3. **Name it** — the assembled goal, editable. It stops following the choices the moment somebody edits it.

What comes out is a **created** skill: `goalTemplate` plus `params`, under `gs_<recording id>`. Which means
it is a tool the moment it is saved — `structureOf()` gives it typed, required parameters, and the MCP server
([21 — MCP server](21-mcp.md)) offers it with them.

**Why a goal and not a macro**, since the question is obvious: the five-column replay format has no `type`
action — its vocabulary is mouse plus `Focus` and `Key Down`, and `Key Down` carries no key — so a literal
typing skill means changing the parser in *both* agents. `/do` does type, but `/replay` is one shot, so a
hybrid needs a client orchestrating replay-type-replay, which is a third execution path. The goal path
already types (the model writes the text), already re-reads the screen (so a moved window stops mattering)
and already reaches an AI with its parameters. Nothing in either agent changes. The cost is a model call per
step — slower, and not free — which is the trade `api/_skill-schema.mjs` already states to a model in words.

**Why not just record the keystrokes.** Because a captured string is one instance. "Weekly report, 21 Aug"
is not a skill; `{{subject}}` is. A parameter has to be declared by somebody who knows what varies, so the
wizard would be needed either way — and asking once, at the moment the skill is made, captures nothing
sensitive by accident, ever.

### Saving as a skill

One implementation for every page that offers it (`features/record/save-as-skill.ts`), because a payload
written in two places will eventually disagree — that already happened with `flowFor`, where a restored
recording stopped matching the saved one.

| | |
|---|---|
| Id | `dr_<recording id>` — so saving twice **updates one row** instead of making a second, and so a recording can be *asked* whether it has a skill (that is what the Status column reads) |
| Role | `SKILL_ROLE`. Without it the row lands in the recordings list and is one day deleted from there as a recording, transcript and all |
| Events | **Copied** into the skill's payload. A skill is self-contained: deleting the recording it came from does not hollow it out. Two objects, two lifetimes |
| `source` | Carried over from the recording, never guessed |

## The library

Columns: checkbox, **Skill**, **Structure**, **Source**, **Updated**, **Status**, **Actions**. Same grid as
the recordings table, and its last column is a **fixed** width for the reason that one learned the hard
way: `auto` sizes to content, so a header word narrower than the buttons under it puts the whole row out by
hundreds of pixels.

- **Search** over the library.
- **Filters** — `All` / `Published` / `Private`. "All" is not a state a skill is in, it is the absence of a
  filter, so it sits beside them rather than being one of them in the data.
- **Structure** — the Signal (when its events happened) and what it takes as input.
- **Source** — `Desktop` or `Extension`, which decides who can replay it.
- **Status** — `Published` (with the listing id) or `Private`. The second is deliberately **not** called a
  draft: a skill that runs and is simply not shared is not unfinished. A skill published before this app
  started recording listings reads as private, and the tooltip says exactly that.

### Row actions

| Control | Behaviour |
|---|---|
| **Use in AI** | The tool definition in three shapes, and a SKILL.md an agent can be handed. In the row rather than behind the "…", because it is what the product is for. |
| **Open** | Desktop skills only. Adopts the flow into the Record console under `from_<id>` and navigates there, ready to play. Adopting the same one twice is a no-op rather than a second copy. |
| *(browser skills)* | A note instead of a button: this one aims at page elements, so the extension is the half that can replay it. |
| **Schedule** (clock) | Opens the form: a time of day with every-day/weekdays, or an interval; a label; and the browser's own time zone, shown rather than assumed. One icon and no word, because the last column is a fixed 20rem and a fifth label pushed **Withdraw** onto a second line. See [24 — Schedules](24-schedules.md). |
| **Publish** / **Republish** | Puts it in the shared gallery. See [07 — Gallery](07-gallery.md). |
| **Withdraw** | Only when there is a listing to take down, armed in the button. The row keeps its `withdrawn_at` and copies people already installed go on working. |
| **More** | Its structure, a copy of it, and Delete. |

The More panel holds:

- **The structure** — see below.
- **Copy the payload** — the whole skill object, to the clipboard.
- **Delete** — armed in the button (`Delete — press again`). The message afterwards says whether a gallery
  listing survives it: withdrawing is a separate act, done in the gallery.

### Clearing several out at once

The recordings table has had ticks and a selection bar for a while; this page had one Delete per row and
nothing else, so removing six skills meant arming and pressing twelve times. It is now the same shape as the
recordings table — **Select all**, an *N selected* bar, an armed **Delete** that disarms itself, and a
**Clear** that disarms as well as clearing. Clearing used to hide the bar with `armed` still set behind it.

Two things it deliberately does **not** copy from that table:

- **Only rows currently on screen count as selected.** A tick that survives a search is how somebody deletes
  what they cannot see.
- **The whole selection goes in one push.** `push` already takes a list, and a loop over it would be N round
  trips that can half-succeed — leaving the person to work out which four of seven went.

### Runs by itself

Above the library, and drawn only when there is something in it: the schedules on the account, each with the
rule in words, the next run **in the schedule's own zone**, the last outcome, and the counts — runs, missed,
failed. Pause keeps the rule and runs nothing; Resume recomputes the next time rather than firing at once;
Remove asks first and says the skill stays.

The counts matter more here than anywhere else on this page, because a scheduled run happens only while that
computer is awake and taking work — so *missed* is a real and common outcome, and it never becomes a run.
The whole of it, including why the clock is the agent's own poll and not a cron, is
[24 — Schedules](24-schedules.md).

![Runs by itself, above the skill library](../img/schedules.png)

## Skill structure, and the three wire formats

![A skill as an MCP tool definition](../img/skills-structure.png)

*This is not a preview of what a model might be told: it is the same derivation the MCP server serves.
See [21 — MCP](21-mcp.md#skills-as-tools).*

`web/src/lib/skill-schema.ts`. A skill on this account is already the same thing a tool call is: a named,
described unit of work with the variable parts pulled out. `extension/skills.js` does the pulling —
`parameterise()` lifts addresses, URLs and quoted phrases out of the goal somebody typed and leaves a
template with `{{recipient}}` in it. What was missing was the last step: saying so in the shape a model API
expects.

The panel shows the derived structure — tool name, runner (`agent` / `extension`), how it runs, the goal
template, and the parameters with their types — and then the same JSON in whichever wire format is
selected:

| Format | Where the schema sits | For |
|---|---|---|
| **Anthropic** | `input_schema` | Messages API |
| **OpenAI** | `parameters`, flat — not nested under `function` | Responses API, which is what `api/_provider.js` sends |
| **MCP** | `inputSchema` | What an MCP server advertises in `tools/list` |

All three carry the same JSON Schema; only the key it sits under changes. That is deliberately the whole
difference, because it is the whole difference in the APIs.

What this does **not** claim is that a model can execute a skill on its own. A skill runs on the user's own
machine, through the agent or the extension, and the schema says so in its description. A tool definition is
how something is offered and asked for; it is not a promise about who does the work.

Who does the work, when the asking is done by a model rather than by a person copying this JSON, is
[21 — MCP server](21-mcp.md): it serves these definitions and runs the call on the machine it is running on.
It derives them from `structureOf()` and `wireFor('mcp')` rather than from a copy, so what a model is told
about a skill is the same sentence this panel shows.

### `mouseflow.skill/2` — the skill as a tiered artifact

A `mouseflow.skill/1` recorded skill **was** its events. The skill was a copy of the recording, so the only
thing anybody could do with it was replay it — and two problems came out of that at once. Somebody handed
such a skill could not tell what it did without running it, and running it is the expensive, irreversible
way to find out. And the documentation product had no artifact at all: "record what you did, get a process
document" needs the document to exist, and it existed nowhere.

So a `/2` skill carries a **procedure in words** and points at the recording as reference material rather
than swallowing it. One artifact then serves both products, which is the whole reason for the version.

| Tier | Field | What |
|---|---|---|
| 0 | `name`, `description` | as before |
| 1 | `procedure` | `{ whenToUse, steps[], pitfalls[], verification[] }` — `steps` are sentences; `verification` is the `expects` shape from [25 — Checks and tests](25-tests.md) |
| 2 | `source` | a **pointer** to the recording, never a copy |

`steps` read as documentation, `verification` runs as checks, and `pitfalls` is the shelf a memory of
applications will fill. The panel shows the procedure **above** the event count, and that order is the
point: "42 recorded actions" answers a question nobody asked — events per human step run to about ten, and
somebody opening the panel wants to know what this *does*.

```
Use it in mail.google.com. It ends by: click "Send".
  1. Open mail.google.com
  2. Click "Compose"
  3. Type {{to_recipients}} into "To recipients"
  4. Type {{subject}} into "Subject"
  5. Scroll
  6. Click "Send"
```

Four rules the derivation follows, each of them a decision rather than an implementation detail:

- **Movement is not a step.** `path` events are the pointer travelling, and "moved 340px" is noise in a
  document about what the work *was*. Consecutive scrolls fold into one, because eleven "Scroll" lines are
  the log this is meant to replace.
- **Typing names a PARAMETER, never a value.** The recorder never keeps what was typed — it keeps that a
  field was typed into. So the sentence names the parameter whose value the person supplies at run time,
  and it is read from the skill's own `params` rather than derived twice, so the document cannot promise a
  field the run form does not offer.
- **A long text is not a label.** A click on a paragraph brings the paragraph back; past 60 characters the
  step names the *kind* of thing instead ("Click the button"). The alternative is a procedure that quotes
  somebody's mail at them — the same rule, and the same reason, as the desktop recorder's landmark search.
- **No check is invented.** It would be easy to derive one — the last URL a recording reached — and wrong
  to. A check carries `why`: the one line somebody reads in a red report at nine in the morning, in the
  goal's own words. Nothing in the derivation knows the goal, so a derived check would assert a condition
  nobody chose with a reason nobody wrote. `verification` exists to be **filled**, and `readExpects` in
  `api/_case.mjs` stays its only judge.

**`/1` stays readable forever, and keeps its own version.** A `/1` file has already left somebody's
machine; refusing to read it would break what they consider theirs. So both formats are accepted, the
newest is written, and a `/1` skill is *augmented* on read — a procedure is derived from its own events, so
an old skill reads as a document immediately — while the stored format stays `/1` and the export returns
what was imported. Stamping `/2` on it would promise a reader a tier the file does not have.

**Where the derivation lives, and why it is only in one place.** `extension/procedure.js`, because the
extension is the only side that ever *derives* one: a skill is made there and a `/1` is upgraded there. The
server only ever **reads** what is stored — `structureOf()` counts `procedure.steps` when they are there
and events when they are not, and `gallery.js` accepts a recorded skill with a procedure *or* events and
refuses one with neither. Neither derives, so there is no second implementation to drift. The format string
itself is the exception that proves the rule: it is written twice, in two runtimes with no import between
them, and `api/_test-skills.mjs` exists to stop the two halves disagreeing — it is the one place that can
load both.

### Parameter extraction, in order

Order matters, and this is the order:

1. `email` → `recipient` — between two runs of the same errand, that is what changes.
2. `url` → `url`.
3. `quoted` → `text` — how people write out a subject line or a message.

Emails are extracted before quoted text so an address inside quotes is recognised as an address. The same
value appearing twice becomes **one** parameter used twice: *"reply to X and cc X"* should ask once.

## Connecting the extension

![Connect the extension](../img/skills-extension.png)

The extension has no session of its own, and cannot get one: signing in inside an extension needs an OAuth
client tied to its id, and an unpacked extension's id is derived from its folder path — different on every
machine. So the web app mints a **device token** and the extension uses it thereafter. The same shape a CLI
uses, for the same reason.

Two paths, and the good one needs no copying:

- **With the extension present** — the token goes straight across the bridge (`handToExtension`), so it is
  never seen, let alone pasted.
- **Without it** — the token is shown **once** and copied to the clipboard. Only a hash is stored
  server-side: a token is a credential, and what leaks from a table should not be usable.

Reopening the page does not mint a new token when one is already attached. Minting requires a **session**,
never a device token — a device that could mint another device would turn one leaked token into permanent
access, and revoking the one you knew about would achieve nothing. Paired devices are listed and revocable
under **Settings → My account**.

## Other ways to start

Shown only while the library is empty (somebody with twenty skills needs the room, not the explanation):

- **Describe a skill** → `/create`
- **Import a recording** → `/record` — named for what it is: there is no skill-file import in the web app,
  there is `.mmmacro` import, and the result is a **recording** that appears in the block above. A tile
  promising a "skill file" would promise a format that does not exist here.
- **Open the gallery** → `/gallery`

And a "What happens next" panel, also empty-state only, saying the three stages plainly: look at the
structure (*Next*), run it on this machine (*Private* — nothing about the run leaves your account), publish
it if you want to (*Optional* — it never happens on its own, and withdrawing is a separate act too).

## The footer note

Full width, under a rule, because it is a note about the whole page rather than about its last column:

> A skill made in the extension appears here once it syncs; one made here appears there after the
> extension's next sync. Publishing is always a separate, deliberate act.
