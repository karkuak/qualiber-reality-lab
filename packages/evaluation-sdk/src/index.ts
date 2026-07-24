/**
 * `@erl2/evaluation-sdk` — the data-only evaluation pack DSL and its
 * certification harness (design v2 §17, implementation plan §12.1 S6.2).
 *
 * ERL2-OQ-004 (data DSL versus restricted WASM) is unresolved, so the design's
 * fail-closed state applies and this package implements *only* the declarative
 * format.  There is no pack runtime here to attack: a pack is a closed
 * `EvaluationPackBodyV1` whose every predicate, input selector, ordering key and
 * finding category is an identifier drawn from a closed vocabulary that
 * `@erl2/core` implements.  A pack therefore cannot express arbitrary
 * JavaScript, shell, WASM or native code, a filesystem/network/process call, an
 * ambient clock or randomness read, an environment mutation, a selection or
 * truth-reveal handle, a validity setter, or a generic threshold override —
 * there is no field of any of those shapes.
 *
 * The certification harness below is the *second* line: it scans an authored
 * pack for subject names, candidate-specific tokens, shortcut predicates,
 * undeclared vocabulary, unknown metric identifiers and attempted authority,
 * and refuses the pack before it can be bound to a run policy.
 *
 * This package depends only on `@erl2/contracts` (implementation plan §4.1), so
 * the canonical hasher is *injected*.  Duplicating a second JCS or SHA-256
 * implementation here would violate the "one canonical implementation" rule in
 * design v2 §16.1.
 */

import {
  CODES,
  Erl2Error,
  RESERVED_GENERIC_METRIC_IDS as RESERVED_GENERIC_METRIC_IDS_CANONICAL,
  type ClaimScope,
  type EvaluationPackAssertionV1,
  type EvaluationPackBodyV1,
  type EvaluationPackCertificationFindingV1,
  type EvaluationPackCertificationReceiptV1,
  type EvaluationPackManifestV1,
  type EvaluationPredicateId,
  type Hash,
  type MetricCanonicalOrdering,
  type MetricDefinitionV1,
  type MetricInputSelector,
  type MetricThresholdClass,
  type Signature,
} from "@erl2/contracts";

// -- 1. the prohibited surface -----------------------------------------------

/**
 * APIs a pack may never reach (design v2 §8/§17, ERL2-AC-016).
 *
 * These are declared in the manifest and scanned for in the body.  The list is
 * belt-and-braces: the closed schema already has no member that could carry
 * one, so a hit here means someone smuggled a string into a free-text field.
 */
export const PROHIBITED_CORE_APIS: readonly string[] = [
  "node:fs",
  "node:net",
  "node:http",
  "node:https",
  "node:dns",
  "node:child_process",
  "node:process",
  "node:worker_threads",
  "node:vm",
  "node:crypto",
  "WebAssembly",
  "eval",
  "Function(",
  "require(",
  "import(",
  "fetch(",
  "Date.now",
  "new Date",
  "Math.random",
  "crypto.getRandomValues",
  "process.env",
  "setValidity",
  "setThreshold",
  "revealTruth",
  "openSelectedEntry",
  "mutateEnvironment",
];

/**
 * Substrings that betray a candidate-specific shortcut in a subject-neutral
 * pack: a rule that recognises one product's output shape rather than the
 * domain's evidence.  Design v2 §17: "a pack that encodes product vocabulary
 * without a subject-deep scope is refused".
 */
export const SHORTCUT_TOKENS: readonly string[] = [
  "if_subject_is",
  "when_vendor",
  "known_good_output",
  "expected_exit_code",
  "product_specific",
  "vendor_specific",
  "candidate_id",
  "golden_answer",
  "answer_key",
];

/** Contract identifiers a domain pack is entitled to read (frozen evidence only). */
export const PERMITTED_INPUT_CONTRACT_IDS: readonly string[] = [
  "ERL2-C-027", // JourneyStepOutcomeV1
  "ERL2-C-028", // SubjectOutputManifestV1
  "ERL2-C-030", // ObservationBundleV2
  "ERL2-C-031", // ReplayCanonicalEvidenceEnvelopeV1
  "ERL2-C-032", // LiveCanonicalEvidenceEnvelopeV1
  "ERL2-C-033", // CanonicalSubjectEvidenceEnvelopeV1
  "ERL2-C-037", // GenericClaimSetV1
  "ERL2-C-029", // SourceSnapshotV1
  "ERL2-C-024", // SubjectInstallationRecordV1
  "ERL2-C-025", // SubjectConfigurationRecordV1
  "ERL2-C-026", // SubjectInteractionRecordV1
  "ERL2-C-120", // AssistanceEventV1
];

/**
 * Contract identifiers no pack may read at any scope: selection openings, truth
 * commitments and reveals, judge expectations, validity results and every
 * terminal artifact.  Reading these would let a pack see the answer or the
 * verdict it is supposed to be measured against.
 */
export const FORBIDDEN_INPUT_CONTRACT_IDS: readonly string[] = [
  "ERL2-C-005", // JudgeJourneyExpectationV1
  "ERL2-C-021", // SelectionRequestV2
  "ERL2-C-043", // PreEnvironmentValidityResultV1
  "ERL2-C-044", // EnvironmentValidityResultV1
  "ERL2-C-045", // ValidityResultV1
  "ERL2-C-053", // GenericEvaluationIndexV1
  "ERL2-C-076", // EligibilityPoolEntryV2
  "ERL2-C-077", // SelectedChallengeJourneyBindingV1
  "ERL2-C-082", // SelectionCommitmentV2
  "ERL2-C-088", // ThresholdRevealReceiptV1
];

/**
 * Generic metric identifiers reserved by the Lab.  A pack addition may not
 * overwrite one (design v2 §17: "pack additions cannot overwrite generic metric
 * IDs"); it may only *reference* them.
 *
 * Re-exported from the single authoritative registry in `@erl2/contracts` so the
 * SDK and the evaluator core cannot drift.  The SDK previously kept its own copy
 * that had fallen two ids behind core (`authority-scope`,
 * `mutation-compensation`), letting `certifyPack` pass a neutered generic metric
 * (review §11.7).
 */
export const RESERVED_GENERIC_METRIC_IDS: readonly string[] = RESERVED_GENERIC_METRIC_IDS_CANONICAL;

// -- 2. authoring types ------------------------------------------------------

/** Injected canonical hasher; see the module comment. */
export type CanonicalHasher = (value: object) => Hash;

export interface CertifyPackOptions {
  readonly body: EvaluationPackBodyV1;
  readonly metricDefinitions: readonly MetricDefinitionV1[];
  /** Product names a subject-neutral pack must never contain. */
  readonly forbiddenSubjectTokens: readonly string[];
  readonly certifierId: string;
  readonly certifiedAt: `${string}Z`;
  readonly hash: CanonicalHasher;
}

/**
 * The declarative pack surface an author writes.  It is deliberately a *type*
 * over the generated contract types rather than a class with methods: a pack
 * has no behaviour to invoke.
 */
export interface DeclarativePack {
  readonly body: EvaluationPackBodyV1;
  readonly metrics: readonly MetricDefinitionV1[];
}

/** Convenience re-exports so a pack author never hand-writes a wire type. */
export type {
  ClaimScope,
  EvaluationPackAssertionV1,
  EvaluationPackBodyV1,
  EvaluationPackManifestV1,
  EvaluationPredicateId,
  MetricCanonicalOrdering,
  MetricDefinitionV1,
  MetricInputSelector,
  MetricThresholdClass,
  Signature,
};

// -- 3. certification --------------------------------------------------------

function check(
  checkId: string,
  passed: boolean,
  reasonCode: string,
  detail?: string,
): EvaluationPackCertificationFindingV1 {
  return {
    check_id: checkId,
    passed,
    reason_code: reasonCode,
    ...(detail === undefined ? {} : { detail: detail.slice(0, 512) }),
  };
}

/** Every free-text or identifier byte a scanner should look at. */
function scannableText(body: EvaluationPackBodyV1, metrics: readonly MetricDefinitionV1[]): string {
  return JSON.stringify({ body, metrics }).toLowerCase();
}

/**
 * Matches a prohibited token against the pack bytes.
 *
 * A bare identifier such as `eval` matches only as a whole word: the schema
 * version `evaluation-pack-body/v1` legitimately contains those four letters,
 * and reporting that as an attempted `eval` call would be a false refusal that
 * teaches reviewers to ignore the scanner. Tokens that already carry
 * punctuation — `node:fs`, `require(`, `Math.random` — match as substrings,
 * because they cannot occur innocently.
 */
function tokenPresent(haystack: string, token: string): boolean {
  const lowered = token.toLowerCase();
  if (/[^a-z0-9]/i.test(token)) return haystack.includes(lowered);
  return new RegExp(`(?<![a-z0-9_])${lowered}(?![a-z0-9_])`).test(haystack);
}

/**
 * Certifies a data-only pack body.
 *
 * Returns a receipt whose `passed` is the conjunction of every check.  It never
 * throws for a *failing* pack — a failed receipt is retained evidence — but it
 * does throw for a structurally impossible input, because that is a programming
 * error rather than a pack defect.
 */
export function certifyPack(options: CertifyPackOptions): EvaluationPackCertificationReceiptV1 {
  const { body, metricDefinitions, forbiddenSubjectTokens } = options;
  const text = scannableText(body, metricDefinitions);
  const checks: EvaluationPackCertificationFindingV1[] = [];

  // 3.1 no product name in a subject-neutral pack.
  const namedSubjects = forbiddenSubjectTokens.filter((t) => tokenPresent(text, t));
  checks.push(
    check(
      "no-subject-vocabulary-in-domain-scope",
      body.scope === "subject_deep" || namedSubjects.length === 0,
      CODES.PACK_SUBJECT_VOCABULARY_IN_DOMAIN_SCOPE,
      namedSubjects.length === 0 ? undefined : `named subjects: ${namedSubjects.join(", ")}`,
    ),
  );

  // 3.2 a domain-scoped pack may not bind a subject id at all.
  checks.push(
    check(
      "domain-scope-declares-no-subject-id",
      body.scope === "subject_deep" || body.subject_id === undefined,
      CODES.PACK_CANDIDATE_TOKEN_PRESENT,
    ),
  );

  // 3.3 no prohibited API string anywhere in the pack bytes.
  const reachedApis = PROHIBITED_CORE_APIS.filter((api) => tokenPresent(text, api));
  checks.push(
    check(
      "no-prohibited-core-api-reference",
      reachedApis.length === 0,
      CODES.PACK_PROHIBITED_API_REFERENCE,
      reachedApis.length === 0 ? undefined : `reached: ${reachedApis.join(", ")}`,
    ),
  );

  // 3.4 no candidate-specific shortcut predicate.
  const shortcuts = SHORTCUT_TOKENS.filter((t) => tokenPresent(text, t));
  checks.push(
    check(
      "no-candidate-shortcut-predicate",
      shortcuts.length === 0,
      CODES.PACK_SHORTCUT_PREDICATE_REFUSED,
      shortcuts.length === 0 ? undefined : `shortcuts: ${shortcuts.join(", ")}`,
    ),
  );

  // 3.5 every metric the body references is defined, and no definition is
  //     orphaned.  An unknown metric id would otherwise silently evaluate to
  //     nothing.
  const definedIds = new Set(metricDefinitions.map((m) => m.metric_id));
  const unknown = body.metric_ids.filter((id) => !definedIds.has(id));
  checks.push(
    check(
      "every-referenced-metric-is-defined",
      unknown.length === 0,
      CODES.PACK_UNKNOWN_METRIC_ID,
      unknown.length === 0 ? undefined : `unknown: ${unknown.join(", ")}`,
    ),
  );

  // 3.6 a pack addition may not redefine a reserved generic metric with
  //     different bytes.  Referencing one is fine; overriding it is not.
  const referencedIds = new Set(body.metric_ids);
  const overrides = metricDefinitions
    .filter((m) => RESERVED_GENERIC_METRIC_IDS.includes(m.metric_id))
    .filter((m) => !referencedIds.has(m.metric_id));
  checks.push(
    check(
      "no-generic-metric-override",
      overrides.length === 0,
      CODES.PACK_GENERIC_METRIC_OVERRIDE,
      overrides.length === 0 ? undefined : `overridden: ${overrides.map((m) => m.metric_id).join(", ")}`,
    ),
  );

  // 3.7 declared inputs stay inside the frozen-evidence set and never reach a
  //     selection opening, judge expectation or validity artifact.
  const notPermitted = body.input_contract_ids.filter(
    (id) => !PERMITTED_INPUT_CONTRACT_IDS.includes(id),
  );
  const forbiddenInputs = body.input_contract_ids.filter((id) =>
    FORBIDDEN_INPUT_CONTRACT_IDS.includes(id),
  );
  checks.push(
    check(
      "declared-inputs-are-frozen-evidence",
      notPermitted.length === 0,
      CODES.PACK_INPUT_CONTRACT_NOT_PERMITTED,
      notPermitted.length === 0 ? undefined : `not permitted: ${notPermitted.join(", ")}`,
    ),
  );
  checks.push(
    check(
      "no-validity-selection-or-truth-input",
      forbiddenInputs.length === 0,
      CODES.PACK_VALIDITY_AUTHORITY_REFUSED,
      forbiddenInputs.length === 0 ? undefined : `forbidden: ${forbiddenInputs.join(", ")}`,
    ),
  );

  // 3.8 a pack proposes only subject-plane finding categories.  Ownership of a
  //     Lab, adapter, dependency or evaluator failure is never a pack decision
  //     (design v2 §17 ownership table).  The schema already restricts the
  //     enum; this check is the executable statement of why.
  const ownershipViolations = body.assertions.filter(
    (a: EvaluationPackAssertionV1) => !a.finding_category.startsWith("subject_"),
  );
  checks.push(
    check(
      "pack-proposes-only-subject-categories",
      ownershipViolations.length === 0,
      CODES.PACK_OWNERSHIP_NOT_A_PACK_DECISION,
    ),
  );

  // 3.9 every assertion predicate and metric predicate is in the closed
  //     vocabulary.  The schema enforces this too; a hit here means a caller
  //     bypassed validation.
  const declaredPredicates = new Set<string>([
    ...body.assertions.map((a: EvaluationPackAssertionV1) => a.predicate),
    ...metricDefinitions.map((m) => m.numerator_predicate),
  ]);
  const undeclared = [...declaredPredicates].filter((p) => !KNOWN_PREDICATES.has(p));
  checks.push(
    check(
      "predicates-come-from-the-closed-vocabulary",
      undeclared.length === 0,
      CODES.PACK_UNDECLARED_VOCABULARY,
      undeclared.length === 0 ? undefined : `undeclared: ${undeclared.join(", ")}`,
    ),
  );

  // 3.10 hard-safety metrics may not be relaxed by the pack: their bound is
  //      fixed by the Lab, so a pack that ships a hard-safety metric with a
  //      different bound is attempting a threshold mutation.
  const relaxed = metricDefinitions.filter(
    (m) =>
      m.threshold_class === "hard_safety" &&
      m.threshold !== undefined &&
      !(m.threshold.comparator === "at_most" && m.threshold.bound === "0") &&
      !(m.threshold.comparator === "equals" && (m.threshold.bound === "0" || m.threshold.bound === "1")),
  );
  checks.push(
    check(
      "hard-safety-thresholds-are-not-relaxed",
      relaxed.length === 0,
      CODES.PACK_THRESHOLD_MUTATION_REFUSED,
      relaxed.length === 0 ? undefined : `relaxed: ${relaxed.map((m) => m.metric_id).join(", ")}`,
    ),
  );

  const receiptBase = {
    schema_version: "evaluation-pack-certification-receipt/v1" as const,
    pack_id: body.pack_id,
    pack_artifact_hash: options.hash(body),
    certifier_id: options.certifierId,
    checks,
    forbidden_token_list_hash: options.hash({
      forbidden_subject_tokens: [...forbiddenSubjectTokens].sort(),
      prohibited_core_apis: [...PROHIBITED_CORE_APIS].sort(),
      shortcut_tokens: [...SHORTCUT_TOKENS].sort(),
    }),
    passed: checks.every((c) => c.passed),
    certified_at: options.certifiedAt,
  };
  return { ...receiptBase, core_hash: options.hash(receiptBase) };
}

/** Throws when a pack was not certified, so a caller cannot ignore the receipt. */
export function assertPackCertified(receipt: EvaluationPackCertificationReceiptV1): void {
  if (!receipt.passed) {
    const failed = receipt.checks.filter((c) => !c.passed);
    throw new Erl2Error(
      failed[0]?.reason_code ?? CODES.PACK_NOT_CERTIFIED,
      `pack ${receipt.pack_id} failed certification: ${failed.map((c) => c.check_id).join(", ")}`,
      { owner: "evaluator" },
    );
  }
}

/**
 * The closed predicate vocabulary, mirrored from the schema so the SDK can scan
 * without loading a validator.  `tests/contract` proves the two agree.
 */
export const KNOWN_PREDICATES: ReadonlySet<string> = new Set<EvaluationPredicateId>([
  "always_included",
  "citation_resolves_in_canonical_envelope",
  "citation_locator_reachable",
  "claim_exactly_supported_by_truth_fact",
  "causal_claim_has_declared_supporting_association",
  "unknown_claim_matches_unrevealed_truth_gap",
  "unavailable_source_explicitly_disclosed",
  "claim_carries_no_credential_material",
  "claim_authority_within_declared_ceiling",
  "required_fact_supported_by_some_claim",
  "step_outcome_status_is",
  "declared_mutation_has_compensation",
]);
