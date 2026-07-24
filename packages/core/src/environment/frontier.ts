/**
 * Resource frontier and independently derived safe cleanup actions
 * (implementation plan §9.1 S3.7, design v2 §12).
 *
 * The frontier is what the driver *observes*, but the action set is derived
 * here from the observed resources and the ownership rules — never supplied by
 * the driver. That separation is the point: a broken or hostile driver cannot
 * talk the Lab into deleting something it does not own, nor into skipping an
 * action that is independently safe.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type EmergencyCleanupActionKind,
  type EnvironmentResourceFrontierV1,
  type EnvironmentResourceV1,
  type Hash,
} from "@erl2/contracts";
import { coreHash, jcs } from "@erl2/integrity";
import { assertOwnedByRun } from "./driver.js";

/** Cleanup action a resource kind implies, in the order they must be attempted. */
const KIND_ACTION: Readonly<Record<string, EmergencyCleanupActionKind>> = {
  subject_process: "stop_subject",
  network: "isolate_network",
  credential: "revoke_credentials",
  mutation: "compensate_mutation",
  container: "destroy_partial_resource",
  volume: "destroy_partial_resource",
  port: "destroy_partial_resource",
  project: "teardown_remaining",
};

/** Stable attempt order, so two runs enumerate the frontier identically. */
const ACTION_ORDER: readonly EmergencyCleanupActionKind[] = [
  "stop_subject",
  "isolate_network",
  "revoke_credentials",
  "compensate_mutation",
  "destroy_partial_resource",
  "teardown_remaining",
  "contain_residual",
];

export interface FreezeFrontierOptions {
  readonly runId: string;
  readonly environmentInstanceHash: Hash;
  readonly driverManifestHash: Hash;
  readonly trigger: EnvironmentResourceFrontierV1["trigger"];
  readonly observedResources: readonly EnvironmentResourceV1[];
  readonly frozenAt: string;
}

/**
 * Freezes the frontier and derives the action set.
 *
 * A resource is independently safe to act on only when it is provably this
 * run's, the driver marked it destroyable, and it is not shared with another
 * run. Anything else becomes a `contain_residual` action marked unsafe with a
 * reason — which the emergency-cleanup contract then requires be skipped
 * *without* a receipt.
 */
export function freezeResourceFrontier(
  options: FreezeFrontierOptions,
): EnvironmentResourceFrontierV1 {
  const actions: {
    action_id: string;
    kind: EmergencyCleanupActionKind;
    target_resource_id: string;
    independently_safe: boolean;
    unsafe_reason_code?: string;
  }[] = [];

  for (const resource of options.observedResources) {
    // Ownership is re-derived, not trusted.
    let owned = true;
    try {
      assertOwnedByRun(options.runId, resource);
    } catch {
      owned = false;
    }

    if (!owned) {
      actions.push({
        action_id: `contain-${resource.resource_id}`,
        kind: "contain_residual",
        target_resource_id: resource.resource_id,
        independently_safe: false,
        unsafe_reason_code: "RESOURCE_NOT_PROVABLY_OWNED_BY_RUN",
      });
      continue;
    }
    if (resource.shared_with_other_runs === true) {
      actions.push({
        action_id: `contain-${resource.resource_id}`,
        kind: "contain_residual",
        target_resource_id: resource.resource_id,
        independently_safe: false,
        unsafe_reason_code: "RESOURCE_SHARED_WITH_ANOTHER_RUN",
      });
      continue;
    }
    if (!resource.destroyable) {
      actions.push({
        action_id: `contain-${resource.resource_id}`,
        kind: "contain_residual",
        target_resource_id: resource.resource_id,
        independently_safe: false,
        unsafe_reason_code: "RESOURCE_NOT_INDEPENDENTLY_DESTROYABLE",
      });
      continue;
    }
    const kind = KIND_ACTION[resource.kind] ?? "destroy_partial_resource";
    actions.push({
      action_id: `${kind.replaceAll("_", "-")}-${resource.resource_id}`,
      kind,
      target_resource_id: resource.resource_id,
      independently_safe: true,
    });
  }

  actions.sort((a, b) => {
    const byKind = ACTION_ORDER.indexOf(a.kind) - ACTION_ORDER.indexOf(b.kind);
    if (byKind !== 0) return byKind;
    return a.action_id < b.action_id ? -1 : a.action_id > b.action_id ? 1 : 0;
  });

  const base = {
    schema_version: "environment-resource-frontier/v1" as const,
    run_id: options.runId,
    environment_instance_hash: options.environmentInstanceHash,
    driver_manifest_hash: options.driverManifestHash,
    trigger: options.trigger,
    observed_resources: [...options.observedResources],
    derived_actions: actions,
    frozen_at: options.frozenAt,
  };
  return assertContract<EnvironmentResourceFrontierV1>("EnvironmentResourceFrontierV1", {
    ...base,
    core_hash: coreHash(base),
  });
}

/**
 * Re-derives the frontier's action set and refuses a frontier whose actions do
 * not match. The verifier calls this rather than trusting `derived_actions`.
 */
export function assertFrontierActionsDerivable(frontier: EnvironmentResourceFrontierV1): void {
  // The declared hash must first match the object's own canonical bytes, so a
  // frontier cannot be edited while keeping its original hash.
  if (coreHash(frontier) !== frontier.core_hash) {
    throw new Erl2Error(
      CODES.ARTIFACT_HASH_MISMATCH,
      "frontier core_hash does not match its canonical bytes",
    );
  }
  const recomputed = freezeResourceFrontier({
    runId: frontier.run_id,
    environmentInstanceHash: frontier.environment_instance_hash,
    driverManifestHash: frontier.driver_manifest_hash,
    trigger: frontier.trigger,
    observedResources: frontier.observed_resources,
    frozenAt: frontier.frozen_at,
  });
  if (jcs(recomputed.derived_actions) !== jcs(frontier.derived_actions)) {
    throw new Erl2Error(
      CODES.EMERGENCY_ACTION_SAFE_ACTION_SKIPPED,
      "frontier actions do not derive from the observed resources",
    );
  }
}

/** Every independently safe action must be attempted (ERL2-FR-025). */
export function safeActions(
  frontier: EnvironmentResourceFrontierV1,
): readonly EnvironmentResourceFrontierV1["derived_actions"][number][] {
  return frontier.derived_actions.filter((a) => a.independently_safe);
}
