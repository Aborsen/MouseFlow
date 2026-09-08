/* MouseFlow over HTTPS, so the decider can be anywhere and still only ever see one account.
 *
 *   POST /api/mcp                    JSON-RPC 2.0. initialize, ping, tools/list, tools/call
 *   GET  /api/mcp                    a sentence for whoever opened the URL in a browser
 *   POST /api/mcp?worker=claim       a worker on somebody's machine takes the next job  (long-polls)
 *   POST /api/mcp?worker=report      ...and says how it went
 *   GET  /api/mcp?worker=state&id=   ...and asks whether it has been cancelled meanwhile
 *   POST /api/mcp?worker=crash       ...and says when it fell over, so the crash is not only in a log file
 *   POST /api/mcp?worker=step        ...or, with no worker at all, an agent carries out a goal one turn
 *                                    at a time: it sends the screen, this decides, it does the action
 *
 * WHY THIS EXISTS BESIDE mcp/server.mjs. That one runs on the user's machine over stdio, which is why it can
 * run anything: the agent listens on loopback and only something on that machine can reach it. It also means
 * one person, one terminal. This is the same tools reachable from Claude on a phone, in a browser, in
 * somebody else's editor - and reachable is the whole problem, because a serverless function cannot dial into
 * anybody's desktop and nothing on the internet should be able to.
 *
 * So the desktop dials out. A tools/call becomes a row in run_queue; a worker on the user's own machine
 * claims it, runs it through the agent it can already reach, and reports back; this waits and answers with
 * what the worker said. The direction of the connection never reverses. A machine with no worker running
 * claims nothing, and the caller is told exactly that rather than left waiting.
 *
 * IDENTITY IS THE POINT. Every request resolves ONE user through whoIsCalling - a session cookie, or the
 * device token the extension already pairs with - and every query filters on that id inside the WHERE
 * clause. There is no route here that takes a user id, and no code path that reads one from the request
 * body. A model-supplied user id is the whole bug class: one hallucinated uuid and this becomes a way to
 * list, or run, somebody else's skills. So the id arrives once, from the credential, and the credential is
 * the only thing that says who anybody is.
 *
 * That is also the answer to "each person in an organisation sees only themselves": each person adds this
 * with their OWN token, and sees their own skills. The one thing to be careful of is a connector installed
 * once for a whole organisation with a single shared header - everyone on it would share one account, which
 * is not multi-tenancy, it is one tenant with many users. The fix for that is OAuth, so the connector
 * identifies the person rather than the installation; the 401 below already advertises where that will live
 * (RFC 9728), and until it exists this is per-person-token.
 *
 * WHAT IT CANNOT SEE. The local agent. Whether it is running, what version, whether a replay is playing -
 * all of that is loopback and this is not on that machine. `mouseflow_status` reports what the ACCOUNT
 * knows and says plainly which half it cannot see, rather than guessing.
 */

import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { whoIsCalling } from './_session.js';
import { structureOf } from './_skill-schema.mjs';
import { flowBody, parseMacro, summarize } from './_macro.mjs';
import { flowFor } from './_flow-for.mjs';
/* The decision loop, turned inside out so it can live in a row between requests. See api/_step.mjs. */
import { advance, startLoop } from './_step.mjs';
/* Composed in the brain rather than here, so the cloud driver and the browser one hand the model the same
   background in the same words. */
import { EARLIER_RUNS, earlierRuns } from './_brain.mjs';
import { ALLOWED_MODELS } from './_vision.mjs';
import { readSettings } from './admin.js';
/* The one implementation of what a skill's parameters do to its goal. Imported rather than repeated for
 * the same reason flowBody is: two answers to "what is this skill's goal text" is one answer too many. */
import { fillGoal, missingParams } from '../extension/skills.js';
/* Server-side crashes reach Sentry from here. See api/_report.js — no dependency, and it
 * deliberately sends the route and the message, never the query string or the body. */
import { report, reportSaid, wrap } from './_report.js';
import { help } from './_help.mjs';
import {
  FAILS_BEFORE_PAUSE, decide, firstAt, readRule, ruleOf, ruleSaid, whenSaid,
} from './_schedule.mjs';
/* Сводка проверок прогона - тем же счётом, что у браузерного драйвера. См. api/_expect.mjs. */
import { checksOf } from './_expect.mjs';
/* Один потолок на все маршруты, тратящие ключ развёртывания - см. api/_spend.mjs. */
import { overSpend, spentWhy } from './_spend.mjs';
/* Потолок на вес записи - тот же, что у api/sync.js: два писателя одной колонки не могут иметь два. */
import { PAYLOAD_MAX_BYTES } from './_payload.mjs';
/* Один заголовочный набор на все маршруты - см. api/_cors.mjs. Семь копий этих строк разошлись
 * ровно в том месте, где это стоило дороже всего: chats.js отражал ЛЮБОЙ origin и выдавал
 * Allow-Credentials, то есть чужая страница читала разговоры человека его же кукой. */
import { cors } from './_cors.mjs';

const SPOKEN = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const NEWEST = '2025-06-18';
const SERVER = { name: 'mouseflow', version: '0.2.0' };

/* How long a tools/call waits for a machine to do the work before it answers "still going".
 *
 * Was just under two minutes, which is well inside the function's own limit and well OUTSIDE what an MCP
 * client will hold a request open for: the first real call died as "Connection closed" while the job sat
 * happily in the queue, which tells the person nothing and looks exactly like a broken server. Half a minute
 * is under every client's patience, and the answer it gives when the wait runs out - the run id, and which
 * tool asks after it - is a better outcome than a dropped connection in every case. */
const CALL_WAIT_MS = 25_000;
const CALL_POLL_MS = 1_500;
/* And how long a worker's claim request may hold open with nothing to do. One request every half minute
 * beats one every three seconds, and an idle loop is not billed as CPU. */
/* HOW LONG THIS WILL HOLD A CLAIM OPEN, and it is a ceiling set by the function rather than by taste.
 *
 * It was 25 seconds, and both couriers asked for exactly that. A serverless function here has no declared
 * maxDuration - not in vercel.json, not in an export - so it gets the plan default, which is ten seconds on
 * Hobby and fifteen on Pro. Every idle poll was therefore GUARANTEED to be killed in flight, and the agent
 * logged the two ways that shows up, over and over: `HTTP 0` when the connection died before the headers,
 * and `HTTP 200` when it died after them with the body half sent - a reply that says `{ ok: true, job: null }`
 * read as a failure to reach the account.
 *
 * Six leaves room for the work either side of the wait: the stale-claim sweep, the claim attempt itself and
 * the flow read all happen inside the same invocation, and the whole of it has to finish under ten.
 *
 * CAPPED HERE, and that is the point of putting it here rather than only in the agents. An agent is a
 * compiled binary somebody has to reinstall - the note by `claimerIsWorker` makes the same argument - so a
 * number changed only there arrives when every machine has been rebuilt. This clamps whatever is asked for,
 * so an agent already installed and asking for 25 gets a clean answer at 6 on the next deploy.
 *
 * The other way out is declaring a maxDuration above 25, which is a Pro feature and would leave every Hobby
 * deployment of this repository broken in the same way. This works on both. */
const CLAIM_WAIT_MAX_MS = 6_000;
const CLAIM_POLL_MS = 1_000;
/* A job a worker took and never reported. Not returned to the pool - a run that may be half-done must not
 * be repeated blind - so it is failed with a reason. */
const CLAIM_STALE_MS = 45 * 60 * 1000;


/** RFC 6750 / RFC 9728: say it is a bearer resource and where the authorisation server will be found. */
function unauthorized(req, res, why) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'mouse-agent.vercel.app';
  const resource = `https://${host}/api/mcp`;
  res.setHeader('WWW-Authenticate',
    `Bearer realm="MouseFlow", resource_metadata="https://${host}/.well-known/oauth-protected-resource"`
    + (why ? `, error="invalid_token", error_description="${why}"` : ''));
  res.status(401).json({
    error: why || 'missing_token',
    resource,
    hint: 'Add this URL to your client and sign in with your MouseFlow account - the 401 above names where. '
      + 'Or send Authorization: Bearer <device token>, minted in the app under Settings → My account. '
      + 'Either way it is one person: each sees only their own recordings and skills. '
      + `https://${host}/mcp explains all of it.`,
  });
}

const rpc = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const say = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

/* ------------------------------------------------------------------------------- the account */

const STATUS_TOOL = {
  name: 'mouseflow_status',
  description: 'What this MouseFlow account holds and whether a machine is listening for work: the number '
    + 'of skills, whether a worker has been seen recently, and anything queued or running. Ask this first '
    + 'when a skill call says nothing picked it up.',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

const STOP_TOOL = {
  name: 'mouseflow_stop',
  description: 'Cancel MouseFlow work that is queued or running on the user\'s machine. Safe to call when '
    + 'nothing is happening.',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

const RUN_STATUS_TOOL = {
  name: 'mouseflow_run_status',
  description: 'How a run that was still going is getting on. Only needed when a skill call came back '
    + 'saying it had not finished; it names the run id to pass here.',
  inputSchema: {
    type: 'object',
    properties: { run: { type: 'string', description: 'The run id the earlier answer named.' } },
    required: ['run'],
    additionalProperties: false,
  },
};

/* ------------------------------------------------------------------------------- reading the account
 *
 * These need nothing on anybody's machine. A recording, a run and the time they took are rows, and rows are
 * here - so the analysis half of this server works the moment a connector is added, with no worker, no
 * agent, and nothing to keep running. That is worth stating because it is the opposite of the run half,
 * which cannot happen without a machine, and the two arriving through one connector would otherwise look
 * like one capability with an intermittent fault.
 *
 * Metadata and prose, never a payload. There is no tool here that hands over raw events: the transcript is
 * the derivation api/_transcript.js already makes for the panel, which is written to be read.
 */

const RECORDINGS_TOOL = {
  name: 'mouseflow_recordings',
  description: 'What is on this MouseFlow account: recordings, and the skills made from them. Names, sizes, '
    + 'where they happened and when. Start here when the question is "what have I got".',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['all', 'recording', 'skill'],
        default: 'all',
        description: 'A recording is what was captured; a skill is a copy of one meant to be handed over.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
    required: [],
    additionalProperties: false,
  },
};

const TRANSCRIPT_TOOL = {
  name: 'mouseflow_transcript',
  description: 'One recording, step by step, in words: what was clicked, in which application and window, '
    + 'how long each part took, and what the recording cannot answer. Takes an id from mouseflow_recordings.',
  inputSchema: {
    type: 'object',
    properties: {
      recording: { type: 'string', description: 'The id from mouseflow_recordings.' },
      steps: { type: 'integer', minimum: 1, maximum: 400, default: 120, description: 'How many steps to return.' },
    },
    required: ['recording'],
    additionalProperties: false,
  },
};

/* НЕ `mouseflow_runs`, и переименовано именно из-за соседа. Рядом стоит mouseflow_run, который двигает
 * настоящую мышь на чьём-то компьютере и не отменяется снаружи; имена, отличающиеся на одну `s`, - плохая
 * пара для инструмента, который выбирают по имени. Читающий тул теперь называется тем, что он отдаёт.
 *
 * Старое имя всё ещё ПРИНИМАЕТСЯ в tools/call - см. RETIRED ниже: клиент кэширует tools/list с момента
 * подключения, и переименование без синонима означает «no such tool» у всех, кто ещё не переподключался. */
const RUNS_TOOL = {
  name: 'mouseflow_run_history',
  description: 'The history of runs on this account: what was asked for, which model drove it, how it ended '
    + 'and how long it took. The record of what has actually been automated, as opposed to what could be. '
    + 'This only READS - mouseflow_run is the one that runs a skill.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
      outcome: { type: 'string', enum: ['any', 'ok', 'failed', 'stopped'], default: 'any' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
    required: [],
    additionalProperties: false,
  },
};

const ACTIVITY_TOOL = {
  name: 'mouseflow_activity',
  description: 'The account in numbers over a window: how much was recorded and for how long, how many runs '
    + 'and how they ended, and which applications the work happened in. For "where is my time going".',
  inputSchema: {
    type: 'object',
    properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
    required: [],
    additionalProperties: false,
  },
};

/* ------------------------------------------------------------------------------- the timer
 *
 * Recording is the one thing on this list that is not a row: it is the agent watching the machine, so it
 * goes through the queue exactly as a skill run does, and needs the same thing listening. The two tools are
 * separate rather than one with a boolean, because "stop" is the one somebody reaches for in a hurry and a
 * tool that could start a recording when they meant to stop one is a bad trade for one fewer entry. */

const START_TOOL = {
  name: 'mouseflow_start_recording',
  description: 'Start recording on the machine this account is paired with — the timer the app shows. It '
    + 'captures clicks, drags, scrolls and pointer movement, and THAT a key was pressed, never which key. '
    + 'Nothing is captured until this is called and it stops the moment recording stops.',
  inputSchema: {
    type: 'object',
    properties: {
      moveMs: {
        type: 'integer', minimum: 0, maximum: 1000, default: 0,
        description: 'How coarsely to sample pointer movement, in milliseconds. 0 keeps every sample; 40 is '
          + 'plenty for a long session and keeps it small.',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

const STOP_RECORDING_TOOL = {
  name: 'mouseflow_stop_recording',
  description: 'Stop the recording running on the paired machine and save it to this account. Answers with '
    + 'what was captured.',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

/* ОДНО ПРЕДЛОЖЕНИЕ ВМЕСТО ID НАВЫКА, и до сих пор такого не было НИ НА ОДНОЙ поверхности.
 *
 * Десять инструментов, и все про то, что уже записано: mouseflow_run берёт `skill`. Сказать «открой почту
 * и найди письмо от Ани» через MCP было нечем - цель попадала в очередь только как СОХРАНЁННЫЙ созданный
 * навык, то есть сначала её надо было где-то создать руками.
 *
 * ПОКА ТОЛЬКО БРАУЗЕР, и это не оговорка мелким шрифтом. Модель в цикле есть у расширения (runGoal в
 * extension/agent.js) - оно само решает один шаг за раз и само смотрит на страницу. У десктопного агента
 * своей модели нет вовсе: он ходит по шагам через ?worker=step, и чтобы дать ему свободную цель, менять
 * надо скомпилированный бинарник на чужой машине. Это отдельная работа, а не строчка здесь.
 *
 * Отдельным `#goal.browser`, а не общим `#goal`: очередь развозит работу по поверхностям, и команда,
 * которую может выполнить только одна из них, обязана это о себе говорить - иначе её заберёт тот, кто
 * ответит «не понимаю», и ход будет потрачен. */
const DO_TOOL = {
  name: 'mouseflow_do',
  description: 'Have the MouseFlow browser extension carry out something described in plain language, in '
    + "the user's own Chrome, with their sessions already signed in. Use this when there is no saved skill "
    + 'for what is wanted. It looks at the page and decides one action at a time, so say what should be '
    + 'true at the end rather than which buttons to press. This acts on a real logged-in browser and the '
    + 'actions cannot be undone from here: an errand that sends, buys or deletes should be the one the user '
    + 'actually asked for. It needs "Let my AI run skills in this browser" switched on in the panel. For a '
    + 'DESKTOP errand there is no equivalent yet - the desktop agent carries no model of its own - so use '
    + 'mouseflow_run with a saved skill there.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'What should be done, in a sentence or two, as the user would say it. Name the things '
          + 'that matter - which account, which item, which recipient - because the run has only this.',
      },
    },
    required: ['goal'],
    additionalProperties: false,
  },
};

/* ------------------------------------------------------------------------------- the documentation
 *
 * THE FIRST QUESTION ANYBODY ASKS is not "run my skill", it is "what is this and what does it record". An
 * assistant with the tools above and no documentation answers that one anyway, out of the tool names and
 * whatever it read in training, and gets the load-bearing parts wrong: that keystroke CONTENT is never
 * captured, that a recorded skill and a goal skill fail in different ways, that only one half can replay a
 * browser skill. Those are the answers that turn into a support ticket or a privacy complaint.
 *
 * It reads the site's own pages - see api/_help.mjs for why it is fetched rather than copied in here. */
const HELP_TOOL = {
  name: 'mouseflow_help',
  description: 'The MouseFlow documentation itself, fetched from mouse-flow.vercel.app/docs. Use it to answer any '
    + 'question about how MouseFlow works - what the recorder captures and what it never captures, skills '
    + 'and how they differ, the agent, the extension, teams, privacy, limits - INSTEAD of answering from '
    + 'memory. Ask a question to get the sections that answer it, name a page to read it whole, or call it '
    + 'with nothing to see the list of pages.',
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'What the person wants to know, in their own words. Keep their nouns - the words the '
          + 'documentation uses are the ones that find it.',
      },
      page: {
        type: 'string',
        description: 'A page id from an earlier answer (for example "record-a-flow" or "privacy-and-data") '
          + 'to read that page whole.',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

/* ------------------------------------------------------------------------------- расписания как тулы
 *
 * «Юзер говорит, что сделать, и когда» - это буквально разговор, поэтому расписание обязано ставиться
 * голосом, а не только галочкой на экране. Три тула, а не один с полем `action`: инструмент выбирают по
 * имени, и «schedule» с action:'delete' - это способ удалить расписание, думая, что создаёшь его.
 *
 * ВРЕМЯ ГОВОРИТСЯ СЛОВАМИ, А НЕ CRON-СТРОКОЙ: `every: "1h"`, `at: "09:00"`, `days: "weekdays"`,
 * `once: "2026-09-03T09:00:00Z"`. Модели проще сказать «каждый час», чем `0 * * * *`, а человеку - проверить.
 *
 * ЗОНА ОБЯЗАТЕЛЬНА У ВРЕМЕНИ СУТОК, и это не придирка: у сервера нет часового пояса, у аккаунта тоже, и
 * «09:00» без зоны молча значит девять утра по UTC - для того, кто просил, середина ночи. Модель знает, где
 * человек, чаще, чем сервер: она видела это в разговоре. Поэтому тул её СПРАШИВАЕТ, а `readRule` отказывает,
 * если зона незнакомая, вместо того чтобы посчитать по UTC.
 */
const SCHEDULE_TOOL = {
  name: 'mouseflow_schedule',
  description: 'Have a skill run by itself, later or repeatedly: "run this every hour", "every weekday at '
    + '09:00", "once tomorrow at 8". Say the time in words - every: "30m"/"1h"/"1d", or at: "09:00" with '
    + 'days: "all"/"weekdays", or once: an ISO instant - and pass the person\'s IANA time zone with `at`, '
    + 'because 09:00 with no zone means 09:00 UTC. A scheduled run only happens while their machine is '
    + 'awake and taking work; missed times are recorded, never run hours late.',
  inputSchema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The skill id from mouseflow_recordings. Its exact name works when only one has it.',
      },
      arguments: {
        type: 'object',
        additionalProperties: true,
        description: 'What the skill asks for, by the input names mouseflow_recordings listed.',
      },
      every: { type: 'string', description: 'Interval: "30m", "1h", "6h", "1d". Minimum 15 minutes.' },
      at: { type: 'string', description: 'Time of day, "09:00" or "17:30". Needs `zone`.' },
      days: { type: 'string', enum: ['all', 'weekdays'], description: 'Which days `at` applies to.' },
      once: { type: 'string', description: 'A single ISO instant, e.g. "2026-09-03T09:00:00Z".' },
      zone: {
        type: 'string',
        description: 'IANA time zone of the person asking, e.g. "Europe/Kiev". Required with `at`.',
      },
      label: { type: 'string', description: 'What to call this schedule, if the skill has more than one.' },
    },
    required: ['skill'],
    additionalProperties: false,
  },
};

const SCHEDULES_TOOL = {
  name: 'mouseflow_schedules',
  description: 'The schedules on this account: what runs, when it next runs, and what happened last time - '
    + 'including "missed, nothing was listening". Use it before adding another, and to answer "what is set '
    + 'to run by itself?".',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

const UNSCHEDULE_TOOL = {
  name: 'mouseflow_unschedule',
  description: 'Stop a schedule: pause it or remove it. Ask mouseflow_schedules for the ids. Pausing keeps '
    + 'it for later; removing forgets it. The skill itself is untouched either way.',
  inputSchema: {
    type: 'object',
    properties: {
      schedule: { type: 'string', description: 'The schedule id from mouseflow_schedules.' },
      pause: {
        type: 'boolean',
        description: 'True pauses it, false resumes it. Omit to remove it entirely.',
      },
    },
    required: ['schedule'],
    additionalProperties: false,
  },
};

const scheduleId = () => `sch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/* Строка расписания словами - один формат для перечня и для подтверждения, чтобы человек читал то же, что
 * прочитала модель. */
const scheduleSaid = (row) => {
  const rule = ruleOf(row);
  const bits = [
    `${row.id}  ${row.label || row.tool_name || row.flow_id}`,
    `  ${ruleSaid(rule)}`,
    `  next: ${row.paused ? `paused - ${row.paused_why || 'by hand'}` : whenSaid(
      row.next_at ? new Date(row.next_at).getTime() : null, rule.zone)}`,
  ];
  if (row.last_at) {
    bits.push(`  last: ${new Date(row.last_at).toISOString()} - ${row.last_said || 'no note'}`);
  }
  if (row.runs || row.misses) bits.push(`  ${row.runs} run(s), ${row.misses} missed`);
  return bits.join('\n');
};

const BROWSER_GOAL = '#goal.browser';

/* A queue job that is an instruction to the agent rather than a skill. Marked by the flow id, so the claim
 * path can tell at a glance that there is no flow to look up. */
const AGENT_JOBS = {
  [START_TOOL.name]: '#record.start',
  [STOP_RECORDING_TOOL.name]: '#record.stop',
};

/* ИМЯ, КОТОРОЕ БОЛЬШЕ НЕ ПРЕДЛАГАЕТСЯ, но ещё принимается. Список инструментов клиент забирает один раз
 * при подключении и держит до следующего: в момент переименования у всех, кто уже подключён, в кэше стоит
 * старое имя, и вызов по нему обязан сработать, а не вернуть «нет такого инструмента». В tools/list его
 * нет - синоним не должен выглядеть как второй инструмент. Убрать можно тогда, когда не жаль сломать
 * сохранённый где-то промпт с этим словом. */
const RETIRED_RUNS = 'mouseflow_runs';

const READ_TOOLS = [RECORDINGS_TOOL, TRANSCRIPT_TOOL, RUNS_TOOL, ACTIVITY_TOOL];

/** The caller's skills, stamped ones only, with their derived tool definitions. */
async function skillsOf(sql, userId) {
  const rows = await sql`
    select client_id, source, kind, name, description, payload, origins
    from user_flow
    where user_id = ${userId} and deleted_at is null
    order by updated_at desc
  `;
  const skills = [];
  let unstamped = 0;
  for (const row of rows) {
    const role = row.payload && typeof row.payload.role === 'string' ? row.payload.role : null;
    if (role === 'recording') continue;
    /* Stamped skills only, and deliberately stricter than the Skills page, which lists an unstamped row AS
     * a skill so that nothing anybody made before the stamp existed vanishes from their library. That
     * default is right for a page somebody reads and wrong for a tool list, which is read by something that
     * will CALL what is in it. The count is reported by mouseflow_status, so what is left out is visible. */
    if (role !== 'skill') { unstamped++; continue; }
    skills.push({
      id: row.client_id,
      source: row.source,
      kind: row.kind,
      name: row.name,
      description: row.description,
      payload: row.payload,
      origins: row.origins,
    });
  }
  return { skills, unstamped };
}

/** Tool name -> skill. Names are near-unique by construction; a collision is still handled. */
/* ONE tool for running a skill, instead of one tool per skill.
 *
 * A tool per skill is the shape that lets a model call a skill in a single step with its arguments checked
 * by a schema, and it was the right first answer. What it costs is paid in EVERY request, forever: measured
 * on this project's own account, a skill's definition is about 184 tokens, so fifty skills is roughly 9,200
 * tokens of tool definitions in front of every message - and a permission list of fifty entries named after
 * the date each recording was made.
 *
 * So the list stays constant and the skills move into a RESULT. `mouseflow_recordings` names them and their
 * inputs; this runs one. The names being unreadable stops mattering, because nobody reads a tool list to
 * find them any more.
 *
 * WHAT IS GIVEN UP, and it is not nothing: `arguments` is a free object, so a model can no longer be forced
 * by the schema to supply a required input. That guarantee moves one turn later - missingParams() already
 * refuses and names what is missing - so it holds, it just costs a round trip. A guarantee enforced by a
 * refusal is weaker than one enforced by a type, and this is the trade being made on purpose.
 */
const RUN_TOOL = {
  name: 'mouseflow_run',
  description: 'Run one skill on the machine this account is paired with. Ask mouseflow_recordings for the '
    + 'skills and the inputs each one takes. This drives a real mouse and keyboard on somebody\'s computer: '
    + 'the actions cannot be undone from here, and a missing input should be asked for rather than guessed.',
  inputSchema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The skill\'s id from mouseflow_recordings. Its exact name also works when only one '
          + 'skill has it.',
      },
      arguments: {
        type: 'object',
        description: 'What the skill asks for, by the input names mouseflow_recordings listed. Omit for a '
          + 'skill that asks for nothing.',
        additionalProperties: true,
      },
    },
    required: ['skill'],
    additionalProperties: false,
  },
};

function tableOf(skills) {
  const table = new Map();
  for (const flow of skills) {
    const structure = structureOf(flow);
    let name = structure.toolName;
    if (table.has(name)) {
      let n = 2;
      while (table.has(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
    }
    table.set(name, { flow, structure });
  }
  return table;
}

/* ------------------------------------------------------------------------------- the queue */

/* Said in three different failures, so it is written once: an instruction that drifts between messages is
 * an instruction somebody follows to two different places. */
const WHERE = 'open MouseFlow, click your avatar at the bottom of the sidebar, then Connections, then '
  + '"Let Claude drive this computer"';

const jobId = () => `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Whether a machine has asked for work lately, and when. */
async function workerSeen(sql, userId) {
  try {
    const rows = await sql`
      select value from user_pref where user_id = ${userId} and key = 'worker.seen'
    `;
    if (!rows.length) return null;
    const at = new Date(rows[0].value);
    return Number.isFinite(at.getTime()) ? at : null;
  } catch (_) {
    /* No table on this deployment yet. Absent is not false: it means nothing is known, and the caller is
     * told that rather than told there is no worker. */
    return undefined;
  }
}

async function stampWorker(sql, userId, key = 'worker.seen') {
  try {
    await sql`
      insert into user_pref (user_id, key, value) values (${userId}, ${key}, ${new Date().toISOString()})
      on conflict (user_id, key) do update set value = excluded.value, updated_at = now()
    `;
  } catch (_) { /* the stamp is a convenience, never a precondition */ }
}

/* How recently a step-capable agent has to have asked for work to count as listening.
 *
 * Longer than the claim's own long poll (25s), so an agent that is polling normally is always inside it,
 * and short enough that a machine whose agent has gone away starts using its worker again within a minute
 * and a half rather than never. */
const AGENT_LISTENING_MS = 90_000;

async function agentIsListening(sql, userId) {
  try {
    const rows = await sql`
      select value from user_pref where user_id = ${userId} and key = 'agent.steps.seen'
    `;
    if (!rows.length) return false;
    return Date.now() - new Date(rows[0].value).getTime() < AGENT_LISTENING_MS;
  } catch (_) {
    /* Unknown means "no", which leaves the worker able to take goals - the behaviour that existed before
     * any of this. A precedence rule must not be the thing that stops work happening. */
    return false;
  }
}

/* ------------------------------------------------------------------------------- расписания
 *
 * ЧАСАМИ СЛУЖИТ ОПРОС АГЕНТА, и это главное решение всей функции. Прогон двигает настоящую мышь на чьей-то
 * машине, значит он может случиться только пока эта машина не спит и берёт работу. Крон в облаке, который
 * срабатывает в 03:00, срабатывает в пустоту - а курьер агента спрашивает этот аккаунт каждые три секунды и
 * самим фактом вопроса сообщает, что машина жива. Поэтому «что пора» проверяется здесь, по пути, и второго
 * планировщика, который может сломаться отдельно, в системе нет.
 *
 * ЧТО ЭТО СТАВИТ В ОЧЕРЕДЬ: обычную строку run_queue. Дальше прогон неотличим от того, который попросили
 * руками, - тот же claim, тот же отчёт, та же история, те же потолки расхода. Ни одной ветки «а это по
 * расписанию» нигде ниже.
 */
async function dueNow(sql, who) {
  let rows;
  try {
    rows = await sql`
      select id, flow_id, tool_name, args, label, kind, every_minutes, at_minutes, days, zone,
             next_at, fails
      from user_schedule
      where user_id = ${who.id} and deleted_at is null and paused = false
        and next_at is not null and next_at <= now()
      order by next_at limit 8
    `;
  } catch (_) {
    /* Таблицы может не быть - миграция не применена на этом деплое. Расписания тогда просто не работают, и
     * это НЕ повод отказать агенту в работе, которую он пришёл забрать: claim обслуживает ручные запуски и
     * без них. Молча, потому что сказать здесь некому - это ответ машине, а не человеку. */
    return;
  }
  if (!rows.length) return;

  /* Занято - это состояние аккаунта, а не расписания: одна мышь на все расписания и на ручной запуск тоже.
   * Спрашивается один раз на такт. */
  const busyRows = await sql`
    select id from run_queue where user_id = ${who.id} and state in ('queued', 'claimed') limit 1
  `;
  let busy = busyRows.length > 0;

  const nowMs = Date.now();
  for (const row of rows) {
    const rule = ruleOf(row);
    const dueMs = new Date(row.next_at).getTime();
    const verdict = decide({ rule, dueMs, nowMs, busy });

    if (verdict.do === 'run') {
      /* Скилл, на который расписание показывает, мог быть удалён. Ставить строку, которая гарантированно
       * провалится, и делать это каждый час - это шум и расход; расписание останавливается и говорит, что
       * стало с целью. Команды на '#' проверять не надо - у них нет строки. */
      if (!String(row.flow_id).startsWith('#')) {
        const alive = await sql`
          select 1 from user_flow
          where user_id = ${who.id} and client_id = ${row.flow_id} and deleted_at is null limit 1
        `;
        if (!alive.length) {
          await sql`
            update user_schedule set paused = true,
                   paused_why = 'the skill it runs was deleted',
                   last_at = now(), last_said = 'the skill it runs no longer exists',
                   updated_at = now()
            where id = ${row.id}
          `;
          continue;
        }
      }
      const id = jobId();
      await sql`
        insert into run_queue (id, user_id, flow_id, tool_name, args, schedule_id)
        values (${id}, ${who.id}, ${row.flow_id}, ${row.tool_name},
                ${JSON.stringify(row.args || {})}, ${row.id})
      `;
      await sql`
        update user_schedule
        set next_at = ${verdict.nextAt ? new Date(verdict.nextAt).toISOString() : null},
            paused = ${verdict.nextAt === null},
            paused_why = ${verdict.nextAt === null ? 'it was a one-off, and it has run' : null},
            last_at = now(), last_said = ${`queued - ${verdict.why}`},
            runs = runs + 1, fails = 0, updated_at = now()
        where id = ${row.id}
      `;
      /* Одна мышь: остальные подошедшие расписания на этом такте уступают, а не выстраиваются в очередь. */
      busy = true;
      continue;
    }

    /* Пропущено или уступлено - записывается ТАМ, ГДЕ ЧЕЛОВЕК УВИДИТ. Ни то, ни другое не становится
     * прогоном, поэтому в истории прогонов их нет, и расписание, которое молча ничего не делает, было бы
     * ровно тем провалом, с которым эта функция иначе уехала бы в продукт. */
    await sql`
      update user_schedule
      set next_at = ${verdict.nextAt ? new Date(verdict.nextAt).toISOString() : null},
          paused = ${verdict.pause ? true : false},
          paused_why = ${verdict.pause || null},
          last_at = now(), last_said = ${verdict.why},
          misses = misses + ${verdict.do === 'miss' ? 1 : 0}, updated_at = now()
      where id = ${row.id}
    `;
  }
}

/* ------------------------------------------------------------------------------- the tools */

/* ------------------------------------------------------------------------------- the read tools */

const ago = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : 'unknown');

async function readRecordings(sql, who, args) {
  const want = ['recording', 'skill'].includes(args.kind) ? args.kind : 'all';
  const limit = Math.min(200, Math.max(1, Math.round(Number(args.limit) || 50)));
  const rows = await sql`
    select client_id, name, description, source, kind, origins, updated_at, payload,
           payload->>'role' as role,
           jsonb_array_length(coalesce(payload->'events', '[]'::jsonb)) as events
    from user_flow
    where user_id = ${who.id} and deleted_at is null
    order by updated_at desc limit ${limit}
  `;
  const kindOf = (r) => (r.role === 'skill' ? 'skill' : r.role === 'recording' ? 'recording' : 'unmarked');
  const shown = rows.filter((r) => want === 'all' || kindOf(r) === want);
  if (!shown.length) return say(want === 'all' ? 'Nothing on this account yet.' : `No ${want}s on this account.`);

  const lines = shown.map((r) => {
    const where = Array.isArray(r.origins) && r.origins.length ? ` in ${r.origins.slice(0, 3).join(', ')}` : '';
    /* THE INPUTS, for a skill. Without them this listing names things a caller cannot use: skills are run
     * through mouseflow_run now, whose `arguments` is a free object, so the only way to learn what a skill
     * asks for is to be told here. It used to be in the per-skill tool's schema; that tool is gone. */
    const asks = kindOf(r) === 'skill'
      ? (structureOf(r).params || [])
        .map((p) => `${p.name} (${p.type}${p.example ? '' : ', required'})`)
      : [];
    return `${r.client_id}  ${r.name || 'untitled'}\n`
      + `    ${kindOf(r)} · ${r.source || 'unknown'} · ${r.events} events${where} · ${day(r.updated_at)}`
      + (asks.length ? `\n    takes: ${asks.join(', ')}` : '')
      + (r.description ? `\n    ${r.description}` : '');
  });
  return say(`${shown.length} of ${rows.length} shown, newest first.\n\n${lines.join('\n')}`);
}

async function readTranscript(sql, who, args) {
  const id = String(args.recording || '');
  if (!id) return say('Which recording? Pass an id from mouseflow_recordings.', true);
  const [row] = await sql`
    select client_id, name, kind, source, payload, origins
    from user_flow where user_id = ${who.id} and client_id = ${id} and deleted_at is null
  `;
  if (!row) return say(`There is nothing called "${id}" on this account.`, true);

  /* Lazily, for the reason api/chat.js states about the same module: a static import of a file that may not
   * be on a given deploy takes the importing route down with it, and one missing file must not stop the
   * tools that have nothing to do with transcripts. */
  let transcribe;
  try {
    ({ transcribe } = await import('./_transcript.js'));
  } catch (err) {
    return say(`The transcript engine could not be loaded on this deployment: ${err.message}`, true);
  }

  const t = transcribe(row);
  const cap = Math.min(400, Math.max(1, Math.round(Number(args.steps) || 120)));
  const out = [];
  out.push(`${t.flow?.name || row.name} — ${t.summary?.events ?? 0} events, `
    + `${t.summary?.clicks ?? 0} clicks, ${t.summary?.seconds ?? 0}s, `
    + `${t.summary?.applications ?? 0} applications.`);

  let shown = 0;
  let dropped = 0;
  for (const seg of t.segments || []) {
    const where = seg.where && seg.where.label ? seg.where.label : 'somewhere';
    out.push(`\n— ${where}`);
    for (const step of seg.steps || []) {
      if (shown >= cap) { dropped++; continue; }
      shown++;
      out.push(`  ${step.n}. ${step.what}${step.control ? ` [${step.control}]` : ''}`);
    }
  }
  /* Silent truncation reads as "that is all of it". */
  if (dropped) out.push(`\n${dropped} further steps not shown — ask for more with a bigger \`steps\`.`);

  if ((t.gaps || []).length) {
    out.push('\nWhat this recording cannot answer:');
    for (const gap of t.gaps) out.push(`  · ${gap.question} — ${gap.why}`);
  }
  return say(out.join('\n'));
}

async function readRuns(sql, who, args) {
  const days = Math.min(365, Math.max(1, Math.round(Number(args.days) || 30)));
  const limit = Math.min(200, Math.max(1, Math.round(Number(args.limit) || 50)));
  const wanted = ['ok', 'failed', 'stopped'].includes(args.outcome) ? args.outcome : null;
  const rows = await sql`
    select client_id, kind, goal, model, flow_id, outcome, summary, error, started_at, finished_at
    from user_run
    where user_id = ${who.id} and started_at >= ${ago(days)}
      and (${wanted}::text is null or outcome = ${wanted})
    order by started_at desc limit ${limit}
  `;
  if (!rows.length) return say(`No runs in the last ${days} days${wanted ? ` that ended "${wanted}"` : ''}.`);

  const lines = rows.map((r) => {
    const took = r.started_at && r.finished_at
      ? `${Math.max(0, Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000))}s`
      : 'unknown';
    return `${day(r.started_at)}  ${r.outcome.padEnd(7)} ${took.padStart(6)}  ${r.kind}`
      + `${r.model ? ` · ${r.model}` : ''}\n    ${(r.goal || '(no goal recorded)').slice(0, 160)}`
      + (r.error ? `\n    failed: ${String(r.error).slice(0, 200)}` : '');
  });
  return say(`${rows.length} runs in the last ${days} days, newest first.\n\n${lines.join('\n')}`);
}

async function readActivity(sql, who, args) {
  const days = Math.min(365, Math.max(1, Math.round(Number(args.days) || 30)));
  const since = ago(days);
  const [made] = await sql`
    select count(*) filter (where payload->>'role' is distinct from 'skill')::int as recordings,
           count(*) filter (where payload->>'role' = 'skill')::int as skills,
           coalesce(sum(jsonb_array_length(coalesce(payload->'events', '[]'::jsonb))), 0)::int as events
    from user_flow where user_id = ${who.id} and deleted_at is null and updated_at >= ${since}
  `;
  const outcomes = await sql`
    select outcome, count(*)::int as n,
           coalesce(sum(extract(epoch from (finished_at - started_at))), 0)::int as seconds
    from user_run where user_id = ${who.id} and started_at >= ${since}
    group by outcome order by n desc
  `;
  const apps = await sql`
    select lower(o) as app, count(*)::int as n
    from user_flow, unnest(coalesce(origins, array[]::text[])) as o
    where user_id = ${who.id} and deleted_at is null and updated_at >= ${since}
    group by lower(o) order by n desc limit 8
  `;

  const runs = outcomes.reduce((n, r) => n + r.n, 0);
  const ok = outcomes.find((r) => r.outcome === 'ok');
  const seconds = outcomes.reduce((n, r) => n + r.seconds, 0);
  const lines = [
    `Last ${days} days.`,
    `Recorded: ${made.recordings} recording${made.recordings === 1 ? '' : 's'} and ${made.skills} `
      + `skill${made.skills === 1 ? '' : 's'}, ${made.events} events between them.`,
    runs
      ? `Runs: ${runs}, of which ${ok ? ok.n : 0} finished ok`
        + ` (${outcomes.map((r) => `${r.outcome} ${r.n}`).join(', ')}), `
        + `${Math.round(seconds / 60)} minutes of running time.`
      : 'Runs: none.',
    apps.length ? `Where the work was: ${apps.map((a) => `${a.app} (${a.n})`).join(', ')}.` : '',
    /* Named rather than left to be inferred from a small number: this counts what the account HOLDS, and a
     * recording deleted last week is not in it. */
    'Counted from what the account holds now — anything deleted since is not in these numbers.',
  ].filter(Boolean);
  return say(lines.join('\n'));
}

/* ------------------------------------------------------------------------------- the tools */

async function callTool(sql, who, params, req) {
  const asked = params && params.name;
  const args = (params && params.arguments) || {};

  if (asked === RECORDINGS_TOOL.name) return readRecordings(sql, who, args);
  if (asked === TRANSCRIPT_TOOL.name) return readTranscript(sql, who, args);
  if (asked === RUNS_TOOL.name || asked === RETIRED_RUNS) return readRuns(sql, who, args);
  if (asked === ACTIVITY_TOOL.name) return readActivity(sql, who, args);

  /* No account, no database and no machine: the documentation is public, and a question about how the
   * product works should be answerable while a person is still deciding whether to attach a computer. */
  if (asked === HELP_TOOL.name) {
    return say(await help({ question: String(args.question || ''), page: String(args.page || '') }));
  }

  /* ------------------------------------------------------------------ расписания */

  if (asked === SCHEDULES_TOOL.name) {
    const rows = await sql`
      select id, flow_id, tool_name, label, kind, every_minutes, at_minutes, days, zone,
             next_at, paused, paused_why, last_at, last_said, runs, misses
      from user_schedule
      where user_id = ${who.id} and deleted_at is null
      order by paused, next_at nulls last
    `;
    if (!rows.length) {
      return say('Nothing is scheduled on this account. mouseflow_schedule sets one up - a skill plus when.');
    }
    /* Условие исполнения названо ЗДЕСЬ, а не только в описании тула: перечень расписаний - это то место,
     * где человек спрашивает «почему не сработало», и ответ должен стоять рядом с ответом. */
    return say(`${rows.length} schedule${rows.length === 1 ? '' : 's'}:\n\n`
      + rows.map(scheduleSaid).join('\n\n')
      + '\n\nA scheduled run happens only while that machine is awake and taking work; a time missed '
      + 'because nothing was listening is recorded as missed rather than run late.');
  }

  if (asked === SCHEDULE_TOOL.name) {
    const wanted = String((args && args.skill) || '').trim();
    if (!wanted) return say('Which skill? Pass the id from mouseflow_recordings as `skill`.', true);

    /* Правило разбирается ДО поиска скилла: «каждые пять минут» отвергается одинаково, существует скилл или
     * нет, и человеку не приходится сначала узнавать про опечатку в имени, а потом про интервал. */
    const read = readRule(args);
    if (read.why) return say(read.why, true);
    const rule = read.rule;
    if (rule.kind === 'daily' && !args.zone) {
      return say('`at` needs `zone` - an IANA name like "Europe/Kiev". Without it "09:00" means 09:00 UTC, '
        + 'which is the middle of the night for most of the people who ask for nine in the morning.', true);
    }

    const { skills } = await skillsOf(sql, who.id);
    let entry = skills.find((f) => f.id === wanted) || null;
    if (!entry) {
      const named = skills.filter((f) => String(f.name || '').trim() === wanted);
      if (named.length > 1) {
        return say(`${named.length} skills are called "${wanted}". Pass one of these ids instead: `
          + `${named.map((f) => f.id).join(', ')}.`, true);
      }
      if (named.length === 1) entry = named[0];
    }
    if (!entry) {
      return say(`There is no skill "${wanted}" on this account. Ask mouseflow_recordings for what there is.`,
        true);
    }

    const at = firstAt(rule, Date.now());
    if (at == null || at < Date.now() - 60_000) {
      return say(`That time has already passed (${new Date(at ?? Date.now()).toISOString()}). Pass a moment `
        + 'in the future, or use `every`/`at` for something that repeats.', true);
    }

    /* Зона запоминается на аккаунте, чтобы облачный прогон мог сказать модели, который час у человека
     * (см. startLoop в api/_step.mjs). Фон: не записалось - расписание всё равно ставится. */
    if (args.zone) {
      await sql`
        insert into user_pref (user_id, key, value) values (${who.id}, 'zone', ${String(args.zone).slice(0, 64)})
        on conflict (user_id, key) do update set value = excluded.value, updated_at = now()
      `.catch(() => {});
    }

    const id = scheduleId();
    try {
      await sql`
        insert into user_schedule (
          id, user_id, flow_id, tool_name, args, label,
          kind, every_minutes, at_minutes, days, zone, next_at
        ) values (
          ${id}, ${who.id}, ${entry.id}, ${RUN_TOOL.name},
          ${JSON.stringify((args && args.arguments) || {})},
          ${String((args && args.label) || entry.name || '').slice(0, 80)},
          ${rule.kind}, ${rule.everyMinutes ?? null}, ${rule.atMinutes ?? null},
          ${rule.days || 'all'}, ${rule.zone}, ${new Date(at).toISOString()}
        )
      `;
    } catch (err) {
      /* Таблицы нет - миграция не применена. Сказать прямо: «не удалось» без причины отправляет человека
       * искать ошибку в своём запросе. */
      return say(`The schedule could not be saved: ${err.message}. If this deployment has not had `
        + 'db/018_user_schedule.sql applied yet, that is the reason.', true);
    }

    /* Условие исполнения - в подтверждении, а не в мелком шрифте: расписание, о котором человек думает, что
     * оно сработает при закрытом ноутбуке, хуже отсутствующего. */
    const listening = await workerSeen(sql, who.id);
    return say(`Scheduled: "${entry.name}" ${ruleSaid(rule)}.\n`
      + `Next run ${whenSaid(at, rule.zone)}. Its id is ${id}.\n\n`
      + (listening === null
        ? 'No computer has ever taken work for this account, so nothing will run this until one does: '
          + `${WHERE}.`
        : 'It runs only while that machine is awake and taking work. A time missed because nothing was '
          + 'listening is recorded as missed rather than run hours late, and three failures in a row pause '
          + 'the schedule.'));
  }

  if (asked === UNSCHEDULE_TOOL.name) {
    const id = String((args && args.schedule) || '').trim();
    if (!id) return say('Which schedule? Pass the id from mouseflow_schedules as `schedule`.', true);
    const rows = await sql`
      select id, label, kind, every_minutes, at_minutes, days, zone, next_at
      from user_schedule where id = ${id} and user_id = ${who.id} and deleted_at is null
    `;
    if (!rows.length) return say(`There is no schedule "${id}" on this account.`, true);
    const row = rows[0];

    if (args.pause === undefined) {
      await sql`update user_schedule set deleted_at = now(), updated_at = now() where id = ${id}`;
      return say(`Removed. "${row.label || id}" will not run by itself again; the skill itself is untouched.`);
    }
    const pausing = args.pause !== false;
    /* Снятие с паузы обязано пересчитать срок: сохранённый next_at за время паузы утёк в прошлое, и без
     * пересчёта расписание сработало бы сразу - или, при большом опоздании, отметилось пропущенным в тот же
     * миг, что и возобновилось. */
    const rule = ruleOf(row);
    const next = pausing ? row.next_at : firstAt(rule, Date.now());
    await sql`
      update user_schedule
      set paused = ${pausing}, paused_why = ${pausing ? 'paused by hand' : null},
          next_at = ${next ? new Date(typeof next === 'number' ? next : next).toISOString() : null},
          updated_at = now()
      where id = ${id}
    `;
    return pausing
      ? say(`Paused. "${row.label || id}" keeps its ${ruleSaid(rule)} and runs nothing until resumed.`)
      : say(`Resumed. Next run ${whenSaid(typeof next === 'number' ? next : null, rule.zone)}.`);
  }

  if (asked === STATUS_TOOL.name) {
    const { skills, unstamped } = await skillsOf(sql, who.id);
    const seen = await workerSeen(sql, who.id);
    const busy = await sql`
      select id, tool_name, state, created_at from run_queue
      where user_id = ${who.id} and state in ('queued', 'claimed')
      order by created_at limit 10
    `;
    const lines = [];
    lines.push(`${skills.length} skill${skills.length === 1 ? '' : 's'} on this account, of which `
      + `${skills.filter((s) => s.source === 'desktop').length} run on a desktop and `
      + `${skills.filter((s) => s.source !== 'desktop').length} in the browser extension.`);
    if (seen === undefined) {
      lines.push('Whether a machine is listening cannot be read on this deployment.');
    } else if (!seen) {
      lines.push('No machine has ever asked this account for work. To let one, ' + WHERE + '. '
        + 'It takes one click and nothing is typed or copied.');
    } else {
      const ago = Math.round((Date.now() - seen.getTime()) / 1000);
      lines.push(ago < 90
        ? `A machine is listening for work (last asked ${ago}s ago).`
        : `No machine has asked for work in ${Math.round(ago / 60)} minutes, so a call would sit in the `
          + 'queue. That computer may be asleep or off, or it may have stopped taking work - the switch is '
          + "in the MouseFlow agent's own menu bar, the cursor icon at the top of the screen.");
    }
    if (busy.length) {
      lines.push(`Queued or running: ${busy.map((b) => `${b.tool_name || b.id} (${b.state})`).join(', ')}.`);
    }
    if (unstamped) {
      lines.push(`${unstamped} row${unstamped === 1 ? '' : 's'} on the account are not marked as either a `
        + 'recording or a skill, and are not offered as tools. Saving them again in the app stamps them.');
    }
    lines.push('What this cannot see: the agent itself. It listens on the machine\'s own loopback, and this '
      + 'is not on that machine.');
    return say(lines.join('\n'));
  }

  if (asked === STOP_TOOL.name) {
    const killed = await sql`
      update run_queue set state = 'cancelled', finished_at = now(),
             ok = false, said = 'cancelled before it finished'
      where user_id = ${who.id} and state in ('queued', 'claimed')
      returning id
    `;
    return say(killed.length
      ? `Cancelled ${killed.length} job${killed.length === 1 ? '' : 's'}. A run already under way stops at `
        + 'the next step the worker checks, which is within a second or two.'
      : 'Nothing was queued or running.');
  }

  if (asked === RUN_STATUS_TOOL.name) {
    const id = String(args.run || '');
    const rows = await sql`
      select state, ok, said, finished_at from run_queue where id = ${id} and user_id = ${who.id}
    `;
    if (!rows.length) return say(`There is no run "${id}" on this account.`, true);
    const job = rows[0];
    if (job.state === 'queued') return say('Still waiting for a machine to pick it up.');
    if (job.state === 'claimed') return say('A machine has it and is working on it.');
    return say(job.said || (job.ok ? 'Done.' : 'It did not finish.'), !job.ok);
  }

  /* The timer, and skills. Both are the same thing from here: something only a machine can do, so it goes
   * on the queue and this waits for the answer. */
  if (asked === DO_TOOL.name) {
    const goal = String((args && args.goal) || '').trim();
    if (!goal) return say('What should it do? Pass the errand as `goal`, in a sentence.', true);
    return queueAndWait(sql, who, {
      flowId: BROWSER_GOAL, toolName: asked, args: { goal: goal.slice(0, 2000) },
    });
  }

  if (AGENT_JOBS[asked]) {
    return queueAndWait(sql, who, { flowId: AGENT_JOBS[asked], toolName: asked, args });
  }

  if (asked !== RUN_TOOL.name) {
    return say(`There is no tool called "${asked}". Ask for the tool list again; skills are run through `
      + `${RUN_TOOL.name} rather than each having a tool of its own.`, true);
  }

  const wanted = String((args && args.skill) || '').trim();
  if (!wanted) return say('Which skill? Pass the id from mouseflow_recordings as `skill`.', true);
  /* The skill's own arguments live one level in, under `arguments`. A separate name rather than reassigning
   * `args`, which is a const and was exactly the mistake here - and one that only shows up when the tool is
   * actually called, since nothing else in this file reads that property. */
  const skillArgs = (args && typeof args.arguments === 'object' && args.arguments) || {};

  const { skills } = await skillsOf(sql, who.id);
  /* By id first, because that is what mouseflow_recordings prints and it cannot be ambiguous. A name is
   * accepted too, since it is what a person says out loud - but only when exactly one skill has it: two
   * skills sharing a name is legal, and picking one of them silently would run the wrong errand. */
  let entry = null;
  /* `.id`, which is what skillsOf() calls it - it renames client_id on the way out. Reading `client_id`
   * here found nothing, ever, and looked exactly like a deleted skill. */
  for (const flow of skills) if (flow.id === wanted) entry = { flow, structure: structureOf(flow) };
  if (!entry) {
    const named = skills.filter((f) => String(f.name || '').trim() === wanted);
    if (named.length > 1) {
      return say(`${named.length} skills are called "${wanted}". Pass one of these ids instead: `
        + `${named.map((f) => f.id).join(', ')}.`, true);
    }
    if (named.length === 1) entry = { flow: named[0], structure: structureOf(named[0]) };
  }
  if (!entry) {
    return say(`There is no skill "${wanted}" on this account. Ask mouseflow_recordings for what there is; `
      + 'it names each skill\'s id and the inputs it takes.', true);
  }
  /* Раньше здесь стоял отказ: «спросите пользователя запустить это в расширении». Он был верен, пока
   * расширение не умело брать работу с аккаунта, - а теперь умеет, и очередь развозит по поверхностям
   * (см. claimerIsBrowser в workerRoute). Отказывать стало нечему: строка встанет в очередь и её заберёт
   * тот Chrome, в котором это включено, а если такого нет - ожидание кончится и об этом скажут прямо,
   * что и есть разница между «никто не подобрал» и «мы не стали и пробовать». */
  /* The tool name on the row stays the SKILL's, not `mouseflow_run` - it is what "MouseFlow is already busy
   * on that machine (…)" names, and "busy on mouseflow_run" would tell nobody which errand is in progress. */
  return queueAndWait(sql, who, {
    flowId: entry.flow.id, toolName: entry.structure.toolName, args: skillArgs,
  });
}

/* Put it on the queue and wait for the machine.
 *
 * One path for a skill and for the timer, because the difference between them is what the worker does with
 * the row, not how it gets there. Waiting rather than returning an id is the point: a tool that comes back
 * before the work happened has told the caller nothing, and the answer says plainly when the wait ran out
 * rather than reporting a success nobody saw. */
async function queueAndWait(sql, who, { flowId, toolName, args }) {
  const seen = await workerSeen(sql, who.id);
  if (seen === null) {
    /* The whole of what somebody has to do, in the answer they are already reading.
     *
     * This used to name a worker and a command. That was true for a week and is the wrong advice now - and a
     * stale instruction in a failure message is worse than none: it sends the person somewhere that does not
     * exist, and they conclude the product is broken rather than that the sentence is. */
    return say('This account has no computer listening, so there is nothing to run this on. To let one: '
      + WHERE + ". It takes one click - nothing to type, nothing to copy - and the agent's own menu bar is "
      + 'where you switch it off again. Nothing was queued.', true);
  }

  const already = await sql`
    select id, tool_name from run_queue where user_id = ${who.id} and state in ('queued', 'claimed') limit 1
  `;
  if (already.length) {
    return say(`MouseFlow is already busy on that machine (${already[0].tool_name || already[0].id}). One `
      + 'thing at a time - there is one mouse. Wait for it, or call mouseflow_stop.', true);
  }

  const id = jobId();
  await sql`
    insert into run_queue (id, user_id, flow_id, tool_name, args)
    values (${id}, ${who.id}, ${flowId}, ${toolName}, ${JSON.stringify(args || {})})
  `;

  const until = Date.now() + CALL_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((done) => setTimeout(done, CALL_POLL_MS));
    const rows = await sql`select state, ok, said from run_queue where id = ${id}`;
    if (!rows.length) break;
    const job = rows[0];
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') {
      return say(job.said || (job.ok ? 'Done.' : 'It did not finish.'), !job.ok);
    }
  }

  const now = await sql`select state from run_queue where id = ${id}`;
  const state = now.length ? now[0].state : 'gone';
  return say(state === 'queued'
    ? `Nothing on the machine picked this up within ${Math.round(CALL_WAIT_MS / 1000)} seconds, and it is `
      + `still queued as ${id}. The MouseFlow worker is probably not running there. Call `
      + `mouseflow_run_status with that id, or mouseflow_stop to take it off the queue.`
    : `It is still running on the machine as ${id}. Call mouseflow_run_status with that id for the outcome.`,
  state === 'queued');
}

/* One stopped recording, as a row.
 *
 * parseMacro and flowFor are the app's own, imported rather than repeated - flowFor's comment says why there
 * is one of them, and this is its fourth caller. The `windows` a replay needs are derived from the events'
 * own `#ctx` instead of from polling the foreground window: more faithful, and available to something that
 * was not watching while the recording ran, which is exactly the case here.
 */
async function saveRecording(sql, who, macro, health) {
  const { events, problems } = parseMacro(macro);
  if (!events.length) {
    return { ok: false, said: 'It stopped, and nothing had been captured. Nothing was saved.' };
  }

  const seen = new Map();
  for (const event of events) {
    const ctx = event && event.context;
    if (!ctx || (!ctx.app && !ctx.window)) continue;
    const key = `${ctx.app || ''}\u0000${ctx.window || ''}`;
    if (!seen.has(key)) seen.set(key, { title: ctx.window || ctx.app || '', process: ctx.app || '' });
  }
  const windows = [...seen.values()].slice(0, 12);

  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const rec = {
    id: `r${Math.random().toString(36).slice(2, 10)}`,
    name: `MouseFlow ${two(now.getDate())}/${two(now.getMonth() + 1)} `
      + `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`,
    created: now.toISOString(),
    events,
    windows,
  };
  const row = flowFor(rec, health);

  /* ТОТ ЖЕ ПОТОЛОК, ЧТО И У ВТОРОГО ПИСАТЕЛЯ. Эта функция пишет в user_flow.payload наравне с
   * api/sync.js, и потолок стоял только там - то есть запись, слишком большую, чтобы синхронизироваться,
   * можно было положить сюда, и она бы легла. Отказ здесь - строка, которую человек прочитает; отсутствие
   * отказа - строка, которую он потом не сможет ни открыть, ни забрать. */
  const encoded = JSON.stringify(row.payload);
  if (encoded.length > PAYLOAD_MAX_BYTES) {
    return {
      ok: false,
      said: `That recording is ${Math.round(encoded.length / 1024)}KB, and the ceiling is `
        + `${Math.round(PAYLOAD_MAX_BYTES / 1024)}KB, so it was not saved. It is still on the machine `
        + 'that recorded it — stop it in shorter stretches, or collect it from the app.',
    };
  }

  await sql`
    insert into user_flow
      (user_id, client_id, source, kind, name, description, payload, origins, created_at, updated_at)
    values
      (${who.id}, ${row.id}, 'desktop', 'recorded', ${row.name}, ${row.description},
       ${encoded}, ${row.origins}, ${row.created}, now())
    on conflict (user_id, client_id) do update set
      name = excluded.name, description = excluded.description, payload = excluded.payload,
      origins = excluded.origins, updated_at = now(), deleted_at = null
  `;

  const s = summarize(events);
  const where = windows.map((w) => w.title).filter(Boolean).slice(0, 3);
  return {
    ok: true,
    said: `Saved as "${rec.name}" (${rec.id}): ${s.count} events, ${s.clicks} `
      + `click${s.clicks === 1 ? '' : 's'}`
      + (where.length ? `, in ${where.join(', ')}` : '') + '.'
      + (problems.length ? ` ${problems.length} lines could not be read and were skipped.` : '')
      + ' Nothing about what was typed is in it, by design.',
  };
}

/* ------------------------------------------------------------------------------- the worker side */

async function workerRoute(action, req, res, sql, who) {
  if (action === 'claim') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
    await stampWorker(sql, who.id);

    /* ЧАСЫ РАСПИСАНИЙ - ЗДЕСЬ. Этот запрос и есть доказательство, что машина жива и берёт работу, так что
     * подошедшее по расписанию ставится в очередь ровно перед тем, как из неё берут. См. dueNow. */
    await dueNow(sql, who);

    /* Anything a worker took and never came back from. Failed rather than requeued: a run that may be
     * half-done must not be repeated blind, and a person can ask for it again knowing what happened. */
    await sql`
      update run_queue set state = 'failed', ok = false, finished_at = now(),
             said = 'the machine took this job and never reported back'
      where user_id = ${who.id} and state = 'claimed'
        and claimed_at < now() - ${`${Math.round(CLAIM_STALE_MS / 1000)} seconds`}::interval
    `;

    const by = String((req.body && req.body.worker) || 'worker').slice(0, 60);
    /* WHAT THIS CLAIMER CAN ACTUALLY DO, which the queue did not ask until it had to.
     *
     * There are two kinds of claimer on one account and they are not interchangeable. An agent's own
     * courier can start a recording, stop one, and replay a body - it has no model in it, so a GOAL skill,
     * whose whole nature is a model deciding one action at a time, is something it can only answer "asked
     * to do something it does not understand" to. The worker has the model path.
     *
     * Both POST here with the same shape, and this took the oldest queued row regardless. While everything
     * queued was a `#record.*` command, which both can do, nothing went wrong; the first goal skill queued
     * on a machine running both went to whichever long-poll landed first, and it was observed doing exactly
     * that - the courier took it and answered "does not understand".
     *
     * THE WORKER DECLARES ITSELF, and which side declares is the whole decision.
     *
     * Having the AGENT declare instead is the version that never refuses an old worker anything, and it was
     * written that way first. It is wrong for one concrete reason: an agent is a COMPILED BINARY installed
     * on somebody's machine, so that fix arrives only when every one of them has been rebuilt and
     * reinstalled. The worker is a checkout of this repository run by node - it updates with `git pull`.
     * Declaring on the side that can actually be updated is what makes the fix land.
     *
     * The cost is real and worth stating: a worker too old to declare itself stops being given goal skills.
     * They queue, and the caller is told nothing picked them up - which is a true sentence somebody can act
     * on, unlike the one this replaced. */
    const claimerIsWorker = String((req.body && req.body.kind) || '') === 'worker';
    /* An agent that can carry a goal one turn at a time (see ?worker=step) may take those jobs as well.
     * It DECLARES it, exactly as the worker does, and for the same reason: the ones that cannot must go on
     * not being given them, and no deploy here can tell an old binary apart from a new one. */
    const claimerSaysSteps = !!(req.body && req.body.steps === true);
    /* ТРЕТИЙ ВИД ЗАБИРАЮЩЕГО, И ОН РАЗДЕЛЯЕТ ОЧЕРЕДЬ НАДВОЕ ПО ПОВЕРХНОСТИ.
     *
     * Браузерное расширение шагает по элементам страницы, десктопный агент - по координатам экрана, и это
     * не два диалекта одного, а две несовместимые вещи: `flowBody` ниже строит пятиколоночное тело из
     * payload.events, а у браузерного навыка в событиях селекторы и никаких x/y. Пока mouseflow_run
     * браузерные навыки ОТКАЗЫВАЛСЯ ставить в очередь, это не могло случиться - отказ и был защитой. Раз
     * он их теперь ставит, защита обязана переехать сюда, в выбор строки.
     *
     * Поэтому условие ровно симметричное: браузерный забирающий берёт ТОЛЬКО навыки не-десктопного
     * источника, а все остальные - только то, что не браузерный навык, включая команды на '#'. Ни один
     * забирающий не может получить работу, для которой у него нет ни рук, ни системы координат. */
    const claimerIsBrowser = String((req.body && req.body.kind) || '') === 'browser';
    /* И ОНО УМЕЕТ ЦЕЛИ, в отличие от агента. Расширение несёт свою модель (runGoal в
     * extension/agent.js): оно смотрит на страницу и решает один шаг за раз само, ничего не спрашивая у
     * этой стороны. Поэтому объявлять `steps` ему не надо - это просто правда о том, что оно такое. */
    const browserDoesGoals = claimerIsBrowser;
    if (claimerIsBrowser) await stampWorker(sql, who.id, 'extension.claim.seen');
    if (claimerSaysSteps && !claimerIsWorker) await stampWorker(sql, who.id, 'agent.steps.seen');

    /* WHEN BOTH ARE LISTENING, THE AGENT WINS - and this is a reversal, so it is worth the paragraph.
     *
     * There is one mouse. A worker and a step-capable agent on the same machine both long-poll here, and
     * whichever asked first used to take the job; on an unlucky pair of polls that is two loops driving one
     * pointer. The plan that started this work said the WORKER should win, on the grounds that it was the
     * proven path. It is not the right answer any more: the worker is the install step this whole change
     * exists to remove, and leaving it in front means the new path never runs on any machine that still has
     * one - which is every machine that could tell us it is broken.
     *
     * So: a worker is not offered a goal while an agent that can do goals is listening. It keeps everything
     * else, and it takes goals again by itself if that agent stops asking. A machine with only a worker is
     * unaffected. */
    const stepperListening = claimerIsWorker ? await agentIsListening(sql, who.id) : false;
    const claimerSteps = claimerIsWorker ? !stepperListening : claimerSaysSteps;
    /* И третий забирающий, отдельной строкой, чтобы правило старшинства между воркером и агентом выше
     * осталось ровно тем, чем было: браузер в нём не участвует - он на своей поверхности один. */
    const goalCapable = claimerSteps || browserDoesGoals;
    const wait = Math.min(CLAIM_WAIT_MAX_MS, Math.max(0, Number((req.body && req.body.wait) || 0) * 1000));
    const until = Date.now() + wait;

    for (;;) {
      /* One statement, so two workers on one account cannot take the same job: the row is selected and
       * claimed in the same update. */
      const took = await sql`
        update run_queue set state = 'claimed', claimed_by = ${by}, claimed_at = now()
        where id = (
          select id from run_queue q
          where q.user_id = ${who.id} and q.state = 'queued'
            /* A command starts with '#' and both kinds can do it; a skill has to be looked at. An agent is
             * handed everything EXCEPT a created skill - and a flow row that has gone missing counts as
             * not-a-goal, so a stale job still gets claimed and fails with a reason rather than sitting in
             * the queue forever waiting for a claimer that will never be allowed to take it. */
            and (
              ${goalCapable}
              or q.flow_id like '#%'
              or not exists (
                select 1 from user_flow f
                where f.user_id = q.user_id and f.client_id = q.flow_id
                  and f.deleted_at is null and f.kind = 'created'
              )
            )
            /* Поверхность. См. claimerIsBrowser выше: браузерному - только браузерное, всем остальным -
             * всё, кроме браузерного. */
            and (
              case when ${claimerIsBrowser}
                then q.flow_id = ${BROWSER_GOAL} or exists (
                  select 1 from user_flow f
                  where f.user_id = q.user_id and f.client_id = q.flow_id
                    and f.deleted_at is null and f.source <> 'desktop'
                )
                else q.flow_id <> ${BROWSER_GOAL} and not exists (
                  select 1 from user_flow f
                  where f.user_id = q.user_id and f.client_id = q.flow_id
                    and f.deleted_at is null and f.source <> 'desktop'
                )
              end
            )
          order by q.created_at limit 1
        )
        returning id, flow_id, tool_name, args
      `;
      if (took.length) {
        const job = took[0];
        /* An agent job carries an instruction, not a skill, so there is nothing to look up. Marked by the
         * flow id rather than by a column, because it is the flow id that is absent. */
        if (String(job.flow_id || '').startsWith('#')) {
          return res.status(200).json({
            ok: true,
            job: { id: job.id, toolName: job.tool_name, args: job.args || {}, command: job.flow_id, flow: null },
          });
        }
        const flow = await sql`
          select client_id, source, kind, name, description, payload, origins
          from user_flow where user_id = ${who.id} and client_id = ${job.flow_id} and deleted_at is null
        `;
        if (!flow.length) {
          await sql`
            update run_queue set state = 'failed', ok = false, finished_at = now(),
                   said = 'the skill was deleted between the ask and the run'
            where id = ${job.id}
          `;
          continue;
        }
        const row = flow[0];
        const payload = row.payload || {};
        const args = job.args || {};

        /* A replay body, built HERE.
         *
         * The claimer used to be a Node process that could import flowBody; now it can be the agent, which
         * is a small program that speaks the five-column format and knows nothing about skills, payloads or
         * parameters. Building it here is what lets that be true - and it is the same builder the Record
         * page uses, so a replay asked for by a chat and one asked for by the button are the same document.
         *
         * Only for a RECORDED skill: a created one is a goal, and a goal needs a model in the loop, which is
         * not something the agent has. The worker still handles those, and says so when it cannot. */
        let body = null;
        let activate = null;
        /* Браузерному забирающему тело не строится вовсе: он получает payload навыка как есть и знает, что
         * с ним делать - это его собственный формат. Строить ему пятиколоночное тело было бы переводом
         * между двумя системами координат, одна из которых у него отсутствует. */
        if (row.source !== 'desktop') {
          return res.status(200).json({
            ok: true,
            job: {
              id: job.id,
              toolName: job.tool_name,
              args,
              body: null,
              activate: null,
              goal: row.kind === 'created',
              flow: {
                id: row.client_id, source: row.source, kind: row.kind, name: row.name,
                description: row.description, payload, origins: row.origins || [],
              },
            },
          });
        }
        if (row.kind !== 'created' && Array.isArray(payload.events) && payload.events.length) {
          const allowed = [0.5, 1, 1.5, 2, 4];
          const asked = Number(args.speed);
          body = flowBody(
            [{
              recordingId: row.client_id,
              repeat: Math.min(999, Math.max(1, Math.round(Number(args.repeat) || 1))),
              speed: allowed.includes(asked) ? asked : 1,
              delayAfterMs: 0,
            }],
            [{ id: row.client_id, name: row.name, events: payload.events, windows: payload.windows || [] }],
            { startDelayMs: 0, flowRepeat: 1, flowForever: false },
          );
          /* The window it was recorded in, as the instruction that raises it - the same thing the Record
           * page sends before it plays a row, for the same reason: a replay is coordinates and has no idea
           * what is under them. */
          const front = Array.isArray(payload.windows) ? payload.windows[0] : null;
          if (front && (front.title || front.process)) {
            activate = `action=activate ${front.process ? `process=${front.process} ` : ''}`
              + `${front.title ? `title=${front.title}` : ''}`.trim();
          }
        }

        return res.status(200).json({
          ok: true,
          job: {
            id: job.id,
            toolName: job.tool_name,
            args,
            /* Both shapes, because there are two kinds of claimer. The agent reads `body` and `activate` and
             * needs nothing else; the worker reads `flow`, which it needs for a goal skill. */
            body,
            activate: activate ? activate.trim() : null,
            /* Whether this needs a model in the loop. The agent reads it to know that `body` will be null
             * and that it should start stepping instead; the worker already knows from `flow.kind`. */
            goal: row.kind === 'created',
            flow: {
              id: row.client_id, source: row.source, kind: row.kind, name: row.name,
              description: row.description, payload: row.payload, origins: row.origins,
            },
          },
        });
      }
      if (Date.now() >= until) return res.status(200).json({ ok: true, job: null });
      await new Promise((done) => setTimeout(done, CLAIM_POLL_MS));
    }
  }

  /* ------------------------------------------------------------------ one turn of a goal
   *
   * A goal skill is a model deciding one action at a time from a screenshot. Until now that loop could only
   * run on the user's own machine, in a node process they had to install alongside the agent, for one
   * reason: it talked to 127.0.0.1. This is the same loop with the machine at the other end of a request.
   *
   *   agent  ──POST ?worker=step { id, shot, windows, results }──►  here
   *                                                                 the model decides (~7s)
   *   agent  ◄──────────────  { actions: [...] }  ──────────────
   *          performs them, takes a new picture, posts again
   *
   * One request per step, and nothing reconnects between steps because there is no gap between them: the
   * reply to step n is what produces step n+1. The state lives in the row (run_queue.loop), never in this
   * function's memory - the instance that decided step 4 may not be the one that decides step 5.
   */
  if (action === 'step') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
    const body = req.body || {};
    const id = String(body.id || '');
    const [job] = await sql`
      select id, flow_id, tool_name, args, state, loop, claimed_at, schedule_id
      from run_queue where id = ${id} and user_id = ${who.id}
    `;
    const fail = async (why) => {
      await sql`
        update run_queue set state = 'failed', ok = false, said = ${why}, finished_at = now(), loop = null
        where id = ${id} and user_id = ${who.id}
      `;
      return res.status(200).json({ ok: true, done: true, outcome: { ok: false, said: why } });
    };

    /* The account's log, written here rather than by the machine - the same reason a stopped recording is
     * turned into a row here: everything the machine would otherwise have to learn already exists on this
     * side. Best effort, and reported: a run whose outcome never reached the log makes the dashboard wrong,
     * but it is not a reason to lose the answer somebody is waiting for. */
    const logRun = async (state, outcome, said, error) => {
      try {
        await sql`
          insert into user_run
            (user_id, client_id, kind, goal, model, flow_id, outcome, summary, error,
             steps, said, extension, started_at, finished_at, checks)
          values
            (${who.id}, ${job.id}, 'agent', ${String(state.goal || '').slice(0, 4000)},
             ${String(state.model || '').slice(0, 60)}, ${String(job.flow_id).slice(0, 80)},
             ${outcome}, ${said ? String(said).slice(0, 2000) : null},
             ${error ? String(error).slice(0, 2000) : null},
             ${JSON.stringify(state.steps || [])}, ${JSON.stringify(state.said || [])},
             /* The loop's own stamp, never claimed_at: that one is moved on by every step, so a
              * three-minute run would be logged with the duration of its last one. */
             'cloud', ${state.startedAt || job.claimed_at || null}, now(),
             /* Считается из шагов ЗДЕСЬ же, одной функцией с браузерным драйвером: два счёта «сколько
              * проверок прошло» однажды разойдутся. Null у прогона, который ничего не утверждал. */
             ${checksOf(state.steps) ? JSON.stringify(checksOf(state.steps)) : null})
          on conflict (user_id, client_id) do update set
            outcome = excluded.outcome, summary = excluded.summary, error = excluded.error,
            steps = excluded.steps, said = excluded.said, finished_at = excluded.finished_at,
            checks = excluded.checks
        `;
      } catch (err) {
        await report(err, req, { route: 'mcp:step:log' });
      }
    };

    /* Gone, or cancelled while it ran. Not an error: the cancellation is what somebody asked for, and the
     * machine's job is to stop, which it cannot do unless it is told. */
    if (!job) return res.status(200).json({ ok: true, done: true, stop: 'gone' });
    if (job.state !== 'claimed') {
      /* Told to stop, tidied up, and RECORDED. The conversation is only worth keeping while there is a next
       * step to take - a cancelled job that kept one would leave tens of kilobytes in the queue for as long
       * as the row lives - but a run somebody stopped part-way is still work that happened on their
       * computer, and the Hours screen and the assistant are built from those rows. The worker path has
       * always logged it; this one used to let a cancelled run vanish. */
      if (job.loop) {
        await logRun(job.loop, 'stopped', null, `stopped after ${job.loop.stepNo || 0} steps`);
        await sql`update run_queue set loop = null where id = ${id} and user_id = ${who.id}`;
      }
      return res.status(200).json({ ok: true, done: true, stop: job.state });
    }

    let loop = job.loop;
    if (!loop) {
      /* The first request of a run: work out what is being carried out, and start the conversation.
       *
       * Deliberately not a separate "begin" call. The agent has just claimed the job and taken a picture;
       * one shape of request for every step is one thing for it to implement and one thing to get right. */
      const flow = await sql`
        select client_id, kind, name, payload from user_flow
        where user_id = ${who.id} and client_id = ${job.flow_id} and deleted_at is null
      `;
      if (!flow.length) return fail('the skill was deleted between the ask and the run');
      const row = flow[0];
      if (row.kind !== 'created') return fail('this skill is a recording, not a goal - it is replayed, not decided');

      const payload = row.payload || {};
      const skill = { ...payload, id: row.client_id, name: row.name, params: payload.params || [] };
      const args = job.args || {};
      /* missingParams first, as its own comment instructs: fillGoal substitutes an empty string for
       * anything it cannot resolve, so calling it alone turns a missing argument into a goal with a hole in
       * it and a run that does something almost right. */
      const missing = missingParams(skill, args);
      if (missing.length) {
        return fail(`This skill needs ${missing.join(', ')}. Ask the user for the missing value rather than `
          + 'guessing one: the goal is carried out on their real computer and cannot be undone from here.');
      }
      const goal = fillGoal(skill, args);
      if (!goal || !goal.trim()) return fail('This skill has no goal text to carry out.');

      /* Resolved once, here, so every step of one run is decided by one model. A model changed mid-run
       * would hand the task between two that never saw each other's reasoning. */
      const settings = await readSettings(sql).catch(() => ({}));
      const wanted = settings['model.desktop'];
      const model = wanted && ALLOWED_MODELS.has(wanted) ? wanted : [...ALLOWED_MODELS][0];
      /* What the author said done looks like, carried from the skill into the run. Null when they said
       * nothing, which is most skills and is fine - the loop simply does not mention it. */
      /* WHAT THIS ACCOUNT DID JUST BEFORE, so that "now do X with the thing we just made" has something to
       * point at. Its own account only - never anybody else's - and composed in the brain so both drivers
       * say it identically. `catch(() => null)` on purpose: background is worth a query and never worth
       * failing a run over. */
      const before = await sql`
        select goal, outcome, summary, error, steps, started_at, finished_at
        from user_run
        where user_id = ${who.id} and deleted_at is null and kind = 'agent'
        order by started_at desc nulls last limit ${EARLIER_RUNS}
      `.catch(() => null);
      const earlier = earlierRuns((before || []).map((r) => ({
        goal: r.goal,
        outcome: r.outcome,
        summary: r.summary,
        error: r.error,
        steps: r.steps,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      })));
      /* ЗОНА ЧЕЛОВЕКА, чтобы цикл мог сказать модели, который час, - и чтобы «в 19:41» в цели значило его
       * 19:41, а не UTC. Сервер её не знает; берётся у расписания, которое этот прогон поставило, иначе из
       * настроек аккаунта (страница Skills и тул расписания записывают туда зону, которую прислал браузер).
       * Ничего нет - часы честно говорят UTC, и это сказано в строке. Фон, а не условие: не нашлось -
       * прогон идёт. */
      const zone = await (async () => {
        try {
          if (job.schedule_id) {
            const [sch] = await sql`select zone from user_schedule where id = ${job.schedule_id} and user_id = ${who.id}`;
            if (sch && sch.zone) return sch.zone;
          }
          const [pref] = await sql`select value from user_pref where user_id = ${who.id} and key = 'zone'`;
          return (pref && pref.value) || null;
        } catch (_) { return null; }
      })();
      loop = startLoop({ goal, model, success: payload.success || null, earlier, zone });
      /* Who is driving. A worker runs the loop itself and never writes here; recorded so that a machine
       * with both cannot end up driving one mouse twice. */
      await sql`update run_queue set stepping = true where id = ${id} and user_id = ${who.id}`;
    }

    /* ПОТОЛОК НА ОБЩИЙ КЛЮЧ - и это был самый дорогой маршрут без него.
     *
     * advance() зовёт callModel с ANTHROPIC_API_KEY развёртывания, по 8000 токенов на вызов, и прогон это
     * до 240 таких подряд. Остальные тратящие маршруты считали вызовы на аккаунт; здесь не считал никто, и
     * подписаться мог любой Google-аккаунт без единого платежа.
     *
     * Пятнадцать в минуту - примерно вдвое быстрее, чем настоящий прогон может идти (ход занимает секунд
     * восемь), так что живая работа этого не почувствует, а зациклившаяся перестанет стоить денег в
     * пределах минуты.
     *
     * Прогон при этом ЗАКАНЧИВАЕТСЯ, а не висит: очередь освобождается, строка пишется в лог как неудача с
     * причиной, которую человек может прочитать. Оставить его claimed значило бы, что упёршийся в потолок
     * прогон занимает место до самой уборки устаревших. */
    const budget = await overSpend(sql, who.id, 'step');
    if (!budget.ok) {
      /* Через тот же fail(), что и всякая другая неудача этого маршрута, а не своим путём: он помечает
       * строку failed с причиной, обнуляет loop и отвечает в форме, которую агент уже умеет читать.
       * Собственная уборка здесь была бы третьей версией того же самого - и первой, про которую забудут. */
      return fail(spentWhy(budget, 'runs'));
    }

    const out = await advance({ loop, shot: body.shot, windows: body.windows, results: body.results });

    /* ОТЛОЖЕНО, А НЕ СДЕЛАНО. Цель назвала время впереди, и модель вместо таймера из PowerShell позвала
     * defer_until. Прогон становится разовым расписанием на этот момент - с тем же flow_id, tool_name и
     * args, чтобы в назначенный час dueNow() поставил обычную строку очереди, - а эта строка закрывается и
     * отпускает мышь. В журнал прогонов не пишется: прогона не было, и зелёная строка о нём была бы ложью
     * того самого вида, против которого написан весь цикл. */
    if (out.done && out.done.deferred) {
      const when = out.done.deferred;
      const at = new Date(when.at);
      const [named] = await sql`
        select name from user_flow where user_id = ${who.id} and client_id = ${job.flow_id} and deleted_at is null
      `.catch(() => []);
      const sid = scheduleId();
      let said;
      try {
        await sql`
          insert into user_schedule (
            id, user_id, flow_id, tool_name, args, label, kind, zone, next_at, last_at, last_said
          ) values (
            ${sid}, ${who.id}, ${job.flow_id}, ${job.tool_name}, ${JSON.stringify(job.args || {})},
            ${String((named && named.name) || when.then || '').slice(0, 80)}, 'once', ${when.zone},
            ${at.toISOString()}, now(), ${'set aside by a run that was asked to wait until then'}
          )
        `;
        said = `Set aside until ${whenSaid(at.getTime(), when.zone)} (${sid}). It runs then, if this `
          + 'machine is awake and taking work; the time passing with nothing listening is recorded as missed.';
      } catch (err) {
        /* Таблицы может не быть - миграция не применена. Сказать это, а не изобразить зелёный прогон. */
        said = `The goal asked to wait until ${whenSaid(at.getTime(), when.zone)}, but this deployment cannot `
          + `schedule it: ${/user_schedule/.test(String(err.message)) ? 'db/018_user_schedule.sql is not applied' : err.message}. `
          + 'Nothing was done.';
        await sql`
          update run_queue set state = 'failed', ok = false, said = ${said}, finished_at = now(), loop = null
          where id = ${id} and user_id = ${who.id} and state = 'claimed'
        `;
        return res.status(200).json({ ok: true, done: true, outcome: { ok: false, said } });
      }
      /* И В ЖУРНАЛ ПРОГОНОВ - с единственным шагом, которым этот прогон и был.
       *
       * Сначала здесь не писалось ничего: «прогона не было». Это неверно - прогон был: модель получила
       * снимок, приняла решение и стоила за него денег, - а человек, у которого в истории пусто, не может
       * узнать, ЧТО было решено. `ok`, потому что прогон закончился тем, чем должен был; выдачей
       * недостигнутой цели за успех это не становится, так как summary начинается с «Set aside until …». */
      await logRun({ ...loop, steps: out.done.steps, said: out.done.saidAll }, 'ok', said, null);
      await sql`
        update run_queue set state = 'done', ok = true, said = ${said}, finished_at = now(), loop = null
        where id = ${id} and user_id = ${who.id} and state = 'claimed'
      `;
      return res.status(200).json({ ok: true, done: true, outcome: { ok: true, said } });
    }

    if (out.done) {
      const done = out.done;
      await logRun(
        { ...loop, steps: done.steps, said: done.saidAll },
        done.ok ? 'ok' : 'failed', done.said, done.error,
      );

      const took = (done.steps || []).length;
      const said = done.ok
        ? `${done.said || 'Done.'} (${took} action${took === 1 ? '' : 's'})`
        : `The run did not finish: ${done.error}. It took ${took} action${took === 1 ? '' : 's'}.`;
      await sql`
        update run_queue set state = ${done.ok ? 'done' : 'failed'}, ok = ${done.ok}, said = ${said},
               finished_at = now(), loop = null
        where id = ${id} and user_id = ${who.id} and state = 'claimed'
      `;
      return res.status(200).json({ ok: true, done: true, outcome: { ok: done.ok, said } });
    }

    /* Still going. `claimed_at` is moved on with every step, so the staleness sweep at the top of ?claim
     * measures time since the machine was last heard from rather than time since it took the job. */
    await sql`
      update run_queue set loop = ${JSON.stringify(out.loop)}, claimed_at = now()
      where id = ${id} and user_id = ${who.id} and state = 'claimed'
    `;
    if (out.shrink) return res.status(200).json({ ok: true, shrink: out.shrink });
    return res.status(200).json({
      ok: true, step: out.step, shotWidth: out.shotWidth, actions: out.actions,
    });
  }

  if (action === 'report') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
    const body = req.body || {};
    const id = String(body.id || '');
    let ok = body.ok === true;
    let said = body.said == null ? null : String(body.said).slice(0, 4000);

    /* A stopped recording arrives as the five-column body the agent hands back, and turning it into a row
     * happens HERE rather than on the machine.
     *
     * That is the whole point of doing it this way: the agent can then be the thing that claims the job, and
     * an agent is a small program that speaks its own format and knows nothing about accounts, payload
     * shapes or flow ids. Everything it would otherwise have to learn - parseMacro, flowFor, the stamp that
     * says this row is a recording - already exists here, in one copy, shared with the app. */
    if (body.body != null) {
      const [job] = await sql`select flow_id from run_queue where id = ${id} and user_id = ${who.id}`;
      if (job && job.flow_id === '#record.stop') {
        const saved = await saveRecording(sql, who, String(body.body), body.health || null);
        ok = saved.ok;
        said = saved.said;
      }
    }

    const done = await sql`
      update run_queue set state = ${ok ? 'done' : 'failed'}, ok = ${ok}, said = ${said},
             finished_at = now()
      where id = ${id} and user_id = ${who.id} and state = 'claimed'
      returning id
    `;
    /* ИСХОД ВОЗВРАЩАЕТСЯ РАСПИСАНИЮ, если прогон завёлся им.
     *
     * Иначе расписание, чей скилл перестал работать, будет запускать его каждый час вечно - и у целевого
     * скилла каждый такой запуск это ещё один платный вызов модели. Три неудачи подряд останавливают его
     * самого, с причиной; удачный прогон обнуляет счёт, потому что «три подряд» - это про подряд.
     *
     * Отдельным запросом и после основного: отчёт о прогоне обязан записаться, даже если расписание за это
     * время удалили, а таблицы может не быть вовсе на деплое без миграции. */
    if (done.length === 1) {
      try {
        const [job] = await sql`select schedule_id from run_queue where id = ${id}`;
        if (job && job.schedule_id) {
          if (ok) {
            await sql`
              update user_schedule set fails = 0, last_at = now(),
                     last_said = ${`ran - ${(said || 'done').slice(0, 200)}`}, updated_at = now()
              where id = ${job.schedule_id} and user_id = ${who.id}
            `;
          } else {
            await sql`
              update user_schedule
              set fails = fails + 1, last_at = now(),
                  last_said = ${`failed - ${(said || 'no reason given').slice(0, 200)}`},
                  paused = (fails + 1 >= ${FAILS_BEFORE_PAUSE}),
                  paused_why = case when fails + 1 >= ${FAILS_BEFORE_PAUSE}
                    then ${`stopped after ${FAILS_BEFORE_PAUSE} failures in a row`} else paused_why end,
                  updated_at = now()
              where id = ${job.schedule_id} and user_id = ${who.id}
            `;
          }
        }
      } catch (_) { /* см. выше: отчёт уже записан, и это важнее */ }
    }

    /* A job cancelled while it ran is not 'claimed' any more, so nothing is updated - and that is the right
     * answer, not an error: the cancellation is what the person asked for and it stands. */
    return res.status(200).json({ ok: true, recorded: done.length === 1 });
  }

  /* An agent saying it fell over.
   *
   * It goes through here rather than to Sentry directly, and that is the whole design: the agent already
   * dials this endpoint with a device token, so it needs no DSN of its own - one less secret inside a
   * program people download - and what arrives is already attached to an account and a machine. The cost is
   * stated plainly: a crash whose cause is "cannot reach the deployment" cannot arrive this way, and stays
   * in the agent's own log where it always was.
   *
   * Nothing here can fail the caller. An agent that has just crashed is not helped by a 500.
   */
  if (action === 'crash') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
    const body = req.body || {};
    let sent = false;
    try {
      sent = await reportSaid({
        type: body.type,
        message: body.message,
        stack: body.stack,
        level: body.level,
        tags: {
          route: 'agent',
          /* Which agent, and which build of it. A crash that only happens on one platform or after one
           * release is the common case, and without these every report reads as "the agent broke". */
          platform: String(body.platform || 'unknown').slice(0, 20),
          version: String(body.version || 'unknown').slice(0, 20),
        },
        /* Тот, кому принадлежит машина - id и только id. Абзац выше обосновывает весь этот маршрут
         * тем, что приходящее «уже привязано к аккаунту и машине»: привязка была в рассуждении и не была
         * в событии, так что в Sentry все краши всех агентов лежали одной кучей. */
        user: { id: who.id },
        extra: { where: String(body.where || '').slice(0, 200) },
      });
    } catch (_) {
      sent = false;
    }
    /* `reported` is the truth, not a courtesy: a deployment with no DSN configured accepts this and sends
     * nothing, and an agent that was told "ok" either way could never tell that apart from a working one. */
    return res.status(200).json({ ok: true, reported: sent });
  }

  if (action === 'state') {
    const id = String((req.query && req.query.id) || '');
    const rows = await sql`select state from run_queue where id = ${id} and user_id = ${who.id}`;
    return res.status(200).json({ ok: true, state: rows.length ? rows[0].state : 'gone' });
  }

  return res.status(400).json({ error: `no worker action "${action}"` });
}

/* ------------------------------------------------------------------------------- the route */

async function handler(req, res) {
  cors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  /* Whoever opened this in a browser. Deliberately answerable without a token: it says nothing about
   * anybody and saves a person guessing why a URL returns 401.
   *
   * Every OTHER GET has to be excluded by name, and that is a sharp edge worth stating: this branch runs
   * before authentication, so any query it does not know about is answered with a document about the server
   * instead of the thing that was asked for. `?pending=1` fell into it and returned `{name, version}` - no
   * error, no 401, just the wrong answer - and the banner that reads `waiting` from it silently never
   * appeared. A route that swallows unknown queries fails exactly like this: quietly, and looking fine. */
  const aGetForSomethingElse = req.query && (req.query.worker || req.query.pending || req.query.live);
  if (req.method === 'GET' && !aGetForSomethingElse) {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'mouseflowapp.vercel.app';
    res.status(200).json({
      name: SERVER.name,
      version: SERVER.version,
      protocol: 'MCP over HTTP POST, JSON-RPC 2.0',
      /* Both ways in, and the one to prefer first. This said "Bearer <device token>" alone for as long as
       * a device token was the only answer, and went on saying it after OAuth landed - which is how a
       * document about a server starts describing a server that no longer exists. */
      auth: 'Add this URL to your client and sign in with your MouseFlow account (OAuth), or send '
        + 'Authorization: Bearer <device token> from Settings → My account',
      note: 'Reading works the moment you connect. Recording and running a skill need a computer attached '
        + 'to the account — in the app: Connections → "Let Claude drive this computer".',
      docs: `https://${host}/mcp`,
    });
    return;
  }

  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'This deployment has no database configured.' });
    return;
  }
  const sql = neon(process.env.DATABASE_URL);

  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (_) {
    who = null;
  }
  if (!who) return unauthorized(req, res);

  /* "Is anything waiting for a machine?" - asked by the app, answered without a job id.
   *
   * The app is the only place a person can say yes, and it cannot offer to unless it knows there is
   * something to say yes TO. Without this the failure is silent in the one window that could fix it: a
   * command sits in a queue, the chat says nothing picked it up, and the app - open on the same screen -
   * shows an ordinary Record page. */
  if (req.method === 'GET' && req.query && req.query.pending) {
    const rows = await sql`
      select id, tool_name, created_at from run_queue
      where user_id = ${who.id} and state = 'queued'
      order by created_at limit 5
    `;
    res.status(200).json({
      ok: true,
      waiting: rows.length,
      oldest: rows.length ? rows[0].created_at : null,
      tools: rows.map((r) => r.tool_name).filter(Boolean),
    });
    return;
  }

  /* «ЧТО МАШИНА ДЕЛАЕТ САМА» - спрашивает приложение, открытое на том же экране.
   *
   * Прогон по расписанию ведёт агент через ?worker=step, и страница Create о нём не знает ничего: в 20:10
   * Outlook открылся и закрылся, а в приложении - ни ленты шагов, ни объявления, ни строки в истории до
   * перезагрузки. Человек прочитал это как «сделал молча». Этот ответ - то, чем страница узнаёт о прогонах,
   * которых не начинала: что идёт сейчас (шаги - из loop, где облачный цикл их держит между ходами) и что
   * закончилось только что (шаги - из user_run, потому что loop у законченного обнулён). Три минуты назад -
   * чтобы окончание, случившееся между двумя опросами, не пропало. Только строки этого человека. */
  if (req.method === 'GET' && req.query && req.query.live) {
    const rows = await sql`
      select q.id, q.flow_id, q.tool_name, q.state, q.ok, q.said, q.loop, q.schedule_id,
             q.created_at, q.claimed_at, q.finished_at,
             f.name as flow_name, r.steps as run_steps, r.goal as run_goal, r.started_at as run_started
      from run_queue q
      left join user_flow f on f.user_id = q.user_id and f.client_id = q.flow_id
      left join user_run r on r.user_id = q.user_id and r.client_id = q.id
      where q.user_id = ${who.id}
        and (q.state in ('queued', 'claimed') or q.finished_at > now() - interval '3 minutes')
      order by q.created_at desc limit 5
    `;
    res.status(200).json({
      ok: true,
      jobs: rows.map((q) => {
        const loop = q.loop && typeof q.loop === 'object' ? q.loop : null;
        return {
          id: q.id,
          state: q.state,
          ok: q.ok,
          said: q.said || null,
          name: q.flow_name || q.tool_name || q.flow_id,
          goal: (loop && loop.goal) || q.run_goal || null,
          scheduleId: q.schedule_id || null,
          startedAt: (loop && loop.startedAt) || q.run_started || q.claimed_at || q.created_at,
          finishedAt: q.finished_at,
          /* Идущий - из loop; законченный - из журнала. Ни один не выдумывается. */
          steps: (loop && Array.isArray(loop.steps) && loop.steps)
            || (Array.isArray(q.run_steps) && q.run_steps) || [],
        };
      }),
    });
    return;
  }

  const action = req.query && req.query.worker;
  if (action) return workerRoute(String(action), req, res, sql, who);

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST' });
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : null;
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    res.status(400).json(rpcError(body && body.id, -32600, 'not a JSON-RPC 2.0 request'));
    return;
  }

  const { id, method, params } = body;

  /* A notification has no id and gets no body - 202 is the documented answer, and replying to one would
   * put an unmatched response into the client's stream. */
  if (method.startsWith('notifications/')) {
    res.status(202).end();
    return;
  }

  try {
    if (method === 'initialize') {
      const asked = params && params.protocolVersion;
      res.setHeader('Mcp-Session-Id', randomUUID());
      res.status(200).json(rpc(id, {
        protocolVersion: SPOKEN.has(asked) ? asked : NEWEST,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: 'Each tool other than mouseflow_status, mouseflow_stop and mouseflow_run_status is one '
          + 'skill on this person\'s MouseFlow account, and calling it moves the real mouse and keyboard on '
          + 'their computer. Two consequences worth holding on to: the actions cannot be undone from here, '
          + 'and a missing argument should be asked for rather than guessed. Nothing runs unless a worker is '
          + 'listening on that machine; mouseflow_status says whether one is.',
      }));
      return;
    }

    if (method === 'ping') {
      res.status(200).json(rpc(id, {}));
      return;
    }

    if (method === 'tools/list') {
      /* Fixed, and that is the change: this used to append one tool per skill, so the list - and the
       * tokens it costs in every request, and the permission dialog somebody reads - grew with the
       * library. Skills are found through mouseflow_recordings and run through mouseflow_run. */
      res.status(200).json(rpc(id, {
        tools: [
          ...READ_TOOLS,
          HELP_TOOL,
          SCHEDULE_TOOL, SCHEDULES_TOOL, UNSCHEDULE_TOOL,
          START_TOOL, STOP_RECORDING_TOOL,
          STATUS_TOOL, STOP_TOOL, RUN_STATUS_TOOL, RUN_TOOL, DO_TOOL,
        ],
      }));
      return;
    }

    if (method === 'tools/call') {
      res.status(200).json(rpc(id, await callTool(sql, who, params, req)));
      return;
    }

    res.status(200).json(rpcError(id, -32601, `no method "${method}"`));
  } catch (err) {
    /* A thrown error is still a tool answer when it happened inside one: the client should see a sentence
     * it can act on, not a transport failure it cannot. */
    if (method === 'tools/call') {
      res.status(200).json(rpc(id, say(`That did not work: ${err.message}`, true)));
      return;
    }
    res.status(200).json(rpcError(id, -32603, err.message));
  }
}

/* The outer net: anything thrown before or around the handler's own try block. */
export default wrap(handler, 'mcp');
