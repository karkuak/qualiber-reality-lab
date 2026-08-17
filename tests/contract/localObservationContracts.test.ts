import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CONTRACTS,
  LOCAL_OBSERVATION_UNSUPPORTED_CLAIMS,
  validateContract,
  type AdapterOperation,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";
import { ARCHIVE_SHAPE, LOCAL_NOW, localFixture } from "../support/localObservationFixtures.js";

const fixture = localFixture(ARCHIVE_SHAPE);
const H = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}`;

function v2Objects(): Readonly<Record<string, Record<string, unknown>>> {
  const negotiationBase = {
    schema_version: "adapter-protocol-negotiation/v2",
    execution_id: fixture.plan.observation_id,
    adapter_manifest_hash: fixture.manifest.core_hash,
    offered_protocol_versions: ["subject-adapter/v2"],
    required_execution_mode: "local_observation",
    selected_protocol_version: "subject-adapter/v2",
    execution_mode: "local_observation",
    adapter_id: fixture.manifest.adapter_id,
    adapter_version: fixture.manifest.version,
    adapter_artifact_hash: fixture.manifest.adapter_artifact_hash,
    supported_operations: [ARCHIVE_SHAPE.operation],
    supported_package_kinds: [ARCHIVE_SHAPE.packageKind],
    max_request_bytes: 262144,
    max_response_bytes: 262144,
    negotiated_at: LOCAL_NOW,
  };
  const envelopeBase = {
    schema_version: "adapter-response-envelope/v2",
    protocol_version: "subject-adapter/v2",
    execution_mode: "local_observation",
    execution_id: fixture.plan.observation_id,
    operation_id: fixture.request.operation_id,
    operation: fixture.request.operation,
    request_core_hash: fixture.request.core_hash,
    status: "supported",
    result_core_hash: H("b"),
    result_schema_version: "local-archive-structure/v1",
    mutation_receipt_hashes: [],
    compensation_receipt_hashes: [],
    credential_use_receipt_hashes: [],
    unsupported_inputs: [],
    active_operator_ms: 0,
    responded_at: LOCAL_NOW,
  };
  const sandboxBase = {
    schema_version: "sandbox-invocation-manifest/v2",
    execution_id: fixture.plan.observation_id,
    execution_mode: "local_observation",
    operation_id: fixture.request.operation_id,
    invocation_id: "invocation-one",
    adapter_manifest_hash: fixture.manifest.core_hash,
    adapter_artifact_hash: fixture.manifest.adapter_artifact_hash,
    executable_file_sha256: fixture.manifest.adapter_artifact_hash,
    protocol_version: "subject-adapter/v2",
    working_directory_path: "observation-workspace/local-op-one",
    read_only_mounts: [],
    writable_output_path: "local-observation-output/local-op-one",
    sandbox_profile: "local-process",
    environment_variable_names: [...fixture.plan.resource_limits.environment_variable_names],
    enforced_controls: [
      { control_id: "process-tree-termination", state: "enforced" },
      { control_id: "deny-by-default-egress", state: "unsupported_on_this_host", reason_code: "NO_NETWORK_NAMESPACE" },
    ],
    resource_limits: fixture.plan.resource_limits,
    egress_policy_hash: fixture.plan.egress_policy.core_hash,
    capability_ids: [],
    credential_handle_ids: [],
    deadline: fixture.request.deadline,
    created_at: LOCAL_NOW,
  };
  const operationBase = {
    schema_version: "local-observation-operation-record/v1",
    state: "declared",
    observation_id: fixture.plan.observation_id,
    plan_hash: fixture.plan.core_hash,
    operation_id: fixture.request.operation_id,
    operation: fixture.request.operation,
    sequence: 0,
    request_hash: fixture.request.core_hash,
    idempotency_key: "1".repeat(64),
    cleanup_eligible: false,
    declared_at: LOCAL_NOW,
    evidence_authenticity: "unauthenticated_local_record",
  };
  const cleanup = {
    status: "cleanup_complete",
    stop: "not_applicable",
    compensation: "not_applicable",
    uninstall: "not_applicable",
    residue: "not_observed",
    reason_codes: [],
  };
  const resultBase = {
    schema_version: "local-observation-result/v1",
    observation_id: fixture.plan.observation_id,
    plan_hash: fixture.plan.core_hash,
    protocol_version: "subject-adapter/v2",
    adapter_id: fixture.manifest.adapter_id,
    adapter_version: fixture.manifest.version,
    adapter_manifest_hash: fixture.manifest.core_hash,
    certification_receipt_hash: fixture.receipt.core_hash,
    adapter_artifact_hash: fixture.manifest.adapter_artifact_hash,
    certification_authenticity: "locally_observed_unauthenticated",
    operation_record_hashes: [H("c")],
    retained_input_refs: [],
    retained_output_refs: [],
    retained_evidence_refs: [],
    structural_validation: [],
    cleanup,
    status: "observed_complete",
    started_at: LOCAL_NOW,
    ended_at: LOCAL_NOW,
    not_scored: true,
    not_governor_authorized: true,
    unsupported_claims: [...LOCAL_OBSERVATION_UNSUPPORTED_CLAIMS],
    evidence_authenticity: "unauthenticated_local_record",
  };
  return {
    SubjectAdapterManifestV2: fixture.manifest as unknown as Record<string, unknown>,
    SubjectAdapterCertificationReceiptV2: fixture.receipt as unknown as Record<string, unknown>,
    AdapterProtocolNegotiationV2: { ...negotiationBase, core_hash: coreHash(negotiationBase) },
    AdapterRequestV2: fixture.request as unknown as Record<string, unknown>,
    AdapterResponseEnvelopeV2: { ...envelopeBase, core_hash: coreHash(envelopeBase) },
    SandboxInvocationManifestV2: { ...sandboxBase, core_hash: coreHash(sandboxBase) },
    LocalObservationLimitsV1: fixture.plan.resource_limits as unknown as Record<string, unknown>,
    LocalObservationPlanV1: fixture.plan as unknown as Record<string, unknown>,
    LocalObservationOperationRecordV1: { ...operationBase, core_hash: coreHash(operationBase) },
    LocalObservationResultV1: { ...resultBase, core_hash: coreHash(resultBase) },
  };
}

test("LOCAL-CONTRACTS: exactly ERL2-C-161 through ERL2-C-170 are registered", () => {
  const added = CONTRACTS.filter((contract) => /^ERL2-C-1(6[1-9]|70)$/.test(contract.id));
  assert.deepEqual(added.map((contract) => contract.id), [
    "ERL2-C-161", "ERL2-C-162", "ERL2-C-163", "ERL2-C-164", "ERL2-C-165",
    "ERL2-C-166", "ERL2-C-167", "ERL2-C-168", "ERL2-C-169", "ERL2-C-170",
  ]);
  assert.equal(added.length, 10);
});

test("LOCAL-CONTRACTS: all ten approved objects validate and reject unknown fields", () => {
  for (const [contract, value] of Object.entries(v2Objects())) {
    assert.equal(validateContract(contract, value).valid, true, `${contract} fixture invalid`);
    assert.equal(
      validateContract(contract, { ...value, arbitrary_metadata: {} }).valid,
      false,
      `${contract} accepted arbitrary metadata`,
    );
  }
});

const payloads: Readonly<Record<AdapterOperation, Record<string, unknown>>> = {
  acquire: { schema_version: "acquire-payload/v1", provenance_mode: "acquired", source_descriptor_input_id: "source-input", output_input_id: "package-output", expected_package_kind: "archive", credential_handle_ids: [] },
  "validate-package": { schema_version: "validate-package-payload/v1", package_input_id: "package-input", package_kind: "archive" },
  install: { schema_version: "install-payload/v1", package_input_id: "package-input" },
  configure: { schema_version: "configure-payload/v1", configuration_input_ids: [] },
  start: { schema_version: "start-payload/v1", input_ids: [] },
  interact: { schema_version: "interact-payload/v1", interaction_input_ids: [] },
  "translate-evidence": { schema_version: "translate-evidence-payload/v1", evidence_input_ids: [], evidence_mount_handle_id: "evidence-mount" },
  "collect-outputs": { schema_version: "collect-outputs-payload/v1", requested_output_role_ids: [] },
  project: { schema_version: "project-payload/v1", evidence_input_ids: [], projection_schema: "local-draft-v1" },
  stop: { schema_version: "stop-payload/v1", start_operation_id: "start-op" },
  uninstall: { schema_version: "uninstall-payload/v1", install_operation_id: "install-op" },
  "report-residue": { schema_version: "report-residue-payload/v1", checkpoint: "final" },
  compensate: { schema_version: "compensate-payload/v1", mutation_receipt_hashes: [H("d")] },
};

test("LOCAL-PAYLOADS: all thirteen operation payloads are closed and correlated", () => {
  for (const [operation, payload] of Object.entries(payloads) as [AdapterOperation, Record<string, unknown>][]) {
    const request = structuredClone(fixture.request) as unknown as Record<string, unknown>;
    request["operation"] = operation;
    request["operation_payload"] = payload;
    assert.equal(validateContract("AdapterRequestV2", request).valid, true, operation);
    const unknown = { ...payload, product_metadata: "forbidden" };
    request["operation_payload"] = unknown;
    assert.equal(validateContract("AdapterRequestV2", request).valid, false, `${operation} is open`);
  }
  const mismatch = structuredClone(fixture.request) as unknown as Record<string, unknown>;
  mismatch["operation_payload"] = payloads["install"];
  assert.equal(validateContract("AdapterRequestV2", mismatch).valid, false);
});

test("LOCAL-CLOSURE: governed fields, claim changes, signatures and trusted status words are unrepresentable", () => {
  const forbidden = [
    "governor_id", "preregistration_hash", "acquisition_preregistration_hash", "execution_plan_hash",
    "visible_step", "judge_expectation", "judge_expectation_hash", "trust_policy_hash", "score",
    "qualification", "reveal_state", "tier", "commitment_hash", "metadata",
  ];
  for (const field of forbidden) {
    const request = structuredClone(fixture.request) as unknown as { execution_context: Record<string, unknown> };
    request.execution_context[field] = field.endsWith("_hash") ? H("e") : "forbidden";
    assert.equal(validateContract("AdapterRequestV2", request).valid, false, field);
  }
  const recursive = structuredClone(fixture.request) as unknown as {
    execution_context: { input_artifact_refs: Record<string, unknown>[] };
  };
  recursive.execution_context.input_artifact_refs[0]!["judge_expectation"] = "forbidden";
  assert.equal(validateContract("AdapterRequestV2", recursive).valid, false);

  for (const change of [
    { not_scored: false },
    { not_governor_authorized: false },
    { unsupported_claims: LOCAL_OBSERVATION_UNSUPPORTED_CLAIMS.slice(0, 5) },
    { unsupported_claims: [...LOCAL_OBSERVATION_UNSUPPORTED_CLAIMS].reverse() },
    { signature: { algorithm: "Ed25519" } },
    { status: "qualified" },
  ]) {
    const result = { ...v2Objects()["LocalObservationResultV1"], ...change };
    assert.equal(validateContract("LocalObservationResultV1", result).valid, false, JSON.stringify(change));
  }
});

test("LOCAL-ANCESTRY: first and later predecessor rules fail closed", () => {
  const first = structuredClone(fixture.request) as unknown as Record<string, unknown>;
  first["ancestry"] = { sequence: 1, predecessor: null };
  assert.equal(validateContract("AdapterRequestV2", first).valid, false);
  first["ancestry"] = {
    sequence: 0,
    predecessor: {
      operation_id: "prior-op",
      operation_record_hash: H("1"),
      request_hash: H("2"),
      outcome: "completed",
      response_envelope_hash: H("3"),
    },
  };
  assert.equal(validateContract("AdapterRequestV2", first).valid, false);
});

test("LOCAL-LIMITS: every numeric, root and environment boundary is contract-enforced", () => {
  const limits = fixture.plan.resource_limits as unknown as Record<string, unknown>;
  const maxima: Record<string, number> = {
    wall_clock_ms: 5_400_000,
    max_request_bytes: 16_777_216,
    max_response_bytes: 16_777_216,
    max_output_files: 100_000,
    max_output_bytes: 68_719_476_736,
    max_output_path_depth: 64,
    max_diagnostic_bytes: 16_777_216,
    max_diagnostic_line_bytes: 65_536,
  };
  for (const [field, maximum] of Object.entries(maxima)) {
    assert.equal(validateContract("LocalObservationLimitsV1", { ...limits, [field]: maximum }).valid, true, field);
    assert.equal(validateContract("LocalObservationLimitsV1", { ...limits, [field]: maximum + 1 }).valid, false, field);
  }
  assert.equal(validateContract("LocalObservationLimitsV1", { ...limits, input_root: "/absolute" }).valid, false);
  assert.equal(
    validateContract("LocalObservationLimitsV1", {
      ...limits,
      environment_variable_names: [...(limits["environment_variable_names"] as string[]), "HOME"],
    }).valid,
    false,
  );
});
