/* The crash reporter, against a Sentry that is really a socket on this machine.
 *
 * api/_report.js writes the envelope by hand rather than carrying the SDK, and its own header names the
 * risk that comes with that: a wire format which was reasoned about rather than observed is a thing that
 * silently sends nothing. The format was checked once, by hand, against @sentry/node. This keeps it checked,
 * and it exists mainly for the path that is about to matter - an agent on somebody else's computer saying
 * it fell over, where "nothing arrived" and "nothing broke" look identical from here.
 *
 * The DSN points at a local server, which is the reason parseDsn takes the scheme from the DSN instead of
 * assuming https.
 *
 * Run: node api/test-report.mjs
 */
import { createServer } from 'node:http';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

const caught = [];
const sentry = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    caught.push({ url: req.url, type: req.headers['content-type'], body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"1"}');
  });
});
await new Promise((ready) => sentry.listen(0, '127.0.0.1', ready));
const port = sentry.address().port;

process.env.SENTRY_DSN = `http://testkey@127.0.0.1:${port}/42`;
const { reportSaid } = await import('./_report.js');

group('an agent crash arrives as a Sentry event, not as a shrug');
{
  const sent = await reportSaid({
    type: 'AgentError',
    message: 'the event tap was refused',
    stack: 'MouseFlowAgent.swift:214 tapCallback\nMouseFlowAgent.swift:88 main',
    tags: { route: 'agent', platform: 'macos', version: '0.8.2' },
    extra: { where: 'startRecording' },
  });
  check('it says it sent something, and means it', sent === true);
  check('exactly one request reached the server', caught.length === 1, String(caught.length));

  const hit = caught[0];
  check('at the envelope endpoint, with the key and version in the query',
    hit.url === '/api/42/envelope/?sentry_key=testkey&sentry_version=7', hit.url);
  check('as an envelope, not as JSON', hit.type === 'application/x-sentry-envelope', String(hit.type));

  const lines = hit.body.split('\n');
  check('three lines: envelope header, item header, event', lines.length === 3, String(lines.length));
  const head = JSON.parse(lines[0]);
  const item = JSON.parse(lines[1]);
  const event = JSON.parse(lines[2]);
  check('the header carries an event id', /^[0-9a-f]{32}$/.test(head.event_id), head.event_id);
  check('and the event carries the same one', event.event_id === head.event_id);
  check('the item is an event', item.type === 'event');

  check('the exception is what the agent said it was',
    event.exception.values[0].type === 'AgentError'
    && event.exception.values[0].value === 'the event tap was refused');
  /* Not 'node'. What ran was Swift; filing it as node would put it in the same bucket as this deployment. */
  check('the platform is not this deployment\'s', event.platform === 'other', event.platform);
  check('a foreign stack travels as text and is not passed off as a parsed trace',
    !event.exception.values[0].stacktrace && /MouseFlowAgent\.swift:214/.test(event.extra.stack));
  check('which agent and which build, since that is the usual difference',
    event.tags.platform === 'macos' && event.tags.version === '0.8.2');
  check('and where it happened', event.extra.where === 'startRecording');
}

group('what must never be reported');
{
  caught.length = 0;
  check('a crash with no message is not an event', (await reportSaid({ message: '' })) === false);
  check('and nothing was sent', caught.length === 0);

  const before = process.env.SENTRY_DSN;
  delete process.env.SENTRY_DSN;
  delete process.env.VITE_SENTRY_DSN;
  check('a deployment with no DSN says so rather than pretending',
    (await reportSaid({ message: 'x' })) === false);
  check('and still sends nothing', caught.length === 0);
  process.env.SENTRY_DSN = before;
}

group('a reporter never makes the incident worse');
{
  caught.length = 0;
  process.env.SENTRY_DSN = 'http://testkey@127.0.0.1:1/42';   // nothing listens there
  let threw = false;
  let answered = null;
  try { answered = await reportSaid({ message: 'nobody is home' }); } catch (_) { threw = true; }
  check('an unreachable Sentry does not throw', !threw);
  check('it reports that it failed', answered === false);
}

sentry.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
