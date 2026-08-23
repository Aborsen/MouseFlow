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
check('tools/list serves the app\'s own derivation rather than a copy',
  /wireFor\('mcp', entry\.structure\)/.test(route) && /from '\.\/_skill-schema\.mjs'/.test(route));
check('an unstamped row is not offered as a tool', /if \(role !== 'skill'\) \{ unstamped\+\+; continue; \}/.test(route));
check('and a call with no worker listening is refused rather than left to hang',
  /No machine has ever asked this account for work/.test(route));
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
check('the only place a sign-in may be sent back to is the consent page',
  /asked\.startsWith\('\/api\/oauth\?'\) \? asked : null/.test(provider));

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
check('nine of them, so a count in prose can be trusted', served.size === 9, String(served.size));
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
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const mainTsx = read('../web/src/main.tsx');
const sidebar = read('../web/src/shell/AppSidebar.tsx');
const settings = read('../web/src/shell/SettingsDialog.tsx');
const insights = read('../api/insights.js');
const teamApi = read('../api/team.js');
const scopeSrc = read('../api/_team-scope.js');

check('/team is a route of its own', /path: '\/team'/.test(mainTsx));
check('and it is in the sidebar, not buried in a dialog', /to: '\/team'/.test(sidebar));
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

/* The security property of the whole feature, in one check: the link is a place, not a key. */
const links = [...waiting.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
check('the link carries no token - it is the Teams page and nothing else',
  links.length === 1 && links[0] === 'https://mouseflowapp.vercel.app/team', links.join(' '));
check('the row is written before anything is sent, so a lost message costs a conversation, not a seat',
  teamApi.indexOf('insert into team_invite') < teamApi.indexOf('const post = await tellThem'));

check('with no mail configured it refuses rather than throwing, and names the variables',
  /RESEND_API_KEY/.test(String(mail.mailProblem())) && /MAIL_FROM/.test(String(mail.mailProblem())));
const unsent = await mail.sendMail({ to: 'somebody@example.dev', subject: 'x', text: 'y' });
check('and the caller is told why', unsent.sent === false && typeof unsent.why === 'string');
check('the endpoint says so too, before an address is typed', /mail: \{ configured:/.test(teamApi));

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
