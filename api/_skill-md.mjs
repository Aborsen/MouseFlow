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

/* The goal, back as lines. The wizard writes it as "opening\n1. …\n2. …", and then, when somebody added
 * notes in their own words, "\nAlso:\n<what they wrote>".
 *
 * THE THIRD PIECE USED TO BE DROPPED. Only the first non-numbered row became `opening` and only the
 * numbered rows survived, so everything after the list went in the bin - and that is precisely the half a
 * recording could never have produced. api/_compose.mjs exists because notes carry the knowledge the
 * screen did not: "finish with Send, not Save", "if a row already exists, stop and say so". The wizard
 * merges them into the goal so a runner executes them; the exported file threw them away, so a skill
 * carried out through MouseFlow and the same skill handed to another agent did DIFFERENT WORK, and
 * nothing said so.
 */
function goalLines(goalTemplate) {
  const rows = String(goalTemplate || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const numbered = rows.filter((l) => /^\d+\./.test(l));
  const opening = rows.find((l) => !/^\d+\./.test(l)) || '';
  /* Everything after the LAST numbered row: what was appended, not what introduced. With no numbered rows
   * at all - a goal written or dictated as prose - there is nothing trailing, because it is all opening. */
  const last = rows.map((l) => /^\d+\./.test(l)).lastIndexOf(true);
  const trailing = last === -1 ? [] : rows.slice(last + 1);
  return { opening, numbered, trailing };
}

const TYPE_WORD = { email: 'an email address', url: 'a URL', quoted: 'text' };

/* The addresses a recording passed through, in order, first occurrence only.
 *
 * QUERY AND FRAGMENT ARE DROPPED, and that is a privacy decision rather than tidying. A SKILL.md is a
 * document that gets downloaded, committed, forwarded and pasted into an agent - and a query string is
 * where a session token, a one-time link or a search somebody typed lives. `?view=list` mattering to a
 * flow is a real cost and the file says so, so a person can put back the part they need; a token leaving
 * in a file nobody reread is not a cost anybody can put back.
 *
 * `url` is written by the EXTENSION recorder. The desktop agent does not write one today, which is exactly
 * what `portability()` below reports rather than papering over. */
export function urlTrail(payload) {
  const events = Array.isArray(payload && payload.events) ? payload.events : [];
  const seen = new Set();
  const out = [];
  for (const event of events) {
    /* TWO PLACES, because the two recorders put it in different ones and reading one would find nothing
     * from the other half of the product. The extension writes `url` on the event - it has the tab. The
     * desktop agent writes it into the `#ctx` line above the event, which macro.ts parses onto
     * `context.url`, because that is where everything it reads off the accessibility tree goes. */
    const raw = event && typeof event.url === 'string' && event.url
      ? event.url
      : (event && event.context && typeof event.context.url === 'string' ? event.context.url : '');
    if (!/^https?:\/\//i.test(raw)) continue;
    let bare;
    try {
      const u = new URL(raw);
      bare = `${u.origin}${u.pathname === '/' ? '' : u.pathname}`;
    } catch (_) {
      continue;
    }
    if (seen.has(bare)) continue;
    seen.add(bare);
    out.push(bare);
    if (out.length >= 20) break;
  }
  return out;
}

/* Can this become a file that runs WITHOUT MouseFlow - on whatever browser tools the agent reading it
 * already has?
 *
 * The test is not "was this a browser" but "do we know the addresses". A recording with no URLs would have
 * to start "find the window called …", which is not something a cloud agent can do and not a step anybody
 * should ship.
 *
 * WHY THE URLS ARE PASSED IN. A skill-GOAL has no `events` of its own - it carries the goal, its parameters
 * and the steps of one run as evidence - so reading `payload.events` returned nothing for every one of
 * them, always, whatever had actually been recorded. Since that became the only kind of skill anybody can
 * make, this answered "not portable" by construction and then explained it with a reason about the
 * recorder, which sent the reader to look in the wrong place. The caller knows which flow the skill was
 * made from and can read ITS trail; this stays a pure function that judges what it is handed.
 *
 * The old reason said the desktop agent does not write web addresses. It DOES - since it learned to read
 * AXWebArea - and desktop recordings on real accounts carry them. That sentence was true once and was never
 * revisited, which is the failure mode a comment like this exists to prevent.
 */
export function portability(flow, knownUrls) {
  const urls = Array.isArray(knownUrls) && knownUrls.length
    ? knownUrls
    : urlTrail((flow && flow.payload) || {});

  /* A SKILL WRITTEN IN WORDS IS ALREADY PORTABLE, and that is the whole of this branch.
   *
   * The address rule was written for a REPLAY: a list of clicks with no address cannot be started by an
   * agent that has only browser tools, so it must not be shipped as one. A goal skill is not that. It says
   * what to achieve in a sentence a person wrote - "send a test email from my gmail to …" - and an agent
   * with browser tools can carry that out the same way a person would. Demanding a recorded URL demands
   * evidence this format never produces, and it refused the easiest way anybody has to author a skill:
   * saying it out loud.
   *
   * The generator already degrades correctly - "Where it happens" is simply left out when nothing is known
   * - so the file this produces was always buildable. The gate was stricter than the thing it guarded.
   */
  if (flow && flow.payload && flow.payload.kind === 'created') {
    return { ok: true, urls, why: '' };
  }

  if (urls.length) return { ok: true, urls, why: '' };
  return {
    ok: false,
    urls,
    why: 'this repeats recorded steps, and none of them landed on a web address — so there is nothing for '
      + 'another agent to open. Skills written or dictated as a goal can be exported this way.',
  };
}

/**
 * @param {object} structure  what structureOf() returned
 * @param {object} flow       the row, for its name
 * @param {{ description?: string, whenToUse?: string }} [written]  the two prose fields, when a model wrote
 *        them. Absent is normal and the file still builds.
 */
export function skillMarkdown(structure, flow, written = {}, opts = {}) {
  const s = structure || {};
  const title = String((flow && flow.name) || 'MouseFlow skill').trim() || 'MouseFlow skill';
  const created = s.kind === 'created';
  const params = Array.isArray(s.params) ? s.params : [];
  const origins = Array.isArray(s.origins) ? s.origins : [];
  const { opening, numbered, trailing } = goalLines(s.goalTemplate);
  /* PORTABLE: the same steps, carried out by whatever browser tools the agent reading this already has, on
   * its own machine. No MouseFlow at run time - no agent, no worker, no MCP tool.
   *
   * The steps are NOT re-derived for it. They are the ones the person approved in the wizard, notes and
   * all; deriving a second list from the recording would hand somebody a skill that differs from the one
   * they read and agreed to, which is a worse failure than any wording. What changes is everything ROUND
   * them: what has to be true first, what carries them out, and what going wrong looks like. */
  const portable = !!opts.portable;
  const urls = Array.isArray(opts.urls) ? opts.urls : [];
  /* Read off the goal rather than recorded, and never merged with the line above. An address somebody's
   * flow actually visited and an address a model worked out from a sentence are different kinds of fact,
   * and presenting the second as the first is the failure this whole file is careful about. */
  const inferred = Array.isArray(opts.inferredUrls) ? opts.inferredUrls : [];
  const desktopOnly = !!opts.desktopOnly;

  const description = String(written.description || '').trim() || String(s.description || '').trim();

  const out = [];
  out.push('---');
  out.push(`name: ${skillSlug(title)}`);
  out.push(`description: ${yaml(description)}`);
  out.push('---');
  out.push('');
  out.push(`# ${title}`);
  out.push('');
  const does = portable
    ? 'Carries out one recorded piece of work in a browser you drive.'
    : "Carries out one recorded piece of work on the user's own computer.";
  out.push(opening ? `${does} ${opening}` : does);
  out.push('');

  out.push('## When to use this');
  out.push('');
  const where = origins.length ? `, in ${origins.slice(0, 3).join(', ')}` : '';
  out.push(String(written.whenToUse || '').trim()
    || (portable
      ? `Use this when the user asks for this exact piece of work to be done${where}. It acts on a real, `
        + 'signed-in account in a browser, so it is never the right answer to a question — only to a '
        + 'request to actually do something.'
      : `Use this when the user asks for this exact piece of work to be done on their own machine${where}. `
        + 'It acts on a real computer, so it is never the right answer to a question — only to a request '
        + 'to actually do something.'));
  out.push('');

  /* The one section that decides whether a run is possible at all. Table rather than prose because every
   * row is a thing to go and check, not a thing to read. */
  out.push('## Prerequisites');
  out.push('');
  out.push('| Requirement | Notes |');
  out.push('|---|---|');
  if (portable) {
    out.push('| **Browser tools** | You carry this out yourself, in a browser you drive. In Claude Code or '
      + 'Cowork that is the `claude-in-chrome` tools; any equivalent will do. |');
    out.push('| **Signed in already** | The pages below assume an existing session. Do not attempt to sign '
      + 'in, and never handle credentials — stop and ask the user instead. |');
    out.push('| **No MouseFlow** | Nothing here needs the MouseFlow agent, worker or MCP connector. The '
      + 'recording is where these steps came from; it takes no part in running them. |');
  } else {
    out.push('| **MouseFlow MCP tools** | This skill does nothing on its own. The tool named below must be '
      + 'available — as a connector, or the local MCP server. |');
    out.push('| **The MouseFlow agent, running** | On the machine the work happens on. Nothing here can '
      + 'start it remotely. |');
    if (created) {
      out.push('| **The MouseFlow worker, running** | Only for this kind of skill: a model decides each '
        + 'step, so the machine has to be claiming jobs. Without it the call is queued and nobody picks it '
        + 'up. |');
    }
    if (origins.length) {
      out.push(`| Applications | ${cell(origins.slice(0, 6).join(', '))} — open and reachable on that machine. |`);
    }
    out.push('| **Somebody at the keyboard** | It drives the real pointer. Do not run it unattended, or on '
      + 'a machine somebody is using. |');
  }
  out.push('');

  /* The addresses, for the portable file only - they are the one anchor that survives a redesign, and the
   * first step of anything a cloud agent does is opening one. */
  if (portable && urls.length) {
    out.push('## Where it happens');
    out.push('');
    for (const u of urls) out.push(`- ${u}`);
    out.push('');
    out.push('Query strings were left out on purpose — they are where session tokens and one-time links '
      + 'live. If a flow needs one, add it here.');
    out.push('');
  } else if (portable && inferred.length) {
    out.push('## Where it happens');
    out.push('');
    for (const u of inferred) out.push(`- ${u}`);
    out.push('');
    out.push('**Read off the goal, not recorded.** This skill was written as a sentence rather than '
      + 'captured from a session, so nothing here was observed — these are the addresses the goal appears '
      + 'to mean. Check the first one before acting on it, and if the user meant somewhere else, go there '
      + 'instead.');
    out.push('');
  }

  /* Said in the file rather than refused at the door. Whether a goal needs a desktop is a judgement, and a
   * wrong judgement that BLOCKS costs somebody their export, while a wrong judgement that WARNS costs a
   * sentence the reader can weigh. The agent reading this is the one holding the tools; it can decide. */
  if (portable && desktopOnly) {
    out.push('> **This may need a desktop, not a browser.** It was carried out through applications on a '
      + 'computer rather than pages in a browser. If the steps below need something your browser tools '
      + 'cannot reach, stop and tell the user — do not improvise a web equivalent.');
    out.push('');
  }

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
    out.push('Ask the user for anything missing. Never invent a value — it gets typed into '
      + (portable ? 'a real, signed-in account' : 'a real application on their machine')
      + ' and cannot be undone from here.');
    out.push('');
  }

  out.push('## How to run it');
  out.push('');
  if (portable) {
    out.push('Carry out the steps below yourself, with your browser tools.');
    out.push('');
    out.push('- **Aim by name, never by coordinate.** The names in quotes are what the controls were called '
      + 'when this was recorded. Find them the way your tools find things; the numbers a recording holds '
      + 'came off somebody else\'s screen and mean nothing on yours.');
    out.push('- **Read the page before each step.** A name that has moved is normal; a name that is not '
      + 'there at all means the page is not the one these steps describe — stop and say so.');
    out.push('- **Do not improvise past the end.** These steps are the whole job.');
  } else {
    out.push(`Call the MCP tool \`${cell(s.toolName)}\`${params.length
      ? ` with ${params.map((p) => `\`${p.name}\``).join(', ')}`
      : ''}.`);
    out.push('');
    out.push(`It runs through ${cell(s.runsHow) || 'the local agent'}.`);
    out.push('');
    /* The rule the whole file rests on. Placed here rather than at the end because this is the moment an
     * agent that cannot find the tool decides what to do instead. */
    out.push('**If that tool is not available, stop and tell the user.** Do not attempt the steps below '
      + 'with browser or computer-use tools: they were recorded on a different screen, and carrying them '
      + 'out by hand aims at the wrong things on a real machine.');
  }
  out.push('');

  if (numbered.length) {
    out.push(portable ? '## The steps' : '## What it does');
    out.push('');
    out.push(portable
      ? 'These came from a recording of somebody doing this once.'
      : 'For reference — the tool carries this out; you do not.');
    out.push('');
    for (const line of numbered) out.push(line);
    out.push('');
    /* What the person added in their own words, kept WITH the steps rather than in a section of its own.
     * It is not commentary about the steps - it is part of the instruction, and the runner executes it. */
    if (trailing.length) {
      for (const line of trailing) out.push(line);
      out.push('');
    }
  }

  /* WHAT DONE LOOKS LIKE, before what can go wrong - a reader needs the target before the hazards.
   *
   * Written in the author's words and marked as a check rather than a step, because an agent handed a
   * condition among instructions will try to bring it about: told "the message appears in Sent", it opens
   * the Sent folder to make the sentence true. The test is what it is for, not something to achieve. */
  if (s.success) {
    out.push('## What done looks like');
    out.push('');
    out.push(String(s.success));
    out.push('');
    out.push('**Check this, do not carry it out.** It is how the person who recorded this could tell it had '
      + 'worked. If it is not true at the end, say so rather than reporting success - a run that stopped '
      + 'short is more use than one that claims something nobody can disagree with.');
    out.push('');
  }

  /* WHAT ONE RUN ACTUALLY DID, which is the one thing here that is not a description.
   *
   * The skill format has carried these since goal skills existed - `payload.steps`, the steps of the
   * recording or the run this was made from - and nothing rendered them. `grep -n "\.steps"` over this file
   * returned nothing at all. So a receiving agent got the instruction and no evidence, while the account
   * held a list of exactly what happened the time it worked.
   *
   * Below the instruction and clearly labelled, because it is NOT the instruction: the steps above are what
   * to do, and these are what one run did on somebody else's screen. An agent that followed these instead
   * would be replaying a stranger's session rather than carrying out the goal - which is the same confusion
   * "Repeat it exactly" was removed for. */
  const evidence = Array.isArray(s.steps) ? s.steps.filter((step) => step && step.name) : [];
  if (evidence.length) {
    out.push('## What one run did');
    out.push('');
    out.push('Evidence, not instructions. This is the sequence the person who made this skill actually '
      + 'carried out, on their screen, the time it worked — useful for telling whether a step above has '
      + 'gone missing, and for nothing else. Do not replay it.');
    out.push('');
    for (const step of evidence.slice(0, 60)) {
      out.push(`- ${cell(step.name)}${step.input ? ` — ${cell(step.input)}` : ''}`);
    }
    if (evidence.length > 60) out.push(`- …and ${evidence.length - 60} more`);
    out.push('');
  }

  out.push('## What can go wrong');
  out.push('');
  out.push('| What you get back | What it means |');
  out.push('|---|---|');
  if (portable) {
    out.push('| A named control is not on the page | It may have been renamed or moved behind a menu. Look '
      + 'once; if it is not there, stop and say which step failed. |');
    out.push('| A sign-in page | The session expired. Stop — do not sign in, and do not handle '
      + 'credentials. Tell the user. |');
    out.push('| The page looks nothing like the steps | This is the wrong page or the site was redesigned. '
      + 'Stop rather than improvising a path through it. |');
    out.push('| An input is missing | Ask the user for it. Never invent a value that gets typed into a real '
      + 'account. |');
    out.push('');
    out.push('Say which step you reached and what you saw. Nobody else can see the browser you drove.');
  } else {
    out.push('| "No MouseFlow agent answered" | The agent is not running on that machine. Ask the user to '
      + 'start it; you cannot. |');
    out.push('| "nothing picked this up" | No worker is claiming jobs there. Same answer. |');
    out.push('| It needs an input | A required argument was missing. Ask the user for it. |');
    out.push('| It ran but did the wrong thing | A window had moved or was not open. Report what came back '
      + 'verbatim rather than retrying — a second run repeats the same actions on the same machine. |');
    out.push('');
    out.push('Report whatever the tool returned, in its own words. It is the only account of what happened '
      + 'on that machine; nothing here can see the screen.');
  }
  out.push('');

  return out.join('\n');
}
