/**
 * Slice 2 exit gate: a fake valid pre-environment run verifies offline, and a
 * fake invalid run verifies offline with no attestation and no bundle.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { verifyInvalidRecord, verifyPublicBundle } from "@erl2/public-verifier";
import {
  runFakeEnvironmentEmergencyCleanupRun,
  runFakeInvalidRun,
  runFakeValidPreEnvironmentRun,
} from "../support/fakeRun.js";

test("NOOP-LIFECYCLE: fake valid pre-environment run verifies offline", () => {
  const run = runFakeValidPreEnvironmentRun();
  const result = verifyPublicBundle({
    bundle: run.bundle,
    artifactRoot: run.root,
    lifecycle: run.lifecycle,
    localTrust: run.localTrust,
    verifiedAt: "2026-07-02T00:00:00Z",
    offline: true,
  });
  assert.equal(result.verdict, "valid");
  assert.equal(result.closure.derived_terminal_variant, "pre_environment");
  assert.equal(result.closure.derived_terminal_phase, "verify_package");
  assert.deepEqual(result.closure.missing_roles, []);
  assert.equal(result.validWhenSigned, true);
  assert.equal(result.currentlyTrusted, true);
});

test("INVALID-TERMINAL: cancellation freezes one invalid record and no bundle", () => {
  const run = runFakeInvalidRun("cancellation");
  const closure = verifyInvalidRecord({
    record: run.invalidRecord,
    artifactRoot: run.root,
    lifecycle: run.lifecycle,
    localTrust: run.localTrust,
    verifiedAt: "2026-07-02T00:00:00Z",
    offline: true,
  });
  assert.equal(closure.derived_terminal_variant, "invalid");
  assert.equal(closure.verdict, "valid");
});

test("INVALID-REASON-PHASE: classified lab failure retains its primary finding", () => {
  const run = runFakeInvalidRun("classified_lab_failure");
  const closure = verifyInvalidRecord({
    record: run.invalidRecord,
    artifactRoot: run.root,
    lifecycle: run.lifecycle,
    localTrust: run.localTrust,
    verifiedAt: "2026-07-02T00:00:00Z",
    offline: true,
  });
  const roles = closure.required_hashes_by_role.map((r) => r.role);
  assert.ok(roles.includes("reached-evidence"));
});

test("VERIFY-RECORD: a public bundle is refused by verify-record", () => {
  const run = runFakeValidPreEnvironmentRun();
  assert.throws(
    () =>
      verifyInvalidRecord({
        record: run.bundle,
        artifactRoot: run.root,
        lifecycle: run.lifecycle,
        localTrust: run.localTrust,
        verifiedAt: "2026-07-02T00:00:00Z",
        offline: true,
      }),
    /VERIFY_RECORD_ATTESTATION_PRESENT|verify-record does not accept/,
  );
});

test("EMERGENCY-CLEANUP: restoration failure reaches the invalid record only through receipt-backed emergency cleanup", () => {
  const run = runFakeEnvironmentEmergencyCleanupRun();
  const closure = verifyInvalidRecord({
    record: run.invalidRecord,
    artifactRoot: run.root,
    lifecycle: run.lifecycle,
    localTrust: run.localTrust,
    verifiedAt: "2026-07-02T00:00:00Z",
    offline: true,
  });
  assert.equal(closure.derived_terminal_variant, "invalid");
  assert.equal(closure.verdict, "valid");
  assert.deepEqual(closure.rejected_extra_hashes, []);

  const record = run.invalidRecord as {
    cleanup: { variant: string; result_hash: string; attempt_hashes: string[] };
  };
  assert.equal(record.cleanup.variant, "emergency_environment");
  assert.ok(record.cleanup.attempt_hashes.length > 0, "safe actions must carry attempt receipts");
});

test("EMERGENCY-CLEANUP: bypassing emergency cleanup after a restoration failure is refused", () => {
  const run = runFakeEnvironmentEmergencyCleanupRun();
  const bypassed = {
    ...(run.invalidRecord as Record<string, unknown>),
    cleanup: { variant: "environment", status: "attempted_succeeded", attempt_hashes: [], result_hash: undefined },
  };
  assert.throws(
    () =>
      verifyInvalidRecord({
        record: bypassed,
        artifactRoot: run.root,
        lifecycle: run.lifecycle,
        localTrust: run.localTrust,
        verifiedAt: "2026-07-02T00:00:00Z",
        offline: true,
      }),
    (error: unknown) =>
      ["SCHEMA_VALIDATION_FAILED", "EMERGENCY_CLEANUP_BYPASSED"].includes(
        (error as { code: string }).code,
      ),
  );
});
