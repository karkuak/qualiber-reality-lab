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
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { assertSubjectPortExecutable, type LabState } from "@erl2/core";
import { erl2, runToAcquired } from "../support/cliRun.js";

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

/*
 * §8.2 — a refusal causes zero new retained evidence.
 *
 * The guard above was wired into the two *port-dispatching* entrypoints
 * (`acquire`, `verify-package`) but not into the two *artifact-freezing* ones.
 * `freezePackage` and `freezeSubjectOutput` froze their bytes first and only
 * then appended the lifecycle event that rejects an ineligible state — so a
 * post-terminal retry was correctly refused with exit 11 and *still* wrote into
 * the finished run.  Reproduced through the CLI: a refused post-terminal
 * `freeze-output` froze `retained/subject-output-manifest.json` into a cancelled
 * run and turned its previously verifying `InvalidLabRunRecordV1` into a
 * `GRAPH_CLOSURE_EXTRA_ARTIFACT` refusal.
 */
test("POST-TERMINAL-NO-WRITE: every refused post-terminal command adds zero retained evidence", () => {
  const run = runToAcquired();
  const base = [
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ];
  const cancelled = erl2(["cancel", ...base, "--reason", "operator_abort"]);
  assert.equal(cancelled.exitCode, 12, JSON.stringify(cancelled.body.errors));

  const retainedDir = path.join(run.runRoot, "retained");
  const snapshot = (): readonly string[] =>
    existsSync(retainedDir) ? [...readdirSync(retainedDir)].sort() : [];
  const before = snapshot();

  const attempts: readonly (readonly [string, readonly string[]])[] = [
    ["freeze-package", ["freeze-package", ...base]],
    [
      "verify-package",
      ["verify-package", ...base, "--fake-verify-package", "failed", "--subject-id", "s", "--subject-version", "0.1.0"],
    ],
    ["freeze-output", ["freeze-output", ...base, "--terminal-stage", "verify_package"]],
  ];
  for (const [label, argv] of attempts) {
    const result = erl2(argv);
    assert.equal(
      result.body.errors[0]?.code,
      "STATE_POST_REVEAL_EXECUTION_FORBIDDEN",
      `${label} must be refused by the pre-dispatch guard: ${JSON.stringify(result.body.errors)}`,
    );
    assert.deepEqual(snapshot(), before, `${label} must add no retained evidence`);
  }

  // Exactly one terminal record, and no fabricated finding.
  assert.equal(before.filter((n) => n === "invalid-run-record.json").length, 1);
  assert.equal(before.filter((n) => n.startsWith("finding-")).length, 0);
});
