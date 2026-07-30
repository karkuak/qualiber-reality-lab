/**
 * The **environment** terminal: run record, signer inventory, ordered
 * finalization gate, final attestation and public bundle (design v2 §12/§14/
 * §16.2, ADR-ERL2-013 for the branch split).
 *
 * This is the environment counterpart of `finalize.ts`.  It is deliberately a
 * separate module rather than a set of variant flags on the pre-environment
 * builders, because the two branches close over *disjoint* member sets and the
 * design forbids either from carrying the other's members:
 *
 *   - the pre-environment branch has no selection, environment, observation,
 *     restoration, teardown or exposure member (design v2 §16.3);
 *   - the environment branch **requires** a subject package manifest, a
 *     verified selection receipt, an environment instance, an execution plan,
 *     restoration and teardown, and an exposure event.
 *
 * The ordering guarantee is the same one `assertFinalizable` enforces for the
 * pre-environment branch, extended with the cleanup pair the environment branch
 * owns: nothing here is signed until restoration passed, teardown passed,
 * residue is zero, validity is `valid`, the independently derived closure is
 * complete, exposure is recorded and trust resolves.  Steps that a producer
 * could otherwise assert are *derived* instead — the closure verdict comes from
 * the verifier's own algorithm, and `passed` on both cleanup artifacts is
 * computed by `@erl2/core`'s cleanup builders from evidence, never supplied.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type ArtifactRef,
  type BundleMember,
  type ClaimScope,
  type EnvironmentFinalLabAttestationV1,
  type EnvironmentJourneyIntent,
  type EnvironmentLabRunRecordV1,
  type EnvironmentPublicVerificationBundleV2,
  type EnvironmentRestorationVerificationV1,
  type EnvironmentSignerInventoryV2,
  type GenericEvaluationIndexV1,
  type Hash,
  type Instant,
  type SelectionAssuranceV1,
  type TeardownVerificationV1,
  type ValidityResultV1,
} from "@erl2/contracts";
import { coreHash, sealSigned, type SigningKey } from "@erl2/integrity";
import { assertNoDeepAncestry } from "../evaluation/join.js";
import { assertValidityAdmitsGenericIndex } from "../evaluation/validity.js";
import type { SignerInventoryEntryInput } from "./finalize.js";

// -- 1. the environment terminal run record ----------------------------------

export interface EnvironmentRunRecordInput {
  readonly runId: string;
  readonly terminalStage: EnvironmentJourneyIntent;
  readonly acquisitionPreregistrationHash: Hash;
  readonly acquisitionSourceManifestHash: Hash;
  readonly acquisitionRecordHash: Hash;
  readonly subjectPackageManifestHash: Hash;
  readonly selectionRequestHash: Hash;
  readonly selectionReceiptHash: Hash;
  readonly selectedChallengeJourneyBindingHash: Hash;
  readonly adapterHash: Hash;
  readonly genericRunPolicyHash: Hash;
  readonly planHash: Hash;
  readonly environmentInstanceHash: Hash;
  readonly observationHash?: Hash;
  readonly canonicalEvidenceEnvelopeHash?: Hash;
  readonly adapterTranslationReceiptHash?: Hash;
  readonly subjectOutputHash: Hash;
  readonly journeyResultHash: Hash;
  readonly domainResultHash: Hash;
  readonly precleanupResultJoinHash: Hash;
  readonly genericEvaluationIndexHash: Hash;
  readonly environmentRestorationHash: Hash;
  readonly teardownHash: Hash;
  readonly lifecycleHeadHash: Hash;
}

/**
 * Freezes the valid environment run record.
 *
 * The observation, envelope and translation members are optional in the schema
 * because a journey may terminate on an intent that never reached capture — but
 * they are *conditionally* mandatory: if any one of the three is supplied all
 * three must be, since a translation receipt without the envelope it translated
 * would be an unciteable ancestor.  Refusing the partial combination here means
 * the verifier never has to guess which of the three the producer forgot.
 */
export function buildEnvironmentRunRecord(
  input: EnvironmentRunRecordInput,
): EnvironmentLabRunRecordV1 {
  const capture = [
    input.observationHash,
    input.canonicalEvidenceEnvelopeHash,
    input.adapterTranslationReceiptHash,
  ];
  const supplied = capture.filter((h) => h !== undefined).length;
  if (supplied !== 0 && supplied !== capture.length) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_MISSING_ROLE,
      "an environment run record carries the observation, canonical envelope and translation receipt together or not at all",
    );
  }
  const body = {
    schema_version: "environment-lab-run-record/v1" as const,
    run_id: input.runId,
    terminal_stage: input.terminalStage,
    acquisition_preregistration_hash: input.acquisitionPreregistrationHash,
    acquisition_source_manifest_hash: input.acquisitionSourceManifestHash,
    acquisition_record_hash: input.acquisitionRecordHash,
    subject_package_manifest_hash: input.subjectPackageManifestHash,
    selection_request_hash: input.selectionRequestHash,
    selection_receipt_hash: input.selectionReceiptHash,
    selected_challenge_journey_binding_hash: input.selectedChallengeJourneyBindingHash,
    adapter_hash: input.adapterHash,
    generic_run_policy_hash: input.genericRunPolicyHash,
    plan_hash: input.planHash,
    environment_instance_hash: input.environmentInstanceHash,
    ...(input.observationHash === undefined ? {} : { observation_hash: input.observationHash }),
    ...(input.canonicalEvidenceEnvelopeHash === undefined
      ? {}
      : { canonical_evidence_envelope_hash: input.canonicalEvidenceEnvelopeHash }),
    ...(input.adapterTranslationReceiptHash === undefined
      ? {}
      : { adapter_translation_receipt_hash: input.adapterTranslationReceiptHash }),
    subject_output_hash: input.subjectOutputHash,
    journey_result_hash: input.journeyResultHash,
    domain_result_hash: input.domainResultHash,
    precleanup_result_join_hash: input.precleanupResultJoinHash,
    generic_evaluation_index_hash: input.genericEvaluationIndexHash,
    environment_restoration_hash: input.environmentRestorationHash,
    teardown_hash: input.teardownHash,
    lifecycle_head_hash: input.lifecycleHeadHash,
  };
  const record = assertContract<EnvironmentLabRunRecordV1>("EnvironmentLabRunRecordV1", {
    ...body,
    core_hash: coreHash(body),
  });
  assertNoDeepAncestry(record, "environment run record");
  return record;
}

// -- 2. the environment signer inventory -------------------------------------

/**
 * Recomputes the environment signer inventory.
 *
 * Two public terminal types are excluded, and the schema fixes both their
 * identity and their order: the selection verification receipt and the
 * environment final attestation.  Both travel in the public bundle, so an
 * inventory that also covered them would be vouching for artifacts a reader
 * already holds independently — the same self-vouching defect the
 * pre-environment inventory avoids for its single excluded type.
 */
export function buildEnvironmentSignerInventory(input: {
  readonly inventoryId: string;
  readonly runId: string;
  readonly selectionCommitmentHash: Hash;
  readonly entries: readonly SignerInventoryEntryInput[];
  readonly completeForTerminalChain: boolean;
  readonly inventoriedAt: Instant;
  readonly signingKey: SigningKey;
}): EnvironmentSignerInventoryV2 {
  const excluded = [
    "selection-verification-receipt/v2",
    "environment-final-lab-attestation/v1",
  ] as const;
  for (const entry of input.entries) {
    if ((excluded as readonly string[]).includes(entry.artifactSchemaVersion)) {
      throw new Erl2Error(
        CODES.INVENTORY_ENTRY_EXTRA,
        `the signer inventory cannot include the public terminal type ${entry.artifactSchemaVersion} it supports`,
      );
    }
  }
  if (input.entries.length === 0) {
    throw new Erl2Error(
      CODES.INVENTORY_ENTRY_MISSING,
      "an environment signer inventory covers at least one signed artifact",
    );
  }
  // ADR-ERL2-030 §4.3, shared with the pre-environment builder: the schema pins
  // `complete_for_terminal_chain` to `true`, so a producer that cannot prove
  // completeness must refuse to seal rather than emit a weaker claim.
  if (!input.completeForTerminalChain) {
    throw new Erl2Error(
      CODES.INVENTORY_ENTRY_MISSING,
      `finalization refused: the signer inventory derivation covers ${String(input.entries.length)} ` +
        `member(s) and could not establish that they are every applicable signed member of the ` +
        `environment terminal chain`,
    );
  }
  const body = {
    schema_version: "signer-inventory/v2" as const,
    terminal_variant: "environment" as const,
    inventory_id: input.inventoryId,
    run_id: input.runId,
    selection_commitment_hash: input.selectionCommitmentHash,
    entries: input.entries.map((e) => ({
      artifact_schema_version: e.artifactSchemaVersion,
      artifact_core_hash: e.artifactCoreHash,
      signer_key_id: e.signerKeyId,
      signature_sha256: e.signatureSha256,
      security_timestamp: e.securityTimestamp,
      timestamp_log_id: e.timestampLogId,
      timestamp_sequence: e.timestampSequence,
    })),
    excluded_public_terminal_types: [...excluded] as [string, string],
    complete_for_terminal_chain: true as const,
    inventoried_at: input.inventoriedAt,
  };
  return assertContract<EnvironmentSignerInventoryV2>(
    "EnvironmentSignerInventoryV2",
    sealSigned(body, input.signingKey),
  );
}

// -- 3. the ordered environment finalization gate ----------------------------

export interface EnvironmentFinalizationPreconditions {
  readonly validity: ValidityResultV1;
  readonly genericEvaluationIndex: GenericEvaluationIndexV1;
  readonly restoration: EnvironmentRestorationVerificationV1;
  readonly teardown: TeardownVerificationV1;
  /** Resources still present after teardown; a valid terminal requires zero. */
  readonly residueAfterTeardown: readonly { readonly identity_hash: Hash }[];
  /** Independently derived closure verdict; a producer array is never trusted. */
  readonly derivedClosureVerdict: "valid" | "invalid";
  readonly derivedMissingRoles: readonly string[];
  readonly derivedExtraHashes: readonly Hash[];
  /** An environment terminal selected a challenge, so exposure is a real event. */
  readonly exposureEventHash: Hash | undefined;
  /**
   * Independently derived by the producer from the retained evidence
   * (ADR-ERL2-030 §4); computed, never asserted.
   */
  readonly signerInventoryComplete: boolean;
  readonly trustVerifiedAtCreation: boolean;
  readonly timestampCheckpointsAcyclic: boolean;
}

/**
 * Refuses every defect the design requires the environment finalizer to refuse,
 * **before** any signature exists.
 *
 * The order matters and is the design's: validity, closure, restoration,
 * teardown, residue, exposure, trust, timestamps.  Each is a hard stop; none of
 * them reads a producer's assertion that the check passed.
 */
export function assertEnvironmentFinalizable(
  pre: EnvironmentFinalizationPreconditions,
): void {
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

  // 3. restoration. A failure here has exactly one authorized route, and it is
  //    not this one: `lab_cleanup_started -> emergency_cleanup_started`.
  if (!pre.restoration.passed) {
    throw new Erl2Error(
      CODES.RESTORATION_FAILED,
      "finalization refused: environment restoration did not pass; a restoration failure enters receipt-backed emergency cleanup and freezes an invalid record",
    );
  }
  if (pre.restoration.residual_resources.length > 0) {
    throw new Erl2Error(
      CODES.RESIDUE_DETECTED,
      `finalization refused: restoration left ${String(pre.restoration.residual_resources.length)} residual resource(s)`,
    );
  }

  // 4. teardown, which may only be evaluated against the restoration above.
  if (pre.teardown.restoration_verification_hash !== pre.restoration.core_hash) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "finalization refused: the teardown verification does not follow the restoration being finalized",
    );
  }
  if (!pre.teardown.passed) {
    throw new Erl2Error(
      CODES.TEARDOWN_FAILED,
      "finalization refused: teardown did not pass; a teardown failure enters receipt-backed emergency cleanup and freezes an invalid record",
    );
  }

  // 5. residue observed *after* teardown, independently of what teardown said.
  if (pre.residueAfterTeardown.length > 0) {
    throw new Erl2Error(
      CODES.RESIDUE_DETECTED,
      `finalization refused: ${String(pre.residueAfterTeardown.length)} resource(s) remain after teardown`,
    );
  }

  // 6. exposure. Unlike the pre-environment branch, an environment run really
  //    did select and open a challenge, so the honest state is a recorded
  //    event rather than an absence.
  if (pre.exposureEventHash === undefined) {
    throw new Erl2Error(
      CODES.BUNDLE_FINALIZED_BEFORE_EXPOSURE,
      "finalization refused: an environment terminal opened a selected challenge, so an exposure event must be recorded",
    );
  }

  // 7. the signer inventory, on the branch where the omission was largest:
  //    66 retained signed members, 61 listed, completeness asserted.
  if (!pre.signerInventoryComplete) {
    throw new Erl2Error(
      CODES.INVENTORY_ENTRY_MISSING,
      "finalization refused: the signer inventory is not derivably complete for the terminal chain",
    );
  }

  // 8-9. trust and timestamps.
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

// -- 4. the environment final attestation ------------------------------------

export interface EnvironmentAttestationInput {
  readonly attestationId: string;
  readonly runId: string;
  readonly runRecordHash: Hash;
  readonly acquisitionPreregistrationVerificationReceiptHash: Hash;
  readonly selectionReceiptHash: Hash;
  readonly signerInventoryHash: Hash;
  readonly timestampCheckpointHash: Hash;
  readonly runTrustPolicyHash: Hash;
  readonly acquisitionSourceManifestHash: Hash;
  readonly acquisitionRecordHash: Hash;
  readonly subjectPackageManifestHash: Hash;
  readonly adapterHash: Hash;
  readonly genericRunPolicyHash: Hash;
  readonly genericEvaluationIndexHash: Hash;
  readonly environmentRestorationHash: Hash;
  readonly teardownHash: Hash;
  readonly exposureEventHash: Hash;
  readonly selectionAssurance: SelectionAssuranceV1;
  readonly claimScope: ClaimScope;
  readonly finalizedAt: Instant;
  readonly signingKey: SigningKey;
}

/**
 * Signs the environment final attestation.
 *
 * `lab_validity` is a schema constant `"valid"`, so an attestation for an
 * invalid run cannot be represented at all, and `cleanup.kind` is the constant
 * `"environment"` carrying *both* the restoration and teardown hashes — a
 * pre-environment cleanup can never be substituted for the pair.
 *
 * While ERL2-OQ-007 is unresolved the only representable assurance is
 * `non_blind_development`, so the attestation cannot claim blindness it did not
 * have.
 */
export function buildEnvironmentAttestation(
  input: EnvironmentAttestationInput,
): EnvironmentFinalLabAttestationV1 {
  const body = {
    schema_version: "environment-final-lab-attestation/v1" as const,
    attestation_id: input.attestationId,
    run_id: input.runId,
    terminal_variant: "environment" as const,
    run_record_hash: input.runRecordHash,
    acquisition_preregistration_verification_receipt_hash:
      input.acquisitionPreregistrationVerificationReceiptHash,
    selection_receipt_hash: input.selectionReceiptHash,
    signer_inventory_hash: input.signerInventoryHash,
    timestamp_checkpoint_hash: input.timestampCheckpointHash,
    run_trust_policy_hash: input.runTrustPolicyHash,
    acquisition_source_manifest_hash: input.acquisitionSourceManifestHash,
    acquisition_record_hash: input.acquisitionRecordHash,
    subject_package_manifest_hash: input.subjectPackageManifestHash,
    adapter_hash: input.adapterHash,
    generic_run_policy_hash: input.genericRunPolicyHash,
    generic_evaluation_index_hash: input.genericEvaluationIndexHash,
    cleanup: {
      kind: "environment" as const,
      restoration_hash: input.environmentRestorationHash,
      teardown_hash: input.teardownHash,
    },
    exposure_event_hash: input.exposureEventHash,
    selection_assurance: input.selectionAssurance,
    lab_validity: "valid" as const,
    claim_scope: input.claimScope,
    finalized_at: input.finalizedAt,
  };
  const attestation = assertContract<EnvironmentFinalLabAttestationV1>(
    "EnvironmentFinalLabAttestationV1",
    sealSigned(body, input.signingKey),
  );
  assertNoDeepAncestry(attestation, "environment final attestation");
  return attestation;
}

// -- 5. the environment public bundle ----------------------------------------

export interface EnvironmentBundleInput {
  readonly bundleId: string;
  readonly runId: string;
  readonly finalAttestation: { readonly artifact: ArtifactRef; readonly coreHash: Hash };
  readonly acquisitionPreregistrationVerificationReceipt: {
    readonly artifact: ArtifactRef;
    readonly coreHash: Hash;
  };
  readonly selectionVerificationReceipt: { readonly artifact: ArtifactRef; readonly coreHash: Hash };
  readonly signerInventory: { readonly artifact: ArtifactRef; readonly coreHash: Hash };
  readonly runTrustPolicy: { readonly artifact: ArtifactRef; readonly coreHash: Hash };
  readonly selectedRunTimestampCheckpointChain: readonly {
    readonly artifact: ArtifactRef;
    readonly coreHash: Hash;
  }[];
  readonly createdAt: Instant;
}

function member(input: { readonly artifact: ArtifactRef; readonly coreHash: Hash }): BundleMember {
  return { artifact: input.artifact, artifact_core_hash: input.coreHash };
}

/**
 * Freezes the environment public bundle.
 *
 * `execution_artifacts` is a schema-fixed empty array and
 * `execution_verification_mode` is fixed to `finalizer_verdict_only`, exactly as
 * in the pre-environment variant: a public bundle carries the finalizer's
 * verdict and the evidence needed to check it, never an execution body a reader
 * could be asked to re-run.  The difference is the mandatory
 * `selection_verification_receipt` member, which is what lets an offline reader
 * check that the challenge this run answered was the one the protocol selected.
 */
export function buildEnvironmentBundle(
  input: EnvironmentBundleInput,
): EnvironmentPublicVerificationBundleV2 {
  if (input.selectedRunTimestampCheckpointChain.length === 0) {
    throw new Erl2Error(
      CODES.BUNDLE_MEMBER_MISSING,
      "a public bundle requires at least one timestamp checkpoint",
    );
  }
  const body = {
    schema_version: "public-verification-bundle/v2" as const,
    terminal_variant: "environment" as const,
    bundle_id: input.bundleId,
    run_id: input.runId,
    final_attestation: member(input.finalAttestation),
    acquisition_preregistration_verification_receipt: member(
      input.acquisitionPreregistrationVerificationReceipt,
    ),
    selection_verification_receipt: member(input.selectionVerificationReceipt),
    signer_inventory: member(input.signerInventory),
    run_trust_policy: member(input.runTrustPolicy),
    selected_run_timestamp_checkpoint_chain:
      input.selectedRunTimestampCheckpointChain.map(member),
    verification_trust_head_source: "local_root_pinned_configuration" as const,
    execution_verification_mode: "finalizer_verdict_only" as const,
    execution_artifacts: [] as [],
    created_at: input.createdAt,
  };
  const bundle = assertContract<EnvironmentPublicVerificationBundleV2>(
    "EnvironmentPublicVerificationBundleV2",
    { ...body, core_hash: coreHash(body) },
  );
  assertNoDeepAncestry(bundle, "environment public bundle");
  return bundle;
}

/**
 * The only selection assurance representable while ERL2-OQ-007 is unresolved.
 *
 * It is a *value*, not a flag: the schema's blind variant requires evidence the
 * development beacon cannot produce, so a development run states plainly that
 * it makes no blindness claim rather than leaving the field to a default.
 */
export const NON_BLIND_DEVELOPMENT_ASSURANCE: SelectionAssuranceV1 = Object.freeze({
  mode: "non_blind_development",
  blindness_claim: "none",
}) as SelectionAssuranceV1;
