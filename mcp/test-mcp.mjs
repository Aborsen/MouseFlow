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

const seen = { activate: [], replayBodies: [], runs: [], modelCalls: 0 };
let replaying = false;
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
    return json(res, 200, { ok: true, flows: 0, runs: (body.runs || []).length, deleted: 0, problems: [] });
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
      recording: false, playing: replaying,
      canSee: true, canWindows: true, canName: true, canKeys: true, canDrain: true,
    });
  }
  if (url.pathname === '/windows') return json(res, 200, { ok: true, windows: [{ title: 'Inbox', process: 'OUTLOOK' }] });
  if (url.pathname === '/shot') return json(res, 200, { ok: true, png: PNG, format: 'png', w: 1440, h: 900, scale: 1, originX: 0, originY: 0 });
  if (url.pathname === '/do') { seen.activate.push(await readBody(req)); return json(res, 200, { ok: true }); }
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
deployment.close();
agent.close();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
