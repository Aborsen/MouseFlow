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
 * два слова в строку. Поэтому строка списка несёт название, время и исход, а всё остальное - слова
 * прогона, его шаги, итог и кнопки - раскрывается на месте, по одной строке за раз. Ровно тот же приём,
 * что у частей сессии на странице Record.
 *
 * ПЕРЕИМЕНОВАНИЕ НЕ ТРОГАЕТ ЦЕЛЬ. Строка показывает подпись, если её дали, и цель, если нет, - но правится
 * при этом ИМЕННО подпись. Цель - то, что действительно ушло в работу, и то, что пошлёт «Ask again»;
 * дать её переписать значило бы, что строка после правки утверждает, будто запускали не то, что
 * запускали. См. run-history.ts и db/013_run_named.sql.
 *
 * УДАЛЕНИЕ УДАЛЯЕТ. Строка прогона - единственная его запись, других копий нет: удалённый прогон исчезает
 * и отсюда, и из итогов на Dashboard, и из того, что видит ассистент. Поэтому спрашивается дважды - см.
 * ArmedButton - и поэтому же сказано вслух, что уходит.
 *
 * НИЧЕГО СВОЕГО. Ни запроса, ни кэша: строки приезжают с аккаунта через AccountProvider, а правила чтения -
 * из run-history.ts, общие с лентой для узкого окна. Разойтись нечему.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, History, Pencil, RotateCcw, Search, Sparkles, X } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { ArmedButton } from '@/components/ArmedButton';
import { StepLine } from '@/components/chat';
import type { Flow, Run } from '@/lib/api';
import { type DictatedRun, hasSkillForRun } from '@/features/record/save-as-skill';
import { asDid, describe } from './describe';
import { dictatedFrom, goalRuns, provable, stepsOf, titleOf, took, when, wordsOf } from './run-history';

/* Поиск появляется, когда без него становится трудно. Поле над тремя строками - это мебель. */
const SEARCH_FROM = 7;

/* Свёрнута ли секция. Помнится между заходами, как и остальные предпочтения на этой странице: человек,
 * которому история сейчас мешает, не должен сворачивать её каждое утро заново. */
const OPEN_KEY = 'mouseflow.earlier.open';

/** Цвет исхода. Точка, а не плашка: в строке из двух строчек плашка забирает всю ширину. */
const dotFor = (outcome: Run['outcome']) =>
  outcome === 'ok' ? 'bg-fb-green' : outcome === 'running' ? 'bg-fb-attention' : 'bg-fb-red';

export const EarlierPanel = ({ runs, flows, hide, onAskAgain, onSaveAsSkill, onRename, onDelete }: {
  runs: Run[];
  flows: Flow[];
  /** Прогоны, уже показанные живьём в этой сессии. Один прогон дважды - это не история. */
  hide: Set<string>;
  onAskAgain: (goal: string) => void;
  onSaveAsSkill: (run: DictatedRun, goal: string) => void;
  /** Пустое имя стирает подпись и возвращает строке её собственную цель. Бросает, если не записалось. */
  onRename: (id: string, name: string | null) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) => {
  const [shown, setShown] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch (_) { return true; }
  });
  const [open, setOpen] = useState<string | null>(null);
  const [needle, setNeedle] = useState('');
  /** Какую строку сейчас переименовывают, и что набрали. */
  const [naming, setNaming] = useState<{ id: string; text: string } | null>(null);
  /** Взведённая кнопка удаления - одна на список: см. ArmedButton. */
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const showSection = useCallback((on: boolean) => {
    setShown(on);
    try { localStorage.setItem(OPEN_KEY, on ? '1' : '0'); } catch (_) { /* private mode */ }
  }, []);

  const mine = useMemo(() => goalRuns(runs, hide), [runs, hide]);
  const found = useMemo(() => {
    const q = needle.trim().toLowerCase();
    if (!q) return mine;
    /* Ищется и по подписи, и по цели: человек, назвавший прогон «инвойсы», ищет и так, и по словам,
     * которые он на самом деле печатал. */
    return mine.filter((r) => `${r.name ?? ''} ${r.goal ?? ''}`.toLowerCase().includes(q));
  }, [mine, needle]);

  /* Пока идёт запрос, кнопки заняты; когда он кончился - отпускаем. Ошибка называется одной строкой над
   * списком, а не глотается: молчащий отказ здесь выглядит как «удалилось», а строка потом вернётся. */
  const act = useCallback(async (id: string, what: () => Promise<void>) => {
    setBusy(id);
    setProblem(null);
    try {
      await what();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'the account did not take that change');
    } finally {
      setBusy(null);
    }
  }, []);

  /* Правку бросает и Escape, и уход строки из списка - иначе поле осталось бы висеть над чужой строкой. */
  useEffect(() => {
    if (naming && !mine.some((r) => r.id === naming.id)) setNaming(null);
  }, [mine, naming]);

  return (
    <aside className="flex max-h-full flex-col overflow-hidden rounded-xl border-stroke border bg-surface-card">
      {/* Заголовок - он же переключатель. Стрелка слева, потому что она про то, что под ней. */}
      <button
        type="button"
        onClick={() => showSection(!shown)}
        aria-expanded={shown}
        className={cn(
          'flex shrink-0 items-center gap-2 px-3.5 py-3 text-left transition-colors',
          'hover:bg-state-hover',
        )}
      >
        {shown ? <ChevronDown className="size-3.5 shrink-0 text-ink-inactive" />
          : <ChevronRight className="size-3.5 shrink-0 text-ink-inactive" />}
        <History className="size-4 shrink-0 text-ink-inactive" />
        <Typography variant="span" className="text-[0.7rem] uppercase tracking-wide text-ink-inactive">
          Earlier
        </Typography>
        <Typography variant="span" className="ms-auto text-[0.76rem] text-ink-inactive tabular-nums">
          {mine.length} run{mine.length === 1 ? '' : 's'}
        </Typography>
      </button>

      {shown && (
        <>
          {mine.length >= SEARCH_FROM && (
            <div className="relative shrink-0 px-3.5 pb-2">
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

          {problem && (
            <Typography variant="p" className="shrink-0 px-3.5 pb-2 text-fb-red-text text-[0.8rem]">
              {problem}
            </Typography>
          )}

          {/* Свой скроллер, чтобы длинная история не тянула колонку. Отступ снизу тот же, что сверху у
            * заголовка, - иначе последняя строка упирается в край, а первая нет. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {!mine.length ? (
              /* Пусто - это состояние, а не ошибка, и сказать надо, чем оно кончится. */
              <Typography variant="p" className="px-1.5 py-1 text-ink-inactive text-[0.8rem]">
                Nothing here yet. What you ask for on this page is recorded on your account, and shows up
                here afterwards — including the button that turns a run that worked into a skill.
              </Typography>
            ) : !found.length ? (
              <Typography variant="p" className="px-1.5 py-1 text-ink-inactive text-[0.8rem]">
                No earlier run says that.
              </Typography>
            ) : (
              <ul className="flex flex-col">
                {found.map((run) => {
                  const showing = open === run.id;
                  const renaming = naming?.id === run.id;
                  const steps = stepsOf(run);
                  const words = wordsOf(run);
                  const note = run.summary ?? run.error ?? null;
                  const length = took(run);
                  const working = busy === run.id;

                  return (
                    <li key={run.id} className="border-stroke/40 border-b last:border-b-0">
                      {renaming ? (
                        /* Поле стоит НА МЕСТЕ названия, а не в отдельном окне: видно, что именно правится,
                         * и видно строку, которой это название достанется. */
                        <div className="flex items-center gap-1 px-1.5 py-2">
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
                              'min-w-0 flex-1 rounded-md border-brand-primary/60 border bg-surface-card2',
                              'px-2 py-1 text-[0.84rem] text-ink-primary',
                              'placeholder:text-ink-inactive focus:outline-none',
                            )}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label="Save this name"
                            isLoading={working}
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
                            <span className="line-clamp-2 text-[0.84rem] text-ink-primary">
                              {titleOf(run)}
                            </span>
                            <span className="mt-0.5 block text-[0.74rem] text-ink-inactive tabular-nums">
                              {[when(run.startedAt), length && `took ${length}`,
                                run.outcome === 'running' ? 'never finished' : null]
                                .filter(Boolean).join(' · ')}
                            </span>
                          </span>
                        </button>
                      )}

                      {showing && !renaming && (
                        /* Отступ и линия слева: раскрытое принадлежит строке над ним, а не панели. Без
                         * этого шаги читались как следующий элемент списка. */
                        <div className={cn(
                          'ms-[0.4rem] flex flex-col gap-1 border-stroke/60 border-s',
                          'ps-2.5 pe-1.5 pb-2.5',
                        )}>
                          {/* НАЗВАНА - значит цель под ней всё ещё видна. Иначе подпись подменяла бы
                            * собой то, что на самом деле запускали, и «Ask again» посылал бы неожиданное. */}
                          {run.name && run.name.trim() && run.goal && (
                            <Typography variant="p" className="text-ink-inactive text-[0.78rem] italic">
                              asked for: {run.goal}
                            </Typography>
                          )}

                          {words.map((word, i) => (
                            <StepLine key={`w${i}`} kind="say">{word}</StepLine>
                          ))}

                          {steps.map((step, i) => (
                            <StepLine key={`s${i}`} kind="tool">{describe(asDid(step))}</StepLine>
                          ))}

                          {/* ЧТО СКАЗАТЬ, КОГДА ШАГОВ НЕ ВИДНО - и это три разных случая, а не один.
                            *
                            * Строка может нести шаги чужой формы (так пишет расширение), не нести их вовсе
                            * (так выглядят прогоны, записанные до того, как шаги стали записываться) или не
                            * иметь конца. Пустая карточка во всех трёх случаях говорила бы «ничего не
                            * делал» - враньё про чужую запись, и именно то враньё, которое читают как
                            * «продукт потерял мои данные». */}
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

                            {/* Кнопка, которую уход со страницы когда-то уносил навсегда. Исчезает, когда
                              * скилл уже сделан: второе приглашение сделать то же самое читается как
                              * «первое не сработало». */}
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

                            <Button
                              variant="ghost"
                              size="sm"
                              leftSlot={<Pencil className="size-4" />}
                              onClick={() => setNaming({ id: run.id, text: run.name ?? '' })}
                            >
                              Rename
                            </Button>

                            {/* Спрашивает дважды, и вторая надпись говорит, что именно уходит: строка
                              * прогона - единственная его запись, и вместе с ней исчезают и итоги на
                              * Dashboard, и то, что о нём знает ассистент. */}
                            <ArmedButton
                              label="Delete"
                              armedLabel="Delete for good — press again"
                              armed={armed === run.id}
                              busy={working}
                              onArm={() => setArmed(run.id)}
                              onDisarm={() => setArmed((was) => (was === run.id ? null : was))}
                              onConfirm={() => {
                                setArmed(null);
                                void act(run.id, () => onDelete(run.id));
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </aside>
  );
};
