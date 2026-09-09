/* Словарь вердиктов для экрана: слово - из общего модуля, цвет - здесь.
 *
 * СЛОВО НЕ ПЕРЕПИСЫВАЕТСЯ. `VERDICTS` в api/_case.mjs читают сервер, тулы и эта страница; своё слово здесь
 * означало бы, что чат называет ночь одним, а страница другим - и оба уверены в своей правоте. Отсюда
 * берётся только то, чего в общем модуле быть не должно: класс цвета, то есть вещь про экран.
 *
 * И ГЛАВНОЕ: «no verdict» - НЕ КРАСНЫЙ. Ночь, в которую агент не смог открыть приложение, покрашенная
 * наравне с найденным дефектом, - это самый быстрый способ добиться, чтобы отчёт перестали читать. Серый:
 * это «мы не узнали», а не «сломано».
 */
import { VERDICTS, type Verdict } from '../../../../api/_case.mjs';
import { type Tone } from '@/features/activity/status';

export const verdictTone = (verdict: Verdict): Tone =>
  verdict === 'pass' ? 'good'
    : verdict === 'fail' ? 'bad'
      : verdict === 'pass_with_repairs' ? 'attention'
        : 'neutral';

/** Чип вердикта - слово из общего словаря, тон отсюда. */
export const verdictChip = (verdict: Verdict) => ({
  label: VERDICTS[verdict] ? VERDICTS[verdict].word : String(verdict),
  tone: verdictTone(verdict),
});

/** Что этот вердикт значит - строка для подсказки под курсором и для пустого места. */
export const verdictWhy = (verdict: Verdict) => (VERDICTS[verdict] ? VERDICTS[verdict].why : '');
