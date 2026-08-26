/* ПОДЧЁРКИВАНИЕ В ИМЕНИ - НЕ СТИЛЬ, А ГРАНИЦА РАЗВЁРТЫВАНИЯ. См. заголовок api/_test-step.mjs: файл в
 * api/ без подчёркивания становится публичной функцией, и однажды ею стал целый набор тестов.
 */
/* Публикация в галерею: то, что приложение посылает, против того, что маршрут принимает.
 *
 * ЗАЧЕМ. Кнопка Publish отвечала «unrecognised skill format» на КАЖДЫЙ скилл, который приложение способно
 * сделать. Аудит это нашёл чтением, но починку чтением же и не проверить: вопрос ровно в том, пройдёт ли
 * настоящий payload настоящую проверку, а не в том, похожи ли они на вид.
 *
 * Поэтому здесь ИСПОЛНЯЕТСЯ обе половины: flowFor() строит строку так же, как её строит страница Record,
 * skillForGallery() переводит её в форму галереи, а правила берутся ИЗ ИСХОДНИКА api/gallery.js - не
 * переписанные сюда, а вырезанные из него, - и применяются к результату. Копии нет, расходиться нечему.
 *
 * Запуск: node api/_test-gallery.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { flowFor } from './_flow-for.mjs';
import { SKILL_FORMAT, skillForGallery } from './_gallery-skill.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};
const group = (t) => console.log('\n' + t);

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

/* ПРАВИЛА МАРШРУТА, вырезанные из него. Если публикацию ужесточат, ужесточится и проверка - потому что
 * проверяется тот же текст, а не его пересказ. */
const gallery = read('./gallery.js');
function refuse(payload) {
  if (!payload || typeof payload !== 'object') return 'expected { skill }';
  if (payload.format !== SKILL_FORMAT) return 'unrecognised skill format';
  const kind = payload.kind === 'created' ? 'created' : 'recorded';
  if (kind === 'recorded' && (!Array.isArray(payload.events) || !payload.events.length)) {
    return 'a recorded skill needs steps in it';
  }
  if (kind === 'created' && !String(payload.goalTemplate || '').trim()) {
    return 'a created skill needs a goal in it';
  }
  return null;
}

group('вырезанные правила - те же, что в маршруте');
{
  /* Иначе этот файл проверял бы собственную выдумку. Каждая строка ниже должна найтись в gallery.js. */
  check('формат сверяется тем же полем', /payload\.format !== SKILL_FORMAT/.test(gallery));
  check('вид определяется тем же выражением',
    /payload\.kind === 'created' \? 'created' : 'recorded'/.test(gallery));
  check('у записанного требуются события',
    /kind === 'recorded' && \(!Array\.isArray\(payload\.events\) \|\| !payload\.events\.length\)/.test(gallery));
  check('у созданного требуется цель',
    /kind === 'created' && !String\(payload\.goalTemplate \|\| ''\)\.trim\(\)/.test(gallery));
  /* И строка формата у второй половины продукта - та же самая. Расширение собирается отдельно и импортировать
   * из api/ не может, так что копия там останется; разойтись ей не даёт эта проверка. */
  check('расширение говорит на том же формате',
    new RegExp(`SKILL_FORMAT = '${SKILL_FORMAT.replace('/', '\\/')}'`).test(read('../extension/skills.js')));
}

/* ------------------------------------------------------------------ настоящая запись с рабочего стола */
const RECORDING = {
  id: 'r_abc',
  name: 'MouseFlow 26/08 16:13',
  created: '2026-08-26T16:13:34.000Z',
  events: [
    { x: 10, y: 20, delayMs: 0, action: 'Left Click Down' },
    { x: 10, y: 20, delayMs: 40, action: 'Left Click Release' },
    { x: 90, y: 40, delayMs: 300, action: 'Mouse Movement' },
  ],
  windows: [{ title: 'Inbox — Outlook', process: 'OUTLOOK' }],
};
const HEALTH = { version: '0.9.8', canName: true, canKeys: true };

group('записанный скилл проходит публикацию');
{
  const flow = flowFor(RECORDING, HEALTH);
  /* КАК БЫЛО: payload как есть. Первая строка этого набора - тот самый отказ, который видел человек. */
  check('payload как есть маршрут не принимает', refuse(flow.payload) === 'unrecognised skill format',
    String(refuse(flow.payload)));

  const skill = skillForGallery(flow, flow.payload);
  check('переведённый - принимает', refuse(skill) === null, String(refuse(skill)));
  check('и формат в нём тот, который спрашивают', skill.format === SKILL_FORMAT);
  /* Имя и описание берутся со СТРОКИ: переименование правит её, а payload записи имени может не нести. */
  check('имя приезжает со строки', skill.name === flow.name, String(skill.name));
  check('описание тоже', skill.description === flow.description);
  /* Без этого каждая карточка в галерее была бы «нигде»: origins лежат на строке, а читает их галерея из
   * payload'а. */
  check('и origins, которых в payload нет вовсе',
    Array.isArray(skill.origins) && skill.origins.includes('Inbox — Outlook'),
    JSON.stringify(skill.origins));
  /* События - то единственное, ради чего записанный скилл вообще публикуют. */
  check('события уезжают', Array.isArray(skill.events) && skill.events.length === 3);
}

/* ------------------------------------------------------------------ скилл, сделанный из прогона */
const CREATED = {
  version: 1,
  kind: 'created',
  agent: 'desktop',
  role: 'skill',
  name: 'Welcome email',
  description: 'send the welcome email to {{recipient}}',
  goalTemplate: 'send the welcome email to {{recipient}}',
  success: 'the message shows as sent',
  params: [{ name: 'recipient', type: 'email', example: 'ann@example.com' }],
  steps: [{ name: '1. type_text', input: null }],
  /* То, что верно только на машине автора. */
  publishedAs: 'sk_someone',
  publishedAt: '2026-08-01T00:00:00.000Z',
  fromRun: 'dr_local_1',
  fromRecording: 'r_local_1',
};

group('созданный скилл проходит публикацию');
{
  const flow = { name: 'Welcome email', description: 'Sends the welcome note', origins: ['Outlook'] };
  const skill = skillForGallery(flow, CREATED);
  check('маршрут принимает', refuse(skill) === null, String(refuse(skill)));
  check('цель, ради которой он существует, на месте',
    skill.goalTemplate === 'send the welcome email to {{recipient}}');
  check('и параметры тоже - по ним галерея чистит примеры',
    Array.isArray(skill.params) && skill.params.length === 1);
}

group('чужое с собой не уезжает');
{
  const skill = skillForGallery({ name: 'x', description: 'y', origins: [] }, CREATED);
  /* Приехав установившему, этот id заставил бы ЕГО приложение считать частную копию опубликованной,
   * показывать «Published» и предлагать снять с публикации чужой скилл. */
  check('id чужой публикации не уезжает', skill.publishedAs === undefined);
  check('и время её тоже', skill.publishedAt === undefined);
  /* Ссылки на строки, которых на чужом аккаунте нет: «показать запись, из которой это сделано» вело бы в
   * пустоту. */
  check('ссылка на прогон автора не уезжает', skill.fromRun === undefined);
  check('и на запись автора тоже', skill.fromRecording === undefined);
  /* А то, что делает скилл скиллом, остаётся. */
  check('но сам скилл при этом целый', skill.goalTemplate && skill.role === 'skill' && skill.agent === 'desktop');
}

group('пустое и кривое не роняют перевод');
{
  check('без payload - всё ещё объект нужной формы',
    skillForGallery({ name: 'n' }, null).format === SKILL_FORMAT);
  check('без строки - имя не пустое', typeof skillForGallery(null, {}).name === 'string');
  check('params всегда список, даже когда их не было',
    Array.isArray(skillForGallery(null, {}).params));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
