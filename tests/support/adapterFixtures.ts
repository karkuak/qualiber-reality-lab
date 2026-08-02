/**
 * Adapter fixtures: manifests, hosts and requests for the Slice 5 suites.
 *
 * The sabotage adapters under `fixtures/sabotage/adapters/` are plain ESM
 * scripts that speak the wire protocol directly and never import the SDK — an
 * adapter that misbehaves is precisely one that ignores the SDK, so testing the
 * host against SDK-shaped adapters would only prove the SDK works.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertContract,
  packageMediaType,
  type Hash,
  type PackageKind,
  type SubjectAdapterManifestV1,
} from "@erl2/contracts";
import { ArtifactStore, coreHash, developmentKey, sealSigned } from "@erl2/integrity";
import { AdapterHost, SteppingClock, type AdapterHostOptions, type AdapterMount } from "@erl2/core";
import { ownedTempDir } from "./tempDirs.js";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

export const RUN_START = "2026-07-01T00:00:00Z";

/** Absolute entry path of a compiled reference adapter. */
export type ReferenceAdapterId =
  | "reference-correct"
  | "reference-limited"
  | "reference-misleading"
  | "reference-inconclusive";

export function referenceAdapterEntry(id: ReferenceAdapterId): string {
  return path.join(repoRoot, "adapters", id, "dist", "src", "main.js");
}

/** Absolute path of a sabotage fixture adapter. */
export function sabotageAdapterEntry(name: string): string {
  return path.join(repoRoot, "fixtures", "sabotage", "adapters", `${name}.mjs`);
}

export interface AdapterManifestOptions {
  readonly adapterId: string;
  readonly version?: string;
  readonly operations?: readonly string[];
  readonly packageKinds?: readonly PackageKind[];
  readonly capabilities?: readonly string[];
  readonly protocolVersion?: string;
}

/** A signed, admissible adapter manifest. */
export function adapterManifest(options: AdapterManifestOptions): SubjectAdapterManifestV1 {
  return assertContract<SubjectAdapterManifestV1>(
    "SubjectAdapterManifestV1",
    sealSigned(
      {
        schema_version: "subject-adapter-manifest/v1" as const,
        adapter_id: options.adapterId,
        version: options.version ?? "0.1.0",
        protocol_version: (options.protocolVersion ?? "subject-adapter/v1") as "subject-adapter/v1",
        adapter_artifact_hash: coreHash({ artifact: options.adapterId }),
        supported_package_kinds: [...(options.packageKinds ?? ["archive"])],
        operations: [...(options.operations ?? ["acquire", "validate-package"])],
        required_broker_capabilities: [
          ...(options.capabilities ?? ["write-adapter-workspace", "write-run-output"]),
        ],
        network_allowlist_ids: [],
        projection_schema: "generic-claim-set/v1" as const,
        certification_receipt_hash: coreHash({ certification: options.adapterId }),
        owner: `${options.adapterId} owner`,
      },
      developmentKey("adapter-owner"),
    ),
  );
}

export const REFERENCE_CORRECT_MANIFEST = (): SubjectAdapterManifestV1 =>
  adapterManifest({
    adapterId: "reference-correct",
    operations: [
      "acquire",
      "validate-package",
      "install",
      "uninstall",
      "translate-evidence",
      "project",
      "report-residue",
      "compensate",
    ],
    packageKinds: ["archive"],
  });

export const REFERENCE_LIMITED_MANIFEST = (): SubjectAdapterManifestV1 =>
  adapterManifest({
    adapterId: "reference-limited",
    operations: ["acquire", "validate-package", "translate-evidence", "project", "report-residue"],
    packageKinds: ["oci"],
  });

export const REFERENCE_MISLEADING_MANIFEST = (): SubjectAdapterManifestV1 =>
  adapterManifest({
    adapterId: "reference-misleading",
    operations: ["acquire", "validate-package", "translate-evidence", "project", "report-residue"],
    packageKinds: ["archive"],
  });

export const REFERENCE_INCONCLUSIVE_MANIFEST = (): SubjectAdapterManifestV1 =>
  adapterManifest({
    adapterId: "reference-inconclusive",
    operations: ["acquire", "validate-package", "translate-evidence", "project", "report-residue"],
    packageKinds: ["archive"],
  });

const RUN_ID = "01890000-0000-7000-8000-00000000000d";

export interface HostFixture {
  readonly host: AdapterHost;
  readonly workspaceRoot: string;
  readonly storeRoot: string;
}

/** A host wired to a temporary workspace and artifact store. */
export function newHost(
  manifest: SubjectAdapterManifestV1,
  entryPath: string,
  overrides: Partial<AdapterHostOptions> = {},
): HostFixture {
  const workspaceRoot = ownedTempDir("erl2-adapter-ws-");
  const storeRoot = ownedTempDir("erl2-adapter-store-");
  const host = new AdapterHost({
    runId: RUN_ID,
    adapterManifest: manifest,
    adapterEntryPath: entryPath,
    workspaceRoot,
    store: new ArtifactStore(storeRoot),
    clock: new SteppingClock(RUN_START, 1000),
    wallClockMs: 20_000,
    ...overrides,
  });
  return { host, workspaceRoot, storeRoot };
}

export function mount(
  mountId: string,
  absolutePath: string,
  purpose: AdapterMount["purpose"] = "subject-visible-input",
): AdapterMount {
  return { mountId, absolutePath, logicalPath: `mounts/${mountId}`, purpose };
}

/** A structurally valid acquisition request. */
export function acquisitionRequest(
  operationId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = {
    schema_version: "acquisition-adapter-request/v1" as const,
    protocol_version: "subject-adapter/v1" as const,
    run_id: RUN_ID,
    operation_id: operationId,
    acquisition_preregistration_hash: `sha256:${"1".repeat(64)}` as Hash,
    acquisition_source_manifest_hash: `sha256:${"2".repeat(64)}` as Hash,
    adapter_manifest_hash: `sha256:${"3".repeat(64)}` as Hash,
    visible_step: {
      artifact: {
        path: `subject-visible/steps/${operationId}.json`,
        media_type: "application/json",
        byte_length: 2,
        file_sha256: `sha256:${"4".repeat(64)}`,
        classification: "PUBLIC" as const,
      },
      core_hash: `sha256:${"5".repeat(64)}` as Hash,
    },
    credential_handle_ids: [] as string[],
    resource_limit_hash: `sha256:${"6".repeat(64)}` as Hash,
    deadline: "2030-01-01T00:00:00Z",
    ...extra,
  };
  return { ...base, core_hash: coreHash(base) };
}

/** A structurally valid package-verification request for one package kind. */
export function packageVerificationRequest(
  operationId: string,
  kind: PackageKind = "archive",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = {
    schema_version: "package-verification-request/v1" as const,
    protocol_version: "subject-adapter/v1" as const,
    run_id: RUN_ID,
    operation_id: operationId,
    acquisition_preregistration_hash: `sha256:${"1".repeat(64)}` as Hash,
    acquisition_record_hash: `sha256:${"2".repeat(64)}` as Hash,
    frozen_acquired_artifact: {
      path: `retained/package-store/sha256/${"7".repeat(64)}.bin`,
      media_type: packageMediaType(kind),
      byte_length: 8,
      file_sha256: `sha256:${"7".repeat(64)}`,
      classification: "INTERNAL" as const,
    },
    frozen_package_file_sha256: `sha256:${"7".repeat(64)}` as Hash,
    integrity_policy_hash: `sha256:${"8".repeat(64)}` as Hash,
    provenance_policy_hash: `sha256:${"9".repeat(64)}` as Hash,
    adapter_manifest_hash: `sha256:${"3".repeat(64)}` as Hash,
    visible_step: {
      artifact: {
        path: `subject-visible/steps/${operationId}.json`,
        media_type: "application/json",
        byte_length: 2,
        file_sha256: `sha256:${"4".repeat(64)}`,
        classification: "PUBLIC" as const,
      },
      core_hash: `sha256:${"5".repeat(64)}` as Hash,
    },
    deadline: "2030-01-01T00:00:00Z",
    ...extra,
  };
  return { ...base, core_hash: coreHash(base) };
}

/** A structurally valid post-plan step request. */
export function stepRequest(
  operationId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = {
    schema_version: "adapter-step-request/v1" as const,
    protocol_version: "subject-adapter/v1" as const,
    run_id: RUN_ID,
    operation_id: operationId,
    execution_plan_hash: `sha256:${"e".repeat(64)}` as Hash,
    visible_step: {
      artifact: {
        path: `subject-visible/steps/${operationId}.json`,
        media_type: "application/json",
        byte_length: 2,
        file_sha256: `sha256:${"4".repeat(64)}`,
        classification: "PUBLIC" as const,
      },
      core_hash: `sha256:${"5".repeat(64)}` as Hash,
    },
    prior_visible_interaction_hashes: [] as Hash[],
    credential_handle_ids: [] as string[],
    resource_limit_hash: `sha256:${"6".repeat(64)}` as Hash,
    deadline: "2030-01-01T00:00:00Z",
    ...extra,
  };
  return { ...base, core_hash: coreHash(base) };
}

export { RUN_ID };
