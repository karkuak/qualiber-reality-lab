/**
 * Acyclic timestamp checkpoints (design v2 §15, ERL2-FR-033/AC-037).
 *
 * A checkpoint anchors the core hash of an artifact that is *already frozen*.
 * The anchored artifact never contains the checkpoint that proves its own
 * existence, so the ordering graph stays acyclic.  This module both builds and
 * independently verifies that ordering.
 */

import {
  CODES,
  Erl2Error,
  type Hash,
  type TrustedTimestampCheckpointV1,
} from "@erl2/contracts";
import { jcs } from "../canonical/jcs.js";
import type { TrustEvaluator } from "../trust/trust.js";
import { SIGNATURE_DOMAINS } from "../hash/domains.js";
import { coreHash } from "../hash/hash.js";

export interface CheckpointTarget {
  readonly artifactSchemaVersion: string;
  readonly artifactCoreHash: Hash;
  readonly signerKeyId: string;
  readonly signatureSha256: Hash;
  readonly securityTimestamp: string;
}

/** Asserts that `checkpoint` anchors `targetHash` exactly once. */
export function assertAnchors(
  checkpoint: TrustedTimestampCheckpointV1,
  targetHash: Hash,
  expectedSchemaVersion?: string,
): void {
  const matches = checkpoint.entries.filter((e) => e.artifact_core_hash === targetHash);
  if (matches.length === 0) {
    throw new Erl2Error(
      CODES.TIMESTAMP_TARGET_MISSING,
      `checkpoint ${checkpoint.checkpoint_id} does not anchor ${targetHash}`,
    );
  }
  if (matches.length > 1) {
    throw new Erl2Error(
      CODES.TIMESTAMP_CHAIN_BROKEN,
      `checkpoint ${checkpoint.checkpoint_id} anchors ${targetHash} more than once`,
    );
  }
  const entry = matches[0];
  if (expectedSchemaVersion !== undefined && entry?.artifact_schema_version !== expectedSchemaVersion) {
    throw new Erl2Error(
      CODES.SELECTION_TIME_WRONG_TARGET,
      `checkpoint anchors ${String(entry?.artifact_schema_version)}, expected ${expectedSchemaVersion}`,
    );
  }
}

/**
 * Refuses a checkpoint that anchors its own core hash — the structural form of
 * a timestamp cycle.
 */
export function assertNotSelfAnchoring(checkpoint: TrustedTimestampCheckpointV1): void {
  const own = coreHash(checkpoint);
  if (checkpoint.entries.some((e) => e.artifact_core_hash === own)) {
    throw new Erl2Error(
      CODES.TIMESTAMP_SELF_REFERENCE,
      `checkpoint ${checkpoint.checkpoint_id} anchors itself`,
    );
  }
  if (checkpoint.prior_checkpoint_hash === own) {
    throw new Erl2Error(
      CODES.TIMESTAMP_SELF_REFERENCE,
      `checkpoint ${checkpoint.checkpoint_id} chains to itself`,
    );
  }
}

/**
 * Refuses an artifact that embeds the hash of the checkpoint meant to anchor
 * it.  Closed schemas already make this impossible for the selection
 * commitment and selected binding; this is the executable proof.
 */
export function assertArtifactDoesNotEmbedCheckpoint(artifact: object, checkpointHash: Hash): void {
  if (jcs(artifact).includes(checkpointHash)) {
    throw new Erl2Error(
      CODES.SELECTION_TIME_CYCLIC_CHECKPOINT,
      "artifact embeds the checkpoint intended to anchor it",
    );
  }
}

/** Security timestamp of the entry anchoring `targetHash`. */
export function anchoredAt(checkpoint: TrustedTimestampCheckpointV1, targetHash: Hash): string {
  const entry = checkpoint.entries.find((e) => e.artifact_core_hash === targetHash);
  if (!entry) {
    throw new Erl2Error(CODES.TIMESTAMP_TARGET_MISSING, `checkpoint does not anchor ${targetHash}`);
  }
  return entry.security_timestamp;
}

/**
 * Verifies a checkpoint chain: sequences are contiguous and ascending,
 * `prior_checkpoint_hash` links each element to its predecessor, and every
 * checkpoint is signed by an authorized timestamp authority.
 */
export function verifyCheckpointChain(
  chain: readonly TrustedTimestampCheckpointV1[],
  trust: TrustEvaluator,
): void {
  if (chain.length === 0) {
    throw new Erl2Error(CODES.TIMESTAMP_CHAIN_BROKEN, "empty timestamp checkpoint chain");
  }
  let priorHash: Hash | undefined;
  let priorLast = -1;
  for (const checkpoint of chain) {
    assertNotSelfAnchoring(checkpoint);
    if (checkpoint.first_sequence > checkpoint.last_sequence) {
      throw new Erl2Error(CODES.TIMESTAMP_CHAIN_BROKEN, "checkpoint sequence range is inverted");
    }
    if (checkpoint.entries.length !== checkpoint.last_sequence - checkpoint.first_sequence + 1) {
      throw new Erl2Error(CODES.TIMESTAMP_CHAIN_BROKEN, "checkpoint entry count does not match its range");
    }
    for (const [i, entry] of checkpoint.entries.entries()) {
      if (entry.sequence !== checkpoint.first_sequence + i) {
        throw new Erl2Error(CODES.TIMESTAMP_CHAIN_BROKEN, "checkpoint entries are not contiguous");
      }
    }
    if (priorHash === undefined) {
      if (checkpoint.prior_checkpoint_hash !== undefined) {
        // A chain may legitimately start mid-log, but then the caller must
        // supply the predecessor; a dangling link is fail-closed here.
        throw new Erl2Error(
          CODES.TIMESTAMP_CHAIN_BROKEN,
          "first checkpoint in the chain references an unsupplied predecessor",
        );
      }
    } else {
      if (checkpoint.prior_checkpoint_hash !== priorHash) {
        throw new Erl2Error(CODES.TIMESTAMP_CHAIN_BROKEN, "checkpoint prior hash does not match");
      }
      if (checkpoint.first_sequence !== priorLast + 1) {
        throw new Erl2Error(CODES.TIMESTAMP_CHAIN_BROKEN, "checkpoint sequences are not contiguous");
      }
    }
    trust.verifyRoleSignature({
      value: checkpoint,
      signature: checkpoint.signature,
      role: "timestamp_authority",
      schemaVersion: checkpoint.schema_version,
      securityTimestamp: checkpoint.checkpointed_at,
      domain: SIGNATURE_DOMAINS.LEGACY_V1,
    });
    priorHash = coreHash(checkpoint);
    priorLast = checkpoint.last_sequence;
  }
}

/** Ordering assertion used across the selection chain. */
export function assertStrictlyBefore(earlier: string, later: string, code: string, what: string): void {
  if (Date.parse(earlier) > Date.parse(later)) {
    throw new Erl2Error(code, `${what}: ${earlier} is not at or before ${later}`);
  }
}
