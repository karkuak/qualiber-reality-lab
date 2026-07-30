/**
 * The negative-control harness, measured.
 *
 * The campaign is this repository's instrument for the question "is this guard
 * load-bearing?", and until now the instrument itself was unmeasured. It applied
 * its patches with `source.replace(find, replace)`, which takes the **first**
 * occurrence and reports nothing when there are several, so a control whose
 * anchor stopped being unique kept producing a number for a measurement that had
 * not happened. Three controls died that way — `invalid-finding-lab-attribution`,
 * `cutoff-milestone-resolution` and `pre-dispatch-intent` — and two of the three
 * were found only by running the full set, months later.
 *
 * So the targeting is now a proof, and this suite is what proves it. The most
 * load-bearing case in the file is the last one: every shipped control is checked
 * against the real source tree on every `npm test`, so a control whose preimage
 * acquires a second occurrence fails in seconds rather than in a four-hour
 * campaign nobody runs between packages.
 *
 * The modules under test are `.mjs` build tooling rather than package source, so
 * they are imported by URL. That is deliberate: the harness must not become a
 * workspace package, because then the tree it measures would contain it.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scriptsDir = path.join(repoRoot, "scripts");
const targetModulePath = path.join(scriptsDir, "lib", "controlTarget.mjs");
const worktreeModulePath = path.join(scriptsDir, "lib", "disposableWorktree.mjs");

interface PatchPlan {
  readonly outcome: string;
  readonly patched?: string;
  readonly offsets?: readonly number[];
  readonly landedAt?: readonly number[];
  readonly replacedCount?: number;
  readonly found?: number;
  readonly expected?: number;
}

interface ControlTargetModule {
  readonly TARGET_OUTCOME: Record<string, string>;
  readonly occurrenceOffsets: (haystack: string, needle: string) => number[];
  readonly countOccurrences: (haystack: string, needle: string) => number;
  readonly planControlPatch: (spec: Record<string, unknown>) => PatchPlan;
  readonly verifyPatchOnDisk: (check: Record<string, unknown>) => { readonly outcome: string };
}

interface HarnessModule {
  readonly CONTROLS: readonly {
    readonly id: string;
    readonly file: string;
    readonly find: string;
    readonly replace: string;
    readonly expectedMatches?: number;
    readonly anchor?: string;
    readonly tests: readonly string[];
    readonly expect: string;
  }[];
  readonly CONTROL_RESULT: Record<string, string>;
  readonly classifyTestRun: (input: Record<string, unknown>) => {
    readonly result: string;
    readonly pass: number;
    readonly fail: number;
    readonly strayFiles?: readonly string[];
  };
  readonly agreesWithExpectation: (result: string, expect: string) => boolean;
  readonly isHarnessError: (result: string) => boolean;
  readonly validateControlDeclarations: (controls: readonly unknown[]) => string[];
}

interface WorktreeModule {
  readonly certifyTreeUnchanged: (
    before: { digest: string; status: string },
    after: { digest: string; status: string },
  ) => { readonly certified: boolean; readonly reason?: string };
}

const targeting = (await import(pathToFileURL(targetModulePath).href)) as unknown as ControlTargetModule;
const harness = (await import(
  pathToFileURL(path.join(scriptsDir, "negative-control.mjs")).href
)) as unknown as HarnessModule;
const worktreeLib = (await import(pathToFileURL(worktreeModulePath).href)) as unknown as WorktreeModule;

const { TARGET_OUTCOME, planControlPatch, verifyPatchOnDisk, occurrenceOffsets } = targeting;

// -- targeting ---------------------------------------------------------------

test("NC-TARGET: a unique match is applied and lands where the plan says", () => {
  const source = "alpha\nconst guard = true;\nomega\n";
  const plan = planControlPatch({ source, find: "const guard = true;", replace: "const guard = false;" });

  assert.equal(plan.outcome, TARGET_OUTCOME["APPLIED"]);
  assert.equal(plan.replacedCount, 1);
  assert.equal(plan.patched, "alpha\nconst guard = false;\nomega\n");
  // Positional, not "the postimage appears somewhere".
  const at = plan.landedAt?.[0] ?? -1;
  assert.equal(plan.patched?.slice(at, at + "const guard = false;".length), "const guard = false;");
});

test("NC-TARGET: zero matches refuses rather than reporting a result", () => {
  const plan = planControlPatch({ source: "nothing here\n", find: "const guard = true;", replace: "x" });
  assert.equal(plan.outcome, TARGET_OUTCOME["NOT_APPLICABLE"]);
  assert.equal(plan.found, 0);
});

test("NC-TARGET: two matches refuse, because the default expected count is exactly one", () => {
  const source = "guard();\nmiddle\nguard();\n";
  const plan = planControlPatch({ source, find: "guard();", replace: "void 0;" });

  assert.equal(plan.outcome, TARGET_OUTCOME["AMBIGUOUS"]);
  assert.equal(plan.found, 2);
  assert.equal(plan.expected, 1);
  assert.equal(plan.patched, undefined, "an ambiguous control must produce no patched text at all");
});

test("NC-TARGET-REGRESSION: the intended occurrence is the second, and the old behaviour took the first", () => {
  // This is `pre-dispatch-intent` in miniature. ADR-ERL2-028 inserted a second
  // `this.advance(spec.operationId, "dispatching")` *above* the one the control
  // meant, on the resume path. `String.replace` silently disabled the resume
  // branch, the control scored 7 pass / 0 fail, and it read as a guard that was
  // not load-bearing rather than as a control that had stopped applying.
  const source = [
    "if (resuming) {",
    '  this.advance(spec.operationId, "dispatching");', // the one ADR-ERL2-028 added
    "}",
    "// Durable *before* the call.",
    '  this.advance(spec.operationId, "dispatching");', // the one the control means
    "dispatch();",
  ].join("\n");
  const find = '  this.advance(spec.operationId, "dispatching");';

  const legacy = source.replace(find, "  void spec.operationId;");
  const firstOffset = source.indexOf(find);
  const intendedOffset = source.lastIndexOf(find);
  assert.notEqual(firstOffset, intendedOffset, "the fixture must contain two identical anchors");
  assert.ok(
    legacy.indexOf("void spec.operationId;") < intendedOffset,
    "String.replace must be shown mutating the *first* occurrence, which is the defect",
  );

  const plan = planControlPatch({ source, find, replace: "  void spec.operationId;" });
  assert.equal(plan.outcome, TARGET_OUTCOME["AMBIGUOUS"], "the hardened harness must refuse rather than choose");
  assert.equal(plan.found, 2);

  // And the anchor is how a control that genuinely means the second one says so.
  const anchored = planControlPatch({
    source,
    anchor: "// Durable *before* the call.",
    find,
    replace: "  void spec.operationId;",
  });
  assert.equal(anchored.outcome, TARGET_OUTCOME["APPLIED"]);
  assert.ok(
    (anchored.landedAt?.[0] ?? -1) > firstOffset,
    "the anchored patch must land on the second occurrence, not the first",
  );
});

test("NC-TARGET: an explicit expected count replaces every declared occurrence", () => {
  const source = "guard();\nmiddle\nguard();\n";
  const plan = planControlPatch({ source, find: "guard();", replace: "void 0;", expectedMatches: 2 });

  assert.equal(plan.outcome, TARGET_OUTCOME["APPLIED"]);
  assert.equal(plan.replacedCount, 2);
  assert.equal(plan.patched, "void 0;\nmiddle\nvoid 0;\n");
});

test("NC-TARGET: an expected count the source does not satisfy refuses in both directions", () => {
  const source = "guard();\nmiddle\nguard();\n";
  const tooMany = planControlPatch({ source, find: "guard();", replace: "void 0;", expectedMatches: 3 });
  assert.equal(tooMany.outcome, TARGET_OUTCOME["AMBIGUOUS"]);
  assert.equal(tooMany.found, 2);
  assert.equal(tooMany.expected, 3);

  const tooFew = planControlPatch({ source, find: "guard();", replace: "void 0;", expectedMatches: 1 });
  assert.equal(tooFew.outcome, TARGET_OUTCOME["AMBIGUOUS"]);

  const zero = planControlPatch({ source, find: "guard();", replace: "void 0;", expectedMatches: 0 });
  assert.equal(zero.outcome, TARGET_OUTCOME["DECLARATION_INVALID"]);
});

test("NC-TARGET: an ambiguous anchor cannot disambiguate anything", () => {
  const source = "// marker\nguard();\n// marker\nguard();\n";
  const plan = planControlPatch({ source, anchor: "// marker", find: "guard();", replace: "void 0;" });
  assert.equal(plan.outcome, TARGET_OUTCOME["ANCHOR_AMBIGUOUS"]);
  assert.equal(plan.found, 2);

  const missing = planControlPatch({ source, anchor: "// absent", find: "guard();", replace: "void 0;" });
  assert.equal(missing.outcome, TARGET_OUTCOME["ANCHOR_NOT_FOUND"]);
});

test("NC-TARGET: a postimage that reintroduces its own preimage is accounted, not refused", () => {
  // Several shipped controls insert an early return *above* the call they
  // disable, so the preimage legitimately survives. What must hold is the exact
  // accounting, not its absence.
  const source = "  assertSubstrateBinding({\n    runId,\n  });\n";
  const plan = planControlPatch({
    source,
    find: "  assertSubstrateBinding({",
    replace: '  if (String(1) !== "2") return;\n  assertSubstrateBinding({',
  });

  assert.equal(plan.outcome, TARGET_OUTCOME["APPLIED"]);
  assert.equal(
    targeting.countOccurrences(plan.patched ?? "", "  assertSubstrateBinding({"),
    1,
    "the preimage must survive exactly once, because the postimage puts it back",
  );
});

test("NC-TARGET: an empty postimage deletes, and the preimage must be gone", () => {
  const source = "keep\nDELETE ME\nkeep\n";
  const plan = planControlPatch({ source, find: "DELETE ME\n", replace: "" });
  assert.equal(plan.outcome, TARGET_OUTCOME["APPLIED"]);
  assert.equal(plan.patched, "keep\nkeep\n");
});

test("NC-TARGET: a postimage already present elsewhere refuses when uniqueness is declared", () => {
  // Opt-in rather than default. `post-capture-activation-requirement` replaces a
  // four-line list with `];`, which occurs ten times in its file — a control that
  // is correct as written, and which a blanket uniqueness rule would refuse.
  const source = "void 0;\nalpha\nguard();\n";
  const lax = planControlPatch({ source, find: "guard();", replace: "void 0;" });
  assert.equal(lax.outcome, TARGET_OUTCOME["APPLIED"], "uniqueness is not the default");

  const strict = planControlPatch({ source, find: "guard();", replace: "void 0;", uniquePostimage: true });
  assert.equal(strict.outcome, TARGET_OUTCOME["POSTIMAGE_ELSEWHERE"]);
});

test("NC-TARGET: a no-op patch is a malformed declaration", () => {
  const plan = planControlPatch({ source: "guard();\n", find: "guard();", replace: "guard();" });
  assert.equal(plan.outcome, TARGET_OUTCOME["DECLARATION_INVALID"]);
});

test("NC-TARGET: an empty preimage names no target", () => {
  assert.throws(() => occurrenceOffsets("anything", ""), TypeError);
  const plan = planControlPatch({ source: "x", find: "", replace: "y" });
  assert.equal(plan.outcome, TARGET_OUTCOME["DECLARATION_INVALID"]);
});

test("NC-TARGET: the bytes on disk are what the control must have proven", () => {
  const source = "alpha\nguard();\nomega\n";
  const plan = planControlPatch({ source, find: "guard();", replace: "void 0;" });
  assert.equal(plan.outcome, TARGET_OUTCOME["APPLIED"]);

  const landed = verifyPatchOnDisk({ written: plan.patched, plan, replace: "void 0;" });
  assert.equal(landed.outcome, TARGET_OUTCOME["APPLIED"]);

  // Something between the write and the build rewrote the file: the postimage is
  // not at the offset the plan computed, and the control has proven nothing.
  const clobbered = verifyPatchOnDisk({ written: source, plan, replace: "void 0;" });
  assert.equal(clobbered.outcome, TARGET_OUTCOME["POSTIMAGE_MISSING"]);

  // The postimage is present, but the rest of the file is not what was planned.
  const drifted = verifyPatchOnDisk({
    written: `${plan.patched ?? ""}\n// appended by something else\n`,
    plan,
    replace: "void 0;",
  });
  assert.equal(drifted.outcome, TARGET_OUTCOME["SPLICE_COLLATERAL"]);
});

// -- result classification ---------------------------------------------------

const SUMMARY = (pass: number, fail: number): string =>
  `ℹ tests ${String(pass + fail)}\nℹ suites 0\nℹ pass ${String(pass)}\nℹ fail ${String(fail)}\n`;

test("NC-CLASSIFY: a named suite failing is a behavioural kill", () => {
  const classified = harness.classifyTestRun({
    stdout: `${SUMMARY(3, 1)}\n✖ failing tests:\n\ntest at tests/dist/e2e/environmentRun.test.js:12:1\n`,
    expect: "fail",
    tests: ["tests/dist/e2e/environmentRun.test.js"],
  });
  assert.equal(classified.result, harness.CONTROL_RESULT["NAMED_TESTS_FAILED"]);
  assert.equal(harness.isHarnessError(classified.result), false);
  assert.equal(harness.agreesWithExpectation(classified.result, "fail"), true);
});

test("NC-CLASSIFY: a guard that kills nothing is a result, not an error", () => {
  const classified = harness.classifyTestRun({
    stdout: SUMMARY(4, 0),
    expect: "pass",
    tests: ["tests/dist/e2e/environmentRun.test.js"],
  });
  assert.equal(classified.result, harness.CONTROL_RESULT["NO_KILL_AS_DECLARED"]);
  assert.equal(harness.isHarnessError(classified.result), false);
  assert.equal(harness.agreesWithExpectation(classified.result, "pass"), true);
  // ...and the same run is a disagreement when a kill was expected.
  const expectedAKill = harness.classifyTestRun({
    stdout: SUMMARY(4, 0),
    expect: "fail",
    tests: ["tests/dist/e2e/environmentRun.test.js"],
  });
  assert.equal(expectedAKill.result, harness.CONTROL_RESULT["TESTS_PASSED_UNEXPECTEDLY"]);
  assert.equal(harness.agreesWithExpectation(expectedAKill.result, "fail"), false);
});

test("NC-CLASSIFY: a failure outside the declared suites is not the control's kill", () => {
  const classified = harness.classifyTestRun({
    stdout:
      `${SUMMARY(2, 1)}\n✖ failing tests:\n\ntest at tests/dist/e2e/somethingElse.test.js:3:1\n`,
    expect: "fail",
    tests: ["tests/dist/e2e/environmentRun.test.js"],
  });
  assert.equal(classified.result, harness.CONTROL_RESULT["UNRELATED_TESTS_FAILED"]);
  assert.deepEqual(classified.strayFiles, ["tests/dist/e2e/somethingElse.test.js"]);
  assert.equal(harness.isHarnessError(classified.result), true);
});

test("NC-CLASSIFY: an unparseable run is a harness failure, never `nothing failed`", () => {
  const classified = harness.classifyTestRun({
    stdout: "SyntaxError: Unexpected token\n",
    expect: "fail",
    tests: ["tests/dist/e2e/environmentRun.test.js"],
  });
  assert.equal(classified.result, harness.CONTROL_RESULT["RUNNER_FAILED"]);
  assert.equal(harness.isHarnessError(classified.result), true);
  assert.equal(harness.agreesWithExpectation(classified.result, "fail"), false);
  assert.equal(harness.agreesWithExpectation(classified.result, "pass"), false);
});

test("NC-CLASSIFY: a build failure is not a load-bearing kill", () => {
  // The distinction the ledger has had to make by hand three times: a patched
  // tree that does not compile says something about the patch, and nothing about
  // whether the guard is load-bearing.
  assert.equal(harness.isHarnessError(harness.CONTROL_RESULT["BUILD_FAILED"] ?? ""), true);
  assert.equal(harness.agreesWithExpectation(harness.CONTROL_RESULT["BUILD_FAILED"] ?? "", "fail"), false);
  for (const outcome of Object.values(TARGET_OUTCOME)) {
    if (outcome === TARGET_OUTCOME["APPLIED"]) continue;
    assert.equal(
      harness.agreesWithExpectation(outcome, "fail"),
      false,
      `${outcome} must never be scored as a behavioural kill`,
    );
    assert.equal(
      harness.agreesWithExpectation(outcome, "pass"),
      false,
      `${outcome} must never be scored as a non-load-bearing control`,
    );
  }
});

// -- declaration validation --------------------------------------------------

test("NC-DECLARE: a control that names no invariant, target or suite is refused", () => {
  const problems = harness.validateControlDeclarations([
    { id: "no-what", file: "a.ts", find: "x", replace: "y", tests: ["t.js"], expect: "fail" },
    { id: "no-tests", what: "w", file: "a.ts", find: "x", replace: "y", tests: [], expect: "fail" },
    { id: "no-expect", what: "w", file: "a.ts", find: "x", replace: "y", tests: ["t.js"] },
    { id: "no-what", what: "w", file: "a.ts", find: "x", replace: "y", tests: ["t.js"], expect: "fail" },
  ]);
  assert.ok(problems.some((p) => p.includes("no named invariant")));
  assert.ok(problems.some((p) => p.includes("names no test")));
  assert.ok(problems.some((p) => p.includes("`expect` must be")));
  assert.ok(problems.some((p) => p.includes("duplicate control id")));
});

test("NC-DECLARE: the shipped control table is well-formed", () => {
  assert.deepEqual(harness.validateControlDeclarations(harness.CONTROLS), []);
});

// -- the tree-unchanged certificate -----------------------------------------

test("NC-TREE: a source-tree digest mismatch refuses certification", () => {
  const before = { digest: "aaaa", status: "" };
  assert.equal(worktreeLib.certifyTreeUnchanged(before, { digest: "aaaa", status: "" }).certified, true);

  const changedBytes = worktreeLib.certifyTreeUnchanged(before, { digest: "bbbb", status: "" });
  assert.equal(changedBytes.certified, false);
  assert.match(changedBytes.reason ?? "", /digest changed/);

  // A file that appeared or vanished moves `git status` without necessarily
  // moving the tracked-file digest, so both halves are required.
  const changedStatus = worktreeLib.certifyTreeUnchanged(before, { digest: "aaaa", status: "?? stray.ts" });
  assert.equal(changedStatus.certified, false);
  assert.match(changedStatus.reason ?? "", /status changed/);
});

// -- restoration and residue, against a throwaway repository ------------------

function makeThrowawayRepo(): { root: string; file: string; original: string } {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-harness-repo-"));
  const original = "export const guard = true;\n";
  const file = path.join(root, "guard.ts");
  const run = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  };
  run("init", "--quiet");
  run("config", "user.email", "harness@example.invalid");
  run("config", "user.name", "harness");
  writeFileSync(file, original);
  run("add", "guard.ts");
  run("commit", "--quiet", "-m", "initial");
  return { root, file, original };
}

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

test("NC-RESTORE: a control's patch is restored from the object store, and the restoration is proven", async () => {
  const repo = makeThrowawayRepo();
  try {
    const lib = (await import(pathToFileURL(worktreeModulePath).href)) as unknown as {
      createDisposableWorktree: (o: Record<string, unknown>) => {
        worktree: string;
        worktreeRoot: string;
        restore: () => string | undefined;
        release: () => void;
      };
      worktreeResidue: (o: Record<string, unknown>) => string[];
    };
    const disposable = lib.createDisposableWorktree({ repoRoot: repo.root, prefix: "erl2-harness-restore-" });
    const patched = path.join(disposable.worktree, "guard.ts");

    // Stand in for a control whose named suite failed: the tree is mutated and
    // the campaign moves on to restoration regardless of the outcome.
    writeFileSync(patched, "export const guard = false;\n");
    assert.notEqual(readFileSync(patched, "utf8"), repo.original);

    const residual = disposable.restore();
    assert.equal(residual, undefined, "restoration must report clean");
    assert.equal(readFileSync(patched, "utf8"), repo.original, "the patch must be gone");

    disposable.release();
    assert.deepEqual(
      lib.worktreeResidue({
        repoRoot: repo.root,
        worktree: disposable.worktree,
        worktreeRoot: disposable.worktreeRoot,
      }),
      [],
    );
    assert.equal(existsSync(disposable.worktreeRoot), false);
    // And the repository the campaign was measuring never moved.
    assert.equal(readFileSync(repo.file, "utf8"), repo.original);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

/**
 * Drive a real worktree in a child process and kill it with `signal`.
 *
 * The `finally` in the campaign runs on a return and on a throw, and on neither
 * of the two ways a long campaign actually ends. The independent review found
 * that by killing a run by hand; a property discovered that way should not stay
 * discoverable only that way.
 */
async function releasesOnSignal(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  const repo = makeThrowawayRepo();
  const marker = path.join(repo.root, "worktree.json");
  try {
    const driver = [
      `import { createDisposableWorktree } from ${JSON.stringify(pathToFileURL(worktreeModulePath).href)};`,
      "import { writeFileSync } from 'node:fs';",
      "const d = createDisposableWorktree({",
      "  repoRoot: process.env['HARNESS_REPO'],",
      "  prefix: 'erl2-harness-signal-',",
      "});",
      "d.installSignalHandlers(() => {});",
      "writeFileSync(process.env['HARNESS_MARKER'], JSON.stringify({",
      "  worktree: d.worktree, worktreeRoot: d.worktreeRoot,",
      "}));",
      "setInterval(() => {}, 1_000);",
    ].join("\n");

    const child = spawn(process.execPath, ["--input-type=module", "-e", driver], {
      env: { ...process.env, HARNESS_REPO: repo.root, HARNESS_MARKER: marker },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    for (let waited = 0; waited < 10_000 && !existsSync(marker); waited += 50) await sleep(50);
    assert.ok(existsSync(marker), `the driver never created its worktree: ${stderr}`);
    const created = JSON.parse(readFileSync(marker, "utf8")) as { worktree: string; worktreeRoot: string };
    assert.equal(existsSync(created.worktree), true);

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
    child.kill(signal);
    await exited;

    const lib = (await import(pathToFileURL(worktreeModulePath).href)) as unknown as {
      worktreeResidue: (o: Record<string, unknown>) => string[];
    };
    assert.equal(
      existsSync(created.worktreeRoot),
      false,
      `${signal} left the temp directory behind: ${stderr}`,
    );
    assert.deepEqual(
      lib.worktreeResidue({ repoRoot: repo.root, worktree: created.worktree, worktreeRoot: created.worktreeRoot }),
      [],
      `${signal} left a registered worktree behind`,
    );
    assert.equal(readFileSync(repo.file, "utf8"), repo.original);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}

test("NC-RESTORE: SIGINT releases the worktree before exiting", async () => {
  await releasesOnSignal("SIGINT");
});

test("NC-RESTORE: SIGTERM releases the worktree before exiting", async () => {
  await releasesOnSignal("SIGTERM");
});

// -- the standing check on the shipped controls ------------------------------

test("NC-CAMPAIGN: every shipped control still targets exactly what it declares", () => {
  // The case this whole package exists for, and the reason it lives in `npm test`
  // rather than only in the campaign: three controls have expired because a later
  // package inserted similar text above their anchor, and two of the three went
  // unnoticed until a full campaign months later. Here it takes a second.
  const failures: string[] = [];
  for (const control of harness.CONTROLS) {
    const source = readFileSync(path.join(repoRoot, control.file), "utf8");
    const plan = planControlPatch({
      source,
      find: control.find,
      replace: control.replace,
      ...(control.expectedMatches === undefined ? {} : { expectedMatches: control.expectedMatches }),
      ...(control.anchor === undefined ? {} : { anchor: control.anchor }),
    });
    if (plan.outcome !== TARGET_OUTCOME["APPLIED"]) {
      failures.push(
        `${control.id} (${control.file}): ${plan.outcome} — found ${String(plan.found ?? plan.offsets?.length ?? 0)}`,
      );
    }
  }
  assert.deepEqual(
    failures,
    [],
    "a control whose preimage is missing or no longer unique measures nothing; re-anchor it on something " +
      "the invariant owns, or declare `expectedMatches`",
  );
});

test("NC-CAMPAIGN: every control names a suite file that exists in the source tree", () => {
  // A control naming a suite that was renamed would run `node --test` over a
  // missing path and report a runner failure deep in a campaign. It is cheaper to
  // say so here.
  const missing: string[] = [];
  for (const control of harness.CONTROLS) {
    for (const suite of control.tests) {
      const source = path.join(repoRoot, suite.replace("tests/dist/", "tests/").replace(/\.js$/, ".ts"));
      if (!existsSync(source)) missing.push(`${control.id}: ${suite}`);
    }
  }
  assert.deepEqual(missing, []);
});
