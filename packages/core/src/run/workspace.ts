/**
 * The run workspace: the generic journey from acquisition to frozen subject
 * output, and the early terminals (design v2 §11.1/§12, implementation plan §10).
 *
 * The enforced order is exactly the design's:
 *
 * ```text
 * acquisition preregistration -> measured acquisition -> acquired-byte freeze
 * -> package verification -> exact subject package manifest
 * -> challenge request -> ... selection ... -> subject output freeze
 * ```
 *
 * A workspace is re-openable between processes: the lifecycle log recovers from
 * its frozen events and every prior artifact is resolved by role from that
 * chain, so each CLI command is a separate process operating on durable state.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  assertContract,
  CODES,
  Erl2Error,
  packageMediaType,
  parseStrictJson,
  type AcquisitionAdapterRequestV1,
  type AcquisitionPreregistrationV1,
  type AcquisitionPreregistrationVerificationReceiptV1,
  type AcquisitionSourceManifestV1,
  type ArtifactRef,
  type DomainResultNotApplicableV1,
  type FindingV1,
  type GenericEvaluationIndexV1,
  type GenericPrecleanupResultJoinV1,
  type GenericRunPolicyV1,
  type CancellationRequestV1,
  type Hash,
  type Instant,
  type InvalidLabRunRecordV1,
  type JourneyStepCommitmentV1,
  type JourneyStepOutcomeV1,
  type JudgeExpectationRevealRecordV1,
  type JudgeJourneyExpectationV1,
  type MetricDefinitionV1,
  type MetricResultV1,
  type PackageVerificationRequestV1,
  type PreEnvironmentCleanupVerificationV1,
  type PreEnvironmentFinalLabAttestationV1,
  type PreEnvironmentLabRunRecordV1,
  type PreEnvironmentPublicVerificationBundleV2,
  type PreEnvironmentSubjectOutputManifestV1,
  type PreEnvironmentValidityResultV1,
  type PreSelectionJourneyResultV1,
  type SubjectAcquisitionRecordV1,
  type SubjectAdapterManifestV1,
  type SubjectPackageManifestV1,
  type SubjectPackageVerificationRecordV1,
  type SubjectVisibleJourneyStepV1,
  type Tier,
  type TrustedTimestampCheckpointV1,
} from "@erl2/contracts";
import {
  ageDecrypt,
  ArtifactStore,
  assertNotSelfAnchoring,
  coreHash,
  hashBytes,
  sealSigned,
  signCoreHash,
  SIGNATURE_DOMAINS,
  treeHash,
  type AgeIdentity,
  type SigningKey,
} from "@erl2/integrity";
import { LifecycleLog, verifyLifecycleChain } from "../lifecycle/log.js";
import { assertSubjectPortExecutable, TERMINAL_STATES, type LabState } from "../lifecycle/states.js";
import { GenericStepEngine, deriveStepClosure } from "../journey/engine.js";
import { assertVisibleStepMatchesCommitment } from "../journey/steps.js";
import { assertNoCanaryLeak, type OracleScanTarget } from "../journey/oracle.js";
import {
  assertDevelopmentSubjectPort,
  type SubjectPort,
} from "../journey/subjectPort.js";
import { AdmissionRegistry } from "../registry/admission.js";
import { TimestampLog } from "../timestamps/log.js";
import type { Clock } from "../runtime/seams.js";
import {
  assertClaimedOrderMatchesDerived,
  buildPreSelectionJourneyResult,
  type AssistanceSummary,
} from "../evaluation/journey.js";
import { buildDomainNotApplicable } from "../evaluation/domain.js";
import {
  assertFindingOwnershipConsistent,
  buildSubjectFinding,
} from "../evaluation/findings.js";
import {
  buildGenericEvaluationIndex,
  buildPrecleanupResultJoin,
  deriveJoinOrdering,
} from "../evaluation/join.js";
import { buildPreEnvironmentValidity, type GateResult } from "../evaluation/validity.js";
import { buildPreEnvironmentCleanup } from "../cleanup/cleanup.js";
import {
  assertFinalizable,
  buildPreEnvironmentAttestation,
  buildPreEnvironmentBundle,
  buildPreEnvironmentRunRecord,
  buildPreEnvironmentSignerInventory,
  type SignerInventoryEntryInput,
} from "../terminal/finalize.js";

/** The evaluator release recorded in every `GenericEvaluationIndexV1`. */
export const EVALUATOR_RELEASE = "erl2-generic-evaluator/0.1.0";

export interface WorkspaceKeyring {
  readonly preregistrar: SigningKey;
  readonly finalizer: SigningKey;
  /** Anchors frozen artifacts in the acyclic timestamp log. */
  readonly timestampAuthority: SigningKey;
  /** Signs evaluation-owned artifacts; distinct from the finalizer. */
  readonly evaluator: SigningKey;
}

export interface OpenWorkspaceOptions {
  readonly runId: string;
  readonly runRoot: string;
  readonly registry: AdmissionRegistry;
  readonly clock: Clock;
  readonly keyring: WorkspaceKeyring;
  readonly tier: Tier;
  readonly subjectPort: SubjectPort;
}

interface IndexedArtifact {
  readonly coreHash: Hash;
  readonly schemaVersion: string;
  readonly value: Record<string, unknown>;
}

export class RunWorkspace {
  readonly runId: string;
  readonly store: ArtifactStore;
  readonly lifecycle: LifecycleLog;
  readonly registry: AdmissionRegistry;
  readonly tier: Tier;
  private readonly clock: Clock;
  private readonly keyring: WorkspaceKeyring;
  private readonly port: SubjectPort;
  private readonly engine: GenericStepEngine;

  constructor(options: OpenWorkspaceOptions) {
    assertDevelopmentSubjectPort(options.tier, options.subjectPort.portId);
    this.runId = options.runId;
    this.store = new ArtifactStore(options.runRoot);
    this.lifecycle = new LifecycleLog({
      runId: options.runId,
      store: this.store,
      clock: options.clock,
    });
    this.registry = options.registry;
    this.tier = options.tier;
    this.clock = options.clock;
    this.keyring = options.keyring;
    this.port = options.subjectPort;
    this.engine = new GenericStepEngine({
      runId: options.runId,
      lifecycle: this.lifecycle,
      store: this.store,
      clock: options.clock,
    });
  }

  // -- artifact resolution -------------------------------------------------

  /** Core hash the lifecycle says was produced under `role`, if any. */
  hashForRole(role: string): Hash | undefined {
    for (const event of [...this.lifecycle.all()].reverse()) {
      const produced = event.produced.find((p) => p.artifact_role === role);
      if (produced) return produced.artifact_core_hash;
    }
    return undefined;
  }

  requireHashForRole(role: string): Hash {
    const hash = this.hashForRole(role);
    if (!hash) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_MISSING_ROLE,
        `this run has not yet produced a ${role}; the ordered journey forbids skipping it`,
      );
    }
    return hash;
  }

  /** Reads a retained artifact by core hash, re-verifying its declared hash. */
  artifact<T>(hash: Hash, contractName: string): T {
    const found = this.index().get(hash);
    if (!found) {
      throw new Erl2Error(CODES.ARTIFACT_NOT_FOUND, `no retained artifact with core hash ${hash}`);
    }
    return assertContract<T>(contractName, found.value);
  }

  private index(): Map<string, IndexedArtifact> {
    const out = new Map<string, IndexedArtifact>();
    const walk = (absolute: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(absolute);
      } catch {
        return;
      }
      for (const name of entries.sort()) {
        const child = path.join(absolute, name);
        if (statSync(child).isDirectory()) {
          // `state/` holds the derived snapshot cache and the run lease — never
          // artifacts.  Walking it would let a torn snapshot crash every command
          // that builds the index (§11.9); it is authoritative for nothing.
          if (absolute === this.store.root && name === "state") continue;
          walk(child);
          continue;
        }
        if (!name.endsWith(".json") || name.endsWith(".frozen")) continue;
        let value: unknown;
        try {
          value = parseStrictJson(readFileSync(child, "utf8"));
        } catch {
          continue; // a file that is not well-formed JSON is not a retained artifact.
        }
        if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        const declared = record["core_hash"];
        const schemaVersion = record["schema_version"];
        if (typeof declared !== "string" || typeof schemaVersion !== "string") continue;
        const recomputed = coreHash(record);
        if (recomputed !== declared) {
          throw new Erl2Error(
            CODES.ARTIFACT_HASH_MISMATCH,
            `retained artifact ${name} was mutated after freezing`,
          );
        }
        out.set(recomputed, { coreHash: recomputed, schemaVersion, value: record });
      }
    };
    walk(this.store.root);
    return out;
  }

  // -- 1. acquisition preregistration --------------------------------------

  /**
   * Freezes the preregistration before any network or store access.
   *
   * `selected_case_identity` is the literal `"absent"`, and the schema forbids
   * every later-phase ancestor, so a preregistration cannot carry challenge,
   * environment or truth identity (ERL2-FR-003).
   */
  preregisterAcquisition(input: {
    readonly sourceManifestHash: Hash;
    readonly adapterManifestHash: Hash;
    readonly genericRunPolicyHash: Hash;
    readonly runTrustPolicyHash: Hash;
    readonly acquisitionActorScriptHash: Hash;
    readonly acquisitionActorSchemaHash: Hash;
    readonly acquisitionStepCommitmentHash: Hash;
    readonly packageVerificationStepCommitmentHash: Hash;
    readonly limitsHash: Hash;
    readonly expiresAt: string;
  }): AcquisitionPreregistrationV1 {
    // Every referenced artifact must already be admitted.
    this.registry.require<AcquisitionSourceManifestV1>(
      input.sourceManifestHash,
      "AcquisitionSourceManifestV1",
    );
    this.registry.require<SubjectAdapterManifestV1>(
      input.adapterManifestHash,
      "SubjectAdapterManifestV1",
    );
    this.registry.require<GenericRunPolicyV1>(input.genericRunPolicyHash, "GenericRunPolicyV1");
    this.registry.require<JourneyStepCommitmentV1>(
      input.acquisitionStepCommitmentHash,
      "JourneyStepCommitmentV1",
    );
    this.registry.require<JourneyStepCommitmentV1>(
      input.packageVerificationStepCommitmentHash,
      "JourneyStepCommitmentV1",
    );

    const preregistration = assertContract<AcquisitionPreregistrationV1>(
      "AcquisitionPreregistrationV1",
      sealSigned(
        {
          schema_version: "acquisition-preregistration/v1" as const,
          preregistration_id: `prereg-${this.runId.slice(0, 8)}`,
          run_id: this.runId,
          acquisition_source_manifest_hash: input.sourceManifestHash,
          adapter_manifest_hash: input.adapterManifestHash,
          acquisition_actor_script_hash: input.acquisitionActorScriptHash,
          acquisition_actor_schema_hash: input.acquisitionActorSchemaHash,
          acquisition_step_commitment_hash: input.acquisitionStepCommitmentHash,
          package_verification_step_commitment_hash: input.packageVerificationStepCommitmentHash,
          generic_run_policy_hash: input.genericRunPolicyHash,
          run_trust_policy_hash: input.runTrustPolicyHash,
          limits_hash: input.limitsHash,
          registered_at: this.clock.now(),
          expires_at: input.expiresAt,
          selected_case_identity: "absent" as const,
        },
        this.keyring.preregistrar,
      ),
    );
    const preregRef = this.store.freezeJson(
      "retained/acquisition-preregistration.json",
      preregistration,
      "INTERNAL",
    );
    void preregRef;

    const receipt = assertContract<AcquisitionPreregistrationVerificationReceiptV1>(
      "AcquisitionPreregistrationVerificationReceiptV1",
      sealSigned(
        {
          schema_version: "acquisition-preregistration-verification-receipt/v1" as const,
          run_id: this.runId,
          acquisition_preregistration_hash: preregistration.core_hash,
          source_manifest_hash: input.sourceManifestHash,
          adapter_manifest_hash: input.adapterManifestHash,
          trust_policy_hash: input.runTrustPolicyHash,
          selected_case_identity_absent: true as const,
          signature_valid: true as const,
          verified_at: this.clock.now(),
        },
        this.keyring.preregistrar,
      ),
    );
    this.store.freezeJson(
      "retained/acquisition-preregistration-verification-receipt.json",
      receipt,
      "INTERNAL",
    );
    // Mirror the admitted source manifest into the run so the offline verifier
    // can resolve it without the governor registry.
    const sourceManifest = this.registry.require<AcquisitionSourceManifestV1>(
      input.sourceManifestHash,
      "AcquisitionSourceManifestV1",
    );
    this.store.freezeJson("retained/acquisition-source-manifest.json", sourceManifest, "INTERNAL");
    const adapterManifest = this.registry.require<SubjectAdapterManifestV1>(
      input.adapterManifestHash,
      "SubjectAdapterManifestV1",
    );
    this.store.freezeJson("retained/adapter-manifest.json", adapterManifest, "INTERNAL");
    const runPolicy = this.registry.require<GenericRunPolicyV1>(
      input.genericRunPolicyHash,
      "GenericRunPolicyV1",
    );
    this.store.freezeJson("retained/generic-run-policy.json", runPolicy, "INTERNAL");
    // The run trust policy is mirrored too, so an offline verifier can resolve
    // trust at creation from the run alone. It is still *authorized* only by the
    // verifier's own locally pinned root — the mirrored copy is evidence, not
    // authority (design v2 §14).
    const trustPolicy = this.registry.tryGet(input.runTrustPolicyHash);
    if (trustPolicy !== undefined && trustPolicy.schemaVersion === "trust-policy-manifest/v2") {
      this.store.freezeJson("retained/trust-policy.json", trustPolicy.value, "PUBLIC");
    }

    this.lifecycle.append({
      eventType: "acquisition_preregistered",
      stateTo: "acquisition_preregistered",
      actorId: "operator",
      commandId: "preregister-acquisition",
      operationId: "op-preregister",
      produced: [
        {
          artifact_role: "acquisition-preregistration",
          artifact_core_hash: preregistration.core_hash,
          artifact_schema_version: "acquisition-preregistration/v1",
        },
        {
          artifact_role: "acquisition-source-manifest",
          artifact_core_hash: input.sourceManifestHash,
          artifact_schema_version: "acquisition-source-manifest/v1",
        },
        {
          artifact_role: "acquisition-preregistration-verification-receipt",
          artifact_core_hash: receipt.core_hash,
          artifact_schema_version: "acquisition-preregistration-verification-receipt/v1",
        },
        {
          artifact_role: "adapter-manifest",
          artifact_core_hash: input.adapterManifestHash,
          artifact_schema_version: "subject-adapter-manifest/v1",
        },
        {
          artifact_role: "generic-run-policy",
          artifact_core_hash: input.genericRunPolicyHash,
          artifact_schema_version: "generic-run-policy/v1",
        },
      ],
    });
    return preregistration;
  }

  // -- 2. measured acquisition ---------------------------------------------

  /** Runs the acquire step through the generic engine and measures it. */
  acquire(): SubjectAcquisitionRecordV1 {
    // Idempotent replay (P1-2, §7.3): if the acquire outcome is already durably
    // recorded in the lifecycle, a replayed or retried command returns the
    // existing record and does NOT re-invoke the subject port or re-freeze
    // bytes.  This is what makes an ordinary retry — or a resumed script that
    // re-issues `acquire` — a no-op rather than a wedge, and guarantees the
    // external acquisition mutation is never duplicated.
    const alreadyAcquired = this.hashForRole("acquisition-record");
    if (alreadyAcquired !== undefined) {
      return this.artifact<SubjectAcquisitionRecordV1>(alreadyAcquired, "SubjectAcquisitionRecordV1");
    }
    // Pre-dispatch state validation (P2-5): a fresh subject execution must never
    // reach the port on a revealed, finalized or invalidating run.  Checked
    // before any port call or freeze, so a refusal has zero external effect.
    assertSubjectPortExecutable(this.lifecycle.currentState);
    const preregHash = this.requireHashForRole("acquisition-preregistration");
    const prereg = this.artifact<AcquisitionPreregistrationV1>(
      preregHash,
      "AcquisitionPreregistrationV1",
    );
    const commitment = this.registry.require<JourneyStepCommitmentV1>(
      prereg.acquisition_step_commitment_hash,
      "JourneyStepCommitmentV1",
    );
    const visibleStep = this.visibleStepFor(commitment);

    const request = assertContract<AcquisitionAdapterRequestV1>("AcquisitionAdapterRequestV1", {
      schema_version: "acquisition-adapter-request/v1" as const,
      protocol_version: "subject-adapter/v1" as const,
      run_id: this.runId,
      operation_id: "op-acquire",
      acquisition_preregistration_hash: preregHash,
      acquisition_source_manifest_hash: prereg.acquisition_source_manifest_hash,
      adapter_manifest_hash: prereg.adapter_manifest_hash,
      visible_step: {
        artifact: this.visibleStepRef(visibleStep),
        core_hash: visibleStep.core_hash,
      },
      credential_handle_ids: [],
      resource_limit_hash: prereg.limits_hash,
      deadline: prereg.expires_at,
      core_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as Hash,
    });
    const sealedRequest = { ...request, core_hash: coreHash(request) };
    this.assertRequestOracleClean("acquisition adapter request", sealedRequest);

    const response = this.port.acquire(sealedRequest);
    let acquiredArtifact: ArtifactRef | undefined;
    if (response.status === "succeeded" && response.packageBytes) {
      acquiredArtifact = this.store.freeze({
        logicalPath: "raw/acquired-package.bin",
        bytes: response.packageBytes,
        // The package kind travels as the frozen artifact's media type; it is
        // the one subject-visible, pre-verification signal an adapter has.
        mediaType: packageMediaType("archive"),
        classification: "INTERNAL",
      });
    }

    const recordBase = {
      schema_version: "subject-acquisition-record/v1" as const,
      run_id: this.runId,
      acquisition_request_hash: sealedRequest.core_hash,
      step_commitment_hash: commitment.core_hash,
      source_manifest_hash: prereg.acquisition_source_manifest_hash,
      attempts: response.attempts.map((a) => ({
        attempt_id: a.attemptId,
        started_at: this.clock.now(),
        ended_at: this.clock.now(),
        status: a.status,
        bytes: a.bytes,
        redirect_count: a.redirectCount,
        error_codes: [...a.errorCodes],
      })),
      authentication_prompt_count: response.authenticationPromptCount,
      documentation_step_ids: [...response.documentationStepIds],
      active_operator_ms: response.activeOperatorMs,
      elapsed_ms: response.elapsedMs,
      ...(acquiredArtifact === undefined ? {} : { acquired_artifact: acquiredArtifact }),
      lab_network_control_hash: coreHash({ control: "lab-network", healthy: true }),
      status: response.status === "succeeded" ? ("completed" as const) : (response.status as "failed" | "unsupported"),
    };
    const record = assertContract<SubjectAcquisitionRecordV1>("SubjectAcquisitionRecordV1", {
      ...recordBase,
      core_hash: coreHash(recordBase),
    });
    this.store.freezeJson("retained/subject-acquisition-record.json", record, "INTERNAL");

    this.engine.runStep({
      stepId: visibleStep.step_id,
      intent: "acquire",
      stepCommitmentHash: commitment.core_hash,
      visibleStepHash: visibleStep.core_hash,
      adapterRequestHash: sealedRequest.core_hash,
      actorId: "operator",
      commandId: "acquire",
      execute: () => ({
        status: response.status,
        attemptRecordHashes: [],
        detailRecordHashes: [record.core_hash],
        activeOperatorMs: response.activeOperatorMs,
        ...(response.errorCode === undefined ? {} : { errorCode: response.errorCode }),
      }),
      additionalProduced: [
        {
          artifact_role: "acquisition-record",
          artifact_core_hash: record.core_hash,
          artifact_schema_version: "subject-acquisition-record/v1",
        },
      ],
    });
    return record;
  }

  // -- 3. freeze the acquired bytes ----------------------------------------

  /**
   * Copies the acquired artifact into the content-addressed package store.
   *
   * Nothing downstream may reference the mutable acquisition path: a package is
   * its exact bytes.
   */
  freezePackage(): ArtifactRef {
    const record = this.artifact<SubjectAcquisitionRecordV1>(
      this.requireHashForRole("acquisition-record"),
      "SubjectAcquisitionRecordV1",
    );
    if (record.status !== "completed" || !record.acquired_artifact) {
      throw new Erl2Error(
        CODES.SUBJECT_ACQUIRE_SOURCE_UNREACHABLE,
        "there are no acquired bytes to freeze; acquisition did not complete",
        { owner: "subject" },
      );
    }
    const bytes = this.store.read(record.acquired_artifact.path);
    const digest = hashBytes(bytes);
    const ref = this.store.freeze({
      logicalPath: `retained/package-store/sha256/${digest.slice("sha256:".length)}.bin`,
      bytes,
      mediaType: packageMediaType("archive"),
      classification: "INTERNAL",
    });
    this.lifecycle.append({
      eventType: "subject_package_frozen",
      stateTo: "subject_package_frozen",
      actorId: "operator",
      commandId: "freeze-package",
      operationId: "op-freeze-package",
      requiredHashes: [record.core_hash],
    });
    return ref;
  }

  // -- 4. package verification and the exact package manifest --------------

  verifyPackage(): SubjectPackageVerificationRecordV1 {
    // Idempotent replay (P1-2): the package verification already ran if its
    // record is durably recorded; a replay returns it without re-invoking the
    // port.
    const alreadyVerified = this.hashForRole("package-verification-record");
    if (alreadyVerified !== undefined) {
      return this.artifact<SubjectPackageVerificationRecordV1>(
        alreadyVerified,
        "SubjectPackageVerificationRecordV1",
      );
    }
    // Pre-dispatch state validation (P2-5), before any port call or freeze.
    assertSubjectPortExecutable(this.lifecycle.currentState);
    const preregHash = this.requireHashForRole("acquisition-preregistration");
    const prereg = this.artifact<AcquisitionPreregistrationV1>(
      preregHash,
      "AcquisitionPreregistrationV1",
    );
    const acquisitionHash = this.requireHashForRole("acquisition-record");
    const acquisition = this.artifact<SubjectAcquisitionRecordV1>(
      acquisitionHash,
      "SubjectAcquisitionRecordV1",
    );
    const frozen = acquisition.acquired_artifact;
    if (!frozen) {
      throw new Erl2Error(
        CODES.SUBJECT_ACQUIRE_SOURCE_UNREACHABLE,
        "package verification requires frozen acquired bytes",
      );
    }
    const sourceManifest = this.registry.require<AcquisitionSourceManifestV1>(
      prereg.acquisition_source_manifest_hash,
      "AcquisitionSourceManifestV1",
    );
    const commitment = this.registry.require<JourneyStepCommitmentV1>(
      prereg.package_verification_step_commitment_hash,
      "JourneyStepCommitmentV1",
    );
    const visibleStep = this.visibleStepFor(commitment);

    const requestBase = {
      schema_version: "package-verification-request/v1" as const,
      protocol_version: "subject-adapter/v1" as const,
      run_id: this.runId,
      operation_id: "op-verify-package",
      acquisition_preregistration_hash: preregHash,
      acquisition_record_hash: acquisitionHash,
      frozen_acquired_artifact: frozen,
      frozen_package_file_sha256: frozen.file_sha256,
      integrity_policy_hash: sourceManifest.integrity_policy_hash,
      provenance_policy_hash: sourceManifest.provenance_policy_hash,
      adapter_manifest_hash: prereg.adapter_manifest_hash,
      visible_step: {
        artifact: this.visibleStepRef(visibleStep),
        core_hash: visibleStep.core_hash,
      },
      deadline: prereg.expires_at,
    };
    const request = assertContract<PackageVerificationRequestV1>("PackageVerificationRequestV1", {
      ...requestBase,
      core_hash: coreHash(requestBase),
    });
    this.assertRequestOracleClean("package verification request", request);

    const response = this.port.validatePackage(request);
    const recordBase = {
      schema_version: "subject-package-verification-record/v1" as const,
      run_id: this.runId,
      verification_request_hash: request.core_hash,
      step_commitment_hash: commitment.core_hash,
      acquisition_record_hash: acquisitionHash,
      frozen_package_file_sha256: frozen.file_sha256,
      integrity_policy_hash: sourceManifest.integrity_policy_hash,
      provenance_policy_hash: sourceManifest.provenance_policy_hash,
      checks: [
        {
          check_id: "frozen-digest-matches-acquisition",
          passed: response.status === "succeeded",
          evidence_refs: [frozen.file_sha256],
        },
      ],
      // `unsupported` is retained as its own status; it is never collapsed into
      // a failure, because an unsupported input must remain an admitted result
      // (ERL2-FR-005).
      status:
        response.status === "succeeded"
          ? ("completed" as const)
          : (response.status as "failed" | "unsupported"),
      started_at: this.clock.now(),
      ended_at: this.clock.now(),
    };
    const record = assertContract<SubjectPackageVerificationRecordV1>(
      "SubjectPackageVerificationRecordV1",
      { ...recordBase, core_hash: coreHash(recordBase) },
    );
    this.store.freezeJson("retained/subject-package-verification-record.json", record, "INTERNAL");

    // A failed or unsupported verification is attributable to the subject only
    // because the Lab's own controls passed: the bytes were frozen before the
    // check, the freezer and validator ran, and the adapter answered on the
    // public protocol. `buildSubjectFinding` refuses to construct the finding at
    // all if any of those prerequisites is missing, and `subject_unsupported`
    // scores on no plane because unsupported is a retained result, not a defect.
    const findings: { role: string; hash: Hash }[] = [];
    if (record.status !== "completed") {
      const finding = buildSubjectFinding({
        findingId:
          record.status === "unsupported"
            ? "subject-package-kind-unsupported"
            : "subject-package-verification-failure",
        runId: this.runId,
        journeyStepId: visibleStep.step_id,
        severity: record.status === "unsupported" ? "info" : "high",
        proofRefs: [record.core_hash, frozen.file_sha256],
        summary:
          record.status === "unsupported"
            ? "The subject declared the acquired package kind unsupported; the admitted case is retained unchanged."
            : "The acquired package did not satisfy the committed integrity and provenance policy.",
        category:
          record.status === "unsupported"
            ? "subject_unsupported"
            : "subject_package_verification_failure",
        prerequisites: {
          baselineValid: true,
          revealedJudgeExpectationHash: undefined,
          adapterFunctioning: true,
          withinSubjectBoundary: true,
          counterfactualControlRefs: [sourceManifest.integrity_policy_hash],
          unresolvedLabOrDependencyCauses: [],
        },
        scoreablePlanes: record.status === "unsupported" ? [] : ["journey"],
      });
      this.store.freezeJson(`retained/finding-${finding.finding_id}.json`, finding, "INTERNAL");
      findings.push({ role: "finding", hash: finding.core_hash });
    }

    this.engine.runStep({
      stepId: visibleStep.step_id,
      intent: "verify_package",
      stepCommitmentHash: commitment.core_hash,
      visibleStepHash: visibleStep.core_hash,
      adapterRequestHash: request.core_hash,
      actorId: "operator",
      commandId: "verify-package",
      execute: () => ({
        status: response.status,
        attemptRecordHashes: [],
        detailRecordHashes: [record.core_hash],
        activeOperatorMs: response.activeOperatorMs,
        ...(response.errorCode === undefined ? {} : { errorCode: response.errorCode }),
      }),
      additionalProduced: [
        {
          artifact_role: "package-verification-record",
          artifact_core_hash: record.core_hash,
          artifact_schema_version: "subject-package-verification-record/v1",
        },
        ...findings.map((f) => ({
          artifact_role: f.role,
          artifact_core_hash: f.hash,
          artifact_schema_version: "finding/v1",
        })),
      ],
    });
    return record;
  }

  /** Only a successful verification record may create the package manifest. */
  freezePackageManifest(input: {
    readonly subjectId: string;
    readonly subjectVersion: string;
  }): SubjectPackageManifestV1 {
    const verification = this.artifact<SubjectPackageVerificationRecordV1>(
      this.requireHashForRole("package-verification-record"),
      "SubjectPackageVerificationRecordV1",
    );
    if (verification.status !== "completed") {
      throw new Erl2Error(
        CODES.SUBJECT_PACKAGE_VERIFICATION_FAILED,
        "a package manifest requires a successful verification record",
        { owner: "subject" },
      );
    }
    const acquisitionHash = this.requireHashForRole("acquisition-record");
    // The configuration-schema and capability-declaration hashes bind the
    // package to the *actual admitted adapter's* declarations (review §11.6):
    // the adapter manifest was admitted and frozen at preregistration and is the
    // authentic source of the subject's projection (configuration) schema and
    // its declared capabilities. Hardcoding `fake-subject/v1` here made every
    // manifest carry identical hashes regardless of the real subject.
    const adapterManifest = this.artifact<SubjectAdapterManifestV1>(
      this.requireHashForRole("adapter-manifest"),
      "SubjectAdapterManifestV1",
    );
    const base = {
      schema_version: "subject-package-manifest/v1" as const,
      subject_id: input.subjectId,
      subject_version: input.subjectVersion,
      package_kind: "archive" as const,
      acquisition_record_hash: acquisitionHash,
      package_verification_record_hash: verification.core_hash,
      package_file_sha256: verification.frozen_package_file_sha256,
      provenance: {
        producer: "erl2-acquisition",
        producer_version: "0.1.0",
        transformations: ["copied-to-content-addressed-package-store"],
      },
      signature_evidence: [] as ArtifactRef[],
      entrypoints: ["main"],
      runtime_requirements: ["node>=22"],
      requested_resources: {
        cpu_millis: 1000,
        memory_mib: 512,
        disk_mib: 1024,
        network_profile: "deny-by-default",
      },
      configuration_schema_hash: coreHash({
        configuration_schema: {
          adapter_id: adapterManifest.adapter_id,
          protocol_version: adapterManifest.protocol_version,
          projection_schema: adapterManifest.projection_schema,
        },
      }),
      capability_declaration_hash: coreHash({
        capability_declaration: {
          adapter_id: adapterManifest.adapter_id,
          adapter_version: adapterManifest.version,
          supported_package_kinds: adapterManifest.supported_package_kinds,
          operations: adapterManifest.operations,
          required_broker_capabilities: adapterManifest.required_broker_capabilities,
          network_allowlist_ids: adapterManifest.network_allowlist_ids,
        },
      }),
    };
    const manifest = assertContract<SubjectPackageManifestV1>("SubjectPackageManifestV1", {
      ...base,
      core_hash: coreHash(base),
    });
    this.store.freezeJson("retained/subject-package-manifest.json", manifest, "INTERNAL");
    this.lifecycle.append({
      eventType: "package_manifest_frozen",
      stateTo: "package_manifest_frozen",
      actorId: "operator",
      commandId: "verify-package",
      operationId: "op-package-manifest",
      produced: [
        {
          artifact_role: "subject-package-manifest",
          artifact_core_hash: manifest.core_hash,
          artifact_schema_version: "subject-package-manifest/v1",
        },
      ],
    });
    return manifest;
  }

  // -- 5. subject output freeze --------------------------------------------

  /**
   * Freezes the pre-environment subject output.
   *
   * The ordered step-outcome closure is derived from lifecycle events, not from
   * a producer array (ERL2-FR-020). Output freezes *before* any reveal.
   *
   * A pre-environment terminal is reachable only from a *failed or unsupported*
   * acquire/verify_package outcome. A successful package verification freezes
   * `SubjectPackageManifestV1` and continues to challenge preregistration; the
   * pre-environment run-record, cleanup, validity and bundle variants have no
   * member that could close over that manifest, so finalizing here would leave
   * an unreachable retained artifact. The transition table already forbids the
   * edge; this is the typed refusal a caller sees (ADR-ERL2-013).
   */
  freezeSubjectOutput(options: {
    readonly terminalStage: "acquire" | "verify_package";
    readonly unsupportedInputs?: readonly string[];
  }): PreEnvironmentSubjectOutputManifestV1 {
    const packageManifestHash = this.hashForRole("subject-package-manifest");
    if (packageManifestHash !== undefined) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
        "a successful subject package manifest exists; the pre-environment terminal variant cannot close over it, so this run must continue to challenge preregistration",
      );
    }
    const derivedOutcomes = deriveStepClosure(this.lifecycle.all());
    if (derivedOutcomes.length === 0) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_MISSING_ROLE,
        "no step outcome has been frozen; there is nothing to freeze output for",
      );
    }
    const entries = derivedOutcomes.map((hash) => {
      const artifact = this.index().get(hash);
      /* c8 ignore next 3 */
      if (!artifact) {
        throw new Erl2Error(CODES.ARTIFACT_NOT_FOUND, `step outcome ${hash} is not retained`);
      }
      return this.store.freezeJson(
        `subject-output/step-outcome-${hash.slice("sha256:".length, "sha256:".length + 12)}.json`,
        artifact.value,
        "INTERNAL",
      );
    });

    const base = {
      schema_version: "subject-output-manifest/v1" as const,
      run_id: this.runId,
      terminal_stage: options.terminalStage,
      acquisition_source_manifest_hash: this.requireHashForRole("acquisition-source-manifest"),
      acquisition_record_hash: this.requireHashForRole("acquisition-record"),
      adapter_hash: this.requireHashForRole("adapter-manifest"),
      step_outcome_hashes: [...derivedOutcomes],
      interaction_hashes: [] as Hash[],
      entries,
      tree_hash: treeHash(entries),
      timed_out: false,
      unsupported_inputs: [...(options.unsupportedInputs ?? [])],
      frozen_at: this.clock.now(),
    };
    const manifest = assertContract<PreEnvironmentSubjectOutputManifestV1>(
      "PreEnvironmentSubjectOutputManifestV1",
      { ...base, core_hash: coreHash(base) },
    );
    this.store.freezeJson("retained/subject-output-manifest.json", manifest, "INTERNAL");
    this.lifecycle.append({
      eventType: "subject_output_frozen",
      stateTo: "subject_output_frozen",
      actorId: "operator",
      commandId: "freeze-output",
      operationId: "op-freeze-output",
      produced: [
        {
          artifact_role: "subject-output-manifest",
          artifact_core_hash: manifest.core_hash,
          artifact_schema_version: "subject-output-manifest/v1",
        },
      ],
    });
    return manifest;
  }

  // -- early invalid terminal ----------------------------------------------

  /**
   * Bounded cleanup from the *actual* resource frontier.
   *
   * The pre-environment cleanup-verification artifact requires a subject output
   * manifest, so it can only be produced once the run has reached subject
   * output.  A run that is invalidated or cancelled *before* subject output —
   * e.g. an ordinary replay/crash between acquire and freeze-output, or a
   * cancellation during acquisition — has no such artifact and must NOT demand
   * one: doing so (the prior `requireHashForRole("subject-output-manifest")`)
   * wedged a healthy run into `GRAPH_CLOSURE_MISSING_ROLE` with no terminal
   * record (review P1-2).  When the artifact cannot yet exist, the cleanup
   * variant is `none`; the acquisition temporaries are still the Lab's to
   * remove, but there is no verification member to freeze.
   */
  private freezeFrontierCleanup(
    terminalStage: "acquire" | "verify_package",
  ): { readonly variant: "none" | "pre_environment"; readonly resultHash?: Hash } {
    const acquisitionHash = this.hashForRole("acquisition-record");
    const subjectOutputHash = this.hashForRole("subject-output-manifest");
    if (acquisitionHash === undefined || subjectOutputHash === undefined) {
      return { variant: "none" };
    }
    const acquisition = this.artifact<SubjectAcquisitionRecordV1>(
      acquisitionHash,
      "SubjectAcquisitionRecordV1",
    );
    const cleanupBase = {
      schema_version: "pre-environment-cleanup-verification/v1" as const,
      run_id: this.runId,
      terminal_stage: terminalStage,
      acquisition_preregistration_hash: this.requireHashForRole("acquisition-preregistration"),
      acquisition_record_hash: acquisitionHash,
      subject_output_hash: subjectOutputHash,
      acquired_artifact_disposition: (acquisition.acquired_artifact === undefined
        ? "never_created"
        : "deleted") as "never_created" | "deleted",
      cleanup_receipt_hashes: [] as Hash[],
      residual_acquisition_resources: [] as { kind: string; identity_hash: Hash }[],
      verified_at: this.clock.now(),
      passed: true,
    };
    const cleanup = assertContract<PreEnvironmentCleanupVerificationV1>(
      "PreEnvironmentCleanupVerificationV1",
      { ...cleanupBase, core_hash: coreHash(cleanupBase) },
    );
    this.store.freezeJson("retained/pre-environment-cleanup-verification.json", cleanup, "INTERNAL");
    return { variant: "pre_environment", resultHash: cleanup.core_hash };
  }

  /**
   * Freezes exactly one `InvalidLabRunRecordV1` after bounded cleanup.
   *
   * A pre-environment failure has an empty resource frontier beyond the Lab's
   * own acquisition temporaries, so the cleanup variant is `pre_environment`
   * when bytes were acquired and `none` when nothing external was created. No
   * attestation and no bundle may descend from this record (ERL2-FR-001/026).
   */
  invalidate(input: {
    readonly phase: "acquisition" | "package_verification";
    /**
     * An event already in the chain that carries the failure. When the failure
     * happened outside the step submachine — an adapter that never produced a
     * response, for instance — omit it and supply `failure` instead, and the
     * detection event itself becomes the failure event.
     */
    readonly failureEventHash?: Hash;
    readonly failure?: {
      readonly code: string;
      readonly owner: "lab" | "external_dependency" | "adapter" | "subject" | "evaluator" | "inconclusive";
      readonly message: string;
    };
    readonly primaryFindingHash: Hash;
    readonly classification: "lab_invalidity" | "dependency_failure" | "adapter_failure" | "cleanup_failure";
  }): InvalidLabRunRecordV1 {
    // Design v2 §12 routes every invalid terminal through detection first, then
    // the frontier-derived cleanup branch. There is no direct edge from a step
    // failure to cleanup.
    let detection = this.lifecycle.find((e) => e.event_type === "invalid_failure_detected");
    if (this.lifecycle.currentState !== "invalid_failure_detected") {
      detection = this.lifecycle.append({
        eventType: "invalid_failure_detected",
        stateTo: "invalid_failure_detected",
        actorId: "operator",
        commandId: "cleanup",
        operationId: "op-invalid-detected",
        requiredHashes: [
          ...(input.failureEventHash === undefined ? [] : [input.failureEventHash]),
          input.primaryFindingHash,
        ],
        ...(input.failure === undefined ? {} : { failure: input.failure }),
      });
    }
    // The record must name an event that is actually in the chain.
    const failureEventHash = input.failureEventHash ?? (detection as { core_hash: Hash }).core_hash;

    this.lifecycle.append({
      eventType: "invalid_pre_environment_cleanup_started",
      stateTo: "invalid_pre_environment_cleanup_started",
      actorId: "operator",
      commandId: "cleanup",
      operationId: "op-invalid-cleanup-start",
    });

    const { variant: cleanupVariant, resultHash: cleanupResultHash } = this.freezeFrontierCleanup(
      input.phase === "acquisition" ? "acquire" : "verify_package",
    );

    const cleanupEvent = this.lifecycle.append({
      eventType: "invalid_cleanup_terminal",
      stateTo: "invalid_cleanup_terminal",
      actorId: "operator",
      commandId: "cleanup",
      operationId: "op-invalid-cleanup-terminal",
      ...(cleanupResultHash === undefined
        ? {}
        : {
            produced: [
              {
                artifact_role: "pre-environment-cleanup",
                artifact_core_hash: cleanupResultHash,
                artifact_schema_version: "pre-environment-cleanup-verification/v1",
              },
            ],
          }),
    });

    const reached: { artifact_role: string; artifact_hash: Hash; reached_event_hash: Hash }[] = [];
    for (const event of this.lifecycle.all()) {
      for (const produced of event.produced) {
        reached.push({
          artifact_role: produced.artifact_role,
          artifact_hash: produced.artifact_core_hash,
          reached_event_hash: event.core_hash,
        });
      }
    }
    // The primary finding is cited by the terminal reason, so it is reached
    // evidence too. Omitting it would leave a retained artifact the record does
    // not account for, which the closure verifier rejects as an extra.
    const detectionEvent = this.lifecycle.find((e) => e.event_type === "invalid_failure_detected");
    if (!reached.some((r) => r.artifact_hash === input.primaryFindingHash)) {
      reached.push({
        artifact_role: "primary-finding",
        artifact_hash: input.primaryFindingHash,
        reached_event_hash: detectionEvent?.core_hash ?? failureEventHash,
      });
    }

    const recordBase = {
      schema_version: "invalid-lab-run-record/v1" as const,
      run_id: this.runId,
      terminal_state: "invalidated" as const,
      failed_phase: {
        kind: "lifecycle_phase" as const,
        phase: input.phase,
        lifecycle_event_hash: failureEventHash,
      },
      terminal_reason: {
        kind: "classified_failure" as const,
        classification: input.classification,
        failure_event_hash: failureEventHash,
        primary_finding_hash: input.primaryFindingHash,
        ...(input.classification === "lab_invalidity" || input.classification === "cleanup_failure"
          ? { invalidity_finding_hash: input.primaryFindingHash }
          : {}),
      },
      available_evidence: reached,
      cleanup: {
        variant: cleanupVariant,
        status: (cleanupVariant === "none" ? "not_required" : "attempted_succeeded") as
          | "not_required"
          | "attempted_succeeded",
        attempt_hashes: [] as Hash[],
        ...(cleanupResultHash === undefined ? {} : { result_hash: cleanupResultHash }),
      },
      lifecycle_head_hash: cleanupEvent.core_hash,
      invalidated_at: this.clock.now(),
    };
    const record = assertContract<InvalidLabRunRecordV1>("InvalidLabRunRecordV1", {
      ...recordBase,
      core_hash: coreHash(recordBase),
    });
    this.store.freezeJson("retained/invalid-run-record.json", record, "INTERNAL");
    this.lifecycle.append({
      eventType: "invalid_lab_run_record_frozen",
      stateTo: "invalid_lab_run_record_frozen",
      actorId: "operator",
      commandId: "cleanup",
      operationId: "op-invalid-record",
      produced: [
        {
          artifact_role: "invalid-run-record",
          artifact_core_hash: record.core_hash,
          artifact_schema_version: "invalid-lab-run-record/v1",
        },
      ],
    });
    this.lifecycle.append({
      eventType: "invalidated",
      stateTo: "invalidated",
      actorId: "operator",
      commandId: "cleanup",
      operationId: "op-invalidated",
    });
    return record;
  }

  /**
   * Derives the cancellation phase from the observed lifecycle state.  Only
   * pre-environment states ship today; the environment-branch phases exist for
   * completeness and are wired to a journey intent by Slice 6.5.
   */
  private cancellationPhaseOf(
    state: LabState,
  ): "pre_environment" | "selection" | "environment_setup" | "cleanup" | "finalization" {
    if (state.startsWith("selection_") || state.startsWith("eligibility_") || state.includes("randomness")) {
      return "selection";
    }
    if (
      state === "case_selected" ||
      state === "environment_provisioned" ||
      state === "baseline_verified" ||
      state === "execution_plan_frozen"
    ) {
      return "environment_setup";
    }
    if (state.includes("cleanup") || state.startsWith("teardown") || state === "environment_restored") {
      return "cleanup";
    }
    if (state.includes("validity_result") || state === "generic_evaluation_index_frozen") {
      return "finalization";
    }
    return "pre_environment";
  }

  /**
   * Mandatory `cancel` terminal (design v2 §12).
   *
   * Cancellation is a first-class terminal, not a fixture-only condition: any
   * durably accepted, non-terminal run may be cancelled.  It freezes signed
   * cancellation evidence, records the exact phase, performs frontier-derived
   * cleanup, and freezes exactly one `InvalidLabRunRecordV1` with a cancellation
   * reason — never a fabricated finding (which the offline verifier refuses on a
   * cancellation terminal).  It refuses before run acceptance and after any
   * terminal completion.
   */
  cancel(input: {
    readonly reasonCode: string;
    readonly requestedByActorId: string;
  }): InvalidLabRunRecordV1 {
    const state = this.lifecycle.currentState;
    if (state === "created") {
      throw new Erl2Error(
        CODES.CANCELLATION_BEFORE_ACCEPTANCE,
        "a run that has not been durably accepted cannot be cancelled",
      );
    }
    if (TERMINAL_STATES.has(state) || state.startsWith("invalid")) {
      throw new Erl2Error(
        CODES.CANCELLATION_AFTER_TERMINAL,
        `run is already terminal or invalidating (state ${state}); it cannot be cancelled`,
      );
    }

    const cancelledDuring = this.cancellationPhaseOf(state);
    const requestBase = {
      schema_version: "cancellation-request/v1" as const,
      request_id: `cxl-${this.runId.slice(0, 8)}`,
      run_id: this.runId,
      cancelled_during: cancelledDuring,
      observed_state: state,
      requested_by_actor_id: input.requestedByActorId,
      reason_code: input.reasonCode,
      requested_at: this.clock.now() as Instant,
    };
    const request = assertContract<CancellationRequestV1>(
      "CancellationRequestV1",
      sealSigned(requestBase, this.keyring.finalizer),
    );
    this.store.freezeJson("retained/cancellation-request.json", request, "INTERNAL");

    const detection = this.lifecycle.append({
      eventType: "invalid_failure_detected",
      stateTo: "invalid_failure_detected",
      actorId: input.requestedByActorId,
      commandId: "cancel",
      operationId: "op-cancel-detected",
      requiredHashes: [request.core_hash],
    });

    this.lifecycle.append({
      eventType: "invalid_pre_environment_cleanup_started",
      stateTo: "invalid_pre_environment_cleanup_started",
      actorId: input.requestedByActorId,
      commandId: "cancel",
      operationId: "op-cancel-cleanup-start",
    });

    const terminalStage =
      this.hashForRole("package-verification-record") !== undefined ? "verify_package" : "acquire";
    const { variant: cleanupVariant, resultHash: cleanupResultHash } =
      this.freezeFrontierCleanup(terminalStage);

    const cleanupEvent = this.lifecycle.append({
      eventType: "invalid_cleanup_terminal",
      stateTo: "invalid_cleanup_terminal",
      actorId: input.requestedByActorId,
      commandId: "cancel",
      operationId: "op-cancel-cleanup-terminal",
      ...(cleanupResultHash === undefined
        ? {}
        : {
            produced: [
              {
                artifact_role: "pre-environment-cleanup",
                artifact_core_hash: cleanupResultHash,
                artifact_schema_version: "pre-environment-cleanup-verification/v1",
              },
            ],
          }),
    });

    const reached: { artifact_role: string; artifact_hash: Hash; reached_event_hash: Hash }[] = [];
    for (const event of this.lifecycle.all()) {
      for (const produced of event.produced) {
        reached.push({
          artifact_role: produced.artifact_role,
          artifact_hash: produced.artifact_core_hash,
          reached_event_hash: event.core_hash,
        });
      }
    }
    // The signed cancellation request is reached evidence; if omitted it would be
    // an unaccounted retained extra the closure verifier rejects.
    reached.push({
      artifact_role: "cancellation-request",
      artifact_hash: request.core_hash,
      reached_event_hash: detection.core_hash,
    });

    const recordBase = {
      schema_version: "invalid-lab-run-record/v1" as const,
      run_id: this.runId,
      terminal_state: "invalidated" as const,
      failed_phase: {
        kind: "cancellation" as const,
        cancelled_during: cancelledDuring,
        lifecycle_event_hash: detection.core_hash,
      },
      terminal_reason: {
        kind: "cancellation" as const,
        classification: "cancellation" as const,
        cancellation_request_hash: request.core_hash,
        cancellation_event_hash: detection.core_hash,
        requested_by_actor_hash: coreHash({ actor_id: input.requestedByActorId }),
        reason_code: input.reasonCode,
      },
      available_evidence: reached,
      cleanup: {
        variant: cleanupVariant,
        status: (cleanupVariant === "none" ? "not_required" : "attempted_succeeded") as
          | "not_required"
          | "attempted_succeeded",
        attempt_hashes: [] as Hash[],
        ...(cleanupResultHash === undefined ? {} : { result_hash: cleanupResultHash }),
      },
      lifecycle_head_hash: cleanupEvent.core_hash,
      invalidated_at: this.clock.now() as Instant,
    };
    const record = assertContract<InvalidLabRunRecordV1>("InvalidLabRunRecordV1", {
      ...recordBase,
      core_hash: coreHash(recordBase),
    });
    this.store.freezeJson("retained/invalid-run-record.json", record, "INTERNAL");
    this.lifecycle.append({
      eventType: "invalid_lab_run_record_frozen",
      stateTo: "invalid_lab_run_record_frozen",
      actorId: input.requestedByActorId,
      commandId: "cancel",
      operationId: "op-cancel-record",
      produced: [
        {
          artifact_role: "invalid-run-record",
          artifact_core_hash: record.core_hash,
          artifact_schema_version: "invalid-lab-run-record/v1",
        },
      ],
    });
    this.lifecycle.append({
      eventType: "invalidated",
      stateTo: "invalidated",
      actorId: input.requestedByActorId,
      commandId: "cancel",
      operationId: "op-cancel-invalidated",
    });
    return record;
  }

  /**
   * Freezes the adapter-owned finding that explains an adapter failure.
   *
   * `subject_attribution_proven` is a schema constant `false` and
   * `scoreable_planes` is empty: a broken or hostile adapter can never become a
   * subject-quality result, because the subject did not author the adapter
   * (ERL2-OPS-003, ERL2-AC-003).
   */
  freezeAdapterFailureFinding(input: {
    readonly findingId: string;
    readonly category: "adapter_protocol_failure" | "adapter_projection_failure" | "adapter_mutation_violation";
    readonly summary: string;
    readonly proofRefs: readonly Hash[];
  }): Hash {
    const adapterHash = this.requireHashForRole("adapter-manifest");
    const adapter = this.artifact<SubjectAdapterManifestV1>(adapterHash, "SubjectAdapterManifestV1");
    const base = {
      schema_version: "finding/v1" as const,
      kind: "adapter_failure" as const,
      finding_id: input.findingId,
      run_id: this.runId,
      severity: "critical" as const,
      proof_refs: [...input.proofRefs],
      safe_summary: input.summary.slice(0, 1024),
      owner: "adapter" as const,
      category: input.category,
      adapter_hash: adapterHash,
      certification_receipt_hash: adapter.certification_receipt_hash,
      subject_attribution_proven: false as const,
      scoreable_planes: [] as const,
    };
    const finding = assertContract<{ core_hash: Hash }>("AdapterFailureV1", {
      ...base,
      core_hash: coreHash(base),
    });
    this.store.freezeJson(`retained/finding-${input.findingId}.json`, finding, "INTERNAL");
    return finding.core_hash;
  }

  /** Freezes the Lab-owned finding that explains an invalid pre-environment terminal. */
  freezeInvalidityFinding(input: {
    readonly findingId: string;
    readonly category: "lab_invalid" | "lab_evidence_failure";
    readonly summary: string;
    readonly failedGateIds: readonly string[];
    readonly proofRefs: readonly Hash[];
  }): Hash {
    const base = {
      schema_version: "finding/v1" as const,
      kind: "lab_invalidity" as const,
      finding_id: input.findingId,
      run_id: this.runId,
      severity: "high" as const,
      proof_refs: [...input.proofRefs],
      safe_summary: input.summary,
      owner: "lab" as const,
      category: input.category,
      failed_gate_ids: [...input.failedGateIds],
      subject_attribution_proven: false as const,
      scoreable_planes: [] as const,
    };
    const finding = assertContract<{ core_hash: Hash }>("LabInvalidityV1", {
      ...base,
      core_hash: coreHash(base),
    });
    this.store.freezeJson(`retained/finding-${input.findingId}.json`, finding, "INTERNAL");
    return finding.core_hash;
  }

  // -- 6. reveal, evaluation and the pre-cleanup result join ----------------

  /**
   * Reveals the committed judge expectations for the failed and unsupported
   * steps only.
   *
   * The reveal happens strictly after `subject_output_frozen`, and the ciphertext
   * digest and plaintext core hash are both re-checked against the commitment,
   * so a substituted expectation is refused rather than believed. Functional
   * truth is not touched: only expectations whose committed `truth_scope` is
   * `journey_only` may be opened on this path, which is what keeps functional
   * mechanism truth encrypted at a pre-environment terminal.
   */
  revealJudgeExpectations(input: {
    readonly vaultRoot: string;
    readonly judgeIdentity: AgeIdentity;
  }): { readonly revealedExpectationHashes: readonly Hash[]; readonly recordHash: Hash } {
    if (this.hashForRole("subject-output-manifest") === undefined) {
      throw new Erl2Error(
        CODES.REVEAL_BEFORE_OUTPUT_FREEZE,
        "no judge expectation may be revealed before the subject output freezes",
      );
    }
    const outcomes = this.derivedStepOutcomes();
    const vault = new ArtifactStore(input.vaultRoot);
    const revealed: Hash[] = [];
    const revealedStepIds: string[] = [];

    for (const outcome of outcomes) {
      if (outcome.status === "succeeded") continue;
      const commitment = this.registry.require<JourneyStepCommitmentV1>(
        outcome.step_commitment_hash,
        "JourneyStepCommitmentV1",
      );
      const ciphertext = vault.read(commitment.judge_expectation_ciphertext.path);
      if (hashBytes(ciphertext) !== commitment.judge_expectation_ciphertext.file_sha256) {
        throw new Erl2Error(
          CODES.REVEAL_CIPHERTEXT_MISMATCH,
          `the retained expectation ciphertext for ${commitment.step_id} is not the committed one`,
        );
      }
      const plaintext = ageDecrypt(ciphertext, input.judgeIdentity);
      if (hashBytes(plaintext) !== commitment.judge_expectation_plaintext_file_sha256) {
        throw new Erl2Error(
          CODES.REVEAL_CIPHERTEXT_MISMATCH,
          `the decrypted expectation for ${commitment.step_id} does not match its commitment`,
        );
      }
      const expectation = assertContract<JudgeJourneyExpectationV1>(
        "JudgeJourneyExpectationV1",
        parseStrictJson(plaintext.toString("utf8")),
      );
      if (expectation.core_hash !== commitment.judge_expectation_core_hash) {
        throw new Erl2Error(
          CODES.REVEAL_CIPHERTEXT_MISMATCH,
          `the decrypted expectation for ${commitment.step_id} has a different identity`,
        );
      }
      if (expectation.truth_scope !== "journey_only") {
        throw new Erl2Error(
          CODES.REVEAL_TRUTH_SCOPE_FORBIDDEN,
          `expectation ${commitment.step_id} carries functional truth, which a pre-environment terminal may not open`,
        );
      }
      revealed.push(expectation.core_hash);
      revealedStepIds.push(expectation.step_id);
    }

    // The reveal record names *which* expectations opened. It carries no
    // expectation body, so retaining it leaks nothing.
    const base = {
      schema_version: "judge-expectation-reveal-record/v1" as const,
      run_id: this.runId,
      subject_output_hash: this.requireHashForRole("subject-output-manifest"),
      revealed_step_ids: revealedStepIds,
      revealed_expectation_hashes: revealed,
      revealed_at: this.clock.now(),
    };
    const record = assertContract<JudgeExpectationRevealRecordV1>(
      "JudgeExpectationRevealRecordV1",
      { ...base, core_hash: coreHash(base) },
    );
    this.store.freezeJson("retained/judge-expectation-reveal.json", record, "INTERNAL");
    this.lifecycle.append({
      eventType: "judge_journey_expectation_revealed",
      stateTo: "judge_journey_expectation_revealed",
      actorId: "judge",
      commandId: "reveal",
      operationId: "op-reveal-journey-expectations",
      requiredHashes: [base.subject_output_hash],
      produced: [
        {
          artifact_role: "judge-expectation-reveal",
          artifact_core_hash: record.core_hash,
          artifact_schema_version: "judge-expectation-reveal-record/v1",
        },
      ],
    });
    return { revealedExpectationHashes: revealed, recordHash: record.core_hash };
  }

  /**
   * Evaluates the journey and domain planes and closes the pre-cleanup join.
   *
   * A pre-environment terminal has no functional evidence by construction — no
   * environment was provisioned, no observation was captured and no canonical
   * evidence envelope exists — so the domain plane is *not applicable* with the
   * exact reason `pre_environment_terminal`. Inventing a functional score here
   * is precisely what design v2 §17 forbids.
   */
  evaluatePreEnvironment(input: {
    readonly revealedExpectationHashes: readonly Hash[];
    readonly journeyMetricDefinitions: readonly MetricDefinitionV1[];
    readonly findingHashes: readonly Hash[];
    readonly assistance?: AssistanceSummary;
  }): {
    readonly journeyResult: PreSelectionJourneyResultV1;
    readonly domainResult: DomainResultNotApplicableV1;
    readonly join: GenericPrecleanupResultJoinV1;
    readonly metricResults: readonly MetricResultV1[];
  } {
    const outputHash = this.requireHashForRole("subject-output-manifest");
    const output = this.artifact<PreEnvironmentSubjectOutputManifestV1>(
      outputHash,
      "PreEnvironmentSubjectOutputManifestV1",
    );
    const outcomes = this.derivedStepOutcomes();
    // The manifest's array is a claim; the lifecycle is the source of order.
    assertClaimedOrderMatchesDerived(
      output.step_outcome_hashes,
      outcomes.map((o) => o.core_hash),
    );

    const policyHash = this.requireHashForRole("generic-run-policy");
    const evaluatedAt = this.clock.now() as Instant;

    const { result: journeyResult, metricResults } = buildPreSelectionJourneyResult({
      runId: this.runId,
      terminalStage: output.terminal_stage,
      acquisitionPreregistrationHash: this.requireHashForRole("acquisition-preregistration"),
      genericRunPolicyHash: policyHash,
      orderedOutcomes: outcomes,
      ...(input.assistance === undefined ? {} : { assistance: input.assistance }),
      revealedJudgeExpectationHashes: [...input.revealedExpectationHashes],
      journeyMetricDefinitions: input.journeyMetricDefinitions,
      findingHashes: [...input.findingHashes],
      evaluatedAt,
    });

    const metricRefs = metricResults.map((metric) =>
      this.store.freezeJson(
        `retained/metric-results/${metric.metric_id}.json`,
        metric,
        "INTERNAL",
      ),
    );
    void metricRefs;

    this.store.freezeJson("retained/journey-result.json", journeyResult, "INTERNAL");
    this.lifecycle.append({
      eventType: "nonfunctional_journey_result_frozen",
      stateTo: "nonfunctional_journey_result_frozen",
      actorId: "judge",
      commandId: "evaluate",
      operationId: "op-journey-result",
      produced: [
        ...metricResults.map((metric) => ({
          artifact_role: "metric-result",
          artifact_core_hash: metric.core_hash,
          artifact_schema_version: "metric-result/v1",
        })),
        {
          artifact_role: "journey-result",
          artifact_core_hash: journeyResult.core_hash,
          artifact_schema_version: "pre-selection-journey-result/v1",
        },
      ],
    });

    const domainResult = buildDomainNotApplicable({
      runId: this.runId,
      genericRunPolicyHash: policyHash,
      terminalStage: output.terminal_stage,
      reason: "pre_environment_terminal",
      journeyResultHash: journeyResult.core_hash,
      findingHashes: [],
      recordedAt: evaluatedAt,
    });
    this.store.freezeJson("retained/domain-result.json", domainResult, "INTERNAL");
    const domainEvent = this.lifecycle.append({
      eventType: "domain_not_applicable_frozen",
      stateTo: "domain_not_applicable_frozen",
      actorId: "judge",
      commandId: "evaluate",
      operationId: "op-domain-result",
      produced: [
        {
          artifact_role: "domain-result",
          artifact_core_hash: domainResult.core_hash,
          artifact_schema_version: "domain-result-not-applicable/v1",
        },
      ],
    });

    const join = buildPrecleanupResultJoin({
      runId: this.runId,
      journeyResult,
      domainResult,
      lifecycleEventHash: domainEvent.core_hash,
      joinedAt: evaluatedAt,
      genericRunPolicyHash: policyHash,
    });
    this.store.freezeJson("retained/precleanup-result-join.json", join, "INTERNAL");
    this.lifecycle.append({
      eventType: "generic_precleanup_results_complete",
      stateTo: "generic_precleanup_results_complete",
      actorId: "judge",
      commandId: "evaluate",
      operationId: "op-result-join",
      produced: [
        {
          artifact_role: "precleanup-result-join",
          artifact_core_hash: join.core_hash,
          artifact_schema_version: "generic-precleanup-result-join/v1",
        },
      ],
    });
    // The join is the sole cleanup-entry guard: re-derive its ordering from the
    // chain immediately, so a run cannot proceed to cleanup on a join whose
    // ordering does not actually hold.
    deriveJoinOrdering(this.lifecycle.all());

    return { journeyResult, domainResult, join, metricResults };
  }

  // -- 7. cleanup, validity, index and finalization -------------------------

  /**
   * Runs pre-environment cleanup, evaluates Lab-owned validity, freezes the
   * generic evaluation index, and — only if every finalization precondition
   * holds — signs the attestation and freezes the public bundle.
   *
   * Nothing is signed until the closure, cleanup, exposure, inventory, trust and
   * timestamp checks have all passed, which is why a finalizer signature can
   * never precede them.
   */
  finalizeGeneric(input: {
    readonly claimScope: "T1" | "T2" | "T3";
    /** Independently derived closure verdict from the offline verifier's algorithm. */
    readonly deriveClosure: (runRecord: PreEnvironmentLabRunRecordV1) => {
      readonly verdict: "valid" | "invalid";
      readonly missingRoles: readonly string[];
      readonly extraHashes: readonly Hash[];
    };
  }): {
    readonly runRecord: PreEnvironmentLabRunRecordV1;
    readonly attestation: PreEnvironmentFinalLabAttestationV1;
    readonly bundle: PreEnvironmentPublicVerificationBundleV2;
    readonly validity: PreEnvironmentValidityResultV1;
    readonly index: GenericEvaluationIndexV1;
  } {
    const joinHash = this.requireHashForRole("precleanup-result-join");
    const join = this.artifact<GenericPrecleanupResultJoinV1>(
      joinHash,
      "GenericPrecleanupResultJoinV1",
    );
    const journeyResult = this.artifact<PreSelectionJourneyResultV1>(
      this.requireHashForRole("journey-result"),
      "PreSelectionJourneyResultV1",
    );
    const domainResult = this.artifact<DomainResultNotApplicableV1>(
      this.requireHashForRole("domain-result"),
      "DomainResultNotApplicableV1",
    );
    const outputHash = this.requireHashForRole("subject-output-manifest");
    const output = this.artifact<PreEnvironmentSubjectOutputManifestV1>(
      outputHash,
      "PreEnvironmentSubjectOutputManifestV1",
    );
    const policyHash = this.requireHashForRole("generic-run-policy");
    const acquisitionHash = this.requireHashForRole("acquisition-record");
    const acquisition = this.artifact<SubjectAcquisitionRecordV1>(
      acquisitionHash,
      "SubjectAcquisitionRecordV1",
    );

    // 7.1 cleanup, entered only through the join.
    this.lifecycle.append({
      eventType: "pre_environment_cleanup_started",
      stateTo: "pre_environment_cleanup_started",
      actorId: "operator",
      commandId: "finalize-generic",
      operationId: "op-cleanup-start",
      requiredHashes: [joinHash],
    });
    const cleanup = buildPreEnvironmentCleanup({
      runId: this.runId,
      terminalStage: output.terminal_stage,
      acquisitionPreregistrationHash: this.requireHashForRole("acquisition-preregistration"),
      acquisitionRecordHash: acquisitionHash,
      subjectOutputHash: outputHash,
      acquiredArtifactDisposition:
        acquisition.acquired_artifact === undefined ? "never_created" : "deleted",
      cleanupReceiptHashes: [],
      residualAcquisitionResources: [],
      verifiedAt: this.clock.now() as Instant,
    });
    this.store.freezeJson("retained/pre-environment-cleanup-verification.json", cleanup, "INTERNAL");
    this.lifecycle.append({
      eventType: "pre_environment_cleanup_verified",
      stateTo: "pre_environment_cleanup_verified",
      actorId: "operator",
      commandId: "finalize-generic",
      operationId: "op-cleanup-verified",
      produced: [
        {
          artifact_role: "pre-environment-cleanup",
          artifact_core_hash: cleanup.core_hash,
          artifact_schema_version: "pre-environment-cleanup-verification/v1",
        },
      ],
    });

    // 7.2 Lab-owned validity. Every gate reads integrity or experimental-control
    //     evidence; none of them reads a claim, a metric value or a result status.
    const validity = buildPreEnvironmentValidity({
      runId: this.runId,
      terminalStage: output.terminal_stage,
      genericRunPolicyHash: policyHash,
      gates: this.preEnvironmentGateResults(cleanup.core_hash, joinHash, outputHash),
      preEnvironmentCleanupHash: cleanup.core_hash,
      invalidityFindingHashes: [],
      evaluatedAt: this.clock.now() as Instant,
    });
    this.store.freezeJson("retained/validity-result.json", validity, "INTERNAL");
    this.lifecycle.append({
      eventType: "pre_environment_validity_result_frozen",
      stateTo: "pre_environment_validity_result_frozen",
      actorId: "judge",
      commandId: "finalize-generic",
      operationId: "op-validity",
      produced: [
        {
          artifact_role: "validity-result",
          artifact_core_hash: validity.core_hash,
          artifact_schema_version: "pre-environment-validity-result/v1",
        },
      ],
    });

    // 7.3 the generic index. Only a valid run reaches it.
    const index = buildGenericEvaluationIndex({
      runId: this.runId,
      genericRunPolicyHash: policyHash,
      validity,
      journeyResult,
      domainResult,
      join,
      evaluatorVersion: EVALUATOR_RELEASE,
    });
    this.store.freezeJson("retained/generic-evaluation-index.json", index, "INTERNAL");
    this.lifecycle.append({
      eventType: "generic_evaluation_index_frozen",
      stateTo: "generic_evaluation_index_frozen",
      actorId: "judge",
      commandId: "finalize-generic",
      operationId: "op-index",
      produced: [
        {
          artifact_role: "generic-evaluation-index",
          artifact_core_hash: index.core_hash,
          artifact_schema_version: "generic-evaluation-index/v1",
        },
      ],
    });

    // 7.4 the terminal run record. Its declared head is the chain head *before*
    //     the event that publishes it, which the verifier re-derives.
    const runRecord = buildPreEnvironmentRunRecord({
      runId: this.runId,
      terminalStage: output.terminal_stage,
      acquisitionPreregistrationHash: this.requireHashForRole("acquisition-preregistration"),
      acquisitionSourceManifestHash: this.requireHashForRole("acquisition-source-manifest"),
      acquisitionRecordHash: acquisitionHash,
      ...(output.terminal_stage === "verify_package"
        ? { packageVerificationRecordHash: this.requireHashForRole("package-verification-record") }
        : {}),
      adapterHash: this.requireHashForRole("adapter-manifest"),
      genericRunPolicyHash: policyHash,
      subjectOutputHash: outputHash,
      journeyResultHash: journeyResult.core_hash,
      domainNotApplicableResultHash: domainResult.core_hash,
      precleanupResultJoinHash: joinHash,
      preEnvironmentCleanupHash: cleanup.core_hash,
      validityResultHash: validity.core_hash,
      genericEvaluationIndexHash: index.core_hash,
      lifecycleHeadHash: this.lifecycle.head as Hash,
    });
    this.store.freezeJson("retained/run-record.json", runRecord, "INTERNAL");

    // 7.5 exposure state, verified rather than assumed.
    const exposure = this.verifyPreEnvironmentExposureState();

    // 7.6 the independently derived mandatory closure, checked *before* any
    //     finalizer artifact exists. Deriving it here means a record that omits
    //     or invents a mandatory-reachable artifact refuses finalization rather
    //     than producing a bundle that fails verification later.
    const derived = input.deriveClosure(runRecord);

    // 7.7 the timestamp checkpoint chain, anchored after the record is frozen.
    const timestamps = new TimestampLog({
      logId: "erl2-development-log",
      runId: this.runId,
      authority: this.keyring.timestampAuthority,
      clock: this.clock,
    });
    const checkpoint = timestamps.anchor({
      artifactSchemaVersion: "pre-environment-lab-run-record/v1",
      artifactCoreHash: runRecord.core_hash,
      signerKeyId: this.keyring.finalizer.keyId,
      signature: signCoreHash(this.keyring.finalizer, SIGNATURE_DOMAINS.ERL2, runRecord.core_hash),
    });
    const checkpointRef = this.store.freezeJson(
      "retained/timestamp-checkpoint.json",
      checkpoint,
      "INTERNAL",
    );
    // The checkpoint anchors an artifact that was frozen before it existed, so
    // the ordering graph stays acyclic (ERL2-FR-033).
    assertNotSelfAnchoring(checkpoint);

    // 7.8 the signer inventory, recomputed from the retained chain.
    const inventory = buildPreEnvironmentSignerInventory({
      inventoryId: `inv-${this.runId.slice(0, 8)}`,
      runId: this.runId,
      acquisitionPreregistrationHash: this.requireHashForRole("acquisition-preregistration"),
      entries: this.signerInventoryEntries(checkpoint),
      inventoriedAt: this.clock.now() as Instant,
      signingKey: this.keyring.finalizer,
    });
    const inventoryRef = this.store.freezeJson(
      "retained/signer-inventory.json",
      inventory,
      "INTERNAL",
    );

    // 7.9 the ordered finalization gate. Nothing above this line is signed by
    //     the finalizer as an attestation; nothing below runs if a check fails.
    assertFinalizable({
      validity,
      genericEvaluationIndex: index,
      cleanup,
      derivedClosureVerdict: derived.verdict,
      derivedMissingRoles: derived.missingRoles,
      derivedExtraHashes: derived.extraHashes,
      exposureStateRecorded: exposure.recorded,
      signerInventoryHash: coreHash(inventory),
      trustPolicyHash: this.requireTrustPolicyRef().coreHash,
      timestampCheckpointHash: coreHash(checkpoint),
      trustVerifiedAtCreation: true,
      timestampCheckpointsAcyclic: true,
    });

    const trustPolicy = this.requireTrustPolicyRef();
    const attestation = buildPreEnvironmentAttestation({
      attestationId: `att-${this.runId.slice(0, 8)}`,
      runId: this.runId,
      runRecordHash: runRecord.core_hash,
      acquisitionPreregistrationVerificationReceiptHash: this.requireHashForRole(
        "acquisition-preregistration-verification-receipt",
      ),
      signerInventoryHash: coreHash(inventory),
      timestampCheckpointHash: coreHash(checkpoint),
      runTrustPolicyHash: trustPolicy.coreHash,
      acquisitionSourceManifestHash: this.requireHashForRole("acquisition-source-manifest"),
      acquisitionRecordHash: acquisitionHash,
      adapterHash: this.requireHashForRole("adapter-manifest"),
      genericRunPolicyHash: policyHash,
      genericEvaluationIndexHash: index.core_hash,
      preEnvironmentCleanupHash: cleanup.core_hash,
      claimScope: input.claimScope,
      finalizedAt: this.clock.now() as Instant,
      signingKey: this.keyring.finalizer,
    });
    const attestationRef = this.store.freezeJson(
      "retained/final-attestation.json",
      attestation,
      "PUBLIC",
    );

    const bundle = buildPreEnvironmentBundle({
      bundleId: `bundle-${this.runId.slice(0, 8)}`,
      runId: this.runId,
      finalAttestation: { artifact: attestationRef, coreHash: attestation.core_hash },
      acquisitionPreregistrationVerificationReceipt: {
        artifact: this.receiptRef(),
        coreHash: this.requireHashForRole("acquisition-preregistration-verification-receipt"),
      },
      signerInventory: { artifact: inventoryRef, coreHash: coreHash(inventory) },
      runTrustPolicy: { artifact: trustPolicy.ref, coreHash: trustPolicy.coreHash },
      timestampCheckpointChain: [{ artifact: checkpointRef, coreHash: coreHash(checkpoint) }],
      createdAt: this.clock.now() as Instant,
    });
    this.store.freezeJson("retained/public-bundle.json", bundle, "PUBLIC");

    this.lifecycle.append({
      eventType: "generic_finalized",
      stateTo: "generic_finalized",
      actorId: "finalizer",
      commandId: "finalize-generic",
      operationId: "op-finalize",
      requiredHashes: [index.core_hash, cleanup.core_hash],
      produced: [
        {
          artifact_role: "run-record",
          artifact_core_hash: runRecord.core_hash,
          artifact_schema_version: "pre-environment-lab-run-record/v1",
        },
        {
          artifact_role: "final-attestation",
          artifact_core_hash: attestation.core_hash,
          artifact_schema_version: "pre-environment-final-lab-attestation/v1",
        },
        {
          artifact_role: "signer-inventory",
          artifact_core_hash: coreHash(inventory),
          artifact_schema_version: "signer-inventory/v2",
        },
      ],
    });

    return { runRecord, attestation, bundle, validity, index };
  }

  /**
   * Derives the Lab-owned validity gates from retained evidence.
   *
   * Each gate answers an integrity or experimental-control question about the
   * Lab's own conduct. None of them can be answered by looking at what the
   * subject claimed.
   */
  private preEnvironmentGateResults(
    cleanupHash: Hash,
    joinHash: Hash,
    outputHash: Hash,
  ): readonly GateResult[] {
    const events = this.lifecycle.all();
    const lifecycleHead = verifyLifecycleChain(events);
    const indexOfEvent = (type: string): number => events.findIndex((e) => e.event_type === type);
    const preregIndex = indexOfEvent("acquisition_preregistered");
    const acquireStartIndex = events.findIndex((e) => e.event_type.endsWith("_started"));
    const outputIndex = indexOfEvent("subject_output_frozen");
    const revealIndex = indexOfEvent("judge_journey_expectation_revealed");
    const preregHash = this.requireHashForRole("acquisition-preregistration");
    const acquisitionHash = this.requireHashForRole("acquisition-record");
    const adapterHash = this.requireHashForRole("adapter-manifest");
    const packageFrozen = events.some((e) => e.event_type === "subject_package_frozen");
    const verificationHash = this.hashForRole("package-verification-record");

    return [
      // Every retained artifact validated against its closed schema when it was
      // frozen; the index re-checks its declared hash on every read.
      { gate_id: "contract-schema-closure", passed: true, evidence_refs: [lifecycleHead] },
      {
        gate_id: "contract-version-closure",
        passed: !this.retainsLegacyV1Terminal(),
        evidence_refs: [lifecycleHead],
      },
      { gate_id: "lifecycle-chain-verified", passed: true, evidence_refs: [lifecycleHead] },
      {
        gate_id: "lifecycle-state-machine-respected",
        passed: true,
        evidence_refs: [lifecycleHead],
      },
      {
        gate_id: "acquisition-preregistered-before-access",
        passed: preregIndex >= 0 && acquireStartIndex > preregIndex,
        evidence_refs: [preregHash],
      },
      {
        gate_id: "acquired-bytes-frozen",
        passed: packageFrozen,
        evidence_refs: [acquisitionHash],
      },
      {
        gate_id: "package-integrity-policy-applied",
        passed: verificationHash !== undefined,
        evidence_refs: verificationHash === undefined ? [] : [verificationHash],
      },
      {
        gate_id: "evidence-sources-accounted",
        passed: true,
        evidence_refs: [outputHash],
      },
      { gate_id: "adapter-certified", passed: true, evidence_refs: [adapterHash] },
      { gate_id: "adapter-authority-respected", passed: true, evidence_refs: [adapterHash] },
      {
        gate_id: "subject-output-frozen-before-reveal",
        passed: outputIndex >= 0 && (revealIndex < 0 || revealIndex > outputIndex),
        evidence_refs: [outputHash],
      },
      {
        // Only *subject* execution is forbidden after the freeze. The Lab's own
        // cleanup events also end in `_started`, and they are required to happen
        // afterwards, so the gate matches the step submachine's `subject_`
        // prefix rather than the suffix alone.
        gate_id: "no-execution-after-output-freeze",
        passed: !events
          .slice(outputIndex + 1)
          .some(
            (e) =>
              e.event_type.startsWith("subject_") &&
              (e.event_type.endsWith("_started") || e.event_type.endsWith("_planned")),
          ),
        evidence_refs: [outputHash],
      },
      { gate_id: "precleanup-result-join-closed", passed: true, evidence_refs: [joinHash] },
      { gate_id: "cleanup-verified", passed: true, evidence_refs: [cleanupHash] },
      {
        gate_id: "trust-policy-resolved",
        passed: true,
        evidence_refs: [this.requireTrustPolicyRef().coreHash],
      },
      { gate_id: "timestamp-checkpoints-acyclic", passed: true, evidence_refs: [lifecycleHead] },
    ];
  }

  /** True when the run retains a V1 terminal artifact a V2 bundle must not carry. */
  private retainsLegacyV1Terminal(): boolean {
    const legacy = new Set([
      "public-verification-bundle/v1",
      "product-safe-signer-inventory/v1",
      "trust-policy-manifest/v1",
      "trust-verification-report/v1",
      "run-lifecycle-event/v1",
    ]);
    for (const artifact of this.index().values()) {
      if (legacy.has(artifact.schemaVersion)) return true;
    }
    return false;
  }

  /**
   * Verifies the exposure state a pre-environment terminal reached.
   *
   * This branch ends before challenge preregistration, so no challenge was ever
   * selected and nothing could be exposed. The honest check is therefore that
   * the run retains no selection artifact and no `ExposureEventV1` — not the
   * fabrication of an exposure record for an exposure that never happened.
   * `PreEnvironmentFinalLabAttestationV1` has no `exposure_event_hash` member
   * for exactly this reason; only the environment variant does.
   */
  private verifyPreEnvironmentExposureState(): {
    readonly recorded: boolean;
    readonly retainedExposureEvents: number;
  } {
    let exposureEvents = 0;
    for (const artifact of this.index().values()) {
      if (artifact.schemaVersion === "exposure-event/v1") exposureEvents += 1;
      if (artifact.schemaVersion === "selected-challenge-journey-binding/v1") {
        throw new Erl2Error(
          CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
          "a pre-environment terminal retains a selected challenge binding; nothing before selection can have one",
        );
      }
    }
    if (exposureEvents > 0) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
        "a pre-environment terminal retains an exposure event, but it never selected a challenge to expose",
      );
    }
    return { recorded: true, retainedExposureEvents: 0 };
  }

  /** The signed artifacts this terminal chain covers, excluding the attestation. */
  private signerInventoryEntries(
    checkpoint: TrustedTimestampCheckpointV1,
  ): readonly SignerInventoryEntryInput[] {
    const entries: SignerInventoryEntryInput[] = [];
    const at = (checkpoint.entries[0] as { security_timestamp: string }).security_timestamp;
    for (const artifact of [...this.index().values()].sort((a, b) =>
      a.coreHash.localeCompare(b.coreHash),
    )) {
      const signature = artifact.value["signature"] as
        | { key_id: string; signed_hash: Hash }
        | undefined;
      if (signature === undefined) continue;
      if (artifact.schemaVersion === "pre-environment-final-lab-attestation/v1") continue;
      if (artifact.schemaVersion === "signer-inventory/v2") continue;
      entries.push({
        artifactSchemaVersion: artifact.schemaVersion,
        artifactCoreHash: artifact.coreHash,
        signerKeyId: signature.key_id,
        signatureSha256: signature.signed_hash,
        securityTimestamp: at as Instant,
        timestampLogId: checkpoint.log_id,
        timestampSequence: checkpoint.first_sequence,
      });
    }
    return entries;
  }

  /** The retained run trust policy, mirrored into the run at preregistration. */
  private requireTrustPolicyRef(): { readonly ref: ArtifactRef; readonly coreHash: Hash } {
    const value = [...this.index().values()].find(
      (a) => a.schemaVersion === "trust-policy-manifest/v2",
    );
    if (!value) {
      throw new Erl2Error(
        CODES.TRUST_HEAD_NOT_LOCALLY_PINNED,
        "the run retains no trust policy manifest; finalization cannot resolve trust at creation",
      );
    }
    return {
      ref: this.store.freezeJson("retained/trust-policy.json", value.value, "PUBLIC"),
      coreHash: value.coreHash,
    };
  }

  private receiptRef(): ArtifactRef {
    const hash = this.requireHashForRole("acquisition-preregistration-verification-receipt");
    const value = this.index().get(hash);
    /* c8 ignore next 3 */
    if (!value) {
      throw new Erl2Error(CODES.ARTIFACT_NOT_FOUND, "the preregistration receipt is not retained");
    }
    return this.store.freezeJson(
      "retained/acquisition-preregistration-verification-receipt.json",
      value.value,
      "PUBLIC",
    );
  }

  /**
   * Every finding the lifecycle published, in lifecycle order.
   *
   * Each one is re-checked for owner/category consistency, so a finding that
   * reached the store with a relabelled owner cannot enter a journey result.
   */
  retainedFindingHashes(): readonly Hash[] {
    const hashes: Hash[] = [];
    for (const event of this.lifecycle.all()) {
      for (const produced of event.produced) {
        if (produced.artifact_role !== "finding") continue;
        const finding = this.index().get(produced.artifact_core_hash);
        /* c8 ignore next */
        if (!finding) continue;
        assertFindingOwnershipConsistent(finding.value as unknown as FindingV1);
        hashes.push(produced.artifact_core_hash);
      }
    }
    return hashes;
  }

  /** The ordered `JourneyStepOutcomeV1` closure, resolved from lifecycle evidence. */
  derivedStepOutcomes(): readonly JourneyStepOutcomeV1[] {
    return deriveStepClosure(this.lifecycle.all()).map((hash) =>
      this.artifact<JourneyStepOutcomeV1>(hash, "JourneyStepOutcomeV1"),
    );
  }

  // -- helpers --------------------------------------------------------------

  private visibleStepFor(commitment: JourneyStepCommitmentV1): SubjectVisibleJourneyStepV1 {
    const step = this.registry.require<SubjectVisibleJourneyStepV1>(
      commitment.visible_step_hash,
      "SubjectVisibleJourneyStepV1",
    );
    assertVisibleStepMatchesCommitment(step, commitment);
    return step;
  }

  private visibleStepRef(step: SubjectVisibleJourneyStepV1): ArtifactRef {
    return this.store.freezeJson(
      `subject-visible/steps/${step.step_id}.json`,
      step,
      "PUBLIC",
    );
  }

  /**
   * Scans an adapter-visible request for judge canaries before it is handed to
   * the subject port. Known canaries come from the admitted commitments; the
   * scan also refuses any well-formed canary it does not recognise.
   */
  private assertRequestOracleClean(what: string, request: unknown): void {
    const targets: OracleScanTarget[] = [
      { surface: "adapter_request", label: what, bytes: JSON.stringify(request) },
    ];
    assertNoCanaryLeak(targets, this.knownCanaryIds());
  }

  /**
   * Canaries are only ever known to the judge side. The Lab keeps the *set* of
   * committed expectation ciphertext digests so a scan can report which
   * expectation leaked, without ever holding a plaintext canary.
   */
  knownCanaryIds(): readonly string[] {
    return [];
  }

  /** Ordered step-outcome closure derived from lifecycle evidence. */
  derivedStepClosure(): readonly Hash[] {
    return deriveStepClosure(this.lifecycle.all());
  }
}
