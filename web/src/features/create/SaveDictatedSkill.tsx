/* Сохранить надиктованный флоу как скилл — после того, как он отработал.
 *
 * ПОЧЕМУ ЭТО НЕ ВИЗАРД. Визард записи существует, чтобы из сотен событий собрать предложение: там есть что
 * выбирать, и первый его шаг — выбор. Здесь предложение уже написано человеком, шагов на выбор нет, и экран
 * с одним лишь текстом «выберите шаги» был бы страницей без работы. Общее у них — то, что сохраняется:
 * saveDictatedAsGoalSkill складывает ровно тот же скилл-цель, что и визард, и запускается он тем же путём.
 *
 * ПАРАМЕТРЫ ВИДНО, ПОКА ПИШЕШЬ. Подстановка в целях — это `{{имя}}`, так читает fillGoal. Соглашение,
 * спрятанное в документации, — это соглашение, о котором никто не узнает, поэтому список под полем считается
 * из текста на каждый набранный символ: написал {{recipient}} — он тут же появился. Ничего не угадывается за
 * человека: параметров нет ровно тогда, когда он их не написал.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { Said } from '@/components/Said';
import {
  type DictatedRun, type GoalParam, saveDictatedAsGoalSkill,
} from '@/features/record/save-as-skill';

/* Имена подстановок в порядке появления, без повторов.
 *
 * Порядок — авторский, а не алфавитный: список читается рядом с текстом, где они стоят, и переставленный
 * читался бы как чужой. */
export function paramsIn(goal: string): string[] {
  const found: string[] = [];
  for (const [, name] of goal.matchAll(/\{\{\s*([A-Za-z][\w-]{0,39})\s*\}\}/g)) {
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/* Умолчание для имени, не алгоритм имени.
 *
 * extension/skills.js умеет suggestName(), но он живёт на другой стороне и в веб-сборку не входит - а
 * переписать его здесь значило бы завести второе определение того, как называется скилл, и однажды они
 * разойдутся. Первая строка цели - это не догадка, это то, что человек уже написал; и он её тут же правит. */
const firstLineOf = (goal: string) => {
  const line = goal.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return (line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line) || 'Dictated flow';
};

interface Props {
  run: DictatedRun;
  /** Ровно то, что было надиктовано. Правится свободно — но начинается с того, что человек уже сказал. */
  goal: string;
  onClose: () => void;
  onSaved: (name: string) => void;
}

export const SaveDictatedSkill = ({ run, goal: dictated, onClose, onSaved }: Props) => {
  const [goal, setGoal] = useState(dictated);
  const [name, setName] = useState(() => firstLineOf(dictated));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const params = useMemo(() => paramsIn(goal), [goal]);
  const ready = name.trim() !== '' && goal.trim() !== '' && !saving;

  const save = async () => {
    setSaving(true);
    setProblem(null);
    try {
      await saveDictatedAsGoalSkill(run, {
        name: name.trim(),
        goal: goal.trim(),
        /* `quoted` и без примера: подстановка в надиктованном тексте — это значение, которое спрашивают
         * каждый раз. Пример — личное значение автора, и подставлять его молча за него нельзя. */
        params: params.map((p): GoalParam => ({ name: p, type: 'quoted', example: null })),
      });
      onSaved(name.trim());
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'It could not be saved.');
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55" />
        <Dialog.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex w-[min(640px,calc(100vw-2rem))] -translate-x-1/2',
            '-translate-y-1/2 flex-col overflow-hidden rounded-xl border border-stroke bg-surface-card',
            'shadow-dropdown',
          )}
        >
          <header className="flex items-start gap-3 border-stroke border-b px-4 py-3">
            <Dialog.Title asChild>
              <Typography variant="h2" weight="semibold" className="min-w-0 flex-1 text-[1rem]">
                Save this flow as a skill
              </Typography>
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="xs" aria-label="Close"><X className="size-4" /></Button>
            </Dialog.Close>
          </header>

          <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-4 py-4">
            <Typography variant="p" className="max-w-[64ch] text-ink-secondary text-[0.86rem]">
              It ran once and finished, so this is a skill that has been proved rather than promised. It will
              be carried out the same way it just was — the agent reads the screen and decides each step.
            </Typography>

            <label className="flex flex-col gap-1.5">
              <Typography variant="span" className="text-ink-body text-[0.86rem]">Name</Typography>
              <input
                value={name}
                onChange={(ev) => setName(ev.target.value.slice(0, 80))}
                className={cn(
                  'rounded-md border-stroke border bg-surface-card2 px-2.5 py-2 text-[0.9rem]',
                  'text-ink-primary',
                )}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <Typography variant="span" className="text-ink-body text-[0.86rem]">
                What it will do — edit it freely, this is what the skill carries out
              </Typography>
              <textarea
                value={goal}
                onChange={(ev) => setGoal(ev.target.value)}
                rows={7}
                className={cn(
                  'resize-y rounded-md border-stroke border bg-surface-card2 px-2.5 py-2',
                  'font-mono text-[0.84rem] text-ink-primary',
                )}
              />
            </label>

            <div className="flex flex-col gap-1.5">
              <Typography variant="span" className="text-ink-body text-[0.86rem]">
                Asks for
              </Typography>
              {params.length === 0 ? (
                <Typography variant="p" className="max-w-[64ch] text-ink-inactive text-[0.82rem]">
                  Nothing — it runs exactly as written. To have it ask for something each time, put the name
                  in double braces where the value belongs: <code className="font-mono">{'{{recipient}}'}</code>.
                </Typography>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5">
                  {params.map((p) => (
                    <span
                      key={p}
                      className="rounded-full border border-stroke px-2 py-0.5 font-mono text-[0.76rem] text-ink-body"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <Said note={problem ? { text: problem, kind: 'bad' } : null} variant="inline" />
          </div>

          <footer className="flex items-center justify-end gap-2 border-stroke border-t px-4 py-3">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={() => void save()} disabled={!ready}>
              {saving ? 'Saving…' : 'Save the skill'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
