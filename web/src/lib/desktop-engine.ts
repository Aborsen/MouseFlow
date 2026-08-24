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
  screenMessage,
  toolsFor,
  truncatedAt,
} from '../../../api/_brain.mjs';
import type { ShotFrame } from '../../../api/_brain.d.mts';

/* Re-exported so nothing else has to know the brain moved: the Create page counts waves, the plan preview
 * and LiveContext normalise a picture's format, and both are imported from here everywhere. */
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
  type: 'turn' | 'tool' | 'text' | 'error' | 'wave' | 'handoff' | 'waiting';
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
}

export interface RunResult {
  ok: boolean;
  said?: string;
  error?: string;
  steps: { tool: string; input: Record<string, unknown> }[];
}

/** What is already open, in one line each - the mistake a picture cannot prevent. */
export async function openWindows(machine: Machine): Promise<string | null> {
  try {
    return openList((await machine.windows()).windows);
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

const moved = (a: Uint8Array | null, b: Uint8Array | null) => {
  if (!a || !b || a.length !== b.length) return true;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  // Mean difference per sample out of 255: three is above dither and below anything visible.
  return sum / a.length > 3;
};

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

    if (last && !moved(last, now)) {
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

interface Options {
  goal: string;
  /** Какой компьютер вести. Раньше здесь стоял номер порта - см. Machine в agent.ts. */
  machine: Machine;
  onEvent: (event: RunEvent) => void;
  isAborted: () => boolean;
  /** Чекпоинты, которые модель обещала пройти. Передаются - значит цикл о них знает и объявляет их; не
   * передаются - инструмента нет и всё работает как раньше. */
  checkpoints?: { title: string; detail: string }[];
  /** Шлюз. Резолвится, когда человек решил: продолжать или остановиться. Пока промис не разрешён, цикл стоит -
   * и это единственное место, где он стоит по чужому решению. */
  onCheckpoint?: (at: { n: number; title: string; said: string }) => Promise<GateAnswer>;
}

export async function runOnDesktop({
  goal, machine, onEvent, isAborted, checkpoints, onCheckpoint,
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

    const messages: unknown[] = [openingMessage(goal, planText, handoff)];
    if (wave > 1) onEvent({ type: 'wave', n: wave, of: MAX_WAVES });

    const outcome = await runWave({
      messages, gate, plan, machine, onEvent, isAborted, steps, wave, stepFrom: stepNo,
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
  messages: unknown[];
  gate?: Options['onCheckpoint'];
  plan?: Options['checkpoints'];
  machine: Machine;
  onEvent: (event: RunEvent) => void;
  isAborted: () => boolean;
  steps: RunResult['steps'];
  wave: number;
  stepFrom: number;
}): Promise<{ stepNo: number; result?: RunResult }> {
  const { messages, machine, onEvent, isAborted, steps, wave } = o;
  let stepNo = o.stepFrom;
  let shotWidth = DEFAULT_SHOT_W;

  for (let turn = 0; turn < WAVE_TURNS; turn++) {
    if (isAborted()) return { stepNo };

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
    messages.push(screenMessage(frame, await openWindows(machine)));

    stepNo++;
    onEvent({ type: 'turn', n: stepNo, wave, inWave: turn + 1, of: WAVE_TURNS });

    const cutoff = new AbortController();
    const timer = setTimeout(() => cutoff.abort(), MODEL_TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      ({ res, text } = await ask({
        model: runModel,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        tools: toolsFor(!!o.gate),
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

    const uses = blocks.filter((b) => b.type === 'tool_use');
    if (!uses.length) {
      return { stepNo, result: { ok: true, said: said || 'It had nothing further to do.', steps } };
    }

    const results: unknown[] = [];
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
        continue;
      }

      if (use.name === 'finish') {
        const closing = String(use.input?.said ?? said ?? 'Done.');
        // Success has to be claimed: anything but an explicit true is a failure that said so in words.
        const claimed = use.input?.ok === true;
        return {
          stepNo,
          result: { ok: claimed, said: closing, error: claimed ? undefined : closing, steps },
        };
      }

      onEvent({ type: 'tool', name: use.name, input: use.input });
      steps.push({ tool: use.name ?? '?', input: (use.input ?? {}) as Record<string, unknown> });

      if (use.name === 'wait') {
        const limit = Math.min(SETTLE_MAX_MS, Math.max(200, Number(use.input?.ms) || 2000));
        const outcome = await settle(machine, limit, isAborted, (waited) =>
          onEvent({ type: 'waiting', ms: waited, limit, reason: String(use.input?.reason ?? '') }));
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: outcome.quiet
            ? `The screen has been still for ${Math.round(outcome.quietFor / 1000)}s after ` +
              `${Math.round(outcome.waited / 1000)}s of waiting.`
            : `Still changing after ${Math.round(outcome.waited / 1000)}s. Wait again with a longer limit ` +
              'if it needs longer.',
        });
        continue;
      }

      const body = actionBody(use.name ?? '', (use.input ?? {}) as Record<string, unknown>, frame);
      if (!body) {
        results.push({
          type: 'tool_result', tool_use_id: use.id, is_error: true,
          content: `no such action here: ${use.name}`,
        });
        continue;
      }

      try {
        await machine.do(body);
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'done' });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'failed';
        onEvent({ type: 'error', message: `${use.name} failed: ${message}` });
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: message });
      }

      // A moment for the screen to react before the next picture, or it shows the state before this.
      await new Promise((done) => setTimeout(done, 350));
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
