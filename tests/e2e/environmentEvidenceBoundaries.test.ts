/**
 * The producer evidence boundaries, on the shipped path (Step 6B).
 *
 * The independent review's producer cluster was not "these scans are missing".
 * It was sharper and worse: the scans existed, they ran, and what they inspected
 * was not what crossed the boundary. A `mounted_file` scan read entry metadata
 * that structurally cannot contain the mounted content; a `lab_telemetry` scan
 * ran on a live path with nothing proving the path reached it; the subject-output
 * surface had no secret or identifier rule at all; and the declared output
 * ceiling was hashed into every request and never compared with anything.
 *
 * Every case here therefore does the same three things:
 *
 *   1. plant the leak where a *real* run could carry it — in admitted governor
 *      data, or in the subject's own bytes — never by hand-assembling an artifact;
 *   2. satisfy every earlier guard, so the refusal is attributable to the rule
 *      under test and not to something in front of it;
 *   3. assert the refusal names that rule, that the leaking bytes were never
 *      written, and that the refusal did not republish the token.
 *
 * Each is driven through the shipped `erl2` binary in separate OS processes.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { erl2, writeLifecycle, writeTrustConfig } from "../support/cliRun.js";
import {
  changed,
  drive,
  environmentPlan,
  manifest,
  phaseIndex,
  producedRoles,
  selectedRun,
  type EnvironmentRun,
} from "../support/environmentCli.js";

/** The declared subject-output ceiling every run freezes into its execution plan. */
const DECLARED_OUTPUT_BYTES = 64 * 1024 * 1024;

const JUDGE_CANARY = `erl2-canary-${"a1b2c3d4".repeat(4)}`;
const TELEMETRY_CANARY = `erl2-canary-${"b2c3d4e5".repeat(4)}`;
const SECRET_CANARY = `erl2-secret-${"c3d4e5f6".repeat(4)}`;
const FORBIDDEN_IDENTIFIER = "BEGIN RSA PRIVATE KEY";

interface Refusal {
  readonly exitCode: number;
  readonly code: string;
  readonly message: string;
  /** The whole CLI envelope, so a leak anywhere in it is visible. */
  readonly envelope: string;
}

function refusalOf(result: { exitCode: number; body: unknown }): Refusal {
  const body = result.body as { errors?: { code?: string; message?: string }[] };
  return {
    exitCode: result.exitCode,
    code: body.errors?.[0]?.code ?? "-",
    message: body.errors?.[0]?.message ?? "",
    envelope: JSON.stringify(result.body),
  };
}

/** Runs one named phase with extra arguments appended. */
function runPhaseWith(run: EnvironmentRun, command: string, extra: readonly string[]): Refusal {
  const entry = environmentPlan(run).find(([name]) => name === command);
  assert.ok(entry !== undefined, `no environment phase named ${command}`);
  return refusalOf(erl2([...entry[1], ...extra]));
}

/** Files beneath a run-root subtree, or `[]` when the subtree does not exist. */
function treeFiles(runRoot: string, relative: string): readonly string[] {
  try {
    return readdirSync(path.join(runRoot, relative), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Every retained file whose bytes carry `token`, as run-root-relative paths.
 *
 * This is the assertion that matters, and it is deliberately stated as an exact
 * set rather than as "nothing anywhere". A run cannot un-admit its own governor
 * input: where the leak enters through admitted data the Lab retains, naming the
 * one file that legitimately holds it is honest, and requiring that set to be
 * *exactly* that file is what proves nothing else picked it up.
 */
function filesContaining(runRoot: string, token: string): readonly string[] {
  const needle = Buffer.from(token, "utf8");
  const out: string[] = [];
  const walk = (dir: string, relative: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(absolute, child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (readFileSync(absolute).includes(needle)) out.push(child);
    }
  };
  walk(runRoot, "");
  return out.sort();
}

/**
 * The exact bytes the production ceiling check will count: every `output_refs`
 * occurrence of every frozen step outcome, measured from the file on disk.
 *
 * Derived the way the producer derives it, from the retained outcomes rather
 * than from a manifest, so a test that computes a target size is computing the
 * same number the run will.
 */
function retainedPayloadBytes(runRoot: string): number {
  const dir = path.join(runRoot, "retained", "step-outcomes");
  let total = 0;
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith(".frozen")) continue;
    const outcome = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as {
      output_refs?: { path: string }[];
    };
    for (const ref of outcome.output_refs ?? []) {
      total += statSync(path.join(runRoot, ref.path)).size;
    }
  }
  return total;
}

// -- 7.1 mounted-file bytes --------------------------------------------------

test("EB-MOUNT: a canary in the mounted file's bytes refuses before the adapter is dispatched", () => {
  // The metadata is clean by construction and stays clean: the step's commitment
  // carries `visible_step_hash`, and the adapter request carries an `ArtifactRef`
  // — a path, a length and a digest. The canary lives only in the *content* of
  // the file the Lab publishes into the adapter-visible tree, which is exactly the
  // shape the old `JSON.stringify(entry)` scan could never see.
  const run = selectedRun({ environmentActorRole: JUDGE_CANARY });
  drive(run, phaseIndex(run, "install"));

  const before = manifest(run.runRoot);
  const refused = runPhaseWith(run, "install", []);

  assert.notEqual(refused.exitCode, 0, "a canary in mounted bytes must refuse");
  assert.equal(refused.code, "JOURNEY_ORACLE_CANARY_LEAKED");
  assert.ok(
    refused.message.includes("mounted_file"),
    `the mounted-file rule must be what refuses, not something in front of it: ${refused.message}`,
  );
  assert.deepEqual(
    filesContaining(run.runRoot, JUDGE_CANARY),
    [],
    "the leaking mount must never reach the run's retained tree at all",
  );
  assert.deepEqual(
    changed(before, manifest(run.runRoot)),
    [],
    "a pre-dispatch refusal writes no evidence at all",
  );
  assert.ok(
    !refused.envelope.includes(JUDGE_CANARY),
    "the refusal must not republish the canary it refused",
  );
});

test("EB-MOUNT: the run cannot step past a refused mount by retrying it", () => {
  // Replay is the obvious way around a scan that only runs once. The scan is
  // recomputed from the same admitted bytes on every attempt, so it cannot be.
  const run = selectedRun({ environmentActorRole: JUDGE_CANARY });
  drive(run, phaseIndex(run, "install"));
  assert.equal(runPhaseWith(run, "install", []).code, "JOURNEY_ORACLE_CANARY_LEAKED");
  const second = runPhaseWith(run, "install", []);
  assert.equal(second.code, "JOURNEY_ORACLE_CANARY_LEAKED", "a retry re-decides, it does not skip");
  assert.deepEqual(filesContaining(run.runRoot, JUDGE_CANARY), []);
});

test("EB-MOUNT: a clean run publishes its mounts and the canonical entries are real files", () => {
  // The positive control. Without it, "no mount was written" would be satisfied
  // just as well by a path that never publishes a mount at all.
  const run = selectedRun();
  drive(run, phaseIndex(run, "execute-subject:exercise"));
  assert.ok(
    treeFiles(run.runRoot, "subject-visible/steps").length > 0,
    "a clean run really does publish subject-visible steps",
  );
  assert.ok(
    treeFiles(run.runRoot, "subject-visible/canonical").length > 0,
    "a clean run really does publish canonical evidence entries",
  );
});

// -- 7.2 lab telemetry -------------------------------------------------------

test("EB-TELEMETRY: a canary in the telemetry bytes refuses before the telemetry is retained", () => {
  // The canary enters through an admitted archetype evidence source, which is
  // the only production route into a `SourceSnapshotV1`: every other field is
  // derived. Provisioning and the baseline succeed with it, so the run reaches
  // `observe` with every earlier guard satisfied.
  const run = selectedRun({ extraEvidenceSourceId: TELEMETRY_CANARY });
  drive(run, phaseIndex(run, "observe"));

  const before = manifest(run.runRoot);
  const refused = runPhaseWith(run, "observe", []);

  assert.notEqual(refused.exitCode, 0, "a canary in Lab telemetry must refuse");
  assert.equal(refused.code, "JOURNEY_ORACLE_CANARY_LEAKED");
  assert.ok(
    refused.message.includes("lab_telemetry"),
    `the lab_telemetry rule must be what refuses: ${refused.message}`,
  );
  assert.deepEqual(
    treeFiles(run.runRoot, "retained/observation"),
    [],
    "no source snapshot may be retained once its bytes are known to leak",
  );
  assert.deepEqual(
    treeFiles(run.runRoot, "subject-visible/canonical"),
    [],
    "and the leak never reaches the adapter-visible tree either",
  );
  // Exactly two files legitimately carry it, and both are records of *admitted
  // input*: the mirrored archetype, which declared the source, and the baseline
  // fingerprint, which cannot omit a source it was told to expect. A run does not
  // get to un-admit its own governor data. What it does get to do is refuse to
  // derive anything further from it — and requiring this set to be exactly these
  // two is what proves nothing further was derived.
  assert.deepEqual(
    filesContaining(run.runRoot, TELEMETRY_CANARY),
    ["retained/environment/archetype.json", "retained/environment/baseline.json"],
    "the admitted archetype and baseline are the only retained carriers",
  );
  assert.deepEqual(changed(before, manifest(run.runRoot)), [], "the refusal writes no evidence");
  assert.ok(!refused.envelope.includes(TELEMETRY_CANARY), "the refusal must not republish the canary");
  assert.ok(
    !producedRoles(run).includes("source-snapshot"),
    "and no lifecycle event may claim a snapshot the run refused to freeze",
  );
});

test("EB-TELEMETRY: a refused capture cannot be stepped past by retrying observe", () => {
  const run = selectedRun({ extraEvidenceSourceId: TELEMETRY_CANARY });
  drive(run, phaseIndex(run, "observe"));
  assert.equal(runPhaseWith(run, "observe", []).code, "JOURNEY_ORACLE_CANARY_LEAKED");
  assert.equal(runPhaseWith(run, "observe", []).code, "JOURNEY_ORACLE_CANARY_LEAKED");
  assert.deepEqual(treeFiles(run.runRoot, "retained/observation"), []);
});

test("EB-TELEMETRY: the run still reaches exactly one invalid terminal that verifies offline", () => {
  // A refusal is not a terminal. What matters is that the run it leaves behind is
  // still closable through the ordinary route, once, and that the record an
  // offline reader gets verifies.
  const run = selectedRun({ extraEvidenceSourceId: TELEMETRY_CANARY });
  drive(run, phaseIndex(run, "observe"));
  assert.equal(runPhaseWith(run, "observe", []).code, "JOURNEY_ORACLE_CANARY_LEAKED");

  const cancelled = erl2(["cancel", ...run.base, "--reason", "OPERATOR_STOP"]);
  assert.notEqual(cancelled.exitCode, 0, "a cancelled run exits on the cancellation class");
  assert.equal(
    producedRoles(run).filter((role) => role === "invalid-run-record").length,
    1,
    "exactly one invalid record",
  );

  const verified = erl2([
    "verify-record",
    "--record", path.join(run.runRoot, "retained", "invalid-run-record.json"),
    "--lifecycle", writeLifecycle(run.runRoot),
    "--artifact-root", run.runRoot,
    "--root-config", writeTrustConfig(run.runRoot),
    "--offline",
  ]);
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  assert.ok(
    !JSON.stringify(verified.body).includes(TELEMETRY_CANARY),
    "the offline verification output must not republish the canary either",
  );
});

// -- 7.3 subject-output content ----------------------------------------------

test("EB-OUTPUT: a secret canary in the subject's output bytes refuses before the freeze", () => {
  const run = selectedRun();
  for (const [name, argv] of environmentPlan(run).slice(0, phaseIndex(run, "freeze-output"))) {
    const result = erl2([...argv, "--fake-leak-canary", SECRET_CANARY]);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
  }

  const before = manifest(run.runRoot);
  const refused = refusalOf(erl2(["freeze-output", ...run.base]));
  assert.notEqual(refused.exitCode, 0);
  assert.equal(refused.code, "SECRET_CANARY_IN_SUBJECT_OUTPUT");
  assert.deepEqual(changed(before, manifest(run.runRoot)), [], "the refusal freezes no subject output");
  assert.ok(
    !producedRoles(run).includes("subject-output-manifest"),
    "and no lifecycle event claims a manifest",
  );
  assert.ok(!refused.envelope.includes(SECRET_CANARY), "the refusal must not republish the secret");
});

test("EB-OUTPUT: a forbidden identifier in the subject's output bytes refuses before the freeze", () => {
  const run = selectedRun();
  for (const [name, argv] of environmentPlan(run).slice(0, phaseIndex(run, "freeze-output"))) {
    const result = erl2([...argv, "--fake-leak-canary", FORBIDDEN_IDENTIFIER]);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
  }

  const before = manifest(run.runRoot);
  const refused = refusalOf(erl2(["freeze-output", ...run.base]));
  assert.notEqual(refused.exitCode, 0);
  assert.equal(refused.code, "SECRET_PLAINTEXT_IN_CONTRACT");
  assert.deepEqual(changed(before, manifest(run.runRoot)), []);
  assert.ok(!refused.envelope.includes(FORBIDDEN_IDENTIFIER));
});

test("EB-OUTPUT: a judge canary still refuses under its own rule, not the new one", () => {
  // The ordering anchor for ADR-ERL2-032 §5. If the new content scan ever grew a
  // judge-canary branch, this case would start refusing under a *different* code
  // — and the control that proves the `subject_output_prefill` scan is
  // load-bearing would quietly stop measuring anything.
  const run = selectedRun();
  for (const [name, argv] of environmentPlan(run).slice(0, phaseIndex(run, "freeze-output"))) {
    const result = erl2([...argv, "--fake-leak-canary", JUDGE_CANARY]);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
  }
  const refused = refusalOf(erl2(["freeze-output", ...run.base]));
  assert.equal(refused.code, "JOURNEY_ORACLE_CANARY_LEAKED");
  assert.ok(refused.message.includes("subject_output_prefill"), refused.message);
});

test("EB-OUTPUT: clean binary output freezes and the run finalizes", () => {
  // Binary in every position that is not the intent's own prefix: a scan that
  // decoded before matching would have to mangle this, and a size check that
  // counted characters would measure it wrong. Both admit it, and the run closes.
  const run = selectedRun();
  for (const [name, argv] of environmentPlan(run).slice(0, phaseIndex(run, "freeze-output"))) {
    const result = erl2([...argv, "--fake-output-bytes", "4096"]);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
  }
  const frozen = erl2(["freeze-output", ...run.base]);
  assert.equal(frozen.exitCode, 0, JSON.stringify(frozen.body.errors));
  assert.equal(drive(run, Number.POSITIVE_INFINITY, phaseIndex(run, "reveal")), "generic_finalized");
});

// -- 7.4 the declared output ceiling -----------------------------------------

test("EB-SIZE: one byte over the declared ceiling refuses before the manifest freezes", () => {
  // The ceiling is the run's own `SubjectExecutionPlanV1.limits.output_bytes` —
  // the value hashed into every step request's `resource_limit_hash`. The last
  // journey step is given exactly the padding that carries the run's real total
  // one byte past it, computed from the payloads already on disk.
  const run = selectedRun();
  drive(run, phaseIndex(run, "remove"));
  const used = retainedPayloadBytes(run.runRoot);
  assert.ok(used < DECLARED_OUTPUT_BYTES, "the fixture must start below the ceiling");

  const last = runPhaseWith(run, "remove", [
    "--fake-output-bytes",
    String(DECLARED_OUTPUT_BYTES - used + 1),
  ]);
  assert.equal(last.exitCode, 0, `remove: ${last.message}`);
  assert.equal(
    retainedPayloadBytes(run.runRoot),
    DECLARED_OUTPUT_BYTES + 1,
    "the run really is one byte over",
  );

  const before = manifest(run.runRoot);
  const refused = refusalOf(erl2(["freeze-output", ...run.base]));
  assert.notEqual(refused.exitCode, 0, "one byte over the declared ceiling must refuse");
  assert.equal(refused.code, "SUBJECT_OUTPUT_LIMIT_EXCEEDED");
  assert.match(refused.message, /67108865 bytes against a declared ceiling of 67108864/);
  assert.deepEqual(changed(before, manifest(run.runRoot)), [], "the refusal freezes no subject output");
  assert.ok(
    !producedRoles(run).includes("subject-output-manifest"),
    "and no lifecycle event claims a manifest",
  );
  // Replaying it cannot get past the bound either.
  assert.equal(refusalOf(erl2(["freeze-output", ...run.base])).code, "SUBJECT_OUTPUT_LIMIT_EXCEEDED");
});

test("EB-SIZE: exactly at the declared ceiling is admitted", () => {
  // The other half, and the one that says the bound is a bound rather than a
  // rejection of anything large. Same fixture, one byte less.
  const run = selectedRun();
  drive(run, phaseIndex(run, "remove"));
  const used = retainedPayloadBytes(run.runRoot);

  const last = runPhaseWith(run, "remove", [
    "--fake-output-bytes",
    String(DECLARED_OUTPUT_BYTES - used),
  ]);
  assert.equal(last.exitCode, 0, `remove: ${last.message}`);
  assert.equal(retainedPayloadBytes(run.runRoot), DECLARED_OUTPUT_BYTES, "exactly at the ceiling");

  const frozen = erl2(["freeze-output", ...run.base]);
  assert.equal(frozen.exitCode, 0, JSON.stringify(frozen.body.errors));
  assert.ok(
    producedRoles(run).includes("subject-output-manifest"),
    "a payload exactly at the ceiling freezes its manifest",
  );
});
