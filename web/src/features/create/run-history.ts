/* Что известно о прошлом прогоне - в одном месте, потому что читают его теперь двое.
 *
 * ПОЧЕМУ ФАЙЛ ПОЯВИЛСЯ. История прогонов живёт на Create в двух видах: списком в правой колонке на широком
 * окне (EarlierPanel) и лентой над строкой ввода на узком (Earlier). Это два разных способа показать одно и
 * то же, и правила у них обязаны быть общими - иначе колонка однажды посчитает прогон удачным, а лента тот
 * же самый нет. Ни одного из этих правил здесь не придумано заново: все они переехали из Earlier.tsx как
 * есть, вместе с объяснениями, ради которых они и записаны.
 *
 * Ничего не запрашивает и ничего не помнит. Строка user_run приезжает с аккаунта через AccountProvider;
 * здесь только то, как её читать.
 */
import type { Run } from '@/lib/api';
import type { DictatedRun } from '@/features/record/save-as-skill';

/** Шаг прогона, как он лежит на аккаунте. Форма принадлежит тому, кто прогон записал. */
export type Step = { tool?: string; input?: Record<string, unknown> | null };

/* ДЕСКТОПНЫЙ ЛИ ЭТО ПРОГОН - по форме шагов, а не по отсутствию поля.
 *
 * `saveDictatedAsGoalSkill` собирает скилл с `agent: 'desktop'` из шагов вида {tool, input}. Расширение
 * пишет шаги другой формы, и предложить сделать из них десктопный скилл значило бы собрать скилл, который
 * не запустится там, куда его положили. Спрашивается поэтому именно то, от чего зависит ответ: есть ли у
 * шагов `tool`. Различать по `extension === null` было бы догадкой по пустому месту. */
export const looksLikeDesktopRun = (steps: unknown): steps is Step[] =>
  Array.isArray(steps) && steps.length > 0 && steps.every((s) => s && typeof (s as Step).tool === 'string');

export const when = (iso: string | null) => {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return clock;
  if (days === 1) return `yesterday ${clock}`;
  return `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock}`;
};

export const took = (run: Run) => {
  if (!run.startedAt || !run.finishedAt) return null;
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
};

/* Только прогоны по цели, новые сверху.
 *
 * Повтор записи - это `kind: 'replay'`, у него нет цели, и в списке, который читается как разговор,
 * реплика без слов не реплика. `hide` - прогоны, показанные живьём в этой же сессии: после удачного
 * прогона страница перечитывает аккаунт, и без этого он появился бы дважды - один раз как ход, второй как
 * история этого же хода. */
export const goalRuns = (runs: Run[], hide: Set<string>) =>
  runs.filter((r) => r.kind === 'agent' && !!r.goal && !hide.has(r.id));

/* КАК ПРОГОН НАЗЫВАЕТСЯ В СПИСКЕ. Подпись, если её дали, иначе цель - и цель при этом никуда не девается:
 * она остаётся тем, что действительно ушло в работу, и тем, что пошлёт «Ask again». Именно поэтому
 * переименование не правит `goal`: иначе строка после правки утверждала бы, что запускали не то, что
 * запускали. См. db/013_run_named.sql. */
export const titleOf = (run: Run) =>
  (run.name && run.name.trim()) || run.goal || 'a run with no goal recorded';

export const stepsOf = (run: Run): Step[] => (looksLikeDesktopRun(run.steps) ? run.steps : []);

export const wordsOf = (run: Run): string[] =>
  (Array.isArray(run.said) ? run.said.filter((w) => typeof w === 'string') : []) as string[];

/* Скилл делается только из ДОКАЗАННОГО прогона - того, что дошёл до конца и записал шаги. Ровно то же
 * условие, что у живого хода; разница лишь в том, что здесь оно проверяется по записи, а не по тому, что
 * помнит страница. */
export const provable = (run: Run) => run.outcome === 'ok' && stepsOf(run).length > 0;

/** Прогон в том виде, в каком его принимает мастер скилла. */
export const dictatedFrom = (run: Run): DictatedRun => ({
  runId: run.id,
  /* ОКНА НЕ ВОССТАНОВИТЬ, и выдумывать их нельзя. У живого хода этот список спрашивается у машины в
   * момент, когда прогон закончился; неделю спустя на машине открыто другое, а строка прогона окон не
   * хранит. Пустой список значит «скилл не сужен» - это правда. Список наугад значил бы «применим вот
   * здесь» про места, которых никто не проверял. */
  windows: [],
  steps: stepsOf(run).map((s) => ({ tool: s.tool!, input: s.input ?? {} })),
  at: run.startedAt ?? new Date().toISOString(),
});
