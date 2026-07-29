/**
 * The offline verifier derives; it does not read the producer's verdict
 * (review P1-11 and the P2 cluster, ADR-ERL2-024 §4.6).
 *
 * ## What the verifier used to believe
 *
 * `verifyEnvironmentBundle` checked `attestation.lab_validity !== "valid"` — but
 * `lab_validity` is a **schema constant** (`lab_validity: "valid" as const`), so
 * the check is tautological for any well-formed attestation. The retained
 * `EnvironmentValidityResultV1.status`, and the `passed` fields of
 * `EnvironmentRestorationVerificationV1` and `TeardownVerificationV1`, were
 * hash-linked and role-required but never inspected. A terminal whose validity
 * said `invalid` with failed gates, and whose cleanup verdicts were
 * `passed: false`, verified as `valid`.
 *
 * ## How these cases are applied
 *
 * Each mutation is applied to the **object the derivation reads**, not to the
 * retained file. Mutating the file is caught first by the hash layer — every
 * one of these artifacts is cited by core hash from the run record or the
 * lifecycle, so an edit surfaces as `ARTIFACT_HASH_MISMATCH` or
 * `GRAPH_CLOSURE_UNREACHABLE_ARTIFACT` and the semantic rule under test never
 * runs. The brief is explicit that a case must not pass because an unrelated
 * check fired first.
 *
 * The end-to-end wiring — that these derivations are actually reached by
 * `erl2 verify` — is asserted by the first test, which drives a real run and
 * verifies its real bundle.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ArtifactIndex,
  assertCleanupApplicable,
  assertSubstrateBindingConsistent,
  deriveRestorationOutcome,
  deriveTeardownOutcome,
  deriveValidityOutcome,
} from "@erl2/public-verifier";
import type {
  EnvironmentRestorationVerificationV1,
  EnvironmentValidityResultV1,
  InvalidLabRunRecordV1,
  LabLifecycleEventV1,
  TeardownVerificationV1,
} from "@erl2/contracts";
import { erl2, verifyBundle, writeLifecycle } from "../support/cliRun.js";
import { drive, selectedRun, type EnvironmentRun } from "../support/environmentCli.js";

function finalizedRun(): EnvironmentRun {
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");
  return run;
}

function retained<T>(run: EnvironmentRun, relative: string): T {
  return JSON.parse(readFileSync(path.join(run.runRoot, "retained", relative), "utf8")) as T;
}

function lifecycle(run: EnvironmentRun): readonly LabLifecycleEventV1[] {
  return JSON.parse(readFileSync(writeLifecycle(run.runRoot), "utf8")) as LabLifecycleEventV1[];
}

function refusalCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

test("VERIFIER-DERIVE: a real environment bundle verifies, and the derivations are reached", () => {
  const run = finalizedRun();
  const verified = verifyBundle(run.runRoot, {
    sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
  });
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  assert.equal((verified.body.data as { verdict: string }).verdict, "valid");

  // The derivations are reached because the binding is required: a bundle with
  // no substrate binding is refused, and every completed run now has one.
  const index = ArtifactIndex.scan(run.runRoot);
  const report = assertSubstrateBindingConsistent({
    index,
    lifecycle: lifecycle(run),
    runId: run.runId,
  });
  assert.ok(report.binding.substrate_instance_hash.startsWith("sha256:"));
});

test("VERIFIER-DERIVE: a validity result that claims `valid` over a failed gate is refused", () => {
  const run = finalizedRun();
  const index = ArtifactIndex.scan(run.runRoot);
  const validity = retained<EnvironmentValidityResultV1>(run, "validity-result.json");
  assert.equal(refusalCode(() => deriveValidityOutcome({ index, validity, requireValid: true })), undefined);

  const mutated = {
    ...validity,
    gate_results: validity.gate_results.map((gate, i) => (i === 0 ? { ...gate, passed: false } : gate)),
  } as EnvironmentValidityResultV1;
  assert.equal(
    refusalCode(() => deriveValidityOutcome({ index, validity: mutated, requireValid: true })),
    "EVALUATOR_VALIDITY_GATE_FAILED",
  );
});

test("VERIFIER-DERIVE: a status that disagrees with its own gates is refused, on that ground alone", () => {
  // Isolates the status-vs-gates derivation, and it took a negative control to
  // notice that it needed isolating: the "claims valid over a failed gate" case
  // above *also* trips the failed-gate-needs-a-finding rule, so disabling the
  // status check killed nothing and the campaign scored it as not load-bearing.
  //
  // Here every gate passes and the producer says `invalid` with no findings.
  // Only recomputing the verdict from the gates catches that.
  const run = finalizedRun();
  const index = ArtifactIndex.scan(run.runRoot);
  const validity = retained<EnvironmentValidityResultV1>(run, "validity-result.json");
  assert.ok(
    validity.gate_results.every((gate) => gate.passed),
    "a finalized run's gates all pass, which is what makes this mutation isolating",
  );
  const understated = { ...validity, status: "invalid" as const } as EnvironmentValidityResultV1;
  assert.equal(
    refusalCode(() => deriveValidityOutcome({ index, validity: understated, requireValid: false })),
    "EVALUATOR_VALIDITY_GATE_FAILED",
  );
});

test("VERIFIER-DERIVE: a failed gate with no invalidity finding naming it is refused", () => {
  // The other half of P1-3: `invalidityFindingHashes` was a hardcoded `[]`, so a
  // run with any failing gate asserted failure with zero supporting findings.
  const run = finalizedRun();
  const index = ArtifactIndex.scan(run.runRoot);
  const validity = retained<EnvironmentValidityResultV1>(run, "validity-result.json");
  const mutated = {
    ...validity,
    status: "invalid" as const,
    gate_results: validity.gate_results.map((gate, i) => (i === 0 ? { ...gate, passed: false } : gate)),
    invalidity_finding_hashes: [],
  } as EnvironmentValidityResultV1;
  assert.equal(
    refusalCode(() => deriveValidityOutcome({ index, validity: mutated, requireValid: false })),
    "EVALUATOR_VALIDITY_GATE_FAILED",
  );
});

test("VERIFIER-DERIVE: a valid result citing invalidity findings is refused", () => {
  const run = finalizedRun();
  const index = ArtifactIndex.scan(run.runRoot);
  const validity = retained<EnvironmentValidityResultV1>(run, "validity-result.json");
  const someHash = validity.environment_restoration_hash;
  const mutated = { ...validity, invalidity_finding_hashes: [someHash] } as EnvironmentValidityResultV1;
  assert.equal(
    refusalCode(() => deriveValidityOutcome({ index, validity: mutated, requireValid: true })),
    "EVALUATOR_VALIDITY_GATE_FAILED",
  );
});

test("VERIFIER-DERIVE: a restoration `passed` that its own evidence contradicts is refused", () => {
  const run = finalizedRun();
  const index = ArtifactIndex.scan(run.runRoot);
  const restoration = retained<EnvironmentRestorationVerificationV1>(
    run,
    "environment-restoration-verification.json",
  );
  assert.equal(refusalCode(() => deriveRestorationOutcome({ index, restoration })), undefined);

  // Drifted baselines with `passed: true`.
  const drifted = {
    ...restoration,
    baseline_after_hash: `sha256:${"2".repeat(64)}`,
  } as EnvironmentRestorationVerificationV1;
  assert.equal(
    refusalCode(() => deriveRestorationOutcome({ index, restoration: drifted })),
    "RESTORATION_FAILED",
  );
});

test("VERIFIER-DERIVE: a restoration citing no compensation receipt is refused", () => {
  // "Reverted nothing" and "had nothing to revert" must not be the same document
  // (review P1-4).
  const run = finalizedRun();
  const index = ArtifactIndex.scan(run.runRoot);
  const restoration = retained<EnvironmentRestorationVerificationV1>(
    run,
    "environment-restoration-verification.json",
  );
  const stripped = {
    ...restoration,
    compensation_receipt_hashes: [],
  } as EnvironmentRestorationVerificationV1;
  assert.equal(
    refusalCode(() => deriveRestorationOutcome({ index, restoration: stripped })),
    "RESTORATION_FAILED",
  );
});

test("VERIFIER-DERIVE: a teardown `passed` over non-empty residue is refused", () => {
  const run = finalizedRun();
  const teardown = retained<TeardownVerificationV1>(run, "teardown-verification.json");
  assert.equal(refusalCode(() => deriveTeardownOutcome(teardown)), undefined);

  const withResidue = {
    ...teardown,
    checks: teardown.checks.map((check, i) =>
      i === 0
        ? { ...check, residue_count: 1, residue_hashes: [`sha256:${"3".repeat(64)}`] }
        : check,
    ),
  } as TeardownVerificationV1;
  assert.equal(refusalCode(() => deriveTeardownOutcome(withResidue)), "TEARDOWN_FAILED");
});

test("VERIFIER-DERIVE: a teardown whose residue count and list disagree is refused", () => {
  const run = finalizedRun();
  const teardown = retained<TeardownVerificationV1>(run, "teardown-verification.json");
  const inconsistent = {
    ...teardown,
    checks: teardown.checks.map((check, i) => (i === 0 ? { ...check, residue_count: 2 } : check)),
  } as TeardownVerificationV1;
  assert.equal(refusalCode(() => deriveTeardownOutcome(inconsistent)), "RESIDUE_DETECTED");
});

test("VERIFIER-DERIVE: a bundle whose lifecycle names no substrate binding is refused", () => {
  const run = finalizedRun();
  const index = ArtifactIndex.scan(run.runRoot);
  const events = lifecycle(run).map((event) => ({
    ...event,
    produced: event.produced.filter((p) => p.artifact_role !== "substrate-binding"),
  }));
  assert.equal(
    refusalCode(() =>
      assertSubstrateBindingConsistent({ index, lifecycle: events, runId: run.runId }),
    ),
    "ENV_SUBSTRATE_BINDING_MISSING",
  );
});

test("VERIFIER-DERIVE: a binding naming another run is refused", () => {
  const run = finalizedRun();
  const index = ArtifactIndex.scan(run.runRoot);
  assert.equal(
    refusalCode(() =>
      assertSubstrateBindingConsistent({
        index,
        lifecycle: lifecycle(run),
        runId: "019f1af9-b400-7444-8444-4444deadbeef",
      }),
    ),
    "ENV_SUBSTRATE_BINDING_MISMATCH",
  );
});

test("VERIFIER-DERIVE: a cancellation claiming `not_required` over an environment is refused", () => {
  // The offline half of P1-2: the shipped verifier accepted a pre-environment
  // cleanup terminal over a run whose environment was still allocated.
  const run = selectedRun();
  drive(run, 4);
  const cancelled = erl2(["cancel", ...run.base, "--reason", "OPERATOR_STOP"]);
  assert.notEqual(cancelled.exitCode, 0);

  const record = retained<InvalidLabRunRecordV1>(run, "invalid-run-record.json");
  const events = lifecycle(run);
  assert.equal(refusalCode(() => assertCleanupApplicable({ record, lifecycle: events })), undefined);

  const forged = {
    ...record,
    cleanup: { variant: "none" as const, status: "not_required" as const, attempt_hashes: [] },
  } as InvalidLabRunRecordV1;
  assert.equal(
    refusalCode(() => assertCleanupApplicable({ record: forged, lifecycle: events })),
    "EMERGENCY_CLEANUP_INCOMPLETE",
  );
});

test("VERIFIER-DERIVE: a cancellation closing over a pre-environment cleanup is refused", () => {
  const run = selectedRun();
  drive(run, 4);
  assert.notEqual(erl2(["cancel", ...run.base, "--reason", "OPERATOR_STOP"]).exitCode, 0);
  const record = retained<InvalidLabRunRecordV1>(run, "invalid-run-record.json");
  const crossed = {
    ...record,
    cleanup: {
      variant: "pre_environment" as const,
      status: "attempted_succeeded" as const,
      attempt_hashes: [],
      result_hash: record.cleanup.result_hash as string,
    },
  } as InvalidLabRunRecordV1;
  assert.equal(
    refusalCode(() => assertCleanupApplicable({ record: crossed, lifecycle: lifecycle(run) })),
    "GRAPH_CLOSURE_TERMINAL_MISMATCH",
  );
});
