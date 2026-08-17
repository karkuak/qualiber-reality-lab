/**
 * Host-provisioned inputs for a trusted-local observation: the path
 * convention, the copy-and-retain, and the offline re-verification.
 *
 * ## Why the plan is the ledger
 *
 * A trusted-local plan already names every input it needs — an `input_id`, a
 * logical `path`, a `byte_length` and a `file_sha256` — and the plan's bytes
 * are bound into the run record through `plan_hash` and `plan_file_hash`. So
 * the expected input set is a *derivation* from the plan, not a second list
 * somebody has to keep in step with it. Retaining a parallel copy of those
 * claims in the record would create exactly one new failure mode — the two
 * lists disagreeing — and buy nothing a reader could not already compute.
 *
 * What the plan does **not** name is where the bytes came from. That is the
 * operator's `--bind-input` binding, and it is deliberately not retained in the
 * portable record: a physical absolute path on one machine is not evidence
 * anywhere else, and a record that carried one would invite a reader to treat
 * it as a location they could check.
 *
 * ## The convention
 *
 * Each host-provisioned input's `artifact.path` is read as
 *
 *     <input_root>/<mount_id>/<relative-file-path>
 *
 * where `input_root` comes from `plan.resource_limits.input_root`. The first
 * segment beneath the input root is a mount, everything after it is a file
 * inside that mount, and several inputs may share one mount. That is the only
 * interpretation this module applies, and every path that does not fit it is
 * refused rather than coerced into something that does.
 *
 * ## What this module is not
 *
 * It confers no certification, no confinement, no scoring, no authentication
 * and no governor authorization. It copies bytes the operator named, checks
 * them against digests the operator's own plan declared, and makes them
 * readable to an adapter the operator already accepted running with their own
 * permissions. A digest that matches proves the file is the file the plan
 * described; it proves nothing about what the file contains or what the
 * adapter does with it.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import path from "node:path";

import {
  CODES,
  Erl2Error,
  type Hash,
  type LocalObservationTrustedLocalPlanV1,
} from "@erl2/contracts";

import type { AdapterMount } from "../adapter/host.js";
import { assertRegularFile } from "../adapter/trustedLocalRegistry.js";

/** Where materialized inputs live, relative to the run's `--output-root`. */
export const TRUSTED_LOCAL_INPUTS_DIR = "inputs";

/**
 * Ceilings on what one trusted-local run will copy in.
 *
 * These are **internal constants, not plan fields**, and that is deliberate.
 * `LocalObservationLimitsV1` carries `max_output_files` and `max_output_bytes`,
 * which bound what the adapter *produces*; neither describes what the host
 * provisions, and reusing one because its number looked convenient would mean
 * an operator raising an output ceiling had silently raised an input ceiling
 * they never reasoned about. There is no input-side limit in the plan schema
 * today, and this slice does not widen the public schema to add one — so the
 * ceilings live here, conservative and documented, and a plan that needs more
 * is a conversation rather than a flag.
 *
 * The values are sized for the only thing this path is for: an owner feeding a
 * bounded set of fixtures, configurations and small packages to their own
 * adapter on their own machine.
 */
export interface TrustedLocalInputCeilings {
  /** How many host-provisioned inputs one plan may bind. */
  readonly maxInputCount: number;
  /** The largest single input, in bytes. */
  readonly maxInputBytes: number;
  /** The largest total across every input, in bytes. */
  readonly maxTotalInputBytes: number;
}

export const TRUSTED_LOCAL_INPUT_CEILINGS: TrustedLocalInputCeilings = {
  maxInputCount: 64,
  maxInputBytes: 64 * 1024 * 1024,
  maxTotalInputBytes: 256 * 1024 * 1024,
};

/** How much is read from a source at a time. Bounded so a large file never lands in memory whole. */
const CHUNK_BYTES = 64 * 1024;

/**
 * True only for the one condition that means "there is nothing at this path".
 *
 * The same rule the substrate reader and the reservation allocator apply: a
 * permission fault, an I/O fault or an invalid path state is *not* absence, and
 * treating it as absence is how a check that exists to prevent an overwrite
 * ends up authorising one.
 */
function isAbsent(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** `O_NOFOLLOW` where the platform has it, and a harmless zero where it does not. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Opening a symbolic link with `O_NOFOLLOW` fails with one of these.
 *
 * Linux and macOS report `ELOOP`; some BSDs report `EMLINK`. Either is the
 * kernel saying "the final component is a link", which is a refusal this module
 * already has a name for rather than an unclassified filesystem exception.
 */
const NOFOLLOW_ERRNOS: ReadonlySet<string> = new Set(["ELOOP", "EMLINK"]);

/**
 * The filesystem calls the open-and-validate path uses.
 *
 * Injectable for one reason only: the defect being closed here is a *race* —
 * a path replaced between inspection and open — and a race cannot be measured
 * by arranging real files, because the test would have to win a scheduling
 * contest to be meaningful. A seam lets the replacement happen deterministically
 * at the exact instant the window exists. Production always passes
 * `REAL_FILE_SEAMS`, and this type is deliberately not re-exported from the
 * package index: it is a test seam, not part of the observation contract.
 */
export interface TrustedLocalFileSeams {
  readonly lstat: (target: string) => Stats;
  readonly open: (target: string, flags: number) => number;
  readonly fstat: (fd: number) => Stats;
  readonly close: (fd: number) => void;
  readonly write: (fd: number, buffer: Buffer, offset: number, length: number) => number;
}

export const REAL_FILE_SEAMS: TrustedLocalFileSeams = {
  lstat: lstatSync,
  open: (target, flags) => openSync(target, flags),
  fstat: fstatSync,
  close: closeSync,
  write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
};

/**
 * Opens a path for reading and proves that what was opened is what was
 * inspected.
 *
 * A plain `lstat`-then-open leaves a window: the final component can be
 * replaced with a symbolic link after the check and before the open, and
 * `openSync(path, "r")` follows it. Everything downstream — the digest, the
 * length, the retained bytes — would then describe a file the caller never
 * approved.
 *
 * Four checks close it, and each one is load-bearing:
 *
 *   1. a pre-open `lstat`, so a link that is already there is refused outright;
 *   2. `O_NOFOLLOW`, so a link introduced in the window makes the *open itself*
 *      fail rather than succeed on the wrong file;
 *   3. an `fstat` on the descriptor, compared to the pre-open `lstat` by
 *      `dev`/`ino`, so a regular file swapped for a *different regular file* is
 *      caught even though no symlink was ever involved;
 *   4. a post-open `lstat`, so a path that still resolves somewhere else after
 *      the fact is refused before a single byte is read.
 *
 * `O_NOFOLLOW` alone would miss check 3, and the identity comparison alone
 * would miss the platforms where an inode number is not meaningful. The bytes
 * are read only from the returned descriptor, never from the path again.
 */
function openRegularFileNoFollow(
  absolute: string,
  label: string,
  seams: TrustedLocalFileSeams = REAL_FILE_SEAMS,
): { readonly fd: number; readonly stats: Stats } {
  const before = inspectRegularFile(absolute, label, seams);

  let fd: number;
  try {
    fd = seams.open(absolute, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | null)?.code ?? "";
    if (NOFOLLOW_ERRNOS.has(code)) {
      throw new Erl2Error(
        CODES.PATH_SYMLINK_REJECTED,
        `${label} became a symbolic link between inspection and opening: ${absolute}`,
        { owner: "lab", cause },
      );
    }
    if (isAbsent(cause)) {
      throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `${label} not found: ${absolute}`, {
        owner: "lab",
        cause,
      });
    }
    throw new Erl2Error(CODES.ADMISSION_RETENTION_FAILED, `${label} could not be opened: ${absolute}`, {
      owner: "lab",
      cause,
    });
  }

  try {
    const opened = seams.fstat(fd);
    if (!opened.isFile()) {
      throw new Erl2Error(
        CODES.PATH_NOT_REGULAR_FILE,
        `${label} is not a regular file: ${absolute}`,
      );
    }
    assertSameFile(before, opened, absolute, label);
    // After the fact as well: a path that no longer names the file just opened
    // is a path whose bytes nobody should be attributing to it.
    assertSameFile(before, inspectRegularFile(absolute, label, seams), absolute, label);
    return { fd, stats: opened };
  } catch (cause) {
    seams.close(fd);
    throw cause;
  }
}

/** One `lstat`, with a regular non-symlink file required and absence named. */
function inspectRegularFile(
  absolute: string,
  label: string,
  seams: TrustedLocalFileSeams,
): Stats {
  let stats: Stats;
  try {
    stats = seams.lstat(absolute);
  } catch (cause) {
    if (isAbsent(cause)) {
      throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `${label} not found: ${absolute}`, {
        owner: "lab",
        cause,
      });
    }
    throw new Erl2Error(
      CODES.ADMISSION_RETENTION_FAILED,
      `${label} could not be inspected: ${absolute}`,
      { owner: "lab", cause },
    );
  }
  if (stats.isSymbolicLink()) {
    throw new Erl2Error(
      CODES.PATH_SYMLINK_REJECTED,
      `${label} is a symbolic link; supply the regular file itself: ${absolute}`,
    );
  }
  if (!stats.isFile()) {
    throw new Erl2Error(CODES.PATH_NOT_REGULAR_FILE, `${label} is not a regular file: ${absolute}`);
  }
  return stats;
}

/**
 * Stable file identity, where the platform reports one.
 *
 * An inode of zero means the filesystem does not supply a meaningful identity,
 * and comparing it would reject every legitimate file on such a filesystem
 * rather than catching anything. The comparison is skipped there; `O_NOFOLLOW`
 * and the two `lstat`s still apply.
 */
function assertSameFile(before: Stats, after: Stats, absolute: string, label: string): void {
  if (before.ino === 0 || after.ino === 0) return;
  if (before.dev === after.dev && before.ino === after.ino) return;
  throw new Erl2Error(
    CODES.PATH_SYMLINK_REJECTED,
    `${label} was replaced between inspection and reading: ${absolute}`,
  );
}

/**
 * Writes an entire slice, however many calls that takes.
 *
 * `writeSync` may write fewer bytes than asked for, and the previous loop
 * called it once and discarded the count. The consequence was specific and
 * bad: the hash and the length were computed over every byte *read*, while the
 * retained file held only the bytes that happened to be *written* — so a
 * short write produced a truncated file carrying the digest and length of the
 * whole one, and every later check would confirm it.
 *
 * The writer is a parameter so a short write can be produced on demand. A real
 * short write from a regular file on a local filesystem is close to
 * unobservable in a test, which is exactly why the bug survived review.
 */
export function writeAllSync(
  write: TrustedLocalFileSeams["write"],
  fd: number,
  buffer: Buffer,
  length: number,
  label: string,
): void {
  let offset = 0;
  while (offset < length) {
    const remaining = length - offset;
    const written = write(fd, buffer, offset, remaining);
    // A non-positive or non-integer count means no progress was made, and
    // looping on it would hang rather than fail. A count larger than what was
    // asked for is equally impossible and equally untrustworthy.
    if (!Number.isInteger(written) || written <= 0 || written > remaining) {
      throw new Erl2Error(
        CODES.ADMISSION_RETENTION_FAILED,
        `${label} could not be written: a write of ${remaining} bytes reported ${String(written)}`,
      );
    }
    offset += written;
  }
}

/** One host-provisioned plan input, resolved against the path convention. */
export interface TrustedLocalInputMapping {
  readonly inputId: string;
  readonly mountId: string;
  /** Slash-separated path beneath the mount; never empty, never a directory. */
  readonly relativePath: string;
  /** The plan's own `artifact.path`, verbatim. */
  readonly logicalPath: string;
  readonly byteLength: number;
  readonly fileSha256: Hash;
}

/** An operator's `--bind-input` pairing, already split but not yet checked. */
export interface TrustedLocalInputBinding {
  readonly inputId: string;
  readonly sourcePath: string;
}

export interface MaterializedTrustedLocalInput {
  readonly inputId: string;
  readonly mountId: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly byteLength: number;
  readonly fileSha256: Hash;
}

/**
 * A mount over retained inputs.
 *
 * Narrower than `AdapterMount` in exactly one place: the purpose is fixed. This
 * path produces subject-visible inputs and nothing else, so a caller reporting
 * the purpose does not have to widen its own types or assert its way back to
 * the literal it already knows.
 */
export interface TrustedLocalInputMount extends AdapterMount {
  readonly purpose: "subject-visible-input";
}

export interface MaterializedTrustedLocalInputs {
  readonly retainedInputRoot: string;
  readonly mounts: readonly TrustedLocalInputMount[];
  readonly files: readonly MaterializedTrustedLocalInput[];
}

export interface MaterializeTrustedLocalInputsInput {
  readonly plan: LocalObservationTrustedLocalPlanV1;
  readonly bindings: readonly TrustedLocalInputBinding[];
  /** The run's `--output-root`; every durable byte lands beneath it. */
  readonly outputRoot: string;
  /** Overridable only so the ceilings' own boundaries can be measured. */
  readonly ceilings?: TrustedLocalInputCeilings;
}

/**
 * Every host-provisioned input the plan declares, resolved to a mount and a
 * relative file path.
 *
 * Pure: it reads the plan and nothing else, which is what lets the producer and
 * the offline verifier derive the same expected set without the verifier
 * calling anything that produced the run.
 */
export function trustedLocalInputMappings(
  plan: LocalObservationTrustedLocalPlanV1,
  ceilings: TrustedLocalInputCeilings = TRUSTED_LOCAL_INPUT_CEILINGS,
): readonly TrustedLocalInputMapping[] {
  const inputRoot = normalizedInputRoot(plan.resource_limits.input_root);
  const hostProvisioned = plan.inputs.filter(
    (input): input is Extract<typeof input, { readonly provenance_mode: "host_provisioned" }> =>
      input.provenance_mode === "host_provisioned",
  );

  if (hostProvisioned.length > ceilings.maxInputCount) {
    throw new Erl2Error(
      CODES.ADAPTER_LOCAL_LIMIT_EXCEEDED,
      `the plan declares ${hostProvisioned.length} host-provisioned inputs, above the ` +
        `${ceilings.maxInputCount}-input trusted-local ceiling`,
    );
  }

  const mappings: TrustedLocalInputMapping[] = [];
  const byInputId = new Set<string>();
  const byDestination = new Map<string, string>();
  let declaredTotal = 0;

  for (const input of hostProvisioned) {
    if (byInputId.has(input.input_id)) {
      throw new Erl2Error(
        CODES.PATH_INVALID_COMPONENT,
        `the plan declares input ${input.input_id} more than once`,
      );
    }
    byInputId.add(input.input_id);

    const { mountId, relativePath } = splitLogicalPath(
      input.artifact.path,
      inputRoot,
      input.input_id,
    );

    // A destination collision means two inputs would occupy one file. Compared
    // case-insensitively as well, because on a case-folding filesystem
    // `Fixture/a` and `fixture/a` are one path and the second write would
    // silently replace the first.
    const destination = `${mountId}/${relativePath}`;
    const folded = destination.toLowerCase();
    const previous = byDestination.get(folded);
    if (previous !== undefined) {
      throw new Erl2Error(
        previous === destination ? CODES.PATH_INVALID_COMPONENT : CODES.PATH_CASE_COLLISION,
        `inputs ${previous === destination ? "" : "case-"}collide on retained destination ` +
          `${destination}; ${input.input_id} would overwrite the input already mapped there`,
      );
    }
    byDestination.set(folded, destination);

    if (input.artifact.byte_length > ceilings.maxInputBytes) {
      throw new Erl2Error(
        CODES.ADAPTER_LOCAL_LIMIT_EXCEEDED,
        `input ${input.input_id} declares ${input.artifact.byte_length} bytes, above the ` +
          `${ceilings.maxInputBytes}-byte single-input trusted-local ceiling`,
      );
    }
    declaredTotal += input.artifact.byte_length;
    if (declaredTotal > ceilings.maxTotalInputBytes) {
      throw new Erl2Error(
        CODES.ADAPTER_LOCAL_LIMIT_EXCEEDED,
        `the plan declares ${declaredTotal} input bytes, above the ` +
          `${ceilings.maxTotalInputBytes}-byte aggregate trusted-local ceiling`,
      );
    }

    mappings.push({
      inputId: input.input_id,
      mountId,
      relativePath,
      logicalPath: input.artifact.path,
      byteLength: input.artifact.byte_length,
      fileSha256: input.artifact.file_sha256,
    });
  }

  return mappings;
}

/**
 * Verifies the operator's bindings, then copies the exact bytes they named.
 *
 * The copy and the digest are **one pass over one open descriptor**. An earlier
 * shape — hash the source, then copy the source — would have read the path
 * twice and admitted a file that was swapped between the two reads, so what is
 * retained would not be what was checked. Here the bytes that reach the staging
 * file are the same bytes that reach the hash, and the comparison against the
 * plan happens after both.
 *
 * Each input is staged, checked and published in turn, so an input that fails
 * may have predecessors already at their final names. That is why the failure
 * path removes the whole retained input root rather than only the staging file:
 * everything beneath it was created by this call — `assertAbsentTree` refused
 * to proceed otherwise — so the removal touches only task-created material, and
 * no half-materialized input root survives a refusal.
 */
export function materializeTrustedLocalInputs(
  input: MaterializeTrustedLocalInputsInput,
): MaterializedTrustedLocalInputs {
  const ceilings = input.ceilings ?? TRUSTED_LOCAL_INPUT_CEILINGS;
  const mappings = trustedLocalInputMappings(input.plan, ceilings);
  const sources = resolveBindings(mappings, input.bindings, ineligibleInputIds(input.plan));

  const outputRoot = path.resolve(input.outputRoot);
  const retainedInputRoot = path.join(outputRoot, TRUSTED_LOCAL_INPUTS_DIR);
  assertAbsentTree(retainedInputRoot);

  if (mappings.length === 0) {
    // A zero-input plan retains nothing and mounts nothing. The directory is
    // deliberately not created: an empty tree and an absent one carry the same
    // meaning to the verifier, and not creating it keeps the run's footprint
    // honest about what it actually provisioned.
    return { retainedInputRoot, mounts: [], files: [] };
  }

  const staged: string[] = [];
  const files: MaterializedTrustedLocalInput[] = [];
  let total = 0;
  try {
    mkdirSync(retainedInputRoot, { recursive: true, mode: 0o700 });
    for (const mapping of mappings) {
      const source = sources.get(mapping.inputId) as string;
      const destination = destinationOf(retainedInputRoot, mapping);
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });

      const stagingPath = `${destination}.${String(process.pid)}.partial`;
      staged.push(stagingPath);
      const observed = streamInto(source, stagingPath, mapping, ceilings, total);
      total += observed.byteLength;

      if (observed.fileSha256 !== mapping.fileSha256) {
        throw new Erl2Error(
          CODES.ARTIFACT_HASH_MISMATCH,
          `input ${mapping.inputId} hashes to ${observed.fileSha256}; the plan declares ` +
            `${mapping.fileSha256}`,
        );
      }
      if (observed.byteLength !== mapping.byteLength) {
        throw new Erl2Error(
          CODES.ARTIFACT_HASH_MISMATCH,
          `input ${mapping.inputId} is ${observed.byteLength} bytes; the plan declares ` +
            `${mapping.byteLength}`,
        );
      }

      // Read-only for the owner and nobody else, before it is reachable at the
      // name the adapter will be told about.
      chmodSync(stagingPath, 0o400);
      assertAbsentTree(destination);
      renameSync(stagingPath, destination);
      staged.pop();

      files.push({
        inputId: mapping.inputId,
        mountId: mapping.mountId,
        relativePath: mapping.relativePath,
        absolutePath: destination,
        byteLength: observed.byteLength,
        fileSha256: observed.fileSha256,
      });
    }
  } catch (cause) {
    for (const stagingPath of staged) {
      try {
        unlinkSync(stagingPath);
      } catch {
        /* the staging file may never have been created */
      }
    }
    // Everything beneath the retained input root was created by this call —
    // `assertAbsentTree` above refused to proceed otherwise — so removing it
    // removes only task-created material.
    try {
      rmSync(retainedInputRoot, { recursive: true, force: true });
    } catch {
      /* removal is best-effort; the refusal below is the result */
    }
    throw cause;
  }

  return { retainedInputRoot, mounts: mountsOf(input.plan, retainedInputRoot, mappings), files };
}

/**
 * Re-hashes the retained input tree against the plan that declared it.
 *
 * Returns refusal sentences rather than throwing, because it is one section of
 * a verification that reports the whole picture in one pass. The physical tree
 * is walked as well as the expected set derived, so a file nobody planned is a
 * refusal in its own right: an input tree with an extra file is an input tree
 * the adapter could have read something unaccounted-for from.
 */
export function verifyRetainedTrustedLocalInputs(input: {
  readonly plan: LocalObservationTrustedLocalPlanV1;
  readonly retainedInputRoot: string;
  readonly ceilings?: TrustedLocalInputCeilings;
}): readonly string[] {
  const refusals: string[] = [];
  const ceilings = input.ceilings ?? TRUSTED_LOCAL_INPUT_CEILINGS;
  let mappings: readonly TrustedLocalInputMapping[];
  try {
    mappings = trustedLocalInputMappings(input.plan, ceilings);
  } catch (cause) {
    return [
      cause instanceof Erl2Error
        ? `the plan's host-provisioned inputs do not resolve: ${cause.code} ${cause.message}`
        : "the plan's host-provisioned inputs do not resolve",
    ];
  }

  const root = path.resolve(input.retainedInputRoot);
  const expected = new Map(
    mappings.map((mapping) => [`${mapping.mountId}/${mapping.relativePath}`, mapping]),
  );

  let present: readonly string[];
  try {
    present = walkRetained(root, refusals);
  } catch (cause) {
    return [
      cause instanceof Erl2Error
        ? `the retained input root could not be read: ${cause.code} ${cause.message}`
        : "the retained input root could not be read",
    ];
  }

  for (const relative of present) {
    if (!expected.has(relative)) {
      refusals.push(`the retained input tree holds ${relative}, which the plan does not declare`);
    }
  }

  const found = new Set(present);
  for (const [relative, mapping] of expected) {
    if (!found.has(relative)) {
      refusals.push(`input ${mapping.inputId} is missing from the retained input tree at ${relative}`);
      continue;
    }
    const absolute = path.join(root, ...relative.split("/"));
    let observed: { readonly byteLength: number; readonly fileSha256: Hash };
    try {
      // Streamed and bounded, like the producer's own pass. A verifier that
      // read whatever was at the path would let anyone who could edit the tree
      // choose how much memory the check costs — and editing the tree is the
      // exact situation this function exists to detect.
      observed = digestRetainedFile(absolute, ceilings.maxInputBytes);
    } catch (cause) {
      refusals.push(
        cause instanceof Erl2Error
          ? `retained input ${relative} could not be re-hashed: ${cause.code} ${cause.message}`
          : `retained input ${relative} could not be read`,
      );
      continue;
    }
    if (observed.byteLength !== mapping.byteLength) {
      refusals.push(
        `retained input ${relative} is ${observed.byteLength} bytes; the plan declares ${mapping.byteLength}`,
      );
    }
    if (observed.fileSha256 !== mapping.fileSha256) {
      refusals.push(`retained input ${relative} no longer hashes to the digest the plan declares`);
    }
  }

  return refusals;
}

/** Plan input ids that exist but can never be host-provisioned. */
function ineligibleInputIds(plan: LocalObservationTrustedLocalPlanV1): ReadonlySet<string> {
  return new Set(
    plan.inputs
      .filter((entry) => entry.provenance_mode !== "host_provisioned")
      .map((entry) => entry.input_id),
  );
}

/** Every distinct mount the mappings ask for, read-only, one per mount id. */
function mountsOf(
  plan: LocalObservationTrustedLocalPlanV1,
  retainedInputRoot: string,
  mappings: readonly TrustedLocalInputMapping[],
): readonly TrustedLocalInputMount[] {
  const inputRoot = normalizedInputRoot(plan.resource_limits.input_root);
  const seen = new Set<string>();
  const mounts: TrustedLocalInputMount[] = [];
  for (const mapping of mappings) {
    if (seen.has(mapping.mountId)) continue;
    seen.add(mapping.mountId);
    mounts.push({
      mountId: mapping.mountId,
      absolutePath: path.join(retainedInputRoot, mapping.mountId),
      // The mount **root**, never an individual artifact path: several inputs
      // share one mount, and a logical path naming one of their files would
      // describe a mount that does not contain the others.
      logicalPath: `${inputRoot}/${mapping.mountId}`,
      purpose: "subject-visible-input",
    });
  }
  return mounts;
}

/**
 * Exactly one binding per host-provisioned input, and no binding for anything
 * else.
 *
 * "Exact" is the whole point. A missing binding would leave the adapter reading
 * a file that is not there; an extra one would mean the operator believed they
 * were supplying something the run never used, which is the more dangerous of
 * the two because nothing would fail.
 */
function resolveBindings(
  mappings: readonly TrustedLocalInputMapping[],
  bindings: readonly TrustedLocalInputBinding[],
  ineligible: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const wanted = new Map(mappings.map((mapping) => [mapping.inputId, mapping]));
  const supplied = new Map<string, string>();

  for (const binding of bindings) {
    if (supplied.has(binding.inputId)) {
      throw new Erl2Error(
        CODES.CFG_DUPLICATE_FLAG,
        `--bind-input names ${binding.inputId} more than once`,
      );
    }
    if (ineligible.has(binding.inputId)) {
      // An `acquired` input carries no ArtifactRef at all: the adapter produces
      // it during the run. Binding one is not a typo to be corrected but a
      // request the shape of the plan cannot express, so it is refused by name
      // rather than folded into "unknown".
      throw new Erl2Error(
        CODES.CFG_UNKNOWN_FLAG,
        `--bind-input names ${binding.inputId}, which the plan declares with provenance_mode ` +
          "acquired; only a host_provisioned input is eligible for host provisioning",
      );
    }
    if (!wanted.has(binding.inputId)) {
      throw new Erl2Error(
        CODES.CFG_UNKNOWN_FLAG,
        `--bind-input names ${binding.inputId}, which the plan does not declare as an input`,
      );
    }
    supplied.set(binding.inputId, binding.sourcePath);
  }

  const missing = [...wanted.keys()].filter((inputId) => !supplied.has(inputId));
  if (missing.length > 0) {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      `every host-provisioned plan input needs a --bind-input binding; missing: ${missing.join(", ")}`,
    );
  }
  return supplied;
}

/**
 * One bounded pass: open, validate, stream, hash and count.
 *
 * The ceilings are enforced *during* the read rather than from a stat, so a
 * file that grows between the check and the read cannot get past them, and no
 * more than one chunk beyond a ceiling is ever read.
 */
export function streamInto(
  sourcePath: string,
  stagingPath: string,
  mapping: TrustedLocalInputMapping,
  ceilings: TrustedLocalInputCeilings,
  alreadyRetained: number,
  seams: TrustedLocalFileSeams = REAL_FILE_SEAMS,
): { readonly byteLength: number; readonly fileSha256: Hash } {
  const label = `the source bound to input ${mapping.inputId}`;
  // Inspected, opened without following, and proved to be the same file on both
  // sides of the open. The bytes below come only from this descriptor; the path
  // is never read again.
  const { fd: sourceFd } = openRegularFileNoFollow(sourcePath, label, seams);
  let stagingFd: number | undefined;
  try {
    stagingFd = openSync(stagingPath, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let byteLength = 0;
    for (;;) {
      const read = readSync(sourceFd, buffer, 0, CHUNK_BYTES, null);
      if (read === 0) break;
      byteLength += read;
      if (byteLength > ceilings.maxInputBytes) {
        throw new Erl2Error(
          CODES.ADAPTER_LOCAL_LIMIT_EXCEEDED,
          `${label} exceeds the ${ceilings.maxInputBytes}-byte single-input trusted-local ceiling`,
        );
      }
      if (alreadyRetained + byteLength > ceilings.maxTotalInputBytes) {
        throw new Erl2Error(
          CODES.ADAPTER_LOCAL_LIMIT_EXCEEDED,
          `the bound inputs exceed the ${ceilings.maxTotalInputBytes}-byte aggregate ` +
            "trusted-local ceiling",
        );
      }
      // Hashed and counted over exactly the slice that is then written in full.
      // The write-all loop is what keeps those three quantities the same bytes.
      hash.update(buffer.subarray(0, read));
      writeAllSync(seams.write, stagingFd, buffer, read, label);
    }
    return { byteLength, fileSha256: `sha256:${hash.digest("hex")}` as Hash };
  } finally {
    seams.close(sourceFd);
    if (stagingFd !== undefined) closeSync(stagingFd);
  }
}

/**
 * One bounded streaming pass over a retained file, for re-verification.
 *
 * Opened with the same no-follow-and-prove-identity discipline as a source. The
 * walk that produced this path already `lstat`ed it, and that check is exactly
 * the one a final-component swap invalidates — so the open repeats it rather
 * than trusting a decision made a moment earlier about a path an attacker with
 * write access to the tree can change.
 */
export function digestRetainedFile(
  absolute: string,
  maxBytes: number,
  seams: TrustedLocalFileSeams = REAL_FILE_SEAMS,
): { readonly byteLength: number; readonly fileSha256: Hash } {
  const { fd } = openRegularFileNoFollow(absolute, `retained input ${absolute}`, seams);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let byteLength = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK_BYTES, null);
      if (read === 0) break;
      byteLength += read;
      if (byteLength > maxBytes) {
        throw new Erl2Error(
          CODES.ADAPTER_LOCAL_LIMIT_EXCEEDED,
          `${absolute} is larger than the ${maxBytes}-byte single-input trusted-local ceiling`,
        );
      }
      hash.update(buffer.subarray(0, read));
    }
    return { byteLength, fileSha256: `sha256:${hash.digest("hex")}` as Hash };
  } finally {
    seams.close(fd);
  }
}

/**
 * The absolute source a `--bind-input` value names, checked before it is read.
 *
 * Exported because the runner has to refuse a bad binding before it creates
 * anything at all, and the same rules must apply whether the refusal happens
 * there or here.
 */
export function assertBoundSource(
  candidate: string,
  inputId: string,
  outputRoot: string,
): string {
  if (!path.isAbsolute(candidate)) {
    throw new Erl2Error(
      CODES.PATH_INVALID_COMPONENT,
      `--bind-input ${inputId} needs an absolute source path; got ${candidate}`,
    );
  }
  const absolute = assertRegularFile(candidate, `source bound to input ${inputId}`);
  const root = path.resolve(outputRoot);
  const forbid = (shown: string): never => {
    throw new Erl2Error(
      CODES.ADAPTER_MOUNT_FORBIDDEN,
      `the source bound to input ${inputId} is inside the run's own output root; a run may not ` +
        `provision itself from the tree it is about to write: ${shown}`,
    );
  };

  // The lexical rule, unchanged and first: it needs no filesystem access and it
  // holds even when nothing has been created yet.
  if (absolute === root || absolute.startsWith(`${root}${path.sep}`)) forbid(absolute);

  // And the same rule again on canonical paths, because the lexical one reads
  // only the spelling. A source at `/elsewhere/link/file.bin`, where `link` is a
  // symlink to the output root, is lexically outside it and physically inside
  // it — the run would be provisioning itself from the tree it is about to
  // write, which is the exact thing the lexical check exists to prevent.
  //
  // Only the *parent* is canonicalized: `assertRegularFile` has already proved
  // the final component is not a symlink, and resolving it would be the one
  // thing this module never does to a final component. Both sides are
  // canonicalized so that platform-level aliases — `/tmp` to `/private/tmp` on
  // macOS, for one — compare as the same place instead of as a violation.
  const realRoot = canonicalOrAbsent(root, `the run's output root`);
  if (realRoot !== undefined) {
    const realParent = canonicalOrAbsent(
      path.dirname(absolute),
      `the directory holding the source bound to input ${inputId}`,
    );
    if (realParent !== undefined) {
      const realSource = path.join(realParent, path.basename(absolute));
      if (realSource === realRoot || realSource.startsWith(`${realRoot}${path.sep}`)) {
        forbid(`${absolute} (resolves to ${realSource})`);
      }
    }
  }
  return absolute;
}

/**
 * A canonical path, or `undefined` when there is nothing there to canonicalize.
 *
 * An output root that does not exist yet cannot be resolved *into*, so absence
 * is the one benign answer. Every other failure refuses: this function feeds a
 * containment check, and a containment check that returns "could not tell" is a
 * containment check that passed.
 */
function canonicalOrAbsent(absolute: string, label: string): string | undefined {
  try {
    return realpathSync(absolute);
  } catch (cause) {
    if (isAbsent(cause)) return undefined;
    throw new Erl2Error(
      CODES.ADAPTER_MOUNT_FORBIDDEN,
      `${label} could not be resolved to a canonical path: ${absolute}`,
      { owner: "lab", cause },
    );
  }
}

/** The plan's input root, with a trailing separator trimmed and its shape checked. */
function normalizedInputRoot(declared: string): string {
  const trimmed = declared.replace(/\/+$/, "");
  if (trimmed === "") {
    throw new Erl2Error(
      CODES.PATH_INVALID_COMPONENT,
      "the plan's resource_limits.input_root is empty",
    );
  }
  assertLogicalSegments(trimmed, "the plan's resource_limits.input_root");
  return trimmed;
}

/** Splits `<input_root>/<mount_id>/<relative>` or refuses the path outright. */
function splitLogicalPath(
  logical: string,
  inputRoot: string,
  inputId: string,
): { readonly mountId: string; readonly relativePath: string } {
  assertLogicalSegments(logical, `input ${inputId}`);
  const prefix = `${inputRoot}/`;
  if (!logical.startsWith(prefix)) {
    throw new Erl2Error(
      CODES.PATH_ESCAPES_ROOT,
      `input ${inputId} names ${logical}, which is outside the plan's input root ${inputRoot}`,
    );
  }
  const segments = logical.slice(prefix.length).split("/");
  const mountId = segments[0] ?? "";
  if (mountId === "") {
    throw new Erl2Error(
      CODES.PATH_INVALID_COMPONENT,
      `input ${inputId} names ${logical}, which has an empty mount id beneath ${inputRoot}`,
    );
  }
  const relativePath = segments.slice(1).join("/");
  if (relativePath === "") {
    throw new Erl2Error(
      CODES.PATH_INVALID_COMPONENT,
      `input ${inputId} names ${logical}, which is a mount root rather than a file inside one; ` +
        `the convention is <input_root>/<mount_id>/<relative-file-path>`,
    );
  }
  return { mountId, relativePath };
}

/**
 * The shape rules `LogicalPath` states, restated here.
 *
 * The contract pattern already refuses most of these, and this is not
 * redundant: these paths become filesystem destinations, and a defence that
 * only exists in a schema is a defence that disappears the moment somebody
 * calls this function with a document that took a different validation route.
 */
function assertLogicalSegments(logical: string, label: string): void {
  if (logical === "") {
    throw new Erl2Error(CODES.PATH_INVALID_COMPONENT, `${label} names an empty path`);
  }
  if (logical.startsWith("/") || path.isAbsolute(logical)) {
    throw new Erl2Error(
      CODES.PATH_INVALID_COMPONENT,
      `${label} names ${logical}, which is absolute; logical paths are root-relative`,
    );
  }
  if (logical.includes("\\") || logical.includes("\0")) {
    throw new Erl2Error(
      CODES.PATH_INVALID_COMPONENT,
      `${label} names ${logical}, which contains a backslash or a NUL`,
    );
  }
  for (const segment of logical.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Erl2Error(
        segment === ".." ? CODES.PATH_ESCAPES_ROOT : CODES.PATH_INVALID_COMPONENT,
        `${label} names ${logical}, which contains an empty, dot or dot-dot segment`,
      );
    }
  }
}

/** The physical destination, re-checked to be beneath the retained root. */
function destinationOf(retainedInputRoot: string, mapping: TrustedLocalInputMapping): string {
  const destination = path.resolve(
    retainedInputRoot,
    mapping.mountId,
    ...mapping.relativePath.split("/"),
  );
  if (!destination.startsWith(`${retainedInputRoot}${path.sep}`)) {
    throw new Erl2Error(
      CODES.PATH_ESCAPES_ROOT,
      `input ${mapping.inputId} would materialize outside the retained input root`,
    );
  }
  return destination;
}

/**
 * Refuses a path that already holds anything at all, symlinks included — and
 * refuses just as firmly when it cannot tell.
 *
 * This is the guard that stands between a run and somebody else's retained
 * evidence, so its failure mode matters more than its success mode. It used to
 * treat *every* `lstat` exception as proof of absence, which meant a permission
 * fault, an I/O fault or a path in an invalid state all read as "nothing here,
 * go ahead" — the one answer that authorises an overwrite. `ENOENT` is the only
 * condition that means the path is empty; everything else means the question
 * was not answered, and an unanswered question is a refusal.
 *
 * The `lstat` seam exists so that "some other errno" can be produced on demand:
 * a permission fault on a path this process just created is not something a
 * test can arrange portably, and the branch would otherwise never be measured.
 */
export function assertAbsentTree(
  absolute: string,
  lstat: TrustedLocalFileSeams["lstat"] = lstatSync,
): void {
  let stats: Stats;
  try {
    stats = lstat(absolute);
  } catch (cause) {
    if (isAbsent(cause)) return;
    throw new Erl2Error(
      CODES.ADMISSION_RETENTION_FAILED,
      `${absolute} could not be inspected before retention; a path that cannot be inspected is ` +
        "not a path that is known to be empty",
      { owner: "lab", cause },
    );
  }
  throw new Erl2Error(
    stats.isSymbolicLink() ? CODES.PATH_SYMLINK_REJECTED : CODES.ADMISSION_RETENTION_FAILED,
    `${absolute} already exists and will not be overwritten; remove the output root to re-run`,
  );
}

/**
 * Every regular file beneath the retained root, as slash-separated paths.
 *
 * `lstat` at every level: a symlink inside the retained tree is a file whose
 * bytes are somewhere else, and rehashing it would verify a file the run never
 * retained. It is refused rather than followed or ignored.
 */
function walkRetained(root: string, refusals: string[]): readonly string[] {
  let rootStats: Stats;
  try {
    rootStats = lstatSync(root);
  } catch (cause) {
    // An absent retained root is only a fact; whether it should have held
    // something is decided by the expected set in the caller. Anything other
    // than absence is the same fail-open shape `assertAbsentTree` carried: a
    // root that cannot be read is not a root that is known to be empty, and
    // reporting it as empty would turn "I could not look" into "nothing is
    // wrong" for every expected file at once.
    if (isAbsent(cause)) return [];
    throw new Erl2Error(
      CODES.ADMISSION_RETENTION_FAILED,
      `the retained input root could not be inspected: ${root}`,
      { owner: "lab", cause },
    );
  }
  if (rootStats.isSymbolicLink()) {
    refusals.push("the retained input root is a symbolic link");
    return [];
  }
  if (!rootStats.isDirectory()) {
    refusals.push("the retained input root is not a directory");
    return [];
  }

  const found: string[] = [];
  const walk = (dir: string, relative: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const absolute = path.join(dir, name);
      const child = relative === "" ? name : `${relative}/${name}`;
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        refusals.push(`the retained input tree holds a symbolic link at ${child}`);
        continue;
      }
      if (stats.isDirectory()) {
        walk(absolute, child);
        continue;
      }
      if (!stats.isFile()) {
        refusals.push(`the retained input tree holds a non-regular file at ${child}`);
        continue;
      }
      found.push(child);
    }
  };
  walk(root, "");
  return found;
}

/** Exported for the runner's own pre-flight, which refuses before it creates anything. */
export function retainedInputRootOf(outputRoot: string): string {
  return path.join(path.resolve(outputRoot), TRUSTED_LOCAL_INPUTS_DIR);
}
