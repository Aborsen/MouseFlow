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
import { Check, ChevronDown, ChevronRight, Pencil, RotateCcw, Sparkles, X } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { AgentTurn, StepLine, UserTurn } from '@/components/chat';
import { ArmedButton } from '@/components/ArmedButton';
import type { Flow, Run } from '@/lib/api';
import { useAgent } from '@/lib/store';
import { type DictatedRun, hasSkillForRun } from '@/features/record/save-as-skill';
import { asDid, describe } from './describe';
import { evidenceOf, verdictKind } from './verdict';
import { dictatedFrom, goalRuns, provable, stepsOf, titleOf, took, when, wordsOf } from './run-history';

/* Сколько показать сразу. Аккаунт отдаёт до шестидесяти прогонов, и вывалить их все над строкой ввода
 * значило бы заменить одну проблему другой: было не найти вчерашнее, стало не добраться до сегодняшнего. */
const SHOWN = 8;

export const Earlier = ({
  runs,
  flows,
  hide,
  onAskAgain,
  onSaveAsSkill,
  onRename,
  onDelete,
  openByDefault,
}: {
  runs: Run[];
  flows: Flow[];
  /** Прогоны, уже показанные живьём в этой сессии. Один прогон дважды в одной ленте - это не история. */
  hide: Set<string>;
  onAskAgain: (goal: string) => void;
  onSaveAsSkill: (run: DictatedRun, goal: string) => void;
  /** Пустое имя стирает подпись и возвращает строке её собственную цель. Бросает, если не записалось. */
  onRename: (id: string, name: string | null) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** Развернуть сразу, когда в ленте больше нечего показать: за историей человек и пришёл. */
  openByDefault: boolean;
}) => {
  /* Какой машиной подписывать аккорды: на маке `ctrl` в шаге - это ⌘. См. describe. */
  const { health } = useAgent();
  const platform = health?.platform;
  const [open, setOpen] = useState(openByDefault);
  const [all, setAll] = useState(false);
  /** Какой прогон сейчас переименовывают, и что набрали. */
  const [naming, setNaming] = useState<{ id: string; text: string } | null>(null);
  /** Взведённая кнопка удаления - одна на всю ленту: см. ArmedButton. */
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /* Отказ называется, а не глотается: молча проглоченный выглядит как «удалилось», а строка потом
   * возвращается при следующей перезагрузке аккаунта, и понять почему уже невозможно. */
  const act = async (id: string, what: () => Promise<void>) => {
    setBusy(id);
    setProblem(null);
    try {
      await what();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'the account did not take that change');
    } finally {
      setBusy(null);
    }
  };

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
          {problem && (
            <Typography variant="p" className="text-fb-red-text text-[0.82rem]">{problem}</Typography>
          )}

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
                {naming?.id === run.id ? (
                  /* Поле стоит НА МЕСТЕ реплики, а не в отдельном окне: видно, что именно правится. */
                  <div className="flex items-center justify-end gap-1">
                    <input
                      autoFocus
                      value={naming.text}
                      onChange={(ev) => setNaming({ id: run.id, text: ev.target.value })}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Escape') { ev.preventDefault(); setNaming(null); }
                        if (ev.key === 'Enter') {
                          ev.preventDefault();
                          const name = naming.text.trim();
                          setNaming(null);
                          void act(run.id, () => onRename(run.id, name || null));
                        }
                      }}
                      placeholder={run.goal ?? 'Name this run'}
                      aria-label="Name for this run"
                      className={cn(
                        'min-w-0 max-w-[75%] flex-1 rounded-md border-brand-primary/60 border',
                        'bg-surface-card2 px-2.5 py-1.5 text-[0.9rem] text-ink-primary',
                        'placeholder:text-ink-inactive focus:outline-none',
                      )}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Save this name"
                      isLoading={busy === run.id}
                      onClick={() => {
                        const name = naming.text.trim();
                        setNaming(null);
                        void act(run.id, () => onRename(run.id, name || null));
                      }}
                    >
                      <Check className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Leave the name as it was"
                      onClick={() => setNaming(null)}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <UserTurn
                    meta={[when(run.startedAt), length && `took ${length}`].filter(Boolean).join(' · ')}
                  >
                    {titleOf(run)}
                  </UserTurn>
                )}

                <AgentTurn tone={run.outcome === 'ok' ? 'ok' : run.outcome === 'running' ? 'running' : 'failed'}>
                  {/* НАЗВАНА - значит цель под ней всё ещё видна. Иначе подпись подменяла бы собой то,
                    * что на самом деле запускали, и «Ask again» посылал бы неожиданное. */}
                  {run.name && run.name.trim() && run.goal && (
                    <Typography variant="p" className="text-ink-inactive text-[0.82rem] italic">
                      asked for: {run.goal}
                    </Typography>
                  )}

                  {words.map((word, i) => (
                    <StepLine key={`w${i}`} kind="say">{word}</StepLine>
                  ))}

                  {steps.map((step, i) => (
                    <StepLine key={`s${i}`} kind={verdictKind(step)}>
                      {describe(asDid(step), platform)}
                      {evidenceOf(step)}
                    </StepLine>
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

                    <Button
                      variant="ghost"
                      size="sm"
                      leftSlot={<Pencil className="size-4" />}
                      onClick={() => setNaming({ id: run.id, text: run.name ?? '' })}
                    >
                      Rename
                    </Button>

                    {/* Спрашивает дважды, и вторая надпись говорит, что именно уходит: строка прогона -
                      * единственная его запись, и вместе с ней исчезают и итоги на Dashboard, и то, что о
                      * нём знает ассистент. */}
                    <ArmedButton
                      label="Delete"
                      armedLabel="Delete for good — press again"
                      armed={armed === run.id}
                      busy={busy === run.id}
                      onArm={() => setArmed(run.id)}
                      onDisarm={() => setArmed((was) => (was === run.id ? null : was))}
                      onConfirm={() => {
                        setArmed(null);
                        void act(run.id, () => onDelete(run.id));
                      }}
                    />
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
