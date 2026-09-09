/* Types for the browser half. The module itself is dependency-free JavaScript shared with the server,
 * exactly like _brain.mjs, _schedule.mjs and _case.mjs; this file exists so the web build can type it.
 * Change it in the same commit as _anchor.mjs. */

export interface Rect { x: number; y: number; w: number; h: number }

/** What a click remembered about where it landed: its window, and its control when one was named. */
export interface Anchor { win: Rect | null; el: Rect | null }

/** How a replayed point was decided. `raw` is not an error - it is what every recording did before. */
export type How = 'element' | 'window' | 'raw';

export function rectOf(list: unknown): Rect | null;
export function anchorOf(event: unknown): Anchor | null;
export function reanchor(
  event: { x: number; y: number; context?: unknown },
  nowWin: Rect | null | undefined,
  hit?: { x: number; y: number } | null,
): { x: number; y: number; how: How; why: string };
export function anchoredSaid(counts: { element?: number; window?: number; raw?: number } | null): string;

/** One window as `/windows` reports it. Only the fields re-anchoring needs. */
export interface OpenWindow {
  title?: string;
  process?: string;
  minimized?: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/**
 * Which window to raise before a replay: the one the CLICKS name, not the first the sampler saw. The
 * sampler's first window is systematically MouseFlow itself, because that is what is in front when Start
 * is pressed - and raising it made the replay click into MouseFlow.
 */
export function whichWindow(events: unknown): { app: string | null; window: string; n: number } | null;

/** The same window now, or nothing - see the three rungs in _anchor.mjs. */
export function matchWindow(ctx: unknown, list: OpenWindow[] | null | undefined): OpenWindow | null;

/**
 * Re-anchor a whole recording before it is sent to /replay. Events with no window anchor are handed back
 * unchanged and are not counted: a report of hundreds of "played as recorded" moves says nothing.
 */
export function reanchorAll<T extends { x: number; y: number; context?: unknown }>(
  events: T[] | null | undefined,
  list: OpenWindow[] | null | undefined,
): { events: T[]; counts: { window: number; raw: number; moved: number } };
export function whatToFind(events: unknown): {
  app: string | null; window: string | null; control: string; key: string;
}[];
export function findKey(event: unknown): string | null;
