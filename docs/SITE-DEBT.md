# What the public site still owes the product

> Part of the handover in [`STATUS.md`](STATUS.md) — see its `4, item 3.

The app repo and the site repo (`D:/MouseLanding`, branch `codex/mouseflow-landing`) are deliberately kept
in step: the MCP tool `mouseflow_help` reads the **live** site, so a feature is "documented" only once the
site is deployed. From 2026-09-10 they are updated in separate passes — code and `docs/product/**` land
first, the site catches up in one sweep — so this file is the difference, and it is the only place that
holds it.

**How to use it.** When you do the site pass: work top to bottom, paste each block into the named file at
the named anchor, then `npm test` and `npm run build` in `D:/MouseLanding`, commit, push, and **delete the
entry from this file in the same commit**. An entry left here after its text is live is worse than no list:
the next person re-adds a section that already exists.

**What is already live**, so nobody re-does it: the anchored-replay page (`ce5ddfe`), the window-raising and
stop-trim changes (`2248202`), and the taskbar-switch / button-release changes (`abb3d35`).

---

## 1. `docs/content/tests.md` — when a check is made (roadmap 5-v2)

Shipped in the app on 2026-09-10. A case's check can name the **moment** it belongs to instead of running at
the end. The reasoning, and why it is a sentence rather than a checkpoint number, is in
[`docs/product/27-cases.md`](product/27-cases.md) → *When a check is made*.

**Insert before** the heading `## Desktop or browser — the same case, different proof`:

```markdown
## When a check is made

By default when the run has finished — and for most checks that is right. But some things **move on**: an
outbox is empty once it has sent, a progress bar is gone once it completes, a draft stops being a draft.
Checking those at the end passes for the wrong reason.

So a check can name **the moment it belongs to**, in your own words — *"the message has been sent"* — and it
is made then, before the run goes on. You write the moment; whoever can see the screen decides when it has
arrived, the same way it works out where "Sent Items" is.

And it is not a promise on paper. A check bound to a moment that got made at the end anyway is counted, and
the run says so — *"1 check bound to a moment was made at the end anyway — a weaker test than this case
says"*. It does not turn the run red: a defect that was found is still found. It just stops a weaker test
from looking like a stronger one.
```

**Also on that page:** `## What it does not do yet` opens with *"Checks in the **middle** of a procedure — all
of them run at the end."* (line 109 as of 2026-09-10) — that line is now false and must go with the same
commit.

---

## 2. Not a section, a decision the site has not caught up with

Two things were decided on 2026-09-10 and the site still presents the old shape. Both are positioning, not
paragraphs, so they need a pass rather than a paste — see [`MEMORY-PLAN.md`](MEMORY-PLAN.md) §2.

- **Coordinate replay is frozen.** *"Show it once. Let your agent do it."* is the headline on the landing
  page and it is the promise being stepped back from. Replay keeps working and keeps its docs page; it
  stops being the thing the product is sold on.
- **Two products, one engine.** The site is meant to become two doors — record work → a process document,
  and describe a goal → a run with evidence — sharing the install, privacy, limits, teams and pricing pages
  rather than forking them. One domain, paths, until a real promotion channel makes a second site earn its
  keep.
