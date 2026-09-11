/* The same decision loop, one turn per HTTP request.
 *
 * WHY IT IS NOT web/src/lib/desktop-engine.ts CALLED FROM HERE. That loop is a for-loop: it takes a
 * screenshot, asks the model, performs the action and comes round again, holding everything in local
 * variables. On a serverless function there is nowhere for those variables to live between one request from
 * the agent and the next - the instance that served step 4 may not be the one that serves step 5, and an
 * instance that is recycled mid-run would lose the run. So the loop is turned inside out: everything it
 * held becomes a value in `run_queue.loop`, and this file is one iteration of the body.
 *
 * What both drivers say to the model is NOT duplicated - see api/_brain.mjs, which is the whole point of
 * that file existing. What differs here is only bookkeeping.
 *
 * THE ROW NEVER HOLDS A PICTURE. Every state that goes back to the database goes through pack(), which
 * drops the images. A screenshot is 161KB; a run is up to 240 steps; a queue table that kept them would be
 * a picture album with a job id attached. The agent sends a fresh one every request, so there is nothing to
 * keep.
 *
 * THE SHAPE, so it can be read out of a row without this file:
 *
 *   v          the version of this shape, so a loop written by an older deploy can be recognised
 *   goal       the sentence being carried out, already filled in from the skill's parameters
 *   model      resolved once, at the start, so every step of one run is decided by one model
 *   wave/turn  where in the wave structure this run is (see WAVES in api/_brain.mjs)
 *   stepNo     decisions taken, across all waves - what the user is shown and what the caps count
 *   shotWidth  what to ask the agent for; halved when a turn came back too large
 *   messages   the conversation, pictures removed
 *   pending    actions the agent was told to do and has not reported on yet
 *   mine       results this side produced without asking the agent - an action it could not encode
 *   ending     a finish that arrived behind other actions in the same turn, to be honoured after them
 *   startedAt  when the run began, stamped once - see the note in startLoop
 *   steps/said the run log, in the shape user_run wants
 */
import {
  HANDOFF_ASK,
  HANDOFF_SYSTEM,
  LOOKS_ONLY,
  MAX_TOKENS,
  PEEK_ID,
  MAX_WAVES,
  SETTLE_MAX_MS,
  SYSTEM,
  TOOLS,
  WAVE_TURNS,
  actionBody,
  explainStatus,
  forgetOldPictures,
  openList,
  openingMessage,
  outOfWaves,
  peekBody,
  refusedAt,
  screenMessage,
  shouldPeek,
  toolsFor,
  truncatedAt,
  actionReport,
  actionSaid,
  AFTER_CUT,
  notBatched,
  sameTurn,
  STILL_GIVE_UP,
  stillStopped,
  waitReport,
} from './_brain.mjs';
/* Момент, на который цель просит отложиться, считается там же, где считаются расписания, - одним и тем
 * же способом для этого драйвера, для браузерного и для проверки на claim. */
import { clockSaid, deferInstant } from './_schedule.mjs';
import { memoryForOpen } from './_memory.mjs';
/* Вердикт по проверке - одним разбором на оба драйвера, потому что «прошло» обязано значить одно и то же,
 * откуда бы прогон ни шёл. См. api/_expect.mjs. */
import { checksOf, expectSaid, judge } from './_expect.mjs';
/* Какой кадр стоит оставить и как его назвать. Тот же расчёт, что у браузерного драйвера: отчёт, в котором
 * у одного прогона есть картинка провала, а у такого же другого нет, не читают. См. api/_artifact.mjs. */
import { kindOf, saidOf } from './_artifact.mjs';
import { DEFAULT_SHOT_W } from './_brain.mjs';
import { callModel } from './_vision.mjs';

export const LOOP_VERSION = 1;
/** Under this a screenshot is unreadable; a turn that is still too large at 320px ends the run. */
export const MIN_SHOT_W = 320;
/* A hard ceiling on one run, enforced by the queue as well as by the wave structure. The waves already
 * bound it; this is the backstop for a loop whose bookkeeping went wrong, because on this path there is no
 * tab to close and nobody watching. */
export const MAX_STEPS = WAVE_TURNS * MAX_WAVES;
/* One turn's model call. The platform kills a function at 300s; this leaves room for the upload and the
 * answer around it. A turn that times out ends the run, exactly as it does in the browser - retrying a
 * decision the model has already been paid for, with no way to tell a slow turn from a stuck one, is how
 * a run burns a budget without moving. */
export const MODEL_TIMEOUT_MS = 75_000;

/** A run at its first step: the goal, and nothing seen yet. */
export function startLoop({ goal, model, success = null, earlier = null, zone = null }) {
  return {
    v: LOOP_VERSION,
    goal: String(goal || ''),
    model: String(model || ''),
    /* Зона человека, чтобы сказать модели, который час, - и чтобы «в 19:41» значило его 19:41. Единственное,
     * чего сервер знать не может: приезжает с расписанием, с аргументами прогона или из настроек аккаунта;
     * без неё часы честно говорят UTC, и это сказано в строке. */
    zone: zone ? String(zone) : null,
    /* When the run really began, stamped once.
     *
     * The row cannot answer this: `claimed_at` is moved on with every step so that staleness means "not
     * heard from" rather than "took the job a while ago", which is right for the queue and useless as a
     * start time. Logging a run against it made a three-minute run read as eleven seconds - the length of
     * its last step - and the Hours and Insights screens are built on those stamps. */
    startedAt: new Date().toISOString(),
    wave: 1,
    turn: 0,
    stepNo: 0,
    shotWidth: DEFAULT_SHOT_W,
    /* Kept on the loop, not only used once: a wave rebuilds the conversation from scratch, and a test the
     * model was told about in wave one would otherwise be forgotten by wave two - which is precisely the
     * wave where it is closest to finishing and most likely to declare victory. */
    success: success ? String(success) : null,
    /* Сколько действий подряд не сдвинули экран. На цикле, а не в переменной хода: три неподвижных
     * действия в одном ходе и три в следующем - это шесть подряд, и человек, глядя на это, считал бы
     * именно так. */
    still: 0,
    /* Kept on the loop as well as used once, for the same reason `success` is: a wave rebuilds the
     * conversation from scratch, and background the model had in wave one would otherwise vanish in wave
     * two - which is the wave most likely to go looking for something it has forgotten exists. */
    earlier: earlier ? String(earlier) : null,
    messages: [openingMessage(String(goal || ''), null, null,
      success ? String(success) : null, earlier ? String(earlier) : null)],
    pending: [],
    mine: [],
    ending: null,
    steps: [],
    said: [],
  };
}

/** Nothing that goes to the database keeps a screenshot. Every return path goes through here. */
function pack(loop) {
  forgetOldPictures(loop.messages);
  return loop;
}

/* The upstream call, as this side makes it. Injectable so the loop can be driven by a test without an API
 * key and without spending anything - which is the only way the bookkeeping above gets exercised at all. */
async function defaultAsk(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { status: 503, body: { error: { message: 'this deployment has no shared key configured' } } };
  }
  const answer = await callModel(body, key, AbortSignal.timeout(MODEL_TIMEOUT_MS));
  if (answer.tooLarge) return { status: 413, body: null };
  if (answer.unreachable) return { status: 502, body: { error: { message: answer.unreachable } } };
  let parsed = null;
  try { parsed = JSON.parse(answer.text); } catch (_) { parsed = null; }
  return { status: answer.status, body: parsed };
}

/* What the agent said came of the actions it was given, in the blocks the API wants back.
 *
 * A pending action with no result is an error rather than an omission: the model has to know its click did
 * not happen, and a missing tool_result is not a thing the API will accept in any case. */
/* @param {{still: number}} loop  counted across turns, so a streak spanning two of them is still a streak */
/* `proven` - то, что этот ход доказал, собирается по пути наружу: кадр к нему один (один экран на ход), и
 * решает его вид `kindOf`. Массив, а не значение: пачка может сделать пять проверок сразу. */
function resultBlocks(pending, said, loop, proven) {
  const bySaid = new Map();
  for (const r of Array.isArray(said) ? said : []) bySaid.set(String(r && r.id), r);
  /* ОДИН СЧЁТ НА ХОД, а не на действие - см. STILL_WARN в _brain.mjs. Ход неподвижен, только если ни одно
   * его действие ничего не сдвинуло; сдвинуло хоть одно - счёт с нуля. Ожидания и действия агента, который
   * не умеет сказать `moved`, счёт не трогают: «не смог определить» это не «не сдвинулось».
   *
   * Сначала итог хода, потом уже слова: пока не прочитаны все результаты, неизвестно, был ли ход
   * неподвижен, а значит и какое число называть первому из них. */
  let judged = false;
  let stirred = false;
  for (const p of pending) {
    const got = bySaid.get(String(p.id));
    /* ВЗГЛЯД НЕ СУДИТ О НЕПОДВИЖНОСТИ. Агент отвечает `moved` про каждое действие, включая чтение окна, и
     * до появления проверок это было незаметно: шесть чтений подряд никто не делал. У QA-прогона форма
     * ровно такая - «сделай одно, проверь пять», - и на статичном экране он упирался бы в STILL_GIVE_UP
     * именно тогда, когда всё работает правильно. См. LOOKS_ONLY в _brain.mjs. */
    if (!got || p.name === 'wait' || LOOKS_ONLY.has(String(p.name))) continue;
    if (got.moved === true) { judged = true; stirred = true; } else if (got.moved === false) judged = true;
  }
  if (judged) loop.still = stirred ? 0 : loop.still + 1;
  if (judged && !stirred) {
    for (const p of pending) {
      const got = bySaid.get(String(p.id));
      if (got && got.moved === false) got.streak = loop.still;
    }
  }
  return pending.map((p) => {
    const got = bySaid.get(String(p.id));
    if (!got) {
      return {
        type: 'tool_result', tool_use_id: p.id, is_error: true,
        content: 'no result came back from the machine for this action',
      };
    }
    /* A wait reports numbers, not a sentence: the wording is one of the things both drivers have to say
     * identically, so it is composed here from what the agent measured. */
    /* An ordinary action reports whether the screen stirred, in the same words the browser driver uses -
     * composed here from the agent's fact for the same reason the wait is. `moved` is absent on any agent
     * older than 0.9.6, and absent means "could not tell", which reads as an ordinary "done" rather than
     * as a screen that stood still. */
    /* actionSaid rather than the three-way conditional this used to be. The rule - output when there is
     * one, the stirred/inert sentence when there is not - now lives in the brain beside actionReport,
     * because the browser driver has to apply exactly the same one and did not. */
    /* ПРОВЕРКА: вердикт выносится ЗДЕСЬ, когда ответ машины уже есть, и записывается в тот шаг, который
     * его заказал - `at` несёт его индекс, потому что шаг был добавлен ходом раньше.
     *
     * `is_error` остаётся ложным даже у FAIL, и это не мелочь: инструмент СРАБОТАЛ, ответ получен, не
     * сошлось утверждение. Пометить это ошибкой инструмента значило бы научить модель, что проверять
     * ломается, - а ей надо решить, что означает несошедшееся утверждение для цели. */
    if (p.name === 'expect') {
      const verdict = judge(p.input || {}, got.output, got.isError === true);
      const step = loop.steps[p.at];
      if (step) step.outcome = verdict;
      if (Array.isArray(proven)) proven.push({ at: p.at, verdict });
      return { type: 'tool_result', tool_use_id: p.id, content: expectSaid(p.input || {}, verdict) };
    }
    const content = p.name === 'wait' && got.quiet !== undefined
      ? waitReport(got)
      : actionSaid(got.output, got.moved === false ? false : undefined, got.streak || 0);
    return { type: 'tool_result', tool_use_id: p.id, content, is_error: got.isError === true };
  });
}

/* The seam between waves. No tools may be USED, but they must still be DECLARED - the API rejects a history
 * containing tool_use blocks with no tools defined, and by now it always contains them. */
async function askForHandoff(loop, ask) {
  const messages = loop.messages.concat([{ role: 'user', content: HANDOFF_ASK }]);
  let answer;
  try {
    answer = await ask({
      model: loop.model, max_tokens: 700, system: HANDOFF_SYSTEM,
      tools: TOOLS, tool_choice: { type: 'none' }, messages,
    });
  } catch (err) {
    return { error: `the handover could not reach the server (${err && err.message})` };
  }
  if (!answer || answer.status < 200 || answer.status >= 300 || !answer.body) {
    return { error: `the handover failed (HTTP ${answer ? answer.status : 0})` };
  }
  const note = (answer.body.content || [])
    .filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  return note ? { note } : { error: 'the handover came back empty' };
}

/**
 * One turn.
 *
 * In: the stored loop, a fresh screenshot, what is open, and what came of the last actions.
 * Out: the loop to store, plus exactly one of
 *   { actions }  do these and come back with a new picture
 *   { shrink }   that picture was too big to send - take a smaller one and ask again
 *   { done }     the run is over, with what to report
 */
/* `caps` - ПЛОСКИЕ ФЛАГИ МАШИНЫ, приехавшие с этим же шагом, и приехать они могут только так.
 *
 * На этом пути у облака нет способа спросить агента о чём-либо: агент сам держит запрос открытым, а
 * ничто отсюда до его 127.0.0.1 не достаёт - это то самое правило «машина спрашивает, ничто не тянется
 * внутрь», на котором держится вся эта половина. Значит возможности либо едут в теле шага, либо не
 * существуют для облачного драйвера вовсе.
 *
 * ПОЧЕМУ НЕ В loop, ОДИН РАЗ НА ПРОГОН. Строка живёт между шагами, а машина - нет: работу забрал один
 * агент, а через минуту на той же машине может отвечать обновлённый. Флаг, записанный при старте,
 * пережил бы факт, который он описывает. Здесь он стоит ровно столько, сколько длится ход, и это тот
 * срок, на который он верен.
 *
 * И отсутствие - это ОТВЕТ, а не false: старый агент про свои возможности не говорит ничего, и мозг
 * тогда инструмента не предлагает. См. toolsFor в api/_brain.mjs. */
export async function advance({ loop, shot, windows, results, caps, ask }) {
  const model = ask || defaultAsk;
  /* КАДР, КОТОРЫЙ СТОИТ ОСТАВИТЬ, - не больше одного за ход, потому что экран за ход один.
   *
   * Решается здесь, а пишется маршрутом (api/mcp.js): этот модуль ничего не знает ни о базе, ни о том, где
   * живут картинки, и знать не должен - его гоняет набор тестов без сети. Наружу уезжает только «оставь
   * этот кадр, вот под каким именем». */
  let keep = null;
  /* Провал вытесняет проверку, финал не вытесняет ничего: у провала одна картинка, и она важнее всех. */
  const keepFrame = (kind, stepNo, said) => {
    if (keep && keep.kind === 'failure' && kind !== 'failure') return;
    if (keep && kind === 'final') return;
    keep = { kind, stepNo, said: String(said || '').slice(0, 2000) };
  };
  /* КАДР НА ОКОНЧАНИИ. Неудача - всегда: это тот самый экран, по которому потом разбирают, что случилось.
   * Успех - только если прогон что-то УТВЕРЖДАЛ: зелёный отчёт без единой картинки нечем подкрепить, а
   * зелёный прогон, который ничего не проверял, - это просто выполненное поручение, и картинка ему не нужна.
   *
   * Вызывается из `over`, то есть на каждом пути окончания, а не только на finish - потому что «упёрся в
   * потолок шагов», «шесть ходов ничего не двигалось» и «модель отказалась» тоже надо разбирать по экрану. */
  const keepEnding = (out) => {
    if (out.ok !== true) {
      keepFrame('failure', loop.stepNo, out.error || out.said || 'the run did not finish');
    } else if (checksOf(loop.steps)) {
      keepFrame('final', loop.stepNo, out.said || 'finished');
    }
    return keep;
  };

  const over = (out) => ({
    loop: pack(loop),
    done: {
      ok: out.ok === true,
      said: out.said || null,
      /* СВОДКА ПРОВЕРОК, отдельно от исхода прогона, и это разделение - весь смысл.
       *
       * `ok` отвечает «процедура выполнена», `checks` - «утверждения сошлись». Прогон может быть `ok` с
       * провалившейся проверкой: агент сделал всё, о чём просили, а продукт повёл себя не так. Схлопнуть их
       * в одно значило бы либо назвать сломанный продукт успехом, либо назвать неудачей агента то, что он
       * как раз и обнаружил. Тест-кейс (пункт 5 плана) читает именно эти два числа. */
      checks: checksOf(loop.steps),
      error: out.ok === true ? null : (out.error || out.said || 'it stopped without saying why'),
      /* Отложенный прогон - не сделанный: драйвер маршрута видит это поле и ставит расписание вместо того,
       * чтобы записать зелёный прогон, которого не было. */
      deferred: out.deferred || null,
      /* И кадр, если этот ход что-то доказал или на нём всё кончилось. */
      keep: keepEnding(out),
      steps: loop.steps,
      saidAll: loop.said,
      stepNo: loop.stepNo,
    },
  });

  // 1. What the agent did with what it was last told to do.
  if (typeof loop.still !== 'number') loop.still = 0;      // a loop stored before this counter existed

  /* The reading that was asked for on the model's behalf, if the last turn carried one. It is NOT a
   * tool_result: no tool_use block matches it, and the API refuses a result with no call. It goes into the
   * next screen message instead, beside the picture it describes.
   *
   * An error is dropped rather than shown. An agent older than 0.16.0 answers `read` with "not implemented
   * on the macOS agent yet", and pasting that into the conversation would teach the model that looking does
   * not work - the opposite of the point. */
  const peeked = (Array.isArray(results) ? results : []).find((r) => r && String(r.id) === PEEK_ID);
  /* A local, not a field on the loop: it is read here and spent below, in this same call. On the cloud path
   * the loop is written back to a database row between turns, and a value that never needs to survive that
   * has no business being in it. */
  const saw = (peeked && peeked.isError !== true && peeked.output) ? String(peeked.output) : null;

  const proven = [];
  const answered = (loop.mine || []).concat(resultBlocks(loop.pending || [], results, loop, proven));
  /* Один кадр на ход, названный тем, что этот ход доказал. Пишется и при PASS: зелёная строка, к которой
   * можно вернуться и посмотреть, - это то, что делает зелёный отчёт проверяемым, а не просто зелёным. */
  if (proven.length) {
    keepFrame(kindOf(proven.map((one) => one.verdict)), proven[0].at,
      saidOf(proven.map((one) => one.verdict)));
  }
  if (answered.length) loop.messages.push({ role: 'user', content: answered });
  loop.mine = [];
  loop.pending = [];

  /* NOTHING HAS MOVED FOR SIX ACTIONS. Ended here, before another decision is bought.
   *
   * Warned three times already, in the results above, and each warning cost a step of about eight seconds.
   * A model that has not changed approach after those is not going to on the seventh, and the run watched
   * live spent a minute proving it - ten identical attempts, ended by a person who was watching. This is
   * that person's judgement, made by the loop instead.
   *
   * A failure, and it says so in the run's own words: what was reached before this stands, and the reason
   * names the thing that actually went wrong rather than blaming the step it stopped on. */
  if (loop.still >= STILL_GIVE_UP) {
    return over({ ok: false, error: stillStopped(loop.still), said: stillStopped(loop.still) });
  }

  /* A finish that arrived behind other actions in the same turn. Those actions were sent and have now been
   * carried out; the ending was always the answer and is honoured here rather than being dropped.
   *
   * НО ТОЛЬКО ЕСЛИ ОНИ И ПРАВДА ВЫПОЛНИЛИСЬ. «Были отправлены и теперь выполнены» - это допущение, а
   * `results` лежит прямо здесь и знает ответ: действие могло вернуться ошибкой или не вернуться вовсе.
   * Засчитывать после этого finish(ok:true) значит объявлять успехом прогон, чей последний шаг не
   * состоялся, - ровно тот ложный зелёный, против которого написан весь блок про turn-that-called-nothing:
   * ложный красный виден и оспорим, ложный зелёный нет.
   *
   * Проверяется только на УСПЕШНОМ окончании. finish(ok:false) - это отчёт о неудаче, и он верен тем более,
   * если вдобавок что-то не сработало. */
  if (loop.ending) {
    const broke = loop.ending.ok === true
      && answered.some((block) => block && block.is_error === true);
    if (broke) {
      const why = 'It reported success, but the action it decided that on did not go through — so the '
        + 'success was not checked against anything. Stopping instead of recording a finished run.';
      return over({ ok: false, error: why, said: loop.ending.said || null });
    }
    return over(loop.ending);
  }

  // 2. The seam between waves.
  if (loop.turn >= WAVE_TURNS) {
    if (loop.wave >= MAX_WAVES) return over({ ok: false, error: outOfWaves() });
    const handed = await askForHandoff(loop, model);
    if (!handed.note) {
      return over({
        ok: false,
        error: `It got as far as step ${loop.stepNo}, then ${handed.error}. It stopped there rather than `
          + 'starting the next stretch with no idea what had been done.',
      });
    }
    loop.wave += 1;
    loop.turn = 0;
    loop.messages = [openingMessage(loop.goal, null, handed.note, loop.success || null,
      loop.earlier || null)];
  }

  // 3. The picture.
  if (!shot || !shot.png) {
    return over({
      ok: false,
      error: `Could not take a picture of the screen at step ${loop.stepNo + 1}`
        + (shot && shot.error ? ` — the agent said: ${shot.error}` : '')
        + '. If the computer is locked or a remote session has been disconnected there is no desktop to '
        + 'look at.',
    });
  }
  if (loop.stepNo >= MAX_STEPS) {
    return over({
      ok: false,
      error: `This run reached ${MAX_STEPS} steps, which is the ceiling for one job. Nothing further was `
        + 'done. A goal that needs more than that needs breaking into smaller ones.',
    });
  }

  forgetOldPictures(loop.messages);
  /* platform: null - облачный драйвер ведёт агента с другой машины, и ничто в проводе `?worker=step`
   * сегодня не говорит, Windows это или Mac (MEMORY-PLAN.md §4.7.1 note, §5 шаг 3). memoryForOpen с
   * платформой null уже честно отвечает null сама, не читая карту, - и по этой же причине карта здесь
   * пустая ЗАДАЧЕЙ, а не за отсутствием таблицы (та уже есть, §5 шаг 5 применён): читать app_memory на
   * каждом ходу ради ответа, который платформа всё равно обнулит раньше, чем до карты дойдёт очередь, -
   * это ход, потраченный без единого шанса на пользу. Появится смысл, когда что-то узнает платформу
   * облачного агента - см. открытый вопрос в MEMORY-PLAN.md §4.6/§5 (row 3 и 4 обе о нём). */
  loop.messages.push(screenMessage(shot, openList(windows, shot), saw, clockSaid(Date.now(), loop.zone || 'UTC'),
    memoryForOpen(windows, null, new Map())));
  loop.stepNo += 1;
  loop.turn += 1;

  // 4. The decision.
  /* Timed, because "it sends a screenshot every four seconds" turned out to be neither a screenshot nor an
   * interval, and that was established by subtracting one measurement from another rather than by measuring
   * the thing itself. On this path the picture is taken by the agent and arrives with the request, so this
   * side can only honestly time the decision - which is the part the subtraction said was almost all of it. */
  const modelAt = Date.now();
  let answer;
  try {
    answer = await model({
      model: loop.model, max_tokens: MAX_TOKENS, system: SYSTEM,
      /* No checkpoint tool on this path: a checkpoint stops the run until a person answers, and on this
       * path there is no one at the other end of it - the request came from a machine. */
      tools: toolsFor(false, loop.success || null, caps || null), messages: loop.messages,
    });
  } catch (err) {
    return over({ ok: false, error: `The model could not be reached at step ${loop.stepNo}: ${err && err.message}` });
  }

  const modelMs = Date.now() - modelAt;

  /* Too large to send. The step never happened, so it is not counted, and the picture that caused it is
   * taken back out of the conversation - the next request brings a smaller one in its place. */
  if (answer.status === 413 && loop.shotWidth > MIN_SHOT_W) {
    loop.messages.pop();
    loop.stepNo -= 1;
    loop.turn -= 1;
    loop.shotWidth = Math.max(MIN_SHOT_W, Math.round(loop.shotWidth / 2));
    return { loop: pack(loop), shrink: loop.shotWidth };
  }

  if (answer.status < 200 || answer.status >= 300 || !answer.body) {
    const detail = answer.body && answer.body.error ? String(answer.body.error.message || '') : '';
    return over({ ok: false, error: explainStatus(answer.status, loop.stepNo, detail) });
  }

  const body = answer.body;
  if (body.stop_reason === 'refusal') return over({ ok: false, error: refusedAt(loop.stepNo) });
  if (body.stop_reason === 'max_tokens') return over({ ok: false, error: truncatedAt(loop.stepNo) });

  const blocks = Array.isArray(body.content) ? body.content : [];
  loop.messages.push({ role: 'assistant', content: blocks });

  const said = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  if (said) loop.said.push(said);

/* A TURN THAT CALLED NOTHING HAS NOT SUCCEEDED, and this used to be the opposite.
 *
 * `finish` exists so that success is CLAIMED - the branch below says so outright: anything but an explicit
 * true is a failure that said so in words. A turn that writes prose and calls no tool has claimed nothing,
 * so reading it as success infers the one thing the protocol insists must be stated. What actually ends
 * this way is a model that stalled, that asked the user a question, or that thought it was done and forgot
 * to say so - and all three closed the run green, were logged as `ok`, and fed the dashboard.
 *
 * A false red is visible and can be argued with. A false green is neither.
 *
 * The model is now told this in the `finish` description, so the requirement is stated where the decision
 * is made rather than only enforced afterwards. Whatever it wrote is carried into the reason, because that
 * sentence is usually the whole explanation. */
  const uses = blocks.filter((b) => b.type === 'tool_use');
  if (!uses.length) {
    const why = said || 'it stopped without doing anything or saying why';
    return over({ ok: false, said: why, error: why });
  }

  // 5. What the machine is to do next.
  const actions = [];
  /* The machine actions this turn has already taken, in order - what sameTurn reads. Names only: the rule
   * is about what an action AIMS AT, and nothing else about it matters here. */
  const ran = [];
  /* Отрезано, а не отфильтровано.
   *
   * Ход [клик, клик, печатать] - это не «выполнить первый и третий». Печатать модель собиралась в то, что
   * откроет ВТОРОЙ клик; выполнить её после первого значит напечатать не туда. Поэтому первый отказ
   * закрывает ход целиком, и всё за ним получает свой tool_result - API требует ответ на каждый tool_use,
   * и молчание было бы вторым способом сказать «сделано». */
  let cut = false;
  for (const use of uses) {
    if (use.name === 'finish') {
      /* Заявка на успех, опирающаяся на действия, которых не было. Ход обрезан - значит часть того, чем
       * этот finish обоснован, не выполнялась, и зачесть его здесь означало бы ровно тот ложный зелёный,
       * против которого написан весь блок выше. Модель посмотрит на свежий снимок и решит заново. */
      if (cut) {
        loop.mine.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: AFTER_CUT });
        continue;
      }
      // Success has to be claimed: anything but an explicit true is a failure that said so in words.
      const closing = String((use.input && use.input.said) || said || 'Done.');
      const claimed = use.input && use.input.ok === true;
      const ending = { ok: !!claimed, said: closing, error: claimed ? null : closing };
      /* Nothing else in this turn ran yet. If actions were already collected they were decided before the
       * finish and happen first, exactly as they would in the browser loop, and the ending waits. */
      if (!actions.length) return over(ending);
      loop.ending = ending;
      break;
    }

    /* ОТЛОЖИТЬ - это окончание, а не действие, и решается оно ЗДЕСЬ, а не моделью: она называет время, драйвер
     * считает момент. Время, которое уже наступило, - не повод ставить расписание на секунду вперёд: модели
     * говорят, который час, и просят продолжать. После обрезанного хода отказано по той же причине, что и
     * finish: заявление, опёртое на действия, которых не было. */
    if (use.name === 'defer_until') {
      if (cut) {
        loop.mine.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: AFTER_CUT });
        continue;
      }
      const when = deferInstant({ at: use.input && use.input.at, zone: loop.zone || 'UTC' });
      if (when.why) {
        loop.mine.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: when.why });
        /* Ход закрыт: что бы ни стояло за этим в том же ходу, оно планировалось на «потом». */
        cut = true;
        continue;
      }
      const then = String((use.input && use.input.then) || '').trim() || loop.goal;
      loop.steps.push({ tool: 'defer_until', input: { at: new Date(when.atMs).toISOString(), then } });
      if (!actions.length) {
        return over({ ok: true, said: `set aside until ${new Date(when.atMs).toISOString()}`,
          deferred: { at: new Date(when.atMs).toISOString(), zone: loop.zone || 'UTC', then } });
      }
      loop.ending = { ok: true, said: `set aside until ${new Date(when.atMs).toISOString()}`,
        deferred: { at: new Date(when.atMs).toISOString(), zone: loop.zone || 'UTC', then } };
      break;
    }

    /* A NOTE IS NOT AN ACTION, and every line of this branch follows from that.
     *
     * Before the batch rule and never added to `ran`: that rule is about actions that go stale with the
     * picture, and a note does not touch the picture. Counted the other way round it would be worse than
     * useless - a note in the middle of a turn would cut the turn having done nothing.
     *
     * Refused after a cut for the same reason finish is: a note is a CLAIM about what happened, and one
     * written on the back of actions that never ran is a false record in the place the user trusts.
     *
     * No `ms` on the step. The decision cost belongs to the actions this turn produced; charging it to a
     * note as well would double-count a single model call. */
    if (use.name === 'note') {
      if (cut) {
        loop.mine.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: AFTER_CUT });
        continue;
      }
      const said = String((use.input && use.input.text) || '').trim();
      if (!said) {
        loop.mine.push({
          type: 'tool_result', tool_use_id: use.id, is_error: true,
          content: 'nothing to record - note takes the text to write down',
        });
        continue;
      }
      loop.steps.push({ tool: 'note', input: { text: said } });
      loop.mine.push({ type: 'tool_result', tool_use_id: use.id, content: 'Recorded. It is in the record of this run for the user to read; nothing waits on it.' });
      continue;
    }

    /* THE BATCH RULE, applied before anything is counted or sent. An action refused here did not happen,
     * so it is not a step and not pending - only an answer the model reads next turn. */
    if (cut || !sameTurn(ran, use.name || '')) {
      loop.mine.push({
        type: 'tool_result', tool_use_id: use.id, is_error: true,
        content: cut ? AFTER_CUT : notBatched(ran, use.name || ''),
      });
      cut = true;
      continue;
    }

    /* The decision belongs to the TURN and is written onto each action it produced. A turn that returned
     * three actions paid for one decision, so summing this column over-counts - the number to read is the
     * per-turn one, and a reader who wants a total should take the distinct decisions. Said here because
     * the shape invites the wrong sum. */
    /* СКОЛЬКО ТОКЕНОВ ПРИШЛО ИЗ КЕША - рядом со временем, потому что это его объяснение. Пункт 6 плана
     * требует проверять кеширование по `usage.cache_read_input_tokens`, а число, которое некуда записать,
     * проверить нельзя. Ноль на первом ходу прогона - норма; ноль на тринадцатом значит, что префикс
     * перестал быть неменяющимся, и увидеть это можно только отсюда. */
    const cached = Number(body.usage && body.usage.cache_read_input_tokens) || 0;
    loop.steps.push({
      tool: use.name || '?',
      input: use.input || {},
      ms: { model: modelMs },
      ...(cached ? { cached } : {}),
    });

    if (use.name === 'wait') {
      const ms = Math.min(SETTLE_MAX_MS, Math.max(200, Number(use.input && use.input.ms) || 2000));
      actions.push({ id: use.id, kind: 'wait', ms, reason: String((use.input && use.input.reason) || '') });
      loop.pending.push({ id: use.id, name: 'wait' });
      ran.push('wait');
      continue;
    }

    const line = actionBody(use.name || '', use.input || {}, shot);
    if (!line) {
      /* Answered here and now: the machine is not asked to do something that has no wire form, and the
       * model still learns that its call went nowhere. */
      loop.mine.push({
        type: 'tool_result', tool_use_id: use.id, is_error: true,
        content: `no such action here: ${use.name}`,
      });
      /* And nothing behind it either: whatever the model meant to follow this did not happen. */
      cut = true;
      continue;
    }
    actions.push({ id: use.id, kind: 'do', name: use.name, body: line });
    /* `at` - индекс шага, который это действие заказало: ответ придёт ходом позже, и вердикт проверки надо
     * будет записать именно в тот шаг. `input` возится только у проверки - ей есть что судить. */
    loop.pending.push({
      id: use.id, name: use.name, at: loop.steps.length - 1,
      ...(use.name === 'expect' ? { input: use.input || {} } : {}),
    });
    ran.push(String(use.name || ''));
  }

  /* AND THE LOOK NOBODY ASKED FOR - appended last, so it reads the window as the model's own actions left
   * it rather than as it was before them. Not in `pending` (it answers no tool_use) and not in `steps` (the
   * model did not decide it, and charging it as a step would put a line in the user's run log for something
   * they cannot read as an intention). See shouldPeek. */
  if (actions.length && shouldPeek(loop.still)) {
    actions.push({ id: PEEK_ID, kind: 'do', name: 'read_window', body: peekBody(shot) });
  }

  return { loop: pack(loop), actions, step: loop.stepNo, shotWidth: loop.shotWidth, keep };
}
