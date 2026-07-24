/**
 * DEP-GRAPH / DEEP-ANCESTRY: the evaluation and deep-plane boundaries.
 *
 * Two structural claims are proven here by inspecting the shipped bytes rather
 * than by review:
 *
 * 1. the data-only pack surface has no reachable capability — no pack package
 *    imports a filesystem, network, process, clock or randomness API, and the
 *    pack contract has no member that could carry one;
 * 2. no generic or base contract references the optional deep plane, so a
 *    Slice 8 `DeepResultV1` can only ever be a descendant.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACTS, schemaBundlePaths } from "@erl2/contracts";
import { DEEP_ANCESTRY_FORBIDDEN_FIELDS } from "@erl2/core";
import {
  FORBIDDEN_INPUT_CONTRACT_IDS,
  KNOWN_PREDICATES,
  PROHIBITED_CORE_APIS,
  RESERVED_GENERIC_METRIC_IDS,
} from "@erl2/evaluation-sdk";
import { GENERIC_METRIC_DEFINITIONS } from "@erl2/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function walk(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const child = path.join(dir, name);
    if (statSync(child).isDirectory()) out.push(...walk(child, extension));
    else if (name.endsWith(extension)) out.push(child);
  }
  return out;
}

test("PACK-RUNTIME: no pack package imports a filesystem, network, process, clock or randomness API", () => {
  const sources = [
    ...walk(path.join(repoRoot, "packs"), ".ts"),
    ...walk(path.join(repoRoot, "packages", "evaluation-sdk", "src"), ".ts"),
  ];
  assert.ok(sources.length > 0, "there are pack sources to scan");
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    const relative = path.relative(repoRoot, file);
    for (const forbidden of [
      "node:fs",
      "node:net",
      "node:http",
      "node:child_process",
      "node:crypto",
      "node:worker_threads",
      "node:vm",
    ]) {
      assert.ok(
        !new RegExp(`from\\s+"${forbidden}"`).test(text),
        `${relative} imports ${forbidden}`,
      );
    }
    // Ambient nondeterminism is what makes a pack unreproducible. Actual
    // *access* is what matters: the SDK's prohibited-API list contains these
    // names as data, and a scanner that could not tell a declaration from a
    // call would flag its own denylist.
    for (const call of ["Date.now(", "Math.random(", "process.env.", "process.env[", "globalThis.fetch"]) {
      assert.ok(!text.includes(call), `${relative} calls ${call}`);
    }
  }
});

test("PACK-CONTRACT: the pack contract has no member that could carry code or authority", () => {
  const bundle = JSON.parse(
    readFileSync(
      schemaBundlePaths().find((p) => p.endsWith("evaluation.schema.json")) as string,
      "utf8",
    ),
  ) as { $defs: Record<string, unknown> };
  const body = bundle.$defs["EvaluationPackBodyV1"] as {
    additionalProperties: boolean;
    properties: Record<string, unknown>;
  };
  assert.equal(body.additionalProperties, false, "the pack body is a closed object");

  const memberNames = Object.keys(body.properties);
  for (const suspicious of [
    "code",
    "script",
    "module",
    "expression",
    "handler",
    "run",
    "exec",
    "path",
    "url",
    "endpoint",
    "seed",
    "clock",
    "validity",
    "status",
    "thresholds",
  ]) {
    assert.ok(
      !memberNames.includes(suspicious),
      `the pack body must not have a "${suspicious}" member`,
    );
  }
  // Every predicate a pack may select is one the Lab implements.
  const predicates = (bundle.$defs["EvaluationPredicateId"] as { enum: string[] }).enum;
  assert.deepEqual(
    [...predicates].sort(),
    [...KNOWN_PREDICATES].sort(),
    "the SDK's mirrored vocabulary must equal the schema's closed enum",
  );
});

test("PACK-AUTHORITY: the reserved generic metric ids are all Lab-defined", () => {
  const defined = new Set(GENERIC_METRIC_DEFINITIONS.map((m) => m.metric_id));
  for (const reserved of RESERVED_GENERIC_METRIC_IDS) {
    assert.ok(defined.has(reserved), `reserved metric ${reserved} has no Lab-owned definition`);
  }
  // Nothing a pack could read grants it sight of the verdict or the answer.
  const ids = new Set(CONTRACTS.map((c) => c.id));
  for (const forbidden of FORBIDDEN_INPUT_CONTRACT_IDS) {
    assert.ok(ids.has(forbidden), `${forbidden} must be a real contract for the ban to mean anything`);
  }
  assert.ok(PROHIBITED_CORE_APIS.length > 10, "the prohibited-API list is not empty");
});

test("DEEP-ANCESTRY: no generic or base contract schema references the deep plane", () => {
  // The only contracts allowed to name the deep plane are the deep descendant
  // itself and its supplement/bundle, which Slice 8 owns.
  const DEEP_OWNED = new Set([
    "DeepResultV1",
    "DeepEvaluationCommitmentV1",
    "DeepSupplementAttestationV1",
    "DeepVerificationBundleV1",
  ]);
  for (const bundlePath of schemaBundlePaths()) {
    const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as {
      $defs: Record<string, { properties?: Record<string, unknown> }>;
    };
    for (const [name, definition] of Object.entries(bundle.$defs)) {
      if (DEEP_OWNED.has(name)) continue;
      for (const member of Object.keys(definition.properties ?? {})) {
        assert.ok(
          !DEEP_ANCESTRY_FORBIDDEN_FIELDS.includes(member),
          `${name} declares the deep-plane member ${member}; a generic or base contract may not reference the deep plane`,
        );
        assert.ok(
          !member.startsWith("deep_"),
          `${name} declares ${member}; deep-plane members belong to the descendant`,
        );
      }
    }
  }
});

test("DEEP-ANCESTRY: the generic evaluation index and base attestations have no deep member", () => {
  const bundle = JSON.parse(
    readFileSync(
      schemaBundlePaths().find((p) => p.endsWith("results.schema.json")) as string,
      "utf8",
    ),
  ) as { $defs: Record<string, { required: string[]; properties: Record<string, unknown> }> };
  const index = bundle.$defs["GenericEvaluationIndexV1"] as {
    required: string[];
    properties: Record<string, unknown>;
  };
  assert.deepEqual(
    Object.keys(index.properties).sort(),
    [
      "core_hash",
      "domain_result_hash",
      "generic_run_policy_hash",
      "journey_result_hash",
      "precleanup_result_join_hash",
      "evaluator_version",
      "run_id",
      "schema_version",
      "validity_result_hash",
    ].sort(),
    "the generic index binds exactly the four planes, the policy and the join — nothing else",
  );
});

test("CORE-PURITY: the evaluation surface names no subject and no product scalar score", () => {
  const sources = [
    ...walk(path.join(repoRoot, "packages", "core", "src", "evaluation"), ".ts"),
    ...walk(path.join(repoRoot, "packages", "evaluation-sdk", "src"), ".ts"),
    ...walk(path.join(repoRoot, "packs"), ".ts"),
  ];
  for (const file of sources) {
    const text = readFileSync(file, "utf8").toLowerCase();
    const relative = path.relative(repoRoot, file);
    for (const token of ["qualiber", "trailhead", "telemetrytest", "scenario-lab"]) {
      assert.ok(!text.includes(token), `${relative} names the subject token "${token}"`);
    }
    // A single combined score across planes is exactly what design v2 §17
    // forbids; there is no identifier for one because there is no such value.
    for (const scalar of ["overallscore", "totalscore", "leaderboard", "compositescore"]) {
      assert.ok(!text.replaceAll("_", "").includes(scalar), `${relative} defines ${scalar}`);
    }
  }
});
