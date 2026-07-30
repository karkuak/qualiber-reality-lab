/**
 * The evidence cutoff, re-derived offline (ADR-ERL2-029 §3).
 *
 * The *pure* half. Every case builds the three cutoff inputs by hand, writes
 * them into a disposable artifact root and scans it, because the point is what
 * the **derivation** does with a set of retained instants — not what the fake
 * capture path happens to produce. The producer's own `realizeCutoff` is never
 * called and never imported: two implementations agreeing proves the
 * implementations agree (ADR-ERL2-024 §7).
 *
 * The review's finding is the first case: *an observation bundle naming a
 * nonexistent runtime milestone verifies as valid.* Before this derivation
 * existed, `cutoff.runtime_milestone_hash` was a 32-byte string nothing resolved.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Erl2Error, Hash, LabLifecycleEventV1 } from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";
import { ArtifactIndex, deriveEvidenceCutoff } from "@erl2/public-verifier";

const RUN = "019f1af9-0000-7000-8000-000000000001";
const OTHER_RUN = "019f1af9-0000-7000-8000-0000000000ff";

const STARTED_AT = "2026-07-29T00:00:00Z";
const OCCURRED_AT = "2026-07-29T00:00:01Z"; // +1_000 ms warmup
const CUTOFF_AT = "2026-07-29T00:00:06Z"; // +5_000 ms observation

/** Seals a body with its own `core_hash`, the way every retained artifact is. */
function sealed<T extends Record<string, unknown>>(body: T): T & { core_hash: Hash } {
  return { ...body, core_hash: coreHash(body) };
}

function cutoffPolicy(overrides: Record<string, unknown> = {}) {
  return sealed({
    schema_version: "cutoff-policy/v1",
    policy_id: "cut-1",
    version: 1,
    clock: "host_utc",
    instant_rule: "traffic_process_started_at_plus_warmup_ms_plus_observation_ms",
    inclusion: "event_time_lt_and_ingestion_time_lte",
    max_skew_ms: 1000,
    late_arrival_grace_ms: 1000,
    maximum_selection_to_traffic_start_ms: 600_000,
    maximum_timestamp_submission_delay_ms: 600_000,
    maximum_process_milestone_skew_ms: 600_000,
    maximum_monotonic_wall_divergence_ms: 1000,
    maximum_warmup_ms: 5000,
    maximum_observation_ms: 30_000,
    minimum_observation_ms: 1000,
    event_time_required: true,
    ingestion_time_required: true,
    valid_from: "2026-01-01T00:00:00Z",
    valid_until: "2027-01-01T00:00:00Z",
    ...overrides,
  });
}

function startReceipt(overrides: Record<string, unknown> = {}) {
  return sealed({
    schema_version: "traffic-process-start-receipt/v1",
    receipt_id: "psr-1",
    run_id: RUN,
    selection_commitment_hash: `sha256:${"1".repeat(64)}` as Hash,
    experiment_manifest_hash: `sha256:${"2".repeat(64)}` as Hash,
    environment_fingerprint_hash: `sha256:${"3".repeat(64)}` as Hash,
    traffic_profile_hash: `sha256:${"4".repeat(64)}` as Hash,
    process_identity_hash: `sha256:${"5".repeat(64)}` as Hash,
    supervisor_boot_id_hash: `sha256:${"6".repeat(64)}` as Hash,
    monotonic_clock_domain_hash: `sha256:${"7".repeat(64)}` as Hash,
    process_started_at: STARTED_AT,
    process_start_monotonic_ms: 0,
    ...overrides,
  });
}

function milestone(receiptHash: Hash, overrides: Record<string, unknown> = {}) {
  return sealed({
    schema_version: "runtime-milestone/v1",
    milestone_id: "ms-1",
    run_id: RUN,
    milestone: "traffic_started",
    selection_commitment_hash: `sha256:${"1".repeat(64)}` as Hash,
    experiment_manifest_hash: `sha256:${"2".repeat(64)}` as Hash,
    environment_fingerprint_hash: `sha256:${"3".repeat(64)}` as Hash,
    traffic_profile_hash: `sha256:${"4".repeat(64)}` as Hash,
    traffic_process_start_receipt_hash: receiptHash,
    monotonic_clock_domain_hash: `sha256:${"7".repeat(64)}` as Hash,
    occurred_at: OCCURRED_AT,
    monotonic_elapsed_ms: 1000,
    ...overrides,
  });
}

function observationBundle(
  policyHash: Hash,
  receiptHash: Hash,
  milestoneHash: Hash,
  overrides: Record<string, unknown> = {},
) {
  return sealed({
    schema_version: "observation-bundle/v2",
    run_id: RUN,
    plan_hash: `sha256:${"8".repeat(64)}` as Hash,
    environment_instance_hash: `sha256:${"9".repeat(64)}` as Hash,
    cutoff: {
      instant: CUTOFF_AT,
      policy_hash: policyHash,
      process_start_receipt_hash: receiptHash,
      runtime_milestone_hash: milestoneHash,
    },
    source_snapshots: [
      { snapshot_id: "snap-1", snapshot_hash: `sha256:${"a".repeat(64)}` as Hash, state: "complete" },
    ],
    subject_visible_projection_policy_hash: `sha256:${"b".repeat(64)}` as Hash,
    comparison_policy_hash: `sha256:${"c".repeat(64)}` as Hash,
    canonical_evidence_envelope_hash: `sha256:${"d".repeat(64)}` as Hash,
    redaction_policy_hash: `sha256:${"e".repeat(64)}` as Hash,
    leak_scan: { version: "1", findings: 0, canaries_found: 0 },
    entries: [],
    tree_hash: `sha256:${"f".repeat(64)}` as Hash,
    frozen_at: CUTOFF_AT,
    ...overrides,
  });
}

/** Writes a set of artifacts into a disposable root and scans it. */
function scan(artifacts: readonly Record<string, unknown>[]): ArtifactIndex {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-cutoff-"));
  mkdirSync(path.join(root, "retained"), { recursive: true });
  for (const [i, artifact] of artifacts.entries()) {
    writeFileSync(
      path.join(root, "retained", `artifact-${String(i)}.json`),
      JSON.stringify(artifact),
    );
  }
  return ArtifactIndex.scan(root);
}

/** A lifecycle that reaches every hash it is given, in order. */
function lifecycleReaching(...hashes: readonly Hash[]): readonly LabLifecycleEventV1[] {
  const events = hashes.map(
    (hash, i) =>
      ({
        event_type: `artifact_reached_${String(i)}`,
        produced: [{ artifact_role: "supporting", artifact_core_hash: hash }],
      }) as unknown as LabLifecycleEventV1,
  );
  return [
    ...events,
    { event_type: "evidence_cutoff_realized", produced: [] } as unknown as LabLifecycleEventV1,
  ];
}

/** The canonical, internally consistent set: policy, receipt, milestone, bundle. */
function wellFormed(
  mutate: {
    readonly policy?: Record<string, unknown>;
    readonly receipt?: Record<string, unknown>;
    readonly milestone?: Record<string, unknown>;
    readonly bundle?: Record<string, unknown>;
  } = {},
) {
  const policy = cutoffPolicy(mutate.policy);
  const receipt = startReceipt(mutate.receipt);
  const ms = milestone(receipt.core_hash, mutate.milestone);
  const bundle = observationBundle(policy.core_hash, receipt.core_hash, ms.core_hash, mutate.bundle);
  return { policy, receipt, milestone: ms, bundle };
}

function derive(
  artifacts: readonly Record<string, unknown>[],
  lifecycle: readonly LabLifecycleEventV1[],
): ReturnType<typeof deriveEvidenceCutoff> {
  return deriveEvidenceCutoff({ index: scan(artifacts), lifecycle, runId: RUN });
}

function refusalCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Erl2Error).code ?? "-";
  }
  return "NO_REFUSAL";
}

// -- baseline ----------------------------------------------------------------

test("CUTOFF-DERIVE: a well-formed cutoff derives its warmup and observation windows", () => {
  const { policy, receipt, milestone: ms, bundle } = wellFormed();
  const derived = derive(
    [policy, receipt, ms, bundle],
    lifecycleReaching(receipt.core_hash, ms.core_hash),
  );
  assert.ok(derived, "a run with an observation bundle derives a cutoff");
  assert.equal(derived.warmupMs, 1000);
  assert.equal(derived.observationMs, 5000);
  assert.equal(derived.instant, CUTOFF_AT);
});

test("CUTOFF-DERIVE: a run that realized no cutoff derives none rather than refusing", () => {
  // The capture group is optional as a group: a run that terminated before
  // `traffic_or_journey_started` never realized a cutoff, and requiring one would
  // force a synthetic observation (design v2 §26, ADR-ERL2-029 §3.4).
  const { policy, receipt } = wellFormed();
  assert.equal(derive([policy, receipt], []), undefined);
});

// -- the review's case -------------------------------------------------------

test("CUTOFF-MUT: an observation bundle naming a nonexistent runtime milestone is refused", () => {
  // The finding, verbatim. The bundle is otherwise perfect and internally
  // consistent — its own core_hash is correct — and the milestone hash is a
  // well-formed hash that names nothing.
  const { policy, receipt } = wellFormed();
  const absent = `sha256:${"0".repeat(64)}` as Hash;
  const bundle = observationBundle(policy.core_hash, receipt.core_hash, absent);
  assert.equal(
    refusalCode(() => derive([policy, receipt, bundle], lifecycleReaching(receipt.core_hash))),
    "CUTOFF_MILESTONE_MISMATCH",
  );
});

test("CUTOFF-MUT: a cutoff naming a nonexistent process-start receipt is refused", () => {
  const { policy, receipt, milestone: ms } = wellFormed();
  const absent = `sha256:${"0".repeat(64)}` as Hash;
  const bundle = observationBundle(policy.core_hash, absent, ms.core_hash);
  assert.equal(
    refusalCode(() => derive([policy, receipt, ms, bundle], lifecycleReaching(ms.core_hash))),
    "CUTOFF_MILESTONE_MISMATCH",
  );
});

// -- binding -----------------------------------------------------------------

test("CUTOFF-MUT: a milestone bound to a different process-start receipt is refused", () => {
  // The substitution the *producer* cannot catch: the milestone is honestly and
  // consistently bound to some other receipt, and the cutoff cites this run's.
  // `realizeCutoff` checks the milestone against the receipt it was handed; the
  // verifier checks it against the receipt the cutoff names.
  const policy = cutoffPolicy();
  const receipt = startReceipt();
  const otherReceipt = startReceipt({ receipt_id: "psr-other" });
  const ms = milestone(otherReceipt.core_hash);
  const bundle = observationBundle(policy.core_hash, receipt.core_hash, ms.core_hash);
  assert.equal(
    refusalCode(() =>
      derive(
        [policy, receipt, otherReceipt, ms, bundle],
        lifecycleReaching(receipt.core_hash, ms.core_hash),
      ),
    ),
    "CUTOFF_MILESTONE_MISMATCH",
  );
});

test("CUTOFF-MUT: a milestone in a different monotonic clock domain is refused", () => {
  const { policy, receipt, milestone: ms, bundle } = wellFormed({
    milestone: { monotonic_clock_domain_hash: `sha256:${"e".repeat(64)}` as Hash },
  });
  assert.equal(
    refusalCode(() =>
      derive([policy, receipt, ms, bundle], lifecycleReaching(receipt.core_hash, ms.core_hash)),
    ),
    "CUTOFF_CLOCK_DOMAIN_MISMATCH",
  );
});

test("CUTOFF-MUT: a milestone from another run is refused", () => {
  const { policy, receipt, milestone: ms, bundle } = wellFormed({
    milestone: { run_id: OTHER_RUN },
  });
  assert.equal(
    refusalCode(() =>
      derive([policy, receipt, ms, bundle], lifecycleReaching(receipt.core_hash, ms.core_hash)),
    ),
    "CUTOFF_MILESTONE_MISMATCH",
  );
});

// -- reachability ------------------------------------------------------------

test("CUTOFF-MUT: a milestone retained but never lifecycle-reached is refused", () => {
  // A snapshot-only artifact with no authoritative event is the shape the closure
  // refuses everywhere else. A cutoff input is not exempt for being carried in a
  // supporting schema rather than a roled one (ADR-ERL2-029 §3.1).
  const { policy, receipt, milestone: ms, bundle } = wellFormed();
  assert.equal(
    refusalCode(() => derive([policy, receipt, ms, bundle], lifecycleReaching(receipt.core_hash))),
    "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT",
  );
});

// -- bounds ------------------------------------------------------------------

test("CUTOFF-MUT: an observation window beyond the committed maximum is refused", () => {
  const { policy, receipt, milestone: ms, bundle } = wellFormed({
    policy: { maximum_observation_ms: 2000 },
  });
  assert.equal(
    refusalCode(() =>
      derive([policy, receipt, ms, bundle], lifecycleReaching(receipt.core_hash, ms.core_hash)),
    ),
    "CUTOFF_BOUND_EXCEEDED",
  );
});

test("CUTOFF-MUT: an observation window below the committed minimum is refused", () => {
  const { policy, receipt, milestone: ms, bundle } = wellFormed({
    policy: { minimum_observation_ms: 10_000 },
  });
  assert.equal(
    refusalCode(() =>
      derive([policy, receipt, ms, bundle], lifecycleReaching(receipt.core_hash, ms.core_hash)),
    ),
    "CUTOFF_BOUND_EXCEEDED",
  );
});

test("CUTOFF-MUT: a warmup beyond the committed maximum is refused", () => {
  const { policy, receipt, milestone: ms, bundle } = wellFormed({
    policy: { maximum_warmup_ms: 500 },
  });
  assert.equal(
    refusalCode(() =>
      derive([policy, receipt, ms, bundle], lifecycleReaching(receipt.core_hash, ms.core_hash)),
    ),
    "CUTOFF_BOUND_EXCEEDED",
  );
});

test("CUTOFF-MUT: a milestone occurring before the process it attests started is refused", () => {
  const { policy, receipt, milestone: ms, bundle } = wellFormed({
    milestone: { occurred_at: "2026-07-28T23:59:59Z", monotonic_elapsed_ms: 0 },
  });
  assert.equal(
    refusalCode(() =>
      derive([policy, receipt, ms, bundle], lifecycleReaching(receipt.core_hash, ms.core_hash)),
    ),
    "CUTOFF_BOUND_EXCEEDED",
  );
});

// -- clocks ------------------------------------------------------------------

test("CUTOFF-MUT: wall and monotonic views that diverge beyond the bound are refused", () => {
  // Wall says 1_000 ms elapsed between process start and the milestone; the
  // monotonic counter says 9_000. One of the two clocks is lying, and the policy
  // committed to a 1_000 ms tolerance.
  const { policy, receipt, milestone: ms, bundle } = wellFormed({
    milestone: { monotonic_elapsed_ms: 9000 },
  });
  assert.equal(
    refusalCode(() =>
      derive([policy, receipt, ms, bundle], lifecycleReaching(receipt.core_hash, ms.core_hash)),
    ),
    "CUTOFF_CLOCK_DIVERGENCE",
  );
});

test("CUTOFF-MUT: a policy whose instant rule this verifier does not implement is refused", () => {
  // Fails closed rather than deriving under a rule it does not know. A future
  // rule must be implemented here before a bundle citing it can verify.
  const { policy, receipt, milestone: ms, bundle } = wellFormed({
    policy: { instant_rule: "some_future_rule" },
  });
  assert.equal(
    refusalCode(() =>
      derive([policy, receipt, ms, bundle], lifecycleReaching(receipt.core_hash, ms.core_hash)),
    ),
    "CUTOFF_BOUND_EXCEEDED",
  );
});

test("CUTOFF-MUT: a cutoff outside the policy's own validity window is refused", () => {
  const { policy, receipt, milestone: ms, bundle } = wellFormed({
    policy: { valid_until: "2026-07-28T00:00:00Z" },
  });
  assert.equal(
    refusalCode(() =>
      derive([policy, receipt, ms, bundle], lifecycleReaching(receipt.core_hash, ms.core_hash)),
    ),
    "CUTOFF_BOUND_EXCEEDED",
  );
});

test("CUTOFF-MUT: an observation bundle belonging to another run is refused", () => {
  const { policy, receipt, milestone: ms } = wellFormed();
  const bundle = observationBundle(policy.core_hash, receipt.core_hash, ms.core_hash, {
    run_id: OTHER_RUN,
  });
  assert.equal(
    refusalCode(() =>
      derive([policy, receipt, ms, bundle], lifecycleReaching(receipt.core_hash, ms.core_hash)),
    ),
    "CUTOFF_MILESTONE_MISMATCH",
  );
});

test("CUTOFF-MUT: two retained observation bundles are refused rather than one being picked", () => {
  const { policy, receipt, milestone: ms, bundle } = wellFormed();
  const second = observationBundle(policy.core_hash, receipt.core_hash, ms.core_hash, {
    frozen_at: "2026-07-29T00:00:07Z",
  });
  assert.equal(
    refusalCode(() =>
      derive(
        [policy, receipt, ms, bundle, second],
        lifecycleReaching(receipt.core_hash, ms.core_hash),
      ),
    ),
    "CUTOFF_MILESTONE_MISMATCH",
  );
});
