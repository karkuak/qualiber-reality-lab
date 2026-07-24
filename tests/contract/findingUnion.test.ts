/**
 * The closed finding union and its prohibited crossovers (design v2 §17,
 * implementation plan §12.1 S6.1).
 *
 * `FindingV1` is a `oneOf` discriminated by `kind`, and `owner`, `category`,
 * `subject_attribution_proven` and `scoreable_planes` are literal per branch.
 * Each test below states one ownership rule and proves it *twice*: the schema
 * refuses the mutation, and the runtime guard refuses it again for an artifact
 * that reached the store by another route.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  assertFindingOwnershipConsistent,
  assertInvalidRunAssertsNoSubjectDefect,
  buildAdapterFailure,
  buildDependencyFinding,
  buildEvaluatorFailure,
  buildInconclusiveFinding,
  buildLabInvalidity,
  buildSubjectFinding,
  type AttributionPrerequisites,
} from "@erl2/core";
import { validateContract, type FindingV1, type Hash } from "@erl2/contracts";

const RUN_ID = "01890000-0000-7000-8000-00000000f001";
const H = (label: string): Hash =>
  `sha256:${label.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "0")}` as Hash;

const PROVEN: AttributionPrerequisites = {
  baselineValid: true,
  revealedJudgeExpectationHash: H("abcdef"),
  adapterFunctioning: true,
  withinSubjectBoundary: true,
  counterfactualControlRefs: [H("cc")],
  unresolvedLabOrDependencyCauses: [],
};


/**
 * Asserts a typed refusal by its stable code.
 *
 * `assert.throws` with a regular expression matches the *message*, and an
 * `Erl2Error` message is prose; the code is the contract, so the tests below
 * assert on `error.code`.
 */
function throwsCode(fn: () => unknown, code: string, label = ""): void {
  try {
    fn();
  } catch (error) {
    assert.equal((error as { code?: string }).code, code, `${label}: ${String(error)}`);
    return;
  }
  assert.fail(`${label}: expected refusal ${code}, but nothing was thrown`);
}

const base = { runId: RUN_ID, severity: "high" as const, proofRefs: [H("aa")], summary: "s" };

/** Every branch of the union, built through its only constructor. */
function everyBranch(): readonly FindingV1[] {
  return [
    buildSubjectFinding({
      ...base,
      findingId: "subject",
      category: "subject_installation_failure",
      prerequisites: PROVEN,
      scoreablePlanes: ["journey"],
    }),
    buildDependencyFinding({
      ...base,
      findingId: "dependency",
      dependencyId: "upstream-registry",
      dependencyHealthHash: H("bb"),
    }),
    buildAdapterFailure({
      ...base,
      findingId: "adapter",
      category: "adapter_protocol_failure",
      adapterHash: H("cc"),
      certificationReceiptHash: H("dd"),
    }),
    buildEvaluatorFailure({
      ...base,
      findingId: "evaluator",
      category: "evaluator_nondeterminism",
      evaluatorOrPackHash: H("ee"),
    }),
    buildLabInvalidity({
      ...base,
      findingId: "lab",
      category: "lab_baseline_failure",
      failedGateIds: ["environment-baseline-clean"],
    }),
    buildInconclusiveFinding({
      ...base,
      findingId: "inconclusive",
      missingProofIds: ["metrics-store-snapshot"],
      scoreablePlanes: ["domain"],
    }),
  ];
}

test("FINDING-UNION: every branch validates, and each carries its literal owner", () => {
  const expected: Readonly<Record<string, string>> = {
    subject_finding: "subject",
    dependency_failure: "external_dependency",
    adapter_failure: "adapter",
    evaluator_failure: "evaluator",
    lab_invalidity: "lab",
    inconclusive: "inconclusive",
  };
  const kinds = new Set<string>();
  for (const finding of everyBranch()) {
    assert.equal(validateContract("FindingV1", finding).valid, true, finding.kind);
    assert.equal(finding.owner, expected[finding.kind]);
    assertFindingOwnershipConsistent(finding);
    kinds.add(finding.kind);
  }
  assert.equal(kinds.size, 6, "the union has exactly six branches and all are exercised");
});

test("FINDING-CROSSOVER: infrastructure failure can never become a subject defect", () => {
  for (const finding of everyBranch()) {
    if (finding.kind === "subject_finding") continue;
    // Relabelling the owner is refused by the schema...
    const relabelled = { ...finding, owner: "subject" };
    assert.equal(validateContract("FindingV1", relabelled).valid, false, finding.kind);
    // ...and by the runtime guard, for an artifact that bypassed validation.
    throwsCode(
      () => assertFindingOwnershipConsistent(relabelled as unknown as FindingV1),
      "EVALUATOR_FINDING_OWNER_CONTRADICTION",
      finding.kind,
    );
  }
});

test("FINDING-CROSSOVER: a non-subject branch cannot claim proven attribution or a scoreable plane", () => {
  for (const finding of everyBranch()) {
    if (finding.kind === "subject_finding" || finding.kind === "inconclusive") continue;
    assert.equal(
      validateContract("FindingV1", { ...finding, subject_attribution_proven: true }).valid,
      false,
    );
    assert.equal(
      validateContract("FindingV1", { ...finding, scoreable_planes: ["journey"] }).valid,
      false,
    );
    throwsCode(
      () =>
        assertFindingOwnershipConsistent({
          ...finding,
          scoreable_planes: ["journey"],
        } as unknown as FindingV1),
      "EVALUATOR_FINDING_OWNER_CONTRADICTION",
      finding.kind,
    );
  }
});

test("FINDING-CROSSOVER: a subject finding cannot carry a Lab or adapter category", () => {
  const subject = everyBranch()[0] as FindingV1;
  for (const category of ["lab_invalid", "adapter_protocol_failure", "external_dependency_failure"]) {
    assert.equal(validateContract("FindingV1", { ...subject, category }).valid, false, category);
    throwsCode(
      () => assertFindingOwnershipConsistent({ ...subject, category } as unknown as FindingV1),
      "EVALUATOR_FINDING_OWNER_CONTRADICTION",
      category,
    );
  }
});

test("ATTRIBUTION: a subject finding cannot be built when a prerequisite is missing", () => {
  const cases: readonly (readonly [string, Partial<AttributionPrerequisites>])[] = [
    ["baseline", { baselineValid: false }],
    ["adapter", { adapterFunctioning: false }],
    ["boundary", { withinSubjectBoundary: false }],
    ["unresolved cause", { unresolvedLabOrDependencyCauses: ["ENV_PROVISION_FAILED"] }],
    ["revealed expectation", { revealedJudgeExpectationHash: undefined }],
  ];
  for (const [label, override] of cases) {
    throwsCode(
      () =>
        buildSubjectFinding({
          ...base,
          findingId: "subject",
          category: "subject_installation_failure",
          prerequisites: { ...PROVEN, ...override },
          scoreablePlanes: ["journey"],
        }),
      "EVALUATOR_SUBJECT_ATTRIBUTION_UNPROVEN",
      label,
    );
  }
});

test("UNSUPPORTED-RETENTION: unsupported is retained, never scored and never Lab invalidity", () => {
  const unsupported = buildSubjectFinding({
    ...base,
    findingId: "unsupported",
    severity: "info",
    category: "subject_unsupported",
    prerequisites: PROVEN,
    scoreablePlanes: [],
  });
  assert.equal(unsupported.owner, "subject");
  assert.deepEqual(unsupported.scoreable_planes, []);
  assertFindingOwnershipConsistent(unsupported);

  // Relabelling it as a scored defect is refused.
  throwsCode(
    () =>
      buildSubjectFinding({
        ...base,
        findingId: "unsupported",
        category: "subject_unsupported",
        prerequisites: PROVEN,
        scoreablePlanes: ["domain"],
      }),
    "EVALUATOR_UNSUPPORTED_RELABELLED",
  );
  // Relabelling it as Lab invalidity is refused by the schema: `lab_invalid` is
  // not a subject category and `subject_unsupported` is not a Lab category.
  assert.equal(
    validateContract("FindingV1", { ...unsupported, kind: "lab_invalidity", owner: "lab" }).valid,
    false,
  );
});

test("INVALID-RUN: an invalid run retains measurements but attests no subject defect", () => {
  const findings = everyBranch();
  throwsCode(
    () => assertInvalidRunAssertsNoSubjectDefect(findings),
    "EVALUATOR_INVALID_RUN_CANNOT_ATTEST_SUBJECT",
  );
  // Unsupported and every non-subject branch remain retainable diagnostics.
  const retainable = findings.filter((f) => f.kind !== "subject_finding");
  assertInvalidRunAssertsNoSubjectDefect(retainable);
});

test("DEEP-BOUNDARY: generic evaluation cannot mark a finding scoreable on the deep plane", () => {
  throwsCode(
    () =>
      buildSubjectFinding({
        ...base,
        findingId: "subject",
        category: "subject_functional_miss",
        prerequisites: PROVEN,
        scoreablePlanes: ["deep"],
      }),
    "DEEP_ANCESTRY_FIELD_IN_GENERIC_ARTIFACT",
  );
  throwsCode(
    () =>
      buildInconclusiveFinding({
        ...base,
        findingId: "inconclusive",
        missingProofIds: ["x"],
        scoreablePlanes: ["deep"],
      }),
    "DEEP_ANCESTRY_FIELD_IN_GENERIC_ARTIFACT",
  );
});

test("INCONCLUSIVE: an inconclusive finding must name what was missing", () => {
  throwsCode(
    () =>
      buildInconclusiveFinding({
        ...base,
        findingId: "inconclusive",
        missingProofIds: [],
        scoreablePlanes: ["domain"],
      }),
    "EVALUATOR_UNDECLARED_REASON_CODE",
  );
});
