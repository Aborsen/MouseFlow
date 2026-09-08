# MouseFlow — product documentation

Every module, every option, and the reasoning behind each one. Written from the code as it stands at
commit `17bbcc5` (agents 0.8.2, extension 0.16.2, web app on React 19 / Vite / TanStack Router).

## How this is organised

| | |
|---|---|
| [01 — Overview](01-overview.md) | What the product is, the three clients, why the split exists, the capability matrix |
| [02 — Concepts and vocabulary](02-concepts.md) | Recording, session, part, flow, skill, run, transcript, role, source, identity |
| [03 — The web app shell](03-web-app.md) | Routes, sidebar, top bar, theme, sign-in wall, settings dialog, PWA state |
| [04 — Record](04-record.md) | The recorder, long sessions, the recordings table, the transcript panel, held recordings, cross-device reconciliation |
| [05 — Create](05-create.md) | Prompt → flow: the two executors, the plan, checkpoint gates, window pinning, live context, the decision loop |
| [06 — Skills](06-skills.md) | The skill library, roles, save-as-skill, tool schemas, publishing, extension pairing |
| [07 — Gallery](07-gallery.md) | Collections, browse and collection views, install, publish, withdraw |
| [08 — Dashboard and the assistant](08-dashboard.md) | Every metric, every gap, the grounded chat and its read-only tools |
| [09 — Connections](09-connections.md) | The install flows for both platforms, Local Network Access, autostart |
| [10 — Agent protocol](10-agent-protocol.md) | The loopback HTTP contract: every endpoint, parameter, event word and body grammar |
| [11 — The Windows agent](11-agent-windows.md) | Flags, tray icon, hooks, capabilities, platform limits |
| [12 — The macOS agent](12-agent-macos.md) | Installer flags, code signing, TCC permissions, menu bar, self-restart, `--doctor` |
| [13 — The Chrome extension](13-extension.md) | Modes, message API, event format, settings, what it cannot do |
| [14 — HTTP API](14-http-api.md) | Every serverless route with its parameters, caps and auth rules |
| [15 — Data model](15-data-model.md) | Tables, payload shapes, `localStorage` keys, sync and reconciliation rules |
| [16 — Transcript engine](16-transcript.md) | How a recording becomes prose, and how an edit is applied and undone |
| [17 — Privacy and security](17-privacy-security.md) | What is captured and what is deliberately not, credentials, CORS, rate limits |
| [18 — Configuration reference](18-configuration.md) | Every environment variable, flag, query parameter, storage key and tuning constant |
| [19 — Limits and known gaps](19-limits-and-known-gaps.md) | Inherent limits, unverified areas, and defects found while writing this |
| [20 — Operations](20-operations.md) | Deploy, migrate, develop, test |
| [21 — MCP](21-mcp.md) | Connecting an AI to an account: every tool, how it signs in, how it comes to be allowed to act on your computer, what it refuses, and what to do when an answer says something did not happen |
| [22 — Teams](22-teams.md) | Who may see whose work, the three roles, and the much longer list of what a team deliberately does not open |
| [23 — Process documents](23-documents.md) | A procedure written from one recording, every line citing its step, kept as an object somebody can correct |
| [24 — Schedules](24-schedules.md) | Runs nobody asks for: a time of day or an interval, ticked by the machine's own poll rather than a cron, and what it says when the machine was asleep |

## Two conventions this documentation keeps

**Measured numbers are marked as measured.** Where a figure came from running the thing (69 bytes an
event, 81.8% of clicks named on macOS, 70.8% on Windows) it is stated as measured and where it came
from. Where something has never been observed working, that is stated too — see
[19 — Limits and known gaps](19-limits-and-known-gaps.md).

**The screenshots are of the app, not of a drawing of it.** Every picture in these documents was taken from
the running application, against the development fixture account (`MOCK_API=1`), at the deployment's own
address so the URLs in them are the URLs you would paste. Two are **staged**, and say so where they appear:
the "Claude asked to start a recording here" banner and the Connections screen before a machine is attached,
both of which need a computer that is *not* already attached — and the machine these were taken on is. The
consent page is rendered from the same function the server sends, rather than mocked up, because a picture
of a consent screen that is not the consent screen is the one picture nobody should draw.

Regenerate them with `node scripts/shoot-docs.mjs`, and look at what comes out — the script cannot tell a
rendered page from a rendered error.

**Absent is not the same as false.** The product draws this distinction everywhere: a capability flag
that is missing means "this agent is too old to say", not "no"; a `#ctx` line that is absent means "not
known", not "nothing was there". The documentation follows the same rule, because collapsing the two is
how a transcript, a dashboard or a document starts asserting things nobody can support.

## Also in the repository

- [`README.md`](../../README.md) — the original project readme. Parts of it predate the React rewrite; where
  it disagrees with these documents, these documents were written from the code.
- [`agent/PROTOCOL.md`](../../agent/PROTOCOL.md) — the normative agent contract. If you are writing a third
  agent, that file is the specification and [10 — Agent protocol](10-agent-protocol.md) is the guided tour.
- [`docs/DEBUG-MAC.md`](../DEBUG-MAC.md), [`docs/DEBUG-WINDOWS.md`](../DEBUG-WINDOWS.md) — per-platform
  debugging, including what is verified on real hardware and what is not.
- [`extension/README.md`](../../extension/README.md) — the extension's own engineering notes.
