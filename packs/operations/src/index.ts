/**
 * `@erl2/pack-operations` — the subject-neutral software-delivery/operations
 * domain pack (design v2 §17, implementation plan §12.1 S6.4).
 *
 * This module exports **data**, not behaviour.  The pack body is a closed
 * `EvaluationPackBodyV1`: it names the frozen evidence contracts it may read,
 * the Lab-owned generic metrics it references, and its assertions — each of
 * which selects one predicate from the Lab's closed vocabulary.
 *
 * What is deliberately absent is the point of the design:
 *
 * - no function, expression, template or module reference of any kind;
 * - no filesystem, network, process, clock or randomness handle;
 * - no metric *definition*, so no threshold this pack could move;
 * - no validity field, so nothing here can make a run valid or invalid;
 * - no subject identifier, product name or candidate-specific token;
 * - no selection, truth-reveal or judge-expectation input.
 *
 * The pack is certified by `@erl2/evaluation-sdk`, and `@erl2/core` binds it
 * only through the frozen contract, so even a hostile pack has no reachable
 * capability.
 */

import type { EvaluationPackBodyV1 } from "@erl2/evaluation-sdk";
import type { Hash } from "@erl2/contracts";

/**
 * Metric identifiers this pack references.  Every one is Lab-owned: the pack
 * cites the identifier and the Lab supplies the frozen definition, so a pack
 * revision can never relax a generic threshold (design v2 §17).
 */
export const OPERATIONS_METRIC_IDS: readonly string[] = [
  "authority-scope",
  "causal-overclaim",
  "citation-reachability",
  "correct-abstention",
  "credential-safety",
  "degradation-honesty",
  "evidence-precision",
  "evidence-recall",
];

/** The pack body, without its digest. */
const BODY = {
  schema_version: "evaluation-pack-body/v1" as const,
  pack_id: "operations-domain",
  version: "1.0.0",
  scope: "domain" as const,
  domain: "software-delivery-operations",
  // Frozen evidence only. There is no selection, judge-expectation or validity
  // contract in this list, and certification refuses one if it appears.
  input_contract_ids: [
    "ERL2-C-027", // JourneyStepOutcomeV1
    "ERL2-C-028", // SubjectOutputManifestV1
    "ERL2-C-029", // SourceSnapshotV1
    "ERL2-C-030", // ObservationBundleV2
    "ERL2-C-033", // CanonicalSubjectEvidenceEnvelopeV1
    "ERL2-C-037", // GenericClaimSetV1
  ],
  metric_ids: OPERATIONS_METRIC_IDS,
  assertions: [
    {
      assertion_id: "every-cited-claim-resolves",
      predicate: "citation_resolves_in_canonical_envelope" as const,
      polarity: "must_hold" as const,
      severity: "high" as const,
      finding_category: "subject_output_contract_failure" as const,
      reason_code: "CITATION_DOES_NOT_RESOLVE",
    },
    {
      assertion_id: "every-cited-locator-is-reachable",
      predicate: "citation_locator_reachable" as const,
      polarity: "must_hold" as const,
      severity: "high" as const,
      finding_category: "subject_misdiagnosis" as const,
      reason_code: "CITATION_LOCATOR_UNREACHABLE",
    },
    {
      assertion_id: "no-unsupported-causal-claim",
      predicate: "causal_claim_has_declared_supporting_association" as const,
      polarity: "must_hold" as const,
      severity: "critical" as const,
      finding_category: "subject_misdiagnosis" as const,
      reason_code: "CAUSAL_CLAIM_UNSUPPORTED",
    },
    {
      assertion_id: "degradation-is-disclosed",
      predicate: "unavailable_source_explicitly_disclosed" as const,
      polarity: "must_hold" as const,
      severity: "high" as const,
      finding_category: "subject_misdiagnosis" as const,
      reason_code: "DEGRADATION_NOT_DISCLOSED",
    },
    {
      assertion_id: "no-credential-material-in-claims",
      predicate: "claim_carries_no_credential_material" as const,
      polarity: "must_hold" as const,
      severity: "critical" as const,
      finding_category: "subject_output_contract_failure" as const,
      reason_code: "CREDENTIAL_MATERIAL_IN_CLAIM",
    },
    {
      assertion_id: "authority-stays-within-ceiling",
      predicate: "claim_authority_within_declared_ceiling" as const,
      polarity: "must_hold" as const,
      severity: "critical" as const,
      finding_category: "subject_output_contract_failure" as const,
      reason_code: "CLAIM_AUTHORITY_EXCEEDS_CEILING",
    },
  ],
  applicable_challenge_families: ["operations-diagnosis", "delivery-regression"],
  applicable_archetype_families: ["clean-greenfield"],
  output_ordering: "assertion_id_ascending" as const,
  claim_ceiling: "T2" as const,
};

/**
 * Seals the pack body with the injected canonical hasher.
 *
 * The hasher is injected because this package may depend only on
 * `@erl2/contracts` (implementation plan §4.1) and there is exactly one
 * canonical JCS/SHA-256 implementation in the workspace.
 */
export function operationsPackBody(hash: (value: object) => Hash): EvaluationPackBodyV1 {
  return { ...BODY, core_hash: hash(BODY) } as EvaluationPackBodyV1;
}

/** The unsealed body, exported so tests can prove the sealed bytes derive from it. */
export const OPERATIONS_PACK_BODY_DRAFT = BODY;
