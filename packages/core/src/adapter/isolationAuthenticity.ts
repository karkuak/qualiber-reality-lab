/**
 * Verifier-controlled isolation-qualification authenticity (6R-E, review P2-1,
 * ERL2-OQ-008, ADR-ERL2-016/017).
 *
 * The qualification verdict (`buildIsolationQualificationReport`) is derived from
 * probe *content* — it answers "were the twenty controls observed enforcing?".
 * It does NOT answer "can I trust that this evidence is authentic?".  The review
 * showed that gap is real: the substrate lock carries an Ed25519 signature that
 * was never verified (corrupting it still yielded `qualified`), and the only
 * signer is `developmentKey("environment-governor")`, whose private key is
 * derivable from this repository.  A hand-authored `environments/isolation/` with
 * twenty `observed` probes therefore "qualified" under `erl2 doctor`.
 *
 * This module adds the authenticity chain doctor must run *before* it may claim
 * an authenticated qualification:
 *
 *   - the lock's signature must cryptographically verify (tamper is refused);
 *   - the signer must be a **pinned, verifier-controlled** qualification
 *     authority — a development key is explicitly NOT one, so a valid
 *     dev-signed lock is `locally_observed_unauthenticated` (self-reported),
 *     never `authenticated`.
 *
 * No real qualification authority exists on this checkout, so the honest result
 * is `locally_observed_unauthenticated`.  `authenticated` is reachable only when
 * a pinned authority signs — which is deliberately out of scope until the
 * container-backed launcher lands (OQ-008 stays open).
 */
import { createPublicKey } from "node:crypto";
import {
  assertContract,
  type Hash,
  type Instant,
  type IsolationEnforcementProbeResultV1,
  type IsolationProbeSigningManifestV1,
  type IsolationSubstrateLockV1,
} from "@erl2/contracts";
import {
  coreHash,
  developmentKey,
  sealSigned,
  SIGNATURE_DOMAINS,
  verifySignature,
  type SigningKey,
} from "@erl2/integrity";

/**
 * Distinguished authenticity outcomes (§10.2).  `not_qualified` covers both
 * absent evidence and a tampered/unverifiable lock; the launcher-unavailable
 * qualifier is layered on by the caller, since even an authenticated substrate
 * cannot execute an opaque subject while OQ-008 is open.
 */
export type IsolationAuthenticity =
  | "not_qualified"
  | "locally_observed_unauthenticated"
  | "authenticated";

/** A verifier-controlled, pinned qualification authority (public key only). */
export interface PinnedQualificationAuthority {
  readonly keyId: string;
  readonly publicKeyPem: string;
}

/** The development governor key is repo-derivable and never a real authority. */
const DEVELOPMENT_GOVERNOR = developmentKey("environment-governor");

export interface LockSignatureVerification {
  readonly signatureValid: boolean;
  readonly signerKeyId: string;
  readonly signerIsPinnedAuthority: boolean;
  readonly signerIsDevelopmentKey: boolean;
  readonly reason?: string;
}

/**
 * Verifies the substrate lock's Ed25519 signature and classifies the signer.
 *
 * The signed hash must be the lock's own `core_hash`; the signature must verify
 * under the signer's public key (a pinned authority's, or the development
 * governor's).  An unknown signer whose key the verifier does not hold cannot be
 * authenticated.
 */
export function verifyIsolationLockSignature(
  lock: IsolationSubstrateLockV1,
  pinnedAuthorities: readonly PinnedQualificationAuthority[] = [],
): LockSignatureVerification {
  const signerKeyId = lock.signature.key_id;
  const recomputed = coreHash(lock);
  if (lock.signature.signed_hash !== recomputed) {
    return {
      signatureValid: false,
      signerKeyId,
      signerIsPinnedAuthority: false,
      signerIsDevelopmentKey: false,
      reason: "SUBSTRATE_LOCK_SIGNED_HASH_MISMATCH",
    };
  }

  const pinned = pinnedAuthorities.find((a) => a.keyId === signerKeyId);
  if (pinned !== undefined) {
    const valid = safeVerify(pinned.publicKeyPem, lock);
    return {
      signatureValid: valid,
      signerKeyId,
      signerIsPinnedAuthority: valid,
      signerIsDevelopmentKey: false,
      ...(valid ? {} : { reason: "SUBSTRATE_LOCK_SIGNATURE_INVALID" }),
    };
  }

  if (signerKeyId === DEVELOPMENT_GOVERNOR.keyId) {
    const valid = verifySignature(DEVELOPMENT_GOVERNOR.publicKey, SIGNATURE_DOMAINS.ERL2, lock.signature);
    return {
      signatureValid: valid,
      signerKeyId,
      signerIsPinnedAuthority: false,
      signerIsDevelopmentKey: true,
      reason: valid ? "SUBSTRATE_LOCK_SIGNED_BY_DEVELOPMENT_KEY" : "SUBSTRATE_LOCK_SIGNATURE_INVALID",
    };
  }

  return {
    signatureValid: false,
    signerKeyId,
    signerIsPinnedAuthority: false,
    signerIsDevelopmentKey: false,
    reason: "SUBSTRATE_LOCK_SIGNER_NOT_PINNED",
  };
}

function safeVerify(publicKeyPem: string, lock: IsolationSubstrateLockV1): boolean {
  try {
    return verifySignature(createPublicKey(publicKeyPem), SIGNATURE_DOMAINS.ERL2, lock.signature);
  } catch {
    return false;
  }
}

/**
 * Combines the content verdict with the signature verification into the single
 * authenticity outcome doctor reports.  Content that is not qualified, or a lock
 * whose signature does not verify, is `not_qualified`; a valid signature by a
 * pinned authority is `authenticated`; a valid signature by anything else (i.e.
 * a development key) is `locally_observed_unauthenticated`.
 */
/**
 * Builds and signs the probe-signing manifest that authenticates the twenty
 * probe results (review §10.1/6R-E).  The manifest binds the ordered probe
 * result core hashes to the lock and probe suite and is signed by the
 * qualification authority (a development key in this checkout).
 */
export function buildIsolationProbeSigningManifest(input: {
  readonly manifestId: string;
  readonly lock: IsolationSubstrateLockV1;
  readonly probeResults: readonly IsolationEnforcementProbeResultV1[];
  readonly signedAt: Instant;
  readonly signingKey: SigningKey;
}): IsolationProbeSigningManifestV1 {
  const body = {
    schema_version: "isolation-probe-signing-manifest/v1" as const,
    manifest_id: input.manifestId,
    substrate_lock_hash: coreHash(input.lock),
    probe_suite_id: input.lock.probe_suite_id,
    probe_suite_digest: input.lock.probe_suite_digest,
    probe_result_hashes: input.probeResults.map((r) => coreHash(r)),
    signed_at: input.signedAt,
  };
  return assertContract<IsolationProbeSigningManifestV1>(
    "IsolationProbeSigningManifestV1",
    sealSigned(body, input.signingKey),
  );
}

/** Distinguished probe-manifest verification outcome. */
export type ProbeManifestStatus =
  | "absent"
  | "invalid"
  | "valid_development"
  | "valid_authority";

export interface ProbeManifestVerification {
  readonly status: ProbeManifestStatus;
  readonly signerKeyId: string;
  readonly reason?: string;
}

/**
 * Verifies that the signed probe manifest authenticates *exactly* the evaluated
 * probe results and binds them to the lock and suite.  A present-but-broken
 * manifest (bad signature, wrong lock, or a probe-hash set that does not cover
 * the evaluated results) is `invalid` — a substitution/tamper attempt — and a
 * caller treats it as fail-closed.  A valid dev-key manifest is
 * `valid_development` (self-reported); only a pinned-authority manifest is
 * `valid_authority`.
 */
export function verifyIsolationProbeManifest(
  manifest: IsolationProbeSigningManifestV1 | undefined,
  lock: IsolationSubstrateLockV1,
  probeResults: readonly IsolationEnforcementProbeResultV1[],
  pinnedAuthorities: readonly PinnedQualificationAuthority[] = [],
): ProbeManifestVerification {
  if (manifest === undefined) {
    return { status: "absent", signerKeyId: "absent" };
  }
  const signerKeyId = manifest.signature.key_id;
  if (manifest.signature.signed_hash !== coreHash(manifest)) {
    return { status: "invalid", signerKeyId, reason: "PROBE_MANIFEST_SIGNED_HASH_MISMATCH" };
  }
  // Bindings: the manifest must cover THIS lock and suite, and exactly the
  // evaluated probe results (order-independent set equality).
  if (manifest.substrate_lock_hash !== coreHash(lock)) {
    return { status: "invalid", signerKeyId, reason: "PROBE_MANIFEST_LOCK_MISMATCH" };
  }
  if (
    manifest.probe_suite_id !== lock.probe_suite_id ||
    manifest.probe_suite_digest !== lock.probe_suite_digest
  ) {
    return { status: "invalid", signerKeyId, reason: "PROBE_MANIFEST_SUITE_MISMATCH" };
  }
  const evaluated = new Set<Hash>(probeResults.map((r) => coreHash(r)));
  const manifested = new Set<Hash>(manifest.probe_result_hashes);
  const covers =
    evaluated.size === manifested.size && [...evaluated].every((h) => manifested.has(h));
  if (!covers) {
    return { status: "invalid", signerKeyId, reason: "PROBE_MANIFEST_DOES_NOT_COVER_RESULTS" };
  }

  const pinned = pinnedAuthorities.find((a) => a.keyId === signerKeyId);
  if (pinned !== undefined) {
    let valid = false;
    try {
      valid = verifySignature(createPublicKey(pinned.publicKeyPem), SIGNATURE_DOMAINS.ERL2, manifest.signature);
    } catch {
      valid = false;
    }
    return valid
      ? { status: "valid_authority", signerKeyId }
      : { status: "invalid", signerKeyId, reason: "PROBE_MANIFEST_SIGNATURE_INVALID" };
  }
  if (signerKeyId === DEVELOPMENT_GOVERNOR.keyId) {
    const valid = verifySignature(DEVELOPMENT_GOVERNOR.publicKey, SIGNATURE_DOMAINS.ERL2, manifest.signature);
    return valid
      ? { status: "valid_development", signerKeyId }
      : { status: "invalid", signerKeyId, reason: "PROBE_MANIFEST_SIGNATURE_INVALID" };
  }
  return { status: "invalid", signerKeyId, reason: "PROBE_MANIFEST_SIGNER_NOT_PINNED" };
}

/**
 * Combines the content verdict, the lock-signature verification AND the
 * probe-manifest verification into the single authenticity outcome.
 *
 *   - not qualified content, or an unverifiable lock signature, or a
 *     present-but-broken probe manifest (tamper/substitution) → `not_qualified`;
 *   - a pinned authority signed BOTH the lock and a covering probe manifest →
 *     `authenticated` (the only path to it);
 *   - otherwise (valid lock signature, but a dev-signed or absent probe
 *     manifest, i.e. self-reported evidence) → `locally_observed_unauthenticated`.
 *
 * So `authenticated` now requires the probe *results* to be authenticated, not
 * just the lock (review §10.1). Dev-signed evidence stays
 * `locally_observed_unauthenticated`.
 */
export function deriveIsolationAuthenticity(input: {
  readonly contentQualified: boolean;
  readonly signature: LockSignatureVerification;
  readonly probeManifest?: ProbeManifestVerification;
}): IsolationAuthenticity {
  if (!input.contentQualified) return "not_qualified";
  if (!input.signature.signatureValid) return "not_qualified";
  const probe = input.probeManifest ?? { status: "absent" as const, signerKeyId: "absent" };
  if (probe.status === "invalid") return "not_qualified";
  if (input.signature.signerIsPinnedAuthority && probe.status === "valid_authority") {
    return "authenticated";
  }
  return "locally_observed_unauthenticated";
}
