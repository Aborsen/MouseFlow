/* Как выглядит проверка в истории прогона.
 *
 * ОДНО МЕСТО НА ДВА СПИСКА. Шаги прогона рисуют и панель истории справа (EarlierPanel), и полоса «сделано
 * раньше» над лентой (Earlier) - через один и тот же `describe`. Цвет исхода обязан быть общим по той же
 * причине: две копии правила «FAIL красный, CANNOT жёлтый» разошлись бы первым же изменением, и один из
 * двух списков однажды покрасил бы непроверенное зелёным.
 *
 * ТРИ ИСХОДА, А НЕ ДВА - и это не стиль, а тот же принцип, что у флагов агента и у `#ctx`: «проверить не
 * удалось» это не «не прошло». Прогон, у которого пять проверок и все они CANNOT, зелёным быть не должен
 * ни на одном экране.
 */
import type { ReactNode } from 'react';

/** Шаг, каким он лежит в user_run.steps. Форма чужого драйвера сюда тоже попадает - отсюда unknown. */
type Step = { tool?: unknown; outcome?: unknown } | unknown;

const outcomeOf = (step: Step): { pass: boolean | null; how?: string; evidence?: string } | null => {
  const it = step as { tool?: unknown; outcome?: unknown } | null;
  if (!it || it.tool !== 'expect' || !it.outcome || typeof it.outcome !== 'object') return null;
  const out = it.outcome as { pass?: unknown; how?: unknown; evidence?: unknown };
  return {
    pass: out.pass === true ? true : out.pass === false ? false : null,
    how: typeof out.how === 'string' ? out.how : undefined,
    evidence: typeof out.evidence === 'string' ? out.evidence : undefined,
  };
};

/** Какого вида строка. Обычный шаг остаётся `tool`, чтобы ничего, кроме проверок, не поменяло вид. */
export const verdictKind = (step: Step): 'tool' | 'pass' | 'fail' | 'unchecked' => {
  const out = outcomeOf(step);
  if (!out) return 'tool';
  return out.pass === true ? 'pass' : out.pass === false ? 'fail' : 'unchecked';
};

/**
 * Доказательство, дописанное к строке проверки.
 *
 * Именно доказательство, а не «прошло»: строка «check that "Send" is there — button "Send" at 1074,159
 * (tree)» проверяема через неделю, а «PASS» надо перепроверять с нуля. Уровень назван в скобках, потому что
 * `tree` и `picture` это разной силы утверждения об одном и том же.
 */
export const evidenceOf = (step: Step): ReactNode => {
  const out = outcomeOf(step);
  if (!out || !out.evidence) return null;
  return ` — ${out.evidence}${out.how ? ` (${out.how})` : ''}`;
};
