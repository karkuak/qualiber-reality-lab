/**
 * Journey evaluation (design v2 §17, implementation plan §12.1 S6.3).
 *
 * The journey plane measures what actually happened to an operator: what was
 * acquired, installed, configured, connected, exercised, recovered, rolled back
 * or removed; how long it took; how much help it needed; what it declared
 * unsupported; and what it mutated and compensated.
 *
 * The ordered step outcomes come from `deriveStepClosure`, which reads the
 * hash-chained lifecycle events.  The subject-output manifest's own
 * `step_outcome_hashes` array is treated as a *claim to check*, never as the
 * source of order (ERL2-FR-020): a subject or adapter that reorders, duplicates
 * or omits an entry is refused rather than believed.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type Hash,
  type Instant,
  type JourneyStepOutcomeV1,
  type MetricDefinitionV1,
  type MetricResultV1,
  type PreSelectionJourneyResultV1,
  type SelectedJourneyResultV1,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";
import {
  evaluateMetric,
  type EvaluationMutation,
  type EvaluationStepOutcome,
  type MetricInputs,
} from "./metrics.js";

/** Severity weights for an operator intervention (design v2 §17). */
export const INTERVENTION_SEVERITY: Readonly<Record<string, number>> = {
  info: 0,
  workaround: 1,
  privilege: 4,
};

export interface AssistanceSummary {
  /** Assistance event identifiers, keyed by the step that needed them. */
  readonly byStepId: Readonly<Record<string, readonly string[]>>;
  /** Intervention kinds, keyed by step id; each maps to a severity weight. */
  readonly interventionKindsByStepId: Readonly<Record<string, readonly string[]>>;
  /** Documentation step identifiers actually used, keyed by step id. */
  readonly documentationByStepId: Readonly<Record<string, readonly string[]>>;
}

export const NO_ASSISTANCE: AssistanceSummary = {
  byStepId: {},
  interventionKindsByStepId: {},
  documentationByStepId: {},
};

/**
 * Projects the derived, ordered `JourneyStepOutcomeV1` closure into the metric
 * evaluator's view.
 *
 * `index` is the position in the *derived* order, so a metric ordered by
 * `step_index_ascending` follows lifecycle order and nothing else.
 */
export function projectStepOutcomes(
  ordered: readonly JourneyStepOutcomeV1[],
  assistance: AssistanceSummary = NO_ASSISTANCE,
): readonly EvaluationStepOutcome[] {
  const seen = new Set<string>();
  return ordered.map((outcome, index) => {
    if (seen.has(outcome.core_hash)) {
      throw new Erl2Error(
        CODES.EVALUATOR_DUPLICATE_STEP_OUTCOME,
        `step outcome ${outcome.step_id} appears more than once in the derived closure`,
        { owner: "lab" },
      );
    }
    seen.add(outcome.core_hash);
    const kinds = assistance.interventionKindsByStepId[outcome.step_id] ?? [];
    const severity = kinds.reduce((sum, kind) => sum + (INTERVENTION_SEVERITY[kind] ?? 0), 0);
    const attempts = Math.max(1, outcome.attempt_record_hashes.length);
    return {
      step_id: outcome.step_id,
      index,
      intent: outcome.intent,
      status: outcome.status,
      attempt_count: attempts,
      retry_count: attempts - 1,
      active_operator_ms: outcome.active_operator_ms,
      elapsed_ms: elapsedMs(outcome.started_at, outcome.ended_at),
      documentation_step_ids: assistance.documentationByStepId[outcome.step_id] ?? [],
      assistance_event_ids: assistance.byStepId[outcome.step_id] ?? [],
      intervention_severity: severity,
      outcome_hash: outcome.core_hash,
    };
  });
}

/**
 * Elapsed wall-clock milliseconds between two committed instants.
 *
 * Both instants are frozen artifact fields, so this is a measurement of
 * recorded evidence rather than a read of an ambient clock.
 */
export function elapsedMs(startedAt: Instant, endedAt: Instant): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    throw new Erl2Error(
      CODES.EVALUATOR_NONDETERMINISM,
      "a step outcome carries a non-monotonic or unparseable instant pair",
      { owner: "lab" },
    );
  }
  return end - start;
}

/**
 * Checks a producer-supplied step-outcome array against the derived closure.
 *
 * A missing, extra, duplicated or reordered entry is refused here, which is why
 * a journey result can be trusted without trusting the subject output.
 */
export function assertClaimedOrderMatchesDerived(
  claimed: readonly Hash[],
  derived: readonly Hash[],
): void {
  if (claimed.length !== derived.length) {
    throw new Erl2Error(
      CODES.EVALUATOR_STEP_OUTCOME_NOT_DERIVED,
      `subject output claims ${String(claimed.length)} step outcomes; the lifecycle derives ${String(derived.length)}`,
      { owner: "lab" },
    );
  }
  for (let i = 0; i < derived.length; i += 1) {
    if (claimed[i] !== derived[i]) {
      throw new Erl2Error(
        CODES.EVALUATOR_STEP_OUTCOME_NOT_DERIVED,
        `subject output step outcome ${String(i)} does not match the lifecycle-derived order`,
        { owner: "lab" },
      );
    }
  }
}

export interface JourneyEvaluationInput {
  readonly runId: string;
  readonly genericRunPolicyHash: Hash;
  readonly orderedOutcomes: readonly JourneyStepOutcomeV1[];
  readonly assistance?: AssistanceSummary;
  readonly declaredMutations?: readonly EvaluationMutation[];
  /** Judge expectations revealed for the failed or unsupported steps only. */
  readonly revealedJudgeExpectationHashes: readonly Hash[];
  readonly journeyMetricDefinitions: readonly MetricDefinitionV1[];
  readonly findingHashes: readonly Hash[];
  readonly evaluatedAt: Instant;
  /** True when the evidence cannot support a conclusion at all. */
  readonly inconclusive?: boolean;
}

export interface JourneyEvaluationOutput {
  readonly metricResults: readonly MetricResultV1[];
  readonly status: "evaluated" | "inconclusive";
  readonly stepOutcomeHashes: readonly Hash[];
}

function evaluateJourneyMetrics(input: JourneyEvaluationInput): JourneyEvaluationOutput {
  const steps = projectStepOutcomes(input.orderedOutcomes, input.assistance ?? NO_ASSISTANCE);
  const inputs: MetricInputs = {
    // The domain-plane inputs are absent on the journey plane; a journey metric
    // that named one would resolve to a missing input rather than to an empty
    // set, which is the honest answer.
    claims: undefined,
    requiredTruthFacts: undefined,
    evidenceSources: undefined,
    stepOutcomes: steps,
    declaredMutations: [...(input.declaredMutations ?? [])],
    envelope: undefined,
    credentialCanaries: [],
    authorityCeiling: "advisory",
  };
  const metricResults = input.journeyMetricDefinitions
    .map((definition) =>
      evaluateMetric({
        definition,
        runId: input.runId,
        plane: "journey",
        inputs,
        evaluatedAt: input.evaluatedAt,
      }),
    )
    .sort((a, b) => a.metric_id.localeCompare(b.metric_id));

  return {
    metricResults,
    status: input.inconclusive === true ? "inconclusive" : "evaluated",
    stepOutcomeHashes: input.orderedOutcomes.map((o) => o.core_hash),
  };
}

/**
 * Freezes the pre-selection journey result for an `acquire` or `verify_package`
 * terminal.
 *
 * This variant has no journey hash and no selected binding, because no
 * challenge was selected: the run ended before selection.
 */
export function buildPreSelectionJourneyResult(
  input: JourneyEvaluationInput & {
    readonly terminalStage: "acquire" | "verify_package";
    readonly acquisitionPreregistrationHash: Hash;
    readonly metricResultHashes?: readonly Hash[];
  },
): { readonly result: PreSelectionJourneyResultV1; readonly metricResults: readonly MetricResultV1[] } {
  const evaluated = evaluateJourneyMetrics(input);
  const body = {
    schema_version: "pre-selection-journey-result/v1" as const,
    run_id: input.runId,
    terminal_stage: input.terminalStage,
    acquisition_preregistration_hash: input.acquisitionPreregistrationHash,
    generic_run_policy_hash: input.genericRunPolicyHash,
    step_outcome_hashes: [...evaluated.stepOutcomeHashes],
    revealed_judge_expectation_hashes: [...input.revealedJudgeExpectationHashes],
    metric_result_hashes:
      input.metricResultHashes === undefined
        ? evaluated.metricResults.map((m) => m.core_hash)
        : [...input.metricResultHashes],
    finding_hashes: [...input.findingHashes],
    status: evaluated.status,
    recorded_at: input.evaluatedAt,
  };
  return {
    result: assertContract<PreSelectionJourneyResultV1>("PreSelectionJourneyResultV1", {
      ...body,
      core_hash: coreHash(body),
    }),
    metricResults: evaluated.metricResults,
  };
}

/** Freezes the selected-environment journey result. */
export function buildSelectedJourneyResult(
  input: JourneyEvaluationInput & {
    readonly journeyHash: Hash;
    readonly notApplicable?: boolean;
    readonly metricResultHashes?: readonly Hash[];
  },
): { readonly result: SelectedJourneyResultV1; readonly metricResults: readonly MetricResultV1[] } {
  const evaluated = evaluateJourneyMetrics(input);
  const status: "evaluated" | "not_applicable" | "inconclusive" =
    input.notApplicable === true ? "not_applicable" : evaluated.status;
  const body = {
    schema_version: "selected-journey-result/v1" as const,
    run_id: input.runId,
    generic_run_policy_hash: input.genericRunPolicyHash,
    journey_hash: input.journeyHash,
    step_outcome_hashes: [...evaluated.stepOutcomeHashes],
    revealed_judge_expectation_hashes: [...input.revealedJudgeExpectationHashes],
    metric_result_hashes:
      input.metricResultHashes === undefined
        ? evaluated.metricResults.map((m) => m.core_hash)
        : [...input.metricResultHashes],
    finding_hashes: [...input.findingHashes],
    status,
    recorded_at: input.evaluatedAt,
  };
  return {
    result: assertContract<SelectedJourneyResultV1>("SelectedJourneyResultV1", {
      ...body,
      core_hash: coreHash(body),
    }),
    metricResults: evaluated.metricResults,
  };
}
