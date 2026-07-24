/**
 * Append-only timestamp log that issues `TrustedTimestampCheckpointV1`.
 *
 * The log only ever anchors the core hash of an artifact that has already been
 * frozen, which is what keeps the selection ordering graph acyclic
 * (ERL2-FR-033).  Submitting an artifact that embeds the hash of the checkpoint
 * about to anchor it is impossible, because the checkpoint hash does not exist
 * until after the submission.
 */

import type { Hash, Signature, TrustedTimestampCheckpointV1 } from "@erl2/contracts";
import { assertContract } from "@erl2/contracts";
import { coreHash, sealSigned, SIGNATURE_DOMAINS, type SigningKey } from "@erl2/integrity";
import type { Clock } from "../runtime/seams.js";

export interface TimestampSubmission {
  readonly artifactSchemaVersion: string;
  readonly artifactCoreHash: Hash;
  readonly signerKeyId: string;
  readonly signature: Signature;
}

export class TimestampLog {
  private readonly logId: string;
  private readonly runId: string;
  private readonly authority: SigningKey;
  private readonly clock: Clock;
  private nextSequence = 0;
  private priorCheckpointHash: Hash | undefined;
  private readonly checkpoints: TrustedTimestampCheckpointV1[] = [];

  constructor(options: {
    readonly logId: string;
    readonly runId: string;
    readonly authority: SigningKey;
    readonly clock: Clock;
  }) {
    this.logId = options.logId;
    this.runId = options.runId;
    this.authority = options.authority;
    this.clock = options.clock;
  }

  /**
   * Anchors one already-frozen artifact and returns the checkpoint.  Each
   * checkpoint in this implementation holds exactly one entry so that ordering
   * assertions between chain steps are unambiguous.
   */
  anchor(submission: TimestampSubmission): TrustedTimestampCheckpointV1 {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    const at = this.clock.now();
    // The checkpoint id is DERIVED from the checkpoint's own content, not a
    // random UUID (review 6R-D): the sequence is monotonic within a log, so the
    // derivation is unique per checkpoint AND byte-reproducible, which is what a
    // deterministic evidence pin requires. A random suffix here was the sole
    // remaining nondeterminism in the fake-run evidence chain.
    const idDigest = coreHash({
      log_id: this.logId,
      run_id: this.runId,
      sequence,
      artifact_core_hash: submission.artifactCoreHash,
      at,
    }).slice("sha256:".length, "sha256:".length + 8);
    const base = {
      schema_version: "trusted-timestamp-checkpoint/v1" as const,
      checkpoint_id: `cp-${String(sequence).padStart(4, "0")}-${idDigest}`,
      log_id: this.logId,
      context: { scope: "selected_run_public" as const, run_id: this.runId },
      ...(this.priorCheckpointHash === undefined
        ? {}
        : { prior_checkpoint_hash: this.priorCheckpointHash }),
      first_sequence: sequence,
      last_sequence: sequence,
      entries: [
        {
          sequence,
          artifact_schema_version: submission.artifactSchemaVersion,
          artifact_core_hash: submission.artifactCoreHash,
          signer_key_id: submission.signerKeyId,
          signature_sha256: submission.signature.signed_hash,
          security_timestamp: at,
        },
      ],
      checkpointed_at: at,
    };
    const signed = sealSigned(base, this.authority, SIGNATURE_DOMAINS.LEGACY_V1);
    const checkpoint = assertContract<TrustedTimestampCheckpointV1>(
      "TrustedTimestampCheckpointV1",
      signed,
    );
    this.priorCheckpointHash = coreHash(checkpoint);
    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  /** The full chain in issue order, for bundle construction. */
  chain(): readonly TrustedTimestampCheckpointV1[] {
    return [...this.checkpoints];
  }

  head(): Hash | undefined {
    return this.priorCheckpointHash;
  }
}
