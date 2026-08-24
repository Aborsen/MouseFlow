/* A zip, in about a hundred lines and no dependency.
 *
 * WHY NOT A LIBRARY. An agent skill installs as a FOLDER - `<name>/SKILL.md`, plus whatever else it needs
 * beside it - so handing somebody a bare .md means telling them where to put it and what to call the
 * directory. A zip removes that instruction. But it is one feature, and JSZip is 100KB in the bundle of an
 * app whose entire dependency list is deliberate.
 *
 * The saving grace is that a zip of TEXT does not need compression. Method 0 is "stored": the bytes go in
 * as they are, and the only arithmetic in the whole format is a CRC-32. What is left is four fixed-layout
 * records, all of them documented in APPNOTE.TXT and none of them clever.
 *
 * WHAT THIS DOES NOT DO, so nobody reaches for it expecting more: no compression, no encryption, no zip64,
 * no data descriptors. A zip64 archive starts at 4GB and these hold a markdown file. If any of that is ever
 * wanted, swapping this for a library is a contained change - `zip()` takes names and text and returns
 * bytes, and nothing about that signature mentions the format.
 *
 * The UTF-8 flag (bit 11) is set on every entry. Without it a name with a non-ASCII character in it - which
 * a skill named in Russian has - is read back through the unzipper's guess at a legacy codepage.
 */

/* Standard CRC-32 (IEEE 802.3), table built once. The table is 2KB and building it costs microseconds; a
 * literal table would be 256 numbers nobody could check by reading. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* MS-DOS date and time, which is what the format stores: two-second resolution, and the epoch is 1980.
 * A date before that cannot be represented, so it is clamped rather than written as a negative year. */
function dosStamp(at) {
  const d = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const utf8 = (text) => new TextEncoder().encode(text);

/** A little-endian writer, because every field in this format is little-endian and nothing else is. */
class Bytes {
  constructor() { this.parts = []; this.length = 0; }
  u16(v) { this.parts.push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff])); this.length += 2; return this; }
  u32(v) {
    this.parts.push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]));
    this.length += 4;
    return this;
  }
  raw(bytes) { this.parts.push(bytes); this.length += bytes.length; return this; }
  done() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) { out.set(part, at); at += part.length; }
    return out;
  }
}

const UTF8_FLAG = 0x0800;   // bit 11 - the name is UTF-8, not a legacy codepage
const STORED = 0;           // method 0 - no compression

/**
 * @param {{ name: string, text?: string, dir?: boolean }[]} files  paths use `/`; a `dir` entry ends in one
 * @param {Date} [at]  the timestamp written into every entry
 * @returns {Uint8Array}
 */
export function zip(files, at) {
  const { time, date } = dosStamp(at);
  const out = new Bytes();
  const central = [];

  for (const file of files || []) {
    const isDir = !!file.dir;
    /* A directory entry is a zero-length one whose name ends in a slash. Most unzippers create parents from
     * the file paths alone, and some do not - and the one that does not leaves SKILL.md loose in whatever
     * directory somebody unzipped into, which is exactly the instruction this whole thing exists to avoid. */
    const name = utf8(isDir ? `${String(file.name).replace(/\/*$/, '')}/` : String(file.name));
    const body = isDir ? new Uint8Array(0) : utf8(String(file.text ?? ''));
    const sum = isDir ? 0 : crc32(body);
    const offset = out.length;

    out.u32(0x04034b50).u16(20).u16(UTF8_FLAG).u16(STORED).u16(time).u16(date)
      .u32(sum).u32(body.length).u32(body.length)
      .u16(name.length).u16(0)
      .raw(name).raw(body);

    central.push({ name, sum, size: body.length, offset, isDir });
  }

  const cdAt = out.length;
  for (const e of central) {
    out.u32(0x02014b50).u16(20).u16(20).u16(UTF8_FLAG).u16(STORED).u16(time).u16(date)
      .u32(e.sum).u32(e.size).u32(e.size)
      .u16(e.name.length).u16(0).u16(0)
      .u16(0).u16(0)
      /* External attributes hold the unix mode in the high 16 bits: 0o40755 for a directory and 0o100644
       * for a file. Without them a folder unzipped on macOS or Linux comes out unreadable often enough to
       * be worth the two constants. */
      .u32(e.isDir ? 0x41ed0010 : 0x81a40000)
      .u32(e.offset)
      .raw(e.name);
  }
  const cdSize = out.length - cdAt;

  out.u32(0x06054b50).u16(0).u16(0)
    .u16(central.length).u16(central.length)
    .u32(cdSize).u32(cdAt).u16(0);

  return out.done();
}
