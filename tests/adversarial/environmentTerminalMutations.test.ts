/**
 * The three §15.4 mutations that could not be exercised until an environment
 * terminal existed: **wrong package binding**, **wrong source**, and an
 * **environment bundle that omits selection verification**.
 *
 * All three are applied to inputs a caller actually supplies — the public bundle
 * document and the verifier's own locally pinned trust configuration — rather
 * than to the retained tree. That is deliberate. A mutation inside `retained/`
 * moves the artifact's core hash and is refused by the derivation layer before
 * the rule under test is ever reached, which makes the case pass for the wrong
 * reason. `erl2 verify --public-bundle PATH --root-config PATH` is the seam an
 * external reader controls, and these are the mutations available there.
 *
 * Each case asserts a specific Appendix B code.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coreHash, developmentKey, publicKeyToPem } from "@erl2/integrity";
import { DevelopmentBeaconSource } from "@erl2/core";
import { erl2, runToEnvironmentTerminal, writeLifecycle, writeTrustConfig } from "../support/cliRun.js";
import { developmentKeyring } from "../support/keys.js";
import type { GovernorRegistry } from "../support/governorRegistry.js";

interface FinalizedRun {
  readonly runRoot: string;
  readonly runId: string;
  readonly registry: GovernorRegistry;
}

/**
 * A complete environment run, driven to `generic_finalized` through the CLI.
 *
 * The plan itself lives in `cliRun.ts` (`runToEnvironmentTerminal`) because three
 * suites now need the same terminal and a copy per suite is a copy that can
 * drift.
 */
function finalizedEnvironmentRun(): FinalizedRun {
  const run = runToEnvironmentTerminal();
  return { runRoot: run.runRoot, runId: run.runId, registry: run.registry };
}

function bundleOf(run: FinalizedRun): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", "public-bundle.json"), "utf8"),
  ) as Record<string, unknown>;
}

/**
 * Verifies a caller-supplied bundle document against a caller-supplied trust
 * config.
 *
 * The document is written **outside** the run root. A caller-supplied bundle is
 * not part of the artifact tree, and leaving it inside made the artifact index
 * find two `public-verification-bundle/v2` artifacts — so every case refused for
 * that reason instead of for the mutation under test.
 */
function verifyWith(run: FinalizedRun, bundle: unknown, rootConfig: string): ReturnType<typeof erl2> {
  const bundlePath = path.join(mkdtempSync(path.join(tmpdir(), "erl2-mut-bundle-")), "bundle.json");
  writeFileSync(bundlePath, JSON.stringify(bundle));
  return erl2([
    "verify",
    "--public-bundle", bundlePath,
    "--root-config", rootConfig,
    "--artifact-root", run.runRoot,
    "--lifecycle", writeLifecycle(run.runRoot),
    "--offline",
  ]);
}

/** The core hash a mutated bundle would carry if its producer had built it. */
function recomputedCoreHash(bundle: Record<string, unknown>): string {
  const body: Record<string, unknown> = { ...bundle };
  delete body["core_hash"];
  return coreHash(body);
}

function pinnedConfig(run: FinalizedRun): string {
  return writeTrustConfig(run.runRoot, "trust-config.json", {
    sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
  });
}

test("MUT-ENV-BASELINE: the unmutated environment bundle verifies offline", () => {
  const run = finalizedEnvironmentRun();
  const verified = verifyWith(run, bundleOf(run), pinnedConfig(run));
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  assert.equal((verified.body.data as { verdict: string }).verdict, "valid");
});

test("MUT-ENV: a bundle that omits selection verification is refused", () => {
  const run = finalizedEnvironmentRun();
  const bundle = bundleOf(run);
  // The member that makes an environment bundle checkable at all: without it an
  // offline reader cannot confirm the challenge this run answered is the one the
  // protocol drew. The environment variant makes it mandatory for that reason.
  delete bundle["selection_verification_receipt"];
  // The mutated bundle is given a *consistent* identity. Without this the
  // refusal is `ARTIFACT_HASH_MISMATCH` — correct, but it is the identity layer
  // answering, and the case would pass without the member rule existing at all.
  bundle["core_hash"] = recomputedCoreHash(bundle);

  const refused = verifyWith(run, bundle, pinnedConfig(run));
  assert.notEqual(refused.exitCode, 0);
  assert.equal(refused.body.errors[0]?.code, "SCHEMA_VALIDATION_FAILED");
  assert.match(refused.body.errors[0]?.message ?? "", /selection_verification_receipt/);
});

test("MUT-ENV: a bundle whose selection receipt names other bytes is refused", () => {
  const run = finalizedEnvironmentRun();
  const bundle = bundleOf(run);
  const member = bundle["selection_verification_receipt"] as { artifact_core_hash: string };
  // Present but pointing elsewhere: absence and substitution must both fail, and
  // a verifier that only checked presence would pass this.
  bundle["selection_verification_receipt"] = {
    ...(bundle["selection_verification_receipt"] as object),
    artifact_core_hash: `sha256:${"e".repeat(64)}`,
  };
  assert.notEqual(member.artifact_core_hash, `sha256:${"e".repeat(64)}`);
  const refused = verifyWith(run, bundle, pinnedConfig(run));
  assert.notEqual(refused.exitCode, 0);
  // The attestation binds the receipt it attests, so a bundle that presents a
  // different one is caught by the binding rather than by the member's presence.
  assert.equal(refused.body.errors[0]?.code, "BUNDLE_MEMBER_MISMATCH");
});

test("MUT-ENV: a wrong package binding — an attestation from another run — is refused", () => {
  const run = finalizedEnvironmentRun();
  const other = finalizedEnvironmentRun();
  const bundle = bundleOf(run);
  // The other run acquired and verified its own package, so its attestation binds
  // a different `subject_package_manifest_hash`. Presenting it as this run's
  // attestation is the wrong-package-binding mutation in its most direct form.
  bundle["final_attestation"] = (bundleOf(other) as { final_attestation: unknown }).final_attestation;
  // Given a consistent identity, so the refusal comes from the *binding* rather
  // than from the bundle's own hash. Without this the case would pass with no
  // binding rule in place at all.
  bundle["core_hash"] = recomputedCoreHash(bundle);

  const refused = verifyWith(run, bundle, pinnedConfig(run));
  assert.notEqual(refused.exitCode, 0);
  // The attestation the bundle names is not in this run's retained tree: the
  // closure resolves every member against the artifact root, so an attestation
  // that binds another run's package cannot be presented as this one's.
  // The attestation the bundle names is not in this run's retained tree at all:
  // the closure resolves every member against the artifact root, so an
  // attestation binding another run's package manifest is unreachable here.
  assert.equal(refused.body.errors[0]?.code, "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT");
});

test("MUT-ENV: a wrong source — the right source id pinned to the wrong keys — is refused", () => {
  const run = finalizedEnvironmentRun();
  // The registry entry keeps the policy's `source_id` and trust-policy hash and
  // changes only the beacon's key material — which is what a substituted
  // randomness source actually looks like: the same name, different keys. The
  // pinned entry is looked up by source id and then the *round proof's own key*
  // must be one it lists, so the name matching is not enough.
  const impostor = new DevelopmentBeaconSource({
    seed: "impostor",
    firstRoundAt: "2026-07-01T00:00:00Z",
    signingKey: developmentKey("not-the-beacon"),
  }).pinnedRegistryEntry(run.registry.sourceTrustPolicyHash);
  const policy = JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", "trust-policy.json"), "utf8"),
  ) as object;
  const configPath = path.join(run.runRoot, "wrong-source-config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      rootKeyIds: [developmentKeyring().root.keyId],
      currentTrustHeadHash: coreHash(policy),
      randomnessSources: [impostor],
      randomnessRegistryHeadHash: run.registry.sourceTrustPolicyHash,
    }),
  );
  // Sanity: the impostor really is a different key, so the case cannot pass by
  // accidentally pinning the genuine beacon.
  const genuine = new DevelopmentBeaconSource({ seed: "x", firstRoundAt: "2026-07-01T00:00:00Z" })
    .pinnedRegistryEntry(run.registry.sourceTrustPolicyHash);
  assert.notDeepEqual(impostor.beaconKeyIds, genuine.beaconKeyIds);
  assert.notEqual(
    publicKeyToPem(developmentKey("not-the-beacon").publicKey),
    publicKeyToPem(developmentKey("beacon").publicKey),
  );

  const refused = verifyWith(run, bundleOf(run), configPath);
  assert.notEqual(refused.exitCode, 0);
  assert.equal(refused.body.errors[0]?.code, "RANDOMNESS_SOURCE_NOT_PINNED");
  assert.match(refused.body.errors[0]?.message ?? "", /beacon key .* is not locally pinned/);
});
