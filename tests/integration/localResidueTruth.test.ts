/**
 * What a local observation may say about the world it left behind.
 *
 * ## The defect these controls exist for
 *
 * `cleanupResult()` used to emit `residue: "observed_clean"` and
 * `cleanup_complete` because a `report-residue` operation had reached the
 * `completed` state. The completed record carried no residue value at all, so
 * the reducer was structurally incapable of telling a clean substrate from a
 * dirty one: an adapter reporting fifty leftover artifacts produced output
 * byte-identical to one reporting none, and `residue_detected` — a value the
 * contract has always offered — was unreachable in the production tree.
 *
 * ADR-ERL2-037 §1 says the local result "reports uncertainty; it does not infer
 * clean", and §6 says the final residue observation is "necessary, not
 * sufficient". Inferring a clean world from the fact that an operation ended is
 * a statement about the harness, not about the machine.
 *
 * ## What is asserted
 *
 * Every case below drives a real certified neutral adapter through the real
 * `AdapterHost` subprocess boundary, because the branch under test is reached
 * from a validated host result and asserting it by calling the reducer directly
 * would prove only that the helper computes what the helper computes.
 *
 * The four honest answers — clean, residue detected, unknown, and no report at
 * all — must reduce to three distinguishable cleanup states, and a report that
 * contradicts itself must be refused rather than believed.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CODES, Erl2Error } from "@erl2/contracts";
import { LocalObservationCoordinator, assertLocalResidueObservationDraft } from "@erl2/core";
import {
  ARCHIVE_SHAPE,
  LOCAL_NOW,
  newLocalHost,
  residueShape,
} from "../support/localObservationFixtures.js";

type ResidueKind = "clean" | "detected" | "unknown" | "contradictory";

/** Runs one neutral residue adapter for real and reduces what it reported. */
function observe(kind: ResidueKind): {
  readonly cleanup: ReturnType<LocalObservationCoordinator["cleanupResult"]>;
  readonly coordinator: LocalObservationCoordinator;
} {
  const fixture = newLocalHost(residueShape(kind));
  const coordinator = new LocalObservationCoordinator(fixture.plan);
  coordinator.execute(fixture.host, fixture.request, LOCAL_NOW, () => "2026-08-12T18:00:03Z");
  return { cleanup: coordinator.cleanupResult(), coordinator };
}

function completedRecord(coordinator: LocalObservationCoordinator): Record<string, unknown> {
  const record = coordinator.operationRecords.find((candidate) => candidate.state === "completed");
  assert.ok(record !== undefined, "the observation produced no completed record");
  return record as unknown as Record<string, unknown>;
}

test("LOCAL-RESIDUE: an explicitly clean report is the only route to observed_clean", () => {
  const { cleanup, coordinator } = observe("clean");
  assert.equal(cleanup.residue, "observed_clean");
  assert.equal(cleanup.status, "cleanup_complete");
  assert.deepEqual(cleanup.reason_codes, []);
  // The verdict is traceable to reported data, not to the operation ending.
  assert.deepEqual(completedRecord(coordinator)["residue_observation"], {
    checkpoint: "final",
    status: "clean",
    residual_resource_count: 0,
    residual_path_count: 0,
  });
});

test("LOCAL-RESIDUE: fifty remaining artifacts reach the reducer as residue_detected", () => {
  const { cleanup, coordinator } = observe("detected");
  assert.equal(cleanup.residue, "residue_detected");
  assert.equal(cleanup.status, "cleanup_incomplete");
  assert.deepEqual(cleanup.reason_codes, [CODES.ADAPTER_LOCAL_CLEANUP_INCOMPLETE]);
  assert.deepEqual(completedRecord(coordinator)["residue_observation"], {
    checkpoint: "final",
    status: "residue_detected",
    residual_resource_count: 0,
    residual_path_count: 50,
  });
});

test("LOCAL-RESIDUE: zero and fifty remaining artifacts are observably different evidence", () => {
  const clean = observe("clean");
  const dirty = observe("detected");

  // The defect this kills produced byte-identical output for both adapters.
  assert.notDeepEqual(clean.cleanup, dirty.cleanup);
  assert.notEqual(
    completedRecord(clean.coordinator)["core_hash"],
    completedRecord(dirty.coordinator)["core_hash"],
    "a clean and a dirty observation must not share one record identity",
  );
  assert.notEqual(
    clean.coordinator.buildResult(LOCAL_NOW, "2026-08-12T18:00:03Z").core_hash,
    dirty.coordinator.buildResult(LOCAL_NOW, "2026-08-12T18:00:03Z").core_hash,
  );
});

test("LOCAL-RESIDUE: an adapter that cannot tell is not rounded to clean", () => {
  const { cleanup, coordinator } = observe("unknown");
  assert.equal(cleanup.residue, "not_observed");
  assert.equal(cleanup.status, "cleanup_incomplete");
  // The operation genuinely succeeded; it simply established nothing about residue.
  assert.equal(completedRecord(coordinator)["response_status"], "supported");
  assert.equal(
    (completedRecord(coordinator)["residue_observation"] as { status: string }).status,
    "unknown",
  );
});

test("LOCAL-RESIDUE: a self-contradicting report is refused, never believed", () => {
  const fixture = newLocalHost(residueShape("contradictory"));
  const coordinator = new LocalObservationCoordinator(fixture.plan);
  coordinator.execute(fixture.host, fixture.request, LOCAL_NOW, () => "2026-08-12T18:00:03Z");
  // `report-residue` is effectful-adjacent cleanup, so a refused report leaves
  // the operation unreconciled rather than quietly completed.
  const cleanup = coordinator.cleanupResult();
  assert.equal(cleanup.residue, "not_observed");
  assert.equal(cleanup.status, "cleanup_incomplete");
  assert.equal(
    coordinator.operationRecords.some((record) => record.state === "completed"),
    false,
    "a refused residue report must not produce a completed record",
  );
});

test("LOCAL-RESIDUE: a completed operation that is not a residue report never implies clean", () => {
  // The exact shape of the original defect: an observation completes, cleanly,
  // and says nothing whatsoever about the substrate.
  const fixture = newLocalHost(ARCHIVE_SHAPE);
  const coordinator = new LocalObservationCoordinator(fixture.plan);
  const terminal = coordinator.execute(
    fixture.host,
    fixture.request,
    LOCAL_NOW,
    () => "2026-08-12T18:00:03Z",
  );
  assert.equal(terminal.state, "completed");
  const cleanup = coordinator.cleanupResult();
  assert.equal(cleanup.residue, "not_observed");
  assert.equal(
    Object.prototype.hasOwnProperty.call(completedRecord(coordinator), "residue_observation"),
    false,
  );
});

test("LOCAL-RESIDUE: the host refuses an unusable report at the protocol boundary", () => {
  const refusal = (value: unknown, checkpoint = "final"): Erl2Error => {
    try {
      assertLocalResidueObservationDraft(value, checkpoint);
    } catch (cause) {
      if (cause instanceof Erl2Error) return cause;
      throw cause;
    }
    throw new Error("expected a typed refusal");
  };

  const valid = {
    schema_version: "local-residue-observation/v1",
    checkpoint: "final",
    status: "clean",
    residual_resources: [],
    residual_paths: [],
  };
  assert.deepEqual(assertLocalResidueObservationDraft(valid, "final"), valid);

  for (const [detail, bad] of [
    ["missing entirely", undefined],
    ["not an object", "clean"],
    ["an array", []],
    ["missing status", { ...valid, status: undefined }],
    ["unknown status word", { ...valid, status: "probably_fine" }],
    ["an unexpected field", { ...valid, verdict: "clean" }],
    ["a wrong schema version", { ...valid, schema_version: "residue-report/v1" }],
    ["clean while naming a path", { ...valid, residual_paths: ["adapter-workspace/x.tmp"] }],
    ["clean while naming a resource", {
      ...valid,
      residual_resources: [{ kind: "process", identity_hash: `sha256:${"a".repeat(64)}` }],
    }],
    ["residue_detected naming nothing", { ...valid, status: "residue_detected" }],
    ["a malformed resource entry", { ...valid, residual_resources: [{ kind: "process" }] }],
    ["a non-string path", { ...valid, status: "residue_detected", residual_paths: [7] }],
  ] as const) {
    assert.equal(
      refusal(bad).code,
      CODES.ADAPTER_LOCAL_RESIDUE_REPORT_INVALID,
      `a report that is ${detail} must be refused as an unusable residue report`,
    );
  }

  // A baseline report may not be retained as the final one.
  assert.equal(
    refusal({ ...valid, checkpoint: "baseline" }, "final").code,
    CODES.ADAPTER_LOCAL_RESIDUE_REPORT_INVALID,
  );
});
