/**
 * `erl2-mandatory-closure/v1` — verifier-derived mandatory artifact closure
 * (design v2 §14, ERL2-FR-020, ERL2-AC-023/031).
 *
 * The algorithm derives the required closure from the lifecycle chain, the
 * terminal stage and the cleanup variant.  Producer-supplied arrays inside the
 * run record, attestation or bundle are treated as *claims to check*, never as
 * the source of the required set.  An artifact that is retained but not derived
 * is reported as a rejected extra; a derived role with no artifact is a missing
 * role; either makes the verdict invalid.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type Hash,
  type InvalidLabRunRecordV1,
  type LabLifecycleEventV1,
  type MandatoryGraphClosureReportV1,
  type PreEnvironmentLabRunRecordV1,
} from "@erl2/contracts";
import { verifyLifecycleChain } from "@erl2/core";
import { coreHash } from "@erl2/integrity";
import type { ArtifactIndex } from "./artifactIndex.js";

/**
 * The adapter host's per-operation adjudication records, as roles.
 *
 * Shared by both terminal branches because both dispatch subjects: the
 * pre-environment walk runs `acquire` and `verify_package`, the environment
 * walk runs those and the journey. A run that never drives an out-of-process
 * adapter produces none of them, which is why they are optional; a run that does
 * produces one set per dispatch, and every one is derived from the lifecycle
 * and resolved against the retained set like any other role.
 *
 * They are **roles**, deliberately, and not entries in `SUPPORTING_SCHEMAS`.
 * A supporting schema is exempt from reachability: adding these there would have
 * admitted *any* retained artifact of those schema versions, including one no
 * event ever produced. As roles they must be produced to be admitted, and must
 * be retained to be produced — which is the property the evidence is for.
 *
 * Each name is prefixed `adapter-` even where an unprefixed role already exists
 * (`mutation-receipt`, `compensation-receipt`). Those belong to the *environment
 * driver*, and one of them is load-bearing: `challenge_activation` is satisfied
 * by `hasRole("mutation-receipt")`, so letting an adapter's mutation land under
 * that name would let a subject's own declaration satisfy the Lab's activation
 * prerequisite.
 */
export const ADAPTER_HOST_EVIDENCE_ROLES = [
  "adapter-response-envelope",
  "adapter-sandbox-invocation-manifest",
  "adapter-sandbox-invocation-result",
  "adapter-capability-grant",
  "adapter-diagnostics-manifest",
  "adapter-egress-decision-receipt",
  "adapter-credential-use-receipt",
  "adapter-mutation-intent",
  "adapter-mutation-receipt",
  "adapter-compensation-receipt",
] as const;

/** Roles a valid pre-environment terminal must close, in derivation order. */
const PRE_ENVIRONMENT_ROLES = [
  "acquisition-preregistration",
  "acquisition-source-manifest",
  "acquisition-record",
  "package-verification-record",
  "journey-step-outcome",
  "subject-output-manifest",
  "journey-result",
  "domain-result",
  "precleanup-result-join",
  "pre-environment-cleanup",
  "validity-result",
  "generic-evaluation-index",
  "run-record",
  "final-attestation",
  "signer-inventory",
] as const;

/**
 * Roles a valid pre-environment terminal MAY produce.  When the lifecycle
 * produced one it belongs to the closure — an uncited retained artifact is a
 * rejected extra — but its absence is not a missing role.
 */
const PRE_ENVIRONMENT_OPTIONAL_ROLES = [
  "finding",
  "metric-result",
  "judge-expectation-reveal",
  ...ADAPTER_HOST_EVIDENCE_ROLES,
] as const;

/**
 * Roles that can only exist on the environment branch.  A `subject-package-
 * manifest` is produced only by a *successful* package verification, whose one
 * authorized continuation is challenge preregistration (design v2 §12,
 * ADR-ERL2-013).  `PreEnvironmentLabRunRecordV1` has no member that could cite
 * it, so its presence here means the run finalized through an unauthorized
 * early terminal.
 */
const PRE_ENVIRONMENT_FORBIDDEN_ROLES = [
  "subject-package-manifest",
  "selection-request",
  "selection-verification-receipt",
  "selected-challenge-journey-binding",
  "environment-resource-inventory",
  "environment-baseline",
  "observation-bundle",
  "canonical-evidence-envelope",
  "environment-restoration",
  "teardown-verification",
  // ADR-ERL2-031 §6: an evidence window is a statement about an environment run
  // that started traffic. A pre-environment terminal reaches neither, so a
  // commitment on that branch means the run finalized through the wrong variant.
  "evidence-window-commitment",
] as const;

/**
 * Roles the finalizer itself publishes.  They cannot exist while the finalizer
 * is still deciding whether to publish them, so the pre-finalization derivation
 * below excludes them and the full derivation above requires them.
 */
const FINALIZER_PRODUCED_ROLES: readonly string[] = [
  "run-record",
  "final-attestation",
  "signer-inventory",
];

export interface DerivedRole {
  readonly role: string;
  readonly ordered_hashes: readonly Hash[];
}

export interface ClosureInput {
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly index: ArtifactIndex;
  readonly verifierReleaseHash: Hash;
  readonly verifiedAt: string;
  readonly verifiedTrustHeadHash?: Hash;
}

/**
 * Groups every artifact the lifecycle says was produced, by its declared role.
 * The lifecycle chain is verified first, so a forged `produced` entry would
 * have to break the hash chain.
 */
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
 * Derives the closure for a valid pre-environment terminal and checks the run
 * record against it.
 */
export function derivePreEnvironmentClosure(
  input: ClosureInput,
): MandatoryGraphClosureReportV1 {
  const lifecycleHead = verifyLifecycleChain(input.lifecycle);
  const roles = derivedRolesFromLifecycle(input.lifecycle);

  for (const forbidden of PRE_ENVIRONMENT_FORBIDDEN_ROLES) {
    if ((roles.get(forbidden) ?? []).length > 0) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
        `a pre-environment terminal cannot close over a ${forbidden}; that role belongs to the environment branch`,
      );
    }
  }

  const runRecordHash = requireExactlyOne(roles, "run-record");
  const record = input.index.typed<PreEnvironmentLabRunRecordV1>(
    runRecordHash,
    "pre-environment-lab-run-record/v1",
  );
  assertContract("PreEnvironmentLabRunRecordV1", record);

  // The terminal stage is derived from the lifecycle, not read from the record.
  const derivedStage = deriveTerminalStage(input.lifecycle);
  if (record.terminal_stage !== derivedStage) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      `record declares terminal stage ${record.terminal_stage}, lifecycle derives ${derivedStage}`,
    );
  }
  // The record is frozen before the event that publishes it, so its declared
  // head must be the event immediately preceding that publication.  Deriving
  // this from the chain means a record cannot claim an arbitrary head.
  const publishingIndex = input.lifecycle.findIndex((e) =>
    e.produced.some((p) => p.artifact_role === "run-record" && p.artifact_core_hash === runRecordHash),
  );
  const expectedHead =
    publishingIndex <= 0 ? lifecycleHead : (input.lifecycle[publishingIndex - 1] as { core_hash: Hash }).core_hash;
  if (record.lifecycle_head_hash !== expectedHead) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "run record does not reference the lifecycle head derived at its freeze point",
    );
  }

  const expected: Record<string, Hash | undefined> = {
    "acquisition-preregistration": record.acquisition_preregistration_hash,
    "acquisition-source-manifest": record.acquisition_source_manifest_hash,
    "acquisition-record": record.acquisition_record_hash,
    "package-verification-record": record.package_verification_record_hash,
    "subject-output-manifest": record.subject_output_hash,
    "journey-result": record.journey_result_hash,
    "domain-result": record.domain_not_applicable_result_hash,
    "precleanup-result-join": record.precleanup_result_join_hash,
    "pre-environment-cleanup": record.pre_environment_cleanup_hash,
    "validity-result": record.validity_result_hash,
    "generic-evaluation-index": record.generic_evaluation_index_hash,
    "run-record": runRecordHash,
  };

  const ordered: DerivedRole[] = [];
  const missing: string[] = [];
  const required = new Set<Hash>();

  for (const role of PRE_ENVIRONMENT_ROLES) {
    const derived = roles.get(role) ?? [];
    if (role === "package-verification-record" && derivedStage === "acquire") {
      if (derived.length !== 0) {
        throw new Erl2Error(
          CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
          "an acquire terminal cannot contain a package-verification record",
        );
      }
      continue;
    }
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
    if (claimed === undefined && role in expected && derived.length > 0 && role !== "journey-step-outcome") {
      // The record omitted a role the lifecycle produced.
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_MISSING_ROLE,
        `run record omits the ${role} the lifecycle produced`,
      );
    }
  }

  for (const role of PRE_ENVIRONMENT_OPTIONAL_ROLES) {
    const derived = roles.get(role) ?? [];
    if (derived.length === 0) continue;
    for (const hash of derived) {
      input.index.get(hash);
      required.add(hash);
    }
    ordered.push({ role, ordered_hashes: derived });
  }

  // The public bundle is the *container* of this closure, not a member of it:
  // it cites the attestation, inventory, receipt, policy and checkpoint that the
  // roles above already require. Exactly one may be retained; a second bundle
  // for the same run is a rejected extra like any other.
  const bundles = input.index.ofSchema("public-verification-bundle/v2");
  if (bundles.length > 1) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      `a terminal retains ${String(bundles.length)} public bundles; exactly one may exist`,
    );
  }
  for (const bundle of bundles) required.add(bundle.coreHash);

  // Anything retained but not derived is a rejected extra.
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
    derived_terminal_variant: "pre_environment" as const,
    lifecycle_head_hash: lifecycleHead,
    ...(input.verifiedTrustHeadHash === undefined
      ? {}
      : { verified_trust_head_hash: input.verifiedTrustHeadHash }),
    required_hashes_by_role: ordered.map((r) => ({ role: r.role, ordered_hashes: [...r.ordered_hashes] })),
    rejected_extra_hashes: rejected,
    missing_roles: missing,
    // A retained artifact the closure did not derive breaks closure exactly as a
    // missing role does (ERL2-FR-020/AC-023, design §14 step 6-7).  The sibling
    // derivations (`derivePreFinalizationClosure`, `deriveInvalidClosure`,
    // `deriveEnvironmentClosure`) already fold extras in; this one must too.
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

export interface PreFinalizationVerdict {
  readonly verdict: "valid" | "invalid";
  readonly missingRoles: readonly string[];
  readonly extraHashes: readonly Hash[];
  readonly derivedTerminalStage: "acquire" | "verify_package";
}

/**
 * Derives the mandatory closure a finalizer must check **before** it signs.
 *
 * This is the same derivation as `derivePreEnvironmentClosure`, minus the three
 * roles the finalizer is about to publish, and with the candidate run record
 * supplied directly rather than resolved from the lifecycle — because it has
 * not been published yet.  The roles it does check come from the hash-chained
 * lifecycle, not from the record's own arrays, so a record that omits or invents
 * a mandatory-reachable artifact is caught here and the run never reaches a
 * signature (design v2 §14, ERL2-AC-031).
 */
export function derivePreFinalizationClosure(
  input: ClosureInput & { readonly runRecord: PreEnvironmentLabRunRecordV1 },
): PreFinalizationVerdict {
  verifyLifecycleChain(input.lifecycle);
  const roles = derivedRolesFromLifecycle(input.lifecycle);
  const record = input.runRecord;

  for (const forbidden of PRE_ENVIRONMENT_FORBIDDEN_ROLES) {
    if ((roles.get(forbidden) ?? []).length > 0) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
        `a pre-environment terminal cannot close over a ${forbidden}; that role belongs to the environment branch`,
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

  const derivedStage = deriveTerminalStage(input.lifecycle);
  if (record.terminal_stage !== derivedStage) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      `record declares terminal stage ${record.terminal_stage}, lifecycle derives ${derivedStage}`,
    );
  }

  const claimed: Record<string, Hash | undefined> = {
    "acquisition-preregistration": record.acquisition_preregistration_hash,
    "acquisition-source-manifest": record.acquisition_source_manifest_hash,
    "acquisition-record": record.acquisition_record_hash,
    "package-verification-record": record.package_verification_record_hash,
    "subject-output-manifest": record.subject_output_hash,
    "journey-result": record.journey_result_hash,
    "domain-result": record.domain_not_applicable_result_hash,
    "precleanup-result-join": record.precleanup_result_join_hash,
    "pre-environment-cleanup": record.pre_environment_cleanup_hash,
    "validity-result": record.validity_result_hash,
    "generic-evaluation-index": record.generic_evaluation_index_hash,
  };

  const missing: string[] = [];
  const required = new Set<Hash>([coreHash(record)]);

  for (const role of PRE_ENVIRONMENT_ROLES) {
    if (FINALIZER_PRODUCED_ROLES.includes(role)) continue;
    const derived = roles.get(role) ?? [];
    if (role === "package-verification-record" && derivedStage === "acquire") {
      if (derived.length !== 0) {
        throw new Erl2Error(
          CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
          "an acquire terminal cannot contain a package-verification record",
        );
      }
      continue;
    }
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

  for (const role of PRE_ENVIRONMENT_OPTIONAL_ROLES) {
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
 * Derives the closure for an invalid terminal.  Only reached evidence and
 * cleanup attempts are required; every attestation and bundle root must be
 * absent (ERL2-AC-026/031).
 */
export function deriveInvalidClosure(input: ClosureInput): MandatoryGraphClosureReportV1 {
  const lifecycleHead = verifyLifecycleChain(input.lifecycle);
  const roles = derivedRolesFromLifecycle(input.lifecycle);

  const recordHash = requireExactlyOne(roles, "invalid-run-record");
  const record = input.index.typed<InvalidLabRunRecordV1>(recordHash, "invalid-lab-run-record/v1");
  assertContract("InvalidLabRunRecordV1", record);

  for (const forbidden of [
    "pre-environment-final-lab-attestation/v1",
    "environment-final-lab-attestation/v1",
    "public-verification-bundle/v2",
    "deep-supplement-attestation/v1",
    "customer-validated-lab-attestation/v1",
  ]) {
    if (input.index.ofSchema(forbidden).length > 0) {
      throw new Erl2Error(
        CODES.INVALID_TERMINAL_ATTESTATION_FORBIDDEN,
        `an invalid run retains ${forbidden}, which is never permitted`,
      );
    }
  }

  const publishingIndex = input.lifecycle.findIndex((e) =>
    e.produced.some(
      (p) => p.artifact_role === "invalid-run-record" && p.artifact_core_hash === recordHash,
    ),
  );
  const expectedHead =
    publishingIndex <= 0 ? lifecycleHead : (input.lifecycle[publishingIndex - 1] as { core_hash: Hash }).core_hash;
  if (record.lifecycle_head_hash !== expectedHead) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "invalid record does not reference the lifecycle head derived at its freeze point",
    );
  }

  // The failure phase and reason must match lifecycle evidence.
  const failureEvent = input.lifecycle.find(
    (e) => e.core_hash === record.failed_phase.lifecycle_event_hash,
  );
  if (!failureEvent) {
    throw new Erl2Error(
      CODES.INVALID_REASON_PHASE_MISMATCH,
      "invalid record names a lifecycle event that is not in the chain",
    );
  }
  if (record.terminal_reason.kind === "cancellation") {
    if (record.failed_phase.kind !== "cancellation") {
      throw new Erl2Error(
        CODES.INVALID_REASON_PHASE_MISMATCH,
        "cancellation reason paired with a non-cancellation phase",
      );
    }
    if (input.index.ofSchema("finding/v1").length > 0) {
      throw new Erl2Error(
        CODES.INVALID_REASON_FABRICATED_FINDING,
        "a cancellation terminal retains a fabricated finding",
      );
    }
  } else {
    if (record.failed_phase.kind === "cancellation") {
      throw new Erl2Error(
        CODES.INVALID_REASON_PHASE_MISMATCH,
        "classified failure paired with a cancellation phase",
      );
    }
    input.index.get(record.terminal_reason.primary_finding_hash);
  }

  // Restoration or teardown failure must terminate through emergency cleanup.
  if (
    record.failed_phase.kind === "lifecycle_phase" &&
    (record.failed_phase.phase === "environment_restoration" || record.failed_phase.phase === "teardown")
  ) {
    if (record.cleanup.variant !== "emergency_environment" || record.cleanup.result_hash === undefined) {
      throw new Erl2Error(
        CODES.EMERGENCY_CLEANUP_BYPASSED,
        "restoration or teardown failure reached the invalid record without emergency cleanup",
      );
    }
    assertEmergencyActionEvidence(input.index, record.cleanup.result_hash);
  }

  const reachedHashes = new Set<Hash>(record.available_evidence.map((e) => e.artifact_hash));
  for (const evidence of record.available_evidence) {
    input.index.get(evidence.artifact_hash);
    if (!input.lifecycle.some((e) => e.core_hash === evidence.reached_event_hash)) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_UNREACHABLE_ARTIFACT,
        "invalid record cites evidence reached by an event outside the chain",
      );
    }
  }
  reachedHashes.add(recordHash);
  if (record.cleanup.result_hash !== undefined) {
    input.index.get(record.cleanup.result_hash);
    reachedHashes.add(record.cleanup.result_hash);
  }
  for (const attempt of record.cleanup.attempt_hashes) reachedHashes.add(attempt);

  const rejected = input.index
    .all()
    .filter((a) => !reachedHashes.has(a.coreHash))
    .filter((a) => !SUPPORTING_SCHEMAS.has(a.schemaVersion))
    .map((a) => a.coreHash);

  const report = {
    schema_version: "mandatory-graph-closure-report/v1" as const,
    algorithm: "erl2-mandatory-closure/v1" as const,
    run_id: record.run_id,
    derived_terminal_phase: record.failed_phase,
    derived_terminal_variant: "invalid" as const,
    lifecycle_head_hash: lifecycleHead,
    required_hashes_by_role: [
      { role: "invalid-run-record", ordered_hashes: [recordHash] },
      {
        role: "reached-evidence",
        ordered_hashes: record.available_evidence.map((e) => e.artifact_hash),
      },
      { role: "cleanup-attempt", ordered_hashes: [...record.cleanup.attempt_hashes] },
    ],
    rejected_extra_hashes: rejected,
    missing_roles: [] as string[],
    // An artifact the run reached but the record does not cite breaks
    // closure just as a missing one does (ERL2-AC-031).
    verdict: (rejected.length === 0 ? "valid" : "invalid") as "valid" | "invalid",
    verified_at: input.verifiedAt,
    verifier_release_hash: input.verifierReleaseHash,
  };
  return assertContract<MandatoryGraphClosureReportV1>("MandatoryGraphClosureReportV1", {
    ...report,
    core_hash: coreHash(report),
  });
}

/** Emergency-action evidence conditionals (ERL2-FR-031, ERL2-AC-035). */
export function assertEmergencyActionEvidence(index: ArtifactIndex, resultHash: Hash): void {
  const verification = index.typed<{
    readonly actions: readonly {
      readonly action_id: string;
      readonly independently_safe: boolean;
      readonly status: string;
      readonly attempt_receipt_hash?: Hash;
      readonly reason_code?: string;
    }[];
  }>(resultHash, "emergency-cleanup-verification/v1");
  for (const action of verification.actions) {
    if (action.status === "skipped_unsafe") {
      if (action.independently_safe) {
        throw new Erl2Error(
          CODES.EMERGENCY_ACTION_SAFE_ACTION_SKIPPED,
          `independently safe action ${action.action_id} was skipped`,
        );
      }
      if (action.attempt_receipt_hash !== undefined) {
        throw new Erl2Error(
          CODES.EMERGENCY_ACTION_RECEIPT_MISSING,
          `skipped action ${action.action_id} carries an attempt receipt`,
        );
      }
      if (action.reason_code === undefined) {
        throw new Erl2Error(
          CODES.EMERGENCY_ACTION_RECEIPT_MISSING,
          `skipped action ${action.action_id} has no reason`,
        );
      }
      continue;
    }
    if (action.attempt_receipt_hash === undefined) {
      throw new Erl2Error(
        CODES.EMERGENCY_ACTION_RECEIPT_MISSING,
        `attempted action ${action.action_id} has no receipt`,
      );
    }
  }
}

/**
 * Derives the terminal journey stage from lifecycle evidence alone.
 */
function deriveTerminalStage(events: readonly LabLifecycleEventV1[]): "acquire" | "verify_package" {
  const outcomes = events.filter((e) => e.event_type.endsWith("_outcome_frozen"));
  const last = outcomes[outcomes.length - 1];
  if (!last) {
    throw new Erl2Error(CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH, "no step outcome in the lifecycle");
  }
  if (last.event_type.startsWith("subject_package_verification")) return "verify_package";
  if (last.event_type.startsWith("subject_acquisition")) return "acquire";
  throw new Erl2Error(
    CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
    `cannot derive a pre-environment terminal stage from ${last.event_type}`,
  );
}

/**
 * Schemas that support verification but are not themselves closure members:
 * trust state, timestamps, the lifecycle stream and verifier output.
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
]);
