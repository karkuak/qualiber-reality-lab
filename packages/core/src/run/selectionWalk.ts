/**
 * The durable, resumable selection walk (ADR-ERL2-020 §6).
 *
 * `runSelectionChain` runs the whole protocol in memory. That is right for the
 * known-answer suites and wrong for a run that must survive a crash: it observes
 * the beacon and releases custodian shares with no durable record between the
 * steps, so a process death anywhere inside leaves nothing to resume from.
 *
 * This module drives the same `stages.ts` functions **one durable transition at
 * a time**. Each step validates the state it departs from, produces exactly its
 * own artifacts, freezes them, and only then appends its lifecycle event. Resume
 * rebuilds the accumulated progress from *retained evidence* — the lifecycle's
 * recorded roles and the frozen artifacts they name — never from memory.
 *
 * The ordering is a table rather than control flow on purpose: the protocol's
 * sequence is the thing being asserted, so it should be readable as data, and a
 * step can be neither skipped nor reordered without editing the table.
 *
 * ## The one window that cannot be resumed
 *
 * Every step here is replay-safe except the beacon observation. `select` records
 * `independent_randomness_requested` *before* asking the beacon, so a crash
 * between the request and the frozen receipt is durably visible. That window
 * cannot be resumed: re-entering would draw a **second round**, and the
 * randomness policy's own `retry_policy` is `none_invalidate_run`. Resume in
 * that state therefore refuses, fail-closed, and the run must be invalidated.
 * This is the only honest answer — a second observation would silently give the
 * Lab two draws to choose between, which is the exact attack the single-source
 * binding exists to prevent.
 */

import { CODES, Erl2Error, type Hash } from "@erl2/contracts";
import type { LabState } from "../lifecycle/states.js";
import { coreHash } from "@erl2/integrity";
import {
  assertSelectionPreconditions,
  stageBinding,
  stageBindingCheckpoint,
  stageCommitment,
  stageCommitmentCheckpoint,
  stagePoolCheckpoint,
  stageProof,
  stageRandomness,
  stageReceipt,
  stageReveal,
  stageSourceTrust,
  type SelectionContext,
  type SelectionProgress,
} from "../selection/stages.js";

/** One produced artifact: where it is frozen and the role the lifecycle records. */
export interface StageArtifact {
  readonly path: string;
  readonly value: object;
  readonly role: string;
  readonly schema: string;
}

/** One durable transition of the walk. */
export interface SelectionStep {
  /** The state this step departs from. */
  readonly from: LabState;
  /** The state it lands in, and the lifecycle event type. */
  readonly to: LabState;
  /**
   * Whether re-entering this step after a crash is safe. Only the beacon
   * observation is not: see the module docstring.
   */
  readonly resumable: boolean;
  /** Produces this step's artifacts from the context and prior progress. */
  readonly run: (
    ctx: SelectionContext,
    progress: SelectionProgress,
  ) => { readonly next: Partial<SelectionProgress>; readonly artifacts: readonly StageArtifact[] };
}

const RETAINED = "retained/selection";

/**
 * The protocol order, as data.
 *
 * `independent_randomness_requested` is a step with no artifact: it exists only
 * so the intent to observe randomness is durable *before* the observation, which
 * is what makes the unresumable window detectable rather than silent.
 */
export const SELECTION_STEPS: readonly SelectionStep[] = [
  {
    from: "eligibility_pool_manifest_frozen",
    to: "eligibility_pool_checkpointed",
    resumable: true,
    run: (ctx) => {
      const poolCheckpoint = stagePoolCheckpoint(ctx);
      return {
        next: { poolCheckpoint },
        artifacts: [
          {
            path: `${RETAINED}/pool-checkpoint.json`,
            value: poolCheckpoint,
            role: "eligibility-pool-checkpoint",
            schema: "trusted-timestamp-checkpoint/v1",
          },
        ],
      };
    },
  },
  {
    // Intent, recorded before the beacon is touched. No artifact by design.
    from: "eligibility_pool_checkpointed",
    to: "independent_randomness_requested",
    resumable: true,
    run: () => ({ next: {}, artifacts: [] }),
  },
  {
    from: "independent_randomness_requested",
    to: "selection_randomness_receipt_frozen",
    // The single unresumable step: it draws the round.
    resumable: false,
    run: (ctx, progress) => {
      const { randomness, signatureProof, inclusionProof, randomnessReceipt } = stageRandomness(
        ctx,
        progress,
      );
      return {
        next: { randomness, signatureProof, inclusionProof, randomnessReceipt },
        artifacts: [
          {
            path: `${RETAINED}/randomness-receipt.json`,
            value: randomnessReceipt,
            role: "selection-randomness-receipt",
            schema: "external-beacon-randomness-receipt/v1",
          },
        ],
      };
    },
  },
  {
    from: "selection_randomness_receipt_frozen",
    to: "randomness_source_trust_verified",
    resumable: true,
    run: (ctx, progress) => {
      const sourceTrustReport = stageSourceTrust(ctx, progress);
      return {
        next: { sourceTrustReport },
        artifacts: [
          {
            path: `${RETAINED}/source-trust-report.json`,
            value: sourceTrustReport,
            role: "randomness-source-trust-report",
            schema: "randomness-source-trust-verification-report/v1",
          },
        ],
      };
    },
  },
  {
    from: "randomness_source_trust_verified",
    to: "selection_committed",
    resumable: true,
    run: (ctx, progress) => {
      const { derived, selectedEntry, commitment } = stageCommitment(ctx, progress);
      return {
        next: { derived, selectedEntry, commitment },
        artifacts: [
          {
            path: `${RETAINED}/commitment.json`,
            value: commitment,
            role: "selection-commitment",
            schema: "selection-commitment/v2",
          },
        ],
      };
    },
  },
  {
    from: "selection_committed",
    to: "selection_commitment_checkpointed",
    resumable: true,
    run: (ctx, progress) => {
      const commitmentCheckpoint = stageCommitmentCheckpoint(ctx, progress);
      return {
        next: { commitmentCheckpoint },
        artifacts: [
          {
            path: `${RETAINED}/commitment-checkpoint.json`,
            value: commitmentCheckpoint,
            role: "selection-commitment-checkpoint",
            schema: "trusted-timestamp-checkpoint/v1",
          },
        ],
      };
    },
  },
  {
    from: "selection_commitment_checkpointed",
    to: "threshold_reveal_receipt_frozen",
    resumable: true,
    run: (ctx, progress) => {
      const thresholdRevealReceipt = stageReveal(ctx, progress);
      return {
        next: { thresholdRevealReceipt },
        artifacts: [
          {
            path: `${RETAINED}/threshold-reveal-receipt.json`,
            value: thresholdRevealReceipt,
            role: "threshold-reveal-receipt",
            schema: "threshold-reveal-receipt/v1",
          },
        ],
      };
    },
  },
  {
    from: "threshold_reveal_receipt_frozen",
    to: "selected_challenge_journey_binding_frozen",
    resumable: true,
    run: (ctx, progress) => {
      const { opened, binding } = stageBinding(ctx, progress);
      return {
        next: { opened, binding },
        artifacts: [
          {
            path: `${RETAINED}/selected-binding.json`,
            value: binding,
            role: "selected-challenge-journey-binding",
            schema: "selected-challenge-journey-binding/v1",
          },
        ],
      };
    },
  },
  {
    from: "selected_challenge_journey_binding_frozen",
    to: "selected_binding_checkpointed",
    resumable: true,
    run: (ctx, progress) => {
      const bindingCheckpoint = stageBindingCheckpoint(ctx, progress);
      return {
        next: { bindingCheckpoint },
        artifacts: [
          {
            path: `${RETAINED}/binding-checkpoint.json`,
            value: bindingCheckpoint,
            role: "selected-binding-checkpoint",
            schema: "trusted-timestamp-checkpoint/v1",
          },
        ],
      };
    },
  },
  {
    from: "selected_binding_checkpointed",
    to: "selection_proof_frozen",
    resumable: true,
    run: (ctx, progress) => {
      const proof = stageProof(ctx, progress);
      return {
        next: { proof },
        artifacts: [
          {
            path: `${RETAINED}/selection-proof.json`,
            value: proof,
            role: "selection-proof",
            schema: "selection-proof/v2",
          },
        ],
      };
    },
  },
  {
    from: "selection_proof_frozen",
    to: "selection_receipt_verified",
    resumable: true,
    run: (ctx, progress) => {
      const receipt = stageReceipt(ctx, progress);
      return {
        next: {},
        artifacts: [
          {
            path: `${RETAINED}/selection-verification-receipt.json`,
            value: receipt,
            role: "selection-verification-receipt",
            schema: "selection-verification-receipt/v2",
          },
        ],
      };
    },
  },
];

/**
 * Refuses a resume that lands in the unresumable window.
 *
 * A run that durably recorded its intent to observe randomness but has no frozen
 * receipt cannot continue: the beacon may or may not have produced a round, and
 * asking again would be a second draw. The randomness policy says
 * `retry_policy: none_invalidate_run`, and this is where that is enforced.
 */
export function assertResumable(state: LabState): void {
  if (state === "independent_randomness_requested") {
    throw new Erl2Error(
      CODES.SELECTION_RANDOMNESS_RETRY_FORBIDDEN,
      "the run recorded a randomness request with no frozen receipt: the beacon may already " +
        "have been observed, and the randomness policy forbids a second draw " +
        "(retry_policy=none_invalidate_run). Invalidate the run; it cannot be resumed.",
    );
  }
}

/** The step that departs from `state`, or undefined when the walk is complete. */
export function stepFrom(state: LabState): SelectionStep | undefined {
  return SELECTION_STEPS.find((step) => step.from === state);
}

/** Recomputed identity of a produced artifact, used when recording its role. */
export function artifactHash(value: object): Hash {
  return coreHash(value as Record<string, unknown>);
}

export { assertSelectionPreconditions };
