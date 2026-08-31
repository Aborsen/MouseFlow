/* Документ процесса: чем он написан, на что ссылается и чего о себе не скрывает.
 *
 * ЖИВОЙ ВЫЗОВ МОДЕЛИ ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ, и это сказано вслух: OPENAI_API_KEY стоит на развёртывании, а
 * не в этом окружении. Проверяется всё остальное - что модель и усилие пришпилены и не попали в меню
 * ассистента, что правила промпта на месте, что разбор ссылок выдерживает опечатки, и что при отказе не
 * сохраняется НИЧЕГО. Последнее важнее всех прочих: половина документа в базе хуже отсутствующего.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DOC_EFFORT, DOC_MODEL, DOC_SYSTEM, DOC_TOKENS, DOC_TRANSCRIPT_BUDGET, citedSteps, docPrompt, newDocId, titleOf } from './_docs.mjs';
import { MODELS, WRITER_MODELS, ask, providerFor } from './_provider.js';
import { recordingTools } from './_recording-tools.js';
import { toolsFor } from './chat.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8').replace(/\r\n/g, '\n');
const tools = read('_recording-tools.js');
const docs = read('_docs.mjs');

let pass = 0;
let fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log('  ok   ' + what); return; }
  fail++;
  console.log('  FAIL ' + what + (detail ? '  -> ' + String(detail).slice(0, 300) : ''));
};
const group = (name) => console.log('\n' + name);

const NEON = Symbol('q');
const fakeNeon = ({ rows = () => [] } = {}) => {
  const seen = [];
  const sql = (strings, ...values) => {
    const text = String(strings.raw ? strings.raw.join('?') : strings);
    seen.push({ text, values });
    return { [NEON]: true, text, then: (r) => Promise.resolve(rows(text, values)).then(r) };
  };
  sql.transaction = async (arr) => arr.map((q) => rows(q.text, []));
  sql.seen = seen;
  return sql;
};
const IDS = ['00000000-0000-0000-0000-000000000001'];

group('модель документов пришпилена и НЕ попала в меню ассистента');
{
  /* Просили дословно: документы на gpt-5.6-terra с усилием medium, ассистент остаётся на Anthropic. */
  check('модель и усилие - те, о которых просили',
    DOC_MODEL === 'gpt-5.6-terra' && DOC_EFFORT === 'medium', DOC_MODEL + ' / ' + DOC_EFFORT);
  /* И читаются НЕ из окружения: документ должен быть воспроизводим из своей строки, а OPENAI_MODEL правят
   * на развёртывании, ничего об этом файле не зная. */
  check('и не читаются из окружения',
    !/process\.env\.OPENAI_MODEL/.test(docs) && !/process\.env\.OPENAI_REASONING/.test(docs));
  /* САМОЕ ТОНКОЕ: MODELS - это меню. api/models.js публикует его, api/chat.js по нему проверяет выбор -
   * значит имя, добавленное туда, становится моделью, которую можно выбрать АССИСТЕНТУ. Просьба была
   * «OpenAI только для документов». */
  check('в меню ассистента её нет',
    !MODELS.openai.includes(DOC_MODEL), MODELS.openai.join(', '));
  /* Но ask() отказывает неизвестной модели, поэтому узнаваемой она быть обязана - в другом списке. */
  check('но позвать её можно - providerFor её знает',
    providerFor(DOC_MODEL) === 'openai' && WRITER_MODELS.openai.includes(DOC_MODEL));
  check('и потолок ответа объявлен', DOC_TOKENS >= 2000);
}

group('сообщение уходит в той форме, которую читают мапперы');
{
  /* ЖИВОЙ ОТЧЁТ. `{ role, content }` вместо `{ role, text }`: api/_provider.js читает `m.text`, поэтому
   * сообщение молча выпадало, запрос уходил с пустым input, и OpenAI отвечал «One of input or
   * previous_response_id or prompt or conversation must be provided» - точное сообщение совершенно не про
   * ту ошибку. 7277 токенов и один непонятный отчёт.
   *
   * Форма нигде не объявлена типом: api/chat.js её строит, мапперы читают. Значит проверять её - здесь. */
  check('writeDoc посылает { role, text }, а не { role, content }',
    /messages: \[\{ role: 'user', text: docPrompt\(/.test(docs)
      && !/role: 'user', content: docPrompt/.test(docs), 'message shape');

  /* И ask() больше не даёт этой ошибке доехать до платного круга - проверяется ИСПОЛНЕНИЕМ, а не поиском
   * по тексту: именно текстовые проверки и пропустили исходную ошибку, потому что в исходнике было
   * написано ровно то, что задумано, а неверен был тип значения. */
  const refusal = async (messages) => {
    try {
      await ask({ model: DOC_MODEL, messages, maxTokens: 500 });
      return 'no refusal';
    } catch (err) {
      return String(err && err.message);
    }
  };
  for (const [what, messages] of [
    ['{ role, content } - та самая ошибка', [{ role: 'user', content: 'hello' }]],
    ['пустой массив', []],
    ['messages не передали вовсе', undefined],
  ]) {
    check('ask() отказывает локально: ' + what,
      /nothing to send: a message here is \{ role, text \}/.test(await refusal(messages)),
      await refusal(messages));
  }
  /* И ДО проверки ключа: неверная форма - ошибка кода, а не состояние развёртывания, и на машине без ключа
   * защита, стоящая после него, недостижима вовсе - вызывающий услышал бы «нет ключа». */
  check('и это происходит до проверки ключа',
    !/has no OpenAI key/.test(await refusal([{ role: 'user', content: 'x' }])));
  /* А верная форма проходит дальше - иначе защита просто запрещала бы работу. */
  check('а { role, text } проходит дальше',
    !/nothing to send/.test(await refusal([{ role: 'user', text: 'hello' }])));
}

group('промпт запрещает то, чем такая проза ломается');
{
  /* Каждое правило здесь стоит из-за конкретного отказа, и все три - те же, что у остального продукта:
   * придуманное число, шаг, которого не было, процедура, которую нельзя проверить. */
  check('ссылка на шаг обязательна у каждой строки',
    /\[step 41\]/.test(DOC_SYSTEM) && /cannot be traced back cannot be checked/.test(DOC_SYSTEM));
  check('и придумывать запрещено прямо',
    /Write nothing you did not read/.test(DOC_SYSTEM)
      && /Do not supply a reason/.test(DOC_SYSTEM));
  /* НАПЕЧАТАННОГО НЕТ, и документ обязан сказать это сам - не потому что отфильтровано, а потому что не
   * записывается. Документ, из которого это неясно, читается как полная инструкция. */
  check('напечатанный текст назван невосстановимым, и это в документе, а не в примечании',
    /TYPED TEXT IS NOT RECORDED/.test(DOC_SYSTEM)
      && /Never invent the content/.test(DOC_SYSTEM)
      && /stated\n.*limitation|as a stated/.test(DOC_SYSTEM));
  /* Выброшенные диапазоны шагов - тоже: процедура, которая выглядит полной и не полна, хуже короткой. */
  check('и выброшенные диапазоны шагов должны быть названы',
    /omitted to fit/.test(DOC_SYSTEM) && /naming the ranges/.test(DOC_SYSTEM));
  check('и раздел «чего этот документ не говорит» обязателен всегда',
    /cannot tell you/.test(DOC_SYSTEM) && /Always present, never empty/.test(DOC_SYSTEM));
}

group('модели показывается результат чужого инструмента, а не своя упаковка');
{
  /* get_transcript уже решает, что влезает, прореживает стретчи и СООБЩАЕТ, что выбросил. Вторая упаковка
   * здесь дала бы второе мнение о том, какие шаги существуют, - а ссылки [step N] стоят именно на том,
   * что мнение одно. */
  const fake = { found: true, steps: 3, segments: [{ n: 1, steps: [{ n: 4 }] }], omitted: [[9, 40]] };
  const prompt = docPrompt({ transcript: fake, name: 'Weekly invoice', focus: 'the approval part' });
  check('расшифровка уезжает целиком, как есть',
    prompt.includes(JSON.stringify(fake)), prompt.slice(0, 120));
  check('и имя записи, и просьба, если её передали',
    /Weekly invoice/.test(prompt) && /the approval part/.test(prompt));
  check('а без просьбы лишней строки нет',
    !/wants the document focused/.test(docPrompt({ transcript: fake, name: 'x' })));
  check('и в файле нет второй упаковки шагов',
    !/slice\(0, \d+\)[\s\S]{0,80}segments/.test(docs));
}

group('доказательства переживают проzу, а не наоборот');
{
  /* ИЗМЕРЕНО, и это был живой отчёт: документ ответил «individual execution steps are not available in the
   * supplied transcript». Причина - порядок жертв при упаковке: лестница прореживала ТОЛЬКО шаги, а рассказ
   * (2823 байта), границы и примечания занимали место безусловно. На записи из 73 шагов до модели доезжало
   * НОЛЬ шагов и 4 стретча из 12. */
  const rt = read('_recording-tools.js');
  check('проза жертвуется ДО прореживания шагов',
    /let prose = true;[\s\S]{0,400}?if \(bytes\(data\) > budget\) \{[\s\S]{0,40}?prose = false;/.test(rt),
    'order');
  check('и рассказ с границами записи под этим признаком',
    /story: prose \?/.test(rt) && /gaps: prose \?/.test(rt));
  /* А `limits` - НЕ под ним. Там написано, что клавиатура никогда не читается: это условие правильного
   * чтения всего остального, и документ, потерявший эту строку, опишет ввод текста как записанный. */
  check('а вот limits не жертвуются никогда',
    /limits: limitsFor\(row\.source\),/.test(rt) && !/limits: prose \?/.test(rt));
  /* И убранная проза НАЗВАНА: её отсутствие иначе читается как «рассказывать было нечего». */
  check('и об убранной прозе сказано в ответе',
    /proseDropped: prose \? undefined/.test(rt));

  /* Потолок - параметр, и у документа он свой: один вызов вместо шести кругов разговора. */
  check('у документа свой потолок расшифровки, и он больше чатовского',
    DOC_TRANSCRIPT_BUDGET > 100_000, String(DOC_TRANSCRIPT_BUDGET));
  check('и инструмент его действительно передаёт',
    /reader\.run\(\{ flowId, budget: DOC_TRANSCRIPT_BUDGET \}/.test(rt));
  /* Модели этот параметр не предлагается: он не в схеме, его передаёт код, который знает свою цену. */
  const schema = rt.slice(rt.indexOf("name: 'get_transcript'"), rt.indexOf("name: 'remove_steps'"));
  check('но в схеме get_transcript его нет - это не выбор модели',
    !/budget: \{ type:/.test(schema));
}

group('имя и ссылки разбираются, включая опечатки');
{
  const body = '# Send the weekly invoice\n\n## Steps\n1. Open it [step 4].\n2. Fill [steps 7-9].\n3. Send [step 12].';
  check('имя берётся из первого заголовка, а не спрашивается отдельно',
    titleOf(body) === 'Send the weekly invoice', titleOf(body));
  /* Два поля под одно имя - это два имени, и править человек будет то, которое видит. */
  check('и его нет в схеме инструмента как отдельного входа',
    !/title: \{ type: 'string'/.test(tools.slice(tools.indexOf("name: 'write_process_doc'"),
      tools.indexOf("name: 'search_recordings'"))));
  check('диапазон раскрывается', JSON.stringify(citedSteps(body)) === '[4,7,8,9,12]', JSON.stringify(citedSteps(body)));
  /* Перевёрнутый диапазон - опечатка, а не диапазон: берутся два конца, которые он называет. Иначе цикл
   * либо не выполнится вовсе, либо - при другой записи - будет бесконечным. */
  check('перевёрнутый диапазон не глотается и не зацикливается',
    JSON.stringify(citedSteps('[steps 9-4]')) === '[4,9]', JSON.stringify(citedSteps('[steps 9-4]')));
  /* Огромный диапазон не раскрывается: [steps 1-999999] иначе построил бы миллион элементов из опечатки. */
  check('огромный диапазон не раскрывается',
    citedSteps('[steps 1-999999]').length === 2);
  /* И «step 3» в обычной фразе ссылкой не считается: шаблон нарочно требует скобок. */
  check('без скобок это не ссылка', citedSteps('as described in step 3 above').length === 0);
  check('идентификатор документа узнаваем', newDocId('abc').startsWith('doc_'));
}

group('при отказе не сохраняется НИЧЕГО');
{
  const body = tools.slice(tools.indexOf("name: 'write_process_doc'"), tools.indexOf("name: 'search_recordings'"));
  /* Половина документа в базе хуже отсутствующего: вставка стоит ПОСЛЕ успешной записи, а перехват
   * возвращается до неё. */
  check('вставка идёт после writeDoc, а не до',
    body.indexOf('await writeDoc(') < body.indexOf('insert into user_doc'), 'order');
  /* И до вставки не доходит: перехват БРОСАЕТ. Проверяется требование - «после отказа ничего не пишется» -
   * а не то, каким оператором оно выполнено; пин на `return` запрещал бы это самое исправление. */
  check('перехват прекращает работу, не доходя до вставки',
    /catch \(err\) \{[\s\S]{0,900}?throw new Error\([\s\S]{0,400}?nothing was saved/.test(body));
  /* БРОСОК, А НЕ МЯГКИЙ ОТКАЗ, и это по живому отчёту: возвращённый отказ уходил в used[] как ok:true, а
   * причина - точное сообщение провайдера - жила только в пересказе модели, который превратил её в «the
   * document service returned an error». Бросок кладёт причину туда, где её видно. */
  check('и отказ не выдаётся за успешный результат инструмента',
    !/written: false/.test(body));
  /* Причина словами: отсутствующий ключ, отказ модели и обрыв на середине - три разных положения. */
  check('и причина отказа передаётся, а не заменяется общей фразой',
    /err\.message \? String\(err\.message\)/.test(body));
  check('и модели прямо сказано процитировать её человеку',
    /Quote that reason to the person/.test(body));
  /* Первая ревизия пишется сразу: иначе у документа, поправленного один раз, не осталось бы версии с тем,
   * что написала модель, - то есть её текст нельзя было бы отличить от чужого. */
  check('первая ревизия сохраняется сразу и помечена моделью',
    /insert into user_doc_version[\s\S]{0,200}?'model'/.test(body));
  check('и документ не пересказывается в ответе целиком',
    /Do not paste the whole document/.test(body));
}

group('инструмент отказывает понятно и не достаёт чужого');
{
  const table = recordingTools({ sql: fakeNeon(), userId: IDS[0] });
  const tool = table.find((t) => t.name === 'write_process_doc');
  check('инструмент есть', !!tool);
  const no = await tool.run({}, {});
  check('без flowId сказано, где его взять', /list_recordings/.test(String(no.data.error)));
  /* Личная область только: он читает одну запись по идентификатору и пишет от имени аккаунта. */
  const asTeam = toolsFor({ sql: fakeNeon(), userId: IDS[0], team: { id: 't1', name: 'Ops' } });
  check('в командной области его нет', !asTeam.write_process_doc, Object.keys(asTeam).join(', '));
  check('а в личной есть', !!toolsFor({ sql: fakeNeon(), userId: IDS[0], team: null }).write_process_doc);
  /* Идентификатор аккаунта приходит фабрикой и не читается из входа - правило, на котором стоит весь файл. */
  check('идентификатор аккаунта не берётся из входа',
    !/input\.(userId|user_id|account)/.test(tools));
  check('и запись пишется от него',
    /\$\{userId\}::uuid/.test(tools));
}

group('и он читает расшифровку тем же инструментом, что ассистент');
{
  const body = tools.slice(tools.indexOf("name: 'write_process_doc'"), tools.indexOf("name: 'search_recordings'"));
  check('расшифровка берётся у get_transcript, а не читается заново',
    /byName\.get\('get_transcript'\)/.test(body));
  check('и его отсутствие сказано, а не обойдено',
    /the transcript tool is not registered/.test(body));
  /* Карта заполняется ПОСЛЕ массива, потому что инструмент, зовущий соседа, объявлен в этом же массиве. */
  check('карта инструментов заполняется после сборки списка',
    /byName = new Map\(list\.map\(/.test(tools)
      && tools.indexOf('let byName') < tools.indexOf('byName = new Map('));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
