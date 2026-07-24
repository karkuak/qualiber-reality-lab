/**
 * Phase-specific request validation (design v2 §11.2, ERL2-FR-018, ERL2-AC-021).
 *
 * Acquisition, package verification and post-plan requests are three
 * structurally disjoint closed schemas. There is no generic request with
 * optional future fields, so "add a field later" cannot become "leak a future
 * ancestor". This module adds the checks a local schema cannot express: which
 * ancestors belong to which phase, and which operations may be dispatched in
 * each phase.
 */

import {
  CODES,
  Erl2Error,
  type AcquisitionAdapterRequestV1,
  type AdapterOperation,
  type AdapterStepRequestV1,
  type PackageVerificationRequestV1,
} from "@erl2/contracts";

export type AdapterRequestV1 =
  | AcquisitionAdapterRequestV1
  | PackageVerificationRequestV1
  | AdapterStepRequestV1;

/** The one request schema each phase uses. */
export const PHASE_REQUEST_SCHEMA = {
  acquisition: "acquisition-adapter-request/v1",
  package_verification: "package-verification-request/v1",
  post_plan: "adapter-step-request/v1",
} as const;

export type AdapterRequestPhase = keyof typeof PHASE_REQUEST_SCHEMA;

/** Ancestors that may never appear in an earlier-phase request. */
const LATER_PHASE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "acquisition-adapter-request/v1": [
    "acquisition_record_hash",
    "frozen_acquired_artifact",
    "frozen_package_file_sha256",
    "execution_plan_hash",
    "canonical_evidence_envelope_hash",
    "canonical_evidence_mount_handle_id",
    "subject_package_manifest_hash",
    "challenge_manifest_hash",
    "environment_instance_hash",
    "selection_request_hash",
    "selected_challenge_journey_binding_hash",
    "journey_hash",
    "truth_commitment_hash",
    "judge_expectation_hash",
    "prior_visible_interaction_hashes",
  ],
  "package-verification-request/v1": [
    "execution_plan_hash",
    "canonical_evidence_envelope_hash",
    "canonical_evidence_mount_handle_id",
    "subject_package_manifest_hash",
    "challenge_manifest_hash",
    "environment_instance_hash",
    "selection_request_hash",
    "selected_challenge_journey_binding_hash",
    "journey_hash",
    "truth_commitment_hash",
    "judge_expectation_hash",
    "prior_visible_interaction_hashes",
  ],
  "adapter-step-request/v1": [
    "truth_commitment_hash",
    "judge_expectation_hash",
    "expected_observations",
    "success_predicate_hash",
    "selection_request_hash",
    "selected_challenge_journey_binding_hash",
    "eligibility_pool_manifest_hash",
    "selection_commitment_hash",
  ],
};

/** Operations that may be dispatched in each phase, and only in that phase. */
const PHASE_OPERATIONS: Readonly<Record<AdapterRequestPhase, readonly AdapterOperation[]>> = {
  acquisition: ["acquire"],
  package_verification: ["validate-package"],
  post_plan: [
    "install",
    "configure",
    "start",
    "interact",
    "translate-evidence",
    "collect-outputs",
    "project",
    "stop",
    "uninstall",
    "report-residue",
    "compensate",
  ],
};

export function phaseOfRequest(request: unknown): AdapterRequestPhase {
  const record = request as Record<string, unknown> | null;
  const schemaVersion = record === null ? undefined : record["schema_version"];
  for (const [phase, schema] of Object.entries(PHASE_REQUEST_SCHEMA)) {
    if (schemaVersion === schema) return phase as AdapterRequestPhase;
  }
  throw new Erl2Error(
    CODES.REQUEST_ANCESTRY_INVALID,
    `unknown adapter request schema ${String(schemaVersion).slice(0, 64)}`,
  );
}

/**
 * Fails closed with `REQUEST_ANCESTRY_INVALID` when a request carries an
 * ancestor from a later phase.
 */
export function assertRequestAncestry(request: AdapterRequestV1 | unknown): AdapterRequestPhase {
  const phase = phaseOfRequest(request);
  const record = request as Record<string, unknown>;
  const schemaVersion = String(record["schema_version"]);
  const forbidden = LATER_PHASE_FIELDS[schemaVersion] ?? [];
  for (const field of forbidden) {
    if (Object.hasOwn(record, field)) {
      throw new Erl2Error(
        CODES.REQUEST_ANCESTRY_INVALID,
        `${schemaVersion} carries later-phase ancestor ${field}`,
      );
    }
  }
  if (record["protocol_version"] !== "subject-adapter/v1") {
    throw new Erl2Error(
      CODES.ADAPTER_PROTOCOL_VERSION_MISMATCH,
      `${schemaVersion} declares protocol ${String(record["protocol_version"]).slice(0, 64)}`,
    );
  }
  return phase;
}

/** Refuses an operation dispatched against the wrong phase's request. */
export function assertOperationMatchesPhase(
  operation: AdapterOperation,
  phase: AdapterRequestPhase,
): void {
  if (!PHASE_OPERATIONS[phase].includes(operation)) {
    throw new Erl2Error(
      CODES.REQUEST_ANCESTRY_INVALID,
      `operation ${operation} cannot be dispatched with a ${phase} request`,
    );
  }
}

/**
 * A post-plan request must carry the execution plan; an acquisition or
 * package-verification request must not.
 */
export function assertExecutionPlan(request: unknown, expectedPlanHash: string | undefined): void {
  const phase = phaseOfRequest(request);
  const record = request as Record<string, unknown>;
  if (phase !== "post_plan") {
    if (expectedPlanHash !== undefined) {
      throw new Erl2Error(
        CODES.REQUEST_ANCESTRY_INVALID,
        "an execution plan was supplied for a pre-plan phase",
      );
    }
    return;
  }
  const declared = record["execution_plan_hash"];
  if (typeof declared !== "string") {
    throw new Erl2Error(
      CODES.REQUEST_ANCESTRY_INVALID,
      "a post-plan request must carry its execution plan hash",
    );
  }
  if (expectedPlanHash !== undefined && declared !== expectedPlanHash) {
    throw new Erl2Error(
      CODES.REQUEST_ANCESTRY_INVALID,
      "post-plan request references an execution plan the run did not freeze",
    );
  }
}

/** Tokens no adapter-visible byte stream may contain (ERL2-FR-015). */
export const ORACLE_CANARY_PATTERN = /erl2-canary-[0-9a-f]{32}/g;

/** Tokens that mark a Lab-owned secret; a hit in adapter-visible bytes is fatal. */
export const SECRET_CANARY_PATTERN = /erl2-secret-[0-9a-f]{32}/g;

/**
 * Field names that would carry oracle authority into the adapter plane. Their
 * *presence* is the violation, whatever the value.
 */
export const FORBIDDEN_REQUEST_FIELDS = [
  "expected_observations",
  "success_predicate",
  "success_predicate_hash",
  "truth",
  "truth_commitment_hash",
  "truth_view_selector",
  "judge_expectation",
  "judge_expectation_hash",
  "judge_journey_expectation",
  "failure_category",
  "expected_outcome",
  "reveal_phase",
] as const;

/**
 * Scans an adapter-visible byte stream for judge canaries.  Any hit invalidates
 * the run before subject attribution.
 */
export function assertNoOracleCanary(what: string, bytes: Buffer | string): void {
  const text = typeof bytes === "string" ? bytes : bytes.toString("utf8");
  const judge = text.match(ORACLE_CANARY_PATTERN);
  if (judge && judge.length > 0) {
    throw new Erl2Error("JOURNEY_ORACLE_CANARY_LEAKED", `judge canary reached ${what}`, {
      owner: "lab",
    });
  }
  const secret = text.match(SECRET_CANARY_PATTERN);
  if (secret && secret.length > 0) {
    throw new Erl2Error(CODES.SECRET_CANARY_IN_DIAGNOSTICS, `secret canary reached ${what}`, {
      owner: "lab",
    });
  }
}

/** Structural half of the oracle partition: the field must not exist at all. */
export function assertNoOracleFields(what: string, value: unknown): void {
  const walk = (node: unknown, depth: number): void => {
    if (depth > 32 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if ((FORBIDDEN_REQUEST_FIELDS as readonly string[]).includes(key)) {
        throw new Erl2Error(
          "JOURNEY_ORACLE_FIELD_PRESENT",
          `${what} carries the oracle field ${key}`,
          { owner: "lab" },
        );
      }
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
}
