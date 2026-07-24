/**
 * Deterministic selection derivations (design v2 §15).
 *
 * Every formula here is stated by the design and is re-derived independently by
 * the offline verifier; nothing in the chain is trusted because a producer
 * asserted it.
 */

import type {
  EligibilityPoolManifestV2,
  Hash,
  SelectorVisibleProfileV1,
} from "@erl2/contracts";
import { CODES, Erl2Error } from "@erl2/contracts";
import { coreHash, domainHash, domainHmac, HASH_DOMAINS, HMAC_DOMAINS } from "@erl2/integrity";

/** Payload committed by a pool entry's salted hiding commitment. */
export interface HidingCommitmentInput {
  readonly challenge_manifest_hash: Hash;
  readonly persona_script_hash: Hash;
  readonly journey_hash: Hash;
  readonly ordered_step_commitment_hashes: readonly Hash[];
  readonly exposure_epoch: number;
  readonly opening_nonce_base64: string;
}

export function hidingCommitment(input: HidingCommitmentInput): Hash {
  return domainHash(HASH_DOMAINS.POOL_ACTOR_JOURNEY, {
    challenge_manifest_hash: input.challenge_manifest_hash,
    persona_script_hash: input.persona_script_hash,
    journey_hash: input.journey_hash,
    ordered_step_commitment_hashes: [...input.ordered_step_commitment_hashes],
    exposure_epoch: input.exposure_epoch,
    opening_nonce_base64: input.opening_nonce_base64,
  });
}

export interface PoolRootInput {
  readonly selection_request_hash: Hash;
  readonly journey_selection_policy_hash: Hash;
  readonly selection_randomness_policy_hash: Hash;
  readonly randomness_source_id: string;
  readonly randomness_source_trust_policy_hash: Hash;
  readonly selection_role_separation_audit_hash: Hash;
  readonly ordered_entry_hashes: readonly Hash[];
  readonly selector_visible_profile_core_hash: Hash;
}

export function poolRootHash(input: PoolRootInput): Hash {
  return domainHash(HASH_DOMAINS.POOL_ROOT, {
    selection_request_hash: input.selection_request_hash,
    journey_selection_policy_hash: input.journey_selection_policy_hash,
    selection_randomness_policy_hash: input.selection_randomness_policy_hash,
    randomness_source_id: input.randomness_source_id,
    randomness_source_trust_policy_hash: input.randomness_source_trust_policy_hash,
    selection_role_separation_audit_hash: input.selection_role_separation_audit_hash,
    ordered_entry_hashes: [...input.ordered_entry_hashes],
    selector_visible_profile_core_hash: input.selector_visible_profile_core_hash,
  });
}

/** Recomputes the pool root from a frozen manifest. */
export function poolRootOf(manifest: EligibilityPoolManifestV2): Hash {
  return poolRootHash({
    selection_request_hash: manifest.selection_request_hash,
    journey_selection_policy_hash: manifest.journey_selection_policy_hash,
    selection_randomness_policy_hash: manifest.selection_randomness_policy_hash,
    randomness_source_id: manifest.randomness_source_id,
    randomness_source_trust_policy_hash: manifest.randomness_source_trust_policy_hash,
    selection_role_separation_audit_hash: manifest.selection_role_separation_audit_hash,
    ordered_entry_hashes: manifest.ordered_entry_hashes,
    selector_visible_profile_core_hash: manifest.selector_visible_profile.core_hash,
  });
}

export function selectorVisibleProfileCoreHash(profile: SelectorVisibleProfileV1): Hash {
  return coreHash(profile);
}

export interface SourceRequestBindingInput {
  readonly selection_request_hash: Hash;
  readonly selection_randomness_policy_hash: Hash;
  readonly source_id: string;
  readonly source_trust_policy_hash: Hash;
  readonly pool_root_hash: Hash;
  readonly pool_manifest_timestamp_checkpoint_hash: Hash;
}

/**
 * The Lab-derived randomness request binding.
 *
 * This hash is recorded in the Lab/verifier association wrapper.  It is never
 * sent to, received by, or signed by the beacon (ERL2-FR-038).
 */
export function sourceRequestBindingHash(input: SourceRequestBindingInput): Hash {
  return domainHash(HASH_DOMAINS.RANDOMNESS_REQUEST, {
    selection_request_hash: input.selection_request_hash,
    selection_randomness_policy_hash: input.selection_randomness_policy_hash,
    source_id: input.source_id,
    source_trust_policy_hash: input.source_trust_policy_hash,
    pool_root_hash: input.pool_root_hash,
    pool_manifest_timestamp_checkpoint_hash: input.pool_manifest_timestamp_checkpoint_hash,
  });
}

export interface DerivedSelection {
  readonly index: number;
  readonly rejectionCount: number;
}

/**
 * Domain-separated HMAC-SHA-256 rejection sampling.
 *
 * The design fixes the seed as
 * `HMAC-SHA-256(randomness_output, "ERL2-SELECT-V2\n" || request_nonce || pool_root_hash)`.
 * ADR-ERL2-011 pins the block expansion used to reject bias: successive
 * `HMAC-SHA-256(seed, "ERL2-SELECT-INDEX-V2\n" || be32(counter))` blocks supply
 * 32-bit candidates, and any candidate at or above the largest multiple of
 * `entryCount` below 2^32 is rejected.  There is no selector seed, nonce search,
 * retry or redraw: the inputs are fixed before the draw exists.
 */
export function deriveSelectedIndex(
  randomnessOutput: Buffer,
  requestNonce: string,
  poolRoot: Hash,
  entryCount: number,
): DerivedSelection {
  if (!Number.isInteger(entryCount) || entryCount < 2 || entryCount > 4096) {
    throw new Erl2Error(CODES.SELECTION_CHAIN_EDGE_UNCLOSED, "pool entry count out of range");
  }
  const seed = domainHmac(
    HMAC_DOMAINS.SELECT,
    randomnessOutput,
    Buffer.from(`${requestNonce}${poolRoot}`, "utf8"),
  );
  const limit = Math.floor(0x100000000 / entryCount) * entryCount;
  let rejectionCount = 0;
  for (let counter = 0; counter < 1_000_000; counter += 1) {
    const message = Buffer.alloc(4);
    message.writeUInt32BE(counter, 0);
    const block = domainHmac(HMAC_DOMAINS.SELECT_INDEX, seed, message);
    for (let offset = 0; offset + 4 <= block.length; offset += 4) {
      const candidate = block.readUInt32BE(offset);
      if (candidate < limit) {
        return { index: candidate % entryCount, rejectionCount };
      }
      rejectionCount += 1;
    }
  }
  /* c8 ignore next */
  throw new Erl2Error(CODES.SELECTION_RANDOMNESS_INDEX_MISMATCH, "rejection sampling did not converge");
}

/** Fixed-width opaque handle for a pool entry. */
export function opaqueHandleFromBytes(bytes: Buffer): string {
  if (bytes.length !== 32) throw new Error("opaque entry handle must be 256 bits");
  return bytes.toString("base64url");
}
