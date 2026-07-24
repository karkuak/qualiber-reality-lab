/**
 * Trust evaluation with two independent verdicts (design v2 §14/§16.2):
 *   - `valid_when_signed`: the key was authorized for the role and contract at
 *     the security timestamp;
 *   - `currently_trusted`: the key is still authorized under the *locally
 *     pinned* current head.
 *
 * Presented bundle state — policies, inventories, checkpoints, wrapper keys —
 * is evidence to validate, never a trust anchor (ERL2-FR-023).
 */

import type { KeyObject } from "node:crypto";
import {
  CODES,
  Erl2Error,
  type Hash,
  type Signature,
  type TrustPolicyManifestV2,
} from "@erl2/contracts";
import { coreHash } from "../hash/hash.js";
import { publicKeyFromPem, verifySignature } from "../signatures/ed25519.js";
import { SIGNATURE_DOMAINS, type SignatureDomain } from "../hash/domains.js";

export type SignerRole = TrustPolicyManifestV2["keys"][number]["signer_roles"][number];

/**
 * Verifier-controlled local configuration.  The CLI populates this only from
 * `--root-config` / `--source-trust-config`; it may never be filled from a
 * policy, receipt, bundle or report.
 */
export interface LocalTrustConfiguration {
  /** Root key ids the verifier itself pins. */
  readonly rootKeyIds: readonly string[];
  /** The trust-policy core hash the verifier accepts as the current head. */
  readonly currentTrustHeadHash: Hash;
  /** Authorized randomness sources, keyed by `source_id`. */
  readonly randomnessSources: readonly LocalRandomnessSourceEntry[];
  /** The registry head hash the verifier pins for those sources. */
  readonly randomnessRegistryHeadHash: Hash;
}

export interface LocalRandomnessSourceEntry {
  readonly sourceId: string;
  readonly sourceTrustPolicyHash: Hash;
  readonly beaconKeyIds: readonly string[];
  readonly beaconPublicKeysPem: readonly string[];
  /**
   * The beacon's OWN native signing domain, pinned by the verifier.  It must
   * never be one of the ERL2 signature domains: conflating the two would let a
   * beacon signature be replayed as a Lab/verifier association signature, or
   * vice versa (ERL2-FR-038, BEACON-WRAPPER-OWNERSHIP).
   */
  readonly nativeSignatureDomain: string;
  readonly revoked: boolean;
}

export interface TrustVerdict {
  readonly keyId: string;
  readonly validWhenSigned: boolean;
  readonly currentlyTrusted: boolean;
  readonly appliedRevocationIds: readonly string[];
}

export class TrustEvaluator {
  private readonly policy: TrustPolicyManifestV2;
  private readonly local: LocalTrustConfiguration;
  private readonly keyCache = new Map<string, KeyObject>();

  constructor(policy: TrustPolicyManifestV2, local: LocalTrustConfiguration) {
    this.policy = policy;
    this.local = local;
    this.assertPolicyIsLocallyPinned();
  }

  /**
   * A presented policy is only usable when the verifier's own configuration
   * already names its head and root key.  A self-consistent policy that names
   * itself is refused (ERL2-AC-027).
   */
  private assertPolicyIsLocallyPinned(): void {
    const presentedHead = coreHash(this.policy);
    if (presentedHead !== this.local.currentTrustHeadHash) {
      throw new Erl2Error(
        CODES.TRUST_HEAD_NOT_LOCALLY_PINNED,
        "presented trust policy head differs from locally pinned current head",
      );
    }
    if (!this.local.rootKeyIds.includes(this.policy.root_key_id)) {
      throw new Erl2Error(
        CODES.TRUST_HEAD_SELF_ANCHORED,
        `trust policy root key ${this.policy.root_key_id} is not locally pinned`,
      );
    }
    const rootEntry = this.policy.keys.find((k) => k.key_id === this.policy.root_key_id);
    if (!rootEntry || !rootEntry.signer_roles.includes("trust_root")) {
      throw new Erl2Error(CODES.TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE, "root key lacks the trust_root role");
    }
    const rootKey = publicKeyFromPem(rootEntry.public_key_pem);
    if (!verifySignature(rootKey, SIGNATURE_DOMAINS.LEGACY_V1, this.policy.root_signature)) {
      throw new Erl2Error(CODES.TRUST_SIGNATURE_INVALID, "trust policy root signature is invalid");
    }
    if (this.policy.root_signature.signed_hash !== presentedHead) {
      throw new Erl2Error(CODES.TRUST_SIGNATURE_INVALID, "trust policy signature covers other bytes");
    }
  }

  publicKeyFor(keyId: string): KeyObject {
    const cached = this.keyCache.get(keyId);
    if (cached) return cached;
    const entry = this.policy.keys.find((k) => k.key_id === keyId);
    if (!entry) throw new Erl2Error(CODES.TRUST_KEY_UNKNOWN, `unknown signer key ${keyId}`);
    const key = publicKeyFromPem(entry.public_key_pem);
    this.keyCache.set(keyId, key);
    return key;
  }

  /** Roles a key holds under the presented (and locally pinned) policy. */
  rolesFor(keyId: string): readonly SignerRole[] {
    const entry = this.policy.keys.find((k) => k.key_id === keyId);
    if (!entry) throw new Erl2Error(CODES.TRUST_KEY_UNKNOWN, `unknown signer key ${keyId}`);
    return entry.signer_roles;
  }

  assertRole(keyId: string, role: SignerRole): void {
    if (!this.rolesFor(keyId).includes(role)) {
      throw new Erl2Error(
        CODES.TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE,
        `key ${keyId} is not authorized for role ${role}`,
      );
    }
  }

  assertContractPermitted(keyId: string, schemaVersion: string): void {
    const entry = this.policy.keys.find((k) => k.key_id === keyId);
    if (!entry) throw new Erl2Error(CODES.TRUST_KEY_UNKNOWN, `unknown signer key ${keyId}`);
    if (entry.permitted_contract_types.length === 0) return;
    if (!entry.permitted_contract_types.includes(schemaVersion)) {
      throw new Erl2Error(
        CODES.TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE,
        `key ${keyId} may not sign ${schemaVersion}`,
      );
    }
  }

  /** Both trust verdicts for one signature at one security timestamp. */
  evaluate(keyId: string, securityTimestamp: string): TrustVerdict {
    const entry = this.policy.keys.find((k) => k.key_id === keyId);
    if (!entry) throw new Erl2Error(CODES.TRUST_KEY_UNKNOWN, `unknown signer key ${keyId}`);
    const t = Date.parse(securityTimestamp);
    const from = Date.parse(entry.valid_from);
    const until = Date.parse(entry.valid_until);
    const inWindow = t >= from && t <= until;

    const applied: string[] = [];
    let validWhenSigned = inWindow;
    let currentlyTrusted = inWindow && entry.status === "active";

    for (const revocation of this.policy.revocations) {
      if (revocation.key_id !== keyId) continue;
      switch (revocation.scope) {
        case "all_historical":
          applied.push(revocation.revocation_id);
          validWhenSigned = false;
          currentlyTrusted = false;
          break;
        case "from_timestamp": {
          const cut = revocation.from_timestamp === undefined ? Number.NaN : Date.parse(revocation.from_timestamp);
          applied.push(revocation.revocation_id);
          currentlyTrusted = false;
          if (!Number.isNaN(cut) && t >= cut) validWhenSigned = false;
          break;
        }
        case "prospective": {
          const effective = revocation.effective_at === undefined ? Number.NaN : Date.parse(revocation.effective_at);
          applied.push(revocation.revocation_id);
          currentlyTrusted = false;
          if (!Number.isNaN(effective) && t >= effective) validWhenSigned = false;
          break;
        }
        default:
          break;
      }
    }

    return { keyId, validWhenSigned, currentlyTrusted, appliedRevocationIds: applied };
  }

  /**
   * Verifies a signature under a role, a contract type and both trust
   * verdicts.  Any failure is fail-closed.
   */
  verifyRoleSignature(options: {
    readonly value: object;
    readonly signature: Signature;
    readonly role: SignerRole;
    readonly schemaVersion: string;
    readonly securityTimestamp: string;
    readonly domain?: SignatureDomain;
  }): TrustVerdict {
    const domain = options.domain ?? SIGNATURE_DOMAINS.ERL2;
    const keyId = options.signature.key_id;
    this.assertRole(keyId, options.role);
    this.assertContractPermitted(keyId, options.schemaVersion);
    const recomputed = coreHash(options.value);
    if (options.signature.signed_hash !== recomputed) {
      throw new Erl2Error(
        CODES.TRUST_SIGNATURE_INVALID,
        `signature over ${options.schemaVersion} covers a different core hash`,
      );
    }
    if (!verifySignature(this.publicKeyFor(keyId), domain, options.signature)) {
      throw new Erl2Error(CODES.TRUST_SIGNATURE_INVALID, `invalid signature by ${keyId}`);
    }
    const verdict = this.evaluate(keyId, options.securityTimestamp);
    if (!verdict.validWhenSigned) {
      throw new Erl2Error(CODES.TRUST_KEY_REVOKED, `key ${keyId} was not trusted when it signed`);
    }
    return verdict;
  }

  /** Locally pinned randomness-source entry, or a fail-closed refusal. */
  randomnessSource(sourceId: string): LocalRandomnessSourceEntry {
    const entry = this.local.randomnessSources.find((s) => s.sourceId === sourceId);
    if (!entry) {
      throw new Erl2Error(
        CODES.RANDOMNESS_SOURCE_NOT_PINNED,
        `randomness source ${sourceId} is not in the locally pinned registry`,
      );
    }
    if (entry.revoked) {
      throw new Erl2Error(CODES.RANDOMNESS_SOURCE_REVOKED, `randomness source ${sourceId} is revoked`);
    }
    return entry;
  }

  get localConfiguration(): LocalTrustConfiguration {
    return this.local;
  }

  get trustPolicy(): TrustPolicyManifestV2 {
    return this.policy;
  }
}
