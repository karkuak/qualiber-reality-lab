/**
 * The pinned environment-terminal golden (Slice 6.5-E).
 *
 * `fixtures/golden/environment-run/closure-summary.json` is produced by driving
 * the shipped CLI from preregistration to `generic_finalized` and then verifying
 * the resulting bundle offline. It pins the **shape** of that milestone, not its
 * bytes.
 *
 * The bytes cannot be pinned and deliberately are not: every eligibility-pool
 * entry is a threshold envelope whose content key, nonce and X25519 ephemerals
 * come from the CSPRNG inside `sealThresholdEnvelope`. Making those derivable is
 * exactly the affordance that would let an observer reconstruct a sealed entry,
 * so the envelope keeps its CSPRNG and this golden keeps to what is genuinely
 * reproducible: the ordered walk, the closure's roles and multiplicities, the
 * derived terminal variant and stage, and the verdict.
 *
 * A regression that drops a role, adds an unaccounted artifact, reorders the
 * walk or changes the verdict fails here. A fresh CSPRNG draw does not.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const summary = JSON.parse(
  readFileSync(
    path.join(repoRoot, "fixtures", "golden", "environment-run", "closure-summary.json"),
    "utf8",
  ),
) as {
  verdict: string;
  derived_terminal_variant: string;
  derived_terminal_phase: string;
  missing_roles: string[];
  rejected_extra_count: number;
  required_roles: { role: string; count: number }[];
  lifecycle_event_types: string[];
  lifecycle_states: string[];
  produced_roles: string[];
  offline_verification: {
    with_pinned_beacon: { exit_code: number };
    without_pinned_beacon: { exit_code: number; code: string | null };
  };
};

test("ENV-GOLDEN: the pinned environment terminal verifies offline as a valid environment variant", () => {
  assert.equal(summary.verdict, "valid");
  assert.equal(summary.derived_terminal_variant, "environment");
  assert.equal(summary.derived_terminal_phase, "remove");
  assert.deepEqual(summary.missing_roles, []);
  assert.equal(summary.rejected_extra_count, 0);
  assert.equal(summary.offline_verification.with_pinned_beacon.exit_code, 0);
});

test("ENV-GOLDEN: the closure requires every environment role, and the finalizer's three", () => {
  const byRole = new Map(summary.required_roles.map((r) => [r.role, r.count]));
  // Named explicitly rather than derived from the summary, so a golden that lost
  // a role cannot also lose the assertion that it was required.
  for (const role of [
    "acquisition-preregistration",
    "acquisition-source-manifest",
    "acquisition-record",
    "package-verification-record",
    "subject-package-manifest",
    "selection-request",
    "eligibility-pool-manifest",
    "selection-commitment",
    "selected-challenge-journey-binding",
    "selection-proof",
    "selection-verification-receipt",
    "environment-reservation-lease",
    "environment-resource-inventory",
    "environment-baseline",
    "execution-plan",
    "journey-step-outcome",
    "subject-output-manifest",
    "journey-result",
    "domain-result",
    "precleanup-result-join",
    "environment-restoration",
    "teardown-verification",
    "validity-result",
    "generic-evaluation-index",
    "run-record",
    "final-attestation",
    "signer-inventory",
  ]) {
    assert.ok((byRole.get(role) ?? 0) >= 1, `the closure does not require ${role}`);
  }
  // Multiplicities that are properties, not incidentals: one environment, one
  // plan, one terminal record; four substrate identities reserved; ten steps.
  assert.equal(byRole.get("environment-resource-inventory"), 1);
  assert.equal(byRole.get("execution-plan"), 1);
  assert.equal(byRole.get("run-record"), 1);
  assert.equal(byRole.get("environment-reservation-lease"), 4);
  assert.equal(byRole.get("journey-step-outcome"), 10);
});

test("ENV-GOLDEN: the walk runs in the design's order and ends at generic_finalized", () => {
  const states = summary.lifecycle_states;
  const order = [
    "case_selected",
    "environment_provisioned",
    "baseline_verified",
    "execution_plan_frozen",
    "challenge_activated",
    "traffic_or_journey_started",
    "evidence_cutoff_realized",
    "observation_frozen",
    "canonical_evidence_envelope_frozen",
    "adapter_translation_frozen",
    "subject_output_frozen",
    "judge_journey_expectation_revealed",
    "generic_precleanup_results_complete",
    "lab_cleanup_started",
    "environment_restored",
    "teardown_started",
    "teardown_verified",
    "environment_validity_result_frozen",
    "generic_evaluation_index_frozen",
    "generic_finalized",
  ];
  const seen = order.map((state) => states.indexOf(state));
  for (const [i, index] of seen.entries()) {
    assert.ok(index >= 0, `the pinned walk never reached ${order[i] as string}`);
    if (i > 0) assert.ok(index > (seen[i - 1] as number), `${order[i] as string} is out of order`);
  }
  assert.equal(states[states.length - 1], "generic_finalized");
  // No pre-environment cleanup on this branch: the two terminal variants close
  // over disjoint member sets and the crossover must stay impossible.
  assert.ok(!summary.produced_roles.includes("pre-environment-cleanup"));
  // The controller's signed activation receipt (ADR-ERL2-023) is really produced.
  assert.ok(summary.produced_roles.includes("challenge-activation-receipt"));
  assert.ok(summary.produced_roles.includes("exposure-event"));
});

test("ENV-GOLDEN: a verifier without the pinned beacon is refused, fail-closed", () => {
  assert.notEqual(summary.offline_verification.without_pinned_beacon.exit_code, 0);
  assert.equal(
    summary.offline_verification.without_pinned_beacon.code,
    "RANDOMNESS_SOURCE_NOT_PINNED",
  );
});
