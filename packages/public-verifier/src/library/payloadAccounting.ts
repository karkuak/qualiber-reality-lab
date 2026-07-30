/**
 * Complete accounting of the subject-output payload root (ADR-ERL2-029 §5,
 * review P2: *retained subject-output payloads have no presence or extra-file
 * accounting in the offline verifier*).
 *
 * Two layers already touch these bytes and neither closes the hole:
 *
 *   - `verifyReferencedBytes` rehashes a declared payload's digest and length,
 *     and refuses symlinks and traversal — **but only if the file is present.**
 *     A missing non-content-addressed payload is silently skipped
 *     (`referencedBytes.ts`: "a working-copy reference may legitimately be
 *     scrubbed from a retained bundle").  That allowance is right for `raw/` and
 *     wrong for a payload the terminal's own manifest declares.
 *   - `verifyRetainedFileAccounting` requires every file under `retained/` to be
 *     accounted, and says so itself in passing: a step outcome's second copy
 *     "lives under `subject-output/`, **outside this subtree**".
 *
 * So the manifest's JSON was validated and its payload directory was accounted in
 * neither direction: a declared payload could be absent, and an undeclared file
 * could sit beside the real ones, and both verified at exit 0 / `valid`.
 *
 * ## What this is not
 *
 * Byte correspondence, not content inspection.  Nothing here scans a payload for
 * secrets, canaries or forbidden identifiers, and nothing enforces the declared
 * subject-output size ceiling — both are producer-side defects with their own
 * evidence, and closing a producer scanning gap from inside the verifier would
 * invert the direction of the guarantee (ADR-ERL2-029 §5.3, §9).
 */

import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { CODES, Erl2Error, type Hash, type LabLifecycleEventV1 } from "@erl2/contracts";
import { hashBytes, hashesEqual } from "@erl2/integrity";
import type { ArtifactIndex } from "./artifactIndex.js";
import { collectReferencedDescriptors } from "./referencedBytes.js";

/**
 * The authorized payload root, from the design's filesystem layout (design v2
 * §14).  A declared entry that resolves outside it is a path escape, not a
 * differently-rooted payload.
 */
const PAYLOAD_ROOT = "subject-output";

/** The freeze-marker suffix written beside a frozen content file. */
const MARKER_SUFFIX = ".frozen";

/** One declared payload, as the manifest states it. */
interface DeclaredPayload {
  readonly declaredPath: string;
  readonly fileSha256: string;
  readonly byteLength: number;
  readonly manifestPath: string;
}

export interface PayloadAccountingReport {
  readonly payloadsChecked: number;
  readonly manifestsChecked: number;
}

/** Normalizes a declared path to the forward-slash form the walk produces. */
function normalize(declaredPath: string): string {
  return path.normalize(declaredPath).split(path.sep).join("/");
}

/** Collects every regular file and non-file entry beneath the payload root. */
function walkPayloadRoot(
  absolute: string,
  relative: string,
  out: Map<string, "file" | "other">,
): void {
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    const childAbs = path.join(absolute, name);
    const childRel = `${relative}/${name}`;
    let info;
    try {
      info = lstatSync(childAbs);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) {
      // Never accounted evidence: it can point anywhere and its bytes are not
      // the retained bytes.
      out.set(childRel, "other");
      continue;
    }
    if (info.isDirectory()) {
      walkPayloadRoot(childAbs, childRel, out);
      continue;
    }
    out.set(childRel, info.isFile() ? "file" : "other");
  }
}

/**
 * Reads a declared payload strictly beneath the artifact root, refusing a path
 * escape, a symlink, a directory and a non-regular file.
 */
function readDeclared(root: string, payload: DeclaredPayload): Buffer {
  const declared = payload.declaredPath;
  if (declared.length === 0 || path.isAbsolute(declared) || declared.includes("\0")) {
    throw new Erl2Error(
      CODES.SUBJECT_OUTPUT_PATH_ESCAPE,
      `subject-output manifest ${payload.manifestPath} declares payload path ` +
        `${JSON.stringify(declared)}, which is empty, absolute or malformed`,
    );
  }
  const normalized = normalize(declared);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    !(normalized === PAYLOAD_ROOT || normalized.startsWith(`${PAYLOAD_ROOT}/`))
  ) {
    throw new Erl2Error(
      CODES.SUBJECT_OUTPUT_PATH_ESCAPE,
      `subject-output manifest ${payload.manifestPath} declares payload ${declared}, which is ` +
        `outside the authorized payload root ${PAYLOAD_ROOT}/`,
    );
  }

  const rootReal = realpathSync(root);
  const absolute = path.resolve(rootReal, normalized);
  const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  if (!absolute.startsWith(prefix)) {
    throw new Erl2Error(
      CODES.SUBJECT_OUTPUT_PATH_ESCAPE,
      `subject-output payload ${declared} resolves outside the artifact root`,
    );
  }

  let info;
  try {
    info = lstatSync(absolute);
  } catch {
    // The gap this module exists for: a declared payload that is simply not
    // there. `verifyReferencedBytes` skips it; a terminal's own manifest may not.
    throw new Erl2Error(
      CODES.ARTIFACT_NOT_FOUND,
      `subject-output manifest ${payload.manifestPath} declares payload ${declared}, which is ` +
        `not retained; a declared payload is not optional`,
    );
  }
  if (info.isSymbolicLink()) {
    throw new Erl2Error(
      CODES.PATH_SYMLINK_REJECTED,
      `subject-output payload ${declared} is a symlink`,
    );
  }
  if (!info.isFile()) {
    throw new Erl2Error(
      CODES.PATH_NOT_REGULAR_FILE,
      `subject-output payload ${declared} is not a regular file`,
    );
  }
  if (realpathSync(absolute) !== absolute) {
    throw new Erl2Error(
      CODES.PATH_SYMLINK_REJECTED,
      `subject-output payload ${declared} resolves through a symlink`,
    );
  }
  return readFileSync(absolute);
}

/**
 * Accounts every byte of the subject-output payload root against the manifests
 * the lifecycle reached, in both directions.
 *
 * Descriptor → bytes: every declared payload exists, is a regular file, matches
 * its declared length and digest exactly, and is declared exactly once.
 *
 * Bytes → descriptor: every regular file beneath the payload root is a declared
 * payload or the freeze marker of one.  Anything else is a rejected extra.
 */
export function verifySubjectOutputPayloads(options: {
  readonly index: ArtifactIndex;
  readonly lifecycle: readonly LabLifecycleEventV1[];
}): PayloadAccountingReport {
  const root = options.index.root;

  // The manifests the *lifecycle* reached, never a producer-supplied list: a
  // manifest retained but unreached is the closure's problem, and a manifest
  // reached but unretained is already a missing-role refusal. Counted for the
  // report and used to decide applicability; the declared set below is wider.
  const reachedManifestHashes = new Set<Hash>();
  for (const event of options.lifecycle) {
    for (const produced of event.produced) {
      if (produced.artifact_role === "subject-output-manifest") {
        reachedManifestHashes.add(produced.artifact_core_hash);
      }
    }
  }
  if (reachedManifestHashes.size === 0) return { payloadsChecked: 0, manifestsChecked: 0 };

  // -- descriptor -> bytes ---------------------------------------------------
  //
  // Declared payloads come from **every** indexed artifact's descriptors, not
  // from the subject-output manifest alone — deliberately, and from exactly the
  // source `retainedFiles.ts` rule 3 uses, so the two accountings cannot drift
  // apart.
  //
  // The manifest declares the step-outcome copies. The subject's own raw output
  // bytes are declared one level down, by each step outcome's `output_refs`
  // (`environmentRun.ts`: `subject-output/steps/<step_id>.out`). Accounting only
  // against the manifest would have called every one of those an undeclared
  // extra — which is a rule refusing the shipped producer, not a defect.
  const declaredByPath = new Map<string, DeclaredPayload>();
  for (const descriptor of collectReferencedDescriptors(options.index)) {
    const normalized = normalize(descriptor.declaredPath);
    if (normalized !== PAYLOAD_ROOT && !normalized.startsWith(`${PAYLOAD_ROOT}/`)) continue;
    if (descriptor.byteLength === undefined) {
      throw new Erl2Error(
        CODES.SUBJECT_OUTPUT_CONTRACT_INVALID,
        `${descriptor.origin} declares subject-output payload ${descriptor.declaredPath} with no ` +
          `byte_length; a payload descriptor must state the length it claims`,
      );
    }
    const existing = declaredByPath.get(normalized);
    if (existing !== undefined) {
      // Redeclaring the *same* bytes is not a smuggling vector — two artifacts
      // may honestly name one payload. Declaring one path with two different
      // digests or lengths is a contradiction about what the file is, and the
      // accounting below would mark it satisfied by whichever it checked first.
      if (
        existing.fileSha256.toLowerCase() !== descriptor.fileSha256.toLowerCase() ||
        existing.byteLength !== descriptor.byteLength
      ) {
        throw new Erl2Error(
          CODES.SUBJECT_OUTPUT_PATH_ESCAPE,
          `subject-output payload ${normalized} is declared with conflicting descriptors by ` +
            `${existing.manifestPath} and ${descriptor.origin}`,
        );
      }
      continue;
    }
    declaredByPath.set(normalized, {
      declaredPath: descriptor.declaredPath,
      fileSha256: descriptor.fileSha256,
      byteLength: descriptor.byteLength,
      manifestPath: descriptor.origin,
    });
  }

  for (const payload of declaredByPath.values()) {
    const bytes = readDeclared(root, payload);
    // Defence in depth: `verifyReferencedBytes` already rehashes a *present*
    // payload, and on the shipped ordering it refuses a tampered one first. Kept
    // so this module is complete on its own terms rather than complete only in
    // the composition that happens to call it.
    if (bytes.byteLength !== payload.byteLength) {
      throw new Erl2Error(
        CODES.ARTIFACT_HASH_MISMATCH,
        `subject-output payload ${payload.declaredPath} has ${String(bytes.byteLength)} bytes, ` +
          `not the declared ${String(payload.byteLength)}`,
      );
    }
    if (!hashesEqual(hashBytes(bytes), payload.fileSha256 as Hash)) {
      throw new Erl2Error(
        CODES.ARTIFACT_HASH_MISMATCH,
        `subject-output payload ${payload.declaredPath} does not match its declared file_sha256`,
      );
    }
  }

  // -- bytes -> descriptor ---------------------------------------------------
  const payloadRootAbs = path.join(root, PAYLOAD_ROOT);
  let rootInfo;
  try {
    rootInfo = lstatSync(payloadRootAbs);
  } catch {
    // No payload directory at all. Legal only if nothing was declared — and if
    // something was, `readDeclared` already refused it above.
    return { payloadsChecked: declaredByPath.size, manifestsChecked: reachedManifestHashes.size };
  }
  if (!rootInfo.isDirectory()) {
    throw new Erl2Error(
      CODES.PATH_NOT_REGULAR_FILE,
      `${PAYLOAD_ROOT} beneath the artifact root is not a directory`,
    );
  }

  const present = new Map<string, "file" | "other">();
  walkPayloadRoot(payloadRootAbs, PAYLOAD_ROOT, present);

  for (const [relative, kind] of present) {
    if (kind === "file" && declaredByPath.has(relative)) continue;
    // A freeze marker is accounted by the payload it seals, never on its own.
    if (kind === "file" && relative.endsWith(MARKER_SUFFIX)) {
      const sealed = relative.slice(0, -MARKER_SUFFIX.length);
      if (declaredByPath.has(sealed)) continue;
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
        `subject-output carries freeze marker ${relative} for ${sealed}, which no reached ` +
          `subject-output manifest declares`,
      );
    }
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      kind === "file"
        ? `subject-output file ${relative} is declared by no reached subject-output manifest`
        : `subject-output entry ${relative} is not a regular file and cannot be accounted evidence`,
    );
  }

  return { payloadsChecked: declaredByPath.size, manifestsChecked: reachedManifestHashes.size };
}
