/* ПОДЧЁРКИВАНИЕ В ИМЕНИ - НЕ СТИЛЬ, А ГРАНИЦА РАЗВЁРТЫВАНИЯ: Vercel собирает в функцию каждый файл в
 * api/, КРОМЕ начинающихся с подчёркивания. Без него набор тестов висел бы по публичному адресу. См.
 * заметку в api/_test-step.mjs, где это выяснилось прогоном против живого развёртывания.
 *
 * `mouseflow.skill/2` - формат обмена, исполняемый против настоящих модулей.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ ЖИВЁТ В api/, А ПРОВЕРЯЕТ РАСШИРЕНИЕ. Потому что он единственное место, откуда видно
 * ОБЕ половины продукта. Формат обмена написан дважды - в extension/skills.js и в api/_gallery-skill.mjs,
 * в двух рантаймах, и импортировать один в другой нечем. Здесь же Node, и он может загрузить оба и
 * сверить их на одних данных. То же и с проверками: `verification` перевозит расширение, а СУДИТ
 * `readExpects` в api/_case.mjs, и «перевезённое проходит суд» - утверждение про две стороны, которое
 * можно проверить только отсюда.
 *
 * Запуск: node api/_test-skills.mjs
 */
import { checksFor, readExpects } from './_case.mjs';
import { SKILL_FORMAT, SKILL_FORMATS_READ } from './_gallery-skill.mjs';
import { structureOf } from './_skill-schema.mjs';
import {
  SKILL_FORMAT as EXT_FORMAT,
  SKILL_FORMATS_READ as EXT_READ,
  exportSkill,
  importSkills,
  skillFromRecording,
} from '../extension/skills.js';
import { hasProcedure, procedureFrom, stepsSaid, STEPS_MAX } from '../extension/procedure.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

/* Настоящая по форме запись из браузера: focus, движение, клики, печать в поля, прокрутка. */
const WEB_EVENTS = [
  { action: 'focus', url: 'https://mail.google.com/mail/u/0', opened: true },
  { action: 'path', points: [{ dt: 16 }, { dt: 16 }] },
  { action: 'click', selector: 'div.T-I.T-I-KE', tag: 'div', text: 'Compose', rx: 0.5, ry: 0.5 },
  { action: 'blank', selector: 'input[name=to]', tag: 'input', field: 'To recipients', keys: 14 },
  { action: 'blank', selector: 'input[name=subjectbox]', tag: 'input', field: 'Subject', keys: 9 },
  { action: 'scroll', scrollY: 200 },
  { action: 'scroll', scrollY: 420 },
  { action: 'scroll', scrollY: 640 },
  { action: 'click', selector: 'div.T-I-atl', tag: 'div', text: 'Send', rx: 0.5, ry: 0.5 },
];
const RECORDING = {
  id: 'rdimm21n3',
  name: 'Send the weekly invoice',
  events: WEB_EVENTS,
  origins: ['mail.google.com'],
  tabs: 1,
};

/* --------------------------------------------------------------------------- обе половины */

group('формат обмена написан дважды, в двух рантаймах, и обязан совпадать');
{
  /* Единственное, что не даёт половинам разъехаться: расширение собирается отдельно и импортировать из
   * api/ не может. Разъехавшись, они дают человеку скилл, который импортируется в браузере и не
   * публикуется - или наоборот, и ни одно из двух сообщений не объясняет, почему. */
  check('пишут они одно и то же', SKILL_FORMAT === EXT_FORMAT, `${SKILL_FORMAT} / ${EXT_FORMAT}`);
  check('и принимают один и тот же набор',
    JSON.stringify(SKILL_FORMATS_READ) === JSON.stringify(EXT_READ),
    `${SKILL_FORMATS_READ} / ${EXT_READ}`);
  check('пишут - последнее, и оно первое в списке чтения',
    SKILL_FORMATS_READ[0] === SKILL_FORMAT, SKILL_FORMATS_READ[0]);
  /* `/1` ЧИТАЕТСЯ НАВСЕГДА, и это свойство формата обмена, а не вежливость: файл уже уехал с чьей-то
   * машины, и отказаться его читать - значит сломать то, что человек считает своим. */
  check('а `/1` остался принимаемым', SKILL_FORMATS_READ.includes('mouseflow.skill/1'));
  check('и версия действительно сменилась на /2', SKILL_FORMAT === 'mouseflow.skill/2', SKILL_FORMAT);
}

/* --------------------------------------------------------------------------- уровень 1 */

group('скилл из записи несёт процедуру словами - уровень 1');
{
  const skill = skillFromRecording(RECORDING, '2026-09-11T10:00:00.000Z');
  const said = stepsSaid(skill.procedure);

  check('формат - тот, который мы пишем', skill.format === SKILL_FORMAT, skill.format);
  check('процедура есть', hasProcedure(skill.procedure));

  /* ДВИЖЕНИЕ - НЕ ШАГ. Процедуру читает человек, решающий, запускать ли это; «переместил указатель на
   * 340px» в документе о том, ЧЕМ была работа, - шум. */
  check('движение мыши в шаги не попало', !said.some((one) => /path|point/i.test(one)), said.join(' | '));

  /* ТРИ ПРОКРУТКИ - ОДИН ШАГ. Одиннадцать «Scroll» подряд - это тот самый журнал, который процедура и
   * заменяет; а «прокрутил до низа» - один человеческий шаг. */
  check('идущие подряд прокрутки схлопнулись в одну',
    said.filter((one) => one === 'Scroll').length === 1, said.join(' | '));

  /* ИМЯ ПАРАМЕТРА - ТО ЖЕ, ЧТО ПРЕДЛОЖИТ ФОРМА ЗАПУСКА. Рекордер содержимого полей не пишет, поэтому шаг
   * называет не значение, а параметр; назови он его иначе, документ обещал бы поле, которого в форме нет. */
  const names = skill.params.map((p) => p.name);
  const named = skill.procedure.steps.filter((s) => s.param).map((s) => s.param);
  check('печать названа параметром, а не значением',
    said.some((one) => one.includes('{{to_recipients}}')), said.join(' | '));
  check('и каждый названный параметр есть среди параметров навыка',
    named.length === 2 && named.every((one) => names.includes(one)),
    `${named} / ${names}`);

  /* ЧТО ЭТО ДЕЛАЕТ - в порядке, в котором делалось, и с исходом в конце. */
  check('шаги идут по порядку, начиная с единицы',
    skill.procedure.steps.every((s, i) => s.n === i + 1));
  check('последний шаг - исход, и он назван в whenToUse',
    /It ends by: click "Send"\./.test(skill.procedure.whenToUse || ''), skill.procedure.whenToUse);
  check('и сказано, где это применять',
    /^Use it in mail\.google\.com\./.test(skill.procedure.whenToUse || ''), skill.procedure.whenToUse);

  /* ШАГ ЗНАЕТ, ИЗ ЧЕГО ОН ВЫВЕДЕН - селектором, а не номером события: номера сдвигаются, когда запись
   * перерезают, а селектор указывает на то же самое. */
  check('шаг помнит, на что он указывает',
    skill.procedure.steps.find((s) => s.said.includes('Send')).selector === 'div.T-I-atl');

  /* ПУСТО И ПУСТО НАРОЧНО - см. заметки в extension/procedure.js. Проверка, которую никто не написал,
   * либо проходит, ничего не доказав, либо краснеет и тратит утро; а `why` у неё был бы не авторский. */
  check('проверки не выдуманы', Array.isArray(skill.procedure.verification)
    && skill.procedure.verification.length === 0);
  check('и подводные камни тоже - это полка для памяти о приложениях',
    Array.isArray(skill.procedure.pitfalls) && skill.procedure.pitfalls.length === 0);
}

group('процедура не растёт без предела и не выдумывает, чего не знает');
{
  const many = Array.from({ length: 200 }, (_, i) => (
    { action: 'click', selector: `#b${i}`, tag: 'button', text: `Button ${i}` }));
  const long = procedureFrom(many, {});
  check(`шагов не больше ${STEPS_MAX}`, long.steps.length === STEPS_MAX, String(long.steps.length));

  /* БЕЗ ПРОИСХОЖДЕНИЯ - НЕТ И ФРАЗЫ. `whenToUse: "Use it."` хуже отсутствующего поля: читатель тратит на
   * него внимание и только потом обнаруживает, что там ничего не сказано. Отсутствие - это ответ. */
  check('без origins whenToUse отсутствует, а не пуст', long.whenToUse === null, String(long.whenToUse));

  /* ДЛИННЫЙ ТЕКСТ - НЕ ПОДПИСЬ. Клик по абзацу возвращает абзац, и процедура, цитирующая чужое письмо,
   * - это утечка, а не документ. Тогда шаг называет ВИД элемента: «the button» читатель хотя бы найдёт. */
  const wordy = procedureFrom([{ action: 'click', tag: 'button', text: 'x'.repeat(400) }], {});
  check('длинный текст подписью не считается',
    wordy.steps[0].said === 'Click the button', wordy.steps[0].said);

  /* НЕЗНАКОМОЕ ДЕЙСТВИЕ - НАЗЫВАЕТСЯ, А НЕ ВЫБРАСЫВАЕТСЯ: процедура, потерявшая шаг, врёт о работе. */
  const odd = procedureFrom([{ action: 'paste', tag: 'input' }], {});
  check('незнакомое действие всё равно попадает в шаги',
    odd.steps.length === 1 && odd.steps[0].said === 'Paste', JSON.stringify(odd.steps));
}

/* --------------------------------------------------------------------------- обмен */

group('`/2` уезжает и приезжает обратно');
{
  const skill = skillFromRecording(RECORDING, '2026-09-11T10:00:00.000Z');
  const back = importSkills(exportSkill(skill))[0];

  check('формат тот же', back.format === SKILL_FORMAT, back.format);
  check('процедура доехала целиком',
    JSON.stringify(stepsSaid(back.procedure)) === JSON.stringify(stepsSaid(skill.procedure)));
  check('и whenToUse тоже', back.procedure.whenToUse === skill.procedure.whenToUse);
  check('и события никуда не делись', JSON.stringify(back.events) === JSON.stringify(skill.events));
  /* Локальная личность у копии своя: два человека могут держать один и тот же скилл. */
  check('а личность у копии новая', back.id !== skill.id && back.imported === true);
}

group('`/1` читается навсегда - и уезжает тем же, чем приехал');
{
  const one = {
    format: 'mouseflow.skill/1',
    kind: 'recorded',
    name: 'Accept and continue',
    description: '2 clicks',
    created: '2026-01-01T00:00:00.000Z',
    origins: ['example.com'],
    tabs: 1,
    params: [],
    events: [
      { action: 'click', selector: '#a', tag: 'button', text: 'Accept' },
      { action: 'click', selector: '#b', tag: 'a', text: 'Next' },
    ],
  };
  const up = importSkills(JSON.stringify(one))[0];

  /* ДОПОЛНЯЕТСЯ, А НЕ ПЕРЕПИСЫВАЕТСЯ. Процедура выводится из его же событий - то есть старый навык сразу
   * читается как документ, - но версия остаётся его: подменить её значило бы обещать читателю уровень,
   * которого в файле нет, и вернуть автору не тот артефакт, который он дал. */
  check('версия осталась его', up.format === 'mouseflow.skill/1', up.format);
  check('процедура выведена из его событий',
    JSON.stringify(stepsSaid(up.procedure)) === JSON.stringify(['Click "Accept"', 'Click "Next"']),
    stepsSaid(up.procedure).join(' | '));
  check('события остались ровно теми же', JSON.stringify(up.events) === JSON.stringify(one.events));

  /* И ЭКСПОРТ ВОЗВРАЩАЕТ ТО, ЧТО ИМПОРТИРОВАЛИ: версия, события и параметры - те же после круга. */
  const again = importSkills(exportSkill(up))[0];
  check('круг не меняет версию', again.format === 'mouseflow.skill/1', again.format);
  check('и не теряет события', JSON.stringify(again.events) === JSON.stringify(one.events));
  check('и не теряет процедуру', hasProcedure(again.procedure));
}

group('пустое отвергается словами, а незнакомое - названо');
{
  const refused = (payload) => {
    try { importSkills(JSON.stringify(payload)); return null; } catch (e) { return e.message; }
  };

  /* НИ ПРОЦЕДУРЫ, НИ СОБЫТИЙ - вот это отказ. Не «нет событий»: с `/2` документ без событий читается, и
   * отказать ему значило бы отказать документу за то, что он документ. */
  const hollow = refused({ format: SKILL_FORMAT, kind: 'recorded', name: 'Hollow' });
  check('скилл без процедуры и без событий отвергнут', !!hollow);
  check('и отказ говорит про оба вида содержимого',
    /no procedure to read and no recorded steps to replay/.test(hollow || ''), hollow);

  /* А ПРОЦЕДУРА БЕЗ СОБЫТИЙ - ПРИНИМАЕТСЯ: это весь продукт-документация. */
  const doc = importSkills(JSON.stringify({
    format: SKILL_FORMAT,
    kind: 'recorded',
    name: 'Читаемый документ',
    procedure: { whenToUse: 'Use it in example.com.', steps: [{ n: 1, said: 'Click "Accept"' }] },
  }))[0];
  check('а процедура без событий принимается - это документ', hasProcedure(doc.procedure));
  check('и событий у него честно нет, а не пустой массив', doc.events === undefined,
    JSON.stringify(doc.events));

  /* НЕЗНАКОМАЯ ВЕРСИЯ - отказ, называющий, что мы читаем. Человек, которому сказали «unrecognised», без
   * этого не знает, чего у него не хватает. */
  const future = refused({ format: 'mouseflow.skill/9', kind: 'recorded', name: 'X' });
  check('незнакомая версия отвергнута', !!future);
  check('и отказ перечисляет, что читается',
    (future || '').includes('mouseflow.skill/2') && (future || '').includes('mouseflow.skill/1'), future);
}

/* --------------------------------------------------------------------------- перевозит, но не судит */

group('`verification` перевозится расширением, а судит её readExpects - и они сходятся');
{
  /* ЗАЧЕМ ЭТА ГРУППА СУЩЕСТВУЕТ. Утверждения едут в скилле через расширение, а выносит по ним вердикт
   * api/_case.mjs. Повторить правило в расширении было нельзя - это было бы два представления о том, что
   * такое проверка, - а импортировать оттуда туда нечем: другой рантайм. Значит расширение только
   * ПЕРЕВОЗИТ шесть известных полей, а сходство двух уровней проверяется здесь, на одних данных. Без этой
   * группы «перевозит верно» было бы верой. */
  const good = [{
    check: 'text_contains',
    name: 'Status',
    text: 'Sent',
    why: 'the invoice actually went out',
    after: 'the message has been sent',
  }];

  const carried = importSkills(JSON.stringify({
    format: SKILL_FORMAT,
    kind: 'recorded',
    name: 'With a check',
    procedure: { steps: [{ n: 1, said: 'Click "Send"' }], verification: good },
  }))[0].procedure.verification;

  check('утверждение доехало', carried.length === 1, JSON.stringify(carried));

  /* И ТО, ЧТО ДОЕХАЛО, ПРОХОДИТ СУД - тем самым readExpects, которым его проверит и страница, и тул. */
  const judged = readExpects(carried, checksFor('browser'));
  check('и прошло readExpects без придирок', judged.why === '', judged.why);
  check('и судья не изменил его смысла',
    JSON.stringify(judged.expects[0]) === JSON.stringify({
      check: 'text_contains',
      name: 'Status',
      text: 'Sent',
      why: 'the invoice actually went out',
      after: 'the message has been sent',
    }),
    JSON.stringify(judged.expects[0]));

  /* ПЕРЕВОЗЧИК НЕ СУДИТ, И ЭТО ВИДНО: он провезёт вид проверки, которого не существует, а откажет по нему
   * тот, кто её будет выполнять. Так и должно быть - иначе у нас два мнения о том, какие проверки бывают,
   * и расширение пришлось бы обновлять всякий раз, когда появляется новый вид. */
  const nonsense = importSkills(JSON.stringify({
    format: SKILL_FORMAT,
    kind: 'recorded',
    name: 'Nonsense check',
    procedure: { steps: [{ n: 1, said: 'Click "Send"' }], verification: [{ check: 'vibes', why: 'hmm' }] },
  }))[0].procedure.verification;
  check('перевозчик провозит незнакомый вид проверки', nonsense.length === 1);
  check('а судья его отвергает, и говорит какие бывают',
    /is not a kind of check here/.test(readExpects(nonsense, checksFor('browser')).why));

  /* И БЕЗ `why` - тоже отказ судьи, а не перевозчика: `why` это единственная строка, которую человек
   * читает в красном отчёте в девять утра. */
  const noWhy = importSkills(JSON.stringify({
    format: SKILL_FORMAT,
    kind: 'recorded',
    name: 'No why',
    procedure: { steps: [{ n: 1, said: 'Click "Send"' }], verification: [{ check: 'text_is', name: 'S', text: 'x' }] },
  }))[0].procedure.verification;
  check('утверждение без «что это доказывает» отвергает судья',
    /say what it proves/.test(readExpects(noWhy, checksFor('browser')).why));
}

/* --------------------------------------------------------------------------- сервер только читает */

group('сервер процедуру не выводит - он её читает, и считает шаги раньше событий');
{
  /* РАЗМЕР СКИЛЛА - В ЧЕЛОВЕЧЕСКИХ ШАГАХ, КОГДА ОНИ ЕСТЬ. Событий на один шаг бывает десяток - движение,
   * нажатие, отпускание, - поэтому «42 recorded actions» отвечает не на тот вопрос, который задал
   * читатель: он спрашивает, сколько тут РАБОТЫ. */
  const withWords = structureOf({
    id: 'f1', name: 'Send invoice', kind: 'recorded', source: 'web', origins: ['mail.google.com'],
    payload: {
      version: 1,
      kind: 'recorded',
      events: WEB_EVENTS,
      procedure: { steps: [{ n: 1, said: 'Click "Compose"' }, { n: 2, said: 'Click "Send"' }] },
    },
  });
  check('где есть процедура - счёт по её шагам',
    /Carries out 2 steps: Click "Compose"; Click "Send"\./.test(withWords.description),
    withWords.description);

  /* А У `/1` - ПО СОБЫТИЯМ, и это верный ответ для него: другого содержимого у него нет. */
  const withEvents = structureOf({
    id: 'f2', name: 'Old skill', kind: 'recorded', source: 'web', origins: [],
    payload: { version: 1, kind: 'recorded', events: WEB_EVENTS },
  });
  check('а где её нет - по событиям, как было всегда',
    /Replays 9 recorded actions\./.test(withEvents.description), withEvents.description);

  /* И СОХРАНЁННОЕ ОПИСАНИЕ ПОБЕЖДАЕТ ОБА: describeRecording его уже написал, и два числа, спорящие внутри
   * одного предложения, - это то, что здесь однажды и было. */
  const stated = structureOf({
    id: 'f3', name: 'Stated', kind: 'recorded', source: 'web', origins: [],
    description: '9 events · 2 clicks · 4.0s',
    payload: { version: 1, kind: 'recorded', events: WEB_EVENTS, procedure: { steps: [{ n: 1, said: 'x' }] } },
  });
  check('а написанное человеком описание побеждает оба счёта',
    stated.description.startsWith('9 events · 2 clicks · 4.0s'), stated.description);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
