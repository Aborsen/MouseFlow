# 03 — The web app shell

React 19, Vite 7, TanStack Router with **code-based** routes (one file listing them all rather than a
directory whose names are the routing), Tailwind 3, and a vendored subset of the Insightis design system.
Entry point: `web/src/main.tsx`.

## Routes

| Path | Screen | Notes |
|---|---|---|
| `/` | → `/record` | Landing on Record: the thing most visits came to do. |
| `/record` | [Record](04-record.md) | |
| `/create` | [Create](05-create.md) | Marked **Beta** in the sidebar. |
| `/skills` | [Skills](06-skills.md) | |
| `/gallery` | [Gallery](07-gallery.md) | |
| `/dashboard` | [Dashboard](08-dashboard.md) | |
| `/insights` | Dashboard | The old path, kept: it is linked from a published roadmap review. |
| `/chat` | → `/dashboard` | The assistant moved onto the page whose numbers it answers about. |
| `/connect` | [Connections](09-connections.md) | Not in the sidebar — it is setup, not a place you work. |
| anything else | → `/record` | |

Old hash links (`#record`, `#skills`, `#gallery`, `#connect`, `#desktop`) are rewritten to paths once, on
the way in. `defaultPreload: 'intent'`.

## The sign-in wall

`AccountProvider` (`web/src/shell/AccountProvider.tsx`) asks `/api/auth/get-session` before anything
renders. Three states:

- **unknown** — nothing renders at all. A flash of the app before the wall is worse than a pause.
- **nobody** — the wall: *Continue with Google*, plus whatever went wrong last time.
- **somebody** — the app, with `{ account, flows, runs, loaded }` in context.

The wall is a **front door, not access control**. Enforcement is in the API, which checks a session or a
device token on every request and cannot be talked out of it. A gate in a page is a suggestion.

Sign-in is Google via Neon Auth, proxied through `/api/auth/*` so the session cookie is first-party. The
callback lands on `/api/auth/finish?to=<where you were>`, which exchanges the one-time verifier for the
session cookie and redirects back with `?auth=ok` (or `missing-verifier` / `rejected` / another code,
which the provider turns into a sentence and then strips from the URL so a refresh does not repeat it).

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

`web/src/shell/AppSidebar.tsx`. Five destinations — Record, Create (Beta), Skills, Gallery, Dashboard —
then an hours row and the account row.

- **Collapse** is remembered (`mouseflow.side.tight`); it is a preference about this screen rather than
  about this visit. Below 820px it collapses itself, because a 236px sidebar and a two-column view do not
  fit at once.
- Every row is one declared square (36px row, 18px glyph, 10px gap) shared by the nav, the collapse
  toggle and the avatar. They each sized themselves before, which is why the collapsed rail looked ragged.
- **Hours** is the sum of `hoursOf(run)` over the account's runs — wall clock, from a run's first step to
  its last, *not* time saved. Clicking it opens the screen it summarises.
- **Beta on Create alone**: of the five things this product does, it is the one that acts on a real
  machine from a model's decisions, so it is the one that can be wrong in a way that costs something.

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

## Settings dialog

`web/src/shell/SettingsDialog.tsx`. Three screens, one declared body height (560px, measured against the
tallest) so the dialog does not grow and shrink as you move between them.

### My account
- Your email.
- **Theme** — Light / Dark / System.
- **Paired devices** — every device token, with when it was created and last used, and Revoke on each.
- **Delete my data** — arms in the button rather than behind a `confirm()`, and disarms itself after a
  moment. See [14 — HTTP API § `/api/account`](14-http-api.md#apiaccount) for exactly what it deletes,
  and what it cannot.
- **Log out** — pinned to the bottom, and verified (above).

### Connections
The same install command, platform picker and health readout as the `/connect` screen, sharing one
implementation (`features/connect/platform.tsx`). They diverged once — the settings panel went on handing
macOS users a PowerShell one-liner — which is why the shared module exists.

### Hours
Total and this-month hours, the five most recent timed runs, and a note saying plainly that this is wall
clock and not time saved. Five rows because six plus the note came to 427px of a 401px body.

## PWA state

`web/index.html` declares `manifest.webmanifest`, icons and a theme colour, and loads DM Sans from
Google Fonts. The app is installable.

`web/public/sw.js` exists but **nothing registers it**, and its shell list still names `app.css` /
`app.js` from the pre-React build. Offline is therefore not working today. See
[19 — Limits and known gaps](19-limits-and-known-gaps.md).
