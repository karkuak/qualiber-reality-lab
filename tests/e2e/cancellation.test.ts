/**
 * Mandatory cancellation terminal (6R-B, review "missing mandatory cancellation";
 * design v2 §12).
 *
 * A durably-accepted, non-terminal run is cancelled through the shipped CLI in a
 * fresh process.  The run must freeze exactly one `InvalidLabRunRecordV1` with a
 * cancellation reason and no fabricated finding, exit on the cancellation class
 * (12), and the record must verify offline.  Cancelling a terminal run is
 * refused.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { erl2, erl2Run, runToAcquired, writeLifecycle, writeTrustConfig } from "../support/cliRun.js";

test("CANCELLATION: a mid-flight run cancels to exactly one invalid record with no finding", () => {
  const run = runToAcquired();

  const cancelled = erl2Run(run, ["cancel", "--reason", "operator_abort"]);
  assert.equal(cancelled.exitCode, 12, `cancellation must exit 12: ${JSON.stringify(cancelled.body.errors)}`);
  assert.equal(cancelled.body.errors[0]?.code, "CANCELLATION_REQUESTED");
  const data = cancelled.body.data as Record<string, unknown>;
  assert.ok(typeof data["invalid_run_record_hash"] === "string", "an invalid record hash is returned");
  assert.equal(data["terminal_state"], "invalidated");
  assert.equal(data["cancelled_during"], "pre_environment");

  // Exactly one invalid record; no fabricated finding on a cancellation terminal.
  const retained = readdirSync(path.join(run.runRoot, "retained"));
  const records = retained.filter((n) => n === "invalid-run-record.json");
  assert.equal(records.length, 1, "exactly one invalid record");
  const findings = retained.filter((n) => n.startsWith("finding-") && n.endsWith(".json"));
  assert.equal(findings.length, 0, "a cancellation terminal fabricates no finding");
  const cancellationRequest = retained.filter((n) => n === "cancellation-request.json");
  assert.equal(cancellationRequest.length, 1, "the signed cancellation request is retained");

  // The invalid record verifies offline in a fresh process.
  const verify = erl2([
    "verify-record",
    "--record", path.join(run.runRoot, "retained", "invalid-run-record.json"),
    "--lifecycle", writeLifecycle(run.runRoot),
    "--artifact-root", run.runRoot,
    "--root-config", writeTrustConfig(run.runRoot),
    "--offline",
  ]);
  assert.equal(verify.exitCode, 0, `the cancellation record must verify offline: ${JSON.stringify(verify.body.errors)}`);

  // The signed request records the observed phase and carries a cancellation reason.
  const request = JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", "cancellation-request.json"), "utf8"),
  ) as { schema_version: string; reason_code: string; cancelled_during: string; signature: unknown };
  assert.equal(request.schema_version, "cancellation-request/v1");
  assert.equal(request.reason_code, "operator_abort");
  assert.ok(request.signature, "the cancellation request is signed");
});

test("CANCELLATION: cancelling an already-terminal run is refused", () => {
  const run = runToAcquired();
  const first = erl2Run(run, ["cancel", "--reason", "operator_abort"]);
  assert.equal(first.exitCode, 12);
  const second = erl2Run(run, ["cancel", "--reason", "again"]);
  assert.notEqual(second.exitCode, 12, "a terminal run cannot be cancelled again");
  assert.equal(second.body.errors[0]?.code, "CANCELLATION_AFTER_TERMINAL");
  assert.equal(second.exitCode, 11, "refusing to cancel a terminal run is a forbidden-state exit");
});
