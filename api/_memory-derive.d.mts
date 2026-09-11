/* Types for the browser half. Dependency-free JavaScript shared with the server, exactly like _memory.mjs;
 * this file exists so the web build can type it. */

export const DERIVE_VERSION: number;
export const TITLE_EDGE_MIN: number;

export interface Touch {
  key: string;
  title: string | null;
  control: string | null;
  near: string | null;
  side: string | null;
}

export function touchesOf(
  flow: { events?: unknown[] } | { payload: { events?: unknown[] } },
  opts?: { platform?: 'win32' | 'darwin' },
): Touch[];

export function deriveEntries(
  touches: Touch[],
  opts?: { version?: number },
): ({ key: string; ok: true; entry: object; seen: number } | { key: string; ok: false; why: string; body?: string; seen: number })[];
