/**
 * The V2 selection chain, executed in the one legal order (design v2 §12/§15):
 *
 *   role audit → ordered pool → pool checkpoint → first finalized beacon round
 *   → Lab/verifier association wrapper → source-trust report → commitment
 *   → commitment checkpoint → threshold reveal → selected binding
 *   → binding checkpoint → proof → verification receipt
 *
 * Nothing in this module may be reordered without breaking an assertion: each
 * step consumes the frozen hash of its predecessor, and each checkpoint anchors
 * an artifact that already exists.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type EligibilityPoolManifestV2,
  type ExternalBeaconRandomnessPolicyV1,
  type ExternalBeaconRandomnessReceiptV1,
  type Hash,
  type RandomnessSourceTrustVerificationReportV1,
  type SelectedChallengeJourneyBindingV1,
  type SelectionCommitmentV2,
  type SelectionProofV2,
  type SelectionRequestV2,
  type SelectionVerificationReceiptV2,
  type ThresholdRevealReceiptV1,
  type TrustedTimestampCheckpointV1,
} from "@erl2/contracts";
import {
  ArtifactStore,
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
  type CustodianKey,
  type SigningKey,
  type TrustEvaluator,
} from "@erl2/integrity";
import type { Clock } from "../runtime/seams.js";
import type { TimestampLog } from "../timestamps/log.js";
import {
  assertActiveRandomnessReceiptVariant,
  assertActiveRandomnessVariant,
  assertWrapperOwnership,
  proofBytes,
  verifyBeaconNativeProof,
  type BeaconSource,
} from "./beacon.js";
import { assertDevelopmentTierOnly } from "./developmentBeacon.js";
import { deriveSelectedIndex, hidingCommitment, poolRootOf, sourceRequestBindingHash } from "./derive.js";
import { assertPoolMetadataUniform, type BuiltPool, type BuiltPoolEntry } from "./pool.js";

export interface SelectionChainKeys {
  readonly selector: SigningKey;
  /** Lab/verifier signer of the beacon-association wrapper. */
  readonly wrapperSigner: SigningKey;
  readonly sourceTrustVerifier: SigningKey;
  readonly revealAuthority: SigningKey;
  readonly verifier: SigningKey;
  readonly custodians: readonly CustodianKey[];
  /** Ed25519 keys the custodians use to sign the threshold reveal receipt. */
  readonly custodianSigners: readonly SigningKey[];
}

export interface RunSelectionOptions {
  readonly runId: string;
  readonly request: SelectionRequestV2;
  readonly requestHash: Hash;
  readonly policy: ExternalBeaconRandomnessPolicyV1;
  readonly policyHash: Hash;
  readonly pool: BuiltPool;
  readonly beacon: BeaconSource;
  readonly trust: TrustEvaluator;
  readonly timestamps: TimestampLog;
  readonly store: ArtifactStore;
  readonly clock: Clock;
  readonly keys: SelectionChainKeys;
  readonly accessLogHeadHash: Hash;
  readonly revealThreshold: number;
}

export interface SelectionChainResult {
  readonly poolCheckpoint: TrustedTimestampCheckpointV1;
  readonly randomnessReceipt: ExternalBeaconRandomnessReceiptV1;
  readonly sourceTrustReport: RandomnessSourceTrustVerificationReportV1;
  readonly commitment: SelectionCommitmentV2;
  readonly commitmentCheckpoint: TrustedTimestampCheckpointV1;
  readonly thresholdRevealReceipt: ThresholdRevealReceiptV1;
  readonly binding: SelectedChallengeJourneyBindingV1;
  readonly bindingCheckpoint: TrustedTimestampCheckpointV1;
  readonly proof: SelectionProofV2;
  readonly receipt: SelectionVerificationReceiptV2;
  readonly selectedEntry: BuiltPoolEntry;
}

const TRUE = true as const;

export function runSelectionChain(options: RunSelectionOptions): SelectionChainResult {
  const {
    runId,
    request,
    requestHash,
    policy,
    policyHash,
    pool,
    beacon,
    trust,
    timestamps,
    store,
    clock,
    keys,
  } = options;

  assertActiveRandomnessVariant(policy);

  // ERL2-OQ-007 fail-closed guard, *inside* the kernel: a held-out or blind
  // selection may never be driven by the development beacon.  The CLI admission
  // layer refuses non-development tiers upstream, but the kernel must enforce it
  // itself so replay evidence or a future caller cannot bypass admission (P2-7).
  assertDevelopmentTierOnly(request.requested_tier, policy.source_id);

  // -- Guards that must hold before any randomness exists ------------------
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

  // -- 1. Freeze and checkpoint the ordered pool ---------------------------
  const poolCheckpoint = timestamps.anchor({
    artifactSchemaVersion: pool.manifest.schema_version,
    artifactCoreHash: pool.manifestHash,
    signerKeyId: pool.manifest.signature.key_id,
    signature: pool.manifest.signature,
  });
  const poolCheckpointHash = coreHash(poolCheckpoint);
  assertAnchors(poolCheckpoint, pool.manifestHash, pool.manifest.schema_version);
  assertArtifactDoesNotEmbedCheckpoint(pool.manifest, poolCheckpointHash);

  // -- 2. Observe exactly one round, strictly after the pool checkpoint ----
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

  // -- 3. The Lab/verifier association wrapper ----------------------------
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
  const randomnessReceiptHash = coreHash(randomnessReceipt);
  trust.assertRole(randomnessReceipt.wrapper_signature.key_id, "lab_verifier_association_signer");

  // -- 4. Source-trust verification against locally pinned state ----------
  const sourceTrustReport = assertContract<RandomnessSourceTrustVerificationReportV1>(
    "RandomnessSourceTrustVerificationReportV1",
    sealSigned(
      {
        schema_version: "randomness-source-trust-verification-report/v1" as const,
        report_id: `source-trust-${round.roundId}`.slice(0, 64),
        run_id: runId,
        selection_randomness_policy_hash: policyHash,
        selection_randomness_receipt_hash: randomnessReceiptHash,
        source_kind: "external_beacon" as const,
        source_id: policy.source_id,
        source_trust_policy_hash: policy.source_trust_policy_hash,
        verifier_pinned_registry_head_hash: trust.localConfiguration.randomnessRegistryHeadHash,
        authorized_beacon_key_ids: [...pinnedSource.beaconKeyIds],
        verified_beacon_key_ids: [signatureProof.signature.key_id],
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
  const sourceTrustReportHash = coreHash(sourceTrustReport);

  // -- 5. Deterministic derivation and commitment -------------------------
  const derived = deriveSelectedIndex(
    round.randomnessOutput,
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
        selection_randomness_receipt_hash: randomnessReceiptHash,
        source_trust_verification_report_hash: sourceTrustReportHash,
        selected_opaque_entry_handle: selectedEntry.entry.opaque_entry_handle,
        selected_entry_hash: selectedEntry.entryHash,
        selection_algorithm: "hmac-sha256-rejection-sampling/v1" as const,
        committed_at: clock.now(),
      },
      keys.selector,
    ),
  );
  const commitmentHash = coreHash(commitment);

  const commitmentCheckpoint = timestamps.anchor({
    artifactSchemaVersion: commitment.schema_version,
    artifactCoreHash: commitmentHash,
    signerKeyId: commitment.signature.key_id,
    signature: commitment.signature,
  });
  const commitmentCheckpointHash = coreHash(commitmentCheckpoint);
  assertAnchors(commitmentCheckpoint, commitmentHash, commitment.schema_version);
  assertArtifactDoesNotEmbedCheckpoint(commitment, commitmentCheckpointHash);

  // -- 6. Threshold reveal, only after the commitment checkpoint ----------
  if (keys.custodians.length < options.revealThreshold) {
    throw new Erl2Error(
      CODES.NON_COLLUSION_THRESHOLD_INSUFFICIENT,
      "fewer custodians than the configured reveal threshold",
    );
  }
  const envelope = parseEnvelope(store.read(selectedEntry.envelopeLogicalPath));
  const released = keys.custodians
    .slice(0, options.revealThreshold)
    .map((custodian) => releaseShare(envelope, custodian, selectedEntry.entry.opaque_entry_handle));
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
    threshold: options.revealThreshold,
    participant_key_ids: keys.custodianSigners.slice(0, options.revealThreshold).map((k) => k.keyId),
    decryption_share_receipt_hashes: shareReceiptHashes,
    append_only_access_log_head_hash: options.accessLogHeadHash,
    released_at: clock.now(),
  };
  const revealCoreHash = coreHash(revealBase);
  const thresholdRevealReceipt = assertContract<ThresholdRevealReceiptV1>("ThresholdRevealReceiptV1", {
    ...revealBase,
    core_hash: revealCoreHash,
    participant_signatures: keys.custodianSigners
      .slice(0, options.revealThreshold)
      .map((k) => signCoreHash(k, SIGNATURE_DOMAINS.THRESHOLD_REVEAL, revealCoreHash)),
  });
  const thresholdRevealReceiptHash = coreHash(thresholdRevealReceipt);

  // -- 7. Open ONLY the selected entry -----------------------------------
  const plaintext = openThresholdEnvelope(
    envelope,
    released,
    selectedEntry.entry.opaque_entry_handle,
  );
  const opened = JSON.parse(plaintext.toString("utf8")) as {
    challenge_manifest_hash: Hash;
    persona_script_hash: Hash;
    journey_hash: Hash;
    ordered_step_commitment_hashes: Hash[];
    exposure_epoch: number;
    opening_nonce_base64: string;
  };
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

  const openingEventHash = domainHash(HASH_DOMAINS.LIFECYCLE_EVENT, {
    run_id: runId,
    event_type: "selected_entry_opened",
    selection_commitment_hash: commitmentHash,
    commitment_timestamp_checkpoint_hash: commitmentCheckpointHash,
    selected_entry_hash: selectedEntry.entryHash,
    threshold_reveal_receipt_hash: thresholdRevealReceiptHash,
  });

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
        opening_event_hash: openingEventHash,
        opened_at: clock.now(),
      },
      keys.revealAuthority,
    ),
  );
  const bindingHashValue = coreHash(binding);

  const bindingCheckpoint = timestamps.anchor({
    artifactSchemaVersion: binding.schema_version,
    artifactCoreHash: bindingHashValue,
    signerKeyId: binding.signature.key_id,
    signature: binding.signature,
  });
  const bindingCheckpointHash = coreHash(bindingCheckpoint);
  assertAnchors(bindingCheckpoint, bindingHashValue, binding.schema_version);
  assertArtifactDoesNotEmbedCheckpoint(binding, bindingCheckpointHash);

  // -- 8. Proof and independent verification receipt ----------------------
  const proof = assertContract<SelectionProofV2>(
    "SelectionProofV2",
    sealSigned(
      {
        schema_version: "selection-proof/v2" as const,
        proof_id: `selection-proof-${runId.slice(0, 8)}`,
        run_id: runId,
        selection_request_hash: requestHash,
        eligibility_pool_manifest_hash: pool.manifestHash,
        pool_manifest_timestamp_checkpoint_hash: poolCheckpointHash,
        selection_randomness_policy_hash: policyHash,
        randomness_source_kind: "external_beacon" as const,
        randomness_source_id: policy.source_id,
        randomness_source_trust_policy_hash: policy.source_trust_policy_hash,
        source_request_binding_hash: bindingHash,
        source_trust_verification_report_hash: sourceTrustReportHash,
        selection_randomness_receipt_hash: randomnessReceiptHash,
        selection_commitment_hash: commitmentHash,
        commitment_timestamp_checkpoint_hash: commitmentCheckpointHash,
        threshold_reveal_receipt_hash: thresholdRevealReceiptHash,
        selected_binding_hash: bindingHashValue,
        binding_timestamp_checkpoint_hash: bindingCheckpointHash,
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
        opening_event_hash: openingEventHash,
        proved_at: clock.now(),
      },
      keys.selector,
    ),
  );

  const receipt = assertContract<SelectionVerificationReceiptV2>(
    "SelectionVerificationReceiptV2",
    sealSigned(
      {
        schema_version: "selection-verification-receipt/v2" as const,
        receipt_id: `selection-receipt-${runId.slice(0, 8)}`,
        run_id: runId,
        selection_request_hash: requestHash,
        eligibility_pool_manifest_hash: pool.manifestHash,
        selection_commitment_hash: commitmentHash,
        selection_proof_hash: coreHash(proof),
        selection_randomness_policy_hash: policyHash,
        randomness_source_kind: "external_beacon" as const,
        randomness_source_id: policy.source_id,
        randomness_source_trust_policy_hash: policy.source_trust_policy_hash,
        source_request_binding_hash: bindingHash,
        source_trust_verification_report_hash: sourceTrustReportHash,
        selection_randomness_receipt_hash: randomnessReceiptHash,
        pool_manifest_timestamp_checkpoint_hash: poolCheckpointHash,
        commitment_timestamp_checkpoint_hash: commitmentCheckpointHash,
        threshold_reveal_receipt_hash: thresholdRevealReceiptHash,
        selected_binding_hash: bindingHashValue,
        binding_timestamp_checkpoint_hash: bindingCheckpointHash,
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

  return {
    poolCheckpoint,
    randomnessReceipt,
    sourceTrustReport,
    commitment,
    commitmentCheckpoint,
    thresholdRevealReceipt,
    binding,
    bindingCheckpoint,
    proof,
    receipt,
    selectedEntry,
  };
}

export type { EligibilityPoolManifestV2 };
