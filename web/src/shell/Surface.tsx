/* Where a screen is being rendered, and therefore what page chrome it gets.
 *
 * WHY THIS EXISTS. Five screens are rendered in two places: as routes in the app, and inside the
 * extension's side panel, which is 400px wide and can be dragged down to 320.
 *
 * As a route a screen IS the page. AppLayout's <main> is a bare box on purpose - no padding, no scroller -
 * so every view opens with `p-5` and the dashboard, which has an assistant column that must not move,
 * opens with a height of its own. That is the app's convention and it is right there.
 *
 * In the panel it is wrong four times over. Panel.tsx's <main> already pads and already scrolls, so the
 * same `p-5` is 40px of a 400px width spent on nothing (measured: the gallery's cards had 196px of a 320px
 * panel to live in, and 64px of it was two paddings); the view's own `overflow-y-auto` is a second
 * scrollbar inside the first; and a full-window height claims the space of a top bar the panel does not
 * have.
 *
 * WHY NOT `if (inExtension)` IN FIVE FILES. Because then five files have to know where they are, and the
 * sixth one added will not. Here the surface is declared once, by whoever mounts the screens, and a screen
 * only ever asks what chrome it should wear.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { cn } from '@insightis/ui/cn';

export type Surface = 'app' | 'panel';

/* 'app' by default, so a screen rendered with no provider above it is a page - which is what every route
 * is, and what every test and story gets without arranging anything. Only the panel says otherwise. */
const SurfaceContext = createContext<Surface>('app');

export const SurfaceProvider = ({ value, children }: { value: Surface; children: ReactNode }) => (
  <SurfaceContext.Provider value={value}>{children}</SurfaceContext.Provider>
);

export const useSurface = () => useContext(SurfaceContext);

/* The height of AppLayout's top bar - the one number a full-height screen has to subtract - and it is
 * spelt out rather than composed from a constant on purpose: Tailwind finds classes by SCANNING this file
 * as text, so a height built by interpolating a constant into a template literal is a class that is never
 * generated and a rule that silently does nothing. Written whole it is still in ONE place, which was the
 * point: three screens used to carry their own copy of this number.
 *
 * И ЧИСЛО ТЕПЕРЬ ВЕРНОЕ, потому что шапка его ОБЪЯВЛЯЕТ, а не складывает. Здесь стояло 3.25rem, а шапка со
 * своим padding'ом и своей кнопкой выходила 65px - разница в тринадцать пикселей, которую было видно снизу:
 * правая колонка на Create уезжала под нижний край окна вместе со своим нижним отступом, так что сверху
 * зазор был, а снизу нет. Само число почини́ть было мало - оно снова разошлось бы, как только в шапку
 * положат что-нибудь повыше, - поэтому у шапки теперь `h-16`, ровно эти 4rem, и складываться там нечему.
 *
 * ПОЧЕМУ НЕ `flex-1` ВМЕСТО ЧИСЛА. Пробовал: оболочка - `min-h-screen`, то есть высота у неё не заданная, а
 * не меньше экрана. Внутри такой высоты `flex-1` ничего не ограничивает - контейнер просто вырастает под
 * содержимое, - и Dashboard, который до этого держался ровно в окне, стал длиной 2057px и потянул за собой
 * скролл всего документа. Заданная высота у шапки решает то же самое, ничего не ломая. */
const APP_PAGE_HEIGHT = 'h-[calc(100dvh-4rem)]';

export interface PageChrome {
  /** The page gutter. Empty on a surface that has already padded us. */
  gutter: string;
  /** A page that fills the window and scrolls inside itself, for a screen with a column that must not move. */
  height: string;
  /** The scroller that goes with `height`. Empty where the surface owns the scrolling. */
  scroll: string;
}

/** What page chrome this surface expects a screen to wear. */
export const usePageChrome = (): PageChrome => (
  useSurface() === 'app'
    ? { gutter: 'p-5', height: APP_PAGE_HEIGHT, scroll: 'overflow-y-auto' }
    : { gutter: '', height: '', scroll: '' }
);

/** A screen's outermost box: the gutter this surface wants, and nothing else that isn't asked for. */
/* `column` УБРАН, а не оставлен на будущее. Он центрировал страницу в 1180px «для экрана, чьи абзацы иначе
 * растянутся на всю ширину», и им пользовалась одна страница - Teams, - из-за чего она выглядела рядом с
 * остальными как другой продукт. Читаемость абзацев держит их собственный max-w в символах, а не обёртка
 * всей страницы: заголовок, таблица и кнопки от неё только теряют.
 *
 * Проп, у которого не осталось ни одного вызова, - это приглашение снова разъехаться. */
export const Page = ({ children, className }: {
  children: ReactNode;
  className?: string;
}) => {
  const { gutter } = usePageChrome();
  return <div className={cn(gutter, className)}>{children}</div>;
};
