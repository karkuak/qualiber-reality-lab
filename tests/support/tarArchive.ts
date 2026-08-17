/**
 * A minimal ustar writer, so a test can hand the trusted channel the same shape
 * `docker cp <container>:<path> -` hands it.
 *
 * The channel now classifies a trusted directory's entries from the archive's
 * own header bytes rather than from a materialised directory, so a stub that
 * writes files to a temporary directory no longer models the thing under test.
 * This builds the archive instead — including the entry *types* a filesystem
 * stub could not express without actually creating a symlink or a FIFO.
 */

const BLOCK = 512;

export interface TarEntry {
  readonly name: string;
  /** ustar typeflag: "0" regular, "2" symlink, "5" directory, "6" FIFO, … */
  readonly type?: string;
  readonly bytes?: Buffer | string;
  /** Overrides the computed size, for truncation and lying-header cases. */
  readonly declaredSize?: number;
  /** A symlink's target, which lives in the header rather than a payload. */
  readonly linkName?: string;
}

function writeField(header: Buffer, value: string, offset: number, length: number): void {
  header.write(value.slice(0, length - 1), offset, "ascii");
}

/** ustar requires the checksum computed with the checksum field read as spaces. */
function checksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return sum;
}

function headerFor(entry: TarEntry, size: number): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  writeField(header, entry.name, 0, 100);
  writeField(header, "0000644", 100, 8);
  writeField(header, "0000000", 108, 8);
  writeField(header, "0000000", 116, 8);
  writeField(header, size.toString(8).padStart(11, "0"), 124, 12);
  writeField(header, "00000000000", 136, 12);
  header.write(entry.type ?? "0", 156, "ascii");
  if (entry.linkName !== undefined) writeField(header, entry.linkName, 157, 100);
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  writeField(header, checksum(header).toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return header;
}

/** The archive, terminated by the two zero blocks a reader stops on. */
export function tarArchive(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const payload =
      entry.bytes === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(entry.bytes)
          ? entry.bytes
          : Buffer.from(entry.bytes, "utf8");
    // A non-regular entry carries no payload, exactly as tar writes it: a
    // symlink's size is zero and its target is a header field, which is why a
    // size check alone never catches one.
    const isRegular = (entry.type ?? "0") === "0";
    const size = entry.declaredSize ?? (isRegular ? payload.length : 0);
    parts.push(headerFor(entry, size));
    if (isRegular && payload.length > 0) {
      parts.push(payload);
      const padding = (BLOCK - (payload.length % BLOCK)) % BLOCK;
      if (padding > 0) parts.push(Buffer.alloc(padding, 0));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/** The common case: a `docker cp` of a directory, root entry included. */
export function trustedDirectoryArchive(
  files: Readonly<Record<string, string | Buffer>>,
): Buffer {
  return tarArchive([
    { name: "trusted/", type: "5" },
    ...Object.entries(files).map(([name, bytes]) => ({ name: `trusted/${name}`, bytes })),
  ]);
}
