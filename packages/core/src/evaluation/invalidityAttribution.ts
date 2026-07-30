/**
 * Which Lab validity gate an environment failure phase falsifies, and who owns
 * the finding that says so (ADR-ERL2-027 §4.5).
 *
 * ## What this closes
 *
 * `EnvironmentRun.invalidate` froze its primary invalidity finding with:
 *
 * ```ts
 * failedGateIds: [input.emergency ? "restoration-verified" : "environment-baseline-clean"],
 * ```
 *
 * — keyed on the *cleanup branch*, not on what failed. A provisioning failure
 * therefore emitted a Lab invalidity finding naming `environment-baseline-clean`:
 * a gate belonging to a later phase, which the run never evaluated, and which has
 * no causal relationship to the failure. A teardown failure named
 * `restoration-verified`, which by construction had already passed.
 *
 * Every structural check passed on those findings. They are retained,
 * hash-linked, role-produced and cited by the record; the finding simply names
 * the wrong thing, which is the one defect a hash cannot catch. This is the P2
 * item "the invalid terminal's primary finding naming a gate from the cleanup
 * branch", reached through review P1-3's requirement that a failed gate and its
 * finding correspond.
 *
 * ## The map
 *
 * Total over the phase union and deterministic, so the producer writes it and
 * the offline verifier re-derives it from the record's own `failed_phase`
 * without either consulting the other. It is a *definition* — a constant lookup
 * reproducible by any reader holding the bytes — and is shared on the terms
 * ADR-ERL2-024 §7.2 set for `safeActions`.
 */

import { CODES, Erl2Error } from "@erl2/contracts";

/**
 * The environment failure phases that reach a terminal through
 * `EnvironmentRun.invalidate`.
 *
 * Narrower than the contract's `InvalidNonJourneyPhase` on purpose: the phases
 * this omits are pre-environment ones, which reach a different terminal with a
 * different finding, and `emergency_cleanup`, which is never a *cause* — a
 * cleanup that fails is recorded as a cleanup result and never replaces the
 * failure it was cleaning up after (ADR-ERL2-027 §4.5.3).
 */
export type EnvironmentFailurePhase =
  | "provisioning"
  | "baseline"
  | "planning"
  | "activation"
  | "observation"
  | "environment_restoration"
  | "teardown";

/**
 * Phase → the gate that phase's evidence supports, and which its failure
 * therefore falsifies.
 *
 * Each entry is the gate whose *evidence* the failed phase was supposed to
 * produce, so the finding names something the run can be read against:
 *
 *  - `provisioning` — no environment, so the artifact graph the terminal owes
 *    cannot close;
 *  - `baseline` — the baseline is the thing that failed;
 *  - `planning` — planning is where the selection chain closes into a plan;
 *  - `activation` — activation mutates the environment, so a failed one leaves
 *    it in an unproven state;
 *  - `observation` — observation is what realizes the evidence cutoff;
 *  - `environment_restoration` / `teardown` — their own gates, and notably *not*
 *    each other's: a teardown failure naming `restoration-verified` names a gate
 *    that passed.
 */
export const ENVIRONMENT_PHASE_GATE: Readonly<Record<EnvironmentFailurePhase, string>> = {
  provisioning: "mandatory-graph-closed",
  baseline: "environment-baseline-clean",
  planning: "selection-chain-closed",
  activation: "environment-not-contaminated",
  observation: "evidence-cutoff-realized",
  environment_restoration: "restoration-verified",
  teardown: "teardown-verified",
};

/**
 * The gate a failed *journey step* falsifies, whatever its intent.
 *
 * A step that was owed and never produced an outcome — the shape an ambiguous
 * subject dispatch leaves behind (ADR-ERL2-024 §4.3) — makes the step closure
 * unclosable: `deriveStepClosure` requires exactly one outcome per committed
 * occurrence, so the mandatory artifact graph cannot close. That is the gate the
 * failure actually falsifies, and it is deliberately *not* an intent-specific
 * gate: the run does not know what the subject did, so it may not name a gate
 * that would imply it does.
 *
 * It is one constant rather than a map over `EnvironmentJourneyIntent` because
 * the falsified gate does not vary with the intent — only the recorded
 * `failed_intent` does, and that lives in the record's own `failed_phase`.
 */
export const JOURNEY_EXECUTION_GATE = "mandatory-graph-closed";

/**
 * The gate a failed environment phase falsifies.
 *
 * Refuses an unmapped phase rather than defaulting: a default would silently
 * reintroduce the defect this module exists to close, one phase at a time, as
 * the phase union grows.
 */
export function gateForEnvironmentFailurePhase(phase: string): string {
  const gate = ENVIRONMENT_PHASE_GATE[phase as EnvironmentFailurePhase];
  if (gate === undefined) {
    throw new Erl2Error(
      CODES.INVALID_REASON_PHASE_MISMATCH,
      `no Lab validity gate is mapped to environment failure phase ${phase}; an invalid terminal ` +
        `may not name a gate that its own failure does not falsify`,
    );
  }
  return gate;
}

/** Whether a phase reaches its terminal through the environment invalid route. */
export function isEnvironmentFailurePhase(phase: string): phase is EnvironmentFailurePhase {
  return Object.hasOwn(ENVIRONMENT_PHASE_GATE, phase);
}

/**
 * The gate a record's own `failed_phase` falsifies, for either failing kind.
 *
 * One function over both kinds so the producer and the offline verifier cannot
 * diverge on the journey-execution route the way they could have if each had
 * grown its own branch. `cancellation` returns `undefined`: a cancellation is
 * not a *failure* of a gate, it is an operator's decision, and naming a
 * falsified gate for it would be exactly the fabrication ADR-ERL2-027 §4.5
 * removed from the other phases.
 */
export function gateForInvalidFailurePhase(
  failedPhase:
    | { readonly kind: "lifecycle_phase"; readonly phase: string }
    | { readonly kind: "journey_execution" }
    | { readonly kind: "cancellation" },
): string | undefined {
  if (failedPhase.kind === "cancellation") return undefined;
  if (failedPhase.kind === "journey_execution") return JOURNEY_EXECUTION_GATE;
  if (!isEnvironmentFailurePhase(failedPhase.phase)) return undefined;
  return gateForEnvironmentFailurePhase(failedPhase.phase);
}
