/* The contract the TypeScript side reads. See api/_quota.mjs for what any of it is for. */

/** Запись в том виде, в каком это правило её знает: id, есть ли вторая копия, и сколько в ней событий. */
export interface Freeable {
  id: string;
  /** Когда аккаунт в последний раз её принял. Отсутствует - второй копии нет, события неприкосновенны. */
  syncedAt?: string;
  events?: unknown[];
}

export function heldElsewhere(rec: Freeable | null | undefined): boolean;

/** Id записей, которые могут отдать свои события, от самой большой к меньшей. */
export function freeingOrder(recordings: Freeable[] | null | undefined): string[];
