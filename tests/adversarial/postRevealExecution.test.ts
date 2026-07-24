/**
 * Pre-dispatch no-execution guard (6R-B, review P2-5 / §8.2, ERL2-FR-007/AC-012).
 *
 * The engine only refused post-reveal execution *inside* `runStep`, after the
 * port had already run.  `assertSubjectPortExecutable` is the fail-closed guard
 * a command calls *before* dispatching the port, so a stray execution on a
 * revealed, finalized or invalidating run never reaches the subject at all.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assertSubjectPortExecutable, type LabState } from "@erl2/core";

// Every external-execution entrypoint the review enumerates, plus the terminal
// and invalidation states.
const FORBIDDEN: readonly LabState[] = [
  "judge_journey_expectation_revealed",
  "truth_revealed",
  "functional_journey_result_frozen",
  "nonfunctional_journey_result_frozen",
  "domain_result_frozen",
  "domain_not_applicable_frozen",
  "generic_precleanup_results_complete",
  "pre_environment_cleanup_started",
  "pre_environment_validity_result_frozen",
  "generic_evaluation_index_frozen",
  "generic_finalized",
  "deep_result_frozen",
  "deep_supplement_finalized",
  "invalid_failure_detected",
  "invalid_cleanup_terminal",
  "invalid_lab_run_record_frozen",
  "invalidated",
];

// States where a subject step legitimately still runs.
const ALLOWED: readonly LabState[] = [
  "acquisition_preregistered",
  "step_planned",
  "step_started",
  "step_outcome_frozen",
  "subject_package_frozen",
  "package_manifest_frozen",
];

test("POST-REVEAL-GUARD: subject execution is refused in every revealed/terminal/invalidating state", () => {
  for (const state of FORBIDDEN) {
    assert.throws(
      () => assertSubjectPortExecutable(state),
      (e: unknown) => (e as { code?: string }).code === "STATE_POST_REVEAL_EXECUTION_FORBIDDEN",
      `execution must be forbidden in ${state}`,
    );
  }
});

test("POST-REVEAL-GUARD: subject execution is permitted while a step is legitimately pending", () => {
  for (const state of ALLOWED) {
    assert.doesNotThrow(() => assertSubjectPortExecutable(state), `execution must be permitted in ${state}`);
  }
});
