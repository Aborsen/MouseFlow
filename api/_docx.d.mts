/* `Uint8Array<ArrayBuffer>` for the same reason _zip.d.mts says so: the bare form is generic over
 * ArrayBufferLike, which includes SharedArrayBuffer, and a BlobPart cannot be backed by one. This
 * allocates its own, so saying so is accurate as well as convenient. */
export function docxFromMarkdown(
  body: string,
  options?: { title?: string },
): Uint8Array<ArrayBuffer>;

/** A filename a person will recognise, and one an OS will accept. Always ends in `.docx`. */
export function docxName(title: string | null | undefined): string;
