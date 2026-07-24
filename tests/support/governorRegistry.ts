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
  jcsBytes,
  sealSigned,
  type AgeIdentity,
} from "@erl2/integrity";
import { commitJourneyStep, type CommittedStep } from "@erl2/core";
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
}

const CREATED_AT = "2026-07-01T00:00:00Z";

/**
 * A stable identity for policy bodies whose contracts belong to later slices.
 * It is content-addressed, so it cannot silently change.
 */
function h(label: string): Hash {
  return `sha256:${createHash("sha256").update(`erl2-fixture:${label}`, "utf8").digest("hex")}`;
}

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
  };
}
