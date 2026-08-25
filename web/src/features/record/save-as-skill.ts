/* Сделать скилл из записи. Одна реализация на все страницы, которые это предлагают.
 *
 * ЗДЕСЬ БЫЛО ДВА ПУТИ, и остался один. Буквальный повтор (`saveAsSkill`, id `dr_<запись>`) копировал события
 * и проигрывал их по экранным координатам: бесплатно, быстро, и он не умел печатать - содержимое нажатий
 * нигде не хранится. Он убран целиком, вместе с обеими кнопками, которые его вызывали: два разных исхода под
 * одним словом «скилл» - это выбор, который человек делает до того, как узнал разницу.
 *
 * Остался `saveAsGoalSkill` - скилл-ЦЕЛЬ, который визард собирает из выбранных шагов и набранного текста.
 * Что в нём важно, написано над ним; `skillIdFor` ниже остался, потому что старые `dr_` скиллы на аккаунтах
 * никуда не делись и их надо узнавать.
 */
import { type Flow, push } from '@/lib/api';
import { SKILL_ROLE } from '@/lib/flow-role';
import { fmtMs, summarize } from '@/lib/macro';
import type { Recording } from '@/lib/store';

/** Описание, которое человек узнает в списке через неделю: что повторяется, сколько это заняло и где. */
export function describeRecording(rec: Recording): string {
  const s = summarize(rec.events);
  const where = rec.windows.map((w) => w.title).filter(Boolean);
  return (
    `Repeats ${s.count} recorded actions`
    + (s.clicks ? ` (${s.clicks} click${s.clicks === 1 ? '' : 's'})` : '')
    + ` over ${fmtMs(s.durationMs)}`
    + (where.length ? `, in ${where.slice(0, 3).join(', ')}` : '')
    + '.'
  ).slice(0, 400);
}

/** Id скилла-повтора, сделанного из этой записи. Делать такие больше нельзя - буквальный повтор убран из
 * интерфейса совсем - но на аккаунтах они есть, сделанные раньше, и `hasSkillFor` обязан их видеть: иначе
 * запись со скиллом вернётся в блок «ещё не стали скиллом» и человека позовут сделать то же второй раз. */
export const skillIdFor = (recordingId: string) => `dr_${recordingId}`;

/** Id скилла-ЦЕЛИ, сделанного из этой записи. Единственный вид, который теперь делается; приставка своя,
 *  потому что у старой записи может лежать и повтор под `dr_`, а это разные вещи с разными судьбами. */
export const goalSkillIdFor = (recordingId: string) => `gs_${recordingId}`;

/* Есть ли у записи скилл на аккаунте - ЛЮБОЙ из двух видов.
 *
 * Делается теперь только цель (`gs_`), но повторы (`dr_`) на аккаунтах остались, сделанные до того. Проверять
 * лишь один вид значило бы вернуть такую запись в блок «ещё не стали скиллом» - обещание блока перестаёт быть
 * правдой, и человека приглашают сделать то же дважды. */
export const hasSkillFor = (flows: Flow[], recordingId: string) =>
  flows.some((flow) => flow.id === skillIdFor(recordingId) || flow.id === goalSkillIdFor(recordingId));

/* --------------------------------------------------------------------------- a skill that can type */

export interface GoalParam {
  name: string;
  /** Один из трёх типов, которые знает parameterise() и умеет описывать api/_skill-schema.mjs. */
  type: 'quoted' | 'email' | 'url';
  /** Всегда null у визарда: пример - это ЛИЧНОЕ значение автора, а fillGoal подставляет его, когда поле
   *  оставили пустым. Параметр без примера обязателен, и это ровно то, что значит «спрашивать каждый раз». */
  example: string | null;
}

/* Сохранить запись как СКИЛЛ-ЦЕЛЬ - тот вид, который умеет печатать.
 *
 * Почему цель, а не макрос, подробно написано в SkillWizard.tsx. Короткая версия: в пятиколоночном формате
 * повтора нет действия «печатать», и добавить его - это менять разбор у обоих агентов; а целевой путь уже
 * печатает, уже перечитывает экран и уже доезжает до ИИ через MCP с типизированными параметрами.
 *
 * `kind: 'created'` - не украшение: structureOf() читает именно его, чтобы отдать параметры вместо
 * repeat/speed, и без него скилл приедет к модели как макрос без аргументов.
 */
/* WHAT IT READS OF THE RECORDING, and it is four fields - stated as a Pick rather than as `Recording`
 * because the caller is not always holding one. The transcript panel opens this wizard for a recording
 * that may not be in this browser at all, and fabricating an empty `events` array to satisfy a type
 * that is never read would be a lie the next reader has to disprove. */
export type GoalSkillSource = Pick<Recording, 'id' | 'name' | 'created' | 'windows'>;

export async function saveAsGoalSkill(
  rec: GoalSkillSource,
  said: { name: string; goal: string; params: GoalParam[]; steps: { name: string; input: string | null }[] },
): Promise<void> {
  const title = (said.name || rec.name).slice(0, 80);
  const where = rec.windows.map((w) => w.title).filter(Boolean);
  const asks = said.params.length
    ? ` Asks for ${said.params.map((p) => p.name).join(', ')}.`
    : '';
  const description = (`Carries out: ${said.goal.split('\n')[0]}`.slice(0, 300) + asks).slice(0, 400);

  const body = await push({
    flows: [{
      id: goalSkillIdFor(rec.id),
      /* `desktop`, потому что выполнять это будет локальный агент. Расширению такое предлагать нельзя: оно
       * умеет страницу, а здесь речь про приложения на машине. */
      source: 'desktop',
      kind: 'created',
      name: title,
      description,
      origins: where.slice(0, 12),
      created: rec.created,
      payload: {
        version: 1,
        kind: 'created',
        agent: 'desktop',
        role: SKILL_ROLE,
        name: title,
        description,
        /* То, что подставляется и выполняется. fillGoal() читает goalTemplate, missingParams() - params. */
        goalTemplate: said.goal,
        params: said.params,
        /* Свидетельство, а не то, что повторяется: шаги записи, из которой это сделано. structureOf()
         * показывает их как «что сделал один удачный прогон». */
        steps: said.steps.slice(0, 200),
        /* Откуда взялось. Запись живёт своей жизнью и может быть удалена - скилл от этого не пустеет, но
         * знать происхождение полезно, и это единственная связь между ними. */
        fromRecording: rec.id,
        created: rec.created,
      },
    }],
  });

  if (body.problems.length) throw new Error(body.problems.join('; '));
}

/* --------------------------------------------------------- a skill from a flow somebody dictated */

/* ЕЩЁ ОДИН ИСТОЧНИК, НО НЕ ЕЩЁ ОДИН ВИД СКИЛЛА - разница, из-за которой буквальный повтор пришлось убирать.
 *
 * Флоу, надиктованный в чате, - это уже текст цели. Записи визард нужен затем, чтобы из трёхсот событий
 * собрать предложение; здесь предложение написал человек, и собирать нечего. Отличается только ПРОИСХОЖДЕНИЕ:
 * доказательством служат шаги удачного прогона, а не шаги записи.
 *
 * Поэтому формат тот же самый - `kind: 'created'`, goalTemplate, params, steps-как-свидетельство, - и
 * запускается он тем же путём. Два входа, один скилл; это не то же, что два скилла под одним словом.
 */
export interface DictatedRun {
  /** Прогон, который это доказал. Скилл делается только из удачного - непроверенному тут не место. */
  runId: string;
  /** Окна, в которых прогон работал: то же поле origins, что у записи, и та же роль - где это применимо. */
  windows: string[];
  /** Что цикл делал по шагам. Свидетельство, а не то, что повторяется. */
  steps: { tool: string; input: Record<string, unknown> }[];
  at: string;
}

/** Id скилла, сделанного из надиктованного прогона. Своя приставка: `gs_` принадлежит записям, и
 *  склеивать их значило бы, что удаление записи трогает чужой скилл. */
export const dictatedSkillIdFor = (runId: string) => `gd_${runId}`;

export const hasSkillForRun = (flows: Flow[], runId: string) =>
  flows.some((flow) => flow.id === dictatedSkillIdFor(runId));

export async function saveDictatedAsGoalSkill(
  run: DictatedRun,
  said: { name: string; goal: string; params: GoalParam[] },
): Promise<void> {
  const title = said.name.slice(0, 80);
  const asks = said.params.length
    ? ` Asks for ${said.params.map((p) => p.name).join(', ')}.`
    : '';
  const description = (`Carries out: ${said.goal.split('\n')[0]}`.slice(0, 300) + asks).slice(0, 400);

  const body = await push({
    flows: [{
      id: dictatedSkillIdFor(run.runId),
      source: 'desktop',
      kind: 'created',
      name: title,
      description,
      origins: run.windows.slice(0, 12),
      created: run.at,
      payload: {
        version: 1,
        kind: 'created',
        agent: 'desktop',
        role: SKILL_ROLE,
        name: title,
        description,
        goalTemplate: said.goal,
        params: said.params,
        /* Шаги прогона, обрезанные так же, как у записи. Читаются как «что сделал один удачный прогон» -
         * ровно та роль, которую structureOf() им отводит. */
        steps: run.steps.slice(0, 200).map((s, i) => ({
          name: `${i + 1}. ${s.tool}`,
          input: null as string | null,
        })),
        /* Откуда взялось. У записи здесь fromRecording; прогон - другой род свидетельства, и называть его
         * записью значило бы отправить читателя искать несуществующую. */
        fromRun: run.runId,
        created: run.at,
      },
    }],
  });

  if (body.problems.length) throw new Error(body.problems.join('; '));
}
