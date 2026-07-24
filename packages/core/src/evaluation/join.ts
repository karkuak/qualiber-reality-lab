/**
 * The precleanup result join and the generic evaluation index (design v2 §17,
 * implementation plan §12.1 S6.5/S6.8).
 *
 * `GenericPrecleanupResultJoinV1` is the **sole** cleanup-entry guard.  Cleanup
 * may start only after a join exists whose lifecycle event follows both frozen
 * results.  `both_frozen_before_cleanup` is a schema constant `true`, so it
 * carries no information on its own: the ordering is derived from the lifecycle
 * chain here and again by the verifier, never read from that boolean.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type DomainResultV1,
  type GenericEvaluationIndexV1,
  type GenericPrecleanupResultJoinV1,
  type Hash,
  type Instant,
  type JourneyResultV1,
  type LabLifecycleEventV1,
  type ValidityResultV1,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";
import { assertValidityAdmitsGenericIndex } from "./validity.js";

/** Lifecycle events that publish a journey result. */
const JOURNEY_RESULT_EVENTS: ReadonlySet<string> = new Set([
  "functional_journey_result_frozen",
  "nonfunctional_journey_result_frozen",
]);

/** Lifecycle events that publish a domain result. */
const DOMAIN_RESULT_EVENTS: ReadonlySet<string> = new Set([
  "domain_result_frozen",
  "domain_not_applicable_frozen",
]);

/** Lifecycle events that start any cleanup branch. */
const CLEANUP_START_EVENTS: ReadonlySet<string> = new Set([
  "pre_environment_cleanup_started",
  "lab_cleanup_started",
]);

export interface JoinOrderingEvidence {
  readonly journeyResultEventIndex: number;
  readonly domainResultEventIndex: number;
  readonly joinEventIndex: number;
  readonly joinEventHash: Hash;
}

/**
 * Derives the join ordering from the hash-chained lifecycle.
 *
 * Refuses a missing branch, a duplicate result, a join that does not follow
 * both results, and a cleanup that started before the join.
 */
export function deriveJoinOrdering(
  events: readonly LabLifecycleEventV1[],
): JoinOrderingEvidence {
  const journeyIndices: number[] = [];
  const domainIndices: number[] = [];
  const cleanupIndices: number[] = [];
  let joinIndex = -1;
  let joinHash: Hash | undefined;

  events.forEach((event, index) => {
    if (JOURNEY_RESULT_EVENTS.has(event.event_type)) journeyIndices.push(index);
    if (DOMAIN_RESULT_EVENTS.has(event.event_type)) domainIndices.push(index);
    if (CLEANUP_START_EVENTS.has(event.event_type)) cleanupIndices.push(index);
    if (event.event_type === "generic_precleanup_results_complete") {
      joinIndex = index;
      joinHash = event.core_hash;
    }
  });

  if (journeyIndices.length === 0 || domainIndices.length === 0) {
    throw new Erl2Error(
      CODES.EVALUATOR_RESULT_JOIN_INCOMPLETE,
      `the result join requires both a journey result (${String(journeyIndices.length)} found) and exactly one domain result (${String(domainIndices.length)} found)`,
      { owner: "lab" },
    );
  }
  if (journeyIndices.length > 1 || domainIndices.length > 1) {
    throw new Erl2Error(
      CODES.EVALUATOR_RESULT_JOIN_DUPLICATE,
      "exactly one journey result and one domain result may be frozen per run",
      { owner: "lab" },
    );
  }
  if (joinIndex < 0 || joinHash === undefined) {
    throw new Erl2Error(
      CODES.EVALUATOR_RESULT_JOIN_INCOMPLETE,
      "no result-join lifecycle event was frozen",
      { owner: "lab" },
    );
  }
  const journeyIndex = journeyIndices[0] as number;
  const domainIndex = domainIndices[0] as number;
  if (joinIndex < journeyIndex || joinIndex < domainIndex) {
    throw new Erl2Error(
      CODES.EVALUATOR_RESULT_JOIN_INCOMPLETE,
      "the result-join event does not follow both frozen results",
      { owner: "lab" },
    );
  }
  const earlyCleanup = cleanupIndices.filter((i) => i < joinIndex);
  if (earlyCleanup.length > 0) {
    throw new Erl2Error(
      CODES.EVALUATOR_CLEANUP_BEFORE_RESULT_JOIN,
      "cleanup started before the result join; the join is the sole cleanup-entry guard",
      { owner: "lab" },
    );
  }
  return {
    journeyResultEventIndex: journeyIndex,
    domainResultEventIndex: domainIndex,
    joinEventIndex: joinIndex,
    joinEventHash: joinHash,
  };
}

export interface BuildJoinInput {
  readonly runId: string;
  readonly journeyResult: JourneyResultV1;
  readonly domainResult: DomainResultV1;
  readonly lifecycleEventHash: Hash;
  readonly joinedAt: Instant;
  /** The policy both results must be bound to. */
  readonly genericRunPolicyHash: Hash;
}

/**
 * Freezes the join.
 *
 * Both results must belong to this run and this policy: a cross-run or
 * cross-policy result is refused rather than joined.
 */
export function buildPrecleanupResultJoin(
  input: BuildJoinInput,
): GenericPrecleanupResultJoinV1 {
  const journey = input.journeyResult;
  const domain = input.domainResult;

  for (const [label, value] of [
    ["journey result", journey.run_id],
    ["domain result", domain.run_id],
  ] as const) {
    if (value !== input.runId) {
      throw new Erl2Error(
        CODES.EVALUATOR_CROSS_RUN_RESULT,
        `the ${label} belongs to run ${value}, not ${input.runId}`,
        { owner: "lab" },
      );
    }
  }
  for (const [label, value] of [
    ["journey result", journey.generic_run_policy_hash],
    ["domain result", domain.generic_run_policy_hash],
  ] as const) {
    if (value !== input.genericRunPolicyHash) {
      throw new Erl2Error(
        CODES.EVALUATOR_CROSS_POLICY_RESULT,
        `the ${label} is bound to a different generic run policy`,
        { owner: "lab" },
      );
    }
  }

  const variant: "evaluated" | "not_applicable" =
    domain.schema_version === "domain-result-not-applicable/v1" ? "not_applicable" : "evaluated";

  // A not-applicable domain result must reference the journey result it follows.
  if (
    domain.schema_version === "domain-result-not-applicable/v1" &&
    domain.journey_result_hash !== journey.core_hash
  ) {
    throw new Erl2Error(
      CODES.EVALUATOR_DOMAIN_VARIANT_MISMATCH,
      "the not-applicable domain result references a different journey result",
      { owner: "lab" },
    );
  }

  const body = {
    schema_version: "generic-precleanup-result-join/v1" as const,
    run_id: input.runId,
    journey_result_hash: journey.core_hash,
    domain_result_hash: domain.core_hash,
    domain_variant: variant,
    both_frozen_before_cleanup: true as const,
    lifecycle_event_hash: input.lifecycleEventHash,
    joined_at: input.joinedAt,
  };
  return assertContract<GenericPrecleanupResultJoinV1>("GenericPrecleanupResultJoinV1", {
    ...body,
    core_hash: coreHash(body),
  });
}

export interface BuildGenericIndexInput {
  readonly runId: string;
  readonly genericRunPolicyHash: Hash;
  readonly validity: ValidityResultV1;
  readonly journeyResult: JourneyResultV1;
  readonly domainResult: DomainResultV1;
  readonly join: GenericPrecleanupResultJoinV1;
  readonly evaluatorVersion: string;
}

/**
 * Binds the four planes for a valid run only.
 *
 * The index contains no deep commitment, no deep result and no product-specific
 * field: `GenericEvaluationIndexV1` has no member of any of those shapes, and
 * the architecture test proves it.  Stale, cross-run and mismatched-variant
 * results are refused here rather than silently indexed.
 */
export function buildGenericEvaluationIndex(
  input: BuildGenericIndexInput,
): GenericEvaluationIndexV1 {
  assertValidityAdmitsGenericIndex(input.validity);

  if (input.validity.run_id !== input.runId) {
    throw new Erl2Error(
      CODES.EVALUATOR_CROSS_RUN_RESULT,
      "the validity result belongs to a different run",
      { owner: "lab" },
    );
  }
  if (input.validity.generic_run_policy_hash !== input.genericRunPolicyHash) {
    throw new Erl2Error(
      CODES.EVALUATOR_CROSS_POLICY_RESULT,
      "the validity result is bound to a different generic run policy",
      { owner: "lab" },
    );
  }
  if (input.join.run_id !== input.runId) {
    throw new Erl2Error(
      CODES.EVALUATOR_CROSS_RUN_RESULT,
      "the result join belongs to a different run",
      { owner: "lab" },
    );
  }
  // Stale results: the index must bind exactly the results the join closed
  // over, not a later re-evaluation.
  if (input.join.journey_result_hash !== input.journeyResult.core_hash) {
    throw new Erl2Error(
      CODES.EVALUATOR_STALE_RESULT_HASH,
      "the generic index binds a journey result the join did not close over",
      { owner: "lab" },
    );
  }
  if (input.join.domain_result_hash !== input.domainResult.core_hash) {
    throw new Erl2Error(
      CODES.EVALUATOR_STALE_RESULT_HASH,
      "the generic index binds a domain result the join did not close over",
      { owner: "lab" },
    );
  }
  const expectedVariant =
    input.domainResult.schema_version === "domain-result-not-applicable/v1"
      ? "not_applicable"
      : "evaluated";
  if (input.join.domain_variant !== expectedVariant) {
    throw new Erl2Error(
      CODES.EVALUATOR_DOMAIN_VARIANT_MISMATCH,
      `the join declares domain variant ${input.join.domain_variant}; the frozen result is ${expectedVariant}`,
      { owner: "lab" },
    );
  }

  const body = {
    schema_version: "generic-evaluation-index/v1" as const,
    run_id: input.runId,
    generic_run_policy_hash: input.genericRunPolicyHash,
    validity_result_hash: input.validity.core_hash,
    journey_result_hash: input.journeyResult.core_hash,
    domain_result_hash: input.domainResult.core_hash,
    precleanup_result_join_hash: input.join.core_hash,
    evaluator_version: input.evaluatorVersion,
  };
  return assertContract<GenericEvaluationIndexV1>("GenericEvaluationIndexV1", {
    ...body,
    core_hash: coreHash(body),
  });
}

/**
 * Field names that would make a generic or base artifact depend on the optional
 * deep plane.  Slice 8 may add a `DeepResultV1` *descendant*; it may never add a
 * member to an ancestor (design v2 §17, implementation plan §14.2).
 */
export const DEEP_ANCESTRY_FORBIDDEN_FIELDS: readonly string[] = [
  "deep_evaluation_commitment_hash",
  "deep_result_hash",
  "deep_pack_hashes",
  "deep_policy_hash",
  "deep_trust_policy_hash",
  "deep_signer_inventory_hash",
  "deep_supplement_attestation_hash",
  "deep_verification_bundle_hash",
];

/**
 * Refuses a deep field injected anywhere in a generic or base artifact.
 *
 * Applied to every artifact the generic evaluator and finalizer freeze, so the
 * Slice 8 boundary is protected by an executable check rather than by review.
 */
export function assertNoDeepAncestry(artifact: unknown, label: string): void {
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (DEEP_ANCESTRY_FORBIDDEN_FIELDS.includes(key)) {
        throw new Erl2Error(
          CODES.DEEP_ANCESTRY_FIELD_IN_GENERIC_ARTIFACT,
          `${label} carries the deep-plane field ${key}; a generic or base artifact may not reference the deep plane`,
          { owner: "lab" },
        );
      }
      walk(child);
    }
  };
  walk(artifact);
}
