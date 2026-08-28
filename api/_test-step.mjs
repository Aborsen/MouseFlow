/* ПОДЧЁРКИВАНИЕ В ИМЕНИ - НЕ СТИЛЬ, А ГРАНИЦА РАЗВЁРТЫВАНИЯ.
 *
 * Vercel собирает в функцию каждый файл в api/, КРОМЕ начинающихся с подчёркивания - поэтому
 * _brain.mjs и _step.mjs функциями не становятся. Без него этот файл ею становился: набор тестов,
 * висящий по публичному адресу, без авторизации и без потолка.
 *
 * Не догадка. Прогон против живого развёртывания:
 *
 *   GET /api/test-step.mjs    -> 500 за 0.5s   (падает, убивая инстанс)
 *   GET /api/test-report.mjs  -> оборван на 15s (гоняет набор и висит)
 *
 * Второе хуже первого: это чужое время на чужом счёте, по одному запросу без единого условия.
 * Аудит подтвердить этого не смог - он читал исходники, - и записал в «чего не проверили».
 */
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
 * Run: node api/_test-step.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_STEPS, MIN_SHOT_W, advance, startLoop } from './_step.mjs';
import { BATCH_MAX, SETTLE_MAX_MS, TOOLS, WAVE_TURNS } from './_brain.mjs';

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

/* One action that changed nothing is ordinary. Six in a row is the run watched live: ten identical
 * attempts to rename a spreadsheet, a minute of it, ended by a person who was watching. This is that
 * person's judgement made by the loop - warned at three, stopped at six. */
group('a run that has stopped moving stops');
{
  const loop = start();
  const told = [];
  let out;
  for (let i = 1; i <= 6; i++) {
    const ask = scripted([answer([use('click', { x: 1, y: 2 }, `c${i}`)])]);
    out = await advance({ loop, shot: SHOT, windows: WINDOWS, results: [], ask });
    if (out.done) break;
    const seen = scripted([answer([use('click', { x: 1, y: 2 }, `d${i}`)])]);
    out = await advance({
      loop, shot: SHOT, windows: WINDOWS,
      results: [{ id: `c${i}`, output: 'done', moved: false }], ask: seen,
    });
    /* The last turn ends the run before the model is asked, so there is nothing to record for it. */
    if (seen.seen[0]) told.push(JSON.stringify(seen.seen[0].messages));
    if (out.done) break;
  }
  check('by the third it is told plainly to try something different',
    told.some((m) => /turns in a row now with nothing changing on screen/.test(m)));
  check('and it ends rather than buying another decision', !!out.done);
  check('as a failure, saying what actually went wrong',
    out.done && out.done.ok === false
      && /Nothing on screen has changed through \d+ decisions in a row/.test(String(out.done.error)));
}
{
  /* СЧИТАЮТСЯ ХОДЫ, А НЕ ДЕЙСТВИЯ - до пачек это было одно и то же число.
   *
   * Ход «кликнуть в поле, Tab, Tab, Tab» - это ОДНО решение, а отпечаток 64x36 рамку фокуса вполне может
   * не заметить. По действиям такой ход насчитал бы сразу три из шести и убил бы работающий прогон вдвое
   * быстрее, чем человек, который на него смотрит. */
  const loop = start();
  const ask = scripted([answer([
    use('click', { x: 1, y: 1 }, 'b1'),
    use('press_key', { key: 'Tab' }, 'b2'),
    use('press_key', { key: 'Tab' }, 'b3'),
  ])]);
  await advance({ loop, shot: SHOT, windows: WINDOWS, results: [], ask });
  const next = scripted([answer([use('finish', { ok: true, said: 'done' })])]);
  await advance({
    loop, shot: SHOT, windows: WINDOWS, ask: next,
    results: [
      { id: 'b1', output: 'done', moved: false },
      { id: 'b2', output: 'done', moved: false },
      { id: 'b3', output: 'done', moved: false },
    ],
  });
  check('a batch of three inert actions counts as ONE turn that moved nothing', loop.still === 1,
    String(loop.still));
}
{
  /* И наоборот: сдвинуло хоть одно действие в ходе - ход не считается неподвижным вовсе. Клик, который
   * не перерисовал ничего, и печать, которая перерисовала, - это ход, который куда-то дошёл. */
  const loop = start();
  loop.still = 2;
  const ask = scripted([answer([
    use('click', { x: 1, y: 1 }, 'm1'),
    use('type_text', { text: 'hello' }, 'm2'),
  ])]);
  await advance({ loop, shot: SHOT, windows: WINDOWS, results: [], ask });
  const next = scripted([answer([use('finish', { ok: true, said: 'done' })])]);
  await advance({
    loop, shot: SHOT, windows: WINDOWS, ask: next,
    results: [
      { id: 'm1', output: 'done', moved: false },
      { id: 'm2', output: 'done', moved: true },
    ],
  });
  check('one action in the batch moving something resets the whole count', loop.still === 0,
    String(loop.still));
  /* И слова при этом не пугают: действие, которое ничего не сдвинуло, всё ещё об этом говорит - просто
   * без счёта, которого нет. */
  check('and the inert action still says so, without a streak it no longer has',
    /screen looks exactly as it did before/.test(JSON.stringify(next.seen[0].messages)));
}
{
  /* The counter is "in a row". A run that moves something is getting somewhere, however many inert
   * clicks it took along the way. */
  const loop = start();
  const first = scripted([answer([use('click', { x: 1, y: 2 }, 'a1')])]);
  await advance({ loop, shot: SHOT, windows: WINDOWS, results: [], ask: first });
  const second = scripted([answer([use('click', { x: 1, y: 2 }, 'a2')])]);
  await advance({
    loop, shot: SHOT, windows: WINDOWS,
    results: [{ id: 'a1', output: 'done', moved: false }], ask: second,
  });
  const third = scripted([answer([use('finish', { ok: true, said: 'done' })])]);
  await advance({
    loop, shot: SHOT, windows: WINDOWS,
    results: [{ id: 'a2', output: 'done', moved: true }], ask: third,
  });
  check('one that moves resets the count', loop.still === 0);
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

/* ------------------------------------------------------------------------------------- пачки */

/* Ход всегда мог унести несколько действий - оба драйвера умели это с самого начала, - и запрещал это
 * только промпт. Что здесь проверяется, так это ГРАНИЦА: что пачка режется по правилу, а не по вкусу
 * модели, и что отрезанное не считается сделанным. */

group('a turn carries one aimed action and the typing that follows it');
{
  const ask = scripted([answer([
    use('click', { x: 100, y: 200, label: 'To' }, 'c1'),
    use('type_text', { text: 'bob@example.com' }, 't1'),
    use('press_key', { key: 'Tab' }, 'k1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('all three go to the machine in one turn', out.actions.length === 3,
    JSON.stringify((out.actions || []).map((a) => a.name || a.kind)));
  check('in the order the model asked for',
    out.actions[0].name === 'click' && out.actions[1].name === 'type_text'
      && out.actions[2].name === 'press_key');
  check('and all three are pending', out.loop.pending.length === 3);
  /* Три действия за одно решение и одну картинку: ход считается один раз, и это вся экономия. */
  check('but the turn is counted ONCE, because one decision was bought',
    out.loop.stepNo === 1 && out.loop.turn === 1, `step ${out.loop.stepNo} turn ${out.loop.turn}`);
}

group('a second aimed action needs a picture taken after the first');
{
  const ask = scripted([answer([
    use('click', { x: 10, y: 10 }, 'c1'),
    use('click', { x: 20, y: 20 }, 'c2'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('only the first is sent', out.actions.length === 1 && out.actions[0].id === 'c1');
  check('the second is not pending, because it will not happen', out.loop.pending.length === 1);
  /* Не шаг: шагами считается сделанное, и отказ, попавший в лог, стал бы «шагом», за который никто
   * не отвечал. */
  check('and not a step either', out.loop.steps.length === 1, String(out.loop.steps.length));

  const ask2 = scripted([answer([use('finish', { ok: true, said: 'ok' })])]);
  await advance({
    loop: out.loop, shot: SHOT, windows: WINDOWS, ask: ask2,
    results: [{ id: 'c1', output: 'done', moved: true }],
  });
  const told = JSON.stringify(ask2.seen[0].messages);
  check('and the model is told why, in words it can act on', told.includes('not carried out'));
  check('naming the reason rather than just refusing', told.includes('aims at a place on screen'));
}

group('a batch is cut, not filtered');
{
  /* Печатать модель собиралась в то, что откроет ВТОРОЙ клик. Выполнить её после первого - напечатать
   * не туда, и это хуже, чем не напечатать вовсе. */
  const ask = scripted([answer([
    use('click', { x: 10, y: 10 }, 'c1'),
    use('click', { x: 20, y: 20 }, 'c2'),
    use('type_text', { text: 'hello' }, 't1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('the typing behind the refused click is dropped too', out.actions.length === 1,
    JSON.stringify((out.actions || []).map((a) => a.id)));
  check('and both refusals are answered', out.loop.mine.length === 2);
}

group('nothing follows a wait, and nothing follows an activate_window');
{
  const ask = scripted([answer([
    use('wait', { ms: 5000 }, 'w1'),
    use('type_text', { text: 'hello' }, 't1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('a wait ends the turn it is in', out.actions.length === 1 && out.actions[0].kind === 'wait');
  check('because the screen it left is not the one that was looked at',
    JSON.stringify(out.loop.mine).includes('the point of waiting is that the screen changed'));

  const ask2 = scripted([answer([
    use('activate_window', { process: 'notepad' }, 'a1'),
    use('type_text', { text: 'the note' }, 't2'),
  ])]);
  const out2 = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask: ask2 });
  /* Единственное прицельное действие, которое падает честно - а агент, получив пачку, выполняет её до
   * конца. Значит «активируй Блокнот, напечатай заметку» с непопавшей активацией напечатало бы заметку
   * в то, что стояло впереди. */
  check('and an activate_window ends it too', out2.actions.length === 1 && out2.actions[0].name === 'activate_window');
  check('because it can find no such window and say so afterwards',
    JSON.stringify(out2.loop.mine).includes('if no such window was found'));
}

group('a batch has a ceiling');
{
  const many = [use('click', { x: 1, y: 1 }, 'c0')];
  for (let i = 1; i <= BATCH_MAX; i++) many.push(use('press_key', { key: 'a' }, 'k' + i));
  const ask = scripted([answer(many)]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check(`at most ${BATCH_MAX} actions leave in one turn`, out.actions.length === BATCH_MAX,
    String(out.actions.length));
  check('and the rest are answered rather than silently dropped',
    out.loop.mine.length === many.length - BATCH_MAX, String(out.loop.mine.length));
}

group('a finish behind an action that FAILED is not honoured either');
{
  /* «Действия были отправлены и теперь выполнены» - это было допущением, а results лежит прямо здесь и
   * знает ответ. Прогон, чей последний шаг вернулся ошибкой, объявлялся успешным. */
  const ask = scripted([answer([
    use('click', { x: 10, y: 10 }, 'c1'),
    use('finish', { ok: true, said: 'Sent it.' }, 'f1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('the action goes out and the ending waits', out.actions.length === 1 && out.loop.ending);

  const done = await advance({
    loop: out.loop, shot: SHOT, windows: WINDOWS, ask: scripted([]),
    results: [{ id: 'c1', isError: true, output: 'the agent could not reach that point' }],
  });
  check('the run does not report success', done.done && done.done.ok === false,
    JSON.stringify(done.done && done.done.ok));
  check('and says the success was never checked against anything',
    /did not go through/.test(String(done.done.error)), String(done.done.error));
  /* Что модель написала, сохраняется: это обычно всё объяснение. */
  check('but what it said is kept', done.done.said === 'Sent it.');
}
{
  /* И обратное: действие прошло - окончание засчитывается, как и раньше. */
  const ask = scripted([answer([
    use('click', { x: 10, y: 10 }, 'c1'),
    use('finish', { ok: true, said: 'Sent it.' }, 'f1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  const done = await advance({
    loop: out.loop, shot: SHOT, windows: WINDOWS, ask: scripted([]),
    results: [{ id: 'c1', output: 'done', moved: true }],
  });
  check('an action that worked still ends the run green', done.done && done.done.ok === true);
}
{
  /* finish(ok:false) - это отчёт о неудаче, и он верен тем более, если вдобавок что-то не сработало. */
  const ask = scripted([answer([
    use('click', { x: 10, y: 10 }, 'c1'),
    use('finish', { ok: false, said: 'Could not find it.' }, 'f1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  const done = await advance({
    loop: out.loop, shot: SHOT, windows: WINDOWS, ask: scripted([]),
    results: [{ id: 'c1', isError: true, output: 'nope' }],
  });
  check('a failure reported behind a failed action keeps its own words',
    done.done && done.done.ok === false && /Could not find it/.test(String(done.done.error)));
}

group('a finish behind a cut turn is not honoured');
{
  /* Ложный красный виден и оспорим, ложный зелёный - нет. Успех, обоснованный действиями, которых не
   * было, не засчитывается: модель посмотрит на свежий снимок и решит заново. */
  const ask = scripted([answer([
    use('click', { x: 10, y: 10 }, 'c1'),
    use('click', { x: 20, y: 20 }, 'c2'),
    use('finish', { ok: true, said: 'Done it.' }, 'f1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('the run does not end', !out.done, JSON.stringify(out.done || null));
  check('and no ending is queued for afterwards', !out.loop.ending);
  check('the finish is answered like anything else behind the cut',
    out.loop.mine.length === 2 && JSON.stringify(out.loop.mine).includes('the turn was cut short'));
}

group('a finish behind a WHOLE batch is still honoured');
{
  /* Разница ровно в одном: здесь ничего не отрезали, значит всё, на чём стоит заявление, выполнено. */
  const ask = scripted([
    answer([
      use('type_text', { text: 'the last word' }, 't1'),
      use('press_key', { key: 'Enter' }, 'k1'),
      use('finish', { ok: true, said: 'Sent it.' }, 'f1'),
    ]),
  ]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('the actions go first', out.actions && out.actions.length === 2);
  check('and the ending waits for them', out.loop.ending && out.loop.ending.ok === true);

  const done = await advance({
    loop: out.loop, shot: SHOT, windows: WINDOWS, ask: scripted([]),
    results: [{ id: 't1', output: 'done', moved: true }, { id: 'k1', output: 'done', moved: true }],
  });
  check('and is honoured once they are done, without buying another decision',
    done.done && done.done.ok === true);
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

/* --------------------------------------------------------------------------------- wave 01 */

group('a note is recorded and is not an action');
{
  /* The shape this exists for: record a result WHILE doing the work, in one turn. If a note were treated as
   * an action the batch rule would cut the turn here and the click would never happen. */
  const ask = scripted([answer([
    use('note', { text: 'Test Case 1 result: the About dialog reports 7.2.14' }, 'n1'),
    use('click', { x: 100, y: 200 }, 'c1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });

  check('the note lands in the run record', out.loop.steps.some((s) => s.tool === 'note'),
    JSON.stringify(out.loop.steps.map((s) => s.tool)));
  check('with the words it was given',
    out.loop.steps.find((s) => s.tool === 'note')?.input?.text === 'Test Case 1 result: the About dialog reports 7.2.14');
  /* THE POINT: the click still ran. A note does not enter `ran`, so it cannot cut a turn. */
  check('and the action in the same turn still happened',
    out.actions.length === 1 && out.actions[0].kind === 'do' && out.actions[0].name === 'click',
    JSON.stringify(out.actions));
  check('nothing was sent to the machine for the note itself',
    !out.actions.some((a) => a.name === 'note'));
  /* Answered, because the API requires a result for every tool_use - and answered with something that says
   * nobody is waiting, or a model would sit expecting a reply. */
  /* `mine` and not `messages`: a turn's answers wait there and are folded into the conversation by the
   * NEXT advance - reading messages.at(-1) here would read the request that went out. */
  check('the model is told it was recorded, and that nothing waits on it',
    JSON.stringify(out.loop.mine).includes('nothing waits on it'), JSON.stringify(out.loop.mine));
}
{
  /* A note is a CLAIM about what happened. One written on the back of actions that never ran is a false
   * record in the one place the user trusts - so it is refused after a cut, exactly as finish is. */
  const ask = scripted([answer([
    use('click', { x: 1, y: 2 }, 'c1'),
    use('click', { x: 3, y: 4 }, 'c2'),
    use('note', { text: 'both clicks done' }, 'n1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('a note behind a cut turn is refused rather than written',
    !out.loop.steps.some((s) => s.tool === 'note'),
    JSON.stringify(out.loop.steps.map((s) => s.tool)));
}
{
  const ask = scripted([answer([use('note', { text: '   ' }, 'n1')])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('an empty note records nothing and says why',
    !out.loop.steps.some((s) => s.tool === 'note')
      && JSON.stringify(out.loop.mine).includes('nothing to record'), JSON.stringify(out.loop.mine));
}

group('hover is an aimed action, and the last one in its turn');
{
  const ask = scripted([answer([use('hover', { x: 300, y: 100 }, 'h1')])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  /* `move` has been an agent action since 0.7.0 - the whole of wave 01 is showing the model what is
   * already there, which is why it ships on a deploy with the agent untouched. */
  check('it goes out as the agent action that already existed',
    out.actions[0]?.body === 'action=move x=600 y=200', out.actions[0]?.body);
}
{
  /* Terminal, and for a reason no other action shares: hovering is done BECAUSE the screen is about to
   * change. Anything decided in the same turn was decided from the picture before the menu opened. */
  const ask = scripted([answer([
    use('hover', { x: 300, y: 100 }, 'h1'),
    use('type_text', { text: 'too soon' }, 'k1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('nothing may follow it, not even typing', out.actions.length === 1,
    JSON.stringify(out.actions.map((a) => a.name)));
  check('and the refusal says why, in the hover words',
    JSON.stringify(out.loop.mine).includes('a hover is done because the screen'),
    JSON.stringify(out.loop.mine));
}

group('the window list carries where each window is');
{
  const ask = scripted([answer([use('finish', { ok: true, said: 'done' })])]);
  await advance({
    loop: start(),
    shot: SHOT,
    windows: [
      { title: 'dbForge Studio', process: 'dbforgesql', active: true, x: 0, y: 0, w: 1920, h: 1032 },
      { title: 'Terminal', process: 'WindowsTerminal', minimized: true, x: -32000, y: -32000, w: 160, h: 28 },
    ],
    results: [],
    ask,
  });
  const sent = JSON.stringify(ask.seen[0].messages);
  /* `/windows` has always sent the rectangle and openList has always thrown it away. Two things a picture
   * cannot answer: what is covering the window you need, and where one is when it is not visible at all. */
  check('a visible window says its size and position', sent.includes('1920x1032 at 0,0'), sent.slice(-400));
  /* Windows puts a minimised window at -32000,-32000. A coordinate that looks like one and means "nowhere"
   * is worse than none: `minimised` is already the whole truth about where it is. */
  check('and a minimised one says only that it is minimised',
    sent.includes('WindowsTerminal, minimised]') && !sent.includes('-32000'));
}

group('press_key promises exactly what the agent can do');
{
  const key = TOOLS.find((t) => t.name === 'press_key');
  const table = readFileSync(fileURLToPath(new URL('../agent/mouseflow-agent.ps1', import.meta.url)), 'utf8');

  /* WHAT THIS GROUP IS FOR, restated once the answer changed - because that is when a test either becomes an
   * invariant or becomes a fossil.
   *
   * It began in wave 01 by asserting the description NAMED WHAT WAS MISSING: the schema promised "F1-F12"
   * while the agent's table had F1-F6, F11 and F12, so the model paid a step to discover each absence - and
   * in one watched run it paid two, on PrintScreen and on Snapshot, and then went to write itself a
   * screenshotter in PowerShell. Wave 04 put the keys in, so there is nothing left to name. Asserting the
   * old wording would now be asserting the old bug.
   *
   * The invariant underneath both is the same and is what is checked here: the description and the table
   * agree. */
  check('every F-key the description promises is in the table',
    /F1-F12/.test(key.description)
      && [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].every((n) => table.includes(`case "f${n}":`)));
  check('and so is PrintScreen, under the names people call it',
    /PrintScreen/.test(key.description)
      && /case "printscreen": case "prtsc": case "snapshot":/.test(table));
  /* Win is held now, so the schema must offer it - it was in the table as a KEY since 0.7.0 with no way to
   * hold it, which is what made Win+Shift+S inexpressible. */
  check('Win is offered as a modifier, not only as a key',
    key.input_schema.properties.win !== undefined && /\bWin\b/.test(key.description));
  /* AND WHAT THE MODIFIERS MEAN, because leaving it out cost a turn on a real run.
   *
   * On a Mac the model needed Cmd+N and sent `win=1 key=n` - flawless reasoning off this very text, which
   * listed `win` and said nothing at all about `ctrl`. The agent refused in the right words, but the turn
   * was spent and the run carries a red line. The grammar is deliberately ONE grammar for two platforms -
   * `ctrl` means "the command modifier", not "the Control key" - and a design that has to be inferred is a
   * design the model will infer wrongly. */
  check('the description says ctrl IS Command on macOS',
    /Command on macOS/.test(key.description) && /\bctrl\b/.test(key.description));
  check('and that Win is not a way to say Command',
    /no such key on macOS/i.test(key.description) && /never reach for it to mean Command/.test(key.description));
  /* И агент отказывает теми же словами, а не своими: две формулировки одного правила - это два правила. */
  const swift = readFileSync(fileURLToPath(new URL('../agent/mouseflow-agent.swift', import.meta.url)), 'utf8');
  check('and the agent refuses it in the same terms',
    /there is no Windows key on macOS/.test(swift) && /`ctrl` already means Command/.test(swift));
  /* And the description stops listing absences, because listing one that no longer exists is worse than
   * listing none: it sends the model round a wall that has been taken down. */
  check('nothing is listed as unavailable any more',
    !/NOT available/.test(key.description), key.description);
}

group('an action can answer with a fact, not just with done');
{
  /* The scenario the whole wave exists for: capture a window, and be told where it went. The agent returns
   * `output`; the loop must hand that to the model verbatim rather than replacing it with "done". */
  const ask = scripted([answer([use('capture_window', { title: 'dbForge' }, 'c1')])]);
  const first = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  /* The geometry travels with it from 0.14.0: a region capture used to answer in SCREEN pixels while
   * read_window answered in screenshot pixels, and a model that read one reply back after the other had two
   * coordinate systems in one conversation. */
  check('the capture goes out as the agent action, carrying the geometry it answers in',
    first.actions[0]?.body === 'action=capture scale=0.5 ox=0 oy=0 title=dbForge', first.actions[0]?.body);

  const said = 'captured "About dbForge Studio", 320x246, to C:\\x.png and onto the clipboard';
  const ask2 = scripted([answer([use('finish', { ok: true, said: 'done' })])]);
  await advance({
    loop: first.loop,
    shot: SHOT,
    windows: WINDOWS,
    results: [{ id: 'c1', output: said, moved: false }],
    ask: ask2,
  });
  /* Read out of the PARSED conversation, not out of JSON.stringify of it: the path in `said` contains a
   * backslash, which stringify doubles - so a substring check against the serialised form fails on a
   * message that is perfectly correct. The block is what the model is handed; that is what to assert on. */
  const blocks = ask2.seen[0].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const told = JSON.stringify(ask2.seen[0].messages);
  check('and what came back reaches the model word for word',
    blocks.some((b) => b.type === 'tool_result' && b.content === said),
    JSON.stringify(blocks.filter((b) => b.type === 'tool_result')));
  /* AND THE INERT SENTENCE IS DROPPED. A capture changes nothing on screen by design; appending "the screen
   * looks exactly as it did before" to a sentence that already reported success would be the loop guessing
   * about an action whose whole point is that it is invisible. */
  check('without being told the screen did not change, which a capture never does',
    !told.includes('looks exactly as it did before'));
}
{
  /* `done` and absent both mean "nothing to add" - what every action before 0.10.0 sends, and what the
   * eight older ones still send. Those must still get the stirred/inert wording. */
  const first = await advance({
    loop: start(), shot: SHOT, windows: WINDOWS, results: [],
    ask: scripted([answer([use('click', { x: 1, y: 2 }, 'k1')])]),
  });
  const ask2 = scripted([answer([use('finish', { ok: true, said: 'x' })])]);
  await advance({
    loop: first.loop, shot: SHOT, windows: WINDOWS,
    results: [{ id: 'k1', output: 'done', moved: false }], ask: ask2,
  });
  check('an ordinary action still gets told when nothing moved',
    JSON.stringify(ask2.seen[0].messages).includes('looks exactly as it did before'));
}

group('the clipboard pairs with the paste, and opening something ends the turn');
{
  /* The pairing this was made batchable for: put the text somewhere, paste it, in one turn. Neither half
   * reads the screen, so neither can be aimed at a stale picture. */
  const ask = scripted([answer([
    use('clipboard_write', { text: 'Test Case 1 result' }, 'w1'),
    use('press_key', { key: 'v', ctrl: true }, 'p1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('both halves run in one turn', out.actions.length === 2,
    JSON.stringify(out.actions.map((a) => a.name)));
  check('and the text travels base64, so a line break survives',
    /^action=clipwrite enc=b64 text=/.test(out.actions[0]?.body ?? ''), out.actions[0]?.body);
}
{
  /* Terminal, and for a reason activate_window only half shares: a window is about to appear AND it takes a
   * moment to do it, so anything aimed in the same turn was aimed before it existed. */
  const ask = scripted([answer([
    use('open_url', { url: 'https://docs.new' }, 'o1'),
    use('type_text', { text: 'too soon' }, 't1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('nothing follows an open', out.actions.length === 1,
    JSON.stringify(out.actions.map((a) => a.name)));
  check('and the refusal explains that the window is not there yet',
    JSON.stringify(out.loop.mine).includes('before that window existed'));
}
{
  /* NOT batchable, and this is the one that needed thinking about: a capture straight after a click races
   * the window it is trying to photograph. The answer to "capture the dialog that click opened" is to wait
   * and look. */
  const ask = scripted([answer([
    use('click', { x: 5, y: 5 }, 'c1'),
    use('capture_window', { title: 'About' }, 'p1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('a capture does not ride behind a click', out.actions.length === 1,
    JSON.stringify(out.actions.map((a) => a.name)));
}

group('the window list is what capture_window and activate_window are aimed with');
{
  const ask = scripted([answer([use('finish', { ok: true, said: 'x' })])]);
  await advance({
    loop: start(), shot: SHOT,
    windows: [{ title: 'About dbForge Studio', process: 'dbforgesql', x: 480, y: 221, w: 320, h: 246 }],
    results: [], ask,
  });
  const sent = JSON.stringify(ask.seen[0].messages);
  check('the model is told those titles are what capture takes', sent.includes('capture_window takes any of these titles'));
  check('and the rectangle is still there for working out what covers what', sent.includes('320x246 at 480,221'));
}

group('aiming by name, and the geometry that makes it clickable');
{
  /* THE TRAP THIS AVOIDS: /shot scales the picture down, so a position the agent reports in SCREEN pixels
   * would be a position the model then clicks in SCREENSHOT pixels. The three numbers go out with the action
   * and the agent answers in the model's own system - see ReadGeometry there, and the note in actionBody. */
  const ask = scripted([answer([use('read_window', { title: 'dbForge' }, 'r1')])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('the geometry the screenshot reported travels with the read',
    out.actions[0]?.body === 'action=read scale=0.5 ox=0 oy=0 title=dbForge', out.actions[0]?.body);
}
{
  /* The name goes in the wire's one spaces-allowed field, which is why find cannot ALSO take a window title.
   * A find for "Help" used to go looking for a WINDOW called Help. */
  const ask = scripted([answer([use('find_element', { name: 'About...', process: 'dbforge' }, 'f1')])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('a find carries the process first and the name last',
    out.actions[0]?.body === 'action=find scale=0.5 ox=0 oy=0 process=dbforge title=About...',
    out.actions[0]?.body);
}
{
  const ask = scripted([answer([use('drag', { x: 100, y: 200, toX: 100, toY: 400 }, 'd1')])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  /* Both ends through the same conversion. A drag with one end converted and one not is a drag across half
   * the screen on any scaled screenshot. */
  check('both ends of a drag are converted the same way',
    out.actions[0]?.body === 'action=drag x=200 y=400 tx=200 ty=800', out.actions[0]?.body);
}
{
  /* Looking is free of the batch rule in one direction and not the other, and both halves matter. */
  const ask = scripted([answer([
    use('click', { x: 5, y: 5 }, 'c1'),
    use('read_window', {}, 'r1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('a look may be added after the aimed action', out.actions.length === 2,
    JSON.stringify(out.actions.map((a) => a.name)));
}
{
  const ask = scripted([answer([
    use('find_element', { name: 'Send' }, 'f1'),
    use('click', { x: 5, y: 5 }, 'c1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('but nothing may follow one, because its answer has not arrived yet', out.actions.length === 1,
    JSON.stringify(out.actions.map((a) => a.name)));
}
{
  const ask = scripted([answer([
    use('scroll_to', { to: 'end' }, 's1'),
    use('click', { x: 5, y: 5 }, 'c1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('and nothing may follow a scroll_to or a drag', out.actions.length === 1);
  check('with a refusal that says the screen has moved',
    JSON.stringify(out.loop.mine).includes('moves the screen under anything that follows'));
}
{
  /* What the model is told when a window will not describe itself. The agent composes this one, because it
   * is the only side that knows which window went quiet - and the loop must pass it through untouched. */
  const first = await advance({
    loop: start(), shot: SHOT, windows: WINDOWS, results: [],
    ask: scripted([answer([use('read_window', { title: 'dbForge' }, 'r1')])]),
  });
  const quiet = 'that window did not answer within 4 seconds - it is busy, or showing something its '
    + 'accessibility interface is stuck behind. Work from the screenshot instead';
  const ask2 = scripted([answer([use('finish', { ok: false, said: 'x' })])]);
  await advance({
    loop: first.loop, shot: SHOT, windows: WINDOWS,
    results: [{ id: 'r1', output: quiet, isError: true }], ask: ask2,
  });
  const blocks = ask2.seen[0].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  check('a window that will not talk is reported in its own words',
    blocks.some((b) => b.type === 'tool_result' && b.content === quiet && b.is_error === true));
}

group('sideways, and a scroll that says what it actually did');
{
  const ask = scripted([answer([use('scroll', { x: 100, y: 200, amount: 4, direction: 'right' }, 's1')])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('a direction reaches the agent',
    out.actions[0]?.body === 'action=scroll x=200 y=400 amount=4 dir=right', out.actions[0]?.body);
}
{
  /* No direction keeps the reading that every caller before 0.12.0 relied on: the sign of `amount`. */
  const ask = scripted([answer([use('scroll', { x: 100, y: 200, amount: -3 }, 's1')])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('and without one, nothing about the old behaviour changes',
    out.actions[0]?.body === 'action=scroll x=200 y=400 amount=-3', out.actions[0]?.body);
}
{
  /* THE UNDER-DELIVERY THAT USED TO BE SILENT. `Math.Min(20, ...)` plus `{"ok":true}` meant fifty notches
   * delivered twenty and reported success, and the model then reasoned about a position it had not reached.
   * The agent composes the sentence; what this holds is that the loop passes it through instead of replacing
   * it with "done". */
  const first = await advance({
    loop: start(), shot: SHOT, windows: WINDOWS, results: [],
    ask: scripted([answer([use('scroll', { x: 1, y: 1, amount: 500, direction: 'down' }, 's1')])]),
  });
  const short = 'scrolled 120 notches, not 500 - 120 is as much as one scroll does. Call it again, or use '
    + 'scroll_to';
  const ask2 = scripted([answer([use('finish', { ok: true, said: 'x' })])]);
  await advance({
    loop: first.loop, shot: SHOT, windows: WINDOWS,
    results: [{ id: 's1', output: short, moved: true }], ask: ask2,
  });
  const blocks = ask2.seen[0].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  check('a short scroll says so, in the agent own words',
    blocks.some((b) => b.type === 'tool_result' && b.content === short));
}

group('two waits that name what they are waiting for');
{
  const ask = scripted([answer([use('wait_for_window', { title: 'Save as', ms: 8000 }, 'w1')])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('a wait for a window carries its limit and its direction',
    out.actions[0]?.body === 'action=waitwindow ms=8000 until=appears title=Save as',
    out.actions[0]?.body);
}
{
  /* Neither a title nor a process is not a wait, it is a wait for nothing - answered here rather than sent. */
  const ask = scripted([answer([use('wait_for_window', { ms: 3000 }, 'w1')])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('and one with nothing named never leaves', out.actions.length === 0,
    JSON.stringify(out.actions));
}
{
  const ask = scripted([answer([
    use('refresh_page', { process: 'chrome' }, 'r1'),
    use('click', { x: 5, y: 5 }, 'c1'),
  ])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('nothing follows a reload or a window wait', out.actions.length === 1);
  check('and the refusal says the screen has not been looked at',
    JSON.stringify(out.loop.mine).includes('a state nothing has looked at yet'));
}
{
  const ask = scripted([answer([use('press_key', { key: 'd', win: true }, 'k1')])]);
  const out = await advance({ loop: start(), shot: SHOT, windows: WINDOWS, results: [], ask });
  check('Win can be held now, which is what made Win+Shift+S impossible',
    out.actions[0]?.body === 'action=key key=d ctrl=0 shift=0 alt=0 win=1', out.actions[0]?.body);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
