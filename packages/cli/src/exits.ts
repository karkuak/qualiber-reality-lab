/**
 * Lab CLI exit codes (design v2 Appendix B).
 *
 * Every exit carries `authority_scope: "lab_orchestration_only"`.  The Lab
 * never emits a subject or customer release exit code.
 */

export const EXIT = {
  COMPLETED: 0,
  USAGE_OR_CONFIG: 2,
  PREREQUISITE_OR_ADMISSION: 3,
  ENVIRONMENT: 4,
  EVIDENCE_OR_DEPENDENCY: 5,
  ADAPTER_OR_SUBJECT_EXECUTION: 6,
  REVEAL: 7,
  EVALUATOR_OR_FINALIZER: 8,
  RESTORATION_OR_TEARDOWN: 9,
  TRUST_OR_TAMPER: 10,
  FORBIDDEN_STATE: 11,
  CANCELLATION: 12,
} as const;

export const AUTHORITY_SCOPE = "lab_orchestration_only" as const;

/** Maps an error-code prefix to the exit the design assigns to its owner. */
export function exitForCode(code: string): number {
  // A completed cancellation is exit 12; refusing to cancel is a usage or
  // forbidden-state refusal, not the cancellation terminal itself.
  if (code === "CANCELLATION_REQUESTED") return EXIT.CANCELLATION;
  if (code === "CANCELLATION_BEFORE_ACCEPTANCE") return EXIT.USAGE_OR_CONFIG;
  if (code === "CANCELLATION_AFTER_TERMINAL") return EXIT.FORBIDDEN_STATE;
  if (code.startsWith("CFG_") || code.startsWith("SCHEMA_") || code.startsWith("POLICY_")) {
    return EXIT.USAGE_OR_CONFIG;
  }
  if (code.startsWith("ADMISSION_") || code.startsWith("REQUEST_ANCESTRY_")) {
    return EXIT.PREREQUISITE_OR_ADMISSION;
  }
  if (
    code.startsWith("SELECTION_") ||
    code.startsWith("RANDOMNESS_") ||
    code.startsWith("BEACON_WRAPPER_") ||
    code.startsWith("THRESHOLD_VRF_") ||
    code.startsWith("NON_COLLUSION_") ||
    code.startsWith("POOL_METADATA_") ||
    code.startsWith("BLIND_")
  ) {
    return EXIT.PREREQUISITE_OR_ADMISSION;
  }
  if (code.startsWith("ENV_") || code.startsWith("BASELINE_")) return EXIT.ENVIRONMENT;
  if (code.startsWith("SOURCE_") || code.startsWith("DEPENDENCY_") || code.startsWith("CUTOFF_")) {
    return EXIT.EVIDENCE_OR_DEPENDENCY;
  }
  if (code.startsWith("ADAPTER_") || code.startsWith("SUBJECT_")) {
    return EXIT.ADAPTER_OR_SUBJECT_EXECUTION;
  }
  if (code.startsWith("REVEAL_") || code.startsWith("TRUTH_")) return EXIT.REVEAL;
  if (code.startsWith("EVALUATOR_") || code.startsWith("PACK_")) return EXIT.EVALUATOR_OR_FINALIZER;
  if (
    code.startsWith("RESTORATION_") ||
    code.startsWith("TEARDOWN_") ||
    code.startsWith("EMERGENCY_") ||
    code.startsWith("RESIDUE_")
  ) {
    return EXIT.RESTORATION_OR_TEARDOWN;
  }
  if (
    code.startsWith("TRUST_") ||
    code.startsWith("TIMESTAMP_") ||
    code.startsWith("ARTIFACT_") ||
    code.startsWith("PATH_") ||
    code.startsWith("BUNDLE_") ||
    code.startsWith("INVENTORY_") ||
    code.startsWith("VERIFY_") ||
    code.startsWith("GRAPH_CLOSURE_") ||
    code.startsWith("VERSION_CLOSURE_")
  ) {
    return EXIT.TRUST_OR_TAMPER;
  }
  if (code.startsWith("STATE_POST_REVEAL_") || code.startsWith("INVALID_")) return EXIT.FORBIDDEN_STATE;
  // An unexpected Lab failure has no dedicated Appendix B exit; it takes the
  // documented fallback so the *code* — not the exit — carries the true cause.
  if (code.startsWith("LAB_")) return EXIT.USAGE_OR_CONFIG;
  return EXIT.USAGE_OR_CONFIG;
}
