/**
 * The `attributable-telemetry-retained` applicability boundary
 * (ADR-ERL2-038 R8, package 3).
 *
 * ## What package 3 changed here, and why it needed a suite of its own
 *
 * Until package 3 this gate was evaluated on *every* environment terminal and
 * passed vacuously wherever the observation was never declared obtainable. A
 * fake-driver run therefore published:
 *
 *     { gate_id: "attributable-telemetry-retained", passed: true }
 *
 * — a boolean answering a question about applicability. A reader could not tell
 * "this run's trusted telemetry was independently verified" from "this run could
 * never have had any", and only one of those is a statement about evidence. It
 * is the same false-attestation shape the independent LIVE-001 review rejected
 * for `adapter-certified`, sitting one gate over and unnoticed because it always
 * said `true`.
 *
 * So the gate is **omitted** where telemetry is inapplicable. Omission is only
 * safe if both directions are refused, and that is what this file measures:
 *
 * 1. an **inapplicable** run may not publish the gate at all — otherwise the old
 *    `passed: true` convention creeps back through a producer that keeps
 *    emitting it;
 * 2. an **applicable** run may not omit it — otherwise "not applicable" quietly
 *    becomes "optional", and a producer facing a failing gate could simply drop
 *    it, which is precisely the hole `assertRequiredGatesPresent` exists to
 *    close and which an unguarded applicability filter would punch in it.
 *
 * Every case drives `buildEnvironmentValidity` — the real production entry
 * point, the one `EnvironmentRun.freezeValidityAndIndex` calls — and asserts a
 * typed refusal **and** that no validity result was produced, because the
 * failure that matters is not "an error was thrown" but "a run carrying a false
 * telemetry claim never became evidence".
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ENVIRONMENT_GATE_IDS,
  assertAttributableTelemetryApplicability,
  attributableTelemetryGatePassed,
  buildEnvironmentValidity,
  requiredGateIds,
  supportsTrustedTelemetry,
} from "@erl2/core";
import { CODES, type Hash, type Instant } from "@erl2/contracts";

const RUN_ID = "0192f0a0-0000-7000-8000-0000000000a1";
const MANIFEST = `sha256:${"a".repeat(64)}` as Hash;
const POLICY = `sha256:${"c".repeat(64)}` as Hash;
const RESTORATION = `sha256:${"e".repeat(64)}` as Hash;
const TEARDOWN = `sha256:${"f".repeat(64)}` as Hash;
const FINDING = `sha256:${"9".repeat(64)}` as Hash;
const EVALUATED_AT = "2026-08-14T00:00:00Z" as Instant;

interface Gate {
  readonly gate_id: string;
  readonly passed: boolean;
  readonly evidence_refs: readonly Hash[];
}

const TELEMETRY_GATE = "attributable-telemetry-retained";

/**
 * A full, otherwise-valid gate set for a fake-port run at the given
 * applicability.
 *
 * Built from the catalogue through `requiredGateIds` rather than hand-listed, so
 * a new Lab gate cannot quietly leave these controls testing a stale shape — and
 * so the set under test is exactly the set the production path would require.
 */
function gatesFor(applicable: boolean, overrides: readonly Gate[] = []): readonly Gate[] {
  const required = requiredGateIds(ENVIRONMENT_GATE_IDS, {
    externalAdapter: false,
    attributableTelemetryApplicable: applicable,
  });
  const overridden = new Set(overrides.map((g) => g.gate_id));
  return [
    ...required
      .filter((id) => !overridden.has(id))
      .map((gate_id) => ({ gate_id, passed: true, evidence_refs: [MANIFEST] })),
    ...overrides,
  ];
}

function build(applicable: boolean, gates: readonly Gate[], failing = false): () => unknown {
  return () =>
    buildEnvironmentValidity({
      runId: RUN_ID,
      subjectExecutionMode: "development_fake_port",
      terminalStage: "exercise",
      attributableTelemetryApplicable: applicable,
      genericRunPolicyHash: POLICY,
      gates,
      environmentRestorationHash: RESTORATION,
      teardownHash: TEARDOWN,
      invalidityFindingHashes: failing ? [FINDING] : [],
      evaluatedAt: EVALUATED_AT,
    });
}

function refusalCode(act: () => unknown): string | undefined {
  try {
    act();
    return undefined;
  } catch (cause) {
    return (cause as { code?: string }).code;
  }
}

// -- 1. the required set follows applicability -------------------------------

test("ENV-TELEM-APPLICABILITY: the gate is required of a declaring run and of no other", () => {
  const applicable = requiredGateIds(ENVIRONMENT_GATE_IDS, {
    externalAdapter: false,
    attributableTelemetryApplicable: true,
  });
  const inapplicable = requiredGateIds(ENVIRONMENT_GATE_IDS, {
    externalAdapter: false,
    attributableTelemetryApplicable: false,
  });
  assert.ok(applicable.includes(TELEMETRY_GATE), "a declaring run must be required to evaluate it");
  assert.ok(
    !inapplicable.includes(TELEMETRY_GATE),
    "a run that never declared telemetry obtainable must not be required to evaluate it",
  );
  // Dropping the telemetry gate must drop *only* it: an applicability filter
  // that also removed a neighbour would narrow the required set silently.
  assert.deepEqual(
    applicable.filter((id) => id !== TELEMETRY_GATE),
    [...inapplicable],
  );
});

test("ENV-TELEM-APPLICABILITY: silence is the strict answer, not the lenient one", () => {
  // A caller that does not answer the applicability question gets the *stricter*
  // required set. The lenient direction has to be asked for explicitly, which is
  // what keeps a forgotten argument from quietly excusing the gate.
  const silent = requiredGateIds(ENVIRONMENT_GATE_IDS, { externalAdapter: false });
  assert.ok(silent.includes(TELEMETRY_GATE));
});

// -- 2. an inapplicable run may not publish the gate -------------------------

test("ENV-TELEM-APPLICABILITY: a non-declaring run that publishes the gate is refused", () => {
  for (const [why, gate] of [
    ["passing", { gate_id: TELEMETRY_GATE, passed: true, evidence_refs: [MANIFEST] }],
    ["failing", { gate_id: TELEMETRY_GATE, passed: false, evidence_refs: [MANIFEST] }],
  ] as const) {
    const gates = [...gatesFor(false), gate];
    assert.equal(
      refusalCode(build(false, gates, !gate.passed)),
      CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
      `a ${why} telemetry gate on a non-declaring run was admitted`,
    );
  }
});

test("ENV-TELEM-APPLICABILITY: a non-declaring run omitting the gate is admitted", () => {
  const validity = build(false, gatesFor(false))() as {
    readonly status: string;
    readonly gate_results: readonly Gate[];
  };
  assert.equal(validity.status, "valid");
  assert.equal(
    validity.gate_results.some((g) => g.gate_id === TELEMETRY_GATE),
    false,
    "the gate must be absent from the published result, not merely unrequired",
  );
});

// -- 3. a declaring run may not omit it --------------------------------------

test("ENV-TELEM-APPLICABILITY: a declaring run that omits the gate is refused", () => {
  const gates = gatesFor(true).filter((g) => g.gate_id !== TELEMETRY_GATE);
  assert.equal(
    refusalCode(build(true, gates)),
    CODES.GRAPH_CLOSURE_MISSING_ROLE,
    "a declaring run dropped its telemetry gate and still produced a validity result",
  );
});

test("ENV-TELEM-APPLICABILITY: a declaring run that publishes the gate twice is refused", () => {
  const duplicate: Gate = { gate_id: TELEMETRY_GATE, passed: true, evidence_refs: [MANIFEST] };
  assert.equal(
    refusalCode(build(true, [...gatesFor(true), duplicate])),
    CODES.GRAPH_CLOSURE_MISSING_ROLE,
    "two telemetry gates were admitted; the second could disagree with the first",
  );
});

test("ENV-TELEM-APPLICABILITY: a declaring run whose gate failed still freezes an invalid terminal", () => {
  // The failure that matters is not that a refusal was raised but that a failing
  // telemetry gate reaches an *invalid* terminal rather than being dropped.
  const failed: Gate = { gate_id: TELEMETRY_GATE, passed: false, evidence_refs: [MANIFEST] };
  const validity = build(true, gatesFor(true, [failed]), true)() as {
    readonly status: string;
    readonly gate_results: readonly Gate[];
  };
  assert.equal(validity.status, "invalid");
  assert.equal(validity.gate_results.find((g) => g.gate_id === TELEMETRY_GATE)?.passed, false);
});

// -- 4. the assertion in isolation -------------------------------------------

test("ENV-TELEM-APPLICABILITY: the applicability assertion refuses both directions", () => {
  const gate: Gate = { gate_id: TELEMETRY_GATE, passed: true, evidence_refs: [MANIFEST] };
  assert.throws(
    () => assertAttributableTelemetryApplicability([gate], { applicable: false }),
    (error: { code?: string }) => error.code === CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
  );
  assert.throws(
    () => assertAttributableTelemetryApplicability([], { applicable: true }),
    (error: { code?: string }) => error.code === CODES.GRAPH_CLOSURE_MISSING_ROLE,
  );
  // And admits each correct shape, so the control is not "refuses everything".
  assertAttributableTelemetryApplicability([], { applicable: false });
  assertAttributableTelemetryApplicability([gate], { applicable: true });
});

// -- 5. what applicability is *not* a function of -----------------------------

test("ENV-TELEM-APPLICABILITY: C-160 cannot satisfy a declaring run's gate", () => {
  // The whole point of the migration, restated at the producer's own gate
  // arithmetic: a historical ERL2-C-160 record is readable and authorizes
  // nothing, so a declaring run holding one — and nothing else — fails.
  const v1 = {
    schema_version: "attributable-telemetry-observation/v1",
    run_id: RUN_ID,
    marker: RUN_ID,
    evidence: "observed",
    observed_at: EVALUATED_AT,
    trace_batches: 1,
    spans: 9999,
    service_names: ["quote"],
    run_attributed_records: 7,
    log_excerpt: `Traces {"spans": 9999} erl2_run=${RUN_ID}`,
    core_hash: MANIFEST,
  };
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [v1] }),
    false,
    "a v1 record satisfied a declaring run's telemetry gate",
  );
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [] }),
    false,
    "a declaring run with no retained observation passed its telemetry gate",
  );
});

test("ENV-TELEM-APPLICABILITY: the trusted-producer capability guard is structural and strict", () => {
  assert.equal(supportsTrustedTelemetry({}), false);
  assert.equal(supportsTrustedTelemetry(undefined), false);
  assert.equal(supportsTrustedTelemetry(null), false);
  // Half the seam is not the seam: a driver that can freeze a record but cannot
  // report how its cleanup went would leave a surviving volume unexplained.
  assert.equal(
    supportsTrustedTelemetry({ freezeTrustedTelemetryObservation: (): void => undefined }),
    false,
  );
  assert.equal(supportsTrustedTelemetry({ trustedChannelCleanup: (): void => undefined }), false);
  assert.equal(
    supportsTrustedTelemetry({
      freezeTrustedTelemetryObservation: (): void => undefined,
      trustedChannelCleanup: (): void => undefined,
    }),
    true,
  );
});
