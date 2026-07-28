/**
 * A governor-prepared admission registry.
 *
 * The challenge governor authors these artifacts out of band, before any run
 * exists: the acquisition source, the adapter manifest, the generic run policy,
 * and — critically — the split visible steps, encrypted judge expectations and
 * their commitments. The Lab then resolves everything by core hash.
 *
 * The judge expectation ciphertexts live in a *separate vault store*, not in
 * the registry and not in any run root, so a test that scans the registry or a
 * run for canaries is scanning exactly what a subject could reach.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Hash, JourneyIntent } from "@erl2/contracts";
import {
  ageRecipientOf,
  ArtifactStore,
  developmentAgeIdentity,
  hashBytes,
  jcsBytes,
  sealSigned,
  type AgeIdentity,
} from "@erl2/integrity";
import { commitJourneyStep, DEVELOPMENT_BEACON_SOURCE_ID, type CommittedStep } from "@erl2/core";
import { developmentKeyring, developmentTrustPolicy, type DevelopmentKeyring } from "./keys.js";
import { REFERENCE_CORRECT_MANIFEST, REFERENCE_LIMITED_MANIFEST } from "./adapterFixtures.js";

export interface GovernorRegistry {
  readonly root: string;
  readonly vaultRoot: string;
  readonly keyring: DevelopmentKeyring;
  readonly judgeIdentity: AgeIdentity;
  readonly sourceManifestHash: Hash;
  readonly adapterManifestHash: Hash;
  /** Certified reference adapters, admitted alongside the fake-port manifest. */
  readonly referenceCorrectAdapterHash: Hash;
  readonly referenceLimitedAdapterHash: Hash;
  readonly genericRunPolicyHash: Hash;
  readonly runTrustPolicyHash: Hash;
  readonly limitsHash: Hash;
  readonly acquisitionActorScriptHash: Hash;
  readonly acquisitionActorSchemaHash: Hash;
  readonly acquisitionStep: CommittedStep;
  readonly packageVerificationStep: CommittedStep;
  readonly environmentSteps: ReadonlyMap<JourneyIntent, CommittedStep>;
  readonly canaryIds: readonly string[];
  /** The real signed journey selection policy (ADR-ERL2-020 §2a, C-3). */
  readonly journeySelectionPolicyHash: Hash;
  /** The admitted external-beacon randomness policy and its pinned source trust head. */
  readonly randomnessPolicyHash: Hash;
  readonly sourceTrustPolicyHash: Hash;
  /** Candidate-independent roots over the admitted challenge family. */
  readonly challengeFamilyHash: Hash;
  readonly journeyFamilyRootHash: Hash;
  readonly challengeCandidates: readonly ChallengeCandidate[];
}

/** One admitted member of the challenge family selection may draw. */
export interface ChallengeCandidate {
  readonly challengeId: string;
  readonly steps: number;
  readonly exposureEpoch: number;
  readonly challengeManifestHash: Hash;
  readonly journeyHash: Hash;
  readonly personaScriptHash: Hash;
  readonly orderedStepCommitmentHashes: readonly Hash[];
}

const CREATED_AT = "2026-07-01T00:00:00Z";

/**
 * A stable identity for policy bodies whose contracts belong to later slices.
 * It is content-addressed, so it cannot silently change.
 */
function h(label: string): Hash {
  return `sha256:${createHash("sha256").update(`erl2-fixture:${label}`, "utf8").digest("hex")}`;
}

/**
 * The admitted challenge family selection draws from.
 *
 * Members differ in step count and exposure epoch so a selection landing on any
 * of them is distinguishable downstream — a family of identical candidates would
 * make a wrong selection unobservable. Order here is presentation only: the
 * family roots hash the *sorted set*, so admission order cannot bias selection.
 */
const CHALLENGE_FAMILY = [
  { challengeId: "a", steps: 2, exposureEpoch: 3 },
  { challengeId: "b", steps: 1, exposureEpoch: 11 },
  { challengeId: "c", steps: 3, exposureEpoch: 0 },
] as const;

const ENVIRONMENT_INTENTS: readonly JourneyIntent[] = [
  "install",
  "configure",
  "authenticate",
  "connect",
  "discover",
  "exercise",
  "observe",
  "diagnose_decide",
  "recover",
  "upgrade",
  "rollback",
  "remove",
];

export interface BuildGovernorRegistryOptions {
  /**
   * A deterministic RNG for the hiding-commitment ciphertexts and canary tokens.
   * Real fixtures use the CSPRNG (the default); an *evidence* build injects a
   * seeded RNG so the CLI-driven runs' commitment hashes are byte-reproducible
   * (review 6R-D). The seeded path never touches held-out selection.
   */
  readonly random?: (n: number) => Buffer;
}

export function buildGovernorRegistry(options: BuildGovernorRegistryOptions = {}): GovernorRegistry {
  const random = options.random;
  const root = mkdtempSync(path.join(tmpdir(), "erl2-registry-"));
  const vaultRoot = mkdtempSync(path.join(tmpdir(), "erl2-vault-"));
  mkdirSync(root, { recursive: true });
  const keyring = developmentKeyring();
  const judgeIdentity = developmentAgeIdentity("judge");
  const vault = new ArtifactStore(vaultRoot);

  const admit = (name: string, value: object): Hash => {
    writeFileSync(path.join(root, `${name}.json`), `${jcsBytes(value).toString("utf8")}\n`);
    return (value as { core_hash: Hash }).core_hash;
  };

  const sourceManifest = sealSigned(
    {
      schema_version: "acquisition-source-manifest/v1" as const,
      source_id: "fixture-local-delivery",
      source_kind: "local_delivery" as const,
      locator_hash: h("locator"),
      requested_version_or_channel: "0.1.0",
      integrity_policy_hash: h("integrity-policy"),
      provenance_policy_hash: h("provenance-policy"),
      network_profile_hash: h("network-profile"),
      limits: { runtime_ms: 60_000, bytes: 1_048_576, redirects: 0 },
    },
    keyring.policyAuthor,
  );
  const sourceManifestHash = admit("acquisition-source-manifest", sourceManifest);

  // The run trust policy is admitted like any other governor artifact, so a run
  // mirrors the real signed manifest rather than a fabricated hash. The verifier
  // still authorizes it only against its own locally pinned root.
  const runTrustPolicy = developmentTrustPolicy(keyring);
  const runTrustPolicyHash = admit("run-trust-policy", runTrustPolicy);

  const adapterManifest = sealSigned(
    {
      schema_version: "subject-adapter-manifest/v1" as const,
      adapter_id: "fake-subject",
      version: "0.1.0",
      protocol_version: "subject-adapter/v1" as const,
      adapter_artifact_hash: h("adapter-artifact"),
      supported_package_kinds: ["archive"],
      operations: ["acquire", "verify-package", "install", "configure", "connect", "exercise", "remove"],
      required_broker_capabilities: [],
      network_allowlist_ids: [],
      projection_schema: "generic-claim-set/v1" as const,
      certification_receipt_hash: h("adapter-certification"),
      owner: "erl2 development",
    },
    keyring.adapterOwner,
  );
  const adapterManifestHash = admit("adapter-manifest", adapterManifest);

  // The reference adapters are admitted like any other adapter: the governor
  // records their exact signed manifests, and a run resolves them by core hash.
  const referenceCorrectAdapterHash = admit(
    "adapter-manifest-reference-correct",
    REFERENCE_CORRECT_MANIFEST(),
  );
  const referenceLimitedAdapterHash = admit(
    "adapter-manifest-reference-limited",
    REFERENCE_LIMITED_MANIFEST(),
  );

  const runPolicy = sealSigned(
    {
      schema_version: "generic-run-policy/v1" as const,
      policy_id: "fixture-generic-run-policy",
      version: 1,
      evidence_policy_hash: h("evidence-policy"),
      cutoff_policy_hash: h("cutoff-policy"),
      journey_policy_hash: h("journey-policy"),
      generic_evaluation_policy_hash: h("generic-evaluation-policy"),
      domain_pack_hashes: [h("operations-pack")],
      run_trust_policy_hash: runTrustPolicyHash,
    },
    keyring.policyAuthor,
  );
  const genericRunPolicyHash = admit("generic-run-policy", runPolicy);

  const recipients = [ageRecipientOf(judgeIdentity)];
  const canaryIds: string[] = [];

  const commit = (
    stepId: string,
    intent: JourneyIntent,
    truthScope: "journey_only" | "functional",
  ): CommittedStep => {
    const step = commitJourneyStep({
      visible: {
        stepId,
        intent,
        actorRole: "operations-engineer",
        interactionKinds: ["cli", "documentation"],
        timeoutMs: 60_000,
        maxAttempts: 3,
        backoffId: "full-jitter-500ms",
      },
      expectation: {
        expectedObservations: [
          {
            observation_id: `${stepId}-succeeded`,
            predicate_id: "step-completed",
            required: true,
            proof_source_ids: ["deployment-log"],
          },
        ],
        permittedFailureCategories: ["subject_runtime_failure"],
        attributionRequirements: [h(`${stepId}-attribution`)],
        truthScope,
      },
      store: vault,
      recipients,
      governorKey: keyring.challengeGovernor,
      committedAt: CREATED_AT,
      ...(random === undefined ? {} : { random }),
    });
    canaryIds.push(step.canaryId);
    // Only the visible step and the commitment are admitted. The plaintext
    // expectation never leaves the vault.
    admit(`visible-step-${stepId}`, step.visibleStep);
    admit(`step-commitment-${stepId}`, step.commitment);
    return step;
  };

  const acquisitionStep = commit("acquire", "acquire", "journey_only");
  const packageVerificationStep = commit("verify-package", "verify_package", "journey_only");
  const environmentSteps = new Map<JourneyIntent, CommittedStep>();
  for (const intent of ENVIRONMENT_INTENTS) {
    environmentSteps.set(intent, commit(intent.replaceAll("_", "-"), intent, "functional"));
  }

  // -- challenge family and the real journey selection policy ---------------
  //
  // ADR-ERL2-020 §2a / CONFLICT-ERL2-002 C-3: `journey-selection-policy/v1` had
  // no producer anywhere — every call site passed the placeholder
  // `h("journey-selection-policy")`, so its authorized signer could not be
  // derived from evidence and its row stayed unencoded. This is that producer.
  //
  // The family roots are deliberately **candidate-independent**: each is a hash
  // over the *sorted set* of the family's member hashes, so admitting the
  // candidates in any order yields the same root and no candidate is privileged
  // by registry construction. Selection must be free to land on any member.
  //
  // These are governor-authored admission inputs, not Lab-produced protocol
  // commitments, so they take a plain content hash. Adding a `HASH_DOMAINS`
  // entry is an ADR-class change (domains.ts:1-8) and is not warranted here —
  // the values these replace were undomained placeholders already.
  const familyRoot = (label: string, members: readonly Hash[]): Hash =>
    hashBytes(jcsBytes({ family: label, members: [...members].sort() }));

  // Each family member gets a *real* signed journey definition and challenge
  // manifest, not a placeholder hash, so the family roots below are computed over
  // artifacts that actually exist and `preregister-challenge` has something to
  // mirror. Members draw disjoint step commitments so a selection landing on the
  // wrong candidate is observable downstream.
  const stepPool = [...environmentSteps.values()];
  let stepCursor = 0;
  const challengeCandidates: ChallengeCandidate[] = CHALLENGE_FAMILY.map((candidate) => {
    const steps = stepPool.slice(stepCursor, stepCursor + candidate.steps);
    stepCursor += candidate.steps;
    const orderedStepCommitmentHashes = steps.map((s) => s.commitmentHash);
    const personaScriptHash = h(`persona-${candidate.challengeId}`);

    const journey = sealSigned(
      {
        schema_version: "journey-definition/v1" as const,
        journey_id: `erl2-development-journey-${candidate.challengeId}`,
        version: 1,
        domain: "software_delivery_operations" as const,
        persona_script_hash: personaScriptHash,
        ordered_step_commitment_hashes: orderedStepCommitmentHashes,
        prerequisite_policy_hash: h("prerequisite-policy"),
        assistance_policy_hash: h("assistance-policy"),
      },
      keyring.challengeGovernor,
    );
    const journeyHash = admit(`journey-definition-${candidate.challengeId}`, journey);

    const challenge = sealSigned(
      {
        schema_version: "challenge-manifest/v1" as const,
        challenge_id: `erl2-development-challenge-${candidate.challengeId}`,
        version: 1,
        domain: "software_delivery_operations" as const,
        archetype_hashes: [h("archetype-clean-greenfield")],
        journey_hash: journeyHash,
        journey_step_commitment_hashes: orderedStepCommitmentHashes,
        truth_commitment_hash: h(`truth-commitment-${candidate.challengeId}`),
        evidence_policy_hash: h("evidence-policy"),
        cutoff_policy_hash: h("cutoff-policy"),
        required_domain_capabilities: [],
        // ERL2-OQ-007 fail-closed: the admitted family is `development` only.
        tier: "development" as const,
        exposure_epoch: candidate.exposureEpoch,
        admission_proof_hash: h(`admission-proof-${candidate.challengeId}`),
      },
      keyring.challengeGovernor,
    );
    const challengeManifestHash = admit(`challenge-manifest-${candidate.challengeId}`, challenge);

    return {
      challengeId: candidate.challengeId,
      steps: candidate.steps,
      exposureEpoch: candidate.exposureEpoch,
      challengeManifestHash,
      journeyHash,
      personaScriptHash,
      orderedStepCommitmentHashes,
    };
  });

  const challengeFamilyHash = familyRoot(
    "challenge",
    challengeCandidates.map((c) => c.challengeManifestHash),
  );
  const journeyFamilyRootHash = familyRoot(
    "journey",
    challengeCandidates.map((c) => c.journeyHash),
  );

  const journeySelectionPolicy = sealSigned(
    {
      schema_version: "journey-selection-policy/v1" as const,
      policy_id: "erl2-development-journey-selection-policy",
      challenge_family_hash: challengeFamilyHash,
      journey_family_root_hash: journeyFamilyRootHash,
      allowed_intents: [...ENVIRONMENT_INTENTS],
      journey_schema_hash: h("journey-schema"),
      step_commitment_schema_hash: h("step-commitment-schema"),
      actor_policy_hash: h("actor-policy"),
      actor_policy_schema_hash: h("actor-policy-schema"),
      admission_policy_hash: h("admission-policy"),
    },
    // ADR-ERL2-020 §2a: `policy_author`, not `challenge_governor`. A policy the
    // challenge governor both authored and selected under would collapse the
    // separation the role audit asserts.
    keyring.policyAuthor,
  );
  const journeySelectionPolicyHash = admit("journey-selection-policy", journeySelectionPolicy);

  // The randomness policy is admitted here too, so `preregister-challenge` can
  // mirror it from the registry rather than a run reconstructing it. Its signer
  // is `policy_author` for the same reason as the journey selection policy
  // (ADR-ERL2-020 §2a): the governor must not author the randomness policy that
  // governs its own selection.
  const sourceTrustPolicyHash = h("source-trust-policy");
  const randomnessPolicy = sealSigned(
    {
      schema_version: "external-beacon-randomness-policy/v1" as const,
      policy_id: "erl2-development-beacon-policy",
      source_kind: "external_beacon" as const,
      source_id: DEVELOPMENT_BEACON_SOURCE_ID,
      source_trust_policy_hash: sourceTrustPolicyHash,
      beacon_trust_configuration_hash: h("beacon-trust-configuration"),
      round_rule: "first_finalized_round_after_pool_checkpoint" as const,
      finality_rule_hash: h("finality-rule"),
      retry_policy: "none_invalidate_run" as const,
      required_operator_separation_policy_hash: h("operator-separation-policy"),
      randomness_domain: "ERL2-SELECTION-RANDOMNESS-V1" as const,
    },
    keyring.policyAuthor,
  );
  const randomnessPolicyHash = admit("selection-randomness-policy", randomnessPolicy);

  return {
    root,
    vaultRoot,
    keyring,
    judgeIdentity,
    sourceManifestHash,
    adapterManifestHash,
    referenceCorrectAdapterHash,
    referenceLimitedAdapterHash,
    genericRunPolicyHash,
    runTrustPolicyHash,
    limitsHash: h("limits"),
    acquisitionActorScriptHash: h("acquisition-actor-script"),
    acquisitionActorSchemaHash: h("acquisition-actor-schema"),
    acquisitionStep,
    packageVerificationStep,
    environmentSteps,
    canaryIds,
    journeySelectionPolicyHash,
    randomnessPolicyHash,
    sourceTrustPolicyHash,
    challengeFamilyHash,
    journeyFamilyRootHash,
    challengeCandidates,
  };
}
