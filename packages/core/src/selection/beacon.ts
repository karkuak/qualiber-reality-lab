/**
 * External-beacon randomness: native proof verification and the separately
 * signed Lab/verifier association wrapper (design v2 §15, ERL2-FR-032/037/038).
 *
 * Two signing scopes exist and must never be conflated:
 *
 *   - the **beacon-native proof** authenticates only the beacon's canonical
 *     round and output, under the beacon's own signing domain and its keys as
 *     pinned by the verifier;
 *   - the **ERL association wrapper** is produced and signed by the Lab or
 *     verifier under `ERL2-BEACON-ASSOCIATION-V1`, and binds that authenticated
 *     round to the ERL request, policy, source, pool root and pool checkpoint.
 *
 * The beacon never receives or signs `source_request_binding_hash`.  Reporting
 * otherwise is a verification failure, not a warning.
 */

import { verify as ed25519Verify } from "node:crypto";
import {
  assertContract,
  CODES,
  Erl2Error,
  parseStrictJson,
  type BeaconInclusionProofV1,
  type BeaconSignatureProofV1,
  type ExternalBeaconRandomnessPolicyV1,
  type ExternalBeaconRandomnessReceiptV1,
  type Hash,
  type Signature,
} from "@erl2/contracts";
import {
  domainHash,
  hashBytes,
  HASH_DOMAINS,
  publicKeyFromPem,
  SIGNATURE_DOMAINS,
  type LocalRandomnessSourceEntry,
} from "@erl2/integrity";

/** A finalized beacon round as the beacon itself publishes it. */
export interface BeaconRound {
  readonly sourceId: string;
  readonly roundId: string;
  /** 64 raw bytes of beacon output. */
  readonly randomnessOutput: Buffer;
  readonly finalizedAt: string;
  readonly previousRoundId: string | undefined;
}

// The beacon-native proof wire types are the closed, schema-governed contract
// types (`BeaconSignatureProofV1` / `BeaconInclusionProofV1`, review §11.13),
// re-exported so callers keep the familiar names while the single source of
// truth is the schema + generated type — no independent handwritten interface
// can drift from the frozen wire format.
export type { BeaconSignatureProofV1, BeaconInclusionProofV1 };

/**
 * Re-parses a frozen beacon signature proof against its closed schema.  Used on
 * the offline-verifier boundary, where the proof arrives as untrusted bytes and
 * must fail closed before any field is consumed (§11.13).
 */
export function parseBeaconSignatureProof(bytes: Buffer): BeaconSignatureProofV1 {
  return assertContract<BeaconSignatureProofV1>(
    "BeaconSignatureProofV1",
    parseStrictJson(bytes.toString("utf8")),
  );
}

/** Re-parses a frozen beacon inclusion proof against its closed schema (§11.13). */
export function parseBeaconInclusionProof(bytes: Buffer): BeaconInclusionProofV1 {
  return assertContract<BeaconInclusionProofV1>(
    "BeaconInclusionProofV1",
    parseStrictJson(bytes.toString("utf8")),
  );
}

/**
 * Transport seam.  Core never reaches the network directly; a driver supplies
 * rounds so tests can inject timeouts, unfinalized rounds and wrong rounds.
 */
export interface BeaconSource {
  readonly sourceId: string;
  /**
   * The first round the source finalizes strictly after `afterInstant`.  There
   * is no retry, no fallback source and no alternate round: an unavailable
   * source invalidates the run.
   */
  firstFinalizedRoundAfter(afterInstant: string): BeaconRound;
  signatureProof(round: BeaconRound): BeaconSignatureProofV1;
  inclusionProof(round: BeaconRound): BeaconInclusionProofV1;
}

/** Canonical payload the beacon signs — ERL identifiers are deliberately absent. */
export function beaconRoundPayloadHash(round: {
  readonly sourceId: string;
  readonly roundId: string;
  readonly randomnessOutput: Buffer;
}): Hash {
  return domainHash(HASH_DOMAINS.BEACON_ROUND_PAYLOAD, {
    source_id: round.sourceId,
    round_id: round.roundId,
    randomness_output_base64: round.randomnessOutput.toString("base64"),
  });
}

function verifyRawSignature(publicKeyPem: string, domain: string, signature: Signature): boolean {
  const message = Buffer.from(`${domain}\n${signature.signed_hash}`, "ascii");
  const raw = Buffer.from(signature.signature_base64, "base64");
  if (raw.byteLength !== 64) return false;
  return ed25519Verify(null, message, publicKeyFromPem(publicKeyPem), raw);
}

const ERL2_SIGNATURE_DOMAINS: ReadonlySet<string> = new Set(Object.values(SIGNATURE_DOMAINS));

/**
 * Verifies the beacon-native proof strictly within its own scope.
 *
 * Refuses: a native domain that collides with any ERL2 signing domain, a key
 * outside the locally pinned set, a payload hash that does not cover exactly
 * the canonical round/output, and a proof that mentions any ERL identifier.
 */
export function verifyBeaconNativeProof(options: {
  readonly proof: BeaconSignatureProofV1;
  readonly inclusion: BeaconInclusionProofV1;
  readonly round: BeaconRound;
  readonly pinned: LocalRandomnessSourceEntry;
}): void {
  const { proof, inclusion, round, pinned } = options;

  if (ERL2_SIGNATURE_DOMAINS.has(proof.native_signature_domain)) {
    throw new Erl2Error(
      CODES.BEACON_WRAPPER_SCOPE_CONFUSED,
      "beacon-native proof claims an ERL2 signing domain",
    );
  }
  if (proof.native_signature_domain !== pinned.nativeSignatureDomain) {
    throw new Erl2Error(
      CODES.RANDOMNESS_TRUST_REGISTRY_STALE,
      "beacon-native signing domain differs from the locally pinned registry entry",
    );
  }
  if (proof.scope !== "canonical_beacon_round_and_output_only") {
    throw new Erl2Error(CODES.BEACON_WRAPPER_SCOPE_CONFUSED, "beacon proof declares a wider scope");
  }
  if (proof.source_id !== pinned.sourceId || inclusion.source_id !== pinned.sourceId) {
    throw new Erl2Error(CODES.RANDOMNESS_SOURCE_MISMATCH, "beacon proof names another source");
  }
  if (proof.round_id !== round.roundId || inclusion.round_id !== round.roundId) {
    throw new Erl2Error(
      CODES.BEACON_WRAPPER_NATIVE_PROOF_INVALID,
      "beacon proof covers a different round",
    );
  }
  if (proof.randomness_output_base64 !== round.randomnessOutput.toString("base64")) {
    throw new Erl2Error(
      CODES.BEACON_WRAPPER_NATIVE_PROOF_INVALID,
      "beacon proof covers a different output",
    );
  }
  const expected = beaconRoundPayloadHash(round);
  if (proof.beacon_signed_payload_hash !== expected) {
    throw new Erl2Error(
      CODES.BEACON_WRAPPER_NATIVE_PROOF_INVALID,
      "beacon_signed_payload_hash is not the canonical round/output payload",
    );
  }
  if (proof.signature.signed_hash !== expected) {
    throw new Erl2Error(
      CODES.BEACON_WRAPPER_SCOPE_CONFUSED,
      "beacon signature covers something other than its canonical round payload",
    );
  }
  const keyIndex = pinned.beaconKeyIds.indexOf(proof.signature.key_id);
  if (keyIndex < 0) {
    throw new Erl2Error(
      CODES.RANDOMNESS_SOURCE_NOT_PINNED,
      `beacon key ${proof.signature.key_id} is not locally pinned for ${pinned.sourceId}`,
    );
  }
  const pem = pinned.beaconPublicKeysPem[keyIndex];
  if (pem === undefined) {
    throw new Erl2Error(CODES.RANDOMNESS_TRUST_REGISTRY_STALE, "pinned registry entry is malformed");
  }
  if (!verifyRawSignature(pem, proof.native_signature_domain, proof.signature)) {
    throw new Erl2Error(CODES.BEACON_WRAPPER_NATIVE_PROOF_INVALID, "beacon-native signature is invalid");
  }
  if (inclusion.previous_round_id !== undefined && inclusion.previous_round_id === round.roundId) {
    throw new Erl2Error(CODES.BEACON_WRAPPER_NATIVE_PROOF_INVALID, "beacon inclusion proof is self-referential");
  }
}

/**
 * Refuses any wrapper that asserts the beacon received or signed ERL-specific
 * data (ERL2-AC-042).
 */
export function assertWrapperOwnership(
  receipt: ExternalBeaconRandomnessReceiptV1,
  proof: BeaconSignatureProofV1,
): void {
  if (receipt.wrapper_kind !== "lab_verifier_beacon_association") {
    throw new Erl2Error(CODES.BEACON_WRAPPER_SCOPE_CONFUSED, "wrapper kind is not a Lab/verifier association");
  }
  if (receipt.beacon_signed_scope !== "canonical_beacon_round_and_output_only") {
    throw new Erl2Error(
      CODES.BEACON_WRAPPER_SCOPE_CONFUSED,
      "wrapper claims the beacon signed more than its canonical round and output",
    );
  }
  if (receipt.wrapper_signed_scope !== "erl_request_policy_source_pool_checkpoint_round_association") {
    throw new Erl2Error(CODES.BEACON_WRAPPER_SCOPE_CONFUSED, "wrapper declares an unexpected signing scope");
  }
  if (receipt.beacon_signed_payload_hash !== proof.beacon_signed_payload_hash) {
    throw new Erl2Error(
      CODES.BEACON_WRAPPER_BINDING_MISMATCH,
      "wrapper references a beacon payload the native proof does not authenticate",
    );
  }
  // The decisive check: the beacon payload the wrapper points at must not be
  // any ERL-derived hash.
  const erlBoundHashes: readonly Hash[] = [
    receipt.selection_request_hash,
    receipt.eligibility_pool_manifest_hash,
    receipt.pool_root_hash,
    receipt.pool_manifest_timestamp_checkpoint_hash,
    receipt.randomness_policy_hash,
    receipt.source_request_binding_hash,
  ];
  if (erlBoundHashes.includes(receipt.beacon_signed_payload_hash)) {
    throw new Erl2Error(
      CODES.BEACON_WRAPPER_SCOPE_CONFUSED,
      "wrapper claims the beacon signed an ERL-derived binding",
    );
  }
  if (proof.signature.signed_hash === receipt.source_request_binding_hash) {
    throw new Erl2Error(
      CODES.BEACON_WRAPPER_SCOPE_CONFUSED,
      "beacon signature is presented as covering the ERL source-request binding",
    );
  }
}

/** Refuses any policy variant other than the active external beacon. */
export function assertActiveRandomnessVariant(policy: unknown): asserts policy is ExternalBeaconRandomnessPolicyV1 {
  const record = policy as Record<string, unknown>;
  const kind = record["source_kind"];
  if (kind === "threshold_vrf" || record["schema_version"] === "threshold-vrf-randomness-policy/v1") {
    throw new Erl2Error(
      CODES.THRESHOLD_VRF_NOT_ACTIVATED,
      "threshold VRF is disabled pending ADR-ERL2-011 and new major contracts",
      { owner: "lab" },
    );
  }
  if (record["schema_version"] !== "external-beacon-randomness-policy/v1" || kind !== "external_beacon") {
    throw new Erl2Error(
      CODES.RANDOMNESS_VARIANT_NOT_ADMISSIBLE,
      "the active randomness policy alias admits only the external-beacon contract",
    );
  }
}

/** Refuses any receipt variant other than the active external-beacon wrapper. */
export function assertActiveRandomnessReceiptVariant(
  receipt: unknown,
): asserts receipt is ExternalBeaconRandomnessReceiptV1 {
  const record = receipt as Record<string, unknown>;
  if (record["source_kind"] === "threshold_vrf") {
    throw new Erl2Error(
      CODES.THRESHOLD_VRF_NOT_ACTIVATED,
      "no threshold-VRF receipt contract exists in this revision",
    );
  }
  if (record["schema_version"] !== "external-beacon-randomness-receipt/v1") {
    throw new Erl2Error(
      CODES.RANDOMNESS_VARIANT_NOT_ADMISSIBLE,
      "the active randomness receipt alias admits only the beacon association wrapper",
    );
  }
  for (const forbidden of ["threshold", "participants", "transcript", "share_proofs", "dkg_transcript_hash"]) {
    if (Object.hasOwn(record, forbidden)) {
      throw new Erl2Error(
        CODES.RANDOMNESS_VARIANT_NOT_ADMISSIBLE,
        `beacon receipt carries the threshold-VRF field ${forbidden}`,
      );
    }
  }
}

/** Digest of a proof artifact's stored bytes, for `ArtifactRef.file_sha256`. */
export function proofBytes(proof: BeaconSignatureProofV1 | BeaconInclusionProofV1): Buffer {
  return Buffer.from(`${JSON.stringify(proof)}\n`, "utf8");
}

export function proofDigest(proof: BeaconSignatureProofV1 | BeaconInclusionProofV1): Hash {
  return hashBytes(proofBytes(proof));
}
