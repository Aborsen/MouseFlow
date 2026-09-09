# 03 — The web app shell

React 19, Vite 7, TanStack Router with **code-based** routes (one file listing them all rather than a
directory whose names are the routing), Tailwind 3, and a vendored subset of the Insightis design system.
Entry point: `web/src/main.tsx`.

## Routes

| Path | Screen | Notes |
|---|---|---|
| `/` | → `/record` | Landing on Record: the thing most visits came to do. |
| `/record` | [Record](04-record.md) | |
| `/activity` | [Activity](26-activity.md) | Running, waiting and everything that ran, with Stop and Cancel beside each. |
| `/create` | [Create](05-create.md) | Marked **Beta** in the sidebar. |
| `/skills` | [Skills](06-skills.md) | |
| `/tests` | [Test cases](27-cases.md) | Cases, the row of nights each one has had, and one button for a nightly run. |
| `/gallery` | [Gallery](07-gallery.md) | |
| `/dashboard` | [Dashboard](08-dashboard.md) | `?team=<id>` scopes it to a whole team, for its owners and admins. |
| `/team` | [Teams](22-teams.md) | |
| `/insights` | Dashboard | The old path, kept: it is linked from a published roadmap review. |
| `/chat` | → `/dashboard` | The assistant moved onto the page whose numbers it answers about. |
| `/connect` | [Connections](09-connections.md) | Not in the sidebar — it is setup, not a place you work. |
| anything else | → `/record` | |

Old hash links (`#record`, `#skills`, `#gallery`, `#connect`, `#desktop`) are rewritten to paths once, on
the way in. `defaultPreload: 'intent'`.

## The sign-in wall

![The sign-in page](../img/sign-in.png)

`AccountProvider` (`web/src/shell/AccountProvider.tsx`) asks `/api/auth/get-session` before anything
renders. Three states:

- **unknown** — nothing renders at all. A flash of the app before the wall is worse than a pause.
- **nobody** — the wall: *Continue with Google*, plus whatever went wrong last time.
- **somebody** — the app, with `{ account, flows, runs, loaded }` in context.

The wall is a **front door, not access control**. Enforcement is in the API, which checks a session or a
device token on every request and cannot be talked out of it. A gate in a page is a suggestion.

Sign-in is Google via Neon Auth, proxied through `/api/auth/*` so the session cookie is first-party. The
callback lands on `/api/auth/finish?to=<where you were>`, which exchanges the one-time verifier for the
session cookie and redirects back with `?auth=ok`, or one of:

| Outcome | Means |
|---|---|
| `missing-verifier` | Google came back without a verifier, so sign-in could not be completed |
| `rejected` | The auth service refused the exchange |
| `no-session-cookie` | The exchange succeeded and no cookie came back |

A failure also carries **`?why=`** — the upstream's **own** status and code, forwarded rather than
summarised. It is short, names a failure mode and never a token, and it is the difference between "try
again" and knowing which thing to fix: this used to redirect with a bare `rejected` and drop the upstream's
answer on the floor, which is how a sign-in that works on a desktop and fails on a phone stayed
unexplained — the one machine that knew the reason threw it away.

The `rejected` message no longer guesses, either. "The attempt may have expired" was a guess the code was
making on the user's behalf, and the wrong one on a phone, where the usual cause is the sign-in starting in
one browser and coming back in another. It now says that, and says trying again is safe.

Both parameters are stripped from the URL after they are read, so a refresh does not repeat the message;
anything else in the query is left alone.

**Signing out is verified, not assumed.** `signOut()` throws on failure like every other call, and the
provider then *reads the session back*: a sign-out response can succeed and still leave the browser signed
in, because it clears cookies by name, path and partition and any of those can fail to match. The
redirect only happens once the answer is nobody; otherwise the message stays on screen beside the button.

### `loaded` — and why it exists

`loaded` is set only on a **successful** `pull()`. An account with nothing in it and an account that could
not be read look identical from the client, and one of those means "every recording you have was deleted
on another machine". The reconciler refuses to run until `loaded`. This was found in the browser, where
the rows came back a moment later and hid it; had the request failed, the recordings would simply have
gone. See [04 — Record § reconciliation](04-record.md#cross-device-reconciliation).

## Sidebar

![The sidebar and top bar](../img/record.png)

`web/src/shell/AppSidebar.tsx`. Six destinations — Record, Create (Beta), Skills, Dashboard, Teams,
Gallery — then an hours row and the account row. Gallery is last because it is the only one that is not
*your* work: everything above it is something on this account.

- **Collapse** is remembered (`mouseflow.side.tight`); it is a preference about this screen rather than
  about this visit. Below 820px it collapses itself, because a 236px sidebar and a two-column view do not
  fit at once.
- Every row is one declared square (36px row, 18px glyph, 10px gap) shared by the nav, the collapse
  toggle and the avatar. They each sized themselves before, which is why the collapsed rail looked ragged.
- **Hours** is the sum of `hoursOf(run)` over the account's runs — wall clock, from a run's first step to
  its last, *not* time saved. Clicking it opens the screen it summarises.
- **Beta on Create alone**: of the things this product does, it is the one that acts on a real machine
  from a model's decisions, so it is the one that can be wrong in a way that costs something.
- **Teams is last, and it is a place rather than a setting.** It was a pane of the settings dialog while it
  was one roster you filled in once; several teams, people being moved and invitations to chase do not fit
  560 declared pixels, and a dialog has no address for an invitation email to link to.

## Top bar

The page's name, and the agent status pill on the right. The pill is always true and always visible, and
clicking it opens **Settings → Connections** rather than toggling a panel over the page you are on.

| State | Shows |
|---|---|
| Answering, current | green dot, `Agent 0.8.2 · 2560×1440` |
| Answering, older than `AGENT_WANTS` | amber dot, `Agent 0.7.0 · update to 0.8.0` |
| Nothing answering | red dot, `Agent offline` |

## Agent polling

One poller for the whole app (`web/src/lib/store.ts`), shared by every component that asks — the
pre-rewrite code had three polls at three cadences that could disagree. It runs every **2s** while the
agent answers or while failures are still under 8 (somebody is probably setting up), and every **15s**
after that: a machine with no agent should not be polled every two seconds forever. `refreshAgent()`
asks immediately, for the moment right after somebody starts the agent.

## Theme

`web/src/shell/theme.ts`. Light, dark, or system. Applied **before React renders** (`bootTheme()`), so
the first paint is the right colour. "System" is the absence of a choice, so it *removes* the stored value
rather than storing a third one, and then follows `prefers-color-scheme` live. The Insightis design
system toggles a `dark` class on the root, so that is what this sets — every vendored component's `dark:`
utilities work untouched. Key: `mouseflow.theme`.

## The first run

`web/src/shell/OnboardingTour.tsx`. Five things in the sidebar and a command to run on this machine is not a
lot, but it is five more than somebody has ever seen before — and the one that matters most, the agent, is
**invisible until it is installed**. So the tour walks down the nav in the order the product is actually
used, and **ends on the Connections screen with the install command in front of them**, which is the only
step that leaves something behind.

| Step | Points at | Says |
|---|---|---|
| 1 | Record | Press Record, work normally, stop. Every click is kept with the name of the thing clicked — "Send", not "1074, 159". Typing is kept as the fact that you typed and when, never the words. |
| 2 | Create | Describe the job in a sentence; it works from a picture of your screen, so it reaches a spreadsheet, a folder or any window. The newest part, which is why it is Beta. |
| 3 | Skills | A recording you keep becomes a skill: run it again, or hand it to Create as one step of something larger. |
| 4 | Gallery | Skills other people shared. Take one and it is yours — a good way to see what this does before recording anything. |
| 5 | Dashboard | What your recordings add up to: which applications the work happens in, how long each stretch took, and what keeps repeating. |
| 6 | *nothing* | The agent is the half that works outside the browser. It runs only on this machine, answers only this app, and takes one command — which is on the next screen. |

Each step says what the thing **is** rather than which button to press: a tour that reads like a list of
controls teaches nothing the controls do not already say.

How it draws itself, because both details were decisions:

- **The spotlight is measured, never guessed** — `data-tour` on each nav link and `getBoundingClientRect` at
  the moment the step opens, re-measured on resize and whenever the sidebar collapses (it goes to a rail
  under 820px and can be collapsed by hand). A highlight drawn at a remembered coordinate is a highlight
  around nothing.
- **Four blurred panels around a gap**, not one panel with a hole cut in it. `clip-path` with an even-odd
  fill is the tidier answer and is not reliable enough to bet a first run on; four rectangles need nothing
  but arithmetic, and the gap is exactly the element.

Shown **once per browser** (`mouseflow.onboarded`, written only when it finishes or is skipped) and
skippable at every step — somebody who knows what they are looking at should not have to click through six
panels to reach it. In private mode it runs every time rather than not at all. **Settings → Connections →
The tour → Show it again** restarts it.

## Settings dialog

`web/src/shell/SettingsDialog.tsx`. Three screens, one declared body height (560px, measured against the
tallest) so the dialog does not grow and shrink as you move between them. Teams was a fourth and is now its
own page — see the sidebar, above.

### My account

![My account](../img/settings-account.png)

- Your email.
- **Theme** — Light / Dark / System.
- **Pair a device** — mints a device token and shows it **once**, because only its hash is stored. It is
  what the extension, a CLI and the MCP server sign in with. Before this button existed the only thing
  that minted one was *Connect the extension* on the Skills page, and being sent here to find a list you
  can only revoke from is the kind of instruction that reads as a lie.
- **Paired devices** — every device token, with when it was created and last used, and Revoke on each.
- **Signed in with your account** — clients you allowed to act as you over OAuth, grouped by client
  rather than by token, because nobody thinks in access tokens. Revoking one takes every token it holds
  at once. Shown only when there is something in it. See [21 — MCP](21-mcp.md#who-it-lets-in).
- **Delete my data** — arms in the button rather than behind a `confirm()`, and disarms itself after a
  moment. See [14 — HTTP API § `/api/account`](14-http-api.md#apiaccount) for exactly what it deletes,
  and what it cannot.
- **Log out** — pinned to the bottom, and verified (above).

### Connections

![Connections](../img/settings-connections.png)

The same install command, platform picker and health readout as the `/connect` screen, sharing one
implementation (`features/connect/platform.tsx`). They diverged once — the settings panel went on handing
macOS users a PowerShell one-liner — which is why the shared module exists.

Plus three things that are only here:

- **The tour → Show it again**, the only way back to the first-run walkthrough once it has run.
- **Let Claude drive this computer** — attaches this machine to the account so a connected AI can ask it
  for work. One click: a device token is minted, handed to the agent across loopback, and never shown.
  Shown only when the running agent can do it at all (`linked` present on `/health`), because absent
  means "this build cannot", not "off".
- **Connect an AI** — the MCP address, with a Copy button, so nobody has to open the documentation to
  find the one line they need to paste. See [21 — MCP](21-mcp.md#connecting-it).

### Hours

![Hours](../img/settings-hours.png)

Total and this-month hours, the five most recent timed runs, and a note saying plainly that this is wall
clock and not time saved. Five rows because six plus the note came to 427px of a 401px body.

## PWA state

`web/index.html` declares `manifest.webmanifest`, icons and a theme colour, and loads DM Sans from
Google Fonts. The app is installable.

`web/public/sw.js` exists but **nothing registers it**, and its shell list still names `app.css` /
`app.js` from the pre-React build. Offline is therefore not working today. See
[19 — Limits and known gaps](19-limits-and-known-gaps.md).
