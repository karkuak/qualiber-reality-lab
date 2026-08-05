/**
 * The evidence harness's staging root: equal path shape, and no residue.
 *
 * ## What was broken
 *
 * `evidence:update` generated the adapter-platform runs directly beneath
 * `fixtures/golden` while `evidence:verify` generated them beneath a random
 * `os.tmpdir()` directory. The two roots have different absolute path lengths,
 * the adapter host bakes the run's absolute adapter-workspace path into the
 * request frames, and `sandbox-invocation-result/v1` retains the true
 * `request_bytes` — so the two generations produced different sandbox-result core
 * hashes, and that difference propagated into detail record hashes, step
 * outcomes, lifecycle events, snapshots, the subject-output manifest, the
 * content-addressed copies and the terminal hashes. The byte-pin could not hold.
 *
 * The fix is not to stop counting real request bytes. It is to make the two
 * generations equivalent: every mode stages into `mkdtemp` under one fixed
 * repo-relative parent with one fixed prefix, so two staging roots differ in
 * their bytes and never in their length.
 *
 * ## What these controls assert
 *
 *  - the equal-length property the pin now depends on, over roots created by the
 *    harness's own `createStagingRoot`, plus the unequal counter-example it
 *    replaced;
 *  - that a staging root is parallel-safe rather than one shared fixed directory;
 *  - that the root is removed after a clean finish, after an early `process.exit`,
 *    after an uncaught throw and after an interrupt — each driven by really
 *    ending a real process that way, in a throwaway checkout root;
 *  - that no mode of `generate-evidence.mjs` generates into `fixtures/golden`;
 *  - that `--out` refuses to overwrite a directory the harness did not create.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ownedTempDir } from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = path.join(repoRoot, "scripts", "generate-evidence.mjs");
const stagingModule = pathToFileURL(path.join(repoRoot, "scripts", "lib", "evidenceStaging.mjs")).href;

const { createStagingRoot, stagingParent, STAGING_PREFIX } = (await import(stagingModule)) as {
  createStagingRoot: (repoRoot: string) => { stagingRoot: string; release: () => void };
  stagingParent: (repoRoot: string) => string;
  STAGING_PREFIX: string;
};

/**
 * Ends a child process the given way, with a staging root already created under
 * a throwaway checkout root, and reports what survived.
 *
 * The child is a real process created by the real `createStagingRoot`, so what is
 * measured is the cleanup the harness actually installs — not a re-description of
 * it here.
 */
function endedProcessResidue(how: "return" | "exit" | "throw" | "interrupt"): {
  readonly status: number | null;
  readonly stagingRoot: string;
  readonly survived: boolean;
  readonly parentSurvived: boolean;
} {
  const fakeRepoRoot = ownedTempDir("erl2-staging-checkout-");
  const childPath = path.join(ownedTempDir("erl2-staging-child-"), "child.mjs");
  writeFileSync(
    childPath,
    [
      `import { createStagingRoot } from ${JSON.stringify(stagingModule)};`,
      `import { writeFileSync } from "node:fs";`,
      `import path from "node:path";`,
      `const { stagingRoot } = createStagingRoot(${JSON.stringify(fakeRepoRoot)});`,
      // A staging root with something in it: an empty directory would be removed
      // by a weaker cleanup than the one under test.
      `writeFileSync(path.join(stagingRoot, "partial-evidence.json"), "{}\\n");`,
      `process.stdout.write(stagingRoot + "\\n");`,
      how === "exit"
        ? `process.exit(7);`
        : how === "throw"
          ? `throw new Error("generation failed");`
          : how === "interrupt"
            ? // A real timer, so the event loop is genuinely idle when the signal
              // arrives, and the process would otherwise outlive the test.
              `process.kill(process.pid, "SIGINT"); setTimeout(() => process.exit(99), 10_000);`
            : `/* return normally */`,
      "",
    ].join("\n"),
  );

  const run = spawnSync(process.execPath, [childPath], { encoding: "utf8" });
  const stagingRoot = run.stdout.trim().split("\n").pop() as string;
  assert.ok(
    stagingRoot !== undefined && stagingRoot.length > 0,
    `the child never reported a staging root (${run.stderr})`,
  );
  return {
    status: run.status,
    stagingRoot,
    survived: existsSync(stagingRoot),
    parentSurvived: existsSync(stagingParent(fakeRepoRoot)),
  };
}

test("EVIDENCE-STAGING: two staging roots differ in bytes and never in length", () => {
  const checkout = ownedTempDir("erl2-staging-checkout-");
  const a = createStagingRoot(checkout);
  const b = createStagingRoot(checkout);
  try {
    assert.notEqual(a.stagingRoot, b.stagingRoot, "each generation must own its own staging root");
    assert.equal(
      a.stagingRoot.length,
      b.stagingRoot.length,
      `staging roots must be equal length by construction: ${a.stagingRoot} vs ${b.stagingRoot}`,
    );
    assert.equal(path.dirname(a.stagingRoot), stagingParent(checkout));
    assert.ok(path.basename(a.stagingRoot).startsWith(STAGING_PREFIX));

    // The counter-example: the two roots the harness used before. Their lengths
    // are unequal, which is exactly what moved `request_bytes` between an update
    // and a verify.
    const beneathGolden = path.join(repoRoot, "fixtures", "golden");
    const beneathTmp = mkdtempSync(path.join(tmpdir(), "erl2-evidence-out-"));
    try {
      assert.notEqual(
        beneathGolden.length,
        beneathTmp.length,
        "the pre-fix roots are expected to differ in length; if they no longer do, this control is vacuous",
      );
    } finally {
      rmSync(beneathTmp, { recursive: true, force: true });
    }
  } finally {
    a.release();
    b.release();
  }
});

test("EVIDENCE-STAGING: the staging root is removed after a clean finish, an exit, a throw and an interrupt", () => {
  for (const [how, expectedStatus] of [
    ["return", 0],
    ["exit", 7],
    ["throw", 1],
    ["interrupt", 130],
  ] as const) {
    const residue = endedProcessResidue(how);
    assert.equal(residue.status, expectedStatus, `the ${how} child ended unexpectedly`);
    assert.equal(
      residue.survived,
      false,
      `a process that ended by ${how} left ${residue.stagingRoot} behind`,
    );
    assert.equal(
      residue.parentSurvived,
      false,
      `a process that ended by ${how} left an empty staging parent behind`,
    );
  }
});

test("EVIDENCE-STAGING: no mode generates into fixtures/golden, and staging is not a fixed shared directory", () => {
  const source = readFileSync(script, "utf8");

  // The generation root is assigned exactly once, from the shared module, so no
  // mode can quietly pick a different root with a different length.
  assert.match(
    source,
    /const \{ stagingRoot \} = createStagingRoot\(root\);/,
    "the staging root must come from createStagingRoot",
  );
  assert.equal(
    (source.match(/^const \{ stagingRoot \}/gm) ?? []).length,
    1,
    "the staging root must be assigned exactly once",
  );

  // `fixtures/golden` may be named only as the pin to compare against and as the
  // publish target — never as somewhere a run is generated.
  const goldenReferences = source.match(/path\.join\(root, "fixtures", "golden"\)/g) ?? [];
  assert.equal(
    goldenReferences.length,
    1,
    "fixtures/golden must be resolved once, as `pinnedRoot`, and never as a generation root",
  );
  assert.match(source, /const pinnedRoot = path\.join\(root, "fixtures", "golden"\);/);
});

test("EVIDENCE-STAGING: --out refuses a directory the harness did not create", () => {
  const occupied = ownedTempDir("erl2-evidence-out-occupied-");
  writeFileSync(path.join(occupied, "someone-elses-file.txt"), "not evidence\n");

  const refused = spawnSync(process.execPath, [script, "--out", occupied], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /refusing to overwrite/);
  // The refusal is a refusal: the directory is untouched and nothing was staged.
  assert.deepEqual(readdirSync(occupied), ["someone-elses-file.txt"]);

  const missingValue = spawnSync(process.execPath, [script, "--out"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(missingValue.status, 2, missingValue.stderr);
  assert.match(missingValue.stderr, /--out requires a directory path/);
});
