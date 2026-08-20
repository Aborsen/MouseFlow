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

/** Есть ли у записи скилл на аккаунте. */
export const hasSkillFor = (flows: Flow[], recordingId: string) =>
  flows.some((flow) => flow.id === skillIdFor(recordingId));

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
