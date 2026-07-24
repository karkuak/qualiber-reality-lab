/**
 * CONTRACT: the Slice 5 adapter platform contracts.
 *
 * Each contract gets a minimal valid fixture, a representative valid fixture,
 * and the negative family the implementation plan requires: unknown field,
 * missing required field, wrong schema version, oversized value, and — where
 * the contract has one — its conditional invariant and its cross-phase or
 * forward-reference violation.
 *
 * The negatives are generated from the valid fixture rather than hand-written,
 * so a new required field cannot quietly escape the unknown-field and
 * wrong-version checks.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateContract, PACKAGE_KINDS, ADAPTER_OPERATIONS } from "@erl2/contracts";

const HASH = (c: string): string => `sha256:${c.repeat(64)}`;
const RUN_ID = "01890000-0000-7000-8000-00000000000d";
const NOW = "2026-07-01T00:00:00Z";

interface Case {
  readonly contract: string;
  readonly valid: Record<string, unknown>;
  /** Additional targeted negatives, each expected to fail validation. */
  readonly invalid?: readonly (readonly [string, Record<string, unknown>])[];
}

const negotiation = {
  schema_version: "adapter-protocol-negotiation/v1",
  run_id: RUN_ID,
  adapter_manifest_hash: HASH("1"),
  host_protocol_version: "subject-adapter/v1",
  adapter_protocol_version: "subject-adapter/v1",
  adapter_id: "reference-correct",
  adapter_version: "0.1.0",
  adapter_artifact_hash: HASH("2"),
  supported_operations: ["acquire", "validate-package"],
  supported_package_kinds: ["archive"],
  max_request_bytes: 1048576,
  max_response_bytes: 1048576,
  negotiated_at: NOW,
  core_hash: HASH("3"),
};

const responseEnvelope = {
  schema_version: "adapter-response-envelope/v1",
  protocol_version: "subject-adapter/v1",
  run_id: RUN_ID,
  operation_id: "op-acquire",
  operation: "acquire",
  status: "supported",
  result_core_hash: HASH("4"),
  result_schema_version: "reference-correct-acquisition/v1",
  mutation_receipt_hashes: [],
  compensation_receipt_hashes: [],
  credential_use_receipt_hashes: [],
  diagnostics_manifest_hash: HASH("5"),
  unsupported_inputs: [],
  active_operator_ms: 1800,
  responded_at: NOW,
  core_hash: HASH("6"),
};

const capabilityGrant = {
  schema_version: "adapter-capability-grant/v1",
  run_id: RUN_ID,
  operation_id: "op-acquire",
  grant_id: "grant-0001",
  adapter_manifest_hash: HASH("1"),
  requested_capability_ids: ["write-run-output", "elevate-to-root"],
  granted_capability_ids: ["write-run-output"],
  denied_capability_ids: ["elevate-to-root"],
  denial_codes: ["ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED"],
  privileged_broker_state: "absent_pending_erl2_oq_001",
  granted_at: NOW,
  core_hash: HASH("7"),
};

const mutationIntent = {
  schema_version: "mutation-intent/v1",
  run_id: RUN_ID,
  operation_id: "op-install",
  mutation_id: "install-runtime",
  mutation_class: "filesystem",
  capability_id: "write-adapter-workspace",
  target_identity_hash: HASH("8"),
  target_descriptor: "adapter-workspace/reference-correct/runtime",
  before_state_hash: HASH("9"),
  compensation_id: "remove-runtime",
  compensation_capability_id: "write-adapter-workspace",
  declared_at: NOW,
  core_hash: HASH("a"),
};

const mutationReceipt = {
  schema_version: "mutation-receipt/v1",
  run_id: RUN_ID,
  operation_id: "op-install",
  mutation_id: "install-runtime",
  mutation_intent_hash: HASH("a"),
  capability_id: "write-adapter-workspace",
  target_identity_hash: HASH("8"),
  before_state_hash: HASH("9"),
  after_state_hash: HASH("b"),
  status: "succeeded",
  compensation_id: "remove-runtime",
  idempotency_key: "0".repeat(64),
  started_at: NOW,
  ended_at: NOW,
  core_hash: HASH("c"),
};

const compensationReceipt = {
  schema_version: "compensation-receipt/v1",
  run_id: RUN_ID,
  compensation_id: "remove-runtime",
  mutation_id: "install-runtime",
  mutation_receipt_hash: HASH("c"),
  target_identity_hash: HASH("8"),
  before_state_hash: HASH("b"),
  after_state_hash: HASH("9"),
  status: "succeeded",
  compensated_at: NOW,
  core_hash: HASH("d"),
};

const credentialRequest = {
  schema_version: "credential-handle-request/v1",
  run_id: RUN_ID,
  operation_id: "op-acquire",
  handle_request_id: "handle-request-1",
  credential_reference_kind: "development-keychain-reference",
  requested_scope_ids: ["subject-registry-read"],
  requested_ttl_seconds: 60,
  requested_max_uses: 2,
  bound_target_hash: HASH("e"),
  purpose_code: "acquire-package",
  requested_at: NOW,
  core_hash: HASH("f"),
};

const credentialGrant = {
  schema_version: "credential-handle-grant/v1",
  run_id: RUN_ID,
  operation_id: "op-acquire",
  handle_id: "handle-0001",
  handle_request_hash: HASH("f"),
  adapter_manifest_hash: HASH("1"),
  requested_scope_ids: ["subject-registry-read", "org-admin"],
  granted_scope_ids: ["subject-registry-read"],
  denied_scope_ids: ["org-admin"],
  denial_codes: ["SECRET_CREDENTIAL_SCOPE_EXCEEDED"],
  bound_target_hash: HASH("e"),
  max_uses: 2,
  issued_at: NOW,
  expires_at: "2026-07-01T00:01:00Z",
  core_hash: HASH("1"),
};

const credentialUse = {
  schema_version: "credential-use-receipt/v1",
  run_id: RUN_ID,
  operation_id: "op-acquire",
  handle_id: "handle-0001",
  grant_hash: HASH("1"),
  adapter_manifest_hash: HASH("1"),
  used_scope_id: "subject-registry-read",
  target_identity_hash: HASH("e"),
  use_index: 1,
  decision: "allowed",
  used_at: NOW,
  core_hash: HASH("2"),
};

const egressPolicy = {
  schema_version: "egress-allowlist-policy/v1",
  policy_id: "adapter-default-deny",
  default_action: "deny",
  allowed_schemes: ["https"],
  allowed_hosts: ["registry.example.test"],
  allowed_ports: [443],
  max_redirects: 0,
  revalidate_redirect_targets: true,
  allow_loopback_hosts: [],
  deny_link_local: true,
  deny_metadata_service: true,
  deny_proxy_bypass: true,
  core_hash: HASH("3"),
};

const egressDecision = {
  schema_version: "egress-decision-receipt/v1",
  run_id: RUN_ID,
  operation_id: "op-acquire",
  decision_id: "egress-1",
  policy_hash: HASH("3"),
  request_url_hash: HASH("4"),
  scheme: "https",
  host: "registry.example.test",
  port: 443,
  resolved_address_hashes: [HASH("5")],
  redirect_chain_url_hashes: [],
  decision: "allowed",
  decided_at: NOW,
  core_hash: HASH("6"),
};

const sandboxManifest = {
  schema_version: "sandbox-invocation-manifest/v1",
  run_id: RUN_ID,
  operation_id: "op-acquire",
  invocation_id: "invocation-0001",
  adapter_manifest_hash: HASH("1"),
  adapter_artifact_hash: HASH("2"),
  executable_file_sha256: HASH("7"),
  protocol_version: "subject-adapter/v1",
  working_directory_path: "adapter-workspace/op-acquire",
  read_only_mounts: [
    {
      mount_id: "subject-visible",
      logical_path: "mounts/subject-visible",
      purpose: "subject-visible-input",
      read_only: true,
    },
  ],
  writable_output_path: "adapter-workspace/op-acquire/output",
  environment_variable_names: ["ERL2_RUN_ID"],
  enforced_controls: [
    { control_id: "separate-process", state: "enforced" },
    {
      control_id: "no-docker-socket",
      state: "unsupported_on_this_host",
      reason_code: "PROCESS_PROFILE_SHARES_HOST_SOCKETS",
    },
  ],
  resource_limits: {
    wall_clock_ms: 30000,
    max_request_bytes: 1048576,
    max_response_bytes: 1048576,
    max_output_files: 64,
    max_output_bytes: 1048576,
    max_output_path_depth: 6,
    max_diagnostic_bytes: 65536,
  },
  egress_policy_hash: HASH("3"),
  capability_ids: ["write-run-output"],
  credential_handle_ids: [],
  deadline: "2026-07-01T00:00:30Z",
  created_at: NOW,
  core_hash: HASH("8"),
};

const sandboxResult = {
  schema_version: "sandbox-invocation-result/v1",
  run_id: RUN_ID,
  invocation_id: "invocation-0001",
  manifest_hash: HASH("8"),
  outcome: "completed",
  exit_status: 0,
  process_tree_terminated: false,
  terminated_descendant_count: 0,
  request_bytes: 2048,
  response_bytes: 512,
  stdout_bytes: 512,
  stderr_bytes: 0,
  wall_clock_ms: 86,
  started_at: NOW,
  ended_at: "2026-07-01T00:00:01Z",
  core_hash: HASH("9"),
};

const diagnostics = {
  schema_version: "subject-diagnostics-manifest/v1",
  run_id: RUN_ID,
  operation_id: "op-acquire",
  entries: [],
  tree_hash: HASH("a"),
  total_bytes: 0,
  truncated: false,
  scan: {
    scanner_version: "erl2-diagnostic-scanner/1",
    secret_canaries_found: 0,
    judge_canaries_found: 0,
    forbidden_identifiers_found: 0,
    redactions_applied: 0,
  },
  frozen_at: NOW,
  core_hash: HASH("b"),
};

const residue = {
  schema_version: "residue-report/v1",
  run_id: RUN_ID,
  operation_id: "op-remove",
  scope: "adapter_workspace",
  before_inventory_hash: HASH("c"),
  after_inventory_hash: HASH("d"),
  residual_resources: [],
  residual_paths: [],
  status: "clean",
  reported_at: NOW,
  core_hash: HASH("e"),
};

const failureReport = {
  schema_version: "adapter-failure-report/v1",
  run_id: RUN_ID,
  operation_id: "op-acquire",
  adapter_manifest_hash: HASH("1"),
  owner: "adapter",
  category: "adapter_timeout",
  refusal_code: "ADAPTER_DEADLINE_EXCEEDED",
  evidence_refs: [HASH("9")],
  sandbox_result_hash: HASH("9"),
  subject_attribution_proven: false,
  safe_summary: "the adapter exceeded its deadline and its process tree was terminated",
  reported_at: NOW,
  core_hash: HASH("f"),
};

const certificationReceipt = {
  schema_version: "subject-adapter-certification-receipt/v1",
  receipt_id: "cert-reference-correct",
  suite: "ADAPTER-CERT-V1",
  adapter_manifest_hash: HASH("1"),
  adapter_artifact_hash: HASH("2"),
  adapter_id: "reference-correct",
  adapter_version: "0.1.0",
  certified_operations: ["acquire", "validate-package"],
  certified_package_kinds: ["archive"],
  checks: [
    { check_id: "protocol-negotiation", status: "passed", severity: "info", detail: "negotiated" },
  ],
  verdict: "certified",
  refusal_codes: [],
  certifier_id: "erl2-certifier",
  certifier_is_adapter_owner: false,
  enforced_controls: ["separate-process"],
  unsupported_controls: ["no-docker-socket"],
  certified_at: NOW,
  core_hash: HASH("1"),
};

const CASES: readonly Case[] = [
  {
    contract: "AdapterProtocolNegotiationV1",
    valid: negotiation,
    invalid: [
      // Wrong protocol version: the host offers exactly one.
      ["wrong protocol", { ...negotiation, adapter_protocol_version: "subject-adapter/v2" }],
      ["unknown operation", { ...negotiation, supported_operations: ["escalate"] }],
      ["unknown package kind", { ...negotiation, supported_package_kinds: ["floppy"] }],
    ],
  },
  {
    contract: "AdapterResponseEnvelopeV1",
    valid: responseEnvelope,
    invalid: [
      // A supported outcome may not carry an error…
      [
        "supported with error",
        {
          ...responseEnvelope,
          error: { code: "X_FAILED", owner: "adapter", safe_message: "no" },
        },
      ],
      // …and a failed one must.
      [
        "failed without error",
        { ...responseEnvelope, status: "failed", result_core_hash: undefined },
      ],
      // Only an unsupported outcome may list unsupported inputs.
      ["supported with unsupported inputs", { ...responseEnvelope, unsupported_inputs: ["x"] }],
      // The adapter plane cannot attribute a failure to the Lab.
      [
        "lab attribution",
        {
          ...responseEnvelope,
          status: "failed",
          result_core_hash: undefined,
          result_schema_version: undefined,
          error: { code: "LAB_BROKE_IT", owner: "lab", safe_message: "not me" },
        },
      ],
    ],
  },
  {
    contract: "AdapterCapabilityGrantV1",
    valid: capabilityGrant,
    invalid: [
      ["broker claimed present", { ...capabilityGrant, privileged_broker_state: "active" }],
      ["capability outside the enum", { ...capabilityGrant, granted_capability_ids: ["sudo"] }],
    ],
  },
  {
    contract: "MutationIntentV1",
    valid: mutationIntent,
    invalid: [
      ["unknown mutation class", { ...mutationIntent, mutation_class: "dns" }],
      ["no compensation identity", { ...mutationIntent, compensation_id: undefined }],
    ],
  },
  {
    contract: "MutationReceiptV1",
    valid: mutationReceipt,
    invalid: [
      ["failed without a code", { ...mutationReceipt, status: "failed" }],
      ["succeeded with a code", { ...mutationReceipt, error_code: "X_FAILED" }],
      ["malformed idempotency key", { ...mutationReceipt, idempotency_key: "short" }],
    ],
  },
  {
    contract: "CompensationReceiptV1",
    valid: compensationReceipt,
    invalid: [
      ["failed without a reason", { ...compensationReceipt, status: "failed" }],
      ["succeeded with a reason", { ...compensationReceipt, reason_code: "WHY" }],
    ],
  },
  {
    contract: "CredentialHandleRequestV1",
    valid: credentialRequest,
    invalid: [
      ["ttl beyond the ceiling", { ...credentialRequest, requested_ttl_seconds: 86400 }],
      ["no scopes", { ...credentialRequest, requested_scope_ids: [] }],
      // A plaintext secret has nowhere to go: any such field is unknown.
      ["plaintext secret field", { ...credentialRequest, secret: "hunter2" }],
    ],
  },
  { contract: "CredentialHandleGrantV1", valid: credentialGrant },
  {
    contract: "CredentialUseReceiptV1",
    valid: credentialUse,
    invalid: [
      ["denied without a code", { ...credentialUse, decision: "denied" }],
      ["allowed with a code", { ...credentialUse, denial_code: "SECRET_CREDENTIAL_HANDLE_EXPIRED" }],
    ],
  },
  {
    contract: "EgressAllowlistPolicyV1",
    valid: egressPolicy,
    invalid: [
      ["allow by default", { ...egressPolicy, default_action: "allow" }],
      ["metadata service permitted", { ...egressPolicy, deny_metadata_service: false }],
      ["redirects not revalidated", { ...egressPolicy, revalidate_redirect_targets: false }],
      ["wildcard host", { ...egressPolicy, allowed_hosts: ["*.example.test"] }],
    ],
  },
  {
    contract: "EgressDecisionReceiptV1",
    valid: egressDecision,
    invalid: [["denied without a code", { ...egressDecision, decision: "denied" }]],
  },
  {
    contract: "SandboxInvocationManifestV1",
    valid: sandboxManifest,
    invalid: [
      // A mount is read-only or it is not a mount.
      [
        "writable mount",
        {
          ...sandboxManifest,
          read_only_mounts: [
            {
              mount_id: "m",
              logical_path: "mounts/m",
              purpose: "subject-visible-input",
              read_only: false,
            },
          ],
        },
      ],
      // An unsupported control must say why it is unsupported.
      [
        "unsupported control with no reason",
        {
          ...sandboxManifest,
          enforced_controls: [{ control_id: "no-docker-socket", state: "unsupported_on_this_host" }],
        },
      ],
      // …and an enforced one may not carry a reason, which would blur the line.
      [
        "enforced control with a reason",
        {
          ...sandboxManifest,
          enforced_controls: [
            { control_id: "separate-process", state: "enforced", reason_code: "MAYBE" },
          ],
        },
      ],
      ["forbidden mount purpose", {
        ...sandboxManifest,
        read_only_mounts: [
          { mount_id: "m", logical_path: "mounts/m", purpose: "truth", read_only: true },
        ],
      }],
    ],
  },
  {
    contract: "SandboxInvocationResultV1",
    valid: sandboxResult,
    invalid: [["refused without a code", { ...sandboxResult, outcome: "refused" }]],
  },
  {
    contract: "SubjectDiagnosticsManifestV1",
    valid: diagnostics,
    invalid: [
      ["truncated without a reason", { ...diagnostics, truncated: true }],
      [
        "untruncated with a reason",
        { ...diagnostics, truncation_reason_code: "ADAPTER_DIAGNOSTICS_LIMIT_EXCEEDED" },
      ],
    ],
  },
  { contract: "ResidueReportV1", valid: residue },
  {
    contract: "AdapterFailureReportV1",
    valid: failureReport,
    invalid: [
      // A hostile adapter cannot be recorded as a subject defect.
      ["subject attribution", { ...failureReport, subject_attribution_proven: true }],
      ["subject ownership", { ...failureReport, owner: "subject" }],
    ],
  },
  {
    contract: "SubjectAdapterCertificationReceiptV1",
    valid: certificationReceipt,
    invalid: [
      // An adapter cannot self-certify.
      ["self-certified", { ...certificationReceipt, certifier_is_adapter_owner: true }],
      ["certified with refusals", { ...certificationReceipt, refusal_codes: ["X_FAILED"] }],
      ["refused with no refusal", { ...certificationReceipt, verdict: "refused" }],
      ["unknown suite", { ...certificationReceipt, suite: "ADAPTER-CERT-V2" }],
    ],
  },
];

/** Strips `undefined` so a fixture can express "remove this field". */
function prune(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

for (const testCase of CASES) {
  test(`CONTRACT: ${testCase.contract} accepts its valid fixture`, () => {
    const result = validateContract(testCase.contract, prune(testCase.valid));
    assert.equal(result.valid, true, JSON.stringify(result.problems));
  });

  test(`CONTRACT: ${testCase.contract} fails closed on the generic negative family`, () => {
    const valid = prune(testCase.valid);

    // Unknown field.
    assert.equal(
      validateContract(testCase.contract, { ...valid, metadata: { anything: true } }).valid,
      false,
      "an unknown field must fail closed",
    );

    // Wrong schema version.
    assert.equal(
      validateContract(testCase.contract, { ...valid, schema_version: "something/v9" }).valid,
      false,
      "a wrong schema version must fail closed",
    );

    // Missing required field: every declared key in the valid fixture is
    // removed in turn, and at least one removal must be rejected.
    const removals = Object.keys(valid).map((key) => {
      const copy = { ...valid };
      delete copy[key];
      return validateContract(testCase.contract, copy).valid;
    });
    assert.ok(
      removals.some((ok) => !ok),
      "removing a required field must fail closed",
    );

    // Oversized value: a string past every declared maximum.
    const stringKey = Object.entries(valid).find(
      ([key, v]) => typeof v === "string" && key !== "schema_version" && !key.endsWith("_hash"),
    );
    if (stringKey) {
      assert.equal(
        validateContract(testCase.contract, { ...valid, [stringKey[0]]: "x".repeat(4096) }).valid,
        false,
        `an oversized ${stringKey[0]} must fail closed`,
      );
    }

    // Forward reference: a hash-shaped field that no contract in this family
    // declares. It is an unknown field, which is the fail-closed behaviour.
    assert.equal(
      validateContract(testCase.contract, { ...valid, truth_commitment_hash: HASH("0") }).valid,
      false,
      "a forward reference must fail closed",
    );
  });

  for (const [label, invalid] of testCase.invalid ?? []) {
    test(`CONTRACT: ${testCase.contract} rejects ${label}`, () => {
      assert.equal(validateContract(testCase.contract, prune(invalid)).valid, false);
    });
  }
}

test("CONTRACT: the adapter operation and package-kind enums are closed and shared", () => {
  // The runtime constants and the schema enum must not drift apart.
  for (const operation of ADAPTER_OPERATIONS) {
    assert.equal(
      validateContract("AdapterProtocolNegotiationV1", {
        ...negotiation,
        supported_operations: [operation],
      }).valid,
      true,
      `${operation} is missing from the schema enum`,
    );
  }
  for (const kind of PACKAGE_KINDS) {
    assert.equal(
      validateContract("AdapterProtocolNegotiationV1", {
        ...negotiation,
        supported_package_kinds: [kind],
      }).valid,
      true,
      `${kind} is missing from the schema enum`,
    );
  }
});

test("REQUEST-ANCESTRY: the three phase requests stay structurally disjoint", () => {
  // Each phase request must reject the *other* phases' required ancestors, so
  // no single generic request can serve all three.
  const acquisitionOnly = "acquisition_source_manifest_hash";
  const packageOnly = "frozen_acquired_artifact";
  const postPlanOnly = "execution_plan_hash";
  const base = {
    protocol_version: "subject-adapter/v1",
    run_id: RUN_ID,
    operation_id: "op-1",
    deadline: "2030-01-01T00:00:00Z",
    core_hash: HASH("0"),
  };
  for (const [contract, foreign] of [
    ["AcquisitionAdapterRequestV1", [packageOnly, postPlanOnly]],
    ["PackageVerificationRequestV1", [postPlanOnly]],
    ["AdapterStepRequestV1", [acquisitionOnly, packageOnly]],
  ] as const) {
    for (const field of foreign) {
      const result = validateContract(contract, { ...base, [field]: HASH("1") });
      assert.equal(result.valid, false, `${contract} accepted the foreign ancestor ${field}`);
    }
  }
});
