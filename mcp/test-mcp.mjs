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
  /* The loop itself is driven and tested in api/_test-step.mjs, which needs neither a database nor a key.
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
  /* The loop is started ONCE, with the model resolved once - a model changed mid-run would hand the task
   * between two that never saw each other's reasoning. Matched on the call rather than on its exact argument
   * list, which grew an `earlier` when runs learned to see the three before them. */
  check('the model is resolved once per run, not per step',
    /loop = startLoop\(\{ goal, model, success: payload\.success \|\| null,/.test(route)
    && /settings\['model\.desktop'\]/.test(route));
  check('the run reaches the account log like any other',
    /insert into user_run/.test(route));
  /* claimed_at is moved on by every step so that staleness means "not heard from". Using it as the start
   * time made a three-minute run read as eleven seconds, and the Hours screen is built on these stamps. */
  check('and dates it from when the run began, not from its last step',
    /\$\{state\.startedAt \|\| job\.claimed_at \|\| null\}/.test(route));
  /* Имя в запросе стало goalCapable, когда забирающих стало трое: claimerSteps по-прежнему решает спор
   * воркера и агента за одну мышь, а в САМ запрос уезжает объединение с браузером, который несёт свою
   * модель. Проверяется и то, и другое - иначе переименование прошло бы за починку. */
  check('only a claimer that says it can step is given a goal',
    /req\.body\.steps === true/.test(route) && /\$\{goalCapable\}/.test(route)
      && /const goalCapable = claimerSteps \|\| browserDoesGoals;/.test(route));

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
check('eleven of them, so a count in prose can be trusted', served.size === 11, String(served.size));
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
/* ПОРЯДОК ЦЕЛИКОМ, а не «галерея последняя»: он говорит, в каком порядке об этих экранах думают.
   /docs стоял здесь один день и ушёл: список документов стал вкладкой Галереи, потому что вопрос у
   человека один - «что уже сделано и можно взять», - и отвечать на него двумя пунктами меню было ошибкой.
   Пин на порядке существует ровно затем, чтобы и добавление, и удаление были видны в диффе теста. */
const NAV_ORDER = '/record,/create,/skills,/dashboard,/team,/gallery';
check('порядок в сайдбаре тот, о котором договорились, и Gallery последняя',
  [...sidebar.matchAll(/to: '(\/[a-z]+)'/g)].map((m) => m[1]).join() === NAV_ORDER,
  [...sidebar.matchAll(/to: '(\/[a-z]+)'/g)].map((m) => m[1]).join());
/* И у каждого пункта есть маршрут: пункт, ведущий в никуда, - это 404 из собственной навигации. */
for (const to of NAV_ORDER.split(',')) {
  check(`${to} - настоящий маршрут`, mainTsx.includes(`path: '${to}'`), to);
}
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
/* СРАВНИВАЮТСЯ ДВА ФАЙЛА, а не проверяется литерал в одном.
 *
 * Прежний вид этого пина требовал у Teams чекбокс шириной 1.5rem - при том, что у RecordingsTable он
 * 1.25rem, - и назывался «в той же анатомии, что у recordings table». То есть литерал закрепил само
 * расхождение, а заметили его глазами: страница Teams выглядела рядом с остальными как другой продукт.
 *
 * Число колонок остаётся своим у каждой: у команды их семь, у записи шесть, и это данные. Совпадать должны
 * ПЕРВАЯ колонка и высота строки - то, из чего складывается «одна анатомия». */
const recordingsTable = read('../web/src/features/record/RecordingsTable.tsx');
const firstCol = (src) => (src.match(/md:grid-cols-\[([^_\]]+)_/) || [])[1];
check('teams and recordings share the checkbox column',
  firstCol(teamView) && firstCol(teamView) === firstCol(recordingsTable),
  firstCol(teamView) + ' vs ' + firstCol(recordingsTable));
check('and the same row height',
  /rounded-lg px-3 py-1\.5/.test(teamView) && /rounded-lg px-3 py-1\.5/.test(recordingsTable));
check('and the same row border', /border border-stroke\/45/.test(teamView));
/* И ШИРИНА СТРАНИЦЫ ТА ЖЕ. Teams была единственной, зажатой в 1180px по центру, - отсюда узкая колонка и
 * пустая половина экрана рядом с Gallery и Skills. Проп убран целиком, а не только его вызов: проп без
 * вызовов - приглашение снова разъехаться. */
check('and no page centres itself at a different width',
  !/max-w-\[1180px\]/.test(read('../web/src/shell/Surface.tsx'))
  && !/<Page column/.test(teamView));
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
/* THE LIST IS PINNED BY EXACT MEMBERSHIP, both ways, and the count is checked so a sixth name cannot
 * arrive quietly. It grew from five to six once, on purpose:
 *
 * summarize_recordings was added because the team DASHBOARD already shows those same three blocks over
 * those same accounts, and the assistant exists on the team view to explain the numbers standing next to
 * it. A tool that is absent there buys nothing but "I cannot see what is on your screen".
 *
 * recording_details was NOT added, and that is the line: it names ONE colleague's recording by id, which
 * is a step towards its contents rather than a count over many. It is registered only outside a team
 * scope - see the check below that the recording tools are not registered at all there. */
const TEAM_ALLOWED = ['summarize_time', 'summarize_recordings', 'list_skills', 'find_repeated',
  'search_runs', 'team_people'];
check('it is a whitelist, and it is exactly these six',
  allowed.length === TEAM_ALLOWED.length
    && TEAM_ALLOWED.every((n) => allowed.includes(n))
    && allowed.every((n) => TEAM_ALLOWED.includes(n)), allowed.join(', '));
for (const forbidden of ['get_run', 'get_transcript', 'list_recordings', 'remove_steps', 'undo_edit',
  'recording_details']) {
  check(`${forbidden} is NOT reachable about a colleague`, !allowed.includes(forbidden));
}
/* И оно не просто отсутствует в списке - оно РЕГИСТРИРУЕТСЯ на другой ветке, за той же дверью, что и
 * остальные инструменты записи. Отсутствие в списке и отсутствие в таблице - разные гарантии. */
check('recording_details is registered only outside a team scope',
  /const table = \{ \.\.\.TOOLS, recording_details: recordingDigestTool \};/.test(chatSrc)
  && chatSrc.indexOf('if (ctx.team)') < chatSrc.indexOf('recording_details: recordingDigestTool'));
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
  /\.\.\.\(await payloadOf\(flow\) as Record<string, unknown>\), name \}/.test(skillsView));
/* И ЧЕРЕЗ payloadOf, а не через flow.payload напрямую. Список приложения перестал везти события записей
 * (28 записей = 3213КБ на каждую загрузку), а Skills показывает записи тоже - значит развернуть здесь
 * flow.payload значило бы отправить запись БЕЗ событий, то есть стереть час работы переименованием. */
check('и payload догружается, а не берётся из списка, который его больше не везёт',
  !/\{ \.\.\.\(flow\.payload as Record<string, unknown>\)/.test(skillsView));
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
/* The BLOCK, sliced out and asked what it does - rather than a pattern with a newline in it. `provider` is
 * the raw read from further up, so on a Windows checkout every \n in a pattern is really \r\n and the
 * assertion fails while the code it describes is exactly right. `read` documents that trap; this walked
 * into it, and the fix is to assert the intent instead of the indentation. */
const keptBlock = provider.slice(provider.indexOf('if (before) {'), provider.indexOf('const teamsBefore'));
check('and the kept copy does not make the account look answered',
  /setKnown\(true\)/.test(keptBlock) && !/setLoaded/.test(keptBlock));
check('so the reconciliation still waits for the real answer',
  /const \{ account, flows, loaded, reload \} = useAccount\(\)/.test(read('../web/src/features/record/Reconciler.tsx'))
    && /if \(!loaded\) return;/.test(read('../web/src/features/record/Reconciler.tsx')));
/* И ЧЬИ ЭТО ЗАПИСИ - второй вопрос, не тот же самый. `loaded` отвечает «аккаунт ответил»; то, что лежит в
 * этом браузере, могло быть записано предыдущим человеком, и Reconciler считает местную запись без штампа
 * работой того, кто сейчас вошёл. */
check('и чьи это записи - тоже, иначе они уедут не на тот аккаунт',
  /if \(!account \|\| storeHeldFor\(\) !== account\.id\) return;/
    .test(read('../web/src/features/record/Reconciler.tsx')));
/* One place applies a sync answer now. Two copies of that drifted once already - the file's opening note is
 * about three separate reads of /api/sync that could and did disagree. */
check('and one place applies an answer, whether it came at boot or later',
  /const applySync = useCallback/.test(provider)
    && /applySync\(await pull\(\)\)/.test(provider)
    && /if \(answer\) applySync\(answer\.body\)/.test(provider));

/* Every number in a transcript was measured from the first event, which answers "how far in" and not
 * "when". On a sixty-four minute recording those are different questions, and "0:03 · 4s" printed two
 * spans where one of them was an offset - so it read as a second duration. */
group('a transcript says what time of day a step happened');
/* `recordView` is already read above; this group reuses it. */
const panel = read('../web/src/features/record/TranscriptPanel.tsx');
const transcriptApi = read('../api/_transcript.js');
const storeTs = read('../web/src/lib/store.ts');

check('an offset says it is one',
  /return `\+\$\{fmtClock\(at\)\}`/.test(panel));
/* On the chapter line the clock REPLACES the offset. It printed both for a day and that was one number too
 * many: a clock on the left and a duration on the right, and "+0:00 · 3s" invited reading the two spans as
 * two durations. The offset stays where there is no room for a clock - the 44px column on a step row - and
 * is the fallback there when nothing gives a usable base. */
check('and on a chapter line the clock takes its place rather than sitting beside it',
  /\{clock \? clock\.at\(count\(chapter\.at\) \?\? 0\) : `\+\$\{fmtClock\(count\(chapter\.at\) \?\? 0\)\}`\}/.test(panel));
check('on the stretch headings too, which is the line people read',
  /clock\.at\(count\(segment\.startMs\) \?\? 0\)/.test(panel));
check('and on a step, without taking a fourth column off a 286px panel',
  /title=\{clock && typeof step\.at === 'number'/.test(panel));

/* WHERE THE CLOCK COMES FROM, and the trap: `created` is stamped when recording STOPS - that is the moment
 * the row is built - so adding offsets to it puts every step up to an hour in the future. */
check('the start is recorded at the press now, not reckoned from the stop',
  /startedAt\.current = new Date\(\)\.toISOString\(\)/.test(recordView)
    && /startedAt\?: string;/.test(storeTs));
/* RUN, not matched: flowFor is imported above, so the builder can be asked rather than read. One builder,
 * four callers - the push on stop, the restore, the reconcile and /api/mcp - so this is the only place the
 * field has to survive. */
const withStart = flowFor({ id: 'r1', name: 'x', created: new Date(74_000).toISOString(),
  startedAt: new Date(0).toISOString(), events: parsed.events, windows: [] }, null);
check('the payload carries the recorded start through the one builder',
  withStart.payload.startedAt === new Date(0).toISOString(), String(withStart.payload.startedAt));
/* `?? null`, never `?? rec.created` - which would be the guess the field exists to remove, and would put a
 * wrong clock on every step of an imported macro instead of no clock at all. */
const noStart = flowFor({ id: 'r2', name: 'x', created: new Date(74_000).toISOString(),
  events: parsed.events, windows: [] }, null);
check('and absent stays absent rather than becoming the moment it stopped',
  noStart.payload.startedAt === null, String(noStart.payload.startedAt));
check('and the endpoint passes it on',
  /startedAt: isoOf\(payload\.startedAt\)/.test(transcriptApi));

/* Everything recorded before the field existed still gets a clock, by subtraction - and the tooltip says
 * which of the two it was, because a reckoned time must not pass for a recorded one. */
check('an older recording is reckoned from the stop minus the span it ran',
  /base = finished - totalMs/.test(panel));
check('and the two are told apart out loud',
  /recorder stamped/.test(panel) && /worked out from when the recording stopped/.test(panel));
/* Neither base available - an imported macro on a deployment that never stamped - prints nothing rather
 * than a number nobody can trust. */
check('and with no usable base it prints no clock at all',
  /if \(!Number\.isFinite\(base\)\) return null;/.test(panel));

/* The preview has to be able to reach BOTH branches or the tooltip could only ever say one of them. */
check('the preview can reach the stamped branch',
  /startedAt: new Date\(Date\.now\(\) - 86400000 - 74_000\)/.test(read('../web/src/dev/mock-api.ts')));

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
/* And it keeps sorting on that when the events themselves are no longer in this browser: a recording whose
 * events were put out to the account to make room still knows how many there were, and sorting it as zero
 * would put a four-hour recording at the bottom of the column that exists to find it. */
check('the sparkline column sorts on how much was recorded',
  /case 'size':\s*\n\s*return \(a\.summary\?\.count \?\? a\.events\.length\) - \(b\.summary\?\.count \?\? b\.events\.length\);/.test(recTable));
check('names sort numerically, since every default name is a date and a time',
  /numeric: true, sensitivity: 'base'/.test(recTable));
check('and newest-first is still where it starts',
  /useState<\{ by: SortKey; asc: boolean \}>\(\{ by: 'created', asc: false \}\)/.test(recTable));
/* The status is read from the account, not from a flag on the row, so the comparator has to be too. */
check('status sorts on whether a skill exists, read the same way the cell reads it',
  /Number\(!!hasSkill\?\.\(a\)\) - Number\(!!hasSkill\?\.\(b\)\)/.test(recTable)
    && /\[state\.recordings, term, sort, hasSkill\]/.test(recTable));

group('the recordings list gives the page back its empty space');
/* `recordView` and `recTable` are both read further up; this group reuses them. */

/* A `w-full` field in a 1fr column was as wide as the column: measured in the browser at a 1920 viewport,
 * 912px of editable box holding a 24-character name, with the hover border drawing all of it. Capped at
 * 22rem it measures 352px - 2.6x narrower - and at a 1280 viewport the column is 272px and the cap does not
 * bite at all, which is the half of this that must not regress. */
check('the name field is capped rather than as wide as its column',
  /'w-full max-w-\[22rem\] rounded-md border border-transparent bg-transparent px-1 py-0\.5'/.test(recTable));
check('and still fills a narrow one, so the cap only ever takes width away from a wide screen',
  /w-full max-w-\[/.test(recTable));

/* CLICKING AWAY CLOSES THE TRANSCRIPT, and the interesting part is what it does NOT do. */
check('a press on the page closes the transcript',
  /document\.addEventListener\('pointerdown', away\)/.test(recordView)
    && /if \(target\.closest\('\[data-transcript\]'\)\) return;/.test(recordView));
/* pointerdown rather than click: a press that starts on the page and ends on the panel is still a press on
 * the page, and the panel should be gone before the button comes up. */
check('on pointerdown, not click',
  !/addEventListener\('click', away\)/.test(recordView));
/* NOT A BACKDROP - the panel is deliberately not modal, because the page scrolls behind it and switching to
 * another recording costs one click. A transparent sheet would take both away. Asserted on the mount site:
 * nothing full-screen was added beside the aside. */
check('and it is not a backdrop, so the list behind it still scrolls and still switches',
  !/inset-0/.test(/\{viewing && \(([\s\S]*?)<\/aside>/.exec(recordView)?.[1] ?? 'inset-0'));
/* A row unfolds when it is clicked. A press that both unfolded a row and closed the panel would read as the
 * page having a mind of its own, so a row is not empty space - and the row has to carry the mark that says
 * so, or the exclusion silently matches nothing. */
check('a row is not empty space, and carries the mark that says so',
  /\[role="button"\],\[data-row\]/.test(recordView) && /\s+data-row=""/.test(recTable));
check('nor is anything that does something on its own press',
  /closest\('a,button,input,select,textarea,label,\[role="checkbox"\]/.test(recordView));
/* Suspended while the wizard is open: the wizard is opened FROM the panel, and cancelling it should put you
 * back where you were rather than on the bare list. */
check('and it stands down while the wizard is open over it',
  /if \(!viewing \|\| wizardFor\) return;/.test(recordView)
    && /\}, \[viewing, wizardFor\]\);/.test(recordView));

group('wave 01: hover and note, on both paths or neither');
const brain = read('../api/_brain.mjs');
const engine = read('../web/src/lib/desktop-engine.ts');
const cloudStep = read('../api/_step.mjs');
const describer = read('../web/src/features/create/describe.ts');

/* The behaviour of both drivers is exercised for real in api/_test-step.mjs, which runs the cloud loop with
 * a scripted model. What CANNOT be exercised there is the browser driver - it is TypeScript inside the app -
 * so what this group protects is the thing that actually goes wrong when there are two of something: one of
 * them getting a branch the other did not. This codebase has been bitten by exactly that ("jpeg" instead of
 * "image/jpeg" in one of two places took every run down). */
check('the note branch exists in the cloud driver and in the browser driver',
  /if \(use\.name === 'note'\)/.test(cloudStep) && /if \(use\.name === 'note'\)/.test(engine));
check('both refuse a note behind a cut turn, because a note is a claim about what happened',
  /'note'\)[\s\S]{0,200}if \(cut\)[\s\S]{0,200}AFTER_CUT/.test(cloudStep)
    && /'note'\)[\s\S]{0,200}if \(cut\)[\s\S]{0,200}AFTER_CUT/.test(engine));
check('both answer in the same words, so the two paths teach one habit',
  /nothing waits on it/.test(cloudStep) && /nothing waits on it/.test(engine));
/* Not in `ran`, and that is the whole design: the batch rule is about actions that go stale with the
 * picture. A note counted as one would cut a turn having done nothing at all. */
check('and neither counts it as a machine action',
  !/ran\.push\('note'\)/.test(cloudStep) && !/ran\.push\('note'\)/.test(engine));

/* Hover needs no driver branch - it has a wire form - but it does need the batch rule, and it is the only
 * aimed action whose reason for being terminal is that it succeeded. */
check('hover has a wire form and it is the action the agent already had',
  /if \(name === 'hover'\)[\s\S]{0,120}action=move/.test(brain));
/* Membership, not the whole set: the exact composition is pinned once, in agent/test-contract.mjs, and
 * pinning it twice means every new terminal action breaks two tests in two files for one decision. What
 * matters here is that hover is in it. */
check('and nothing may follow it',
  /const TERMINAL = new Set\(\[[^\]]*'hover'[^\]]*\]\)/.test(brain));

/* One describer for the live feed and for history - see the note at the top of that file. A tool missing
 * from it does not break: it falls through to printing its own name, which is exactly how "note" would have
 * shown up as `note` with the text nowhere. */
check('both new tools read as sentences rather than as tool names',
  /case 'hover':/.test(describer) && /case 'note': \{/.test(describer));
check('and the note shows its text, since the text IS the step',
  /noted "\$\{written\.length > 72/.test(describer));
/* A fixture, because a branch no preview can reach is a branch nobody looks at. */
check('a run in the preview reaches both of them',
  /tool: 'hover'/.test(read('../web/src/dev/mock-api.ts'))
    && /tool: 'note'/.test(read('../web/src/dev/mock-api.ts')));

group('wave 02: the agent can hand something back, and will not drive itself');
const winAgent2 = read('../agent/mouseflow-agent.ps1');
const swiftAgent = read('../agent/mouseflow-agent.swift');

/* ONE RULE FOR AN ACTION'S ANSWER, in the brain, because the cloud path already forwarded a non-`done`
 * output and the browser path did not - the channel existed and one side ignored it. */
check('both drivers compose an answer through the same function',
  /export const actionSaid = /.test(brain)
    && /actionSaid\(got\.output,/.test(read('../api/_step.mjs'))
    && /actionSaid\(output, inert \? false : true, still\)/.test(engine));
/* The bug this condition exists to prevent: the browser driver rewrites inert answers at the END of a turn,
 * which would have overwritten a capture's path with "nothing changed on screen". */
check('and a reported fact is not overwritten by the end-of-turn rewrite',
  /if \(inert && \(output == null \|\| output === 'done'\)\) inertSaid\.push\(report\)/.test(engine));

/* Nothing new on the wire. `{"ok":true}` is still the whole reply for the eight actions that report
 * nothing, so an older deployment reading a newer agent sees exactly what it saw before. */
check('the agent adds output only when there is one',
  /said == null\s*\n\s*\? "\{\\"ok\\":true\}"/.test(winAgent2));
check('and the courier reports it the same way',
  /told == null \? "done" : told/.test(winAgent2));

/* CAPTURE BY WINDOW, not by screen, which is the entire point: in the run this came from, a terminal was
 * covering the dialog and every screen capture was a picture of the terminal. */
check('a window is asked to draw itself, so what is in front of it does not matter',
  /Native\.PrintWindow\(target, hdc, Native\.PW_RENDERFULLCONTENT\)/.test(winAgent2));
check('and when it will not, the photograph says it is a photograph',
  /would not draw itself, so this is a photograph of that patch/.test(winAgent2));
check('the picture goes to a file AND to the clipboard, because two callers want different halves',
  /shot\.Save\(path, System\.Drawing\.Imaging\.ImageFormat\.Png\)/.test(winAgent2)
    && /Clipboard\.SetImage\(copy\)/.test(winAgent2));
/* A run that captures thirty windows leaves thirty files. Pruned by age AND by count, because a hundred in
 * an hour is as much a runaway as a hundred over a month. */
check('captures do not accumulate forever',
  /i >= 200 \|\| files\[i\]\.LastWriteTimeUtc < cutoff/.test(winAgent2));

/* THE GUARD, and what makes it more than the first draft. GetConsoleWindow returns ZERO under Windows
 * Terminal - measured - so a guard built on it would have been inert in the one environment it was for. */
check('the guard walks the process chain rather than trusting a console window',
  /NtQueryInformationProcess/.test(winAgent2) && /static HashSet<int> OwnPids\(\)/.test(winAgent2));
check('it stops at the first host that owns a window, which is the terminal a person can see',
  /if \(ShowsAWindow\(host\)\) break;/.test(winAgent2));
/* And never one link further. explorer owns Progman and every File Explorer window, and wave 01 had just
 * finished teaching the model to use the desktop and the taskbar. */
check('and never crosses into the shell, whose windows are the desktop and the taskbar',
  /NotAHost = new string\[\] \{\s*\n\s*"explorer", "services"/.test(winAgent2));
check('a recycled process id cannot make an unrelated process count as the host',
  /if \(up\.StartTime > childStarted\) return 0;/.test(winAgent2));
/* Clicks, keys and activation are refused; a picture is not. Photographing the terminal changes nothing,
 * and is a reasonable thing to want when something has gone wrong in it. */
check('typing, keys, pointing and activation are all guarded',
  /if \(action == "type" \|\| action == "key"\)[\s\S]{0,200}Mine\(Native\.GetForegroundWindow\(\)\)/.test(winAgent2)
    && /Mine\(Native\.WindowFromPoint/.test(winAgent2)
    && /IntPtr wanted = WindowMatching\([\s\S]{0,160}Mine\(wanted\)/.test(winAgent2));
check('but capturing it is not, because a picture changes nothing',
  /Deliberately NOT guarded by Mine\(\)/.test(winAgent2));

/* ONE WINDOW LOOKUP for three callers, rather than the copy that activating a window used to keep. */
check('one window lookup, shared by activating, capturing and refusing',
  /public static IntPtr WindowMatching\(string title, string process\)/.test(winAgent2)
    && (winAgent2.match(/Native\.EnumWindows\(delegate/g) || []).length <= 4);

/* http and https only, and a NAME rather than a command line. Neither is a security boundary - the model can
 * already open a terminal by clicking one - and the comments say so rather than implying otherwise. */
check('only the web can be opened by url',
  /parsed\.Scheme != Uri\.UriSchemeHttp && parsed\.Scheme != Uri\.UriSchemeHttps/.test(winAgent2));
check('and an application is opened by name, never by path or with arguments',
  /a NAME, not a path or a command line/.test(winAgent2)
    && /cannot pass it arguments/.test(winAgent2));
check('which the code admits is a narrowing rather than a boundary',
  /WHAT THIS IS NOT is a security boundary/.test(winAgent2));

/* macOS HAD none of the four and named them rather than calling them unknown - a model told "no such action"
 * improvises, and improvising is how a run ended up writing itself a screen-capture tool in a terminal. Now
 * it has them, and the refusal is gone WITH the implementation rather than in a later pass: a refusal left
 * standing beside a live action rejects a working action, which is the worse of the two failures. */
check('macOS implements the four rather than naming them',
  /case "capture":/.test(swiftAgent) && /case "clipread":/.test(swiftAgent)
    && /case "clipwrite":/.test(swiftAgent) && /case "open":/.test(swiftAgent));
check('and no refusal is left standing beside a live implementation',
  !/not implemented on the macOS agent yet/.test(swiftAgent));

check('and the preview reaches the new steps',
  /tool: 'capture_window'/.test(read('../web/src/dev/mock-api.ts'))
    && /tool: 'open_url'/.test(read('../web/src/dev/mock-api.ts')));
check('which read as sentences rather than as tool names',
  /case 'capture_window':/.test(describer) && /case 'open_url':/.test(describer)
    && /case 'clipboard_write': \{/.test(describer));

group('wave 03: the agent can be asked what is on screen, by name');
const winAgent3 = read('../agent/mouseflow-agent.ps1');

/* THE RULE THIS BENDS, and the measurement that permits it. PROTOCOL.md forbids walking a window's tree at
 * 0.6-4.4s per window, and that number is about a RECURSION from the agent's own process - one cross-process
 * call per element - which is still slow. A single FindAll with the condition on the provider's side is a
 * different call, and the numbers are in the code rather than in somebody's memory. */
check('the search is one call with the condition on the provider side, not a recursion',
  /root\.FindAll\(TreeScope\.Descendants, what\)/.test(winAgent3)
    && /IsControlElementProperty, true/.test(winAgent3));
/* Reading the four wanted properties afterwards is a cross-process call per property per element: measured
 * at 2.0-2.7s against 570-850ms with them asked for up front. */
check('and the properties it needs are asked for up front rather than read one by one',
  /CacheRequest wanted = new CacheRequest\(\)/.test(winAgent3)
    && /GetCachedPropertyValue\(\s*AutomationElement\.BoundingRectangleProperty\)/.test(winAgent3));

/* AN APPLICATION CAN STOP ANSWERING ENTIRELY - dbForge did, mid-session, from any thread. So there is a
 * deadline; and because an abandoned thread stays blocked, the window that missed it is muted rather than
 * asked again. */
check('a search has a deadline',
  /if \(!worker\.Join\(budgetMs\)\)/.test(winAgent3));
check('the window that missed it is muted by handle rather than asked again',
  /_mute\[hwnd\] = DateTime\.UtcNow\.AddSeconds\(60\)/.test(winAgent3));
/* THE FIRST FIX WAS WORSE THAN THE LEAK: a single global lock meant one hung application refused reads of
 * every other window for the rest of the session. Measured on this machine, and written down so nobody
 * reintroduces it. */
check('and NOT by a global lock, which poisoned every other window',
  /WORSE\s*\n\s*\* THAN THE LEAK/.test(winAgent3) && /_stuck\) >= 3/.test(winAgent3));
check('the mute list is pruned, so a long session cannot grow it',
  /if \(entry\.Value <= DateTime\.UtcNow\) over\.Add\(entry\.Key\)/.test(winAgent3));

/* COORDINATES OUT, and this is the one place the agent converts them - because these actions answer with
 * positions, which has never had a home, and the alternative is two coordinate systems in one conversation. */
check('the agent answers in screenshot pixels, from the geometry the deployment sends',
  /static void ReadGeometry\(Dictionary<string, string> a\)/.test(winAgent3)
    && /const geometry = \(\) => `scale=\$\{frame\.scale \|\| 1\}/.test(brain));
check('and says so where somebody would look for the rule',
  /SCREEN PIXELS OUT, SCREENSHOT PIXELS IN/.test(winAgent3));

/* AMBIGUITY IS REPORTED, NOT RESOLVED. Two controls with the same name is a fact the model needs before it
 * clicks; picking one silently is how a click lands on the wrong row. */
check('several matches are listed rather than one being chosen',
  /so the name alone does not say which/.test(winAgent3));
check('and nothing matching says what to do next',
  /Read the window to see \"?\n?\s*\+? ?\"?what it does call things/.test(winAgent3)
    || /what it does call things/.test(winAgent3));

/* scroll_to reuses find rather than reimplementing the same exact-then-contains rule, so "scroll to it" and
 * "is it there" cannot disagree about whether it is there. */
check('scroll_to asks find whether it has arrived, rather than deciding for itself',
  /Reusing find, not reimplementing it/.test(winAgent3));
/* A scroll that gave up must not read as one that arrived. */
check('and a scroll that ran out of bursts says so',
  /which is as far as one scrollto goes/.test(winAgent3));

/* A drag could not be composed: click always sent the press and the release together. Interpolated because
 * an application reads the movement in between to decide what is happening. */
/* Подпись больше не цитируется целиком: их две - четырёхаргументная делегирует пятиаргументной, чтобы ни
 * одному вызывающему не пришлось меняться, - а нажатие несёт модификатор. Утверждение то же: нажимает,
 * идёт шагами, отпускает. */
check('a drag presses, moves in steps, and releases',
  /static string Drag\(int x1, int y1, int x2, int y2, string mods\)/.test(winAgent3)
    && /Emit\(At\(x1, y1, "Left Click Down", mods\)\)/.test(winAgent3)
    && /Emit\(At\(ix, iy, "Mouse Movement"\)\)/.test(winAgent3)
    && /Emit\(At\(x2, y2, "Left Click Release"\)\)/.test(winAgent3));
/* И старая подпись жива, потому что у неё есть вызывающие - повтор и courier зовут перетаскивание без
 * модификатора, и их не пришлось трогать. */
check('and the plain four-argument call still exists for everything that had it',
  /static string Drag\(int x1, int y1, int x2, int y2\) \{ return Drag\(x1, y1, x2, y2, null\); \}/
    .test(winAgent3));
check('and the guard covers both of its ends',
  /string minedTarget = Mine\(Native\.WindowFromPoint\(new POINT \{ X = tx, Y = ty \}\)\)/.test(winAgent3));

/* WHAT THIS ASSERTED, AND WHY IT CHANGED. Wave 03 lifted the movement threshold into one definition because
 * the courier and scroll_to had started asking it separately - the right move against a copy that drifts.
 * What it got wrong was assuming the two callers were asking the SAME question. They were not: the courier
 * asks "did anything happen" after an action, and scroll_to asks "has it stopped" - and one threshold cannot
 * be biased both ways. A run was stopped for typing fifteen characters because of it.
 *
 * So there are two definitions now, still one each, and the invariant this holds is the one that mattered
 * all along: no caller carries its own copy. */
check('each question has exactly one definition, and no caller copies it',
  /public static bool GridStirred\(byte\[\] a, byte\[\] b\)/.test(winAgent3)
    && /public static bool GridQuiet\(byte\[\] a, byte\[\] b\)/.test(winAgent3)
    && /static bool Moved\(byte\[\] a, byte\[\] b\) \{ return Agent\.GridStirred\(a, b\); \}/.test(winAgent3));

check('the preview reaches the new steps, and they read as sentences',
  /tool: 'read_window'/.test(read('../web/src/dev/mock-api.ts'))
    && /tool: 'drag'/.test(read('../web/src/dev/mock-api.ts'))
    && /case 'find_element':/.test(describer) && /case 'scroll_to':/.test(describer));

group('wave 04: sideways, and no more silent under-delivery');
const winAgent4 = read('../agent/mouseflow-agent.ps1');

/* THE HOLE HAD THREE SIDES, and only a sweep finds that shape: a person's sideways scroll was never
 * recorded, a recording carrying one could not be replayed, and no action could command one - while the
 * transcript had been parsing "Scroll Left" and "Scroll Right" all along. All three are closed here, and the
 * test names all three, because closing two of them would look like closing it. */
check('a sideways scroll can be RECORDED',
  /case Native\.WM_MOUSEHWHEEL:/.test(winAgent4)
    && /action = wheel >= 0 \? "Scroll Right" : "Scroll Left"/.test(winAgent4));
check('and REPLAYED',
  /case "Scroll Right": flags \|= Native\.MOUSEEVENTF_HWHEEL; data = 120; break;/.test(winAgent4)
    && /case "Scroll Left": flags \|= Native\.MOUSEEVENTF_HWHEEL/.test(winAgent4));
check('and COMMANDED',
  /if \(dir == "left"\) which = "Scroll Left";/.test(winAgent4)
    && /dir=\$\{input\.direction\}/.test(brain));
/* Positive is RIGHT for the horizontal wheel and UP for the vertical one - opposite conventions, and getting
 * it backwards would record every sideways scroll as its mirror image. */
check('with the sign convention written down, because it is the opposite of the vertical wheel',
  /Positive is RIGHT here, which is the opposite convention/.test(winAgent4));
/* And the old reading survives: a caller that sends no direction gets exactly what it always got. */
check('and a caller that sends no direction is unaffected',
  /else which = amount > 0 \? "Scroll Up" : "Scroll Down";/.test(winAgent4));

/* UNDER-DELIVERY PRESENTED AS SUCCESS: Math.Min(20, ...) plus {"ok":true}. Same sin the transcript has a
 * long note about, one file along. The fix is the report, not the cap. */
check('a scroll that delivered fewer notches than asked says so',
  /scrolled " \+ steps\.ToString\(CultureInfo\.InvariantCulture\) \+ " notches, not "/.test(winAgent4));
check('and the silent clamp at twenty is gone',
  !/Math\.Min\(20, Math\.Abs\(amount\)\)/.test(winAgent4));

/* refresh_page is not a new capability - F5 was always reachable - it is three model turns collapsed into
 * one, and the waiting is the part worth having. */
check('a reload activates, presses F5 and waits',
  /string refused = PressKey\("f5", false, false, false, false\);/.test(winAgent4)
    && /bool quiet = SettleHere\(20000, out waited\);/.test(winAgent4));
/* The SETTLING question, which is the insensitive one - see the note beside GridStirred for why a reload
 * must not use the same test an action report uses. */
check('using the same settling threshold as every other wait',
  /if \(last != null && now != null && GridQuiet\(last, now\)\)/.test(winAgent4));
/* "It did not appear" is an answer about the world. Reported as a failure, a model looks for a fault in the
 * waiting rather than in its own expectation. */
check('a window that never appears is an answer, not an error',
  /NOT an error: "it did not appear" is an answer about the world/.test(winAgent4));

/* Win was in the table as a KEY since 0.7.0 and there was no way to HOLD it, so Win+D, Win+E, Win+L and
 * Win+arrow were all unreachable - and a watched run degraded Win+Shift+S into typing a capital S. */
check('Win is a modifier now, released last so the Start menu is not left open',
  /static string PressKey\(string key, bool ctrl, bool shift, bool alt, bool win\)/.test(winAgent4)
    && /if \(win\) SendVk\(0x5B, true\);/.test(winAgent4));
check('and a recorded chord naming it replays as that chord',
  /else if \(mod == "win" \|\| mod == "cmd"\) wantWin = true;/.test(winAgent4));
check('the four F-keys the description used to promise now exist',
  /case "f7": return 0x76;/.test(winAgent4) && /case "f10": return 0x79;/.test(winAgent4));
check('and PrintScreen, under both names people call it',
  /case "printscreen": case "prtsc": case "snapshot": return 0x2C;/.test(winAgent4));
/* The description no longer lists absences, because there are none left - and it points at capture_window,
 * which is a better screenshot than any key. */
check('press_key stops listing what it cannot do, and points at the better route',
  !/NOT available: F7-F10/.test(brain) && /use capture_window rather than/.test(brain));

check('the preview reaches the new steps, and they read as sentences',
  /direction: 'right'/.test(read('../web/src/dev/mock-api.ts'))
    && /tool: 'wait_for_window'/.test(read('../web/src/dev/mock-api.ts'))
    && /case 'refresh_page':/.test(describer) && /input\.win && 'Win'/.test(describer));

group('a recording does not collect other people\'s words');
/* `names` is taken at the top of this file for the tool list; this module needs its own handle. */
const nameRules = await import('../api/_names.mjs');
const { gridStirred, gridQuiet, earlierRuns, openingMessage, EARLIER_RUNS } =
  await import(new URL('../api/_brain.mjs', import.meta.url).href);
/* `transcribe` is imported further down this file, and a const is not hoisted - so this group takes its
 * own handle rather than reaching forward to one that does not exist yet. */
const { transcribe: readBack } = await import(new URL('../api/_transcript.js', import.meta.url).href);
const privacyTranscript = read('../api/_transcript.js');
const privacyAgent = read('../agent/mouseflow-agent.ps1');

/* A WINDOW TITLE THAT IS AN ADDRESS LOSES ITS QUERY, which is where a sign-in token lives. Seen in a real
 * recording: auth.doubleword.ai/u/login?state=hKFo2SAw… - and PageUrl had been cutting exactly this off the
 * `url` field all along, on exactly this argument. */
check('a sign-in url in a title keeps its origin and path and loses the token',
  nameRules.plainTitle('auth.doubleword.ai/u/login?state=hKFo2SAwNTh5Q2dOX2cOWVBSZkxfVy15Vk')
    === 'auth.doubleword.ai/u/login');
check('with the scheme kept when the title had one',
  nameRules.plainTitle('https://accounts.google.com/o/oauth2/auth?client_id=1&scope=email')
    === 'https://accounts.google.com/o/oauth2/auth');
/* ONLY when the whole title is an address. A question mark in a sentence is punctuation, and cutting at it
 * would mangle every ordinary window. */
check('but a sentence with a question mark in it is left exactly alone',
  nameRules.plainTitle('What is a good name? - Google Search') === 'What is a good name? - Google Search');
check('and so is every title that is not an address',
  ['Chat | Devart BU Leaders | Microsoft Teams', 'Inbox - Outlook', 'report.xlsx - Excel']
    .every((t) => nameRules.plainTitle(t) === t));
check('the agent cuts it at RECORDING time as well, so it never reaches the account',
  /static string BareTitle\(string title\)/.test(privacyAgent)
    && /string bare = BareTitle\(title\);/.test(privacyAgent));

/* A NAME TOO LONG TO BE A LABEL IS CONTENT. Measured, and the measurement is in both files rather than in
 * somebody's memory: 43 characters was the longest name on anything a person presses. */
check('the agent stops recording a name over sixty characters, and writes its length',
  /const int NameMax = 60;/.test(privacyAgent)
    && /target\.NameLength = name\.Length;/.test(privacyAgent));
/* Never both: an older reader sees a step with a type and no name, which is what it would have shown for an
 * unnamed control and is safe. */
/* An `else`, not a second `if`: otherwise an older reader would see a step carrying BOTH a name and a
 * length, and the whole point is that the name is gone. */
check('and never both the name and the length',
  /sb\.Append\(e\.Control\); \}[\s\S]{0,380}else if \(e\.NameLength > 0\)/.test(privacyAgent));
check('the reader applies the same rule, because older recordings already hold the text',
  /const NAME_MAX = 60;/.test(privacyTranscript)
    && /function nameOrLength\(name, said\)/.test(privacyTranscript));

/* And through the real transcript, both ways round. */
{
  const message = 'Привет, та такие конторы обычно данные потом у себя сторят, а потом их сливают куда '
    + 'попало — Дима не захочет с этим связываться, я почти уверен';
  const clicks = (context) => ([
    { action: 'Left Click Down', x: 500, y: 400, delayMs: 0, context },
    { action: 'Left Click Release', x: 500, y: 400, delayMs: 20, context },
  ]);
  const run = (context) => readBack({
    source: 'desktop', kind: 'recorded', name: 'x',
    payload: { recorder: { version: '0.13.0' }, windows: [], events: clicks(context) },
  });

  const old = run({ app: 'ms-teams', window: 'Chat', control: message, type: 'group' });
  check('a recording made BEFORE the agent stopped collecting it does not show the message',
    !JSON.stringify(old).includes('сторят'));
  check('and says what it was instead',
    /clicked a group holding \d+ characters of text \(not recorded\)/
      .test(old.segments?.[0]?.steps?.[0]?.what ?? ''),
    old.segments?.[0]?.steps?.[0]?.what);

  const fresh = run({ app: 'OUTLOOK', window: 'Inbox', nameLength: '283', type: 'option' });
  check('and a recording made after it reads the length the agent sent',
    /clicked an option holding 283 characters of text/.test(fresh.segments?.[0]?.steps?.[0]?.what ?? ''),
    fresh.segments?.[0]?.steps?.[0]?.what);
  /* NOT RECORDED IS NOT UNKNOWN. Saying "nothing there had a name" would be false twice: it did have one,
   * and the reason it is absent is a decision. A reader told the wrong thing goes hunting for a fault. */
  check('the note says it was a decision rather than a failure to read',
    /does not record that/.test(fresh.segments?.[0]?.steps?.[0]?.note ?? ''),
    fresh.segments?.[0]?.steps?.[0]?.note);
  check('and it does NOT claim the application named nothing',
    !/nothing there had a name/.test(fresh.segments?.[0]?.steps?.[0]?.note ?? ''));

  /* The 60 is a threshold, not a ban on names: a label still reads as a label. */
  check('a real label of any ordinary length is untouched',
    run({ app: 'ms-teams', window: 'Chat', control: 'Send', type: 'button' })
      .segments?.[0]?.steps?.[0]?.what === 'clicked the "Send" button in ms-teams');

  const auth = run({
    app: 'chrome',
    window: 'auth.doubleword.ai/u/login?state=hKFo2SAwNTh5Q2dOX2cOWVBSZkxfVy15Vk',
    control: 'Sign up',
    type: 'button',
  });
  check('and a sign-in token in a title does not survive the transcript either',
    !JSON.stringify(auth).includes('hKFo2SAw')
      && auth.segments?.[0]?.where?.label === 'auth.doubleword.ai/u/login',
    auth.segments?.[0]?.where?.label);
}

group('what a failed run showed: a dialog is a window, and a text edit is a change');
const traceAgent = read('../agent/mouseflow-agent.ps1');
const traceBrain = read('../api/_brain.mjs');
const traceEngine = read('../web/src/lib/desktop-engine.ts');

/* A MODAL DIALOG IS AN OWNED WINDOW. Both the lookup and the list skipped owned windows, so
 * `capture_window title=About` answered "no open window matches" with the About dialog on screen in front of
 * the model - and the list could not even tell it the title to ask for. Watched on a live desktop:
 *   OWNED  WindowsForms10...  dbforgesql  About dbForge Studio for SQL Server */
check('the window lookup no longer skips owned windows',
  !/if \(found != IntPtr\.Zero\) return false;\s*\n\s*if \(!Native\.IsWindowVisible\(hWnd\)\) return true;\s*\n\s*if \(Native\.GetWindow\(hWnd, Native\.GW_OWNER\)/
    .test(traceAgent));
check('nor does the list of what is open',
  !/if \(!Native\.IsWindowVisible\(hWnd\)\) return true;\s*\n\s*if \(Native\.GetWindow\(hWnd, Native\.GW_OWNER\) != IntPtr\.Zero\) return true;\s*\n\s*int length/
    .test(traceAgent));
check('and a dialog is reported as one, because that is usually the most important line in the list',
  /dialog\\":/.test(traceAgent) && /w\.dialog \? 'dialog, ' : ''/.test(traceBrain));
/* Said in the prompt too, or the model has the fact and not the habit. */
check('the model is told a dialog is a window it can name',
  /A DIALOG IS A WINDOW/.test(traceBrain));

/* A REGION CAPTURE ANSWERED IN SCREEN PIXELS while read_window answers in screenshot pixels - two coordinate
 * systems in one conversation, and a watched run spent a step correcting itself over it. */
check('a capture carries the geometry it answers in',
  /return `action=capture \$\{geometry\(\)\}/.test(traceBrain)
    && /ReadGeometry\(a\);\s*\n\s*int rx = 0/.test(traceAgent.replace(/\/\*[\s\S]*?\*\//g, '')));
check('and reports a region in those coordinates rather than in screen pixels',
  /what = "the region " \+ ToShotSize\(rw\)/.test(traceAgent));

/* ONE FINGERPRINT, TWO OPPOSITE QUESTIONS. This is the one that killed the run: typing fifteen characters
 * measures a mean of 0.049 over 2304 cells, so `mean > 3` read it as nothing happening - six times, and the
 * run stopped while it was working. */
check('there are two predicates now, not one threshold serving both',
  /export const gridStirred = /.test(traceBrain) && /export const gridQuiet = /.test(traceBrain));
check('the action report asks whether anything happened',
  /!gridStirred\(before, after\)/.test(traceEngine)
    && /static bool Moved\(byte\[\] a, byte\[\] b\) \{ return Agent\.GridStirred\(a, b\); \}/.test(traceAgent));
check('and the waits ask whether it has stopped',
  /if \(last && gridQuiet\(last, now\)\)/.test(traceEngine)
    && /GridQuiet\(last, now\)/.test(traceAgent) && /GridQuiet\(before, after\)/.test(traceAgent));
/* The numbers must match on both sides of the wire, because the browser driver and the agent each measure
 * their own fingerprint and a model must not be told different things by the two paths. */
check('the two sides agree on the numbers',
  /export const STIR_LEVEL = 8;/.test(traceBrain) && /export const STIR_CELLS = 1;/.test(traceBrain)
    && /const int StirLevel = 8;/.test(traceAgent) && /const int StirCells = 1;/.test(traceAgent));
/* And the measurements are written down, because the next person to tune one of these numbers needs to know
 * what an idle screen and a text edit actually measure rather than guessing again. */
check('with the table they were read off, not just the values',
  /idle, a caret blinking in it/.test(traceBrain) && /typed "dbForge Testing"/.test(traceBrain));

/* The predicates themselves, on grids rather than on source. */
{
  const grid = (fill) => new Uint8Array(2304).fill(fill);
  /* Wrapped, because `i * 37` runs off the end after 62 steps - the first version of this asked for 2304
   * changed cells and got 62, which made "moved everywhere" quiet and the test wrong rather than the rule. */
  const bump = (base, cells, by) => {
    const out = new Uint8Array(base);
    for (let i = 0; i < cells; i++) {
      const at = (i * 37) % base.length;
      out[at] = Math.min(255, (base[at] ?? 0) + by);
    }
    return out;
  };
  const flat = grid(120);
  check('one cell changing strongly is something happening, which is what a text edit looks like',
    gridStirred(flat, bump(flat, 1, 30)) === true);
  check('but a whole grid drifting by dither is not',
    gridStirred(flat, bump(flat, 2304, 4)) === false);
  /* The other question, and the opposite bias: a screen nudged in one cell has still settled. */
  check('and a screen that moved one cell counts as settled for a wait',
    gridQuiet(flat, bump(flat, 1, 30)) === true);
  check('while one that moved everywhere does not',
    gridQuiet(flat, bump(flat, 2304, 40)) === false);
  check('an unreadable fingerprint is movement, and is NOT quiet - the two defaults differ on purpose',
    gridStirred(null, flat) === true && gridQuiet(null, flat) === false);
}

group('a shortcut is a keycode, and both halves read the same modifiers');
const kbWin = read('../agent/mouseflow-agent.ps1');
const kbMac = read('../agent/mouseflow-agent.swift');

/* THE MEASUREMENT THAT NAMED IT: with a Russian layout active, VkKeyScan refuses every Latin letter, so
 * every letter shortcut on the machine was "unknown key". And with a Latin layout it reported the modifiers
 * that CHARACTER needs, so an uppercase V added Shift and Ctrl+V went out as Ctrl+Shift+V - which Google
 * Docs reads as paste-without-formatting and which drops an image in silence. */
check('a letter resolves to its keycode rather than through the layout',
  /if \(one >= 'a' && one <= 'z'\) return \(ushort\)\(one - 'a' \+ 0x41\);/.test(kbWin)
    && /if \(one >= 'A' && one <= 'Z'\) return \(ushort\)\(one - 'A' \+ 0x41\);/.test(kbWin));
check('and so does a digit',
  /if \(one >= '0' && one <= '9'\) return \(ushort\)\(one - '0' \+ 0x30\);/.test(kbWin));
/* Case must not become a modifier: `key=V ctrl=1` is Ctrl+V, and Ctrl+Shift+V is a different instruction. */
check('and case never turns into a Shift the caller did not ask for',
  /if \(\(one >= 'a' && one <= 'z'\) \|\| \(one >= 'A' && one <= 'Z'\) \|\| \(one >= '0' && one <= '9'\)\) return;/
    .test(kbWin));
/* VkKeyScan is still right where the layout genuinely decides. */
check('but punctuation still goes through the layout, because there it is the only thing that knows',
  /short scan = Native\.VkKeyScan\(one\);/.test(kbWin));
check('with the measurement written down rather than the conclusion alone',
  /'a' -> -1    'A' -> -1    'c' -> -1    'v' -> -1/.test(kbWin));

/* macOS never had that bug - Carbon keycodes are physical positions. It had the mirror: a modifier field
 * that one half sent and the other did not read, so Win+D arrived as a bare D. */
check('macOS resolves letters from a fixed keycode table, not a layout',
  /"a": 0, "b": 11, "c": 8/.test(kbMac) && /"v": 9/.test(kbMac));
check('and it reads the win field the Windows half sends',
  /win: \(fields\["win"\] \?\? "0"\) == "1"/.test(kbMac));
/* REFUSED rather than mapped onto Command: Win+D and Cmd+D are different instructions, and a chord that
 * quietly means something else is worse than one that says it cannot be pressed. */
check('refusing it rather than turning it into a different shortcut',
  /if win \{ return NO_SUCH_KEY_HERE\["win"\] \}/.test(kbMac)
    && /there is no Windows key on macOS/.test(kbMac));
check('and the mirror: Windows reads cmd and meta onto its own command modifier',
  /Get\(a, "ctrl", "0"\) == "1" \|\| Get\(a, "cmd", "0"\) == "1" \|\| Get\(a, "meta", "0"\) == "1"/.test(kbWin));
/* The replay path calls the same function, and replaying the REMAINDER of a chord is replaying a different
 * chord - which is how a Win+D recording would have become a D. */
check('the replay path carries it too, on both sides',
  /win: mods\.contains\("win"\)/.test(kbMac)
    && /else if \(mod == "win" \|\| mod == "cmd"\) wantWin = true;/.test(kbWin));

/* THE INVARIANT THAT STOPS THIS DRIFTING AGAIN: every key name one platform accepts is either accepted by
 * the other or REFUSED BY NAME there. A name that exists on one side and falls through to "no key called
 * that" on the other is how a skill made on Windows fails on a Mac for a reason nobody can read. */
{
  const winNames = [...kbWin.matchAll(/case "([a-z0-9]+)":/g)].map((m) => m[1]);
  const macTable = /let KEY_CODES: \[String: CGKeyCode\] = \[([\s\S]*?)\n\]/.exec(kbMac)?.[1] ?? '';
  const macRefused = /let NO_SUCH_KEY_HERE: \[String: String\] = \[([\s\S]*?)\n\]/.exec(kbMac)?.[1] ?? '';
  const known = new Set([
    ...[...macTable.matchAll(/"([a-z0-9]+)":/g)].map((m) => m[1]),
    ...[...macRefused.matchAll(/"([a-z0-9]+)":/g)].map((m) => m[1]),
  ]);
  const orphans = winNames.filter((n) => !known.has(n));
  check('every key Windows names is either known on macOS or refused there BY NAME',
    winNames.length > 20 && orphans.length === 0,
    `windows knows ${winNames.length}; unaccounted for on macOS: ${orphans.join(', ') || 'none'}`);
}

group('a run is told what the account did just before it');
{
  /* WHY: a request that began "now - ask a question ... and add it into the document" had nothing to point
   * at. The loop is handed the goal text and nothing else, so "now" and "the document" referred to a run it
   * could not see, and the person had to paste the link by hand. */
  const at = Date.parse('2026-08-28T13:30:00Z');
  const runs = [
    { goal: 'ask the AI Assistant who is he', outcome: 'ok', summary: 'Asked it and recorded the answer.',
      steps: [{ tool: 'open_url', input: { url: 'https://docs.google.com/document/d/1KC4bS/edit?tab=t.0' } }],
      startedAt: '2026-08-28T13:05:00Z', finishedAt: '2026-08-28T13:12:00Z' },
    { goal: 'create a google doc called dbForge Testing', outcome: 'ok', summary: 'Created it.',
      steps: [{ tool: 'open_url', input: { url: 'https://docs.new' } }],
      startedAt: '2026-08-28T12:20:00Z', finishedAt: '2026-08-28T12:41:00Z' },
    { goal: 'rename the sheet', outcome: 'failed', error: 'the picker never loaded', steps: [],
      startedAt: '2026-08-27T09:00:00Z', finishedAt: '2026-08-27T09:01:00Z' },
    { goal: 'the fourth, which must not appear', outcome: 'ok', steps: [],
      startedAt: '2026-08-26T09:00:00Z' },
  ];
  const block = earlierRuns(runs, at);
  check('it carries the goal, how long ago, and how it ended',
    /18 minutes ago, finished: ask the AI Assistant who is he/.test(block)
      && /1 day ago, did not finish: rename the sheet/.test(block), block);
  check('and what the run said, which is where the useful detail is',
    /it said: Created it\./.test(block));
  /* THREE, which is what the person whose runs they are chose. A fourth appearing would be a quiet decision
   * about somebody's prompt size and somebody's privacy. */
  check('exactly three, never a fourth', !/fourth/.test(block) && EARLIER_RUNS === 3);
  /* Query strings cut off, the same rule and the same reason as everywhere else here: that is where a
   * session token and a one-time sign-in link live. */
  check('addresses keep origin and path and lose the query',
    /https:\/\/docs\.google\.com\/document\/d\/1KC4bS\/edit/.test(block) && !/tab=t\.0/.test(block));
  check('and nothing at all when there is nothing before', earlierRuns([]) === null
    && earlierRuns(null) === null);

  /* WHERE IT SITS. Whatever comes first is read as the task, so this goes after the goal - and is labelled
   * twice, because a previous goal is still not this goal and a model that treats it as one carries out
   * last week's work again. */
  const msg = openingMessage('add Test Case 3', null, null, null, block);
  check('the goal is still the first thing in the message', msg.content.startsWith('add Test Case 3'));
  check('and the background says it is background, not an instruction',
    /background, NOT instructions/.test(msg.content));
  check('with nothing added when there is no background',
    openingMessage('do a thing', null, null, null, null).content === 'do a thing');
}
/* BOTH DRIVERS, or the two paths teach the model different habits about the same account. The cloud one
 * reads it from the account; the browser one passes what the app is already holding. */
check('the cloud driver reads the account own runs, and only those',
  /where user_id = \$\{who\.id\} and deleted_at is null and kind = 'agent'/.test(read('../api/mcp.js'))
    && /limit \$\{EARLIER_RUNS\}/.test(read('../api/mcp.js')));
check('and never fails a run over background it could not fetch',
  /\.catch\(\(\) => null\);/.test(read('../api/mcp.js')));
check('the browser driver passes what it already has',
  /earlier: runs\.filter\(\(run\) => run\.kind === 'agent'\)/.test(read('../web/src/features/create/CreateView.tsx')));
/* A wave rebuilds the conversation from scratch, so background not kept on the loop would vanish in wave two
 * - which is the wave most likely to go looking for something it has forgotten exists. */
check('and a second wave still has it',
  /earlier: earlier \? String\(earlier\) : null,/.test(read('../api/_step.mjs'))
    && /loop\.earlier \|\| null\)\];/.test(read('../api/_step.mjs')));

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
const { choiceRuns, isContainerClick, isOwnRecorderControl } = await import('../api/_choices.mjs');

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
    && /<\/label>[\s\S]{0,400}\{askable[\s\S]{0,120}<WhatWasTyped/.test(wizard));
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
  && /lines \?\? \[\]\)\.filter\(\(line\) => worthShowing\(line, hushed\)\)\.map\(\(line\) => line\.n\)/.test(wizard));
/* A scroll IS describable and still is not worth a line: this kind of skill is carried out by a model
 * reading the screen, which scrolls when it needs to see something. One recording here held 1,732 wheel
 * notches. */
check('a scroll is folded away with the rest, not put in front of somebody',
  /describable\(line\) && line\.action !== 'scroll'/.test(wizard));
check('and it is not in the skill by default either, so hidden means left out',
  /setKept\(new Set\(flat\.filter\(\(l\) => worthShowing\(l, hushed\)\)/.test(wizard));
check('the fold says scrolls are among what it holds',
  /scrolls, clicks on things with no name/.test(wizard));

/* Every recording started from the app ends with a click on MouseFlow's own Stop button. That click is
 * bookkeeping ABOUT the recording, not part of the work - and a skill repeating it presses Stop on a
 * recorder nobody started, which is what the first goal skill made here actually did.
 *
 * ПРОВЕРЯЕТСЯ ВЫЗОВОМ, а не регуляркой по .tsx, и переехало это ровно из-за той ошибки, которую регулярка
 * поймать не могла: список сравнивался НА РАВЕНСТВО, а панель задач Windows отдаёт имя кнопки как имя
 * приложения плюс заголовок окна. Пины видели в файле нужные строки и были зелёными, пока в скилл ехал
 * последний шаг «нажать стоп». */
check('MouseFlow’s own recorder controls are folded away too',
  /!isOwnRecorderControl\(line\)/.test(wizard)
    && isOwnRecorderControl({ control: 'Stop and save this recording' })
    && isOwnRecorderControl({ control: 'Start recording' }));
check('and the tray item as the taskbar actually hands it over — the app name glued to the window title',
  /* Замерено на rn3l06nya, шаг 71: right-clicked the "MouseFlow agent MouseFlow agent - recording" button. */
  isOwnRecorderControl({ control: 'MouseFlow agent MouseFlow agent - recording' })
    && isOwnRecorderControl({ control: 'MouseFlow agent - recording' })
    && isOwnRecorderControl({ control: 'MouseFlow agent' }));
/* Narrow on purpose: a click on "Make a skill" or "Delete" is somebody USING the app - unlikely to be the
 * task, but at least something they did. Stopping the recording is the one action guaranteed not to be. */
check('and only the recorder’s controls, not everything in MouseFlow',
  !isOwnRecorderControl({ control: 'Make a skill' })
    && !isOwnRecorderControl({ control: 'Delete' })
    && !isOwnRecorderControl({ control: 'Next' })
    && !isOwnRecorderControl({ control: '' })
    && !isOwnRecorderControl({}));
/* Matching our OWN labels is safe where matching a platform's control type is not: these are not translated
 * — which is why the strings were taken from the app's and both agents' source rather than invented. */
check('the tray label is the one the Windows agent actually sets',
  read('../agent/mouseflow-agent.ps1').includes('"MouseFlow agent - recording"'));

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
  /overSpend\(sql, who\.id, 'compose'\)/.test(composeApi));
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
    && /\$\{goalCapable\}/.test(mcpApi)
    && /claimerSaysSteps = !!\(req\.body && req\.body\.steps === true\)/.test(mcpApi));
/* There is one mouse, and both claimers long-poll the same endpoint: whichever asked first used to take
 * the job. The agent wins now - a reversal of the plan, on the grounds that the worker is the install step
 * this whole change removes, and leaving it in front means the new path never runs on a machine that has
 * one. A worker alone is unaffected, and takes goals again by itself if the agent stops asking. */
check('when both are listening, the worker is not offered a goal',
  /const claimerSteps = claimerIsWorker \? !stepperListening : claimerSaysSteps/.test(mcpApi));
/* ТРЕТИЙ ЗАБИРАЮЩИЙ НЕ УЧАСТВУЕТ В ЭТОМ СТАРШИНСТВЕ: расширение на своей поверхности одно, и правило
 * «когда слушают оба, воркеру цель не дают» про мышь, которая у него общая с агентом. Отдельной строкой
 * именно поэтому - слить их значило бы, что браузер начнёт отбирать работу у десктопа или наоборот. */
check('и браузер умеет цели сам, потому что несёт свою модель',
  /const goalCapable = claimerSteps \|\| browserDoesGoals;/.test(mcpApi)
    && /const browserDoesGoals = claimerIsBrowser;/.test(mcpApi));
check('и свободная цель уезжает только на ту поверхность, которая её выполнит',
  /flowId: BROWSER_GOAL/.test(mcpApi)
    && /then q\.flow_id = \$\{BROWSER_GOAL\}/.test(mcpApi)
    && /else q\.flow_id <> \$\{BROWSER_GOAL\}/.test(mcpApi));
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

/* The skill format has carried `payload.steps` since goal skills existed - the sequence of the recording or
 * the run it was made from - and nothing rendered them, so a receiving agent got the instruction and no
 * evidence at all. */
{
  const withSteps = skillMd.skillMarkdown(
    {
      kind: 'created', goalTemplate: 'In Gmail, do this:\n1. Click "Compose".', params: [], origins: [],
      steps: [{ name: '1. click', input: null }, { name: '2. type_text', input: 'the note' }],
    },
    { name: 'Send it', source: 'desktop' }, {}, { portable: true, urls: ['https://mail.google.com'] },
  );
  check('what one run did is in the exported file',
    /## What one run did/.test(withSteps) && /2\. type_text — the note/.test(withSteps));
  check('and it is labelled as evidence, not as the thing to carry out',
    /Evidence, not instructions/.test(withSteps) && /Do not replay it/.test(withSteps));
  check('a skill with no steps gets no empty section',
    !/## What one run did/.test(skillMd.skillMarkdown(
      { kind: 'created', goalTemplate: 'x', params: [], origins: [], steps: [] },
      { name: 'x' }, {}, { portable: true, urls: ['https://e.com'] },
    )));
}

/* The goal field capped typing at 4,000 while the DERIVED goal has no cap at all, so a long recording
 * arrived already over the line and the first keystroke threw the rest away. The fix has to refuse growth
 * rather than trim - the first attempt at it still cut 25,000 down to 20,000 on one keypress. */
check('editing a goal that is already long cannot silently shorten it',
  /if \(was\.length > GOAL_MAX\) return next\.length <= was\.length \? next : was;/
    .test(read('../web/src/features/record/SkillWizard.tsx')));

/* A parameter's description came from a table keyed on its TYPE, so a skill taking a subject line and a
 * body described both with the same canned sentence and a caller choosing between two string arguments
 * chose on nothing. The model is asked to name them - which is the one thing here it can do without
 * inventing, since the answer is derivable from instructions somebody already approved.
 *
 * Every guard below is enforced in code rather than requested in the prompt, and each is exercised. */
group('the inputs a skill asks for get names and words');
const { applyNames, promptFor: paramPrompt } = await import(
  new URL('../api/_params.mjs', import.meta.url).href);
const { structureOf } = await import(new URL('../api/_skill-schema.mjs', import.meta.url).href);
{
  const blanks = [
    { n: 4, name: 'text', control: null, type: 'quoted' },
    { n: 9, name: 'text2', control: null, type: 'quoted' },
  ];
  const good = applyNames(blanks, { inputs: [
    { n: 4, name: 'Subject', about: 'The subject line of the message.' },
    { n: 9, name: 'body', about: 'The text of the message.' },
  ] });
  check('a good answer replaces text and text2 with words that mean something',
    good[0].name === 'subject' && good[1].name === 'body'
    && /subject line/.test(String(good[0].about)));

  const silent = applyNames(blanks, {});
  check('silence keeps the derived names rather than emptying them',
    silent[0].name === 'text' && silent[1].name === 'text2' && silent[0].about === null);

  const clash = applyNames(blanks, { inputs: [
    { n: 4, name: 'message', about: 'a' }, { n: 9, name: 'message', about: 'b' },
  ] });
  check('two blanks renamed to one word are separated, or the skill fills two from one',
    clash[0].name === 'message' && clash[1].name === 'message2');

  const braces = applyNames(blanks, { inputs: [
    { n: 4, name: '{{subject}}', about: 'put {{subject}} here' },
  ] });
  check('a name carrying braces is stripped — nothing scans a goal for them',
    braces[0].name === 'subject' && !/\{\{/.test(String(braces[0].about)));

  const invented = applyNames(blanks, { inputs: [{ n: 99, name: 'invented', about: 'nope' }] });
  check('a blank that was never sent cannot be invented',
    invented.length === 2 && !invented.some((p) => p.name === 'invented'));

  const twice = applyNames(blanks, { inputs: [
    { n: 4, name: 'first', about: 'one' }, { n: 4, name: 'second', about: 'two' },
  ] });
  check('answered twice, the first stands', twice[0].name === 'first');

  const { user } = paramPrompt({ opening: 'In Gmail:', steps: [{ n: 4, instruction: 'type into "Subject"' }], blanks });
  check('the prompt names each blank by the step it belongs to',
    /4: currently called "text"/.test(user));
}
check('and the author’s words reach the tool schema, with the canned sentence as the fallback', (() => {
  const s = structureOf({
    kind: 'created', source: 'desktop', name: 'Send', id: 's1', origins: [],
    payload: {
      kind: 'created', goalTemplate: 'send {{subject}} and {{body}}',
      params: [
        { name: 'subject', type: 'quoted', example: null, about: 'the subject line of the email' },
        { name: 'body', type: 'quoted', example: null },
      ],
    },
  });
  return /subject line of the email/.test(s.schema.properties.subject.description)
    && /a phrase the goal quotes/.test(s.schema.properties.body.description);
})());

/* An open tab never re-fetches its own JavaScript, so a deployment reaches nobody who already has the page
 * up - and every constant baked into it stays as it was, AGENT_WANTS included. Somebody sat looking at a
 * pill saying their agent was current while a newer one had been out for an hour, because the page whose
 * job it was to say so was itself a version behind and could not know. */
group('a page that has fallen behind can say so');
const buildLib = read('../web/src/lib/build.ts');
check('the check is not answered by the copy it is checking',
  /cache: 'no-store'/.test(buildLib));
check('and it only ever reports a build that is DIFFERENT, never the one it already is',
  /if \(said && said !== BUILD\) deployed = said;/.test(buildLib));
check('it never reloads on its own — a half-typed goal is not ours to throw away',
  !/location\.reload/.test(buildLib));
check('the stamp is baked in at build time and served as a file',
  /__BUILD__/.test(read('../web/vite.config.ts'))
  && /fileName: 'build\.json'/.test(read('../web/vite.config.ts')));
check('and the notice sits beside the agent pill, which is the claim it was making wrongly',
  /Update available · Reload/.test(read('../web/src/shell/AppLayout.tsx')));

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

/* WHAT WAS WRONG. Every click on the Windows 11 taskbar was recorded as an unnamed pane, so a transcript
 * read "clicked on the desktop or the taskbar, at 898,1050" - a step nobody can act on. The name was not
 * missing; the resolver looked the wrong way. Measured on a live desktop: FromPoint over a taskbar button
 * answers with Shell_TrayWnd, the whole 1920x48 window, and the button is four levels BELOW it inside a
 * XAML island. Verified end to end by running the agent's own Describe() through reflection: it now writes
 *   #ctx  app=explorer  control=Google Chrome - 1 running window  type=button
 * for exactly the point in the complaint. */
group('a click on the taskbar says which icon');
const winAgent = read('../agent/mouseflow-agent.ps1');

check('the resolver looks DOWN when the climb found no name',
  /if \(string\.IsNullOrEmpty\(name\)\)\s*\n\s*\{[\s\S]{0,400}NamedUnder\(el, new System\.Windows\.Point\(job\.X, job\.Y\)/
    .test(winAgent));
/* ONLY after the climb, and that ordering is the no-regression guarantee: 70.8% of clicks are already
 * named, and none of them reach this code. A descent that ran FIRST could change an answer that works. */
check('and only after it, so nothing that is named today can change',
  winAgent.indexOf('at = TreeWalker.ControlViewWalker.GetParent(at); }')
    < winAgent.indexOf('NamedUnder(el, new System.Windows.Point'));
/* SMALLEST RECTANGLE, NOT FIRST FOUND - measured, not tidy. Shell_TrayWnd lists a leftover ReBarWindow32
 * before the XAML island and it HAS a named child, "Running applications", so a depth-first search returns
 * the strip and stops one step short of the icon. */
check('the smallest named rectangle wins, not the first one found',
  /if \(!string\.IsNullOrEmpty\(named\) && area < bestArea\)/.test(winAgent));
/* Bounded, because this runs while somebody is working and PROTOCOL.md forbids sweeping a subtree. Only
 * children whose rectangle contains the point are opened - a path down, not a sweep. */
check('it is bounded on depth, on siblings and on total elements',
  /examined >= 120/.test(winAgent) && /seen < 40 && examined < 120/.test(winAgent)
    && /NamedUnder\(el, new System\.Windows\.Point\(job\.X, job\.Y\), 6,/.test(winAgent));
check('and it only opens children that contain the point',
  /&& box\.Contains\(p\)\)/.test(winAgent));
/* An offscreen element reports an infinite rectangle, and a named hairline separator would win on area
 * every single time. Same guard the macOS side puts on kAXSize. */
check('a degenerate or offscreen rectangle cannot win on area',
  /box\.Width > 1 && box\.Height > 1\s*\n\s*&& !double\.IsInfinity\(box\.Width\) && !double\.IsInfinity\(box\.Height\)/
    .test(winAgent));

/* ---------------------------------------------------------------- and the reading side */
const shell = (control, type = 'button', window = undefined) => transcribe({
  source: 'desktop', kind: 'recorded', name: 'taskbar',
  payload: {
    events: [
      { x: 898, y: 1050, delayMs: 0, action: 'Left Click Down',
        context: { app: 'explorer', window, control, type } },
      { x: 898, y: 1050, delayMs: 20, action: 'Left Click Release',
        context: { app: 'explorer', window, control, type } },
    ],
  },
});

const chrome = shell('Google Chrome - 1 running window');
check('the icon is named in the story, which is the line people read',
  /Clicked "Google Chrome"/.test(chrome.story?.map((p) => p.text).join(' ') ?? ''),
  chrome.story?.[1]?.text);
/* THE RUNNING COUNT COMES OFF. Windows builds that name for a screen reader, so it carries state: the
 * count is true at the instant of the click and false a minute later, which makes two clicks on the SAME
 * icon read as two different targets. Same complaint plainName() exists for, one field along. */
check('and without the running count Windows appends for screen readers',
  chrome.segments?.[0]?.steps?.[0]?.what === 'clicked the "Google Chrome" button in explorer',
  chrome.segments?.[0]?.steps?.[0]?.what);
check('a count in any language comes off, because the rule is keyed on the digit',
  shell('Проводник — 3 окна').segments?.[0]?.steps?.[0]?.what
    === 'clicked the "Проводник" button in explorer',
  shell('Проводник — 3 окна').segments?.[0]?.steps?.[0]?.what);
/* SCOPED TO THE SHELL, and this is the test that keeps it there. "Documents - 3 items" inside a File
 * Explorer WINDOW is a legitimate name, and trimming it would rename a control the replay aims by.
 * Measured: Shell_TrayWnd carries no window title, an Explorer window always has one. */
check('but a real Explorer window keeps its name exactly as it was',
  shell('Documents - 3 items', 'list item', 'Documents').segments?.[0]?.steps?.[0]?.what
    === 'clicked the "Documents - 3 items" list item in explorer',
  shell('Documents - 3 items', 'list item', 'Documents').segments?.[0]?.steps?.[0]?.what);
/* The stretch was headed `explorer`, which is true and says nothing. Gated on a NAMED BUTTON, not on the
 * app: a click on the desktop BACKGROUND is also explorer with no title where the wallpaper rotates, and
 * it never carries a control. */
check('the stretch is headed by the taskbar rather than by a process name',
  shell('Google Chrome - 1 running window').segments?.[0]?.where?.label === 'the taskbar',
  shell('Google Chrome - 1 running window').segments?.[0]?.where?.label);
check('and a real window is still headed by its title',
  shell('Documents - 3 items', 'list item', 'Documents').segments?.[0]?.where?.label === 'Documents');

/* WHAT MUST NOT GET MORE CONFIDENT. An empty stretch of taskbar still has no name, and saying so is the
 * honest answer - but the note that explained the absence blamed Electron, a canvas or an elevated window,
 * none of which is involved. And nothing in a payload says which build recorded it, so the older agent's
 * behaviour has to stay in the sentence. */
const bare = shell(undefined, 'pane');
check('an empty stretch of taskbar is still not named, and does not pretend to be',
  !/"/.test(bare.segments?.[0]?.steps?.[0]?.what ?? '"'),
  bare.segments?.[0]?.steps?.[0]?.what);
check('the story places it without inventing a control',
  /on the desktop or the taskbar/.test(bare.story?.map((p) => p.text).join(' ') ?? ''));
check('and the note stops blaming Electron for the Windows shell',
  /nothing under it/.test(bare.segments?.[0]?.steps?.[0]?.note ?? '')
    && !/Electron/.test(bare.segments?.[0]?.steps?.[0]?.note ?? ''),
  bare.segments?.[0]?.steps?.[0]?.note);
check('while still saying an older agent reported icons this way too',
  /older than 0\.9\.9/.test(bare.segments?.[0]?.steps?.[0]?.note ?? ''));


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
/* ------------------------------------------ открытый вопрос «что умеет это развёртывание» стоит дёшево */

/* Два маршрута отвечают на него БЕЗ входа, и оба обязаны: расширение спрашивает до того, как человек вошёл,
 * а десктопный движок узнаёт здесь, какой моделью ехать. Но каждый из них читал app_setting на КАЖДЫЙ
 * запрос - то есть любой, кто знает адрес, заставлял базу работать одним curl, без счёта и без условия.
 *
 * Найдено прогоном против живого развёртывания. Аудит отметил один из двух (api/chat.js:1228), второй -
 * api/claude.js - не заметил вовсе; оба подтверждены запросом, оба отвечают 200 без сессии. */
group('открытый вопрос «что умеет развёртывание» не ходит в базу каждый раз');
{
  const { readSettings, forgetSettings } = await import(new URL('../api/admin.js', import.meta.url));
  let hits = 0;
  const sql = () => { hits += 1; return Promise.resolve([{ key: 'model.chat_default', value: 'claude-opus-5' }]); };

  forgetSettings();
  for (let i = 0; i < 10; i += 1) await readSettings(sql);
  check('десять запросов подряд - одно обращение к базе', hits === 1, String(hits));

  /* Админ, не увидевший собственной правки, нажмёт ещё раз. */
  forgetSettings();
  const before = hits;
  await readSettings(sql);
  check('а запись настройки сбрасывает кэш там же, где происходит', hits === before + 1);
  const admin = read('../api/admin.js');
  check('и сброс стоит на обоих путях записи',
    (admin.match(/forgetSettings\(\);/g) || []).length >= 2);

  /* Пустое означает «ничего не настроено», и заминка базы переключила бы модель посреди работы. */
  const broken = () => Promise.reject(new Error('down'));
  const kept = await readSettings(broken);
  check('сбой базы отдаёт последнее известное, а не пустоту',
    kept['model.chat_default'] === 'claude-opus-5');
  forgetSettings();
  const cold = await readSettings(broken);
  check('а если не читали никогда - пусто, ровно как до появления таблицы',
    JSON.stringify(cold) === '{}');

  /* Кэш в памяти процесса тут уместен, в отличие от счётчика трат: это ЧТЕНИЕ, одинаковое для всех, а не
   * счёт, который на каждом инстансе свой. Разница названа в комментарии, чтобы следующий не скопировал
   * не тот вывод. */
  check('и сказано, чем это отличается от счётчика трат',
    /отличие от счётчика трат/.test(admin)
      && /а не счёт, который на каждом инстансе свой/.test(admin));
}

/* --------------------------------------------- ничего лишнего не выставлено наружу маршрутом */

/* Vercel собирает в функцию каждый файл в api/, кроме начинающихся с подчёркивания. Два набора тестов
 * лежали там без него - и это была не гипотеза аудита, а измеренный факт: GET /api/test-step.mjs отвечал
 * 500 за полсекунды, а GET /api/test-report.mjs висел, пока его не оборвали на пятнадцатой. То есть любой,
 * кто знает адрес, жёг чужое время на чужом счёте, без авторизации и без потолка.
 *
 * Проверяется правило, а не два имени: следующий такой файл будет называться иначе. */
group('в api/ нет ничего, что не должно быть маршрутом');
{
  const { readdirSync } = await import('node:fs');
  const here = new URL('../api/', import.meta.url);
  const files = readdirSync(here).filter((n) => /\.(js|mjs)$/.test(n));

  /* Что становится функцией: всё, что не начинается с подчёркивания. */
  const routes = files.filter((n) => !n.startsWith('_'));
  const looksLikeTest = routes.filter((n) => /(^|[-.])test([-.]|$)|\bcheck-/.test(n));
  check('ни один набор тестов не выставлен маршрутом', looksLikeTest.length === 0, looksLikeTest.join(', '));

  /* И наоборот: то, что тестами является, лежит под подчёркиванием - иначе следующий npm test позовёт
   * файл, которого он не найдёт. */
  for (const name of ['_test-step.mjs', '_test-report.mjs']) {
    check(`${name} на месте и не маршрут`, files.includes(name));
  }
  const pkg = read('../package.json');
  check('и npm test зовёт их по новым именам',
    /node api\/_test-step\.mjs/.test(pkg) && /node api\/_test-report\.mjs/.test(pkg));

  /* Список маршрутов целиком - на глаз, чтобы добавленный завтра был виден в диффе теста.
   *
   * docs.js добавлен намеренно: документы процессов - объекты, их читают, правят и откатывают со страницы,
   * а это HTTP-поверхность, которой раньше не было. Писать документ этот маршрут НЕ умеет - написание
   * означает чтение расшифровки, вызов модели и плату за него, и живёт там, где уже действуют правила и
   * потолки ассистента (api/_recording-tools.js, write_process_doc). */
  const expected = ['account.js', 'admin.js', 'auth.js', 'chat.js', 'chats.js', 'claude.js', 'compose.js',
    'docs.js', 'gallery.js', 'insights.js', 'mcp.js', 'models.js', 'oauth.js', 'params.js', 'skill-md.js',
    'sync.js', 'team.js', 'transcript.js', 'well-known.js'];
  const unexpected = routes.filter((n) => !expected.includes(n));
  check('и новых маршрутов не появилось незамеченными', unexpected.length === 0, unexpected.join(', '));
  /* И наоборот - что каждый ожидаемый на месте: список, из которого файл пропал, молча перестаёт его
   * проверять, и пропажу маршрута этот пин не заметил бы вовсе. */
  const missing = expected.filter((n) => !routes.includes(n));
  check('и ни один из ожидаемых не исчез', missing.length === 0, missing.join(', '));
}

/* --------------------------------------------- кому браузер разрешит прочитать наш ответ */

/* НАЙДЕНО ИСПОЛНЕНИЕМ, а не чтением. Аудит прочитал все семь копий CORS и не заметил, что одна из них
 * другая: чтобы увидеть, надо было послать запрос с чужим Origin и посмотреть на заголовки ОТВЕТА. Первый
 * же такой запрос к живому развёртыванию вернул `access-control-allow-origin: https://evil.example` и
 * `access-control-allow-credentials: true`.
 *
 * Вместе это значит: страница на evil.example делает fetch с credentials:'include', браузер прикладывает
 * сессионную куку человека, сервер разрешает читать - и страница читает. За /api/chats лежат разговоры с
 * ассистентом: полный текст каждого вопроса и ответа. Allow-Methods там же перечислял DELETE. */
group('заголовки CORS - одно определение, и credentials не выдаются никому');
{
  const { cors } = await import(new URL('../api/_cors.mjs', import.meta.url));
  const headersFor = (origin) => {
    const h = {};
    cors({ headers: origin ? { origin } : {} }, { setHeader: (k, v) => { h[k] = v; } }, 'GET, OPTIONS');
    return h;
  };

  /* Главное: ни одному origin, никогда. Приложение с API однодоменно - CORS к нему не применяется вовсе, -
   * а расширение шлёт токен заголовком, а не кукой. Куке незачем ездить кросс-доменно ни в одном
   * настоящем случае, значит и разрешать это незачем. */
  for (const o of ['https://mouseflowapp.vercel.app', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    'https://evil.example', null]) {
    check(`credentials не выдаются: ${o}`,
      !('Access-Control-Allow-Credentials' in headersFor(o)));
  }

  check('свой адрес отражается', headersFor('https://mouseflowapp.vercel.app')['Access-Control-Allow-Origin']
    === 'https://mouseflowapp.vercel.app');
  check('и второе развёртывание тоже', headersFor('https://mouse-agent.vercel.app')['Access-Control-Allow-Origin']
    === 'https://mouse-agent.vercel.app');
  /* Id расширения у каждой установки свой, перечислить их нельзя. */
  check('расширение отражается',
    headersFor('chrome-extension://abc')['Access-Control-Allow-Origin'] === 'chrome-extension://abc');
  check('чужой - нет', headersFor('https://evil.example')['Access-Control-Allow-Origin']
    === 'https://mouseflowapp.vercel.app');
  /* Хост целиком, а не префиксом. */
  check('и поддомен, притворяющийся нашим',
    headersFor('https://mouseflowapp.vercel.app.evil.example')['Access-Control-Allow-Origin']
      === 'https://mouseflowapp.vercel.app');
  /* Без этого кэш отдал бы одному origin ответ, приготовленный для другого. */
  check('и ответ помечен зависящим от Origin', headersFor('https://evil.example').Vary === 'Origin');

  /* Одна копия. Семь разошлись ровно там, где это стоило дороже всего. */
  const routes = ['chats', 'chat', 'sync', 'gallery', 'insights', 'transcript', 'mcp',
    'claude', 'compose', 'params', 'skill-md', 'team', 'account'];
  for (const name of routes) {
    const src = read(`../api/${name}.js`);
    /* Комментарии сняты: каждый из этих файлов ЦИТИРУЕТ старую строку, объясняя, чем она была. */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    check(`${name} не держит своей копии`, !/function cors\(req, res\)|const cors = \(req, res\)/.test(code));
    check(`${name} не выдаёт credentials`, !/setHeader\('Access-Control-Allow-Credentials'/.test(code));
  }
  /* И называет те методы, которые правда принимает: preflight на DELETE у маршрута, который его не
   * принимает, обещает то, чего нет. */
  check('и каждый называет свои методы', /cors\(req, res, 'GET, POST, DELETE, OPTIONS'\)/.test(read('../api/sync.js'))
    && /cors\(req, res, 'DELETE, OPTIONS'\)/.test(read('../api/account.js'))
    && /cors\(req, res, 'GET, OPTIONS'\)/.test(read('../api/insights.js')));
}

/* ------------------------------------------------------- периметр расширения - один, и он в манифесте */

/* `http://localhost/*` стоял в выпускаемом манифесте, а Chrome в таких шаблонах ПОРТ ИГНОРИРУЕТ - то есть
 * мост внедрялся в каждую страницу на каждом порту localhost. Не гипотетическую: локальный превью проекта,
 * документация под `python -m http.server`, веб-интерфейс любой установленной программы. Такая страница
 * одним window.postMessage перепривязывала расширение к чужому аккаунту, после чего скиллы человека
 * уезжали туда, а оттуда приезжали чужие - синхронизация двусторонняя. */
group('периметр расширения один, и он выводится из манифеста');
{
  const manifest = JSON.parse(read('../extension/manifest.json'));
  const bg = read('../extension/background.js');
  const conf = read('../web/vite.extension.config.ts');

  const shipped = [
    ...manifest.content_scripts.flatMap((e) => e.matches),
    ...manifest.externally_connectable.matches,
  ];
  /* Проверяется НЕ «нет строки localhost», а «нет ничего, что Chrome сочтёт локальным»: file://, любой
   * шаблон со звёздочкой в хосте и всё, что не https на нашем домене. */
  const local = shipped.filter((m) => /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|^file:/.test(m));
  check('в выпускаемом манифесте нет ничего локального', local.length === 0, local.join(', '));
  check('и нет шаблона со звёздочкой в хосте',
    !shipped.some((m) => /^https?:\/\/[^/]*\*/.test(m)), shipped.join(', '));
  check('а остались только собственные адреса продукта',
    shipped.every((m) => /^https:\/\/(mouseflowapp|mouse-agent)\.vercel\.app\/\*$/.test(m)),
    shipped.join(', '));

  /* Второй список расходился с манифестом в ОБЕ стороны: он знал один адрес из двух (значит на
   * mouse-agent мост внедрялся и молча ничего не мог) и добавлял весь localhost. */
  check('фон больше не держит своего списка origin', !/const BRIDGE_ORIGINS/.test(bg)
    && !/const LOCAL_ORIGIN/.test(bg));
  check('а выводит его из того же манифеста, по которому решает Chrome',
    /chrome\.runtime\.getManifest\(\)/.test(bg) && /function originsFromManifest\(\)/.test(bg));

  /* ИСПОЛНЕНИЕМ, а не чтением: правило про порты и поддомены регуляркой в тесте не проверить - её пришлось
   * бы написать второй раз, и проверялась бы она, а не код. */
  const body = bg.slice(bg.indexOf('function originsFromManifest()'), bg.indexOf('let bridgeOrigins = null;'));
  const build = (m) => {
    const fn = new Function('chrome', `${body}; return originsFromManifest;`)({ runtime: { getManifest: () => m } });
    const rules = fn();
    return (origin) => rules.some((r) => r.test(origin));
  };
  const allows = build(manifest);
  check('своя страница проходит', allows('https://mouseflowapp.vercel.app'));
  check('и второе развёртывание тоже', allows('https://mouse-agent.vercel.app'));
  check('ЛЮБОЙ порт localhost отвергается',
    !allows('http://localhost:4400') && !allows('http://127.0.0.1:8000') && !allows('http://localhost'));
  check('чужая страница отвергается', !allows('https://evil.example'));
  /* Хост целиком, а не префиксом. */
  check('и поддомен, притворяющийся нашим', !allows('https://mouseflowapp.vercel.app.evil.example'));
  /* Тот же адрес по http - не тот же адрес. */
  check('и наш адрес по http', !allows('http://mouseflowapp.vercel.app'));

  /* Разработке они нужны - поэтому не удалены, а за флагом, и флаг кричит. */
  check('локальные адреса остались доступны разработке за флагом',
    /MOUSEFLOW_DEV_BRIDGE/.test(conf) && /const DEV_BRIDGE = /.test(conf));
  check('и сборка с ним предупреждает, что её нельзя выпускать',
    /Do not ship it/.test(conf));
  /* Иначе разработочная сборка оставила бы после себя изменённый manifest.json, и первый же коммит
   * выпустил бы то, что здесь и закрывается. */
  check('а правится копия в dist, а не исходник',
    /openManifestForDev\(join\(OUT, 'manifest\.json'\)\)/.test(conf));
}

/* -------------------------------------------- синхронизация не воскрешает и не откатывает */

/* Три находки, и все три - «клиент прислал, сервер записал». Расширение шлёт свою библиотеку ЦЕЛИКОМ при
 * каждой синхронизации, так что «последний пишет» здесь означает не «свежее побеждает», а «кто нажал
 * позже». */
group('синхронизация не воскрешает удалённое и не откатывает свежее');
{
  const sync = read('../api/sync.js');
  const flowFor = read('../api/_flow-for.mjs');
  const reconciler = read('../web/src/features/record/Reconciler.tsx');

  /* `deleted_at = null` стояло в upsert безусловно: удаление, сделанное в приложении, возвращалось
   * следующим нажатием Sync в расширении. */
  check('upsert больше не снимает надгробие', !/updated_at = now\(\), deleted_at = null/.test(sync));
  check('а удалённое отказывается принимать', /was deleted on this account, so it was not/.test(sync));
  /* Отказ сам по себе оставил бы запись здесь непроштампованной - то есть следующий проход отправил бы её
   * снова, и так навсегда. */
  check('и клиент перестаёт пытаться', /was deleted on this account/.test(reconciler)
    && /const forget = new Set\(\[\.\.\.plan\.forget, \.\.\.buried\]\)/.test(reconciler));

  /* Переименование в приложении меняло name и payload; машина, не синхронизировавшаяся с тех пор,
   * возвращала старое имя И старый payload поверх нового - молча, и счётчик считал это сохранением. */
  check('устаревшее не перезаписывает свежее',
    /is older here than on the account, so it was not/.test(sync));
  check('и клиент присылает, насколько свежа его копия', /updated: rec\.syncedAt \?\? null,/.test(flowFor));
  /* И РАСШИРЕНИЕ ТОЖЕ - оно и есть тот клиент, который откатывал переименования: библиотека шлётся
   * целиком при каждом Sync, так что «последний пишет» означало «кто нажал позже», а не «у кого свежее». */
  const bgSrc = read('../extension/background.js');
  check('расширение тоже, иначе именно оно и откатывало',
    /updated: skill\.updated \|\| null,/.test(bgSrc));
  check('и отмечает свои изменения', /skill\.updated = now;/.test(bgSrc)
    && /skill\.updated = new Date\(\)\.toISOString\(\);/.test(bgSrc));
  /* Иначе скачанный скилл выглядел бы никогда не менявшимся и первый же push отправил бы его обратно. */
  check('а скачанное считается свежим настолько, насколько сказал аккаунт',
    /updated: s2\.updated \|\| new Date\(\)\.toISOString\(\),/.test(bgSrc));
  /* Клиент, который его не шлёт, ведёт себя как раньше - это не ослабление, раньше так вели себя все. */
  check('а без этого поля работает по-старому', /const mine = when\(flow\.updated\);/.test(sync)
    && /if \(row && mine &&/.test(sync));

  /* Строка, которую Postgres датой не признаёт, роняла insert - а значит ВЕСЬ push, а значит и каждый
   * следующий, потому что клиент шлёт библиотеку целиком. Взяться ей есть откуда: extension/skills.js
   * принимает created любой строкой, и скилл можно ввезти файлом. */
  /* И ВИДНА ЛИ ОНА ТАМ, ГДЕ ВЫЗЫВАЕТСЯ. Проверка только на «функция где-то есть» прошла бы и тогда, когда
   * она объявлена без export и не импортирована - а это ReferenceError на КАЖДОМ push, потому что вызов
   * стоит внутри функции и загрузка модуля его не трогает. Ровно так и было: тесты по исходнику зелёные,
   * маршрут мёртвый. Нашлось при сверке «что закрыто» - и это единственная причина, по которой нашлось. */
  check('даты разбираются, а не кладутся как есть',
    /export function when\(said\) \{/.test(read('../api/_payload.mjs')));
  check('и та, что разбирает, видна там, где её зовут',
    /\$\{when\(/.test(sync)
      && /import \{[^}]*\bwhen\b[^}]*\} from '\.\/_payload\.mjs';/.test(sync));
  check('и применяются ко всем трём',
    /\$\{when\(flow\.created\)\}/.test(sync)
      && /\$\{when\(run\.startedAt\)\}, \$\{when\(run\.finishedAt\)\}/.test(sync));

  /* Шаг со скриншотом в data-URL - ровно то, что db/010 запрещает для run_queue; здесь запрета не было.
   * Четыреста шагов по 161КБ это шестьдесят четыре мегабайта в строке, которую потом возит каждый список. */
  check('трасса прогона ограничена по весу, а не только по числу шагов',
    /trace\.length \+ words\.length > RUN_MAX_BYTES/.test(sync));
  check('и отказ называет обычную причину', /A step carrying a screenshot/.test(sync));
  check('origins ограничены и по длине', /\.map\(\(o\) => text\(o, 200\)\)/.test(sync));

  /* Писателей у payload двое, и потолок стоял у одного. */
  const mcpApi = read('../api/mcp.js');
  check('второй писатель payload знает тот же потолок',
    /import \{ PAYLOAD_MAX_BYTES \} from '\.\/_payload\.mjs';/.test(mcpApi)
      && /if \(encoded\.length > PAYLOAD_MAX_BYTES\)/.test(mcpApi));
  /* По неразорванному куску: обе половины фразы лежат по разные стороны переноса внутри шаблона, и между
   * ними остаётся `+ '` - проверка на слитность мерила бы форматирование, а не смысл. */
  check('и отказывает строкой, которую человек прочитает',
    /so it was not saved/.test(mcpApi) && /stop it in shorter stretches/.test(mcpApi));
}

/* ------------------------------------------- потолок на общий ключ считается там, где он один */

/* Шесть маршрутов держали счётчик в Map в области модуля, и каждый из них своим же комментарием признавал
 * главное: на serverless окно живёт в ОДНОМ тёплом инстансе, а сколько их - решает трафик. То есть предел
 * умножался ровно тогда, когда был нужнее всего. Ещё два не считали вовсе, и один из них - самый дорогой:
 * ?worker=step ведёт прогон до 240 обращений к модели по 8000 токенов. */
group('потолок на общий ключ считается в базе, а не в памяти инстанса');
{
  const spend = read('../api/_spend.mjs');
  check('счётчик один на все маршруты', /export async function overSpend\(sql, userId, route\)/.test(spend));
  check('и считает строки в таблице, а не в Map', /from model_call/.test(spend) && !/new Map\(\)/.test(spend));
  /* Иначе первый же вызов считался бы вторым; и отказ ничего не стоил, значит в счёт не идёт.
   *
   * По ПОЛОЖЕНИЮ внутри самой функции, а не по близости: между счётом и вставкой стоит ещё запрос «когда
   * освободится место», и проверка расстоянием мерила бы длину этого запроса. И не по всему файлу -
   * сравнение индексов через весь файл однажды уже дало проходящую проверку не о том. */
  const overSpendBody = (() => {
    const at = spend.indexOf('export async function overSpend(');
    return at < 0 ? '' : spend.slice(at);
  })();
  check('считает ДО того, как записать себя',
    overSpendBody.indexOf('select count(*)::int as n from model_call') > 0
      && overSpendBody.indexOf('select count(*)::int as n from model_call')
        < overSpendBody.indexOf('insert into model_call'));
  /* Потолок против цикла, а не замок: сбой базы, превращённый в «вы исчерпали лимит», - это маленькая
   * авария, превращённая в неверное утверждение о человеке. */
  check('и при сбое базы пропускает, а не отказывает',
    /catch \(_\) \{[\s\S]{0,260}?return \{ ok: true \};/.test(spend));
  check('а отказ говорит, когда пробовать', /retryInMs/.test(spend) && /Try again in about/.test(spend));

  /* Все восемь тратящих маршрутов - через одну дверь. */
  for (const route of ['claude', 'chat', 'insights', 'compose', 'params', 'transcript', 'skill-md']) {
    const src = read(`../api/${route}.js`);
    check(`${route} спрашивает общий потолок`, /overSpend\(/.test(src), 'нет вызова');
    check(`${route} больше не считает в памяти`, !/rateLimited|function tooMany/.test(src));
  }
  const mcpApi = read('../api/mcp.js');
  check('и самый дорогой маршрут - тоже', /overSpend\(sql, who\.id, 'step'\)/.test(mcpApi));
  /* Через тот же fail(), что и всякая другая неудача этого маршрута: своя уборка была бы третьей версией
   * того же самого и первой, про которую забудут. */
  check('а упёршийся прогон заканчивается, а не висит claimed',
    /return fail\(spentWhy\(budget, 'runs'\)\);/.test(mcpApi));

  /* Числа наконец лежат одним списком, где их можно сравнить. */
  check('и все потолки перечислены в одном месте', /export const LIMITS = \{/.test(spend));
  check('включая тот, которого не было', /'skill-md': \{ max: \d+/.test(spend));

  /* Таблица существует, чтобы посчитать последние минуты, а не чтобы помнить. */
  const migration = read('../db/012_model_call.sql');
  check('таблица есть и подметается', /create table if not exists model_call/.test(migration)
    && /delete from model_call where at </.test(spend));
  check('и индекс отвечает ровно на тот запрос, который есть',
    /model_call_window on model_call \(user_id, route, at desc\)/.test(migration));
}

/* ------------------------------------------------------- чужие данные не достаются не тому */

group('записи не переходят к следующему, кто вошёл на этой машине');
{
  const store = read('../web/src/lib/store.ts');
  const provider = read('../web/src/shell/AccountProvider.tsx');
  const bg = read('../extension/background.js');

  /* lib/kept.ts носил и механизм, и предупреждение - «кэш чужих скилов, отданный следующему, кто вошёл на
   * этой машине, это не медленная страница, это утечка», - и там же сказано, что ЭТО хранилище по человеку
   * не ключуется. Последствие было хуже показа: Reconciler отправлял чужие записи на аккаунт вошедшего. */
  check('у записей теперь слот на аккаунт', /const slotFor = \(id: string\) => `\$\{KEY\}:\$\{id\}`;/.test(store));
  /* Проверка переехала вместе с кодом: запись на диск теперь отдельной функцией, потому что у неё
   * появилось отступление на случай переполнения. Свойство то же - без назвавшегося не пишется ничего. */
  check('и на диск не пишется, пока никто не назвался',
    /function persist\(next: Console\): void \{\s*\n\s*if \(!heldFor\) return;/.test(store)
      && /localStorage\.setItem\(key, JSON\.stringify\(value\)\)/.test(store));
  /* Указатель - то, что сохраняет мгновенное открытие страницы: ждать сессию значило бы менять утечку на
   * секунду ожидания для каждого. Пересечение случается по пути «A вышел → B вошёл», а выход это наш код. */
  check('выход стирает указатель, но не диск',
    /export function releaseStore\(\): void \{[\s\S]{0,200}?localStorage\.removeItem\(WHO\)/.test(store));
  check('и вызывается на выходе', /releaseStore\(\);/.test(provider));
  check('а вход сверяет слот с настоящим id', /claimStore\(me\?\.id \?\? null\);/.test(provider));
  /* Наследство от сборки без слотов достаётся первому, кто назвался: сегодня эти записи видит кто угодно,
   * так что забрать их однажды строго лучше, чем оставить. */
  check('и наследство забирается один раз, а не раздаётся всем',
    /const legacy = mine \? null : readSlot\(KEY\);/.test(store)
      && /localStorage\.removeItem\(KEY\)/.test(store));

  /* Расширение: скиллы и следы прогонов живут в chrome.storage.local и ни к какому аккаунту не привязаны. */
  check('расширение сверяет, кто был привязан раньше',
    /const wasSomebodyElse = !syncWho \|\| !who \|\| syncWho\.id !== who\.id;/.test(bg));
  /* Чистится, а не «не отправляется»: не отправлять значило бы оставить чужие скиллы лежать и показывать
   * их новому человеку в его собственном списке. */
  check('и чистит местное ДО того, как что-либо уедет',
    /remove\(\['skills', 'agentTrace', 'agentTraceHistory', 'syncDeleted', 'syncedAt'\]\)/.test(bg));
}

group('в команду попадают по согласию, а не по чужому решению');
{
  const team = read('../api/team.js');

  /* Была развилка: существующий аккаунт вписывался в team_member прямо, без приглашения и без спроса. */
  /* Именно в addMember, а не во всём файле: acceptInvite членство пишет - там оно и должно появляться,
   * это и есть согласие. Проверка на весь файл ловила бы правильный код и требовала его убрать. */
  const addMemberBody = (() => {
    const at = team.indexOf('async function addMember(');
    if (at < 0) return '';
    const next = team.indexOf('\nasync function ', at + 10);
    return team.slice(at, next < 0 ? undefined : next);
  })();
  check('тело addMember найдено', addMemberBody.length > 200, String(addMemberBody.length));
  check('добавление больше не пишет членство напрямую',
    !/insert into team_member/.test(addMemberBody));
  check('а всегда пишет приглашение', /insert into team_invite \(team_id, email, role, invited_by\) values/.test(team));
  /* И вторая половина: claimInvites превращал приглашение в членство при чтении списка - то есть согласие
   * было побочным эффектом того, что человек открыл страницу. */
  check('и чтение списка больше никого никуда не вступает', !/claimInvites\(sql, who\)/.test(team));
  check('вступление - отдельное действие', /async function acceptInvite\(sql, who, teamId\)/.test(team));
  check('и отказ тоже', /async function declineInvite\(sql, who, teamId\)/.test(team));
  /* Токен коннектора получен по согласию, перечисляющему три возможности, и вступления в команду там нет. */
  check('ответить на приглашение можно только из браузера',
    /only a signed-in browser can answer an invitation/.test(team));
  /* DELETE ?team=1 с Bearer-токеном сносил команду для всех участников, а каскадом - общие записи. */
  check('и разрушительное в командах - тоже только из браузера',
    /only a signed-in browser can change a team/.test(team));

  /* Лимит считал team_invite, а ветка для существующего аккаунта строк туда не писала - значит счёт был
   * вечным нулём, и письма любому зарегистрированному пользователю ничем не ограничивались. Теперь строка
   * пишется всегда, и тот же запрос наконец считает то, на что смотрит. */
  check('лимит приглашений считает таблицу, в которую теперь и правда пишут',
    /select count\(\*\)::int as sent from team_invite/.test(team)
      && /insert into team_invite \(team_id, email, role, invited_by\) values/.test(team));
  /* Второе письмо тому, кто уже в команде, - это не приглашение. */
  check('и тому, кто уже в команде, второго письма не шлют',
    /if \(already\.length\) \{[\s\S]{0,160}?mailed: false/.test(team));

  /* Приглашение - не команда: человек в ней не состоит, и складывать их в один список значило бы
   * повторить ту же ошибку в интерфейсе. */
  const view = read('../web/src/features/team/TeamView.tsx');
  check('экран показывает приглашения отдельно от команд',
    /invitations\.length > 0 && \(/.test(view) && /You have been invited to a team/.test(view));
  check('и предлагает оба ответа глаголом, а не «ок»',
    />\s*Join\s*<\/Button>/.test(view) && />\s*Decline\s*<\/Button>/.test(view));
  check('и говорит, что вступление открывает',
    /see that work is happening on your account/.test(view));
}

/* ------------------------------------------------ что уходит с машины, и молчание о потерянном */

group('адрес режется у источника на обеих половинах');
{
  const bg = read('../extension/background.js');
  /* PROTOCOL.md:406 объясняет, почему резать надо в рекордере: значение, которое не вошло в запись, не
   * утечёт ни по одному из путей, а резать позже значило бы, что каждый обязан об этом помнить. Оба агента
   * так и делают; расширение писало tab.url целиком. */
  check('расширение режет адрес до происхождения и пути', /return parsed\.origin \+ parsed\.pathname;/.test(bg));
  /* У самого входа, а не в трёх местах вызова: следующее событие с адресом появится не через них. */
  check('и делает это в pushEvent, а не в каждом вызывающем',
    /if \(typeof ev\.url === 'string'\) ev\.url = bareUrl\(ev\.url\);/.test(bg));
  check('и только для http и https', /parsed\.protocol !== 'http:' && parsed\.protocol !== 'https:'/.test(bg));

  /* beforeSend в @sentry/react 10 работает на ошибках; транзакции идут своим конвертом и несут url
   * каждого fetch - то есть ровно те адреса, ради которых scrubUrl и написан. */
  const sentry = read('../web/src/lib/sentry.ts');
  check('трассировки чистятся тем же правилом, что и ошибки',
    /beforeSendTransaction\(event\) \{/.test(sentry));
  check('включая описания и атрибуты спанов',
    /span\.description = span\.description\.replace/.test(sentry)
      && /\['url', 'http\.url', 'server\.address'\]/.test(sentry));
}

group('о потерянном говорят вслух');
{
  const recordView = read('../web/src/features/record/RecordView.tsx');
  const sync = read('../api/sync.js');
  const step = read('../api/_step.mjs');

  /* `finished` верно и тогда, когда отправлять было нечего, а печаталась длина всего реестра: сессия, из
   * которой уехало две части из пяти, сообщала «5 parts on the account». */
  check('сессия сообщает, сколько частей ДОЕХАЛО',
    /const landed = done\.parts\.filter\(\(p\) => p\.onAccount\)\.length;/.test(recordView));
  check('и называет обе цифры, когда они разошлись',
    /reached your account\. The rest were only ever in the tab that recorded them/.test(recordView));

  /* Три среза молча теряли остаток, а ответ был 200 ok со счётчиками, равными уцелевшему. */
  check('push называет отброшенный хвост', /were not saved — this takes/.test(sync));
  /* Хуже всего на deleted: расширение чистит свой список по успешному ответу. */
  check('включая удаления', /tooMany\(body\.deleted, removed\.length, 'deletions', FLOWS_MAX\)/.test(sync));

  /* «Действия были отправлены и теперь выполнены» - допущение; results знает ответ. */
  check('успех, объявленный за не сработавшим действием, не засчитывается',
    /const broke = loop\.ending\.ok === true/.test(step)
      && /answered\.some\(\(block\) => block && block\.is_error === true\)/.test(step));
  /* finish(ok:false) - отчёт о неудаче, и он верен тем более. */
  check('а отчёт о неудаче остаётся своим', /loop\.ending\.ok === true\n\s*&& answered\.some/.test(step));

  /* Чужой скилл, положенный проиграть, - не работа этого человека, и на его аккаунте ему не место. */
  const adopt = read('../web/src/features/record/adopt.ts');
  const reconcile = read('../web/src/features/record/reconcile.ts');
  check('взятое на время помечается', /borrowed: true,/.test(adopt));
  check('и наверх не едет', /if \(rec\.borrowed\) continue;/.test(reconcile));

  /* Документ утверждал, что страница Record говорит это в интерфейсе; предложение было комментарием. */
  check('страница Record и правда говорит, куда это уезжает',
    /is saved to your account/.test(recordView));
}

/* ------------------------------------------------------- публикация говорит, что именно уезжает */

/* Две находки, одно свойство: публикация необратима, и человек должен видеть, ЧТО именно уезжает и КОМУ. */
group('публикация называет и содержимое, и аудиторию');
{
  const skills = read('../web/src/features/skills/SkillsView.tsx');
  const gallery = read('../web/src/features/gallery/GalleryView.tsx');
  const ext = read('../extension/skills.js');
  const galleryApi = read('../api/gallery.js');

  /* «Anyone signed in can install it» было неправдой дважды. Во-первых, ?id= не зовёт caller() вовсе. */
  check('галерея по ссылке и правда читается без сессии - вот почему текст был ложью',
    /if \(id\) \{[\s\S]{0,400}?select \* from gallery_skill where id =/.test(galleryApi)
      && !/if \(id\) \{[\s\S]{0,300}?await caller\(req\)/.test(galleryApi));
  /* Комментарии сняты: файл цитирует старую формулировку, объясняя, чем она была ложью. */
  const skillsCode = skills.replace(/\/\*[\s\S]*?\*\//g, '');
  check('подтверждение больше не говорит «anyone signed in»',
    !/Anyone signed in can install it/.test(skillsCode));
  /* По кускам, а не одной фразой: обе строки разорваны переносом внутри шаблона, и проверка, требующая
   * их слитно, проверяет форматирование, а не смысл. */
  check('а говорит про любого, у кого есть ссылка',
    /no account needed/.test(skills) && /cannot be un-read once it is out/.test(skills));
  /* Во-вторых, «install» описывает намерение, а уезжает содержимое: имена окон и адреса. */
  check('и показывает, что внутри, а не спрашивает «уверены?»',
    /It carries:/.test(skills) && /const whatTravels/.test(skills));
  /* Путь и строка запроса - это уже содержание, а не место. */
  check('от адреса берётся только хост', /add\(new URL\(e\.url\)\.host\)/.test(skills));

  /* Кнопка в попапе открывала /gallery.html - страницы с таким именем в проекте нет, читать фрагмент было
   * некому, скилл молча выбрасывался, а попап отвечал ok:true. */
  check('ссылка расширения ведёт на маршрут, который существует',
    /'\/gallery#publish=' \+ base64url/.test(ext) && !/gallery\.html#publish/.test(ext));
  check('и приёмная половина наконец есть', /const skillFromHash = \(hash: string\)/.test(gallery));
  check('она тоже спрашивает, а не публикует молча',
    /no account needed/.test(gallery) && /cannot be un-read once it is out/.test(gallery));
  /* Иначе перезагрузка страницы предложит то же самое второй раз. */
  check('и стирает фрагмент в обоих исходах',
    /window\.history\.replaceState\(null, '', window\.location\.pathname/.test(gallery));
  check('испорченный фрагмент не роняет страницу', /return null;\n\s*\}\n\};/.test(gallery));
}

/* ------------------------------------------------ выключатель означает то, что про него написано */

/* «The agent has no outbound network code at all» стояло в четырёх местах, включая экран, который читают
 * ровно перед тем, как скачать и установить агента. Написано было, когда было правдой, и оставлено, когда
 * перестало: у агента есть курьер и репортер крашей.
 *
 * И вторая половина: меню говорит «Off. Nothing leaves this Mac», курьер `taking` проверял, а репортер
 * крашей - нет. То есть предложение было правдой про опрос и неправдой про отчёты - ровно в том месте,
 * где человек ищет свой единственный выключатель. */
group('выключатель означает то, что про него написано');
{
  /* Оба агента читаются здесь: `swift` и `ps` - переменные соседнего набора (agent/test-contract.mjs),
   * и брать их по имени значило бы полагаться на порядок файлов, которого нет. */
  const swiftCode = read('../agent/mouseflow-agent.swift')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const psCode = read('../agent/mouseflow-agent.ps1').replace(/\/\*[\s\S]*?\*\//g, '');

  check('macOS: краш не уходит, когда работа не берётся',
    /guard let link = Account\.link, link\.taking,/.test(swiftCode));
  check('Windows: то же самое, той же проверкой', /if \(!Account\.Taking\) return;/.test(psCode));

  /* Четыре места. Комментарии сняты - каждое из них объясняет, чем была старая формулировка. */
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  for (const [what, text] of [
    ['экран установки', strip(read('../web/src/features/connect/ConnectView.tsx'))],
    ['README', read('../README.md')],
    ['документ про приватность', read('../docs/product/17-privacy-security.md')],
  ]) {
    check(`${what} больше не обещает, что исходящих вызовов нет вовсе`,
      !/no outbound network code/.test(text));
  }
  /* И говорит то, что правда: до привязки - тишина, после - разговор с аккаунтом. */
  check('а экран установки называет оба состояния',
    /makes no outbound call at all; attached, it asks your account for work/
      .test(read('../web/src/features/connect/ConnectView.tsx')));
  /* Таблица «что куда уходит» имела одну строку про агента и отвечала «нет». */
  check('таблица в документе различает привязанного и непривязанного',
    /Agent traffic, attached and taking work/.test(read('../docs/product/17-privacy-security.md')));

  /* Маршрут крашей обосновывался тем, что приходящее «уже привязано к аккаунту», и не привязывал: в Sentry
   * все краши всех агентов лежали одной кучей. */
  check('форварднутый краш несёт, чей он', /user: \{ id: who\.id \},/.test(read('../api/mcp.js')));
  check('но только id, не почту - sendDefaultPii здесь выключен намеренно',
    /user: said && said\.user && said\.user\.id \? \{ id: String\(said\.user\.id\)/.test(read('../api/_report.js')));
}

/* --------------------------------------------- обещание про захват текста считается, а не объявляется */

/* До 0.9.7 macOS-агент брал имя элемента из kAXValue, а у текстового поля kAXValue и есть содержимое.
 * Агент это чинит - но чинит БУДУЩЕЕ: сто с лишним записей уже лежат, и транскрипт читает и те, и другие.
 * Значит ответ на «есть ли тут мой текст» разный для разных записей, и постоянной строкой его дать нельзя
 * ни в одну сторону: безусловное «нет» врёт про старые, безусловное «может быть» пугает без причины на
 * новых. */
group('обещание про захват текста считается по записи, а не объявляется');
{
  const { transcribe } = await import(new URL('../api/_transcript.js', import.meta.url));
  const made = (version, extra = {}) => {
    const events = [
      { action: 'Left Click Down', x: 400, y: 300, delayMs: 500,
        context: { app: 'Google Chrome', window: 'Search', control: 'что-то набранное', type: 'text field' } },
      { action: 'Left Click Release', x: 400, y: 300, delayMs: 40 },
    ];
    return transcribe({
      id: 't', name: 't', kind: 'recorded', source: 'desktop',
      payload: {
        kind: 'recorded', agent: 'desktop', events, windows: [],
        recorder: version === null ? undefined : { version, canName: true, canKeys: true },
        ...extra,
      },
    }).summary.captured;
  };

  check('запись старого агента предупреждает, что имя может быть набранным текстом',
    /Text can still appear in the names above/.test(made('0.9.2')), made('0.9.2').slice(-120));
  check('и запись без версии тоже - исключить нельзя, а молчать нечестно',
    /Text can still appear in the names above/.test(made(null)));
  /* Ровно та же запись, только помеченная новым агентом: предупреждения быть не должно. */
  check('а запись сегодняшнего агента - НЕ предупреждает, потому что он значений не читает',
    !/Text can still appear/.test(made('0.9.7')), made('0.9.7').slice(-120));
  check('и более новая тоже', !/Text can still appear/.test(made('0.10.0')));

  /* Оговорка стояла ВНУТРИ ветки «были нажатия»: запись без единой клавиши, но с кликами в поля,
   * показывала читателю только успокаивающую половину. */
  const src = read('../api/_transcript.js');
  check('оговорка вынесена из ветки про клавиатуру',
    /\+ \(namesMayHoldTyping\(recorder, perStep, counts\)/.test(src));
  check('и версия сравнивается числами, а не строками',
    /function olderVersion\(said, than\)/.test(src));

  /* Две ветки говорили «Nothing typed» безусловно, при том что counts.keys лежит рядом. */
  check('«ничего не набрано» больше нигде не говорится безусловно',
    !/Nothing typed, no screenshots/.test(src) && !/Nothing typed, no other page text/.test(src));

  /* И то же самое - в результате, который читает ассистент. bounded() резал на 300 знаках, а оговорка
   * живёт за пятисотым: модель получала успокаивающее начало и не получала предупреждения. */
  const tools = read('../api/_recording-tools.js');
  check('captured не проходит через общую обрезку на 300',
    /captured: text\(transcript\.summary\.captured, CAPTURED_MAX\)/.test(tools));
  check('и потолок для неё длиннее самой длинной ветки', /const CAPTURED_MAX = 700;/.test(tools));
  /* Комментарии сняты - файл объясняет, чем была старая формулировка, и цитирует её. Четвёртый раз за
   * сессию, когда негативная проверка ловит собственное объяснение; правило простое - искать отсутствие
   * можно только в коде, а не в тексте, который про этот код рассказывает. */
  const toolsCode = tools.replace(/\/\*[\s\S]*?\*\//g, '');
  check('ассистенту больше не обещают, что ни один шаг не несёт набранного',
    !/No step carries what was typed/.test(toolsCode));
  check('а отсылают туда, где стоит ответ про ЭТУ запись',
    /Read `summary\.captured` before saying anything about what was typed/.test(tools));
  check('и говорят, что делать с таким именем',
    /do not quote it back unless they asked about it/.test(tools));
}

/* ------------------------------------------------- события не едут в списке, а приезжают по просьбе */

/* GET /api/sync отдавал payload КАЖДОГО флоу без limit. Замерено на живом аккаунте: 28 записей - 3213КБ,
 * 4 скилла - 5КБ. То есть 99.8% веса ответа это `events`, и приложение возило их на каждой загрузке, хотя
 * нужны они ровно двум действиям: забрать запись в браузер и что-то с ней сделать.
 *
 * Опасность правки не в том, что что-то не покажется, а в том, что что-то СОТРЁТСЯ: переименование в
 * Skills делает `{ ...payload, name }` и пушит обратно, а Skills показывает и записи тоже. */
group('список не везёт события, и от этого ничего не теряется');
{
  const sync = read('../api/sync.js');
  const api = read('../web/src/lib/api.ts');
  const reconcile = read('../web/src/features/record/reconcile.ts');
  const reconciler = read('../web/src/features/record/Reconciler.tsx');

  /* Считается в SQL: вытащить 3МБ, чтобы посчитать длину массива и выбросить, - та же работа, только на
   * другой стороне провода. */
  /* Псевдоним `f.` появился вместе с join за формой записи - см. ниже. Проверяется то же самое:
   * длина массива и вес считаются в базе, а payload записи наверх не едет. */
  check('список считает сводку в SQL, а не тянет payload, чтобы посчитать',
    /jsonb_array_length\(f\.payload->'events'\)/.test(sync)
      && /octet_length\(f\.payload::text\) as bytes/.test(sync));
  /* Скиллы payload везут: пять килобайт на все, и запустить скилл можно прямо из списка. */
  check('но скиллы payload по-прежнему везут, их запускают из списка',
    /case when f\.kind = 'created' then f\.payload else null end as payload/.test(sync));

  /* ФОРМА ЗАПИСИ едет вместо событий, и это то, чем закрывается дыра, которую сделала эта же оптимизация:
   * столбец Signal рисуется из событий, а их не стало - значит для всякой записи с аккаунта он рисовал
   * шестнадцать полосок по нижней границе, то есть картинку тихой записи поверх четырёхчасовой сессии. */
  check('зато форма записи едет - шестнадцать чисел вместо сотен килобайт',
    /left join flow_digest d on d\.user_id = f\.user_id and d\.client_id = f\.client_id/.test(sync)
      && /shape: Array\.isArray\(f\.shape\)/.test(sync));
  /* LEFT JOIN, а не INNER: дайджеста может ещё не быть - запись сделана минуту назад, или код развёрнут
   * впереди своей миграции. INNER уронил бы всю синхронизацию из-за украшения. */
  check('и её отсутствие не роняет синхронизацию',
    /left join flow_digest/.test(sync) && !/join flow_digest d on/.test(sync.replace(/left join flow_digest/g, '')));
  /* И этот маршрут дайджесты НЕ считает: он самый горячий в продукте, его зовут на каждую загрузку. */
  check('а считать дайджесты этот маршрут не берётся',
    !/topUp\(/.test(sync));
  check('и есть маршрут за одним payload', /query\.flow\) return await onePayload/.test(sync));
  /* «Нет такой записи» и «запись без содержимого» - разные ответы, и клиент, получивший второй вместо
   * первого, запишет пустоту поверх. */
  check('которого нет - это 404, а не пустой payload',
    /no flow with that id on this account/.test(sync));

  /* ГЛАВНОЕ: инвариант на сервере. Клиент делает правильно, но клиентов четыре, включая расширение и
   * агентов, и следующий появится завтра. */
  check('сервер отказывается писать пустые события поверх непустых',
    /refusing to overwrite a recording with an empty one/.test(sync));
  check('и говорит, что делать вместо этого', /GET \/api\/sync\?flow=/.test(sync));

  /* Положительный признак, а не отсутствие поля: undefined читается и как «не приехало», и как «пусто». */
  check('«не приехал» сказано прямо, а не оставлено на догадку',
    /payloadOmitted: f\.payload === null \|\| f\.payload === undefined/.test(sync)
      && /payloadOmitted\?: boolean;/.test(api));
  check('и тип признаёт, что payload может не приехать', /payload\?: \{/.test(api));
  check('есть одна дверь, через которую его берут', /export const payloadOf = async/.test(api));
  check('и она кэширует на время жизни страницы', /const loaded = new Map<string, Promise</.test(api));
  /* Сеть моргнула - следующая попытка должна быть попыткой, а не тем же отказом. */
  check('но не кэширует отказ', /void asked\.catch\(\(\) => loaded\.delete\(id\)\)/.test(api));
  /* Что записали - то больше не то, что лежит в кэше. */
  check('и push чистит то, что сам переписал', /for \(const id of payload\.deleted \?\? \[\]\) loaded\.delete\(id\)/.test(api));

  /* «Правила можно прогнать, а не прочитать» - на этом стоят все её тесты, и асинхронность внутри убила
   * бы ровно это. */
  check('reconcile осталась чистой: план НАЗЫВАЕТ, кого забрать',
    /pull: Wanted\[\];/.test(reconcile) && !/await/.test(reconcile));
  check('и решает по сводке, когда payload не приехал',
    /return flow\.summary\?\.events \?\? 0;/.test(reconcile)
      && /return flow\.summary\?\.bytes \?\? 0;/.test(reconcile));
  /* Ответ старого развёртывания сводки не несёт, и мок тоже - а первый же прогон против такого сервера
   * решил бы, что записей нет, и предложил стереть локальные. */
  check('но payload читается первым, когда он есть',
    /if \(Array\.isArray\(payload\?\.events\)\) return payload\.events\.length;/.test(reconcile));

  /* Десяток параллельных запросов по мегабайту на старте страницы - та же трата, только сжатая во времени. */
  check('забирает по одной, а не Promise.all',
    /for \(const want of plan\.pull\)/.test(reconciler) && !/Promise\.all\(plan\.pull/.test(reconciler));
  /* Пустая запись вытеснила бы целую, и следующий проход счёл бы, что здесь уже всё есть. */
  check('и не кладёт пустую запись поверх непришедшей',
    /if \(!events\.length\) continue;/.test(reconciler));
  check('а человеку сообщает, сколько ДОЕХАЛО', /pulled: pulled\.length/.test(reconciler));

  /* roleOf читает payload.role. Без второй половины он вернул бы null для КАЖДОЙ записи - тихо, потому
   * что null законный ответ, - и Skills показал бы не то. */
  const role = read('../api/_flow-role.mjs');
  check('роль читается из сводки, когда payload не приехал',
    /flow\.summary && typeof flow\.summary\.role === 'string'/.test(role));
  check('и payload остаётся первым, потому что он точнее',
    /payload && typeof payload\.role === 'string' \? payload\.role/.test(role));
}

/* ------------------------------------------------------- длинная запись доезжает до аккаунта */

/* Человек записал полтора часа работы - 34 722 события, 2098КБ - и запись не уехала никуда. Потолок
 * стоял на 400КБ без объяснения, push отказал, а транскрипт строится на сервере, который её не видел, -
 * поэтому панель сказала «no recording with that id on this account». Час работы остался в браузере и не
 * читался ничем.
 *
 * Полтора часа - это не злоупотребление, а ровно то, что продукт предлагает делать. Потолок, режущий
 * обычное использование, - не защита, а поломка. */
group('длинная запись доезжает до аккаунта');
{
  /* Переехали в api/_payload.mjs: писателей у user_flow.payload двое - api/sync.js принимает push, а
   * api/mcp.js кладёт запись, остановленную агентом без открытого браузера, - и потолок стоял только у
   * первого. Два писателя одной колонки не могут иметь два представления о том, что в неё влезает. */
  const { inflatePayload, PAYLOAD_MAX_BYTES } = await import(new URL('../api/_payload.mjs', import.meta.url));
  const { gzipSync } = await import('node:zlib');

  /* Число взято из измерений: 23КБ в минуту на живом аккаунте. Восемь мегабайт - запись длиннее рабочего
   * дня; полтора часа весят два. */
  check('потолок вмещает запись длиной в рабочий день', PAYLOAD_MAX_BYTES >= 8_000_000,
    String(PAYLOAD_MAX_BYTES));
  check('и полуторачасовая запись, из-за которой это писалось, в него влезает',
    2098 * 1024 < PAYLOAD_MAX_BYTES);

  /* Круговой прогон: то, что кладёт браузер, сервер разворачивает побайтово тем же. */
  const payload = {
    kind: 'recorded', agent: 'desktop', version: '0.9.7', windows: [],
    events: Array.from({ length: 4000 }, (_, i) => ({
      action: 'Mouse Movement', x: 100 + (i % 900), y: 200 + (i % 500), delayMs: 10,
    })),
  };
  const text = JSON.stringify(payload);
  const wire = gzipSync(Buffer.from(text)).toString('base64');
  const opened = inflatePayload(wire);
  check('сжатый payload разворачивается', !opened.why, String(opened.why));
  check('и разворачивается ровно в то, что было', opened.encoded === text);
  check('и разбирается в тот же объект',
    JSON.stringify(opened.value) === text, 'события: ' + (opened.value?.events?.length ?? 'нет'));
  /* Ради чего всё: события мыши повторяются почти дословно. */
  check('и на проводе оно на порядок меньше', wire.length < text.length / 5,
    `${Math.round(text.length / 1024)}KB -> ${Math.round(wire.length / 1024)}KB`);

  /* «Несколько килобайт, разворачивающихся в гигабайт» - не гипотеза, а стандартный приём. Проверка
   * размера ПОСЛЕ распаковки означала бы сперва распаковать. */
  const bomb = gzipSync(Buffer.alloc(50_000_000, 0x41)).toString('base64');
  const stopped = inflatePayload(bomb);
  check('зип-бомба обрывается на пороге, а не в памяти', !!stopped.why, JSON.stringify(stopped).slice(0, 80));
  check('и человеку называется размер, а не текст ошибки zlib',
    /unpacks to more than \d+KB/.test(stopped.why || ''), String(stopped.why));

  check('не-gzip отвергается, а не роняет маршрут', !!inflatePayload('bm90IGd6aXA=').why);
  check('и не-строка тоже', !!inflatePayload(null).why && !!inflatePayload(42).why);
  /* Сжатое, но не JSON: разворачивается, а разобрать нечего. */
  check('сжатый мусор отвергается на разборе',
    /not valid JSON/.test(inflatePayload(gzipSync(Buffer.from('{{{')).toString('base64')).why || ''));

  /* Оба входа принимаются: агенты и расширение шлют payload, браузер - payloadZ. Запись, отказанная за
   * то, что отправитель старый, - та же потеря часа, только с другой причиной. */
  const sync = read('../api/sync.js');
  check('старый вход не отнят', /let payload = flow && flow\.payload;/.test(sync));
  check('и новый добавлен рядом', /if \(!payload && flow && flow\.payloadZ\)/.test(sync));
  /* Сжатие меняет цену перевозки, а не то, сколько это займёт места у нас. */
  check('проверяется РАЗВЁРНУТЫЙ размер, а не тот, что приехал',
    /if \(encoded\.length > PAYLOAD_MAX_BYTES\)/.test(sync));
  check('и отказ называет потолок, а не только вес',
    /and the ceiling is/.test(sync));

  /* На клиенте сжатие стоит в ЕДИНСТВЕННОМ месте отправки: строитель payload'а один, а вызывающих
   * четыре, и забыл бы тот, которого зовут реже всех. */
  const api = read('../web/src/lib/api.ts');
  check('клиент сжимает в одном месте, на выходе', /flows: await packFlows\(payload\.flows\)/.test(api));
  check('только то, что того стоит', /if \(text\.length < COMPRESS_OVER_BYTES\) return flow;/.test(api));
  check('и не шлёт обе формы разом', /const \{ payload: _dropped, \.\.\.rest \}/.test(api));
  /* Развернуть мегабайтный массив в аргументы - переполнение стека ровно на тех записях, ради которых
   * сжатие и делается. */
  /* Блочные комментарии сняты - и ТОЛЬКО они. Файл объясняет, почему не делает spread, и цитирует его;
   * искать запрещённое во всём тексте значит найти собственное объяснение. Снимать `//` нельзя: такой
   * стриппер не отличает комментарий от строкового литерала и однажды уже срезал «//host» прямо из URL. */
  const apiCode = api.replace(/\/\*[\s\S]*?\*\//g, '');
  check('base64 собирается кусками, а не одним spread',
    /i \+= 0x8000/.test(apiCode) && !/String\.fromCharCode\(\.\.\.bytes\)/.test(apiCode));
  check('браузер без CompressionStream шлёт как раньше',
    /if \(!canCompress\(\)\) return flows;/.test(api));
}

/* ------------------------------------------------------- двойной клик по тому, у чего нет имени */

/* Ветка звала unnamedClick() - функции с таким именем никогда не существовало, она называется
 * unnamedClicks, во множественном. То есть ReferenceError каждый раз, когда двойной клик приходился на
 * то, чему дерево доступности не дало имени: холст, тело документа, окно приложения без разрешения.
 * Такая запись не открывалась ВООБЩЕ - ни прочитать, ни отредактировать, ни сделать скилл, - и падало это
 * в transcribe(), то есть на маршруте.
 *
 * Ни одна из двадцати девяти записей на живом аккаунте в неё не попадала, поэтому и не всплывало. Тест
 * держит обе ветки, потому что чинилась одна, а сломать легко обе. */
group('двойной клик читается и тогда, когда у цели нет имени');
{
  const { transcribe } = await import(new URL('../api/_transcript.js', import.meta.url));
  const ev = (action, x, y, delayMs, context) =>
    (context ? { action, x, y, delayMs, context } : { action, x, y, delayMs });
  const story = (events) => {
    const out = transcribe({
      id: 't', name: 't', kind: 'recorded', source: 'desktop',
      payload: { kind: 'recorded', agent: 'desktop', version: '0.9.6', events, windows: [] },
    });
    return (out.segments || [])
      .flatMap((seg) => [seg.text, ...(seg.steps || []).map((s) => s.what)])
      .filter(Boolean).join(' | ');
  };
  /* Настоящая форма записи: клик приезжает парой Down/Release. Две пары в одной точке ближе 400мс - это
   * то, что transcribe складывает в двойной клик. */
  const twice = (context) => [
    ev('Left Click Down', 400, 300, 500, context), ev('Left Click Release', 400, 300, 40),
    ev('Left Click Down', 400, 300, 90, context), ev('Left Click Release', 400, 300, 40),
  ];

  let bare = null;
  let threw = null;
  try { bare = story(twice(null)); } catch (err) { threw = err; }
  check('запись с безымянным двойным кликом вообще открывается', !threw,
    threw ? threw.constructor.name + ': ' + threw.message : '');
  check('и говорит, что это был двойной клик', /double-clicked/.test(bare || ''), String(bare));
  check('называя координату, раз назвать больше нечего', /400,300/.test(bare || ''), String(bare));
  /* Точки отдаются самой unnamedClicks, а не приклеиваются после неё: она сама решает, ставить ли запятую,
   * и склейка снаружи давала «at 400,300 at 400,300». */
  check('и называя её ОДИН раз', (String(bare).match(/400,300/g) || []).length === 1, String(bare));

  const named = story(twice({ app: 'Microsoft Excel', control: 'Sheet1', type: 'tab' }));
  check('а когда имя есть, читается по имени',
    /double-clicked the "Sheet1" tab in Microsoft Excel/.test(named), named);

  /* И сам вызов - той функции, которая существует. Проверка по исходнику, потому что ветка редкая:
   * опечатку в имени вернут обратно, а тест выше поймает её только если кто-то соберёт ровно такой ввод. */
  /* Комментарии сняты: файл ОБЪЯСНЯЕТ, чем была опечатка, и цитирует её. Искать её в исходнике целиком -
   * значит найти собственное объяснение и посчитать его багом. Второй раз за сессию. */
  const src = read('../api/_transcript.js')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('и зовётся функция, которая существует',
    /unnamedClicks\(1, step\.ctx, \[step\.target\]\)/.test(src)
      && !/[^s]unnamedClick\(/.test(src));
}

/* ------------------------------------------------------------------ имя без приписки приложения */

/* Пришло как жалоба на внешний вид - «убери "использует 411 МБ памяти" из названия вкладок», - и оказалось
 * не про вид. Записанное имя это то, ПО ЧЕМУ ЦЕЛИТСЯ ПОВТОР: агент ищет в живом дереве элемент с таким же
 * именем, потому что полоса вкладок перекладывается. Число мегабайт меняется каждую минуту, значит
 * записанное имя не совпадёт с живым никогда - и прицел, написанный ради вкладок, на вкладках отказывал.
 *
 * Строки здесь настоящие: сняты с аккаунта, двенадцать таких из ста восьмидесяти трёх имён. */
group('имя вкладки читается без того, что браузер к нему приписал');
{
  const { plainName } = await import(new URL('../api/_names.mjs', import.meta.url));

  /* Форма первая: заголовок ЗАВЁРНУТ - приписка стоит и слева, и справа. Так пишет локализованный Chrome. */
  check('русский Chrome: заголовок достаётся из кавычек',
    plainName('Вкладка "Home - Google Drive" использует 448 МБ памяти') === 'Home - Google Drive',
    plainName('Вкладка "Home - Google Drive" использует 448 МБ памяти'));
  check('и вторая его формулировка тоже',
    plainName('Вкладка "(1) Chat / Margaryta Kashuba / Microsoft Teams" использует много памяти: 962 МБ')
      === '(1) Chat / Margaryta Kashuba / Microsoft Teams');
  check('заголовок с тире внутри не рассыпается',
    plainName('Вкладка "All Dashboards — kuswise — Sentry" использует 623 МБ памяти')
      === 'All Dashboards — kuswise — Sentry');

  /* Форма вторая: приписка ХВОСТОМ. Отрезается вместе со словом «память» - иначе осталось бы
   * «- Memory usage», - и вместе со всем, что стоит за ней: имя профиля тоже не часть имени. */
  check('английский Chrome: хвост отрезается вместе со словом про память',
    plainName('webmachinelearning/webmcp: WebMCP - Memory usage - 299 MB')
      === 'webmachinelearning/webmcp: WebMCP');
  check('и всё, что стоит ЗА припиской, тоже уходит',
    plainName('Входящие - Viktor Horlenko - Outlook - High memory usage - 815 MB - Vic')
      === 'Входящие - Viktor Horlenko - Outlook');
  check('заголовок из дефисов без пробелов не режется по ним',
    plainName('Продуктовый-фреймворк-Devart-21 - High memory usage - 1.4 GB')
      === 'Продуктовый-фреймворк-Devart-21');

  /* И ГЛАВНОЕ - чего оно НЕ делает. Переименованная кнопка это кнопка, которую повтор не найдёт в живом
   * дереве и кликнет по координате. Правило, написанное чинить прицел, не имеет права его ломать.
   *
   * Третья форма - «отрезать по самому числу, когда нет ни кавычек, ни разделителя» - была написана и
   * убрана именно из-за этих строк: на настоящих именах она не сработала ни разу, а «Upgrade to 200 GB
   * storage» превратила в «Upgrade to». */
  for (const safe of [
    'Send', 'MouseFlow', 'Адресная строка и строка поиска', 'D8', 'New mail',
    'Upgrade to 200 GB storage', 'Free up 2 GB now', 'Storage: 15 GB used',
    'Buy 2 GB plan', 'Download 15 GBP invoice', 'Play MP3', 'Reply to "Ann"',
  ]) {
    check(`имя без приписки не трогается: ${safe}`, plainName(safe) === safe, plainName(safe));
  }

  check('и не-строка не роняет его', plainName(null) === '' && plainName(undefined) === '');

  /* Одно определение на всех читателей: транскрипт показывает имя человеку, flowBody отдаёт его агенту
   * как цель прицела. Обе стороны обязаны видеть одно и то же имя, иначе человек читает одно, а повтор
   * ищет другое. */
  const transcript = read('../api/_transcript.js');
  const macro = read('../api/_macro.mjs');
  /* Проверяется НАМЕРЕНИЕ, а не соседство скобок. Прежняя версия закрепляла ровно
   * `shorten(plainName(src.control)` и сломалась, когда имя кнопки на панели задач стало проходить ещё
   * через plainShellName - хотя правило, за которым тест поставлен, при этом не изменилось ни на символ.
   * Тест, который падает от появления второго правила, охраняет форму записи, а не договор. */
  check('его читает транскрипт',
    /plainShellName\(plainName\(src\.control\), app, window\)/.test(transcript));
  /* plainName ВНУТРИ: он общий для обоих читателей, а plainShellName - только про оболочку Windows, и
   * снаружи он оказаться не может, иначе приписку про память будет искать правило про счётчик окон.
   *
   * Порядок стал длиннее на одно правило - nameOrLength, отбрасывающее содержимое, - и оно стоит МЕЖДУ
   * ними и обрезкой по длине. Это существенно: обрезка снаружи прячет длинное имя, а не отбрасывает его, и
   * поставь её раньше - в записи осталось бы содержимое, просто короче. */
  check('и обрезка по длине по-прежнему самая внешняя',
    /const named = nameOrLength\(plainShellName\(plainName\(src\.control\), app, window\), src\.nameLength\);/
      .test(transcript)
    && /const control = shorten\(named\.control, CTX_MAX\);/.test(transcript));
  /* И окно тоже, потому что заголовок несёт ту же приписку - плюс plainTitle снаружи от него: сначала
   * снимается приписка приложения, потом query из адреса, иначе «использует 448 МБ памяти» помешает узнать
   * в заголовке адрес, потому что в нём появятся пробелы. */
  check('и окно тоже, потому что заголовок окна несёт ту же приписку',
    /shorten\(plainTitle\(plainName\(src\.window\)\), CTX_MAX\)/.test(transcript));
  check('и тело повтора отдаёт агенту очищенное имя',
    /control=\$\{plainName\(e\.context\.control\)\}/.test(macro));
  check('оба берут его из одного файла, а не пишут своё',
    /from '\.\/_names\.mjs'/.test(transcript) && /from '\.\/_names\.mjs'/.test(macro));
}

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

group('the run log says what the gesture was made with');
{
  /* Проверяется по тексту, а не выполнением: describe.ts - это TypeScript внутри приложения, и запускать
   * его в этом наборе нечем. Поэтому утверждается ФОРМА правила, а не результат: префикс строится один раз
   * и применяется всеми тремя ветвями. */
  check('the prefix is built once, not three times',
    /const with_ = held\.length \? `\$\{held\.join\('\+'\)\}-` : '';/.test(describer)
      && (describer.match(/\$\{with_\}/g) || []).length === 3);
  /* Порядок ФИКСИРОВАН, а не тот, в котором модель перечислила: один и тот же жест обязан читаться
   * одинаково в двух прогонах, иначе журнал сравнивать нельзя. */
  check('and the order is fixed rather than as-listed',
    /\['cmd', 'ctrl', 'alt', 'shift'\]/.test(describer));
  /* Три ветви, и это те же три инструмента, у которых поле есть. Пропустить одну - значит получить журнал,
   * который для одного из трёх жестов молчит о модификаторе. */
  check('click, scroll and drag all carry it',
    /\$\{with_\}\$\{input\.double \? 'double-click'/.test(describer)
      && /\$\{with_\}scroll \$\{way\}/.test(describer)
      && /\$\{with_\}drag /.test(describer));
  /* И поле у инструментов есть - все три, потому что схема без описания к ней это поле, о котором модель не
   * узнает. */
  check('and all three tools declare the field',
    (brain.match(/modifiers: MODIFIERS,/g) || []).length === 3);
  /* Одно объяснение на три инструмента, а не три копии: разница с `press_key` - самое лёгкое место, где
   * ошибиться, и написанное трижды оно разошлось бы. */
  check('with one description shared by them, not three copies',
    /const MODIFIERS = \{/.test(brain)
      && /NOT press_key\\'s ctrl/.test(brain));
}

group('«clicked in the page, at 99,577» получает место');
{
  /* ЖАЛОБА, ИЗ КОТОРОЙ ЭТО ВЫРОСЛО, дословно: «clicked in the page, at 99,577». Координата была
   * единственным, что читатель получал о шаге, и разместить его по ней нельзя. Причина не в том, что чтение
   * не удалось — измерено, что под курсором в claude.ai безымянная группа, а единственное названное,
   * содержащее точку, это абзац, который человек читает. Поэтому записывается не то, на что нажали, а
   * ориентир: подпись ближайшего элемента управления и сторона. */
  const step = (fields) => `#ctx\t${fields}\n1 | 99 | 577 | 0 | Left Click Down\n`
    + '2 | 99 | 577 | 30 | Left Click Release\n';
  const read = (body) => {
    const { events } = parseMacro(body);
    return transcribe({ payload: { events }, name: 'p' });
  };
  const placeText = (out) => (out.story || []).filter((s) => s.kind === 'place').map((s) => s.text).join(' ');
  const stepText = (out) => (out.segments || []).flatMap((s) => s.steps || []).map((s) => s.what).join(' ');

  const fixed = read(step('app=chrome\twindow=Claude\ttype=group\tside=below\tnear=Address Bar'));
  check('та самая фраза теперь называет место',
    /just below "Address Bar"/.test(placeText(fixed)), placeText(fixed));
  /* Координата ОСТАЁТСЯ: она нужна повтору и редактированию. Менялось то, что она была единственным. */
  check('и координата при этом остаётся', /at 99,577/.test(placeText(fixed)));

  /* Имя, отброшенное за длину, — тот же случай «сказать нечего», по другой причине. Запятая обязательна:
   * «not recorded just above „X“» слипается в одну мысль, а это два разных факта. */
  const dropped = read(step('app=teams\twindow=Chat\tnamelen=1745\ttype=group\tside=above\tnear=Send feedback'));
  check('и шаг с отброшенным за длину именем тоже',
    /not recorded, just above "Send feedback"/.test(placeText(dropped)), placeText(dropped));

  /* `side=in` значит, что точка внутри названной области — это сильнее, чем «рядом». */
  const inside = read(step('app=explorer\twindow=scratchpad\ttype=pane\tside=in\tnear=Favorites'));
  check('точка внутри названной области читается как «in»',
    / in "Favorites"/.test(placeText(inside)), placeText(inside));
  /* И эта ветка возвращалась РАНЬШЕ остальных, теряя ориентир: шаг говорил «in „Favorites“», рассказ
   * молчал. Расхождение между двумя описаниями одного клика — хуже отсутствия обоих. */
  check('и рассказ с шагом об этом не расходятся',
    /Favorites/.test(placeText(inside)) && /Favorites/.test(stepText(inside)));

  /* Незнакомая или отсутствующая сторона — не причина молчать: «near „Отправить“» всё ещё размещает шаг. */
  const noSide = read(step('app=chrome\twindow=Claude\ttype=group\tnear=Send'));
  check('имя без стороны читается как «near»', /near "Send"/.test(placeText(noSide)), placeText(noSide));

  /* И РЕГРЕСС: без ориентира всё ровно как было. Старые записи его не несут, и их чтение меняться не
   * должно ни на слово. */
  const bare = read(step('app=chrome\twindow=Claude\ttype=group'));
  check('без ориентира текст не меняется',
    /in the page, at 99,577/.test(placeText(bare)) && !/near|just /.test(placeText(bare)),
    placeText(bare));

  /* Ориентир проходит те же правила, что всякое имя с экрана: приписка браузера про память бывает и на
   * кнопке, а подпись в четыреста символов ориентиром не является. */
  const memo = read(step('app=chrome\twindow=Claude\ttype=group\tside=below\tnear=Send  and 2 more pages'));
  check('и он проходит те же правила, что всякое имя с экрана',
    /"Send/.test(placeText(memo)), placeText(memo));
}

/* ------------------------------------------------------------------ выбор, которого запись не увидела */

/* ЗАМЕР, а не выдумка: rn3l06nya, шаги 11-27, как их отдаёт /api/transcript. Кнопка « Add filter», а следом
 * три клика с type=document и именем «Order search» - это имя ДОКУМЕНТА, и что человек выбрал в открывшемся
 * фильтре, запись не знает и знать не может. Как шаги они давали «click "Order search"» трижды подряд:
 * строчку, по которой ничего сделать нельзя, и при этом единственное место, где выбор произошёл. */
group('клик, попавший в саму страницу, - это место для ответа, а не шаг');
{
  const PAGE = 'https://secure.2checkout.com/cpanel/reports.php';
  const measured = [
    { n: 11, action: 'click', control: 'Clear filters', controlType: 'button', url: PAGE },
    { n: 12, action: 'move', control: null, controlType: null, url: PAGE },
    { n: 13, action: 'click', control: ' Add filter', controlType: 'button', url: PAGE },
    { n: 14, action: 'move', control: null, controlType: null, url: PAGE },
    { n: 15, action: 'click', control: 'Order search', controlType: 'document', url: PAGE },
    { n: 17, action: 'scroll', control: null, controlType: null, url: PAGE },
    { n: 21, action: 'wait', control: null, controlType: null, url: PAGE },
    { n: 23, action: 'click', control: 'Order search', controlType: 'document', url: PAGE },
    { n: 25, action: 'click', control: 'Order search', controlType: 'document', url: PAGE },
    { n: 27, action: 'click', control: 'Search', controlType: 'button', url: PAGE },
  ];
  const { runs, anchors, hushed } = choiceRuns(measured);

  check('серия кликов по странице - один вопрос, а не три одинаковых',
    runs.length === 1 && runs[0].clicks === 3, JSON.stringify(runs));
  /* Спросили-то про шаг «Click " Add filter"» - там ответ и должен стоять. */
  check('и стоит он на том шаге, который выбор открыл',
    runs[0].n === 13 && runs[0].after === ' Add filter');
  check('прокрутка и пауза серию не разрывают - это не действия',
    JSON.stringify(runs[0].steps) === JSON.stringify([15, 23, 25]));
  check('а сами клики по странице прячутся: за них отвечает вопрос',
    hushed.has(15) && hushed.has(23) && hushed.has(25) && !hushed.has(13));
  check('названная кнопка после серии её закрывает',
    !hushed.has(27) && anchors.size === 1);

  /* Клик по телу страницы - штука рядовая: на записи из 6705 шагов таких серий 144, и почти все они - клик
   * по пустому месту или снятие фокуса. Без открывающего клика это остаётся обычным шагом, иначе вопросов
   * было бы сто сорок четыре - тот самый провал, от которого рядом существует отбор набора текста. */
  const lonely = choiceRuns([
    { n: 1, action: 'click', control: 'Claude', controlType: 'document', url: 'https://claude.ai/' },
    { n: 2, action: 'move', control: null, controlType: null, url: 'https://claude.ai/' },
  ]);
  check('без открывающего клика серии нет - и шаг остаётся как был',
    lonely.runs.length === 0 && lonely.hushed.size === 0);

  /* Другой сайт - другой выбор. */
  const moved = choiceRuns([
    { n: 1, action: 'click', control: 'Tickets', controlType: 'link', url: 'https://desk.zoho.com/a' },
    { n: 2, action: 'click', control: 'List', controlType: 'main', url: 'https://desk.zoho.com/b' },
  ]);
  check('смена места разрывает серию', moved.runs.length === 0, JSON.stringify(moved.runs));

  /* Набор текста - свой разговор, у него свой пропуск. */
  const typed2 = choiceRuns([
    { n: 1, action: 'click', control: 'Comment', controlType: 'toggle button', url: 'u' },
    { n: 2, action: 'type', control: 'Comment', controlType: 'document', keys: 12, url: 'u' },
    { n: 3, action: 'click', control: 'Ticket', controlType: 'document', url: 'u' },
  ]);
  check('набор текста между ними тоже разрывает - у него свой пропуск',
    typed2.runs.length === 0, JSON.stringify(typed2.runs));

  check('контейнер - это тип, а не отсутствие имени',
    isContainerClick({ action: 'click', control: 'Order search', controlType: 'document' })
      && isContainerClick({ action: 'click', control: 'tickets List', controlType: 'main' })
      && !isContainerClick({ action: 'click', control: 'Search', controlType: 'button' })
      && !isContainerClick({ action: 'click', control: null, controlType: 'document' })
      && !isContainerClick({ action: 'type', control: 'x', controlType: 'document' }));

  /* Ответ дописывается ПОСЛЕ самого шага: сначала то, что запись видела, потом то, чего она видеть не
   * могла. Обратный порядок читался бы как инструкция выбрать раньше, чем открыл. */
  check('ответ встаёт в шаг после него, а не вместо него',
    wizard.includes('const withChoice = ') && wizard.includes('`${base}, then ${said}`'));
  check('и только у клика: выбор открывают нажатием',
    wizard.includes("case 'click': return named ? withChoice("));
  /* Пустой ответ - это 'skip', то есть шаг остаётся как был. Именно поэтому вопрос ничего не держит: Next
   * смотрит на 'fixed' без текста, а у выбора такого состояния не бывает. */
  check('пустой ответ возвращает шаг в исходное состояние, а не держит Next',
    wizard.includes("fill: (value.trim() ? 'fixed' : 'skip') as Fill")
      && wizard.includes("fill: (e.target.value.trim() ? 'fixed' : 'skip') as Fill"));
  /* Параметром выбор не становится: параметру нужны имя и тип, а тут неизвестно даже, что выбирали -
   * «фильтр» бывает продуктом, а бывает диапазоном дат. */
  check('и параметром не становится - ни один путь из вопроса не ведёт к ask',
    !wizard.slice(wizard.indexOf('const WhatWasChosen'), wizard.indexOf('const STAGES'))
      .includes("fill: 'ask'"));
  check('спрашивают в двух местах - у строки и списком - и правят один Blank',
    wizard.includes('<WhatWasChosen blank={blank}') && wizard.includes('{choices.length > 0 && ('));
  check('а сложенные клики названы там, где названо всё сложенное',
    wizard.includes('clicks that landed on the page itself'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
/* Exited rather than left to drain. Two servers and three spawned children have been closed and killed by
 * here, and a keep-alive socket that outlives them keeps the loop open - which turns a suite that has
 * finished and said so into one that appears to hang, and `npm test` never returns. Everything this file
 * had to say is above this line. */
process.exit(fail ? 1 : 0);
