/**
 * The §15.4 offline mutation battery for the V2 selection chain.
 *
 * Two layers refuse a tampered selection, and this suite separates them on
 * purpose, because a first draft did not and was much weaker than it looked.
 *
 * **The derivation layer.** Any on-disk mutation must be re-signed to survive
 * the signature check, and re-signing moves the artifact's `core_hash` — which
 * then no longer matches what the run's lifecycle recorded producing. So a
 * tampered artifact is refused before `verifySelectionChain` ever sees it. Real
 * and desirable, and `MUT-SEL-DISK` pins it.
 *
 * **The chain layer.** It is also not what §15.4 asks about. To exercise the
 * chain rules themselves, the mutation must be applied to evidence that has
 * already passed derivation, so `MUT-SEL-CHAIN` derives a clean chain and
 * mutates the in-memory evidence. Each of those asserts a *chain* refusal
 * specifically — a helper that accepted any error code was what hid this the
 * first time round.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  coreHash,
  developmentKey,
  sealSigned,
  SIGNATURE_DOMAINS,
  TrustEvaluator,
  type LocalTrustConfiguration,
} from "@erl2/integrity";
import { DevelopmentBeaconSource, verifySelectionChain } from "@erl2/core";
import {
  ArtifactIndex,
  deriveSelectionEvidence,
  type DerivedSelectionEvidence,
} from "@erl2/public-verifier";
import type { LabLifecycleEventV1, TrustPolicyManifestV2 } from "@erl2/contracts";
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
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-selmut-"));
  cpSync(template.runRoot, dest, { recursive: true });
  return { runRoot: dest, registry: template.registry };
}

const SEL = (run: SelectedRun, name: string): string =>
  path.join(run.runRoot, "retained", "selection", name);

function lifecycleOf(run: SelectedRun): readonly LabLifecycleEventV1[] {
  const dir = path.join(run.runRoot, "events");
  return readdirSync(dir)
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as LabLifecycleEventV1);
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

function derive(run: SelectedRun): DerivedSelectionEvidence {
  return deriveSelectionEvidence(ArtifactIndex.scan(run.runRoot), lifecycleOf(run));
}

/** One clean run, derived once; chain cases mutate deep copies of its evidence. */
let cleanRun: SelectedRun | undefined;
function cleanEvidence(): { evidence: DerivedSelectionEvidence; trust: TrustEvaluator } {
  cleanRun ??= freshCopy();
  return {
    evidence: JSON.parse(JSON.stringify(derive(cleanRun))) as DerivedSelectionEvidence,
    trust: trustOf(cleanRun),
  };
}

/** Codes that mean the *chain* refused, as opposed to derivation or raw bytes. */
const CHAIN_CODES =
  /^(SELECTION_|RANDOMNESS_|BEACON_WRAPPER_|THRESHOLD_VRF_|NON_COLLUSION_|POOL_METADATA_|BLIND_|TRUST_|TIMESTAMP_)/;

/** Applies a mutation to derived evidence and requires a chain-level refusal. */
function chainRefuses(why: string, mutateEvidence: (evidence: Record<string, unknown>) => void): void {
  const { evidence, trust } = cleanEvidence();
  mutateEvidence(evidence as unknown as Record<string, unknown>);
  let code = "(no refusal)";
  assert.throws(
    () => verifySelectionChain(evidence, trust),
    (error: { code?: string }) => {
      code = error.code ?? "(untyped)";
      return CHAIN_CODES.test(code);
    },
    `${why} — got ${code}`,
  );
}

test("MUT-SEL-BASELINE: the unmutated chain verifies offline", () => {
  const { evidence, trust } = cleanEvidence();
  const outcome = verifySelectionChain(evidence, trust);
  assert.equal(outcome.selectedEntryHash, evidence.commitment.selected_entry_hash);
});

// ---------------------------------------------------------------------------
// The derivation layer: on-disk tampering never reaches the chain.
// ---------------------------------------------------------------------------

test("MUT-SEL-DISK: a re-signed selection artifact no longer matches the lifecycle record", () => {
  const cases: readonly (readonly [string, string, (v: Record<string, unknown>) => void])[] = [
    ["eligibility-pool-manifest.json", "challenge-governor", (v) => {
      v["ordered_entry_hashes"] = [...(v["ordered_entry_hashes"] as string[])].reverse();
    }],
    ["eligibility-pool-manifest.json", "challenge-governor", (v) => {
      v["pool_root_hash"] = `sha256:${"7".repeat(64)}`;
    }],
    ["selection-proof.json", "selector", (v) => {
      v["derived_index"] = ((v["derived_index"] as number) + 1) % 3;
    }],
    ["selection-request.json", "challenge-governor", (v) => {
      v["requested_tier"] = "blind";
    }],
  ];
  for (const [name, key, edit] of cases) {
    const run = freshCopy();
    const file = SEL(run, name);
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete value["core_hash"];
    delete value["signature"];
    edit(value);
    chmodSync(file, 0o644);
    writeFileSync(file, JSON.stringify(sealSigned(value as never, developmentKey(key))));
    assert.throws(
      () => derive(run),
      (error: { code?: string }) => error.code === "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT",
      `${name} re-signed after tampering must be refused by the derivation`,
    );
    rmSync(run.runRoot, { recursive: true, force: true });
  }
});

test("MUT-SEL-DISK: a forged beacon native proof is refused", () => {
  // The proof is a PUBLIC wire blob with no core_hash, so the derivation cannot
  // cross-check it against the lifecycle — the chain's beacon verification is
  // what refuses.
  const run = freshCopy();
  const dir = path.join(run.runRoot, "commitments", "randomness");
  const proofFile = readdirSync(dir).find((n) => n.endsWith(".signature-proof.json"));
  assert.ok(proofFile, "the run froze a beacon signature proof");
  const target = path.join(dir, proofFile);
  const proof = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
  const signature = proof["signature"] as Record<string, string>;
  const base64 = signature["signature_base64"] as string;
  signature["signature_base64"] = (base64[0] === "A" ? "B" : "A") + base64.slice(1);
  chmodSync(target, 0o644);
  writeFileSync(target, JSON.stringify(proof));
  assert.throws(
    () => verifySelectionChain(derive(run), trustOf(run)),
    (error: { code?: string }) => error.code === "BEACON_WRAPPER_NATIVE_PROOF_INVALID",
  );
  rmSync(run.runRoot, { recursive: true, force: true });
});

test("MUT-SEL-DISK: a forged association wrapper signature is refused", () => {
  const run = freshCopy();
  const file = SEL(run, "randomness-receipt.json");
  const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const wrapper = value["wrapper_signature"] as Record<string, string>;
  const base64 = wrapper["signature_base64"] as string;
  wrapper["signature_base64"] = (base64[0] === "A" ? "B" : "A") + base64.slice(1);
  chmodSync(file, 0o644);
  writeFileSync(file, JSON.stringify(value));
  assert.throws(
    () => verifySelectionChain(derive(run), trustOf(run)),
    (error: { code?: string }) => error.code === "BEACON_WRAPPER_SIGNATURE_INVALID",
  );
  rmSync(run.runRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The chain layer: §15.4's rules, on evidence that has passed derivation.
// ---------------------------------------------------------------------------

test("MUT-SEL-CHAIN: a reordered eligibility pool is refused", () => {
  chainRefuses("a reordered pool must not verify", (e) => {
    (e["poolEntries"] as unknown[]).reverse();
  });
});

test("MUT-SEL-CHAIN: a substituted pool root is refused", () => {
  chainRefuses("a substituted pool root must not verify", (e) => {
    (e["poolManifest"] as Record<string, unknown>)["pool_root_hash"] = `sha256:${"7".repeat(64)}`;
  });
});

test("MUT-SEL-CHAIN: an extra pool entry is refused", () => {
  chainRefuses("an entry outside the ordered pool must not verify", (e) => {
    const entries = e["poolEntries"] as unknown[];
    entries.push(JSON.parse(JSON.stringify(entries[0])));
  });
});

test("MUT-SEL-CHAIN: a wrong beacon round is refused", () => {
  chainRefuses("a receipt naming a different round must not verify", (e) => {
    (e["randomnessReceipt"] as Record<string, unknown>)["source_round_id"] = "999999";
  });
});

test("MUT-SEL-CHAIN: a wrong source/request binding is refused", () => {
  chainRefuses("a receipt bound to a different request must not verify", (e) => {
    (e["randomnessReceipt"] as Record<string, unknown>)["source_request_binding_hash"] =
      `sha256:${"3".repeat(64)}`;
  });
});

test("MUT-SEL-CHAIN: a wrong derived index is refused", () => {
  chainRefuses("a proof claiming a different index must not verify", (e) => {
    const proof = e["proof"] as Record<string, number>;
    proof["derived_index"] = ((proof["derived_index"] ?? 0) + 1) % 3;
  });
});

test("MUT-SEL-CHAIN: a rejection-count mismatch is refused", () => {
  chainRefuses("a proof claiming a different rejection count must not verify", (e) => {
    const proof = e["proof"] as Record<string, number>;
    proof["rejection_count"] = (proof["rejection_count"] ?? 0) + 7;
  });
});

test("MUT-SEL-CHAIN: a reveal released before the commitment checkpoint is refused", () => {
  chainRefuses("a premature reveal must not verify", (e) => {
    (e["thresholdRevealReceipt"] as Record<string, unknown>)["released_at"] = "2026-01-01T00:00:00Z";
  });
});

test("MUT-SEL-CHAIN: a checkpoint anchoring the wrong target is refused", () => {
  chainRefuses("a swapped checkpoint must not verify", (e) => {
    const pool = e["poolCheckpoint"];
    e["poolCheckpoint"] = e["commitmentCheckpoint"];
    e["commitmentCheckpoint"] = pool;
  });
});

test("MUT-SEL-CHAIN: a checkpoint-order violation is refused", () => {
  chainRefuses("an out-of-order checkpoint must not verify", (e) => {
    (e["bindingCheckpoint"] as Record<string, unknown>)["checkpointed_at"] = "2026-01-01T00:00:00Z";
  });
});

test("MUT-SEL-CHAIN: a substituted selected binding is refused", () => {
  chainRefuses("a binding naming a different entry must not verify", (e) => {
    const entries = e["poolEntries"] as Record<string, unknown>[];
    const binding = e["binding"] as Record<string, unknown>;
    const other = entries.find((entry) => coreHash(entry) !== binding["pool_entry_hash"]);
    assert.ok(other, "the pool holds more than one entry");
    binding["pool_entry_hash"] = coreHash(other);
  });
});

test("MUT-SEL-CHAIN: a missing selection member is refused", () => {
  chainRefuses("a chain missing its proof must not verify", (e) => {
    delete e["proof"];
  });
});

/*
 * ERL2-OQ-007, through the verifier kernel.
 *
 * `assertDevelopmentTierOnly` lives inside both kernels, but until now only a
 * direct unit call exercised it — ADR-ERL2-020's evidence list records that gap.
 * These drive a relabelled tier through `verifySelectionChain` itself.
 */
for (const tier of ["held_out", "blind"] as const) {
  test(`MUT-SEL-CHAIN: a development selection relabelled ${tier} is refused by the kernel`, () => {
    chainRefuses(`a ${tier} tier against the development beacon must not verify`, (e) => {
      (e["request"] as Record<string, unknown>)["requested_tier"] = tier;
    });
  });
}

test("MUT-SEL-CHAIN: a threshold-VRF randomness policy is refused", () => {
  chainRefuses("threshold VRF is never activated", (e) => {
    (e["policy"] as Record<string, unknown>)["source_kind"] = "threshold_vrf";
  });
});

test("MUT-SEL-CHAIN: a revoked signer is refused", () => {
  // Nothing in the run changes; the verifier's own pinned policy revokes the
  // selector, and the chain must refuse on that alone. The policy is root-signed,
  // so it is re-sealed by the root key rather than edited in place — editing
  // would break its own signature and test the wrong thing.
  cleanRun ??= freshCopy();
  const run = cleanRun;
  const policy = JSON.parse(
    readFileSync(path.join(run.registry.root, "run-trust-policy.json"), "utf8"),
  ) as Record<string, unknown>;
  delete policy["core_hash"];
  delete policy["root_signature"];
  // The entry must match the frozen revocation shape. A first draft used
  // `revoked_at`/`reason`, which `TrustEvaluator.evaluate` silently ignored —
  // its switch is on `scope`, so a malformed entry revokes nothing.
  policy["revocations"] = [
    {
      revocation_id: "audit-revocation-1",
      key_id: "erl2-dev-selector-ed25519-1",
      scope: "all_historical",
      announced_at: "2026-07-01T00:00:00Z",
      reason_code: "key_compromise",
    },
  ];
  const resealed = sealSigned(
    policy as never,
    developmentKey("root"),
    SIGNATURE_DOMAINS.LEGACY_V1 as never,
    "root_signature" as never,
  ) as unknown as TrustPolicyManifestV2 & { root_key_id: string };
  const beacon = new DevelopmentBeaconSource({ seed: "pin", firstRoundAt: "2026-07-01T00:00:00Z" });
  const trust = new TrustEvaluator(resealed, {
    rootKeyIds: [resealed.root_key_id],
    currentTrustHeadHash: coreHash(resealed as unknown as Record<string, unknown>),
    randomnessSources: [beacon.pinnedRegistryEntry(run.registry.sourceTrustPolicyHash)],
    randomnessRegistryHeadHash: run.registry.sourceTrustPolicyHash,
  });
  let code = "(no refusal)";
  assert.throws(
    () => verifySelectionChain(derive(run), trust),
    (error: { code?: string }) => {
      code = error.code ?? "(untyped)";
      return CHAIN_CODES.test(code);
    },
    `a revoked selector must not verify — got ${code}`,
  );
});
