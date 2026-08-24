export interface TypingVerdict { field: boolean; sure: boolean; why: string }
export interface TypingLike { control?: string | null; role?: string | null; keys?: number }

export function classifyTyping(step: TypingLike, windowTitle?: string | null): TypingVerdict;
export function splitTyping<T extends TypingLike>(
  steps: T[],
  windowTitleFor?: (step: T) => string | null,
): { fields: (T & { verdict: TypingVerdict })[]; aside: (T & { verdict: TypingVerdict })[] };
