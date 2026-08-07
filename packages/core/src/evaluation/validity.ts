/**
 * Lab-owned validity evaluation (design v2 §12/§17, implementation plan §12.1
 * S6.6).
 *
 * Validity answers exactly one question: *is this experimental run and its
 * evidence trustworthy enough to attest?*  It is decided entirely from Lab-owned
 * integrity and experimental-control evidence.
 *
 * It must never depend on whether the subject's claims are correct, useful,
 * complete or favourable.  The gate catalogue below therefore contains no
 * reference to a claim, a metric value, a domain result status or a journey
 * outcome status; `assertGatesAreLabOwned` refuses a gate identifier outside the
 * catalogue, so a caller cannot smuggle subject quality into the verdict.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type EnvironmentJourneyIntent,
  type EnvironmentValidityResultV1,
  type Hash,
  type Instant,
  type PreEnvironmentValidityResultV1,
  type ValidityResultV1,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";

/**
 * Gate categories design v2 requires, with the exact gate identifiers the Lab
 * owns.  Every one is an integrity or experimental-control fact.
 */
export const LAB_VALIDITY_GATES = {
  contract_closure: ["contract-schema-closure", "contract-version-closure"],
  lifecycle_integrity: ["lifecycle-chain-verified", "lifecycle-state-machine-respected"],
  acquisition_integrity: [
    "acquisition-preregistered-before-access",
    "acquired-bytes-frozen",
    "package-integrity-policy-applied",
  ],
  selection_integrity: ["selection-chain-closed", "selection-reveal-order-respected"],
  environment_control: ["environment-baseline-clean", "environment-not-contaminated"],
  evidence_completeness: [
    "evidence-cutoff-realized",
    "evidence-sources-accounted",
    // ADR-ERL2-033: passes wherever the attributable-telemetry observation was
    // never declared obtainable; refuses where it was declared and is missing,
    // not observed, not this run's, or unattributed.
    "attributable-telemetry-retained",
  ],
  adapter_compliance: ["adapter-certified", "adapter-authority-respected"],
  output_freeze: ["subject-output-frozen-before-reveal", "no-execution-after-output-freeze"],
  result_join: ["precleanup-result-join-closed"],
  cleanup: ["cleanup-verified", "restoration-verified", "teardown-verified"],
  trust_closure: [
    "exposure-state-recorded",
    "trust-policy-resolved",
    "timestamp-checkpoints-acyclic",
    "mandatory-graph-closed",
  ],
} as const;

const ALL_GATE_IDS: ReadonlySet<string> = new Set(Object.values(LAB_VALIDITY_GATES).flat());

/**
 * Gates a pre-environment terminal can meaningfully evaluate.
 *
 * `evidence-cutoff-realized`, the environment-control gates and the
 * selection-integrity gates are deliberately absent: the run ended before any
 * environment was provisioned or any challenge selected, so scoring them would
 * be asserting a control that was never exercised.
 */
export const PRE_ENVIRONMENT_GATE_IDS: readonly string[] = [
  ...LAB_VALIDITY_GATES.contract_closure,
  ...LAB_VALIDITY_GATES.lifecycle_integrity,
  ...LAB_VALIDITY_GATES.acquisition_integrity,
  "evidence-sources-accounted",
  ...LAB_VALIDITY_GATES.adapter_compliance,
  ...LAB_VALIDITY_GATES.output_freeze,
  ...LAB_VALIDITY_GATES.result_join,
  "cleanup-verified",
  "trust-policy-resolved",
  "timestamp-checkpoints-acyclic",
];

/** Gates an environment terminal must additionally evaluate. */
export const ENVIRONMENT_GATE_IDS: readonly string[] = [
  ...PRE_ENVIRONMENT_GATE_IDS,
  ...LAB_VALIDITY_GATES.selection_integrity,
  ...LAB_VALIDITY_GATES.environment_control,
  "evidence-cutoff-realized",
  // ADR-ERL2-033: evaluated on every environment terminal; vacuous where the
  // observation was never declared obtainable, so fake-driver runs are
  // untouched and the gate is still measured rather than skipped.
  "attributable-telemetry-retained",
  "restoration-verified",
  "teardown-verified",
  "exposure-state-recorded",
  "mandatory-graph-closed",
];

export interface GateResult {
  readonly gate_id: string;
  readonly passed: boolean;
  readonly evidence_refs: readonly Hash[];
}

/**
 * Refuses any gate identifier the Lab does not own.
 *
 * This is the executable statement of "validity may inspect only Lab-owned
 * integrity and experimental-control evidence": a gate named
 * `subject-claims-correct` has no catalogue entry and cannot be scored.
 */
export function assertGatesAreLabOwned(gates: readonly GateResult[]): void {
  for (const gate of gates) {
    if (!ALL_GATE_IDS.has(gate.gate_id)) {
      throw new Erl2Error(
        CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
        `validity gate ${gate.gate_id} is not a Lab-owned integrity or experimental-control gate`,
        { owner: "lab" },
      );
    }
  }
}

/** Every required gate must be present; a silently omitted gate is not a pass. */
export function assertRequiredGatesPresent(
  gates: readonly GateResult[],
  required: readonly string[],
): void {
  const present = new Set(gates.map((g) => g.gate_id));
  const missing = required.filter((id) => !present.has(id));
  if (missing.length > 0) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_MISSING_ROLE,
      `validity evaluation omitted required gate(s): ${missing.join(", ")}`,
      { owner: "lab" },
    );
  }
}

function statusOf(gates: readonly GateResult[]): "valid" | "invalid" {
  return gates.every((g) => g.passed) ? "valid" : "invalid";
}

/** The gates that did not pass, named so a refusal is actionable. */
export function failedGateIds(gates: readonly GateResult[]): readonly string[] {
  return gates.filter((g) => !g.passed).map((g) => g.gate_id);
}

export interface PreEnvironmentValidityInput {
  readonly runId: string;
  readonly terminalStage: "acquire" | "verify_package";
  readonly genericRunPolicyHash: Hash;
  readonly gates: readonly GateResult[];
  readonly preEnvironmentCleanupHash: Hash;
  readonly invalidityFindingHashes: readonly Hash[];
  readonly evaluatedAt: Instant;
}

export function buildPreEnvironmentValidity(
  input: PreEnvironmentValidityInput,
): PreEnvironmentValidityResultV1 {
  assertGatesAreLabOwned(input.gates);
  assertRequiredGatesPresent(input.gates, PRE_ENVIRONMENT_GATE_IDS);
  const status = statusOf(input.gates);
  if (status === "invalid" && input.invalidityFindingHashes.length === 0) {
    throw new Erl2Error(
      CODES.INVALID_REASON_FABRICATED_FINDING,
      `an invalid validity result must name the Lab invalidity finding for its failed gate(s): ${failedGateIds(input.gates).join(", ")}`,
      { owner: "lab" },
    );
  }
  const body = {
    schema_version: "pre-environment-validity-result/v1" as const,
    run_id: input.runId,
    terminal_stage: input.terminalStage,
    generic_run_policy_hash: input.genericRunPolicyHash,
    gate_results: input.gates.map((g) => ({
      gate_id: g.gate_id,
      passed: g.passed,
      evidence_refs: [...g.evidence_refs],
    })),
    pre_environment_cleanup_hash: input.preEnvironmentCleanupHash,
    status,
    invalidity_finding_hashes: [...input.invalidityFindingHashes],
    evaluated_at: input.evaluatedAt,
  };
  return assertContract<PreEnvironmentValidityResultV1>("PreEnvironmentValidityResultV1", {
    ...body,
    core_hash: coreHash(body),
  });
}

export interface EnvironmentValidityInput {
  readonly runId: string;
  readonly terminalStage: EnvironmentJourneyIntent;
  readonly genericRunPolicyHash: Hash;
  readonly gates: readonly GateResult[];
  readonly environmentRestorationHash: Hash;
  readonly teardownHash: Hash;
  readonly invalidityFindingHashes: readonly Hash[];
  readonly evaluatedAt: Instant;
}

export function buildEnvironmentValidity(
  input: EnvironmentValidityInput,
): EnvironmentValidityResultV1 {
  assertGatesAreLabOwned(input.gates);
  assertRequiredGatesPresent(input.gates, ENVIRONMENT_GATE_IDS);
  const status = statusOf(input.gates);
  if (status === "invalid" && input.invalidityFindingHashes.length === 0) {
    throw new Erl2Error(
      CODES.INVALID_REASON_FABRICATED_FINDING,
      `an invalid validity result must name the Lab invalidity finding for its failed gate(s): ${failedGateIds(input.gates).join(", ")}`,
      { owner: "lab" },
    );
  }
  const body = {
    schema_version: "environment-validity-result/v1" as const,
    run_id: input.runId,
    terminal_stage: input.terminalStage,
    generic_run_policy_hash: input.genericRunPolicyHash,
    gate_results: input.gates.map((g) => ({
      gate_id: g.gate_id,
      passed: g.passed,
      evidence_refs: [...g.evidence_refs],
    })),
    environment_restoration_hash: input.environmentRestorationHash,
    teardown_hash: input.teardownHash,
    status,
    invalidity_finding_hashes: [...input.invalidityFindingHashes],
    evaluated_at: input.evaluatedAt,
  };
  return assertContract<EnvironmentValidityResultV1>("EnvironmentValidityResultV1", {
    ...body,
    core_hash: coreHash(body),
  });
}

/**
 * Only `status="valid"` may reach `GenericEvaluationIndexV1`; `status="invalid"`
 * must freeze an invalid terminal record and stop before generic finalization
 * (design v2 §17, ERL2-AC-026).
 */
export function assertValidityAdmitsGenericIndex(validity: ValidityResultV1): void {
  if (validity.status !== "valid") {
    throw new Erl2Error(
      CODES.EVALUATOR_INVALID_VALIDITY_IN_GENERIC_INDEX,
      "a run whose validity is invalid freezes an invalid terminal record; it never enters the generic evaluation index",
      { owner: "lab" },
    );
  }
}
