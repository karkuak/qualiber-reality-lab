/**
 * ADAPTER-CERT / DEP-GRAPH: adapter packages are removable.
 *
 * The Slice 5 exit gate requires that *removing or disabling all adapter
 * packages leaves core, integrity, contracts and verifier green*. Proving that
 * by deleting directories from the live workspace would be unsafe and would
 * race the other test files, so this test builds a throwaway module tree that
 * contains the core packages and **no adapter package at all**, then runs the
 * core surface inside it in a fresh process.
 *
 * If core had grown a dependency on an adapter — an import, a resolved path, a
 * lazily required module — the child process would fail to resolve it.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Packages that make up core. No adapter or pack package is among them. */
const CORE_PACKAGES = [
  "contracts",
  "integrity",
  "core",
  "adapter-sdk",
  "evaluation-sdk",
  "public-verifier",
  "cli",
] as const;

const ADAPTER_PACKAGE_NAMES = [
  "adapter-reference-correct",
  "adapter-reference-limited",
  "adapter-reference-misleading",
  "adapter-reference-inconclusive",
  "adapter-reference-otel-demo",
  "pack-operations",
] as const;

function buildAdapterFreeTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-no-adapters-"));
  const modules = path.join(root, "node_modules");
  mkdirSync(path.join(modules, "@erl2"), { recursive: true });

  // Third-party dependencies are linked as they are; none of them is an
  // adapter and none imports `@erl2/*`, so their realpath back into the repo
  // cannot reach an adapter.
  for (const name of readdirSync(path.join(repoRoot, "node_modules"))) {
    if (name === "@erl2") continue;
    symlinkSync(path.join(repoRoot, "node_modules", name), path.join(modules, name));
  }
  // The core packages are *copied*, not symlinked.  A symlink would resolve to
  // its realpath in `<repo>/packages/<name>`, and from there Node would walk up
  // to `<repo>/node_modules/@erl2` — where all four adapters are linked — so a
  // core→adapter import would still resolve and the test would prove nothing
  // (review P2-9).  Copying confines every `@erl2/*` resolution to this tree,
  // which contains NO adapter package under any name, so a core dependency on an
  // adapter fails to resolve here.
  for (const name of CORE_PACKAGES) {
    cpSync(path.join(repoRoot, "packages", name), path.join(modules, "@erl2", name), {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`) && !src.endsWith(".tsbuildinfo"),
    });
  }
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "erl2-core-only", private: true, type: "module" }, null, 2)}\n`,
  );
  return root;
}

const PROBE = `
import { compileAll, CONTRACTS } from "@erl2/contracts";
import { registeredDomains, coreHash } from "@erl2/integrity";
import { LAB_STATES, TRANSITIONS, certifyAdapter, AdapterHost } from "@erl2/core";
import { verifyInvalidRecord, verifyPublicBundle } from "@erl2/public-verifier";
import { runCommand } from "@erl2/cli";

compileAll();
const doctor = runCommand(["doctor", "--profile", "local-developer"]);
const help = runCommand(["help"]);
const verify = runCommand(["verify", "--public-bundle", "x", "--root-config", "y", "--artifact-root", "z", "--lifecycle", "w"]);

console.log(JSON.stringify({
  contracts: CONTRACTS.length,
  states: LAB_STATES.length,
  domains: registeredDomains().length,
  transitions: Object.keys(TRANSITIONS).length,
  hash: coreHash({ probe: true }),
  doctor_ok: doctor.ok,
  help_ok: help.ok,
  verify_refused: verify.errors[0]?.code,
  certify_is_function: typeof certifyAdapter === "function",
  host_is_constructor: typeof AdapterHost === "function",
  verifier_present: typeof verifyPublicBundle === "function" && typeof verifyInvalidRecord === "function",
}));
`;

test("ADAPTER-CERT: core, integrity, contracts and the verifier work with no adapter package present", () => {
  const root = buildAdapterFreeTree();
  for (const name of ADAPTER_PACKAGE_NAMES) {
    assert.equal(
      existsSync(path.join(root, "node_modules", "@erl2", name)),
      false,
      `${name} must be absent from the adapter-free tree`,
    );
  }
  assert.equal(existsSync(path.join(root, "adapters")), false);
  assert.equal(existsSync(path.join(root, "packs")), false);

  const probePath = path.join(root, "probe.mjs");
  writeFileSync(probePath, PROBE);
  const result = spawnSync(process.execPath, [probePath], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `core did not run without adapters:\n${result.stderr}`);

  const observed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  assert.ok((observed["contracts"] as number) > 100, "every contract must still compile");
  assert.ok((observed["states"] as number) > 50, "the lifecycle must still be complete");
  assert.equal(observed["doctor_ok"], true);
  assert.equal(observed["help_ok"], true);
  // The verifier still refuses correctly rather than merely loading.
  assert.equal(observed["verify_refused"], "VERIFY_OFFLINE_REQUIRED");
  assert.equal(observed["certify_is_function"], true, "the certification harness is core-owned");
  assert.equal(observed["host_is_constructor"], true, "the adapter host is core-owned");
  assert.equal(observed["verifier_present"], true);
});

test("ADAPTER-CERT: the isolated tree genuinely cannot resolve an adapter (negative control)", () => {
  // Proves the tree is really adapter-free: a module that imports an adapter
  // MUST fail to resolve here.  Under the previous symlink tree this would have
  // *succeeded* (realpath walked back into the repo's node_modules where the
  // adapters are linked), so the isolation was fake (review P2-9).
  const root = buildAdapterFreeTree();
  const probePath = path.join(root, "imports-an-adapter.mjs");
  writeFileSync(probePath, `import "@erl2/adapter-reference-correct";\nconsole.log("resolved");\n`);
  const result = spawnSync(process.execPath, [probePath], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0, "an adapter import must NOT resolve in the adapter-free tree");
  assert.match(
    result.stderr,
    /ERR_MODULE_NOT_FOUND|Cannot find package/,
    `expected a module-resolution failure, got:\n${result.stderr}`,
  );
});

test("ADAPTER-CERT: the same core artifacts hash identically with and without adapters", () => {
  // A digest that changed when adapters were removed would mean core had read
  // them. It does not: this is the same computation in both trees.
  const root = buildAdapterFreeTree();
  const probePath = path.join(root, "digest.mjs");
  writeFileSync(
    probePath,
    `import { coreHash } from "@erl2/integrity";
     import { CONTRACTS } from "@erl2/contracts";
     import { LAB_STATES } from "@erl2/core";
     console.log(coreHash({ contracts: CONTRACTS.map((c) => c.id).sort(), states: [...LAB_STATES] }));`,
  );
  const isolated = spawnSync(process.execPath, [probePath], { cwd: root, encoding: "utf8" });
  assert.equal(isolated.status, 0, isolated.stderr);

  // The comparison run resolves through the real workspace, where the adapter
  // packages *are* present and linked.
  const localPath = path.join(repoRoot, "node_modules", ".erl2-removability-digest.mjs");
  cpSync(probePath, localPath);
  const local = spawnSync(process.execPath, [localPath], { cwd: repoRoot, encoding: "utf8" });
  rmSync(localPath, { force: true });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(isolated.stdout.trim(), local.stdout.trim());
});
