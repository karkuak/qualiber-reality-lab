import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertContract,
  type AdapterOperation,
  type AdapterRequestV2,
  type LocalObservationPlanV1,
  type PackageKind,
  type SandboxControlId,
  type SubjectAdapterCertificationReceiptV2,
  type SubjectAdapterManifestV2,
} from "@erl2/contracts";
import { ArtifactStore, coreHash, developmentKey, hashBytes, sealSigned } from "@erl2/integrity";
import { AdapterHost, SteppingClock } from "@erl2/core";
import { ownedTempDir } from "./tempDirs.js";
import { repoRoot } from "./adapterFixtures.js";

export const LOCAL_RUN_ID = "018f1111-2222-7333-8444-555555555555";
export const LOCAL_NOW = "2026-08-12T18:00:00Z";
export const LOCAL_LATER = "2026-08-12T18:10:00Z";
export const LOCAL_CLAIMS = [
  "score",
  "qualification",
  "governor_authorization",
  "reveal",
  "judge_evaluation",
  "governed_finalization",
] as const;

export interface LocalFixtureShape {
  readonly adapterId: string;
  readonly operation: AdapterOperation;
  readonly packageKind: PackageKind;
  readonly payload: Record<string, unknown>;
  readonly entryName: string;
  /**
   * Every operation the manifest and receipt certify, when that is wider than
   * the single operation the one-shot plan dispatches. A lifecycle fixture
   * declares `start` and `stop`; everything else certifies exactly what it runs.
   */
  readonly certifiedOperations?: readonly AdapterOperation[];
}

/** The operations a shape's manifest and receipt certify. */
function certifiedOperationsOf(shape: LocalFixtureShape): readonly AdapterOperation[] {
  return shape.certifiedOperations ?? [shape.operation];
}

export const ARCHIVE_SHAPE: LocalFixtureShape = {
  adapterId: "neutral-archive-observer",
  operation: "validate-package",
  packageKind: "archive",
  payload: {
    schema_version: "validate-package-payload/v1",
    package_input_id: "package-input",
    package_kind: "archive",
  },
  entryName: "local-archive-observer.mjs",
};

export const BUNDLE_SHAPE: LocalFixtureShape = {
  adapterId: "neutral-bundle-observer",
  operation: "project",
  packageKind: "bundle",
  payload: {
    schema_version: "project-payload/v1",
    evidence_input_ids: ["package-input"],
    projection_schema: "neutral-bundle-projection-v1",
  },
  entryName: "local-bundle-observer.mjs",
};

const controls = ["process-tree-termination", "deny-by-default-egress"] as const;

export function localEntry(shape: LocalFixtureShape): string {
  return path.join(repoRoot, "fixtures", "neutral", shape.entryName);
}

export function localManifest(shape: LocalFixtureShape): SubjectAdapterManifestV2 {
  return assertContract<SubjectAdapterManifestV2>(
    "SubjectAdapterManifestV2",
    sealSigned(
      {
        schema_version: "subject-adapter-manifest/v2" as const,
        adapter_id: shape.adapterId,
        version: "1.0.0",
        adapter_artifact_hash: hashBytes(readFileSync(localEntry(shape))),
        protocol_support: [
          {
            protocol_version: "subject-adapter/v2" as const,
            execution_modes: ["local_observation"] as const,
            operations: [...certifiedOperationsOf(shape)],
            supported_package_kinds: [shape.packageKind],
            required_controls: [...controls],
          },
        ],
        required_broker_capabilities: [],
        network_allowlist_ids: [],
        certification_receipt_hash: `sha256:${"0".repeat(64)}`,
        owner: "neutral fixture owner",
      },
      developmentKey("neutral-local-owner"),
    ),
  );
}

export function localReceipt(
  manifest: SubjectAdapterManifestV2,
  shape: LocalFixtureShape,
  overrides: Partial<SubjectAdapterCertificationReceiptV2> = {},
): SubjectAdapterCertificationReceiptV2 {
  const profile = {
    protocol_version: "subject-adapter/v2" as const,
    execution_modes: ["local_observation"] as const,
    operations: [...certifiedOperationsOf(shape)],
    supported_package_kinds: [shape.packageKind],
    required_controls: [...controls],
  };
  const base = {
    schema_version: "subject-adapter-certification-receipt/v2" as const,
    receipt_id: `local-cert-${shape.adapterId}`,
    suite: "ADAPTER-CERT-V2" as const,
    suite_version: 2 as const,
    adapter_manifest_hash: manifest.core_hash,
    adapter_artifact_hash: manifest.adapter_artifact_hash,
    adapter_id: manifest.adapter_id,
    adapter_version: manifest.version,
    certified_profiles: [profile],
    certified_modes: ["local_observation"] as const,
    certified_operations: [...certifiedOperationsOf(shape)],
    certified_package_kinds: [shape.packageKind],
    checks: [
      {
        check_id: "neutral-scope",
        status: "passed" as const,
        severity: "info" as const,
        detail: "Package A neutral fixture scope only; external certification remains incomplete",
      },
    ],
    verdict: "certified" as const,
    refusal_codes: [],
    certifier_id: "neutral-certifier",
    certifier_is_adapter_owner: false as const,
    enforced_controls: ["process-tree-termination"] as SandboxControlId[],
    unsupported_controls: ["deny-by-default-egress"] as SandboxControlId[],
    certification_authenticity: "locally_observed_unauthenticated" as const,
    signature_state: "unsigned" as const,
    certified_at: LOCAL_NOW,
    ...overrides,
  };
  return assertContract<SubjectAdapterCertificationReceiptV2>(
    "SubjectAdapterCertificationReceiptV2",
    { ...base, core_hash: coreHash(base) },
  );
}

export function localLimits() {
  const base = {
    schema_version: "local-observation-limits/v1" as const,
    wall_clock_ms: 5_000,
    max_request_bytes: 256 * 1024,
    max_response_bytes: 256 * 1024,
    max_output_files: 8,
    max_output_bytes: 64 * 1024,
    max_output_path_depth: 4,
    max_diagnostic_bytes: 8 * 1024,
    max_diagnostic_line_bytes: 512,
    environment_variable_names: [
      "ERL2_ADAPTER_PROTOCOL_VERSION",
      "ERL2_EXECUTION_ID",
      "ERL2_EXECUTION_MODE",
      "ERL2_OPERATION_ID",
    ] as const,
    input_root: "observation-inputs",
    workspace_root: "observation-workspace",
    output_root: "local-observation-output",
    control_expectations: [
      { control_id: "process-tree-termination" as const, required_state: "enforced" as const },
      { control_id: "deny-by-default-egress" as const, required_state: "unsupported_permitted" as const },
    ],
  };
  return { ...base, core_hash: coreHash(base) };
}

export function localEgressPolicy() {
  const base = {
    schema_version: "egress-allowlist-policy/v1" as const,
    policy_id: "local-default-deny",
    default_action: "deny" as const,
    allowed_schemes: ["https"] as const,
    allowed_hosts: [],
    allowed_ports: [443],
    max_redirects: 0,
    revalidate_redirect_targets: true as const,
    allow_loopback_hosts: [],
    deny_link_local: true as const,
    deny_metadata_service: true as const,
    deny_proxy_bypass: true as const,
  };
  return { ...base, core_hash: coreHash(base) };
}

export function localPlan(
  manifest: SubjectAdapterManifestV2,
  receipt: SubjectAdapterCertificationReceiptV2,
  shape: LocalFixtureShape,
): LocalObservationPlanV1 {
  const artifact = {
    path: "observation-inputs/package.bin",
    media_type: "application/octet-stream",
    byte_length: 8,
    file_sha256: `sha256:${"a".repeat(64)}`,
    classification: "INTERNAL" as const,
  };
  const base = {
    schema_version: "local-observation-plan/v1" as const,
    observation_id: LOCAL_RUN_ID,
    mode: "local_observation" as const,
    protocol_version: "subject-adapter/v2" as const,
    adapter_id: manifest.adapter_id,
    adapter_version: manifest.version,
    adapter_manifest_hash: manifest.core_hash,
    certification_receipt_hash: receipt.core_hash,
    adapter_artifact_hash: manifest.adapter_artifact_hash,
    certification_authenticity: "locally_observed_unauthenticated" as const,
    operations: [
      {
        sequence: 0,
        operation_id: "local-op-one",
        operation: shape.operation,
        payload: shape.payload,
        timeout_ms: 4_000,
        cleanup: false,
      },
    ],
    inputs: [
      {
        input_id: "package-input",
        role: "package-input",
        provenance_mode: "host_provisioned" as const,
        artifact,
      },
    ],
    resource_limits: localLimits(),
    egress_policy: localEgressPolicy(),
    allowed_capability_ids: [],
    allowed_credential_handle_ids: [],
    created_at: LOCAL_NOW,
    expires_at: LOCAL_LATER,
    not_scored: true as const,
    not_governor_authorized: true as const,
    unsupported_claims: [...LOCAL_CLAIMS],
    evidence_authenticity: "unauthenticated_local_record" as const,
  };
  return assertContract<LocalObservationPlanV1>("LocalObservationPlanV1", {
    ...base,
    core_hash: coreHash(base),
  });
}

export function localRequest(
  manifest: SubjectAdapterManifestV2,
  plan: LocalObservationPlanV1,
  shape: LocalFixtureShape,
): AdapterRequestV2 {
  const input = plan.inputs[0];
  if (input === undefined || input.provenance_mode !== "host_provisioned") throw new Error("fixture input absent");
  const base = {
    schema_version: "adapter-request/v2" as const,
    protocol_version: "subject-adapter/v2" as const,
    execution_id: LOCAL_RUN_ID,
    adapter_manifest_hash: manifest.core_hash,
    operation_id: "local-op-one",
    operation: shape.operation,
    ancestry: { sequence: 0, predecessor: null },
    deadline: "2026-08-12T18:00:05Z",
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
      input_artifact_refs: [input],
      egress_policy: plan.egress_policy,
      allowed_capability_ids: [],
      allowed_credential_handle_ids: [],
      not_scored: true as const,
      not_governor_authorized: true as const,
      unsupported_claims: [...LOCAL_CLAIMS],
    },
    operation_payload: shape.payload,
  };
  return assertContract<AdapterRequestV2>("AdapterRequestV2", {
    ...base,
    core_hash: coreHash(base),
  });
}

/**
 * One neutral adapter per honest residue answer.
 *
 * These are separate entry files rather than one configurable adapter because
 * the child environment is a closed four-name allowlist and the operation
 * payload is a closed object: there is deliberately no channel through which a
 * test could tell a running adapter what to report. Distinct behaviour needs
 * distinct certified bytes, which is the property under test.
 */
export const RESIDUE_SHAPES = {
  clean: "neutral-residue-clean-observer",
  detected: "neutral-residue-detected-observer",
  unknown: "neutral-residue-unknown-observer",
  contradictory: "neutral-residue-contradictory-observer",
} as const;

export function residueShape(
  kind: keyof typeof RESIDUE_SHAPES,
  checkpoint: "baseline" | "post_operation" | "final" = "final",
): LocalFixtureShape {
  return {
    adapterId: RESIDUE_SHAPES[kind],
    operation: "report-residue",
    packageKind: "archive",
    payload: { schema_version: "report-residue-payload/v1", checkpoint },
    entryName: `${RESIDUE_SHAPES[kind]}.mjs`,
  };
}

/**
 * One neutral adapter per stop verdict, for the same reason the residue shapes
 * are separate files: a running adapter cannot be told what to answer.
 */
export const LIFECYCLE_SHAPES = {
  succeeded: "neutral-lifecycle-stop-succeeded",
  failed: "neutral-lifecycle-stop-failed",
} as const;

const LIFECYCLE_OPERATIONS = ["start", "stop"] as const;

const LIFECYCLE_PAYLOADS = {
  start: { schema_version: "start-payload/v1", input_ids: ["package-input"] },
  stop: { schema_version: "stop-payload/v1", start_operation_id: "op-start" },
} as const;

export function lifecycleShape(kind: keyof typeof LIFECYCLE_SHAPES): LocalFixtureShape {
  return {
    adapterId: LIFECYCLE_SHAPES[kind],
    operation: "start",
    packageKind: "archive",
    payload: { ...LIFECYCLE_PAYLOADS.start },
    entryName: `${LIFECYCLE_SHAPES[kind]}.mjs`,
    certifiedOperations: [...LIFECYCLE_OPERATIONS],
  };
}

/**
 * A two-operation plan — `start`, then `stop` as the frozen cleanup suffix.
 *
 * The smallest sequence that reaches the reducer's authoritative "did this
 * operation succeed?" decision: `start` creates the obligation and `stop` is the
 * only operation that can discharge it.
 */
export function lifecycleFixture(kind: keyof typeof LIFECYCLE_SHAPES) {
  const shape = lifecycleShape(kind);
  const manifest = localManifest(shape);
  const receipt = localReceipt(manifest, shape);
  const onePlan = localPlan(manifest, receipt, shape);

  const specs = [
    { sequence: 0, operation_id: "op-start", operation: "start" as const, payload: { ...LIFECYCLE_PAYLOADS.start }, timeout_ms: 4_000, cleanup: false },
    { sequence: 1, operation_id: "op-stop", operation: "stop" as const, payload: { ...LIFECYCLE_PAYLOADS.stop }, timeout_ms: 4_000, cleanup: true },
  ];
  const planBase = { ...onePlan, operations: specs } as unknown as Record<string, unknown>;
  delete planBase["core_hash"];
  const plan = assertContract<LocalObservationPlanV1>("LocalObservationPlanV1", {
    ...planBase,
    core_hash: coreHash(planBase),
  });

  const oneRequest = localRequest(manifest, plan, shape);
  /**
   * `predecessor` is the real completed `start` record rather than a placeholder,
   * so the stop request the adapter answers is the one a coordinator would
   * actually have built at that cursor.
   */
  const request = (
    which: "start" | "stop",
    predecessor: Record<string, unknown> | null = null,
  ): AdapterRequestV2 => {
    const spec = specs[which === "start" ? 0 : 1];
    if (spec === undefined) throw new Error("lifecycle fixture operation missing");
    const base = {
      ...oneRequest,
      operation_id: spec.operation_id,
      operation: spec.operation,
      operation_payload: spec.payload,
      ancestry: { sequence: spec.sequence, predecessor },
      execution_context: { ...oneRequest.execution_context, observation_plan_hash: plan.core_hash },
    } as unknown as Record<string, unknown>;
    delete base["core_hash"];
    return assertContract<AdapterRequestV2>("AdapterRequestV2", { ...base, core_hash: coreHash(base) });
  };

  return { shape, manifest, receipt, plan, request };
}

export function newLocalLifecycleHost(kind: keyof typeof LIFECYCLE_SHAPES) {
  const fixture = lifecycleFixture(kind);
  const workspaceRoot = ownedTempDir("erl2-local-lifecycle-ws-");
  const storeRoot = ownedTempDir("erl2-local-lifecycle-store-");
  const host = new AdapterHost({
    runId: LOCAL_RUN_ID,
    adapterManifest: fixture.manifest,
    localAuthorityV2: { mode: "certified_external", receipt: fixture.receipt },
    localObservationPlan: fixture.plan,
    adapterEntryPath: localEntry(fixture.shape),
    workspaceRoot,
    store: new ArtifactStore(storeRoot),
    clock: new SteppingClock(LOCAL_NOW, 1000),
    wallClockMs: 10_000,
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
  });
  return { ...fixture, host, workspaceRoot, storeRoot };
}

export function localFixture(shape: LocalFixtureShape = ARCHIVE_SHAPE) {
  const manifest = localManifest(shape);
  const receipt = localReceipt(manifest, shape);
  const plan = localPlan(manifest, receipt, shape);
  const request = localRequest(manifest, plan, shape);
  return { manifest, receipt, plan, request };
}

export function newLocalHost(shape: LocalFixtureShape = ARCHIVE_SHAPE) {
  const fixture = localFixture(shape);
  const workspaceRoot = ownedTempDir("erl2-local-adapter-ws-");
  const storeRoot = ownedTempDir("erl2-local-adapter-store-");
  const host = new AdapterHost({
    runId: LOCAL_RUN_ID,
    adapterManifest: fixture.manifest,
    localAuthorityV2: { mode: "certified_external", receipt: fixture.receipt },
    localObservationPlan: fixture.plan,
    adapterEntryPath: localEntry(shape),
    workspaceRoot,
    store: new ArtifactStore(storeRoot),
    clock: new SteppingClock(LOCAL_NOW, 1000),
    wallClockMs: 10_000,
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
  });
  return { ...fixture, host, workspaceRoot, storeRoot };
}
