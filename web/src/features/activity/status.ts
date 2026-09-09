/* Словарь статусов - одно место, где сказано, каким словом и каким цветом называется то, что стало с работой.
 *
 * ДВА ВОПРОСА НИКОГДА НЕ ДЕЛЯТ ОДИН ЧИП: «довёл ли агент» и «прошёл ли продукт». Поэтому у прогона может
 * быть два чипа рядом - «ok» и «1 check failed», - и это не противоречие, а найденный дефект (см. db/019).
 *
 * Слова - человеческие, а не имена состояний из базы: «could not finish», а не «failed»; «stopped by you», а
 * не «stopped». Человек, читающий страницу в девять утра, не должен переводить.
 *
 * ИСТОЧНИК - ВТОРАЯ ОСЬ, и она не складывается в статус: «by itself, from a schedule» и «ok» это разные факты
 * об одной строке.
 */
import type { LiveJob, Run, Schedule } from '@/lib/api';

export type Tone = 'good' | 'bad' | 'attention' | 'accent' | 'neutral';

export interface Chip {
  label: string;
  tone: Tone;
}

/** Классы чипа по тону - те же, что у Pill и Badge в остальном приложении. */
export const chipClass = (tone: Tone) =>
  tone === 'good' ? 'bg-fb-green/12 text-fb-green'
    : tone === 'bad' ? 'bg-fb-red/15 text-fb-red-text'
      : tone === 'attention' ? 'bg-fb-attention/15 text-fb-attention'
        : tone === 'accent' ? 'bg-brand-primary/12 text-brand-primary'
          : 'bg-surface-chips text-ink-secondary';

/** Точка слева от строки - тот же цвет, что у чипа, чтобы список читался, не читая. */
export const dotClass = (tone: Tone) =>
  tone === 'good' ? 'bg-fb-green'
    : tone === 'bad' ? 'bg-fb-red-text'
      : tone === 'attention' ? 'bg-fb-attention'
        : tone === 'accent' ? 'bg-brand-primary'
          : 'bg-ink-inactive';

/** Был ли последний шаг прогона переносом на другое время. */
const deferredTo = (run: Run): string | null => {
  const steps = Array.isArray(run.steps) ? run.steps as { tool?: unknown; input?: { at?: unknown } }[] : [];
  const last = steps[steps.length - 1];
  if (!last || last.tool !== 'defer_until' || !last.input || typeof last.input.at !== 'string') return null;
  const at = new Date(last.input.at);
  return Number.isNaN(at.getTime()) ? null
    : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/** Чипы прогона из журнала. Первый - исход, дальше - что ещё о нём важно сказать. */
export const runChips = (run: Run): Chip[] => {
  const chips: Chip[] = [];
  const at = deferredTo(run);
  if (at) {
    chips.push({ label: `set aside → ${at}`, tone: 'accent' });
  } else if (run.outcome === 'ok') {
    chips.push({ label: 'ok', tone: 'good' });
  } else if (run.outcome === 'stopped') {
    chips.push({ label: 'stopped by you', tone: 'neutral' });
  } else if (run.outcome === 'running') {
    chips.push({ label: 'never finished', tone: 'neutral' });
  } else {
    chips.push({ label: 'could not finish', tone: 'bad' });
  }
  /* Проверки - отдельным чипом, и провал красным даже у зелёного прогона: это и есть найденный дефект. */
  const checks = run.checks;
  if (checks) {
    if (checks.failed > 0) chips.push({ label: `${checks.failed} check${checks.failed === 1 ? '' : 's'} failed`, tone: 'bad' });
    else if (checks.unchecked > 0 && !checks.passed) chips.push({ label: `${checks.unchecked} unchecked`, tone: 'attention' });
    else chips.push({ label: `${checks.passed} check${checks.passed === 1 ? '' : 's'}`, tone: 'good' });
  }
  return chips;
};

/** Чип работы из очереди, которая прогоном не стала (или ещё не стала). */
export const jobChip = (job: LiveJob): Chip =>
  job.state === 'claimed' ? { label: 'running', tone: 'attention' }
    : job.state === 'queued' ? { label: 'queued', tone: 'neutral' }
      : job.state === 'cancelled' ? { label: 'cancelled · never ran', tone: 'neutral' }
        : job.state === 'done' && job.ok ? { label: 'ok', tone: 'good' }
          : { label: 'could not start', tone: 'bad' };

/** Чип расписания, которое ждёт своего часа. */
export const scheduleChip = (one: Schedule): Chip =>
  one.paused ? { label: `paused${one.pausedWhy ? ` · ${one.pausedWhy}` : ''}`, tone: 'neutral' }
    : { label: 'scheduled', tone: 'accent' };

/** Откуда пришла работа - вторая ось, и она не складывается в статус. */
export const sourceOf = (run: Run, job?: LiveJob | null): string => {
  if (job) return job.source ?? (job.scheduleId ? 'schedule' : 'chat');
  if (run.extension === 'cloud') return 'chat';
  if (run.extension) return 'extension';
  return 'you';
};

/** Тон точки у строки прогона - по первому чипу. */
export const runTone = (run: Run): Tone => runChips(run)[0].tone;
