/* A MouseFlow skill as an Agent Skill - the SKILL.md an agent can be given directly.
 *
 * WHAT THIS IS NOT. It is not a fourth wire format. `wireFor()` next door emits a TOOL DEFINITION - a name,
 * a description and a JSON schema - which is what a model is handed so it can CALL something. This is a
 * DOCUMENT: frontmatter and prose, loaded into an agent's context so it knows when to reach for the tool,
 * what has to be true first, and what to do when it goes wrong.
 *
 * The two are not alternatives. A SKILL.md cannot move a mouse. Everything here ends in a call to the MCP
 * tool named in the frontmatter, and the whole file exists to make that call happen at the right moment
 * with the right arguments - the same shape as any hand-written agent skill that ends by invoking another.
 *
 * WHICH IS WHY THERE IS NO "DOING IT WITHOUT MOUSEFLOW" SECTION, and its absence is deliberate rather than
 * unfinished. An agent with computer-use, handed a numbered list of clicks and no tool, will try to carry
 * them out itself - on somebody's real machine, aiming at coordinates that came from a different screen.
 * The file says the opposite in as many words: without the tool, stop and say so.
 *
 * DERIVED, NOT WRITTEN. Every section below is built from `structureOf()` - the same derivation the tool
 * definitions use - so an export costs nothing, works offline, and cannot disagree with the tool it
 * describes. Two fields are the exception and they are the two that decide whether an agent ever reaches
 * for this at all: `description` and "When to use this". A derived description reads "Carries out: In
 * Outlook, do this:", which is a summary of the mechanism and a poor trigger. Those two are passed in when
 * a model has written them, and fall back to the derived text when it has not - so the file is always
 * produced, and is better when the model was reachable.
 */

const slug = (name) => String(name || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60) || 'mouseflow-skill';

/** `name:` must be a slug an agent can address; the title keeps what a person actually called it. */
export const skillSlug = slug;
export const skillFileName = (name) => `${slug(name)}-SKILL.md`;

/* YAML frontmatter is whitespace-significant and a description is written by a person or a model, so it can
 * contain a colon, a quote, or a newline - each of which breaks the block in a different way. Folded to one
 * line and single-quoted, with the one escape single-quoted YAML has. */
const yaml = (value) => `'${String(value || '').replace(/\s+/g, ' ').trim().replace(/'/g, "''")}'`;

const cell = (value) => String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** The numbered goal, back as lines. `goalTemplate` is written by the wizard as "opening\n1. …\n2. …". */
function goalLines(goalTemplate) {
  const rows = String(goalTemplate || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const numbered = rows.filter((l) => /^\d+\./.test(l));
  const opening = rows.find((l) => !/^\d+\./.test(l)) || '';
  return { opening, numbered };
}

const TYPE_WORD = { email: 'an email address', url: 'a URL', quoted: 'text' };

/**
 * @param {object} structure  what structureOf() returned
 * @param {object} flow       the row, for its name
 * @param {{ description?: string, whenToUse?: string }} [written]  the two prose fields, when a model wrote
 *        them. Absent is normal and the file still builds.
 */
export function skillMarkdown(structure, flow, written = {}) {
  const s = structure || {};
  const title = String((flow && flow.name) || 'MouseFlow skill').trim() || 'MouseFlow skill';
  const created = s.kind === 'created';
  const params = Array.isArray(s.params) ? s.params : [];
  const origins = Array.isArray(s.origins) ? s.origins : [];
  const { opening, numbered } = goalLines(s.goalTemplate);

  const description = String(written.description || '').trim() || String(s.description || '').trim();

  const out = [];
  out.push('---');
  out.push(`name: ${skillSlug(title)}`);
  out.push(`description: ${yaml(description)}`);
  out.push('---');
  out.push('');
  out.push(`# ${title}`);
  out.push('');
  out.push(opening
    ? `Carries out one recorded piece of work on the user's own computer. ${opening}`
    : 'Carries out one recorded piece of work on the user\'s own computer.');
  out.push('');

  out.push('## When to use this');
  out.push('');
  out.push(String(written.whenToUse || '').trim()
    || `Use this when the user asks for this exact piece of work to be done on their own machine`
      + `${origins.length ? `, in ${origins.slice(0, 3).join(', ')}` : ''}. It acts on a real computer, so `
      + 'it is never the right answer to a question — only to a request to actually do something.');
  out.push('');

  /* The one section that decides whether a run is possible at all. Table rather than prose because every
   * row is a thing to go and check, not a thing to read. */
  out.push('## Prerequisites');
  out.push('');
  out.push('| Requirement | Notes |');
  out.push('|---|---|');
  out.push('| **MouseFlow MCP tools** | This skill does nothing on its own. The tool named below must be '
    + 'available — as a connector, or the local MCP server. |');
  out.push('| **The MouseFlow agent, running** | On the machine the work happens on. Nothing here can start '
    + 'it remotely. |');
  if (created) {
    out.push('| **The MouseFlow worker, running** | Only for this kind of skill: a model decides each step, '
      + 'so the machine has to be claiming jobs. Without it the call is queued and nobody picks it up. |');
  }
  if (origins.length) {
    out.push(`| Applications | ${cell(origins.slice(0, 6).join(', '))} — open and reachable on that machine. |`);
  }
  out.push('| **Somebody at the keyboard** | It drives the real pointer. Do not run it unattended, or on a '
    + 'machine somebody is using. |');
  out.push('');

  if (params.length) {
    out.push('## Inputs');
    out.push('');
    out.push('| Name | Type | Required |');
    out.push('|---|---|---|');
    for (const p of params) {
      out.push(`| \`${cell(p.name)}\` | ${cell(TYPE_WORD[p.type] || 'text')} | ${p.example ? 'no' : 'yes'} |`);
    }
    out.push('');
    /* Said outright, because the failure it prevents is the expensive one: a value invented to satisfy a
     * required argument is typed into somebody's real application. */
    out.push('Ask the user for anything missing. Never invent a value — it gets typed into a real '
      + 'application on their machine and cannot be undone from here.');
    out.push('');
  }

  out.push('## How to run it');
  out.push('');
  out.push(`Call the MCP tool \`${cell(s.toolName)}\`${params.length
    ? ` with ${params.map((p) => `\`${p.name}\``).join(', ')}`
    : ''}.`);
  out.push('');
  out.push(`It runs through ${cell(s.runsHow) || 'the local agent'}.`);
  out.push('');
  /* The rule the whole file rests on. Placed here rather than at the end because this is the moment an
   * agent that cannot find the tool decides what to do instead. */
  out.push('**If that tool is not available, stop and tell the user.** Do not attempt the steps below with '
    + 'browser or computer-use tools: they were recorded on a different screen, and carrying them out by '
    + 'hand aims at the wrong things on a real machine.');
  out.push('');

  if (numbered.length) {
    out.push('## What it does');
    out.push('');
    out.push('For reference — the tool carries this out; you do not.');
    out.push('');
    for (const line of numbered) out.push(line);
    out.push('');
  }

  out.push('## What can go wrong');
  out.push('');
  out.push('| What you get back | What it means |');
  out.push('|---|---|');
  out.push('| "No MouseFlow agent answered" | The agent is not running on that machine. Ask the user to '
    + 'start it; you cannot. |');
  out.push('| "nothing picked this up" | No worker is claiming jobs there. Same answer. |');
  out.push('| It needs an input | A required argument was missing. Ask the user for it. |');
  out.push('| It ran but did the wrong thing | A window had moved or was not open. Report what came back '
    + 'verbatim rather than retrying — a second run repeats the same actions on the same machine. |');
  out.push('');
  out.push('Report whatever the tool returned, in its own words. It is the only account of what happened '
    + 'on that machine; nothing here can see the screen.');
  out.push('');

  return out.join('\n');
}
