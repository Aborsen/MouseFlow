/* ПОДЧЁРКИВАНИЕ В ИМЕНИ - НЕ СТИЛЬ, А ГРАНИЦА РАЗВЁРТЫВАНИЯ.
 *
 * Vercel собирает в функцию каждый файл в api/, КРОМЕ начинающихся с подчёркивания. Без него набор
 * тестов висел бы по публичному адресу - см. заголовок api/_test-step.mjs, где это уже случилось.
 */
/* Что именно уходит провайдеру, и чем один провайдер отличается от другого.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ. `maxTokens` у каждого вызывающего значит одно: сколько места у ОТВЕТА. api/chat.js
 * так и называет своё число - ANSWER_TOKENS. У Anthropic это правда, потому что бюджет на размышление
 * не посылается вовсе. У OpenAI Responses - нет: max_output_tokens ограничивает размышление И ответ
 * вместе, а размышления не видно и при effort 'high' его обычно больше, чем всего написанного потом.
 *
 * Ассистент на этом развёртывании (gpt-5.6, effort high, ANSWER_TOKENS = 2000) на обычном вопросе
 * потратил весь потолок на размышление и вернулся с `status: incomplete` и пустым текстом. Здесь это
 * читается как 'truncated', api/chat.js честно отказывается показывать это как ответ, и человек видел
 * «модель не уместилась, спросите поуже» - совет, который не мог помочь, потому что вопрос был ни при
 * чём. За все эти токены уже заплачено.
 *
 * Проверяется ИСПОЛНЕНИЕМ, а не чтением: тело запроса перехватывается подменённым fetch, потому что
 * единственное, что здесь имеет значение, - число, которое реально ушло в провайдера.
 *
 * Запуск: node api/_test-provider.mjs
 */
import { ask } from './_provider.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

/* Ключи нужны только чтобы дойти до сборки тела: настоящего запроса не будет - fetch подменён. */
process.env.ANTHROPIC_API_KEY = 'test-anthropic';
process.env.OPENAI_API_KEY = 'test-openai';

const OPENAI_DONE = { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } };
const ANTHROPIC_DONE = { stop_reason: 'end_turn', content: [], usage: { input_tokens: 1, output_tokens: 1 } };

/** Что ушло провайдеру на один вызов. */
async function sent(opts, reply) {
  let body = null;
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
  };
  try {
    await ask(opts);
  } finally {
    globalThis.fetch = real;
  }
  return body;
}

const OPENAI = 'gpt-5.1';
const ANTHROPIC = 'claude-sonnet-5';
const one = [{ role: 'user', text: 'hello' }];

// ---------------------------------------------------------------- потолок у рассуждающей модели
group('у рассуждающей модели потолок покрывает и размышление, и ответ');
{
  const high = await sent({ model: OPENAI, messages: one, maxTokens: 2000, effort: 'high' }, OPENAI_DONE);
  const medium = await sent({ model: OPENAI, messages: one, maxTokens: 2000, effort: 'medium' }, OPENAI_DONE);
  const low = await sent({ model: OPENAI, messages: one, maxTokens: 2000, effort: 'low' }, OPENAI_DONE);

  check('effort уходит как просили', high.reasoning && high.reasoning.effort === 'high',
    JSON.stringify(high.reasoning));
  /* Та самая цифра из отчёта: 2000 на всё - это потолок на РАЗМЫШЛЕНИЕ, а не на ответ. */
  check('2000 на ответ больше не значит 2000 на всё', high.max_output_tokens > 2000,
    String(high.max_output_tokens));
  check('и место на размышление отмерено настоящее, а не символическое',
    high.max_output_tokens - 2000 >= 25_000, String(high.max_output_tokens));
  /* Больше размышления - больше запаса. Одна константа на все три была бы либо тесной для high, либо
   * бессмысленно щедрой для low. */
  check('чем больше effort, тем больше запас',
    high.max_output_tokens > medium.max_output_tokens
    && medium.max_output_tokens > low.max_output_tokens,
    `${low.max_output_tokens} / ${medium.max_output_tokens} / ${high.max_output_tokens}`);
  /* Запас - это запас, а не замена: место под ответ остаётся тем, о котором просили. */
  check('и о запрошенном месте под ответ не забыли',
    high.max_output_tokens - 25_000 === 2000, String(high.max_output_tokens));
}

// ---------------------------------------------------------------- Anthropic не трогали
group('у Anthropic потолок остаётся потолком ответа');
{
  const cl = await sent({ model: ANTHROPIC, messages: one, maxTokens: 2000 }, ANTHROPIC_DONE);
  /* Бюджета на размышление сюда не посылают - значит max_tokens и есть длина ответа, и прибавлять к
   * нему нечего. Прибавка здесь была бы тихим удорожанием каждого вызова. */
  check('max_tokens - ровно то, что просил вызывающий', cl.max_tokens === 2000, String(cl.max_tokens));
  check('и никакого reasoning ему не посылают', cl.reasoning === undefined);
}

// ---------------------------------------------------------------- модель, которая не рассуждает
group('модели без размышления запас не выдаётся');
{
  /* effort вне списка означает «не посылать поле» - см. ask(). Тогда и прибавлять нечего: потолок
   * снова описывает только ответ. */
  const flat = await sent({ model: OPENAI, messages: one, maxTokens: 2000, effort: 'none' }, OPENAI_DONE);
  check('поле reasoning не уходит', flat.reasoning === undefined);
  check('и потолок равен запрошенному', flat.max_output_tokens === 2000, String(flat.max_output_tokens));
}

// ---------------------------------------------------------------- обрыв всё ещё называется обрывом
group('обрыв по потолку по-прежнему не выдаётся за ответ');
{
  /* Запас делает обрыв редким, а не невозможным. Если он всё же случился - это не ответ, и путь,
   * который об этом говорит, должен остаться. */
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  let out;
  try {
    out = await ask({ model: OPENAI, messages: one, maxTokens: 2000 });
  } finally {
    globalThis.fetch = real;
  }
  check('status:incomplete читается как truncated', out.stopReason === 'truncated', out.stopReason);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
