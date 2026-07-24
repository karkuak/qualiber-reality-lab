/**
 * DEP-GRAPH / ADAPTER-CERT: the adapter SDK's authority boundary.
 *
 * The SDK is what an untrusted adapter author imports. Its *export list* is
 * therefore a security surface: adding a `revealTruth` or a `spawn` would hand
 * the adapter plane an authority core owns. These tests read the real module
 * and the real source, so the boundary cannot drift with a comment left behind.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "@erl2/adapter-sdk";
import { FORBIDDEN_SDK_IMPORTS, FORBIDDEN_SDK_SURFACE } from "@erl2/adapter-sdk";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const child = path.join(dir, name);
    if (statSync(child).isDirectory()) out.push(...sourceFiles(child));
    else if (name.endsWith(".ts")) out.push(child);
  }
  return out;
}

test("ADAPTER-CERT: the SDK exports no Lab, judge or evaluator authority", () => {
  const exported = Object.keys(sdk);
  assert.ok(exported.length > 0, "the SDK must export something");
  for (const forbidden of FORBIDDEN_SDK_SURFACE) {
    const hit = exported.find((name) => name.toLowerCase() === forbidden.toLowerCase());
    assert.equal(hit, undefined, `the SDK exports the forbidden symbol ${String(hit)}`);
  }
  // And nothing whose name merely *suggests* one of those authorities.
  for (const name of exported) {
    const lower = name.toLowerCase();
    for (const marker of ["truth", "judge", "validity", "attest", "finaliz", "threshold", "selectchallenge"]) {
      assert.ok(!lower.includes(marker), `the SDK exports ${name}, which names ${marker}`);
    }
  }
});

test("ADAPTER-CERT: the SDK imports no process, network or evaluation module", () => {
  for (const file of sourceFiles(path.join(repoRoot, "packages", "adapter-sdk", "src"))) {
    const text = readFileSync(file, "utf8");
    for (const forbidden of FORBIDDEN_SDK_IMPORTS) {
      assert.ok(
        !new RegExp(`from\\s+"${forbidden}"`).test(text),
        `${path.relative(repoRoot, file)} imports ${forbidden}`,
      );
    }
    for (const match of text.matchAll(/from\s+"(@erl2\/[^"]+)"/g)) {
      assert.equal(
        match[1],
        "@erl2/contracts",
        `${path.relative(repoRoot, file)} imports ${String(match[1])}; the SDK may depend on contracts only`,
      );
    }
  }
});

test("DEP-GRAPH: the adapter host lives in core and core imports no adapter package", () => {
  const hostDir = path.join(repoRoot, "packages", "core", "src", "adapter");
  assert.ok(existsSync(hostDir), "the host must be core-owned");
  for (const file of sourceFiles(hostDir)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/from\s+"(@erl2\/[^"]+)"/g)) {
      assert.ok(
        match[1] === "@erl2/contracts" || match[1] === "@erl2/integrity",
        `${path.relative(repoRoot, file)} imports ${String(match[1])}`,
      );
    }
    assert.ok(
      !/adapters\/reference|reference-correct|reference-limited/.test(text),
      `${path.relative(repoRoot, file)} names a reference adapter`,
    );
  }
});

test("ADAPTER-CERT: reference adapters use only the public SDK and contracts", () => {
  for (const id of ["reference-correct", "reference-limited"]) {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "adapters", id, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const dependencies = Object.keys(manifest.dependencies ?? {}).filter((d) =>
      d.startsWith("@erl2/"),
    );
    assert.deepEqual(
      dependencies.sort(),
      ["@erl2/adapter-sdk", "@erl2/contracts"],
      `${id} depends on something beyond the public adapter surface`,
    );
    for (const file of sourceFiles(path.join(repoRoot, "adapters", id, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+"(@erl2\/[^"]+)"/g)) {
        assert.ok(
          match[1] === "@erl2/adapter-sdk" || match[1] === "@erl2/contracts",
          `${path.relative(repoRoot, file)} imports ${String(match[1])}`,
        );
      }
      // A reference adapter is a subject, not a privileged helper.
      assert.ok(
        !/node:child_process|node:net|node:http/.test(text),
        `${path.relative(repoRoot, file)} reaches for a process or network module`,
      );
    }
  }
});

test("ADAPTER-CERT: the sabotage fixtures are outside the workspace package graph", () => {
  // They must never become a dependency of anything: they exist to be run, not
  // linked, and a workspace entry would let them ship.
  const root = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    workspaces: string[];
  };
  for (const workspace of root.workspaces) {
    assert.ok(!workspace.startsWith("fixtures/"), `fixtures are declared as a workspace: ${workspace}`);
  }
  const fixtures = readdirSync(path.join(repoRoot, "fixtures", "sabotage", "adapters"));
  assert.ok(fixtures.length >= 20, "the sabotage matrix should be substantial");
  for (const fixture of fixtures) {
    if (fixture.startsWith("_")) continue;
    const text = readFileSync(path.join(repoRoot, "fixtures", "sabotage", "adapters", fixture), "utf8");
    assert.ok(
      !text.includes("@erl2/adapter-sdk"),
      `${fixture} uses the SDK; a hostile adapter must speak the raw protocol`,
    );
  }
});

test("CORE-PURITY: no adapter contract, capability or control names a subject", () => {
  const tokens = ["qualiber", "trailhead", "telemetrytest", "scenario-lab"];
  const schema = readFileSync(
    path.join(repoRoot, "packages", "contracts", "schemas", "adapter.schema.json"),
    "utf8",
  ).toLowerCase();
  for (const token of tokens) {
    assert.ok(!schema.includes(token), `the adapter schema names ${token}`);
  }
  // "reference-correct" and "reference-limited" are reference *subjects*; core
  // must not know them either.
  for (const token of ["reference-correct", "reference-limited"]) {
    assert.ok(!schema.includes(token), `the adapter schema names the reference subject ${token}`);
  }
});
