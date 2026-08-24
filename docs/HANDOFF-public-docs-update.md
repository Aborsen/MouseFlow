# Work order: bring the public documentation up to date

**For:** whoever updates `Aborsen/MouseLanding` (branch `codex/mouseflow-landing`, deploys to
`mouse-flow.vercel.app`).
**Written:** 2026-08-24, from the product repo `Aborsen/Mouse` at commit `a85e675`.

**This file replaces the previous work order, which was written at `f9df447` and is now wrong rather than
merely incomplete.** Twenty-three commits landed after it. Some of them changed the same screens that order
described, so applying it as written would document a product that existed for one day.

Everything below is stated so you can write from it without reading the product source. Where a fact is
load-bearing it is marked **must stay exact** — those are the ones that turn into a support ticket or a
privacy complaint if paraphrased loosely.

---

## Part 0 — Read this before you start

Two things about the *previous* order:

1. **Its Teams section is still correct.** Nothing about Teams changed since. If that part was already
   applied, skip it; if not, it is reproduced in Part 6.
2. **Its screenshot instructions are still correct and still not done.** All 35 images in `Mouse/docs/img`
   are dated 23 August 13:57, and the last commit touching that directory is `0237898` on the 23rd. If
   somebody re-shot them since, it did not reach the repository — check before assuming.

---

## Part 1 — Every screenshot is wrong again, and more so than last time

**Why.** Since the pictures were taken, both main pages were rebuilt and the skill wizard was rewritten
end to end. This is not a sidebar change this time; it is the content of the pages.

```bash
cd <Mouse repo>
node scripts/shoot-docs.mjs
```

It runs the app under its own HTTPS dev server at the deployment's real hostname, against the dev fixture —
no real account and no real agent are touched. It takes two to three minutes and needs Google Chrome. Then
copy the images to `MouseLanding/public/docs/`, referenced from markdown as `/docs/<name>.png`.

**Shots whose content changed and which MUST be re-taken and re-checked by eye:**

| Image | What is different now |
|---|---|
| `skills.png` | The library is in a bordered card; columns sort; the Structure column is gone; every row has a **Use in AI** button |
| `skills-structure.png` | The panel now opens with **As an agent skill** first, then the wire definitions |
| `record.png` | One **Skill** button instead of two; no Play on the row; columns sort |
| `record-skill-wizard.png` | Step 1 folds away what cannot be described; typing rows carry a chip |
| `record-skill-wizard-2.png` | Step 2 leads with the free-text field; the explanation moved to the bottom |

The others still need re-shooting for the sidebar, exactly as the previous order said.

---

## Part 2 — The skill wizard, which is now a different screen

This is the biggest single documentation job. `skills.md` and `record-a-flow.md` describe a wizard that no
longer exists.

### Step 1 — "What it did"

- **The list shows only steps that can become instructions.** Pointer moves, waits, scrolls, and clicks on
  things the accessibility layer could not name are folded into one line: *"N more steps left out — pointer
  moves, waits, scrolls, and clicks on things with no name. Show them to put any back."* One click reveals
  them.
- **Scrolls are left out of the skill as well as the screen.** A goal skill is carried out by a model
  reading the screen, and it scrolls when it needs to see something; being told to scroll at step 14 tells
  it nothing. (Worth saying: one recording held 1,732 wheel notches.)
- **A typing row carries a chip** saying what will happen there — the text in quotes, *"will ask each
  time"*, or *"types nothing"*. Clicking it opens a small panel headed **"What did you type here?"** with a
  text box first and the three choices under it. Typing into the box picks "always this text" for you.
- **A typing row that is NOT a field says so**: a muted *"keys, not text"*, which opens an explanation and
  a one-click override.

### Step 2 — "Instructions"

- **Leads with the free-text field**, "Anything else it should know". The per-field cards are underneath,
  and the explanation of the three choices is at the bottom.
- **Repeats of one field are numbered**: `Into "Prompt" 1 of 9`, with parameters `prompt1 … prompt9`.

### Step 3 — "Name it"

- **What you wrote is placed among the steps, not appended.** When you write instructions on step 2, they
  are woven into the numbered goal at the point they belong.
- The screen reports what could **not** be placed, and where your words **contradict** a recorded step.

### Must stay exact — what the compiler is not allowed to do

> Your instructions are added to the steps; they never remove or rewrite one. Where something you wrote
> disagrees with what was recorded, both are kept and the disagreement is shown, so you can decide.

Do not describe this as the skill being "rewritten" or "optimised". It inserts and it flags. That is the
whole promise.

### Must stay exact — the privacy line, which has NOT changed

> MouseFlow records that a key was pressed and when, never which key. What you typed is not in the
> recording and cannot be.

---

## Part 3 — A new page: using a skill in an AI system

There is nothing in the docs about this and it is the product's main claim. Suggested `docs/content/agent-skills.md`.

A skill can be handed to an AI in two different ways, and they are not alternatives:

| | What it is | What runs it |
|---|---|---|
| **Tool definition** | Name, description, JSON schema, in Anthropic / OpenAI / MCP shapes | A model calls it; MouseFlow does the work |
| **Agent skill (`SKILL.md`)** | A document: when to use it, what must be true first, what to do when it fails | Loaded into an agent's context |

Both are on the Skills page: press **Use in AI** on any skill.

### The two kinds of SKILL.md — must stay exact

The panel offers a choice, and the difference is what has to be true when it runs:

- **Through MouseFlow** — the file tells the agent to call the MouseFlow tool. Works with any application
  on the paired machine. **Needs** the MouseFlow agent running there, the worker for goal skills, and the
  MCP connector.
- **Portable** — the file tells the agent to carry the steps out **itself**, with its own browser tools
  (in Claude Code or Cowork, `claude-in-chrome`). **Needs no MouseFlow at all at run time.** Browser work
  only.

**Portable is offered only when the recording holds web addresses.** The rule is "do we know the
addresses", not "was it a browser": a recording with no URLs would have to begin *"find the window called…"*,
which a cloud agent cannot do. Recordings made before 24 August by the desktop agent have no URLs and never
will — the addresses are written at recording time. **A new recording is needed.**

### Must stay exact — what is in the file, and what is not

- URLs are **origin and path only**. Query strings and fragments are dropped **in the agent, before the
  recording is written**, because that is where session tokens and one-time links live. The file says so,
  so a person can put back a query their flow genuinely needs.
- There is deliberately **no "how to do this without MouseFlow"** section in the Through-MouseFlow file. An
  agent with computer-use, handed a list of clicks and no tool, would try to carry them out itself on a real
  machine against coordinates from a different screen. The file says: stop and tell the user.
- The portable file treats a **sign-in page as a stop**, never something to solve, and forbids handling
  credentials.

### Downloads

Two buttons: **`<skill-name>.zip`** — a folder `<skill-name>/SKILL.md`, which is the shape an agent skill
installs in — and **`.md`** for a folder you already have.

**Note for the docs:** the file's `description` line is written by a model when one is reachable, and
derived otherwise. The panel says which. A derived description works but makes an agent less likely to reach
for the file.

---

## Part 4 — Both tables now sort, and a skill can be renamed

Small, visible in every screenshot, and worth a line each:

- **Skills and Recordings both sort** by clicking a column header. A second click reverses it; an arrow
  shows which column is deciding and which way. Skills sorts by name, source, updated, status. Recordings
  sorts by name, how much was recorded, captured, status.
- **A skill can be renamed** — open **Use in AI** and press Rename. **Must stay exact:** the tool name an
  AI calls is derived from the skill's name, so anything already pointed at the old name needs the new one.
- **The Skills page opens on your skills.** The "Ready to become a skill" block moved below the library.
- Both lists are **five rows tall on a small screen and up to ten on a large one**, scrolling past that.

---

## Part 5 — Corrections to pages that are now WRONG

### `record-a-flow.md` and `skills.md`

1. **There is one skill button on a recording, and it opens the wizard.** There used to be two — a literal
   copy and the wizard. The literal copy still exists, on the Skills page, called **"Repeat it exactly"**.
2. **Play is not on the recording row.** It is in the panel with the repeat, speed and loop it obeys.
3. Everything in Part 2 about the wizard.

### `privacy-and-data.md` — must stay exact, and this one is new

The agents now record **the address of the page a click landed on**, for browser windows. This is the
largest expansion of what is captured since the project started and the docs must say so plainly:

> For a click in a browser, MouseFlow now also records the page's address — its origin and path. The query
> string and fragment are removed before the recording is written, because that is where session tokens,
> one-time sign-in links and search terms live. Nothing is recorded for applications that are not browsers.

Do not bury this in a feature note. It belongs in the privacy page.

### `dashboard.md`, `assistant.md`, sign-in, `faq.md`

Unchanged since the previous work order — the corrections it listed are still needed and still not made.
They are reproduced in Part 6.

---

## Part 6 — Still outstanding from the previous order

Carried over verbatim in substance, because none of it was applied:

- **Teams** is undocumented: a new `docs/content/teams.md`, registered in `src/pages/docs.jsx` in four
  places (import, `SIDEBAR_NAV`, `PAGES`, `DOC_SLUGS`). Roles owner/admin/member. Limits: 60-character
  name, 20 teams per person, 200 members per team, 25 invitations per account per hour.
  - **Must stay exact:** joining a team hands over nothing already recorded. *Activity* — that a person
    recorded something, when, and how a run ended — becomes visible to owners and admins. *Content* — the
    events inside a recording, its transcript, its chat — stays private until its owner shares one skill,
    deliberately, one at a time. An owner also sees application and process names, skill and recording
    names, the goal wording of repeated runs, and the reason text of failures.
  - Invitations: you add somebody by **email address**; the row is the invitation and the email is a
    courtesy; **the link carries no token**, so opening it as the wrong person joins nothing. Do not name
    the sending domain.
- **`dashboard.md`**: the window presets are **Today / 7 days / Custom** — 30 and 90 were removed, the
  default is 7 days. The team view (`?team=…`), the **Who did what** table, and the per-member filter
  (`&person=…`) are undocumented.
- **`assistant.md`**: it follows the dashboard's scope. **Must stay exact:** on a team it gets a whitelist
  of aggregate lookups — it **cannot** read a colleague's transcript, cannot read a run's individual steps,
  and **cannot write**. Those tools are not registered at all, not merely disabled.
- **Sign-in**: signed out, every address redirects to `/sign-in`. The in-place sign-in card is gone.
- **`settings-team.png`** is deleted; no page references it.
- **Sentry** stays out of the public docs, except optionally in `privacy-and-data.md`: no Session Replay,
  no PII, no IP, no cookies, query values redacted by allowlist.

---

## Checklist

- [ ] `node scripts/shoot-docs.mjs`, then look at the five images in Part 1 by eye
- [ ] copy images to `MouseLanding/public/docs/`, delete `settings-team.png`
- [ ] rewrite the wizard in `skills.md` / `record-a-flow.md` (Part 2)
- [ ] new `docs/content/agent-skills.md`, registered in `src/pages/docs.jsx` (Part 3)
- [ ] sorting, renaming, page order (Part 4)
- [ ] one skill button, Play moved (Part 5)
- [ ] **`privacy-and-data.md`: the page address** (Part 5 — do not skip this one)
- [ ] everything in Part 6, which was never applied
- [ ] `npm run check:wiring`, build, and read the pages before pushing
