/**
 * Fake no-op run harness (implementation plan §8.5).
 *
 * This is a *test harness*, not a CLI command: the design forbids exposing a
 * development-only shortcut in the release CLI.  It drives the real lifecycle,
 * artifact store, trust and verifier code paths with a fake subject so the
 * Slice 2 exit gates — a valid pre-environment run and an invalid run, both
 * verifying offline — are executable evidence rather than a claim.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertContract,
  type ArtifactRef,
  type Hash,
  type LabLifecycleEventV1,
} from "@erl2/contracts";
import {
  ArtifactStore,
  coreHash,
  domainHash,
  HASH_DOMAINS,
  sealSigned,
  treeHash,
} from "@erl2/integrity";
import {
  assertBaselineClean,
  assertFrontierActionsDerivable,
  FakeEnvironmentDriver,
  freezeResourceFrontier,
  LifecycleLog,
  SteppingClock,
  SeededRandom,
  TimestampLog,
  uuidV7From,
  type LabState,
} from "@erl2/core";
import {
  developmentKeyring,
  developmentTrustPolicy,
  localTrustConfiguration,
  type DevelopmentKeyring,
} from "./keys.js";
import type { LocalTrustConfiguration } from "@erl2/integrity";

export interface FakeRunResult {
  readonly runId: string;
  readonly root: string;
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly localTrust: LocalTrustConfiguration;
  readonly keyring: DevelopmentKeyring;
  readonly bundle?: unknown;
  readonly invalidRecord?: unknown;
  readonly store: ArtifactStore;
}

const RUN_START = "2026-07-01T00:00:00Z";

function newWorkspace(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `erl2-${label}-`));
}

function fakeRunId(seed: number): string {
  return uuidV7From(Date.parse(RUN_START), Buffer.alloc(10, seed));
}

interface Ctx {
  readonly runId: string;
  readonly store: ArtifactStore;
  readonly clock: SteppingClock;
  readonly random: SeededRandom;
  readonly lifecycle: LifecycleLog;
  readonly timestamps: TimestampLog;
  readonly keyring: DevelopmentKeyring;
}

/** Freezes a contract object and returns its `ArtifactRef` plus core hash. */
function publish(
  ctx: Ctx,
  logicalPath: string,
  value: unknown,
): { readonly ref: ArtifactRef; readonly hash: Hash } {
  const ref = ctx.store.freezeJson(logicalPath, value, "INTERNAL");
  return { ref, hash: coreHash(value as object) };
}

function h(label: string): Hash {
  return domainHash(HASH_DOMAINS.TREE, { fixture_label: label });
}

// ---------------------------------------------------------------------------
// Shared pre-environment scaffolding.
// ---------------------------------------------------------------------------

function preregister(ctx: Ctx) {
  const { keyring } = ctx;

  const adapterManifest = assertContract(
    "SubjectAdapterManifestV1",
    sealSigned(
      {
        schema_version: "subject-adapter-manifest/v1" as const,
        adapter_id: "fake-subject",
        version: "0.1.0",
        protocol_version: "subject-adapter/v1" as const,
        adapter_artifact_hash: h("adapter-artifact"),
        supported_package_kinds: ["archive"],
        operations: ["acquire", "verify-package"],
        required_broker_capabilities: [],
        network_allowlist_ids: [],
        projection_schema: "generic-claim-set/v1" as const,
        certification_receipt_hash: h("adapter-certification"),
        owner: "erl2 development",
      },
      keyring.adapterOwner,
    ),
  );
  const adapter = publish(ctx, "retained/adapter-manifest.json", adapterManifest);

  const sourceManifest = assertContract(
    "AcquisitionSourceManifestV1",
    sealSigned(
      {
        schema_version: "acquisition-source-manifest/v1" as const,
        source_id: "fake-local-delivery",
        source_kind: "local_delivery" as const,
        locator_hash: h("locator"),
        requested_version_or_channel: "0.1.0",
        integrity_policy_hash: h("integrity-policy"),
        provenance_policy_hash: h("provenance-policy"),
        network_profile_hash: h("network-profile"),
        limits: { runtime_ms: 60_000, bytes: 1_048_576, redirects: 0 },
      },
      keyring.policyAuthor,
    ),
  );
  const source = publish(ctx, "retained/acquisition-source-manifest.json", sourceManifest);

  const runPolicy = assertContract(
    "GenericRunPolicyV1",
    sealSigned(
      {
        schema_version: "generic-run-policy/v1" as const,
        policy_id: "fake-generic-run-policy",
        version: 1,
        evidence_policy_hash: h("evidence-policy"),
        cutoff_policy_hash: h("cutoff-policy"),
        journey_policy_hash: h("journey-policy"),
        generic_evaluation_policy_hash: h("generic-evaluation-policy"),
        domain_pack_hashes: [h("operations-pack")],
        run_trust_policy_hash: h("run-trust-policy"),
      },
      keyring.policyAuthor,
    ),
  );
  const policy = publish(ctx, "retained/generic-run-policy.json", runPolicy);

  const preregistration = assertContract(
    "AcquisitionPreregistrationV1",
    sealSigned(
      {
        schema_version: "acquisition-preregistration/v1" as const,
        preregistration_id: "fake-preregistration",
        run_id: ctx.runId,
        acquisition_source_manifest_hash: source.hash,
        adapter_manifest_hash: adapter.hash,
        acquisition_actor_script_hash: h("acquisition-actor-script"),
        acquisition_actor_schema_hash: h("acquisition-actor-schema"),
        acquisition_step_commitment_hash: h("acquire-step-commitment"),
        package_verification_step_commitment_hash: h("verify-package-step-commitment"),
        generic_run_policy_hash: policy.hash,
        run_trust_policy_hash: h("run-trust-policy"),
        limits_hash: h("limits"),
        registered_at: ctx.clock.now(),
        expires_at: "2026-12-31T00:00:00Z",
        selected_case_identity: "absent" as const,
      },
      keyring.preregistrar,
    ),
  );
  const prereg = publish(ctx, "retained/acquisition-preregistration.json", preregistration);

  const receipt = assertContract(
    "AcquisitionPreregistrationVerificationReceiptV1",
    sealSigned(
      {
        schema_version: "acquisition-preregistration-verification-receipt/v1" as const,
        run_id: ctx.runId,
        acquisition_preregistration_hash: prereg.hash,
        source_manifest_hash: source.hash,
        adapter_manifest_hash: adapter.hash,
        trust_policy_hash: h("run-trust-policy"),
        selected_case_identity_absent: true as const,
        signature_valid: true as const,
        verified_at: ctx.clock.now(),
      },
      keyring.preregistrar,
    ),
  );
  const verificationReceipt = publish(
    ctx,
    "retained/acquisition-preregistration-verification-receipt.json",
    receipt,
  );

  ctx.lifecycle.append({
    eventType: "acquisition_preregistered",
    stateTo: "acquisition_preregistered",
    actorId: "fake-operator",
    commandId: "preregister-acquisition",
    operationId: "op-preregister",
    produced: [
      {
        artifact_role: "acquisition-preregistration",
        artifact_core_hash: prereg.hash,
        artifact_schema_version: "acquisition-preregistration/v1",
      },
      {
        artifact_role: "acquisition-source-manifest",
        artifact_core_hash: source.hash,
        artifact_schema_version: "acquisition-source-manifest/v1",
      },
    ],
  });

  return { adapter, source, policy, prereg, verificationReceipt };
}

// ---------------------------------------------------------------------------
// Valid pre-environment terminal.
// ---------------------------------------------------------------------------

/**
 * A complete valid pre-environment run.
 *
 * Acquisition succeeds and package verification *fails*, which is the only way
 * a run legitimately terminates before selection: a successful verification
 * freezes `SubjectPackageManifestV1` and the design's one authorized
 * continuation is challenge preregistration (design v2 §12, ADR-ERL2-013).
 * The failed step is attributed to the subject, the journey and domain results
 * join before cleanup, cleanup verifies, validity is valid, and the finalizer
 * produces an attestation and a closed public bundle.
 */
export function runFakeValidPreEnvironmentRun(): FakeRunResult {
  const root = newWorkspace("valid");
  const runId = fakeRunId(0x11);
  const keyring = developmentKeyring();
  const store = new ArtifactStore(root);
  const clock = new SteppingClock(RUN_START, 1000);
  const ctx: Ctx = {
    runId,
    store,
    clock,
    random: new SeededRandom("erl2-fake-valid"),
    lifecycle: new LifecycleLog({ runId, store, clock }),
    timestamps: new TimestampLog({
      logId: "erl2-development-log",
      runId,
      authority: keyring.timestampAuthority,
      clock,
    }),
    keyring,
  };
  const scaffold = preregister(ctx);

  // --- acquire -------------------------------------------------------------
  const acquireOutcome = runStep(ctx, {
    stepId: "acquire",
    intent: "acquire",
    commitmentHash: h("acquire-step-commitment"),
    eventPrefix: "subject_acquisition",
    status: "succeeded",
  });

  const acquiredArtifact = store.freeze({
    logicalPath: "retained/acquired-package.bin",
    bytes: Buffer.from("fake subject package bytes\n", "utf8"),
    mediaType: "application/octet-stream",
    classification: "INTERNAL",
  });
  const acquisitionBase = {
    schema_version: "subject-acquisition-record/v1" as const,
    run_id: runId,
    acquisition_request_hash: h("acquisition-request"),
    step_commitment_hash: h("acquire-step-commitment"),
    source_manifest_hash: scaffold.source.hash,
    attempts: [
      {
        attempt_id: "attempt-1",
        started_at: "2026-07-01T00:00:10Z",
        ended_at: "2026-07-01T00:00:12Z",
        status: "completed" as const,
        bytes: 4096,
        redirect_count: 0,
        error_codes: [] as string[],
      },
    ],
    authentication_prompt_count: 0,
    documentation_step_ids: ["doc-install-overview"],
    active_operator_ms: 2000,
    elapsed_ms: 2000,
    acquired_artifact: acquiredArtifact,
    lab_network_control_hash: h("lab-network-control"),
    status: "completed" as const,
  };
  const acquisitionValue = { ...acquisitionBase, core_hash: coreHash(acquisitionBase) };
  assertContract("SubjectAcquisitionRecordV1", acquisitionValue);
  const acquisition = publish(ctx, "retained/subject-acquisition-record.json", acquisitionValue);

  ctx.lifecycle.append({
    eventType: "subject_acquisition_outcome_frozen",
    stateTo: "step_outcome_frozen",
    actorId: "fake-operator",
    commandId: "acquire",
    operationId: "op-acquire-freeze",
    requiredHashes: [scaffold.prereg.hash],
    produced: [
      {
        artifact_role: "acquisition-record",
        artifact_core_hash: acquisition.hash,
        artifact_schema_version: "subject-acquisition-record/v1",
      },
      {
        artifact_role: "journey-step-outcome",
        artifact_core_hash: acquireOutcome.hash,
        artifact_schema_version: "journey-step-outcome/v1",
      },
    ],
  });

  // --- verify package ------------------------------------------------------
  ctx.lifecycle.append({
    eventType: "subject_package_frozen",
    stateTo: "subject_package_frozen",
    actorId: "fake-operator",
    commandId: "freeze-package",
    operationId: "op-freeze-package",
  });
  const verifyOutcome = runStep(ctx, {
    stepId: "verify-package",
    intent: "verify_package",
    commitmentHash: h("verify-package-step-commitment"),
    eventPrefix: "subject_package_verification",
    status: "failed",
  });

  const verificationRecordBase = {
    schema_version: "subject-package-verification-record/v1" as const,
    run_id: runId,
    verification_request_hash: h("package-verification-request"),
    step_commitment_hash: h("verify-package-step-commitment"),
    acquisition_record_hash: acquisition.hash,
    frozen_package_file_sha256: h("frozen-package-bytes"),
    integrity_policy_hash: h("integrity-policy"),
    provenance_policy_hash: h("provenance-policy"),
    checks: [{ check_id: "provenance-attestation-present", passed: false, evidence_refs: [] }],
    status: "failed" as const,
    started_at: "2026-07-01T00:00:20Z",
    ended_at: "2026-07-01T00:00:21Z",
  };
  const verification = publish(ctx, "retained/subject-package-verification-record.json", {
    ...verificationRecordBase,
    core_hash: coreHash(verificationRecordBase),
  });
  assertContract("SubjectPackageVerificationRecordV1", {
    ...verificationRecordBase,
    core_hash: coreHash(verificationRecordBase),
  });

  // The failure is attributable to the subject: the Lab's own freezer and
  // validator controls passed, so the finding is a subject finding rather than
  // a Lab invalidity (design v2 §12 failure-ownership table).
  const subjectFindingBase = {
    schema_version: "finding/v1" as const,
    kind: "subject_finding" as const,
    finding_id: "subject-package-verification-failure",
    run_id: runId,
    journey_step_id: "verify-package",
    severity: "high" as const,
    proof_refs: [verification.hash],
    safe_summary: "The acquired package carries no provenance attestation the declared policy accepts.",
    owner: "subject" as const,
    category: "subject_package_verification_failure" as const,
    subject_attribution_proven: true as const,
    attribution_proof_hash: h("lab-freezer-and-validator-controls-passed"),
    counterfactual_control_refs: [h("control-package-verifies")],
    scoreable_planes: ["journey"] as const,
  };
  const subjectFinding = publish(ctx, "retained/subject-package-verification-finding.json", {
    ...subjectFindingBase,
    core_hash: coreHash(subjectFindingBase),
  });
  assertContract("SubjectFindingV1", { ...subjectFindingBase, core_hash: subjectFinding.hash });

  ctx.lifecycle.append({
    eventType: "subject_package_verification_outcome_frozen",
    stateTo: "step_outcome_frozen",
    actorId: "fake-operator",
    commandId: "verify-package",
    operationId: "op-verify-package-freeze",
    requiredHashes: [acquisition.hash],
    produced: [
      {
        artifact_role: "package-verification-record",
        artifact_core_hash: verification.hash,
        artifact_schema_version: "subject-package-verification-record/v1",
      },
      {
        artifact_role: "journey-step-outcome",
        artifact_core_hash: verifyOutcome.hash,
        artifact_schema_version: "journey-step-outcome/v1",
      },
      {
        artifact_role: "finding",
        artifact_core_hash: subjectFinding.hash,
        artifact_schema_version: "finding/v1",
      },
    ],
  });

  // --- subject output freeze ----------------------------------------------
  // No `subject_package_manifest_hash`: verification failed, so no package
  // manifest exists, and the pre-environment branch has no member for one.
  const outputEntries: ArtifactRef[] = [acquireOutcome.ref, verifyOutcome.ref];
  const outputBase = {
    schema_version: "subject-output-manifest/v1" as const,
    run_id: runId,
    terminal_stage: "verify_package" as const,
    acquisition_source_manifest_hash: scaffold.source.hash,
    acquisition_record_hash: acquisition.hash,
    adapter_hash: scaffold.adapter.hash,
    step_outcome_hashes: [acquireOutcome.hash, verifyOutcome.hash],
    interaction_hashes: [],
    entries: outputEntries,
    tree_hash: treeHash(outputEntries),
    timed_out: false,
    unsupported_inputs: [],
    frozen_at: ctx.clock.now(),
  };
  const output = publish(ctx, "retained/subject-output-manifest.json", {
    ...outputBase,
    core_hash: coreHash(outputBase),
  });
  assertContract("PreEnvironmentSubjectOutputManifestV1", { ...outputBase, core_hash: output.hash });

  ctx.lifecycle.append({
    eventType: "subject_output_frozen",
    stateTo: "subject_output_frozen",
    actorId: "fake-operator",
    commandId: "freeze-output",
    operationId: "op-freeze-output",
    produced: [
      {
        artifact_role: "subject-output-manifest",
        artifact_core_hash: output.hash,
        artifact_schema_version: "subject-output-manifest/v1",
      },
    ],
  });

  // --- reveal, results and the pre-cleanup join ---------------------------
  ctx.lifecycle.append({
    eventType: "judge_journey_expectation_revealed",
    stateTo: "judge_journey_expectation_revealed",
    actorId: "fake-judge",
    commandId: "reveal",
    operationId: "op-reveal",
    requiredHashes: [output.hash],
  });

  const journeyBase = {
    schema_version: "pre-selection-journey-result/v1" as const,
    run_id: runId,
    terminal_stage: "verify_package" as const,
    acquisition_preregistration_hash: scaffold.prereg.hash,
    generic_run_policy_hash: scaffold.policy.hash,
    step_outcome_hashes: [acquireOutcome.hash, verifyOutcome.hash],
    revealed_judge_expectation_hashes: [h("revealed-acquire-expectation")],
    metric_result_hashes: [h("metric-time-to-first-evidence")],
    finding_hashes: [subjectFinding.hash],
    status: "evaluated" as const,
    recorded_at: ctx.clock.now(),
  };
  const journey = publish(ctx, "retained/journey-result.json", {
    ...journeyBase,
    core_hash: coreHash(journeyBase),
  });
  ctx.lifecycle.append({
    eventType: "nonfunctional_journey_result_frozen",
    stateTo: "nonfunctional_journey_result_frozen",
    actorId: "fake-judge",
    commandId: "evaluate",
    operationId: "op-journey-result",
    produced: [
      {
        artifact_role: "journey-result",
        artifact_core_hash: journey.hash,
        artifact_schema_version: "pre-selection-journey-result/v1",
      },
    ],
  });

  const domainBase = {
    schema_version: "domain-result-not-applicable/v1" as const,
    run_id: runId,
    generic_run_policy_hash: scaffold.policy.hash,
    terminal_stage: "verify_package" as const,
    reason: "pre_environment_terminal" as const,
    journey_result_hash: journey.hash,
    finding_hashes: [] as Hash[],
    status: "not_applicable" as const,
    recorded_at: ctx.clock.now(),
  };
  const domain = publish(ctx, "retained/domain-result.json", {
    ...domainBase,
    core_hash: coreHash(domainBase),
  });
  const domainEvent = ctx.lifecycle.append({
    eventType: "domain_not_applicable_frozen",
    stateTo: "domain_not_applicable_frozen",
    actorId: "fake-judge",
    commandId: "evaluate",
    operationId: "op-domain-result",
    produced: [
      {
        artifact_role: "domain-result",
        artifact_core_hash: domain.hash,
        artifact_schema_version: "domain-result-not-applicable/v1",
      },
    ],
  });

  const joinBase = {
    schema_version: "generic-precleanup-result-join/v1" as const,
    run_id: runId,
    journey_result_hash: journey.hash,
    domain_result_hash: domain.hash,
    domain_variant: "not_applicable" as const,
    both_frozen_before_cleanup: true as const,
    lifecycle_event_hash: domainEvent.core_hash,
    joined_at: ctx.clock.now(),
  };
  const join = publish(ctx, "retained/precleanup-result-join.json", {
    ...joinBase,
    core_hash: coreHash(joinBase),
  });
  ctx.lifecycle.append({
    eventType: "generic_precleanup_results_complete",
    stateTo: "generic_precleanup_results_complete",
    actorId: "fake-judge",
    commandId: "evaluate",
    operationId: "op-result-join",
    produced: [
      {
        artifact_role: "precleanup-result-join",
        artifact_core_hash: join.hash,
        artifact_schema_version: "generic-precleanup-result-join/v1",
      },
    ],
  });

  // --- cleanup (pre-environment only), validity, index --------------------
  ctx.lifecycle.append({
    eventType: "pre_environment_cleanup_started",
    stateTo: "pre_environment_cleanup_started",
    actorId: "fake-operator",
    commandId: "finalize-generic",
    operationId: "op-cleanup-start",
  });
  const cleanupBase = {
    schema_version: "pre-environment-cleanup-verification/v1" as const,
    run_id: runId,
    terminal_stage: "verify_package" as const,
    acquisition_preregistration_hash: scaffold.prereg.hash,
    acquisition_record_hash: acquisition.hash,
    subject_output_hash: output.hash,
    acquired_artifact_disposition: "deleted" as const,
    cleanup_receipt_hashes: [h("cleanup-receipt-workspace")],
    residual_acquisition_resources: [],
    verified_at: ctx.clock.now(),
    passed: true,
  };
  const cleanup = publish(ctx, "retained/pre-environment-cleanup-verification.json", {
    ...cleanupBase,
    core_hash: coreHash(cleanupBase),
  });
  ctx.lifecycle.append({
    eventType: "pre_environment_cleanup_verified",
    stateTo: "pre_environment_cleanup_verified",
    actorId: "fake-operator",
    commandId: "finalize-generic",
    operationId: "op-cleanup-verified",
    produced: [
      {
        artifact_role: "pre-environment-cleanup",
        artifact_core_hash: cleanup.hash,
        artifact_schema_version: "pre-environment-cleanup-verification/v1",
      },
    ],
  });

  const validityBase = {
    schema_version: "pre-environment-validity-result/v1" as const,
    run_id: runId,
    terminal_stage: "verify_package" as const,
    generic_run_policy_hash: scaffold.policy.hash,
    gate_results: [
      { gate_id: "acquisition-controls-passed", passed: true, evidence_refs: [acquisition.hash] },
      { gate_id: "cleanup-verified", passed: true, evidence_refs: [cleanup.hash] },
    ],
    pre_environment_cleanup_hash: cleanup.hash,
    status: "valid" as const,
    invalidity_finding_hashes: [],
    evaluated_at: ctx.clock.now(),
  };
  const validity = publish(ctx, "retained/validity-result.json", {
    ...validityBase,
    core_hash: coreHash(validityBase),
  });
  ctx.lifecycle.append({
    eventType: "pre_environment_validity_result_frozen",
    stateTo: "pre_environment_validity_result_frozen",
    actorId: "fake-judge",
    commandId: "finalize-generic",
    operationId: "op-validity",
    produced: [
      {
        artifact_role: "validity-result",
        artifact_core_hash: validity.hash,
        artifact_schema_version: "pre-environment-validity-result/v1",
      },
    ],
  });

  const indexBase = {
    schema_version: "generic-evaluation-index/v1" as const,
    run_id: runId,
    generic_run_policy_hash: scaffold.policy.hash,
    validity_result_hash: validity.hash,
    journey_result_hash: journey.hash,
    domain_result_hash: domain.hash,
    precleanup_result_join_hash: join.hash,
    evaluator_version: "erl2-generic-evaluator/0.1.0",
  };
  const evaluationIndex = publish(ctx, "retained/generic-evaluation-index.json", {
    ...indexBase,
    core_hash: coreHash(indexBase),
  });
  ctx.lifecycle.append({
    eventType: "generic_evaluation_index_frozen",
    stateTo: "generic_evaluation_index_frozen",
    actorId: "fake-judge",
    commandId: "finalize-generic",
    operationId: "op-index",
    produced: [
      {
        artifact_role: "generic-evaluation-index",
        artifact_core_hash: evaluationIndex.hash,
        artifact_schema_version: "generic-evaluation-index/v1",
      },
    ],
  });

  // --- terminal run record -------------------------------------------------
  const recordBase = {
    schema_version: "pre-environment-lab-run-record/v1" as const,
    run_id: runId,
    terminal_stage: "verify_package" as const,
    acquisition_preregistration_hash: scaffold.prereg.hash,
    acquisition_source_manifest_hash: scaffold.source.hash,
    acquisition_record_hash: acquisition.hash,
    package_verification_record_hash: verification.hash,
    adapter_hash: scaffold.adapter.hash,
    generic_run_policy_hash: scaffold.policy.hash,
    subject_output_hash: output.hash,
    journey_result_hash: journey.hash,
    domain_not_applicable_result_hash: domain.hash,
    precleanup_result_join_hash: join.hash,
    pre_environment_cleanup_hash: cleanup.hash,
    validity_result_hash: validity.hash,
    generic_evaluation_index_hash: evaluationIndex.hash,
    lifecycle_head_hash: ctx.lifecycle.head as Hash,
  };
  const runRecord = publish(ctx, "retained/run-record.json", {
    ...recordBase,
    core_hash: coreHash(recordBase),
  });
  assertContract("PreEnvironmentLabRunRecordV1", { ...recordBase, core_hash: runRecord.hash });

  // The run record's own event closes the chain; its lifecycle_head_hash refers
  // to the head *before* that event, which is what the verifier re-derives.
  const trustPolicy = developmentTrustPolicy(keyring);
  const trustPolicyPublished = publish(ctx, "retained/trust-policy.json", trustPolicy);

  const checkpoint = ctx.timestamps.anchor({
    artifactSchemaVersion: "pre-environment-lab-run-record/v1",
    artifactCoreHash: runRecord.hash,
    signerKeyId: keyring.finalizer.keyId,
    signature: {
      algorithm: "Ed25519",
      key_id: keyring.finalizer.keyId,
      signed_hash: runRecord.hash,
      signature_base64: `${"A".repeat(86)}==`,
    },
  });
  const checkpointPublished = publish(ctx, "retained/timestamp-checkpoint.json", checkpoint);

  const inventoryBase = {
    schema_version: "signer-inventory/v2" as const,
    terminal_variant: "pre_environment" as const,
    inventory_id: "fake-signer-inventory",
    run_id: runId,
    acquisition_preregistration_hash: scaffold.prereg.hash,
    entries: [
      {
        artifact_schema_version: "acquisition-preregistration/v1",
        artifact_core_hash: scaffold.prereg.hash,
        signer_key_id: keyring.preregistrar.keyId,
        signature_sha256: scaffold.prereg.hash,
        security_timestamp: "2026-07-01T00:00:05Z",
        timestamp_log_id: "erl2-development-log",
        timestamp_sequence: 0,
      },
    ],
    excluded_public_terminal_types: ["pre-environment-final-lab-attestation/v1"] as const,
    complete_for_terminal_chain: true as const,
    inventoried_at: ctx.clock.now(),
  };
  const inventory = publish(
    ctx,
    "retained/signer-inventory.json",
    sealSigned(inventoryBase, keyring.finalizer),
  );

  const attestationBase = {
    schema_version: "pre-environment-final-lab-attestation/v1" as const,
    attestation_id: "fake-final-attestation",
    run_id: runId,
    terminal_variant: "pre_environment" as const,
    run_record_hash: runRecord.hash,
    acquisition_preregistration_verification_receipt_hash: scaffold.verificationReceipt.hash,
    signer_inventory_hash: inventory.hash,
    timestamp_checkpoint_hash: checkpointPublished.hash,
    run_trust_policy_hash: trustPolicyPublished.hash,
    acquisition_source_manifest_hash: scaffold.source.hash,
    acquisition_record_hash: acquisition.hash,
    adapter_hash: scaffold.adapter.hash,
    generic_run_policy_hash: scaffold.policy.hash,
    generic_evaluation_index_hash: evaluationIndex.hash,
    cleanup: { kind: "pre_environment" as const, verification_hash: cleanup.hash },
    lab_validity: "valid" as const,
    claim_scope: "T1" as const,
    finalized_at: ctx.clock.now(),
  };
  const attestation = publish(
    ctx,
    "retained/final-attestation.json",
    sealSigned(attestationBase, keyring.finalizer),
  );

  const bundleBase = {
    schema_version: "public-verification-bundle/v2" as const,
    terminal_variant: "pre_environment" as const,
    bundle_id: "fake-public-bundle",
    run_id: runId,
    final_attestation: { artifact: attestation.ref, artifact_core_hash: attestation.hash },
    acquisition_preregistration_verification_receipt: {
      artifact: scaffold.verificationReceipt.ref,
      artifact_core_hash: scaffold.verificationReceipt.hash,
    },
    signer_inventory: { artifact: inventory.ref, artifact_core_hash: inventory.hash },
    run_trust_policy: {
      artifact: trustPolicyPublished.ref,
      artifact_core_hash: trustPolicyPublished.hash,
    },
    acquisition_timestamp_checkpoint_chain: [
      { artifact: checkpointPublished.ref, artifact_core_hash: checkpointPublished.hash },
    ] as const,
    verification_trust_head_source: "local_root_pinned_configuration" as const,
    execution_verification_mode: "finalizer_verdict_only" as const,
    execution_artifacts: [] as const,
    created_at: ctx.clock.now(),
  };
  const bundle = { ...bundleBase, core_hash: coreHash(bundleBase) };
  publish(ctx, "retained/public-bundle.json", bundle);
  assertContract("PreEnvironmentPublicVerificationBundleV2", bundle);

  ctx.lifecycle.append({
    eventType: "generic_finalized",
    stateTo: "generic_finalized",
    actorId: "fake-finalizer",
    commandId: "finalize-generic",
    operationId: "op-finalize",
    requiredHashes: [evaluationIndex.hash, cleanup.hash],
    produced: [
      {
        artifact_role: "run-record",
        artifact_core_hash: runRecord.hash,
        artifact_schema_version: "pre-environment-lab-run-record/v1",
      },
      {
        artifact_role: "final-attestation",
        artifact_core_hash: attestation.hash,
        artifact_schema_version: "pre-environment-final-lab-attestation/v1",
      },
      {
        artifact_role: "signer-inventory",
        artifact_core_hash: inventory.hash,
        artifact_schema_version: "signer-inventory/v2",
      },
    ],
  });

  return {
    runId,
    root,
    lifecycle: ctx.lifecycle.all(),
    localTrust: localTrustConfiguration(trustPolicy, keyring, [], h("randomness-registry-head")),
    keyring,
    bundle,
    store,
  };
}

interface StepOptions {
  readonly stepId: string;
  readonly intent: "acquire" | "verify_package";
  readonly commitmentHash: Hash;
  readonly eventPrefix: string;
  readonly status: "succeeded" | "failed" | "unsupported";
}

function runStep(ctx: Ctx, options: StepOptions): { readonly ref: ArtifactRef; readonly hash: Hash } {
  ctx.lifecycle.append({
    eventType: `${options.eventPrefix}_planned`,
    stateTo: "step_planned",
    actorId: "fake-operator",
    commandId: options.stepId,
    operationId: `op-${options.stepId}-planned`,
  });
  ctx.lifecycle.append({
    eventType: `${options.eventPrefix}_started`,
    stateTo: "step_started",
    actorId: "fake-operator",
    commandId: options.stepId,
    operationId: `op-${options.stepId}-started`,
  });
  const terminal = {
    succeeded: { event: "completed", state: "step_succeeded" },
    failed: { event: "failed", state: "step_failed" },
    unsupported: { event: "unsupported", state: "step_unsupported" },
  }[options.status] as { event: string; state: LabState };
  ctx.lifecycle.append({
    eventType: `${options.eventPrefix}_${terminal.event}`,
    stateTo: terminal.state,
    actorId: "fake-operator",
    commandId: options.stepId,
    operationId: `op-${options.stepId}-${options.status}`,
  });
  const base = {
    schema_version: "journey-step-outcome/v1" as const,
    run_id: ctx.runId,
    step_id: options.stepId,
    step_commitment_hash: options.commitmentHash,
    visible_step_hash: h(`${options.stepId}-visible-step`),
    adapter_request_hash: h(`${options.stepId}-adapter-request`),
    intent: options.intent,
    status: options.status,
    attempt_record_hashes: [h(`${options.stepId}-attempt-1`)],
    detail_record_hashes: [],
    visible_input_hashes: [],
    output_refs: [],
    mutation_receipt_hashes: [],
    compensation_receipt_hashes: [],
    diagnostic_refs: [],
    started_at: "2026-07-01T00:00:10Z",
    ended_at: "2026-07-01T00:00:12Z",
    active_operator_ms: 2000,
    next_permitted_intents: options.intent === "acquire" ? ["verify_package" as const] : [],
  };
  const value = { ...base, core_hash: coreHash(base) };
  assertContract("JourneyStepOutcomeV1", value);
  const ref = ctx.store.freezeJson(`retained/step-outcome-${options.stepId}.json`, value, "INTERNAL");
  return { ref, hash: value.core_hash };
}

// ---------------------------------------------------------------------------
// Invalid terminals.
// ---------------------------------------------------------------------------

export type InvalidScenario = "cancellation" | "classified_lab_failure";

/**
 * A run that cannot satisfy a valid terminal freezes exactly one
 * `InvalidLabRunRecordV1` after bounded cleanup, and produces no attestation
 * and no bundle (ERL2-FR-001/026, ERL2-AC-026/030).
 */
export function runFakeInvalidRun(scenario: InvalidScenario): FakeRunResult {
  const root = newWorkspace(`invalid-${scenario}`);
  const runId = fakeRunId(scenario === "cancellation" ? 0x22 : 0x33);
  const keyring = developmentKeyring();
  const store = new ArtifactStore(root);
  const clock = new SteppingClock(RUN_START, 1000);
  const ctx: Ctx = {
    runId,
    store,
    clock,
    random: new SeededRandom(`erl2-fake-${scenario}`),
    lifecycle: new LifecycleLog({ runId, store, clock }),
    timestamps: new TimestampLog({
      logId: "erl2-development-log",
      runId,
      authority: keyring.timestampAuthority,
      clock,
    }),
    keyring,
  };
  const scaffold = preregister(ctx);
  const preregEvent = ctx.lifecycle.find((e) => e.event_type === "acquisition_preregistered");

  ctx.lifecycle.append({
    eventType: "subject_acquisition_planned",
    stateTo: "step_planned",
    actorId: "fake-operator",
    commandId: "acquire",
    operationId: "op-acquire-planned",
  });

  let failureEventHash: Hash;
  let findingHash: Hash | undefined;

  if (scenario === "cancellation") {
    const event = ctx.lifecycle.append({
      eventType: "cancellation_requested",
      stateTo: "invalid_failure_detected",
      actorId: "fake-operator",
      commandId: "cancel",
      operationId: "op-cancel",
      failure: { code: "INVALID_TERMINAL_CANCELLED", owner: "lab", message: "operator cancelled the run" },
    });
    failureEventHash = event.core_hash;
  } else {
    const findingBase = {
      schema_version: "finding/v1" as const,
      kind: "lab_invalidity" as const,
      finding_id: "lab-acquisition-control-failure",
      run_id: runId,
      severity: "high" as const,
      proof_refs: [h("lab-network-control")],
      safe_summary: "Lab acquisition network control failed; no subject attribution is possible.",
      owner: "lab" as const,
      category: "lab_invalid" as const,
      failed_gate_ids: ["lab-network-control"],
      subject_attribution_proven: false as const,
      scoreable_planes: [] as const,
    };
    const finding = publish(ctx, "retained/lab-invalidity-finding.json", {
      ...findingBase,
      core_hash: coreHash(findingBase),
    });
    assertContract("LabInvalidityV1", { ...findingBase, core_hash: finding.hash });
    findingHash = finding.hash;
    const event = ctx.lifecycle.append({
      eventType: "lab_acquisition_control_failed",
      stateTo: "invalid_failure_detected",
      actorId: "fake-operator",
      commandId: "acquire",
      operationId: "op-acquire-failed",
      produced: [
        {
          artifact_role: "primary-finding",
          artifact_core_hash: finding.hash,
          artifact_schema_version: "finding/v1",
        },
      ],
      failure: { code: "ENV_LAB_NETWORK_CONTROL_FAILED", owner: "lab", message: "control probe failed" },
    });
    failureEventHash = event.core_hash;
  }

  // Bounded cleanup from the actual resource frontier: nothing external was
  // created, so the frontier is empty and no cleanup is required.
  ctx.lifecycle.append({
    eventType: "invalid_pre_environment_cleanup_started",
    stateTo: "invalid_pre_environment_cleanup_started",
    actorId: "fake-operator",
    commandId: "cleanup",
    operationId: "op-invalid-cleanup-start",
  });
  ctx.lifecycle.append({
    eventType: "invalid_cleanup_terminal",
    stateTo: "invalid_cleanup_terminal",
    actorId: "fake-operator",
    commandId: "cleanup",
    operationId: "op-invalid-cleanup-terminal",
  });

  const failedPhase =
    scenario === "cancellation"
      ? {
          kind: "cancellation" as const,
          cancelled_during: "pre_environment" as const,
          lifecycle_event_hash: failureEventHash,
        }
      : {
          kind: "lifecycle_phase" as const,
          phase: "acquisition" as const,
          lifecycle_event_hash: failureEventHash,
        };

  const terminalReason =
    scenario === "cancellation"
      ? {
          kind: "cancellation" as const,
          classification: "cancellation" as const,
          cancellation_request_hash: h("cancellation-request"),
          cancellation_event_hash: failureEventHash,
          requested_by_actor_hash: h("fake-operator-identity"),
          reason_code: "OPERATOR_CANCELLED",
        }
      : {
          kind: "classified_failure" as const,
          classification: "lab_invalidity" as const,
          failure_event_hash: failureEventHash,
          primary_finding_hash: findingHash as Hash,
          invalidity_finding_hash: findingHash as Hash,
        };

  const recordBase = {
    schema_version: "invalid-lab-run-record/v1" as const,
    run_id: runId,
    terminal_state: "invalidated" as const,
    failed_phase: failedPhase,
    terminal_reason: terminalReason,
    available_evidence: [
      {
        artifact_role: "acquisition-preregistration",
        artifact_hash: scaffold.prereg.hash,
        reached_event_hash: preregEvent?.core_hash as Hash,
      },
      {
        artifact_role: "acquisition-source-manifest",
        artifact_hash: scaffold.source.hash,
        reached_event_hash: preregEvent?.core_hash as Hash,
      },
      ...(findingHash === undefined
        ? []
        : [
            {
              artifact_role: "primary-finding",
              artifact_hash: findingHash,
              reached_event_hash: failureEventHash,
            },
          ]),
    ] as { artifact_role: string; artifact_hash: Hash; reached_event_hash: Hash }[],
    cleanup: {
      variant: "none" as const,
      status: "not_required" as const,
      attempt_hashes: [] as Hash[],
    },
    lifecycle_head_hash: ctx.lifecycle.head as Hash,
    invalidated_at: ctx.clock.now(),
  };
  const record = { ...recordBase, core_hash: coreHash(recordBase) };
  assertContract("InvalidLabRunRecordV1", record);
  const published = publish(ctx, "retained/invalid-run-record.json", record);

  ctx.lifecycle.append({
    eventType: "invalid_lab_run_record_frozen",
    stateTo: "invalid_lab_run_record_frozen",
    actorId: "fake-operator",
    commandId: "cleanup",
    operationId: "op-invalid-record",
    produced: [
      {
        artifact_role: "invalid-run-record",
        artifact_core_hash: published.hash,
        artifact_schema_version: "invalid-lab-run-record/v1",
      },
    ],
  });
  ctx.lifecycle.append({
    eventType: "invalidated",
    stateTo: "invalidated",
    actorId: "fake-operator",
    commandId: "cleanup",
    operationId: "op-invalidated",
  });

  const trustPolicy = developmentTrustPolicy(keyring);
  return {
    runId,
    root,
    lifecycle: ctx.lifecycle.all(),
    localTrust: localTrustConfiguration(trustPolicy, keyring, [], h("randomness-registry-head")),
    keyring,
    invalidRecord: record,
    store,
  };
}

// ---------------------------------------------------------------------------
// Environment teardown failure -> receipt-backed emergency cleanup.
// ---------------------------------------------------------------------------

/**
 * An invalid run that provisioned an environment and then failed to restore it.
 *
 * Design v2 §12 routes this through `emergency_cleanup_started`: the core
 * freezes the actual resource frontier, attempts every independently safe
 * action, freezes a receipt for each attempt, records each unsafe skip with a
 * reason and no receipt, and only then freezes the invalid record. A direct
 * transition to the invalid record is refused by the verifier
 * (ERL2-FR-025/AC-029/AC-035).
 */
export function runFakeEnvironmentEmergencyCleanupRun(): FakeRunResult {
  const root = newWorkspace("emergency");
  const runId = fakeRunId(0x44);
  const keyring = developmentKeyring();
  const store = new ArtifactStore(root);
  const clock = new SteppingClock(RUN_START, 1000);
  const ctx: Ctx = {
    runId,
    store,
    clock,
    random: new SeededRandom("erl2-fake-emergency"),
    lifecycle: new LifecycleLog({ runId, store, clock }),
    timestamps: new TimestampLog({
      logId: "erl2-development-log",
      runId,
      authority: keyring.timestampAuthority,
      clock,
    }),
    keyring,
  };
  const scaffold = preregister(ctx);
  const preregEvent = ctx.lifecycle.find((e) => e.event_type === "acquisition_preregistered");

  // --- provision a real (fake-driver) environment -------------------------
  const archetypeHash = h("clean-greenfield-archetype");
  const driver = new FakeEnvironmentDriver({
    clock,
    signingKey: keyring.challengeGovernor,
    archetypeHash,
    // One resource is shared with another run, so the frontier must contain it
    // rather than destroy it.
    faults: { failRestore: true, sharedResourceIds: [`volume-${runId.slice(0, 8)}`] },
  });
  const driverManifest = publish(ctx, "retained/environment-driver-manifest.json", driver.manifest);
  const provisioned = driver.provision({
    runId,
    archetypeHash,
    disorderSeedCommitment: h("disorder-seed"),
    operationId: "op-provision",
  });
  const inventory = publish(ctx, "retained/environment-resource-inventory.json", provisioned.inventory);
  const baseline = driver.probe({ runId, phase: "baseline", operationId: "op-baseline" });
  assertBaselineClean(baseline);
  const baselinePublished = publish(ctx, "retained/environment-baseline.json", baseline);

  ctx.lifecycle.append({
    eventType: "subject_acquisition_planned",
    stateTo: "step_planned",
    actorId: "fake-operator",
    commandId: "provision",
    operationId: "op-env-planned",
  });
  const provisionEvent = ctx.lifecycle.append({
    eventType: "subject_acquisition_started",
    stateTo: "step_started",
    actorId: "fake-operator",
    commandId: "provision",
    operationId: "op-env-started",
    produced: [
      {
        artifact_role: "environment-driver-manifest",
        artifact_core_hash: driverManifest.hash,
        artifact_schema_version: "environment-driver-manifest/v1",
      },
      {
        artifact_role: "environment-resource-inventory",
        artifact_core_hash: inventory.hash,
        artifact_schema_version: "environment-resource-inventory/v1",
      },
      {
        artifact_role: "environment-baseline",
        artifact_core_hash: baselinePublished.hash,
        artifact_schema_version: "environment-baseline-fingerprint/v1",
      },
    ],
  });

  // --- restoration fails --------------------------------------------------
  const restoreReceipt = driver.restore({ runId, operationId: "op-restore" });
  const restorePublished = publish(ctx, "retained/environment-restore-receipt.json", restoreReceipt);
  const findingBase = {
    schema_version: "finding/v1" as const,
    kind: "lab_invalidity" as const,
    finding_id: "lab-restoration-failure",
    run_id: runId,
    severity: "critical" as const,
    proof_refs: [restorePublished.hash],
    safe_summary: "Environment restoration failed; the run is Lab-invalid and no subject attribution is possible.",
    owner: "lab" as const,
    category: "lab_restoration_failure" as const,
    failed_gate_ids: ["environment-restoration"],
    subject_attribution_proven: false as const,
    scoreable_planes: [] as const,
  };
  const finding = publish(ctx, "retained/lab-restoration-finding.json", {
    ...findingBase,
    core_hash: coreHash(findingBase),
  });
  assertContract("LabInvalidityV1", { ...findingBase, core_hash: finding.hash });

  const failureEvent = ctx.lifecycle.append({
    eventType: "environment_restoration_failed",
    stateTo: "invalid_failure_detected",
    actorId: "fake-operator",
    commandId: "restore",
    operationId: "op-restore-failed",
    produced: [
      {
        artifact_role: "primary-finding",
        artifact_core_hash: finding.hash,
        artifact_schema_version: "finding/v1",
      },
      {
        artifact_role: "environment-operation-receipt",
        artifact_core_hash: restorePublished.hash,
        artifact_schema_version: "environment-operation-receipt/v1",
      },
    ],
    failure: {
      code: "RESTORATION_FAILED",
      owner: "lab",
      message: "environment restoration receipt reported failure",
    },
  });

  // --- freeze the frontier, then attempt every independently safe action ---
  ctx.lifecycle.append({
    eventType: "invalid_environment_cleanup_started",
    stateTo: "invalid_environment_cleanup_started",
    actorId: "fake-operator",
    commandId: "cleanup",
    operationId: "op-invalid-env-cleanup",
  });

  const frontier = freezeResourceFrontier({
    runId,
    environmentInstanceHash: provisioned.environmentInstanceHash,
    driverManifestHash: driverManifest.hash,
    trigger: "restoration_failure",
    observedResources: driver.inspect(runId).resources,
    frozenAt: ctx.clock.now(),
  });
  assertFrontierActionsDerivable(frontier);
  const frontierPublished = publish(ctx, "retained/environment-resource-frontier.json", frontier);

  const frontierEvent = ctx.lifecycle.append({
    eventType: "emergency_cleanup_started",
    stateTo: "emergency_cleanup_started",
    actorId: "fake-operator",
    commandId: "cleanup",
    operationId: "op-emergency-start",
    produced: [
      {
        artifact_role: "environment-resource-frontier",
        artifact_core_hash: frontierPublished.hash,
        artifact_schema_version: "environment-resource-frontier/v1",
      },
    ],
  });

  // Every independently safe action is attempted and receipted; every unsafe
  // one is skipped with a reason and no receipt.
  const attemptHashes: Hash[] = [];
  const actions = frontier.derived_actions.map((action) => {
    if (!action.independently_safe) {
      return {
        action_id: action.action_id,
        kind: action.kind,
        independently_safe: false as const,
        status: "skipped_unsafe" as const,
        reason_code: action.unsafe_reason_code ?? "UNSAFE",
      };
    }
    const receiptBase = {
      schema_version: "environment-operation-receipt/v1" as const,
      run_id: runId,
      operation: "destroy" as const,
      operation_id: action.action_id,
      idempotency_key: coreHash({ run: runId, action: action.action_id }).slice("sha256:".length),
      driver_manifest_hash: driverManifest.hash,
      target_identity_hash: h(`target-${action.target_resource_id}`),
      before_state_hash: h(`before-${action.action_id}`),
      after_state_hash: h(`after-${action.action_id}`),
      status: "succeeded" as const,
      started_at: ctx.clock.now(),
      ended_at: ctx.clock.now(),
    };
    const receipt = publish(ctx, `retained/emergency-receipt-${action.action_id}.json`, {
      ...receiptBase,
      core_hash: coreHash(receiptBase),
    });
    attemptHashes.push(receipt.hash);
    return {
      action_id: action.action_id,
      kind: action.kind,
      independently_safe: true as const,
      status: "succeeded" as const,
      attempt_receipt_hash: receipt.hash,
    };
  });

  const emergencyBase = {
    schema_version: "emergency-cleanup-verification/v1" as const,
    run_id: runId,
    environment_instance_hash: provisioned.environmentInstanceHash,
    trigger: "restoration_failure" as const,
    resource_frontier_event_hash: frontierEvent.core_hash,
    actions,
    all_independently_safe_actions_attempted: true as const,
    remaining_resources: frontier.derived_actions
      .filter((a) => !a.independently_safe)
      .map((a) => ({
        kind: "volume",
        identity_hash: h(`target-${a.target_resource_id}`),
        containment_status: "contained" as const,
      })),
    completed_at: ctx.clock.now(),
  };
  const emergency = publish(ctx, "retained/emergency-cleanup-verification.json", {
    ...emergencyBase,
    core_hash: coreHash(emergencyBase),
  });
  assertContract("EmergencyCleanupVerificationV1", { ...emergencyBase, core_hash: emergency.hash });

  const emergencyEvent = ctx.lifecycle.append({
    eventType: "emergency_cleanup_terminal",
    stateTo: "emergency_cleanup_terminal",
    actorId: "fake-operator",
    commandId: "cleanup",
    operationId: "op-emergency-terminal",
    produced: [
      {
        artifact_role: "emergency-cleanup-verification",
        artifact_core_hash: emergency.hash,
        artifact_schema_version: "emergency-cleanup-verification/v1",
      },
    ],
  });

  const recordBase = {
    schema_version: "invalid-lab-run-record/v1" as const,
    run_id: runId,
    terminal_state: "invalidated" as const,
    failed_phase: {
      kind: "lifecycle_phase" as const,
      phase: "environment_restoration" as const,
      lifecycle_event_hash: failureEvent.core_hash,
    },
    terminal_reason: {
      kind: "classified_failure" as const,
      classification: "cleanup_failure" as const,
      failure_event_hash: failureEvent.core_hash,
      primary_finding_hash: finding.hash,
      invalidity_finding_hash: finding.hash,
    },
    available_evidence: [
      { artifact_role: "acquisition-preregistration", artifact_hash: scaffold.prereg.hash, reached_event_hash: preregEvent?.core_hash as Hash },
      { artifact_role: "acquisition-source-manifest", artifact_hash: scaffold.source.hash, reached_event_hash: preregEvent?.core_hash as Hash },
      { artifact_role: "environment-driver-manifest", artifact_hash: driverManifest.hash, reached_event_hash: provisionEvent.core_hash },
      { artifact_role: "environment-resource-inventory", artifact_hash: inventory.hash, reached_event_hash: provisionEvent.core_hash },
      { artifact_role: "environment-baseline", artifact_hash: baselinePublished.hash, reached_event_hash: provisionEvent.core_hash },
      { artifact_role: "environment-operation-receipt", artifact_hash: restorePublished.hash, reached_event_hash: failureEvent.core_hash },
      { artifact_role: "primary-finding", artifact_hash: finding.hash, reached_event_hash: failureEvent.core_hash },
      { artifact_role: "environment-resource-frontier", artifact_hash: frontierPublished.hash, reached_event_hash: frontierEvent.core_hash },
      { artifact_role: "emergency-cleanup-verification", artifact_hash: emergency.hash, reached_event_hash: emergencyEvent.core_hash },
      ...attemptHashes.map((hash) => ({
        artifact_role: "emergency-attempt-receipt",
        artifact_hash: hash,
        reached_event_hash: emergencyEvent.core_hash,
      })),
    ] as { artifact_role: string; artifact_hash: Hash; reached_event_hash: Hash }[],
    cleanup: {
      variant: "emergency_environment" as const,
      status: "attempted_succeeded" as const,
      attempt_hashes: attemptHashes,
      result_hash: emergency.hash,
    },
    lifecycle_head_hash: ctx.lifecycle.head as Hash,
    invalidated_at: ctx.clock.now(),
  };
  const record = { ...recordBase, core_hash: coreHash(recordBase) };
  assertContract("InvalidLabRunRecordV1", record);
  const published = publish(ctx, "retained/invalid-run-record.json", record);

  ctx.lifecycle.append({
    eventType: "invalid_lab_run_record_frozen",
    stateTo: "invalid_lab_run_record_frozen",
    actorId: "fake-operator",
    commandId: "cleanup",
    operationId: "op-invalid-record",
    produced: [
      {
        artifact_role: "invalid-run-record",
        artifact_core_hash: published.hash,
        artifact_schema_version: "invalid-lab-run-record/v1",
      },
    ],
  });
  ctx.lifecycle.append({
    eventType: "invalidated",
    stateTo: "invalidated",
    actorId: "fake-operator",
    commandId: "cleanup",
    operationId: "op-invalidated",
  });

  const trustPolicy = developmentTrustPolicy(keyring);
  return {
    runId,
    root,
    lifecycle: ctx.lifecycle.all(),
    localTrust: localTrustConfiguration(trustPolicy, keyring, [], h("randomness-registry-head")),
    keyring,
    invalidRecord: record,
    store,
  };
}

export type { LabState };
