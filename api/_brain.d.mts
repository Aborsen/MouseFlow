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
  /** Owned by another window - which is what a modal dialog is. From agent 0.14.0. */
  dialog?: boolean;
  /** Экранный прямоугольник окна. `/windows` присылает его всегда; openList печатает - кроме свёрнутых. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
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
export function openList(windows: WindowLike[] | null | undefined, frame?: ShotFrame): string | null;
/** Чтение переднего окна, подложенное к ходу после застрявшего. Правило и слова - в _brain.mjs. */
export const PEEK_ID: string;
export function shouldPeek(still: number): boolean;
export function peekBody(frame: ShotFrame): string;
export function screenMessage(frame: ShotLike, open: string | null, saw?: string | null, clock?: string | null): Message;
export function forgetOldPictures<T extends { content?: unknown }>(messages: T[]): T[];
/** What one action did, in the words both drivers use. `moved === false` means the screen stood still. */
export function actionReport(moved: boolean | undefined, streak?: number): string;
export const STIR_LEVEL: number;
export const STIR_CELLS: number;
export const QUIET_MEAN: number;
export function gridStirred(a: Uint8Array | null, b: Uint8Array | null): boolean;
export function gridQuiet(a: Uint8Array | null, b: Uint8Array | null): boolean;
export const EARLIER_RUNS: number;
export function earlierRuns(runs: unknown[] | null | undefined, now?: number): string | null;
export function modsWire(asked: unknown): string;
export const OUTPUT_MAX: number;
export function actionSaid(
  output: string | null | undefined,
  moved: boolean | undefined,
  streak?: number,
): string;
export const STILL_WARN: number;
export const STILL_GIVE_UP: number;
export function stillStopped(streak: number): string;
export const STILL_NOTE: string;

/* Сколько действий один ход может унести, и какие. Правило в коде, а не в промпте - см. _brain.mjs. */
export const BATCH_MAX: number;
/** Whether one more action may run in this turn, with no fresh screenshot in between. */
export function sameTurn(sofar: string[], next: string): boolean;
/** Why an action in a batch was not carried out, in the words both drivers use. */
export function notBatched(sofar: string[], next: string): string;
/** And for everything behind the cut: a batch is cut, not filtered. */
export const AFTER_CUT: string;

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
  /** Что аккаунт делал прямо перед этим - фон, а не задание. См. earlierRuns. */
  earlier?: string | null,
): Message;
