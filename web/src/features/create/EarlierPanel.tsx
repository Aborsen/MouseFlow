/* Прошлые прогоны, колонкой справа - на месте, где раньше стоял снимок экрана.
 *
 * ЧТО ЗДЕСЬ БЫЛО. Панель Live Context: миниатюра рабочего стола, активное приложение, число окон,
 * разрешение. Идея была хорошая - «посмотреть, что увидит агент, прежде чем просить его что-то сделать», -
 * но снимок читался по кнопке, а не сам, так что почти всё время колонка держала пустой прямоугольник с
 * надписью «Not read yet». Целая колонка на широком окне под кнопку, которую нажимают редко.
 *
 * ЧТО ЗДЕСЬ ТЕПЕРЬ. То, за чем на эту страницу возвращаются: что уже просили и чем это кончилось. Раньше
 * это жило свёрнутой строкой над полем ввода («12 earlier runs on this account») - то есть за кликом, над
 * лентой, где ему приходилось соревноваться за место с тем, что происходит сейчас. В колонке оно видно
 * сразу и не мешает.
 *
 * СПИСОК, А НЕ ЛЕНТА. Двадцать четыре ремa - это не ширина разговора: полные реплики здесь ломались бы по
 * два слова в строку. Поэтому строка списка несёт цель, время и исход, а всё остальное - слова прогона,
 * его шаги, итог и обе кнопки - раскрывается на месте, по одной строке за раз. Ровно тот же приём, что у
 * частей сессии на странице Record.
 *
 * НИЧЕГО СВОЕГО. Ни запроса, ни состояния, ни кэша: строки приезжают с аккаунта через AccountProvider, а
 * правила чтения - из run-history.ts, общие с лентой для узкого окна. Разойтись нечему.
 */
import { useMemo, useState } from 'react';
import { History, RotateCcw, Search, Sparkles } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { StepLine } from '@/components/chat';
import type { Flow, Run } from '@/lib/api';
import { type DictatedRun, hasSkillForRun } from '@/features/record/save-as-skill';
import { asDid, describe } from './describe';
import { dictatedFrom, goalRuns, provable, stepsOf, took, when, wordsOf } from './run-history';

/* Поиск появляется, когда без него становится трудно. Поле над тремя строками - это мебель. */
const SEARCH_FROM = 7;

/** Цвет исхода. Точка, а не плашка: в строке из двух строчек плашка забирает всю ширину. */
const dotFor = (outcome: Run['outcome']) =>
  outcome === 'ok' ? 'bg-fb-green' : outcome === 'running' ? 'bg-fb-attention' : 'bg-fb-red';

export const EarlierPanel = ({ runs, flows, hide, onAskAgain, onSaveAsSkill }: {
  runs: Run[];
  flows: Flow[];
  /** Прогоны, уже показанные живьём в этой сессии. Один прогон дважды - это не история. */
  hide: Set<string>;
  onAskAgain: (goal: string) => void;
  onSaveAsSkill: (run: DictatedRun, goal: string) => void;
}) => {
  const [open, setOpen] = useState<string | null>(null);
  const [needle, setNeedle] = useState('');

  const mine = useMemo(() => goalRuns(runs, hide), [runs, hide]);
  const found = useMemo(() => {
    const q = needle.trim().toLowerCase();
    if (!q) return mine;
    return mine.filter((r) => (r.goal ?? '').toLowerCase().includes(q));
  }, [mine, needle]);

  return (
    <aside className="flex max-h-full flex-col rounded-xl border-stroke border bg-surface-card">
      <div className="flex items-center gap-2 px-3.5 pt-3.5 pb-2">
        <History className="size-4 shrink-0 text-ink-inactive" />
        <Typography variant="span" className="text-[0.7rem] uppercase tracking-wide text-ink-inactive">
          Earlier
        </Typography>
        <Typography variant="span" className="ms-auto text-[0.76rem] text-ink-inactive tabular-nums">
          {mine.length} run{mine.length === 1 ? '' : 's'}
        </Typography>
      </div>

      {mine.length >= SEARCH_FROM && (
        <div className="relative px-3.5 pb-2">
          <Search className="absolute left-5.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-inactive" />
          <input
            value={needle}
            onChange={(ev) => setNeedle(ev.target.value)}
            placeholder="Search what you asked for…"
            aria-label="Search earlier runs"
            className={cn(
              'w-full rounded-md border-stroke border bg-surface-card2 py-1.5 pl-7 pr-2 text-[0.82rem]',
              'text-ink-primary placeholder:text-ink-inactive focus:outline-none',
              'focus:border-brand-primary/60',
            )}
          />
        </div>
      )}

      {/* Свой скроллер, чтобы длинная история не тянула колонку. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!mine.length ? (
          /* Пусто - это состояние, а не ошибка, и сказать надо, чем оно кончится. */
          <Typography variant="p" className="px-1.5 py-2 text-ink-inactive text-[0.8rem]">
            Nothing here yet. What you ask for on this page is recorded on your account, and shows up here
            afterwards — including the button that turns a run that worked into a skill.
          </Typography>
        ) : !found.length ? (
          <Typography variant="p" className="px-1.5 py-2 text-ink-inactive text-[0.8rem]">
            No earlier run says that.
          </Typography>
        ) : (
          <ul className="flex flex-col">
            {found.map((run) => {
              const showing = open === run.id;
              const steps = stepsOf(run);
              const words = wordsOf(run);
              const note = run.summary ?? run.error ?? null;
              const length = took(run);

              return (
                <li key={run.id} className="border-stroke/40 border-b last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setOpen(showing ? null : run.id)}
                    aria-expanded={showing}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md px-1.5 py-2 text-left transition-colors',
                      'hover:bg-state-hover',
                      showing && 'bg-state-hover',
                    )}
                  >
                    <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', dotFor(run.outcome))} />
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[0.84rem] text-ink-primary">{run.goal}</span>
                      <span className="mt-0.5 block text-[0.74rem] text-ink-inactive tabular-nums">
                        {[when(run.startedAt), length && `took ${length}`,
                          run.outcome === 'running' ? 'never finished' : null]
                          .filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </button>

                  {showing && (
                    /* Отступ и линия слева: раскрытое принадлежит строке над ним, а не панели. Без этого
                     * шаги читались как следующий элемент списка. */
                    <div className="ms-[0.4rem] flex flex-col gap-1 border-stroke/60 border-s ps-2.5 pe-1.5 pb-2.5">
                      {words.map((word, i) => (
                        <StepLine key={`w${i}`} kind="say">{word}</StepLine>
                      ))}

                      {steps.map((step, i) => (
                        <StepLine key={`s${i}`} kind="tool">{describe(asDid(step))}</StepLine>
                      ))}

                      {/* ЧТО СКАЗАТЬ, КОГДА ШАГОВ НЕ ВИДНО - и это три разных случая, а не один.
                        *
                        * Строка может нести шаги чужой формы (так пишет расширение), не нести их вовсе (так
                        * выглядят прогоны, записанные до того, как шаги стали записываться) или не иметь
                        * конца. Пустая карточка во всех трёх случаях говорила бы «ничего не делал» - враньё
                        * про чужую запись, и именно то враньё, которое читают как «продукт потерял мои
                        * данные». */}
                      {!steps.length && (
                        <StepLine kind="waiting">
                          {run.outcome === 'running'
                            ? 'This one never reported that it finished.'
                            : Array.isArray(run.steps) && run.steps.length
                              ? `${run.steps.length} steps, in the browser extension’s own shape — this `
                                + 'page reads the desktop agent’s.'
                              : 'No step-by-step trace was kept for this run.'}
                        </StepLine>
                      )}

                      {note && (
                        <Typography
                          variant="p"
                          className={cn(
                            'mt-0.5 text-[0.82rem]',
                            run.outcome === 'ok' ? 'text-fb-green' : 'text-fb-red-text',
                          )}
                        >
                          {note}
                        </Typography>
                      )}

                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          leftSlot={<RotateCcw className="size-4" />}
                          onClick={() => onAskAgain(run.goal!)}
                        >
                          Ask again
                        </Button>

                        {/* Кнопка, которую уход со страницы когда-то уносил навсегда. Исчезает, когда скилл
                          * уже сделан: второе приглашение сделать то же самое читается как «первое не
                          * сработало». */}
                        {provable(run) && (
                          hasSkillForRun(flows, run.id) ? (
                            <Typography variant="p" className="ms-1 text-ink-inactive text-[0.8rem]">
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
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
};
