/**
 * The exact evidence window — the arithmetic half (ADR-ERL2-031 §3.2, §3.3).
 *
 * ADR-ERL2-029 §3.2 could prove the retained cutoff was *consistent with* three
 * signed clocks and every committed bound, and said plainly what it could not
 * prove:
 *
 * > What is **not** proven is that the operator chose a 1-second warmup rather
 * > than a 900 ms one.
 *
 * It could not, because the durations were composition constants retained in no
 * contract, so the derivation read them back out of the very instants it was
 * checking. This suite measures the producer-side half of the fix: the window is
 * validated, bounded and made representable **before** it is signed, and the
 * milestone is then required to land on the boundary it fixed.
 *
 * Pure. No CLI, no filesystem, no disposable run — the semantic mutation battery
 * in `tests/adversarial/evidenceWindowCommitment.test.ts` covers the end-to-end
 * side. What is here is the arithmetic, at every boundary §17 of the remediation
 * brief names.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CutoffPolicyV1, Erl2Error, EvidenceWindowCommitmentV1, Hash, Instant, RuntimeMilestoneV1, TrafficProcessStartReceiptV1 } from "@erl2/contracts";
import { coreHash, developmentKey } from "@erl2/integrity";
import {
  addExactMs,
  assertMilestoneOnCommittedBoundary,
  committedCutoffMs,
  sealWindowCommitment,
} from "@erl2/core";

const RUN = "019f1af9-0000-7000-8000-000000000001";
const STARTED_AT = "2026-07-29T00:00:00Z";
const CLOCK_DOMAIN = coreHash({ domain: "clock" }) as Hash;
const POLICY_AUTHOR = developmentKey("policy-author");

function sealed<T extends Record<string, unknown>>(body: T): T & { core_hash: Hash } {
  return { ...body, core_hash: coreHash(body) };
}

function policy(overrides: Record<string, unknown> = {}): CutoffPolicyV1 {
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
    maximum_warmup_ms: 5_000,
    maximum_observation_ms: 30_000,
    minimum_observation_ms: 1_000,
    event_time_required: true,
    ingestion_time_required: true,
    valid_from: "2026-01-01T00:00:00Z",
    valid_until: "2027-01-01T00:00:00Z",
    signature: {
      algorithm: "Ed25519",
      key_id: "erl2-dev-policy-author-ed25519-1",
      signed_hash: coreHash({ x: 1 }),
      signature_base64: `${"A".repeat(86)}==`,
    },
    ...overrides,
  }) as unknown as CutoffPolicyV1;
}

function receipt(startedAt: string = STARTED_AT): TrafficProcessStartReceiptV1 {
  return sealed({
    schema_version: "traffic-process-start-receipt/v1",
    receipt_id: "traffic-1",
    run_id: RUN,
    selection_commitment_hash: coreHash({ s: 1 }),
    experiment_manifest_hash: coreHash({ e: 1 }),
    environment_fingerprint_hash: coreHash({ f: 1 }),
    traffic_profile_hash: coreHash({ t: 1 }),
    process_identity_hash: coreHash({ p: 1 }),
    supervisor_boot_id_hash: coreHash({ b: 1 }),
    monotonic_clock_domain_hash: CLOCK_DOMAIN,
    process_started_at: startedAt,
    process_start_monotonic_ms: 0,
  }) as unknown as TrafficProcessStartReceiptV1;
}

function milestone(occurredAt: string, monotonicElapsedMs = 1_000): RuntimeMilestoneV1 {
  return sealed({
    schema_version: "runtime-milestone/v1",
    milestone_id: "milestone-1",
    run_id: RUN,
    milestone: "traffic_started",
    selection_commitment_hash: coreHash({ s: 1 }),
    experiment_manifest_hash: coreHash({ e: 1 }),
    environment_fingerprint_hash: coreHash({ f: 1 }),
    traffic_profile_hash: coreHash({ t: 1 }),
    traffic_process_start_receipt_hash: coreHash({ r: 1 }),
    monotonic_clock_domain_hash: CLOCK_DOMAIN,
    occurred_at: occurredAt,
    monotonic_elapsed_ms: monotonicElapsedMs,
  }) as unknown as RuntimeMilestoneV1;
}

function seal(overrides: Partial<Parameters<typeof sealWindowCommitment>[0]> = {}): EvidenceWindowCommitmentV1 {
  return sealWindowCommitment({
    runId: RUN,
    policy: policy(),
    processStartReceipt: receipt(),
    monotonicClockDomainHash: CLOCK_DOMAIN,
    comparisonPolicyHash: coreHash({ c: 1 }),
    environmentInstanceHash: coreHash({ i: 1 }),
    warmupMs: 1_000,
    observationMs: 5_000,
    committedAt: STARTED_AT as Instant,
    signingKey: POLICY_AUTHOR,
    ...overrides,
  });
}

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (cause) {
    return (cause as Erl2Error).code ?? "-";
  }
  return "<no refusal>";
};

// -- the window is fixed before anything observes it -------------------------

test("WINDOW-SEAL: a well-formed window seals, and carries the exact durations", () => {
  const commitment = seal();
  assert.equal(commitment.schema_version, "evidence-window-commitment/v1");
  assert.equal(commitment.warmup_ms, 1_000);
  assert.equal(commitment.observation_ms, 5_000);
  assert.equal(commitment.run_id, RUN);
  // The rule it implements is pinned, so a future derivation cannot silently
  // reinterpret an old commitment under different arithmetic.
  assert.equal(commitment.instant_rule, "traffic_process_started_at_plus_warmup_ms_plus_observation_ms");
  assert.equal(commitment.milestone_relationship, "runtime_milestone_at_process_start_plus_warmup_ms");
  assert.equal(commitment.signature.key_id, "erl2-dev-policy-author-ed25519-1");
});

test("WINDOW-SEAL: the cutoff is exactly process start plus warmup plus observation", () => {
  const commitment = seal();
  assert.equal(committedCutoffMs(commitment, receipt()), Date.parse("2026-07-29T00:00:06Z"));
});

// -- §17: every duration boundary -------------------------------------------

test("WINDOW-BOUNDS: a zero warmup is legal; a zero observation window is not", () => {
  // Zero warmup means the milestone is the process start, which is a degenerate
  // but coherent window. Zero observation means no window at all, and the policy's
  // own `minimum_observation_ms` starts at 1.
  assert.equal(seal({ warmupMs: 0 }).warmup_ms, 0);
  assert.equal(codeOf(() => seal({ observationMs: 0 })), "CUTOFF_BOUND_EXCEEDED");
});

test("WINDOW-BOUNDS: the policy's minimum and maximum are the edges, inclusive", () => {
  // Exactly at each edge: legal.
  assert.equal(seal({ observationMs: 1_000 }).observation_ms, 1_000);
  assert.equal(seal({ observationMs: 30_000 }).observation_ms, 30_000);
  assert.equal(seal({ warmupMs: 5_000 }).warmup_ms, 5_000);
});

test("WINDOW-BOUNDS: one unit outside either edge refuses", () => {
  // "One unit" is a whole second here, because a sub-second window is refused for
  // a different reason and would not isolate the bound.
  assert.equal(codeOf(() => seal({ observationMs: 31_000 })), "CUTOFF_BOUND_EXCEEDED");
  assert.equal(codeOf(() => seal({ warmupMs: 6_000 })), "CUTOFF_BOUND_EXCEEDED");
  // And the *contract's* own ceiling, above the policy's.
  assert.equal(
    codeOf(() => seal({ policy: policy({ maximum_warmup_ms: 5_400_000 }), warmupMs: 5_401_000 })),
    "CUTOFF_BOUND_EXCEEDED",
  );
});

test("WINDOW-BOUNDS: a negative duration refuses", () => {
  assert.equal(codeOf(() => seal({ warmupMs: -1_000 })), "CUTOFF_BOUND_EXCEEDED");
  assert.equal(codeOf(() => seal({ observationMs: -5_000 })), "CUTOFF_BOUND_EXCEEDED");
});

test("WINDOW-BOUNDS: a fractional duration refuses", () => {
  assert.equal(codeOf(() => seal({ warmupMs: 1_000.5 })), "CUTOFF_BOUND_EXCEEDED");
  assert.equal(codeOf(() => seal({ observationMs: Number.NaN })), "CUTOFF_BOUND_EXCEEDED");
});

test("WINDOW-BOUNDS: a sub-second window refuses, because its instant is not representable", () => {
  // The hazard is specific and easy to miss. `Instant` is second-precision, and
  // the producer renders it by *truncating* a millisecond ISO string:
  //
  //   new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")
  //
  // So a 900 ms warmup would render `…T00:00:00Z` and the retained instant would
  // disagree with the arithmetic that produced it by 900 ms — silently. Refusing
  // before the signature is the only honest place to catch it.
  assert.equal(codeOf(() => seal({ warmupMs: 900 })), "CUTOFF_BOUND_EXCEEDED");
  assert.equal(codeOf(() => seal({ warmupMs: 1_500 })), "CUTOFF_BOUND_EXCEEDED");
  assert.equal(codeOf(() => seal({ observationMs: 5_500 })), "CUTOFF_BOUND_EXCEEDED");
});

test("WINDOW-ARITH: exact integer addition refuses to overflow rather than losing precision", () => {
  assert.equal(addExactMs(1, 2, "x"), 3);
  assert.equal(codeOf(() => addExactMs(Number.MAX_SAFE_INTEGER, 1, "x")), "CUTOFF_BOUND_EXCEEDED");
  assert.equal(codeOf(() => addExactMs(0.5, 1, "x")), "CUTOFF_BOUND_EXCEEDED");
  assert.equal(codeOf(() => addExactMs(Number.POSITIVE_INFINITY, 1, "x")), "CUTOFF_BOUND_EXCEEDED");
});

// -- §17: clock domain and skew ---------------------------------------------

test("WINDOW-CLOCK: a window measured against another clock domain refuses", () => {
  assert.equal(
    codeOf(() => seal({ monotonicClockDomainHash: coreHash({ other: 1 }) as Hash })),
    "CUTOFF_CLOCK_DOMAIN_MISMATCH",
  );
});

test("WINDOW-RUN: a receipt from another run refuses before it is signed", () => {
  const foreign = sealed({
    ...receipt(),
    run_id: "019f1af9-0000-7000-8000-0000000000ff",
  }) as unknown as TrafficProcessStartReceiptV1;
  assert.equal(codeOf(() => seal({ processStartReceipt: foreign })), "GRAPH_CLOSURE_TERMINAL_MISMATCH");
});

test("WINDOW-MILESTONE: the observed milestone must land exactly on the committed boundary", () => {
  const commitment = seal();
  // Exactly on it.
  assertMilestoneOnCommittedBoundary(commitment, receipt(), milestone("2026-07-29T00:00:01Z"));
  // One second early, one second late — both refuse. A milestone that may drift is
  // a milestone that can be moved to fit a window chosen afterwards, which is the
  // residual this package closes.
  assert.equal(
    codeOf(() => assertMilestoneOnCommittedBoundary(commitment, receipt(), milestone(STARTED_AT))),
    "CUTOFF_BOUND_EXCEEDED",
  );
  assert.equal(
    codeOf(() =>
      assertMilestoneOnCommittedBoundary(commitment, receipt(), milestone("2026-07-29T00:00:02Z")),
    ),
    "CUTOFF_BOUND_EXCEEDED",
  );
});

test("WINDOW-MILESTONE: a milestone before the process it attests refuses", () => {
  assert.equal(
    codeOf(() =>
      assertMilestoneOnCommittedBoundary(seal(), receipt(), milestone("2026-07-28T23:59:59Z")),
    ),
    "CUTOFF_BOUND_EXCEEDED",
  );
});

test("WINDOW-MILESTONE: a zero-warmup window puts the milestone at the process start", () => {
  const commitment = seal({ warmupMs: 0 });
  assertMilestoneOnCommittedBoundary(commitment, receipt(), milestone(STARTED_AT, 0));
  assert.equal(
    codeOf(() =>
      assertMilestoneOnCommittedBoundary(commitment, receipt(), milestone("2026-07-29T00:00:01Z")),
    ),
    "CUTOFF_BOUND_EXCEEDED",
  );
});

// -- §17: the timezone question, answered rather than assumed ----------------

test("WINDOW-TZ: the arithmetic is on UTC instants, so offsets and DST are irrelevant", () => {
  // `Instant` is RFC 3339 with a literal `Z`, and every derived value is epoch
  // milliseconds. This case exists because "daylight saving cannot affect it" is
  // the kind of claim that is true until someone parses a local time.
  //
  // 2026-03-29 is the European DST transition; 02:00 local does not exist. The
  // window either side of it is still exactly six seconds of UTC.
  const across = receipt("2026-03-29T00:59:58Z");
  const commitment = seal({ processStartReceipt: across, warmupMs: 1_000, observationMs: 5_000 });
  assert.equal(committedCutoffMs(commitment, across), Date.parse("2026-03-29T01:00:04Z"));
  assertMilestoneOnCommittedBoundary(commitment, across, milestone("2026-03-29T00:59:59Z"));

  // And a leap-second-shaped instant is simply not representable in the contract,
  // so it cannot reach the arithmetic at all.
  assert.equal(Number.isNaN(Date.parse("2026-12-31T23:59:60Z")), true);
});

test("WINDOW-TZ: an unparseable process start refuses rather than yielding NaN arithmetic", () => {
  const broken = sealed({ ...receipt(), process_started_at: "not-an-instant" }) as unknown as TrafficProcessStartReceiptV1;
  assert.equal(codeOf(() => seal({ processStartReceipt: broken })), "CUTOFF_BOUND_EXCEEDED");
});
