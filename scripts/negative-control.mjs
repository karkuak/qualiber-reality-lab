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
 * ## Why every patch must prove it hit its target
 *
 * This campaign used to apply patches with `source.replace(find, replace)`, which
 * takes the **first** occurrence and reports nothing when there are several.
 * Three controls have silently expired that way after a later package inserted
 * similar text above their anchor, and two of the three were found only by
 * running the full set — the focused subsets in between reported a number for a
 * measurement that had not happened.
 *
 * So targeting is now a proof rather than an assumption, in
 * `scripts/lib/controlTarget.mjs`: a control declares its preimage and how many
 * occurrences it means, the default is exactly one, zero and "more than declared"
 * are both refusals, and the postimage is verified positionally after the splice.
 * A control whose anchor is ambiguous is a **harness error** that fails the
 * campaign. It is never reported as a passing or non-load-bearing control,
 * because a patch that modified the wrong location is not evidence.
 *
 * Usage:
 *   npm run negative-control              # every control
 *   npm run negative-control -- substrate # controls whose id matches
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TARGET_OUTCOME, planControlPatch, verifyPatchOnDisk } from "./lib/controlTarget.mjs";
import {
  certifyTreeUnchanged,
  createDisposableWorktree,
  treeDigest,
  worktreeResidue,
} from "./lib/disposableWorktree.mjs";
import {
  CAMPAIGN_PREREQUISITES,
  PREREQUISITE_STATUS,
  ensurePrerequisite,
} from "./lib/campaignFixtures.mjs";
import {
  CAMPAIGN_SCHEMA,
  EVIDENCE_VERSION,
  repositoryIdentity,
} from "./lib/validationEvidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every control: a guard, how to disable it, and which suites should notice.
 *
 * `expect` is what the campaign asserts, and `"none"` is a legitimate value.
 * Two of these guards genuinely do not fail any test when removed; recording
 * that as an expectation is the point, because it stops a later reader from
 * assuming they are proven. See the ledger for why each one is kept anyway.
 *
 * `expectedMatches` is optional and defaults to **exactly one**. A control whose
 * preimage legitimately occurs more than once must say so, or name an `anchor`
 * that occurs exactly once and locate the preimage after it. Neither is a
 * formality: the default is what turns a preimage that stopped being unique from
 * a silent mis-patch into a failed campaign.
 *
 * `expectedSkips` is how a control admits, in advance, that one of the suites it
 * runs will announce a skip. Since the independent review of `07da5fe`, any skip
 * a control did not declare is a harness error — so this field is the only way a
 * skip is permitted to coexist with a measurement, and declaring one is a claim a
 * reader can check rather than a silence they cannot.
 */

/**
 * The one case in `composeSubstrate.test.js` that skips itself.
 *
 * It renders the *real* merged Compose configuration, which needs the extracted
 * upstream fixture — git-ignored, so absent from a fresh campaign worktree until
 * something provisions it. Only `substrate-loopback-only-rendered` declares that
 * fixture as a prerequisite, and it is the last of the four controls running this
 * suite, so for the three before it the case is genuinely unobservable and says
 * so with `RENDERED TOPOLOGY UNPROVEN`.
 *
 * Those three measure ownership labels, running-image resolution and collector
 * verification: none of them is *about* the rendered topology, so the skip is
 * unrelated to what they claim. Before this declaration existed, the campaign
 * recorded their agreements without recording the skip at all — which is exactly
 * what the review meant by saying the 129-row record could not establish that no
 * skips were hidden. Declaring it does not excuse it; it publishes it.
 */
const RENDERED_TOPOLOGY_SKIP = Object.freeze([
  Object.freeze({
    case: "COMPOSE-ADV: the RENDERED configuration publishes one loopback port and nothing else",
    reason: "RENDERED TOPOLOGY UNPROVEN",
  }),
  // Package 2 added a second assertion over the same rendered merge — that the
  // trusted telemetry volume is mounted into the collector and into nothing
  // else — so it is unobservable under exactly the same missing fixture, for
  // exactly the same controls, and is declared here for exactly the same
  // reason. An undeclared skip in a campaign row reads as coverage.
  Object.freeze({
    case: "COMPOSE-ADV: the RENDERED configuration mounts the trusted volume into the collector alone",
    reason: "RENDERED TOPOLOGY UNPROVEN",
  }),
]);

export const CONTROLS = [
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
    id: "adapter-mode-binding",
    what: "a run cannot change the subject seam or the current receipt it froze at preregistration",
    file: "packages/cli/src/journeyCommands.ts",
    // The LIVE-001 P1 the independent review of `e9718e0` reproduced: a run
    // preregistered without an adapter could later supply a real entrypoint and
    // authorize receipt A on one command and receipt B on the next, with
    // neither inside the frozen boundary. Removing this single call restores
    // exactly that bypass — `adapterCertificationReceiptHash` then falls back to
    // whatever flag the command carries, because no binding contradicts it.
    //
    // `void` rather than deletion: the function must stay referenced or the
    // patched tree fails to compile on an unused declaration, and a control that
    // cannot build is a harness error rather than evidence.
    find: "  assertSubjectModeUnchanged(flags, runRoot);",
    replace: "  void assertSubjectModeUnchanged;",
    tests: ["tests/dist/adversarial/adapterModeBinding.test.js"],
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
    //
    // Anchored on the comment above the *first-dispatch* advance, not on the
    // advance alone. `this.advance(spec.operationId, "dispatching")` occurs
    // twice: once on the resume path ADR-ERL2-028 added, which is taken only
    // when an existing intent already sits at `declared`, and once on the path
    // every operation takes. `String.replace` took the first, so from
    // ADR-ERL2-028 onward this control disabled the resume branch and killed
    // nothing — 7 pass / 0 fail on the Step 5B campaign. That is the third
    // recorded instance of a control expiring because a later package edited
    // the file above its anchor (`invalid-finding-lab-attribution` was the
    // second), and it is the case the unique-target requirement now catches
    // structurally rather than by memory.
    find:
      "    // Durable *before* the call, so a crash during dispatch is distinguishable\n" +
      "    // from a crash before it.\n" +
      '    this.advance(spec.operationId, "dispatching");',
    replace:
      "    // Durable *before* the call, so a crash during dispatch is distinguishable\n" +
      "    // from a crash before it.\n" +
      "    void spec.operationId;",
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
    file: "packages/core/src/run/environmentCleanup.ts",
    // Forces the whole-environment fallback even though the driver offers
    // per-resource destruction — the pre-remediation behaviour exactly.
    find: "  if (ctx.driver.destroyResource !== undefined) {",
    replace:
      '  if (ctx.driver.destroyResource !== undefined && ctx.driver.manifest.driver_id === "no-such-driver") {',
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
    id: "telemetry-gate-satisfaction",
    what: "a declared run passes the telemetry gate only on one observed, run-attributed observation of its own (ADR-ERL2-033)",
    file: "packages/core/src/environment/telemetryObservation.ts",
    find: [
      "  return (",
      '    observation.evidence === "observed" &&',
      "    observation.run_id === input.runId &&",
      "    observation.marker === input.runId &&",
      "    (observation.run_attributed_records ?? 0) >= 1",
      "  );",
    ].join("\n"),
    replace: ["  void observation;", "  return String(1) === String(1);"].join("\n"),
    // ADR-ERL2-038 R8 moved the suite, not the property. The arithmetic is
    // unchanged and still decides whether a declared run is satisfied; what
    // changed is that only an ERL2-C-171 record now reaches it, so the cases
    // that exercise it live with the v2 fixtures. Its v1 cases were not
    // dropped — they still run, and they still fail the gate, one step earlier
    // and for a stronger reason.
    tests: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFail: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFailCases: [
      "TRUSTED-AUTHORITY: an authentic zero governs, and authorizes no positive claim",
      "TRUSTED-AUTHORITY: an absent v2 governs its own refusal rather than being ignored",
      "TRUSTED-AUTHORITY: the migration truth table, observed at the gate",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-verifier-declared-requires-observation",
    what: "the offline verifier requires a retained observation wherever the retained bytes declare it obtainable (ADR-ERL2-033)",
    file: "packages/public-verifier/src/library/telemetryDerivation.ts",
    find: [
      "    if (declared) {",
      "      throw new Erl2Error(",
      "        CODES.ENV_TELEMETRY_OBSERVATION_MISSING,",
    ].join("\n"),
    replace: [
      '    if (declared && String(1) === "2") {',
      "      throw new Erl2Error(",
      "        CODES.ENV_TELEMETRY_OBSERVATION_MISSING,",
    ].join("\n"),
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: ["ATTR-TELEM-VERIFY: a declared run that retains no observation is refused"],
    expect: "fail",
  },
  {
    id: "telemetry-verifier-count-derivation",
    what: "the offline verifier recomputes every telemetry count from the retained excerpt instead of reading the observation's numbers (ADR-ERL2-033)",
    file: "packages/public-verifier/src/library/telemetryDerivation.ts",
    find: [
      "  if (",
      "    observation.trace_batches !== derived.traceBatches ||",
      "    observation.spans !== derived.spans ||",
      "    observation.run_attributed_records !== derived.runAttributedRecords ||",
      "    !namesAgree",
      "  ) {",
    ].join("\n"),
    replace: '  if (String(1) === "2" && Boolean(namesAgree)) {',
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: ["TRUSTED-VERIFY: the verifier reads the bytes rather than the claim"],
    expect: "fail",
  },
  {
    id: "telemetry-verifier-attribution-floor",
    what: "a declared observation with zero run-attributed records is refused, not recorded (ADR-ERL2-033)",
    file: "packages/public-verifier/src/library/telemetryDerivation.ts",
    find: "  if (declared && derived.runAttributedRecords < 1) {",
    replace: '  if (declared && derived.runAttributedRecords < 1 && String(1) === "2") {',
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "TRUSTED-VERIFY: an authentic zero verifies where undeclared and is refused where declared",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-verifier-observation-cardinality",
    what: "a second retained telemetry observation is refused, not silently ignored (ADR-ERL2-033)",
    file: "packages/public-verifier/src/library/telemetryDerivation.ts",
    find: "  if (observationHashes.length > 1) {",
    replace: '  if (observationHashes.length > 1 && String(1) === "2") {',
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-TELEM-VERIFY: a second retained observation is refused rather than silently ignored",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-verifier-excerpt-fixed-point",
    what: "the offline verifier recomputes the digest of the retained trusted bytes, so the bytes it parses are the bytes the record is hash-bound to (ADR-ERL2-038 R5)",
    file: "packages/public-verifier/src/library/telemetryDerivation.ts",
    // ADR-ERL2-038 R7/R8 migration. The property is unchanged — *the retained
    // bytes are exactly the bytes the counts derive from* — but its enforcement
    // point moved with the channel. Under v1 it was the excerpt fixed point: an
    // excerpt carrying a line that contributed to no count was refused. Under
    // ERL2-C-171 the retained bytes are whole records, so the fixed point is
    // the digest: the verifier hashes the bytes it just parsed and refuses a
    // record whose declared digest is not that hash. The id is kept so the
    // ledger can show one property moving rather than one disappearing and an
    // unrelated one appearing.
    find: "  if (artifact.content_digest !== recomputedDigest) {",
    replace: '  if (artifact.content_digest !== recomputedDigest && String(1) === "2") {',
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "TRUSTED-VERIFY: the verifier reads the bytes rather than the claim",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-driver-verified-collector",
    what: "an unverified collector yields an absent observation, never a zero-count one (ADR-ERL2-033)",
    file: "packages/core/src/environment/composeDriver.ts",
    find: [
      "    if (collector === undefined || !ComposeEnvironmentDriver.verified(collector)) {",
      '      return { status: "unverified" };',
      "    }",
    ].join("\n"),
    replace: [
      "    if (collector === undefined) {",
      '      return { status: "unverified" };',
      "    }",
    ].join("\n"),
    tests: ["tests/dist/adversarial/composeSubstrate.test.js"],
    mustFail: ["tests/dist/adversarial/composeSubstrate.test.js"],
    mustFailCases: [
      "COMPOSE-ADV: a collector that is not provably this run's yields an absent observation, not a zero",
    ],
    expectedSkips: RENDERED_TOPOLOGY_SKIP,
    expect: "fail",
  },
  {
    id: "telemetry-producer-gate-wiring",
    what: "the environment validity gate answers the telemetry question from the run's own evidence, not from a constant",
    file: "packages/core/src/run/environmentRun.ts",
    find: "              gate_id: \"attributable-telemetry-retained\",\n              passed:\n                attributableTelemetryGatePassed({",
    replace: "              gate_id: \"attributable-telemetry-retained\",\n              passed:\n                String(1) === String(1) ||\n                attributableTelemetryGatePassed({",
    tests: [
      "tests/dist/adversarial/attributableTelemetry.test.js",
      "tests/dist/e2e/environmentExerciseTelemetryTerminal.test.js",
    ],
    mustFail: ["tests/dist/e2e/environmentExerciseTelemetryTerminal.test.js"],
    mustFailCases: [
      "ENV-TELEM-TERMINAL: a telemetry-applicable run whose channel produced nothing reaches an INVALID terminal",
    ],
    expect: "fail",
    // **Measured, and no longer a declared no-kill (ADR-ERL2-039).**
    //
    // This control was `expect: "pass"` from the day it was written, on the
    // reasoning that driving the gate's false branch needed a live Compose
    // substrate the ordinary suite must never require. The independent Package 3
    // review measured the cost of that reasoning: hard-coding the single wire
    // that decides whether a real run's telemetry is believed broke no test in
    // the repository.
    //
    // The premise was wrong rather than the reasoning. What the false branch
    // needs is a driver that *declares* a compose kind and implements the
    // package 2 seam — not a daemon. `environmentExerciseTelemetryTerminal`
    // supplies one and drives the whole terminal, so the mutation now turns four
    // assertions over at once: the gate passes, the terminal is valid, no
    // invalidity finding is frozen, and the run enters the generic evaluation
    // index it should have been refused.
    //
    // Measured before this declaration changed, against the mutation verbatim:
    // 1 pass / 1 fail, failing on `Missing expected exception: an invalid run
    // must be refused entry to the generic evaluation index`. The positive case
    // still passes under the mutant, so the kill is the property and not
    // collateral breakage.
  },
  {
    id: "exercise-outcome-failure-invalidates",
    what: "a required exercise that did not succeed fails its own Lab gate, so the run reaches an invalid terminal instead of a valid one with no telemetry obligation (ADR-ERL2-039)",
    file: "packages/core/src/journey/exerciseOutcome.ts",
    // The enforcement point, and the reason it is anchored on the *primitive*
    // rather than on the gate composition: this one definition is what the gate,
    // the required-gate set, `attributableTelemetryDeclared` and the retention
    // guard all read. Widening it to accept any status is exactly the defect the
    // review found — a run whose exercise failed answering as though it had
    // succeeded — and it type-checks.
    find: '    (outcome) => outcome.intent === EXERCISE_INTENT && outcome.status === "succeeded",',
    replace: "    (outcome) => outcome.intent === EXERCISE_INTENT,",
    tests: ["tests/dist/adversarial/environmentExerciseOutcome.test.js"],
    mustFail: ["tests/dist/adversarial/environmentExerciseOutcome.test.js"],
    mustFailCases: [
      "ENV-EXERCISE: an unsuccessful required exercise reaches an INVALID terminal",
      "ENV-EXERCISE: telemetry applicability contains exercise success, from one definition",
    ],
    expect: "fail",
  },
  {
    id: "exercise-outcome-applicability-is-not-the-verdict",
    what: "the exercise gate is composed from whether the run exercised, never from how the exercise went, so an unsuccessful exercise cannot be relabelled `not applicable` (ADR-ERL2-039)",
    file: "packages/core/src/journey/exerciseOutcome.ts",
    // The rot the ADR names explicitly. Narrowing applicability to *succeeded*
    // exercises would let a failing run omit the gate rather than fail it, which
    // is the false-valid terminal restated one level up.
    find: "  return outcomes.some((outcome) => outcome.intent === EXERCISE_INTENT);",
    replace:
      '  return outcomes.some(\n    (outcome) => outcome.intent === EXERCISE_INTENT && outcome.status === "succeeded",\n  );',
    tests: ["tests/dist/adversarial/environmentExerciseOutcome.test.js"],
    mustFail: ["tests/dist/adversarial/environmentExerciseOutcome.test.js"],
    mustFailCases: [
      "ENV-EXERCISE: an unsuccessful required exercise reaches an INVALID terminal",
      "ENV-EXERCISE: applicability reads whether an exercise happened, never how it went",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-retention-follows-one-applicability-answer",
    what: "the run retains an ERL2-C-171 observation only where the telemetry gate will evaluate it, so retention and applicability cannot disagree (ADR-ERL2-039)",
    file: "packages/core/src/run/environmentRun.ts",
    // The second half of the review's finding: retention guarded on two
    // conjuncts while the gate used three, so a run whose exercise did not
    // succeed froze a record no gate read. Removing the conjunct restores
    // exactly that, and `assertTelemetryExerciseCoherence` is what refuses it.
    find: "    if (!exerciseSucceeded(this.ws.derivedStepOutcomes())) return [];",
    replace: "    if (!exerciseSucceeded(this.ws.derivedStepOutcomes()) && String(1) === \"2\") return [];",
    tests: ["tests/dist/adversarial/environmentExerciseOutcome.test.js"],
    expect: "pass",
    note: "Declared unmeasured, and stated rather than implied. The mutant is a real defect — a run whose exercise did not succeed would freeze an ERL2-C-171 record again — but reaching it needs a run that both declares a compose driver and fails its exercising step, and on the shipped fixture journey a failed exercise is refused earlier still: `revealJudgeExpectations` opens the expectation of every non-succeeded step and refuses any carrying functional truth, which `exercise` does here. The contradiction the mutant creates is refused by `assertTelemetryExerciseCoherence` in the producer and by `deriveValidityOutcome` in the offline verifier, and both refusals ARE measured — by ENV-EXERCISE: a retained observation the gate would not evaluate is refused, and by VERIFIER-DERIVE: the exercise obligation is recomputed, not read from the producer. What is unmeasured is only this call site's own guard, and closing that needs a fixture whose exercise expectation is `journey_only`, which is a fixture change this package deliberately does not make.",
  },
  {
    id: "telemetry-retention-reentry",
    what: "a resumed retention reads the observation it already froze instead of observing again (EQ-L-005)",
    file: "packages/core/src/environment/telemetryObservation.ts",
    find: "  if (input.store.isFrozen(input.observationPath)) {",
    replace: "  if (input.store.isFrozen(input.observationPath) && String(1) === \"2\") {",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-TELEM-RETAIN: a re-entered retention reads what it wrote instead of observing again",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-excerpt-retention-bound",
    what: "a collector output past the excerpt bound demotes to an honest absent rather than being truncated or frozen (ADR-ERL2-033)",
    file: "packages/core/src/environment/telemetryObservation.ts",
    find: "  if (material.excerpt.length > MAX_TELEMETRY_EXCERPT_CHARS) return R.excerptOverBound;",
    replace: "  if (material.excerpt.length > MAX_TELEMETRY_EXCERPT_CHARS && String(1) === \"2\") return R.excerptOverBound;",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-TELEM-RETAIN: an excerpt past the retention bound demotes rather than truncating",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-excerpt-canonicalizable",
    what: "an excerpt the canonicalizer refuses demotes to absent rather than throwing before teardown begins (ADR-ERL2-035, EQ-L-004)",
    file: "packages/core/src/environment/telemetryObservation.ts",
    find: "  if (!isCanonicalizableString(material.excerpt)) return R.excerptNotCanonicalizable;",
    replace: "  if (!isCanonicalizableString(material.excerpt) && String(1) === \"2\") return R.excerptNotCanonicalizable;",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-TELEM-RETAIN: an excerpt the canonicalizer refuses demotes rather than throwing",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-service-name-cardinality",
    what: "more distinct service names than the contract retains demotes to absent (ADR-ERL2-035)",
    file: "packages/core/src/environment/telemetryObservation.ts",
    find: "  if (names.length > MAX_SERVICE_NAMES) return R.serviceNamesOverCardinality;",
    replace: "  if (names.length > MAX_SERVICE_NAMES && String(1) === \"2\") return R.serviceNamesOverCardinality;",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-TELEM-RETAIN: more distinct service names than the contract retains demotes",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-service-name-length",
    what: "a service name past the contract's length bound demotes to absent (ADR-ERL2-035)",
    file: "packages/core/src/environment/telemetryObservation.ts",
    find: "    if (name.length > MAX_SERVICE_NAME_CHARS) return R.serviceNameOverLength;",
    replace: "    if (name.length > MAX_SERVICE_NAME_CHARS && String(1) === \"2\") return R.serviceNameOverLength;",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-TELEM-RETAIN: a service name past the contract's length bound demotes",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-service-name-canonicalizable",
    what: "a service name the canonicalizer refuses demotes to absent (ADR-ERL2-035)",
    file: "packages/core/src/environment/telemetryObservation.ts",
    find: "    if (!isCanonicalizableString(name)) return R.serviceNameNotCanonicalizable;",
    replace: "    if (!isCanonicalizableString(name) && String(1) === \"2\") return R.serviceNameNotCanonicalizable;",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-TELEM-RETAIN: a service name the canonicalizer refuses demotes",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-count-representable",
    what: "a telemetry count outside the range the contract and the canonicalizer both represent demotes to absent, rather than reaching the hash (ADR-ERL2-035)",
    file: "packages/core/src/environment/telemetryObservation.ts",
    find: "    if (!Number.isInteger(count) || count < 0 || count > MAX_TELEMETRY_COUNT) {\n      return R.countNotRepresentable;\n    }",
    replace: "    if (String(1) === \"2\") {\n      return R.countNotRepresentable;\n    }",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    // This named two cases. The second one — a digit run long enough to reach
    // `Infinity` — no longer belongs to this guard: the trace-summary parser
    // refuses an unrepresentable count before it can be summed into a total, so
    // that case now passes under this mutation and is killed by
    // `telemetry-malformed-summary-is-not-a-zero` instead. The property did not
    // move out of the campaign, it moved earlier in the pipeline, and this row
    // is narrowed rather than left naming a case it cannot kill.
    mustFailCases: ["ATTR-TELEM-RETAIN: a count outside the contract's range demotes"],
    expect: "fail",
  },
  {
    id: "telemetry-collector-service-id",
    what: "a collector service id the contract's identifier pattern refuses demotes to absent (ADR-ERL2-035)",
    file: "packages/core/src/environment/telemetryObservation.ts",
    find: "  if (!SERVICE_ID.test(collector.serviceId)) return R.collectorIdentityOverBound;",
    replace: "  if (!SERVICE_ID.test(collector.serviceId) && String(1) === \"2\") return R.collectorIdentityOverBound;",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-TELEM-RETAIN: a collector service id the contract refuses demotes",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-collector-digest-cardinality",
    what: "more observed repo digests than the contract retains demotes to absent (ADR-ERL2-035)",
    file: "packages/core/src/environment/telemetryObservation.ts",
    find: "  if (collector.observedImageRepoDigests.length > MAX_REPO_DIGESTS) {\n    return R.collectorIdentityOverBound;\n  }",
    replace: "  if (String(1) === \"2\") {\n    return R.collectorIdentityOverBound;\n  }",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-TELEM-RETAIN: more observed repo digests than the contract retains demotes",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-collector-identity-bound",
    what: "a collector identity string past the contract's bound demotes to absent (ADR-ERL2-035)",
    file: "packages/core/src/environment/telemetryObservation.ts",
    find: "    if (verdict === \"over_bound\") return R.collectorIdentityOverBound;",
    replace: "    if (verdict === \"over_bound\" && String(1) === \"2\") return R.collectorIdentityOverBound;",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-TELEM-RETAIN: a collector identity string past its bound demotes",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-collector-identity-canonicalizable",
    what: "a collector identity string the canonicalizer refuses demotes to absent (ADR-ERL2-035)",
    file: "packages/core/src/environment/telemetryObservation.ts",
    find: "    if (verdict === \"not_canonicalizable\") return R.collectorIdentityNotCanonicalizable;",
    replace: "    if (verdict === \"not_canonicalizable\" && String(1) === \"2\") return R.collectorIdentityNotCanonicalizable;",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-TELEM-RETAIN: a collector identity string the canonicalizer refuses demotes",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-retention-failures-routable",
    what: "every failure of the retention path leaves as a code the caller's terminal can route, never as an uncatalogued throw before teardown_started (ADR-ERL2-035, EQ-L-004)",
    file: "packages/core/src/environment/telemetryObservation.ts",
    find: "    if (cause instanceof Erl2Error && cause.code === CODES.TEARDOWN_FAILED) throw cause;",
    replace: "    if (String(1) === String(1)) throw cause;",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-TELEM-RETAIN: a retention failure nothing anticipated still leaves as a routable teardown failure",
    ],
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

  // -- ADR-ERL2-027: one cleanup discipline, and an observed residue ---------
  {
    id: "unconditional-bounded-destroy",
    what: "the bounded invalid route derives its cleanup instead of destroying the environment (review P1-1/P1-5)",
    file: "packages/core/src/run/environmentCleanup.ts",
    // Restores `boundedEnvironmentCleanup` in the one respect that matters: the
    // non-emergency route swings a whole-environment `driver.destroy()` before
    // it reads the frontier it just froze. The per-action executor still runs
    // afterwards, so the patch compiles and the *only* thing that changes is
    // that an unauthorized aggregate dispatch happens first — which is the
    // defect, and which the frontier-unsafe survivor and the residue probe both
    // see.
    find: "  const safe = safeActions(frontier);\n  const attemptHashes: Hash[] = [];",
    replace:
      "  if (!emergency) ctx.driver.destroy({ runId: ctx.runId, operationId: \"op-invalid-destroy\" });\n" +
      "  const safe = safeActions(frontier);\n  const attemptHashes: Hash[] = [];",
    tests: ["tests/dist/adversarial/invalidCleanupDiscipline.test.js"],
    expect: "fail",
  },
  {
    id: "cleanup-residue-probe",
    what: "the substrate is re-observed after cleanup and the observation retained (ADR-ERL2-027 §4.3)",
    file: "packages/public-verifier/src/library/environmentDerivation.ts",
    // The verifier stops requiring the independent observation. Everything the
    // producer writes about its own residue then stands unchallenged, which is
    // the state §1.6 describes.
    find: "  const probeHash = single(roles, \"cleanup-residue-probe\");\n  if (probeHash === undefined) {",
    replace:
      "  const probeHash = single(roles, \"cleanup-residue-probe\");\n" +
      "  if (probeHash === undefined || String(1) !== \"2\") return;\n" +
      "  if (probeHash === undefined) {",
    tests: [
      "tests/dist/adversarial/invalidCleanupDiscipline.test.js",
      "tests/dist/adversarial/emergencyCleanupAdversarial.test.js",
    ],
    expect: "fail",
  },
  {
    id: "undeclared-destruction-detection",
    what: "a resource that vanished without an authorized action is a refusal (ADR-ERL2-027 §4.3)",
    file: "packages/core/src/environment/residueProbe.ts",
    // The arithmetic still runs; only the verdict is suppressed, so a resource
    // the frontier said not to touch can disappear and the probe reports
    // `clean`. This is the offline-invisible half of P1-1.
    find: "  if (undeclaredDestroyed.length > 0) {",
    replace: '  if (undeclaredDestroyed.length > 0 && String(1) === "2") {',
    tests: ["tests/dist/integration/cleanupDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "actions-agree-with-residue",
    what: "a reported outcome must agree with the substrate that was observed (ADR-ERL2-027 §4.6)",
    file: "packages/public-verifier/src/library/environmentDerivation.ts",
    find: "  for (const action of cleanup.actions) {\n    const target = targetOf.get(action.action_id);",
    replace:
      "  for (const action of [] as typeof cleanup.actions) {\n" +
      "    const target = targetOf.get(action.action_id);",
    tests: ["tests/dist/adversarial/invalidCleanupDiscipline.test.js"],
    expect: "fail",
  },
  {
    id: "invalid-finding-phase-gate",
    what: "the invalid terminal's finding names the gate its own phase falsifies (review P1-3)",
    file: "packages/core/src/evaluation/invalidityAttribution.ts",
    // Restores the branch-keyed answer: every phase gets the baseline gate,
    // which is what the producer did for five of the seven.
    find: "  const gate = ENVIRONMENT_PHASE_GATE[phase as EnvironmentFailurePhase];",
    replace: '  const gate = "environment-baseline-clean";',
    tests: [
      "tests/dist/integration/cleanupDerivation.test.js",
      "tests/dist/adversarial/invalidCleanupDiscipline.test.js",
    ],
    expect: "fail",
  },
  {
    id: "invalid-finding-lab-attribution",
    what: "a Lab environment failure cannot be attributed to the subject (ADR-ERL2-027 §4.5.2)",
    file: "packages/public-verifier/src/library/environmentDerivation.ts",
    // Repaired for ADR-ERL2-028: that package replaced the
    // `failed_phase.kind !== "lifecycle_phase"` early return this patch anchored
    // on with the cancellation / journey-execution branching, so the control had
    // been **silently not applying** ever since. It went unnoticed because the
    // full 47 were never re-run after the change — the lifecycle-ordering handoff
    // §9.2 says so in as many words, and this is what that costs.
    //
    // Anchored on the function's own first two lines now, which are the stable
    // part: a patch anchored on a branch is a patch that expires the next time
    // the branch is edited.
    find:
      "  const { record } = options;\n" +
      '  if (record.terminal_reason.kind !== "classified_failure") return;',
    replace:
      "  const { record } = options;\n" +
      '  if (String(1) !== "2") return;\n' +
      '  if (record.terminal_reason.kind !== "classified_failure") return;',
    tests: ["tests/dist/adversarial/invalidCleanupDiscipline.test.js"],
    expect: "fail",
  },
  {
    id: "foreign-resource-classification",
    what: "a resource that is not provably this run's is never an authorized target (review P1-5)",
    file: "packages/core/src/environment/frontier.ts",
    // The frontier stops re-deriving ownership and believes whatever it was
    // handed. Another run's resource then becomes an independently safe action,
    // which is the classification failure every downstream guard depends on not
    // happening.
    find: "    if (!owned) {",
    replace: '    if (!owned && String(1) === "2") {',
    tests: [
      "tests/dist/integration/cleanupDerivation.test.js",
      "tests/dist/adversarial/invalidCleanupDiscipline.test.js",
    ],
    expect: "fail",
  },

  // -- Step 4: lifecycle ordering and crash recovery (ADR-ERL2-028) ----------
  {
    id: "journey-prerequisite-matrix",
    what: "every journey intent enforces its own activation/cutoff prerequisites (review P1-9)",
    file: "packages/core/src/run/environmentRun.ts",
    // Removes the per-occurrence enforcement entirely. This is the defect itself:
    // without it a committed post-capture step runs before activation and before
    // the evidence cutoff, exactly as it did before this package.
    find: "    this.assertStepPrerequisites(step.intent, state);",
    replace: "    void this.assertStepPrerequisites;",
    tests: [
      "tests/dist/adversarial/lifecycleOrdering.test.js",
      "tests/dist/e2e/environmentRun.test.js",
    ],
    expect: "fail",
  },
  {
    id: "post-capture-activation-requirement",
    what: "a post-capture intent may not run before the challenge is activated",
    file: "packages/core/src/journey/prerequisites.ts",
    // Keeps the matrix and the enforcement, and drops only the three facts that
    // separate a post-capture intent from a setup one. A run can then reach
    // `exercise` with no activation receipt and no realized cutoff.
    //
    // The postimage here is `];`, which occurs ten times in this file — which is
    // exactly why the harness verifies the postimage **positionally** rather than
    // by counting occurrences, and why `uniquePostimage` is opt-in.
    find: '  "challenge_activation",\n  "evidence_cutoff",\n  "observation_bundle",\n];',
    replace: "];",
    tests: ["tests/dist/integration/journeyPrerequisites.test.js"],
    expect: "fail",
  },
  {
    id: "prerequisite-evidence-derivation",
    what: "prerequisites are answered from retained evidence, not from the departure state",
    file: "packages/core/src/journey/prerequisites.ts",
    // Every prerequisite becomes satisfied. The departure-state check survives, so
    // this isolates the half of the matrix that the state machine does *not*
    // already imply — and `step_outcome_frozen` is a legal post-capture departure
    // state, which is exactly why the state alone cannot be the gate.
    find: "  const unmet = row.requires.filter((prerequisite) => !SATISFIED_BY[prerequisite](evidence));",
    replace: "  const unmet = row.requires.filter(() => false);",
    tests: [
      "tests/dist/integration/journeyPrerequisites.test.js",
      "tests/dist/adversarial/lifecycleOrdering.test.js",
    ],
    expect: "fail",
  },
  {
    id: "refusal-before-cutoff-freeze",
    what: "every refusable input is resolved before the first retained byte (review P1-10)",
    file: "packages/core/src/run/environmentRun.ts",
    // Restores the original ordering: the comparison policy is resolved at its
    // freeze rather than up front, so a `journey` missing it freezes the cutoff
    // policy and only then refuses.
    find: "    const comparisonPolicy = this.comparisonPolicy();",
    replace: "    const comparisonPolicy = { get bytes() { return this; } } as never;",
    tests: ["tests/dist/adversarial/lifecycleOrdering.test.js"],
    expect: "fail",
  },
  {
    id: "lazy-operational-directories",
    what: "a refused command creates no substrate or reservation directory",
    file: "packages/core/src/environment/allocator.ts",
    // Puts the eager mkdir back in the constructor, which `openEnvironment` runs
    // for every command including the ones that refuse.
    find: "    this.ttlMs = options.ttlMs ?? 3_600_000;",
    replace: "    this.ttlMs = options.ttlMs ?? 3_600_000;\n    mkdirSync(this.root, { recursive: true, mode: 0o700 });",
    tests: ["tests/dist/adversarial/lifecycleOrdering.test.js"],
    expect: "fail",
  },
  {
    id: "cancellation-branch-classification",
    what: "the cancellation branch is derived from durable evidence, not one file's existence (review P1-2)",
    file: "packages/core/src/run/cancellationBranch.ts",
    // Reinstates the `existsSync` semantics: absence and unreadability become the
    // same answer, and the lifecycle witness is dropped. A live environment run
    // whose binding artifact is gone then takes the pre-environment branch and
    // freezes `not_required` over allocated resources.
    find: "  if (bindingPresent(runRoot)) return \"environment\";\n  if (lifecycleShowsEnvironment(runRoot)) return \"environment\";",
    replace:
      "  try {\n" +
      "    if (bindingPresent(runRoot)) return \"environment\";\n" +
      "  } catch {\n" +
      "    return \"pre_environment\";\n" +
      "  }",
    tests: ["tests/dist/adversarial/lifecycleOrdering.test.js"],
    expect: "fail",
  },
  {
    id: "cleanup-continuation",
    what: "a cancellation continues an in-flight cleanup instead of re-observing its frontier",
    file: "packages/core/src/run/environmentRun.ts",
    // Drops the adoption, so a cancellation during emergency cleanup freezes a
    // second frontier under a relabelled trigger and collides with the first.
    find: "    const alreadyFrozenFrontier = this.retainedResourceFrontier();",
    replace: "    const alreadyFrozenFrontier = undefined as ReturnType<typeof this.retainedResourceFrontier>;",
    tests: ["tests/dist/adversarial/lifecycleOrdering.test.js"],
    expect: "fail",
  },
  {
    id: "not-dispatched-proven",
    what: "a `declared` intent proves nothing was dispatched, so it is resumed rather than failed closed",
    file: "packages/core/src/run/mutationIntent.ts",
    // Removes the third reconciliation answer. A subject step interrupted between
    // its intent freeze and its dispatch marker then fails closed to an invalid
    // terminal over an operation that demonstrably never ran.
    find: '      if (existing.state === "declared") {',
    replace: '      if (existing.state === "declared" && String(1) === "2") {',
    tests: ["tests/dist/e2e/crashBoundaryMatrix.test.js"],
    expect: "fail",
  },
  {
    id: "crash-lease-reclamation",
    what: "a lease whose holder is gone is reclaimed, so a crashed run can be recovered at all",
    file: "packages/core/src/lifecycle/lease.ts",
    // Without it, every crash recovery waits out the five-minute TTL — so the
    // process that must reconcile the interrupted operation is refused before it
    // reads a single intent.
    find: "        if (!RunLease.ownerAlive(existing)) {",
    replace: '        if (!RunLease.ownerAlive(existing) && String(1) === "2") {',
    tests: [
      "tests/dist/integration/runLease.test.js",
      "tests/dist/e2e/crashBoundaryMatrix.test.js",
    ],
    expect: "fail",
  },
  {
    id: "invocation-count-not-dedup",
    what: "the crash matrix counts external invocations, and artifact deduplication is not a substitute",
    file: "packages/core/src/run/mutationIntent.ts",
    // **The control this package exists to run.** It removes reconciliation
    // entirely — every unsettled operation is re-dispatched — while leaving the
    // artifact store's duplicate refusal, the lifecycle log's `operation_id`
    // dedupe and the driver's own operation log completely intact.
    //
    // A suite that asserted "exactly one retained receipt" therefore still
    // passes. The invocation-count assertions must fail anyway, because the
    // external port really was entered twice. If this control kills nothing, the
    // matrix is counting artifacts and the exactly-once claim is unfounded.
    // Disables the condition's middle clause rather than the whole `if`. Replacing
    // the condition with `false` removes the `existing !== undefined` narrowing, so
    // the block below stops compiling under `strictNullChecks` — the same
    // narrowing trap that broke two controls in the 6.5-B campaign
    // (`remediation-6.5-invariants.md` §8). This keeps every identifier used and
    // every type narrowed, and still makes the condition unsatisfiable.
    find: '      existing.state !== "settled" &&',
    replace: '      String(1) === "2" &&',
    tests: ["tests/dist/e2e/crashBoundaryMatrix.test.js"],
    expect: "fail",
  },

  // -- ADR-ERL2-029: the cutoff, the payload root and the invalid-golden gate --
  {
    id: "cutoff-milestone-resolution",
    what: "the cutoff's runtime milestone is resolved, not merely named (review P2)",
    file: "packages/public-verifier/src/library/cutoffDerivation.ts",
    // Restores the pre-remediation posture: a well-formed hash is believed
    // without being resolved to the artifact it names. Any artifact of the right
    // schema stands in, which is exactly what "nothing resolved the hash" meant.
    //
    // Disabling the `if` instead — the obvious patch — does **not** compile: it
    // removes the `undefined` narrowing and the three uses of `found` below fail
    // `strictNullChecks`. That is the same trap that broke two controls in the
    // 6.5-B campaign (`remediation-6.5-invariants.md` §8) and one in the
    // lifecycle-ordering campaign, and it is the third time it has been hit. The
    // substitution keeps every identifier used and every type narrowed, and still
    // makes resolution meaningless.
    find: "  const found = index.tryGet(hash);",
    replace:
      "  const found =\n" +
      "    index.tryGet(hash) ?? index.all().find((a) => a.schemaVersion === schemaVersion);",
    tests: ["tests/dist/integration/cutoffDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "cutoff-bounds-derivation",
    what: "the derived warmup and observation windows are checked against the committed policy bounds",
    file: "packages/public-verifier/src/library/cutoffDerivation.ts",
    // Removes only the observation-window bounds, leaving resolution, binding,
    // clock-domain and divergence checks intact. A control that removed the whole
    // arithmetic would kill every case and prove nothing about which rule each
    // one measures.
    find: "  if (observationMs < policy.minimum_observation_ms) {",
    replace: "  if (String(1) === \"2\" && observationMs < policy.minimum_observation_ms) {",
    tests: ["tests/dist/integration/cutoffDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "cutoff-clock-divergence",
    what: "wall and monotonic views of the warmup interval must agree within the committed bound",
    file: "packages/public-verifier/src/library/cutoffDerivation.ts",
    find: "  if (Math.abs(warmupMs - monotonicElapsedMs) > policy.maximum_monotonic_wall_divergence_ms) {",
    replace:
      '  if (String(1) === "2" && Math.abs(warmupMs - monotonicElapsedMs) > policy.maximum_monotonic_wall_divergence_ms) {',
    tests: ["tests/dist/integration/cutoffDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "cutoff-lifecycle-reachability",
    what: "a cutoff input retained but never lifecycle-reached is refused",
    file: "packages/public-verifier/src/library/cutoffDerivation.ts",
    find: "  if (!reached.has(hash)) {",
    replace: '  if (String(1) === "2" && !reached.has(hash)) {',
    tests: ["tests/dist/integration/cutoffDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "payload-presence-accounting",
    what: "a declared subject-output payload must actually be retained (review P2)",
    file: "packages/public-verifier/src/library/payloadAccounting.ts",
    // Restores the referenced-bytes layer's "a missing reference may have been
    // scrubbed" allowance to the payload root, which is exactly the gap: that
    // allowance is right for `raw/` and wrong for a payload the terminal's own
    // manifest declares.
    find: "  for (const payload of declaredByPath.values()) {\n    const bytes = readDeclared(root, payload);",
    replace:
      "  for (const payload of [] as DeclaredPayload[]) {\n    const bytes = readDeclared(root, payload);",
    tests: ["tests/dist/adversarial/subjectOutputPayloads.test.js"],
    expect: "fail",
  },
  {
    id: "payload-directory-enumeration",
    what: "every file in the subject-output payload root is declared by a reached manifest",
    file: "packages/public-verifier/src/library/payloadAccounting.ts",
    // The other direction, and the one §24 names explicitly: skip the payload
    // directory enumeration. Presence checking stays intact, so only the
    // extra-file cases may die.
    find: "  for (const [relative, kind] of present) {",
    replace: "  for (const [relative, kind] of [] as [string, \"file\" | \"other\"][]) {\n    void present;",
    tests: ["tests/dist/adversarial/subjectOutputPayloads.test.js"],
    expect: "fail",
  },

  // -- ADR-ERL2-030: signer-inventory completeness, in all three layers -------
  //
  // The producer controls all substitute the field list rather than deleting the
  // loop, for the reason the cutoff controls record: removing a guard usually
  // removes a type narrowing too, and a patched tree that does not compile
  // measures nothing. Substituting the *set of fields the producer looks in* is
  // also the more faithful reproduction — the defect was never "no enumeration",
  // it was "an enumeration over one field name".
  //
  // All three share one preimage, `for (const field of AUTHORITY_SIGNATURE_FIELDS) {`,
  // which occurs exactly once in that file. The unique-target requirement is what
  // keeps that true: if a later package adds a second enumeration over the same
  // constant, these three become ambiguous and fail the campaign rather than
  // quietly measuring whichever one comes first.
  {
    id: "signer-producer-ordinary-signature",
    what: "the producer enumerates members whose authority field is `signature`",
    file: "packages/core/src/terminal/signerInventoryDerivation.ts",
    find: "  for (const field of AUTHORITY_SIGNATURE_FIELDS) {",
    replace: '  for (const field of ["root_signature", "wrapper_signature"] as const) {',
    tests: ["tests/dist/integration/signerInventoryDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "signer-producer-root-signature",
    what: "the producer enumerates `root_signature` members — the mirrored trust policy, on every run",
    file: "packages/core/src/terminal/signerInventoryDerivation.ts",
    find: "  for (const field of AUTHORITY_SIGNATURE_FIELDS) {",
    replace: '  for (const field of ["signature", "wrapper_signature"] as const) {',
    tests: ["tests/dist/integration/signerInventoryDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "signer-producer-wrapper-signature",
    what: "the producer enumerates `wrapper_signature` members — the review's original finding",
    file: "packages/core/src/terminal/signerInventoryDerivation.ts",
    find: "  for (const field of AUTHORITY_SIGNATURE_FIELDS) {",
    replace: '  for (const field of ["signature", "root_signature"] as const) {',
    tests: ["tests/dist/integration/signerInventoryDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "signer-producer-unknown-contract",
    what: "a signed contract the producer declares no role for stops finalization",
    file: "packages/core/src/terminal/signerInventoryDerivation.ts",
    // Keeps `role` a string and every use below type-correct, and still makes an
    // unclassified signed contract silently inventoried under a borrowed role.
    find: "    const role = PRODUCER_SIGNED_MEMBER_ROLES.get(artifact.schemaVersion);\n    if (role === undefined) {",
    replace:
      '    const role = PRODUCER_SIGNED_MEMBER_ROLES.get(artifact.schemaVersion) ?? "policy_author";\n' +
      '    if (String(1) === "2") {',
    tests: ["tests/dist/integration/signerInventoryDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "signer-producer-completeness-derivation",
    what: "`complete_for_terminal_chain` is derived from the actual set, not asserted",
    file: "packages/core/src/terminal/signerInventoryDerivation.ts",
    // The exact pre-remediation posture: a constant where a result belongs.
    find: "    completeForTerminalChain: ordered.length === seen.size && ordered.length > 0,",
    replace: "    completeForTerminalChain: true,",
    tests: ["tests/dist/integration/signerInventoryDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "signer-producer-finalization-gate",
    what: "an inventory the derivation cannot certify is refused rather than sealed",
    file: "packages/core/src/terminal/finalize.ts",
    find: "function assertInventoryComplete(complete: boolean, entryCount: number): void {\n  if (complete) return;",
    replace:
      "function assertInventoryComplete(complete: boolean, entryCount: number): void {\n" +
      '  if (complete || String(1) === "1") return;',
    tests: ["tests/dist/integration/signerInventoryDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "signer-producer-postfreeze-recheck",
    what: "completeness is re-established against the tree as it stands after the inventory is sealed",
    file: "packages/core/src/terminal/signerInventoryDerivation.ts",
    // Re-derives the listed set from the derivation instead of from the sealed
    // entries, which makes the comparison agree with itself by construction.
    find: "  const listed = new Set(entries.map((entry) => entry.artifactCoreHash as string));",
    replace:
      "  const listed = new Set(derivation.applicableMembers.map((member) => member.coreHash as string));\n" +
      "  void entries;",
    tests: ["tests/dist/integration/signerInventoryDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "signer-fixture-complete-set",
    what: "the fixture inventories every signed member it retains, rather than hand-writing one entry",
    file: "tests/support/fakeRun.ts",
    // Restores the shape the ledger measured: one entry, completeness asserted.
    find: "    entries: applicable.map((member) => ({",
    replace: "    entries: applicable.slice(0, 1).map((member) => ({",
    tests: ["tests/dist/e2e/preEnvironmentRun.test.js"],
    expect: "fail",
  },
  {
    id: "signer-verifier-trusts-producer-flag",
    what: "the verifier derives completeness instead of reading `complete_for_terminal_chain`",
    file: "packages/public-verifier/src/library/verify.ts",
    // The status quo ADR-ERL2-029 §9 rejected, restored exactly: the field is
    // `const: true`, so guarding the derivation on it disables the derivation.
    find:
      "  verifySignerInventoryCompleteness({\n    index,\n    trust,\n    lifecycle: options.lifecycle,\n" +
      '    runId: attestation.run_id,\n    terminalVariant: "pre_environment",',
    replace:
      "  if (!inventory.complete_for_terminal_chain) verifySignerInventoryCompleteness({\n    index,\n    trust,\n" +
      "    lifecycle: options.lifecycle,\n" +
      '    runId: attestation.run_id,\n    terminalVariant: "pre_environment",',
    tests: ["tests/dist/adversarial/signerInventoryCompleteness.test.js"],
    expect: "fail",
  },
  {
    id: "signer-verifier-missing-direction",
    what: "an applicable signed member with no inventory entry is refused (retained -> inventory)",
    file: "packages/public-verifier/src/library/inventoryCompleteness.ts",
    find: "  if (missing.length > 0) {",
    replace: '  if (String(1) === "2" && missing.length > 0) {',
    tests: ["tests/dist/adversarial/signerInventoryCompleteness.test.js"],
    expect: "fail",
  },
  {
    id: "signer-verifier-extra-detection",
    what: "an inventory entry that is not an applicable member is refused (inventory -> retained)",
    file: "packages/public-verifier/src/library/inventoryCompleteness.ts",
    find: "  if (extra.length > 0) {",
    replace: '  if (String(1) === "2" && extra.length > 0) {',
    tests: ["tests/dist/adversarial/signerInventoryCompleteness.test.js"],
    expect: "fail",
  },
  {
    id: "signer-verifier-duplicate-detection",
    what: "an applicable member inventoried twice is refused",
    file: "packages/public-verifier/src/library/inventoryCompleteness.ts",
    find: "  if (duplicates.length > 0) {",
    replace: '  if (String(1) === "2" && duplicates.length > 0) {',
    tests: ["tests/dist/adversarial/signerInventoryCompleteness.test.js"],
    expect: "fail",
  },
  {
    id: "signer-verifier-lifecycle-reachability",
    what: "an inventoried member no lifecycle event produced is refused",
    file: "packages/public-verifier/src/library/inventoryCompleteness.ts",
    find: "  if (reachabilityFailures.length > 0) {",
    replace: '  if (String(1) === "2" && reachabilityFailures.length > 0) {',
    tests: ["tests/dist/adversarial/signerInventoryCompleteness.test.js"],
    expect: "fail",
  },
  {
    id: "signer-verifier-member-run-binding",
    what: "a signed member belonging to another run is refused",
    file: "packages/public-verifier/src/library/inventoryCompleteness.ts",
    find: "  if (foreignRunMembers.length > 0) {",
    replace: '  if (String(1) === "2" && foreignRunMembers.length > 0) {',
    tests: ["tests/dist/adversarial/signerInventoryCompleteness.test.js"],
    expect: "fail",
  },
  {
    id: "signer-verifier-inventory-run-scope",
    what: "an inventory naming another run is refused even when every member hash resolves",
    file: "packages/public-verifier/src/library/inventoryCompleteness.ts",
    find: "  if (input.inventoryRunId !== input.runId) {",
    replace: '  if (String(1) === "2" && input.inventoryRunId !== input.runId) {',
    tests: ["tests/dist/adversarial/signerInventoryCompleteness.test.js"],
    expect: "fail",
  },
  {
    id: "signer-verifier-entry-signature-binding",
    what: "an entry whose declared signature hash contradicts the artifact is refused",
    file: "packages/public-verifier/src/library/inventoryCompleteness.ts",
    // The one entry field `verifySignedMembers` does not cross-check, so this
    // control isolates the completeness layer rather than an inherited rule.
    find: "    if (entry.signature_sha256 !== member.signedHash) {",
    replace: '    if (String(1) === "2" && entry.signature_sha256 !== member.signedHash) {',
    tests: ["tests/dist/adversarial/signerInventoryCompleteness.test.js"],
    expect: "fail",
  },
  {
    id: "signer-invalid-record-inventory",
    what: "an invalid record that retains a signer inventory is refused",
    file: "packages/public-verifier/src/library/verify.ts",
    find:
      '  const strayInventories = index.ofSchema("signer-inventory/v2");\n  if (strayInventories.length > 0) {',
    replace:
      '  const strayInventories = index.ofSchema("signer-inventory/v2");\n' +
      '  if (String(1) === "2" && strayInventories.length > 0) {',
    tests: ["tests/dist/adversarial/signerInventoryCompleteness.test.js"],
    expect: "fail",
  },
  {
    id: "signer-verifier-wrapper-field",
    what: "the verifier recognizes wrapper-signed members as applicable inventory members",
    file: "packages/public-verifier/src/library/signedMembers.ts",
    // Removing wrapper recognition on the *verifier* side does not hide the
    // member — it makes the honest environment inventory look like it lists
    // something inapplicable, which is why the environment battery is the target.
    find: "const SIGNATURE_FIELDS = AUTHORITY_SIGNATURE_FIELDS;",
    replace: 'const SIGNATURE_FIELDS = ["signature", "root_signature"] as const;',
    tests: ["tests/dist/adversarial/signerInventoryEnvironment.test.js"],
    expect: "fail",
  },
  {
    id: "signer-verifier-environment-completeness",
    what: "the environment branch derives completeness too, not only the pre-environment one",
    file: "packages/public-verifier/src/library/verify.ts",
    find:
      "  verifySignerInventoryCompleteness({\n    index,\n    trust,\n    lifecycle: options.lifecycle,\n" +
      '    runId: attestation.run_id,\n    terminalVariant: "environment",',
    replace:
      "  if (!inventory.complete_for_terminal_chain) verifySignerInventoryCompleteness({\n    index,\n    trust,\n" +
      "    lifecycle: options.lifecycle,\n" +
      '    runId: attestation.run_id,\n    terminalVariant: "environment",',
    tests: ["tests/dist/adversarial/signerInventoryEnvironment.test.js"],
    expect: "fail",
  },
  // -- ADR-ERL2-031: the signed evidence-window commitment -------------------
  //
  // Anchors are things each invariant owns — a named comparison, a role-table
  // row, the `produced` entry itself — rather than a line that could become one
  // of several. `NC-CAMPAIGN` re-checks every one against real source on each
  // `npm test`, so an anchor that stops being unique fails in seconds rather than
  // in a four-hour campaign.
  {
    id: "window-producer-lifecycle-reach",
    what: "the evidence-window commitment is reached by the lifecycle event that produced it",
    file: "packages/core/src/run/environmentRun.ts",
    // Relabels the `produced` row rather than deleting the freeze. Deleting the
    // freeze would kill every window case at once and prove nothing about which
    // rule each measures; relabelling isolates *reachability* from *presence*,
    // which is the snapshot-only shape the closure refuses everywhere else.
    find: '          artifact_role: "evidence-window-commitment",',
    replace: '          artifact_role: "evidence-window-commitment-unreached",',
    tests: ["tests/dist/adversarial/evidenceWindowCommitment.test.js"],
    expect: "fail",
  },
  {
    id: "window-producer-uses-frozen-commitment",
    what: "the cutoff is built from the frozen commitment, not from a mutable constant",
    file: "packages/core/src/run/environmentRun.ts",
    // **The control this package exists to run.** It restores the composition
    // constants ADR-ERL2-031 removed: the cutoff is rebuilt from module-level
    // numbers instead of from the signed commitment the run froze. The bytes an
    // offline reader holds then stop governing the bytes the producer writes,
    // which is the residual restored under a different name.
    // The substituted constants must not preserve the **sum**. The first version
    // of this control used 2 000 / 4 000, and 2 000 + 4 000 is 1 000 + 5 000, so
    // the derived cutoff instant was byte-identical and the control scored
    // 29 pass / 0 fail against an `expect: "fail"`. It read as a guard that is not
    // load-bearing; it was a patch that changed nothing.
    //
    // 2 000 / 3 000 moves the cutoff a second earlier while keeping both
    // durations inside the policy bounds, so `realizeCutoff` still succeeds and
    // only the comparison against the frozen commitment can catch it.
    find: "      warmupMs: commitment.warmup_ms,\n      observationMs: commitment.observation_ms,",
    replace: "      warmupMs: 2_000,\n      observationMs: 3_000,",
    tests: [
      "tests/dist/adversarial/evidenceWindowCommitment.test.js",
      "tests/dist/e2e/environmentRun.test.js",
    ],
    expect: "fail",
  },
  {
    id: "window-producer-milestone-boundary",
    what: "the observed milestone must land on the committed warmup boundary",
    file: "packages/core/src/capture/evidenceWindow.ts",
    find: "  if (observedWarmupMs !== commitment.warmup_ms) {",
    replace: '  if (String(1) === "2" && observedWarmupMs !== commitment.warmup_ms) {',
    tests: ["tests/dist/integration/evidenceWindowDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "window-producer-policy-bounds",
    what: "a configured window outside the policy's committed bounds is refused before it is signed",
    file: "packages/core/src/capture/evidenceWindow.ts",
    find: "  if (input.warmupMs > policy.maximum_warmup_ms) {",
    replace: '  if (String(1) === "2" && input.warmupMs > policy.maximum_warmup_ms) {',
    tests: ["tests/dist/integration/evidenceWindowDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "window-producer-whole-second-durations",
    what: "a sub-second window is refused, because its derived instant is not representable",
    file: "packages/core/src/capture/evidenceWindow.ts",
    // `Instant` is second-precision and the renderer truncates rather than
    // rounding, so a 900 ms warmup would render an instant disagreeing with its
    // own arithmetic by 900 ms — silently.
    find: "  if (value % MS_PER_SECOND !== 0) {",
    replace: '  if (String(1) === "2" && value % MS_PER_SECOND !== 0) {',
    tests: ["tests/dist/integration/evidenceWindowDerivation.test.js"],
    expect: "fail",
  },
  {
    id: "window-verifier-requires-commitment",
    what: "a run that started traffic and retains no commitment is refused",
    file: "packages/public-verifier/src/library/windowDerivation.ts",
    // Re-pointed after the first campaign measured it.
    //
    // It originally disabled `retained.length === 0` in `windowDerivation.ts`,
    // and scored 0 pass / 0 fail — the patched tree left `retained[0]` undefined,
    // the CLI died on a TypeError rather than refusing, and every case in the
    // file was cancelled. That is not a measurement, and the classifier now says
    // so instead of reading it as "nothing failed".
    //
    // The requirement that actually fires on a missing commitment is the
    // conditional role check in `deriveEnvironmentSemantics`, which the closure
    // reaches first. `windowDerivation.ts`'s own `retained.length === 0` refusal
    // is defence for callers that run no closure; it is behind this rule on both
    // shipped branches, and the ledger records that rather than claiming two
    // kills for one guard.
    // Returns `undefined` rather than making the condition unsatisfiable: leaving
    // `retained[0]` undefined crashed the CLI on a TypeError instead of refusing,
    // and a control that crashes the process has measured nothing. This keeps
    // every type sound and still accepts a terminal that started traffic and
    // committed no window.
    find: "  if (retained.length === 0) {",
    replace: '  if (retained.length === 0) return undefined;\n  if (String(1) === "2") {',
    tests: ["tests/dist/adversarial/evidenceWindowCommitment.test.js"],
    expect: "fail",
  },
  {
    id: "window-verifier-exact-cutoff",
    what: "the verifier compares the exact rederived cutoff, not merely the committed bounds",
    file: "packages/public-verifier/src/library/windowDerivation.ts",
    // **The control ADR-ERL2-031 §10 singles out.** Removing this comparison
    // restores ADR-ERL2-029's bounds-only posture exactly, so a within-bounds
    // shifted window — warmup 1s -> 2s, observation 5s -> 4s, milestone moved to
    // match, commitment untouched — must verify again. If this control kills
    // nothing, the exact derivation is not doing the work the ADR claims and the
    // residual is still open.
    find: "  if (derivedCutoffMs !== cutoffMs) {",
    replace: '  if (String(1) === "2" && derivedCutoffMs !== cutoffMs) {',
    tests: ["tests/dist/adversarial/evidenceWindowCommitment.test.js"],
    expect: "fail",
  },
  {
    id: "window-verifier-exact-milestone",
    what: "the milestone must land exactly on the committed warmup boundary",
    file: "packages/public-verifier/src/library/windowDerivation.ts",
    find: "  if (derivedMilestoneMs !== milestoneMs) {",
    replace: '  if (String(1) === "2" && derivedMilestoneMs !== milestoneMs) {',
    tests: ["tests/dist/adversarial/evidenceWindowCommitment.test.js"],
    expect: "fail",
  },
  {
    id: "window-verifier-capture-window",
    what: "every source snapshot's window must close at the committed cutoff",
    file: "packages/public-verifier/src/library/windowDerivation.ts",
    // Recorded as `expect: "pass"` because it is, not because it should be.
    //
    // Building the mutation needs a snapshot reseal, which moves the observation
    // bundle that cites it, the canonical evidence envelope and the adapter
    // translation receipt — and the terminal then refuses at the closure with
    // three unaccounted artifacts, long before the window derivation runs. The
    // rule is real and is covered by the pure cases in
    // `evidenceWindowDerivation.test.ts`; what is missing is an end-to-end
    // mutation that reaches it, and saying so is better than a control that
    // reads as evidence and measures a rule that fires first.
    find: "    if (toMs !== derivedCutoffMs) {",
    replace: '    if (String(1) === "2" && toMs !== derivedCutoffMs) {',
    tests: ["tests/dist/adversarial/evidenceWindowCommitment.test.js"],
    expect: "pass",
    note: "no end-to-end mutation reaches it; the closure refuses a resealed snapshot chain first",
  },
  {
    id: "window-verifier-policy-binding",
    what: "the commitment must name the cutoff policy the cutoff was derived under",
    file: "packages/public-verifier/src/library/windowDerivation.ts",
    find: "  if (commitment.cutoff_policy_hash !== cutoff.policy_hash) {",
    replace: '  if (String(1) === "2" && commitment.cutoff_policy_hash !== cutoff.policy_hash) {',
    tests: ["tests/dist/adversarial/evidenceWindowCommitment.test.js"],
    expect: "fail",
  },
  {
    id: "window-verifier-process-binding",
    what: "the commitment must name the process-start receipt the window is measured from",
    file: "packages/public-verifier/src/library/windowDerivation.ts",
    find: "  if (commitment.process_start_receipt_hash !== cutoff.process_start_receipt_hash) {",
    replace:
      '  if (String(1) === "2" && commitment.process_start_receipt_hash !== cutoff.process_start_receipt_hash) {',
    tests: ["tests/dist/adversarial/evidenceWindowCommitment.test.js"],
    expect: "fail",
  },
  {
    id: "window-verifier-pre-capture-ordering",
    what: "a commitment frozen after the capture it governs is refused",
    file: "packages/public-verifier/src/library/windowDerivation.ts",
    find: "    if (at >= 0 && at < producedAt) {",
    replace: '    if (String(1) === "2" && at >= 0 && at < producedAt) {',
    tests: ["tests/dist/adversarial/evidenceWindowCommitment.test.js"],
    expect: "fail",
  },
  {
    id: "window-signer-inventory-inclusion",
    what: "the commitment participates in signer-inventory completeness like any signed member",
    file: "packages/core/src/terminal/signerInventoryDerivation.ts",
    // Removes exactly one row from the producer's role table. A signed contract
    // with no declared role is a hard refusal, so this measures that the new
    // contract goes through the *general* derivation — a special case for it
    // would prove only that the special case works.
    find: '  ["evidence-window-commitment/v1", "policy_author"],',
    replace: "",
    // Measured, and re-pointed once. `signerInventoryDerivation.test.js` is a
    // **pure** suite: it builds its own fixtures and none of them retains an
    // evidence-window commitment, so removing the role row changed nothing there
    // and the control scored 17 pass / 0 fail. The suites that retain one are the
    // end-to-end battery — where the producer refuses to finalize a real
    // environment run it cannot classify — and the architecture case that pins
    // the two role tables in agreement.
    tests: [
      "tests/dist/architecture/evidenceWindowIndependence.test.js",
      "tests/dist/adversarial/evidenceWindowCommitment.test.js",
    ],
    expect: "fail",
  },
  {
    id: "window-signer-role-separation",
    what: "the window is signed by policy_author, never by a clock-stamping role",
    file: "packages/public-verifier/src/library/signedMembers.ts",
    // Grants the window to the traffic supervisor — the party that signs the
    // instant the window is measured *from*. A signer that both chooses the
    // window and stamps its origin can move both together and leave the
    // arithmetic closing, which is the residual under another name
    // (ADR-ERL2-031 §4).
    find: '    { role: "policy_author", securityTimestampField: "committed_at" },',
    replace: '    { role: "traffic_supervisor", securityTimestampField: "committed_at" },',
    tests: ["tests/dist/adversarial/evidenceWindowCommitment.test.js"],
    expect: "fail",
  },

  // -- Step 6B: the four producer evidence boundaries ------------------------
  //
  // The review's producer cluster was not "these scans are missing"; it was that
  // each scan inspected something other than what crossed the boundary. So each
  // control below disables exactly the byte-level rule, and each names a test
  // that plants its leak in admitted data or in the subject's own bytes and
  // drives the shipped binary. A control killed by an earlier guard would prove
  // that the boundary is covered by something else, not that this rule works, so
  // every designated case asserts the *surface or code the intended rule emits*.
  {
    id: "mounted-file-byte-scan",
    what: "the bytes an adapter can mount are scanned before they are published",
    file: "packages/core/src/run/workspace.ts",
    // Deletes the scan and leaves the publication. The declared postimage keeps
    // `bytes` referenced so the surrounding function still typechecks under
    // `noUnusedLocals`: a patched tree that does not compile measures nothing.
    find: [
      "    assertNoCanaryLeak(",
      '      [{ surface: "mounted_file" as const, label, bytes }],',
      "      this.knownCanaryIds(),",
      "    );",
    ].join("\n"),
    replace: "    void label;",
    tests: ["tests/dist/e2e/environmentEvidenceBoundaries.test.js"],
    mustFail: ["tests/dist/e2e/environmentEvidenceBoundaries.test.js"],
    mustFailCases: [
      "EB-MOUNT: a canary in the mounted file's bytes refuses before the adapter is dispatched",
      "EB-MOUNT: the run cannot step past a refused mount by retrying it",
    ],
    expect: "fail",
  },
  {
    id: "lab-telemetry-oracle-scan",
    what: "Lab telemetry is scanned before one byte of it is retained",
    file: "packages/core/src/capture/capture.ts",
    // The single scanner both call sites share, so this disables the production
    // `lab_telemetry` scan everywhere rather than one of two copies.
    find: "  assertNoCanaryLeak(scanTargets, knownCanaryIds);",
    replace: "  void scanTargets;\n  void knownCanaryIds;",
    tests: ["tests/dist/e2e/environmentEvidenceBoundaries.test.js"],
    mustFail: ["tests/dist/e2e/environmentEvidenceBoundaries.test.js"],
    mustFailCases: [
      "EB-TELEMETRY: a canary in the telemetry bytes refuses before the telemetry is retained",
      "EB-TELEMETRY: a refused capture cannot be stepped past by retrying observe",
      "EB-TELEMETRY: the run still reaches exactly one invalid terminal that verifies offline",
    ],
    expect: "fail",
  },
  {
    id: "subject-output-secret-canary-scan",
    what: "a secret canary in retained subject-output bytes refuses before the freeze",
    file: "packages/core/src/adapter/outputFreezer.ts",
    find: [
      "    if (counts.secretCanaries > 0) {",
      "      throw new Erl2Error(",
      "        CODES.SECRET_CANARY_IN_SUBJECT_OUTPUT,",
      "        `a secret canary reached retained subject output at ${payload.path}`,",
      '        { owner: "lab" },',
      "      );",
      "    }",
    ].join("\n"),
    replace: "",
    tests: ["tests/dist/e2e/environmentEvidenceBoundaries.test.js"],
    mustFail: ["tests/dist/e2e/environmentEvidenceBoundaries.test.js"],
    mustFailCases: [
      "EB-OUTPUT: a secret canary in the subject's output bytes refuses before the freeze",
    ],
    expect: "fail",
  },
  {
    id: "subject-output-forbidden-identifier-scan",
    what: "a forbidden identifier in retained subject-output bytes refuses before the freeze",
    file: "packages/core/src/adapter/outputFreezer.ts",
    find: [
      "    if (counts.forbiddenIdentifiers > 0) {",
      "      throw new Erl2Error(",
      "        CODES.SECRET_PLAINTEXT_IN_CONTRACT,",
      "        `retained subject output at ${payload.path} carries a forbidden identifier`,",
      '        { owner: "lab" },',
      "      );",
      "    }",
    ].join("\n"),
    replace: "",
    tests: ["tests/dist/e2e/environmentEvidenceBoundaries.test.js"],
    mustFail: ["tests/dist/e2e/environmentEvidenceBoundaries.test.js"],
    mustFailCases: [
      "EB-OUTPUT: a forbidden identifier in the subject's output bytes refuses before the freeze",
    ],
    expect: "fail",
  },
  {
    id: "subject-output-declared-byte-ceiling",
    what: "the declared output ceiling is compared with the bytes the subject produced",
    file: "packages/core/src/adapter/outputFreezer.ts",
    // `String(1) === "2"` rather than `false`: a literal `false` lets TypeScript
    // drop the branch and stop narrowing, and the control then reports a build
    // failure instead of measuring anything.
    find: "  if (total > declaredOutputBytes) {",
    replace: '  if (String(1) === "2") {\n    void total;\n    void declaredOutputBytes;',
    tests: ["tests/dist/e2e/environmentEvidenceBoundaries.test.js"],
    mustFail: ["tests/dist/e2e/environmentEvidenceBoundaries.test.js"],
    mustFailCases: [
      "EB-SIZE: one byte over the declared ceiling refuses before the manifest freezes",
    ],
    expect: "fail",
  },
  {
    id: "subject-output-byte-total-counts-payloads",
    what: "the byte total is summed from the payloads, not read off a descriptor",
    file: "packages/core/src/adapter/outputFreezer.ts",
    // A subtler mutation than deleting the comparison: the ceiling still runs,
    // and the number it is given is wrong. Counting *references* instead of
    // bytes is the exact shape the review found on this surface — a bound
    // enforced against a proxy for the thing it governs.
    find: "    total += payload.bytes.byteLength;",
    replace: "    total += payload.path.length;",
    tests: ["tests/dist/e2e/environmentEvidenceBoundaries.test.js"],
    mustFail: ["tests/dist/e2e/environmentEvidenceBoundaries.test.js"],
    mustFailCases: [
      "EB-SIZE: one byte over the declared ceiling refuses before the manifest freezes",
    ],
    expect: "fail",
  },

  // -- stabilization: the pre-environment bundle's run binding ---------------
  //
  // Found by the R-02 sabotage work rather than by design review: mutating the
  // valid golden's top-level `run_id` and recomputing `bundle.core_hash` gave a
  // self-consistent document the verifier accepted at exit 0 / `valid`. The
  // environment branch had always refused it; the pre-environment branch had
  // not.
  {
    id: "pre-environment-bundle-run-binding",
    what: "a pre-environment bundle must name the run its signed attestation names",
    file: "packages/public-verifier/src/library/verify.ts",
    // The identical comparison now exists on both branches, so the preimage
    // carries the following comment line to name *this* one. Without it the
    // targeting layer would refuse the control as ambiguous — which is the
    // behaviour that exists to stop a control silently measuring the wrong
    // occurrence.
    find: [
      "  if (attestation.run_id !== bundle.run_id) {",
      "    throw new Erl2Error(",
      "      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,",
      '      "the bundle and the attestation name different runs",',
      "    );",
      "  }",
      "",
      "  // Signer inventory: recomputed, never trusted.",
    ].join("\n"),
    // `bundle` stays referenced so the patched tree still typechecks under
    // `noUnusedLocals`; a build failure would measure nothing.
    replace: "  void bundle.run_id;\n\n  // Signer inventory: recomputed, never trusted.",
    uniquePostimage: true,
    tests: ["tests/dist/adversarial/preEnvironmentBundleRunBinding.test.js"],
    mustFail: ["tests/dist/adversarial/preEnvironmentBundleRunBinding.test.js"],
    mustFailCases: [
      "RUNBIND: a self-consistent bundle naming a different run than its attestation is refused",
    ],
    expect: "fail",
  },

  // -- ERL2-OQ-005 trust boundaries -----------------------------------------
  //
  // Three guards, three controls. Each one was a place where a *name* or a
  // *retained file* stood in for an observation, so each control removes exactly
  // the observation and names the case that must then stop refusing.

  {
    id: "compose-ownership-label-verification",
    what: "an expected container name is not ownership: all three labels must be this run's",
    file: "packages/core/src/environment/composeDriver.ts",
    // Removes only the label half of the verdict, leaving the image half intact,
    // so the control measures ownership rather than the whole check at once.
    find: [
      "      if (observed.runLabel !== this.runId) violations.push(VIOLATION_RUN_LABEL);",
      "      if (observed.driverLabel !== COMPOSE_DRIVER_ID) violations.push(VIOLATION_DRIVER_LABEL);",
      "      if (observed.projectLabel !== this.project) violations.push(VIOLATION_PROJECT_LABEL);",
    ].join("\n"),
    // The three violation constants stay referenced so the patched tree still
    // typechecks under `noUnusedLocals`.
    replace: "      void [VIOLATION_RUN_LABEL, VIOLATION_DRIVER_LABEL, VIOLATION_PROJECT_LABEL];",
    tests: ["tests/dist/adversarial/composeSubstrate.test.js"],
    mustFail: ["tests/dist/adversarial/composeSubstrate.test.js"],
    mustFailCases: [
      "COMPOSE-ADV: an expected container carrying another run's run_id label is refused",
      "COMPOSE-ADV: an expected container carrying a foreign driver_id label is refused",
      "COMPOSE-ADV: an expected container carrying a foreign Compose project label is refused",
      "COMPOSE-ADV: an expected container MISSING an ownership label is refused",
    ],
    expectedSkips: RENDERED_TOPOLOGY_SKIP,
    expect: "fail",
  },
  {
    id: "compose-running-image-verification",
    what: "the running image must resolve, through Docker, to the locked service/platform digest",
    file: "packages/core/src/environment/composeDriver.ts",
    // Reverts the verdict to the shape the reproduced defect had: the observation
    // is still recorded, but nothing is derived from it.
    find: "      if (!image.matchesLockedDigest) violations.push(VIOLATION_IMAGE);",
    replace: "      void [image, VIOLATION_IMAGE];",
    tests: ["tests/dist/adversarial/composeSubstrate.test.js"],
    mustFail: ["tests/dist/adversarial/composeSubstrate.test.js"],
    mustFailCases: [
      "COMPOSE-ADV: an expected container name running an image the lock does not pin is refused",
      "COMPOSE-ADV: an expected container name whose image cannot be resolved at all is refused",
    ],
    expectedSkips: RENDERED_TOPOLOGY_SKIP,
    expect: "fail",
  },
  {
    id: "compose-endpoint-live-revalidation",
    what: "a retained endpoint record never authorizes egress on its own",
    file: "packages/core/src/environment/composeDriver.ts",
    // Removes the live re-observation and returns the record's own contents, which
    // is exactly what the defect did: the file became the authorization.
    find: [
      "  const inspected = docker.run({",
      '    args: ["container", "inspect", expectedContainer, "--format", "{{json .}}"],',
      "    timeoutMs: 60_000,",
      "  });",
      "  if (inspected.status !== 0) return undefined;",
    ].join("\n"),
    // `docker` stays referenced so the patched tree typechecks; the inspection's
    // result is simply no longer consulted.
    replace: [
      "  const inspected = docker.run({",
      '    args: ["container", "inspect", expectedContainer, "--format", "{{json .}}"],',
      "    timeoutMs: 60_000,",
      "  });",
      "  if (inspected.status !== 0) return { host: LOOPBACK_HOST, port, container: expectedContainer };",
    ].join("\n"),
    tests: ["tests/dist/adversarial/composeEndpointEgress.test.js"],
    mustFail: ["tests/dist/adversarial/composeEndpointEgress.test.js"],
    mustFailCases: [
      "COMPOSE-EGRESS-ADV: a stale record surviving teardown grants nothing",
      "COMPOSE-EGRESS-ADV: a record whose container no longer exists grants nothing",
    ],
    expect: "fail",
  },
  {
    id: "loopback-egress-host-validation",
    what: "a loopback egress allowlist may name 127.0.0.1 and nothing else",
    file: "packages/core/src/adapter/egress.ts",
    find: "  if (host !== CANONICAL_LOOPBACK_HOST) {",
    replace: '  if (host !== CANONICAL_LOOPBACK_HOST && String(1) === "2") {',
    tests: ["tests/dist/adversarial/composeEndpointEgress.test.js"],
    mustFail: ["tests/dist/adversarial/composeEndpointEgress.test.js"],
    mustFailCases: ["COMPOSE-EGRESS-ADV: loopbackEgressPolicy refuses any host but 127.0.0.1"],
    expect: "fail",
  },
  {
    id: "endpoint-locked-image-verification",
    what: "an endpoint is authorized only for a container running the locked image",
    file: "packages/core/src/environment/composeDriver.ts",
    // Removes only the image leg of the endpoint authorization, leaving the label,
    // state and binding checks intact, so the control measures the image rule alone.
    find: "  if (!image.matchesLockedDigest) return undefined;",
    replace: "  void image;",
    tests: ["tests/dist/adversarial/composeEndpointEgress.test.js"],
    mustFail: ["tests/dist/adversarial/composeEndpointEgress.test.js"],
    mustFailCases: [
      "COMPOSE-EGRESS-ADV: the exact expected container running a substituted image grants nothing",
      "COMPOSE-EGRESS-ADV: an unresolvable pinned image grants nothing",
      "COMPOSE-EGRESS-ADV: image id and repository digest disagreeing grants nothing",
    ],
    expect: "fail",
  },
  {
    id: "endpoint-exact-port-binding",
    what: "authorization requires 8090/tcp on 127.0.0.1 at exactly the recorded host port",
    file: "packages/core/src/environment/composeDriver.ts",
    // Reverts to the loose rule the defect had: any published host port matching the
    // recorded number, under any container port, on any interface.
    find: [
      "  if (loopbackHostPort(observedBindings(raw.NetworkSettings?.Ports), OTEL_DEMO_ENDPOINT_CONTAINER_PORT) !== port) {",
      "    return undefined;",
      "  }",
    ].join("\n"),
    replace: [
      "  const anyPublished = observedBindings(raw.NetworkSettings?.Ports).map((b) => b.hostPort);",
      "  void OTEL_DEMO_ENDPOINT_CONTAINER_PORT;",
      "  void loopbackHostPort;",
      "  if (!anyPublished.includes(port)) {",
      "    return undefined;",
      "  }",
    ].join("\n"),
    tests: ["tests/dist/adversarial/composeEndpointEgress.test.js"],
    mustFail: ["tests/dist/adversarial/composeEndpointEgress.test.js"],
    mustFailCases: [
      "COMPOSE-EGRESS-ADV: the recorded port published from the WRONG container port grants nothing",
      "COMPOSE-EGRESS-ADV: a binding on any interface but 127.0.0.1 grants nothing",
      "COMPOSE-EGRESS-ADV: an unrelated published binding does not stand in for the endpoint's",
    ],
    expect: "fail",
  },
  {
    id: "substrate-loopback-only-rendered",
    what: "the rendered Compose configuration publishes one loopback port and nothing else",
    file: "environments/otel-demo/compose/erl2-overlay.yaml",
    // Restores upstream's exposure for the collector: `!reset` removed its
    // 4317/4318 publication, and without it Compose merges upstream's entries back
    // in — published on every interface, with no host_ip.
    find: "    # No host publication at all. Reachable only on the Compose network.\n    ports: !reset []\n",
    replace: "",
    tests: ["tests/dist/adversarial/composeSubstrate.test.js"],
    mustFail: ["tests/dist/adversarial/composeSubstrate.test.js"],
    mustFailCases: [
      "COMPOSE-ADV: the RENDERED configuration publishes one loopback port and nothing else",
    ],
    // The designated case renders the real merged Compose configuration, which
    // needs upstream's `.env` and `compose.yaml`. `environments/otel-demo/upstream/`
    // is git-ignored, so a worktree checked out at HEAD does not carry it and the
    // case skips itself. Declaring the prerequisite is what lets the campaign
    // provision it — and, when it genuinely cannot be provisioned, record
    // `unmeasured_here` instead of the false disagreement the review reproduced.
    requiresPrerequisite: "otel-demo-upstream",
    expect: "fail",
    note: "the overlay is a locked configuration file, so this control also moves a config hash; the topology assertion is what it measures",
  },

  // -- the container-backed sandbox launcher (ERL2-OQ-008 gate 2, ADR-ERL2-034)
  //
  // The launcher's risk is that it makes an overclaim cheap: before it,
  // `sandboxControlReport("container")` threw and there was nothing to get
  // wrong; now thirteen entries can read `enforced`. Each control below removes
  // one of the things standing between that and a false attestation.

  {
    id: "container-profile-requires-derivation",
    what: "the container profile is refused until a qualification is derived for this host (ADR-ERL2-034)",
    file: "packages/core/src/adapter/sandbox.ts",
    // Lets any caller use the profile with no activation at all, which is the
    // pre-derivation state of every host that never ran the probe suite.
    find: [
      "  if (activation === undefined || activation.state !== CONTAINER_PROFILE_ENABLED_STATE) {",
      "    throw new Erl2Error(",
      "      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,",
      "      `sandbox profile ${profile} is ${CONTAINER_PROFILE_STATE}: no qualification was derived for this host, so nothing has established that the substrate enforces anything or that an adapter could be started inside it. It cannot be silently downgraded to local-process.`,",
      "    );",
      "  }",
    ].join("\n"),
    // Returns instead of throwing, keeping `assertQualified(activation)` below
    // reachable and type-correct: the control removes the refusal, not the
    // whole function.
    replace: ["  if (activation === undefined) {", "    return;", "  }"].join("\n"),
    tests: ["tests/dist/adversarial/containerSandboxProfile.test.js"],
    mustFail: ["tests/dist/adversarial/containerSandboxProfile.test.js"],
    // Only the first case: with the guard gone the host constructor still
    // refuses, because it has no adapter package to mount — a different
    // refusal for a different reason, and naming it here would credit this
    // control with a kill it did not make.
    mustFailCases: [
      "CONTAINER-PROFILE: with nothing derived, the profile is refused and reports why",
    ],
    expect: "fail",
  },
  {
    id: "container-profile-substrate-qualification",
    what: "the profile re-derives the qualification — drift, suite digest, lock binding and twenty observed controls — before it activates (ADR-ERL2-034)",
    file: "packages/core/src/adapter/sandbox.ts",
    // The single call that carries substrate drift, probe-suite drift,
    // probe-to-lock binding and the observed-not-mocked rule. `void` keeps the
    // import used so the patched tree still compiles.
    find: [
      "  assertQualifiedForExecution({",
      '    profile: "container",',
      "    lock: input.lock,",
      "    observed: input.observed,",
      "    probeResults: input.probeResults,",
      "  });",
    ].join("\n"),
    replace: "  void assertQualifiedForExecution;",
    tests: ["tests/dist/adversarial/containerSandboxProfile.test.js"],
    mustFail: ["tests/dist/adversarial/containerSandboxProfile.test.js"],
    mustFailCases: [
      "CONTAINER-PROFILE: a drifted substrate is refused before anything executes",
      "CONTAINER-PROFILE: mocked probes qualify nothing, launcher or no launcher",
      "CONTAINER-PROFILE: probe evidence frozen against another lock licenses nothing",
    ],
    expect: "fail",
  },
  {
    id: "container-profile-subject-trust",
    what: "an opaque-private or third-party subject is refused the container profile even when it is fully working (ADR-ERL2-016 §5, re-affirmed by -017 and -034)",
    file: "packages/core/src/adapter/sandbox.ts",
    find: '  if (input.subjectTrust !== "trusted_reference") {',
    replace:
      '  if (input.subjectTrust !== "trusted_reference" && String(1) === "2") {',
    tests: ["tests/dist/adversarial/containerSandboxProfile.test.js"],
    mustFail: ["tests/dist/adversarial/containerSandboxProfile.test.js"],
    mustFailCases: [
      "CONTAINER-PROFILE: an opaque or third-party subject is refused a fully working profile",
    ],
    expect: "fail",
  },
  {
    id: "container-profile-launcher-observed",
    what: "a qualified substrate with no working launcher is still refused; gate 1 and gate 2 stay two questions (ADR-ERL2-017 decision 3)",
    file: "packages/core/src/adapter/sandbox.ts",
    find: "  if (!input.launcher.available) {",
    replace: '  if (!input.launcher.available && String(1) === "2") {',
    tests: ["tests/dist/adversarial/containerSandboxProfile.test.js"],
    mustFail: ["tests/dist/adversarial/containerSandboxProfile.test.js"],
    mustFailCases: [
      "CONTAINER-PROFILE: a qualified substrate with no launcher is still refused",
    ],
    expect: "fail",
  },
  {
    id: "container-control-report-derived-per-control",
    what: "each kernel-prevented control reads `enforced` only because a probe observed *that* control on this lock (ADR-ERL2-034)",
    file: "packages/core/src/adapter/sandbox.ts",
    // Returns all thirteen regardless of what the probe results say, which is
    // the difference between a derived report and a second hard-coded table.
    find: [
      "  return CONTAINER_CONTROL_PROOFS.filter((control) => {",
      "    const probe = byControl.get(control);",
      '    return probe !== undefined && probe.evidence === "observed" && probe.enforced;',
      "  });",
    ].join("\n"),
    replace: ["  void byControl;", "  return CONTAINER_CONTROL_PROOFS;"].join("\n"),
    tests: ["tests/dist/adversarial/containerSandboxProfile.test.js"],
    mustFail: ["tests/dist/adversarial/containerSandboxProfile.test.js"],
    mustFailCases: [
      "CONTAINER-PROFILE: the control report is derived per control, from the probe bytes",
    ],
    expect: "fail",
  },
  {
    id: "container-activation-rederived-from-evidence",
    what: "an activation is re-derived from the evidence it carries on every use, so the structural type cannot be forged into a permission (ADR-ERL2-034 §7)",
    file: "packages/core/src/adapter/sandbox.ts",
    // Trusts the `state` label the object arrived with. `ContainerProfileActivation`
    // is a structural type, so without this line the profile opens to any object
    // literal — which is how the type looked before the evidence-carrying
    // rewrite, and why it was rewritten.
    find: "  assertQualified(activation);\n}",
    replace: "  void assertQualified;\n}",
    tests: ["tests/dist/adversarial/containerSandboxProfile.test.js"],
    mustFail: ["tests/dist/adversarial/containerSandboxProfile.test.js"],
    mustFailCases: [
      "CONTAINER-PROFILE: an activation is re-derived from its evidence on every use",
    ],
    expect: "fail",
  },
  {
    id: "container-manifest-names-its-substrate",
    what: "a container invocation manifest must name the substrate lock whose evidence licenses its control report (ADR-ERL2-034)",
    file: "packages/core/src/adapter/sandbox.ts",
    find: [
      "  if (",
      '    profile === "container" &&',
      "    (activation === undefined ||",
      "      manifest.isolation_substrate_lock_hash !== containerSubstrateLockHash(activation))",
      "  ) {",
    ].join("\n"),
    replace: [
      "  void containerSubstrateLockHash;",
      "  if (",
      '    profile === "container" &&',
      "    activation === undefined",
      "  ) {",
    ].join("\n"),
    tests: ["tests/dist/adversarial/containerSandboxProfile.test.js"],
    mustFail: ["tests/dist/adversarial/containerSandboxProfile.test.js"],
    mustFailCases: [
      "CONTAINER-PROFILE: a container manifest that names no substrate lock is refused",
    ],
    expect: "fail",
  },
  {
    id: "container-deadline-kills-the-container",
    what: "the deadline SIGKILLs the container, not the runtime CLI — the exact defect ADR-ERL2-017 §Evidence recorded (ADR-ERL2-034 §2)",
    file: "packages/core/src/adapter/containerSupervisor.ts",
    // Reproduces the original defect faithfully: signal the CLI and hope. The
    // CLI forwards SIGTERM to PID 1, PID 1 has no default signal handlers
    // because it is PID 1, and the container runs to its own natural end. The
    // probe that did this reported `enforced: true` for a 4 s deadline after
    // 608 s.
    find: [
      '    if (control(["kill", "--signal", "KILL", containerId]).status !== 0) {',
      '      removedByKill = control(["rm", "--force", containerId]).status === 0;',
      "    }",
    ].join("\n"),
    replace: [
      "    void removedByKill;",
      '    child.kill("SIGTERM");',
    ].join("\n"),
    tests: ["tests/dist/adversarial/containerDeadlineEnforcement.test.js"],
    mustFail: ["tests/dist/adversarial/containerDeadlineEnforcement.test.js"],
    mustFailCases: [
      "CONTAINER-DEADLINE: a subject that ignores every signal is bounded by its deadline",
      "CONTAINER-DEADLINE: termination is observed — the whole pid namespace, keyed on container id",
    ],
    // The reading this control's note has asked readers to perform by hand since
    // it was written is now the harness's own: no daemon, no measurement,
    // `unmeasured_here`. Nothing the campaign can do provisions a daemon, so this
    // prerequisite is detected rather than satisfied.
    requiresPrerequisite: "docker-daemon",
    expect: "fail",
    note: "Needs a container daemon. On a host without one the deadline tests take their announced skip branch, the declared prerequisite is unavailable, and the campaign records `unmeasured_here` — which is neither agreement nor disagreement, and must not be read as a guard that is not load-bearing. The ordinary gate must never require a daemon; this control is where that reading is made explicit.",
  },

  // -- subject-adapter/v2 local observation (ADR-ERL2-037) ------------------
  //
  // These twelve ran for a while in `scripts/subject-adapter-v2-negative-controls.mjs`,
  // a second harness with its own runner, its own patcher and its own report
  // shape. They killed what they claimed to kill, and `npm run negative-control`
  // could not see any of them: the campaign counted 129 controls and published
  // that number as its scope while twelve load-bearing guards sat outside it. A
  // control the campaign cannot discover is a control the campaign does not have,
  // so they live here now, under the same discovery, timeout, classification and
  // durable-record path as every other row. The five after them close the gaps an
  // independent review found in this package.
  {
    id: "v2-local-mode-accepts-v1",
    what: "local observation may only be dispatched on subject-adapter/v2",
    file: "packages/core/src/adapter/host.ts",
    find: "if (isLocal !== (input.executionMode === ADAPTER_LOCAL_EXECUTION_MODE)) {",
    replace: 'if (String(1) === "2" && isLocal !== (input.executionMode === ADAPTER_LOCAL_EXECUTION_MODE)) {',
    tests: ["tests/dist/adversarial/localAdapterV2.test.js"],
    expect: "fail",
  },
  {
    id: "v2-receipt-version-guard",
    what: "a v1 certification receipt never authorizes a v2 local profile",
    file: "packages/core/src/adapter/admission.ts",
    find: 'if (receipt.schema_version !== "subject-adapter-certification-receipt/v2") {',
    replace: 'if (String(1) === "2") {',
    tests: ["tests/dist/adversarial/localAdapterV2.test.js"],
    expect: "fail",
  },
  {
    id: "v2-local-context-closed",
    what: "the local execution context admits no governed field",
    file: "packages/contracts/schemas/adapter.schema.json",
    // The def name is carried in the preimage rather than used as an anchor:
    // an anchor only opens a window to end-of-file, and `additionalProperties`
    // occurs seven times below this one.
    find:
      '"LocalObservationExecutionContextV2": {\n' +
      '      "type": "object",\n' +
      '      "additionalProperties": false,',
    replace:
      '"LocalObservationExecutionContextV2": {\n' +
      '      "type": "object",\n' +
      '      "additionalProperties": true,',
    tests: ["tests/dist/contract/localObservationContracts.test.js"],
    expect: "fail",
  },
  {
    id: "v2-not-scored-constant",
    what: "a local observation result cannot stop declaring itself unscored",
    file: "packages/contracts/schemas/observation.schema.json",
    anchor: '"LocalObservationResultV1": {',
    find: '"not_scored": { "const": true },',
    replace: '"not_scored": { "type": "boolean" },',
    tests: ["tests/dist/contract/localObservationContracts.test.js"],
    expect: "fail",
  },
  {
    id: "v2-governed-consumer-firewall",
    what: "a local observation result cannot satisfy a governed consumer contract",
    file: "packages/contracts/src/validate.ts",
    find: "export function validateContract(contractName: string, value: unknown): ValidationResult {",
    replace:
      "export function validateContract(contractName: string, value: unknown): ValidationResult {\n" +
      '  if (contractName === "LabRunRecordV1" && (value as { schema_version?: string })?.schema_version === "local-observation-result/v1") return { valid: true, problems: [] };',
    tests: ["tests/dist/adversarial/localObservationFirewall.test.js"],
    expect: "fail",
  },
  {
    id: "v2-receipt-operation-scope",
    what: "the receipt's certified operations must equal the certified profile's",
    file: "packages/core/src/adapter/admission.ts",
    find: '  assertSameSet(receipt.certified_operations, certifiedProfile.operations, "certified operations", manifest.adapter_id);\n',
    replace: "",
    tests: ["tests/dist/adversarial/localAdapterV2.test.js"],
    expect: "fail",
  },
  {
    id: "v2-per-dispatch-digest",
    what: "the adapter's entry bytes are re-verified on every dispatch",
    file: "packages/core/src/adapter/host.ts",
    find:
      "      assertEntryDigestUnchanged({\n" +
      "        entryPath: this.entryPath,\n" +
      "        certifiedArtifactHash: this.certifiedArtifactHash,\n" +
      "      });",
    replace: "      void this.certifiedArtifactHash;",
    tests: ["tests/dist/adversarial/localAdapterV2.test.js"],
    expect: "fail",
  },
  {
    id: "v2-local-output-bytes",
    what: "the plan's output-byte ceiling, not the host default, bounds a local run",
    file: "packages/core/src/adapter/host.ts",
    find: "maxTotalBytes: limits.max_output_bytes,",
    replace: "maxTotalBytes: hostBounds.maxTotalBytes,",
    tests: ["tests/dist/adversarial/localAdapterV2.test.js"],
    expect: "fail",
  },
  {
    id: "v2-ambiguous-never-replayed",
    what: "an ambiguous local effect is never replayed to make progress",
    file: "packages/core/src/observation/localObservation.ts",
    find:
      '        if (existing.state === "ambiguous_not_replayed") {\n' +
      "          throw new Erl2Error(\n" +
      "            CODES.ADAPTER_LOCAL_AMBIGUOUS_REPLAY_REFUSED,\n" +
      '            "an ambiguous local effect is never replayed blindly",\n' +
      "          );\n" +
      "        }",
    replace:
      '        if (existing.state === "ambiguous_not_replayed") {\n' +
      "          return existing;\n" +
      "        }",
    tests: ["tests/dist/integration/localObservationReducer.test.js"],
    expect: "fail",
  },
  {
    id: "v2-post-freeze-dispatch",
    what: "no local operation dispatches after the output freeze",
    file: "packages/core/src/observation/localObservation.ts",
    find: "if (this.outputFrozen) {",
    replace: 'if (String(1) === "2" && this.outputFrozen) {',
    tests: ["tests/dist/integration/localObservationReducer.test.js"],
    expect: "fail",
  },
  {
    id: "v2-cleanup-requires-evidence",
    what: "cleanup is complete only when its evidence says so",
    file: "packages/core/src/observation/localObservation.ts",
    find: "    const complete =\n",
    replace: "    const complete =\n      true ||\n",
    tests: [
      "tests/dist/integration/localObservationReducer.test.js",
      "tests/dist/integration/localResidueTruth.test.js",
    ],
    expect: "fail",
  },
  {
    id: "v2-coordinator-delegates",
    what: "the local coordinator holds no subprocess authority of its own",
    file: "packages/core/src/observation/localObservation.ts",
    find: 'import { coreHash } from "@erl2/integrity";\n',
    replace: 'import { coreHash } from "@erl2/integrity";\nimport { spawnSync } from "node:child_process";\n',
    tests: ["tests/dist/architecture/localObservationBoundary.test.js"],
    expect: "fail",
  },

  // -- closures from the Package A independent review ------------------------
  {
    id: "v2-residue-requires-report",
    what: "a clean substrate is read from the adapter's residue report, never inferred from an operation ending",
    file: "packages/core/src/observation/localObservation.ts",
    // The exact defect that was found, reintroduced verbatim: cleanliness
    // derived from a `report-residue` operation having ended, with the report
    // itself computed and then ignored.
    //
    // An earlier version of this control patched only the `finalResidue ===
    // undefined` arm, and survived — because once the report is read, that arm
    // is unreachable for an operation that succeeded. A control has to remove
    // the property, not a line near it.
    find:
      '    const residue: LocalCleanupResultV1["residue"] =\n' +
      "      finalResidue === undefined\n" +
      '        ? "not_observed"\n' +
      '        : finalResidue.status === "clean"\n' +
      '          ? "observed_clean"\n' +
      '          : finalResidue.status === "residue_detected"\n' +
      '            ? "residue_detected"\n' +
      '            : "not_observed";',
    replace:
      "    void finalResidue;\n" +
      '    const residue: LocalCleanupResultV1["residue"] =\n' +
      '      finalResiduePlanned && succeeded("report-residue") ? "observed_clean" : "not_observed";',
    tests: ["tests/dist/integration/localResidueTruth.test.js"],
    expect: "fail",
  },
  {
    id: "v2-residue-report-validated",
    what: "an unusable or self-contradicting residue report is refused at the protocol boundary",
    file: "packages/core/src/adapter/responseShape.ts",
    find: '  if (record["status"] === "clean" && named > 0) {',
    replace: '  if (String(1) === "2" && record["status"] === "clean" && named > 0) {',
    tests: ["tests/dist/integration/localResidueTruth.test.js"],
    expect: "fail",
  },
  {
    id: "v2-governed-port-refusal",
    what: "the governed SubjectPort refuses a v2 local-observation host at construction, before a port exists to dispatch through",
    file: "packages/core/src/adapter/hostedSubjectPort.ts",
    // The mutation an independent review ran, which the suite did not notice.
    //
    // What it kills is the port's own early refusal, and only that. Enforcement
    // is layered: with this guard gone the host's execution-mode binding still
    // refuses every port method, so no adapter dispatch becomes observable and
    // the suite's sentinel does not move. An earlier note here claimed the
    // sentinel would move; a second review disproved it by experiment. The
    // narrower claim is the true one, and `HOST-MODE-BINDING` in the same suite
    // pins the layer that makes it true.
    find: '    if (host.manifest.schema_version !== "subject-adapter-manifest/v1") {',
    replace: '    if (String(1) === "2") {',
    tests: ["tests/dist/integration/governedPortRefusal.test.js"],
    expect: "fail",
  },
  {
    id: "v2-telemetry-follower-readiness",
    what: "a follower that never attached or died mid-look yields TRACE_OBSERVATION_UNAVAILABLE, never TRACE_NOT_EMITTED",
    file: "tests/support/durableTelemetry.ts",
    // Pinned at the diagnostic code, not at an explanation string. The cases
    // this control originally killed all stayed classified
    // `TRACE_OBSERVATION_UNAVAILABLE` under the mutation — the `unreadable`
    // fallback caught them — so only their wording changed, which a second
    // review found and is not a boundary. `a follower that dies after an empty
    // read` is the fixture where the classification itself flips to
    // `TRACE_NOT_EMITTED`: the capture is present, readable and honestly empty,
    // so nothing else in the verdict chain can stand in for readiness.
    find: "    if (!readiness.usable) {",
    replace: '    if (String(1) === "2" && !readiness.usable) {',
    tests: ["tests/dist/integration/durableTelemetryObservation.test.js"],
    expect: "fail",
  },
  {
    id: "v2-telemetry-block-boundary",
    what: "a trace batch is attributed only by the markers inside its own block",
    file: "tests/support/durableTelemetry.ts",
    // Never terminating a block is the direction that leaks one run's spans into
    // another's total, and is the mutation that previously survived.
    find: "      if (SIGNAL_SUMMARY_LINE.test(line)) break;",
    replace: "      if (false) break;",
    tests: ["tests/dist/integration/durableTelemetryObservation.test.js"],
    expect: "fail",
  },
  {
    id: "v2-operation-success-requires-adapter-success",
    what: "an operation counts as successful only when the adapter said it succeeded, never merely because its record completed",
    file: "packages/core/src/observation/localObservation.ts",
    // The residue remediation corrected two properties, and only the first got a
    // control. This is the second: `completed` means the exchange completed and
    // its evidence froze, and has never meant the adapter succeeded. An
    // independent review ran exactly this mutation and the entire test tree
    // stayed green, so the property was outside the campaign's scope.
    //
    // The conjunct is removed rather than the branch around it: lifecycle
    // completion is retained, so the mutation asks precisely "does the adapter's
    // verdict decide?" and nothing else.
    find:
      '          record.state === "completed" &&\n' +
      '          record.response_status === "supported",',
    replace: '          record.state === "completed",',
    tests: ["tests/dist/integration/localOperationSuccess.test.js"],
    expect: "fail",
  },
  {
    id: "compose-observation-requires-coherent-span-count",
    what: "a retained telemetry observation states a span count only from a window that carried the counting line and this run's records together",
    file: "packages/core/src/environment/telemetryObservation.ts",
    // The defect an independently classified clean-gate failure exposed. The
    // observer settled on `runAttributedRecords >= 1` and froze the span count
    // from the same read, but the two survive rotation differently: marked
    // records live in a batch's detailed dump and the count lives in the summary
    // line above it, and the collector's `json-file` log evicts from the head. A
    // run whose spans were emitted, exported and marked could therefore freeze
    // `evidence: observed, spans: 0` beside `run_attributed_records: 2`.
    //
    // The mutation is exactly the pre-correction condition, so a survivor means
    // the false-zero artifact is retainable again. The named case reads the
    // *frozen artifact* through the production retention path, not a helper's
    // return value: the lie was in the retained evidence.
    find: "  if (input.counts.runAttributedBatches >= 1) return { decision: \"retain\" };",
    replace: "  if (input.counts.runAttributedRecords >= 1) return { decision: \"retain\" };",
    tests: ["tests/dist/adversarial/composeSubstrate.test.js"],
    mustFail: ["tests/dist/adversarial/composeSubstrate.test.js"],
    mustFailCases: [
      "COMPOSE-WINDOW: the failed-gate signature cannot be retained as a definitive zero",
      "COMPOSE-WINDOW: another run's summary does not supply a count for this run's records",
    ],
    // The shared declaration the suite's three other controls carry, and this
    // one now carries too. It used to be a hand-written copy naming only the
    // *first* rendered-topology case; package 2 added a second assertion over
    // the same merge and updated `RENDERED_TOPOLOGY_SKIP`, and this copy was not
    // updated with it. The independent Package 3 review ran this control for the
    // first time since and it harness-errored on the undeclared second skip —
    // the guard killed correctly, but an undeclared skip is coverage the
    // campaign cannot account for, so it refused to record an agreement.
    //
    // Referencing the constant rather than restating it is the repair: a copy
    // drifts, a reference cannot.
    expectedSkips: RENDERED_TOPOLOGY_SKIP,
    expect: "fail",
  },
  {
    id: "nc-marker-published-atomically",
    what: "a marker's final path is never the file being written to, so no reader can observe it at length zero",
    file: "tests/support/atomicMarker.ts",
    // The second failure the same gate recorded. `writeFileSync` opens the final
    // path with O_CREAT|O_TRUNC and *then* writes, so the path exists, empty,
    // before it carries a byte; an independent probe caught it at size zero in
    // 300 of 300 attempts. The mutation restores exactly that shape — the bytes
    // go straight to the final name — and the named case notices structurally,
    // between staging and committing, rather than by racing anything.
    find: '  const fd = openSync(temporary, "wx", MARKER_MODE);',
    replace: '  const fd = openSync(finalPath, "w", MARKER_MODE);',
    tests: ["tests/dist/integration/atomicMarkerPublication.test.js"],
    mustFail: ["tests/dist/integration/atomicMarkerPublication.test.js"],
    mustFailCases: ["MARKER-WRITE: the final path is never the file being written to"],
    expect: "fail",
  },
  {
    id: "nc-marker-readiness-requires-valid-content",
    what: "a marker is ready only when its bytes read whole, parse, and name the writer the reader is waiting for — never merely because the path exists",
    file: "tests/support/atomicMarker.ts",
    // The reader half of the same defect, and the half that makes the outcome
    // deterministic rather than merely unlikely: the original loop's readiness
    // condition was `existsSync`, so it proceeded to `JSON.parse` on a file that
    // existed and was empty. The mutation makes an existing empty file ready
    // again, which is that condition exactly.
    find: '  if (bytes.length === 0) return { ready: false, why: { state: "empty" } };',
    replace:
      "  if (bytes.length === 0) {\n" +
      "    return { ready: true, envelope: { kind: expected.kind, id: expected.id, payload: {} as T } };\n" +
      "  }",
    tests: ["tests/dist/integration/atomicMarkerPublication.test.js"],
    mustFail: ["tests/dist/integration/atomicMarkerPublication.test.js"],
    mustFailCases: [
      "MARKER-READ: an empty file is never a marker",
      "MARKER-READ: the exact failed-gate failure is unreachable through the reader",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-summary-must-be-a-framed-record",
    what: "a span count is read only from a line the collector framed as a whole console record, never from payload text a subject wrote",
    file: "packages/core/src/environment/telemetryObservation.ts",
    // P1 of the independent review. The pattern here was
    // `/\bTraces\b.*"spans":\s*(\d+)/` — unanchored, matching anywhere on any
    // line. The Lab's overlay pipes subject logs through the same debug
    // exporter, and the pinned collector renders a log body at column zero, so
    // `Body: Str(...Traces ... "spans": 9999)` matched. One of those turned a
    // correctly refused rotated window into a retained observation stating a
    // count no collector ever wrote.
    //
    // The mutation drops the record-boundary requirement, which is the whole of
    // the anchoring. The named case is the payload table: the reviewed exploit
    // must classify as `not_summary`, and without the anchor it does not.
    find: "  if (!CONSOLE_RECORD_LINE.test(line)) return NOT_SUMMARY;",
    replace: "  if (false) return NOT_SUMMARY;",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-PARSE: only a whole console record the collector framed states a span count",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-record-payload-is-not-summary-text",
    what: "text inside a record's payload states nothing, even when it is a byte-exact copy of an authentic summary",
    file: "packages/core/src/environment/telemetryObservation.ts",
    // The residual the anchoring alone leaves: a subject's *multi-line* log body
    // puts its continuation at column zero, so it can carry a whole copied
    // summary record. Framing is what answers it — a record whose message runs
    // on opens a payload region, and nothing in that region is read as a
    // summary. The mutation stops any region from ever opening.
    find: "    if (CONSOLE_RECORD_LINE.test(line) && !isCompleteRecordLine(line)) open = true;",
    replace: "    if (false) open = true;",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-PARSE: a payload line shaped like a record boundary makes the window ambiguous",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-ambiguous-window-is-refused",
    what: "a window carrying a record boundary inside payload is refused, not read as though its framing were known",
    file: "packages/core/src/environment/telemetryObservation.ts",
    // Detecting the forged boundary is only half of it: the window must then be
    // refused. Without this guard the scan falls through and states whatever
    // its lines happen to total, which is the shape of the original defect.
    find: "  if (input.counts.forgedBoundaries > 0) {",
    replace: "  if (false) {",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-PARSE: a payload line shaped like a record boundary makes the window ambiguous",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-malformed-summary-is-not-a-zero",
    what: "a summary record whose count cannot be read refuses the window instead of totalling to zero",
    file: "packages/core/src/environment/telemetryObservation.ts",
    // The count used to be a digit run handed to `Number.parseInt`, so a long
    // enough one reached `Infinity`. The parser refuses it now — but a refused
    // summary that merely went uncounted would leave the window stating a zero
    // it never observed, which is the exact conflation this module exists to
    // prevent.
    find: "  if (input.counts.malformedSummaries > 0) {",
    replace: "  if (false) {",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-PARSE: a record shaped like a summary and unreadable as one is malformed, never a zero",
      "ATTR-TELEM-RETAIN: a digit run too long to represent never becomes a count",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-verifier-recomputes-coherence",
    what: "the offline verifier re-derives the retained artifact's byte length, record count and termination instead of trusting the producer that declared them (ADR-ERL2-038 R5)",
    file: "packages/public-verifier/src/library/telemetryDerivation.ts",
    // P2 of the same review. The producer enforced the coherent-window
    // invariant and the verifier did not re-derive it, so the literal artifact
    // the failed clean gate recorded — `spans: 0` beside
    // `run_attributed_records: 2` — still verified clean: every counter agreed
    // with the excerpt, and nothing checked the relationship between them.
    //
    // A retained artifact is durable evidence with two authorities. The
    // mutation removes the second one.
    // ADR-ERL2-038 R7 migration. Under v1 the incoherent shape was attribution
    // with no batch that counted it, because a batch's summary and its marked
    // records could land in different windows. Under ERL2-C-171 both come out
    // of one parsed document and cannot separate, so the incoherent shape is
    // attribution that exceeds the spans it was drawn from. Same property —
    // *the verifier re-derives the relationship between two counts instead of
    // trusting the producer that wrote them* — at the boundary that now exists.
    find: [
      "  if (",
      "    artifact.byte_length !== derived.byteLength ||",
      "    artifact.record_count !== derived.recordCount ||",
      "    artifact.final_record_terminated !== derived.finalRecordTerminated",
      "  ) {",
    ].join("\n"),
    replace: '  if (String(1) === "2") {',
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "TRUSTED-VERIFY: the verifier reads the bytes rather than the claim",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-v1-cannot-authorize",
    what: "a historical v1 record, an unknown version and an invalid v2 are all refused authority for a new claim rather than accepted because nothing better exists (ADR-ERL2-038 R8)",
    file: "packages/core/src/environment/telemetryObservation.ts",
    // The whole migration in one line. Mutating it restores exactly the
    // dual authority R8 exists to prevent: any retained record, of any
    // version and any validity, becomes good enough.
    find: "  if (!claim.authoritative) return false;",
    replace: "  if (!claim.authoritative) return input.observations.length > 0;",
    tests: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFail: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFailCases: [
      "TRUSTED-AUTHORITY: the migration truth table, observed at the gate",
      "TRUSTED-INVALID: every invalid shape is refused, and none falls back to v1",
      "TRUSTED-HISTORY: v1 stays readable, and reading is not authorizing",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-invalid-v2-does-not-downgrade",
    what: "an invalid v2 record refuses outright instead of falling through to a v1 that would have passed (ADR-ERL2-038 R8)",
    file: "packages/core/src/environment/telemetryAuthority.ts",
    find: "  if (!validateContract(\"AttributableTelemetryObservationV2\", candidate).valid) {",
    replace: "  if (false) {",
    tests: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFail: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFailCases: [
      "TRUSTED-INVALID: every invalid shape is refused, and none falls back to v1",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-unknown-version-fails-closed",
    what: "a retained record whose schema version the Lab does not know fails closed rather than being ignored (ADR-ERL2-038 R8)",
    file: "packages/core/src/environment/telemetryAuthority.ts",
    find: "    return refuse(TELEMETRY_AUTHORITY_REASONS.unknownVersion);",
    replace: "    continue;",
    // Only the inventory distinguishes this. The truth table asks whether the
    // run is eligible, and an ignored unknown-version record leaves it
    // ineligible either way — a weaker refusal is still a refusal, so the row
    // that must move is the one asserting *which* refusal.
    tests: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFail: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFailCases: [
      "TRUSTED-INVALID: every invalid shape is refused, and none falls back to v1",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-freeze-integrity-verified",
    what: "a record edited after it was frozen is refused, because its own core hash is no longer the hash of its own fields (ADR-ERL2-038 R5)",
    file: "packages/core/src/environment/telemetryAuthority.ts",
    find: "  if (coreHash(coreOf(observation)) !== observation.core_hash) {",
    replace: "  if (false) {",
    tests: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFail: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFailCases: [
      "TRUSTED-INVALID: every invalid shape is refused, and none falls back to v1",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-artifact-digest-verified",
    what: "the declared content digest is recomputed over the retained bytes, so a record hashed over one buffer and retained over another is refused (ADR-ERL2-038 R5)",
    file: "packages/core/src/environment/telemetryAuthority.ts",
    find: "  if (artifact.content_digest !== hashBytes(Buffer.from(bytes, \"utf8\"))) {",
    replace: "  if (false) {",
    tests: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFail: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFailCases: [
      "TRUSTED-INVALID: every invalid shape is refused, and none falls back to v1",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-untrusted-payload-cannot-create-a-record",
    what: "a physical line that is not exactly one OTLP-JSON trace document states no count, which is where the retired region-open property now lives (ADR-ERL2-038 R7)",
    file: "packages/core/src/environment/trustedTelemetry.ts",
    // The mapped successor of telemetry-record-payload-is-not-summary-text.
    // That control mutates the mixed parser's region-open decision, whose
    // enforcement point survives until package 3 retires the parser, so it
    // is still discovered and still killing. This is the same security
    // property — subject payload cannot become a record — measured at the
    // boundary that will outlive it.
    find: "    if (keys.length !== 1 || keys[0] !== \"resourceSpans\") {",
    replace: "    if (false) {",
    tests: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFail: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFailCases: [
      "TRUSTED-PARSE: the grammar refuses every shape a minimized channel cannot produce",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-cross-run-record-refused",
    what: "an artifact carrying another run's marker is refused rather than counted in part (ADR-ERL2-038 R4)",
    file: "packages/core/src/environment/trustedTelemetry.ts",
    find: "              if (found !== marker) return refuse(TRUSTED_TELEMETRY_REASONS.foreignRun);",
    replace: "              if (false) return refuse(TRUSTED_TELEMETRY_REASONS.foreignRun);",
    tests: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFail: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFailCases: [
      "TRUSTED-PARSE: the grammar refuses every shape a minimized channel cannot produce",
      "TRUSTED-PARSE: mixed run markers are refused rather than partially counted",
      "TRUSTED-INVALID: every invalid shape is refused, and none falls back to v1",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-partial-record-refused",
    what: "bytes that do not end on a record boundary are a partial write and state no count (ADR-ERL2-038 R5)",
    file: "packages/core/src/environment/trustedTelemetry.ts",
    find: "  if (!bytes.endsWith(\"\\n\")) return refuse(TRUSTED_TELEMETRY_REASONS.incomplete);",
    replace: "  if (false) return refuse(TRUSTED_TELEMETRY_REASONS.incomplete);",
    tests: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFail: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFailCases: [
      "TRUSTED-PARSE: the grammar refuses every shape a minimized channel cannot produce",
      "TRUSTED-INVALID: every invalid shape is refused, and none falls back to v1",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-size-bound-enforced",
    what: "an artifact past the retention bound is refused rather than truncated into counts that are not the run's (ADR-ERL2-038 R6)",
    file: "packages/core/src/environment/trustedTelemetry.ts",
    find: "    return refuse(TRUSTED_TELEMETRY_REASONS.overSizeBound);",
    replace: "    return { ok: true, counts: { traceBatches: 0, spans: 0, serviceNames: [], runAttributedRecords: 0, byteLength, recordCount: 0, finalRecordTerminated: false } };",
    tests: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFail: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFailCases: [
      "TRUSTED-FIXTURE: the size-boundary fixture is bounded, and one byte more is not",
    ],
    expect: "fail",
  },
  {
    id: "trusted-channel-minimization-configured",
    what: "the trusted pipeline minimizes before it exports; removing the transform makes the channel retain whatever a subject attached (ADR-ERL2-038 R2)",
    file: "environments/otel-demo/compose/erl2-otelcol-extras.yaml",
    find: "      processors: [memory_limiter, transform/trusted]",
    replace: "      processors: [memory_limiter]",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CONFIG: the trusted pipeline minimizes before it exports, and the allowlist is the parser's",
    ],
    expect: "fail",
  },
  {
    // P0-1, collector side. The scope context is the one the first candidate
    // never named, and a live review payload retained a session token in it.
    id: "trusted-channel-scope-minimized",
    what: "the trusted pipeline strips the instrumentation scope's attributes, name and version before export, so the third attribute map cannot carry subject bytes into the artifact (Package 2 remediation P0-1)",
    file: "environments/otel-demo/compose/erl2-otelcol-extras.yaml",
    find: "          - keep_keys(scope.attributes, [])",
    replace: "          - set(scope.version, \"\")",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CONFIG: the trusted pipeline minimizes before it exports, and the allowlist is the parser's",
    ],
    expect: "fail",
  },
  {
    // P0-1, collector side. Span name, status message and trace state were all
    // measured surviving verbatim into a verified artifact.
    id: "trusted-channel-span-fields-minimized",
    what: "the trusted pipeline removes the span's name, status message and trace state before export, closing the three subject-controlled string fields the allowlist never named (Package 2 remediation P0-1)",
    file: "environments/otel-demo/compose/erl2-otelcol-extras.yaml",
    find: "          - set(span.status.message, \"\")",
    replace: "          - set(span.kind, span.kind)",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CONFIG: the trusted pipeline minimizes before it exports, and the allowlist is the parser's",
    ],
    expect: "fail",
  },
  {
    // `error_mode: ignore` is how `set(span.events, [])` became a silent no-op.
    // Every statement here is load-bearing for a privacy bound, so a statement
    // that cannot be applied must stop the batch rather than export more.
    id: "trusted-channel-minimization-fails-closed",
    what: "an inapplicable minimization statement fails the trusted pipeline closed rather than being swallowed, so a statement that parses but does not mutate cannot silently retain more than the allowlist says (Package 2 remediation P0-1)",
    file: "environments/otel-demo/compose/erl2-otelcol-extras.yaml",
    find: "    error_mode: propagate",
    replace: "    error_mode: ignore",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CONFIG: the trusted pipeline minimizes before it exports, and the allowlist is the parser's",
    ],
    expect: "fail",
  },
  {
    id: "trusted-channel-event-attributes-stripped",
    what: "span event attributes are stripped before export; without it an exception stack trace reaches the retained artifact, which a live run demonstrated (ADR-ERL2-038 R2)",
    file: "environments/otel-demo/compose/erl2-otelcol-extras.yaml",
    find: "          - keep_keys(spanevent.attributes, [])",
    replace: "          - truncate_all(spanevent.attributes, 512)",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CONFIG: the trusted pipeline minimizes before it exports, and the allowlist is the parser's",
    ],
    expect: "fail",
  },
  {
    id: "trusted-channel-debug-off-the-trusted-pipeline",
    what: "the debug exporter never shares the trusted pipeline; on a shared stream a subject log body forged a complete trusted record reading 9999 spans (ADR-ERL2-038 R3)",
    file: "environments/otel-demo/compose/erl2-otelcol-extras.yaml",
    find: "      exporters: [file/trusted]",
    replace: "      exporters: [file/trusted, debug]",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CONFIG: the trusted exporter shares its channel with nothing that renders subject bytes",
    ],
    expect: "fail",
  },
  {
    id: "trusted-channel-logs-excluded-from-trusted-export",
    what: "no signal but traces reaches the trusted exporter, so a subject log body — the vector the mixed stream was forged through — has no path into the trusted file (ADR-ERL2-038 R3)",
    file: "environments/otel-demo/compose/erl2-otelcol-extras.yaml",
    find: [
      "    logs:",
      "      receivers: [otlp]",
      "      processors: [memory_limiter]",
      "      exporters: [debug]",
    ].join("\n"),
    replace: [
      "    logs:",
      "      receivers: [otlp]",
      "      processors: [memory_limiter]",
      "      exporters: [debug, file/trusted]",
    ].join("\n"),
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CONFIG: the trusted exporter shares its channel with nothing that renders subject bytes",
    ],
    expect: "fail",
  },
  {
    id: "trusted-channel-stale-volume-refused",
    what: "a trusted volume of this run's name that already exists is refused rather than adopted, so a run cannot inherit another run's bytes (ADR-ERL2-038 R5)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "    if (this.volumeExists()) {",
    replace: "    if (false) {",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CHANNEL: a volume of this run's name that already exists is refused, never adopted",
    ],
    expect: "fail",
  },
  {
    id: "trusted-channel-mount-ownership-verified",
    what: "the volume's ownership and size options are read back from the daemon rather than assumed to have been applied (ADR-ERL2-038 R1/R4)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "    if (observed !== trustedVolumeMountOptions()) {",
    replace: "    if (false) {",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CHANNEL: a daemon that ignored the ownership options is refused, not trusted",
    ],
    expect: "fail",
  },
  {
    id: "trusted-channel-volume-run-scoped",
    what: "the trusted volume's name embeds the run id, so ownership is provable from the name and two runs cannot collide (ADR-ERL2-038 R5)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "  return `erl2-trusted-${runId}`;",
    replace: "  return \"erl2-trusted-shared\";",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CHANNEL: the volume name is run-scoped, so ownership is provable from the name",
      "TRUSTED-CHANNEL: the volume is created with the collector's ownership and a size bound",
    ],
    expect: "fail",
  },
  {
    id: "trusted-channel-single-file-enforced",
    what: "a trusted directory holding more than the one expected artifact is refused, which is what enforces the contract's no-rotation single segment (ADR-ERL2-038 R6)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "    if (fileNames.length !== 1) {",
    replace: "    if (false) {",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CHANNEL: exactly one file is frozen, and a second is refused rather than ignored",
    ],
    expect: "fail",
  },
  {
    id: "trusted-channel-artifact-stability-required",
    what: "an artifact is frozen only after two consecutive copies agree, so a prefix of a file the collector is still appending to is never hashed as the artifact (ADR-ERL2-038 R5)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "        previous.equals(read.bytes) &&",
    replace: "        true &&",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CHANNEL: bytes that never stop moving are refused, never half-frozen",
    ],
    expect: "fail",
  },
  {
    id: "trusted-channel-settle-requires-attribution",
    what: "the freeze waits for this run's telemetry to reach the file rather than for the file to stop moving, so a stable empty file is not frozen as an authentic zero (ADR-ERL2-033)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "    return settling.ok && settling.counts.runAttributedRecords >= 1;",
    replace: "    return true;",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CHANNEL: an empty file that is merely stable is not yet a settled observation",
    ],
    expect: "fail",
  },
  {
    id: "trusted-channel-oversize-refused",
    what: "an artifact larger than ERL2-C-171 retains fails closed at the freeze and is never truncated to fit (ADR-ERL2-038 R6)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "    if (byteLength > TRUSTED_TELEMETRY_MAX_BYTES) {",
    replace: "    if (false) {",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CHANNEL: an artifact over the retention bound fails closed and is never truncated to fit",
    ],
    expect: "fail",
  },
  {
    id: "trusted-channel-encoding-verified",
    what: "bytes that do not survive a UTF-8 round trip are refused rather than decoded with replacement characters, so a digest never covers bytes the collector did not write",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "    if (!Buffer.from(text, \"utf8\").equals(bytes)) {",
    replace: "    if (false) {",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CHANNEL: bytes that are not UTF-8 are refused rather than silently replaced",
    ],
    expect: "fail",
  },
  {
    // The anchor moved from `this.created` to the durable handle's run binding,
    // because the property moved with it. "Only a volume this channel created"
    // used to mean "only while the creating process is still alive", which is
    // why every real multi-process teardown left the volume behind. It now means
    // "only a volume this run holds a durable, run-bound handle for", and this
    // is the line that makes the handle load-bearing: refuse every handle here
    // and cleanup is blind again, exactly as it was.
    //
    // The mutation withholds the handle from every caller. Two earlier attempts
    // did not survive contact with the type checker — assigning the read away
    // narrows the local to `never`, and an always-true early return discards the
    // narrowing for the lines below it — and the campaign scores a build failure
    // as a harness error rather than a kill, so a control anchored either way
    // measures nothing. Returning `undefined` from the accessor is the same
    // defect and type-checks.
    id: "trusted-channel-cleanup-scoped-to-created",
    what: "cleanup acts only on a durable ownership handle bound to this run, so a refused pre-existing volume is never deleted and a volume created in an earlier process is still removable (Package 2 closure)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "    return handle;",
    replace: "    return undefined;",
    // Scoped to the ownership suite rather than to both, and every case it kills
    // is declared. This is the most central guard in the module — withhold the
    // handle and nothing downstream can prove anything — so a broad kill is the
    // honest result rather than a sign the mutation is too coarse. Declaring the
    // full list is what keeps it a measurement: an undeclared failure would be
    // scored as collateral and the control would not be credited at all. The
    // cross-process suite is left to the controls whose mutations discriminate
    // within it.
    tests: ["tests/dist/adversarial/trustedOwnership.test.js"],
    mustFail: ["tests/dist/adversarial/trustedOwnership.test.js"],
    mustFailCases: [
      "TRUSTED-OWNERSHIP: a crash after the volume and before confirmation reconciles the exact resource",
      "TRUSTED-OWNERSHIP: a failed removal keeps the handle and reports the daemon's words",
      "TRUSTED-OWNERSHIP: a live claim is never overwritten by a second provision",
      "TRUSTED-OWNERSHIP: a removal that succeeded without a tombstone is recovered honestly",
      "TRUSTED-OWNERSHIP: a successful removal tombstones the handle",
      "TRUSTED-OWNERSHIP: a volume with the right labels and the wrong capability survives",
      "TRUSTED-OWNERSHIP: a volume with the right name and wrong labels survives",
      "TRUSTED-OWNERSHIP: ownership is read from the handle, never from this object's memory",
      "TRUSTED-OWNERSHIP: reconciliation refuses a mismatched resource rather than deleting it",
      "TRUSTED-OWNERSHIP: repeated destroy is idempotent and cannot reach a later resource",
    ],
    expect: "fail",
  },
  {
    // The handle is the only thing standing between a second process and a
    // guessed deletion, so a handle that verifies without being sealed is a
    // capability anyone with write access to a temporary directory can mint.
    id: "trusted-channel-ownership-handle-integrity",
    what: "an ownership handle is accepted only when it hashes to what it claims, so an edited or hand-written handle cannot authorize removing a resource (Package 2 closure)",
    file: "packages/core/src/environment/trustedOwnership.ts",
    find: "  return coreHash(core) === claimed;",
    replace: "  return claimed === claimed;",
    tests: ["tests/dist/adversarial/trustedOwnership.test.js"],
    mustFail: ["tests/dist/adversarial/trustedOwnership.test.js"],
    mustFailCases: ["TRUSTED-OWNERSHIP: a tampered handle is not a handle"],
    expect: "fail",
  },
  {
    // The crash-window ordering. Persisting the intent *after* the resource
    // exists reopens the one window that cannot be recovered from: a volume
    // nobody can prove they own.
    id: "trusted-channel-ownership-intent-precedes-creation",
    what: "the ownership intent is durable before the volume is created, so a crash between the two leaves a recoverable handle rather than an unattributable resource (Package 2 closure)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "    this.ownership.write(intent);",
    replace: "    void intent;",
    tests: ["tests/dist/adversarial/trustedOwnership.test.js"],
    mustFail: ["tests/dist/adversarial/trustedOwnership.test.js"],
    mustFailCases: [
      "TRUSTED-OWNERSHIP: a crash after the intent and before the volume is recoverable",
    ],
    expect: "fail",
  },
  {
    // Label validation, immediately before removal.
    id: "trusted-channel-ownership-labels-verified",
    what: "a volume is removed only when its label set is exactly the one this run's handle requires, so a resource carrying this run's name and another run's labels is never deleted (Package 2 closure)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "    if (!labelsMatch(handle.labels, observed)) return false;",
    replace: "    if (false) return false;",
    tests: ["tests/dist/adversarial/trustedOwnership.test.js"],
    mustFail: ["tests/dist/adversarial/trustedOwnership.test.js"],
    mustFailCases: [
      "TRUSTED-OWNERSHIP: a volume with the right name and wrong labels survives",
    ],
    expect: "fail",
  },
  {
    // Capability validation. Separate from the labels because it is a separate
    // claim: the labels say what the resource is, and this says the remover
    // holds the value that created it.
    id: "trusted-channel-ownership-capability-verified",
    what: "a volume is removed only when its ownership label carries the digest of the capability in this run's handle, so a resource spoofed under a predictable name is never deleted (Package 2 closure)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find:
      "    if (observed?.[TRUSTED_VOLUME_LABEL_KEYS.ownership] !== trustedCapabilityDigest(handle.capability)) {",
    replace: "    if (false) {",
    tests: [
      "tests/dist/adversarial/trustedOwnership.test.js",
      "tests/dist/integration/trustedCrossProcess.test.js",
    ],
    mustFail: [
      "tests/dist/adversarial/trustedOwnership.test.js",
      "tests/dist/integration/trustedCrossProcess.test.js",
    ],
    mustFailCases: [
      "TRUSTED-OWNERSHIP: a volume with the right labels and the wrong capability survives",
      // The same spoof staged against the real daemon. Both must be declared, or
      // the harness reads the second failure as collateral and scores the
      // control `unrelated_tests_failed` — a kill it will not credit.
      "XPROC: a volume carrying the right name and a foreign capability is not removed",
    ],
    expect: "fail",
  },
  {
    // The one place this module removes a resource it did not watch being
    // created. Widening it is how a recovery path becomes a garbage collector.
    id: "trusted-channel-ownership-reconciliation-exact",
    what: "a pending ownership intent reconciles only the exact resource it names and proves, so recovery never removes a volume the intent does not describe (Package 2 closure)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "    if (!this.resourceProvenOwned(intent)) return false;",
    replace: "    if (false) return false;",
    tests: ["tests/dist/adversarial/trustedOwnership.test.js"],
    mustFail: ["tests/dist/adversarial/trustedOwnership.test.js"],
    mustFailCases: [
      "TRUSTED-OWNERSHIP: reconciliation refuses a mismatched resource rather than deleting it",
    ],
    expect: "fail",
  },
  {
    // Without the tombstone a destroyed run keeps a live claim on a name, and a
    // later resource under that name inherits it.
    id: "trusted-channel-cleanup-tombstones-ownership",
    what: "a successful removal retires the ownership handle, so a repeated destroy is idempotent and a live claim can never reach a resource created later under the same name (Package 2 closure)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find:
      "    this.ownership.write(sealTrustedVolumeOwnership({ ...withoutHash(handle), phase: \"released\" }));\n    return { attempted: true, removed: true, surviving: [] };",
    replace: "    return { attempted: true, removed: true, surviving: [] };",
    tests: ["tests/dist/adversarial/trustedOwnership.test.js"],
    mustFail: ["tests/dist/adversarial/trustedOwnership.test.js"],
    mustFailCases: [
      "TRUSTED-OWNERSHIP: a successful removal tombstones the handle",
      "TRUSTED-OWNERSHIP: repeated destroy is idempotent and cannot reach a later resource",
    ],
    expect: "fail",
  },
  {
    // The anchor moved with the code: the post-removal re-check is now one
    // expression rather than a second `volumeExists` block, and the mutation
    // says the same thing — treat every removal as having succeeded.
    id: "trusted-channel-cleanup-failure-reported",
    what: "a volume that is still present after a failed removal is reported as surviving rather than as removed, so cleanup outcome stays an observation (ADR-ERL2-038)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "    if (removed.status === 0 || !this.volumeExists()) return this.releaseHandle(handle);",
    replace: "    if (true) return this.releaseHandle(handle);",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CHANNEL: a cleanup that failed says so, and says what survived",
      "TRUSTED-CHANNEL: cleanup does not confer evidence validity, and validity does not confer cleanup",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-event-attributes-refused",
    what: "a span event's attributes and name are refused, closing the minimization hole a live run exposed when an exception stack trace survived into the retained artifact (ADR-ERL2-038 R2)",
    file: "packages/core/src/environment/trustedTelemetry.ts",
    find: "          const eventRefusal = childRefusal(span[\"events\"], SHAPE.event);",
    replace: "          const eventRefusal = undefined;",
    tests: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFail: ["tests/dist/adversarial/trustedChannel.test.js"],
    mustFailCases: [
      "TRUSTED-CHANNEL: a span event's attributes and name are both refused",
    ],
    expect: "fail",
  },
  {
    // P0-1. The generic unknown-key refusal is the whole recursion: the first
    // Package 2 grammar checked four attribute maps and ignored every other key
    // at every level, so six subject-controlled surfaces reached the artifact
    // and verified clean. Tolerating an unknown key is exactly how that happens.
    id: "trusted-telemetry-unknown-key-refused",
    what: "an unknown key at any nesting level is refused rather than ignored, so a surface nobody described cannot ride into the retained artifact (Package 2 remediation P0-1)",
    file: "packages/core/src/environment/trustedTelemetry.ts",
    find: "    return TRUSTED_TELEMETRY_REASONS.unexpectedField;\n  }\n  return undefined;\n}",
    replace: "    continue;\n  }\n  return undefined;\n}",
    tests: ["tests/dist/adversarial/trustedRemediation.test.js"],
    mustFail: ["tests/dist/adversarial/trustedRemediation.test.js"],
    mustFailCases: [
      "TRUSTED-REMEDIATION: every subject-controlled surface is refused, at every nesting level",
    ],
    expect: "fail",
  },
  {
    // P0-1. The other half: a key the pipeline strips arriving with content.
    // Treating it as empty is how a scope attribute carrying a session token
    // becomes an accepted artifact.
    id: "trusted-telemetry-unminimized-field-refused",
    what: "a field the trusted pipeline removes is refused when it arrives carrying content, so a configuration regression is caught rather than exported (Package 2 remediation P0-1)",
    file: "packages/core/src/environment/trustedTelemetry.ts",
    find: "      if (isEmpty(value[key])) continue;\n      return removedReason;",
    replace: "      if (isEmpty(value[key])) continue;\n      continue;",
    tests: ["tests/dist/adversarial/trustedRemediation.test.js"],
    mustFail: ["tests/dist/adversarial/trustedRemediation.test.js"],
    mustFailCases: [
      "TRUSTED-REMEDIATION: every subject-controlled surface is refused, at every nesting level",
    ],
    expect: "fail",
  },
  {
    // P1-1. The reproduced defect: budget exhaustion reaching the `observed`
    // constructor. Restoring that one call is exactly the false authentic zero.
    id: "trusted-channel-settle-timeout-is-not-a-zero",
    what: "settle-budget exhaustion produces an absence with a cause, never an authoritative observed zero, so delayed telemetry cannot be frozen as a positive claim that the collector received nothing (Package 2 remediation P1-1)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "    return {\n      evidence: \"absent\",\n      marker,\n      reasonCode:\n        counts.recordCount === 0\n          ? TRUSTED_CHANNEL_REASONS.expectedTelemetryMissing\n          : TRUSTED_CHANNEL_REASONS.settleTimeout,\n    };",
    replace: "    return observedMaterial(collector, binding, marker, freeze, counts);",
    tests: ["tests/dist/adversarial/trustedRemediation.test.js"],
    mustFail: ["tests/dist/adversarial/trustedRemediation.test.js"],
    mustFailCases: [
      "TRUSTED-REMEDIATION: telemetry arriving after the settle budget is never an observed zero",
    ],
    expect: "fail",
  },
  {
    // P1-1, the other direction: a zero that nobody declared eligible.
    id: "trusted-channel-zero-requires-declared-eligibility",
    what: "an observed zero is produced only for a run declared zero-eligible before observation, so an empty file is never read as proof the collector received nothing (Package 2 remediation P1-1)",
    file: "packages/core/src/environment/trustedChannel.ts",
    find: "    if (zeroEligibility.kind === \"zero-eligible\") {",
    replace: "    if (true) {",
    tests: ["tests/dist/adversarial/trustedRemediation.test.js"],
    mustFail: ["tests/dist/adversarial/trustedRemediation.test.js"],
    mustFailCases: [
      "TRUSTED-REMEDIATION: a zero is authoritative only when the run was declared eligible for one",
    ],
    expect: "fail",
  },
  {
    // P2-1. The planted symlink. Dropping the type check restores the copy
    // primitive that read the host's /etc/passwd.
    // Anchored on the *classification*, not on the channel's guard.
    //
    // The guard in `copyTrustedDirectory` refuses a non-regular entry twice
    // over — by type, and because the reader attaches no payload to one — so
    // mutating it alone changes no outcome and the control measured nothing.
    // Measured: it survived. The load-bearing decision is here, where the
    // archive's typeflag becomes a classification, and misreading a symlink as
    // a regular file is exactly the defect P2-1 describes.
    id: "trusted-channel-source-entry-must-be-regular",
    what: "the trusted source entry is proved a regular file from the archive's own header before any byte is used, so a planted symlink cannot be dereferenced into the artifact (Package 2 remediation P2-1)",
    file: "packages/core/src/environment/trustedArchive.ts",
    find: "  \"2\": \"symlink\",",
    replace: "  \"2\": \"regular-file\",",
    tests: ["tests/dist/adversarial/trustedRemediation.test.js"],
    mustFail: ["tests/dist/adversarial/trustedRemediation.test.js"],
    mustFailCases: [
      "TRUSTED-REMEDIATION: a non-regular source entry is refused before anything dereferences it",
    ],
    expect: "fail",
  },
  {
    // P2-2, closed as an explicitly unsupported MVP capability. The pinned
    // collector has no span-link OTTL context, so nothing upstream of this line
    // can remove link content — which makes this the only enforcement point
    // there is, and a silent acceptance here retains subject-controlled bytes
    // the artifact's privacy bound never accounted for.
    id: "trusted-telemetry-span-links-unsupported",
    what: "an artifact carrying any nonempty span link is refused whole with its own capability reason, so no linked span contributes evidence at a collector pin that cannot minimize link content (Package 2 closure P2-2)",
    file: "packages/core/src/environment/trustedTelemetry.ts",
    find: "  return TRUSTED_TELEMETRY_REASONS.spanLinksUnsupported;",
    replace: "  return undefined;",
    tests: ["tests/dist/adversarial/trustedSpanLinks.test.js"],
    mustFail: ["tests/dist/adversarial/trustedSpanLinks.test.js"],
    mustFailCases: [
      "TRUSTED-LINKS: any nonempty link refuses the artifact with the capability reason",
      "TRUSTED-LINKS: a mixed artifact contributes nothing, not a reduced count",
      "TRUSTED-LINKS: the sealed record refuses the gate and retains no link bytes",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-minimization-enforced",
    what: "a record carrying an attribute outside the pre-export allowlist is refused, so the verifier does not assume the minimizing processor ran (ADR-ERL2-038 R2)",
    file: "packages/core/src/environment/trustedTelemetry.ts",
    find: "    if (!allowed.includes(key)) return TRUSTED_TELEMETRY_REASONS.unexpectedField;",
    replace: "    if (false) return TRUSTED_TELEMETRY_REASONS.unexpectedField;",
    tests: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFail: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFailCases: [
      "TRUSTED-PARSE: the grammar refuses every shape a minimized channel cannot produce",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-sensitive-field-refused",
    what: "a retained record carrying a credential-shaped attribute is refused with its own reason rather than the generic one (ADR-ERL2-038 R2)",
    file: "packages/core/src/environment/trustedTelemetry.ts",
    find: "      return TRUSTED_TELEMETRY_REASONS.forbiddenField;",
    replace: "      return TRUSTED_TELEMETRY_REASONS.unexpectedField;",
    tests: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFail: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFailCases: [
      "TRUSTED-PARSE: the grammar refuses every shape a minimized channel cannot produce",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-field-bound-enforced",
    what: "an attribute value longer than the pre-export truncation bound is refused, so the privacy bound is measured rather than assumed (ADR-ERL2-038 R2)",
    file: "packages/core/src/environment/trustedTelemetry.ts",
    // Anchored on the comparison rather than on the bare `return`. Package 2
    // added a second `fieldOverBound` return for a span event's name, at a
    // deeper indentation — which *contains* the one-line anchor as a substring,
    // so the patch target stopped being unique and the harness said so instead
    // of patching the wrong one.
    find: [
      "    if (stringValue.length > TRUSTED_TELEMETRY_MAX_FIELD_CHARS) {",
      "      return TRUSTED_TELEMETRY_REASONS.fieldOverBound;",
    ].join("\n"),
    replace: [
      "    if (false) {",
      "      return TRUSTED_TELEMETRY_REASONS.fieldOverBound;",
    ].join("\n"),
    tests: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFail: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFailCases: [
      "TRUSTED-PARSE: the grammar refuses every shape a minimized channel cannot produce",
      "TRUSTED-INVALID: every invalid shape is refused, and none falls back to v1",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-run-binding-verified",
    what: "the offline verifier refuses an artifact bound to an environment archetype this run did not use (ADR-ERL2-038 R4)",
    file: "packages/public-verifier/src/library/telemetryDerivation.ts",
    find: "  if (observation.binding?.environment_archetype_hash !== archetypeHashes[0]) {",
    replace: "  if (false) {",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "TRUSTED-VERIFY: the verifier reads the bytes rather than the claim",
    ],
    expect: "fail",
  },
  {
    id: "trusted-telemetry-genuine-zero-not-inferred",
    what: "an empty finalized artifact is positively read as an authentic zero rather than conflated with bytes that could not be read (ADR-ERL2-038 R5)",
    file: "packages/core/src/environment/trustedTelemetry.ts",
    // The property is *a zero is read, never inferred*. Mutating the branch
    // makes an empty artifact fall through to the termination check and refuse,
    // which turns "the collector received nothing" into "nothing readable
    // arrived" — the exact conflation ADR-ERL2-033 exists to prevent.
    find: "  if (bytes.length === 0) {",
    replace: '  if (bytes.length === 0 && String(1) === "2") {',
    tests: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    mustFail: ["tests/dist/adversarial/trustedTelemetryAuthority.test.js"],
    // One case, and only one. The fixture test was declared here too and does
    // not fail: after authority and coherence were split, the authority
    // decision no longer parses the retained bytes, so a fixture that merely
    // *governs* its run never reaches this branch. A declared case that cannot
    // fail is a claim of coverage the control does not have.
    mustFailCases: [
      "TRUSTED-PARSE: an authentic zero is read, and a claimed zero over records is not",
    ],
    expect: "fail",
  },
  // -- package 3: the environment run's ERL2-C-171 integration ---------------
  {
    id: "telemetry-gate-composed-only-where-applicable",
    what: "the environment telemetry gate is composed from this run's own declaration predicate, so a run that could never have had trusted telemetry omits the gate rather than publishing a vacuous pass (ADR-ERL2-038 R8, package 3)",
    file: "packages/core/src/run/environmentRun.ts",
    // Mutating the *composition* condition alone, not the shared accessor: the
    // property is that the gate a run publishes and the applicability its
    // validity result declares are the same answer. Forcing the composition true
    // makes a fake-driver run emit a gate its own validity input says is not
    // applicable, and `assertAttributableTelemetryApplicability` refuses it. If
    // the accessor itself were mutated both sites would move together and agree,
    // which would measure something weaker.
    find: "      ...(this.attributableTelemetryApplicable()\n        ? [",
    replace: '      ...(String(1) === String(1)\n        ? [',
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-TELEM-E2E: a fake-driver run declares nothing, retains nothing, and still verifies offline",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-inapplicable-run-may-not-publish-the-gate",
    what: "a run that never declared an attributable-telemetry observation obtainable may not publish the gate at all, so the retired vacuous-pass convention cannot creep back through a producer that keeps emitting it (package 3)",
    file: "packages/core/src/evaluation/validity.ts",
    find: "    if (found.length > 0) {\n      throw new Erl2Error(\n        CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,\n        \"a run that never declared an attributable-telemetry observation obtainable must omit \" +",
    replace: "    if (String(1) === \"2\") {\n      throw new Erl2Error(\n        CODES.EVALUATOR_VALIDITY_GATE_NOT_LAB_OWNED,\n        \"a run that never declared an attributable-telemetry observation obtainable must omit \" +",
    tests: ["tests/dist/adversarial/environmentTelemetryApplicability.test.js"],
    mustFail: ["tests/dist/adversarial/environmentTelemetryApplicability.test.js"],
    mustFailCases: [
      "ENV-TELEM-APPLICABILITY: a non-declaring run that publishes the gate is refused",
      "ENV-TELEM-APPLICABILITY: the applicability assertion refuses both directions",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-applicable-run-evaluates-exactly-one-gate",
    what: "a run declaring the observation obtainable must evaluate exactly one telemetry gate, so a second gate cannot disagree with the first (package 3)",
    file: "packages/core/src/evaluation/validity.ts",
    // Declared on the *duplicate* case only. Omission is also caught by
    // `assertRequiredGatesPresent`, so claiming it here would credit this
    // control for a kill the neighbouring guard already makes — the redundant-
    // guard trap the package 2 review found twice. The duplicate is the case
    // only this statement decides.
    find: "  if (found.length !== 1) {\n    throw new Erl2Error(\n      CODES.GRAPH_CLOSURE_MISSING_ROLE,\n      `a run declaring an obtainable attributable-telemetry observation must evaluate exactly one `",
    replace: "  if (String(1) === \"2\") {\n    throw new Erl2Error(\n      CODES.GRAPH_CLOSURE_MISSING_ROLE,\n      `a run declaring an obtainable attributable-telemetry observation must evaluate exactly one `",
    tests: ["tests/dist/adversarial/environmentTelemetryApplicability.test.js"],
    mustFail: ["tests/dist/adversarial/environmentTelemetryApplicability.test.js"],
    mustFailCases: [
      "ENV-TELEM-APPLICABILITY: a declaring run that publishes the gate twice is refused",
      "ENV-TELEM-APPLICABILITY: the applicability assertion refuses both directions",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-required-set-follows-applicability",
    what: "the telemetry gate leaves the required set only for a run that never declared the observation obtainable, so `not applicable` cannot become `optional` for a run that did (package 3)",
    file: "packages/core/src/evaluation/validity.ts",
    // Inverting the test drops the gate from the required set of exactly the
    // runs that must carry it, and keeps it required of exactly the runs that
    // must not — both halves of the boundary in one mutation.
    find: "  if (options.attributableTelemetryApplicable === false) {",
    replace: "  if (options.attributableTelemetryApplicable === true) {",
    tests: ["tests/dist/adversarial/environmentTelemetryApplicability.test.js"],
    mustFail: ["tests/dist/adversarial/environmentTelemetryApplicability.test.js"],
    // One declared case, and only one. `silence is the strict answer` was
    // declared here first and does not fail: inverting the comparison leaves the
    // *undefined* arm untouched, so a caller that answers nothing still gets the
    // strict set and that case still passes. A declared case that cannot fail is
    // a claim of coverage this control does not have — measured, and corrected
    // rather than left standing.
    mustFailCases: [
      "ENV-TELEM-APPLICABILITY: the gate is required of a declaring run and of no other",
    ],
    expect: "fail",
  },
  {
    id: "telemetry-producer-retains-the-trusted-record",
    what: "the retained attributable-telemetry observation comes from the package 2 trusted channel, so a driver that cannot produce ERL2-C-171 produces no artifact rather than a debug-derived one (package 3)",
    file: "packages/core/src/run/environmentRun.ts",
    // Anchored on the accessor's return, not on the call site's guard. The guard
    // is what gives `freezeTrustedTelemetryObservation` its type, so removing it
    // yields a tree that does not build — a harness error, not a kill. Measured
    // exactly that way first, and re-anchored rather than left as a control that
    // proves nothing; this is the same correction package 2 made to its
    // durable-ownership anchor. Withholding the capability check here is the
    // defect itself, and it type-checks: a fake-driver run then calls a method
    // its driver does not have.
    find: "    return supportsTrustedTelemetry(this.driver) ? this.driver : undefined;",
    replace: "    return this.driver as unknown as TrustedTelemetryProducer;",
    tests: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFail: ["tests/dist/adversarial/attributableTelemetry.test.js"],
    mustFailCases: [
      "ATTR-TELEM-E2E: a fake-driver run declares nothing, retains nothing, and still verifies offline",
    ],
    expect: "fail",
  },
];

// -- result classification ---------------------------------------------------

/**
 * How one control ended.
 *
 * The distinction that matters is between a **behavioural kill** — the guard was
 * disabled and the named suite noticed — and everything else. A build failure is
 * not a kill: it says the patched tree does not compile, which is a fact about
 * the patch. A patch that landed in the wrong place is not evidence at all. Both
 * used to be scored in the same column as a real result, and reading a campaign
 * summary required knowing which rows to distrust.
 */
export const CONTROL_RESULT = Object.freeze({
  NAMED_TESTS_FAILED: "named_tests_failed",
  UNRELATED_TESTS_FAILED: "unrelated_tests_failed",
  DECLARED_CASES_NOT_FAILED: "declared_cases_not_failed",
  TESTS_PASSED_UNEXPECTEDLY: "tests_passed_unexpectedly",
  NO_KILL_AS_DECLARED: "no_kill_as_declared",
  UNMEASURED_HERE: "unmeasured_here",
  DESIGNATED_CASE_SKIPPED: "designated_case_skipped",
  BUILD_FAILED: "build_failure",
  RUNNER_FAILED: "test_runner_failed",
  STAGE_TIMED_OUT: "stage_timed_out",
  TREE_TERMINATION_FAILED: "stage_tree_termination_failed",
  RESTORATION_FAILED: "restoration_failure",
  RESIDUE_FAILED: "residue_failure",
  // The five the independent review of `07da5fe` required. Each names an
  // *incomplete observation* rather than an outcome: the campaign did not learn
  // less than it hoped, it learned nothing it can stand behind. They are separate
  // values rather than one `runner_failed` because an operator reading a campaign
  // needs to know which of "the output was cut", "the process was killed", "the
  // numbers do not add up" and "a case vanished" happened.
  EXECUTION_FACTS_MISSING: "execution_facts_missing",
  OUTPUT_TRUNCATED: "output_truncated",
  ABNORMAL_TERMINATION: "stage_terminated_abnormally",
  IMPOSSIBLE_ACCOUNTING: "impossible_test_accounting",
  UNEXPECTED_CASE_SKIPPED: "unexpected_case_skipped",
});

/** Result values that mean the campaign measured the guard rather than itself. */
const MEASURED = new Set([
  CONTROL_RESULT.NAMED_TESTS_FAILED,
  CONTROL_RESULT.TESTS_PASSED_UNEXPECTEDLY,
  CONTROL_RESULT.NO_KILL_AS_DECLARED,
]);

/**
 * Results that are neither a measurement nor a fault: the control declared a
 * prerequisite, the host could not supply it, and the designated case said so
 * itself by skipping.
 *
 * This is a third column, and it has to be, because the other two both lie about
 * it. Scoring it as a result claims the campaign learned something about the
 * guard when it ran nothing; scoring it as a harness error claims something
 * broke when the only fact is that this host is not the host. The ledger has
 * carried the phrase `UNMEASURED HERE` in prose since
 * `container-deadline-kills-the-container` was written — the note on that
 * control says a reader "must read" its result that way. This makes the harness
 * say it instead of asking the reader to.
 */
const UNMEASURED = new Set([CONTROL_RESULT.UNMEASURED_HERE]);

/** True when the result says something about the harness, not about the guard. */
export function isHarnessError(result) {
  return !MEASURED.has(result) && !UNMEASURED.has(result);
}

/**
 * True when the campaign ran nothing for a *declared* reason.
 *
 * Deliberately not the complement of `isHarnessError`: an undeclared skip is a
 * harness error, because a designated case that vanished with nobody having said
 * it might is exactly the shape this whole correction exists to stop being read
 * as agreement.
 */
export function isUnmeasured(result) {
  return UNMEASURED.has(result);
}

/**
 * Every failing case the spec reporter named, as `{ file, name }` pairs.
 *
 * The reporter's trailing `failing tests:` section prints two lines per failure:
 *
 *     test at tests/dist/e2e/environmentEvidenceBoundaries.test.js:287:1
 *     ✖ EB-OUTPUT: a secret canary in the subject's output bytes refuses … (12.3ms)
 *
 * The file line alone is what the harness used to read, and a file is coarser
 * than an invariant: six controls name the same twelve-case suite, so "1 of 12
 * failed" was scored as a kill without the harness ever confirming *which* one.
 * The name is right there on the next line; this reads it.
 */
export function parseFailingCases(stdout) {
  return [
    ...stdout.matchAll(/^test at (.+?):\d+:\d+\r?\n\s*✖ (.+?)(?: \([\d.]+ms\))?[ \t]*$/gm),
  ].map((m) => ({ file: m[1].replace(/^\.\//, ""), name: m[2] }));
}

/**
 * Every case the spec reporter skipped, as `{ name, reason }` pairs.
 *
 * The reporter prints one line per skip, with `﹣` (U+FE63) rather than the `✔`
 * of a pass, and the skip's own message after a `#`:
 *
 *     ﹣ COMPOSE-ADV: the RENDERED configuration … (0.06ms) # RENDERED TOPOLOGY UNPROVEN: …
 *
 * Reading the reason as well as the name is what lets a campaign record *why* a
 * control was unmeasured, which is the difference between a line an operator can
 * act on and one they have to go and reproduce.
 */
export function parseSkippedCases(stdout) {
  return [...stdout.matchAll(/^\s*﹣ (.+?)(?: \([\d.]+ms\))?(?: # (.*))?[ \t]*$/gm)].map((m) => ({
    name: m[1],
    reason: m[2] ?? "",
  }));
}

/**
 * Parse one `node --test` run and decide what it says about the control.
 *
 * The spec reporter names the file of every failing test in its trailing
 * `failing tests:` section, which is what makes "a test failed that this control
 * did not name" expressible at all. `mustFail`, when a control declares it,
 * narrows the expectation further: the listed files are run, and the failures
 * must fall inside the declared subset.
 *
 * `mustFailCases` narrows it to the granularity of the invariant. A control that
 * declares it is not satisfied by *a* failure in the right file; every declared
 * case must be among the cases that actually failed. A mutation that trips some
 * unrelated case in the same suite is then not an agreed kill — it is invalid
 * evidence, and it is reported as a harness error rather than as a result,
 * because what the campaign measured is not what the control declared.
 */
export function parseRunSummary(stdout) {
  const read = (label) => {
    const matched = new RegExp(`^ℹ ${label} (-?\\d+)$`, "m").exec(stdout);
    return matched === null ? undefined : Number(matched[1]);
  };
  return {
    tests: read("tests"),
    pass: read("pass"),
    fail: read("fail"),
    cancelled: read("cancelled"),
    skipped: read("skipped"),
  };
}

/** The counters every classification requires; a run missing one is not a run. */
const REQUIRED_COUNTERS = Object.freeze(["tests", "pass", "fail", "cancelled", "skipped"]);

/**
 * Whether an observed skip is one the control said in advance it would see.
 *
 * Both halves must match. The name alone would let any change of reason keep an
 * old excuse alive; the reason alone would let a *different* case inherit it.
 */
export function skipIsDeclared(observed, expectedSkips) {
  if (!Array.isArray(expectedSkips)) return false;
  return expectedSkips.some(
    (declared) =>
      typeof declared === "object" &&
      declared !== null &&
      observed.name.includes(String(declared.case)) &&
      observed.reason.includes(String(declared.reason)),
  );
}

export function classifyTestRun({
  stdout,
  expect,
  tests,
  mustFail,
  mustFailCases,
  prerequisite,
  expectedSkips,
  execution,
}) {
  const summary = parseRunSummary(stdout);
  const skippedCases = parseSkippedCases(stdout);
  const skippedNames = skippedCases.map((c) => c.name);

  /**
   * The facts every result carries, whatever the result turns out to be.
   *
   * The review's finding was not only that skips could be excused — it was that a
   * skip could be *omitted from the record*, so a reader could not tell an
   * agreement with a hidden skip from an agreement without one. Retaining the
   * observation on every path, including the agreeing ones, is what makes the
   * campaign's own JSON able to answer that question.
   */
  const observed = {
    pass: summary.pass ?? -1,
    fail: summary.fail ?? -1,
    tests: summary.tests ?? -1,
    cancelled: summary.cancelled ?? -1,
    skipped: summary.skipped ?? -1,
    failingFiles: [],
    ...(skippedCases.length === 0
      ? {}
      : {
          skippedCases: skippedNames,
          skipReasons: [...new Set(skippedCases.map((c) => c.reason).filter((r) => r !== ""))],
        }),
  };
  const outcome = (result, detail, extra = {}) => ({
    ...observed,
    result,
    ...(detail === undefined ? {} : { detail }),
    ...extra,
  });

  // -- what the process did, before a word of its output is believed ----------
  //
  // The order here is the correction. Everything below reads a *tail* of at most
  // `STAGE_MAX_OUTPUT_BYTES`, and a tail is perfectly capable of carrying a
  // well-formed summary from a run that was cut in half, killed by a signal, or
  // exited nonzero for a reason no test explains. Reading the tail first and
  // asking about the process afterwards is how "the stage died" becomes "nothing
  // failed", which is the shape the review reproduced.
  if (execution === null || typeof execution !== "object") {
    return outcome(
      CONTROL_RESULT.EXECUTION_FACTS_MISSING,
      "classification was not given the stage's exit status, signal and truncation state; " +
        "an observation with no execution facts cannot be scored as a measurement",
    );
  }
  if (execution.spawnError !== undefined && execution.spawnError !== null) {
    return outcome(CONTROL_RESULT.RUNNER_FAILED, `the stage could not be spawned: ${String(execution.spawnError)}`);
  }
  if (execution.timedOut === true) {
    return outcome(CONTROL_RESULT.STAGE_TIMED_OUT, "the stage was stopped by its bound");
  }
  if (execution.treeTerminationFailed === true) {
    return outcome(CONTROL_RESULT.TREE_TERMINATION_FAILED, "the stage's process group outlived its kill");
  }
  if (execution.truncated === true) {
    return outcome(
      CONTROL_RESULT.OUTPUT_TRUNCATED,
      "the stage produced more output than the collection bound, so the summary below was read " +
        "from a tail that cannot be reconciled against the whole run",
    );
  }
  if (execution.signal !== undefined && execution.signal !== null) {
    return outcome(
      CONTROL_RESULT.ABNORMAL_TERMINATION,
      `the stage was terminated by ${String(execution.signal)}`,
    );
  }
  if (!Number.isInteger(execution.status)) {
    return outcome(
      CONTROL_RESULT.ABNORMAL_TERMINATION,
      `the stage did not exit with a status (${String(execution.status)})`,
    );
  }

  // -- whether the summary is a summary --------------------------------------

  const missingCounters = REQUIRED_COUNTERS.filter((counter) => summary[counter] === undefined);
  if (missingCounters.length > 0) {
    // A module that would not load, a crash before the first test, a reporter
    // that never reached its epilogue. Not "nothing failed".
    return outcome(
      CONTROL_RESULT.RUNNER_FAILED,
      `the run printed no ${missingCounters.join(", ")} counter`,
    );
  }
  const negative = REQUIRED_COUNTERS.filter((counter) => !Number.isInteger(summary[counter]) || summary[counter] < 0);
  if (negative.length > 0) {
    return outcome(CONTROL_RESULT.IMPOSSIBLE_ACCOUNTING, `${negative.join(", ")} is negative or not a whole number`);
  }
  if (summary.tests === 0) {
    return outcome(CONTROL_RESULT.RUNNER_FAILED, "the run reported zero tests");
  }
  const accounted = summary.pass + summary.fail + summary.skipped + summary.cancelled;
  if (summary.tests !== accounted) {
    return outcome(
      CONTROL_RESULT.IMPOSSIBLE_ACCOUNTING,
      `${String(summary.tests)} tests ≠ ${String(summary.pass)} pass + ${String(summary.fail)} fail + ` +
        `${String(summary.skipped)} skipped + ${String(summary.cancelled)} cancelled`,
    );
  }

  // A cancelled case is a crash wearing a number.
  // `window-verifier-requires-commitment` produced exactly this on its first
  // campaign: the patched verifier died on a TypeError instead of refusing,
  // every case in the file was cancelled, and the run reported **0 pass / 0
  // fail** — which the classifier read as "the guard killed nothing".
  //
  // It measured nothing at all. A control that disables a guard and crashes the
  // process has not shown the guard is unnecessary; it has shown the patch was
  // wrong. Checked before skips, because a cancellation is a fault and a skip is
  // a decision; a run carrying both is the fault.
  if (summary.cancelled > 0) {
    return outcome(CONTROL_RESULT.RUNNER_FAILED, `${String(summary.cancelled)} case(s) were cancelled`);
  }

  // The exit status has to agree with the counters it supposedly summarises.
  // `node --test` exits 1 when a test failed and 0 when none did, so any other
  // pairing is a process that ended for a reason its own output does not explain.
  const expectedStatus = summary.fail > 0 ? 1 : 0;
  if (execution.status !== expectedStatus) {
    return outcome(
      CONTROL_RESULT.ABNORMAL_TERMINATION,
      `the run reported ${String(summary.fail)} failing test(s) but the process exited ` +
        `${String(execution.status)}; a parseable tail does not account for that`,
    );
  }

  // -- whether the cases are the cases ---------------------------------------

  const failingCases = parseFailingCases(stdout);
  const failingNames = failingCases.map((c) => c.name);
  const seen = new Set();
  const duplicated = [];
  for (const failing of failingCases) {
    const key = `${failing.file}::${failing.name}`;
    if (seen.has(key)) duplicated.push(key);
    else seen.add(key);
  }
  if (duplicated.length > 0) {
    return outcome(
      CONTROL_RESULT.IMPOSSIBLE_ACCOUNTING,
      `the reporter named the same failing case more than once: ${[...new Set(duplicated)].join(" | ")}`,
      { failingCases: failingNames },
    );
  }
  const bothWays = failingNames.filter((name) => skippedNames.includes(name));
  if (bothWays.length > 0) {
    return outcome(
      CONTROL_RESULT.IMPOSSIBLE_ACCOUNTING,
      `the same case is reported as both failed and skipped: ${[...new Set(bothWays)].join(" | ")}`,
      { failingCases: failingNames },
    );
  }

  // -- what did not run ------------------------------------------------------
  //
  // A case that skipped did not run, and a case that did not run cannot have
  // agreed. This is where the review of `90a0039` was answered and where the
  // review of `07da5fe` widened the answer: it is no longer enough that the
  // *designated* case ran. Every skip in the file has to be one somebody
  // declared, because "the guard's own case failed" says nothing about a
  // neighbouring case that quietly vanished in the same run.

  // Substring in the same direction as the failing-case match, so one declared
  // excerpt recognises the long descriptive name it was taken from.
  const skippedDesignated =
    mustFailCases === undefined
      ? []
      : mustFailCases.filter((declared) => skippedNames.some((n) => n.includes(declared)));

  if (skippedDesignated.length > 0) {
    const reasons = skippedCases
      .filter((c) => skippedDesignated.some((d) => c.name.includes(d)))
      .map((c) => c.reason);
    // A declared prerequisite excuses a designated skip only when the skip the
    // suite actually announced is the one the prerequisite is about. Without
    // this, any control naming any prerequisite could launder any disappearance
    // into `unmeasured_here` — the one outcome that is neither agreement nor
    // failure, and so the one that must be hardest to reach.
    const evidence =
      prerequisite === undefined ? undefined : CAMPAIGN_PREREQUISITES[prerequisite]?.skipEvidence;
    const agrees =
      Array.isArray(evidence) &&
      reasons.length > 0 &&
      reasons.every((reason) => evidence.some((marker) => reason.includes(marker)));
    return outcome(
      agrees ? CONTROL_RESULT.UNMEASURED_HERE : CONTROL_RESULT.DESIGNATED_CASE_SKIPPED,
      agrees
        ? undefined
        : prerequisite === undefined
          ? "a designated case skipped and no prerequisite declared that it might"
          : `a designated case skipped, but its reason does not name what \`${prerequisite}\` ` +
            `stands for: ${reasons.join(" | ") || "(no reason given)"}`,
      {
        skippedDesignated,
        ...(prerequisite === undefined ? {} : { prerequisite }),
      },
    );
  }

  const undeclaredSkips = skippedCases.filter((c) => !skipIsDeclared(c, expectedSkips));
  if (undeclaredSkips.length > 0) {
    return outcome(
      CONTROL_RESULT.UNEXPECTED_CASE_SKIPPED,
      `${String(undeclaredSkips.length)} case(s) skipped that this control did not declare: ` +
        undeclaredSkips.map((c) => `${c.name}${c.reason === "" ? "" : ` # ${c.reason}`}`).join(" | "),
      { undeclaredSkips: undeclaredSkips.map((c) => c.name) },
    );
  }

  // A run that reports tests but produced no outcome at all, with nothing
  // skipped to explain it, never got far enough to have an opinion.
  if (summary.pass + summary.fail === 0) {
    return outcome(CONTROL_RESULT.RUNNER_FAILED, "no case passed and none failed");
  }

  const failingFiles = [
    ...new Set(
      [...stdout.matchAll(/^test at (.+?):\d+:\d+$/gm)].map((m) => m[1].replace(/^\.\//, "")),
    ),
  ].sort();

  const declaredSkipNote =
    skippedCases.length === 0 ? {} : { declaredSkips: skippedNames };

  if (summary.fail === 0) {
    return outcome(
      expect === "fail" ? CONTROL_RESULT.TESTS_PASSED_UNEXPECTEDLY : CONTROL_RESULT.NO_KILL_AS_DECLARED,
      undefined,
      { failingFiles, ...declaredSkipNote },
    );
  }

  const permitted = (mustFail ?? tests).map((t) => t.replace(/^\.\//, ""));
  const stray = failingFiles.filter((file) => !permitted.some((t) => file.endsWith(t) || t.endsWith(file)));
  if (stray.length > 0) {
    return outcome(CONTROL_RESULT.UNRELATED_TESTS_FAILED, undefined, {
      failingFiles,
      strayFiles: stray,
      ...declaredSkipNote,
    });
  }

  // The right file failed. When the control named the case, that is not yet the
  // measurement it declared.
  if (mustFailCases !== undefined) {
    // Substring, because a declared case is an excerpt of a long descriptive
    // name and the harness must not turn a prose edit into a campaign failure.
    const missingCases = mustFailCases.filter((declared) => !failingNames.some((n) => n.includes(declared)));
    if (missingCases.length > 0) {
      return outcome(CONTROL_RESULT.DECLARED_CASES_NOT_FAILED, undefined, {
        failingFiles,
        missingCases,
        failingCases: failingNames,
        ...declaredSkipNote,
      });
    }
    return outcome(CONTROL_RESULT.NAMED_TESTS_FAILED, undefined, {
      failingFiles,
      failingCases: failingNames,
      ...declaredSkipNote,
    });
  }

  return outcome(CONTROL_RESULT.NAMED_TESTS_FAILED, undefined, { failingFiles, ...declaredSkipNote });
}

/** Whether a measured result matches what the control declared. */
export function agreesWithExpectation(result, expect) {
  if (expect === "fail") return result === CONTROL_RESULT.NAMED_TESTS_FAILED;
  if (expect === "pass") return result === CONTROL_RESULT.NO_KILL_AS_DECLARED;
  return false;
}

/**
 * Structural checks on the control table itself, run before any worktree exists.
 *
 * A malformed declaration should fail in the first second of a four-hour
 * campaign, not in its last.
 */
export function validateControlDeclarations(controls) {
  const problems = [];
  const seen = new Set();
  for (const control of controls) {
    const where = control.id ?? "<control with no id>";
    if (typeof control.id !== "string" || control.id === "") problems.push("a control has no id");
    else if (seen.has(control.id)) problems.push(`${control.id}: duplicate control id`);
    else seen.add(control.id);
    if (typeof control.what !== "string" || control.what === "") {
      problems.push(`${where}: no named invariant (\`what\`)`);
    }
    if (typeof control.file !== "string" || control.file === "") problems.push(`${where}: no target file`);
    if (typeof control.find !== "string" || control.find === "") problems.push(`${where}: no preimage`);
    if (typeof control.replace !== "string") problems.push(`${where}: no postimage`);
    if (!Array.isArray(control.tests) || control.tests.length === 0) {
      problems.push(`${where}: names no test expected to notice`);
    }
    if (control.expect !== "fail" && control.expect !== "pass") {
      problems.push(`${where}: \`expect\` must be "fail" or "pass"`);
    }
    if (control.expectedMatches !== undefined && !Number.isSafeInteger(control.expectedMatches)) {
      problems.push(`${where}: \`expectedMatches\` must be an integer`);
    }
    if (control.requiresPrerequisite !== undefined) {
      // Only a name the registry knows. A typo would otherwise buy the control a
      // permanent, silent `unmeasured_here` — the one outcome that is neither
      // agreement nor failure, and so the one a typo must never be able to reach.
      if (CAMPAIGN_PREREQUISITES[control.requiresPrerequisite] === undefined) {
        problems.push(
          `${where}: \`requiresPrerequisite\` names \`${String(control.requiresPrerequisite)}\`, ` +
            `which is not one of: ${Object.keys(CAMPAIGN_PREREQUISITES).join(", ")}`,
        );
      }
    }
    if (control.expectedSkips !== undefined) {
      // A declared skip is a promise about a *named* case with a *named* reason.
      // A vague one would re-open the hole it exists to close: every skip this
      // control's suites announce must be one a reader could have predicted from
      // the declaration alone.
      if (!Array.isArray(control.expectedSkips) || control.expectedSkips.length === 0) {
        problems.push(`${where}: \`expectedSkips\` must be a non-empty array`);
      } else {
        for (const declared of control.expectedSkips) {
          if (
            declared === null ||
            typeof declared !== "object" ||
            typeof declared.case !== "string" ||
            declared.case.trim() === "" ||
            typeof declared.reason !== "string" ||
            declared.reason.trim() === ""
          ) {
            problems.push(`${where}: every \`expectedSkips\` entry needs a non-empty \`case\` and \`reason\``);
            continue;
          }
          if ((control.mustFailCases ?? []).some((c) => declared.case.includes(c) || c.includes(declared.case))) {
            // Declaring the case you designated would be declaring away the
            // measurement itself.
            problems.push(
              `${where}: \`expectedSkips\` names \`${declared.case}\`, which is also a designated case; ` +
                `a control cannot declare its own measurement away`,
            );
          }
        }
      }
    }
    if (control.mustFail !== undefined) {
      const outside = control.mustFail.filter((t) => !control.tests.includes(t));
      if (outside.length > 0) problems.push(`${where}: \`mustFail\` names suites it does not run: ${outside.join(", ")}`);
    }
    if (control.mustFailCases !== undefined) {
      // A declared case can only be checked against a run that produced
      // failures, so it is meaningless on a control that expects none.
      if (!Array.isArray(control.mustFailCases) || control.mustFailCases.length === 0) {
        problems.push(`${where}: \`mustFailCases\` must be a non-empty array of test-name excerpts`);
      } else {
        const bad = control.mustFailCases.filter((c) => typeof c !== "string" || c.trim() === "");
        if (bad.length > 0) problems.push(`${where}: \`mustFailCases\` has empty or non-string entries`);
        const duplicates = control.mustFailCases.filter((c, i) => control.mustFailCases.indexOf(c) !== i);
        if (duplicates.length > 0) {
          problems.push(`${where}: \`mustFailCases\` repeats ${[...new Set(duplicates)].join(", ")}`);
        }
        if (control.expect !== "fail") {
          problems.push(`${where}: \`mustFailCases\` needs \`expect: "fail"\`; a control that expects no failure cannot name one`);
        }
      }
    }
  }
  return problems;
}

// -- bounded subprocess stages -----------------------------------------------

/**
 * How long each campaign stage may run before it is a hang rather than progress.
 *
 * Measured across two full 92-control campaigns — every stage of both, recorded
 * as `buildMs`/`suiteMs` in `docs/ledger/negative-controls.json` — then
 * multiplied:
 *
 *   |        | median      | worst observed                              |
 *   |--------|-------------|---------------------------------------------|
 *   | build  | 10.0–11.4 s | **50.5 s**                                  |
 *   | suite  | 81.8–89.0 s | **1,280.1 s** (`environment-bundle-verifier`)|
 *
 * `environment-bundle-verifier` designates `environmentRun.test.js` *and*
 * `environmentTerminalMutations.test.js`, so one stage runs two heavy e2e files.
 * The reference point the review named — `environmentEvidenceBoundaries`, 126 s
 * in campaign — is nowhere near the slowest, and a bound picked from it would
 * have been passed by the real worst case ten times over.
 *
 * The same stage measured 858.7 s in the first campaign and 1,280.1 s in the
 * second, on the same machine and the same tree: **1.5x run-to-run variance is
 * normal here**, which is the argument for a wide margin rather than a tight
 * one. A 20-minute suite bound looked like an 8x margin against a single timed
 * file and would have aborted the second campaign outright.
 *
 * The two stages are bounded separately because their needs differ by more than
 * an order of magnitude; one number generous enough for the suite would leave
 * the build effectively unbounded.
 *
 * The margins are ~5.9x the worst observed build and ~2.8x the worst observed
 * suite. The bound is not a performance budget: a regression that doubled a
 * suite's runtime should surface as a slow campaign a human looks into, not as
 * a control the harness scored as a hang. What it exists to catch is the
 * *unbounded* case — a disabled guard that turns a refusal into a wait —
 * because every suite here runs under `--test-timeout=0`, so nothing else in
 * the stack would ever stop it. A hang therefore costs at most one hour before
 * the campaign says so and stops.
 */
export const STAGE_TIMEOUT_MS = Object.freeze({
  build: 5 * 60_000,
  suite: 60 * 60_000,
});

/**
 * The default 1 MiB `maxBuffer` truncates a chatty suite's stdout, which loses
 * the trailing `ℹ pass/fail` summary and downgrades a real measurement to a
 * harness error. Bounded rather than removed: unbounded output is its own way
 * for a runaway control to take the campaign down.
 */
export const STAGE_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * How much of a stage's output the durable record keeps, per control.
 *
 * A tail rather than a sample, and for the same reason the collector keeps a
 * tail: everything a reader needs in order to check the classification — the
 * `ℹ pass/fail` counters, the `failing tests:` section, the skip lines — is at
 * the end. 16 KiB across 129 controls is a couple of megabytes of evidence, which
 * is the right order of magnitude for something that has to survive a fresh
 * clone. The full output's digest and byte count are recorded alongside it, so a
 * reader can tell whether they are holding all of it.
 */
export const RETAINED_OUTPUT_BYTES = 16 * 1024;

const sha256Text = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

const tailOf = (text) => {
  const bytes = Buffer.from(text, "utf8");
  return bytes.byteLength <= RETAINED_OUTPUT_BYTES
    ? text
    : bytes.subarray(-RETAINED_OUTPUT_BYTES).toString("utf8");
};

/**
 * Run one campaign stage under an explicit bound, and say plainly how it ended.
 *
 * `spawnSync` reports a timeout, a spawn failure and a clean non-zero exit in
 * three different shapes, and the two failure shapes both leave `stdout` null.
 * Reading `run.stdout` directly — which is what the harness did — collapses all
 * three into "the summary did not parse".
 */
export const STAGE_TREE_KILL_GRACE_MS = 5_000;

/** How often the reconciliation loop re-checks that the group is gone. */
const TREE_POLL_MS = 100;

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * SIGKILL an owned process *group*, falling back to the direct child.
 *
 * The same discipline `packages/core/src/adapter/sandboxLauncher.ts` uses for
 * adapter deadlines — reimplemented rather than imported, because the harness
 * must not depend on the tree it measures.
 *
 * `process.kill(-pid, …)` is a process-group signal and only exists where
 * process groups do. Windows has none, and a negative pid there is not "the
 * group", it is a different pid or an error — so it gets `taskkill /T /F`,
 * which is the platform's own tree kill.
 */
function killStageTree(pid) {
  if (process.platform === "win32") {
    const out = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { encoding: "utf8" });
    if (out.status === 0) return true;
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    // The group may already be gone, or the child may never have become a group
    // leader. Either way the direct child is still worth a signal.
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
}

/** Whether anything in the owned group is still alive. Signal 0 tests, it does not kill. */
function stageTreeAlive(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one campaign stage under an explicit bound, owning its whole process tree.
 *
 * The previous implementation used `spawnSync(… timeout, killSignal: "SIGKILL")`.
 * That bound is real but it reaches exactly one process: `npm run build` spawns
 * node, and `node --test` spawns one child per test file, so the descendants of
 * a killed stage survived it. The old test proved only that `run.pid` was dead —
 * which was true, and not the property that matters.
 *
 * So the stage is now `detached`, which makes it a process-group leader on
 * macOS and Linux, and the bound kills the *group*. After the direct child
 * closes, the group is reconciled: if anything in it is still alive it is killed
 * again, boundedly, and a group that outlives `STAGE_TREE_KILL_GRACE_MS` is a
 * `stage_tree_termination_failed` harness error rather than a result.
 *
 * Each stage also gets its own `TMPDIR`, so whatever the stage's processes
 * scatter is scattered somewhere the harness owns. It is removed **after** the
 * tree is proven dead and never before — deleting a directory a surviving
 * descendant is still writing to is how a cleanup becomes a corruption.
 *
 * No shell: `command` and `args` are passed through, so nothing is word-split
 * and there is no intermediate `sh` to lose the signal.
 */
export async function runStage({ command, args, cwd, timeoutMs, stage }) {
  const startedAt = Date.now();
  // `NODE_TEST_CONTEXT` is set by `node --test` in the processes it spawns, and a
  // nested runner that sees it declines to run any files at all — it assumes it
  // is a test file being re-entered. The campaign is normally a top-level
  // process, so this never bit it; it bites the moment anything runs a stage
  // from inside a test, which is exactly what this harness's own tests do.
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  const stageTmp = mkdtempSync(path.join(tmpdir(), `erl2-nc-stage-${stage}-`));
  env["TMPDIR"] = stageTmp;
  env["TMP"] = stageTmp;
  env["TEMP"] = stageTmp;

  const child = spawn(command, args, {
    cwd,
    env,
    shell: false,
    // Its own process group, so the bound below reaches the whole tree.
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;

  // Bounded collection, replacing `spawnSync`'s `maxBuffer`. The window is a
  // *tail*: everything the classifier reads — the `ℹ pass/fail` summary and the
  // `failing tests:` section — is at the end of the stream, so discarding the
  // head keeps a run classifiable where discarding the tail would downgrade a
  // real measurement to a harness error.
  const collect = () => {
    const chunks = [];
    let total = 0;
    let truncated = false;
    return {
      push(chunk) {
        chunks.push(chunk);
        total += chunk.byteLength;
        while (total > STAGE_MAX_OUTPUT_BYTES && chunks.length > 1) {
          total -= chunks.shift().byteLength;
          truncated = true;
        }
      },
      text() {
        return Buffer.concat(chunks).subarray(-STAGE_MAX_OUTPUT_BYTES).toString("utf8");
      },
      get truncated() {
        return truncated;
      },
    };
  };
  const out = collect();
  const err = collect();
  child.stdout.on("data", (chunk) => { out.push(chunk); });
  child.stderr.on("data", (chunk) => { err.push(chunk); });

  let timedOut = false;
  let spawnError;
  // Captured rather than discarded. A stage killed by a signal exits with a null
  // status and a signal name, and the classifier is now required to see the
  // difference between that and an ordinary nonzero exit — a SIGSEGV halfway
  // through a suite can still leave a perfectly parseable summary behind it.
  let signal = null;
  const timer = setTimeout(() => {
    timedOut = true;
    if (pid !== undefined) killStageTree(pid);
  }, timeoutMs);
  timer.unref?.();

  const status = await new Promise((resolve) => {
    child.on("error", (error) => {
      spawnError = `${String(error.code ?? error.name)}: ${error.message}`;
      resolve(null);
    });
    // `close` rather than `exit`: the stdio streams are drained first, so the
    // output a stage produced just before dying is not lost.
    child.on("close", (code, closedBy) => {
      signal = closedBy ?? null;
      resolve(code);
    });
  });
  clearTimeout(timer);

  // Reconciliation, on every path and not only on timeout: a stage that
  // returned cleanly while leaking a descendant is the same residue problem
  // wearing a green tick. `stageTreeAlive` is a no-op when nothing survived.
  let treeTerminationFailed = false;
  if (pid !== undefined && spawnError === undefined) {
    const deadline = Date.now() + STAGE_TREE_KILL_GRACE_MS;
    while (stageTreeAlive(pid)) {
      if (Date.now() >= deadline) {
        treeTerminationFailed = true;
        break;
      }
      killStageTree(pid);
      await delay(TREE_POLL_MS);
    }
  }

  // Only now, and only if nothing of ours is still running.
  let stageTmpRemoved = false;
  if (!treeTerminationFailed) {
    try {
      rmSync(stageTmp, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Reported through `stageTmpRemoved`, never thrown: a temporary directory
      // that will not delete must not become this stage's result.
    }
    stageTmpRemoved = !existsSync(stageTmp);
  }

  return {
    stage,
    status,
    signal,
    pid,
    stdout: out.text(),
    stderr: err.text(),
    truncated: out.truncated || err.truncated,
    elapsedMs: Date.now() - startedAt,
    timedOut,
    treeTerminationFailed,
    stageTmp,
    stageTmpRemoved,
    spawnError,
  };
}
// -- the campaign ------------------------------------------------------------

async function main() {
  const campaignStartedAt = new Date().toISOString();
  const campaignStartMs = Date.now();
  // Where the durable record goes. A *file* rather than a directory, and never
  // defaulted: the ignored `docs/ledger/negative-controls.json` below is still
  // written for continuity, but it is explicitly not the evidence — it is
  // overwritten by every targeted run, which is exactly why the review refused to
  // treat it as a campaign record. A run that wants durable evidence says where.
  const evidenceOutFlag = process.argv.indexOf("--evidence-out");
  const evidenceOut = evidenceOutFlag === -1 ? undefined : process.argv[evidenceOutFlag + 1];

  const declarationProblems = validateControlDeclarations(CONTROLS);
  if (declarationProblems.length > 0) {
    console.error("negative-control refuses to run: the control table is malformed\n");
    for (const problem of declarationProblems) console.error(`  ${problem}`);
    process.exit(2);
  }

  // `--list` answers "what would this campaign measure?" without measuring it.
  //
  // It exists because scope was silently wrong once: twelve `subject-adapter/v2`
  // controls lived in a second script with its own runner, and the campaign went
  // on reporting 129 as its scope while none of the twelve was discoverable here.
  // Nothing was lying; there was simply no cheap way to ask. This is that way,
  // and it deliberately mutates nothing, so it does not need a clean tree.
  if (process.argv.includes("--list")) {
    console.log(`negative-control discovery: ${String(CONTROLS.length)} control(s)\n`);
    for (const control of CONTROLS) {
      console.log(`  ${control.id}\t${control.file}\t${control.what}`);
    }
    process.exit(0);
  }

  const before = treeDigest(root);

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
  // touches. A full campaign is ~70 builds and ~70 suite runs; a package that
  // changed nine guards should be able to say which nine it measured rather than
  // choosing between four hours and a partial answer with no record of which part.
  // Positional, and only positional: `--evidence-out` takes a value, and a path
  // silently read as a control filter would run a campaign of nothing while
  // looking like it had run one of something.
  const positional = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    const argument = process.argv[i];
    if (argument === "--evidence-out") {
      i += 1;
      continue;
    }
    if (argument.startsWith("--")) continue;
    positional.push(argument);
  }
  const filter = positional[0];
  const wanted = filter === undefined ? undefined : filter.split(",").filter(Boolean);
  const selected = CONTROLS.filter(
    (c) => wanted === undefined || wanted.some((needle) => c.id.includes(needle)),
  );
  if (selected.length === 0) {
    console.error(`no control matches ${String(filter)}`);
    process.exit(2);
  }

  const disposable = createDisposableWorktree({ repoRoot: root });
  const { worktree, worktreeRoot } = disposable;
  console.log(`negative controls: ${String(selected.length)} of ${String(CONTROLS.length)}`);
  console.log(`worktree: ${worktree}`);
  disposable.installSignalHandlers((signal) => {
    console.error(`\nnegative-control: ${signal} received — removing the worktree before exiting.`);
  });

  const results = [];
  // Fetching is opt-in and loud. A campaign that silently reached the network
  // would make its own result depend on what a URL served that afternoon, which
  // is the opposite of what a pinned fixture is for.
  const allowFetch = process.env["ERL2_CAMPAIGN_ALLOW_FETCH"] === "1";
  const archiveOverride = process.env["ERL2_CAMPAIGN_OTEL_ARCHIVE"];
  const prerequisiteCache = new Map();
  const announcedPrerequisites = new Set();
  let aborted;
  try {
    console.log("installing dependencies in the worktree (once)…");
    const install = spawnSync("npm", ["install", "--silent"], { cwd: worktree, encoding: "utf8" });
    if (install.status !== 0) {
      throw new Error(`npm install failed in the worktree:\n${install.stderr.slice(0, 2000)}`);
    }

    for (const control of selected) {
      // Prerequisites first, and once. The campaign runs one reusable worktree,
      // so a fixture belongs to the worktree rather than to each control that
      // needs it; `ensurePrerequisite` memoises on `prerequisiteCache` and the
      // second declaring control pays nothing. A control that declares nothing
      // asks for nothing and never reaches this branch.
      if (control.requiresPrerequisite !== undefined) {
        const outcome = ensurePrerequisite(
          control.requiresPrerequisite,
          { repoRoot: root, worktree, allowFetch, ...(archiveOverride === undefined ? {} : { archiveOverride }) },
          prerequisiteCache,
        );
        if (outcome.status !== PREREQUISITE_STATUS.SATISFIED) {
          // Not patched, not built, not run. The campaign already knows it
          // cannot measure this guard here, and spending ninety seconds proving
          // that again would only produce a skip for the classifier to
          // re-derive. `agreed: null` rather than `false`: the summary counts
          // this in its own column, and a control that ran nothing has neither
          // agreed nor disagreed.
          results.push({
            id: control.id,
            what: control.what,
            expected: control.expect,
            result: CONTROL_RESULT.UNMEASURED_HERE,
            harnessError: false,
            unmeasured: true,
            agreed: null,
            prerequisite: control.requiresPrerequisite,
            detail: outcome.reason,
          });
          console.log(
            `  ⊘ ${control.id}: UNMEASURED HERE — ${CAMPAIGN_PREREQUISITES[control.requiresPrerequisite].describe} ` +
              `is unavailable\n      ${String(outcome.reason ?? "")}`,
          );
          continue;
        }
        if (!announcedPrerequisites.has(control.requiresPrerequisite)) {
          announcedPrerequisites.add(control.requiresPrerequisite);
          console.log(
            `  · prerequisite ${control.requiresPrerequisite}: satisfied` +
              (outcome.extractionRoot === undefined
                ? ""
                : ` (${outcome.reused ? "reused" : "provisioned"} ${outcome.extractionRoot}` +
                  `${outcome.archiveSha256 === undefined ? "" : `, archive ${outcome.archiveSha256}`})`),
          );
        }
      }

      const target = path.join(worktree, control.file);
      const source = readFileSync(target, "utf8");

      const plan = planControlPatch({
        source,
        find: control.find,
        replace: control.replace,
        ...(control.expectedMatches === undefined ? {} : { expectedMatches: control.expectedMatches }),
        ...(control.anchor === undefined ? {} : { anchor: control.anchor }),
        ...(control.uniquePostimage === undefined ? {} : { uniquePostimage: control.uniquePostimage }),
      });

      if (plan.outcome !== TARGET_OUTCOME.APPLIED) {
        // A control whose patch cannot be proven to hit its declared target is a
        // *failure of the campaign*, not a silent skip and not a result: the
        // guard may have moved, been renamed, been deleted, or — the case that
        // cost three controls — acquired a second occurrence above the intended
        // one. Any of those needs a human.
        results.push({
          id: control.id,
          what: control.what,
          expected: control.expect,
          result: plan.outcome,
          harnessError: true,
          agreed: false,
          detail: { ...plan, patched: undefined, preimage: control.find.slice(0, 90) },
        });
        console.log(`  ✖ ${control.id}: ${plan.outcome}`);
        continue;
      }

      writeFileSync(target, plan.patched);

      // Re-read rather than trusting the write: the compiler is about to read
      // these bytes, so these are the bytes the control must have proven.
      const landed = verifyPatchOnDisk({
        written: readFileSync(target, "utf8"),
        plan,
        replace: control.replace,
      });
      if (landed.outcome !== TARGET_OUTCOME.APPLIED) {
        results.push({
          id: control.id,
          what: control.what,
          expected: control.expect,
          result: landed.outcome,
          harnessError: true,
          agreed: false,
          detail: landed,
        });
        console.log(`  ✖ ${control.id}: ${landed.outcome}`);
        const residualAfterLanding = disposable.restore();
        if (residualAfterLanding !== undefined) {
          aborted = { id: control.id, residual: residualAfterLanding };
          break;
        }
        continue;
      }

      const build = await runStage({
        command: "npm",
        args: ["run", "build"],
        cwd: worktree,
        timeoutMs: STAGE_TIMEOUT_MS.build,
        stage: "build",
      });
      if (build.timedOut || build.treeTerminationFailed) {
        // A hang is not a slow result, and neither is a stage whose process tree
        // outlived its kill. Both stop the campaign: a surviving descendant may
        // still be writing into the worktree the next control is about to patch,
        // and measuring a control against a contended tree produces a number
        // that means nothing.
        const failure = build.treeTerminationFailed
          ? CONTROL_RESULT.TREE_TERMINATION_FAILED
          : CONTROL_RESULT.STAGE_TIMED_OUT;
        results.push({
          id: control.id,
          what: control.what,
          expected: control.expect,
          result: failure,
          harnessError: true,
          agreed: false,
          stage: "build",
          elapsedMs: build.elapsedMs,
          stageTmp: build.stageTmp,
          stageTmpRemoved: build.stageTmpRemoved,
          detail: build.treeTerminationFailed
            ? `the build process group outlived ${String(STAGE_TREE_KILL_GRACE_MS)} ms of SIGKILL; ` +
              `its temporary root ${build.stageTmp} was left in place rather than deleted under a live process`
            : `build exceeded ${String(STAGE_TIMEOUT_MS.build)} ms and its process group was SIGKILLed`,
        });
        console.log(
          `  ✖ ${control.id}: the build stage ${build.treeTerminationFailed ? "could not be fully terminated" : "timed out"} ` +
            `after ${String(build.elapsedMs)} ms`,
        );
        aborted = { id: control.id, residual: undefined, timedOut: "build" };
        disposable.restore();
        break;
      }
      if (build.status !== 0) {
        // Not a behavioural kill. The patched tree does not compile, which is a
        // fact about the patch and says nothing about whether the guard is
        // load-bearing.
        results.push({
          id: control.id,
          what: control.what,
          expected: control.expect,
          result: CONTROL_RESULT.BUILD_FAILED,
          harnessError: true,
          agreed: false,
          detail: build.stdout.slice(-800),
        });
        console.log(`  ✖ ${control.id}: the patched tree does not build`);
        const residualAfterBuild = disposable.restore();
        if (residualAfterBuild !== undefined) {
          aborted = { id: control.id, residual: residualAfterBuild };
          break;
        }
        continue;
      }

      const run = await runStage({
        command: "node",
        // The reporter is named rather than defaulted: `classifyTestRun` parses
        // the spec reporter's summary lines and its `failing tests:` section, so
        // the format the classifier depends on is the format the stage asks for.
        args: ["--test", "--test-reporter=spec", ...control.tests],
        cwd: worktree,
        timeoutMs: STAGE_TIMEOUT_MS.suite,
        stage: "suite",
      });
      if (run.timedOut || run.treeTerminationFailed) {
        // The case the bound exists for: a disabled guard that turns a refusal
        // into a wait. Under `--test-timeout=0` nothing else would ever stop it,
        // and in a multi-hour campaign a hang and slow progress look identical.
        // `node --test` spawns one process per test file, so the kill has to
        // reach the group; a group that survives it is its own harness error.
        const failure = run.treeTerminationFailed
          ? CONTROL_RESULT.TREE_TERMINATION_FAILED
          : CONTROL_RESULT.STAGE_TIMED_OUT;
        results.push({
          id: control.id,
          what: control.what,
          expected: control.expect,
          result: failure,
          harnessError: true,
          agreed: false,
          stage: "suite",
          elapsedMs: run.elapsedMs,
          stageTmp: run.stageTmp,
          stageTmpRemoved: run.stageTmpRemoved,
          detail: run.treeTerminationFailed
            ? `the suite process group outlived ${String(STAGE_TREE_KILL_GRACE_MS)} ms of SIGKILL; ` +
              `its temporary root ${run.stageTmp} was left in place rather than deleted under a live process`
            : `the designated suite exceeded ${String(STAGE_TIMEOUT_MS.suite)} ms and its process group was SIGKILLed`,
        });
        console.log(
          `  ✖ ${control.id}: the suite stage ${run.treeTerminationFailed ? "could not be fully terminated" : "timed out"} ` +
            `after ${String(run.elapsedMs)} ms`,
        );
        aborted = { id: control.id, residual: undefined, timedOut: "suite" };
        disposable.restore();
        break;
      }
      const classified = classifyTestRun({
        // `runStage` normalises the null stdout that a spawn failure produces, so
        // an unspawnable runner reaches the classifier as an unparseable run —
        // a harness error — rather than as a crash inside the classifier.
        stdout: run.stdout,
        // The complete execution facts, not a summary of them. Truncation, a
        // signal, an exit status the counters do not explain: each is decided by
        // the classifier itself, so no path exists where an incomplete
        // observation is scored first and annotated afterwards. The build stage's
        // truncation rides along, because a build whose output was cut is not a
        // clean input to the suite that follows it.
        execution: {
          status: run.status,
          signal: run.signal ?? null,
          timedOut: run.timedOut,
          treeTerminationFailed: run.treeTerminationFailed,
          truncated: run.truncated || build.truncated,
          ...(run.spawnError === undefined ? {} : { spawnError: run.spawnError }),
        },
        expect: control.expect,
        tests: control.tests,
        ...(control.mustFail === undefined ? {} : { mustFail: control.mustFail }),
        ...(control.mustFailCases === undefined ? {} : { mustFailCases: control.mustFailCases }),
        ...(control.expectedSkips === undefined ? {} : { expectedSkips: control.expectedSkips }),
        // A satisfied prerequisite can still leave the designated case skipped —
        // the rendered-topology case needs a daemon as well as the fixture. The
        // control declared that it might not be answerable here, so a skip is
        // still `unmeasured_here` rather than a manufactured disagreement.
        ...(control.requiresPrerequisite === undefined
          ? {}
          : { prerequisite: control.requiresPrerequisite }),
      });
      const unmeasured = isUnmeasured(classified.result);
      const agreed = unmeasured ? null : agreesWithExpectation(classified.result, control.expect);
      results.push({
        id: control.id,
        what: control.what,
        expected: control.expect,
        result: classified.result,
        harnessError: isHarnessError(classified.result),
        replacedCount: plan.replacedCount,
        offsets: plan.offsets,
        pass: classified.pass,
        fail: classified.fail,
        agreed,
        ...(unmeasured ? { unmeasured: true } : {}),
        ...(control.requiresPrerequisite === undefined
          ? {}
          : { prerequisite: control.requiresPrerequisite }),
        // The complete observation, on every row and whatever the row concluded.
        // A campaign record that drops the counters on its agreeing rows cannot
        // be asked afterwards whether anything was hidden behind them.
        tests: classified.tests,
        cancelled: classified.cancelled,
        skipped: classified.skipped,
        ...(classified.skippedCases === undefined ? {} : { skippedCases: classified.skippedCases }),
        ...(classified.skipReasons === undefined ? {} : { skipReasons: classified.skipReasons }),
        ...(classified.undeclaredSkips === undefined ? {} : { undeclaredSkips: classified.undeclaredSkips }),
        ...(control.expectedSkips === undefined
          ? {}
          : { expectedSkips: control.expectedSkips.map((s) => ({ case: s.case, reason: s.reason })) }),
        ...(classified.detail === undefined ? {} : { classifierDetail: classified.detail }),
        // The identity of what actually ran, so a reader can reproduce the row
        // rather than trust it.
        command: ["node", "--test", "--test-reporter=spec", ...control.tests].join(" "),
        exitStatus: run.status,
        exitSignal: run.signal ?? null,
        buildExitStatus: build.status,
        buildMs: build.elapsedMs,
        suiteMs: run.elapsedMs,
        stageTmpRemoved: build.stageTmpRemoved && run.stageTmpRemoved,
        outputTruncated: run.truncated || build.truncated,
        suiteOutputSha256: sha256Text(`${run.stdout}${run.stderr}`),
        suiteOutputBytes: Buffer.byteLength(run.stdout) + Buffer.byteLength(run.stderr),
        suiteOutputTail: tailOf(`${run.stdout}${run.stderr}`),
        ...(run.spawnError === undefined ? {} : { spawnError: run.spawnError }),
        ...(classified.strayFiles === undefined ? {} : { strayFiles: classified.strayFiles }),
        ...(control.mustFailCases === undefined ? {} : { mustFailCases: [...control.mustFailCases] }),
        ...(classified.failingCases === undefined ? {} : { failingCases: classified.failingCases }),
        ...(classified.missingCases === undefined ? {} : { missingCases: classified.missingCases }),
        ...(control.note === undefined ? {} : { note: control.note }),
      });
      if (classified.missingCases !== undefined) {
        console.log(
          `    declared case(s) that did not fail: ${classified.missingCases.join(" | ")}\n` +
            `    cases that did fail: ${(classified.failingCases ?? []).join(" | ") || "(none named)"}`,
        );
      }
      console.log(
        `  ${unmeasured ? "⊘" : agreed ? "✔" : "✖"} ${control.id}: ${String(classified.pass)} pass / ` +
          `${String(classified.fail)} fail${classified.skipped ? ` / ${String(classified.skipped)} skipped` : ""} ` +
          `(expected ${control.expect}, ${classified.result})` +
          `${unmeasured ? " — UNMEASURED HERE" : ""}${control.note === undefined ? "" : ` — ${control.note}`}`,
      );

      const residual = disposable.restore();
      if (residual !== undefined) {
        results.push({
          id: control.id,
          result: CONTROL_RESULT.RESTORATION_FAILED,
          harnessError: true,
          agreed: false,
          detail: residual.slice(0, 800),
        });
        aborted = { id: control.id, residual };
        break;
      }
    }
  } finally {
    // The worktree goes whatever happened, and the real tree is proven untouched.
    // Shared with the signal handlers above, so a normal exit and an interrupted
    // one release exactly the same things.
    disposable.release();
  }

  const residue = worktreeResidue({ repoRoot: root, worktree, worktreeRoot });

  const certified = certifyTreeUnchanged(before, treeDigest(root));
  if (!certified.certified) {
    console.error(
      "\nnegative-control FAILED: the working tree changed while controls ran.\n" +
        "This harness must never modify the tree it is measuring.",
    );
    console.error(`  ${certified.reason}\n  before: ${certified.before}\n  after:  ${certified.after}`);
    process.exit(1);
  }
  console.log("\nthe working tree is byte-identical to how the campaign started");

  // Every discovered control lands in exactly one column, and the columns sum to
  // the discovery count. A campaign that cannot show that has not accounted for
  // its own controls — which is how one unmeasured control spent a full run
  // being reported as a disagreement.
  const measuredAgreements = results.filter((r) => r.agreed === true).length;
  const disagreements = results.filter((r) => r.agreed === false && r.harnessError !== true).length;
  const unmeasuredControls = results.filter((r) => r.unmeasured === true);
  const harnessErrors = results.filter((r) => r.harnessError === true).length;
  const accounting = {
    discovered: selected.length,
    measured_agreements: measuredAgreements,
    disagreements,
    unmeasured: unmeasuredControls.length,
    harness_errors: harnessErrors,
  };
  const accounted = measuredAgreements + disagreements + unmeasuredControls.length + harnessErrors;
  const reconciled = accounted === results.length && results.length === selected.length;

  // The ignored, mutable, last-output-wins file. Kept for continuity and
  // explicitly not the evidence: the retained output tails are stripped, because
  // a file nobody can verify does not become more useful by being larger.
  writeFileSync(
    path.join(root, "docs", "ledger", "negative-controls.json"),
    `${JSON.stringify(
      {
        generated_by: "scripts/negative-control.mjs",
        authoritative: false,
        note:
          "Regenerated by every campaign, including targeted ones, and excluded by .gitignore. " +
          "The durable record is written by --evidence-out; see docs/evidence/validation-harness-closure/.",
        selected: selected.length,
        of: CONTROLS.length,
        accounting,
        reconciled,
        results: results.map(({ suiteOutputTail, ...rest }) => rest),
      },
      null,
      2,
    )}\n`,
  );

  if (evidenceOut !== undefined) {
    const identity = repositoryIdentity(root);
    const endedAtMs = Date.now();
    const record = {
      schema: CAMPAIGN_SCHEMA,
      version: EVIDENCE_VERSION,
      generated_by: "scripts/negative-control.mjs",
      executable: identity,
      command: `node scripts/negative-control.mjs${filter === undefined ? "" : ` ${filter}`}`,
      targeted: filter !== undefined,
      started_at: campaignStartedAt,
      ended_at: new Date(endedAtMs).toISOString(),
      duration_ms: endedAtMs - campaignStartMs,
      configuration: {
        allow_fetch: allowFetch,
        archive_override: archiveOverride ?? null,
        allow_dirty: process.argv.includes("--allow-dirty"),
        stage_timeout_ms: { ...STAGE_TIMEOUT_MS },
        stage_max_output_bytes: STAGE_MAX_OUTPUT_BYTES,
        retained_output_bytes: RETAINED_OUTPUT_BYTES,
      },
      discovered: selected.length,
      of: CONTROLS.length,
      controls: selected.map((c) => c.id),
      prerequisites: Object.fromEntries(
        [...prerequisiteCache.entries()].map(([id, outcome]) => [
          id,
          {
            declared_by: selected.filter((c) => c.requiresPrerequisite === id).map((c) => c.id),
            ...outcome,
          },
        ]),
      ),
      accounting,
      reconciled,
      repository_byte_identical: certified.certified === true,
      residue,
      results,
    };
    mkdirSync(path.dirname(path.resolve(evidenceOut)), { recursive: true });
    writeFileSync(path.resolve(evidenceOut), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`\ndurable campaign record: ${path.resolve(evidenceOut)}`);
  }

  console.log(
    `\naccounting: ${String(accounting.discovered)} discovered = ` +
      `${String(accounting.measured_agreements)} agreed + ${String(accounting.disagreements)} disagreed + ` +
      `${String(accounting.unmeasured)} unmeasured + ${String(accounting.harness_errors)} harness error(s)`,
  );
  if (unmeasuredControls.length > 0) {
    console.log("\nUNMEASURED HERE — declared prerequisite unavailable on this host:");
    for (const r of unmeasuredControls) {
      console.log(`  ⊘ ${r.id} (${String(r.prerequisite)}): ${String(r.detail ?? r.skipReasons?.join(" | ") ?? "")}`);
    }
    console.log(
      "  These are neither agreements nor disagreements. The guards they name are\n" +
        "  unproven on this host and must not be reported as load-bearing here.",
    );
  }
  if (!reconciled) {
    console.error(
      `\nnegative-control FAILED: the summary does not account for every control ` +
        `(${String(accounted)} accounted, ${String(results.length)} recorded, ${String(selected.length)} discovered)`,
    );
    process.exit(1);
  }

  if (residue.length > 0) {
    console.error(`\nnegative-control FAILED: ${CONTROL_RESULT.RESIDUE_FAILED}`);
    for (const line of residue) console.error(`  ${line}`);
    process.exit(1);
  }

  if (aborted !== undefined && aborted.timedOut !== undefined) {
    console.error(
      `\nnegative-control FAILED: the ${aborted.timedOut} stage of ${aborted.id} was stopped by its bound.\n` +
        "A timeout is a harness error, never a kill and never an agreement: the campaign\n" +
        "learned nothing about that guard. It stopped there rather than patch a worktree a\n" +
        "killed stage may still have descendants inside.",
    );
    process.exit(1);
  }
  if (aborted !== undefined) {
    console.error(
      `\nnegative-control FAILED: the worktree could not be restored after ${aborted.id}.\n` +
        "The campaign stopped there rather than measuring later controls against a\n" +
        "tree still carrying this control's patch.\n\n" +
        aborted.residual,
    );
    process.exit(1);
  }

  const disagreed = results.filter((r) => r.agreed === false);
  if (disagreed.length > 0) {
    const harnessErrors = disagreed.filter((r) => r.harnessError === true);
    console.error(
      `\nnegative-control FAILED: ${String(disagreed.length)} control(s) disagreed with their recorded expectation` +
        (harnessErrors.length > 0
          ? `, of which ${String(harnessErrors.length)} measured nothing (a harness error rather than a result)`
          : ""),
    );
    for (const r of disagreed) console.error(`  ${r.id}: ${JSON.stringify(r)}`);
    process.exit(1);
  }
  console.log(
    `all ${String(measuredAgreements)} measured control(s) matched their recorded expectation` +
      (unmeasuredControls.length === 0
        ? ""
        : `; ${String(unmeasuredControls.length)} were UNMEASURED HERE and are claimed for nothing`),
  );
}

// Importable for its own tests without starting a four-hour campaign.
const entry = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (entry === import.meta.url) await main();
