/**
 * The fake environment driver (implementation plan §9.1 S3.3).
 *
 * It is deterministic, needs no substrate, and models every lifecycle and
 * failure path the Compose driver will have to handle: clean provision,
 * partial provision, baseline contamination, mutation and compensation,
 * restoration failure, teardown failure and residue.
 *
 * It satisfies the same `EnvironmentDriver` contract suite the Compose driver
 * must satisfy. While ERL2-OQ-005 is unresolved this is the *only* enabled
 * driver, and it is the one the Slice 3 exit gate is proven against.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type EnvironmentBaselineFingerprintV1,
  type EnvironmentDriverManifestV1,
  type EnvironmentOperationReceiptV1,
  type EnvironmentProbeResultV1,
  type EnvironmentResourceInventoryV1,
  type EnvironmentResourceV1,
  type Hash,
} from "@erl2/contracts";
import { coreHash, domainHash, HASH_DOMAINS, sealSigned, type SigningKey } from "@erl2/integrity";
import type { Clock } from "../runtime/seams.js";
import { buildBaselineFingerprint, type EvidenceSourceState } from "./cleanControl.js";
import {
  MemorySubstrateStore,
  type SubstrateInstance,
  type SubstrateState,
  type SubstrateStore,
} from "./substrate.js";
import {
  assertDriverEnabled,
  assertNarrowSelector,
  assertOperationSupported,
  assertOwnedByRun,
  resourceIdentityHash,
  type DestroyRequest,
  type DestroyResourceRequest,
  type DestroyResult,
  type EnvironmentDriver,
  type MutateRequest,
  type ProbeRequest,
  type ProvisionRequest,
  type ProvisionResult,
  type RestoreRequest,
} from "./driver.js";

/** Scripted faults, so every failure branch is reachable in a test. */
export interface FakeDriverFaults {
  readonly provisionPartialAfter?: number;
  readonly contaminationCodes?: readonly string[];
  readonly failProbeIds?: readonly string[];
  readonly failRestore?: boolean;
  /**
   * The compensation returns `succeeded` and reverts nothing.
   *
   * This is review P1-4 as a scripted fault. It is not a variant of
   * `failRestore`: a *failed* restoration is honest and already routes to
   * emergency cleanup, while this one lies — and until ADR-ERL2-026 the lie was
   * accepted, because the baseline fingerprint and the resource inventory are
   * both blind to a mutation.
   */
  readonly restoreWithoutReverting?: boolean;
  /**
   * A mutation the environment already carried when the run provisioned into
   * it, which the run never applied and holds no receipt for.
   *
   * An ordinary compensation then clears it along with the run's own, which is
   * the `collateral` case: state the compensation was never asked to revert,
   * reverted anyway. The environment did not return to its baseline either.
   */
  readonly preexistingMutationId?: string;
  readonly failTeardown?: boolean;
  /** Resource ids the driver refuses to destroy, producing residue. */
  readonly residualResourceIds?: readonly string[];
  /** Resources it claims are shared, so the frontier must contain rather than destroy. */
  readonly sharedResourceIds?: readonly string[];
}

export interface FakeDriverOptions {
  readonly clock: Clock;
  readonly signingKey: SigningKey;
  readonly archetypeHash: Hash;
  readonly faults?: FakeDriverFaults;
  /** Resource kinds this archetype provisions, in order. */
  readonly resourceKinds?: readonly string[];
  readonly evidenceSourceIds?: readonly string[];
  /**
   * Where the driver remembers its substrate.
   *
   * Omitted, it remembers only within this process — right for the in-process
   * contract suite, wrong for the CLI, where provision, restore and destroy are
   * three separate processes and an in-process map makes a fresh `destroy`
   * report a clean teardown over resources it never looked at.
   */
  readonly substrate?: SubstrateStore;
}

const DEFAULT_KINDS = ["project", "network", "volume", "container", "port"] as const;
const DEFAULT_SOURCES = ["deployment-log", "service-metric", "change-record"] as const;

export function fakeDriverManifest(signingKey: SigningKey, kinds: readonly string[]): EnvironmentDriverManifestV1 {
  return assertContract<EnvironmentDriverManifestV1>(
    "EnvironmentDriverManifestV1",
    sealSigned(
      {
        schema_version: "environment-driver-manifest/v1" as const,
        driver_id: "fake-driver",
        driver_kind: "fake" as const,
        version: "0.1.0",
        supported_operations: ["provision", "probe", "mutate", "restore", "destroy", "inspect"] as const,
        resource_kinds: [...kinds],
        enabled: true,
      },
      signingKey,
    ),
  );
}

export class FakeEnvironmentDriver implements EnvironmentDriver {
  readonly manifest: EnvironmentDriverManifestV1;
  private readonly clock: Clock;
  private readonly faults: FakeDriverFaults;
  private readonly kinds: readonly string[];
  private readonly sourceIds: readonly string[];
  private readonly archetypeHash: Hash;
  private readonly substrate: SubstrateStore;

  constructor(options: FakeDriverOptions) {
    this.clock = options.clock;
    this.faults = options.faults ?? {};
    this.kinds = options.resourceKinds ?? DEFAULT_KINDS;
    this.sourceIds = options.evidenceSourceIds ?? DEFAULT_SOURCES;
    this.archetypeHash = options.archetypeHash;
    this.manifest = fakeDriverManifest(options.signingKey, this.kinds);
    this.substrate = options.substrate ?? new MemorySubstrateStore();
  }

  /** What the substrate says about this run, or the empty substrate. */
  private state(runId: string): SubstrateState {
    return this.substrate.load(runId) ?? { resources: [], mutations: [] };
  }

  /** Whether this run has ever been provisioned on this substrate. */
  private provisioned(runId: string): boolean {
    return this.substrate.load(runId) !== undefined;
  }

  private liveResources(runId: string): readonly EnvironmentResourceV1[] {
    return this.state(runId).resources;
  }

  private liveInstanceHash(runId: string): Hash {
    return this.state(runId).instanceHash ?? this.archetypeHash;
  }

  private appliedMutations(runId: string): readonly string[] {
    return this.state(runId).mutations;
  }

  /**
   * What the substrate says is applied **right now** (ADR-ERL2-026 §4.1).
   *
   * The Lab reads this before compensating and again afterwards, and derives
   * restoration from the difference rather than from the compensation receipt's
   * own `status`. A driver that reported `succeeded` and cleared nothing used to
   * produce `passed: true`, because the baseline fingerprint measures resource
   * health and a mutation leaves resource health alone (review P1-4).
   */
  observedMutations(runId: string): readonly string[] {
    return [...this.appliedMutations(runId)].sort();
  }

  /**
   * The receipt of an operation this driver already completed for the run.
   *
   * The driver's own operation log, which is what makes restart reconciliation
   * able to *adopt* a prior result rather than re-dispatch or fail closed
   * (ADR-ERL2-024 §4.3). A real driver has the same thing under a different
   * name: a labelled Compose project, a namespace annotation.
   */
  completedOperation(runId: string, operationId: string): EnvironmentOperationReceiptV1 | undefined {
    return this.state(runId).operations?.[operationId];
  }

  /** Records a completed operation, so a repeat of the same id is a no-op. */
  private remember(runId: string, receipt: EnvironmentOperationReceiptV1): EnvironmentOperationReceiptV1 {
    this.put(runId, {
      operations: { ...(this.state(runId).operations ?? {}), [receipt.operation_id]: receipt },
    });
    return receipt;
  }

  private put(runId: string, patch: Partial<SubstrateState>): void {
    this.substrate.save(runId, { ...this.state(runId), ...patch });
  }

  private manifestHash(): Hash {
    return coreHash(this.manifest);
  }

  private receipt(options: {
    readonly runId: string;
    readonly operation: EnvironmentOperationReceiptV1["operation"];
    readonly operationId: string;
    readonly targetIdentityHash: Hash;
    readonly before: unknown;
    readonly after: unknown;
    readonly status: "succeeded" | "failed";
    readonly errorCode?: string;
    readonly compensationId?: string;
  }): EnvironmentOperationReceiptV1 {
    const startedAt = this.clock.now();
    const base = {
      schema_version: "environment-operation-receipt/v1" as const,
      run_id: options.runId,
      operation: options.operation,
      operation_id: options.operationId,
      idempotency_key: coreHash({ run: options.runId, op: options.operationId }).slice("sha256:".length),
      driver_manifest_hash: this.manifestHash(),
      target_identity_hash: options.targetIdentityHash,
      before_state_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, options.before),
      after_state_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, options.after),
      ...(options.compensationId === undefined ? {} : { compensation_id: options.compensationId }),
      status: options.status,
      ...(options.errorCode === undefined ? {} : { error_code: options.errorCode }),
      started_at: startedAt,
      ended_at: this.clock.now(),
    };
    return assertContract<EnvironmentOperationReceiptV1>("EnvironmentOperationReceiptV1", {
      ...base,
      core_hash: coreHash(base),
    });
  }

  private resourcesFor(runId: string): EnvironmentResourceV1[] {
    const limit = this.faults.provisionPartialAfter ?? this.kinds.length;
    return this.kinds.slice(0, limit).map((kind) => {
      const runScopedName = `erl2-${kind}-${runId}`;
      return {
        resource_id: `${kind}-${runId.slice(0, 8)}`,
        kind,
        run_scoped_name: runScopedName,
        identity_hash: resourceIdentityHash(runId, kind, runScopedName),
        destroyable: !(this.faults.residualResourceIds ?? []).includes(`${kind}-${runId.slice(0, 8)}`),
        ...((this.faults.sharedResourceIds ?? []).includes(`${kind}-${runId.slice(0, 8)}`)
          ? { shared_with_other_runs: true }
          : {}),
      };
    });
  }

  private inventoryOf(runId: string, resources: readonly EnvironmentResourceV1[]): EnvironmentResourceInventoryV1 {
    const base = {
      schema_version: "environment-resource-inventory/v1" as const,
      run_id: runId,
      environment_instance_hash: this.liveInstanceHash(runId),
      driver_manifest_hash: this.manifestHash(),
      resources: [...resources],
      inventoried_at: this.clock.now(),
    };
    return assertContract<EnvironmentResourceInventoryV1>("EnvironmentResourceInventoryV1", {
      ...base,
      core_hash: coreHash(base),
    });
  }

  substrateInstance(): SubstrateInstance | undefined {
    return this.substrate.instance();
  }

  establishSubstrateInstance(runId: string): SubstrateInstance {
    return this.substrate.establishInstance(runId);
  }

  provision(request: ProvisionRequest): ProvisionResult {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "provision");
    // Idempotent by operation id: a resumed dispatch under the same id returns
    // what the first one did, without creating a second environment.
    const completed = this.completedOperation(request.runId, request.operationId);
    if (completed !== undefined) {
      const live = this.liveResources(request.runId);
      return {
        receipt: completed,
        inventory: this.inventoryOf(request.runId, live),
        environmentInstanceHash: this.liveInstanceHash(request.runId),
        partial: live.length < this.kinds.length,
      };
    }
    if (this.provisioned(request.runId) && this.liveResources(request.runId).length > 0) {
      throw new Erl2Error(CODES.ENV_PROVISION_FAILED, `run ${request.runId} is already provisioned`);
    }
    const resources = this.resourcesFor(request.runId);
    const instanceHash = domainHash(HASH_DOMAINS.DRIVER_STATE, {
      archetype_hash: request.archetypeHash,
      disorder_seed_commitment: request.disorderSeedCommitment,
      run_id: request.runId,
      resource_ids: resources.map((r) => r.resource_id),
    });
    this.put(request.runId, {
      instanceHash,
      resources,
      ...(this.faults.preexistingMutationId === undefined
        ? {}
        : { mutations: [this.faults.preexistingMutationId] }),
    });
    const partial = resources.length < this.kinds.length;

    return {
      receipt: this.remember(request.runId, this.receipt({
        runId: request.runId,
        operation: "provision",
        operationId: request.operationId,
        targetIdentityHash: instanceHash,
        before: { resources: [] },
        after: { resources: resources.map((r) => r.identity_hash) },
        status: partial ? "failed" : "succeeded",
        ...(partial ? { errorCode: CODES.ENV_PROVISION_FAILED } : {}),
      })),
      inventory: this.inventoryOf(request.runId, resources),
      environmentInstanceHash: instanceHash,
      partial,
    };
  }

  probe(request: ProbeRequest): EnvironmentBaselineFingerprintV1 {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "probe");
    const resources = this.liveResources(request.runId);
    const failing = new Set(this.faults.failProbeIds ?? []);
    const probes: EnvironmentProbeResultV1[] = resources.map((resource) => {
      const probeId = `probe-${resource.kind}`;
      const passed = !failing.has(probeId);
      return {
        probe_id: probeId,
        phase: request.phase,
        kind: "health",
        target_resource_id: resource.resource_id,
        passed,
        // The observation deliberately excludes run-scoped identity so two
        // clean runs of the same archetype fingerprint identically.
        observation_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
          kind: resource.kind,
          healthy: passed,
        }),
        ...(passed ? {} : { failure_code: CODES.BASELINE_PROBE_FAILED }),
      };
    });
    const evidenceSourceStates: EvidenceSourceState[] = this.sourceIds.map((source_id) => ({
      source_id,
      state: "complete",
    }));

    return buildBaselineFingerprint({
      runId: request.runId,
      environmentInstanceHash: this.liveInstanceHash(request.runId),
      archetypeHash: this.archetypeHash,
      driverManifestHash: this.manifestHash(),
      probes,
      evidenceSourceStates,
      observedAt: this.clock.now(),
      ...(this.faults.contaminationCodes === undefined
        ? {}
        : { preexistingResidueCodes: this.faults.contaminationCodes }),
    });
  }

  mutate(request: MutateRequest): EnvironmentOperationReceiptV1 {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "mutate");
    const resources = this.liveResources(request.runId);
    const target = resources.find((r) => r.resource_id === request.targetResourceId);
    if (!target) {
      throw new Erl2Error(
        CODES.ENV_FOREIGN_RESOURCE_REJECTED,
        `resource ${request.targetResourceId} is not part of run ${request.runId}`,
      );
    }
    assertOwnedByRun(request.runId, target);
    const already = this.completedOperation(request.runId, request.operationId);
    if (already !== undefined) return already;
    const applied = [...this.appliedMutations(request.runId), request.mutationId];
    this.put(request.runId, { mutations: applied });
    return this.remember(request.runId, this.receipt({
      runId: request.runId,
      operation: "mutate",
      operationId: request.operationId,
      targetIdentityHash: target.identity_hash,
      before: { mutations: applied.slice(0, -1) },
      after: { mutations: applied },
      status: "succeeded",
      compensationId: `compensate-${request.mutationId}`,
    }));
  }

  restore(request: RestoreRequest): EnvironmentOperationReceiptV1 {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "restore");
    const already = this.completedOperation(request.runId, request.operationId);
    if (already !== undefined) return already;
    const applied = this.appliedMutations(request.runId);
    if (this.faults.failRestore === true) {
      return this.remember(request.runId, this.receipt({
        runId: request.runId,
        operation: "restore",
        operationId: request.operationId,
        targetIdentityHash: this.liveInstanceHash(request.runId),
        before: { mutations: applied },
        after: { mutations: applied },
        status: "failed",
        errorCode: CODES.RESTORATION_FAILED,
      }));
    }
    // The scripted lie: a receipt that reads exactly like a clean compensation
    // over a substrate the compensation never touched. It has to be
    // indistinguishable *in the receipt* — that is the whole of P1-4 — and
    // distinguishable only by re-reading the substrate.
    this.put(request.runId, {
      mutations: this.faults.restoreWithoutReverting === true ? applied : [],
    });
    return this.remember(request.runId, this.receipt({
      runId: request.runId,
      operation: "restore",
      operationId: request.operationId,
      targetIdentityHash: this.liveInstanceHash(request.runId),
      before: { mutations: applied },
      after: { mutations: [] },
      status: "succeeded",
    }));
  }

  /**
   * Destroys exactly one owned resource (ADR-ERL2-024 §4.5).
   *
   * This is what lets emergency cleanup attempt each independently safe action
   * on its own, instead of swinging a whole-environment destroy first and
   * classifying the frontier afterwards (review P1-1). A foreign resource in
   * the frontier now fails exactly one action rather than aborting the branch
   * (review P1-5).
   */
  destroyResource(request: DestroyResourceRequest): EnvironmentOperationReceiptV1 {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "destroy");
    const resources = this.liveResources(request.runId);
    const already = this.completedOperation(request.runId, request.operationId);
    if (already !== undefined) return already;
    const target = resources.find((r) => r.resource_id === request.resourceId);
    if (target === undefined) {
      throw new Erl2Error(
        CODES.ENV_FOREIGN_RESOURCE_REJECTED,
        `resource ${request.resourceId} is not part of run ${request.runId}`,
      );
    }
    // Ownership and narrowness are checked for *this* resource only: the whole
    // point of per-resource destruction is that one foreign member does not
    // veto the destruction of the run's own resources.
    assertOwnedByRun(request.runId, target);
    assertNarrowSelector(request.runId, target.run_scoped_name);
    const before = resources.map((r) => r.identity_hash);
    if (!target.destroyable) {
      return this.remember(request.runId, this.receipt({
        runId: request.runId,
        operation: "destroy",
        operationId: request.operationId,
        targetIdentityHash: target.identity_hash,
        before: { resources: before },
        after: { resources: before },
        status: "failed",
        errorCode: CODES.ENV_RESIDUE_DETECTED,
      }));
    }
    if (this.faults.failTeardown === true) {
      return this.remember(request.runId, this.receipt({
        runId: request.runId,
        operation: "destroy",
        operationId: request.operationId,
        targetIdentityHash: target.identity_hash,
        before: { resources: before },
        after: { resources: before },
        status: "failed",
        errorCode: CODES.TEARDOWN_FAILED,
      }));
    }
    const remaining = resources.filter((r) => r.resource_id !== target.resource_id);
    this.put(request.runId, { resources: remaining });
    return this.remember(request.runId, this.receipt({
      runId: request.runId,
      operation: "destroy",
      operationId: request.operationId,
      targetIdentityHash: target.identity_hash,
      before: { resources: before },
      after: { resources: remaining.map((r) => r.identity_hash) },
      status: "succeeded",
    }));
  }

  destroy(request: DestroyRequest): DestroyResult {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "destroy");
    const resources = this.liveResources(request.runId);
    // Cleanup targets exact validated identities; a wildcard selector is refused.
    for (const resource of resources) {
      assertOwnedByRun(request.runId, resource);
      assertNarrowSelector(request.runId, resource.run_scoped_name);
    }
    const alreadyDestroyed = this.completedOperation(request.runId, request.operationId);
    if (alreadyDestroyed !== undefined) {
      return { receipt: alreadyDestroyed, residue: this.liveResources(request.runId) };
    }
    if (this.faults.failTeardown === true) {
      return {
        receipt: this.remember(request.runId, this.receipt({
          runId: request.runId,
          operation: "destroy",
          operationId: request.operationId,
          targetIdentityHash: this.liveInstanceHash(request.runId),
          before: { resources: resources.map((r) => r.identity_hash) },
          after: { resources: resources.map((r) => r.identity_hash) },
          status: "failed",
          errorCode: CODES.TEARDOWN_FAILED,
        })),
        residue: resources,
      };
    }
    const residue = resources.filter((r) => !r.destroyable);
    this.put(request.runId, { resources: residue });
    return {
      receipt: this.remember(request.runId, this.receipt({
        runId: request.runId,
        operation: "destroy",
        operationId: request.operationId,
        targetIdentityHash: this.liveInstanceHash(request.runId),
        before: { resources: resources.map((r) => r.identity_hash) },
        after: { resources: residue.map((r) => r.identity_hash) },
        status: residue.length === 0 ? "succeeded" : "failed",
        ...(residue.length === 0 ? {} : { errorCode: CODES.ENV_RESIDUE_DETECTED }),
      })),
      residue,
    };
  }

  inspect(runId: string): EnvironmentResourceInventoryV1 {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "inspect");
    return this.inventoryOf(runId, this.liveResources(runId));
  }
}
