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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_PROTOCOL_VERSION,
  assertContract,
  CODES,
  decodeFrame,
  encodeFrame,
  Erl2Error,
  type AdapterCapabilityGrantV1,
  type AdapterFailureReportV1,
  type AdapterOperation,
  type AdapterProtocolNegotiationV1,
  type AdapterResponseEnvelopeV1,
  type AdapterResponseMessage,
  type ArtifactRef,
  type CompensationReceiptV1,
  type CredentialUseReceiptV1,
  type EgressAllowlistPolicyV1,
  type EgressDecisionReceiptV1,
  type Hash,
  type HostOperationMessage,
  type Instant,
  type MutationIntentV1,
  type MutationReceiptV1,
  type SandboxInvocationManifestV1,
  type SandboxInvocationResultV1,
  type SubjectAdapterManifestV1,
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
import { CredentialBroker } from "./credentials.js";
import { decideEgress, denyByDefaultEgressPolicy } from "./egress.js";
import { MutationLedger } from "./mutations.js";
import { assertAdapterResponseShape } from "./responseShape.js";
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
  ALLOWED_ENVIRONMENT_VARIABLE_NAMES,
  sandboxControlReport,
  type SandboxProfileId,
} from "./sandbox.js";
import { SUPERVISOR_PREFIX, type SupervisorReport } from "./sandboxLauncher.js";

export interface AdapterMount {
  readonly mountId: string;
  readonly absolutePath: string;
  readonly logicalPath: string;
  readonly purpose: "subject-visible-input" | "canonical-evidence" | "frozen-package";
}

export interface AdapterHostOptions {
  readonly runId: string;
  readonly adapterManifest: SubjectAdapterManifestV1;
  /** Absolute path of the adapter's entry module. Its digest is pinned. */
  readonly adapterEntryPath: string;
  readonly workspaceRoot: string;
  readonly store: ArtifactStore;
  readonly clock: Clock;
  readonly profile?: SandboxProfileId;
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

/** The retained root every host adjudication record for one operation lives under. */
const HOST_EVIDENCE_LOGICAL_ROOT = "retained/adapter";

/** A four-digit ordinal, so a repeated record kind gets a stable, safe file name. */
function ordinal(index: number): string {
  return String(index + 1).padStart(4, "0");
}

interface RawExchange {
  readonly negotiation?: AdapterProtocolNegotiationV1;
  readonly response?: AdapterResponseMessage;
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

export class AdapterHost {
  readonly runId: string;
  readonly manifest: SubjectAdapterManifestV1;
  readonly credentials = new CredentialBroker();
  readonly egressPolicy: EgressAllowlistPolicyV1;

  private readonly entryPath: string;
  private readonly workspaceRoot: string;
  private readonly store: ArtifactStore;
  private readonly clock: Clock;
  private readonly profile: SandboxProfileId;
  private readonly bounds: OutputBounds;
  private readonly wallClockMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly mounts: readonly AdapterMount[];
  private readonly permittedMutationPrefixes: readonly string[];
  private readonly nodeExecutable: string;
  /** See `AdapterHostOptions.evidenceFixtureWallClockMs`. Undefined in production. */
  private readonly evidenceFixtureWallClockMs: number | undefined;
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
    this.bounds = options.bounds ?? DEFAULT_OUTPUT_BOUNDS;
    this.wallClockMs = options.wallClockMs ?? 30_000;
    this.maxRequestBytes = options.maxRequestBytes ?? 1024 * 1024;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.mounts = options.mounts ?? [];
    this.permittedMutationPrefixes = options.permittedMutationPrefixes ?? ["adapter-workspace/"];
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.evidenceFixtureWallClockMs = options.evidenceFixtureWallClockMs;

    if (this.manifest.protocol_version !== ADAPTER_PROTOCOL_VERSION) {
      throw new Erl2Error(
        CODES.ADAPTER_PROTOCOL_VERSION_MISMATCH,
        `adapter manifest declares protocol ${this.manifest.protocol_version}`,
        { owner: "adapter" },
      );
    }
    assertManifestCapabilitiesUnprivileged(this.manifest.required_broker_capabilities);
    for (const mount of this.mounts) {
      assertMountPermitted(path.resolve(mount.absolutePath), process.env["HOME"]);
    }
    if (!existsSync(this.entryPath)) {
      throw new Erl2Error(
        CODES.ADAPTER_IDENTITY_MISMATCH,
        `adapter entry ${this.entryPath} does not exist`,
        { owner: "adapter" },
      );
    }
    this.egressPolicy = options.egressPolicy ?? denyByDefaultEgressPolicy("adapter-default-deny");
    mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
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
  }): AdapterOperationResult {
    assertNoExecutionAfterOutputFreeze(this.outputFrozen, `adapter operation ${input.operation}`);
    if (!this.manifest.operations.includes(input.operation)) {
      throw new Erl2Error(
        CODES.ADAPTER_OPERATION_UNSUPPORTED,
        `adapter ${this.manifest.adapter_id} does not declare operation ${input.operation}`,
        { owner: "adapter" },
      );
    }
    // The request never carries an oracle field, checked on the Lab side before
    // it can reach the process boundary.
    assertNoOracleFields(`${input.operation} adapter request`, input.request);

    const requested = input.requestedCapabilityIds ?? this.manifest.required_broker_capabilities;
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

    const deadline = instantAfter(now, this.wallClockMs);

    const sandboxManifest = this.buildSandboxManifest({
      invocationId,
      operationId: input.operationId,
      outputDirectory,
      deadline,
      createdAt: now,
      capabilityIds: capabilityGrant.granted_capability_ids,
    });
    assertControlReportMatchesProfile(sandboxManifest, this.profile);

    // Mounts are fingerprinted *and* scanned before the adapter can see them.
    const mountFingerprints = this.mounts.map((m) => ({
      mountId: m.mountId,
      before: treeFingerprint(path.resolve(m.absolutePath), { mountId: m.mountId }),
    }));

    const message: HostOperationMessage = {
      kind: "operation",
      protocol_version: ADAPTER_PROTOCOL_VERSION,
      run_id: this.runId,
      operation: input.operation,
      operation_id: input.operationId,
      request: input.request,
      mounts: this.mounts.map((m) => ({
        mount_id: m.mountId,
        absolute_path: path.resolve(m.absolutePath),
        purpose: m.purpose,
      })),
      output_directory: outputDirectory,
      diagnostics_directory: diagnosticsDirectory,
      granted_capability_ids: capabilityGrant.granted_capability_ids,
      deadline,
    };

    const exchange = this.exchange(message);

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
    if (
      response.run_id !== this.runId ||
      response.operation !== input.operation ||
      response.operation_id !== input.operationId
    ) {
      throw new Erl2Error(
        CODES.ADAPTER_PROTOCOL_RESPONSE_MISMATCH,
        "adapter response does not repeat the dispatched identifiers",
        { owner: "adapter" },
      );
    }

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

    const envelopeBase = {
      schema_version: "adapter-response-envelope/v1" as const,
      protocol_version: ADAPTER_PROTOCOL_VERSION,
      run_id: this.runId,
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
    const envelope = assertContract<AdapterResponseEnvelopeV1>("AdapterResponseEnvelopeV1", {
      ...envelopeBase,
      core_hash: coreHash(envelopeBase),
    });

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
      logicalPrefix: adapterOutputPrefix(input.operationId),
      bounds: this.bounds,
    });

    const retained = this.retainHostEvidence({
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

    return {
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
      outputDirectory,
      retained,
    };
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
    readonly operationId: string;
    readonly envelope: AdapterResponseEnvelopeV1;
    readonly sandboxManifest: SandboxInvocationManifestV1;
    readonly sandboxResult: SandboxInvocationResultV1;
    readonly capabilityGrant: AdapterCapabilityGrantV1;
    readonly diagnostics: SubjectDiagnosticsManifestV1;
    readonly credentialUseReceipts: readonly CredentialUseReceiptV1[];
    readonly egressReceipts: readonly EgressDecisionReceiptV1[];
    readonly mutationIntents: readonly MutationIntentV1[];
    readonly mutationReceipts: readonly MutationReceiptV1[];
    readonly compensationReceipts: readonly CompensationReceiptV1[];
    readonly outputRefs: readonly ArtifactRef[];
  }): SubjectStepEvidence {
    const root = `${HOST_EVIDENCE_LOGICAL_ROOT}/${input.operationId}`;
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
        "adapter-response-envelope",
        "adapter-response-envelope/v1",
        input.envelope,
      ),
      freeze(
        "sandbox-invocation-manifest",
        "adapter-sandbox-invocation-manifest",
        "sandbox-invocation-manifest/v1",
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
  }): SandboxInvocationManifestV1 {
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
      environment_variable_names: [...ALLOWED_ENVIRONMENT_VARIABLE_NAMES],
      enforced_controls: sandboxControlReport(this.profile).map((c) => ({
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
  private exchange(message: HostOperationMessage): RawExchange {
    const negotiateFrame = encodeFrame(
      {
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
    // bytes stay inspectable after a crash.
    const inputPath = path.join(path.dirname(message.output_directory), "request.frames");
    writeFileSync(inputPath, input, { mode: 0o600 });

    const spawned = spawnSync(
      this.nodeExecutable,
      [
        launcherPath(),
        this.entryPath,
        String(this.wallClockMs),
        String(this.maxResponseBytes),
        inputPath,
      ],
      {
        cwd: path.dirname(message.output_directory),
        // Deny by default: exactly the allowlisted names, nothing inherited.
        env: this.childEnvironment(message),
        // A hard ceiling above the supervisor's own deadline, so a wedged
        // supervisor cannot hang the Lab either.
        timeout: this.wallClockMs * 3 + 5_000,
        maxBuffer: this.maxResponseBytes + 1024 * 1024,
        killSignal: "SIGKILL",
      },
    );

    const stdout = spawned.stdout ?? Buffer.alloc(0);
    const stderrText = (spawned.stderr ?? Buffer.alloc(0)).toString("utf8");
    const report = parseSupervisorReport(stderrText);

    if (!report) {
      // The supervisor itself did not report: treat it as a crash rather than
      // guessing an outcome from an exit code the adapter may have influenced.
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
    };

    if (report.outcome === "timed_out") return { ...common, outcome: "timed_out" };
    if (report.outcome === "refused") {
      return {
        ...common,
        outcome: "refused",
        refusalCode: report.refusal_code ?? CODES.ADAPTER_RESPONSE_OVERSIZED,
      };
    }

    let negotiation: AdapterProtocolNegotiationV1 | undefined;
    let response: AdapterResponseMessage | undefined;
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
          response = assertAdapterResponseShape(value);
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

  private childEnvironment(message: HostOperationMessage): Record<string, string> {
    const env: Record<string, string> = {
      ERL2_ADAPTER_PROTOCOL_VERSION: ADAPTER_PROTOCOL_VERSION,
      ERL2_RUN_ID: this.runId,
      ERL2_OPERATION_ID: message.operation_id,
    };
    assertEnvironmentAllowlisted(env);
    return env;
  }

  private assertNegotiation(value: { kind?: string }): AdapterProtocolNegotiationV1 {
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
    if (raw.adapter_id !== this.manifest.adapter_id || raw.adapter_version !== this.manifest.version) {
      throw new Erl2Error(
        CODES.ADAPTER_IDENTITY_MISMATCH,
        "the running adapter does not match its certified manifest identity",
        { owner: "adapter" },
      );
    }
    const base = {
      schema_version: "adapter-protocol-negotiation/v1" as const,
      run_id: this.runId,
      adapter_manifest_hash: this.manifest.core_hash,
      host_protocol_version: ADAPTER_PROTOCOL_VERSION,
      adapter_protocol_version: ADAPTER_PROTOCOL_VERSION,
      adapter_id: this.manifest.adapter_id,
      adapter_version: this.manifest.version,
      adapter_artifact_hash: this.manifest.adapter_artifact_hash,
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

/** Absolute path of the compiled supervisor, resolved from this module. */
function launcherPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "sandboxLauncher.js");
}

/** Extracts the single supervisor line from the captured stderr. */
function parseSupervisorReport(stderrText: string): SupervisorReport | undefined {
  const index = stderrText.lastIndexOf(SUPERVISOR_PREFIX);
  if (index < 0) return undefined;
  const line = stderrText.slice(index + SUPERVISOR_PREFIX.length).split("\n")[0] ?? "";
  try {
    return JSON.parse(line) as SupervisorReport;
  } catch {
    return undefined;
  }
}
