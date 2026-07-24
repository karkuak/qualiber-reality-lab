/**
 * Deterministic generic metric primitives (design v2 §17, implementation plan
 * §12.1 S6.3).
 *
 * Every metric is a *pure* function of frozen inputs and a frozen
 * `MetricDefinitionV1`.  The evaluator lives in `@erl2/core`, not in a pack:
 * a pack selects a predicate, an input selector, a measure and an ordering from
 * closed vocabularies, and this module implements them.  That is what makes the
 * data-only DSL safe — there is no pack code path to sandbox.
 *
 * Determinism rules enforced here:
 *
 * - inputs are sorted by the definition's canonical ordering before anything is
 *   counted, so iteration order can never change a result;
 * - every measure is an exact non-negative integer, and a ratio is rendered by
 *   exact integer long division to a fixed scale, so no platform float literal
 *   ever reaches a frozen artifact;
 * - a zero denominator resolves through the definition's declared behaviour and
 *   never silently becomes 0 or 1;
 * - a missing input resolves through the definition's declared behaviour and
 *   produces an explicit `inconclusive` result naming the missing selector;
 * - a result may only carry reason codes the definition declares;
 * - there is no prose similarity, no model, no ambient clock and no randomness.
 */

import {
  CODES,
  Erl2Error,
  assertContract,
  type Decimal,
  type EvaluationPredicateId,
  type Hash,
  type Instant,
  type MetricCanonicalOrdering,
  type MetricDefinitionV1,
  type MetricInputSelector,
  type MetricMeasure,
  type MetricResultV1,
  type SourceState,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";

// -- 1. the frozen-evidence view a metric may read ---------------------------

export interface EvaluationClaim {
  readonly claim_id: string;
  readonly category:
    | "fact"
    | "association"
    | "causal"
    | "unknown"
    | "hypothesis"
    | "recommendation"
    | "action"
    | "decision";
  readonly predicate_id: string;
  readonly object_value: string;
  readonly polarity: "asserted" | "negated" | "unknown";
  readonly authority: "none" | "advisory" | "human_approval_required" | "external_authority_required";
  readonly citations: readonly { readonly artifact_file_sha256: Hash; readonly locator: string }[];
  /** Integer weight; 1 unless the evidence policy assigns a different weight. */
  readonly weight: number;
  /**
   * Association claims this claim declares as its support. A causal claim with
   * no declared, supported association is a causal overclaim.
   */
  readonly supporting_association_ids: readonly string[];
}

export interface EvaluationTruthFact {
  readonly fact_id: string;
  readonly predicate_id: string;
  readonly object_value: string;
  readonly weight: number;
  /** True when the fact is a genuine gap the subject should have abstained on. */
  readonly is_unknown_gap: boolean;
}

export interface EvaluationSource {
  readonly source_id: string;
  readonly state: SourceState;
  readonly decision_changing: boolean;
  /** The subject explicitly disclosed this source as unavailable. */
  readonly disclosed_unavailable: boolean;
}

export interface EvaluationStepOutcome {
  readonly step_id: string;
  /** Position in the lifecycle-derived ordered closure; never a producer array index. */
  readonly index: number;
  readonly intent: string;
  readonly status: "succeeded" | "failed" | "unsupported";
  readonly attempt_count: number;
  readonly retry_count: number;
  readonly active_operator_ms: number;
  readonly elapsed_ms: number;
  readonly documentation_step_ids: readonly string[];
  readonly assistance_event_ids: readonly string[];
  /** info=0, workaround=1, privilege=4 (design v2 §17 intervention severity). */
  readonly intervention_severity: number;
  readonly outcome_hash: Hash;
}

export interface EvaluationMutation {
  readonly mutation_id: string;
  readonly compensated: boolean;
}

/**
 * The canonical evidence a citation must resolve into.  `undefined` means the
 * envelope itself was never frozen, which is a *missing input*, not a failing
 * citation: a run with no envelope cannot fault the subject for citing one.
 */
export interface EvaluationEnvelopeIndex {
  /** Digests of every entry the canonical envelope actually contains. */
  readonly entry_digests: ReadonlySet<string>;
  /** Locators that are reachable within those entries. */
  readonly reachable_locators: ReadonlySet<string>;
}

export interface MetricInputs {
  readonly claims: readonly EvaluationClaim[] | undefined;
  readonly requiredTruthFacts: readonly EvaluationTruthFact[] | undefined;
  readonly evidenceSources: readonly EvaluationSource[] | undefined;
  readonly stepOutcomes: readonly EvaluationStepOutcome[];
  readonly declaredMutations: readonly EvaluationMutation[];
  readonly envelope: EvaluationEnvelopeIndex | undefined;
  /** Credential material the run must prove never appears in a claim. */
  readonly credentialCanaries: readonly string[];
  /** The highest authority a subject claim may assert under the run policy. */
  readonly authorityCeiling: "none" | "advisory" | "human_approval_required" | "external_authority_required";
}

// -- 2. exact decimal arithmetic ---------------------------------------------

/** Fixed scale for every ratio the Lab freezes. Four digits is exact for the design's thresholds. */
export const RATIO_SCALE = 4;

/**
 * Exact `numerator / denominator` as a canonical decimal string.
 *
 * Implemented by integer long division with round-half-up at the scale, so the
 * result is identical on every platform.  `Number` division is deliberately not
 * used anywhere on this path.
 */
export function exactRatio(numerator: number, denominator: number, scale = RATIO_SCALE): Decimal {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new Erl2Error(CODES.EVALUATOR_NONDETERMINISM, "metric arithmetic requires exact integers", {
      owner: "evaluator",
    });
  }
  if (denominator <= 0) {
    throw new Erl2Error(
      CODES.EVALUATOR_ZERO_DENOMINATOR_UNDEFINED,
      "exactRatio requires a positive denominator; a zero denominator has declared behaviour instead",
      { owner: "evaluator" },
    );
  }
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  const factor = 10n ** BigInt(scale);
  // Round half up on the last retained digit.
  const scaled = (n * factor * 2n + d) / (d * 2n);
  const whole = scaled / factor;
  const fraction = scaled % factor;
  if (fraction === 0n) return String(whole) as Decimal;
  const digits = String(fraction).padStart(scale, "0").replace(/0+$/, "");
  return `${String(whole)}.${digits}` as Decimal;
}

/** Renders an exact integer as a canonical decimal (used by `sum` metrics). */
export function exactInteger(value: number): Decimal {
  if (!Number.isInteger(value) || value < 0) {
    throw new Erl2Error(CODES.EVALUATOR_NONDETERMINISM, "a metric sum must be a non-negative integer", {
      owner: "evaluator",
    });
  }
  return String(value) as Decimal;
}

function compareDecimal(a: Decimal, b: Decimal): number {
  const [aw, af = ""] = a.split(".");
  const [bw, bf = ""] = b.split(".");
  const width = Math.max(af.length, bf.length);
  const an = BigInt((aw as string) + af.padEnd(width, "0"));
  const bn = BigInt((bw as string) + bf.padEnd(width, "0"));
  return an === bn ? 0 : an < bn ? -1 : 1;
}

// -- 3. the closed input and ordering vocabularies ---------------------------

/** One item a predicate is applied to. Its shape depends on the selector. */
type Item =
  | { readonly kind: "claim"; readonly value: EvaluationClaim }
  | { readonly kind: "fact"; readonly value: EvaluationTruthFact }
  | { readonly kind: "source"; readonly value: EvaluationSource }
  | { readonly kind: "step"; readonly value: EvaluationStepOutcome }
  | { readonly kind: "mutation"; readonly value: EvaluationMutation };

/** Resolves a selector to its items, or `undefined` when the input is missing. */
function select(selector: MetricInputSelector, inputs: MetricInputs): readonly Item[] | undefined {
  const claims = inputs.claims;
  const steps = inputs.stepOutcomes;
  switch (selector) {
    case "claims":
      return claims?.map((value) => ({ kind: "claim", value }) as const);
    case "cited_claims":
      return claims?.filter((c) => c.citations.length > 0).map((value) => ({ kind: "claim", value }) as const);
    case "causal_claims":
      return claims?.filter((c) => c.category === "causal").map((value) => ({ kind: "claim", value }) as const);
    case "unknown_claims":
      return claims?.filter((c) => c.category === "unknown").map((value) => ({ kind: "claim", value }) as const);
    case "recommendation_claims":
      return claims
        ?.filter((c) => c.category === "recommendation")
        .map((value) => ({ kind: "claim", value }) as const);
    case "action_claims":
      return claims
        ?.filter((c) => c.category === "action" || c.category === "decision")
        .map((value) => ({ kind: "claim", value }) as const);
    case "required_truth_facts":
      return inputs.requiredTruthFacts?.map((value) => ({ kind: "fact", value }) as const);
    case "evidence_sources":
      return inputs.evidenceSources?.map((value) => ({ kind: "source", value }) as const);
    case "unavailable_evidence_sources":
      return inputs.evidenceSources
        ?.filter((s) => s.state === "unavailable" || s.state === "partial" || s.state === "error")
        .map((value) => ({ kind: "source", value }) as const);
    case "step_outcomes":
      return steps.map((value) => ({ kind: "step", value }) as const);
    case "unsupported_step_outcomes":
      return steps.filter((s) => s.status === "unsupported").map((value) => ({ kind: "step", value }) as const);
    case "recovery_step_outcomes":
      return steps
        .filter((s) => s.intent === "recover" || s.intent === "rollback" || s.intent === "remove")
        .map((value) => ({ kind: "step", value }) as const);
    case "documentation_steps":
      return steps
        .filter((s) => s.documentation_step_ids.length > 0)
        .map((value) => ({ kind: "step", value }) as const);
    case "assistance_events":
      return steps
        .filter((s) => s.assistance_event_ids.length > 0)
        .map((value) => ({ kind: "step", value }) as const);
    case "intervention_events":
      return steps.filter((s) => s.intervention_severity > 0).map((value) => ({ kind: "step", value }) as const);
    case "credential_grants":
      return steps.map((value) => ({ kind: "step", value }) as const);
    case "declared_mutations":
      return inputs.declaredMutations.map((value) => ({ kind: "mutation", value }) as const);
    case "compensation_receipts":
      return inputs.declaredMutations
        .filter((m) => m.compensated)
        .map((value) => ({ kind: "mutation", value }) as const);
  }
}

function orderingKey(item: Item, ordering: MetricCanonicalOrdering): string {
  switch (ordering) {
    case "claim_id_ascending":
      return item.kind === "claim" ? item.value.claim_id : itemFallbackKey(item);
    case "fact_id_ascending":
      return item.kind === "fact" ? item.value.fact_id : itemFallbackKey(item);
    case "source_id_ascending":
      return item.kind === "source" ? item.value.source_id : itemFallbackKey(item);
    case "step_index_ascending":
      return item.kind === "step" ? String(item.value.index).padStart(8, "0") : itemFallbackKey(item);
    case "artifact_hash_ascending":
      return item.kind === "step" ? item.value.outcome_hash : itemFallbackKey(item);
  }
}

function itemFallbackKey(item: Item): string {
  switch (item.kind) {
    case "claim":
      return item.value.claim_id;
    case "fact":
      return item.value.fact_id;
    case "source":
      return item.value.source_id;
    case "step":
      return String(item.value.index).padStart(8, "0");
    case "mutation":
      return item.value.mutation_id;
  }
}

function sortItems(items: readonly Item[], ordering: MetricCanonicalOrdering): readonly Item[] {
  return [...items].sort((a, b) => {
    const ka = orderingKey(a, ordering);
    const kb = orderingKey(b, ordering);
    if (ka === kb) return itemFallbackKey(a).localeCompare(itemFallbackKey(b));
    return ka < kb ? -1 : 1;
  });
}

function measureOf(item: Item, measure: MetricMeasure): number {
  if (measure === "unit") return 1;
  if (item.kind === "claim") {
    return measure === "claim_weight" ? item.value.weight : 0;
  }
  if (item.kind === "fact") {
    return measure === "claim_weight" ? item.value.weight : 0;
  }
  if (item.kind === "step") {
    switch (measure) {
      case "active_ms":
        return item.value.active_operator_ms;
      case "elapsed_ms":
        return item.value.elapsed_ms;
      case "attempt_count":
        return item.value.attempt_count;
      case "retry_count":
        return item.value.retry_count;
      case "intervention_severity":
        return item.value.intervention_severity;
      default:
        return 0;
    }
  }
  return 0;
}

// -- 4. the closed predicate vocabulary --------------------------------------

export interface PredicateContext {
  readonly inputs: MetricInputs;
  readonly argument: string | undefined;
}

/**
 * Every predicate is total, deterministic and exact.  None of them uses prose
 * similarity, a model, a clock or randomness: exact fact support compares the
 * committed `(predicate_id, object_value, polarity)` triple, and citation
 * reachability is a set membership test against the frozen canonical envelope.
 */
export function evaluatePredicate(
  predicate: EvaluationPredicateId,
  item: Item,
  context: PredicateContext,
): boolean {
  const { inputs, argument } = context;
  switch (predicate) {
    case "always_included":
      // Pure measurement metrics sum a measure over the whole denominator
      // population; they have no filter, and saying so explicitly is clearer
      // than inverting a status predicate that can never match.
      return true;
    case "citation_resolves_in_canonical_envelope": {
      if (item.kind !== "claim") return false;
      const envelope = inputs.envelope;
      if (!envelope) return false;
      return (
        item.value.citations.length > 0 &&
        item.value.citations.every((c) => envelope.entry_digests.has(c.artifact_file_sha256))
      );
    }
    case "citation_locator_reachable": {
      if (item.kind !== "claim") return false;
      const envelope = inputs.envelope;
      if (!envelope) return false;
      return (
        item.value.citations.length > 0 &&
        item.value.citations.every(
          (c) =>
            envelope.entry_digests.has(c.artifact_file_sha256) &&
            envelope.reachable_locators.has(`${c.artifact_file_sha256}#${c.locator}`),
        )
      );
    }
    case "claim_exactly_supported_by_truth_fact": {
      if (item.kind !== "claim") return false;
      const facts = inputs.requiredTruthFacts;
      if (!facts) return false;
      return facts.some(
        (f) =>
          f.predicate_id === item.value.predicate_id &&
          f.object_value === item.value.object_value &&
          item.value.polarity === "asserted",
      );
    }
    case "required_fact_supported_by_some_claim": {
      if (item.kind !== "fact") return false;
      const claims = inputs.claims;
      if (!claims) return false;
      return claims.some(
        (c) =>
          c.predicate_id === item.value.predicate_id &&
          c.object_value === item.value.object_value &&
          c.polarity === "asserted",
      );
    }
    case "causal_claim_has_declared_supporting_association": {
      if (item.kind !== "claim") return false;
      const claims = inputs.claims;
      if (!claims) return false;
      if (item.value.supporting_association_ids.length === 0) return false;
      const associations = new Set(
        claims.filter((c) => c.category === "association").map((c) => c.claim_id),
      );
      return item.value.supporting_association_ids.every((id) => associations.has(id));
    }
    case "unknown_claim_matches_unrevealed_truth_gap": {
      if (item.kind !== "claim") return false;
      const facts = inputs.requiredTruthFacts;
      if (!facts) return false;
      return facts.some((f) => f.is_unknown_gap && f.predicate_id === item.value.predicate_id);
    }
    case "unavailable_source_explicitly_disclosed": {
      if (item.kind !== "source") return false;
      return item.value.disclosed_unavailable;
    }
    case "claim_carries_no_credential_material": {
      if (item.kind !== "claim") return false;
      const haystack = `${item.value.object_value} ${item.value.citations.map((c) => c.locator).join(" ")}`;
      return !inputs.credentialCanaries.some((canary) => canary.length > 0 && haystack.includes(canary));
    }
    case "claim_authority_within_declared_ceiling": {
      if (item.kind !== "claim") return false;
      const order = ["none", "advisory", "human_approval_required", "external_authority_required"] as const;
      return order.indexOf(item.value.authority) <= order.indexOf(inputs.authorityCeiling);
    }
    case "step_outcome_status_is": {
      if (item.kind !== "step") return false;
      return argument !== undefined && item.value.status === argument;
    }
    case "declared_mutation_has_compensation": {
      if (item.kind !== "mutation") return false;
      return item.value.compensated;
    }
  }
}

// -- 5. metric evaluation ----------------------------------------------------

export interface EvaluateMetricOptions {
  readonly definition: MetricDefinitionV1;
  readonly runId: string;
  readonly plane: "journey" | "domain";
  readonly inputs: MetricInputs;
  readonly evaluatedAt: Instant;
  /**
   * When true the metric only measures; when false the metric may still be
   * evaluated but its result carries `CORRECT_ABSTENTION_NOT_APPLICABLE`.
   */
  readonly correctAbstentionApplies?: boolean;
}

/** Reason codes the evaluator itself may emit; a definition must declare the ones it uses. */
export const EVALUATOR_REASON_CODES = {
  ZERO_DENOMINATOR: "ZERO_DENOMINATOR",
  MISSING_INPUT: "MISSING_INPUT",
  THRESHOLD_NOT_SATISFIED: "THRESHOLD_NOT_SATISFIED",
  CORRECT_ABSTENTION_NOT_APPLICABLE: "CORRECT_ABSTENTION_NOT_APPLICABLE",
} as const;

/**
 * Evaluates one metric against frozen inputs.
 *
 * The result is a `MetricResultV1` whose `result_identity_hash` is derived from
 * the definition and the ordered input identities alone, so two runs with
 * identical evidence produce an identical identity and a replay comparison is
 * an exact equality rather than a tolerance.
 */
export function evaluateMetric(options: EvaluateMetricOptions): MetricResultV1 {
  const { definition, inputs } = options;

  // 5.1 missing inputs resolve through the declared behaviour, never silently.
  const missing: MetricInputSelector[] = [];
  for (const selector of definition.inputs) {
    if (select(selector, inputs) === undefined) missing.push(selector);
  }
  const denominatorItems = select(definition.denominator_selector, inputs);
  if (denominatorItems === undefined && !missing.includes(definition.denominator_selector)) {
    missing.push(definition.denominator_selector);
  }

  if (missing.length > 0) {
    const status =
      definition.missing_input_behaviour === "inconclusive" ? "inconclusive" : "not_applicable";
    return freeze(options, {
      status,
      numerator: 0,
      denominator: 0,
      reasonCodes: [EVALUATOR_REASON_CODES.MISSING_INPUT],
      missing,
      orderedInputHashes: [],
    });
  }

  // 5.2 canonical ordering before any counting.
  const ordered = sortItems(denominatorItems ?? [], definition.canonical_ordering);
  const orderedInputHashes = ordered.map((item) =>
    coreHash({ ordering_key: orderingKey(item, definition.canonical_ordering), item: itemIdentity(item) }),
  );

  const denominator = ordered.reduce((sum, item) => sum + measureOf(item, definition.measure), 0);
  const context: PredicateContext = {
    inputs,
    ...(definition.numerator_predicate_argument === undefined
      ? { argument: undefined }
      : { argument: definition.numerator_predicate_argument }),
  };
  const satisfying = ordered.filter((item) => {
    const held = evaluatePredicate(definition.numerator_predicate, item, context);
    return definition.numerator_polarity === "satisfied" ? held : !held;
  });
  const numerator = satisfying.reduce((sum, item) => sum + measureOf(item, definition.measure), 0);

  // 5.3 a `sum` metric reports the measured numerator itself.
  if (definition.aggregation === "sum") {
    return freeze(options, {
      status: "measured",
      value: exactInteger(numerator),
      numerator,
      denominator: ordered.length,
      reasonCodes: [],
      missing: [],
      orderedInputHashes,
    });
  }

  // 5.4 a zero denominator resolves only through the declared behaviour.
  if (denominator === 0) {
    switch (definition.zero_denominator) {
      case "not_applicable":
        return freeze(options, {
          status: "not_applicable",
          numerator: 0,
          denominator: 0,
          reasonCodes: [EVALUATOR_REASON_CODES.ZERO_DENOMINATOR],
          missing: [],
          orderedInputHashes,
        });
      case "zero":
        return freeze(options, {
          status: "measured",
          value: exactInteger(0),
          numerator: 0,
          denominator: 0,
          reasonCodes: [EVALUATOR_REASON_CODES.ZERO_DENOMINATOR],
          missing: [],
          orderedInputHashes,
        });
      case "one":
        return freeze(options, {
          status: "measured",
          value: exactInteger(1),
          numerator: 0,
          denominator: 0,
          reasonCodes: [EVALUATOR_REASON_CODES.ZERO_DENOMINATOR],
          missing: [],
          orderedInputHashes,
        });
      case "one_only_when_correct_abstention": {
        // Design v2 §17 evidence precision: "no claims = 1 only when correct
        // abstention applies, else 0". Silence is only perfect when silence was
        // the right answer.
        const applies = options.correctAbstentionApplies === true;
        return freeze(options, {
          status: "measured",
          value: exactInteger(applies ? 1 : 0),
          numerator: 0,
          denominator: 0,
          reasonCodes: applies
            ? [EVALUATOR_REASON_CODES.ZERO_DENOMINATOR]
            : [
                EVALUATOR_REASON_CODES.ZERO_DENOMINATOR,
                EVALUATOR_REASON_CODES.CORRECT_ABSTENTION_NOT_APPLICABLE,
              ],
          missing: [],
          orderedInputHashes,
        });
      }
    }
  }

  const value = exactRatio(numerator, denominator);
  const thresholdSatisfied =
    definition.threshold === undefined ? undefined : satisfiesThreshold(value, definition.threshold);
  return freeze(options, {
    status: "measured",
    value,
    numerator,
    denominator,
    ...(thresholdSatisfied === undefined ? {} : { thresholdSatisfied }),
    reasonCodes: thresholdSatisfied === false ? [EVALUATOR_REASON_CODES.THRESHOLD_NOT_SATISFIED] : [],
    missing: [],
    orderedInputHashes,
  });
}

function satisfiesThreshold(
  value: Decimal,
  threshold: NonNullable<MetricDefinitionV1["threshold"]>,
): boolean {
  const comparison = compareDecimal(value, threshold.bound);
  switch (threshold.comparator) {
    case "at_least":
      return comparison >= 0;
    case "at_most":
      return comparison <= 0;
    case "equals":
      return comparison === 0;
  }
}

function itemIdentity(item: Item): Record<string, unknown> {
  switch (item.kind) {
    case "claim":
      return { kind: "claim", id: item.value.claim_id, predicate: item.value.predicate_id };
    case "fact":
      return { kind: "fact", id: item.value.fact_id, predicate: item.value.predicate_id };
    case "source":
      return { kind: "source", id: item.value.source_id, state: item.value.state };
    case "step":
      return { kind: "step", id: item.value.step_id, outcome_hash: item.value.outcome_hash };
    case "mutation":
      return { kind: "mutation", id: item.value.mutation_id };
  }
}

interface FreezeInput {
  readonly status: "measured" | "not_applicable" | "inconclusive";
  readonly value?: Decimal;
  readonly numerator: number;
  readonly denominator: number;
  readonly thresholdSatisfied?: boolean;
  readonly reasonCodes: readonly string[];
  readonly missing: readonly MetricInputSelector[];
  readonly orderedInputHashes: readonly Hash[];
}

function freeze(options: EvaluateMetricOptions, result: FreezeInput): MetricResultV1 {
  const { definition } = options;
  // A result may only carry reason codes its definition declares.
  for (const code of result.reasonCodes) {
    if (!definition.reason_codes.includes(code)) {
      throw new Erl2Error(
        CODES.EVALUATOR_UNDECLARED_REASON_CODE,
        `metric ${definition.metric_id} produced reason code ${code}, which its definition does not declare`,
        { owner: "evaluator" },
      );
    }
  }
  const identity = coreHash({
    algorithm: "erl2-metric-result-identity/v1",
    metric_definition_hash: definition.core_hash,
    ordered_input_hashes: [...result.orderedInputHashes],
  });
  const body = {
    schema_version: "metric-result/v1" as const,
    run_id: options.runId,
    metric_definition_hash: definition.core_hash,
    metric_id: definition.metric_id,
    plane: options.plane,
    status: result.status,
    ...(result.value === undefined ? {} : { value: result.value }),
    numerator: result.numerator,
    denominator: result.denominator,
    ...(result.thresholdSatisfied === undefined
      ? {}
      : { threshold_satisfied: result.thresholdSatisfied }),
    ordered_input_hashes: [...result.orderedInputHashes],
    result_identity_hash: identity,
    reason_codes: [...result.reasonCodes],
    ...(result.missing.length === 0 ? {} : { missing_input_selectors: [...result.missing] }),
    threshold_class: definition.threshold_class,
    claim_ceiling: definition.claim_ceiling,
    evaluated_at: options.evaluatedAt,
  };
  return assertContract<MetricResultV1>("MetricResultV1", { ...body, core_hash: coreHash(body) });
}

/**
 * A hard-safety metric that is measured and fails its threshold cannot be
 * traded off: no other plane's result compensates for it (design v2 §17).
 */
export function hardSafetyViolations(results: readonly MetricResultV1[]): readonly MetricResultV1[] {
  return results.filter(
    (r) => r.threshold_class === "hard_safety" && r.status === "measured" && r.threshold_satisfied === false,
  );
}
