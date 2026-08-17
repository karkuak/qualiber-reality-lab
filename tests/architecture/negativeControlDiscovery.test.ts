/**
 * The campaign's scope is what the campaign can discover.
 *
 * ## What was broken
 *
 * Twelve `subject-adapter/v2` controls lived in `scripts/subject-adapter-v2-negative-controls.mjs`,
 * a second harness with its own runner, patcher and report shape. Every one of
 * them killed what it claimed to kill. None of them was reachable from
 * `npm run negative-control`, which went on discovering 129 controls and
 * publishing that number as the campaign's scope — so the record said "129
 * controls, all agreed" while twelve load-bearing guards were measured by
 * something else, or by nothing, depending on who remembered to run the second
 * script. A control the campaign cannot discover is a control the campaign does
 * not have.
 *
 * ## What these controls assert
 *
 * That the v2 rows are in the canonical table, that they name real files and
 * real suites, and that the count is derived rather than asserted. The last
 * point matters: a test that hard-codes "146" would pass forever and tell you
 * nothing, so the checks below are about *presence and shape*, and the total is
 * printed by `--list` rather than pinned here.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface Control {
  readonly id: string;
  readonly what: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly tests: readonly string[];
  readonly expect: string;
  readonly mustFailCases?: readonly string[];
}

const { CONTROLS } = (await import(
  pathToFileURL(path.join(repoRoot, "scripts", "negative-control.mjs")).href
)) as { CONTROLS: readonly Control[] };

const v2 = CONTROLS.filter((control) => control.id.startsWith("v2-"));

/**
 * Every guard the v2 package added, by the boundary it defends.
 *
 * Named individually rather than counted: a count survives one control being
 * deleted and another added, which is the substitution this test exists to
 * notice.
 */
const REQUIRED_V2_CONTROLS = [
  // The twelve that were previously invisible to canonical discovery.
  "v2-local-mode-accepts-v1",
  "v2-receipt-version-guard",
  "v2-local-context-closed",
  "v2-not-scored-constant",
  "v2-governed-consumer-firewall",
  "v2-receipt-operation-scope",
  "v2-per-dispatch-digest",
  "v2-local-output-bytes",
  "v2-ambiguous-never-replayed",
  "v2-post-freeze-dispatch",
  "v2-cleanup-requires-evidence",
  "v2-coordinator-delegates",
  // The closures from the Package A independent review.
  "v2-residue-requires-report",
  "v2-residue-report-validated",
  "v2-governed-port-refusal",
  "v2-telemetry-follower-readiness",
  "v2-telemetry-block-boundary",
  // The closure from the focused re-review: the residue remediation's second
  // property, which shipped correct and unmeasured.
  "v2-operation-success-requires-adapter-success",
] as const;

test("NC-DISCOVERY: every v2 control is reachable from canonical discovery", () => {
  const discovered = new Set(v2.map((control) => control.id));
  for (const id of REQUIRED_V2_CONTROLS) {
    assert.equal(discovered.has(id), true, `${id} is not discoverable by npm run negative-control`);
  }
});

test("NC-DISCOVERY: no v2 control is declared twice under two names", () => {
  const ids = CONTROLS.map((control) => control.id);
  assert.equal(new Set(ids).size, ids.length, "a control id is declared more than once");
  // Two rows patching the same preimage in the same file would run the same
  // measurement twice and count it as two.
  const targets = v2.map((control) => `${control.file}::${control.find}`);
  assert.equal(new Set(targets).size, targets.length, "two v2 controls mutate the same preimage");
});

test("NC-DISCOVERY: the second v2 harness is gone, not merely bypassed", () => {
  // While it exists, someone will run it, and its results will not be in the
  // campaign record.
  assert.equal(
    existsSync(path.join(repoRoot, "scripts", "subject-adapter-v2-negative-controls.mjs")),
    false,
    "the superseded v2 control script is still present",
  );
});

test("NC-DISCOVERY: every v2 control names a file and suites that exist", () => {
  for (const control of v2) {
    assert.equal(
      existsSync(path.join(repoRoot, control.file)),
      true,
      `${control.id} targets a missing file ${control.file}`,
    );
    assert.ok(control.tests.length > 0, `${control.id} names no suite`);
    for (const suite of control.tests) {
      // The compiled suite is what the campaign runs.
      assert.match(suite, /^tests\/dist\/.+\.test\.js$/, `${control.id} names ${suite}`);
      const source = path.join(repoRoot, suite.replace("tests/dist/", "tests/").replace(/\.js$/, ".ts"));
      assert.equal(existsSync(source), true, `${control.id} names a suite with no source: ${suite}`);
    }
    assert.equal(control.expect, "fail", `${control.id} must declare an expected kill`);
  }
});

/**
 * The boundaries closed by the bounded reliability correction.
 *
 * Not `v2-` prefixed, because they are not that package's: they are Reality Lab
 * reliability guards, and they take their names from the families they join
 * (`compose-*` for the driver's observation, `nc-*` for the campaign harness's
 * own instrumentation). They are pinned here for the same reason the v2 rows
 * are — a control that is renamed away is a property silently dropped.
 */
test("NC-DISCOVERY: the boundaries closed by the reliability correction each have a control", () => {
  const byId = new Map(CONTROLS.map((control) => [control.id, control]));
  const boundaries: readonly (readonly [string, string])[] = [
    // The retained telemetry observation may not state a span count derived
    // from a window that did not carry the counting line.
    [
      "compose-observation-requires-coherent-span-count",
      "packages/core/src/environment/telemetryObservation.ts",
    ],
    // The campaign harness's own marker: published atomically, and read as
    // content rather than as a path that exists.
    ["nc-marker-published-atomically", "tests/support/atomicMarker.ts"],
    ["nc-marker-readiness-requires-valid-content", "tests/support/atomicMarker.ts"],
  ];
  for (const [id, file] of boundaries) {
    const control = byId.get(id);
    assert.ok(control !== undefined, `${id} is missing from canonical discovery`);
    assert.equal(control.file, file, `${id} no longer defends ${file}`);
    assert.equal(
      existsSync(path.join(repoRoot, control.file)),
      true,
      `${id} targets a missing file ${control.file}`,
    );
    assert.equal(control.expect, "fail", `${id} must declare an expected kill`);
    assert.ok(control.tests.length > 0, `${id} names no suite`);
    for (const suite of control.tests) {
      const source = path.join(repoRoot, suite.replace("tests/dist/", "tests/").replace(/\.js$/, ".ts"));
      assert.equal(existsSync(source), true, `${id} names a suite with no source: ${suite}`);
    }
    // Case-level granularity: a control that names only a file scores a kill on
    // any failure in it, which is what review R-05 removed.
    assert.ok(
      (control.mustFailCases ?? []).length > 0,
      `${id} does not name the cases that must fail`,
    );
  }
});

/**
 * The boundaries closed by the parser-authentication and verifier-independence
 * remediation.
 *
 * Pinned by boundary rather than by name, like every other row here: a control
 * that is renamed away is a property silently dropped, and these five are the
 * ones an independent review had to prove were missing.
 */
test("NC-DISCOVERY: the parser and verifier integrity boundaries each have a control", () => {
  const byId = new Map(CONTROLS.map((control) => [control.id, control]));
  const boundaries: readonly (readonly [string, string])[] = [
    // Only a line the collector framed as a whole record may state a count.
    [
      "telemetry-summary-must-be-a-framed-record",
      "packages/core/src/environment/telemetryObservation.ts",
    ],
    // Payload text states nothing, even copied byte for byte.
    [
      "telemetry-record-payload-is-not-summary-text",
      "packages/core/src/environment/telemetryObservation.ts",
    ],
    // A window whose framing is ambiguous, or whose summary cannot be read, is
    // refused rather than totalled.
    [
      "telemetry-ambiguous-window-is-refused",
      "packages/core/src/environment/telemetryObservation.ts",
    ],
    [
      "telemetry-malformed-summary-is-not-a-zero",
      "packages/core/src/environment/telemetryObservation.ts",
    ],
    // The offline verifier re-derives coherence rather than trusting it.
    [
      "telemetry-verifier-recomputes-coherence",
      "packages/public-verifier/src/library/telemetryDerivation.ts",
    ],
  ];
  for (const [id, file] of boundaries) {
    const control = byId.get(id);
    assert.ok(control !== undefined, `${id} is missing from canonical discovery`);
    assert.equal(control.file, file, `${id} no longer defends ${file}`);
    assert.equal(
      existsSync(path.join(repoRoot, control.file)),
      true,
      `${id} targets a missing file ${control.file}`,
    );
    assert.equal(control.expect, "fail", `${id} must declare an expected kill`);
    assert.ok(
      (control.mustFailCases ?? []).length > 0,
      `${id} does not name the cases that must fail`,
    );
  }
});

test("NC-DISCOVERY: the boundaries closed by the Package A review each have a control", () => {
  // Keyed on the boundary rather than the id, so renaming a control does not
  // quietly drop the property it was standing for.
  const byId = new Map(v2.map((control) => [control.id, control]));
  const boundaries: readonly (readonly [string, string])[] = [
    ["v2-residue-requires-report", "packages/core/src/observation/localObservation.ts"],
    ["v2-residue-report-validated", "packages/core/src/adapter/responseShape.ts"],
    ["v2-governed-port-refusal", "packages/core/src/adapter/hostedSubjectPort.ts"],
    ["v2-telemetry-follower-readiness", "tests/support/durableTelemetry.ts"],
    ["v2-telemetry-block-boundary", "tests/support/durableTelemetry.ts"],
    [
      "v2-operation-success-requires-adapter-success",
      "packages/core/src/observation/localObservation.ts",
    ],
  ];
  for (const [id, file] of boundaries) {
    const control = byId.get(id);
    assert.ok(control !== undefined, `${id} is missing`);
    assert.equal(control.file, file, `${id} no longer defends ${file}`);
  }
});
