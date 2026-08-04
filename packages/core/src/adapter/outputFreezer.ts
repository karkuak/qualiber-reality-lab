/**
 * Subject-output freezing and bounded diagnostic scanning (design v2 §14/§21,
 * ERL2-SEC-004, ERL2-FR-007).
 *
 * The adapter writes into a temporary run-scoped output directory. The freezer
 * then:
 *
 *   1. walks that directory refusing symlinks, hard links, special files, path
 *      escapes, over-deep paths and over-large or over-numerous entries;
 *   2. scans every byte for judge canaries, secret canaries and forbidden
 *      identifiers;
 *   3. redacts diagnostics and truncates them at the declared bound, saying so;
 *   4. inventories, fsyncs, atomically publishes and freezes.
 *
 * After the freeze the output is immutable and no adapter or subject process
 * may run again for this run: `assertNoExecutionAfterOutputFreeze` is the gate,
 * and the host calls it before every dispatch.
 */

import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  assertContract,
  CODES,
  Erl2Error,
  type ArtifactRef,
  type Hash,
  type Instant,
  type SubjectDiagnosticsManifestV1,
} from "@erl2/contracts";
import { ArtifactStore, coreHash, treeHash } from "@erl2/integrity";

export interface OutputBounds {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxPathDepth: number;
  readonly maxDiagnosticBytes: number;
  readonly allowedMediaTypes: readonly string[];
}

export const DEFAULT_OUTPUT_BOUNDS: OutputBounds = {
  maxFiles: 64,
  maxTotalBytes: 1024 * 1024,
  maxPathDepth: 6,
  maxDiagnosticBytes: 64 * 1024,
  allowedMediaTypes: ["application/json", "text/plain", "application/octet-stream"],
};

/** Identifiers that must never appear in retained adapter output or diagnostics. */
export const FORBIDDEN_OUTPUT_IDENTIFIERS = [
  "erl2-canary-",
  "erl2-secret-",
  "BEGIN RSA PRIVATE KEY",
  "BEGIN OPENSSH PRIVATE KEY",
  "BEGIN PRIVATE KEY",
  "aws_secret_access_key",
  "AGE-SECRET-KEY-",
] as const;

const JUDGE_CANARY = /erl2-canary-[0-9a-f]{32}/g;
const SECRET_CANARY = /erl2-secret-[0-9a-f]{32}/g;
const SCANNER_VERSION = "erl2-diagnostic-scanner/1";

export interface CollectedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly bytes: Buffer;
}

/**
 * The retained root every adapter-produced byte-stream is published beneath.
 *
 * `subject-output/` is the design's payload root (design v2 §14), and the
 * offline verifier accounts it in *both* directions: a declared payload that is
 * absent is a refusal, and a file present there that no retained descriptor
 * declares is a rejected extra (`payloadAccounting.ts`). Publishing adapter
 * output and diagnostics anywhere else would put them in a subtree no
 * accounting pass walks — which is how they were previously retained beside the
 * evidence rather than inside it.
 */
export const SUBJECT_OUTPUT_LOGICAL_ROOT = "subject-output";

/** Where one operation's redacted diagnostics entries are published. */
export const DIAGNOSTICS_LOGICAL_ROOT = `${SUBJECT_OUTPUT_LOGICAL_ROOT}/diagnostics`;

/** Where one operation's admitted output tree is published. */
export const ADAPTER_OUTPUT_LOGICAL_ROOT = `${SUBJECT_OUTPUT_LOGICAL_ROOT}/adapter`;

/**
 * The deterministic, operation-scoped logical prefix for an operation's output.
 *
 * Operation ids are Lab-authored and unique within a run (`op-acquire`,
 * `op-verify-package`, `op-step-<n>`), so two operations can never collide and
 * the same operation replayed produces the same path — which is what makes the
 * store's identical-bytes freeze idempotent rather than a conflict.
 */
export function adapterOutputPrefix(operationId: string): string {
  return `${ADAPTER_OUTPUT_LOGICAL_ROOT}/${operationId}`;
}

/**
 * Walks a directory the adapter wrote, enforcing every structural bound before
 * a single byte is admitted.
 */
export function collectBoundedTree(root: string, bounds: OutputBounds): readonly CollectedFile[] {
  const out: CollectedFile[] = [];
  let totalBytes = 0;

  const walk = (dir: string, relative: string, depth: number): void => {
    if (depth > bounds.maxPathDepth) {
      throw new Erl2Error(
        CODES.SUBJECT_OUTPUT_LIMIT_EXCEEDED,
        `output path depth exceeds ${String(bounds.maxPathDepth)} at ${relative}`,
        { owner: "adapter" },
      );
    }
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const absolute = path.join(dir, name);
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      // lstat, never stat: a symlink must be seen as a symlink.
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        throw new Erl2Error(
          CODES.PATH_SYMLINK_REJECTED,
          `adapter output contains a symlink at ${childRelative}`,
          { owner: "adapter" },
        );
      }
      if (stats.isDirectory()) {
        walk(absolute, childRelative, depth + 1);
        continue;
      }
      if (!stats.isFile()) {
        throw new Erl2Error(
          CODES.PATH_NOT_REGULAR_FILE,
          `adapter output contains a non-regular file at ${childRelative}`,
          { owner: "adapter" },
        );
      }
      if (stats.nlink > 1) {
        // A hard link lets bytes outside the output tree be published as if the
        // adapter had produced them.
        throw new Erl2Error(
          CODES.PATH_HARD_LINK_REJECTED,
          `adapter output entry ${childRelative} has ${String(stats.nlink)} links`,
          { owner: "adapter" },
        );
      }
      if (name.includes("..") || name.startsWith("/") || name.includes("\\")) {
        throw new Erl2Error(
          CODES.SUBJECT_OUTPUT_PATH_ESCAPE,
          `adapter output entry ${childRelative} uses a forbidden path component`,
          { owner: "adapter" },
        );
      }
      if (out.length + 1 > bounds.maxFiles) {
        throw new Erl2Error(
          CODES.SUBJECT_OUTPUT_LIMIT_EXCEEDED,
          `adapter output exceeds ${String(bounds.maxFiles)} files`,
          { owner: "adapter" },
        );
      }
      totalBytes += stats.size;
      if (totalBytes > bounds.maxTotalBytes) {
        throw new Erl2Error(
          CODES.SUBJECT_OUTPUT_LIMIT_EXCEEDED,
          `adapter output exceeds ${String(bounds.maxTotalBytes)} bytes`,
          { owner: "adapter" },
        );
      }
      out.push({ relativePath: childRelative, absolutePath: absolute, bytes: readFileSync(absolute) });
    }
  };

  try {
    if (!statSync(root).isDirectory()) return out;
  } catch {
    return out;
  }
  walk(root, "", 1);
  return out;
}

export interface ScanCounts {
  readonly judgeCanaries: number;
  readonly secretCanaries: number;
  readonly forbiddenIdentifiers: number;
}

export function scanBytes(text: string): ScanCounts {
  const judge = text.match(JUDGE_CANARY)?.length ?? 0;
  const secret = text.match(SECRET_CANARY)?.length ?? 0;
  let forbidden = 0;
  for (const token of FORBIDDEN_OUTPUT_IDENTIFIERS) {
    if (token === "erl2-canary-" || token === "erl2-secret-") continue;
    if (text.includes(token)) forbidden += 1;
  }
  return { judgeCanaries: judge, secretCanaries: secret, forbiddenIdentifiers: forbidden };
}

/**
 * Refuses admitted output that carries a canary.
 *
 * A judge canary in subject output means the oracle partition failed and the
 * run is invalid before any subject attribution; a secret canary means a
 * credential reached retained bytes. Neither is a subject-quality result.
 */
export function assertOutputClean(files: readonly CollectedFile[]): void {
  for (const file of files) {
    const counts = scanBytes(file.bytes.toString("latin1"));
    if (counts.judgeCanaries > 0) {
      throw new Erl2Error(
        "JOURNEY_ORACLE_CANARY_LEAKED",
        `a judge canary reached adapter output at ${file.relativePath}`,
        { owner: "lab" },
      );
    }
    if (counts.secretCanaries > 0) {
      throw new Erl2Error(
        CODES.SECRET_CANARY_IN_SUBJECT_OUTPUT,
        `a secret canary reached adapter output at ${file.relativePath}`,
        { owner: "lab" },
      );
    }
    if (counts.forbiddenIdentifiers > 0) {
      throw new Erl2Error(
        CODES.SECRET_PLAINTEXT_IN_CONTRACT,
        `adapter output at ${file.relativePath} contains a forbidden identifier`,
        { owner: "lab" },
      );
    }
  }
}

/**
 * One retained subject-output payload, as the bytes actually on disk.
 *
 * `path` is the Lab-authored logical path, kept for diagnosis; it is never the
 * payload's content, so naming it cannot republish what the scan refused.
 */
export interface RetainedSubjectOutputPayload {
  readonly path: string;
  readonly bytes: Buffer;
}

/**
 * Total retained subject-output payload bytes.
 *
 * Byte counting, stated exactly, because every loose reading of it is a way to
 * hide a total:
 *
 * - the unit is the **byte**, from `Buffer.byteLength`, never the JavaScript
 *   character. A multibyte UTF-8 payload counts more bytes than it has
 *   characters, and the ceiling is a retention bound on bytes;
 * - the bytes counted are the ones **read back from the store**, never a
 *   descriptor's `byte_length`, a manifest total or a file name. A declared
 *   length is the producer's claim about the payload, not the payload;
 * - every *occurrence* counts. Two references naming one path are two exposures
 *   of those bytes and count twice; deduplicating by path would let a duplicated
 *   reference shrink the measured total below the real one;
 * - nothing is decoded, decompressed or re-encoded first. The retained bytes are
 *   what the ceiling governs, whatever they encode.
 *
 * The running total is asserted to stay an exact integer at every step, so the
 * comparison against the ceiling can never be made against a value that silently
 * lost precision.
 */
export function subjectOutputPayloadByteTotal(
  payloads: readonly RetainedSubjectOutputPayload[],
): number {
  let total = 0;
  for (const payload of payloads) {
    total += payload.bytes.byteLength;
    if (!Number.isSafeInteger(total)) {
      throw new Erl2Error(
        CODES.SUBJECT_OUTPUT_LIMIT_EXCEEDED,
        "retained subject output exceeds any exactly representable byte total",
        { owner: "lab" },
      );
    }
  }
  return total;
}

/**
 * Enforces the run's **declared** subject-output byte ceiling against the bytes
 * the subject actually produced.
 *
 * The ceiling is `SubjectExecutionPlanV1.limits.output_bytes` — the value the
 * run froze into its own execution plan and hashed into every step request's
 * `resource_limit_hash`. It is deliberately not the adapter host's output-tree
 * bound, not the diagnostics bound, and not any flag: a limit a caller can move
 * at the moment of enforcement is not a commitment.
 *
 * Exactly at the ceiling is admitted; one byte over is refused. The message
 * carries two integers and no payload byte.
 */
export function assertSubjectOutputWithinDeclaredBytes(
  payloads: readonly RetainedSubjectOutputPayload[],
  declaredOutputBytes: number,
): void {
  const total = subjectOutputPayloadByteTotal(payloads);
  if (total > declaredOutputBytes) {
    throw new Erl2Error(
      CODES.SUBJECT_OUTPUT_LIMIT_EXCEEDED,
      `retained subject output is ${String(total)} bytes against a declared ceiling of ${String(declaredOutputBytes)}`,
      { owner: "lab" },
    );
  }
}

/**
 * Scans retained subject-output payload bytes for secrets.
 *
 * Deliberately **not** a judge-canary gate. The judge-canary rule on this
 * surface is owned by the `subject_output_prefill` oracle scan that runs just
 * before this one, and that scan has a load-bearing negative control proving it.
 * A second gate answering the same question with the same code would make that
 * control kill nothing — it would still refuse, from here — and retire the only
 * evidence that the first scan works. So this closes exactly the two rules the
 * environment subject-output surface had no gate for at all.
 *
 * The vocabulary is the established one: `scanBytes` and
 * `FORBIDDEN_OUTPUT_IDENTIFIERS`, the same definitions the adapter host's output
 * and diagnostics paths already enforce. Inventing a second forbidden-token list
 * would mean two answers to one question.
 *
 * Matching is over `latin1`, which is a byte-for-byte view: a payload that is
 * not valid UTF-8 is scanned as it is rather than mangled into replacement
 * characters that could break a token apart.
 *
 * Both refusals are **Lab-owned**. A secret or an identifier in retained output
 * is an evidence-boundary failure of the Lab's own partition; it is not a
 * finding about the subject's behaviour and must never be attributed as one.
 */
export function assertSubjectOutputContentClean(
  payloads: readonly RetainedSubjectOutputPayload[],
): void {
  for (const payload of payloads) {
    const counts = scanBytes(payload.bytes.toString("latin1"));
    if (counts.secretCanaries > 0) {
      throw new Erl2Error(
        CODES.SECRET_CANARY_IN_SUBJECT_OUTPUT,
        `a secret canary reached retained subject output at ${payload.path}`,
        { owner: "lab" },
      );
    }
    if (counts.forbiddenIdentifiers > 0) {
      throw new Erl2Error(
        CODES.SECRET_PLAINTEXT_IN_CONTRACT,
        `retained subject output at ${payload.path} carries a forbidden identifier`,
        { owner: "lab" },
      );
    }
  }
}

export function redact(text: string): { readonly text: string; readonly redactions: number } {
  let redactions = 0;
  let out = text.replace(SECRET_CANARY, () => {
    redactions += 1;
    return "[redacted-secret]";
  });
  out = out.replace(JUDGE_CANARY, () => {
    redactions += 1;
    return "[redacted-canary]";
  });
  for (const token of FORBIDDEN_OUTPUT_IDENTIFIERS) {
    if (token === "erl2-canary-" || token === "erl2-secret-") continue;
    if (out.includes(token)) {
      out = out.replaceAll(token, "[redacted-identifier]");
      redactions += 1;
    }
  }
  return { text: out, redactions };
}

export interface FreezeDiagnosticsOptions {
  readonly runId: string;
  readonly operationId: string;
  readonly diagnosticsRoot: string;
  readonly store: ArtifactStore;
  readonly bounds: OutputBounds;
  readonly frozenAt: Instant;
}

/**
 * Scans, redacts, truncates and freezes an operation's diagnostics.
 *
 * Diagnostics are redacted rather than refused: they are the operator-facing
 * trail, and losing them entirely would hide the failure that produced them.
 * The counts of what was found are retained, so a leak is visible even after
 * the bytes are gone.
 */
export function freezeDiagnostics(
  options: FreezeDiagnosticsOptions,
): SubjectDiagnosticsManifestV1 {
  const files = collectBoundedTree(options.diagnosticsRoot, {
    ...options.bounds,
    maxTotalBytes: Math.max(options.bounds.maxDiagnosticBytes * 4, options.bounds.maxDiagnosticBytes),
  });

  let judge = 0;
  let secret = 0;
  let forbidden = 0;
  let redactions = 0;
  let truncated = false;
  let budget = options.bounds.maxDiagnosticBytes;
  const entries: ArtifactRef[] = [];

  for (const file of files) {
    const raw = file.bytes.toString("utf8");
    const counts = scanBytes(raw);
    judge += counts.judgeCanaries;
    secret += counts.secretCanaries;
    forbidden += counts.forbiddenIdentifiers;
    const cleaned = redact(raw);
    redactions += cleaned.redactions;

    let body = cleaned.text;
    if (Buffer.byteLength(body, "utf8") > budget) {
      body = Buffer.from(body, "utf8").subarray(0, Math.max(budget, 0)).toString("utf8");
      truncated = true;
    }
    budget -= Buffer.byteLength(body, "utf8");
    entries.push(
      options.store.freeze({
        logicalPath: `${DIAGNOSTICS_LOGICAL_ROOT}/${options.operationId}/${file.relativePath}`,
        bytes: Buffer.from(body, "utf8"),
        mediaType: "text/plain",
        classification: "INTERNAL",
      }),
    );
    if (budget <= 0) {
      truncated = truncated || files.indexOf(file) < files.length - 1;
      break;
    }
  }

  const totalBytes = entries.reduce((sum, e) => sum + e.byte_length, 0);
  const base = {
    schema_version: "subject-diagnostics-manifest/v1" as const,
    run_id: options.runId,
    operation_id: options.operationId,
    entries,
    tree_hash: treeHash(entries),
    total_bytes: totalBytes,
    truncated,
    ...(truncated ? { truncation_reason_code: CODES.ADAPTER_DIAGNOSTICS_LIMIT_EXCEEDED } : {}),
    scan: {
      scanner_version: SCANNER_VERSION,
      secret_canaries_found: secret,
      judge_canaries_found: judge,
      forbidden_identifiers_found: forbidden,
      redactions_applied: redactions,
    },
    frozen_at: options.frozenAt,
  };
  return assertContract<SubjectDiagnosticsManifestV1>("SubjectDiagnosticsManifestV1", {
    ...base,
    core_hash: coreHash(base),
  });
}

export interface FreezeOutputOptions {
  readonly outputRoot: string;
  readonly store: ArtifactStore;
  readonly logicalPrefix: string;
  readonly bounds: OutputBounds;
}

/**
 * Inventories and freezes the adapter's output tree.
 *
 * Publication is the store's temporary-write → validate → fsync → atomic
 * publish → freeze-marker protocol, so a crash leaves either a complete frozen
 * artifact or none.
 */
export function freezeAdapterOutput(options: FreezeOutputOptions): {
  readonly entries: readonly ArtifactRef[];
  readonly treeHash: Hash;
} {
  const files = collectBoundedTree(options.outputRoot, options.bounds);
  assertOutputClean(files);
  const entries = files.map((file) =>
    options.store.freeze({
      logicalPath: `${options.logicalPrefix}/${file.relativePath}`,
      bytes: file.bytes,
      mediaType: file.relativePath.endsWith(".json") ? "application/json" : "text/plain",
      classification: "INTERNAL",
    }),
  );
  return { entries, treeHash: treeHash(entries) };
}

/**
 * The post-freeze gate.
 *
 * Once subject output is frozen — or once any reveal has happened — no adapter
 * or subject process may run again for this run.
 */
export function assertNoExecutionAfterOutputFreeze(outputFrozen: boolean, what: string): void {
  if (outputFrozen) {
    throw new Erl2Error(
      CODES.ADAPTER_EXECUTION_AFTER_OUTPUT_FREEZE,
      `${what} is forbidden after subject output freezes`,
      { owner: "lab" },
    );
  }
}
