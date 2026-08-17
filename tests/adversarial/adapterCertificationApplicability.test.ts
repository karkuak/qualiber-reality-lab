/**
 * `adapter-certified` applicability, enforced where validity is actually built.
 *
 * ## The gap this closes
 *
 * The independent review of `90a0039` removed **both** production calls to
 * `assertAdapterCertificationApplicability` — from `buildPreEnvironmentValidity`
 * and from `buildEnvironmentValidity` — and the tree still passed 144/144 in the
 * affected suite and **1,209 tests with zero failures** across the whole
 * repository. Nothing noticed.
 *
 * It survived for a specific, instructive reason. The existing
 * `GATE-APPLICABILITY` control calls `assertAdapterCertificationApplicability`
 * *directly*, so deleting the wiring cannot break it: the helper still exists
 * and still works, it is simply no longer reached. And the one sub-case that is
 * independently enforced — an external run **omitting** the gate — is caught by
 * `assertRequiredGatesPresent`, which is why suppressing the producer (the
 * review's M4) did fail a test.
 *
 * What was left uncovered is everything the applicability rule uniquely says:
 *
 *   - the gate appearing **more than once**;
 *   - the gate citing **manifest-only** evidence;
 *   - the gate citing the manifest's **bootstrap/prior** receipt instead of the
 *     current one the run was authorised on;
 *   - a **fake-port** run emitting the gate at all.
 *
 * None of those is a missing gate, so `assertRequiredGatesPresent` is silent on
 * all four. Each is a false certification claim in retained evidence — exactly
 * the shape LIVE-001 was — and until now a regression could reintroduce any of
 * them without a single test failing.
 *
 * ## Why these controls are written this way
 *
 * They drive `buildPreEnvironmentValidity` and `buildEnvironmentValidity`: the
 * real production entry points, the ones `RunWorkspace.freezeValidity` and
 * `EnvironmentRun` call, and the ones that carry the deleted call sites. A
 * control that called the helper again would repeat the mistake it exists to
 * fix.
 *
 * Every case asserts a typed refusal **and** that no validity result was
 * produced, because the failure that matters is not "an error was thrown" but
 * "a run carrying a false certification claim never became evidence".
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BOOTSTRAP_RECEIPT_SENTINEL,
  ENVIRONMENT_GATE_IDS,
  PRE_ENVIRONMENT_GATE_IDS,
  buildEnvironmentValidity,
  buildPreEnvironmentValidity,
  requiredGateIds,
} from "@erl2/core";
import { CODES, type Hash, type Instant } from "@erl2/contracts";

const RUN_ID = "0192f0a0-0000-7000-8000-000000000001";
const MANIFEST = `sha256:${"a".repeat(64)}` as Hash;
/** The current receipt the run froze at preregistration. */
const CURRENT_RECEIPT = `sha256:${"b".repeat(64)}` as Hash;
const POLICY = `sha256:${"c".repeat(64)}` as Hash;
const CLEANUP = `sha256:${"d".repeat(64)}` as Hash;
const RESTORATION = `sha256:${"e".repeat(64)}` as Hash;
const TEARDOWN = `sha256:${"f".repeat(64)}` as Hash;
const EVALUATED_AT = "2026-08-11T00:00:00Z" as Instant;

interface Gate {
  readonly gate_id: string;
  readonly passed: boolean;
  readonly evidence_refs: readonly Hash[];
}

/** The gate a correctly behaving external run emits: one, citing the receipt. */
const CERTIFIED: Gate = {
  gate_id: "adapter-certified",
  passed: true,
  evidence_refs: [CURRENT_RECEIPT, MANIFEST],
};

/**
 * A full, otherwise-valid gate set for the given mode.
 *
 * Built from the catalogue rather than hand-listed, so a new Lab gate cannot
 * quietly leave these controls testing a stale shape — and `requiredGateIds` is
 * what decides whether `adapter-certified` belongs, which keeps the baseline
 * honest for both modes.
 */
function gatesFor(
  catalogue: readonly string[],
  mode: "development_fake_port" | "external_adapter",
  adapterCertified: readonly Gate[],
): readonly Gate[] {
  const required = requiredGateIds(catalogue, { externalAdapter: mode === "external_adapter" });
  return [
    ...required
      .filter((id) => id !== "adapter-certified")
      .map((gate_id) => ({ gate_id, passed: true, evidence_refs: [MANIFEST] })),
    ...adapterCertified,
  ];
}

function preEnvironment(
  mode: "development_fake_port" | "external_adapter",
  adapterCertified: readonly Gate[],
): () => unknown {
  return () =>
    buildPreEnvironmentValidity({
      runId: RUN_ID,
      subjectExecutionMode: mode,
      ...(mode === "external_adapter" ? { adapterCertificationReceiptHash: CURRENT_RECEIPT } : {}),
      terminalStage: "verify_package",
      genericRunPolicyHash: POLICY,
      gates: gatesFor(PRE_ENVIRONMENT_GATE_IDS, mode, adapterCertified),
      preEnvironmentCleanupHash: CLEANUP,
      invalidityFindingHashes: [],
      evaluatedAt: EVALUATED_AT,
    });
}

function environment(
  mode: "development_fake_port" | "external_adapter",
  adapterCertified: readonly Gate[],
): () => unknown {
  return () =>
    buildEnvironmentValidity({
      runId: RUN_ID,
      subjectExecutionMode: mode,
      ...(mode === "external_adapter" ? { adapterCertificationReceiptHash: CURRENT_RECEIPT } : {}),
      terminalStage: "exercise",
      // This suite measures the *adapter* applicability dimension, so telemetry
      // stays applicable throughout and the gate `gatesFor` emits is the one
      // `assertAttributableTelemetryApplicability` then requires. The telemetry
      // dimension has its own suite.
      attributableTelemetryApplicable: true,
      // ADR-ERL2-039. A run with applicable telemetry is a run whose exercising
      // step succeeded — the coherence refusal makes any other combination
      // unrepresentable — so this suite states the ordinary case and leaves the
      // exercise dimension to `environmentExerciseOutcome.test.ts`.
      exerciseApplicable: true,
      exerciseSucceeded: true,
      telemetryObservationRetained: true,
      genericRunPolicyHash: POLICY,
      gates: gatesFor(ENVIRONMENT_GATE_IDS, mode, adapterCertified),
      environmentRestorationHash: RESTORATION,
      teardownHash: TEARDOWN,
      invalidityFindingHashes: [],
      evaluatedAt: EVALUATED_AT,
    });
}

/**
 * A refusal that produced no evidence.
 *
 * Both halves are the control. A thrown error that nonetheless left a validity
 * result behind would still have published the certification claim.
 */
function refuses(build: () => unknown, code: string, label: string): void {
  let produced: unknown;
  assert.throws(
    () => {
      produced = build();
    },
    (error: unknown) => (error as { code?: string }).code === code,
    `${label}: expected a typed ${code} refusal`,
  );
  assert.equal(produced, undefined, `${label}: a validity result was emitted despite the refusal`);
}

// -- the baseline these controls are measured against ------------------------

test("APPLICABILITY: a correctly formed run of each mode still builds validity", () => {
  // Without this, every control below could pass because the inputs were
  // malformed in some unrelated way.
  for (const [label, build] of [
    ["external pre-environment", preEnvironment("external_adapter", [CERTIFIED])],
    ["external environment", environment("external_adapter", [CERTIFIED])],
    ["fake-port pre-environment", preEnvironment("development_fake_port", [])],
    ["fake-port environment", environment("development_fake_port", [])],
  ] as const) {
    const result = build() as { status: string; gate_results: readonly Gate[] };
    assert.equal(result.status, "valid", `${label}: the honest shape must remain valid`);
    const certified = result.gate_results.filter((g) => g.gate_id === "adapter-certified");
    assert.equal(
      certified.length,
      label.startsWith("external") ? 1 : 0,
      `${label}: the baseline carries the wrong number of adapter-certified gates`,
    );
  }
});

// -- the four shapes only applicability rejects ------------------------------

test("APPLICABILITY: an external run emitting the gate twice is refused where validity is built", () => {
  // `assertRequiredGatesPresent` sees the gate and is satisfied; both copies are
  // Lab-owned and passing, so nothing else in the pipeline objects. "Exactly
  // one" is the only rule that does — and two passing certification claims over
  // one receipt is precisely the ambiguity the gate is supposed to remove.
  refuses(
    preEnvironment("external_adapter", [CERTIFIED, CERTIFIED]),
    CODES.GRAPH_CLOSURE_MISSING_ROLE,
    "duplicate gate, pre-environment",
  );
  refuses(
    environment("external_adapter", [CERTIFIED, CERTIFIED]),
    CODES.GRAPH_CLOSURE_MISSING_ROLE,
    "duplicate gate, environment",
  );
});

test("APPLICABILITY: an external gate citing only the manifest is refused where validity is built", () => {
  // The original LIVE-001 shape: a passing `adapter-certified` whose evidence is
  // a manifest hash. A manifest is a declaration; it is not certification.
  const manifestOnly: Gate = {
    gate_id: "adapter-certified",
    passed: true,
    evidence_refs: [MANIFEST],
  };
  refuses(
    preEnvironment("external_adapter", [manifestOnly]),
    CODES.GRAPH_CLOSURE_MISSING_ROLE,
    "manifest-only evidence, pre-environment",
  );
  refuses(
    environment("external_adapter", [manifestOnly]),
    CODES.GRAPH_CLOSURE_MISSING_ROLE,
    "manifest-only evidence, environment",
  );
});

test("APPLICABILITY: an external gate citing the bootstrap/prior receipt is refused where validity is built", () => {
  // The P2 the review raised in its other form: the manifest's
  // `certification_receipt_hash` is a bootstrap/prior reference, and naming it
  // asserts a current authority the run never had.
  const bootstrap: Gate = {
    gate_id: "adapter-certified",
    passed: true,
    evidence_refs: [BOOTSTRAP_RECEIPT_SENTINEL as Hash, MANIFEST],
  };
  refuses(
    preEnvironment("external_adapter", [bootstrap]),
    CODES.GRAPH_CLOSURE_MISSING_ROLE,
    "bootstrap receipt evidence, pre-environment",
  );
  refuses(
    environment("external_adapter", [bootstrap]),
    CODES.GRAPH_CLOSURE_MISSING_ROLE,
    "bootstrap receipt evidence, environment",
  );
});

test("APPLICABILITY: a fake-port run emitting the gate is refused where validity is built", () => {
  // `requiredGateIds` drops `adapter-certified` for a fake-port run, so nothing
  // requires it — and nothing else forbids it either. Without applicability the
  // old `passed: true` convention could creep back in through any producer that
  // kept emitting it, which is the exact regression P2 asked to be made
  // impossible rather than merely absent.
  refuses(
    preEnvironment("development_fake_port", [CERTIFIED]),
    CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
    "fake-port emitting the gate, pre-environment",
  );
  refuses(
    environment("development_fake_port", [CERTIFIED]),
    CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
    "fake-port emitting the gate, environment",
  );
});

test("APPLICABILITY: each refusal is uniquely applicability's, not another guard firing first", () => {
  // The control is only meaningful if removing the applicability call sites is
  // what makes these cases pass. Each malformed shape is therefore checked to be
  // well-formed in every *other* respect: the required set is satisfied, every
  // gate id is Lab-owned, and every gate passes — so no other enforcement in
  // `buildPreEnvironmentValidity` has grounds to object.
  const shapes: readonly (readonly [string, "development_fake_port" | "external_adapter", readonly Gate[]])[] = [
    ["duplicate", "external_adapter", [CERTIFIED, CERTIFIED]],
    ["manifest-only", "external_adapter", [{ ...CERTIFIED, evidence_refs: [MANIFEST] }]],
    ["bootstrap", "external_adapter", [{ ...CERTIFIED, evidence_refs: [BOOTSTRAP_RECEIPT_SENTINEL as Hash] }]],
    ["fake-port emits", "development_fake_port", [CERTIFIED]],
  ];
  for (const [label, mode, certified] of shapes) {
    const gates = gatesFor(PRE_ENVIRONMENT_GATE_IDS, mode, certified);
    const required = requiredGateIds(PRE_ENVIRONMENT_GATE_IDS, {
      externalAdapter: mode === "external_adapter",
    });
    for (const id of required) {
      assert.ok(
        gates.some((g) => g.gate_id === id),
        `${label}: the required gate ${id} is missing, so this case would refuse for the wrong reason`,
      );
    }
    assert.ok(
      gates.every((g) => PRE_ENVIRONMENT_GATE_IDS.includes(g.gate_id) || g.gate_id === "adapter-certified"),
      `${label}: a gate id outside the catalogue would be refused as not Lab-owned`,
    );
    assert.ok(gates.every((g) => g.passed), `${label}: a failing gate would change the status instead`);
  }
});
