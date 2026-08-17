import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CODES,
  Erl2Error,
  assertContract,
  type AdapterOperation,
  type AdapterRequestPredecessorV2,
  type AdapterRequestV2,
  type LocalObservationPlanV1,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";
import { LocalObservationCoordinator } from "@erl2/core";
import {
  ARCHIVE_SHAPE,
  LOCAL_NOW,
  localFixture,
  newLocalHost,
} from "../support/localObservationFixtures.js";

const H = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}`;

function refusal(fn: () => unknown): Erl2Error {
  try {
    fn();
  } catch (cause) {
    if (cause instanceof Erl2Error) return cause;
    throw cause;
  }
  throw new Error("expected a typed refusal");
}

test("LOCAL-REDUCER: declared, dispatched and completed records are immutable and terminal replay is idempotent", () => {
  const fixture = newLocalHost();
  const coordinator = new LocalObservationCoordinator(fixture.plan);
  const terminal = coordinator.execute(
    fixture.host,
    fixture.request,
    LOCAL_NOW,
    () => "2026-08-12T18:00:03Z",
  );
  assert.equal(terminal.state, "completed");
  assert.deepEqual(coordinator.operationRecords.map((record) => record.state), [
    "declared", "dispatched", "completed",
  ]);
  assert.ok(coordinator.operationRecords.every(
    (record) => record.evidence_authenticity === "unauthenticated_local_record",
  ));
  const replay = coordinator.execute(
    fixture.host,
    fixture.request,
    LOCAL_NOW,
    () => "2026-08-12T18:00:04Z",
  );
  assert.equal(replay.core_hash, terminal.core_hash);
  assert.equal(coordinator.operationRecords.length, 3, "terminal replay must not redispatch");

  const result = coordinator.buildResult(LOCAL_NOW, "2026-08-12T18:00:04Z");
  assert.equal(result.status, "observed_complete");
  assert.equal(result.not_scored, true);
  assert.equal(result.not_governor_authorized, true);
  assert.equal(result.evidence_authenticity, "unauthenticated_local_record");
});

test("LOCAL-REDUCER: the same operation id with different request bytes conflicts", () => {
  const fixture = localFixture();
  const coordinator = new LocalObservationCoordinator(fixture.plan);
  coordinator.declare(fixture.request, LOCAL_NOW);
  const changedBase = {
    ...fixture.request,
    deadline: "2026-08-12T18:00:04Z",
  } as unknown as Record<string, unknown>;
  delete changedBase["core_hash"];
  const changed = { ...changedBase, core_hash: coreHash(changedBase) } as unknown as AdapterRequestV2;
  assert.equal(
    refusal(() => coordinator.declare(changed, LOCAL_NOW)).code,
    CODES.ADAPTER_LOCAL_REPLAY_CONFLICT,
  );
});

test("LOCAL-REDUCER: ambiguous effects are never replayed and force cleanup-only progress", () => {
  const { plan, request } = customPlan([
    ["acquire", false],
    ["project", false],
    ["report-residue", true],
  ]);
  const coordinator = new LocalObservationCoordinator(plan);
  coordinator.declare(request(0), LOCAL_NOW);
  coordinator.markDispatched("op-acquire", LOCAL_NOW);
  const ambiguous = coordinator.markAmbiguous(
    "op-acquire",
    "no terminal host evidence after process loss",
    "2026-08-12T18:00:02Z",
  );
  assert.equal(ambiguous.state, "ambiguous_not_replayed");
  assert.equal(
    refusal(() => coordinator.execute({} as never, request(0), LOCAL_NOW, () => LOCAL_NOW)).code,
    CODES.ADAPTER_LOCAL_AMBIGUOUS_REPLAY_REFUSED,
  );
  assert.equal(
    refusal(() => coordinator.declare(request(1), LOCAL_NOW)).code,
    CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID,
  );
  // The residue operation is the frozen cleanup suffix, and its predecessor is
  // the ambiguous acquire — the operation this run actually finished last, not
  // the plan entry one sequence earlier.
  assert.equal(
    coordinator.declare(request(2, coordinator.nextPredecessor()), LOCAL_NOW).state,
    "declared",
  );
  assert.equal(coordinator.cleanupResult().status, "cleanup_incomplete");
});

test("LOCAL-REDUCER: failed operations preserve typed failure and conservative cleanup", () => {
  const fixture = localFixture();
  const coordinator = new LocalObservationCoordinator(fixture.plan);
  coordinator.declare(fixture.request, LOCAL_NOW);
  coordinator.markDispatched(fixture.request.operation_id, LOCAL_NOW);
  const failed = coordinator.fail(
    fixture.request.operation_id,
    CODES.ADAPTER_PROCESS_CRASHED,
    LOCAL_NOW,
    "2026-08-12T18:00:02Z",
  );
  assert.equal(failed.state, "failed");
  assert.equal(failed.failure_code, CODES.ADAPTER_PROCESS_CRASHED);
  assert.equal(coordinator.cleanupResult().status, "cleanup_complete");
});

test("LOCAL-REDUCER: output freeze irreversibly refuses subsequent subject operations", () => {
  const fixture = newLocalHost();
  const coordinator = new LocalObservationCoordinator(fixture.plan);
  coordinator.freezeOutput(fixture.host);
  assert.equal(
    refusal(() => coordinator.declare(fixture.request, LOCAL_NOW)).code,
    CODES.ADAPTER_EXECUTION_AFTER_OUTPUT_FREEZE,
  );
  assert.equal(
    refusal(() =>
      fixture.host.run({
        operation: fixture.request.operation,
        operationId: fixture.request.operation_id,
        request: fixture.request,
        executionMode: "local_observation",
      }),
    ).code,
    CODES.ADAPTER_EXECUTION_AFTER_OUTPUT_FREEZE,
  );
});

const prerequisiteEdges: readonly (readonly [AdapterOperation, AdapterOperation])[] = [
  ["acquire", "validate-package"],
  ["validate-package", "install"],
  ["install", "configure"],
  ["install", "start"],
  ["configure", "start"],
  ["start", "interact"],
  ["start", "collect-outputs"],
  ["interact", "collect-outputs"],
  ["start", "stop"],
  ["install", "uninstall"],
  ["stop", "uninstall"],
];

test("LOCAL-REDUCER: every prerequisite edge is refused before dispatch", () => {
  for (const [prior, target] of prerequisiteEdges) {
    const { plan, request } = customPlan([
      [prior, false],
      [target, target === "stop" || target === "uninstall"],
    ]);
    const coordinator = new LocalObservationCoordinator(plan);
    assert.equal(
      refusal(() => coordinator.declare(request(1), LOCAL_NOW)).code,
      CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID,
      `${prior} -> ${target}`,
    );
    assert.equal(coordinator.operationRecords.length, 0, `${target} reached dispatch state`);
  }
});

function customPlan(
  operations: readonly (readonly [AdapterOperation, boolean])[],
): {
  readonly plan: LocalObservationPlanV1;
  /**
   * `predecessor` defaults to a placeholder that no run ever produced, which is
   * what the ancestry check exists to refuse. A test that means to dispatch a
   * genuinely chained operation passes the coordinator's own `nextPredecessor()`.
   */
  readonly request: (
    index: number,
    predecessor?: AdapterRequestPredecessorV2 | null,
  ) => AdapterRequestV2;
} {
  const fixture = localFixture(ARCHIVE_SHAPE);
  const specs = operations.map(([operation, cleanup], sequence) => ({
    sequence,
    operation_id: `op-${operation}`,
    operation,
    payload: payloadFor(operation),
    timeout_ms: 4_000,
    cleanup,
  }));
  const planBase = { ...fixture.plan, operations: specs } as unknown as Record<string, unknown>;
  delete planBase["core_hash"];
  const plan = assertContract<LocalObservationPlanV1>("LocalObservationPlanV1", {
    ...planBase,
    core_hash: coreHash(planBase),
  });
  return {
    plan,
    request: (index: number, predecessor?: AdapterRequestPredecessorV2 | null) => {
      const spec = specs[index];
      if (spec === undefined) throw new Error("fixture operation missing");
      const link = predecessor === undefined
        ? {
            operation_id: specs[index - 1]?.operation_id ?? "op-absent",
            operation_record_hash: H("1"),
            request_hash: H("2"),
            outcome: "completed" as const,
            response_envelope_hash: H("3"),
          }
        : predecessor;
      const base = {
        ...fixture.request,
        operation_id: spec.operation_id,
        operation: spec.operation,
        operation_payload: spec.payload,
        ancestry: index === 0
          ? { sequence: 0, predecessor: predecessor ?? null }
          : { sequence: index, predecessor: link },
        execution_context: {
          ...fixture.request.execution_context,
          observation_plan_hash: plan.core_hash,
        },
      } as unknown as Record<string, unknown>;
      delete base["core_hash"];
      return assertContract<AdapterRequestV2>("AdapterRequestV2", {
        ...base,
        core_hash: coreHash(base),
      });
    },
  };
}

function payloadFor(operation: AdapterOperation): Record<string, unknown> {
  switch (operation) {
    case "acquire": return { schema_version: "acquire-payload/v1", provenance_mode: "acquired", source_descriptor_input_id: "package-input", output_input_id: "package-output", expected_package_kind: "archive", credential_handle_ids: [] };
    case "validate-package": return { schema_version: "validate-package-payload/v1", package_input_id: "package-input", package_kind: "archive" };
    case "install": return { schema_version: "install-payload/v1", package_input_id: "package-input" };
    case "configure": return { schema_version: "configure-payload/v1", configuration_input_ids: [] };
    case "start": return { schema_version: "start-payload/v1", input_ids: [] };
    case "interact": return { schema_version: "interact-payload/v1", interaction_input_ids: [] };
    case "translate-evidence": return { schema_version: "translate-evidence-payload/v1", evidence_input_ids: [], evidence_mount_handle_id: "evidence-mount" };
    case "collect-outputs": return { schema_version: "collect-outputs-payload/v1", requested_output_role_ids: [] };
    case "project": return { schema_version: "project-payload/v1", evidence_input_ids: [], projection_schema: "local-draft-v1" };
    case "stop": return { schema_version: "stop-payload/v1", start_operation_id: "op-start" };
    case "uninstall": return { schema_version: "uninstall-payload/v1", install_operation_id: "op-install" };
    case "report-residue": return { schema_version: "report-residue-payload/v1", checkpoint: "final" };
    case "compensate": return { schema_version: "compensate-payload/v1", mutation_receipt_hashes: [H("4")] };
  }
}
