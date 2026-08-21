# 06 — Skills

`/skills`. The flows on your account, from both halves, plus the way to connect the extension. File:
`web/src/features/skills/SkillsView.tsx`.

A skill is a flow with a name, a description and — where the goal had variable parts — parameters. It is
what makes something you did once worth handing to somebody else.

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
| **Open** | Desktop skills only. Adopts the flow into the Record console under `from_<id>` and navigates there, ready to play. Adopting the same one twice is a no-op rather than a second copy. |
| *(browser skills)* | A note instead of a button: this one aims at page elements, so the extension is the half that can replay it. |
| **Publish** / **Republish** | Puts it in the shared gallery. See [07 — Gallery](07-gallery.md). |
| **More** | Its structure, a copy of it, and Delete. |

The More panel holds:

- **The structure** — see below.
- **Copy the payload** — the whole skill object, to the clipboard.
- **Delete** — armed in the button (`Delete — press again`). The message afterwards says whether a gallery
  listing survives it: withdrawing is a separate act, done in the gallery.

## Skill structure, and the three wire formats

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

### Parameter extraction, in order

Order matters, and this is the order:

1. `email` → `recipient` — between two runs of the same errand, that is what changes.
2. `url` → `url`.
3. `quoted` → `text` — how people write out a subject line or a message.

Emails are extracted before quoted text so an address inside quotes is recognised as an address. The same
value appearing twice becomes **one** parameter used twice: *"reply to X and cc X"* should ask once.

## Connecting the extension

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
