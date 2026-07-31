// GENERATED FILE — DO NOT EDIT.
// Produced by scripts/generate-types.mjs from packages/contracts/schemas/*.schema.json.
// Run `npm run generate` after any schema change; `npm run verify:generated` proves
// the committed output matches the schemas (implementation plan §5 rule 1).
/* eslint-disable */

// ---- erl2:acquisition : ERL2 acquisition, package and adapter-request contracts ----

export type AcquisitionSourceManifestV1 = {
  readonly schema_version: "acquisition-source-manifest/v1";
  readonly source_id: Id;
  readonly source_kind: "local_delivery" | "registry" | "release_api" | "approved_repository";
  readonly locator_hash: Hash;
  readonly requested_version_or_channel: string;
  readonly authentication_ref_kind?: Id;
  readonly integrity_policy_hash: Hash;
  readonly provenance_policy_hash: Hash;
  readonly network_profile_hash: Hash;
  readonly documentation_entrypoint_hash?: Hash;
  readonly expected_package_sha256?: Hash;
  readonly limits: {
    readonly runtime_ms: number;
    readonly bytes: number;
    readonly redirects: number;
  };
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type AcquisitionPreregistrationV1 = {
  readonly schema_version: "acquisition-preregistration/v1";
  readonly preregistration_id: Id;
  readonly run_id: RunId;
  readonly acquisition_source_manifest_hash: Hash;
  readonly adapter_manifest_hash: Hash;
  readonly acquisition_actor_script_hash: Hash;
  readonly acquisition_actor_schema_hash: Hash;
  readonly acquisition_step_commitment_hash: Hash;
  readonly package_verification_step_commitment_hash: Hash;
  readonly generic_run_policy_hash: Hash;
  readonly run_trust_policy_hash: Hash;
  readonly limits_hash: Hash;
  readonly registered_at: Instant;
  readonly expires_at: Instant;
  readonly selected_case_identity: "absent";
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type AcquisitionPreregistrationVerificationReceiptV1 = {
  readonly schema_version: "acquisition-preregistration-verification-receipt/v1";
  readonly run_id: RunId;
  readonly acquisition_preregistration_hash: Hash;
  readonly source_manifest_hash: Hash;
  readonly adapter_manifest_hash: Hash;
  readonly trust_policy_hash: Hash;
  readonly selected_case_identity_absent: true;
  readonly signature_valid: true;
  readonly verified_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type VisibleStepReference = {
  readonly artifact: ArtifactRef;
  readonly core_hash: Hash;
};

export type AcquisitionAdapterRequestV1 = {
  readonly schema_version: "acquisition-adapter-request/v1";
  readonly protocol_version: "subject-adapter/v1";
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly acquisition_preregistration_hash: Hash;
  readonly acquisition_source_manifest_hash: Hash;
  readonly adapter_manifest_hash: Hash;
  readonly visible_step: VisibleStepReference;
  readonly credential_handle_ids: IdArray;
  readonly resource_limit_hash: Hash;
  readonly deadline: Instant;
  readonly core_hash: Hash;
};

export type PackageVerificationRequestV1 = {
  readonly schema_version: "package-verification-request/v1";
  readonly protocol_version: "subject-adapter/v1";
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly acquisition_preregistration_hash: Hash;
  readonly acquisition_record_hash: Hash;
  readonly frozen_acquired_artifact: ArtifactRef;
  readonly frozen_package_file_sha256: Hash;
  readonly integrity_policy_hash: Hash;
  readonly provenance_policy_hash: Hash;
  readonly adapter_manifest_hash: Hash;
  readonly visible_step: VisibleStepReference;
  readonly deadline: Instant;
  readonly core_hash: Hash;
};

export type AdapterStepRequestV1 = {
  readonly schema_version: "adapter-step-request/v1";
  readonly protocol_version: "subject-adapter/v1";
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly execution_plan_hash: Hash;
  readonly visible_step: VisibleStepReference;
  readonly canonical_evidence_envelope_hash?: Hash;
  readonly canonical_evidence_mount_handle_id?: Id;
  readonly prior_visible_interaction_hashes: HashArray;
  readonly credential_handle_ids: IdArray;
  readonly resource_limit_hash: Hash;
  readonly deadline: Instant;
  readonly core_hash: Hash;
};

export type SubjectAcquisitionRecordV1 = {
  readonly schema_version: "subject-acquisition-record/v1";
  readonly run_id: RunId;
  readonly acquisition_request_hash: Hash;
  readonly step_commitment_hash: Hash;
  readonly source_manifest_hash: Hash;
  readonly attempts: readonly ({
    readonly attempt_id: Id;
    readonly started_at: Instant;
    readonly ended_at: Instant;
    readonly status: "completed" | "failed";
    readonly bytes: number;
    readonly redirect_count: number;
    readonly error_codes: ShortStringArray;
  })[];
  readonly authentication_prompt_count: number;
  readonly documentation_step_ids: IdArray;
  readonly active_operator_ms: number;
  readonly elapsed_ms: number;
  readonly acquired_artifact?: ArtifactRef;
  readonly lab_network_control_hash: Hash;
  readonly dependency_health_hash?: Hash;
  readonly status: RecordStatus;
  readonly core_hash: Hash;
};

export type SubjectPackageVerificationRecordV1 = {
  readonly schema_version: "subject-package-verification-record/v1";
  readonly run_id: RunId;
  readonly verification_request_hash: Hash;
  readonly step_commitment_hash: Hash;
  readonly acquisition_record_hash: Hash;
  readonly frozen_package_file_sha256: Hash;
  readonly integrity_policy_hash: Hash;
  readonly provenance_policy_hash: Hash;
  readonly checks: readonly ({
    readonly check_id: Id;
    readonly passed: boolean;
    readonly evidence_refs: HashArray;
  })[];
  readonly status: RecordStatus;
  readonly started_at: Instant;
  readonly ended_at: Instant;
  readonly core_hash: Hash;
};

export type SubjectPackageManifestV1 = {
  readonly schema_version: "subject-package-manifest/v1";
  readonly subject_id: Id;
  readonly subject_version: string;
  readonly package_kind: "archive" | "oci" | "native" | "bundle";
  readonly acquisition_record_hash: Hash;
  readonly package_verification_record_hash: Hash;
  readonly package_file_sha256: Hash;
  readonly provenance: Provenance;
  readonly sbom?: ArtifactRef;
  readonly signature_evidence: ArtifactRefArray;
  readonly entrypoints: ShortStringArray;
  readonly runtime_requirements: ShortStringArray;
  readonly requested_resources: {
    readonly cpu_millis: number;
    readonly memory_mib: number;
    readonly disk_mib: number;
    readonly network_profile: Id;
  };
  readonly configuration_schema_hash: Hash;
  readonly capability_declaration_hash: Hash;
  readonly core_hash: Hash;
  readonly signature?: Signature;
};

export type SubjectAdapterManifestV1 = {
  readonly schema_version: "subject-adapter-manifest/v1";
  readonly adapter_id: Id;
  readonly version: string;
  readonly protocol_version: "subject-adapter/v1";
  readonly adapter_artifact_hash: Hash;
  readonly supported_package_kinds: readonly ("archive" | "oci" | "native" | "bundle")[];
  readonly operations: IdArray;
  readonly required_broker_capabilities: IdArray;
  readonly network_allowlist_ids: IdArray;
  readonly projection_schema: "generic-claim-set/v1";
  readonly certification_receipt_hash: Hash;
  readonly owner: string;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type GenericRunPolicyV1 = {
  readonly schema_version: "generic-run-policy/v1";
  readonly policy_id: Id;
  readonly version: number;
  readonly evidence_policy_hash: Hash;
  readonly cutoff_policy_hash: Hash;
  readonly journey_policy_hash: Hash;
  readonly generic_evaluation_policy_hash: Hash;
  readonly domain_pack_hashes: HashArray;
  readonly run_trust_policy_hash: Hash;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

// ---- erl2:adapter : ERL2 adapter platform: protocol, sandbox, capability, credential, mutation and certification contracts ----

export type AdapterProtocolVersion = "subject-adapter/v1";

export type AdapterOperationId = "acquire" | "validate-package" | "install" | "configure" | "start" | "interact" | "translate-evidence" | "collect-outputs" | "project" | "stop" | "uninstall" | "report-residue" | "compensate";

export type AdapterCapabilityId = "read-subject-visible-input" | "read-canonical-evidence" | "write-run-output" | "write-adapter-workspace" | "request-credential-handle" | "network-egress" | "bind-loopback-port" | "install-package-into-host" | "write-host-configuration" | "register-host-service" | "host-package-manager" | "load-kernel-module" | "use-docker-socket" | "elevate-to-root" | "reboot-host";

export type SandboxControlId = "separate-process" | "process-tree-termination" | "wall-clock-deadline" | "bounded-request-bytes" | "bounded-response-bytes" | "writable-output-only" | "environment-variable-allowlist" | "bounded-diagnostics" | "input-mount-tamper-detection" | "egress-policy-adjudication" | "docker-socket-capability-denied" | "privileged-capability-denied" | "read-only-input-mounts" | "no-ambient-home-directory" | "no-docker-socket" | "deny-by-default-egress" | "numeric-non-root-user" | "read-only-root-filesystem" | "capability-drop-all" | "no-new-privileges" | "seccomp-default-profile" | "pid-limit" | "memory-limit" | "cpu-limit" | "network-namespace-isolation";

export type MutationClass = "filesystem" | "service" | "configuration" | "package" | "credential" | "environment";

export type AdapterProtocolNegotiationV1 = {
  readonly schema_version: "adapter-protocol-negotiation/v1";
  readonly run_id: RunId;
  readonly adapter_manifest_hash: Hash;
  readonly host_protocol_version: AdapterProtocolVersion;
  readonly adapter_protocol_version: AdapterProtocolVersion;
  readonly adapter_id: Id;
  readonly adapter_version: string;
  readonly adapter_artifact_hash: Hash;
  readonly supported_operations: readonly AdapterOperationId[];
  readonly supported_package_kinds: readonly ("archive" | "oci" | "native" | "bundle")[];
  readonly max_request_bytes: number;
  readonly max_response_bytes: number;
  readonly negotiated_at: Instant;
  readonly core_hash: Hash;
};

export type AdapterResponseEnvelopeV1 = {
  readonly schema_version: "adapter-response-envelope/v1";
  readonly protocol_version: AdapterProtocolVersion;
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly operation: AdapterOperationId;
  readonly status: "supported" | "failed" | "unsupported";
  readonly result_core_hash?: Hash;
  readonly result_schema_version?: string;
  readonly mutation_receipt_hashes: HashArray;
  readonly compensation_receipt_hashes: HashArray;
  readonly credential_use_receipt_hashes: HashArray;
  readonly diagnostics_manifest_hash?: Hash;
  readonly unsupported_inputs: ShortStringArray;
  readonly error?: {
    readonly code: string;
    readonly owner: "adapter" | "subject";
    readonly safe_message: string;
  };
  readonly active_operator_ms: number;
  readonly responded_at: Instant;
  readonly core_hash: Hash;
};

export type AdapterCapabilityGrantV1 = {
  readonly schema_version: "adapter-capability-grant/v1";
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly grant_id: Id;
  readonly adapter_manifest_hash: Hash;
  readonly requested_capability_ids: readonly AdapterCapabilityId[];
  readonly granted_capability_ids: readonly AdapterCapabilityId[];
  readonly denied_capability_ids: readonly AdapterCapabilityId[];
  readonly denial_codes?: ShortStringArray;
  readonly privileged_broker_state: "absent_pending_erl2_oq_001";
  readonly granted_at: Instant;
  readonly core_hash: Hash;
};

export type MutationIntentV1 = {
  readonly schema_version: "mutation-intent/v1";
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly mutation_id: Id;
  readonly mutation_class: MutationClass;
  readonly capability_id: AdapterCapabilityId;
  readonly target_identity_hash: Hash;
  readonly target_descriptor: string;
  readonly before_state_hash: Hash;
  readonly compensation_id: Id;
  readonly compensation_capability_id: AdapterCapabilityId;
  readonly declared_at: Instant;
  readonly core_hash: Hash;
};

export type MutationReceiptV1 = {
  readonly schema_version: "mutation-receipt/v1";
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly mutation_id: Id;
  readonly mutation_intent_hash: Hash;
  readonly capability_id: AdapterCapabilityId;
  readonly target_identity_hash: Hash;
  readonly before_state_hash: Hash;
  readonly after_state_hash: Hash;
  readonly status: "succeeded" | "failed";
  readonly error_code?: string;
  readonly compensation_id: Id;
  readonly idempotency_key: string;
  readonly started_at: Instant;
  readonly ended_at: Instant;
  readonly core_hash: Hash;
};

export type CompensationReceiptV1 = {
  readonly schema_version: "compensation-receipt/v1";
  readonly run_id: RunId;
  readonly compensation_id: Id;
  readonly mutation_id: Id;
  readonly mutation_receipt_hash: Hash;
  readonly target_identity_hash: Hash;
  readonly before_state_hash: Hash;
  readonly after_state_hash: Hash;
  readonly status: "succeeded" | "failed" | "not_required";
  readonly reason_code?: string;
  readonly compensated_at: Instant;
  readonly core_hash: Hash;
};

export type CredentialHandleRequestV1 = {
  readonly schema_version: "credential-handle-request/v1";
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly handle_request_id: Id;
  readonly credential_reference_kind: "development-keychain-reference" | "workload-identity-reference" | "short-lived-token-reference";
  readonly requested_scope_ids: readonly Id[];
  readonly requested_ttl_seconds: number;
  readonly requested_max_uses: number;
  readonly bound_target_hash: Hash;
  readonly purpose_code: Id;
  readonly requested_at: Instant;
  readonly core_hash: Hash;
};

export type CredentialHandleGrantV1 = {
  readonly schema_version: "credential-handle-grant/v1";
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly handle_id: Id;
  readonly handle_request_hash: Hash;
  readonly adapter_manifest_hash: Hash;
  readonly requested_scope_ids: IdArray;
  readonly granted_scope_ids: IdArray;
  readonly denied_scope_ids: IdArray;
  readonly denial_codes?: ShortStringArray;
  readonly bound_target_hash: Hash;
  readonly max_uses: number;
  readonly issued_at: Instant;
  readonly expires_at: Instant;
  readonly core_hash: Hash;
};

export type CredentialUseReceiptV1 = {
  readonly schema_version: "credential-use-receipt/v1";
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly handle_id: Id;
  readonly grant_hash: Hash;
  readonly adapter_manifest_hash: Hash;
  readonly used_scope_id: Id;
  readonly target_identity_hash: Hash;
  readonly use_index: number;
  readonly decision: "allowed" | "denied";
  readonly denial_code?: string;
  readonly used_at: Instant;
  readonly core_hash: Hash;
};

export type EgressAllowlistPolicyV1 = {
  readonly schema_version: "egress-allowlist-policy/v1";
  readonly policy_id: Id;
  readonly default_action: "deny";
  readonly allowed_schemes: readonly ("https" | "http")[];
  readonly allowed_hosts: readonly string[];
  readonly allowed_ports: readonly number[];
  readonly max_redirects: number;
  readonly revalidate_redirect_targets: true;
  readonly allow_loopback_hosts: readonly string[];
  readonly deny_link_local: true;
  readonly deny_metadata_service: true;
  readonly deny_proxy_bypass: true;
  readonly core_hash: Hash;
};

export type EgressDecisionReceiptV1 = {
  readonly schema_version: "egress-decision-receipt/v1";
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly decision_id: Id;
  readonly policy_hash: Hash;
  readonly request_url_hash: Hash;
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
  readonly resolved_address_hashes: HashArray;
  readonly redirect_chain_url_hashes: HashArray;
  readonly decision: "allowed" | "denied";
  readonly denial_code?: string;
  readonly decided_at: Instant;
  readonly core_hash: Hash;
};

export type SandboxInvocationManifestV1 = {
  readonly schema_version: "sandbox-invocation-manifest/v1";
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly invocation_id: Id;
  readonly adapter_manifest_hash: Hash;
  readonly adapter_artifact_hash: Hash;
  readonly executable_file_sha256: Hash;
  readonly protocol_version: AdapterProtocolVersion;
  readonly working_directory_path: LogicalPath;
  readonly read_only_mounts: readonly ({
    readonly mount_id: Id;
    readonly logical_path: LogicalPath;
    readonly purpose: "subject-visible-input" | "canonical-evidence" | "frozen-package";
    readonly read_only: true;
  })[];
  readonly writable_output_path: LogicalPath;
  readonly environment_variable_names: ShortStringArray;
  readonly enforced_controls: readonly ({
    readonly control_id: SandboxControlId;
    readonly state: "enforced" | "unsupported_on_this_host";
    readonly reason_code?: string;
  })[];
  readonly resource_limits: {
    readonly wall_clock_ms: number;
    readonly max_request_bytes: number;
    readonly max_response_bytes: number;
    readonly max_output_files: number;
    readonly max_output_bytes: number;
    readonly max_output_path_depth: number;
    readonly max_diagnostic_bytes: number;
  };
  readonly egress_policy_hash?: Hash;
  readonly capability_ids: readonly AdapterCapabilityId[];
  readonly credential_handle_ids: IdArray;
  readonly deadline: Instant;
  readonly created_at: Instant;
  readonly core_hash: Hash;
};

export type SandboxInvocationResultV1 = {
  readonly schema_version: "sandbox-invocation-result/v1";
  readonly run_id: RunId;
  readonly invocation_id: Id;
  readonly manifest_hash: Hash;
  readonly outcome: "completed" | "timed_out" | "crashed" | "refused";
  readonly exit_status?: number;
  readonly termination_signal?: string;
  readonly process_tree_terminated: boolean;
  readonly terminated_descendant_count: number;
  readonly request_bytes: number;
  readonly response_bytes: number;
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
  readonly wall_clock_ms: number;
  readonly refusal_code?: string;
  readonly started_at: Instant;
  readonly ended_at: Instant;
  readonly core_hash: Hash;
};

export type SubjectDiagnosticsManifestV1 = {
  readonly schema_version: "subject-diagnostics-manifest/v1";
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly entries: ArtifactRefArray;
  readonly tree_hash: Hash;
  readonly total_bytes: number;
  readonly truncated: boolean;
  readonly truncation_reason_code?: string;
  readonly scan: {
    readonly scanner_version: string;
    readonly secret_canaries_found: number;
    readonly judge_canaries_found: number;
    readonly forbidden_identifiers_found: number;
    readonly redactions_applied: number;
  };
  readonly frozen_at: Instant;
  readonly core_hash: Hash;
};

export type ResidueReportV1 = {
  readonly schema_version: "residue-report/v1";
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly scope: "adapter_workspace" | "run_output" | "environment";
  readonly before_inventory_hash: Hash;
  readonly after_inventory_hash: Hash;
  readonly residual_resources: ResourceIdentityList;
  readonly residual_paths: ShortStringArray;
  readonly status: "clean" | "residue_detected" | "unknown";
  readonly reported_at: Instant;
  readonly core_hash: Hash;
};

export type AdapterFailureReportV1 = {
  readonly schema_version: "adapter-failure-report/v1";
  readonly run_id: RunId;
  readonly operation_id: Id;
  readonly adapter_manifest_hash: Hash;
  readonly owner: "adapter" | "lab";
  readonly category: "adapter_protocol_failure" | "adapter_projection_failure" | "adapter_mutation_violation" | "adapter_sandbox_violation" | "adapter_capability_violation" | "adapter_credential_violation" | "adapter_egress_violation" | "adapter_output_violation" | "adapter_timeout" | "adapter_crash" | "lab_host_failure";
  readonly refusal_code: string;
  readonly evidence_refs: HashArray;
  readonly sandbox_result_hash?: Hash;
  readonly subject_attribution_proven: false;
  readonly safe_summary: string;
  readonly reported_at: Instant;
  readonly core_hash: Hash;
};

export type AdapterCertificationFindingV1 = {
  readonly check_id: Id;
  readonly status: "passed" | "failed" | "unsupported";
  readonly severity: "info" | "low" | "medium" | "high" | "critical";
  readonly detail: string;
  readonly refusal_code?: string;
  readonly evidence_refs?: HashArray;
};

export type SubjectAdapterCertificationReceiptV1 = {
  readonly schema_version: "subject-adapter-certification-receipt/v1";
  readonly receipt_id: Id;
  readonly suite: "ADAPTER-CERT-V1";
  readonly adapter_manifest_hash: Hash;
  readonly adapter_artifact_hash: Hash;
  readonly adapter_id: Id;
  readonly adapter_version: string;
  readonly certified_operations: readonly AdapterOperationId[];
  readonly certified_package_kinds: readonly ("archive" | "oci" | "native" | "bundle")[];
  readonly checks: readonly AdapterCertificationFindingV1[];
  readonly verdict: "certified" | "refused";
  readonly refusal_codes: ShortStringArray;
  readonly certifier_id: Id;
  readonly certifier_is_adapter_owner: false;
  readonly enforced_controls: readonly SandboxControlId[];
  readonly unsupported_controls: readonly SandboxControlId[];
  readonly certified_at: Instant;
  readonly core_hash: Hash;
  readonly signature?: Signature;
};

// ---- erl2:common : ERL2 shared scalar and composite definitions ----

export type Hash = `sha256:${string}`;

export type Instant = `${string}Z`;

export type Decimal = string;

export type Id = string;

export type RunId = string;

export type Base64 = string;

export type Base64Url256 = string;

export type LogicalPath = string;

export type MediaType = string;

export type Classification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "SECRET";

export type SourceState = "complete" | "healthy_empty" | "partial" | "unavailable" | "error";

export type Tier = "development" | "held_out" | "blind";

export type ClaimScope = "T1" | "T2" | "T3";

export type JourneyIntent = "acquire" | "verify_package" | "install" | "configure" | "authenticate" | "connect" | "discover" | "exercise" | "observe" | "diagnose_decide" | "recover" | "upgrade" | "rollback" | "remove";

export type EnvironmentJourneyIntent = "install" | "configure" | "authenticate" | "connect" | "discover" | "exercise" | "observe" | "diagnose_decide" | "recover" | "upgrade" | "rollback" | "remove";

export type PreEnvironmentJourneyIntent = "acquire" | "verify_package";

export type StepStatus = "succeeded" | "failed" | "unsupported";

export type RecordStatus = "completed" | "failed" | "unsupported";

export type KeyId = string;

export type Signature = {
  readonly algorithm: "Ed25519";
  readonly key_id: KeyId;
  readonly signed_hash: Hash;
  readonly signature_base64: string;
};

export type ArtifactRef = {
  readonly path: LogicalPath;
  readonly media_type: MediaType;
  readonly byte_length: number;
  readonly file_sha256: Hash;
  readonly classification: Classification;
};

export type Provenance = {
  readonly producer: string;
  readonly producer_version: string;
  readonly source_uri?: string;
  readonly source_commit?: string;
  readonly transformations: readonly string[];
};

export type BundleMember = {
  readonly artifact: ArtifactRef;
  readonly artifact_core_hash: Hash;
};

export type HashArray = readonly Hash[];

export type UniqueHashArray = readonly Hash[];

export type IdArray = readonly Id[];

export type KeyIdArray = readonly KeyId[];

export type ShortStringArray = readonly string[];

export type ArtifactRefArray = readonly ArtifactRef[];

export type EmptyArray = readonly [];

export type GateResults = readonly ({
  readonly gate_id: Id;
  readonly passed: boolean;
  readonly evidence_refs: HashArray;
})[];

export type ResourceIdentityList = readonly ({
  readonly kind: Id;
  readonly identity_hash: Hash;
})[];

// ---- erl2:environment : ERL2 environment driver, clean-control, frontier and substrate-lock contracts ----

export type DriverOperation = "provision" | "probe" | "mutate" | "restore" | "destroy" | "inspect";

export type EnvironmentDriverManifestV1 = {
  readonly schema_version: "environment-driver-manifest/v1";
  readonly driver_id: Id;
  readonly driver_kind: "fake" | "compose";
  readonly version: string;
  readonly supported_operations: readonly DriverOperation[];
  readonly resource_kinds: IdArray;
  readonly substrate_lock_hash?: Hash;
  readonly enabled: boolean;
  readonly disabled_reason_code?: string;
  readonly activation_gate?: string;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type SubstrateLockV1 = {
  readonly schema_version: "substrate-lock/v1";
  readonly lock_id: Id;
  readonly substrate_id: Id;
  readonly qualification_status: "qualified" | "unqualified_pending_erl2_oq_005";
  readonly unqualified_reason_code?: string;
  readonly source_archive: {
    readonly release_tag: string;
    readonly source_commit: string;
    readonly archive_sha256: Hash;
  };
  readonly images: readonly ({
    readonly service_id: Id;
    readonly platform: "linux/amd64" | "linux/arm64" | "darwin/arm64";
    readonly digest: Hash;
  })[];
  readonly sbom?: ArtifactRef;
  readonly provenance?: Provenance;
  readonly config_hashes: UniqueHashArray;
  readonly recorded_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type EnvironmentResourceV1 = {
  readonly resource_id: Id;
  readonly kind: Id;
  readonly run_scoped_name: string;
  readonly identity_hash: Hash;
  readonly destroyable: boolean;
  readonly shared_with_other_runs?: boolean;
};

export type EnvironmentResourceInventoryV1 = {
  readonly schema_version: "environment-resource-inventory/v1";
  readonly run_id: RunId;
  readonly environment_instance_hash: Hash;
  readonly driver_manifest_hash: Hash;
  readonly resources: readonly EnvironmentResourceV1[];
  readonly inventoried_at: Instant;
  readonly core_hash: Hash;
};

export type EnvironmentOperationReceiptV1 = {
  readonly schema_version: "environment-operation-receipt/v1";
  readonly run_id: RunId;
  readonly operation: DriverOperation;
  readonly operation_id: Id;
  readonly idempotency_key: string;
  readonly driver_manifest_hash: Hash;
  readonly target_identity_hash: Hash;
  readonly before_state_hash: Hash;
  readonly after_state_hash: Hash;
  readonly compensation_id?: Id;
  readonly status: "succeeded" | "failed";
  readonly error_code?: string;
  readonly started_at: Instant;
  readonly ended_at: Instant;
  readonly core_hash: Hash;
};

export type EnvironmentProbeResultV1 = {
  readonly probe_id: Id;
  readonly phase: "readiness" | "baseline" | "fault" | "restoration" | "teardown";
  readonly kind: Id;
  readonly target_resource_id: Id;
  readonly passed: boolean;
  readonly observation_hash: Hash;
  readonly failure_code?: string;
};

export type EnvironmentBaselineFingerprintV1 = {
  readonly schema_version: "environment-baseline-fingerprint/v1";
  readonly run_id: RunId;
  readonly environment_instance_hash: Hash;
  readonly archetype_hash: Hash;
  readonly driver_manifest_hash: Hash;
  readonly probes: readonly EnvironmentProbeResultV1[];
  readonly evidence_source_states: readonly ({
    readonly source_id: Id;
    readonly state: SourceState;
  })[];
  readonly fingerprint_hash: Hash;
  readonly contamination: {
    readonly detected: boolean;
    readonly finding_codes: ShortStringArray;
  };
  readonly observed_at: Instant;
  readonly core_hash: Hash;
};

export type EnvironmentResourceFrontierV1 = {
  readonly schema_version: "environment-resource-frontier/v1";
  readonly run_id: RunId;
  readonly environment_instance_hash: Hash;
  readonly driver_manifest_hash: Hash;
  readonly trigger: "provision_failure" | "restoration_failure" | "teardown_failure" | "invalid_environment_failure";
  readonly observed_resources: readonly EnvironmentResourceV1[];
  readonly derived_actions: readonly ({
    readonly action_id: Id;
    readonly kind: EmergencyCleanupActionKind;
    readonly target_resource_id: Id;
    readonly independently_safe: boolean;
    readonly unsafe_reason_code?: string;
  })[];
  readonly frozen_at: Instant;
  readonly core_hash: Hash;
};

export type EnvironmentReservationLeaseV1 = {
  readonly schema_version: "environment-reservation-lease/v1";
  readonly lease_id: Id;
  readonly run_id: RunId;
  readonly reservation_kind: "network" | "volume" | "port" | "tenant" | "project";
  readonly reserved_value: string;
  readonly acquired_at: Instant;
  readonly expires_at: Instant;
  readonly core_hash: Hash;
};

export type EnvironmentCleanupContractV1 = {
  readonly schema_version: "environment-cleanup-contract/v1";
  readonly contract_id: Id;
  readonly archetype_id: Id;
  readonly expected_zero_residue_kinds: IdArray;
  readonly permitted_retained_kinds: IdArray;
  readonly teardown_probe_ids: IdArray;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type ChallengeActivationReceiptV1 = {
  readonly schema_version: "challenge-activation-receipt/v1";
  readonly receipt_id: Id;
  readonly run_id: RunId;
  readonly selected_challenge_journey_binding_hash: Hash;
  readonly environment_instance_hash: Hash;
  readonly execution_plan_hash: Hash;
  readonly environment_fingerprint_hash: Hash;
  readonly connection_step_outcome_hash: Hash;
  readonly mutation_receipt_hash: Hash;
  readonly activated_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type SubstrateBindingV1 = {
  readonly schema_version: "substrate-binding/v1";
  readonly binding_id: Id;
  readonly run_id: RunId;
  readonly driver_id: Id;
  readonly driver_manifest_hash: Hash;
  readonly archetype_hash: Hash;
  readonly substrate_kind: Id;
  readonly substrate_instance_hash: Hash;
  readonly reservation_namespace_hash: Hash;
  readonly substrate_lock_hash?: Hash;
  readonly bound_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type ObservedResourceIdentity = {
  readonly resource_id: Id;
  readonly identity_hash: Hash;
};

export type CleanupResidueProbeV1 = {
  readonly schema_version: "cleanup-residue-probe/v1";
  readonly probe_id: Id;
  readonly run_id: RunId;
  readonly substrate_binding_hash: Hash;
  readonly environment_instance_hash: Hash;
  readonly resource_frontier_hash: Hash;
  readonly observed_before: readonly ObservedResourceIdentity[];
  readonly observed_after: readonly ObservedResourceIdentity[];
  readonly authorized_targets: IdArray;
  readonly undeclared_destroyed_resources: IdArray;
  readonly residual_resources: IdArray;
  readonly probe_status: "observed" | "unavailable";
  readonly outcome: "clean" | "residual" | "undeclared_destruction" | "unobservable";
  readonly probed_at: Instant;
  readonly core_hash: Hash;
};

export type ExpectedRevertedMutation = {
  readonly mutation_id: Id;
  readonly mutation_receipt_hash: Hash;
  readonly target_identity_hash: Hash;
};

export type RestorationProbeV1 = {
  readonly schema_version: "restoration-probe/v1";
  readonly probe_id: Id;
  readonly run_id: RunId;
  readonly substrate_binding_hash: Hash;
  readonly environment_instance_hash: Hash;
  readonly compensation_operation_id: Id;
  readonly compensation_receipt_hash: Hash;
  readonly expected_reverted_mutations: readonly ExpectedRevertedMutation[];
  readonly observed_before: IdArray;
  readonly observed_after: IdArray;
  readonly residual_expected_mutations: IdArray;
  readonly collateral_reverted_mutations: IdArray;
  readonly probe_status: "observed" | "unavailable";
  readonly outcome: "reverted" | "nothing_to_revert" | "residual" | "collateral" | "unobservable";
  readonly probed_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

// ---- erl2:evaluation : ERL2 data-only evaluation pack, metric definition and metric result contracts ----

export type MetricThresholdClass = "measurement" | "information" | "ordinary_gate" | "hard_safety";

export type MetricZeroDenominatorBehaviour = "not_applicable" | "zero" | "one" | "one_only_when_correct_abstention";

export type MetricMissingInputBehaviour = "not_applicable" | "inconclusive";

export type MetricInputSelector = "claims" | "cited_claims" | "causal_claims" | "unknown_claims" | "recommendation_claims" | "action_claims" | "required_truth_facts" | "evidence_sources" | "unavailable_evidence_sources" | "step_outcomes" | "assistance_events" | "intervention_events" | "credential_grants" | "documentation_steps" | "declared_mutations" | "compensation_receipts" | "recovery_step_outcomes" | "unsupported_step_outcomes";

export type MetricCanonicalOrdering = "claim_id_ascending" | "fact_id_ascending" | "source_id_ascending" | "step_index_ascending" | "artifact_hash_ascending";

export type MetricAggregation = "ratio" | "sum";

export type MetricMeasure = "unit" | "claim_weight" | "active_ms" | "elapsed_ms" | "attempt_count" | "retry_count" | "intervention_severity";

export type EvaluationPredicateId = "always_included" | "citation_resolves_in_canonical_envelope" | "citation_locator_reachable" | "claim_exactly_supported_by_truth_fact" | "causal_claim_has_declared_supporting_association" | "unknown_claim_matches_unrevealed_truth_gap" | "unavailable_source_explicitly_disclosed" | "claim_carries_no_credential_material" | "claim_authority_within_declared_ceiling" | "required_fact_supported_by_some_claim" | "step_outcome_status_is" | "declared_mutation_has_compensation";

export type MetricDefinitionV1 = {
  readonly schema_version: "metric-definition/v1";
  readonly metric_id: Id;
  readonly title: string;
  readonly inputs: readonly MetricInputSelector[];
  readonly canonical_ordering: MetricCanonicalOrdering;
  readonly aggregation: MetricAggregation;
  readonly measure: MetricMeasure;
  readonly numerator_predicate: EvaluationPredicateId;
  readonly numerator_predicate_argument?: string;
  readonly numerator_polarity: "satisfied" | "violated";
  readonly denominator_selector: MetricInputSelector;
  readonly zero_denominator: MetricZeroDenominatorBehaviour;
  readonly missing_input_behaviour: MetricMissingInputBehaviour;
  readonly threshold_class: MetricThresholdClass;
  readonly threshold?: {
    readonly comparator: "at_least" | "at_most" | "equals";
    readonly bound: Decimal;
  };
  readonly claim_ceiling: ClaimScope;
  readonly reason_codes: readonly string[];
  readonly inclusions: ShortStringArray;
  readonly exclusions: ShortStringArray;
  readonly core_hash: Hash;
};

export type EvaluationPackAssertionV1 = {
  readonly assertion_id: Id;
  readonly predicate: EvaluationPredicateId;
  readonly predicate_argument?: string;
  readonly polarity: "must_hold" | "must_not_hold";
  readonly severity: Severity;
  readonly finding_category: "subject_functional_miss" | "subject_misdiagnosis" | "subject_output_contract_failure" | "subject_unsupported";
  readonly reason_code: string;
};

export type EvaluationPackBodyV1 = {
  readonly schema_version: "evaluation-pack-body/v1";
  readonly pack_id: Id;
  readonly version: string;
  readonly scope: "domain" | "subject_deep";
  readonly domain: Id;
  readonly subject_id?: Id;
  readonly input_contract_ids: readonly string[];
  readonly metric_ids: IdArray;
  readonly assertions: readonly EvaluationPackAssertionV1[];
  readonly applicable_challenge_families: IdArray;
  readonly applicable_archetype_families: IdArray;
  readonly output_ordering: "metric_id_ascending" | "assertion_id_ascending";
  readonly claim_ceiling: ClaimScope;
  readonly core_hash: Hash;
};

export type EvaluationPackCertificationFindingV1 = {
  readonly check_id: Id;
  readonly passed: boolean;
  readonly reason_code: string;
  readonly detail?: string;
};

export type EvaluationPackCertificationReceiptV1 = {
  readonly schema_version: "evaluation-pack-certification-receipt/v1";
  readonly pack_id: Id;
  readonly pack_artifact_hash: Hash;
  readonly certifier_id: Id;
  readonly checks: readonly EvaluationPackCertificationFindingV1[];
  readonly forbidden_token_list_hash: Hash;
  readonly passed: boolean;
  readonly certified_at: Instant;
  readonly core_hash: Hash;
};

export type EvaluationPackManifestV1 = {
  readonly schema_version: "evaluation-pack-manifest/v1";
  readonly pack_id: Id;
  readonly version: string;
  readonly scope: "domain" | "subject_deep";
  readonly domain: Id;
  readonly subject_id?: Id;
  readonly pack_artifact_hash: Hash;
  readonly vocabulary_hash: Hash;
  readonly truth_schema_hash: Hash;
  readonly assertion_ids: IdArray;
  readonly metric_definitions: HashArray;
  readonly prohibited_core_apis: ShortStringArray;
  readonly reviewer_ids: IdArray;
  readonly bias_review_hash: Hash;
  readonly certification_receipt_hash: Hash;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type MetricResultV1 = {
  readonly schema_version: "metric-result/v1";
  readonly run_id: RunId;
  readonly metric_definition_hash: Hash;
  readonly metric_id: Id;
  readonly plane: "journey" | "domain";
  readonly status: "measured" | "not_applicable" | "inconclusive";
  readonly value?: Decimal;
  readonly numerator: number;
  readonly denominator: number;
  readonly threshold_satisfied?: boolean;
  readonly ordered_input_hashes: HashArray;
  readonly result_identity_hash: Hash;
  readonly reason_codes: readonly string[];
  readonly missing_input_selectors?: readonly MetricInputSelector[];
  readonly threshold_class: MetricThresholdClass;
  readonly claim_ceiling: ClaimScope;
  readonly evaluated_at: Instant;
  readonly core_hash: Hash;
};

// ---- erl2:evidence : ERL2 cutoff, capture, observation and canonical-evidence contracts ----

export type MonotonicClockDomainV1 = {
  readonly schema_version: "monotonic-clock-domain/v1";
  readonly domain_id: Id;
  readonly run_id: RunId;
  readonly environment_fingerprint_hash: Hash;
  readonly host_identity_hash: Hash;
  readonly boot_id_hash: Hash;
  readonly clock_id: "CLOCK_MONOTONIC" | "mach_continuous_time";
  readonly clock_epoch_token_hash: Hash;
  readonly observed_at: Instant;
  readonly core_hash: Hash;
};

export type CutoffPolicyV1 = {
  readonly schema_version: "cutoff-policy/v1";
  readonly policy_id: Id;
  readonly version: number;
  readonly clock: "host_utc";
  readonly instant_rule: "traffic_process_started_at_plus_warmup_ms_plus_observation_ms";
  readonly inclusion: "event_time_lt_and_ingestion_time_lte";
  readonly max_skew_ms: number;
  readonly late_arrival_grace_ms: number;
  readonly maximum_selection_to_traffic_start_ms: number;
  readonly maximum_timestamp_submission_delay_ms: number;
  readonly maximum_process_milestone_skew_ms: number;
  readonly maximum_monotonic_wall_divergence_ms: number;
  readonly maximum_warmup_ms: number;
  readonly maximum_observation_ms: number;
  readonly minimum_observation_ms: number;
  readonly event_time_required: true;
  readonly ingestion_time_required: true;
  readonly valid_from: Instant;
  readonly valid_until: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type TrafficProcessStartReceiptV1 = {
  readonly schema_version: "traffic-process-start-receipt/v1";
  readonly receipt_id: Id;
  readonly run_id: RunId;
  readonly selection_commitment_hash: Hash;
  readonly experiment_manifest_hash: Hash;
  readonly environment_fingerprint_hash: Hash;
  readonly traffic_profile_hash: Hash;
  readonly process_identity_hash: Hash;
  readonly supervisor_boot_id_hash: Hash;
  readonly monotonic_clock_domain_hash: Hash;
  readonly process_started_at: Instant;
  readonly process_start_monotonic_ms: number;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type RuntimeMilestoneV1 = {
  readonly schema_version: "runtime-milestone/v1";
  readonly milestone_id: Id;
  readonly run_id: RunId;
  readonly milestone: "traffic_started";
  readonly selection_commitment_hash: Hash;
  readonly experiment_manifest_hash: Hash;
  readonly environment_fingerprint_hash: Hash;
  readonly traffic_profile_hash: Hash;
  readonly traffic_process_start_receipt_hash: Hash;
  readonly monotonic_clock_domain_hash: Hash;
  readonly occurred_at: Instant;
  readonly monotonic_elapsed_ms: number;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type EvidenceWindowCommitmentV1 = {
  readonly schema_version: "evidence-window-commitment/v1";
  readonly commitment_id: Id;
  readonly run_id: RunId;
  readonly cutoff_policy_hash: Hash;
  readonly process_start_receipt_hash: Hash;
  readonly monotonic_clock_domain_hash: Hash;
  readonly comparison_policy_hash: Hash;
  readonly environment_instance_hash: Hash;
  readonly warmup_ms: number;
  readonly observation_ms: number;
  readonly instant_rule: "traffic_process_started_at_plus_warmup_ms_plus_observation_ms";
  readonly milestone_relationship: "runtime_milestone_at_process_start_plus_warmup_ms";
  readonly committed_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type SourceSnapshotV1 = {
  readonly schema_version: "source-snapshot/v1";
  readonly run_id: RunId;
  readonly snapshot_id: Id;
  readonly source_id: Id;
  readonly source_kind: Id;
  readonly source_schema: string;
  readonly source_identity_hash: Hash;
  readonly state: SourceState;
  readonly query_hash: Hash;
  readonly window: {
    readonly from: Instant;
    readonly to_exclusive: Instant;
  };
  readonly started_at: Instant;
  readonly ended_at: Instant;
  readonly pages: number;
  readonly records: number;
  readonly bytes: number;
  readonly cursor_start_hash?: Hash;
  readonly cursor_end_hash?: Hash;
  readonly dedupe_key: string;
  readonly ordering_id: Id;
  readonly sampling: {
    readonly kind: Id;
    readonly rate?: Decimal;
    readonly seed_commitment?: Hash;
  };
  readonly truncation: {
    readonly truncated: boolean;
    readonly reason?: string;
  };
  readonly health_record_hash: Hash;
  readonly unavailable_reason_code?: string;
  readonly records_artifact?: ArtifactRef;
  readonly provenance: Provenance;
  readonly core_hash: Hash;
};

export type CanonicalEvidenceEntry = {
  readonly entry_id: Id;
  readonly source_content_hash: Hash;
  readonly artifact: ArtifactRef;
  readonly source_state: SourceState;
};

export type UnsupportedDescriptor = {
  readonly entry_id: Id;
  readonly evidence_kind: Id;
  readonly reason_code: string;
};

export type ReplayCanonicalEvidenceEnvelopeV1 = {
  readonly schema_version: "replay-canonical-evidence-envelope/v1";
  readonly comparison_id: Id;
  readonly mode: "replay_comparison";
  readonly generic_run_policy_hash: Hash;
  readonly challenge_hash: Hash;
  readonly evidence_policy_hash: Hash;
  readonly cutoff_evidence_set_hash: Hash;
  readonly entries: readonly CanonicalEvidenceEntry[];
  readonly unsupported_descriptors: readonly UnsupportedDescriptor[];
  readonly tree_hash: Hash;
  readonly frozen_at: Instant;
  readonly core_hash: Hash;
};

export type LiveCanonicalEvidenceEnvelopeV1 = {
  readonly schema_version: "live-canonical-evidence-envelope/v1";
  readonly run_id: RunId;
  readonly comparison_id: Id;
  readonly mode: "live_ecosystem";
  readonly generic_run_policy_hash: Hash;
  readonly challenge_hash: Hash;
  readonly evidence_policy_hash: Hash;
  readonly equivalence_profile_hash: Hash;
  readonly semantic_projection_hash: Hash;
  readonly entries: readonly CanonicalEvidenceEntry[];
  readonly unsupported_descriptors: readonly UnsupportedDescriptor[];
  readonly tree_hash: Hash;
  readonly frozen_at: Instant;
  readonly core_hash: Hash;
};

export type CanonicalSubjectEvidenceEnvelopeV1 = ReplayCanonicalEvidenceEnvelopeV1
  | LiveCanonicalEvidenceEnvelopeV1;

export type EvidenceEquivalenceProfileV1 = {
  readonly schema_version: "evidence-equivalence-profile/v1";
  readonly profile_id: Id;
  readonly challenge_family_hash: Hash;
  readonly semantic_fact_schema_hash: Hash;
  readonly normalization_rule_hashes: HashArray;
  readonly ignored_volatile_field_paths: ShortStringArray;
  readonly required_invariant_ids: IdArray;
  readonly forbidden_omission_classes: IdArray;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type SemanticEvidenceEquivalenceReceiptV1 = {
  readonly schema_version: "semantic-evidence-equivalence-receipt/v1";
  readonly comparison_id: Id;
  readonly equivalence_profile_hash: Hash;
  readonly independent_verifier_hash: Hash;
  readonly live_envelope_hashes: readonly Hash[];
  readonly semantic_projection_hashes: HashArray;
  readonly invariant_results: readonly ({
    readonly invariant_id: Id;
    readonly status: "passed" | "failed" | "inconclusive";
    readonly proof_refs: HashArray;
  })[];
  readonly status: "equivalent" | "not_equivalent" | "inconclusive";
  readonly verified_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type ObservationBundleV2 = {
  readonly schema_version: "observation-bundle/v2";
  readonly run_id: RunId;
  readonly plan_hash: Hash;
  readonly environment_instance_hash: Hash;
  readonly cutoff: {
    readonly instant: Instant;
    readonly policy_hash: Hash;
    readonly process_start_receipt_hash: Hash;
    readonly runtime_milestone_hash: Hash;
  };
  readonly source_snapshots: readonly ({
    readonly snapshot_id: Id;
    readonly snapshot_hash: Hash;
    readonly state: SourceState;
  })[];
  readonly subject_visible_projection_policy_hash: Hash;
  readonly comparison_policy_hash: Hash;
  readonly canonical_evidence_envelope_hash: Hash;
  readonly redaction_policy_hash: Hash;
  readonly leak_scan: {
    readonly version: string;
    readonly findings: number;
    readonly canaries_found: 0;
  };
  readonly entries: ArtifactRefArray;
  readonly tree_hash: Hash;
  readonly frozen_at: Instant;
  readonly core_hash: Hash;
};

export type AdapterTranslationReceiptV1 = {
  readonly schema_version: "adapter-translation-receipt/v1";
  readonly run_id: RunId;
  readonly adapter_hash: Hash;
  readonly canonical_envelope_hash: Hash;
  readonly translated_tree_hash: Hash;
  readonly mappings: readonly ({
    readonly entry_id: Id;
    readonly disposition: "mapped_exact" | "mapped_lossy" | "unsupported";
    readonly target_refs: ArtifactRefArray;
    readonly loss_reason_code?: string;
  })[];
  readonly total_input_entries: number;
  readonly accounted_entries: number;
  readonly complete: true;
  readonly translated_at: Instant;
  readonly core_hash: Hash;
};

export type GenericClaimSetV1 = {
  readonly schema_version: "generic-claim-set/v1";
  readonly run_id: RunId;
  readonly adapter_hash: Hash;
  readonly subject_output_hash: Hash;
  readonly domain_vocabulary_hash: Hash;
  readonly claims: readonly ({
    readonly claim_id: Id;
    readonly category: "fact" | "association" | "causal" | "unknown" | "hypothesis" | "recommendation" | "action" | "decision";
    readonly subject: {
      readonly kind: Id;
      readonly id: string;
    };
    readonly predicate_id: Id;
    readonly object: {
      readonly type: Id;
      readonly value: string;
    };
    readonly temporal_scope: {
      readonly from?: Instant;
      readonly to_exclusive?: Instant;
    };
    readonly polarity: "asserted" | "negated" | "unknown";
    readonly confidence: Decimal;
    readonly authority: "none" | "advisory" | "human_approval_required" | "external_authority_required";
    readonly citations: readonly ({
      readonly artifact_file_sha256: Hash;
      readonly locator: string;
    })[];
    readonly source_output_path: LogicalPath;
  })[];
  readonly contradictions: readonly ({
    readonly claim_id_a: Id;
    readonly claim_id_b: Id;
  })[];
  readonly unprojected: readonly ({
    readonly path: LogicalPath;
    readonly reason_code: string;
  })[];
  readonly complete: boolean;
  readonly core_hash: Hash;
};

// ---- erl2:isolation : ERL2 subject-isolation substrate lock, enforcement probe evidence and qualification report ----

export type IsolationControlId = "read-only-root-filesystem" | "numeric-non-root-user" | "capability-drop-all" | "no-new-privileges" | "seccomp-default-profile" | "cpu-limit" | "memory-limit" | "pid-limit" | "wall-clock-deadline" | "process-tree-termination" | "network-namespace-isolation" | "deny-by-default-egress" | "read-only-input-mounts" | "writable-output-only" | "no-docker-socket" | "no-ambient-home-directory" | "no-vault-truth-judge-or-selection-access" | "bounded-diagnostics" | "run-scoped-resource-identity" | "teardown-and-residue-inspection";

export type ProbeEvidenceKind = "observed" | "declared" | "mocked" | "absent";

export type IsolationProfileId = "local-process" | "container" | "disposable_vm";

export type IsolationSubstrateLockV1 = {
  readonly schema_version: "isolation-substrate-lock/v1";
  readonly lock_id: Id;
  readonly profile: IsolationProfileId;
  readonly runtime_id: string;
  readonly runtime_version: string;
  readonly platform: string;
  readonly architecture: string;
  readonly kernel_version: string;
  readonly image_reference: string;
  readonly image_digest: Hash;
  readonly runtime_configuration_hashes: UniqueHashArray;
  readonly required_security_profile: {
    readonly seccomp: string;
    readonly cgroup_version: "1" | "2";
    readonly default_runtime: string;
    readonly apparmor?: string;
    readonly selinux?: string;
  };
  readonly probe_suite_id: Id;
  readonly probe_suite_digest: Hash;
  readonly policy_input_hashes: UniqueHashArray;
  readonly pinned: true;
  readonly recorded_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type IsolationEnforcementProbeResultV1 = {
  readonly schema_version: "isolation-enforcement-probe-result/v1";
  readonly probe_id: Id;
  readonly control_id: IsolationControlId;
  readonly substrate_lock_hash: Hash;
  readonly evidence: ProbeEvidenceKind;
  readonly enforced: boolean;
  readonly method: string;
  readonly observation: {
    readonly attempted: string;
    readonly observed: string;
    readonly expectation: string;
    readonly exit_code?: number;
  };
  readonly reason_code?: string;
  readonly resources_cleaned_up?: boolean;
  readonly started_at: Instant;
  readonly ended_at: Instant;
  readonly core_hash: Hash;
};

export type IsolationQualificationReportV1 = {
  readonly schema_version: "isolation-qualification-report/v1";
  readonly report_id: Id;
  readonly algorithm: "erl2-isolation-qualification/v1";
  readonly profile: IsolationProfileId;
  readonly substrate_lock_hash?: Hash;
  readonly required_controls: readonly IsolationControlId[];
  readonly observed_controls: readonly IsolationControlId[];
  readonly probe_result_hashes: HashArray;
  readonly verdict: "qualified" | "not_qualified";
  readonly not_qualified_state?: "disabled_no_qualified_adapter_substrate";
  readonly reasons: readonly string[];
  readonly missing_controls: readonly IsolationControlId[];
  readonly evaluated_at: Instant;
  readonly qualifier_release: string;
  readonly core_hash: Hash;
};

export type IsolationProbeSigningManifestV1 = {
  readonly schema_version: "isolation-probe-signing-manifest/v1";
  readonly manifest_id: Id;
  readonly substrate_lock_hash: Hash;
  readonly probe_suite_id: Id;
  readonly probe_suite_digest: Hash;
  readonly probe_result_hashes: readonly Hash[];
  readonly signed_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

// ---- erl2:journey : ERL2 journey, challenge and environment contracts ----

export type SubjectVisibleJourneyStepV1 = {
  readonly schema_version: "subject-visible-journey-step/v1";
  readonly step_id: Id;
  readonly intent: JourneyIntent;
  readonly actor_role: Id;
  readonly interaction_kinds: readonly ("cli" | "api" | "ui" | "file" | "documentation")[];
  readonly visible_prerequisite_ids: IdArray;
  readonly visible_input_refs: HashArray;
  readonly timeout_ms: number;
  readonly retry_policy: {
    readonly max_attempts: number;
    readonly backoff_id: Id;
  };
  readonly compensation_intent?: Id;
  readonly core_hash: Hash;
};

export type JudgeJourneyExpectationV1 = {
  readonly schema_version: "judge-journey-expectation/v1";
  readonly step_id: Id;
  readonly visible_step_hash: Hash;
  readonly expected_observations: readonly ({
    readonly observation_id: Id;
    readonly predicate_id: Id;
    readonly required: boolean;
    readonly proof_source_ids: IdArray;
  })[];
  readonly permitted_failure_categories: ShortStringArray;
  readonly attribution_requirements: HashArray;
  readonly earliest_reveal: "after_subject_output_freeze";
  readonly truth_scope: "journey_only" | "functional";
  readonly oracle_canary_id: string;
  readonly core_hash: Hash;
};

export type JourneyStepCommitmentV1 = {
  readonly schema_version: "journey-step-commitment/v1";
  readonly step_id: Id;
  readonly visible_step_hash: Hash;
  readonly judge_expectation_core_hash: Hash;
  readonly judge_expectation_plaintext_file_sha256: Hash;
  readonly judge_expectation_ciphertext: ArtifactRef;
  readonly encryption: "age-x25519";
  readonly recipient_key_ids: KeyIdArray;
  readonly committed_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type JourneyDefinitionV1 = {
  readonly schema_version: "journey-definition/v1";
  readonly journey_id: Id;
  readonly version: number;
  readonly domain: "software_delivery_operations";
  readonly persona_script_hash: Hash;
  readonly ordered_step_commitment_hashes: readonly Hash[];
  readonly prerequisite_policy_hash: Hash;
  readonly assistance_policy_hash: Hash;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type ChallengeManifestV1 = {
  readonly schema_version: "challenge-manifest/v1";
  readonly challenge_id: Id;
  readonly version: number;
  readonly domain: "software_delivery_operations";
  readonly archetype_hashes: readonly Hash[];
  readonly journey_hash: Hash;
  readonly journey_step_commitment_hashes: readonly Hash[];
  readonly truth_commitment_hash: Hash;
  readonly traffic_profile_hash?: Hash;
  readonly evidence_policy_hash: Hash;
  readonly cutoff_policy_hash: Hash;
  readonly required_domain_capabilities: IdArray;
  readonly tier: Tier;
  readonly exposure_epoch: number;
  readonly admission_proof_hash: Hash;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type EnvironmentArchetypeV1 = {
  readonly schema_version: "environment-archetype/v1";
  readonly archetype_id: Id;
  readonly version: number;
  readonly domain: "software_delivery_operations";
  readonly topology: readonly ({
    readonly node_id: Id;
    readonly kind: Id;
    readonly version_constraint: string;
  })[];
  readonly evidence_sources: readonly ({
    readonly source_id: Id;
    readonly kind: Id;
    readonly required: boolean;
  })[];
  readonly organization_metadata_schema: string;
  readonly access_constraints: readonly ({
    readonly constraint_id: Id;
    readonly kind: Id;
    readonly scope: string;
  })[];
  readonly normal_disorder: readonly ({
    readonly disorder_id: Id;
    readonly kind: Id;
    readonly parameters_hash: Hash;
  })[];
  readonly resource_budget: {
    readonly cpu_millis: number;
    readonly memory_mib: number;
    readonly disk_mib: number;
    readonly runtime_ms: number;
  };
  readonly cleanup_contract_hash: Hash;
  readonly compatibility_tags: IdArray;
  readonly admission_proof_hash: Hash;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type EnvironmentInstanceV1 = {
  readonly schema_version: "environment-instance/v1";
  readonly run_id: RunId;
  readonly archetype_hash: Hash;
  readonly driver_manifest_hash: Hash;
  readonly resolved_nodes: readonly ({
    readonly node_id: Id;
    readonly artifact_digest: Hash;
    readonly instance_identity_hash: Hash;
  })[];
  readonly source_bindings: readonly ({
    readonly source_id: Id;
    readonly endpoint_hash: Hash;
    readonly tenant_hash: Hash;
  })[];
  readonly credential_scope_hashes: HashArray;
  readonly disorder_seed_commitment: Hash;
  readonly resource_inventory: ArtifactRefArray;
  readonly baseline_hash?: Hash;
  readonly created_at: Instant;
  readonly core_hash: Hash;
};

export type SubjectExecutionPlanV1 = {
  readonly schema_version: "subject-execution-plan/v1";
  readonly run_id: RunId;
  readonly selection_commitment_hash: Hash;
  readonly selection_verification_receipt_hash: Hash;
  readonly selected_challenge_journey_binding_hash: Hash;
  readonly environment_instance_hash: Hash;
  readonly challenge_hash: Hash;
  readonly journey_hash: Hash;
  readonly acquisition_source_manifest_hash: Hash;
  readonly subject_package_manifest_hash: Hash;
  readonly adapter_manifest_hash: Hash;
  readonly configuration_hash: Hash;
  readonly generic_run_policy_hash: Hash;
  readonly actor_script_hash: Hash;
  readonly limits: {
    readonly runtime_ms: number;
    readonly output_bytes: number;
    readonly diagnostic_bytes: number;
  };
  readonly core_hash: Hash;
};

export type JourneyStepOutcomeV1 = {
  readonly schema_version: "journey-step-outcome/v1";
  readonly run_id: RunId;
  readonly step_id: Id;
  readonly step_commitment_hash: Hash;
  readonly visible_step_hash: Hash;
  readonly adapter_request_hash: Hash;
  readonly intent: JourneyIntent;
  readonly status: StepStatus;
  readonly attempt_record_hashes: HashArray;
  readonly detail_record_hashes: HashArray;
  readonly visible_input_hashes: HashArray;
  readonly output_refs: ArtifactRefArray;
  readonly mutation_receipt_hashes: HashArray;
  readonly compensation_receipt_hashes: HashArray;
  readonly diagnostic_refs: ArtifactRefArray;
  readonly started_at: Instant;
  readonly ended_at: Instant;
  readonly active_operator_ms: number;
  readonly next_permitted_intents: readonly JourneyIntent[];
  readonly core_hash: Hash;
};

export type PreEnvironmentSubjectOutputManifestV1 = {
  readonly schema_version: "subject-output-manifest/v1";
  readonly run_id: RunId;
  readonly terminal_stage: PreEnvironmentJourneyIntent;
  readonly acquisition_source_manifest_hash: Hash;
  readonly acquisition_record_hash: Hash;
  readonly adapter_hash: Hash;
  readonly step_outcome_hashes: readonly Hash[];
  readonly interaction_hashes: HashArray;
  readonly entries: ArtifactRefArray;
  readonly tree_hash: Hash;
  readonly stdout?: ArtifactRef;
  readonly stderr?: ArtifactRef;
  readonly exit_status?: number;
  readonly timed_out: boolean;
  readonly unsupported_inputs: ShortStringArray;
  readonly frozen_at: Instant;
  readonly core_hash: Hash;
};

export type EnvironmentSubjectOutputManifestV1 = {
  readonly schema_version: "subject-output-manifest/v1";
  readonly run_id: RunId;
  readonly terminal_stage: EnvironmentJourneyIntent;
  readonly acquisition_source_manifest_hash: Hash;
  readonly acquisition_record_hash: Hash;
  readonly subject_package_manifest_hash: Hash;
  readonly adapter_hash: Hash;
  readonly plan_hash: Hash;
  readonly canonical_evidence_envelope_hash?: Hash;
  readonly adapter_translation_receipt_hash?: Hash;
  readonly step_outcome_hashes: readonly Hash[];
  readonly interaction_hashes: HashArray;
  readonly entries: ArtifactRefArray;
  readonly tree_hash: Hash;
  readonly stdout?: ArtifactRef;
  readonly stderr?: ArtifactRef;
  readonly exit_status?: number;
  readonly timed_out: boolean;
  readonly unsupported_inputs: ShortStringArray;
  readonly projection_input_hash?: Hash;
  readonly frozen_at: Instant;
  readonly core_hash: Hash;
};

export type SubjectOutputManifestV1 = PreEnvironmentSubjectOutputManifestV1
  | EnvironmentSubjectOutputManifestV1;

export type JudgeExpectationRevealRecordV1 = {
  readonly schema_version: "judge-expectation-reveal-record/v1";
  readonly run_id: RunId;
  readonly subject_output_hash: Hash;
  readonly revealed_step_ids: IdArray;
  readonly revealed_expectation_hashes: HashArray;
  readonly revealed_at: Instant;
  readonly core_hash: Hash;
};

// ---- erl2:results : ERL2 finding, cleanup, validity, result and index contracts ----

export type SubjectFindingCategory = "subject_acquisition_failure" | "subject_package_verification_failure" | "subject_installation_failure" | "subject_configuration_failure" | "subject_authentication_failure" | "subject_connection_failure" | "subject_discovery_failure" | "subject_interaction_failure" | "subject_integration_failure" | "subject_compatibility_failure" | "subject_runtime_failure" | "subject_output_contract_failure" | "subject_functional_miss" | "subject_misdiagnosis" | "subject_recovery_failure" | "subject_upgrade_failure" | "subject_rollback_failure" | "subject_uninstall_failure" | "subject_uninstall_residue" | "subject_documentation_friction" | "subject_unsupported";

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export type ScoreablePlanes = readonly ("journey" | "domain" | "deep")[];

export type SubjectFindingV1 = {
  readonly schema_version: "finding/v1";
  readonly kind: "subject_finding";
  readonly finding_id: Id;
  readonly run_id: RunId;
  readonly journey_step_id?: Id;
  readonly severity: Severity;
  readonly proof_refs: HashArray;
  readonly safe_summary: string;
  readonly owner: "subject";
  readonly category: SubjectFindingCategory;
  readonly subject_attribution_proven: true;
  readonly attribution_proof_hash: Hash;
  readonly counterfactual_control_refs: HashArray;
  readonly scoreable_planes: ScoreablePlanes;
  readonly core_hash: Hash;
};

export type DependencyFindingV1 = {
  readonly schema_version: "finding/v1";
  readonly kind: "dependency_failure";
  readonly finding_id: Id;
  readonly run_id: RunId;
  readonly journey_step_id?: Id;
  readonly severity: Severity;
  readonly proof_refs: HashArray;
  readonly safe_summary: string;
  readonly owner: "external_dependency";
  readonly category: "external_dependency_failure";
  readonly dependency_id: Id;
  readonly dependency_health_hash: Hash;
  readonly subject_attribution_proven: false;
  readonly scoreable_planes: EmptyArray;
  readonly core_hash: Hash;
};

export type AdapterFailureV1 = {
  readonly schema_version: "finding/v1";
  readonly kind: "adapter_failure";
  readonly finding_id: Id;
  readonly run_id: RunId;
  readonly journey_step_id?: Id;
  readonly severity: Severity;
  readonly proof_refs: HashArray;
  readonly safe_summary: string;
  readonly owner: "adapter";
  readonly category: "adapter_protocol_failure" | "adapter_projection_failure" | "adapter_mutation_violation";
  readonly adapter_hash: Hash;
  readonly certification_receipt_hash: Hash;
  readonly subject_attribution_proven: false;
  readonly scoreable_planes: EmptyArray;
  readonly core_hash: Hash;
};

export type EvaluatorFailureV1 = {
  readonly schema_version: "finding/v1";
  readonly kind: "evaluator_failure";
  readonly finding_id: Id;
  readonly run_id: RunId;
  readonly journey_step_id?: Id;
  readonly severity: Severity;
  readonly proof_refs: HashArray;
  readonly safe_summary: string;
  readonly owner: "evaluator";
  readonly category: "evaluator_execution_failure" | "evaluation_pack_failure" | "evaluator_nondeterminism";
  readonly evaluator_or_pack_hash: Hash;
  readonly subject_attribution_proven: false;
  readonly scoreable_planes: EmptyArray;
  readonly core_hash: Hash;
};

export type LabInvalidityV1 = {
  readonly schema_version: "finding/v1";
  readonly kind: "lab_invalidity";
  readonly finding_id: Id;
  readonly run_id: RunId;
  readonly journey_step_id?: Id;
  readonly severity: Severity;
  readonly proof_refs: HashArray;
  readonly safe_summary: string;
  readonly owner: "lab";
  readonly category: "lab_invalid" | "lab_provisioning_failure" | "lab_baseline_failure" | "lab_evidence_failure" | "lab_reveal_failure" | "lab_restoration_failure" | "lab_teardown_failure" | "lab_integrity_failure";
  readonly failed_gate_ids: IdArray;
  readonly subject_attribution_proven: false;
  readonly scoreable_planes: EmptyArray;
  readonly core_hash: Hash;
};

export type InconclusiveFindingV1 = {
  readonly schema_version: "finding/v1";
  readonly kind: "inconclusive";
  readonly finding_id: Id;
  readonly run_id: RunId;
  readonly journey_step_id?: Id;
  readonly severity: Severity;
  readonly proof_refs: HashArray;
  readonly safe_summary: string;
  readonly owner: "inconclusive";
  readonly category: "inconclusive";
  readonly missing_proof_ids: IdArray;
  readonly subject_attribution_proven: false;
  readonly scoreable_planes: ScoreablePlanes;
  readonly core_hash: Hash;
};

export type FindingV1 = SubjectFindingV1
  | DependencyFindingV1
  | AdapterFailureV1
  | EvaluatorFailureV1
  | LabInvalidityV1
  | InconclusiveFindingV1;

export type PreEnvironmentCleanupVerificationV1 = {
  readonly schema_version: "pre-environment-cleanup-verification/v1";
  readonly run_id: RunId;
  readonly terminal_stage: PreEnvironmentJourneyIntent;
  readonly acquisition_preregistration_hash: Hash;
  readonly acquisition_record_hash: Hash;
  readonly subject_output_hash: Hash;
  readonly acquired_artifact_disposition: "never_created" | "deleted" | "retained_quarantined";
  readonly cleanup_receipt_hashes: HashArray;
  readonly residual_acquisition_resources: ResourceIdentityList;
  readonly verified_at: Instant;
  readonly passed: boolean;
  readonly core_hash: Hash;
};

export type EnvironmentRestorationVerificationV1 = {
  readonly schema_version: "environment-restoration-verification/v1";
  readonly run_id: RunId;
  readonly environment_instance_hash: Hash;
  readonly activation_receipt_hashes: HashArray;
  readonly compensation_receipt_hashes: HashArray;
  readonly subject_stop_hash?: Hash;
  readonly subject_uninstall_hash?: Hash;
  readonly baseline_before_hash: Hash;
  readonly baseline_after_hash: Hash;
  readonly residual_resources: ResourceIdentityList;
  readonly restored_at: Instant;
  readonly passed: boolean;
  readonly core_hash: Hash;
};

export type TeardownVerificationV1 = {
  readonly schema_version: "teardown-verification/v1";
  readonly run_id: RunId;
  readonly environment_instance_hash: Hash;
  readonly checked_at: Instant;
  readonly checks: readonly ({
    readonly kind: "container" | "network" | "volume" | "secret_file" | "port" | "working_state";
    readonly selector: string;
    readonly residue_count: number;
    readonly residue_hashes: HashArray;
  })[];
  readonly restoration_verification_hash: Hash;
  readonly passed: boolean;
  readonly core_hash: Hash;
};

export type EmergencyCleanupActionKind = "stop_subject" | "isolate_network" | "revoke_credentials" | "compensate_mutation" | "destroy_partial_resource" | "teardown_remaining" | "contain_residual";

export type SucceededEmergencyCleanupActionV1 = {
  readonly action_id: Id;
  readonly kind: EmergencyCleanupActionKind;
  readonly independently_safe: true;
  readonly status: "succeeded";
  readonly attempt_receipt_hash: Hash;
};

export type FailedEmergencyCleanupActionV1 = {
  readonly action_id: Id;
  readonly kind: EmergencyCleanupActionKind;
  readonly independently_safe: true;
  readonly status: "failed";
  readonly attempt_receipt_hash: Hash;
  readonly reason_code: string;
};

export type SkippedUnsafeEmergencyCleanupActionV1 = {
  readonly action_id: Id;
  readonly kind: EmergencyCleanupActionKind;
  readonly independently_safe: false;
  readonly status: "skipped_unsafe";
  readonly reason_code: string;
};

export type EmergencyCleanupActionV1 = SucceededEmergencyCleanupActionV1
  | FailedEmergencyCleanupActionV1
  | SkippedUnsafeEmergencyCleanupActionV1;

export type EmergencyCleanupVerificationV1 = {
  readonly schema_version: "emergency-cleanup-verification/v1";
  readonly run_id: RunId;
  readonly environment_instance_hash: Hash;
  readonly trigger: "restoration_failure" | "teardown_failure" | "invalid_environment_failure";
  readonly resource_frontier_event_hash: Hash;
  readonly actions: readonly EmergencyCleanupActionV1[];
  readonly all_independently_safe_actions_attempted: true;
  readonly remaining_resources: readonly ({
    readonly kind: Id;
    readonly identity_hash: Hash;
    readonly containment_status: "contained" | "uncontained" | "unknown";
  })[];
  readonly completed_at: Instant;
  readonly core_hash: Hash;
};

export type CleanupVerificationV1 = PreEnvironmentCleanupVerificationV1
  | EnvironmentRestorationVerificationV1
  | EmergencyCleanupVerificationV1;

export type PreEnvironmentValidityResultV1 = {
  readonly schema_version: "pre-environment-validity-result/v1";
  readonly run_id: RunId;
  readonly terminal_stage: PreEnvironmentJourneyIntent;
  readonly generic_run_policy_hash: Hash;
  readonly gate_results: GateResults;
  readonly pre_environment_cleanup_hash: Hash;
  readonly status: "valid" | "invalid";
  readonly invalidity_finding_hashes: HashArray;
  readonly evaluated_at: Instant;
  readonly core_hash: Hash;
};

export type EnvironmentValidityResultV1 = {
  readonly schema_version: "environment-validity-result/v1";
  readonly run_id: RunId;
  readonly terminal_stage: EnvironmentJourneyIntent;
  readonly generic_run_policy_hash: Hash;
  readonly gate_results: GateResults;
  readonly environment_restoration_hash: Hash;
  readonly teardown_hash: Hash;
  readonly status: "valid" | "invalid";
  readonly invalidity_finding_hashes: HashArray;
  readonly evaluated_at: Instant;
  readonly core_hash: Hash;
};

export type ValidityResultV1 = PreEnvironmentValidityResultV1
  | EnvironmentValidityResultV1;

export type PreSelectionJourneyResultV1 = {
  readonly schema_version: "pre-selection-journey-result/v1";
  readonly run_id: RunId;
  readonly terminal_stage: PreEnvironmentJourneyIntent;
  readonly acquisition_preregistration_hash: Hash;
  readonly generic_run_policy_hash: Hash;
  readonly step_outcome_hashes: HashArray;
  readonly revealed_judge_expectation_hashes: HashArray;
  readonly metric_result_hashes: HashArray;
  readonly finding_hashes: HashArray;
  readonly status: "evaluated" | "inconclusive";
  readonly recorded_at: Instant;
  readonly core_hash: Hash;
};

export type SelectedJourneyResultV1 = {
  readonly schema_version: "selected-journey-result/v1";
  readonly run_id: RunId;
  readonly generic_run_policy_hash: Hash;
  readonly journey_hash: Hash;
  readonly step_outcome_hashes: HashArray;
  readonly revealed_judge_expectation_hashes: HashArray;
  readonly metric_result_hashes: HashArray;
  readonly finding_hashes: HashArray;
  readonly status: "evaluated" | "not_applicable" | "inconclusive";
  readonly recorded_at: Instant;
  readonly core_hash: Hash;
};

export type JourneyResultV1 = PreSelectionJourneyResultV1
  | SelectedJourneyResultV1;

export type DomainResultEvaluatedV1 = {
  readonly schema_version: "domain-result-evaluated/v1";
  readonly run_id: RunId;
  readonly generic_run_policy_hash: Hash;
  readonly domain_pack_hashes: HashArray;
  readonly observation_bundle_hash: Hash;
  readonly canonical_evidence_envelope_hash: Hash;
  readonly subject_output_hash: Hash;
  readonly claim_set_hash?: Hash;
  readonly truth_reveal_hash: Hash;
  readonly metric_result_hashes: HashArray;
  readonly finding_hashes: HashArray;
  readonly status: "evaluated" | "unsupported" | "inconclusive";
  readonly recorded_at: Instant;
  readonly core_hash: Hash;
};

export type DomainResultNotApplicableV1 = {
  readonly schema_version: "domain-result-not-applicable/v1";
  readonly run_id: RunId;
  readonly generic_run_policy_hash: Hash;
  readonly terminal_stage: JourneyIntent;
  readonly reason: "pre_environment_terminal" | "setup_terminal" | "connection_terminal" | "functional_evidence_unavailable";
  readonly journey_result_hash: Hash;
  readonly finding_hashes: HashArray;
  readonly status: "not_applicable";
  readonly recorded_at: Instant;
  readonly core_hash: Hash;
};

export type DomainResultV1 = DomainResultEvaluatedV1
  | DomainResultNotApplicableV1;

export type GenericPrecleanupResultJoinV1 = {
  readonly schema_version: "generic-precleanup-result-join/v1";
  readonly run_id: RunId;
  readonly journey_result_hash: Hash;
  readonly domain_result_hash: Hash;
  readonly domain_variant: "evaluated" | "not_applicable";
  readonly both_frozen_before_cleanup: true;
  readonly lifecycle_event_hash: Hash;
  readonly joined_at: Instant;
  readonly core_hash: Hash;
};

export type GenericEvaluationIndexV1 = {
  readonly schema_version: "generic-evaluation-index/v1";
  readonly run_id: RunId;
  readonly generic_run_policy_hash: Hash;
  readonly validity_result_hash: Hash;
  readonly journey_result_hash: Hash;
  readonly domain_result_hash: Hash;
  readonly precleanup_result_join_hash: Hash;
  readonly evaluator_version: string;
  readonly core_hash: Hash;
};

// ---- erl2:selection : ERL2 V2 blind-selection chain contracts ----

export type ComparisonPolicyV1 = {
  readonly schema_version: "comparison-policy/v1";
  readonly policy_id: Id;
  readonly mode: "replay_comparison" | "live_ecosystem";
  readonly selection_eligibility: "development_only_non_blind" | "blind_capable";
  readonly replay_envelope_hash?: Hash;
  readonly equivalence_profile_hash?: Hash;
  readonly independent_equivalence_verifier_hash?: Hash;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type JourneySelectionPolicyV1 = {
  readonly schema_version: "journey-selection-policy/v1";
  readonly policy_id: Id;
  readonly challenge_family_hash: Hash;
  readonly journey_family_root_hash: Hash;
  readonly allowed_intents: readonly JourneyIntent[];
  readonly journey_schema_hash: Hash;
  readonly step_commitment_schema_hash: Hash;
  readonly actor_policy_hash: Hash;
  readonly actor_policy_schema_hash: Hash;
  readonly admission_policy_hash: Hash;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type ExternalBeaconRandomnessPolicyV1 = {
  readonly schema_version: "external-beacon-randomness-policy/v1";
  readonly policy_id: Id;
  readonly source_kind: "external_beacon";
  readonly source_id: Id;
  readonly source_trust_policy_hash: Hash;
  readonly beacon_trust_configuration_hash: Hash;
  readonly round_rule: "first_finalized_round_after_pool_checkpoint";
  readonly finality_rule_hash: Hash;
  readonly retry_policy: "none_invalidate_run";
  readonly required_operator_separation_policy_hash: Hash;
  readonly randomness_domain: "ERL2-SELECTION-RANDOMNESS-V1";
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type ThresholdVrfRandomnessPolicyV1 = {
  readonly schema_version: "threshold-vrf-randomness-policy/v1";
  readonly source_kind: "threshold_vrf";
  readonly activation_status: "disabled_pending_adr_erl2_011";
  readonly activation_gate: "ADR-ERL2-011";
  readonly admissible: false;
  readonly emittable: false;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type SelectionRandomnessPolicyV1 = ExternalBeaconRandomnessPolicyV1;

export type SelectionRequestV2 = {
  readonly schema_version: "selection-request/v2";
  readonly request_id: Id;
  readonly run_id: RunId;
  readonly request_nonce: string;
  readonly requested_tier: Tier;
  readonly acquisition_preregistration_hash: Hash;
  readonly acquisition_source_manifest_hash: Hash;
  readonly acquisition_record_hash: Hash;
  readonly subject_package_manifest_hash: Hash;
  readonly adapter_manifest_hash: Hash;
  readonly admissible_archetype_set_hash: Hash;
  readonly challenge_family_hash: Hash;
  readonly environment_profile_hash: Hash;
  readonly eligibility_policy_hash: Hash;
  readonly configuration_intent_hash: Hash;
  readonly generic_run_policy_hash: Hash;
  readonly actor_policy_hash: Hash;
  readonly comparison_policy_hash: Hash;
  readonly selection_randomness_policy_hash: Hash;
  readonly journey_selection_policy_hash: Hash;
  readonly non_blind_replay_persona_script_hash?: Hash;
  readonly non_blind_replay_journey_hash?: Hash;
  readonly non_blind_replay_step_commitment_hashes?: readonly Hash[];
  readonly requested_at: Instant;
  readonly expires_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type SelectionRoleSeparationAuditV1 = {
  readonly schema_version: "selection-role-separation-audit/v1";
  readonly audit_id: Id;
  readonly run_id: RunId;
  readonly selection_request_hash: Hash;
  readonly role_assignments: readonly ({
    readonly role: "challenge_governor" | "selector" | "randomness_source" | "reveal_custodian" | "evaluator";
    readonly operator_identity_hash: Hash;
    readonly key_ids: KeyIdArray;
  })[];
  readonly reveal_threshold: number;
  readonly reveal_participant_key_ids: readonly KeyId[];
  readonly prohibited_operator_overlaps: EmptyArray;
  readonly prohibited_key_overlaps: EmptyArray;
  readonly append_only_access_log_head_hash: Hash;
  readonly all_required_roles_disjoint: true;
  readonly status: "passed";
  readonly audited_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type SelectorVisibleProfileV1 = {
  readonly payload_ciphertext_byte_length: number;
  readonly entry_serialized_byte_length: number;
  readonly opaque_handle_encoding: "base64url-256";
  readonly artifact_path_pattern_id: Id;
  readonly artifact_path_byte_length: number;
  readonly payload_media_type: "application/vnd.erl2.selection-binding+age";
  readonly payload_classification: "SECRET";
  readonly payload_encryption: "threshold-x25519-envelope/v1";
  readonly payload_padding: "iso7816-4-to-fixed-size";
  readonly reveal_threshold: number;
  readonly reveal_participant_key_ids: readonly KeyId[];
  readonly decryption_release_policy_hash: Hash;
  readonly entry_signer_key_id: KeyId;
  readonly hidden_payload_schema_hash: Hash;
  readonly challenge_correlated_cleartext_fields: EmptyArray;
  readonly exposure_epoch_visibility: "encrypted_until_selected";
  readonly core_hash: Hash;
};

export type EligibilityPoolEntryV2 = {
  readonly schema_version: "eligibility-pool-entry/v2";
  readonly opaque_entry_handle: Base64Url256;
  readonly weight: 1;
  readonly challenge_actor_journey_hiding_commitment: Hash;
  readonly encrypted_binding_payload: ArtifactRef;
  readonly selector_visible_profile_hash: Hash;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type HiddenBindingPayloadV1 = {
  readonly schema_version: "hidden-binding-payload/v1";
  readonly challenge_manifest_hash: Hash;
  readonly persona_script_hash: Hash;
  readonly journey_hash: Hash;
  readonly ordered_step_commitment_hashes: readonly Hash[];
  readonly exposure_epoch: number;
  readonly opening_nonce_base64: string;
};

export type EligibilityPoolManifestV2 = {
  readonly schema_version: "eligibility-pool-manifest/v2";
  readonly pool_id: Id;
  readonly selection_request_hash: Hash;
  readonly journey_selection_policy_hash: Hash;
  readonly selection_randomness_policy_hash: Hash;
  readonly randomness_source_id: Id;
  readonly randomness_source_trust_policy_hash: Hash;
  readonly selection_role_separation_audit_hash: Hash;
  readonly ordered_entry_hashes: readonly Hash[];
  readonly entry_count: number;
  readonly pool_root_hash: Hash;
  readonly eligibility_proof_hash: Hash;
  readonly selector_visible_profile: SelectorVisibleProfileV1;
  readonly created_at: Instant;
  readonly expires_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type ExternalBeaconRandomnessReceiptV1 = {
  readonly schema_version: "external-beacon-randomness-receipt/v1";
  readonly receipt_id: Id;
  readonly run_id: RunId;
  readonly selection_request_hash: Hash;
  readonly eligibility_pool_manifest_hash: Hash;
  readonly pool_root_hash: Hash;
  readonly pool_manifest_timestamp_checkpoint_hash: Hash;
  readonly randomness_policy_hash: Hash;
  readonly source_kind: "external_beacon";
  readonly source_id: Id;
  readonly source_trust_policy_hash: Hash;
  readonly source_round_id: string;
  readonly source_request_binding_hash: Hash;
  readonly randomness_output_base64: string;
  readonly randomness_output_hash: Hash;
  readonly beacon_signed_payload_hash: Hash;
  readonly beacon_inclusion_proof: ArtifactRef;
  readonly beacon_signature_proof: ArtifactRef;
  readonly wrapper_kind: "lab_verifier_beacon_association";
  readonly association_rule: "first_finalized_round_after_pool_checkpoint";
  readonly beacon_signed_scope: "canonical_beacon_round_and_output_only";
  readonly wrapper_signed_scope: "erl_request_policy_source_pool_checkpoint_round_association";
  readonly round_observed_at: Instant;
  readonly wrapped_at: Instant;
  readonly core_hash: Hash;
  readonly wrapper_signature: Signature;
};

export type SelectionRandomnessReceiptV1 = ExternalBeaconRandomnessReceiptV1;

export type BeaconSignatureProofV1 = {
  readonly proof_kind: "beacon_native_signature";
  readonly scope: "canonical_beacon_round_and_output_only";
  readonly native_signature_domain: string;
  readonly source_id: Id;
  readonly round_id: string;
  readonly randomness_output_base64: Base64;
  readonly beacon_signed_payload_hash: Hash;
  readonly signature: Signature;
};

export type BeaconInclusionProofV1 = {
  readonly proof_kind: "beacon_native_inclusion";
  readonly source_id: Id;
  readonly round_id: string;
  readonly previous_round_id?: string;
  readonly chain_hash: Hash;
};

export type RandomnessSourceTrustVerificationReportV1 = {
  readonly schema_version: "randomness-source-trust-verification-report/v1";
  readonly report_id: Id;
  readonly run_id: RunId;
  readonly selection_randomness_policy_hash: Hash;
  readonly selection_randomness_receipt_hash: Hash;
  readonly source_kind: "external_beacon";
  readonly source_id: Id;
  readonly source_trust_policy_hash: Hash;
  readonly verifier_pinned_registry_head_hash: Hash;
  readonly authorized_beacon_key_ids: KeyIdArray;
  readonly verified_beacon_key_ids: KeyIdArray;
  readonly authorized_wrapper_key_ids: KeyIdArray;
  readonly verified_wrapper_key_ids: KeyIdArray;
  readonly checks: {
    readonly policy_source_authorized: true;
    readonly policy_trust_hash_pinned: true;
    readonly receipt_source_matches: true;
    readonly beacon_keys_subset_authorized: true;
    readonly wrapper_key_authorized_by_run_trust_policy: true;
    readonly beacon_native_scope_verified: true;
    readonly source_proof_valid: true;
    readonly wrapper_signature_valid: true;
    readonly wrapper_scope_verified: true;
    readonly registry_current_and_non_revoked: true;
  };
  readonly verified_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type SelectionCommitmentV2 = {
  readonly schema_version: "selection-commitment/v2";
  readonly commitment_id: Id;
  readonly run_id: RunId;
  readonly selection_request_hash: Hash;
  readonly eligibility_pool_manifest_hash: Hash;
  readonly pool_root_hash: Hash;
  readonly selection_randomness_receipt_hash: Hash;
  readonly source_trust_verification_report_hash: Hash;
  readonly selected_opaque_entry_handle: Base64Url256;
  readonly selected_entry_hash: Hash;
  readonly selection_algorithm: "hmac-sha256-rejection-sampling/v1";
  readonly committed_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type ThresholdRevealReceiptV1 = {
  readonly schema_version: "threshold-reveal-receipt/v1";
  readonly receipt_id: Id;
  readonly run_id: RunId;
  readonly selection_commitment_hash: Hash;
  readonly commitment_timestamp_checkpoint_hash: Hash;
  readonly selected_entry_hash: Hash;
  readonly threshold: number;
  readonly participant_key_ids: readonly KeyId[];
  readonly decryption_share_receipt_hashes: readonly Hash[];
  readonly append_only_access_log_head_hash: Hash;
  readonly released_at: Instant;
  readonly core_hash: Hash;
  readonly participant_signatures: readonly Signature[];
};

export type SelectedChallengeJourneyBindingV1 = {
  readonly schema_version: "selected-challenge-journey-binding/v1";
  readonly run_id: RunId;
  readonly selection_commitment_hash: Hash;
  readonly selected_opaque_entry_handle: Base64Url256;
  readonly pool_entry_hash: Hash;
  readonly encrypted_binding_payload_file_sha256: Hash;
  readonly payload_plaintext_hash: Hash;
  readonly challenge_manifest_hash: Hash;
  readonly persona_script_hash: Hash;
  readonly journey_hash: Hash;
  readonly ordered_step_commitment_hashes: readonly Hash[];
  readonly exposure_epoch: number;
  readonly threshold_reveal_receipt_hash: Hash;
  readonly opening_nonce_base64: string;
  readonly opening_event_hash: Hash;
  readonly opened_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type SelectionProofV2 = {
  readonly schema_version: "selection-proof/v2";
  readonly proof_id: Id;
  readonly run_id: RunId;
  readonly selection_request_hash: Hash;
  readonly eligibility_pool_manifest_hash: Hash;
  readonly pool_manifest_timestamp_checkpoint_hash: Hash;
  readonly selection_randomness_policy_hash: Hash;
  readonly randomness_source_kind: "external_beacon";
  readonly randomness_source_id: Id;
  readonly randomness_source_trust_policy_hash: Hash;
  readonly source_request_binding_hash: Hash;
  readonly source_trust_verification_report_hash: Hash;
  readonly selection_randomness_receipt_hash: Hash;
  readonly selection_commitment_hash: Hash;
  readonly commitment_timestamp_checkpoint_hash: Hash;
  readonly threshold_reveal_receipt_hash: Hash;
  readonly selected_binding_hash: Hash;
  readonly binding_timestamp_checkpoint_hash: Hash;
  readonly request_nonce: string;
  readonly algorithm: "hmac-sha256-rejection-sampling/v1";
  readonly rejection_count: number;
  readonly derived_index: number;
  readonly derived_opaque_entry_handle: Base64Url256;
  readonly pool_checkpoint_precedes_randomness: true;
  readonly randomness_precedes_source_trust: true;
  readonly source_trust_precedes_commitment: true;
  readonly commitment_checkpoint_precedes_opening: true;
  readonly opening_precedes_binding: true;
  readonly binding_checkpoint_precedes_proof: true;
  readonly opening_event_hash: Hash;
  readonly proved_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type SelectionVerificationReceiptV2 = {
  readonly schema_version: "selection-verification-receipt/v2";
  readonly receipt_id: Id;
  readonly run_id: RunId;
  readonly selection_request_hash: Hash;
  readonly eligibility_pool_manifest_hash: Hash;
  readonly selection_commitment_hash: Hash;
  readonly selection_proof_hash: Hash;
  readonly selection_randomness_policy_hash: Hash;
  readonly randomness_source_kind: "external_beacon";
  readonly randomness_source_id: Id;
  readonly randomness_source_trust_policy_hash: Hash;
  readonly source_request_binding_hash: Hash;
  readonly source_trust_verification_report_hash: Hash;
  readonly selection_randomness_receipt_hash: Hash;
  readonly pool_manifest_timestamp_checkpoint_hash: Hash;
  readonly commitment_timestamp_checkpoint_hash: Hash;
  readonly threshold_reveal_receipt_hash: Hash;
  readonly selected_binding_hash: Hash;
  readonly binding_timestamp_checkpoint_hash: Hash;
  readonly selection_role_separation_audit_hash: Hash;
  readonly journey_selection_policy_hash: Hash;
  readonly verified_selected_entry_hash: Hash;
  readonly checks: {
    readonly request_pool_bound: true;
    readonly role_separation_precedes_pool: true;
    readonly ordered_entry_root_verified: true;
    readonly uniform_selector_metadata_verified: true;
    readonly selected_entry_in_pool: true;
    readonly pool_checkpoint_verified: true;
    readonly single_policy_source_verified: true;
    readonly source_request_binding_verified: true;
    readonly randomness_variant_verified: true;
    readonly beacon_native_proof_verified: true;
    readonly beacon_wrapper_signature_verified: true;
    readonly beacon_wrapper_scope_verified: true;
    readonly threshold_vrf_inactive_verified: true;
    readonly verifier_pinned_source_trust_verified: true;
    readonly independent_randomness_verified: true;
    readonly pool_checkpoint_precedes_randomness: true;
    readonly randomness_precedes_source_trust: true;
    readonly source_trust_precedes_commitment: true;
    readonly commitment_checkpoint_verified: true;
    readonly commitment_checkpoint_precedes_opening: true;
    readonly threshold_reveal_verified: true;
    readonly opening_precedes_binding: true;
    readonly binding_checkpoint_verified: true;
    readonly binding_checkpoint_precedes_proof: true;
    readonly selection_algorithm_verified: true;
    readonly hiding_commitment_opened: true;
    readonly manifest_journey_steps_verified: true;
    readonly journey_family_verified: true;
    readonly actor_family_verified: true;
    readonly exposure_eligible: true;
    readonly role_separation_verified: true;
    readonly access_log_verified: true;
  };
  readonly verified_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type NonBlindSelectionAssuranceV1 = {
  readonly mode: "non_blind_development";
  readonly blindness_claim: "none";
};

export type BlindSelectionAssuranceV1 = {
  readonly mode: "blind_or_held_out";
  readonly blindness_assurance: "role_separated_threshold_protocol";
  readonly residual_limitation: "governor/selector/reveal-quorum or privileged-administrator collusion is not excluded";
  readonly role_separation_audit_hash: Hash;
  readonly randomness_source_id: Id;
  readonly randomness_source_trust_policy_hash: Hash;
  readonly source_trust_verification_report_hash: Hash;
  readonly selection_randomness_receipt_hash: Hash;
  readonly threshold_reveal_receipt_hash: Hash;
  readonly access_log_head_hash: Hash;
};

export type SelectionAssuranceV1 = NonBlindSelectionAssuranceV1
  | BlindSelectionAssuranceV1;

// ---- erl2:subject : ERL2 subject step-detail records, capability declaration and assistance evidence ----

export type SubjectInstallationRecordV1 = {
  readonly schema_version: "subject-installation-record/v1";
  readonly run_id: RunId;
  readonly attempt_id: Id;
  readonly plan_hash: Hash;
  readonly adapter_hash: Hash;
  readonly started_at: Instant;
  readonly ended_at: Instant;
  readonly status: RecordStatus;
  readonly package_verification_hash: Hash;
  readonly mutations: HashArray;
  readonly compensation_ids: IdArray;
  readonly warnings: ShortStringArray;
  readonly error_codes: ShortStringArray;
  readonly active_operator_ms: number;
  readonly elapsed_ms: number;
  readonly core_hash: Hash;
};

export type SubjectConfigurationRecordV1 = {
  readonly schema_version: "subject-configuration-record/v1";
  readonly run_id: RunId;
  readonly attempt_id: Id;
  readonly installation_hash: Hash;
  readonly input_configuration_hash: Hash;
  readonly redacted_change_refs: ArtifactRefArray;
  readonly credential_scopes_requested: ShortStringArray;
  readonly credential_scopes_granted: ShortStringArray;
  readonly credential_scopes_used: ShortStringArray;
  readonly documentation_step_ids: IdArray;
  readonly warnings: ShortStringArray;
  readonly error_codes: ShortStringArray;
  readonly manual_intervention_ids: IdArray;
  readonly status: RecordStatus;
  readonly started_at: Instant;
  readonly ended_at: Instant;
  readonly active_operator_ms: number;
  readonly core_hash: Hash;
};

export type SubjectInteractionRecordV1 = {
  readonly schema_version: "subject-interaction-record/v1";
  readonly run_id: RunId;
  readonly interaction_id: Id;
  readonly step_hash: Hash;
  readonly intent: JourneyIntent;
  readonly request_core_hash: Hash;
  readonly subject_visible_input_hash: Hash;
  readonly response_artifacts: ArtifactRefArray;
  readonly mutations: HashArray;
  readonly status: RecordStatus;
  readonly started_at: Instant;
  readonly ended_at: Instant;
  readonly active_operator_ms: number;
  readonly retry_count: number;
  readonly core_hash: Hash;
};

export type SubjectCapabilityDeclarationV1 = {
  readonly schema_version: "subject-capability-declaration/v1";
  readonly subject_id: Id;
  readonly domain: "software_delivery_operations";
  readonly consumes: readonly ({
    readonly evidence_kind: Id;
    readonly schema_ids: ShortStringArray;
    readonly required: boolean;
  })[];
  readonly produces: readonly ({
    readonly claim_categories: IdArray;
    readonly action_kinds: IdArray;
  })[];
  readonly credential_needs: readonly ({
    readonly kind: Id;
    readonly scope: string;
    readonly required: boolean;
  })[];
  readonly limitations: ShortStringArray;
  readonly declared_at: Instant;
  readonly core_hash: Hash;
  readonly signature?: Signature;
};

export type AssistanceEventV1 = {
  readonly schema_version: "assistance-event/v1";
  readonly event_id: Id;
  readonly run_id: RunId;
  readonly step_id: Id;
  readonly actor_kind: "human_operator" | "scripted_actor" | "agent";
  readonly actor_script_version: string;
  readonly prompt_hash: Hash;
  readonly visible_evidence_hashes: HashArray;
  readonly action: "followed_documented_step" | "manual_intervention" | "undocumented_workaround" | "privilege_escalation_request" | "abandoned";
  readonly intervention_reason_code?: string;
  readonly narration_artifact?: ArtifactRef;
  readonly started_at: Instant;
  readonly ended_at: Instant;
  readonly active_ms: number;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

// ---- erl2:terminal : ERL2 terminal run records, attestations, public bundles and closure report ----

export type CancellationRequestV1 = {
  readonly schema_version: "cancellation-request/v1";
  readonly request_id: Id;
  readonly run_id: RunId;
  readonly cancelled_during: "pre_environment" | "selection" | "environment_setup" | "journey_execution" | "cleanup" | "finalization";
  readonly observed_state: string;
  readonly requested_by_actor_id: Id;
  readonly reason_code: string;
  readonly requested_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type PreEnvironmentLabRunRecordV1 = {
  readonly schema_version: "pre-environment-lab-run-record/v1";
  readonly run_id: RunId;
  readonly terminal_stage: PreEnvironmentJourneyIntent;
  readonly acquisition_preregistration_hash: Hash;
  readonly acquisition_source_manifest_hash: Hash;
  readonly acquisition_record_hash: Hash;
  readonly package_verification_record_hash?: Hash;
  readonly adapter_hash: Hash;
  readonly generic_run_policy_hash: Hash;
  readonly subject_output_hash: Hash;
  readonly journey_result_hash: Hash;
  readonly domain_not_applicable_result_hash: Hash;
  readonly precleanup_result_join_hash: Hash;
  readonly pre_environment_cleanup_hash: Hash;
  readonly validity_result_hash: Hash;
  readonly generic_evaluation_index_hash: Hash;
  readonly lifecycle_head_hash: Hash;
  readonly core_hash: Hash;
};

export type EnvironmentLabRunRecordV1 = {
  readonly schema_version: "environment-lab-run-record/v1";
  readonly run_id: RunId;
  readonly terminal_stage: EnvironmentJourneyIntent;
  readonly acquisition_preregistration_hash: Hash;
  readonly acquisition_source_manifest_hash: Hash;
  readonly acquisition_record_hash: Hash;
  readonly subject_package_manifest_hash: Hash;
  readonly selection_request_hash: Hash;
  readonly selection_receipt_hash: Hash;
  readonly selected_challenge_journey_binding_hash: Hash;
  readonly adapter_hash: Hash;
  readonly generic_run_policy_hash: Hash;
  readonly plan_hash: Hash;
  readonly environment_instance_hash: Hash;
  readonly observation_hash?: Hash;
  readonly canonical_evidence_envelope_hash?: Hash;
  readonly adapter_translation_receipt_hash?: Hash;
  readonly subject_output_hash: Hash;
  readonly journey_result_hash: Hash;
  readonly domain_result_hash: Hash;
  readonly precleanup_result_join_hash: Hash;
  readonly generic_evaluation_index_hash: Hash;
  readonly environment_restoration_hash: Hash;
  readonly teardown_hash: Hash;
  readonly lifecycle_head_hash: Hash;
  readonly core_hash: Hash;
};

export type InvalidNonJourneyPhase = "acquisition_preregistration" | "acquisition" | "package_verification" | "challenge_preregistration" | "selection" | "provisioning" | "baseline" | "planning" | "activation" | "observation" | "output_freeze" | "reveal" | "evaluation" | "pre_environment_cleanup" | "environment_restoration" | "emergency_cleanup" | "teardown" | "validity" | "finalization";

export type InvalidLifecyclePhaseV1 = {
  readonly kind: "lifecycle_phase";
  readonly phase: InvalidNonJourneyPhase;
  readonly lifecycle_event_hash: Hash;
};

export type InvalidJourneyExecutionPhaseV1 = {
  readonly kind: "journey_execution";
  readonly failed_intent: EnvironmentJourneyIntent;
  readonly step_commitment_hash: Hash;
  readonly lifecycle_event_hash: Hash;
};

export type InvalidCancellationPhaseV1 = {
  readonly kind: "cancellation";
  readonly cancelled_during: "pre_environment" | "selection" | "environment_setup" | "journey_execution" | "cleanup" | "finalization";
  readonly journey_intent?: EnvironmentJourneyIntent;
  readonly lifecycle_event_hash: Hash;
};

export type InvalidFailurePhaseV1 = InvalidLifecyclePhaseV1
  | InvalidJourneyExecutionPhaseV1
  | InvalidCancellationPhaseV1;

export type InvalidFailureClassification = "lab_invalidity" | "dependency_failure" | "adapter_failure" | "evaluator_failure" | "integrity_failure" | "cleanup_failure" | "teardown_failure";

export type ClassifiedFailureTerminalReasonV1 = {
  readonly kind: "classified_failure";
  readonly classification: InvalidFailureClassification;
  readonly failure_event_hash: Hash;
  readonly primary_finding_hash: Hash;
  readonly invalidity_finding_hash?: Hash;
};

export type CancellationTerminalReasonV1 = {
  readonly kind: "cancellation";
  readonly classification: "cancellation";
  readonly cancellation_request_hash: Hash;
  readonly cancellation_event_hash: Hash;
  readonly requested_by_actor_hash: Hash;
  readonly reason_code: string;
};

export type InvalidTerminalReasonV1 = ClassifiedFailureTerminalReasonV1
  | CancellationTerminalReasonV1;

export type InvalidLabRunRecordV1 = {
  readonly schema_version: "invalid-lab-run-record/v1";
  readonly run_id: RunId;
  readonly terminal_state: "invalidated";
  readonly failed_phase: InvalidFailurePhaseV1;
  readonly terminal_reason: InvalidTerminalReasonV1;
  readonly available_evidence: readonly ({
    readonly artifact_role: Id;
    readonly artifact_hash: Hash;
    readonly reached_event_hash: Hash;
  })[];
  readonly cleanup: {
    readonly variant: "none" | "pre_environment" | "partial_environment" | "environment" | "emergency_environment";
    readonly status: "not_required" | "attempted_succeeded" | "attempted_failed";
    readonly attempt_hashes: HashArray;
    readonly result_hash?: Hash;
  };
  readonly lifecycle_head_hash: Hash;
  readonly invalidated_at: Instant;
  readonly core_hash: Hash;
};

export type LabRunRecordV1 = PreEnvironmentLabRunRecordV1
  | EnvironmentLabRunRecordV1
  | InvalidLabRunRecordV1;

export type PreEnvironmentFinalLabAttestationV1 = {
  readonly schema_version: "pre-environment-final-lab-attestation/v1";
  readonly attestation_id: Id;
  readonly run_id: RunId;
  readonly terminal_variant: "pre_environment";
  readonly run_record_hash: Hash;
  readonly acquisition_preregistration_verification_receipt_hash: Hash;
  readonly signer_inventory_hash: Hash;
  readonly timestamp_checkpoint_hash: Hash;
  readonly run_trust_policy_hash: Hash;
  readonly acquisition_source_manifest_hash: Hash;
  readonly acquisition_record_hash: Hash;
  readonly adapter_hash: Hash;
  readonly generic_run_policy_hash: Hash;
  readonly generic_evaluation_index_hash: Hash;
  readonly cleanup: {
    readonly kind: "pre_environment";
    readonly verification_hash: Hash;
  };
  readonly lab_validity: "valid";
  readonly claim_scope: ClaimScope;
  readonly finalized_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type EnvironmentFinalLabAttestationV1 = {
  readonly schema_version: "environment-final-lab-attestation/v1";
  readonly attestation_id: Id;
  readonly run_id: RunId;
  readonly terminal_variant: "environment";
  readonly run_record_hash: Hash;
  readonly acquisition_preregistration_verification_receipt_hash: Hash;
  readonly selection_receipt_hash: Hash;
  readonly signer_inventory_hash: Hash;
  readonly timestamp_checkpoint_hash: Hash;
  readonly run_trust_policy_hash: Hash;
  readonly acquisition_source_manifest_hash: Hash;
  readonly acquisition_record_hash: Hash;
  readonly subject_package_manifest_hash: Hash;
  readonly adapter_hash: Hash;
  readonly generic_run_policy_hash: Hash;
  readonly generic_evaluation_index_hash: Hash;
  readonly cleanup: {
    readonly kind: "environment";
    readonly restoration_hash: Hash;
    readonly teardown_hash: Hash;
  };
  readonly exposure_event_hash: Hash;
  readonly selection_assurance: SelectionAssuranceV1;
  readonly lab_validity: "valid";
  readonly claim_scope: ClaimScope;
  readonly finalized_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type FinalLabAttestationV1 = PreEnvironmentFinalLabAttestationV1
  | EnvironmentFinalLabAttestationV1;

export type PreEnvironmentPublicVerificationBundleV2 = {
  readonly schema_version: "public-verification-bundle/v2";
  readonly terminal_variant: "pre_environment";
  readonly bundle_id: Id;
  readonly run_id: RunId;
  readonly final_attestation: BundleMember;
  readonly acquisition_preregistration_verification_receipt: BundleMember;
  readonly signer_inventory: BundleMember;
  readonly run_trust_policy: BundleMember;
  readonly acquisition_timestamp_checkpoint_chain: readonly BundleMember[];
  readonly verification_trust_head_source: "local_root_pinned_configuration";
  readonly execution_verification_mode: "finalizer_verdict_only";
  readonly execution_artifacts: EmptyArray;
  readonly created_at: Instant;
  readonly core_hash: Hash;
};

export type EnvironmentPublicVerificationBundleV2 = {
  readonly schema_version: "public-verification-bundle/v2";
  readonly terminal_variant: "environment";
  readonly bundle_id: Id;
  readonly run_id: RunId;
  readonly final_attestation: BundleMember;
  readonly acquisition_preregistration_verification_receipt: BundleMember;
  readonly selection_verification_receipt: BundleMember;
  readonly signer_inventory: BundleMember;
  readonly run_trust_policy: BundleMember;
  readonly selected_run_timestamp_checkpoint_chain: readonly BundleMember[];
  readonly verification_trust_head_source: "local_root_pinned_configuration";
  readonly execution_verification_mode: "finalizer_verdict_only";
  readonly execution_artifacts: EmptyArray;
  readonly created_at: Instant;
  readonly core_hash: Hash;
};

export type PublicVerificationBundleV2 = PreEnvironmentPublicVerificationBundleV2
  | EnvironmentPublicVerificationBundleV2;

export type MandatoryGraphClosureReportV1 = {
  readonly schema_version: "mandatory-graph-closure-report/v1";
  readonly algorithm: "erl2-mandatory-closure/v1";
  readonly run_id: RunId;
  readonly derived_terminal_phase: JourneyIntent
    | InvalidFailurePhaseV1;
  readonly derived_terminal_variant: "pre_environment" | "environment" | "invalid";
  readonly lifecycle_head_hash: Hash;
  readonly verified_trust_head_hash?: Hash;
  readonly required_hashes_by_role: readonly ({
    readonly role: Id;
    readonly ordered_hashes: HashArray;
  })[];
  readonly rejected_extra_hashes: HashArray;
  readonly missing_roles: IdArray;
  readonly verdict: "valid" | "invalid";
  readonly verified_at: Instant;
  readonly verifier_release_hash: Hash;
  readonly core_hash: Hash;
};

// ---- erl2:trust : ERL2 trust, timestamp, signer-inventory and lifecycle contracts ----

export type SignerRole = "trust_root" | "timestamp_authority" | "policy_author" | "preregistrar" | "challenge_governor" | "environment_governor" | "selector" | "randomness_source" | "lab_verifier_association_signer" | "reveal_custodian" | "truth_custodian" | "vault_authorizer" | "controller" | "traffic_supervisor" | "runtime_attestor" | "reveal_service" | "adapter_owner" | "evaluator" | "confidential_selection_auditor" | "final_attestation_signer" | "deep_finalizer";

export type TrustPolicyManifestV2 = {
  readonly schema_version: "trust-policy-manifest/v2";
  readonly manifest_id: Id;
  readonly version: number;
  readonly issued_at: Instant;
  readonly keys: readonly ({
    readonly key_id: KeyId;
    readonly public_key_pem: string;
    readonly signer_roles: readonly SignerRole[];
    readonly permitted_contract_types: readonly string[];
    readonly permitted_encryption_recipient_ids: KeyIdArray;
    readonly valid_from: Instant;
    readonly valid_until: Instant;
    readonly status: "active" | "retired";
    readonly retired_at?: Instant;
    readonly tiers: readonly Tier[];
  })[];
  readonly revocations: readonly ({
    readonly revocation_id: Id;
    readonly key_id: KeyId;
    readonly scope: "prospective" | "from_timestamp" | "all_historical";
    readonly announced_at: Instant;
    readonly effective_at?: Instant;
    readonly from_timestamp?: Instant;
    readonly reason_code: string;
  })[];
  readonly prior_manifest_hash?: Hash;
  readonly root_key_id: KeyId;
  readonly core_hash: Hash;
  readonly root_signature: Signature;
};

export type TrustedTimestampCheckpointV1 = {
  readonly schema_version: "trusted-timestamp-checkpoint/v1";
  readonly checkpoint_id: Id;
  readonly log_id: Id;
  readonly context: {
    readonly scope: "selected_run_public";
    readonly run_id: RunId;
  }
    | {
    readonly scope: "confidential_admission";
    readonly admission_context_id: Id;
  };
  readonly prior_checkpoint_hash?: Hash;
  readonly first_sequence: number;
  readonly last_sequence: number;
  readonly entries: readonly ({
    readonly sequence: number;
    readonly artifact_schema_version: string;
    readonly artifact_core_hash: Hash;
    readonly signer_key_id: KeyId;
    readonly signature_sha256: Hash;
    readonly security_timestamp: Instant;
  })[];
  readonly checkpointed_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type SignerInventoryEntry = {
  readonly artifact_schema_version: string;
  readonly artifact_core_hash: Hash;
  readonly signer_key_id: KeyId;
  readonly signature_sha256: Hash;
  readonly security_timestamp: Instant;
  readonly timestamp_log_id: Id;
  readonly timestamp_sequence: number;
};

export type PreEnvironmentSignerInventoryV2 = {
  readonly schema_version: "signer-inventory/v2";
  readonly terminal_variant: "pre_environment";
  readonly inventory_id: Id;
  readonly run_id: RunId;
  readonly acquisition_preregistration_hash: Hash;
  readonly entries: readonly SignerInventoryEntry[];
  readonly excluded_public_terminal_types: readonly ["pre-environment-final-lab-attestation/v1"];
  readonly complete_for_terminal_chain: true;
  readonly inventoried_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type EnvironmentSignerInventoryV2 = {
  readonly schema_version: "signer-inventory/v2";
  readonly terminal_variant: "environment";
  readonly inventory_id: Id;
  readonly run_id: RunId;
  readonly selection_commitment_hash: Hash;
  readonly entries: readonly SignerInventoryEntry[];
  readonly excluded_public_terminal_types: readonly ["selection-verification-receipt/v2", "environment-final-lab-attestation/v1"];
  readonly complete_for_terminal_chain: true;
  readonly inventoried_at: Instant;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type SignerInventoryV2 = PreEnvironmentSignerInventoryV2
  | EnvironmentSignerInventoryV2;

export type TrustVerificationReportV2 = {
  readonly schema_version: "trust-verification-report/v2";
  readonly report_id: Id;
  readonly run_id: RunId;
  readonly terminal_variant: "pre_environment" | "environment";
  readonly verification_scope: "confidential_full" | "public_product";
  readonly final_attestation_hash: Hash;
  readonly public_verification_bundle_hash: Hash;
  readonly selection_verification_receipt_hash?: Hash;
  readonly signer_inventory_hash: Hash;
  readonly timestamp_checkpoint_hash: Hash;
  readonly run_trust_policy_hash: Hash;
  readonly verification_trust_head_hash: Hash;
  readonly head_descends_from_run_policy: true;
  readonly valid_when_signed: boolean;
  readonly currently_trusted: boolean;
  readonly signer_results: readonly ({
    readonly artifact_hash: Hash;
    readonly key_id: KeyId;
    readonly security_timestamp: Instant;
    readonly valid_when_signed: boolean;
    readonly currently_trusted: boolean;
    readonly applied_revocation_ids: IdArray;
  })[];
  readonly verified_at: Instant;
  readonly core_hash: Hash;
};

export type ExposureEventV1 = {
  readonly schema_version: "exposure-event/v1";
  readonly exposure_id: Id;
  readonly corpus_id: Id;
  readonly challenge_manifest_hash: Hash;
  readonly prior_tier: Tier;
  readonly resulting_tier: "development";
  readonly occurred_at: Instant;
  readonly reason: "product_team_view" | "truth_reveal" | "debug_access" | "public_disclosure";
  readonly actor_id: Id;
  readonly run_id?: RunId;
  readonly prior_exposure_hash?: Hash;
  readonly core_hash: Hash;
  readonly signature: Signature;
};

export type LabLifecycleEventV1 = {
  readonly schema_version: "lab-lifecycle-event/v1";
  readonly run_id: RunId;
  readonly sequence: number;
  readonly event_id: Id;
  readonly event_type: string;
  readonly state_from: string;
  readonly state_to: string;
  readonly occurred_at: Instant;
  readonly actor_id: Id;
  readonly command_id: Id;
  readonly operation_id: Id;
  readonly prior_event_hash?: Hash;
  readonly required_hashes: HashArray;
  readonly produced: readonly ({
    readonly artifact_role: Id;
    readonly artifact_core_hash: Hash;
    readonly artifact_schema_version: string;
  })[];
  readonly failure?: {
    readonly code: string;
    readonly owner: "lab" | "external_dependency" | "adapter" | "subject" | "evaluator" | "inconclusive";
    readonly message: string;
  };
  readonly core_hash: Hash;
};

