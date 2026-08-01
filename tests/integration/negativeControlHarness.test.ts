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
    readonly mustFail?: readonly string[];
    readonly mustFailCases?: readonly string[];
    readonly expect: string;
  }[];
  readonly CONTROL_RESULT: Record<string, string>;
  readonly classifyTestRun: (input: Record<string, unknown>) => {
    readonly result: string;
    readonly pass: number;
    readonly fail: number;
    readonly strayFiles?: readonly string[];
    readonly failingCases?: readonly string[];
    readonly missingCases?: readonly string[];
  };
  readonly parseFailingCases: (stdout: string) => readonly { readonly file: string; readonly name: string }[];
  readonly agreesWithExpectation: (result: string, expect: string) => boolean;
  readonly isHarnessError: (result: string) => boolean;
  readonly validateControlDeclarations: (controls: readonly unknown[]) => string[];
  readonly STAGE_TIMEOUT_MS: { readonly build: number; readonly suite: number };
  readonly STAGE_MAX_OUTPUT_BYTES: number;
  readonly runStage: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly stage: string;
  }) => {
    readonly stage: string;
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly elapsedMs: number;
    readonly timedOut: boolean;
    readonly pid?: number;
    readonly spawnError?: string;
  };
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
 *
 * ## Why every path kills the child
 *
 * The first version of this helper did not, and it hung the **entire suite** for
 * seven hours. `spawn` with piped stdio keeps the parent's event loop alive until
 * the child exits, and the child holds itself open with a `setInterval`. So any
 * early failure — a marker that never appeared because thirty concurrent test
 * processes made `git worktree add` slower than the poll window — left the child
 * running, left the parent unable to exit, and left `node --test` waiting on a
 * file that would never finish. `--test-timeout=0` means nothing rescues it.
 *
 * The bug was mine, not the harness's: driven directly, `installSignalHandlers`
 * fires, releases and exits cleanly every time. What was missing was the
 * discipline this file exists to check — clean up on every path, including the
 * ones taken when something has already gone wrong.
 *
 * So: the child is killed in a `finally`, its streams are destroyed, and the wait
 * for its exit is bounded. A test that cannot prove cleanup must **fail**, never
 * hang.
 */
async function releasesOnSignal(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  const repo = makeThrowawayRepo();
  const marker = path.join(repo.root, "worktree.json");
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

  try {
    // Generous, because this runs alongside every other suite and `git worktree
    // add` is not fast under that load. Exceeding it is a failure, not a hang.
    for (let waited = 0; waited < 60_000 && !existsSync(marker); waited += 50) await sleep(50);
    assert.ok(existsSync(marker), `the driver never created its worktree: ${stderr}`);
    const created = JSON.parse(readFileSync(marker, "utf8")) as { worktree: string; worktreeRoot: string };
    assert.equal(existsSync(created.worktree), true);

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
    child.kill(signal);

    // Bounded. If the handler does not terminate the child, that is exactly the
    // defect this case exists to catch, and it must surface as a failure.
    const timedOut = Symbol("timeout");
    const outcome = await Promise.race([
      exited.then(() => "exited" as const),
      sleep(30_000).then(() => timedOut),
    ]);
    assert.notEqual(outcome, timedOut, `${signal} did not terminate the driver: ${stderr}`);

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
    // Every path, including the ones taken when an assertion already failed.
    // Piped stdio keeps this process alive until the child is gone.
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.stderr?.destroy();
    child.stdout?.destroy();
    rmSync(repo.root, { recursive: true, force: true });
  }
}

test("NC-RESTORE: SIGINT releases the worktree before exiting", async () => {
  await releasesOnSignal("SIGINT");
});

test("NC-RESTORE: SIGTERM releases the worktree before exiting", async () => {
  await releasesOnSignal("SIGTERM");
});

// -- case-level kill granularity (review R-05) -------------------------------
//
// A control's kill used to be measured at *file* granularity: `fail > 0` and
// every failing file inside `mustFail` scored a kill without the harness ever
// checking which case failed. All six Step 6B controls name the same twelve-case
// suite, so "1 of 12 failed" was read as proof of the invariant by a human
// comparing counts in a ledger — review, not measurement.

/** Reporter output for a run whose failing cases are exactly `cases`. */
const FAILING = (
  pass: number,
  cases: readonly (readonly [file: string, name: string])[],
): string =>
  `${SUMMARY(pass, cases.length)}\n✖ failing tests:\n\n` +
  cases.map(([file, name]) => `test at ${file}:12:1\n✖ ${name} (1.5ms)\n  AssertionError\n`).join("\n");

const SUITE = "tests/dist/e2e/environmentEvidenceBoundaries.test.js";

test("NC-CASES: the reporter's failing-case names are parsed from a real `node --test` run", async () => {
  // The parser's whole risk is that it agrees with a hand-written fixture and
  // disagrees with the reporter. So this one case runs the real runner over a
  // real fixture and parses the real bytes; every case below can then use
  // synthetic output honestly.
  const dir = mkdtempSync(path.join(tmpdir(), "erl2-reporter-fixture-"));
  writeFileSync(
    path.join(dir, "fixture.test.mjs"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert";',
      'test("ALPHA: the intended case", () => { assert.equal(1, 2); });',
      'test("BETA: an unrelated case", () => { assert.equal(1, 1); });',
      'test("GAMMA: another intended case", () => { assert.equal(3, 4); });',
      "",
    ].join("\n"),
  );
  try {
    const run = harness.runStage({
      command: process.execPath,
      args: ["--test", "--test-reporter=spec", "fixture.test.mjs"],
      cwd: dir,
      timeoutMs: 60_000,
      stage: "suite",
    });
    const parsed = harness.parseFailingCases(run.stdout);
    assert.deepEqual(
      parsed.map((c) => c.name).sort(),
      ["ALPHA: the intended case", "GAMMA: another intended case"],
      `the reporter format moved; parsed ${JSON.stringify(parsed)}`,
    );
    assert.equal(parsed.every((c) => c.file.endsWith("fixture.test.mjs")), true);

    // …and the classifier reaches the same verdict over those real bytes.
    const killed = harness.classifyTestRun({
      stdout: run.stdout,
      expect: "fail",
      tests: ["fixture.test.mjs"],
      mustFailCases: ["ALPHA: the intended case"],
    });
    assert.equal(killed.result, harness.CONTROL_RESULT["NAMED_TESTS_FAILED"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NC-CASES: the intended named case failing is the control's kill", () => {
  const classified = harness.classifyTestRun({
    stdout: FAILING(11, [[SUITE, "EB-OUTPUT: a secret canary in the subject's output bytes refuses before the freeze"]]),
    expect: "fail",
    tests: [SUITE],
    mustFail: [SUITE],
    mustFailCases: ["EB-OUTPUT: a secret canary in the subject's output bytes refuses before the freeze"],
  });
  assert.equal(classified.result, harness.CONTROL_RESULT["NAMED_TESTS_FAILED"]);
  assert.equal(harness.isHarnessError(classified.result), false);
  assert.equal(harness.agreesWithExpectation(classified.result, "fail"), true);
});

test("NC-CASES: only an unrelated case in the same file failing is not an agreed kill", () => {
  // The defect in one line. The file is the declared file, the count is 1 of 12,
  // and the invariant the control names was never exercised.
  const classified = harness.classifyTestRun({
    stdout: FAILING(11, [[SUITE, "EB-OUTPUT: clean binary output freezes and the run finalizes"]]),
    expect: "fail",
    tests: [SUITE],
    mustFail: [SUITE],
    mustFailCases: ["EB-OUTPUT: a secret canary in the subject's output bytes refuses before the freeze"],
  });
  assert.equal(classified.result, harness.CONTROL_RESULT["DECLARED_CASES_NOT_FAILED"]);
  assert.equal(harness.isHarnessError(classified.result), true, "invalid evidence, not a result about the guard");
  assert.equal(harness.agreesWithExpectation(classified.result, "fail"), false);
  assert.equal(harness.agreesWithExpectation(classified.result, "pass"), false);
  // The diagnostic a campaign operator needs is in the result, not in a rerun.
  assert.deepEqual(classified.missingCases, [
    "EB-OUTPUT: a secret canary in the subject's output bytes refuses before the freeze",
  ]);
  assert.deepEqual(classified.failingCases, ["EB-OUTPUT: clean binary output freezes and the run finalizes"]);
});

test("NC-CASES: a declared case absent from the reporter output is not an agreed kill", () => {
  // The summary says a test failed and the failing-tests section names no case —
  // a truncated stream, a reporter change. Silence must not read as agreement.
  const classified = harness.classifyTestRun({
    stdout: `${SUMMARY(11, 1)}\n✖ failing tests:\n\ntest at ${SUITE}:12:1\n`,
    expect: "fail",
    tests: [SUITE],
    mustFail: [SUITE],
    mustFailCases: ["EB-SIZE: one byte over the declared ceiling refuses before the manifest freezes"],
  });
  assert.equal(classified.result, harness.CONTROL_RESULT["DECLARED_CASES_NOT_FAILED"]);
  assert.deepEqual(classified.failingCases, []);
});

test("NC-CASES: every declared case must fail, not merely one of them", () => {
  const declared = [
    "EB-TELEMETRY: a canary in the telemetry bytes refuses before the telemetry is retained",
    "EB-TELEMETRY: a refused capture cannot be stepped past by retrying observe",
    "EB-TELEMETRY: the run still reaches exactly one invalid terminal that verifies offline",
  ];
  const all = harness.classifyTestRun({
    stdout: FAILING(9, declared.map((name) => [SUITE, name] as const)),
    expect: "fail",
    tests: [SUITE],
    mustFail: [SUITE],
    mustFailCases: declared,
  });
  assert.equal(all.result, harness.CONTROL_RESULT["NAMED_TESTS_FAILED"]);
  assert.equal(harness.agreesWithExpectation(all.result, "fail"), true);

  const partial = harness.classifyTestRun({
    stdout: FAILING(10, [[SUITE, declared[0] as string], [SUITE, declared[1] as string]]),
    expect: "fail",
    tests: [SUITE],
    mustFail: [SUITE],
    mustFailCases: declared,
  });
  assert.equal(partial.result, harness.CONTROL_RESULT["DECLARED_CASES_NOT_FAILED"]);
  assert.deepEqual(partial.missingCases, [declared[2]]);
});

test("NC-CASES: a control that declares no cases keeps exactly its old behaviour", () => {
  // The legacy shape: file-level `mustFail` and nothing more. It must still be a
  // kill, and it must still carry no case-level fields to reason about.
  const classified = harness.classifyTestRun({
    stdout: FAILING(11, [[SUITE, "EB-OUTPUT: clean binary output freezes and the run finalizes"]]),
    expect: "fail",
    tests: [SUITE],
    mustFail: [SUITE],
  });
  assert.equal(classified.result, harness.CONTROL_RESULT["NAMED_TESTS_FAILED"]);
  assert.equal(harness.agreesWithExpectation(classified.result, "fail"), true);
  assert.equal(classified.missingCases, undefined);
  assert.equal(classified.failingCases, undefined);

  // …and a stray file still outranks the case check, because a failure outside
  // the declared suite is not this control's kill whatever it is named.
  const stray = harness.classifyTestRun({
    stdout: FAILING(2, [["tests/dist/e2e/somethingElse.test.js", "EB-OUTPUT: a secret canary"]]),
    expect: "fail",
    tests: [SUITE],
    mustFail: [SUITE],
    mustFailCases: ["EB-OUTPUT: a secret canary"],
  });
  assert.equal(stray.result, harness.CONTROL_RESULT["UNRELATED_TESTS_FAILED"]);
});

test("NC-DECLARE: `mustFailCases` is rejected when it is empty, duplicated or malformed", () => {
  const base = { what: "w", file: "a.ts", find: "x", replace: "y", tests: ["t.js"], expect: "fail" };
  const problems = harness.validateControlDeclarations([
    { ...base, id: "empty-array", mustFailCases: [] },
    { ...base, id: "empty-entry", mustFailCases: ["ok", "  "] },
    { ...base, id: "non-string", mustFailCases: [7] },
    { ...base, id: "duplicated", mustFailCases: ["same", "same"] },
    { ...base, id: "expects-pass", expect: "pass", mustFailCases: ["case"] },
  ]);
  assert.ok(problems.some((p) => p.startsWith("empty-array:") && p.includes("non-empty array")));
  assert.ok(problems.some((p) => p.startsWith("empty-entry:") && p.includes("empty or non-string")));
  assert.ok(problems.some((p) => p.startsWith("non-string:") && p.includes("empty or non-string")));
  assert.ok(problems.some((p) => p.startsWith("duplicated:") && p.includes("repeats same")));
  assert.ok(problems.some((p) => p.startsWith("expects-pass:") && p.includes('`expect: "fail"`')));
});

test("NC-DECLARE: the six Step 6B evidence-boundary controls each name their load-bearing case", () => {
  // The controls this finding was written about. Each names the twelve-case
  // producer-boundary suite, so without a case-level declaration each one's kill
  // is "something in that file failed".
  const expected: Record<string, readonly string[]> = {
    "mounted-file-byte-scan": ["EB-MOUNT: a canary in the mounted file's bytes refuses before the adapter is dispatched"],
    "lab-telemetry-oracle-scan": ["EB-TELEMETRY: a canary in the telemetry bytes refuses before the telemetry is retained"],
    "subject-output-secret-canary-scan": ["EB-OUTPUT: a secret canary in the subject's output bytes refuses before the freeze"],
    "subject-output-forbidden-identifier-scan": ["EB-OUTPUT: a forbidden identifier in the subject's output bytes refuses before the freeze"],
    "subject-output-declared-byte-ceiling": ["EB-SIZE: one byte over the declared ceiling refuses before the manifest freezes"],
    "subject-output-byte-total-counts-payloads": ["EB-SIZE: one byte over the declared ceiling refuses before the manifest freezes"],
  };
  for (const [id, required] of Object.entries(expected)) {
    const control = harness.CONTROLS.find((c) => c.id === id);
    assert.ok(control !== undefined, `${id} must still be a shipped control`);
    const declared = control.mustFailCases ?? [];
    assert.ok(declared.length > 0, `${id} must declare the case its invariant owns`);
    for (const name of required) {
      assert.ok(declared.includes(name), `${id} must name ${name}; it names ${JSON.stringify(declared)}`);
    }
    // Every declared name must exist in the suite it runs, or the campaign would
    // report a missing case for a control that is measuring correctly.
    const suiteSource = readFileSync(
      path.join(repoRoot, (control.tests[0] as string).replace("tests/dist/", "tests/").replace(/\.js$/, ".ts")),
      "utf8",
    );
    for (const name of declared) {
      assert.ok(suiteSource.includes(name), `${id} declares a case the suite does not define: ${name}`);
    }
  }
});

// -- bounded subprocess stages (review R-06) ---------------------------------

test("NC-TIMEOUT: a hanging stage is killed at the bound and reported as a timeout", () => {
  // Injected command and a 400 ms bound: the classification is what is under
  // test, not the production constants, so this costs well under a second.
  const started = Date.now();
  const run = harness.runStage({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: repoRoot,
    timeoutMs: 400,
    stage: "suite",
  });
  const wall = Date.now() - started;

  assert.equal(run.timedOut, true, "a stage that never returns must be reported as a timeout");
  assert.equal(run.stage, "suite");
  assert.ok(wall < 30_000, `the bound must actually stop it; took ${String(wall)} ms`);
  assert.equal(typeof run.elapsedMs, "number");
  // Null output on a killed child must reach the classifier as an unparseable
  // run — a harness error — and never as "nothing failed".
  assert.equal(typeof run.stdout, "string");
  const classified = harness.classifyTestRun({ stdout: run.stdout, expect: "fail", tests: ["x.test.js"] });
  assert.equal(classified.result, harness.CONTROL_RESULT["RUNNER_FAILED"]);
});

test("NC-TIMEOUT: a timeout is a harness error, never a kill and never an agreement", () => {
  const timedOut = harness.CONTROL_RESULT["STAGE_TIMED_OUT"] as string;
  assert.equal(harness.isHarnessError(timedOut), true);
  assert.equal(harness.agreesWithExpectation(timedOut, "fail"), false);
  assert.equal(harness.agreesWithExpectation(timedOut, "pass"), false);
});

test("NC-TIMEOUT: the killed child leaves no surviving process", () => {
  // `spawnSync` waits for and reaps the child it killed before returning, so by
  // the time `runStage` hands back a timeout there is nothing left to reap and
  // nothing left running. That is the property the abort path relies on when it
  // declines to patch the worktree again after a timeout.
  const run = harness.runStage({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: repoRoot,
    timeoutMs: 400,
    stage: "suite",
  });
  assert.equal(run.timedOut, true);
  const pid = run.pid;
  assert.equal(typeof pid, "number", "the stage must report the process it bounded");
  let alive: boolean;
  try {
    process.kill(pid as number, 0);
    alive = true;
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "a SIGKILLed stage must not survive its bound");
});

test("NC-TIMEOUT: a stage that cannot be spawned is reported, not silently empty", () => {
  const run = harness.runStage({
    command: path.join(repoRoot, "no-such-command-erl2"),
    args: [],
    cwd: repoRoot,
    timeoutMs: 5_000,
    stage: "build",
  });
  assert.equal(run.timedOut, false);
  assert.ok((run.spawnError ?? "").length > 0, "a spawn failure must be named");
  assert.equal(run.stdout, "", "null stdout is normalised, so no caller reads a property of null");
});

test("NC-TIMEOUT: the stage bounds are distinct, positive and above the slowest observed suite", () => {
  const { build, suite } = harness.STAGE_TIMEOUT_MS;
  assert.ok(build > 0 && suite > 0);
  assert.notEqual(build, suite, "the two stages differ by an order of magnitude; one number would unbound the build");
  // Measured on this checkout: build 11.5 s, the slowest designated suite
  // (`environmentEvidenceBoundaries`) 152.6 s. The bounds must stay generous
  // margins above those, and the suite bound must stay under the whole gate.
  assert.ok(build >= 60_000, "the build bound must leave room for a cold worktree");
  assert.ok(suite >= 10 * 60_000, "the suite bound must be a wide margin over 152.6 s, not a performance budget");
  assert.ok(suite <= 60 * 60_000, "a bound longer than a full campaign stage would not catch a hang");
  assert.ok(harness.STAGE_MAX_OUTPUT_BYTES >= 8 * 1024 * 1024, "1 MiB truncates a chatty suite's summary away");
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
