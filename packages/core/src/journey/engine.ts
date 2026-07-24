/**
 * The generic step engine (design v2 §12).
 *
 * The step submachine is authoritative for **every** journey intent. There is
 * no privileged installation or configuration path: acquire and remove run
 * through exactly the same planned → started → succeeded|failed|unsupported →
 * outcome-frozen sequence, and every intent can therefore produce all three
 * terminal outcomes.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type ArtifactRef,
  type Hash,
  type JourneyIntent,
  type JourneyStepOutcomeV1,
} from "@erl2/contracts";
import { ArtifactStore, coreHash } from "@erl2/integrity";
import type { Clock } from "../runtime/seams.js";
import type { LifecycleLog } from "../lifecycle/log.js";
import { assertNoSubjectExecutionAfterReveal } from "../lifecycle/states.js";

/**
 * Derived lifecycle event prefix per intent. The design names
 * `subject_acquisition_*`, `subject_package_verification_*`, `subject_install_*`,
 * `subject_config_*`, `subject_authentication_*`, `subject_connection_*`,
 * `subject_discovery_*`, `subject_interaction_*`, `subject_recovery_*`,
 * `subject_upgrade_*`, `subject_rollback_*` and `subject_uninstall_*`; the
 * remaining intents follow the same generic pattern.
 */
export const INTENT_EVENT_PREFIX: Readonly<Record<JourneyIntent, string>> = {
  acquire: "subject_acquisition",
  verify_package: "subject_package_verification",
  install: "subject_install",
  configure: "subject_config",
  authenticate: "subject_authentication",
  connect: "subject_connection",
  discover: "subject_discovery",
  exercise: "subject_interaction",
  observe: "subject_observation",
  diagnose_decide: "subject_diagnosis",
  recover: "subject_recovery",
  upgrade: "subject_upgrade",
  rollback: "subject_rollback",
  remove: "subject_uninstall",
};

/** Intents that may legally follow each intent, derived from design §10's order. */
const JOURNEY_ORDER: readonly JourneyIntent[] = [
  "acquire",
  "verify_package",
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

export function nextPermittedIntents(intent: JourneyIntent): readonly JourneyIntent[] {
  const index = JOURNEY_ORDER.indexOf(intent);
  if (index < 0 || index === JOURNEY_ORDER.length - 1) return [];
  // Recovery, rollback and removal remain reachable from any later stage, which
  // is what lets a failed step still finalize through its cleanup attempts.
  const forward = JOURNEY_ORDER.slice(index + 1);
  return forward;
}

export type StepStatus = "succeeded" | "failed" | "unsupported";

export interface StepAttempt {
  readonly attemptRecordHash: Hash;
}

/** What the subject port returns for one step. */
export interface StepExecutionResult {
  readonly status: StepStatus;
  readonly attemptRecordHashes: readonly Hash[];
  readonly detailRecordHashes: readonly Hash[];
  readonly visibleInputHashes?: readonly Hash[];
  readonly outputRefs?: readonly ArtifactRef[];
  readonly mutationReceiptHashes?: readonly Hash[];
  readonly compensationReceiptHashes?: readonly Hash[];
  readonly diagnosticRefs?: readonly ArtifactRef[];
  readonly activeOperatorMs: number;
  readonly errorCode?: string;
}

export interface RunStepOptions {
  readonly stepId: string;
  readonly intent: JourneyIntent;
  readonly stepCommitmentHash: Hash;
  readonly visibleStepHash: Hash;
  readonly adapterRequestHash: Hash;
  readonly actorId: string;
  readonly commandId: string;
  /** Executes the step. Any throw becomes a typed Lab failure, never a subject finding. */
  readonly execute: () => StepExecutionResult;
  /**
   * Detail records published alongside the outcome. They belong to the same
   * lifecycle event as the outcome so the submachine stays a single pass:
   * planned -> started -> terminal -> outcome frozen.
   */
  readonly additionalProduced?: readonly {
    readonly artifact_role: string;
    readonly artifact_core_hash: Hash;
    readonly artifact_schema_version: string;
  }[];
}

export class GenericStepEngine {
  private readonly runId: string;
  private readonly lifecycle: LifecycleLog;
  private readonly store: ArtifactStore;
  private readonly clock: Clock;

  constructor(options: {
    readonly runId: string;
    readonly lifecycle: LifecycleLog;
    readonly store: ArtifactStore;
    readonly clock: Clock;
  }) {
    this.runId = options.runId;
    this.lifecycle = options.lifecycle;
    this.store = options.store;
    this.clock = options.clock;
  }

  /**
   * Runs one step through the complete submachine and freezes exactly one
   * `JourneyStepOutcomeV1`.
   */
  runStep(options: RunStepOptions): { outcome: JourneyStepOutcomeV1; ref: ArtifactRef } {
    // No subject or adapter execution may happen after any reveal.
    assertNoSubjectExecutionAfterReveal(this.lifecycle.currentState);

    const prefix = INTENT_EVENT_PREFIX[options.intent];
    const startedAt = this.clock.now();

    this.lifecycle.append({
      eventType: `${prefix}_planned`,
      stateTo: "step_planned",
      actorId: options.actorId,
      commandId: options.commandId,
      operationId: `op-${options.stepId}-planned`,
      requiredHashes: [options.stepCommitmentHash, options.visibleStepHash],
    });
    this.lifecycle.append({
      eventType: `${prefix}_started`,
      stateTo: "step_started",
      actorId: options.actorId,
      commandId: options.commandId,
      operationId: `op-${options.stepId}-started`,
      requiredHashes: [options.adapterRequestHash],
    });

    let result: StepExecutionResult;
    try {
      result = options.execute();
    } catch (cause) {
      // An execution fault inside the Lab is Lab-owned; it never becomes a
      // subject finding (design v2 §20).
      this.lifecycle.append({
        eventType: `${prefix}_failed`,
        stateTo: "step_failed",
        actorId: options.actorId,
        commandId: options.commandId,
        operationId: `op-${options.stepId}-lab-fault`,
        failure: {
          code: "ADAPTER_EXECUTION_FAULT",
          owner: "lab",
          message: cause instanceof Error ? cause.message.slice(0, 512) : "unknown execution fault",
        },
      });
      throw cause;
    }

    const terminalState =
      result.status === "succeeded"
        ? "step_succeeded"
        : result.status === "failed"
          ? "step_failed"
          : "step_unsupported";
    const terminalEvent =
      result.status === "succeeded"
        ? `${prefix}_completed`
        : result.status === "failed"
          ? `${prefix}_failed`
          : `${prefix}_unsupported`;

    this.lifecycle.append({
      eventType: terminalEvent,
      stateTo: terminalState,
      actorId: options.actorId,
      commandId: options.commandId,
      operationId: `op-${options.stepId}-${result.status}`,
      ...(result.errorCode === undefined
        ? {}
        : {
            failure: {
              code: result.errorCode,
              owner: result.status === "unsupported" ? "subject" : "subject",
              message: `step ${options.stepId} reported ${result.status}`,
            },
          }),
    });

    const base = {
      schema_version: "journey-step-outcome/v1" as const,
      run_id: this.runId,
      step_id: options.stepId,
      step_commitment_hash: options.stepCommitmentHash,
      visible_step_hash: options.visibleStepHash,
      adapter_request_hash: options.adapterRequestHash,
      intent: options.intent,
      status: result.status,
      attempt_record_hashes: [...result.attemptRecordHashes],
      detail_record_hashes: [...result.detailRecordHashes],
      visible_input_hashes: [...(result.visibleInputHashes ?? [])],
      output_refs: [...(result.outputRefs ?? [])],
      mutation_receipt_hashes: [...(result.mutationReceiptHashes ?? [])],
      compensation_receipt_hashes: [...(result.compensationReceiptHashes ?? [])],
      diagnostic_refs: [...(result.diagnosticRefs ?? [])],
      started_at: startedAt,
      ended_at: this.clock.now(),
      active_operator_ms: result.activeOperatorMs,
      next_permitted_intents: [...nextPermittedIntents(options.intent)],
    };
    const outcome = assertContract<JourneyStepOutcomeV1>("JourneyStepOutcomeV1", {
      ...base,
      core_hash: coreHash(base),
    });
    const ref = this.store.freezeJson(
      `retained/step-outcomes/${options.stepId}.json`,
      outcome,
      "INTERNAL",
    );

    this.lifecycle.append({
      eventType: `${prefix}_outcome_frozen`,
      stateTo: "step_outcome_frozen",
      actorId: options.actorId,
      commandId: options.commandId,
      operationId: `op-${options.stepId}-outcome-frozen`,
      produced: [
        {
          artifact_role: "journey-step-outcome",
          artifact_core_hash: outcome.core_hash,
          artifact_schema_version: "journey-step-outcome/v1",
        },
        ...(options.additionalProduced ?? []),
      ],
    });

    return { outcome, ref };
  }
}

/**
 * Derives the exact ordered step occurrences from lifecycle evidence.
 *
 * The verifier uses this rather than trusting the arrays inside the run record
 * or the journey result (ERL2-FR-020, ERL2-AC-023). Exactly one outcome per
 * occurrence is required.
 */
export function deriveStepClosure(
  events: readonly { readonly event_type: string; readonly produced: readonly { readonly artifact_role: string; readonly artifact_core_hash: Hash }[] }[],
): readonly Hash[] {
  const ordered: Hash[] = [];
  let planned = 0;
  let frozen = 0;
  for (const event of events) {
    if (event.event_type.endsWith("_planned")) planned += 1;
    if (!event.event_type.endsWith("_outcome_frozen")) continue;
    frozen += 1;
    const produced = event.produced.filter((p) => p.artifact_role === "journey-step-outcome");
    if (produced.length !== 1) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_MISSING_ROLE,
        `step outcome event produced ${String(produced.length)} outcomes; exactly one is required`,
      );
    }
    ordered.push((produced[0] as { artifact_core_hash: Hash }).artifact_core_hash);
  }
  // Duplicates are checked before the planned/frozen balance, so a replayed
  // outcome is reported as an extra artifact rather than as a count mismatch.
  if (new Set(ordered).size !== ordered.length) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      "the same step outcome is frozen more than once",
    );
  }
  if (planned !== frozen) {
    throw new Erl2Error(
      planned > frozen ? CODES.GRAPH_CLOSURE_MISSING_ROLE : CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      `${String(planned)} planned step occurrence(s) but ${String(frozen)} frozen outcome(s)`,
    );
  }
  return ordered;
}
