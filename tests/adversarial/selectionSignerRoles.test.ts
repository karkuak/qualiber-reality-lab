/**
 * The verifier-owned signer-role table for the V2 selection chain
 * (ADR-ERL2-020 §2, CONFLICT-ERL2-002).
 *
 * These rows are the offline authorization rule for every selection contract, so
 * a wrong one silently authorizes the wrong signer forever. They are exercised
 * here against a chain produced by the shipped `erl2 select`.
 *
 * The wrong-role cases are the point. Each re-seals a member with a **validly
 * signed** but wrongly-roled key: the signature verifies, the `core_hash` is
 * unchanged (signature fields are excluded from it by design), and the closure
 * is untouched. Only the role check can refuse — which is what makes it a test
 * of the table rather than of the signature layer.
 *
 * They therefore assert `TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE`, never
 * `TRUST_SIGNATURE_INVALID`: the latter would mean the signature itself failed,
 * which would prove nothing about the table.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  coreHash,
  developmentKey,
  sealSigned,
  TrustEvaluator,
  type LocalTrustConfiguration,
} from "@erl2/integrity";
import { DevelopmentBeaconSource } from "@erl2/core";
import { ArtifactIndex, verifySignedMembers } from "@erl2/public-verifier";
import type { TrustPolicyManifestV2 } from "@erl2/contracts";
import { erl2, runToAcquired } from "../support/cliRun.js";
import type { GovernorRegistry } from "../support/governorRegistry.js";

interface SelectedRun {
  readonly runRoot: string;
  readonly registry: GovernorRegistry;
}

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
  assert.equal(
    erl2(["select", ...base, "--source-trust-config", stc, "--expires", "2026-12-31T00:00:00Z"]).exitCode,
    0,
  );
  return { runRoot: run.runRoot, registry: run.registry };
}

let template: SelectedRun | undefined;
function freshCopy(): SelectedRun {
  template ??= selectedRun();
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-selroles-"));
  cpSync(template.runRoot, dest, { recursive: true });
  return { runRoot: dest, registry: template.registry };
}

function trustOf(run: SelectedRun): TrustEvaluator {
  const policy = JSON.parse(
    readFileSync(path.join(run.registry.root, "run-trust-policy.json"), "utf8"),
  ) as TrustPolicyManifestV2;
  const beacon = new DevelopmentBeaconSource({ seed: "pin", firstRoundAt: "2026-07-01T00:00:00Z" });
  const local: LocalTrustConfiguration = {
    rootKeyIds: [policy.root_key_id],
    currentTrustHeadHash: coreHash(policy as unknown as Record<string, unknown>),
    randomnessSources: [beacon.pinnedRegistryEntry(run.registry.sourceTrustPolicyHash)],
    randomnessRegistryHeadHash: run.registry.sourceTrustPolicyHash,
  };
  return new TrustEvaluator(policy, local);
}

function verifyMembers(run: SelectedRun): void {
  verifySignedMembers({
    index: ArtifactIndex.scan(run.runRoot),
    trust: trustOf(run),
    asOf: "2026-07-28T00:00:00Z",
  });
}

/** Re-seals a retained artifact with `key`, leaving its `core_hash` unchanged. */
function reSign(file: string, keyLabel: string): void {
  const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const original = value["core_hash"];
  const body = { ...value };
  delete body["core_hash"];
  delete body["signature"];
  const resealed = sealSigned(body as never, developmentKey(keyLabel)) as Record<string, unknown>;
  // The signature is excluded from `core_hash` by design, so re-signing must not
  // move the artifact's identity. If it did, the closure would refuse first and
  // this would stop being a role test.
  assert.equal(resealed["core_hash"], original, "re-signing must not change the core hash");
  chmodSync(file, 0o644);
  writeFileSync(file, JSON.stringify(resealed));
}

const SEL = (run: SelectedRun, name: string): string =>
  path.join(run.runRoot, "retained", "selection", name);

test("SEL-ROLES: every signed selection member verifies under its declared role", () => {
  const run = freshCopy();
  verifyMembers(run);
  rmSync(run.runRoot, { recursive: true, force: true });
});

/*
 * ADR-ERL2-020 §2a — the two policy rows.
 *
 * A first draft assigned both to `challenge_governor`. Encoding that would have
 * let the challenge governor author the policies governing its own selection.
 * These two cases are what stop that regression coming back.
 */
test("SEL-ROLES: a governor-signed randomness policy is refused", () => {
  const run = freshCopy();
  reSign(path.join(run.runRoot, "retained", "selection-randomness-policy.json"), "challenge-governor");
  assert.throws(
    () => verifyMembers(run),
    (error: { code?: string }) => error.code === "TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE",
    "the randomness policy is policy_author's, not the governor's",
  );
  rmSync(run.runRoot, { recursive: true, force: true });
});

test("SEL-ROLES: a governor-signed journey selection policy is refused", () => {
  const run = freshCopy();
  reSign(path.join(run.runRoot, "retained", "journey-selection-policy.json"), "challenge-governor");
  assert.throws(
    () => verifyMembers(run),
    (error: { code?: string }) => error.code === "TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE",
    "the journey selection policy is policy_author's, not the governor's",
  );
  rmSync(run.runRoot, { recursive: true, force: true });
});

/*
 * ADR-ERL2-020 §3 — the receipt is the auditor's, never the evaluator's.
 *
 * The development fixture originally signed it with the evaluator key, which
 * would have made the evaluation authority the attestor that the selection it
 * will be judged against was correctly verified.
 */
test("SEL-ROLES: an evaluator-signed verification receipt is refused", () => {
  const run = freshCopy();
  reSign(SEL(run, "selection-verification-receipt.json"), "evaluator");
  assert.throws(
    () => verifyMembers(run),
    (error: { code?: string }) => error.code === "TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE",
    "the receipt is confidential_selection_auditor's",
  );
  rmSync(run.runRoot, { recursive: true, force: true });
});

test("SEL-ROLES: every other selection member is refused under a wrong role", () => {
  // Each pair is (member, a key that is validly pinned but holds a different
  // role). The signature verifies in every case; only the role table refuses.
  const cases: readonly (readonly [string, string])[] = [
    ["selection-request.json", "policy-author"],
    ["role-separation-audit.json", "selector"],
    ["eligibility-pool-manifest.json", "policy-author"],
    ["commitment.json", "challenge-governor"],
    ["selection-proof.json", "reveal-authority"],
    ["selected-binding.json", "selector"],
    ["source-trust-report.json", "policy-author"],
  ];
  for (const [name, wrongKey] of cases) {
    const run = freshCopy();
    reSign(SEL(run, name), wrongKey);
    assert.throws(
      () => verifyMembers(run),
      (error: { code?: string }) => error.code === "TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE",
      `${name} signed by ${wrongKey} must be refused`,
    );
    rmSync(run.runRoot, { recursive: true, force: true });
  }
});

test("SEL-ROLES: an undeclared signed selection contract is still refused", () => {
  // The table is an allowlist, not a category. A signed contract nobody declared
  // a role for stays refused even though the selection branch is now live.
  const run = freshCopy();
  const body = {
    schema_version: "threshold-vrf-randomness-policy/v1",
    policy_id: "rogue-threshold-policy",
  };
  const rogue = sealSigned(body as never, developmentKey("selector")) as Record<string, unknown>;
  writeFileSync(SEL(run, "rogue-threshold-policy.json"), JSON.stringify(rogue));
  assert.throws(
    () => verifyMembers(run),
    (error: { code?: string }) => error.code === "TRUST_SIGNATURE_INVALID",
    "a contract with no declared signer role must be refused outright",
  );
  rmSync(run.runRoot, { recursive: true, force: true });
});
