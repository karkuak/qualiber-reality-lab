#!/usr/bin/env node
/**
 * Negative controls, run against a disposable copy of the tree.
 *
 * A guard that no test fails on is not a guard, it is a comment. So every guard
 * this repository claims is load-bearing gets disabled here and the suite is
 * re-run to see the failure. The results are the ledger's §2 and §7 tables.
 *
 * ## Why this does not patch the working tree
 *
 * The first version of this campaign did, restoring each patch from a snapshot
 * it had copied beforehand. A timeout killed it mid-case, so the snapshot taken
 * for the *next* case captured the previous case's patch, and the working tree
 * was silently left mutated — which then surfaced as four unexplained failures on
 * a supposedly clean branch. The lesson is not "be careful with snapshots"; it is
 * that a harness which can write to the tree it is measuring will eventually
 * leave it changed.
 *
 * So: the mutations happen in a `git worktree` checked out at HEAD in a temp
 * directory. Restoration is `git checkout -- .`, which restores from the object
 * store — an immutable original, not a copy this script made. And the run ends by
 * proving the real working tree is byte-identical to how it started, failing if
 * it is not.
 *
 * Controls are applied to a worktree checked out at **HEAD**, so the campaign
 * refuses to run against a dirty tree: an uncommitted change to a guard would be
 * measured against source that does not contain it.
 *
 * Usage:
 *   npm run negative-control              # every control
 *   npm run negative-control -- substrate # controls whose id matches
 */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every control: a guard, how to disable it, and which suites should notice.
 *
 * `expect` is what the campaign asserts, and `"none"` is a legitimate value.
 * Two of these guards genuinely do not fail any test when removed; recording
 * that as an expectation is the point, because it stops a later reader from
 * assuming they are proven. See the ledger for why each one is kept anyway.
 */
const CONTROLS = [
  {
    id: "activate-connect-guard",
    what: "activation requires a succeeded connect outcome",
    file: "packages/core/src/run/environmentRun.ts",
    find: 'if (connected === undefined || connected.status !== "succeeded") {',
    replace: "if (false) {",
    tests: ["tests/dist/adversarial/environmentCommands.test.js"],
    expect: "fail",
  },
  {
    id: "freeze-output-outstanding-step-guard",
    what: "subject output cannot freeze while a committed step is owed",
    file: "packages/core/src/run/environmentRun.ts",
    find: "if (remaining !== undefined) {",
    replace: "if (false) {",
    tests: ["tests/dist/adversarial/environmentCommands.test.js"],
    expect: "fail",
  },
  {
    id: "step-order-guard",
    what: "a named step command may not reorder the committed journey",
    file: "packages/core/src/run/environmentRun.ts",
    find: "if (intent !== undefined && step.intent !== intent) {",
    replace: "if (false) {",
    tests: ["tests/dist/e2e/environmentRun.test.js"],
    expect: "fail",
  },
  {
    id: "durable-substrate",
    what: "the environment driver remembers its substrate across processes",
    file: "packages/core/src/environment/fakeDriver.ts",
    find: "this.substrate = options.substrate ?? new MemorySubstrateStore();",
    replace: "this.substrate = new MemorySubstrateStore();",
    tests: [
      "tests/dist/e2e/environmentRun.test.js",
      "tests/dist/adversarial/environmentCommands.test.js",
    ],
    expect: "fail",
  },
  {
    id: "restore-receipt-status",
    what: "a driver-reported failed restore is a restoration failure, drift or not",
    file: "packages/core/src/run/environmentRun.ts",
    find: [
      '    if (receipt.status !== "succeeded") {',
      "      this.ws.store.freezeJson(`${RETAINED}/failed-restore-receipt.json`, receipt, \"INTERNAL\");",
    ].join("\n"),
    replace: [
      "    if (false) {",
      "      this.ws.store.freezeJson(`${RETAINED}/failed-restore-receipt.json`, receipt, \"INTERNAL\");",
    ].join("\n"),
    tests: ["tests/dist/e2e/environmentInvalidTerminal.test.js"],
    expect: "fail",
  },
  {
    id: "emergency-route",
    what: "a restoration failure MUST enter receipt-backed emergency cleanup",
    file: "packages/cli/src/environmentCommands.ts",
    find: '"environment_restoration", "cleanup_failure", true)',
    replace: '"environment_restoration", "cleanup_failure", false)',
    tests: ["tests/dist/e2e/environmentInvalidTerminal.test.js"],
    expect: "fail",
  },
  {
    id: "subject-output-canary-scan",
    what: "a canary in the subject's output bytes refuses before the freeze",
    file: "packages/core/src/run/environmentRun.ts",
    // Removes the *bytes* half of the scan specifically. Emptying
    // `knownCanaryIds()` would be a no-op — detection is pattern-based — and a
    // control that cannot fail is worse than no control, because it reads as
    // evidence that the guard is not load-bearing.
    find: [
      "        ...outcomes.flatMap((outcome) =>",
      "          outcome.output_refs.map((ref) => ({",
      '            surface: "subject_output_prefill" as const,',
      "            label: `subject-output:${ref.path}`,",
      "            bytes: this.ws.store.read(ref.path),",
      "          })),",
      "        ),",
    ].join("\n"),
    replace: "",
    tests: ["tests/dist/e2e/environmentRun.test.js"],
    expect: "fail",
  },
  {
    id: "environment-bundle-verifier",
    what: "verifyEnvironmentBundle is reached by a real bundle",
    file: "packages/public-verifier/src/library/verify.ts",
    find: "function verifyEnvironmentBundle(options: VerifyBundleOptions): BundleVerificationResult {",
    replace:
      "function verifyEnvironmentBundle(options: VerifyBundleOptions): BundleVerificationResult {\n" +
      '  throw new Error("negative control: verifyEnvironmentBundle is unreachable");',
    tests: [
      "tests/dist/e2e/environmentRun.test.js",
      "tests/dist/adversarial/environmentTerminalMutations.test.js",
    ],
    expect: "fail",
  },
  {
    id: "baseline-repeatability",
    what: "two baseline probes of a clean environment must agree",
    file: "packages/core/src/run/environmentRun.ts",
    find: "    assertRepeatableBaseline(first, second);",
    replace: "    void second;",
    tests: ["tests/dist/e2e/environmentRun.test.js"],
    expect: "pass",
    note: "the fake driver is deterministic, so two probes agree by construction; kept for the Compose driver",
  },
  {
    id: "case-selected-comparisons",
    what: "the opened binding must match the admitted challenge and journey",
    file: "packages/core/src/run/workspace.ts",
    find: '    if (challenge.journey_hash !== binding.journey_hash) disagree("the journey");',
    replace: "    void disagree;",
    tests: ["tests/dist/e2e/selectionWalk.test.js", "tests/dist/e2e/environmentRun.test.js"],
    expect: "pass",
    note: "the producer builds pool entries from the admitted manifests, so they agree by construction",
  },
];

// -- the disposable tree -----------------------------------------------------

function git(args, cwd = root) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A digest of every tracked file, so "the tree is unchanged" is checkable. */
function treeDigest() {
  const status = git(["status", "--porcelain"]);
  const files = git(["ls-files"]).split("\n").filter(Boolean);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(file);
    hash.update("\0");
    try {
      hash.update(readFileSync(path.join(root, file)));
    } catch {
      hash.update("<unreadable>");
    }
  }
  return { digest: hash.digest("hex"), status };
}

const before = treeDigest();

/**
 * Paths whose uncommitted state could change a control's result.
 *
 * Narrower than "the whole tree" on purpose. Refusing on *any* dirt sounds
 * stricter, but it fires on an unrelated markdown edit, and a check that fires
 * for reasons the operator knows are irrelevant trains them to pass
 * `--allow-dirty` reflexively — at which point it stops protecting the case it
 * exists for. These are the roots the build and the controls actually read.
 */
const BUILD_RELEVANT = ["packages/", "tests/", "scripts/", "adapters/", "packs/", "package.json", "tsconfig"];
const dirty = before.status
  .split("\n")
  .filter(Boolean)
  .map((line) => line.slice(3));
const blocking = dirty.filter((f) => BUILD_RELEVANT.some((prefix) => f.startsWith(prefix)));
if (blocking.length > 0 && !process.argv.includes("--allow-dirty")) {
  console.error(
    "negative-control refuses to run: uncommitted changes to source it measures.\n\n" +
      "Controls are applied to a worktree checked out at HEAD, so an uncommitted\n" +
      "change to a guard would be measured against source that does not contain\n" +
      "it — the result would look authoritative and mean nothing. Commit first, or\n" +
      "pass --allow-dirty if you know the difference does not matter.\n\n" +
      blocking.map((f) => `  ${f}`).join("\n"),
  );
  process.exit(2);
}
if (dirty.length > blocking.length) {
  console.log(
    `note: ${String(dirty.length - blocking.length)} uncommitted file(s) outside the build ` +
      "are ignored; they cannot change a control's result",
  );
}
const filter = process.argv.find((a) => !a.startsWith("--") && a !== process.argv[0] && a !== process.argv[1]);
const selected = CONTROLS.filter((c) => filter === undefined || c.id.includes(filter));
if (selected.length === 0) {
  console.error(`no control matches ${String(filter)}`);
  process.exit(2);
}

const worktreeRoot = mkdtempSync(path.join(tmpdir(), "erl2-negative-control-"));
const worktree = path.join(worktreeRoot, "tree");
console.log(`negative controls: ${String(selected.length)} of ${String(CONTROLS.length)}`);
console.log(`worktree: ${worktree}`);
git(["worktree", "add", "--detach", worktree, "HEAD"]);

const results = [];
try {
  console.log("installing dependencies in the worktree (once)…");
  const install = spawnSync("npm", ["install", "--silent"], { cwd: worktree, encoding: "utf8" });
  if (install.status !== 0) {
    throw new Error(`npm install failed in the worktree:\n${install.stderr.slice(0, 2000)}`);
  }

  for (const control of selected) {
    const target = path.join(worktree, control.file);
    const source = readFileSync(target, "utf8");
    if (!source.includes(control.find)) {
      // A control whose patch no longer applies is a *failure of the campaign*,
      // not a silent skip: the guard may have moved, been renamed, or been
      // deleted, and any of those needs a human.
      results.push({ id: control.id, outcome: "PATCH DID NOT APPLY", detail: control.find.slice(0, 80) });
      console.log(`  ✖ ${control.id}: patch did not apply`);
      continue;
    }
    writeFileSync(target, source.replace(control.find, control.replace));

    const build = spawnSync("npm", ["run", "build"], { cwd: worktree, encoding: "utf8" });
    if (build.status !== 0) {
      results.push({ id: control.id, outcome: "BUILD FAILED", detail: build.stdout.slice(-800) });
      console.log(`  ✖ ${control.id}: the patched tree does not build`);
      git(["checkout", "--", "."], worktree);
      continue;
    }
    const run = spawnSync("node", ["--test", ...control.tests], { cwd: worktree, encoding: "utf8" });
    const pass = Number(/^ℹ pass (\d+)$/m.exec(run.stdout)?.[1] ?? "0");
    const fail = Number(/^ℹ fail (\d+)$/m.exec(run.stdout)?.[1] ?? "0");
    const outcome = fail > 0 ? "fail" : "pass";
    const agreed = outcome === control.expect;
    results.push({
      id: control.id,
      what: control.what,
      expected: control.expect,
      outcome,
      pass,
      fail,
      agreed,
      ...(control.note === undefined ? {} : { note: control.note }),
    });
    console.log(
      `  ${agreed ? "✔" : "✖"} ${control.id}: ${String(pass)} pass / ${String(fail)} fail ` +
        `(expected ${control.expect})${control.note === undefined ? "" : ` — ${control.note}`}`,
    );
    git(["checkout", "--", "."], worktree);
  }
} finally {
  // The worktree goes whatever happened, and the real tree is proven untouched.
  try {
    git(["worktree", "remove", "--force", worktree]);
  } catch {
    /* the prune below covers a worktree that was already gone */
  }
  git(["worktree", "prune"]);
  rmSync(worktreeRoot, { recursive: true, force: true });
}

const after = treeDigest();
if (after.digest !== before.digest || after.status !== before.status) {
  console.error(
    "\nnegative-control FAILED: the working tree changed while controls ran.\n" +
      "This harness must never modify the tree it is measuring.",
  );
  console.error(`  before: ${before.digest}\n  after:  ${after.digest}`);
  process.exit(1);
}
console.log("\nthe working tree is byte-identical to how the campaign started");

const disagreed = results.filter((r) => r.agreed === false || r.outcome === "PATCH DID NOT APPLY" || r.outcome === "BUILD FAILED");
writeFileSync(
  path.join(root, "docs", "ledger", "negative-controls.json"),
  `${JSON.stringify({ generated_by: "scripts/negative-control.mjs", results }, null, 2)}\n`,
);
if (disagreed.length > 0) {
  console.error(`\nnegative-control FAILED: ${String(disagreed.length)} control(s) disagreed with their recorded expectation`);
  for (const r of disagreed) console.error(`  ${r.id}: ${JSON.stringify(r)}`);
  process.exit(1);
}
console.log(`all ${String(results.length)} control(s) matched their recorded expectation`);
