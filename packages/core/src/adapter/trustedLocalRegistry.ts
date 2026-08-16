/**
 * Durable retention and re-resolution of a trusted-local admission.
 *
 * The declaration and manifest are retained as the **exact bytes the operator
 * supplied**, not as re-serialized objects. A re-serialization would produce a
 * document that hashes the same under `coreHash` but not under `hashBytes`, and
 * the file digest is half of what a later reader has to check: the offline
 * verifier compares the retained file's bytes against the digests the run
 * record names, and that comparison is only meaningful if nothing rewrote them
 * on the way in.
 *
 * Retention is atomic. Both documents land together or neither does, so a
 * crash cannot leave a registry holding a manifest whose declaration never
 * arrived — a half-admitted state that would otherwise be indistinguishable
 * from a complete one.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  CODES,
  Erl2Error,
  parseStrictJson,
  type Hash,
  type SubjectAdapterManifestV2,
  type TrustedLocalAdapterDeclarationV1,
} from "@erl2/contracts";
import { hashBytes } from "@erl2/integrity";

import {
  verifyTrustedLocalAdapterDeclaration,
  type TrustedLocalAdmissionV2,
} from "./trustedLocal.js";

/** Where trusted-local admissions live, relative to a registry root. */
export const TRUSTED_LOCAL_ADAPTER_DIR = "trusted-local-adapters";

export const TRUSTED_LOCAL_MANIFEST_FILE = "adapter-manifest.v2.json";
export const TRUSTED_LOCAL_DECLARATION_FILE = "trusted-local-declaration.v1.json";

/**
 * Ceiling for either retained document.
 *
 * A manifest and a declaration are both small, bounded records. Reading an
 * arbitrarily large file to find out it is neither is work an attacker gets to
 * choose the size of, so the size is checked before the parse rather than
 * after (§P2 of the `3ded03c` review: no input-size ceiling).
 */
export const MAX_TRUSTED_LOCAL_DOCUMENT_BYTES = 256 * 1024;

export interface RetainedTrustedLocalAdmission {
  /** Directory, relative to the registry root, holding both documents. */
  readonly logicalPath: string;
  readonly manifestCoreHash: Hash;
  readonly manifestFileHash: Hash;
  readonly declarationCoreHash: Hash;
  readonly declarationFileHash: Hash;
  readonly admission: TrustedLocalAdmissionV2;
  /** True when this exact admission was already published. */
  readonly alreadyPresent: boolean;
}

export interface RetainTrustedLocalAdapterInput {
  readonly registryRoot: string;
  readonly manifestBytes: Buffer;
  readonly declarationBytes: Buffer;
  readonly adapterEntryPath: string;
}

/**
 * Verifies the admission, then publishes the exact bytes it verified.
 *
 * The order matters: nothing is written until the declaration binds the
 * manifest, the manifest binds the artifact, and the artifact on disk hashes
 * to what both of them name. A refused admission leaves no directory behind.
 */
export function retainTrustedLocalAdapterV2(
  input: RetainTrustedLocalAdapterInput,
): RetainedTrustedLocalAdmission {
  const manifestFileHash = hashBytes(
    assertBoundedDocument(input.manifestBytes, "adapter manifest"),
  );
  const declarationFileHash = hashBytes(
    assertBoundedDocument(input.declarationBytes, "trusted-local declaration"),
  );
  const manifest = parseDocument<SubjectAdapterManifestV2>(
    input.manifestBytes,
    "adapter manifest",
  );
  const declaration = parseDocument<TrustedLocalAdapterDeclarationV1>(
    input.declarationBytes,
    "trusted-local declaration",
  );
  const entryPath = assertRegularFile(input.adapterEntryPath, "adapter entry");
  const admission = verifyTrustedLocalAdapterDeclaration({
    manifest,
    declaration,
    entryDigest: hashBytes(readFileSync(entryPath)),
    manifestFileHash,
  });

  const root = path.resolve(input.registryRoot);
  const name = admission.manifestHash.replace("sha256:", "");
  const logicalPath = `${TRUSTED_LOCAL_ADAPTER_DIR}/${name}`;
  const destination = path.join(root, TRUSTED_LOCAL_ADAPTER_DIR, name);

  if (existsSync(destination)) {
    const existing = readRetainedBytes(destination);
    if (
      existing.manifestFileHash === manifestFileHash &&
      existing.declarationFileHash === declarationFileHash
    ) {
      return {
        logicalPath,
        manifestCoreHash: admission.manifestHash,
        manifestFileHash,
        declarationCoreHash: admission.declarationHash,
        declarationFileHash,
        admission,
        alreadyPresent: true,
      };
    }
    throw new Erl2Error(
      CODES.ADMISSION_RETENTION_FAILED,
      `${logicalPath} already holds a different trusted-local admission for this manifest; ` +
        "remove it before admitting a different declaration",
    );
  }

  let staging: string | undefined;
  try {
    mkdirSync(path.join(root, TRUSTED_LOCAL_ADAPTER_DIR), { recursive: true });
    staging = mkdtempSync(path.join(root, TRUSTED_LOCAL_ADAPTER_DIR, ".admit-"));
    writeFileSync(path.join(staging, TRUSTED_LOCAL_MANIFEST_FILE), input.manifestBytes, {
      mode: 0o600,
    });
    writeFileSync(path.join(staging, TRUSTED_LOCAL_DECLARATION_FILE), input.declarationBytes, {
      mode: 0o600,
    });
    renameSync(staging, destination);
    staging = undefined;
  } catch (cause) {
    if (cause instanceof Erl2Error) throw cause;
    throw new Erl2Error(
      CODES.ADMISSION_RETENTION_FAILED,
      `the trusted-local admission could not be published into the registry at ${logicalPath}`,
      { cause },
    );
  } finally {
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true });
  }

  return {
    logicalPath,
    manifestCoreHash: admission.manifestHash,
    manifestFileHash,
    declarationCoreHash: admission.declarationHash,
    declarationFileHash,
    admission,
    alreadyPresent: false,
  };
}

export interface ResolvedTrustedLocalAdapter {
  readonly manifest: SubjectAdapterManifestV2;
  readonly declaration: TrustedLocalAdapterDeclarationV1;
  readonly admission: TrustedLocalAdmissionV2;
  readonly manifestFileHash: Hash;
  readonly declarationFileHash: Hash;
}

/**
 * Re-derives authority from the retained bytes, re-hashing the entry.
 *
 * This is the time-of-use half of admission, and it is why the runner resolves
 * before constructing a host: bytes swapped between publication and
 * construction are refused here, and bytes swapped between one dispatch and
 * the next are refused by the host's own per-dispatch re-hash. Nothing carries
 * the in-memory admission object forward across that boundary.
 */
export function resolveTrustedLocalAdapterV2(input: {
  readonly registryRoot: string;
  readonly manifestCoreHash: Hash;
  readonly adapterEntryPath: string;
}): ResolvedTrustedLocalAdapter {
  const root = path.resolve(input.registryRoot);
  const name = input.manifestCoreHash.replace("sha256:", "");
  const destination = path.join(root, TRUSTED_LOCAL_ADAPTER_DIR, name);
  if (!existsSync(destination)) {
    throw new Erl2Error(
      CODES.ADMISSION_RETENTION_FAILED,
      `no trusted-local admission is retained for manifest ${input.manifestCoreHash}`,
    );
  }
  const manifestBytes = readRetainedFile(destination, TRUSTED_LOCAL_MANIFEST_FILE);
  const declarationBytes = readRetainedFile(destination, TRUSTED_LOCAL_DECLARATION_FILE);
  const manifestFileHash = hashBytes(manifestBytes);
  const declarationFileHash = hashBytes(declarationBytes);
  const manifest = parseDocument<SubjectAdapterManifestV2>(manifestBytes, "retained adapter manifest");
  const declaration = parseDocument<TrustedLocalAdapterDeclarationV1>(
    declarationBytes,
    "retained trusted-local declaration",
  );
  const entryPath = assertRegularFile(input.adapterEntryPath, "adapter entry");
  const admission = verifyTrustedLocalAdapterDeclaration({
    manifest,
    declaration,
    entryDigest: hashBytes(readFileSync(entryPath)),
    manifestFileHash,
  });
  if (admission.manifestHash !== input.manifestCoreHash) {
    throw new Erl2Error(
      CODES.ADMISSION_RETENTION_FAILED,
      "the retained manifest does not hash to the admission it is filed under",
    );
  }
  return { manifest, declaration, admission, manifestFileHash, declarationFileHash };
}

/**
 * Refuses anything that is not a regular file at the exact path given.
 *
 * `lstat`, not `stat`: a symlink pointing at valid bytes is still a path whose
 * target can be repointed between the check and the read, so the path itself
 * has to be the regular file rather than resolve to one.
 */
export function assertRegularFile(candidate: string, label: string): string {
  const absolute = path.resolve(candidate);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch (cause) {
    throw new Erl2Error(CODES.CFG_MISSING_REQUIRED, `${label} not found: ${absolute}`, { cause });
  }
  if (stats.isSymbolicLink()) {
    throw new Erl2Error(
      CODES.PATH_SYMLINK_REJECTED,
      `${label} is a symbolic link; supply the regular file itself: ${absolute}`,
    );
  }
  if (!stats.isFile()) {
    throw new Erl2Error(
      CODES.PATH_NOT_REGULAR_FILE,
      `${label} is not a regular file: ${absolute}`,
    );
  }
  return absolute;
}

/** Refuses a directory path that is, or resolves through, a symbolic link. */
export function assertRegularDirectory(candidate: string, label: string): string {
  const absolute = path.resolve(candidate);
  if (!existsSync(absolute)) return absolute;
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink()) {
    throw new Erl2Error(
      CODES.PATH_SYMLINK_REJECTED,
      `${label} is a symbolic link; supply the directory itself: ${absolute}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Erl2Error(
      CODES.PATH_NOT_REGULAR_FILE,
      `${label} exists and is not a directory: ${absolute}`,
    );
  }
  return absolute;
}

function assertBoundedDocument(bytes: Buffer, label: string): Buffer {
  if (bytes.byteLength > MAX_TRUSTED_LOCAL_DOCUMENT_BYTES) {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_RECORD_OVERSIZED,
      `${label} is ${bytes.byteLength} bytes, above the ${MAX_TRUSTED_LOCAL_DOCUMENT_BYTES}-byte ceiling`,
    );
  }
  return bytes;
}

function readRetainedFile(destination: string, name: string): Buffer {
  const file = assertRegularFile(path.join(destination, name), `retained ${name}`);
  return assertBoundedDocument(readFileSync(file), `retained ${name}`);
}

function readRetainedBytes(destination: string): {
  readonly manifestFileHash: string;
  readonly declarationFileHash: string;
} {
  const read = (name: string): string => {
    try {
      return hashBytes(readFileSync(path.join(destination, name)));
    } catch {
      return "";
    }
  };
  return {
    manifestFileHash: read(TRUSTED_LOCAL_MANIFEST_FILE),
    declarationFileHash: read(TRUSTED_LOCAL_DECLARATION_FILE),
  };
}

function parseDocument<T>(bytes: Buffer, label: string): T {
  let value: unknown;
  try {
    value = parseStrictJson(bytes.toString("utf8"));
  } catch (cause) {
    if (cause instanceof Erl2Error) throw cause;
    throw new Erl2Error(CODES.SCHEMA_VALIDATION_FAILED, `${label} is not valid JSON`, { cause });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Erl2Error(CODES.SCHEMA_VALIDATION_FAILED, `${label} must be a JSON object`);
  }
  return value as T;
}
