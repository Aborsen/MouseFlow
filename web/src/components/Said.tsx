/* What just happened, in one line, above the thing it happened to.
 *
 * Eight screens keep a `said` of their own and eight rendered it their own way, which is how one of them
 * ended up being the only one a screen reader announces: the team page wrapped it in `role="status"` and a
 * bordered box, and the skills and gallery pages printed coloured text with no role at all. A person using
 * a reader was told the outcome on one screen out of eight, and nobody chose that either.
 *
 * `role="status"` is the whole reason this is a component: it makes the browser announce the text when it
 * appears, WITHOUT moving focus - which is right for "Deleted 3 skills" and would be wrong for anything
 * that needs answering.
 *
 * Colour is not the message. Red and green carry the tone; the words carry the meaning, and they have to,
 * because a third of people cannot separate those two hues reliably.
 *
 * И ОНО САМО ПОКАЗЫВАЕТСЯ НА ГЛАЗА. Reported: «когда скилл запаблишился - у меня не было уведомления».
 * Уведомление было - вот эта строка, - но живёт она наверху страницы, а кнопку Publish жмут в строке
 * таблицы, до которой пролистали. Сказать человеку об исходе за пределами экрана - это не сказать: он
 * видит только, что ничего не произошло, и жмёт второй раз. Скролл делается ТОЛЬКО когда строка не видна
 * (block: 'nearest'), так что на короткой странице ничего не дёргается; и `role="status"` остаётся тем,
 * чем был - объявляет, не забирая фокус. Прокрутка фокус тоже не забирает.
 */
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@insightis/ui/cn';

export type SaidKind = 'good' | 'bad';
export interface SaidNote { text: string; kind: SaidKind }

export interface SaidProps {
  /** Null renders nothing, so a caller can pass its state straight in. */
  note: SaidNote | null;
  /** `block` is the bordered line above a list; `inline` is the small coloured note that lives inside a
   *  panel, where a box would push the panel's own layout around. Both are announced - the variance is in
   *  how it looks, never in whether a screen reader is told, which is the point of this file. */
  variant?: 'block' | 'inline';
  /** Given, the note can be dismissed; omitted, it stays until the next thing happens. */
  onDismiss?: () => void;
  className?: string;
}

export const Said = ({ note, variant = 'block', onDismiss, className }: SaidProps) => {
  const box = useRef<HTMLDivElement>(null);

  /* На текст, а не на объект: восемь экранов зовут setSaid новым объектом каждый раз, и эффект на `note`
   * прокручивал бы на каждый ререндер. Меняется то, что сказали, - тогда и показываем. */
  const text = note?.text ?? null;
  useEffect(() => {
    if (!text || !box.current) return;
    /* Уже на экране - ничего не делаем: `nearest` прокручивает ровно столько, сколько нужно, и ноль,
     * когда не нужно. Плавно, если человек не просил меньше движения. */
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    box.current.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  }, [text]);

  if (!note) return null;
  return (
    <div
      ref={box}
      role="status"
      className={cn(
        'break-words',
        variant === 'block'
          ? cn(
            'rounded-lg border px-3.5 py-2.5 text-[0.85rem] leading-relaxed',
            note.kind === 'bad'
              ? 'border-fb-red/40 bg-fb-red/5 text-fb-red-text'
              : 'border-fb-green/40 bg-fb-green/5 text-ink-body',
          )
          : cn('text-[0.82rem]', note.kind === 'bad' ? 'text-fb-red-text' : 'text-fb-green'),
        className,
      )}
    >
      {note.text}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="ms-2 align-middle text-ink-inactive hover:text-ink-primary"
        >
          <X className="inline size-3.5" />
        </button>
      )}
    </div>
  );
};
