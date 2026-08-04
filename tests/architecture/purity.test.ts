/**
 * CORE-PURITY and the dependency-boundary graph (ERL2-AC-001, plan §4.1).
 *
 * The scan inspects package manifests, the workspace lockfile, TypeScript
 * sources, compiled bundles, generated types, schemas, CLI help output and
 * error codes.  A seeded forbidden fixture proves the scanner is sensitive.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACTS } from "@erl2/contracts";
import { runCommand } from "@erl2/cli";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Named subjects core must never know about. */
const FORBIDDEN_SUBJECT_TOKENS = ["qualiber", "trailhead", "telemetrytest", "scenario-lab"];

/** Allowed dependency direction (implementation plan §4.1). */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "@erl2/contracts": [],
  "@erl2/integrity": ["@erl2/contracts"],
  "@erl2/core": ["@erl2/contracts", "@erl2/integrity"],
  "@erl2/adapter-sdk": ["@erl2/contracts"],
  "@erl2/evaluation-sdk": ["@erl2/contracts"],
  "@erl2/public-verifier": ["@erl2/contracts", "@erl2/integrity", "@erl2/core"],
  "@erl2/cli": ["@erl2/contracts", "@erl2/integrity", "@erl2/core", "@erl2/public-verifier"],
  "@erl2/adapter-reference-correct": ["@erl2/contracts", "@erl2/adapter-sdk"],
  "@erl2/adapter-reference-limited": ["@erl2/contracts", "@erl2/adapter-sdk"],
  "@erl2/adapter-reference-misleading": ["@erl2/contracts", "@erl2/adapter-sdk"],
  "@erl2/adapter-reference-inconclusive": ["@erl2/contracts", "@erl2/adapter-sdk"],
  "@erl2/adapter-reference-otel-demo": ["@erl2/contracts", "@erl2/adapter-sdk"],
  "@erl2/pack-operations": ["@erl2/contracts", "@erl2/evaluation-sdk"],
};

const PACKAGE_DIRS = [
  "packages/contracts",
  "packages/integrity",
  "packages/core",
  "packages/adapter-sdk",
  "packages/evaluation-sdk",
  "packages/public-verifier",
  "packages/cli",
  "adapters/reference-correct",
  "adapters/reference-limited",
  "adapters/reference-misleading",
  "adapters/reference-inconclusive",
  "adapters/reference-otel-demo",
  "packs/operations",
];

/** Packages whose bytes must never name a subject. */
const CORE_DIRS = [
  "packages/contracts",
  "packages/integrity",
  "packages/core",
  "packages/adapter-sdk",
  "packages/evaluation-sdk",
  "packages/public-verifier",
  "packages/cli",
];

function walkFiles(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const child = path.join(dir, name);
    const st = statSync(child);
    if (st.isDirectory()) out.push(...walkFiles(child, extensions));
    else if (extensions.some((e) => name.endsWith(e))) out.push(child);
  }
  return out;
}

/**
 * Every `@erl2/<pkg>` an import in `text` names, across *all* import forms the
 * language offers — the previous scanner matched only double-quoted static
 * `from "@erl2/…"` and so would miss a regression that reached an adapter by a
 * side-effect import, a dynamic `import()`, `require`, `createRequire`, a path
 * alias, or a single-quoted specifier (review P2-9).
 */
// Every mechanism that pulls in a module — static `from`/side-effect `import`,
// dynamic `import()`, `require`, a `createRequire(...)` result (however it is
// aliased), or a path alias — names the target with a quoted string specifier.
// Matching the specifier itself is therefore form-agnostic and catches all of
// them, unlike the previous `from "…"`-only regex (review P2-9).
const ERL2_SPECIFIER = /['"](@erl2\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g;

function importedErl2Packages(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(ERL2_SPECIFIER)) found.add(match[1] as string);
  return found;
}

function namedSubjectTokens(text: string): string[] {
  const lower = text.toLowerCase();
  return FORBIDDEN_SUBJECT_TOKENS.filter((t) => lower.includes(t));
}

test("DEP-GRAPH: every package manifest declares only its allowed dependencies", () => {
  for (const dir of PACKAGE_DIRS) {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, dir, "package.json"), "utf8"),
    ) as { name: string; dependencies?: Record<string, string> };
    const allowed = ALLOWED[manifest.name];
    assert.ok(allowed, `unknown workspace package ${manifest.name}`);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!dependency.startsWith("@erl2/")) continue;
      assert.ok(
        allowed.includes(dependency),
        `${manifest.name} may not depend on ${dependency}`,
      );
    }
  }
});

test("DEP-GRAPH: no core source imports an adapter, pack or consumer integration", () => {
  for (const dir of CORE_DIRS) {
    for (const file of walkFiles(path.join(repoRoot, dir, "src"), [".ts"])) {
      const text = readFileSync(file, "utf8");
      const manifestName = JSON.parse(
        readFileSync(path.join(repoRoot, dir, "package.json"), "utf8"),
      ).name as string;
      const allowed = ALLOWED[manifestName] ?? [];
      for (const target of importedErl2Packages(text)) {
        assert.ok(
          allowed.includes(target),
          `${path.relative(repoRoot, file)} imports ${target}, which the dependency direction forbids`,
        );
      }
      assert.ok(
        !/from\s+"(\.\.\/){2,}(adapters|packs)\//.test(text),
        `${path.relative(repoRoot, file)} reaches into adapters or packs by relative path`,
      );
    }
  }
});

test("CORE-PURITY: no core source, schema, generated type or bundle names a subject", () => {
  const scanned: string[] = [];
  for (const dir of CORE_DIRS) {
    scanned.push(
      ...walkFiles(path.join(repoRoot, dir, "src"), [".ts"]),
      ...walkFiles(path.join(repoRoot, dir, "schemas"), [".json"]),
      ...walkFiles(path.join(repoRoot, dir, "generated"), [".ts"]),
      ...walkFiles(path.join(repoRoot, dir, "dist"), [".js"]),
    );
    const manifestPath = path.join(repoRoot, dir, "package.json");
    if (existsSync(manifestPath)) scanned.push(manifestPath);
  }
  assert.ok(scanned.length > 0, "purity scan found no files to scan");
  for (const file of scanned) {
    const text = readFileSync(file, "utf8").toLowerCase();
    for (const token of FORBIDDEN_SUBJECT_TOKENS) {
      assert.ok(
        !text.includes(token),
        `${path.relative(repoRoot, file)} names the subject token "${token}"`,
      );
    }
  }
});

test("CORE-PURITY: the import scanner catches every import form, not just static double-quoted from", () => {
  // Each of these reaches an adapter by a form the previous scanner missed; the
  // scanner must flag all of them (review P2-9).
  const forbiddenForms = [
    `import { x } from "@erl2/adapter-reference-correct";`, // static, double
    `import { x } from '@erl2/adapter-reference-limited';`, // static, single
    `import "@erl2/adapter-reference-misleading";`, // side-effect
    `const m = await import('@erl2/adapter-reference-inconclusive');`, // dynamic
    `const r = require("@erl2/adapter-reference-correct");`, // require
    `import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nconst a = req('@erl2/adapter-reference-limited');`, // createRequire
    `import { deep } from "@erl2/adapter-reference-correct/deep";`, // subpath
  ];
  for (const form of forbiddenForms) {
    const found = importedErl2Packages(form);
    assert.ok(found.size > 0, `the scanner missed an adapter import form:\n${form}`);
    assert.ok(
      [...found].some((p) => p.startsWith("@erl2/adapter-reference")),
      `the scanner did not resolve the adapter package in:\n${form}`,
    );
  }
  // A permitted import is not a false positive.
  assert.deepEqual([...importedErl2Packages(`import { coreHash } from "@erl2/integrity";`)], ["@erl2/integrity"]);
});

test("CORE-PURITY: the seeded-fixture check exercises the real scanner over a file on disk", () => {
  // Plant a core-shaped file that both imports an adapter (single-quoted
  // side-effect — a form the old regex missed) and names a subject, then run the
  // *actual* file scanner over it, proving the scan (not just an in-memory
  // string) is sensitive.
  const dir = mkdtempSync(path.join(tmpdir(), "erl2-purity-seed-"));
  try {
    const seededSrc = path.join(dir, "src");
    const nested = path.join(seededSrc, "nested");
    const file = path.join(nested, "leak.ts");
    writeFileSync(path.join(dir, "package.json"), "{}");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      file,
      `import '@erl2/adapter-reference-correct';\nconst branch = subjectId === "Qualiber" ? deep : generic;\n`,
    );

    const scanned = walkFiles(seededSrc, [".ts"]);
    assert.ok(scanned.includes(file), "the file walker must find the seeded file");

    const text = readFileSync(file, "utf8");
    assert.ok(importedErl2Packages(text).has("@erl2/adapter-reference-correct"), "adapter import undetected");
    assert.deepEqual(namedSubjectTokens(text), ["qualiber"], "named subject undetected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CORE-PURITY: no contract identifier or schema version names a subject", () => {
  for (const contract of CONTRACTS) {
    const text = `${contract.id} ${contract.name} ${contract.ref} ${contract.schemaVersion ?? ""}`.toLowerCase();
    for (const token of FORBIDDEN_SUBJECT_TOKENS) {
      assert.ok(!text.includes(token), `contract ${contract.id} names "${token}"`);
    }
  }
});

test("CORE-PURITY: CLI help and doctor output name no subject and no product exit code", () => {
  const help = runCommand(["help"]);
  const doctor = runCommand(["doctor", "--profile", "local-developer"]);
  for (const result of [help, doctor]) {
    const text = JSON.stringify(result).toLowerCase();
    for (const token of FORBIDDEN_SUBJECT_TOKENS) {
      assert.ok(!text.includes(token), `CLI output names "${token}"`);
    }
    assert.equal(result.authority_scope, "lab_orchestration_only");
  }
});

test("CORE-PURITY: the lockfile records no named-subject dependency", () => {
  const lockPath = path.join(repoRoot, "package-lock.json");
  if (!existsSync(lockPath)) return;
  const text = readFileSync(lockPath, "utf8").toLowerCase();
  for (const token of FORBIDDEN_SUBJECT_TOKENS) {
    assert.ok(!text.includes(token), `the lockfile names "${token}"`);
  }
});
