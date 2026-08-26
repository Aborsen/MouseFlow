/* POST /api/skill-md - one skill as an Agent Skill file.
 *
 * The document, not the tool definition. `wireFor()` already emits what a model is handed so it can CALL a
 * skill; this is what an agent is given so it knows WHEN to, what has to be true first, and what to do when
 * it comes back wrong. Both describe the same skill and neither replaces the other - see api/_skill-md.mjs.
 *
 * WHY THE SERVER BUILDS IT rather than the browser. The row is the authority on what a skill is, and the
 * app holds a copy that can be a sync behind. A file somebody downloads, hands to an agent and forgets
 * about must describe the skill as it IS, not as this browser last saw it. Everything below reads the flow
 * out of the database by id, under the caller's own account.
 *
 * The model is optional here, and the two things it writes are the two that decide whether an agent ever
 * reaches for the file: `description` and "When to use this". Derived, they read "Carries out: In Outlook,
 * do this:" - a summary of the mechanism, and a poor trigger. So this asks, and falls back without
 * complaint: a deployment with no key, or a model that is busy, still gets the file.
 */
import { neon } from '@neondatabase/serverless';
import { whoIsCalling } from './_session.js';
import { ask, DEFAULT_MODEL, ProviderError } from './_provider.js';
import { structureOf } from './_skill-schema.mjs';
import { portability, skillFileName, skillMarkdown, skillSlug, urlTrail } from './_skill-md.mjs';
import { report, wrap } from './_report.js';
/* Один потолок на все маршруты, тратящие ключ развёртывания - см. api/_spend.mjs. */
import { overSpend, spentWhy } from './_spend.mjs';
/* Один заголовочный набор на все маршруты - см. api/_cors.mjs. Семь копий этих строк разошлись
 * ровно в том месте, где это стоило дороже всего: chats.js отражал ЛЮБОЙ origin и выдавал
 * Allow-Credentials, то есть чужая страница читала разговоры человека его же кукой. */
import { cors } from './_cors.mjs';

const TRIGGER_TOOL = {
  name: 'describe_the_skill',
  description: 'Write the two lines that decide whether an agent reaches for this skill.',
  schema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'One sentence, under 300 characters, in the voice of an agent-skill description: what '
          + 'it does and when to use it. Start with "Use this when". Name the applications. Do not '
          + 'describe how it works internally.',
      },
      whenToUse: {
        type: 'string',
        description: 'Two to four sentences: when this is the right answer, and when it is not. Say plainly '
          + 'that it acts on a real computer, so it answers a request to DO something, never a question.',
      },
      /* THE CONVERSION. A goal written in words says where it happens the way a person would - "my gmail",
       * "our Notion" - and an agent with browser tools needs an address to open. Nothing recorded it,
       * because nothing was recorded: the goal was spoken. So it is READ OFF THE GOAL, and the file says
       * that is where it came from, because an inferred address presented as a recorded one is a lie that
       * looks like a fact. */
      webAddresses: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only for a goal carried out in a browser: the addresses the goal implies, as bare '
          + 'origins - "https://mail.google.com" for "my gmail". At most three, most likely first. Empty if '
          + 'the goal names no recognisable web application, and empty rather than guessed.',
      },
      desktopOnly: {
        type: 'boolean',
        description: 'True when the goal needs applications on a computer rather than pages in a browser - '
          + '"the spreadsheet on screen", Outlook the program, Finder. An agent with only browser tools '
          + 'cannot carry that out, and the file has to say so instead of pretending.',
      },
    },
    required: ['description', 'whenToUse'],
    additionalProperties: false,
  },
};


const fail = (res, status, message) =>
  res.status(status).json({ error: { type: 'skill_md_error', message } });

/** What the model is shown. The goal, the inputs, and where it runs - not the whole event list. */
function briefOf(structure, name) {
  return [
    `Name: ${name}`,
    structure.origins.length ? `Applications: ${structure.origins.slice(0, 6).join(', ')}` : '',
    structure.params.length
      ? `Inputs it asks for: ${structure.params.map((p) => `${p.name} (${p.type})`).join(', ')}`
      : 'It asks for nothing.',
    '',
    'What it carries out:',
    String(structure.goalTemplate || structure.description || '').slice(0, 4000),
  ].filter(Boolean).join('\n');
}

async function handler(req, res) {
  cors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') return fail(res, 405, 'POST a skill id');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = typeof body.flow === 'string' ? body.flow.trim() : '';
  /* The PORTABLE file: the same steps, carried out by whatever browser tools the agent reading it already
   * has. No MouseFlow at run time at all. */
  const portable = body.portable === true;
  if (!id) return fail(res, 400, 'which skill? pass { flow: "<id>" }');

  if (!process.env.DATABASE_URL) return fail(res, 503, 'this deployment has no database');
  const sql = neon(process.env.DATABASE_URL);

  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (err) {
    await report(err, req, { route: 'skill-md' });
    return fail(res, 500, 'could not check who is calling');
  }
  if (!who) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return fail(res, 401, 'sign in first — a skill belongs to one account');
  }

  /* Scoped in the WHERE clause, and a flow that is not the caller's is a 404 rather than a 403: the ids are
   * chosen by the client, so a 403 would turn this into an oracle for guessing them. Same rule as
   * /api/transcript, and it has to stay the same rule. */
  const rows = await sql`
    select client_id as id, name, description, payload, source, kind, origins
    from user_flow
    where user_id = ${who.id} and client_id = ${id} and deleted_at is null
    limit 1`;
  if (!rows.length) return fail(res, 404, 'no skill with that id on this account');

  const flow = rows[0];
  const structure = structureOf(flow);

  /* Gated on whether the addresses are KNOWN, not on whether it looked like a browser. A browser recording
   * with no URLs would have to begin "find the window called …", which a cloud agent cannot do and nobody
   * should ship.
   *
   * A SKILL IS ASKED ABOUT THE RECORDING IT CAME FROM. A skill-goal has no events of its own, so looking
   * only at its own payload answered "no addresses" for every skill ever made, and then blamed the
   * recorder. The recording it was made from is one row away and is where the trail actually is - scoped to
   * the same account, like every other read here, and a missing or deleted source simply leaves the trail
   * empty rather than failing the request. */
  let trail = urlTrail(flow.payload || {});
  const cameFrom = flow.payload && flow.payload.fromRecording;
  if (!trail.length && cameFrom) {
    const source = await sql`
      select payload from user_flow
      where user_id = ${who.id} and client_id = ${cameFrom} and deleted_at is null
      limit 1`;
    if (source.length) trail = urlTrail(source[0].payload || {});
  }
  const portably = portability(flow, trail);
  if (portable && !portably.ok) {
    return res.status(200).json({ ok: false, portable: true, why: portably.why });
  }

  /* ПОТОЛОК НА ОБЩИЙ КЛЮЧ. Это был единственный маршрут, тратящий его без счёта вовсе: он проверяет, кто
   * звонит, читает один принадлежащий звонящему флоу и идёт прямо в ask(). Всё, что для этого нужно, - id
   * флоу, который у звонящего уже есть, то есть запрос повторяется тривиально.
   *
   * Отказ не роняет ответ: файл собирается из выведенного текста, ровно как при любой другой неудаче
   * модели ниже - и это причина, по которой генератор принимает эти поля необязательными. */
  const budget = await overSpend(sql, who.id, 'skill-md');

  /* Asked for, not required. Every failure below leaves `written` empty and the file is built from the
   * derived text - which is the whole reason the generator takes these as optional. */
  let written = {};
  try {
    if (!budget.ok) throw new Error(spentWhy(budget, 'skill files'));
    const reply = await ask({
      model: process.env.ANTHROPIC_API_KEY ? DEFAULT_MODEL.anthropic : DEFAULT_MODEL.openai,
      system: 'You are writing the frontmatter of an agent skill. '
        + (portable
          ? 'The agent reading it will carry the steps out itself, with its own browser tools, on pages the '
            + 'user is already signed in to. Do not mention MouseFlow — it takes no part in running this. '
          : 'It wraps a tool that carries out one recorded piece of work on somebody’s own computer. ')
        + 'Be concrete and short. Never claim it can do anything beyond the steps you are shown.',
      messages: [{
        role: 'user',
        text: portable
          ? `${briefOf(structure, flow.name)}\n\nIt will be carried out by an agent using its own browser `
            + 'tools, not by MouseFlow'
            + (portably.urls.length
              ? `, at: ${portably.urls.slice(0, 6).join(', ')}`
              : '. No address was recorded — read the addresses off the goal itself, and say so if the '
                + 'goal needs desktop applications rather than web pages.')
          : briefOf(structure, flow.name),
      }],
      tools: [TRIGGER_TOOL],
      maxTokens: 1000,
    });
    const call = (reply.calls || []).find((c) => c.name === TRIGGER_TOOL.name);
    if (call && call.input) written = call.input;
  } catch (err) {
    if (!(err instanceof ProviderError)) await report(err, req, { route: 'skill-md' });
  }

  return res.status(200).json({
    ok: true,
    portable,
    filename: skillFileName(flow.name),
    /* The FOLDER name. An agent skill installs as `<slug>/SKILL.md`, and the slug in the frontmatter and
     * the slug on the directory have to be the same word - so one place decides it, and the client is told
     * rather than deriving it a second time. */
    slug: skillSlug(flow.name),
    /* Said, so the panel can show whether the trigger line was written or derived. A file whose description
     * came out of the fallback is worth knowing about before it is handed to an agent. */
    written: !!written.description,
    text: skillMarkdown(structure, flow, written, {
      portable,
      urls: portably.urls,
      /* Kept apart from `urls` all the way to the page. They are different KINDS of fact - one was seen,
       * one was worked out - and merging them into one list is how the second becomes the first. */
      inferredUrls: portable && !portably.urls.length && Array.isArray(written.webAddresses)
        ? written.webAddresses.slice(0, 3)
        : [],
      /* ABSENCE OF AN ANSWER IS NOT A NEGATIVE ANSWER, and this is the seam where that mattered. The
       * caveat used to be `!!written.desktopOnly` alone - so when the model call failed, `written` stayed
       * empty, the flag came out false, and a recording made on somebody's Dock exported as browser work
       * with no warning at all. Silence read as a claim, exactly when the deployment was least able to
       * make one.
       *
       * So the fallback is computed HERE, from what this side knows: desktop-made, no address ever
       * recorded, and nobody available to judge otherwise. The model can clear the warning by answering;
       * it cannot clear it by being unreachable. */
      desktopOnly: portable && (written.desktopOnly === true
        || (!written.description && !portably.urls.length && flow.source === 'desktop')),
    }),
  });
}

export default wrap(handler, 'skill-md');
