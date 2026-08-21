/* Что модель СОБИРАЕТСЯ сделать — до того, как она начнёт делать это на настоящей машине.
 *
 * ЧТО ЭТО НЕ ТАКОЕ, и это важнее всего остального в файле. Цикл в desktop-engine.ts реактивный: он смотрит
 * на скриншот, выбирает одно действие, делает его и смотрит снова. Плана у него нет и он его не получает -
 * этот вызов происходит ДО цикла, отдельно, и цикл о нём никогда не узнаёт.
 *
 * Поэтому то, что здесь возвращается, - заявление о намерении, а не сценарий. Прогон может пойти иначе, и
 * интерфейс обязан говорить это теми же словами: чекпоинты с номерами, притворяющиеся программой, - худший
 * вид полировки, потому что выглядят как гарантия и ею не являются.
 *
 * Зачем тогда вообще. Он ловит самый дорогой класс ошибок - непонимание. Вы читаете «открыть Chrome и войти»
 * и понимаете, что вас поняли не так, ДО того как что-то нажато на вашей машине. Ровно это и стоит одного
 * лишнего вызова модели.
 *
 * СТРУКТУРА через инструмент, а не через «ответь JSON». Прокси уже пробрасывает `tools` и `tool_choice`
 * (api/claude.js), а модель, которой велено вызвать инструмент, отдаёт валидный объект по схеме - в отличие
 * от модели, которую попросили «вернуть JSON» и которая обернёт его в три абзаца вежливости.
 */
import { planModel } from './model-config';

const MODEL = 'claude-opus-5'; // the fallback; the configured choice comes from model-config
const TIMEOUT_MS = 45_000;

/** Немного. План - это то, что читают за пять секунд перед нажатием, а не документ. */
const CHECKPOINTS_MAX = 6;

export interface Checkpoint {
  title: string;
  detail: string;
}

export interface Plan {
  /** Короткое имя того, что будет сделано. Не цель дословно: цель - предложение, это - заголовок. */
  title: string;
  checkpoints: Checkpoint[];
}

const OUTLINE_TOOL = {
  name: 'outline',
  description: 'Say what you intend to do, before doing any of it.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Four to eight words naming the task, as a person would refer to it later.',
      },
      checkpoints: {
        type: 'array',
        description: `Three to ${CHECKPOINTS_MAX} checkpoints, in order.`,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Two to five words. What this stage achieves.' },
            detail: { type: 'string', description: 'One sentence on how, and what you will check.' },
          },
          required: ['title', 'detail'],
        },
      },
    },
    required: ['title', 'checkpoints'],
  },
};

const SYSTEM = `You are about to operate a real computer for someone, and you are showing them your intention first so they can correct you before anything happens.

Write the checkpoints you expect to pass through. Rules:
- Three to ${CHECKPOINTS_MAX}. Fewer than three is not a plan; more than six is a script, and you cannot know the screen that far ahead.
- Each one is a state you will have REACHED, not a keystroke. "The reply is drafted", not "click the reply button".
- Say what you will check before a one-way action - sending, submitting, deleting - because that is the checkpoint somebody wants to see.
- If the goal is ambiguous, do not resolve the ambiguity silently. Make the reading you intend explicit in a checkpoint, so it can be corrected.
- If the goal asks for something you must refuse - typing a password, an irreversible action it did not ask for - say so in a checkpoint instead of planning around it.
- You have not looked at the screen yet unless a picture is attached. Do not claim to know what is on it.`;

const clip = (value: unknown, max: number) =>
  String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Один вызов, до цикла. Возвращает план или причину, по которой его нет — и «нет плана» никогда не должно
 * молча превращаться в «запускаем без предупреждения»: решает вызывающий, а не этот файл.
 */
export async function askForPlan(
  goal: string,
  where: 'desktop' | 'browser',
  /** Скриншот, если он есть и человек попросил учитывать текущий экран. base64 без префикса. */
  screen?: { png: string; format: string } | null,
): Promise<{ plan?: Plan; error?: string }> {
  const cutoff = new AbortController();
  const timer = setTimeout(() => cutoff.abort(), TIMEOUT_MS);

  /* Картинка приезжает первой, потому что и в цикле она приезжает первой: модель, которой сначала дали
   * текст, отвечает на текст и смотрит на картинку как на подтверждение. */
  const content: unknown[] = [];
  if (screen) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: `image/${screen.format || 'jpeg'}`, data: screen.png },
    });
  }
  content.push({
    type: 'text',
    text: `${goal}\n\nThis will run ${
      where === 'desktop' ? 'on the whole desktop of this machine' : 'in one tab of this browser'
    }.${screen ? ' The picture above is what is on screen right now.' : ''}`,
  });

  let res: Response;
  let text: string;
  try {
    res = await fetch('/api/claude', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      signal: cutoff.signal,
      body: JSON.stringify({
        model: await planModel().catch(() => MODEL),
        max_tokens: 900,
        system: SYSTEM,
        tools: [OUTLINE_TOOL],
        /* Заставленный вызов. Без него модель иногда отвечает прозой, и разбирать прозу обратно в чекпоинты
         * значит угадывать - а угаданный план хуже отсутствующего. */
        tool_choice: { type: 'tool', name: 'outline' },
        messages: [{ role: 'user', content }],
      }),
    });
    text = await res.text();
  } catch (err) {
    clearTimeout(timer);
    return {
      error: (err as { name?: string } | null)?.name === 'AbortError'
        ? 'the plan took too long to come back'
        : 'the plan could not reach the server',
    };
  }
  clearTimeout(timer);

  if (!res.ok) {
    /* Своими словами прокси, если он их сказал: он знает, почему отказал (нет ключа, слишком большой
     * запрос), а эта страница - нет. */
    let said = '';
    try {
      said = clip(JSON.parse(text)?.error?.message, 200);
    } catch (_) {
      said = clip(text, 200);
    }
    return { error: said || `the model refused with HTTP ${res.status}` };
  }

  let body: { content?: unknown } | null = null;
  try {
    body = JSON.parse(text);
  } catch (_) {
    return { error: 'the model answered with something that is not JSON' };
  }

  const blocks = Array.isArray(body?.content) ? body.content : [];
  const call = blocks.find(
    (b): b is { type: string; name: string; input?: unknown } =>
      !!b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use',
  );
  const input = call?.input as { title?: unknown; checkpoints?: unknown } | undefined;
  if (!input) return { error: 'the model did not answer with a plan' };

  const checkpoints = (Array.isArray(input.checkpoints) ? input.checkpoints : [])
    .map((row) => ({
      title: clip((row as { title?: unknown })?.title, 60),
      detail: clip((row as { detail?: unknown })?.detail, 220),
    }))
    /* Пустой чекпоинт - это строка, которую человек прочтёт как «шаг, о котором ничего не сказали».
     * Выбрасывается, а не показывается заглушкой. */
    .filter((row) => row.title || row.detail)
    .slice(0, CHECKPOINTS_MAX);

  if (!checkpoints.length) return { error: 'the plan came back empty' };

  return { plan: { title: clip(input.title, 80) || clip(goal, 80), checkpoints } };
}
