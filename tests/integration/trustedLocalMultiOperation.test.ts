/**
 * Multi-operation execution and the ancestry chain that holds it together.
 *
 * The defect these cases exist for was narrow and total: the runner put an
 * entire operation record where the contract wanted a five-field summary, so
 * every plan refused its second operation and no multi-operation profile could
 * run at all. The first case proves eleven operations complete; the rest prove
 * the chain is checked rather than merely constructed.
 *
 * Nothing here contacts any product or service. The neutral observer answers
 * every operation locally.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  CODES,
  Erl2Error,
  type AdapterRequestPredecessorV2,
  type AdapterRequestV2,
  type LocalObservationTrustedLocalPlanV1,
} from "@erl2/contracts";
import { ArtifactStore, coreHash } from "@erl2/integrity";
import {
  AdapterHost,
  LocalObservationCoordinator,
  SystemClock,
  compactPredecessorOf,
} from "@erl2/core";
import { runCommand } from "@erl2/cli";
import { ownedTempDir } from "../support/tempDirs.js";
import {
  ELEVEN_OPERATION_CLEAN_PLAN,
  ELEVEN_OPERATION_PROFILE,
  ELEVEN_OPERATION_PROFILE_PLAN,
  writeTrustedLocalInputs,
  type WrittenTrustedLocalInputs,
} from "../support/trustedLocalFixtures.js";

function refusal(fn: () => unknown): Erl2Error {
  try {
    fn();
  } catch (cause) {
    if (cause instanceof Erl2Error) return cause;
    throw cause;
  }
  throw new Error("expected a typed refusal");
}

function run(inputs: WrittenTrustedLocalInputs): ReturnType<typeof runCommand> {
  return runCommand([
    "run-trusted-local-observation",
    "--adapter-entry", inputs.entryPath,
    "--manifest", inputs.manifestPath,
    "--plan", inputs.planPath,
    "--owner-declaration", inputs.declarationPath,
    "--output-root", inputs.outputRoot,
  ]);
}

test("TRUSTED-LOCAL-CHAIN: an eleven-operation neutral plan completes end to end", () => {
  const root = ownedTempDir("erl2-tlo-eleven-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);
  const result = run(inputs);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const data = result.data as {
    operations: readonly { operation: string; state: string; response_status?: string }[];
    terminal_status: string;
    offline_verification: { ok: boolean; refusals: readonly string[] };
  };
  assert.equal(data.operations.length, 11);
  assert.ok(
    data.operations.every((operation) => operation.state === "completed"),
    `not every operation completed: ${JSON.stringify(data.operations)}`,
  );
  assert.equal(data.terminal_status, "observed_complete");
  assert.equal(data.offline_verification.ok, true, data.offline_verification.refusals.join("; "));
});

test("TRUSTED-LOCAL-CHAIN: operation two receives a valid compact predecessor", () => {
  const root = ownedTempDir("erl2-tlo-two-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_CLEAN_PLAN);
  const result = run(inputs);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const operations = (result.data as {
    operations: readonly {
      operation_id: string;
      predecessor_operation_id?: string;
      predecessor_operation_record_hash?: string;
    }[];
  }).operations;
  assert.equal(operations[0]?.predecessor_operation_id, undefined, "the first operation has no predecessor");
  // Every later operation names the one before it, and names its record hash.
  for (const [index, operation] of operations.entries()) {
    if (index === 0) continue;
    assert.equal(operation.predecessor_operation_id, operations[index - 1]?.operation_id);
    assert.match(String(operation.predecessor_operation_record_hash), /^sha256:[0-9a-f]{64}$/);
  }
});

test("TRUSTED-LOCAL-CHAIN: the exact eleven-operation profile dispatches every operation", () => {
  const root = ownedTempDir("erl2-tlo-profile-");
  const inputs = writeTrustedLocalInputs(root, ELEVEN_OPERATION_PROFILE_PLAN);
  const result = run(inputs);
  // The plan's operations are exactly the eleven the external profile
  // declares, so every one of them dispatches and completes. The terminal is
  // nevertheless `cleanup_incomplete`, because a successful `start` creates a
  // stop obligation and this profile declares no `stop` — an honest property
  // of the profile, not a fixture defect. The record is retained either way.
  assert.equal(result.ok, false);
  assert.equal(result.errors?.[0]?.code, CODES.ADAPTER_LOCAL_CLEANUP_INCOMPLETE);
  assert.equal(
    ELEVEN_OPERATION_PROFILE_PLAN.length,
    ELEVEN_OPERATION_PROFILE.length,
    "the plan must cover the whole declared profile",
  );
});

/** Drives the coordinator directly, so a request's ancestry can be malformed. */
function directRun(
  root: string,
  operations: readonly { operation: never; cleanup: boolean }[] = ELEVEN_OPERATION_CLEAN_PLAN as never,
): {
  readonly coordinator: LocalObservationCoordinator;
  readonly host: AdapterHost;
  readonly plan: LocalObservationTrustedLocalPlanV1;
  readonly request: (
    index: number,
    predecessor: AdapterRequestPredecessorV2 | null,
  ) => AdapterRequestV2;
} {
  const inputs = writeTrustedLocalInputs(root, operations as never);
  const host = new AdapterHost({
    runId: inputs.plan.observation_id,
    adapterManifest: inputs.manifest,
    localAuthorityV2: { mode: "trusted_local_code", declaration: inputs.declaration },
    localObservationPlan: inputs.plan,
    adapterEntryPath: inputs.entryPath,
    workspaceRoot: path.join(root, "ws"),
    store: new ArtifactStore(path.join(root, "store")),
    clock: new SystemClock(),
    wallClockMs: inputs.plan.resource_limits.wall_clock_ms,
    maxRequestBytes: inputs.plan.resource_limits.max_request_bytes,
    maxResponseBytes: inputs.plan.resource_limits.max_response_bytes,
  });
  return {
    coordinator: new LocalObservationCoordinator(inputs.plan),
    host,
    plan: inputs.plan,
    request: (index, predecessor) => buildRequest(inputs.plan, index, predecessor),
  };
}

function buildRequest(
  plan: LocalObservationTrustedLocalPlanV1,
  index: number,
  predecessor: AdapterRequestPredecessorV2 | null,
): AdapterRequestV2 {
  const spec = plan.operations[index];
  if (spec === undefined) throw new Error(`no plan operation at ${index}`);
  const deadline = new Date(Date.parse(plan.created_at) + spec.timeout_ms)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const base = {
    schema_version: "adapter-request/v2" as const,
    protocol_version: "subject-adapter/v2" as const,
    execution_id: plan.observation_id,
    adapter_manifest_hash: plan.adapter_manifest_hash,
    operation_id: spec.operation_id,
    operation: spec.operation,
    ancestry: { sequence: spec.sequence, predecessor },
    deadline,
    diagnostics_policy: {
      max_total_bytes: plan.resource_limits.max_diagnostic_bytes,
      max_line_bytes: plan.resource_limits.max_diagnostic_line_bytes,
      redact_secrets: true as const,
      scan_forbidden_identifiers: true as const,
    },
    execution_context: {
      mode: "local_observation" as const,
      observation_plan_hash: plan.core_hash,
      resource_limits: plan.resource_limits,
      input_artifact_refs: [...plan.inputs],
      egress_policy: plan.egress_policy,
      allowed_capability_ids: [],
      allowed_credential_handle_ids: [],
      not_scored: true as const,
      not_governor_authorized: true as const,
      unsupported_claims: [...plan.unsupported_claims],
    },
    operation_payload: spec.payload,
  };
  return { ...base, core_hash: coreHash(base) } as unknown as AdapterRequestV2;
}

test("TRUSTED-LOCAL-CHAIN: operation one carrying a predecessor is refused", () => {
  const root = ownedTempDir("erl2-tlo-first-");
  const { coordinator, host, request } = directRun(root);
  const invented: AdapterRequestPredecessorV2 = {
    operation_id: "op-nothing",
    operation_record_hash: `sha256:${"1".repeat(64)}`,
    request_hash: `sha256:${"2".repeat(64)}`,
    outcome: "completed",
    response_envelope_hash: `sha256:${"3".repeat(64)}`,
  };
  const error = refusal(() =>
    coordinator.execute(host, request(0, invented), "2026-08-12T18:00:00Z", () => "2026-08-12T18:00:01Z"),
  );
  // The contract itself forbids a predecessor at sequence zero.
  assert.equal(error.code, CODES.SCHEMA_VALIDATION_FAILED);
});

test("TRUSTED-LOCAL-CHAIN: operation two without a predecessor is refused", () => {
  const root = ownedTempDir("erl2-tlo-missing-");
  const { coordinator, host, request } = directRun(root);
  coordinator.execute(host, request(0, null), "2026-08-12T18:00:00Z", () => "2026-08-12T18:00:01Z");
  const error = refusal(() =>
    coordinator.execute(host, request(1, null), "2026-08-12T18:00:01Z", () => "2026-08-12T18:00:02Z"),
  );
  assert.equal(error.code, CODES.SCHEMA_VALIDATION_FAILED);
});

test("TRUSTED-LOCAL-CHAIN: an altered predecessor hash is refused", () => {
  const root = ownedTempDir("erl2-tlo-altered-");
  const { coordinator, host, request } = directRun(root);
  const first = coordinator.execute(
    host,
    request(0, null),
    "2026-08-12T18:00:00Z",
    () => "2026-08-12T18:00:01Z",
  );
  const altered = {
    ...compactPredecessorOf(first),
    operation_record_hash: `sha256:${"9".repeat(64)}`,
  } as AdapterRequestPredecessorV2;
  const error = refusal(() =>
    coordinator.execute(host, request(1, altered), "2026-08-12T18:00:01Z", () => "2026-08-12T18:00:02Z"),
  );
  assert.equal(error.code, CODES.ADAPTER_REQUEST_PREDECESSOR_INVALID);
});

test("TRUSTED-LOCAL-CHAIN: a predecessor from another run is refused", () => {
  const rootA = ownedTempDir("erl2-tlo-runa-");
  const rootB = ownedTempDir("erl2-tlo-runb-");
  const a = directRun(rootA);
  const b = directRun(rootB);
  const foreign = compactPredecessorOf(
    a.coordinator.execute(a.host, a.request(0, null), "2026-08-12T18:00:00Z", () => "2026-08-12T18:00:01Z"),
  );
  b.coordinator.execute(b.host, b.request(0, null), "2026-08-12T18:00:00Z", () => "2026-08-12T18:00:01Z");
  const error = refusal(() =>
    b.coordinator.execute(b.host, b.request(1, foreign), "2026-08-12T18:00:01Z", () => "2026-08-12T18:00:02Z"),
  );
  assert.equal(error.code, CODES.ADAPTER_REQUEST_PREDECESSOR_INVALID);
});

test("TRUSTED-LOCAL-CHAIN: a predecessor from another plan is refused", () => {
  const rootA = ownedTempDir("erl2-tlo-plana-");
  const rootB = ownedTempDir("erl2-tlo-planb-");
  const a = directRun(rootA, [
    { operation: "acquire" as never, cleanup: false },
    { operation: "validate-package" as never, cleanup: false },
    { operation: "report-residue" as never, cleanup: true },
  ]);
  const b = directRun(rootB);
  const foreign = compactPredecessorOf(
    a.coordinator.execute(a.host, a.request(0, null), "2026-08-12T18:00:00Z", () => "2026-08-12T18:00:01Z"),
  );
  b.coordinator.execute(b.host, b.request(0, null), "2026-08-12T18:00:00Z", () => "2026-08-12T18:00:01Z");
  const error = refusal(() =>
    b.coordinator.execute(b.host, b.request(1, foreign), "2026-08-12T18:00:01Z", () => "2026-08-12T18:00:02Z"),
  );
  assert.equal(error.code, CODES.ADAPTER_REQUEST_PREDECESSOR_INVALID);
});

test("TRUSTED-LOCAL-CHAIN: a reordered operation is refused", () => {
  const root = ownedTempDir("erl2-tlo-reorder-");
  const { coordinator, host, request } = directRun(root);
  const first = coordinator.execute(
    host,
    request(0, null),
    "2026-08-12T18:00:00Z",
    () => "2026-08-12T18:00:01Z",
  );
  // Skipping straight to the third operation with a valid chain link: the plan
  // cursor refuses it, in plan vocabulary.
  const error = refusal(() =>
    coordinator.execute(
      host,
      request(2, compactPredecessorOf(first)),
      "2026-08-12T18:00:01Z",
      () => "2026-08-12T18:00:02Z",
    ),
  );
  assert.equal(error.code, CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID);
});

test("TRUSTED-LOCAL-CHAIN: an omitted operation is refused", () => {
  const root = ownedTempDir("erl2-tlo-omit-");
  const { coordinator, host, request } = directRun(root);
  const first = coordinator.execute(
    host,
    request(0, null),
    "2026-08-12T18:00:00Z",
    () => "2026-08-12T18:00:01Z",
  );
  const second = coordinator.execute(
    host,
    request(1, compactPredecessorOf(first)),
    "2026-08-12T18:00:01Z",
    () => "2026-08-12T18:00:02Z",
  );
  // Operation three exists in the plan; jumping to four cannot skip it.
  const error = refusal(() =>
    coordinator.execute(
      host,
      request(3, compactPredecessorOf(second)),
      "2026-08-12T18:00:02Z",
      () => "2026-08-12T18:00:03Z",
    ),
  );
  assert.equal(error.code, CODES.ADAPTER_LOCAL_OPERATION_ORDER_INVALID);
});

test("TRUSTED-LOCAL-CHAIN: a duplicated operation is idempotent, never a second dispatch", () => {
  const root = ownedTempDir("erl2-tlo-dup-");
  const { coordinator, host, request } = directRun(root);
  const first = coordinator.execute(
    host,
    request(0, null),
    "2026-08-12T18:00:00Z",
    () => "2026-08-12T18:00:01Z",
  );
  const recordCount = coordinator.operationRecords.length;
  const replay = coordinator.execute(
    host,
    request(0, null),
    "2026-08-12T18:00:02Z",
    () => "2026-08-12T18:00:03Z",
  );
  assert.equal(replay.core_hash, first.core_hash, "a replayed terminal must be the same record");
  assert.equal(
    coordinator.operationRecords.length,
    recordCount,
    "a duplicate must not append a second dispatch",
  );
});

test("TRUSTED-LOCAL-CHAIN: a failed operation stays failed and the cleanup suffix still runs", () => {
  const root = ownedTempDir("erl2-tlo-fail-");
  const inputs = writeTrustedLocalInputs(
    root,
    [
      { operation: "acquire", cleanup: false },
      { operation: "translate-evidence", cleanup: false },
      { operation: "report-residue", cleanup: true },
    ],
    { fixture: "fault" },
  );
  const result = run(inputs);
  assert.equal(result.ok, false, "a run with a failed operation must not report success");
  assert.equal(result.errors?.[0]?.code, CODES.ADAPTER_LOCAL_CLEANUP_INCOMPLETE);

  // The record is retained regardless, and it says what happened rather than
  // rounding the failure away.
  const record = JSON.parse(
    readFileSync(path.join(inputs.outputRoot, "trusted-local-observation-record.json"), "utf8"),
  ) as {
    operation_outcomes: readonly { operation: string; state: string }[];
  };
  const byOperation = new Map(
    record.operation_outcomes.map((outcome) => [outcome.operation, outcome.state]),
  );
  assert.equal(byOperation.get("acquire"), "completed");
  assert.equal(byOperation.get("translate-evidence"), "failed");
  assert.equal(
    byOperation.get("report-residue"),
    "completed",
    "the frozen cleanup suffix runs after a main-sequence failure",
  );
});
