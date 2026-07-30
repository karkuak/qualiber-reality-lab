/**
 * The environment terminal: run record, signer inventory, ordered finalization
 * gate, attestation, bundle and the verifier-derived environment closure
 * (design v2 §12/§14/§16.2/§16.3, Slice 6.5).
 *
 * These tests cover the layer Slice 6.5 added. They do **not** stand in for the
 * §4.4 positive proof: no CLI-driven environment run exists yet, so nothing
 * here produces a valid environment terminal end to end. What they do prove is
 * that the finalizer and the closure refuse everything they are required to
 * refuse — which is the property that keeps the absence of the orchestration
 * safe rather than merely incomplete.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NON_BLIND_DEVELOPMENT_ASSURANCE,
  assertEnvironmentFinalizable,
  buildEnvironmentAttestation,
  buildEnvironmentBundle,
  buildEnvironmentRunRecord,
  buildEnvironmentSignerInventory,
  buildEnvironmentRestoration,
  buildTeardownVerification,
  type EnvironmentRunRecordInput,
} from "@erl2/core";
import {
  ArtifactIndex,
  deriveEnvironmentTerminalStage,
  deriveTerminalVariant,
} from "@erl2/public-verifier";
import type {
  ArtifactRef,
  EnvironmentRestorationVerificationV1,
  GenericEvaluationIndexV1,
  Hash,
  LabLifecycleEventV1,
  TeardownVerificationV1,
  ValidityResultV1,
} from "@erl2/contracts";
import { coreHash, developmentKey } from "@erl2/integrity";

const AT = "2026-07-23T00:00:00Z";
const h = (seed: string): Hash =>
  `sha256:${seed.repeat(64).slice(0, 64)}` as Hash;

function throwsCode(fn: () => unknown, code: string, label = ""): void {
  try {
    fn();
  } catch (error) {
    assert.equal((error as { code?: string }).code, code, `${label}: ${String(error)}`);
    return;
  }
  assert.fail(`${label}: expected refusal ${code}, but nothing was thrown`);
}

function runRecordInput(
  overrides: Partial<EnvironmentRunRecordInput> = {},
): EnvironmentRunRecordInput {
  return {
    runId: "01890000-0000-7000-8000-000000000001",
    terminalStage: "remove",
    acquisitionPreregistrationHash: h("1"),
    acquisitionSourceManifestHash: h("2"),
    acquisitionRecordHash: h("3"),
    subjectPackageManifestHash: h("4"),
    selectionRequestHash: h("5"),
    selectionReceiptHash: h("6"),
    selectedChallengeJourneyBindingHash: h("7"),
    adapterHash: h("8"),
    genericRunPolicyHash: h("9"),
    planHash: h("a"),
    environmentInstanceHash: h("b"),
    subjectOutputHash: h("c"),
    journeyResultHash: h("d"),
    domainResultHash: h("e"),
    precleanupResultJoinHash: h("f"),
    genericEvaluationIndexHash: h("0"),
    environmentRestorationHash: h("ab"),
    teardownHash: h("cd"),
    lifecycleHeadHash: h("ef"),
    ...overrides,
  };
}

function restoration(passed: boolean): EnvironmentRestorationVerificationV1 {
  return buildEnvironmentRestoration({
    runId: "01890000-0000-7000-8000-000000000001",
    environmentInstanceHash: h("b"),
    activationReceiptHashes: [],
    compensationReceiptHashes: [],
    baselineBeforeHash: h("11"),
    // A drifted after-baseline is exactly what a failed restoration looks like;
    // `passed` is derived from the comparison, never supplied.
    baselineAfterHash: passed ? h("11") : h("22"),
    residualResources: [],
    restoredAt: AT,
  });
}

const RUN_ID = "01890000-0000-7000-8000-000000000001";

function teardown(restorationHash: Hash, passed: boolean): TeardownVerificationV1 {
  return buildTeardownVerification({
    runId: RUN_ID,
    environmentInstanceHash: h("b"),
    restorationVerificationHash: restorationHash,
    // `passed` is derived from residue, never supplied: a failing teardown is
    // one that still saw a resource, not one that said so.
    checks: [
      {
        kind: "container",
        selector: `erl2-container-${RUN_ID}`,
        residueHashes: passed ? [] : [h("33")],
      },
    ],
    checkedAt: AT,
  });
}

const VALID_VALIDITY = {
  schema_version: "environment-validity-result/v1",
  core_hash: h("77"),
  run_id: "01890000-0000-7000-8000-000000000001",
  status: "valid",
  generic_run_policy_hash: h("9"),
} as unknown as ValidityResultV1;

const INDEX = {
  schema_version: "generic-evaluation-index/v1",
  core_hash: h("88"),
  validity_result_hash: h("77"),
} as unknown as GenericEvaluationIndexV1;

function preconditions(overrides: Record<string, unknown> = {}) {
  const rest = restoration(true);
  return {
    validity: VALID_VALIDITY,
    genericEvaluationIndex: INDEX,
    restoration: rest,
    teardown: teardown(rest.core_hash, true),
    residueAfterTeardown: [],
    derivedClosureVerdict: "valid" as const,
    derivedMissingRoles: [] as string[],
    derivedExtraHashes: [] as Hash[],
    exposureEventHash: h("99") as Hash | undefined,
    signerInventoryComplete: true,
    trustVerifiedAtCreation: true,
    timestampCheckpointsAcyclic: true,
    ...overrides,
  };
}

// -- 1. the run record -------------------------------------------------------

test("ENV-RECORD: the capture group is all-or-nothing", () => {
  // Neither: a journey that terminated before capture.
  const withoutCapture = buildEnvironmentRunRecord(runRecordInput());
  assert.equal(withoutCapture.schema_version, "environment-lab-run-record/v1");
  assert.equal(withoutCapture.observation_hash, undefined);

  // All three: a journey that reached capture.
  const withCapture = buildEnvironmentRunRecord(
    runRecordInput({
      observationHash: h("aa"),
      canonicalEvidenceEnvelopeHash: h("bb"),
      adapterTranslationReceiptHash: h("cc"),
    }),
  );
  assert.equal(withCapture.observation_hash, h("aa"));

  // Any partial combination is refused: a translation receipt without the
  // envelope it translated would be an ancestor nothing can cite.
  for (const partial of [
    { observationHash: h("aa") },
    { canonicalEvidenceEnvelopeHash: h("bb") },
    { observationHash: h("aa"), adapterTranslationReceiptHash: h("cc") },
  ]) {
    throwsCode(
      () => buildEnvironmentRunRecord(runRecordInput(partial)),
      "GRAPH_CLOSURE_MISSING_ROLE",
      JSON.stringify(Object.keys(partial)),
    );
  }
});

test("ENV-RECORD: the environment record requires the members the pre-environment branch forbids", () => {
  const record = buildEnvironmentRunRecord(runRecordInput());
  // §16.3: the environment branch is defined by what the pre-environment
  // branch cannot carry.
  for (const member of [
    "subject_package_manifest_hash",
    "selection_receipt_hash",
    "selected_challenge_journey_binding_hash",
    "plan_hash",
    "environment_instance_hash",
    "environment_restoration_hash",
    "teardown_hash",
  ] as const) {
    assert.ok(record[member] !== undefined, `${member} is mandatory on the environment branch`);
  }
  // And it has no pre-environment cleanup member at all.
  assert.equal(
    (record as unknown as Record<string, unknown>)["pre_environment_cleanup_hash"],
    undefined,
  );
});

// -- 2. the signer inventory -------------------------------------------------

test("ENV-INVENTORY: the two public terminal types are excluded and cannot be smuggled in", () => {
  const entry = {
    artifactSchemaVersion: "environment-restoration-verification/v1",
    artifactCoreHash: h("ab"),
    signerKeyId: developmentKey("finalizer").keyId,
    signatureSha256: h("dd"),
    securityTimestamp: AT as `${string}Z`,
    timestampLogId: "erl2-development-log",
    timestampSequence: 1,
  };
  const inventory = buildEnvironmentSignerInventory({
    inventoryId: "inv-env",
    runId: "01890000-0000-7000-8000-000000000001",
    selectionCommitmentHash: h("5"),
    entries: [entry],
    completeForTerminalChain: true,
    inventoriedAt: AT,
    signingKey: developmentKey("finalizer"),
  });
  assert.deepEqual(inventory.excluded_public_terminal_types, [
    "selection-verification-receipt/v2",
    "environment-final-lab-attestation/v1",
  ]);
  assert.equal(inventory.terminal_variant, "environment");

  for (const excluded of [
    "selection-verification-receipt/v2",
    "environment-final-lab-attestation/v1",
  ]) {
    throwsCode(
      () =>
        buildEnvironmentSignerInventory({
          inventoryId: "inv-env",
          runId: "01890000-0000-7000-8000-000000000001",
          selectionCommitmentHash: h("5"),
          entries: [{ ...entry, artifactSchemaVersion: excluded }],
          completeForTerminalChain: true,
          inventoriedAt: AT,
          signingKey: developmentKey("finalizer"),
        }),
      "INVENTORY_ENTRY_EXTRA",
      excluded,
    );
  }

  throwsCode(
    () =>
      buildEnvironmentSignerInventory({
        inventoryId: "inv-env",
        runId: "01890000-0000-7000-8000-000000000001",
        selectionCommitmentHash: h("5"),
        entries: [],
        completeForTerminalChain: true,
        inventoriedAt: AT,
        signingKey: developmentKey("finalizer"),
      }),
    "INVENTORY_ENTRY_MISSING",
    "an empty inventory",
  );

  // ADR-ERL2-030 §4.3: a derivation that could not establish completeness does
  // not produce a weaker inventory, because the schema pins the field to `true`.
  // It refuses — before any signature exists.
  throwsCode(
    () =>
      buildEnvironmentSignerInventory({
        inventoryId: "inv-env",
        runId: "01890000-0000-7000-8000-000000000001",
        selectionCommitmentHash: h("5"),
        entries: [entry],
        completeForTerminalChain: false,
        inventoriedAt: AT,
        signingKey: developmentKey("finalizer"),
      }),
    "INVENTORY_ENTRY_MISSING",
    "an inventory the derivation could not certify complete",
  );
});

// -- 3. the ordered finalization gate ---------------------------------------

test("ENV-FINALIZE: the honest path passes the gate", () => {
  assertEnvironmentFinalizable(preconditions());
});

test("ENV-FINALIZE: restoration failure never reaches a valid terminal", () => {
  const failed = restoration(false);
  assert.equal(failed.passed, false, "a drifted after-baseline is a failed restoration");
  throwsCode(
    () =>
      assertEnvironmentFinalizable(
        preconditions({ restoration: failed, teardown: teardown(failed.core_hash, true) }),
      ),
    "RESTORATION_FAILED",
    "failed restoration",
  );
});

test("ENV-FINALIZE: teardown failure never reaches a valid terminal", () => {
  const rest = restoration(true);
  throwsCode(
    () =>
      assertEnvironmentFinalizable(
        preconditions({ restoration: rest, teardown: teardown(rest.core_hash, false) }),
      ),
    "TEARDOWN_FAILED",
    "failed teardown",
  );
});

test("ENV-FINALIZE: a teardown bound to a different restoration is refused", () => {
  const rest = restoration(true);
  throwsCode(
    () =>
      assertEnvironmentFinalizable(
        preconditions({ restoration: rest, teardown: teardown(h("ff"), true) }),
      ),
    "GRAPH_CLOSURE_TERMINAL_MISMATCH",
    "teardown of another restoration",
  );
});

test("ENV-FINALIZE: residue observed after teardown is refused independently of what teardown said", () => {
  // Teardown itself passed. The residue check is a *separate* observation, so a
  // driver that reported success while leaving a resource behind is still
  // caught.
  throwsCode(
    () =>
      assertEnvironmentFinalizable(
        preconditions({ residueAfterTeardown: [{ identity_hash: h("ee") }] }),
      ),
    "RESIDUE_DETECTED",
    "residue after a passing teardown",
  );
});

test("ENV-FINALIZE: a missing exposure event is refused", () => {
  // Unlike the pre-environment branch, an environment run really did open a
  // selected challenge, so the honest state is a recorded event.
  throwsCode(
    () => assertEnvironmentFinalizable(preconditions({ exposureEventHash: undefined })),
    "BUNDLE_FINALIZED_BEFORE_EXPOSURE",
    "no exposure event",
  );
});

test("ENV-FINALIZE: an invalid validity result never reaches the generic index", () => {
  throwsCode(
    () =>
      assertEnvironmentFinalizable(
        preconditions({
          validity: { ...VALID_VALIDITY, status: "invalid" } as unknown as ValidityResultV1,
        }),
      ),
    "EVALUATOR_INVALID_VALIDITY_IN_GENERIC_INDEX",
    "invalid validity",
  );
});

test("ENV-FINALIZE: a stale index, a missing role, an extra artifact or an invalid closure all refuse", () => {
  throwsCode(
    () =>
      assertEnvironmentFinalizable(
        preconditions({
          genericEvaluationIndex: {
            ...INDEX,
            validity_result_hash: h("aa"),
          } as unknown as GenericEvaluationIndexV1,
        }),
      ),
    "EVALUATOR_STALE_RESULT_HASH",
    "index bound to another validity result",
  );
  throwsCode(
    () => assertEnvironmentFinalizable(preconditions({ derivedMissingRoles: ["execution-plan"] })),
    "GRAPH_CLOSURE_MISSING_ROLE",
    "missing derived role",
  );
  throwsCode(
    () => assertEnvironmentFinalizable(preconditions({ derivedExtraHashes: [h("dd")] })),
    "GRAPH_CLOSURE_EXTRA_ARTIFACT",
    "unaccounted retained artifact",
  );
  throwsCode(
    () => assertEnvironmentFinalizable(preconditions({ derivedClosureVerdict: "invalid" })),
    "GRAPH_CLOSURE_TERMINAL_MISMATCH",
    "invalid derived closure",
  );
});

test("ENV-FINALIZE: trust and timestamp closure gate the signature", () => {
  throwsCode(
    () => assertEnvironmentFinalizable(preconditions({ trustVerifiedAtCreation: false })),
    "BUNDLE_FINALIZED_BEFORE_TRUST_CLOSURE",
    "unverified trust",
  );
  throwsCode(
    () => assertEnvironmentFinalizable(preconditions({ timestampCheckpointsAcyclic: false })),
    "TIMESTAMP_SELF_REFERENCE",
    "cyclic checkpoints",
  );
});

// -- 4. attestation and bundle ----------------------------------------------

function ref(name: string): ArtifactRef {
  return {
    path: `retained/${name}.json`,
    media_type: "application/json",
    byte_length: 32,
    file_sha256: h("12"),
    classification: "PUBLIC",
  };
}

test("ENV-ATTESTATION: the attestation carries the environment cleanup pair and a non-blind assurance", () => {
  const attestation = buildEnvironmentAttestation({
    attestationId: "att-env",
    runId: "01890000-0000-7000-8000-000000000001",
    runRecordHash: h("13"),
    acquisitionPreregistrationVerificationReceiptHash: h("14"),
    selectionReceiptHash: h("6"),
    signerInventoryHash: h("15"),
    timestampCheckpointHash: h("16"),
    runTrustPolicyHash: h("17"),
    acquisitionSourceManifestHash: h("2"),
    acquisitionRecordHash: h("3"),
    subjectPackageManifestHash: h("4"),
    adapterHash: h("8"),
    genericRunPolicyHash: h("9"),
    genericEvaluationIndexHash: h("88"),
    environmentRestorationHash: h("ab"),
    teardownHash: h("cd"),
    exposureEventHash: h("99"),
    selectionAssurance: NON_BLIND_DEVELOPMENT_ASSURANCE,
    claimScope: "T1",
    finalizedAt: AT,
    signingKey: developmentKey("finalizer"),
  });
  assert.equal(attestation.terminal_variant, "environment");
  assert.equal(attestation.lab_validity, "valid");
  assert.equal(attestation.cleanup.kind, "environment");
  assert.equal(attestation.cleanup.restoration_hash, h("ab"));
  assert.equal(attestation.cleanup.teardown_hash, h("cd"));
  // ERL2-OQ-007 is unresolved, so the only representable assurance says plainly
  // that no blindness is claimed.
  assert.equal(attestation.selection_assurance.mode, "non_blind_development");
  assert.equal(attestation.selection_assurance.blindness_claim, "none");
});

test("ENV-BUNDLE: the bundle is a container of evidence, never an execution body", () => {
  const bundle = buildEnvironmentBundle({
    bundleId: "bundle-env",
    runId: "01890000-0000-7000-8000-000000000001",
    finalAttestation: { artifact: ref("final-attestation"), coreHash: h("18") },
    acquisitionPreregistrationVerificationReceipt: {
      artifact: ref("receipt"),
      coreHash: h("14"),
    },
    selectionVerificationReceipt: { artifact: ref("selection-receipt"), coreHash: h("6") },
    signerInventory: { artifact: ref("signer-inventory"), coreHash: h("15") },
    runTrustPolicy: { artifact: ref("trust-policy"), coreHash: h("17") },
    selectedRunTimestampCheckpointChain: [{ artifact: ref("checkpoint"), coreHash: h("16") }],
    createdAt: AT,
  });
  assert.equal(bundle.terminal_variant, "environment");
  assert.equal(bundle.execution_verification_mode, "finalizer_verdict_only");
  assert.deepEqual(bundle.execution_artifacts, []);
  assert.equal(bundle.verification_trust_head_source, "local_root_pinned_configuration");
  // The selection receipt is what lets an offline reader check that the
  // challenge answered is the one the protocol selected.
  assert.equal(bundle.selection_verification_receipt.artifact_core_hash, h("6"));

  throwsCode(
    () =>
      buildEnvironmentBundle({
        bundleId: "bundle-env",
        runId: "01890000-0000-7000-8000-000000000001",
        finalAttestation: { artifact: ref("final-attestation"), coreHash: h("18") },
        acquisitionPreregistrationVerificationReceipt: {
          artifact: ref("receipt"),
          coreHash: h("14"),
        },
        selectionVerificationReceipt: { artifact: ref("selection-receipt"), coreHash: h("6") },
        signerInventory: { artifact: ref("signer-inventory"), coreHash: h("15") },
        runTrustPolicy: { artifact: ref("trust-policy"), coreHash: h("17") },
        selectedRunTimestampCheckpointChain: [],
        createdAt: AT,
      }),
    "BUNDLE_MEMBER_MISSING",
    "a bundle with no timestamp checkpoint",
  );
});

// -- 5. the verifier-derived environment closure ----------------------------

function event(type: string): LabLifecycleEventV1 {
  return { event_type: type, produced: [] } as unknown as LabLifecycleEventV1;
}

test("ENV-CLOSURE: the terminal stage is derived from the step submachine, never read", () => {
  assert.equal(
    deriveEnvironmentTerminalStage([
      event("subject_install_outcome_frozen"),
      event("subject_connection_outcome_frozen"),
      event("subject_uninstall_outcome_frozen"),
    ]),
    "remove",
  );
  assert.equal(
    deriveEnvironmentTerminalStage([event("subject_interaction_outcome_frozen")]),
    "exercise",
  );
  // A pre-environment-only lifecycle derives no environment stage at all.
  throwsCode(
    () =>
      deriveEnvironmentTerminalStage([
        event("subject_acquisition_outcome_frozen"),
        event("subject_package_verification_outcome_frozen"),
      ]),
    "GRAPH_CLOSURE_TERMINAL_MISMATCH",
    "a pre-environment lifecycle",
  );
});

test("ENV-CLOSURE: the terminal variant is derived from the retained record, not the bundle's claim", () => {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-env-closure-"));
  mkdirSync(path.join(root, "retained"), { recursive: true });

  // Nothing retained yet: a run with no environment record reads as
  // pre-environment, which is the safe default.
  assert.equal(deriveTerminalVariant(ArtifactIndex.scan(root)), "pre_environment");

  const record = buildEnvironmentRunRecord(runRecordInput());
  writeFileSync(
    path.join(root, "retained", "run-record.json"),
    JSON.stringify(record),
  );
  assert.equal(deriveTerminalVariant(ArtifactIndex.scan(root)), "environment");

  // Both variants retained at once is a crossover, not a choice.
  const preEnvironment = {
    schema_version: "pre-environment-lab-run-record/v1",
    core_hash: "",
  } as Record<string, unknown>;
  preEnvironment["core_hash"] = coreHash({
    ...preEnvironment,
    core_hash: undefined,
  });
  // Write a minimally-shaped second record; the derivation refuses on schema
  // version alone, before any contract validation.
  const body = { schema_version: "pre-environment-lab-run-record/v1", run_id: "x" };
  writeFileSync(
    path.join(root, "retained", "pre-env-record.json"),
    JSON.stringify({ ...body, core_hash: coreHash(body) }),
  );
  throwsCode(
    () => deriveTerminalVariant(ArtifactIndex.scan(root)),
    "GRAPH_CLOSURE_TERMINAL_MISMATCH",
    "both terminal variants retained",
  );
});

// -- 6. teardown residue observation ----------------------------------------

test("ENV-TEARDOWN: a wildcard or foreign selector is refused, not narrowed", () => {
  const base = {
    runId: "01890000-0000-7000-8000-000000000001",
    environmentInstanceHash: h("b"),
    restorationVerificationHash: h("ab"),
    checkedAt: AT,
  } as const;
  for (const selector of [
    "*",
    "erl2-container-*",
    "erl2-container-01890000-0000-7000-8000-00000000000?",
    "   ",
    "erl2-container-some-other-run",
  ]) {
    throwsCode(
      () =>
        buildTeardownVerification({
          ...base,
          checks: [{ kind: "container", selector, residueHashes: [] }],
        }),
      "ENV_BROAD_DELETE_REJECTED",
      selector,
    );
  }
});

test("ENV-TEARDOWN: passed is derived from residue, so a clean claim over residue is unrepresentable", () => {
  const clean = teardown(h("ab"), true);
  assert.equal(clean.passed, true);
  assert.equal(clean.checks[0]?.residue_count, 0);

  const dirty = teardown(h("ab"), false);
  assert.equal(dirty.passed, false, "an inspection that saw residue cannot report a clean teardown");
  assert.equal(dirty.checks[0]?.residue_count, 1);
  // The count is computed from the evidence, so the two cannot disagree.
  assert.equal(dirty.checks[0]?.residue_hashes.length, dirty.checks[0]?.residue_count);
});

test("ENV-TEARDOWN: an uninspected teardown proves nothing and is refused", () => {
  throwsCode(
    () =>
      buildTeardownVerification({
        runId: "01890000-0000-7000-8000-000000000001",
        environmentInstanceHash: h("b"),
        restorationVerificationHash: h("ab"),
        checks: [],
        checkedAt: AT,
      }),
    "RESIDUE_DETECTED",
    "zero residue inspections",
  );
});
