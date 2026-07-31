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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LIVE_ORACLE_SCAN_SURFACES,
  ORACLE_SCAN_SURFACES,
  PENDING_ORACLE_SCAN_SURFACES,
  assertNoCanaryLeak,
  scanForCanaries,
} from "@erl2/core";

const CANARY = `erl2-canary-${"a1b2c3d4".repeat(4)}`; // erl2-canary- + 32 hex chars

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const controls = (await import(
  pathToFileURL(path.join(repoRoot, "scripts", "negative-control.mjs")).href
)) as unknown as { readonly CONTROLS: readonly { readonly id: string }[] };

/**
 * What each live surface must be able to point at.
 *
 * The review's finding about this file was precise and it was right: the cases
 * below prove the *scanner* recognises a target labelled with a surface, which
 * "does not prove production calls the scanner for that surface, so it cannot
 * catch a dropped scan". Two of the four claimed-live surfaces were defective at
 * the time and this file said nothing.
 *
 * A label is not evidence. Two things are, and a surface may not be called live
 * without both:
 *
 *   - a **production-path regression**: a named test that plants the leak in
 *     admitted data or in the subject's own bytes and drives the shipped binary,
 *     so the refusal comes from a run rather than from a constructed target;
 *   - a **negative control**: a named control that disables that one scan, after
 *     which the regression must fail. This is what makes "the scan is reached"
 *     falsifiable instead of asserted.
 *
 * Written out by hand, per surface. A derived table would be satisfied by
 * whatever the code happens to do, which is the failure this is here to prevent.
 */
interface SurfaceEvidence {
  readonly test?: string;
  readonly control?: string;
  /** Why no control can kill this scan, when none can. Never empty. */
  readonly shadowed?: string;
}

const LIVE_SURFACE_EVIDENCE: Readonly<Record<string, SurfaceEvidence>> = {
  lab_telemetry: {
    test: "tests/e2e/environmentEvidenceBoundaries.test.ts",
    control: "lab-telemetry-oracle-scan",
  },
  mounted_file: {
    test: "tests/e2e/environmentEvidenceBoundaries.test.ts",
    control: "mounted-file-byte-scan",
  },
  subject_output_prefill: {
    test: "tests/e2e/environmentRun.test.ts",
    control: "subject-output-canary-scan",
  },
  // The Lab-side request scan is live and it is *shadowed*, which is a different
  // thing from unproven and must not be reported as either "load-bearing" or
  // "missing".
  //
  // An `AdapterStepRequestV1` carries hashes, a run id, an operation id, a
  // deadline and an `ArtifactRef` to the visible step. The only field that can
  // carry attacker-influenced text is that reference's *path*, which is built
  // from the step id — and since Step 6B the same step's bytes are scanned as a
  // `mounted_file` and refused one call earlier, before the file exists. So every
  // input that could reach this scan is refused in front of it.
  //
  // That is a strictly better outcome than the previous ordering (which published
  // the mount and then refused the request naming it), and the cost is that no
  // shipped input can demonstrate this particular call. Recording that is the
  // honest report; claiming a fourth load-bearing surface would not be.
  adapter_request: {
    shadowed:
      "every request field that could carry a token is either a hash or the visible-step path, " +
      "and the step's own bytes are refused as a mounted_file before the request is built",
  },
};

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

test("ORACLE-COVERAGE: every live surface names a production regression and a control that kills it", () => {
  const missing: string[] = [];
  const controlIds = new Set(controls.CONTROLS.map((control) => control.id));
  for (const surface of LIVE_ORACLE_SCAN_SURFACES) {
    const evidence = LIVE_SURFACE_EVIDENCE[surface];
    if (evidence === undefined) {
      missing.push(`${surface}: claimed live with no production regression and no control`);
      continue;
    }
    if (evidence.shadowed !== undefined) {
      if (evidence.shadowed.length === 0) missing.push(`${surface}: shadowed with no stated reason`);
      if (evidence.control !== undefined || evidence.test !== undefined) {
        missing.push(`${surface}: claims both a shadowed reason and its own evidence`);
      }
      continue;
    }
    if (evidence.test === undefined || !existsSync(path.join(repoRoot, evidence.test))) {
      missing.push(`${surface}: names ${String(evidence.test)}, which does not exist`);
    }
    if (evidence.control === undefined || !controlIds.has(evidence.control)) {
      missing.push(`${surface}: names control ${String(evidence.control)}, which is not in the shipped table`);
    }
  }
  // And nothing pending may claim evidence it does not have.
  for (const surface of PENDING_ORACLE_SCAN_SURFACES) {
    if (LIVE_SURFACE_EVIDENCE[surface] !== undefined) {
      missing.push(`${surface}: recorded as pending while claiming production evidence`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "a surface is live when a shipped run refuses on it and a control proves that refusal is load-bearing",
  );
});

test("ORACLE-COVERAGE: the mounted-file scan reads content, not a descriptor about it", () => {
  // The defect in one line. `mounted_file` used to be scanned with
  // `JSON.stringify(entry)` over `{entryId, sourceContentHash, artifact, sourceState}`
  // — four fields that are an id, a state and two digests. No canary in the
  // mounted *content* can appear in any of them, so the scan could not fail.
  //
  // Asserted against the source, because the property is that the production call
  // site passes bytes rather than a descriptor, and no runtime value can show
  // that a different value was once passed.
  const source = readFileSync(
    path.join(repoRoot, "packages", "core", "src", "run", "environmentRun.ts"),
    "utf8",
  );
  assert.ok(
    !source.includes('surface: "mounted_file"'),
    "the environment run must not build a mounted-file scan target of its own; " +
      "publication and scanning are one operation in `freezeMountedFile`",
  );
  const workspace = readFileSync(
    path.join(repoRoot, "packages", "core", "src", "run", "workspace.ts"),
    "utf8",
  );
  assert.ok(
    workspace.includes('surface: "mounted_file" as const, label, bytes'),
    "the mounted-file scan must receive the published bytes themselves",
  );
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
