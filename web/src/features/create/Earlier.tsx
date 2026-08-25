/* Что было создано раньше - на верху той же ленты, из той записи, которая уже есть.
 *
 * ЗАЧЕМ. «Создали - вышли - и он пропал»: ход на этой странице жил в памяти компонента, и переход на
 * соседний экран стирал всё. Стирал не только текст - у удачного прогона там же была единственная кнопка
 * «сделать скилл», и уйти со страницы значило потерять её навсегда, хотя сам прогон никуда не девался.
 *
 * ЧТО ЗДЕСЬ НЕ СДЕЛАНО, и это половина смысла файла. Ход НЕ сохраняется. Комментарий наверху CreateView
 * возражал против истории так: прогон уже записан на аккаунт, а вторая копия рядом - это два источника,
 * которые могут разойтись. Возражение верное, вывод из него был неверный: чинится это не сохранением
 * ленты, а ЧТЕНИЕМ той записи, которая и так есть. Строка user_run несёт цель, исход, слова и шаги;
 * GET /api/sync их уже отдаёт; AccountProvider их уже держит и кладёт на диск. Не хватало только того,
 * кто это покажет. Поэтому здесь нет ни своего запроса, ни своего состояния, ни своего кэша - и разойтись
 * нечему.
 *
 * ЧЕГО В ЗАПИСИ НЕТ, честно: паузы, волны, снимки экрана и порядок, в котором слова перемежались шагами.
 * Это события живого цикла, они никуда не писались и не пишутся. История показывает то, что записано, и
 * выглядит поэтому суше живого хода - но не притворяется им.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { AgentTurn, StepLine, UserTurn } from '@/components/chat';
import type { Flow, Run } from '@/lib/api';
import { type DictatedRun, hasSkillForRun } from '@/features/record/save-as-skill';
import { asDid, describe } from './describe';

/* Сколько показать сразу. Аккаунт отдаёт до шестидесяти прогонов, и вывалить их все над строкой ввода
 * значило бы заменить одну проблему другой: было не найти вчерашнее, стало не добраться до сегодняшнего. */
const SHOWN = 8;

/** Шаг прогона, как он лежит на аккаунте. Форма принадлежит тому, кто прогон записал. */
type Step = { tool?: string; input?: Record<string, unknown> | null };

/* ДЕСКТОПНЫЙ ЛИ ЭТО ПРОГОН - по форме шагов, а не по отсутствию поля.
 *
 * `saveDictatedAsGoalSkill` собирает скилл с `agent: 'desktop'` из шагов вида {tool, input}. Расширение
 * пишет шаги другой формы, и предложить сделать из них десктопный скилл значило бы собрать скилл, который
 * не запустится там, куда его положили. Спрашивается поэтому именно то, от чего зависит ответ: есть ли у
 * шагов `tool`. Различать по `extension === null` было бы догадкой по пустому месту. */
const looksLikeDesktopRun = (steps: unknown): steps is Step[] =>
  Array.isArray(steps) && steps.length > 0 && steps.every((s) => s && typeof (s as Step).tool === 'string');

const when = (iso: string | null) => {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return clock;
  if (days === 1) return `yesterday ${clock}`;
  return `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock}`;
};

const took = (run: Run) => {
  if (!run.startedAt || !run.finishedAt) return null;
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
};

export const Earlier = ({
  runs,
  flows,
  hide,
  onAskAgain,
  onSaveAsSkill,
  openByDefault,
}: {
  runs: Run[];
  flows: Flow[];
  /** Прогоны, уже показанные живьём в этой сессии. Один прогон дважды в одной ленте - это не история. */
  hide: Set<string>;
  onAskAgain: (goal: string) => void;
  onSaveAsSkill: (run: DictatedRun, goal: string) => void;
  /** Развернуть сразу, когда в ленте больше нечего показать: за историей человек и пришёл. */
  openByDefault: boolean;
}) => {
  const [open, setOpen] = useState(openByDefault);
  const [all, setAll] = useState(false);

  /* Только прогоны по цели. Повтор записи - это `kind: 'replay'`, у него нет цели, и в ленте, которая
   * читается как разговор, реплика без слов не реплика. */
  const mine = runs.filter((r) => r.kind === 'agent' && !!r.goal && !hide.has(r.id));
  if (!mine.length) return null;

  /* Аккаунт отдаёт новые сверху; лента читается сверху вниз и кончается сегодняшним. */
  const ordered = [...mine].reverse();
  const shown = all ? ordered : ordered.slice(-SHOWN);
  const hidden = ordered.length - shown.length;

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        className={cn(
          'flex items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-[0.8rem]',
          'text-ink-secondary hover:text-ink-primary',
        )}
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {mine.length} earlier {mine.length === 1 ? 'run' : 'runs'} on this account
        {!open && mine[0]?.startedAt && (
          <span className="text-ink-inactive">· last {when(mine[0].startedAt)}</span>
        )}
      </button>

      {open && (
        <>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="self-center text-[0.8rem] text-ink-secondary hover:text-ink-primary"
            >
              Show {hidden} older
            </button>
          )}

          {shown.map((run) => {
            const steps = looksLikeDesktopRun(run.steps) ? run.steps : [];
            const words = Array.isArray(run.said) ? run.said.filter((w) => typeof w === 'string') : [];
            const note = run.summary ?? run.error ?? null;
            const length = took(run);
            /* Скилл делается только из ДОКАЗАННОГО прогона - того, что дошёл до конца и записал шаги.
             * Ровно то же условие, что у живого хода; разница лишь в том, что здесь оно проверяется по
             * записи, а не по тому, что помнит страница. */
            const provable = run.outcome === 'ok' && steps.length > 0;

            return (
              <div key={run.id} className="flex flex-col gap-3 opacity-90">
                <UserTurn
                  meta={[when(run.startedAt), length && `took ${length}`].filter(Boolean).join(' · ')}
                >
                  {run.goal}
                </UserTurn>

                <AgentTurn tone={run.outcome === 'ok' ? 'ok' : run.outcome === 'running' ? 'running' : 'failed'}>
                  {words.map((word, i) => (
                    <StepLine key={`w${i}`} kind="say">{word}</StepLine>
                  ))}

                  {steps.map((step, i) => (
                    <StepLine key={`s${i}`} kind="tool">{describe(asDid(step))}</StepLine>
                  ))}

                  {/* ЧТО СКАЗАТЬ, КОГДА ШАГОВ НЕ ВИДНО - и это три разных случая, а не один.
                    *
                    * Строка может нести шаги чужой формы (так пишет расширение), не нести их вовсе (так
                    * выглядят прогоны, записанные до того, как шаги стали записываться) или не иметь конца
                    * (прогон, который не доложил, что закончился). Показать во всех трёх пустую карточку
                    * значило бы сказать «ничего не делал» - враньё про чужую запись, и именно то враньё,
                    * которое потом читают как «продукт потерял мои данные». */}
                  {!steps.length && (
                    <StepLine kind="waiting">
                      {run.outcome === 'running'
                        ? 'This one never reported that it finished.'
                        : Array.isArray(run.steps) && run.steps.length
                          ? `${run.steps.length} steps, in the browser extension’s own shape — this page `
                            + 'reads the desktop agent’s.'
                          : 'No step-by-step trace was kept for this run.'}
                    </StepLine>
                  )}

                  {note && (
                    <Typography
                      variant="p"
                      className={cn(
                        'mt-1 text-[0.88rem]',
                        run.outcome === 'ok' ? 'text-fb-green' : 'text-fb-red-text',
                      )}
                    >
                      {note}
                    </Typography>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      leftSlot={<RotateCcw className="size-4" />}
                      onClick={() => onAskAgain(run.goal!)}
                    >
                      Ask again
                    </Button>

                    {/* Та самая кнопка, которую уход со страницы уносил навсегда. Исчезает, когда скилл
                      * уже сделан: второе приглашение сделать то же самое читается как «первое не
                      * сработало». */}
                    {provable && (
                      hasSkillForRun(flows, run.id) ? (
                        <Typography variant="p" className="ms-1 text-ink-inactive text-[0.82rem]">
                          Saved as a skill.
                        </Typography>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          leftSlot={<Sparkles className="size-4" />}
                          onClick={() => onSaveAsSkill(
                            {
                              runId: run.id,
                              /* ОКНА НЕ ВОССТАНОВИТЬ, и выдумывать их нельзя. У живого хода этот список
                               * спрашивается у машины в момент, когда прогон закончился; неделю спустя на
                               * машине открыто другое, а строка прогона окон не хранит. Пустой список
                               * значит «скилл не сужен» - это правда. Список наугад значил бы «применим
                               * вот здесь» про места, которых никто не проверял. */
                              windows: [],
                              steps: steps.map((s) => ({ tool: s.tool!, input: s.input ?? {} })),
                              at: run.startedAt ?? new Date().toISOString(),
                            },
                            run.goal!,
                          )}
                        >
                          Save as skill
                        </Button>
                      )
                    )}
                  </div>
                </AgentTurn>
              </div>
            );
          })}

          <div className="flex items-center gap-3 pt-1">
            <div className="h-px flex-1 bg-stroke" />
            <span className="text-[0.72rem] text-ink-inactive">now</span>
            <div className="h-px flex-1 bg-stroke" />
          </div>
        </>
      )}
    </div>
  );
};
