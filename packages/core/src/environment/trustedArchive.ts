/**
 * The trusted directory's archive, read for its own entry metadata.
 *
 * ## Why an archive and not a directory
 *
 * The first Package 2 candidate copied the trusted directory onto the host with
 * `docker cp <container>:/trusted <dir>` and then read the one file it expected
 * with `readFileSync`. An independent review planted a symlink named
 * `traces.jsonl` on the trusted volume and measured the consequence: `docker cp`
 * preserves the symlink, `readdirSync` reports exactly one entry with exactly
 * the expected name, and `readFileSync` **follows it** — 9 350 bytes of the
 * host's `/etc/passwd` arrived where the artifact should have been.
 *
 * Every check that could have caught it ran on the host, after the bytes were
 * already materialised, against a name that told the truth. The type was the
 * only thing that would have refused it, and nothing looked at the type.
 *
 * `docker cp <container>:<path> -` answers with a **tar stream** instead, and a
 * tar header carries the entry's type as a field. So the classification happens
 * before anything is written to a filesystem, before anything is opened, and —
 * because the payload rides in the same archive — the entry that is type-checked
 * is literally the entry the bytes are taken from. There is no window between
 * deciding an entry is a regular file and reading it, because both come out of
 * the same 512-byte-framed structure in one pass.
 *
 * This is Docker's own archive metadata, which is the first mechanism the
 * remediation brief names. It needs no helper image, no in-container `stat`, no
 * shell, and no new privilege: it is the same `docker cp` the driver already had
 * authority to run, asked for its output rather than its side effect.
 *
 * ## What this deliberately does not do
 *
 * It does not extract. There is no path where a name from the archive becomes a
 * path on this host, so an absolute name or a `..` traversal cannot escape
 * anywhere — they are refused, but even unrefused they would have nowhere to go.
 * It does not follow a link, resolve a name, or open a file. It reads bytes the
 * daemon sent and decides whether they are the one regular file the channel
 * expects.
 *
 * The Docker-daemon administrator remains outside the subject threat boundary,
 * exactly as before: someone who can drive the daemon can write whatever they
 * like into the stream. What changes is that a *collector* compromise, a
 * configuration defect or a future topology change can no longer turn a name
 * into a host file read.
 */

/** A ustar header block is 512 bytes, and so is every payload block. */
const BLOCK = 512;

/** Header field offsets, from the ustar layout. */
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const TYPEFLAG_OFFSET = 156;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;

/**
 * Tar entry types, as the single byte at offset 156.
 *
 * `0` and NUL both mean a regular file; every other value is something this
 * channel has no reason to accept. They are named rather than compared inline so
 * a refusal can say what it refused.
 */
export const TAR_ENTRY_TYPES: Readonly<Record<string, string>> = {
  "0": "regular-file",
  "\0": "regular-file",
  "1": "hard-link",
  "2": "symlink",
  "3": "character-device",
  "4": "block-device",
  "5": "directory",
  "6": "fifo",
  "7": "contiguous-file",
};

/** One entry of the archive, classified but not extracted. */
export interface TrustedArchiveEntry {
  /** The archive's own name for it, with any ustar prefix rejoined. */
  readonly name: string;
  /** The declared type, or `unknown-<byte>` for a value ustar does not define. */
  readonly type: string;
  /** The declared payload length in bytes. */
  readonly size: number;
  /** The payload, present only for a regular file. */
  readonly bytes?: Buffer;
}

export type TrustedArchiveRead =
  | { readonly ok: true; readonly entries: readonly TrustedArchiveEntry[] }
  | { readonly ok: false; readonly detail: string };

/** A NUL-terminated ASCII field. */
function field(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("ascii");
}

/**
 * A tar size field: octal, NUL- or space-terminated.
 *
 * Refused rather than coerced when it is not that, because a size this function
 * guesses at is a size the caller would then trust to bound a read.
 */
function octalSize(header: Buffer): number | undefined {
  const raw = field(header, SIZE_OFFSET, SIZE_LENGTH).trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/.test(raw)) return undefined;
  const value = Number.parseInt(raw, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Reads every entry of a tar stream, classifying each without extracting it.
 *
 * `maxTotalBytes` bounds the payload this will hold, so a hostile archive
 * declaring an enormous member is refused rather than buffered. The bound is the
 * caller's, because it is the contract's retention ceiling rather than a
 * property of tar.
 */
export function readTrustedArchive(archive: Buffer, maxTotalBytes: number): TrustedArchiveRead {
  const entries: TrustedArchiveEntry[] = [];
  let offset = 0;
  let retained = 0;

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks end the archive; one is enough to stop here,
    // because a header whose name is empty describes nothing.
    if (header.every((byte) => byte === 0)) break;

    const name = field(header, NAME_OFFSET, NAME_LENGTH);
    const prefix = field(header, PREFIX_OFFSET, PREFIX_LENGTH);
    const full = prefix.length > 0 ? `${prefix}/${name}` : name;
    if (full.length === 0) return { ok: false, detail: "an archive entry has no name" };

    const size = octalSize(header);
    if (size === undefined) {
      return { ok: false, detail: `archive entry ${full} declares an unreadable size` };
    }

    const typeByte = String.fromCharCode(header[TYPEFLAG_OFFSET] ?? 0);
    const type = TAR_ENTRY_TYPES[typeByte] ?? `unknown-${header[TYPEFLAG_OFFSET] ?? 0}`;

    offset += BLOCK;
    // Only a regular file has a payload worth carrying. A symlink's "size" is
    // zero and its target lives in the header's linkname field, which is exactly
    // why a size check alone would never have caught the planted link.
    if (type === "regular-file") {
      if (offset + size > archive.length) {
        return { ok: false, detail: `archive entry ${full} is truncated` };
      }
      retained += size;
      if (retained > maxTotalBytes) {
        return { ok: false, detail: `archive payload exceeds ${String(maxTotalBytes)} bytes` };
      }
      entries.push({ name: full, type, size, bytes: archive.subarray(offset, offset + size) });
    } else {
      entries.push({ name: full, type, size });
    }
    // Payloads are padded to a block boundary.
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  return { ok: true, entries };
}

/**
 * Whether an archive name is one this channel may reason about at all.
 *
 * Absolute names and `..` segments are refused even though nothing here writes
 * to a path, because an archive that contains one is not the archive the
 * collector was supposed to have produced, and the cheapest place to say so is
 * before anything downstream treats the name as ordinary.
 */
export function unsafeArchiveName(name: string): boolean {
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return true;
  return name.split("/").some((segment) => segment === "..");
}
