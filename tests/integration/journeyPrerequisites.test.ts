/**
 * The journey prerequisite matrix (review P1-9, ADR-ERL2-028 §2).
 *
 * Table-driven, and the table is the assertion: a canonical intent that arrives
 * without a prerequisite row fails here, and the `Record<JourneyIntent, …>` type
 * makes it fail at compile time as well. Both directions are checked, because the
 * type catches a *missing* row and only a runtime comparison catches a row for an
 * intent the frozen contract does not declare.
 *
 * These cases are pure: they call `assertJourneyPrerequisites` with an explicit
 * evidence set, so every state × intent combination is reachable without building
 * a run. The library-boundary and CLI halves live in
 * `tests/adversarial/lifecycleOrdering.test.ts`.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CANONICAL_JOURNEY_INTENTS,
  JOURNEY_PREREQUISITES,
  LAB_STATES,
  NO_SUBJECT_EXECUTION_STATES,
  assertJourneyPrerequisites,
  isPostCaptureIntent,
  type JourneyPrerequisite,
  type JourneyPrerequisiteEvidence,
  type LabState,
} from "@erl2/core";
import type { JourneyIntent } from "@erl2/contracts";

/** Every prerequisite satisfied: the baseline a negative case departs from. */
function allSatisfied(state: LabState): JourneyPrerequisiteEvidence {
  return {
    state,
    hasRole: () => true,
    connectSucceeded: true,
    completedStepCount: 3,
  };
}

/** The same, with exactly one prerequisite withheld. */
function withheld(state: LabState, prerequisite: JourneyPrerequisite): JourneyPrerequisiteEvidence {
  const roles: Readonly<Record<JourneyPrerequisite, readonly string[]>> = {
    verified_package: ["package-verification-record"],
    selected_challenge: ["selected-challenge-journey-binding"],
    provisioned_environment: ["environment-resource-inventory"],
    stable_baseline: ["environment-baseline"],
    execution_plan: ["execution-plan"],
    successful_connection: [],
    challenge_activation: ["mutation-receipt", "challenge-activation-receipt"],
    evidence_cutoff: ["runtime-milestone", "source-snapshot"],
    observation_bundle: ["observation-bundle"],
    prior_committed_step: [],
  };
  const hidden = new Set(roles[prerequisite]);
  return {
    state,
    hasRole: (role) => !hidden.has(role),
    connectSucceeded: prerequisite !== "successful_connection",
    completedStepCount: prerequisite === "prior_committed_step" ? 0 : 3,
  };
}

const ENVIRONMENT_INTENTS = CANONICAL_JOURNEY_INTENTS.filter(
  (intent) => JOURNEY_PREREQUISITES[intent].branch === "environment",
);

test("PREREQ-MATRIX: every canonical journey intent has exactly one row", () => {
  const rows = Object.keys(JOURNEY_PREREQUISITES).sort();
  assert.deepEqual(
    rows,
    [...CANONICAL_JOURNEY_INTENTS].sort(),
    "the matrix and the contract's intent union must agree in both directions; a new " +
      "canonical intent needs a prerequisite row, and a row needs a declared intent",
  );
  assert.equal(CANONICAL_JOURNEY_INTENTS.length, 14, "the contract declares fourteen intents");
});

test("PREREQ-MATRIX: the pre-environment intents cannot run as environment steps", () => {
  for (const intent of ["acquire", "verify_package"] satisfies JourneyIntent[]) {
    assert.throws(
      () => assertJourneyPrerequisites(intent, allSatisfied("execution_plan_frozen")),
      (error: unknown) => (error as { code?: string }).code === "POLICY_CONFLICT",
      `${intent} belongs to the acquisition walk`,
    );
  }
});

test("PREREQ-MATRIX: post-capture intents require activation, the cutoff and the bundle", () => {
  const postCapture = ENVIRONMENT_INTENTS.filter((intent) => isPostCaptureIntent(intent));
  // The design's "exercise through remove" range, and nothing else.
  assert.deepEqual(
    [...postCapture],
    ["exercise", "observe", "diagnose_decide", "recover", "upgrade", "rollback", "remove"],
  );
  for (const intent of postCapture) {
    const requires = JOURNEY_PREREQUISITES[intent].requires;
    for (const owed of ["challenge_activation", "evidence_cutoff", "observation_bundle"] as const) {
      assert.ok(requires.includes(owed), `${intent} must require ${owed}`);
    }
  }
});

test("PREREQ-MATRIX: setup intents do not require activation or the cutoff", () => {
  const setup = ENVIRONMENT_INTENTS.filter((intent) => !isPostCaptureIntent(intent));
  assert.deepEqual([...setup], ["install", "configure", "authenticate", "connect", "discover"]);
  for (const intent of setup) {
    const requires = JOURNEY_PREREQUISITES[intent].requires;
    assert.equal(requires.includes("challenge_activation"), false, `${intent} runs before activation`);
    assert.equal(requires.includes("evidence_cutoff"), false, `${intent} runs before the cutoff`);
  }
});

test("PREREQ-MATRIX: every environment intent accepts its own departure states", () => {
  for (const intent of ENVIRONMENT_INTENTS) {
    for (const state of JOURNEY_PREREQUISITES[intent].departsFrom) {
      assertJourneyPrerequisites(intent, allSatisfied(state));
    }
  }
});

test("PREREQ-MATRIX: every environment intent refuses every state it does not depart from", () => {
  for (const intent of ENVIRONMENT_INTENTS) {
    const permitted = new Set<string>(JOURNEY_PREREQUISITES[intent].departsFrom);
    for (const state of LAB_STATES) {
      if (permitted.has(state)) continue;
      assert.throws(
        () => assertJourneyPrerequisites(intent, allSatisfied(state)),
        (error: unknown) => (error as { code?: string }).code === "POLICY_CONFLICT",
        `${intent} must refuse to depart from ${state}`,
      );
    }
  }
});

test("PREREQ-MATRIX: withholding any single prerequisite refuses the intent that owes it", () => {
  let checked = 0;
  for (const intent of ENVIRONMENT_INTENTS) {
    const row = JOURNEY_PREREQUISITES[intent];
    // Departure from the *last* permitted state, so a post-capture intent is
    // tested from `step_outcome_frozen` too — the state the old single-state gate
    // never covered.
    for (const state of row.departsFrom) {
      for (const prerequisite of row.requires) {
        assert.throws(
          () => assertJourneyPrerequisites(intent, withheld(state, prerequisite)),
          (error: unknown) => (error as { code?: string }).code === "POLICY_CONFLICT",
          `${intent} from ${state} must refuse when ${prerequisite} is missing`,
        );
        checked += 1;
      }
    }
  }
  // A count, so a matrix that silently loses its rows fails rather than passing
  // vacuously.
  assert.ok(checked >= 100, `expected a wide sweep, checked ${String(checked)} combinations`);
});

test("PREREQ-MATRIX: this is P1-9 — a post-capture intent refuses in the pre-activation state", () => {
  // Exactly the state the review's reproduction sat in: the journey has connected
  // and discovered, so it is in `step_outcome_frozen`, and the old gate
  // (`state === "execution_plan_frozen" && …`) did not fire at all.
  const preActivation: JourneyPrerequisiteEvidence = {
    state: "step_outcome_frozen",
    hasRole: (role) =>
      [
        "package-verification-record",
        "selected-challenge-journey-binding",
        "environment-resource-inventory",
        "environment-baseline",
        "execution-plan",
      ].includes(role),
    connectSucceeded: true,
    completedStepCount: 5,
  };
  for (const intent of ["exercise", "observe", "remove"] satisfies JourneyIntent[]) {
    assert.throws(
      () => assertJourneyPrerequisites(intent, preActivation),
      (error: unknown) => {
        const message = (error as Error).message;
        return (
          (error as { code?: string }).code === "POLICY_CONFLICT" &&
          message.includes("challenge_activation") &&
          message.includes("evidence_cutoff")
        );
      },
      `${intent} must refuse before activation and before the cutoff`,
    );
  }
  // And a setup intent in the same state is still legal, so the refusal above is
  // about the prerequisites and not about the state.
  assertJourneyPrerequisites("discover", preActivation);
});

test("PREREQ-MATRIX: no intent departs from a state where subject execution is forbidden", () => {
  for (const intent of ENVIRONMENT_INTENTS) {
    for (const state of JOURNEY_PREREQUISITES[intent].departsFrom) {
      assert.equal(
        NO_SUBJECT_EXECUTION_STATES.has(state),
        false,
        `${intent} departs from ${state}, where no subject may execute`,
      );
    }
  }
});

test("PREREQ-MATRIX: the pre-reveal subject cleanup edge is recorded and not enabled", () => {
  // Design v2 §12 permits recover/rollback/remove from
  // `pre_reveal_subject_cleanup_started`. That edge has never shipped. The row
  // records the design's permission; the enabled set does not include it; and the
  // refusal says so rather than pretending the design forbids it.
  for (const intent of ["recover", "rollback", "remove"] satisfies JourneyIntent[]) {
    const row = JOURNEY_PREREQUISITES[intent];
    assert.deepEqual(row.designAlsoPermits, ["pre_reveal_subject_cleanup_started"]);
    assert.equal(row.departsFrom.includes("pre_reveal_subject_cleanup_started"), false);
    assert.throws(
      () => assertJourneyPrerequisites(intent, allSatisfied("pre_reveal_subject_cleanup_started")),
      (error: unknown) => (error as Error).message.includes("that edge is not enabled"),
    );
  }
});
