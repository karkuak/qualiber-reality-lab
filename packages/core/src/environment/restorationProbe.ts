/**
 * The independent post-compensation observation (ADR-ERL2-026, contract
 * ERL2-C-157).
 *
 * ## What this closes
 *
 * `restore()` compensated, re-measured the baseline fingerprint, inspected the
 * resource inventory and then derived `passed` from
 * `baseline_after_hash === baseline_before_hash && residual_resources.length ===
 * 0`. Not one of those three observations can see a mutation: the fingerprint
 * measures resource *health*, and the inventory measures resource *existence*.
 * A driver that answered `status: "succeeded"` and reverted nothing therefore
 * produced a restoration reading `passed: true` over a mutation that was still
 * applied, and the offline verifier agreed, because it re-derived from the same
 * three blind observations plus the receipt's own `status` (review P1-4).
 *
 * The receipt is not the answer. A compensation receipt is a statement by the
 * driver about the driver's own work, and ADR-ERL2-023 §2a already fixed the
 * direction of trust for exactly this shape: the Lab derives an action's success
 * by re-observing the substrate, never from what the receipt claimed.
 *
 * ## What replaces it
 *
 * Before the compensation is dispatched the run records, durably, what the
 * compensation is expected to revert — one entry per retained mutation receipt,
 * each naming the mutation, the receipt that recorded it being applied, and the
 * resource it was applied to. After the compensation the run asks the substrate
 * again what is applied, and the verdict is the difference between the two.
 *
 * Five outcomes, and the two that matter most are the two that used to be the
 * same silence:
 *
 * | outcome | meaning |
 * |---|---|
 * | `reverted` | every expected mutation is gone and nothing else was touched |
 * | `nothing_to_revert` | there was no mutation to revert, and the run says so |
 * | `residual` | an expected mutation is **still applied** — the no-op compensation |
 * | `collateral` | unrelated state was reverted instead of, or as well as, the target |
 * | `unobservable` | the driver cannot be asked; a restoration nobody observed |
 *
 * `unobservable` is a refusal, not a pass. A driver with no applied-mutation
 * observation is not broken — it simply cannot support a restoration claim, the
 * same fail-closed posture ADR-ERL2-024 §4.3 takes for a driver with no
 * operation log.
 */

import {
  assertContract,
  type Hash,
  type Instant,
  type RestorationProbeV1,
} from "@erl2/contracts";
import { sealSigned, type SigningKey } from "@erl2/integrity";

/** One mutation the compensation was declared to reverse. */
export interface ExpectedRevertedMutation {
  readonly mutationId: string;
  readonly mutationReceiptHash: Hash;
  readonly targetIdentityHash: Hash;
}

/** The two observations a probe compares, and what the driver could offer. */
export interface RestorationObservations {
  readonly expected: readonly ExpectedRevertedMutation[];
  /**
   * What the substrate reported applied immediately before the compensation.
   *
   * Legitimately empty on a resumed run whose compensation already completed and
   * was adopted from the driver's operation log, which is why it is evidence
   * rather than a precondition: requiring the expected set to appear here would
   * refuse a correctly reconciled restart.
   */
  readonly observedBefore: readonly string[];
  /** What the substrate reported applied after it, read back independently. */
  readonly observedAfter: readonly string[];
  readonly probeStatus: "observed" | "unavailable";
}

export interface RestorationProbeVerdict {
  readonly outcome: RestorationProbeV1["outcome"];
  readonly residualExpected: readonly string[];
  readonly collateralReverted: readonly string[];
}

/**
 * Derives the outcome from the observations alone.
 *
 * Shared with the offline verifier on the terms ADR-ERL2-024 §7.2 already set
 * for `safeActions` and `assertFrontierActionsDerivable`: this is set
 * arithmetic over two retained arrays — a *definition*, reproducible by any
 * reader holding the bytes. What is verifier-owned, and deliberately not shared,
 * is every judgement *about* those arrays: that they correspond to the retained
 * mutation receipts, that they belong to this run and this substrate binding,
 * and that the retained `outcome` is the one this function returns.
 */
export function deriveRestorationProbeOutcome(
  observations: RestorationObservations,
): RestorationProbeVerdict {
  const expectedIds = observations.expected.map((entry) => entry.mutationId);
  const after = new Set(observations.observedAfter);
  const expected = new Set(expectedIds);

  const residualExpected = [...new Set(expectedIds.filter((id) => after.has(id)))].sort();
  const collateralReverted = [
    ...new Set(
      observations.observedBefore.filter((id) => !expected.has(id) && !after.has(id)),
    ),
  ].sort();

  if (observations.probeStatus === "unavailable") {
    return { outcome: "unobservable", residualExpected, collateralReverted };
  }
  // Ordered most-specific-failure first: a compensation that left its target
  // applied *and* removed something else is reported as the failure it was
  // asked about.
  if (residualExpected.length > 0) {
    return { outcome: "residual", residualExpected, collateralReverted };
  }
  if (collateralReverted.length > 0) {
    return { outcome: "collateral", residualExpected, collateralReverted };
  }
  if (expectedIds.length === 0 && observations.observedBefore.length === 0) {
    // Not the same statement as `reverted`, and that is the whole point: a run
    // that reverted nothing because there was nothing to revert must not be
    // readable as one that reverted something.
    return { outcome: "nothing_to_revert", residualExpected, collateralReverted };
  }
  return { outcome: "reverted", residualExpected, collateralReverted };
}

/** The two outcomes a valid environment terminal may be signed over. */
export function restorationProbePassed(outcome: RestorationProbeV1["outcome"]): boolean {
  return outcome === "reverted" || outcome === "nothing_to_revert";
}

export interface BuildRestorationProbeInput extends RestorationObservations {
  readonly runId: string;
  readonly substrateBindingHash: Hash;
  readonly environmentInstanceHash: Hash;
  readonly compensationOperationId: string;
  readonly compensationReceiptHash: Hash;
  readonly probedAt: Instant;
  readonly signingKey: SigningKey;
}

/**
 * Builds and seals the probe.
 *
 * Signed by the **environment governor**, for the same reason the substrate
 * binding is: the driver is untrusted infrastructure, and a statement that a
 * driver's compensation worked must not be signed by that driver.
 */
export function buildRestorationProbe(input: BuildRestorationProbeInput): RestorationProbeV1 {
  const verdict = deriveRestorationProbeOutcome(input);
  const body = {
    schema_version: "restoration-probe/v1" as const,
    probe_id: `restoration-probe-${input.runId.slice(0, 8)}`,
    run_id: input.runId,
    substrate_binding_hash: input.substrateBindingHash,
    environment_instance_hash: input.environmentInstanceHash,
    compensation_operation_id: input.compensationOperationId,
    compensation_receipt_hash: input.compensationReceiptHash,
    expected_reverted_mutations: input.expected.map((entry) => ({
      mutation_id: entry.mutationId,
      mutation_receipt_hash: entry.mutationReceiptHash,
      target_identity_hash: entry.targetIdentityHash,
    })),
    // Sorted so two runs over the same substrate freeze the same bytes; the
    // driver's iteration order is not evidence.
    observed_before: [...new Set(input.observedBefore)].sort(),
    observed_after: [...new Set(input.observedAfter)].sort(),
    residual_expected_mutations: [...verdict.residualExpected],
    collateral_reverted_mutations: [...verdict.collateralReverted],
    probe_status: input.probeStatus,
    outcome: verdict.outcome,
    probed_at: input.probedAt,
  };
  return assertContract<RestorationProbeV1>(
    "RestorationProbeV1",
    sealSigned(body, input.signingKey),
  );
}
