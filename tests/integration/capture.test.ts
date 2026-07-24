/**
 * Capture, cutoff, source states, evidence envelopes and the translation
 * boundary (design v2 §13, ERL2-FR-016/021, ERL2-AC-024).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertContract,
  type ArtifactRef,
  type ComparisonPolicyV1,
  type CutoffPolicyV1,
  type Hash,
  type RuntimeMilestoneV1,
  type SourceState,
  type TrafficProcessStartReceiptV1,
} from "@erl2/contracts";
import { ArtifactStore, coreHash, domainHash, HASH_DOMAINS, sealSigned } from "@erl2/integrity";
import {
  assertComparisonModeAdmissible,
  assertLiveEquivalence,
  assertReplayEnvelopesIdentical,
  assertTranslationTotality,
  buildLiveEnvelope,
  buildReplayEnvelope,
  freezeObservation,
  freezeSourceSnapshot,
  isEligibleAtCutoff,
  realizeCutoff,
} from "@erl2/core";
import { developmentKeyring } from "../support/keys.js";

const keyring = developmentKeyring();
const h = (label: string): Hash => domainHash(HASH_DOMAINS.TREE, { label });

function cutoffPolicy(overrides: Partial<CutoffPolicyV1> = {}): CutoffPolicyV1 {
  const base = {
    schema_version: "cutoff-policy/v1" as const,
    policy_id: "fixture-cutoff",
    version: 1,
    clock: "host_utc" as const,
    instant_rule: "traffic_process_started_at_plus_warmup_ms_plus_observation_ms" as const,
    inclusion: "event_time_lt_and_ingestion_time_lte" as const,
    max_skew_ms: 1000,
    late_arrival_grace_ms: 30_000,
    maximum_selection_to_traffic_start_ms: 600_000,
    maximum_timestamp_submission_delay_ms: 60_000,
    maximum_process_milestone_skew_ms: 60_000,
    maximum_monotonic_wall_divergence_ms: 2000,
    maximum_warmup_ms: 60_000,
    maximum_observation_ms: 600_000,
    minimum_observation_ms: 1000,
    event_time_required: true as const,
    ingestion_time_required: true as const,
    valid_from: "2026-01-01T00:00:00Z",
    valid_until: "2030-01-01T00:00:00Z",
    ...overrides,
  };
  return assertContract<CutoffPolicyV1>("CutoffPolicyV1", sealSigned(base, keyring.policyAuthor));
}

function processStart(): TrafficProcessStartReceiptV1 {
  const base = {
    schema_version: "traffic-process-start-receipt/v1" as const,
    receipt_id: "fixture-process-start",
    run_id: "01890000-0000-7000-8000-000000000001",
    selection_commitment_hash: h("selection-commitment"),
    experiment_manifest_hash: h("challenge-manifest"),
    environment_fingerprint_hash: h("environment-instance"),
    traffic_profile_hash: h("traffic-profile"),
    process_identity_hash: h("process-identity"),
    supervisor_boot_id_hash: h("supervisor-boot"),
    monotonic_clock_domain_hash: h("clock-domain"),
    process_started_at: "2026-07-01T00:10:00Z",
    process_start_monotonic_ms: 1_000_000,
  };
  return assertContract<TrafficProcessStartReceiptV1>(
    "TrafficProcessStartReceiptV1",
    sealSigned(base, keyring.challengeGovernor),
  );
}

function milestone(receipt: TrafficProcessStartReceiptV1, occurredAt: string, monotonic: number): RuntimeMilestoneV1 {
  const base = {
    schema_version: "runtime-milestone/v1" as const,
    milestone_id: "fixture-milestone",
    run_id: receipt.run_id,
    milestone: "traffic_started" as const,
    selection_commitment_hash: receipt.selection_commitment_hash,
    experiment_manifest_hash: receipt.experiment_manifest_hash,
    environment_fingerprint_hash: receipt.environment_fingerprint_hash,
    traffic_profile_hash: receipt.traffic_profile_hash,
    traffic_process_start_receipt_hash: coreHash(receipt),
    monotonic_clock_domain_hash: receipt.monotonic_clock_domain_hash,
    occurred_at: occurredAt,
    monotonic_elapsed_ms: monotonic,
  };
  return assertContract<RuntimeMilestoneV1>(
    "RuntimeMilestoneV1",
    sealSigned(base, keyring.challengeGovernor),
  );
}

test("CUTOFF: the instant derives from the signed process start plus committed durations", () => {
  const policy = cutoffPolicy();
  const receipt = processStart();
  const cutoff = realizeCutoff({
    policy,
    processStartReceipt: receipt,
    runtimeMilestone: milestone(receipt, "2026-07-01T00:10:01Z", 1_001_000),
    warmupMs: 30_000,
    observationMs: 120_000,
  });
  assert.equal(cutoff.instant, "2026-07-01T00:12:30Z");
});

test("CUTOFF: exactly-at-cutoff event time is excluded and grace never widens it", () => {
  const policy = cutoffPolicy();
  const receipt = processStart();
  const cutoff = realizeCutoff({
    policy,
    processStartReceipt: receipt,
    runtimeMilestone: milestone(receipt, "2026-07-01T00:10:01Z", 1_001_000),
    warmupMs: 30_000,
    observationMs: 120_000,
  });
  assert.equal(isEligibleAtCutoff(cutoff, policy, "2026-07-01T00:12:29Z", "2026-07-01T00:12:29Z"), true);
  // Exactly at the cutoff is excluded.
  assert.equal(isEligibleAtCutoff(cutoff, policy, "2026-07-01T00:12:30Z", "2026-07-01T00:12:30Z"), false);
  // Late ingestion within grace is allowed for an eligible event...
  assert.equal(isEligibleAtCutoff(cutoff, policy, "2026-07-01T00:12:29Z", "2026-07-01T00:12:50Z"), true);
  // ...but grace never makes a post-cutoff event eligible.
  assert.equal(isEligibleAtCutoff(cutoff, policy, "2026-07-01T00:12:40Z", "2026-07-01T00:12:50Z"), false);
});

test("CUTOFF: clock divergence and exceeded bounds fail closed", () => {
  const policy = cutoffPolicy();
  const receipt = processStart();
  assert.throws(
    () =>
      realizeCutoff({
        policy,
        processStartReceipt: receipt,
        // Wall says 10s elapsed, monotonic says 1s.
        runtimeMilestone: milestone(receipt, "2026-07-01T00:10:10Z", 1_001_000),
        warmupMs: 30_000,
        observationMs: 120_000,
      }),
    (e: unknown) => (e as { code: string }).code === "CUTOFF_CLOCK_DIVERGENCE",
  );
  assert.throws(
    () =>
      realizeCutoff({
        policy,
        processStartReceipt: receipt,
        runtimeMilestone: milestone(receipt, "2026-07-01T00:10:01Z", 1_001_000),
        warmupMs: 30_000,
        observationMs: 900_000,
      }),
    (e: unknown) => (e as { code: string }).code === "CUTOFF_BOUND_EXCEEDED",
  );
});

test("SOURCE-STATE: all five states are representable and constrained", () => {
  const common = {
    runId: "01890000-0000-7000-8000-000000000001",
    sourceKind: "deployment",
    sourceSchema: "deployment/v1",
    sourceIdentityHash: h("source-identity"),
    queryHash: h("query"),
    window: { from: "2026-07-01T00:00:00Z" as const, to_exclusive: "2026-07-01T00:12:30Z" as const },
    startedAt: "2026-07-01T00:12:31Z" as const,
    endedAt: "2026-07-01T00:12:32Z" as const,
    pages: 1,
    bytes: 128,
    dedupeKey: "id",
    orderingId: "event-time",
    healthRecordHash: h("health"),
  };
  const artifact: ArtifactRef = {
    path: "normalized/records.json",
    media_type: "application/json",
    byte_length: 2,
    file_sha256: h("records"),
    classification: "INTERNAL",
  };

  const states: readonly SourceState[] = ["complete", "healthy_empty", "partial", "unavailable", "error"];
  for (const state of states) {
    const snapshot = freezeSourceSnapshot({
      ...common,
      snapshotId: `snapshot-${state.replaceAll("_", "-")}`,
      sourceId: `source-${state.replaceAll("_", "-")}`,
      state,
      records: state === "healthy_empty" || state === "unavailable" || state === "error" ? 0 : 3,
      ...(state === "unavailable" || state === "error"
        ? { unavailableReasonCode: "SOURCE_TIMEOUT" }
        : state === "healthy_empty"
          ? {}
          : { recordsArtifact: artifact }),
    });
    assert.equal(snapshot.state, state);
    if (state === "unavailable" || state === "error") {
      assert.equal(snapshot.unavailable_reason_code, "SOURCE_TIMEOUT");
      assert.equal(snapshot.records_artifact, undefined);
    }
  }
});

test("SOURCE-STATE: truncation must state its reason", () => {
  const snapshot = freezeSourceSnapshot({
    runId: "01890000-0000-7000-8000-000000000001",
    snapshotId: "snapshot-truncated",
    sourceId: "source-truncated",
    sourceKind: "metric",
    sourceSchema: "metric/v1",
    sourceIdentityHash: h("source-identity"),
    state: "partial",
    queryHash: h("query"),
    window: { from: "2026-07-01T00:00:00Z", to_exclusive: "2026-07-01T00:12:30Z" },
    startedAt: "2026-07-01T00:12:31Z",
    endedAt: "2026-07-01T00:12:32Z",
    pages: 20,
    records: 1000,
    bytes: 4096,
    dedupeKey: "id",
    orderingId: "event-time",
    healthRecordHash: h("health"),
    truncated: { reason: "PAGE_LIMIT_REACHED" },
  });
  assert.equal(snapshot.truncation.truncated, true);
  assert.equal(snapshot.truncation.reason, "PAGE_LIMIT_REACHED");
});

function comparisonPolicy(mode: "replay_comparison" | "live_ecosystem"): ComparisonPolicyV1 {
  const base =
    mode === "replay_comparison"
      ? {
          schema_version: "comparison-policy/v1" as const,
          policy_id: "fixture-replay",
          mode,
          selection_eligibility: "development_only_non_blind" as const,
          replay_envelope_hash: h("replay-envelope"),
        }
      : {
          schema_version: "comparison-policy/v1" as const,
          policy_id: "fixture-live",
          mode,
          selection_eligibility: "blind_capable" as const,
          equivalence_profile_hash: h("equivalence-profile"),
          independent_equivalence_verifier_hash: h("equivalence-verifier"),
        };
  return assertContract<ComparisonPolicyV1>("ComparisonPolicyV1", sealSigned(base, keyring.policyAuthor));
}

test("COMPARISON-MODE: replay is development-only and blind tiers are refused", () => {
  assertComparisonModeAdmissible(comparisonPolicy("replay_comparison"), "development");
  for (const tier of ["held_out", "blind"] as const) {
    assert.throws(
      () => assertComparisonModeAdmissible(comparisonPolicy("replay_comparison"), tier),
      (e: unknown) => (e as { code: string }).code === "COMPARISON_MODE_REPLAY_IN_BLIND_TIER",
    );
  }
  assertComparisonModeAdmissible(comparisonPolicy("live_ecosystem"), "blind");
});

const entryArtifact = (id: string): ArtifactRef => ({
  path: `subject-visible/canonical/${id}.json`,
  media_type: "application/json",
  byte_length: 16,
  file_sha256: h(`entry-${id}`),
  classification: "INTERNAL",
});

function replayEnvelope() {
  return buildReplayEnvelope({
    comparisonId: "fixture-comparison",
    genericRunPolicyHash: h("generic-run-policy"),
    challengeHash: h("challenge"),
    evidencePolicyHash: h("evidence-policy"),
    cutoffEvidenceSetHash: h("cutoff-evidence-set"),
    entries: [
      { entryId: "entry-a", sourceContentHash: h("content-a"), artifact: entryArtifact("a"), sourceState: "complete" },
      { entryId: "entry-b", sourceContentHash: h("content-b"), artifact: entryArtifact("b"), sourceState: "partial" },
    ],
    frozenAt: "2026-07-01T00:13:00Z",
  });
}

test("CANONICAL-EVIDENCE: the replay envelope is byte-identical across independent builds", () => {
  assertReplayEnvelopesIdentical(replayEnvelope(), replayEnvelope());
  // It carries no run, package, adapter or plan identity, which is what makes
  // that possible.
  const text = JSON.stringify(replayEnvelope());
  for (const forbidden of ["run_id", "adapter_hash", "plan_hash", "subject_package_manifest_hash"]) {
    assert.ok(!text.includes(forbidden), `replay envelope carries ${forbidden}`);
  }
});

test("CANONICAL-EVIDENCE: independent live envelopes differ and byte equality is refused", () => {
  const live = (runId: string, contentSuffix: string) =>
    buildLiveEnvelope({
      runId,
      cutoffEvidenceSetHash: h("cutoff-evidence-set"),
      comparisonId: "fixture-comparison",
      genericRunPolicyHash: h("generic-run-policy"),
      challengeHash: h("challenge"),
      evidencePolicyHash: h("evidence-policy"),
      equivalenceProfileHash: h("equivalence-profile"),
      semanticProjectionHash: h("semantic-projection"),
      entries: [
        {
          entryId: "entry-a",
          sourceContentHash: h(`content-a-${contentSuffix}`),
          artifact: entryArtifact("a"),
          sourceState: "complete",
        },
      ],
      frozenAt: "2026-07-01T00:13:00Z",
    });
  const a = live("01890000-0000-7000-8000-00000000000a", "one");
  const b = live("01890000-0000-7000-8000-00000000000b", "two");
  assert.notEqual(coreHash(a), coreHash(b));

  const receiptBase = {
    schema_version: "semantic-evidence-equivalence-receipt/v1" as const,
    comparison_id: "fixture-comparison",
    equivalence_profile_hash: h("equivalence-profile"),
    independent_verifier_hash: h("equivalence-verifier"),
    live_envelope_hashes: [coreHash(a), coreHash(b)],
    semantic_projection_hashes: [h("projection-a"), h("projection-b")],
    invariant_results: [
      { invariant_id: "same-fact-set", status: "passed" as const, proof_refs: [] },
    ],
    status: "equivalent" as const,
    verified_at: "2026-07-01T00:14:00Z",
  };
  const receipt = assertContract("SemanticEvidenceEquivalenceReceiptV1", sealSigned(receiptBase, keyring.evaluator));
  assertLiveEquivalence(receipt as never, [a, b]);

  // An inconclusive receipt cannot be reported as equivalent.
  const inconclusive = assertContract(
    "SemanticEvidenceEquivalenceReceiptV1",
    sealSigned({ ...receiptBase, status: "inconclusive" as const }, keyring.evaluator),
  );
  assert.throws(
    () => assertLiveEquivalence(inconclusive as never, [a, b]),
    (e: unknown) => (e as { code: string }).code === "COMPARISON_MODE_ENVELOPE_MISMATCH",
  );
});

function translationReceipt(envelope: ReturnType<typeof replayEnvelope>, mappings: unknown[]) {
  const base = {
    schema_version: "adapter-translation-receipt/v1" as const,
    run_id: "01890000-0000-7000-8000-000000000001",
    adapter_hash: h("adapter"),
    canonical_envelope_hash: coreHash(envelope),
    translated_tree_hash: h("translated-tree"),
    mappings,
    total_input_entries: envelope.entries.length,
    accounted_entries: (mappings as { entry_id: string }[]).length,
    complete: true as const,
    translated_at: "2026-07-01T00:13:30Z",
  };
  return assertContract("AdapterTranslationReceiptV1", { ...base, core_hash: coreHash(base) });
}

test("TRANSLATION: every entry is accounted for exactly once, unsupported included", () => {
  const envelope = replayEnvelope();
  const receipt = translationReceipt(envelope, [
    { entry_id: "entry-a", disposition: "mapped_exact", target_refs: [] },
    { entry_id: "entry-b", disposition: "unsupported", target_refs: [], loss_reason_code: "NO_EQUIVALENT_INPUT" },
  ]);
  assertTranslationTotality(receipt as never, envelope);
});

test("TRANSLATION: an omitted, duplicated or unknown entry is refused", () => {
  const envelope = replayEnvelope();
  assert.throws(
    () =>
      assertTranslationTotality(
        translationReceipt(envelope, [
          { entry_id: "entry-a", disposition: "mapped_exact", target_refs: [] },
        ]) as never,
        envelope,
      ),
    (e: unknown) => (e as { code: string }).code === "TRANSLATION_ENTRY_OMITTED",
  );
  assert.throws(
    () =>
      assertTranslationTotality(
        translationReceipt(envelope, [
          { entry_id: "entry-a", disposition: "mapped_exact", target_refs: [] },
          { entry_id: "entry-a", disposition: "mapped_exact", target_refs: [] },
          { entry_id: "entry-b", disposition: "mapped_exact", target_refs: [] },
        ]) as never,
        envelope,
      ),
    (e: unknown) => (e as { code: string }).code === "TRANSLATION_ENTRY_DUPLICATED",
  );
  assert.throws(
    () =>
      assertTranslationTotality(
        translationReceipt(envelope, [
          { entry_id: "entry-a", disposition: "mapped_exact", target_refs: [] },
          { entry_id: "entry-b", disposition: "mapped_exact", target_refs: [] },
          { entry_id: "entry-z", disposition: "mapped_exact", target_refs: [] },
        ]) as never,
        envelope,
      ),
    (e: unknown) => (e as { code: string }).code === "TRANSLATION_UNKNOWN_ENTRY",
  );
});

test("TRANSLATION: an adapter cannot present the canonical envelope as its translated tree", () => {
  const envelope = replayEnvelope();
  const base = {
    schema_version: "adapter-translation-receipt/v1" as const,
    run_id: "01890000-0000-7000-8000-000000000001",
    adapter_hash: h("adapter"),
    canonical_envelope_hash: coreHash(envelope),
    translated_tree_hash: envelope.tree_hash,
    mappings: [
      { entry_id: "entry-a", disposition: "mapped_exact" as const, target_refs: [] },
      { entry_id: "entry-b", disposition: "mapped_exact" as const, target_refs: [] },
    ],
    total_input_entries: 2,
    accounted_entries: 2,
    complete: true as const,
    translated_at: "2026-07-01T00:13:30Z",
  };
  const receipt = assertContract("AdapterTranslationReceiptV1", { ...base, core_hash: coreHash(base) });
  assert.throws(
    () => assertTranslationTotality(receipt as never, envelope),
    (e: unknown) => (e as { code: string }).code === "TRANSLATION_ENVELOPE_REWRITTEN",
  );
});

test("CAPTURE: the observation freeze scans for canaries before retention", () => {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-observation-"));
  const store = new ArtifactStore(root);
  const receipt = processStart();
  const cutoff = realizeCutoff({
    policy: cutoffPolicy(),
    processStartReceipt: receipt,
    runtimeMilestone: milestone(receipt, "2026-07-01T00:10:01Z", 1_001_000),
    warmupMs: 30_000,
    observationMs: 120_000,
  });
  const snapshot = freezeSourceSnapshot({
    runId: "01890000-0000-7000-8000-000000000001",
    snapshotId: "snapshot-clean",
    sourceId: "deployment-log",
    sourceKind: "deployment",
    sourceSchema: "deployment/v1",
    sourceIdentityHash: h("source-identity"),
    state: "complete",
    queryHash: h("query"),
    window: { from: "2026-07-01T00:00:00Z", to_exclusive: "2026-07-01T00:12:30Z" },
    startedAt: "2026-07-01T00:12:31Z",
    endedAt: "2026-07-01T00:12:32Z",
    pages: 1,
    records: 3,
    bytes: 128,
    dedupeKey: "id",
    orderingId: "event-time",
    healthRecordHash: h("health"),
  });
  const bundle = freezeObservation({
    runId: "01890000-0000-7000-8000-000000000001",
    planHash: h("plan"),
    environmentInstanceHash: h("environment-instance"),
    cutoff,
    snapshots: [snapshot],
    subjectVisibleProjectionPolicyHash: h("projection-policy"),
    comparisonPolicyHash: h("comparison-policy"),
    canonicalEvidenceEnvelopeHash: coreHash(replayEnvelope()),
    redactionPolicyHash: h("redaction-policy"),
    entries: [entryArtifact("a")],
    frozenAt: "2026-07-01T00:13:00Z",
    store,
    knownCanaryIds: [],
  });
  assert.equal(bundle.leak_scan.canaries_found, 0);
  assert.equal(bundle.cutoff.instant, "2026-07-01T00:12:30Z");
});
