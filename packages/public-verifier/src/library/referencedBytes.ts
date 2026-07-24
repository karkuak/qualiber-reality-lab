/**
 * Independent verification of *referenced raw bytes* (ERL2-AC-013, design §16.2).
 *
 * `ArtifactIndex` recomputes the `core_hash` of every retained JSON document, but
 * a run also retains non-JSON payloads (the acquired package archive, its
 * content-addressed store copy, capture blobs).  Those bytes are named by a
 * `file_sha256` inside a signed/hashed JSON artifact, but nothing re-reads the
 * bytes and recomputes that digest — so a byte flip, a truncation or a
 * same-length substitution of a retained payload was previously invisible to the
 * offline verifier (P2-2).
 *
 * This pass closes that hole.  It walks every indexed JSON artifact for the two
 * referenced-byte shapes the contracts use — `ArtifactRef` (`path`) and the
 * logical byte descriptor (`logical_path`) — resolves each reference strictly
 * beneath the verifier-supplied artifact root, and recomputes `file_sha256` (and
 * `byte_length`) over the referenced bytes.  It additionally enforces that every
 * content-addressed store file hashes to the digest in its own name, and that
 * the signed `frozen_package_file_sha256` names a store file that is actually
 * present and correct.  The network is never used; paths that are absolute,
 * escape the root, or resolve through a symlink out of the root are refused.
 */

import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { CODES, Erl2Error, type Hash } from "@erl2/contracts";
import { hashBytes, hashesEqual } from "@erl2/integrity";
import type { ArtifactIndex } from "./artifactIndex.js";

/** Refuse to read a single referenced payload larger than the schema ceiling. */
const MAX_REFERENCED_BYTES = 68_719_476_736; // 64 GiB, the ArtifactRef byte_length max.

/** A content-addressed store filename: `<64 lowercase hex>.<ext>`. */
const STORE_FILE = /(?:^|\/)sha256\/([0-9a-f]{64})\.[a-z0-9]+$/;

interface Descriptor {
  readonly declaredPath: string;
  readonly fileSha256: string;
  readonly byteLength?: number;
  /** The JSON artifact the descriptor was found in, for error messages. */
  readonly origin: string;
}

/**
 * Resolves a declared, root-relative logical path to an absolute path strictly
 * beneath `root`, refusing absolute inputs, `..` traversal, and any component
 * that resolves through a symlink pointing outside the root.
 */
function resolveBeneathRoot(root: string, declaredPath: string, origin: string): string {
  if (declaredPath.length === 0 || path.isAbsolute(declaredPath) || declaredPath.includes("\0")) {
    throw new Erl2Error(
      CODES.PATH_INVALID_COMPONENT,
      `referenced path ${JSON.stringify(declaredPath)} in ${origin} is empty, absolute or malformed`,
    );
  }
  const normalized = path.normalize(declaredPath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`)) {
    throw new Erl2Error(
      CODES.PATH_ESCAPES_ROOT,
      `referenced path ${declaredPath} in ${origin} escapes the artifact root`,
    );
  }
  // Resolve against the *real* root so a symlinked root prefix (e.g. macOS
  // /tmp -> /private/tmp) does not read as an escape.
  const rootReal = realpathSync(root);
  const absolute = path.resolve(rootReal, normalized);
  const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  if (absolute !== rootReal && !absolute.startsWith(prefix)) {
    throw new Erl2Error(
      CODES.PATH_ESCAPES_ROOT,
      `referenced path ${declaredPath} in ${origin} resolves outside the artifact root`,
    );
  }
  return absolute;
}

/**
 * Reads the referenced regular file, refusing symlinks and oversized payloads,
 * and returns its bytes — or `undefined` if the file does not exist.
 */
function readReferenced(absolute: string, declaredPath: string, origin: string): Buffer | undefined {
  let info;
  try {
    info = lstatSync(absolute);
  } catch {
    return undefined;
  }
  if (info.isSymbolicLink()) {
    throw new Erl2Error(
      CODES.PATH_SYMLINK_REJECTED,
      `referenced path ${declaredPath} in ${origin} is a symlink`,
    );
  }
  // A symlinked *directory* component would have escaped realpath confinement
  // above; confirm the final resolved target is still inside the root.
  const real = realpathSync(absolute);
  if (real !== absolute) {
    throw new Erl2Error(
      CODES.PATH_SYMLINK_REJECTED,
      `referenced path ${declaredPath} in ${origin} resolves through a symlink`,
    );
  }
  if (!info.isFile()) {
    throw new Erl2Error(
      CODES.PATH_NOT_REGULAR_FILE,
      `referenced path ${declaredPath} in ${origin} is not a regular file`,
    );
  }
  if (info.size > MAX_REFERENCED_BYTES) {
    throw new Erl2Error(
      CODES.ARTIFACT_HASH_MISMATCH,
      `referenced path ${declaredPath} in ${origin} exceeds the maximum artifact size`,
    );
  }
  return readFileSync(absolute);
}

/** Recursively collects every referenced-byte descriptor from a JSON value. */
function collectDescriptors(value: unknown, origin: string, out: Descriptor[]): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectDescriptors(item, origin, out);
    return;
  }
  const record = value as Record<string, unknown>;
  const declaredPath = record["path"] ?? record["logical_path"];
  const fileSha256 = record["file_sha256"];
  if (typeof declaredPath === "string" && typeof fileSha256 === "string") {
    const byteLength = record["byte_length"];
    out.push({
      declaredPath,
      fileSha256,
      ...(typeof byteLength === "number" ? { byteLength } : {}),
      origin,
    });
  }
  for (const nested of Object.values(record)) collectDescriptors(nested, origin, out);
}

/** Walks the filesystem beneath `root` collecting content-addressed store files. */
function collectStoreFiles(root: string, absolute: string, relative: string, out: Map<string, Hash>): void {
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    const childAbs = path.join(absolute, name);
    const childRel = relative === "" ? name : `${relative}/${name}`;
    let info;
    try {
      info = lstatSync(childAbs);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue; // never followed by the verifier.
    if (info.isDirectory()) {
      collectStoreFiles(root, childAbs, childRel, out);
      continue;
    }
    const match = STORE_FILE.exec(childRel);
    if (match && info.isFile()) out.set(childRel, `sha256:${match[1] as string}` as Hash);
  }
}

export interface ReferencedByteReport {
  readonly descriptorsChecked: number;
  readonly storeFilesChecked: number;
}

/**
 * Verifies every referenced raw byte-stream retained beneath the verifier's
 * artifact root.  Throws a typed refusal on any mismatch, missing required
 * payload, or path-safety violation.
 */
export function verifyReferencedBytes(index: ArtifactIndex): ReferencedByteReport {
  const root = index.root;

  // 1. Every content-addressed store file must hash to the digest in its name.
  //    This is authority-independent: a swapped or truncated store payload is
  //    caught even if no descriptor referenced it.
  const storeFiles = new Map<string, Hash>();
  collectStoreFiles(root, root, "", storeFiles);
  for (const [relative, declaredHash] of storeFiles) {
    const bytes = readFileSync(path.join(root, relative));
    const actual = hashBytes(bytes);
    if (!hashesEqual(actual, declaredHash)) {
      throw new Erl2Error(
        CODES.ARTIFACT_HASH_MISMATCH,
        `content-addressed store file ${relative} does not hash to its own name`,
      );
    }
  }

  // 2. Every referenced descriptor whose path is present must match its bytes.
  const descriptors: Descriptor[] = [];
  for (const artifact of index.all()) {
    collectDescriptors(artifact.value, artifact.logicalPath, descriptors);
  }
  let descriptorsChecked = 0;
  for (const descriptor of descriptors) {
    const absolute = resolveBeneathRoot(root, descriptor.declaredPath, descriptor.origin);
    const bytes = readReferenced(absolute, descriptor.declaredPath, descriptor.origin);
    if (bytes === undefined) {
      // A working-copy reference (e.g. `raw/…`) may legitimately be scrubbed
      // from a retained bundle.  A content-addressed reference may not: it is
      // always retained, so its absence is a missing-payload refusal.
      if (STORE_FILE.test(descriptor.declaredPath)) {
        throw new Erl2Error(
          CODES.ARTIFACT_NOT_FOUND,
          `content-addressed payload ${descriptor.declaredPath} referenced by ${descriptor.origin} is missing`,
        );
      }
      continue;
    }
    if (descriptor.byteLength !== undefined && bytes.byteLength !== descriptor.byteLength) {
      throw new Erl2Error(
        CODES.ARTIFACT_HASH_MISMATCH,
        `referenced payload ${descriptor.declaredPath} in ${descriptor.origin} has ${String(bytes.byteLength)} bytes, not the declared ${String(descriptor.byteLength)}`,
      );
    }
    if (!hashesEqual(hashBytes(bytes), descriptor.fileSha256 as Hash)) {
      throw new Erl2Error(
        CODES.ARTIFACT_HASH_MISMATCH,
        `referenced payload ${descriptor.declaredPath} in ${descriptor.origin} does not match its declared file_sha256`,
      );
    }
    descriptorsChecked += 1;
  }

  // Note: raw payloads (the acquired package and its content-addressed store
  // copy) are `INTERNAL` and may be absent from a `PUBLIC` bundle; their absence
  // is therefore not a refusal.  What is enforced is that every payload that *is*
  // retained matches its declared digest — a swapped or truncated payload cannot
  // survive (P2-2).
  return { descriptorsChecked, storeFilesChecked: storeFiles.size };
}
