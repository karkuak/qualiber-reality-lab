/**
 * Immutable artifact publication (design v2 §14, implementation plan §5 rule 5).
 *
 * Freeze protocol: write a temporary file in the destination filesystem →
 * validate bytes → fsync file → link (never replace) → fsync parent → write the
 * freeze marker last → drop write permission.  Re-freezing identical bytes is
 * idempotent; different bytes for the same path are refused.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  chmodSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CODES, Erl2Error, type ArtifactRef, type Classification, type Hash } from "@erl2/contracts";
import { hashBytes, hashesEqual } from "../hash/hash.js";
import { jcsBytes } from "../canonical/jcs.js";
import { ensureConfinedParent, resolveConfined } from "./paths.js";

const MARKER_SUFFIX = ".frozen";

export interface FreezeInput {
  readonly logicalPath: string;
  readonly bytes: Buffer;
  readonly mediaType: string;
  readonly classification: Classification;
}

export interface FreezeMarker {
  readonly logical_path: string;
  readonly file_sha256: Hash;
  readonly byte_length: number;
  readonly media_type: string;
  readonly classification: Classification;
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Content-addressed, append-only artifact store rooted at one run directory.
 * The store never rewrites a frozen artifact and never follows a symlink.
 */
export class ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  /** Absolute path of a logical path, with confinement enforced. */
  resolve(logicalPath: string): string {
    return resolveConfined(this.root, logicalPath);
  }

  isFrozen(logicalPath: string): boolean {
    return existsSync(`${this.resolve(logicalPath)}${MARKER_SUFFIX}`);
  }

  /**
   * Publishes `input` atomically and returns its `ArtifactRef`.
   *
   * Freezing the same path with the same bytes is a no-op (same operation,
   * same bytes → idempotent).  Different bytes raise `ARTIFACT_ALREADY_FROZEN`.
   */
  freeze(input: FreezeInput): ArtifactRef {
    const absolute = ensureConfinedParent(this.root, input.logicalPath);
    const digest = hashBytes(input.bytes);
    const markerPath = `${absolute}${MARKER_SUFFIX}`;
    const contentPresent = existsSync(absolute);

    // A complete, valid marker means the artifact is fully frozen.
    if (existsSync(markerPath)) {
      let marker: FreezeMarker | undefined;
      try {
        marker = JSON.parse(readFileSync(markerPath, "utf8")) as FreezeMarker;
      } catch {
        marker = undefined; // a crash during the marker write left a partial marker.
      }
      if (marker !== undefined && contentPresent) {
        const existing = readFileSync(absolute);
        const existingDigest = hashBytes(existing);
        if (!hashesEqual(existingDigest, marker.file_sha256)) {
          throw new Erl2Error(
            CODES.ARTIFACT_HASH_MISMATCH,
            `frozen artifact does not match its marker: ${input.logicalPath}`,
          );
        }
        if (!hashesEqual(existingDigest, digest)) {
          throw new Erl2Error(
            CODES.ARTIFACT_ALREADY_FROZEN,
            `artifact ${input.logicalPath} is frozen with different bytes`,
          );
        }
        return this.refFor(input, digest);
      }
      // Corrupt/partial marker (or a marker with no content): fall through to
      // reconciliation, which completes the freeze when the content matches.
    }

    if (contentPresent) {
      // The content was linked but the freeze did not complete its marker (a
      // crash between `linkSync` and the marker write, or a corrupt marker).
      // Reconcile against the bytes: identical bytes complete the freeze,
      // different bytes are a typed conflict.  A markerless artifact can
      // therefore always complete or fail typed — it never wedges (§11.4).
      const existing = readFileSync(absolute);
      if (!hashesEqual(hashBytes(existing), digest)) {
        throw new Erl2Error(
          CODES.ARTIFACT_ALREADY_FROZEN,
          `artifact ${input.logicalPath} already exists with different bytes`,
        );
      }
      this.publishMarker(markerPath, absolute, input, digest);
      return this.refFor(input, digest);
    }

    const dir = path.dirname(absolute);
    const temp = path.join(dir, `.tmp-${randomBytes(12).toString("hex")}`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, input.bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    try {
      // linkSync never replaces an existing destination, which gives an atomic
      // create-or-fail publication without a cross-device rename.
      linkSync(temp, absolute);
    } catch (cause) {
      unlinkSync(temp);
      // A concurrent freeze won the link race; reconcile against the winner's
      // bytes rather than failing blindly.
      const existing = readFileSync(absolute);
      if (hashesEqual(hashBytes(existing), digest)) {
        this.publishMarker(markerPath, absolute, input, digest);
        return this.refFor(input, digest);
      }
      throw new Erl2Error(
        CODES.ARTIFACT_ALREADY_FROZEN,
        `artifact ${input.logicalPath} already exists`,
        { cause },
      );
    }
    unlinkSync(temp);
    fsyncDir(dir);
    this.publishMarker(markerPath, absolute, input, digest);
    return this.refFor(input, digest);
  }

  /** Writes the freeze marker last and drops write permission, crash-idempotently. */
  private publishMarker(markerPath: string, absolute: string, input: FreezeInput, digest: Hash): void {
    const marker: FreezeMarker = {
      logical_path: input.logicalPath,
      file_sha256: digest,
      byte_length: input.bytes.byteLength,
      media_type: input.mediaType,
      classification: input.classification,
    };
    // Remove any partial/corrupt marker (which may already be read-only) first.
    if (existsSync(markerPath)) unlinkSync(markerPath);
    writeFileSync(markerPath, `${jcsBytes(marker).toString("utf8")}\n`, { mode: 0o400 });
    fsyncDir(path.dirname(absolute));
    chmodSync(absolute, 0o400);
  }

  /** Freezes a contract object as canonical JSON with a trailing newline. */
  freezeJson(
    logicalPath: string,
    value: unknown,
    classification: Classification = "INTERNAL",
    mediaType = "application/json",
  ): ArtifactRef {
    const bytes = Buffer.concat([jcsBytes(value), Buffer.from("\n", "utf8")]);
    return this.freeze({ logicalPath, bytes, mediaType, classification });
  }

  read(logicalPath: string): Buffer {
    const absolute = this.resolve(logicalPath);
    if (!existsSync(absolute)) {
      throw new Erl2Error(CODES.ARTIFACT_NOT_FOUND, `no artifact at ${logicalPath}`);
    }
    return readFileSync(absolute);
  }

  readJson(logicalPath: string): unknown {
    return JSON.parse(this.read(logicalPath).toString("utf8")) as unknown;
  }

  /** Verifies stored bytes against a previously issued reference. */
  verify(ref: ArtifactRef): void {
    const bytes = this.read(ref.path);
    if (bytes.byteLength !== ref.byte_length) {
      throw new Erl2Error(CODES.ARTIFACT_HASH_MISMATCH, `byte length changed for ${ref.path}`);
    }
    if (!hashesEqual(hashBytes(bytes), ref.file_sha256)) {
      throw new Erl2Error(CODES.ARTIFACT_HASH_MISMATCH, `file digest changed for ${ref.path}`);
    }
  }

  private refFor(input: FreezeInput, digest: Hash): ArtifactRef {
    return {
      path: input.logicalPath,
      media_type: input.mediaType,
      byte_length: input.bytes.byteLength,
      file_sha256: digest,
      classification: input.classification,
    };
  }
}
