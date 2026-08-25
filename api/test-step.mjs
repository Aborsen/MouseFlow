/* The cloud driver, one turn at a time, against a scripted model.
 *
 * Nothing here talks to Anthropic, to a database or to an agent. `advance()` takes the loop, a screenshot
 * and what came of the last actions, and returns the next loop plus what the machine should do - so the
 * whole of it can be driven from a test, which is the only reason the model call is an argument.
 *
 * What is worth testing here is the bookkeeping, because that is what turning a for-loop inside out put at
 * risk: that a step is counted once, that a picture never reaches the row, that a result finds its action,
 * that a wave seam starts the next wave from the note rather than from nothing, and that a finish behind
 * another action in the same turn still happens after it.
 *
 * Run: node api/test-step.mjs
 */
import { MAX_STEPS, MIN_SHOT_W, advance, startLoop } from './_step.mjs';
import { SETTLE_MAX_MS, WAVE_TURNS } from './_brain.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

/* A 1×1 PNG, so there is a real picture in the conversation. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const SHOT = { png: PNG, format: 'image/jpeg', w: 1280, h: 800, scale: 0.5, originX: 0, originY: 0 };
const WINDOWS = [{ title: 'Inbox — Outlook', process: 'OUTLOOK', active: true }];

const use = (name, input, id) => ({ type: 'tool_use', id: id || ('t' + name), name, input });
const says = (text) => ({ type: 'text', text });
const answer = (content, stop) => ({ status: 200, body: { stop_reason: stop || 'tool_use', content } });

/* A model that answers from a list, and remembers what it was asked.
 *
 * The request is COPIED, not kept. `advance` works on the loop in place - the conversation it hands the
 * model is the same array it goes on writing to - so holding a reference would show the state after the
 * turn and call it the request. Production is not affected: the real call serialises the body on the way
 * out, before anything else touches it. */
function scripted(list) {
  const seen = [];
  const ask = async (body) => {
    seen.push(JSON.parse(JSON.stringify(body)));
    const next = list.shift();
    if (!next) throw new Error('the script ran out of answers');
    return typeof next === 'function' ? next(body) : next;
  };
  ask.seen = seen;
  return ask;
}

const pictures = (loop) => JSON.stringify(loop.messages).match(/"type":"image"/g)?.length || 0;
const start = (goal) => startLoop({ goal: goal || 'email bob@example.com the note', model: 'claude-opus-5' });

/* --------------------------------------------------------------------------------- one turn */

group('a turn goes out as one action and comes back as one result');
{
  const ask = scripted([answer([says('Opening it.'), use('click', { x: 100, y: 200, label: 'New mail' })])]);
  const first = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });

  check('the machine is given exactly one thing to do', first.actions && first.actions.length === 1,
    JSON.stringify(first.actions));
  check('as the wire line the agents already speak',
    first.actions[0].body === 'action=click x=200 y=400 button=left double=0 name=New mail',
    first.actions[0].body);
  check('the picture\'s coordinates were turned into the screen\'s',
    /x=200 y=400/.test(first.actions[0].body));
  check('the step is counted once', first.loop.stepNo === 1 && first.loop.turn === 1);
  /* Наблюдено на живом прогоне: три минуты записались в лог как одиннадцать секунд, потому что за начало
   * брался claimed_at, а его двигает каждый шаг. Начало у прогона одно, и ставится оно один раз. */
  check('and the run knows when it really began',
    /^\d{4}-\d\d-\d\dT/.test(first.loop.startedAt), String(first.loop.startedAt));
  check('and the action is remembered as pending', first.loop.pending.length === 1);

  /* The one thing a queue table must never become. */
  check('NO SCREENSHOT is stored in the loop', pictures(first.loop) === 0, String(pictures(first.loop)));
  check('and the model did see one', JSON.stringify(ask.seen[0].messages).includes('"type":"image"'));
  check('the checkpoint tool is not offered where nobody can answer it',
    !JSON.stringify(ask.seen[0].tools).includes('reached_checkpoint'));

  const ask2 = scripted([answer([use('finish', { ok: true, said: 'Sent it.' })])]);
  const second = await advance({
    loop: first.loop, shot: SHOT, windows: WINDOWS, ask: ask2,
    results: [{ id: first.actions[0].id, output: 'done' }],
  });
  check('the run ends when finish claims success', second.done && second.done.ok === true);
  /* Наблюдено на живом прогоне: три минуты записались в лог как одиннадцать секунд, потому что за начало
   * брался claimed_at, а его двигает каждый шаг. Начало у прогона одно. */
  check('and the start it reports is the one it began with, not the last step',
    second.loop.startedAt === first.loop.startedAt, String(second.loop.startedAt));
  check('with what it said', second.done.said === 'Sent it.');
  check('and the result reached the model as a tool_result',
    JSON.stringify(ask2.seen[0].messages).includes('"tool_use_id":"tclick"'));
  check('the step trace is the shape user_run wants',
    Array.isArray(second.done.steps) && second.done.steps[0].tool === 'click');
}

group('a finish that does not claim success is a failure that said why');
{
  const ask = scripted([answer([use('finish', { ok: false, said: 'I could not find the button.' })])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('ok is false', out.done && out.done.ok === false);
  check('and the reason is what it said', out.done.error === 'I could not find the button.');
}

/* Silence is not success, and it used to be. A turn that writes prose and calls no tool has claimed
 * nothing, so reading it as success infers the one thing `finish` exists to make explicit. What ends this
 * way is a model that stalled, asked a question, or forgot to say it was done - and all three closed the
 * run green and were logged as `ok`. A false red is visible; a false green is not. */
/* "It sends a screenshot every four seconds" was the report. The agent answers /shot in tens of
 * milliseconds and this loop has no timer in it at all - so the four seconds were the decision, which was
 * established by subtracting one measurement from another. Every step carries its own now. */
/* A run spent a minute renaming a spreadsheet, ten actions at six to nine seconds, none of which landed:
 * the caret was never in the field and nothing told it. The screen fingerprint costs thirty milliseconds
 * and is the signal that was missing - stated as an observation, because some actions correctly change
 * nothing and calling those failures would abandon working steps. */
/* The condition belongs in BOTH places. The opening message is read while the model is choosing a route;
 * the `finish` description is read when it decides to stop - and the check matters in the second. Telling
 * it once at the start of a twenty-step run and hoping it is remembered is relying on attention where a
 * repetition costs nothing. */
group('what done looks like reaches the run, twice');
{
  const ask = scripted([answer([use('finish', { ok: true, said: 'done' })])]);
  const loop = startLoop({
    goal: 'send the note', model: 'claude-opus-5',
    success: 'the message appears in Sent',
  });
  await advance({ loop, shot: SHOT, windows: WINDOWS, results: [], ask });
  const sent = ask.seen[0];
  check('it is in the opening message, its own paragraph',
    /Done looks like this: the message appears in Sent/.test(JSON.stringify(sent.messages)));
  check('and in the finish tool, where stopping is decided',
    /done looks like this: the message appears in Sent/i
      .test(JSON.stringify(sent.tools.find((t) => t.name === 'finish'))));
  check('a skill that said nothing gets neither, rather than an empty sentence', (() => {
    const quiet = scripted([answer([use('finish', { ok: true, said: 'done' })])]);
    return startLoop({ goal: 'x', model: 'm' }).success === null && !!quiet;
  })());
}

group('an action that changed nothing says so');
{
  const ask = scripted([answer([use('click', { x: 1, y: 2 }, 'c1')])]);
  const first = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  const seen = scripted([answer([use('finish', { ok: true, said: 'done' })])]);
  const second = await advance({
    loop: first.loop, shot: SHOT, windows: WINDOWS,
    results: [{ id: 'c1', output: 'done', moved: false }], ask: seen,
  });
  const sent = JSON.stringify(seen.seen[0].messages);
  check('the model is told the screen stood still',
    /screen looks exactly as it did before/.test(sent));
  check('and told what to do about it, rather than to try again',
    /rather than doing the same thing again/.test(sent));
  check('the run is not failed over it — some actions correctly change nothing',
    !second.done || second.done.ok !== false);
}
{
  const ask = scripted([answer([use('click', { x: 1, y: 2 }, 'c2')])]);
  const first = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  const seen = scripted([answer([use('finish', { ok: true, said: 'done' })])]);
  await advance({
    loop: first.loop, shot: SHOT, windows: WINDOWS,
    results: [{ id: 'c2', output: 'done' }], ask: seen,
  });
  check('an agent too old to say gets an ordinary "done", not a claim about the screen',
    !/screen looks exactly/.test(JSON.stringify(seen.seen[0].messages)));
}

group('a step says what it cost');
{
  const slow = async () => {
    await new Promise((r) => setTimeout(r, 60));
    return { status: 200, body: { stop_reason: 'tool_use', content: [use('click', { x: 1, y: 2 })] } };
  };
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask: slow });
  const step = out.loop.steps[0];
  check('the decision is timed', !!step.ms && typeof step.ms.model === 'number');
  check('and it is the time actually spent, not a guess',
    step.ms.model >= 55, String(step.ms && step.ms.model));
}

group('a turn that called nothing has not succeeded');
{
  const ask = scripted([answer([])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('it ends', !!out.done);
  check('and it ends as a failure', out.done && out.done.ok === false);
}
{
  const ask = scripted([answer([{ type: 'text', text: 'Which of the two invoices did you mean?' }])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('a question is a failure too, not a finished run',
    out.done && out.done.ok === false);
  check('and what it asked becomes the reason, because that is the whole explanation',
    out.done && /Which of the two invoices/.test(String(out.done.error)));
}

group('an action decided before a finish in the same turn still happens');
{
  const ask = scripted([answer([
    use('type_text', { text: 'the note' }, 'ta'),
    use('finish', { ok: true, said: 'Typed it.' }, 'tb'),
  ])]);
  const first = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('the machine is still told to type', first.actions.length === 1 && first.actions[0].kind === 'do');
  check('and the ending is held over', !!first.loop.ending);
  const second = await advance({
    loop: first.loop, shot: SHOT, windows: WINDOWS, ask: scripted([]),
    results: [{ id: 'ta', output: 'done' }],
  });
  check('which is honoured on the next turn, without asking the model again',
    second.done && second.done.ok === true && second.done.said === 'Typed it.');
}

/* --------------------------------------------------------------------------------- waiting */

group('waiting is the agent\'s job, and the report of it is not');
{
  const ask = scripted([answer([use('wait', { ms: 999999, reason: 'the page is loading' })])]);
  const first = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('a wait goes out as a wait, not as an action to perform', first.actions[0].kind === 'wait');
  check('capped at what the tool promises', first.actions[0].ms === SETTLE_MAX_MS, String(first.actions[0].ms));

  const ask2 = scripted([answer([use('finish', { ok: true, said: 'Done.' })])]);
  await advance({
    loop: first.loop, shot: SHOT, windows: WINDOWS, ask: ask2,
    results: [{ id: first.actions[0].id, quiet: true, waited: 5000, quietFor: 3000 }],
  });
  const back = JSON.stringify(ask2.seen[0].messages);
  check('and the model is told in the same words the browser uses',
    back.includes('The screen has been still for 3s after 5s of waiting.'), back.slice(-300));
}

group('an action with no wire form is answered here, not sent');
{
  const ask = scripted([answer([use('activate_window', {}, 'tw')])]);
  const first = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('nothing is sent to the machine', first.actions.length === 0);
  check('but the model is owed an answer', first.loop.mine.length === 1);

  const ask2 = scripted([answer([use('finish', { ok: true, said: 'ok' })])]);
  await advance({ loop: first.loop, shot: SHOT, windows: WINDOWS, results: [], ask: ask2 });
  check('which it gets on the next turn',
    JSON.stringify(ask2.seen[0].messages).includes('no such action here: activate_window'));
}

group('an action the machine never reported on is an error, not a silence');
{
  const ask = scripted([answer([use('click', { x: 10, y: 10 })])]);
  const first = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  const ask2 = scripted([answer([use('finish', { ok: false, said: 'gave up' })])]);
  await advance({ loop: first.loop, shot: SHOT, windows: WINDOWS, results: [], ask: ask2 });
  check('the model is told the click did not happen',
    JSON.stringify(ask2.seen[0].messages).includes('no result came back from the machine'));
}

/* --------------------------------------------------------------------------------- failures */

group('a picture too large to send shrinks the picture, not the run');
{
  const ask = scripted([{ status: 413, body: null }]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('the agent is asked for a smaller one', out.shrink === 640, String(out.shrink));
  check('the run is not over', !out.done);
  check('and the step that never happened is not counted', out.loop.stepNo === 0 && out.loop.turn === 0);
  check('the picture is taken back out of the conversation', pictures(out.loop) === 0);
  check('and so is the message it was in', out.loop.messages.length === 1, String(out.loop.messages.length));
}

group('still too large at the smallest picture ends the run, with the reason');
{
  const loop = start();
  loop.shotWidth = MIN_SHOT_W;
  const ask = scripted([{ status: 413, body: null }]);
  const out = await advance({ loop, shot: SHOT, windows: WINDOWS, results: [], ask });
  check('the run ends', out.done && out.done.ok === false);
  check('saying which step and what to do', /too large to send even at the smallest picture/.test(out.done.error),
    out.done.error);
}

group('a refusal and a truncated answer are different things and are said differently');
{
  const refused = await advance({
    loop: start(), shot: SHOT, windows: WINDOWS, results: [],
    ask: scripted([{ status: 200, body: { stop_reason: 'refusal', content: [] } }]),
  });
  check('a refusal says how to get past it', /declined to continue/.test(refused.done.error), refused.done.error);

  const cut = await advance({
    loop: start(), shot: SHOT, windows: WINDOWS, results: [],
    ask: scripted([{ status: 200, body: { stop_reason: 'max_tokens', content: [] } }]),
  });
  check('a cut-off answer is a failure, never a success',
    cut.done.ok === false && /cut off before it decided anything/.test(cut.done.error), cut.done.error);
}

group('an answer with no tool call ends the run rather than looping forever');
{
  const out = await advance({
    loop: start(), shot: SHOT, windows: WINDOWS, results: [],
    ask: scripted([answer([says('There is nothing to do here.')], 'end_turn')]),
  });
  check('it ends', !!out.done);
  check('and repeats what it said', out.done.said === 'There is nothing to do here.');
}

group('a screen that cannot be photographed is reported as that');
{
  const out = await advance({ loop: start(), shot: { png: '', error: 'no display' }, results: [], ask: scripted([]) });
  check('the run ends without asking the model', out.done && out.done.ok === false);
  check('and says what the agent said', /no display/.test(out.done.error), out.done.error);
}

/* --------------------------------------------------------------------------------- the long run */

group('a wave ends with a note, and the next wave starts from it');
{
  let loop = start();
  const clicks = [];
  for (let i = 0; i < WAVE_TURNS; i++) {
    const ask = scripted([answer([use('click', { x: 1, y: 1 }, 'c' + i)])]);
    const out = await advance({ loop, shot: SHOT, windows: WINDOWS, results: clicks, ask });
    loop = out.loop;
    clicks.length = 0;
    clicks.push({ id: 'c' + i, output: 'done' });
  }
  check(`${WAVE_TURNS} turns fit in one wave`, loop.turn === WAVE_TURNS && loop.wave === 1,
    `turn ${loop.turn} wave ${loop.wave}`);

  const ask = scripted([
    { status: 200, body: { stop_reason: 'end_turn', content: [says('Half of it is done; the draft is open.')] } },
    answer([use('click', { x: 2, y: 2 }, 'next')]),
  ]);
  const out = await advance({ loop, shot: SHOT, windows: WINDOWS, results: clicks, ask });
  check('the seam asks for a handover with the tools declared but forbidden',
    ask.seen[0].tool_choice && ask.seen[0].tool_choice.type === 'none' && Array.isArray(ask.seen[0].tools));
  check('the next wave starts over', out.loop.wave === 2 && out.loop.turn === 1);
  check('from the goal plus the note, and nothing else',
    ask.seen[1].messages[0].content.includes('Half of it is done')
    && ask.seen[1].messages[0].content.includes('email bob@example.com the note'));
  check('so the tenth wave costs what the first did', ask.seen[1].messages.length === 2,
    String(ask.seen[1].messages.length));
  check('and the step count keeps running across waves', out.loop.stepNo === WAVE_TURNS + 1);
  check('no picture was ever stored, over a whole wave', pictures(out.loop) === 0);
}

group('a run cannot go on forever');
{
  const loop = start();
  loop.stepNo = MAX_STEPS;
  const out = await advance({ loop, shot: SHOT, windows: WINDOWS, results: [], ask: scripted([]) });
  check('the ceiling ends it without asking the model', out.done && out.done.ok === false);
  check('and says so plainly', new RegExp(`reached ${MAX_STEPS} steps`).test(out.done.error), out.done.error);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
