/* "Create the flow": the loop that carries out a goal, driven from the page.
 *
 * The agent has eyes (/shot, /pulse), hands (/do) and a memory of what is open (/windows) - and no model.
 * Deciding what to do next is this file's job.
 *
 * WHAT IS STILL HERE AND WHAT IS NOT. The prompt, the tool schemas, the encoding of an action and the
 * reading of a reply moved to api/_brain.mjs, because there is a second driver now: api/_step.mjs runs the
 * same conversation in the cloud, one turn per request, for a machine with no worker on it. What is left
 * here is the DRIVING - whose turn it is, what to do while waiting, when to stop - and every lesson below
 * is about exactly that.
 *
 * Everything here was learned the hard way and is kept deliberately:
 *
 *   WAVES         a run is stretches of WAVE_TURNS decisions. At a seam the model stops acting and writes
 *                 a note; the next wave starts from the goal plus that note. Long tasks finish, and the
 *                 tenth wave costs what the first did because a wave carries only its own turns.
 *   tools at the seam   the handover request keeps `tools` and forbids their use with tool_choice: none.
 *                 Dropping the tools makes the API reject a history that contains tool_use blocks - which
 *                 it always does by then - so every long run used to die at the end of wave one.
 *   waiting is free   the screen is polled locally (a 3KB fingerprint) rather than by asking the model to
 *                 look again. A wait used to cost a screenshot and a step, so waiting for a page to
 *                 finish burned the whole budget.
 *   stop is per action   a turn can carry several tool calls, so the abort is checked before each one.
 *   413 shrinks the picture   rather than ending the run.
 *   finish must claim success   ok is required; anything else is a failure, because a run that gave up
 *                 used to report as green.
 */
import { AgentError } from './agent';
import type { Machine } from './agent';
import { desktopModel } from './model-config';
/* Всё, что модель ВИДИТ и что её ответ ЗНАЧИТ, живёт в одном месте на двоих - здесь и в облачном шаге,
 * который ведёт тот же разговор по одному ходу на запрос. Этот файл - драйвер: чей ход, что делать в
 * ожидании, когда остановиться. См. заголовок api/_brain.mjs. */
import {
  DEFAULT_SHOT_W,
  HANDOFF_ASK,
  HANDOFF_SYSTEM,
  MAX_TOKENS,
  MAX_WAVES,
  SETTLE_MAX_MS,
  SYSTEM,
  TOOLS,
  WAVE_TURNS,
  actionBody,
  explainStatus,
  forgetOldPictures,
  mediaType,
  openList,
  openingMessage,
  outOfWaves,
  refusedAt,
  peekBody,
  screenMessage,
  shouldPeek,
  toolsFor,
  truncatedAt,
  actionReport,
  actionSaid,
  earlierRuns,
  gridQuiet,
  gridStirred,
  AFTER_CUT,
  LOOKS_ONLY,
  notBatched,
  sameTurn,
  STILL_GIVE_UP,
  stillStopped,
  waitReport,
} from '../../../api/_brain.mjs';
import type { ShotFrame } from '../../../api/_brain.d.mts';
/* Тот же расчёт момента, что у облачного драйвера и у расписаний: «в 19:41» обязано значить одно и то же,
 * откуда бы прогон ни шёл. */
import { clockSaid, deferInstant } from '../../../api/_schedule.mjs';
/* Один разбор на оба драйвера: «прошло» обязано значить одно и то же, откуда бы прогон ни шёл. */
import { checksOf, expectSaid, judge } from '../../../api/_expect.mjs';
/* Какой кадр стоит оставить и как его назвать - тот же расчёт, что у облачного драйвера. */
import { kindOf, saidOf } from '../../../api/_artifact.mjs';

/* Re-exported so nothing else has to know the brain moved: the Create page counts waves, and the plan
 * preview and the checkpoint gate's thumbnail normalise a picture's format through mediaType. */
export { MAX_WAVES, WAVE_TURNS, actionBody, mediaType };
export type { ShotFrame };

/* The fallback when the deployment cannot say - the CONFIGURED model comes from model-config, resolved
 * once on the way into a run so every step of that run uses one answer. */
const MODEL = 'claude-opus-5';
let runModel = MODEL;
const MODEL_TIMEOUT_MS = 75000;
const SETTLE_POLL_MS = 1500;
const SETTLE_QUIET_FRAMES = 2;

/** Что модель ГОВОРИТ о своём продвижении, и решение человека. Не факт: см. заметку у CHECKPOINT_TOOL. */
export type GateAnswer = 'go' | 'stop';

export interface RunEvent {
  type: 'turn' | 'tool' | 'text' | 'error' | 'wave' | 'handoff' | 'waiting' | 'check';
  /** Только у 'check': прошло, не прошло или проверить не удалось. См. api/_expect.mjs. */
  pass?: boolean | null;
  n?: number;
  wave?: number;
  inWave?: number;
  of?: number;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  message?: string;
  ms?: number;
  limit?: number;
  reason?: string;
  /* What the turn that produced this step cost. On screen so the pace can be read while it runs, rather
   * than reconstructed from the account afterwards - the question it answers, "why does this feel slow",
   * is asked while watching, not later. */
  spent?: { shot: number; model: number };
}

export interface RunResult {
  ok: boolean;
  said?: string;
  error?: string;
  steps: RunStep[];
  /** Сошлись ли утверждения - ОТДЕЛЬНО от того, выполнилась ли процедура. См. checksOf в _expect.mjs. */
  checks?: { passed: number; failed: number; unchecked: number; tiers: Record<string, number> } | null;
  /** Цель назвала время впереди, и прогон отложен до него: страница ставит расписание, а не пишет прогон. */
  deferred?: { at: string; zone: string; then: string };
}

/** One decided action, and what it cost. `ms` is absent on any run recorded before it was measured. */
export interface RunStep {
  tool: string;
  input: Record<string, unknown>;
  ms?: { shot: number; model: number; act: number };
  /** Только у `expect`: вердикт с доказательством. `pass: null` - проверить не удалось (см. _expect.mjs). */
  outcome?: { pass: boolean | null; how: string; evidence: string };
}

/** What is already open, in one line each - the mistake a picture cannot prevent. */
export async function openWindows(machine: Machine, frame?: ShotFrame): Promise<string | null> {
  try {
    /* Кадр - чтобы прямоугольники приехали в пикселях картинки, а не экрана: см. openList. */
    return openList((await machine.windows()).windows, frame);
  } catch (_) {
    return null;                          // an agent from before /windows runs without the list
  }
}

/* --------------------------------------------------------------------------------- waiting */

const decodeGrid = (b64: string) => {
  const raw = atob(b64);
  const grid = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) grid[i] = raw.charCodeAt(i);
  return grid;
};

/* Both predicates now live in the brain, beside the words composed from them - see the long note there for
 * why there are two and what was measured. This file had its own copy of the one threshold, which is exactly
 * how the browser driver and the agent would have drifted apart on the fix. */

/* The same 64x36 grey reduction the agent does in /pulse, for an agent that cannot do it yet. */
async function fingerprintPng(png: string): Promise<Uint8Array | null> {
  try {
    const blob = await (await fetch(`data:image/png;base64,${png}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(64, 36);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, 64, 36);
    bitmap.close();
    const { data } = ctx.getImageData(0, 0, 64, 36);
    const grey = new Uint8Array(64 * 36);
    for (let i = 0; i < grey.length; i++) {
      const at = i * 4;
      grey[i] = ((data[at] ?? 0) * 77 + (data[at + 1] ?? 0) * 150 + (data[at + 2] ?? 0) * 29) >> 8;
    }
    return grey;
  } catch (_) {
    return null;
  }
}

async function settle(machine: Machine, limitMs: number, aborted: () => boolean, onTick: (ms: number) => void) {
  const started = Date.now();
  let last: Uint8Array | null = null;
  let quietSince: number | null = null;

  while (Date.now() - started < limitMs) {
    if (aborted()) break;
    await new Promise((done) => setTimeout(done, SETTLE_POLL_MS));

    let now: Uint8Array | null = null;
    try {
      now = decodeGrid((await machine.pulse()).grid);
    } catch (_) {
      /* An agent too old to fingerprint for us - /pulse arrived in 0.4.0 - so fall back to a small picture
       * and do the same reduction here. Slower and heavier, but a wait that works is worth more than a wait
       * that returns instantly and leaves the model to guess. */
      try {
        const frame = await machine.shot(640);
        now = await fingerprintPng(frame.png);
      } catch (_) {
        break;                            // the agent went away; the next turn's shot reports it properly
      }
    }

    if (last && gridQuiet(last, now)) {
      if (quietSince === null) quietSince = Date.now();
      const frames = Math.round((Date.now() - quietSince) / SETTLE_POLL_MS) + 1;
      if (frames >= SETTLE_QUIET_FRAMES) {
        return { quiet: true, waited: Date.now() - started, quietFor: Date.now() - quietSince };
      }
    } else {
      quietSince = null;
    }
    last = now;
    onTick(Date.now() - started);
  }

  return { quiet: false, waited: Date.now() - started, quietFor: 0 };
}

/* --------------------------------------------------------------------------------- the model */

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface Answer {
  stop_reason?: string;
  content?: Block[];
}

async function ask(body: unknown, signal?: AbortSignal) {
  const res = await fetch('/api/claude', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify(body),
  });
  return { res, text: await res.text() };
}

/* ----------------------------------------------------------------------------------- the run */

/** Зона этого браузера - он и есть та машина, которую ведёт прогон. Отказ Intl - UTC, и часы так и скажут. */
const hereZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
};

interface Options {
  goal: string;
  /** Что автор назвал признаком готовности. Отсутствует - цикл о нём просто не заговаривает. */
  success?: string | null;
  /** Какой компьютер вести. Раньше здесь стоял номер порта - см. Machine в agent.ts. */
  machine: Machine;
  /* ЧТО ЭТА МАШИНА УМЕЕТ - плоские флаги из её /health, ровно как их отдал агент.
   *
   * Отдельно от Machine нарочно. Machine - это ЧЕТЫРЕ ДЕЙСТВИЯ, которые цикл делает с компьютером, и
   * весь смысл того интерфейса в том, что цикл не различает локальный агент и агент на другом конце
   * запроса. Возможности - не действие, а факт, и знает его тот, кто уже опросил /health: страница
   * держит его в состоянии и обновляет опросом. Цикл его только ЧИТАЕТ и только для того, чтобы решить,
   * какие инструменты предложить модели.
   *
   * Не передали - модель не получит инструментов, зависящих от флага, и прогон пойдёт как до 0.28.0. */
  caps?: { canClickName?: boolean } | null;
  onEvent: (event: RunEvent) => void;
  isAborted: () => boolean;
  /** Чекпоинты, которые модель обещала пройти. Передаются - значит цикл о них знает и объявляет их; не
   * передаются - инструмента нет и всё работает как раньше. */
  checkpoints?: { title: string; detail: string }[];
  /** Шлюз. Резолвится, когда человек решил: продолжать или остановиться. Пока промис не разрешён, цикл стоит -
   * и это единственное место, где он стоит по чужому решению. */
  onCheckpoint?: (at: { n: number; title: string; said: string }) => Promise<GateAnswer>;
  /** Что этот аккаунт делал прямо перед этим - фон, а не задание. Формулируется в мозге (earlierRuns),
   * потому что облачный драйвер отдаёт модели то же самое теми же словами. Отсутствует - и цикл о нём
   * просто не заговаривает, что и происходит у первого прогона. */
  earlier?: unknown[] | null;
  /**
   * КАДР, КОТОРЫЙ СТОИТ ОСТАВИТЬ: ход что-то доказал, или на нём всё кончилось.
   *
   * Обратным вызовом, а не записью отсюда, по той же причине, по которой этот файл не знает про /api/sync:
   * цикл ведёт машину, а не аккаунт. Кто его дал - тот и решает, куда кадр девать (страница Create кладёт
   * его в /api/artifacts). Не дали - кадры просто не хранятся, и всё остальное работает как раньше.
   */
  onArtifact?: (kept: {
    kind: string; stepNo: number; said: string; frame: ShotFrame & { png: string; format?: string; w: number; h: number };
  }) => void;
}

export async function runOnDesktop({
  goal, success, machine, caps, onEvent, isAborted, checkpoints, onCheckpoint, earlier, onArtifact,
}: Options): Promise<RunResult> {
  /* Шлюз работает только когда есть и план, и кто-то, кто ответит. Одно без другого - это либо инструмент,
   * объявляющий чекпоинты, которых нет, либо пауза, из которой никто не выпустит. */
  /* Resolved here rather than at each ask: a model change mid-run would hand the task between two models
   * that never saw each other's reasoning. The next run picks up the new answer. */
  runModel = await desktopModel();
  const gate = checkpoints && checkpoints.length && onCheckpoint ? onCheckpoint : undefined;
  const plan = gate ? checkpoints : undefined;
  const steps: RunResult['steps'] = [];
  let handoff: string | null = null;
  let stepNo = 0;

  for (let wave = 1; wave <= MAX_WAVES; wave++) {
    /* План уезжает в цикл - этим вариант 3 и отличается от варианта 1, где он существовал только в
     * интерфейсе. Модель обязана объявлять каждый чекпоинт по достижении, и на объявлении цикл останавливается
     * до ответа человека. */
    const planText = plan
      ? '\n\nYou told the user you would pass through these checkpoints:\n'
        + plan.map((c, i) => `${i + 1}. ${c.title} — ${c.detail}`).join('\n')
        + '\n\nCall reached_checkpoint the moment one of them is true, before doing anything that belongs to '
        + 'the next one. The user is watching and will answer before you continue. If you find you must '
        + 'depart from the plan, do the right thing and say so in the next reached_checkpoint or in finish - '
        + 'the plan was your intention, not an instruction you are bound to.'
      : '';

    /* The same background the cloud driver reads from the account, from what the app is already holding -
     * see earlierRuns in the brain. Absent is fine and common: a first run has nothing before it. */
    const messages: unknown[] = [
      openingMessage(goal, planText, handoff, success ?? null, earlierRuns(earlier ?? null)),
    ];
    if (wave > 1) onEvent({ type: 'wave', n: wave, of: MAX_WAVES });

    const outcome = await runWave({
      messages, success, gate, plan, machine, caps, onEvent, isAborted, steps, wave, stepFrom: stepNo,
      onArtifact,
    });
    stepNo = outcome.stepNo;
    if (outcome.result) return outcome.result;
    if (isAborted()) return { ok: false, error: 'stopped', steps };

    const handed = await askForHandoff(messages);
    if (!handed.note) {
      return {
        ok: false,
        error: `It got as far as step ${stepNo}, then ${handed.error}. It stopped there rather than ` +
          'starting the next stretch with no idea what had been done.',
        steps,
      };
    }
    handoff = handed.note;
    onEvent({ type: 'handoff', text: handoff });
  }

  return { ok: false, error: outOfWaves(), steps };
}

async function runWave(o: {
  /** Что автор назвал признаком готовности. Дописывается в описание `finish`, потому что читают его
   *  в момент решения остановиться, а не в начале прогона. */
  success?: string | null;
  messages: unknown[];
  gate?: Options['onCheckpoint'];
  plan?: Options['checkpoints'];
  machine: Machine;
  caps?: Options['caps'];
  onEvent: (event: RunEvent) => void;
  isAborted: () => boolean;
  steps: RunResult['steps'];
  onArtifact?: Options['onArtifact'];
  wave: number;
  stepFrom: number;
}): Promise<{ stepNo: number; result?: RunResult }> {
  const { messages, machine, onEvent, isAborted, steps, wave } = o;
  let stepNo = o.stepFrom;
  let shotWidth = DEFAULT_SHOT_W;

  /* Сколько действий подряд не сдвинули экран. Живёт через ходы: три неподвижных в одном ходе и три в
   * следующем - это шесть подряд, и человек, глядя на это, считал бы именно так. */
  let still = 0;
  /* Что прочиталось у окна на застрявшем ходу, до следующей картинки. См. shouldPeek в мозге: правило одно
   * на два драйвера, и момент, в который оно срабатывает, тоже обязан быть одним. */
  let saw: string | null = null;

  for (let turn = 0; turn < WAVE_TURNS; turn++) {
    if (isAborted()) return { stepNo };

    /* WHERE THE TIME GOES, measured rather than reasoned about.
     *
     * "It sends a screenshot every four seconds" was the report, and the four seconds turned out to be
     * neither a screenshot nor an interval: the agent answers /shot in tens of milliseconds and there is no
     * timer in this loop at all. But that was arrived at by subtracting one measurement from another, which
     * is an argument, not a number. So each step now carries its own split. */
    const shotAt = Date.now();
    let frame;
    try {
      frame = await machine.shot(shotWidth === DEFAULT_SHOT_W ? undefined : shotWidth);
    } catch (err) {
      const offline = err instanceof AgentError && err.offline;
      return {
        stepNo,
        result: {
          ok: false,
          error: offline
            ? `Lost the local agent at step ${stepNo + 1} — ${(err as Error).message}. The PowerShell window ` +
              'may have been closed, or the computer may have slept. Start it again from Connections.'
            : `Could not see the screen at step ${stepNo + 1}: ${(err as Error).message}`,
          steps,
        },
      };
    }
    if (!frame.png) {
      return {
        stepNo,
        result: {
          ok: false,
          error: `Could not take a picture of the screen at step ${stepNo + 1}` +
            (frame.error ? ` — the agent said: ${frame.error}` : '') +
            '. If the computer is locked or a remote session has been disconnected there is no desktop ' +
            'to look at.',
          steps,
        },
      };
    }

    forgetOldPictures(messages as { content?: unknown }[]);
    messages.push(screenMessage(frame, await openWindows(machine, frame), saw, clockSaid(Date.now(), hereZone())));
    saw = null;

    stepNo++;
    onEvent({ type: 'turn', n: stepNo, wave, inWave: turn + 1, of: WAVE_TURNS });

    /* Снято ЗДЕСЬ, до того как ход что-либо сделает и до того как `still` обновится: на облачном пути это
     * решает предыдущий ход, отдавая действия, и решать это в двух драйверах в разные моменты значит иметь
     * два разных правила под одним именем. */
    const peekNow = shouldPeek(still);
    /* Что этот ход доказал. Кадр к нему ОДИН - экран за ход один, - и вид его решает kindOf: провалом ход
     * считается, если хоть одно утверждение не сошлось. */
    const proven: { at: number; verdict: { pass: boolean | null; how: string; evidence: string } }[] = [];

    const cutoff = new AbortController();
    const shotMs = Date.now() - shotAt;

    /* NOTHING HAS MOVED FOR SIX ACTIONS, so the next decision is not bought.
     *
     * Warned three times already in the results, each warning costing a step of several seconds. A model
     * that has not changed approach after those will not on the seventh - the run watched live spent a
     * minute proving it, ten identical attempts ended by a person who was watching. This is that person's
     * judgement, made by the loop instead. */
    if (still >= STILL_GIVE_UP) {
      const why = stillStopped(still);
      onEvent({ type: 'text', text: why });
      /* Кадр провала - тот самый экран, по которому потом и разбирают, на чём всё встало. Берётся кадр
       * ЭТОГО хода: он снят выше, до решения, и это ровно тот экран, который цикл видел последним. */
      if (frame) o.onArtifact?.({ kind: 'failure', stepNo, said: why, frame });
      return { stepNo, result: { ok: false, error: why, steps } };
    }

    const timer = setTimeout(() => cutoff.abort(), MODEL_TIMEOUT_MS);
    const modelAt = Date.now();
    let res: Response;
    let text: string;
    try {
      ({ res, text } = await ask({
        model: runModel,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        tools: toolsFor(!!o.gate, o.success ?? null, o.caps ?? null),
        messages,
      }, cutoff.signal));
    } catch (err) {
      clearTimeout(timer);
      const timedOut = (err as { name?: string } | null)?.name === 'AbortError';
      return {
        stepNo,
        result: {
          ok: false,
          error: timedOut
            ? `The model did not answer within ${MODEL_TIMEOUT_MS / 1000}s at step ${stepNo}.`
            : 'Could not reach the MouseFlow server.',
          steps,
        },
      };
    }
    clearTimeout(timer);
    const modelMs = Date.now() - modelAt;

    if (res.status === 413 && shotWidth > 320) {
      shotWidth = Math.max(320, Math.round(shotWidth / 2));
      onEvent({
        type: 'text',
        text: `That step was too large to send; taking a smaller picture (${shotWidth}px) and trying again.`,
      });
      turn--;                             // the same decision, retried - it never got made
      stepNo--;
      continue;
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? ''; } catch (_) {}
      return { stepNo, result: { ok: false, error: explainStatus(res.status, stepNo, detail), steps } };
    }

    let answer: Answer;
    try { answer = JSON.parse(text) as Answer; } catch (_) {
      return { stepNo, result: { ok: false, error: 'The model sent something unreadable.', steps } };
    }

    if (answer.stop_reason === 'refusal') {
      return {
        stepNo,
        result: { ok: false, error: refusedAt(stepNo), steps },
      };
    }
    if (answer.stop_reason === 'max_tokens') {
      return {
        stepNo,
        result: { ok: false, error: truncatedAt(stepNo), steps },
      };
    }

    const blocks = answer.content ?? [];
    messages.push({ role: 'assistant', content: blocks });

    const said = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    if (said) onEvent({ type: 'text', text: said });

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
      return { stepNo, result: { ok: false, error: why, steps } };
    }

    const results: unknown[] = [];
    /* ОДИН СЧЁТ НА ХОД, а не на действие - см. STILL_WARN в api/_brain.mjs. Здесь результаты кладутся по
     * ходу дела, а итог хода известен только в конце, поэтому неподвижные ответы запоминаются и слова в
     * них дописываются после цикла: назвать счёт первому из них раньше значило бы назвать его наугад. */
    const inertSaid: { content: string }[] = [];
    let judged = false;
    let stirred = false;
    /* The machine actions this turn has already taken, in order - what sameTurn reads. See the note on it
     * in api/_brain.mjs: a turn carries one aimed action and then the typing that follows from it. */
    const ran: string[] = [];
    /* Отрезано, а не отфильтровано. Ход [клик, клик, печатать] - это не «выполнить первый и третий»:
     * печатать модель собиралась в то, что откроет ВТОРОЙ клик. Первый отказ закрывает ход целиком, и
     * каждому отказанному вызову всё равно отвечают - API требует результат на каждый tool_use. */
    let cut = false;
    for (const use of uses) {
      /* Per action, not per turn: a turn can pair a long wait with the click that follows it, and Stop
       * during the wait used to let that click land on a live desktop afterwards. */
      if (isAborted()) {
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'the user stopped the run' });
        break;
      }

      /* Шлюз. Объявление стоит шага - оно и есть turn - поэтому попадает и в steps, и в фид, как всякое
       * другое действие. Разница одна: цикл после него СТОИТ, пока человек не ответит. */
      if (use.name === 'reached_checkpoint') {
        /* Заявление о достигнутом чекпоинте после обрезанного хода опирается на действия, которых не было. */
        if (cut) {
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: AFTER_CUT });
          continue;
        }
        const n = Math.max(1, Math.min(o.plan?.length ?? 99, Number(use.input?.n) || 1));
        const title = o.plan?.[n - 1]?.title ?? `checkpoint ${n}`;
        const claimed = String(use.input?.said ?? '').trim() || 'no words with it';

        onEvent({ type: 'tool', name: use.name, input: use.input });
        steps.push({ tool: 'reached_checkpoint', input: (use.input ?? {}) as Record<string, unknown> });

        /* Здесь цикл стоит. Единственное место, где он ждёт чужого решения - и `isAborted` продолжает
         * работать, потому что Stop разрешает промис как 'stop'. */
        const answer = o.gate ? await o.gate({ n, title, said: claimed }) : 'go';

        if (answer === 'stop' || isAborted()) {
          return {
            stepNo,
            result: {
              ok: false,
              said: claimed,
              /* Не «ошибка»: остановка на шлюзе - это решение, а прогон дошёл до названного места. Писать
               * «stopped» одним словом значило бы выбросить единственное, что здесь стоит знать. */
              error: `Stopped at checkpoint ${n} — ${title}. It said: ${claimed}`,
              steps,
            },
          };
        }

        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: 'The user looked and said to carry on. Continue from where you are, and announce the next '
            + 'checkpoint when it is true.',
        });
        /* И ход на этом закрыт. Между объявлением и ответом человека проходит сколько угодно времени - за
         * него экран мог стать любым, - так что действие, стоявшее в том же ходе за чекпоинтом, целилось бы
         * в картинку, которой человек уже не видит. */
        cut = true;
        continue;
      }

      /* ОТЛОЖИТЬ - окончание, не действие; длинная версия «почему» в api/_step.mjs, который делает ровно то
       * же. Момент считает deferInstant: время, которое уже наступило, - отказ с часами, а не расписание на
       * секунду вперёд. */
      if (use.name === 'defer_until') {
        if (cut) {
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: AFTER_CUT });
          continue;
        }
        const zone = hereZone();
        const when = deferInstant({ at: use.input?.at, zone });
        if (when.atMs == null) {
          const why = when.why ?? 'that is not a time I can read';
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: why });
          /* В фид, а не только модели: «в 19:54», исполненное в 19:53, читалось как прогон, который время
           * проигнорировал, - а он его СПРОСИЛ и получил ответ. Ответ должен видеть и человек. */
          onEvent({ type: 'text', text: why });
          cut = true;
          continue;
        }
        const at = new Date(when.atMs).toISOString();
        const then = String(use.input?.then ?? '').trim();
        onEvent({ type: 'tool', name: 'defer_until', input: { at, then } });
        steps.push({ tool: 'defer_until', input: { at, then } });
        return {
          stepNo,
          result: { ok: true, said: `set aside until ${at}`, steps, deferred: { at, zone, then } },
        };
      }

      if (use.name === 'finish') {
        /* Успех, обоснованный действиями, которых не было. Обрезанный ход не заканчивают зелёным - модель
         * посмотрит на свежий снимок и решит заново. Ложный красный виден и оспорим, ложный зелёный - нет. */
        if (cut) {
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: AFTER_CUT });
          continue;
        }
        const closing = String(use.input?.said ?? said ?? 'Done.');
        // Success has to be claimed: anything but an explicit true is a failure that said so in words.
        const claimed = use.input?.ok === true;
        /* КАДР НА ОКОНЧАНИИ. Неудача - всегда: по этому экрану её и разбирают. Успех - только если прогон
         * что-то УТВЕРЖДАЛ: зелёный отчёт без картинки нечем подкрепить, а обычное выполненное поручение в
         * картинке не нуждается. Кадр берётся тот, на котором решался этот ход. */
        if (!claimed) o.onArtifact?.({ kind: 'failure', stepNo, said: closing, frame });
        else if (checksOf(steps)) o.onArtifact?.({ kind: 'final', stepNo, said: closing, frame });
        return {
          stepNo,
          result: {
            ok: claimed, said: closing, error: claimed ? undefined : closing, steps,
            /* Отдельно от `ok`: процедура могла выполниться, а утверждение не сойтись - это провал ПРОДУКТА,
             * а не прогона, и читается он двумя числами, а не одним цветом. */
            checks: checksOf(steps),
          },
        };
      }

      /* A NOTE IS NOT AN ACTION - the long version of why is in api/_step.mjs, which does exactly this.
       * Both drivers or neither: a note that reached the record on one path and not the other would be a
       * difference nobody could explain from the outside. */
      if (use.name === 'note') {
        if (cut) {
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: AFTER_CUT });
          continue;
        }
        const written = String(use.input?.text ?? '').trim();
        if (!written) {
          results.push({
            type: 'tool_result', tool_use_id: use.id, is_error: true,
            content: 'nothing to record - note takes the text to write down',
          });
          continue;
        }
        onEvent({ type: 'tool', name: 'note', input: { text: written } });
        steps.push({ tool: 'note', input: { text: written } });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Recorded. It is in the record of this run for the user to read; nothing waits on it.' });
        continue;
      }

      /* THE BATCH RULE, applied before anything is counted, shown or sent. A refused action did not happen,
       * so it is not a step and not an event - only an answer the model reads on its next turn. */
      if (cut || !sameTurn(ran, use.name ?? '')) {
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: cut ? AFTER_CUT : notBatched(ran, use.name ?? ''),
        });
        cut = true;
        continue;
      }

      onEvent({ type: 'tool', name: use.name, input: use.input, spent: { shot: shotMs, model: modelMs } });
      const actAt = Date.now();
      const trace: RunStep = {
        tool: use.name ?? '?',
        input: (use.input ?? {}) as Record<string, unknown>,
        /* The picture and the decision belong to the TURN, not to this action - a turn that returned three
         * of them paid for one of each. Written onto every step anyway, because the alternative is a shape
         * where some steps have timings and some do not, and whoever reads them later has to know why. */
        ms: { shot: shotMs, model: modelMs, act: 0 },
      };
      steps.push(trace);

      if (use.name === 'wait') {
        const limit = Math.min(SETTLE_MAX_MS, Math.max(200, Number(use.input?.ms) || 2000));
        const outcome = await settle(machine, limit, isAborted, (waited) =>
          onEvent({ type: 'waiting', ms: waited, limit, reason: String(use.input?.reason ?? '') }));
        results.push({ type: 'tool_result', tool_use_id: use.id, content: waitReport(outcome) });
        ran.push('wait');
        continue;
      }

      /* THE SCREEN BEFORE THE ACTION, so the result can say whether anything happened.
       *
       * A run watched live spent a minute renaming a spreadsheet: it clicked the title, double-clicked it,
       * selected all, typed, opened File → Rename and typed again - ten actions at six to nine seconds
       * each, none of which landed, because the caret was never in the field. Nothing told it. `do` has no
       * return value to check and never has; the only way it could tell was by reading the next screenshot,
       * which it did, and misread, and tried again.
       *
       * /pulse is 64×36 grey samples and answers in about 30ms. Against a decision that costs seconds that
       * is free, and it is the one signal that was missing. */
      let settled = false;
      let before: Uint8Array | null = null;
      try { before = decodeGrid((await machine.pulse()).grid); } catch (_) { before = null; }

      const body = actionBody(use.name ?? '', (use.input ?? {}) as Record<string, unknown>, frame);
      if (!body) {
        results.push({
          type: 'tool_result', tool_use_id: use.id, is_error: true,
          content: `no such action here: ${use.name}`,
        });
        /* And nothing behind it either: whatever the model meant to follow this did not happen. */
        cut = true;
        continue;
      }
      ran.push(use.name ?? '');

      let output: string | undefined;
      try {
        /* The agent's own answer, when the action had one. Read here and composed through actionSaid below,
         * so this driver and the cloud one say the same thing about the same reply. */
        output = (await machine.do(body)).output;
        /* The pause first: a screen compared the instant after a click has not had time to react, and
         * would report every action as having changed nothing. This is the same 350ms the loop already
         * waits before its next picture, moved above the comparison rather than added to it. */
        await new Promise((done) => setTimeout(done, 350));
        settled = true;

        let after: Uint8Array | null = null;
        try { after = decodeGrid((await machine.pulse()).grid); } catch (_) { after = null; }

        /* STATED, NOT JUDGED. Some actions correctly change nothing on screen - a copy to the clipboard,
         * a click on something already selected - so this reports what was observed and leaves the reading
         * to the model. Saying "that failed" would be this loop guessing about applications it cannot see
         * inside, which is how a working step gets abandoned. */
        /* STIRRED, not "not quiet": after an action the question is whether anything happened, and a wrong
         * "nothing did" is what ends runs. A renamed title moves four cells out of 2304 and the mean barely
         * twitches. */
        const inert = !!(before && after && !gridStirred(before, after));
        /* «Не смог снять отпечаток» - это не «не сдвинулось», и ход, про который ничего не известно, счёт
         * не трогает вовсе.
         *
         * И ВЗГЛЯД НЕ СУДИТ О НЕПОДВИЖНОСТИ: агент отвечает `moved` про каждое действие, включая чтение
         * окна, а проверка ничего двигать и не собиралась. QA-прогон - «сделай одно, проверь пять» - иначе
         * упирался бы в STILL_GIVE_UP на статичном экране, то есть когда всё правильно. См. LOOKS_ONLY. */
        if (before && after && !LOOKS_ONLY.has(use.name ?? '')) {
          judged = true;
          if (!inert) stirred = true;
        }
        /* ПРОВЕРКА: вердикт выносится здесь, потому что на этом пути ответ машины уже в руках - в отличие от
         * облачного, где он приходит ходом позже. Разбор тот же самый, и `is_error` у FAIL остаётся ложным:
         * инструмент сработал, не сошлось утверждение. */
        if (use.name === 'expect') {
          const want = (use.input ?? {}) as { check: string; name: string; text?: string; why?: string };
          const verdict = judge(want, output, false);
          trace.outcome = verdict;
          proven.push({ at: stepNo, verdict });
          const said = expectSaid(want, verdict);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: said });
          /* Своим видом события, а не текстом: человек, читающий ленту, обязан видеть исход проверки
           * цветом - в отчёте по кейсу это единственное, что читают. */
          onEvent({ type: 'check', text: said, pass: verdict.pass });
          continue;
        }
        const report = {
          type: 'tool_result',
          tool_use_id: use.id,
          /* The words live in the brain, like waitReport's: the two drivers must tell the model the same
           * thing, or one of them teaches it a habit the other punishes. */
          content: actionSaid(output, inert ? false : true, still),
        };
        results.push(report);
        /* Only when the answer is the stirred/inert sentence. An action that reported a fact - a capture's
         * path, the clipboard's contents - must not have that fact overwritten at the end of the turn by
         * "nothing changed on screen", which is the bug this condition exists to prevent. */
        if (inert && (output == null || output === 'done')) inertSaid.push(report);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'failed';
        onEvent({ type: 'error', message: `${use.name} failed: ${message}` });
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: message });
        /* И остаток хода - тоже нет. Печатать после клика, которого не было, значит печатать не туда; на
         * этом пути это видно СРАЗУ, потому что действия выполняются здесь по одному. На облачном не видно
         * - там пачка уже уехала агенту целиком, - и разницу закрывает правило: после activate_window,
         * единственного прицельного действия, которое падает честно, в пачке ничего не идёт. */
        cut = true;
      }

      trace.ms!.act = Date.now() - actAt;

      /* A moment for the screen to react before the next picture, or it shows the state before this. Skipped
       * when the comparison above already waited it out - one pause, not two. */
      if (!settled) await new Promise((done) => setTimeout(done, 350));
    }

    /* ОДИН КАДР НА ХОД, названный тем, что этот ход доказал. Пишется и при PASS: зелёная строка, к которой
     * можно вернуться и посмотреть, - это то, что делает зелёный отчёт проверяемым, а не просто зелёным. */
    if (proven.length) {
      o.onArtifact?.({
        kind: kindOf(proven.map((one) => one.verdict)),
        stepNo: proven[0].at,
        said: saidOf(proven.map((one) => one.verdict)),
        frame,
      });
    }

    /* ИТОГ ХОДА, и только теперь. Ход неподвижен, только если ни одно его действие ничего не сдвинуло;
     * сдвинуло хоть одно - счёт с нуля. Слова в неподвижных ответах дописываются здесь, потому что до
     * конца цикла назвать в них было нечего. */
    if (judged) {
      still = stirred ? 0 : still + 1;
      if (!stirred) for (const r of inertSaid) r.content = actionReport(false, still);
    }

    /* И ВЗГЛЯД, КОТОРОГО НИКТО НЕ ПРОСИЛ - после действий хода, как на облачном пути, и решённый тем же
     * числом: `peekNow` снят ДО того, как `still` обновился, потому что там это решает предыдущий ход,
     * возвращая действия. Два драйвера, одно правило и один момент - иначе один научит модель привычке,
     * которую второй не поддержит. Ошибка проглатывается: агент старее 0.16.0 ответит отказом, и показать
     * его модели значило бы научить её, что смотреть бесполезно. */
    if (peekNow && results.length) {
      try {
        const looked = (await machine.do(peekBody(frame))).output;
        saw = looked ? String(looked) : null;
      } catch (_) { saw = null; }
    }

    messages.push({ role: 'user', content: results });
  }

  return { stepNo };                      // out of turns: the caller asks for a handover
}

/* The seam between waves. No tools may be USED, but they must still be DECLARED - the API rejects a
 * history containing tool_use blocks with no tools defined, and by now it always contains them. */
async function askForHandoff(messages: unknown[]): Promise<{ note?: string; error?: string }> {
  messages.push({ role: 'user', content: HANDOFF_ASK });

  const cutoff = new AbortController();
  const timer = setTimeout(() => cutoff.abort(), MODEL_TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    ({ res, text } = await ask({
      model: runModel,
      max_tokens: 700,
      system: HANDOFF_SYSTEM,
      tools: TOOLS,
      tool_choice: { type: 'none' },
      messages,
    }, cutoff.signal));
  } catch (err) {
    clearTimeout(timer);
    return {
      error: (err as { name?: string } | null)?.name === 'AbortError'
        ? 'the handover request timed out'
        : 'the handover could not reach the server',
    };
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = '';
    try { detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? ''; } catch (_) {}
    return { error: `the handover failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}` };
  }

  let answer: Answer;
  try { answer = JSON.parse(text) as Answer; } catch (_) {
    return { error: 'the handover answer was unreadable' };
  }
  const note = (answer.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  return note ? { note } : { error: 'the handover came back empty' };
}
