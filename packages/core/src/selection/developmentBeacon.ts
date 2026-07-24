/**
 * DEVELOPMENT-ONLY beacon source.
 *
 * ERL2-OQ-007 (qualify a real external beacon, its locally pinned registry
 * entry and the custodian roster) is unresolved, so the fail-closed state
 * defined by the design and implementation plan applies: non-blind development
 * selection only, and no held-out or blind claim.
 *
 * This source exists so the complete selection chain — native proof, wrapper
 * ownership, source-trust pinning, acyclic checkpoints, threshold reveal — is
 * implemented and adversarially tested now.  `assertDevelopmentTierOnly` makes
 * the restriction executable: constructing a held-out or blind run against it
 * is refused, it is never wired into the release CLI's held-out path, and its
 * signing key is a deterministic development key.
 */

import { CODES, Erl2Error, type Tier } from "@erl2/contracts";
import { developmentKey, publicKeyToPem, signForeignDomain, type SigningKey } from "@erl2/integrity";
import type { LocalRandomnessSourceEntry } from "@erl2/integrity";
import {
  beaconRoundPayloadHash,
  type BeaconInclusionProofV1,
  type BeaconRound,
  type BeaconSignatureProofV1,
  type BeaconSource,
} from "./beacon.js";
import { domainHash, HASH_DOMAINS } from "@erl2/integrity";

/** The development beacon's own signing domain; deliberately not an ERL2 domain. */
export const DEVELOPMENT_BEACON_NATIVE_DOMAIN = "DEV-BEACON-ROUND-V1";

export const DEVELOPMENT_BEACON_SOURCE_ID = "erl2-development-beacon";

export interface DevelopmentBeaconOptions {
  readonly sourceId?: string;
  /** Deterministic round seed so fixtures are reproducible. */
  readonly seed: string;
  /** Interval between simulated finalized rounds. */
  readonly roundIntervalMs?: number;
  readonly firstRoundAt: string;
  readonly signingKey?: SigningKey;
}

export class DevelopmentBeaconSource implements BeaconSource {
  readonly sourceId: string;
  private readonly seed: string;
  private readonly intervalMs: number;
  private readonly firstRoundMs: number;
  private readonly key: SigningKey;
  private observedRoundId: string | undefined;

  constructor(options: DevelopmentBeaconOptions) {
    this.sourceId = options.sourceId ?? DEVELOPMENT_BEACON_SOURCE_ID;
    this.seed = options.seed;
    this.intervalMs = options.roundIntervalMs ?? 30_000;
    this.firstRoundMs = Date.parse(options.firstRoundAt);
    this.key = options.signingKey ?? developmentKey("beacon");
  }

  /** Public key material a verifier would pin out of band. */
  pinnedRegistryEntry(sourceTrustPolicyHash: `sha256:${string}`): LocalRandomnessSourceEntry {
    return {
      sourceId: this.sourceId,
      sourceTrustPolicyHash,
      beaconKeyIds: [this.key.keyId],
      beaconPublicKeysPem: [publicKeyToPem(this.key.publicKey)],
      nativeSignatureDomain: DEVELOPMENT_BEACON_NATIVE_DOMAIN,
      revoked: false,
    };
  }

  firstFinalizedRoundAfter(afterInstant: string): BeaconRound {
    if (this.observedRoundId !== undefined) {
      // No retry, no second draw, no alternate round (ERL2-AC-036).
      throw new Erl2Error(
        CODES.SELECTION_RANDOMNESS_INDEX_MISMATCH,
        "a round was already observed for this pool; a second draw is forbidden",
      );
    }
    const after = Date.parse(afterInstant);
    let index = 0;
    let at = this.firstRoundMs;
    while (at <= after) {
      index += 1;
      at = this.firstRoundMs + index * this.intervalMs;
    }
    const roundId = `dev-round-${String(index).padStart(8, "0")}`;
    this.observedRoundId = roundId;
    return {
      sourceId: this.sourceId,
      roundId,
      randomnessOutput: this.outputFor(roundId),
      finalizedAt: new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z"),
      previousRoundId: index === 0 ? undefined : `dev-round-${String(index - 1).padStart(8, "0")}`,
    };
  }

  signatureProof(round: BeaconRound): BeaconSignatureProofV1 {
    const payloadHash = beaconRoundPayloadHash(round);
    return {
      proof_kind: "beacon_native_signature",
      scope: "canonical_beacon_round_and_output_only",
      native_signature_domain: DEVELOPMENT_BEACON_NATIVE_DOMAIN,
      source_id: round.sourceId,
      round_id: round.roundId,
      randomness_output_base64: round.randomnessOutput.toString("base64"),
      beacon_signed_payload_hash: payloadHash,
      // The beacon signs with its own domain; ERL2 domains are refused here.
      signature: signForeignDomain(this.key, DEVELOPMENT_BEACON_NATIVE_DOMAIN, payloadHash),
    };
  }

  inclusionProof(round: BeaconRound): BeaconInclusionProofV1 {
    return {
      proof_kind: "beacon_native_inclusion",
      source_id: round.sourceId,
      round_id: round.roundId,
      ...(round.previousRoundId === undefined ? {} : { previous_round_id: round.previousRoundId }),
      chain_hash: domainHash(HASH_DOMAINS.BEACON_ROUND_PAYLOAD, {
        chain: "development",
        round_id: round.roundId,
        previous_round_id: round.previousRoundId ?? null,
      }),
    };
  }

  private outputFor(roundId: string): Buffer {
    const a = domainHash(HASH_DOMAINS.BEACON_ROUND_PAYLOAD, { seed: this.seed, round_id: roundId, half: 0 });
    const b = domainHash(HASH_DOMAINS.BEACON_ROUND_PAYLOAD, { seed: this.seed, round_id: roundId, half: 1 });
    return Buffer.concat([
      Buffer.from(a.slice("sha256:".length), "hex"),
      Buffer.from(b.slice("sha256:".length), "hex"),
    ]);
  }
}

/**
 * Executable fail-closed guard for ERL2-OQ-007.  Held-out and blind tiers may
 * not run against a development beacon.
 */
export function assertDevelopmentTierOnly(tier: Tier, sourceId: string): void {
  if (tier !== "development" && sourceId === DEVELOPMENT_BEACON_SOURCE_ID) {
    throw new Erl2Error(
      CODES.RANDOMNESS_SOURCE_NOT_PINNED,
      "the development beacon may not drive a held-out or blind selection (ERL2-OQ-007 unresolved)",
    );
  }
}
