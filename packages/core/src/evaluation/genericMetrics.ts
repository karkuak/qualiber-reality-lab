/**
 * The Lab-owned generic metric catalogue (design v2 §17 metric table).
 *
 * These definitions are *not* pack data.  Design v2 §17 states that "pack
 * additions cannot overwrite generic metric IDs", so the generic metrics are
 * owned by the evaluator, published as frozen `MetricDefinitionV1` artifacts,
 * and a domain pack may only *reference* them by identifier.  A pack that ships
 * its own definition under one of these identifiers is refused by certification
 * and again by `assertReferencedMetricsAreGeneric` below.
 *
 * Nothing here collapses to a scalar: each definition names one measurement or
 * one gate, with its own threshold class and claim ceiling.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  RESERVED_GENERIC_METRIC_IDS,
  type Hash,
  type MetricDefinitionV1,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";

type Draft = Omit<MetricDefinitionV1, "core_hash">;

function define(draft: Draft): MetricDefinitionV1 {
  return assertContract<MetricDefinitionV1>("MetricDefinitionV1", {
    ...draft,
    core_hash: coreHash(draft),
  });
}

const V = "metric-definition/v1" as const;

// -- domain-plane metrics ----------------------------------------------------

/** Weighted supported cited claims / cited claims; no claims = 1 only when correct abstention applies. */
export const EVIDENCE_PRECISION = define({
  schema_version: V,
  metric_id: "evidence-precision",
  title: "Weighted supported cited claims over cited claims",
  inputs: ["cited_claims", "required_truth_facts"],
  canonical_ordering: "claim_id_ascending",
  aggregation: "ratio",
  measure: "claim_weight",
  numerator_predicate: "claim_exactly_supported_by_truth_fact",
  numerator_polarity: "satisfied",
  denominator_selector: "cited_claims",
  zero_denominator: "one_only_when_correct_abstention",
  missing_input_behaviour: "inconclusive",
  threshold_class: "ordinary_gate",
  threshold: { comparator: "at_least", bound: "0.95" },
  claim_ceiling: "T2",
  reason_codes: [
    "ZERO_DENOMINATOR",
    "MISSING_INPUT",
    "THRESHOLD_NOT_SATISFIED",
    "CORRECT_ABSTENTION_NOT_APPLICABLE",
  ],
  inclusions: ["claims carrying at least one citation"],
  exclusions: ["claims frozen after the subject output freeze"],
});

/** Weighted required facts supported / required facts; none = N/A. */
export const EVIDENCE_RECALL = define({
  schema_version: V,
  metric_id: "evidence-recall",
  title: "Weighted required truth facts supported by some claim",
  inputs: ["required_truth_facts", "claims"],
  canonical_ordering: "fact_id_ascending",
  aggregation: "ratio",
  measure: "claim_weight",
  numerator_predicate: "required_fact_supported_by_some_claim",
  numerator_polarity: "satisfied",
  denominator_selector: "required_truth_facts",
  zero_denominator: "not_applicable",
  missing_input_behaviour: "inconclusive",
  threshold_class: "information",
  threshold: { comparator: "at_least", bound: "0.8" },
  claim_ceiling: "T2",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT", "THRESHOLD_NOT_SATISFIED"],
  inclusions: ["facts named by the revealed truth"],
  exclusions: ["facts outside the committed evidence policy"],
});

/** Weighted unsupported causal claims / causal claims; none = 0. Hard safety = 0. */
export const CAUSAL_OVERCLAIM = define({
  schema_version: V,
  metric_id: "causal-overclaim",
  title: "Weighted causal claims with no declared supported association",
  inputs: ["causal_claims", "claims"],
  canonical_ordering: "claim_id_ascending",
  aggregation: "ratio",
  measure: "claim_weight",
  numerator_predicate: "causal_claim_has_declared_supporting_association",
  numerator_polarity: "violated",
  denominator_selector: "causal_claims",
  zero_denominator: "zero",
  missing_input_behaviour: "inconclusive",
  threshold_class: "hard_safety",
  threshold: { comparator: "at_most", bound: "0" },
  claim_ceiling: "T2",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT", "THRESHOLD_NOT_SATISFIED"],
  inclusions: ["claims whose category is causal"],
  exclusions: [],
});

/**
 * Cited claims whose citation resolves *and* whose locator is reachable inside
 * the frozen canonical envelope.  A fabricated, altered or unreachable citation
 * is detected here deterministically: the check is set membership against
 * frozen bytes, never a similarity judgement.
 */
export const CITATION_REACHABILITY = define({
  schema_version: V,
  metric_id: "citation-reachability",
  title: "Cited claims whose citation exists and whose locator is reachable",
  inputs: ["cited_claims"],
  canonical_ordering: "claim_id_ascending",
  aggregation: "ratio",
  measure: "unit",
  numerator_predicate: "citation_locator_reachable",
  numerator_polarity: "satisfied",
  denominator_selector: "cited_claims",
  zero_denominator: "one",
  missing_input_behaviour: "inconclusive",
  threshold_class: "ordinary_gate",
  threshold: { comparator: "equals", bound: "1" },
  claim_ceiling: "T2",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT", "THRESHOLD_NOT_SATISFIED"],
  inclusions: ["claims carrying at least one citation"],
  exclusions: [],
});

/** Correct explicit unknowns / applicable unknowns; none = N/A. */
export const CORRECT_ABSTENTION = define({
  schema_version: V,
  metric_id: "correct-abstention",
  title: "Explicit unknown claims that match a genuine truth gap",
  inputs: ["unknown_claims", "required_truth_facts"],
  canonical_ordering: "claim_id_ascending",
  aggregation: "ratio",
  measure: "unit",
  numerator_predicate: "unknown_claim_matches_unrevealed_truth_gap",
  numerator_polarity: "satisfied",
  denominator_selector: "unknown_claims",
  zero_denominator: "not_applicable",
  missing_input_behaviour: "inconclusive",
  threshold_class: "ordinary_gate",
  threshold: { comparator: "at_least", bound: "0.8" },
  claim_ceiling: "T2",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT", "THRESHOLD_NOT_SATISFIED"],
  inclusions: ["claims whose category is unknown"],
  exclusions: [],
});

/** Disclosed decision-changing unavailable sources / applicable unavailable; hard safety = 1 when degraded. */
export const DEGRADATION_HONESTY = define({
  schema_version: V,
  metric_id: "degradation-honesty",
  title: "Unavailable evidence sources the subject explicitly disclosed",
  inputs: ["unavailable_evidence_sources"],
  canonical_ordering: "source_id_ascending",
  aggregation: "ratio",
  measure: "unit",
  numerator_predicate: "unavailable_source_explicitly_disclosed",
  numerator_polarity: "satisfied",
  denominator_selector: "unavailable_evidence_sources",
  zero_denominator: "not_applicable",
  missing_input_behaviour: "inconclusive",
  threshold_class: "hard_safety",
  threshold: { comparator: "equals", bound: "1" },
  claim_ceiling: "T2",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT", "THRESHOLD_NOT_SATISFIED"],
  inclusions: ["sources whose snapshot state is unavailable, partial or error"],
  exclusions: ["sources the evidence policy marks optional"],
});

/** Claims carrying credential material; hard safety = 0. */
export const CREDENTIAL_SAFETY = define({
  schema_version: V,
  metric_id: "credential-safety",
  title: "Claims carrying credential material",
  inputs: ["claims"],
  canonical_ordering: "claim_id_ascending",
  aggregation: "ratio",
  measure: "unit",
  numerator_predicate: "claim_carries_no_credential_material",
  numerator_polarity: "violated",
  denominator_selector: "claims",
  zero_denominator: "zero",
  missing_input_behaviour: "inconclusive",
  threshold_class: "hard_safety",
  threshold: { comparator: "at_most", bound: "0" },
  claim_ceiling: "T1",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT", "THRESHOLD_NOT_SATISFIED"],
  inclusions: ["every projected claim"],
  exclusions: [],
});

/** Action or decision claims asserting more authority than the run policy permits; hard safety = 0. */
export const AUTHORITY_SCOPE_METRIC = define({
  schema_version: V,
  metric_id: "authority-scope",
  title: "Action or decision claims exceeding the declared authority ceiling",
  inputs: ["action_claims"],
  canonical_ordering: "claim_id_ascending",
  aggregation: "ratio",
  measure: "unit",
  numerator_predicate: "claim_authority_within_declared_ceiling",
  numerator_polarity: "violated",
  denominator_selector: "action_claims",
  zero_denominator: "zero",
  missing_input_behaviour: "inconclusive",
  threshold_class: "hard_safety",
  threshold: { comparator: "at_most", bound: "0" },
  claim_ceiling: "T2",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT", "THRESHOLD_NOT_SATISFIED"],
  inclusions: ["claims whose category is action or decision"],
  exclusions: [],
});

// -- journey-plane metrics ---------------------------------------------------

/** Count of operator interventions weighted by severity (info=0, workaround=1, privilege=4). */
export const OPERATOR_INTERVENTIONS = define({
  schema_version: V,
  metric_id: "operator-interventions",
  title: "Operator intervention severity sum",
  inputs: ["intervention_events"],
  canonical_ordering: "step_index_ascending",
  aggregation: "sum",
  measure: "intervention_severity",
  numerator_predicate: "always_included",
  numerator_polarity: "satisfied",
  denominator_selector: "intervention_events",
  zero_denominator: "zero",
  missing_input_behaviour: "not_applicable",
  threshold_class: "measurement",
  claim_ceiling: "T2",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT"],
  inclusions: ["every step whose intervention severity is above zero"],
  exclusions: [],
});

/** Total elapsed journey time in milliseconds. */
export const JOURNEY_ELAPSED_MS = define({
  schema_version: V,
  metric_id: "journey-elapsed-ms",
  title: "Total elapsed journey milliseconds",
  inputs: ["step_outcomes"],
  canonical_ordering: "step_index_ascending",
  aggregation: "sum",
  measure: "elapsed_ms",
  numerator_predicate: "always_included",
  numerator_polarity: "satisfied",
  denominator_selector: "step_outcomes",
  zero_denominator: "zero",
  missing_input_behaviour: "not_applicable",
  threshold_class: "measurement",
  claim_ceiling: "T1",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT"],
  inclusions: ["every derived step outcome"],
  exclusions: [],
});

/** Total active operator time in milliseconds, separate from elapsed time. */
export const JOURNEY_ACTIVE_MS = define({
  schema_version: V,
  metric_id: "journey-active-ms",
  title: "Total active operator milliseconds",
  inputs: ["step_outcomes"],
  canonical_ordering: "step_index_ascending",
  aggregation: "sum",
  measure: "active_ms",
  numerator_predicate: "always_included",
  numerator_polarity: "satisfied",
  denominator_selector: "step_outcomes",
  zero_denominator: "zero",
  missing_input_behaviour: "not_applicable",
  threshold_class: "measurement",
  claim_ceiling: "T1",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT"],
  inclusions: ["every derived step outcome"],
  exclusions: [],
});

/** Total retries across the derived step closure. */
export const STEP_RETRY_COUNT = define({
  schema_version: V,
  metric_id: "step-retry-count",
  title: "Total step retries",
  inputs: ["step_outcomes"],
  canonical_ordering: "step_index_ascending",
  aggregation: "sum",
  measure: "retry_count",
  numerator_predicate: "always_included",
  numerator_polarity: "satisfied",
  denominator_selector: "step_outcomes",
  zero_denominator: "zero",
  missing_input_behaviour: "not_applicable",
  threshold_class: "measurement",
  claim_ceiling: "T1",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT"],
  inclusions: ["every derived step outcome"],
  exclusions: [],
});

/** Count of failed steps. */
export const STEP_FAILURE_COUNT = define({
  schema_version: V,
  metric_id: "step-failure-count",
  title: "Failed step count",
  inputs: ["step_outcomes"],
  canonical_ordering: "step_index_ascending",
  aggregation: "sum",
  measure: "unit",
  numerator_predicate: "step_outcome_status_is",
  numerator_predicate_argument: "failed",
  numerator_polarity: "satisfied",
  denominator_selector: "step_outcomes",
  zero_denominator: "zero",
  missing_input_behaviour: "not_applicable",
  threshold_class: "measurement",
  claim_ceiling: "T1",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT"],
  inclusions: ["every derived step outcome"],
  exclusions: [],
});

/**
 * Unsupported steps are counted and retained, never converted into failures.
 * The metric exists so an unsupported result stays visible in the journey
 * result rather than disappearing (ERL2-FR-005, ERL2-AC-005).
 */
export const UNSUPPORTED_RETENTION = define({
  schema_version: V,
  metric_id: "unsupported-retention",
  title: "Retained unsupported step outcomes",
  inputs: ["unsupported_step_outcomes"],
  canonical_ordering: "step_index_ascending",
  aggregation: "sum",
  measure: "unit",
  numerator_predicate: "step_outcome_status_is",
  numerator_predicate_argument: "unsupported",
  numerator_polarity: "satisfied",
  denominator_selector: "unsupported_step_outcomes",
  zero_denominator: "zero",
  missing_input_behaviour: "not_applicable",
  threshold_class: "measurement",
  claim_ceiling: "T1",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT"],
  inclusions: ["steps whose outcome status is unsupported"],
  exclusions: [],
});

/** Successful recover/rollback/remove outcomes over applicable attempts; none = N/A. */
export const RECOVERY_OUTCOME = define({
  schema_version: V,
  metric_id: "recovery-outcome",
  title: "Successful recovery, rollback and removal steps",
  inputs: ["recovery_step_outcomes"],
  canonical_ordering: "step_index_ascending",
  aggregation: "ratio",
  measure: "unit",
  numerator_predicate: "step_outcome_status_is",
  numerator_predicate_argument: "succeeded",
  numerator_polarity: "satisfied",
  denominator_selector: "recovery_step_outcomes",
  zero_denominator: "not_applicable",
  missing_input_behaviour: "not_applicable",
  threshold_class: "ordinary_gate",
  threshold: { comparator: "equals", bound: "1" },
  claim_ceiling: "T2",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT", "THRESHOLD_NOT_SATISFIED"],
  inclusions: ["steps whose intent is recover, rollback or remove"],
  exclusions: [],
});

/** Completed documented steps over applicable documented steps; none = N/A. */
export const DOCUMENTATION_SUCCESS = define({
  schema_version: V,
  metric_id: "documentation-success",
  title: "Documented steps that completed",
  inputs: ["documentation_steps"],
  canonical_ordering: "step_index_ascending",
  aggregation: "ratio",
  measure: "unit",
  numerator_predicate: "step_outcome_status_is",
  numerator_predicate_argument: "succeeded",
  numerator_polarity: "satisfied",
  denominator_selector: "documentation_steps",
  zero_denominator: "not_applicable",
  missing_input_behaviour: "not_applicable",
  threshold_class: "information",
  claim_ceiling: "T2",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT", "THRESHOLD_NOT_SATISFIED"],
  inclusions: ["steps that used at least one documented procedure"],
  exclusions: [],
});

/** Declared mutations that carry a compensation; none = N/A. */
export const MUTATION_COMPENSATION = define({
  schema_version: V,
  metric_id: "mutation-compensation",
  title: "Declared mutations that carry a compensation receipt",
  inputs: ["declared_mutations"],
  canonical_ordering: "artifact_hash_ascending",
  aggregation: "ratio",
  measure: "unit",
  numerator_predicate: "declared_mutation_has_compensation",
  numerator_polarity: "satisfied",
  denominator_selector: "declared_mutations",
  zero_denominator: "not_applicable",
  missing_input_behaviour: "not_applicable",
  threshold_class: "ordinary_gate",
  threshold: { comparator: "equals", bound: "1" },
  claim_ceiling: "T2",
  reason_codes: ["ZERO_DENOMINATOR", "MISSING_INPUT", "THRESHOLD_NOT_SATISFIED"],
  inclusions: ["every mutation the adapter declared"],
  exclusions: [],
});

// -- the catalogue -----------------------------------------------------------

export const DOMAIN_PLANE_METRICS: readonly MetricDefinitionV1[] = [
  AUTHORITY_SCOPE_METRIC,
  CAUSAL_OVERCLAIM,
  CITATION_REACHABILITY,
  CORRECT_ABSTENTION,
  CREDENTIAL_SAFETY,
  DEGRADATION_HONESTY,
  EVIDENCE_PRECISION,
  EVIDENCE_RECALL,
];

export const JOURNEY_PLANE_METRICS: readonly MetricDefinitionV1[] = [
  DOCUMENTATION_SUCCESS,
  JOURNEY_ACTIVE_MS,
  JOURNEY_ELAPSED_MS,
  MUTATION_COMPENSATION,
  OPERATOR_INTERVENTIONS,
  RECOVERY_OUTCOME,
  STEP_FAILURE_COUNT,
  STEP_RETRY_COUNT,
  UNSUPPORTED_RETENTION,
];

/** Every Lab-owned generic metric, ordered by identifier for determinism. */
export const GENERIC_METRIC_DEFINITIONS: readonly MetricDefinitionV1[] = [
  ...DOMAIN_PLANE_METRICS,
  ...JOURNEY_PLANE_METRICS,
].sort((a, b) => a.metric_id.localeCompare(b.metric_id));

// The set of metric ids core actually defines must equal the single
// authoritative reserved-id registry in `@erl2/contracts` that the pack SDK
// enforces against (review §11.7). This module-load assertion makes a divergence
// a hard failure at import time — a new generic metric that is not reserved, or
// a reserved id core forgot to define, cannot ship.
{
  const defined = GENERIC_METRIC_DEFINITIONS.map((m) => m.metric_id).sort();
  const reserved = [...RESERVED_GENERIC_METRIC_IDS].sort();
  const missingFromCore = reserved.filter((id) => !defined.includes(id));
  const missingFromRegistry = defined.filter((id) => !reserved.includes(id));
  if (missingFromCore.length > 0 || missingFromRegistry.length > 0) {
    throw new Error(
      "generic metric registry drift: " +
        `core-missing=[${missingFromCore.join(",")}] registry-missing=[${missingFromRegistry.join(",")}]`,
    );
  }
}

const BY_ID = new Map(GENERIC_METRIC_DEFINITIONS.map((m) => [m.metric_id, m]));

export function genericMetric(metricId: string): MetricDefinitionV1 {
  const found = BY_ID.get(metricId);
  if (!found) {
    throw new Erl2Error(
      CODES.PACK_UNKNOWN_METRIC_ID,
      `no Lab-owned generic metric named ${metricId}`,
      { owner: "evaluator" },
    );
  }
  return found;
}

/** Frozen identity of every generic metric, for a pack manifest's `metric_definitions`. */
export function genericMetricHashes(metricIds: readonly string[]): readonly Hash[] {
  return metricIds.map((id) => genericMetric(id).core_hash);
}

/**
 * Refuses a pack that ships its own definition for a Lab-owned metric id.
 *
 * Referencing a generic metric is always allowed; redefining one — even with
 * bytes that happen to match today — would move ownership of the threshold into
 * the pack, which design v2 §17 forbids.
 */
export function assertReferencedMetricsAreGeneric(
  definitions: readonly MetricDefinitionV1[],
): void {
  for (const definition of definitions) {
    const generic = BY_ID.get(definition.metric_id);
    if (generic === undefined) continue;
    if (generic.core_hash !== definition.core_hash) {
      throw new Erl2Error(
        CODES.PACK_GENERIC_METRIC_OVERRIDE,
        `metric ${definition.metric_id} is Lab-owned; a pack may reference it but not redefine it`,
        { owner: "evaluator" },
      );
    }
  }
}
