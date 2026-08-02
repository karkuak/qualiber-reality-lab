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
  type CancellationRequestV1,
  type ChallengeActivationReceiptV1,
  type ChallengeManifestV1,
  type ComparisonPolicyV1,
  type CutoffPolicyV1,
  type DomainResultNotApplicableV1,
  type EnvironmentArchetypeV1,
  type EnvironmentBaselineFingerprintV1,
  type EnvironmentJourneyIntent,
  type InvalidNonJourneyPhase,
  type EnvironmentOperationReceiptV1,
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
  type EvidenceWindowCommitmentV1,
  type MonotonicClockDomainV1,
  type ObservationBundleV2,
  type LiveCanonicalEvidenceEnvelopeV1,
  type RuntimeMilestoneV1,
  type SelectedChallengeJourneyBindingV1,
  type SelectedJourneyResultV1,
  type SelectionAssuranceV1,
  type SourceSnapshotV1,
  type SubjectExecutionPlanV1,
  type SubjectVisibleJourneyStepV1,
  type SubstrateBindingV1,
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
import { TERMINAL_STATES, assertSubjectPortExecutable } from "../lifecycle/states.js";
import { assertBaselineClean, assertRepeatableBaseline } from "../environment/cleanControl.js";
import {
  assertDriverEnabled,
  assertOperationSupported,
  type DestroyResult,
  type EnvironmentDriver,
  type ProvisionResult,
} from "../environment/driver.js";
import { ReservationAllocator, type ReservationKind } from "../environment/allocator.js";
import {
  assertSubstrateBinding,
  buildSubstrateBinding,
  reservationNamespaceHash,
} from "../environment/substrateBinding.js";
import {
  buildRestorationProbe,
  restorationProbePassed,
  type ExpectedRevertedMutation,
} from "../environment/restorationProbe.js";
import { freezeResourceFrontier } from "../environment/frontier.js";
import { buildEnvironmentRestoration, buildTeardownVerification, type TeardownCheck } from "../cleanup/cleanup.js";
import {
  assertTelemetryOracleClean,
  realizeCutoff,
  freezeSourceSnapshot,
  freezeObservation,
  type RealizedCutoff,
} from "../capture/capture.js";
import { assertMilestoneOnCommittedBoundary, sealWindowCommitment } from "../capture/evidenceWindow.js";
import { assertComparisonModeAdmissible, assertTranslationTotality, buildLiveEnvelope } from "../capture/envelope.js";
import { buildSelectedJourneyResult } from "../evaluation/journey.js";
import { buildDomainNotApplicable, missingDomainAncestors } from "../evaluation/domain.js";
import { buildGenericEvaluationIndex, buildPrecleanupResultJoin, deriveJoinOrdering } from "../evaluation/join.js";
import { buildEnvironmentValidity, type GateResult } from "../evaluation/validity.js";
import {
  JOURNEY_EXECUTION_GATE,
  gateForEnvironmentFailurePhase,
} from "../evaluation/invalidityAttribution.js";
import { JOURNEY_PLANE_METRICS } from "../evaluation/genericMetrics.js";
import { verifyLifecycleChain } from "../lifecycle/log.js";
import { assertNoCanaryLeak } from "../journey/oracle.js";
import {
  assertSubjectOutputContentClean,
  assertSubjectOutputWithinDeclaredBytes,
} from "../adapter/outputFreezer.js";
import {
  CANONICAL_JOURNEY_INTENTS,
  JOURNEY_PREREQUISITES,
  assertJourneyPrerequisites,
  isPostCaptureIntent,
} from "../journey/prerequisites.js";
import { NO_CRASH, type CrashBarrier } from "./crashBarrier.js";
import { MutationIntentJournal, type ProbeVerdict } from "./mutationIntent.js";
import {
  executeFrontierDerivedCleanup,
  type CleanupTrigger,
  type FrontierCleanupOutcome,
} from "./environmentCleanup.js";
import { EVALUATOR_RELEASE, type RunWorkspace } from "./workspace.js";

/** The signing roles the environment branch needs, each a distinct operator. */
export interface EnvironmentKeyring {
  /**
   * Signs the run's substrate binding (ADR-ERL2-024 §6.4).
   *
   * The governor is the authority that provisions the environment, so recording
   * *which* substrate it provisioned into is part of that act. Not the
   * `controller` — that role decides a challenge goes live (ADR-ERL2-023) — and
   * never the driver, which is untrusted infrastructure.
   */
  readonly environmentGovernor: SigningKey;
  /** Signs the challenge-activation controller evidence. */
  readonly controller: SigningKey;
  /** Signs the traffic process start receipt. */
  readonly trafficSupervisor: SigningKey;
  /** Signs the runtime milestone the cutoff is derived from. */
  readonly runtimeAttestor: SigningKey;
  /**
   * Signs the run's evidence-window commitment (ADR-ERL2-031 §4).
   *
   * The authority that bounds the window in `cutoff-policy/v1` is the one that
   * commits the exact window inside those bounds — the same statement, one notch
   * more specific. Deliberately **not** `trafficSupervisor` or `runtimeAttestor`:
   * the party that chooses the window must not also stamp the clocks the
   * derivation is anchored on, or "wall, monotonic, supervisor and
   * runtime-attestor bounds agree" collapses into one operator's own bookkeeping.
   */
  readonly policyAuthor: SigningKey;
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
  /**
   * Where a crash may be injected, for the crash matrix (ADR-ERL2-028 §7).
   *
   * Absent in production and on the release surface; the CLI installs one only
   * under the explicit development profile.
   */
  readonly barrier?: CrashBarrier;
}

const RETAINED = "retained/environment";

/**
 * How a driver names the undo of a mutation it applied.
 *
 * The only place the Lab's mutation vocabulary and the driver's compensation
 * vocabulary meet: `EnvironmentOperationReceiptV1.compensation_id` is where a
 * driver says "the way to undo this is …", and the restoration probe needs the
 * mutation id back out of it to ask whether it is still applied.
 */
const COMPENSATION_PREFIX = "compensate-";

/** Resource kinds the global allocator holds a reservation lease for (§22). */
const RESERVATION_KINDS: ReadonlySet<string> = new Set<ReservationKind>([
  "network",
  "volume",
  "port",
  "tenant",
  "project",
]);

/**
 * The evidence window this development profile **configures**.
 *
 * These were constants of the composition — retained in no contract, so no
 * offline reader could recompute the cutoff scalar and the derivation was
 * bounds-exact rather than exact (ADR-ERL2-029 §3.2). They are now inputs to one
 * thing only: the signed `evidence-window-commitment/v1` the run freezes before
 * it observes the runtime milestone. Every later phase reads the frozen
 * commitment, so a producer that edits these values after the freeze changes
 * bytes a reader can see (ADR-ERL2-031 §1.1).
 *
 * Whole seconds, because `erl2:common#/$defs/Instant` is second-precision and the
 * renderer truncates rather than rounds; `sealWindowCommitment` refuses anything
 * else before it signs (ADR-ERL2-031 §3.2).
 */
const CONFIGURED_WARMUP_MS = 1_000;
const CONFIGURED_OBSERVATION_MS = 5_000;

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

/**
 * The intents that may run before the challenge is activated.
 *
 * Derived from the prerequisite matrix rather than restated, so the two can
 * never disagree: an intent is a setup intent exactly when it does not owe the
 * evidence cutoff (ADR-ERL2-028 §2).
 */
const SETUP_INTENTS: ReadonlySet<JourneyIntent> = new Set<JourneyIntent>(
  CANONICAL_JOURNEY_INTENTS.filter(
    (intent) =>
      JOURNEY_PREREQUISITES[intent].branch === "environment" && !isPostCaptureIntent(intent),
  ),
);

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
   * Durable intent before every external dispatch, and reconciliation before any
   * retry (ADR-ERL2-024 §4.3). Run-private state, not evidence: it records that
   * a call is about to be made, which is never a result.
   */
  private readonly intents: MutationIntentJournal;
  /**
   * Where a crash may be injected, for the four boundaries this class owns.
   *
   * The other four belong to the intent journal, which receives the same
   * barrier: the eight named boundaries of ADR-ERL2-028 §7 straddle both.
   */
  private readonly barrier: CrashBarrier;
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
    this.barrier = options.barrier ?? NO_CRASH;
    this.intents = new MutationIntentJournal({
      runRoot: options.workspace.store.root,
      runId: options.workspace.runId,
      barrier: this.barrier,
    });
  }

  /**
   * Runs one driver operation under a durable intent.
   *
   * The probe and the adopt path both come from the driver's own operation log:
   * a completed operation id *is* the independently observable evidence that the
   * external call already happened, and its stored receipt is the result to
   * adopt. A driver with no log cannot answer, so its unsettled operations fail
   * closed — which is the honest outcome, not a gap to paper over with an
   * assumption of idempotence.
   */
  private driverOperation<T = EnvironmentOperationReceiptV1>(spec: {
    readonly operationId: string;
    readonly kind: string;
    readonly targetIdentity: string;
    readonly requestHash: Hash;
    readonly compensation: string;
    /**
     * For a compensation, what it is expected to reverse and what must hold
     * afterwards (ADR-ERL2-026 §4.2).
     *
     * `requestHash` already covers the mutation set, but only as an opaque
     * digest: a crashed run's journal could say a compensation was in flight
     * without saying what it was undoing, which is the information a
     * reconciliation actually needs.
     */
    readonly expectedRevertedMutations?: readonly string[];
    readonly expectedTargets?: readonly Hash[];
    readonly expectedPostCondition?: string;
    readonly probeId?: string;
    readonly dispatch: () => T;
    /**
     * Rebuilds the result from the driver's own operation log. Defaults to the
     * stored receipt, which is the result for every operation whose value *is*
     * a receipt; `provision` supplies its own because its result also carries an
     * inventory, which is an observation the driver can re-derive.
     */
    readonly adopt?: (completed: EnvironmentOperationReceiptV1) => T;
  }): T {
    const completed = (): EnvironmentOperationReceiptV1 | undefined =>
      this.driver.completedOperation?.(this.runId, spec.operationId);
    return this.intents.run<T>(
      {
        operationId: spec.operationId,
        kind: spec.kind,
        targetIdentity: spec.targetIdentity,
        requestHash: spec.requestHash,
        idempotencyKey: domainHash(HASH_DOMAINS.DRIVER_STATE, {
          run_id: this.runId,
          operation_id: spec.operationId,
        }),
        preconditionHash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
          resources: this.driver.inspect(this.runId).resources.map((r) => r.identity_hash),
        }),
        ...(this.ws.hashForRole("substrate-binding") === undefined
          ? {}
          : { substrateBindingHash: this.ws.requireHashForRole("substrate-binding") }),
        ...(spec.expectedRevertedMutations === undefined
          ? {}
          : { expectedRevertedMutations: spec.expectedRevertedMutations }),
        ...(spec.expectedTargets === undefined ? {} : { expectedTargets: spec.expectedTargets }),
        ...(spec.expectedPostCondition === undefined
          ? {}
          : { expectedPostCondition: spec.expectedPostCondition }),
        probeId: spec.probeId ?? "driver.completedOperation",
        retry: "idempotent_by_key",
        compensation: spec.compensation,
        probe: (): ProbeVerdict =>
          this.driver.completedOperation === undefined
            ? "unknown"
            : completed() === undefined
              ? "absent"
              : "present",
        adopt: (): T => {
          const receipt = completed() as EnvironmentOperationReceiptV1;
          return spec.adopt === undefined ? (receipt as T) : spec.adopt(receipt);
        },
        dispatch: spec.dispatch,
      },
      this.now(),
    );
  }

  /**
   * Refuses a compensation receipt that is not this compensation's
   * (ADR-ERL2-026 §4.3).
   *
   * Four ways a receipt can be about something else, and each of them is a way
   * for a genuine past success to be replayed over a compensation that never
   * happened: it belongs to another run, it settles another operation, it was
   * issued against another driver manifest, or it is not a compensation at all.
   * The receipt is retained, hash-linked and role-produced, so none of these is
   * caught by any hash check.
   */
  private assertCompensationReceiptBound(
    receipt: EnvironmentOperationReceiptV1,
    operationId: string,
  ): void {
    const binding = this.substrateBinding();
    const wrong =
      receipt.run_id !== this.runId
        ? `belongs to run ${receipt.run_id}`
        : receipt.operation_id !== operationId
          ? `settles operation ${receipt.operation_id}, not ${operationId}`
          : receipt.operation !== "restore"
            ? `records a ${receipt.operation}, which is not a compensation`
            : binding !== undefined && receipt.driver_manifest_hash !== binding.driver_manifest_hash
              ? "was issued against a driver manifest this run never bound"
              : undefined;
    if (wrong !== undefined) {
      throw new Erl2Error(
        CODES.RESTORATION_PROBE_MISSING,
        `the compensation receipt for ${operationId} ${wrong}`,
        { owner: "lab" },
      );
    }
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

  // -- 0. the substrate binding ----------------------------------------------

  /** The run's retained substrate binding, if the lifecycle has recorded one. */
  substrateBinding(): SubstrateBindingV1 | undefined {
    const hash = this.ws.hashForRole("substrate-binding");
    if (hash === undefined) return undefined;
    return this.ws.artifact<SubstrateBindingV1>(hash, "SubstrateBindingV1");
  }

  /**
   * The binding as it exists on disk, whether or not the lifecycle has reached
   * the event that records it.
   *
   * `provision` freezes the binding *before* it dispatches, so a partial
   * provision or a reservation conflict raises before the
   * `environment_provisioned` event exists. The invalid terminal must still be
   * able to see the binding — both to check it before enumerating a frontier,
   * and to account for the retained byte, which the closure would otherwise
   * reject as an unreachable artifact.
   */
  private retainedSubstrateBinding(): SubstrateBindingV1 | undefined {
    const roled = this.substrateBinding();
    if (roled !== undefined) return roled;
    let bytes: Buffer;
    try {
      bytes = this.ws.store.read(`${RETAINED}/substrate-binding.json`);
    } catch {
      return undefined;
    }
    return assertContract<SubstrateBindingV1>(
      "SubstrateBindingV1",
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
  }

  /** True once this run has external resources, or may have: the environment branch. */
  hasSubstrate(): boolean {
    return this.ws.hashForRole("substrate-binding") !== undefined;
  }

  /**
   * The selection assurance this run's terminal will carry.
   *
   * Exposed so the claim-scope derivation reads the *same* value the finalizer
   * will sign rather than a second copy of it: a ceiling derived from one
   * assurance and an attestation signed with another would be two answers to one
   * question. ERL2-OQ-007 is unresolved, so the only representable value is the
   * one that makes no blindness claim at all.
   */
  selectionAssurance(): SelectionAssuranceV1 {
    return NON_BLIND_DEVELOPMENT_ASSURANCE;
  }

  /**
   * Refuses a phase whose substrate is not the one this run bound
   * (ADR-ERL2-024 §4.2), **before** any dispatch and before any freeze.
   *
   * Every environment phase that will reach the driver calls this. A phase that
   * skipped it could be pointed at a fresh empty substrate and would record a
   * clean observation of an environment it never looked at — the P0-1 exploit.
   */
  private assertBoundSubstrate(options: { readonly expectProvisioned: boolean }): void {
    const binding = this.substrateBinding();
    if (binding === undefined) {
      throw new Erl2Error(
        CODES.ENV_SUBSTRATE_BINDING_MISSING,
        "this run has not bound a substrate; an environment phase cannot dispatch to a substrate the run never claimed",
        { owner: "lab" },
      );
    }
    assertSubstrateBinding({
      binding,
      runId: this.runId,
      driver: this.driver,
      archetypeHash: coreHash(this.archetype),
      reservationNamespaceHash: reservationNamespaceHash(this.allocator.namespaceLocator),
      expectProvisioned: options.expectProvisioned,
    });
  }

  /**
   * Whether the run's own lifecycle still says resources should exist.
   *
   * True from `environment_provisioned` until the teardown that removed them is
   * verified. Used as `expectProvisioned`, so an emptied or substituted
   * substrate is caught while the run still believes it has an environment, and
   * a legitimately torn-down run is not.
   */
  private lifecycleExpectsResources(): boolean {
    if (this.ws.hashForRole("environment-resource-inventory") === undefined) return false;
    return this.ws.hashForRole("teardown-verification") === undefined;
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
    // The substrate identity is established and bound BEFORE the first
    // substrate-affecting dispatch (ADR-ERL2-024 §4.2). Establishing it after
    // provisioning would leave a window in which a crash produced real
    // resources that no binding names — and a run whose environment exists but
    // whose substrate is unnamed is exactly the state P0-1 exploits.
    const substrate = this.driver.establishSubstrateInstance(this.runId);
    const binding = buildSubstrateBinding({
      runId: this.runId,
      driverManifest: this.driver.manifest,
      archetypeHash: coreHash(this.archetype),
      substrateKind: substrate.kind,
      substrateInstanceHash: substrate.instanceHash,
      reservationNamespaceHash: reservationNamespaceHash(this.allocator.namespaceLocator),
      boundAt: this.now(),
      signingKey: this.keys.environmentGovernor,
    });
    this.ws.store.freezeJson(`${RETAINED}/substrate-binding.json`, binding, "INTERNAL");

    // Every reservation is taken before the driver is asked to create anything.
    const leases = kinds.map((kind) =>
      this.allocator.acquire({
        runId: this.runId,
        kind: kind as ReservationKind,
        value: `erl2-${kind}-${this.runId}`,
        leaseId: `lease-${kind}-${this.runId.slice(0, 8)}`,
      }),
    );

    // Durable intent before the dispatch, and reconciliation before any retry.
    // A crash between the call and the receipt freeze used to leave an
    // environment the run had no record of; the next process re-provisioned.
    const provisionRequest = {
      runId: this.runId,
      archetypeHash: coreHash(this.archetype),
      disorderSeedCommitment: domainHash(HASH_DOMAINS.DRIVER_STATE, {
        run_id: this.runId,
        archetype_id: this.archetype.archetype_id,
      }),
      operationId: "op-provision",
    };
    // Exactly one dispatch. An adopted prior provision rebuilds its result from
    // the driver's operation log and a fresh inspection — the inventory is an
    // observation either way — rather than calling `provision` a second time,
    // which would be a second external invocation however harmless it looked.
    const result = this.driverOperation<ProvisionResult>({
      operationId: "op-provision",
      kind: "provision",
      targetIdentity: coreHash(this.archetype),
      requestHash: domainHash(HASH_DOMAINS.DRIVER_STATE, provisionRequest),
      compensation: "invalid terminal via frontier-derived environment cleanup",
      dispatch: () => this.driver.provision(provisionRequest),
      adopt: (receipt) => {
        const observed = this.driver.inspect(this.runId);
        return {
          receipt,
          inventory: observed,
          environmentInstanceHash: observed.environment_instance_hash,
          partial: observed.resources.length < this.archetype.topology.length,
        };
      },
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
        // The binding is the first produced role of the environment branch:
        // every later phase resolves it before it dispatches, and the offline
        // verifier requires it before it will believe any cleanup verdict.
        {
          artifact_role: "substrate-binding",
          artifact_core_hash: binding.core_hash,
          artifact_schema_version: "substrate-binding/v1",
        },
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
    this.intents.settle("op-provision", result.receipt.core_hash);
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
    // The substrate this phase is about to probe must be the one the run bound.
    this.assertBoundSubstrate({ expectProvisioned: true });
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
   * Refuses a step occurrence whose prerequisites the run has not earned.
   *
   * Enforced here, at the library boundary, and not in the CLI: a caller holding
   * an `EnvironmentRun` must be held to the same matrix as one holding the
   * binary, or the matrix is advice (ADR-ERL2-028 §2.4).
   */
  private assertStepPrerequisites(intent: JourneyIntent, state: LabState): void {
    assertJourneyPrerequisites(intent, {
      state,
      hasRole: (role) =>
        role === "source-snapshot"
          ? this.ws.hashesForRole(role).length > 0
          : this.ws.hashForRole(role) !== undefined,
      connectSucceeded: this.connectOutcome()?.status === "succeeded",
      completedStepCount: this.ws.derivedStepOutcomes().length,
    });
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
    // Every applicable activation, cutoff, ordering and state prerequisite, for
    // *this* occurrence — not only for the journey's first step (review P1-9).
    // The previous gate was `state === "execution_plan_frozen" && !SETUP_INTENTS
    // .has(...)`, and `step_outcome_frozen` recurs after every step, so a
    // committed `exercise` step ran happily before activation and before the
    // cutoff existed.
    this.assertStepPrerequisites(step.intent, state);

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

    // A subject step is the one external mutation with **no probe**. An opaque
    // subject cannot be asked whether it already ran a step, so an intent left
    // unsettled by a crash is genuinely ambiguous — and ambiguity fails closed
    // (ADR-ERL2-024 §4.3). Re-dispatching would mean choosing to double-install
    // against a real subject to keep a happy path green. The durable intent
    // itself is what makes the ambiguity *visible*: before it, a crash between
    // the call and the lifecycle append simply re-invoked the port (review P1-7).
    const response = this.intents.run(
      {
        operationId: `op-step-${String(step.index)}`,
        kind: "subject_step",
        targetIdentity: step.visibleStep.step_id,
        requestHash: request.core_hash,
        // The step commitment, not the request: the request carries a deadline
        // read from the clock, and an idempotency key that moves is not one.
        idempotencyKey: step.commitment.core_hash,
        preconditionHash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
          prior_outcomes: priorInteractions,
        }),
        ...(this.ws.hashForRole("substrate-binding") === undefined
          ? {}
          : { substrateBindingHash: this.ws.requireHashForRole("substrate-binding") }),
        retry: "fail_closed",
        compensation: "invalid terminal; a subject step is not safe to repeat",
        probe: () => "unknown" as const,
        dispatch: () => this.ws.subject.step(request, step.intent),
      },
      this.now(),
    );
    // Boundary 5: the subject has responded and not one byte of the response is
    // retained yet. The durable intent says `dispatched`; nothing else does.
    this.barrier("before_receipt_freeze", `op-step-${String(step.index)}`);
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
    // Boundary 6: the subject's output bytes are frozen and no lifecycle event
    // names them. A retained byte the lifecycle never reached is precisely what
    // the closure derivation rejects as unaccounted, so this boundary is the one
    // that says whether a resumed run can still close.
    this.barrier("after_receipt_freeze", `op-step-${String(step.index)}`);
    // Boundary 7: immediately before the step submachine, which appends
    // `_planned`, `_started`, the terminal event, freezes the outcome and appends
    // `_outcome_frozen` as one pass.
    this.barrier("before_lifecycle_append", `op-step-${String(step.index)}`);
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
    // Boundary 8: the outcome is frozen and its events are appended; only the
    // intent's own `settled` marker is missing. A restart must be a true no-op —
    // the step has an outcome, so `nextStep()` has moved on.
    this.barrier("after_lifecycle_append", `op-step-${String(step.index)}`);
    this.intents.settle(`op-step-${String(step.index)}`, outcome.core_hash);
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
  activate(): { readonly receiptHash: Hash; readonly activationReceiptHash: Hash } {
    // "Already activated" is read from evidence, not from state ordering: the
    // state this phase departs from (`step_outcome_frozen`) recurs on every
    // journey step, so only the retained activation receipt distinguishes a run
    // that has activated from one that has not.
    if (this.ws.hashForRole("mutation-receipt") !== undefined) {
      const receiptHash = this.ws.requireHashForRole("mutation-receipt");
      // Settle here too. A crash between the lifecycle append and the settle left
      // an intent stuck at `dispatched` over an operation whose public evidence is
      // complete, and this replay path returned without ever clearing it — so the
      // journal accumulated a permanently pending entry for a finished operation.
      // Harmless to the terminal, and not harmless to a reader: it is the
      // difference between "one operation is unaccounted" and "none are".
      this.intents.settle("op-activate", receiptHash);
      return {
        receiptHash,
        activationReceiptHash: this.ws.requireHashForRole("challenge-activation-receipt"),
      };
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
    this.assertBoundSubstrate({ expectProvisioned: true });
    assertOperationSupported(this.driver.manifest, "mutate");
    const target = this.mutationTarget();
    const mutateRequest = {
      runId: this.runId,
      targetResourceId: target.resource_id,
      mutationId: `activate-${this.binding().challenge_manifest_hash.slice("sha256:".length, "sha256:".length + 12)}`,
      operationId: "op-activate",
    };
    const receipt = this.driverOperation({
      operationId: "op-activate",
      kind: "mutate",
      targetIdentity: target.identity_hash,
      requestHash: domainHash(HASH_DOMAINS.DRIVER_STATE, mutateRequest),
      compensation: "invalid terminal via receipt-backed emergency cleanup",
      dispatch: () => this.driver.mutate(mutateRequest),
    });
    if (receipt.status !== "succeeded") {
      throw new Erl2Error(
        CODES.ENV_PROVISION_FAILED,
        `challenge activation failed: ${receipt.error_code ?? "unspecified"}`,
        { owner: "lab" },
      );
    }
    // Design §12 asks for a **signed controller receipt** alongside the traffic
    // receipt, and no V2 contract carried one: `EnvironmentOperationReceiptV1`
    // records what the substrate did and has no signature field, so it can say
    // that a mutation happened but not who authorized it. ADR-ERL2-023 adds this
    // additive contract for exactly that gap.
    // Boundary 5: the substrate is mutated and nothing is retained about it.
    this.barrier("before_receipt_freeze", "op-activate");
    const baselineHash = this.ws.requireHashForRole("environment-baseline");
    const activation = assertContract<ChallengeActivationReceiptV1>(
      "ChallengeActivationReceiptV1",
      sealSigned(
        {
          schema_version: "challenge-activation-receipt/v1" as const,
          receipt_id: `activation-${this.runId.slice(0, 8)}`,
          run_id: this.runId,
          selected_challenge_journey_binding_hash: this.ws.requireHashForRole(
            "selected-challenge-journey-binding",
          ),
          environment_instance_hash: this.environmentInstanceHash(),
          execution_plan_hash: this.ws.requireHashForRole("execution-plan"),
          environment_fingerprint_hash: baselineHash,
          connection_step_outcome_hash: connected.core_hash,
          mutation_receipt_hash: receipt.core_hash,
          // The substrate's own account of when the mutation landed, not the
          // moment the Lab got round to writing it down.
          //
          // This was `this.now()`, and it made the signed activation receipt
          // **not byte-reproducible across a crash** between its freeze and its
          // lifecycle append. The stepping clock is anchored to the run's latest
          // durable instant, which is stable — but the *number of reads* before
          // this point is not: the first pass dispatches `driver.mutate` and the
          // resumed pass adopts the stored receipt instead, so the two passes
          // arrive here at different ticks. Re-freezing the receipt then raised
          // `ARTIFACT_ALREADY_FROZEN` and the run reached no terminal.
          //
          // Found by crash boundary `before_lifecycle_append` (ADR-ERL2-028 §7),
          // which is the one window in which both receipts are retained and no
          // event names either. Deriving the instant from the adopted receipt
          // makes it stable by construction rather than by luck.
          activated_at: receipt.ended_at,
        },
        this.keys.controller,
      ),
    );

    this.ws.store.freezeJson(`${RETAINED}/mutation-activate.json`, receipt, "INTERNAL");
    // Boundary 6: the driver receipt is retained and the controller's signed one
    // is not. Both are closure-required once the lifecycle shows
    // `challenge_activated` (ADR-ERL2-024 §4.6), so this is the window in which a
    // resumed run has to rebuild the second from the first.
    this.barrier("after_receipt_freeze", "op-activate");
    this.ws.store.freezeJson(`${RETAINED}/activation-receipt.json`, activation, "INTERNAL");
    // Boundary 7: both receipts retained, no event names either.
    this.barrier("before_lifecycle_append", "op-activate");
    this.ws.lifecycle.append({
      eventType: "challenge_activated",
      stateTo: "challenge_activated",
      actorId: "controller",
      commandId: "activate",
      operationId: "op-activate",
      requiredHashes: [connected.core_hash, baselineHash],
      produced: [
        {
          artifact_role: "mutation-receipt",
          artifact_core_hash: receipt.core_hash,
          artifact_schema_version: "environment-operation-receipt/v1",
        },
        {
          artifact_role: "challenge-activation-receipt",
          artifact_core_hash: activation.core_hash,
          artifact_schema_version: "challenge-activation-receipt/v1",
        },
      ],
    });
    // Boundary 8: the activation is complete and public; only the intent's
    // `settled` marker is missing. A restart returns the retained receipts
    // without touching the driver, from the evidence check at the top of this
    // method rather than from state ordering.
    this.barrier("after_lifecycle_append", "op-activate");
    this.intents.settle("op-activate", receipt.core_hash);
    return { receiptHash: receipt.core_hash, activationReceiptHash: activation.core_hash };
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
    // Every input that can refuse is resolved **here**, before the first byte is
    // frozen (review P1-10, ADR-ERL2-028 §3).
    //
    // The cutoff policy used to be resolved at its freeze and the comparison
    // policy on the line after it, so `journey` with an admitted `--cutoff-policy`
    // and a missing `--comparison-policy` froze
    // `retained/environment/cutoff-policy.json` and *then* refused
    // `CFG_MISSING_REQUIRED`. The run was left holding retained cutoff-policy
    // bytes that no lifecycle event reached — a refusal that wrote evidence, and
    // one that made the run's own terminal fail offline verification as an
    // unaccounted artifact.
    //
    // Resolving both up front is not a convenience: it is the whole fix. A
    // resolution that can throw must never sit between two freezes.
    const cutoffPolicy = this.cutoffPolicy();
    const comparisonPolicy = this.comparisonPolicy();
    // The substrate this run is bound to, checked before evidence is written for
    // the same reason every dispatching phase checks it before dispatching
    // (ADR-ERL2-024 §5): a run whose binding cannot be established has no
    // business freezing a milestone about the environment it names.
    this.assertBoundSubstrate({ expectProvisioned: true });

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

    // ADR-ERL2-031 §5: the exact window is **sealed** here, before the milestone
    // is observed, so the milestone is measured against a window that was already
    // fixed rather than chosen to fit it. That was the residual: a producer free
    // to select the durations could move them inside the committed bounds and
    // move the milestone with them, and no retained byte disagreed.
    //
    // Sealed, not written. Writing before the milestone check would leave retained
    // bytes behind on a refusal — the P1-10 defect ADR-ERL2-028 §3 removed, where
    // a resolution that can throw sits between two freezes. Both artifacts reach
    // the disk together below, after nothing can still refuse.
    const windowCommitment = sealWindowCommitment({
      runId: this.runId,
      policy: cutoffPolicy,
      processStartReceipt: startReceipt,
      monotonicClockDomainHash: clockDomain.core_hash,
      comparisonPolicyHash: coreHash(comparisonPolicy),
      // The instance the observation bundle names, not the baseline fingerprint
      // the process-start receipt names. They are different artifacts and binding
      // the wrong one is caught immediately by the verifier's own binding check —
      // which is how this line got its first value wrong and its second right.
      environmentInstanceHash: this.environmentInstanceHash(),
      warmupMs: CONFIGURED_WARMUP_MS,
      observationMs: CONFIGURED_OBSERVATION_MS,
      committedAt: startedAt,
      signingKey: this.keys.policyAuthor,
    });

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

    // The milestone is an observation and the commitment is the expectation it
    // has to satisfy. Deriving the milestone from the committed warmup instead
    // would be tidier and wrong — it is signed by the `runtime_attestor`, and
    // computing it from a value the `policy_author` chose would make one party's
    // arithmetic look like two parties' agreement. Refused here, before either
    // artifact is written (ADR-ERL2-031 §3.3).
    assertMilestoneOnCommittedBoundary(windowCommitment, startReceipt, milestone);

    // The cutoff policy is mirrored into the run for the same reason the trust
    // policy is: an offline reader must be able to re-derive the cutoff from
    // retained bytes alone.
    this.ws.store.freezeJson(`${RETAINED}/cutoff-policy.json`, cutoffPolicy, "INTERNAL");
    this.ws.store.freezeJson(
      `${RETAINED}/evidence-window-commitment.json`,
      windowCommitment,
      "INTERNAL",
    );
    this.ws.store.freezeJson(`${RETAINED}/comparison-policy.json`, comparisonPolicy, "INTERNAL");
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
          artifact_core_hash: coreHash(cutoffPolicy),
          artifact_schema_version: "cutoff-policy/v1",
        },
        // A produced artifact, not a supporting schema. That distinction carries
        // the invalid branch for free: `available_evidence` is built from every
        // event's `produced`, so a run that reached traffic accounts for its
        // commitment and one that failed earlier fabricates none. A supporting
        // schema would have accounted for it unconditionally — including on runs
        // that never committed a window, which is the shape that hides an
        // omission (ADR-ERL2-031 §6).
        {
          artifact_role: "evidence-window-commitment",
          artifact_core_hash: windowCommitment.core_hash,
          artifact_schema_version: "evidence-window-commitment/v1",
        },
        {
          artifact_role: "comparison-policy",
          artifact_core_hash: coreHash(comparisonPolicy),
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
   *
   * The durations come from the run's own **frozen** window commitment, resolved
   * by role like every other retained input — never from `CONFIGURED_WARMUP_MS`
   * and `CONFIGURED_OBSERVATION_MS`. That is the whole producer-side content of
   * ADR-ERL2-031: the values an offline reader can see are the values the cutoff
   * is actually built from, so editing the module constants after the freeze
   * cannot move the cutoff without moving signed bytes.
   */
  private cutoff(): RealizedCutoff {
    const commitment = this.ws.artifact<EvidenceWindowCommitmentV1>(
      this.ws.requireHashForRole("evidence-window-commitment"),
      "EvidenceWindowCommitmentV1",
    );
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
      warmupMs: commitment.warmup_ms,
      observationMs: commitment.observation_ms,
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
    // The Lab's own telemetry is scanned before one byte of it is retained.
    // The scan used to sit only in `freezeObservation`, one phase later, by which
    // point the snapshots were already frozen artifacts: the refusal was real but
    // it arrived after the leaking bytes had been written.
    assertTelemetryOracleClean(snapshots, this.ws.knownCanaryIds());
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
      // The bytes an adapter would mount are this snapshot's canonical bytes, so
      // they are scanned before they are published rather than after — and the
      // published bytes are bound to the scanned ones.
      const ref = this.ws.freezeMountedFile(
        `subject-visible/canonical/${snapshot.snapshot_id}.json`,
        snapshot,
        `canonical-evidence:${snapshot.source_id}`,
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
        // Also an adapter-visible mount, and scanned as one: the projection is
        // derived from bytes this run already scanned, but "derived from clean
        // input" is an argument, not a check.
        this.ws.freezeMountedFile(
          `subject-visible/translated/${entry.entry_id}.json`,
          { entry_id: entry.entry_id, source_content_hash: entry.source_content_hash },
          `translated-evidence:${entry.entry_id}`,
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

    // Every retained payload byte the subject produced, read back from the store
    // rather than taken from any descriptor. `store.read` resolves component by
    // component and refuses a symlink or a hard link, so these are the bytes at
    // the authorized path and not bytes something pointed there.
    //
    // One read, three gates, in this order and for these reasons:
    //
    //   1. the declared byte ceiling, first — it is the one check that must not
    //      require materialising an over-large payload as text to reach a verdict;
    //   2. the judge-canary scan, unchanged, which owns that rule on this surface;
    //   3. secret canaries and forbidden identifiers, which had no gate here at
    //      all.
    //
    // All three run before anything freezes, so each refusal leaves no subject
    // output manifest and no step-outcome copy behind.
    const payloads = outcomes.flatMap((outcome) =>
      outcome.output_refs.map((ref) => ({
        path: ref.path,
        bytes: this.ws.store.read(ref.path),
      })),
    );
    assertSubjectOutputWithinDeclaredBytes(payloads, this.plannedPlan().limits.output_bytes);

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
    assertSubjectOutputContentClean(payloads);

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
   * The mutations a compensation is expected to reverse, from the run's own
   * retained evidence (ADR-ERL2-026 §4.2).
   *
   * Derived from the retained `mutation-receipt` role, one entry per receipt,
   * so the expected set is exactly what the run durably recorded as applied and
   * cannot be narrowed at compensation time. The mutation id is the driver's
   * own vocabulary, recovered from the receipt's `compensation_id`: the driver
   * declares "the way to undo this is `compensate-<mutation>`" when it applies
   * a mutation, and that is the only place the two vocabularies meet.
   */
  private expectedRevertedMutations(): readonly ExpectedRevertedMutation[] {
    return this.ws.hashesForRole("mutation-receipt").map((hash) => {
      const receipt = this.ws.artifact<EnvironmentOperationReceiptV1>(
        hash,
        "EnvironmentOperationReceiptV1",
      );
      const compensationId = receipt.compensation_id;
      if (compensationId === undefined || !compensationId.startsWith(COMPENSATION_PREFIX)) {
        // A mutation whose receipt names no compensation cannot be proven
        // reverted, so it is not quietly dropped from the expected set: the run
        // refuses rather than compensating a smaller set than it mutated.
        throw new Erl2Error(
          CODES.RESTORATION_PROBE_MISSING,
          `the retained mutation receipt ${hash} declares no compensation, so what a restoration ` +
            `would have to revert cannot be established`,
          { owner: "lab" },
        );
      }
      return {
        mutationId: compensationId.slice(COMPENSATION_PREFIX.length),
        mutationReceiptHash: receipt.core_hash,
        targetIdentityHash: receipt.target_identity_hash,
      };
    });
  }

  /** What the substrate says is applied now, or `undefined` if it cannot be asked. */
  private observedMutations(): readonly string[] | undefined {
    return this.driver.observedMutations?.(this.runId);
  }

  /**
   * Compensates every mutation, independently re-reads the substrate, and
   * freezes both the restoration verification and the observation it rests on.
   *
   * `passed` is derived by `buildEnvironmentRestoration` from the before/after
   * baselines and the residual set, never supplied: a drifted baseline is a
   * restoration failure whose authorized route is emergency cleanup, so it can
   * only ever be reported, not asserted away.
   *
   * Those three observations are blind to a *mutation*, though — the
   * fingerprint measures resource health and the inventory measures resource
   * existence — so ADR-ERL2-026 adds the one observation that is not: the
   * substrate is asked again what is applied, and a compensation that returned
   * `succeeded` while leaving its target applied is refused on that ground
   * alone (review P1-4).
   */
  restore(): EnvironmentRestorationVerificationV1 {
    if (!this.enter("restore", this.ws.hashForRole("environment-restoration") !== undefined)) {
      return this.ws.artifact<EnvironmentRestorationVerificationV1>(
        this.ws.requireHashForRole("environment-restoration"),
        "EnvironmentRestorationVerificationV1",
      );
    }
    this.assertBoundSubstrate({ expectProvisioned: true });
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

    // Read *before* the dispatch, and before the intent that precedes it: the
    // question "what was applied when this compensation started" has no answer
    // once the compensation has run.
    const expected = this.expectedRevertedMutations();
    const observedBefore = this.observedMutations();
    const bindingHash = this.ws.requireHashForRole("substrate-binding");

    const receipt = this.driverOperation({
      operationId: "op-restore",
      kind: "restore",
      targetIdentity: this.instanceHashForCleanup(),
      requestHash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
        run_id: this.runId,
        operation_id: "op-restore",
        // What this compensation is *supposed* to revert, recorded before it
        // runs. Without it, "reverted nothing" and "had nothing to revert" are
        // indistinguishable — which is how a no-op compensation was accepted
        // (review P1-4).
        reverts: this.ws.hashesForRole("mutation-receipt"),
      }),
      // The durable intent names the mutation set, the resources it was applied
      // to, the state observed before, the condition that must hold afterwards
      // and the probe that will answer it — so a crash mid-compensation leaves a
      // record of what the run was in the middle of undoing, not just that it
      // was undoing something.
      expectedRevertedMutations: expected.map((entry) => entry.mutationId),
      expectedTargets: expected.map((entry) => entry.targetIdentityHash),
      expectedPostCondition: "no expected mutation remains applied to the bound substrate",
      probeId: "driver.observedMutations",
      compensation: "invalid terminal via receipt-backed emergency cleanup",
      dispatch: () => this.driver.restore({ runId: this.runId, operationId: "op-restore" }),
    });
    // The compensation receipt must be about *this* compensation, on this run's
    // substrate. A receipt from another operation, another run or another driver
    // manifest is a receipt from elsewhere, and citing one is how a stale
    // success gets replayed over a compensation that never happened.
    this.assertCompensationReceiptBound(receipt, "op-restore");
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

    // The independent observation. Taken from the substrate, not from the
    // receipt the substrate just handed back.
    const observedAfter = this.observedMutations();
    const probe = buildRestorationProbe({
      runId: this.runId,
      substrateBindingHash: bindingHash,
      environmentInstanceHash: this.environmentInstanceHash(),
      compensationOperationId: "op-restore",
      compensationReceiptHash: receipt.core_hash,
      expected,
      observedBefore: observedBefore ?? [],
      observedAfter: observedAfter ?? [],
      probeStatus: observedAfter === undefined ? "unavailable" : "observed",
      probedAt: this.now(),
      signingKey: this.keys.environmentGovernor,
    });
    if (!restorationProbePassed(probe.outcome)) {
      // Retained before the refusal, so the invalid terminal can cite the
      // observation that refused it rather than only the receipt that lied.
      this.ws.store.freezeJson(`${RETAINED}/failed-restore-receipt.json`, receipt, "INTERNAL");
      this.ws.store.freezeJson(`${RETAINED}/failed-restoration-probe.json`, probe, "INTERNAL");
      this.failedAttemptHash = receipt.core_hash;
      throw new Erl2Error(
        CODES.RESTORATION_NOT_INDEPENDENTLY_OBSERVED,
        `the compensation receipt reports success, but re-reading the bound substrate derives ` +
          `${probe.outcome}` +
          (probe.residual_expected_mutations.length > 0
            ? ` (still applied: ${probe.residual_expected_mutations.join(", ")})`
            : probe.collateral_reverted_mutations.length > 0
              ? ` (reverted without being asked to: ${probe.collateral_reverted_mutations.join(", ")})`
              : " (the driver offers no applied-mutation observation)") +
          `; the authorized route is receipt-backed emergency cleanup`,
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
    this.ws.store.freezeJson(`${RETAINED}/restoration-probe.json`, probe, "INTERNAL");
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
          artifact_role: "restoration-probe",
          artifact_core_hash: probe.core_hash,
          artifact_schema_version: "restoration-probe/v1",
        },
        {
          artifact_role: "environment-restoration",
          artifact_core_hash: restoration.core_hash,
          artifact_schema_version: "environment-restoration-verification/v1",
        },
      ],
    });
    this.intents.settle("op-restore", receipt.core_hash);
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
    // The exact site of the P0-1 exploit: `destroy` against a fresh empty
    // substrate observed nothing and recorded a clean teardown. It now refuses
    // before the `teardown_started` event, so no cleanup evidence freezes at all.
    this.assertBoundSubstrate({ expectProvisioned: true });
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

    const result = this.driverOperation<DestroyResult>({
      operationId: "op-destroy",
      kind: "destroy",
      targetIdentity: this.environmentInstanceHash(),
      requestHash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
        run_id: this.runId,
        operation_id: "op-destroy",
        declared: declared.map((r) => r.identity_hash),
      }),
      compensation: "invalid terminal via receipt-backed emergency cleanup",
      dispatch: () => this.driver.destroy({ runId: this.runId, operationId: "op-destroy" }),
      adopt: (receipt) => ({ receipt, residue: this.driver.inspect(this.runId).resources }),
    });
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
    this.intents.settle("op-destroy", result.receipt.core_hash);
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

    // Every failing gate gets a finding that names it. `invalidityFindingHashes`
    // used to be a hardcoded `[]` two lines below the gate computation, so a run
    // with any failing gate froze a validity result asserting failure with zero
    // supporting findings — which `assertEnvironmentFinalizable` then rejected as
    // a fabricated invalid reason. The run was durably accepted with **no
    // reachable terminal at all**, which ERL2-FR-001 forbids (review P1-3).
    //
    // The findings are derived from the gate results, not chosen: a gate that
    // passed can never acquire one, and a gate that failed can never lack one.
    const gates = this.environmentGates(input);
    const failedGates = gates.filter((gate) => !gate.passed);
    const invalidityFindingHashes = failedGates.map((gate) =>
      this.ws.freezeInvalidityFinding({
        findingId: `environment-gate-${gate.gate_id}`,
        category: "lab_invalid",
        summary: `Lab-owned environment validity gate ${gate.gate_id} did not pass.`,
        failedGateIds: [gate.gate_id],
        proofRefs: [...gate.evidence_refs],
      }),
    );

    const validity = buildEnvironmentValidity({
      runId: this.runId,
      terminalStage,
      genericRunPolicyHash: policyHash,
      gates,
      environmentRestorationHash: restorationHash,
      teardownHash,
      invalidityFindingHashes,
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
        // The findings are recorded as produced roles, not merely retained: a
        // retained byte the lifecycle never reached is an unaccounted artifact,
        // and the closure derivation rejects it.
        ...invalidityFindingHashes.map((hash) => ({
          artifact_role: "finding",
          artifact_core_hash: hash,
          artifact_schema_version: "finding/v1",
        })),
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

    // The finalizer re-observes residue independently of what teardown reported
    // (`residueAfterTeardown` below). That independence is worthless if it can be
    // pointed at a different substrate, so the binding is checked here too.
    this.assertBoundSubstrate({ expectProvisioned: false });

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

    // Two public terminal types are excluded because the bundle already carries
    // them: an inventory covering them would vouch for artifacts the reader
    // holds independently. Everything else that is signed and retained is
    // derived, not enumerated by field name (ADR-ERL2-030 §4) — this branch is
    // where the old `artifact.value["signature"]` loop lost the most, omitting
    // the wrapper-signed beacon association receipt and the mirrored trust root
    // from an inventory that asserted it was complete.
    const environmentExclusions = [
      "environment-final-lab-attestation/v1",
      "selection-verification-receipt/v2",
    ];
    const signerInventory = this.ws.deriveSignerInventory(checkpoint, environmentExclusions);
    const inventory = buildEnvironmentSignerInventory({
      inventoryId: `inv-${this.runId.slice(0, 8)}`,
      runId: this.runId,
      selectionCommitmentHash: this.ws.requireHashForRole("selection-commitment"),
      entries: signerInventory.entries,
      completeForTerminalChain: signerInventory.derivation.completeForTerminalChain,
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
      signerInventoryComplete: signerInventory.derivation.completeForTerminalChain,
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
    // Re-derived against the tree *including* the sealed inventory, so a signed
    // artifact that appeared between the derivation and the freeze cannot ride
    // in uncovered by it.
    this.ws.assertSignerInventoryStillComplete(signerInventory.entries, environmentExclusions);
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
    /**
     * The phase that failed.
     *
     * A string for the seven lifecycle phases. For a journey step it is the
     * step's own identity, because `InvalidJourneyExecutionPhaseV1` — already in
     * the frozen contract, and until now unreached by the environment walk —
     * requires the intent and the step commitment. That is the route an
     * ambiguous subject dispatch takes: `ENV_MUTATION_INTENT_AMBIGUOUS` used to
     * propagate as an ordinary CLI error, leaving a durably accepted run with no
     * terminal at all, which is the brief's own P1 definition
     * (ADR-ERL2-028 §5.2).
     */
    readonly phase:
      | "provisioning"
      | "baseline"
      | "planning"
      | "activation"
      | "observation"
      | "environment_restoration"
      | "teardown"
      | {
          readonly kind: "journey_execution";
          readonly intent: EnvironmentJourneyIntent;
          readonly stepCommitmentHash: Hash;
        };
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
    // The gate named is the one this phase's evidence supports, and which its
    // failure therefore falsifies. It used to be keyed on the *cleanup branch*
    // — `input.emergency ? "restoration-verified" : "environment-baseline-clean"`
    // — so a provisioning failure named a baseline gate the run never evaluated
    // and a teardown failure named a restoration gate that had passed
    // (ADR-ERL2-027 §4.5). The verifier re-derives this from the record's own
    // `failed_phase` and refuses any other gate.
    //
    // Frozen here, before the frontier and before any cleanup dispatch: a
    // cleanup that then fails adds its own evidence and never replaces the cause.
    const lifecyclePhase = typeof input.phase === "string" ? input.phase : undefined;
    const journeyStep = typeof input.phase === "string" ? undefined : input.phase;
    const phaseLabel = lifecyclePhase ?? `journey-${(journeyStep as { intent: string }).intent}`;
    const findingHash = this.ws.freezeInvalidityFinding({
      findingId: `environment-${phaseLabel.replaceAll("_", "-")}-failure`,
      category: "lab_invalid",
      summary: `${input.failure.code}: ${input.failure.message}`.slice(0, 512),
      failedGateIds: [
        lifecyclePhase === undefined
          ? JOURNEY_EXECUTION_GATE
          : gateForEnvironmentFailurePhase(lifecyclePhase),
      ],
      proofRefs: [this.instanceHashForCleanup()],
    });

    // A provisioning failure raises *after* the binding is frozen and *before*
    // the event that records it, so the detection event adopts it. Two things
    // depend on that: the frontier gate below needs a binding it can resolve by
    // role, and the invalid-record closure counts a retained byte the lifecycle
    // never reached as an unaccounted artifact.
    const unrecordedBinding =
      this.ws.hashForRole("substrate-binding") === undefined
        ? this.retainedSubstrateBinding()
        : undefined;
    const detectionProduced = [
      ...(unrecordedBinding === undefined
        ? []
        : [
            {
              artifact_role: "substrate-binding",
              artifact_core_hash: unrecordedBinding.core_hash,
              artifact_schema_version: "substrate-binding/v1",
            },
          ]),
      ...(this.failedAttemptHash === undefined
        ? []
        : [
            {
              artifact_role: "environment-operation-receipt",
              artifact_core_hash: this.failedAttemptHash,
              artifact_schema_version: "environment-operation-receipt/v1",
            },
          ]),
    ];
    const detection = this.ws.lifecycle.append({
      // Named for the phase, not for the state: the state is
      // `invalid_failure_detected` for every one of them, and an event stream
      // that only said that would not say what failed.
      // A journey step's failure is named for the step, not for the walk: the
      // event stream has to say *which* committed occurrence was left without an
      // outcome, because that is the whole content of the finding.
      eventType:
        lifecyclePhase === undefined
          ? `environment_journey_${(journeyStep as { intent: string }).intent}_failed`
          : `environment_${lifecyclePhase.replace(/^environment_/, "")}_failed`,
      stateTo: "invalid_failure_detected",
      actorId: "operator",
      commandId: "cleanup",
      operationId: "op-invalid-detected",
      requiredHashes: [findingHash],
      failure: input.failure,
      ...(detectionProduced.length === 0 ? {} : { produced: detectionProduced }),
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
    // The frontier is an observation of the substrate, so it is only meaningful
    // against the substrate the run bound. `expectProvisioned` is false: a
    // provisioning failure legitimately has no inventory, and an emptied
    // substrate is a *result* the frontier must be allowed to record.
    this.assertBoundSubstrate({ expectProvisioned: false });
    const frontier = freezeResourceFrontier({
      runId: this.runId,
      environmentInstanceHash: this.instanceHashForCleanup(),
      driverManifestHash: coreHash(this.driver.manifest),
      trigger,
      observedResources: this.driver.inspect(this.runId).resources,
      frozenAt: this.now(),
    });
    this.ws.store.freezeJson(`${RETAINED}/resource-frontier.json`, frontier, "INTERNAL");

    // One executor, both routes. `emergency` decides which lifecycle states the
    // terminal passes through and which trigger the frontier records — it does
    // **not** decide which safety rules apply. Until ADR-ERL2-027 it did: the
    // bounded route swung an unconditional whole-environment `driver.destroy()`
    // over a frontier it had just frozen and never read, which destroyed
    // resources that frontier had classified `contain_residual` and aborted
    // outright on a foreign one (review P1-1, P1-5 — closed on the emergency
    // branch by ADR-ERL2-024 §4.5 and left open on this one).
    const cleanup = this.frontierDerivedCleanup(frontier, trigger, input.emergency);

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
      failed_phase:
        lifecyclePhase === undefined
          ? {
              kind: "journey_execution" as const,
              failed_intent: (journeyStep as { intent: EnvironmentJourneyIntent }).intent,
              step_commitment_hash: (journeyStep as { stepCommitmentHash: Hash }).stepCommitmentHash,
              lifecycle_event_hash: detection.core_hash,
            }
          : {
              kind: "lifecycle_phase" as const,
              phase: lifecyclePhase as InvalidNonJourneyPhase,
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

  // -- 15. cancellation, on the branch the run is actually in -----------------

  /**
   * The cancellation phase this run is in, derived from its observed state.
   *
   * Not the pre-environment mapping: that one answers `environment_setup` for
   * everything from `case_selected` onward and has no notion of a journey in
   * flight, which is how a live environment came to be described as a
   * pre-environment cancellation in the first place.
   */
  private cancellationPhase(state: LabState): "environment_setup" | "journey_execution" | "cleanup" | "finalization" {
    if (
      state === "case_selected" ||
      state === "environment_provisioned" ||
      state === "baseline_verified" ||
      state === "execution_plan_frozen"
    ) {
      return "environment_setup";
    }
    if (
      state.includes("cleanup") ||
      state.startsWith("teardown") ||
      state === "environment_restored"
    ) {
      return "cleanup";
    }
    if (state.includes("validity_result") || state === "generic_evaluation_index_frozen") {
      return "finalization";
    }
    return "journey_execution";
  }

  /**
   * The environment journey intent a cancellation interrupted, if any.
   *
   * The step the journey owes next when there is one — that is the step in
   * flight — and otherwise the last environment intent that produced an outcome.
   * A run with neither is not executing a journey.
   */
  private cancellationJourneyIntent(): EnvironmentJourneyIntent | undefined {
    const environmentIntent = (intent: JourneyIntent): EnvironmentJourneyIntent | undefined =>
      intent === "acquire" || intent === "verify_package"
        ? undefined
        : (intent as EnvironmentJourneyIntent);
    if (this.ws.hashForRole("execution-plan") === undefined) return undefined;
    const next = this.nextStep();
    if (next !== undefined) {
      const intent = environmentIntent(next.intent);
      if (intent !== undefined) return intent;
    }
    const outcomes = this.ws.derivedStepOutcomes();
    for (let i = outcomes.length - 1; i >= 0; i -= 1) {
      const intent = environmentIntent((outcomes[i] as JourneyStepOutcomeV1).intent);
      if (intent !== undefined) return intent;
    }
    return undefined;
  }

  /**
   * The frontier this run already enumerated and froze, if it has one.
   *
   * Read by role, so it is the frontier the *lifecycle* reached — the same
   * discipline every other phase uses. A run that has one has already observed
   * its substrate once for cleanup purposes, and a continuation reads that
   * observation rather than making a second one under a different trigger.
   */
  private retainedResourceFrontier(): EnvironmentResourceFrontierV1 | undefined {
    const hash = this.ws.hashForRole("environment-resource-frontier");
    if (hash === undefined) return undefined;
    return this.ws.artifact<EnvironmentResourceFrontierV1>(hash, "EnvironmentResourceFrontierV1");
  }

  /**
   * Every operation this run left unsettled, reconciled before the cancellation
   * touches the substrate (ADR-ERL2-028 §6.3).
   *
   * A cancellation that interrupts a journey must not start another subject step
   * — it does not, it never dispatches one — but it must also not describe the
   * run as merely "cancelled during `exercise`" when the truth is "`exercise` was
   * dispatched and nobody knows what happened". The reconciliation is the
   * *probe*, run before any cleanup call, and its verdict is recorded in the
   * cancellation's own reason so an offline reader sees the ambiguity rather than
   * inferring it from an intent journal that is not public evidence.
   *
   * The probes themselves are read-only by contract, so running them here costs
   * the substrate nothing and cannot dispatch anything.
   */
  private reconcilePendingOperations(): readonly string[] {
    const ambiguous: string[] = [];
    // The step ids this run has a frozen outcome for. A crash between the
    // lifecycle append and the intent's `settled` marker leaves an intent that
    // looks pending and an operation that demonstrably completed; reporting that
    // as an ambiguity would be a fabricated one, and a cancellation record full
    // of fabricated ambiguities is no more useful than one with none.
    const completedStepIds = new Set(this.ws.derivedStepOutcomes().map((outcome) => outcome.step_id));
    for (const intent of this.intents.unsettled()) {
      // A driver operation can be asked; a subject step cannot, and that
      // asymmetry is the claim rather than a gap in it (ADR-ERL2-024 §4.3).
      // `declared` is the third answer: it proves nothing was dispatched.
      const settled =
        intent.state === "declared"
          ? true
          : intent.kind === "subject_step"
            ? completedStepIds.has(intent.target_identity)
            : this.driver.completedOperation?.(this.runId, intent.operation_id) !== undefined;
      if (!settled) ambiguous.push(`${intent.kind}:${intent.operation_id}:${intent.state}`);
    }
    return ambiguous;
  }

  /**
   * True once the run has entered its cleanup sequence, so a cancellation from
   * here has exactly one authorized route: receipt-backed emergency cleanup
   * (design §12). Restoration and teardown are the two phases whose failure the
   * design already routes that way, and an interruption part-way through either
   * is indistinguishable from a failure of it.
   */
  private cleanupAlreadyBegun(state: LabState): boolean {
    return (
      state === "lab_cleanup_started" ||
      state === "environment_restored" ||
      state.startsWith("teardown") ||
      state.startsWith("emergency_") ||
      state === "invalid_environment_cleanup_started"
    );
  }

  /**
   * `erl2 cancel` on the environment branch (ADR-ERL2-024 §4.4).
   *
   * ## What this replaces
   *
   * `cancel` was not branch-dispatched. Cancelling a **live** environment run
   * ran the pre-environment terminal, which enumerates only the Lab's own
   * acquisition temporaries: the record froze with cleanup variant `none` and
   * status `not_required` while the environment and its four reservation leases
   * were still allocated — and the shipped verifier accepted it (review P1-2).
   *
   * ## The order, and why it is that order
   *
   * The signed cancellation request freezes **first**, before any external
   * cleanup call. That is the durable cancellation intent §4.3 requires: a crash
   * between "the operator asked to stop" and "the Lab started destroying things"
   * must leave evidence of the ask, not of neither.
   *
   * Reservations are released **last**, only after cleanup is proven, exactly as
   * on the valid path: a cancelled run that returned its network and port names
   * while its containers were still up would hand a live environment's
   * identities to the next run.
   */
  cancel(input: {
    readonly reasonCode: string;
    readonly requestedByActorId: string;
  }): InvalidLabRunRecordV1 {
    const state = this.ws.lifecycle.currentState;

    // Replay is a no-op, not a second terminal. A cancelled run that is
    // cancelled again returns the record it already froze and writes nothing.
    const existingRecord = this.ws.hashForRole("invalid-run-record");
    if (existingRecord !== undefined) {
      const record = this.ws.artifact<InvalidLabRunRecordV1>(existingRecord, "InvalidLabRunRecordV1");
      if (record.failed_phase.kind === "cancellation") return record;
      throw new Erl2Error(
        CODES.CANCELLATION_AFTER_TERMINAL,
        `run is already invalidated for a reason other than cancellation; it cannot be cancelled`,
      );
    }
    if (state === "created") {
      throw new Erl2Error(
        CODES.CANCELLATION_BEFORE_ACCEPTANCE,
        "a run that has not been durably accepted cannot be cancelled",
      );
    }
    if (TERMINAL_STATES.has(state)) {
      throw new Erl2Error(
        CODES.CANCELLATION_AFTER_TERMINAL,
        `run is already terminal (state ${state}); it cannot be cancelled`,
      );
    }

    // `InvalidCancellationPhaseV1` requires the journey intent exactly when the
    // cancellation happened during journey execution, and forbids it otherwise:
    // "cancelled during the journey" is not a claim you may make without saying
    // *which step*. If no environment intent can be derived the run was not in a
    // journey at all, so the honest phase is the setup one.
    const journeyIntent = this.cancellationJourneyIntent();
    const derivedPhase = this.cancellationPhase(state);
    const cancelledDuring =
      derivedPhase === "journey_execution" && journeyIntent === undefined
        ? ("environment_setup" as const)
        : derivedPhase;
    const emergency = this.cleanupAlreadyBegun(state);

    // 1. durable intent, before any external call.
    const requestBase = {
      schema_version: "cancellation-request/v1" as const,
      request_id: `cxl-${this.runId.slice(0, 8)}`,
      run_id: this.runId,
      cancelled_during: cancelledDuring,
      observed_state: state,
      requested_by_actor_id: input.requestedByActorId,
      reason_code: input.reasonCode,
      requested_at: this.now(),
    };
    const request = assertContract<CancellationRequestV1>(
      "CancellationRequestV1",
      sealSigned(requestBase, this.keys.finalizer),
    );
    this.ws.store.freezeJson("retained/cancellation-request.json", request, "INTERNAL");

    // 2. detection, carrying the request and adopting any binding the lifecycle
    //    has not yet recorded (a cancellation during provisioning).
    const unrecordedBinding =
      this.ws.hashForRole("substrate-binding") === undefined
        ? this.retainedSubstrateBinding()
        : undefined;
    // Reconcile before the substrate is touched, and record what could not be
    // reconciled *in the hash-chained lifecycle* (ADR-ERL2-028 §6.3).
    //
    // A cancellation that interrupts a dispatched-but-unsettled operation used to
    // describe itself as nothing more than "cancelled during exercise". The
    // operator's ask and the pending operation's unknown outcome are two separate
    // facts, and the second one belongs in public evidence: the intent journal is
    // run-private by design (ADR-ERL2-024 §4.3) and an offline reader never sees
    // it, so an ambiguity recorded only there is an ambiguity recorded nowhere.
    const unreconciled = this.reconcilePendingOperations();
    const detection = this.ws.lifecycle.append({
      eventType: "environment_cancellation_requested",
      stateTo: "invalid_failure_detected",
      actorId: input.requestedByActorId,
      commandId: "cancel",
      operationId: "op-cancel-detected",
      requiredHashes: [request.core_hash],
      ...(unreconciled.length === 0
        ? {}
        : {
            failure: {
              code: CODES.ENV_MUTATION_INTENT_AMBIGUOUS,
              // Lab-owned: the Lab cannot establish what happened, and that is a
              // fact about the Lab's own knowledge. Attributing it to the subject
              // would be fabricating an outcome the run explicitly does not have.
              owner: "lab" as const,
              message:
                `cancelled with ${String(unreconciled.length)} dispatched operation(s) whose outcome ` +
                `could not be established: ${unreconciled.join(", ")}`.slice(0, 512),
            },
          }),
      ...(unrecordedBinding === undefined
        ? {}
        : {
            produced: [
              {
                artifact_role: "substrate-binding",
                artifact_core_hash: unrecordedBinding.core_hash,
                artifact_schema_version: "substrate-binding/v1",
              },
            ],
          }),
    });
    this.ws.lifecycle.append({
      eventType: "invalid_environment_cleanup_started",
      stateTo: "invalid_environment_cleanup_started",
      actorId: input.requestedByActorId,
      commandId: "cancel",
      operationId: "op-cancel-environment-cleanup-start",
    });
    // A cancellation may not cancel mandatory safety cleanup, and it may not
    // repeat one either. `frontierDerivedCleanup` adopts every driver action that
    // already completed, because each one runs under a durable intent whose probe
    // is the driver's own operation log (ADR-ERL2-024 §4.3) — so the actions are
    // not re-dispatched. What needed fixing was the evidence around them, above:
    // the frontier is adopted rather than re-observed, and its trigger is not
    // relabelled.

    // 3. the actual resource frontier — never "this run probably has nothing".
    this.assertBoundSubstrate({ expectProvisioned: false });
    // A cancellation that interrupts a cleanup **continues** it (ADR-ERL2-024
    // §4.4's "emergency, resumed"), and the frontier is where continuing starts:
    // it is an observation the run already made and froze.
    //
    // Re-freezing one was not merely wasteful, it was a wedge. The new frontier
    // records `trigger: teardown_failure` for every emergency cancellation, so
    // cancelling during the emergency cleanup that followed a *restoration*
    // failure produced different bytes at the same logical path and raised
    // `ARTIFACT_ALREADY_FROZEN` — no terminal, leases retained. The run had
    // already enumerated its own frontier; the honest thing is to read it.
    const alreadyFrozenFrontier = this.retainedResourceFrontier();
    const frontier =
      alreadyFrozenFrontier ??
      freezeResourceFrontier({
        runId: this.runId,
        environmentInstanceHash: this.instanceHashForCleanup(),
        driverManifestHash: coreHash(this.driver.manifest),
        trigger: emergency ? "teardown_failure" : "invalid_environment_failure",
        observedResources: this.driver.inspect(this.runId).resources,
        frozenAt: this.now(),
      });
    if (alreadyFrozenFrontier === undefined) {
      this.ws.store.freezeJson(`${RETAINED}/resource-frontier.json`, frontier, "INTERNAL");
    }

    // The same executor the failure path uses, for the same reason: a
    // cancellation is a failure the operator chose, and it owes the substrate
    // exactly what any other invalid terminal owes it (ADR-ERL2-027 §4.1).
    //
    // The trigger is the frontier's own, not one re-derived from the cancellation:
    // a continued cleanup must not relabel the failure it is cleaning up after.
    // `provision_failure` is a frontier trigger the cleanup executor does not
    // model, and it is treated as the general invalid-environment case rather than
    // silently promoted to a teardown failure.
    const cleanup = this.frontierDerivedCleanup(
      frontier,
      frontier.trigger === "restoration_failure" ||
        frontier.trigger === "teardown_failure" ||
        frontier.trigger === "invalid_environment_failure"
        ? frontier.trigger
        : "invalid_environment_failure",
      emergency,
    );

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
    // The signed request is reached evidence; omitting it would leave an
    // unaccounted retained artifact the closure verifier rejects.
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
        ...(cancelledDuring === "journey_execution"
          ? { journey_intent: journeyIntent as EnvironmentJourneyIntent }
          : {}),
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
    this.ws.lifecycle.append({
      eventType: "invalidated",
      stateTo: "invalidated",
      actorId: input.requestedByActorId,
      commandId: "cancel",
      operationId: "op-cancel-invalidated",
    });
    // Only now: cleanup has been attempted and its outcome retained.
    for (const lease of this.allocator.held(this.runId)) {
      this.allocator.release(this.runId, lease.reservation_kind, lease.reserved_value);
    }
    return record;
  }

  /**
   * Reaches the cleanup terminal for a frozen frontier.
   *
   * The executor itself lives in `environmentCleanup.ts`; this is the
   * orchestration entry point both invalid-terminal routes call, and it is the
   * only place the run's state is handed to it. Everything passed below is a
   * named capability — the executor never receives this instance, the
   * workspace, the store or the intent journal, so it cannot reach for run
   * state it was not given.
   */
  private frontierDerivedCleanup(
    frontier: EnvironmentResourceFrontierV1,
    trigger: CleanupTrigger,
    emergency: boolean,
  ): FrontierCleanupOutcome {
    return executeFrontierDerivedCleanup(
      {
        runId: this.runId,
        driver: this.driver,
        now: () => this.now(),
        appendLifecycle: (event) => {
          this.ws.lifecycle.append(event);
        },
        lifecycleEvents: () => this.ws.lifecycle.all(),
        freezeJson: (logicalPath, value, classification) => {
          this.ws.store.freezeJson(logicalPath, value, classification);
        },
        driverOperation: (spec) => this.driverOperation(spec),
        settleIntent: (operationId, outcomeHash) => {
          this.intents.settle(operationId, outcomeHash);
        },
        retainedSubstrateBinding: () => this.retainedSubstrateBinding(),
        instanceHash: () => this.instanceHashForCleanup(),
      },
      frontier,
      trigger,
      emergency,
    );
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
