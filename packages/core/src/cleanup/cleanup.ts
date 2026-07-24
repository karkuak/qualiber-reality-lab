/**
 * Cleanup and emergency-cleanup evaluation (design v2 §12/§16.2,
 * implementation plan §12.1 S6.7).
 *
 * A terminal uses exactly one branch, chosen from the *actual* resource
 * frontier rather than from a caller's assertion:
 *
 * - a pre-environment terminal proves only the resources that could exist;
 * - an environment terminal requires restoration **and** teardown;
 * - a restoration or teardown failure enters emergency cleanup, which must
 *   attempt every independently safe action and receipt each attempt.
 *
 * The emergency-action union is closed and its conditionals are enforced twice:
 * once here, when the verification is built, and again by the offline verifier
 * (`assertEmergencyActionEvidence`), so an emergency result cannot be
 * hand-assembled to look complete.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type EmergencyCleanupActionV1,
  type EmergencyCleanupVerificationV1,
  type EnvironmentResourceFrontierV1,
  type EnvironmentRestorationVerificationV1,
  type Hash,
  type Instant,
  type PreEnvironmentCleanupVerificationV1,
  type TeardownVerificationV1,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";
import { safeActions } from "../environment/frontier.js";
import { assertNarrowSelector } from "../environment/driver.js";

// -- 1. pre-environment cleanup ----------------------------------------------

export interface PreEnvironmentCleanupInput {
  readonly runId: string;
  readonly terminalStage: "acquire" | "verify_package";
  readonly acquisitionPreregistrationHash: Hash;
  readonly acquisitionRecordHash: Hash;
  readonly subjectOutputHash: Hash;
  readonly acquiredArtifactDisposition: "never_created" | "deleted" | "retained_quarantined";
  readonly cleanupReceiptHashes: readonly Hash[];
  readonly residualAcquisitionResources: readonly { readonly kind: string; readonly identity_hash: Hash }[];
  readonly verifiedAt: Instant;
}

/**
 * Verifies the only cleanup a pre-environment terminal can owe: the Lab's own
 * acquisition temporaries.  No environment was provisioned, so there is nothing
 * external to restore or tear down.
 *
 * `passed` is derived, not supplied: a residual resource that is not explicitly
 * quarantined means cleanup did not pass.
 */
export function buildPreEnvironmentCleanup(
  input: PreEnvironmentCleanupInput,
): PreEnvironmentCleanupVerificationV1 {
  const passed =
    input.residualAcquisitionResources.length === 0 ||
    input.acquiredArtifactDisposition === "retained_quarantined";
  const body = {
    schema_version: "pre-environment-cleanup-verification/v1" as const,
    run_id: input.runId,
    terminal_stage: input.terminalStage,
    acquisition_preregistration_hash: input.acquisitionPreregistrationHash,
    acquisition_record_hash: input.acquisitionRecordHash,
    subject_output_hash: input.subjectOutputHash,
    acquired_artifact_disposition: input.acquiredArtifactDisposition,
    cleanup_receipt_hashes: [...input.cleanupReceiptHashes],
    residual_acquisition_resources: input.residualAcquisitionResources.map((r) => ({
      kind: r.kind,
      identity_hash: r.identity_hash,
    })),
    verified_at: input.verifiedAt,
    passed,
  };
  return assertContract<PreEnvironmentCleanupVerificationV1>(
    "PreEnvironmentCleanupVerificationV1",
    { ...body, core_hash: coreHash(body) },
  );
}

// -- 2. environment restoration and teardown ---------------------------------

export interface EnvironmentRestorationInput {
  readonly runId: string;
  readonly environmentInstanceHash: Hash;
  readonly activationReceiptHashes: readonly Hash[];
  readonly compensationReceiptHashes: readonly Hash[];
  readonly subjectStopHash?: Hash;
  readonly subjectUninstallHash?: Hash;
  readonly baselineBeforeHash: Hash;
  readonly baselineAfterHash: Hash;
  readonly residualResources: readonly { readonly kind: string; readonly identity_hash: Hash }[];
  readonly restoredAt: Instant;
}

/**
 * Restoration passes only when the after-baseline equals the before-baseline
 * and nothing is left behind.  A drifted baseline is a restoration failure,
 * which routes to emergency cleanup (design v2 §12).
 */
export function buildEnvironmentRestoration(
  input: EnvironmentRestorationInput,
): EnvironmentRestorationVerificationV1 {
  const passed =
    input.residualResources.length === 0 && input.baselineAfterHash === input.baselineBeforeHash;
  const body = {
    schema_version: "environment-restoration-verification/v1" as const,
    run_id: input.runId,
    environment_instance_hash: input.environmentInstanceHash,
    activation_receipt_hashes: [...input.activationReceiptHashes],
    compensation_receipt_hashes: [...input.compensationReceiptHashes],
    ...(input.subjectStopHash === undefined ? {} : { subject_stop_hash: input.subjectStopHash }),
    ...(input.subjectUninstallHash === undefined
      ? {}
      : { subject_uninstall_hash: input.subjectUninstallHash }),
    baseline_before_hash: input.baselineBeforeHash,
    baseline_after_hash: input.baselineAfterHash,
    residual_resources: input.residualResources.map((r) => ({
      kind: r.kind,
      identity_hash: r.identity_hash,
    })),
    restored_at: input.restoredAt,
    passed,
  };
  return assertContract<EnvironmentRestorationVerificationV1>(
    "EnvironmentRestorationVerificationV1",
    { ...body, core_hash: coreHash(body) },
  );
}

/**
 * One residue inspection: a resource kind, the exact selector that was
 * enumerated, and what was still there afterwards.
 *
 * A teardown check is *not* a pass/fail assertion the caller supplies. It is an
 * observation of what remained, and `passed` is derived from it below — which
 * is what stops a driver reporting a clean teardown over a resource it failed
 * to destroy.
 */
export interface TeardownCheck {
  readonly kind: "container" | "network" | "volume" | "secret_file" | "port" | "working_state";
  /** Exact, run-scoped selector. A wildcard is refused, not narrowed. */
  readonly selector: string;
  readonly residueHashes: readonly Hash[];
}

export interface TeardownInput {
  readonly runId: string;
  readonly environmentInstanceHash: Hash;
  readonly restorationVerificationHash: Hash;
  readonly checks: readonly TeardownCheck[];
  readonly checkedAt: Instant;
}

/**
 * Verifies teardown from residue observations.
 *
 * Two properties matter here, and both are enforced rather than trusted:
 *
 *  1. **Every selector must be narrow and run-scoped.** `assertNarrowSelector`
 *     refuses a wildcard or a selector that does not embed the run id, so a
 *     teardown cannot be recorded against "everything that looked like ours".
 *  2. **`passed` is derived, never supplied.** It is true only when every
 *     inspection found zero residue. A caller cannot assert a clean teardown
 *     over a non-empty residue list, and `residue_count` is computed from the
 *     hashes rather than declared alongside them, so the count and the evidence
 *     cannot disagree.
 */
export function buildTeardownVerification(input: TeardownInput): TeardownVerificationV1 {
  if (input.checks.length === 0) {
    throw new Erl2Error(
      CODES.RESIDUE_DETECTED,
      "teardown verification requires at least one residue inspection; an uninspected teardown proves nothing",
      { owner: "lab" },
    );
  }
  for (const check of input.checks) {
    assertNarrowSelector(input.runId, check.selector);
  }
  const checks = input.checks.map((c) => ({
    kind: c.kind,
    selector: c.selector,
    residue_count: c.residueHashes.length,
    residue_hashes: [...c.residueHashes],
  }));
  const body = {
    schema_version: "teardown-verification/v1" as const,
    run_id: input.runId,
    environment_instance_hash: input.environmentInstanceHash,
    restoration_verification_hash: input.restorationVerificationHash,
    checks,
    checked_at: input.checkedAt,
    passed: checks.every((c) => c.residue_count === 0),
  };
  return assertContract<TeardownVerificationV1>("TeardownVerificationV1", {
    ...body,
    core_hash: coreHash(body),
  });
}

// -- 3. emergency cleanup ----------------------------------------------------

/** The outcome an operator or driver reports for one attempted action. */
export interface EmergencyAttempt {
  readonly actionId: string;
  readonly succeeded: boolean;
  /** Receipt for the attempt. Required for every attempted action, success or failure. */
  readonly attemptReceiptHash?: Hash;
  readonly reasonCode?: string;
}

export interface EmergencyCleanupInput {
  readonly runId: string;
  readonly environmentInstanceHash: Hash;
  readonly trigger: "restoration_failure" | "teardown_failure" | "invalid_environment_failure";
  readonly frontier: EnvironmentResourceFrontierV1;
  readonly resourceFrontierEventHash: Hash;
  readonly attempts: readonly EmergencyAttempt[];
  readonly remainingResources: readonly {
    readonly kind: string;
    readonly identity_hash: Hash;
    readonly containment_status: "contained" | "uncontained" | "unknown";
  }[];
  readonly completedAt: Instant;
}

/**
 * Builds the emergency-cleanup verification from the *frontier*, not from the
 * caller's action list.
 *
 * Every independently safe action the frontier derived must have an attempt
 * with a receipt; every unsafe action becomes a `skipped_unsafe` entry carrying
 * its frontier-derived reason and no receipt.  An attempt for an action the
 * frontier never derived is refused.
 */
export function buildEmergencyCleanup(
  input: EmergencyCleanupInput,
): EmergencyCleanupVerificationV1 {
  const derived = input.frontier.derived_actions;
  const derivedIds = new Set(derived.map((a) => a.action_id));
  const attemptsById = new Map(input.attempts.map((a) => [a.actionId, a]));

  for (const attempt of input.attempts) {
    if (!derivedIds.has(attempt.actionId)) {
      throw new Erl2Error(
        CODES.EMERGENCY_ACTION_RECEIPT_MISSING,
        `emergency attempt ${attempt.actionId} names an action the resource frontier never derived`,
        { owner: "lab" },
      );
    }
  }

  const actions: EmergencyCleanupActionV1[] = [];
  for (const action of derived) {
    if (!action.independently_safe) {
      const attempted = attemptsById.get(action.action_id);
      if (attempted !== undefined) {
        throw new Erl2Error(
          CODES.EMERGENCY_ACTION_RECEIPT_MISSING,
          `action ${action.action_id} is not independently safe; it must be skipped without a receipt`,
          { owner: "lab" },
        );
      }
      if (action.unsafe_reason_code === undefined) {
        throw new Erl2Error(
          CODES.EMERGENCY_ACTION_RECEIPT_MISSING,
          `unsafe action ${action.action_id} carries no reason`,
          { owner: "lab" },
        );
      }
      actions.push({
        action_id: action.action_id,
        kind: action.kind,
        independently_safe: false,
        status: "skipped_unsafe",
        reason_code: action.unsafe_reason_code,
      });
      continue;
    }

    // Independently safe: it MUST have been attempted, and the attempt MUST
    // carry a receipt whether it succeeded or failed (ERL2-FR-025/031).
    const attempt = attemptsById.get(action.action_id);
    if (attempt === undefined) {
      throw new Erl2Error(
        CODES.EMERGENCY_ACTION_SAFE_ACTION_SKIPPED,
        `independently safe action ${action.action_id} was not attempted`,
        { owner: "lab" },
      );
    }
    if (attempt.attemptReceiptHash === undefined) {
      throw new Erl2Error(
        CODES.EMERGENCY_ACTION_RECEIPT_MISSING,
        `attempted action ${action.action_id} has no attempt receipt`,
        { owner: "lab" },
      );
    }
    if (attempt.succeeded) {
      actions.push({
        action_id: action.action_id,
        kind: action.kind,
        independently_safe: true,
        status: "succeeded",
        attempt_receipt_hash: attempt.attemptReceiptHash,
      });
      continue;
    }
    if (attempt.reasonCode === undefined) {
      throw new Erl2Error(
        CODES.EMERGENCY_ACTION_RECEIPT_MISSING,
        `failed action ${action.action_id} has a receipt but no reason`,
        { owner: "lab" },
      );
    }
    actions.push({
      action_id: action.action_id,
      kind: action.kind,
      independently_safe: true,
      status: "failed",
      attempt_receipt_hash: attempt.attemptReceiptHash,
      reason_code: attempt.reasonCode,
    });
  }

  // The remaining-resource set must be derivable from the frontier: an
  // emergency result cannot claim a cleaner outcome than the frontier allows.
  assertRemainingResourcesMatchFrontier(input.frontier, actions, input.remainingResources);

  const body = {
    schema_version: "emergency-cleanup-verification/v1" as const,
    run_id: input.runId,
    environment_instance_hash: input.environmentInstanceHash,
    trigger: input.trigger,
    resource_frontier_event_hash: input.resourceFrontierEventHash,
    actions,
    all_independently_safe_actions_attempted: true as const,
    remaining_resources: input.remainingResources.map((r) => ({
      kind: r.kind,
      identity_hash: r.identity_hash,
      containment_status: r.containment_status,
    })),
    completed_at: input.completedAt,
  };
  return assertContract<EmergencyCleanupVerificationV1>("EmergencyCleanupVerificationV1", {
    ...body,
    core_hash: coreHash(body),
  });
}

/**
 * Every resource whose action was skipped as unsafe or failed must still appear
 * in `remaining_resources` with an explicit containment status.  Silence is not
 * containment.
 */
export function assertRemainingResourcesMatchFrontier(
  frontier: EnvironmentResourceFrontierV1,
  actions: readonly EmergencyCleanupActionV1[],
  remaining: readonly { readonly identity_hash: Hash; readonly containment_status: string }[],
): void {
  const unresolved = actions.filter((a) => a.status !== "succeeded").map((a) => a.action_id);
  const byActionId = new Map(frontier.derived_actions.map((a) => [a.action_id, a.target_resource_id]));
  const byResourceId = new Map(
    frontier.observed_resources.map((r) => [r.resource_id, r.identity_hash]),
  );
  const declared = new Set(remaining.map((r) => r.identity_hash));
  const missing: string[] = [];
  for (const actionId of unresolved) {
    const resourceId = byActionId.get(actionId);
    const identity = resourceId === undefined ? undefined : byResourceId.get(resourceId);
    if (identity !== undefined && !declared.has(identity)) missing.push(actionId);
  }
  if (missing.length > 0) {
    throw new Erl2Error(
      CODES.RESIDUE_DETECTED,
      `emergency cleanup left resources unaccounted for: ${missing.join(", ")}`,
      { owner: "lab" },
    );
  }
}

/** Independently safe actions the frontier requires an attempt for. */
export function requiredEmergencyAttempts(
  frontier: EnvironmentResourceFrontierV1,
): readonly string[] {
  return safeActions(frontier).map((a) => a.action_id);
}
