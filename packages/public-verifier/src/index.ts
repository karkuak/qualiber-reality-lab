/**
 * `@erl2/public-verifier` — the neutral, offline consumer library.
 *
 * Depends on `@erl2/contracts`, `@erl2/integrity` and the lifecycle-chain
 * verifier in `@erl2/core`.  It never reaches vault plaintext or mutable remote
 * registry state.
 */

export { ArtifactIndex, type IndexedArtifact } from "./library/artifactIndex.js";
export {
  verifyReferencedBytes,
  collectReferencedDescriptors,
  type ReferencedByteReport,
  type Descriptor,
} from "./library/referencedBytes.js";
export {
  verifySignedMembers,
  type SignedMemberOptions,
  type SignedMemberReport,
} from "./library/signedMembers.js";
export {
  verifyRetainedFileAccounting,
  type RetainedAccountingReport,
} from "./library/retainedFiles.js";
export {
  derivePreEnvironmentClosure,
  derivePreFinalizationClosure,
  deriveInvalidClosure,
  assertEmergencyActionEvidence,
  type ClosureInput,
  type DerivedRole,
  type PreFinalizationVerdict,
} from "./library/closure.js";
export {
  deriveEnvironmentClosure,
  deriveEnvironmentClosureProgress,
  deriveEnvironmentPreFinalizationClosure,
  deriveEnvironmentTerminalStage,
  deriveTerminalVariant,
  type EnvironmentPreFinalizationVerdict,
} from "./library/environmentClosure.js";
export {
  assertCleanupApplicable,
  assertSubstrateBindingConsistent,
  deriveEmergencyCleanup,
  deriveEnvironmentSemantics,
  deriveInvalidEnvironmentSemantics,
  deriveRestorationOutcome,
  deriveTeardownOutcome,
  deriveValidityOutcome,
  type EnvironmentSemanticReport,
  type SubstrateBindingReport,
} from "./library/environmentDerivation.js";
export {
  assertClaimScopeWithinCeiling,
  claimScopeExceeds,
  claimScopeRank,
  combineClaimScopeComponents,
  deriveClaimCeiling,
  MAX_BASE_CLAIM_SCOPE,
  type ClaimCeilingReport,
  type ClaimScopeComponent,
  type DeriveClaimCeilingOptions,
} from "./library/claimScope.js";
export {
  verifyPublicBundle,
  verifyInvalidRecord,
  VERIFIER_RELEASE_HASH,
  type VerifyBundleOptions,
  type VerifyRecordOptions,
  type BundleVerificationResult,
} from "./library/verify.js";
export {
  deriveSelectionEvidence,
  assertNoSelectionArtifacts,
  SELECTION_SCHEMAS,
  type DerivedSelectionEvidence,
} from "./library/selectionEvidence.js";
