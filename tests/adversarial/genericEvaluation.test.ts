/**
 * Slice 6 adversarial matrix (continuation prompt §8, implementation plan §12.3).
 *
 * Every case here is a *mutation of a working artifact*: the honest object is
 * built first, then exactly one field is corrupted, and the refusal code and
 * failure owner are asserted. A mutation that produced no refusal would mean the
 * corresponding invariant is prose rather than code.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DOMAIN_PLANE_METRICS,
  EVIDENCE_PRECISION,
  GENERIC_METRIC_DEFINITIONS,
  JOURNEY_PLANE_METRICS,
  assertGatesAreLabOwned,
  assertNoDeepAncestry,
  assertNoVersionCrossover,
  assertReferencedMetricsAreGeneric,
  assertValidityAdmitsGenericIndex,
  bindDomainPack,
  buildDomainNotApplicable,
  buildEmergencyCleanup,
  buildGenericEvaluationIndex,
  buildPreEnvironmentCleanup,
  buildPreEnvironmentRunRecord,
  buildPreEnvironmentValidity,
  buildPreSelectionJourneyResult,
  buildPrecleanupResultJoin,
  deriveJoinOrdering,
  evaluateMetric,
  exactRatio,
  freezeResourceFrontier,
  genericMetricHashes,
  resourceIdentityHash,
  type GateResult,
} from "@erl2/core";
import { coreHash, developmentKey, sealSigned } from "@erl2/integrity";
import { certifyPack, RESERVED_GENERIC_METRIC_IDS as SDK_RESERVED_IDS } from "@erl2/evaluation-sdk";
import { RESERVED_GENERIC_METRIC_IDS as CANONICAL_RESERVED_IDS } from "@erl2/contracts";
import { OPERATIONS_METRIC_IDS, operationsPackBody } from "@erl2/pack-operations";
import {
  assertContract,
  validateContract,
  type EvaluationPackBodyV1,
  type EvaluationPackManifestV1,
  type Hash,
  type Instant,
  type JourneyStepOutcomeV1,
  type LabLifecycleEventV1,
  type MetricDefinitionV1,
} from "@erl2/contracts";

const RUN_ID = "01890000-0000-7000-8000-00000000a001";
const OTHER_RUN_ID = "01890000-0000-7000-8000-00000000a002";
const AT = "2026-07-01T03:00:00Z" as Instant;
const POLICY = `sha256:${"1".repeat(64)}` as Hash;
const OTHER_POLICY = `sha256:${"2".repeat(64)}` as Hash;
const h = (c: string): Hash => `sha256:${c.repeat(64)}` as Hash;

function throwsCode(fn: () => unknown, code: string, label = ""): void {
  try {
    fn();
  } catch (error) {
    assert.equal((error as { code?: string }).code, code, `${label}: ${String(error)}`);
    return;
  }
  assert.fail(`${label}: expected refusal ${code}, but nothing was thrown`);
}

// -- shared honest artifacts -------------------------------------------------

function stepOutcome(id: string, status: "succeeded" | "failed" | "unsupported"): JourneyStepOutcomeV1 {
  const body = {
    schema_version: "journey-step-outcome/v1" as const,
    run_id: RUN_ID,
    step_id: id,
    step_commitment_hash: h("3"),
    visible_step_hash: h("4"),
    adapter_request_hash: h("5"),
    intent: "verify_package" as const,
    status,
    attempt_record_hashes: [],
    detail_record_hashes: [],
    visible_input_hashes: [],
    output_refs: [],
    mutation_receipt_hashes: [],
    compensation_receipt_hashes: [],
    diagnostic_refs: [],
    started_at: "2026-07-01T00:00:00Z" as Instant,
    ended_at: "2026-07-01T00:00:05Z" as Instant,
    active_operator_ms: 1000,
    next_permitted_intents: [],
  };
  return assertContract<JourneyStepOutcomeV1>("JourneyStepOutcomeV1", {
    ...body,
    core_hash: coreHash(body),
  });
}

function journeyResult(runId = RUN_ID, policy = POLICY) {
  return buildPreSelectionJourneyResult({
    runId,
    terminalStage: "verify_package",
    acquisitionPreregistrationHash: h("6"),
    genericRunPolicyHash: policy,
    orderedOutcomes: [stepOutcome("acquire", "succeeded"), stepOutcome("verify", "failed")],
    revealedJudgeExpectationHashes: [h("7")],
    journeyMetricDefinitions: JOURNEY_PLANE_METRICS,
    findingHashes: [],
    evaluatedAt: AT,
  }).result;
}

function domainResult(journeyHash: Hash, runId = RUN_ID, policy = POLICY) {
  return buildDomainNotApplicable({
    runId,
    genericRunPolicyHash: policy,
    terminalStage: "verify_package",
    reason: "pre_environment_terminal",
    journeyResultHash: journeyHash,
    findingHashes: [],
    recordedAt: AT,
  });
}

const LAB_GATES: readonly GateResult[] = [
  { gate_id: "contract-schema-closure", passed: true, evidence_refs: [] },
  { gate_id: "contract-version-closure", passed: true, evidence_refs: [] },
  { gate_id: "lifecycle-chain-verified", passed: true, evidence_refs: [] },
  { gate_id: "lifecycle-state-machine-respected", passed: true, evidence_refs: [] },
  { gate_id: "acquisition-preregistered-before-access", passed: true, evidence_refs: [] },
  { gate_id: "acquired-bytes-frozen", passed: true, evidence_refs: [] },
  { gate_id: "package-integrity-policy-applied", passed: true, evidence_refs: [] },
  { gate_id: "evidence-sources-accounted", passed: true, evidence_refs: [] },
  // No `adapter-certified`: this fixture is a development fake-port run, which
  // selects no external adapter, so the gate is not applicable and the
  // catalogue does not require it (ADR-ERL2-036 §5a). Including it here used to
  // be harmless because the gate was an unconditional `true`; it is now the
  // exact misrepresentation `assertAdapterCertificationApplicability` refuses.
  { gate_id: "adapter-authority-respected", passed: true, evidence_refs: [] },
  { gate_id: "subject-output-frozen-before-reveal", passed: true, evidence_refs: [] },
  { gate_id: "no-execution-after-output-freeze", passed: true, evidence_refs: [] },
  { gate_id: "precleanup-result-join-closed", passed: true, evidence_refs: [] },
  { gate_id: "cleanup-verified", passed: true, evidence_refs: [] },
  { gate_id: "trust-policy-resolved", passed: true, evidence_refs: [] },
  { gate_id: "timestamp-checkpoints-acyclic", passed: true, evidence_refs: [] },
];

function validity(status: "valid" | "invalid" = "valid", runId = RUN_ID, policy = POLICY) {
  const gates =
    status === "valid"
      ? LAB_GATES
      : LAB_GATES.map((g) =>
          g.gate_id === "acquired-bytes-frozen" ? { ...g, passed: false } : g,
        );
  return buildPreEnvironmentValidity({
    subjectExecutionMode: "development_fake_port",
    runId,
    terminalStage: "verify_package",
    genericRunPolicyHash: policy,
    gates,
    preEnvironmentCleanupHash: h("8"),
    invalidityFindingHashes: status === "invalid" ? [h("9")] : [],
    evaluatedAt: AT,
  });
}

function lifecycleEvent(
  sequence: number,
  eventType: string,
  produced: readonly { artifact_role: string; artifact_core_hash: Hash; artifact_schema_version: string }[] = [],
): LabLifecycleEventV1 {
  return {
    schema_version: "lab-lifecycle-event/v1",
    run_id: RUN_ID,
    sequence,
    event_type: eventType,
    state_from: "created",
    state_to: "created",
    actor_id: "operator",
    command_id: "test",
    operation_id: `op-${String(sequence)}`,
    required_hashes: [],
    produced: [...produced],
    prior_event_hash: h("0"),
    recorded_at: AT,
    core_hash: h("a"),
  } as unknown as LabLifecycleEventV1;
}

// -- 1. evaluation-pack authority -------------------------------------------

const FORBIDDEN_TOKENS = ["qualiber", "trailhead", "telemetrytest", "scenario-lab"];

function certify(body: EvaluationPackBodyV1, metrics: readonly MetricDefinitionV1[] = DOMAIN_PLANE_METRICS) {
  return certifyPack({
    body,
    metricDefinitions: metrics,
    forbiddenSubjectTokens: FORBIDDEN_TOKENS,
    certifierId: "independent-evaluation-reviewer",
    certifiedAt: AT,
    hash: coreHash,
  });
}

function failedChecks(receipt: ReturnType<typeof certify>): readonly string[] {
  return receipt.checks.filter((c) => !c.passed).map((c) => c.reason_code);
}

test("PACK-AUTHORITY: a pack cannot express I/O, a clock, randomness, a process or a mutation", () => {
  const honest = operationsPackBody(coreHash);
  // The closed schema has no member of any of those shapes: adding one is
  // rejected before certification even runs.
  for (const injected of [
    { run: "node:child_process" },
    { clock: "Date.now" },
    { random: "Math.random" },
    { mutate: "mutateEnvironment" },
    { validity: "valid" },
    { thresholds: { "evidence-precision": "0.1" } },
  ]) {
    assert.equal(
      validateContract("EvaluationPackBodyV1", { ...honest, ...injected }).valid,
      false,
      JSON.stringify(injected),
    );
  }
  // The scanner matches bare identifiers as whole words, so the pack's own
  // `evaluation-pack-body/v1` schema version is not reported as an `eval` call.
  // A scanner that cried wolf there would teach reviewers to ignore it.
  assert.ok(honest.schema_version.includes("eval"));
  assert.equal(certify(honest).passed, true, "an innocent substring is not a false positive");
  // A genuinely smuggled reference is caught.
  const smuggled = certify({
    ...honest,
    applicable_challenge_families: ["eval", "operations-diagnosis"],
  } as EvaluationPackBodyV1);
  assert.equal(smuggled.passed, false);
  assert.ok(failedChecks(smuggled).includes("PACK_PROHIBITED_API_REFERENCE"));
});

test("PACK-AUTHORITY: a domain pack naming a subject or a shortcut predicate is refused", () => {
  const honest = operationsPackBody(coreHash);
  const named = certify({
    ...honest,
    applicable_challenge_families: ["qualiber-regression"],
  } as EvaluationPackBodyV1);
  assert.equal(named.passed, false);
  assert.ok(failedChecks(named).includes("PACK_SUBJECT_VOCABULARY_IN_DOMAIN_SCOPE"));

  const shortcut = certify({
    ...honest,
    applicable_challenge_families: ["golden-answer-lookup", "answer_key"],
  } as EvaluationPackBodyV1);
  assert.equal(shortcut.passed, false);
  assert.ok(failedChecks(shortcut).includes("PACK_SHORTCUT_PREDICATE_REFUSED"));
});

test("PACK-AUTHORITY: a pack cannot read a validity, selection or judge-expectation contract", () => {
  const honest = operationsPackBody(coreHash);
  const reaching = certify({
    ...honest,
    input_contract_ids: [...honest.input_contract_ids, "ERL2-C-045"],
  } as EvaluationPackBodyV1);
  assert.equal(reaching.passed, false);
  assert.ok(failedChecks(reaching).includes("PACK_VALIDITY_AUTHORITY_REFUSED"));
});

test("PACK-AUTHORITY: post-hoc threshold mutation changes the metric identity and is refused", () => {
  const relaxed: MetricDefinitionV1 = assertContract<MetricDefinitionV1>("MetricDefinitionV1", {
    ...EVIDENCE_PRECISION,
    threshold: { comparator: "at_least" as const, bound: "0.1" },
    core_hash: coreHash({
      ...EVIDENCE_PRECISION,
      threshold: { comparator: "at_least" as const, bound: "0.1" },
      core_hash: undefined,
    }),
  });
  // A relaxed generic metric is a *different* artifact; the Lab owns the id.
  throwsCode(
    () => assertReferencedMetricsAreGeneric([relaxed]),
    "PACK_GENERIC_METRIC_OVERRIDE",
  );
});

test("PACK-BINDING: an uncertified pack, a swapped body and a swapped receipt are all refused", () => {
  const body = operationsPackBody(coreHash);
  const receipt = certify(body);
  const manifest = assertContract<EvaluationPackManifestV1>(
    "EvaluationPackManifestV1",
    sealSigned(
      {
        schema_version: "evaluation-pack-manifest/v1" as const,
        pack_id: body.pack_id,
        version: body.version,
        scope: body.scope,
        domain: body.domain,
        pack_artifact_hash: body.core_hash,
        vocabulary_hash: h("b"),
        truth_schema_hash: h("c"),
        assertion_ids: body.assertions.map((a) => a.assertion_id),
        metric_definitions: genericMetricHashes(OPERATIONS_METRIC_IDS),
        prohibited_core_apis: ["node:fs"],
        reviewer_ids: ["domain-reviewer", "bias-reviewer"],
        bias_review_hash: h("d"),
        certification_receipt_hash: receipt.core_hash,
      },
      developmentKey("evaluator"),
    ),
  );
  const bind = (over: Partial<Parameters<typeof bindDomainPack>[0]>) =>
    bindDomainPack({ manifest, body, certification: receipt, metricDefinitions: DOMAIN_PLANE_METRICS, ...over });

  bind({}); // the honest binding succeeds
  throwsCode(() => bind({ certification: { ...receipt, passed: false } }), "PACK_NOT_CERTIFIED", "uncertified");
  throwsCode(
    () => bind({ manifest: { ...manifest, pack_artifact_hash: h("e") } }),
    "PACK_NOT_CERTIFIED",
    "swapped body",
  );
  throwsCode(
    () => bind({ manifest: { ...manifest, certification_receipt_hash: h("e") } }),
    "PACK_NOT_CERTIFIED",
    "swapped receipt",
  );
  throwsCode(
    () => bind({ manifest: { ...manifest, subject_id: "some-product" } }),
    "PACK_SUBJECT_VOCABULARY_IN_DOMAIN_SCOPE",
    "subject-bound domain pack",
  );
});

// -- 2. metric determinism and zero denominators -----------------------------

test("METRIC-ARITHMETIC: ratios are exact integer division, never platform floats", () => {
  assert.equal(exactRatio(1, 3), "0.3333");
  assert.equal(exactRatio(2, 3), "0.6667");
  assert.equal(exactRatio(1, 1), "1");
  assert.equal(exactRatio(0, 7), "0");
  // 0.1 + 0.2 style drift cannot occur: there is no float on this path.
  assert.equal(exactRatio(3, 10), "0.3");
  throwsCode(() => exactRatio(1, 0), "EVALUATOR_ZERO_DENOMINATOR_UNDEFINED");
  throwsCode(() => exactRatio(1.5, 2), "EVALUATOR_NONDETERMINISM");
});

test("METRIC-ZERO: an empty denominator resolves only through the declared behaviour", () => {
  const empty = {
    claims: [],
    requiredTruthFacts: [],
    evidenceSources: [],
    stepOutcomes: [],
    declaredMutations: [],
    envelope: { entry_digests: new Set<string>(), reachable_locators: new Set<string>() },
    credentialCanaries: [],
    authorityCeiling: "advisory" as const,
  };
  const byId = new Map(GENERIC_METRIC_DEFINITIONS.map((m) => [m.metric_id, m]));
  const cases: readonly (readonly [string, string, string | undefined])[] = [
    ["evidence-recall", "not_applicable", undefined],
    ["causal-overclaim", "measured", "0"],
    ["citation-reachability", "measured", "1"],
    ["degradation-honesty", "not_applicable", undefined],
  ];
  for (const [metricId, status, value] of cases) {
    const result = evaluateMetric({
      definition: byId.get(metricId) as MetricDefinitionV1,
      runId: RUN_ID,
      plane: "domain",
      inputs: empty,
      evaluatedAt: AT,
      correctAbstentionApplies: true,
    });
    assert.equal(result.status, status, metricId);
    assert.equal(result.value, value, metricId);
    assert.ok(result.reason_codes.includes("ZERO_DENOMINATOR"), metricId);
  }
});

test("GENERIC-METRIC-REGISTRY §11.7: core, the SDK and the authoritative registry agree two ways", () => {
  const coreDefined = [...GENERIC_METRIC_DEFINITIONS.map((m) => m.metric_id)].sort();
  const canonical = [...CANONICAL_RESERVED_IDS].sort();
  const sdk = [...SDK_RESERVED_IDS].sort();

  // The single source of truth carries all seventeen ids, including the two the
  // SDK's stale copy had dropped.
  assert.equal(canonical.length, 17);
  assert.ok(canonical.includes("authority-scope"));
  assert.ok(canonical.includes("mutation-compensation"));

  // Two-way equality: nothing core defines is unreserved, and nothing reserved
  // is undefined by core. And the SDK's re-export IS the canonical registry.
  assert.deepEqual(coreDefined, canonical, "core ⇔ authoritative registry");
  assert.deepEqual(sdk, canonical, "SDK ⇔ authoritative registry");
  assert.equal(SDK_RESERVED_IDS, CANONICAL_RESERVED_IDS, "SDK re-exports the same array reference");
});

test("GENERIC-METRIC-NEUTER §11.7: a pack that redefines a reserved hard-safety metric is refused", () => {
  // `authority-scope` (hard-safety) and `mutation-compensation` were missing
  // from the SDK's old reserved list, so a pack could ship a neutered
  // definition for either and certifyPack would not flag it. Now it must.
  for (const neuteredId of ["authority-scope", "mutation-compensation"] as const) {
    const genuine = GENERIC_METRIC_DEFINITIONS.find((m) => m.metric_id === neuteredId);
    assert.ok(genuine, `${neuteredId} must be a Lab-owned generic metric`);
    // A pack ships its OWN definition under the reserved id (not referencing the
    // Lab metric) with a neutered threshold — an override attempt. The pack body
    // does not reference the id, so `no-generic-metric-override` is the check
    // that must fire.
    const { core_hash: _drop, ...draft } = genuine as MetricDefinitionV1;
    const neuteredDraft = { ...draft, title: "neutered by a hostile pack" };
    const neutered = { ...neuteredDraft, core_hash: coreHash(neuteredDraft) } as MetricDefinitionV1;
    const body = operationsPackBody(coreHash);
    const receipt = certifyPack({
      body: { ...body, metric_ids: body.metric_ids.filter((id) => id !== neuteredId) },
      metricDefinitions: [neutered],
      forbiddenSubjectTokens: FORBIDDEN_TOKENS,
      certifierId: "erl2-test-certifier",
      certifiedAt: AT,
      hash: coreHash,
    });
    const overrideCheck = receipt.checks.find((c) => c.check_id === "no-generic-metric-override");
    assert.ok(overrideCheck, "override check must exist");
    assert.equal(overrideCheck?.passed, false, `${neuteredId} override must be refused`);
  }
});

test("METRIC-MISSING-INPUT: an unavailable input is inconclusive and names the selector", () => {
  const result = evaluateMetric({
    definition: EVIDENCE_PRECISION,
    runId: RUN_ID,
    plane: "domain",
    inputs: {
      claims: undefined,
      requiredTruthFacts: undefined,
      evidenceSources: undefined,
      stepOutcomes: [],
      declaredMutations: [],
      envelope: undefined,
      credentialCanaries: [],
      authorityCeiling: "advisory",
    },
    evaluatedAt: AT,
  });
  assert.equal(result.status, "inconclusive");
  assert.ok(result.reason_codes.includes("MISSING_INPUT"));
  assert.ok((result.missing_input_selectors ?? []).includes("cited_claims"));
  assert.equal(result.value, undefined, "an inconclusive metric never carries a number");
});

// -- 3. journey ordering ------------------------------------------------------

test("STEP-ORDER: a duplicated step outcome in the derived closure is refused", () => {
  const duplicate = stepOutcome("acquire", "succeeded");
  throwsCode(
    () =>
      buildPreSelectionJourneyResult({
        runId: RUN_ID,
        terminalStage: "verify_package",
        acquisitionPreregistrationHash: h("6"),
        genericRunPolicyHash: POLICY,
        orderedOutcomes: [duplicate, duplicate],
        revealedJudgeExpectationHashes: [],
        journeyMetricDefinitions: JOURNEY_PLANE_METRICS,
        findingHashes: [],
        evaluatedAt: AT,
      }),
    "EVALUATOR_DUPLICATE_STEP_OUTCOME",
  );
});

// -- 4. the result join -------------------------------------------------------

test("RESULT-JOIN: a missing branch, a duplicate result and an early cleanup are all refused", () => {
  const journeyEvent = lifecycleEvent(1, "nonfunctional_journey_result_frozen");
  const domainEvent = lifecycleEvent(2, "domain_not_applicable_frozen");
  const joinEvent = lifecycleEvent(3, "generic_precleanup_results_complete");
  const cleanupEvent = lifecycleEvent(4, "pre_environment_cleanup_started");

  deriveJoinOrdering([journeyEvent, domainEvent, joinEvent, cleanupEvent]);

  throwsCode(
    () => deriveJoinOrdering([journeyEvent, joinEvent]),
    "EVALUATOR_RESULT_JOIN_INCOMPLETE",
    "missing domain result",
  );
  throwsCode(
    () => deriveJoinOrdering([domainEvent, joinEvent]),
    "EVALUATOR_RESULT_JOIN_INCOMPLETE",
    "missing journey result",
  );
  throwsCode(
    () => deriveJoinOrdering([journeyEvent, journeyEvent, domainEvent, joinEvent]),
    "EVALUATOR_RESULT_JOIN_DUPLICATE",
    "duplicate journey result",
  );
  throwsCode(
    () => deriveJoinOrdering([journeyEvent, domainEvent, cleanupEvent, joinEvent]),
    "EVALUATOR_CLEANUP_BEFORE_RESULT_JOIN",
    "cleanup before the join",
  );
  throwsCode(
    () => deriveJoinOrdering([journeyEvent, domainEvent]),
    "EVALUATOR_RESULT_JOIN_INCOMPLETE",
    "no join event",
  );
});

test("RESULT-JOIN: a cross-run or cross-policy result cannot be joined", () => {
  const journey = journeyResult();
  const domain = domainResult(journey.core_hash);
  buildPrecleanupResultJoin({
    runId: RUN_ID,
    journeyResult: journey,
    domainResult: domain,
    lifecycleEventHash: h("a"),
    joinedAt: AT,
    genericRunPolicyHash: POLICY,
  });

  const foreignJourney = journeyResult(OTHER_RUN_ID);
  throwsCode(
    () =>
      buildPrecleanupResultJoin({
        runId: RUN_ID,
        journeyResult: foreignJourney,
        domainResult: domainResult(foreignJourney.core_hash),
        lifecycleEventHash: h("a"),
        joinedAt: AT,
        genericRunPolicyHash: POLICY,
      }),
    "EVALUATOR_CROSS_RUN_RESULT",
  );

  const otherPolicyJourney = journeyResult(RUN_ID, OTHER_POLICY);
  throwsCode(
    () =>
      buildPrecleanupResultJoin({
        runId: RUN_ID,
        journeyResult: otherPolicyJourney,
        domainResult: domainResult(otherPolicyJourney.core_hash, RUN_ID, OTHER_POLICY),
        lifecycleEventHash: h("a"),
        joinedAt: AT,
        genericRunPolicyHash: POLICY,
      }),
    "EVALUATOR_CROSS_POLICY_RESULT",
  );

  // A not-applicable domain result that points at a different journey result.
  throwsCode(
    () =>
      buildPrecleanupResultJoin({
        runId: RUN_ID,
        journeyResult: journey,
        domainResult: domainResult(h("f")),
        lifecycleEventHash: h("a"),
        joinedAt: AT,
        genericRunPolicyHash: POLICY,
      }),
    "EVALUATOR_DOMAIN_VARIANT_MISMATCH",
  );
});

test("NOT-APPLICABLE-REASON: a reason that does not derive from the terminal stage is refused", () => {
  throwsCode(
    () =>
      buildDomainNotApplicable({
        runId: RUN_ID,
        genericRunPolicyHash: POLICY,
        terminalStage: "verify_package",
        reason: "connection_terminal",
        journeyResultHash: h("f"),
        findingHashes: [],
        recordedAt: AT,
      }),
    "EVALUATOR_NOT_APPLICABLE_REASON_MISMATCH",
    "pre-environment terminal claiming a connection reason",
  );
  throwsCode(
    () =>
      buildDomainNotApplicable({
        runId: RUN_ID,
        genericRunPolicyHash: POLICY,
        terminalStage: "connect",
        reason: "pre_environment_terminal",
        journeyResultHash: h("f"),
        findingHashes: [],
        recordedAt: AT,
      }),
    "EVALUATOR_NOT_APPLICABLE_REASON_MISMATCH",
    "connection terminal claiming a pre-environment reason",
  );
  throwsCode(
    () =>
      buildDomainNotApplicable({
        runId: RUN_ID,
        genericRunPolicyHash: POLICY,
        terminalStage: "exercise",
        reason: "setup_terminal",
        journeyResultHash: h("f"),
        findingHashes: [],
        recordedAt: AT,
      }),
    "EVALUATOR_NOT_APPLICABLE_REASON_MISMATCH",
    "post-setup terminal claiming a setup reason",
  );
});

// -- 5. validity independence -------------------------------------------------

test("VALIDITY-INDEPENDENCE: a gate that inspects subject quality is not a Lab-owned gate", () => {
  for (const gateId of [
    "subject-claims-correct",
    "domain-result-favourable",
    "evidence-precision-above-threshold",
    "journey-succeeded",
  ]) {
    throwsCode(
      () => assertGatesAreLabOwned([{ gate_id: gateId, passed: true, evidence_refs: [] }]),
      "EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED",
      gateId,
    );
  }
  // Every catalogued gate is accepted.
  assertGatesAreLabOwned(LAB_GATES);
});

test("VALIDITY-COMPLETENESS: an omitted required gate is not a silent pass", () => {
  throwsCode(
    () =>
      buildPreEnvironmentValidity({
    subjectExecutionMode: "development_fake_port",
        runId: RUN_ID,
        terminalStage: "verify_package",
        genericRunPolicyHash: POLICY,
        gates: LAB_GATES.filter((g) => g.gate_id !== "cleanup-verified"),
        preEnvironmentCleanupHash: h("8"),
        invalidityFindingHashes: [],
        evaluatedAt: AT,
      }),
    "GRAPH_CLOSURE_MISSING_ROLE",
  );
});

test("VALIDITY-ROUTING: invalid validity can never enter the generic evaluation index", () => {
  const invalid = validity("invalid");
  assert.equal(invalid.status, "invalid");
  throwsCode(
    () => assertValidityAdmitsGenericIndex(invalid),
    "EVALUATOR_INVALID_VALIDITY_IN_GENERIC_INDEX",
  );

  const journey = journeyResult();
  const domain = domainResult(journey.core_hash);
  const join = buildPrecleanupResultJoin({
    runId: RUN_ID,
    journeyResult: journey,
    domainResult: domain,
    lifecycleEventHash: h("a"),
    joinedAt: AT,
    genericRunPolicyHash: POLICY,
  });
  throwsCode(
    () =>
      buildGenericEvaluationIndex({
        runId: RUN_ID,
        genericRunPolicyHash: POLICY,
        validity: invalid,
        journeyResult: journey,
        domainResult: domain,
        join,
        evaluatorVersion: "erl2-generic-evaluator/0.1.0",
      }),
    "EVALUATOR_INVALID_VALIDITY_IN_GENERIC_INDEX",
  );
});

test("GENERIC-INDEX: a stale, cross-run or wrong-variant result is refused", () => {
  const journey = journeyResult();
  const domain = domainResult(journey.core_hash);
  const join = buildPrecleanupResultJoin({
    runId: RUN_ID,
    journeyResult: journey,
    domainResult: domain,
    lifecycleEventHash: h("a"),
    joinedAt: AT,
    genericRunPolicyHash: POLICY,
  });
  const good = buildGenericEvaluationIndex({
    runId: RUN_ID,
    genericRunPolicyHash: POLICY,
    validity: validity(),
    journeyResult: journey,
    domainResult: domain,
    join,
    evaluatorVersion: "erl2-generic-evaluator/0.1.0",
  });
  assert.equal(good.precleanup_result_join_hash, join.core_hash);

  // A later re-evaluation the join never closed over: a different terminal
  // stage gives it a different identity, which is exactly what "stale" means.
  const restated = buildPreSelectionJourneyResult({
    runId: RUN_ID,
    terminalStage: "acquire",
    acquisitionPreregistrationHash: h("6"),
    genericRunPolicyHash: POLICY,
    orderedOutcomes: [stepOutcome("acquire", "succeeded")],
    revealedJudgeExpectationHashes: [],
    journeyMetricDefinitions: JOURNEY_PLANE_METRICS,
    findingHashes: [],
    evaluatedAt: AT,
  }).result;
  assert.notEqual(restated.core_hash, journey.core_hash);
  throwsCode(
    () =>
      buildGenericEvaluationIndex({
        runId: RUN_ID,
        genericRunPolicyHash: POLICY,
        validity: validity(),
        journeyResult: restated,
        domainResult: domain,
        join,
        evaluatorVersion: "erl2-generic-evaluator/0.1.0",
      }),
    "EVALUATOR_STALE_RESULT_HASH",
  );
  throwsCode(
    () =>
      buildGenericEvaluationIndex({
        runId: OTHER_RUN_ID,
        genericRunPolicyHash: POLICY,
        validity: validity(),
        journeyResult: journey,
        domainResult: domain,
        join,
        evaluatorVersion: "erl2-generic-evaluator/0.1.0",
      }),
    "EVALUATOR_CROSS_RUN_RESULT",
  );
  throwsCode(
    () =>
      buildGenericEvaluationIndex({
        runId: RUN_ID,
        genericRunPolicyHash: POLICY,
        validity: validity(),
        journeyResult: journey,
        domainResult: domain,
        join: { ...join, domain_variant: "evaluated" },
        evaluatorVersion: "erl2-generic-evaluator/0.1.0",
      }),
    "EVALUATOR_DOMAIN_VARIANT_MISMATCH",
  );
});

// -- 6. emergency cleanup evidence -------------------------------------------

const CONTAINER_NAME = `erl2-${RUN_ID}-container-a`;
const VOLUME_NAME = `erl2-${RUN_ID}-volume-b`;
const CONTAINER_IDENTITY = resourceIdentityHash(RUN_ID, "container", CONTAINER_NAME);
const VOLUME_IDENTITY = resourceIdentityHash(RUN_ID, "volume", VOLUME_NAME);

function frontier() {
  return freezeResourceFrontier({
    runId: RUN_ID,
    environmentInstanceHash: h("b"),
    driverManifestHash: h("c"),
    trigger: "restoration_failure",
    observedResources: [
      {
        resource_id: "container-a",
        kind: "container",
        run_scoped_name: CONTAINER_NAME,
        identity_hash: resourceIdentityHash(RUN_ID, "container", CONTAINER_NAME),
        destroyable: true,
        shared_with_other_runs: false,
      },
      {
        // Not independently destroyable: it becomes an unsafe `contain_residual`
        // action, which must be skipped with a reason and no receipt.
        resource_id: "volume-b",
        kind: "volume",
        run_scoped_name: VOLUME_NAME,
        identity_hash: resourceIdentityHash(RUN_ID, "volume", VOLUME_NAME),
        destroyable: false,
        shared_with_other_runs: false,
      },
    ],
    frozenAt: AT,
  });
}

test("EMERGENCY-ACTION: a safe action without a receipt, and an unsafe skip with one, are refused", () => {
  const f = frontier();
  const safe = f.derived_actions.filter((a) => a.independently_safe);
  const unsafe = f.derived_actions.filter((a) => !a.independently_safe);
  assert.ok(safe.length >= 1 && unsafe.length >= 1, "the frontier derives both kinds of action");

  const honest = buildEmergencyCleanup({
    runId: RUN_ID,
    environmentInstanceHash: h("b"),
    trigger: "restoration_failure",
    frontier: f,
    resourceFrontierEventHash: h("a"),
    attempts: safe.map((a) => ({ actionId: a.action_id, succeeded: true, attemptReceiptHash: h("1") })),
    remainingResources: [{ kind: "volume", identity_hash: VOLUME_IDENTITY, containment_status: "contained" }],
    completedAt: AT,
  });
  assert.equal(honest.all_independently_safe_actions_attempted, true);
  assert.equal(
    honest.actions.filter((a) => a.status === "skipped_unsafe").length,
    unsafe.length,
    "every unsafe action is skipped with a reason and no receipt",
  );

  // A safe action that was never attempted.
  throwsCode(
    () =>
      buildEmergencyCleanup({
        runId: RUN_ID,
        environmentInstanceHash: h("b"),
        trigger: "restoration_failure",
        frontier: f,
        resourceFrontierEventHash: h("a"),
        attempts: [],
        remainingResources: [],
        completedAt: AT,
      }),
    "EMERGENCY_ACTION_SAFE_ACTION_SKIPPED",
  );
  // A safe action attempted without a receipt.
  throwsCode(
    () =>
      buildEmergencyCleanup({
        runId: RUN_ID,
        environmentInstanceHash: h("b"),
        trigger: "restoration_failure",
        frontier: f,
        resourceFrontierEventHash: h("a"),
        attempts: safe.map((a) => ({ actionId: a.action_id, succeeded: true })),
        remainingResources: [],
        completedAt: AT,
      }),
    "EMERGENCY_ACTION_RECEIPT_MISSING",
  );
  // A failed action with a receipt but no reason.
  throwsCode(
    () =>
      buildEmergencyCleanup({
        runId: RUN_ID,
        environmentInstanceHash: h("b"),
        trigger: "restoration_failure",
        frontier: f,
        resourceFrontierEventHash: h("a"),
        attempts: safe.map((a) => ({
          actionId: a.action_id,
          succeeded: false,
          attemptReceiptHash: h("1"),
        })),
        remainingResources: [
          { kind: "container", identity_hash: CONTAINER_IDENTITY, containment_status: "uncontained" },
          { kind: "volume", identity_hash: VOLUME_IDENTITY, containment_status: "contained" },
        ],
        completedAt: AT,
      }),
    "EMERGENCY_ACTION_RECEIPT_MISSING",
  );
  // An unsafe action carrying an attempt receipt.
  throwsCode(
    () =>
      buildEmergencyCleanup({
        runId: RUN_ID,
        environmentInstanceHash: h("b"),
        trigger: "restoration_failure",
        frontier: f,
        resourceFrontierEventHash: h("a"),
        attempts: [
          ...safe.map((a) => ({ actionId: a.action_id, succeeded: true, attemptReceiptHash: h("1") })),
          {
            actionId: (unsafe[0] as { action_id: string }).action_id,
            succeeded: true,
            attemptReceiptHash: h("1"),
          },
        ],
        remainingResources: [],
        completedAt: AT,
      }),
    "EMERGENCY_ACTION_RECEIPT_MISSING",
  );
});

test("EMERGENCY-RESIDUE: an unresolved resource must be declared with a containment status", () => {
  const f = frontier();
  const safe = f.derived_actions.filter((a) => a.independently_safe);
  throwsCode(
    () =>
      buildEmergencyCleanup({
        runId: RUN_ID,
        environmentInstanceHash: h("b"),
        trigger: "restoration_failure",
        frontier: f,
        resourceFrontierEventHash: h("a"),
        attempts: safe.map((a) => ({ actionId: a.action_id, succeeded: true, attemptReceiptHash: h("1") })),
        // The skipped volume is simply omitted. Silence is not containment.
        remainingResources: [],
        completedAt: AT,
      }),
    "RESIDUE_DETECTED",
  );
});

// -- 7. terminal-variant and version crossover --------------------------------

test("TERMINAL-VARIANT: an acquire terminal cannot carry a package-verification record", () => {
  const shared = {
    runId: RUN_ID,
    acquisitionPreregistrationHash: h("1"),
    acquisitionSourceManifestHash: h("2"),
    acquisitionRecordHash: h("3"),
    adapterHash: h("4"),
    genericRunPolicyHash: POLICY,
    subjectOutputHash: h("5"),
    journeyResultHash: h("6"),
    domainNotApplicableResultHash: h("7"),
    precleanupResultJoinHash: h("8"),
    preEnvironmentCleanupHash: h("9"),
    validityResultHash: h("a"),
    genericEvaluationIndexHash: h("b"),
    lifecycleHeadHash: h("c"),
  };
  throwsCode(
    () =>
      buildPreEnvironmentRunRecord({
        ...shared,
        terminalStage: "acquire",
        packageVerificationRecordHash: h("d"),
      }),
    "GRAPH_CLOSURE_EXTRA_ARTIFACT",
  );
  throwsCode(
    () => buildPreEnvironmentRunRecord({ ...shared, terminalStage: "verify_package" }),
    "GRAPH_CLOSURE_MISSING_ROLE",
  );
  // The pre-environment record has no member for a package manifest at all.
  const record = buildPreEnvironmentRunRecord({ ...shared, terminalStage: "acquire" });
  assert.equal(
    validateContract("PreEnvironmentLabRunRecordV1", {
      ...record,
      subject_package_manifest_hash: h("d"),
    }).valid,
    false,
    "ADR-ERL2-013: a successful package manifest cannot be closed over here",
  );
});

test("VERSION-CROSSOVER: a V2 bundle cannot carry a retained V1 member", () => {
  assertNoVersionCrossover([
    { schema_version: "pre-environment-final-lab-attestation/v1" },
    { schema_version: "signer-inventory/v2" },
  ]);
  for (const v1 of [
    "public-verification-bundle/v1",
    "product-safe-signer-inventory/v1",
    "trust-policy-manifest/v1",
    "run-lifecycle-event/v1",
  ]) {
    throwsCode(
      () => assertNoVersionCrossover([{ schema_version: v1 }]),
      "VERSION_CLOSURE_MEMBER_CROSSOVER",
      v1,
    );
  }
});

// -- 8. the deep-plane boundary ----------------------------------------------

test("DEEP-ANCESTRY: no generic or base artifact may carry a deep field", () => {
  const journey = journeyResult();
  assertNoDeepAncestry(journey, "journey result");
  for (const field of [
    "deep_evaluation_commitment_hash",
    "deep_result_hash",
    "deep_pack_hashes",
    "deep_supplement_attestation_hash",
  ]) {
    throwsCode(
      () => assertNoDeepAncestry({ ...journey, [field]: h("d") }, "journey result"),
      "DEEP_ANCESTRY_FIELD_IN_GENERIC_ARTIFACT",
      field,
    );
    // Nested injection is caught too.
    throwsCode(
      () => assertNoDeepAncestry({ outer: { inner: [{ [field]: h("d") }] } }, "nested"),
      "DEEP_ANCESTRY_FIELD_IN_GENERIC_ARTIFACT",
      `nested ${field}`,
    );
    // And the closed schema refuses it as an unknown field.
    assert.equal(
      validateContract("PreSelectionJourneyResultV1", { ...journey, [field]: h("d") }).valid,
      false,
      field,
    );
  }
});

// -- 9. cleanup residue -------------------------------------------------------

test("CLEANUP: residual acquisition resources that are not quarantined fail cleanup", () => {
  const passing = buildPreEnvironmentCleanup({
    runId: RUN_ID,
    terminalStage: "verify_package",
    acquisitionPreregistrationHash: h("1"),
    acquisitionRecordHash: h("2"),
    subjectOutputHash: h("3"),
    acquiredArtifactDisposition: "deleted",
    cleanupReceiptHashes: [],
    residualAcquisitionResources: [],
    verifiedAt: AT,
  });
  assert.equal(passing.passed, true);

  const leaking = buildPreEnvironmentCleanup({
    runId: RUN_ID,
    terminalStage: "verify_package",
    acquisitionPreregistrationHash: h("1"),
    acquisitionRecordHash: h("2"),
    subjectOutputHash: h("3"),
    acquiredArtifactDisposition: "deleted",
    cleanupReceiptHashes: [],
    residualAcquisitionResources: [{ kind: "temp-file", identity_hash: h("4") }],
    verifiedAt: AT,
  });
  assert.equal(leaking.passed, false, "cleanup with residue does not pass");

  const quarantined = buildPreEnvironmentCleanup({
    runId: RUN_ID,
    terminalStage: "verify_package",
    acquisitionPreregistrationHash: h("1"),
    acquisitionRecordHash: h("2"),
    subjectOutputHash: h("3"),
    acquiredArtifactDisposition: "retained_quarantined",
    cleanupReceiptHashes: [],
    residualAcquisitionResources: [{ kind: "temp-file", identity_hash: h("4") }],
    verifiedAt: AT,
  });
  assert.equal(quarantined.passed, true, "explicit quarantine is an accounted-for outcome");
});
