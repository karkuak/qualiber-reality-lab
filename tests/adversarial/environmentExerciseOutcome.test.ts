/**
 * The `subject-exercise-succeeded` boundary, and the false-valid terminal it
 * closes (ADR-ERL2-039).
 *
 * ## The defect this file is the memory of
 *
 * The independent Package 3 live-integration review drove the real production
 * predicate and the real production validity entry point and measured this:
 *
 * | exercise outcome | telemetry applicable | telemetry gate | terminal |
 * |---|---|---|---|
 * | succeeded        | true  | present | valid   |
 * | **failed**       | false | **absent** | **valid** |
 * | **unsupported**  | false | **absent** | **valid** |
 *
 * A run whose exercising step did not succeed omitted the telemetry gate —
 * correctly, because telemetry applicability contains exercise success — and
 * then reached a **valid** terminal anyway, because *nothing else in the gate
 * catalogue could fail on an unsuccessful exercise*. The omission was dominated
 * by no independent failure at all. Worse, `retainAttributableTelemetry` did not
 * read the exercise conjunct, so the run still froze an ERL2-C-171 record that
 * no gate ever evaluated.
 *
 * Two properties close it, and both are measured here:
 *
 *   1. an independent gate fails when a required exercise did not succeed, so
 *      the run is invalid for a reason of its own;
 *   2. retention and gate applicability read **one** predicate, so a retained
 *      observation cannot escape the gate that should evaluate it.
 *
 * ## What is deliberately *not* claimed
 *
 * An unsuccessful exercise is not relabelled "not applicable". Applicability
 * reads only *whether the committed journey ordered an exercising step*, never
 * how it turned out, so a failing run and an inapplicable run stay different
 * shapes. And the run is still permitted to finalize and keep its diagnostics —
 * `nextPermittedIntents` is unchanged. Permission to finalize is not a valid
 * verdict, which is the distinction this gate exists to make.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ENVIRONMENT_GATE_IDS,
  assertExerciseOutcomeApplicability,
  assertTelemetryExerciseCoherence,
  attributableTelemetryDeclared,
  buildEnvironmentValidity,
  exerciseApplicable,
  exerciseOutcomeGateVerdict,
  exerciseSucceeded,
  requiredGateIds,
} from "@erl2/core";
import { CODES, type Hash, type Instant, type JourneyStepOutcomeV1 } from "@erl2/contracts";

const RUN_ID = "0192f0a0-0000-7000-8000-0000000000a1";
const H = (c: string): Hash => `sha256:${c.repeat(64)}` as Hash;
const MANIFEST = H("a");
const FINDING = H("9");
const EVALUATED_AT = "2026-08-15T00:00:00Z" as Instant;

const EXERCISE_GATE = "subject-exercise-succeeded";
const TELEMETRY_GATE = "attributable-telemetry-retained";

/** A step outcome carrying only what these predicates read. */
function outcome(intent: string, status: string): JourneyStepOutcomeV1 {
  return { intent, status } as unknown as JourneyStepOutcomeV1;
}

/** The compose/metric half of telemetry applicability, held fixed. */
const COMPOSE_WITH_METRIC = {
  driverKind: "compose",
  evidenceSources: [{ source_id: "service-metric", kind: "metric", required: true }],
} as unknown as {
  driverKind: string;
  evidenceSources: Parameters<typeof attributableTelemetryDeclared>[0]["evidenceSources"];
};

interface Gate {
  readonly gate_id: string;
  readonly passed: boolean;
  readonly evidence_refs: readonly Hash[];
}

/**
 * The gate set a producer reading these outcomes would actually compose.
 *
 * Built from the catalogue through `requiredGateIds` and from the same shared
 * primitives production reads, so this helper cannot drift into testing a shape
 * the producer never emits.
 */
function gatesFor(outcomes: readonly JourneyStepOutcomeV1[], overrides: readonly Gate[] = []): readonly Gate[] {
  const telemetry = attributableTelemetryDeclared({ ...COMPOSE_WITH_METRIC, outcomes });
  const required = requiredGateIds(ENVIRONMENT_GATE_IDS, {
    externalAdapter: false,
    attributableTelemetryApplicable: telemetry,
    exerciseApplicable: exerciseApplicable(outcomes),
  });
  const overridden = new Set(overrides.map((g) => g.gate_id));
  return [
    ...required
      .filter((id) => !overridden.has(id))
      .map((gate_id) => ({
        gate_id,
        // The exercise gate answers from the outcomes; every other Lab gate is
        // held passing so the only thing that can invalidate a run here is the
        // property under test.
        passed: gate_id === EXERCISE_GATE ? exerciseSucceeded(outcomes) : true,
        evidence_refs: [MANIFEST],
      })),
    ...overrides,
  ];
}

function build(outcomes: readonly JourneyStepOutcomeV1[], gates: readonly Gate[]): () => unknown {
  const telemetry = attributableTelemetryDeclared({ ...COMPOSE_WITH_METRIC, outcomes });
  return () =>
    buildEnvironmentValidity({
      runId: RUN_ID,
      subjectExecutionMode: "development_fake_port",
      terminalStage: "exercise",
      attributableTelemetryApplicable: telemetry,
      exerciseApplicable: exerciseApplicable(outcomes),
      exerciseSucceeded: exerciseSucceeded(outcomes),
      telemetryObservationRetained: telemetry,
      genericRunPolicyHash: H("c"),
      gates,
      environmentRestorationHash: H("e"),
      teardownHash: H("f"),
      invalidityFindingHashes: gates.some((g) => !g.passed) ? [FINDING] : [],
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

// -- 1. the regression itself ------------------------------------------------

test("ENV-EXERCISE: an unsuccessful required exercise reaches an INVALID terminal", () => {
  // Both of the review's measured shapes, and the one it did not name: a run
  // whose exercising step is present but never succeeded, however it failed.
  for (const status of ["failed", "unsupported"] as const) {
    const outcomes = [outcome("exercise", status)];
    const validity = build(outcomes, gatesFor(outcomes))() as {
      readonly status: string;
      readonly gate_results: readonly Gate[];
    };
    assert.equal(
      validity.status,
      "invalid",
      `an exercise that came back ${status} must not reach a valid terminal`,
    );
    assert.equal(
      validity.gate_results.find((g) => g.gate_id === EXERCISE_GATE)?.passed,
      false,
      "the exercise gate is the independent failure the omission is dominated by",
    );
    // And the telemetry gate is still absent — that part of package 3 was right,
    // and this correction does not make an unexercised run answer for telemetry.
    assert.equal(
      validity.gate_results.some((g) => g.gate_id === TELEMETRY_GATE),
      false,
      "a run whose exercise did not succeed must not be required to produce telemetry",
    );
  }
});

test("ENV-EXERCISE: a successful exercise still reaches a valid terminal", () => {
  const outcomes = [outcome("exercise", "succeeded")];
  const validity = build(outcomes, gatesFor(outcomes))() as {
    readonly status: string;
    readonly gate_results: readonly Gate[];
  };
  assert.equal(validity.status, "valid");
  assert.equal(validity.gate_results.find((g) => g.gate_id === EXERCISE_GATE)?.passed, true);
  assert.equal(
    validity.gate_results.some((g) => g.gate_id === TELEMETRY_GATE),
    true,
    "a compose run with a metric source and a succeeded exercise must answer for its telemetry",
  );
});

test("ENV-EXERCISE: reaching finalization is not the same as being valid", () => {
  // `nextPermittedIntents` still lets a failed step finalize — that is
  // deliberate, and this asserts the two ideas stay separate rather than one
  // being quietly repaired into the other.
  const outcomes = [outcome("exercise", "failed"), outcome("remove", "succeeded")];
  const validity = build(outcomes, gatesFor(outcomes))() as { readonly status: string };
  assert.equal(
    validity.status,
    "invalid",
    "a run that got all the way to a terminal on a failed exercise is finalized, not valid",
  );
});

// -- 2. applicability is not a function of the outcome -----------------------

test("ENV-EXERCISE: applicability reads whether an exercise happened, never how it went", () => {
  for (const status of ["succeeded", "failed", "unsupported"] as const) {
    assert.equal(
      exerciseApplicable([outcome("exercise", status)]),
      true,
      `an exercising step that came back ${status} is still an exercising step`,
    );
  }
  assert.equal(exerciseApplicable([outcome("observe", "succeeded")]), false);
  assert.equal(exerciseApplicable([]), false);

  // The gate verdict distinguishes all three states, and `undefined` — the
  // omission — is reachable only by never having exercised.
  assert.equal(exerciseOutcomeGateVerdict([outcome("exercise", "succeeded")]), true);
  assert.equal(exerciseOutcomeGateVerdict([outcome("exercise", "failed")]), false);
  assert.equal(exerciseOutcomeGateVerdict([outcome("observe", "succeeded")]), undefined);
});

test("ENV-EXERCISE: a run that committed no exercising step omits the gate and passes nothing vacuously", () => {
  const outcomes = [outcome("install", "succeeded"), outcome("observe", "succeeded")];
  const validity = build(outcomes, gatesFor(outcomes))() as {
    readonly status: string;
    readonly gate_results: readonly Gate[];
  };
  assert.equal(validity.status, "valid");
  assert.equal(
    validity.gate_results.some((g) => g.gate_id === EXERCISE_GATE),
    false,
    "the gate must be absent from the published result, not present and true",
  );
});

// -- 3. both directions of the applicability boundary ------------------------

test("ENV-EXERCISE: an exercising run may not omit the gate, and a non-exercising run may not publish it", () => {
  const exercised = [outcome("exercise", "succeeded")];
  assert.equal(
    refusalCode(build(exercised, gatesFor(exercised).filter((g) => g.gate_id !== EXERCISE_GATE))),
    CODES.GRAPH_CLOSURE_MISSING_ROLE,
    "a run that exercised dropped its gate and still produced a validity result",
  );

  const notExercised = [outcome("observe", "succeeded")];
  assert.equal(
    refusalCode(
      build(notExercised, [
        ...gatesFor(notExercised),
        { gate_id: EXERCISE_GATE, passed: true, evidence_refs: [MANIFEST] },
      ]),
    ),
    CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
    "a run that never exercised published a passing exercise gate",
  );

  assert.equal(
    refusalCode(
      build(exercised, [
        ...gatesFor(exercised),
        { gate_id: EXERCISE_GATE, passed: true, evidence_refs: [MANIFEST] },
      ]),
    ),
    CODES.GRAPH_CLOSURE_MISSING_ROLE,
    "two exercise gates were admitted; the second could disagree with the first",
  );

  // The assertion in isolation, so the control has a boundary to mutate that is
  // not entangled with the whole validity build.
  assert.throws(
    () => assertExerciseOutcomeApplicability([], { applicable: true }),
    (error: { code?: string }) => error.code === CODES.GRAPH_CLOSURE_MISSING_ROLE,
  );
  assert.throws(
    () =>
      assertExerciseOutcomeApplicability(
        [{ gate_id: EXERCISE_GATE, passed: true, evidence_refs: [MANIFEST] }],
        { applicable: false },
      ),
    (error: { code?: string }) => error.code === CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
  );
  assertExerciseOutcomeApplicability([], { applicable: false });
  assertExerciseOutcomeApplicability(
    [{ gate_id: EXERCISE_GATE, passed: false, evidence_refs: [MANIFEST] }],
    { applicable: true },
  );
});

// -- 4. one predicate: retention and the gate cannot disagree ----------------

test("ENV-EXERCISE: telemetry applicability contains exercise success, from one definition", () => {
  // The producer's retention guard and the gate now read the same primitive, so
  // this is the statement that they agree — measured on the predicate itself
  // rather than asserted in prose.
  for (const status of ["failed", "unsupported"] as const) {
    const outcomes = [outcome("exercise", status)];
    assert.equal(exerciseSucceeded(outcomes), false);
    assert.equal(
      attributableTelemetryDeclared({ ...COMPOSE_WITH_METRIC, outcomes }),
      false,
      `a compose run whose exercise came back ${status} declares no telemetry obligation`,
    );
  }
  const succeeded = [outcome("exercise", "succeeded")];
  assert.equal(attributableTelemetryDeclared({ ...COMPOSE_WITH_METRIC, outcomes: succeeded }), true);
});

test("ENV-EXERCISE: a retained observation the gate would not evaluate is refused", () => {
  // The exact contradiction the review found in production: bytes retained under
  // one predicate, gated under another, and therefore gated by nothing.
  assert.throws(
    () =>
      assertTelemetryExerciseCoherence({
        attributableTelemetryApplicable: false,
        exerciseApplicable: true,
        exerciseSucceeded: false,
        telemetryObservationRetained: true,
      }),
    (error: { code?: string }) => error.code === CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
    "a retained ERL2-C-171 record that no gate evaluates must be refused",
  );

  // And the other direction: claiming telemetry applies while the exercise did
  // not succeed asserts two things that cannot both be true.
  assert.throws(
    () =>
      assertTelemetryExerciseCoherence({
        attributableTelemetryApplicable: true,
        exerciseApplicable: true,
        exerciseSucceeded: false,
        telemetryObservationRetained: true,
      }),
    (error: { code?: string }) => error.code === CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
  );

  // Telemetry cannot apply to a run that committed no exercising step at all.
  assert.throws(
    () =>
      assertTelemetryExerciseCoherence({
        attributableTelemetryApplicable: true,
        exerciseApplicable: false,
        exerciseSucceeded: false,
        telemetryObservationRetained: true,
      }),
    (error: { code?: string }) => error.code === CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
  );

  // The two coherent shapes are admitted, so this is not "refuses everything".
  assertTelemetryExerciseCoherence({
    attributableTelemetryApplicable: true,
    exerciseApplicable: true,
    exerciseSucceeded: true,
    telemetryObservationRetained: true,
  });
  assertTelemetryExerciseCoherence({
    attributableTelemetryApplicable: false,
    exerciseApplicable: true,
    exerciseSucceeded: false,
    telemetryObservationRetained: false,
  });
});

// -- 5. the required set follows applicability -------------------------------

test("ENV-EXERCISE: the gate leaves the required set only for a run that never exercised", () => {
  const exercising = requiredGateIds(ENVIRONMENT_GATE_IDS, {
    externalAdapter: false,
    exerciseApplicable: true,
  });
  const notExercising = requiredGateIds(ENVIRONMENT_GATE_IDS, {
    externalAdapter: false,
    exerciseApplicable: false,
  });
  assert.ok(exercising.includes(EXERCISE_GATE));
  assert.ok(!notExercising.includes(EXERCISE_GATE));
  // Dropping it must drop *only* it.
  assert.deepEqual(exercising.filter((id) => id !== EXERCISE_GATE), [...notExercising]);
  // Silence is the strict answer, here as everywhere else.
  assert.ok(
    requiredGateIds(ENVIRONMENT_GATE_IDS, { externalAdapter: false }).includes(EXERCISE_GATE),
  );
});
