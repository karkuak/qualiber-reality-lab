/**
 * `erl2-mandatory-closure/v1`, environment branch (design v2 §14, ERL2-FR-020,
 * ERL2-AC-023/031).
 *
 * Same algorithm as the pre-environment derivation in `closure.ts`, over the
 * environment role set: the required closure comes from the hash-chained
 * lifecycle and the derived terminal stage, never from an array the producer
 * put inside the run record.  A retained artifact the derivation does not reach
 * is a rejected extra; a derived role with no artifact is a missing role;
 * either makes the verdict invalid.
 *
 * The branch is also *mutually exclusive* with the pre-environment one.  A run
 * that produced a `pre-environment-cleanup` never reached an environment, and a
 * run that produced an `environment-restoration` cannot close through the
 * pre-environment record — the forbidden-role lists on both sides make the
 * crossover a refusal rather than a silently wrong closure.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type EnvironmentJourneyIntent,
  type EnvironmentLabRunRecordV1,
  type Hash,
  type LabLifecycleEventV1,
  type MandatoryGraphClosureReportV1,
} from "@erl2/contracts";
import { verifyLifecycleChain } from "@erl2/core";
import { coreHash } from "@erl2/integrity";
import type { ArtifactIndex } from "./artifactIndex.js";
import type { ClosureInput } from "./closure.js";

/** Roles a valid environment terminal must close, in derivation order. */
const ENVIRONMENT_ROLES = [
  "acquisition-preregistration",
  "acquisition-source-manifest",
  "acquisition-record",
  "package-verification-record",
  "subject-package-manifest",
  "selection-request",
  "eligibility-pool-manifest",
  "selection-commitment",
  "selected-challenge-journey-binding",
  "selection-proof",
  "selection-verification-receipt",
  "environment-reservation-lease",
  "environment-resource-inventory",
  "environment-baseline",
  "execution-plan",
  "journey-step-outcome",
  "subject-output-manifest",
  "journey-result",
  "domain-result",
  "precleanup-result-join",
  "environment-restoration",
  "teardown-verification",
  "validity-result",
  "generic-evaluation-index",
  "run-record",
  "final-attestation",
  "signer-inventory",
] as const;

/**
 * Roles a valid environment terminal MAY produce.
 *
 * Capture roles are optional as a *group*: an environment journey that
 * terminated before `traffic_or_journey_started` never realized a cutoff, so
 * requiring an observation would force a synthetic one — precisely what design
 * v2 §26 forbids.  When any of them is present the run record must cite it, and
 * `assertCaptureGroupComplete` refuses a partial group.
 */
const ENVIRONMENT_OPTIONAL_ROLES = [
  "finding",
  "metric-result",
  "judge-expectation-reveal",
  "observation-bundle",
  "canonical-evidence-envelope",
  "adapter-translation-receipt",
  "source-snapshot",
  "environment-operation-receipt",
  "mutation-receipt",
  "compensation-receipt",
] as const;

/** The three capture roles that must appear together or not at all. */
const CAPTURE_GROUP = [
  "observation-bundle",
  "canonical-evidence-envelope",
  "adapter-translation-receipt",
] as const;

/**
 * Roles that can only exist on the pre-environment branch.  Their presence
 * means the run finalized through the wrong terminal variant.
 */
const ENVIRONMENT_FORBIDDEN_ROLES = ["pre-environment-cleanup"] as const;

/** Roles the finalizer itself publishes; excluded from the pre-signature derivation. */
const FINALIZER_PRODUCED_ROLES: readonly string[] = [
  "run-record",
  "final-attestation",
  "signer-inventory",
];

/**
 * Schemas that support verification but are not themselves closure members.
 *
 * Identical in spirit to the pre-environment set, plus the environment-only
 * supporting artifacts: driver manifests, substrate locks, reservation and
 * randomness evidence a reader needs to re-derive the chain but which are not
 * separately roled outputs of the terminal.
 */
const SUPPORTING_SCHEMAS: ReadonlySet<string> = new Set([
  "trust-policy-manifest/v2",
  "trusted-timestamp-checkpoint/v1",
  "lab-lifecycle-event/v1",
  "mandatory-graph-closure-report/v1",
  "trust-verification-report/v2",
  "acquisition-preregistration-verification-receipt/v1",
  "subject-adapter-manifest/v1",
  "generic-run-policy/v1",
  "subject-visible-journey-step/v1",
  "journey-step-commitment/v1",
  "exposure-event/v1",
  "environment-driver-manifest/v1",
  "substrate-lock/v1",
  "environment-archetype/v1",
  "challenge-manifest/v1",
  "journey-definition/v1",
  "eligibility-pool-entry/v2",
  "external-beacon-randomness-policy/v1",
  "external-beacon-randomness-receipt/v1",
  "randomness-source-trust-verification-report/v1",
  "threshold-reveal-receipt/v1",
  "selection-role-separation-audit/v1",
  "journey-selection-policy/v1",
  "comparison-policy/v1",
  "cutoff-policy/v1",
  "monotonic-clock-domain/v1",
  // The cutoff's three independently signed inputs. A reader must hold them to
  // re-derive `ObservationBundleV2.cutoff`, but none of them is a separately
  // roled output of the terminal (Slice 6.5-B, ADR-ERL2-021).
  "challenge-activation-receipt/v1",
  "traffic-process-start-receipt/v1",
  "runtime-milestone/v1",
  "evidence-equivalence-profile/v1",
  "metric-definition/v1",
]);

function derivedRolesFromLifecycle(events: readonly LabLifecycleEventV1[]): Map<string, Hash[]> {
  const roles = new Map<string, Hash[]>();
  for (const event of events) {
    for (const produced of event.produced) {
      const bucket = roles.get(produced.artifact_role) ?? [];
      bucket.push(produced.artifact_core_hash);
      roles.set(produced.artifact_role, bucket);
    }
  }
  return roles;
}

function requireExactlyOne(roles: Map<string, Hash[]>, role: string): Hash {
  const found = roles.get(role) ?? [];
  if (found.length !== 1) {
    throw new Erl2Error(
      found.length === 0 ? CODES.GRAPH_CLOSURE_MISSING_ROLE : CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      `role ${role} occurs ${String(found.length)} times in the lifecycle; exactly one is required`,
    );
  }
  return found[0] as Hash;
}

/**
 * Derives the terminal journey intent from lifecycle evidence alone.
 *
 * The environment branch terminates on whichever subject intent froze last, so
 * the stage is read out of the step submachine's derived event names rather
 * than out of the record that is being checked.
 */
export function deriveEnvironmentTerminalStage(
  events: readonly LabLifecycleEventV1[],
): EnvironmentJourneyIntent {
  const INTENT_BY_EVENT_PREFIX: Readonly<Record<string, EnvironmentJourneyIntent>> = {
    subject_install: "install",
    subject_config: "configure",
    subject_authentication: "authenticate",
    subject_connection: "connect",
    subject_discovery: "discover",
    subject_interaction: "exercise",
    subject_observation: "observe",
    subject_diagnosis: "diagnose_decide",
    subject_recovery: "recover",
    subject_upgrade: "upgrade",
    subject_rollback: "rollback",
    subject_uninstall: "remove",
  };
  const outcomes = events.filter((e) => e.event_type.endsWith("_outcome_frozen"));
  for (let i = outcomes.length - 1; i >= 0; i -= 1) {
    const type = (outcomes[i] as LabLifecycleEventV1).event_type;
    for (const [prefix, intent] of Object.entries(INTENT_BY_EVENT_PREFIX)) {
      if (type.startsWith(prefix)) return intent;
    }
  }
  throw new Erl2Error(
    CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
    "cannot derive an environment terminal stage: the lifecycle froze no environment-phase step outcome",
  );
}

/** Refuses a capture group that is present but incomplete. */
function assertCaptureGroupComplete(roles: Map<string, Hash[]>): void {
  const present = CAPTURE_GROUP.filter((role) => (roles.get(role) ?? []).length > 0);
  if (present.length !== 0 && present.length !== CAPTURE_GROUP.length) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_MISSING_ROLE,
      `the capture group is partial: ${present.join(", ")} present, ${CAPTURE_GROUP.filter((r) => !present.includes(r)).join(", ")} missing`,
    );
  }
}

/** The record members the derivation checks the lifecycle against, by role. */
function claimedByRole(
  record: EnvironmentLabRunRecordV1,
): Readonly<Record<string, Hash | undefined>> {
  return {
    "acquisition-preregistration": record.acquisition_preregistration_hash,
    "acquisition-source-manifest": record.acquisition_source_manifest_hash,
    "acquisition-record": record.acquisition_record_hash,
    "subject-package-manifest": record.subject_package_manifest_hash,
    "selection-request": record.selection_request_hash,
    "selection-verification-receipt": record.selection_receipt_hash,
    "selected-challenge-journey-binding": record.selected_challenge_journey_binding_hash,
    "execution-plan": record.plan_hash,
    "environment-resource-inventory": record.environment_instance_hash,
    "subject-output-manifest": record.subject_output_hash,
    "journey-result": record.journey_result_hash,
    "domain-result": record.domain_result_hash,
    "precleanup-result-join": record.precleanup_result_join_hash,
    "environment-restoration": record.environment_restoration_hash,
    "teardown-verification": record.teardown_hash,
    "generic-evaluation-index": record.generic_evaluation_index_hash,
    "observation-bundle": record.observation_hash,
    "canonical-evidence-envelope": record.canonical_evidence_envelope_hash,
    "adapter-translation-receipt": record.adapter_translation_receipt_hash,
  };
}

/**
 * Derives the closure for a valid environment terminal and checks the run
 * record against it.
 */
export function deriveEnvironmentClosure(
  input: ClosureInput,
): MandatoryGraphClosureReportV1 {
  const lifecycleHead = verifyLifecycleChain(input.lifecycle);
  const roles = derivedRolesFromLifecycle(input.lifecycle);

  for (const forbidden of ENVIRONMENT_FORBIDDEN_ROLES) {
    if ((roles.get(forbidden) ?? []).length > 0) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
        `an environment terminal cannot close over a ${forbidden}; that role belongs to the pre-environment branch`,
      );
    }
  }
  assertCaptureGroupComplete(roles);

  const runRecordHash = requireExactlyOne(roles, "run-record");
  const record = input.index.typed<EnvironmentLabRunRecordV1>(
    runRecordHash,
    "environment-lab-run-record/v1",
  );
  assertContract("EnvironmentLabRunRecordV1", record);

  const derivedStage = deriveEnvironmentTerminalStage(input.lifecycle);
  if (record.terminal_stage !== derivedStage) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      `record declares terminal stage ${record.terminal_stage}, lifecycle derives ${derivedStage}`,
    );
  }

  const publishingIndex = input.lifecycle.findIndex((e) =>
    e.produced.some(
      (p) => p.artifact_role === "run-record" && p.artifact_core_hash === runRecordHash,
    ),
  );
  const expectedHead =
    publishingIndex <= 0
      ? lifecycleHead
      : (input.lifecycle[publishingIndex - 1] as { core_hash: Hash }).core_hash;
  if (record.lifecycle_head_hash !== expectedHead) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "run record does not reference the lifecycle head derived at its freeze point",
    );
  }

  const expected = claimedByRole(record);
  const ordered: { role: string; ordered_hashes: readonly Hash[] }[] = [];
  const missing: string[] = [];
  const required = new Set<Hash>();

  for (const role of ENVIRONMENT_ROLES) {
    const derived = roles.get(role) ?? [];
    if (derived.length === 0) {
      missing.push(role);
      continue;
    }
    for (const hash of derived) {
      input.index.get(hash);
      required.add(hash);
    }
    ordered.push({ role, ordered_hashes: derived });

    const claimed = expected[role];
    if (claimed !== undefined && !derived.includes(claimed)) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_MISSING_ROLE,
        `run record claims a ${role} the lifecycle never produced`,
      );
    }
    if (claimed === undefined && role in expected) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_MISSING_ROLE,
        `run record omits the ${role} the lifecycle produced`,
      );
    }
  }

  for (const role of ENVIRONMENT_OPTIONAL_ROLES) {
    const derived = roles.get(role) ?? [];
    if (derived.length === 0) continue;
    for (const hash of derived) {
      input.index.get(hash);
      required.add(hash);
    }
    ordered.push({ role, ordered_hashes: derived });
    const claimed = expected[role];
    if (claimed !== undefined && !derived.includes(claimed)) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_MISSING_ROLE,
        `run record claims a ${role} the lifecycle never produced`,
      );
    }
  }

  const bundles = input.index.ofSchema("public-verification-bundle/v2");
  if (bundles.length > 1) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      `a terminal retains ${String(bundles.length)} public bundles; exactly one may exist`,
    );
  }
  for (const bundle of bundles) required.add(bundle.coreHash);

  const rejected = input.index
    .all()
    .filter((a) => !required.has(a.coreHash))
    .filter((a) => !SUPPORTING_SCHEMAS.has(a.schemaVersion))
    .map((a) => a.coreHash);

  const report = {
    schema_version: "mandatory-graph-closure-report/v1" as const,
    algorithm: "erl2-mandatory-closure/v1" as const,
    run_id: record.run_id,
    derived_terminal_phase: derivedStage,
    derived_terminal_variant: "environment" as const,
    lifecycle_head_hash: lifecycleHead,
    ...(input.verifiedTrustHeadHash === undefined
      ? {}
      : { verified_trust_head_hash: input.verifiedTrustHeadHash }),
    required_hashes_by_role: ordered.map((r) => ({
      role: r.role,
      ordered_hashes: [...r.ordered_hashes],
    })),
    rejected_extra_hashes: rejected,
    missing_roles: missing,
    verdict: (missing.length === 0 && rejected.length === 0 ? "valid" : "invalid") as
      | "valid"
      | "invalid",
    verified_at: input.verifiedAt,
    verifier_release_hash: input.verifierReleaseHash,
  };
  return assertContract<MandatoryGraphClosureReportV1>("MandatoryGraphClosureReportV1", {
    ...report,
    core_hash: coreHash(report),
  });
}

/**
 * How complete the environment closure is *before* the validity result and the
 * generic index exist.
 *
 * The environment validity gate set includes `mandatory-graph-closed`, but the
 * closure cannot be derived against the terminal run record at that point: the
 * record cites the index, the index cites the validity result, and the validity
 * result is what is being computed. Rather than inventing a second, weaker
 * completeness check for that moment, this runs the *same* role derivation with
 * the three finalizer-produced roles and the two not-yet-produced ones excluded.
 * A role missing here is missing in the final derivation too.
 */
export function deriveEnvironmentClosureProgress(
  input: ClosureInput,
): { readonly missingRoles: readonly string[]; readonly extraHashes: readonly Hash[] } {
  verifyLifecycleChain(input.lifecycle);
  const roles = derivedRolesFromLifecycle(input.lifecycle);
  const notYetProduced = new Set([
    ...FINALIZER_PRODUCED_ROLES,
    "validity-result",
    "generic-evaluation-index",
  ]);

  for (const forbidden of ENVIRONMENT_FORBIDDEN_ROLES) {
    if ((roles.get(forbidden) ?? []).length > 0) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
        `an environment terminal cannot close over a ${forbidden}; that role belongs to the pre-environment branch`,
      );
    }
  }
  assertCaptureGroupComplete(roles);

  const missing: string[] = [];
  const required = new Set<Hash>();
  for (const role of ENVIRONMENT_ROLES) {
    if (notYetProduced.has(role)) continue;
    const derived = roles.get(role) ?? [];
    if (derived.length === 0) {
      missing.push(role);
      continue;
    }
    for (const hash of derived) {
      input.index.get(hash);
      required.add(hash);
    }
  }
  for (const role of ENVIRONMENT_OPTIONAL_ROLES) {
    for (const hash of roles.get(role) ?? []) {
      input.index.get(hash);
      required.add(hash);
    }
  }
  const extraHashes = input.index
    .all()
    .filter((a) => !required.has(a.coreHash))
    .filter((a) => !SUPPORTING_SCHEMAS.has(a.schemaVersion))
    .map((a) => a.coreHash);
  return { missingRoles: missing, extraHashes };
}

export interface EnvironmentPreFinalizationVerdict {
  readonly verdict: "valid" | "invalid";
  readonly missingRoles: readonly string[];
  readonly extraHashes: readonly Hash[];
  readonly derivedTerminalStage: EnvironmentJourneyIntent;
}

/**
 * Derives the mandatory closure the environment finalizer must check **before**
 * it signs.
 *
 * Same derivation as `deriveEnvironmentClosure`, minus the three roles the
 * finalizer is about to publish, with the candidate record supplied directly
 * because it has not been published yet.  Everything it checks comes from the
 * hash-chained lifecycle, so a record that omits or invents a
 * mandatory-reachable artifact is caught here and the run never reaches a
 * signature (design v2 §14, ERL2-AC-031).
 */
export function deriveEnvironmentPreFinalizationClosure(
  input: ClosureInput & { readonly runRecord: EnvironmentLabRunRecordV1 },
): EnvironmentPreFinalizationVerdict {
  verifyLifecycleChain(input.lifecycle);
  const roles = derivedRolesFromLifecycle(input.lifecycle);
  const record = input.runRecord;

  for (const forbidden of ENVIRONMENT_FORBIDDEN_ROLES) {
    if ((roles.get(forbidden) ?? []).length > 0) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
        `an environment terminal cannot close over a ${forbidden}; that role belongs to the pre-environment branch`,
      );
    }
  }
  for (const premature of FINALIZER_PRODUCED_ROLES) {
    if ((roles.get(premature) ?? []).length > 0) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
        `role ${premature} is already published; this run has finalized once already`,
      );
    }
  }
  assertCaptureGroupComplete(roles);

  const derivedStage = deriveEnvironmentTerminalStage(input.lifecycle);
  if (record.terminal_stage !== derivedStage) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      `record declares terminal stage ${record.terminal_stage}, lifecycle derives ${derivedStage}`,
    );
  }

  const claimed = claimedByRole(record);
  const missing: string[] = [];
  const required = new Set<Hash>([coreHash(record)]);

  for (const role of ENVIRONMENT_ROLES) {
    if (FINALIZER_PRODUCED_ROLES.includes(role)) continue;
    const derived = roles.get(role) ?? [];
    if (derived.length === 0) {
      missing.push(role);
      continue;
    }
    for (const hash of derived) {
      input.index.get(hash);
      required.add(hash);
    }
    const claim = claimed[role];
    if (claim !== undefined && !derived.includes(claim)) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_MISSING_ROLE,
        `run record claims a ${role} the lifecycle never produced`,
      );
    }
    if (claim === undefined && role in claimed) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_MISSING_ROLE,
        `run record omits the ${role} the lifecycle produced`,
      );
    }
  }

  for (const role of ENVIRONMENT_OPTIONAL_ROLES) {
    for (const hash of roles.get(role) ?? []) {
      input.index.get(hash);
      required.add(hash);
    }
  }

  const extras = input.index
    .all()
    .filter((a) => !required.has(a.coreHash))
    .filter((a) => !SUPPORTING_SCHEMAS.has(a.schemaVersion))
    .map((a) => a.coreHash);

  return {
    verdict: missing.length === 0 && extras.length === 0 ? "valid" : "invalid",
    missingRoles: missing,
    extraHashes: extras,
    derivedTerminalStage: derivedStage,
  };
}

/**
 * Reports which terminal branch a lifecycle actually reached.
 *
 * The public verifier calls this before choosing a derivation, so a bundle
 * declaring `terminal_variant: "environment"` over a pre-environment lifecycle
 * (or the reverse) is a typed crossover refusal rather than a closure that
 * silently checks the wrong role set.
 */
export function deriveTerminalVariant(
  index: ArtifactIndex,
): "pre_environment" | "environment" {
  const environmentRecords = index.ofSchema("environment-lab-run-record/v1");
  const preEnvironmentRecords = index.ofSchema("pre-environment-lab-run-record/v1");
  if (environmentRecords.length > 0 && preEnvironmentRecords.length > 0) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "a run retains both a pre-environment and an environment run record; exactly one terminal variant may exist",
    );
  }
  if (environmentRecords.length > 1 || preEnvironmentRecords.length > 1) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      "a run retains more than one terminal run record",
    );
  }
  return environmentRecords.length === 1 ? "environment" : "pre_environment";
}
