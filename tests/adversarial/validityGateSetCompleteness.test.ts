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
import { cpSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash, hashBytes, sealSigned, type SigningKey } from "@erl2/integrity";
import {
  ArtifactIndex,
  derivePreEnvironmentValidity,
  deriveEnvironmentSemantics,
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
  writeJson,
  type GateRow,
  type Json,
} from "../support/preEnvironmentCascade.js";
import { developmentKeyring } from "../support/keys.js";
import { ownedTempDir } from "../support/tempDirs.js";
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

// -- the environment call site's authority, measured -------------------------
//
// Everything above proves the *rule* is symmetric: `assertRetainedGateSetComplete`
// refuses the same class on both branches, and `RLD031-P16`/`RLD031-P17` prove
// the pre-environment call site really reads the signed preregistration rather
// than assuming a mode.
//
// The environment call site had no equivalent. `RLD031-E` supplies
// `subjectExecutionMode` to `deriveValidityOutcome` itself, so it measures the
// rule while stepping over the one line that connects the rule to the
// preregistrar's signature -- and a mutant replacing
//
//     subjectExecutionMode: preregistration.subject_execution_mode
//
// with a hardcoded `"development_fake_port"` at that call site survived the
// whole suite. A guard nothing measures is a guard nothing holds.
//
// So this case drives `deriveEnvironmentSemantics` -- the public entry point
// that resolves the preregistration from the lifecycle's own role map and reads
// the mode off it -- over two bundles that differ in exactly one signed field.

/**
 * The environment required set, written out rather than computed.
 *
 * The same discipline as `EXPECTED_PRE_ENVIRONMENT_REQUIRED` and for the same
 * reason: building this from `verifierRequiredGateIds` would let the function
 * under test supply its own expected answer. These are the twenty-seven
 * environment catalogue identifiers minus the three the applicability rules own
 * (`adapter-certified`, `subject-exercise-succeeded`,
 * `attributable-telemetry-retained`), which is what a `development_fake_port`
 * environment terminal owes.
 */
const EXPECTED_ENVIRONMENT_REQUIRED: readonly string[] = [
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
  "selection-chain-closed",
  "selection-reveal-order-respected",
  "environment-baseline-clean",
  "environment-not-contaminated",
  "evidence-cutoff-realized",
  "restoration-verified",
  "teardown-verified",
  "exposure-state-recorded",
  "mandatory-graph-closed",
];

/** The one gate an `external_adapter` environment terminal additionally owes. */
const EXTERNAL_ADAPTER_ONLY_GATE = "adapter-certified";

type Event = Json & {
  produced: { artifact_role: string; artifact_core_hash: string }[];
  core_hash: string;
  sequence: number;
  prior_event_hash?: string;
};

/**
 * A retained file's `.frozen` byte descriptor, re-stated after a rewrite.
 *
 * Without this the descriptor still names the byte length and SHA-256 of the
 * artifact as it was, and the rebuild would be refused for an accounting defect
 * before any semantic rule ran -- which is the failure mode that makes a
 * negative case worthless.
 */
function refreshFrozen(file: string): void {
  const descriptorPath = `${file}.frozen`;
  let descriptor: Json;
  try {
    descriptor = readJson(descriptorPath);
  } catch {
    return; /* not a frozen retained file */
  }
  writeJson(descriptorPath, {
    ...descriptor,
    byte_length: statSync(file).size,
    file_sha256: hashBytes(readFileSync(file)),
  });
}

/** Recomputes `core_hash`, writes the artifact back, and re-states its descriptor. */
function resealAt(file: string, body: Json): string {
  const { core_hash: _hash, signature: _signature, ...rest } = body;
  const hash = coreHash(rest);
  writeJson(file, { ...rest, core_hash: hash });
  refreshFrozen(file);
  return hash;
}

/** The same, re-signed under a role key rather than left bare. */
function resealSignedAt(file: string, body: Json, key: SigningKey): string {
  const { core_hash: _hash, signature: _signature, ...rest } = body;
  const sealed = sealSigned(rest, key) as Json;
  writeJson(file, sealed);
  refreshFrozen(file);
  return sealed["core_hash"] as string;
}

interface RebuiltRun {
  readonly dir: string;
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly preregistrationHash: string;
}

/**
 * A whole environment run rebuilt around a doctored preregistration, re-signed
 * by the **preregistrar** and rebound everywhere the environment entry point
 * reads.
 *
 * The attacker modelled here is stronger than the one the rest of this file
 * models. Every other case doctors an artifact the finalizer already controls;
 * this one hands the attacker the preregistrar key as well and *still* expects a
 * refusal, because the refusal does not come from the signature -- it comes from
 * the gate set the signed mode obliges the run to have retained.
 *
 * A doctored preregistration changes its own core hash, which unbinds the
 * lifecycle event that published it, which moves every event hash after it,
 * which moves the signed freeze head, which unbinds the run record, which
 * unbinds the attestation's `run_record_hash`, which is signed. Each step below
 * restores one of those links, and the events are written back to
 * `events/NNNNNN.json` so the bundle on disk is the bundle the derivation reads.
 *
 * The identity control below proves the rebuild is faithful: run this with a
 * doctor that changes nothing and the **shipped offline CLI** verifies the
 * result end to end, `exit 0` / `valid`.
 *
 * What is deliberately not rebound: `selection-request/v2`, its own signed
 * selection chain, the preregistration verification receipt and the signer
 * inventory also name the preregistration hash. They belong to verifier stages
 * this entry point does not traverse, and re-deriving the selection chain to
 * reach a rule two stages earlier would measure the rebuild rather than the
 * rule. The mode-flipped bundle is therefore coherent through every path
 * `deriveEnvironmentSemantics` follows, and is not offered to the full CLI.
 */
function rebuildAroundPreregistration(
  run: EnvironmentRun,
  honestLifecycle: readonly LabLifecycleEventV1[],
  doctor: (preregistration: Json) => Json,
): RebuiltRun {
  const keyring = developmentKeyring();
  const dir = ownedTempDir("erl2-d031-env-");
  cpSync(run.runRoot, dir, { recursive: true });
  const retained = path.join(dir, "retained");

  const rechain = (events: readonly Event[]): Event[] => {
    const out: Event[] = [];
    let prior: string | undefined;
    for (const event of events) {
      const next = { ...event };
      if (prior === undefined) delete next.prior_event_hash;
      else next.prior_event_hash = prior;
      const { core_hash: _drop, ...body } = next;
      const sealed = { ...body, core_hash: coreHash(body) } as Event;
      out.push(sealed);
      prior = sealed.core_hash;
    }
    return out;
  };
  const remapProduced = (events: readonly Event[], role: string, hash: string): Event[] =>
    events.map((event) =>
      event.produced.some((p) => p.artifact_role === role)
        ? ({
            ...event,
            produced: event.produced.map((p) =>
              p.artifact_role === role ? { ...p, artifact_core_hash: hash } : p,
            ),
          } as Event)
        : event,
    );

  // 1. the doctored preregistration, re-signed by the preregistrar itself
  const preregistrationPath = path.join(retained, "acquisition-preregistration.json");
  const preregistrationHash = resealSignedAt(
    preregistrationPath,
    doctor(readJson(preregistrationPath)),
    keyring.preregistrar,
  );

  // 2. the event that published it lies before the signed freeze point, so
  //    re-pointing it moves the freeze head. Settle the chain once to find the
  //    head, exactly as the pre-environment cascade does and for the same reason.
  const settled = rechain(
    remapProduced(honestLifecycle as unknown as Event[], "acquisition-preregistration", preregistrationHash),
  );
  const at = settled.findIndex((event) => event.produced.some((p) => p.artifact_role === "run-record"));
  const freezeHead = (settled[at - 1] as Event).core_hash;

  // 3. the run record rebinds to both the preregistration and the new head
  const recordPath = path.join(retained, "run-record.json");
  const recordHash = resealAt(recordPath, {
    ...readJson(recordPath),
    acquisition_preregistration_hash: preregistrationHash,
    lifecycle_head_hash: freezeHead,
  });

  // 4. the terminal attestation is re-signed over the new record
  const attestationPath = path.join(retained, "final-attestation.json");
  const attestationHash = resealSignedAt(
    attestationPath,
    { ...readJson(attestationPath), run_record_hash: recordHash },
    keyring.finalizer,
  );

  const republished = rechain(
    remapProduced(remapProduced(settled, "run-record", recordHash), "final-attestation", attestationHash),
  );
  assert.equal(
    (republished[at - 1] as Event).core_hash,
    freezeHead,
    "republishing the terminal must not move the signed freeze head",
  );

  // 5. the retained bundle re-points at the re-signed attestation
  const attestationBytes = readFileSync(attestationPath);
  const bundlePath = path.join(retained, "public-bundle.json");
  const bundle = readJson(bundlePath);
  const member = bundle["final_attestation"] as Json;
  const artifact = member["artifact"] as Json;
  const { core_hash: _bundleHash, ...bundleRest } = bundle;
  const bundleBody: Json = {
    ...bundleRest,
    final_attestation: {
      ...member,
      artifact: {
        ...artifact,
        byte_length: statSync(attestationPath).size,
        file_sha256: hashBytes(attestationBytes),
      },
      artifact_core_hash: attestationHash,
    },
  };
  writeJson(bundlePath, { ...bundleBody, core_hash: coreHash(bundleBody) });
  refreshFrozen(bundlePath);

  // 6. the events on disk, so the index and any CLI reading this tree see the
  //    same chain the derivation is handed rather than the pre-cascade one.
  const bySequence = new Map(republished.map((event) => [event.sequence, event]));
  const eventsDir = path.join(dir, "events");
  for (const name of readdirSync(eventsDir).sort()) {
    if (!name.endsWith(".json") || name.endsWith(".frozen")) continue;
    const file = path.join(eventsDir, name);
    const replacement = bySequence.get((readJson(file) as unknown as Event).sequence);
    if (replacement === undefined) continue;
    writeJson(file, replacement);
    refreshFrozen(file);
  }

  return { dir, lifecycle: republished as unknown as LabLifecycleEventV1[], preregistrationHash };
}

/** The real public environment entry point, over a rebuilt run. */
function environmentRefusal(rebuilt: RebuiltRun, runId: string): string | undefined {
  try {
    const report = deriveEnvironmentSemantics({
      index: ArtifactIndex.scan(rebuilt.dir),
      lifecycle: rebuilt.lifecycle,
      runId,
    });
    assert.equal(report.validity.status, "valid", "an accepted rebuild must derive the honest verdict");
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function environmentMessage(rebuilt: RebuiltRun, runId: string): string {
  try {
    deriveEnvironmentSemantics({
      index: ArtifactIndex.scan(rebuilt.dir),
      lifecycle: rebuilt.lifecycle,
      runId,
    });
    return "";
  } catch (error) {
    return (error as { message?: string }).message ?? "";
  }
}

test("RLD031-E2: the environment call site derives the required set from the signed preregistration", () => {
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");
  const honestLifecycle = JSON.parse(
    readFileSync(writeLifecycle(run.runRoot), "utf8"),
  ) as LabLifecycleEventV1[];

  // -- the catalogue, pinned independently ---------------------------------
  //
  // Asserted against the shipped catalogue rather than derived from it, so a
  // catalogue change that widens or narrows what an environment terminal owes
  // has to be made here too, deliberately.
  assert.deepEqual(
    sorted(verifierRequiredGateIds("environment", "development_fake_port")),
    sorted(EXPECTED_ENVIRONMENT_REQUIRED),
    "the environment required set must be the gates this file names",
  );
  assert.deepEqual(
    sorted(verifierRequiredGateIds("environment", "external_adapter")),
    sorted([...EXPECTED_ENVIRONMENT_REQUIRED, EXTERNAL_ADAPTER_ONLY_GATE]),
    "an external-adapter environment run must additionally owe adapter-certified",
  );

  // -- the identity control -------------------------------------------------
  //
  // The same rebuild, with a doctor that changes nothing. It must land on a
  // bundle the *shipped offline CLI* accepts end to end -- not merely one the
  // entry point tolerates. Without this every refusal below could be the
  // rebuild failing rather than the rule refusing.
  const control = rebuildAroundPreregistration(run, honestLifecycle, (prereg) => prereg);
  const controlCli = verifyBundle(control.dir, {
    sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
  });
  assert.equal(controlCli.exitCode, 0, JSON.stringify(controlCli.body.errors));
  assert.equal(
    (controlCli.body.data as { verdict: string }).verdict,
    "valid",
    "the identity rebuild must reproduce a bundle the shipped verifier calls valid",
  );
  assert.equal(
    environmentRefusal(control, run.runId),
    undefined,
    "the honest signed preregistration must be accepted by the entry point",
  );

  // The honest run really is a fake-port run, and really does not carry the
  // adapter gate. Both halves matter: the case below is only a case because the
  // mode-specific gate is genuinely absent from these retained bytes.
  const honestPrereg = readJson(
    path.join(control.dir, "retained", "acquisition-preregistration.json"),
  );
  assert.equal(honestPrereg["subject_execution_mode"], "development_fake_port");
  const retainedGates = gatesOf(
    readJson(path.join(control.dir, "retained", "validity-result.json")),
  ).map((gate) => gate.gate_id);
  assert.equal(
    retainedGates.includes(EXTERNAL_ADAPTER_ONLY_GATE),
    false,
    "a fake-port run must retain no adapter-certified gate",
  );

  // -- the case: one signed field, flipped ----------------------------------
  //
  // Fully re-signed by the preregistrar, rebound through the lifecycle, the run
  // record and the attestation. The retained gate set is byte-identical to the
  // control's. The only difference in the whole bundle is the mode the
  // preregistrar signed.
  const adapter = rebuildAroundPreregistration(run, honestLifecycle, (prereg) => ({
    ...prereg,
    subject_execution_mode: "external_adapter",
  }));
  assert.equal(
    readJson(path.join(adapter.dir, "retained", "acquisition-preregistration.json"))[
      "subject_execution_mode"
    ],
    "external_adapter",
  );
  assert.notEqual(
    adapter.preregistrationHash,
    control.preregistrationHash,
    "flipping a signed field must move the preregistration's own hash",
  );
  assert.deepEqual(
    gatesOf(readJson(path.join(adapter.dir, "retained", "validity-result.json"))),
    gatesOf(readJson(path.join(control.dir, "retained", "validity-result.json"))),
    "the two rebuilds must present the identical retained gate set",
  );

  // The whole point. The same gate set that is complete under the signed
  // fake-port mode is incomplete under the signed external-adapter mode, and the
  // entry point must say so -- naming the gate the signed mode obliged.
  assert.equal(
    environmentRefusal(adapter, run.runId),
    "GRAPH_CLOSURE_MISSING_ROLE",
    "an external-adapter environment terminal that retains no adapter-certified gate must be refused",
  );
  assert.match(
    environmentMessage(adapter, run.runId),
    /omits required gate\(s\): adapter-certified/,
    "the refusal must name the gate the signed mode required",
  );

  // -- the authority source must be present, intact and signed --------------
  //
  // Absent: the mandatory closure role is gone, so there is no signed mode to
  // read and the terminal is refused as the closure defect it is.
  assert.equal(
    environmentRefusal(
      {
        ...control,
        lifecycle: control.lifecycle.map((event) => ({
          ...event,
          produced: event.produced.filter(
            (produced) => produced.artifact_role !== "acquisition-preregistration",
          ),
        })) as unknown as LabLifecycleEventV1[],
      },
      run.runId,
    ),
    "GRAPH_CLOSURE_MISSING_ROLE",
    "a terminal retaining no preregistration cannot be told which gates it owed",
  );

  // Malformed, left unbound: the bytes no longer produce the hash the lifecycle
  // names, and the index refuses before any semantic rule reads a mode.
  {
    const tampered = rebuildAroundPreregistration(run, honestLifecycle, (prereg) => prereg);
    const file = path.join(tampered.dir, "retained", "acquisition-preregistration.json");
    writeJson(file, { ...readJson(file), subject_execution_mode: "not-a-mode" });
    refreshFrozen(file);
    assert.equal(
      environmentRefusal(tampered, run.runId),
      "ARTIFACT_HASH_MISMATCH",
      "a doctored preregistration that was not rebound must be refused as tampered bytes",
    );
  }

  // Malformed, fully rebound: the hash resolves, so the defect is no longer an
  // integrity one -- and closure admission, the boundary that owns it, refuses a
  // preregistration that satisfies none of its declared contracts. A mode the
  // contract does not define never reaches the required-set rule to be read as
  // "not external_adapter".
  for (const malformed of [
    (prereg: Json): Json => ({ ...prereg, subject_execution_mode: "not-a-mode" }),
    (prereg: Json): Json => {
      const { subject_execution_mode: _absent, ...rest } = prereg;
      return rest;
    },
  ]) {
    const rebuilt = rebuildAroundPreregistration(run, honestLifecycle, malformed);
    assert.throws(
      () => ArtifactIndex.scan(rebuilt.dir).admit(rebuilt.preregistrationHash as never),
      (error: { code?: string }) => error.code === "GRAPH_CLOSURE_RETAINED_CONTRACT_INVALID",
      "a preregistration whose mode the contract does not define must not be admitted as evidence",
    );
  }

  // Unsigned: stripping the signature leaves the core hash untouched -- it is
  // computed over the body -- so the mode still resolves and the entry point
  // still reads it. The refusal has to come from the stage that owns signatures,
  // and it does: the shipped offline CLI refuses the bundle outright.
  {
    const unsigned = rebuildAroundPreregistration(run, honestLifecycle, (prereg) => prereg);
    const file = path.join(unsigned.dir, "retained", "acquisition-preregistration.json");
    const { signature: _stripped, ...bare } = readJson(file);
    writeJson(file, bare);
    refreshFrozen(file);
    assert.equal(
      readJson(file)["core_hash"],
      unsigned.preregistrationHash,
      "stripping a signature must not move the core hash; that is why this case needs the CLI",
    );
    const cli = verifyBundle(unsigned.dir, {
      sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
    });
    assert.notEqual(cli.exitCode, 0, "an unsigned preregistration must not verify");
    assert.equal(
      (cli.body.errors as { code: string }[])[0]?.code,
      "GRAPH_CLOSURE_RETAINED_CONTRACT_INVALID",
      "an unsigned preregistration is not a preregistration this verifier will read",
    );
  }
});
