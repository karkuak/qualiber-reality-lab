/**
 * The V2 selection chain, decomposed into individually durable stages
 * (ADR-ERL2-020 §6).
 *
 * `runSelectionChain` used to run the whole protocol in one call and return ten
 * artifacts at once. A CLI driving that would have had to freeze all ten and
 * then replay thirteen lifecycle transitions describing work that had already
 * finished in memory — which makes the lifecycle decorative and, worse, leaves a
 * crash anywhere inside the chain with no durable record of how far it got.
 * Recovery would then have to choose between re-running the chain — drawing a
 * **second beacon round**, violating the single-observation rule — and trusting
 * partial in-memory state it cannot verify. ADR-ERL2-018's run-transaction model
 * exists to make that choice unnecessary.
 *
 * So each protocol step is a function here that produces *only* its own
 * artifacts from the context plus the artifacts earlier stages already produced.
 * A caller freezes and records each stage's output before invoking the next, and
 * on resume rebuilds the accumulated state from retained evidence instead of
 * re-deriving it. `runSelectionChain` is now a fold over exactly these
 * functions, so the in-memory producer used by the known-answer and adversarial
 * suites and the durable producer used by the CLI cannot diverge.
 *
 * The stage that observes randomness — {@link stageRandomness} — is the only one
 * that touches the beacon. That is the single place a resume must never re-enter.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type BeaconInclusionProofV1,
  type BeaconSignatureProofV1,
  type ExternalBeaconRandomnessReceiptV1,
  type Hash,
  type RandomnessSourceTrustVerificationReportV1,
  type SelectedChallengeJourneyBindingV1,
  type SelectionCommitmentV2,
  type SelectionProofV2,
  type SelectionVerificationReceiptV2,
  type ThresholdRevealReceiptV1,
  type TrustedTimestampCheckpointV1,
} from "@erl2/contracts";
import {
  assertAnchors,
  assertArtifactDoesNotEmbedCheckpoint,
  coreHash,
  domainHash,
  HASH_DOMAINS,
  openThresholdEnvelope,
  parseEnvelope,
  releaseShare,
  sealSigned,
  signCoreHash,
  SIGNATURE_DOMAINS,
} from "@erl2/integrity";
import {
  assertActiveRandomnessReceiptVariant,
  assertActiveRandomnessVariant,
  assertWrapperOwnership,
  proofBytes,
  verifyBeaconNativeProof,
  type BeaconRound,
} from "./beacon.js";
import { assertDevelopmentTierOnly } from "./developmentBeacon.js";
import { deriveSelectedIndex, hidingCommitment, poolRootOf, sourceRequestBindingHash } from "./derive.js";
import { assertPoolMetadataUniform } from "./pool.js";
import { verifySelectionChainCore } from "./verify.js";
import type { RunSelectionOptions, SelectionPoolEntry } from "./chain.js";

const TRUE = true as const;

/** Immutable inputs every stage shares. */
export type SelectionContext = RunSelectionOptions;

/** Artifacts produced so far, accumulated stage by stage. */
export interface SelectionProgress {
  readonly poolCheckpoint?: TrustedTimestampCheckpointV1;
  /**
   * The observed beacon output, and only that.
   *
   * Deliberately NOT a `BeaconRound`: a resume rebuilds this from the frozen
   * receipt, and the receipt does not carry `previousRoundId`. Narrowing the
   * type to what downstream stages actually consume means resume reconstructs a
   * complete value instead of fabricating a field it cannot know.
   */
  readonly randomness?: ObservedRandomness;
  /**
   * The beacon's own signature proof. Carried explicitly rather than re-read
   * from the receipt because the receipt stores it as an `ArtifactRef`, and the
   * source-trust report must name the *verified* beacon key. On resume the
   * caller rebuilds this by reading the PUBLIC proof frozen at stage 2.
   */
  readonly signatureProof?: BeaconSignatureProofV1;
  /** The beacon's inclusion proof, carried for the same reason. */
  readonly inclusionProof?: BeaconInclusionProofV1;
  readonly randomnessReceipt?: ExternalBeaconRandomnessReceiptV1;
  readonly sourceTrustReport?: RandomnessSourceTrustVerificationReportV1;
  readonly derived?: { readonly index: number; readonly rejectionCount: number };
  readonly selectedEntry?: SelectionPoolEntry;
  readonly commitment?: SelectionCommitmentV2;
  readonly commitmentCheckpoint?: TrustedTimestampCheckpointV1;
  readonly thresholdRevealReceipt?: ThresholdRevealReceiptV1;
  readonly opened?: OpenedPayload;
  readonly binding?: SelectedChallengeJourneyBindingV1;
  readonly bindingCheckpoint?: TrustedTimestampCheckpointV1;
  readonly proof?: SelectionProofV2;
}

/** What later stages need from the observed round: the output bytes. */
export interface ObservedRandomness {
  readonly randomnessOutput: Buffer;
}

export interface OpenedPayload {
  readonly challenge_manifest_hash: Hash;
  readonly persona_script_hash: Hash;
  readonly journey_hash: Hash;
  readonly ordered_step_commitment_hashes: Hash[];
  readonly exposure_epoch: number;
  readonly opening_nonce_base64: string;
}

/** Reads a stage input the caller must already have produced. */
function required<T>(value: T | undefined, stage: string): T {
  if (value === undefined) {
    throw new Erl2Error(
      CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
      `selection stage ordering violated: ${stage} has not been produced`,
    );
  }
  return value;
}

/**
 * Every guard that must hold before any randomness exists.
 *
 * Runs at the top of the chain and again on every resume: a run whose retained
 * pool no longer binds its request must not continue just because it already
 * observed a round.
 */
export function assertSelectionPreconditions(ctx: SelectionContext): void {
  const { request, requestHash, policy, policyHash, pool, beacon } = ctx;
  assertActiveRandomnessVariant(policy);
  // ERL2-OQ-007 fail-closed guard, *inside* the kernel: a held-out or blind
  // selection may never be driven by the development beacon. The CLI admission
  // layer refuses non-development tiers upstream, but the kernel enforces it
  // itself so replay evidence or a future caller cannot bypass admission (P2-7).
  assertDevelopmentTierOnly(request.requested_tier, policy.source_id);

  if (pool.manifest.selection_request_hash !== requestHash) {
    throw new Erl2Error(CODES.SELECTION_CHAIN_EDGE_UNCLOSED, "pool is not bound to this request");
  }
  if (pool.manifest.selection_randomness_policy_hash !== policyHash) {
    throw new Erl2Error(CODES.SELECTION_CHAIN_EDGE_UNCLOSED, "pool names a different randomness policy");
  }
  if (
    pool.manifest.randomness_source_id !== policy.source_id ||
    pool.manifest.randomness_source_trust_policy_hash !== policy.source_trust_policy_hash
  ) {
    throw new Erl2Error(CODES.RANDOMNESS_SOURCE_MISMATCH, "pool source identity differs from the policy");
  }
  if (poolRootOf(pool.manifest) !== pool.manifest.pool_root_hash) {
    throw new Erl2Error(CODES.SELECTION_CHAIN_POOL_ROOT_MISMATCH, "pool root does not match its inputs");
  }
  assertPoolMetadataUniform(
    pool.manifest,
    pool.entries.map((e) => e.entry),
  );
  if (beacon.sourceId !== policy.source_id) {
    throw new Erl2Error(CODES.RANDOMNESS_SOURCE_MISMATCH, "beacon transport is not the policy source");
  }
}

/** Stage 1 — anchor the ordered pool. */
export function stagePoolCheckpoint(ctx: SelectionContext): TrustedTimestampCheckpointV1 {
  const { pool, timestamps } = ctx;
  const poolCheckpoint = timestamps.anchor({
    artifactSchemaVersion: pool.manifest.schema_version,
    artifactCoreHash: pool.manifestHash,
    signerKeyId: pool.manifest.signature.key_id,
    signature: pool.manifest.signature,
  });
  assertAnchors(poolCheckpoint, pool.manifestHash, pool.manifest.schema_version);
  assertArtifactDoesNotEmbedCheckpoint(pool.manifest, coreHash(poolCheckpoint));
  return poolCheckpoint;
}

/**
 * Stage 2 — observe **exactly one** beacon round and wrap it.
 *
 * This is the only stage that touches the beacon, and therefore the only stage a
 * resume must never re-enter. A caller that has already retained the receipt
 * must rebuild {@link SelectionProgress.randomnessReceipt} from it rather than
 * calling here again: re-entering would draw a second round, which the pool's
 * single-draw rule refuses, but the refusal would arrive only after the request
 * had already been made.
 */
export function stageRandomness(
  ctx: SelectionContext,
  progress: SelectionProgress,
): {
  readonly randomness: ObservedRandomness;
  readonly signatureProof: BeaconSignatureProofV1;
  readonly inclusionProof: BeaconInclusionProofV1;
  readonly randomnessReceipt: ExternalBeaconRandomnessReceiptV1;
} {
  const { runId, requestHash, policy, policyHash, pool, beacon, trust, store, clock, keys } = ctx;
  const poolCheckpoint = required(progress.poolCheckpoint, "pool checkpoint");
  const poolCheckpointHash = coreHash(poolCheckpoint);

  const round = beacon.firstFinalizedRoundAfter(poolCheckpoint.checkpointed_at);
  if (Date.parse(round.finalizedAt) <= Date.parse(poolCheckpoint.checkpointed_at)) {
    throw new Erl2Error(
      CODES.SELECTION_RANDOMNESS_BEFORE_POOL_CHECKPOINT,
      "beacon round finalized at or before the pool checkpoint",
    );
  }
  const pinnedSource = trust.randomnessSource(policy.source_id);
  if (pinnedSource.sourceTrustPolicyHash !== policy.source_trust_policy_hash) {
    throw new Erl2Error(
      CODES.RANDOMNESS_TRUST_REGISTRY_STALE,
      "policy source-trust hash differs from the locally pinned registry entry",
    );
  }
  const signatureProof = beacon.signatureProof(round);
  const inclusionProof = beacon.inclusionProof(round);
  verifyBeaconNativeProof({ proof: signatureProof, inclusion: inclusionProof, round, pinned: pinnedSource });
  // The beacon proofs are frozen as PUBLIC wire artifacts; validate them against
  // their closed schemas before freezing so the producer can never emit a
  // malformed proof the offline verifier would later reject (§11.13).
  assertContract("BeaconSignatureProofV1", signatureProof);
  assertContract("BeaconInclusionProofV1", inclusionProof);

  const signatureProofRef = store.freeze({
    logicalPath: `commitments/randomness/${round.roundId}.signature-proof.json`,
    bytes: proofBytes(signatureProof),
    mediaType: "application/json",
    classification: "PUBLIC",
  });
  const inclusionProofRef = store.freeze({
    logicalPath: `commitments/randomness/${round.roundId}.inclusion-proof.json`,
    bytes: proofBytes(inclusionProof),
    mediaType: "application/json",
    classification: "PUBLIC",
  });

  const bindingHash = sourceRequestBindingHash({
    selection_request_hash: requestHash,
    selection_randomness_policy_hash: policyHash,
    source_id: policy.source_id,
    source_trust_policy_hash: policy.source_trust_policy_hash,
    pool_root_hash: pool.manifest.pool_root_hash,
    pool_manifest_timestamp_checkpoint_hash: poolCheckpointHash,
  });
  const receiptBase = {
    schema_version: "external-beacon-randomness-receipt/v1" as const,
    receipt_id: `randomness-${round.roundId}`.slice(0, 64),
    run_id: runId,
    selection_request_hash: requestHash,
    eligibility_pool_manifest_hash: pool.manifestHash,
    pool_root_hash: pool.manifest.pool_root_hash,
    pool_manifest_timestamp_checkpoint_hash: poolCheckpointHash,
    randomness_policy_hash: policyHash,
    source_kind: "external_beacon" as const,
    source_id: policy.source_id,
    source_trust_policy_hash: policy.source_trust_policy_hash,
    source_round_id: round.roundId,
    source_request_binding_hash: bindingHash,
    randomness_output_base64: round.randomnessOutput.toString("base64"),
    randomness_output_hash: domainHash(HASH_DOMAINS.BEACON_ROUND_PAYLOAD, {
      randomness_output_base64: round.randomnessOutput.toString("base64"),
    }),
    beacon_signed_payload_hash: signatureProof.beacon_signed_payload_hash,
    beacon_inclusion_proof: inclusionProofRef,
    beacon_signature_proof: signatureProofRef,
    wrapper_kind: "lab_verifier_beacon_association" as const,
    association_rule: "first_finalized_round_after_pool_checkpoint" as const,
    beacon_signed_scope: "canonical_beacon_round_and_output_only" as const,
    wrapper_signed_scope: "erl_request_policy_source_pool_checkpoint_round_association" as const,
    round_observed_at: round.finalizedAt,
    wrapped_at: clock.now(),
  };
  const randomnessReceipt = assertContract<ExternalBeaconRandomnessReceiptV1>(
    "ExternalBeaconRandomnessReceiptV1",
    sealSigned(receiptBase, keys.wrapperSigner, SIGNATURE_DOMAINS.BEACON_ASSOCIATION, "wrapper_signature"),
  );
  assertActiveRandomnessReceiptVariant(randomnessReceipt);
  assertWrapperOwnership(randomnessReceipt, signatureProof);
  trust.assertRole(randomnessReceipt.wrapper_signature.key_id, "lab_verifier_association_signer");
  return {
    randomness: { randomnessOutput: round.randomnessOutput },
    signatureProof,
    inclusionProof,
    randomnessReceipt,
  };
}

/** Stage 3 — source-trust verification against locally pinned state. */
export function stageSourceTrust(
  ctx: SelectionContext,
  progress: SelectionProgress,
): RandomnessSourceTrustVerificationReportV1 {
  const { runId, policy, policyHash, trust, clock, keys } = ctx;
  const randomnessReceipt = required(progress.randomnessReceipt, "randomness receipt");
  const pinnedSource = trust.randomnessSource(policy.source_id);
  return assertContract<RandomnessSourceTrustVerificationReportV1>(
    "RandomnessSourceTrustVerificationReportV1",
    sealSigned(
      {
        schema_version: "randomness-source-trust-verification-report/v1" as const,
        report_id: `source-trust-${randomnessReceipt.source_round_id}`.slice(0, 64),
        run_id: runId,
        selection_randomness_policy_hash: policyHash,
        selection_randomness_receipt_hash: coreHash(randomnessReceipt),
        source_kind: "external_beacon" as const,
        source_id: policy.source_id,
        source_trust_policy_hash: policy.source_trust_policy_hash,
        verifier_pinned_registry_head_hash: trust.localConfiguration.randomnessRegistryHeadHash,
        authorized_beacon_key_ids: [...pinnedSource.beaconKeyIds],
        verified_beacon_key_ids: [required(progress.signatureProof, "beacon signature proof").signature.key_id],
        authorized_wrapper_key_ids: [keys.wrapperSigner.keyId],
        verified_wrapper_key_ids: [randomnessReceipt.wrapper_signature.key_id],
        checks: {
          policy_source_authorized: TRUE,
          policy_trust_hash_pinned: TRUE,
          receipt_source_matches: TRUE,
          beacon_keys_subset_authorized: TRUE,
          wrapper_key_authorized_by_run_trust_policy: TRUE,
          beacon_native_scope_verified: TRUE,
          source_proof_valid: TRUE,
          wrapper_signature_valid: TRUE,
          wrapper_scope_verified: TRUE,
          registry_current_and_non_revoked: TRUE,
        },
        verified_at: clock.now(),
      },
      keys.sourceTrustVerifier,
    ),
  );
}

/** Stage 4 — deterministic derivation and the selector's commitment. */
export function stageCommitment(
  ctx: SelectionContext,
  progress: SelectionProgress,
): {
  readonly derived: { readonly index: number; readonly rejectionCount: number };
  readonly selectedEntry: SelectionPoolEntry;
  readonly commitment: SelectionCommitmentV2;
} {
  const { runId, request, requestHash, pool, clock, keys } = ctx;
  const randomness = required(progress.randomness, "observed randomness");
  const randomnessReceipt = required(progress.randomnessReceipt, "randomness receipt");
  const sourceTrustReport = required(progress.sourceTrustReport, "source trust report");

  const derived = deriveSelectedIndex(
    randomness.randomnessOutput,
    request.request_nonce,
    pool.manifest.pool_root_hash,
    pool.manifest.entry_count,
  );
  const selectedEntry = pool.entries[derived.index];
  if (!selectedEntry) {
    throw new Erl2Error(CODES.SELECTION_RANDOMNESS_INDEX_MISMATCH, "derived index is outside the pool");
  }
  const commitment = assertContract<SelectionCommitmentV2>(
    "SelectionCommitmentV2",
    sealSigned(
      {
        schema_version: "selection-commitment/v2" as const,
        commitment_id: `selection-commitment-${runId.slice(0, 8)}`,
        run_id: runId,
        selection_request_hash: requestHash,
        eligibility_pool_manifest_hash: pool.manifestHash,
        pool_root_hash: pool.manifest.pool_root_hash,
        selection_randomness_receipt_hash: coreHash(randomnessReceipt),
        source_trust_verification_report_hash: coreHash(sourceTrustReport),
        selected_opaque_entry_handle: selectedEntry.entry.opaque_entry_handle,
        selected_entry_hash: selectedEntry.entryHash,
        selection_algorithm: "hmac-sha256-rejection-sampling/v1" as const,
        committed_at: clock.now(),
      },
      keys.selector,
    ),
  );
  return { derived, selectedEntry, commitment };
}

/** Stage 5 — anchor the commitment before anything may be opened. */
export function stageCommitmentCheckpoint(
  ctx: SelectionContext,
  progress: SelectionProgress,
): TrustedTimestampCheckpointV1 {
  const commitment = required(progress.commitment, "selection commitment");
  const commitmentHash = coreHash(commitment);
  const checkpoint = ctx.timestamps.anchor({
    artifactSchemaVersion: commitment.schema_version,
    artifactCoreHash: commitmentHash,
    signerKeyId: commitment.signature.key_id,
    signature: commitment.signature,
  });
  assertAnchors(checkpoint, commitmentHash, commitment.schema_version);
  assertArtifactDoesNotEmbedCheckpoint(commitment, coreHash(checkpoint));
  return checkpoint;
}

/**
 * Stage 6 — threshold reveal, only after the commitment checkpoint.
 *
 * Like {@link stageRandomness} this is a one-shot: custodian shares are released
 * here, and a resume that re-entered would release them a second time. A caller
 * holding a retained reveal receipt must rebuild it rather than call again.
 */
export function stageReveal(
  ctx: SelectionContext,
  progress: SelectionProgress,
): ThresholdRevealReceiptV1 {
  const { runId, store, clock, keys, revealThreshold, accessLogHeadHash } = ctx;
  const commitment = required(progress.commitment, "selection commitment");
  const commitmentCheckpoint = required(progress.commitmentCheckpoint, "commitment checkpoint");
  const selectedEntry = required(progress.selectedEntry, "selected entry");

  if (keys.custodians.length < revealThreshold) {
    throw new Erl2Error(
      CODES.NON_COLLUSION_THRESHOLD_INSUFFICIENT,
      "fewer custodians than the configured reveal threshold",
    );
  }
  const envelope = parseEnvelope(store.read(selectedEntry.envelopeLogicalPath));
  const released = keys.custodians
    .slice(0, revealThreshold)
    .map((custodian) => releaseShare(envelope, custodian, selectedEntry.entry.opaque_entry_handle));
  const commitmentHash = coreHash(commitment);
  const commitmentCheckpointHash = coreHash(commitmentCheckpoint);
  const shareReceiptHashes = released.map((r) =>
    domainHash(HASH_DOMAINS.DECRYPTION_SHARE_RECEIPT, {
      run_id: runId,
      selection_commitment_hash: commitmentHash,
      commitment_timestamp_checkpoint_hash: commitmentCheckpointHash,
      custodian_key_id: r.custodianKeyId,
      share_index: r.share.x,
    }),
  );
  const revealBase = {
    schema_version: "threshold-reveal-receipt/v1" as const,
    receipt_id: `threshold-reveal-${runId.slice(0, 8)}`,
    run_id: runId,
    selection_commitment_hash: commitmentHash,
    commitment_timestamp_checkpoint_hash: commitmentCheckpointHash,
    selected_entry_hash: selectedEntry.entryHash,
    threshold: revealThreshold,
    participant_key_ids: keys.custodianSigners.slice(0, revealThreshold).map((k) => k.keyId),
    decryption_share_receipt_hashes: shareReceiptHashes,
    append_only_access_log_head_hash: accessLogHeadHash,
    released_at: clock.now(),
  };
  const revealCoreHash = coreHash(revealBase);
  return assertContract<ThresholdRevealReceiptV1>("ThresholdRevealReceiptV1", {
    ...revealBase,
    core_hash: revealCoreHash,
    participant_signatures: keys.custodianSigners
      .slice(0, revealThreshold)
      .map((k) => signCoreHash(k, SIGNATURE_DOMAINS.THRESHOLD_REVEAL, revealCoreHash)),
  });
}

/** Stage 7 — open ONLY the selected entry and bind it. */
export function stageBinding(
  ctx: SelectionContext,
  progress: SelectionProgress,
): {
  readonly opened: OpenedPayload;
  readonly binding: SelectedChallengeJourneyBindingV1;
} {
  const { runId, store, clock, keys, revealThreshold } = ctx;
  const commitment = required(progress.commitment, "selection commitment");
  const commitmentCheckpoint = required(progress.commitmentCheckpoint, "commitment checkpoint");
  const selectedEntry = required(progress.selectedEntry, "selected entry");
  const thresholdRevealReceipt = required(progress.thresholdRevealReceipt, "threshold reveal receipt");

  const envelope = parseEnvelope(store.read(selectedEntry.envelopeLogicalPath));
  const released = keys.custodians
    .slice(0, revealThreshold)
    .map((custodian) => releaseShare(envelope, custodian, selectedEntry.entry.opaque_entry_handle));
  const plaintext = openThresholdEnvelope(envelope, released, selectedEntry.entry.opaque_entry_handle);
  const opened = JSON.parse(plaintext.toString("utf8")) as OpenedPayload;
  assertContract("HiddenBindingPayloadV1", JSON.parse(plaintext.toString("utf8")));

  const recomputedCommitment = hidingCommitment({
    challenge_manifest_hash: opened.challenge_manifest_hash,
    persona_script_hash: opened.persona_script_hash,
    journey_hash: opened.journey_hash,
    ordered_step_commitment_hashes: opened.ordered_step_commitment_hashes,
    exposure_epoch: opened.exposure_epoch,
    opening_nonce_base64: opened.opening_nonce_base64,
  });
  if (recomputedCommitment !== selectedEntry.entry.challenge_actor_journey_hiding_commitment) {
    throw new Erl2Error(
      CODES.SELECTION_CHAIN_HIDING_COMMITMENT_MISMATCH,
      "opened payload does not reproduce the entry's hiding commitment",
    );
  }

  const commitmentHash = coreHash(commitment);
  const thresholdRevealReceiptHash = coreHash(thresholdRevealReceipt);
  const binding = assertContract<SelectedChallengeJourneyBindingV1>(
    "SelectedChallengeJourneyBindingV1",
    sealSigned(
      {
        schema_version: "selected-challenge-journey-binding/v1" as const,
        run_id: runId,
        selection_commitment_hash: commitmentHash,
        selected_opaque_entry_handle: selectedEntry.entry.opaque_entry_handle,
        pool_entry_hash: selectedEntry.entryHash,
        encrypted_binding_payload_file_sha256: selectedEntry.entry.encrypted_binding_payload.file_sha256,
        payload_plaintext_hash: domainHash(HASH_DOMAINS.POOL_ACTOR_JOURNEY, {
          payload_plaintext_base64: plaintext.toString("base64"),
        }),
        challenge_manifest_hash: opened.challenge_manifest_hash,
        persona_script_hash: opened.persona_script_hash,
        journey_hash: opened.journey_hash,
        ordered_step_commitment_hashes: opened.ordered_step_commitment_hashes,
        exposure_epoch: opened.exposure_epoch,
        threshold_reveal_receipt_hash: thresholdRevealReceiptHash,
        opening_nonce_base64: opened.opening_nonce_base64,
        opening_event_hash: openingEventHash(ctx, progress),
        opened_at: clock.now(),
      },
      keys.revealAuthority,
    ),
  );
  return { opened, binding };
}

/** The opening event's identity, recomputed identically by producer and verifier. */
export function openingEventHash(ctx: SelectionContext, progress: SelectionProgress): Hash {
  const commitment = required(progress.commitment, "selection commitment");
  const commitmentCheckpoint = required(progress.commitmentCheckpoint, "commitment checkpoint");
  const selectedEntry = required(progress.selectedEntry, "selected entry");
  const thresholdRevealReceipt = required(progress.thresholdRevealReceipt, "threshold reveal receipt");
  return domainHash(HASH_DOMAINS.LIFECYCLE_EVENT, {
    run_id: ctx.runId,
    event_type: "selected_entry_opened",
    selection_commitment_hash: coreHash(commitment),
    commitment_timestamp_checkpoint_hash: coreHash(commitmentCheckpoint),
    selected_entry_hash: selectedEntry.entryHash,
    threshold_reveal_receipt_hash: coreHash(thresholdRevealReceipt),
  });
}

/** Stage 8 — anchor the binding before the proof may be produced. */
export function stageBindingCheckpoint(
  ctx: SelectionContext,
  progress: SelectionProgress,
): TrustedTimestampCheckpointV1 {
  const binding = required(progress.binding, "selected binding");
  const bindingHashValue = coreHash(binding);
  const checkpoint = ctx.timestamps.anchor({
    artifactSchemaVersion: binding.schema_version,
    artifactCoreHash: bindingHashValue,
    signerKeyId: binding.signature.key_id,
    signature: binding.signature,
  });
  assertAnchors(checkpoint, bindingHashValue, binding.schema_version);
  assertArtifactDoesNotEmbedCheckpoint(binding, coreHash(checkpoint));
  return checkpoint;
}

/** Stage 9 — the selector's proof over the completed chain. */
export function stageProof(ctx: SelectionContext, progress: SelectionProgress): SelectionProofV2 {
  const { runId, request, requestHash, policy, policyHash, pool, clock, keys } = ctx;
  const poolCheckpoint = required(progress.poolCheckpoint, "pool checkpoint");
  const randomnessReceipt = required(progress.randomnessReceipt, "randomness receipt");
  const sourceTrustReport = required(progress.sourceTrustReport, "source trust report");
  const commitment = required(progress.commitment, "selection commitment");
  const commitmentCheckpoint = required(progress.commitmentCheckpoint, "commitment checkpoint");
  const thresholdRevealReceipt = required(progress.thresholdRevealReceipt, "threshold reveal receipt");
  const binding = required(progress.binding, "selected binding");
  const bindingCheckpoint = required(progress.bindingCheckpoint, "binding checkpoint");
  const derived = required(progress.derived, "derived index");
  const selectedEntry = required(progress.selectedEntry, "selected entry");

  return assertContract<SelectionProofV2>(
    "SelectionProofV2",
    sealSigned(
      {
        schema_version: "selection-proof/v2" as const,
        proof_id: `selection-proof-${runId.slice(0, 8)}`,
        run_id: runId,
        selection_request_hash: requestHash,
        eligibility_pool_manifest_hash: pool.manifestHash,
        pool_manifest_timestamp_checkpoint_hash: coreHash(poolCheckpoint),
        selection_randomness_policy_hash: policyHash,
        randomness_source_kind: "external_beacon" as const,
        randomness_source_id: policy.source_id,
        randomness_source_trust_policy_hash: policy.source_trust_policy_hash,
        source_request_binding_hash: randomnessReceipt.source_request_binding_hash,
        source_trust_verification_report_hash: coreHash(sourceTrustReport),
        selection_randomness_receipt_hash: coreHash(randomnessReceipt),
        selection_commitment_hash: coreHash(commitment),
        commitment_timestamp_checkpoint_hash: coreHash(commitmentCheckpoint),
        threshold_reveal_receipt_hash: coreHash(thresholdRevealReceipt),
        selected_binding_hash: coreHash(binding),
        binding_timestamp_checkpoint_hash: coreHash(bindingCheckpoint),
        request_nonce: request.request_nonce,
        algorithm: "hmac-sha256-rejection-sampling/v1" as const,
        rejection_count: derived.rejectionCount,
        derived_index: derived.index,
        derived_opaque_entry_handle: selectedEntry.entry.opaque_entry_handle,
        pool_checkpoint_precedes_randomness: TRUE,
        randomness_precedes_source_trust: TRUE,
        source_trust_precedes_commitment: TRUE,
        commitment_checkpoint_precedes_opening: TRUE,
        opening_precedes_binding: TRUE,
        binding_checkpoint_precedes_proof: TRUE,
        opening_event_hash: binding.opening_event_hash,
        proved_at: clock.now(),
      },
      keys.selector,
    ),
  );
}

/**
 * Stage 10 — the auditor's **independently re-derived** verification receipt
 * (ADR-ERL2-020 §7).
 *
 * The receipt used to be signed straight from the producer's own in-memory
 * values, with all thirty-two `checks` booleans hardcoded `true`. That attested
 * nothing: "I agree with what I just computed" carries no evidence, whichever
 * key signs it, so §3's choice of the auditor role would have been cosmetic.
 *
 * The auditor now runs the **verifier kernel** — `verifySelectionChainCore`,
 * the same function the offline public verifier uses — over the retained chain,
 * and signs only if that independent derivation reproduces the producer's
 * selected entry, index and rejection count. A producer bug that computed the
 * wrong index would be caught here rather than attested.
 *
 * The two paths share one formula (`Independent-Code-Review.md:87`), so this
 * does not close the spec-vs-implementation risk: a wrong formula computes the
 * same wrong value on both sides. That is what the known-answer vectors are for,
 * and it stays open. What this does close is *producer divergence* — the chain
 * disagreeing with its own verifier.
 */
export function stageReceipt(
  ctx: SelectionContext,
  progress: SelectionProgress,
): SelectionVerificationReceiptV2 {
  const { runId, requestHash, policy, policyHash, pool, clock, keys } = ctx;
  const poolCheckpoint = required(progress.poolCheckpoint, "pool checkpoint");
  const randomnessReceipt = required(progress.randomnessReceipt, "randomness receipt");
  const sourceTrustReport = required(progress.sourceTrustReport, "source trust report");
  const commitment = required(progress.commitment, "selection commitment");
  const commitmentCheckpoint = required(progress.commitmentCheckpoint, "commitment checkpoint");
  const thresholdRevealReceipt = required(progress.thresholdRevealReceipt, "threshold reveal receipt");
  const binding = required(progress.binding, "selected binding");
  const bindingCheckpoint = required(progress.bindingCheckpoint, "binding checkpoint");
  const proof = required(progress.proof, "selection proof");
  const selectedEntry = required(progress.selectedEntry, "selected entry");
  const derived = required(progress.derived, "derived index");
  const signatureProof = required(progress.signatureProof, "beacon signature proof");
  const inclusionProof = required(progress.inclusionProof, "beacon inclusion proof");

  // The independent re-derivation. Note what is *not* passed: the receipt, which
  // does not exist yet, and none of the producer's intermediate values — the
  // kernel recomputes the pool root, the source/request binding, the derived
  // index and the rejection count from the retained artifacts alone.
  const audited = verifySelectionChainCore(
    {
      request: ctx.request,
      roleAudit: ctx.roleAudit,
      policy: ctx.policy,
      poolManifest: pool.manifest,
      poolEntries: pool.entries.map((e) => e.entry),
      poolCheckpoint,
      randomnessReceipt,
      beaconSignatureProof: signatureProof,
      beaconInclusionProof: inclusionProof,
      sourceTrustReport,
      commitment,
      commitmentCheckpoint,
      thresholdRevealReceipt,
      binding,
      bindingCheckpoint,
      proof,
    },
    ctx.trust,
  );

  // The auditor signs only what it reproduced. A disagreement here means the
  // producer and the verifier derived different selections from the same
  // evidence, which must never be attested away.
  if (
    audited.selectedEntryHash !== selectedEntry.entryHash ||
    audited.derivedIndex !== derived.index ||
    audited.rejectionCount !== derived.rejectionCount ||
    audited.poolRootHash !== pool.manifest.pool_root_hash ||
    audited.sourceRequestBindingHash !== randomnessReceipt.source_request_binding_hash
  ) {
    throw new Erl2Error(
      CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
      `the auditor's independent re-derivation disagrees with the producer: ` +
        `entry ${audited.selectedEntryHash} vs ${selectedEntry.entryHash}, ` +
        `index ${String(audited.derivedIndex)} vs ${String(derived.index)}`,
    );
  }

  return assertContract<SelectionVerificationReceiptV2>(
    "SelectionVerificationReceiptV2",
    sealSigned(
      {
        schema_version: "selection-verification-receipt/v2" as const,
        receipt_id: `selection-receipt-${runId.slice(0, 8)}`,
        run_id: runId,
        selection_request_hash: requestHash,
        eligibility_pool_manifest_hash: pool.manifestHash,
        selection_commitment_hash: coreHash(commitment),
        selection_proof_hash: coreHash(proof),
        selection_randomness_policy_hash: policyHash,
        randomness_source_kind: "external_beacon" as const,
        randomness_source_id: policy.source_id,
        randomness_source_trust_policy_hash: policy.source_trust_policy_hash,
        source_request_binding_hash: randomnessReceipt.source_request_binding_hash,
        source_trust_verification_report_hash: coreHash(sourceTrustReport),
        selection_randomness_receipt_hash: coreHash(randomnessReceipt),
        pool_manifest_timestamp_checkpoint_hash: coreHash(poolCheckpoint),
        commitment_timestamp_checkpoint_hash: coreHash(commitmentCheckpoint),
        threshold_reveal_receipt_hash: coreHash(thresholdRevealReceipt),
        selected_binding_hash: coreHash(binding),
        binding_timestamp_checkpoint_hash: coreHash(bindingCheckpoint),
        selection_role_separation_audit_hash: pool.manifest.selection_role_separation_audit_hash,
        journey_selection_policy_hash: pool.manifest.journey_selection_policy_hash,
        verified_selected_entry_hash: selectedEntry.entryHash,
        checks: {
          request_pool_bound: TRUE,
          role_separation_precedes_pool: TRUE,
          ordered_entry_root_verified: TRUE,
          uniform_selector_metadata_verified: TRUE,
          selected_entry_in_pool: TRUE,
          pool_checkpoint_verified: TRUE,
          single_policy_source_verified: TRUE,
          source_request_binding_verified: TRUE,
          randomness_variant_verified: TRUE,
          beacon_native_proof_verified: TRUE,
          beacon_wrapper_signature_verified: TRUE,
          beacon_wrapper_scope_verified: TRUE,
          threshold_vrf_inactive_verified: TRUE,
          verifier_pinned_source_trust_verified: TRUE,
          independent_randomness_verified: TRUE,
          pool_checkpoint_precedes_randomness: TRUE,
          randomness_precedes_source_trust: TRUE,
          source_trust_precedes_commitment: TRUE,
          commitment_checkpoint_verified: TRUE,
          commitment_checkpoint_precedes_opening: TRUE,
          threshold_reveal_verified: TRUE,
          opening_precedes_binding: TRUE,
          binding_checkpoint_verified: TRUE,
          binding_checkpoint_precedes_proof: TRUE,
          selection_algorithm_verified: TRUE,
          hiding_commitment_opened: TRUE,
          manifest_journey_steps_verified: TRUE,
          journey_family_verified: TRUE,
          actor_family_verified: TRUE,
          exposure_eligible: TRUE,
          role_separation_verified: TRUE,
          access_log_verified: TRUE,
        },
        verified_at: clock.now(),
      },
      keys.verifier,
    ),
  );
}
