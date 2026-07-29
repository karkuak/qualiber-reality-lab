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
    // Removes only the *succeeded* requirement, keeping the undefined check.
    //
    // `if (false)` would compile until 6.5-E, which added an activation receipt
    // reading `connected.core_hash` after the block — with the guard gone TS can
    // no longer narrow it and the patched tree stops building. And splitting the
    // guard this way found something better: the first version of this control
    // passed, because the only case any test reached was a connect that had never
    // run. `ENV-MUT: activation is refused after a connect that failed` now covers
    // the half that was unexercised.
    find: 'if (connected === undefined || connected.status !== "succeeded") {',
    replace: "if (connected === undefined) {",
    tests: ["tests/dist/adversarial/environmentCommands.test.js"],
    expect: "fail",
  },
  {
    id: "freeze-output-outstanding-step-guard",
    what: "subject output cannot freeze while a committed step is owed",
    file: "packages/core/src/run/environmentRun.ts",
    // `String(1) === "2"` rather than `false`: a literal `false` lets TypeScript
    // mark the block unreachable and skip narrowing entirely, so `remaining` in
    // the block's own message reverts to its declared optional type and the patch
    // will not compile. An opaque boolean keeps the branch reachable to the type
    // checker and false at runtime.
    find: "if (remaining !== undefined) {",
    replace: 'if (remaining !== undefined && String(1) === "2") {',
    tests: ["tests/dist/adversarial/environmentCommands.test.js"],
    expect: "fail",
  },
  {
    id: "step-order-guard",
    what: "a named step command may not reorder the committed journey",
    file: "packages/core/src/run/environmentRun.ts",
    // Same technique, same reason.
    find: "if (intent !== undefined && step.intent !== intent) {",
    replace: 'if (intent !== undefined && step.intent !== intent && String(1) === "2") {',
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
    // Routed away rather than made to `throw`.
    //
    // The original patch inserted a `throw` as the function's first statement.
    // That worked until ADR-ERL2-024 added `chain[chain.length - 1]` to the
    // environment path: under `noUncheckedIndexedAccess` the value is
    // `T | undefined`, and TypeScript's control-flow analysis does not narrow
    // inside a block it has already proven unreachable — so the *patched* tree
    // stopped compiling and the control reported BUILD FAILED instead of
    // measuring anything. Diverting the dispatch tests the same property (an
    // environment bundle really reaches `verifyEnvironmentBundle`) and leaves
    // both functions typechecking.
    find:
      '  return declaredVariant === "environment"\n' +
      "    ? verifyEnvironmentBundle(options)\n" +
      "    : verifyPreEnvironmentBundle(options);",
    replace: "  void verifyEnvironmentBundle;\n  return verifyPreEnvironmentBundle(options);",
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

  // -- ADR-ERL2-024: one control per invariant the remediation establishes ----
  //
  // Each disables exactly one guard and names the test that must then fail. A
  // control that kills nothing is recorded as `expect: "pass"` with the reason,
  // never quietly re-scored — the discipline §10a already established.
  //
  // Several patches read `String(1) === "2"` rather than `false`. That is not
  // decoration: a literal `false` lets TypeScript drop the branch and stop
  // narrowing, so the *unpatched* code around it no longer typechecks and the
  // control reports BUILD FAILED instead of measuring anything.
  {
    id: "run-identity-validation",
    what: "--run must match the run the workspace records (review P1-8)",
    file: "packages/core/src/run/runIdentity.ts",
    // Disabled at the single source of truth, which is what proves all three
    // call sites — the CLI dispatcher, the CLI workspace opener and the
    // `RunWorkspace` constructor — rest on the same guard.
    find: "  const identity = readWorkspaceIdentity(options.runRoot);",
    replace:
      "  const identity = readWorkspaceIdentity(options.runRoot);\n" +
      '  if (String(1) !== "2") return identity;',
    tests: ["tests/dist/adversarial/runIdentity.test.js"],
    expect: "fail",
  },
  {
    id: "substrate-binding-validation",
    what: "every environment phase checks the substrate it is about to talk to (review P0-1)",
    file: "packages/core/src/run/environmentRun.ts",
    find: "    assertSubstrateBinding({",
    replace: '    if (String(1) !== "2") return;\n    assertSubstrateBinding({',
    tests: ["tests/dist/adversarial/substrateSubstitution.test.js"],
    expect: "fail",
  },
  {
    id: "substrate-locator-conflict",
    what: "a locator flag may not replace an established binding (review P0-1)",
    file: "packages/cli/src/environmentCommands.ts",
    find:
      "  if (suppliedSubstrate !== undefined && path.resolve(suppliedSubstrate) !== bound.substrate_root) {",
    replace:
      "  if (suppliedSubstrate !== undefined && String(1) === \"2\") {",
    tests: ["tests/dist/adversarial/substrateSubstitution.test.js"],
    expect: "fail",
  },
  {
    id: "pre-dispatch-intent",
    what: "no external mutation without a durable intent recorded first (review P1-7)",
    file: "packages/core/src/run/mutationIntent.ts",
    // The dispatch still happens; only the durable record *before* it is
    // removed. That is the defect exactly: the call was made and nothing said so.
    find: '    this.advance(spec.operationId, "dispatching");',
    replace: "    void spec.operationId;",
    tests: ["tests/dist/e2e/mutationIntentCrashMatrix.test.js"],
    expect: "fail",
  },
  {
    id: "intent-reconciliation",
    what: "an unsettled intent is reconciled against observed state before any retry",
    file: "packages/core/src/run/mutationIntent.ts",
    // Disables the *adopt* path, so an unsettled idempotent operation is
    // re-dispatched instead of reconciled. Patching the probe itself does not
    // compile: TypeScript narrows a `const` to its literal initializer even
    // through a type annotation, and the two later comparisons then report "no
    // overlap".
    find: '      if (observed === "present") {',
    replace: '      if (String(1) === "2") {',
    tests: ["tests/dist/e2e/mutationIntentCrashMatrix.test.js"],
    expect: "fail",
  },
  {
    id: "frontier-action-derivation",
    what: "a frontier cannot vouch for its own action set (review P1-6)",
    file: "packages/public-verifier/src/library/environmentDerivation.ts",
    find: "  assertFrontierActionsDerivable(frontier);",
    replace: "  void assertFrontierActionsDerivable;",
    tests: ["tests/dist/adversarial/emergencyCleanupAdversarial.test.js"],
    expect: "fail",
  },
  {
    id: "safe-action-completeness",
    what: "every independently safe action must be attempted and correctly labelled (ERL2-AC-035)",
    file: "packages/public-verifier/src/library/environmentDerivation.ts",
    // Empties the per-action verification loop: an omitted action and a
    // relabelled one both become invisible, which is what the verifier did.
    find: "  for (const action of frontier.derived_actions) {\n    const reported = reportedById.get(action.action_id);",
    replace:
      "  for (const action of [] as typeof frontier.derived_actions) {\n" +
      "    const reported = reportedById.get(action.action_id);",
    tests: ["tests/dist/adversarial/emergencyCleanupAdversarial.test.js"],
    expect: "fail",
  },
  {
    id: "per-action-emergency-cleanup",
    what: "emergency cleanup attempts each safe action separately (review P1-1/P1-5)",
    file: "packages/core/src/run/environmentRun.ts",
    // Forces the whole-environment fallback even though the driver offers
    // per-resource destruction — the pre-remediation behaviour exactly.
    find: "    if (this.driver.destroyResource !== undefined) {",
    replace:
      '    if (this.driver.destroyResource !== undefined && this.driver.manifest.driver_id === "no-such-driver") {',
    tests: ["tests/dist/adversarial/emergencyCleanupAdversarial.test.js"],
    expect: "fail",
  },
  {
    id: "verifier-validity-derivation",
    what: "the verifier re-derives validity instead of reading `status` (review P1-11)",
    file: "packages/public-verifier/src/library/environmentDerivation.ts",
    find: "  if (derived !== validity.status) {",
    replace: '  if (String(1) === "2") {',
    tests: ["tests/dist/adversarial/environmentVerifierDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "verifier-restoration-derivation",
    what: "the verifier re-derives restoration instead of reading `passed` (review P1-4)",
    file: "packages/public-verifier/src/library/environmentDerivation.ts",
    find: "  if (derived !== restoration.passed) {",
    replace: '  if (String(1) === "2") {',
    tests: ["tests/dist/adversarial/environmentVerifierDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "verifier-teardown-derivation",
    what: "the verifier re-derives teardown instead of reading `passed`",
    file: "packages/public-verifier/src/library/environmentDerivation.ts",
    find: "  if (derived !== teardown.passed) {",
    replace: '  if (String(1) === "2") {',
    tests: ["tests/dist/adversarial/environmentVerifierDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "branch-specific-cancellation",
    what: "cancel is routed by the run's own evidence, not to the pre-environment terminal (review P1-2)",
    file: "packages/cli/src/index.ts",
    find: "  cancel: (argv) => (hasSubstrate(argv) ? cancelEnvironment(argv) : cancel(argv)),",
    replace:
      '  cancel: (argv) => (hasSubstrate(argv) && String(1) === "2" ? cancelEnvironment(argv) : cancel(argv)),',
    tests: ["tests/dist/e2e/environmentCancellation.test.js"],
    expect: "fail",
  },
  {
    id: "cancellation-cleanup-applicability",
    what: "the verifier refuses a terminal claiming no cleanup was required over a live environment",
    file: "packages/public-verifier/src/library/environmentDerivation.ts",
    find: '  if (variant === "none" || status === "not_required") {',
    replace: '  if (String(1) === "2") {',
    tests: ["tests/dist/adversarial/environmentVerifierDerivation.test.js"],
    expect: "fail",
  },

  // -- the false-attestation remediation package (ADR-ERL2-025/026, and the
  //    parts of P0-1 / P1-12 / P1-4 that ADR-ERL2-024 left open) -------------
  {
    id: "locator-flag-development-gate",
    what: "--substrate-root and --reservation-root are development-only (review P0-1)",
    file: "packages/cli/src/environmentCommands.ts",
    // The gate, not the binding. Gating the flag is not the fix — the binding
    // is — but an ungated redirection flag has no business on a release surface
    // either way, and the claim that it is unreachable there has to be measured.
    find: '  if (supplied && process.env["ERL2_DEVELOPMENT_FAKE_SUBJECT"] !== "1") {',
    replace: '  if (supplied && String(1) === "2") {',
    tests: ["tests/dist/adversarial/substrateSubstitution.test.js"],
    expect: "fail",
  },
  {
    id: "narrow-enoent-substrate-read",
    what: "only ENOENT means `never provisioned`; every other fault fails closed (review P1-12)",
    file: "packages/core/src/environment/substrate.ts",
    // Restores the original fail-open exactly: every read fault becomes
    // "nothing here", which is what let a teardown pass over live resources.
    find: "      if (isAbsent(cause)) return undefined;",
    replace: "      void cause;\n      return undefined;",
    tests: ["tests/dist/adversarial/substrateErrorClassification.test.js"],
    expect: "fail",
  },
  {
    id: "substrate-state-shape-validation",
    what: "a document that is not substrate state is a fault, not an empty substrate (review P1-12)",
    file: "packages/core/src/environment/substrate.ts",
    // The second, quieter half of the same fail-open: the coercion that turned
    // every unrecognised shape into `{ resources: [], mutations: [] }`.
    find: "  if (!Array.isArray(record[\"resources\"])) throw unreadable(what, \"`resources` is not an array\");",
    replace:
      "  if (!Array.isArray(record[\"resources\"])) return { resources: [], mutations: [] };",
    tests: ["tests/dist/adversarial/substrateErrorClassification.test.js"],
    expect: "fail",
  },
  {
    id: "compensation-mutation-binding",
    what: "the expected reverted set is derived from the run's own retained mutation receipts (review P1-4)",
    file: "packages/core/src/run/environmentRun.ts",
    // The compensation still runs and the probe is still frozen; it simply
    // stops naming what it was supposed to revert, which is how "reverted
    // nothing" and "had nothing to revert" became the same terminal.
    // Asks for a role nothing produces rather than substituting an empty
    // literal: a literal `[]` loses the branded hash type and the *unpatched*
    // callback stops typechecking, which reports BUILD FAILED instead of
    // measuring anything — the failure mode §8 of the previous campaign
    // recorded twice.
    find: 'return this.ws.hashesForRole("mutation-receipt").map((hash) => {',
    replace: 'return this.ws.hashesForRole("no-such-role").map((hash) => {',
    tests: ["tests/dist/adversarial/compensationAdversarial.test.js"],
    expect: "fail",
  },
  {
    id: "independent-restoration-probe",
    what: "the substrate is re-read after the compensation, and the verdict comes from that (review P1-4)",
    file: "packages/core/src/run/environmentRun.ts",
    // Removes the independent post-compensation observation and falls back to
    // believing the receipt — the pre-ADR-ERL2-026 behaviour exactly.
    find: "    if (!restorationProbePassed(probe.outcome)) {",
    replace: '    if (String(1) === "2") {',
    tests: ["tests/dist/adversarial/compensationAdversarial.test.js"],
    expect: "fail",
  },
  {
    id: "producer-claim-scope-derivation",
    what: "the producer refuses a requested scope stronger than the evidence (ADR-ERL2-025 §4.4)",
    file: "packages/cli/src/journeyCommands.ts",
    // Restores `flags["claim-scope"] ?? "T1"`: the operator's word, signed.
    find: "  assertClaimScopeWithinCeiling({",
    replace:
      "  if (String(1) !== \"2\") return options.requested;\n  assertClaimScopeWithinCeiling({",
    tests: ["tests/dist/adversarial/claimScopeEscalation.test.js"],
    expect: "fail",
  },
  {
    id: "verifier-claim-scope-rederivation",
    what: "the verifier re-derives the ceiling instead of accepting the signed scope (ADR-ERL2-025 §4.5)",
    file: "packages/public-verifier/src/library/claimScope.ts",
    find: "  if (!claimScopeExceeds(options.claimScope, options.report.ceiling)) return;",
    replace: '  if (String(1) !== "2") return;',
    tests: ["tests/dist/adversarial/claimScopeEscalation.test.js"],
    expect: "fail",
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
// Comma-separated, so a remediation package can measure exactly the controls it
// touches. A full campaign is ~30 builds and ~30 suite runs; a package that
// changed nine guards should be able to say which nine it measured rather than
// choosing between four hours and a partial answer with no record of which part.
const filter = process.argv.find((a) => !a.startsWith("--") && a !== process.argv[0] && a !== process.argv[1]);
const wanted = filter === undefined ? undefined : filter.split(",").filter(Boolean);
const selected = CONTROLS.filter(
  (c) => wanted === undefined || wanted.some((needle) => c.id.includes(needle)),
);
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
