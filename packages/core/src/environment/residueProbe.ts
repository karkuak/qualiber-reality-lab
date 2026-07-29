/**
 * The independent post-cleanup observation (ADR-ERL2-027 §4.3, contract
 * ERL2-C-158).
 *
 * ## What this closes
 *
 * `EmergencyCleanupVerificationV1.remaining_resources` is the only post-cleanup
 * evidence an invalid terminal carried, and the producer derives it from the
 * producer's own action outcomes: a resource appears there when its action was
 * skipped or failed, and not otherwise. Two consequences, both offline-invisible:
 *
 *  1. **An empty residue is unfalsifiable.** A cleanup that marked every action
 *     `succeeded` produces `remaining_resources: []`, and the verifier's own
 *     cross-check — every unresolved action's target must appear in the residue —
 *     is vacuous when nothing is unresolved.
 *  2. **An unauthorized destruction is undetectable.** A post-cleanup inventory
 *     cannot distinguish a resource that was destroyed *because the Lab
 *     authorized it* from one that was destroyed anyway: the resource is absent
 *     in both. That is precisely the shape review P1-1 described, and the reason
 *     `boundedEnvironmentCleanup` could destroy a resource its own frontier had
 *     classified `contain_residual` and leave no trace of having done so.
 *
 * ## What replaces it
 *
 * The substrate is re-observed after the last cleanup dispatch, and the
 * observation is *retained* beside the pre-action frontier it closes over. The
 * verdict is then a set comparison an offline reader can reproduce:
 *
 * ```
 * destroyed  = observed_before \ observed_after
 * undeclared = destroyed \ authorized_targets
 * residual   = observed_before ∩ observed_after
 * ```
 *
 * `authorized_targets` is the derived safe-action target set — what the Lab said
 * it was allowed to touch, frozen before it touched anything. A resource that
 * left the substrate without being in it is `undeclared_destruction`, and that is
 * a Lab-integrity failure whoever caused it: the Lab cannot account for an effect
 * it did not authorize.
 *
 * | outcome | meaning |
 * |---|---|
 * | `clean` | nothing of this run remains, and every disappearance was authorized |
 * | `residual` | something remains; every disappearance was authorized |
 * | `undeclared_destruction` | something the Lab never authorized is gone |
 * | `unobservable` | the substrate could not be re-observed at all |
 *
 * `unobservable` is a refusal, not a pass — the same fail-closed posture
 * ADR-ERL2-026 took for a driver with no applied-mutation observation, and
 * ADR-ERL2-024 §4.3 for one with no operation log.
 *
 * Unsigned, deliberately: an invalid terminal emits no attestation and no public
 * bundle, so a signature here would add a key to a path that publishes nothing
 * (ADR-ERL2-027 §6.3).
 */

import {
  assertContract,
  type CleanupResidueProbeV1,
  type Hash,
  type Instant,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";

/** One resource as the substrate reported it at a single moment. */
export interface ObservedResourceIdentity {
  readonly resourceId: string;
  readonly identityHash: Hash;
}

/** The two observations a residue probe compares, and what the Lab authorized. */
export interface ResidueObservations {
  /** The substrate as the pre-action frontier observed it. */
  readonly observedBefore: readonly ObservedResourceIdentity[];
  /** The substrate re-observed after the last cleanup dispatch. */
  readonly observedAfter: readonly ObservedResourceIdentity[];
  /**
   * Resource ids the derived safe actions authorized a dispatch against.
   *
   * This is the *derived* set, not the set of actions that happened to succeed.
   * An action that was authorized and then failed still authorized its target,
   * so a resource that vanished anyway is accounted for; an action that was
   * never derived never authorized anything, which is the case this exists for.
   */
  readonly authorizedTargets: readonly string[];
  readonly probeStatus: "observed" | "unavailable";
}

export interface ResidueProbeVerdict {
  readonly outcome: CleanupResidueProbeV1["outcome"];
  /** Present before, absent after, never authorized. */
  readonly undeclaredDestroyed: readonly string[];
  /** Frontier members still observed afterwards. */
  readonly residual: readonly string[];
}

/**
 * Derives the outcome from the observations alone.
 *
 * Shared with the offline verifier on the terms ADR-ERL2-024 §7.2 set for
 * `safeActions` and ADR-ERL2-026 §7 for the restoration arithmetic: this is set
 * difference over retained arrays — a *definition*, reproducible by any reader
 * holding the bytes. Every judgement *about* those arrays is verifier-owned and
 * lives in `packages/public-verifier`: that `observed_before` is the frontier's
 * own observation, that the probe belongs to this run and this binding, and that
 * the retained `outcome` is the one this function returns.
 */
export function deriveResidueProbeOutcome(observations: ResidueObservations): ResidueProbeVerdict {
  const before = observations.observedBefore.map((r) => r.resourceId);
  const after = new Set(observations.observedAfter.map((r) => r.resourceId));
  const authorized = new Set(observations.authorizedTargets);

  const residual = [...new Set(before.filter((id) => after.has(id)))].sort();
  const undeclaredDestroyed = [
    ...new Set(before.filter((id) => !after.has(id) && !authorized.has(id))),
  ].sort();

  if (observations.probeStatus === "unavailable") {
    return { outcome: "unobservable", undeclaredDestroyed, residual };
  }
  // Ordered most-severe-first. A cleanup that both destroyed something it never
  // authorized *and* left residue behind is reported as the integrity failure:
  // residue is a cleanup that did not finish, and an unauthorized destruction is
  // a cleanup that did something nobody can account for.
  if (undeclaredDestroyed.length > 0) {
    return { outcome: "undeclared_destruction", undeclaredDestroyed, residual };
  }
  if (residual.length > 0) {
    return { outcome: "residual", undeclaredDestroyed, residual };
  }
  return { outcome: "clean", undeclaredDestroyed, residual };
}

/** The one outcome over which a cleanup may be recorded as complete. */
export function residueProbeClean(outcome: CleanupResidueProbeV1["outcome"]): boolean {
  return outcome === "clean";
}

export interface BuildResidueProbeInput extends ResidueObservations {
  readonly runId: string;
  readonly substrateBindingHash: Hash;
  readonly environmentInstanceHash: Hash;
  readonly resourceFrontierHash: Hash;
  readonly probedAt: Instant;
}

/** Builds the probe. `outcome` is derived from the observations, never supplied. */
export function buildResidueProbe(input: BuildResidueProbeInput): CleanupResidueProbeV1 {
  const verdict = deriveResidueProbeOutcome(input);
  const identities = (
    resources: readonly ObservedResourceIdentity[],
  ): { resource_id: string; identity_hash: Hash }[] =>
    [...resources]
      // Sorted so two runs over the same substrate freeze the same bytes; the
      // driver's iteration order is not evidence.
      .sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0))
      .map((r) => ({ resource_id: r.resourceId, identity_hash: r.identityHash }));

  const body = {
    schema_version: "cleanup-residue-probe/v1" as const,
    probe_id: `cleanup-residue-probe-${input.runId.slice(0, 8)}`,
    run_id: input.runId,
    substrate_binding_hash: input.substrateBindingHash,
    environment_instance_hash: input.environmentInstanceHash,
    resource_frontier_hash: input.resourceFrontierHash,
    observed_before: identities(input.observedBefore),
    observed_after: identities(input.observedAfter),
    authorized_targets: [...new Set(input.authorizedTargets)].sort(),
    undeclared_destroyed_resources: [...verdict.undeclaredDestroyed],
    residual_resources: [...verdict.residual],
    probe_status: input.probeStatus,
    outcome: verdict.outcome,
    probed_at: input.probedAt,
  };
  return assertContract<CleanupResidueProbeV1>("CleanupResidueProbeV1", {
    ...body,
    core_hash: coreHash(body),
  });
}
