/**
 * RL-D-031 — a verdict re-derived from a gate set the producer chose.
 *
 * ## The boundary this file measures
 *
 * RL-D-028 stopped both terminal branches trusting the producer's *verdict*:
 * `status` is now recomputed from `gate_results`, and a result that disagrees
 * with its own gates is refused. What neither branch checked is whether those
 * gates are the gates the run owed.
 *
 * `statusOf` is `gates.every((g) => g.passed)`, and `every` over an empty array
 * is `true`. Reproduced on the merge base (62e7116d) against the shipped CLI,
 * with every mutation fully re-signed: deleting the failed row, narrowing the
 * array to one passing gate, supplying no gates at all, and substituting
 * identifiers the Lab does not own each left `erl2 verify --offline` reporting
 * **exit 0 / `valid`**. Seven of ten refuse-intent cases evaded. Re-deriving a
 * verdict from an attacker-chosen set of inputs is not an independent
 * derivation; it is the producer's answer reached by a longer route.
 *
 * ## Why these cases are believable
 *
 * The pre-environment cases drive the **real shipped CLI** over a fully
 * re-signed bundle: core hashes recomputed, lifecycle re-chained, terminal
 * re-signed under an authorized role, signed freeze head preserved. The
 * identity control proves the cascade lands back on the shipped terminal byte
 * for byte, so no case here can be passing because the rebuild broke something
 * incidental.
 *
 * The environment cases drive a **real environment run** to its generic-
 * finalized terminal and feed the real verifier entry point with that run's
 * genuine index, lifecycle and retained step outcomes. There is no committed
 * environment golden to copy, and mutating retained files would surface as
 * `ARTIFACT_HASH_MISMATCH` before any semantic rule ran — so the mutation is
 * applied to the object the derivation reads, exactly as the shipped
 * environment adversarial suite already does.
 *
 * ## What is deliberately not claimed
 *
 * Completeness is a claim about the **retained set**: every gate the branch owed
 * is present exactly once, nothing off-catalogue is scored, and applicability is
 * enforced. It is not a claim that any gate was independently re-executed.
 *
 * The shipped goldens are copied, never written to.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArtifactIndex,
  derivePreEnvironmentValidity,
  deriveTelemetryDeclaration,
  deriveValidityOutcome,
  verifierRequiredGateIds,
} from "@erl2/public-verifier";
import type {
  AcquisitionPreregistrationV1,
  EnvironmentValidityResultV1,
  JourneyStepOutcomeV1,
  LabLifecycleEventV1,
  SubjectExecutionMode,
} from "@erl2/contracts";
import {
  copyPreEnvironmentGolden,
  gatesOf,
  readJson,
  resignCascade,
  verifyOffline,
  type GateRow,
  type Json,
} from "../support/preEnvironmentCascade.js";
import { writeLifecycle, verifyBundle } from "../support/cliRun.js";
import { drive, selectedRun, type EnvironmentRun } from "../support/environmentCli.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The pre-environment required set, written out rather than computed.
 *
 * This is the independent statement of the property. Building it from
 * `verifierRequiredGateIds` would make every assertion below a tautology — the
 * function under test would be supplying its own expected answer — so the
 * fifteen identifiers are listed, and the first test asserts the shipped
 * catalogue still agrees with them. A catalogue change that widens or narrows
 * the set must therefore be made here too, deliberately, by someone who has read
 * what the change means.
 */
const EXPECTED_PRE_ENVIRONMENT_REQUIRED: readonly string[] = [
  "contract-schema-closure",
  "contract-version-closure",
  "lifecycle-chain-verified",
  "lifecycle-state-machine-respected",
  "acquisition-preregistered-before-access",
  "acquired-bytes-frozen",
  "package-integrity-policy-applied",
  "evidence-sources-accounted",
  "adapter-authority-respected",
  "subject-output-frozen-before-reveal",
  "no-execution-after-output-freeze",
  "precleanup-result-join-closed",
  "cleanup-verified",
  "trust-policy-resolved",
  "timestamp-checkpoints-acyclic",
];

const sorted = (ids: readonly string[]): string[] => [...ids].sort();
const copyGolden = () => copyPreEnvironmentGolden("erl2-d031-");

/** Runs one doctored pre-environment terminal through the real offline CLI. */
function refusedBy(doctor: (validity: Json) => Json): {
  readonly code: string;
  readonly message: string;
  readonly exitCode: number;
  readonly verdict: string;
} {
  const c = copyGolden();
  resignCascade(c, doctor);
  return verifyOffline(c);
}

// -- the catalogue, pinned independently -------------------------------------

test("RLD031-CATALOGUE: the verifier's pre-environment required set is the fifteen gates this file names", () => {
  assert.deepEqual(
    sorted(verifierRequiredGateIds("pre_environment", "development_fake_port")),
    sorted(EXPECTED_PRE_ENVIRONMENT_REQUIRED),
  );
});

test("RLD031-CATALOGUE: an external-adapter run additionally owes adapter-certified", () => {
  // The one applicability bit the required set depends on, and the only thing
  // that may change it. It comes from a preregistrar-signed artifact, not from
  // anything the finalizer writes.
  assert.deepEqual(
    sorted(verifierRequiredGateIds("pre_environment", "external_adapter")),
    sorted([...EXPECTED_PRE_ENVIRONMENT_REQUIRED, "adapter-certified"]),
  );
  // And an environment terminal owes strictly more than a pre-environment one:
  // it reached controls the earlier terminal never exercised.
  const environment = verifierRequiredGateIds("environment", "development_fake_port");
  for (const gate of EXPECTED_PRE_ENVIRONMENT_REQUIRED) {
    assert.ok(environment.includes(gate), `the environment set must still owe ${gate}`);
  }
  assert.ok(
    environment.length > EXPECTED_PRE_ENVIRONMENT_REQUIRED.length,
    "an environment terminal owes more than a pre-environment one",
  );
});

test("RLD031-AUTHORITY: the required set is decided by a catalogue the producer cannot reach", () => {
  // Structural, and asserted at the source because it is the property the whole
  // correction rests on. The verifier's catalogue is a build-time import of
  // frozen constants; if it ever started reading a retained field, the required
  // set would become the thing under attack again.
  const source = readFileSync(
    path.join(repoRoot, "packages", "public-verifier", "src", "library", "gateSetAuthority.ts"),
    "utf8",
  );
  assert.match(
    source,
    /import \{[^}]*PRE_ENVIRONMENT_GATE_IDS[^}]*\} from "@erl2\/core"/s,
    "the catalogue must be imported, not reconstructed from retained bytes",
  );
  // Comments are stripped first, and deliberately: this module has to *discuss*
  // the producer fields it refuses to read, and a scanner that could not tell
  // prose from code would flag its own rationale.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.ok(code.includes("PRE_ENVIRONMENT_GATE_IDS"), "the comment stripper must not have eaten the code");
  for (const producerField of ["gate_results", "validity.status", "attestation", "lab_validity", "index."]) {
    assert.ok(
      !code.includes(producerField),
      `the required set must not be derived from ${producerField}`,
    );
  }
});

// -- pre-environment: baseline ------------------------------------------------

test("RLD031-P-BASELINE: the shipped golden retains exactly the required set, and verifies", () => {
  const c = copyGolden();
  const validity = readJson(path.join(c.artifacts, "retained", "validity-result.json"));
  assert.deepEqual(
    sorted(gatesOf(validity).map((g) => g.gate_id)),
    sorted(EXPECTED_PRE_ENVIRONMENT_REQUIRED),
    "the hand-built fixture must carry the real catalogue, not a convenient subset",
  );
  assert.ok(
    gatesOf(validity).every((g) => g.passed),
    "the honest golden passes every gate it evaluates",
  );
  const outcome = verifyOffline(c);
  assert.equal(outcome.exitCode, 0, `${outcome.code}: ${outcome.message}`);
  assert.equal(outcome.verdict, "valid");
});

test("RLD031-P-BASELINE: the cascade preserves the shipped terminal byte for byte", () => {
  const c = copyGolden();
  const before = readJson(path.join(c.artifacts, "retained", "final-attestation.json"))["core_hash"];
  const { attestationHash } = resignCascade(c, (v) => v);
  assert.equal(attestationHash, before, "a faithful cascade must reproduce the shipped terminal");
  const outcome = verifyOffline(c);
  assert.equal(outcome.exitCode, 0, `a faithful re-sign must still verify: ${outcome.code}`);
  assert.equal(outcome.verdict, "valid");
});

// -- pre-environment: completeness -------------------------------------------

test("RLD031-P1: deleting the gate that failed is refused", () => {
  // The evasion itself. An honest producer whose `cleanup-verified` failed
  // retains the failed row and freezes an invalid terminal; this one deletes it
  // and keeps `status: "valid"`. Before RL-D-031 the verifier derived `valid`
  // from the fourteen rows that remained.
  const outcome = refusedBy((v) => ({
    ...v,
    status: "valid",
    gate_results: gatesOf(v).filter((g) => g.gate_id !== "cleanup-verified"),
  }));
  assert.notEqual(outcome.exitCode, 0, `a deleted failed gate must be refused; verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "GRAPH_CLOSURE_MISSING_ROLE", outcome.message);
  assert.match(outcome.message, /cleanup-verified/, "the refusal must name the gate that went missing");
});

test("RLD031-P2: deleting a gate that passed is refused just as hard", () => {
  // Deliberately a *passing* gate: completeness is not a check on outcomes, and
  // a verifier that only noticed missing failures would still let a producer
  // hide which controls it never ran.
  const outcome = refusedBy((v) => ({
    ...v,
    gate_results: gatesOf(v).filter((g) => g.gate_id !== "lifecycle-chain-verified"),
  }));
  assert.notEqual(outcome.exitCode, 0, `verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "GRAPH_CLOSURE_MISSING_ROLE", outcome.message);
  assert.match(outcome.message, /lifecycle-chain-verified/);
});

test("RLD031-P3: a narrowed set is refused", () => {
  const outcome = refusedBy((v) => ({ ...v, gate_results: gatesOf(v).slice(0, 1) }));
  assert.notEqual(outcome.exitCode, 0, `verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "GRAPH_CLOSURE_MISSING_ROLE", outcome.message);
});

test("RLD031-P4: an empty set is refused, and not read as a run that passed everything", () => {
  // `every` over nothing is `true`, so this is the case the arithmetic gets
  // exactly backwards on its own.
  const outcome = refusedBy((v) => ({ ...v, status: "valid", gate_results: [] }));
  assert.notEqual(outcome.exitCode, 0, `an empty gate set must be refused; verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "GRAPH_CLOSURE_MISSING_ROLE", outcome.message);
});

test("RLD031-P5: a gate identifier the Lab does not own is refused", () => {
  const outcome = refusedBy((v) => ({
    ...v,
    gate_results: [
      ...gatesOf(v),
      { gate_id: "subject-claims-correct", passed: true, evidence_refs: [] } as GateRow,
    ],
  }));
  assert.notEqual(outcome.exitCode, 0, `verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED", outcome.message);
  assert.match(outcome.message, /subject-claims-correct/);
});

test("RLD031-P6: substituting the whole set with unknown identifiers is refused", () => {
  // The shape a producer reaches for when it wants a set that trivially passes:
  // fifteen rows, all `true`, none of them a control anyone agreed to.
  const outcome = refusedBy((v) => ({
    ...v,
    gate_results: EXPECTED_PRE_ENVIRONMENT_REQUIRED.map((id) => ({
      gate_id: `${id}-ok`,
      passed: true,
      evidence_refs: [],
    })) as GateRow[],
  }));
  assert.notEqual(outcome.exitCode, 0, `verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED", outcome.message);
});

test("RLD031-P7: a real catalogue gate belonging to the other branch is refused", () => {
  // `environment-baseline-clean` is a genuine `LAB_VALIDITY_GATES` member, so
  // the Lab-ownership check alone would pass it. A pre-environment terminal
  // never provisioned an environment, so scoring it asserts a control that was
  // never exercised — which is precisely what the branch catalogues exist to say.
  const outcome = refusedBy((v) => ({
    ...v,
    gate_results: [
      ...gatesOf(v),
      { gate_id: "environment-baseline-clean", passed: true, evidence_refs: [] } as GateRow,
    ],
  }));
  assert.notEqual(outcome.exitCode, 0, `verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED", outcome.message);
  assert.match(outcome.message, /environment-baseline-clean/);
});

test("RLD031-P8: a gate evaluated twice is refused", () => {
  const outcome = refusedBy((v) => {
    const rows = gatesOf(v);
    return { ...v, gate_results: [...rows, { ...(rows[0] as GateRow) }] };
  });
  assert.notEqual(outcome.exitCode, 0, `verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "EVALUATOR_VALIDITY_GATE_FAILED", outcome.message);
  assert.match(outcome.message, /more than once/);
});

test("RLD031-P9: a duplicate that disagrees with itself cannot pick the passing row", () => {
  // The reason duplicates are refused rather than reconciled: one row has to
  // lose, and which one lost would be decided by array order the producer chose.
  const outcome = refusedBy((v) => {
    const rows = gatesOf(v);
    return {
      ...v,
      status: "valid",
      gate_results: [...rows, { ...(rows[0] as GateRow), passed: false }],
    };
  });
  assert.notEqual(outcome.exitCode, 0, `verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "EVALUATOR_VALIDITY_GATE_FAILED", outcome.message);
});

// -- pre-environment: applicability ------------------------------------------

test("RLD031-P10: a fake-port run publishing adapter-certified is refused", () => {
  // This run's signed preregistration says `development_fake_port`, so there are
  // no adapter bytes to certify. `passed: true` here is a boolean answering a
  // question about applicability — the shape ADR-ERL2-036 rejected — and the
  // verifier now reads the signed mode rather than believing the gate.
  const outcome = refusedBy((v) => ({
    ...v,
    gate_results: [
      ...gatesOf(v),
      { gate_id: "adapter-certified", passed: true, evidence_refs: [] } as GateRow,
    ],
  }));
  assert.notEqual(outcome.exitCode, 0, `verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED", outcome.message);
  assert.match(outcome.message, /adapter-certified/);
});

test("RLD031-P11: the applicability answer comes from the preregistration, not the validity result", () => {
  // The golden's preregistration is signed by the preregistrar — a key the
  // finalizer does not hold — and says `development_fake_port`. Asserted so a
  // future fixture change that flips the mode cannot silently turn P10 into a
  // test of nothing.
  const c = copyGolden();
  const prereg = readJson(
    path.join(c.artifacts, "retained", "acquisition-preregistration.json"),
  ) as unknown as AcquisitionPreregistrationV1;
  assert.equal(prereg.subject_execution_mode, "development_fake_port");
  assert.ok(prereg.signature, "the applicability input must be a signed artifact");
  assert.equal(
    prereg.run_id,
    (readJson(path.join(c.artifacts, "retained", "run-record.json"))["run_id"] as string),
    "and it must be bound to this run",
  );
});

test("RLD031-P16: the execution mode is consumed, not assumed", () => {
  // Every committed pre-environment fixture preregisters the development fake
  // port, so nothing above could tell "reads the signed mode" from "hardcodes
  // development_fake_port" — and a verifier that hardcoded it would pass this
  // whole file while being exactly as wrong as one that read the producer.
  //
  // So the derivation is driven directly, over the real golden, with the mode
  // supplied both ways. The answers must differ, and differ in the direction the
  // catalogue says: an external-adapter run owes `adapter-certified`, and this
  // fixture does not carry it.
  const c = copyGolden();
  const index = ArtifactIndex.scan(c.artifacts);
  const record = readJson(path.join(c.artifacts, "retained", "run-record.json"));
  const validityResultHash = record["validity_result_hash"] as string;

  const asFakePort = derivePreEnvironmentValidity({
    index,
    validityResultHash: validityResultHash as never,
    requireValid: true,
    subjectExecutionMode: "development_fake_port",
  });
  assert.equal(asFakePort.status, "valid", "the golden is a valid fake-port terminal");

  assert.throws(
    () =>
      derivePreEnvironmentValidity({
        index,
        validityResultHash: validityResultHash as never,
        requireValid: true,
        subjectExecutionMode: "external_adapter",
      }),
    (error: unknown) => {
      const e = error as { code?: string; message?: string };
      return (
        e.code === "GRAPH_CLOSURE_MISSING_ROLE" &&
        (e.message ?? "").includes("adapter-certified")
      );
    },
    "the same bytes must derive a different required set under the other signed mode",
  );
});

test("RLD031-P17: the pre-environment call site reads the signed preregistration", () => {
  // The plumbing half of P16, pinned at the source: P16 proves the parameter is
  // consumed, this proves the production caller fills it from the preregistrar-
  // signed artifact rather than from anything the finalizer writes.
  const source = readFileSync(
    path.join(repoRoot, "packages", "public-verifier", "src", "library", "verify.ts"),
    "utf8",
  );
  assert.match(
    source,
    /derivePreEnvironmentValidity\(\{[^}]*subjectExecutionMode: preregistration\.subject_execution_mode/s,
    "the pre-environment derivation must be given the preregistration's mode",
  );
  assert.match(
    source,
    /requiredHash\(closure, "acquisition-preregistration"\)/,
    "and that preregistration must come from the derived closure, not a scan",
  );
});

// -- pre-environment: order, and the RL-D-028 properties still holding --------

test("RLD031-P12: a re-ordered honest set is accepted; order is irrelevant, not unchecked", () => {
  // A gate set is a set. Nothing in the producer or the verifier derives
  // anything from a row's position, so a reversed honest set must verify — and
  // saying so here is what makes "order is irrelevant" a claim rather than an
  // omission.
  const c = copyGolden();
  resignCascade(c, (v) => ({ ...v, gate_results: [...gatesOf(v)].reverse() }));
  const outcome = verifyOffline(c);
  assert.equal(outcome.exitCode, 0, `a re-ordered honest set must still verify: ${outcome.code}: ${outcome.message}`);
  assert.equal(outcome.verdict, "valid");
});

test("RLD031-P13: the complete set with a retained failed row is still refused", () => {
  // Completeness must not have made honesty worse: a producer that retains its
  // failure is refused for the failure, not for the shape of its set.
  const outcome = refusedBy((v) => ({
    ...v,
    status: "invalid",
    gate_results: gatesOf(v).map((g) =>
      g.gate_id === "cleanup-verified" ? { ...g, passed: false } : g,
    ),
  }));
  assert.notEqual(outcome.exitCode, 0, `verdict ${outcome.verdict}`);
  assert.ok(
    ["EVALUATOR_VALIDITY_GATE_FAILED", "BUNDLE_VARIANT_MISMATCH"].includes(outcome.code),
    `the refusal must be about the failure, not the set: ${outcome.code}: ${outcome.message}`,
  );
  assert.ok(
    outcome.code !== "GRAPH_CLOSURE_MISSING_ROLE",
    "a complete set must never be reported as incomplete",
  );
});

test("RLD031-P14: declared valid over a complete set containing a failure is refused", () => {
  const outcome = refusedBy((v) => ({
    ...v,
    status: "valid",
    gate_results: gatesOf(v).map((g) =>
      g.gate_id === "cleanup-verified" ? { ...g, passed: false } : g,
    ),
  }));
  assert.notEqual(outcome.exitCode, 0, `verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "EVALUATOR_VALIDITY_GATE_FAILED", outcome.message);
});

test("RLD031-P15: declared invalid over a complete all-passing set is refused", () => {
  const outcome = refusedBy((v) => ({ ...v, status: "invalid" }));
  assert.notEqual(outcome.exitCode, 0, `verdict ${outcome.verdict}`);
  assert.equal(outcome.code, "EVALUATOR_VALIDITY_GATE_FAILED", outcome.message);
});

// -- environment: the same class, on the branch that also had it -------------

interface EnvironmentContext {
  readonly index: ArtifactIndex;
  readonly validity: EnvironmentValidityResultV1;
  readonly outcomes: readonly JourneyStepOutcomeV1[];
  readonly telemetryObservationRetained: boolean;
  readonly subjectExecutionMode: SubjectExecutionMode;
  readonly attributableTelemetryApplicable: boolean;
}

/**
 * A real environment run, finalized, with the derivation inputs resolved the way
 * the production caller resolves them — from the lifecycle's own role map.
 */
function environmentContext(run: EnvironmentRun): EnvironmentContext {
  const lifecycle = JSON.parse(
    readFileSync(writeLifecycle(run.runRoot), "utf8"),
  ) as LabLifecycleEventV1[];
  const index = ArtifactIndex.scan(run.runRoot);
  const roles = new Map<string, string[]>();
  for (const event of lifecycle) {
    for (const produced of event.produced) {
      const bucket = roles.get(produced.artifact_role) ?? [];
      bucket.push(produced.artifact_core_hash);
      roles.set(produced.artifact_role, bucket);
    }
  }
  return {
    index,
    validity: JSON.parse(
      readFileSync(path.join(run.runRoot, "retained", "validity-result.json"), "utf8"),
    ) as EnvironmentValidityResultV1,
    outcomes: (roles.get("journey-step-outcome") ?? [])
      .map((hash) => index.get(hash as never).value as JourneyStepOutcomeV1)
      .filter((outcome) => outcome.run_id === run.runId),
    telemetryObservationRetained:
      (roles.get("attributable-telemetry-observation") ?? []).length > 0,
    subjectExecutionMode: (
      index.get((roles.get("acquisition-preregistration") ?? [])[0] as never)
        .value as AcquisitionPreregistrationV1
    ).subject_execution_mode,
    attributableTelemetryApplicable: deriveTelemetryDeclaration({
      index,
      lifecycle,
      runId: run.runId,
    }),
  };
}

function envRefusal(context: EnvironmentContext, validity: unknown): string | undefined {
  try {
    deriveValidityOutcome({
      index: context.index,
      validity: validity as EnvironmentValidityResultV1,
      requireValid: true,
      outcomes: context.outcomes,
      telemetryObservationRetained: context.telemetryObservationRetained,
      subjectExecutionMode: context.subjectExecutionMode,
      attributableTelemetryApplicable: context.attributableTelemetryApplicable,
    });
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

test("RLD031-E: the environment branch refuses the same completeness class", () => {
  // One real run drives every case: the run is expensive, and the cases are
  // independent mutations of the same honest terminal.
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");
  const verified = verifyBundle(run.runRoot, {
    sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
  });
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  assert.equal((verified.body.data as { verdict: string }).verdict, "valid");

  const context = environmentContext(run);
  const rows = context.validity.gate_results;

  // Baseline: the honest terminal is accepted, and its set really is the set
  // this branch owes. Without this every refusal below could be incidental.
  assert.equal(envRefusal(context, context.validity), undefined, "the honest terminal must be accepted");
  const required = verifierRequiredGateIds("environment", context.subjectExecutionMode);
  for (const gate of required) {
    assert.ok(
      rows.some((r) => r.gate_id === gate),
      `a real environment run must retain the required gate ${gate}`,
    );
  }

  const withRows = (gate_results: unknown[]): unknown => ({ ...context.validity, gate_results });
  const drop = (id: string): unknown[] => rows.filter((r) => r.gate_id !== id);

  // A required gate deleted — the evasion, on this branch. `cleanup-verified` is
  // required here and is not applicability-governed, so nothing else can answer.
  assert.equal(
    envRefusal(context, withRows(drop("cleanup-verified"))),
    "GRAPH_CLOSURE_MISSING_ROLE",
    "deleting a required environment gate must be refused",
  );
  // An environment-only control deleted: the pre-environment set is not a legal
  // environment set, which is the shape a downgrading producer would reach for.
  assert.equal(
    envRefusal(context, withRows(drop("environment-not-contaminated"))),
    "GRAPH_CLOSURE_MISSING_ROLE",
    "an environment terminal may not drop its environment-control gates",
  );
  assert.equal(
    envRefusal(context, withRows(drop("selection-chain-closed"))),
    "GRAPH_CLOSURE_MISSING_ROLE",
    "an environment terminal may not drop its selection-integrity gates",
  );
  assert.equal(envRefusal(context, withRows([])), "GRAPH_CLOSURE_MISSING_ROLE", "an empty set must be refused");
  assert.equal(
    envRefusal(context, withRows(rows.slice(0, 2))),
    "GRAPH_CLOSURE_MISSING_ROLE",
    "a narrowed set must be refused",
  );
  assert.equal(
    envRefusal(context, withRows([...rows, { gate_id: "subject-claims-correct", passed: true, evidence_refs: [] }])),
    "EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED",
    "an off-catalogue identifier must be refused",
  );
  assert.equal(
    envRefusal(context, withRows([...rows, { ...(rows[0] as object) }])),
    "EVALUATOR_VALIDITY_GATE_FAILED",
    "a duplicated gate must be refused",
  );
  assert.equal(
    envRefusal(context, withRows([...rows, { gate_id: "adapter-certified", passed: true, evidence_refs: [] }])),
    "EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED",
    "a fake-port environment run may not publish adapter-certified",
  );

  // The vacuous-pass direction the applicability-governed exclusion could have
  // left open, and did: until RL-D-031 the verifier refused an
  // `attributable-telemetry-retained` gate only when the exercise had *failed*,
  // which is one conjunct of three. This fixture run drives a fake driver, so
  // telemetry is inapplicable for a different reason entirely — and publishing
  // the gate as passed over an observation the run could never have obtained was
  // accepted. Reproduced on this exact harness before the fix.
  assert.equal(
    context.attributableTelemetryApplicable,
    false,
    "this fixture run declares no telemetry; the case below is what makes that matter",
  );
  assert.equal(
    envRefusal(
      context,
      withRows([
        ...rows.filter((r) => r.gate_id !== "attributable-telemetry-retained"),
        { gate_id: "attributable-telemetry-retained", passed: true, evidence_refs: [] },
      ]),
    ),
    "EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED",
    "a run that never declared the observation obtainable may not publish the gate as passed",
  );

  // Order is irrelevant here too, and for the same reason.
  assert.equal(
    envRefusal(context, withRows([...rows].reverse())),
    undefined,
    "a re-ordered honest environment set must still be accepted",
  );

  // And the RL-D-028 properties still hold over a complete set.
  assert.equal(
    envRefusal(context, { ...context.validity, status: "invalid" }),
    "EVALUATOR_VALIDITY_GATE_FAILED",
    "declared invalid over an all-passing complete set must be refused",
  );
  assert.equal(
    envRefusal(
      context,
      withRows(rows.map((r) => (r.gate_id === "cleanup-verified" ? { ...r, passed: false } : r))),
    ),
    "EVALUATOR_VALIDITY_GATE_FAILED",
    "declared valid over a complete set containing a failure must be refused",
  );
});
