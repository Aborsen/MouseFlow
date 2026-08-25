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

/* Что в мок записали через POST /api/sync. В памяти, как и всё остальное состояние фикстуры: живёт столько,
 * сколько живёт dev-сервер. */
const pushedFlows = new Map<string, unknown>();
const deletedFlows = new Set<string>();
/* Which gallery listings have been withdrawn since this server started. In memory like the rest: the point
 * is that a withdraw is VISIBLE afterwards - the listing leaves the list and a second press is refused -
 * not that it survives a restart. */
const withdrawnListings = new Set<string>();
const pushedRuns: unknown[] = [];

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
  /* A recording the ACCOUNT has and this browser does not - the state that produced "I deleted the
   * recordings and the assistant still sees them". No `dr_` prefix and no skill role, so it is exactly what
   * the orphan strip on Record is for: a recording whose local copy is gone, or one made on another
   * machine. */
  {
    id: 'ronly_account_1',
    source: 'desktop',
    kind: 'recorded',
    name: 'Neon Console · 4 clicks',
    description: 'Repeats 4 recorded actions (4 clicks) over 9.1s, in Neon Console - Google Chrome.',
    origins: ['Neon Console - Google Chrome'],
    created: hoursAgo(80),
    updated: hoursAgo(20),
    payload: {
      version: 1,
      kind: 'recorded',
      agent: 'desktop',
      role: 'recording',
      events: [
        { x: 640, y: 380, delayMs: 0, action: 'Left Click Down', context: { app: 'chrome', window: 'Neon Console - Google Chrome', control: 'Run', type: 'button' } },
        { x: 640, y: 380, delayMs: 60, action: 'Left Click Release' },
        { x: 700, y: 420, delayMs: 900, action: 'Left Click Down' },
        { x: 700, y: 420, delayMs: 60, action: 'Left Click Release' },
      ],
      windows: [{ title: 'Neon Console - Google Chrome', process: 'chrome' }],
    },
  },
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
     * evidence. This is the shape the Structure fold turns into a tool definition.
     *
     * AND IT IS PUBLISHED, which no fixture was: `publishedAs` is the only thing the app reads to know that,
     * so without one the Published pill, Republish and Withdraw were all unreachable in the preview - three
     * controls nobody could look at. The id matches a GALLERY listing below, because that is the pair the
     * real thing forms. */
     payload: {
      version: 1,
      kind: 'created',
      name: 'Reply that the invoice is approved',
      publishedAs: 'sk_dev_1',
      publishedAt: hoursAgo(30),
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
      /* Only the addresses. The extension recorder writes `url` on the events that carry one, and this is
       * what makes the PORTABLE export reachable in dev - without it every fixture is a desktop recording
       * with no urls, and the only thing a person can see here is the refusal. The query on the second one
       * is deliberate: urlTrail() drops it, and a fixture that never carried one would not prove that. */
      events: [
        { x: 0, y: 0, delayMs: 0, action: 'Focus', url: 'https://outlook.office.com/mail/inbox' },
        { x: 0, y: 0, delayMs: 900, action: 'Focus', url: 'https://outlook.office.com/mail/id/AAQk?token=secret' },
      ],
    },
  },
];

/* `steps` и `said` есть на проводе с самого начала - api/sync.js отдаёт обе колонки, - и в этом наборе их
 * не было, поэтому история прогонов на моке выглядела бы пустой при работающем сервере. Ровно тот случай,
 * ради которого этот файл переписывали трижды: мок, отвечающий не тем, чем отвечает сервер, показывает
 * рабочий код сломанным.
 *
 * Формы шагов ДВЕ, и это не небрежность: десктопный цикл пишет {tool, input, ms}, расширение - свою. Обе
 * здесь, потому что Earlier предлагает «сделать скилл» только по первой, и проверить это можно только
 * имея вторую. */
const RUNS = [
  {
    id: 'dr_251119120000', kind: 'agent', goal: 'send the welcome email to Margaryta', model: 'claude-opus-5',
    flowId: null, outcome: 'ok', summary: 'Sent it.', error: null, extension: null,
    said: ['Outlook is already open, so I will use that rather than launching it.'],
    steps: [
      { tool: 'activate_window', input: { process: 'OUTLOOK' }, ms: { shot: 90, model: 4200, act: 380 } },
      { tool: 'click', input: { x: 120, y: 88, label: 'New mail' }, ms: { shot: 88, model: 3900, act: 360 } },
      { tool: 'type_text', input: { text: 'margaryta@example.com' }, ms: { shot: 91, model: 3100, act: 420 } },
      { tool: 'press_key', input: { key: 'Tab' }, ms: { shot: 87, model: 2600, act: 355 } },
      { tool: 'type_text', input: { text: 'Welcome!\n\nGlad to have you with us.' }, ms: { shot: 90, model: 4800, act: 470 } },
      { tool: 'click', input: { x: 74, y: 140, label: 'Send' }, ms: { shot: 89, model: 5200, act: 365 } },
    ],
    startedAt: hoursAgo(3), finishedAt: new Date(now - 3 * 3600_000 + 7 * 60_000).toISOString(),
  },
  {
    id: 'r2', kind: 'replay', goal: null, model: null, flowId: 'dr_dev_1',
    outcome: 'ok', summary: null, error: null, extension: null, said: [], steps: [],
    startedAt: hoursAgo(26), finishedAt: new Date(now - 26 * 3600_000 + 90_000).toISOString(),
  },
  {
    id: 'r3', kind: 'agent', goal: 'research AI browser agents and write it up', model: 'claude-opus-5',
    flowId: null, outcome: 'failed', summary: null, error: 'It used all 24 steps without finishing.',
    extension: '0.16.0',
    said: ['Opening the first result to read it properly.'],
    /* Форма расширения: нет `tool`, есть `host`. Earlier не предложит сделать из неё десктопный скилл, и
     * это единственный способ увидеть, что не предложит. */
    steps: [{ host: 'www.google.com' }, { host: 'arxiv.org' }, { host: 'arxiv.org' }],
    startedAt: hoursAgo(70), finishedAt: new Date(now - 70 * 3600_000 + 22 * 60_000).toISOString(),
  },
  {
    /* Прогон, чья строка шагов не несёт: так выглядят строки, записанные до того, как шаги стали
     * записываться. История обязана сказать про них правду, а не «ничего не делал». */
    id: 'r4', kind: 'agent', goal: 'rename the sheet to Q3 and save it', model: 'claude-opus-5',
    flowId: null, outcome: 'stopped', summary: null, error: 'Stopped.', extension: null,
    said: [], steps: [],
    startedAt: hoursAgo(96), finishedAt: new Date(now - 96 * 3600_000 + 40_000).toISOString(),
  },
];

/* Published flows, in the shape api/gallery.js actually returns.
 *
 * The old fixture had `author` as a string and `published` instead of `publishedAt`, so the card read
 * `skill.author.name`, got undefined, and rendered "by " and "Invalid Date" - working code looking broken.
 * That is the third mock in this project to answer differently from the server it stands in for, and each of
 * the three cost more than writing it properly would have.
 *
 * Fourteen rather than one, because the page has rows, a collection view and pagination, and the rule those
 * rest on - a row appears only when it says something the row above did not - cannot be seen or disproved
 * over a single card. Some carry origins that overlap the recordings in the local fixture, which is what
 * lets the "In the apps you use" row exist at all; one has no installs, so "Most installed" has something to
 * leave out. */
const listing = (
  id: string, name: string, kind: 'recorded' | 'created', description: string,
  author: string, installs: number, hours: number, origins: string[],
  actions: number | null, params: { name: string; type: string }[] = [],
) => ({
  id, name, kind, description,
  author: { name: author, image: null },
  origins, installs, publishedAt: hoursAgo(hours), withdrawn: false, params, actions,
  payload: kind === 'recorded'
    ? {
      version: 1, kind: 'recorded', agent: 'desktop', origins,
      events: Array.from({ length: Math.max(1, actions ?? 1) }, (_, i) => ({
        x: 100 + i * 7, y: 200 + i * 3, delayMs: i === 0 ? 0 : 120,
        action: i % 5 === 0 ? 'Left Click Down' : 'Mouse Movement',
      })),
    }
    : { version: 1, kind: 'created', agent: 'web', origins, goalTemplate: description, params },
});

const GALLERY = [
  listing('sk_dev_1', 'Complete spreadsheet totals', 'created', 'Calculate and fill the Total column for every visible row.', 'Priya S.', 34, 190, ['https://docs.google.com/spreadsheets'], null, [{ name: 'sheet', type: 'text' }, { name: 'column', type: 'text' }]),
  listing('sk_dev_2', 'Download monthly invoices', 'recorded', 'Collects the current invoices into a named Finance folder.', 'Noah M.', 28, 420, ['Billing - Google Chrome', 'Downloads - File Explorer'], 214),
  listing('sk_dev_3', 'Triage the morning inbox', 'recorded', 'Labels, prioritises and archives new mail in one pass.', 'Alex R.', 21, 620, ['Inbox - Outlook'], 486),
  listing('sk_dev_4', 'Reply to approval requests', 'created', 'Finds pending approvals and prepares short confirmations.', 'Nina K.', 19, 90, ['Inbox - Outlook'], null, [{ name: 'recipient', type: 'email' }]),
  listing('sk_dev_5', 'Compare product pricing', 'recorded', 'Captures price and plan details from three browser tabs.', 'Daniel F.', 15, 300, ['Pricing - Google Chrome'], 152),
  listing('sk_dev_6', 'Open the dashboard', 'recorded', 'Navigates to analytics and opens the latest activity view.', 'Mara', 12, 700, ['Neon Console - Google Chrome'], 63),
  listing('sk_dev_7', 'Research a topic with Claude', 'created', 'Researches a topic and assembles the findings in a doc.', 'Vic Gorlenko', 8, 40, ['https://claude.ai'], null, [{ name: 'topic', type: 'quoted' }]),
  listing('sk_dev_8', 'Update CRM contacts', 'created', 'Enriches a contact and records the latest sales activity.', 'Leo T.', 7, 26, ['https://app.salesforce.com'], null, [{ name: 'contact', type: 'email' }]),
  listing('sk_dev_9', 'Organize downloads', 'recorded', 'Sorts new downloads into folders by file type.', 'Sofia P.', 6, 500, ['Downloads - File Explorer'], 97),
  listing('sk_dev_10', 'Send the weekly status email', 'created', 'Assembles completed tasks and prepares a team update.', 'Emma C.', 5, 60, ['Inbox - Outlook'], null, []),
  listing('sk_dev_11', 'Summarize competitor pages', 'created', 'Reads open product pages and writes a comparison brief.', 'Omar B.', 4, 18, ['https://www.notion.so'], null, [{ name: 'competitor', type: 'text' }]),
  listing('sk_dev_12', 'Clean customer data', 'recorded', 'Normalises names, removes duplicates, flags gaps.', 'Iris W.', 3, 800, ['book.xlsx - Excel'], 331),
  listing('sk_dev_13', 'Weekly Jira export', 'recorded', 'Opens the board, filters to last week and exports the CSV.', 'Margaryta Kashuba', 2, 900, ['Backlog - Jira - Google Chrome'], 128),
  listing('sk_dev_14', 'Archive finished tickets', 'recorded', 'Moves everything marked done into the archive project.', 'Tomas L.', 0, 8, ['Backlog - Jira - Google Chrome'], 74),
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
    /* Записанное запоминается.
     *
     * POST отвечал успехом и ничего не менял, а GET отдавал неподвижную фикстуру - значит «сохранил, и список
     * изменился» в превью не проверялось вообще. На этом я попадался дважды: мок выхода отвечал успехом и
     * продолжал отдавать сессию, мок разговоров принимал сохранение и возвращал пустую историю. Один раз
     * работающая функция выглядела сломанной, другой - наоборот. */
    if (req.method === 'POST') {
      let text = '';
      req.on('data', (chunk) => { text += chunk; });
      req.on('end', () => {
        let body: { flows?: unknown[]; runs?: unknown[]; deleted?: string[] } = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch (_) {
          return json(res, 400, { error: { type: 'sync_error', message: 'that body is not JSON' } });
        }

        const flows = Array.isArray(body.flows) ? body.flows : [];
        for (const flow of flows) {
          const id = String((flow as { id?: unknown }).id ?? '');
          if (!id) continue;
          // Upsert по id, как настоящий: сохранить одно и то же дважды обновляет строку, а не удваивает её.
          pushedFlows.set(id, flow);
          deletedFlows.delete(id);
        }
        for (const id of Array.isArray(body.deleted) ? body.deleted : []) {
          deletedFlows.add(String(id));
          pushedFlows.delete(String(id));
        }
        const runs = Array.isArray(body.runs) ? body.runs : [];
        for (const run of runs) pushedRuns.push(run);

        /* The counts where the real endpoint puts them - top level - not under a `saved` key that only ever
         * existed in the type. A fixture answering the type instead of the server is a fixture that confirms
         * a mistake. */
        return json(res, 200, {
          ok: true,
          flows: flows.length,
          runs: runs.length,
          deleted: Array.isArray(body.deleted) ? body.deleted.length : 0,
          problems: [],
        });
      });
      return undefined;
    }
    if (req.method === 'DELETE') return json(res, 200, { ok: true });
    return json(res, 200, {
      ok: true,
      /* Фикстуры плюс записанное, минус помеченное удалённым - то есть тот же порядок правил, что у
       * настоящего эндпоинта, и «сохранил → видно» наконец проверяется. */
      flows: [
        ...FLOWS.filter((f) => !deletedFlows.has(f.id) && !pushedFlows.has(f.id)),
        ...pushedFlows.values(),
      ],
      runs: [...RUNS, ...pushedRuns],
      you: ACCOUNT,
    });
  }

  if (url.startsWith('/api/gallery')) {
    const id = /[?&]id=([^&]+)/.exec(url)?.[1];

    /* Withdraw, modelled rather than waved through. This route answered ANY method carrying an id with the
     * skill itself, so a DELETE came back 200 and the caller was told a listing had been taken down that was
     * still there - and the second press, which the real endpoint answers 404 for ("not your skill, or
     * already withdrawn"), was never reachable. Both are states the button has to handle. */
    if (req.method === 'DELETE') {
      if (!id) return json(res, 400, { error: { message: 'which skill?' } });
      const known = GALLERY.some((s) => s.id === id);
      if (!known || withdrawnListings.has(id)) {
        return json(res, 404, { error: { message: 'not your skill, or already withdrawn' } });
      }
      withdrawnListings.add(id);
      return json(res, 200, { ok: true, withdrawn: id });
    }

    if (id) {
      const skill = GALLERY.find((s) => s.id === id);
      // Withdrawn is gone as far as a reader is concerned: the real query filters `withdrawn_at is null`.
      return skill && !withdrawnListings.has(id)
        ? json(res, 200, { ok: true, skill })
        : json(res, 404, { error: { message: 'no such skill' } });
    }
    if (req.method === 'POST') return json(res, 201, { ok: true, skill: GALLERY[0] });
    /* Searches, because the field on the page does. A fixture that ignores ?q= makes a working search look
     * broken - the same class of lie as the sign-out mock that reported success and kept the session. Name
     * and description only, which is what the real index covers. */
    const asking = new URL(url, 'http://x').searchParams.get('q');
    const live = GALLERY.filter((s) => !withdrawnListings.has(s.id));
    const matched = asking
      ? live.filter((s) => (s.name + ' ' + s.description).toLowerCase().includes(asking.toLowerCase()))
      : live;
    return json(res, 200, { ok: true, skills: matched, total: matched.length, shown: matched.length });
  }

  if (url.startsWith('/api/account')) {
    return json(res, 200, {
      ok: true,
      deleted: { flows: 2, runs: 3, devices: 2, withdrawn: 0 },
      note: 'Your Google account is not ours to delete - sign out to finish.',
    });
  }

  /* One skill as an Agent Skill file.
   *
   * The REAL generator and the real structureOf, from the same modules production uses; only the two prose
   * fields a model would write are faked, and one request in three pretends it had no model at all so the
   * derived fallback is reachable without turning a key off. */
  if (url.startsWith('/api/skill-md')) {
    if (method !== 'POST') {
      return json(res, 405, { error: { type: 'skill_md_error', message: 'POST a skill id' } });
    }
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      void (async () => {
        let body: { flow?: string; portable?: boolean } = {};
        try { body = text ? JSON.parse(text) : {}; } catch (_) { /* handled below */ }
        const id = String(body.flow || '');
        const portable = body.portable === true;
        const flow = [...FLOWS, ...pushedFlows.values()]
          .find((f) => (f as { id?: string }).id === id) as
            { id: string; name: string; kind?: string; source?: string; payload?: unknown } | undefined;
        if (!flow) {
          return json(res, 404, {
            error: { type: 'skill_md_error', message: 'no skill with that id on this account' },
          });
        }
        const [{ structureOf }, { skillMarkdown, skillFileName, skillSlug, portability }] = await Promise.all([
          import('../../../api/_skill-schema.mjs'),
          import('../../../api/_skill-md.mjs'),
        ]);
        const structure = structureOf(flow);
        const row = flow;
        /* The real gate, not a fixture of one: the dev flows are desktop recordings with no urls, so the
         * portable refusal is what a person sees here - which is exactly what they would see in production
         * for the same recording, and the reason worth reading. */
        const portably = portability(flow);
        if (portable && !portably.ok) {
          return json(res, 200, { ok: false, portable: true, why: portably.why });
        }
        /* What a model would have written, for a fixture. Deliberately in the voice the tool asks for. */
        /* The two prose fields differ BY MODE, because the real route gives the model a different system
         * prompt for each - a portable file that talked about the MouseFlow agent would be a fixture
         * teaching the wrong thing about the feature it exists to show. */
        const written = id.endsWith('1')
          ? (portable ? {
            description: `Use this when the user asks to run "${row.name}" in their browser. Carries the `
              + 'steps out with your own browser tools on pages they are already signed in to.',
            whenToUse: 'Use it when somebody asks for this work to be actually done, not described. It '
              + 'acts on a real, signed-in account, so it is never the answer to a question. If the page '
              + 'does not look like the steps, stop rather than improvising.',
          } : {
            description: `Use this when the user asks to run "${row.name}" on their own computer. `
              + 'Drives the real pointer through the MouseFlow agent on a paired machine.',
            whenToUse: 'Use it when somebody asks for this work to be actually done, not described. It '
              + 'acts on a real computer, so it is never the answer to a question. If no MouseFlow tool is '
              + 'available, say so rather than attempting the steps another way.',
          })
          : {};
        return json(res, 200, {
          ok: true,
          portable,
          filename: skillFileName(row.name),
          slug: skillSlug(row.name),
          written: !!written.description,
          text: skillMarkdown(structure, flow, written, { portable, urls: portably.urls }),
        });
      })();
    });
    return undefined;
  }

  /* Placing what somebody wrote onto the steps they recorded.
   *
   * Only the MODEL is faked. The plan below is handed to the REAL applyPlan from api/_compose.mjs, because
   * the half worth exercising in a browser is the half that decides what the goal text ends up being - and
   * a fixture that reimplemented the splice would be a fixture agreeing with itself. The plan is written to
   * hit all three outcomes at once: one line placed, one clash reported, one sentence left unplaced.
   */
  if (url.startsWith('/api/compose')) {
    if (method !== 'POST') return json(res, 200, { ok: false, why: 'POST a step list and some notes' });
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      void (async () => {
        let body: { steps?: { n: number; instruction: string }[]; notes?: string; opening?: string } = {};
        try { body = text ? JSON.parse(text) : {}; } catch (_) { /* handled below */ }
        const steps = Array.isArray(body.steps) ? body.steps : [];
        const said = String(body.notes || '').split('\n').map((l) => l.replace(/^[•\-*]\s*/, '').trim())
          .filter(Boolean);
        if (!said.length || !steps.length) {
          return json(res, 200, { ok: false, why: 'nothing was written, so there is nothing to place' });
        }
        const { applyPlan } = await import('../../../api/_compose.mjs');
        const applied = applyPlan({ steps, opening: body.opening }, {
          insert: said[0] ? [{ after: steps[0].n, instruction: said[0], from: said[0] }] : [],
          conflicts: said[1] && steps.length > 1
            ? [{ n: steps[steps.length - 1].n, note: said[1], why: 'the recording did something else here' }]
            : [],
          unplaced: said[2] ? [{ note: said[2], why: 'it reads as context rather than an action' }] : [],
        });
        return json(res, 200, { ok: true, ...applied, dropped: 0, limit: 300 });
      })();
    });
    return undefined;
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
            { n: 1, at: 0, ms: 0, action: 'click', what: 'clicked the "New mail" button in OUTLOOK', target: '1030,1053', note: null, control: 'New mail', controlType: 'button', role: 'AXButton', keys: 0 },
            { n: 2, at: 4100, ms: 210, action: 'click', what: 'clicked the "To" edit box in OUTLOOK', target: '158,271', note: null, control: 'To', controlType: 'edit box', role: 'AXTextField', keys: 0 },
            { n: 3, at: 9400, ms: 180, action: 'click', what: 'clicked at 980,612 in OUTLOOK', target: '980,612', note: 'OUTLOOK was under the pointer, but nothing there had a name the agent could read', control: null, controlType: null, keys: 0 },
            { n: 4, at: 11000, ms: 47200, action: 'type', what: 'typed for 47.2s - 132 keystrokes into the "Message body" edit box in OUTLOOK', target: null, note: 'which keys is not recorded, deliberately: the agent reads that a key was pressed and when, never which one, so nothing here can carry text - and a replay cannot reproduce it', control: 'Message body', controlType: 'edit box', role: 'AXTextArea', keys: 132 },
          ],
          note: null,
        },
        {
          n: 2, where: { kind: 'app', label: 'Book1 - Excel', detail: 'EXCEL' }, startMs: 41000, seconds: 33,
          steps: [
            { n: 5, at: 41000, ms: 260, action: 'click', what: 'clicked the "B4" cell in EXCEL', target: '899,1058', note: null, control: 'B4', controlType: 'cell', role: 'AXCell', keys: 0 },
            /* A SECOND run into the same box as step 4. Real recordings are full of these - one measured
             * recording typed into a single "Prompt" nine times - and without one here the wizard's
             * "2 of 2" counter and its prompt1/prompt2 naming are unreachable in dev. */
            { n: 9, at: 44000, ms: 5200, action: 'type', what: 'typed for 5.2s - 24 keystrokes into the "Message body" edit box in OUTLOOK', target: null, note: null, control: 'Message body', controlType: 'edit box', role: 'AXTextArea', keys: 24 },
            /* How every recording made from the app ends: a click on MouseFlow's OWN stop button. It is
             * bookkeeping about the recording, not part of the work, and a skill that repeats it presses
             * Stop on a recorder nobody started. Here so the fold is reachable in dev. */
            { n: 10, at: 62000, ms: 180, action: 'click', what: 'clicked the "Stop and save this recording" button in MouseFlow', target: '1180,74', note: null, control: 'Stop and save this recording', controlType: 'button', role: 'AXButton', keys: 0 },
            { n: 6, at: 52000, ms: 90, action: 'scroll', what: 'scrolled down 3 notches in EXCEL', target: null, note: null, control: null, controlType: null, role: null, keys: 0 },
            /* Two typing runs that are NOT fields - Enter and Escape at a dialog, which the hit-test names
             * after the dialog. Measured on a real recording (see api/_typing.mjs); here so that the folded
             * -away half of the wizard's second step is reachable in dev without a real machine. */
            { n: 7, at: 58000, ms: 400, action: 'type', what: 'pressed a key into the "Save as" dialog in EXCEL', target: null, note: null, control: 'Save as', controlType: 'диалоговое окно', role: 'AXGroup', keys: 2 },
            { n: 8, at: 61000, ms: 300, action: 'type', what: 'pressed a key into the "Save as" dialog in EXCEL', target: null, note: null, control: 'Save as', controlType: 'диалоговое окно', role: 'AXGroup', keys: 1 },
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

  /* Teams. A fixture with one of each role in it, because the screen's whole job is to show the difference
   * between them: an owner sees everybody's activity, a member sees only the shared skills and their own.
   * A screen that could only be looked at signed in to a real deployment is a screen nobody looks at while
   * they are changing it - and the same emptiness made it the one settings screen with no picture in the
   * documentation. */
  /* The Dashboard. A fixture whose numbers AGREE WITH EACH OTHER, which is the only kind worth having:
   * byOutcome sums to totals.runs, the day rows sum to the same, the application shares plus the
   * unattributed share come to one. A fixture that disagrees with itself teaches the page to render
   * something that can never arrive, and the first person to notice is a user looking at real data.
   *
   * Added because there was nothing here: /api/insights answered 501 and the Dashboard rendered its error
   * box, which is what the documentation's screenshot of it showed. */
  if (url.startsWith('/api/insights')) {
    const asked = new URLSearchParams(url.split('?')[1] || '');
    const days = Number(asked.get('days')) || 30;
    const from = new Date(now - days * 86400_000).toISOString();
    /* The team scope, and the same rule the endpoint enforces: only a team this account owns or
     * administers. 't_dev3' is here to be REFUSED - the page has a path for a team the reader may not
     * read, and a fixture where every id succeeds never renders it. */
    const wantsTeam = asked.get('team');
    if (wantsTeam && wantsTeam !== 't_dev1' && wantsTeam !== 't_dev2') {
      return json(res, 403, {
        error: {
          type: 'insights_error',
          message: 'Only an owner or an admin sees a team’s numbers. Yours are on the personal view.',
        },
      });
    }
    /* One row per member, and the rows SUM TO THE HEADER: runs 24+15+8 = 47, recordings 9+6+3 = 18,
     * skills 3+2+1 = 6, hours 1.80+1.10+0.52 = 3.42. A team fixture whose people disagree with its own
     * totals teaches the page to render something that can never arrive. */
    const people = [
      {
        id: ACCOUNT.id, name: ACCOUNT.name, email: ACCOUNT.email, role: 'owner', you: true,
        recordings: 9, createdSkills: 3, runs: 24, ok: 20, failed: 3, stopped: 1,
        agentHours: 1.8, lastRun: hoursAgo(2), lastMade: hoursAgo(3),
      },
      {
        id: 'u_dev2', name: 'Margaryta K.', email: 'margaryta@example.dev', role: 'admin', you: false,
        recordings: 6, createdSkills: 2, runs: 15, ok: 13, failed: 1, stopped: 1,
        agentHours: 1.1, lastRun: hoursAgo(20), lastMade: hoursAgo(26),
      },
      {
        id: 'u_dev3', name: 'Pavlo D.', email: 'pavlo@example.dev', role: 'member', you: false,
        recordings: 3, createdSkills: 1, runs: 8, ok: 6, failed: 1, stopped: 0,
        agentHours: 0.52, lastRun: hoursAgo(48), lastMade: hoursAgo(50),
      },
    ];
    /* Narrowing to one member. The roster stays WHOLE while the counting narrows, exactly as the endpoint
     * does it — a picker holding only the person already chosen is a filter with no way out. */
    const wantsPerson = asked.get('person');
    const roster = wantsTeam === 't_dev2' ? people.slice(0, 2) : people;
    const chosen = wantsPerson ? roster.find((row) => row.id === wantsPerson) : null;
    const scope = wantsTeam
      ? {
        kind: 'team',
        team: { id: wantsTeam, name: wantsTeam === 't_dev2' ? 'Finance' : 'Operations' },
        role: wantsTeam === 't_dev2' ? 'admin' : 'owner',
        people: roster,
        ...(chosen
          ? { person: { id: chosen.id, name: chosen.name, email: chosen.email, you: chosen.you } }
          : {}),
      }
      : { kind: 'personal', people: [] };
    const teamTotals = {
      runs: 47, ok: 39, failed: 5, stopped: 2, running: 1,
      recordings: 18, createdSkills: 6, agentHours: 3.42,
    };
    /* Filtered to one member, the header must be THEIR numbers, not the team's. Without this the fixture
     * renders "Margaryta K." above the whole team's 47 runs, which teaches the page that the filter is
     * cosmetic — and the real endpoint narrows the accounts it counts, so it never would. */
    const totals = chosen
      ? {
        runs: chosen.runs,
        ok: chosen.ok,
        failed: chosen.failed,
        stopped: chosen.stopped,
        running: Math.max(0, chosen.runs - chosen.ok - chosen.failed - chosen.stopped),
        recordings: chosen.recordings,
        createdSkills: chosen.createdSkills,
        agentHours: chosen.agentHours,
      }
      : teamTotals;
    const share = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 1000 : 0);
    /* Nine days with something on them, summing to the team's 47. */
    const teamDayRuns = [3, 6, 2, 8, 5, 4, 9, 6, 4];
    const teamDayOk = [3, 5, 2, 7, 4, 3, 8, 5, 2];
    const teamDayFailed = [0, 1, 0, 1, 0, 1, 1, 0, 1];
    /* Spread a smaller total over the same nine days, with the rounding remainder landing on the busiest
     * day, so the columns still sum to the header exactly. */
    const spread = (want: number, from: number[]) => {
      const of = from.reduce((a, b) => a + b, 0);
      if (!of || want === of) return from;
      const out = from.map((n) => Math.floor((n * want) / of));
      // Whatever rounding down left over goes to the busiest days first, so the shape stays recognisable.
      const busiest = from.map((_, i) => i).sort((a, b) => from[b] - from[a]);
      let left = want - out.reduce((a, b) => a + b, 0);
      for (let i = 0; left > 0; i = (i + 1) % busiest.length, left -= 1) out[busiest[i]] += 1;
      return out;
    };
    const dayRuns = chosen ? spread(totals.runs, teamDayRuns) : teamDayRuns;
    const dayOk = chosen ? spread(totals.ok, teamDayOk) : teamDayOk;
    const dayFailed = chosen ? spread(totals.failed, teamDayFailed) : teamDayFailed;
    /* ownerId on every row, in both scopes: the endpoint sends it either way, and a fixture that only had
     * it under `team` would let the personal view drift into depending on its absence. Filtered to one
     * member, only their own rows survive — the real query counts their runs and nobody else's. */
    const skillRows = [
        {
          flowId: 'wf_dev_1', ownerId: ACCOUNT.id,
          name: 'Reply that the invoice is approved', kind: 'created', source: 'web',
          runs: 11, ok: 10, failed: 1, medianSeconds: 122.0, lastRunAt: hoursAgo(4),
        },
        {
          flowId: 'dr_dev_1', ownerId: wantsTeam ? 'u_dev2' : ACCOUNT.id,
          name: 'Outlook (PWA) · 6 clicks', kind: 'recorded', source: 'desktop',
          runs: 7, ok: 6, failed: 1, medianSeconds: 140.9, lastRunAt: hoursAgo(27),
        },
        {
          flowId: 'ronly_account_1', ownerId: wantsTeam ? 'u_dev3' : ACCOUNT.id,
          name: 'Neon Console · 4 clicks', kind: 'recorded', source: 'desktop',
          runs: 3, ok: 3, failed: 0, medianSeconds: 9.1, lastRunAt: hoursAgo(50),
        },
      ];

    return json(res, 200, {
      ok: true,
      scope,
      window: { days, from, to: new Date(now).toISOString(), timeZone: 'UTC' },
      totals,
      previous: chosen
        ? {
          from: new Date(now - days * 2 * 86400_000).toISOString(), to: from,
          had: true,
          runs: Math.round(totals.runs * 0.66), ok: Math.round(totals.ok * 0.62),
          failed: Math.max(0, totals.failed - 1), stopped: 0,
          agentHours: Math.round(totals.agentHours * 0.63 * 100) / 100,
        }
        : {
          from: new Date(now - days * 2 * 86400_000).toISOString(), to: from,
          had: true, runs: 31, ok: 24, failed: 6, stopped: 1, agentHours: 2.15,
        },
      byOutcome: (['ok', 'failed', 'stopped', 'running'] as const).map((outcome) => ({
        outcome, runs: totals[outcome], share: share(totals[outcome], totals.runs),
      })),
      byDay: dayRuns.map((runs, i) => ({
        day: new Date(now - (dayRuns.length - i) * 86400_000).toISOString().slice(0, 10),
        runs, ok: dayOk[i], failed: dayFailed[i],
        agentSeconds: Math.round(runs * 262.4),
      })),
      applications: [
        { name: 'chrome', kind: 'app', recordings: 9, runs: 24, seconds: 5120.4, share: 0.416 },
        { name: 'outlook', kind: 'app', recordings: 4, runs: 11, seconds: 2740.8, share: 0.223 },
        { name: 'excel', kind: 'app', recordings: 3, runs: 7, seconds: 1980.2, share: 0.161 },
        { name: 'slack', kind: 'app', recordings: 1, runs: 3, seconds: 890.6, share: 0.072 },
        { name: 'https://app.hubspot.com', kind: 'origin', recordings: 1, runs: 2, seconds: 604.0, share: 0.049 },
      ],
      unattributed: {
        seconds: 966.1,
        share: 0.079,
        why: 'Time that happened but cannot be placed: agent steps with no page or no timing, the model '
          + 'thinking between steps, and the part of a recording before anything named where it was.',
      },
      repeated: [
        {
          signature: 'sig_invoice', label: 'reply that the invoice is approved', times: 11,
          seconds: 1342.5, timed: 11, lastAt: hoursAgo(4), flowIds: ['wf_dev_1'],
        },
        {
          signature: 'sig_pipeline', label: 'update the pipeline sheet from the CRM', times: 7,
          seconds: 986.0, timed: 6, lastAt: hoursAgo(27), flowIds: ['dr_dev_1'],
        },
        {
          signature: 'sig_triage', label: 'triage the overnight support queue', times: 5,
          seconds: 611.2, timed: 5, lastAt: hoursAgo(51), flowIds: [],
        },
      ],
      slowestSteps: [
        { tool: 'screenshot', calls: 214, medianMs: 812, p90Ms: 1640 },
        { tool: 'click', calls: 189, medianMs: 240, p90Ms: 610 },
        { tool: 'type', calls: 96, medianMs: 1180, p90Ms: 2310 },
        { tool: 'wait_for', calls: 44, medianMs: 2050, p90Ms: 4400 },
      ],
      failures: [
        {
          reason: 'the window it was recorded in was not open', times: 3, lastAt: hoursAgo(20),
          example: { runId: 'r_dev_9', error: 'no window matching "Book1 - Excel"' },
        },
        {
          reason: 'stopped at a checkpoint and nobody answered', times: 2, lastAt: hoursAgo(72),
          example: { runId: 'r_dev_4', error: 'checkpoint "send the reply" timed out after 10m' },
        },
      ],
      skills: chosen ? skillRows.filter((r) => r.ownerId === chosen.id) : skillRows,
      gaps: [
        {
          question: 'How much time did this save me?',
          why: 'Nothing here holds how long the same task takes by hand, and there is no field for it in '
            + 'user_run. Agent hours are measured wall clock; "time saved" would be a number this endpoint '
            + 'made up, so it does not report one.',
        },
        {
          question: 'Why is my mail time listed under a browser?',
          why: 'Because the application a click landed in is a PROCESS name, read from the window manager, '
            + 'and a web app hosted in a browser is that browser: Outlook as a PWA counts as chrome.',
        },
        {
          question: 'Where did the rest of my day go?',
          why: 'Only runs and recordings are timed. The hours between them are recorded nowhere, so these '
            + 'day totals are activity, not a working day.',
        },
      ],
      caps: {
        days: 365,
        applications: { shown: 5, total: 5, limit: 12 },
        repeated: { shown: 3, total: 3, limit: 10 },
        slowestSteps: { shown: 4, total: 4, limit: 10, minCalls: 2 },
        failures: { shown: 2, total: 2, limit: 10 },
        skills: { shown: 3, total: 3, limit: 20 },
      },
    });
  }

  if (url.startsWith('/api/team')) {
    const query = new URLSearchParams(url.split('?')[1] || '');
    /* TWO teams, not one. One person runs several - an operations team, a finance team, a client - and the
     * screen is built for that: a column of teams, and a dashboard switch that becomes a select past the
     * second. A fixture with a single team would leave both of those branches unlooked at. */
    if (method === 'GET' && !query.get('id')) {
      return json(res, 200, {
        ok: true,
        teams: [
          { id: 't_dev1', name: 'Operations', role: 'owner', members: 3, created_at: hoursAgo(720) },
          { id: 't_dev2', name: 'Finance', role: 'admin', members: 2, created_at: hoursAgo(300) },
        ],
        /* CONFIGURED, because that is what the deployment is: kuswise.com is verified with Resend and both
         * variables are set on production. The fixture tracks the live app rather than the app we intend to
         * have — a screenshot is a claim, and one showing "no email leaves this deployment" beside a
         * deployment that emails would be the wrong claim to keep in a document. Flip it back the day the
         * variables come off, and retake the pictures. */
        mail: { configured: true, problem: null },
      });
    }
    if (method === 'GET' && query.get('id') === 't_dev2') {
      const fortnight2 = (pattern: number[]) => pattern.map((runs, i) => ({
        day: new Date(now - (pattern.length - 1 - i) * 86400_000).toISOString().slice(0, 10),
        runs,
        failed: 0,
      }));
      return json(res, 200, {
        ok: true,
        team: { id: 't_dev2', name: 'Finance', created: hoursAgo(300), createdBy: 'u_dev2' },
        you: { role: 'admin' },
        members: [
          {
            id: ACCOUNT.id, role: 'admin', joined: hoursAgo(300), name: ACCOUNT.name, email: ACCOUNT.email,
            activity: {
              recordings: 12, skills: 3, runs: 41, lastRecorded: hoursAgo(3), lastRun: hoursAgo(2),
              days: fortnight2([2, 3, 4, 3, 5, 2, 0, 3, 4, 6, 3, 2, 1, 3]),
            },
          },
          {
            id: 'u_dev4', role: 'owner', joined: hoursAgo(300), name: 'Iryna B.', email: 'iryna@example.dev',
            activity: {
              recordings: 4, skills: 1, runs: 9, lastRecorded: hoursAgo(70), lastRun: hoursAgo(66),
              days: fortnight2([0, 1, 0, 2, 0, 0, 1, 0, 3, 0, 0, 1, 0, 1]),
            },
          },
        ],
        invites: [],
        shared: [],
      });
    }
    if (method === 'GET') {
      /* Fourteen days of runs per person, because that is what the member cards draw. Three different
       * RHYTHMS rather than three different totals: somebody steady, somebody bursty, and somebody who
       * barely appears — which is the whole reason the card shows a shape instead of one more number. */
      const fortnight = (pattern: number[], fails: number[] = []) => pattern.map((runs, i) => ({
        day: new Date(now - (pattern.length - 1 - i) * 86400_000).toISOString().slice(0, 10),
        runs,
        failed: fails[i] ?? 0,
      }));
      return json(res, 200, {
        ok: true,
        team: { id: 't_dev1', name: 'Operations', created: hoursAgo(720), createdBy: ACCOUNT.id },
        you: { role: 'owner' },
        members: [
          {
            id: ACCOUNT.id, role: 'owner', joined: hoursAgo(720), name: ACCOUNT.name, email: ACCOUNT.email,
            activity: {
              recordings: 12, skills: 3, runs: 41, lastRecorded: hoursAgo(3), lastRun: hoursAgo(2),
              // steady, with one bad Thursday
              days: fortnight([2, 3, 4, 3, 5, 2, 0, 3, 4, 6, 3, 2, 1, 3], [0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0]),
            },
          },
          {
            id: 'u_dev2', role: 'admin', joined: hoursAgo(400), name: 'Margaryta K.', email: 'margaryta@example.dev',
            activity: {
              recordings: 7, skills: 2, runs: 18, lastRecorded: hoursAgo(26), lastRun: hoursAgo(20),
              // bursty: nothing for days, then a big Tuesday
              days: fortnight([0, 0, 1, 0, 0, 9, 2, 0, 0, 0, 3, 1, 0, 2], [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]),
            },
          },
          {
            id: 'u_dev3', role: 'member', joined: hoursAgo(96), name: 'Pavlo D.', email: 'pavlo@example.dev',
            activity: {
              recordings: 2, skills: 0, runs: 4, lastRecorded: hoursAgo(50), lastRun: hoursAgo(48),
              // barely started
              days: fortnight([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1]),
            },
          },
        ],
        invites: [{ email: 'newcomer@example.dev', role: 'member', created: hoursAgo(12) }],
        shared: [{
          flowId: 'wf_dev_1', ownerId: ACCOUNT.id, owner: ACCOUNT.name,
          name: 'Reply that the invoice is approved',
          description: 'Re-runs its goal through the agent, so it adapts and can take different details each time.',
          source: 'web', kind: 'created', missing: false, at: hoursAgo(20),
        }],
      });
    }
    /* Writes are not mocked: they would have to be remembered to be believed, and the screen is read far
     * more often than it is written to. */
    return json(res, 501, { error: { message: 'not mocked - run against the deployment for this' } });
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
