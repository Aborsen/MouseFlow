/* The MCP server, end to end, against a fake deployment and a fake agent.
 *
 * Everything this server does is a conversation between three parties - an MCP client on stdio, the
 * deployment over HTTPS, and the local agent over loopback - so the only test worth writing stands all three
 * up and watches what crosses the wires. Reading the source and agreeing with it is what the earlier bugs in
 * this repository survived.
 *
 * The two fakes are deliberately literal. The deployment answers /api/sync with the exact shape api/sync.js
 * returns, and the agent answers the exact shape the Swift and PowerShell agents do, because a fake that is
 * merely plausible tests the fake.
 *
 * Run: node mcp/test-mcp.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

/* A 1×1 PNG, so the decision loop has something real to look at. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/* ------------------------------------------------------------------------------- the account */

const EVENTS = [
  { x: 100, y: 200, delayMs: 0, action: 'press', context: { app: 'Outlook', window: 'Inbox', control: 'New mail' } },
  { x: 100, y: 200, delayMs: 40, action: 'release' },
  { x: 400, y: 300, delayMs: 500, action: 'press' },
  { x: 400, y: 300, delayMs: 40, action: 'release' },
];

const FLOWS = [
  {
    id: 'dr_rec1', source: 'desktop', kind: 'recorded', name: 'Open the inbox',
    description: 'Repeats 4 recorded actions (2 clicks) over 1.0s, in Outlook.',
    origins: ['Outlook'],
    payload: { role: 'skill', events: EVENTS, windows: [{ title: 'Inbox', process: 'OUTLOOK' }] },
  },
  {
    id: 'sk_goal1', source: 'desktop', kind: 'created', name: 'Send the weekly note',
    description: 'Carries out: email {{recipient}} the weekly note',
    origins: [],
    payload: {
      role: 'skill', kind: 'created',
      goalTemplate: 'email {{recipient}} the weekly note',
      params: [{ name: 'recipient', type: 'email', example: null }],
    },
  },
  {
    id: 'sk_page1', source: 'extension', kind: 'recorded', name: 'Fill the timesheet',
    description: 'Replays 12 recorded actions.', origins: ['app.example.com'],
    payload: { role: 'skill', events: EVENTS },
  },
  /* No role: written before rows said which they were. Must NOT be offered - see the note in server.mjs. */
  { id: 'old1', source: 'desktop', kind: 'recorded', name: 'Something old', description: '', origins: [], payload: { events: EVENTS } },
  /* A recording, which the Skills page hides and so must this. */
  { id: 'rec9', source: 'desktop', kind: 'recorded', name: 'Just a recording', description: '', origins: [], payload: { role: 'recording', events: EVENTS } },
];

/* ------------------------------------------------------------------------------- the fakes */

const seen = { activate: [], replayBodies: [], runs: [], modelCalls: 0, claims: 0, reports: [], flows: [], nextJob: null };
let replaying = false;
let recording = false;
let replayStatus = { playing: false, step: 1, steps: 1, pass: 1, passes: 1, index: 4, total: 4, flowPass: 1, flowPasses: 1, unplayable: 0, retargeted: 0 };
let agentUp = true;

const readBody = (req) => new Promise((done) => {
  let text = '';
  req.on('data', (c) => { text += c; });
  req.on('end', () => done(text));
});

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const deployment = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/sync' && req.method === 'GET') {
    if (req.headers.authorization !== 'Bearer mf_test_token') return json(res, 401, { error: 'no' });
    return json(res, 200, { ok: true, you: { name: 'Tester', prefs: {} }, flows: FLOWS, runs: [] });
  }
  if (url.pathname === '/api/sync' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    (body.runs || []).forEach((r) => seen.runs.push(r));
    (body.flows || []).forEach((f) => seen.flows.push(f));
    return json(res, 200, { ok: true, flows: 0, runs: (body.runs || []).length, deleted: 0, problems: [] });
  }
  if (url.pathname === '/api/mcp' && url.searchParams.get('worker') === 'claim') {
    await readBody(req);
    seen.claims++;
    /* One job, then nothing - so a worker started with ONCE=1 does exactly one piece of work. */
    if (seen.nextJob) { const job = seen.nextJob; seen.nextJob = null; return json(res, 200, { ok: true, job }); }
    if (seen.claims > 1) return json(res, 200, { ok: true, job: null });
    return json(res, 200, {
      ok: true,
      job: { id: 'q_test1', toolName: 'open_the_inbox_drrec1', args: { repeat: 1 }, flow: FLOWS[0] },
    });
  }
  if (url.pathname === '/api/mcp' && url.searchParams.get('worker') === 'report') {
    seen.reports.push(JSON.parse(await readBody(req) || '{}'));
    return json(res, 200, { ok: true, recorded: true });
  }
  if (url.pathname === '/api/mcp' && url.searchParams.get('worker') === 'state') {
    return json(res, 200, { ok: true, state: 'claimed' });
  }
  if (url.pathname === '/api/claude' && req.method === 'GET') {
    return json(res, 200, { model: 'test-model', planModel: 'test-model' });
  }
  if (url.pathname === '/api/claude' && req.method === 'POST') {
    seen.modelCalls++;
    if (req.headers.authorization !== 'Bearer mf_test_token') return json(res, 401, { error: 'no token' });
    return json(res, 200, {
      content: [{ type: 'tool_use', id: 'tu1', name: 'finish', input: { ok: true, said: 'Sent the note.' } }],
    });
  }
  return json(res, 404, { error: 'nope' });
});

const agent = createServer(async (req, res) => {
  if (!agentUp) { res.destroy(); return; }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    return json(res, 200, {
      ok: true, version: '0.8.2', platform: 'macos', screen: { w: 1440, h: 900 },
      recording, playing: replaying,
      canSee: true, canWindows: true, canName: true, canKeys: true, canDrain: true,
    });
  }
  if (url.pathname === '/windows') return json(res, 200, { ok: true, windows: [{ title: 'Inbox', process: 'OUTLOOK' }] });
  if (url.pathname === '/shot') return json(res, 200, { ok: true, png: PNG, format: 'png', w: 1440, h: 900, scale: 1, originX: 0, originY: 0 });
  if (url.pathname === '/do') { seen.activate.push(await readBody(req)); return json(res, 200, { ok: true }); }
  if (url.pathname === '/record/start') { recording = true; return json(res, 200, { ok: true }); }
  if (url.pathname === '/record/stop') {
    recording = false;
    res.writeHead(200, { 'content-type': 'text/plain' });
    /* The exact shape both agents hand back, #ctx lines and all. */
    res.end('#ctx\tapp=OUTLOOK\twindow=Inbox\tcontrol=New mail\ttype=button\n'
      + '1 | 100 | 200 | 0 | Left Click Down\n'
      + '2 | 100 | 200 | 40 | Left Click Up\n'
      + '#ctx\tapp=EXCEL\twindow=Book1\n'
      + '3 | 400 | 300 | 500 | Left Click Down\n'
      + '4 | 400 | 300 | 40 | Left Click Up\n');
    return undefined;
  }
  if (url.pathname === '/replay') {
    seen.replayBodies.push(await readBody(req));
    replaying = true;
    replayStatus = { ...replayStatus, playing: true };
    /* Finishes on its own, the way a real replay does. */
    setTimeout(() => { replaying = false; replayStatus = { ...replayStatus, playing: false }; }, 900);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/replay/status') return json(res, 200, replayStatus);
  if (url.pathname === '/replay/abort') { replaying = false; replayStatus = { ...replayStatus, playing: false }; return json(res, 200, { ok: true }); }
  return json(res, 404, { ok: false, error: 'nope' });
});

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));

/* ------------------------------------------------------------------------------- the client */

class Client {
  constructor(child) {
    this.child = child;
    this.next = 1;
    this.waiting = new Map();
    this.notes = [];
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch (_) { this.bad = line; return; }
      if (message.id === undefined || message.id === null) { this.notes.push(message); return; }
      const settle = this.waiting.get(message.id);
      if (settle) { this.waiting.delete(message.id); settle(message); }
    });
  }

  send(method, params) {
    const id = this.next++;
    return new Promise((done, fail_) => {
      const timer = setTimeout(() => fail_(new Error(`no answer to ${method}`)), 60000);
      this.waiting.set(id, (m) => { clearTimeout(timer); done(m); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }
}

const said = (answer) => (answer.result && answer.result.content && answer.result.content[0]
  ? answer.result.content[0].text : '');

/* ------------------------------------------------------------------------------- the run */

const deployPort = await listen(deployment);
const agentPort = await listen(agent);

const child = spawn(process.execPath, [fileURLToPath(new URL('server.mjs', import.meta.url))], {
  env: {
    ...process.env,
    MOUSEFLOW_TOKEN: 'mf_test_token',
    MOUSEFLOW_URL: `http://127.0.0.1:${deployPort}`,
    MOUSEFLOW_AGENT_PORT: String(agentPort),
    /* So a replay that never finishes fails in seconds with something to read, instead of hanging for the
     * half hour a real one is allowed. */
    MOUSEFLOW_REPLAY_MAX_MS: '20000',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const logs = [];
child.stderr.on('data', (c) => logs.push(String(c)));

const client = new Client(child);

group('the handshake');
const hello = await client.send('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'test', version: '0' },
});
check('it answers initialize', !!hello.result, JSON.stringify(hello));
check('and echoes the version the client asked for', hello.result.protocolVersion === '2025-03-26',
  hello.result.protocolVersion);
check('declares the tools capability with listChanged',
  !!(hello.result.capabilities && hello.result.capabilities.tools
    && hello.result.capabilities.tools.listChanged === true));
check('and says what calling one of these means',
  /real mouse and keyboard/.test(hello.result.instructions || ''));
client.notify('notifications/initialized');

const pong = await client.send('ping', {});
check('ping is answered', !!pong.result && !pong.error);

group('the tool list is the account');
const list = await client.send('tools/list', {});
const names = (list.result.tools || []).map((t) => t.name);
check('the two fixed tools are there',
  names.includes('mouseflow_status') && names.includes('mouseflow_stop'), names.join(', '));
check('a recorded desktop skill is offered', names.some((n) => n.startsWith('open_the_inbox')), names.join(', '));
check('a goal skill is offered', names.some((n) => n.startsWith('send_the_weekly_note')), names.join(', '));
check('an extension skill is offered too, so nothing is silently missing',
  names.some((n) => n.startsWith('fill_the_timesheet')), names.join(', '));
check('a recording is NOT offered', !names.some((n) => n.startsWith('just_a_recording')), names.join(', '));
check('and neither is an unstamped row', !names.some((n) => n.startsWith('something_old')), names.join(', '));
check('nothing else crept in', names.length === 5, String(names.length));

const inbox = list.result.tools.find((t) => t.name.startsWith('open_the_inbox'));
check('a recorded skill takes the replay knobs and nothing else',
  Object.keys(inbox.inputSchema.properties).sort().join(',') === 'repeat,speed',
  Object.keys(inbox.inputSchema.properties).join(','));
check('the schema sits under inputSchema, which is what MCP reads', !!inbox.inputSchema && !inbox.input_schema);
check('and the description says who does the work',
  /own machine through the MouseFlow agent/.test(inbox.description), inbox.description);

const weekly = list.result.tools.find((t) => t.name.startsWith('send_the_weekly_note'));
check('a goal skill takes its own parameter',
  Object.keys(weekly.inputSchema.properties).join(',') === 'recipient',
  Object.keys(weekly.inputSchema.properties).join(','));
check('required, because its author left no example',
  weekly.inputSchema.required.join(',') === 'recipient', weekly.inputSchema.required.join(','));
check('and it is typed as an address', weekly.inputSchema.properties.recipient.format === 'email');

group('status');
const status = await client.send('tools/call', { name: 'mouseflow_status', arguments: {} });
check('it reports the running agent and its version', /agent is running: version 0\.8\.2/.test(said(status)), said(status));
check('and what it can do', /can: sees, names, keys/.test(said(status)), said(status));
check('and the account it read', /3 skills on the account \(Tester\)/.test(said(status)), said(status));
check('and says out loud what it left out rather than hiding it',
  /1 row on the account are not marked|1 rows on the account are not marked/.test(said(status)), said(status));

group('replaying a recorded skill');
const played = await client.send('tools/call', { name: inbox.name, arguments: { repeat: 2, speed: 2 } });
check('the front window is raised first, as the Record page does',
  seen.activate.some((b) => /action=activate/.test(b) && /process=OUTLOOK/.test(b)), seen.activate.join(' | '));
const body = seen.replayBodies[0] || '';
check('the replay body carries the five columns', /\n1 \| 100 \| 200 \| 0 \| press/.test(body), body.slice(0, 120));
check('and the #ctx line, so a moved control can be re-aimed', /#ctx\tapp=Outlook/.test(body), body.slice(0, 200));
check('repeat and speed reach the body', /STEP repeat=2 speed=2/.test(body), body.split('\n')[2]);
check('it waited for the replay to end before answering', /Replayed "Open the inbox"/.test(said(played)), said(played));
check('and does not claim the applications did anything',
  /actions were sent/.test(said(played)), said(played));
check('the run reached the account as a replay',
  seen.runs.some((r) => r.kind === 'replay' && r.flowId === 'dr_rec1' && r.outcome === 'ok'),
  JSON.stringify(seen.runs));

group('what could not be played is not called success in silence');
replayStatus = { ...replayStatus, unplayable: 3, retargeted: 1 };
const partial = await client.send('tools/call', { name: inbox.name, arguments: {} });
check('the unplayable count is reported', /3 events could not be played/.test(said(partial)), said(partial));
check('with the reason, which is the privacy design',
  /Keystroke content is never stored/.test(said(partial)), said(partial));
check('and the re-aimed clicks are named too',
  /1 click was re-aimed by name/.test(said(partial)), said(partial));
replayStatus = { ...replayStatus, unplayable: 0, retargeted: 0 };

group('a goal skill');
const noArgs = await client.send('tools/call', { name: weekly.name, arguments: {} });
check('a missing parameter is refused by name', /needs recipient/.test(said(noArgs)), said(noArgs));
check('and it is marked as an error, not a result', noArgs.result.isError === true);
check('and the caller is told to ask rather than invent one',
  /rather than guessing/.test(said(noArgs)), said(noArgs));

const ran = await client.send('tools/call', { name: weekly.name, arguments: { recipient: 'sam@example.com' } });
check('with the parameter it runs the decision loop', seen.modelCalls > 0, String(seen.modelCalls));
check('and reports what the run said', /Sent the note\./.test(said(ran)), said(ran));
check('the run reached the account as an agent run with the FILLED goal',
  seen.runs.some((r) => r.kind === 'agent' && r.goal === 'email sam@example.com the weekly note'),
  JSON.stringify(seen.runs.map((r) => r.goal)));
check('and the model it actually used was the one the deployment named',
  /test-model/.test(logs.join('')) || seen.runs.some((r) => r.kind === 'agent'), 'see the run log');

group('what it will not do');
const pageName = names.find((n) => n.startsWith('fill_the_timesheet'));
const pageAnswer = await client.send('tools/call', { name: pageName, arguments: {} });
check('an extension skill refuses with the reason',
  /browser extension is the half that can replay it/.test(said(pageAnswer)), said(pageAnswer));
check('and refusing counts as an error', pageAnswer.result.isError === true);
check('and nothing was sent to the agent for it',
  seen.replayBodies.length === 2, String(seen.replayBodies.length));

const gone = await client.send('tools/call', { name: 'no_such_skill_abc123', arguments: {} });
check('a name that is not on the account says the list changed',
  /ask for the tool list again/.test(said(gone)), said(gone));
check('and it is an error', gone.result.isError === true);

const nope = await client.send('resources/list', {});
check('a method this server does not offer is refused properly',
  !!nope.error && nope.error.code === -32601, JSON.stringify(nope));

group('stop');
const stopped = await client.send('tools/call', { name: 'mouseflow_stop', arguments: {} });
check('stopping when nothing runs still tells the agent',
  /a stop was sent to the agent/.test(said(stopped)), said(stopped));

group('when the agent is not there');
agentUp = false;
const dead = await client.send('tools/call', { name: inbox.name, arguments: {} });
check('a skill call says the agent is not running',
  /No MouseFlow agent answered/.test(said(dead)), said(dead));
check('and names the port it looked on', new RegExp(`127\\.0\\.0\\.1:${agentPort}`).test(said(dead)), said(dead));
const deadStatus = await client.send('tools/call', { name: 'mouseflow_status', arguments: {} });
check('status says so as an error rather than a cheerful report', deadStatus.result.isError === true);
agentUp = true;

group('the protocol stream stays clean');
check('nothing but JSON was written to stdout', !client.bad, client.bad);
check('the diagnostics went to stderr', logs.join('').includes('[mouseflow]'), logs.join('').slice(0, 200));

child.stdin.end();
child.kill();

group('the worker: the machine end of the HTTPS server');
const before = seen.replayBodies.length;
const worker = spawn(process.execPath, [fileURLToPath(new URL('worker.mjs', import.meta.url))], {
  env: {
    ...process.env,
    MOUSEFLOW_TOKEN: 'mf_test_token',
    MOUSEFLOW_URL: `http://127.0.0.1:${deployPort}`,
    MOUSEFLOW_AGENT_PORT: String(agentPort),
    MOUSEFLOW_WORKER_NAME: 'test-machine',
    MOUSEFLOW_WORKER_WAIT: '0',
    MOUSEFLOW_WORKER_ONCE: '1',
    MOUSEFLOW_REPLAY_MAX_MS: '20000',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const workerLog = [];
worker.stderr.on('data', (c) => workerLog.push(String(c)));
const workerCode = await new Promise((done) => worker.on('exit', done));

check('it exits cleanly after one job', workerCode === 0, String(workerCode));
check('it claimed work rather than being pushed any', seen.claims >= 1, String(seen.claims));
check('it names itself and the agent it found', /listening for work as "test-machine".*agent 0\.8\.2/.test(workerLog.join('')), workerLog.join(''));
check('it ran the skill through the same path the stdio server uses',
  seen.replayBodies.length === before + 1, `${before} -> ${seen.replayBodies.length}`);
check('the window was raised for it too, from the payload that travelled with the job',
  seen.activate.filter((b) => /process=OUTLOOK/.test(b)).length >= 3, seen.activate.join(' | '));
const report = seen.reports[0] || {};
check('it reported the job id it was given', report.id === 'q_test1', JSON.stringify(report));
check('with ok true', report.ok === true, JSON.stringify(report));
check('and the same sentence a local caller would have got',
  /Replayed "Open the inbox"/.test(report.said || ''), report.said);
check('the run also reached the account, not only the queue',
  seen.runs.filter((r) => r.kind === 'replay').length >= 3, String(seen.runs.length));

group('the timer: start and stop, through the same queue');
const runWorker = async (job) => {
  seen.nextJob = job;
  const w = spawn(process.execPath, [fileURLToPath(new URL('worker.mjs', import.meta.url))], {
    env: {
      ...process.env,
      MOUSEFLOW_TOKEN: 'mf_test_token',
      MOUSEFLOW_URL: `http://127.0.0.1:${deployPort}`,
      MOUSEFLOW_AGENT_PORT: String(agentPort),
      MOUSEFLOW_WORKER_WAIT: '0',
      MOUSEFLOW_WORKER_ONCE: '1',
      MOUSEFLOW_REPLAY_MAX_MS: '20000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const said = [];
  w.stderr.on('data', (c) => said.push(String(c)));
  /* Bounded, and the worker's own words come back with the failure. A spawned process that never exits is
   * the one failure a test cannot explain from the outside, and waiting forever for it explains nothing. */
  const how = await new Promise((done) => {
    const timer = setTimeout(() => { w.kill(); done('timed out'); }, 30000);
    w.on('exit', (code) => { clearTimeout(timer); done(code === 0 ? 'ok' : `exit ${code}`); });
  });
  /* The report for THIS job, not merely the newest one - a worker that died before reporting would
   * otherwise be read as having succeeded at whatever ran before it. */
  const mine = seen.reports.find((r) => r.id === job.id) || {};
  return { ...mine, how, log: said.join('') };
};

const started = await runWorker({ id: 'q_start', toolName: 'mouseflow_start_recording', args: {}, command: '#record.start', flow: null });
check('a start command reaches the agent and is reported ok', started.ok === true,
  `how=${started.how} log=${started.log}`);
check('and says what is and is not captured',
  /never which key/.test(started.said || ''), started.said);

const ended = await runWorker({ id: 'q_stop', toolName: 'mouseflow_stop_recording', args: {}, command: '#record.stop', flow: null });
check('a stop command comes back ok', ended.ok === true, `how=${ended.how} log=${ended.log}`);
check('and hands the five-column body over UNCHANGED, rather than turning it into a row itself',
  /#ctx\tapp=OUTLOOK/.test(ended.body || '') && /1 \| 100 \| 200 \| 0 \| Left Click Down/.test(ended.body || ''),
  String(ended.body).slice(0, 80));
check('the machine sends no flow to the account - the server writes the row',
  seen.flows.length === 0, JSON.stringify(seen.flows.map((f) => f.id)));
check('and the agent it found travels with it, because only the machine knows that',
  ended.health && ended.health.version === '0.8.2', JSON.stringify(ended.health));

group('and what the server makes of that body');
/* The two halves saveRecording() composes, exercised directly: no database needed to know whether the row
 * it would write is the right shape. */
const { parseMacro } = await import(new URL('../api/_macro.mjs', import.meta.url).href);
const { flowFor } = await import(new URL('../api/_flow-for.mjs', import.meta.url).href);
const parsed = parseMacro(ended.body || '');
check('the body parses to the events it carried', parsed.events.length === 4, String(parsed.events.length));
check('with their #ctx intact', parsed.events[0].context?.control === 'New mail',
  JSON.stringify(parsed.events[0]));
const derived = new Map();
for (const e of parsed.events) {
  const c = e.context;
  if (!c || (!c.app && !c.window)) continue;
  const key = `${c.app || ''}\u0000${c.window || ''}`;
  if (!derived.has(key)) derived.set(key, { title: c.window || c.app || '', process: c.app || '' });
}
const built = flowFor({ id: 'rtest', name: 'x', created: new Date(0).toISOString(),
  events: parsed.events, windows: [...derived.values()] }, ended.health);
check('flowFor stamps it as a recording', built.payload.role === 'recording', JSON.stringify(built.payload.role));
check('and as desktop, which decides who may replay it', built.source === 'desktop');
check('the windows come out of the events, not out of a poll nobody ran',
  built.payload.windows.length === 2 && built.payload.windows[0].process === 'OUTLOOK',
  JSON.stringify(built.payload.windows));
check('and what the agent said about itself is recorded, because later nothing can reconstruct it',
  built.payload.recorder.version === '0.8.2' && built.payload.recorder.canKeys === true,
  JSON.stringify(built.payload.recorder));

group('the HTTPS route: one account, and no way to name another');
const route = readFileSync(fileURLToPath(new URL('../api/mcp.js', import.meta.url)), 'utf8');
check('the caller is resolved by credential, once', /whoIsCalling\(req, sql\)/.test(route));
check('and a missing credential is a 401 that says where auth lives',
  /WWW-Authenticate/.test(route) && /resource_metadata/.test(route));
/* The invariant that matters: no query may take a user id from anywhere but `who`. Every interpolation
 * against user_id is checked rather than trusted, because one that read the body would be the whole bug. */
const userIdInterps = [...route.matchAll(/user_id = \$\{([^}]+)\}/g)].map((m) => m[1].trim());
/* Two steps, because the helpers take the id as an argument. Every query reads either `who.id` directly or
 * the parameter the helpers are handed - and every call site hands them `who.id`. One hallucinated uuid
 * reaching either place is the whole bug class this is here to keep out. */
check('every user_id in every query comes from the credential or from the parameter',
  userIdInterps.length > 0 && userIdInterps.every((v) => v === 'who.id' || v === 'userId'),
  userIdInterps.join(', '));
const helperCalls = [...route.matchAll(/(function\s+)?\b(skillsOf|workerSeen|stampWorker)\(sql, ([^),]+)/g)]
  .filter((m) => !m[1])   // the definitions match the same shape; only the CALLS are the invariant
  .map((m) => m[3].trim());
check('and every call that passes one passes who.id',
  helperCalls.length > 0 && helperCalls.every((v) => v === 'who.id'), helperCalls.join(', '));
check('and nothing reads a user id out of the request',
  !/body\.(userId|user_id)|query\.(userId|user_id)/.test(route));
check('the queue is filtered by owner on the worker side as well',
  /from run_queue[\s\S]{0,120}user_id = \$\{who\.id\}/.test(route)
  && /update run_queue[\s\S]{0,200}user_id = \$\{who\.id\}/.test(route));
check('a notification gets 202 and no body', /startsWith\('notifications\/'\)[\s\S]{0,80}202/.test(route));
/* The unauthenticated info document runs before authentication, so every other GET has to be excluded by
 * name - and one that is not is answered with a document about the server rather than an error. `?pending`
 * fell into it and the in-app banner silently never appeared, which is what a route that swallows unknown
 * queries looks like from the outside: fine. */
check('the info document does not swallow the other GETs',
  /const aGetForSomethingElse = req\.query && \(req\.query\.worker \|\| req\.query\.pending\)/.test(route));
const getQueries = [...route.matchAll(/req\.method === 'GET' && req\.query && req\.query\.(\w+)/g)]
  .map((m) => m[1]);
check('and every GET query it does have is one of them',
  getQueries.length > 0 && getQueries.every((q) => /aGetForSomethingElse/.test(route)
    && new RegExp(`req\\.query\\.${q}\\b`).test(route.slice(0, route.indexOf('aGetForSomethingElse') + 200))),
  getQueries.join(','));
/* tools/list is FIXED now. It used to append one tool per skill, so the list — and the tokens it costs in
 * every request, and the permission dialog somebody reads — grew with the library. */
check('tools/list does not grow with the library',
  !/for \(const \[name, entry\] of tableOf\(skills\)\)/.test(route)
    && /RUN_STATUS_TOOL, RUN_TOOL,/.test(route));
/* skillsOf() renames client_id to `id` on the way out, and the dispatch has to read the name it is given.
 * Reading `client_id` found nothing, ever, and the answer looked exactly like a deleted skill. */
check('and a skill is run through one tool, by the id field skillsOf actually returns',
  /name: 'mouseflow_run'/.test(route) && /flow\.id === wanted/.test(route)
    && /skills\.push\(\{\s*\n\s*id: row\.client_id,/.test(route));
/* Two skills may legally share a name; picking one of them silently would run the wrong errand. */
check('an ambiguous name is refused rather than guessed at',
  /skills are called "\$\{wanted\}"/.test(route));
/* With the per-skill schema gone, the listing is the only place a caller can learn what to pass. */
check('and the listing names each skill’s inputs, since the schema no longer does',
  /takes: \$\{asks\.join\(', '\)\}/.test(route));
/* The row still records the SKILL's tool name: "already busy on mouseflow_run" would name no errand. */
/* `args` is a const, and the first version of this dispatch assigned to it. `node --check` does not catch
 * that - it is a runtime error - and every check in this group is a regex over source, so it shipped and
 * failed on the first real call with "Assignment to constant variable".
 *
 * This guard catches the exact class and nothing more. The honest note is that api/mcp.js has no executable
 * coverage at all: it needs a database and a signed-in caller, so the suite reads it rather than runs it.
 * That is the actual gap, and a regex is not a fix for it. */
check('the dispatch does not assign to the const it was handed',
  !/\n\s*args = /.test(route.slice(
    route.indexOf('if (asked !== RUN_TOOL.name)'),
    route.indexOf('async function queueAndWait'),
  )));

check('the queue row still says which errand is running',
  /toolName: entry\.structure\.toolName/.test(route));
check('an unstamped row is not offered as a tool', /if \(role !== 'skill'\) \{ unstamped\+\+; continue; \}/.test(route));
check('and a call with no worker listening is refused rather than left to hang',
  /No machine has ever asked this account for work/.test(route));
group('a goal can be carried out by an agent with no worker behind it');
{
  /* The loop itself is driven and tested in api/test-step.mjs, which needs neither a database nor a key.
   * What can only be checked here is the ROUTE around it: that the state goes to the row rather than to
   * this function's memory, that a picture never lands in the queue, and that the machine is told to stop
   * when the job it is holding has been cancelled. */
  check('the endpoint exists and takes one turn per request',
    /if \(action === 'step'\)/.test(route) && /await advance\(\{ loop, shot: body\.shot/.test(route));
  check('the loop lives in the row, not in the instance',
    /update run_queue set loop = \$\{JSON\.stringify\(out\.loop\)\}/.test(route));
  check('and is cleared when the run ends, so no queue row keeps a conversation',
    (route.match(/loop = null/g) || []).length >= 2);
  check('every step moves the claim on, so staleness means "not heard from"',
    /loop = \$\{JSON\.stringify\(out\.loop\)\}, claimed_at = now\(\)/.test(route));
  check('a job cancelled while it ran tells the machine to stop rather than to carry on',
    /job\.state !== 'claimed'[\s\S]{0,1200}done: true, stop: job\.state/.test(route));
  /* Observed on a real run: cancelling left 28KB of conversation in the row, because the stop path
   * answered the machine and returned before tidying. A row that is over keeps nothing. */
  check('and clears the conversation on the way out, not only when a run finishes',
    /await sql`update run_queue set loop = null where id = \$\{id\}/.test(route));
  /* And a run stopped part-way is still work that happened on somebody's computer. The worker path always
   * logged it; this one used to let a cancelled run vanish from the Hours screen entirely. */
  /* THIS ONE COST A LIVE RUN. `const logRun = …` was declared after the branch that calls it, so cancelling
   * a run answered the machine with a 500 instead of "stop", and the agent abandoned the job. `node --check`
   * does not catch a temporal dead zone - it is a runtime error - and every check here is a regex over
   * source, which is the standing gap this file already admits to. This is the narrowest guard for the
   * class: inside the step route, a helper must be declared before anything calls it. */
  {
    const step = route.slice(route.indexOf("if (action === 'step')"), route.indexOf("if (action === 'report')"));
    const helpers = [...step.matchAll(/const (\w+) = async/g)].map((m) => m[1]);
    const early = helpers.filter((name) => {
      const declared = step.indexOf(`const ${name} = async`);
      const called = step.indexOf(`${name}(`);
      return called >= 0 && called < declared;
    });
    check('every helper in the step route is declared before it is called',
      helpers.length > 0 && early.length === 0, early.join(', '));
  }
  check('a stopped run is logged rather than dropped',
    /await logRun\(job\.loop, 'stopped'/.test(route));
  check('and there is ONE writer for the account log, so the two paths cannot drift',
    (route.match(/insert into user_run/g) || []).length === 1);
  /* The queue id is already prefixed. `q_ + job.id` wrote q_q_… into the log, which reads as a typo and
   * would break any join somebody writes against it later. */
  check('the run is logged under the queue id, not a second prefix of it',
    !/\$\{'q_' \+ job\.id\}/.test(route));
  check('the goal comes from the one implementation of what a parameter does',
    /from '\.\.\/extension\/skills\.js'/.test(route) && /fillGoal\(skill, args\)/.test(route));
  check('and a missing parameter fails the job instead of running a sentence with a hole in it',
    /const missing = missingParams\(skill, args\)/.test(route));
  check('the model is resolved once per run, not per step',
    /startLoop\(\{ goal, model, success: payload\.success \|\| null \}\)/.test(route)
    && /settings\['model\.desktop'\]/.test(route));
  check('the run reaches the account log like any other',
    /insert into user_run/.test(route));
  /* claimed_at is moved on by every step so that staleness means "not heard from". Using it as the start
   * time made a three-minute run read as eleven seconds, and the Hours screen is built on these stamps. */
  check('and dates it from when the run began, not from its last step',
    /\$\{state\.startedAt \|\| job\.claimed_at \|\| null\}/.test(route));
  check('only a claimer that says it can step is given a goal',
    /req\.body\.steps === true/.test(route) && /\$\{claimerSteps\}/.test(route));

  /* The column is `loop` because `state` was taken - by this table's own queued/claimed/done. Naming it
   * `state`, which is what the plan said, would have been two meanings on one row. */
  const at = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const migration = at('../db/010_run_queue_loop.sql');
  check('the column is jsonb and is not called state',
    /add column if not exists loop jsonb/.test(migration) && !/add column if not exists state /.test(migration));
  check('and the queue still has its own state column, untouched',
    /state {8}text {8}not null default 'queued'/.test(at('../db/007_run_queue.sql')));
}

check('the metadata document names an authorisation server',
  /authorization_servers: \[origin\]/.test(readFileSync(fileURLToPath(new URL('../api/well-known.js', import.meta.url)), 'utf8')));
const vercel = JSON.parse(readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8'));
check('and it is routed, so the 401 does not point at the single-page app',
  vercel.rewrites.some((r) => r.source === '/.well-known/oauth-protected-resource'),
  JSON.stringify(vercel.rewrites.map((r) => r.source)));

group('OAuth: the connector signs in as a person, not as an installation');
const oauth = readFileSync(fileURLToPath(new URL('../api/oauth.js', import.meta.url)), 'utf8');
check('only a SESSION may authorise — a token cannot consent on somebody\'s behalf',
  /who\.via !== 'session'[\s\S]{0,40}who = null/.test(oauth));
check('PKCE is required, and S256 only',
  /method !== 'S256'/.test(oauth) && !/'plain'/.test(oauth));
check('the verifier is checked against the stored challenge',
  /createHash\('sha256'\)\.update\(verifier\)\.digest\('base64url'\)/.test(oauth));
check('and compared in constant time', /timingSafeEqual/.test(oauth) && /sameSecret\(computed/.test(oauth));
check('a redirect_uri must match one that was registered, exactly',
  /const registered = \(client, uri\)[\s\S]{0,200}known === uri/.test(oauth));
check('an unknown client or redirect is NOT redirected back to',
  /if \(!client\) return res\.status\(400\)/.test(oauth)
  && /if \(!registered\(client, redirectUri\ature?\)\)|if \(!registered\(client, redirectUri\)\)/.test(oauth));
check('a code is burnt before anything is checked against it',
  /used_at = now\(\)[\s\S]{0,120}returning code_hash[\s\S]{0,200}expires_at/.test(oauth));
check('refresh tokens rotate', /update oauth_token set revoked_at = now\(\) where token_hash = \$\{row\.token_hash\}/.test(oauth));
check('tokens are stored hashed, never in the clear',
  /hashToken\(access\)/.test(oauth) && /hashToken\(refresh\)/.test(oauth));
check('revoking a grant takes every token, not just the access one',
  /update oauth_token set revoked_at = now\(\)[\s\S]{0,120}client_id = \$\{clientId\}/.test(oauth));
const session = readFileSync(fileURLToPath(new URL('../api/_session.js', import.meta.url)), 'utf8');
check('an OAuth token identifies a caller everywhere, not only in /api/mcp',
  /from oauth_token/.test(session) && /via: 'oauth'/.test(session));
check('and an expired one is nobody', /expires_at[\s\S]{0,80}< Date\.now\(\)\) return null/.test(session));
const wk = readFileSync(fileURLToPath(new URL('../api/well-known.js', import.meta.url)), 'utf8');
check('the authorisation server is advertised now that it exists',
  /authorization_servers: \[origin\]/.test(wk) && /authorization_endpoint/.test(wk));
check('and both documents are routed',
  vercel.rewrites.some((r) => r.source === '/.well-known/oauth-authorization-server'),
  JSON.stringify(vercel.rewrites.map((r) => r.source)));
const provider = readFileSync(fileURLToPath(new URL('../web/src/shell/AccountProvider.tsx', import.meta.url)), 'utf8');
check('a sign-in is sent back only to the consent page or to a listed page of this app',
  /asked\.startsWith\('\/api\/oauth\?'\)\) return asked;/.test(provider)
  && /LANDINGS\.includes\(asked\) \? asked : null/.test(provider));

group('one derivation, three readers');
const shim = readFileSync(fileURLToPath(new URL('../web/src/lib/skill-schema.ts', import.meta.url)), 'utf8');
check('the web app reads the module beside the API rather than its own copy',
  /from '\.\.\/\.\.\/\.\.\/api\/_skill-schema\.mjs'/.test(shim));
check('and the MCP bridge reads the same file',
  /_skill-schema\.mjs/.test(readFileSync(fileURLToPath(new URL('shared.mjs', import.meta.url)), 'utf8')));
check('vite is told it may reach outside web/, or dev would refuse to serve it',
  /fs: \{ allow: \['\.\.'\] \}/.test(readFileSync(fileURLToPath(new URL('../web/vite.config.ts', import.meta.url)), 'utf8')));

/* ------------------------------------------------------------------------------- what people are told
 *
 * The product page at /mcp, the address on the Connections panel and this server all describe the same
 * thing, and the failure mode when they drift is the one this repository has already shipped twice: an
 * instruction pointing at something that is not there. So the page's tool table is checked against the
 * server's, in both directions - nothing offered goes undescribed, and nothing described is unoffered. */

group('what the app tells people about MCP');
const facts = readFileSync(fileURLToPath(new URL('../web/src/features/mcp/facts.ts', import.meta.url)), 'utf8');
const mcpRoute = readFileSync(fileURLToPath(new URL('../api/mcp.js', import.meta.url)), 'utf8');
const named = (text) => new Set([...text.matchAll(/name: '(mouseflow_[a-z_]+)'/g)].map((m) => m[1]));
const served = named(mcpRoute);
const described = named(facts);
const missing = [...served].filter((n) => !described.has(n));
const invented = [...described].filter((n) => !served.has(n));
check('every tool the server offers is described on the page', missing.length === 0, missing.join(', '));
check('and nothing is described that the server does not offer', invented.length === 0, invented.join(', '));
check('ten of them, so a count in prose can be trusted', served.size === 10, String(served.size));
check('and the page no longer promises one tool per skill',
  !/plus one for each skill/.test(readFileSync(fileURLToPath(new URL('../web/src/features/mcp/McpView.tsx', import.meta.url)), 'utf8')));
check('the page names the endpoint the server actually answers on',
  /const MCP_PATH = '\/api\/mcp'/.test(facts));
check('and builds the address from the origin it is served from, not a constant',
  /location\.origin/.test(facts));

const connections = readFileSync(
  fileURLToPath(new URL('../web/src/shell/settings/ConnectionsScreen.tsx', import.meta.url)), 'utf8');
check('the Connections panel shows the address from that one file',
  /from '@\/features\/mcp\/facts'/.test(connections) && /mcpUrl\(\)/.test(connections));
const view = readFileSync(
  fileURLToPath(new URL('../web/src/features/mcp/McpView.tsx', import.meta.url)), 'utf8');
check('and so does the page it links to', /from '\.\/facts'/.test(view));
const main = readFileSync(fileURLToPath(new URL('../web/src/main.tsx', import.meta.url)), 'utf8');
check('/mcp is a route', /path: '\/mcp'/.test(main));
const account = readFileSync(
  fileURLToPath(new URL('../web/src/shell/AccountProvider.tsx', import.meta.url)), 'utf8');
check('and it is readable with no account, or it is a door that opens from inside',
  /PUBLIC_PATHS = \['\/mcp'\]/.test(account) && /isPublicPath\(location\.pathname\)/.test(account));

/* ------------------------------------------------------------------------------- teams
 *
 * Two rules are worth a test rather than a careful reading, because both are the kind that stay true right
 * up until somebody edits the file next to them:
 *
 *   who may count whose work - one derivation, in api/_team-scope.js, imported by both endpoints that
 *     turn a team id into a permission. A second copy would be a second place for it to be right.
 *   what an invitation is worth - a deep link, never a token, so a forwarded message hands nobody a seat.
 */

group('teams are a module, and the dashboard can be scoped to one');
/* CRLF folded to LF on the way in. Every pattern below that spans a line break has a newline in it, and a
   Windows checkout stores these files with a carriage return before that newline - so three checks here
   failed on Windows while the source they describe was perfectly correct. Normalised in the one place a
   file is read, so no individual assertion has to think about it. */
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  .replace(/\r\n/g, '\n');
const mainTsx = read('../web/src/main.tsx');
const sidebar = read('../web/src/shell/AppSidebar.tsx');
const settings = read('../web/src/shell/SettingsDialog.tsx');
const insights = read('../api/insights.js');
const teamApi = read('../api/team.js');
const scopeSrc = read('../api/_team-scope.js');

check('/team is a route of its own', /path: '\/team'/.test(mainTsx));
check('and it is in the sidebar, not buried in a dialog', /to: '\/team'/.test(sidebar));
check('with Gallery last, since it is the only one that is not your own work',
  [...sidebar.matchAll(/to: '(\/[a-z]+)'/g)].map((m) => m[1]).join() === '/record,/create,/skills,/dashboard,/team,/gallery',
  [...sidebar.matchAll(/to: '(\/[a-z]+)'/g)].map((m) => m[1]).join());
check('the settings dialog no longer keeps a second copy of it',
  !/TeamScreen/.test(settings) && !existsSync(fileURLToPath(new URL('../web/src/shell/settings/TeamScreen.tsx', import.meta.url))));

check('one derivation of who may see whose work: the team API imports it',
  /from '\.\/_team-scope\.js'/.test(teamApi) && !/^async function roleOf/m.test(teamApi));
check('and so does the dashboard endpoint', /from '\.\/_team-scope\.js'/.test(insights));
check('the team scope is refused to a member by name, not silently answered',
  /status: 403/.test(scopeSrc) && /Only an owner or an admin/.test(scopeSrc));
check('and a team the caller is not in is a 404, which does not confirm it exists',
  /if \(!role\) return \{ error: \{ status: 404/.test(scopeSrc));

check('every count is scoped to the set of accounts, never to one hard-wired id',
  !/\$\{userId\}/.test(insights) && /any\(\$\{ids\}::uuid\[\]\)/.test(insights));
check('a run is matched against its OWN owner\'s flows, not the caller\'s',
  /join user_flow f on f\.user_id = r\.user_id/.test(insights));
const dash = read('../web/src/features/insights/InsightsView.tsx');
check('and a personal request still sends no team, so an old bookmark asks the old question',
  /scope\.kind === 'team'\s*\n?\s*\? `&team=/.test(dash));
check('one member can be picked out of a team, and it travels in the address',
  /&person=\$\{encodeURIComponent\(scope\.person\)\}/.test(dash));
check('the member id is checked against that team rather than trusted',
  /if \(!ids\.includes\(personId\)\)/.test(scopeSrc));
check('and the roster stays whole while the counting narrows, or the filter is a dead end',
  /memberIds: ids/.test(scopeSrc) && /ids: chosen \? \[chosen\] : ids/.test(scopeSrc));
check('the range presets are Today, 7 days and Custom', /const RANGES = \[7\];/.test(dash));

const teamView = read('../web/src/features/team/TeamView.tsx');
const skillsInsights = read('../web/src/features/insights/InsightsView.tsx');
/* The first column is the tick, added when the list learned to select several teams at once. Named in the
 * template rather than left implicit: the header draws a spacer for it, and a header that forgets is every
 * label one column out. */
/* `md:` because the grid only applies where it fits: below that the row stacks, which is what makes this
 * readable in a narrow window and in the extension's side panel. The template is the same one. */
check('teams are rows, in the anatomy the recordings table already uses',
  /const COLUMNS = 'md:grid-cols-\[1\.5rem_minmax\(11rem,1fr\)/.test(teamView)
  && /border border-stroke\/45/.test(teamView));
check('one grid template for the header and the rows, or the labels sit over nothing',
  (teamView.match(/cn\(COLUMNS|cn\(\s*\n?\s*ROW, COLUMNS/g) || []).length >= 2);
check('opening a team is a panel over the list, not a page away from it',
  /role="dialog"/.test(teamView) && /fixed inset-y-0 end-0/.test(teamView));
check('and it can be closed with Escape, like every other overlay',
  /ev\.key === 'Escape'/.test(teamView));
check('the panel is read when it opens and dropped when it closes, never left stale',
  /setDetail\(null\);\n    void loadDetail\(openId\)/.test(teamView));
check('an owner can rename a team, which the screen has always said they could',
  /async function renameTeam/.test(teamApi) && /update team set name/.test(teamApi)
  && /JSON\.stringify\(\{ name \}\)/.test(teamView));
check('and a rename is told from a role change by what the body carries, not by a mode flag',
  /body && body\.name !== undefined/.test(teamApi));

/* The bug this covers reached production: a `const people` referenced one line above its own declaration,
 * so every request that filtered the dashboard to one person answered 500. It survived a browser check
 * because the dev fixture answers /api/insights itself — the page was exercised, this file was not. It is
 * a pure function now, so the suite can simply run it. */
/* The list was read per screen and per visit: this page and the dashboard's scope picker each had their own
 * fetch, so opening both read it twice and coming back to either read it again - 0.4-0.7s of function boot
 * plus two Neon round trips, spent on a list that had not changed, with "Reading…" on screen throughout. */
group('the team list is read once and kept, not once per visit');
/* `provider` is already read above, so this group uses that one. Every pattern here is single-line, which
 * is why the older raw read is fine for them - see the CRLF note by `read`. */
const teamsLib = read('../web/src/lib/teams.ts');
check('the endpoint has one module for its shapes and its transport',
  /export interface TeamRow/.test(teamsLib) && /export const callTeams/.test(teamsLib));
/* Two error shapes - `{error: "words"}` and `{error: {message}}` - and reading only the first printed
 * "[object Object]" at somebody. Worked out once, where both callers get it. */
check('and the two error shapes are untangled there rather than per caller',
  /typeof said === 'string'/.test(teamsLib) && /nested = /.test(teamsLib));
check('neither screen keeps its own copy of the row any more',
  !/interface TeamRow/.test(teamView) && !/interface MailState/.test(teamView));
check('and neither screen fetches the list itself',
  !/fetch\('\/api\/team'/.test(teamView) && !/fetch\('\/api\/team'/.test(skillsInsights));

check('the provider holds it, and null means not-read rather than empty',
  /teams: TeamRow\[\] \| null;/.test(provider));
/* LAZY: most of the app never mentions a team, so a read on mount would be paid by everybody for two
 * screens. `startedTeams` is a ref because two consumers mounting in one commit would both read a `false`
 * piece of state and both fetch. */
check('it is read on the first screen that asks, not on every page load',
  /const startedTeams = useRef\(false\)/.test(provider)
    && /if \(startedTeams\.current\) return;/.test(provider));
check('and asking is what the hook does, so no screen can read a null nobody is filling',
  /export const useTeams = \(\)/.test(provider)
    && /useEffect\(\(\) => \{ void ensureTeams\(\); \}, \[ensureTeams\]\)/.test(provider));
/* A change re-reads. Nothing else does - a list expiring on a timer would put "Reading…" back for no reason
 * anybody could see. */
check('a change to the list is what re-reads it',
  /refresh: refreshTeams/.test(provider) && /refresh: loadTeams/.test(teamView));
/* The failure that mattered: the old loader set the list to [] and the page then showed "You are not in a
 * team yet" to somebody with four of them. */
check('and a read that failed says so instead of reporting an empty account',
  /setTeamsProblem\(/.test(provider)
    && !/setTeams\(\[\]\)/.test(provider)
    && /could not be read: \$\{teamsProblem\}/.test(teamView));
/* On the dashboard it stays a silent failure, and that is the right answer for a CONTROL: the page is not
 * broken by a list it does not need to show numbers. */
check('the dashboard still fails silently, because the picker is not the content',
  /const \{ teams: allTeams \} = useTeams\(\)/.test(skillsInsights)
    && /\(allTeams \?\? \[\]\)\.filter/.test(skillsInsights));

group('the dashboard can say whose numbers it is showing');
const { shapeScope } = await import('../api/insights.js');
const roster = new Map([
  ['u1', { name: 'Vic', email: 'v@x.dev' }],
  ['u2', { name: 'Margaryta', email: 'm@x.dev' }],
]);
const members = [{ id: 'u1', role: 'owner' }, { id: 'u2', role: 'admin' }];
const rows = [{ id: 'u1', runs: 4, recordings: 1 }, { id: 'u2', runs: 9, recordings: 3 }];
const whole = shapeScope({
  scope: { kind: 'team', team: { id: 't1', name: 'Ops' }, role: 'owner', members },
  people: roster, rows, callerId: 'u1',
});
check('a whole team names no single person', whole.person === undefined && whole.people.length === 2);
check('and its rows are busiest first', whole.people.map((p) => p.name).join() === 'Margaryta,Vic');
check('each row carries the role from the membership, not from the row',
  whole.people.map((p) => p.role).join() === 'admin,owner');
check('the reader is marked, so the page never has to compare ids itself',
  whole.people.find((p) => p.id === 'u1').you === true
  && whole.people.find((p) => p.id === 'u2').you === false);

const one = shapeScope({
  scope: { kind: 'team', team: { id: 't1', name: 'Ops' }, role: 'owner', person: 'u2', members },
  people: roster, rows, callerId: 'u1',
});
check('filtered to one member, it resolves them to a NAME rather than echoing the id',
  one.person && one.person.id === 'u2' && one.person.name === 'Margaryta' && one.person.you === false);
check('and the roster survives the filter, or the picker has no way back',
  one.people.length === 2);
/* The regression itself: any throw here is the shape of the bug that shipped. */
let threw = null;
try {
  shapeScope({
    scope: { kind: 'team', team: { id: 't1', name: 'Ops' }, role: 'admin', person: 'u9', members },
    people: roster, rows: [], callerId: 'u2',
  });
} catch (err) { threw = err.message; }
check('an unknown person does not throw, it answers with the id and no name', threw === null, threw);

/* The assistant's team scope is the one place in this product where one person's question reads another
 * person's rows, so what it may reach is checked rather than reviewed. */
group('the assistant on a team can count, and cannot read or write');
const chatSrc = read('../api/chat.js');
const listed = (chatSrc.match(/const TEAM_TOOL_NAMES = \[([^\]]*)\]/) || [])[1] || '';
const allowed = [...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
check('it is a whitelist, and these five are on it',
  allowed.length === 5 && ['summarize_time', 'list_skills', 'find_repeated', 'search_runs', 'team_people']
    .every((n) => allowed.includes(n)), allowed.join(', '));
for (const forbidden of ['get_run', 'get_transcript', 'list_recordings', 'remove_steps', 'undo_edit']) {
  check(`${forbidden} is NOT reachable about a colleague`, !allowed.includes(forbidden));
}
check('the recording tools are not even registered in a team scope',
  /if \(ctx\.team\) \{[\s\S]{0,400}?return table;/.test(chatSrc)
  && chatSrc.indexOf('if (ctx.team)') < chatSrc.indexOf('recordingTools({ sql: ctx.sql'));
check('and the chat resolves the team through the same one derivation',
  /from '\.\/_team-scope\.js'/.test(chatSrc) && /scopeFor\(sql, who, text\(body\.team/.test(chatSrc));
check('a filtered panel is told it is reading one person, not the team',
  /filtered to ONE member of the team/.test(chatSrc));

group('an invitation says who sent it, and what to do if it was not for you');
const mail = await import('../api/_mail.js');
const waiting = mail.invitationMail({
  teamName: 'Operations', inviterName: 'Vic', inviterEmail: 'vic@example.dev',
  toEmail: 'newcomer@example.dev', url: 'https://mouseflowapp.vercel.app/team',
  hasAccount: false, role: 'member',
});
const already = mail.invitationMail({
  teamName: 'Operations', inviterName: 'Vic', inviterEmail: 'vic@example.dev',
  toEmail: 'colleague@example.dev', url: 'https://mouseflowapp.vercel.app/team',
  hasAccount: true, role: 'admin',
});
check('it names who did it', /vic@example\.dev/.test(waiting.subject) && /Vic/.test(waiting.text));
check('somebody with no account is told to make one with THAT address',
  /newcomer@example\.dev/.test(waiting.text) && /Create one with this address/.test(waiting.text));
check('and somebody who has one is told they are already in', /you are in/.test(already.text));
check('the envelope and the first line use the same verb',
  waiting.subject.includes('invited you to join') && waiting.text.startsWith('Vic (vic@example.dev) invited you to join'));
check('it says to delete the message if they do not recognise it',
  /delete this email/i.test(waiting.text) && /delete this email/i.test(waiting.html));
check('and that nothing of theirs was opened by it', /nothing of yours was/i.test(waiting.text));

/* The security property of the whole feature: the link is a PLACE, not a key. Two places, because the two
 * readers have different next steps - and neither carries anything that would let the holder of a
 * forwarded message take the seat. */
const linksIn = (mail) => [...mail.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
const waitingLinks = linksIn(waiting);
const alreadyLinks = linksIn(already);
check('somebody who already has an account is sent to the Teams page',
  alreadyLinks.length === 1 && alreadyLinks[0] === 'https://mouseflowapp.vercel.app/team',
  alreadyLinks.join(' '));
check('and somebody who does not is sent to SIGN UP, not to a sign-in wall',
  waitingLinks.length === 1 && waitingLinks[0].startsWith('https://mouseflowapp.vercel.app/sign-up?'),
  waitingLinks.join(' '));
check('carrying where to land and the address it was sent to, and nothing else',
  /next=%2Fteam/.test(waitingLinks[0]) && /email=newcomer%40example\.dev/.test(waitingLinks[0])
  && !/token|code|key|secret|invite=/i.test(waitingLinks[0]), waitingLinks[0]);

/* And the page that link names has to accept where it was told to go. An allowlist, because `next` arrives
 * in a link anybody can write. */
const shared = read('../web/src/features/auth/shared.tsx');
check('sign-up lands only on this app\'s own places, never on an arbitrary path',
  /const LANDINGS = \[/.test(shared) && /LANDINGS\.includes\(asked\)/.test(shared));
check('and /team is one of them, since an invitation names it', /'\/team'/.test(shared));
check('the sign-up page reads that destination rather than always going to Record',
  /nextFrom\(location\.search\)/.test(read('../web/src/features/auth/SignUpView.tsx')));
const wall = read('../web/src/shell/AccountProvider.tsx');
check('signed out sends somebody to the sign-in PAGE, not a card over the page they asked for',
  /location\.replace\(`\/sign-in/.test(wall) && !/SignInWall/.test(wall));
check('carrying where they were trying to get to', /to\.set\('next', location\.pathname\)/.test(wall));
check('and carrying why a Google round trip failed, or nothing ever says',
  /to\.set\('auth', arrived\.auth\)/.test(wall)
  && /authFailure\(location\.search\)/.test(read('../web/src/features/auth/SignInView.tsx')));
/* The reason is deleted from the address by an effect that runs BEFORE the redirect does, so it has to be
 * captured during the first render or it is gone by the time anything can forward it. */
check('the reason is captured before the address is cleaned, not read after',
  /const \[arrived\] = useState\(\(\) => \{/.test(wall)
  && wall.indexOf('const [arrived]') < wall.indexOf("rest.delete('auth')"));
check('the sign-in page offers a way to create an account',
  /\/sign-up/.test(read('../web/src/features/auth/SignInView.tsx')));
check('the row is written before anything is sent, so a lost message costs a conversation, not a seat',
  teamApi.indexOf('insert into team_invite') < teamApi.indexOf('const post = await tellThem'));

check('with no mail configured it refuses rather than throwing, and names the variables',
  /RESEND_API_KEY/.test(String(mail.mailProblem())) && /MAIL_FROM/.test(String(mail.mailProblem())));
const unsent = await mail.sendMail({ to: 'somebody@example.dev', subject: 'x', text: 'y' });
check('and the caller is told why', unsent.sent === false && typeof unsent.why === 'string');
check('the endpoint says so too, before an address is typed', /mail: \{ configured:/.test(teamApi));

group('making a skill lands where the skill will be');
const recordView = read('../web/src/features/record/RecordView.tsx');
const skillsView = read('../web/src/features/skills/SkillsView.tsx');
const wizard = read('../web/src/features/record/SkillWizard.tsx');
check('the Record page hands the recording to /skills rather than opening over itself',
  /to: '\/skills', search: \{ make: rec\.id \}/.test(recordView));
check('and Skills opens the wizard for the id in the address',
  /get\('make'\)/.test(skillsView) && /if \(found\) setWizardFor\(found\)/.test(skillsView));
check('waiting for the recordings to arrive, not reading them once',
  /\}, \[asked, local\.recordings\]\);/.test(skillsView));
check('dropping the parameter once used, so the wizard does not reopen later',
  /searchParams\.delete\('make'\)/.test(skillsView));
check('and saying so when this browser does not have that recording',
  /not in this browser/.test(skillsView));
/* Order on the page, which is a thing source order actually decides here - both blocks are siblings in one
 * container with no ordering CSS. Somebody comes to /skills for the skills they have; the builder for the
 * ones they do not was standing in front of it, and on a 1680x1050 screen the library began below the fold. */
/* The RENDERED headings, not the first mention: both names appear in comments above the code that draws
 * them, and a plain indexOf finds the comment. That is how this check first passed the wrong way round. */
check('the library stands above the builder, not behind it',
  skillsView.indexOf('\n              Your skills\n')
    < skillsView.indexOf('\n              Ready to become a skill\n'));
/* The list reserved six rows of height so that converting a recording could not shift what sat BELOW it.
 * Nothing sits below it now, and with one recording the reserve drew 374px of empty card. */
check('and the builder no longer reserves height for rows that are not there',
  !/minHeight: READY_MIN/.test(skillsView) && !/const READY_MIN/.test(skillsView));

/* The page a person comes to for their skills, made to look and behave like a table of them. */
group('the skills library is a section, sortable, and says how to use a skill');
check('it sits in a card like the block under it, not loose on the page',
  /<section className="mb-4 rounded-xl border-stroke border bg-surface-card p-4">/.test(skillsView));
check('its columns sort, which is the one thing a table of anything has to do',
  /const SORTABLE: \{ key: SortKey; label: string \}\[\]/.test(skillsView)
    && /onClick=\{\(\) => sortBy\(key\)\}/.test(skillsView));
/* A second click on the same column reverses; a first click on a new one starts the way that column reads.
 * The arrow itself moved into components/SortButton.tsx when the two tables stopped keeping a copy each -
 * so the page is checked for USING it, and the arrow is checked where the arrow is. */
check('and the direction is shown rather than left to be guessed',
  /<SortButton[\s\S]{0,400}active=\{sort\.by === key\}[\s\S]{0,80}asc=\{sort\.asc\}/.test(skillsView)
    && /!asc && 'rotate-180'/.test(read('../web/src/components/SortButton.tsx')));
check('names sort numerically, since every one of them ends in a date or a number',
  /numeric: true, sensitivity: 'base'/.test(skillsView));
/* Structure was a phrase assembled per row, so sorting it ordered rows by their own wording. Dropped. */
check('the column whose values were a phrase is gone, and its sort key with it',
  !/label: 'Structure'/.test(skillsView) && !/const events = eventsOf\(flow\)/.test(skillsView));

/* Everything that makes a skill usable BY a model lived behind an unlabelled "..." beside Delete. */
check('the way into an AI system is on the row, in words',
  /Use in AI/.test(skillsView) && /Its tool definition, and a SKILL\.md an agent can be given/.test(skillsView));
check('and arriving there does not land on a second closed box',
  /<details open className=/.test(skillsView));

check('a skill can be renamed, which the account always allowed and the page never offered',
  /const rename = useCallback\(async \(flow: Flow, next: string\)/.test(skillsView));
/* payload.name is written by saveAsGoalSkill; left behind it is the name a restored copy comes back under. */
check('and the payload name moves with it, or the rename undoes itself on the next sync',
  /payload: \{ \.\.\.\(flow\.payload as Record<string, unknown>\), name \}/.test(skillsView));
check('and the person is told the tool name an AI calls changed too',
  /pointed at the old name will need the new one/.test(skillsView));

/* Five rows on a 13" laptop and up to ten on a big monitor: a height in rem alone is the same 316px on a
 * 1440-tall screen as on a 700-tall one. */
check('both lists are one height, and it follows the window',
  /const LIST_HEIGHT = `clamp\(\$\{rowsToRem\(5\)\}rem, 32vh, \$\{rowsToRem\(10\)\}rem\)`/.test(skillsView));
check('and the row height it is built from was measured, not chosen',
  /58\.3px measured/.test(skillsView));
check('anything past that scrolls inside its own block',
  (skillsView.match(/overflow-y-auto/g) || []).length === 2);
/* With a scroller everything is reachable, so the truncation - and its apology - had nothing left to do. */
check('and the "N older ones are on the Record page" truncation is gone',
  !/older\{' '\}/.test(skillsView) && !/const READY_SHOWN/.test(skillsView));

/* Publishing had no opposite for as long as it existed. The app said "the gallery listing stays until you
 * withdraw it" on the screen where a skill is deleted, and there was no control anywhere - the only way out
 * was a DELETE typed into a browser console against an endpoint nobody was told about. */
group('a published skill can be taken back');
const apiTs = read('../web/src/lib/api.ts');
check('the app can ask the endpoint that has existed all along',
  /export const galleryWithdraw/.test(apiTs)
    && /method: 'DELETE'/.test(apiTs));
/* One status for two cases - "not your skill" and "already withdrawn" - and from the browser they cannot be
 * told apart. Somebody pressing Withdraw on a listing that is already gone wants the same outcome either
 * way, and wants the app's record of it cleared most of all. */
check('and a listing that is already gone is not reported as a failure',
  /err\.status === 404\) return \{ ok: true, alreadyGone: true \}/.test(apiTs));

check('the control is beside Republish, not filed under the ellipsis',
  /\{listing && \([\s\S]{0,200}label="Withdraw"/.test(skillsView)
    && skillsView.indexOf("{listing ? 'Republish' : 'Publish'}")
      < skillsView.indexOf('label="Withdraw"'));
/* Two presses, because the listing goes for everybody on the second one - and the SAME armed flag as Delete
 * would cock both buttons of the row at once. */
check('it asks twice, on a flag of its own',
  /armed=\{armedWithdraw === flow\.id\}/.test(skillsView)
    && /const \[armedWithdraw, setArmedWithdraw\]/.test(skillsView));
/* `publishedAs` in the payload is the ONLY thing the app reads to know a skill is published: gallery_skill
 * has no back-reference to the flow. Withdraw the listing and leave that behind, and the row goes on saying
 * Published and offering to withdraw something that is not there. */
check('and the app forgets it was published, or the row keeps claiming it is',
  /delete payload\.publishedAs;/.test(skillsView) && /delete payload\.publishedAt;/.test(skillsView));
check('cleared even when the gallery said it was already gone - especially then',
  /alreadyGone\s*\n?\s*\?/.test(skillsView));
/* And the sentence that used to point nowhere now points at the button. */
check('the delete warning names where the listing is taken down',
  /Withdraw on this[\s\S]{0,40}row is what takes that down/.test(skillsView));

/* The mock has to be able to say no, or the second press was never a state anybody could look at. */
const mockApi = read('../web/src/dev/mock-api.ts');
check('the preview models a withdraw instead of waving it through',
  /if \(req\.method === 'DELETE'\)/.test(mockApi)
    && /withdrawnListings\.add\(id\)/.test(mockApi)
    && /not your skill, or already withdrawn/.test(mockApi));
check('and a withdrawn listing leaves the list, as the real query makes it',
  /const live = GALLERY\.filter\(\(s\) => !withdrawnListings\.has\(s\.id\)\)/.test(mockApi));
check('and one fixture is published, so the published half of the row exists at all',
  /publishedAs: 'sk_dev_1'/.test(mockApi));

/* An empty array is what `flows` is before the account has answered, so every branch asking "are there no
 * skills?" was answering before it had been told. For a second and a half the page opened with the whole
 * empty-state foundry and "Nothing on your account yet" above a list of five recordings. */
group('the page does not say the account is empty before it has read it');
/* The flag was `loaded` when this was written and is `known` now - a wider question, "there is something
 * worth drawing", which a kept answer satisfies too. The strict one still exists and still belongs to
 * whoever COMPARES the two sides; the group below is about that difference. */
check('it takes the flag that separates "empty" from "not yet told"',
  /const \{ flows, known, readFailed, reload \} = useAccount\(\);/.test(skillsView));
check('the foundry picks neither size until then',
  /\{!known \? null : skills\.length === 0 \? \(/.test(skillsView));
check('and the library says it is reading, rather than counting nothing',
  /\{!known \? \([\s\S]{0,400}Reading…/.test(skillsView));
/* A read that FAILED leaves `loaded` false for good, so "Reading…" would sit there for ever describing
 * something the app has given up on. AccountProvider keeps `readFailed` for exactly this, and says so. */
check('and a read that failed says that instead of reading for ever',
  /readFailed[\s\S]{0,120}could not be read just now/.test(skillsView));

/* Record opened with everything on it and Skills sat on "Reading…", and the reason was not the query:
 * recordings are on disk and read synchronously, while the account's answer lived in React state only, so
 * every reload started from nothing. It then waited out TWO cold functions end to end, because /api/sync was
 * not started until whoAmI had come back. Measured: 0.42-0.67s for one warm function, 0.22 MB of payload for
 * the account being complained about - so neither the size nor the query was ever the cost. */
group('the account is read in parallel and remembered between loads');
const keptLib = read('../web/src/lib/kept.ts');

check('the two boot reads are started together, not one after the other',
  /const syncing = pull\(\)\.then/.test(provider)
    && provider.indexOf('const syncing = pull()') < provider.indexOf('const me = await whoAmI()'));
/* The order things are JUDGED in must not change: the wall asks whoAmI, and a 401 for somebody with no
 * session is the expected answer to a question we should not have asked - not a failed read. */
check('and a visitor with no session is not reported as a failed read',
  /if \(!me\) return;/.test(provider)
    && provider.indexOf('if (!me) return;') < provider.indexOf('else setReadFailed(true)'));

check('what the account last answered is kept, and whose it was is part of the record',
  /export function keep<T>\(key: string, forAccount: string \| null/.test(keptLib)
    && /parsed\.forAccount !== forAccount\) return null/.test(keptLib));
/* Not a nicety: the recordings store is not keyed by person, and one person's skills handed to the next to
 * sign in on the same machine is a leak rather than a slow page. */
check('a kept copy belonging to somebody else is not read',
  /kept<\{ flows: Flow\[\]; runs: Run\[\] \}>\(KEPT_ACCOUNT, id\)/.test(provider)
    && /const before = onDisk\.account\(me\.id\)/.test(provider));
check('and signing out drops it rather than leaving it for the next person',
  /forget\(KEPT_ACCOUNT\)/.test(provider) && /forget\(KEPT_TEAMS\)/.test(provider));

/* The distinction the whole thing turns on. `loaded` is "the account answered THIS session" and is what the
 * reconciliation asks - the note there describes it concluding that every local recording had been deleted
 * elsewhere, off an empty `flows` on the first render. A kept answer must never be able to trigger that. */
check('rendering asks a different question from comparing',
  /known: boolean;/.test(provider)
    && /const \{ flows, known, readFailed, reload \} = useAccount\(\)/.test(skillsView));
check('and the kept copy does not make the account look answered',
  /setKnown\(true\);\n      \}/.test(provider)
    && !/setLoaded\(true\);\n        setKnown/.test(provider));
check('so the reconciliation still waits for the real answer',
  /const \{ flows, loaded, reload \} = useAccount\(\)/.test(read('../web/src/features/record/Reconciler.tsx'))
    && /if \(!loaded\) return;/.test(read('../web/src/features/record/Reconciler.tsx')));
/* One place applies a sync answer now. Two copies of that drifted once already - the file's opening note is
 * about three separate reads of /api/sync that could and did disagree. */
check('and one place applies an answer, whether it came at boot or later',
  /const applySync = useCallback/.test(provider)
    && /applySync\(await pull\(\)\)/.test(provider)
    && /if \(answer\) applySync\(answer\.body\)/.test(provider));

/* The same treatment on the other table, because two tables of the same product sorting differently - or
 * one of them not sorting at all - is a difference somebody has to learn for no reason. */
group('and the recordings table sorts the same way');
const recTable = read('../web/src/features/record/RecordingsTable.tsx');
check('its columns are buttons too',
  /const SORTABLE: \{ key: SortKey; label: string; title\?: string \}\[\]/.test(recTable)
    && /onClick=\{\(\) => sortBy\(key\)\}/.test(recTable));
check('and it shows which column is deciding, and which way',
  /<SortButton[\s\S]{0,240}active=\{sort\.by === key\}[\s\S]{0,80}asc=\{sort\.asc\}/.test(recTable)
    && /!asc && 'rotate-180'/.test(read('../web/src/components/SortButton.tsx')));
/* A sparkline has nothing alphabetical about it; what somebody reads off that column is how much is in the
 * recording, so that is what it sorts on. */
check('the sparkline column sorts on how much was recorded',
  /case 'size':\s*\n\s*return a\.events\.length - b\.events\.length;/.test(recTable));
check('names sort numerically, since every default name is a date and a time',
  /numeric: true, sensitivity: 'base'/.test(recTable));
check('and newest-first is still where it starts',
  /useState<\{ by: SortKey; asc: boolean \}>\(\{ by: 'created', asc: false \}\)/.test(recTable));
/* The status is read from the account, not from a flag on the row, so the comparator has to be too. */
check('status sorts on whether a skill exists, read the same way the cell reads it',
  /Number\(!!hasSkill\?\.\(a\)\) - Number\(!!hasSkill\?\.\(b\)\)/.test(recTable)
    && /\[state\.recordings, term, sort, hasSkill\]/.test(recTable));

group('a skill can be handed to an agent as a file');
const skillMd = await import('../api/_skill-md.mjs');
const MD_STRUCTURE = {
  kind: 'created',
  toolName: 'reply_wf1',
  runsHow: 'the local agent, which re-runs the goal',
  goalTemplate: 'In Outlook, do this:\n1. Click "New mail".\n2. Type {{subject}} into "Subject".',
  description: 'Carries out: In Outlook, do this:',
  params: [{ name: 'subject', type: 'quoted', example: null }],
  origins: ['Outlook (PWA) - Mail'],
};
const md = skillMd.skillMarkdown(MD_STRUCTURE, { name: 'Reply that the invoice is approved' });
check('it opens with frontmatter an agent can read',
  md.startsWith('---\nname: reply-that-the-invoice-is-approved\ndescription: '));
/* A description is written by a model or a person, so it can hold a colon, a quote or a newline - each of
 * which breaks a YAML block in its own way. */
check('and the description is quoted, so a colon in it cannot break the block',
  skillMd.skillMarkdown({ ...MD_STRUCTURE, description: "it's here: really" }, { name: 'x' })
    .includes("description: 'it''s here: really'"));
check('it names the tool to call, which is the only thing that makes anything happen',
  /Call the MCP tool `reply_wf1` with `subject`\./.test(md));
/* The rule the whole file rests on: an agent with computer-use handed a list of clicks and no tool will try
 * to carry them out itself, on a real machine, against coordinates from a different screen. */
check('and it says to stop rather than attempt the steps another way',
  /If that tool is not available, stop and tell the user/.test(md)
    && !/without MouseFlow/i.test(md));
check('the prerequisites are a table of things to go and check',
  /\| \*\*The MouseFlow agent, running\*\* \|/.test(md)
    && /\| Applications \| Outlook \(PWA\) - Mail/.test(md));
/* A goal skill needs the worker as well as the agent; a recorded one does not. Saying it either way would
 * send somebody to install something they do not need, or leave a run queued with nobody claiming it. */
check('a goal skill asks for the worker and a recorded one does not',
  /The MouseFlow worker, running/.test(md)
    && !/worker, running/.test(skillMd.skillMarkdown({ ...MD_STRUCTURE, kind: 'recorded' }, { name: 'x' })));
check('a required input is marked required, and the file forbids inventing one',
  /\| `subject` \| text \| yes \|/.test(md) && /Never invent a value/.test(md));
check('the file is named after the skill', skillMd.skillFileName('Reply that it is approved')
  === 'reply-that-it-is-approved-SKILL.md');
/* The row on the account is the authority; this browser holds a copy that can be a sync behind. */
check('the route builds it from the row rather than from the browser’s copy',
  /where user_id = \$\{who\.id\} and client_id = \$\{id\}/.test(read('../api/skill-md.js')));
check('and a flow that is not the caller’s is a 404, not a 403',
  /no skill with that id on this account/.test(read('../api/skill-md.js')));
check('the model is optional — no key still produces the file',
  /let written = \{\};/.test(read('../api/skill-md.js')));
check('and the panel says when the description was derived rather than written',
  /Its description was derived rather than written/.test(skillsView));

/* The other bargain: a file the agent reading it carries out ITSELF, with its own browser tools, on a
 * machine MouseFlow is not on. Same steps, everything round them different. */
group('a skill that runs where MouseFlow is not');
const EXT_FLOW = {
  name: 'Reply', source: 'web', kind: 'created',
  payload: {
    kind: 'created', goalTemplate: 'In Outlook, do this:\n1. Click "Reply".',
    events: [
      { action: 'Focus', url: 'https://outlook.office.com/mail/inbox' },
      { action: 'Focus', url: 'https://outlook.office.com/mail/id/AAQk?token=secret#frag' },
      { action: 'Focus', url: 'https://outlook.office.com/mail/inbox' },
      { action: 'Focus', url: 'file:///Users/somebody/notes.txt' },
    ],
  },
};
/* A SKILL.md gets downloaded, committed, forwarded and pasted into an agent. A query string is where a
 * session token, a one-time link or a search somebody typed lives. */
check('the addresses come back with query and fragment dropped',
  skillMd.urlTrail(EXT_FLOW.payload).join(' ')
    === 'https://outlook.office.com/mail/inbox https://outlook.office.com/mail/id/AAQk',
  skillMd.urlTrail(EXT_FLOW.payload).join(' '));
check('and a non-web address is not one an agent can open, so it is not listed',
  !skillMd.urlTrail(EXT_FLOW.payload).some((u) => u.startsWith('file:')));

/* The gate is "do we know the addresses", not "did this look like a browser": a browser recording with no
 * urls would have to begin "find the window called …", which a cloud agent cannot do. */
check('a recording with addresses can be exported this way', skillMd.portability(EXT_FLOW).ok);
check('one without them cannot',
  skillMd.portability({ source: 'desktop', payload: { events: [] } }).ok === false);

/* THE BUG THIS REPLACES. A skill-goal carries no events of its own - goal, params, and one run's steps as
 * evidence - so reading its own payload answered "no addresses" for every skill ever made, whatever had
 * been recorded. Since that is now the only kind of skill anybody can make, Portable was refused by
 * construction, and the refusal blamed the desktop recorder for something it does do. */
const GOAL_SKILL = {
  source: 'desktop',
  payload: { kind: 'created', goalTemplate: 'send a test email', fromRecording: 'r_1', steps: [] },
};
/* The address rule was written for a REPLAY: a list of clicks with no address cannot be started. A goal
 * skill is not that - the sentence somebody wrote IS the instruction, and requiring a recorded URL demanded
 * evidence this format never produces, which refused the easiest way anybody has to author a skill. */
check('a skill written or dictated as a goal is portable on its own, with or without addresses',
  skillMd.portability(GOAL_SKILL).ok === true
    && skillMd.portability(GOAL_SKILL, ['https://mail.google.com']).ok === true);
check('and the addresses it does know still travel with it',
  skillMd.portability(GOAL_SKILL, ['https://mail.google.com']).urls[0] === 'https://mail.google.com');
check('and it no longer claims the desktop agent cannot write addresses, because it can',
  !/does not write down web addresses/.test(skillMd.portability(GOAL_SKILL).why)
  && !/does not write down web addresses/.test(read('../api/_skill-md.mjs').split('export function portability')[1]));
check('a dictated desktop flow is portable too — it is a goal, not a list of clicks',
  skillMd.portability({ source: 'desktop', payload: { kind: 'created', fromRun: 'dr_1' } }).ok === true);
check('only a recorded replay is refused, and it is told the goal path works',
  skillMd.portability({ source: 'desktop', payload: { kind: 'recorded', events: [] } }).ok === false
    && /written or dictated as a goal can be exported/.test(
      skillMd.portability({ source: 'desktop', payload: { kind: 'recorded', events: [] } }).why));
/* A dictated goal names where it happens the way a person does — "my gmail" — and a browser agent needs an
 * address. Nothing recorded one, because nothing was recorded. So it is read off the goal, and the file has
 * to say that is where it came from: an inferred address shown as a recorded one is a lie that reads as a
 * fact. */
const INFERRED = skillMd.skillMarkdown(
  { kind: 'created', goalTemplate: 'send a test email from my gmail', params: [], origins: [] },
  { name: 'send a test email' },
  {},
  { portable: true, urls: [], inferredUrls: ['https://mail.google.com'], desktopOnly: true },
);
check('an address read off the goal is listed, and labelled as read rather than observed',
  /- https:\/\/mail\.google\.com/.test(INFERRED)
  && /Read off the goal, not recorded/.test(INFERRED));
check('a goal that needs a desktop says so in the file instead of being refused at the door',
  /This may need a desktop, not a browser/.test(INFERRED)
  && /do not improvise a web equivalent/.test(INFERRED));
check('and recorded addresses are never presented as inferred ones',
  !/Read off the goal/.test(skillMd.skillMarkdown(
    { kind: 'created', goalTemplate: 'x', params: [], origins: [] },
    { name: 'x' }, {},
    { portable: true, urls: ['https://example.com'], inferredUrls: ['https://guess.example'] },
  )));

/* The notes somebody writes by hand are the only channel for knowledge the recording could not have -
 * "finish with Send, not Save". The wizard merges them into the goal so the runner executes them, and the
 * exporter dropped every line that was not numbered. The same skill then did DIFFERENT WORK depending on
 * which agent carried it out, and nothing said so. */
const WITH_NOTES = skillMd.skillMarkdown(
  {
    kind: 'created',
    goalTemplate: 'In Gmail, do this:\n1. Click "Compose".\n\nAlso:\nFinish by pressing Send, not Save.',
    params: [], origins: [],
  },
  { name: 'Send', source: 'desktop' }, {}, { portable: true, urls: [] },
);
check('what somebody added in their own words survives the export',
  /Finish by pressing Send, not Save/.test(WITH_NOTES));
check('and it stays with the steps it modifies, not in a section of its own',
  WITH_NOTES.indexOf('Finish by pressing Send') > WITH_NOTES.indexOf('1. Click "Compose"'));

check('and the route reads the source recording rather than guessing',
  /where user_id = \$\{who\.id\} and client_id = \$\{cameFrom\}/.test(read('../api/skill-md.js'))
  && /portability\(flow, trail\)/.test(read('../api/skill-md.js')));

const portableMd = skillMd.skillMarkdown(MD_STRUCTURE, { name: 'Reply' }, {},
  { portable: true, urls: skillMd.urlTrail(EXT_FLOW.payload) });
check('the portable file needs no agent, no worker and no connector',
  /\| \*\*No MouseFlow\*\* \|/.test(portableMd)
    && !/The MouseFlow agent, running/.test(portableMd)
    && !/The MouseFlow worker, running/.test(portableMd));
check('it tells the reader to carry the steps out with its own browser tools',
  /Carry out the steps below yourself, with your browser tools\./.test(portableMd));
/* The numbers in a recording came off somebody else's screen. Aiming by them on another machine is the one
 * mistake this file has to forbid outright. */
check('and to aim by name, never by coordinate',
  /Aim by name, never by coordinate/.test(portableMd));
check('it lists where it happens, and says the query was dropped on purpose',
  /## Where it happens/.test(portableMd) && /Query strings were left out on purpose/.test(portableMd));
/* Credentials are the one thing an unattended agent must never touch. */
check('a sign-in wall is a stop, not a thing to solve',
  /do not sign in, and do not handle\s+credentials/.test(portableMd)
    && /never handle credentials/.test(portableMd));
check('nothing in it claims the work happens on the user’s own machine',
  !/own machine|on their machine/.test(portableMd));
/* The steps are the ones the person approved in the wizard, notes and all. Re-deriving a second list would
 * hand somebody a skill that differs from the one they read and agreed to. */
check('the steps are the approved ones, not a second derivation',
  /1\. Click "New mail"\./.test(portableMd));
check('and the route refuses rather than shipping a file with nowhere to start',
  /if \(portable && !portably\.ok\)/.test(read('../api/skill-md.js')));
check('the model is told not to mention MouseFlow in a portable file',
  /Do not mention MouseFlow — it takes no part in running this/.test(read('../api/skill-md.js')));
check('the choice is offered at export, not forked at creation',
  /const \[portable, setPortable\] = useState\(false\)/.test(skillsView)
    && /Through MouseFlow/.test(skillsView) && /'Portable'/.test(skillsView));
/* The dev fixture has to be able to reach BOTH answers or one of them is unreachable without production. */
check('and the dev fixture carries a url with a query on it, so both paths are reachable',
  /token=secret/.test(read('../web/src/dev/mock-api.ts')));

/* An agent skill installs as a FOLDER. Handing over a bare .md means also telling somebody where to put it
 * and what to call the directory; a zip does not. Written by hand rather than pulled in: a zip of text needs
 * no compression, so the whole format is four fixed-layout records and a CRC-32. */
group('and as the folder it actually installs as');
const zipper = await import('../api/_zip.mjs');
/* Checked against the reference implementation of CRC-32, not against itself. */
check('the checksum is the standard one', zipper.crc32(new TextEncoder().encode('123456789')) === 0xcbf43926,
  zipper.crc32(new TextEncoder().encode('123456789')).toString(16));
const archive = zipper.zip([
  { name: 'my-skill', dir: true },
  { name: 'my-skill/SKILL.md', text: '---\nname: my-skill\n---\n\n# Привет\n' },
], new Date('2026-08-24T19:45:00Z'));
check('it writes the four signatures a zip is made of',
  archive[0] === 0x50 && archive[1] === 0x4b && archive[2] === 0x03 && archive[3] === 0x04
    && Buffer.from(archive).includes(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    && Buffer.from(archive).includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])));
/* Read back by a real unzipper rather than by the code that wrote it. A zip writer verified only against
 * itself is a zip writer nobody has opened. */
{
  const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'mf-zip-'));
  const file = join(dir, 'a.zip');
  writeFileSync(file, archive);
  let tested = false;
  try {
    execFileSync('unzip', ['-tqq', file], { stdio: 'pipe' });
    execFileSync('unzip', ['-qq', file, '-d', dir], { stdio: 'pipe' });
    tested = true;
  } catch (_) { /* no unzip on this machine - reported below rather than passed silently */ }
  check('a real unzip reads it back, folder and all', tested
    && existsSync(join(dir, 'my-skill', 'SKILL.md')),
    tested ? 'ok' : 'no `unzip` on this machine, so this checked nothing');
  check('and the UTF-8 in it survives the round trip', tested
    && readFileSync(join(dir, 'my-skill', 'SKILL.md'), 'utf8').includes('Привет'));
}
/* Without the UTF-8 flag a name with a non-ASCII character is read through the unzipper's guess at a legacy
 * codepage - which a skill named in Russian has. */
check('every entry is flagged UTF-8', /const UTF8_FLAG = 0x0800;/.test(read('../api/_zip.mjs')));
check('the panel offers the folder first and the bare file second',
  skillsView.indexOf('{md.slug}.zip') < skillsView.indexOf('Just the file, for a folder you already have'));
check('and the folder is named by the same slug as the frontmatter',
  /slug: skillSlug\(flow\.name\)/.test(read('../api/skill-md.js')));

/* Two skill buttons a word apart in meaning, one of them wordless, and the wordless one was the better
 * answer nearly every time. */
group('one skill button on a recording, and it makes the kind worth making');
check('the row’s Skill button opens the wizard rather than copying coordinates',
  /leftSlot=\{<Sparkles className="size-4" \/>\}[\s\S]{0,220}onClick=\{\(\) => onMakeSkill\(rec\)\}/.test(recTable));
check('and the literal copy is gone from the row, prop and handler with it',
  !/onSaveAsSkill/.test(recTable)
    && !/onSaveAsSkill/.test(read('../web/src/features/record/RecordView.tsx'))
    && !/const keepAsSkill/.test(read('../web/src/features/record/RecordView.tsx')));
/* And now gone from the Skills page as well, where it was the second of two buttons. Two outcomes under one
 * word is a choice made before the difference is known, and "repeat it as it was" - which cannot type, and
 * breaks when a window moves - was almost never the answer wanted. Asserted as absence in BOTH places: the
 * screen that offered it and the builder behind it, or it comes back the next time somebody needs a quick
 * copy and finds the function still sitting there. */
const saveAsSkillModule = read('../web/src/features/record/save-as-skill.ts');
/* The BUTTON, not the words: the comment above the surviving one names what was taken away and why, which
 * is the thing this repository does everywhere. A check that forbade the phrase in prose would forbid the
 * explanation and pass a file that had deleted it. */
check('and it is gone from the product, not moved somewhere quieter',
  !/>\s*Repeat it exactly\s*<\/Button>/.test(skillsView)
    && !/export async function saveAsSkill/.test(saveAsSkillModule)
    && /export async function saveAsGoalSkill/.test(saveAsSkillModule));
/* The id prefix stays, though, and that is not a leftover: skills made the old way are on accounts, and
 * hasSkillFor has to recognise them or their recording is invited into the wizard a second time. */
check('but the old ids are still recognised, so nobody is asked to make the same skill twice',
  /const skillIdFor = \(recordingId: string\) => `dr_\$\{recordingId\}`/.test(saveAsSkillModule)
    && /flow\.id === skillIdFor\(recordingId\) \|\| flow\.id === goalSkillIdFor\(recordingId\)/.test(saveAsSkillModule));
/* Play obeys the repeat, speed and loop below it, so it belongs beside them rather than above them. */
check('Play is in the panel with the settings it obeys, not on the row',
  (recTable.match(/onClick=\{\(\) => onPlay\(rec\)\}/g) || []).length === 1);
check('step two is about instructions, not only recorded typing',
  /STAGES = \['What it did', 'Instructions', 'Name it'\]/.test(wizard));
check('and it always offers a field, so it is never a dead end',
  /const \[notes, setNotes\]/.test(wizard) && /Anything else it should know/.test(wizard));
/* The point of the field: it is EXECUTED. A skill made here is a goal skill, and the goal is the sentence
 * a model reads and carries out — text in a field nobody executes would be a note to self. */
check('what somebody writes goes into the goal, which is what actually runs',
  /function withNotes/.test(wizard) && /withNotes\(buildGoal\(lines, kept, blanks\), notes\)/.test(wizard));
check('the three choices are explained, not left as unlabelled buttons repeated N times',
  /becomes an input on the skill/.test(wizard) && /leaves that field\s*\n?\s*alone/.test(wizard));
check('and they can be set for all of them at once, since a long recording makes nineteen',
  /Set all \{fields\.length\}/.test(wizard));
check('a skill about to demand a pile of inputs says so while it is still cheap to change',
  /separate inputs<\/strong> every/.test(wizard));
check('a window title used as a field name is cut rather than wrapped over three lines',
  /max-w-\[26rem\] truncate/.test(wizard));
check('and one keystroke is not "1 keystrokes"', /keystroke\$\{b\.keys === 1 \? '' : 's'\}/.test(wizard));

/* The classifier, run for real rather than checked by regex.
 *
 * The cases below are not invented. They are the thirteen typing runs of a 6,617-event recording on this
 * account, read out of the database: nine into one AXTextArea named "Prompt", four into the AXGroup of a
 * dialog, which is what Enter and Escape look like when the hit-test finds the container. The old wizard
 * asked a three-way question about all thirteen. */
group('a typing run is a field, or it is somebody pressing Enter');
const { classifyTyping, splitTyping } = await import('../api/_typing.mjs');

const MEASURED = [
  { keys: 60, role: 'AXTextArea', control: 'Prompt' },
  { keys: 7, role: 'AXGroup', control: 'Make a skill from “MouseFlow 22/08 13:10:16”' },
  { keys: 6, role: 'AXGroup', control: 'Make a skill from “MouseFlow 22/08 13:10:16”' },
  { keys: 70, role: 'AXTextArea', control: 'Prompt' },
  { keys: 53, role: 'AXTextArea', control: 'Prompt' },
  { keys: 116, role: 'AXTextArea', control: 'Prompt' },
  { keys: 3, role: 'AXTextArea', control: 'Prompt' },
  { keys: 2, role: 'AXGroup', control: 'Make a skill from “MouseFlow 22/08 13:10:16”' },
  { keys: 1, role: 'AXGroup', control: 'Make a skill from “MouseFlow 22/08 13:10:16”' },
  { keys: 261, role: 'AXTextArea', control: 'Prompt' },
  { keys: 15, role: 'AXTextArea', control: 'Prompt' },
  { keys: 1, role: 'AXTextArea', control: 'What it will do — edit it freely, this is what the skill carries out' },
  { keys: 61, role: 'AXTextArea', control: 'Prompt' },
];
const split = splitTyping(MEASURED);
check('the measured recording splits nine fields from four keypresses',
  split.fields.length === 9 && split.aside.length === 4,
  `${split.fields.length} fields, ${split.aside.length} aside`);
check('and every one of those verdicts was read off the role, not guessed',
  [...split.fields, ...split.aside].every((b) => b.verdict.sure));
/* Run 7 is three keystrokes into a genuine text box and run 12 is one. A rule that ranked keystroke count
 * above the role would have thrown both away - which is why the count is only consulted without a role. */
check('a three-keystroke run in a real text box is still a field',
  classifyTyping({ keys: 3, role: 'AXTextArea', control: 'Prompt' }).field);
check('and a one-keystroke run in one is too',
  classifyTyping({ keys: 1, role: 'AXTextArea', control: 'x' }).field);

/* `type` is the platform's word in the READER's language. This account alone produced Russian and Ukrainian
 * for it, so anything matching English control-type words would classify a Ukrainian machine as unknown. */
check('the localised control type is never what decides it',
  !/область|кнопка|edit box|text area/i.test(read('../api/_typing.mjs').split('const TEXT_ROLES')[1] || ''));

/* Windows writes no role at all, so everything below is the guess path. */
check('with no role, a name that is the window’s own name is not a field',
  classifyTyping({ keys: 9, control: 'Untitled — Notepad' }, 'Untitled — Notepad').field === false);
check('and that verdict admits it is a guess',
  classifyTyping({ keys: 9, control: 'Untitled — Notepad' }, 'Untitled — Notepad').sure === false);
check('with no role and no name there is nothing to aim at, so nothing to ask about',
  classifyTyping({ keys: 40, control: null }).field === false);
check('with no role, one keystroke is a shortcut',
  classifyTyping({ keys: 1, control: 'Subject' }).field === false);
check('with no role, a long run into a named control is taken as a field',
  classifyTyping({ keys: 40, control: 'Subject' }, 'Untitled - Message').field === true);
check('an unknown role falls through to the guess rather than to a confident no',
  classifyTyping({ keys: 40, role: 'AXSomethingNew', control: 'Subject' }).sure === false);
/* A password box is a text box. Hiding it would leave a skill that silently types nothing there. */
check('a secure field is reported as a field, so the skill does not quietly skip it',
  classifyTyping({ keys: 12, role: 'AXSecureTextField', control: 'Password' }).field);

/* Saying what was typed on the step it happened, rather than on a screen of cards away from it. */
group('the text can be given beside the step it belongs to');
check('a typing row carries a control that opens a popover',
  /const WhatWasTyped = /.test(wizard) && /<PopoverTrigger asChild>/.test(wizard));
check('and it asks in words anybody has, not in the vocabulary of parameters',
  /What did you type here\?/.test(wizard));
/* The box first, the three choices under it. The old screen led with the choices, which is a question about
 * parameters put to somebody who has never met one. */
check('the text box is the primary control and comes before the choices',
  wizard.indexOf('placeholder="the text"') < wizard.indexOf("['fixed', 'Type this every time']"));
check('typing picks "always this text" without anybody having to know that is what it is called',
  /const first = blank\.fill === 'ask' && !blank\.fixed;/.test(wizard));
/* ...but only from the untouched state, or a deliberate "ask" would be silently taken back. */
check('and it never overrides a choice somebody made on purpose',
  /\.\.\.\(first && value \? \{ fill: 'fixed' as Fill \} : \{\}\)/.test(wizard));
check('the chip shows the current answer, so nothing is set without saying so',
  /function chipOf\(b: Blank\)/.test(wizard) && /will ask each time/.test(wizard)
    && /types nothing/.test(wizard));
/* A button inside the row's <label> would toggle the checkbox on every click: the step would drop out of
 * the skill at the moment somebody opened the popover to say what it types. */
/* Asserted as STRUCTURE, not as a class list. This pinned the label's exact className, which made it a
 * test of cosmetics: it failed the day the row learned to wrap on a narrow panel, and it would have passed
 * had the chip been moved inside the label with the classes left alone - the one thing it exists to catch. */
check('the control sits outside the label, so opening it does not untick the step',
  /The chip sits OUTSIDE the label/.test(wizard)
    && /<\/label>\s*\{askable[\s\S]{0,80}<WhatWasTyped/.test(wizard));
/* A run that is NOT a field gets a chip too, and that is a fix rather than a decoration: without one the
 * row looked identical to a field's and simply had nowhere to answer. The first person to see the screen
 * asked why some typing rows could be filled in and others could not — the screen knew and was not saying. */
check('a typing run that is not a field says so, rather than sitting there silent',
  /const isField = blank\.verdict\.field;/.test(wizard)
    && /'keys, not text'/.test(wizard) && /Nothing to type here/.test(wizard));
check('and it explains itself with the same verdict the folding used',
  /\{blank\.verdict\.why\}/.test(wizard));
check('and it can be overturned there, not only from step two',
  wizard.split('It is a field →').length - 1 === 2);
check('only a KEPT step gets one — a dropped step types nothing by definition',
  /const askable = !!blank && on;/.test(wizard));
/* The three chip weights: loud when it wants an answer, quiet when it has one, barely a control when it is
 * only explaining itself. A muted label is information; a bordered chip is a question. */
check('the chip that only explains itself does not look like a question',
  /border-transparent text-ink-inactive hover:bg-state-hover/.test(wizard));

/* The free-text field first, the per-field cards under it. Free text can be written about ANY recording;
 * the cards answer a question the recording itself raises, and there may be none of them at all. */
check('step two leads with the field anybody can use, not with the special case',
  wizard.indexOf('Anything else it should know')
    < wizard.indexOf('MouseFlow records that a key was pressed and when'));
/* Six lines of explanation standing in front of the controls they explain is a screen that has to be
 * scrolled past before it can be worked — the cards were not visible at all. Kept, but underneath. */
check('and the explanation sits under the cards it explains, not on top of them',
  wizard.indexOf('Set all {fields.length}')
    < wizard.indexOf('MouseFlow records that a key was pressed and when'));
check('and it says the cards are above it, since that is now where they are',
  /Each card above is one place/.test(wizard));

/* Nine runs into one "Prompt" made nine cards headed identically, and named them prompt, prompt2, prompt3 —
 * a list where only the first is unnumbered, which reads as though it were the odd one out. They stay nine
 * parameters, because nine prompts in a chat are nine different sentences; they just become tellable apart. */
group('repeats of one field are numbered, not left looking identical');
check('the total is counted before any of them is named, so the first can be prompt1',
  /const totals = new Map<string, number>\(\);/.test(wizard)
    && /const param = verdict\.field \? unique\(of > 1 \? `\$\{base\}\$\{nth\}` : base, taken\) : '';/.test(wizard));
check('a field typed into once keeps its plain name',
  /of > 1 \? `\$\{base\}\$\{nth\}` : base/.test(wizard));
check('the card says which of them it is, and how many there are',
  /\{b\.nth\} of \{b\.of\}/.test(wizard));
check('and the popover says it too, since that is the other place they look identical',
  /blank\.of > 1 \? ` \$\{blank\.nth\} of \$\{blank\.of\}` : ''/.test(wizard));
/* The control name is truncated — it is often a window title. The counter must not be inside that span. */
check('the counter sits outside the truncating span, so it can never be cut off',
  wizard.indexOf('so the truncation above can never') > 0
    && /<span className="shrink-0 font-medium text-\[0\.9rem\] text-ink-primary">/.test(wizard));
/* Numbering repeats and breaking a tie between two DIFFERENT controls that slug alike are separate jobs. */
check('two different controls that slug alike still get separate names',
  /const unique = \(want: string, taken: Set<string>\)/.test(wizard)
    && /const slugOf = \(control: string \| null\)/.test(wizard));
check('the dev fixture carries a repeated field, or none of this is reachable in dev',
  (read('../web/src/dev/mock-api.ts').match(/control: 'Message body'/g) || []).length === 2);
check('a 546-step list does not scan the blanks once per row',
  /const blankOf = useMemo\(\(\) => new Map/.test(wizard));
check('and both screens edit the same blank, so they cannot disagree',
  /onEdit=\{\(patch\) => edit\(line\.n, patch\)\}/.test(wizard));

group('and the wizard folds the rest away instead of asking about them');
check('what is not a field defaults to typing nothing, rather than to a required input',
  /fill: \(verdict\.field \? 'ask' : 'skip'\) as Fill/.test(wizard));
check('and that default is stated on screen, not silent',
  /other place\{aside\.length === 1 \? '' : 's'\} where keys were pressed/.test(wizard));
check('a wrong verdict is one click to overturn',
  /It is a field →/.test(wizard) && /fill: 'ask', verdict: \{ \.\.\.b\.verdict, field: true \}/.test(wizard));
check('a guess is labelled as one, since that is what decides whether to overturn it',
  /b\.verdict\.sure \? '' : ' \(a guess\)'/.test(wizard));
check('parameter names are spent on fields only, so the first real one is not called text4',
  /const param = verdict\.field \? unique\(/.test(wizard) && /: '';/.test(wizard));
check('overturning one names it, so Next is never disabled with an empty box and no reason',
  /next\.fill === 'ask' && !next\.param\.trim\(\)/.test(wizard));
check('the transcript sends the unlocalised role, which is what any of this rests on',
  /role: ctx && ctx\.role \? ctx\.role : null/.test(read('../api/_transcript.js')));

check('the save button carries no icon, which wrapped it onto two lines',
  !/<Check className/.test(wizard));

check('the step list can be taken whole in one click', /const keepAll = useCallback/.test(wizard)
  && /lines \?\? \[\]\)\.filter\(worthShowing\)\.map\(\(line\) => line\.n\)/.test(wizard));
/* A scroll IS describable and still is not worth a line: this kind of skill is carried out by a model
 * reading the screen, which scrolls when it needs to see something. One recording here held 1,732 wheel
 * notches. */
check('a scroll is folded away with the rest, not put in front of somebody',
  /describable\(line\) && line\.action !== 'scroll'/.test(wizard));
check('and it is not in the skill by default either, so hidden means left out',
  /setKept\(new Set\(flat\.filter\(worthShowing\)/.test(wizard));
check('the fold says scrolls are among what it holds',
  /scrolls, clicks on things with no name/.test(wizard));

/* Every recording started from the app ends with a click on MouseFlow's own Stop button. That click is
 * bookkeeping ABOUT the recording, not part of the work - and a skill repeating it presses Stop on a
 * recorder nobody started, which is what the first goal skill made here actually did. */
check('MouseFlow’s own recorder controls are folded away too',
  /const OWN_RECORDER_CONTROLS = new Set\(\[/.test(wizard)
    && /'stop and save this recording',/.test(wizard)
    && /!isOwnRecorderControl\(line\)/.test(wizard));
/* Narrow on purpose: a click on "Make a skill" or "Delete" is somebody USING the app - unlikely to be the
 * task, but at least something they did. Stopping the recording is the one action guaranteed not to be. */
check('and only the recorder’s controls, not everything in MouseFlow',
  !/'make a skill'|'delete'|'next'/.test(wizard.slice(
    wizard.indexOf('const OWN_RECORDER_CONTROLS'), wizard.indexOf('const isOwnRecorderControl'))));
/* Matching our OWN labels is safe where matching a platform's control type is not: these are not translated
 * — which is why the strings were taken from the app's and both agents' source rather than invented. */
check('the labels cover the app, the macOS menu item and the Windows tray item',
  /'stop and save recording',/.test(wizard) && /'mouseflow agent - recording',/.test(wizard));
/* A recording whose only step is the click that stopped it now folds to nothing. An empty list under a
 * disabled Next with no sentence reads as a broken screen; it is a real recording with nothing in it. */
check('a recording that folds to nothing says so rather than showing an empty list',
  /Nothing in this recording can become a skill\./.test(wizard));
check('and the dev fixture ends the way a real recording does',
  /control: 'Stop and save this recording'/.test(read('../web/src/dev/mock-api.ts')));

/* A 546-step recording is mostly pointer moves, waits, and clicks on things the accessibility layer could
 * not name. None of them can become an instruction, so showing four hundred of them - each with three lines
 * saying why it cannot be used - is a list nobody reads any of. */
group('the step list opens on the steps that can become a skill');
check('what cannot be described is folded away by default',
  /const \[showAll, setShowAll\] = useState\(false\)/.test(wizard)
    && /const shown = showAll \? \(lines \?\? \[\]\) : describables;/.test(wizard));
check('and the list renders the folded view, not the whole thing',
  /\{shown\.map\(\(line\) => \{/.test(wizard));
/* Hidden is not the same as absent: a recording of 546 steps showing 90 is a claim, and the page says it. */
check('the count of what was left out is stated, with a way in',
  /\{hidden\} more step\{hidden === 1 \? '' : 's'\}/.test(wizard)
    && /setShowAll\(\(was\) => !was\)/.test(wizard));
check('and both counters count the same thing, so "8 of 9" cannot appear over 8 rows',
  (wizard.match(/of \{describables\.length\}/g) || []).length === 1
    && /\$\{kept\.size\} of \$\{describables\.length\} steps kept/.test(wizard));
check('taking everything takes what can be described, not ticks that contribute nothing',
  /describables\.every\(\(line\) => kept\.has\(line\.n\)\)/.test(wizard));

/* The dialog was `max-h-[60vh] min-h-[280px]` — a RANGE, so it was a different size on every recording and
 * on every step of the same one, resizing under the cursor with Next moving as it went. */
check('the dialog is one height rather than a range',
  /h-\[60vh\] max-h-\[34rem\] min-h-\[20rem\]/.test(wizard)
    && !/max-h-\[60vh\] min-h-\[280px\]/.test(wizard));
check('and emptied in one, so neither direction costs a click per step',
  /const keepNone = useCallback\(\(\) => setKept\(new Set\(\)\)/.test(wizard));

/* The compiler that puts what somebody WROTE onto the steps their recording DERIVED.
 *
 * Run for real. Applying the plan is plain code on purpose - the model decides where a sentence goes and
 * whether something clashes; this decides what the goal text ends up being - so it is the half that can be
 * tested without a model, and the half where a mistake silently changes what runs on a real machine. */
group('what was written is placed among the steps, never instead of them');
const compose = await import('../api/_compose.mjs');

const RECORDED = [
  { n: 1, instruction: 'click "New mail"' },
  { n: 4, instruction: 'type {{subject}} into "Subject"' },
  { n: 7, instruction: 'click "Save"' },
];

const placed = compose.applyPlan({ steps: RECORDED, opening: 'In Outlook, do this:' }, {
  insert: [{ after: 4, instruction: 'type today’s date into "Reference"', from: 'type today’s date' }],
  conflicts: [{ n: 7, note: 'finish by pressing Send, not Save', why: 'the recording clicked Save here' }],
  unplaced: [{ note: 'this is for the Q3 client', why: 'it is context, not an action' }],
});
check('an insert lands after the step it names, in the position that step now occupies',
  /2\. Type \{\{subject\}\} into "Subject"\./.test(placed.text)
    && /3\. Type today’s date into "Reference"\./.test(placed.text), placed.text);
/* The placeholder is an input the skill will ask for. A compiler that helpfully filled one in would build a
 * skill that runs the author's own errand for whoever calls it. */
check('and a placeholder survives the round trip untouched',
  placed.text.includes('{{subject}}'));
check('the inserted line sits between the two it was placed between',
  placed.lines.map((l) => l.from).join(',') === 'recorded,recorded,yours,recorded',
  placed.lines.map((l) => l.instruction).join(' | '));
check('and the whole thing renumbers, so the goal reads 1..4',
  /1\. Click/.test(placed.text) && /4\. Click "Save"\./.test(placed.text), placed.text);
/* The decision that matters: a conflict is REPORTED and the recorded step survives. A compiler that deleted
 * step 7 because a sentence disagreed with it would destroy the one thing here that is not a guess. */
check('a conflict is reported and the step it clashes with is left exactly as it was',
  placed.conflicts.length === 1 && placed.conflicts[0].n === 7
    && placed.text.includes('Click "Save"'));
/* Two numberings are on screen at once: the recording's, which has gaps where steps were dropped, and the
 * goal's, renumbered 1..N with the inserts spliced in. Reporting a clash in the first sends somebody to a
 * different line of the second — which is what it did until it was looked at rather than reasoned about. */
check('and it is numbered in the goal’s numbering, not the recording’s',
  placed.conflicts[0].n === 7 && placed.conflicts[0].at === 4,
  JSON.stringify(placed.conflicts[0]));
check('and quoted too, since a quotation cannot drift out of step with a renumbering',
  placed.conflicts[0].instruction === 'click "Save"');
check('and nothing the person wrote is swallowed - unplaced comes back',
  placed.unplaced.length === 1 && /context, not an action/.test(placed.unplaced[0].why));

/* A position the model invented cannot be honoured, and the instruction it carried must not be dropped on
 * the floor or appended somewhere plausible - either would be a silent guess about where work happens. */
const stray = compose.applyPlan({ steps: RECORDED }, {
  insert: [{ after: 99, instruction: 'click "Send"', from: 'finish with Send' }],
  conflicts: [], unplaced: [],
});
check('an insert after a step nobody kept becomes unplaced, not a guess',
  stray.unplaced.length === 1 && /not one of the steps kept/.test(stray.unplaced[0].why)
    && !stray.text.includes('Send'));
check('and it is reported under what the person wrote, not under the model’s paraphrase',
  stray.unplaced[0].note === 'finish with Send');

check('after 0 means before the first step, which is a real answer',
  compose.applyPlan({ steps: RECORDED }, {
    insert: [{ after: 0, instruction: 'open Outlook', from: 'start in Outlook' }],
    conflicts: [], unplaced: [],
  }).lines[0].from === 'yours');

check('a conflict against a step nobody kept is not a conflict any more',
  compose.applyPlan({ steps: RECORDED }, {
    insert: [], conflicts: [{ n: 99, note: 'x', why: 'y' }], unplaced: [],
  }).conflicts.length === 0);

check('two inserts after one step keep the order they came in',
  compose.applyPlan({ steps: RECORDED }, {
    insert: [
      { after: 1, instruction: 'first', from: 'a' },
      { after: 1, instruction: 'second', from: 'b' },
    ],
    conflicts: [], unplaced: [],
  }).lines.map((l) => l.instruction).slice(1, 3).join(',') === 'first,second');

check('an empty instruction is ignored rather than numbered as a blank line',
  compose.applyPlan({ steps: RECORDED }, {
    insert: [{ after: 1, instruction: '   ', from: 'a' }], conflicts: [], unplaced: [],
  }).lines.length === RECORDED.length);

/* Junk from a model must not throw. This route runs while somebody is trying to save a skill. */
check('a plan that is not the shape asked for leaves the recorded steps intact',
  compose.applyPlan({ steps: RECORDED }, null).lines.length === 3
    && compose.applyPlan({ steps: RECORDED }, { insert: 'nope' }).lines.length === 3);

/* No silent caps: a compiler that considered the first 300 of 546 steps would place "finish by pressing
 * Save" against whatever step 300 happened to be. */
const long = Array.from({ length: compose.MAX_STEPS + 46 }, (_, i) => ({ n: i + 1, instruction: 'click x' }));
const prompt = compose.promptFor({ steps: long, notes: 'finish by pressing Save' });
check('a list longer than the cap says how many it left out', prompt.dropped === 46
  && /46 further steps are not listed/.test(prompt.user));
check('the model is told never to place a note just to avoid the unplaced list',
  /Unplaced is a normal answer/.test(compose.SYSTEM));
check('and never to inline a value for an input the skill will ask for',
  /never inline a value for one/.test(compose.SYSTEM));
/* The tool is what forces the structure; without required fields the model answers in prose. */
check('the plan is required to carry all three lists',
  compose.PLAN_TOOL.schema.required.join(',') === 'insert,conflicts,unplaced');

group('and the route can fail without stopping anybody saving a skill');
const composeApi = read('../api/compose.js');
check('every refusal answers 200 with a reason, so a busy model is not a dead end',
  /const no = \(res, why\) => res\.status\(200\)\.json\(\{ ok: false, why \}\)/.test(composeApi));
check('it is behind whoIsCalling, because it spends the deployment’s own key',
  /whoIsCalling\(req, sql\)/.test(composeApi) && /if \(!who\) return no\(/.test(composeApi));
check('and rate-limited per account rather than per address',
  /tooMany\(who\.id\)/.test(composeApi));
check('no notes means no model call at all',
  /if \(!notes\.trim\(\)\) return no\(/.test(composeApi));
check('a deployment with no model key says so rather than reporting a crash',
  /instanceof ProviderError/.test(composeApi));

/* Two claimers on one account, and they are not interchangeable. While everything queued was a `#record.*`
 * command - which both can do - nothing went wrong; the first goal skill queued on a machine running both
 * would have gone to whichever long-poll landed first. */
group('the queue hands a job only to something that can do it');
const mcpApi = read('../api/mcp.js');
check('the claim asks what the claimer is',
  /const claimerIsWorker = String\(\(req\.body && req\.body\.kind\) \|\| ''\) === 'worker'/.test(mcpApi));
/* Two things qualify, and both DECLARE it: a worker, which runs the loop on the machine, and an agent that
 * can carry a goal one turn at a time against ?worker=step. Neither is assumed - an old binary and an old
 * worker go on not being given goal jobs, which is the whole reason the declaration is on the claimer. */
check('and a created skill goes only to something that declared it has the model path',
  /and f\.deleted_at is null and f\.kind = 'created'/.test(mcpApi)
    && /\$\{claimerSteps\}/.test(mcpApi)
    && /claimerSaysSteps = !!\(req\.body && req\.body\.steps === true\)/.test(mcpApi));
/* There is one mouse, and both claimers long-poll the same endpoint: whichever asked first used to take
 * the job. The agent wins now - a reversal of the plan, on the grounds that the worker is the install step
 * this whole change removes, and leaving it in front means the new path never runs on a machine that has
 * one. A worker alone is unaffected, and takes goals again by itself if the agent stops asking. */
check('when both are listening, the worker is not offered a goal',
  /const claimerSteps = claimerIsWorker \? !stepperListening : claimerSaysSteps/.test(mcpApi));
check('and "listening" means it asked recently, not that it once existed',
  /AGENT_LISTENING_MS = 90_000/.test(mcpApi)
    && /Date\.now\(\) - new Date\(rows\[0\]\.value\)\.getTime\(\) < AGENT_LISTENING_MS/.test(mcpApi));
check('a stepping agent stamps itself, or nothing could know it is there',
  /stampWorker\(sql, who\.id, 'agent\.steps\.seen'\)/.test(mcpApi));
/* A precedence rule must never be the thing that stops work happening: if the stamp cannot be read, the
 * answer is "no agent", which is the behaviour that existed before any of this. */
check('and an unreadable stamp leaves the worker able to work',
  /catch \(_\) \{[\s\S]{0,220}return false;\n {2}\}/.test(mcpApi));
check('and the worker is what declares it',
  /kind: 'worker'/.test(read('../mcp/worker.mjs')));
/* A command is `#`-prefixed and both kinds can do it — the flow lookup is only for actual skills. */
check('a command still goes to either of them', /q\.flow_id like '#%'/.test(mcpApi));
/* A stale job whose flow is gone must still be claimable, or it sits in the queue for ever waiting for a
 * claimer that will never be allowed to take it. */
check('and a job whose flow went missing is still claimed, then fails with a reason',
  /not exists \(/.test(mcpApi));
/* WHICH SIDE declares is the whole decision, and it was made the wrong way round first. Having the AGENT
 * declare never refuses an old worker anything - and it lands only when every compiled agent binary has
 * been rebuilt and reinstalled. The worker is a checkout that updates with `git pull`. */
check('the declaration is on the side that can be updated',
  /an agent is a COMPILED BINARY/.test(mcpApi)
    && /updates with `git pull`/.test(read('../mcp/worker.mjs')));

/* A crash reporter on a product that promises not to watch you is worth checking rather than trusting. */
group('error reporting sends crashes and not people');
const sentry = read('../web/src/lib/sentry.ts');
check('no DSN means no reporting at all, so dev and previews are silent by default',
  /if \(!DSN\) return;/.test(sentry));
check('Session Replay is not installed — not disabled, absent',
  !/replayIntegration/.test(sentry.replace(/\/\*[\s\S]*?\*\//g, '')));
check('and no IP, cookies or headers ride along', /sendDefaultPii: false/.test(sentry));
check('query values are scrubbed by an ALLOWLIST, so a parameter added later is redacted by default',
  /const KEEP = new Set\(/.test(sentry) && /\[redacted\]/.test(sentry));
check('breadcrumbs are scrubbed too, where a URL turns up a second time',
  /event\.breadcrumbs = event\.breadcrumbs\.map/.test(sentry));
check('a render crash shows something rather than a white page',
  /<ErrorBoundary/.test(read('../web/src/main.tsx')));
const viteConfig = read('../web/vite.config.ts');
check('source maps are uploaded only when a token is present, and the build never fails for want of one',
  /const uploadingMaps = Boolean\(/.test(viteConfig) && /uploadingMaps \? 'hidden' : false/.test(viteConfig));
check('and they are deleted after upload, so they are not served from the CDN',
  /filesToDeleteAfterUpload/.test(viteConfig));

/* The server half. The bug that motivated it was CAUGHT and turned into a 500 by the route's own handler,
 * so an outer wrapper alone would have missed it — which is why both paths are checked here. */
group('a server crash reaches Sentry, handled or not');
const reporter = read('../api/_report.js');
check('the envelope is three lines: header, item header, event',
  /JSON\.stringify\(\{ event_id: id, sent_at/.test(reporter)
  && /JSON\.stringify\(\{ type: 'event' \}\)/.test(reporter));
check('sent to the envelope endpoint with the DSN key, at version 7',
  /\/api\/\$\{dsn\.project\}\/envelope\/\?sentry_key=\$\{dsn\.key\}&sentry_version=7/.test(reporter));
check('the scheme comes from the DSN rather than being assumed https',
  /protocol: url\.protocol/.test(reporter));
check('the innermost frame goes LAST, which is the order Sentry draws',
  /return frames\.reverse\(\);/.test(reporter));
check('node internals are marked not-in-app, or a trace is forty frames of runtime',
  /in_app: !filename\.startsWith\('node:'\)/.test(reporter));
check('the request carries the route and NOT the query string, the body or the headers',
  /String\(req\.url \|\| ''\)\.split\('\?'\)\[0\]/.test(reporter)
  && !/req\.headers/.test(reporter));
check('no DSN means it does nothing at all', /if \(!dsnOf\(\)\) return;/.test(reporter));
check('and reporting never throws on top of the failure it is reporting',
  /catch \(_\) \{[\s\S]{0,200}?return false;/.test(reporter));
check('it is awaited before responding, since a function can be frozen the instant it returns',
  /await report\(err, req/.test(read('../api/insights.js')));

/* A failed sign-in used to be knowable only from the address bar of the person it happened to, which is
 * why a loop that shows up in the database as three sessions in twenty-two seconds had no reason attached
 * to any of them. These hold the reporting in place. */
const authRoute = read('../api/auth.js');
check('every failed sign-in reports before it redirects, because the address bar is not instrumentation',
  /await report\([\s\S]{0,500}?res\.writeHead\(302/.test(authRoute));
check('and no failure path can skip it — the only redirects are the one bounce and the one success',
  (authRoute.match(/res\.writeHead\(302/g) || []).length === 2,
  'found ' + (authRoute.match(/res\.writeHead\(302/g) || []).length);
check('the browser is named, since a failure that clusters on one engine is a different bug',
  /browser: String\(req\.headers\['user-agent'\]/.test(authRoute));
/* Scoped to the object literal itself, not a window of characters after it: a loose window reaches the
 * `if (!verifier)` on the next line and fails on the word rather than on the thing. */
check('and the one-time verifier is not among what travels',
  !/verifier/i.test((authRoute.match(/detail: \{[^}]*\}/) || [''])[0]));
check('a refusal is a warning and a broken contract is an error, so the two do not drown each other',
  /bounced\('rejected', why, 'warning'\)/.test(authRoute)
  && /bounced\('no-session-cookie', why, 'error'\)/.test(authRoute));

/* The tool that edits the trusted-origin list runs against PRODUCTION auth config, and the entries most
 * worth removing are the malformed ones — so tidying the argument before matching deletes the wrong twin
 * and says "Removed". It did exactly that to this project. */
const originTool = read('../scripts/auth-origin.mjs');
check('removing a trusted origin matches the string it was given before tidying it',
  /const verbatim = removing && current\.some\(\(entry\) => domainOf\(entry\) === target\)/.test(originTool)
  && /const origin = verbatim \? target : normalise\(target\)/.test(originTool));
check('and a non-exact entry is still flagged rather than silently tidied',
  /NOT an exact origin, so it is trusted for nothing/.test(originTool));

/* Every route that turns an exception into a 500 has to say so, or the commonest failure stays invisible. */
let silent = [];
for (const file of readdirSync(fileURLToPath(new URL('../api/', import.meta.url))).filter((f) => f.endsWith('.js'))) {
  const text = readFileSync(fileURLToPath(new URL('../api/' + file, import.meta.url)), 'utf8');
  for (const [, before] of text.matchAll(/([\s\S]{160})return fail\(res, 500,/g)) {
    if (!/await report\(/.test(before)) silent.push(file);
  }
}
check('no route answers 500 without reporting it', silent.length === 0, [...new Set(silent)].join(', '));
check('and the routes carry the outer net too',
  readdirSync(fileURLToPath(new URL('../api/', import.meta.url)))
    .filter((f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'well-known.js' && f !== 'auth.js')
    .every((f) => /export default wrap\(/.test(
      readFileSync(fileURLToPath(new URL('../api/' + f, import.meta.url)), 'utf8'))));

/* A goal skill needs a model in the loop, so it runs through mcp/worker.mjs rather than through the agent.
 * That was a macOS-only story: there was an installer for the Mac and nothing at all for Windows, so a
 * Windows user could be driven for RECORDED skills and not for created ones. */
group('the worker can be installed on either platform');
const mac = read('../mcp/install-worker-mac.sh');
const win = read('../mcp/install-worker-windows.ps1');
check('both refuse anything that is not a device token',
  /mf_\*\)/.test(mac) && /StartsWith\('mf_'\)/.test(win));
check('both read the token without echoing it',
  /read -rs TOKEN/.test(mac) && /-AsSecureString/.test(win));
/* Which is exactly why the length has to be checked. A prompt that does not echo invites somebody who is
 * not sure the paste landed to paste again; that produces a 92-character string with the right prefix,
 * which installs cleanly and then fails auth forever. It happened. */
check('and both check the length, because the prefix alone let a doubled paste through',
  /TOKEN_LEN" -ne 46/.test(mac) && /\$Token\.Length -ne 46/.test(win));
/* The message has to name what happened. "Mint a new one" sends somebody to make a second token that
 * fails the same way — which is what the worker's own error said, and it was not enough. */
check('and say it was pasted twice rather than sending somebody to mint another',
  /pasted twice/.test(mac) && /pasted twice/.test(win));
/* 46 is not a guess: api/sync.js mints `mf_` + base64url of 32 random bytes. */
check('46 is the length the account actually mints',
  /DEVICE_TOKEN_PREFIX \+ randomBytes\(32\)\.toString\('base64url'\)/.test(read('../api/sync.js')));
check('both refuse a Node older than 22.18, which the worker needs',
  /22 \] \|\| \{ \[ "\$NODE_MAJOR" -eq 22 \] && \[ "\$NODE_MINOR" -lt 18/.test(mac)
  && /major -lt 22 -or \(\$major -eq 22 -and \$minor -lt 18\)/.test(win));
check('both take the same three settings',
  ['MOUSEFLOW_TOKEN', 'MOUSEFLOW_URL', 'MOUSEFLOW_AGENT_PORT'].every((k) => mac.includes(k) && win.includes(k)));
check('both can say whether it is running, and both can remove it',
  /--status/.test(mac) && /--uninstall/.test(mac) && /\$Status/.test(win) && /\$Uninstall/.test(win));
check('both write somewhere readable, since a worker that cannot reach the account says so there',
  /StandardErrorPath/.test(mac) && /worker\.log/.test(win));
/* The one place they genuinely differ, and it is a platform fact rather than an omission. */
check('the Windows one says it has no KeepAlive, because the Startup folder has none',
  /does not restart it if it dies/.test(win));

/* Copy that names a mechanism only one platform has is copy that is wrong on the other. It said "the
 * cursor icon at the top of the screen" to Windows users the day Windows could be attached at all. */
group('the app describes the machine somebody is actually on');
const conn = read('../web/src/shell/settings/ConnectionsScreen.tsx');
check('the attach panel branches on the platform the agent reports',
  /health\.platform === 'windows'/.test(conn));
check('and Windows is told about a tray, not a menu bar',
  /tray menu, in the notification area/.test(conn));

/* Chrome 142 made reaching 127.0.0.1 from a public origin a user PERMISSION. All three defences below were
 * described in the docs for weeks while none of them existed in the code, which is the failure these
 * guard: the prompt was raised by a background poll on page load, got dismissed as inexplicable, and every
 * later request failed instantly while the app said "Agent offline" about an agent answering curl. */
group('the browser is asked for the local network on purpose, not by accident');
const agentLib = read('../web/src/lib/agent.ts');
const storeLib = read('../web/src/lib/store.ts');
check('every call to the agent declares the address space it is crossing',
  /targetAddressSpace: 'loopback'/.test(agentLib));
check('nothing reaches loopback before a gesture, on an origin where a prompt can appear',
  /if \(timer === null && armed\)/.test(storeLib)
  && /export function askAgent/.test(storeLib));
check('and refreshAgent cannot start one either, so the rule does not rest on its callers',
  /export function refreshAgent\(\) \{\s*\n\s*if \(!armed\) return;/.test(storeLib));
check('a loopback page is exempt, because same-address-space raises no prompt to wait for',
  /const sameAddressSpace = \(\)/.test(storeLib)
  && /let armed = sameAddressSpace\(\)/.test(storeLib));
check('the permission is read to EXPLAIN a failure, never to decide whether to try',
  /const trouble = status\.trouble \?\? await loopbackTrouble\(\)/.test(storeLib)
  && !/if \([^)]*loopbackTrouble[^)]*\)[\s\S]{0,40}return;/.test(storeLib));
check('and "Agent offline" is no longer the answer to four different questions',
  /Blocked by browser/.test(read('../web/src/shell/AppLayout.tsx'))
  && /Check for agent/.test(read('../web/src/shell/AppLayout.tsx')));

/* A recording could not say that the work ended by pressing Send, so a skill made from it stopped one step
 * short - and nobody found out until it ran. The agent now names the keys that cannot spell anything; these
 * check the rest of the journey, which is where it can be lost silently.
 *
 * Run against the real transcript builder rather than asserted over source: the first attempt at this
 * passed every regex and still delivered `pressed: null` to the wizard, because emit() builds a step from
 * an explicit list of fields and quietly drops anything not on it. */
group('a key that was named survives all the way to an instruction');
const { transcribe } = await import(new URL('../api/_transcript.js', import.meta.url).href);
const keyEv = (action, delayMs) => ({
  x: 400, y: 300, delayMs, action,
  context: { app: 'Gmail', window: 'Compose', control: 'Message body', type: 'text field' },
});
const typed = transcribe({
  source: 'desktop', kind: 'recorded', name: 'send it',
  payload: {
    events: [
      keyEv('Focus', 0), keyEv('Left Click Down', 300), keyEv('Left Click Release', 40),
      ...Array.from({ length: 8 }, () => keyEv('Key Down', 90)),
      keyEv('Key Backspace', 200), keyEv('Key Cmd+Enter', 250),
    ],
  },
});
const keySteps = (typed.segments ?? []).flatMap((s) => s.steps ?? []);
check('anonymous typing is still one step saying how long and how many',
  keySteps.filter((s) => s.action === 'type').length === 1
  && keySteps.some((s) => s.action === 'type' && s.keys === 8));
check('a named key is its own step, never folded into the run',
  keySteps.filter((s) => s.action === 'press').length === 2);
check('and it carries its NAME out to the client, which emit() would otherwise drop',
  keySteps.filter((s) => s.action === 'press').every((s) => !!s.pressed)
  && keySteps.some((s) => s.pressed === 'Cmd+Enter')
  && keySteps.some((s) => s.pressed === 'Backspace'));
check('deleting is visible as deleting, rather than as more typing',
  keySteps.some((s) => /pressed Backspace/.test(s.what)));
check('the wizard can build an instruction from it without a control name',
  /case 'press': return line\.pressed/.test(read('../web/src/features/record/SkillWizard.tsx'))
  && /if \(line\.action === 'press'\) return !!line\.pressed;/.test(
    read('../web/src/features/record/SkillWizard.tsx')));

/* A reporting script that runs against the production database, so the thing worth holding is that it can
 * only ever read - and that it does not print what a run was FOR. Measuring the pace is not a reason to put
 * somebody's goal text on a terminal. */
group('the pace report reads, and reads only');
/* Comments stripped FIRST, for both. This file explains itself at length and says the words it is
 * checking for - the first version matched "Select statements" in a comment, ran the capture through to
 * the real query, and reported the prose as SQL. */
const pace = read('../scripts/pace.mjs')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check('nothing in it writes',
  !/\b(insert|update|delete|drop|alter|truncate|create)\s+(into|table|from|set)?/i.test(pace));
check('and it never selects the goal, which is not what it is measuring',
  !/\bgoal\b/.test(pace.match(/select[\s\S]*?from user_run/i)?.[0] ?? ''));
/* On the CODE, not on the prose that describes it - the prose was just stripped, and a check that reads a
 * comment passes for a file whose comment survived a change its code did not. */
check('percentiles rather than means, or one timeout moves the number people act on',
  /Math\.ceil\(\(p \/ 100\) \* sorted\.length\)/.test(pace)
  && !/reduce\(\(a, b\) => a \+ b/.test(pace));

/* A page title cut at ninety characters read as a title that ends there. "…press stop when the task is
 * done. - Google Search" became "… - Go", which a reader has no way to recognise as shortened - and a page
 * title is precisely a thing people recognise. */
{
  const seg = (window) => transcribe({
    source: 'desktop', kind: 'recorded', name: 'x',
    payload: {
      events: [
        { x: 1, y: 1, delayMs: 0, action: 'Focus', context: { app: 'Chrome', window } },
        { x: 5, y: 5, delayMs: 200, action: 'Left Click Down', context: { app: 'Chrome', window, control: 'a' } },
        { x: 5, y: 5, delayMs: 20, action: 'Left Click Release', context: { app: 'Chrome', window } },
      ],
    },
  }).segments?.[0]?.where?.label;

  const long = 'Capturing every click, drag, scroll and keystroke — press stop when the task is done. - Google Search';
  check('a title too long to fit is shortened on a word, and says it was',
    /…$/.test(seg(long)) && !/- Go…?$/.test(seg(long)));
  check('and not left ending on a dangling separator',
    !/[-–—,:;|]…$/.test(seg(long)));
  check('a title that fits is left exactly alone',
    seg('Short title - Google Chrome') === 'Short title - Google Chrome');
  check('and one long word is still cut, because there is nowhere better to cut it',
    seg('A'.repeat(200)).length <= 90 && /…$/.test(seg('A'.repeat(200))));
}

/* Two presses become one double-click, and the click count went down while the two context counters did
 * not - so a recording with one double-click printed "for 10 of the 9 clicks". Asserted as the invariant
 * rather than as those numbers: what must hold is that you cannot have read more clicks than there were. */
{
  const ctx = { app: 'Google Chrome', window: 'MouseFlow', control: 'MouseFlow', type: 'link' };
  const at = (action, delayMs, x = 400, y = 300) => ({ x, y, delayMs, action, context: ctx });
  const doubled = transcribe({
    source: 'desktop', kind: 'recorded', name: 'dbl',
    payload: {
      events: [
        at('Focus', 0),
        at('Left Click Down', 300), at('Left Click Release', 20),
        at('Left Click Down', 90), at('Left Click Release', 20),
        at('Left Click Down', 900, 500, 400), at('Left Click Release', 20, 500, 400),
      ],
    },
  });
  const said = JSON.stringify(doubled);
  const counted = /(\d+) of the (\d+) click/.exec(said);
  check('a double click cannot leave more named clicks than clicks',
    !!counted && Number(counted[1]) <= Number(counted[2]),
    counted ? counted[0] : 'phrase missing');
  check('and it is folded, so three presses read as two clicks',
    doubled.summary && doubled.summary.clicks === 2, String(doubled.summary?.clicks));
}

/* Pressing Return after typing is what a person does to a BOX. Nobody commits a canvas or a game that
 * way, so a run terminated by one is a field as a matter of fact - which matters most on Windows, whose
 * agent writes no accessibility role at all and therefore always took the guess path. */
check('a run committed with Return is a field, and known rather than guessed', (() => {
  const run = { action: 'type', control: 'Search', role: null, keys: 22 };
  const guessed = classifyTyping(run, 'Some Window');
  const known = classifyTyping(run, 'Some Window', 'Enter');
  return guessed.field === true && guessed.sure === false
    && known.field === true && known.sure === true;
})());
check('a chord counts, because Cmd+Enter sends things too',
  classifyTyping({ action: 'type', control: 'Body', role: null, keys: 30 }, null, 'Cmd+Enter').sure === true);
check('but Backspace is not a commit — it is more editing',
  classifyTyping({ action: 'type', control: 'Body', role: null, keys: 30 }, null, 'Backspace').sure === false);
check('and a role that says "not a text box" still wins over the inference',
  classifyTyping({ action: 'type', control: 'Send', role: 'AXButton', keys: 22 }, null, 'Enter').field === false);

/* Dictation sends the user's voice somewhere. Which somewhere is a product decision, not a detail, and
 * these hold it: local first, and said out loud either way. */
group('dictation prefers the machine, and says so when it cannot');
const speech = read('../web/src/features/create/dictation.ts');
check('on-device availability is asked BEFORE falling back to a server',
  /available\(\{ langs: \[lang\], processLocally: true/.test(speech)
  && /available\(\{ langs: \[lang\], processLocally: false/.test(speech));
check('and processLocally is only set once that answer said the language is here',
  /if \(where === 'on-this-computer'\) rec\.processLocally = true;/.test(speech));
check('a failed check does not get to claim the audio stays local',
  /catch \(_\) \{[\s\S]{0,160}setWhere\('a-server'\)/.test(speech));
/* The browser only SEEDS it. navigator.language is the preferred-languages list, not the language somebody
 * speaks: on the first real machine the interface was Russian and it returned English, so Russian speech
 * came back recognised as English - which reads as broken recognition, not as a wrong setting. */
check('the language is a remembered choice, seeded by the browser rather than dictated by it',
  /rec\.lang = lang;/.test(speech)
  && /localStorage\.getItem\(LANG_KEY\)/.test(speech)
  && /localStorage\.setItem\(LANG_KEY, tag\)/.test(speech));
check('and changing it stops recognition, so the control cannot show one language while hearing another',
  /const setLang = useCallback\(\(tag: string\) => \{[\s\S]{0,120}live\.current\?\.abort\(\)/.test(speech));
check('the choices are deduped by base language, so "ru" and "ru-RU" are not two lines',
  /have\.split\('-'\)\[0\] === base/.test(speech));
check('where the audio goes is on screen before the microphone is pressed',
  /dictation is sent to Google to be recognised/.test(read('../web/src/features/create/CreateView.tsx'))
  && /dictation stays on this computer/.test(read('../web/src/features/create/CreateView.tsx')));
check('only FINAL speech reaches the goal — interim text would rewrite itself under the cursor',
  /if \(result\.isFinal\) sink\.current\(text\);/.test(speech)
  && /else pending \+= text;/.test(speech));
check('and a refused microphone says what to do, not what happened',
  /Allow it for this site in the address bar/.test(speech));

/* A flow dictated in chat can become a skill once it has actually run. The danger here is not that it
 * fails - it is that it quietly becomes a SECOND kind of skill, which is the thing da2b247 spent a whole
 * commit removing. So these hold it to one format and one save path. */
group('a dictated flow becomes a skill, and not a second kind of skill');
const dictated = read('../web/src/features/create/SaveDictatedSkill.tsx');
const saver = read('../web/src/features/record/save-as-skill.ts');
check('it saves the same goal skill the wizard saves — created, desktop, goalTemplate',
  /kind: 'created'/.test(saver) && /agent: 'desktop'/.test(saver)
  && /goalTemplate: said\.goal/.test(saver));
check('provenance says RUN, so nobody goes looking for a recording that never existed',
  /fromRun: run\.runId/.test(saver) && !/fromRecording: run\./.test(saver));
check('and its id cannot collide with a skill made from a recording',
  /dictatedSkillIdFor = \(runId: string\) => `gd_\$\{runId\}`/.test(saver)
  && /goalSkillIdFor = \(recordingId: string\) => `gs_\$\{recordingId\}`/.test(saver));
check('the offer appears only on a run that finished AND reached the account',
  /if \(result\.ok\) \{/.test(read('../web/src/features/create/CreateView.tsx'))
  && /turn\.state === 'ok' && turn\.proved/.test(read('../web/src/features/create/CreateView.tsx')));
check('and it stops being offered once the skill exists',
  /hasSkillForRun\(flows, turn\.proved\.runId\)/.test(read('../web/src/features/create/CreateView.tsx')));

/* The parameter convention is `{{name}}`, because that is what fillGoal substitutes. Run the file's OWN
 * expression rather than a copy of it - a copied regex is a second definition that agrees today. */
const paramRx = dictated.match(/goal\.matchAll\(\/(.+?)\/g\)/);
check('the parameter pattern is read from the file itself', !!paramRx, 'not found');
if (paramRx) {
  const rx = new RegExp(paramRx[1], 'g');
  const names = (text) => [...text.matchAll(rx)].map((m) => m[1]);
  check('it finds a placeholder and reports its name',
    JSON.stringify(names('mail {{recipient}} the report')) === '["recipient"]');
  check('it reads them in the order they were written, which is the order they are read in',
    JSON.stringify(names('{{b}} then {{a}}')) === '["b","a"]');
  check('a single brace is not a placeholder, or every JSON example becomes a parameter',
    names('send {plain} and ${x}').length === 0);
  check('and an empty pair asks for nothing', names('{{}} {{ }}').length === 0);
}

/* A click on a browser tab came back as "something Google Chrome did not name", so a recording of tab
 * clicks produced a skill with no steps in it. Chrome's own native tree says why: the hit test lands on
 * TabStrip::TabDragContextImpl, which covers the tabs exactly and has NO children, while the tab itself is
 * a level below that node's SIBLING. Descending from the hit can never reach it. */
const macAgent = read('../agent/mouseflow-agent.swift');
check('naming climbs out of a dead end rather than believing an empty node',
  /private static func namedAround/.test(macAgent)
  && /node = elementAttr\(here, kAXParentAttribute\)/.test(macAgent));
check('and considers every child that contains the point, not only the smallest',
  /private static func childrenAt/.test(macAgent)
  && /hits\.sorted \{ \$0\.area < \$1\.area \}/.test(macAgent));
check('aiming by name searches downward too, which is the case it was written for',
  /return namedDeep\(parent, matching: name, kind: kind\)/.test(macAgent));
check('and both searches are bounded, because this runs while somebody is working',
  /guard depth < 4 else \{ return nil \}/.test(macAgent)
  && /guard depth < 5, budget\.spend\(\) else \{ return nil \}/.test(macAgent)
  && /final class Budget/.test(macAgent));

/* The two agents answered the same question differently in the one header that decides whether a browser
 * will talk to them at all. */
check('both agents echo the caller origin rather than a bare star, and vary on it',
  /if \(allow == "\*" && origin != null\)/.test(read('../agent/mouseflow-agent.ps1'))
  && /if allow == "\*", let asked = origin \{ allow = asked \}/.test(read('../agent/mouseflow-agent.swift'))
  && /Vary: Origin/.test(read('../agent/mouseflow-agent.ps1'))
  && /Vary: Origin/.test(read('../agent/mouseflow-agent.swift')));

/* A picture that 404s is the documentation's version of the same bug. */
group('the documentation points at pictures that exist');
const docsDir = fileURLToPath(new URL('../docs/product/', import.meta.url));
const imgDir = fileURLToPath(new URL('../docs/img/', import.meta.url));
let images = 0;
let broken = [];
for (const file of readdirSync(docsDir).filter((f) => f.endsWith('.md'))) {
  const text = readFileSync(docsDir + file, 'utf8');
  for (const [, rel] of text.matchAll(/!\[[^\]]*\]\(\.\.\/img\/([^)]+)\)/g)) {
    images++;
    if (!existsSync(imgDir + rel)) broken.push(file + ' -> ' + rel);
  }
}
check('every screenshot referenced is in docs/img', broken.length === 0, broken.join(', '));
check('and there are pictures at all', images >= 20, String(images));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
/* Exited rather than left to drain. Two servers and three spawned children have been closed and killed by
 * here, and a keep-alive socket that outlives them keeps the loop open - which turns a suite that has
 * finished and said so into one that appears to hang, and `npm test` never returns. Everything this file
 * had to say is above this line. */
process.exit(fail ? 1 : 0);
