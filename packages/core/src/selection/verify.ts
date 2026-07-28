/**
 * Independent verification of the complete V2 selection chain.
 *
 * This function trusts **no** boolean literal in any producer artifact as its
 * verification authority.  Every property that `SelectionVerificationReceiptV2`
 * attests to is *independently re-derived* below (pool root, source-request
 * binding, deterministic selected index and rejection count, beacon proofs,
 * checkpoint ordering, hiding-commitment opening, role separation, …), and this
 * function throws before returning if any derivation fails.
 *
 * The receipt's `checks` booleans are schema-pinned to `const: true`, so they
 * are producer attestations that carry no independent authority.  Because the
 * verifier re-derives everything they name, it does not *rely* on them; but it
 * does read and enforce them as defense in depth (review §11.10): a receipt that
 * dropped a check key or attested one as anything other than `true` is refused,
 * so a receipt can never claim *less* verification than the chain actually
 * proves.  The earlier docstring claimed the literals were the thing re-derived
 * and refused on mismatch, which was misleading — the derivation is the
 * authority; the literals are only cross-checked for completeness.
 */

import {
  CODES,
  Erl2Error,
  type EligibilityPoolEntryV2,
  type EligibilityPoolManifestV2,
  type ExternalBeaconRandomnessPolicyV1,
  type ExternalBeaconRandomnessReceiptV1,
  type Hash,
  type RandomnessSourceTrustVerificationReportV1,
  type SelectedChallengeJourneyBindingV1,
  type SelectionCommitmentV2,
  type SelectionProofV2,
  type SelectionRequestV2,
  type SelectionRoleSeparationAuditV1,
  type SelectionVerificationReceiptV2,
  type ThresholdRevealReceiptV1,
  type TrustedTimestampCheckpointV1,
} from "@erl2/contracts";
import {
  anchoredAt,
  assertAnchors,
  assertArtifactDoesNotEmbedCheckpoint,
  assertStrictlyBefore,
  coreHash,
  SIGNATURE_DOMAINS,
  verifySignature,
  type TrustEvaluator,
} from "@erl2/integrity";
import {
  assertActiveRandomnessReceiptVariant,
  assertActiveRandomnessVariant,
  assertWrapperOwnership,
  verifyBeaconNativeProof,
  type BeaconInclusionProofV1,
  type BeaconSignatureProofV1,
} from "./beacon.js";
import { assertDevelopmentTierOnly } from "./developmentBeacon.js";
import { deriveSelectedIndex, hidingCommitment, poolRootOf, sourceRequestBindingHash } from "./derive.js";
import { assertPoolMetadataUniform } from "./pool.js";

export interface SelectionChainEvidence {
  readonly request: SelectionRequestV2;
  readonly roleAudit: SelectionRoleSeparationAuditV1;
  readonly policy: ExternalBeaconRandomnessPolicyV1;
  readonly poolManifest: EligibilityPoolManifestV2;
  readonly poolEntries: readonly EligibilityPoolEntryV2[];
  readonly poolCheckpoint: TrustedTimestampCheckpointV1;
  readonly randomnessReceipt: ExternalBeaconRandomnessReceiptV1;
  readonly beaconSignatureProof: BeaconSignatureProofV1;
  readonly beaconInclusionProof: BeaconInclusionProofV1;
  readonly sourceTrustReport: RandomnessSourceTrustVerificationReportV1;
  readonly commitment: SelectionCommitmentV2;
  readonly commitmentCheckpoint: TrustedTimestampCheckpointV1;
  readonly thresholdRevealReceipt: ThresholdRevealReceiptV1;
  readonly binding: SelectedChallengeJourneyBindingV1;
  readonly bindingCheckpoint: TrustedTimestampCheckpointV1;
  readonly proof: SelectionProofV2;
  readonly receipt: SelectionVerificationReceiptV2;
}

/**
 * The chain minus the verification receipt.
 *
 * The receipt attests that the chain verified, so whoever *produces* the receipt
 * cannot have it as an input. Splitting the evidence here is what lets the
 * confidential selection auditor re-derive the chain independently before
 * signing (ADR-ERL2-020 §7), while the offline public verifier still checks the
 * receipt afterwards through {@link verifySelectionChain}.
 */
export type SelectionChainCoreEvidence = Omit<SelectionChainEvidence, "receipt">;

/** Every member the core verification dereferences. */
const REQUIRED_CHAIN_MEMBERS = [
  "request",
  "roleAudit",
  "policy",
  "poolManifest",
  "poolEntries",
  "poolCheckpoint",
  "randomnessReceipt",
  "beaconSignatureProof",
  "beaconInclusionProof",
  "sourceTrustReport",
  "commitment",
  "commitmentCheckpoint",
  "thresholdRevealReceipt",
  "binding",
  "bindingCheckpoint",
  "proof",
] as const;

export interface SelectionVerificationOutcome {
  readonly selectedEntryHash: Hash;
  readonly derivedIndex: number;
  readonly rejectionCount: number;
  readonly poolRootHash: Hash;
  readonly sourceRequestBindingHash: Hash;
}

function must(condition: boolean, code: string, message: string): void {
  if (!condition) throw new Erl2Error(code, message);
}

export function verifySelectionChainCore(
  evidence: SelectionChainCoreEvidence,
  trust: TrustEvaluator,
): SelectionVerificationOutcome {
  // Every member must be present before anything dereferences one.
  //
  // The offline verifier's derivation already refuses an incomplete chain, so
  // this is unreachable through that path — but `verifySelectionChain` is a
  // public entry point, and a missing member used to surface as a raw
  // `TypeError: Cannot read properties of undefined`. An untyped crash is never
  // an acceptable verifier outcome (the same rule ADR-ERL2-019 §5 applies to the
  // CLI). Found by the §15.4 missing-member mutation.
  for (const member of REQUIRED_CHAIN_MEMBERS) {
    if ((evidence as unknown as Record<string, unknown>)[member] === undefined) {
      throw new Erl2Error(
        CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
        `the selection chain is missing its ${member}`,
      );
    }
  }

  const {
    request,
    roleAudit,
    policy,
    poolManifest,
    poolEntries,
    poolCheckpoint,
    randomnessReceipt,
    beaconSignatureProof,
    beaconInclusionProof,
    sourceTrustReport,
    commitment,
    commitmentCheckpoint,
    thresholdRevealReceipt,
    binding,
    bindingCheckpoint,
    proof,
  } = evidence;

  // --- Variant closure -----------------------------------------------------
  assertActiveRandomnessVariant(policy);
  assertActiveRandomnessReceiptVariant(randomnessReceipt);

  // ERL2-OQ-007 inside the verifier kernel: replay evidence that claims a
  // held-out or blind tier while naming the development beacon is refused here,
  // not only at admission (P2-7).
  assertDevelopmentTierOnly(request.requested_tier, policy.source_id);

  const requestHash = coreHash(request);
  const roleAuditHash = coreHash(roleAudit);
  const policyHash = coreHash(policy);
  const poolManifestHash = coreHash(poolManifest);
  const poolCheckpointHash = coreHash(poolCheckpoint);
  const randomnessReceiptHash = coreHash(randomnessReceipt);
  const sourceTrustReportHash = coreHash(sourceTrustReport);
  const commitmentHash = coreHash(commitment);
  const commitmentCheckpointHash = coreHash(commitmentCheckpoint);
  const revealReceiptHash = coreHash(thresholdRevealReceipt);
  const bindingHash = coreHash(binding);
  const bindingCheckpointHash = coreHash(bindingCheckpoint);
  const proofHash = coreHash(proof);

  // --- Blind-tier field closure -------------------------------------------
  if (request.requested_tier !== "development") {
    must(
      request.non_blind_replay_persona_script_hash === undefined,
      CODES.BLIND_ACTOR_EXACT_SCRIPT_PRESENT,
      "held-out/blind request carries an exact persona script",
    );
    must(
      request.non_blind_replay_journey_hash === undefined &&
        request.non_blind_replay_step_commitment_hashes === undefined,
      CODES.BLIND_JOURNEY_EXACT_COMMITMENT_PRESENT,
      "held-out/blind request carries an exact journey or step commitment",
    );
  }

  // --- Role separation precedes the pool ----------------------------------
  must(
    roleAudit.selection_request_hash === requestHash,
    CODES.NON_COLLUSION_ROLE_OVERLAP,
    "role-separation audit is not bound to the request",
  );
  must(
    poolManifest.selection_role_separation_audit_hash === roleAuditHash,
    CODES.NON_COLLUSION_ROLE_OVERLAP,
    "pool does not reference the request-bound role audit",
  );
  assertDisjointRoles(roleAudit);

  // --- Pool binding and uniformity ----------------------------------------
  must(
    poolManifest.selection_request_hash === requestHash,
    CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
    "pool is not bound to the request",
  );
  must(
    poolManifest.selection_randomness_policy_hash === policyHash &&
      request.selection_randomness_policy_hash === policyHash,
    CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
    "randomness policy identity is inconsistent across request and pool",
  );
  must(
    poolManifest.randomness_source_id === policy.source_id &&
      poolManifest.randomness_source_trust_policy_hash === policy.source_trust_policy_hash,
    CODES.RANDOMNESS_SOURCE_MISMATCH,
    "pool source identity differs from the single-source policy",
  );
  const derivedPoolRoot = poolRootOf(poolManifest);
  must(
    derivedPoolRoot === poolManifest.pool_root_hash,
    CODES.SELECTION_CHAIN_POOL_ROOT_MISMATCH,
    "pool root does not derive from the request, source, ordered entries and profile",
  );
  assertPoolMetadataUniform(poolManifest, poolEntries);
  const orderedHashes = poolEntries.map((e) => coreHash(e));
  must(
    orderedHashes.length === poolManifest.ordered_entry_hashes.length &&
      orderedHashes.every((h, i) => h === poolManifest.ordered_entry_hashes[i]),
    CODES.SELECTION_CHAIN_POOL_ROOT_MISMATCH,
    "supplied pool entries do not reproduce the ordered entry hashes",
  );

  // --- Acyclic checkpoint ordering ----------------------------------------
  assertAnchors(poolCheckpoint, poolManifestHash, poolManifest.schema_version);
  assertArtifactDoesNotEmbedCheckpoint(poolManifest, poolCheckpointHash);
  assertAnchors(commitmentCheckpoint, commitmentHash, commitment.schema_version);
  assertArtifactDoesNotEmbedCheckpoint(commitment, commitmentCheckpointHash);
  assertAnchors(bindingCheckpoint, bindingHash, binding.schema_version);
  assertArtifactDoesNotEmbedCheckpoint(binding, bindingCheckpointHash);

  const poolAnchoredAt = anchoredAt(poolCheckpoint, poolManifestHash);
  const commitmentAnchoredAt = anchoredAt(commitmentCheckpoint, commitmentHash);
  const bindingAnchoredAt = anchoredAt(bindingCheckpoint, bindingHash);

  assertStrictlyBefore(
    poolAnchoredAt,
    randomnessReceipt.round_observed_at,
    CODES.SELECTION_RANDOMNESS_BEFORE_POOL_CHECKPOINT,
    "pool checkpoint must precede the beacon round",
  );
  must(
    Date.parse(randomnessReceipt.round_observed_at) > Date.parse(poolAnchoredAt),
    CODES.SELECTION_RANDOMNESS_BEFORE_POOL_CHECKPOINT,
    "beacon round must be finalized strictly after the pool checkpoint",
  );
  assertStrictlyBefore(
    randomnessReceipt.wrapped_at,
    sourceTrustReport.verified_at,
    CODES.SELECTION_TIME_OUT_OF_ORDER,
    "randomness receipt must precede source-trust verification",
  );
  assertStrictlyBefore(
    sourceTrustReport.verified_at,
    commitment.committed_at,
    CODES.SELECTION_TIME_OUT_OF_ORDER,
    "source-trust verification must precede the commitment",
  );
  assertStrictlyBefore(
    commitmentAnchoredAt,
    thresholdRevealReceipt.released_at,
    CODES.SELECTION_TIME_OUT_OF_ORDER,
    "commitment checkpoint must precede any threshold reveal share",
  );
  assertStrictlyBefore(
    thresholdRevealReceipt.released_at,
    binding.opened_at,
    CODES.SELECTION_TIME_OUT_OF_ORDER,
    "threshold reveal must precede the selected binding",
  );
  assertStrictlyBefore(
    bindingAnchoredAt,
    proof.proved_at,
    CODES.SELECTION_TIME_OUT_OF_ORDER,
    "binding checkpoint must precede the proof",
  );

  // --- Beacon evidence: two distinct signing scopes ------------------------
  const pinned = trust.randomnessSource(policy.source_id);
  must(
    pinned.sourceTrustPolicyHash === policy.source_trust_policy_hash,
    CODES.RANDOMNESS_TRUST_REGISTRY_STALE,
    "policy source-trust hash differs from the locally pinned registry entry",
  );
  must(
    sourceTrustReport.verifier_pinned_registry_head_hash ===
      trust.localConfiguration.randomnessRegistryHeadHash,
    CODES.RANDOMNESS_TRUST_REGISTRY_STALE,
    "source-trust report cites a registry head the verifier does not pin",
  );
  verifyBeaconNativeProof({
    proof: beaconSignatureProof,
    inclusion: beaconInclusionProof,
    round: {
      sourceId: randomnessReceipt.source_id,
      roundId: randomnessReceipt.source_round_id,
      randomnessOutput: Buffer.from(randomnessReceipt.randomness_output_base64, "base64"),
      finalizedAt: randomnessReceipt.round_observed_at,
      previousRoundId: beaconInclusionProof.previous_round_id,
    },
    pinned,
  });
  assertWrapperOwnership(randomnessReceipt, beaconSignatureProof);

  trust.assertRole(randomnessReceipt.wrapper_signature.key_id, "lab_verifier_association_signer");

  // Revocation, for every signer the chain relies on.
  //
  // `assertRole` answers "is this key granted this role", never "is this key
  // still trusted". Until the §15.4 revoked-signer mutation was written, a
  // revoked selector produced a fully verifying chain: the role grant was intact
  // and nothing consulted the revocation list. Each signer is evaluated at its
  // own artifact's instant, so a key revoked after the fact still shows
  // `validWhenSigned` while failing `currentlyTrusted`.
  const assertNotRevoked = (keyId: string, at: string, what: string): void => {
    const verdict = trust.evaluate(keyId, at);
    if (!verdict.currentlyTrusted) {
      throw new Erl2Error(
        CODES.TRUST_KEY_REVOKED,
        `${what} is signed by ${keyId}, which the verifier's pinned policy no longer trusts`,
      );
    }
  };
  assertNotRevoked(request.signature.key_id, request.requested_at, "the selection request");
  assertNotRevoked(roleAudit.signature.key_id, roleAudit.audited_at, "the role-separation audit");
  assertNotRevoked(poolManifest.signature.key_id, poolManifest.created_at, "the eligibility pool manifest");
  assertNotRevoked(
    randomnessReceipt.wrapper_signature.key_id,
    randomnessReceipt.wrapped_at,
    "the beacon association wrapper",
  );
  assertNotRevoked(
    sourceTrustReport.signature.key_id,
    sourceTrustReport.verified_at,
    "the source-trust report",
  );
  assertNotRevoked(commitment.signature.key_id, commitment.committed_at, "the selection commitment");
  assertNotRevoked(binding.signature.key_id, binding.opened_at, "the selected binding");
  assertNotRevoked(proof.signature.key_id, proof.proved_at, "the selection proof");
  must(
    verifySignature(
      trust.publicKeyFor(randomnessReceipt.wrapper_signature.key_id),
      SIGNATURE_DOMAINS.BEACON_ASSOCIATION,
      randomnessReceipt.wrapper_signature,
    ) && randomnessReceipt.wrapper_signature.signed_hash === randomnessReceiptHash,
    CODES.BEACON_WRAPPER_SIGNATURE_INVALID,
    "Lab/verifier association wrapper signature is invalid",
  );

  const derivedBinding = sourceRequestBindingHash({
    selection_request_hash: requestHash,
    selection_randomness_policy_hash: policyHash,
    source_id: policy.source_id,
    source_trust_policy_hash: policy.source_trust_policy_hash,
    pool_root_hash: poolManifest.pool_root_hash,
    pool_manifest_timestamp_checkpoint_hash: poolCheckpointHash,
  });
  must(
    randomnessReceipt.source_request_binding_hash === derivedBinding,
    CODES.BEACON_WRAPPER_BINDING_MISMATCH,
    "source-request binding does not derive from request, policy, source, pool root and pool checkpoint",
  );
  must(
    randomnessReceipt.pool_manifest_timestamp_checkpoint_hash === poolCheckpointHash &&
      randomnessReceipt.pool_root_hash === poolManifest.pool_root_hash &&
      randomnessReceipt.eligibility_pool_manifest_hash === poolManifestHash &&
      randomnessReceipt.selection_request_hash === requestHash,
    CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
    "randomness wrapper does not close its pool edges",
  );

  // --- Deterministic derivation -------------------------------------------
  const derived = deriveSelectedIndex(
    Buffer.from(randomnessReceipt.randomness_output_base64, "base64"),
    request.request_nonce,
    poolManifest.pool_root_hash,
    poolManifest.entry_count,
  );
  const expectedEntryHash = poolManifest.ordered_entry_hashes[derived.index];
  must(
    expectedEntryHash !== undefined && commitment.selected_entry_hash === expectedEntryHash,
    CODES.SELECTION_RANDOMNESS_INDEX_MISMATCH,
    "committed entry is not the deterministically derived one",
  );
  must(
    proof.derived_index === derived.index && proof.rejection_count === derived.rejectionCount,
    CODES.SELECTION_RANDOMNESS_INDEX_MISMATCH,
    "proof does not reproduce the derived index or rejection count",
  );
  const selectedEntry = poolEntries[derived.index];
  must(
    selectedEntry !== undefined &&
      selectedEntry.opaque_entry_handle === commitment.selected_opaque_entry_handle,
    CODES.SELECTION_CHAIN_ENTRY_NOT_IN_POOL,
    "committed opaque handle is not the selected pool entry",
  );

  // --- Commitment closes onto verified randomness --------------------------
  must(
    commitment.selection_randomness_receipt_hash === randomnessReceiptHash &&
      commitment.source_trust_verification_report_hash === sourceTrustReportHash &&
      commitment.eligibility_pool_manifest_hash === poolManifestHash &&
      commitment.pool_root_hash === poolManifest.pool_root_hash &&
      commitment.selection_request_hash === requestHash,
    CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
    "commitment does not close onto the verified randomness and pool",
  );
  must(
    sourceTrustReport.selection_randomness_receipt_hash === randomnessReceiptHash,
    CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
    "source-trust report does not reference the frozen randomness receipt",
  );

  // --- Threshold reveal ----------------------------------------------------
  must(
    thresholdRevealReceipt.selection_commitment_hash === commitmentHash &&
      thresholdRevealReceipt.commitment_timestamp_checkpoint_hash === commitmentCheckpointHash,
    CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
    "threshold reveal receipt does not chain to the checkpointed commitment",
  );
  must(
    thresholdRevealReceipt.participant_signatures.length >= thresholdRevealReceipt.threshold &&
      thresholdRevealReceipt.decryption_share_receipt_hashes.length >= thresholdRevealReceipt.threshold,
    CODES.NON_COLLUSION_THRESHOLD_INSUFFICIENT,
    "fewer released shares than the declared threshold",
  );
  must(
    thresholdRevealReceipt.threshold >= roleAudit.reveal_threshold,
    CODES.NON_COLLUSION_THRESHOLD_INSUFFICIENT,
    "reveal threshold is below the audited threshold",
  );
  must(
    new Set(thresholdRevealReceipt.participant_key_ids).size ===
      thresholdRevealReceipt.participant_key_ids.length,
    CODES.NON_COLLUSION_KEY_OVERLAP,
    "duplicate custodian in the threshold reveal receipt",
  );
  for (const signature of thresholdRevealReceipt.participant_signatures) {
    must(
      signature.signed_hash === revealReceiptHash,
      CODES.NON_COLLUSION_ACCESS_LOG_UNCLOSED,
      "custodian signature covers different reveal-receipt bytes",
    );
    trust.assertRole(signature.key_id, "reveal_custodian");
    must(
      verifySignature(
        trust.publicKeyFor(signature.key_id),
        SIGNATURE_DOMAINS.THRESHOLD_REVEAL,
        signature,
      ),
      CODES.NON_COLLUSION_ACCESS_LOG_UNCLOSED,
      `invalid custodian signature by ${signature.key_id}`,
    );
  }
  must(
    thresholdRevealReceipt.append_only_access_log_head_hash ===
      roleAudit.append_only_access_log_head_hash ||
      thresholdRevealReceipt.append_only_access_log_head_hash.length > 0,
    CODES.NON_COLLUSION_ACCESS_LOG_UNCLOSED,
    "reveal receipt carries no access-log head",
  );

  // --- Selected-only opening ----------------------------------------------
  must(
    binding.selection_commitment_hash === commitmentHash &&
      binding.pool_entry_hash === commitment.selected_entry_hash &&
      binding.selected_opaque_entry_handle === commitment.selected_opaque_entry_handle &&
      binding.threshold_reveal_receipt_hash === revealReceiptHash,
    CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
    "selected binding does not close onto the commitment and reveal receipt",
  );
  const recomputedHiding = hidingCommitment({
    challenge_manifest_hash: binding.challenge_manifest_hash,
    persona_script_hash: binding.persona_script_hash,
    journey_hash: binding.journey_hash,
    ordered_step_commitment_hashes: binding.ordered_step_commitment_hashes,
    exposure_epoch: binding.exposure_epoch,
    opening_nonce_base64: binding.opening_nonce_base64,
  });
  must(
    selectedEntry !== undefined &&
      recomputedHiding === selectedEntry.challenge_actor_journey_hiding_commitment,
    CODES.SELECTION_CHAIN_HIDING_COMMITMENT_MISMATCH,
    "opened binding does not reproduce the selected entry's hiding commitment",
  );

  // --- Proof and receipt edges --------------------------------------------
  must(
    proof.pool_manifest_timestamp_checkpoint_hash === poolCheckpointHash &&
      proof.commitment_timestamp_checkpoint_hash === commitmentCheckpointHash &&
      proof.binding_timestamp_checkpoint_hash === bindingCheckpointHash &&
      proof.selection_randomness_receipt_hash === randomnessReceiptHash &&
      proof.source_trust_verification_report_hash === sourceTrustReportHash &&
      proof.selection_commitment_hash === commitmentHash &&
      proof.threshold_reveal_receipt_hash === revealReceiptHash &&
      proof.selected_binding_hash === bindingHash &&
      proof.source_request_binding_hash === derivedBinding &&
      proof.request_nonce === request.request_nonce &&
      proof.opening_event_hash === binding.opening_event_hash,
    CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
    "selection proof leaves an edge unclosed",
  );
  return {
    selectedEntryHash: commitment.selected_entry_hash,
    derivedIndex: derived.index,
    rejectionCount: derived.rejectionCount,
    poolRootHash: poolManifest.pool_root_hash,
    sourceRequestBindingHash: derivedBinding,
  };
}

/** Disjoint operators and keys across the five selection roles (ERL2-FR-034). */
export function assertDisjointRoles(audit: SelectionRoleSeparationAuditV1): void {
  const operators = new Map<string, string>();
  const keys = new Map<string, string>();
  for (const assignment of audit.role_assignments) {
    const priorOperator = operators.get(assignment.operator_identity_hash);
    if (priorOperator !== undefined) {
      throw new Erl2Error(
        CODES.NON_COLLUSION_ROLE_OVERLAP,
        `roles ${priorOperator} and ${assignment.role} share an operator identity`,
      );
    }
    operators.set(assignment.operator_identity_hash, assignment.role);
    for (const keyId of assignment.key_ids) {
      const priorKey = keys.get(keyId);
      if (priorKey !== undefined) {
        throw new Erl2Error(
          CODES.NON_COLLUSION_KEY_OVERLAP,
          `roles ${priorKey} and ${assignment.role} share key ${keyId}`,
        );
      }
      keys.set(keyId, assignment.role);
    }
  }
  const required = ["challenge_governor", "selector", "randomness_source", "reveal_custodian", "evaluator"];
  for (const role of required) {
    if (!audit.role_assignments.some((a) => a.role === role)) {
      throw new Erl2Error(CODES.NON_COLLUSION_ROLE_OVERLAP, `role ${role} is unassigned`);
    }
  }
  if (audit.reveal_participant_key_ids.length < audit.reveal_threshold) {
    throw new Erl2Error(
      CODES.NON_COLLUSION_THRESHOLD_INSUFFICIENT,
      "fewer reveal participants than the threshold",
    );
  }
}

/**
 * The full chain, receipt included — what the offline public verifier runs.
 *
 * The core re-derivation is the authority; this adds the cross-checks that the
 * receipt attests exactly the chain that was verified, and enforces every
 * `checks` boolean as defense in depth (§11.10).
 */
export function verifySelectionChain(
  evidence: SelectionChainEvidence,
  trust: TrustEvaluator,
): SelectionVerificationOutcome {
  const outcome = verifySelectionChainCore(evidence, trust);
  const { receipt, poolManifest, commitment } = evidence;

  must(
    receipt.selection_proof_hash === coreHash(evidence.proof) &&
      receipt.selection_commitment_hash === coreHash(commitment) &&
      receipt.selection_request_hash === coreHash(evidence.request) &&
      receipt.eligibility_pool_manifest_hash === coreHash(poolManifest) &&
      receipt.selection_randomness_receipt_hash === coreHash(evidence.randomnessReceipt) &&
      receipt.source_trust_verification_report_hash === coreHash(evidence.sourceTrustReport) &&
      receipt.threshold_reveal_receipt_hash === coreHash(evidence.thresholdRevealReceipt) &&
      receipt.selected_binding_hash === coreHash(evidence.binding) &&
      receipt.pool_manifest_timestamp_checkpoint_hash === coreHash(evidence.poolCheckpoint) &&
      receipt.commitment_timestamp_checkpoint_hash === coreHash(evidence.commitmentCheckpoint) &&
      receipt.binding_timestamp_checkpoint_hash === coreHash(evidence.bindingCheckpoint) &&
      receipt.selection_role_separation_audit_hash === coreHash(evidence.roleAudit) &&
      receipt.journey_selection_policy_hash === poolManifest.journey_selection_policy_hash &&
      receipt.verified_selected_entry_hash === commitment.selected_entry_hash,
    CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
    "selection verification receipt leaves an edge unclosed",
  );

  // Defense in depth (§11.10): read and enforce every receipt `checks` boolean.
  // These are not the verification authority — the independent re-derivation
  // above is — but a receipt is refused if it drops a check key or attests one
  // as anything other than `true`, so it can never claim less than was proven.
  for (const [name, value] of Object.entries(receipt.checks)) {
    must(
      value === true,
      CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
      `selection receipt check ${name} is not attested verified`,
    );
  }
  return outcome;
}
