/**
 * Canonical evidence envelopes and the translation boundary
 * (design v2 §10/§13, ERL2-FR-016/021, ERL2-AC-024).
 *
 * Two non-interchangeable comparison modes:
 *
 *   - `replay_comparison` is **development-only and non-blind**. One immutable
 *     `ReplayCanonicalEvidenceEnvelopeV1` is bound by every replay run, and its
 *     exact bytes, tree hash and core hash are identical across subjects. Only
 *     this mode can satisfy the byte-identity architecture proof.
 *   - `live_ecosystem` is blind-capable. Each independently instantiated
 *     environment produces its own envelope; equivalence is *semantic*,
 *     independently verified, and can never be reported as byte equality.
 *
 * In either mode the envelope is Lab-owned. An adapter writes only a new
 * translated tree and returns a total-coverage receipt; it can never rewrite or
 * replace the canonical envelope.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type AdapterTranslationReceiptV1,
  type ArtifactRef,
  type CanonicalSubjectEvidenceEnvelopeV1,
  type ComparisonPolicyV1,
  type Hash,
  type Instant,
  type LiveCanonicalEvidenceEnvelopeV1,
  type ReplayCanonicalEvidenceEnvelopeV1,
  type SemanticEvidenceEquivalenceReceiptV1,
  type SourceState,
  type Tier,
} from "@erl2/contracts";
import { coreHash, treeHash } from "@erl2/integrity";

export interface CanonicalEntryInput {
  readonly entryId: string;
  readonly sourceContentHash: Hash;
  readonly artifact: ArtifactRef;
  readonly sourceState: SourceState;
}

export interface UnsupportedDescriptorInput {
  readonly entryId: string;
  readonly evidenceKind: string;
  readonly reasonCode: string;
}

/**
 * A replay request must be development tier and non-blind; a held-out or blind
 * request carrying replay mode is refused before pool construction.
 */
export function assertComparisonModeAdmissible(policy: ComparisonPolicyV1, tier: Tier): void {
  if (policy.mode === "replay_comparison") {
    if (tier !== "development") {
      throw new Erl2Error(
        CODES.COMPARISON_MODE_REPLAY_IN_BLIND_TIER,
        `replay comparison is development-only; requested tier is ${tier}`,
      );
    }
    if (policy.selection_eligibility !== "development_only_non_blind") {
      throw new Erl2Error(
        CODES.COMPARISON_MODE_TIER_MISMATCH,
        "replay comparison must declare development_only_non_blind eligibility",
      );
    }
    return;
  }
  if (policy.selection_eligibility !== "blind_capable") {
    throw new Erl2Error(
      CODES.COMPARISON_MODE_TIER_MISMATCH,
      "live ecosystem comparison must declare blind_capable eligibility",
    );
  }
}

export interface BuildReplayEnvelopeOptions {
  readonly comparisonId: string;
  readonly genericRunPolicyHash: Hash;
  readonly challengeHash: Hash;
  readonly evidencePolicyHash: Hash;
  readonly cutoffEvidenceSetHash: Hash;
  readonly entries: readonly CanonicalEntryInput[];
  readonly unsupported?: readonly UnsupportedDescriptorInput[];
  readonly frozenAt: Instant;
}

/**
 * Builds the comparison-level replay envelope.
 *
 * It deliberately carries no run, package, adapter, plan or run-local snapshot
 * identity, which is exactly what lets its bytes be identical across subjects.
 */
export function buildReplayEnvelope(
  options: BuildReplayEnvelopeOptions,
): ReplayCanonicalEvidenceEnvelopeV1 {
  const entries = normalizeEntries(options.entries);
  const base = {
    schema_version: "replay-canonical-evidence-envelope/v1" as const,
    comparison_id: options.comparisonId,
    mode: "replay_comparison" as const,
    generic_run_policy_hash: options.genericRunPolicyHash,
    challenge_hash: options.challengeHash,
    evidence_policy_hash: options.evidencePolicyHash,
    cutoff_evidence_set_hash: options.cutoffEvidenceSetHash,
    entries,
    unsupported_descriptors: normalizeUnsupported(options.unsupported ?? []),
    tree_hash: treeHash(entries.map((e) => e.artifact)),
    frozen_at: options.frozenAt,
  };
  return assertContract<ReplayCanonicalEvidenceEnvelopeV1>(
    "ReplayCanonicalEvidenceEnvelopeV1",
    { ...base, core_hash: coreHash(base) },
  );
}

export interface BuildLiveEnvelopeOptions extends BuildReplayEnvelopeOptions {
  readonly runId: string;
  readonly equivalenceProfileHash: Hash;
  readonly semanticProjectionHash: Hash;
}

export function buildLiveEnvelope(
  options: BuildLiveEnvelopeOptions,
): LiveCanonicalEvidenceEnvelopeV1 {
  const entries = normalizeEntries(options.entries);
  const base = {
    schema_version: "live-canonical-evidence-envelope/v1" as const,
    run_id: options.runId,
    comparison_id: options.comparisonId,
    mode: "live_ecosystem" as const,
    generic_run_policy_hash: options.genericRunPolicyHash,
    challenge_hash: options.challengeHash,
    evidence_policy_hash: options.evidencePolicyHash,
    equivalence_profile_hash: options.equivalenceProfileHash,
    semantic_projection_hash: options.semanticProjectionHash,
    entries,
    unsupported_descriptors: normalizeUnsupported(options.unsupported ?? []),
    tree_hash: treeHash(entries.map((e) => e.artifact)),
    frozen_at: options.frozenAt,
  };
  return assertContract<LiveCanonicalEvidenceEnvelopeV1>(
    "LiveCanonicalEvidenceEnvelopeV1",
    { ...base, core_hash: coreHash(base) },
  );
}

function normalizeEntries(entries: readonly CanonicalEntryInput[]) {
  const sorted = [...entries].sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  const seen = new Set<string>();
  for (const entry of sorted) {
    if (seen.has(entry.entryId)) {
      throw new Erl2Error(CODES.TRANSLATION_ENTRY_DUPLICATED, `duplicate envelope entry ${entry.entryId}`);
    }
    seen.add(entry.entryId);
  }
  return sorted.map((e) => ({
    entry_id: e.entryId,
    source_content_hash: e.sourceContentHash,
    artifact: e.artifact,
    source_state: e.sourceState,
  }));
}

function normalizeUnsupported(items: readonly UnsupportedDescriptorInput[]) {
  return [...items]
    .sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0))
    .map((u) => ({ entry_id: u.entryId, evidence_kind: u.evidenceKind, reason_code: u.reasonCode }));
}

/**
 * Byte identity across replay runs. This is the only equality the architecture
 * proof may cite (ERL2-AC-010).
 */
export function assertReplayEnvelopesIdentical(
  a: ReplayCanonicalEvidenceEnvelopeV1,
  b: ReplayCanonicalEvidenceEnvelopeV1,
): void {
  if (coreHash(a) !== coreHash(b) || a.tree_hash !== b.tree_hash) {
    throw new Erl2Error(
      CODES.COMPARISON_MODE_ENVELOPE_MISMATCH,
      "replay envelopes are not byte-identical across subjects",
    );
  }
}

/**
 * Live runs produce different bytes by construction. Asserting byte equality
 * for them is a false claim and is refused; only the independently verified
 * semantic-equivalence receipt may be cited, and only at its actual status.
 */
export function assertLiveEquivalence(
  receipt: SemanticEvidenceEquivalenceReceiptV1,
  envelopes: readonly LiveCanonicalEvidenceEnvelopeV1[],
): void {
  const hashes = envelopes.map((e) => coreHash(e));
  if (new Set(hashes).size !== hashes.length) {
    throw new Erl2Error(
      CODES.COMPARISON_MODE_LIVE_BYTE_EQUALITY_CLAIMED,
      "two live envelopes are byte-identical, which independent live runs cannot be",
    );
  }
  for (const hash of receipt.live_envelope_hashes) {
    if (!hashes.includes(hash)) {
      throw new Erl2Error(
        CODES.COMPARISON_MODE_ENVELOPE_MISMATCH,
        "equivalence receipt cites an envelope that was not supplied",
      );
    }
  }
  if (receipt.status !== "equivalent") {
    throw new Erl2Error(
      CODES.COMPARISON_MODE_ENVELOPE_MISMATCH,
      `semantic equivalence is ${receipt.status}; it cannot be reported as equivalent`,
    );
  }
}

/**
 * Translation totality: every envelope entry is accounted for exactly once, as
 * `mapped_exact`, `mapped_lossy` or `unsupported`.
 *
 * An adapter may not omit an entry under "domain compatibility", and it may not
 * rewrite the canonical envelope — the receipt's translated tree must differ
 * from the envelope's own tree.
 */
export function assertTranslationTotality(
  receipt: AdapterTranslationReceiptV1,
  envelope: CanonicalSubjectEvidenceEnvelopeV1,
): void {
  if (receipt.canonical_envelope_hash !== coreHash(envelope)) {
    throw new Erl2Error(
      CODES.TRANSLATION_ENVELOPE_REWRITTEN,
      "translation receipt does not reference the frozen canonical envelope",
    );
  }
  if (receipt.translated_tree_hash === envelope.tree_hash) {
    throw new Erl2Error(
      CODES.TRANSLATION_ENVELOPE_REWRITTEN,
      "translated tree is the canonical envelope tree; an adapter may only write a new tree",
    );
  }
  const envelopeIds = envelope.entries.map((e) => e.entry_id);
  const mapped = new Map<string, number>();
  for (const mapping of receipt.mappings) {
    if (!envelopeIds.includes(mapping.entry_id)) {
      throw new Erl2Error(
        CODES.TRANSLATION_UNKNOWN_ENTRY,
        `translation receipt maps unknown entry ${mapping.entry_id}`,
      );
    }
    mapped.set(mapping.entry_id, (mapped.get(mapping.entry_id) ?? 0) + 1);
  }
  for (const [entryId, count] of mapped) {
    if (count > 1) {
      throw new Erl2Error(
        CODES.TRANSLATION_ENTRY_DUPLICATED,
        `entry ${entryId} is accounted for ${String(count)} times`,
      );
    }
  }
  const missing = envelopeIds.filter((id) => !mapped.has(id));
  if (missing.length > 0) {
    throw new Erl2Error(
      CODES.TRANSLATION_ENTRY_OMITTED,
      `translation omits ${String(missing.length)} entry/entries, starting with ${String(missing[0])}`,
    );
  }
  if (receipt.total_input_entries !== envelopeIds.length) {
    throw new Erl2Error(
      CODES.TRANSLATION_ENTRY_OMITTED,
      "translation receipt miscounts the envelope entries",
    );
  }
  if (receipt.accounted_entries !== envelopeIds.length) {
    throw new Erl2Error(
      CODES.TRANSLATION_ENTRY_OMITTED,
      "translation receipt does not account for every envelope entry",
    );
  }
}
