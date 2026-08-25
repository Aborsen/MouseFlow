/* The contract the TypeScript side reads. See api/_brain.mjs for what any of it is for. */

/** Что нужно, чтобы перевести точку на картинке в точку на экране. Больше от снимка мозгу ничего не надо. */
export interface ShotFrame {
  scale: number;
  originX: number;
  originY: number;
}

/** Снимок как его отдаёт агент - ровно то, из чего собирается сообщение с картинкой. */
export interface ShotLike extends ShotFrame {
  png: string;
  format?: string;
  w: number;
  h: number;
}

export interface WindowLike {
  title: string;
  process?: string;
  active?: boolean;
  minimized?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  source?: Record<string, unknown>;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string | Block[];
}

export const WAVE_TURNS: number;
export const MAX_WAVES: number;
export const DEFAULT_SHOT_W: number;
export const MAX_TOKENS: number;
export const SETTLE_MAX_MS: number;
export const SYSTEM: string;
export const TOOLS: Tool[];
export const HANDOFF_ASK: string;
export const HANDOFF_SYSTEM: string;

/** @param success what the author said done looks like, appended to `finish` so it is read when stopping. */
export function toolsFor(gated: boolean, success?: string | null): Tool[];
export function mediaType(said: string | undefined | null): string;
export function actionBody(
  name: string,
  input: Record<string, any>,
  frame: ShotFrame,
): string | null;
export function openList(windows: WindowLike[] | null | undefined): string | null;
export function screenMessage(frame: ShotLike, open: string | null): Message;
export function forgetOldPictures<T extends { content?: unknown }>(messages: T[]): T[];
/** What one action did, in the words both drivers use. `moved === false` means the screen stood still. */
export function actionReport(moved: boolean | undefined): string;
export const STILL_NOTE: string;

export function waitReport(outcome: { quiet?: boolean; waited?: number; quietFor?: number }): string;
export function explainStatus(status: number, stepNo: number, detail: string): string;
export function refusedAt(stepNo: number): string;
export function truncatedAt(stepNo: number): string;
export function outOfWaves(): string;
export function openingMessage(
  goal: string,
  planText: string | null,
  handoff: string | null,
  /** What the author said done looks like. Its own paragraph, never folded into the goal. */
  success?: string | null,
): Message;
