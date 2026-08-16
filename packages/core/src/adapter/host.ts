/**
 * The core-owned adapter host (design v2 §11.2, implementation plan §11.1).
 *
 * The host — not the adapter — owns every boundary:
 *
 *   - exact executable identity: the entry file's digest is pinned in the
 *     invocation manifest and re-read on every launch;
 *   - one fixed protocol version, negotiated once and refused on mismatch;
 *   - bounded request and response frames, checked before parsing;
 *   - a deterministic deadline and process-*tree* termination;
 *   - read-only subject-visible inputs, verified unchanged after the call;
 *   - a single writable run-scoped output directory;
 *   - a deny-by-default environment (no HOME, no proxy, no credentials);
 *   - capability, credential and egress adjudication with receipts;
 *   - a mutation ledger requiring intent, receipt and compensation;
 *   - capped, scanned, redacted stdout/stderr;
 *   - crash-safe reconciliation and idempotent resume.
 *
 * Failures here are typed **adapter** or **Lab** outcomes. A broken, hostile or
 * absent adapter never produces a subject finding, because the subject did not
 * author the adapter.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_LOCAL_EXECUTION_MODE,
  ADAPTER_PROTOCOL_VERSION,
  ADAPTER_PROTOCOL_VERSION_V2,
  assertLocalObservationClaimExclusions,
  assertNoLocalObservationGovernedFields,
  assertContract,
  CODES,
  decodeFrame,
  encodeFrame,
  Erl2Error,
  type AdapterCapabilityGrantV1,
  type AdapterFailureReportV1,
  type AdapterOperation,
  type AdapterOperationId,
  type AdapterPackageKind,
  type AdapterProtocolNegotiationV1,
  type AdapterProtocolNegotiationV2,
  type AdapterRequestV2,
  type AdapterResponseEnvelopeV1,
  type AdapterResponseEnvelopeV2,
  type AdapterResponseMessage,
  type AdapterResponseMessageV2,
  type ArtifactRef,
  type CompensationReceiptV1,
  type CredentialUseReceiptV1,
  type EgressAllowlistPolicyV1,
  type EgressDecisionReceiptV1,
  type Hash,
  type HostOperationMessage,
  type HostOperationMessageV2,
  type Instant,
  type MutationIntentV1,
  type MutationReceiptV1,
  type SandboxInvocationManifestV1,
  type SandboxInvocationManifestV2,
  type SandboxInvocationResultV1,
  type SubjectAdapterManifestV1,
  type LocalResidueObservationDraft,
  type SubjectAdapterManifestV2,
  type LocalObservationLimitsV1,
  type LocalObservationCertifiedPlanV1,
  type LocalObservationPlanV1,
  type SubjectDiagnosticsManifestV1,
} from "@erl2/contracts";
import { ArtifactStore, coreHash, hashBytes } from "@erl2/integrity";
import type { Clock } from "../runtime/seams.js";
import { assertNoOracleFields } from "../journey/oracle.js";
import type {
  SubjectProducedArtifact,
  SubjectStepEvidence,
} from "../journey/subjectPort.js";
import {
  assertManifestCapabilitiesUnprivileged,
  grantCapabilities,
  isPrivilegedCapability,
  privilegedRefusal,
} from "./capabilities.js";
import { assertEntryDigestUnchanged } from "./admission.js";
import { verifyLocalAdapterCertificationV2 } from "./admission.js";
import {
  assertTrustedLocalControls,
  verifyTrustedLocalAdapterDeclaration,
  type LocalAdapterAuthorityV2,
} from "./trustedLocal.js";
import { CredentialBroker } from "./credentials.js";
import { decideEgress, denyByDefaultEgressPolicy } from "./egress.js";
import { MutationLedger } from "./mutations.js";
import {
  assertAdapterResponseShape,
  assertAdapterResponseShapeV2,
  assertLocalResidueObservationDraft,
} from "./responseShape.js";
import {
  adapterOutputPrefix,
  assertNoExecutionAfterOutputFreeze,
  DEFAULT_OUTPUT_BOUNDS,
  freezeAdapterOutput,
  freezeDiagnostics,
  scanBytes,
  type OutputBounds,
} from "./outputFreezer.js";
import {
  assertControlReportMatchesProfile,
  assertEnvironmentAllowlisted,
  assertMountPermitted,
  assertSandboxProfileEnabled,
  containerSubstrateLockHash,
  ALLOWED_ENVIRONMENT_VARIABLE_NAMES,
  LOCAL_OBSERVATION_ENVIRONMENT_VARIABLE_NAMES,
  sandboxControlReport,
  type ContainerProfileActivation,
  type SandboxProfileId,
} from "./sandbox.js";
import {
  CONTAINER_APP_ROOT,
  CONTAINER_DIAGNOSTICS_ROOT,
  CONTAINER_MODULES_ROOT,
  CONTAINER_MOUNTS_ROOT,
  CONTAINER_OUTPUT_ROOT,
  HARDENED_CONTAINER_RUN_FLAGS,
} from "./containerHardening.js";
import { containerInvocationName, type AdapterModuleDirectory } from "./containerLauncher.js";
import { runtimeCliEnvironment } from "./containerRuntime.js";
import type {
  ContainerSupervisorReport,
  ContainerSupervisorSpec,
} from "./containerSupervisor.js";
import { SUPERVISOR_PREFIX, type SupervisorReport } from "./sandboxLauncher.js";

export interface AdapterMount {
  readonly mountId: string;
  readonly absolutePath: string;
  readonly logicalPath: string;
  readonly purpose: "subject-visible-input" | "canonical-evidence" | "frozen-package";
}

export interface AdapterHostOptions {
  readonly runId: string;
  readonly adapterManifest: SubjectAdapterManifestV1 | SubjectAdapterManifestV2;
  /**
   * Which authority admitted this adapter. Required for a V2 local-observation
   * host and meaningless for a governed V1 one.
   *
   * A closed union rather than two optional documents: the host must know
   * *which* kind of authority it is running under — a certified external
   * review, or the operator's own trusted-local declaration — because the two
   * support entirely different statements about the run, and a host that
   * inferred the answer from which field was populated could not retain the
   * fact honestly (ADR-ERL2-042).
   */
  readonly localAuthorityV2?: LocalAdapterAuthorityV2;
  /** Frozen plan whose scope and concrete limits govern every local dispatch. */
  readonly localObservationPlan?: LocalObservationPlanV1;
  /** Absolute path of the adapter's entry module. Its digest is pinned. */
  readonly adapterEntryPath: string;
  /**
   * The adapter artifact digest an admitted certification receipt covers.
   *
   * Supplied whenever the run bound a certification. The host then re-reads the
   * entry and compares before **every** dispatch, so replacing the file after
   * admission cannot execute different bytes under the admitted certification
   * (LIVE-001, ADR-ERL2-036). Absent for hosts built outside the admission path
   * — the certification harness itself, which is what *produces* the digest.
   */
  readonly certifiedArtifactHash?: Hash;
  readonly workspaceRoot: string;
  readonly store: ArtifactStore;
  readonly clock: Clock;
  readonly profile?: SandboxProfileId;
  /**
   * The derived permission to use the `container` profile on this host.
   *
   * Required whenever `profile` is `container`, and produced only by
   * `deriveContainerProfileActivation` from retained probe evidence, a
   * drift-checked substrate and an observed launcher. There is no option that
   * turns the profile on without it.
   */
  readonly containerActivation?: ContainerProfileActivation;
  /**
   * Where the adapter's code lives on the host, for the container profile.
   *
   * The package root is bind-mounted read-only and the declared module closure
   * is laid out beneath it, so the container gets the adapter and its
   * dependencies and nothing else. Resolve the closure with
   * `resolveAdapterModuleClosure`; mounting a repository root instead would put
   * the vault, truth, judge and selection roots inside a namespace the probes
   * proved could not reach them.
   */
  readonly containerAdapterPackage?: {
    readonly packageRoot: string;
    readonly moduleDirectories: readonly AdapterModuleDirectory[];
  };
  readonly bounds?: OutputBounds;
  readonly wallClockMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly egressPolicy?: EgressAllowlistPolicyV1;
  readonly mounts?: readonly AdapterMount[];
  /** Descriptor prefixes an adapter may mutate; defaults to its own workspace. */
  readonly permittedMutationPrefixes?: readonly string[];
  readonly nodeExecutable?: string;
  /**
   * An EVIDENCE-FIXTURE MEASUREMENT OVERRIDE for the retained sandbox result's
   * `wall_clock_ms`, and for nothing else.
   *
   * This is not a timing control. It does not shorten, lengthen or influence any
   * deadline: the supervisor is still launched with `wallClockMs`, still enforces
   * that deadline against real elapsed time, and still terminates the adapter's
   * process tree on it. The spawn ceiling, the response-byte caps, the sandbox
   * control report and the certification suite are all untouched. The single
   * effect is which number is written into `sandbox-invocation-result/v1`.
   *
   * It exists because `sandbox-invocation-result/v1` is retained, integrity-bound
   * evidence and its `wall_clock_ms` is a real measurement of a real process —
   * correct production evidence that cannot be byte-identical between two
   * deliberate generations of the pinned goldens. Rather than normalizing or
   * dropping the field in production, or excluding it from the core hash, the
   * evidence harness supplies one fixture value here.
   *
   * ABSENT BY DEFAULT, and supplied only by the CLI composition root under the
   * existing `ERL2_EVIDENCE_CLOCK` evidence mode. When absent — every production
   * path, every certification, every test that does not ask for it — the observed
   * supervisor duration is retained unchanged.
   */
  readonly evidenceFixtureWallClockMs?: number;
}

export interface AdapterOperationResult {
  readonly envelope: AdapterResponseEnvelopeV1;
  readonly sandboxResult: SandboxInvocationResultV1;
  readonly sandboxManifest: SandboxInvocationManifestV1;
  readonly capabilityGrant: AdapterCapabilityGrantV1;
  readonly diagnostics: SubjectDiagnosticsManifestV1;
  readonly credentialUseReceipts: readonly CredentialUseReceiptV1[];
  readonly egressReceipts: readonly EgressDecisionReceiptV1[];
  readonly mutationIntents: readonly MutationIntentV1[];
  readonly mutationReceipts: readonly MutationReceiptV1[];
  readonly compensationReceipts: readonly CompensationReceiptV1[];
  readonly result: unknown;
  readonly outputDirectory: string;
  /**
   * Everything the host published for this operation, and the metadata that
   * makes it reachable.
   *
   * The records above are the host's *in-process* adjudication. This is the
   * retained form of them: frozen artifacts, their hashes, and the lifecycle
   * production entries a caller must append so the offline closure can derive
   * them. Before it existed the host adjudicated an operation completely and
   * then handed the caller objects that were never written down, so a run could
   * attest a step whose adapter evidence existed only in memory.
   */
  readonly retained: SubjectStepEvidence;
}

export interface LocalAdapterStepEvidence {
  readonly artifactHashes: readonly Hash[];
  readonly mutationReceiptHashes: readonly Hash[];
  readonly compensationReceiptHashes: readonly Hash[];
  readonly outputRefs: readonly ArtifactRef[];
  readonly diagnosticRefs: readonly ArtifactRef[];
}

export interface LocalAdapterOperationResult {
  readonly envelope: AdapterResponseEnvelopeV2;
  readonly sandboxResult: SandboxInvocationResultV1;
  readonly sandboxManifest: SandboxInvocationManifestV2;
  readonly capabilityGrant: AdapterCapabilityGrantV1;
  readonly diagnostics: SubjectDiagnosticsManifestV1;
  readonly credentialUseReceipts: readonly CredentialUseReceiptV1[];
  readonly egressReceipts: readonly EgressDecisionReceiptV1[];
  readonly mutationIntents: readonly MutationIntentV1[];
  readonly mutationReceipts: readonly MutationReceiptV1[];
  readonly compensationReceipts: readonly CompensationReceiptV1[];
  readonly result: unknown;
  /**
   * The validated residue draft, present only for a `report-residue` operation
   * the adapter supported. Undefined means no residue was observed — which is
   * not the same fact as observing none, and the reducer must not conflate them.
   */
  readonly residueObservation: LocalResidueObservationDraft | undefined;
  readonly outputDirectory: string;
  readonly retained: LocalAdapterStepEvidence;
}

/** The retained root every host adjudication record for one operation lives under. */
const HOST_EVIDENCE_LOGICAL_ROOT = "retained/adapter";

/** A four-digit ordinal, so a repeated record kind gets a stable, safe file name. */
function ordinal(index: number): string {
  return String(index + 1).padStart(4, "0");
}

interface RawExchange {
  readonly negotiation?: AdapterProtocolNegotiationV1 | AdapterProtocolNegotiationV2;
  readonly response?: AdapterResponseMessage | AdapterResponseMessageV2;
  readonly outcome: "completed" | "timed_out" | "crashed" | "refused";
  readonly exitStatus?: number;
  readonly terminationSignal?: string;
  readonly processTreeTerminated: boolean;
  readonly terminatedDescendantCount: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly wallClockMs: number;
  readonly refusalCode?: string;
  readonly stderrText: string;
  /** Present only for the container profile; retained verbatim on the result. */
  readonly containerTermination?: SandboxInvocationResultV1["container_termination"];
}

/**
 * Digest of a directory tree, used to prove read-only mounts were untouched.
 *
 * When `scan` is set, every file is also checked for judge and secret canaries:
 * a mount is an adapter-visible surface, so the oracle partition has to hold
 * there as strictly as it does in the request bytes.
 */
function treeFingerprint(root: string, scan: { readonly mountId: string } | undefined): Hash {
  const parts: { path: string; digest: Hash; size: number }[] = [];
  const walk = (dir: string, relative: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const absolute = path.join(dir, name);
      const child = relative === "" ? name : `${relative}/${name}`;
      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        walk(absolute, child);
        continue;
      }
      const bytes = readFileSync(absolute);
      if (scan !== undefined) {
        const counts = scanBytes(bytes.toString("latin1"));
        if (counts.judgeCanaries > 0) {
          throw new Erl2Error(
            "JOURNEY_ORACLE_CANARY_LEAKED",
            `a judge canary is present in adapter mount ${scan.mountId} at ${child}`,
            { owner: "lab" },
          );
        }
        if (counts.secretCanaries > 0) {
          throw new Erl2Error(
            CODES.SECRET_CANARY_IN_DIAGNOSTICS,
            `a secret canary is present in adapter mount ${scan.mountId} at ${child}`,
            { owner: "lab" },
          );
        }
      }
      parts.push({ path: child, digest: hashBytes(bytes), size: stats.size });
    }
  };
  walk(root, "");
  return coreHash({ tree: parts });
}

/**
 * The operation and package-kind scope a V2 local host may dispatch within.
 *
 * Deliberately narrower than either authority document: the host needs exactly
 * these two lists, and taking only them keeps a certified profile and a
 * declared manifest profile interchangeable *here* without making them
 * interchangeable anywhere that matters.
 */
interface LocalAdapterScopeV2 {
  readonly operations: readonly AdapterOperationId[];
  readonly supported_package_kinds: readonly AdapterPackageKind[];
}

/** True when a frozen plan is the certification-receipt variant. */
function isCertifiedPlan(
  plan: LocalObservationPlanV1,
): plan is LocalObservationCertifiedPlanV1 {
  return "certification_receipt_hash" in plan;
}

/** The plan as the trusted-local variant, or `undefined` if it is the other one. */
function trustedLocalPlanOf(
  plan: LocalObservationPlanV1,
): Exclude<LocalObservationPlanV1, LocalObservationCertifiedPlanV1> | undefined {
  return isCertifiedPlan(plan) ? undefined : plan;
}

/**
 * The plan may not reach past what the manifest and admitted profile allow.
 *
 * Shared by both authority arms because the rule is the same under either one:
 * an operation the profile does not contain, or a capability the manifest does
 * not require, is out of scope no matter who admitted the adapter.
 */
function assertLocalPlanScope(
  plan: LocalObservationPlanV1,
  operations: readonly AdapterOperationId[],
  manifest: SubjectAdapterManifestV2,
): void {
  const permitted = new Set<string>(operations);
  const manifestCapabilities = new Set<string>(manifest.required_broker_capabilities);
  if (
    plan.operations.some((operation) => !permitted.has(operation.operation)) ||
    plan.allowed_capability_ids.some((capability) => !manifestCapabilities.has(capability))
  ) {
    throw new Erl2Error(
      CODES.ADAPTER_CERTIFICATION_SCOPE_MISMATCH,
      "local plan operation or capability scope exceeds what the manifest and admitted profile allow",
    );
  }
}

export class AdapterHost {
  readonly runId: string;
  readonly manifest: SubjectAdapterManifestV1 | SubjectAdapterManifestV2;
  readonly credentials = new CredentialBroker();
  readonly egressPolicy: EgressAllowlistPolicyV1;

  private readonly entryPath: string;
  private readonly workspaceRoot: string;
  private readonly store: ArtifactStore;
  private readonly clock: Clock;
  private readonly profile: SandboxProfileId;
  private readonly containerActivation: ContainerProfileActivation | undefined;
  private readonly containerAdapterPackage: AdapterHostOptions["containerAdapterPackage"];
  private readonly bounds: OutputBounds;
  private readonly wallClockMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly mounts: readonly AdapterMount[];
  private readonly permittedMutationPrefixes: readonly string[];
  private readonly nodeExecutable: string;
  /** See `AdapterHostOptions.evidenceFixtureWallClockMs`. Undefined in production. */
  private readonly evidenceFixtureWallClockMs: number | undefined;
  private readonly certifiedArtifactHash: Hash | undefined;
  private readonly protocolVersion: typeof ADAPTER_PROTOCOL_VERSION | typeof ADAPTER_PROTOCOL_VERSION_V2;
  /**
   * Which authority this host is running under, once admission has resolved.
   *
   * Retained as a discriminant rather than recomputed, so `run` and the
   * negotiation check never have to re-derive it, and so a caller reading the
   * host can be told the truth about what admitted the adapter.
   */
  private localAuthorityMode: LocalAdapterAuthorityV2["mode"] | undefined;
  /**
   * The operation and package-kind scope admission established.
   *
   * Under a certification receipt this is the certified profile — the
   * intersection a certifier signed off. Under a trusted-local declaration it
   * is the manifest's own declared profile, because there is no certifier and
   * pretending there is an approved subset would invent one.
   */
  private localScope: LocalAdapterScopeV2 | undefined;
  private readonly localPlan: LocalObservationPlanV1 | undefined;
  private outputFrozen = false;
  private invocationSequence = 0;

  constructor(options: AdapterHostOptions) {
    this.runId = options.runId;
    this.manifest = options.adapterManifest;
    this.entryPath = path.resolve(options.adapterEntryPath);
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.store = options.store;
    this.clock = options.clock;
    this.profile = options.profile ?? "local-process";
    this.containerActivation = options.containerActivation;
    this.containerAdapterPackage = options.containerAdapterPackage;
    const hostBounds = options.bounds ?? DEFAULT_OUTPUT_BOUNDS;
    const hostWallClockMs = options.wallClockMs ?? 30_000;
    const hostMaxRequestBytes = options.maxRequestBytes ?? 1024 * 1024;
    const hostMaxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.mounts = options.mounts ?? [];
    this.permittedMutationPrefixes = options.permittedMutationPrefixes ?? ["adapter-workspace/"];
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.evidenceFixtureWallClockMs = options.evidenceFixtureWallClockMs;
    this.localPlan = options.localObservationPlan;
    const isV2 = this.manifest.schema_version === "subject-adapter-manifest/v2";
    this.protocolVersion = isV2 ? ADAPTER_PROTOCOL_VERSION_V2 : ADAPTER_PROTOCOL_VERSION;
    this.localAuthorityMode = undefined;
    this.localScope = undefined;
    this.certifiedArtifactHash =
      isV2 ? this.manifest.adapter_artifact_hash : options.certifiedArtifactHash;

    if (!isV2 && this.manifest.protocol_version !== ADAPTER_PROTOCOL_VERSION) {
      throw new Erl2Error(
        CODES.ADAPTER_PROTOCOL_VERSION_MISMATCH,
        `adapter manifest declares protocol ${this.manifest.protocol_version}`,
        { owner: "adapter" },
      );
    }
    if (isV2 && (options.localAuthorityV2 === undefined || this.localPlan === undefined)) {
      throw new Erl2Error(
        CODES.ADAPTER_CERTIFICATION_RECEIPT_REQUIRED,
        "a local V2 host requires an explicit admission authority and its frozen observation plan",
      );
    }

    const limits = isV2 ? this.localPlan?.resource_limits : undefined;
    if (limits !== undefined) {
      assertContract<LocalObservationLimitsV1>("LocalObservationLimitsV1", limits);
      const over =
        limits.wall_clock_ms > hostWallClockMs ||
        limits.max_request_bytes > hostMaxRequestBytes ||
        limits.max_response_bytes > hostMaxResponseBytes ||
        limits.max_output_files > hostBounds.maxFiles ||
        limits.max_output_bytes > hostBounds.maxTotalBytes ||
        limits.max_output_path_depth > hostBounds.maxPathDepth ||
        limits.max_diagnostic_bytes > hostBounds.maxDiagnosticBytes;
      if (over) {
        throw new Erl2Error(
          CODES.ADAPTER_LOCAL_LIMIT_EXCEEDED,
          "local observation limits exceed one or more host ceilings",
        );
      }
      this.bounds = {
        maxFiles: limits.max_output_files,
        maxTotalBytes: limits.max_output_bytes,
        maxPathDepth: limits.max_output_path_depth,
        maxDiagnosticBytes: limits.max_diagnostic_bytes,
        allowedMediaTypes: hostBounds.allowedMediaTypes,
      };
      this.wallClockMs = limits.wall_clock_ms;
      this.maxRequestBytes = limits.max_request_bytes;
      this.maxResponseBytes = limits.max_response_bytes;
    } else {
      this.bounds = hostBounds;
      this.wallClockMs = hostWallClockMs;
      this.maxRequestBytes = hostMaxRequestBytes;
      this.maxResponseBytes = hostMaxResponseBytes;
    }
    assertManifestCapabilitiesUnprivileged(this.manifest.required_broker_capabilities);
    for (const mount of this.mounts) {
      assertMountPermitted(path.resolve(mount.absolutePath), process.env["HOME"]);
    }
    // The profile is checked here rather than at dispatch: admission is where
    // the subject-trust gate lives, and a host that cannot run its own profile
    // must not exist long enough to be handed a request (ADR-ERL2-017's third
    // rejected alternative).
    assertSandboxProfileEnabled(this.profile, this.containerActivation);
    if (this.profile === "container") {
      if (this.containerAdapterPackage === undefined) {
        throw new Erl2Error(
          CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
          "the container profile needs the adapter's package root and resolved module closure; without them there is nothing to mount and the adapter could not be started",
          { owner: "lab" },
        );
      }
      const packageRoot = path.resolve(this.containerAdapterPackage.packageRoot);
      assertMountPermitted(packageRoot, process.env["HOME"]);
      for (const module of this.containerAdapterPackage.moduleDirectories) {
        assertMountPermitted(path.resolve(module.hostPath), process.env["HOME"]);
      }
      const relative = path.relative(packageRoot, this.entryPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Erl2Error(
          CODES.ADAPTER_IDENTITY_MISMATCH,
          `adapter entry ${this.entryPath} is outside its declared package root ${packageRoot}, so it would not be inside the mounted namespace`,
          { owner: "lab" },
        );
      }
    }
    if (!existsSync(this.entryPath)) {
      throw new Erl2Error(
        CODES.ADAPTER_IDENTITY_MISMATCH,
        `adapter entry ${this.entryPath} does not exist`,
        { owner: "adapter" },
      );
    }
    if (isV2) {
      const plan = assertContract<LocalObservationPlanV1>("LocalObservationPlanV1", this.localPlan);
      if (coreHash(plan) !== plan.core_hash) {
        throw new Erl2Error(CODES.ARTIFACT_HASH_MISMATCH, "local observation plan core hash is stale");
      }
      if (
        coreHash(plan.resource_limits) !== plan.resource_limits.core_hash ||
        coreHash(plan.egress_policy) !== plan.egress_policy.core_hash
      ) {
        throw new Erl2Error(
          CODES.ARTIFACT_HASH_MISMATCH,
          "local plan embeds stale limits or egress-policy identity",
        );
      }
      const authority = options.localAuthorityV2 as LocalAdapterAuthorityV2;
      this.localAuthorityMode = authority.mode;
      // Each arm resolves the same four facts — identity, artifact digest, the
      // plan's authority binding, and the operation scope — from a different
      // authority. The two arms never share a document: a receipt cannot
      // satisfy the trusted-local arm and a declaration cannot satisfy the
      // certified one, because each calls a verifier that rejects the other's
      // `schema_version` outright.
      if (authority.mode === "certified_external") {
        const admission = verifyLocalAdapterCertificationV2({
          manifest: this.manifest,
          receipt: authority.receipt,
          entryDigest: this.executableDigest,
        });
        this.localScope = admission.profile;
        if (
          !isCertifiedPlan(plan) ||
          plan.adapter_id !== admission.adapterId ||
          plan.adapter_version !== admission.adapterVersion ||
          plan.adapter_manifest_hash !== admission.manifestHash ||
          plan.certification_receipt_hash !== admission.receiptHash ||
          plan.adapter_artifact_hash !== admission.adapterArtifactHash ||
          plan.certification_authenticity !== admission.authenticity
        ) {
          throw new Erl2Error(
            CODES.ADAPTER_CERTIFICATION_IDENTITY_MISMATCH,
            "the local plan is not bound to the admitted V2 manifest, receipt and artifact",
          );
        }
        assertLocalPlanScope(plan, admission.profile.operations, this.manifest);
        const actualControls = sandboxControlReport(this.profile, this.containerActivation);
        for (const expectation of plan.resource_limits.control_expectations) {
          const actual = actualControls.find((control) => control.control_id === expectation.control_id);
          if (
            actual === undefined ||
            (expectation.required_state === "enforced" &&
              (actual.state !== "enforced" ||
                !authority.receipt.enforced_controls.includes(expectation.control_id)))
          ) {
            throw new Erl2Error(
              CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
              `local observation requires unavailable control ${expectation.control_id}`,
            );
          }
        }
      } else {
        const admission = verifyTrustedLocalAdapterDeclaration({
          manifest: this.manifest,
          declaration: authority.declaration,
          entryDigest: this.executableDigest,
        });
        this.localScope = admission.profile;
        // The discrimination is a binding of its own, held in a name rather
        // than folded into the condition below: a plan naming a certification
        // receipt is not this arm's document, and the check that says so has to
        // be separately disable-able or it cannot be separately measured.
        const ownerPlan = trustedLocalPlanOf(plan);
        if (
          ownerPlan === undefined ||
          ownerPlan.adapter_id !== admission.adapterId ||
          ownerPlan.adapter_version !== admission.adapterVersion ||
          ownerPlan.adapter_manifest_hash !== admission.manifestHash ||
          ownerPlan.trusted_local_declaration_hash !== admission.declarationHash ||
          ownerPlan.adapter_artifact_hash !== admission.adapterArtifactHash ||
          ownerPlan.trust_mode !== admission.trustMode
        ) {
          throw new Erl2Error(
            CODES.ADAPTER_TRUSTED_LOCAL_BINDING_MISMATCH,
            "the local plan is not bound to the admitted V2 manifest, owner declaration and artifact",
          );
        }
        assertLocalPlanScope(plan, admission.profile.operations, this.manifest);
        // No certifier claimed anything about controls, so both the manifest's
        // requirements and the plan's expectations are settled against the
        // host's own report.
        assertTrustedLocalControls(
          admission.profile,
          plan.resource_limits.control_expectations,
          admission.hostControlReport,
        );
      }
      if (
        options.egressPolicy !== undefined &&
        options.egressPolicy.core_hash !== plan.egress_policy.core_hash
      ) {
        throw new Erl2Error(
          CODES.ADAPTER_CERTIFICATION_SCOPE_MISMATCH,
          "host egress policy differs from the frozen local observation plan",
        );
      }
      this.egressPolicy = plan.egress_policy;
    } else {
      this.egressPolicy = options.egressPolicy ?? denyByDefaultEgressPolicy("adapter-default-deny");
    }
    mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
  }

  /**
   * Which authority admitted this host's adapter, or `undefined` for a
   * governed V1 host that has none.
   *
   * Exposed so a caller retaining evidence writes down the authority the host
   * actually resolved, rather than the one the caller believes it passed in.
   */
  get localAuthorityModeV2(): LocalAdapterAuthorityV2["mode"] | undefined {
    return this.localAuthorityMode;
  }

  /** Marks the run's subject output frozen; no further dispatch is possible. */
  markOutputFrozen(): void {
    this.outputFrozen = true;
  }

  get executableDigest(): Hash {
    return hashBytes(readFileSync(this.entryPath));
  }

  /**
   * Dispatches one operation and returns its adjudicated result.
   *
   * Every host-side decision is receipted before the envelope is built, so a
   * refusal is evidence rather than an exception with no trail.
   */
  run(input: {
    readonly operation: AdapterOperation;
    readonly operationId: string;
    readonly request: unknown;
    readonly requestedCapabilityIds?: readonly string[];
    readonly executionMode?: never;
  }): AdapterOperationResult;
  run(input: {
    readonly operation: AdapterOperation;
    readonly operationId: string;
    readonly request: AdapterRequestV2;
    readonly requestedCapabilityIds?: readonly string[];
    readonly executionMode: typeof ADAPTER_LOCAL_EXECUTION_MODE;
  }): LocalAdapterOperationResult;
  run(input: {
    readonly operation: AdapterOperation;
    readonly operationId: string;
    readonly request: unknown;
    readonly requestedCapabilityIds?: readonly string[];
    readonly executionMode?: typeof ADAPTER_LOCAL_EXECUTION_MODE;
  }): AdapterOperationResult | LocalAdapterOperationResult {
    assertNoExecutionAfterOutputFreeze(this.outputFrozen, `adapter operation ${input.operation}`);
    const isLocal = this.protocolVersion === ADAPTER_PROTOCOL_VERSION_V2;
    if (isLocal !== (input.executionMode === ADAPTER_LOCAL_EXECUTION_MODE)) {
      throw new Erl2Error(
        CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED,
        isLocal
          ? "a V2 host accepts only explicitly local-observation dispatch"
          : "a governed V1 host cannot dispatch a local-observation request",
      );
    }
    // Time of use. Admission hashed these bytes once; this re-hashes them on
    // every dispatch, before anything is spawned, so the window between
    // admission and execution — and between one operation and the next — is
    // closed rather than merely narrow.
    if (this.certifiedArtifactHash !== undefined) {
      assertEntryDigestUnchanged({
        entryPath: this.entryPath,
        certifiedArtifactHash: this.certifiedArtifactHash,
      });
    }
    const declaredOperations = isLocal
      ? this.localScope?.operations ?? []
      : (this.manifest as SubjectAdapterManifestV1).operations;
    if (!declaredOperations.includes(input.operation)) {
      throw new Erl2Error(
        CODES.ADAPTER_OPERATION_UNSUPPORTED,
        `adapter ${this.manifest.adapter_id} does not declare operation ${input.operation}`,
        { owner: "adapter" },
      );
    }
    if (isLocal) {
      const request = assertContract<AdapterRequestV2>("AdapterRequestV2", input.request);
      if (coreHash(request) !== request.core_hash) {
        throw new Erl2Error(CODES.ARTIFACT_HASH_MISMATCH, "local AdapterRequestV2 core hash is stale");
      }
      if ((request.execution_context as { mode?: string }).mode !== ADAPTER_LOCAL_EXECUTION_MODE) {
        throw new Erl2Error(
          CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED,
          "governed subject-adapter/v2 is structural-only and cannot be dispatched",
        );
      }
      assertNoLocalObservationGovernedFields(request);
      assertLocalObservationClaimExclusions(request.execution_context);
      const plan = this.localPlan as LocalObservationPlanV1;
      const localContext = request.execution_context as Extract<
        AdapterRequestV2["execution_context"],
        { readonly mode: "local_observation" }
      >;
      const spec = plan.operations.find((operation) => operation.operation_id === input.operationId);
      if (
        request.execution_id !== this.runId ||
        request.operation_id !== input.operationId ||
        request.operation !== input.operation ||
        request.adapter_manifest_hash !== this.manifest.core_hash ||
        localContext.observation_plan_hash !== plan.core_hash ||
        spec === undefined ||
        spec.operation !== input.operation ||
        coreHash({ payload: spec.payload }) !== coreHash({ payload: request.operation_payload })
      ) {
        throw new Erl2Error(
          CODES.ADAPTER_CERTIFICATION_SCOPE_MISMATCH,
          "local request is outside its exact plan, manifest or operation scope",
        );
      }
      if (
        coreHash(localContext.resource_limits) !== plan.resource_limits.core_hash ||
        coreHash(localContext.egress_policy) !== plan.egress_policy.core_hash ||
        coreHash({ values: localContext.allowed_capability_ids }) !==
          coreHash({ values: plan.allowed_capability_ids }) ||
        coreHash({ values: localContext.allowed_credential_handle_ids }) !==
          coreHash({ values: plan.allowed_credential_handle_ids }) ||
        request.diagnostics_policy.max_total_bytes > plan.resource_limits.max_diagnostic_bytes ||
        request.diagnostics_policy.max_line_bytes > plan.resource_limits.max_diagnostic_line_bytes
      ) {
        throw new Erl2Error(
          CODES.ADAPTER_LOCAL_LIMIT_EXCEEDED,
          "local request limits, policy or grants differ from the frozen plan",
        );
      }
      if (
        request.ancestry.sequence !== spec.sequence ||
        (spec.sequence === 0) !== (request.ancestry.predecessor === null)
      ) {
        throw new Erl2Error(CODES.REQUEST_ANCESTRY_INVALID, "local request ancestry disagrees with plan sequence");
      }
      if (Date.parse(request.deadline) > Date.parse(plan.expires_at)) {
        throw new Erl2Error(CODES.ADAPTER_DEADLINE_EXCEEDED, "local request deadline exceeds plan expiry");
      }
      const packageKind = localPackageKind(request.operation_payload);
      if (
        packageKind !== undefined &&
        !this.localScope?.supported_package_kinds.includes(packageKind)
      ) {
        throw new Erl2Error(
          CODES.ADAPTER_PACKAGE_KIND_UNSUPPORTED,
          `package kind ${packageKind} is outside the certified local profile`,
          { owner: "adapter" },
        );
      }
    }
    // The request never carries an oracle field, checked on the Lab side before
    // it can reach the process boundary.
    assertNoOracleFields(`${input.operation} adapter request`, input.request);

    const requested = input.requestedCapabilityIds ?? this.manifest.required_broker_capabilities;
    if (isLocal) {
      const allowed = new Set<string>(this.localPlan?.allowed_capability_ids ?? []);
      for (const capability of requested) {
        if (!allowed.has(capability)) {
          throw new Erl2Error(
            CODES.ADAPTER_CAPABILITY_NOT_GRANTED,
            `capability ${capability} is outside the frozen local plan`,
          );
        }
      }
    }
    for (const capability of requested) {
      if (isPrivilegedCapability(capability)) throw privilegedRefusal(capability);
    }
    this.invocationSequence += 1;
    const invocationId = `invocation-${String(this.invocationSequence).padStart(4, "0")}`;
    const now = this.clock.now();

    const capabilityGrant = grantCapabilities({
      runId: this.runId,
      operationId: input.operationId,
      grantId: `grant-${String(this.invocationSequence).padStart(4, "0")}`,
      adapterManifestHash: this.manifest.core_hash,
      requested,
      grantedAt: now,
    });

    const operationRoot = path.join(this.workspaceRoot, input.operationId);
    const outputDirectory = path.join(operationRoot, "output");
    const diagnosticsDirectory = path.join(operationRoot, "diagnostics");
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(diagnosticsDirectory, { recursive: true, mode: 0o700 });
    if (this.profile === "container") {
      // The container runs as an unmapped numeric uid, so the two writable
      // mounts have to be writable by it. They are run-scoped directories inside
      // a 0700 workspace root — the parent is what confines them — and this is
      // the same arrangement the `writable-output-only` probe observed.
      chmodSync(outputDirectory, 0o777);
      chmodSync(diagnosticsDirectory, 0o777);
    }
    // Nothing may be pre-placed in the output tree. A prefilled output would
    // let bytes the adapter never produced be attributed to the subject, and it
    // is a route for a judge canary to arrive from outside the request.
    if (readdirSync(outputDirectory).length > 0) {
      throw new Erl2Error(
        CODES.SUBJECT_OUTPUT_PATH_ESCAPE,
        `the output directory for ${input.operationId} is not empty; adapter output may not be prefilled`,
        { owner: "lab" },
      );
    }

    const deadline = isLocal
      ? (input.request as AdapterRequestV2).deadline
      : instantAfter(now, this.wallClockMs);

    const sandboxManifest = this.buildSandboxManifest({
      invocationId,
      operationId: input.operationId,
      outputDirectory,
      deadline,
      createdAt: now,
      capabilityIds: capabilityGrant.granted_capability_ids,
    });
    assertControlReportMatchesProfile(sandboxManifest, this.profile, this.containerActivation);

    // Mounts are fingerprinted *and* scanned before the adapter can see them.
    const mountFingerprints = this.mounts.map((m) => ({
      mountId: m.mountId,
      before: treeFingerprint(path.resolve(m.absolutePath), { mountId: m.mountId }),
    }));

    // Under the container profile the adapter is told **container-side** paths.
    // The host paths it would otherwise be handed do not exist inside the
    // namespace, and an adapter that wrote to one would be writing into a
    // read-only rootfs rather than into the directory the host reads back.
    const inContainer = this.profile === "container";
    const messageCommon = {
      operation: input.operation,
      operation_id: input.operationId,
      request: input.request,
      mounts: this.mounts.map((m) => ({
        mount_id: m.mountId,
        absolute_path: inContainer
          ? `${CONTAINER_MOUNTS_ROOT}/${m.mountId}`
          : path.resolve(m.absolutePath),
        purpose: m.purpose,
      })),
      output_directory: inContainer ? CONTAINER_OUTPUT_ROOT : outputDirectory,
      diagnostics_directory: inContainer ? CONTAINER_DIAGNOSTICS_ROOT : diagnosticsDirectory,
      granted_capability_ids: capabilityGrant.granted_capability_ids,
      deadline,
    };
    const message: HostOperationMessage | HostOperationMessageV2 = isLocal
      ? {
          kind: "operation",
          schema_version: "adapter-host-operation/v2",
          protocol_version: ADAPTER_PROTOCOL_VERSION_V2,
          execution_mode: ADAPTER_LOCAL_EXECUTION_MODE,
          execution_id: this.runId,
          ...messageCommon,
        }
      : {
          kind: "operation",
          protocol_version: ADAPTER_PROTOCOL_VERSION,
          run_id: this.runId,
          ...messageCommon,
        };

    const exchange = this.exchange(message, {
      operationRoot,
      outputDirectory,
      diagnosticsDirectory,
      invocationId,
    });

    // Read-only mounts are verified unchanged. On the process profile the
    // kernel does not prevent a write; this detects one and refuses the run.
    for (const fingerprint of mountFingerprints) {
      const mount = this.mounts.find((m) => m.mountId === fingerprint.mountId);
      /* c8 ignore next */
      if (!mount) continue;
      if (treeFingerprint(path.resolve(mount.absolutePath), undefined) !== fingerprint.before) {
        throw new Erl2Error(
          CODES.ADAPTER_MOUNT_NOT_READ_ONLY,
          `adapter modified the read-only mount ${mount.mountId}`,
          { owner: "adapter" },
        );
      }
    }

    const endedAt = this.clock.now();
    const sandboxResult = this.buildSandboxResult(
      invocationId,
      sandboxManifest.core_hash,
      exchange,
      now,
      endedAt,
    );

    const diagnostics = freezeDiagnostics({
      runId: this.runId,
      operationId: input.operationId,
      diagnosticsRoot: diagnosticsDirectory,
      store: this.store,
      bounds: this.bounds,
      frozenAt: endedAt,
    });
    if (diagnostics.scan.judge_canaries_found > 0) {
      throw new Erl2Error(
        "JOURNEY_ORACLE_CANARY_LEAKED",
        "a judge canary reached adapter diagnostics",
        { owner: "lab" },
      );
    }
    if (diagnostics.scan.secret_canaries_found > 0) {
      throw new Erl2Error(
        CODES.SECRET_CANARY_IN_DIAGNOSTICS,
        "a secret canary reached adapter diagnostics",
        { owner: "lab" },
      );
    }

    if (exchange.outcome !== "completed" || !exchange.response) {
      throw this.hostFailure(input.operationId, exchange, sandboxResult);
    }
    const response = exchange.response;
    const responseExecutionId = "execution_id" in response ? response.execution_id : response.run_id;
    if (
      responseExecutionId !== this.runId ||
      response.operation !== input.operation ||
      response.operation_id !== input.operationId ||
      (isLocal &&
        (!("execution_mode" in response) ||
          response.protocol_version !== ADAPTER_PROTOCOL_VERSION_V2 ||
          response.execution_mode !== ADAPTER_LOCAL_EXECUTION_MODE)) ||
      (!isLocal && "execution_mode" in response)
    ) {
      throw new Erl2Error(
        CODES.ADAPTER_PROTOCOL_RESPONSE_MISMATCH,
        "adapter response does not repeat the dispatched identifiers",
        { owner: "adapter" },
      );
    }

    // A supported `report-residue` operation must carry a usable residue report.
    // Validated here, with the rest of the draft adjudication and before
    // anything is derived or frozen, because an adapter that supported the
    // operation and then said nothing intelligible about residue must be
    // refused at the boundary rather than handed downstream as an absence the
    // cleanup reducer has to interpret.
    const residueObservation =
      isLocal && input.operation === "report-residue" && response.status === "supported"
        ? assertLocalResidueObservationDraft(
            response.result,
            residueCheckpointOf((input.request as AdapterRequestV2).operation_payload),
          )
        : undefined;

    const ledger = new MutationLedger({
      runId: this.runId,
      permittedTargetPrefixes: this.permittedMutationPrefixes,
      grantedCapabilities: capabilityGrant.granted_capability_ids,
    });
    const mutationIntents: MutationIntentV1[] = [];
    const mutationReceipts: MutationReceiptV1[] = [];
    for (const declared of response.mutations) {
      const entry = ledger.record(
        {
          mutationId: declared.mutation_id,
          mutationClass: declared.mutation_class,
          capabilityId: declared.capability_id as never,
          targetDescriptor: declared.target_descriptor,
          beforeStateDescriptor: declared.before_state_descriptor,
          afterStateDescriptor: declared.after_state_descriptor,
          compensationId: declared.compensation_id,
          compensationCapabilityId: declared.compensation_capability_id as never,
          status: declared.status,
          ...(declared.error_code === undefined ? {} : { errorCode: declared.error_code }),
        },
        input.operationId,
        endedAt,
      );
      mutationIntents.push(entry.intent);
      mutationReceipts.push(entry.receipt);
    }
    const compensationReceipts = response.compensations.map((declared) =>
      ledger.compensate(
        {
          compensationId: declared.compensation_id,
          mutationId: declared.mutation_id,
          afterStateDescriptor: declared.after_state_descriptor,
          status: declared.status,
          ...(declared.reason_code === undefined ? {} : { reasonCode: declared.reason_code }),
        },
        endedAt,
      ),
    );
    ledger.assertReconciled();

    for (const request of response.credential_requests) {
      this.credentials.issue({
        runId: this.runId,
        operationId: input.operationId,
        adapterManifestHash: this.manifest.core_hash,
        handleRequestId: request.handle_request_id,
        credentialReferenceKind: request.credential_reference_kind,
        requestedScopeIds: request.requested_scope_ids,
        requestedTtlSeconds: request.requested_ttl_seconds,
        requestedMaxUses: request.requested_max_uses,
        targetDescriptor: request.target_descriptor,
        purposeCode: request.purpose_code,
        now: endedAt,
      });
    }
    const credentialUseReceipts = response.credential_uses.map((use) =>
      this.credentials.use({
        runId: this.runId,
        operationId: input.operationId,
        adapterManifestHash: this.manifest.core_hash,
        handleId: use.handle_id,
        scopeId: use.used_scope_id,
        targetDescriptor: use.target_descriptor,
        now: endedAt,
      }),
    );

    const egressReceipts = response.egress_attempts.map((attempt) =>
      decideEgress({
        runId: this.runId,
        operationId: input.operationId,
        decisionId: attempt.decision_id,
        policy: this.egressPolicy,
        url: attempt.url,
        redirectChain: attempt.redirect_chain,
        resolvedAddresses: attempt.resolved_addresses,
        now: endedAt,
      }),
    );
    const deniedEgress = egressReceipts.find((r) => r.decision === "denied");
    if (deniedEgress) {
      throw new Erl2Error(
        deniedEgress.denial_code ?? CODES.ADAPTER_EGRESS_DENIED,
        `adapter egress to ${deniedEgress.host} was denied by policy`,
        { owner: "adapter" },
      );
    }
    const deniedCredential = credentialUseReceipts.find((r) => r.decision === "denied");
    if (deniedCredential) {
      throw new Erl2Error(
        deniedCredential.denial_code ?? CODES.SECRET_CREDENTIAL_SCOPE_EXCEEDED,
        `credential handle ${deniedCredential.handle_id} was used outside its grant`,
        { owner: "adapter" },
      );
    }

    const envelopeOutcome = {
      operation_id: input.operationId,
      operation: input.operation,
      status: response.status,
      ...(response.status === "supported"
        ? {
            result_core_hash: coreHash((response.result ?? {}) as object),
            result_schema_version: response.result_schema_version ?? "adapter-result/opaque",
          }
        : {}),
      mutation_receipt_hashes: ledger.receiptHashes(),
      compensation_receipt_hashes: ledger.compensationHashes(),
      credential_use_receipt_hashes: credentialUseReceipts.map((r) => r.core_hash),
      diagnostics_manifest_hash: diagnostics.core_hash,
      unsupported_inputs: [...response.unsupported_inputs],
      ...(response.status === "supported" ? {} : { error: response.error }),
      active_operator_ms: response.active_operator_ms,
      responded_at: endedAt,
    };
    const envelope = isLocal
      ? (() => {
          const base = {
            schema_version: "adapter-response-envelope/v2" as const,
            protocol_version: ADAPTER_PROTOCOL_VERSION_V2,
            execution_mode: ADAPTER_LOCAL_EXECUTION_MODE,
            execution_id: this.runId,
            request_core_hash: (input.request as AdapterRequestV2).core_hash,
            ...envelopeOutcome,
          };
          return assertContract<AdapterResponseEnvelopeV2>("AdapterResponseEnvelopeV2", {
            ...base,
            core_hash: coreHash(base),
          });
        })()
      : (() => {
          const base = {
            schema_version: "adapter-response-envelope/v1" as const,
            protocol_version: ADAPTER_PROTOCOL_VERSION,
            run_id: this.runId,
            ...envelopeOutcome,
          };
          return assertContract<AdapterResponseEnvelopeV1>("AdapterResponseEnvelopeV1", {
            ...base,
            core_hash: coreHash(base),
          });
        })();

    // The adapter's output tree, admitted last and only once every other
    // adjudication has passed.
    //
    // `freezeAdapterOutput` walks the tree refusing symlinks, hard links,
    // non-regular entries, path escapes, over-deep paths and over-large or
    // over-numerous entries, scans every byte for judge canaries, secret
    // canaries and forbidden identifiers, and only then publishes. Every one of
    // those gates existed and none of them ran against a real adapter, because
    // this function had no caller: the output stayed in the host-owned working
    // directory and the step outcome carried `output_refs: []`. An adapter could
    // therefore write an oversized, structurally forbidden or secret-bearing
    // tree, return a supported envelope, and leave an offline-valid terminal.
    //
    // Placed *after* the ledger, credential and egress adjudication so that a
    // refusal from any of those publishes nothing for this operation; placed
    // before the host's own records are frozen for the same reason.
    const output = freezeAdapterOutput({
      outputRoot: outputDirectory,
      store: this.store,
      logicalPrefix: isLocal
        ? `${(this.localPlan as LocalObservationPlanV1).resource_limits.output_root}/${input.operationId}`
        : adapterOutputPrefix(input.operationId),
      bounds: this.bounds,
    });

    const retained = this.retainHostEvidence({
      local: isLocal,
      operationId: input.operationId,
      envelope,
      sandboxManifest,
      sandboxResult,
      capabilityGrant,
      diagnostics,
      credentialUseReceipts,
      egressReceipts,
      mutationIntents,
      mutationReceipts,
      compensationReceipts,
      outputRefs: output.entries,
    });

    const resultBase = {
      envelope,
      sandboxResult,
      sandboxManifest,
      capabilityGrant,
      diagnostics,
      credentialUseReceipts,
      egressReceipts,
      mutationIntents,
      mutationReceipts,
      compensationReceipts,
      result: response.result,
      residueObservation,
      outputDirectory,
      retained,
    };
    return isLocal
      ? (resultBase as LocalAdapterOperationResult)
      : (resultBase as AdapterOperationResult);
  }

  /**
   * Freezes the host's adjudication records for one operation and returns the
   * evidence the caller needs to make them reachable.
   *
   * ## Why the host freezes them rather than the caller
   *
   * These are the *host's* decisions about an untrusted process: what it was
   * granted, what sandbox it ran in, how it ended, what it was allowed to reach
   * and what it declared it changed. The host is the only component that holds
   * them, and the previous seam handed them back as in-process objects that the
   * `SubjectPort` reduced to a status and a duration. Nothing else ever saw
   * them, so nothing else could have frozen them.
   *
   * ## Why every record gets its own retained file
   *
   * The offline closure resolves a produced hash to a retained artifact
   * (`ArtifactIndex.get`). A hash appended to the lifecycle whose object is not
   * on disk is an unreachable-artifact refusal, which is the correct outcome
   * and a useless one: the point is that the object *is* there. One artifact per
   * file also means the retained-file accounting pass indexes each of them, so
   * a deleted or substituted record is caught rather than merely absent.
   *
   * File names are Lab-authored ordinals, never adapter-supplied identifiers: a
   * mutation id or a decision id is a string the untrusted process chose, and a
   * chosen string does not belong in a path even behind path confinement.
   */
  private retainHostEvidence(input: {
    readonly local: boolean;
    readonly operationId: string;
    readonly envelope: AdapterResponseEnvelopeV1 | AdapterResponseEnvelopeV2;
    readonly sandboxManifest: SandboxInvocationManifestV1 | SandboxInvocationManifestV2;
    readonly sandboxResult: SandboxInvocationResultV1;
    readonly capabilityGrant: AdapterCapabilityGrantV1;
    readonly diagnostics: SubjectDiagnosticsManifestV1;
    readonly credentialUseReceipts: readonly CredentialUseReceiptV1[];
    readonly egressReceipts: readonly EgressDecisionReceiptV1[];
    readonly mutationIntents: readonly MutationIntentV1[];
    readonly mutationReceipts: readonly MutationReceiptV1[];
    readonly compensationReceipts: readonly CompensationReceiptV1[];
    readonly outputRefs: readonly ArtifactRef[];
  }): SubjectStepEvidence | LocalAdapterStepEvidence {
    const root = `${input.local ? "retained/local-observation-adapter" : HOST_EVIDENCE_LOGICAL_ROOT}/${input.operationId}`;
    const produced: SubjectProducedArtifact[] = [];
    const detailRecordHashes: Hash[] = [];

    const freeze = (
      name: string,
      role: string,
      schemaVersion: string,
      value: { readonly core_hash: Hash },
    ): Hash => {
      this.store.freezeJson(`${root}/${name}.json`, value, "INTERNAL");
      produced.push({
        artifact_role: role,
        artifact_core_hash: value.core_hash,
        artifact_schema_version: schemaVersion,
      });
      return value.core_hash;
    };

    // Detail records: the adjudication trail for this one dispatch.
    detailRecordHashes.push(
      freeze(
        "response-envelope",
        input.local ? "local-adapter-response-envelope" : "adapter-response-envelope",
        input.local ? "adapter-response-envelope/v2" : "adapter-response-envelope/v1",
        input.envelope,
      ),
      freeze(
        "sandbox-invocation-manifest",
        input.local ? "local-adapter-sandbox-invocation-manifest" : "adapter-sandbox-invocation-manifest",
        input.local ? "sandbox-invocation-manifest/v2" : "sandbox-invocation-manifest/v1",
        input.sandboxManifest,
      ),
      freeze(
        "sandbox-invocation-result",
        "adapter-sandbox-invocation-result",
        "sandbox-invocation-result/v1",
        input.sandboxResult,
      ),
      freeze(
        "capability-grant",
        "adapter-capability-grant",
        "adapter-capability-grant/v1",
        input.capabilityGrant,
      ),
      freeze(
        "diagnostics-manifest",
        "adapter-diagnostics-manifest",
        "subject-diagnostics-manifest/v1",
        input.diagnostics,
      ),
    );
    input.egressReceipts.forEach((receipt, index) => {
      detailRecordHashes.push(
        freeze(
          `egress-decision-receipt-${ordinal(index)}`,
          "adapter-egress-decision-receipt",
          "egress-decision-receipt/v1",
          receipt,
        ),
      );
    });
    input.credentialUseReceipts.forEach((receipt, index) => {
      detailRecordHashes.push(
        freeze(
          `credential-use-receipt-${ordinal(index)}`,
          "adapter-credential-use-receipt",
          "credential-use-receipt/v1",
          receipt,
        ),
      );
    });
    // A mutation intent is a detail record; its receipt is the mutation field.
    // Splitting them this way is not cosmetic: `JourneyStepOutcomeV1` declares
    // `mutation_receipt_hashes`, and an intent is not a receipt.
    input.mutationIntents.forEach((intent, index) => {
      detailRecordHashes.push(
        freeze(
          `mutation-intent-${ordinal(index)}`,
          "adapter-mutation-intent",
          "mutation-intent/v1",
          intent,
        ),
      );
    });
    const mutationReceiptHashes = input.mutationReceipts.map((receipt, index) =>
      freeze(
        `mutation-receipt-${ordinal(index)}`,
        "adapter-mutation-receipt",
        "mutation-receipt/v1",
        receipt,
      ),
    );
    const compensationReceiptHashes = input.compensationReceipts.map((receipt, index) =>
      freeze(
        `compensation-receipt-${ordinal(index)}`,
        "adapter-compensation-receipt",
        "compensation-receipt/v1",
        receipt,
      ),
    );

    if (input.local) {
      return {
        artifactHashes: [...detailRecordHashes],
        mutationReceiptHashes,
        compensationReceiptHashes,
        outputRefs: [...input.outputRefs],
        diagnosticRefs: [...input.diagnostics.entries],
      };
    }
    return {
      produced,
      detailRecordHashes,
      mutationReceiptHashes,
      compensationReceiptHashes,
      outputRefs: [...input.outputRefs],
      // The diagnostics manifest's own entries, which the freezer already
      // published and redacted. Referencing them is what puts them inside the
      // retained bundle's accounting rather than beside it.
      diagnosticRefs: [...input.diagnostics.entries],
    };
  }

  /** Builds the typed adapter/Lab failure for a non-completed invocation. */
  private hostFailure(
    operationId: string,
    exchange: RawExchange,
    sandboxResult: SandboxInvocationResultV1,
  ): Erl2Error {
    const code =
      exchange.refusalCode ??
      (exchange.outcome === "timed_out"
        ? CODES.ADAPTER_DEADLINE_EXCEEDED
        : CODES.ADAPTER_PROCESS_CRASHED);
    const report = this.buildFailureReport({
      operationId,
      code,
      category: exchange.outcome === "timed_out" ? "adapter_timeout" : "adapter_crash",
      sandboxResultHash: sandboxResult.core_hash,
      summary:
        exchange.outcome === "timed_out"
          ? `the adapter exceeded its ${String(this.wallClockMs)}ms deadline and its process tree was terminated`
          : `the adapter process ended without a valid response (${exchange.stderrText.slice(0, 200)})`,
    });
    return new Erl2Error(code, report.safe_summary, { owner: "adapter", detail: report.core_hash });
  }

  /** Freezes a typed adapter failure report; ownership is never `subject`. */
  buildFailureReport(input: {
    readonly operationId: string;
    readonly code: string;
    readonly category: AdapterFailureReportV1["category"];
    readonly summary: string;
    readonly sandboxResultHash?: Hash;
    readonly evidenceRefs?: readonly Hash[];
  }): AdapterFailureReportV1 {
    const base = {
      schema_version: "adapter-failure-report/v1" as const,
      run_id: this.runId,
      operation_id: input.operationId,
      adapter_manifest_hash: this.manifest.core_hash,
      owner: (input.category === "lab_host_failure" ? "lab" : "adapter") as "adapter" | "lab",
      category: input.category,
      refusal_code: input.code,
      evidence_refs: [...(input.evidenceRefs ?? [])],
      ...(input.sandboxResultHash === undefined
        ? {}
        : { sandbox_result_hash: input.sandboxResultHash }),
      subject_attribution_proven: false as const,
      safe_summary: input.summary.slice(0, 1024),
      reported_at: this.clock.now(),
    };
    return assertContract<AdapterFailureReportV1>("AdapterFailureReportV1", {
      ...base,
      core_hash: coreHash(base),
    });
  }

  private buildSandboxManifest(input: {
    readonly invocationId: string;
    readonly operationId: string;
    readonly outputDirectory: string;
    readonly deadline: Instant;
    readonly createdAt: Instant;
    readonly capabilityIds: readonly string[];
  }): SandboxInvocationManifestV1 | SandboxInvocationManifestV2 {
    if (this.protocolVersion === ADAPTER_PROTOCOL_VERSION_V2) {
      const limits = (this.localPlan as LocalObservationPlanV1).resource_limits;
      const base = {
        schema_version: "sandbox-invocation-manifest/v2" as const,
        execution_id: this.runId,
        execution_mode: ADAPTER_LOCAL_EXECUTION_MODE,
        operation_id: input.operationId,
        invocation_id: input.invocationId,
        adapter_manifest_hash: this.manifest.core_hash,
        adapter_artifact_hash: this.manifest.adapter_artifact_hash,
        executable_file_sha256: this.executableDigest,
        protocol_version: ADAPTER_PROTOCOL_VERSION_V2,
        working_directory_path: `${limits.workspace_root}/${input.operationId}`,
        read_only_mounts: this.mounts.map((m) => ({
          mount_id: m.mountId,
          logical_path: m.logicalPath,
          purpose: m.purpose,
          read_only: true as const,
        })),
        writable_output_path: `${limits.output_root}/${input.operationId}`,
        ...(this.profile === "container"
          ? {
              sandbox_profile: "container" as const,
              isolation_substrate_lock_hash: containerSubstrateLockHash(
                this.containerActivation as ContainerProfileActivation,
              ),
            }
          : { sandbox_profile: "local-process" as const }),
        environment_variable_names: [...LOCAL_OBSERVATION_ENVIRONMENT_VARIABLE_NAMES],
        enforced_controls: sandboxControlReport(this.profile, this.containerActivation).map((c) => ({
          control_id: c.control_id,
          state: c.state,
          ...(c.reason_code === undefined ? {} : { reason_code: c.reason_code }),
        })),
        resource_limits: limits,
        egress_policy_hash: this.egressPolicy.core_hash,
        capability_ids: [...input.capabilityIds] as never,
        credential_handle_ids: this.credentials.issuedHandleIds() as string[],
        deadline: input.deadline,
        created_at: input.createdAt,
      };
      return assertContract<SandboxInvocationManifestV2>("SandboxInvocationManifestV2", {
        ...base,
        core_hash: coreHash(base),
      });
    }
    const base = {
      schema_version: "sandbox-invocation-manifest/v1" as const,
      run_id: this.runId,
      operation_id: input.operationId,
      invocation_id: input.invocationId,
      adapter_manifest_hash: this.manifest.core_hash,
      adapter_artifact_hash: this.manifest.adapter_artifact_hash,
      executable_file_sha256: this.executableDigest,
      protocol_version: ADAPTER_PROTOCOL_VERSION,
      working_directory_path: `adapter-workspace/${input.operationId}`,
      read_only_mounts: this.mounts.map((m) => ({
        mount_id: m.mountId,
        logical_path: m.logicalPath,
        purpose: m.purpose,
        read_only: true as const,
      })),
      writable_output_path: `adapter-workspace/${input.operationId}/output`,
      // Named only for the container profile: a manifest that omits them is a
      // local-process manifest, which is what every one frozen before the
      // container launcher existed was. The lock hash is what binds this
      // invocation's control report to the evidence that licensed it.
      ...(this.profile === "container"
        ? {
            sandbox_profile: "container" as const,
            isolation_substrate_lock_hash: containerSubstrateLockHash(
              this.containerActivation as ContainerProfileActivation,
            ),
          }
        : {}),
      environment_variable_names: [...ALLOWED_ENVIRONMENT_VARIABLE_NAMES],
      enforced_controls: sandboxControlReport(this.profile, this.containerActivation).map((c) => ({
        control_id: c.control_id,
        state: c.state,
        ...(c.reason_code === undefined ? {} : { reason_code: c.reason_code }),
      })),
      resource_limits: {
        wall_clock_ms: this.wallClockMs,
        max_request_bytes: this.maxRequestBytes,
        max_response_bytes: this.maxResponseBytes,
        max_output_files: this.bounds.maxFiles,
        max_output_bytes: this.bounds.maxTotalBytes,
        max_output_path_depth: this.bounds.maxPathDepth,
        max_diagnostic_bytes: this.bounds.maxDiagnosticBytes,
      },
      egress_policy_hash: this.egressPolicy.core_hash,
      capability_ids: [...input.capabilityIds] as never,
      credential_handle_ids: this.credentials.issuedHandleIds() as string[],
      deadline: input.deadline,
      created_at: input.createdAt,
    };
    return assertContract<SandboxInvocationManifestV1>("SandboxInvocationManifestV1", {
      ...base,
      core_hash: coreHash(base),
    });
  }

  private buildSandboxResult(
    invocationId: string,
    manifestHash: Hash,
    exchange: RawExchange,
    startedAt: Instant,
    endedAt: Instant,
  ): SandboxInvocationResultV1 {
    const base = {
      schema_version: "sandbox-invocation-result/v1" as const,
      run_id: this.runId,
      invocation_id: invocationId,
      manifest_hash: manifestHash,
      outcome: exchange.outcome,
      ...(exchange.exitStatus === undefined ? {} : { exit_status: exchange.exitStatus }),
      ...(exchange.terminationSignal === undefined
        ? {}
        : { termination_signal: exchange.terminationSignal }),
      process_tree_terminated: exchange.processTreeTerminated,
      terminated_descendant_count: exchange.terminatedDescendantCount,
      request_bytes: exchange.requestBytes,
      response_bytes: exchange.responseBytes,
      stdout_bytes: exchange.stdoutBytes,
      stderr_bytes: exchange.stderrBytes,
      // The observed supervisor duration, unless the evidence harness supplied a
      // fixture measurement. Nothing else on this record, and nothing anywhere
      // else in the host, consults the override — the deadline the supervisor
      // enforced was `this.wallClockMs` against real time either way.
      wall_clock_ms: this.evidenceFixtureWallClockMs ?? exchange.wallClockMs,
      ...(exchange.refusalCode === undefined ? {} : { refusal_code: exchange.refusalCode }),
      // Retained verbatim, so an offline reader can re-derive
      // `process_tree_terminated` from what the runtime actually reported
      // instead of taking the supervisor's word for it.
      ...(exchange.containerTermination === undefined
        ? {}
        : { container_termination: exchange.containerTermination }),
      started_at: startedAt,
      ended_at: endedAt,
    };
    return assertContract<SandboxInvocationResultV1>("SandboxInvocationResultV1", {
      ...base,
      core_hash: coreHash(base),
    });
  }

  /**
   * Runs the adapter through the supervisor for exactly one operation.
   *
   * One process per operation keeps state from leaking between operations and
   * makes the crash story simple: a dead process produced no response, so the
   * operation is retried or invalidated, never half-applied.
   *
   * The call is synchronous — a run is a sequence of durable steps, not a
   * concurrent pipeline — and the supervisor is what makes that possible
   * without giving up process-tree termination.
   */
  private exchange(
    message: HostOperationMessage | HostOperationMessageV2,
    context: ExchangeContext,
  ): RawExchange {
    const local = "execution_id" in message;
    const negotiateFrame = encodeFrame(
      local
        ? {
            kind: "negotiate",
            schema_version: "adapter-host-negotiation-request/v2",
            offered_protocol_versions: [ADAPTER_PROTOCOL_VERSION_V2],
            required_execution_mode: ADAPTER_LOCAL_EXECUTION_MODE,
            execution_id: this.runId,
            max_request_bytes: this.maxRequestBytes,
            max_response_bytes: this.maxResponseBytes,
          }
        : {
            kind: "negotiate",
            protocol_version: ADAPTER_PROTOCOL_VERSION,
            run_id: this.runId,
            max_request_bytes: this.maxRequestBytes,
            max_response_bytes: this.maxResponseBytes,
          },
      this.maxRequestBytes,
    );
    const operationFrame = encodeFrame(message, this.maxRequestBytes);
    const shutdownFrame = encodeFrame({ kind: "shutdown" }, this.maxRequestBytes);
    const input = Buffer.concat([negotiateFrame, operationFrame, shutdownFrame]);
    const requestBytes = input.byteLength;

    // The request is written to a run-scoped file rather than piped, so the
    // supervisor never has to buffer an unbounded stdin and the exact request
    // bytes stay inspectable after a crash. It is written under the *host*
    // operation root, which under the container profile is not where the
    // adapter thinks its output directory is.
    const inputPath = path.join(context.operationRoot, "request.frames");
    writeFileSync(inputPath, input, { mode: 0o600 });

    const launch =
      this.profile === "container"
        ? this.containerLaunch(message, context, inputPath)
        : {
            args: [
              launcherPath("sandboxLauncher.js"),
              this.entryPath,
              String(this.wallClockMs),
              String(this.maxResponseBytes),
              inputPath,
            ],
            // Deny by default: exactly the allowlisted names, nothing inherited.
            env: this.childEnvironment(message),
          };

    const spawned = spawnSync(this.nodeExecutable, launch.args, {
      cwd: context.operationRoot,
      env: launch.env,
      // A hard ceiling above the supervisor's own deadline, so a wedged
      // supervisor cannot hang the Lab either. The container supervisor gets a
      // larger constant because it makes five bounded control-plane calls the
      // local one does not — create, top, kill, inspect and remove — and a
      // ceiling that fired during teardown would abandon a live container.
      timeout:
        this.wallClockMs * 3 +
        (this.profile === "container" ? CONTAINER_SUPERVISOR_CEILING_MS : SUPERVISOR_CEILING_MS),
      maxBuffer: this.maxResponseBytes + 1024 * 1024,
      killSignal: "SIGKILL",
    });

    const stdout = spawned.stdout ?? Buffer.alloc(0);
    const stderrText = (spawned.stderr ?? Buffer.alloc(0)).toString("utf8");
    const report = parseSupervisorReport(stderrText);

    if (!report) {
      // The supervisor itself did not report, which under the container profile
      // means it was killed before it could tear down — the host's own ceiling
      // fires, `spawnSync` SIGKILLs it, and the container it created outlives
      // it with nothing watching. The supervisor cannot clean that up, by
      // definition, so the host reaps by the run-scoped name it chose. Without
      // this, the profile's `teardown-and-residue-inspection` claim would hold
      // on every path except the one where teardown was interrupted.
      if (this.profile === "container") {
        spawnSync(
          (this.containerActivation as ContainerProfileActivation).launcher.runtimeBinary,
          ["rm", "--force", containerInvocationName(this.runId, context.invocationId)],
          { timeout: 30_000, killSignal: "SIGKILL", env: runtimeCliEnvironment() },
        );
      }
      // Treat it as a crash rather than guessing an outcome from an exit code
      // the adapter may have influenced.
      return {
        outcome: "crashed",
        processTreeTerminated: false,
        terminatedDescendantCount: 0,
        requestBytes,
        responseBytes: stdout.byteLength,
        stdoutBytes: stdout.byteLength,
        stderrBytes: Buffer.byteLength(stderrText, "utf8"),
        wallClockMs: this.wallClockMs,
        stderrText: stderrText.slice(0, 2048),
      };
    }

    const common = {
      processTreeTerminated: report.process_tree_terminated,
      terminatedDescendantCount: report.terminated_descendant_count,
      requestBytes,
      responseBytes: report.stdout_bytes,
      stdoutBytes: report.stdout_bytes,
      stderrBytes: report.stderr_bytes,
      wallClockMs: report.wall_clock_ms,
      stderrText: report.stderr_excerpt,
      ...(report.exit_status === null ? {} : { exitStatus: report.exit_status }),
      ...(report.termination_signal === null
        ? {}
        : { terminationSignal: report.termination_signal }),
      ...(report.container_termination === undefined
        ? {}
        : { containerTermination: report.container_termination }),
    };

    // A container the runtime still knows about after removal was ordered is
    // residue, and residue is a refusal here rather than a cleanup note: the
    // `teardown-and-residue-inspection` control is one of the twenty this
    // profile claims, and a run that left something behind did not hold it.
    if (report.container_termination?.residue_after_removal === true) {
      return { ...common, outcome: "refused", refusalCode: CODES.RESIDUE_DETECTED };
    }

    if (report.outcome === "timed_out") return { ...common, outcome: "timed_out" };
    if (report.outcome === "refused") {
      return {
        ...common,
        outcome: "refused",
        refusalCode: report.refusal_code ?? CODES.ADAPTER_RESPONSE_OVERSIZED,
      };
    }

    let negotiation: AdapterProtocolNegotiationV1 | AdapterProtocolNegotiationV2 | undefined;
    let response: AdapterResponseMessage | AdapterResponseMessageV2 | undefined;
    let refusalCode: string | undefined;
    try {
      let buffer = stdout;
      for (;;) {
        const frame = decodeFrame(buffer, this.maxResponseBytes);
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        const value = frame.value as { kind?: string };
        if (value.kind === "negotiation") {
          negotiation = this.assertNegotiation(value);
        } else if (value.kind === "response") {
          // Validate the complete response frame against its (closed) shape
          // before any field is read or any array iterated — a hostile adapter
          // that omits an array must yield a typed adapter refusal, never an
          // untyped `TypeError` on the production path (P2-6, §11.2).
          response = local
            ? assertAdapterResponseShapeV2(value)
            : assertAdapterResponseShape(value);
        } else {
          throw new Erl2Error(
            CODES.ADAPTER_PROTOCOL_FRAME_INVALID,
            `adapter sent an unknown frame kind ${String(value.kind).slice(0, 32)}`,
            { owner: "adapter" },
          );
        }
      }
      if (!negotiation) refusalCode = CODES.ADAPTER_PROTOCOL_VERSION_MISMATCH;
    } catch (cause) {
      refusalCode = cause instanceof Erl2Error ? cause.code : CODES.ADAPTER_PROTOCOL_FRAME_INVALID;
    }

    const outcome: RawExchange["outcome"] =
      refusalCode !== undefined
        ? "refused"
        : response === undefined || report.outcome !== "completed"
          ? "crashed"
          : "completed";

    return {
      ...common,
      ...(negotiation === undefined ? {} : { negotiation }),
      ...(response === undefined ? {} : { response }),
      outcome,
      ...(refusalCode === undefined ? {} : { refusalCode }),
    };
  }

  /**
   * Builds the container supervisor's invocation and its host-authored spec.
   *
   * Everything the supervisor will apply is decided here and written to a file
   * it reads: the image, the flag vector, every mount, the adapter's
   * container-side entry path, the deadline and the response bound. The
   * supervisor adds nothing — that is what keeps it the same kind of thing as
   * the local one, a courier with a stopwatch rather than a second place where
   * the Lab decides what a subject may reach.
   */
  private containerLaunch(
    message: HostOperationMessage | HostOperationMessageV2,
    context: ExchangeContext,
    inputPath: string,
  ): { readonly args: readonly string[]; readonly env: Record<string, string> } {
    const activation = this.containerActivation as ContainerProfileActivation;
    const adapterPackage = this.containerAdapterPackage as NonNullable<
      AdapterHostOptions["containerAdapterPackage"]
    >;
    const packageRoot = path.resolve(adapterPackage.packageRoot);

    const mounts: ContainerSupervisorSpec["mounts"] = [
      { hostPath: packageRoot, containerPath: CONTAINER_APP_ROOT, readOnly: true },
      ...adapterPackage.moduleDirectories.map((module) => ({
        hostPath: path.resolve(module.hostPath),
        containerPath: `${CONTAINER_MODULES_ROOT}/${module.name}`,
        readOnly: true,
      })),
      ...this.mounts.map((mount) => ({
        hostPath: path.resolve(mount.absolutePath),
        containerPath: `${CONTAINER_MOUNTS_ROOT}/${mount.mountId}`,
        readOnly: true,
      })),
      { hostPath: context.outputDirectory, containerPath: CONTAINER_OUTPUT_ROOT, readOnly: false },
      {
        hostPath: context.diagnosticsDirectory,
        containerPath: CONTAINER_DIAGNOSTICS_ROOT,
        readOnly: false,
      },
    ];

    const spec: ContainerSupervisorSpec = {
      runtimeBinary: activation.launcher.runtimeBinary,
      imageReference: activation.lock.image_reference,
      imageDigest: activation.lock.image_digest,
      containerName: containerInvocationName(this.runId, context.invocationId),
      hardenedFlags: [...HARDENED_CONTAINER_RUN_FLAGS],
      mounts,
      // The deny-by-default environment, applied by the runtime rather than by
      // handing the adapter a scrubbed copy of this process's environment.
      // Strictly stronger: there is no environment to scrub, because the
      // adapter no longer shares one with anything on this host.
      environment: this.childEnvironment(message),
      entryPath: `${CONTAINER_APP_ROOT}/${path
        .relative(packageRoot, this.entryPath)
        .replaceAll("\\", "/")}`,
      // Read-only on purpose: a writable working directory invites relative
      // writes that land somewhere the host never reads back.
      workingDirectory: CONTAINER_APP_ROOT,
      deadlineMs: this.wallClockMs,
      maxResponseBytes: this.maxResponseBytes,
      inputPath,
    };
    const specPath = path.join(context.operationRoot, "container-spec.json");
    writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });

    return {
      args: [launcherPath("containerSupervisor.js"), specPath],
      // The *supervisor* is Lab code and needs to reach the runtime daemon; the
      // *adapter* gets the three allowlisted names above and nothing else. The
      // two environments are separated by the container boundary, which is the
      // point of the profile.
      env: runtimeCliEnvironment(),
    };
  }

  private childEnvironment(message: HostOperationMessage | HostOperationMessageV2): Record<string, string> {
    const local = "execution_id" in message;
    const env: Record<string, string> = local
      ? {
          ERL2_ADAPTER_PROTOCOL_VERSION: ADAPTER_PROTOCOL_VERSION_V2,
          ERL2_EXECUTION_ID: this.runId,
          ERL2_EXECUTION_MODE: ADAPTER_LOCAL_EXECUTION_MODE,
          ERL2_OPERATION_ID: message.operation_id,
        }
      : {
          ERL2_ADAPTER_PROTOCOL_VERSION: ADAPTER_PROTOCOL_VERSION,
          ERL2_RUN_ID: this.runId,
          ERL2_OPERATION_ID: message.operation_id,
        };
    assertEnvironmentAllowlisted(
      env,
      local ? LOCAL_OBSERVATION_ENVIRONMENT_VARIABLE_NAMES : ALLOWED_ENVIRONMENT_VARIABLE_NAMES,
    );
    return env;
  }

  private assertNegotiation(
    value: { kind?: string },
  ): AdapterProtocolNegotiationV1 | AdapterProtocolNegotiationV2 {
    if (this.protocolVersion === ADAPTER_PROTOCOL_VERSION_V2) {
      const raw = value as unknown as {
        kind?: string;
        schema_version?: string;
        selected_protocol_version?: string;
        execution_mode?: string;
        adapter_id?: string;
        adapter_version?: string;
        supported_operations?: string[];
        supported_package_kinds?: string[];
      };
      const allowed = [
        "kind", "schema_version", "selected_protocol_version", "execution_mode", "adapter_id",
        "adapter_version", "supported_operations", "supported_package_kinds",
      ];
      const unknown = Object.keys(value).find((key) => !allowed.includes(key));
      if (unknown !== undefined || raw.schema_version !== "adapter-negotiation-response/v2") {
        throw new Erl2Error(
          CODES.ADAPTER_PROTOCOL_FRAME_INVALID,
          `malformed V2 negotiation${unknown === undefined ? "" : ` field ${unknown}`}`,
          { owner: "adapter" },
        );
      }
      if (raw.selected_protocol_version === ADAPTER_PROTOCOL_VERSION) {
        throw new Erl2Error(
          CODES.ADAPTER_PROTOCOL_DOWNGRADE_REFUSED,
          "the adapter returned V1 to a V2-only local offer",
          { owner: "adapter" },
        );
      }
      if (raw.selected_protocol_version !== ADAPTER_PROTOCOL_VERSION_V2) {
        throw new Erl2Error(
          CODES.ADAPTER_PROTOCOL_VERSION_MISMATCH,
          `adapter selected unknown protocol ${String(raw.selected_protocol_version).slice(0, 64)}`,
          { owner: "adapter" },
        );
      }
      if (raw.execution_mode !== ADAPTER_LOCAL_EXECUTION_MODE) {
        throw new Erl2Error(
          CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED,
          `adapter selected unsupported mode ${String(raw.execution_mode).slice(0, 64)}`,
          { owner: "adapter" },
        );
      }
      if (raw.adapter_id !== this.manifest.adapter_id || raw.adapter_version !== this.manifest.version) {
        throw new Erl2Error(
          CODES.ADAPTER_IDENTITY_MISMATCH,
          "the running V2 adapter does not match its certified manifest identity",
          { owner: "adapter" },
        );
      }
      const profile = this.localScope as LocalAdapterScopeV2;
      assertExactStringSet(raw.supported_operations, profile.operations, "operations");
      assertExactStringSet(
        raw.supported_package_kinds,
        profile.supported_package_kinds,
        "package kinds",
      );
      const base = {
        schema_version: "adapter-protocol-negotiation/v2" as const,
        execution_id: this.runId,
        adapter_manifest_hash: this.manifest.core_hash,
        offered_protocol_versions: [ADAPTER_PROTOCOL_VERSION_V2] as const,
        required_execution_mode: ADAPTER_LOCAL_EXECUTION_MODE,
        selected_protocol_version: ADAPTER_PROTOCOL_VERSION_V2,
        execution_mode: ADAPTER_LOCAL_EXECUTION_MODE,
        adapter_id: this.manifest.adapter_id,
        adapter_version: this.manifest.version,
        adapter_artifact_hash: this.manifest.adapter_artifact_hash,
        supported_operations: [...profile.operations],
        supported_package_kinds: [...profile.supported_package_kinds],
        max_request_bytes: this.maxRequestBytes,
        max_response_bytes: this.maxResponseBytes,
        negotiated_at: this.clock.now(),
      };
      return assertContract<AdapterProtocolNegotiationV2>("AdapterProtocolNegotiationV2", {
        ...base,
        core_hash: coreHash(base),
      });
    }
    const raw = value as unknown as {
      protocol_version?: string;
      adapter_id?: string;
      adapter_version?: string;
      supported_operations?: string[];
      supported_package_kinds?: string[];
    };
    if (raw.protocol_version !== ADAPTER_PROTOCOL_VERSION) {
      throw new Erl2Error(
        CODES.ADAPTER_PROTOCOL_VERSION_MISMATCH,
        `adapter negotiated protocol ${String(raw.protocol_version).slice(0, 64)}; the host offers only ${ADAPTER_PROTOCOL_VERSION}`,
        { owner: "adapter" },
      );
    }
    const manifest = this.manifest as SubjectAdapterManifestV1;
    if (raw.adapter_id !== manifest.adapter_id || raw.adapter_version !== manifest.version) {
      throw new Erl2Error(
        CODES.ADAPTER_IDENTITY_MISMATCH,
        "the running adapter does not match its certified manifest identity",
        { owner: "adapter" },
      );
    }
    const base = {
      schema_version: "adapter-protocol-negotiation/v1" as const,
      run_id: this.runId,
      adapter_manifest_hash: manifest.core_hash,
      host_protocol_version: ADAPTER_PROTOCOL_VERSION,
      adapter_protocol_version: ADAPTER_PROTOCOL_VERSION,
      adapter_id: manifest.adapter_id,
      adapter_version: manifest.version,
      adapter_artifact_hash: manifest.adapter_artifact_hash,
      supported_operations: (raw.supported_operations ?? []) as never,
      supported_package_kinds: (raw.supported_package_kinds ?? []) as never,
      max_request_bytes: this.maxRequestBytes,
      max_response_bytes: this.maxResponseBytes,
      negotiated_at: this.clock.now(),
    };
    return assertContract<AdapterProtocolNegotiationV1>("AdapterProtocolNegotiationV1", {
      ...base,
      core_hash: coreHash(base),
    });
  }
}

/** Second-precision UTC instant `ms` after `now`, in the contract's shape. */
export function instantAfter(now: Instant, ms: number): Instant {
  return `${new Date(Date.parse(now) + ms).toISOString().slice(0, 19)}Z`;
}

/** Absolute path of a compiled supervisor, resolved from this module. */
function launcherPath(supervisor: "sandboxLauncher.js" | "containerSupervisor.js"): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), supervisor);
}

/** Extracts the single supervisor line from the captured stderr. */
function parseSupervisorReport(stderrText: string): ContainerSupervisorReport | undefined {
  const index = stderrText.lastIndexOf(SUPERVISOR_PREFIX);
  if (index < 0) return undefined;
  const line = stderrText.slice(index + SUPERVISOR_PREFIX.length).split("\n")[0] ?? "";
  try {
    return JSON.parse(line) as ContainerSupervisorReport;
  } catch {
    return undefined;
  }
}

/** Ceiling above the local supervisor's own deadline, for a wedged supervisor. */
const SUPERVISOR_CEILING_MS = 5_000;

/**
 * The same ceiling for the container supervisor.
 *
 * Larger because five bounded control-plane calls sit between the adapter
 * exiting and the report being written, and a ceiling that fired in the middle
 * of teardown would leave a container running with nothing watching it.
 */
const CONTAINER_SUPERVISOR_CEILING_MS = 150_000;

/** Host-side paths one dispatch needs, none of which the adapter is told about. */
interface ExchangeContext {
  readonly operationRoot: string;
  readonly outputDirectory: string;
  readonly diagnosticsDirectory: string;
  readonly invocationId: string;
}

function assertExactStringSet(
  actual: readonly string[] | undefined,
  expected: readonly string[],
  label: string,
): void {
  if (
    actual === undefined ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Erl2Error(
      CODES.ADAPTER_CERTIFICATION_SCOPE_MISMATCH,
      `adapter negotiation ${label} do not exactly match the selected certified profile`,
      { owner: "adapter" },
    );
  }
}

/** The checkpoint the host dispatched, which the adapter's report must repeat. */
function residueCheckpointOf(payload: AdapterRequestV2["operation_payload"]): string {
  const checkpoint = (payload as unknown as Record<string, unknown>)["checkpoint"];
  return typeof checkpoint === "string" ? checkpoint : "";
}

function localPackageKind(
  payload: AdapterRequestV2["operation_payload"],
): "archive" | "oci" | "native" | "bundle" | undefined {
  const record = payload as unknown as Record<string, unknown>;
  const kind = record["package_kind"] ?? record["expected_package_kind"];
  return kind === "archive" || kind === "oci" || kind === "native" || kind === "bundle"
    ? kind
    : undefined;
}
