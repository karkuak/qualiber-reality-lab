/**
 * Oracle-canary surface coverage honesty (6R-C, review P2-11, §8.6, FR-016).
 *
 * The design declares eight canary-scan surfaces. Slice 6.5-C brought three more
 * onto live paths, because the environment walk finally *produces* them: the
 * source snapshots the observation is built from, the canonical evidence entries
 * an adapter can mount, and the subject output before it freezes.
 *
 * The requirement is unchanged and is the reason this test exists: do NOT claim
 * scanning on surfaces that are never scanned. The four still pending are named
 * individually below, so a regression that quietly claimed full coverage — or
 * dropped a live scan — fails here rather than in a report.
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

test("ORACLE-COVERAGE: exactly the four produced surfaces are live; the rest are honestly pending", () => {
  assert.deepEqual(
    [...LIVE_ORACLE_SCAN_SURFACES].sort(),
    ["adapter_request", "lab_telemetry", "mounted_file", "subject_output_prefill"],
    "the live scope must not over-claim",
  );
  // Live ∪ pending is exactly the full declared set, with no overlap.
  assert.deepEqual(
    [...LIVE_ORACLE_SCAN_SURFACES, ...PENDING_ORACLE_SCAN_SURFACES].sort(),
    [...ORACLE_SCAN_SURFACES].sort(),
    "every declared surface is classified as live or pending exactly once",
  );
  assert.ok(PENDING_ORACLE_SCAN_SURFACES.length >= 1, "the pending surfaces must be recorded, not hidden");
  // Named individually rather than derived, so adding a surface to the live list
  // without a producer cannot silently empty this check.
  //
  //   environment_variable / process_argument — set by the Slice 5 adapter host,
  //     not by the environment walk;
  //   diagnostics — needs a subject that emits them; the development fake port
  //     emits none;
  //   network_egress — needs a run that egresses; no shipped path does.
  for (const surface of [
    "environment_variable",
    "process_argument",
    "diagnostics",
    "network_egress",
  ] as const) {
    assert.ok(PENDING_ORACLE_SCAN_SURFACES.includes(surface), `${surface} must be recorded as pending, not live`);
    assert.ok(!LIVE_ORACLE_SCAN_SURFACES.includes(surface), `${surface} is not scanned live and must not claim to be`);
  }
});

test("ORACLE-COVERAGE: every live surface is fail-closed on token detection", () => {
  // Detection depends on neither the surface nor a known-id list: any canary on
  // any live surface is a finding and a refusal. A surface that were listed live
  // but scanned with a different predicate would fail here.
  for (const surface of LIVE_ORACLE_SCAN_SURFACES) {
    const targets = [{ surface, label: `${surface} sample`, bytes: `{"x":"${CANARY}"}` }];
    const findings = scanForCanaries(targets, []);
    assert.equal(findings.length, 1, `${surface} did not detect a canary token`);
    assert.equal(findings[0]?.surface, surface);
    assert.throws(() => assertNoCanaryLeak(targets, []), `${surface} is not fail-closed`);
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
