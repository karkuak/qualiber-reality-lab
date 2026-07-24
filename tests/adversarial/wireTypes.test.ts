/**
 * §11.13 — handwritten wire types no longer drift.
 *
 * Two families were validated by hand:
 *   - the threshold X25519 envelope, a *raw AEAD/crypto* container, is validated
 *     by a single explicit-format parser that fails closed on any malformation;
 *   - the beacon-native proofs, *persisted PUBLIC wire artifacts*, are now closed,
 *     schema-governed contracts whose generated types are the single source.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseEnvelope, sealThresholdEnvelope, developmentCustodian } from "@erl2/integrity";
import { validateContract, assertContract, type Hash } from "@erl2/contracts";
import { hardSafetyViolations } from "@erl2/core";

function goodEnvelopeBytes(): Buffer {
  const custodians = [developmentCustodian("a"), developmentCustodian("b"), developmentCustodian("c")];
  const envelope = sealThresholdEnvelope({
    plaintext: Buffer.from("secret payload"),
    paddedSize: 128,
    threshold: 2,
    custodians: custodians.map((c) => ({ keyId: c.keyId, publicKey: c.publicKey })),
    associatedHandle: "entry-handle-1",
  });
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

test("§11.13 ENVELOPE: a well-formed envelope round-trips through the explicit-format parser", () => {
  const parsed = parseEnvelope(goodEnvelopeBytes());
  assert.equal(parsed.envelope_version, "threshold-x25519-envelope/v1");
  assert.equal(parsed.aead, "chacha20-poly1305");
  assert.ok(parsed.wrapped_shares.length >= 2);
});

test("§11.13 ENVELOPE: every malformation of the raw crypto container fails closed", () => {
  const base = JSON.parse(goodEnvelopeBytes().toString("utf8")) as Record<string, unknown>;
  const mutate = (fn: (v: Record<string, unknown>) => void): Buffer => {
    const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    fn(copy);
    return Buffer.from(JSON.stringify(copy), "utf8");
  };

  const cases: ((v: Record<string, unknown>) => void)[] = [
    (v) => (v["envelope_version"] = "other/v1"),
    (v) => (v["aead"] = "aes-gcm"),
    (v) => (v["padding"] = "pkcs7"),
    (v) => (v["threshold"] = 1),
    (v) => (v["threshold"] = "2"),
    (v) => (v["nonce_base64"] = "not base64!!"),
    (v) => (v["ciphertext_base64"] = 42),
    (v) => (v["padded_plaintext_byte_length"] = -1),
    (v) => ((v as { extra?: number })["extra"] = 1), // unknown top-level field
    (v) => ((v["wrapped_shares"] as unknown[]).push({ bogus: true })),
    (v) => (((v["wrapped_shares"] as Record<string, unknown>[])[0] as Record<string, unknown>)["share_index"] = 0),
    (v) => (((v["wrapped_shares"] as Record<string, unknown>[])[0] as Record<string, unknown>)["evil"] = 1),
    (v) => (v["wrapped_shares"] = []), // fewer shares than threshold
  ];
  for (const [i, fn] of cases.entries()) {
    assert.throws(() => parseEnvelope(mutate(fn)), /malformed threshold envelope/, `case ${i}`);
  }
  assert.throws(() => parseEnvelope(Buffer.from("{not json", "utf8")), /malformed threshold envelope/);
});

const GOOD_SIGNATURE_PROOF = {
  proof_kind: "beacon_native_signature",
  scope: "canonical_beacon_round_and_output_only",
  native_signature_domain: "DEV-BEACON-ROUND-V1",
  source_id: "erl2-development-beacon",
  round_id: "dev-round-00000001",
  randomness_output_base64: Buffer.alloc(64, 7).toString("base64"),
  beacon_signed_payload_hash: `sha256:${"a".repeat(64)}`,
  signature: {
    algorithm: "Ed25519",
    key_id: "erl2-dev-beacon-ed25519-1",
    signed_hash: `sha256:${"a".repeat(64)}`,
    signature_base64: `${"A".repeat(86)}==`,
  },
};

const GOOD_INCLUSION_PROOF = {
  proof_kind: "beacon_native_inclusion",
  source_id: "erl2-development-beacon",
  round_id: "dev-round-00000001",
  chain_hash: `sha256:${"b".repeat(64)}`,
};

test("§11.13 BEACON-PROOF: the closed schemas accept the honest proofs and reject drift", () => {
  assertContract("BeaconSignatureProofV1", GOOD_SIGNATURE_PROOF);
  assertContract("BeaconInclusionProofV1", GOOD_INCLUSION_PROOF);
  assertContract("BeaconInclusionProofV1", { ...GOOD_INCLUSION_PROOF, previous_round_id: "dev-round-00000000" });

  // Unknown field, wrong const, and missing required field are all refused.
  assert.equal(validateContract("BeaconSignatureProofV1", { ...GOOD_SIGNATURE_PROOF, extra: 1 }).valid, false);
  assert.equal(
    validateContract("BeaconSignatureProofV1", { ...GOOD_SIGNATURE_PROOF, proof_kind: "beacon_native_inclusion" }).valid,
    false,
  );
  const { chain_hash: _drop, ...missing } = GOOD_INCLUSION_PROOF;
  assert.equal(validateContract("BeaconInclusionProofV1", missing).valid, false);
  // A signature proof carrying an ERL identifier-shaped extra field cannot smuggle
  // through — additionalProperties is false.
  assert.equal(
    validateContract("BeaconSignatureProofV1", { ...GOOD_SIGNATURE_PROOF, source_request_binding_hash: `sha256:${"c".repeat(64)}` }).valid,
    false,
  );
});

test("§11.14 SET-ARRAYS: a substrate lock with a duplicate config hash is refused (uniqueItems)", () => {
  const h = (n: number): Hash => `sha256:${String(n).repeat(64).slice(0, 64)}` as Hash;
  const base = {
    schema_version: "substrate-lock/v1",
    lock_id: "dup-config-lock",
    substrate_id: "s",
    qualification_status: "unqualified_pending_erl2_oq_005",
    unqualified_reason_code: "ERL2-OQ-005",
    source_archive: { release_tag: "v1", source_commit: "0".repeat(40), archive_sha256: h(7) },
    images: [],
    sbom: { path: "retained/s.json", media_type: "application/json", byte_length: 1, file_sha256: h(6), classification: "PUBLIC" },
    provenance: { producer: "t", producer_version: "0", transformations: [] },
    recorded_at: "2026-07-23T00:00:00Z",
  };
  // Two identical config hashes: a set array must reject the duplicate.
  const withDup = { ...base, config_hashes: [h(5), h(5)] };
  assert.equal(validateContract("SubstrateLockV1", withDup).valid, false);
  const noDup = { ...base, config_hashes: [h(5), h(4)] };
  const problems = validateContract("SubstrateLockV1", noDup).problems;
  // (No uniqueItems failure among the problems for the distinct set.)
  assert.ok(!problems.some((p) => p.keyword === "uniqueItems"));
});

test("§11.14 HARD-SAFETY: the gate primitive flags measured, threshold-failing hard-safety metrics", () => {
  // hardSafetyViolations is the primitive the 6.5 domain-evaluation → validity
  // claim-scope gate consumes when metrics are actually measured. Pin its
  // behaviour: only measured + threshold-unsatisfied hard-safety results count.
  const mk = (over: Record<string, unknown>) =>
    ({
      threshold_class: "hard_safety",
      status: "measured",
      threshold_satisfied: false,
      ...over,
    }) as never;
  const results = [
    mk({ metric_id: "authority-scope" }), // violation
    mk({ metric_id: "credential-safety", threshold_satisfied: true }), // satisfied → not a violation
    mk({ metric_id: "evidence-precision", threshold_class: "ordinary_gate" }), // not hard-safety
    mk({ metric_id: "degradation-honesty", status: "inconclusive" }), // not measured
  ];
  const violations = hardSafetyViolations(results);
  assert.equal(violations.length, 1);
  assert.equal((violations[0] as { metric_id: string }).metric_id, "authority-scope");
});
