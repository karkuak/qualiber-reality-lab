/**
 * Closed domain registry for domain-separated SHA-256 and Ed25519 signatures.
 *
 * Every hash or signature the Lab produces names exactly one entry here.  The
 * registry is closed: adding a domain is an ADR-class change because it alters
 * canonical bytes (implementation plan §6.2).
 */

/** Domains prefixed to a JCS payload before SHA-256. */
export const HASH_DOMAINS = {
  /** Ordered eligibility pool root (design v2 §15). */
  POOL_ROOT: "ERL2-POOL-ROOT-V2",
  /** Per-entry salted hiding commitment over the exact challenge/persona/journey. */
  POOL_ACTOR_JOURNEY: "ERL2-POOL-ACTOR-JOURNEY-V1",
  /** Lab-derived randomness request binding; never sent to or signed by the beacon. */
  RANDOMNESS_REQUEST: "ERL2-RANDOMNESS-REQUEST-V1",
  /** Canonical beacon round/output payload the beacon itself authenticates. */
  BEACON_ROUND_PAYLOAD: "ERL2-BEACON-ROUND-PAYLOAD-V1",
  /** Lifecycle event chain link. */
  LIFECYCLE_EVENT: "ERL2-LIFECYCLE-EVENT-V1",
  /** Append-only access-log head. */
  ACCESS_LOG: "ERL2-ACCESS-LOG-V1",
  /** Threshold decryption share receipt. */
  DECRYPTION_SHARE_RECEIPT: "ERL2-DECRYPTION-SHARE-V1",
  /** Sorted artifact-ref tree hash. */
  TREE: "ERL2-TREE-V1",
  /** Resource frontier snapshot used by emergency cleanup. */
  RESOURCE_FRONTIER: "ERL2-RESOURCE-FRONTIER-V1",
  /** Run-scoped environment resource identity (design v2 §22). */
  RESOURCE_IDENTITY: "ERL2-RESOURCE-IDENTITY-V1",
  /** Clean-control baseline fingerprint over ordered probe observations. */
  BASELINE_FINGERPRINT: "ERL2-BASELINE-FINGERPRINT-V1",
  /** Environment driver operation state, before and after. */
  DRIVER_STATE: "ERL2-DRIVER-STATE-V1",
  /** Threshold envelope AEAD associated data. */
  THRESHOLD_ENVELOPE_AAD: "ERL2-THRESHOLD-ENVELOPE-V1",
  /** Per-custodian share wrapping. */
  THRESHOLD_SHARE_KDF: "ERL2-THRESHOLD-SHARE-KDF-V1",
} as const;

/** Domains prefixed to an ASCII core hash before Ed25519 signing. */
export const SIGNATURE_DOMAINS = {
  /** V2 default signing domain. */
  ERL2: "ERL2-SIGN-V1",
  /** Retained revision-0.9.8 domain; byte-compatible V1 contracts keep it. */
  LEGACY_V1: "ERL-SIGN-V1",
  /** Lab/verifier beacon-association wrapper (design v2 §15). */
  BEACON_ASSOCIATION: "ERL2-BEACON-ASSOCIATION-V1",
  /** Threshold reveal custodian signatures. */
  THRESHOLD_REVEAL: "ERL2-THRESHOLD-REVEAL-V1",
  /** Customer T4 attestation role signatures. */
  CUSTOMER_ATTEST: "ERL2-CUSTOMER-ATTEST-V1",
} as const;

/** HMAC domains. */
export const HMAC_DOMAINS = {
  /** Selection seed derivation (design v2 §15). */
  SELECT: "ERL2-SELECT-V2",
  /** Rejection-sampling block expansion for the selection index (ADR-ERL2-011). */
  SELECT_INDEX: "ERL2-SELECT-INDEX-V2",
} as const;

export type HashDomain = (typeof HASH_DOMAINS)[keyof typeof HASH_DOMAINS];
export type SignatureDomain = (typeof SIGNATURE_DOMAINS)[keyof typeof SIGNATURE_DOMAINS];
export type HmacDomain = (typeof HMAC_DOMAINS)[keyof typeof HMAC_DOMAINS];

const ALL_DOMAINS: ReadonlySet<string> = new Set<string>([
  ...Object.values(HASH_DOMAINS),
  ...Object.values(SIGNATURE_DOMAINS),
  ...Object.values(HMAC_DOMAINS),
]);

export function isRegisteredDomain(domain: string): boolean {
  return ALL_DOMAINS.has(domain);
}

export function assertRegisteredDomain(domain: string): void {
  if (!isRegisteredDomain(domain)) {
    throw new Error(`unregistered separation domain: ${domain}`);
  }
}

/** Every registered domain string, sorted; used by the domain-registry test. */
export function registeredDomains(): readonly string[] {
  return [...ALL_DOMAINS].sort();
}
