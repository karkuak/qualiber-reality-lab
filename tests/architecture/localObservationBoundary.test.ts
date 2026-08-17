import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const coordinatorPath = path.join(
  repoRoot,
  "packages",
  "core",
  "src",
  "observation",
  "localObservation.ts",
);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const child = path.join(dir, name);
    if (statSync(child).isDirectory()) out.push(...files(child));
    else out.push(child);
  }
  return out;
}

test("LOCAL-ARCH: the coordinator delegates execution exclusively to AdapterHost", () => {
  const source = readFileSync(coordinatorPath, "utf8");
  assert.match(source, /import \{ AdapterHost/);
  assert.match(source, /host\.run\(/);
  for (const forbidden of [
    "node:child_process", "spawn(", "spawnSync(", "exec(", "execFile(", "sandboxLauncher",
    "containerSupervisor", "ArtifactStore", "MutationLedger", "freezeAdapterOutput", "freezeDiagnostics",
    "RunWorkspace", "EnvironmentRun", "finalize", "evaluation/", "selection/", "judge",
  ]) {
    assert.equal(source.includes(forbidden), false, `coordinator directly contains ${forbidden}`);
  }
});

test("LOCAL-ARCH: exactly one production module drives the adapter, and no second engine/store/supervisor exists", () => {
  // The property is that local observation has one execution engine, not that
  // its directory holds one file. Ancestry derivation and offline verification
  // are pure readers; pinning the filename list made adding either look like
  // adding an engine, while a real second engine called `localObservation2.ts`
  // would have had to be noticed by hand. So the check now asks which modules
  // actually reach AdapterHost, and requires the rest to hold no process,
  // store or supervisor authority whatever they are named.
  const observationFiles = files(path.join(repoRoot, "packages", "core", "src", "observation"))
    .filter((file) => file.endsWith(".ts"));
  const drivers = observationFiles.filter((file) => {
    const source = readFileSync(file, "utf8");
    return /import \{ AdapterHost/.test(source) || source.includes("host.run(");
  });
  assert.deepEqual(drivers.map((file) => path.relative(repoRoot, file)), [
    "packages/core/src/observation/localObservation.ts",
  ]);
  for (const file of observationFiles.filter((candidate) => !drivers.includes(candidate))) {
    const source = readFileSync(file, "utf8");
    for (const forbidden of [
      "node:child_process", "spawn(", "spawnSync(", "exec(", "execFile(", "sandboxLauncher",
      "containerSupervisor", "ArtifactStore", "MutationLedger", "RunWorkspace", "EnvironmentRun",
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${path.relative(repoRoot, file)} directly contains ${forbidden}`,
      );
    }
  }
  const production = [
    ...files(path.join(repoRoot, "packages", "core", "src")),
    ...files(path.join(repoRoot, "packages", "adapter-sdk", "src")),
  ].filter((file) => file.endsWith(".ts"));
  const localModules = production.filter((file) => /localObservation|LocalObservation/.test(path.basename(file)));
  assert.deepEqual(localModules.map((file) => path.relative(repoRoot, file)), [
    "packages/core/src/observation/localObservation.ts",
  ]);
});

test("LOCAL-ARCH: no product token, converter, local governed role or trusted-status vocabulary entered the implementation", () => {
  const scoped = [
    coordinatorPath,
    path.join(repoRoot, "packages", "core", "src", "observation", "ancestry.ts"),
    path.join(repoRoot, "packages", "core", "src", "observation", "trustedLocalVerifier.ts"),
    path.join(repoRoot, "packages", "core", "src", "adapter", "trustedLocal.ts"),
    path.join(repoRoot, "packages", "core", "src", "adapter", "trustedLocalRegistry.ts"),
    path.join(repoRoot, "packages", "contracts", "schemas", "observation.schema.json"),
    path.join(repoRoot, "fixtures", "neutral", "local-archive-observer.mjs"),
    path.join(repoRoot, "fixtures", "neutral", "local-bundle-observer.mjs"),
  ];
  const text = scoped.map((file) => readFileSync(file, "utf8").toLowerCase()).join("\n");
  for (const token of ["qualiber", "r5", "analytics", "quotes", "telemetry", "converter", "convertlocal", "tier-upgrade"] ) {
    assert.equal(text.includes(token), false, `local implementation names ${token}`);
  }
  for (const forbiddenStatus of [
    '"scored"', '"qualified"', '"approved"', '"certified"', '"finalized"',
  ]) {
    assert.equal(
      readFileSync(path.join(repoRoot, "packages", "contracts", "schemas", "observation.schema.json"), "utf8")
        .includes(forbiddenStatus),
      false,
      `local machine status contains ${forbiddenStatus}`,
    );
  }
});

test("LOCAL-ARCH: governed V1 composition does not import local-observation coordination", () => {
  for (const dir of ["run", "journey", "evaluation", "terminal"]) {
    for (const file of files(path.join(repoRoot, "packages", "core", "src", dir)).filter((item) => item.endsWith(".ts"))) {
      const source = readFileSync(file, "utf8");
      assert.equal(source.includes("observation/localObservation"), false, path.relative(repoRoot, file));
      assert.equal(source.includes("LocalObservationCoordinator"), false, path.relative(repoRoot, file));
    }
  }
});
