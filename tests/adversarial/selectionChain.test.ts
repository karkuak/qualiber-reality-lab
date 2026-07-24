/**
 * SELECTION-CHAIN-CLOSURE, POOL-METADATA-UNIFORMITY, BEACON-WRAPPER-OWNERSHIP,
 * RANDOMNESS-SOURCE-TRUST, ACYCLIC-SELECTION-TIME, SINGLE-RANDOMNESS-SOURCE,
 * RANDOMNESS-VARIANT-CLOSURE, THRESHOLD-VRF-ACTIVATION-GATE and
 * SELECTION-NON-COLLUSION.
 *
 * Each negative case names the exact invariant it violates and the refusal code
 * it must produce (implementation plan §19.3).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  assertActiveRandomnessReceiptVariant,
  assertActiveRandomnessVariant,
  assertDevelopmentTierOnly,
  assertDisjointRoles,
  DEVELOPMENT_BEACON_SOURCE_ID,
  deriveSelectedIndex,
  verifySelectionChain,
  type SelectionChainEvidence,
} from "@erl2/core";
import { buildSelectionFixture } from "../support/selectionFixture.js";

function evidenceOf(fixture: ReturnType<typeof buildSelectionFixture>): SelectionChainEvidence {
  const beaconRound = {
    sourceId: fixture.beacon.sourceId,
    roundId: fixture.result.randomnessReceipt.source_round_id,
    randomnessOutput: Buffer.from(fixture.result.randomnessReceipt.randomness_output_base64, "base64"),
    finalizedAt: fixture.result.randomnessReceipt.round_observed_at,
    previousRoundId: undefined,
  };
  return {
    request: fixture.request,
    roleAudit: fixture.roleAudit,
    policy: fixture.policy,
    poolManifest: fixture.pool.manifest,
    poolEntries: fixture.pool.entries.map((e) => e.entry),
    poolCheckpoint: fixture.result.poolCheckpoint,
    randomnessReceipt: fixture.result.randomnessReceipt,
    beaconSignatureProof: fixture.beacon.signatureProof(beaconRound),
    beaconInclusionProof: fixture.beacon.inclusionProof(beaconRound),
    sourceTrustReport: fixture.result.sourceTrustReport,
    commitment: fixture.result.commitment,
    commitmentCheckpoint: fixture.result.commitmentCheckpoint,
    thresholdRevealReceipt: fixture.result.thresholdRevealReceipt,
    binding: fixture.result.binding,
    bindingCheckpoint: fixture.result.bindingCheckpoint,
    proof: fixture.result.proof,
    receipt: fixture.result.receipt,
  };
}

test("SELECTION-CHAIN-CLOSURE: the complete chain verifies independently", () => {
  const fixture = buildSelectionFixture();
  const outcome = verifySelectionChain(evidenceOf(fixture), fixture.trust);
  assert.equal(outcome.selectedEntryHash, fixture.result.commitment.selected_entry_hash);
  assert.equal(outcome.derivedIndex, fixture.result.proof.derived_index);
});

test("SELECTION-RECEIPT-CHECKS §11.10: a receipt attesting a check as not-verified is refused", () => {
  const fixture = buildSelectionFixture();
  const evidence = evidenceOf(fixture);
  // The honest receipt verifies (its checks are all `true`).
  verifySelectionChain(evidence, fixture.trust);

  // A receipt whose `checks` boolean is negated (bypassing the schema's
  // `const: true`, as a hostile producer that skipped the JSON validator could)
  // must be refused: the verifier reads and enforces the booleans as defense in
  // depth, even though the independent re-derivation is the real authority.
  const tampered: SelectionChainEvidence = {
    ...evidence,
    receipt: {
      ...evidence.receipt,
      checks: { ...evidence.receipt.checks, selection_algorithm_verified: false as true },
    },
  };
  assert.throws(
    () => verifySelectionChain(tampered, fixture.trust),
    /selection_algorithm_verified is not attested verified|SELECTION_CHAIN_EDGE_UNCLOSED/,
  );
});

test("POOL-METADATA-UNIFORMITY: every selector-visible length matches the profile", () => {
  const fixture = buildSelectionFixture();
  const profile = fixture.pool.manifest.selector_visible_profile;
  for (const built of fixture.pool.entries) {
    assert.equal(built.entry.encrypted_binding_payload.byte_length, profile.payload_ciphertext_byte_length);
    assert.equal(built.entry.encrypted_binding_payload.path.length, profile.artifact_path_byte_length);
    assert.equal(built.entry.selector_visible_profile_hash, profile.core_hash);
  }
  assert.deepEqual(profile.challenge_correlated_cleartext_fields, []);
  assert.equal(profile.exposure_epoch_visibility, "encrypted_until_selected");
});

test("SELECTION-CHAIN-CLOSURE: a substituted pool root is rejected", () => {
  const fixture = buildSelectionFixture();
  const evidence = evidenceOf(fixture);
  const tampered: SelectionChainEvidence = {
    ...evidence,
    poolManifest: { ...evidence.poolManifest, pool_root_hash: evidence.request.core_hash },
  };
  assert.throws(() => verifySelectionChain(tampered, fixture.trust), /SELECTION_CHAIN_POOL_ROOT_MISMATCH|pool root/);
});

test("SELECTION-CHAIN-CLOSURE: reordered pool entries are rejected", () => {
  const fixture = buildSelectionFixture();
  const evidence = evidenceOf(fixture);
  const reordered = [...evidence.poolEntries].reverse();
  assert.throws(
    () => verifySelectionChain({ ...evidence, poolEntries: reordered }, fixture.trust),
    /ordered entry hashes|SELECTION_CHAIN_POOL_ROOT_MISMATCH/,
  );
});

test("BEACON-WRAPPER-OWNERSHIP: a wrapper claiming the beacon signed the ERL binding is rejected", () => {
  const fixture = buildSelectionFixture();
  const evidence = evidenceOf(fixture);
  const tampered: SelectionChainEvidence = {
    ...evidence,
    randomnessReceipt: {
      ...evidence.randomnessReceipt,
      beacon_signed_payload_hash: evidence.randomnessReceipt.source_request_binding_hash,
    },
  };
  assert.throws(
    () => verifySelectionChain(tampered, fixture.trust),
    (error: unknown) =>
      ["BEACON_WRAPPER_NATIVE_PROOF_INVALID", "BEACON_WRAPPER_SCOPE_CONFUSED", "BEACON_WRAPPER_BINDING_MISMATCH"].includes(
        (error as { code: string }).code,
      ),
  );
});

test("RANDOMNESS-SOURCE-TRUST: an unpinned source is rejected", () => {
  const fixture = buildSelectionFixture();
  const evidence = evidenceOf(fixture);
  const otherPolicy = { ...evidence.policy, source_id: "some-other-beacon" };
  assert.throws(
    () => verifySelectionChain({ ...evidence, policy: otherPolicy }, fixture.trust),
    (error: unknown) =>
      ["RANDOMNESS_SOURCE_MISMATCH", "RANDOMNESS_SOURCE_NOT_PINNED", "SELECTION_CHAIN_EDGE_UNCLOSED"].includes(
        (error as { code: string }).code,
      ),
  );
});

test("THRESHOLD-VRF-ACTIVATION-GATE: a threshold-VRF policy is non-admissible", () => {
  assert.throws(
    () =>
      assertActiveRandomnessVariant({
        schema_version: "threshold-vrf-randomness-policy/v1",
        source_kind: "threshold_vrf",
        activation_status: "disabled_pending_adr_erl2_011",
        admissible: false,
        emittable: false,
      }),
    (error: unknown) => (error as { code: string }).code === "THRESHOLD_VRF_NOT_ACTIVATED",
  );
});

test("RANDOMNESS-VARIANT-CLOSURE: a beacon receipt carrying threshold fields is rejected", () => {
  const fixture = buildSelectionFixture();
  assert.throws(
    () =>
      assertActiveRandomnessReceiptVariant({
        ...fixture.result.randomnessReceipt,
        transcript: "forbidden",
      }),
    (error: unknown) => (error as { code: string }).code === "RANDOMNESS_VARIANT_NOT_ADMISSIBLE",
  );
});

test("SINGLE-RANDOMNESS-SOURCE: the beacon refuses a second draw for the same pool", () => {
  const fixture = buildSelectionFixture();
  assert.throws(
    () => fixture.beacon.firstFinalizedRoundAfter("2026-07-01T00:05:00Z"),
    /second draw is forbidden/,
  );
});

test("SELECTION-NON-COLLUSION: overlapping role keys fail admission", () => {
  const fixture = buildSelectionFixture();
  const overlapping = {
    ...fixture.roleAudit,
    role_assignments: fixture.roleAudit.role_assignments.map((a) =>
      a.role === "evaluator" ? { ...a, key_ids: [fixture.keyring.selector.keyId] } : a,
    ),
  };
  assert.throws(() => assertDisjointRoles(overlapping), /NON_COLLUSION_KEY_OVERLAP|share key/);
});

test("ERL2-OQ-007 fail-closed: the development beacon may not drive a blind tier", () => {
  assert.throws(
    () => assertDevelopmentTierOnly("blind", DEVELOPMENT_BEACON_SOURCE_ID),
    /RANDOMNESS_SOURCE_NOT_PINNED|development beacon/,
  );
  assertDevelopmentTierOnly("development", DEVELOPMENT_BEACON_SOURCE_ID);
});

test("ERL2-OQ-007 wired: verifySelectionChain itself refuses a blind tier on the dev beacon (P2-7)", () => {
  const fixture = buildSelectionFixture();
  const evidence = evidenceOf(fixture);
  // Replay evidence that claims a blind tier while naming the development beacon
  // must be refused by the kernel, not only by the CLI admission layer.
  const blind = { ...evidence, request: { ...fixture.request, requested_tier: "blind" as const } };
  assert.equal(fixture.policy.source_id, DEVELOPMENT_BEACON_SOURCE_ID, "fixture uses the dev beacon");
  assert.throws(
    () => verifySelectionChain(blind, fixture.trust),
    /RANDOMNESS_SOURCE_NOT_PINNED|development beacon/,
    "the verifier kernel must enforce OQ-007 itself",
  );
});

test("INDEPENDENT-RANDOMNESS: index derivation is deterministic and in range", () => {
  const output = Buffer.alloc(64, 7);
  const nonce = "b".repeat(64);
  const root = `sha256:${"c".repeat(64)}` as const;
  const first = deriveSelectedIndex(output, nonce, root, 3);
  const second = deriveSelectedIndex(output, nonce, root, 3);
  assert.deepEqual(first, second);
  assert.ok(first.index >= 0 && first.index < 3);
});
