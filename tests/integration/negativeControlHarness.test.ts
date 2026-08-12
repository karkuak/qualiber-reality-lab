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
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureProcessIdentity,
  capturedProcessIsRunning,
  killCapturedProcess,
  parseProcessIdentity,
} from "../support/processIdentity.js";
import type { ProcessIdentity } from "../support/processIdentity.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const scriptsDir = path.join(repoRoot, "scripts");
const targetModulePath = path.join(scriptsDir, "lib", "controlTarget.mjs");
const worktreeModulePath = path.join(scriptsDir, "lib", "disposableWorktree.mjs");
/** The identity helper, reachable from the probe's own process by URL. */
const identityModulePath = pathToFileURL(path.join(here, "..", "support", "processIdentity.js")).href;

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
    readonly requiresPrerequisite?: string;
    readonly expect: string;
  }[];
  readonly CONTROL_RESULT: Record<string, string>;
  readonly classifyTestRun: (input: Record<string, unknown>) => {
    readonly result: string;
    readonly pass: number;
    readonly fail: number;
    readonly tests: number;
    readonly cancelled: number;
    readonly skipped: number;
    readonly detail?: string;
    readonly undeclaredSkips?: readonly string[];
    readonly declaredSkips?: readonly string[];
    readonly strayFiles?: readonly string[];
    readonly failingCases?: readonly string[];
    readonly missingCases?: readonly string[];
    readonly skippedCases?: readonly string[];
    readonly skippedDesignated?: readonly string[];
    readonly skipReasons?: readonly string[];
    readonly prerequisite?: string;
  };
  readonly parseFailingCases: (stdout: string) => readonly { readonly file: string; readonly name: string }[];
  readonly parseSkippedCases: (
    stdout: string,
  ) => readonly { readonly name: string; readonly reason: string }[];
  readonly agreesWithExpectation: (result: string, expect: string) => boolean;
  readonly isHarnessError: (result: string) => boolean;
  readonly isUnmeasured: (result: string) => boolean;
  readonly validateControlDeclarations: (controls: readonly unknown[]) => string[];
  readonly STAGE_TIMEOUT_MS: { readonly build: number; readonly suite: number };
  readonly STAGE_MAX_OUTPUT_BYTES: number;
  readonly STAGE_TREE_KILL_GRACE_MS: number;
  readonly runStage: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly stage: string;
  }) => Promise<{
    readonly stage: string;
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: boolean;
    readonly elapsedMs: number;
    readonly timedOut: boolean;
    readonly treeTerminationFailed: boolean;
    readonly stageTmp: string;
    readonly stageTmpRemoved: boolean;
    readonly pid?: number;
    readonly spawnError?: string;
  }>;
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
  `ℹ tests ${String(pass + fail)}\nℹ suites 0\nℹ pass ${String(pass)}\nℹ fail ${String(fail)}\n` +
  `ℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n`;

/**
 * Classify a run whose process ended consistently with the output it produced.
 *
 * `classifyTestRun` requires the stage's execution facts and fails closed without
 * them — that is the correction the independent review of `07da5fe` demanded, and
 * `NC-EXECUTION` below asserts it directly. Every other control here is about
 * *parsing and precedence*, so this helper supplies the uninteresting half: exit
 * 1 when the output says something failed, exit 0 when it does not, no signal, no
 * truncation. A test that cares about the process supplies its own `execution`
 * and this defaults out of the way.
 */
const classify = (input: Record<string, unknown>): ReturnType<typeof harness.classifyTestRun> => {
  if (input["execution"] !== undefined) return harness.classifyTestRun(input);
  const failed = /^ℹ fail (\d+)$/m.exec(String(input["stdout"] ?? ""))?.[1];
  return harness.classifyTestRun({
    ...input,
    execution: {
      status: failed === undefined || failed === "0" ? 0 : 1,
      signal: null,
      timedOut: false,
      truncated: false,
      treeTerminationFailed: false,
    },
  });
};

test("NC-CLASSIFY: a named suite failing is a behavioural kill", () => {
  const classified = classify({
    stdout: `${SUMMARY(3, 1)}\n✖ failing tests:\n\ntest at tests/dist/e2e/environmentRun.test.js:12:1\n`,
    expect: "fail",
    tests: ["tests/dist/e2e/environmentRun.test.js"],
  });
  assert.equal(classified.result, harness.CONTROL_RESULT["NAMED_TESTS_FAILED"]);
  assert.equal(harness.isHarnessError(classified.result), false);
  assert.equal(harness.agreesWithExpectation(classified.result, "fail"), true);
});

test("NC-CLASSIFY: a guard that kills nothing is a result, not an error", () => {
  const classified = classify({
    stdout: SUMMARY(4, 0),
    expect: "pass",
    tests: ["tests/dist/e2e/environmentRun.test.js"],
  });
  assert.equal(classified.result, harness.CONTROL_RESULT["NO_KILL_AS_DECLARED"]);
  assert.equal(harness.isHarnessError(classified.result), false);
  assert.equal(harness.agreesWithExpectation(classified.result, "pass"), true);
  // ...and the same run is a disagreement when a kill was expected.
  const expectedAKill = classify({
    stdout: SUMMARY(4, 0),
    expect: "fail",
    tests: ["tests/dist/e2e/environmentRun.test.js"],
  });
  assert.equal(expectedAKill.result, harness.CONTROL_RESULT["TESTS_PASSED_UNEXPECTEDLY"]);
  assert.equal(harness.agreesWithExpectation(expectedAKill.result, "fail"), false);
});

test("NC-CLASSIFY: a failure outside the declared suites is not the control's kill", () => {
  const classified = classify({
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
  const classified = classify({
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
    const run = await harness.runStage({
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
    const killed = classify({
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
  const classified = classify({
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
  const classified = classify({
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
  const classified = classify({
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
  const all = classify({
    stdout: FAILING(9, declared.map((name) => [SUITE, name] as const)),
    expect: "fail",
    tests: [SUITE],
    mustFail: [SUITE],
    mustFailCases: declared,
  });
  assert.equal(all.result, harness.CONTROL_RESULT["NAMED_TESTS_FAILED"]);
  assert.equal(harness.agreesWithExpectation(all.result, "fail"), true);

  const partial = classify({
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
  const classified = classify({
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
  const stray = classify({
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

test("NC-TIMEOUT: a hanging stage is killed at the bound and reported as a timeout", async () => {
  // Injected command and a 400 ms bound: the classification is what is under
  // test, not the production constants, so this costs well under a second.
  const started = Date.now();
  const run = await harness.runStage({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: repoRoot,
    timeoutMs: 400,
    stage: "suite",
  });
  const wall = Date.now() - started;

  assert.equal(run.timedOut, true, "a stage that never returns must be reported as a timeout");
  assert.equal(run.treeTerminationFailed, false, "a single hanging process must terminate cleanly");
  assert.equal(run.stage, "suite");
  assert.ok(wall < 30_000, `the bound must actually stop it; took ${String(wall)} ms`);
  assert.equal(typeof run.elapsedMs, "number");
  // Null output on a killed child must reach the classifier as an unparseable
  // run — a harness error — and never as "nothing failed".
  assert.equal(typeof run.stdout, "string");
  const classified = classify({ stdout: run.stdout, expect: "fail", tests: ["x.test.js"] });
  assert.equal(classified.result, harness.CONTROL_RESULT["RUNNER_FAILED"]);
});

test("NC-TIMEOUT: a timeout is a harness error, never a kill and never an agreement", () => {
  for (const key of ["STAGE_TIMED_OUT", "TREE_TERMINATION_FAILED"]) {
    const result = harness.CONTROL_RESULT[key] as string;
    assert.equal(harness.isHarnessError(result), true, `${key} must be a harness error`);
    assert.equal(harness.agreesWithExpectation(result, "fail"), false);
    assert.equal(harness.agreesWithExpectation(result, "pass"), false);
  }
});

/** What the probe records about one of its two processes, before either dies. */
interface RecordedProcess {
  readonly pid: number;
  /** `null` when `ps` never established one, which fails the test rather than weakening it. */
  readonly identity: ProcessIdentity | null;
}

interface RecordedProbe {
  readonly parent: RecordedProcess;
  readonly grandchild: RecordedProcess;
}

/** The bare-pid predicate this test used to assert on. Kept only to prove it is wrong. */
function barePidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// -- the identity the process-tree assertions rest on -------------------------
//
// `NC-PROCTREE` concludes that two specific processes are gone. Everything it
// concludes depends on "gone" meaning *the captured process*, not the small
// recycled integer it used to hold — so the comparison is measured here rather
// than trusted. These cases are also where the two controls live: that the
// bare-pid comparison this replaced really is fooled by a reused pid, and that a
// genuine survivor is still reported alive.

interface Sleeper {
  readonly pid: number;
  readonly identity: ProcessIdentity;
  readonly child: ReturnType<typeof spawn>;
  readonly stop: () => void;
}

/** A real live process, with its identity captured while it is certainly alive. */
function sleeper(): Sleeper {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) assert.fail("the sleeper process was not spawned");
  let identity: ProcessIdentity | undefined;
  // `ps` can lag a just-forked pid by a scheduling quantum. Bounded, and a
  // failure to establish identity fails the test rather than skipping it.
  for (let attempt = 0; attempt < 100 && identity === undefined; attempt += 1) {
    identity = captureProcessIdentity(pid);
    if (identity === undefined) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (identity === undefined) assert.fail(`ps never reported the just-spawned process ${String(pid)}`);
  return {
    pid,
    identity,
    child,
    stop: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone, which is the expected case once a test has killed it.
      }
    },
  };
}

test("NC-PROCIDENTITY: a running process matches the identity captured from it", () => {
  const live = sleeper();
  try {
    assert.equal(capturedProcessIsRunning(live.identity), true, "a live process must match its own capture");

    // This process too, which is beyond doubt running.
    const own = captureProcessIdentity(process.pid);
    if (own === undefined) assert.fail("ps must report the process asking the question");
    assert.equal(own.pid, process.pid);
    assert.match(own.startedAt, /^\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/, own.startedAt);
    assert.ok(own.command.length > 0, "an identity with no command is not an identity");
    assert.equal(capturedProcessIsRunning(own), true);
  } finally {
    live.stop();
  }
});

test("NC-PROCIDENTITY: an exited process and a pid ps refuses are both absent", async () => {
  const live = sleeper();
  assert.equal(capturedProcessIsRunning(live.identity), true, "the fixture must start alive");
  live.stop();
  await once(live.child, "exit");

  // True whether the number was left free or immediately reused, which is what
  // makes this deterministic where a bare-pid check is not.
  assert.equal(
    capturedProcessIsRunning(live.identity),
    false,
    "a process that exited must never be reported as still running",
  );
  // `ps` refusing outright is the same answer, not a different one.
  assert.equal(captureProcessIdentity(-1), undefined, "a pid ps refuses must establish no identity");
});

test("NC-PROCIDENTITY: the same pid with a different start is not the captured process", () => {
  const live = sleeper();
  try {
    const stale: ProcessIdentity = { ...live.identity, startedAt: "Mon Jan 1 00:00:00 2001" };
    assert.notEqual(stale.startedAt, live.identity.startedAt, "the fixture must actually differ");
    // The pid really is held — so this is a mismatch, not an absence.
    assert.equal(barePidIsAlive(stale.pid), true);
    assert.equal(capturedProcessIsRunning(stale), false, "a different start instant is a different process");
  } finally {
    live.stop();
  }
});

test("NC-PROCIDENTITY: the same pid with a different command is not the captured process", () => {
  const live = sleeper();
  try {
    const other: ProcessIdentity = { ...live.identity, command: `${live.identity.command} --not-this-one` };
    assert.notEqual(other.command, live.identity.command, "the fixture must actually differ");
    assert.equal(barePidIsAlive(other.pid), true);
    assert.equal(capturedProcessIsRunning(other), false, "a different command is a different process");
  } finally {
    live.stop();
  }
});

test("NC-PROCIDENTITY: malformed or empty ps output establishes no identity", () => {
  // Fail closed: every way of not establishing identity answers "not running",
  // because the alternative is signalling or asserting about someone else.
  for (const raw of [
    undefined,
    "",
    "   ",
    "\n\n",
    "garbage",
    "Wed Aug  5 08:49:30 2026" /* an lstart with no command */,
    "a b c d e" /* five tokens, nothing more */,
    "Wed Aug  5 08:49:30 2026 node\nWed Aug  5 08:49:31 2026 node" /* two answers to one question */,
  ]) {
    assert.equal(
      parseProcessIdentity(4242, raw),
      undefined,
      `this must not parse: ${JSON.stringify(raw)}`,
    );
  }

  // …and a well-formed line still parses, or every case above is satisfied by a
  // parser that simply always refuses.
  assert.deepEqual(parseProcessIdentity(4242, "Wed Aug  5 08:49:30 2026 /usr/bin/node -e x\n"), {
    pid: 4242,
    startedAt: "Wed Aug 5 08:49:30 2026",
    command: "/usr/bin/node -e x",
  });
});

test("NC-PROCIDENTITY: a reused pid is not the captured process, and cleanup will not signal it", () => {
  const live = sleeper();
  try {
    // A simulated pid reuse: the recorded identity names a process that has
    // died, and the number is now held by an unrelated live process. This is
    // the exact shape that turned a correctly terminated process tree into a
    // red publication gate.
    const reused: ProcessIdentity = { ...live.identity, command: `${live.identity.command} --a-different-process` };

    // THE CONTROL. Reverting to the bare-pid comparison this replaced answers
    // "alive" here — so the assertion `alive(pid) === false` that NC-PROCTREE
    // used to make fails on a process that died exactly as intended. If this
    // ever stops holding, the identity comparison has stopped being
    // load-bearing and the case below proves nothing.
    assert.equal(
      barePidIsAlive(reused.pid),
      true,
      "the bare-pid check must be fooled here, or this control is vacuous",
    );
    assert.equal(capturedProcessIsRunning(reused), false, "identity must not be fooled by a reused pid");

    // …and cleanup must refuse to signal it. A `finally` block SIGKILLing a
    // stranger is the least observable bug this file could ship.
    assert.equal(killCapturedProcess(reused), "gone");
    assert.equal(
      capturedProcessIsRunning(live.identity),
      true,
      "cleanup killed a process whose identity it could not confirm",
    );

    // THE OTHER HALF. A genuine survivor — same pid, same start, same command —
    // is still reported alive and is still the thing cleanup kills. Without
    // this, "never signals" would be satisfied by never signalling at all.
    assert.equal(killCapturedProcess(live.identity), "signalled");
  } finally {
    live.stop();
  }
});

test("NC-PROCTREE: a timed-out stage kills its grandchild, not only its direct child", async () => {
  // The property the previous test did *not* have. `spawnSync(… killSignal)`
  // kills and reaps exactly one process, and both real stages spawn
  // descendants: `npm run build` spawns node, and `node --test` spawns one
  // process per test file. Asserting `run.pid` is dead was true and beside the
  // point.
  //
  // Both processes are recorded to disk *before* the parent starts waiting, so
  // the proof survives the SIGKILL that removes every chance to report them.
  //
  // What is recorded is an *identity*, not a number. A pid is recycled — macOS
  // wraps at 99999 and a full gate spawns thousands of processes — so asking
  // `kill(grandchildPid, 0)` asks whether *anyone* holds that number, not
  // whether the grandchild survived. That is a weaker question than the one the
  // production harness answers (it reconciles on the process *group*), and it
  // is why this test failed intermittently on a correctly terminated tree.
  //
  // The probe is a file rather than `node -e`, because the recorded command is
  // half of the identity: a multi-line `-e` source appears as one line in macOS
  // `ps` and as several in Linux `ps`, and an identity that parses on one
  // platform and not the other is not an identity.
  const probe = mkdtempSync(path.join(tmpdir(), "erl2-tree-probe-"));
  const pidFile = path.join(probe, "pids.json");
  const probeScript = path.join(probe, "probe.mjs");
  writeFileSync(
    probeScript,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `import { captureProcessIdentity } from ${JSON.stringify(identityModulePath)};`,
      'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      // `ps` can lag a just-forked pid by a scheduling quantum, so the capture
      // is retried — bounded, and never degrading to "close enough". A capture
      // that does not succeed is recorded as `null` and fails the test.
      "const identify = (pid) => {",
      "  for (let attempt = 0; attempt < 100; attempt += 1) {",
      "    const identity = captureProcessIdentity(pid);",
      "    if (identity !== undefined) return identity;",
      "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);",
      "  }",
      "  return null;",
      "};",
      // Captured while both are certainly alive: this process is executing the
      // line, and the grandchild has a 1 s interval holding it open.
      "const recorded = {",
      "  parent: { pid: process.pid, identity: identify(process.pid) },",
      "  grandchild: { pid: grandchild.pid, identity: identify(grandchild.pid) },",
      "};",
      `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(recorded));`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );

  let recorded: RecordedProbe | undefined;
  try {
    const run = await harness.runStage({
      command: process.execPath,
      args: [probeScript],
      cwd: probe,
      timeoutMs: 1_500,
      stage: "suite",
    });
    assert.equal(run.timedOut, true);
    // Unchanged, and still the load-bearing production assertion: the harness
    // itself proved the spawned process *group* was empty. Identity below
    // narrows what "empty" is allowed to mean; it does not replace this.
    assert.equal(run.treeTerminationFailed, false, "the group must be terminable inside its grace window");

    recorded = JSON.parse(readFileSync(pidFile, "utf8")) as RecordedProbe;
    assert.equal(typeof recorded.grandchild.pid, "number", "the probe must have recorded a grandchild");
    assert.notEqual(recorded.grandchild.pid, recorded.parent.pid);
    assert.equal(recorded.parent.pid, run.pid, "the stage's own pid must be the parent it spawned");

    const parentIdentity = recorded.parent.identity;
    const grandchildIdentity = recorded.grandchild.identity;
    // Both identities had to be established while the processes were alive, or
    // the assertions below compare against nothing and pass vacuously.
    if (parentIdentity === null || grandchildIdentity === null) {
      assert.fail(
        "the probe must capture both identities while both are alive; got " +
          `parent=${JSON.stringify(parentIdentity)} grandchild=${JSON.stringify(grandchildIdentity)}`,
      );
    }
    for (const [name, identity] of [
      ["parent", parentIdentity],
      ["grandchild", grandchildIdentity],
    ] as const) {
      assert.match(
        identity.startedAt,
        /^\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/,
        `the ${name}'s recorded start is not an lstart instant: ${identity.startedAt}`,
      );
      assert.ok(identity.command.length > 0, `the ${name}'s recorded command is empty`);
    }

    // "Dead" means the process we started is gone — not that nobody holds its
    // number. A pid inherited by one of the thousands of processes a full gate
    // spawns answers the second question wrongly and the first one correctly.
    assert.equal(capturedProcessIsRunning(parentIdentity), false, "the direct child must be dead");
    assert.equal(
      capturedProcessIsRunning(grandchildIdentity),
      false,
      "the grandchild must be dead too — this is the whole finding",
    );

    // The stage owns its own TMPDIR and removes it once the tree is proven
    // dead, so a timed-out stage leaves nothing behind either.
    assert.equal(run.stageTmpRemoved, true, "the stage-owned temporary root must be gone");
    assert.equal(existsSync(run.stageTmp as string), false, `${String(run.stageTmp)} must not exist`);
  } finally {
    // Bounded on every failure path: if an assertion above threw, anything the
    // probe left running is killed here rather than inherited by the suite.
    //
    // Never to a bare recorded number. `killCapturedProcess` re-reads the pid's
    // current identity and signals only a match, so a recycled pid is reported
    // `gone` instead of being SIGKILLed — a stranger being killed from a
    // `finally` block on a failure path is the least observable bug available.
    if (recorded !== undefined) {
      for (const entry of [recorded.grandchild, recorded.parent]) {
        if (entry.identity !== null) killCapturedProcess(entry.identity);
      }
    }
    rmSync(probe, { recursive: true, force: true });
  }
});

test("NC-PROCTREE: a stage that completes normally still leaves no descendant and no temporary root", async () => {
  const run = await harness.runStage({
    command: process.execPath,
    args: ["-e", "process.stdout.write('done')"],
    cwd: repoRoot,
    timeoutMs: 30_000,
    stage: "build",
  });
  assert.equal(run.timedOut, false);
  assert.equal(run.treeTerminationFailed, false);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "done");
  assert.equal(run.stageTmpRemoved, true);
  assert.equal(existsSync(run.stageTmp as string), false);
});

test("NC-TIMEOUT: a stage that cannot be spawned is reported, not silently empty", async () => {
  const run = await harness.runStage({
    command: path.join(repoRoot, "no-such-command-erl2"),
    args: [],
    cwd: repoRoot,
    timeoutMs: 5_000,
    stage: "build",
  });
  assert.equal(run.timedOut, false);
  assert.ok((run.spawnError ?? "").length > 0, "a spawn failure must be named");
  assert.equal(run.stdout, "", "null stdout is normalised, so no caller reads a property of null");
  assert.equal(run.stageTmpRemoved, true, "a stage that never ran still cleans its temporary root");
});

test("NC-TIMEOUT: the stage bounds are distinct, positive and above the slowest observed suite", () => {
  const { build, suite } = harness.STAGE_TIMEOUT_MS;
  assert.ok(build > 0 && suite > 0);
  assert.notEqual(build, suite, "the two stages differ by an order of magnitude; one number would unbound the build");
  // Measured across two full campaigns: build max 50.5 s, suite max 1,280.1 s
  // (`environment-bundle-verifier`, two heavy e2e files in one stage). The
  // bounds must stay generous margins above those — a bound a slower CI runner
  // trips turns a healthy campaign into an abort — and must stay small enough
  // that a hang is still bounded in hours rather than days.
  assert.ok(build >= 2 * 60_000, "the build bound must be a wide margin over 50.5 s");
  assert.ok(suite >= 30 * 60_000, "the suite bound must be a wide margin over 1,280.1 s, not a performance budget");
  assert.ok(suite <= 90 * 60_000, "a bound this long stops catching a hang in useful time");
  assert.ok(harness.STAGE_MAX_OUTPUT_BYTES >= 8 * 1024 * 1024, "1 MiB truncates a chatty suite's summary away");
  assert.ok(harness.STAGE_TREE_KILL_GRACE_MS > 0, "the group reconciliation must be bounded");
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

// -- skipped cases, and the third column they need ---------------------------
//
// The defect the independent review of `90a0039` proved: `classifyTestRun` read
// `tests`, `pass`, `fail` and `cancelled`, and never `skipped`. When the case a
// control designates skips itself, the other cases in its file still pass, so
// `fail === 0` was reached and — for a control expecting a kill — recorded as
// `tests_passed_unexpectedly`. That is a disagreement manufactured out of a
// measurement that never happened, and it short-circuited *above* the
// `mustFailCases` check written to catch exactly "the declared case did not
// fail".
//
// A skip is neither a result nor a fault. It needs its own column, and which
// column it lands in depends on whether anybody declared it might happen.

/** A spec-reporter summary with an explicit skipped count. */
const SUMMARY_WITH_SKIPS = (pass: number, fail: number, skipped: number): string =>
  `ℹ tests ${String(pass + fail + skipped)}\nℹ suites 0\nℹ pass ${String(pass)}\n` +
  `ℹ fail ${String(fail)}\nℹ cancelled 0\nℹ skipped ${String(skipped)}\nℹ todo 0\n`;

/** The exact line `node --test --test-reporter=spec` prints for a skipped case. */
const skipLine = (name: string, reason: string): string => `﹣ ${name} (0.06ms) # ${reason}`;

/** The two lines the reporter prints for a failing case in its trailing section. */
const failBlock = (file: string, name: string): string =>
  `\n✖ failing tests:\n\ntest at ${file}:12:1\n✖ ${name} (88.6ms)\n`;

const RENDERED = "COMPOSE-ADV: the RENDERED configuration publishes one loopback port and nothing else";
const RENDER_SKIP_REASON =
  "RENDERED TOPOLOGY UNPROVEN: the extracted upstream configuration is absent";
const COMPOSE_SUITE = "tests/dist/adversarial/composeSubstrate.test.js";
const DEADLINE_SUITE = "tests/dist/adversarial/containerDeadlineEnforcement.test.js";
const DEADLINE_CASES = [
  "CONTAINER-DEADLINE: a subject that ignores every signal is bounded by its deadline",
  "CONTAINER-DEADLINE: termination is observed — the whole pid namespace, keyed on container id",
];

test("NC-SKIP: the reporter's skip lines are read, with their reasons", () => {
  const parsed = harness.parseSkippedCases(
    `✔ ALPHA: ran (1ms)\n${skipLine(RENDERED, RENDER_SKIP_REASON)}\n${skipLine("BETA: no reason given", "")}\n`,
  );
  assert.deepEqual(
    parsed.map((c) => c.name),
    [RENDERED, "BETA: no reason given"],
  );
  assert.equal(parsed[0]?.reason, RENDER_SKIP_REASON);
  // A pass line is not a skip line, and must not be read as one.
  assert.equal(parsed.some((c) => c.name.startsWith("ALPHA")), false);
});

interface ClassifyCase {
  readonly name: string;
  readonly stdout: string;
  readonly expect: string;
  readonly tests: readonly string[];
  readonly mustFail?: readonly string[];
  readonly mustFailCases?: readonly string[];
  readonly prerequisite?: string;
  readonly expectedSkips?: readonly { readonly case: string; readonly reason: string }[];
  /** The stage's execution facts, when the row is about the process rather than its output. */
  readonly execution?: Record<string, unknown>;
  readonly result: string;
  /** `true` agreement, `false` disagreement, `null` neither — the third column. */
  readonly agrees: boolean | null;
  readonly harnessError: boolean;
  readonly unmeasured: boolean;
  /** Counts and names the row asserts survive into the result, whatever it is. */
  readonly retains?: Record<string, unknown>;
}

const CLASSIFY_TABLE: readonly ClassifyCase[] = [
  {
    name: "the designated case really failed — a kill, and an agreement",
    stdout: `✖ ${RENDERED} (88.6ms)\n${SUMMARY_WITH_SKIPS(28, 1, 0)}${failBlock(COMPOSE_SUITE, RENDERED)}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    prerequisite: "otel-demo-upstream",
    result: "named_tests_failed",
    agrees: true,
    harnessError: false,
    unmeasured: false,
  },
  {
    name: "everything passed and nothing skipped — a real unexpected pass, still a disagreement",
    stdout: SUMMARY_WITH_SKIPS(29, 0, 0),
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    prerequisite: "otel-demo-upstream",
    result: "tests_passed_unexpectedly",
    agrees: false,
    harnessError: false,
    unmeasured: false,
  },
  {
    name: "the exact recorded defect: 28 pass, 0 fail, designated case skipped, prerequisite declared",
    stdout: `${skipLine(RENDERED, RENDER_SKIP_REASON)}\n${SUMMARY_WITH_SKIPS(28, 0, 1)}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    prerequisite: "otel-demo-upstream",
    result: "unmeasured_here",
    agrees: null,
    harnessError: false,
    unmeasured: true,
  },
  {
    name: "the same run with no prerequisite declared stays fail-closed as a harness error",
    stdout: `${skipLine(RENDERED, RENDER_SKIP_REASON)}\n${SUMMARY_WITH_SKIPS(28, 0, 1)}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    result: "designated_case_skipped",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "a cancelled run is a crash, not a skip, even when something also skipped",
    stdout:
      `${skipLine(RENDERED, RENDER_SKIP_REASON)}\n` +
      "ℹ tests 29\nℹ suites 0\nℹ pass 0\nℹ fail 0\nℹ cancelled 28\nℹ skipped 1\n",
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    prerequisite: "otel-demo-upstream",
    result: "test_runner_failed",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "a harness crash with no parseable summary is never `nothing failed`",
    stdout: "SyntaxError: Unexpected token\n",
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    prerequisite: "otel-demo-upstream",
    result: "test_runner_failed",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "truncated output that lost its summary is a harness error, declared prerequisite or not",
    stdout: `${skipLine(RENDERED, RENDER_SKIP_REASON)}\nℹ tests 29\nℹ suites 0\n`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    prerequisite: "otel-demo-upstream",
    result: "test_runner_failed",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    // Both of the rows below used to assert the opposite, and the independent
    // review of `07da5fe` named them: they "deliberately assert that unrelated
    // skips still produce a measured kill without requiring the skip to remain
    // visible". That is the hole. A designated case failing says the guard is
    // load-bearing; it says nothing whatsoever about two neighbouring cases that
    // disappeared in the same run, and a campaign that scores the row as a clean
    // agreement has quietly answered a question it never asked.
    name: "an intended failure does not excuse two undeclared skips beside it",
    stdout:
      `${skipLine("COMPOSE-ADV: some docker-gated case", "no daemon")}\n` +
      `${skipLine("COMPOSE-ADV: another docker-gated case", "no daemon")}\n` +
      `✖ ${RENDERED} (88.6ms)\n${SUMMARY_WITH_SKIPS(26, 1, 2)}${failBlock(COMPOSE_SUITE, RENDERED)}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    prerequisite: "otel-demo-upstream",
    result: "unexpected_case_skipped",
    agrees: false,
    harnessError: true,
    unmeasured: false,
    retains: {
      skipped: 2,
      undeclaredSkips: ["COMPOSE-ADV: some docker-gated case", "COMPOSE-ADV: another docker-gated case"],
    },
  },
  {
    name: "one undeclared skip beside an intended failure is enough to fail closed",
    stdout:
      `${skipLine("COMPOSE-ADV: some docker-gated case", "no daemon")}\n` +
      `✖ ${RENDERED} (88.6ms)\n${SUMMARY_WITH_SKIPS(27, 1, 1)}${failBlock(COMPOSE_SUITE, RENDERED)}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    prerequisite: "otel-demo-upstream",
    result: "unexpected_case_skipped",
    agrees: false,
    harnessError: true,
    unmeasured: false,
    retains: { skipped: 1, undeclaredSkips: ["COMPOSE-ADV: some docker-gated case"] },
  },
  {
    // …and the way through: declare it. The three controls that run
    // `composeSubstrate.test.js` before the fixture is provisioned do exactly
    // this, so the skip is published on the row rather than absent from it.
    name: "a declared skip beside an intended failure is an agreement that still shows the skip",
    stdout:
      `${skipLine(RENDERED, RENDER_SKIP_REASON)}\n` +
      `✖ COMPOSE-ADV: an expected container name is refused (8.6ms)\n${SUMMARY_WITH_SKIPS(27, 1, 1)}` +
      `${failBlock(COMPOSE_SUITE, "COMPOSE-ADV: an expected container name is refused")}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: ["COMPOSE-ADV: an expected container name is refused"],
    expectedSkips: [{ case: RENDERED, reason: "RENDERED TOPOLOGY UNPROVEN" }],
    result: "named_tests_failed",
    agrees: true,
    harnessError: false,
    unmeasured: false,
    retains: { skipped: 1, skippedCases: [RENDERED], declaredSkips: [RENDERED] },
  },
  {
    name: "a declaration whose reason no longer matches stops excusing the skip",
    stdout:
      `${skipLine(RENDERED, "someone commented it out")}\n` +
      `✖ COMPOSE-ADV: an expected container name is refused (8.6ms)\n${SUMMARY_WITH_SKIPS(27, 1, 1)}` +
      `${failBlock(COMPOSE_SUITE, "COMPOSE-ADV: an expected container name is refused")}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: ["COMPOSE-ADV: an expected container name is refused"],
    expectedSkips: [{ case: RENDERED, reason: "RENDERED TOPOLOGY UNPROVEN" }],
    result: "unexpected_case_skipped",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "an expected-pass control with an unexpected skip is a harness error, not a clean pass",
    stdout: `${skipLine("SOME: unrelated case", "host is odd")}\n${SUMMARY_WITH_SKIPS(1, 0, 1)}`,
    expect: "pass",
    tests: [COMPOSE_SUITE],
    result: "unexpected_case_skipped",
    agrees: false,
    harnessError: true,
    unmeasured: false,
    retains: { skipped: 1, skipReasons: ["host is odd"] },
  },
  {
    name: "a designated skip whose reason does not name what the prerequisite stands for",
    stdout: `${skipLine(RENDERED, "someone commented it out")}\n${SUMMARY_WITH_SKIPS(28, 0, 1)}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    prerequisite: "otel-demo-upstream",
    result: "designated_case_skipped",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "impossible accounting: the counters do not sum to the total",
    stdout: "ℹ tests 2\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\n",
    expect: "fail",
    tests: [COMPOSE_SUITE],
    result: "impossible_test_accounting",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "a negative counter is not a count",
    stdout: "ℹ tests 5\nℹ suites 0\nℹ pass 6\nℹ fail -1\nℹ cancelled 0\nℹ skipped 0\n",
    expect: "fail",
    tests: [COMPOSE_SUITE],
    result: "impossible_test_accounting",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "a missing summary counter fails closed rather than defaulting to zero",
    stdout: "ℹ tests 6\nℹ suites 0\nℹ pass 6\nℹ fail 0\nℹ cancelled 0\n",
    expect: "pass",
    tests: [COMPOSE_SUITE],
    result: "test_runner_failed",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "the same case reported as both failed and skipped is impossible, not a kill",
    stdout:
      `${skipLine(RENDERED, RENDER_SKIP_REASON)}\n${SUMMARY_WITH_SKIPS(27, 1, 1)}` +
      `${failBlock(COMPOSE_SUITE, RENDERED)}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    result: "impossible_test_accounting",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "the reporter naming one failing case twice is impossible, not two kills",
    stdout:
      `${SUMMARY_WITH_SKIPS(4, 2, 0)}\n✖ failing tests:\n\ntest at ${COMPOSE_SUITE}:12:1\n` +
      `✖ ${RENDERED} (8.6ms)\ntest at ${COMPOSE_SUITE}:12:1\n✖ ${RENDERED} (8.6ms)\n`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    result: "impossible_test_accounting",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    // The review's sharpest case: the tail parses perfectly, and it is a tail of
    // a run that was cut. Annotating an otherwise-agreeing result with
    // `outputTruncated: true` — which is what the harness used to do — leaves the
    // agreement standing.
    name: "truncated output with an otherwise valid tail is a harness error, not an annotated kill",
    stdout: `${SUMMARY_WITH_SKIPS(27, 1, 0)}${failBlock(COMPOSE_SUITE, RENDERED)}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    execution: { status: 1, signal: null, timedOut: false, truncated: true, treeTerminationFailed: false },
    result: "output_truncated",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "an abnormal exit is not hidden by a parseable tail",
    stdout: `${SUMMARY_WITH_SKIPS(27, 1, 0)}${failBlock(COMPOSE_SUITE, RENDERED)}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    execution: { status: 137, signal: null, timedOut: false, truncated: false, treeTerminationFailed: false },
    result: "stage_terminated_abnormally",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "a run whose exit status disagrees with its own counters is abnormal",
    stdout: SUMMARY_WITH_SKIPS(6, 0, 0),
    expect: "pass",
    tests: [COMPOSE_SUITE],
    execution: { status: 1, signal: null, timedOut: false, truncated: false, treeTerminationFailed: false },
    result: "stage_terminated_abnormally",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "signal termination is a harness error even with a complete summary",
    stdout: `${SUMMARY_WITH_SKIPS(27, 1, 0)}${failBlock(COMPOSE_SUITE, RENDERED)}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    execution: { status: null, signal: "SIGKILL", timedOut: false, truncated: false, treeTerminationFailed: false },
    result: "stage_terminated_abnormally",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "a stage stopped by its bound is a timeout, whatever its output says",
    stdout: `${SUMMARY_WITH_SKIPS(27, 1, 0)}${failBlock(COMPOSE_SUITE, RENDERED)}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    execution: { status: null, signal: null, timedOut: true, truncated: false, treeTerminationFailed: false },
    result: "stage_timed_out",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "a stage whose process group outlived its kill is a harness error",
    stdout: SUMMARY_WITH_SKIPS(6, 0, 0),
    expect: "pass",
    tests: [COMPOSE_SUITE],
    execution: { status: 0, signal: null, timedOut: false, truncated: false, treeTerminationFailed: true },
    result: "stage_tree_termination_failed",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "a stage that could not be spawned is a harness error",
    stdout: "",
    expect: "fail",
    tests: [COMPOSE_SUITE],
    execution: { status: null, signal: null, spawnError: "ENOENT: node is not on PATH" },
    result: "test_runner_failed",
    agrees: false,
    harnessError: true,
    unmeasured: false,
  },
  {
    name: "container-deadline on a host with a daemon: both declared cases fail, agreement",
    stdout:
      `✖ ${DEADLINE_CASES[0] as string} (4001ms)\n✖ ${DEADLINE_CASES[1] as string} (4002ms)\n` +
      `${SUMMARY_WITH_SKIPS(3, 2, 0)}\n✖ failing tests:\n\ntest at ${DEADLINE_SUITE}:12:1\n` +
      `✖ ${DEADLINE_CASES[0] as string} (4001ms)\ntest at ${DEADLINE_SUITE}:40:1\n` +
      `✖ ${DEADLINE_CASES[1] as string} (4002ms)\n`,
    expect: "fail",
    tests: [DEADLINE_SUITE],
    mustFail: [DEADLINE_SUITE],
    mustFailCases: DEADLINE_CASES,
    prerequisite: "docker-daemon",
    result: "named_tests_failed",
    agrees: true,
    harnessError: false,
    unmeasured: false,
  },
  {
    name: "container-deadline on a host without one: the note's UNMEASURED HERE, now machine-said",
    stdout:
      `${skipLine(DEADLINE_CASES[0] as string, "LIVE CONTAINER UNPROVEN: no container daemon")}\n` +
      `${skipLine(DEADLINE_CASES[1] as string, "LIVE CONTAINER UNPROVEN: no container daemon")}\n` +
      `${SUMMARY_WITH_SKIPS(3, 0, 2)}`,
    expect: "fail",
    tests: [DEADLINE_SUITE],
    mustFail: [DEADLINE_SUITE],
    mustFailCases: DEADLINE_CASES,
    prerequisite: "docker-daemon",
    result: "unmeasured_here",
    agrees: null,
    harnessError: false,
    unmeasured: true,
  },
  {
    // This row used to be `unmeasured_here`: a control naming no case, expecting
    // a kill, that skipped something was given the benefit of the doubt because
    // the skip *might* have been the kill that never ran. It might equally not
    // have been. Declaring a prerequisite is not a licence to reinterpret any
    // disappearance in the file as that prerequisite's fault, and `unmeasured` is
    // the one column that is neither agreement nor failure — so it has to be the
    // hardest to reach, not the easiest.
    name: "a prerequisite does not excuse a skip the control never designated",
    stdout: `${skipLine("SOME: gated case", "unavailable here")}\n${SUMMARY_WITH_SKIPS(4, 0, 1)}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    prerequisite: "otel-demo-upstream",
    result: "unexpected_case_skipped",
    agrees: false,
    harnessError: true,
    unmeasured: false,
    retains: { skipped: 1, skippedCases: ["SOME: gated case"], undeclaredSkips: ["SOME: gated case"] },
  },
  {
    name: "a control that declared no kill and skipped nothing is unaffected",
    stdout: SUMMARY_WITH_SKIPS(4, 0, 0),
    expect: "pass",
    tests: [COMPOSE_SUITE],
    result: "no_kill_as_declared",
    agrees: true,
    harnessError: false,
    unmeasured: false,
  },
];

for (const row of CLASSIFY_TABLE) {
  test(`NC-CLASSIFY-SKIP: ${row.name}`, () => {
    const classified = classify({
      stdout: row.stdout,
      expect: row.expect,
      tests: row.tests,
      ...(row.mustFail === undefined ? {} : { mustFail: row.mustFail }),
      ...(row.mustFailCases === undefined ? {} : { mustFailCases: row.mustFailCases }),
      ...(row.prerequisite === undefined ? {} : { prerequisite: row.prerequisite }),
      ...(row.expectedSkips === undefined ? {} : { expectedSkips: row.expectedSkips }),
      ...(row.execution === undefined ? {} : { execution: row.execution }),
    });
    assert.equal(classified.result, row.result, `classified as ${classified.result}`);
    // Whatever the row concluded, the observation it concluded it from stays in
    // the result. A record that drops its counters on the way to an agreement
    // cannot afterwards be asked what it agreed in spite of.
    for (const [field, expected] of Object.entries(row.retains ?? {})) {
      assert.deepEqual(
        (classified as unknown as Record<string, unknown>)[field],
        expected,
        `${field} was not retained in the result`,
      );
    }
    assert.equal(harness.isHarnessError(classified.result), row.harnessError);
    assert.equal(harness.isUnmeasured(classified.result), row.unmeasured);
    // The three columns are exclusive: an unmeasured control is neither an
    // agreement nor a fault, and the campaign records `agreed: null` for it.
    const agreed = harness.isUnmeasured(classified.result)
      ? null
      : harness.agreesWithExpectation(classified.result, row.expect);
    assert.equal(agreed, row.agrees);
    assert.equal(
      harness.isUnmeasured(classified.result) && harness.isHarnessError(classified.result),
      false,
      "a result cannot be both unmeasured and a harness error",
    );
  });
}

test("NC-EXECUTION: classification without the stage's execution facts fails closed", () => {
  // The default has to be refusal rather than optimism. If omitting the facts
  // produced a classification, then every future caller that forgot to pass them
  // would get a measurement it had not earned — which is precisely how output
  // truncation came to be an annotation on an agreement rather than a reason to
  // withhold one.
  const complete = `${SUMMARY_WITH_SKIPS(27, 1, 0)}${failBlock(COMPOSE_SUITE, RENDERED)}`;
  for (const execution of [undefined, null, "clean", 0]) {
    const classified = harness.classifyTestRun({
      stdout: complete,
      expect: "fail",
      tests: [COMPOSE_SUITE],
      mustFail: [COMPOSE_SUITE],
      mustFailCases: [RENDERED],
      ...(execution === undefined ? {} : { execution }),
    });
    assert.equal(
      classified.result,
      harness.CONTROL_RESULT["EXECUTION_FACTS_MISSING"],
      `execution=${JSON.stringify(execution)} produced ${classified.result}`,
    );
    assert.equal(harness.isHarnessError(classified.result), true);
    assert.equal(harness.agreesWithExpectation(classified.result, "fail"), false);
  }
});

test("NC-EXECUTION: every result carries the counters it was read from", () => {
  // Including the agreeing ones. The review's finding was that a skip could be
  // omitted from the record entirely, so a reader could not distinguish an
  // agreement with a hidden skip from one without.
  const classified = classify({
    stdout: `${SUMMARY_WITH_SKIPS(27, 1, 0)}${failBlock(COMPOSE_SUITE, RENDERED)}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFail: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
  });
  assert.equal(classified.result, harness.CONTROL_RESULT["NAMED_TESTS_FAILED"]);
  for (const counter of ["tests", "pass", "fail", "cancelled", "skipped"] as const) {
    assert.equal(
      typeof (classified as unknown as Record<string, unknown>)[counter],
      "number",
      `an agreeing result dropped its ${counter} counter`,
    );
  }
  assert.equal(classified.tests, 28);
  assert.equal(classified.tests, classified.pass + classified.fail + classified.skipped + classified.cancelled);
});

test("NC-CLASSIFY-SKIP: a skipped designated case is never an agreement, under any declaration", () => {
  // The single property the whole correction exists to guarantee. Whatever else
  // changes, a case that did not run must never be reported as a guard proven
  // load-bearing here.
  for (const prerequisite of [undefined, "otel-demo-upstream", "docker-daemon"]) {
    const classified = classify({
      stdout: `${skipLine(RENDERED, RENDER_SKIP_REASON)}\n${SUMMARY_WITH_SKIPS(28, 0, 1)}`,
      expect: "fail",
      tests: [COMPOSE_SUITE],
      mustFailCases: [RENDERED],
      ...(prerequisite === undefined ? {} : { prerequisite }),
    });
    assert.equal(
      harness.agreesWithExpectation(classified.result, "fail"),
      false,
      `a skipped designated case agreed with prerequisite=${String(prerequisite)}`,
    );
    assert.notEqual(
      classified.result,
      harness.CONTROL_RESULT["TESTS_PASSED_UNEXPECTEDLY"],
      "a skipped designated case was still read as an unexpected pass",
    );
  }
});

test("NC-CLASSIFY-SKIP: the unmeasured result carries why, so an operator need not reproduce it", () => {
  const classified = classify({
    stdout: `${skipLine(RENDERED, RENDER_SKIP_REASON)}\n${SUMMARY_WITH_SKIPS(28, 0, 1)}`,
    expect: "fail",
    tests: [COMPOSE_SUITE],
    mustFailCases: [RENDERED],
    prerequisite: "otel-demo-upstream",
  });
  assert.equal(classified.skipped, 1);
  assert.deepEqual(classified.skippedDesignated, [RENDERED]);
  assert.deepEqual(classified.skipReasons, [RENDER_SKIP_REASON]);
  assert.equal(classified.prerequisite, "otel-demo-upstream");
});
