/**
 * Generic domain evaluation (design v2 §17, implementation plan §12.1 S6.4).
 *
 * Exactly one of `DomainResultEvaluatedV1` or `DomainResultNotApplicableV1`
 * freezes per run.  An *evaluated* result requires every design-mandated
 * ancestor — frozen observation, frozen canonical evidence envelope, frozen
 * subject output and a permitted truth reveal — because a functional claim
 * cannot be scored against evidence that does not exist.
 *
 * The not-applicable branch is the honest outcome for a failed acquisition or
 * package verification, a failed setup or connection, missing evidence, and an
 * invalid run.  It carries the exact reason and the journey result it follows;
 * it never invents a functional score.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type DomainResultEvaluatedV1,
  type DomainResultNotApplicableV1,
  type EvaluationPackBodyV1,
  type EvaluationPackCertificationReceiptV1,
  type EvaluationPackManifestV1,
  type FindingV1,
  type Hash,
  type Instant,
  type JourneyIntent,
  type MetricDefinitionV1,
  type MetricResultV1,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";
import {
  evaluateMetric,
  evaluatePredicate,
  type EvaluationClaim,
  type EvaluationEnvelopeIndex,
  type EvaluationSource,
  type EvaluationTruthFact,
  type MetricInputs,
} from "./metrics.js";
import { buildInconclusiveFinding, buildSubjectFinding, type AttributionPrerequisites } from "./findings.js";
import { assertReferencedMetricsAreGeneric } from "./genericMetrics.js";

// -- 1. binding a certified pack ---------------------------------------------

export interface BoundDomainPack {
  readonly manifest: EvaluationPackManifestV1;
  readonly body: EvaluationPackBodyV1;
  readonly metricDefinitions: readonly MetricDefinitionV1[];
}

/**
 * Admits a pack for use in a run.
 *
 * The certification receipt is checked, the body digest must match the manifest,
 * the pack may not redefine a Lab-owned metric, and — the structural point — the
 * pack is only ever read as closed contract data.  There is no code path here
 * that could give a pack filesystem, network, process, clock, randomness,
 * mutation, threshold or validity authority, because the contract has no member
 * of any of those shapes.
 */
export function bindDomainPack(input: {
  readonly manifest: EvaluationPackManifestV1;
  readonly body: EvaluationPackBodyV1;
  readonly certification: EvaluationPackCertificationReceiptV1;
  readonly metricDefinitions: readonly MetricDefinitionV1[];
}): BoundDomainPack {
  const { manifest, body, certification } = input;
  if (!certification.passed) {
    throw new Erl2Error(
      CODES.PACK_NOT_CERTIFIED,
      `pack ${manifest.pack_id} has no passing certification receipt`,
      { owner: "evaluator" },
    );
  }
  if (certification.pack_artifact_hash !== body.core_hash) {
    throw new Erl2Error(
      CODES.PACK_NOT_CERTIFIED,
      "the certification receipt does not describe this pack body",
      { owner: "evaluator" },
    );
  }
  if (manifest.pack_artifact_hash !== body.core_hash) {
    throw new Erl2Error(
      CODES.PACK_NOT_CERTIFIED,
      "the pack manifest names a different pack body",
      { owner: "evaluator" },
    );
  }
  if (manifest.certification_receipt_hash !== certification.core_hash) {
    throw new Erl2Error(
      CODES.PACK_NOT_CERTIFIED,
      "the pack manifest names a different certification receipt",
      { owner: "evaluator" },
    );
  }
  if (manifest.scope === "domain" && (body.subject_id !== undefined || manifest.subject_id !== undefined)) {
    throw new Erl2Error(
      CODES.PACK_SUBJECT_VOCABULARY_IN_DOMAIN_SCOPE,
      "a subject-neutral domain pack cannot bind a subject identity",
      { owner: "evaluator" },
    );
  }
  assertReferencedMetricsAreGeneric(input.metricDefinitions);

  const declared = new Set(input.metricDefinitions.map((m) => m.core_hash));
  for (const hash of manifest.metric_definitions) {
    if (!declared.has(hash)) {
      throw new Erl2Error(
        CODES.PACK_UNKNOWN_METRIC_ID,
        "the pack manifest names a metric definition that was not supplied",
        { owner: "evaluator" },
      );
    }
  }
  const byId = new Map(input.metricDefinitions.map((m) => [m.metric_id, m]));
  for (const metricId of body.metric_ids) {
    if (!byId.has(metricId)) {
      throw new Erl2Error(
        CODES.PACK_UNKNOWN_METRIC_ID,
        `the pack references metric ${metricId}, which the Lab does not define`,
        { owner: "evaluator" },
      );
    }
  }
  return { manifest, body, metricDefinitions: input.metricDefinitions };
}

// -- 2. the evaluated branch -------------------------------------------------

/**
 * Every ancestor an evaluated domain result requires.  A missing one is not a
 * subject defect: it routes to the not-applicable branch.
 */
export interface DomainAncestors {
  readonly observationBundleHash: Hash | undefined;
  readonly canonicalEvidenceEnvelopeHash: Hash | undefined;
  readonly subjectOutputHash: Hash | undefined;
  readonly truthRevealHash: Hash | undefined;
  readonly claimSetHash: Hash | undefined;
}

export interface DomainEvidence {
  readonly claims: readonly EvaluationClaim[];
  readonly requiredTruthFacts: readonly EvaluationTruthFact[];
  readonly evidenceSources: readonly EvaluationSource[];
  readonly envelope: EvaluationEnvelopeIndex;
  readonly credentialCanaries: readonly string[];
  readonly authorityCeiling: "none" | "advisory" | "human_approval_required" | "external_authority_required";
  /** True when abstaining was the correct answer for this challenge. */
  readonly correctAbstentionApplies: boolean;
}

export interface EvaluateDomainInput {
  readonly runId: string;
  readonly genericRunPolicyHash: Hash;
  readonly pack: BoundDomainPack;
  readonly ancestors: DomainAncestors;
  readonly evidence: DomainEvidence;
  readonly attribution: AttributionPrerequisites;
  readonly evaluatedAt: Instant;
}

export interface EvaluateDomainOutput {
  readonly result: DomainResultEvaluatedV1;
  readonly metricResults: readonly MetricResultV1[];
  readonly findings: readonly FindingV1[];
}

/** Which ancestors are missing, in declaration order. */
export function missingDomainAncestors(ancestors: DomainAncestors): readonly string[] {
  const missing: string[] = [];
  if (ancestors.observationBundleHash === undefined) missing.push("observation-bundle");
  if (ancestors.canonicalEvidenceEnvelopeHash === undefined) missing.push("canonical-evidence-envelope");
  if (ancestors.subjectOutputHash === undefined) missing.push("subject-output-manifest");
  if (ancestors.truthRevealHash === undefined) missing.push("truth-reveal");
  return missing;
}

/**
 * Evaluates the generic domain plane.
 *
 * The evaluator applies only the pack's declared assertions and the Lab-owned
 * metrics the pack references.  It infers no product semantics: every predicate
 * is a set-membership or exact-triple test over frozen evidence.
 */
export function evaluateDomain(input: EvaluateDomainInput): EvaluateDomainOutput {
  const missing = missingDomainAncestors(input.ancestors);
  if (missing.length > 0) {
    throw new Erl2Error(
      CODES.EVALUATOR_DOMAIN_EVIDENCE_UNAVAILABLE,
      `an evaluated domain result requires ${missing.join(", ")}; use the not-applicable branch instead`,
      { owner: "lab" },
    );
  }

  const inputs: MetricInputs = {
    claims: input.evidence.claims,
    requiredTruthFacts: input.evidence.requiredTruthFacts,
    evidenceSources: input.evidence.evidenceSources,
    stepOutcomes: [],
    declaredMutations: [],
    envelope: input.evidence.envelope,
    credentialCanaries: [...input.evidence.credentialCanaries],
    authorityCeiling: input.evidence.authorityCeiling,
  };

  const byId = new Map(input.pack.metricDefinitions.map((m) => [m.metric_id, m]));
  const metricResults = [...input.pack.body.metric_ids]
    .sort((a, b) => a.localeCompare(b))
    .map((metricId) =>
      evaluateMetric({
        definition: byId.get(metricId) as MetricDefinitionV1,
        runId: input.runId,
        plane: "domain",
        inputs,
        evaluatedAt: input.evaluatedAt,
        correctAbstentionApplies: input.evidence.correctAbstentionApplies,
      }),
    );

  // 2.1 assertions produce findings on the subject plane only, in the pack's
  //     declared deterministic order.
  const assertions =
    input.pack.body.output_ordering === "assertion_id_ascending"
      ? [...input.pack.body.assertions].sort((a, b) => a.assertion_id.localeCompare(b.assertion_id))
      : [...input.pack.body.assertions];

  const findings: FindingV1[] = [];
  for (const assertion of assertions) {
    const violating = violatingClaimIds(assertion, inputs);
    if (violating.length === 0) continue;
    findings.push(
      buildSubjectFinding({
        findingId: `domain-${assertion.assertion_id}`,
        runId: input.runId,
        severity: assertion.severity,
        proofRefs: [input.ancestors.canonicalEvidenceEnvelopeHash as Hash],
        summary: `${assertion.reason_code}: ${String(violating.length)} claim(s) violate ${assertion.assertion_id}`,
        category: assertion.finding_category,
        prerequisites: input.attribution,
        scoreablePlanes: assertion.finding_category === "subject_unsupported" ? [] : ["domain"],
      }),
    );
  }

  // 2.2 a metric whose declared input was missing is inconclusive, and the
  //     inconclusive finding names the missing selector rather than blaming the
  //     subject.
  for (const metric of metricResults) {
    if (metric.status !== "inconclusive") continue;
    findings.push(
      buildInconclusiveFinding({
        findingId: `domain-inconclusive-${metric.metric_id}`,
        runId: input.runId,
        severity: "info",
        proofRefs: [metric.core_hash],
        summary: `metric ${metric.metric_id} could not be evaluated on the available evidence`,
        missingProofIds: [...(metric.missing_input_selectors ?? [])],
        scoreablePlanes: ["domain"],
      }),
    );
  }

  const anyInconclusive = metricResults.some((m) => m.status === "inconclusive");
  const anyMeasured = metricResults.some((m) => m.status === "measured");
  const status: "evaluated" | "unsupported" | "inconclusive" = anyMeasured
    ? anyInconclusive
      ? "inconclusive"
      : "evaluated"
    : "inconclusive";

  const body = {
    schema_version: "domain-result-evaluated/v1" as const,
    run_id: input.runId,
    generic_run_policy_hash: input.genericRunPolicyHash,
    domain_pack_hashes: [input.pack.manifest.core_hash],
    observation_bundle_hash: input.ancestors.observationBundleHash as Hash,
    canonical_evidence_envelope_hash: input.ancestors.canonicalEvidenceEnvelopeHash as Hash,
    subject_output_hash: input.ancestors.subjectOutputHash as Hash,
    ...(input.ancestors.claimSetHash === undefined
      ? {}
      : { claim_set_hash: input.ancestors.claimSetHash }),
    truth_reveal_hash: input.ancestors.truthRevealHash as Hash,
    metric_result_hashes: metricResults.map((m) => m.core_hash),
    finding_hashes: findings.map((f) => f.core_hash),
    status,
    recorded_at: input.evaluatedAt,
  };
  return {
    result: assertContract<DomainResultEvaluatedV1>("DomainResultEvaluatedV1", {
      ...body,
      core_hash: coreHash(body),
    }),
    metricResults,
    findings,
  };
}

function violatingClaimIds(
  assertion: EvaluationPackBodyV1["assertions"][number],
  inputs: MetricInputs,
): readonly string[] {
  const claims = inputs.claims ?? [];
  const sources = inputs.evidenceSources ?? [];
  const context = {
    inputs,
    ...(assertion.predicate_argument === undefined
      ? { argument: undefined }
      : { argument: assertion.predicate_argument }),
  };
  const violating: string[] = [];
  // Source-scoped predicates iterate sources; every other predicate iterates
  // claims. There is no third shape, because the vocabulary is closed.
  if (assertion.predicate === "unavailable_source_explicitly_disclosed") {
    for (const source of sources) {
      if (source.state === "complete" || source.state === "healthy_empty") continue;
      const held = evaluatePredicate(assertion.predicate, { kind: "source", value: source } as never, context);
      if (assertion.polarity === "must_hold" ? !held : held) violating.push(source.source_id);
    }
    return violating.sort();
  }
  for (const claim of claims) {
    if (!claimIsInScope(assertion, claim)) continue;
    const held = evaluatePredicate(assertion.predicate, { kind: "claim", value: claim } as never, context);
    if (assertion.polarity === "must_hold" ? !held : held) violating.push(claim.claim_id);
  }
  return violating.sort();
}

/** Restricts an assertion to the claim category its predicate is about. */
function claimIsInScope(
  assertion: EvaluationPackBodyV1["assertions"][number],
  claim: EvaluationClaim,
): boolean {
  switch (assertion.predicate) {
    case "citation_resolves_in_canonical_envelope":
    case "citation_locator_reachable":
      return claim.citations.length > 0;
    case "causal_claim_has_declared_supporting_association":
      return claim.category === "causal";
    case "unknown_claim_matches_unrevealed_truth_gap":
      return claim.category === "unknown";
    case "claim_authority_within_declared_ceiling":
      return claim.category === "action" || claim.category === "decision";
    default:
      return true;
  }
}

// -- 3. the not-applicable branch --------------------------------------------

export type NotApplicableReason =
  | "pre_environment_terminal"
  | "setup_terminal"
  | "connection_terminal"
  | "functional_evidence_unavailable";

/** The one reason each terminal stage may carry. */
const REASON_FOR_STAGE: Readonly<Record<string, NotApplicableReason>> = {
  acquire: "pre_environment_terminal",
  verify_package: "pre_environment_terminal",
  install: "setup_terminal",
  configure: "setup_terminal",
  authenticate: "setup_terminal",
  connect: "connection_terminal",
};

/**
 * Freezes the not-applicable domain result.
 *
 * The reason must match the terminal stage: a `connect` terminal cannot claim
 * `pre_environment_terminal`, and a pre-environment terminal cannot claim
 * `connection_terminal`.  Anything past connection that still has no functional
 * evidence uses `functional_evidence_unavailable`.
 */
export function buildDomainNotApplicable(input: {
  readonly runId: string;
  readonly genericRunPolicyHash: Hash;
  readonly terminalStage: JourneyIntent;
  readonly reason: NotApplicableReason;
  readonly journeyResultHash: Hash;
  readonly findingHashes: readonly Hash[];
  readonly recordedAt: Instant;
}): DomainResultNotApplicableV1 {
  const expected = REASON_FOR_STAGE[input.terminalStage];
  if (expected === undefined) {
    if (input.reason !== "functional_evidence_unavailable") {
      throw new Erl2Error(
        CODES.EVALUATOR_NOT_APPLICABLE_REASON_MISMATCH,
        `terminal stage ${input.terminalStage} may only report functional_evidence_unavailable, not ${input.reason}`,
        { owner: "evaluator" },
      );
    }
  } else if (input.reason !== expected && input.reason !== "functional_evidence_unavailable") {
    throw new Erl2Error(
      CODES.EVALUATOR_NOT_APPLICABLE_REASON_MISMATCH,
      `terminal stage ${input.terminalStage} derives reason ${expected}, not ${input.reason}`,
      { owner: "evaluator" },
    );
  }
  const body = {
    schema_version: "domain-result-not-applicable/v1" as const,
    run_id: input.runId,
    generic_run_policy_hash: input.genericRunPolicyHash,
    terminal_stage: input.terminalStage,
    reason: input.reason,
    journey_result_hash: input.journeyResultHash,
    finding_hashes: [...input.findingHashes],
    status: "not_applicable" as const,
    recorded_at: input.recordedAt,
  };
  return assertContract<DomainResultNotApplicableV1>("DomainResultNotApplicableV1", {
    ...body,
    core_hash: coreHash(body),
  });
}
