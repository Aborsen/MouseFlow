export interface ComposeStep { n: number; instruction: string }
export interface Inserted { after: number; instruction: string; from: string }
export interface Conflict {
  /** The recording's own step number. */
  n: number;
  note: string;
  why: string;
  /** Where that step ended up in the renumbered goal, which is the numbering on screen. */
  at: number | null;
  instruction: string;
}
export interface Unplaced { note: string; why: string }
export interface Applied {
  text: string;
  lines: { instruction: string; from: 'recorded' | 'yours' }[];
  inserted: Inserted[];
  conflicts: Conflict[];
  unplaced: Unplaced[];
}

export const MAX_STEPS: number;
export const MAX_NOTES: number;
export const SYSTEM: string;
export const PLAN_TOOL: { name: string; description: string; schema: Record<string, unknown> };

export function promptFor(input: { steps: ComposeStep[]; notes: string }):
  { system: string; user: string; dropped: number };
export function applyPlan(
  input: { steps: ComposeStep[]; opening?: string },
  plan: unknown,
): Applied;
