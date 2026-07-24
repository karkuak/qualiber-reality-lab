/**
 * The closed finding union and its ownership rules (design v2 §17,
 * implementation plan §12.1 S6.1, ERL2-OPS-003, ERL2-AC-003).
 *
 * `FindingV1` is a JSON Schema `oneOf` discriminated by `kind`, and `owner`,
 * `category`, `subject_attribution_proven` and `scoreable_planes` are *literal
 * constants per branch*.  That is what makes ownership unforgeable: a finding
 * cannot change owner through an optional field, because no branch has an
 * optional field that names an owner.
 *
 * This module adds the runtime half the schema cannot express:
 *
 * - a subject finding may only be built when every committed attribution
 *   prerequisite from design v2 §17 actually holds;
 * - a Lab, dependency, adapter or evaluator failure has no constructor that
 *   could produce `owner:"subject"` at all;
 * - `subject_unsupported` is a retained subject-plane result, never a Lab
 *   invalidity and never a defect that removes an admitted case;
 * - an invalid run may not attest a subject defect even when diagnostic
 *   measurements exist.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type AdapterFailureV1,
  type DependencyFindingV1,
  type EvaluatorFailureV1,
  type FindingV1,
  type Hash,
  type InconclusiveFindingV1,
  type LabInvalidityV1,
  type SubjectFindingCategory,
  type SubjectFindingV1,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";

export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type ScoreablePlane = "journey" | "domain" | "deep";

interface FindingBaseInput {
  readonly findingId: string;
  readonly runId: string;
  readonly journeyStepId?: string;
  readonly severity: Severity;
  readonly proofRefs: readonly Hash[];
  readonly summary: string;
}

function base(input: FindingBaseInput): Record<string, unknown> {
  return {
    schema_version: "finding/v1" as const,
    finding_id: input.findingId,
    run_id: input.runId,
    ...(input.journeyStepId === undefined ? {} : { journey_step_id: input.journeyStepId }),
    severity: input.severity,
    proof_refs: [...input.proofRefs],
    // Safe summaries are bounded and never carry truth plaintext, a judge
    // canary or credential material; the oracle scanner checks the frozen
    // bytes, and the bound stops an adapter-authored string from becoming an
    // unbounded log.
    safe_summary: input.summary.slice(0, 1024),
  };
}

function seal<T>(contractName: string, body: Record<string, unknown>): T {
  return assertContract<T>(contractName, { ...body, core_hash: coreHash(body) });
}

// -- 1. subject findings and their attribution prerequisites -----------------

/**
 * The committed prerequisites design v2 §17 requires before any failure may be
 * attributed to the subject.  Every one is evidence the *Lab* owns; none of
 * them is a subject-supplied assertion.
 */
export interface AttributionPrerequisites {
  /** The environment or pre-environment baseline gate passed. */
  readonly baselineValid: boolean;
  /** The committed visible intent and its matching judge expectation were revealed. */
  readonly revealedJudgeExpectationHash: Hash | undefined;
  /** The adapter is certified and its host reported no protocol/projection fault. */
  readonly adapterFunctioning: boolean;
  /** The failure occurred inside the subject boundary or its declared contract. */
  readonly withinSubjectBoundary: boolean;
  /** Control or counterfactual runs that isolate the subject as the cause. */
  readonly counterfactualControlRefs: readonly Hash[];
  /** Unresolved Lab or external-dependency causes; attribution requires none. */
  readonly unresolvedLabOrDependencyCauses: readonly string[];
}

/**
 * Categories whose attribution does not require a revealed judge expectation,
 * because they are decided entirely by Lab-owned integrity evidence before any
 * reveal: the package either verified against the committed policy or it did
 * not.  Every other subject category needs the revealed expectation.
 */
const PRE_REVEAL_ATTRIBUTABLE: ReadonlySet<SubjectFindingCategory> = new Set<SubjectFindingCategory>([
  "subject_acquisition_failure",
  "subject_package_verification_failure",
  // Design v2 §17's proof requirement for `unsupported` is "admitted
  // challenge/input retained; explicit subject/adapter declaration or bounded
  // inability". It names no expectation, because unsupported is not a judgement
  // against one: it is the subject's own declaration, recorded as-is.
  "subject_unsupported",
]);

/**
 * Categories that are retained results rather than defects.  `subject_unsupported`
 * keeps the admitted case unchanged (ERL2-FR-005): it scores on no plane and it
 * is never Lab invalidity.
 */
const RETAINED_NOT_DEFECT: ReadonlySet<SubjectFindingCategory> = new Set<SubjectFindingCategory>([
  "subject_unsupported",
]);

export function assertAttributionProven(
  category: SubjectFindingCategory,
  prerequisites: AttributionPrerequisites,
): void {
  if (!prerequisites.baselineValid) {
    throw new Erl2Error(
      CODES.EVALUATOR_SUBJECT_ATTRIBUTION_UNPROVEN,
      `${category} cannot be attributed to the subject: the Lab baseline gate did not pass`,
      { owner: "lab" },
    );
  }
  if (!prerequisites.adapterFunctioning) {
    throw new Erl2Error(
      CODES.EVALUATOR_SUBJECT_ATTRIBUTION_UNPROVEN,
      `${category} cannot be attributed to the subject: the adapter did not function independently`,
      { owner: "adapter" },
    );
  }
  if (!prerequisites.withinSubjectBoundary) {
    throw new Erl2Error(
      CODES.EVALUATOR_SUBJECT_ATTRIBUTION_UNPROVEN,
      `${category} occurred outside the subject boundary and its declared contract`,
      { owner: "lab" },
    );
  }
  if (prerequisites.unresolvedLabOrDependencyCauses.length > 0) {
    throw new Erl2Error(
      CODES.EVALUATOR_SUBJECT_ATTRIBUTION_UNPROVEN,
      `${category} has unresolved non-subject causes: ${prerequisites.unresolvedLabOrDependencyCauses.join(", ")}`,
      { owner: "lab" },
    );
  }
  if (
    !PRE_REVEAL_ATTRIBUTABLE.has(category) &&
    prerequisites.revealedJudgeExpectationHash === undefined
  ) {
    throw new Erl2Error(
      CODES.EVALUATOR_SUBJECT_ATTRIBUTION_UNPROVEN,
      `${category} requires the matching revealed judge expectation before attribution`,
      { owner: "lab" },
    );
  }
}

export interface SubjectFindingInput extends FindingBaseInput {
  readonly category: SubjectFindingCategory;
  readonly prerequisites: AttributionPrerequisites;
  readonly scoreablePlanes: readonly ScoreablePlane[];
}

/**
 * Builds the one branch of the union that can carry `owner:"subject"`.
 *
 * `subject_attribution_proven` is a schema constant `true` on this branch, so a
 * caller cannot produce a subject finding with attribution left unproven; this
 * function refuses to build the object at all when a prerequisite is missing.
 */
export function buildSubjectFinding(input: SubjectFindingInput): SubjectFindingV1 {
  assertAttributionProven(input.category, input.prerequisites);

  // An unsupported result is retained on no plane: it is not a defect, so it
  // may not contribute to any score (ERL2-FR-005, ERL2-AC-005).
  if (RETAINED_NOT_DEFECT.has(input.category) && input.scoreablePlanes.length > 0) {
    throw new Erl2Error(
      CODES.EVALUATOR_UNSUPPORTED_RELABELLED,
      "an unsupported result is retained, not scored; it may not name a scoreable plane",
      { owner: "evaluator" },
    );
  }
  // The deep plane belongs to an optional post-base descendant. A generic
  // evaluation may never mark a finding deep-scoreable (design v2 §17).
  if (input.scoreablePlanes.includes("deep")) {
    throw new Erl2Error(
      CODES.DEEP_ANCESTRY_FIELD_IN_GENERIC_ARTIFACT,
      "generic evaluation cannot mark a finding scoreable on the deep plane",
      { owner: "evaluator" },
    );
  }

  return seal<SubjectFindingV1>("SubjectFindingV1", {
    ...base(input),
    kind: "subject_finding" as const,
    owner: "subject" as const,
    category: input.category,
    subject_attribution_proven: true as const,
    attribution_proof_hash: coreHash({
      algorithm: "erl2-attribution-proof/v1",
      baseline_valid: input.prerequisites.baselineValid,
      adapter_functioning: input.prerequisites.adapterFunctioning,
      within_subject_boundary: input.prerequisites.withinSubjectBoundary,
      revealed_judge_expectation_hash: input.prerequisites.revealedJudgeExpectationHash ?? null,
      counterfactual_control_refs: [...input.prerequisites.counterfactualControlRefs].sort(),
    }),
    counterfactual_control_refs: [...input.prerequisites.counterfactualControlRefs],
    scoreable_planes: [...input.scoreablePlanes],
  });
}

// -- 2. non-subject branches -------------------------------------------------

export interface DependencyFindingInput extends FindingBaseInput {
  readonly dependencyId: string;
  readonly dependencyHealthHash: Hash;
}

/** An independently controlled external service failed outside the subject. */
export function buildDependencyFinding(input: DependencyFindingInput): DependencyFindingV1 {
  return seal<DependencyFindingV1>("DependencyFindingV1", {
    ...base(input),
    kind: "dependency_failure" as const,
    owner: "external_dependency" as const,
    category: "external_dependency_failure" as const,
    dependency_id: input.dependencyId,
    dependency_health_hash: input.dependencyHealthHash,
    subject_attribution_proven: false as const,
    scoreable_planes: [] as const,
  });
}

export interface AdapterFailureInput extends FindingBaseInput {
  readonly category: "adapter_protocol_failure" | "adapter_projection_failure" | "adapter_mutation_violation";
  readonly adapterHash: Hash;
  readonly certificationReceiptHash: Hash;
}

/**
 * The subject did not author its adapter, so an adapter protocol, projection or
 * mutation fault is never a subject defect: this branch has no member that
 * could score on any plane.
 */
export function buildAdapterFailure(input: AdapterFailureInput): AdapterFailureV1 {
  return seal<AdapterFailureV1>("AdapterFailureV1", {
    ...base(input),
    kind: "adapter_failure" as const,
    owner: "adapter" as const,
    category: input.category,
    adapter_hash: input.adapterHash,
    certification_receipt_hash: input.certificationReceiptHash,
    subject_attribution_proven: false as const,
    scoreable_planes: [] as const,
  });
}

export interface EvaluatorFailureInput extends FindingBaseInput {
  readonly category: "evaluator_execution_failure" | "evaluation_pack_failure" | "evaluator_nondeterminism";
  readonly evaluatorOrPackHash: Hash;
}

/** The evaluator or a pack failed on identical frozen inputs; no semantic verdict follows. */
export function buildEvaluatorFailure(input: EvaluatorFailureInput): EvaluatorFailureV1 {
  return seal<EvaluatorFailureV1>("EvaluatorFailureV1", {
    ...base(input),
    kind: "evaluator_failure" as const,
    owner: "evaluator" as const,
    category: input.category,
    evaluator_or_pack_hash: input.evaluatorOrPackHash,
    subject_attribution_proven: false as const,
    scoreable_planes: [] as const,
  });
}

export type LabInvalidityCategory =
  | "lab_invalid"
  | "lab_provisioning_failure"
  | "lab_baseline_failure"
  | "lab_evidence_failure"
  | "lab_reveal_failure"
  | "lab_restoration_failure"
  | "lab_teardown_failure"
  | "lab_integrity_failure";

export interface LabInvalidityInput extends FindingBaseInput {
  readonly category: LabInvalidityCategory;
  readonly failedGateIds: readonly string[];
}

/** A failed Lab integrity or experimental-control gate. Never a subject defect. */
export function buildLabInvalidity(input: LabInvalidityInput): LabInvalidityV1 {
  return seal<LabInvalidityV1>("LabInvalidityV1", {
    ...base(input),
    kind: "lab_invalidity" as const,
    owner: "lab" as const,
    category: input.category,
    failed_gate_ids: [...input.failedGateIds],
    subject_attribution_proven: false as const,
    scoreable_planes: [] as const,
  });
}

export interface InconclusiveFindingInput extends FindingBaseInput {
  /** The exact evidence that was missing; an inconclusive result must name it. */
  readonly missingProofIds: readonly string[];
  readonly scoreablePlanes: readonly ScoreablePlane[];
}

/**
 * Evidence could not meet the attribution or truth ceiling.
 *
 * This is an honest outcome, not a defect and not Lab invalidity: it scores as
 * "inconclusive" on its declared planes and always names what was missing.
 */
export function buildInconclusiveFinding(input: InconclusiveFindingInput): InconclusiveFindingV1 {
  if (input.missingProofIds.length === 0) {
    throw new Erl2Error(
      CODES.EVALUATOR_UNDECLARED_REASON_CODE,
      "an inconclusive finding must name the missing source",
      { owner: "evaluator" },
    );
  }
  if (input.scoreablePlanes.includes("deep")) {
    throw new Erl2Error(
      CODES.DEEP_ANCESTRY_FIELD_IN_GENERIC_ARTIFACT,
      "generic evaluation cannot mark a finding scoreable on the deep plane",
      { owner: "evaluator" },
    );
  }
  return seal<InconclusiveFindingV1>("InconclusiveFindingV1", {
    ...base(input),
    kind: "inconclusive" as const,
    owner: "inconclusive" as const,
    category: "inconclusive" as const,
    missing_proof_ids: [...input.missingProofIds],
    subject_attribution_proven: false as const,
    scoreable_planes: [...input.scoreablePlanes],
  });
}

// -- 3. crossover guards -----------------------------------------------------

/** The one owner each `kind` may carry. A mismatch is a contradiction. */
const OWNER_BY_KIND: Readonly<Record<string, string>> = {
  subject_finding: "subject",
  dependency_failure: "external_dependency",
  adapter_failure: "adapter",
  evaluator_failure: "evaluator",
  lab_invalidity: "lab",
  inconclusive: "inconclusive",
};

/** Category prefixes each `kind` may carry. */
const CATEGORY_PREFIX_BY_KIND: Readonly<Record<string, string>> = {
  subject_finding: "subject_",
  dependency_failure: "external_dependency_",
  adapter_failure: "adapter_",
  evaluator_failure: "evaluat",
  lab_invalidity: "lab_",
  inconclusive: "inconclusive",
};

/**
 * Independently re-derives ownership from a frozen finding.
 *
 * The schema already refuses a contradictory combination, but the verifier and
 * the evaluator both re-check here so an artifact that reached the store by any
 * other route still cannot smuggle a relabelled owner.
 */
export function assertFindingOwnershipConsistent(finding: FindingV1): void {
  // The union's literal branches make several of these checks statically
  // unreachable, which is the point: the schema already refuses them.  Reading
  // the shared members through one widened view lets the *runtime* check run
  // anyway, for an artifact that reached the store without passing the
  // validator.
  const view = finding as {
    readonly kind: string;
    readonly owner: string;
    readonly category: string;
    readonly subject_attribution_proven: boolean;
    readonly scoreable_planes: readonly string[];
  };

  const expectedOwner = OWNER_BY_KIND[view.kind];
  if (expectedOwner === undefined || view.owner !== expectedOwner) {
    throw new Erl2Error(
      CODES.EVALUATOR_FINDING_OWNER_CONTRADICTION,
      `finding kind ${view.kind} cannot carry owner ${view.owner}`,
      { owner: "evaluator" },
    );
  }
  const prefix = CATEGORY_PREFIX_BY_KIND[view.kind] as string;
  if (!view.category.startsWith(prefix)) {
    throw new Erl2Error(
      CODES.EVALUATOR_FINDING_OWNER_CONTRADICTION,
      `finding kind ${view.kind} cannot carry category ${view.category}`,
      { owner: "evaluator" },
    );
  }
  if (view.kind !== "subject_finding" && view.subject_attribution_proven !== false) {
    throw new Erl2Error(
      CODES.EVALUATOR_FINDING_OWNER_CONTRADICTION,
      `a ${view.kind} cannot claim proven subject attribution`,
      { owner: "evaluator" },
    );
  }
  if (NON_SCOREABLE_KINDS.has(view.kind) && view.scoreable_planes.length !== 0) {
    throw new Erl2Error(
      CODES.EVALUATOR_FINDING_OWNER_CONTRADICTION,
      `a ${view.kind} scores on no plane; infrastructure failure is never subject quality`,
      { owner: "evaluator" },
    );
  }
  if (
    view.kind === "subject_finding" &&
    view.category === "subject_unsupported" &&
    view.scoreable_planes.length !== 0
  ) {
    throw new Erl2Error(
      CODES.EVALUATOR_UNSUPPORTED_RELABELLED,
      "unsupported is a retained result, not a scored defect",
      { owner: "evaluator" },
    );
  }
  if (view.scoreable_planes.includes("deep")) {
    throw new Erl2Error(
      CODES.DEEP_ANCESTRY_FIELD_IN_GENERIC_ARTIFACT,
      "a generic finding cannot be scoreable on the optional deep plane",
      { owner: "evaluator" },
    );
  }
}

/** Kinds whose branch fixes `scoreable_planes` to the empty array. */
const NON_SCOREABLE_KINDS: ReadonlySet<string> = new Set([
  "dependency_failure",
  "adapter_failure",
  "evaluator_failure",
  "lab_invalidity",
]);

/**
 * An invalid run retains its diagnostic measurements but attests nothing about
 * the subject (design v2 §17, ERL2-AC-026).
 */
export function assertInvalidRunAssertsNoSubjectDefect(findings: readonly FindingV1[]): void {
  const attested = findings.filter(
    (f) => f.kind === "subject_finding" && f.category !== "subject_unsupported",
  );
  if (attested.length > 0) {
    throw new Erl2Error(
      CODES.EVALUATOR_INVALID_RUN_CANNOT_ATTEST_SUBJECT,
      `an invalid run cannot attest subject defects (${attested.map((f) => f.finding_id).join(", ")}); frozen measurements remain diagnostic only`,
      { owner: "lab" },
    );
  }
}
