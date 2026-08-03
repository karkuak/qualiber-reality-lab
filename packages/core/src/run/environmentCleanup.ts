/**
 * Frontier-derived cleanup: the executor both invalid-terminal routes share.
 *
 * ## Why this is its own module
 *
 * Reaching a cleanup terminal is one job with one reason to change — the
 * cleanup *policy* — and it was the largest single method in `environmentRun.ts`
 * (~330 lines inside a 4,227-line class). Nothing here decides when a run
 * cleans up; `environmentRun.ts` keeps that orchestration and all run state.
 * What moved is the decision of *how* a frozen frontier becomes attempted
 * actions, a residue observation and a terminal event.
 *
 * ## The dependency boundary
 *
 * The executor takes a `FrontierCleanupContext`: an explicitly typed set of
 * capabilities and nothing else. It never receives the `EnvironmentRun`
 * instance, the `RunWorkspace`, the artifact store or the intent journal — the
 * point of the extraction is that this code cannot reach for run state it was
 * not handed. It imports nothing from `environmentRun.ts`, so the dependency
 * runs one way and no cycle exists.
 *
 * **Every behaviour below is byte-for-byte the behaviour that lived in
 * `environmentRun.frontierDerivedCleanup`.** Lifecycle event types, operation
 * ids and order; retained paths and artifact roles; driver dispatch order;
 * intent settlement; safe-action ordering; per-action failure continuation;
 * whole-environment fallback authorization; post-action inspection timing;
 * residue-probe inputs; hash inputs; error codes and messages; terminal
 * variant, status and result selection; timestamp call order; and thrown-error
 * behaviour are all unchanged. The only edits made while moving were mechanical:
 * `this.<member>` became `ctx.<capability>`, and the two methods became
 * functions.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type EnvironmentOperationReceiptV1,
  type EnvironmentResourceFrontierV1,
  type Hash,
  type Instant,
  type SubstrateBindingV1,
} from "@erl2/contracts";
import { coreHash, domainHash, HASH_DOMAINS } from "@erl2/integrity";
import type { AppendEventInput } from "../lifecycle/log.js";
import type { LabLifecycleEventV1 } from "@erl2/contracts";
import type { EnvironmentDriver } from "../environment/driver.js";
import { safeActions } from "../environment/frontier.js";
import { buildResidueProbe } from "../environment/residueProbe.js";
import { buildEmergencyCleanup } from "../cleanup/cleanup.js";

/** Which failure the cleanup is cleaning up after. Unchanged from the method's parameter. */
export type CleanupTrigger =
  | "restoration_failure"
  | "teardown_failure"
  | "invalid_environment_failure";

/** What the caller needs in order to reach its terminal. Unchanged from the method's return. */
export interface FrontierCleanupOutcome {
  readonly variant: "emergency_environment" | "environment" | "partial_environment";
  readonly status: "attempted_succeeded" | "attempted_failed";
  readonly attemptHashes: readonly Hash[];
  readonly resultHash: Hash;
}

/**
 * Exactly the capabilities the executor uses, and no others.
 *
 * Each one is a member the method previously reached through `this`. Naming
 * them is the extraction: a reader can see the whole surface this code touches
 * without reading `environmentRun.ts`, and a future edit that needs a new
 * capability has to add it here in the open.
 */
export interface FrontierCleanupContext {
  readonly runId: string;
  /**
   * The retained subtree the environment branch writes into.
   *
   * Supplied rather than redeclared. `environmentRun.ts` owns this path and
   * always has; importing it back would be the reverse dependency this
   * extraction exists to avoid, and copying it would let the two definitions
   * drift apart silently.
   */
  readonly retainedRoot: string;
  /** The untrusted infrastructure this cleanup dispatches to. */
  readonly driver: EnvironmentDriver;
  /** The run's clock read, in the order the original made it. */
  readonly now: () => Instant;
  readonly appendLifecycle: (event: AppendEventInput) => void;
  readonly lifecycleEvents: () => readonly LabLifecycleEventV1[];
  readonly freezeJson: (logicalPath: string, value: unknown, classification: "INTERNAL") => void;
  /** Runs an external mutation under a durable intent (ADR-ERL2-026). */
  readonly driverOperation: (spec: {
    readonly operationId: string;
    readonly kind: string;
    readonly targetIdentity: string;
    readonly requestHash: Hash;
    readonly compensation: string;
    readonly dispatch: () => EnvironmentOperationReceiptV1;
  }) => EnvironmentOperationReceiptV1;
  readonly settleIntent: (operationId: string, outcomeHash?: Hash) => void;
  readonly retainedSubstrateBinding: () => SubstrateBindingV1 | undefined;
  /** The instance identity a cleanup path may use. */
  readonly instanceHash: () => Hash;
}

/**
 * The emergency branch: attempt every independently safe action **one at a
 * time**, receipt each attempt, and record every unsafe skip with its
 * frontier-derived reason.
 *
 * ## What this replaces
 *
 * The previous implementation issued an unconditional whole-environment
 * `driver.destroy()` *before* consulting the frontier it had just frozen, and
 * then reported every frontier-unsafe resource as `skipped_unsafe` — a claim
 * the destroy had already contradicted (review P1-1). Worse, the fake driver's
 * `destroy` validates ownership of **every** resource before touching any, so a
 * single foreign resource in the frontier made that one call throw: the branch
 * aborted with zero safe actions attempted, no terminal reached and the run's
 * leases still held (review P1-5).
 *
 * ## What it does instead
 *
 * Each independently safe action is attempted inside its own failure boundary,
 * against its own target. A foreign or shared resource now fails, or skips,
 * exactly one action. A driver fault part-way through the sequence does not
 * stop the actions after it. And each action's success is derived by
 * **re-observing the target afterwards**, never from what the receipt claimed.
 *
 * A driver with no per-resource granularity falls back to the conditional
 * whole-environment rule (ADR-ERL2-024 §4.5): the sledgehammer may be swung
 * only when every observed frontier member is an authorized target, so it can
 * never destroy something the derived action set did not authorize.
 */
export function executeFrontierDerivedCleanup(
  ctx: FrontierCleanupContext,
  frontier: EnvironmentResourceFrontierV1,
  trigger: CleanupTrigger,
  emergency: boolean,
): FrontierCleanupOutcome {
  if (emergency) {
    // A cleanup that was interrupted has already appended
    // `op-emergency-cleanup-start`. Re-appending it is a *no-op* — the lifecycle
    // log dedupes by operation id — and a no-op leaves the state where it was,
    // so the terminal append that follows becomes an illegal transition and the
    // run reaches no terminal at all. That is what "continue rather than
    // restart" costs if it is only half done (ADR-ERL2-028 §4.2).
    //
    // The continuation gets its own operation id and its own event type, so the
    // state advances legally and the stream says plainly that this cleanup was
    // resumed rather than begun.
    const resumed = ctx
      .lifecycleEvents()
      .some((event) => event.operation_id === "op-emergency-cleanup-start");
    ctx.appendLifecycle({
      eventType: resumed ? "emergency_cleanup_resumed" : "emergency_cleanup_started",
      stateTo: "emergency_cleanup_started",
      actorId: "operator",
      commandId: "cleanup",
      operationId: resumed ? "op-emergency-cleanup-resume" : "op-emergency-cleanup-start",
      produced: [
        {
          artifact_role: "environment-resource-frontier",
          artifact_core_hash: frontier.core_hash,
          artifact_schema_version: "environment-resource-frontier/v1",
        },
      ],
    });
  }

  const safe = safeActions(frontier);
  const attemptHashes: Hash[] = [];
  const produced: {
    artifact_role: string;
    artifact_core_hash: Hash;
    artifact_schema_version: string;
  }[] = [];
  const attempts: {
    actionId: string;
    succeeded: boolean;
    attemptReceiptHash?: Hash;
    reasonCode?: string;
  }[] = [];

  const record = (receipt: EnvironmentOperationReceiptV1, label: string): Hash => {
    ctx.freezeJson(`${ctx.retainedRoot}/emergency-receipt-${label}.json`, receipt, "INTERNAL");
    if (!attemptHashes.includes(receipt.core_hash)) {
      attemptHashes.push(receipt.core_hash);
      produced.push({
        artifact_role: "emergency-attempt-receipt",
        artifact_core_hash: receipt.core_hash,
        artifact_schema_version: "environment-operation-receipt/v1",
      });
    }
    return receipt.core_hash;
  };

  if (ctx.driver.destroyResource !== undefined) {
    const destroyResource = ctx.driver.destroyResource.bind(ctx.driver);
    for (const action of safe) {
      const operationId = `op-emergency-${action.action_id}`;
      let receiptHash: Hash;
      try {
        receiptHash = record(
          // Under a durable intent like every other external mutation. An
          // emergency action is the most consequential dispatch a run makes
          // and the one most likely to be interrupted, so exempting it would
          // be exempting the case the audit exists for.
          ctx.driverOperation({
            operationId,
            kind: "emergency_action",
            targetIdentity: action.target_resource_id,
            requestHash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
              run_id: ctx.runId,
              action_id: action.action_id,
              target_resource_id: action.target_resource_id,
            }),
            compensation: "retain the target as uncontained residue in the emergency verification",
            dispatch: () =>
              destroyResource({
                runId: ctx.runId,
                resourceId: action.target_resource_id,
                operationId,
              }),
          }),
          action.action_id,
        );
        ctx.settleIntent(operationId, receiptHash);
      } catch (cause) {
        // A driver fault on one action is that action's failure, not the
        // branch's. Without a receipt the contract has nothing to bind the
        // attempt to, so the attempt is recorded against the *frontier* — and
        // `buildEmergencyCleanup` will refuse an attempt with no receipt,
        // which is why the synthetic receipt below exists rather than a bare
        // "it threw".
        receiptHash = record(
          failedActionReceipt(ctx, action.target_resource_id, action.action_id, cause),
          action.action_id,
        );
        attempts.push({
          actionId: action.action_id,
          succeeded: false,
          attemptReceiptHash: receiptHash,
          reasonCode: cause instanceof Erl2Error ? cause.code : "EMERGENCY_ACTION_DRIVER_FAULT",
        });
        continue;
      }
      // Success is an *observation*, not a claim: re-inspect and ask whether
      // the target is actually gone.
      const stillThere = ctx.driver
        .inspect(ctx.runId)
        .resources.some((r) => r.resource_id === action.target_resource_id);
      attempts.push({
        actionId: action.action_id,
        succeeded: !stillThere,
        attemptReceiptHash: receiptHash,
        ...(stillThere ? { reasonCode: "RESOURCE_SURVIVED_EMERGENCY_DESTROY" } : {}),
      });
    }
  } else if (safe.length > 0) {
    // Whole-environment granularity only. It is authorized only when the
    // derived action set covers every observed member — otherwise the single
    // call would affect a target the Lab never authorized, which is exactly
    // what §4.5 refuses.
    const unauthorized = frontier.derived_actions.filter((a) => !a.independently_safe);
    if (unauthorized.length > 0) {
      for (const action of safe) {
        attempts.push({
          actionId: action.action_id,
          succeeded: false,
          attemptReceiptHash: record(
            failedActionReceipt(
              ctx,
              action.target_resource_id,
              action.action_id,
              new Erl2Error(
                CODES.EMERGENCY_ACTION_UNDECLARED_TARGET,
                `driver ${ctx.driver.manifest.driver_id} destroys only whole environments, and ` +
                  `${String(unauthorized.length)} observed resource(s) are not authorized targets`,
              ),
            ),
            action.action_id,
          ),
          reasonCode: CODES.EMERGENCY_ACTION_UNDECLARED_TARGET,
        });
      }
    } else {
      const wholeReceipt = record(
        ctx.driver.destroy({ runId: ctx.runId, operationId: "op-emergency-destroy" }).receipt,
        "whole-environment",
      );
      const remaining = new Set(
        ctx.driver.inspect(ctx.runId).resources.map((r) => r.resource_id),
      );
      for (const action of safe) {
        const stillThere = remaining.has(action.target_resource_id);
        attempts.push({
          actionId: action.action_id,
          succeeded: !stillThere,
          attemptReceiptHash: wholeReceipt,
          ...(stillThere ? { reasonCode: "RESOURCE_SURVIVED_EMERGENCY_DESTROY" } : {}),
        });
      }
    }
  }

  // The substrate is re-observed after the last dispatch, and the observation
  // is *retained* rather than consumed in-process (ADR-ERL2-027 §4.3).
  //
  // Until this contract existed, the only post-cleanup evidence was
  // `remaining_resources`, which the producer derives from its own action
  // outcomes — so an empty residue was unfalsifiable offline, and a resource
  // that vanished with no authorized action was undetectable. The probe closes
  // over the *pre-action* frontier and the *derived* authorized-target set, so
  // an offline reader can reproduce both answers.
  const observedAfter = ctx.driver
    .inspect(ctx.runId)
    .resources.map((r) => ({ resourceId: r.resource_id, identityHash: r.identity_hash }));
  // `assertBoundSubstrate` ran before the frontier was frozen, so a binding
  // exists by the time control reaches here. Re-reading it rather than
  // asserting it is not defensiveness for its own sake: the probe's whole
  // claim is *which substrate was observed*, and a probe that could not name
  // one would be an observation of nowhere.
  const binding = ctx.retainedSubstrateBinding();
  if (binding === undefined) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISSING,
      "cleanup reached the residue probe with no retained substrate binding; the observation " +
        "could not be attributed to any substrate",
      { owner: "lab" },
    );
  }
  const probe = buildResidueProbe({
    runId: ctx.runId,
    substrateBindingHash: binding.core_hash,
    environmentInstanceHash: ctx.instanceHash(),
    resourceFrontierHash: frontier.core_hash,
    observedBefore: frontier.observed_resources.map((r) => ({
      resourceId: r.resource_id,
      identityHash: r.identity_hash,
    })),
    observedAfter,
    // What the Lab *authorized*, not what happened to succeed. An action that
    // was derived safe and then failed still authorized its target, so a
    // target that vanished anyway is accounted for; an action the frontier
    // never derived authorized nothing, which is the case this set exists for.
    authorizedTargets: safe.map((a) => a.target_resource_id),
    probeStatus: "observed",
    probedAt: ctx.now(),
  });
  ctx.freezeJson(`${ctx.retainedRoot}/cleanup-residue-probe.json`, probe, "INTERNAL");

  const stillPresent = new Set(observedAfter.map((r) => r.resourceId));
  // Every resource whose action was skipped or failed must appear here with an
  // explicit containment status: silence is not containment.
  const failedTargets = new Set(
    attempts
      .filter((a) => !a.succeeded)
      .map((a) => frontier.derived_actions.find((d) => d.action_id === a.actionId))
      .filter((d): d is NonNullable<typeof d> => d !== undefined)
      .map((d) => d.target_resource_id),
  );
  const unresolved = new Set([
    ...frontier.derived_actions.filter((a) => !a.independently_safe).map((a) => a.target_resource_id),
    ...failedTargets,
  ]);
  // A frontier that derived no action at all describes a cleanup with nothing
  // to do, and `EmergencyCleanupVerificationV1.actions` has `minItems: 1` — the
  // contract already refuses to describe one. The residue probe is the result
  // in that case, and it is not a weaker record: it is the observation that
  // says the substrate really was empty, which is the claim being made.
  const verification =
    frontier.derived_actions.length === 0
      ? undefined
      : buildEmergencyCleanup({
          runId: ctx.runId,
          environmentInstanceHash: ctx.instanceHash(),
          trigger,
          frontier,
          resourceFrontierEventHash: frontier.core_hash,
          attempts,
          remainingResources: frontier.observed_resources
            .filter((r) => unresolved.has(r.resource_id))
            .map((r) => ({
              kind: r.kind,
              identity_hash: r.identity_hash,
              containment_status: stillPresent.has(r.resource_id)
                ? ("uncontained" as const)
                : ("contained" as const),
            })),
          completedAt: ctx.now(),
        });
  if (verification !== undefined) {
    ctx.freezeJson("retained/emergency-cleanup-verification.json", verification, "INTERNAL");
  }

  const residueProduced = {
    artifact_role: "cleanup-residue-probe",
    artifact_core_hash: probe.core_hash,
    artifact_schema_version: "cleanup-residue-probe/v1",
  };
  const verificationProduced =
    verification === undefined
      ? []
      : [
          {
            artifact_role: "emergency-cleanup-verification",
            artifact_core_hash: verification.core_hash,
            artifact_schema_version: "emergency-cleanup-verification/v1",
          },
        ];
  ctx.appendLifecycle(
    emergency
      ? {
          eventType: "emergency_cleanup_terminal",
          stateTo: "emergency_cleanup_terminal",
          actorId: "operator",
          commandId: "cleanup",
          operationId: "op-emergency-cleanup-terminal",
          produced: [...produced, residueProduced, ...verificationProduced],
        }
      : {
          eventType: "invalid_cleanup_terminal",
          stateTo: "invalid_cleanup_terminal",
          actorId: "operator",
          commandId: "cleanup",
          operationId: "op-invalid-cleanup-terminal",
          produced: [
            // The bounded route has no `*_cleanup_started` event after the
            // frontier is frozen, so the frontier is reached here. It must be
            // reached somewhere: an artifact the lifecycle never produced is an
            // unaccounted retained byte, and the closure derivation rejects it.
            {
              artifact_role: "environment-resource-frontier",
              artifact_core_hash: frontier.core_hash,
              artifact_schema_version: "environment-resource-frontier/v1",
            },
            ...produced,
            residueProduced,
            ...verificationProduced,
          ],
        },
  );
  // Residue is what the substrate reported, not what the action list implies.
  const residue = probe.residual_resources.length;
  // The terminal stays reachable even when cleanup did not complete:
  // `attempted_failed` with retained residue is a *result*, and stranding the
  // run instead would violate ERL2-FR-001.
  return {
    variant: emergency
      ? ("emergency_environment" as const)
      : residue === 0
        ? ("environment" as const)
        : ("partial_environment" as const),
    status: residue === 0 ? "attempted_succeeded" : "attempted_failed",
    attemptHashes,
    resultHash: verification?.core_hash ?? probe.core_hash,
  };
}

/**
 * A Lab-authored receipt for an action the driver could not receipt itself.
 *
 * An attempted action must always carry a receipt (ERL2-FR-025/031), and a
 * driver that throws produces none. Recording the attempt without one would be
 * refused by `buildEmergencyCleanup`; recording *no attempt* would be a
 * silently skipped safe action, which is worse. So the Lab receipts its own
 * failed attempt, marked `failed` with the driver's refusal code, and the
 * before/after state hashes are the Lab's observation rather than the driver's
 * claim.
 */
function failedActionReceipt(
  ctx: FrontierCleanupContext,
  targetResourceId: string,
  actionId: string,
  cause: unknown,
): EnvironmentOperationReceiptV1 {
  const observed = ctx.driver.inspect(ctx.runId).resources.map((r) => r.identity_hash);
  const at = ctx.now();
  const base = {
    schema_version: "environment-operation-receipt/v1" as const,
    run_id: ctx.runId,
    operation: "destroy" as const,
    operation_id: `op-emergency-${actionId}`,
    idempotency_key: coreHash({ run: ctx.runId, action: actionId }).slice("sha256:".length),
    driver_manifest_hash: coreHash(ctx.driver.manifest),
    target_identity_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, {
      run_id: ctx.runId,
      target_resource_id: targetResourceId,
    }),
    before_state_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, { resources: observed }),
    after_state_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, { resources: observed }),
    status: "failed" as const,
    error_code: cause instanceof Erl2Error ? cause.code : CODES.LAB_UNEXPECTED_FAILURE,
    started_at: at,
    ended_at: at,
  };
  return assertContract<EnvironmentOperationReceiptV1>("EnvironmentOperationReceiptV1", {
    ...base,
    core_hash: coreHash(base),
  });
}
