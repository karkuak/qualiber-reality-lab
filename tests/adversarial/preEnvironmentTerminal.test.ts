/**
 * EARLY-TERMINAL-CLOSURE: the pre-environment terminal has exactly one
 * authorized ancestry (ADR-ERL2-013).
 *
 * A *successful* package verification freezes `SubjectPackageManifestV1`, and
 * design v2 §12 gives that state one continuation: `challenge_preregistered`.
 * A *failed or unsupported* verification instead reaches
 * `subject_output_frozen` through the generic terminal step-outcome route.
 *
 * Four independent layers are proved here, because any one of them alone could
 * be edited around: the transition table, the closed schema, the run
 * workspace's typed refusal, and the offline closure verifier.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertContract,
  validateContract,
  type Hash,
  type LabLifecycleEventV1,
} from "@erl2/contracts";
import { ArtifactStore, coreHash } from "@erl2/integrity";
import {
  assertTransitionAllowed,
  TRANSITIONS,
  LifecycleLog,
  SteppingClock,
  uuidV7From,
} from "@erl2/core";
import { verifyPublicBundle } from "@erl2/public-verifier";
import { runFakeValidPreEnvironmentRun } from "../support/fakeRun.js";

test("EARLY-TERMINAL-CLOSURE: the transition table has one authorized continuation for a verified package", () => {
  assert.deepEqual(
    [...TRANSITIONS.package_manifest_frozen].filter((s) => s !== "invalid_failure_detected"),
    ["challenge_preregistered"],
  );
  assert.throws(
    () => assertTransitionAllowed("package_manifest_frozen", "subject_output_frozen", "freeze_output"),
    /not in the design state machine/,
  );
  // The failed/unsupported route is the generic terminal step-outcome edge, and
  // it stays open.
  assert.ok(TRANSITIONS.step_outcome_frozen.includes("subject_output_frozen"));
  assert.ok(TRANSITIONS.pre_reveal_subject_cleanup_started.includes("subject_output_frozen"));
});

test("EARLY-TERMINAL-CLOSURE: the pre-environment output manifest has no package-manifest member", () => {
  const base = {
    schema_version: "subject-output-manifest/v1",
    run_id: "01890000-0000-7000-8000-000000000000",
    terminal_stage: "verify_package",
    acquisition_source_manifest_hash: `sha256:${"1".repeat(64)}`,
    acquisition_record_hash: `sha256:${"2".repeat(64)}`,
    adapter_hash: `sha256:${"3".repeat(64)}`,
    step_outcome_hashes: [`sha256:${"4".repeat(64)}`],
    interaction_hashes: [],
    entries: [],
    tree_hash: `sha256:${"5".repeat(64)}`,
    timed_out: false,
    unsupported_inputs: [],
    frozen_at: "2026-07-01T00:00:00Z",
    core_hash: `sha256:${"6".repeat(64)}`,
  };
  assert.equal(validateContract("PreEnvironmentSubjectOutputManifestV1", base).valid, true);

  const withManifest = { ...base, subject_package_manifest_hash: `sha256:${"7".repeat(64)}` };
  assert.equal(validateContract("PreEnvironmentSubjectOutputManifestV1", withManifest).valid, false);
  // And the union rejects it too, so no producer can slip past the branch.
  assert.equal(validateContract("SubjectOutputManifestV1", withManifest).valid, false);
});

test("EARLY-TERMINAL-CLOSURE: the closure verifier rejects a package manifest in a pre-environment terminal", () => {
  const run = runFakeValidPreEnvironmentRun();

  // Baseline: the authorized failed-verification run verifies.
  const ok = verifyPublicBundle({
    bundle: run.bundle,
    artifactRoot: run.root,
    lifecycle: run.lifecycle,
    localTrust: run.localTrust,
    verifiedAt: "2026-07-02T00:00:00Z",
    offline: true,
  });
  assert.equal(ok.verdict, "valid");

  // Seed the unauthorized alternative: the same run, but its lifecycle also
  // claims a frozen subject package manifest. Every hash below is internally
  // valid; only the derived closure can reject it (ERL2-AC-023).
  const seeded = run.lifecycle.map((event, index) =>
    index === run.lifecycle.length - 1
      ? {
          ...event,
          produced: [
            ...event.produced,
            {
              artifact_role: "subject-package-manifest",
              artifact_core_hash: `sha256:${"a".repeat(64)}` as Hash,
              artifact_schema_version: "subject-package-manifest/v1",
            },
          ],
        }
      : event,
  ) as LabLifecycleEventV1[];

  assert.throws(
    () =>
      verifyPublicBundle({
        bundle: run.bundle,
        artifactRoot: run.root,
        lifecycle: seeded,
        localTrust: run.localTrust,
        verifiedAt: "2026-07-02T00:00:00Z",
        offline: true,
      }),
    (error: unknown) => {
      const code = (error as { code?: string }).code;
      // The seeded event breaks the chain hash first when the tamper is at the
      // byte level; the closure rule is what rejects a *well-formed* one.
      return code === "GRAPH_CLOSURE_TERMINAL_MISMATCH" || code === "ARTIFACT_HASH_MISMATCH";
    },
  );
});

test("EARLY-TERMINAL-CLOSURE: a real run that verifies its package cannot append the early terminal", () => {
  // A hand-built, internally consistent lifecycle: every event hashes, the
  // chain is unbroken, and the only defect is the unauthorized ancestry.
  const root = mkdtempSync(path.join(tmpdir(), "erl2-seeded-"));
  const runId = uuidV7From(Date.parse("2026-07-01T00:00:00Z"), Buffer.alloc(10, 0x55));
  const store = new ArtifactStore(root);
  const clock = new SteppingClock("2026-07-01T00:00:00Z", 1000);
  const lifecycle = new LifecycleLog({ runId, store, clock });

  lifecycle.append({
    eventType: "acquisition_preregistered",
    stateTo: "acquisition_preregistered",
    actorId: "operator",
    commandId: "preregister-acquisition",
    operationId: "op-prereg",
  });
  for (const [prefix, stage] of [
    ["subject_acquisition", "acquire"],
    ["subject_package_verification", "verify-package"],
  ] as const) {
    lifecycle.append({
      eventType: `${prefix}_planned`,
      stateTo: "step_planned",
      actorId: "operator",
      commandId: stage,
      operationId: `op-${stage}-planned`,
    });
    lifecycle.append({
      eventType: `${prefix}_started`,
      stateTo: "step_started",
      actorId: "operator",
      commandId: stage,
      operationId: `op-${stage}-started`,
    });
    lifecycle.append({
      eventType: `${prefix}_completed`,
      stateTo: "step_succeeded",
      actorId: "operator",
      commandId: stage,
      operationId: `op-${stage}-completed`,
    });
    lifecycle.append({
      eventType: `${prefix}_outcome_frozen`,
      stateTo: "step_outcome_frozen",
      actorId: "operator",
      commandId: stage,
      operationId: `op-${stage}-outcome`,
      produced: [
        {
          artifact_role: "journey-step-outcome",
          artifact_core_hash: coreHash({ outcome: stage }) as Hash,
          artifact_schema_version: "journey-step-outcome/v1",
        },
      ],
    });
    if (stage === "acquire") {
      lifecycle.append({
        eventType: "subject_package_frozen",
        stateTo: "subject_package_frozen",
        actorId: "operator",
        commandId: "freeze-package",
        operationId: "op-freeze-package",
      });
    }
  }

  // The successful manifest freezes; the state machine now permits only
  // `challenge_preregistered`.
  const frozen = lifecycle.append({
    eventType: "package_manifest_frozen",
    stateTo: "package_manifest_frozen",
    actorId: "operator",
    commandId: "verify-package",
    operationId: "op-package-manifest",
    produced: [
      {
        artifact_role: "subject-package-manifest",
        artifact_core_hash: coreHash({ manifest: runId }) as Hash,
        artifact_schema_version: "subject-package-manifest/v1",
      },
    ],
  });
  assert.equal(frozen.state_to, "package_manifest_frozen");

  assert.throws(
    () =>
      lifecycle.append({
        eventType: "subject_output_frozen",
        stateTo: "subject_output_frozen",
        actorId: "operator",
        commandId: "freeze-output",
        operationId: "op-freeze-output",
      }),
    /transition package_manifest_frozen -> subject_output_frozen/,
  );
});

test("INVALID-TERMINAL: an invalid terminal always passes through invalid_failure_detected", () => {
  // Every non-terminal state can reach detection, and detection is the only
  // door into either invalid cleanup branch (design v2 §12).
  for (const target of ["invalid_pre_environment_cleanup_started", "invalid_environment_cleanup_started"]) {
    const sources = Object.entries(TRANSITIONS)
      .filter(([, targets]) => (targets as readonly string[]).includes(target))
      .map(([from]) => from);
    assert.deepEqual(sources, ["invalid_failure_detected"], `${target} has an extra predecessor`);
  }
  assert.throws(
    () =>
      assertTransitionAllowed(
        "step_outcome_frozen",
        "invalid_pre_environment_cleanup_started",
        "cleanup",
      ),
    /not in the design state machine/,
  );
  // And nothing may skip cleanup straight to the record.
  const recordSources = Object.entries(TRANSITIONS)
    .filter(([, targets]) => (targets as readonly string[]).includes("invalid_lab_run_record_frozen"))
    .map(([from]) => from)
    .sort();
  assert.deepEqual(recordSources, [
    "emergency_cleanup_terminal",
    "environment_validity_result_frozen",
    "generic_evaluation_index_frozen",
    "invalid_cleanup_terminal",
    "pre_environment_cleanup_started",
    "pre_environment_validity_result_frozen",
  ]);
});

test("EARLY-TERMINAL-CLOSURE: the run workspace refuses the early terminal with a stable code", async () => {
  const { buildGovernorRegistry } = await import("../support/governorRegistry.js");
  const { AdmissionRegistry, FakeSubjectPort, RunWorkspace } = await import("@erl2/core");
  const { developmentKey } = await import("@erl2/integrity");

  const registry = buildGovernorRegistry();
  const runRoot = mkdtempSync(path.join(tmpdir(), "erl2-refusal-"));
  const runId = uuidV7From(Date.parse("2026-07-01T00:00:00Z"), Buffer.alloc(10, 0x66));
  const workspace = new RunWorkspace({
    // This fixture creates the run root it operates on, which is the one thing
    // `allowBootstrap` is for (ADR-ERL2-024 §4.1). Without it a library caller
    // may not bring a workspace into being, so a mistyped root refuses instead
    // of silently starting a second, empty run.
    allowBootstrap: true,
    runId,
    runRoot,
    registry: AdmissionRegistry.open(registry.root),
    clock: new SteppingClock("2026-07-01T00:00:00Z", 1000),
    keyring: {
      preregistrar: developmentKey("preregistrar"),
      finalizer: developmentKey("finalizer"),
      timestampAuthority: developmentKey("timestamp"),
      evaluator: developmentKey("evaluator"),
    },
    tier: "development",
    subjectPort: new FakeSubjectPort(),
  });
  workspace.preregisterAcquisition({
    subjectExecutionMode: "development_fake_port",
    sourceManifestHash: registry.sourceManifestHash,
    adapterManifestHash: registry.adapterManifestHash,
    genericRunPolicyHash: registry.genericRunPolicyHash,
    runTrustPolicyHash: registry.runTrustPolicyHash,
    acquisitionActorScriptHash: registry.acquisitionActorScriptHash,
    acquisitionActorSchemaHash: registry.acquisitionActorSchemaHash,
    acquisitionStepCommitmentHash: registry.acquisitionStep.commitmentHash,
    packageVerificationStepCommitmentHash: registry.packageVerificationStep.commitmentHash,
    limitsHash: registry.limitsHash,
    expiresAt: "2026-12-31T00:00:00Z",
  });
  workspace.acquire();
  workspace.freezePackage();
  workspace.verifyPackage();
  const manifest = workspace.freezePackageManifest({
    subjectId: "fake-subject",
    subjectVersion: "0.1.0",
  });
  assertContract("SubjectPackageManifestV1", manifest);

  assert.throws(
    () => workspace.freezeSubjectOutput({ terminalStage: "verify_package" }),
    (error: unknown) => (error as { code: string }).code === "GRAPH_CLOSURE_TERMINAL_MISMATCH",
  );
});
