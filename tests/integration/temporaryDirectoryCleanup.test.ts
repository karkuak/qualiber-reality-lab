/**
 * Temporary-directory ownership and cleanup (review R-08).
 *
 * ## What was leaking
 *
 * `grep -rn "rmSync\|after(\|afterEach" tests/support/*.ts` returned nothing.
 * Every `mkdtempSync` in the support layer was created and abandoned, and two of
 * them were not test-only at all: `certification.ts` builds a workspace and an
 * artifact store per host, up to eight hosts per certification, on the
 * production adapter path. Over one machine's history that came to well over
 * 190,000 `$TMPDIR/erl2-*` directories.
 *
 * ## How this file measures it
 *
 * Residue, not implementation. Each case runs the real thing in a child process
 * with `TMPDIR` pointed at a directory this file created, then lists what is
 * left. A cleanup that merely *looks* right — a hook registered on the wrong
 * object, an `rmSync` that never fires on the refusal path — leaves the same
 * residue as no cleanup at all, and only the listing tells them apart.
 *
 * The child process matters: the deterministic removal point is the end of the
 * owning *test file's* process, which cannot be observed from inside that same
 * process.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ownedRunRoot,
  ownedTempDir,
  ownedTempDirCount,
  releaseTempDir,
  runRootCompanions,
} from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A `$TMPDIR` this file owns, so residue from anything else cannot be mistaken for ours. */
function isolatedTmp(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `erl2-cleanup-probe-${label}-`));
}

/** Everything left directly inside an isolated `$TMPDIR`. */
function residue(root: string): readonly string[] {
  return readdirSync(root).sort();
}

/**
 * Run a driver script in a child process whose `TMPDIR` is `tmp`.
 *
 * `NODE_TEST_CONTEXT` is removed because a nested `node --test` that sees it
 * declines to run any files, and one of the drivers below is a test run.
 */
function runChild(source: string, tmp: string, args: readonly string[] = []): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
  delete env["NODE_TEST_CONTEXT"];
  const run = spawnSync(process.execPath, [...args, "--input-type=module", "-e", source], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 120_000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

// -- the ownership helper itself ---------------------------------------------

test("TMP-OWN: a directory obtained here is tracked, and releasing it removes it now", () => {
  const before = ownedTempDirCount();
  const dir = ownedTempDir("erl2-own-probe-");
  writeFileSync(path.join(dir, "payload.txt"), "x");
  assert.equal(ownedTempDirCount(), before + 1);
  assert.equal(readdirSync(dir).length, 1);

  releaseTempDir(dir);
  assert.equal(ownedTempDirCount(), before, "a released directory is no longer owned");
  assert.throws(() => readdirSync(dir), "a released directory is gone from disk");

  // Releasing something this module never handed out is a no-op, not a throw and
  // not a removal of somebody else's directory.
  const foreign = mkdtempSync(path.join(tmpdir(), "erl2-foreign-probe-"));
  releaseTempDir(foreign);
  assert.equal(ownedTempDirCount(), before);
  rmSync(foreign, { recursive: true, force: true });
});

test("TMP-OWN: one process installs one listener, not one per directory", () => {
  // The failure mode the obvious fix produces: a per-directory `process.on`
  // trades a directory leak for a listener leak and starts warning a few hundred
  // fixtures in.
  const before = process.listenerCount("exit");
  for (let i = 0; i < 40; i += 1) releaseTempDir(ownedTempDir("erl2-listener-probe-"));
  assert.equal(process.listenerCount("exit"), before, "40 directories must not add 40 listeners");
  assert.ok(before <= 2, `the module installs at most one exit listener; saw ${String(before)}`);
});

// -- the test-support layer --------------------------------------------------

test("TMP-SUPPORT: a test file using the support fixtures leaves no directory behind", () => {
  // The end-to-end proof for the five support paths named in R-08, through the
  // `process.on("exit")` fallback — this driver is not a test-runner child. It
  // builds a governor registry (`erl2-registry-`, `erl2-vault-`), an adapter host
  // fixture (`erl2-adapter-ws-`, `erl2-adapter-store-`), a selection fixture
  // (`erl2-selection-`) and a fake run workspace (`erl2-fake-*`), then ends
  // normally. Nothing may survive the process.
  const tmp = isolatedTmp("support");
  try {
    const driver = [
      `const { buildGovernorRegistry } = await import(${JSON.stringify(path.join(repoRoot, "tests", "dist", "support", "governorRegistry.js"))});`,
      `const { newHost, REFERENCE_CORRECT_MANIFEST, referenceAdapterEntry } = await import(${JSON.stringify(path.join(repoRoot, "tests", "dist", "support", "adapterFixtures.js"))});`,
      `const { buildSelectionFixture } = await import(${JSON.stringify(path.join(repoRoot, "tests", "dist", "support", "selectionFixture.js"))});`,
      "const registry = buildGovernorRegistry();",
      "const host = newHost(REFERENCE_CORRECT_MANIFEST(), referenceAdapterEntry('reference-correct'));",
      "buildSelectionFixture();",
      "console.log(JSON.stringify({ registry: registry.root, workspace: host.workspaceRoot }));",
    ].join("\n");
    const child = runChild(driver, tmp);
    assert.equal(child.status, 0, child.out);
    const created = JSON.parse(child.out.trim().split("\n").pop() as string) as Record<string, string>;
    // The driver really did create directories inside the isolated root, so an
    // empty listing below means "removed", not "never made".
    for (const dir of Object.values(created)) {
      assert.ok(dir.startsWith(tmp) || dir.startsWith(`/private${tmp}`), `${dir} must live in the isolated TMPDIR`);
    }
    assert.deepEqual(residue(tmp), [], `support fixtures left ${residue(tmp).join(", ")}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("TMP-SUPPORT: a real `node --test` file cleans up through the deterministic hook", () => {
  // The two mechanisms are covered separately, and this is the deterministic
  // one. The plain driver above runs with no `NODE_TEST_CONTEXT`, so it reaches
  // removal through the `exit` fallback; this case is a real `node --test` run,
  // where the root `after` hook is installed and fires once the file's cases are
  // finished. Both must end with nothing in the isolated `$TMPDIR`.
  const tmp = isolatedTmp("after-hook");
  const suiteDir = mkdtempSync(path.join(tmpdir(), "erl2-cleanup-suite-"));
  try {
    writeFileSync(
      path.join(suiteDir, "a.test.mjs"),
      [
        'import { test } from "node:test";',
        `const { buildGovernorRegistry } = await import(${JSON.stringify(path.join(repoRoot, "tests", "dist", "support", "governorRegistry.js"))});`,
        'test("makes a registry", () => { buildGovernorRegistry(); });',
        "",
      ].join("\n"),
    );
    const run = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=spec", "a.test.mjs"],
      {
        cwd: suiteDir,
        env: (() => {
          const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
          delete env["NODE_TEST_CONTEXT"];
          return env;
        })(),
        encoding: "utf8",
        timeout: 120_000,
        killSignal: "SIGKILL",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.match(run.stdout ?? "", /ℹ pass 1/, `${run.stdout ?? ""}${run.stderr ?? ""}`);
    assert.deepEqual(residue(tmp), [], `a completed test file left ${residue(tmp).join(", ")}`);
  } finally {
    rmSync(suiteDir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

// -- the production certification path ---------------------------------------

const CERT_DRIVER = (manifestExpr: string, entryExpr: string, certifier: string): string =>
  [
    `const core = await import(${JSON.stringify(path.join(repoRoot, "packages", "core", "dist", "src", "index.js"))});`,
    `const fixtures = await import(${JSON.stringify(path.join(repoRoot, "tests", "dist", "support", "adapterFixtures.js"))});`,
    "const receipt = core.certifyAdapter({",
    `  adapterManifest: ${manifestExpr},`,
    `  adapterEntryPath: ${entryExpr},`,
    '  clock: new core.SteppingClock("2026-07-01T00:00:00Z", 1000),',
    `  certifierId: ${JSON.stringify(certifier)},`,
    "});",
    "console.log(JSON.stringify({ verdict: receipt.verdict }));",
  ].join("\n");

test("TMP-CERT: a successful certification removes both of every host's roots", () => {
  const tmp = isolatedTmp("cert-ok");
  try {
    const child = runChild(
      CERT_DRIVER(
        "fixtures.REFERENCE_CORRECT_MANIFEST()",
        "fixtures.referenceAdapterEntry('reference-correct')",
        "erl2-certifier",
      ),
      tmp,
    );
    assert.equal(child.status, 0, child.out);
    assert.match(child.out, /"verdict":"certified"/, child.out);
    // The certified path builds up to eight hosts, two roots each, and includes
    // the 1 ms deadline probe that SIGKILLs its adapter mid-operation.
    assert.deepEqual(residue(tmp), [], `certification left ${residue(tmp).join(", ")}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("TMP-CERT: a refused certification removes them too", () => {
  // The path a `return refuse(...)` takes out of the middle of the suite. Before
  // the fix it skipped every host root created up to that point; teardown now
  // lives in a `finally` around the whole run, so an early return cannot miss it.
  const tmp = isolatedTmp("cert-refused");
  try {
    const child = runChild(
      CERT_DRIVER(
        "fixtures.adapterManifest({ adapterId: 'sabotage-crash', operations: ['acquire', 'validate-package'] })",
        "fixtures.sabotageAdapterEntry('crash-before-response')",
        "erl2-certifier",
      ),
      tmp,
    );
    assert.equal(child.status, 0, child.out);
    assert.match(child.out, /"verdict":"refused"/, child.out);
    assert.deepEqual(residue(tmp), [], `a refused certification left ${residue(tmp).join(", ")}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("TMP-CERT: a certification that throws removes them, and the throw is what the caller sees", () => {
  // Teardown must never speak over the outcome. The self-certification refusal
  // is the throw the harness reserves for an invalid *request*, and it must come
  // back unchanged with nothing left on disk.
  const tmp = isolatedTmp("cert-throw");
  try {
    const driver = [
      `const core = await import(${JSON.stringify(path.join(repoRoot, "packages", "core", "dist", "src", "index.js"))});`,
      `const fixtures = await import(${JSON.stringify(path.join(repoRoot, "tests", "dist", "support", "adapterFixtures.js"))});`,
      "let code = 'NO_THROW';",
      "try {",
      "  core.certifyAdapter({",
      "    adapterManifest: fixtures.REFERENCE_CORRECT_MANIFEST(),",
      "    adapterEntryPath: fixtures.referenceAdapterEntry('reference-correct'),",
      '    clock: new core.SteppingClock("2026-07-01T00:00:00Z", 1000),',
      "    certifierId: 'reference-correct',",
      "  });",
      "} catch (error) { code = error.code ?? String(error); }",
      "console.log(JSON.stringify({ code }));",
    ].join("\n");
    const child = runChild(driver, tmp);
    assert.equal(child.status, 0, child.out);
    assert.match(child.out, /"code":"ADAPTER_SELF_CERTIFICATION_REFUSED"/, child.out);
    assert.deepEqual(residue(tmp), [], `a throwing certification left ${residue(tmp).join(", ")}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// -- run roots and their CLI-derived companions ------------------------------
//
// The first version of this package owned the run root and nothing else, and a
// full gate still left 387 directories behind. `resolveLocators` derives
// `${runRoot}.substrate` and `${runRoot}.reservations` when the caller supplies
// neither flag, and those are *siblings*: removing the root cannot remove them.

test("TMP-RUNROOT: the companion names still match the production defaults", () => {
  // The companion list is duplicated from the CLI rather than imported, so that
  // the suites exercising the production *default* locator path keep doing so.
  // Duplication is only safe if a change on either side fails here.
  const source = readFileSync(
    path.join(repoRoot, "packages", "cli", "src", "environmentCommands.ts"),
    "utf8",
  );
  assert.match(source, /suppliedSubstrate \?\? `\$\{runRoot\}\.substrate`/);
  assert.match(source, /suppliedReservation \?\? `\$\{runRoot\}\.reservations`/);
  assert.deepEqual(runRootCompanions("/tmp/erl2-example"), [
    "/tmp/erl2-example.substrate",
    "/tmp/erl2-example.reservations",
  ]);
});

test("TMP-RUNROOT: releasing a run root removes the whole ownership set", () => {
  const before = ownedTempDirCount();
  const root = ownedRunRoot("erl2-runroot-probe-");
  const [substrate, reservations] = runRootCompanions(root) as [string, string];
  // Companions are created by the CLI, not by the helper; the helper's job is to
  // own paths that may or may not come to exist.
  mkdirSync(substrate, { recursive: true });
  writeFileSync(path.join(substrate, "marker"), "x");
  assert.equal(ownedTempDirCount(), before + 1, "a run root is one ownership set, not three");

  releaseTempDir(root);
  assert.equal(existsSync(root), false, "the run root must be gone");
  assert.equal(existsSync(substrate), false, "the substrate companion must be gone");
  // The reservations companion was never created. Its absence must be a no-op,
  // not an error.
  assert.equal(existsSync(reservations), false);
  assert.equal(ownedTempDirCount(), before);
});

test("TMP-RUNROOT: a real environment CLI run leaves no root and no companion", () => {
  // The end-to-end proof, driven through the shipped binary rather than through
  // a hand-made directory: `provision` is the first command that resolves the
  // locators, and it is reached only after freeze-package, verify-package,
  // preregister-challenge and select. The driver asserts both companions exist
  // *before* it exits, so an empty listing afterwards means "removed", not
  // "never created".
  const tmp = isolatedTmp("runroot");
  try {
    const driver = [
      `const { runToAcquired, erl2 } = await import(${JSON.stringify(path.join(repoRoot, "tests", "dist", "support", "cliRun.js"))});`,
      'const fs = await import("node:fs");',
      'const nodePath = await import("node:path");',
      "const run = runToAcquired();",
      'const base = ["--run-root", run.runRoot, "--registry", run.registry.root, "--tier", "development", "--run", run.runId];',
      'const sourceTrust = nodePath.join(run.runRoot, "source-trust.json");',
      "fs.writeFileSync(sourceTrust, JSON.stringify({ sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash, randomnessRegistryHeadHash: run.registry.sourceTrustPolicyHash }));",
      "const plan = [",
      '  ["freeze-package", ["freeze-package", ...base]],',
      '  ["verify-package", ["verify-package", ...base, "--fake-verify-package", "succeeded", "--subject-id", "s", "--subject-version", "0.1.0"]],',
      '  ["preregister-challenge", ["preregister-challenge", ...base, "--journey-selection-policy", run.registry.journeySelectionPolicyHash, "--randomness-policy", run.registry.randomnessPolicyHash, ...run.registry.challengeCandidates.flatMap((c) => ["--challenge", c.challengeManifestHash])]],',
      '  ["select", ["select", ...base, "--source-trust-config", sourceTrust, "--expires", "2026-12-31T00:00:00Z"]],',
      '  ["provision", ["provision", ...base, "--archetype", run.registry.archetypeHash]],',
      "];",
      "for (const [name, argv] of plan) {",
      "  const result = erl2(argv);",
      "  if (result.exitCode !== 0) throw new Error(name + ': ' + JSON.stringify(result.body.errors));",
      "}",
      'const substrate = run.runRoot + ".substrate";',
      'const reservations = run.runRoot + ".reservations";',
      "if (!fs.existsSync(substrate)) throw new Error('the substrate companion was never created');",
      "if (!fs.existsSync(reservations)) throw new Error('the reservations companion was never created');",
      "console.log(JSON.stringify({ runRoot: run.runRoot, substrate, reservations }));",
    ].join("\n");
    const child = runChild(driver, tmp);
    assert.equal(child.status, 0, child.out);
    const created = JSON.parse(child.out.trim().split("\n").pop() as string) as {
      runRoot: string;
      substrate: string;
      reservations: string;
    };

    // The owning process has finished. Nothing it owned may survive it.
    assert.equal(existsSync(created.runRoot), false, "the run root must be gone");
    assert.equal(existsSync(created.substrate), false, "the `.substrate` companion must be gone");
    assert.equal(existsSync(created.reservations), false, "the `.reservations` companion must be gone");

    const left = residue(tmp);
    const OWNED_PREFIXES = [
      "erl2-mut-", "erl2-mid-", "erl2-prereg-", "erl2-registry-", "erl2-vault-",
      "erl2-adapter-ws-", "erl2-adapter-store-", "erl2-selection-", "erl2-cert-", "erl2-cert-store-",
    ];
    const stillOwned = left.filter((entry) => OWNED_PREFIXES.some((p) => entry.startsWith(p)));
    assert.deepEqual(stillOwned, [], `support-owned roots or companions remain: ${stillOwned.join(", ")}`);
    assert.deepEqual(left, [], `the isolated TMPDIR must be empty; it holds ${left.join(", ")}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
