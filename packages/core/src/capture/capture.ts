/**
 * Evidence capture, cutoff realization and observation freeze
 * (design v2 §13, implementation plan §10.1 S4.7).
 *
 * The cutoff is *derived*, never asserted: it comes from the independently
 * signed traffic-process start receipt plus the committed warmup and
 * observation durations, and wall, monotonic and policy bounds must agree.
 * Exactly-at-cutoff event time is excluded; late ingestion is allowed only
 * through the committed grace and never changes event-time eligibility.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type ArtifactRef,
  type CutoffPolicyV1,
  type Hash,
  type Instant,
  type ObservationBundleV2,
  type RuntimeMilestoneV1,
  type SourceSnapshotV1,
  type SourceState,
  type TrafficProcessStartReceiptV1,
} from "@erl2/contracts";
import { ArtifactStore, coreHash, treeHash } from "@erl2/integrity";
import { assertNoCanaryLeak, type OracleScanTarget } from "../journey/oracle.js";

export interface CutoffInput {
  readonly policy: CutoffPolicyV1;
  readonly processStartReceipt: TrafficProcessStartReceiptV1;
  readonly runtimeMilestone: RuntimeMilestoneV1;
  readonly warmupMs: number;
  readonly observationMs: number;
}

export interface RealizedCutoff {
  readonly instant: Instant;
  readonly policyHash: Hash;
  readonly processStartReceiptHash: Hash;
  readonly runtimeMilestoneHash: Hash;
}

/** Derives the concrete cutoff instant and checks every policy bound. */
export function realizeCutoff(input: CutoffInput): RealizedCutoff {
  const { policy, processStartReceipt, runtimeMilestone } = input;

  if (input.warmupMs > policy.maximum_warmup_ms) {
    throw new Erl2Error(CODES.CUTOFF_BOUND_EXCEEDED, "warmup exceeds the committed maximum");
  }
  if (input.observationMs > policy.maximum_observation_ms) {
    throw new Erl2Error(CODES.CUTOFF_BOUND_EXCEEDED, "observation exceeds the committed maximum");
  }
  if (input.observationMs < policy.minimum_observation_ms) {
    throw new Erl2Error(CODES.CUTOFF_BOUND_EXCEEDED, "observation is below the committed minimum");
  }
  if (runtimeMilestone.traffic_process_start_receipt_hash !== coreHash(processStartReceipt)) {
    throw new Erl2Error(
      CODES.CUTOFF_MILESTONE_MISMATCH,
      "runtime milestone does not reference the signed process-start receipt",
    );
  }
  if (runtimeMilestone.monotonic_clock_domain_hash !== processStartReceipt.monotonic_clock_domain_hash) {
    throw new Erl2Error(
      CODES.CUTOFF_CLOCK_DOMAIN_MISMATCH,
      "milestone and process-start receipt are in different monotonic clock domains",
    );
  }

  // Wall and monotonic views of the same elapsed interval must agree within
  // the committed divergence bound.
  const wallElapsedMs = Date.parse(runtimeMilestone.occurred_at) - Date.parse(processStartReceipt.process_started_at);
  const monotonicElapsedMs =
    runtimeMilestone.monotonic_elapsed_ms - processStartReceipt.process_start_monotonic_ms;
  if (Math.abs(wallElapsedMs - monotonicElapsedMs) > policy.maximum_monotonic_wall_divergence_ms) {
    throw new Erl2Error(
      CODES.CUTOFF_CLOCK_DIVERGENCE,
      "wall and monotonic elapsed time diverge beyond the committed bound",
    );
  }
  if (Math.abs(wallElapsedMs) > policy.maximum_process_milestone_skew_ms) {
    throw new Erl2Error(CODES.CUTOFF_BOUND_EXCEEDED, "process-to-milestone skew exceeds the bound");
  }

  const instantMs =
    Date.parse(processStartReceipt.process_started_at) + input.warmupMs + input.observationMs;
  return {
    instant: new Date(instantMs).toISOString().replace(/\.\d{3}Z$/, "Z") as Instant,
    policyHash: coreHash(policy),
    processStartReceiptHash: coreHash(processStartReceipt),
    runtimeMilestoneHash: coreHash(runtimeMilestone),
  };
}

/**
 * Event-time eligibility. Exactly-at-cutoff is excluded; ingestion may lag by
 * the committed grace but that never widens the event-time window.
 */
export function isEligibleAtCutoff(
  cutoff: RealizedCutoff,
  policy: CutoffPolicyV1,
  eventTime: string,
  ingestionTime: string,
): boolean {
  const cutoffMs = Date.parse(cutoff.instant);
  const eventMs = Date.parse(eventTime);
  const ingestionMs = Date.parse(ingestionTime);
  if (!(eventMs < cutoffMs)) return false;
  return ingestionMs <= cutoffMs + policy.late_arrival_grace_ms;
}

export interface SnapshotInput {
  readonly runId: string;
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly sourceSchema: string;
  readonly sourceIdentityHash: Hash;
  readonly state: SourceState;
  readonly queryHash: Hash;
  readonly window: { readonly from: Instant; readonly to_exclusive: Instant };
  readonly startedAt: Instant;
  readonly endedAt: Instant;
  readonly pages: number;
  readonly records: number;
  readonly bytes: number;
  readonly dedupeKey: string;
  readonly orderingId: string;
  readonly healthRecordHash: Hash;
  readonly unavailableReasonCode?: string;
  readonly recordsArtifact?: ArtifactRef;
  readonly truncated?: { readonly reason: string };
}

/**
 * Freezes one source snapshot. Every state is explicit: an unavailable,
 * partial or errored source is a retained result, never a silent omission.
 */
export function freezeSourceSnapshot(input: SnapshotInput): SourceSnapshotV1 {
  const base = {
    schema_version: "source-snapshot/v1" as const,
    run_id: input.runId,
    snapshot_id: input.snapshotId,
    source_id: input.sourceId,
    source_kind: input.sourceKind,
    source_schema: input.sourceSchema,
    source_identity_hash: input.sourceIdentityHash,
    state: input.state,
    query_hash: input.queryHash,
    window: input.window,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    pages: input.pages,
    records: input.records,
    bytes: input.bytes,
    dedupe_key: input.dedupeKey,
    ordering_id: input.orderingId,
    sampling: { kind: "none" },
    truncation:
      input.truncated === undefined
        ? { truncated: false }
        : { truncated: true, reason: input.truncated.reason },
    health_record_hash: input.healthRecordHash,
    ...(input.unavailableReasonCode === undefined
      ? {}
      : { unavailable_reason_code: input.unavailableReasonCode }),
    ...(input.recordsArtifact === undefined ? {} : { records_artifact: input.recordsArtifact }),
    provenance: {
      producer: "erl2-capture-coordinator",
      producer_version: "0.1.0",
      transformations: [] as string[],
    },
  };
  return assertContract<SourceSnapshotV1>("SourceSnapshotV1", {
    ...base,
    core_hash: coreHash(base),
  });
}

export interface FreezeObservationOptions {
  readonly runId: string;
  readonly planHash: Hash;
  readonly environmentInstanceHash: Hash;
  readonly cutoff: RealizedCutoff;
  readonly snapshots: readonly SourceSnapshotV1[];
  readonly subjectVisibleProjectionPolicyHash: Hash;
  readonly comparisonPolicyHash: Hash;
  readonly canonicalEvidenceEnvelopeHash: Hash;
  readonly redactionPolicyHash: Hash;
  readonly entries: readonly ArtifactRef[];
  readonly frozenAt: Instant;
  readonly store: ArtifactStore;
  /** Known judge canaries; the observation is scanned before it is retained. */
  readonly knownCanaryIds: readonly string[];
}

/**
 * Freezes the observation bundle.
 *
 * The leak scan runs before retention and must find zero canaries — the schema
 * pins `canaries_found` to `0`, so a bundle that found one cannot even be
 * constructed.
 */
export function freezeObservation(options: FreezeObservationOptions): ObservationBundleV2 {
  const scanTargets: OracleScanTarget[] = options.snapshots.map((snapshot) => ({
    surface: "lab_telemetry" as const,
    label: `source-snapshot:${snapshot.snapshot_id}`,
    bytes: JSON.stringify(snapshot),
  }));
  assertNoCanaryLeak(scanTargets, options.knownCanaryIds);

  const base = {
    schema_version: "observation-bundle/v2" as const,
    run_id: options.runId,
    plan_hash: options.planHash,
    environment_instance_hash: options.environmentInstanceHash,
    cutoff: {
      instant: options.cutoff.instant,
      policy_hash: options.cutoff.policyHash,
      process_start_receipt_hash: options.cutoff.processStartReceiptHash,
      runtime_milestone_hash: options.cutoff.runtimeMilestoneHash,
    },
    source_snapshots: options.snapshots.map((s) => ({
      snapshot_id: s.snapshot_id,
      snapshot_hash: coreHash(s),
      state: s.state,
    })),
    subject_visible_projection_policy_hash: options.subjectVisibleProjectionPolicyHash,
    comparison_policy_hash: options.comparisonPolicyHash,
    canonical_evidence_envelope_hash: options.canonicalEvidenceEnvelopeHash,
    redaction_policy_hash: options.redactionPolicyHash,
    leak_scan: { version: "erl2-leak-scan/0.1.0", findings: 0, canaries_found: 0 as const },
    entries: [...options.entries],
    tree_hash: treeHash(options.entries),
    frozen_at: options.frozenAt,
  };
  const bundle = assertContract<ObservationBundleV2>("ObservationBundleV2", {
    ...base,
    core_hash: coreHash(base),
  });
  options.store.freezeJson("retained/observation-bundle.json", bundle, "INTERNAL");
  return bundle;
}
