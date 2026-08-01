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
import { writeFileSync, mkdirSync } from "node:fs";
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
import { ownedTempDir } from "./tempDirs.js";

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
  readonly canaryIds: readonly string[];
  /** Environment admission inputs (Slice 6.5-B). */
  readonly archetypeHash: Hash;
  readonly equivalenceProfileHash: Hash;
  readonly comparisonPolicyHash: Hash;
  readonly cutoffPolicyHash: Hash;
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
  /** The ordered intents this candidate's journey commits, in execution order. */
  readonly intents: readonly JourneyIntent[];
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
  { challengeId: "a", exposureEpoch: 3 },
  { challengeId: "b", exposureEpoch: 11 },
  { challengeId: "c", exposureEpoch: 0 },
] as const;

/**
 * The ordered intents every admitted candidate commits.
 *
 * Each candidate commits its *own instance* of every step — `a-install` is a
 * different commitment from `b-install` — so a selection landing on the wrong
 * candidate stays observable downstream while every candidate remains a
 * complete, runnable environment journey. An earlier fixture distinguished
 * candidates by step *count* instead, which made two of the three unable to
 * reach activation at all and hid the environment path behind whichever
 * candidate the beacon happened to pick.
 */
const ENVIRONMENT_JOURNEY: readonly JourneyIntent[] = [
  "install",
  "configure",
  "authenticate",
  "connect",
  "discover",
  "exercise",
  "observe",
  "remove",
];

/**
 * The intents whose judge expectation carries functional mechanism truth.
 *
 * Everything else is journey-scope: whether the subject installed, connected or
 * uninstalled cleanly is a journey fact, not a mechanism one. This split is what
 * lets a run whose functional truth stays sealed still open the expectations for
 * its unsupported steps (design §12, §15).
 */
const FUNCTIONAL_TRUTH_INTENTS: ReadonlySet<JourneyIntent> = new Set<JourneyIntent>([
  "exercise",
  "diagnose_decide",
]);

export interface BuildGovernorRegistryOptions {
  /**
   * A deterministic RNG for the hiding-commitment ciphertexts and canary tokens.
   * Real fixtures use the CSPRNG (the default); an *evidence* build injects a
   * seeded RNG so the CLI-driven runs' commitment hashes are byte-reproducible
   * (review 6R-D). The seeded path never touches held-out selection.
   */
  readonly random?: (n: number) => Buffer;
  /**
   * The `actor_role` every *environment* journey step is admitted with.
   *
   * A leak has to enter the run through admitted governor data, because that is
   * the only side of the partition that ever holds a canary. Setting this to a
   * canary token puts one inside the `SubjectVisibleJourneyStepV1` the Lab
   * publishes into the adapter-visible tree — with the step's descriptor, its
   * commitment and the adapter request that names it all still clean, since each
   * of those carries a hash rather than the content. That is exactly the shape
   * the review said a metadata scan could never catch.
   *
   * The acquisition steps keep the ordinary role, so the pre-environment path
   * still runs and the refusal lands where the test aims it.
   */
  readonly environmentActorRole?: string;
  /**
   * An extra evidence source the archetype declares, beyond the three the fake
   * driver ordinarily serves.
   *
   * Its id reaches the baseline fingerprint, and from there every
   * `SourceSnapshotV1` the capture freezes — the Lab's own telemetry. A canary
   * token here is the production route to the `lab_telemetry` scan.
   */
  readonly extraEvidenceSourceId?: string;
}

export function buildGovernorRegistry(options: BuildGovernorRegistryOptions = {}): GovernorRegistry {
  const random = options.random;
  const root = ownedTempDir("erl2-registry-");
  const vaultRoot = ownedTempDir("erl2-vault-");
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

  // -- environment admission inputs (Slice 6.5-B) ----------------------------
  //
  // The clean-greenfield archetype used to be a bare placeholder hash on every
  // challenge manifest, which meant `provision` had nothing to resolve: the
  // topology, evidence sources and cleanup contract a run is provisioned against
  // existed only as a name. This is the real admitted artifact those names now
  // refer to.
  //
  // Its evidence sources are exactly the ones the fake driver serves, so the
  // baseline's declared source set and the capture's snapshot set are the same
  // set by construction rather than by coincidence.
  const archetype = sealSigned(
    {
      schema_version: "environment-archetype/v1" as const,
      archetype_id: "erl2-clean-greenfield",
      version: 1,
      domain: "software_delivery_operations" as const,
      topology: [
        { node_id: "project", kind: "project-root", version_constraint: "*" },
        { node_id: "network", kind: "isolated-network", version_constraint: "*" },
        { node_id: "volume", kind: "scratch-volume", version_constraint: "*" },
        { node_id: "container", kind: "service-container", version_constraint: "*" },
        { node_id: "port", kind: "loopback-port", version_constraint: "*" },
      ],
      evidence_sources: [
        { source_id: "deployment-log", kind: "deployment", required: true },
        { source_id: "service-metric", kind: "metric", required: true },
        { source_id: "change-record", kind: "change", required: true },
        ...(options.extraEvidenceSourceId === undefined
          ? []
          : [{ source_id: options.extraEvidenceSourceId, kind: "change", required: true }]),
      ],
      organization_metadata_schema: "erl2-generic-organization/v1",
      access_constraints: [{ constraint_id: "loopback-only", kind: "egress", scope: "loopback" }],
      normal_disorder: [],
      resource_budget: {
        cpu_millis: 8_000,
        memory_mib: 16_384,
        disk_mib: 40_960,
        runtime_ms: 2_700_000,
      },
      cleanup_contract_hash: h("cleanup-contract-clean-greenfield"),
      compatibility_tags: ["clean-greenfield"],
      admission_proof_hash: h("admission-proof-archetype"),
    },
    // The development policy grants the challenge governor both governor roles
    // and reports that concentration rather than hiding it (ADR-ERL2-020 §4).
    keyring.challengeGovernor,
  );
  const archetypeHash = admit("environment-archetype", archetype);

  // The equivalence profile a live envelope is projected under: which volatile
  // fields are ignored, which invariants must hold, and which omissions are
  // forbidden. It is admitted before any run so a run cannot choose the terms it
  // will be compared under.
  const equivalenceProfile = sealSigned(
    {
      schema_version: "evidence-equivalence-profile/v1" as const,
      profile_id: "erl2-development-equivalence",
      challenge_family_hash: h("challenge-family-placeholder"),
      semantic_fact_schema_hash: h("semantic-fact-schema"),
      normalization_rule_hashes: [h("normalize-timestamps"), h("normalize-instance-ids")],
      ignored_volatile_field_paths: ["started_at", "ended_at", "inventoried_at"],
      required_invariant_ids: ["every-declared-source-has-a-state"],
      forbidden_omission_classes: ["declared-source-absent"],
    },
    keyring.policyAuthor,
  );
  const equivalenceProfileHash = admit("evidence-equivalence-profile", equivalenceProfile);

  // `live_ecosystem`, not `replay_comparison`.
  //
  // Replay mode means every run binds one *pre-admitted* comparison-level
  // envelope whose bytes are identical across subjects (§13). A run that observes
  // its own provisioned environment does not have that envelope and must not
  // claim it: it produces its own `LiveCanonicalEvidenceEnvelopeV1` under this
  // equivalence profile. Cross-environment equivalence is a claim about two runs,
  // so no `SemanticEvidenceEquivalenceReceiptV1` is produced here — a single run
  // has nothing to be equivalent to.
  const comparisonPolicy = sealSigned(
    {
      schema_version: "comparison-policy/v1" as const,
      policy_id: "erl2-development-comparison",
      mode: "live_ecosystem" as const,
      selection_eligibility: "blind_capable" as const,
      equivalence_profile_hash: equivalenceProfileHash,
      independent_equivalence_verifier_hash: h("independent-equivalence-verifier-unactivated"),
    },
    keyring.policyAuthor,
  );
  const comparisonPolicyHash = admit("comparison-policy", comparisonPolicy);

  // The bounds the cutoff is checked against. `realizeCutoff` refuses a warmup
  // or observation window outside them, and refuses a wall/monotonic divergence
  // beyond `maximum_monotonic_wall_divergence_ms`, so these are the numbers that
  // make the derived cutoff falsifiable rather than declarative.
  const cutoffPolicy = sealSigned(
    {
      schema_version: "cutoff-policy/v1" as const,
      policy_id: "erl2-development-cutoff",
      version: 1,
      clock: "host_utc" as const,
      instant_rule: "traffic_process_started_at_plus_warmup_ms_plus_observation_ms" as const,
      inclusion: "event_time_lt_and_ingestion_time_lte" as const,
      max_skew_ms: 5_000,
      late_arrival_grace_ms: 30_000,
      maximum_selection_to_traffic_start_ms: 3_600_000,
      maximum_timestamp_submission_delay_ms: 60_000,
      maximum_process_milestone_skew_ms: 60_000,
      maximum_monotonic_wall_divergence_ms: 1_000,
      maximum_warmup_ms: 60_000,
      maximum_observation_ms: 600_000,
      minimum_observation_ms: 1_000,
      event_time_required: true as const,
      ingestion_time_required: true as const,
      valid_from: CREATED_AT,
      valid_until: "2030-01-01T00:00:00Z",
    },
    keyring.policyAuthor,
  );
  const cutoffPolicyHash = admit("cutoff-policy", cutoffPolicy);

  const recipients = [ageRecipientOf(judgeIdentity)];
  const canaryIds: string[] = [];

  const commit = (
    stepId: string,
    intent: JourneyIntent,
    truthScope: "journey_only" | "functional",
    actorRole = "operations-engineer",
  ): CommittedStep => {
    const step = commitJourneyStep({
      visible: {
        stepId,
        intent,
        actorRole,
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
  const challengeCandidates: ChallengeCandidate[] = CHALLENGE_FAMILY.map((candidate) => {
    const steps = ENVIRONMENT_JOURNEY.map((intent) =>
      commit(
        `${candidate.challengeId}-${intent.replaceAll("_", "-")}`,
        intent,
        FUNCTIONAL_TRUTH_INTENTS.has(intent) ? "functional" : "journey_only",
        // Every candidate carries it, so the property under test does not depend
        // on which challenge the beacon drew.
        options.environmentActorRole,
      ),
    );
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
        archetype_hashes: [archetypeHash],
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
      steps: steps.length,
      exposureEpoch: candidate.exposureEpoch,
      intents: [...ENVIRONMENT_JOURNEY],
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
      allowed_intents: [...ENVIRONMENT_JOURNEY],
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
    canaryIds,
    archetypeHash,
    equivalenceProfileHash,
    comparisonPolicyHash,
    cutoffPolicyHash,
    journeySelectionPolicyHash,
    randomnessPolicyHash,
    sourceTrustPolicyHash,
    challengeFamilyHash,
    journeyFamilyRootHash,
    challengeCandidates,
  };
}
