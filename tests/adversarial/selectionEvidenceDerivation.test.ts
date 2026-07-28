/**
 * Verifier-side derivation of the selection chain (Slice 6.5-A §15.1).
 *
 * Every case runs against a selection subtree produced by the **shipped
 * `erl2 select`**, not a hand-built fixture — brief §14 forbids fixture-built
 * artifacts as completion evidence, and a derivation tested against evidence the
 * test itself wrote would prove only that the test agrees with itself.
 *
 * The property is that the verifier assembles the chain from retained bytes
 * alone. A producer-supplied list of members would let a run nominate what gets
 * verified — retaining a complete chain and omitting the member that
 * contradicts it — which is exactly what deriving independently prevents.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coreHash, TrustEvaluator, type LocalTrustConfiguration } from "@erl2/integrity";
import { DevelopmentBeaconSource, verifySelectionChain } from "@erl2/core";
import { ArtifactIndex, deriveSelectionEvidence, assertNoSelectionArtifacts } from "@erl2/public-verifier";
import type { LabLifecycleEventV1, TrustPolicyManifestV2 } from "@erl2/contracts";
import { erl2, runToAcquired } from "../support/cliRun.js";
import type { GovernorRegistry } from "../support/governorRegistry.js";

interface SelectedRun {
  readonly runRoot: string;
  readonly registry: GovernorRegistry;
}

/** Drives the shipped CLI to a completed selection. */
function selectedRun(): SelectedRun {
  const run = runToAcquired();
  const base = [
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ];
  assert.equal(erl2(["freeze-package", ...base]).exitCode, 0);
  assert.equal(
    erl2([
      "verify-package", ...base,
      "--fake-verify-package", "succeeded",
      "--subject-id", "s",
      "--subject-version", "0.1.0",
    ]).exitCode,
    0,
  );
  assert.equal(
    erl2([
      "preregister-challenge", ...base,
      "--journey-selection-policy", run.registry.journeySelectionPolicyHash,
      "--randomness-policy", run.registry.randomnessPolicyHash,
      ...run.registry.challengeCandidates.flatMap((c) => ["--challenge", c.challengeManifestHash]),
    ]).exitCode,
    0,
  );
  const stc = path.join(run.runRoot, "source-trust.json");
  writeFileSync(
    stc,
    JSON.stringify({
      sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
      randomnessRegistryHeadHash: run.registry.sourceTrustPolicyHash,
    }),
  );
  const selected = erl2([
    "select", ...base,
    "--source-trust-config", stc,
    "--expires", "2026-12-31T00:00:00Z",
  ]);
  assert.equal(selected.exitCode, 0, JSON.stringify(selected.body.errors));
  assert.equal(selected.body.state, "case_selected");
  return { runRoot: run.runRoot, registry: run.registry };
}

/** One completed selection, copied per case so mutations stay isolated. */
let template: SelectedRun | undefined;
function freshCopy(): SelectedRun {
  template ??= selectedRun();
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-selderiv-"));
  cpSync(template.runRoot, dest, { recursive: true });
  return { runRoot: dest, registry: template.registry };
}

function lifecycleOf(run: SelectedRun): readonly LabLifecycleEventV1[] {
  const dir = path.join(run.runRoot, "events");
  return readdirSync(dir)
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as LabLifecycleEventV1);
}

function derive(run: SelectedRun): ReturnType<typeof deriveSelectionEvidence> {
  return deriveSelectionEvidence(ArtifactIndex.scan(run.runRoot), lifecycleOf(run));
}

function trustOf(run: SelectedRun): TrustEvaluator {
  const policy = JSON.parse(
    readFileSync(path.join(run.registry.root, "run-trust-policy.json"), "utf8"),
  ) as TrustPolicyManifestV2;
  // The pinned entry comes from the beacon the CLI uses, so the verifier pins
  // exactly what the producer was authorized against.
  const beacon = new DevelopmentBeaconSource({
    seed: "unused-for-pinning",
    firstRoundAt: "2026-07-01T00:00:00Z",
  });
  const local: LocalTrustConfiguration = {
    rootKeyIds: [policy.root_key_id],
    currentTrustHeadHash: coreHash(policy as unknown as Record<string, unknown>),
    randomnessSources: [beacon.pinnedRegistryEntry(run.registry.sourceTrustPolicyHash)],
    randomnessRegistryHeadHash: run.registry.sourceTrustPolicyHash,
  };
  return new TrustEvaluator(policy, local);
}

/** Overwrites a frozen retained artifact, which is read-only on disk. */
function overwrite(file: string, value: unknown): void {
  chmodSync(file, 0o644);
  writeFileSync(file, JSON.stringify(value));
}

const SELECTION_DIR = ["retained", "selection"];

/** The compiled test runs from `tests/dist/adversarial`, so the root is three up. */
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");

test("SEL-DERIVE: the chain is assembled from retained bytes and verifies", () => {
  const run = freshCopy();
  const evidence = derive(run);

  // All seventeen members, resolved without any producer-supplied list.
  assert.equal(evidence.request.schema_version, "selection-request/v2");
  assert.equal(evidence.poolEntries.length, evidence.poolManifest.entry_count);
  assert.equal(evidence.receipt.schema_version, "selection-verification-receipt/v2");

  // And the derived evidence is what the chain verifier accepts.
  const outcome = verifySelectionChain(evidence, trustOf(run));
  assert.equal(outcome.selectedEntryHash, evidence.commitment.selected_entry_hash);
  assert.equal(outcome.poolRootHash, evidence.poolManifest.pool_root_hash);
  rmSync(run.runRoot, { recursive: true, force: true });
});

test("SEL-DERIVE: each checkpoint is identified by what it anchors", () => {
  const run = freshCopy();
  const evidence = derive(run);
  const anchors = (checkpoint: { entries: readonly { artifact_core_hash: string }[] }): string[] =>
    checkpoint.entries.map((e) => e.artifact_core_hash);

  // Three distinct checkpoints, each anchoring its own target — not assigned by
  // ordering or by a producer label.
  assert.ok(anchors(evidence.poolCheckpoint).includes(coreHash(evidence.poolManifest)));
  assert.ok(anchors(evidence.commitmentCheckpoint).includes(coreHash(evidence.commitment)));
  assert.ok(anchors(evidence.bindingCheckpoint).includes(coreHash(evidence.binding)));
  assert.equal(
    new Set([
      coreHash(evidence.poolCheckpoint),
      coreHash(evidence.commitmentCheckpoint),
      coreHash(evidence.bindingCheckpoint),
    ]).size,
    3,
    "the three checkpoints are distinct artifacts",
  );
  rmSync(run.runRoot, { recursive: true, force: true });
});

test("SEL-DERIVE: a missing selection member is refused, never defaulted", () => {
  for (const file of [
    "selection-request.json",
    "role-separation-audit.json",
    "randomness-receipt.json",
    "source-trust-report.json",
    "commitment.json",
    "threshold-reveal-receipt.json",
    "selected-binding.json",
    "selection-proof.json",
    "selection-verification-receipt.json",
  ]) {
    const run = freshCopy();
    rmSync(path.join(run.runRoot, ...SELECTION_DIR, file));
    rmSync(path.join(run.runRoot, ...SELECTION_DIR, `${file}.frozen`), { force: true });
    assert.throws(
      () => derive(run),
      (error: { code?: string }) =>
        error.code === "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT" || error.code === "TIMESTAMP_TARGET_MISSING",
      `removing ${file} must refuse`,
    );
    rmSync(run.runRoot, { recursive: true, force: true });
  }
});

test("SEL-DERIVE: a duplicated selection member is refused, not silently chosen between", () => {
  const run = freshCopy();
  const dir = path.join(run.runRoot, ...SELECTION_DIR);
  // A byte-copy under another name: the chain admits exactly one commitment, so
  // the verifier must refuse rather than pick whichever it walked into first.
  cpSync(path.join(dir, "commitment.json"), path.join(dir, "commitment-copy.json"));
  assert.throws(
    () => derive(run),
    (error: { code?: string }) => error.code === "GRAPH_CLOSURE_EXTRA_ARTIFACT",
    "two commitments must refuse",
  );
  rmSync(run.runRoot, { recursive: true, force: true });
});

test("SEL-DERIVE: a pool entry the manifest does not order is refused", () => {
  const run = freshCopy();
  const entries = path.join(run.runRoot, ...SELECTION_DIR, "pool-entries");
  const names = readdirSync(entries).filter((n) => n.endsWith(".json"));
  const first = names[0] as string;
  cpSync(path.join(entries, first), path.join(entries, `extra-${first}`));
  assert.throws(
    () => derive(run),
    (error: { code?: string }) => error.code === "GRAPH_CLOSURE_EXTRA_ARTIFACT",
    "an unordered pool entry is an extra",
  );
  rmSync(run.runRoot, { recursive: true, force: true });
});

test("SEL-DERIVE: entries are taken in the manifest's order, not the directory's", () => {
  const run = freshCopy();
  const evidence = derive(run);
  const derivedOrder = evidence.poolEntries.map((e) => coreHash(e));
  assert.deepEqual(
    derivedOrder,
    [...evidence.poolManifest.ordered_entry_hashes],
    "the ordered entry list is what the pool root commits to",
  );

  // Reordering the manifest's list must change what the chain verifies against,
  // and the pool root no longer matches.
  const manifestPath = path.join(run.runRoot, ...SELECTION_DIR, "eligibility-pool-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    ordered_entry_hashes: string[];
  };
  const reordered = { ...manifest, ordered_entry_hashes: [...manifest.ordered_entry_hashes].reverse() };
  overwrite(manifestPath, reordered);
  assert.throws(() => derive(run), /core_hash|mutated/, "a reordered manifest no longer hashes to itself");
  rmSync(run.runRoot, { recursive: true, force: true });
});

test("SEL-DERIVE: a retained member the lifecycle never recorded is refused", () => {
  const run = freshCopy();
  // Strip the produced-role entries for the commitment from the lifecycle. The
  // artifact is still retained and self-consistent; what it lacks is any record
  // that this run ever produced it.
  const dir = path.join(run.runRoot, "events");
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const event = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & {
      produced?: { artifact_role: string }[];
    };
    if (event.produced?.some((p) => p.artifact_role === "selection-commitment") !== true) continue;
    // The event's own core_hash is recomputed, so the index accepts the edited
    // event and the lifecycle cross-check is what refuses — not the store's
    // freeze-integrity guard firing first.
    const edited: Record<string, unknown> = {
      ...event,
      produced: event.produced.filter((p) => p.artifact_role !== "selection-commitment"),
    };
    delete edited["core_hash"];
    overwrite(file, { ...edited, core_hash: coreHash(edited) });
  }
  assert.throws(
    () => derive(run),
    (error: { code?: string }) => error.code === "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT",
    "an unrecorded member is not selection evidence",
  );
  rmSync(run.runRoot, { recursive: true, force: true });
});

test("SEL-DERIVE: the pre-environment verifier still forbids selection artifacts", () => {
  const run = freshCopy();
  assert.throws(
    () => assertNoSelectionArtifacts(ArtifactIndex.scan(run.runRoot)),
    (error: { code?: string }) => error.code === "GRAPH_CLOSURE_EXTRA_ARTIFACT",
    "selection artifacts belong to the environment branch only",
  );

  // And a genuine pre-environment run passes the same gate.
  const preEnvironment = path.join(
    repoRoot,
    "fixtures",
    "golden",
    "valid-pre-environment-run",
    "artifacts",
  );
  assertNoSelectionArtifacts(ArtifactIndex.scan(preEnvironment));
  rmSync(run.runRoot, { recursive: true, force: true });
});

/*
 * A selection artifact cannot enter a pre-environment bundle — end to end.
 *
 * What this pins is the *refusal*, not one particular gate. Two layers cover it:
 * the closure's rejected-extra rule (which fires first, since no pre-environment
 * role can derive a selection member) and `assertNoSelectionArtifacts`. Removing
 * the latter leaves this green, so it is defense in depth rather than the
 * load-bearing check — stated here so a future reader does not mistake this case
 * for proof of that call site.
 *
 * The property still matters: until the selection signer rows were declared
 * (ADR-ERL2-020 §2), a stray selection member was refused as an undeclared
 * signed contract, and declaring the roles removed that particular refusal.
 */
test("SEL-DERIVE: a selection artifact planted in a pre-environment bundle is refused by the CLI", () => {
  const golden = path.join(repoRoot, "fixtures", "golden", "valid-pre-environment-run");
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-preenv-sel-"));
  cpSync(golden, dest, { recursive: true });

  const verify = (): { exitCode: number | null; code: string } => {
    const result = erl2([
      "verify",
      "--public-bundle", path.join(dest, "public-bundle.json"),
      "--root-config", path.join(dest, "root-config.json"),
      "--artifact-root", path.join(dest, "artifacts"),
      "--lifecycle", path.join(dest, "lifecycle.json"),
      "--offline",
    ]);
    return { exitCode: result.exitCode, code: result.body.errors[0]?.code ?? "-" };
  };
  assert.equal(verify().exitCode, 0, "the untouched golden bundle verifies");

  // Plant a real selection member, taken from a real selected run.
  const source = freshCopy();
  cpSync(
    path.join(source.runRoot, ...SELECTION_DIR, "commitment.json"),
    path.join(dest, "artifacts", "retained", "selection-commitment.json"),
  );
  const refused = verify();
  assert.notEqual(refused.exitCode, 0, "a pre-environment terminal may not retain a selection member");
  assert.equal(refused.code, "GRAPH_CLOSURE_EXTRA_ARTIFACT");

  rmSync(source.runRoot, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
});
