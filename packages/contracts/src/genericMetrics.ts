/**
 * The single authoritative registry of Lab-owned **reserved generic metric
 * identifiers** (design v2 §17: "pack additions cannot overwrite generic metric
 * IDs").
 *
 * This list lives in `@erl2/contracts` — the one package both the evaluator core
 * (`@erl2/core`, which owns the full frozen `MetricDefinitionV1` objects) and the
 * pack-authoring SDK (`@erl2/evaluation-sdk`, which refuses a pack that redefines
 * one) depend on.  Previously each package kept its own copy and they had
 * drifted: core reserved seventeen ids while the SDK reserved only fifteen,
 * silently omitting the hard-safety `authority-scope` and the
 * `mutation-compensation` metrics, so `certifyPack` could pass a neutered
 * generic metric (review §11.7).  A single source, cross-checked two ways by a
 * test, makes that drift impossible.
 */

/**
 * Every generic metric identifier the Lab reserves, sorted lexically for
 * determinism.  Core's `GENERIC_METRIC_DEFINITIONS` must cover exactly this set
 * (proven two-way by `tests/adversarial/genericEvaluation.test.ts`).
 */
export const RESERVED_GENERIC_METRIC_IDS: readonly string[] = [
  "authority-scope",
  "causal-overclaim",
  "citation-reachability",
  "correct-abstention",
  "credential-safety",
  "degradation-honesty",
  "documentation-success",
  "evidence-precision",
  "evidence-recall",
  "journey-active-ms",
  "journey-elapsed-ms",
  "mutation-compensation",
  "operator-interventions",
  "recovery-outcome",
  "step-failure-count",
  "step-retry-count",
  "unsupported-retention",
];

/** Set form for O(1) membership checks. */
export const RESERVED_GENERIC_METRIC_ID_SET: ReadonlySet<string> = new Set(
  RESERVED_GENERIC_METRIC_IDS,
);
