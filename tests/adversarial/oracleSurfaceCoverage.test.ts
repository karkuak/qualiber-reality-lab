/**
 * Oracle-canary surface coverage honesty (6R-C, review P2-11, §8.6, FR-016).
 *
 * The design declares eight canary-scan surfaces, but only the adapter request
 * is scanned on the *shipped* pre-environment path (`assertRequestOracleClean`);
 * the rest belong to the environment/journey orchestration that lands in Slice
 * 6.5.  The review's requirement is honesty: do NOT claim scanning on surfaces
 * that are never scanned.  This test pins the live-vs-pending split so a
 * regression that quietly claimed full coverage — or dropped the one live scan —
 * fails, and proves the one live surface is genuinely fail-closed on token
 * detection.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  LIVE_ORACLE_SCAN_SURFACES,
  ORACLE_SCAN_SURFACES,
  PENDING_ORACLE_SCAN_SURFACES,
  assertNoCanaryLeak,
  scanForCanaries,
} from "@erl2/core";

const CANARY = `erl2-canary-${"a1b2c3d4".repeat(4)}`; // erl2-canary- + 32 hex chars

test("ORACLE-COVERAGE: only the adapter request is scanned live; the rest are honestly pending 6.5", () => {
  assert.deepEqual([...LIVE_ORACLE_SCAN_SURFACES], ["adapter_request"], "the live scope must not over-claim");
  // Live ∪ pending is exactly the full declared set, with no overlap.
  assert.deepEqual(
    [...LIVE_ORACLE_SCAN_SURFACES, ...PENDING_ORACLE_SCAN_SURFACES].sort(),
    [...ORACLE_SCAN_SURFACES].sort(),
    "every declared surface is classified as live or pending exactly once",
  );
  assert.ok(PENDING_ORACLE_SCAN_SURFACES.length >= 1, "the pending surfaces must be recorded, not hidden");
  // The surfaces the review named as declared-but-unscanned are pending, not claimed live.
  for (const surface of ["network_egress", "lab_telemetry", "mounted_file"] as const) {
    assert.ok(PENDING_ORACLE_SCAN_SURFACES.includes(surface), `${surface} must be recorded as pending, not live`);
    assert.ok(!LIVE_ORACLE_SCAN_SURFACES.includes(surface), `${surface} is not scanned live and must not claim to be`);
  }
});

test("ORACLE-COVERAGE: the live adapter-request surface is fail-closed on token detection", () => {
  // Detection does not depend on `knownCanaryIds` (which is empty today):
  // any canary token on the live surface is a finding and a refusal.
  const targets = [{ surface: "adapter_request" as const, label: "acquisition request", bytes: `{"x":"${CANARY}"}` }];
  const findings = scanForCanaries(targets, []);
  assert.equal(findings.length, 1, "a canary token in an adapter request must be detected with no known-id list");
  assert.equal(findings[0]?.surface, "adapter_request");
  assert.throws(() => assertNoCanaryLeak(targets, []), "a detected canary must be a fail-closed refusal");
});

test("ORACLE-COVERAGE: a clean adapter request is not a false positive", () => {
  const clean = [{ surface: "adapter_request" as const, label: "clean", bytes: `{"operation":"acquire"}` }];
  assert.deepEqual(scanForCanaries(clean, []), [], "a clean surface produces no finding");
  assert.doesNotThrow(() => assertNoCanaryLeak(clean, []));
});
