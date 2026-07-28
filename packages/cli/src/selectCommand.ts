/**
 * `erl2 select` — the durable, resumable selection walk (ADR-ERL2-020 §6).
 *
 * This is the composition root for selection: it assembles the context from the
 * run's **own retained evidence** and hands it to `RunWorkspace.advanceSelection`,
 * which advances one durable transition at a time. Re-invoking continues from
 * wherever the last process stopped.
 *
 * Two choices here are deliberate and load-bearing.
 *
 * **The challenge family comes from `retained/`, never from the registry.**
 * `preregister-challenge` froze the admitted family into the run; selection
 * draws from exactly those bytes. Reading the registry again would let an
 * operator widen or narrow the family between preregistration and the draw,
 * which is precisely what freezing it first prevents.
 *
 * **The pool is built once and loaded thereafter.** `buildEligibilityPool` draws
 * opening nonces and envelope ciphertexts, so rebuilding it on resume would
 * produce different entries and silently select a different challenge.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CODES,
  Erl2Error,
  parseStrictJson,
  type AcquisitionPreregistrationV1,
  type ChallengeManifestV1,
  type EligibilityPoolEntryV2,
  type EligibilityPoolManifestV2,
  type ExternalBeaconRandomnessPolicyV1,
  type Hash,
  type JourneyDefinitionV1,
  type TrustPolicyManifestV2,
} from "@erl2/contracts";
import {
  coreHash,
  developmentCustodian,
  developmentKey,
  sealSigned,
  TrustEvaluator,
  type CustodianKey,
  type LocalTrustConfiguration,
} from "@erl2/integrity";
import {
  buildEligibilityPool,
  buildRoleSeparationAudit,
  buildSelectionRequest,
  DevelopmentBeaconSource,
  loadSelectionPool,
  RunWorkspace,
  SeededRandom,
  SystemRandom,
  TimestampLog,
  type SelectionContext,
  type SelectionPool,
  type SelectionPreludeInput,
} from "@erl2/core";

/** Development-tier selection parameters. No other tier is reachable (OQ-007). */
const REVEAL_THRESHOLD = 2;
/**
 * Custodian labels, matching the development trust policy exactly.
 *
 * The producer never used to verify these against the trust policy; the
 * auditor's re-derivation does, and refused an earlier draft that invented
 * `custodian-0..2` with `TRUST_KEY_UNKNOWN`.
 */
const CUSTODIAN_LABELS = ["a", "b", "c"] as const;
const BEACON_FIRST_ROUND_AT = "2026-07-01T00:00:00Z";

/**
 * Verifier-controlled randomness trust, loaded only from `--source-trust-config`.
 *
 * The producer may not decide which randomness source is authorized: that is the
 * verifier's pin, supplied as explicit configuration. The beacon's *public keys*
 * are derived from the development beacon because in this tier the Lab operates
 * it — which is exactly why no tier other than `development` is reachable.
 */
export interface SourceTrustConfig {
  readonly sourceTrustPolicyHash: Hash;
  readonly randomnessRegistryHeadHash: Hash;
}

export function loadSourceTrustConfig(configPath: string): SourceTrustConfig {
  const value = parseStrictJson(readFileSync(path.resolve(configPath), "utf8")) as Partial<SourceTrustConfig>;
  if (
    typeof value.sourceTrustPolicyHash !== "string" ||
    typeof value.randomnessRegistryHeadHash !== "string"
  ) {
    throw new Erl2Error(
      CODES.CFG_MISSING_REQUIRED,
      "source trust configuration needs sourceTrustPolicyHash and randomnessRegistryHeadHash",
    );
  }
  return value as SourceTrustConfig;
}

/** The selection signing roles, each a distinct key (ADR-ERL2-020 §2). */
function selectionKeys(): {
  readonly challengeGovernor: ReturnType<typeof developmentKey>;
  readonly entrySigner: ReturnType<typeof developmentKey>;
  readonly selector: ReturnType<typeof developmentKey>;
  readonly wrapperSigner: ReturnType<typeof developmentKey>;
  readonly auditor: ReturnType<typeof developmentKey>;
  readonly revealAuthority: ReturnType<typeof developmentKey>;
  readonly timestampAuthority: ReturnType<typeof developmentKey>;
  readonly evaluator: ReturnType<typeof developmentKey>;
  readonly custodianSigners: readonly ReturnType<typeof developmentKey>[];
} {
  return {
    challengeGovernor: developmentKey("challenge-governor"),
    entrySigner: developmentKey("entry-signer"),
    selector: developmentKey("selector"),
    wrapperSigner: developmentKey("lab-verifier"),
    auditor: developmentKey("source-trust-verifier"),
    revealAuthority: developmentKey("reveal-authority"),
    timestampAuthority: developmentKey("timestamp"),
    evaluator: developmentKey("evaluator"),
    custodianSigners: CUSTODIAN_LABELS.map((label) => developmentKey(`custodian-${label}`)),
  };
}

/**
 * The randomness the eligibility pool draws its opening nonces and envelope
 * ciphertexts from.
 *
 * The CSPRNG, always — except when generating pinned evidence, where the
 * composition root sets `ERL2_EVIDENCE_RANDOM` to a fixed label so a CLI-driven
 * golden run is byte-reproducible. This is the same mechanism, and the same
 * confinement, as `ERL2_EVIDENCE_CLOCK`: read only here in the CLI composition
 * root, never by core, and per-run rather than global, so two evidence runs still
 * draw different pools.
 *
 * It cannot weaken a real selection. Held-out and blind tiers are refused inside
 * both selection kernels (ERL2-OQ-007), so the only tier this can reach is
 * `development`, where the beacon is Lab-operated anyway and the run makes no
 * blindness claim.
 */
function selectionRandom(runId: string): SystemRandom | SeededRandom {
  const label = process.env["ERL2_EVIDENCE_RANDOM"];
  return label === undefined || label.length === 0
    ? new SystemRandom()
    : new SeededRandom(`${label}:${runId}`);
}

export interface SelectionAssembly {
  readonly ctx: SelectionContext;
  readonly prelude: SelectionPreludeInput;
}

/**
 * Assembles the selection context from the run's retained evidence.
 *
 * Called fresh on every invocation. Nothing is carried between processes: if a
 * value is needed, it is read from `retained/` or from explicit configuration.
 */
export function assembleSelection(input: {
  readonly workspace: RunWorkspace;
  readonly sourceTrust: SourceTrustConfig;
  readonly expiresAt: string;
}): SelectionAssembly {
  // The threshold custodians are part of the composition root, not a caller
  // input: `reveal_custodian` is a separated role and the CLI must not accept a
  // caller-supplied set of them.
  const custodians: readonly CustodianKey[] = CUSTODIAN_LABELS.map((label) =>
    developmentCustodian(label),
  );
  const { workspace, sourceTrust } = input;
  const keys = selectionKeys();
  const clock = workspace.productionClock();

  const role = (name: string): Hash => {
    const hash = workspace.hashForRole(name);
    if (hash === undefined) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_UNREACHABLE_ARTIFACT,
        `selection requires a retained ${name}; the run has none`,
      );
    }
    return hash;
  };

  const beacon = new DevelopmentBeaconSource({
    seed: `erl2-selection-${workspace.runId}`,
    firstRoundAt: BEACON_FIRST_ROUND_AT,
  });

  const prereg = workspace.artifact<AcquisitionPreregistrationV1>(
    role("acquisition-preregistration"),
    "AcquisitionPreregistrationV1",
  );
  // The trust policy is mirrored into the run at preregistration but is not a
  // *produced role*, so it is resolved through the preregistration's own
  // `run_trust_policy_hash` — the run's durable statement of which head it was
  // accepted under, rather than whatever happens to sit at the mirror path.
  const trustPolicy = workspace.artifact<TrustPolicyManifestV2>(
    prereg.run_trust_policy_hash,
    "TrustPolicyManifestV2",
  );
  const localTrust: LocalTrustConfiguration = {
    rootKeyIds: [trustPolicy.root_key_id],
    currentTrustHeadHash: coreHash(trustPolicy as unknown as Record<string, unknown>),
    randomnessSources: [beacon.pinnedRegistryEntry(sourceTrust.sourceTrustPolicyHash)],
    randomnessRegistryHeadHash: sourceTrust.randomnessRegistryHeadHash,
  };
  const trust = new TrustEvaluator(trustPolicy, localTrust);

  const policy = workspace.artifact<ExternalBeaconRandomnessPolicyV1>(
    role("selection-randomness-policy"),
    "ExternalBeaconRandomnessPolicyV1",
  );
  const policyHash = coreHash(policy as unknown as Record<string, unknown>);

  // The family the run froze, in the order the lifecycle recorded it.
  const challengeHashes = workspace.hashesForRole("challenge-manifest");
  if (challengeHashes.length === 0) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_UNREACHABLE_ARTIFACT,
      "selection requires a preregistered challenge family; the run has none",
    );
  }
  const candidates = challengeHashes.map((challengeHash) => {
    const challenge = workspace.artifact<ChallengeManifestV1>(challengeHash, "ChallengeManifestV1");
    const journey = workspace.artifact<JourneyDefinitionV1>(challenge.journey_hash, "JourneyDefinitionV1");
    return {
      challengeManifestHash: challengeHash,
      personaScriptHash: journey.persona_script_hash,
      journeyHash: challenge.journey_hash,
      orderedStepCommitmentHashes: challenge.journey_step_commitment_hashes,
      exposureEpoch: challenge.exposure_epoch,
    };
  });

  const request = buildSelectionRequest({
    runId: workspace.runId,
    prereg,
    bindings: {
      acquisitionPreregistrationHash: role("acquisition-preregistration"),
      acquisitionSourceManifestHash: role("acquisition-source-manifest"),
      acquisitionRecordHash: role("acquisition-record"),
      subjectPackageManifestHash: role("subject-package-manifest"),
      adapterManifestHash: role("adapter-manifest"),
      genericRunPolicyHash: role("generic-run-policy"),
      journeySelectionPolicyHash: role("journey-selection-policy"),
      randomnessPolicyHash: policyHash,
      challengeFamilyHash: coreHash({ family: "challenge", members: [...challengeHashes].sort() }),
    },
    expiresAt: input.expiresAt,
    requestedAt: prereg.registered_at,
    signer: keys.challengeGovernor,
    seal: (body, key) => sealSigned(body as never, key),
  });
  const requestHash = coreHash(request as unknown as Record<string, unknown>);

  const accessLogHeadHash: Hash = coreHash({ run_id: workspace.runId, log: "selection-access" });
  // Each selection role is a distinct *operator*, not just a distinct key.
  // Reusing one identity across roles makes the role-separation audit assert a
  // separation that does not exist — `verifySelectionChainCore` refuses it with
  // `NON_COLLUSION_ROLE_OVERLAP`, which is how this was caught.
  const operatorIdentity = (roleName: string): Hash =>
    coreHash({ run_id: workspace.runId, selection_operator: roleName });
  const roleAudit = buildRoleSeparationAudit({
    runId: workspace.runId,
    requestHash,
    assignments: [
      { role: "challenge_governor", operatorIdentityHash: operatorIdentity("challenge_governor"), keyIds: [keys.challengeGovernor.keyId] },
      { role: "selector", operatorIdentityHash: operatorIdentity("selector"), keyIds: [keys.selector.keyId] },
      { role: "randomness_source", operatorIdentityHash: operatorIdentity("randomness_source"), keyIds: beacon.pinnedRegistryEntry(sourceTrust.sourceTrustPolicyHash).beaconKeyIds as string[] },
      {
        role: "reveal_custodian",
        operatorIdentityHash: operatorIdentity("reveal_custodian"),
        keyIds: keys.custodianSigners.map((k) => k.keyId),
      },
      { role: "evaluator", operatorIdentityHash: operatorIdentity("evaluator"), keyIds: [keys.evaluator.keyId] },
    ],
    revealThreshold: REVEAL_THRESHOLD,
    revealParticipantKeyIds: keys.custodianSigners.map((k) => k.keyId),
    accessLogHeadHash,
    auditedAt: prereg.registered_at,
    signer: keys.challengeGovernor,
    seal: (body, key) => sealSigned(body as never, key),
  });
  const roleAuditHash = coreHash(roleAudit as unknown as Record<string, unknown>);

  const loadPool = (): SelectionPool | undefined => {
    const manifestHash = workspace.hashForRole("eligibility-pool-manifest");
    if (manifestHash === undefined) return undefined;
    return loadSelectionPool(
      workspace.artifact<EligibilityPoolManifestV2>(manifestHash, "EligibilityPoolManifestV2"),
      workspace
        .hashesForRole("eligibility-pool-entry")
        .map((hash) => workspace.artifact<EligibilityPoolEntryV2>(hash, "EligibilityPoolEntryV2")),
    );
  };

  const buildPool = (): SelectionPool => {
    const built = buildEligibilityPool({
      poolId: `pool-${workspace.runId.slice(0, 8)}`,
      selectionRequestHash: requestHash,
      journeySelectionPolicyHash: role("journey-selection-policy"),
      selectionRandomnessPolicyHash: policyHash,
      randomnessSourceId: beacon.sourceId,
      randomnessSourceTrustPolicyHash: sourceTrust.sourceTrustPolicyHash,
      roleAudit,
      roleAuditHash,
      candidates,
      custodians,
      revealThreshold: REVEAL_THRESHOLD,
      decryptionReleasePolicyHash: accessLogHeadHash,
      hiddenPayloadSchemaHash: accessLogHeadHash,
      eligibilityProofHash: accessLogHeadHash,
      governorKey: keys.challengeGovernor,
      entrySignerKey: keys.entrySigner,
      store: workspace.store,
      clock,
      random: selectionRandom(workspace.runId),
      expiresAt: input.expiresAt,
    });
    return { manifest: built.manifest, manifestHash: built.manifestHash, entries: built.entries };
  };

  const ctx: SelectionContext = {
    runId: workspace.runId,
    request,
    requestHash,
    roleAudit,
    policy,
    policyHash,
    // Late-bound; `advanceSelection` merges the pool it built or loaded.
    pool: loadPool() ?? ({ entries: [] } as never),
    beacon,
    trust,
    timestamps: new TimestampLog({
      logId: `selection-${workspace.runId.slice(0, 8)}`,
      runId: workspace.runId,
      authority: keys.timestampAuthority,
      clock,
    }),
    store: workspace.store,
    clock,
    keys: {
      selector: keys.selector,
      wrapperSigner: keys.wrapperSigner,
      sourceTrustVerifier: keys.auditor,
      revealAuthority: keys.revealAuthority,
      // ADR-ERL2-020 §3: the verification receipt is the auditor's, never the
      // evaluator's — the evaluation authority must not attest that the
      // selection it will be judged against was correctly verified.
      verifier: keys.auditor,
      custodians,
      custodianSigners: keys.custodianSigners,
    },
    accessLogHeadHash,
    revealThreshold: REVEAL_THRESHOLD,
  };

  return { ctx, prelude: { request, roleAudit, buildPool, loadPool } };
}
