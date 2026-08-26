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
 *
 * ЭТО ВИД ДЛЯ УЗКОГО ОКНА. На широком та же история стоит колонкой справа - см. EarlierPanel, - и лента
 * ниже xl скрыта. Два вида, одни правила: всё, от чего зависит, какой прогон показывать и можно ли из него
 * сделать скилл, лежит в run-history.ts и читается обоими. Иначе колонка однажды посчитала бы прогон удачным,
 * а лента тот же самый нет.
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
import { dictatedFrom, goalRuns, provable, stepsOf, took, when, wordsOf } from './run-history';

/* Сколько показать сразу. Аккаунт отдаёт до шестидесяти прогонов, и вывалить их все над строкой ввода
 * значило бы заменить одну проблему другой: было не найти вчерашнее, стало не добраться до сегодняшнего. */
const SHOWN = 8;

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

  const mine = goalRuns(runs, hide);
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
            const steps = stepsOf(run);
            const words = wordsOf(run);
            const note = run.summary ?? run.error ?? null;
            const length = took(run);

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
                    {provable(run) && (
                      hasSkillForRun(flows, run.id) ? (
                        <Typography variant="p" className="ms-1 text-ink-inactive text-[0.82rem]">
                          Saved as a skill.
                        </Typography>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          leftSlot={<Sparkles className="size-4" />}
                          onClick={() => onSaveAsSkill(dictatedFrom(run), run.goal!)}
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
