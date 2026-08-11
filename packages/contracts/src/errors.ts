/**
 * Stable refusal codes (design v2 Appendix B).
 *
 * Every adversarial fixture in `fixtures/invalid` and `fixtures/tampered` names
 * exactly one of these.  Codes are append-only: removing or renaming one is a
 * breaking change to the CLI and verifier contract.
 */
export const ERL2_ERROR_PREFIXES = [
  "CFG_",
  "SCHEMA_",
  "POLICY_",
  "ADMISSION_",
  "SELECTION_",
  "ENV_",
  "BASELINE_",
  "CUTOFF_",
  "ADAPTER_",
  "SUBJECT_ACQUIRE_",
  "SUBJECT_PACKAGE_",
  "SUBJECT_INSTALL_",
  "SUBJECT_CONFIG_",
  "SUBJECT_AUTH_",
  "SUBJECT_RUNTIME_",
  "SUBJECT_OUTPUT_",
  "REQUEST_ANCESTRY_",
  "JOURNEY_ORACLE_",
  "ADMISSION_SUBJECT_",
  "BLIND_JOURNEY_",
  "BLIND_ACTOR_",
  "POOL_METADATA_",
  "SELECTION_CHAIN_",
  "SELECTION_RANDOMNESS_",
  "RANDOMNESS_SOURCE_",
  "RANDOMNESS_VARIANT_",
  "RANDOMNESS_TRUST_",
  "BEACON_WRAPPER_",
  "THRESHOLD_VRF_",
  "SELECTION_TIME_",
  "NON_COLLUSION_",
  "TRANSLATION_",
  "COMPARISON_MODE_",
  "DEEP_ANCESTRY_",
  "VERSION_CLOSURE_",
  "GRAPH_CLOSURE_",
  "SOURCE_",
  "DEPENDENCY_",
  "ARTIFACT_",
  "PATH_",
  "SECRET_",
  "TRUTH_",
  "REVEAL_",
  "STATE_POST_REVEAL_",
  "PACK_",
  "EVALUATOR_",
  "RESTORATION_",
  "TEARDOWN_",
  "EMERGENCY_CLEANUP_",
  "EMERGENCY_ACTION_",
  "RESIDUE_",
  "INVALID_TERMINAL_",
  "INVALID_REASON_",
  "TRUST_",
  "TIMESTAMP_",
  "INVENTORY_",
  "BUNDLE_",
  "CUSTOMER_BUNDLE_",
  "VERIFY_",
  "VERIFY_RECORD_",
  "CANCELLATION_",
  "LAB_",
] as const;

export type Erl2ErrorPrefix = (typeof ERL2_ERROR_PREFIXES)[number];

/** Failure-domain owner, kept mechanically distinct (ERL2-OPS-003). */
export type FailureOwner =
  | "lab"
  | "external_dependency"
  | "adapter"
  | "subject"
  | "evaluator"
  | "inconclusive";

export interface Erl2ErrorOptions {
  readonly owner?: FailureOwner;
  readonly detail?: string;
  readonly cause?: unknown;
}

/**
 * A typed, bounded refusal.  `message` is always safe to log: callers must not
 * put secrets, truth plaintext or judge canaries into it.
 */
export class Erl2Error extends Error {
  readonly code: string;
  readonly owner: FailureOwner;
  readonly detail: string | undefined;

  constructor(code: string, message: string, options: Erl2ErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "Erl2Error";
    this.code = code;
    this.owner = options.owner ?? "lab";
    this.detail = options.detail;
    assertKnownPrefix(code);
  }
}

export function assertKnownPrefix(code: string): void {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) {
    throw new Error(`malformed error code: ${code}`);
  }
  const known = ERL2_ERROR_PREFIXES.some((p) => code.startsWith(p));
  if (!known) {
    throw new Error(`error code ${code} does not use a catalogued Appendix B prefix`);
  }
}

/** Selection codes referenced directly by the design's fail-closed requirements. */
export const CODES = {
  SCHEMA_VALIDATION_FAILED: "SCHEMA_VALIDATION_FAILED",
  SCHEMA_UNKNOWN_CONTRACT: "SCHEMA_UNKNOWN_CONTRACT",
  SCHEMA_UNKNOWN_FIELD: "SCHEMA_UNKNOWN_FIELD",
  THRESHOLD_VRF_NOT_ACTIVATED: "THRESHOLD_VRF_NOT_ACTIVATED",
  REQUEST_ANCESTRY_INVALID: "REQUEST_ANCESTRY_INVALID",
  SELECTION_CHAIN_EDGE_UNCLOSED: "SELECTION_CHAIN_EDGE_UNCLOSED",
  SELECTION_CHAIN_POOL_ROOT_MISMATCH: "SELECTION_CHAIN_POOL_ROOT_MISMATCH",
  SELECTION_CHAIN_ENTRY_NOT_IN_POOL: "SELECTION_CHAIN_ENTRY_NOT_IN_POOL",
  SELECTION_CHAIN_HIDING_COMMITMENT_MISMATCH: "SELECTION_CHAIN_HIDING_COMMITMENT_MISMATCH",
  /**
   * Two selection roles are held by the same signing key.
   *
   * `selection-role-separation-audit/v1` pins `all_required_roles_disjoint: true`
   * and `status: "passed"` as schema constants, so a *failing* audit cannot be
   * represented at all. Refusing is therefore the only honest outcome: emitting
   * the artifact would assert a separation the run does not have
   * (CONFLICT-ERL2-002 C-2, ADR-ERL2-020 §4).
   */
  SELECTION_CHAIN_ROLE_SEPARATION_VIOLATED: "SELECTION_CHAIN_ROLE_SEPARATION_VIOLATED",
  SELECTION_TIME_CYCLIC_CHECKPOINT: "SELECTION_TIME_CYCLIC_CHECKPOINT",
  SELECTION_TIME_WRONG_TARGET: "SELECTION_TIME_WRONG_TARGET",
  SELECTION_TIME_OUT_OF_ORDER: "SELECTION_TIME_OUT_OF_ORDER",
  SELECTION_RANDOMNESS_BEFORE_POOL_CHECKPOINT: "SELECTION_RANDOMNESS_BEFORE_POOL_CHECKPOINT",
  SELECTION_RANDOMNESS_INDEX_MISMATCH: "SELECTION_RANDOMNESS_INDEX_MISMATCH",
  /**
   * A run durably recorded its intent to observe randomness but retains no
   * frozen receipt, so the beacon may or may not already have produced a round.
   * Resuming would risk a *second* draw, which would hand the Lab two outcomes
   * to choose between — the exact attack the single-source binding prevents. The
   * randomness policy's own `retry_policy` is `none_invalidate_run`, and this is
   * where that is enforced: the run is refused, not retried (ADR-ERL2-020 §6).
   */
  SELECTION_RANDOMNESS_RETRY_FORBIDDEN: "SELECTION_RANDOMNESS_RETRY_FORBIDDEN",
  RANDOMNESS_SOURCE_MISMATCH: "RANDOMNESS_SOURCE_MISMATCH",
  RANDOMNESS_SOURCE_NOT_PINNED: "RANDOMNESS_SOURCE_NOT_PINNED",
  RANDOMNESS_SOURCE_REVOKED: "RANDOMNESS_SOURCE_REVOKED",
  RANDOMNESS_VARIANT_NOT_ADMISSIBLE: "RANDOMNESS_VARIANT_NOT_ADMISSIBLE",
  RANDOMNESS_TRUST_REGISTRY_STALE: "RANDOMNESS_TRUST_REGISTRY_STALE",
  BEACON_WRAPPER_SIGNATURE_INVALID: "BEACON_WRAPPER_SIGNATURE_INVALID",
  BEACON_WRAPPER_SCOPE_CONFUSED: "BEACON_WRAPPER_SCOPE_CONFUSED",
  BEACON_WRAPPER_NATIVE_PROOF_INVALID: "BEACON_WRAPPER_NATIVE_PROOF_INVALID",
  BEACON_WRAPPER_BINDING_MISMATCH: "BEACON_WRAPPER_BINDING_MISMATCH",
  NON_COLLUSION_ROLE_OVERLAP: "NON_COLLUSION_ROLE_OVERLAP",
  NON_COLLUSION_KEY_OVERLAP: "NON_COLLUSION_KEY_OVERLAP",
  NON_COLLUSION_THRESHOLD_INSUFFICIENT: "NON_COLLUSION_THRESHOLD_INSUFFICIENT",
  NON_COLLUSION_ACCESS_LOG_UNCLOSED: "NON_COLLUSION_ACCESS_LOG_UNCLOSED",
  POOL_METADATA_NOT_UNIFORM: "POOL_METADATA_NOT_UNIFORM",
  POOL_METADATA_PADDING_INVALID: "POOL_METADATA_PADDING_INVALID",
  BLIND_JOURNEY_EXACT_COMMITMENT_PRESENT: "BLIND_JOURNEY_EXACT_COMMITMENT_PRESENT",
  BLIND_ACTOR_EXACT_SCRIPT_PRESENT: "BLIND_ACTOR_EXACT_SCRIPT_PRESENT",
  COMPARISON_MODE_REPLAY_IN_BLIND_TIER: "COMPARISON_MODE_REPLAY_IN_BLIND_TIER",
  GRAPH_CLOSURE_MISSING_ROLE: "GRAPH_CLOSURE_MISSING_ROLE",
  GRAPH_CLOSURE_EXTRA_ARTIFACT: "GRAPH_CLOSURE_EXTRA_ARTIFACT",
  GRAPH_CLOSURE_UNREACHABLE_ARTIFACT: "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT",
  GRAPH_CLOSURE_TERMINAL_MISMATCH: "GRAPH_CLOSURE_TERMINAL_MISMATCH",
  VERSION_CLOSURE_MEMBER_CROSSOVER: "VERSION_CLOSURE_MEMBER_CROSSOVER",
  ARTIFACT_ALREADY_FROZEN: "ARTIFACT_ALREADY_FROZEN",
  ARTIFACT_HASH_MISMATCH: "ARTIFACT_HASH_MISMATCH",
  ARTIFACT_NOT_FOUND: "ARTIFACT_NOT_FOUND",
  PATH_ESCAPES_ROOT: "PATH_ESCAPES_ROOT",
  PATH_NOT_REGULAR_FILE: "PATH_NOT_REGULAR_FILE",
  PATH_SYMLINK_REJECTED: "PATH_SYMLINK_REJECTED",
  PATH_CASE_COLLISION: "PATH_CASE_COLLISION",
  PATH_INVALID_COMPONENT: "PATH_INVALID_COMPONENT",
  TRUST_KEY_UNKNOWN: "TRUST_KEY_UNKNOWN",
  TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE: "TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE",
  TRUST_KEY_REVOKED: "TRUST_KEY_REVOKED",
  TRUST_SIGNATURE_INVALID: "TRUST_SIGNATURE_INVALID",
  TRUST_HEAD_NOT_LOCALLY_PINNED: "TRUST_HEAD_NOT_LOCALLY_PINNED",
  TRUST_HEAD_SELF_ANCHORED: "TRUST_HEAD_SELF_ANCHORED",
  TIMESTAMP_TARGET_MISSING: "TIMESTAMP_TARGET_MISSING",
  TIMESTAMP_SELF_REFERENCE: "TIMESTAMP_SELF_REFERENCE",
  TIMESTAMP_CHAIN_BROKEN: "TIMESTAMP_CHAIN_BROKEN",
  INVENTORY_ENTRY_MISSING: "INVENTORY_ENTRY_MISSING",
  INVENTORY_ENTRY_EXTRA: "INVENTORY_ENTRY_EXTRA",
  /** A signer-inventory entry disagrees with the retained artifact it names. */
  INVENTORY_ENTRY_MISMATCH: "INVENTORY_ENTRY_MISMATCH",
  BUNDLE_MEMBER_MISSING: "BUNDLE_MEMBER_MISSING",
  BUNDLE_MEMBER_EXTRA: "BUNDLE_MEMBER_EXTRA",
  /**
   * A bundle presents a member the attestation it carries does not attest —
   * for instance an environment bundle whose `selection_verification_receipt`
   * is not the receipt named by `EnvironmentFinalLabAttestationV1`.
   */
  BUNDLE_MEMBER_MISMATCH: "BUNDLE_MEMBER_MISMATCH",
  BUNDLE_VARIANT_MISMATCH: "BUNDLE_VARIANT_MISMATCH",
  VERIFY_OFFLINE_REQUIRED: "VERIFY_OFFLINE_REQUIRED",
  VERIFY_RECORD_EXPECTED_INVALID_RECORD: "VERIFY_RECORD_EXPECTED_INVALID_RECORD",
  VERIFY_RECORD_ATTESTATION_PRESENT: "VERIFY_RECORD_ATTESTATION_PRESENT",
  VERIFY_RECORD_LIFECYCLE_GAP: "VERIFY_RECORD_LIFECYCLE_GAP",
  INVALID_TERMINAL_ATTESTATION_FORBIDDEN: "INVALID_TERMINAL_ATTESTATION_FORBIDDEN",
  INVALID_TERMINAL_MULTIPLE_RECORDS: "INVALID_TERMINAL_MULTIPLE_RECORDS",
  INVALID_REASON_PHASE_MISMATCH: "INVALID_REASON_PHASE_MISMATCH",
  INVALID_REASON_FABRICATED_FINDING: "INVALID_REASON_FABRICATED_FINDING",
  EMERGENCY_CLEANUP_BYPASSED: "EMERGENCY_CLEANUP_BYPASSED",
  /**
   * Emergency cleanup did not account for the frontier it was derived from: an
   * omitted action, a cleanup citing a frontier the run never froze, or a
   * terminal that claims cleanup was not required while the run held external
   * resources (ADR-ERL2-024 §4.5/§4.6).
   */
  EMERGENCY_CLEANUP_INCOMPLETE: "EMERGENCY_CLEANUP_INCOMPLETE",
  EMERGENCY_ACTION_RECEIPT_MISSING: "EMERGENCY_ACTION_RECEIPT_MISSING",
  EMERGENCY_ACTION_SAFE_ACTION_SKIPPED: "EMERGENCY_ACTION_SAFE_ACTION_SKIPPED",
  STATE_POST_REVEAL_EXECUTION_FORBIDDEN: "STATE_POST_REVEAL_EXECUTION_FORBIDDEN",
  CUTOFF_BOUND_EXCEEDED: "CUTOFF_BOUND_EXCEEDED",
  CUTOFF_MILESTONE_MISMATCH: "CUTOFF_MILESTONE_MISMATCH",
  CUTOFF_CLOCK_DOMAIN_MISMATCH: "CUTOFF_CLOCK_DOMAIN_MISMATCH",
  CUTOFF_CLOCK_DIVERGENCE: "CUTOFF_CLOCK_DIVERGENCE",
  CUTOFF_FUTURE_EVIDENCE_REJECTED: "CUTOFF_FUTURE_EVIDENCE_REJECTED",
  COMPARISON_MODE_TIER_MISMATCH: "COMPARISON_MODE_TIER_MISMATCH",
  COMPARISON_MODE_ENVELOPE_MISMATCH: "COMPARISON_MODE_ENVELOPE_MISMATCH",
  COMPARISON_MODE_LIVE_BYTE_EQUALITY_CLAIMED: "COMPARISON_MODE_LIVE_BYTE_EQUALITY_CLAIMED",
  TRANSLATION_ENTRY_OMITTED: "TRANSLATION_ENTRY_OMITTED",
  TRANSLATION_ENTRY_DUPLICATED: "TRANSLATION_ENTRY_DUPLICATED",
  TRANSLATION_ENVELOPE_REWRITTEN: "TRANSLATION_ENVELOPE_REWRITTEN",
  TRANSLATION_UNKNOWN_ENTRY: "TRANSLATION_UNKNOWN_ENTRY",
  ADMISSION_ARTIFACT_UNKNOWN: "ADMISSION_ARTIFACT_UNKNOWN",
  ADMISSION_CANDIDATE_DERIVED_ELIGIBILITY: "ADMISSION_CANDIDATE_DERIVED_ELIGIBILITY",
  ADMISSION_EXPOSED_CHALLENGE: "ADMISSION_EXPOSED_CHALLENGE",
  ADMISSION_SUBJECT_PORT_NOT_DEVELOPMENT: "ADMISSION_SUBJECT_PORT_NOT_DEVELOPMENT",
  SUBJECT_ACQUIRE_SOURCE_UNREACHABLE: "SUBJECT_ACQUIRE_SOURCE_UNREACHABLE",
  SUBJECT_PACKAGE_VERIFICATION_FAILED: "SUBJECT_PACKAGE_VERIFICATION_FAILED",
  SUBJECT_PACKAGE_KIND_UNSUPPORTED: "SUBJECT_PACKAGE_KIND_UNSUPPORTED",
  SUBJECT_OUTPUT_FROZEN_ALREADY: "SUBJECT_OUTPUT_FROZEN_ALREADY",
  SUBJECT_OUTPUT_LIMIT_EXCEEDED: "SUBJECT_OUTPUT_LIMIT_EXCEEDED",
  SUBJECT_OUTPUT_PATH_ESCAPE: "SUBJECT_OUTPUT_PATH_ESCAPE",
  SUBJECT_OUTPUT_CONTRACT_INVALID: "SUBJECT_OUTPUT_CONTRACT_INVALID",
  SUBJECT_INSTALL_FAILED: "SUBJECT_INSTALL_FAILED",

  // -- slice 5: adapter host, sandbox, capability and certification ---------
  ADAPTER_PROTOCOL_VERSION_MISMATCH: "ADAPTER_PROTOCOL_VERSION_MISMATCH",
  ADAPTER_PROTOCOL_FRAME_INVALID: "ADAPTER_PROTOCOL_FRAME_INVALID",
  ADAPTER_PROTOCOL_RESPONSE_MISMATCH: "ADAPTER_PROTOCOL_RESPONSE_MISMATCH",
  ADAPTER_REQUEST_OVERSIZED: "ADAPTER_REQUEST_OVERSIZED",
  ADAPTER_RESPONSE_OVERSIZED: "ADAPTER_RESPONSE_OVERSIZED",
  ADAPTER_DEADLINE_EXCEEDED: "ADAPTER_DEADLINE_EXCEEDED",
  ADAPTER_PROCESS_CRASHED: "ADAPTER_PROCESS_CRASHED",
  ADAPTER_IDENTITY_MISMATCH: "ADAPTER_IDENTITY_MISMATCH",
  ADAPTER_NOT_CERTIFIED: "ADAPTER_NOT_CERTIFIED",
  ADAPTER_SELF_CERTIFICATION_REFUSED: "ADAPTER_SELF_CERTIFICATION_REFUSED",

  // -- external-adapter certification admission (LIVE-001, ADR-ERL2-036) ----
  //
  // Certification, authentication and admission policy are three separate
  // facts, so they get three separate refusals. Collapsing them would make an
  // unsigned-but-genuinely-certified development adapter indistinguishable
  // from a forged one, which is the distinction the whole path exists to draw.
  ADAPTER_CERTIFICATION_RECEIPT_REQUIRED: "ADAPTER_CERTIFICATION_RECEIPT_REQUIRED",
  ADAPTER_CERTIFICATION_IDENTITY_MISMATCH: "ADAPTER_CERTIFICATION_IDENTITY_MISMATCH",
  ADAPTER_CERTIFICATION_SCOPE_MISMATCH: "ADAPTER_CERTIFICATION_SCOPE_MISMATCH",
  ADAPTER_CERTIFICATION_AUTHENTICATION_REQUIRED:
    "ADAPTER_CERTIFICATION_AUTHENTICATION_REQUIRED",
  ADMISSION_RETENTION_FAILED: "ADMISSION_RETENTION_FAILED",
  ADAPTER_OPERATION_UNSUPPORTED: "ADAPTER_OPERATION_UNSUPPORTED",
  ADAPTER_PACKAGE_KIND_UNSUPPORTED: "ADAPTER_PACKAGE_KIND_UNSUPPORTED",
  ADAPTER_UNDECLARED_MUTATION: "ADAPTER_UNDECLARED_MUTATION",
  ADAPTER_MUTATION_TARGET_NOT_PERMITTED: "ADAPTER_MUTATION_TARGET_NOT_PERMITTED",
  ADAPTER_COMPENSATION_MISSING: "ADAPTER_COMPENSATION_MISSING",
  ADAPTER_COMPENSATION_TARGET_MISMATCH: "ADAPTER_COMPENSATION_TARGET_MISMATCH",
  ADAPTER_MUTATION_UNRECONCILED: "ADAPTER_MUTATION_UNRECONCILED",
  ADAPTER_CAPABILITY_NOT_GRANTED: "ADAPTER_CAPABILITY_NOT_GRANTED",
  ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED: "ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED",
  ADAPTER_MOUNT_FORBIDDEN: "ADAPTER_MOUNT_FORBIDDEN",
  ADAPTER_MOUNT_NOT_READ_ONLY: "ADAPTER_MOUNT_NOT_READ_ONLY",
  ADAPTER_ENVIRONMENT_VARIABLE_DENIED: "ADAPTER_ENVIRONMENT_VARIABLE_DENIED",
  ADAPTER_EGRESS_DENIED: "ADAPTER_EGRESS_DENIED",
  ADAPTER_EGRESS_SCHEME_NOT_ALLOWED: "ADAPTER_EGRESS_SCHEME_NOT_ALLOWED",
  ADAPTER_EGRESS_HOST_NOT_ALLOWED: "ADAPTER_EGRESS_HOST_NOT_ALLOWED",
  ADAPTER_EGRESS_PORT_NOT_ALLOWED: "ADAPTER_EGRESS_PORT_NOT_ALLOWED",
  ADAPTER_EGRESS_REDIRECT_ESCAPED: "ADAPTER_EGRESS_REDIRECT_ESCAPED",
  ADAPTER_EGRESS_DNS_REBOUND: "ADAPTER_EGRESS_DNS_REBOUND",
  ADAPTER_EGRESS_METADATA_SERVICE_DENIED: "ADAPTER_EGRESS_METADATA_SERVICE_DENIED",
  ADAPTER_EGRESS_PROXY_BYPASS_DENIED: "ADAPTER_EGRESS_PROXY_BYPASS_DENIED",
  ADAPTER_DIAGNOSTICS_LIMIT_EXCEEDED: "ADAPTER_DIAGNOSTICS_LIMIT_EXCEEDED",
  ADAPTER_EXECUTION_AFTER_OUTPUT_FREEZE: "ADAPTER_EXECUTION_AFTER_OUTPUT_FREEZE",
  ADAPTER_EXECUTION_FAULT: "ADAPTER_EXECUTION_FAULT",
  ADAPTER_CERTIFICATION_FAILED: "ADAPTER_CERTIFICATION_FAILED",
  ADAPTER_PROJECTION_NONDETERMINISTIC: "ADAPTER_PROJECTION_NONDETERMINISTIC",
  ADAPTER_SANDBOX_CONTROL_UNSUPPORTED: "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED",

  // -- slice 5: credential handles and secret canaries ----------------------
  SECRET_PLAINTEXT_IN_CONTRACT: "SECRET_PLAINTEXT_IN_CONTRACT",
  SECRET_CANARY_IN_DIAGNOSTICS: "SECRET_CANARY_IN_DIAGNOSTICS",
  SECRET_CANARY_IN_SUBJECT_OUTPUT: "SECRET_CANARY_IN_SUBJECT_OUTPUT",
  SECRET_CREDENTIAL_SCOPE_EXCEEDED: "SECRET_CREDENTIAL_SCOPE_EXCEEDED",
  SECRET_CREDENTIAL_HANDLE_UNKNOWN: "SECRET_CREDENTIAL_HANDLE_UNKNOWN",
  SECRET_CREDENTIAL_HANDLE_EXPIRED: "SECRET_CREDENTIAL_HANDLE_EXPIRED",
  SECRET_CREDENTIAL_HANDLE_REPLAYED: "SECRET_CREDENTIAL_HANDLE_REPLAYED",
  SECRET_CREDENTIAL_HANDLE_WRONG_RUN: "SECRET_CREDENTIAL_HANDLE_WRONG_RUN",

  // -- slice 5: path and residue -------------------------------------------
  PATH_HARD_LINK_REJECTED: "PATH_HARD_LINK_REJECTED",
  RESIDUE_DETECTED: "RESIDUE_DETECTED",
  ENV_DRIVER_DISABLED: "ENV_DRIVER_DISABLED",
  ENV_OPERATION_UNSUPPORTED: "ENV_OPERATION_UNSUPPORTED",
  ENV_FOREIGN_RESOURCE_REJECTED: "ENV_FOREIGN_RESOURCE_REJECTED",
  ENV_BROAD_DELETE_REJECTED: "ENV_BROAD_DELETE_REJECTED",
  ENV_RESOURCE_NOT_RUN_SCOPED: "ENV_RESOURCE_NOT_RUN_SCOPED",
  ENV_RESERVATION_CONFLICT: "ENV_RESERVATION_CONFLICT",
  ENV_STALE_LEASE_RECLAIMED: "ENV_STALE_LEASE_RECLAIMED",
  ENV_SUBSTRATE_LOCK_UNQUALIFIED: "ENV_SUBSTRATE_LOCK_UNQUALIFIED",
  /**
   * The observed isolation substrate diverged from its pinned lock, or the
   * probe suite that ran is not the one the lock pins (ERL2-OQ-008).
   */
  ENV_ISOLATION_SUBSTRATE_DRIFT: "ENV_ISOLATION_SUBSTRATE_DRIFT",
  ENV_SUBSTRATE_DIGEST_MISMATCH: "ENV_SUBSTRATE_DIGEST_MISMATCH",
  ENV_SUBSTRATE_PLATFORM_MISSING: "ENV_SUBSTRATE_PLATFORM_MISSING",
  /**
   * The environment substrate lock's Ed25519 signature did not verify (a
   * corrupted signature, a `signed_hash` that is not the lock's own core hash,
   * or a signer whose key the verifier does not hold). The lock cannot license a
   * provisioning run (review §11.5).
   */
  ENV_SUBSTRATE_LOCK_SIGNATURE_INVALID: "ENV_SUBSTRATE_LOCK_SIGNATURE_INVALID",
  ENV_PROVISION_FAILED: "ENV_PROVISION_FAILED",
  ENV_RESIDUE_DETECTED: "ENV_RESIDUE_DETECTED",
  BASELINE_CONTAMINATION_DETECTED: "BASELINE_CONTAMINATION_DETECTED",
  BASELINE_FINGERPRINT_MISMATCH: "BASELINE_FINGERPRINT_MISMATCH",
  BASELINE_PROBE_FAILED: "BASELINE_PROBE_FAILED",
  RESTORATION_FAILED: "RESTORATION_FAILED",
  TEARDOWN_FAILED: "TEARDOWN_FAILED",

  // -- slice 6.5 remediation: run identity, substrate binding, mutation intent
  //    (ADR-ERL2-024; review P0-1, P1-7, P1-8, P1-12) ------------------------
  /**
   * `--run` names a run the workspace at `--run-root` does not record. A run
   * root and a run id are one identity, not two independent inputs (§4.1).
   * Raised before the run lease, any evidence, any substrate directory and any
   * driver, subject port or adapter construction.
   */
  POLICY_RUN_IDENTITY_MISMATCH: "POLICY_RUN_IDENTITY_MISMATCH",
  /**
   * A locator flag named a substrate or reservation root other than the one
   * this run privately recorded when it bound its substrate. A binding may be
   * established once; it may never be replaced by a flag (§4.2).
   */
  ENV_SUBSTRATE_LOCATOR_CONFLICT: "ENV_SUBSTRATE_LOCATOR_CONFLICT",
  /**
   * A bound run reached a substrate that carries no instance identity — the
   * fresh empty directory of the P0-1 substitution exploit. Raised before any
   * cleanup evidence can freeze.
   */
  ENV_SUBSTRATE_BINDING_MISSING: "ENV_SUBSTRATE_BINDING_MISSING",
  /**
   * The substrate instance, driver, archetype or reservation namespace this
   * phase is about to talk to is not the one the run bound.
   */
  ENV_SUBSTRATE_BINDING_MISMATCH: "ENV_SUBSTRATE_BINDING_MISMATCH",
  /**
   * The lifecycle records a provisioned environment; the substrate says this
   * run was never provisioned in it. A teardown here would be a clean report
   * over resources it never looked at.
   */
  ENV_SUBSTRATE_NOT_PROVISIONED: "ENV_SUBSTRATE_NOT_PROVISIONED",
  /**
   * The substrate exists but could not be read. Previously indistinguishable
   * from "never provisioned", so an ordinary permission or I/O fault yielded a
   * passing teardown over live resources (review P1-12). It is now its own
   * fail-closed refusal.
   */
  ENV_SUBSTRATE_UNREADABLE: "ENV_SUBSTRATE_UNREADABLE",
  /**
   * The run declares an obtainable attributable-telemetry observation — a
   * driver that can observe it, an archetype declaring a metric source and a
   * succeeded exercising step — and retains none (ADR-ERL2-033).
   */
  ENV_TELEMETRY_OBSERVATION_MISSING: "ENV_TELEMETRY_OBSERVATION_MISSING",
  /**
   * The observation was declared obtainable and the retained record is
   * `absent` or carries zero records naming this run's marker. Telemetry
   * silence where telemetry was declared is a refusal, never a downgrade
   * (ADR-ERL2-033).
   */
  ENV_TELEMETRY_NOT_ATTRIBUTED: "ENV_TELEMETRY_NOT_ATTRIBUTED",
  /**
   * A retained telemetry observation that is not this run's, whose marker is
   * not the run id, whose counts disagree with the counts recomputed from its
   * own retained log excerpt, or whose lifecycle placement does not prove the
   * collector was read before teardown began (ADR-ERL2-033).
   */
  ENV_TELEMETRY_OBSERVATION_MISMATCH: "ENV_TELEMETRY_OBSERVATION_MISMATCH",
  /** An external dispatch was reached with no durable intent. A Lab defect; fails closed. */
  ENV_MUTATION_INTENT_MISSING: "ENV_MUTATION_INTENT_MISSING",
  /**
   * A durable intent is unsettled, the operation is not idempotent, and no
   * probe can observe whether the external effect happened. Ambiguity fails
   * closed rather than re-dispatching (§4.3).
   */
  ENV_MUTATION_INTENT_AMBIGUOUS: "ENV_MUTATION_INTENT_AMBIGUOUS",
  /**
   * Whole-environment destruction would affect a target the frontier-derived
   * action set does not authorize. A driver whose only granularity is the whole
   * environment may be invoked only when every observed member is an authorized
   * target (§4.5).
   */
  EMERGENCY_ACTION_UNDECLARED_TARGET: "EMERGENCY_ACTION_UNDECLARED_TARGET",

  // -- slice 6.5 remediation: one cleanup discipline and an independently
  //    observed residue (ADR-ERL2-027; review P1-1, P1-3, P1-5, P1-6) ---------
  /**
   * An invalid environment terminal that froze a resource frontier retains no
   * `cleanup-residue-probe/v1`, or retains one that is not about that frontier:
   * another run, another substrate binding, another frontier, or an
   * `observed_before` that disagrees with the frontier it names.
   *
   * Without it the post-cleanup residue is derived by the producer from the
   * producer's own action outcomes, so an empty one is unfalsifiable offline
   * (ADR-ERL2-027 §1.6).
   */
  RESIDUE_PROBE_MISSING: "RESIDUE_PROBE_MISSING",
  /**
   * A resource present in the pre-action frontier is absent afterwards and was
   * never the authorized target of an attempted safe action.
   *
   * This is the offline-detectable form of destroy-first-classify-afterwards: a
   * post-cleanup inventory alone cannot tell an authorized destruction from an
   * unauthorized one, because the resource is absent in both (review P1-1).
   */
  RESIDUE_UNDECLARED_DESTRUCTION: "RESIDUE_UNDECLARED_DESTRUCTION",

  // -- slice 6.5 remediation: independently probed restoration and the
  //    evidence-derived claim ceiling (ADR-ERL2-025/026; review P1-4, P2) ----
  /**
   * A compensation was cited without the independent observation that says what
   * it actually did: no retained `restoration-probe/v1`, a probe naming another
   * run, another substrate binding or another compensation operation, or a
   * probe whose expected mutation set does not correspond to the retained
   * mutation receipts (ADR-ERL2-026 §4.3).
   */
  RESTORATION_PROBE_MISSING: "RESTORATION_PROBE_MISSING",
  /**
   * The substrate was re-read after the compensation and the mutation the
   * compensation was declared to revert is still applied, or unrelated state
   * was reverted instead, or the driver offers no applied-mutation observation
   * at all. A receipt reading `succeeded` is not an answer to this question,
   * which is why it is asked separately (review P1-4).
   */
  RESTORATION_NOT_INDEPENDENTLY_OBSERVED: "RESTORATION_NOT_INDEPENDENTLY_OBSERVED",
  /**
   * A requested or retained `claim_scope` is stronger than the ceiling
   * independently derived from the run's own retained evidence
   * (ADR-ERL2-025 §4). Raised by the producer against `--claim-scope` and again,
   * independently, by the offline verifier against the signed attestation.
   */
  POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE: "POLICY_CLAIM_SCOPE_EXCEEDS_EVIDENCE",
  // -- slice 6: data-only evaluation packs (ERL2-OQ-004 fail-closed) --------
  PACK_SUBJECT_VOCABULARY_IN_DOMAIN_SCOPE: "PACK_SUBJECT_VOCABULARY_IN_DOMAIN_SCOPE",
  PACK_PROHIBITED_API_REFERENCE: "PACK_PROHIBITED_API_REFERENCE",
  PACK_CANDIDATE_TOKEN_PRESENT: "PACK_CANDIDATE_TOKEN_PRESENT",
  PACK_SHORTCUT_PREDICATE_REFUSED: "PACK_SHORTCUT_PREDICATE_REFUSED",
  PACK_UNDECLARED_VOCABULARY: "PACK_UNDECLARED_VOCABULARY",
  PACK_UNKNOWN_METRIC_ID: "PACK_UNKNOWN_METRIC_ID",
  PACK_GENERIC_METRIC_OVERRIDE: "PACK_GENERIC_METRIC_OVERRIDE",
  PACK_INPUT_CONTRACT_NOT_PERMITTED: "PACK_INPUT_CONTRACT_NOT_PERMITTED",
  PACK_VALIDITY_AUTHORITY_REFUSED: "PACK_VALIDITY_AUTHORITY_REFUSED",
  PACK_THRESHOLD_MUTATION_REFUSED: "PACK_THRESHOLD_MUTATION_REFUSED",
  PACK_OWNERSHIP_NOT_A_PACK_DECISION: "PACK_OWNERSHIP_NOT_A_PACK_DECISION",
  PACK_NOT_CERTIFIED: "PACK_NOT_CERTIFIED",
  PACK_EXECUTABLE_MODULE_REFUSED: "PACK_EXECUTABLE_MODULE_REFUSED",

  // -- slice 6: the generic evaluator ---------------------------------------
  EVALUATOR_FINDING_OWNER_CONTRADICTION: "EVALUATOR_FINDING_OWNER_CONTRADICTION",
  EVALUATOR_SUBJECT_ATTRIBUTION_UNPROVEN: "EVALUATOR_SUBJECT_ATTRIBUTION_UNPROVEN",
  EVALUATOR_UNSUPPORTED_RELABELLED: "EVALUATOR_UNSUPPORTED_RELABELLED",
  EVALUATOR_INVALID_RUN_CANNOT_ATTEST_SUBJECT: "EVALUATOR_INVALID_RUN_CANNOT_ATTEST_SUBJECT",
  EVALUATOR_UNDECLARED_REASON_CODE: "EVALUATOR_UNDECLARED_REASON_CODE",
  EVALUATOR_METRIC_INPUT_UNAVAILABLE: "EVALUATOR_METRIC_INPUT_UNAVAILABLE",
  EVALUATOR_ZERO_DENOMINATOR_UNDEFINED: "EVALUATOR_ZERO_DENOMINATOR_UNDEFINED",
  EVALUATOR_NONDETERMINISM: "EVALUATOR_NONDETERMINISM",
  EVALUATOR_DUPLICATE_STEP_OUTCOME: "EVALUATOR_DUPLICATE_STEP_OUTCOME",
  EVALUATOR_STEP_OUTCOME_NOT_DERIVED: "EVALUATOR_STEP_OUTCOME_NOT_DERIVED",
  EVALUATOR_DOMAIN_VARIANT_MISMATCH: "EVALUATOR_DOMAIN_VARIANT_MISMATCH",
  EVALUATOR_DOMAIN_EVIDENCE_UNAVAILABLE: "EVALUATOR_DOMAIN_EVIDENCE_UNAVAILABLE",
  EVALUATOR_NOT_APPLICABLE_REASON_MISMATCH: "EVALUATOR_NOT_APPLICABLE_REASON_MISMATCH",
  EVALUATOR_RESULT_JOIN_INCOMPLETE: "EVALUATOR_RESULT_JOIN_INCOMPLETE",
  EVALUATOR_RESULT_JOIN_DUPLICATE: "EVALUATOR_RESULT_JOIN_DUPLICATE",
  EVALUATOR_CLEANUP_BEFORE_RESULT_JOIN: "EVALUATOR_CLEANUP_BEFORE_RESULT_JOIN",
  EVALUATOR_CROSS_RUN_RESULT: "EVALUATOR_CROSS_RUN_RESULT",
  EVALUATOR_CROSS_POLICY_RESULT: "EVALUATOR_CROSS_POLICY_RESULT",
  EVALUATOR_STALE_RESULT_HASH: "EVALUATOR_STALE_RESULT_HASH",
  EVALUATOR_INVALID_VALIDITY_IN_GENERIC_INDEX: "EVALUATOR_INVALID_VALIDITY_IN_GENERIC_INDEX",
  EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED: "EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED",
  /**
   * A retained validity result disagrees with its own gate set, or a failed gate
   * carries no invalidity finding naming it. Raised by the offline verifier,
   * which re-derives the verdict rather than reading `status` (ADR-ERL2-024
   * §4.6; review P1-3 and the tautological `lab_validity` check).
   */
  EVALUATOR_VALIDITY_GATE_FAILED: "EVALUATOR_VALIDITY_GATE_FAILED",
  EVALUATOR_FABRICATED_CITATION: "EVALUATOR_FABRICATED_CITATION",
  EVALUATOR_CAUSAL_OVERCLAIM: "EVALUATOR_CAUSAL_OVERCLAIM",

  // -- slice 6: judge-expectation reveal ------------------------------------
  REVEAL_BEFORE_OUTPUT_FREEZE: "REVEAL_BEFORE_OUTPUT_FREEZE",
  REVEAL_CIPHERTEXT_MISMATCH: "REVEAL_CIPHERTEXT_MISMATCH",
  REVEAL_TRUTH_SCOPE_FORBIDDEN: "REVEAL_TRUTH_SCOPE_FORBIDDEN",

  // -- slice 6: finalization and the deep-ancestry boundary -----------------
  DEEP_ANCESTRY_FIELD_IN_GENERIC_ARTIFACT: "DEEP_ANCESTRY_FIELD_IN_GENERIC_ARTIFACT",
  DEEP_ANCESTRY_BASE_NOT_FROZEN: "DEEP_ANCESTRY_BASE_NOT_FROZEN",
  BUNDLE_FINALIZED_BEFORE_CLEANUP: "BUNDLE_FINALIZED_BEFORE_CLEANUP",
  BUNDLE_FINALIZED_BEFORE_EXPOSURE: "BUNDLE_FINALIZED_BEFORE_EXPOSURE",
  BUNDLE_FINALIZED_BEFORE_TRUST_CLOSURE: "BUNDLE_FINALIZED_BEFORE_TRUST_CLOSURE",

  POLICY_CONFLICT: "POLICY_CONFLICT",
  // A Lab-owned run-lease conflict: another live command holds the run.  This is
  // never an adapter or subject failure (design §20 failure ownership).
  POLICY_RUN_LEASE_HELD: "POLICY_RUN_LEASE_HELD",
  POLICY_COMMAND_NOT_IMPLEMENTED: "POLICY_COMMAND_NOT_IMPLEMENTED",
  CFG_UNKNOWN_FLAG: "CFG_UNKNOWN_FLAG",
  CFG_DUPLICATE_FLAG: "CFG_DUPLICATE_FLAG",
  CFG_MISSING_REQUIRED: "CFG_MISSING_REQUIRED",
  /**
   * A development-only shortcut (the fake-subject-port scripting flags
   * `--fake-acquire` / `--fake-verify-package`) was used without the explicit
   * development profile enabled. These flags script test failpoints and are not
   * reachable on the default release surface (review §11.8, plan §8.5).
   */
  CFG_DEVELOPMENT_FLAG_UNAVAILABLE: "CFG_DEVELOPMENT_FLAG_UNAVAILABLE",
  /**
   * Backstop for an exception that is not already a typed refusal.  The CLI's
   * top level must never exit with a raw stack trace and no code: every command
   * outcome is a typed, Lab-owned envelope (design Appendix B/C, §20 failure
   * ownership).  Reaching this code is a Lab defect, never a subject or adapter
   * outcome — it is owner `lab` by construction.
   */
  LAB_UNEXPECTED_FAILURE: "LAB_UNEXPECTED_FAILURE",

  // A run that was durably accepted and then cancelled reaches the mandatory
  // cancellation terminal (design v2 §12, Appendix B exit 12).
  CANCELLATION_REQUESTED: "CANCELLATION_REQUESTED",
  CANCELLATION_BEFORE_ACCEPTANCE: "CANCELLATION_BEFORE_ACCEPTANCE",
  CANCELLATION_AFTER_TERMINAL: "CANCELLATION_AFTER_TERMINAL",
} as const;

export type Erl2ErrorCode = (typeof CODES)[keyof typeof CODES];
