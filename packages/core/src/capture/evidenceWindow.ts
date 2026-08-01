/**
 * The producer's evidence-window commitment (ADR-ERL2-031).
 *
 * ## What this replaces
 *
 * `WARMUP_MS = 1_000` and `OBSERVATION_MS = 5_000` were **constants of the
 * composition** (`environmentRun.ts:233`), retained in no contract. ADR-ERL2-029
 * §3.2 measured what that costs and said so plainly:
 *
 * > What is **not** proven is that the operator chose a 1-second warmup rather
 * > than a 900 ms one. A producer that moved the window inside the committed
 * > bounds, and moved the milestone with it, is not caught — and could not be by
 * > any reader that does not hold the durations.
 *
 * A reader cannot recompute a number nobody wrote down. So the run writes it
 * down, signs it, and does so **before** it observes the milestone the cutoff is
 * anchored on. From then on every phase reads the frozen commitment; the
 * configured durations are an input to the freeze and to nothing else.
 *
 * ## Sealed before the milestone, written after it
 *
 * The window must be fixed before the milestone is read, or the milestone could
 * be chosen to fit it — which is the residual. But writing the commitment before
 * the milestone check would leave retained bytes behind on a refusal, which is
 * the P1-10 defect ADR-ERL2-028 §3 removed: *a resolution that can throw must
 * never sit between two freezes.*
 *
 * Both hold because sealing and writing are different acts. `sealWindowCommitment`
 * computes the bytes and the signature — the window is fixed at that point — and
 * nothing reaches the disk until the milestone has been observed and checked
 * against it. A run whose milestone misses the committed boundary writes nothing.
 *
 * ## What this does not claim
 *
 * An authorized `policy_author` that deliberately commits a different window
 * produces a terminal that verifies. The commitment proves a window was fixed
 * under an authorized key before capture and that every later instant matches it
 * exactly — not that it was the right window. Which windows are permissible is
 * the cutoff policy's business and who may commit one is the trust policy's
 * (ADR-ERL2-031 §3.4).
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type CutoffPolicyV1,
  type EvidenceWindowCommitmentV1,
  type Hash,
  type Instant,
  type RuntimeMilestoneV1,
  type TrafficProcessStartReceiptV1,
} from "@erl2/contracts";
import { coreHash, sealSigned, type SigningKey } from "@erl2/integrity";

/**
 * Instants are second-precision by contract and the renderer **truncates** a
 * millisecond ISO string rather than rounding, so a window that is not a whole
 * number of seconds would render an instant disagreeing with the arithmetic that
 * produced it. The schema pins `multipleOf: 1000`; this is the producer's own
 * check, because a schema that is the only thing enforcing a numeric invariant
 * stops enforcing it the moment a caller constructs the object directly.
 */
const MS_PER_SECOND = 1_000;

/** The ceiling both duration fields share with `CutoffPolicyV1`. */
const MAXIMUM_DURATION_MS = 5_400_000;

export interface WindowCommitmentInput {
  readonly runId: string;
  readonly policy: CutoffPolicyV1;
  readonly processStartReceipt: TrafficProcessStartReceiptV1;
  readonly monotonicClockDomainHash: Hash;
  readonly comparisonPolicyHash: Hash;
  readonly environmentInstanceHash: Hash;
  readonly warmupMs: number;
  readonly observationMs: number;
  readonly committedAt: Instant;
  readonly signingKey: SigningKey;
}

function assertDuration(value: number, label: string, minimum: number, maximum: number): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the configured ${label} ${String(value)} is not an integer number of milliseconds`,
    );
  }
  if (value < minimum) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the configured ${label} is ${String(value)} ms, below the minimum of ${String(minimum)} ms`,
    );
  }
  if (value > maximum) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the configured ${label} is ${String(value)} ms, beyond the maximum of ${String(maximum)} ms`,
    );
  }
  if (value % MS_PER_SECOND !== 0) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the configured ${label} is ${String(value)} ms, which is not a whole number of seconds; ` +
        `retained instants are second-precision and the derived instant would not be representable`,
    );
  }
}

/** Integer addition that refuses rather than silently losing precision. */
export function addExactMs(left: number, right: number, label: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new Erl2Error(CODES.CUTOFF_BOUND_EXCEEDED, `${label} is not exact integer arithmetic`);
  }
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new Erl2Error(CODES.CUTOFF_BOUND_EXCEEDED, `${label} overflows exact integer arithmetic`);
  }
  return sum;
}

/**
 * Seals the run's evidence-window commitment.
 *
 * Every refusal here happens before any byte is written. The caller holds the
 * result until the milestone has been observed and checked against it.
 */
export function sealWindowCommitment(input: WindowCommitmentInput): EvidenceWindowCommitmentV1 {
  const { policy } = input;

  // The configured window on its own terms first, then against the policy that
  // bounds it. Both, because the policy's ceiling and the contract's are
  // different statements and a window can violate either.
  assertDuration(input.warmupMs, "warmup", 0, MAXIMUM_DURATION_MS);
  assertDuration(input.observationMs, "observation window", MS_PER_SECOND, MAXIMUM_DURATION_MS);

  if (input.warmupMs > policy.maximum_warmup_ms) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the configured warmup ${String(input.warmupMs)} ms exceeds the committed maximum ` +
        `${String(policy.maximum_warmup_ms)} ms`,
    );
  }
  if (input.observationMs < policy.minimum_observation_ms) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the configured observation window ${String(input.observationMs)} ms is below the committed ` +
        `minimum ${String(policy.minimum_observation_ms)} ms`,
    );
  }
  if (input.observationMs > policy.maximum_observation_ms) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the configured observation window ${String(input.observationMs)} ms exceeds the committed ` +
        `maximum ${String(policy.maximum_observation_ms)} ms`,
    );
  }

  // The clock domain the window is measured in must be the receipt's own; a
  // window committed against one clock and measured in another is not a window.
  if (input.processStartReceipt.monotonic_clock_domain_hash !== input.monotonicClockDomainHash) {
    throw new Erl2Error(
      CODES.CUTOFF_CLOCK_DOMAIN_MISMATCH,
      "the evidence window and the process-start receipt are in different monotonic clock domains",
    );
  }
  if (input.processStartReceipt.run_id !== input.runId) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      `the process-start receipt belongs to run ${input.processStartReceipt.run_id}, not ${input.runId}`,
    );
  }

  // The derived instants must be representable before anything is signed.
  const startedAtMs = Date.parse(input.processStartReceipt.process_started_at);
  if (Number.isNaN(startedAtMs)) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `process_started_at is not a parseable instant: ${input.processStartReceipt.process_started_at}`,
    );
  }
  addExactMs(addExactMs(startedAtMs, input.warmupMs, "warmup"), input.observationMs, "observation window");

  return assertContract<EvidenceWindowCommitmentV1>(
    "EvidenceWindowCommitmentV1",
    sealSigned(
      {
        schema_version: "evidence-window-commitment/v1" as const,
        commitment_id: `window-${input.runId.slice(0, 8)}`,
        run_id: input.runId,
        cutoff_policy_hash: coreHash(policy),
        process_start_receipt_hash: coreHash(input.processStartReceipt),
        monotonic_clock_domain_hash: input.monotonicClockDomainHash,
        comparison_policy_hash: input.comparisonPolicyHash,
        environment_instance_hash: input.environmentInstanceHash,
        warmup_ms: input.warmupMs,
        observation_ms: input.observationMs,
        instant_rule: "traffic_process_started_at_plus_warmup_ms_plus_observation_ms" as const,
        milestone_relationship: "runtime_milestone_at_process_start_plus_warmup_ms" as const,
        committed_at: input.committedAt,
      },
      input.signingKey,
    ),
  );
}

/**
 * The milestone is an **observation**, and the commitment is the expectation it
 * has to satisfy.
 *
 * Deriving the milestone instant from the committed warmup instead of observing
 * it would be tidier and wrong: the milestone is signed by the
 * `runtime_attestor`, and computing it from a value the `policy_author` chose
 * would make one party's arithmetic look like two parties' agreement. So the run
 * observes, compares, and refuses — before either artifact is written.
 */
export function assertMilestoneOnCommittedBoundary(
  commitment: EvidenceWindowCommitmentV1,
  receipt: TrafficProcessStartReceiptV1,
  milestone: RuntimeMilestoneV1,
): void {
  const startedAtMs = Date.parse(receipt.process_started_at);
  const occurredAtMs = Date.parse(milestone.occurred_at);
  if (Number.isNaN(startedAtMs) || Number.isNaN(occurredAtMs)) {
    throw new Erl2Error(CODES.CUTOFF_BOUND_EXCEEDED, "an unparseable instant reached the window check");
  }
  const observedWarmupMs = occurredAtMs - startedAtMs;
  if (observedWarmupMs !== commitment.warmup_ms) {
    throw new Erl2Error(
      CODES.CUTOFF_BOUND_EXCEEDED,
      `the runtime milestone occurred ${String(observedWarmupMs)} ms after the process started, but ` +
        `this run committed a ${String(commitment.warmup_ms)} ms warmup; the milestone marks the ` +
        `warmup boundary and a run that cannot land on its own committed window has not observed it`,
    );
  }
}

/** The cutoff instant this commitment fixes, in exact integer arithmetic. */
export function committedCutoffMs(
  commitment: EvidenceWindowCommitmentV1,
  receipt: TrafficProcessStartReceiptV1,
): number {
  const startedAtMs = Date.parse(receipt.process_started_at);
  if (Number.isNaN(startedAtMs)) {
    throw new Erl2Error(CODES.CUTOFF_BOUND_EXCEEDED, "process_started_at is not a parseable instant");
  }
  return addExactMs(
    addExactMs(startedAtMs, commitment.warmup_ms, "committed warmup"),
    commitment.observation_ms,
    "committed observation window",
  );
}
