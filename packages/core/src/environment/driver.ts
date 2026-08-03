/**
 * The environment driver interface (design v2 §8, implementation plan §9.2).
 *
 * Six closed operations, no escape hatch: `provision`, `probe`, `mutate`,
 * `restore`, `destroy`, `inspect`.  A driver never sees truth, judge
 * expectations, selection handles or subject output; it manipulates
 * infrastructure and returns receipts.
 *
 * The fake driver and the Compose driver satisfy the same suite — that is the
 * design's "every abstraction has two uses" rule made executable.  Both uses are
 * real: `ComposeEnvironmentDriver` runs the qualified OQ-005 substrate and is
 * proven against a live daemon by `tests/integration/composeDriverContract.test.ts`,
 * which refuses rather than skips when a caller asked for the live claim.
 */

import {
  CODES,
  Erl2Error,
  type EnvironmentBaselineFingerprintV1,
  type EnvironmentDriverManifestV1,
  type EnvironmentOperationReceiptV1,
  type EnvironmentResourceInventoryV1,
  type EnvironmentResourceV1,
  type Hash,
} from "@erl2/contracts";
import { domainHash, HASH_DOMAINS } from "@erl2/integrity";
import type { SubstrateInstance } from "./substrate.js";

/** Resource identity always embeds the run id (design v2 §22). */
export function resourceIdentityHash(runId: string, kind: string, runScopedName: string): Hash {
  if (!runScopedName.includes(runId)) {
    throw new Erl2Error(
      CODES.ENV_RESOURCE_NOT_RUN_SCOPED,
      `resource name ${runScopedName} does not embed run id ${runId}`,
    );
  }
  return domainHash(HASH_DOMAINS.RESOURCE_IDENTITY, {
    run_id: runId,
    kind,
    run_scoped_name: runScopedName,
  });
}

/**
 * Refuses a resource that is not provably this run's.  Every destructive path
 * calls this before it touches anything: broad deletion and ambient project
 * discovery are unreachable by construction.
 */
export function assertOwnedByRun(runId: string, resource: EnvironmentResourceV1): void {
  if (!resource.run_scoped_name.includes(runId)) {
    throw new Erl2Error(
      CODES.ENV_FOREIGN_RESOURCE_REJECTED,
      `resource ${resource.resource_id} is not scoped to run ${runId}`,
    );
  }
  const expected = resourceIdentityHash(runId, resource.kind, resource.run_scoped_name);
  if (expected !== resource.identity_hash) {
    throw new Erl2Error(
      CODES.ENV_FOREIGN_RESOURCE_REJECTED,
      `resource ${resource.resource_id} identity hash does not derive from its run-scoped name`,
    );
  }
}

/** A selector that would match more than this run's resources is refused. */
export function assertNarrowSelector(runId: string, selector: string): void {
  if (selector.includes("*") || selector.includes("?") || selector.trim() === "") {
    throw new Erl2Error(
      CODES.ENV_BROAD_DELETE_REJECTED,
      `cleanup selector ${JSON.stringify(selector)} is a wildcard`,
    );
  }
  if (!selector.includes(runId)) {
    throw new Erl2Error(
      CODES.ENV_BROAD_DELETE_REJECTED,
      `cleanup selector ${selector} is not scoped to run ${runId}`,
    );
  }
}

export interface ProvisionRequest {
  readonly runId: string;
  readonly archetypeHash: Hash;
  readonly disorderSeedCommitment: Hash;
  readonly operationId: string;
}

export interface ProvisionResult {
  readonly receipt: EnvironmentOperationReceiptV1;
  readonly inventory: EnvironmentResourceInventoryV1;
  readonly environmentInstanceHash: Hash;
  /** Partially provisioned runs still return everything that was created. */
  readonly partial: boolean;
}

export interface ProbeRequest {
  readonly runId: string;
  readonly phase: "readiness" | "baseline" | "fault" | "restoration" | "teardown";
  readonly operationId: string;
}

export interface MutateRequest {
  readonly runId: string;
  readonly targetResourceId: string;
  readonly mutationId: string;
  readonly operationId: string;
}

export interface RestoreRequest {
  readonly runId: string;
  readonly operationId: string;
}

export interface DestroyRequest {
  readonly runId: string;
  readonly operationId: string;
}

export interface DestroyResult {
  readonly receipt: EnvironmentOperationReceiptV1;
  /** Resources still present after teardown; zero for a clean run. */
  readonly residue: readonly EnvironmentResourceV1[];
}

export interface DestroyResourceRequest {
  readonly runId: string;
  readonly resourceId: string;
  readonly operationId: string;
}

export interface EnvironmentDriver {
  readonly manifest: EnvironmentDriverManifestV1;
  provision(request: ProvisionRequest): ProvisionResult;
  /** Read-only by contract: a probe observes and returns a fingerprint. It mutates nothing. */
  probe(request: ProbeRequest): EnvironmentBaselineFingerprintV1;
  mutate(request: MutateRequest): EnvironmentOperationReceiptV1;
  restore(request: RestoreRequest): EnvironmentOperationReceiptV1;
  destroy(request: DestroyRequest): DestroyResult;
  /** Read-only by contract: an inspection observes and returns an inventory. */
  inspect(runId: string): EnvironmentResourceInventoryV1;
  /**
   * The identity of the substrate this driver instance is operating against, or
   * `undefined` when that substrate has never been established.
   *
   * ADR-ERL2-024 §6.2 amends ADR-ERL2-021 §5 to add this. §4.2 requires an
   * identity "unambiguous for the driver and substrate instance actually
   * observed", and only the driver can report it: the run root knows which
   * substrate it *configured*, not which one the driver reached.
   */
  substrateInstance(): SubstrateInstance | undefined;
  /** Establishes the substrate identity. Called once, by `provision`. */
  establishSubstrateInstance(runId: string): SubstrateInstance;
  /**
   * The receipt of an operation this driver has already completed for the run,
   * keyed by operation id — the driver's own operation log.
   *
   * **Optional.** It is what lets restart reconciliation *adopt* an
   * independently verified prior result instead of re-dispatching or failing
   * closed (ADR-ERL2-024 §4.3). A driver that cannot offer one is not broken;
   * its unsettled operations simply fail closed, which is the correct posture
   * and not a thing to work around by assuming idempotence.
   */
  completedOperation?(runId: string, operationId: string): EnvironmentOperationReceiptV1 | undefined;
  /**
   * The mutation ids the driver observes as **currently applied** to this run's
   * environment.
   *
   * **Optional**, and its absence is fail-closed: a driver that cannot be asked
   * what is applied cannot support a restoration claim, because there is then no
   * way to tell a compensation that reverted the mutation from one that returned
   * `succeeded` and did nothing (review P1-4). Restoration under such a driver
   * records `probe_status: "unavailable"` and refuses.
   *
   * This is an **observation**, like `probe` and `inspect`, and it is read-only
   * by contract. It is what the restoration probe re-reads *after* the
   * compensation, so the Lab's verdict comes from the substrate rather than from
   * the receipt the substrate handed it.
   */
  observedMutations?(runId: string): readonly string[];
  /**
   * Destroys exactly one owned resource, receipting the attempt.
   *
   * **Optional.** A driver whose only destructive granularity is the whole
   * environment omits it, and emergency cleanup then falls back to the
   * conditional whole-environment rule (§4.5): the sledgehammer may be swung
   * only when every observed frontier member is an authorized target. Providing
   * this method is how a driver escapes that restriction.
   */
  destroyResource?(request: DestroyResourceRequest): EnvironmentOperationReceiptV1;
}

/**
 * A driver is usable only when its manifest says so.  This is where the OQ-005
 * fail-closed state bites: `composeDriverManifestBody` derives `enabled` from
 * the substrate lock, so a Compose manifest built from an unqualified lock is
 * signed `enabled: false` and any attempt to drive it refuses before
 * provisioning.
 */
export function assertDriverEnabled(manifest: EnvironmentDriverManifestV1): void {
  if (!manifest.enabled) {
    throw new Erl2Error(
      CODES.ENV_DRIVER_DISABLED,
      `environment driver ${manifest.driver_id} is disabled: ${manifest.disabled_reason_code ?? "unspecified"} (gate ${manifest.activation_gate ?? "unspecified"})`,
    );
  }
}

export function assertOperationSupported(
  manifest: EnvironmentDriverManifestV1,
  operation: EnvironmentDriverManifestV1["supported_operations"][number],
): void {
  if (!manifest.supported_operations.includes(operation)) {
    throw new Erl2Error(
      CODES.ENV_OPERATION_UNSUPPORTED,
      `driver ${manifest.driver_id} does not support ${operation}`,
    );
  }
}
