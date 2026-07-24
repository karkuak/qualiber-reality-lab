/**
 * The environment driver interface (design v2 §8, implementation plan §9.2).
 *
 * Six closed operations, no escape hatch: `provision`, `probe`, `mutate`,
 * `restore`, `destroy`, `inspect`.  A driver never sees truth, judge
 * expectations, selection handles or subject output; it manipulates
 * infrastructure and returns receipts.
 *
 * The fake driver and the Compose driver satisfy the same suite — that is the
 * design's "every abstraction has two uses" rule made executable.  The Compose
 * driver is disabled until its substrate lock qualifies (ERL2-OQ-005), so the
 * second use is currently proven by the contract suite rather than by a live
 * substrate.
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

export interface EnvironmentDriver {
  readonly manifest: EnvironmentDriverManifestV1;
  provision(request: ProvisionRequest): ProvisionResult;
  probe(request: ProbeRequest): EnvironmentBaselineFingerprintV1;
  mutate(request: MutateRequest): EnvironmentOperationReceiptV1;
  restore(request: RestoreRequest): EnvironmentOperationReceiptV1;
  destroy(request: DestroyRequest): DestroyResult;
  inspect(runId: string): EnvironmentResourceInventoryV1;
}

/**
 * A driver is usable only when its manifest says so.  This is where the
 * OQ-005 fail-closed state bites: the Compose manifest is signed with
 * `enabled: false`, so any attempt to drive it refuses before provisioning.
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
