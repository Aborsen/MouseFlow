/* Types for the browser half. The module itself is dependency-free JavaScript shared with the server,
 * exactly like _brain.mjs, _schedule.mjs and _expect.mjs; this file exists so the web build can type it.
 * Change it in the same commit as _case.mjs - a type that lags the module is a lie the compiler enforces. */

import type { Want } from './_expect.d.mts';

export const CASE_KEY: string;
export const EXPECTS_MAX: number;

/** What a case asserts. The same shape the `expect` tool takes - deliberately one language, not two. */
export interface Expect extends Want {
  process?: string | null;
}

/** The four outcomes of a case run. `blocked` is not a red: it means nothing was proven. */
export type Verdict = 'pass' | 'pass_with_repairs' | 'fail' | 'blocked';

export function readExpects(input: unknown): { expects: Expect[]; why: string };
export function expectLine(want: unknown): string;
export function caseGoal(goal: string, expects: unknown): string;
export function stripCase(args: unknown): Record<string, unknown>;
export function caseIdOf(args: unknown): string | null;
export function repairsOf(steps: unknown): number;
export function caseVerdict(run: {
  outcome?: string | null;
  checks?: { passed: number; failed: number; unchecked: number } | null;
  /** The run's steps, when the caller has them. */
  steps?: unknown;
  /** Or just the count of repaired steps, when it was cheaper to ask the database for the number. */
  repairs?: number | null;
} | null): Verdict;
export const VERDICTS: Record<Verdict, { word: string; why: string }>;
export function verdictSaid(verdict: string): string;
export function tallyOf(verdicts: unknown): Record<Verdict, number>;
