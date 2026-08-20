/* A stand-in for the account endpoints, for working on the UI without a session.
 *
 * Dev only, and off unless MOCK_API=1 is set: it is wired into the dev server as middleware, so it cannot
 * reach a build. Without it every UI change has to be verified against a signed-in deployment, which means
 * either shipping to look at it or having production cookies in a dev browser - both worse.
 *
 * The shapes are the real ones. A mock that is shaped differently from the endpoint it stands for teaches
 * the UI to expect the wrong thing, which is how a fake becomes worse than nothing.
 */
import type { Connect } from 'vite';

const now = Date.now();
const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();

/* Conversations, as the real store would hold them. In memory, so they last as long as the dev server does -
 * which is the same lifetime as the signed-out flag below and for the same reason. */
const chats = new Map<string, {
  id: string;
  title: string;
  created: string;
  updated: string;
  messages: unknown[];
}>();

/* Whether the fixture has been signed out. Module scope, so it survives between requests in one dev
 * session and resets when the server restarts - which is what a session cookie does. */
let signedOut = false;

const ACCOUNT = { id: 'u_dev', name: 'Vic Gorlenko', email: 'vic@example.dev', image: null };

const FLOWS = [
  {
    id: 'dr_dev_1',
    source: 'desktop',
    kind: 'recorded',
    name: 'Outlook (PWA) · 6 clicks',
    // The count agrees with payload.events below: a fixture that disagrees with itself teaches the wrong
    // thing to whoever reads the Structure fold beside it.
    description: 'Repeats 2 recorded actions (1 click) over 20.5s, in Outlook (PWA) - Mail, Book1 - Excel.',
    origins: ['Outlook (PWA) - Mail', 'Book1 - Excel'],
    created: hoursAgo(50),
    updated: hoursAgo(3),
    payload: {
      version: 1, kind: 'recorded', agent: 'desktop', name: 'Outlook (PWA) · 6 clicks',
      events: [
        { x: 940, y: 520, delayMs: 0, action: 'Left Click Down' },
        { x: 940, y: 520, delayMs: 60, action: 'Left Click Release' },
      ],
      windows: [{ title: 'Outlook (PWA) - Mail', process: 'chrome' }],
    },
  },
  {
    id: 'wf_dev_1',
    source: 'web',
    kind: 'created',
    name: 'Reply that the invoice is approved',
    description: 'Re-runs its goal through the agent, so it adapts and can take different details each time.',
    origins: ['https://outlook.office.com'],
    created: hoursAgo(120),
    updated: hoursAgo(20),
    /* A created skill as extension/skills.js writes one: the goal with its variable parts lifted out by
     * parameterise(), the values that filled them as examples, and what one successful run did beside it as
     * evidence. This is the shape the Structure fold turns into a tool definition. */
     payload: {
      version: 1,
      kind: 'created',
      name: 'Reply that the invoice is approved',
      goalTemplate: 'Reply to {{recipient}} saying "{{text}}" and attach the latest invoice',
      params: [
        { name: 'recipient', type: 'email', example: 'accounts@northwind.example' },
        { name: 'text', type: 'quoted', example: 'the invoice is approved' },
      ],
      steps: [
        { name: 'open the thread', input: 'Invoice 4417' },
        { name: 'click Reply', input: '' },
        { name: 'type the message', input: 'the invoice is approved' },
        { name: 'attach the invoice', input: 'invoice-4417.pdf' },
      ],
      events: [],
    },
  },
];

const RUNS = [
  {
    id: 'r1', kind: 'agent', goal: 'send the welcome email to Margaryta', model: 'claude-opus-5',
    flowId: null, outcome: 'ok', summary: 'Sent it.', error: null, extension: null,
    startedAt: hoursAgo(3), finishedAt: new Date(now - 3 * 3600_000 + 7 * 60_000).toISOString(),
  },
  {
    id: 'r2', kind: 'replay', goal: null, model: null, flowId: 'dr_dev_1',
    outcome: 'ok', summary: null, error: null, extension: null,
    startedAt: hoursAgo(26), finishedAt: new Date(now - 26 * 3600_000 + 90_000).toISOString(),
  },
  {
    id: 'r3', kind: 'agent', goal: 'research AI browser agents and write it up', model: 'claude-opus-5',
    flowId: null, outcome: 'failed', summary: null, error: 'It used all 24 steps without finishing.',
    extension: '0.16.0',
    startedAt: hoursAgo(70), finishedAt: new Date(now - 70 * 3600_000 + 22 * 60_000).toISOString(),
  },
];

const GALLERY = [
  {
    id: 'sk_dev_1', name: 'Weekly Jira export', kind: 'recorded' as const,
    description: 'Opens the board, filters to last week and exports the CSV.',
    author: 'Margaryta Kashuba', installs: 4, published: hoursAgo(300),
    payload: { version: 1, kind: 'recorded', agent: 'desktop', events: [{ x: 10, y: 10, delayMs: 0, action: 'Left Click Down' }] },
  },
];

const json = (res: Parameters<Connect.NextHandleFunction>[1], status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

export const mockApi: Connect.NextHandleFunction = (req, res, next) => {
  const url = req.url ?? '';
  const method = (req.method ?? 'GET').toUpperCase();
  /* ---------------------------------------------------------------- conversations, kept
   *
   * Behaves rather than answers. A fixture that accepted a save and then returned an empty list would make a
   * working history look broken, which is the mistake the sign-out mock made and the reason this one does
   * the whole loop: saved, listed, read back, deleted. */
  if (url.startsWith('/api/chats')) {
    const asked = new URL(url, 'http://x').searchParams.get('thread');

    if (method === 'DELETE') {
      if (!asked || !chats.has(asked)) {
        return json(res, 404, { error: { type: 'chat_store_error', message: 'no conversation with that id on this account' } });
      }
      chats.delete(asked);
      return json(res, 200, { ok: true, deleted: asked });
    }

    if (method === 'POST') {
      /* Read off the stream. `req.body` is a Vercel convenience and does not exist in a Connect middleware,
       * so reaching for it made every save fail here with a 400 that production would not have returned -
       * a fixture failing where the real thing succeeds is worse than no fixture at all. */
      let text = '';
      req.on('data', (chunk) => { text += chunk; });
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch (_) {
          return json(res, 400, { error: { type: 'chat_store_error', message: 'that body is not JSON' } });
        }
        const id = String(body.thread ?? '');
        if (!id) {
          return json(res, 400, { error: { type: 'chat_store_error', message: 'thread is required' } });
        }
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const was = chats.get(id);
        chats.set(id, {
          id,
          // Set on first save only, like the real one: a conversation's name comes from how it started.
          title: was?.title || String(body.title ?? '').slice(0, 120) || 'Untitled',
          created: was?.created ?? new Date().toISOString(),
          updated: new Date().toISOString(),
          messages,
        });
        return json(res, 200, { ok: true, saved: messages.length, thread: id });
      });
      return undefined;
    }

    if (asked) {
      const found = chats.get(asked);
      if (!found) {
        return json(res, 404, { error: { type: 'chat_store_error', message: 'no conversation with that id on this account' } });
      }
      return json(res, 200, {
        ok: true,
        thread: { id: found.id, title: found.title, messages: found.messages.length, created: found.created, updated: found.updated },
        messages: found.messages,
      });
    }

    return json(res, 200, {
      ok: true,
      threads: [...chats.values()]
        .sort((a, b) => (a.updated < b.updated ? 1 : -1))
        .map((t) => ({ id: t.id, title: t.title, messages: t.messages.length, created: t.created, updated: t.updated })),
    });
  }

  if (!url.startsWith('/api/')) return next();

  /* Signed in until told otherwise. The real endpoint clears a session cookie and the next get-session
   * answers null; this is the same claim at the level a fixture can make it, and it matters because
   * AccountProvider.leave() now reads the session back rather than trusting the 200 - against a mock that
   * kept answering with a user, a working log-out reported itself as broken. */
  if (url.startsWith('/api/auth/get-session')) {
    return json(res, 200, { user: signedOut ? null : ACCOUNT });
  }
  if (url.startsWith('/api/auth/sign-out')) {
    signedOut = true;
    return json(res, 200, { success: true });
  }
  // So the wall can be gone through again without restarting the dev server.
  if (url.startsWith('/api/auth/sign-in')) {
    signedOut = false;
    return json(res, 200, { url: '/?auth=ok' });
  }

  if (url.startsWith('/api/sync?tokens=1')) {
    return json(res, 200, {
      ok: true,
      devices: [
        { id: 'dev_1', label: 'Chrome extension', createdAt: hoursAgo(200), lastUsedAt: hoursAgo(4) },
        { id: 'dev_2', label: 'Chrome extension', createdAt: hoursAgo(500), lastUsedAt: null },
      ],
    });
  }
  if (url.startsWith('/api/sync?issue=1')) {
    return json(res, 201, { ok: true, token: 'mf_dev_' + 'x'.repeat(38), device: { id: 'dev_3', label: 'Chrome extension', createdAt: new Date().toISOString(), lastUsedAt: null } });
  }
  if (url.startsWith('/api/sync')) {
    if (req.method === 'POST') return json(res, 200, { ok: true, saved: { flows: 1, runs: 1 }, problems: [] });
    if (req.method === 'DELETE') return json(res, 200, { ok: true });
    return json(res, 200, { ok: true, flows: FLOWS, runs: RUNS, you: ACCOUNT });
  }

  if (url.startsWith('/api/gallery')) {
    const id = /[?&]id=([^&]+)/.exec(url)?.[1];
    if (id) {
      const skill = GALLERY.find((s) => s.id === id);
      return skill ? json(res, 200, { ok: true, skill }) : json(res, 404, { error: { message: 'no such skill' } });
    }
    if (req.method === 'POST') return json(res, 201, { ok: true, skill: GALLERY[0] });
    return json(res, 200, { ok: true, skills: GALLERY });
  }

  if (url.startsWith('/api/account')) {
    return json(res, 200, {
      ok: true,
      deleted: { flows: 2, runs: 3, devices: 2, withdrawn: 0 },
      note: 'Your Google account is not ours to delete - sign out to finish.',
    });
  }

  /* The transcript, so the panel can be looked at without a session. A fixture of the SHAPE - the real
   * derivation is api/_transcript.js and it is pure, so what is worth checking here is that the panel reads
   * the shape the derivation produces. Two segments, one step with no context, and a gaps list, because
   * those are the three cases the panel has to render honestly. */
  if (url.startsWith('/api/transcript')) {
    if (method !== 'GET') return json(res, 200, { ok: true, removed: 1, remaining: 17, revision: 1, undo: { revision: 0 } });
    return json(res, 200, {
      ok: true,
      flow: {
        id: 'rec1', name: 'Send the weekly invoice', kind: 'recorded', source: 'desktop',
        created: new Date(Date.now() - 86400000).toISOString(),
        origins: [], windows: [{ title: 'Inbox — Outlook', process: 'chrome' }],
      },
      summary: {
        events: 18, clicks: 6, scrolls: 2, drags: 1, keys: 132, seconds: 74,
        // A count on both, which is what api/_transcript.js returns; the panel renders either.
        applications: 2, pages: 0,
        // Keystrokes and how long they took. No text: the agent never reads which key.
        typedSeconds: 47.2,
        captured: 'Every click, drag, scroll and pointer movement, as screen coordinates. For 6 of the 6 '
          + 'clicks the agent also read what was under the pointer - the application, the window, and for '
          + '5 of them the name and kind of the control. 132 keystrokes over 47.2s, counted and timed but '
          + 'never read: which key was pressed is not recorded anywhere, so this carries no text. No '
          + 'screenshots.',
        gaps: 2,
      },
      /* The narrative, which is what api/_transcript.js now returns first. Derived there from the same
       * steps below - no model writes it - so a fixture of it is a fixture of the SHAPE, and the wording
       * is a real example of what the derivation produces. */
      story: [
        { kind: 'overview', title: null, text: 'This recording runs 1m 14s. The work moves through 2 places, starting in Inbox — victorg — Outlook and ending in Q3-forecast.xlsx - Excel Online — Microsoft Edge.' },
        { kind: 'place', title: 'Inbox — victorg — Outlook', detail: 'OUTLOOK', at: 0, seconds: 41, text: 'Clicked "New mail" then "To", clicked once on something with no name to read, typed for 47.2s in "Message body" - 132 keystrokes and then clicked "Send". Most of the time here went on typing (47.2s of 41s).' },
        { kind: 'place', title: 'Q3-forecast.xlsx - Excel Online — Microsoft Edge', detail: 'msedge', at: 41000, seconds: 33, text: 'Clicked "B4" and then scrolled down.' },
        { kind: 'reading', title: 'Reading it', text: '47.2s of it - about 64% - went on typing, in 1 run; 6 clicks, 5 of them on something with a name; 2 wheel notches; 1 drag. Steady input for most of the recording, which is the shape of work being done rather than a screen being watched.' },
      ],
      segments: [
        {
          // Window as the label, application as the detail: one browser is many tabs, and "chrome" is not
          // where the work happened.
          n: 1, where: { kind: 'app', label: 'Inbox — victorg — Outlook', detail: 'OUTLOOK' }, startMs: 0, seconds: 41,
          steps: [
            { n: 1, at: 0, ms: 0, action: 'click', what: 'clicked the "New mail" button in OUTLOOK', target: '1030,1053', note: null },
            { n: 2, at: 4100, ms: 210, action: 'click', what: 'clicked the "To" edit box in OUTLOOK', target: '158,271', note: null },
            { n: 3, at: 9400, ms: 180, action: 'click', what: 'clicked at 980,612 in OUTLOOK', target: '980,612', note: 'OUTLOOK was under the pointer, but nothing there had a name the agent could read' },
            { n: 4, at: 11000, ms: 47200, action: 'type', what: 'typed for 47.2s - 132 keystrokes into the "Message body" edit box in OUTLOOK', target: null, note: 'which keys is not recorded, deliberately: the agent reads that a key was pressed and when, never which one, so nothing here can carry text - and a replay cannot reproduce it' },
          ],
          note: null,
        },
        {
          n: 2, where: { kind: 'app', label: 'Book1 - Excel', detail: 'EXCEL' }, startMs: 41000, seconds: 33,
          steps: [
            { n: 5, at: 41000, ms: 260, action: 'click', what: 'clicked the "B4" cell in EXCEL', target: '899,1058', note: null },
            { n: 6, at: 52000, ms: 90, action: 'scroll', what: 'scrolled down 3 notches in EXCEL', target: null, note: null },
          ],
          note: null,
        },
      ],
      gaps: [
        { question: 'What did I type?', why: 'No text, by design. The agent hooks the keyboard to learn '
          + 'THAT a key was pressed and when, and never touches vkCode - this recording spent 47.2s on 132 '
          + 'keystrokes. What was written is nowhere.' },
        { question: 'Can this be replayed exactly?', why: 'No. The typing run cannot be reproduced - a '
          + 'replay knows a key was pressed and not which - so it waits out the 47.2s and presses '
          + 'nothing, then carries on with the clicks.' },
        { question: 'Was anything missed?', why: 'A recording made over an elevated window is silently '
          + 'incomplete: the hook cannot see input while such a window has focus, and this cannot detect it.' },
      ],
    });
  }

  /* The assistant. A FIXTURE, not a fake loop: the reply is canned and says so in its own text, and it
   * exists because the bug it caught was pure layout - a 270px "based on" sidebar laid out beside the answer
   * inside a 416px panel, which left the words about 60px to be read in. That needs a rendered reply to
   * measure and nothing else. The model call itself is still not mocked; see below. */
  if (url.startsWith('/api/chat')) {
    if (method === 'GET') {
      return json(res, 200, {
        ok: true,
        configured: { anthropic: true, openai: true },
        models: { anthropic: ['claude-opus-5'], openai: ['gpt-5.6-luna'] },
        default: 'gpt-5.6-luna',
        database: true,
        rounds: 6,
        tools: ['search_runs', 'get_run', 'summarize_time', 'list_skills', 'find_repeated'],
      });
    }
    return json(res, 200, {
      ok: true,
      answer: 'This is a canned reply from the dev mock, long enough to show how an answer wraps when the '
        + 'panel is narrow and when it is wide. It mentions two recordings and a run so the layout has '
        + 'something to lay out, and it deliberately contains no markdown.',
      citations: [],
      used: [{ tool: 'list_skills', ok: true, detail: '{"limit":20}' }],
      usage: { input: 2562, output: 65 },
      provider: 'openai',
      model: 'gpt-5.6-luna',
    });
  }

  /* Deliberately not mocked: a model call costs money and a fake one would make the loop look like it
   * works when it has never spoken to anything. */
  return json(res, 501, { error: { message: 'not mocked - run against the deployment for this' } });
};
