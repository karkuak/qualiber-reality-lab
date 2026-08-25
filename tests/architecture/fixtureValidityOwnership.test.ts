/**
 * FIXTURE-VALIDITY: every committed validity result is a set the verifier would
 * require (RL-D-031).
 *
 * ## Why this exists
 *
 * The `valid-pre-environment-run` golden carried two gate rows for its entire
 * life, and one of them — `acquisition-controls-passed` — was an identifier no
 * Lab catalogue has ever defined. Nothing noticed, because the offline verifier
 * derived its verdict from whatever rows it found and the fixture writer was the
 * only thing that decided what those rows were.
 *
 * That is the shape this file refuses to let return. A fixture is not a
 * convenience: it is the artifact every adversarial case is built on top of, so
 * a fixture whose gate set is quietly short makes every case built on it a
 * weaker test than it reads as. Worse, once the verifier requires completeness,
 * a short fixture is a bundle the shipped verifier would refuse — and a
 * repository that ships one is claiming a terminal it does not have.
 *
 * ## What it checks, and why against the bytes
 *
 * The committed files, not the writer. A writer that generates the right set
 * today can be replaced by a hand-listed one tomorrow, and the hand-listed one
 * looks perfectly reasonable in review. Scanning the shipped bytes is the check
 * that survives that.
 *
 * The applicability input is read from each fixture's own retained, signed
 * preregistration — the same artifact the verifier reads — so a fixture that
 * legitimately preregisters an external adapter is held to the wider set rather
 * than being excused from it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAB_VALIDITY_GATES } from "@erl2/core";
import { verifierRequiredGateIds } from "@erl2/public-verifier";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const ALL_LAB_GATE_IDS = new Set(Object.values(LAB_VALIDITY_GATES).flat() as readonly string[]);

const BRANCH_OF: Readonly<Record<string, "pre_environment" | "environment">> = {
  "pre-environment-validity-result/v1": "pre_environment",
  "environment-validity-result/v1": "environment",
};

interface Found {
  readonly file: string;
  readonly value: Record<string, unknown>;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const child = path.join(dir, name);
    if (statSync(child).isDirectory()) out.push(...walk(child));
    else if (name.endsWith(".json")) out.push(child);
  }
  return out;
}

/** Every committed validity result, wherever it lives beneath `fixtures/`. */
function committedValidityResults(): Found[] {
  const out: Found[] = [];
  for (const file of walk(path.join(repoRoot, "fixtures"))) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (typeof record["schema_version"] !== "string") continue;
    if (BRANCH_OF[record["schema_version"] as string] === undefined) continue;
    out.push({ file, value: record });
  }
  return out;
}

/**
 * The execution mode the fixture's own signed preregistration declares.
 *
 * Resolved by walking up from the validity result to the run's `retained`
 * directory, which is how every fixture in this repository is laid out. A
 * fixture with no preregistration is a defect in its own right — the role is
 * mandatory on both branches — so this refuses rather than defaulting.
 */
function declaredExecutionMode(file: string): "development_fake_port" | "external_adapter" {
  const retained = path.dirname(file);
  const candidate = path.join(retained, "acquisition-preregistration.json");
  const value = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
  assert.equal(
    value["schema_version"],
    "acquisition-preregistration/v1",
    `${candidate} is not a preregistration`,
  );
  const mode = value["subject_execution_mode"];
  assert.ok(
    mode === "development_fake_port" || mode === "external_adapter",
    `${candidate} declares no usable subject_execution_mode`,
  );
  return mode;
}

test("FIXTURE-VALIDITY: there are committed validity results to check", () => {
  // A scanner that silently found nothing would pass forever. This is the guard
  // that makes every assertion below load-bearing.
  assert.ok(
    committedValidityResults().length > 0,
    "the scan must find the committed validity results, or it is proving nothing",
  );
});

test("FIXTURE-VALIDITY: every committed gate row is a Lab-owned gate of its own branch", () => {
  for (const { file, value } of committedValidityResults()) {
    const relative = path.relative(repoRoot, file);
    const branch = BRANCH_OF[value["schema_version"] as string] as "pre_environment" | "environment";
    const rows = value["gate_results"] as { gate_id: string }[];
    assert.ok(Array.isArray(rows), `${relative} has no gate_results array`);
    for (const row of rows) {
      assert.ok(
        ALL_LAB_GATE_IDS.has(row.gate_id),
        `${relative} evaluates ${row.gate_id}, which no Lab catalogue defines`,
      );
    }
    // The branch check is the catalogue's own: a gate this branch cannot
    // meaningfully evaluate must not appear at all.
    const allowed = new Set(verifierRequiredGateIds(branch, "external_adapter"));
    for (const governed of ["subject-exercise-succeeded", "attributable-telemetry-retained"]) {
      if (branch === "environment") allowed.add(governed);
    }
    for (const row of rows) {
      assert.ok(
        allowed.has(row.gate_id),
        `${relative} is a ${branch} terminal and evaluates ${row.gate_id}, which is not one of its gates`,
      );
    }
  }
});

test("FIXTURE-VALIDITY: no committed validity result evaluates a gate twice", () => {
  for (const { file, value } of committedValidityResults()) {
    const relative = path.relative(repoRoot, file);
    const ids = (value["gate_results"] as { gate_id: string }[]).map((r) => r.gate_id);
    assert.equal(new Set(ids).size, ids.length, `${relative} evaluates a gate more than once`);
  }
});

test("FIXTURE-VALIDITY: every committed validity result carries the set its run owed", () => {
  // The check the shipped verifier now makes, made here against the bytes as
  // committed — so a short fixture fails in this repository rather than in
  // somebody else's verification.
  for (const { file, value } of committedValidityResults()) {
    const relative = path.relative(repoRoot, file);
    const branch = BRANCH_OF[value["schema_version"] as string] as "pre_environment" | "environment";
    const present = new Set((value["gate_results"] as { gate_id: string }[]).map((r) => r.gate_id));
    const missing = verifierRequiredGateIds(branch, declaredExecutionMode(file)).filter(
      (id: string) => !present.has(id),
    );
    assert.deepEqual(
      missing,
      [],
      `${relative} omits required gate(s): ${missing.join(", ")}`,
    );
  }
});

test("FIXTURE-VALIDITY: the direct fixture writer builds its gate set from the catalogue", () => {
  // The drift guard. Generating the rows from `requiredGateIds` is what makes a
  // catalogue addition a loud failure at fixture-generation time instead of a
  // quietly short fixture; a hand-listed array would restore the original defect
  // one catalogue revision later, and would look entirely reasonable in review.
  const writer = readFileSync(path.join(repoRoot, "tests", "support", "fakeRun.ts"), "utf8");
  assert.match(
    writer,
    /requiredGateIds\(PRE_ENVIRONMENT_GATE_IDS/,
    "fakeRun.ts must generate its pre-environment gate rows from the shipped catalogue",
  );
  // Comments stripped first: the writer has to *name* the off-catalogue
  // identifier to explain why it is gone, and a scanner that could not tell
  // prose from code would flag the explanation instead of a regression.
  const writerCode = writer
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.match(writerCode, /gate_results:/, "the comment stripper must not have eaten the writer");
  assert.ok(
    !writerCode.includes("acquisition-controls-passed"),
    "the off-catalogue identifier this test exists for must not return",
  );
});
