/**
 * Verifier-side derivation of the V2 selection chain (design §8.5, Slice 6.5-A
 * §15.1).
 *
 * The environment offline verifier must reach `verifySelectionChain` with
 * evidence it assembled **itself**. A producer-supplied array of "here are my
 * selection artifacts" would let a run nominate which artifacts get verified,
 * which is the whole attack: a bundle could retain a complete, well-formed
 * chain and simply not list the member that contradicts it.
 *
 * So every member here is resolved from the retained set by its *contract
 * identity*, then cross-checked against the role the run's own lifecycle
 * recorded. A member the index cannot produce, or produces twice, is a refusal
 * rather than a choice.
 *
 * ## The three checkpoints
 *
 * `trusted-timestamp-checkpoint/v1` appears three times in a selection — over
 * the pool manifest, the commitment and the selected binding — and nothing in
 * the contract says which is which. Reading a producer's label would defeat the
 * point, so each is identified by **what it anchors**: the checkpoint whose
 * entries include the pool manifest's core hash *is* the pool checkpoint. A
 * producer that swapped two checkpoints would have to swap what they anchor,
 * which the timestamp layer already refuses.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertContract,
  CODES,
  Erl2Error,
  parseStrictJson,
  type BeaconInclusionProofV1,
  type BeaconSignatureProofV1,
  type EligibilityPoolEntryV2,
  type EligibilityPoolManifestV2,
  type ExternalBeaconRandomnessPolicyV1,
  type ExternalBeaconRandomnessReceiptV1,
  type Hash,
  type LabLifecycleEventV1,
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
import { coreHash } from "@erl2/integrity";
import type { ArtifactIndex, IndexedArtifact } from "./artifactIndex.js";

/** Every member the chain verifier consumes, minus the receipt-only wrapper. */
export interface DerivedSelectionEvidence {
  readonly request: SelectionRequestV2;
  readonly roleAudit: SelectionRoleSeparationAuditV1;
  readonly policy: ExternalBeaconRandomnessPolicyV1;
  readonly poolManifest: EligibilityPoolManifestV2;
  readonly poolEntries: readonly EligibilityPoolEntryV2[];
  readonly poolCheckpoint: TrustedTimestampCheckpointV1;
  readonly randomnessReceipt: ExternalBeaconRandomnessReceiptV1;
  readonly beaconSignatureProof: BeaconSignatureProofV1;
  readonly beaconInclusionProof: BeaconInclusionProofV1;
  readonly sourceTrustReport: RandomnessSourceTrustVerificationReportV1;
  readonly commitment: SelectionCommitmentV2;
  readonly commitmentCheckpoint: TrustedTimestampCheckpointV1;
  readonly thresholdRevealReceipt: ThresholdRevealReceiptV1;
  readonly binding: SelectedChallengeJourneyBindingV1;
  readonly bindingCheckpoint: TrustedTimestampCheckpointV1;
  readonly proof: SelectionProofV2;
  readonly receipt: SelectionVerificationReceiptV2;
}

/**
 * The lifecycle role each singleton member must have been recorded under.
 *
 * This is the cross-check that the retained set and the run's own history agree.
 * An artifact present in `retained/` that the lifecycle never recorded producing
 * is not selection evidence — it is an extra, and the closure's rejected-extra
 * rule owns it.
 */
const SINGLETON_ROLES: Readonly<Record<string, string>> = {
  "selection-request/v2": "selection-request",
  "selection-role-separation-audit/v1": "selection-role-separation-audit",
  "external-beacon-randomness-policy/v1": "selection-randomness-policy",
  "eligibility-pool-manifest/v2": "eligibility-pool-manifest",
  "external-beacon-randomness-receipt/v1": "selection-randomness-receipt",
  "randomness-source-trust-verification-report/v1": "randomness-source-trust-report",
  "selection-commitment/v2": "selection-commitment",
  "threshold-reveal-receipt/v1": "threshold-reveal-receipt",
  "selected-challenge-journey-binding/v1": "selected-challenge-journey-binding",
  "selection-proof/v2": "selection-proof",
  "selection-verification-receipt/v2": "selection-verification-receipt",
};

/** Core hashes the lifecycle recorded under `role`, in event order. */
function recordedForRole(lifecycle: readonly LabLifecycleEventV1[], role: string): readonly Hash[] {
  const out: Hash[] = [];
  for (const event of lifecycle) {
    for (const produced of event.produced ?? []) {
      if (produced.artifact_role === role) out.push(produced.artifact_core_hash);
    }
  }
  return out;
}

/**
 * The one retained artifact of `schemaVersion`, cross-checked against the role
 * the lifecycle recorded. Absent, duplicated or unrecorded is a refusal.
 */
function singleton<T>(
  index: ArtifactIndex,
  lifecycle: readonly LabLifecycleEventV1[],
  schemaVersion: string,
): T {
  // Counted over retained *files*, not `ofSchema`. `ofSchema` iterates the
  // core-hash map, so a byte-copy of a member is invisible to it — the same
  // shadowing that let a forged signature ride in before the index grew a
  // per-file view. "Exactly one" has to mean one file.
  const found = index.retainedFiles().filter((a) => a.schemaVersion === schemaVersion);
  if (found.length === 0) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_UNREACHABLE_ARTIFACT,
      `the selection chain requires a retained ${schemaVersion}; none is retained`,
    );
  }
  if (found.length > 1) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      `${String(found.length)} retained ${schemaVersion} artifacts; the selection chain admits exactly one`,
    );
  }
  const artifact = found[0] as IndexedArtifact;
  const role = SINGLETON_ROLES[schemaVersion];
  if (role !== undefined) {
    const recorded = recordedForRole(lifecycle, role);
    if (!recorded.includes(artifact.coreHash)) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_UNREACHABLE_ARTIFACT,
        `retained ${schemaVersion} was never recorded by the lifecycle under ${role}`,
      );
    }
  }
  return artifact.value as T;
}

/**
 * The checkpoint that anchors `targetHash`.
 *
 * Identified by what it anchors, never by ordering or a producer label, so two
 * checkpoints cannot be swapped without also swapping their entries.
 */
function checkpointAnchoring(
  checkpoints: readonly IndexedArtifact[],
  targetHash: Hash,
  label: string,
): TrustedTimestampCheckpointV1 {
  const matches = checkpoints.filter((candidate) => {
    const value = candidate.value as unknown as TrustedTimestampCheckpointV1;
    return value.entries.some((entry) => entry.artifact_core_hash === targetHash);
  });
  if (matches.length === 0) {
    throw new Erl2Error(
      CODES.TIMESTAMP_TARGET_MISSING,
      `no retained checkpoint anchors the ${label} (${targetHash})`,
    );
  }
  if (matches.length > 1) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      `${String(matches.length)} retained checkpoints anchor the ${label}; exactly one may`,
    );
  }
  return (matches[0] as IndexedArtifact).value as unknown as TrustedTimestampCheckpointV1;
}

/**
 * The two beacon proofs, resolved through the refs the randomness receipt names.
 *
 * They carry no `schema_version` and no `core_hash`, so the artifact index skips
 * them: they are PUBLIC wire blobs, not Lab artifacts. The receipt names their
 * paths and declares their digests, and `verifyReferencedBytes` has already
 * rehashed both from disk — so resolving them here reads bytes whose integrity
 * the closure already established, rather than trusting a second copy.
 */
function beaconProofs(
  index: ArtifactIndex,
  receipt: ExternalBeaconRandomnessReceiptV1,
): { readonly signature: BeaconSignatureProofV1; readonly inclusion: BeaconInclusionProofV1 } {
  const read = (ref: { path: string }, contract: string, label: string): unknown => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path.join(index.root, ref.path));
    } catch {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_UNREACHABLE_ARTIFACT,
        `the randomness receipt references a ${label} at ${ref.path}, which is not retained`,
      );
    }
    return assertContract(contract, parseStrictJson(bytes.toString("utf8")) as Record<string, unknown>);
  };
  return {
    signature: read(
      receipt.beacon_signature_proof,
      "BeaconSignatureProofV1",
      "beacon signature proof",
    ) as BeaconSignatureProofV1,
    inclusion: read(
      receipt.beacon_inclusion_proof,
      "BeaconInclusionProofV1",
      "beacon inclusion proof",
    ) as BeaconInclusionProofV1,
  };
}

/**
 * Assembles the selection chain from retained evidence alone.
 *
 * Ordering note: the pool entries are taken in the **manifest's** declared
 * order, not the index's. The ordered entry list is what the pool root commits
 * to, so reading the directory instead would let a reordered pool verify against
 * a root it does not produce.
 */
export function deriveSelectionEvidence(
  index: ArtifactIndex,
  lifecycle: readonly LabLifecycleEventV1[],
): DerivedSelectionEvidence {
  const poolManifest = singleton<EligibilityPoolManifestV2>(
    index,
    lifecycle,
    "eligibility-pool-manifest/v2",
  );
  const commitment = singleton<SelectionCommitmentV2>(index, lifecycle, "selection-commitment/v2");
  const binding = singleton<SelectedChallengeJourneyBindingV1>(
    index,
    lifecycle,
    "selected-challenge-journey-binding/v1",
  );

  const retainedEntryFiles = index
    .retainedFiles()
    .filter((a) => a.schemaVersion === "eligibility-pool-entry/v2");
  const retainedEntries = new Map<Hash, EligibilityPoolEntryV2>();
  for (const artifact of retainedEntryFiles) {
    retainedEntries.set(artifact.coreHash, artifact.value as unknown as EligibilityPoolEntryV2);
  }
  const poolEntries = poolManifest.ordered_entry_hashes.map((entryHash) => {
    const entry = retainedEntries.get(entryHash);
    if (entry === undefined) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_UNREACHABLE_ARTIFACT,
        `the pool manifest orders entry ${entryHash}, which is not retained`,
      );
    }
    return entry;
  });
  // Compared over files, so a duplicated entry counts even though it shares a
  // core hash with the one the manifest orders.
  if (retainedEntryFiles.length !== poolEntries.length) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      `${String(retainedEntryFiles.length)} retained pool entry files but the manifest orders ` +
        `${String(poolEntries.length)}; an unordered or duplicated entry is an extra`,
    );
  }

  const randomnessReceipt = singleton<ExternalBeaconRandomnessReceiptV1>(
    index,
    lifecycle,
    "external-beacon-randomness-receipt/v1",
  );
  const proofs = beaconProofs(index, randomnessReceipt);
  const checkpoints = index
    .retainedFiles()
    .filter((a) => a.schemaVersion === "trusted-timestamp-checkpoint/v1");
  return {
    request: singleton<SelectionRequestV2>(index, lifecycle, "selection-request/v2"),
    roleAudit: singleton<SelectionRoleSeparationAuditV1>(
      index,
      lifecycle,
      "selection-role-separation-audit/v1",
    ),
    policy: singleton<ExternalBeaconRandomnessPolicyV1>(
      index,
      lifecycle,
      "external-beacon-randomness-policy/v1",
    ),
    poolManifest,
    poolEntries,
    poolCheckpoint: checkpointAnchoring(checkpoints, coreHash(poolManifest), "eligibility pool manifest"),
    randomnessReceipt,
    beaconSignatureProof: proofs.signature,
    beaconInclusionProof: proofs.inclusion,
    sourceTrustReport: singleton<RandomnessSourceTrustVerificationReportV1>(
      index,
      lifecycle,
      "randomness-source-trust-verification-report/v1",
    ),
    commitment,
    commitmentCheckpoint: checkpointAnchoring(checkpoints, coreHash(commitment), "selection commitment"),
    thresholdRevealReceipt: singleton<ThresholdRevealReceiptV1>(
      index,
      lifecycle,
      "threshold-reveal-receipt/v1",
    ),
    binding,
    bindingCheckpoint: checkpointAnchoring(checkpoints, coreHash(binding), "selected binding"),
    proof: singleton<SelectionProofV2>(index, lifecycle, "selection-proof/v2"),
    receipt: singleton<SelectionVerificationReceiptV2>(
      index,
      lifecycle,
      "selection-verification-receipt/v2",
    ),
  };
}

/**
 * Refuses any selection artifact in a **pre-environment** closure.
 *
 * The pre-environment terminal has no selection, so retaining one is a category
 * error rather than a partial chain — and it stays refused independently of the
 * signed-member table (ADR-ERL2-019 §2), which would otherwise be the only gate.
 */
export const SELECTION_SCHEMAS: readonly string[] = [
  ...Object.keys(SINGLETON_ROLES),
  "eligibility-pool-entry/v2",
  "journey-selection-policy/v1",
];

export function assertNoSelectionArtifacts(index: ArtifactIndex): void {
  for (const schemaVersion of SELECTION_SCHEMAS) {
    const found = index.retainedFiles().filter((a) => a.schemaVersion === schemaVersion);
    if (found.length > 0) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
        `a pre-environment terminal retains ${schemaVersion}, which belongs to the environment branch`,
      );
    }
  }
}
