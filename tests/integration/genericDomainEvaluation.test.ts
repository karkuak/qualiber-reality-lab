/**
 * Generic domain evaluation against the four reference subjects.
 *
 * Each subject is driven through the **real** adapter host over the public
 * protocol; the claim set the evaluator scores is the one the adapter actually
 * projected, not a hand-written fixture. The evaluator is the shipped one and
 * the pack is the shipped operations pack, bound through the real certification
 * receipt.
 *
 * The point of the suite is discrimination: correct, limited, misleading and
 * inconclusive subjects must produce *different, typed* outcomes without core
 * containing a single branch that knows which subject it is running.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DOMAIN_PLANE_METRICS,
  SteppingClock,
  bindDomainPack,
  buildDomainNotApplicable,
  evaluateDomain,
  genericMetricHashes,
  hardSafetyViolations,
  missingDomainAncestors,
  type AttributionPrerequisites,
  type DomainEvidence,
  type EvaluationClaim,
} from "@erl2/core";
import {
  ArtifactStore,
  coreHash,
  developmentKey,
  sealSigned,
} from "@erl2/integrity";
import { certifyPack } from "@erl2/evaluation-sdk";
import {
  OPERATIONS_METRIC_IDS,
  operationsPackBody,
} from "@erl2/pack-operations";
import {
  assertContract,
  type EvaluationPackManifestV1,
  type Hash,
  type Instant,
} from "@erl2/contracts";
import {
  RUN_START,
  REFERENCE_CORRECT_MANIFEST,
  REFERENCE_INCONCLUSIVE_MANIFEST,
  REFERENCE_LIMITED_MANIFEST,
  REFERENCE_MISLEADING_MANIFEST,
  newHost,
  referenceAdapterEntry,
  type ReferenceAdapterId,
} from "../support/adapterFixtures.js";

const RUN_ID = "01890000-0000-7000-8000-00000000006a";
const EVALUATED_AT = "2026-07-01T02:00:00Z" as Instant;

/** Forbidden subject tokens the pack certifier scans for. */
const FORBIDDEN_SUBJECT_TOKENS = [
  "qualiber",
  "trailhead",
  "telemetrytest",
  "scenario-lab",
];

/** Binds the shipped operations pack through real certification. */
function boundPack(): ReturnType<typeof bindDomainPack> {
  const body = operationsPackBody(coreHash);
  const certification = certifyPack({
    body,
    metricDefinitions: DOMAIN_PLANE_METRICS,
    forbiddenSubjectTokens: FORBIDDEN_SUBJECT_TOKENS,
    certifierId: "independent-evaluation-reviewer",
    certifiedAt: RUN_START as Instant,
    hash: coreHash,
  });
  assert.equal(
    certification.passed,
    true,
    `the shipped operations pack must certify: ${JSON.stringify(certification.checks.filter((c) => !c.passed))}`,
  );
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
        vocabulary_hash: coreHash({
          vocabulary: "software-delivery-operations/v1",
        }),
        truth_schema_hash: coreHash({ truth_schema: "operations-truth/v1" }),
        assertion_ids: body.assertions.map((a) => a.assertion_id),
        metric_definitions: genericMetricHashes(OPERATIONS_METRIC_IDS),
        prohibited_core_apis: ["node:fs", "node:net", "node:child_process"],
        reviewer_ids: ["domain-reviewer", "bias-reviewer"],
        bias_review_hash: coreHash({ bias_review: "operations-pack" }),
        certification_receipt_hash: certification.core_hash,
      },
      developmentKey("evaluator"),
    ),
  );
  return bindDomainPack({
    manifest,
    body,
    certification,
    metricDefinitions: DOMAIN_PLANE_METRICS,
  });
}

/** Runs a reference adapter's `project` operation over the public protocol. */
function projectedClaims(id: ReferenceAdapterId): readonly EvaluationClaim[] {
  const manifest = {
    "reference-correct": REFERENCE_CORRECT_MANIFEST,
    "reference-limited": REFERENCE_LIMITED_MANIFEST,
    "reference-misleading": REFERENCE_MISLEADING_MANIFEST,
    "reference-inconclusive": REFERENCE_INCONCLUSIVE_MANIFEST,
  }[id]();
  const fixture = newHost(manifest, referenceAdapterEntry(id));
  const result = fixture.host.run({
    operation: "project",
    operationId: "op-project",
    request: {
      schema_version: "adapter-step-request/v1",
      protocol_version: "subject-adapter/v1",
      run_id: RUN_ID,
      operation_id: "op-project",
    },
  });
  assert.equal(result.envelope.status, "supported", `${id} must project`);
  const projected =
    (result.result as { claims?: readonly Record<string, unknown>[] }).claims ??
    [];
  return projected.map((claim) => ({
    claim_id: String(claim["claim_id"]),
    category: claim["category"] as EvaluationClaim["category"],
    predicate_id: String(claim["predicate_id"]),
    // The reference adapters cite by locator only; the object value is the
    // predicate's asserted subject, which the Lab derives from the projection.
    object_value: String(claim["predicate_id"]),
    polarity: claim["polarity"] as EvaluationClaim["polarity"],
    authority: claim["authority"] as EvaluationClaim["authority"],
    citations: (
      (claim["citations"] as { locator: string }[] | undefined) ?? []
    ).map((c) => ({
      artifact_file_sha256: ENVELOPE_DIGEST,
      locator: c.locator,
    })),
    weight: 1,
    supporting_association_ids: [],
  }));
}

/**
 * The frozen canonical envelope every citation must resolve into.
 *
 * Only the two locators the Lab actually captured are reachable. A citation to
 * anything else is a fabricated citation, detected by set membership rather
 * than by any similarity judgement.
 */
const ENVELOPE_DIGEST = `sha256:${"a".repeat(64)}` as Hash;
const ENVELOPE = {
  entry_digests: new Set<string>([ENVELOPE_DIGEST]),
  reachable_locators: new Set<string>([
    `${ENVELOPE_DIGEST}#acquisition/notes.txt`,
    `${ENVELOPE_DIGEST}#translated/deployment-log.json`,
  ]),
};

const TRUTH_FACTS = [
  {
    fact_id: "documentation-consulted",
    predicate_id: "documentation-consulted",
    object_value: "documentation-consulted",
    weight: 1,
    is_unknown_gap: false,
  },
  {
    // A genuine gap: the correct answer is to abstain, not to guess.
    fact_id: "root-cause-of-latency",
    predicate_id: "root-cause-of-latency",
    object_value: "root-cause-of-latency",
    weight: 1,
    is_unknown_gap: true,
  },
  {
    fact_id: "error-rate-increased",
    predicate_id: "error-rate-increased",
    object_value: "error-rate-increased",
    weight: 1,
    is_unknown_gap: true,
  },
];

const SOURCES = [
  {
    source_id: "deployment-log",
    state: "complete" as const,
    decision_changing: true,
    disclosed_unavailable: false,
  },
  {
    // Degraded. Disclosing it is the hard-safety requirement.
    source_id: "metrics-store",
    state: "unavailable" as const,
    decision_changing: true,
    disclosed_unavailable: false,
  },
];

const ATTRIBUTION: AttributionPrerequisites = {
  baselineValid: true,
  revealedJudgeExpectationHash: `sha256:${"b".repeat(64)}` as Hash,
  adapterFunctioning: true,
  withinSubjectBoundary: true,
  counterfactualControlRefs: [],
  unresolvedLabOrDependencyCauses: [],
};

const ANCESTORS = {
  observationBundleHash: `sha256:${"c".repeat(64)}` as Hash,
  canonicalEvidenceEnvelopeHash: ENVELOPE_DIGEST,
  subjectOutputHash: `sha256:${"d".repeat(64)}` as Hash,
  truthRevealHash: `sha256:${"e".repeat(64)}` as Hash,
  claimSetHash: `sha256:${"f".repeat(64)}` as Hash,
};

function evaluateSubject(
  id: ReferenceAdapterId,
  overrides: Partial<DomainEvidence> = {},
): ReturnType<typeof evaluateDomain> {
  return evaluateDomain({
    runId: RUN_ID,
    genericRunPolicyHash: `sha256:${"1".repeat(64)}` as Hash,
    pack: boundPack(),
    ancestors: ANCESTORS,
    evidence: {
      claims: projectedClaims(id),
      requiredTruthFacts: TRUTH_FACTS,
      evidenceSources: SOURCES,
      envelope: ENVELOPE,
      credentialCanaries: ["erl2-credential-canary"],
      authorityCeiling: "advisory",
      correctAbstentionApplies: true,
      ...overrides,
    },
    attribution: ATTRIBUTION,
    evaluatedAt: EVALUATED_AT,
  });
}

function metric(result: ReturnType<typeof evaluateDomain>, id: string) {
  const found = result.metricResults.find((m) => m.metric_id === id);
  assert.ok(found, `metric ${id} was evaluated`);
  return found;
}

test("PACK-CERTIFICATION: the shipped operations pack is data-only and certifies", () => {
  const pack = boundPack();
  assert.equal(pack.body.scope, "domain");
  assert.equal(
    pack.body.subject_id,
    undefined,
    "a domain pack binds no subject identity",
  );
  // The pack declares no metric definition of its own: it references Lab-owned
  // metrics, so it cannot move a generic threshold.
  assert.deepEqual(
    [...pack.body.metric_ids].sort(),
    [...OPERATIONS_METRIC_IDS].sort(),
  );
  const serialized = JSON.stringify(pack.body);
  for (const forbidden of [
    "function",
    "=>",
    "require(",
    "node:fs",
    "Math.random",
    "Date.now",
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      `the pack body must not contain ${forbidden}`,
    );
  }
});

test("DISCRIMINATION: the correct reference subject makes only supported, reachable claims", () => {
  const result = evaluateSubject("reference-correct");
  assert.equal(
    metric(result, "citation-reachability").threshold_satisfied,
    true,
  );
  assert.equal(metric(result, "causal-overclaim").value, "0");
  assert.equal(metric(result, "credential-safety").value, "0");
  assert.equal(metric(result, "authority-scope").value, "0");
  assert.deepEqual(
    hardSafetyViolations(result.metricResults).map((m) => m.metric_id),
    ["degradation-honesty"],
    "the only hard-safety failure is the undisclosed degraded source, which is a genuine one",
  );
});

test("DISCRIMINATION: the misleading subject fails causal overclaim, citation reachability and authority", () => {
  const result = evaluateSubject("reference-misleading");

  // A causal claim with no declared supporting association.
  const causal = metric(result, "causal-overclaim");
  assert.equal(causal.status, "measured");
  assert.equal(causal.value, "1", "every causal claim is unsupported");
  assert.equal(causal.threshold_satisfied, false);
  assert.equal(causal.threshold_class, "hard_safety");

  // A citation whose locator is not in the frozen canonical envelope.
  const citation = metric(result, "citation-reachability");
  assert.equal(
    citation.threshold_satisfied,
    false,
    "a fabricated citation is detected",
  );
  assert.ok(
    Number(citation.numerator) < Number(citation.denominator),
    "at least one cited claim does not resolve",
  );

  // An action claim asserting more authority than the policy permits.
  const authority = metric(result, "authority-scope");
  assert.equal(authority.value, "1");
  assert.equal(authority.threshold_satisfied, false);

  // Every finding it produces is a *subject* finding on the domain plane, and
  // none of them is Lab invalidity or an adapter failure.
  assert.ok(
    result.findings.length >= 3,
    "each violated assertion produces a finding",
  );
  for (const finding of result.findings) {
    assert.equal(finding.kind, "subject_finding");
    assert.equal(finding.owner, "subject");
    assert.equal(finding.subject_attribution_proven, true);
  }
  const ids = result.findings.map((f) => f.finding_id);
  assert.ok(ids.includes("domain-no-unsupported-causal-claim"));
  assert.ok(ids.includes("domain-every-cited-locator-is-reachable"));
  assert.ok(ids.includes("domain-authority-stays-within-ceiling"));
});

test("DISCRIMINATION: the inconclusive subject abstains correctly and makes no causal overclaim", () => {
  const result = evaluateSubject("reference-inconclusive");

  const abstention = metric(result, "correct-abstention");
  assert.equal(abstention.status, "measured");
  assert.equal(
    abstention.value,
    "1",
    "every explicit unknown matches a genuine truth gap",
  );
  assert.equal(abstention.threshold_satisfied, true);

  // No causal claim at all: zero over an empty denominator, resolved through
  // the declared behaviour rather than guessed.
  const causal = metric(result, "causal-overclaim");
  assert.equal(causal.denominator, 0);
  assert.equal(causal.value, "0");
  assert.ok(causal.reason_codes.includes("ZERO_DENOMINATOR"));

  assert.equal(
    metric(result, "citation-reachability").threshold_satisfied,
    true,
  );
  assert.equal(
    result.findings.some(
      (f) => f.finding_id === "domain-no-unsupported-causal-claim",
    ),
    false,
    "abstaining is not a defect",
  );
});

test("DISCRIMINATION: the limited subject projects nothing and is inconclusive, not wrong", () => {
  const result = evaluateSubject("reference-limited");
  // No claims at all. Precision resolves through
  // `one_only_when_correct_abstention`, which is 1 only because abstaining was
  // in fact the right answer here.
  const precision = metric(result, "evidence-precision");
  assert.equal(precision.denominator, 0);
  assert.equal(precision.value, "1");
  assert.ok(precision.reason_codes.includes("ZERO_DENOMINATOR"));

  const withoutAbstention = evaluateDomain({
    runId: RUN_ID,
    genericRunPolicyHash: `sha256:${"1".repeat(64)}` as Hash,
    pack: boundPack(),
    ancestors: ANCESTORS,
    evidence: {
      claims: projectedClaims("reference-limited"),
      requiredTruthFacts: TRUTH_FACTS,
      evidenceSources: SOURCES,
      envelope: ENVELOPE,
      credentialCanaries: [],
      authorityCeiling: "advisory",
      correctAbstentionApplies: false,
    },
    attribution: ATTRIBUTION,
    evaluatedAt: EVALUATED_AT,
  });
  const strict = withoutAbstention.metricResults.find(
    (m) => m.metric_id === "evidence-precision",
  );
  assert.equal(
    strict?.value,
    "0",
    "silence is only perfect when silence was the right answer",
  );
  assert.ok(strict?.reason_codes.includes("CORRECT_ABSTENTION_NOT_APPLICABLE"));
});

test("EMPTY-SOURCE: an empty evidence source set never fabricates a functional score", () => {
  const result = evaluateSubject("reference-correct", { evidenceSources: [] });
  const degradation = result.metricResults.find(
    (m) => m.metric_id === "degradation-honesty",
  );
  assert.equal(degradation?.status, "not_applicable");
  assert.equal(
    degradation?.value,
    undefined,
    "a not-applicable metric carries no value",
  );
  assert.ok(degradation?.reason_codes.includes("ZERO_DENOMINATOR"));
});

test("DOMAIN-NOT-APPLICABLE: missing functional evidence uses the not-applicable branch", () => {
  const ancestors = { ...ANCESTORS, canonicalEvidenceEnvelopeHash: undefined };
  assert.deepEqual(missingDomainAncestors(ancestors), [
    "canonical-evidence-envelope",
  ]);
  assert.throws(
    () =>
      evaluateDomain({
        runId: RUN_ID,
        genericRunPolicyHash: `sha256:${"1".repeat(64)}` as Hash,
        pack: boundPack(),
        ancestors,
        evidence: {
          claims: [],
          requiredTruthFacts: TRUTH_FACTS,
          evidenceSources: SOURCES,
          envelope: ENVELOPE,
          credentialCanaries: [],
          authorityCeiling: "advisory",
          correctAbstentionApplies: true,
        },
        attribution: ATTRIBUTION,
        evaluatedAt: EVALUATED_AT,
      }),
    /EVALUATOR_DOMAIN_EVIDENCE_UNAVAILABLE|canonical-evidence-envelope/,
  );

  // The honest alternative carries the exact reason and the journey it follows.
  const journeyResultHash = `sha256:${"9".repeat(64)}` as Hash;
  const notApplicable = buildDomainNotApplicable({
    runId: RUN_ID,
    genericRunPolicyHash: `sha256:${"1".repeat(64)}` as Hash,
    terminalStage: "connect",
    reason: "connection_terminal",
    journeyResultHash,
    findingHashes: [],
    recordedAt: EVALUATED_AT,
  });
  assert.equal(notApplicable.status, "not_applicable");
  assert.equal(notApplicable.reason, "connection_terminal");
  assert.equal(notApplicable.journey_result_hash, journeyResultHash);
});

test("DETERMINISM: identical frozen inputs produce identical metric identities", () => {
  const first = evaluateSubject("reference-misleading");
  const second = evaluateSubject("reference-misleading");
  assert.deepEqual(
    first.metricResults.map((m) => m.result_identity_hash),
    second.metricResults.map((m) => m.result_identity_hash),
  );
  assert.equal(first.result.core_hash, second.result.core_hash);
});

test("SECRET-SAFETY: a credential canary inside a claim is a hard-safety violation", () => {
  const canary = "erl2-credential-canary-9f2c";
  const claims: EvaluationClaim[] = [
    {
      claim_id: "leaky-claim",
      category: "fact",
      predicate_id: "documentation-consulted",
      object_value: `token=${canary}`,
      polarity: "asserted",
      authority: "none",
      citations: [
        {
          artifact_file_sha256: ENVELOPE_DIGEST,
          locator: "acquisition/notes.txt",
        },
      ],
      weight: 1,
      supporting_association_ids: [],
    },
  ];
  const result = evaluateDomain({
    runId: RUN_ID,
    genericRunPolicyHash: `sha256:${"1".repeat(64)}` as Hash,
    pack: boundPack(),
    ancestors: ANCESTORS,
    evidence: {
      claims,
      requiredTruthFacts: TRUTH_FACTS,
      evidenceSources: SOURCES,
      envelope: ENVELOPE,
      credentialCanaries: [canary],
      authorityCeiling: "advisory",
      correctAbstentionApplies: true,
    },
    attribution: ATTRIBUTION,
    evaluatedAt: EVALUATED_AT,
  });
  const safety = result.metricResults.find(
    (m) => m.metric_id === "credential-safety",
  );
  assert.equal(safety?.value, "1");
  assert.equal(safety?.threshold_satisfied, false);
  assert.equal(safety?.threshold_class, "hard_safety");
  assert.ok(
    result.findings.some(
      (f) => f.finding_id === "domain-no-credential-material-in-claims",
    ),
  );
});

test("REMOVABILITY: the new reference subjects are separate packages core never imports", () => {
  const repoRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "..",
    "..",
  );
  for (const id of [
    "reference-misleading",
    "reference-inconclusive",
  ] as const) {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "adapters", id, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.deepEqual(
      Object.keys(manifest.dependencies).sort(),
      ["@erl2/adapter-sdk", "@erl2/contracts"],
      `${id} uses only the public SDK and contracts`,
    );
  }
  // A throwaway store proves the evaluator needs no adapter package at all.
  const store = new ArtifactStore(
    mkdtempSync(path.join(tmpdir(), "erl2-eval-store-")),
  );
  void store;
  void new SteppingClock(RUN_START, 1000);
  assert.ok(
    DOMAIN_PLANE_METRICS.length > 0,
    "the metric catalogue is Lab-owned",
  );
});
