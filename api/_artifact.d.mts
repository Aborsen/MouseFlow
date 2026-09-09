/* Types for the browser half. The module itself is dependency-free JavaScript shared with the server,
 * exactly like _brain.mjs, _schedule.mjs and _expect.mjs; this file exists so the web build can type it. */

export const ARTIFACT_MAX_BYTES: number;
export const ARTIFACTS_PER_RUN: number;
export const ARTIFACT_KEEP_DAYS: number;
/** Kinds, most-worth-keeping first — the order `dropWhich` throws things away by. */
export const KINDS: string[];

export function artifactId(): string;
/** A sentence when the frame is over the cap, null when it fits. Never silently downscales. */
export function tooBig(bytes: string | number): string | null;
/** Which ids to delete when a run is over its cap: oldest PASSING checks first, failures last. */
export function dropWhich(
  have: { id: string; kind: string; step_no: number }[] | unknown,
  adding?: number,
): string[];
/** 'failure' if any assertion in the turn failed, else 'check'. */
export function kindOf(verdicts: { pass: boolean | null }[] | unknown): string;
/** What the turn proved, in the words a person reads under the thumbnail. */
export function saidOf(verdicts: { pass: boolean | null; evidence?: string }[] | unknown): string;
