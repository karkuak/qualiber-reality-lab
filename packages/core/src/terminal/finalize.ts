/**
 * Terminal run records, final attestation and the public bundle (design v2
 * §12/§14/§16.2, implementation plan §12.1 S6.9).
 *
 * Finalization runs in exactly the order the design fixes, and each step is a
 * *refusal point*, not a formality:
 *
 * 1. verify the terminal run-record variant;
 * 2. independently derive the mandatory graph closure;
 * 3. verify the applicable cleanup and that residue is zero or explicitly
 *    contained;
 * 4. verify exposure state;
 * 5. verify the signer inventory;
 * 6. verify trust at creation under the V2 trust contracts;
 * 7. verify acyclic timestamp checkpoints;
 * 8. freeze the final attestation;
 * 9. freeze the matching `PublicVerificationBundleV2` variant;
 * 10. verify that bundle offline in a fresh process.
 *
 * Steps 1–7 all happen *before* the finalizer signs anything, which is why a
 * signature can never precede cleanup, exposure, trust or graph closure.  Step
 * 10 lives in the CLI and `tests/e2e`, because it must run in another process.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type ArtifactRef,
  type BundleMember,
  type ClaimScope,
  type GenericEvaluationIndexV1,
  type Hash,
  type Instant,
  type PreEnvironmentCleanupVerificationV1,
  type PreEnvironmentFinalLabAttestationV1,
  type PreEnvironmentLabRunRecordV1,
  type PreEnvironmentPublicVerificationBundleV2,
  type PreEnvironmentSignerInventoryV2,
  type ValidityResultV1,
} from "@erl2/contracts";
import { coreHash, sealSigned, type SigningKey } from "@erl2/integrity";
import { assertNoDeepAncestry } from "../evaluation/join.js";
import { assertValidityAdmitsGenericIndex } from "../evaluation/validity.js";

// -- 1. the pre-environment terminal run record ------------------------------

export interface PreEnvironmentRunRecordInput {
  readonly runId: string;
  readonly terminalStage: "acquire" | "verify_package";
  readonly acquisitionPreregistrationHash: Hash;
  readonly acquisitionSourceManifestHash: Hash;
  readonly acquisitionRecordHash: Hash;
  readonly packageVerificationRecordHash?: Hash;
  readonly adapterHash: Hash;
  readonly genericRunPolicyHash: Hash;
  readonly subjectOutputHash: Hash;
  readonly journeyResultHash: Hash;
  readonly domainNotApplicableResultHash: Hash;
  readonly precleanupResultJoinHash: Hash;
  readonly preEnvironmentCleanupHash: Hash;
  readonly validityResultHash: Hash;
  readonly genericEvaluationIndexHash: Hash;
  readonly lifecycleHeadHash: Hash;
}

/**
 * Freezes the valid pre-environment run record.
 *
 * There is deliberately no `subject_package_manifest_hash` member: a successful
 * package verification continues to challenge preregistration, so this variant
 * can never close over one (ADR-ERL2-013).  An `acquire` terminal additionally
 * cannot carry a package-verification record.
 */
export function buildPreEnvironmentRunRecord(
  input: PreEnvironmentRunRecordInput,
): PreEnvironmentLabRunRecordV1 {
  if (input.terminalStage === "acquire" && input.packageVerificationRecordHash !== undefined) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      "an acquire terminal cannot close over a package-verification record",
    );
  }
  if (input.terminalStage === "verify_package" && input.packageVerificationRecordHash === undefined) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_MISSING_ROLE,
      "a verify_package terminal must close over its package-verification record",
    );
  }
  const body = {
    schema_version: "pre-environment-lab-run-record/v1" as const,
    run_id: input.runId,
    terminal_stage: input.terminalStage,
    acquisition_preregistration_hash: input.acquisitionPreregistrationHash,
    acquisition_source_manifest_hash: input.acquisitionSourceManifestHash,
    acquisition_record_hash: input.acquisitionRecordHash,
    ...(input.packageVerificationRecordHash === undefined
      ? {}
      : { package_verification_record_hash: input.packageVerificationRecordHash }),
    adapter_hash: input.adapterHash,
    generic_run_policy_hash: input.genericRunPolicyHash,
    subject_output_hash: input.subjectOutputHash,
    journey_result_hash: input.journeyResultHash,
    domain_not_applicable_result_hash: input.domainNotApplicableResultHash,
    precleanup_result_join_hash: input.precleanupResultJoinHash,
    pre_environment_cleanup_hash: input.preEnvironmentCleanupHash,
    validity_result_hash: input.validityResultHash,
    generic_evaluation_index_hash: input.genericEvaluationIndexHash,
    lifecycle_head_hash: input.lifecycleHeadHash,
  };
  const record = assertContract<PreEnvironmentLabRunRecordV1>("PreEnvironmentLabRunRecordV1", {
    ...body,
    core_hash: coreHash(body),
  });
  assertNoDeepAncestry(record, "pre-environment run record");
  return record;
}

// -- 2. the signer inventory -------------------------------------------------

export interface SignerInventoryEntryInput {
  readonly artifactSchemaVersion: string;
  readonly artifactCoreHash: Hash;
  readonly signerKeyId: string;
  readonly signatureSha256: Hash;
  readonly securityTimestamp: Instant;
  readonly timestampLogId: string;
  readonly timestampSequence: number;
}

/**
 * Recomputes the pre-environment signer inventory.
 *
 * The public terminal attestation type is *excluded* from its own inventory:
 * the inventory attests the chain the attestation covers, so including the
 * attestation would let it vouch for itself (design v2 §14).
 */
export function buildPreEnvironmentSignerInventory(input: {
  readonly inventoryId: string;
  readonly runId: string;
  readonly acquisitionPreregistrationHash: Hash;
  readonly entries: readonly SignerInventoryEntryInput[];
  readonly inventoriedAt: Instant;
  readonly signingKey: SigningKey;
}): PreEnvironmentSignerInventoryV2 {
  const excluded = "pre-environment-final-lab-attestation/v1";
  for (const entry of input.entries) {
    if (entry.artifactSchemaVersion === excluded) {
      throw new Erl2Error(
        CODES.INVENTORY_ENTRY_EXTRA,
        "the signer inventory cannot include the public terminal attestation it supports",
      );
    }
  }
  const body = {
    schema_version: "signer-inventory/v2" as const,
    terminal_variant: "pre_environment" as const,
    inventory_id: input.inventoryId,
    run_id: input.runId,
    acquisition_preregistration_hash: input.acquisitionPreregistrationHash,
    entries: input.entries.map((e) => ({
      artifact_schema_version: e.artifactSchemaVersion,
      artifact_core_hash: e.artifactCoreHash,
      signer_key_id: e.signerKeyId,
      signature_sha256: e.signatureSha256,
      security_timestamp: e.securityTimestamp,
      timestamp_log_id: e.timestampLogId,
      timestamp_sequence: e.timestampSequence,
    })),
    excluded_public_terminal_types: [excluded],
    complete_for_terminal_chain: true as const,
    inventoried_at: input.inventoriedAt,
  };
  return assertContract<PreEnvironmentSignerInventoryV2>(
    "PreEnvironmentSignerInventoryV2",
    sealSigned(body, input.signingKey),
  );
}

// -- 3. the ordered finalization gate ----------------------------------------

export interface FinalizationPreconditions {
  readonly validity: ValidityResultV1;
  readonly genericEvaluationIndex: GenericEvaluationIndexV1;
  readonly cleanup: PreEnvironmentCleanupVerificationV1;
  /** Independently derived closure verdict; a producer array is never trusted. */
  readonly derivedClosureVerdict: "valid" | "invalid";
  /** Roles the derived closure could not find. */
  readonly derivedMissingRoles: readonly string[];
  /** Retained artifacts the derived closure did not require. */
  readonly derivedExtraHashes: readonly Hash[];
  /** Exposure state must be recorded before an attestation may be signed. */
  readonly exposureStateRecorded: boolean;
  readonly signerInventoryHash: Hash;
  readonly trustPolicyHash: Hash;
  readonly timestampCheckpointHash: Hash;
  readonly trustVerifiedAtCreation: boolean;
  readonly timestampCheckpointsAcyclic: boolean;
}

/**
 * Refuses every defect design v2 requires the finalizer to refuse, *before* any
 * signature exists.
 */
export function assertFinalizable(pre: FinalizationPreconditions): void {
  // 1. only a valid run may finalize.
  assertValidityAdmitsGenericIndex(pre.validity);
  if (pre.genericEvaluationIndex.validity_result_hash !== pre.validity.core_hash) {
    throw new Erl2Error(
      CODES.EVALUATOR_STALE_RESULT_HASH,
      "the generic evaluation index does not bind the validity result being finalized",
    );
  }
  // 2. the independently derived graph must be complete.
  if (pre.derivedMissingRoles.length > 0) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_MISSING_ROLE,
      `finalization refused: derived closure is missing ${pre.derivedMissingRoles.join(", ")}`,
    );
  }
  if (pre.derivedExtraHashes.length > 0) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      `finalization refused: ${String(pre.derivedExtraHashes.length)} retained artifact(s) are not accounted for by the run record`,
    );
  }
  if (pre.derivedClosureVerdict !== "valid") {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "finalization refused: the independently derived mandatory closure is invalid",
    );
  }
  // 3. cleanup must have passed with zero or explicitly contained residue.
  if (!pre.cleanup.passed) {
    throw new Erl2Error(
      CODES.BUNDLE_FINALIZED_BEFORE_CLEANUP,
      "finalization refused: cleanup did not pass; a cleanup failure routes to the invalid terminal",
    );
  }
  if (
    pre.cleanup.residual_acquisition_resources.length > 0 &&
    pre.cleanup.acquired_artifact_disposition !== "retained_quarantined"
  ) {
    throw new Erl2Error(
      CODES.RESIDUE_DETECTED,
      "finalization refused: residual acquisition resources are neither zero nor explicitly quarantined",
    );
  }
  // 4. exposure state.
  if (!pre.exposureStateRecorded) {
    throw new Erl2Error(
      CODES.BUNDLE_FINALIZED_BEFORE_EXPOSURE,
      "finalization refused: exposure state was not recorded",
    );
  }
  // 5-7. trust, signer inventory and timestamps.
  if (!pre.trustVerifiedAtCreation) {
    throw new Erl2Error(
      CODES.BUNDLE_FINALIZED_BEFORE_TRUST_CLOSURE,
      "finalization refused: trust at creation was not verified under the V2 trust contracts",
    );
  }
  if (!pre.timestampCheckpointsAcyclic) {
    throw new Erl2Error(
      CODES.TIMESTAMP_SELF_REFERENCE,
      "finalization refused: the timestamp checkpoint chain is not acyclic",
    );
  }
}

// -- 4. the final attestation ------------------------------------------------

export interface PreEnvironmentAttestationInput {
  readonly attestationId: string;
  readonly runId: string;
  readonly runRecordHash: Hash;
  readonly acquisitionPreregistrationVerificationReceiptHash: Hash;
  readonly signerInventoryHash: Hash;
  readonly timestampCheckpointHash: Hash;
  readonly runTrustPolicyHash: Hash;
  readonly acquisitionSourceManifestHash: Hash;
  readonly acquisitionRecordHash: Hash;
  readonly adapterHash: Hash;
  readonly genericRunPolicyHash: Hash;
  readonly genericEvaluationIndexHash: Hash;
  readonly preEnvironmentCleanupHash: Hash;
  readonly claimScope: ClaimScope;
  readonly finalizedAt: Instant;
  readonly signingKey: SigningKey;
}

/**
 * Signs the pre-environment final attestation.
 *
 * `lab_validity` is a schema constant `"valid"`, so an attestation for an
 * invalid run cannot be represented at all, and `claim_scope` is limited to
 * T1–T3: a base attestation never emits T4, which requires genuine customer
 * outcome evidence (design v2 §25).
 */
export function buildPreEnvironmentAttestation(
  input: PreEnvironmentAttestationInput,
): PreEnvironmentFinalLabAttestationV1 {
  const body = {
    schema_version: "pre-environment-final-lab-attestation/v1" as const,
    attestation_id: input.attestationId,
    run_id: input.runId,
    terminal_variant: "pre_environment" as const,
    run_record_hash: input.runRecordHash,
    acquisition_preregistration_verification_receipt_hash:
      input.acquisitionPreregistrationVerificationReceiptHash,
    signer_inventory_hash: input.signerInventoryHash,
    timestamp_checkpoint_hash: input.timestampCheckpointHash,
    run_trust_policy_hash: input.runTrustPolicyHash,
    acquisition_source_manifest_hash: input.acquisitionSourceManifestHash,
    acquisition_record_hash: input.acquisitionRecordHash,
    adapter_hash: input.adapterHash,
    generic_run_policy_hash: input.genericRunPolicyHash,
    generic_evaluation_index_hash: input.genericEvaluationIndexHash,
    cleanup: { kind: "pre_environment" as const, verification_hash: input.preEnvironmentCleanupHash },
    lab_validity: "valid" as const,
    claim_scope: input.claimScope,
    finalized_at: input.finalizedAt,
  };
  const attestation = assertContract<PreEnvironmentFinalLabAttestationV1>(
    "PreEnvironmentFinalLabAttestationV1",
    sealSigned(body, input.signingKey),
  );
  assertNoDeepAncestry(attestation, "pre-environment final attestation");
  return attestation;
}

// -- 5. the public bundle ----------------------------------------------------

export interface PreEnvironmentBundleInput {
  readonly bundleId: string;
  readonly runId: string;
  readonly finalAttestation: { readonly artifact: ArtifactRef; readonly coreHash: Hash };
  readonly acquisitionPreregistrationVerificationReceipt: {
    readonly artifact: ArtifactRef;
    readonly coreHash: Hash;
  };
  readonly signerInventory: { readonly artifact: ArtifactRef; readonly coreHash: Hash };
  readonly runTrustPolicy: { readonly artifact: ArtifactRef; readonly coreHash: Hash };
  readonly timestampCheckpointChain: readonly { readonly artifact: ArtifactRef; readonly coreHash: Hash }[];
  readonly createdAt: Instant;
}

function member(input: { readonly artifact: ArtifactRef; readonly coreHash: Hash }): BundleMember {
  return { artifact: input.artifact, artifact_core_hash: input.coreHash };
}

/**
 * Freezes the pre-environment public bundle.
 *
 * `execution_artifacts` is a schema-fixed empty array and
 * `execution_verification_mode` is fixed to `finalizer_verdict_only`: a public
 * bundle carries the finalizer's verdict and the evidence needed to check it,
 * never an execution body a reader could be asked to re-run.
 */
export function buildPreEnvironmentBundle(
  input: PreEnvironmentBundleInput,
): PreEnvironmentPublicVerificationBundleV2 {
  if (input.timestampCheckpointChain.length === 0) {
    throw new Erl2Error(
      CODES.BUNDLE_MEMBER_MISSING,
      "a public bundle requires at least one timestamp checkpoint",
    );
  }
  const [first, ...rest] = input.timestampCheckpointChain;
  const body = {
    schema_version: "public-verification-bundle/v2" as const,
    terminal_variant: "pre_environment" as const,
    bundle_id: input.bundleId,
    run_id: input.runId,
    final_attestation: member(input.finalAttestation),
    acquisition_preregistration_verification_receipt: member(
      input.acquisitionPreregistrationVerificationReceipt,
    ),
    signer_inventory: member(input.signerInventory),
    run_trust_policy: member(input.runTrustPolicy),
    acquisition_timestamp_checkpoint_chain: [
      member(first as { artifact: ArtifactRef; coreHash: Hash }),
      ...rest.map(member),
    ] as [BundleMember, ...BundleMember[]],
    verification_trust_head_source: "local_root_pinned_configuration" as const,
    execution_verification_mode: "finalizer_verdict_only" as const,
    execution_artifacts: [] as [],
    created_at: input.createdAt,
  };
  const bundle = assertContract<PreEnvironmentPublicVerificationBundleV2>(
    "PreEnvironmentPublicVerificationBundleV2",
    { ...body, core_hash: coreHash(body) },
  );
  assertNoDeepAncestry(bundle, "pre-environment public bundle");
  return bundle;
}

/**
 * Refuses a V1/V2 member crossover.
 *
 * V2 readers accept only `PublicVerificationBundleV2` members; a retained V1
 * artifact stays readable through the separate V1 verifier and the optional
 * legacy wrapper, and is never silently promoted (design v2 §26).
 */
export function assertNoVersionCrossover(members: readonly { readonly schema_version: string }[]): void {
  const v1Terminals = [
    "public-verification-bundle/v1",
    "product-safe-signer-inventory/v1",
    "trust-policy-manifest/v1",
    "trust-verification-report/v1",
    "run-lifecycle-event/v1",
    "observation-bundle/v1",
  ];
  for (const m of members) {
    if (v1Terminals.includes(m.schema_version)) {
      throw new Erl2Error(
        CODES.VERSION_CLOSURE_MEMBER_CROSSOVER,
        `a V2 bundle cannot carry the retained V1 member ${m.schema_version}`,
      );
    }
  }
}
