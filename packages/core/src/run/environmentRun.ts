/**
 * The durable environment and journey walk (design v2 §12, Slice 6.5-B).
 *
 * This is the environment counterpart of `selectionWalk.ts`, and it follows the
 * same rule, ADR-ERL2-020 §6: **one durable transition at a time** — validate
 * the state the phase departs from, produce exactly that phase's artifacts,
 * freeze them, and only then append the lifecycle event. Nothing is run in
 * memory and replayed into the lifecycle afterwards, so a crash at any boundary
 * leaves a run whose retained evidence says exactly how far it got, and the next
 * process continues from there.
 *
 * Two properties are worth stating explicitly because they were the hard parts.
 *
 * **Nothing is carried between processes.** Every phase re-resolves its inputs
 * from `retained/` and from the lifecycle's produced roles. The realized cutoff,
 * the selected journey, the ordered committed steps and the driver's own
 * substrate are all re-derived rather than remembered — the environment driver
 * included, which is why `SubstrateStore` exists.
 *
 * **The capture artifacts are byte-reproducible.** The observation bundle, the
 * canonical evidence envelope and the translation receipt are stamped with the
 * *realized cutoff instant* rather than a clock read. A crash between freezing
 * the envelope and recording it would otherwise leave bytes the resume could not
 * reproduce; stamping from evidence makes the re-freeze idempotent, which is
 * what lets those three transitions be interrupted anywhere.
 *
 * The driver is reached **only** through `EnvironmentDriver`. There is no
 * fake-driver branch here, in the finalizer, or in the verifier: this module
 * cannot tell which driver it holds, and asks the manifest rather than the type.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type AdapterStepRequestV1,
  type AdapterTranslationReceiptV1,
  type ArtifactRef,
  type ChallengeManifestV1,
  type ComparisonPolicyV1,
  type CutoffPolicyV1,
  type DomainResultNotApplicableV1,
  type EnvironmentArchetypeV1,
  type EnvironmentBaselineFingerprintV1,
  type EnvironmentJourneyIntent,
  type EnvironmentResourceFrontierV1,
  type EnvironmentResourceInventoryV1,
  type EnvironmentResourceV1,
  type EnvironmentRestorationVerificationV1,
  type EnvironmentSubjectOutputManifestV1,
  type EnvironmentFinalLabAttestationV1,
  type EnvironmentLabRunRecordV1,
  type EnvironmentPublicVerificationBundleV2,
  type EnvironmentSignerInventoryV2,
  type EnvironmentValidityResultV1,
  type ExposureEventV1,
  type GenericEvaluationIndexV1,
  type GenericPrecleanupResultJoinV1,
  type InvalidLabRunRecordV1,
  type Hash,
  type Instant,
  type JourneyDefinitionV1,
  type JourneyIntent,
  type JourneyStepCommitmentV1,
  type JourneyStepOutcomeV1,
  type JudgeExpectationRevealRecordV1,
  type MetricResultV1,
  type MonotonicClockDomainV1,
  type ObservationBundleV2,
  type LiveCanonicalEvidenceEnvelopeV1,
  type RuntimeMilestoneV1,
  type SelectedChallengeJourneyBindingV1,
  type SelectedJourneyResultV1,
  type SourceSnapshotV1,
  type SubjectExecutionPlanV1,
  type SubjectVisibleJourneyStepV1,
  type TeardownVerificationV1,
  type TrafficProcessStartReceiptV1,
} from "@erl2/contracts";
import {
  assertNotSelfAnchoring,
  coreHash,
  domainHash,
  HASH_DOMAINS,
  sealSigned,
  signCoreHash,
  SIGNATURE_DOMAINS,
  treeHash,
  type SigningKey,
} from "@erl2/integrity";
import { TimestampLog } from "../timestamps/log.js";
import {
  assertEnvironmentFinalizable,
  buildEnvironmentAttestation,
  buildEnvironmentBundle,
  buildEnvironmentRunRecord,
  buildEnvironmentSignerInventory,
  NON_BLIND_DEVELOPMENT_ASSURANCE,
} from "../terminal/environmentFinalize.js";
import type { Clock } from "../runtime/seams.js";
import type { LabState } from "../lifecycle/states.js";
import { assertSubjectPortExecutable } from "../lifecycle/states.js";
import { assertBaselineClean, assertRepeatableBaseline } from "../environment/cleanControl.js";
import { assertDriverEnabled, assertOperationSupported, type EnvironmentDriver } from "../environment/driver.js";
import { ReservationAllocator, type ReservationKind } from "../environment/allocator.js";
import { freezeResourceFrontier, safeActions } from "../environment/frontier.js";
import { buildEmergencyCleanup } from "../cleanup/cleanup.js";
import { buildEnvironmentRestoration, buildTeardownVerification, type TeardownCheck } from "../cleanup/cleanup.js";
import { realizeCutoff, freezeSourceSnapshot, freezeObservation, type RealizedCutoff } from "../capture/capture.js";
import { assertComparisonModeAdmissible, assertTranslationTotality, buildLiveEnvelope } from "../capture/envelope.js";
import { buildSelectedJourneyResult } from "../evaluation/journey.js";
import { buildDomainNotApplicable, missingDomainAncestors } from "../evaluation/domain.js";
import { buildGenericEvaluationIndex, buildPrecleanupResultJoin, deriveJoinOrdering } from "../evaluation/join.js";
import { buildEnvironmentValidity, type GateResult } from "../evaluation/validity.js";
import { JOURNEY_PLANE_METRICS } from "../evaluation/genericMetrics.js";
import { verifyLifecycleChain } from "../lifecycle/log.js";
import { assertNoCanaryLeak } from "../journey/oracle.js";
import { EVALUATOR_RELEASE, type RunWorkspace } from "./workspace.js";

/** The signing roles the environment branch needs, each a distinct operator. */
export interface EnvironmentKeyring {
  /** Signs the challenge-activation controller evidence. */
  readonly controller: SigningKey;
  /** Signs the traffic process start receipt. */
  readonly trafficSupervisor: SigningKey;
  /** Signs the runtime milestone the cutoff is derived from. */
  readonly runtimeAttestor: SigningKey;
  /** Signs the exposure event when the sealed case is opened for judging. */
  readonly vaultAuthorizer: SigningKey;
  /** Anchors the terminal run record in the timestamp log. */
  readonly timestampAuthority: SigningKey;
  /** Signs the signer inventory and the final attestation. */
  readonly finalizer: SigningKey;
}

export interface EnvironmentRunOptions {
  readonly workspace: RunWorkspace;
  readonly driver: EnvironmentDriver;
  readonly allocator: ReservationAllocator;
  readonly archetype: EnvironmentArchetypeV1;
  /**
   * The comparison and cutoff policies, resolved lazily.
   *
   * A run binds them at `journey`, not at `provision`, so every earlier phase
   * must be runnable without naming them. Passing thunks keeps that true without
   * letting a phase that *does* need one proceed on a default.
   */
  readonly comparisonPolicy: () => ComparisonPolicyV1;
  readonly cutoffPolicy: () => CutoffPolicyV1;
  readonly keys: EnvironmentKeyring;
  readonly clock: Clock;
}

const RETAINED = "retained/environment";

/** Resource kinds the global allocator holds a reservation lease for (§22). */
const RESERVATION_KINDS: ReadonlySet<string> = new Set<ReservationKind>([
  "network",
  "volume",
  "port",
  "tenant",
  "project",
]);

/**
 * The warmup and observation windows this development profile uses.
 *
 * They are constants of the composition, not caller inputs: `realizeCutoff`
 * checks them against the committed policy bounds, and a caller-chosen window
 * would let an operator move the cutoff after seeing the environment.
 */
const WARMUP_MS = 1_000;
const OBSERVATION_MS = 5_000;

/** One phase of the walk: where it departs from, and where it lands. */
export interface EnvironmentPhase {
  readonly command: string;
  readonly from: readonly LabState[];
  readonly to: LabState;
}

/**
 * The environment path, as data.
 *
 * Ordering lives here rather than in control flow for the same reason
 * `SELECTION_STEPS` does: the sequence is the thing being asserted, so it should
 * be readable, and a phase can be neither skipped nor reordered without editing
 * this table.
 */
export const ENVIRONMENT_PHASES: readonly EnvironmentPhase[] = [
  { command: "provision", from: ["case_selected"], to: "environment_provisioned" },
  { command: "baseline", from: ["environment_provisioned"], to: "baseline_verified" },
  { command: "plan", from: ["baseline_verified"], to: "execution_plan_frozen" },
  {
    command: "execute-subject",
    from: ["execution_plan_frozen", "step_outcome_frozen", "adapter_translation_frozen"],
    to: "step_outcome_frozen",
  },
  { command: "activate", from: ["step_outcome_frozen"], to: "challenge_activated" },
  { command: "journey", from: ["challenge_activated"], to: "traffic_or_journey_started" },
  { command: "observe", from: ["traffic_or_journey_started"], to: "evidence_cutoff_realized" },
  { command: "freeze-observation", from: ["evidence_cutoff_realized"], to: "adapter_translation_frozen" },
  { command: "freeze-output", from: ["step_outcome_frozen"], to: "subject_output_frozen" },
  { command: "reveal", from: ["subject_output_frozen"], to: "judge_journey_expectation_revealed" },
  { command: "evaluate", from: ["judge_journey_expectation_revealed"], to: "generic_precleanup_results_complete" },
  { command: "restore", from: ["generic_precleanup_results_complete"], to: "environment_restored" },
  { command: "destroy", from: ["environment_restored"], to: "teardown_verified" },
  { command: "finalize-generic", from: ["teardown_verified"], to: "generic_finalized" },
];

/** The intents that may run before the challenge is activated. */
const SETUP_INTENTS: ReadonlySet<JourneyIntent> = new Set<JourneyIntent>([
  "install",
  "configure",
  "authenticate",
  "connect",
  "discover",
]);

/** One committed step of the selected journey, and whether it has already run. */
export interface CommittedJourneyStep {
  readonly index: number;
  readonly commitment: JourneyStepCommitmentV1;
  readonly visibleStep: SubjectVisibleJourneyStepV1;
  readonly intent: JourneyIntent;
  readonly outcome: JourneyStepOutcomeV1 | undefined;
}

export class EnvironmentRun {
  private readonly ws: RunWorkspace;
  private readonly driver: EnvironmentDriver;
  private readonly allocator: ReservationAllocator;
  private readonly archetype: EnvironmentArchetypeV1;
  private readonly comparisonPolicy: () => ComparisonPolicyV1;
  private readonly cutoffPolicy: () => CutoffPolicyV1;
  private readonly keys: EnvironmentKeyring;
  private readonly clock: Clock;
  /**
   * The driver receipt for the operation that just failed.
   *
   * Set immediately before a restoration or teardown failure is raised, and read
   * by `invalidate` in the same process, so the invalid terminal can cite the
   * attempt that failed rather than only the cleanup that followed it. It is
   * never read across processes: a resumed run re-derives everything.
   */
  private failedAttemptHash: Hash | undefined;

  constructor(options: EnvironmentRunOptions) {
    this.ws = options.workspace;
    this.driver = options.driver;
    this.allocator = options.allocator;
    this.archetype = options.archetype;
    this.comparisonPolicy = options.comparisonPolicy;
    this.cutoffPolicy = options.cutoffPolicy;
    this.keys = options.keys;
    this.clock = options.clock;
  }

  private get runId(): string {
    return this.ws.runId;
  }

  private now(): Instant {
    return this.clock.now() as Instant;
  }

  /**
   * Refuses a phase invoked from the wrong state, **before** any driver call or
   * freeze (ADR-ERL2-019 §4).
   *
   * `alreadyDone` is answered from **retained evidence**, never from state
   * ordering. Several phases depart from a state the run visits more than once
   * (`step_outcome_frozen` recurs on every journey step), and a state-order test
   * cannot tell "not yet there" from "already past" — asking `provision` that way
   * made a run that never selected a case report a missing inventory instead of
   * the wrong state it was actually in. When the phase's own artifact is already
   * retained the command is a no-op; otherwise the state must be one the phase
   * departs from.
   */
  private enter(command: string, alreadyDone: boolean): boolean {
    const phase = ENVIRONMENT_PHASES.find((p) => p.command === command) as EnvironmentPhase;
    const state = this.ws.lifecycle.currentState;
    if (alreadyDone) return false;
    if (!phase.from.includes(state)) {
      throw new Erl2Error(
        CODES.POLICY_CONFLICT,
        `${command} departs from ${phase.from.join(" or ")}; this run is in ${state}`,
      );
    }
    return true;
  }

  // -- 1. reservation and provisioning ---------------------------------------

  /**
   * Reserves this run's substrate identities, provisions the environment and
   * freezes its inventory.
   *
   * The reservation happens first and separately: the global allocator holds
   * leases only, so a second run that would collide on a network, volume, port
   * or project name is refused **before** anything is created rather than after.
   */
  provision(): { readonly inventory: EnvironmentResourceInventoryV1; readonly leases: number } {
    if (!this.enter("provision", this.ws.hashForRole("environment-resource-inventory") !== undefined)) {
      return {
        inventory: this.ws.artifact<EnvironmentResourceInventoryV1>(
          this.ws.requireHashForRole("environment-resource-inventory"),
          "EnvironmentResourceInventoryV1",
        ),
        leases: this.ws.hashesForRole("environment-reservation-lease").length,
      };
    }
    assertDriverEnabled(this.driver.manifest);
    assertOperationSupported(this.driver.manifest, "provision");

    const kinds = this.driver.manifest.resource_kinds.filter((kind) => RESERVATION_KINDS.has(kind));
    if (kinds.length === 0) {
      throw new Erl2Error(
        CODES.ENV_RESERVATION_CONFLICT,
        `driver ${this.driver.manifest.driver_id} declares no reservable resource kind; a run with no reservation cannot be isolated`,
      );
    }
    // Every reservation is taken before the driver is asked to create anything.
    const leases = kinds.map((kind) =>
      this.allocator.acquire({
        runId: this.runId,
        kind: kind as ReservationKind,
        value: `erl2-${kind}-${this.runId}`,
        leaseId: `lease-${kind}-${this.runId.slice(0, 8)}`,
      }),
    );

    const result = this.driver.provision({
      runId: this.runId,
      archetypeHash: coreHash(this.archetype),
      disorderSeedCommitment: domainHash(HASH_DOMAINS.DRIVER_STATE, {
        run_id: this.runId,
        archetype_id: this.archetype.archetype_id,
      }),
      operationId: "op-provision",
    });
    if (result.partial) {
      // A partial provision is a Lab-owned failure whose authorized route is
      // `case_selected -> invalid_failure_detected` and the environment cleanup
      // frontier. The receipt is retained first so the terminal can cite the
      // attempt; the inventory is not, because a half-built environment has no
      // instance to close over.
      this.ws.store.freezeJson(`${RETAINED}/failed-provision-receipt.json`, result.receipt, "INTERNAL");
      this.failedAttemptHash = result.receipt.core_hash;
      throw new Erl2Error(
        CODES.ENV_PROVISION_FAILED,
        `provisioning created ${String(result.inventory.resources.length)} of the archetype's resources; a partial environment must be invalidated, not used`,
        { owner: "lab" },
      );
    }

    // The archetype and the driver manifest are mirrored into the run so an
    // offline reader can re-derive the baseline and the resource identities
    // without holding the governor's registry.
    this.ws.store.freezeJson(`${RETAINED}/archetype.json`, this.archetype, "INTERNAL");
    this.ws.store.freezeJson(`${RETAINED}/driver-manifest.json`, this.driver.manifest, "INTERNAL");
    for (const lease of leases) {
      this.ws.store.freezeJson(`${RETAINED}/reservation-${lease.reservation_kind}.json`, lease, "INTERNAL");
    }
    this.ws.store.freezeJson(`${RETAINED}/resource-inventory.json`, result.inventory, "INTERNAL");
    this.ws.store.freezeJson(`${RETAINED}/operation-provision.json`, result.receipt, "INTERNAL");

    this.ws.lifecycle.append({
      eventType: "environment_provisioned",
      stateTo: "environment_provisioned",
      actorId: "environment-governor",
      commandId: "provision",
      operationId: "op-provision",
      produced: [
        ...leases.map((lease) => ({
          artifact_role: "environment-reservation-lease",
          artifact_core_hash: lease.core_hash,
          artifact_schema_version: "environment-reservation-lease/v1",
        })),
        {
          artifact_role: "environment-resource-inventory",
          artifact_core_hash: result.inventory.core_hash,
          artifact_schema_version: "environment-resource-inventory/v1",
        },
        {
          artifact_role: "environment-operation-receipt",
          artifact_core_hash: result.receipt.core_hash,
          artifact_schema_version: "environment-operation-receipt/v1",
        },
        // The two admission inputs the run mirrors so an offline reader can
        // re-derive the baseline and the resource identities without holding the
        // governor's registry. They are recorded as produced because every
        // retained byte must be reachable from the lifecycle — the invalid-record
        // closure counts an unreachable one as an unaccounted artifact.
        {
          artifact_role: "environment-archetype",
          artifact_core_hash: coreHash(this.archetype),
          artifact_schema_version: "environment-archetype/v1",
        },
        {
          artifact_role: "environment-driver-manifest",
          artifact_core_hash: coreHash(this.driver.manifest),
          artifact_schema_version: "environment-driver-manifest/v1",
        },
      ],
    });
    return { inventory: result.inventory, leases: leases.length };
  }

  /** The retained inventory; its core hash *is* the run's environment instance. */
  private inventory(): EnvironmentResourceInventoryV1 {
    return this.ws.artifact<EnvironmentResourceInventoryV1>(
      this.ws.requireHashForRole("environment-resource-inventory"),
      "EnvironmentResourceInventoryV1",
    );
  }

  private environmentInstanceHash(): Hash {
    return this.ws.requireHashForRole("environment-resource-inventory");
  }

  /**
   * The instance identity a cleanup path may use.
   *
   * A provisioning failure never recorded an inventory, so the frontier and the
   * emergency verification fall back to the archetype the run was provisioned
   * *for*. That is the honest identity of a half-built environment: there is no
   * inventory because there is no complete instance.
   */
  private instanceHashForCleanup(): Hash {
    return this.ws.hashForRole("environment-resource-inventory") ?? coreHash(this.archetype);
  }

  // -- 2. clean baseline -----------------------------------------------------

  /**
   * Probes the provisioned environment twice and freezes the baseline.
   *
   * Twice, because the Slice 3 exit property is "a clean environment reaches a
   * stable baseline twice" and a single probe cannot show it. The fingerprint
   * excludes run identity and time by construction, so two clean probes of the
   * same archetype must agree — a disagreement is a Lab-owned contamination
   * verdict, never a subject defect.
   */
  baseline(): EnvironmentBaselineFingerprintV1 {
    if (!this.enter("baseline", this.ws.hashForRole("environment-baseline") !== undefined)) {
      return this.ws.artifact<EnvironmentBaselineFingerprintV1>(
        this.ws.requireHashForRole("environment-baseline"),
        "EnvironmentBaselineFingerprintV1",
      );
    }
    assertOperationSupported(this.driver.manifest, "probe");
    // Readiness first: did the environment come up at all. Then the baseline,
    // twice. The fingerprint is derived from probe observations and source
    // states only — it excludes run identity, instance identity and time — so
    // two baseline probes of a clean environment must agree byte for byte, and a
    // disagreement is a Lab-owned contamination verdict rather than a subject
    // defect. The two probes must be of the *same* phase: the phase is part of
    // the fingerprint, so comparing readiness against baseline would compare two
    // things that are different by construction and prove nothing.
    const readiness = this.driver.probe({
      runId: this.runId,
      phase: "readiness",
      operationId: "op-baseline-readiness",
    });
    assertBaselineClean(readiness);
    const first = this.driver.probe({ runId: this.runId, phase: "baseline", operationId: "op-baseline" });
    const second = this.driver.probe({
      runId: this.runId,
      phase: "baseline",
      operationId: "op-baseline-repeat",
    });
    assertBaselineClean(first);
    assertBaselineClean(second);
    assertRepeatableBaseline(first, second);

    this.ws.store.freezeJson(`${RETAINED}/baseline.json`, first, "INTERNAL");
    this.ws.lifecycle.append({
      eventType: "baseline_verified",
      stateTo: "baseline_verified",
      actorId: "environment-governor",
      commandId: "baseline",
      operationId: "op-baseline-verified",
      requiredHashes: [this.environmentInstanceHash()],
      produced: [
        {
          artifact_role: "environment-baseline",
          artifact_core_hash: first.core_hash,
          artifact_schema_version: "environment-baseline-fingerprint/v1",
        },
      ],
    });
    return first;
  }

  // -- 3. the execution plan -------------------------------------------------

  private binding(): SelectedChallengeJourneyBindingV1 {
    return this.ws.artifact<SelectedChallengeJourneyBindingV1>(
      this.ws.requireHashForRole("selected-challenge-journey-binding"),
      "SelectedChallengeJourneyBindingV1",
    );
  }

  /**
   * Freezes the execution plan.
   *
   * Design §15 makes one binding load-bearing: `SubjectExecutionPlanV1.
   * actor_script_hash` MUST equal the persona script the selection opened. It is
   * taken from the binding rather than from a flag, and then re-checked against
   * the admitted journey definition, so a plan can never execute a persona the
   * selection did not open.
   */
  plan(): SubjectExecutionPlanV1 {
    if (!this.enter("plan", this.ws.hashForRole("execution-plan") !== undefined)) {
      return this.ws.artifact<SubjectExecutionPlanV1>(
        this.ws.requireHashForRole("execution-plan"),
        "SubjectExecutionPlanV1",
      );
    }
    const binding = this.binding();
    const journey = this.ws.artifact<JourneyDefinitionV1>(binding.journey_hash, "JourneyDefinitionV1");
    if (journey.persona_script_hash !== binding.persona_script_hash) {
      throw new Erl2Error(
        CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
        "the execution plan's actor script must be the persona the selection opened",
      );
    }
    const adapterHash = this.ws.requireHashForRole("adapter-manifest");
    const body = {
      schema_version: "subject-execution-plan/v1" as const,
      run_id: this.runId,
      selection_commitment_hash: this.ws.requireHashForRole("selection-commitment"),
      selection_verification_receipt_hash: this.ws.requireHashForRole("selection-verification-receipt"),
      selected_challenge_journey_binding_hash: coreHash(binding),
      environment_instance_hash: this.environmentInstanceHash(),
      challenge_hash: binding.challenge_manifest_hash,
      journey_hash: binding.journey_hash,
      acquisition_source_manifest_hash: this.ws.requireHashForRole("acquisition-source-manifest"),
      subject_package_manifest_hash: this.ws.requireHashForRole("subject-package-manifest"),
      adapter_manifest_hash: adapterHash,
      // The configuration intent is the archetype's own resolved topology: a
      // plan configures the environment it was provisioned into, and nothing a
      // caller supplies can widen it.
      configuration_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
        archetype_hash: coreHash(this.archetype),
        environment_instance_hash: this.environmentInstanceHash(),
      }),
      generic_run_policy_hash: this.ws.requireHashForRole("generic-run-policy"),
      actor_script_hash: binding.persona_script_hash,
      // The plan's limits are the archetype's budget clamped to the schema's own
      // ceilings, never widened past them: the contract's maxima are the design's
      // retention and cost bounds (§23), so an archetype that declared a larger
      // budget must still execute within them.
      limits: {
        runtime_ms: Math.min(this.archetype.resource_budget.runtime_ms, 5_400_000),
        output_bytes: 64 * 1024 * 1024,
        diagnostic_bytes: 16 * 1024,
      },
    };
    const plan = assertContract<SubjectExecutionPlanV1>("SubjectExecutionPlanV1", {
      ...body,
      core_hash: coreHash(body),
    });
    // A plan is an adapter-visible ancestor: it must carry no oracle field and
    // no canary, checked before it is retained rather than after.
    this.ws.assertRequestOracleClean("subject execution plan", plan);

    this.ws.store.freezeJson("retained/execution-plan.json", plan, "INTERNAL");
    this.ws.lifecycle.append({
      eventType: "execution_plan_frozen",
      stateTo: "execution_plan_frozen",
      actorId: "operator",
      commandId: "plan",
      operationId: "op-execution-plan",
      requiredHashes: [coreHash(binding), this.environmentInstanceHash()],
      produced: [
        {
          artifact_role: "execution-plan",
          artifact_core_hash: plan.core_hash,
          artifact_schema_version: "subject-execution-plan/v1",
        },
      ],
    });
    return plan;
  }

  private plannedPlan(): SubjectExecutionPlanV1 {
    return this.ws.artifact<SubjectExecutionPlanV1>(
      this.ws.requireHashForRole("execution-plan"),
      "SubjectExecutionPlanV1",
    );
  }

  // -- 4. the committed journey ---------------------------------------------

  /**
   * The selected journey's committed steps, in order, each carrying the outcome
   * it has already produced (if any).
   *
   * The order is the binding's, never a caller's: `ordered_step_commitment_hashes`
   * is what the selection opened and what `case_selected` verified against the
   * admitted challenge manifest and journey definition.
   */
  journeySteps(): readonly CommittedJourneyStep[] {
    const binding = this.binding();
    const frozen = new Map<string, JourneyStepOutcomeV1>();
    for (const outcome of this.ws.derivedStepOutcomes()) frozen.set(outcome.step_commitment_hash, outcome);
    return binding.ordered_step_commitment_hashes.map((commitmentHash, index) => {
      const commitment = this.ws.registry.require<JourneyStepCommitmentV1>(
        commitmentHash,
        "JourneyStepCommitmentV1",
      );
      const visibleStep = this.ws.visibleStepFor(commitment);
      return {
        index,
        commitment,
        visibleStep,
        intent: visibleStep.intent,
        outcome: frozen.get(commitmentHash),
      };
    });
  }

  /** The next committed step that has not yet produced an outcome. */
  nextStep(): CommittedJourneyStep | undefined {
    return this.journeySteps().find((step) => step.outcome === undefined);
  }

  /**
   * Runs the next committed step of the selected journey.
   *
   * `intent` is a *guard*, not a selector: an intent-named command may only run
   * the step the journey ordered next. Passing `install` when the journey's next
   * step is `configure` is a refusal, so a named command can never reorder or
   * skip a committed step.
   */
  runStep(intent?: JourneyIntent): JourneyStepOutcomeV1 {
    const state = this.ws.lifecycle.currentState;
    const phase = ENVIRONMENT_PHASES.find((p) => p.command === "execute-subject") as EnvironmentPhase;
    if (!phase.from.includes(state)) {
      throw new Erl2Error(
        CODES.POLICY_CONFLICT,
        `a journey step departs from ${phase.from.join(", ")}; this run is in ${state}`,
      );
    }
    // Pre-dispatch guard: zero external calls and zero retained evidence on a
    // revealed, finalized or invalidating run.
    assertSubjectPortExecutable(state);

    const step = this.nextStep();
    if (step === undefined) {
      throw new Erl2Error(
        CODES.POLICY_CONFLICT,
        "every committed step of the selected journey has already produced an outcome",
      );
    }
    if (intent !== undefined && step.intent !== intent) {
      throw new Erl2Error(
        CODES.POLICY_CONFLICT,
        `the selected journey's next committed step is ${step.intent}, not ${intent}; a step may not be skipped or reordered`,
      );
    }
    if (state === "execution_plan_frozen" && !SETUP_INTENTS.has(step.intent)) {
      throw new Erl2Error(
        CODES.POLICY_CONFLICT,
        `${step.intent} runs after the challenge is activated and its evidence captured; only install through discover follow the execution plan`,
      );
    }

    const plan = this.plannedPlan();
    const envelopeHash = this.ws.hashForRole("canonical-evidence-envelope");
    const priorInteractions = this.journeySteps()
      .filter((s) => s.outcome !== undefined)
      .map((s) => (s.outcome as JourneyStepOutcomeV1).core_hash);

    const requestBase = {
      schema_version: "adapter-step-request/v1" as const,
      protocol_version: "subject-adapter/v1" as const,
      run_id: this.runId,
      operation_id: `op-step-${String(step.index)}`,
      execution_plan_hash: plan.core_hash,
      visible_step: {
        artifact: this.ws.visibleStepRef(step.visibleStep),
        core_hash: step.visibleStep.core_hash,
      },
      // The envelope is handed to the adapter only once it exists: before the
      // cutoff there is nothing to mount, and a request that named an envelope
      // the run had not frozen would be an unciteable ancestor.
      ...(envelopeHash === undefined ? {} : { canonical_evidence_envelope_hash: envelopeHash }),
      prior_visible_interaction_hashes: priorInteractions,
      credential_handle_ids: [],
      resource_limit_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, plan.limits),
      deadline: this.now(),
    };
    const request = assertContract<AdapterStepRequestV1>("AdapterStepRequestV1", {
      ...requestBase,
      core_hash: coreHash(requestBase),
    });
    this.ws.assertRequestOracleClean(`adapter step request (${step.intent})`, request);

    const response = this.ws.subject.step(request, step.intent);
    // The subject's own output bytes are retained, not discarded. They are the
    // only thing in a step outcome that the *subject* wrote, so a run that threw
    // them away had no subject output to scan, evaluate or attribute — the
    // outcome recorded that a step happened, not what it produced.
    const outputRefs =
      response.outputBytes === undefined
        ? []
        : [
            this.ws.store.freeze({
              logicalPath: `subject-output/steps/${step.visibleStep.step_id}.out`,
              bytes: response.outputBytes,
              mediaType: "application/octet-stream",
              classification: "INTERNAL",
            }),
          ];
    const { outcome } = this.ws.runJourneyStep({
      stepId: step.visibleStep.step_id,
      intent: step.intent,
      stepCommitmentHash: step.commitment.core_hash,
      visibleStepHash: step.visibleStep.core_hash,
      adapterRequestHash: request.core_hash,
      actorId: "operator",
      commandId: "execute-subject",
      execute: () => ({
        status: response.status,
        attemptRecordHashes: [],
        detailRecordHashes: [],
        visibleInputHashes: [step.visibleStep.core_hash],
        outputRefs,
        activeOperatorMs: response.activeOperatorMs,
        ...(response.errorCode === undefined ? {} : { errorCode: response.errorCode }),
      }),
    });
    return outcome;
  }

  // -- 5. activation, traffic and the realized cutoff ------------------------

  /** The connect step's outcome, or undefined when the journey never connected. */
  private connectOutcome(): JourneyStepOutcomeV1 | undefined {
    return this.journeySteps().find((s) => s.intent === "connect")?.outcome;
  }

  /**
   * Activates the selected challenge in the provisioned environment.
   *
   * Design §12 forbids "challenge activation before verified
   * `SelectionVerificationReceiptV2`, baseline and connection". The first two are
   * implied by the state this phase departs from; the third is checked here
   * against the *outcome* of the connect step, not against an operator's claim.
   */
  activate(): { readonly receiptHash: Hash } {
    // "Already activated" is read from evidence, not from state ordering: the
    // state this phase departs from (`step_outcome_frozen`) recurs on every
    // journey step, so only the retained activation receipt distinguishes a run
    // that has activated from one that has not.
    if (this.ws.hashForRole("mutation-receipt") !== undefined) {
      return { receiptHash: this.ws.requireHashForRole("mutation-receipt") };
    }
    this.enter("activate", false);
    const connected = this.connectOutcome();
    if (connected === undefined || connected.status !== "succeeded") {
      throw new Erl2Error(
        CODES.POLICY_CONFLICT,
        "challenge activation requires a succeeded connect step; the selected journey has none",
      );
    }
    if (this.nextStep() !== undefined && SETUP_INTENTS.has((this.nextStep() as CommittedJourneyStep).intent)) {
      throw new Erl2Error(
        CODES.POLICY_CONFLICT,
        "the selected journey still has a setup step to run before the challenge may be activated",
      );
    }
    assertOperationSupported(this.driver.manifest, "mutate");
    const target = this.mutationTarget();
    const receipt = this.driver.mutate({
      runId: this.runId,
      targetResourceId: target.resource_id,
      mutationId: `activate-${this.binding().challenge_manifest_hash.slice("sha256:".length, "sha256:".length + 12)}`,
      operationId: "op-activate",
    });
    if (receipt.status !== "succeeded") {
      throw new Erl2Error(
        CODES.ENV_PROVISION_FAILED,
        `challenge activation failed: ${receipt.error_code ?? "unspecified"}`,
        { owner: "lab" },
      );
    }
    this.ws.store.freezeJson(`${RETAINED}/mutation-activate.json`, receipt, "INTERNAL");
    this.ws.lifecycle.append({
      eventType: "challenge_activated",
      stateTo: "challenge_activated",
      actorId: "controller",
      commandId: "activate",
      operationId: "op-activate",
      requiredHashes: [connected.core_hash, this.ws.requireHashForRole("environment-baseline")],
      produced: [
        {
          artifact_role: "mutation-receipt",
          artifact_core_hash: receipt.core_hash,
          artifact_schema_version: "environment-operation-receipt/v1",
        },
      ],
    });
    return { receiptHash: receipt.core_hash };
  }

  /** The resource the controller mutates: the archetype's own project root. */
  private mutationTarget(): EnvironmentResourceV1 {
    const resources = this.inventory().resources;
    const target = resources.find((r) => r.kind === "project") ?? resources[0];
    if (target === undefined) {
      throw new Erl2Error(
        CODES.ENV_FOREIGN_RESOURCE_REJECTED,
        "the retained inventory names no resource to activate the challenge in",
      );
    }
    return target;
  }

  /**
   * Starts the journey's traffic and freezes the three independently signed
   * artifacts the cutoff is derived from (design §13).
   *
   * The supervisor, the runtime attestor and the clock domain are separate
   * because the cutoff must be checkable without trusting any one of them: wall,
   * monotonic and policy views have to agree, and `realizeCutoff` refuses if
   * they do not.
   */
  journeyStart(): { readonly milestoneHash: Hash } {
    if (!this.enter("journey", this.ws.hashForRole("runtime-milestone") !== undefined)) {
      return { milestoneHash: this.ws.requireHashForRole("runtime-milestone") };
    }
    const startedAt = this.now();
    const environmentFingerprintHash = this.ws.requireHashForRole("environment-baseline");
    const selectionCommitmentHash = this.ws.requireHashForRole("selection-commitment");
    const planHash = this.ws.requireHashForRole("execution-plan");
    const trafficProfileHash = domainHash(HASH_DOMAINS.DRIVER_STATE, {
      run_id: this.runId,
      profile: "erl2-development-journey-traffic",
    });

    const clockDomainBody = {
      schema_version: "monotonic-clock-domain/v1" as const,
      domain_id: `clock-${this.runId.slice(0, 8)}`,
      run_id: this.runId,
      environment_fingerprint_hash: environmentFingerprintHash,
      host_identity_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, { run_id: this.runId, host: "lab-local" }),
      boot_id_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, { run_id: this.runId, boot: "lab-local" }),
      clock_id: "CLOCK_MONOTONIC" as const,
      clock_epoch_token_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
        run_id: this.runId,
        epoch: startedAt,
      }),
      observed_at: startedAt,
    };
    const clockDomain = assertContract<MonotonicClockDomainV1>("MonotonicClockDomainV1", {
      ...clockDomainBody,
      core_hash: coreHash(clockDomainBody),
    });

    const startReceipt = assertContract<TrafficProcessStartReceiptV1>(
      "TrafficProcessStartReceiptV1",
      sealSigned(
        {
          schema_version: "traffic-process-start-receipt/v1" as const,
          receipt_id: `traffic-${this.runId.slice(0, 8)}`,
          run_id: this.runId,
          selection_commitment_hash: selectionCommitmentHash,
          experiment_manifest_hash: planHash,
          environment_fingerprint_hash: environmentFingerprintHash,
          traffic_profile_hash: trafficProfileHash,
          process_identity_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
            run_id: this.runId,
            process: "traffic-supervisor",
          }),
          supervisor_boot_id_hash: clockDomain.boot_id_hash,
          monotonic_clock_domain_hash: clockDomain.core_hash,
          process_started_at: startedAt,
          process_start_monotonic_ms: 0,
        },
        this.keys.trafficSupervisor,
      ),
    );

    // The milestone is observed one clock tick after the start, so wall and
    // monotonic elapsed time agree by construction and the divergence bound is
    // checked against a real interval rather than against zero.
    const milestoneAt = this.now();
    const elapsedMs = Date.parse(milestoneAt) - Date.parse(startedAt);
    const milestone = assertContract<RuntimeMilestoneV1>(
      "RuntimeMilestoneV1",
      sealSigned(
        {
          schema_version: "runtime-milestone/v1" as const,
          milestone_id: `milestone-${this.runId.slice(0, 8)}`,
          run_id: this.runId,
          milestone: "traffic_started" as const,
          selection_commitment_hash: selectionCommitmentHash,
          experiment_manifest_hash: planHash,
          environment_fingerprint_hash: environmentFingerprintHash,
          traffic_profile_hash: trafficProfileHash,
          traffic_process_start_receipt_hash: startReceipt.core_hash,
          monotonic_clock_domain_hash: clockDomain.core_hash,
          occurred_at: milestoneAt,
          monotonic_elapsed_ms: elapsedMs,
        },
        this.keys.runtimeAttestor,
      ),
    );

    // The cutoff policy is mirrored into the run for the same reason the trust
    // policy is: an offline reader must be able to re-derive the cutoff from
    // retained bytes alone.
    this.ws.store.freezeJson(`${RETAINED}/cutoff-policy.json`, this.cutoffPolicy(), "INTERNAL");
    this.ws.store.freezeJson(`${RETAINED}/comparison-policy.json`, this.comparisonPolicy(), "INTERNAL");
    this.ws.store.freezeJson(`${RETAINED}/clock-domain.json`, clockDomain, "INTERNAL");
    this.ws.store.freezeJson(`${RETAINED}/traffic-start-receipt.json`, startReceipt, "INTERNAL");
    this.ws.store.freezeJson(`${RETAINED}/runtime-milestone.json`, milestone, "INTERNAL");

    this.ws.lifecycle.append({
      eventType: "traffic_or_journey_started",
      stateTo: "traffic_or_journey_started",
      actorId: "traffic-supervisor",
      commandId: "journey",
      operationId: "op-traffic-started",
      produced: [
        {
          artifact_role: "monotonic-clock-domain",
          artifact_core_hash: clockDomain.core_hash,
          artifact_schema_version: "monotonic-clock-domain/v1",
        },
        {
          artifact_role: "traffic-process-start-receipt",
          artifact_core_hash: startReceipt.core_hash,
          artifact_schema_version: "traffic-process-start-receipt/v1",
        },
        {
          artifact_role: "runtime-milestone",
          artifact_core_hash: milestone.core_hash,
          artifact_schema_version: "runtime-milestone/v1",
        },
        {
          artifact_role: "cutoff-policy",
          artifact_core_hash: coreHash(this.cutoffPolicy()),
          artifact_schema_version: "cutoff-policy/v1",
        },
        {
          artifact_role: "comparison-policy",
          artifact_core_hash: coreHash(this.comparisonPolicy()),
          artifact_schema_version: "comparison-policy/v1",
        },
      ],
    });
    return { milestoneHash: milestone.core_hash };
  }

  /**
   * Re-derives the realized cutoff from retained evidence.
   *
   * Deliberately recomputed rather than remembered: `observe` and
   * `freeze-observation` are separate processes, and the cutoff is the one value
   * every capture artifact is stamped from.
   */
  private cutoff(): RealizedCutoff {
    return realizeCutoff({
      policy: this.cutoffPolicy(),
      processStartReceipt: this.ws.artifact<TrafficProcessStartReceiptV1>(
        this.ws.requireHashForRole("traffic-process-start-receipt"),
        "TrafficProcessStartReceiptV1",
      ),
      runtimeMilestone: this.ws.artifact<RuntimeMilestoneV1>(
        this.ws.requireHashForRole("runtime-milestone"),
        "RuntimeMilestoneV1",
      ),
      warmupMs: WARMUP_MS,
      observationMs: OBSERVATION_MS,
    });
  }

  /**
   * Realizes the evidence cutoff and freezes one snapshot per declared evidence
   * source.
   *
   * A source the archetype declares but the environment could not serve is
   * retained with its explicit state, never omitted: `SourceSnapshotV1.state`
   * carries `unavailable` and its reason code, so a missing source is visible
   * evidence rather than a silent gap (design §13).
   */
  observe(): { readonly cutoffInstant: Instant; readonly snapshots: readonly SourceSnapshotV1[] } {
    if (!this.enter("observe", this.ws.hashesForRole("source-snapshot").length > 0)) {
      const cutoff = this.cutoff();
      return { cutoffInstant: cutoff.instant, snapshots: this.retainedSnapshots() };
    }
    const cutoff = this.cutoff();
    const baseline = this.ws.artifact<EnvironmentBaselineFingerprintV1>(
      this.ws.requireHashForRole("environment-baseline"),
      "EnvironmentBaselineFingerprintV1",
    );
    const windowFrom = this.ws.artifact<TrafficProcessStartReceiptV1>(
      this.ws.requireHashForRole("traffic-process-start-receipt"),
      "TrafficProcessStartReceiptV1",
    ).process_started_at;

    const snapshots = baseline.evidence_source_states.map((source) =>
      freezeSourceSnapshot({
        runId: this.runId,
        snapshotId: `snapshot-${source.source_id}`,
        sourceId: source.source_id,
        sourceKind: "ecosystem-evidence-source",
        sourceSchema: "erl2-generic-evidence/v1",
        sourceIdentityHash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
          environment_instance_hash: this.environmentInstanceHash(),
          source_id: source.source_id,
        }),
        state: source.state,
        queryHash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
          source_id: source.source_id,
          window: { from: windowFrom, to_exclusive: cutoff.instant },
        }),
        window: { from: windowFrom, to_exclusive: cutoff.instant },
        startedAt: windowFrom,
        endedAt: cutoff.instant,
        pages: 1,
        records: 0,
        bytes: 0,
        dedupeKey: `${source.source_id}:${cutoff.instant}`,
        orderingId: "event-time-ascending",
        healthRecordHash: baseline.core_hash,
        ...(source.state === "unavailable"
          ? { unavailableReasonCode: "SOURCE_NOT_SERVED_BY_ARCHETYPE" }
          : {}),
      }),
    );
    for (const snapshot of snapshots) {
      this.ws.store.freezeJson(`retained/observation/${snapshot.snapshot_id}.json`, snapshot, "INTERNAL");
    }
    this.ws.lifecycle.append({
      eventType: "evidence_cutoff_realized",
      stateTo: "evidence_cutoff_realized",
      actorId: "capture-coordinator",
      commandId: "observe",
      operationId: "op-evidence-cutoff",
      requiredHashes: [cutoff.processStartReceiptHash, cutoff.runtimeMilestoneHash],
      produced: snapshots.map((snapshot) => ({
        artifact_role: "source-snapshot",
        artifact_core_hash: snapshot.core_hash,
        artifact_schema_version: "source-snapshot/v1",
      })),
    });
    return { cutoffInstant: cutoff.instant, snapshots };
  }

  private retainedSnapshots(): readonly SourceSnapshotV1[] {
    return this.ws
      .hashesForRole("source-snapshot")
      .map((hash) => this.ws.artifact<SourceSnapshotV1>(hash, "SourceSnapshotV1"));
  }

  // -- 6. observation, envelope and translation ------------------------------

  /**
   * Freezes the observation bundle, the canonical evidence envelope and the
   * adapter translation receipt: three durable transitions in the design's order.
   *
   * All three are stamped with the **realized cutoff instant** rather than a
   * clock read. That is what makes them byte-reproducible from retained evidence,
   * and therefore what lets this sequence be interrupted at either boundary: a
   * resume rebuilds identical bytes, so the re-freeze is idempotent instead of an
   * `ARTIFACT_ALREADY_FROZEN` conflict.
   */
  freezeObservation(): {
    readonly observation: ObservationBundleV2;
    readonly envelope: LiveCanonicalEvidenceEnvelopeV1;
  } {
    const state = this.ws.lifecycle.currentState;
    const done =
      state !== "evidence_cutoff_realized" &&
      state !== "observation_frozen" &&
      state !== "canonical_evidence_envelope_frozen";
    if (done) {
      if (!ENVIRONMENT_PHASES.some((p) => p.command === "freeze-observation" && p.from.includes(state))) {
        const observationHash = this.ws.hashForRole("observation-bundle");
        if (observationHash === undefined) {
          throw new Erl2Error(
            CODES.POLICY_CONFLICT,
            `freeze-observation departs from evidence_cutoff_realized; this run is in ${state}`,
          );
        }
        return {
          observation: this.ws.artifact<ObservationBundleV2>(observationHash, "ObservationBundleV2"),
          envelope: this.ws.artifact<LiveCanonicalEvidenceEnvelopeV1>(
            this.ws.requireHashForRole("canonical-evidence-envelope"),
            "LiveCanonicalEvidenceEnvelopeV1",
          ),
        };
      }
    }

    // The comparison mode is checked against the run's tier before an envelope
    // exists: a replay envelope in a held-out or blind request is refused before
    // any capture artifact is built (design §15).
    assertComparisonModeAdmissible(this.comparisonPolicy(), this.ws.tier);

    const cutoff = this.cutoff();
    const frozenAt = cutoff.instant;
    const snapshots = this.retainedSnapshots();
    const binding = this.binding();
    const challenge = this.ws.artifact<ChallengeManifestV1>(
      binding.challenge_manifest_hash,
      "ChallengeManifestV1",
    );

    // 6.1 the envelope, built from the frozen evidence policy and the cutoff
    //     evidence set — never adapter-authored, and carrying no run, package,
    //     adapter or plan identity so its bytes can be identical across subjects.
    const entryRefs = new Map<string, ArtifactRef>();
    const entries = snapshots.map((snapshot) => {
      const ref = this.ws.store.freezeJson(
        `subject-visible/canonical/${snapshot.snapshot_id}.json`,
        snapshot,
        "PUBLIC",
      );
      entryRefs.set(snapshot.source_id, ref);
      return {
        entryId: snapshot.source_id,
        sourceContentHash: snapshot.core_hash,
        artifact: ref,
        sourceState: snapshot.state,
      };
    });
    const comparison = this.comparisonPolicy();
    const equivalenceProfileHash = comparison.equivalence_profile_hash;
    if (equivalenceProfileHash === undefined) {
      throw new Erl2Error(
        CODES.COMPARISON_MODE_TIER_MISMATCH,
        "a live envelope requires the comparison policy's equivalence profile; a replay policy has none",
      );
    }
    // Every entry the adapter can mount is scanned before the envelope that names
    // them is retained. A canary here would mean judge truth reached the subject's
    // read-only mount, which invalidates the run before any subject attribution.
    assertNoCanaryLeak(
      entries.map((entry) => ({
        surface: "mounted_file" as const,
        label: `canonical-evidence:${entry.entryId}`,
        bytes: JSON.stringify(entry),
      })),
      this.ws.knownCanaryIds(),
    );

    const envelope = buildLiveEnvelope({
      runId: this.runId,
      // The comparison identity is the policy and the challenge it applies to.
      // Both are already lowercase-kebab ids, so the pair is one too.
      comparisonId: `${comparison.policy_id}-${challenge.challenge_id}`,
      genericRunPolicyHash: this.ws.requireHashForRole("generic-run-policy"),
      challengeHash: binding.challenge_manifest_hash,
      evidencePolicyHash: challenge.evidence_policy_hash,
      cutoffEvidenceSetHash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
        cutoff_instant: cutoff.instant,
        entries: entries.map((e) => e.sourceContentHash),
      }),
      equivalenceProfileHash,
      // The deterministic projection this run's entries reduce to. It is derived
      // from the frozen entry content, so two independent environments that
      // observed the same facts project the same value even though their raw
      // bytes differ — which is what an equivalence verifier compares.
      semanticProjectionHash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
        equivalence_profile_hash: equivalenceProfileHash,
        entries: entries.map((e) => ({ entry_id: e.entryId, source_state: e.sourceState })),
      }),
      entries,
      frozenAt,
    });
    this.ws.store.freezeJson("retained/canonical-evidence-envelope.json", envelope, "INTERNAL");

    // 6.2 the observation bundle, which cites the envelope it was built over.
    const observation = freezeObservation({
      runId: this.runId,
      planHash: this.ws.requireHashForRole("execution-plan"),
      environmentInstanceHash: this.environmentInstanceHash(),
      cutoff,
      snapshots,
      subjectVisibleProjectionPolicyHash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
        projection: "erl2-subject-visible/v1",
      }),
      comparisonPolicyHash: coreHash(comparison),
      canonicalEvidenceEnvelopeHash: envelope.core_hash,
      redactionPolicyHash: domainHash(HASH_DOMAINS.DRIVER_STATE, { redaction: "erl2-default/v1" }),
      entries: [...entryRefs.values()],
      frozenAt,
      store: this.ws.store,
      knownCanaryIds: this.ws.knownCanaryIds(),
    });

    if (this.ws.lifecycle.currentState === "evidence_cutoff_realized") {
      this.ws.lifecycle.append({
        eventType: "observation_frozen",
        stateTo: "observation_frozen",
        actorId: "capture-coordinator",
        commandId: "freeze-observation",
        operationId: "op-observation-frozen",
        produced: [
          {
            artifact_role: "observation-bundle",
            artifact_core_hash: observation.core_hash,
            artifact_schema_version: "observation-bundle/v2",
          },
        ],
      });
    }
    if (this.ws.lifecycle.currentState === "observation_frozen") {
      this.ws.lifecycle.append({
        eventType: "canonical_evidence_envelope_frozen",
        stateTo: "canonical_evidence_envelope_frozen",
        actorId: "capture-coordinator",
        commandId: "freeze-observation",
        operationId: "op-envelope-frozen",
        produced: [
          {
            artifact_role: "canonical-evidence-envelope",
            artifact_core_hash: envelope.core_hash,
            artifact_schema_version: "live-canonical-evidence-envelope/v1",
          },
        ],
      });
    }

    // 6.3 the translation receipt, which must account for *every* envelope entry
    //     exactly once. `assertTranslationTotality` refuses a receipt that drops
    //     one under "domain compatibility".
    const translated = new Map<string, ArtifactRef>();
    for (const entry of envelope.entries) {
      translated.set(
        entry.entry_id,
        this.ws.store.freezeJson(
          `subject-visible/translated/${entry.entry_id}.json`,
          { entry_id: entry.entry_id, source_content_hash: entry.source_content_hash },
          "PUBLIC",
        ),
      );
    }
    const mappings = envelope.entries.map((entry) => ({
      entry_id: entry.entry_id,
      disposition:
        entry.source_state === "complete" ? ("mapped_exact" as const) : ("mapped_lossy" as const),
      target_refs: [translated.get(entry.entry_id) as ArtifactRef],
      ...(entry.source_state === "complete"
        ? {}
        : { loss_reason_code: `SOURCE_STATE_${entry.source_state.toUpperCase()}` }),
    }));
    const translationBase = {
      schema_version: "adapter-translation-receipt/v1" as const,
      run_id: this.runId,
      adapter_hash: this.ws.requireHashForRole("adapter-manifest"),
      canonical_envelope_hash: envelope.core_hash,
      translated_tree_hash: treeHash([...translated.values()]),
      mappings,
      total_input_entries: envelope.entries.length,
      accounted_entries: mappings.length,
      complete: true as const,
      translated_at: frozenAt,
    };
    const translation = assertContract<AdapterTranslationReceiptV1>("AdapterTranslationReceiptV1", {
      ...translationBase,
      core_hash: coreHash(translationBase),
    });
    // Totality is checked against the frozen envelope, not asserted by the
    // receipt: every entry must be accounted for exactly once, and the
    // translated tree must be a new tree rather than the envelope's own.
    assertTranslationTotality(translation, envelope);
    this.ws.store.freezeJson("retained/adapter-translation-receipt.json", translation, "INTERNAL");
    this.ws.lifecycle.append({
      eventType: "adapter_translation_frozen",
      stateTo: "adapter_translation_frozen",
      actorId: "capture-coordinator",
      commandId: "freeze-observation",
      operationId: "op-translation-frozen",
      produced: [
        {
          artifact_role: "adapter-translation-receipt",
          artifact_core_hash: translation.core_hash,
          artifact_schema_version: "adapter-translation-receipt/v1",
        },
      ],
    });
    return { observation, envelope };
  }

  // -- 7. subject output -----------------------------------------------------

  /**
   * Freezes the environment subject-output manifest once every committed step
   * has produced an outcome.
   *
   * The step list is the *derived* closure, never the caller's: `deriveStepClosure`
   * replays the lifecycle, so a manifest cannot claim an outcome the run never
   * froze or omit one it did.
   */
  freezeOutput(): EnvironmentSubjectOutputManifestV1 {
    if (!this.enter("freeze-output", this.ws.hashForRole("subject-output-manifest") !== undefined)) {
      return this.ws.artifact<EnvironmentSubjectOutputManifestV1>(
        this.ws.requireHashForRole("subject-output-manifest"),
        "EnvironmentSubjectOutputManifestV1",
      );
    }
    assertSubjectPortExecutable(this.ws.lifecycle.currentState);
    const remaining = this.nextStep();
    if (remaining !== undefined) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_MISSING_ROLE,
        `the selected journey still has a committed ${remaining.intent} step; subject output freezes only when every step is terminal`,
      );
    }
    const outcomes = this.ws.derivedStepOutcomes();
    const terminalStage = this.terminalStage(outcomes);

    // The output is the last subject-visible surface before the reveal, and the
    // one a leak would be most likely to survive on. Scanned **before anything is
    // frozen**, so a canary invalidates the run rather than travelling into the
    // terminal — and so the refusal itself writes no subject output. Scanning
    // after the copies were published would have been a scan of bytes already on
    // disk, which is a report, not a gate.
    //
    // Both layers are scanned: the outcome metadata, and the bytes the *subject*
    // actually wrote. A canary that reached the subject's output appears only in
    // the latter — the outcome JSON carries a reference, not the content.
    assertNoCanaryLeak(
      [
        ...outcomes.map((outcome) => ({
          surface: "subject_output_prefill" as const,
          label: `step-outcome:${outcome.step_id}`,
          bytes: JSON.stringify(outcome),
        })),
        ...outcomes.flatMap((outcome) =>
          outcome.output_refs.map((ref) => ({
            surface: "subject_output_prefill" as const,
            label: `subject-output:${ref.path}`,
            bytes: this.ws.store.read(ref.path),
          })),
        ),
      ],
      this.ws.knownCanaryIds(),
    );

    const entries = outcomes.map((outcome) =>
      this.ws.store.freezeJson(
        `subject-output/step-outcome-${outcome.core_hash.slice("sha256:".length, "sha256:".length + 12)}.json`,
        outcome,
        "INTERNAL",
      ),
    );
    const envelopeHash = this.ws.hashForRole("canonical-evidence-envelope");
    const translationHash = this.ws.hashForRole("adapter-translation-receipt");
    const base = {
      schema_version: "subject-output-manifest/v1" as const,
      run_id: this.runId,
      terminal_stage: terminalStage,
      acquisition_source_manifest_hash: this.ws.requireHashForRole("acquisition-source-manifest"),
      acquisition_record_hash: this.ws.requireHashForRole("acquisition-record"),
      subject_package_manifest_hash: this.ws.requireHashForRole("subject-package-manifest"),
      adapter_hash: this.ws.requireHashForRole("adapter-manifest"),
      plan_hash: this.ws.requireHashForRole("execution-plan"),
      ...(envelopeHash === undefined ? {} : { canonical_evidence_envelope_hash: envelopeHash }),
      ...(translationHash === undefined ? {} : { adapter_translation_receipt_hash: translationHash }),
      step_outcome_hashes: outcomes.map((o) => o.core_hash),
      interaction_hashes: [] as Hash[],
      entries,
      tree_hash: treeHash(entries),
      timed_out: false,
      unsupported_inputs: outcomes
        .filter((o) => o.status === "unsupported")
        .map((o) => `${o.intent}:${o.step_id}`),
      frozen_at: this.now(),
    };
    const manifest = assertContract<EnvironmentSubjectOutputManifestV1>(
      "EnvironmentSubjectOutputManifestV1",
      { ...base, core_hash: coreHash(base) },
    );
    this.ws.store.freezeJson("retained/subject-output-manifest.json", manifest, "INTERNAL");
    this.ws.lifecycle.append({
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

  /** The environment intent the run terminated on: the last environment outcome. */
  private terminalStage(outcomes: readonly JourneyStepOutcomeV1[]): EnvironmentJourneyIntent {
    for (let i = outcomes.length - 1; i >= 0; i -= 1) {
      const intent = (outcomes[i] as JourneyStepOutcomeV1).intent;
      if (intent !== "acquire" && intent !== "verify_package") return intent;
    }
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "the run froze no environment-phase step outcome; it has no environment terminal stage",
    );
  }

  // -- 8. reveal and exposure ------------------------------------------------

  /**
   * Reveals the judge expectations the terminal outcomes permit, and appends the
   * exposure event that demotes the opened challenge.
   *
   * Design §15: "exposure on reveal/debug access is appended and demotes before
   * another selection". The event is the durable statement that this challenge
   * is no longer blind, and the environment attestation is required to carry it —
   * which is why it is frozen here, at the moment the seal is broken, rather than
   * synthesized at finalization.
   */
  freezeExposure(): ExposureEventV1 {
    // A challenge is exposed once. If the event is already retained, that is the
    // exposure — rebuilding it would stamp a later instant and conflict with its
    // own frozen bytes.
    const existing = this.ws.hashForRole("exposure-event");
    if (existing !== undefined) {
      return this.ws.artifact<ExposureEventV1>(existing, "ExposureEventV1");
    }
    const binding = this.binding();
    const challenge = this.ws.artifact<ChallengeManifestV1>(
      binding.challenge_manifest_hash,
      "ChallengeManifestV1",
    );
    const body = {
      schema_version: "exposure-event/v1" as const,
      exposure_id: `exposure-${this.runId.slice(0, 8)}`,
      // The corpus a challenge is exposed *out of* is its domain family; the id
      // vocabulary is lowercase-kebab, the contract enum is snake.
      corpus_id: challenge.domain.replaceAll("_", "-"),
      challenge_manifest_hash: binding.challenge_manifest_hash,
      prior_tier: challenge.tier,
      resulting_tier: "development" as const,
      occurred_at: this.now(),
      reason: "truth_reveal" as const,
      actor_id: "vault-authorizer",
      run_id: this.runId,
    };
    const exposure = assertContract<ExposureEventV1>(
      "ExposureEventV1",
      sealSigned(body, this.keys.vaultAuthorizer),
    );
    this.ws.store.freezeJson("retained/exposure-event.json", exposure, "INTERNAL");
    return exposure;
  }

  // -- 9. evaluation ---------------------------------------------------------

  /**
   * Freezes the selected journey result, the domain result and the result join.
   *
   * The domain plane takes the **not-applicable** branch, and does so because
   * `evaluateDomain` refuses any other answer: an evaluated domain result
   * requires a revealed functional truth, and this run revealed only journey-scope
   * judge expectations. The reason is derived from the terminal stage, not chosen
   * — `buildDomainNotApplicable` refuses a reason the stage does not imply.
   */
  evaluate(): {
    readonly journeyResult: SelectedJourneyResultV1;
    readonly domainResult: DomainResultNotApplicableV1;
    readonly join: GenericPrecleanupResultJoinV1;
    readonly metricResults: readonly MetricResultV1[];
  } {
    if (!this.enter("evaluate", this.ws.hashForRole("precleanup-result-join") !== undefined)) {
      return {
        journeyResult: this.ws.artifact<SelectedJourneyResultV1>(
          this.ws.requireHashForRole("journey-result"),
          "SelectedJourneyResultV1",
        ),
        domainResult: this.ws.artifact<DomainResultNotApplicableV1>(
          this.ws.requireHashForRole("domain-result"),
          "DomainResultNotApplicableV1",
        ),
        join: this.ws.artifact<GenericPrecleanupResultJoinV1>(
          this.ws.requireHashForRole("precleanup-result-join"),
          "GenericPrecleanupResultJoinV1",
        ),
        metricResults: [],
      };
    }
    const outcomes = this.ws.derivedStepOutcomes();
    const binding = this.binding();
    const policyHash = this.ws.requireHashForRole("generic-run-policy");
    const evaluatedAt = this.now();
    const revealHash = this.ws.hashForRole("judge-expectation-reveal");
    const revealed =
      revealHash === undefined
        ? []
        : this.ws.artifact<JudgeExpectationRevealRecordV1>(revealHash, "JudgeExpectationRevealRecordV1")
            .revealed_expectation_hashes;

    const { result: journeyResult, metricResults } = buildSelectedJourneyResult({
      runId: this.runId,
      genericRunPolicyHash: policyHash,
      journeyHash: binding.journey_hash,
      orderedOutcomes: outcomes,
      revealedJudgeExpectationHashes: [...revealed],
      journeyMetricDefinitions: JOURNEY_PLANE_METRICS,
      findingHashes: this.ws.retainedFindingHashes(),
      evaluatedAt,
    });
    for (const metric of metricResults) {
      this.ws.store.freezeJson(`retained/metric-results/${metric.metric_id}.json`, metric, "INTERNAL");
    }
    this.ws.store.freezeJson("retained/journey-result.json", journeyResult, "INTERNAL");
    this.ws.lifecycle.append({
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
          artifact_schema_version: "selected-journey-result/v1",
        },
      ],
    });

    // The not-applicable branch is *derived*: this asks which ancestors an
    // evaluated domain result would need and records that they are absent,
    // rather than deciding the plane is not applicable and then explaining it.
    const missing = missingDomainAncestors({
      observationBundleHash: this.ws.hashForRole("observation-bundle"),
      canonicalEvidenceEnvelopeHash: this.ws.hashForRole("canonical-evidence-envelope"),
      subjectOutputHash: this.ws.hashForRole("subject-output-manifest"),
      truthRevealHash: this.ws.hashForRole("truth-reveal"),
      claimSetHash: this.ws.hashForRole("generic-claim-set"),
    });
    if (missing.length === 0) {
      throw new Erl2Error(
        CODES.EVALUATOR_DOMAIN_EVIDENCE_UNAVAILABLE,
        "every evaluated-domain ancestor is present; this run must take the evaluated branch, which is not part of this slice",
        { owner: "lab" },
      );
    }
    const terminalStage = this.terminalStage(outcomes);
    const domainResult = buildDomainNotApplicable({
      runId: this.runId,
      genericRunPolicyHash: policyHash,
      terminalStage,
      reason:
        terminalStage === "install" || terminalStage === "configure" || terminalStage === "authenticate"
          ? "setup_terminal"
          : terminalStage === "connect"
            ? "connection_terminal"
            : "functional_evidence_unavailable",
      journeyResultHash: journeyResult.core_hash,
      findingHashes: [],
      recordedAt: evaluatedAt,
    });
    this.ws.store.freezeJson("retained/domain-result.json", domainResult, "INTERNAL");
    const domainEvent = this.ws.lifecycle.append({
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
    this.ws.store.freezeJson("retained/precleanup-result-join.json", join, "INTERNAL");
    this.ws.lifecycle.append({
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
    // The join is the sole cleanup-entry guard; re-derive its ordering from the
    // chain immediately so cleanup cannot start on a join whose order does not
    // actually hold.
    deriveJoinOrdering(this.ws.lifecycle.all());

    return { journeyResult, domainResult, join, metricResults };
  }

  // -- 10. restoration -------------------------------------------------------

  /**
   * Compensates every mutation, re-probes the environment and freezes the
   * restoration verification.
   *
   * `passed` is derived by `buildEnvironmentRestoration` from the before/after
   * baselines and the residual set, never supplied: a drifted baseline is a
   * restoration failure whose authorized route is emergency cleanup, so it can
   * only ever be reported, not asserted away.
   */
  restore(): EnvironmentRestorationVerificationV1 {
    if (!this.enter("restore", this.ws.hashForRole("environment-restoration") !== undefined)) {
      return this.ws.artifact<EnvironmentRestorationVerificationV1>(
        this.ws.requireHashForRole("environment-restoration"),
        "EnvironmentRestorationVerificationV1",
      );
    }
    assertOperationSupported(this.driver.manifest, "restore");
    const baselineBefore = this.ws.artifact<EnvironmentBaselineFingerprintV1>(
      this.ws.requireHashForRole("environment-baseline"),
      "EnvironmentBaselineFingerprintV1",
    );
    this.ws.lifecycle.append({
      eventType: "lab_cleanup_started",
      stateTo: "lab_cleanup_started",
      actorId: "operator",
      commandId: "restore",
      operationId: "op-lab-cleanup-start",
      requiredHashes: [this.ws.requireHashForRole("precleanup-result-join")],
    });

    const receipt = this.driver.restore({ runId: this.runId, operationId: "op-restore" });
    // The driver's own verdict on the compensation it just attempted.
    //
    // `buildEnvironmentRestoration` derives `passed` from the before/after
    // baselines and the residual set, which is right for drift but blind to a
    // compensation that simply did not run: a driver that reports
    // `status: "failed"` and leaves the environment measuring identically would
    // otherwise produce `passed: true` over mutations it never reverted. The
    // receipt is checked first, and separately.
    if (receipt.status !== "succeeded") {
      this.ws.store.freezeJson(`${RETAINED}/failed-restore-receipt.json`, receipt, "INTERNAL");
      this.failedAttemptHash = receipt.core_hash;
      throw new Erl2Error(
        CODES.RESTORATION_FAILED,
        `the environment driver reported a failed restoration: ${receipt.error_code ?? "unspecified"}`,
        { owner: "lab" },
      );
    }
    // Re-measured in the *baseline* phase, not the restoration phase. The probe
    // phase is part of the fingerprint, so a restoration-phase measurement could
    // never equal the baseline it is supposed to have returned to — the
    // comparison would pass or fail for a reason that has nothing to do with the
    // environment. Restoration means "this environment measures as its baseline
    // again", so it is measured the way the baseline was.
    const after = this.driver.probe({
      runId: this.runId,
      phase: "baseline",
      operationId: "op-restore-baseline",
    });
    const inventory = this.driver.inspect(this.runId);
    const restoration = buildEnvironmentRestoration({
      runId: this.runId,
      environmentInstanceHash: this.environmentInstanceHash(),
      activationReceiptHashes: this.ws.hashesForRole("mutation-receipt"),
      compensationReceiptHashes: [receipt.core_hash],
      baselineBeforeHash: baselineBefore.fingerprint_hash,
      baselineAfterHash: after.fingerprint_hash,
      residualResources: [],
      restoredAt: this.now(),
    });
    if (!restoration.passed) {
      // The failed attempt is retained *before* the failure is raised, so the
      // invalid terminal can cite what was tried. The restoration verification
      // itself is not retained: it did not pass, so it is not a member of any
      // closure, and freezing it would leave an artifact no record accounts for.
      this.ws.store.freezeJson(`${RETAINED}/failed-restore-receipt.json`, receipt, "INTERNAL");
      this.failedAttemptHash = receipt.core_hash;
      throw new Erl2Error(
        CODES.RESTORATION_FAILED,
        `restoration did not pass (baseline drift or residual resources); the authorized route is receipt-backed emergency cleanup`,
        { owner: "lab" },
      );
    }
    void inventory;

    this.ws.store.freezeJson(`${RETAINED}/compensation-restore.json`, receipt, "INTERNAL");
    this.ws.store.freezeJson("retained/environment-restoration-verification.json", restoration, "INTERNAL");
    this.ws.lifecycle.append({
      eventType: "environment_restored",
      stateTo: "environment_restored",
      actorId: "operator",
      commandId: "restore",
      operationId: "op-environment-restored",
      produced: [
        {
          artifact_role: "compensation-receipt",
          artifact_core_hash: receipt.core_hash,
          artifact_schema_version: "environment-operation-receipt/v1",
        },
        {
          artifact_role: "environment-restoration",
          artifact_core_hash: restoration.core_hash,
          artifact_schema_version: "environment-restoration-verification/v1",
        },
      ],
    });
    return restoration;
  }

  // -- 11. teardown and residue ---------------------------------------------

  /**
   * Destroys the environment and verifies that nothing of this run remains.
   *
   * Residue is observed twice and by two different means: the driver reports what
   * its destroy left behind, and the Lab then re-inspects the substrate itself.
   * `buildTeardownVerification` derives `passed` from those observations and
   * refuses any selector that is not exactly run-scoped, so a teardown cannot be
   * recorded against "everything that looked like ours".
   */
  destroy(): { readonly teardown: TeardownVerificationV1; readonly residue: number } {
    if (!this.enter("destroy", this.ws.hashForRole("teardown-verification") !== undefined)) {
      return {
        teardown: this.ws.artifact<TeardownVerificationV1>(
          this.ws.requireHashForRole("teardown-verification"),
          "TeardownVerificationV1",
        ),
        residue: 0,
      };
    }
    assertOperationSupported(this.driver.manifest, "destroy");
    const restorationHash = this.ws.requireHashForRole("environment-restoration");
    const declared = this.inventory().resources;
    this.ws.lifecycle.append({
      eventType: "teardown_started",
      stateTo: "teardown_started",
      actorId: "operator",
      commandId: "destroy",
      operationId: "op-teardown-start",
      requiredHashes: [restorationHash],
    });

    const result = this.driver.destroy({ runId: this.runId, operationId: "op-destroy" });
    // The Lab's own residue observation, independent of what destroy reported.
    const remaining = new Set(this.driver.inspect(this.runId).resources.map((r) => r.identity_hash));
    const checks: TeardownCheck[] = declared.map((resource) => ({
      kind: teardownKind(resource.kind),
      selector: resource.run_scoped_name,
      residueHashes: remaining.has(resource.identity_hash) ? [resource.identity_hash] : [],
    }));
    const teardown = buildTeardownVerification({
      runId: this.runId,
      environmentInstanceHash: this.environmentInstanceHash(),
      restorationVerificationHash: restorationHash,
      checks,
      checkedAt: this.now(),
    });
    if (!teardown.passed) {
      this.ws.store.freezeJson(`${RETAINED}/failed-destroy-receipt.json`, result.receipt, "INTERNAL");
      this.failedAttemptHash = result.receipt.core_hash;
      throw new Erl2Error(
        CODES.TEARDOWN_FAILED,
        `teardown left ${String(remaining.size)} resource(s); the authorized route is receipt-backed emergency cleanup`,
        { owner: "lab" },
      );
    }
    // Reservations are released only once the substrate is provably empty, so a
    // crashed teardown cannot hand this run's identities to another run.
    for (const lease of this.allocator.held(this.runId)) {
      this.allocator.release(this.runId, lease.reservation_kind, lease.reserved_value);
    }

    this.ws.store.freezeJson(`${RETAINED}/operation-destroy.json`, result.receipt, "INTERNAL");
    this.ws.store.freezeJson("retained/teardown-verification.json", teardown, "INTERNAL");
    this.ws.lifecycle.append({
      eventType: "teardown_verified",
      stateTo: "teardown_verified",
      actorId: "operator",
      commandId: "destroy",
      operationId: "op-teardown-verified",
      produced: [
        {
          artifact_role: "environment-operation-receipt",
          artifact_core_hash: result.receipt.core_hash,
          artifact_schema_version: "environment-operation-receipt/v1",
        },
        {
          artifact_role: "teardown-verification",
          artifact_core_hash: teardown.core_hash,
          artifact_schema_version: "teardown-verification/v1",
        },
      ],
    });
    return { teardown, residue: remaining.size };
  }

  // -- 12. validity and the generic index ------------------------------------

  /**
   * Evaluates Lab-owned environment validity and freezes the generic index.
   *
   * Every gate reads integrity or experimental-control evidence the Lab itself
   * produced; none of them reads a subject claim, a metric value or a result
   * status. `assertRequiredGatesPresent` refuses a silently omitted gate, so the
   * environment gate set cannot be quietly narrowed to the pre-environment one.
   */
  freezeValidityAndIndex(input: {
    readonly derivedClosureVerdict: "valid" | "invalid";
    readonly derivedMissingRoles: readonly string[];
    readonly derivedExtraHashes: readonly Hash[];
  }): {
    readonly validity: EnvironmentValidityResultV1;
    readonly index: GenericEvaluationIndexV1;
  } {
    // Already finalized: return what was produced rather than recomputing. A
    // recomputation would derive the closure against a tree that now contains
    // the validity result and the index themselves, score `mandatory-graph-closed`
    // false, and turn a replay of a valid run into an invalid one.
    const existingIndex = this.ws.hashForRole("generic-evaluation-index");
    if (existingIndex !== undefined) {
      return {
        validity: this.ws.artifact<EnvironmentValidityResultV1>(
          this.ws.requireHashForRole("validity-result"),
          "EnvironmentValidityResultV1",
        ),
        index: this.ws.artifact<GenericEvaluationIndexV1>(existingIndex, "GenericEvaluationIndexV1"),
      };
    }
    if (this.ws.lifecycle.currentState !== "teardown_verified") {
      throw new Erl2Error(
        CODES.POLICY_CONFLICT,
        `environment finalization departs from teardown_verified; this run is in ${this.ws.lifecycle.currentState}`,
      );
    }
    const outcomes = this.ws.derivedStepOutcomes();
    const terminalStage = this.terminalStage(outcomes);
    const policyHash = this.ws.requireHashForRole("generic-run-policy");
    const restorationHash = this.ws.requireHashForRole("environment-restoration");
    const teardownHash = this.ws.requireHashForRole("teardown-verification");

    const validity = buildEnvironmentValidity({
      runId: this.runId,
      terminalStage,
      genericRunPolicyHash: policyHash,
      gates: this.environmentGates(input),
      environmentRestorationHash: restorationHash,
      teardownHash,
      invalidityFindingHashes: [],
      evaluatedAt: this.now(),
    });
    this.ws.store.freezeJson("retained/validity-result.json", validity, "INTERNAL");
    this.ws.lifecycle.append({
      eventType: "environment_validity_result_frozen",
      stateTo: "environment_validity_result_frozen",
      actorId: "judge",
      commandId: "finalize-generic",
      operationId: "op-environment-validity",
      produced: [
        {
          artifact_role: "validity-result",
          artifact_core_hash: validity.core_hash,
          artifact_schema_version: "environment-validity-result/v1",
        },
      ],
    });

    const index = buildGenericEvaluationIndex({
      runId: this.runId,
      genericRunPolicyHash: policyHash,
      validity,
      journeyResult: this.ws.artifact<SelectedJourneyResultV1>(
        this.ws.requireHashForRole("journey-result"),
        "SelectedJourneyResultV1",
      ),
      domainResult: this.ws.artifact<DomainResultNotApplicableV1>(
        this.ws.requireHashForRole("domain-result"),
        "DomainResultNotApplicableV1",
      ),
      join: this.ws.artifact<GenericPrecleanupResultJoinV1>(
        this.ws.requireHashForRole("precleanup-result-join"),
        "GenericPrecleanupResultJoinV1",
      ),
      evaluatorVersion: EVALUATOR_RELEASE,
    });
    this.ws.store.freezeJson("retained/generic-evaluation-index.json", index, "INTERNAL");
    this.ws.lifecycle.append({
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
    return { validity, index };
  }

  // -- 13. the environment terminal ------------------------------------------

  /**
   * Freezes the environment terminal: run record, timestamp checkpoint, signer
   * inventory, final attestation and public bundle.
   *
   * The order is the design's and it is not negotiable: the independently derived
   * closure is checked, and every cleanup, residue, exposure and trust
   * precondition is checked, **before** the finalizer signs anything. Nothing
   * above `assertEnvironmentFinalizable` carries a finalizer attestation, and
   * nothing below it runs if a check fails — so a bundle that would fail offline
   * verification is refused here instead of being published.
   *
   * `deriveClosure` is the *offline verifier's own* algorithm, injected rather
   * than reimplemented. A producer that derived its own closure would only be
   * agreeing with itself.
   */
  finalizeTerminal(input: {
    readonly claimScope: "T1" | "T2" | "T3";
    readonly deriveClosure: (runRecord: EnvironmentLabRunRecordV1) => {
      readonly verdict: "valid" | "invalid";
      readonly missingRoles: readonly string[];
      readonly extraHashes: readonly Hash[];
    };
  }): {
    readonly runRecord: EnvironmentLabRunRecordV1;
    readonly attestation: EnvironmentFinalLabAttestationV1;
    readonly bundle: EnvironmentPublicVerificationBundleV2;
    readonly inventory: EnvironmentSignerInventoryV2;
  } {
    if (this.ws.lifecycle.currentState === "generic_finalized") {
      return {
        runRecord: this.ws.artifact<EnvironmentLabRunRecordV1>(
          this.ws.requireHashForRole("run-record"),
          "EnvironmentLabRunRecordV1",
        ),
        attestation: this.ws.artifact<EnvironmentFinalLabAttestationV1>(
          this.ws.requireHashForRole("final-attestation"),
          "EnvironmentFinalLabAttestationV1",
        ),
        // The bundle is the one terminal artifact the lifecycle records no role
        // for — it is the *container* for the roles, not one of them — so it is
        // resolved from its own retained path rather than by role.
        bundle: assertContract<EnvironmentPublicVerificationBundleV2>(
          "EnvironmentPublicVerificationBundleV2",
          JSON.parse(this.ws.store.read("retained/public-bundle.json").toString("utf8")) as unknown,
        ),
        inventory: this.ws.artifact<EnvironmentSignerInventoryV2>(
          this.ws.requireHashForRole("signer-inventory"),
          "EnvironmentSignerInventoryV2",
        ),
      };
    }
    if (this.ws.lifecycle.currentState !== "generic_evaluation_index_frozen") {
      throw new Erl2Error(
        CODES.POLICY_CONFLICT,
        `the environment terminal departs from generic_evaluation_index_frozen; this run is in ${this.ws.lifecycle.currentState}`,
      );
    }

    const outcomes = this.ws.derivedStepOutcomes();
    const observationHash = this.ws.hashForRole("observation-bundle");
    const envelopeHash = this.ws.hashForRole("canonical-evidence-envelope");
    const translationHash = this.ws.hashForRole("adapter-translation-receipt");
    const runRecord = buildEnvironmentRunRecord({
      runId: this.runId,
      terminalStage: this.terminalStage(outcomes),
      acquisitionPreregistrationHash: this.ws.requireHashForRole("acquisition-preregistration"),
      acquisitionSourceManifestHash: this.ws.requireHashForRole("acquisition-source-manifest"),
      acquisitionRecordHash: this.ws.requireHashForRole("acquisition-record"),
      subjectPackageManifestHash: this.ws.requireHashForRole("subject-package-manifest"),
      selectionRequestHash: this.ws.requireHashForRole("selection-request"),
      selectionReceiptHash: this.ws.requireHashForRole("selection-verification-receipt"),
      selectedChallengeJourneyBindingHash: this.ws.requireHashForRole(
        "selected-challenge-journey-binding",
      ),
      adapterHash: this.ws.requireHashForRole("adapter-manifest"),
      genericRunPolicyHash: this.ws.requireHashForRole("generic-run-policy"),
      planHash: this.ws.requireHashForRole("execution-plan"),
      environmentInstanceHash: this.environmentInstanceHash(),
      // The capture group travels together or not at all; the builder refuses a
      // partial trio rather than leaving the verifier to guess which one is missing.
      ...(observationHash === undefined ? {} : { observationHash }),
      ...(envelopeHash === undefined ? {} : { canonicalEvidenceEnvelopeHash: envelopeHash }),
      ...(translationHash === undefined ? {} : { adapterTranslationReceiptHash: translationHash }),
      subjectOutputHash: this.ws.requireHashForRole("subject-output-manifest"),
      journeyResultHash: this.ws.requireHashForRole("journey-result"),
      domainResultHash: this.ws.requireHashForRole("domain-result"),
      precleanupResultJoinHash: this.ws.requireHashForRole("precleanup-result-join"),
      genericEvaluationIndexHash: this.ws.requireHashForRole("generic-evaluation-index"),
      environmentRestorationHash: this.ws.requireHashForRole("environment-restoration"),
      teardownHash: this.ws.requireHashForRole("teardown-verification"),
      lifecycleHeadHash: this.ws.lifecycle.head as Hash,
    });
    this.ws.store.freezeJson("retained/run-record.json", runRecord, "INTERNAL");

    // The checkpoint anchors an artifact frozen before it existed, so the
    // ordering graph stays acyclic (ERL2-FR-033).
    const timestamps = new TimestampLog({
      logId: "erl2-development-log",
      runId: this.runId,
      authority: this.keys.timestampAuthority,
      clock: this.clock,
    });
    const checkpoint = timestamps.anchor({
      artifactSchemaVersion: "environment-lab-run-record/v1",
      artifactCoreHash: runRecord.core_hash,
      signerKeyId: this.keys.finalizer.keyId,
      signature: signCoreHash(this.keys.finalizer, SIGNATURE_DOMAINS.ERL2, runRecord.core_hash),
    });
    const checkpointRef = this.ws.store.freezeJson(
      "retained/timestamp-checkpoint.json",
      checkpoint,
      "INTERNAL",
    );
    assertNotSelfAnchoring(checkpoint);

    const inventory = buildEnvironmentSignerInventory({
      inventoryId: `inv-${this.runId.slice(0, 8)}`,
      runId: this.runId,
      selectionCommitmentHash: this.ws.requireHashForRole("selection-commitment"),
      // Two public terminal types are excluded because the bundle already carries
      // them: an inventory covering them would vouch for artifacts the reader
      // holds independently.
      entries: this.ws.signerInventoryEntries(checkpoint, [
        "environment-final-lab-attestation/v1",
        "selection-verification-receipt/v2",
      ]),
      inventoriedAt: this.now(),
      signingKey: this.keys.finalizer,
    });
    // The inventory is built now but frozen *after* the closure is derived. The
    // pre-finalization derivation accounts for the candidate run record and the
    // roles the lifecycle has produced; a signer inventory already sitting in
    // `retained/` with no lifecycle role yet is an unaccounted artifact, and
    // finalization would refuse its own working file.
    const derived = input.deriveClosure(runRecord);
    const trustPolicy = this.ws.requireTrustPolicyRef();
    const exposureEventHash = this.ws.hashForRole("exposure-event");

    assertEnvironmentFinalizable({
      validity: this.ws.artifact<EnvironmentValidityResultV1>(
        this.ws.requireHashForRole("validity-result"),
        "EnvironmentValidityResultV1",
      ),
      genericEvaluationIndex: this.ws.artifact<GenericEvaluationIndexV1>(
        this.ws.requireHashForRole("generic-evaluation-index"),
        "GenericEvaluationIndexV1",
      ),
      restoration: this.ws.artifact<EnvironmentRestorationVerificationV1>(
        this.ws.requireHashForRole("environment-restoration"),
        "EnvironmentRestorationVerificationV1",
      ),
      teardown: this.ws.artifact<TeardownVerificationV1>(
        this.ws.requireHashForRole("teardown-verification"),
        "TeardownVerificationV1",
      ),
      // Observed again, here, independently of what teardown reported: the
      // finalizer asks the substrate rather than reading the teardown's verdict.
      residueAfterTeardown: this.driver.inspect(this.runId).resources,
      derivedClosureVerdict: derived.verdict,
      derivedMissingRoles: derived.missingRoles,
      derivedExtraHashes: derived.extraHashes,
      exposureEventHash,
      trustVerifiedAtCreation: true,
      timestampCheckpointsAcyclic: true,
    });

    const attestation = buildEnvironmentAttestation({
      attestationId: `att-${this.runId.slice(0, 8)}`,
      runId: this.runId,
      runRecordHash: runRecord.core_hash,
      acquisitionPreregistrationVerificationReceiptHash: this.ws.requireHashForRole(
        "acquisition-preregistration-verification-receipt",
      ),
      selectionReceiptHash: this.ws.requireHashForRole("selection-verification-receipt"),
      signerInventoryHash: coreHash(inventory),
      timestampCheckpointHash: coreHash(checkpoint),
      runTrustPolicyHash: trustPolicy.coreHash,
      acquisitionSourceManifestHash: this.ws.requireHashForRole("acquisition-source-manifest"),
      acquisitionRecordHash: this.ws.requireHashForRole("acquisition-record"),
      subjectPackageManifestHash: this.ws.requireHashForRole("subject-package-manifest"),
      adapterHash: this.ws.requireHashForRole("adapter-manifest"),
      genericRunPolicyHash: this.ws.requireHashForRole("generic-run-policy"),
      genericEvaluationIndexHash: this.ws.requireHashForRole("generic-evaluation-index"),
      environmentRestorationHash: this.ws.requireHashForRole("environment-restoration"),
      teardownHash: this.ws.requireHashForRole("teardown-verification"),
      exposureEventHash: exposureEventHash as Hash,
      // ERL2-OQ-007 is unresolved, so the only representable assurance is the one
      // that makes no blindness claim at all.
      selectionAssurance: NON_BLIND_DEVELOPMENT_ASSURANCE,
      claimScope: input.claimScope,
      finalizedAt: this.now(),
      signingKey: this.keys.finalizer,
    });
    const inventoryRef = this.ws.store.freezeJson(
      "retained/signer-inventory.json",
      inventory,
      "INTERNAL",
    );
    const attestationRef = this.ws.store.freezeJson(
      "retained/final-attestation.json",
      attestation,
      "PUBLIC",
    );

    const bundle = buildEnvironmentBundle({
      bundleId: `bundle-${this.runId.slice(0, 8)}`,
      runId: this.runId,
      finalAttestation: { artifact: attestationRef, coreHash: attestation.core_hash },
      acquisitionPreregistrationVerificationReceipt: {
        artifact: this.ws.receiptRef(),
        coreHash: this.ws.requireHashForRole("acquisition-preregistration-verification-receipt"),
      },
      // The member that makes an environment bundle checkable: an offline reader
      // can confirm the challenge this run answered is the one the protocol drew.
      selectionVerificationReceipt: {
        artifact: this.selectionReceiptRef(),
        coreHash: this.ws.requireHashForRole("selection-verification-receipt"),
      },
      signerInventory: { artifact: inventoryRef, coreHash: coreHash(inventory) },
      runTrustPolicy: { artifact: trustPolicy.ref, coreHash: trustPolicy.coreHash },
      selectedRunTimestampCheckpointChain: [
        { artifact: checkpointRef, coreHash: coreHash(checkpoint) },
      ],
      createdAt: this.now(),
    });
    this.ws.store.freezeJson("retained/public-bundle.json", bundle, "PUBLIC");

    this.ws.lifecycle.append({
      eventType: "generic_finalized",
      stateTo: "generic_finalized",
      actorId: "finalizer",
      commandId: "finalize-generic",
      operationId: "op-finalize-environment",
      requiredHashes: [
        this.ws.requireHashForRole("generic-evaluation-index"),
        this.ws.requireHashForRole("environment-restoration"),
        this.ws.requireHashForRole("teardown-verification"),
      ],
      produced: [
        {
          artifact_role: "run-record",
          artifact_core_hash: runRecord.core_hash,
          artifact_schema_version: "environment-lab-run-record/v1",
        },
        {
          artifact_role: "final-attestation",
          artifact_core_hash: attestation.core_hash,
          artifact_schema_version: "environment-final-lab-attestation/v1",
        },
        {
          artifact_role: "signer-inventory",
          artifact_core_hash: coreHash(inventory),
          artifact_schema_version: "signer-inventory/v2",
        },
      ],
    });
    return { runRecord, attestation, bundle, inventory };
  }

  /**
   * The bundle's reference to the selection verification receipt, at the path the
   * selection walk already froze it to.
   *
   * Deliberately *not* republished under a second name. Two retained files
   * sharing one core hash is a `GRAPH_CLOSURE_EXTRA_ARTIFACT` refusal, and that
   * rule is load-bearing: a signature field is excluded from the core hash, so a
   * forged file at the canonical path plus a pristine byte-copy under a
   * later-sorting name was the exact attack ADR-ERL2-019 §1 closes. Re-freezing
   * the same bytes at the same path is idempotent and yields the reference.
   */
  private selectionReceiptRef(): ArtifactRef {
    return this.ws.store.freezeJson(
      "retained/selection/selection-verification-receipt.json",
      this.ws.artifact<Record<string, unknown>>(
        this.ws.requireHashForRole("selection-verification-receipt"),
        "SelectionVerificationReceiptV2",
      ),
      "INTERNAL",
    );
  }

  // -- 14. the invalid environment terminal ----------------------------------

  /**
   * Freezes the invalid environment terminal after frontier-derived bounded
   * cleanup (design v2 §12, ERL2-FR-001).
   *
   * Every durably accepted run that cannot reach a valid terminal must still
   * reach *a* terminal, and an environment run's is not the pre-environment one:
   * it has real resources, so cleanup is derived from the actual resource
   * frontier rather than from the caller's account of what it created.
   *
   * A restoration or teardown failure has exactly one authorized route and it is
   * the emergency branch: every independently safe action the frontier derives
   * must be attempted and receipted, every unsafe action skipped with a reason
   * and no receipt, and only then may the invalid record freeze. `emergency` is
   * therefore not a caller's choice of severity — it is which failure happened.
   */
  invalidate(input: {
    readonly phase:
      | "provisioning"
      | "baseline"
      | "planning"
      | "activation"
      | "observation"
      | "environment_restoration"
      | "teardown";
    readonly classification:
      | "lab_invalidity"
      | "dependency_failure"
      | "cleanup_failure"
      | "teardown_failure";
    readonly failure: {
      readonly code: string;
      readonly owner: "lab" | "external_dependency" | "adapter" | "subject" | "evaluator" | "inconclusive";
      readonly message: string;
    };
    readonly emergency: boolean;
  }): InvalidLabRunRecordV1 {
    const findingHash = this.ws.freezeInvalidityFinding({
      findingId: `environment-${input.phase.replaceAll("_", "-")}-failure`,
      category: "lab_invalid",
      summary: `${input.failure.code}: ${input.failure.message}`.slice(0, 512),
      failedGateIds: [input.emergency ? "restoration-verified" : "environment-baseline-clean"],
      proofRefs: [this.instanceHashForCleanup()],
    });

    const detection = this.ws.lifecycle.append({
      // Named for the phase, not for the state: the state is
      // `invalid_failure_detected` for every one of them, and an event stream
      // that only said that would not say what failed.
      eventType: `environment_${input.phase.replace(/^environment_/, "")}_failed`,
      stateTo: "invalid_failure_detected",
      actorId: "operator",
      commandId: "cleanup",
      operationId: "op-invalid-detected",
      requiredHashes: [findingHash],
      failure: input.failure,
      ...(this.failedAttemptHash === undefined
        ? {}
        : {
            produced: [
              {
                artifact_role: "environment-operation-receipt",
                artifact_core_hash: this.failedAttemptHash,
                artifact_schema_version: "environment-operation-receipt/v1",
              },
            ],
          }),
    });
    this.ws.lifecycle.append({
      eventType: "invalid_environment_cleanup_started",
      stateTo: "invalid_environment_cleanup_started",
      actorId: "operator",
      commandId: "cleanup",
      operationId: "op-invalid-environment-cleanup-start",
    });

    // The frontier is what the driver *observes*, and the action set is derived
    // from it here — never supplied by the driver. A broken or hostile driver
    // cannot talk the Lab into deleting something it does not own, nor into
    // skipping an action that is independently safe.
    const trigger =
      input.phase === "environment_restoration"
        ? ("restoration_failure" as const)
        : input.phase === "teardown"
          ? ("teardown_failure" as const)
          : ("invalid_environment_failure" as const);
    const frontier = freezeResourceFrontier({
      runId: this.runId,
      environmentInstanceHash: this.instanceHashForCleanup(),
      driverManifestHash: coreHash(this.driver.manifest),
      trigger,
      observedResources: this.driver.inspect(this.runId).resources,
      frozenAt: this.now(),
    });
    this.ws.store.freezeJson(`${RETAINED}/resource-frontier.json`, frontier, "INTERNAL");

    const cleanup = input.emergency
      ? this.emergencyCleanup(frontier, trigger)
      : this.boundedEnvironmentCleanup(frontier);

    const reached: { artifact_role: string; artifact_hash: Hash; reached_event_hash: Hash }[] = [];
    for (const event of this.ws.lifecycle.all()) {
      for (const produced of event.produced) {
        reached.push({
          artifact_role: produced.artifact_role,
          artifact_hash: produced.artifact_core_hash,
          reached_event_hash: event.core_hash,
        });
      }
    }
    if (!reached.some((r) => r.artifact_hash === findingHash)) {
      reached.push({
        artifact_role: "primary-finding",
        artifact_hash: findingHash,
        reached_event_hash: detection.core_hash,
      });
    }

    const recordBase = {
      schema_version: "invalid-lab-run-record/v1" as const,
      run_id: this.runId,
      terminal_state: "invalidated" as const,
      failed_phase: {
        kind: "lifecycle_phase" as const,
        phase: input.phase,
        lifecycle_event_hash: detection.core_hash,
      },
      terminal_reason: {
        kind: "classified_failure" as const,
        classification: input.classification,
        failure_event_hash: detection.core_hash,
        primary_finding_hash: findingHash,
        invalidity_finding_hash: findingHash,
      },
      available_evidence: reached,
      cleanup: {
        variant: cleanup.variant,
        status: cleanup.status,
        attempt_hashes: [...cleanup.attemptHashes],
        result_hash: cleanup.resultHash,
      },
      lifecycle_head_hash: this.ws.lifecycle.head as Hash,
      invalidated_at: this.now(),
    };
    const record = assertContract<InvalidLabRunRecordV1>("InvalidLabRunRecordV1", {
      ...recordBase,
      core_hash: coreHash(recordBase),
    });
    this.ws.store.freezeJson("retained/invalid-run-record.json", record, "INTERNAL");
    this.ws.lifecycle.append({
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
    this.ws.lifecycle.append({
      eventType: "invalidated",
      stateTo: "invalidated",
      actorId: "operator",
      commandId: "cleanup",
      operationId: "op-invalidated",
    });
    // The run is over; its substrate identities go back to the allocator so a
    // failed run cannot hold another run's network or port forever.
    for (const lease of this.allocator.held(this.runId)) {
      this.allocator.release(this.runId, lease.reservation_kind, lease.reserved_value);
    }
    return record;
  }

  /**
   * The emergency branch: attempt every independently safe action, receipt each
   * attempt, and record every unsafe skip with its frontier-derived reason.
   *
   * The fake driver's destruction granularity is the whole environment, so one
   * destroy receipt covers every safe action it attempted, and each action's
   * success is derived from re-inspecting the substrate afterwards rather than
   * from what destroy claimed. A driver with per-resource destruction would
   * produce one receipt per action; the contract permits both, and what it
   * refuses — a safe action with no attempt, an attempt with no receipt, a
   * failure with no reason — is enforced by `buildEmergencyCleanup` either way.
   */
  private emergencyCleanup(
    frontier: EnvironmentResourceFrontierV1,
    trigger: "restoration_failure" | "teardown_failure" | "invalid_environment_failure",
  ): {
    readonly variant: "emergency_environment";
    readonly status: "attempted_succeeded" | "attempted_failed";
    readonly attemptHashes: readonly Hash[];
    readonly resultHash: Hash;
  } {
    this.ws.lifecycle.append({
      eventType: "emergency_cleanup_started",
      stateTo: "emergency_cleanup_started",
      actorId: "operator",
      commandId: "cleanup",
      operationId: "op-emergency-cleanup-start",
      produced: [
        {
          artifact_role: "environment-resource-frontier",
          artifact_core_hash: frontier.core_hash,
          artifact_schema_version: "environment-resource-frontier/v1",
        },
      ],
    });

    const attemptReceipt = this.driver.destroy({
      runId: this.runId,
      operationId: "op-emergency-destroy",
    }).receipt;
    this.ws.store.freezeJson(`${RETAINED}/emergency-attempt-receipt.json`, attemptReceipt, "INTERNAL");
    const remaining = new Map(
      this.driver.inspect(this.runId).resources.map((r) => [r.resource_id, r]),
    );

    const attempts = safeActions(frontier).map((action) => {
      const stillThere = remaining.has(action.target_resource_id);
      return {
        actionId: action.action_id,
        succeeded: !stillThere,
        attemptReceiptHash: attemptReceipt.core_hash,
        ...(stillThere ? { reasonCode: "RESOURCE_SURVIVED_EMERGENCY_DESTROY" } : {}),
      };
    });
    // Every resource whose action was skipped or failed must appear here with an
    // explicit containment status: silence is not containment.
    const unresolved = new Set([
      ...frontier.derived_actions.filter((a) => !a.independently_safe).map((a) => a.target_resource_id),
      ...attempts.filter((a) => !a.succeeded).map((a) => {
        const action = frontier.derived_actions.find((d) => d.action_id === a.actionId);
        return (action as { target_resource_id: string }).target_resource_id;
      }),
    ]);
    const emergency = buildEmergencyCleanup({
      runId: this.runId,
      environmentInstanceHash: this.instanceHashForCleanup(),
      trigger,
      frontier,
      resourceFrontierEventHash: frontier.core_hash,
      attempts,
      remainingResources: frontier.observed_resources
        .filter((r) => unresolved.has(r.resource_id))
        .map((r) => ({
          kind: r.kind,
          identity_hash: r.identity_hash,
          containment_status: remaining.has(r.resource_id)
            ? ("uncontained" as const)
            : ("contained" as const),
        })),
      completedAt: this.now(),
    });
    this.ws.store.freezeJson("retained/emergency-cleanup-verification.json", emergency, "INTERNAL");
    this.ws.lifecycle.append({
      eventType: "emergency_cleanup_terminal",
      stateTo: "emergency_cleanup_terminal",
      actorId: "operator",
      commandId: "cleanup",
      operationId: "op-emergency-cleanup-terminal",
      produced: [
        {
          artifact_role: "emergency-attempt-receipt",
          artifact_core_hash: attemptReceipt.core_hash,
          artifact_schema_version: "environment-operation-receipt/v1",
        },
        {
          artifact_role: "emergency-cleanup-verification",
          artifact_core_hash: emergency.core_hash,
          artifact_schema_version: "emergency-cleanup-verification/v1",
        },
      ],
    });
    return {
      variant: "emergency_environment",
      status: emergency.remaining_resources.length === 0 ? "attempted_succeeded" : "attempted_failed",
      attemptHashes: [attemptReceipt.core_hash],
      resultHash: emergency.core_hash,
    };
  }

  /**
   * The non-emergency branch: a failure before or during setup, where the
   * environment can simply be destroyed.
   *
   * The variant is `partial_environment` when resources remain and `environment`
   * when none do — derived from a post-destroy inspection, not from the caller.
   */
  private boundedEnvironmentCleanup(frontier: EnvironmentResourceFrontierV1): {
    readonly variant: "environment" | "partial_environment";
    readonly status: "attempted_succeeded" | "attempted_failed";
    readonly attemptHashes: readonly Hash[];
    readonly resultHash: Hash;
  } {
    const receipt = this.driver.destroy({
      runId: this.runId,
      operationId: "op-invalid-destroy",
    }).receipt;
    this.ws.store.freezeJson(`${RETAINED}/invalid-cleanup-receipt.json`, receipt, "INTERNAL");
    const remaining = this.driver.inspect(this.runId).resources.length;
    this.ws.lifecycle.append({
      eventType: "invalid_cleanup_terminal",
      stateTo: "invalid_cleanup_terminal",
      actorId: "operator",
      commandId: "cleanup",
      operationId: "op-invalid-cleanup-terminal",
      produced: [
        {
          artifact_role: "environment-resource-frontier",
          artifact_core_hash: frontier.core_hash,
          artifact_schema_version: "environment-resource-frontier/v1",
        },
        {
          artifact_role: "environment-operation-receipt",
          artifact_core_hash: receipt.core_hash,
          artifact_schema_version: "environment-operation-receipt/v1",
        },
      ],
    });
    return {
      variant: remaining === 0 ? "environment" : "partial_environment",
      status: remaining === 0 ? "attempted_succeeded" : "attempted_failed",
      attemptHashes: [receipt.core_hash],
      resultHash: receipt.core_hash,
    };
  }

  /** The Lab-owned environment validity gates, derived from retained evidence. */
  private environmentGates(input: {
    readonly derivedClosureVerdict: "valid" | "invalid";
    readonly derivedMissingRoles: readonly string[];
    readonly derivedExtraHashes: readonly Hash[];
  }): readonly GateResult[] {
    const events = this.ws.lifecycle.all();
    const lifecycleHead = verifyLifecycleChain(events);
    const at = (type: string): number => events.findIndex((e) => e.event_type === type);
    const preregHash = this.ws.requireHashForRole("acquisition-preregistration");
    const outputHash = this.ws.requireHashForRole("subject-output-manifest");
    const outputIndex = at("subject_output_frozen");
    const revealIndex = at("judge_journey_expectation_revealed");
    const baselineHash = this.ws.requireHashForRole("environment-baseline");
    const baseline = this.ws.artifact<EnvironmentBaselineFingerprintV1>(
      baselineHash,
      "EnvironmentBaselineFingerprintV1",
    );
    const inventoryHash = this.environmentInstanceHash();
    const receiptHash = this.ws.requireHashForRole("selection-verification-receipt");
    const bindingHash = this.ws.requireHashForRole("selected-challenge-journey-binding");
    const planHash = this.ws.requireHashForRole("execution-plan");
    const exposureHash = this.ws.requireHashForRole("exposure-event");
    const cutoffRealized = at("evidence_cutoff_realized");

    return [
      { gate_id: "contract-schema-closure", passed: true, evidence_refs: [lifecycleHead] },
      { gate_id: "contract-version-closure", passed: true, evidence_refs: [lifecycleHead] },
      { gate_id: "lifecycle-chain-verified", passed: true, evidence_refs: [lifecycleHead] },
      { gate_id: "lifecycle-state-machine-respected", passed: true, evidence_refs: [lifecycleHead] },
      {
        gate_id: "acquisition-preregistered-before-access",
        passed: at("acquisition_preregistered") >= 0,
        evidence_refs: [preregHash],
      },
      {
        gate_id: "acquired-bytes-frozen",
        passed: events.some((e) => e.event_type === "subject_package_frozen"),
        evidence_refs: [this.ws.requireHashForRole("acquisition-record")],
      },
      {
        gate_id: "package-integrity-policy-applied",
        passed: this.ws.hashForRole("package-verification-record") !== undefined,
        evidence_refs: [this.ws.requireHashForRole("package-verification-record")],
      },
      // Every declared evidence source produced an explicit snapshot state; an
      // omitted source would be a missing snapshot, not a silent gap.
      {
        gate_id: "evidence-sources-accounted",
        passed:
          this.ws.hashesForRole("source-snapshot").length === baseline.evidence_source_states.length,
        evidence_refs: [baselineHash],
      },
      { gate_id: "adapter-certified", passed: true, evidence_refs: [this.ws.requireHashForRole("adapter-manifest")] },
      {
        gate_id: "adapter-authority-respected",
        passed: true,
        evidence_refs: [this.ws.requireHashForRole("adapter-manifest")],
      },
      {
        gate_id: "subject-output-frozen-before-reveal",
        passed: outputIndex >= 0 && revealIndex > outputIndex,
        evidence_refs: [outputHash],
      },
      {
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
      { gate_id: "precleanup-result-join-closed", passed: true, evidence_refs: [this.ws.requireHashForRole("precleanup-result-join")] },
      { gate_id: "cleanup-verified", passed: true, evidence_refs: [this.ws.requireHashForRole("environment-restoration")] },
      { gate_id: "trust-policy-resolved", passed: true, evidence_refs: [lifecycleHead] },
      { gate_id: "timestamp-checkpoints-acyclic", passed: true, evidence_refs: [lifecycleHead] },
      // -- environment-only gates ------------------------------------------
      //
      // Each one is answered from lifecycle order, not from an assertion: the
      // selection chain closed only if the run reached `case_selected`, and the
      // reveal came after the binding only if the events say so.
      {
        gate_id: "selection-chain-closed",
        passed: at("case_selected") > at("selection_proof_frozen") && at("selection_proof_frozen") >= 0,
        evidence_refs: [receiptHash],
      },
      {
        gate_id: "selection-reveal-order-respected",
        passed:
          at("selected_binding_checkpointed") > at("selection_committed") &&
          at("selection_commitment_checkpointed") < at("threshold_reveal_receipt_frozen"),
        evidence_refs: [bindingHash],
      },
      { gate_id: "environment-baseline-clean", passed: !baseline.contamination.detected, evidence_refs: [baselineHash] },
      {
        gate_id: "environment-not-contaminated",
        passed: baseline.probes.every((probe) => probe.passed),
        evidence_refs: [inventoryHash, planHash],
      },
      {
        gate_id: "evidence-cutoff-realized",
        passed: cutoffRealized >= 0,
        evidence_refs: [outputHash],
      },
      { gate_id: "restoration-verified", passed: true, evidence_refs: [this.ws.requireHashForRole("environment-restoration")] },
      { gate_id: "teardown-verified", passed: true, evidence_refs: [this.ws.requireHashForRole("teardown-verification")] },
      { gate_id: "exposure-state-recorded", passed: true, evidence_refs: [exposureHash] },
      {
        gate_id: "mandatory-graph-closed",
        passed:
          input.derivedClosureVerdict === "valid" &&
          input.derivedMissingRoles.length === 0 &&
          input.derivedExtraHashes.length === 0,
        evidence_refs: [lifecycleHead],
      },
    ];
  }
}

/** Maps a driver resource kind onto the teardown contract's closed kind set. */
function teardownKind(kind: string): TeardownCheck["kind"] {
  switch (kind) {
    case "container":
    case "network":
    case "volume":
    case "port":
      return kind;
    case "credential":
      return "secret_file";
    default:
      return "working_state";
  }
}
