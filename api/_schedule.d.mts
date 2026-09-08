/* Types for the two things the browser driver reads out of _schedule.mjs. The module itself is dependency-free
 * JavaScript shared with the server, exactly like _brain.mjs; this file exists so the web build can type it. */
export const MIN_EVERY_MINUTES: number;
export const MAX_EVERY_MINUTES: number;
export const CATCH_UP_MS: number;
export const DEFER_GRACE_MS: number;
export const FAILS_BEFORE_PAUSE: number;

export function deferInstant(o: { at: unknown; zone?: string | null; nowMs?: number }):
  | { atMs: number; now?: undefined; why?: undefined }
  | { now: true; why: string; atMs?: undefined }
  | { why: string; now?: undefined; atMs?: undefined };

export function clockSaid(utcMs: number, zone: string): string;
export function whenSaid(utcMs: number | null, zone: string): string;
