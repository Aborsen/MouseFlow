/* Запрос, который уходит наверх на каждом ходу цикла: пределы и кеширование префикса.
 *
 * ЭТОТ ФАЙЛ ПОЯВИЛСЯ ПОЗЖЕ САМОГО МОДУЛЯ, и это стоит сказать: до пункта 6 плана api/_vision.mjs не был
 * закреплён ничем - ни исполняемым тестом, ни пином. А в нём стоят единственные границы того, СКОЛЬКО МОЖЕТ
 * СТОИТЬ ОДИН ЗАПРОС на общем ключе: список моделей, потолок токенов, потолок байтов. Заголовок файла прямо
 * говорит, что пределы - это половина его смысла, и половина смысла держалась ни на чём.
 *
 * ГЛАВНОЕ, ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ:
 *
 *   ОТМЕТКА КЕША СТОИТ НА ПОСЛЕДНЕМ ИНСТРУМЕНТЕ, и последний инструмент - это `finish`. На этом порядке
 *   держится весь рычаг: отметка кеширует всё ДО СЕБЯ, то есть system+tools одним куском. Уедь `finish` из
 *   конца - и кешироваться начнёт часть схемы, а остальное поедет заново каждый ход. Молча: время просто
 *   вернётся к прежнему, и объяснить это будет нечем.
 *
 *   ОБЩИЙ МАССИВ TOOLS НЕ МУТИРУЕТСЯ. Он экспортирован из api/_brain.mjs и читается ещё и тестами; дописать
 *   в него cache_control на месте значило бы дописать его всюду, где его читают.
 *
 *   ПОЛЯ, КОТОРЫХ НЕ ПРОСИЛИ, НЕ ПЕРЕСЫЛАЮТСЯ. Тело собирается заново по полям именно за этим.
 *
 * Run: node api/_test-vision.mjs
 */
import { ALLOWED_MODELS, MAX_BODY_BYTES, MAX_MESSAGES, MAX_TOKENS_CAP, payloadFor } from './_vision.mjs';
import { actionBody, TOOLS, toolsFor } from './_brain.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

const EPH = JSON.stringify({ type: 'ephemeral' });

group('ПРЕФИКС КЕШИРУЕТСЯ - то, что не менялось, не отправляется заново');
{
  const out = payloadFor({
    model: 'claude-opus-5', max_tokens: 8000, system: 'You are operating a computer.',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'click' }, { name: 'expect' }, { name: 'finish' }],
  });
  check('system стал массивом блоков - на строку отметку не поставить',
    Array.isArray(out.system) && out.system.length === 1 && out.system[0].type === 'text',
    JSON.stringify(out.system));
  check('и текст в нём тот же, слово в слово',
    out.system[0].text === 'You are operating a computer.');
  check('и он помечен для кеша',
    JSON.stringify(out.system[0].cache_control) === EPH, JSON.stringify(out.system[0]));

  check('отметка стоит на ПОСЛЕДНЕМ инструменте - она кеширует всё до себя',
    JSON.stringify(out.tools[2].cache_control) === EPH, JSON.stringify(out.tools[2]));
  check('и только на нём - вторая отметка внутри схемы разрезала бы её пополам',
    !out.tools[0].cache_control && !out.tools[1].cache_control);
  check('а сам инструмент не тронут ничем, кроме отметки',
    out.tools[2].name === 'finish' && Object.keys(out.tools[2]).length === 2,
    JSON.stringify(Object.keys(out.tools[2])));
}

group('НА ЧЁМ ЭТО ДЕРЖИТСЯ: `finish` - последний инструмент, во всех режимах');
{
  /* Отметка ставится на ПОЗИЦИЮ. Пока finish последний, кешируется вся схема; уедь он из конца - и
   * кешируется её часть, а остальное едет заново каждый ход, и заметить это будет нечем. */
  const last = (list) => (list.length ? list[list.length - 1].name : '(empty)');
  check('в самом TOOLS он последний', last(TOOLS) === 'finish', last(TOOLS));
  check('и со шлюзом', last(toolsFor(true)) === 'finish', last(toolsFor(true)));
  check('и без шлюза - вырезается reached_checkpoint, он стоит раньше',
    last(toolsFor(false)) === 'finish', last(toolsFor(false)));
  check('и когда finish переписан под «как выглядит готово»',
    last(toolsFor(false, 'the row is in the table')) === 'finish');
  /* И он там ОДИН: два finish означали бы, что отметка легла не на тот. */
  check('и он там один', TOOLS.filter((t) => t.name === 'finish').length === 1);
}

group('НАЖАТИЕ ПО ИМЕНИ ПРЕДЛАГАЕТСЯ ТОЛЬКО ТАМ, ГДЕ АГЕНТ ЕГО УМЕЕТ (пункт 6, рычаг 2)');
{
  /* ПОЧЕМУ ЭТО ЗАКРЕПЛЕНО ИСПОЛНЕНИЕМ, А НЕ ТЕКСТОМ. Весь смысл рычага - снять ход, и инструмент,
   * которого агент не умеет, ход ДОБАВЛЯЕТ: модель его зовёт, агент отвечает "unknown action", пять
   * секунд ушли. То есть ошибка в этом фильтре не ломает прогон, а тихо разворачивает пункт в минус, и
   * увидеть это можно только по счёту ходов через месяц. Значит проверять надо здесь.
   *
   * И отсутствие флага - НЕ false. Старый агент про свои возможности не говорит ничего, и «слишком старый,
   * чтобы сказать» читается как «не предлагать»: это то же правило, что у canName и canAnchor. */
  const names = (list) => list.map((t) => t.name);
  const has = (list) => names(list).includes('click_named');

  check('в самом TOOLS инструмент есть - он один на всех, фильтруется на выдаче',
    names(TOOLS).includes('click_named'));
  check('без возможностей вовсе - не предлагается', !has(toolsFor(false)));
  check('с флагом - предлагается', has(toolsFor(false, null, { canClickName: true })));
  check('с флагом false - не предлагается: это агент, который сказал «не умею»',
    !has(toolsFor(false, null, { canClickName: false })));
  check('с другими флагами, но без этого - не предлагается: отсутствие не «да»',
    !has(toolsFor(false, null, { canName: true, canSee: true })));
  check('и со шлюзом правило то же - фильтр один, не два',
    has(toolsFor(true, null, { canClickName: true })) && !has(toolsFor(true)));

  /* И ТО, НА ЧЁМ ДЕРЖИТСЯ КЕШ: фильтр вырезает из СЕРЕДИНЫ, поэтому finish обязан остаться последним в
   * каждом из четырёх сочетаний. Иначе отметка cache_control ляжет не на конец схемы, и кешироваться
   * будет её часть - молча, без всякого признака. */
  const last = (list) => (list.length ? list[list.length - 1].name : '(empty)');
  for (const [said, list] of [
    ['без флага', toolsFor(false)],
    ['с флагом', toolsFor(false, null, { canClickName: true })],
    ['со шлюзом и флагом', toolsFor(true, null, { canClickName: true })],
    ['с флагом и переписанным finish', toolsFor(false, 'the row is there', { canClickName: true })],
  ]) {
    check(`finish остаётся последним: ${said}`, last(list) === 'finish', last(list));
  }

  /* ЦЕЛЬ - ИМЯ, И НА ПРОВОДЕ ЭТО ВИДНО. `title=` забирает остаток строки, поэтому всё остальное стоит
   * до него; написанное после - часть имени, и нажатие уедет по имени "Save button=left". */
  const frame = { scale: 2, originX: 0, originY: 0 };
  const line = actionBody('click_named', { name: 'Save as', process: 'excel' }, frame);
  check('действие называется clickname', line.startsWith('action=clickname '), line);
  check('и имя стоит последним, потому что забирает остаток строки',
    line.endsWith(' title=Save as'), line);
  check('и геометрия едет - агент отвечает, КУДА нажал, в пикселях снимка',
    line.includes('scale=2 ox=0 oy=0'), line);
  check('и окно сужается процессом, а не заголовком', line.includes(' process=excel'), line);
  check('модификаторы - до имени, иначе они часть имени',
    actionBody('click_named', { name: 'Send', modifiers: ['Shift'] }, frame)
      === 'action=clickname scale=2 ox=0 oy=0 button=left double=0 mods=Shift title=Send',
    actionBody('click_named', { name: 'Send', modifiers: ['Shift'] }, frame));
  check('без имени действия нет вовсе - пустое имя нажало бы неизвестно что',
    actionBody('click_named', { name: '   ' }, frame) === null);
}

group('ОБЩИЙ МАССИВ НЕ МУТИРУЕТСЯ - иначе отметка расползётся по всему, что его читает');
{
  const shared = [{ name: 'click' }, { name: 'finish' }];
  const before = JSON.stringify(shared);
  payloadFor({ model: 'claude-opus-5', system: 's', messages: [], tools: shared });
  check('входной массив тот же, что был', JSON.stringify(shared) === before, JSON.stringify(shared));
  check('и это относится к самому TOOLS - его читают тесты и оба драйвера',
    !TOOLS.some((tool) => tool && tool.cache_control));
}

group('ВЫЗОВ БЕЗ ИНСТРУМЕНТОВ - тоже кеширует свой system (askForHandoff зовёт именно так)');
{
  const out = payloadFor({ model: 'claude-opus-5', max_tokens: 700, system: 'Summarise.', messages: [] });
  check('system помечен', JSON.stringify(out.system[0].cache_control) === EPH);
  check('а инструментов нет вовсе - не пустой массив, а отсутствие',
    !('tools' in out), JSON.stringify(Object.keys(out)));
}

group('ОТСУТСТВИЕ ОСТАЁТСЯ ОТСУТСТВИЕМ');
{
  check('нет system - нет поля', !('system' in payloadFor({ model: 'x', messages: [] })));
  check('пустая строка - тоже нет поля: пустой блок кешировать нечего',
    !('system' in payloadFor({ model: 'x', system: '', messages: [] })));
  /* Массив на входе пропускается как есть: вызывающий, который уже собрал блоки, знает про них больше. */
  const blocks = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
  check('готовые блоки не переписываются',
    JSON.stringify(payloadFor({ model: 'x', system: blocks, messages: [] }).system)
      === JSON.stringify(blocks));
  check('пустой массив инструментов остаётся пустым, а не получает отметку в никуда',
    JSON.stringify(payloadFor({ model: 'x', messages: [], tools: [] }).tools) === '[]');
}

group('ПРЕДЕЛЫ ОДНОГО ЗАПРОСА - половина смысла файла, и до сегодня они не были закреплены');
{
  check('потолок токенов обрезает просьбу, а не доверяет ей',
    payloadFor({ model: 'x', max_tokens: 999999, messages: [] }).max_tokens === MAX_TOKENS_CAP);
  check('и подставляет своё, когда не попросили',
    payloadFor({ model: 'x', messages: [] }).max_tokens === 4096);
  check('и мусор не проходит в потолок',
    payloadFor({ model: 'x', max_tokens: 'много', messages: [] }).max_tokens === 4096);
  /* ПОЛЯ, КОТОРЫХ НЕ ПРОСИЛИ, НЕ ПЕРЕСЫЛАЮТСЯ - за этим тело и собирается заново по полям. */
  const out = payloadFor({
    model: 'x', messages: [], temperature: 2, metadata: { user_id: 'someone' }, stream: true,
  });
  check('чужие поля не уезжают наверх',
    !('temperature' in out) && !('metadata' in out) && !('stream' in out),
    JSON.stringify(Object.keys(out)));
  /* И сами числа - чтобы правка «на глазок» не прошла молча: это деньги на общем ключе. */
  check('модели - только те три, что нужны циклам',
    ALLOWED_MODELS.size === 3 && ALLOWED_MODELS.has('claude-opus-5')
      && ALLOWED_MODELS.has('claude-sonnet-5') && ALLOWED_MODELS.has('claude-haiku-4-5-20251001'),
    [...ALLOWED_MODELS].join(','));
  check('и три предела на месте',
    MAX_TOKENS_CAP === 16000 && MAX_MESSAGES === 120 && MAX_BODY_BYTES === 4_000_000,
    `${MAX_TOKENS_CAP}/${MAX_MESSAGES}/${MAX_BODY_BYTES}`);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
