export function crc32(bytes: Uint8Array): number;
/* `Uint8Array<ArrayBuffer>` rather than a bare Uint8Array: the bare form is generic over ArrayBufferLike,
 * which includes SharedArrayBuffer, and a BlobPart cannot be backed by one. Everything here allocates its
 * own ArrayBuffer, so saying so is accurate as well as convenient. */
export function zip(
  files: { name: string; text?: string; dir?: boolean }[],
  at?: Date,
): Uint8Array<ArrayBuffer>;
