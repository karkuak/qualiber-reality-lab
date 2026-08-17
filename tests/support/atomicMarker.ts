/**
 * Publishing a small JSON marker so that a reader can never see it half-written.
 *
 * ## The defect this replaces
 *
 * A test that drives a child process and waits for it to report back used the
 * obvious shape:
 *
 * ```js
 * // writer, in the child
 * writeFileSync(markerPath, JSON.stringify({ worktree, worktreeRoot }));
 * // reader, in the parent
 * for (let waited = 0; waited < 60_000 && !existsSync(marker); waited += 50) await sleep(50);
 * const created = JSON.parse(readFileSync(marker, "utf8"));
 * ```
 *
 * `writeFileSync` opens with `O_CREAT|O_TRUNC` and *then* writes, so the final
 * path exists, at length zero, before it carries a byte. The reader's readiness
 * condition is existence, so the window between those two syscalls is a window
 * in which the reader proceeds and `JSON.parse("")` throws
 * `SyntaxError: Unexpected end of JSON input`. An independent probe drove the
 * two concurrently and observed the file at size zero in **300 of 300**
 * attempts: the window is unconditional, and an idle host merely loses the race
 * more often than it wins it. A clean gate run immediately after a four-hour
 * campaign lost it.
 *
 * ## The correction, on both sides
 *
 * **The writer publishes atomically.** The bytes are serialised in full, written
 * to a uniquely named temporary file *in the destination directory*, flushed and
 * closed, and only then `rename`d onto the final path. `rename` within one
 * filesystem is atomic: the final name resolves either to what was there before
 * or to the complete new file, never to a partially written one. Same directory
 * is what keeps it a rename rather than a copy, which would reintroduce exactly
 * the window it removes.
 *
 * **The reader treats readiness as content, not existence.** A path that exists
 * is not a marker. Ready means the bytes were read whole, they parse, and the
 * envelope names the writer the reader is waiting for. Anything less stays "not
 * ready" only while a writer could still be publishing; content that is stably
 * malformed, an envelope naming somebody else, an unsafe path, or a closed
 * deadline fail closed with a diagnostic that says which of those it was.
 *
 * Writer-only would close this instance and leave the shape for the next
 * consumer; reader-only would leave the non-atomic publication in place. Both
 * are here, and the reader's condition is the half that makes the outcome
 * deterministic rather than merely unlikely.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";

/** Permissions a task-owned marker is published with. Never group- or world-writable. */
const MARKER_MODE = 0o600;

/** The default bound on `awaitMarker`, matching the suite it was extracted from. */
export const DEFAULT_MARKER_TIMEOUT_MS = 60_000;
/** The default gap between readiness checks. */
export const DEFAULT_MARKER_POLL_MS = 50;

/**
 * Who published a marker.
 *
 * Carried in the envelope rather than inferred from the path so that a reader
 * refuses a marker left behind by an earlier run at the same location instead of
 * adopting it. A path proves where a file is; only its contents prove whose.
 */
export interface MarkerIdentity {
  readonly kind: string;
  readonly id: string;
}

/** The published shape: identity beside the payload, never mixed into it. */
export interface MarkerEnvelope<T = Readonly<Record<string, unknown>>> extends MarkerIdentity {
  readonly payload: T;
}

/** Why a marker is not ready, or not acceptable at all. */
export type MarkerNotReady =
  | { readonly state: "absent" }
  | { readonly state: "empty" }
  | { readonly state: "unparsable"; readonly bytes: string; readonly detail: string }
  | { readonly state: "malformed"; readonly bytes: string; readonly detail: string }
  | { readonly state: "foreign"; readonly bytes: string; readonly detail: string }
  | { readonly state: "unsafe"; readonly detail: string }
  | { readonly state: "unreadable"; readonly detail: string };

export type MarkerReadState<T> =
  | { readonly ready: true; readonly envelope: MarkerEnvelope<T> }
  | { readonly ready: false; readonly why: MarkerNotReady };

/** Monotonic within this process, so two stagings never collide by name. */
let staged = 0;

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message.slice(0, 200) : String(cause).slice(0, 200);
}

/**
 * Serialise an envelope to the exact bytes that will be published.
 *
 * Object keys are emitted in sorted order at every depth, so the same marker is
 * the same bytes every time. That is what lets a reader tell a *partial* write
 * from a *different* write, and what makes the stress check's byte comparison
 * mean something.
 */
export function serializeMarker<T>(envelope: MarkerEnvelope<T>): string {
  return `${stableJson({ id: envelope.id, kind: envelope.kind, payload: envelope.payload })}\n`;
}

/** `JSON.stringify` with object keys sorted at every depth. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Write the complete bytes to a task-owned temporary file beside `finalPath`.
 *
 * Exported separately from `publishMarker` because the property that matters —
 * that the final path is never the thing being written to — is a *structural*
 * one, and a test that can look between the two steps proves it without racing
 * anything. `O_CREAT|O_EXCL` is what makes the temporary path this task's: it
 * fails rather than truncating an existing file, and it refuses to follow a
 * symlink planted at that name.
 */
export function stageMarker<T>(finalPath: string, envelope: MarkerEnvelope<T>): string {
  const directory = path.dirname(finalPath);
  mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(serializeMarker(envelope), "utf8");
  // Unique per attempt: process, a monotonic counter, and the final name, so
  // two publishers of two markers in one directory never collide, and a stray
  // temporary is always attributable to the process that created it.
  const temporary = path.join(
    directory,
    `.${path.basename(finalPath)}.${String(process.pid)}.${String((staged += 1))}.tmp`,
  );
  const fd = openSync(temporary, "wx", MARKER_MODE);
  try {
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written);
    // The bytes must be on their way to the filesystem before the name that
    // promises them exists, or a crash publishes an empty file under a complete
    // name — the same lie by a slower route.
    fsyncSync(fd);
  } catch (cause) {
    closeSync(fd);
    // Only ever this call's own temporary. Nothing else in the directory is
    // this function's to remove.
    rmSync(temporary, { force: true });
    throw cause;
  }
  closeSync(fd);
  return temporary;
}

/**
 * Move a staged marker onto its final name, atomically.
 *
 * Refuses a final path that is a symlink: `rename` onto one replaces the link
 * rather than following it, but a reader that resolved the link first would
 * have read somewhere else entirely, and a marker whose location is ambiguous
 * proves nothing about who wrote it.
 */
export function commitMarker(temporaryPath: string, finalPath: string): void {
  assertNotSymlink(finalPath);
  renameSync(temporaryPath, finalPath);
}

/** Refuse a path that exists as a symlink, without following it. */
function assertNotSymlink(target: string): void {
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    return; // Absent is the ordinary case and the safe one.
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`refusing to publish a marker through a symlink at ${target}`);
  }
}

/**
 * Publish a marker so that `finalPath` is never observable incomplete.
 *
 * Overwrites, which is the semantics the call site it replaces had: `rename`
 * onto an existing regular file replaces it in one step, so a reader sees the
 * old complete marker or the new complete marker and nothing between.
 */
export function publishMarker<T>(finalPath: string, envelope: MarkerEnvelope<T>): void {
  const temporary = stageMarker(finalPath, envelope);
  try {
    commitMarker(temporary, finalPath);
  } catch (cause) {
    rmSync(temporary, { force: true });
    throw cause;
  }
}

/**
 * Whether the marker at `finalPath` is ready, and if not, why.
 *
 * Existence is deliberately not a state of its own: it is the condition that
 * made the original defect possible, so the only way to be ready here is to
 * hold bytes that parsed into an envelope naming `expected`.
 */
export function readMarker<T>(finalPath: string, expected: MarkerIdentity): MarkerReadState<T> {
  let stats;
  try {
    stats = lstatSync(finalPath);
  } catch (cause) {
    // Absent is the ordinary "the writer has not published yet". Everything
    // else is a filesystem fact a poll loop has no business absorbing.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { ready: false, why: { state: "absent" } };
    }
    return { ready: false, why: { state: "unreadable", detail: describe(cause) } };
  }
  if (stats.isSymbolicLink()) {
    return {
      ready: false,
      why: { state: "unsafe", detail: `${finalPath} is a symlink, not a published marker` },
    };
  }
  if (!stats.isFile()) {
    return {
      ready: false,
      why: { state: "unsafe", detail: `${finalPath} is not a regular file` },
    };
  }

  let bytes: string;
  try {
    bytes = readFileSync(finalPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { ready: false, why: { state: "absent" } };
    }
    return { ready: false, why: { state: "unreadable", detail: describe(cause) } };
  }
  if (bytes.length === 0) return { ready: false, why: { state: "empty" } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (cause) {
    return { ready: false, why: { state: "unparsable", bytes, detail: describe(cause) } };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ready: false, why: { state: "malformed", bytes, detail: "the marker is not an object" } };
  }
  const envelope = parsed as Partial<MarkerEnvelope<T>>;
  if (typeof envelope.kind !== "string" || typeof envelope.id !== "string") {
    return {
      ready: false,
      why: { state: "malformed", bytes, detail: "the marker carries no kind and id" },
    };
  }
  if (envelope.payload === undefined) {
    return { ready: false, why: { state: "malformed", bytes, detail: "the marker carries no payload" } };
  }
  if (envelope.kind !== expected.kind || envelope.id !== expected.id) {
    return {
      ready: false,
      why: {
        state: "foreign",
        bytes,
        detail:
          `the marker names ${envelope.kind}/${envelope.id} and this reader is waiting for ` +
          `${expected.kind}/${expected.id}`,
      },
    };
  }
  return {
    ready: true,
    envelope: { kind: envelope.kind, id: envelope.id, payload: envelope.payload as T },
  };
}

/** The error a bounded wait fails closed with, carrying what it last saw. */
export class MarkerUnavailableError extends Error {
  readonly why: MarkerNotReady;
  constructor(message: string, why: MarkerNotReady) {
    super(message);
    this.name = "MarkerUnavailableError";
    this.why = why;
  }
}

/**
 * Wait, bounded, for a marker naming `expected` to be published at `finalPath`.
 *
 * Three states are transient, because a writer that is mid-publication produces
 * exactly them: absent, empty, and content that does not parse. The last is
 * transient *only while it keeps changing*: bytes that fail to parse twice
 * running are not a write in progress, they are a marker that will never be
 * valid, and waiting out the full deadline for it would report a timeout for
 * something that was never going to happen.
 *
 * Everything else fails closed at once — a foreign identity, a marker whose
 * shape is wrong, an unsafe path, or any filesystem error that is not "the file
 * is not there yet". A poll loop that swallowed those would turn a permission
 * error into a timeout.
 */
export async function awaitMarker<T>(options: {
  readonly path: string;
  readonly expected: MarkerIdentity;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<MarkerEnvelope<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MARKER_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_MARKER_POLL_MS;
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  let last: MarkerNotReady = { state: "absent" };
  let previousUnparsable: string | undefined;
  for (let waited = 0; ; waited += pollMs) {
    const state = readMarker<T>(options.path, options.expected);
    if (state.ready) return state.envelope;
    last = state.why;
    switch (last.state) {
      case "absent":
      case "empty":
        previousUnparsable = undefined;
        break;
      case "unparsable":
        if (previousUnparsable === last.bytes) {
          throw new MarkerUnavailableError(
            `the marker at ${options.path} is stably unparsable: ${last.detail}`,
            last,
          );
        }
        previousUnparsable = last.bytes;
        break;
      default:
        throw new MarkerUnavailableError(
          `the marker at ${options.path} is not acceptable: ${last.detail}`,
          last,
        );
    }
    if (waited >= timeoutMs) {
      throw new MarkerUnavailableError(
        `no marker naming ${options.expected.kind}/${options.expected.id} was published at ` +
          `${options.path} within ${String(timeoutMs)}ms (last state: ${last.state})`,
        last,
      );
    }
    await sleep(pollMs);
  }
}

/** Task-created temporaries still sitting beside `finalPath`, if any. */
export function markerTemporaryResidue(finalPath: string): readonly string[] {
  const directory = path.dirname(finalPath);
  if (!existsSync(directory)) return [];
  const prefix = `.${path.basename(finalPath)}.`;
  return readdirSync(directory)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"))
    .map((entry) => path.join(directory, entry))
    .sort();
}
