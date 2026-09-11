/* Types for the browser half. The module itself is dependency-free JavaScript shared with the server,
 * exactly like _expect.mjs and _schedule.mjs; this file exists so the web build can type it. */

export const PROVENANCE: ('derived' | 'taught' | 'learned' | 'builtin')[];
export const PROVENANCE_RULES: Record<'derived' | 'taught' | 'learned' | 'builtin', { recomputable: boolean; approval: boolean }>;
export const KEY_BUDGET: number;
export const MAX_KEYS_PER_TURN: number;
export const MAX_NAME_LENGTH: number;

export interface MemoryKey {
  platform: 'win32' | 'darwin' | 'web';
  id: string;
}

export interface MemoryEntry {
  key: string;
  provenance: 'derived' | 'taught' | 'learned' | 'builtin';
  body: string;
  version?: number | null;
  runId?: string | null;
  state?: 'pending' | 'live' | 'rejected' | null;
  createdAt?: string | null;
}

export interface BuiltinEntry {
  scope: 'platform:win32' | 'platform:darwin' | 'self';
  body: string;
  enforcedIn: string;
  provenance: 'builtin';
}

export function parseKey(key: string): MemoryKey | null;
export function webKeyFor(url: string): string | null;

export function redactionProblem(input: { body?: string | null; name?: string | null; secret?: boolean }): string | null;

export function writeMemory(input: {
  key: string;
  provenance: 'derived' | 'taught' | 'learned';
  body: string;
  name?: string | null;
  secret?: boolean;
  version?: number | null;
  runId?: string | null;
}):
  | { ok: true; entry: MemoryEntry }
  | { ok: false; why: string };

export function fitBlock(entries: MemoryEntry[] | null | undefined, budget?: number): {
  text: string;
  used: number;
  evicted: MemoryEntry[];
};

export function builtinEntries(): BuiltinEntry[];
