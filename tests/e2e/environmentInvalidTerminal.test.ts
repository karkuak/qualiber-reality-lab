/**
 * The invalid environment terminal (Slice 6.5-D).
 *
 * ERL2-FR-001: every durably accepted run that cannot reach a valid terminal must
 * still reach *a* terminal. An environment run's is not the pre-environment one —
 * it has real resources, so cleanup is derived from the actual resource frontier.
 *
 * Design §12 is stricter still about two of these: a restoration or teardown
 * failure MUST enter receipt-backed emergency cleanup. There is no direct edge
 * from either to the invalid record, and these cases assert the route as well as
 * the outcome.
 *
 * Every failure is produced by a *driver* fault, not by hand-built evidence, and
 * every record is then read back by the shipped `erl2 verify-record` in a fresh
 * process.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { erl2, runToAcquired, writeLifecycle, writeTrustConfig } from "../support/cliRun.js";
import type { GovernorRegistry } from "../support/governorRegistry.js";

interface Run {
  readonly runRoot: string;
  readonly runId: string;
  readonly registry: GovernorRegistry;
  readonly base: readonly string[];
}

function selectedRun(): Run {
  const run = runToAcquired();
  const base = [
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ];
  assert.equal(erl2(["freeze-package", ...base]).exitCode, 0);
  assert.equal(
    erl2([
      "verify-package", ...base, "--fake-verify-package", "succeeded",
      "--subject-id", "s", "--subject-version", "0.1.0",
    ]).exitCode,
    0,
  );
  assert.equal(
    erl2([
      "preregister-challenge", ...base,
      "--journey-selection-policy", run.registry.journeySelectionPolicyHash,
      "--randomness-policy", run.registry.randomnessPolicyHash,
      ...run.registry.challengeCandidates.flatMap((c) => ["--challenge", c.challengeManifestHash]),
    ]).exitCode,
    0,
  );
  const sourceTrust = path.join(run.runRoot, "source-trust.json");
  writeFileSync(
    sourceTrust,
    JSON.stringify({
      sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
      randomnessRegistryHeadHash: run.registry.sourceTrustPolicyHash,
    }),
  );
  assert.equal(
    erl2(["select", ...base, "--source-trust-config", sourceTrust, "--expires", "2026-12-31T00:00:00Z"])
      .body.state,
    "case_selected",
  );
  return { runRoot: run.runRoot, runId: run.runId, registry: run.registry, base };
}

/** Drives the environment path to just before `restore`, with a scripted fault. */
function toResultJoin(run: Run, fault?: string): void {
  const f = fault === undefined ? [] : ["--fake-driver-fault", fault];
  const plan: readonly (readonly [string, readonly string[]])[] = [
    ["provision", ["provision", ...run.base, "--archetype", run.registry.archetypeHash, ...f]],
    ["baseline", ["baseline", ...run.base, ...f]],
    ["plan", ["plan", ...run.base, ...f]],
    ["install", ["install", ...run.base, ...f]],
    ["configure", ["configure", ...run.base, ...f]],
    ["authenticate", ["authenticate", ...run.base, ...f]],
    ["connect", ["connect", ...run.base, ...f]],
    ["discover", ["execute-subject", ...run.base, ...f]],
    ["activate", ["activate", ...run.base, ...f]],
    [
      "journey",
      [
        "journey", ...run.base, ...f,
        "--comparison-policy", run.registry.comparisonPolicyHash,
        "--cutoff-policy", run.registry.cutoffPolicyHash,
      ],
    ],
    ["observe", ["observe", ...run.base, ...f]],
    ["freeze-observation", ["freeze-observation", ...run.base, ...f]],
    ["exercise", ["execute-subject", ...run.base, ...f]],
    ["observe-step", ["execute-subject", ...run.base, ...f]],
    ["remove", ["remove", ...run.base, ...f]],
    ["freeze-output", ["freeze-output", ...run.base, ...f]],
    ["reveal", ["reveal", ...run.base, ...f, "--vault", run.registry.vaultRoot]],
    ["evaluate", ["evaluate", ...run.base, ...f]],
  ];
  for (const [name, argv] of plan) {
    const result = erl2(argv);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
  }
}

/**
 * The run's durable state trace.
 *
 * Read as `state_to`, not `event_type`: §12 constrains the state machine, and the
 * detection event is named for the phase that failed (`environment_restoration_failed`)
 * precisely so the stream says *what* failed as well as *that* it did.
 */
function events(run: Run): readonly string[] {
  const dir = path.join(run.runRoot, "events");
  return readdirSync(dir)
    .sort()
    .map((n) => (JSON.parse(readFileSync(path.join(dir, n), "utf8")) as { state_to: string }).state_to);
}

function invalidRecord(run: Run): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", "invalid-run-record.json"), "utf8"),
  ) as Record<string, unknown>;
}

/** Reads the invalid record back through the shipped verifier, offline. */
function verifyRecord(run: Run): ReturnType<typeof erl2> {
  return erl2([
    "verify-record",
    "--record", path.join(run.runRoot, "retained", "invalid-run-record.json"),
    "--lifecycle", writeLifecycle(run.runRoot),
    "--artifact-root", run.runRoot,
    "--root-config", writeTrustConfig(run.runRoot),
    "--offline",
  ]);
}

test("ENV-INVALID: a restoration failure enters emergency cleanup and freezes one invalid record", () => {
  const run = selectedRun();
  toResultJoin(run, "failed-restore");

  const failed = erl2(["restore", ...run.base, "--fake-driver-fault", "failed-restore"]);
  assert.notEqual(failed.exitCode, 0, "a failed restoration cannot report success");
  assert.equal(failed.body.errors[0]?.code, "RESTORATION_FAILED");
  // Appendix C: a durably accepted run may not return a terminal state without
  // its record hash, even when the command exits on the failure.
  const data = failed.body.data as { invalid_run_record_hash: string; cleanup_variant: string };
  assert.ok(data.invalid_run_record_hash, "the terminal record hash is returned");
  assert.equal(data.cleanup_variant, "emergency_environment");
  assert.equal(failed.body.state, "invalidated");

  // The route, not just the destination: §12 forbids a direct edge from a
  // restoration failure to the invalid record.
  const trace = events(run);
  const order = [
    "invalid_failure_detected",
    "invalid_environment_cleanup_started",
    "emergency_cleanup_started",
    "emergency_cleanup_terminal",
    "invalid_lab_run_record_frozen",
    "invalidated",
  ];
  const indices = order.map((type) => trace.findIndex((t) => t === type));
  for (const [i, index] of indices.entries()) {
    assert.ok(index >= 0, `the run never reached ${order[i] as string}`);
    if (i > 0) assert.ok(index > (indices[i - 1] as number), `${order[i] as string} is out of order`);
  }
  assert.equal(
    trace.filter((t) => t === "invalid_lab_run_record_frozen").length,
    1,
    "exactly one invalid record",
  );
  assert.ok(
    readdirSync(path.join(run.runRoot, "events"))
      .sort()
      .map((n) => (JSON.parse(readFileSync(path.join(run.runRoot, "events", n), "utf8")) as { event_type: string }).event_type)
      .includes("environment_restoration_failed"),
    "the event stream names the phase that failed",
  );

  const record = invalidRecord(run);
  assert.equal((record["failed_phase"] as { phase: string }).phase, "environment_restoration");
  assert.equal(
    (record["terminal_reason"] as { classification: string }).classification,
    "cleanup_failure",
  );
});

test("ENV-INVALID: every independently safe emergency action is attempted and receipted", () => {
  const run = selectedRun();
  toResultJoin(run, "failed-restore");
  assert.notEqual(erl2(["restore", ...run.base, "--fake-driver-fault", "failed-restore"]).exitCode, 0);

  const emergency = JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", "emergency-cleanup-verification.json"), "utf8"),
  ) as {
    all_independently_safe_actions_attempted: boolean;
    actions: { status: string; attempt_receipt_hash?: string; reason_code?: string }[];
    remaining_resources: unknown[];
  };
  assert.equal(emergency.all_independently_safe_actions_attempted, true);
  assert.ok(emergency.actions.length > 0, "an emergency cleanup with no actions proves nothing");
  for (const action of emergency.actions) {
    if (action.status === "skipped_unsafe") {
      // Skipped-unsafe carries a reason and *no* receipt: the Lab did not touch it.
      assert.ok(action.reason_code, "an unsafe skip must carry its reason");
      assert.equal(action.attempt_receipt_hash, undefined, "an unsafe skip must have no receipt");
      continue;
    }
    assert.ok(action.attempt_receipt_hash, `attempted action ${action.status} has no receipt`);
    if (action.status === "failed") assert.ok(action.reason_code, "a failed attempt must carry its reason");
  }
});

test("ENV-INVALID: a teardown failure takes the same authorized route", () => {
  const run = selectedRun();
  toResultJoin(run);
  assert.equal(erl2(["restore", ...run.base]).exitCode, 0);

  const failed = erl2(["destroy", ...run.base, "--fake-driver-fault", "failed-teardown"]);
  assert.notEqual(failed.exitCode, 0);
  assert.equal(failed.body.errors[0]?.code, "TEARDOWN_FAILED");
  assert.equal(failed.body.state, "invalidated");
  const trace = events(run);
  assert.ok(trace.includes("emergency_cleanup_started"), "a teardown failure enters emergency cleanup");
  const record = invalidRecord(run);
  assert.equal((record["failed_phase"] as { phase: string }).phase, "teardown");
  assert.equal(
    (record["terminal_reason"] as { classification: string }).classification,
    "teardown_failure",
  );
});

test("ENV-INVALID: a contaminated baseline is Lab-owned and never a subject defect", () => {
  const run = selectedRun();
  assert.equal(
    erl2(["provision", ...run.base, "--archetype", run.registry.archetypeHash]).exitCode,
    0,
  );

  const failed = erl2(["baseline", ...run.base, "--fake-driver-fault", "contaminated-baseline"]);
  assert.notEqual(failed.exitCode, 0);
  assert.equal(failed.body.errors[0]?.code, "BASELINE_CONTAMINATION_DETECTED");
  assert.equal(failed.body.state, "invalidated");

  const record = invalidRecord(run);
  assert.equal((record["failed_phase"] as { phase: string }).phase, "baseline");
  // Lab-owned, not `adapter_failure` and not a subject finding: the environment
  // was not clean, so nothing about the subject was measured.
  assert.equal(
    (record["terminal_reason"] as { classification: string }).classification,
    "lab_invalidity",
  );
  // A pre-environment cleanup on a run that provisioned an environment would be
  // the wrong branch entirely.
  assert.notEqual((record["cleanup"] as { variant: string }).variant, "pre_environment");
});

test("ENV-INVALID: no attestation or public bundle descends from an invalid record", () => {
  const run = selectedRun();
  toResultJoin(run, "failed-restore");
  assert.notEqual(erl2(["restore", ...run.base, "--fake-driver-fault", "failed-restore"]).exitCode, 0);

  const retained = readdirSync(path.join(run.runRoot, "retained"));
  assert.ok(!retained.includes("final-attestation.json"), "an invalid run has no attestation");
  assert.ok(!retained.includes("public-bundle.json"), "an invalid run has no public bundle");

  // And finalization stays refused rather than quietly producing one.
  const finalize = erl2(["finalize-generic", ...run.base]);
  assert.notEqual(finalize.exitCode, 0);
  assert.ok(finalize.body.errors[0]?.code);
});

test("ENV-INVALID: the run's substrate reservations are released", () => {
  const run = selectedRun();
  toResultJoin(run, "failed-restore");
  assert.notEqual(erl2(["restore", ...run.base, "--fake-driver-fault", "failed-restore"]).exitCode, 0);
  const held = readdirSync(`${path.resolve(run.runRoot)}.reservations`).filter((n) =>
    n.endsWith(".lease.json"),
  );
  assert.deepEqual(held, [], "a failed run must not hold its identities forever");
});

test("ENV-INVALID: --fake-driver-fault is unreachable without the development profile", () => {
  // The release surface refuses the flag outright, the same way `--fake-acquire`
  // is refused: a scripted substrate failure must not be reachable from it.
  const run = selectedRun();
  const result = erl2(
    ["provision", ...run.base, "--archetype", run.registry.archetypeHash, "--fake-driver-fault", "failed-restore"],
    { developmentProfile: false },
  );
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.body.errors[0]?.code, "CFG_DEVELOPMENT_FLAG_UNAVAILABLE");
});

test("ENV-INVALID: the invalid record verifies offline through the shipped verifier", () => {
  const run = selectedRun();
  toResultJoin(run, "failed-restore");
  assert.notEqual(erl2(["restore", ...run.base, "--fake-driver-fault", "failed-restore"]).exitCode, 0);

  const verified = verifyRecord(run);
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  assert.equal(verified.body.state, "invalidated");
});
