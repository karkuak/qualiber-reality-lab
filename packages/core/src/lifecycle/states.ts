/**
 * Explicit transition table derived from the design's state machine
 * (design v2 §12).
 *
 * The table is data, not control flow, so an illegal transition is a refusal
 * rather than an unreachable branch.  Transitions listed as forbidden in §12
 * are simply absent: there is no direct edge from a step failure to cleanup, no
 * edge that reaches selection before a verified package manifest, and no edge
 * out of a terminal state except the one-way base-final → deep-descendant path.
 */

import { CODES, Erl2Error } from "@erl2/contracts";

export const LAB_STATES = [
  "created",
  "acquisition_preregistered",
  "step_planned",
  "step_started",
  "step_succeeded",
  "step_failed",
  "step_unsupported",
  "step_outcome_frozen",
  "subject_package_frozen",
  "package_manifest_frozen",
  "challenge_preregistered",
  "selection_role_separation_audit_frozen",
  "eligibility_pool_manifest_frozen",
  "eligibility_pool_checkpointed",
  "independent_randomness_requested",
  "selection_randomness_receipt_frozen",
  "randomness_source_trust_verified",
  "selection_committed",
  "selection_commitment_checkpointed",
  "threshold_reveal_receipt_frozen",
  "selected_challenge_journey_binding_frozen",
  "selected_binding_checkpointed",
  "selection_proof_frozen",
  "selection_receipt_verified",
  "case_selected",
  "environment_provisioned",
  "baseline_verified",
  "execution_plan_frozen",
  "challenge_activated",
  "traffic_or_journey_started",
  "evidence_cutoff_realized",
  "observation_frozen",
  "canonical_evidence_envelope_frozen",
  "adapter_translation_frozen",
  "pre_reveal_subject_cleanup_started",
  "subject_output_frozen",
  "truth_revealed",
  "judge_journey_expectation_revealed",
  "functional_journey_result_frozen",
  "nonfunctional_journey_result_frozen",
  "domain_result_frozen",
  "domain_not_applicable_frozen",
  "generic_precleanup_results_complete",
  "pre_environment_cleanup_started",
  "pre_environment_cleanup_verified",
  "pre_environment_validity_result_frozen",
  "lab_cleanup_started",
  "environment_restored",
  "teardown_started",
  "teardown_verified",
  "environment_validity_result_frozen",
  "emergency_cleanup_started",
  "emergency_cleanup_terminal",
  "generic_evaluation_index_frozen",
  "generic_finalized",
  "deep_result_frozen",
  "deep_supplement_finalized",
  "invalid_failure_detected",
  "invalid_pre_environment_cleanup_started",
  "invalid_environment_cleanup_started",
  "invalid_cleanup_terminal",
  "invalid_lab_run_record_frozen",
  "invalidated",
] as const;

export type LabState = (typeof LAB_STATES)[number];

const STATE_SET: ReadonlySet<string> = new Set(LAB_STATES);

/** Terminal states; nothing may transition out of them. */
export const TERMINAL_STATES: ReadonlySet<LabState> = new Set<LabState>([
  "generic_finalized",
  "deep_supplement_finalized",
  "invalidated",
]);

type Transitions = Readonly<Record<LabState, readonly LabState[]>>;

/**
 * Every transition the design permits.  `invalid_failure_detected` is reachable
 * from every non-terminal state because any accepted unrecoverable failure or
 * cancellation must freeze exactly one invalid record (ERL2-FR-001).
 */
const EXPLICIT: Partial<Record<LabState, readonly LabState[]>> = {
  created: ["acquisition_preregistered"],
  acquisition_preregistered: ["step_planned"],
  step_planned: ["step_started"],
  step_started: ["step_succeeded", "step_failed", "step_unsupported"],
  step_succeeded: ["step_outcome_frozen"],
  step_failed: ["step_outcome_frozen"],
  step_unsupported: ["step_outcome_frozen"],
  step_outcome_frozen: [
    "subject_package_frozen",
    "package_manifest_frozen",
    "step_planned",
    "challenge_activated",
    "pre_reveal_subject_cleanup_started",
    "subject_output_frozen",
  ],
  subject_package_frozen: ["step_planned"],
  // A successful package verification has exactly one authorized continuation
  // (design v2 §12, ADR-ERL2-013). The `verify_package` pre-environment
  // terminal exists for a *failed or unsupported* verification, which reaches
  // `subject_output_frozen` through the generic terminal step-outcome route
  // below; `PreEnvironmentLabRunRecordV1` has no package-manifest member, so a
  // successful manifest cannot be closed over by that branch at all.
  package_manifest_frozen: ["challenge_preregistered"],
  challenge_preregistered: ["selection_role_separation_audit_frozen"],
  selection_role_separation_audit_frozen: ["eligibility_pool_manifest_frozen"],
  eligibility_pool_manifest_frozen: ["eligibility_pool_checkpointed"],
  eligibility_pool_checkpointed: ["independent_randomness_requested"],
  independent_randomness_requested: ["selection_randomness_receipt_frozen"],
  selection_randomness_receipt_frozen: ["randomness_source_trust_verified"],
  randomness_source_trust_verified: ["selection_committed"],
  selection_committed: ["selection_commitment_checkpointed"],
  selection_commitment_checkpointed: ["threshold_reveal_receipt_frozen"],
  threshold_reveal_receipt_frozen: ["selected_challenge_journey_binding_frozen"],
  selected_challenge_journey_binding_frozen: ["selected_binding_checkpointed"],
  selected_binding_checkpointed: ["selection_proof_frozen"],
  selection_proof_frozen: ["selection_receipt_verified"],
  selection_receipt_verified: ["case_selected"],
  case_selected: ["environment_provisioned"],
  environment_provisioned: ["baseline_verified"],
  baseline_verified: ["execution_plan_frozen"],
  execution_plan_frozen: ["step_planned"],
  challenge_activated: ["traffic_or_journey_started"],
  traffic_or_journey_started: ["evidence_cutoff_realized"],
  evidence_cutoff_realized: ["observation_frozen"],
  observation_frozen: ["canonical_evidence_envelope_frozen"],
  canonical_evidence_envelope_frozen: ["adapter_translation_frozen"],
  adapter_translation_frozen: ["step_planned"],
  pre_reveal_subject_cleanup_started: ["step_planned", "subject_output_frozen"],
  subject_output_frozen: ["truth_revealed", "judge_journey_expectation_revealed"],
  truth_revealed: ["functional_journey_result_frozen", "domain_result_frozen"],
  judge_journey_expectation_revealed: ["nonfunctional_journey_result_frozen", "domain_not_applicable_frozen"],
  functional_journey_result_frozen: ["domain_result_frozen", "generic_precleanup_results_complete"],
  domain_result_frozen: ["functional_journey_result_frozen", "generic_precleanup_results_complete"],
  nonfunctional_journey_result_frozen: ["domain_not_applicable_frozen", "generic_precleanup_results_complete"],
  domain_not_applicable_frozen: ["nonfunctional_journey_result_frozen", "generic_precleanup_results_complete"],
  generic_precleanup_results_complete: ["pre_environment_cleanup_started", "lab_cleanup_started"],
  pre_environment_cleanup_started: ["pre_environment_cleanup_verified", "invalid_lab_run_record_frozen"],
  pre_environment_cleanup_verified: ["pre_environment_validity_result_frozen"],
  pre_environment_validity_result_frozen: ["generic_evaluation_index_frozen", "invalid_lab_run_record_frozen"],
  lab_cleanup_started: ["environment_restored", "emergency_cleanup_started"],
  environment_restored: ["teardown_started"],
  teardown_started: ["teardown_verified", "emergency_cleanup_started"],
  teardown_verified: ["environment_validity_result_frozen"],
  environment_validity_result_frozen: ["generic_evaluation_index_frozen", "invalid_lab_run_record_frozen"],
  emergency_cleanup_started: ["emergency_cleanup_terminal"],
  emergency_cleanup_terminal: ["invalid_lab_run_record_frozen"],
  generic_evaluation_index_frozen: ["generic_finalized", "invalid_lab_run_record_frozen"],
  generic_finalized: ["deep_result_frozen"],
  deep_result_frozen: ["deep_supplement_finalized"],
  invalid_failure_detected: ["invalid_pre_environment_cleanup_started", "invalid_environment_cleanup_started"],
  invalid_pre_environment_cleanup_started: ["invalid_cleanup_terminal"],
  invalid_environment_cleanup_started: ["invalid_cleanup_terminal", "emergency_cleanup_started"],
  invalid_cleanup_terminal: ["invalid_lab_run_record_frozen"],
  invalid_lab_run_record_frozen: ["invalidated"],
};

export const TRANSITIONS: Transitions = Object.freeze(
  Object.fromEntries(
    LAB_STATES.map((state) => {
      const explicit = EXPLICIT[state] ?? [];
      const canInvalidate =
        !TERMINAL_STATES.has(state) &&
        state !== "invalid_failure_detected" &&
        state !== "invalid_cleanup_terminal" &&
        state !== "invalid_lab_run_record_frozen";
      return [state, canInvalidate ? [...explicit, "invalid_failure_detected"] : explicit];
    }),
  ) as Record<LabState, readonly LabState[]>,
);

export function isLabState(value: string): value is LabState {
  return STATE_SET.has(value);
}

export function assertTransitionAllowed(from: LabState, to: LabState, eventType: string): void {
  if (!isLabState(from) || !isLabState(to)) {
    throw new Erl2Error(CODES.POLICY_CONFLICT, `unknown lifecycle state in ${from} -> ${to}`);
  }
  if (TERMINAL_STATES.has(from) && !(from === "generic_finalized" && to === "deep_result_frozen")) {
    throw new Erl2Error(
      CODES.STATE_POST_REVEAL_EXECUTION_FORBIDDEN,
      `no transition leaves terminal state ${from}`,
    );
  }
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Erl2Error(
      CODES.POLICY_CONFLICT,
      `transition ${from} -> ${to} (${eventType}) is not in the design state machine`,
    );
  }
}

/** States after which no subject or adapter process may execute. */
export const POST_REVEAL_STATES: ReadonlySet<LabState> = new Set<LabState>([
  "truth_revealed",
  "judge_journey_expectation_revealed",
  "functional_journey_result_frozen",
  "nonfunctional_journey_result_frozen",
  "domain_result_frozen",
  "domain_not_applicable_frozen",
  "generic_precleanup_results_complete",
]);

export function assertNoSubjectExecutionAfterReveal(state: LabState): void {
  if (POST_REVEAL_STATES.has(state)) {
    throw new Erl2Error(
      CODES.STATE_POST_REVEAL_EXECUTION_FORBIDDEN,
      `subject or adapter execution is forbidden in state ${state}`,
    );
  }
}

/**
 * Every state at or beyond truth reveal, finalization, cleanup, or invalidation.
 * No subject or adapter process may execute in any of them (design §12,
 * ERL2-FR-007 / AC-012).  This is the superset the *pre-dispatch* guard checks so
 * a stray execution never reaches the port on a revealed, finalized or
 * invalidating run — the check the engine only performed *after* the port had
 * already run (review P2-5).
 */
export const NO_SUBJECT_EXECUTION_STATES: ReadonlySet<LabState> = new Set<LabState>([
  ...POST_REVEAL_STATES,
  ...TERMINAL_STATES,
  "pre_environment_cleanup_started",
  "pre_environment_cleanup_verified",
  "pre_environment_validity_result_frozen",
  "generic_evaluation_index_frozen",
  "lab_cleanup_started",
  "environment_restored",
  "teardown_started",
  "teardown_verified",
  "environment_validity_result_frozen",
  "emergency_cleanup_started",
  "emergency_cleanup_terminal",
  "deep_result_frozen",
  "invalid_failure_detected",
  "invalid_pre_environment_cleanup_started",
  "invalid_environment_cleanup_started",
  "invalid_cleanup_terminal",
  "invalid_lab_run_record_frozen",
]);

/**
 * Fail-closed guard a command MUST call *before* dispatching any subject or
 * adapter port.  A refusal here causes zero external calls and zero new retained
 * evidence (review §8.2).
 */
export function assertSubjectPortExecutable(state: LabState): void {
  if (NO_SUBJECT_EXECUTION_STATES.has(state)) {
    throw new Erl2Error(
      CODES.STATE_POST_REVEAL_EXECUTION_FORBIDDEN,
      `subject or adapter execution is forbidden in state ${state}`,
    );
  }
}
