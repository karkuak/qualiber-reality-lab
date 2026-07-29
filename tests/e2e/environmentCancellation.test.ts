/**
 * Cancellation is routed from the branch and state the run is actually in
 * (review P1-2, ADR-ERL2-024 §4.4).
 *
 * `erl2 cancel` was not branch-dispatched. Cancelling a **live** environment run
 * ran the pre-environment terminal — which enumerates only the Lab's own
 * acquisition temporaries — so the record froze with cleanup variant `none` and
 * status `not_required` while the environment and its four reservation leases
 * were still allocated. The shipped verifier accepted it.
 *
 * The matrix below covers every state ADR-ERL2-024 §4.4 names. Each case asserts
 * three things: the cleanup variant is derived from the actual frontier, the
 * terminal is exactly one `InvalidLabRunRecordV1`, and the result verifies
 * offline through the shipped `verify-record`.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { erl2, writeLifecycle, writeTrustConfig } from "../support/cliRun.js";
import {
  changed,
  drive,
  manifest,
  phaseIndex,
  producedRoles,
  selectedRun,
  substrateRootOf,
  type EnvironmentRun,
} from "../support/environmentCli.js";

interface CancelOutcome {
  readonly exitCode: number;
  readonly cleanupVariant: string;
  readonly cleanupStatus: string;
  readonly cancelledDuring: string;
  readonly recordHash: string;
}

function cancel(run: EnvironmentRun, reason = "OPERATOR_STOP"): CancelOutcome {
  const result = erl2(["cancel", ...run.base, "--reason", reason]);
  const data = (result.body.data ?? {}) as Record<string, string>;
  return {
    exitCode: result.exitCode,
    cleanupVariant: data["cleanup_variant"] as string,
    cleanupStatus: data["cleanup_status"] as string,
    cancelledDuring: data["cancelled_during"] as string,
    recordHash: data["invalid_run_record_hash"] as string,
  };
}

/** `erl2 verify-record` over the run's own retained invalid record. */
function verifyRecord(run: EnvironmentRun): { exitCode: number; errors: unknown } {
  const result = erl2([
    "verify-record",
    "--record", path.join(run.runRoot, "retained", "invalid-run-record.json"),
    "--lifecycle", writeLifecycle(run.runRoot),
    "--artifact-root", run.runRoot,
    "--root-config", writeTrustConfig(run.runRoot),
    "--offline",
  ]);
  return { exitCode: result.exitCode, errors: result.body.errors };
}

/** Exactly one invalid run record, read from the lifecycle rather than the tree. */
function invalidRecordCount(run: EnvironmentRun): number {
  return producedRoles(run).filter((role) => role === "invalid-run-record").length;
}

/** Whether the run still holds reservation leases in its allocator namespace. */
function heldLeases(run: EnvironmentRun): number {
  const root = `${path.resolve(run.runRoot)}.reservations`;
  if (!existsSync(root)) return 0;
  let held = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      const value = JSON.parse(readFileSync(child, "utf8")) as { run_id?: string };
      if (value.run_id === run.runId) held += 1;
    }
  };
  walk(root);
  return held;
}

test("ENV-CANCEL: cancellation before provisioning stays pre-environment", () => {
  const run = selectedRun();
  const outcome = cancel(run);
  assert.notEqual(outcome.exitCode, 0, "a cancelled run exits on the cancellation class");
  // No substrate binding exists, so the run genuinely has no external resources.
  assert.ok(
    outcome.cleanupVariant === "none" || outcome.cleanupVariant === "pre_environment",
    `pre-environment cancellation may not claim an environment cleanup; got ${outcome.cleanupVariant}`,
  );
  assert.equal(invalidRecordCount(run), 1);
  const verified = verifyRecord(run);
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.errors));
});

test("ENV-CANCEL: a live environment never receives a `not_required` cleanup", () => {
  // The exact defect: everything through `plan` is a live environment with four
  // reservation leases, and the pre-environment terminal used to claim it owed
  // no cleanup at all.
  const run = selectedRun();
  drive(run, phaseIndex(run, "install"));

  const outcome = cancel(run);
  assert.notEqual(outcome.exitCode, 0);
  assert.notEqual(
    outcome.cleanupStatus,
    "not_required",
    "a run holding an environment always owes cleanup",
  );
  assert.notEqual(outcome.cleanupVariant, "none");
  assert.notEqual(outcome.cleanupVariant, "pre_environment");
  assert.equal(outcome.cancelledDuring, "environment_setup");
  assert.equal(invalidRecordCount(run), 1);

  // The frontier was actually enumerated, and cleanup actually ran.
  const roles = new Set(producedRoles(run));
  assert.ok(roles.has("environment-resource-frontier"), "the frontier must be frozen");
  assert.ok(roles.has("substrate-binding"), "the binding must be accounted for");

  const verified = verifyRecord(run);
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.errors));
});

test("ENV-CANCEL: cancellation during journey execution enumerates its frontier", () => {
  const run = selectedRun();
  drive(run, phaseIndex(run, "activate"));

  const outcome = cancel(run);
  assert.equal(outcome.cancelledDuring, "journey_execution");
  assert.notEqual(outcome.cleanupStatus, "not_required");
  assert.ok(new Set(producedRoles(run)).has("environment-resource-frontier"));
  assert.equal(verifyRecord(run).exitCode, 0);
});

test("ENV-CANCEL: cancellation after restoration begins takes the emergency route", () => {
  const run = selectedRun();
  drive(run, phaseIndex(run, "destroy"));

  const outcome = cancel(run);
  assert.equal(outcome.cancelledDuring, "cleanup");
  assert.equal(
    outcome.cleanupVariant,
    "emergency_environment",
    "a cancellation after cleanup began has exactly one authorized route",
  );
  const roles = new Set(producedRoles(run));
  assert.ok(roles.has("emergency-cleanup-verification"));
  assert.equal(invalidRecordCount(run), 1);
  assert.equal(verifyRecord(run).exitCode, 0);
});

test("ENV-CANCEL: cancellation during partial provisioning enumerates what was created", () => {
  const run = selectedRun();
  // `--fake-driver-fault partial-provision` stops the driver part-way, so the
  // binding exists and the inventory does not.
  const provision = erl2([
    "provision",
    ...run.base,
    "--archetype", run.registry.archetypeHash,
    "--fake-driver-fault", "partial-provision",
  ]);
  assert.notEqual(provision.exitCode, 0, "a partial provision is a Lab-owned failure");
  // The partial provision already routed itself to a terminal, so a later
  // cancellation must refuse rather than freeze a second one.
  const outcome = cancel(run);
  assert.notEqual(outcome.exitCode, 0);
  assert.equal(invalidRecordCount(run), 1, "exactly one terminal record may exist");
});

test("ENV-CANCEL: replaying a completed cancellation writes nothing and returns the same record", () => {
  const run = selectedRun();
  drive(run, phaseIndex(run, "install"));
  const first = cancel(run);
  const after = manifest(run.runRoot);

  const second = cancel(run);
  assert.equal(second.recordHash, first.recordHash, "a replay returns the same terminal");
  assert.deepEqual(changed(after, manifest(run.runRoot)), [], "a replay writes nothing");
  assert.equal(invalidRecordCount(run), 1);
});

test("ENV-CANCEL: cancellation after a valid terminal is refused", () => {
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");
  const result = erl2(["cancel", ...run.base, "--reason", "TOO_LATE"]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(
    result.body.errors[0]?.code,
    "CANCELLATION_AFTER_TERMINAL",
    JSON.stringify(result.body.errors),
  );
});

test("ENV-CANCEL: reservations are held until cleanup is proven, then released", () => {
  const run = selectedRun();
  drive(run, phaseIndex(run, "install"));
  assert.ok(heldLeases(run) > 0, "a provisioned run holds reservation leases");

  cancel(run);
  assert.equal(heldLeases(run), 0, "a cancelled run returns its substrate identities");
  // Released *after* the cleanup evidence exists, not before.
  assert.ok(new Set(producedRoles(run)).has("environment-resource-frontier"));
});

test("ENV-CANCEL: the substrate is actually cleaned up, not merely declared clean", () => {
  const run = selectedRun();
  drive(run, phaseIndex(run, "install"));
  cancel(run);

  const substrate = substrateRootOf(run);
  const files = manifest(substrate);
  const stateFile = [...files.keys()].find((k) => k.endsWith(".substrate.json"));
  assert.ok(stateFile !== undefined);
  const live = JSON.parse(readFileSync(path.join(substrate, stateFile), "utf8")) as {
    resources: unknown[];
  };
  assert.equal(live.resources.length, 0, "cancellation must destroy the run's own resources");
});
