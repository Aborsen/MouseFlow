/* What MouseFlow tells people about its MCP server — in one place, because it is said in three.
 *
 * The settings panel where somebody copies the URL, the product page at /mcp, and the documentation all
 * describe the same server. Written three times they would drift, and the drift is not cosmetic: the last
 * time an instruction in this product went stale it sent somebody to a button that did not exist, and they
 * concluded the product was broken rather than that the sentence was.
 *
 * So the tool table lives here, and `mcp/test-mcp.mjs` asserts it against `api/mcp.js` — every tool the
 * server offers is named here, and nothing is named here that the server does not offer. A page that
 * promises a tool nobody implemented is the same class of lie as a button that is not there.
 *
 * What this file is NOT is the tool definitions. Those are derived from the account's own skills by
 * `api/_skill-schema.mjs` and served by `tools/list`; this is prose about the built-in ones.
 */

/** The endpoint itself. One path, resolved against wherever the app is being served from. */
export const MCP_PATH = '/api/mcp';

/* location.origin rather than a constant, so the URL is right on the deployment, on a preview build and on
 * a dev server without any of them having to be listed. Somebody copying this out of a preview and finding
 * it points at production is a subtle, expensive kind of wrong. */
export const mcpUrl = (origin?: string) =>
  (origin ?? (typeof location === 'undefined' ? 'https://mouseflowapp.vercel.app' : location.origin))
    .replace(/\/$/, '') + MCP_PATH;

export type ToolGroup = 'read' | 'machine' | 'control';

export interface McpTool {
  name: string;
  group: ToolGroup;
  /** What it answers, in a sentence somebody reading the page can check against what they get. */
  what: string;
  /** Its arguments, as they appear in the tool definition. Empty where it takes none. */
  args: string;
}

export const TOOL_GROUPS: Record<ToolGroup, { title: string; note: string }> = {
  read: {
    title: 'Reading — nothing has to be running',
    note: 'A recording, a run and the time it took are rows on your account. These answer the moment the '
      + 'connector is added: no agent, no computer awake, nothing installed.',
  },
  machine: {
    title: 'Doing — your computer has to be listening',
    note: 'Recording and replaying are things only the agent on your machine can do. These become a job it '
      + 'picks up; if nothing is listening, the answer says so instead of leaving the call to time out.',
  },
  control: {
    title: 'The machinery itself',
    note: 'For when an answer said something was still going, or nothing picked it up.',
  },
};

/* Every tool. There used to be one MORE per skill on the account, generated from its own schema; they are
 * gone, and skills are run through `mouseflow_run` instead. The reason is written where the tool is
 * defined: a per-skill tool costs its definition in every request forever, and a library of fifty put nine
 * thousand tokens of tool definitions in front of every message and fifty date-shaped names in the
 * permission list.
 *
 * Kept from the old note, because it is still the thing that matters: the definitions here are prose about
 * what the server offers, and the suite checks them against `api/mcp.js` in both directions.
 *
 * (Historic:) The per-skill tools were not here because they are yours, and there was one for each
 * skill on the account — `mouseflow_recordings` is how you see them. */
export const MCP_TOOLS: McpTool[] = [
  /* FIRST, because it is the first thing asked. Every other tool answers a question about YOUR account;
   * this one answers "what is this, and what does it record" - and an assistant with no way to look that up
   * answers it anyway, from the tool names and from training, wrongly in the places that matter most. */
  {
    name: 'mouseflow_help',
    group: 'read',
    what: 'The documentation itself, fetched from mouseflow.ai/docs, so an assistant answers "what does '
      + 'MouseFlow record?" out of the page rather than out of memory. Needs no account, no agent and no '
      + 'data of yours.',
    args: 'question: what you want to know · page: a page id, to read one whole',
  },
  {
    name: 'mouseflow_recordings',
    group: 'read',
    what: 'What the account holds: recordings and the skills made from them, with names, sizes, which '
      + 'applications they happened in and when.',
    args: 'kind: all | recording | skill · limit: 1–200 (50)',
  },
  {
    name: 'mouseflow_transcript',
    group: 'read',
    what: 'One recording as prose steps — what was clicked, in which window, how long each part took, and '
      + 'what the recording cannot answer. The same derivation the transcript panel shows.',
    args: 'recording: id (required) · steps: 1–400 (120)',
  },
  {
    name: 'mouseflow_runs',
    group: 'read',
    what: 'What was actually run: the goal, the model that drove it, how it ended and how long it took.',
    args: 'days: 1–365 (30) · outcome: any | ok | failed | stopped · limit: 1–200 (50)',
  },
  {
    name: 'mouseflow_activity',
    group: 'read',
    what: 'The account in numbers over a window — how much was recorded, how many runs and how they ended, '
      + 'and which applications the work happened in.',
    args: 'days: 1–365 (30)',
  },
  {
    name: 'mouseflow_start_recording',
    group: 'machine',
    what: 'Starts the recording timer on your computer — the same timer the Record page shows. It captures '
      + 'clicks, drags, scrolls and pointer movement, and that a key was pressed, never which key.',
    args: 'moveMs: 0–1000 (0) — how coarsely to sample pointer movement',
  },
  {
    name: 'mouseflow_stop_recording',
    group: 'machine',
    what: 'Stops it and saves what was captured to the account, answering with the name, the id, the count '
      + 'and the applications it happened in.',
    args: '—',
  },
  {
    name: 'mouseflow_status',
    group: 'control',
    what: 'How many skills the account holds, how many of them can run on a desktop, whether a computer has '
      + 'asked for work lately, and anything queued or running. Ask this first when a call says nothing '
      + 'picked it up.',
    args: '—',
  },
  {
    name: 'mouseflow_stop',
    group: 'control',
    what: 'Cancels whatever is queued or running. Safe to call when nothing is happening.',
    args: '—',
  },
  {
    name: 'mouseflow_run_status',
    group: 'control',
    what: 'How a run that was still going is getting on. Only needed when an answer named a run id.',
    args: 'run: the id the earlier answer named (required)',
  },
  {
    name: 'mouseflow_run',
    group: 'control',
    what: 'Runs one of your skills on the paired machine. Ask mouseflow_recordings which there are and what '
      + 'each one takes.',
    args: 'skill: its id (required) · arguments: what it asks for',
  },
  {
    name: 'mouseflow_do',
    group: 'control',
    what: 'Carries out something described in plain language in your own Chrome, through the browser '
      + 'extension, when no saved skill covers it. Needs "Let my AI run skills in this browser" switched '
      + 'on in the panel. There is no desktop equivalent yet: the desktop agent carries no model of its own.',
    args: 'goal: what should be done, in a sentence (required)',
  },
];

export interface ConnectWay {
  id: string;
  label: string;
  /** One line: who this is for. */
  lead: string;
  /** What to do, in order. A line beginning with `$` is a command; everything else is prose. */
  steps: string[];
  /** Said after the steps, where there is something worth knowing. */
  note?: string;
}

/* The three ways in, in the order most people want them. OAuth first everywhere, because a token somebody
 * has to carry is the thing that turns an organisation's connector into one shared account. */
export const CONNECT_WAYS = (url: string): ConnectWay[] => [
  {
    id: 'claude',
    label: 'Claude — web or desktop',
    lead: 'Sign in with the MouseFlow account you already have. Nothing to copy, nothing to keep.',
    steps: [
      'Open Settings → Connectors in Claude, then Add custom connector.',
      `Paste this URL: ${url}`,
      'Claude registers itself and sends you to MouseFlow’s own sign-in — Google, or your email and '
        + 'password, whichever you already use.',
      'Approve once, on a page that says exactly what the connector will be able to do.',
    ],
    note: 'What Claude ends up holding identifies you, not the installation — so everyone in a team adds '
      + 'the same URL and each sees only their own recordings and skills. Take it back any time under '
      + 'Settings → My account.',
  },
  {
    id: 'code',
    label: 'Claude Code',
    lead: 'The same OAuth sign-in, from a terminal.',
    steps: [
      `$ claude mcp add --transport http mouseflow ${url}`,
      'Then run /mcp inside Claude Code and choose to authenticate. A browser opens on the same consent '
        + 'page.',
    ],
  },
  {
    id: 'token',
    label: 'A device token — where there is no browser',
    lead: 'CI, a headless box, or a client that cannot do OAuth.',
    steps: [
      'Settings → My account → Pair a device. The token starts with mf_ and is shown once.',
      `$ claude mcp add --transport http mouseflow ${url} --header "Authorization: Bearer mf_…"`,
    ],
    note: 'It is a credential: it signs in as you. Never put it in a URL — this server does not read one '
      + 'from a query string, and the MCP specification forbids it. Revoke it in the same place you made it.',
  },
];

/* The thing people are most surprised by, so it is stated wherever the URL is. */
export const CONSENT_LINE = 'Reading works the moment you connect. Asking it to DO something — start a '
  + 'recording, run a skill — needs your computer to be listening, and the app asks you first: a banner '
  + 'appears on the Record page saying what was asked for, with one button that lets it through.';
