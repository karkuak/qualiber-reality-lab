/**
 * Neutral fixtures for the owner-operated trusted-local path.
 *
 * Everything here is product-free: one neutral observer that answers every
 * operation in the closed set, a manifest that declares it, an owner
 * declaration over its exact bytes, and plans built from those three. No
 * certification receipt is constructed anywhere in this file, and none can be
 * substituted — the trusted-local contracts and the receipt contracts have
 * disjoint required fields.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertContract,
  type AdapterOperation,
  type LocalObservationTrustedLocalPlanV1,
  type SubjectAdapterManifestV2,
  type TrustedLocalAdapterDeclarationV1,
} from "@erl2/contracts";
import { coreHash, developmentKey, hashBytes, sealSigned } from "@erl2/integrity";
import { TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN } from "@erl2/core";
import { LOCAL_CLAIMS, LOCAL_LATER, LOCAL_NOW, LOCAL_RUN_ID } from "./localObservationFixtures.js";
import { repoRoot } from "./adapterFixtures.js";

export const TRUSTED_LOCAL_ADAPTER_ID = "neutral-full-lifecycle-observer";
export const TRUSTED_LOCAL_OWNER = "neutral fixture owner";

/**
 * The one host-provisioned input every default fixture plan declares.
 *
 * Real bytes with a real digest, not a placeholder. The plan's ArtifactRef is
 * derived from these constants rather than typed, so the fixture cannot drift
 * into declaring a digest nothing on disk has — which is precisely the state
 * the materializer exists to refuse, and a fixture that could reach it would
 * be testing the refusal rather than the path.
 */
export const TRUSTED_LOCAL_INPUT_ID = "package-input";
export const TRUSTED_LOCAL_INPUT_MOUNT = "package-mount";
export const TRUSTED_LOCAL_INPUT_RELATIVE = "package.bin";
export const TRUSTED_LOCAL_INPUT_BYTES = Buffer.from(
  "neutral trusted-local bound input\n",
  "utf8",
);

/** `<input_root>/<mount_id>/<relative-file-path>`, the only convention the runner reads. */
export function trustedLocalInputLogicalPath(
  mountId: string = TRUSTED_LOCAL_INPUT_MOUNT,
  relativePath: string = TRUSTED_LOCAL_INPUT_RELATIVE,
): string {
  return `${trustedLocalLimits().input_root}/${mountId}/${relativePath}`;
}

/** A host-provisioned plan input over exact bytes the caller also writes to disk. */
export function trustedLocalPlanInput(options: {
  readonly inputId?: string;
  readonly mountId?: string;
  readonly relativePath?: string;
  readonly bytes?: Buffer;
  readonly logicalPath?: string;
  readonly byteLength?: number;
  readonly fileSha256?: string;
}): LocalObservationTrustedLocalPlanV1["inputs"][number] {
  const bytes = options.bytes ?? TRUSTED_LOCAL_INPUT_BYTES;
  return {
    input_id: options.inputId ?? TRUSTED_LOCAL_INPUT_ID,
    role: "package-input",
    provenance_mode: "host_provisioned" as const,
    artifact: {
      path:
        options.logicalPath ??
        trustedLocalInputLogicalPath(options.mountId, options.relativePath),
      media_type: "application/octet-stream",
      byte_length: options.byteLength ?? bytes.byteLength,
      file_sha256: (options.fileSha256 ?? hashBytes(bytes)) as `sha256:${string}`,
      classification: "INTERNAL" as const,
    },
  };
}

/**
 * Controls this fixture's manifest requires.
 *
 * Only controls the `local-process` profile genuinely enforces, so the fixture
 * proves the honest case rather than relying on the plan's waiver. The waiver
 * path has its own case.
 */
export const TRUSTED_LOCAL_CONTROLS = [
  "separate-process",
  "process-tree-termination",
  "wall-clock-deadline",
  "bounded-request-bytes",
  "bounded-response-bytes",
  "writable-output-only",
  "environment-variable-allowlist",
  "bounded-diagnostics",
] as const;

/** The exact eleven operations the external subject profile under test declares. */
export const ELEVEN_OPERATION_PROFILE: readonly AdapterOperation[] = [
  "acquire",
  "validate-package",
  "install",
  "configure",
  "start",
  "interact",
  "uninstall",
  "translate-evidence",
  "project",
  "report-residue",
  "compensate",
];

/**
 * Every operation the neutral observer answers, **in the order the adapter
 * negotiates them**.
 *
 * `AdapterHost` compares the negotiated operation list against the profile's
 * positionally, not as a set, and the SDK negotiates `Object.keys(handlers)`.
 * So a manifest whose operations are the right thirteen in a different order
 * is refused — and refused as "the adapter process ended without a valid
 * response", which names the symptom rather than the cause. This ordering is
 * kept identical to the fixture's handler declaration order for that reason.
 */
export const ALL_OPERATIONS: readonly AdapterOperation[] = [
  "acquire",
  "validate-package",
  "install",
  "configure",
  "start",
  "interact",
  "translate-evidence",
  "collect-outputs",
  "project",
  "stop",
  "uninstall",
  "compensate",
  "report-residue",
];

/**
 * Which neutral observer a fixture set is built around.
 *
 * `input-reader` is the one that proves the mount: it reads its bound inputs
 * back through the SDK and reports the digests it observed, so a case can
 * assert on what the adapter saw rather than on what the host says it wrote.
 */
export type TrustedLocalFixtureName = "full-lifecycle" | "fault" | "input-reader";

const FIXTURE_ENTRY: Readonly<Record<TrustedLocalFixtureName, string>> = {
  "full-lifecycle": "neutral-full-lifecycle-observer.mjs",
  fault: "neutral-fault-observer.mjs",
  "input-reader": "neutral-input-reading-observer.mjs",
};

const FIXTURE_ADAPTER_ID: Readonly<Record<TrustedLocalFixtureName, string>> = {
  "full-lifecycle": TRUSTED_LOCAL_ADAPTER_ID,
  fault: "neutral-fault-observer",
  "input-reader": "neutral-input-reading-observer",
};

export function trustedLocalEntry(
  fixture: TrustedLocalFixtureName = "full-lifecycle",
): string {
  return path.join(repoRoot, "fixtures", "neutral", FIXTURE_ENTRY[fixture]);
}

/** The fault observer's handlers, in its own negotiation order. */
export const FAULT_OPERATIONS: readonly AdapterOperation[] = [
  "acquire",
  "translate-evidence",
  "report-residue",
];

/** The input-reading observer's handlers, in its own negotiation order. */
export const INPUT_READER_OPERATIONS: readonly AdapterOperation[] = [
  "acquire",
  "translate-evidence",
  "report-residue",
];

/**
 * Three operations that reach a clean terminal without an obligation.
 *
 * No `start` and no `install`, so nothing has to be discharged, and a final
 * `report-residue` answering `clean` is the whole cleanup story. That keeps
 * every input case about the inputs.
 */
export const INPUT_READER_PLAN: readonly PlanOperationSpec[] = [
  { operation: "acquire", cleanup: false },
  { operation: "translate-evidence", cleanup: false },
  { operation: "report-residue", cleanup: true },
];

export function trustedLocalManifest(
  operations: readonly AdapterOperation[] = ALL_OPERATIONS,
  fixture: TrustedLocalFixtureName = "full-lifecycle",
): SubjectAdapterManifestV2 {
  return assertContract<SubjectAdapterManifestV2>(
    "SubjectAdapterManifestV2",
    sealSigned(
      {
        schema_version: "subject-adapter-manifest/v2" as const,
        adapter_id: FIXTURE_ADAPTER_ID[fixture],
        version: "1.0.0",
        adapter_artifact_hash: hashBytes(readFileSync(trustedLocalEntry(fixture))),
        protocol_support: [
          {
            protocol_version: "subject-adapter/v2" as const,
            execution_modes: ["local_observation"] as const,
            operations: [...operations],
            supported_package_kinds: ["archive" as const],
            required_controls: [...TRUSTED_LOCAL_CONTROLS],
          },
        ],
        required_broker_capabilities: [],
        network_allowlist_ids: [],
        certification_receipt_hash: `sha256:${"0".repeat(64)}`,
        owner: TRUSTED_LOCAL_OWNER,
      },
      developmentKey("neutral-trusted-local-owner"),
    ),
  );
}

export function trustedLocalDeclaration(
  manifest: SubjectAdapterManifestV2,
  manifestBytes: Buffer,
  overrides: Partial<TrustedLocalAdapterDeclarationV1> = {},
): TrustedLocalAdapterDeclarationV1 {
  const base = {
    schema_version: "trusted-local-adapter-declaration/v1" as const,
    declaration_id: "neutral-trusted-local-declaration",
    adapter_id: manifest.adapter_id,
    adapter_owner: manifest.owner,
    protocol_version: "subject-adapter/v2" as const,
    subject_execution_mode: "local_observation" as const,
    trust_mode: "trusted_local_code" as const,
    tier: "development" as const,
    adapter_artifact_hash: manifest.adapter_artifact_hash,
    adapter_manifest_file_hash: hashBytes(manifestBytes),
    adapter_manifest_core_hash: manifest.core_hash,
    adapter_source: null,
    operator_acknowledgement: {
      acknowledgement_token: TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN,
      acknowledged_artifact_hash: manifest.adapter_artifact_hash,
      acknowledged_manifest_core_hash: manifest.core_hash,
      adapter_code_is_not_confined: true as const,
      adapter_runs_with_operator_user_permissions: true as const,
      adapter_is_not_independently_certified: true as const,
      results_are_development_only: true as const,
      results_are_unscored: true as const,
      results_are_unauthenticated: true as const,
      acknowledged_by: "neutral fixture operator",
      acknowledged_at: LOCAL_NOW,
    },
    independent_certifier: null,
    certifier_is_adapter_owner: "not_applicable" as const,
    owner_test_evidence: null,
    excluded_claims: [...LOCAL_CLAIMS],
    not_scored: true as const,
    not_governor_authorized: true as const,
    not_independently_certified: true as const,
    not_confined: true as const,
    not_production_ready: true as const,
    evidence_authenticity: "owner_asserted_unauthenticated" as const,
    created_at: LOCAL_NOW,
    ...overrides,
  };
  return assertContract<TrustedLocalAdapterDeclarationV1>(
    "TrustedLocalAdapterDeclarationV1",
    { ...base, core_hash: coreHash(base) },
  );
}

export function trustedLocalLimits(): LocalObservationTrustedLocalPlanV1["resource_limits"] {
  const base = {
    schema_version: "local-observation-limits/v1" as const,
    wall_clock_ms: 20_000,
    max_request_bytes: 256 * 1024,
    max_response_bytes: 256 * 1024,
    max_output_files: 32,
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
      { control_id: "separate-process" as const, required_state: "enforced" as const },
      { control_id: "process-tree-termination" as const, required_state: "enforced" as const },
      { control_id: "wall-clock-deadline" as const, required_state: "enforced" as const },
      { control_id: "deny-by-default-egress" as const, required_state: "unsupported_permitted" as const },
    ],
  };
  return { ...base, core_hash: coreHash(base) } as LocalObservationTrustedLocalPlanV1["resource_limits"];
}

export function trustedLocalEgressPolicy(): LocalObservationTrustedLocalPlanV1["egress_policy"] {
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
  return { ...base, core_hash: coreHash(base) } as LocalObservationTrustedLocalPlanV1["egress_policy"];
}

/** A neutral payload for every operation, correlated with its closed schema. */
export function payloadFor(operation: AdapterOperation): Record<string, unknown> {
  switch (operation) {
    case "acquire":
      return {
        schema_version: "acquire-payload/v1",
        provenance_mode: "acquired",
        source_descriptor_input_id: "package-input",
        output_input_id: "package-output",
        expected_package_kind: "archive",
        credential_handle_ids: [],
      };
    case "validate-package":
      return {
        schema_version: "validate-package-payload/v1",
        package_input_id: "package-input",
        package_kind: "archive",
      };
    case "install":
      return { schema_version: "install-payload/v1", package_input_id: "package-input" };
    case "configure":
      return { schema_version: "configure-payload/v1", configuration_input_ids: [] };
    case "start":
      return { schema_version: "start-payload/v1", input_ids: [] };
    case "interact":
      return { schema_version: "interact-payload/v1", interaction_input_ids: [] };
    case "translate-evidence":
      return {
        schema_version: "translate-evidence-payload/v1",
        evidence_input_ids: [],
        evidence_mount_handle_id: "evidence-mount",
      };
    case "collect-outputs":
      return { schema_version: "collect-outputs-payload/v1", requested_output_role_ids: [] };
    case "project":
      return {
        schema_version: "project-payload/v1",
        evidence_input_ids: [],
        projection_schema: "local-draft-v1",
      };
    case "stop":
      return { schema_version: "stop-payload/v1", start_operation_id: "op-start" };
    case "uninstall":
      return { schema_version: "uninstall-payload/v1", install_operation_id: "op-install" };
    case "report-residue":
      return { schema_version: "report-residue-payload/v1", checkpoint: "final" };
    case "compensate":
      // At least one receipt hash: the contract will not describe a
      // compensation that reverses nothing.
      return {
        schema_version: "compensate-payload/v1",
        mutation_receipt_hashes: [`sha256:${"f".repeat(64)}`],
      };
    default:
      throw new Error(`no neutral payload for ${operation}`);
  }
}

export interface PlanOperationSpec {
  readonly operation: AdapterOperation;
  readonly cleanup: boolean;
}

/** Each observer's own negotiation order, which its manifest must match positionally. */
const DEFAULT_FIXTURE_OPERATIONS: Readonly<
  Record<TrustedLocalFixtureName, readonly AdapterOperation[]>
> = {
  "full-lifecycle": ALL_OPERATIONS,
  fault: FAULT_OPERATIONS,
  "input-reader": INPUT_READER_OPERATIONS,
};

export function trustedLocalPlan(
  manifest: SubjectAdapterManifestV2,
  declaration: TrustedLocalAdapterDeclarationV1,
  operations: readonly PlanOperationSpec[],
  overrides: Partial<LocalObservationTrustedLocalPlanV1> = {},
): LocalObservationTrustedLocalPlanV1 {
  const base = {
    schema_version: "local-observation-plan/v1" as const,
    observation_id: LOCAL_RUN_ID,
    mode: "local_observation" as const,
    protocol_version: "subject-adapter/v2" as const,
    adapter_id: manifest.adapter_id,
    adapter_version: manifest.version,
    adapter_manifest_hash: manifest.core_hash,
    trusted_local_declaration_hash: declaration.core_hash,
    trust_mode: "trusted_local_code" as const,
    adapter_artifact_hash: manifest.adapter_artifact_hash,
    operations: operations.map((spec, sequence) => ({
      sequence,
      operation_id: `op-${spec.operation}`,
      operation: spec.operation,
      payload: payloadFor(spec.operation),
      timeout_ms: 15_000,
      cleanup: spec.cleanup,
    })),
    inputs: [trustedLocalPlanInput({})],
    resource_limits: trustedLocalLimits(),
    egress_policy: trustedLocalEgressPolicy(),
    allowed_capability_ids: [],
    allowed_credential_handle_ids: [],
    created_at: LOCAL_NOW,
    expires_at: LOCAL_LATER,
    not_scored: true as const,
    not_governor_authorized: true as const,
    unsupported_claims: [...LOCAL_CLAIMS],
    evidence_authenticity: "unauthenticated_local_record" as const,
    ...overrides,
  };
  return assertContract<LocalObservationTrustedLocalPlanV1>(
    "LocalObservationTrustedLocalPlanV1",
    { ...base, core_hash: coreHash(base) },
  );
}

/**
 * Eleven operations that reach a clean terminal.
 *
 * A successful `start` creates a stop obligation, so a clean terminal needs
 * `stop` in the plan; the eleven-operation profile that omits it is covered
 * separately, and its incomplete terminal is the honest answer rather than a
 * fixture defect.
 */
export const ELEVEN_OPERATION_CLEAN_PLAN: readonly PlanOperationSpec[] = [
  { operation: "acquire", cleanup: false },
  { operation: "validate-package", cleanup: false },
  { operation: "install", cleanup: false },
  { operation: "configure", cleanup: false },
  { operation: "start", cleanup: false },
  { operation: "interact", cleanup: false },
  { operation: "translate-evidence", cleanup: false },
  { operation: "project", cleanup: false },
  { operation: "stop", cleanup: true },
  { operation: "uninstall", cleanup: true },
  { operation: "report-residue", cleanup: true },
];

/** The exact eleven-operation profile, ordered so its cleanup suffix is contiguous. */
export const ELEVEN_OPERATION_PROFILE_PLAN: readonly PlanOperationSpec[] = [
  { operation: "acquire", cleanup: false },
  { operation: "validate-package", cleanup: false },
  { operation: "install", cleanup: false },
  { operation: "configure", cleanup: false },
  { operation: "start", cleanup: false },
  { operation: "interact", cleanup: false },
  { operation: "translate-evidence", cleanup: false },
  { operation: "project", cleanup: false },
  { operation: "uninstall", cleanup: true },
  { operation: "compensate", cleanup: true },
  { operation: "report-residue", cleanup: true },
];

export interface WrittenTrustedLocalInputs {
  readonly entryPath: string;
  readonly manifestPath: string;
  readonly declarationPath: string;
  readonly planPath: string;
  readonly outputRoot: string;
  readonly manifest: SubjectAdapterManifestV2;
  readonly declaration: TrustedLocalAdapterDeclarationV1;
  readonly plan: LocalObservationTrustedLocalPlanV1;
  /**
   * `--bind-input` pairs for exactly the plan's host-provisioned inputs.
   *
   * Spread into the argv rather than assembled at each call site, so a case
   * that is about something else cannot quietly stop binding an input and pass
   * for the wrong reason.
   */
  readonly bindArgs: readonly string[];
  /** Absolute source paths, by input id, for cases that want to tamper with one. */
  readonly boundSources: ReadonlyMap<string, string>;
}

/** Serializes a complete input set into a caller-owned temporary directory. */
export function writeTrustedLocalInputs(
  root: string,
  operations: readonly PlanOperationSpec[] = ELEVEN_OPERATION_CLEAN_PLAN,
  options: {
    readonly manifestOperations?: readonly AdapterOperation[];
    readonly declarationOverrides?: Partial<TrustedLocalAdapterDeclarationV1>;
    readonly planOverrides?: Partial<LocalObservationTrustedLocalPlanV1>;
    readonly fixture?: TrustedLocalFixtureName;
    /**
     * Bytes to write for each host-provisioned input, by input id.
     *
     * Defaults to the exact bytes the plan's ArtifactRef was derived from. A
     * case that wants a digest or length mismatch supplies different bytes
     * here and leaves the plan alone.
     */
    readonly sourceBytes?: ReadonlyMap<string, Buffer>;
  } = {},
): WrittenTrustedLocalInputs {
  mkdirSync(root, { recursive: true });
  const fixture = options.fixture ?? "full-lifecycle";
  const manifest = trustedLocalManifest(
    options.manifestOperations ?? DEFAULT_FIXTURE_OPERATIONS[fixture],
    fixture,
  );
  const manifestBytes = json(manifest);
  const manifestPath = path.join(root, "adapter-manifest.v2.json");
  writeFileSync(manifestPath, manifestBytes);

  const declaration = trustedLocalDeclaration(
    manifest,
    manifestBytes,
    options.declarationOverrides,
  );
  const declarationPath = path.join(root, "trusted-local-declaration.v1.json");
  writeFileSync(declarationPath, json(declaration));

  const plan = trustedLocalPlan(manifest, declaration, operations, options.planOverrides);
  const planPath = path.join(root, "observation-plan.json");
  writeFileSync(planPath, json(plan));

  // The sources live beside the plan and outside the run's output root, which
  // is where an operator's own fixtures would be and where the runner insists
  // they are.
  const sourceRoot = path.join(root, "bound-sources");
  mkdirSync(sourceRoot, { recursive: true });
  const bindArgs: string[] = [];
  const boundSources = new Map<string, string>();
  for (const input of plan.inputs) {
    if (input.provenance_mode !== "host_provisioned") continue;
    const source = path.join(sourceRoot, `${input.input_id}.bin`);
    writeFileSync(source, options.sourceBytes?.get(input.input_id) ?? TRUSTED_LOCAL_INPUT_BYTES);
    boundSources.set(input.input_id, source);
    bindArgs.push("--bind-input", `${input.input_id}=${source}`);
  }

  return {
    entryPath: trustedLocalEntry(fixture),
    manifestPath,
    declarationPath,
    planPath,
    outputRoot: path.join(root, "run-output"),
    manifest,
    declaration,
    plan,
    bindArgs,
    boundSources,
  };
}

export function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Re-seals an object after a mutation, so a forgery fails on meaning not on hash. */
export function reseal<T extends { readonly core_hash: string }>(value: T): T {
  const base = { ...(value as Record<string, unknown>) };
  delete base["core_hash"];
  return { ...base, core_hash: coreHash(base) } as unknown as T;
}
