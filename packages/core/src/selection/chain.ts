/**
 * The V2 selection chain, executed in the one legal order (design v2 §12/§15):
 *
 *   role audit → ordered pool → pool checkpoint → first finalized beacon round
 *   → Lab/verifier association wrapper → source-trust report → commitment
 *   → commitment checkpoint → threshold reveal → selected binding
 *   → binding checkpoint → proof → verification receipt
 *
 * Nothing in this module may be reordered without breaking an assertion: each
 * step consumes the frozen hash of its predecessor, and each checkpoint anchors
 * an artifact that already exists.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type EligibilityPoolManifestV2,
  type ExternalBeaconRandomnessPolicyV1,
  type ExternalBeaconRandomnessReceiptV1,
  type Hash,
  type RandomnessSourceTrustVerificationReportV1,
  type SelectedChallengeJourneyBindingV1,
  type SelectionCommitmentV2,
  type SelectionProofV2,
  type SelectionRequestV2,
  type SelectionRoleSeparationAuditV1,
  type SelectionVerificationReceiptV2,
  type ThresholdRevealReceiptV1,
  type TrustedTimestampCheckpointV1,
} from "@erl2/contracts";
import {
  ArtifactStore,
  assertAnchors,
  assertArtifactDoesNotEmbedCheckpoint,
  coreHash,
  domainHash,
  HASH_DOMAINS,
  openThresholdEnvelope,
  parseEnvelope,
  releaseShare,
  sealSigned,
  signCoreHash,
  SIGNATURE_DOMAINS,
  type CustodianKey,
  type SigningKey,
  type TrustEvaluator,
} from "@erl2/integrity";
import type { Clock } from "../runtime/seams.js";
import type { TimestampLog } from "../timestamps/log.js";
import {
  assertActiveRandomnessReceiptVariant,
  assertActiveRandomnessVariant,
  assertWrapperOwnership,
  proofBytes,
  verifyBeaconNativeProof,
  type BeaconSource,
} from "./beacon.js";
import { assertDevelopmentTierOnly } from "./developmentBeacon.js";
import { deriveSelectedIndex, hidingCommitment, poolRootOf, sourceRequestBindingHash } from "./derive.js";
import type { BuiltPoolEntry } from "./pool.js";

/**
 * The pool as the chain stages consume it.
 *
 * Deliberately narrower than `BuiltPool`: the stages touch only the manifest and
 * each entry's `entry` / `entryHash` / `envelopeLogicalPath`. The build-time
 * extras (`openingNonceBase64`, `candidate`) are vault-only and never leave the
 * pool builder.
 *
 * The narrowing is what makes resume honest. `buildEligibilityPool` draws
 * randomness for opening nonces and envelope encryption, so rebuilding a pool
 * after a crash would produce *different* entries and silently select a
 * different challenge. A resumed run therefore LOADS its pool from retained
 * evidence, and this type is exactly what can be reconstructed from it.
 */
export interface SelectionPoolEntry {
  readonly entry: BuiltPoolEntry["entry"];
  readonly entryHash: Hash;
  readonly envelopeLogicalPath: string;
}

export interface SelectionPool {
  readonly manifest: EligibilityPoolManifestV2;
  readonly manifestHash: Hash;
  readonly entries: readonly SelectionPoolEntry[];
}
import {
  assertSelectionPreconditions,
  stageBinding,
  stageBindingCheckpoint,
  stageCommitment,
  stageCommitmentCheckpoint,
  stagePoolCheckpoint,
  stageProof,
  stageRandomness,
  stageReceipt,
  stageReveal,
  stageSourceTrust,
  type SelectionProgress,
} from "./stages.js";

export interface SelectionChainKeys {
  readonly selector: SigningKey;
  /** Lab/verifier signer of the beacon-association wrapper. */
  readonly wrapperSigner: SigningKey;
  readonly sourceTrustVerifier: SigningKey;
  readonly revealAuthority: SigningKey;
  readonly verifier: SigningKey;
  readonly custodians: readonly CustodianKey[];
  /** Ed25519 keys the custodians use to sign the threshold reveal receipt. */
  readonly custodianSigners: readonly SigningKey[];
}

export interface RunSelectionOptions {
  readonly runId: string;
  readonly request: SelectionRequestV2;
  readonly requestHash: Hash;
  /**
   * The role-separation audit the pool was built under.
   *
   * Carried explicitly because the auditor's independent re-derivation
   * (ADR-ERL2-020 §7) verifies it directly; the chain previously saw it only
   * indirectly, through the hash the pool manifest records.
   */
  readonly roleAudit: SelectionRoleSeparationAuditV1;
  readonly policy: ExternalBeaconRandomnessPolicyV1;
  readonly policyHash: Hash;
  readonly pool: SelectionPool;
  readonly beacon: BeaconSource;
  readonly trust: TrustEvaluator;
  readonly timestamps: TimestampLog;
  readonly store: ArtifactStore;
  readonly clock: Clock;
  readonly keys: SelectionChainKeys;
  readonly accessLogHeadHash: Hash;
  readonly revealThreshold: number;
}

export interface SelectionChainResult {
  readonly poolCheckpoint: TrustedTimestampCheckpointV1;
  readonly randomnessReceipt: ExternalBeaconRandomnessReceiptV1;
  readonly sourceTrustReport: RandomnessSourceTrustVerificationReportV1;
  readonly commitment: SelectionCommitmentV2;
  readonly commitmentCheckpoint: TrustedTimestampCheckpointV1;
  readonly thresholdRevealReceipt: ThresholdRevealReceiptV1;
  readonly binding: SelectedChallengeJourneyBindingV1;
  readonly bindingCheckpoint: TrustedTimestampCheckpointV1;
  readonly proof: SelectionProofV2;
  readonly receipt: SelectionVerificationReceiptV2;
  readonly selectedEntry: SelectionPoolEntry;
}

const TRUE = true as const;

/**
 * The whole chain, in memory, as a **fold over the durable stages**
 * (ADR-ERL2-020 §6).
 *
 * This entry point exists for the known-answer and adversarial suites, which
 * need the complete chain in one call. It deliberately holds no logic of its
 * own: every artifact is produced by the same `stages.ts` function the CLI's
 * durable, resumable walk invokes, so the producer under test and the producer
 * that ships cannot drift apart.
 *
 * A caller that must survive a crash must NOT use this — it observes the beacon
 * and releases custodian shares with no durable record between the steps. Drive
 * the stages individually and freeze after each.
 */
export function runSelectionChain(options: RunSelectionOptions): SelectionChainResult {
  assertSelectionPreconditions(options);

  let progress: SelectionProgress = {};
  const advance = (next: Partial<SelectionProgress>): void => {
    progress = { ...progress, ...next };
  };

  advance({ poolCheckpoint: stagePoolCheckpoint(options) });
  advance(stageRandomness(options, progress));
  advance({ sourceTrustReport: stageSourceTrust(options, progress) });
  advance(stageCommitment(options, progress));
  advance({ commitmentCheckpoint: stageCommitmentCheckpoint(options, progress) });
  advance({ thresholdRevealReceipt: stageReveal(options, progress) });
  advance(stageBinding(options, progress));
  advance({ bindingCheckpoint: stageBindingCheckpoint(options, progress) });
  advance({ proof: stageProof(options, progress) });
  const receipt = stageReceipt(options, progress);

  return {
    poolCheckpoint: progress.poolCheckpoint as TrustedTimestampCheckpointV1,
    randomnessReceipt: progress.randomnessReceipt as ExternalBeaconRandomnessReceiptV1,
    sourceTrustReport: progress.sourceTrustReport as RandomnessSourceTrustVerificationReportV1,
    commitment: progress.commitment as SelectionCommitmentV2,
    commitmentCheckpoint: progress.commitmentCheckpoint as TrustedTimestampCheckpointV1,
    thresholdRevealReceipt: progress.thresholdRevealReceipt as ThresholdRevealReceiptV1,
    binding: progress.binding as SelectedChallengeJourneyBindingV1,
    bindingCheckpoint: progress.bindingCheckpoint as TrustedTimestampCheckpointV1,
    proof: progress.proof as SelectionProofV2,
    receipt,
    selectedEntry: progress.selectedEntry as SelectionPoolEntry,
  };
}

export type { EligibilityPoolManifestV2 };
