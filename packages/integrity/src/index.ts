/**
 * `@erl2/integrity` — the single implementation of canonical bytes, identity,
 * artifact publication, signatures, trust and timestamp ordering.
 *
 * Depends only on `@erl2/contracts` (implementation plan §4.1).
 */

export {
  jcs,
  jcsBytes,
  CanonicalizationError,
  isCanonicalizableNumber,
  isCanonicalizableString,
} from "./canonical/jcs.js";
export {
  HASH_DOMAINS,
  SIGNATURE_DOMAINS,
  HMAC_DOMAINS,
  isRegisteredDomain,
  assertRegisteredDomain,
  registeredDomains,
  type HashDomain,
  type SignatureDomain,
  type HmacDomain,
} from "./hash/domains.js";
export {
  sha256Hex,
  toHash,
  hashBytes,
  hashHexOf,
  hashesEqual,
  coreOf,
  coreHash,
  seal,
  domainHash,
  domainHashBytes,
  domainHmac,
  treeHash,
} from "./hash/hash.js";
export {
  assertLogicalPath,
  resolveConfined,
  ensureConfinedParent,
  type ConfinedPathOptions,
} from "./artifacts/paths.js";
export { ArtifactStore, type FreezeInput, type FreezeMarker } from "./artifacts/store.js";
export {
  signedMessage,
  signCoreHash,
  signForeignDomain,
  sealSigned,
  verifySignature,
  verifySealed,
  publicKeyToPem,
  publicKeyFromPem,
  developmentKey,
  type SigningKey,
} from "./signatures/ed25519.js";
export {
  TrustEvaluator,
  type LocalTrustConfiguration,
  type LocalRandomnessSourceEntry,
  type TrustVerdict,
  type SignerRole,
} from "./trust/trust.js";
export {
  assertAnchors,
  assertNotSelfAnchoring,
  assertArtifactDoesNotEmbedCheckpoint,
  anchoredAt,
  verifyCheckpointChain,
  assertStrictlyBefore,
  type CheckpointTarget,
} from "./timestamps/checkpoints.js";
export {
  ageEncrypt,
  ageDecrypt,
  ageRecipientOf,
  developmentAgeIdentity,
  AgeError,
  type AgeIdentity,
  type AgeRecipient,
} from "./encryption/age.js";
export {
  sealThresholdEnvelope,
  openThresholdEnvelope,
  releaseShare,
  parseEnvelope,
  shamirSplit,
  shamirCombine,
  padToFixed,
  unpadFixed,
  developmentCustodian,
  type ThresholdEnvelopeV1,
  type WrappedShare,
  type ShamirShare,
  type ReleasedShare,
  type CustodianKey,
} from "./threshold/envelope.js";
