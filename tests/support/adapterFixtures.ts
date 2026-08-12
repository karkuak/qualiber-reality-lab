/**
 * Adapter fixtures: manifests, hosts and requests for the Slice 5 suites.
 *
 * The sabotage adapters under `fixtures/sabotage/adapters/` are plain ESM
 * scripts that speak the wire protocol directly and never import the SDK — an
 * adapter that misbehaves is precisely one that ignores the SDK, so testing the
 * host against SDK-shaped adapters would only prove the SDK works.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertContract,
  packageMediaType,
  type Hash,
  type PackageKind,
  type SubjectAdapterCertificationReceiptV1,
  type SubjectAdapterManifestV1,
} from "@erl2/contracts";
import { ArtifactStore, coreHash, developmentKey, hashBytes, sealSigned } from "@erl2/integrity";
import {
  AdapterHost,
  BOOTSTRAP_RECEIPT_SENTINEL,
  SteppingClock,
  type AdapterHostOptions,
  type AdapterMount,
} from "@erl2/core";
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
  | "reference-inconclusive"
  | "reference-otel-demo";

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
  /**
   * The adapter's real entry digest.
   *
   * Most fixtures never execute the bytes they name, so the default is a
   * synthetic hash derived from the id. A manifest that is going to be
   * *certified and admitted*, though, must declare the digest of the file that
   * will actually run: admission requires the manifest, the receipt and the
   * bytes on disk to agree, and a synthetic hash cannot satisfy that.
   */
  readonly artifactHash?: Hash;
  /**
   * A prior certification receipt, or the bootstrap sentinel when there is
   * none. Never the receipt that certifies this manifest — that is a cycle.
   */
  readonly certificationReceiptHash?: Hash;
}

/** The digest of a compiled reference adapter's entry, as it is on disk. */
export function referenceAdapterEntryDigest(id: ReferenceAdapterId): Hash {
  return hashBytes(readFileSync(referenceAdapterEntry(id)));
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
        adapter_artifact_hash: options.artifactHash ?? coreHash({ artifact: options.adapterId }),
        supported_package_kinds: [...(options.packageKinds ?? ["archive"])],
        operations: [...(options.operations ?? ["acquire", "validate-package"])],
        required_broker_capabilities: [
          ...(options.capabilities ?? ["write-adapter-workspace", "write-run-output"]),
        ],
        network_allowlist_ids: [],
        projection_schema: "generic-claim-set/v1" as const,
        certification_receipt_hash:
          options.certificationReceiptHash ?? coreHash({ certification: options.adapterId }),
        owner: `${options.adapterId} owner`,
      },
      developmentKey("adapter-owner"),
    ),
  );
}

/**
 * The three dispatchable reference adapters name the digest of the file that
 * really runs and declare no prior receipt, because they are certified and
 * admitted and admission requires manifest, receipt and bytes to agree. Every
 * other fixture keeps the synthetic default: it is never dispatched, and giving
 * it a real digest would couple an unrelated fixture to a build artifact.
 */
export const REFERENCE_CORRECT_MANIFEST = (): SubjectAdapterManifestV1 =>
  adapterManifest({
    adapterId: "reference-correct",
    artifactHash: referenceAdapterEntryDigest("reference-correct"),
    certificationReceiptHash: BOOTSTRAP_RECEIPT_SENTINEL,
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

/**
 * The environment-interacting reference subject (ERL2-OQ-005).
 *
 * It declares `configure`, `start` and `interact` because it really performs
 * them against a real endpoint; the other reference adapters declare none of the
 * three and answer `unsupported` for them, which is the honest difference
 * between a subject that touches the environment and one that does not.
 */
export const REFERENCE_OTEL_DEMO_MANIFEST = (): SubjectAdapterManifestV1 =>
  adapterManifest({
    adapterId: "reference-otel-demo",
    artifactHash: referenceAdapterEntryDigest("reference-otel-demo"),
    certificationReceiptHash: BOOTSTRAP_RECEIPT_SENTINEL,
    operations: [
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
    ],
    packageKinds: ["archive"],
  });

export const REFERENCE_LIMITED_MANIFEST = (): SubjectAdapterManifestV1 =>
  adapterManifest({
    adapterId: "reference-limited",
    artifactHash: referenceAdapterEntryDigest("reference-limited"),
    certificationReceiptHash: BOOTSTRAP_RECEIPT_SENTINEL,
    operations: ["acquire", "validate-package", "translate-evidence", "project", "report-residue"],
    packageKinds: ["oci"],
  });

/**
 * A manifest and a *certified* receipt for a sabotage fixture.
 *
 * Certification is not a promise of good behaviour. An adapter can pass
 * `ADAPTER-CERT-V1` and still hang, crash or lie on a later operation, and the
 * host's runtime controls — deadlines, process-tree termination, identity and
 * response adjudication — are what answer that. Proving they still fire needs
 * an adapter that is *legitimately admitted* and then misbehaves.
 *
 * `certifyAdapter` cannot produce this receipt: it would run the suite against
 * the fixture and refuse it, which is correct and is exactly why the receipt is
 * built by hand here. It carries the fixture's real entry digest, so admission
 * accepts it on the same terms as any other — nothing about the admission path
 * is weakened to let it through.
 *
 * Test and evidence fixtures only. Nothing in `packages/` builds one.
 */
export function certifiedSabotageAdapter(
  name: string,
  options: { readonly adapterId: string; readonly operations?: readonly string[] },
): {
  readonly manifest: SubjectAdapterManifestV1;
  readonly receipt: SubjectAdapterCertificationReceiptV1;
} {
  const entryPath = sabotageAdapterEntry(name);
  const manifest = adapterManifest({
    adapterId: options.adapterId,
    artifactHash: hashBytes(readFileSync(entryPath)),
    certificationReceiptHash: BOOTSTRAP_RECEIPT_SENTINEL,
    ...(options.operations === undefined ? {} : { operations: options.operations }),
  });
  return { manifest, receipt: syntheticCertificationReceipt(manifest, entryPath) };
}

/**
 * A `certified` receipt for a manifest whose declared digest is the real entry.
 *
 * Built rather than measured, for fixtures where running `ADAPTER-CERT-V1`
 * would be circular (a sabotage fixture it must refuse) or would couple a
 * Docker-gated end-to-end test to an eight-spawn certification run. It is
 * accepted by admission on exactly the same terms as a measured receipt —
 * nothing in the admission path is relaxed for it — and it is a *fixture*, not
 * a certification: it asserts nothing about the adapter's behaviour.
 */
export function syntheticCertificationReceipt(
  manifest: SubjectAdapterManifestV1,
  entryPath: string,
  options: {
    readonly receiptId?: string;
    readonly verdict?: "certified" | "refused";
    readonly refusalCodes?: readonly string[];
  } = {},
): SubjectAdapterCertificationReceiptV1 {
  const entryDigest = hashBytes(readFileSync(entryPath));
  const body = {
    schema_version: "subject-adapter-certification-receipt/v1" as const,
    receipt_id: options.receiptId ?? `cert-${manifest.adapter_id}`,
    suite: "ADAPTER-CERT-V1" as const,
    adapter_manifest_hash: manifest.core_hash,
    adapter_artifact_hash: entryDigest,
    adapter_id: manifest.adapter_id,
    adapter_version: manifest.version,
    certified_operations: [...manifest.operations],
    certified_package_kinds: [...manifest.supported_package_kinds],
    checks: [
      {
        check_id: "immutable-artifact-identity",
        status: "passed" as const,
        severity: "info" as const,
        detail: "fixture receipt, certified by construction",
      },
    ],
    verdict: (options.verdict ?? "certified") as "certified" | "refused",
    refusal_codes: [...(options.refusalCodes ?? [])],
    certifier_id: "erl2-certifier",
    certifier_is_adapter_owner: false as const,
    enforced_controls: [],
    unsupported_controls: [],
    certified_at: RUN_START,
  };
  return { ...body, core_hash: coreHash(body) } as SubjectAdapterCertificationReceiptV1;
}

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
