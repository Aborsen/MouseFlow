export interface TypingVerdict { field: boolean; sure: boolean; why: string }
export interface TypingLike {
  control?: string | null;
  role?: string | null;
  keys?: number;
  /** Present on a step the recorder could name; `splitTyping` reads it off the NEXT entry. */
  action?: string;
  pressed?: string | null;
}

/**
 * @param committedBy the key pressed immediately after this run, when it had a name. Return or Tab makes
 *   the run a field as a matter of fact rather than of guesswork - which is the only evidence available on
 *   Windows, whose agent writes no accessibility role.
 */
export function classifyTyping(
  step: TypingLike,
  windowTitle?: string | null,
  committedBy?: string | null,
): TypingVerdict;
export function splitTyping<T extends TypingLike>(
  steps: T[],
  windowTitleFor?: (step: T) => string | null,
): { fields: (T & { verdict: TypingVerdict })[]; aside: (T & { verdict: TypingVerdict })[] };
