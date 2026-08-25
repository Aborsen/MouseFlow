/* Сделать скилл из записи. Одна реализация на все страницы, которые это предлагают.
 *
 * Так живёт здесь, а не в RecordView, потому что предлагают это уже две страницы - Record и Skills - и
 * payload, написанный дважды, однажды разойдётся. Это не гипотеза: та же ошибка уже случалась с `flowFor`,
 * где восстановленная запись перестала совпадать с сохранённой, и лечилось это ровно так - одним строителем
 * на двух вызывающих.
 *
 * ЧТО ЗДЕСЬ ВАЖНО, кроме отсутствия дублей:
 *
 *   id           `dr_<id записи>`, а не новый. Значит «сохранить как скилл» дважды обновит одну строку вместо
 *                того чтобы завести вторую - и значит по записи можно СПРОСИТЬ, есть ли у неё скилл, чем и
 *                пользуется статус в обеих таблицах.
 *   role         SKILL_ROLE. Без этого строка попадёт в список записей на Record и однажды будет удалена
 *                оттуда как запись - вместе с транскриптом, чего никто не просил.
 *   события      копируются в payload скилла. Скилл самодостаточен: удаление записи, из которой он сделан,
 *                не оставляет его пустым. Две вещи, две судьбы.
 *   source       переносится с записи, а не угадывается. `desktop` - это экранные координаты; предложить
 *                расширению проигрывать их значило бы кликать по бессмысленным позициям в странице.
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

/** Id скилла, сделанного из этой записи. Выведен из id записи, поэтому «есть ли скилл» - это вопрос, на
 * который можно ответить, а не догадка. */
export const skillIdFor = (recordingId: string) => `dr_${recordingId}`;

/** Id скилла-ЦЕЛИ, сделанного из этой записи. Другая приставка, потому что у записи могут быть оба:
 *  буквальный повтор и цель, и это разные вещи с разными судьбами. */
export const goalSkillIdFor = (recordingId: string) => `gs_${recordingId}`;

/* Есть ли у записи скилл на аккаунте - ЛЮБОЙ из двух.
 *
 * Их два вида, и они не одно и то же: буквальный повтор (`dr_`) и цель, собранная визардом (`gs_`).
 * Проверять только первый значило бы оставлять запись в блоке «ещё не стали скиллом» после того, как из неё
 * уже сделали скилл - обещание блока перестаёт быть правдой, и человека приглашают сделать то же дважды.
 * Оба пути при этом никуда не деваются: на странице Skills лежат обе кнопки. */
export const hasSkillFor = (flows: Flow[], recordingId: string) =>
  flows.some((flow) => flow.id === skillIdFor(recordingId) || flow.id === goalSkillIdFor(recordingId));

export async function saveAsSkill(rec: Recording, name?: string): Promise<void> {
  const described = describeRecording(rec);
  const title = (name || rec.name).slice(0, 80);
  const where = rec.windows.map((w) => w.title).filter(Boolean);

  const body = await push({
    flows: [{
      id: skillIdFor(rec.id),
      /* `desktop`, что решает, кто может это запустить: это экранные координаты, и расширению их предлагать
       * нельзя - оно кликало бы по бессмысленным позициям в странице. */
      source: 'desktop',
      kind: 'recorded',
      name: title,
      description: described,
      origins: where.slice(0, 12),
      created: rec.created,
      payload: {
        version: 1,
        kind: 'recorded',
        agent: 'desktop',
        // Скилл, и самодостаточный: события ниже - его собственная копия.
        role: SKILL_ROLE,
        name: title,
        description: described,
        events: rec.events,
        windows: rec.windows,
        created: rec.created,
      },
    }],
  });

  if (body.problems.length) throw new Error(body.problems.join('; '));
}

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
