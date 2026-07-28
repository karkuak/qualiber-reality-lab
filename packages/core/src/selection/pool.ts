/**
 * Uniformly padded, threshold-encrypted eligibility pool (design v2 §15,
 * ERL2-FR-030/AC-034).
 *
 * Every selector-visible value and length comes from one pool-common profile.
 * Only the ciphertext bytes, their digest, the hiding commitment, the opaque
 * handle and the entry signature legitimately vary.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type EligibilityPoolEntryV2,
  type EligibilityPoolManifestV2,
  type Hash,
  type SelectionRoleSeparationAuditV1,
  type SelectorVisibleProfileV1,
} from "@erl2/contracts";
import {
  ArtifactStore,
  coreHash,
  jcsBytes,
  sealSigned,
  sealThresholdEnvelope,
  type CustodianKey,
  type SigningKey,
} from "@erl2/integrity";
import { hidingCommitment, opaqueHandleFromBytes, poolRootHash } from "./derive.js";
import type { Clock, RandomSource } from "../runtime/seams.js";

/** The exact, hidden content of one eligible entry. */
export interface EligibleCandidate {
  readonly challengeManifestHash: Hash;
  readonly personaScriptHash: Hash;
  readonly journeyHash: Hash;
  readonly orderedStepCommitmentHashes: readonly Hash[];
  readonly exposureEpoch: number;
}

export interface BuiltPoolEntry {
  readonly entry: EligibilityPoolEntryV2;
  readonly entryHash: Hash;
  /** Retained by the vault only; never published. */
  readonly openingNonceBase64: string;
  readonly candidate: EligibleCandidate;
  readonly envelopeLogicalPath: string;
}

export interface BuildPoolOptions {
  readonly poolId: string;
  readonly selectionRequestHash: Hash;
  readonly journeySelectionPolicyHash: Hash;
  readonly selectionRandomnessPolicyHash: Hash;
  readonly randomnessSourceId: string;
  readonly randomnessSourceTrustPolicyHash: Hash;
  readonly roleAudit: SelectionRoleSeparationAuditV1;
  readonly roleAuditHash: Hash;
  readonly candidates: readonly EligibleCandidate[];
  readonly custodians: readonly CustodianKey[];
  readonly revealThreshold: number;
  readonly decryptionReleasePolicyHash: Hash;
  readonly hiddenPayloadSchemaHash: Hash;
  readonly eligibilityProofHash: Hash;
  readonly governorKey: SigningKey;
  readonly entrySignerKey: SigningKey;
  readonly store: ArtifactStore;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly expiresAt: string;
}

export interface BuiltPool {
  readonly manifest: EligibilityPoolManifestV2;
  readonly manifestHash: Hash;
  readonly entries: readonly BuiltPoolEntry[];
}

/**
 * Fixed ciphertext plaintext size; one value for the whole pool.
 *
 * It must exceed the largest admitted payload, because a candidate whose payload
 * did not fit would be refused rather than padded — and a family that could only
 * admit short journeys would make journey *length* a selection-visible property.
 * It is raised, never narrowed to fit: the padding is what makes every entry's
 * selector-visible length identical, so shrinking it towards the current maximum
 * would leak how close the largest candidate is to the bound.
 */
const FIXED_PAYLOAD_PLAINTEXT_BYTES = 2048;
const ZERO_HASH: Hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
/** `pool/entries/<handle>.age`: 43-char handle keeps every path the same length. */
const ENTRY_PATH_PREFIX = "commitments/pool/entries/";
const ENTRY_PATH_SUFFIX = ".age";

function entryLogicalPath(handle: string): string {
  return `${ENTRY_PATH_PREFIX}${handle}${ENTRY_PATH_SUFFIX}`;
}

export function buildEligibilityPool(options: BuildPoolOptions): BuiltPool {
  if (options.candidates.length < 2) {
    throw new Erl2Error(
      CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
      "an eligibility pool needs at least two entries",
    );
  }
  if (options.roleAudit.selection_request_hash !== options.selectionRequestHash) {
    throw new Erl2Error(
      CODES.NON_COLLUSION_ROLE_OVERLAP,
      "role-separation audit is not bound to this selection request",
    );
  }

  const participantKeyIds = options.custodians.map((c) => c.keyId);
  const profileBase = {
    payload_ciphertext_byte_length: 0,
    entry_serialized_byte_length: 0,
    opaque_handle_encoding: "base64url-256" as const,
    artifact_path_pattern_id: "pool-entry-path" as const,
    artifact_path_byte_length: entryLogicalPath("x".repeat(43)).length,
    payload_media_type: "application/vnd.erl2.selection-binding+age" as const,
    payload_classification: "SECRET" as const,
    payload_encryption: "threshold-x25519-envelope/v1" as const,
    payload_padding: "iso7816-4-to-fixed-size" as const,
    reveal_threshold: options.revealThreshold,
    reveal_participant_key_ids: participantKeyIds,
    decryption_release_policy_hash: options.decryptionReleasePolicyHash,
    entry_signer_key_id: options.entrySignerKey.keyId,
    hidden_payload_schema_hash: options.hiddenPayloadSchemaHash,
    challenge_correlated_cleartext_fields: [] as const,
    exposure_epoch_visibility: "encrypted_until_selected" as const,
  };

  // First pass: seal every payload so the pool-common ciphertext length is a
  // measured fact rather than an assumption.
  const sealed = options.candidates.map((candidate) => {
    const handle = opaqueHandleFromBytes(options.random.bytes(32));
    const openingNonceBase64 = options.random.bytes(32).toString("base64");
    const payload = {
      schema_version: "hidden-binding-payload/v1" as const,
      challenge_manifest_hash: candidate.challengeManifestHash,
      persona_script_hash: candidate.personaScriptHash,
      journey_hash: candidate.journeyHash,
      ordered_step_commitment_hashes: [...candidate.orderedStepCommitmentHashes],
      exposure_epoch: candidate.exposureEpoch,
      opening_nonce_base64: openingNonceBase64,
    };
    assertContract("HiddenBindingPayloadV1", payload);
    const envelope = sealThresholdEnvelope({
      plaintext: jcsBytes(payload),
      paddedSize: FIXED_PAYLOAD_PLAINTEXT_BYTES,
      threshold: options.revealThreshold,
      custodians: options.custodians,
      associatedHandle: handle,
    });
    const envelopeBytes = Buffer.concat([jcsBytes(envelope), Buffer.from("\n", "utf8")]);
    return { candidate, handle, openingNonceBase64, payload, envelope, envelopeBytes };
  });

  const ciphertextLengths = new Set(sealed.map((s) => s.envelopeBytes.byteLength));
  if (ciphertextLengths.size !== 1) {
    throw new Erl2Error(
      CODES.POOL_METADATA_NOT_UNIFORM,
      "sealed payload lengths differ despite fixed-size padding",
    );
  }
  const payloadCiphertextByteLength = [...ciphertextLengths][0] as number;

  // Every selector-visible field of an entry is fixed-width, so the serialized
  // length can be measured from a template before the profile hash exists.
  // This breaks the profile/entry hash cycle without weakening uniformity: the
  // measured value is asserted against every real entry below.
  const templateEntry = {
    schema_version: "eligibility-pool-entry/v2" as const,
    opaque_entry_handle: "A".repeat(43),
    weight: 1 as const,
    challenge_actor_journey_hiding_commitment: ZERO_HASH,
    encrypted_binding_payload: {
      path: entryLogicalPath("A".repeat(43)),
      media_type: profileBase.payload_media_type,
      byte_length: payloadCiphertextByteLength,
      file_sha256: ZERO_HASH,
      classification: profileBase.payload_classification,
    },
    selector_visible_profile_hash: ZERO_HASH,
    core_hash: ZERO_HASH,
    signature: {
      algorithm: "Ed25519" as const,
      key_id: options.entrySignerKey.keyId,
      signed_hash: ZERO_HASH,
      signature_base64: `${"A".repeat(86)}==`,
    },
  };
  const entrySerializedByteLength = jcsBytes(templateEntry).byteLength;

  const profileWithoutHash = {
    ...profileBase,
    payload_ciphertext_byte_length: payloadCiphertextByteLength,
    entry_serialized_byte_length: entrySerializedByteLength,
  };
  const profile: SelectorVisibleProfileV1 = {
    ...profileWithoutHash,
    core_hash: coreHash(profileWithoutHash),
  };
  const profileHash = profile.core_hash;

  const serializedLengths = new Set<number>();
  const finalEntries: BuiltPoolEntry[] = sealed.map((item) => {
    const logicalPath = entryLogicalPath(item.handle);
    const ref = options.store.freeze({
      logicalPath,
      bytes: item.envelopeBytes,
      mediaType: profileBase.payload_media_type,
      classification: profileBase.payload_classification,
    });
    const commitment = hidingCommitment({
      challenge_manifest_hash: item.candidate.challengeManifestHash,
      persona_script_hash: item.candidate.personaScriptHash,
      journey_hash: item.candidate.journeyHash,
      ordered_step_commitment_hashes: item.candidate.orderedStepCommitmentHashes,
      exposure_epoch: item.candidate.exposureEpoch,
      opening_nonce_base64: item.openingNonceBase64,
    });
    const signed = sealSigned(
      {
        schema_version: "eligibility-pool-entry/v2" as const,
        opaque_entry_handle: item.handle,
        weight: 1 as const,
        challenge_actor_journey_hiding_commitment: commitment,
        encrypted_binding_payload: ref,
        selector_visible_profile_hash: profileHash,
      },
      options.entrySignerKey,
    );
    const entry = assertContract<EligibilityPoolEntryV2>("EligibilityPoolEntryV2", signed);
    serializedLengths.add(jcsBytes(entry).byteLength);
    return {
      entry,
      entryHash: coreHash(entry),
      openingNonceBase64: item.openingNonceBase64,
      candidate: item.candidate,
      envelopeLogicalPath: logicalPath,
    };
  });

  if (serializedLengths.size !== 1 || ![...serializedLengths].includes(entrySerializedByteLength)) {
    throw new Erl2Error(
      CODES.POOL_METADATA_NOT_UNIFORM,
      "selector-visible entry serialisations differ in length",
    );
  }

  const orderedEntryHashes = finalEntries.map((e) => e.entryHash);
  const root = poolRootHash({
    selection_request_hash: options.selectionRequestHash,
    journey_selection_policy_hash: options.journeySelectionPolicyHash,
    selection_randomness_policy_hash: options.selectionRandomnessPolicyHash,
    randomness_source_id: options.randomnessSourceId,
    randomness_source_trust_policy_hash: options.randomnessSourceTrustPolicyHash,
    selection_role_separation_audit_hash: options.roleAuditHash,
    ordered_entry_hashes: orderedEntryHashes,
    selector_visible_profile_core_hash: profileHash,
  });

  const manifestBase = {
    schema_version: "eligibility-pool-manifest/v2" as const,
    pool_id: options.poolId,
    selection_request_hash: options.selectionRequestHash,
    journey_selection_policy_hash: options.journeySelectionPolicyHash,
    selection_randomness_policy_hash: options.selectionRandomnessPolicyHash,
    randomness_source_id: options.randomnessSourceId,
    randomness_source_trust_policy_hash: options.randomnessSourceTrustPolicyHash,
    selection_role_separation_audit_hash: options.roleAuditHash,
    ordered_entry_hashes: orderedEntryHashes,
    entry_count: orderedEntryHashes.length,
    pool_root_hash: root,
    eligibility_proof_hash: options.eligibilityProofHash,
    selector_visible_profile: profile,
    created_at: options.clock.now(),
    expires_at: options.expiresAt,
  };
  const manifest = assertContract<EligibilityPoolManifestV2>(
    "EligibilityPoolManifestV2",
    sealSigned(manifestBase, options.governorKey),
  );

  return { manifest, manifestHash: coreHash(manifest), entries: finalEntries };
}

/**
 * Independently re-checks that every selector-visible value equals the pool
 * profile.  The verifier runs this without trusting the manifest's own claim.
 */
export function assertPoolMetadataUniform(
  manifest: EligibilityPoolManifestV2,
  entries: readonly EligibilityPoolEntryV2[],
): void {
  const profile = manifest.selector_visible_profile;
  if (coreHash(profile) !== profile.core_hash) {
    throw new Erl2Error(CODES.POOL_METADATA_NOT_UNIFORM, "selector-visible profile hash mismatch");
  }
  if (profile.challenge_correlated_cleartext_fields.length !== 0) {
    throw new Erl2Error(
      CODES.POOL_METADATA_NOT_UNIFORM,
      "profile declares challenge-correlated cleartext fields",
    );
  }
  if (manifest.entry_count !== manifest.ordered_entry_hashes.length) {
    throw new Erl2Error(CODES.SELECTION_CHAIN_POOL_ROOT_MISMATCH, "entry_count does not match the ordered array");
  }
  if (new Set(manifest.ordered_entry_hashes).size !== manifest.ordered_entry_hashes.length) {
    throw new Erl2Error(CODES.SELECTION_CHAIN_POOL_ROOT_MISMATCH, "duplicate entry hash in the ordered pool");
  }
  for (const entry of entries) {
    if (entry.selector_visible_profile_hash !== profile.core_hash) {
      throw new Erl2Error(CODES.POOL_METADATA_NOT_UNIFORM, "entry references a different profile");
    }
    if (entry.encrypted_binding_payload.byte_length !== profile.payload_ciphertext_byte_length) {
      throw new Erl2Error(CODES.POOL_METADATA_NOT_UNIFORM, "entry ciphertext length differs from the profile");
    }
    if (entry.encrypted_binding_payload.media_type !== profile.payload_media_type) {
      throw new Erl2Error(CODES.POOL_METADATA_NOT_UNIFORM, "entry payload media type differs from the profile");
    }
    if (entry.encrypted_binding_payload.classification !== profile.payload_classification) {
      throw new Erl2Error(CODES.POOL_METADATA_NOT_UNIFORM, "entry payload classification differs");
    }
    if (entry.encrypted_binding_payload.path.length !== profile.artifact_path_byte_length) {
      throw new Erl2Error(CODES.POOL_METADATA_NOT_UNIFORM, "entry path length differs from the profile");
    }
    if (entry.signature.key_id !== profile.entry_signer_key_id) {
      throw new Erl2Error(CODES.POOL_METADATA_NOT_UNIFORM, "entry signer differs from the profile");
    }
    if (jcsBytes(entry).byteLength !== profile.entry_serialized_byte_length) {
      throw new Erl2Error(CODES.POOL_METADATA_NOT_UNIFORM, "entry serialisation length differs from the profile");
    }
  }
}

export { FIXED_PAYLOAD_PLAINTEXT_BYTES, entryLogicalPath };
