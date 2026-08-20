/* Chat furniture, following insightis/apps/web's chat feature.
 *
 * Their chat components could not be vendored: they are bound to their own backend (99 imports from
 * @insightis/ui, but also @insightis/api, react-i18next, tiptap, framer-motion, metric mentions, artifact
 * panels). None of that has a counterpart here. What IS reusable is the vocabulary, and since we render on
 * the same design system it comes out looking like theirs:
 *
 *   a user turn      right-aligned bubble, rounded-2xl with the corner nearest the sender squared off,
 *                    bg-state-hover / text-content-on-solid
 *   an assistant turn full-width card, rounded-2xl with rounded-bl-none, border-stroke on surface-card
 *   the composer     rounded-2xl, translucent surface-card with a blur behind it, and a border that lifts
 *                    on focus-within rather than on the textarea itself
 *   suggestions      small ghost buttons with a muted leading glyph
 *
 * Two deliberate departures. Theirs centres the thread on `max-w-chat-container`, a token defined in their
 * app's own tailwind config rather than in the design-system package we vendored, so the width is stated
 * here instead of inventing a token that would drift. And their composer floats over a scrolling thread with
 * a fade; ours is a flex row, because this composer carries controls (which half runs the goal) and hiding
 * them behind a scroll position would be worse than the loss of the effect.
 */
import { cn } from '@insightis/ui/cn';
import { Typography } from '@insightis/ui/Typography';
import type { ReactNode } from 'react';

/** The reading column. Wide enough for a paragraph, narrow enough to read - theirs is the same idea. */
export const THREAD_WIDTH = 'mx-auto w-full max-w-[46rem]';

export const Thread = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn('flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-6', className)}>
    <div className={cn(THREAD_WIDTH, 'flex flex-col gap-4')}>{children}</div>
  </div>
);

/** What the person asked for. */
export const UserTurn = ({ children, meta }: { children: ReactNode; meta?: ReactNode }) => (
  <div className="flex flex-col items-end gap-1">
    <div
      className={cn(
        'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-none px-3.5 py-2.5 md:max-w-[75%]',
        'bg-state-hover text-content-on-solid',
      )}
    >
      {children}
    </div>
    {meta && <span className="text-[0.72rem] text-ink-inactive">{meta}</span>}
  </div>
);

/** What happened as a result: a card rather than a bubble, because a run is long and structured. */
export const AgentTurn = ({
  children,
  header,
  meta,
  tone,
}: {
  children?: ReactNode;
  header?: ReactNode;
  meta?: ReactNode;
  /** Colours the left edge only. A whole card tinted red reads as an error page rather than a step log. */
  tone?: 'running' | 'ok' | 'failed';
}) => (
  <div className="flex flex-col items-start gap-1">
    <div
      className={cn(
        'flex w-full flex-col gap-2 rounded-2xl rounded-bl-none border border-stroke bg-surface-card px-4 py-3.5',
        tone === 'running' && 'border-l-2 border-l-brand-primary',
        tone === 'ok' && 'border-l-2 border-l-fb-green',
        tone === 'failed' && 'border-l-2 border-l-fb-red',
      )}
    >
      {header}
      {children}
    </div>
    {meta && <span className="text-[0.72rem] text-ink-inactive">{meta}</span>}
  </div>
);

/* The composer. A shell rather than a control: what goes inside it differs per screen - this one carries a
 * choice of executor, the history chat carries a model picker - and the shell is what makes them look like
 * one product. */
export const Composer = ({
  children,
  footer,
  hint,
}: {
  children: ReactNode;
  footer?: ReactNode;
  /* Справка, а не управление: она стоит ПОД карточкой мелким шрифтом. Внутри строки управления она отнимала
   * место у кнопок и сталкивала их на второй ряд - справка, описывающая кнопку, не должна её выдавливать. */
  hint?: ReactNode;
}) => (
  <div className="shrink-0 px-4 pb-5">
    <div className={THREAD_WIDTH}>
      <div
        className={cn(
          'flex flex-col gap-2 rounded-2xl border border-stroke p-2.5',
          'bg-surface-card/[0.72] backdrop-blur-[10px]',
          'focus-within:border-input-focus [&:hover:not(:focus-within)]:border-stroke-field-hover',
        )}
      >
        {children}
        {/* `flex-nowrap` до `sm`, потому что в этой строке теперь только управление, и разъезжаться ему не
          * на чем - а перенос как раз и был тем, из-за чего кнопка уезжала под поле. */}
        {footer && <div className="flex flex-wrap items-center gap-2">{footer}</div>}
      </div>
      {hint && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[0.74rem] text-ink-inactive">
          {hint}
        </div>
      )}
    </div>
  </div>
);

/** A two-way switch, the shape the settings screens already use for theme. */
export const Segmented = <T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { id: T; label: string; title?: string }[];
  onChange: (id: T) => void;
  disabled?: boolean;
}) => (
  <div className="flex gap-0.5 rounded-md border border-stroke bg-surface-card2 p-0.5">
    {options.map((option) => (
      <button
        key={option.id}
        type="button"
        disabled={disabled}
        title={option.title}
        onClick={() => onChange(option.id)}
        className={cn(
          'rounded-[5px] px-2.5 py-1 text-[0.8rem] text-ink-secondary hover:text-ink-primary',
          value === option.id && 'bg-surface-card font-semibold text-ink-primary shadow-rest',
          disabled && 'cursor-not-allowed opacity-disabled hover:text-ink-secondary',
        )}
      >
        {option.label}
      </button>
    ))}
  </div>
);

/** Where a thread starts: a line about what this screen does, and things worth asking it. */
export const Opener = ({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children?: ReactNode;
}) => (
  <div className="flex flex-1 flex-col justify-center gap-3 py-8">
    <Typography variant="h2" weight="semibold" className="text-[1.35rem]">
      {title}
    </Typography>
    <Typography variant="p" className="max-w-[58ch] text-ink-secondary">
      {note}
    </Typography>
    {children && <div className="mt-1 flex flex-wrap gap-2">{children}</div>}
  </div>
);

/** A suggestion, in their shape: small, quiet, and it fills the composer rather than sending. */
export const Suggestion = ({
  children,
  icon,
  onClick,
}: {
  children: ReactNode;
  icon?: ReactNode;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'inline-flex h-[2.125rem] items-center gap-2 rounded-md border border-stroke px-3.5',
      'text-[0.8125rem] text-ink-body hover:bg-state-hover hover:text-ink-primary',
      '[&_svg]:size-3.5 [&_svg]:text-ink-secondary',
    )}
  >
    {icon}
    {children}
  </button>
);

/** One line of a run: what it did, in the terms somebody debugging afterwards would want. */
export const StepLine = ({
  kind,
  children,
}: {
  kind: 'tool' | 'say' | 'error' | 'wave' | 'handoff' | 'waiting';
  children: ReactNode;
}) => (
  <div
    className={cn(
      'text-[0.85rem]',
      kind === 'tool' && 'font-mono text-[0.8rem] text-ink-secondary',
      kind === 'say' && 'text-ink-body',
      kind === 'error' && 'text-fb-red-text',
      kind === 'waiting' && 'text-ink-inactive',
      kind === 'wave' && 'mt-1 border-stroke border-t pt-2 font-semibold text-ink-primary',
      kind === 'handoff' && 'border-brand-primary border-l-2 bg-surface-accent px-2 py-1 text-ink-secondary',
    )}
  >
    {children}
  </div>
);
