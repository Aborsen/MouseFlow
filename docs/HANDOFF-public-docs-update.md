# Work order: bring the public documentation up to date

**For:** whoever updates `Aborsen/MouseLanding` (branch `codex/mouseflow-landing`, deploys to
`mouse-flow.vercel.app`).
**Written:** 2026-08-23, from the product repo `Aborsen/Mouse` at commit `f9df447`.

The public docs were written when the app's last commit was **`531e63c`**. Twelve commits have landed since.
The assumption that "only Teams was added" is not quite right — there are **nine** user-facing changes, and
three of them silently falsify sentences the docs currently contain.

Everything below is stated so you can write from it without reading the product source. Where a fact is
load-bearing it is marked **must stay exact** — those are the ones that turn into a support ticket or a
privacy complaint if paraphrased loosely.

---

## Part 1 — Every screenshot of the app is now wrong

This is the biggest single job, and it is mechanical.

**Why.** The left sidebar changed twice: a **Teams** entry was added, and **Gallery** moved to the bottom.
The sidebar is in every screenshot of the app, so all 31 images in `MouseLanding/public/docs` show a
sidebar the product no longer has.

The order is now, top to bottom:

```
Record · Create (Beta) · Skills · Dashboard · Teams · Gallery
```

**Do not re-shoot these by hand.** The product repo regenerates them all from the running app:

```bash
cd <Mouse repo>
node scripts/shoot-docs.mjs
```

It runs the app under its own HTTPS dev server at the deployment's real hostname (so the addresses inside
the pictures are real, not `localhost`), against the dev fixture — no real account and no real agent are
touched. It writes **33** images to `Mouse/docs/img/`. It takes two to three minutes and needs Google
Chrome. Two shots are deliberately staged and say so where they appear.

Then copy them across. The landing repo keeps its own copy at `MouseLanding/public/docs/`, referenced from
markdown as `/docs/<name>.png`.

| | |
|---|---|
| **New images** to copy in | `team.png`, `team-panel.png`, `dashboard-team.png` |
| **Deleted** — remove from `public/docs` and from any page referencing it | `settings-team.png` |
| **All others** | overwrite; every one has a changed sidebar |

`settings-team.png` is gone because Teams stopped being a pane inside the settings dialog. I checked: **no
page in `docs/content/` references it**, so deleting the file is all there is to do.

---

## Part 2 — A new page: Teams

There is no Teams page in `docs/content/` at all. Create `docs/content/teams.md` and register it in
`src/pages/docs.jsx` the way every other page is registered — there are four places, all near each other:

1. `import teamsMd from '../../docs/content/teams.md?raw';`
2. an entry in `SIDEBAR_NAV`
3. an entry in `PAGES` — `'teams': mdToPage(teamsMd),`
4. an entry in `DOC_SLUGS`

Frontmatter matches the house format:

```markdown
---
title: Teams
description: <one sentence>
breadcrumb: Docs / Teams / Teams
---
```

### What to write

**Where it lives.** `/team` in the app's sidebar. It was a pane inside the settings dialog and is now its
own page.

**What a team is for.** The people running it can see **that** work is happening — who recorded, when, how
runs ended.

**Must stay exact — what joining one does NOT do.** This is the sentence the whole feature rests on, and
getting it loose is the one failure that matters:

> Joining a team hands over nothing you have already recorded. **Activity** — that a person recorded
> something, when, and how a run ended — becomes visible to the team's owners and admins. **Content** — the
> events inside a recording, its transcript, its chat — stays private until its owner shares one skill,
> deliberately, one at a time.

Be careful not to overstate it in the other direction either. An owner or admin **also** sees: application
and process names, skill and recording names, the **goal wording** of runs that happened more than once, and
the **reason text** of failures. It is *work product a manager could already see on the roster*, not *only
numbers*. (The product docs got this wrong first and had to be corrected; do not reintroduce it.)

**Three roles, fixed:**

| | Can |
|---|---|
| **owner** | rename the team, delete it, move anybody's role including another owner's — plus everything an admin can |
| **admin** | add and remove members, cancel invitations, see everyone's activity |
| **member** | see the team's shared skills, and their own activity |

**How the page works.** Teams are listed one per row — name, your role, how many people, shared skills,
created. Opening one slides a panel over the list, so moving between teams is one click each. The panel
holds the members, the add-somebody field, invitations, shared skills, and (for an owner) Rename and Delete.

**Limits:** 60-character name · 20 teams per person · 200 members per team · 25 invitations per account per
hour.

### Invitations — must stay exact

- You add somebody by **email address**. They do not need an account first.
- **The row is the invitation; the email is a courtesy.** Membership is decided by the address on the
  account that opens the page.
- **The link carries no token.** Opening it as the wrong person joins nothing. This is deliberate and worth
  saying: a tokenised join link means anyone who ever sees the message — a forward, a shared inbox, a mail
  log — could take the seat. An address-bound row cannot be handed on.
- Someone **with** an account gets a link to `/team`. Someone **without** one is sent to sign up, with their
  address prefilled, and lands on the team once the account exists.
- If the deployment has no mail configured, the invitation still works exactly as before and every screen
  says plainly that nothing was sent.

**Do not name the sending domain in public docs.** It is currently a domain borrowed from another project
and will change. "You'll get an email from MouseFlow" is the right level.

---

## Part 3 — Pages that are now WRONG and must be corrected

These are not additions. The docs currently state things the product no longer does.

### `dashboard.md` — three corrections

1. **The window presets changed.** The page says *"pick a window: **7**, **30** or **90 days**"*. It is now
   **Today**, **7 days**, and **Custom** (a calendar reaching 365 days). 30 and 90 were removed. The default
   window is now 7 days.

2. **The team view is new and undocumented.** An owner or admin of a team can point the dashboard at that
   whole team with a **Mine / team** switch. The scope lives in the address (`/dashboard?team=…`), so a link
   opens what the sender was looking at. It adds a **Who did what** table — one row per member, over the
   window on screen — and a *Whose* column on the skills table. Everybody gets a row, including people with
   nothing in the window.

   A second control narrows it to **one member** (`&person=…`). The roster stays whole while the counting
   narrows, so the picker still offers everybody. The Who-did-what table hides while one person is selected.

   A member who is not an owner or admin is **not offered the switch at all**, and is refused by name if
   they ask for it another way.

3. **The assistant is not the same.** See below.

### `assistant.md` — two corrections

1. **It follows the dashboard's scope.** Ask it about a team and it answers about that team; narrow the page
   to one person and it answers about that person. It labels whose history it is reading, and its three
   starter questions change with the scope.

2. **Must stay exact — what it cannot reach on a team.** In a team scope the assistant is given a
   *whitelist* of aggregate lookups. It **cannot** read a colleague's transcript, cannot read a run's
   individual steps, and **cannot write** — it cannot edit or remove steps from anybody's recording. Those
   tools are not disabled for teams; they are not registered at all.

   Worth stating plainly, because it is the question a reader will have.

3. Minor, but visible in every screenshot: the panel now carries its own **minimise** and **close** controls
   in its header, and "New chat" is a `+`. Minimised it leaves a rail on the right edge.

### `skills.md` and `record-a-flow.md` — two corrections

1. **Make a skill now lands on the Skills page.** Pressing it on a recording takes you to `/skills` with the
   wizard open, instead of opening the wizard over the recordings list. You end up where the skill you just
   made actually is.

2. **The step list has Select all and None.** The wizard opens with only the describable steps ticked; the
   two new controls take the whole recording or empty the list in one click. Worth documenting because
   "repeat exactly what I just did" is the commonest case and used to mean ticking every box by hand.

### Sign-in — check every page that describes getting in

Signed out, **every address now redirects to `/sign-in`**, carrying the page you were trying to reach. The
app used to draw a sign-in card in place, leaving the URL as `/record`. If any page shows or describes that
in-place card, it is out of date. The sign-in page now also carries a **Create an account** link.

### `faq.md`

Add questions for the new surface. Candidates, in the file's existing voice:

- Can I have more than one team?
- What does my team see about my work? *(use the exact wording from Part 2)*
- Somebody I invited has no MouseFlow account — what happens?
- Can a teammate open my recordings? *(no)*
- Can the assistant read my colleague's recordings? *(no — whitelist, above)*
- How do I see one person's numbers rather than the whole team's?

---

## Part 4 — What is deliberately NOT for the public docs

- **Sentry.** Error reporting was added this session. It is internal plumbing; the privacy-relevant part
  (no Session Replay, no PII, query values scrubbed) belongs in `privacy-and-data.md` **only** if you want
  to make a positive claim there — and if you do, say it precisely: crash reports carry no IP address, no
  cookies, no session recording, and query values are redacted by allowlist.
- **The sending domain** for invitation email (see Part 2).
- Internal environment variables, the run queue, the `_team-scope.js` derivation.

---

## Checklist

- [ ] `node scripts/shoot-docs.mjs` in the Mouse repo
- [ ] copy all 33 images to `MouseLanding/public/docs/`, delete `settings-team.png`
- [ ] new `docs/content/teams.md`, registered in `src/pages/docs.jsx` (four places)
- [ ] `dashboard.md` — window presets, team view, member filter
- [ ] `assistant.md` — scope, the whitelist, the new header controls
- [ ] `skills.md` / `record-a-flow.md` — where Make a skill lands, Select all
- [ ] sign-in described as a redirect to `/sign-in`
- [ ] `faq.md` — the six questions above
- [ ] `npm run check:wiring`, build, and look at the pages before pushing
