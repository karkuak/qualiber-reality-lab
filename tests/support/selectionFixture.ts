/**
 * Builds a complete, verifiable V2 selection chain against the development
 * beacon.  Non-blind `development` tier only: ERL2-OQ-007 is unresolved, so a
 * held-out or blind selection against this source is refused by design.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertContract,
  type ExternalBeaconRandomnessPolicyV1,
  type Hash,
  type SelectionRequestV2,
  type SelectionRoleSeparationAuditV1,
} from "@erl2/contracts";
import {
  ArtifactStore,
  coreHash,
  domainHash,
  HASH_DOMAINS,
  sealSigned,
  TrustEvaluator,
  type LocalTrustConfiguration,
} from "@erl2/integrity";
import {
  buildEligibilityPool,
  DevelopmentBeaconSource,
  runSelectionChain,
  SteppingClock,
  SeededRandom,
  TimestampLog,
  uuidV7From,
  type BuiltPool,
  type SelectionChainResult,
} from "@erl2/core";
import { developmentKeyring, developmentTrustPolicy, localTrustConfiguration } from "./keys.js";
import type { DevelopmentKeyring } from "./keys.js";

const START = "2026-07-01T00:00:00Z";

function h(label: string): Hash {
  return domainHash(HASH_DOMAINS.TREE, { fixture_label: label });
}

export interface SelectionFixture {
  readonly root: string;
  readonly runId: string;
  readonly keyring: DevelopmentKeyring;
  readonly trust: TrustEvaluator;
  readonly localTrust: LocalTrustConfiguration;
  readonly request: SelectionRequestV2;
  readonly requestHash: Hash;
  readonly roleAudit: SelectionRoleSeparationAuditV1;
  readonly policy: ExternalBeaconRandomnessPolicyV1;
  readonly policyHash: Hash;
  readonly pool: BuiltPool;
  readonly result: SelectionChainResult;
  readonly beacon: DevelopmentBeaconSource;
  readonly store: ArtifactStore;
}

export function buildSelectionFixture(): SelectionFixture {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-selection-"));
  const runId = uuidV7From(Date.parse(START), Buffer.alloc(10, 0x44));
  const keyring = developmentKeyring();
  const store = new ArtifactStore(root);
  const clock = new SteppingClock(START, 1000);
  const random = new SeededRandom("erl2-selection-fixture");

  const sourceTrustPolicyHash = h("source-trust-policy");
  const beacon = new DevelopmentBeaconSource({
    seed: "erl2-selection-fixture",
    firstRoundAt: "2026-07-01T00:01:00Z",
    roundIntervalMs: 30_000,
  });
  const registryHead = h("randomness-registry-head");
  const trustPolicy = developmentTrustPolicy(keyring);
  const localTrust = localTrustConfiguration(
    trustPolicy,
    keyring,
    [beacon.pinnedRegistryEntry(sourceTrustPolicyHash)],
    registryHead,
  );
  const trust = new TrustEvaluator(trustPolicy, localTrust);

  const policy = assertContract<ExternalBeaconRandomnessPolicyV1>(
    "ExternalBeaconRandomnessPolicyV1",
    sealSigned(
      {
        schema_version: "external-beacon-randomness-policy/v1" as const,
        policy_id: "erl2-development-beacon-policy",
        source_kind: "external_beacon" as const,
        source_id: beacon.sourceId,
        source_trust_policy_hash: sourceTrustPolicyHash,
        beacon_trust_configuration_hash: h("beacon-trust-configuration"),
        round_rule: "first_finalized_round_after_pool_checkpoint" as const,
        finality_rule_hash: h("finality-rule"),
        retry_policy: "none_invalidate_run" as const,
        required_operator_separation_policy_hash: h("operator-separation-policy"),
        randomness_domain: "ERL2-SELECTION-RANDOMNESS-V1" as const,
      },
      keyring.policyAuthor,
    ),
  );
  const policyHash = coreHash(policy);

  const request = assertContract<SelectionRequestV2>(
    "SelectionRequestV2",
    sealSigned(
      {
        schema_version: "selection-request/v2" as const,
        request_id: "erl2-development-selection",
        run_id: runId,
        request_nonce: "a".repeat(64),
        requested_tier: "development" as const,
        acquisition_preregistration_hash: h("acquisition-preregistration"),
        acquisition_source_manifest_hash: h("acquisition-source-manifest"),
        acquisition_record_hash: h("acquisition-record"),
        subject_package_manifest_hash: h("subject-package-manifest"),
        adapter_manifest_hash: h("adapter-manifest"),
        admissible_archetype_set_hash: h("archetype-set"),
        challenge_family_hash: h("challenge-family"),
        environment_profile_hash: h("environment-profile"),
        eligibility_policy_hash: h("eligibility-policy"),
        configuration_intent_hash: h("configuration-intent"),
        generic_run_policy_hash: h("generic-run-policy"),
        actor_policy_hash: h("actor-policy"),
        comparison_policy_hash: h("comparison-policy"),
        selection_randomness_policy_hash: policyHash,
        journey_selection_policy_hash: h("journey-selection-policy"),
        requested_at: clock.now(),
        expires_at: "2026-12-31T00:00:00Z",
      },
      keyring.challengeGovernor,
    ),
  );
  const requestHash = coreHash(request);

  const roleAudit = assertContract<SelectionRoleSeparationAuditV1>(
    "SelectionRoleSeparationAuditV1",
    sealSigned(
      {
        schema_version: "selection-role-separation-audit/v1" as const,
        audit_id: "erl2-role-audit",
        run_id: runId,
        selection_request_hash: requestHash,
        role_assignments: [
          {
            role: "challenge_governor" as const,
            operator_identity_hash: h("operator-governor"),
            key_ids: [keyring.challengeGovernor.keyId],
          },
          {
            role: "selector" as const,
            operator_identity_hash: h("operator-selector"),
            key_ids: [keyring.selector.keyId],
          },
          {
            role: "randomness_source" as const,
            operator_identity_hash: h("operator-beacon"),
            key_ids: ["erl2-dev-beacon-ed25519-1"],
          },
          {
            role: "reveal_custodian" as const,
            operator_identity_hash: h("operator-custodians"),
            key_ids: keyring.custodianSigners.map((k) => k.keyId),
          },
          {
            role: "evaluator" as const,
            operator_identity_hash: h("operator-evaluator"),
            key_ids: [keyring.evaluator.keyId],
          },
        ],
        reveal_threshold: 2,
        reveal_participant_key_ids: keyring.custodianSigners.map((k) => k.keyId),
        prohibited_operator_overlaps: [] as const,
        prohibited_key_overlaps: [] as const,
        append_only_access_log_head_hash: h("access-log-head"),
        all_required_roles_disjoint: true as const,
        status: "passed" as const,
        audited_at: clock.now(),
      },
      keyring.challengeGovernor,
    ),
  );
  const roleAuditHash = coreHash(roleAudit);

  const pool = buildEligibilityPool({
    poolId: "erl2-development-pool",
    selectionRequestHash: requestHash,
    journeySelectionPolicyHash: h("journey-selection-policy"),
    selectionRandomnessPolicyHash: policyHash,
    randomnessSourceId: beacon.sourceId,
    randomnessSourceTrustPolicyHash: sourceTrustPolicyHash,
    roleAudit,
    roleAuditHash,
    candidates: [
      {
        challengeManifestHash: h("challenge-a"),
        personaScriptHash: h("persona-a-a-very-long-script"),
        journeyHash: h("journey-a"),
        orderedStepCommitmentHashes: [h("step-a1"), h("step-a2")],
        exposureEpoch: 3,
      },
      {
        challengeManifestHash: h("challenge-b"),
        personaScriptHash: h("persona-b"),
        journeyHash: h("journey-b"),
        orderedStepCommitmentHashes: [h("step-b1")],
        exposureEpoch: 11,
      },
      {
        challengeManifestHash: h("challenge-c"),
        personaScriptHash: h("persona-c"),
        journeyHash: h("journey-c"),
        orderedStepCommitmentHashes: [h("step-c1"), h("step-c2"), h("step-c3")],
        exposureEpoch: 0,
      },
    ],
    custodians: keyring.custodians,
    revealThreshold: 2,
    decryptionReleasePolicyHash: h("decryption-release-policy"),
    hiddenPayloadSchemaHash: h("hidden-payload-schema"),
    eligibilityProofHash: h("eligibility-proof"),
    governorKey: keyring.challengeGovernor,
    entrySignerKey: keyring.entrySigner,
    store,
    clock,
    random,
    expiresAt: "2026-12-31T00:00:00Z",
  });

  const timestamps = new TimestampLog({
    logId: "erl2-development-log",
    runId,
    authority: keyring.timestampAuthority,
    clock,
  });

  const result = runSelectionChain({
    runId,
    request,
    requestHash,
    policy,
    policyHash,
    pool,
    beacon,
    trust,
    timestamps,
    store,
    clock,
    keys: {
      selector: keyring.selector,
      wrapperSigner: keyring.wrapperSigner,
      sourceTrustVerifier: keyring.sourceTrustVerifier,
      revealAuthority: keyring.revealAuthority,
      verifier: keyring.evaluator,
      custodians: keyring.custodians,
      custodianSigners: keyring.custodianSigners,
    },
    accessLogHeadHash: h("access-log-head"),
    revealThreshold: 2,
  });

  return {
    root,
    runId,
    keyring,
    trust,
    localTrust,
    request,
    requestHash,
    roleAudit,
    policy,
    policyHash,
    pool,
    result,
    beacon,
    store,
  };
}
