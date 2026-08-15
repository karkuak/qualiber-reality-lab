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
  type SubjectExecutionMode,
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
    // ADR-ERL2-038 R8, package 3: evaluated wherever the run declared the
    // observation obtainable, and **omitted** where it did not. It refuses where
    // it was declared and the retained ERL2-C-171 record is missing, historical,
    // absent, not this run's, or unattributed.
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
  // ADR-ERL2-038 R8, package 3: required of a run that declared the observation
  // obtainable, and omitted from the required set of one that did not — see
  // `requiredGateIds` and `assertAttributableTelemetryApplicability`.
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
 * `adapter-certified` is required only of a run that selected a real external
 * adapter (ADR-ERL2-036).
 *
 * A development fake-port run executes no adapter bytes, so there is nothing to
 * certify — and the honest representation of that is the same one this catalogue
 * already uses for the environment and selection gates on a run that reached
 * neither: the gate is **absent**, not passed. Requiring it would force a
 * boolean to answer a question about applicability, and the only value it could
 * take, `true`, reads as a certification claim over manifest-only evidence.
 * That is exactly what the independent review of the first LIVE-001 package
 * rejected.
 *
 * `adapter-authority-respected` stays required in both modes: it is a statement
 * about what the Lab let the subject seam do, which every run answers.
 */
export function requiredGateIds(
  base: readonly string[],
  options: {
    readonly externalAdapter: boolean;
    /**
     * Whether this run declared an attributable-telemetry observation
     * obtainable (ADR-ERL2-038 R8, package 3).
     *
     * Defaults to applicable, which is the safe direction: a caller that forgets
     * to answer gets a *stricter* required set, not a looser one. Only an
     * explicit `false` drops the gate, and
     * `assertAttributableTelemetryApplicability` then refuses the gate being
     * present at all — so "not applicable" cannot decay into "optional".
     */
    readonly attributableTelemetryApplicable?: boolean;
  },
): readonly string[] {
  const withoutCertification = options.externalAdapter
    ? base
    : base.filter((id) => id !== "adapter-certified");
  if (options.attributableTelemetryApplicable === false) {
    return withoutCertification.filter((id) => id !== "attributable-telemetry-retained");
  }
  return withoutCertification;
}

/**
 * The applicability rule for `adapter-certified`, enforced rather than assumed.
 *
 * Omitting the gate for a fake-port run is only safe if the *external* case
 * stays strictly required — otherwise "not applicable" quietly becomes
 * "optional", which is the same false-attestation shape in a new place. So this
 * refuses, for an external-adapter run:
 *
 *   - the gate being absent;
 *   - the gate appearing more than once;
 *   - the gate citing manifest-only evidence, or the manifest's bootstrap/prior
 *     receipt, instead of the **current** receipt the run was authorized on.
 *
 * And for a fake-port run it refuses the gate being present at all, so the old
 * `passed: true` convention cannot creep back in through a producer that keeps
 * emitting it.
 */
export function assertAdapterCertificationApplicability(
  gates: readonly GateResult[],
  options: {
    readonly subjectExecutionMode: SubjectExecutionMode;
    /** The current receipt the run froze, when it has one. */
    readonly currentReceiptHash?: Hash;
  },
): void {
  const found = gates.filter((g) => g.gate_id === "adapter-certified");
  if (options.subjectExecutionMode !== "external_adapter") {
    if (found.length > 0) {
      throw new Erl2Error(
        CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
        "a run that selected no external adapter must omit adapter-certified; certification " +
          "is not applicable, and a boolean cannot say so",
        { owner: "lab" },
      );
    }
    return;
  }
  if (found.length !== 1) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_MISSING_ROLE,
      `an external-adapter run must evaluate exactly one adapter-certified gate; found ${String(found.length)}`,
      { owner: "lab" },
    );
  }
  const gate = found[0] as GateResult;
  if (options.currentReceiptHash === undefined) return;
  if (!gate.evidence_refs.includes(options.currentReceiptHash)) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_MISSING_ROLE,
      "the adapter-certified gate does not cite the current certification receipt this run was " +
        "authorized on; a manifest hash, or the manifest's bootstrap/prior receipt, is not " +
        "certification evidence",
      { owner: "lab" },
    );
  }
}

/**
 * The applicability rule for `attributable-telemetry-retained`, enforced rather
 * than assumed (ADR-ERL2-038 R8, package 3).
 *
 * Until package 3 this gate was evaluated on every environment terminal and
 * *passed vacuously* wherever the observation was never declared obtainable. A
 * fake-driver run therefore published `attributable-telemetry-retained:
 * passed: true` — a boolean answering a question about applicability, which is
 * the same false-attestation shape `assertAdapterCertificationApplicability`
 * already rejects one gate over. A reader cannot tell "this run's trusted
 * telemetry was verified" from "this run could never have had any", and only
 * one of those is a statement about evidence.
 *
 * So the gate is now *omitted* where telemetry is inapplicable, and this makes
 * the omission safe by refusing the two ways it could rot:
 *
 *   - for an **applicable** run, the gate being absent or appearing more than
 *     once — otherwise a producer could drop the gate to avoid failing it,
 *     which is precisely the failure mode `assertRequiredGatesPresent` exists
 *     for and which the applicability filter would otherwise punch a hole in;
 *   - for an **inapplicable** run, the gate being present at all — so the old
 *     `passed: true` convention cannot creep back through a producer that keeps
 *     emitting it.
 *
 * Applicability is *not* a function of the observation's outcome. It is the
 * declaration predicate of ADR-ERL2-033 — a compose driver, an archetype
 * declaring a metric evidence source, and a succeeded exercising step — every
 * conjunct of which the offline verifier recomputes from retained bytes in
 * `deriveAttributableTelemetry`. A run cannot become inapplicable by failing to
 * observe, because nothing the channel reports is an input here.
 */
export function assertAttributableTelemetryApplicability(
  gates: readonly GateResult[],
  options: { readonly applicable: boolean },
): void {
  const found = gates.filter((g) => g.gate_id === "attributable-telemetry-retained");
  if (!options.applicable) {
    if (found.length > 0) {
      throw new Erl2Error(
        CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,
        "a run that never declared an attributable-telemetry observation obtainable must omit " +
          "attributable-telemetry-retained; the observation is not applicable, and a boolean cannot say so",
        { owner: "lab" },
      );
    }
    return;
  }
  if (found.length !== 1) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_MISSING_ROLE,
      `a run declaring an obtainable attributable-telemetry observation must evaluate exactly one ` +
        `attributable-telemetry-retained gate; found ${String(found.length)}`,
      { owner: "lab" },
    );
  }
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
  /** Decides whether `adapter-certified` is applicable at all. */
  readonly subjectExecutionMode: SubjectExecutionMode;
  /** The current receipt an external run was authorized on, if it has one. */
  readonly adapterCertificationReceiptHash?: Hash;
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
  assertRequiredGatesPresent(
    input.gates,
    requiredGateIds(PRE_ENVIRONMENT_GATE_IDS, {
      externalAdapter: input.subjectExecutionMode === "external_adapter",
    }),
  );
  assertAdapterCertificationApplicability(input.gates, {
    subjectExecutionMode: input.subjectExecutionMode,
    ...(input.adapterCertificationReceiptHash === undefined
      ? {}
      : { currentReceiptHash: input.adapterCertificationReceiptHash }),
  });
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
  /** Decides whether `adapter-certified` is applicable at all. */
  readonly subjectExecutionMode: SubjectExecutionMode;
  /** The current receipt an external run was authorized on, if it has one. */
  readonly adapterCertificationReceiptHash?: Hash;
  readonly terminalStage: EnvironmentJourneyIntent;
  /**
   * Whether this run declared an attributable-telemetry observation obtainable.
   *
   * Required rather than optional: the whole point of omitting the gate is that
   * a reader can tell "not applicable" from "passed", and a defaulted flag
   * would let a producer reach the lenient answer by silence.
   */
  readonly attributableTelemetryApplicable: boolean;
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
  assertRequiredGatesPresent(
    input.gates,
    requiredGateIds(ENVIRONMENT_GATE_IDS, {
      externalAdapter: input.subjectExecutionMode === "external_adapter",
      attributableTelemetryApplicable: input.attributableTelemetryApplicable,
    }),
  );
  assertAttributableTelemetryApplicability(input.gates, {
    applicable: input.attributableTelemetryApplicable,
  });
  assertAdapterCertificationApplicability(input.gates, {
    subjectExecutionMode: input.subjectExecutionMode,
    ...(input.adapterCertificationReceiptHash === undefined
      ? {}
      : { currentReceiptHash: input.adapterCertificationReceiptHash }),
  });
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
