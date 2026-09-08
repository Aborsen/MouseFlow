/* Types for the browser half. The module itself is dependency-free JavaScript shared with the server,
 * exactly like _brain.mjs and _schedule.mjs; this file exists so the web build can type it. */

export const CHECKS: string[];
export const TIERS: string[];

export interface Want {
  check: string;
  name: string;
  text?: string | null;
  why?: string | null;
}

export interface Verdict {
  /** true passed, false failed, **null could not be checked** — three outcomes, never two. */
  pass: boolean | null;
  how: string;
  evidence: string;
}

export interface Found {
  kind: 'one' | 'several' | 'none' | 'cannot';
  why: string;
  count?: number;
  role?: string;
  name?: string;
  at?: [number, number];
  size?: [number, number];
  value?: string | null;
  secret?: boolean;
  enabled?: boolean;
}

export function readFound(output: string | undefined | null): Found;
export function judge(want: Want, output?: string, isError?: boolean): Verdict;
export function expectSaid(want: Want, result: Verdict): string;
export function checksOf(
  steps: { tool: string; outcome?: Verdict }[] | unknown,
): { passed: number; failed: number; unchecked: number; tiers: Record<string, number> } | null;
