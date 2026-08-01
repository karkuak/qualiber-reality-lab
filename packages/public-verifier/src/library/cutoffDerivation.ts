/**
 * Independent offline re-derivation of the evidence cutoff (ADR-ERL2-029 §3,
 * design v2 §13, review P2).
 *
 * `realizeCutoff` (`packages/core/src/capture/capture.ts`) is careful: it refuses
 * a milestone that does not reference the signed process-start receipt, a
 * milestone in a different monotonic clock domain, wall and monotonic views that
 * diverge beyond the committed bound, and a process-to-milestone skew beyond the
 * bound.  The offline verifier re-did **none** of it, so
 * `ObservationBundleV2.cutoff.runtime_milestone_hash` was a 32-byte string nothing
 * resolved — the review's finding, verbatim: *an observation bundle naming a
 * nonexistent runtime milestone verifies as valid.*
 *
 * This module is the reader's own derivation.  It shares canonical hashing and
 * schema validation with the producer and nothing else; the arithmetic and every
 * bound below are re-implemented here rather than imported, on ADR-ERL2-024 §7's
 * rule that two implementations agreeing proves the implementations agree.
 *
 * ## Bounds-exact, not scalar-exact
 *
 * The producer computes `instant = process_started_at + warmupMs + observationMs`,
 * and both durations are **constants of the composition** — not carried in the
 * bundle, the policy, the milestone or the receipt.  A reader cannot recompute the
 * scalar, so it decomposes against a *third* independently signed instant instead:
 *
 *     warmup      := milestone.occurred_at    - receipt.process_started_at
 *     observation := cutoff.instant           - milestone.occurred_at
 *
 * `occurred_at` is signed by the `runtime_attestor` and `process_started_at` by the
 * `traffic_supervisor` — neither is the party that wrote the cutoff — and both
 * derived durations are then checked against the committed policy bounds.
 *
 * What is **not** proven is that the operator chose a 1-second warmup rather than a
 * 900 ms one: a producer free to select the durations is free to select ones that
 * satisfy any recomputation.  Closing that needs a signed window commitment on the
 * producer side, which is a producer change and is not in this package
 * (ADR-ERL2-029 §3.2, §9).  The boundary is stated rather than blurred.
 */

import {
  CODES,
  Erl2Error,
  type CutoffPolicyV1,
  type Hash,
  type LabLifecycleEventV1,
  type ObservationBundleV2,
  type RuntimeMilestoneV1,
  type TrafficProcessStartReceiptV1,
} from "@erl2/contracts";
import type { ArtifactIndex } from "./artifactIndex.js";

/** What the derivation concluded, for the caller's report. */
export interface CutoffDerivation {
  readonly instant: string;
  readonly warmupMs: number;
  readonly observationMs: number;
  readonly milestoneHash: Hash;
  readonly processStartReceiptHash: Hash;
  readonly policyHash: Hash;
}

/**
 * Resolves a cutoff input by **exact core hash and schema**.
 *
 * `ArtifactIndex.typed` would do this, but its refusal for an absent hash is the
 * generic unreachable-artifact code.  A cutoff input that names nothing is the
 * specific defect the review reproduced, so it keeps its own cause.
 */
function resolveCutoffInput<T>(
  index: ArtifactIndex,
  hash: Hash,
  schemaVersion: string,
  label: string,
): T {
  const found = index.tryGet(hash);
  if (found === undefined) {
    throw new Erl2Error(
      CODES.CUTOFF_MILESTONE_MISMATCH,
      `the observation bundle's cutoff names ${label} ${hash}, which no retained artifact has; ` +
        `a well-formed hash naming nothing is not evidence that the ${label} exists`,
    );
  }
  if (found.schemaVersion !== schemaVersion) {
    throw new Erl2Error(
      CODES.CUTOFF_MILESTONE_MISMATCH,
      `the cutoff's ${label} ${hash} is a ${found.schemaVersion}, not a ${schemaVersion}`,
    );
  }
  return found.value as T;
}

/** Every artifact core hash some lifecycle event names as produced. */
function reachedHashes(events: readonly LabLifecycleEventV1[]): Set<string> {
  const reached = new Set<string>();
  for (const event of events) {
    for (const produced of event.produced) reached.add(produced.artifact_core_hash);
  }
  return reached;
}

/**
 * Refuses an artifact that is retained but that no lifecycle event ever reached.
 *
 * A snapshot-only artifact with no authoritative event is the shape the closure
 * refuses everywhere else; a cutoff input is not exempt from it merely because it
 * is carried in a *supporting* schema rather than a roled one.
 */
function assertReached(
  reached: ReadonlySet<string>,
  hash: Hash,
  label: string,
): void {
  if (!reached.has(hash)) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_UNREACHABLE_ARTIFACT,
      `the cutoff's ${label} ${hash} is retained but no lifecycle event produced it; ` +
        `a cutoff input the run never reached cannot have contributed to the cutoff`,
    );
  }
}

function instantMs(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Erl2Error(CODES.CUTOFF_BOUND_EXCEEDED, `${label} is not a parseable instant: ${value}`);
  }
  return parsed;
}

/**
 * Re-derives the evidence cutoff of a run that realized one.
 *
 * Returns `undefined` when the run retained no observation bundle: the capture
 * group is optional *as a group*, and a run that terminated before
 * `traffic_or_journey_started` never realized a cutoff.  Requiring one would force
 * a synthetic observation, which design v2 §26 forbids;
 * `assertCaptureGroupComplete` continues to refuse a *partial* group
 * (ADR-ERL2-029 §3.4).
 */
export function deriveEvidenceCutoff(options: {
  readonly index: ArtifactIndex;
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly runId: string;
}): CutoffDerivation | undefined {
  const bundles = options.index.ofSchema("observation-bundle/v2");
  if (bundles.length === 0) return undefined;
  if (bundles.length > 1) {
    throw new Erl2Error(
      CODES.CUTOFF_MILESTONE_MISMATCH,
      `a run may realize at most one evidence cutoff; ${String(bundles.length)} observation bundles are retained`,
    );
  }
  const bundle = (bundles[0] as { value: unknown }).value as ObservationBundleV2;
  if (bundle.run_id !== options.runId) {
    throw new Erl2Error(
      CODES.CUTOFF_MILESTONE_MISMATCH,
      `the retained observation bundle belongs to run ${bundle.run_id}, not ${options.runId}`,
    );
  }

  const { cutoff } = bundle;
  const policy = resolveCutoffInput<CutoffPolicyV1>(
    options.index,
    cutoff.policy_hash,
    "cutoff-policy/v1",
    "cutoff policy",
  );
  const receipt = resolveCutoffInput<TrafficProcessStartReceiptV1>(
    options.index,
    cutoff.process_start_receipt_hash,
    "traffic-process-start-receipt/v1",
    "process-start receipt",
  );
  const milestone = resolveCutoffInput<RuntimeMilestoneV1>(
    options.index,
    cutoff.runtime_milestone_hash,
    "runtime-milestone/v1",
    "runtime milestone",
  );

  // -- 1. identity -----------------------------------------------------------
  for (const [label, id] of [
    ["cutoff policy", undefined],
    ["process-start receipt", receipt.run_id],
    ["runtime milestone", milestone.run_id],
  ] as const) {
    if (id !== undefined && id !== options.runId) {
      throw new Erl2Error(
        CODES.CUTOFF_MILESTONE_MISMATCH,
        `the cutoff's ${label} belongs to run ${id}, not ${options.runId}`,
      );
    }
  }

  // -- 2. the milestone must bind the receipt the cutoff names ---------------
  //
  // The producer checks the milestone against the receipt it was handed. The
  // verifier checks it against the receipt the *cutoff* names, which is the
  // substitution the producer cannot catch: a milestone honestly bound to some
  // other run's receipt, cited by a cutoff that names this run's.
  if (milestone.traffic_process_start_receipt_hash !== cutoff.process_start_receipt_hash) {
    throw new Erl2Error(
      CODES.CUTOFF_MILESTONE_MISMATCH,
      `the runtime milestone binds process-start receipt ` +
        `${milestone.traffic_process_start_receipt_hash}, but the cutoff was derived from ` +
        `${cutoff.process_start_receipt_hash}`,
    );
  }
  if (milestone.monotonic_clock_domain_hash !== receipt.monotonic_clock_domain_hash) {
    throw new Erl2Error(
      CODES.CUTOFF_CLOCK_DOMAIN_MISMATCH,
      "the runtime milestone and the process-start receipt are in different monotonic clock domains",
    );
  }

  // -- 3. lifecycle reachability --------------------------------------------
  const reached = reachedHashes(options.lifecycle);
  assertReached(reached, cutoff.runtime_milestone_hash, "runtime milestone");
  assertReached(reached, cutoff.process_start_receipt_hash, "process-start receipt");

  // -- 4. the policy must be the one this derivation implements --------------
  if (policy.instant_rule !== "traffic_process_started_at_plus_warmup_ms_plus_observation_ms") {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `this verifier derives the cutoff under the ` +
        `traffic_process_started_at_plus_warmup_ms_plus_observation_ms rule; the retained policy ` +
        `declares ${policy.instant_rule}`,
    );
  }
  if (policy.clock !== "host_utc") {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the cutoff policy declares clock ${policy.clock}; this derivation reads host_utc instants`,
    );
  }

  // -- 5. the arithmetic, decomposed against three signed instants -----------
  const startedAtMs = instantMs(receipt.process_started_at, "process_started_at");
  const occurredAtMs = instantMs(milestone.occurred_at, "milestone occurred_at");
  const cutoffMs = instantMs(cutoff.instant, "cutoff instant");

  const warmupMs = occurredAtMs - startedAtMs;
  const observationMs = cutoffMs - occurredAtMs;

  if (warmupMs < 0) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the runtime milestone occurred ${String(-warmupMs)} ms before the process it attests started`,
    );
  }
  if (warmupMs > policy.maximum_warmup_ms) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the derived warmup is ${String(warmupMs)} ms, beyond the committed maximum of ` +
        `${String(policy.maximum_warmup_ms)} ms`,
    );
  }
  if (observationMs < policy.minimum_observation_ms) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the derived observation window is ${String(observationMs)} ms, below the committed minimum ` +
        `of ${String(policy.minimum_observation_ms)} ms`,
    );
  }
  if (observationMs > policy.maximum_observation_ms) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the derived observation window is ${String(observationMs)} ms, beyond the committed maximum ` +
        `of ${String(policy.maximum_observation_ms)} ms`,
    );
  }
  // True by construction of the decomposition above, and asserted anyway: it is
  // the statement of the rule, and a later change to either side must break here
  // rather than silently stop meaning anything.
  if (startedAtMs + warmupMs + observationMs !== cutoffMs) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      "the cutoff instant does not equal process start plus the derived warmup and observation",
    );
  }

  // -- 6. wall and monotonic views of the same interval must agree -----------
  const monotonicElapsedMs = milestone.monotonic_elapsed_ms - receipt.process_start_monotonic_ms;
  if (Math.abs(warmupMs - monotonicElapsedMs) > policy.maximum_monotonic_wall_divergence_ms) {
    throw new Erl2Error(
      CODES.CUTOFF_CLOCK_DIVERGENCE,
      `wall and monotonic elapsed time diverge by ` +
        `${String(Math.abs(warmupMs - monotonicElapsedMs))} ms, beyond the committed bound of ` +
        `${String(policy.maximum_monotonic_wall_divergence_ms)} ms`,
    );
  }
  if (Math.abs(warmupMs) > policy.maximum_process_milestone_skew_ms) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `process-to-milestone skew is ${String(Math.abs(warmupMs))} ms, beyond the committed bound of ` +
        `${String(policy.maximum_process_milestone_skew_ms)} ms`,
    );
  }

  // -- 7. the cutoff must fall inside the policy's own validity window -------
  const validFromMs = instantMs(policy.valid_from, "policy valid_from");
  const validUntilMs = instantMs(policy.valid_until, "policy valid_until");
  if (cutoffMs < validFromMs || cutoffMs > validUntilMs) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the cutoff instant ${cutoff.instant} falls outside the policy's validity window ` +
        `${policy.valid_from} .. ${policy.valid_until}`,
    );
  }

  return {
    instant: cutoff.instant,
    warmupMs,
    observationMs,
    milestoneHash: cutoff.runtime_milestone_hash,
    processStartReceiptHash: cutoff.process_start_receipt_hash,
    policyHash: cutoff.policy_hash,
  };
}

/**
 * The lifecycle ordering the cutoff imposes, derived from the event chain alone.
 *
 * Separate from {@link deriveEvidenceCutoff} because it holds of the *event
 * order*, not of the instants: a producer that got the arithmetic right and the
 * order wrong is a different defect from one that got the order right and the
 * arithmetic wrong, and they should not share a refusal.
 */
export function assertCutoffOrderingFromLifecycle(
  events: readonly LabLifecycleEventV1[],
  milestoneHash: Hash | undefined,
): void {
  const indexOf = (type: string): number => events.findIndex((e) => e.event_type === type);
  const realizedAt = indexOf("evidence_cutoff_realized");
  if (realizedAt < 0) return;

  if (milestoneHash !== undefined) {
    const milestoneAt = events.findIndex((event) =>
      event.produced.some((p) => p.artifact_core_hash === milestoneHash),
    );
    if (milestoneAt < 0 || milestoneAt > realizedAt) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_UNREACHABLE_ARTIFACT,
        "the runtime milestone the cutoff was derived from is reached after the cutoff was realized",
      );
    }
  }

  // The observation freeze is what publishes the cutoff; it cannot precede it.
  const frozenAt = indexOf("observation_frozen");
  if (frozenAt >= 0 && frozenAt < realizedAt) {
    throw new Erl2Error(
      CODES.POLICY_CONFLICT,
      "the observation was frozen before the evidence cutoff was realized",
    );
  }
}
