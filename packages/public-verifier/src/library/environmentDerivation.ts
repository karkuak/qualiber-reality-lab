/**
 * Verifier-owned derivation of environment validity and cleanup
 * (ADR-ERL2-024 §4.6, design v2 §14 / ERL2-AC-031/035).
 *
 * ## What the verifier used to do
 *
 * `verifyEnvironmentBundle` checked `attestation.lab_validity !== "valid"`. But
 * `lab_validity` is a **schema constant** — `environmentFinalize.ts` writes
 * `lab_validity: "valid" as const` — so the check is tautological for any
 * well-formed attestation. The retained `EnvironmentValidityResultV1`'s own
 * `status`, and the `passed` fields of `EnvironmentRestorationVerificationV1`
 * and `TeardownVerificationV1`, were hash-linked and role-required but **never
 * inspected**. A terminal whose validity said `invalid` with failed gates, and
 * whose cleanup verdicts were `passed: false`, verified as `valid` (review
 * P1-11 and the P2 cluster).
 *
 * The emergency branch was worse: the verifier accepted a cleanup that *omitted*
 * an independently safe action, and one that *relabelled* a safe action as an
 * unsafe skip — which ERL2-AC-035 explicitly requires be refused (P1-6).
 *
 * ## What it does now
 *
 * Everything below is recomputed from retained bytes and the hash-chained
 * lifecycle, and then compared with what the producer wrote. A producer field
 * is never the source of truth; it is the thing under test.
 *
 * The frontier's own action derivation (`assertFrontierActionsDerivable`) and
 * the ownership/narrowness predicates are shared with the producer on purpose:
 * they are *definitions*, not judgements. What is not shared is every verdict
 * on this page.
 */

import {
  CODES,
  Erl2Error,
  type CleanupResidueProbeV1,
  type EmergencyCleanupVerificationV1,
  type EnvironmentOperationReceiptV1,
  type EnvironmentResourceFrontierV1,
  type EnvironmentRestorationVerificationV1,
  type EnvironmentValidityResultV1,
  type Hash,
  type InvalidLabRunRecordV1,
  type LabLifecycleEventV1,
  type RestorationProbeV1,
  type SubstrateBindingV1,
  type TeardownVerificationV1,
} from "@erl2/contracts";
import {
  assertFrontierActionsDerivable,
  deriveResidueProbeOutcome,
  deriveRestorationProbeOutcome,
  gateForInvalidFailurePhase,
  isEnvironmentFailurePhase,
  restorationProbePassed,
  safeActions,
} from "@erl2/core";
import { coreHash } from "@erl2/integrity";
import type { ArtifactIndex } from "./artifactIndex.js";

/** Roles a lifecycle produced, by role name. */
function rolesOf(events: readonly LabLifecycleEventV1[]): Map<string, Hash[]> {
  const roles = new Map<string, Hash[]>();
  for (const event of events) {
    for (const produced of event.produced) {
      const bucket = roles.get(produced.artifact_role) ?? [];
      bucket.push(produced.artifact_core_hash);
      roles.set(produced.artifact_role, bucket);
    }
  }
  return roles;
}

function single(roles: Map<string, Hash[]>, role: string): Hash | undefined {
  const found = roles.get(role) ?? [];
  return found.length === 1 ? found[0] : undefined;
}

// -- 1. substrate binding ----------------------------------------------------

export interface SubstrateBindingReport {
  readonly binding: SubstrateBindingV1;
  readonly substrateInstanceHash: Hash;
}

/**
 * Re-derives the run's substrate binding and cross-checks every identity it
 * claims against the retained artifacts those identities belong to.
 *
 * This is the offline half of P0-1. A bundle whose cleanup verdicts were
 * observed against a substrate other than the one the run bound cannot be
 * detected by any hash check — the artifacts are internally consistent — so the
 * binding has to exist, be signed, be unique, and agree with the driver
 * manifest and archetype the run actually used.
 */
export function assertSubstrateBindingConsistent(options: {
  readonly index: ArtifactIndex;
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly runId: string;
}): SubstrateBindingReport {
  const roles = rolesOf(options.lifecycle);
  const bindings = roles.get("substrate-binding") ?? [];
  if (bindings.length === 0) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISSING,
      "this environment terminal names no substrate binding; its cleanup verdicts cannot be " +
        "attributed to any substrate, so they cannot be checked",
    );
  }
  if (bindings.length > 1) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      `a run may bind exactly one substrate; this lifecycle records ${String(bindings.length)}`,
    );
  }
  const binding = options.index.typed<SubstrateBindingV1>(
    bindings[0] as Hash,
    "substrate-binding/v1",
  );
  if (binding.run_id !== options.runId) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      `the substrate binding names run ${binding.run_id}; this terminal is run ${options.runId}`,
    );
  }

  // The driver manifest and the archetype the binding names must be the ones
  // the run actually mirrored. A binding that names a *different* driver is a
  // binding to a substrate this run never operated.
  const driverManifests = options.index.ofSchema("environment-driver-manifest/v1");
  if (driverManifests.length !== 1) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      `an environment terminal must retain exactly one driver manifest for its binding to be ` +
        `checkable; found ${String(driverManifests.length)}`,
    );
  }
  const driverManifest = driverManifests[0] as { coreHash: Hash; value: Record<string, unknown> };
  if (binding.driver_manifest_hash !== driverManifest.coreHash) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      "the substrate binding names a driver manifest other than the one this run retained",
    );
  }
  if (binding.driver_id !== driverManifest.value["driver_id"]) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      "the substrate binding's driver id does not match the retained driver manifest",
    );
  }
  const archetypes = options.index.ofSchema("environment-archetype/v1");
  if (archetypes.length !== 1 || (archetypes[0] as { coreHash: Hash }).coreHash !== binding.archetype_hash) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
      "the substrate binding names an archetype other than the one this run retained",
    );
  }

  // Every driver receipt this run retained was produced against a substrate;
  // they must all be the same run's, and their driver manifest must be the
  // bound one. A receipt citing a different driver is a receipt from elsewhere.
  for (const artifact of options.index.ofSchema("environment-operation-receipt/v1")) {
    const receipt = artifact.value as unknown as EnvironmentOperationReceiptV1;
    if (receipt.run_id !== options.runId) {
      throw new Erl2Error(
        CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
        `a retained environment operation receipt belongs to run ${receipt.run_id}`,
      );
    }
    if (receipt.driver_manifest_hash !== binding.driver_manifest_hash) {
      throw new Erl2Error(
        CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
        `a retained environment operation receipt cites driver manifest ` +
          `${receipt.driver_manifest_hash}, which is not the substrate binding's`,
      );
    }
  }

  return { binding, substrateInstanceHash: binding.substrate_instance_hash };
}

// -- 2. restoration ----------------------------------------------------------

/**
 * Re-derives whether restoration passed.
 *
 * Two independent grounds, checked separately because they catch different lies:
 *
 *  1. **the baselines and the residue** — a drifted after-baseline or any
 *     residual resource means the environment did not return to its baseline;
 *  2. **the compensation receipts' own statuses** — a driver that reports
 *     `status: "failed"` while leaving the environment measuring identically
 *     produced `passed: true` over mutations it never reverted (ADR-ERL2-022 §5,
 *     review P1-4). The receipts are cited by the restoration, so the verifier
 *     can read them; it must.
 *
 * A restoration that claims `passed: true` on either ground being false is
 * refused, and so is one that claims `false` while the evidence says otherwise —
 * a producer must not be able to under-claim its way past a gate either.
 */
export function deriveRestorationOutcome(options: {
  readonly index: ArtifactIndex;
  readonly restoration: EnvironmentRestorationVerificationV1;
  /**
   * The independent post-compensation observation, from the lifecycle's
   * `restoration-probe` role.
   *
   * Absent only on the pre-ADR-ERL2-026 synthetic fixtures, which never reached
   * a *valid* terminal; `deriveEnvironmentSemantics` requires it for one that
   * did. Passing it separately keeps this function usable by the invalid-record
   * pass, where a probe may legitimately not exist because the run never got
   * that far.
   */
  readonly probe?: RestorationProbeV1;
  /** Hashes the lifecycle produced under the `mutation-receipt` role. */
  readonly mutationReceiptHashes?: readonly Hash[];
  /** The one substrate binding this run froze, when the caller holds it. */
  readonly substrateBindingHash?: Hash;
}): { readonly passed: boolean } {
  const { restoration } = options;
  const baselinesAgree = restoration.baseline_after_hash === restoration.baseline_before_hash;
  const noResidue = restoration.residual_resources.length === 0;

  if (restoration.compensation_receipt_hashes.length === 0) {
    throw new Erl2Error(
      CODES.RESTORATION_FAILED,
      "a restoration verification cites no compensation receipt; a compensation that left no " +
        "receipt cannot be distinguished from one that never ran",
    );
  }
  if (
    new Set(restoration.compensation_receipt_hashes).size !==
    restoration.compensation_receipt_hashes.length
  ) {
    // One receipt cited twice is one compensation counted twice, which is how a
    // restoration that covered half its mutations comes to look complete.
    throw new Erl2Error(
      CODES.RESTORATION_FAILED,
      "a restoration verification cites the same compensation receipt more than once",
    );
  }
  let everyCompensationSucceeded = true;
  for (const hash of restoration.compensation_receipt_hashes) {
    const receipt = options.index.typed<EnvironmentOperationReceiptV1>(
      hash,
      "environment-operation-receipt/v1",
    );
    if (receipt.run_id !== restoration.run_id) {
      throw new Erl2Error(
        CODES.RESTORATION_FAILED,
        "a restoration cites a compensation receipt belonging to another run",
      );
    }
    if (receipt.operation !== "restore") {
      throw new Erl2Error(
        CODES.RESTORATION_FAILED,
        `a restoration cites a ${receipt.operation} receipt as its compensation`,
      );
    }
    if (receipt.status !== "succeeded") everyCompensationSucceeded = false;
  }

  const probeSaysReverted =
    options.probe === undefined
      ? true
      : deriveRestorationProbe({
          index: options.index,
          restoration,
          probe: options.probe,
          mutationReceiptHashes: options.mutationReceiptHashes ?? [],
          ...(options.substrateBindingHash === undefined
            ? {}
            : { substrateBindingHash: options.substrateBindingHash }),
        });

  const derived = baselinesAgree && noResidue && everyCompensationSucceeded && probeSaysReverted;
  if (derived !== restoration.passed) {
    throw new Erl2Error(
      CODES.RESTORATION_FAILED,
      `the retained restoration declares passed=${String(restoration.passed)}, but the verifier ` +
        `derives ${String(derived)} from its baselines (${
          baselinesAgree ? "agree" : "drifted"
        }), residue (${String(restoration.residual_resources.length)}), compensation receipts ` +
        `(${everyCompensationSucceeded ? "all succeeded" : "at least one failed"}) and the ` +
        `post-compensation probe (${probeSaysReverted ? "reverted" : "did not revert"})`,
    );
  }
  return { passed: derived };
}

/**
 * Re-derives the independent post-compensation observation (ADR-ERL2-026 §7).
 *
 * The outcome arithmetic itself is shared with the producer — it is set
 * difference over two retained arrays, a definition rather than a judgement, on
 * the same terms ADR-ERL2-024 §7.2 already shares `safeActions`. Everything
 * *around* it is verifier-owned and is what this function exists for:
 *
 *  - the probe is this run's, over this run's substrate binding;
 *  - it settles the compensation the restoration actually cites, not another
 *    operation whose receipt happens to read `succeeded`;
 *  - its expected mutation set corresponds one-for-one to the retained
 *    `mutation-receipt` set, so a probe cannot name a smaller set than the run
 *    mutated, a different mutation, or none at all;
 *  - each expected entry names the target its own receipt named;
 *  - the retained `outcome` is the one the observations derive.
 *
 * Returns whether the probe supports restoration; every other failure is a
 * refusal, because it means the probe is not about this compensation at all.
 */
function deriveRestorationProbe(options: {
  readonly index: ArtifactIndex;
  readonly restoration: EnvironmentRestorationVerificationV1;
  readonly probe: RestorationProbeV1;
  readonly mutationReceiptHashes: readonly Hash[];
  readonly substrateBindingHash?: Hash;
}): boolean {
  const { probe, restoration } = options;
  if (probe.run_id !== restoration.run_id) {
    throw new Erl2Error(
      CODES.RESTORATION_PROBE_MISSING,
      `the restoration probe names run ${probe.run_id}; the restoration is run ${restoration.run_id}`,
    );
  }
  if (
    options.substrateBindingHash !== undefined &&
    probe.substrate_binding_hash !== options.substrateBindingHash
  ) {
    // An observation of another substrate says nothing about this one, and the
    // binding is the only thing that names which substrate was observed at all.
    throw new Erl2Error(
      CODES.RESTORATION_PROBE_MISSING,
      `the restoration probe names substrate binding ${probe.substrate_binding_hash}; this run ` +
        `bound ${options.substrateBindingHash}`,
    );
  }
  if (!restoration.compensation_receipt_hashes.includes(probe.compensation_receipt_hash)) {
    throw new Erl2Error(
      CODES.RESTORATION_PROBE_MISSING,
      "the restoration probe observed a compensation the restoration does not cite; an observation " +
        "of another operation says nothing about this one",
    );
  }
  const receipt = options.index.typed<EnvironmentOperationReceiptV1>(
    probe.compensation_receipt_hash,
    "environment-operation-receipt/v1",
  );
  if (receipt.operation_id !== probe.compensation_operation_id) {
    throw new Erl2Error(
      CODES.RESTORATION_PROBE_MISSING,
      `the restoration probe claims to observe operation ${probe.compensation_operation_id}, but ` +
        `the receipt it cites settles ${receipt.operation_id}`,
    );
  }
  if (probe.environment_instance_hash !== restoration.environment_instance_hash) {
    throw new Erl2Error(
      CODES.RESTORATION_PROBE_MISSING,
      "the restoration probe observed a different environment instance than the restoration verifies",
    );
  }

  // The expected set is the retained mutation-receipt set, exactly.
  const expectedByReceipt = new Map(
    probe.expected_reverted_mutations.map((entry) => [entry.mutation_receipt_hash, entry]),
  );
  if (expectedByReceipt.size !== probe.expected_reverted_mutations.length) {
    throw new Erl2Error(
      CODES.RESTORATION_PROBE_MISSING,
      "the restoration probe names the same mutation receipt twice",
    );
  }
  const retained = new Set(options.mutationReceiptHashes);
  for (const hash of retained) {
    if (!expectedByReceipt.has(hash)) {
      throw new Erl2Error(
        CODES.RESTORATION_PROBE_MISSING,
        `the restoration probe does not name mutation receipt ${hash}, which this run retained; a ` +
          `compensation that does not cover every applied mutation did not restore the environment`,
      );
    }
  }
  for (const [hash, entry] of expectedByReceipt) {
    if (!retained.has(hash)) {
      throw new Erl2Error(
        CODES.RESTORATION_PROBE_MISSING,
        `the restoration probe names mutation receipt ${hash}, which this run never retained`,
      );
    }
    const mutation = options.index.typed<EnvironmentOperationReceiptV1>(
      hash,
      "environment-operation-receipt/v1",
    );
    if (mutation.target_identity_hash !== entry.target_identity_hash) {
      throw new Erl2Error(
        CODES.RESTORATION_PROBE_MISSING,
        `the restoration probe names target ${entry.target_identity_hash} for mutation ` +
          `${entry.mutation_id}; its own receipt names ${mutation.target_identity_hash}`,
      );
    }
  }

  const verdict = deriveRestorationProbeOutcome({
    expected: probe.expected_reverted_mutations.map((entry) => ({
      mutationId: entry.mutation_id,
      mutationReceiptHash: entry.mutation_receipt_hash,
      targetIdentityHash: entry.target_identity_hash,
    })),
    observedBefore: probe.observed_before,
    observedAfter: probe.observed_after,
    probeStatus: probe.probe_status,
  });
  if (verdict.outcome !== probe.outcome) {
    throw new Erl2Error(
      CODES.RESTORATION_NOT_INDEPENDENTLY_OBSERVED,
      `the retained restoration probe declares outcome ${probe.outcome}, but its own observations ` +
        `derive ${verdict.outcome}`,
    );
  }
  return restorationProbePassed(probe.outcome);
}

// -- 3. teardown -------------------------------------------------------------

/**
 * Re-derives whether teardown passed, from the residue each inspection recorded.
 *
 * `residue_count` is recomputed from `residue_hashes` rather than believed: the
 * producer computes it the same way, and a mismatch means one of the two was
 * edited.
 */
export function deriveTeardownOutcome(teardown: TeardownVerificationV1): { readonly passed: boolean } {
  if (teardown.checks.length === 0) {
    throw new Erl2Error(
      CODES.RESIDUE_DETECTED,
      "a teardown verification with no residue inspection proves nothing",
    );
  }
  for (const check of teardown.checks) {
    if (check.residue_count !== check.residue_hashes.length) {
      throw new Erl2Error(
        CODES.RESIDUE_DETECTED,
        `teardown check ${check.selector} declares ${String(check.residue_count)} residual ` +
          `resources and lists ${String(check.residue_hashes.length)}`,
      );
    }
  }
  const derived = teardown.checks.every((check) => check.residue_hashes.length === 0);
  if (derived !== teardown.passed) {
    throw new Erl2Error(
      CODES.TEARDOWN_FAILED,
      `the retained teardown declares passed=${String(teardown.passed)}, but its own residue ` +
        `observations derive ${String(derived)}`,
    );
  }
  return { passed: derived };
}

// -- 4. emergency cleanup ----------------------------------------------------

/**
 * Recomputes the expected emergency action set from the frontier and refuses
 * every way a cleanup can misreport it.
 *
 * ERL2-AC-035 requires refusal of an omitted safe action and of a safe action
 * relabelled as an unsafe skip. Both verified as `valid` before this pass
 * existed (review P1-6). The frontier's own action derivation is recomputed
 * first — a frontier that declares an action its observed resources do not
 * imply is refused before its actions are used as the expectation.
 */
export function deriveEmergencyCleanup(options: {
  readonly index: ArtifactIndex;
  readonly frontier: EnvironmentResourceFrontierV1;
  readonly cleanup: EmergencyCleanupVerificationV1;
  /**
   * Hashes of the lifecycle events that produced this frontier, when the caller
   * holds the lifecycle.
   *
   * `resource_frontier_event_hash` is named for an *event* and the shipped
   * producer fills it with the frontier's own core hash. Both readings bind the
   * cleanup to the same frozen frontier, and both are represented in retained
   * evidence, so the verifier accepts either — and only either. An unrelated
   * hash is still refused, which is the property the field exists for.
   */
  readonly frontierEventHashes?: readonly Hash[];
}): { readonly complete: boolean; readonly residualCount: number } {
  const { frontier, cleanup } = options;
  // The expectation is only as good as the frontier it comes from.
  assertFrontierActionsDerivable(frontier);

  const boundTo = new Set<Hash>([frontier.core_hash, ...(options.frontierEventHashes ?? [])]);
  if (!boundTo.has(cleanup.resource_frontier_event_hash)) {
    throw new Erl2Error(
      CODES.EMERGENCY_CLEANUP_INCOMPLETE,
      "the emergency cleanup cites a resource frontier other than the one this run froze",
    );
  }
  if (cleanup.run_id !== frontier.run_id) {
    throw new Erl2Error(
      CODES.EMERGENCY_CLEANUP_INCOMPLETE,
      "the emergency cleanup and its frontier belong to different runs",
    );
  }

  const derivedById = new Map(frontier.derived_actions.map((a) => [a.action_id, a]));
  const reportedById = new Map(cleanup.actions.map((a) => [a.action_id, a]));

  // Nothing may be reported that the frontier never derived.
  for (const reported of cleanup.actions) {
    if (!derivedById.has(reported.action_id)) {
      throw new Erl2Error(
        CODES.EMERGENCY_ACTION_RECEIPT_MISSING,
        `emergency cleanup reports action ${reported.action_id}, which the frontier never derived`,
      );
    }
  }

  const expectedSafe = new Set(safeActions(frontier).map((a) => a.action_id));
  for (const action of frontier.derived_actions) {
    const reported = reportedById.get(action.action_id);
    if (reported === undefined) {
      throw new Erl2Error(
        expectedSafe.has(action.action_id)
          ? CODES.EMERGENCY_ACTION_SAFE_ACTION_SKIPPED
          : CODES.EMERGENCY_CLEANUP_INCOMPLETE,
        `emergency cleanup omits ${
          expectedSafe.has(action.action_id) ? "the independently safe" : "the"
        } action ${action.action_id} the frontier derived`,
      );
    }
    // A safe action relabelled as an unsafe skip is the second half of
    // ERL2-AC-035, and it is the cheaper lie: it needs no receipt.
    if (reported.independently_safe !== action.independently_safe) {
      throw new Erl2Error(
        CODES.EMERGENCY_ACTION_SAFE_ACTION_SKIPPED,
        `emergency cleanup reports action ${action.action_id} as ` +
          `${reported.independently_safe ? "safe" : "unsafe"}, but the verifier derives it as ` +
          `${action.independently_safe ? "safe" : "unsafe"} from the observed resource`,
      );
    }
    if (reported.kind !== action.kind) {
      throw new Erl2Error(
        CODES.EMERGENCY_ACTION_SAFE_ACTION_SKIPPED,
        `emergency cleanup reports action ${action.action_id} as kind ${reported.kind}; the ` +
          `frontier derives ${action.kind}`,
      );
    }

    if (!action.independently_safe) {
      if (reported.status !== "skipped_unsafe") {
        throw new Erl2Error(
          CODES.EMERGENCY_ACTION_SAFE_ACTION_SKIPPED,
          `action ${action.action_id} is not independently safe; it may only be skipped`,
        );
      }
      // The union's `skipped_unsafe` variant has no receipt field at all, so a
      // skip carrying one is already a schema refusal. Read defensively anyway:
      // this pass also runs over documents that reached the verifier by other
      // routes, and "the schema would have caught it" is not a check.
      if ((reported as { attempt_receipt_hash?: unknown }).attempt_receipt_hash !== undefined) {
        throw new Erl2Error(
          CODES.EMERGENCY_ACTION_RECEIPT_MISSING,
          `action ${action.action_id} is recorded as skipped but carries an attempt receipt; a ` +
            `skip that produced a receipt is not a skip`,
        );
      }
      if (reported.reason_code !== action.unsafe_reason_code) {
        throw new Erl2Error(
          CODES.EMERGENCY_ACTION_RECEIPT_MISSING,
          `action ${action.action_id} is skipped with reason ${String(reported.reason_code)}; ` +
            `the frontier derives ${String(action.unsafe_reason_code)}`,
        );
      }
      continue;
    }

    // Independently safe: attempted, and receipted whether it worked or not.
    if (reported.status === "skipped_unsafe") {
      throw new Erl2Error(
        CODES.EMERGENCY_ACTION_SAFE_ACTION_SKIPPED,
        `independently safe action ${action.action_id} was not attempted`,
      );
    }
    if (reported.attempt_receipt_hash === undefined) {
      throw new Erl2Error(
        CODES.EMERGENCY_ACTION_RECEIPT_MISSING,
        `attempted action ${action.action_id} carries no attempt receipt`,
      );
    }
    // The receipt must be retained and must be this run's: a cleanup that cites
    // a receipt from another run's substrate is the substitution again.
    const receipt = options.index.typed<EnvironmentOperationReceiptV1>(
      reported.attempt_receipt_hash,
      "environment-operation-receipt/v1",
    );
    if (receipt.run_id !== cleanup.run_id) {
      throw new Erl2Error(
        CODES.EMERGENCY_ACTION_RECEIPT_MISSING,
        `action ${action.action_id} cites an attempt receipt belonging to run ${receipt.run_id}`,
      );
    }
    if (reported.status === "failed" && reported.reason_code === undefined) {
      throw new Erl2Error(
        CODES.EMERGENCY_ACTION_RECEIPT_MISSING,
        `failed action ${action.action_id} has a receipt but no reason`,
      );
    }
  }

  // Every unresolved action's target must be accounted for in the residue, with
  // an explicit containment status. Silence is not containment.
  const byActionId = new Map(frontier.derived_actions.map((a) => [a.action_id, a.target_resource_id]));
  const identityOf = new Map(frontier.observed_resources.map((r) => [r.resource_id, r.identity_hash]));
  const declared = new Set(cleanup.remaining_resources.map((r) => r.identity_hash));
  for (const reported of cleanup.actions) {
    if (reported.status === "succeeded") continue;
    const resourceId = byActionId.get(reported.action_id);
    const identity = resourceId === undefined ? undefined : identityOf.get(resourceId);
    if (identity !== undefined && !declared.has(identity)) {
      throw new Erl2Error(
        CODES.RESIDUE_DETECTED,
        `emergency cleanup leaves ${reported.action_id} unresolved but does not account for its ` +
          `target in the post-cleanup residue`,
      );
    }
  }

  return {
    complete: cleanup.remaining_resources.length === 0,
    residualCount: cleanup.remaining_resources.length,
  };
}

// -- 4a. the independently observed residue ----------------------------------

/**
 * Re-derives the post-cleanup observation and everything it makes checkable
 * (ADR-ERL2-027 §4.3/§4.6).
 *
 * Before this contract existed the only post-cleanup evidence was
 * `EmergencyCleanupVerificationV1.remaining_resources`, which the producer
 * derives from its own action outcomes. Two lies were therefore unfalsifiable
 * offline:
 *
 *  - **an empty residue**, because a cleanup that marked every action
 *    `succeeded` produced one and the residue cross-check is vacuous when
 *    nothing is unresolved;
 *  - **an unauthorized destruction**, because a post-cleanup inventory cannot
 *    distinguish a resource destroyed *because the Lab authorized it* from one
 *    destroyed anyway — it is absent in both (review P1-1).
 *
 * The expectation is rebuilt here from the *pre-action* frontier and from
 * `safeActions`, never from the probe's own `authorized_targets`: a probe that
 * writes its own authorization would authorize whatever it destroyed.
 */
export function deriveResidueProbe(options: {
  readonly probe: CleanupResidueProbeV1;
  readonly frontier: EnvironmentResourceFrontierV1;
  readonly runId: string;
  readonly substrateBindingHash?: Hash;
}): { readonly residual: readonly string[] } {
  const { probe, frontier } = options;

  if (probe.run_id !== options.runId) {
    throw new Erl2Error(
      CODES.RESIDUE_PROBE_MISSING,
      `the cleanup residue probe names run ${probe.run_id}; this terminal is run ${options.runId}`,
    );
  }
  if (
    options.substrateBindingHash !== undefined &&
    probe.substrate_binding_hash !== options.substrateBindingHash
  ) {
    // An observation of another substrate says nothing about this one, and the
    // binding is the only thing that names which substrate was observed at all.
    throw new Erl2Error(
      CODES.RESIDUE_PROBE_MISSING,
      `the cleanup residue probe names substrate binding ${probe.substrate_binding_hash}; this run ` +
        `bound ${options.substrateBindingHash}`,
    );
  }
  if (probe.resource_frontier_hash !== frontier.core_hash) {
    throw new Erl2Error(
      CODES.RESIDUE_PROBE_MISSING,
      "the cleanup residue probe closes over a resource frontier other than the one this run froze",
    );
  }

  // `observed_before` must be the frontier's own observation. This is what stops
  // a probe assembled over an inventory taken *after* a destruction: such a probe
  // would show nothing missing, because the destruction already happened before
  // its "before".
  const frontierResources = new Map(
    frontier.observed_resources.map((r) => [r.resource_id, r.identity_hash]),
  );
  const probeBefore = new Map(probe.observed_before.map((r) => [r.resource_id, r.identity_hash]));
  if (probeBefore.size !== probe.observed_before.length) {
    throw new Erl2Error(
      CODES.RESIDUE_PROBE_MISSING,
      "the cleanup residue probe observes the same resource twice before cleanup",
    );
  }
  for (const [resourceId, identity] of frontierResources) {
    const observed = probeBefore.get(resourceId);
    if (observed === undefined) {
      throw new Erl2Error(
        CODES.RESIDUE_PROBE_MISSING,
        `the cleanup residue probe does not observe resource ${resourceId}, which the pre-action ` +
          `frontier did; a probe that starts from a smaller world cannot see what left it`,
      );
    }
    if (observed !== identity) {
      throw new Erl2Error(
        CODES.RESIDUE_PROBE_MISSING,
        `the cleanup residue probe gives resource ${resourceId} identity ${observed}; the frontier ` +
          `observed ${identity}`,
      );
    }
  }
  for (const resourceId of probeBefore.keys()) {
    if (!frontierResources.has(resourceId)) {
      throw new Erl2Error(
        CODES.RESIDUE_PROBE_MISSING,
        `the cleanup residue probe observes resource ${resourceId} before cleanup, which the ` +
          `pre-action frontier never did`,
      );
    }
  }

  // The authorization is re-derived from the frontier, not read from the probe.
  const derivedAuthorized = [...new Set(safeActions(frontier).map((a) => a.target_resource_id))].sort();
  const declaredAuthorized = [...new Set(probe.authorized_targets)].sort();
  if (derivedAuthorized.join(" ") !== declaredAuthorized.join(" ")) {
    throw new Erl2Error(
      CODES.EMERGENCY_ACTION_UNDECLARED_TARGET,
      `the cleanup residue probe claims authorization over [${declaredAuthorized.join(", ")}]; the ` +
        `frontier derives [${derivedAuthorized.join(", ")}]`,
    );
  }

  const verdict = deriveResidueProbeOutcome({
    observedBefore: probe.observed_before.map((r) => ({
      resourceId: r.resource_id,
      identityHash: r.identity_hash,
    })),
    observedAfter: probe.observed_after.map((r) => ({
      resourceId: r.resource_id,
      identityHash: r.identity_hash,
    })),
    authorizedTargets: derivedAuthorized,
    probeStatus: probe.probe_status,
  });
  if (verdict.outcome !== probe.outcome) {
    throw new Erl2Error(
      CODES.RESIDUE_PROBE_MISSING,
      `the retained cleanup residue probe declares outcome ${probe.outcome}, but its own ` +
        `observations derive ${verdict.outcome}`,
    );
  }
  if (verdict.residual.join(" ") !== [...probe.residual_resources].join(" ")) {
    throw new Erl2Error(
      CODES.RESIDUE_PROBE_MISSING,
      "the cleanup residue probe's residual set is not the one its observations derive",
    );
  }
  if (
    verdict.undeclaredDestroyed.join(" ") !==
    [...probe.undeclared_destroyed_resources].join(" ")
  ) {
    throw new Erl2Error(
      CODES.RESIDUE_PROBE_MISSING,
      "the cleanup residue probe's undeclared-destruction set is not the one its observations derive",
    );
  }

  if (verdict.outcome === "undeclared_destruction") {
    throw new Erl2Error(
      CODES.RESIDUE_UNDECLARED_DESTRUCTION,
      `cleanup destroyed [${verdict.undeclaredDestroyed.join(", ")}], which the frontier-derived ` +
        `action set never authorized; a resource the Lab did not authorize an action against must ` +
        `still be there`,
    );
  }
  if (verdict.outcome === "unobservable") {
    throw new Erl2Error(
      CODES.RESIDUE_PROBE_MISSING,
      "the substrate could not be re-observed after cleanup; a cleanup nobody observed cannot be " +
        "recorded as one that happened",
    );
  }

  return { residual: verdict.residual };
}

/**
 * Cross-checks each reported action against the substrate as it was actually
 * observed afterwards.
 *
 * Separate from `deriveEmergencyCleanup` because it answers a different
 * question: that function asks whether the *action list* corresponds to the
 * frontier, and this one asks whether the action list corresponds to the
 * *world*. A cleanup can satisfy the first completely and still report a success
 * over a resource that is still sitting there.
 */
export function assertActionsAgreeWithResidue(options: {
  readonly cleanup: EmergencyCleanupVerificationV1;
  readonly frontier: EnvironmentResourceFrontierV1;
  readonly probe: CleanupResidueProbeV1;
}): void {
  const { cleanup, frontier, probe } = options;
  const targetOf = new Map(frontier.derived_actions.map((a) => [a.action_id, a.target_resource_id]));
  const present = new Set(probe.observed_after.map((r) => r.resource_id));

  for (const action of cleanup.actions) {
    const target = targetOf.get(action.action_id);
    if (target === undefined) continue;
    const stillThere = present.has(target);
    if (action.status === "succeeded" && stillThere) {
      throw new Erl2Error(
        CODES.EMERGENCY_CLEANUP_INCOMPLETE,
        `emergency action ${action.action_id} is recorded as succeeded, but its target ${target} is ` +
          `still present in the post-cleanup observation`,
      );
    }
    if (action.status === "failed" && !stillThere) {
      // The target was authorized, so its absence is not an *undeclared*
      // destruction — but an action that reports failing to remove a resource
      // that is gone is not describing what happened either.
      throw new Erl2Error(
        CODES.EMERGENCY_CLEANUP_INCOMPLETE,
        `emergency action ${action.action_id} is recorded as failed, but its target ${target} is ` +
          `absent from the post-cleanup observation`,
      );
    }
  }

  // `remaining_resources` is producer-derived; the probe is observed. They must
  // name the same survivors, which is what makes a fabricated empty residue a
  // refusal rather than an unfalsifiable claim.
  const identityOf = new Map(frontier.observed_resources.map((r) => [r.resource_id, r.identity_hash]));
  const observedResidue = new Set(
    probe.residual_resources
      .map((id) => identityOf.get(id))
      .filter((h): h is Hash => h !== undefined),
  );
  const declaredResidue = new Set(cleanup.remaining_resources.map((r) => r.identity_hash));
  for (const identity of observedResidue) {
    if (!declaredResidue.has(identity)) {
      throw new Erl2Error(
        CODES.RESIDUE_DETECTED,
        `the post-cleanup observation still sees ${identity}, which the cleanup verification does ` +
          `not account for in its remaining resources`,
      );
    }
  }
  for (const identity of declaredResidue) {
    if (!observedResidue.has(identity)) {
      throw new Erl2Error(
        CODES.RESIDUE_DETECTED,
        `the cleanup verification reports ${identity} as remaining, but the post-cleanup ` +
          `observation does not see it`,
      );
    }
  }
}

// -- 4b. Lab attribution on an invalid environment terminal ------------------

/**
 * Refuses an invalid environment terminal whose primary finding names the wrong
 * gate, or attributes a Lab environment failure to the subject
 * (ADR-ERL2-027 §4.5).
 *
 * The gate map is re-applied here from the record's **own** `failed_phase`, so
 * the producer's choice is the thing under test rather than the input. It used to
 * be keyed on the cleanup branch: a provisioning failure named
 * `environment-baseline-clean`, a gate belonging to a later phase that the run
 * never evaluated, and every structural check passed over it.
 *
 * Attribution is checked because an invalid environment terminal is a statement
 * about the **Lab's own** environment. A subject cannot be scored for the Lab
 * failing to provision, restore or tear down, and the closed finding union
 * carries the fields that say so — they were simply never required.
 */
export function assertInvalidFindingAttribution(options: {
  readonly index: ArtifactIndex;
  readonly record: InvalidLabRunRecordV1;
}): void {
  const { record } = options;
  if (record.terminal_reason.kind !== "classified_failure") return;
  // A cancellation is an operator's decision rather than the falsification of a
  // gate, so it has no expected gate to check. Both *failing* kinds do, and the
  // journey-execution one is checked here rather than skipped: an ambiguous
  // subject dispatch reaches its terminal through that member (ADR-ERL2-028 §5.2),
  // and it is precisely the terminal on which a producer might be tempted to blame
  // the subject for an outcome nobody observed.
  if (record.failed_phase.kind === "cancellation") return;
  if (
    record.failed_phase.kind === "lifecycle_phase" &&
    !isEnvironmentFailurePhase(record.failed_phase.phase)
  ) {
    return;
  }
  const expectedGate = gateForInvalidFailurePhase(record.failed_phase);
  if (expectedGate === undefined) return;

  const finding = options.index.get(record.terminal_reason.primary_finding_hash).value;

  if (finding["owner"] !== "lab") {
    throw new Erl2Error(
      CODES.INVALID_REASON_FABRICATED_FINDING,
      `this terminal's primary finding is owned by ${String(finding["owner"])}; an invalid ` +
        `environment terminal is a statement about the Lab's own environment and cannot be owned ` +
        `by anyone else`,
    );
  }
  if (finding["subject_attribution_proven"] === true) {
    throw new Erl2Error(
      CODES.INVALID_REASON_FABRICATED_FINDING,
      "this terminal's primary finding claims proven subject attribution for an environment " +
        "failure the Lab owns",
    );
  }
  const planes = (finding["scoreable_planes"] as readonly unknown[] | undefined) ?? [];
  if (planes.length > 0) {
    throw new Erl2Error(
      CODES.INVALID_REASON_FABRICATED_FINDING,
      `this terminal's primary finding declares ${String(planes.length)} scoreable plane(s); a Lab ` +
        `environment failure is not scored against the subject on any plane`,
    );
  }

  const named = (finding["failed_gate_ids"] as readonly string[] | undefined) ?? [];
  if (named.length !== 1 || named[0] !== expectedGate) {
    const phaseLabel =
      record.failed_phase.kind === "lifecycle_phase"
        ? record.failed_phase.phase
        : `journey_execution (${record.failed_phase.failed_intent})`;
    throw new Erl2Error(
      CODES.INVALID_REASON_PHASE_MISMATCH,
      `this terminal failed in phase ${phaseLabel}, which falsifies gate ` +
        `${expectedGate}; its primary finding names [${named.join(", ")}]`,
    );
  }
}

// -- 4c. Journey ordering, re-derived from the lifecycle ----------------------

/**
 * The design's post-capture intents, and the event prefix each one emits.
 *
 * Held here rather than imported from `@erl2/core` for the reason every other
 * derivation in this file is: the verifier must not share the producer's decision
 * about what a post-capture intent *is*. It shares only hashing and schema
 * validation (ADR-ERL2-024 §4.6).
 */
const POST_CAPTURE_EVENT_PREFIXES: readonly string[] = [
  "subject_interaction", // exercise
  "subject_observation", // observe
  "subject_diagnosis", // diagnose_decide
  "subject_recovery", // recover
  "subject_upgrade", // upgrade
  "subject_rollback", // rollback
  "subject_uninstall", // remove
];

/**
 * Refuses a run whose lifecycle shows a post-capture journey step starting before
 * the challenge was activated, or before the evidence cutoff was realized
 * (review P1-9, ADR-ERL2-028 §2).
 *
 * Derived from the hash-chained event order alone, so it holds for any producer.
 * The producer-side matrix is the primary guard; this is the half an offline
 * reader can check without trusting it, and without it a bundle produced by an
 * older or patched Lab would still verify `valid` — which is exactly what P1-9's
 * reproduction did.
 */
export function assertJourneyOrderingFromLifecycle(
  events: readonly { readonly event_type: string }[],
): void {
  const indexOf = (type: string): number => events.findIndex((event) => event.event_type === type);
  const activatedAt = indexOf("challenge_activated");
  const cutoffAt = indexOf("evidence_cutoff_realized");

  for (const [position, event] of events.entries()) {
    const prefix = POST_CAPTURE_EVENT_PREFIXES.find((candidate) =>
      event.event_type.startsWith(`${candidate}_`),
    );
    if (prefix === undefined) continue;
    // `_planned` is the first event of a step occurrence, so it is the one that
    // dates the step. Using a later one would let an out-of-order step hide behind
    // its own completion event.
    if (!event.event_type.endsWith("_planned")) continue;
    if (activatedAt < 0 || position < activatedAt) {
      throw new Erl2Error(
        CODES.POLICY_CONFLICT,
        `${event.event_type} occurs before the challenge was activated; a post-capture journey ` +
          `step may not run before activation`,
      );
    }
    if (cutoffAt < 0 || position < cutoffAt) {
      throw new Erl2Error(
        CODES.POLICY_CONFLICT,
        `${event.event_type} occurs before the evidence cutoff was realized; a post-capture ` +
          `journey step may not run before the cutoff`,
      );
    }
  }
}

// -- 5. Lab validity ---------------------------------------------------------

/**
 * Re-derives the validity verdict from the gates the producer recorded, and
 * cross-checks the invalidity findings against the gates that failed.
 *
 * Two producer lies this catches, both of which verified as `valid` before:
 *
 *  - a validity result whose `status` is `valid` while one of its own gates is
 *    `passed: false`;
 *  - a failed gate with no invalidity finding naming it — which is also the
 *    other side of P1-3, where `invalidityFindingHashes: []` was hardcoded so a
 *    run with any failing gate could never reach a terminal at all.
 *
 * The verifier does not re-run the gates themselves — several of them read
 * evidence a public reader does not hold — but it does require the retained gate
 * set to be *self-consistent* and to be corroborated by the retained findings.
 * That boundary is stated rather than blurred.
 */
export function deriveValidityOutcome(options: {
  readonly index: ArtifactIndex;
  readonly validity: EnvironmentValidityResultV1;
  readonly requireValid: boolean;
}): { readonly status: "valid" | "invalid"; readonly failedGateIds: readonly string[] } {
  const { validity } = options;
  const failed = validity.gate_results.filter((g) => !g.passed).map((g) => g.gate_id);
  const derived = failed.length === 0 ? "valid" : "invalid";

  if (derived !== validity.status) {
    throw new Erl2Error(
      CODES.EVALUATOR_VALIDITY_GATE_FAILED,
      `the retained validity result declares status ${validity.status}, but ${String(failed.length)} ` +
        `of its own gates failed (${failed.join(", ") || "none"}); the verifier derives ${derived}`,
    );
  }

  // Every failed gate must be named by a retained invalidity finding, and every
  // cited finding must be retained. A verdict of `invalid` with no supporting
  // finding is a fabricated invalid reason; a failed gate with no finding is an
  // unexplained one.
  const namedGates = new Set<string>();
  for (const hash of validity.invalidity_finding_hashes) {
    const finding = options.index.get(hash);
    for (const gate of (finding.value["failed_gate_ids"] as string[] | undefined) ?? []) {
      namedGates.add(gate);
    }
  }
  for (const gate of failed) {
    if (!namedGates.has(gate)) {
      throw new Erl2Error(
        CODES.EVALUATOR_VALIDITY_GATE_FAILED,
        `validity gate ${gate} failed but no retained invalidity finding names it`,
      );
    }
  }
  if (derived === "valid" && validity.invalidity_finding_hashes.length > 0) {
    throw new Erl2Error(
      CODES.EVALUATOR_VALIDITY_GATE_FAILED,
      "a valid validity result cites invalidity findings; every gate passed",
    );
  }

  if (options.requireValid && derived !== "valid") {
    throw new Erl2Error(
      CODES.BUNDLE_VARIANT_MISMATCH,
      `a public bundle cannot carry an invalid verdict; the retained validity result derives ` +
        `${derived} (failed gates: ${failed.join(", ")})`,
    );
  }
  return { status: derived, failedGateIds: failed };
}

// -- 6. cancellation cleanup applicability -----------------------------------

/**
 * Refuses a cancellation terminal that claims no cleanup was required while the
 * run had, or may have had, external resources.
 *
 * `erl2 cancel` was not branch-dispatched: cancelling a live environment run
 * froze a **pre-environment** cleanup terminal claiming `not_required` while the
 * environment and its reservation leases were still allocated, and the shipped
 * verifier accepted it (review P1-2). The discriminator is the run's own
 * evidence — a substrate binding, or a resource inventory — never a flag and
 * never the record's own account of itself.
 */
export function assertCleanupApplicable(options: {
  readonly record: InvalidLabRunRecordV1;
  readonly lifecycle: readonly LabLifecycleEventV1[];
}): void {
  const roles = rolesOf(options.lifecycle);
  const hadEnvironment =
    (roles.get("substrate-binding") ?? []).length > 0 ||
    (roles.get("environment-resource-inventory") ?? []).length > 0;
  if (!hadEnvironment) return;

  const { variant, status } = options.record.cleanup;
  if (variant === "none" || status === "not_required") {
    throw new Erl2Error(
      CODES.EMERGENCY_CLEANUP_INCOMPLETE,
      `this run provisioned an environment, but its terminal records cleanup variant ` +
        `${variant} with status ${status}; a run with external resources always owes cleanup, ` +
        `and a terminal that says otherwise is asserting a frontier it never enumerated`,
    );
  }
  if (variant === "pre_environment") {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "this run provisioned an environment; its terminal cannot close over a pre-environment cleanup",
    );
  }
}

// -- 7. the whole environment terminal ---------------------------------------

export interface EnvironmentSemanticReport {
  readonly substrate: SubstrateBindingReport;
  readonly validity: { readonly status: "valid" | "invalid"; readonly failedGateIds: readonly string[] };
  readonly restorationPassed: boolean;
  readonly teardownPassed: boolean;
}

/**
 * The verifier's own semantic pass over a valid environment terminal.
 *
 * Called after the closure derivation, so a genuinely missing role keeps its own,
 * more fundamental cause rather than surfacing as a derived-verdict mismatch.
 */
export function deriveEnvironmentSemantics(options: {
  readonly index: ArtifactIndex;
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly runId: string;
}): EnvironmentSemanticReport {
  // Ordering first: a valid terminal whose journey ran a post-capture step before
  // activation or before the cutoff is not a terminal with a derived-verdict
  // mismatch, it is a terminal that should never have been reachable (review P1-9).
  assertJourneyOrderingFromLifecycle(options.lifecycle);
  const substrate = assertSubstrateBindingConsistent(options);
  const roles = rolesOf(options.lifecycle);

  // A run that activated a challenge must retain the controller's own signed
  // receipt that it did (ADR-ERL2-023 §2). It is optional as a role because a
  // run that terminated before activation never produced one — but a terminal
  // that *did* activate and dropped the receipt used to verify valid, because
  // the schema was only in the supporting set (review P2).
  if (options.lifecycle.some((event) => event.event_type === "challenge_activated")) {
    for (const role of ["challenge-activation-receipt", "mutation-receipt"] as const) {
      if (single(roles, role) === undefined) {
        throw new Erl2Error(
          CODES.GRAPH_CLOSURE_MISSING_ROLE,
          `this run activated its challenge, so it must retain exactly one ${role}`,
        );
      }
    }
  }

  // ADR-ERL2-031 §6. A run that started traffic committed an evidence window
  // before it observed the milestone the cutoff is anchored on, and must retain
  // exactly one. Conditional on the lifecycle for the same reason the activation
  // receipt is: a run that terminated earlier committed none, and requiring one
  // would force a synthetic commitment (design v2 §26).
  if (options.lifecycle.some((event) => event.event_type === "traffic_or_journey_started")) {
    if (single(roles, "evidence-window-commitment") === undefined) {
      throw new Erl2Error(
        CODES.GRAPH_CLOSURE_MISSING_ROLE,
        "this run started traffic, so it must retain exactly one evidence-window commitment; " +
          "without it the exact evidence window is unrecoverable and the cutoff can only be " +
          "bounds-checked",
      );
    }
  }

  const validityHash = single(roles, "validity-result");
  if (validityHash === undefined) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_MISSING_ROLE,
      "an environment terminal must produce exactly one validity result",
    );
  }
  const validity = deriveValidityOutcome({
    index: options.index,
    validity: options.index.typed<EnvironmentValidityResultV1>(
      validityHash,
      "environment-validity-result/v1",
    ),
    requireValid: true,
  });

  const restorationHash = single(roles, "environment-restoration");
  const teardownHash = single(roles, "teardown-verification");
  if (restorationHash === undefined || teardownHash === undefined) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_MISSING_ROLE,
      "an environment terminal must produce exactly one restoration and one teardown verification",
    );
  }
  // The independent post-compensation observation is mandatory on a *valid*
  // environment terminal: a restoration whose only witnesses are the baseline
  // fingerprint, the resource inventory and the driver's own receipt is exactly
  // the artifact a no-op compensation produced (review P1-4, ADR-ERL2-026 §4.3).
  const probeHash = single(roles, "restoration-probe");
  if (probeHash === undefined) {
    throw new Erl2Error(
      CODES.RESTORATION_PROBE_MISSING,
      "a valid environment terminal must produce exactly one restoration probe; without it, a " +
        "compensation that reverted nothing cannot be told from one that had nothing to revert",
    );
  }
  const restoration = deriveRestorationOutcome({
    index: options.index,
    restoration: options.index.typed<EnvironmentRestorationVerificationV1>(
      restorationHash,
      "environment-restoration-verification/v1",
    ),
    probe: options.index.typed<RestorationProbeV1>(probeHash, "restoration-probe/v1"),
    mutationReceiptHashes: roles.get("mutation-receipt") ?? [],
    substrateBindingHash: substrate.binding.core_hash,
  });
  const teardown = deriveTeardownOutcome(
    options.index.typed<TeardownVerificationV1>(teardownHash, "teardown-verification/v1"),
  );

  // A valid terminal cannot be signed over a cleanup that did not pass. The
  // producer already refuses this at `assertEnvironmentFinalizable`; the point
  // is that the verifier now refuses it independently.
  if (!restoration.passed || !teardown.passed) {
    throw new Erl2Error(
      CODES.BUNDLE_VARIANT_MISMATCH,
      `a valid environment terminal requires a passing restoration and teardown; the verifier ` +
        `derives restoration=${String(restoration.passed)}, teardown=${String(teardown.passed)}`,
    );
  }

  // The cleanup verdicts must be about the environment this run bound.
  const inventoryHash = single(roles, "environment-resource-inventory");
  if (inventoryHash !== undefined) {
    const restorationArtifact = options.index.typed<EnvironmentRestorationVerificationV1>(
      restorationHash,
      "environment-restoration-verification/v1",
    );
    const teardownArtifact = options.index.typed<TeardownVerificationV1>(
      teardownHash,
      "teardown-verification/v1",
    );
    for (const [label, claimed] of [
      ["restoration", restorationArtifact.environment_instance_hash],
      ["teardown", teardownArtifact.environment_instance_hash],
    ] as const) {
      if (claimed !== inventoryHash) {
        throw new Erl2Error(
          CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
          `the ${label} verification names environment instance ${claimed}, which is not the ` +
            `resource inventory this run froze`,
        );
      }
    }
  }

  return {
    substrate,
    validity,
    restorationPassed: restoration.passed,
    teardownPassed: teardown.passed,
  };
}

/**
 * The verifier's own semantic pass over an **invalid** environment terminal.
 *
 * An invalid record has no attestation and no bundle, but it is the only
 * evidence that a failed run cleaned up — so its cleanup claims are exactly the
 * ones worth checking. Runs that never reached an environment are unaffected.
 */
export function deriveInvalidEnvironmentSemantics(options: {
  readonly index: ArtifactIndex;
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly record: InvalidLabRunRecordV1;
}): void {
  assertCleanupApplicable({ record: options.record, lifecycle: options.lifecycle });
  assertInvalidFindingAttribution({ index: options.index, record: options.record });
  assertJourneyOrderingFromLifecycle(options.lifecycle);

  const roles = rolesOf(options.lifecycle);
  const hadEnvironment =
    (roles.get("substrate-binding") ?? []).length > 0 ||
    (roles.get("environment-resource-inventory") ?? []).length > 0;
  if (!hadEnvironment) return;

  // A binding is required only of runs that produced one; the synthetic
  // pre-ADR-ERL2-024 environment fixtures predate the contract and are still
  // readable, which §10 records deliberately.
  let bindingHash: Hash | undefined;
  if ((roles.get("substrate-binding") ?? []).length > 0) {
    bindingHash = assertSubstrateBindingConsistent({
      index: options.index,
      lifecycle: options.lifecycle,
      runId: options.record.run_id,
    }).binding.core_hash;
  }

  // Every invalid environment terminal, not only the emergency one. This early
  // return used to be `variant !== "emergency_environment"`, and behind it sat a
  // bounded branch that swung an unconditional whole-environment `driver.destroy()`
  // over a frontier it never read — so for five of the seven failure phases the
  // verifier derived no expected safe-action set, checked no receipt cardinality
  // and validated no unsafe skip (review P1-1, P1-5, P1-6; ADR-ERL2-027 §1.3).
  const frontierHash = single(roles, "environment-resource-frontier");
  if (frontierHash === undefined) {
    // A run that reached an environment always enumerates one before it cleans
    // up; a terminal with none is asserting a cleanup over a world it never
    // observed.
    throw new Erl2Error(
      CODES.EMERGENCY_CLEANUP_INCOMPLETE,
      "this run reached an environment, but its terminal retains no resource frontier; a cleanup " +
        "derived from nothing authorizes nothing",
    );
  }
  const frontier = options.index.typed<EnvironmentResourceFrontierV1>(
    frontierHash,
    "environment-resource-frontier/v1",
  );

  // The independent post-cleanup observation is mandatory wherever a frontier
  // was frozen — including a frontier that was empty. An empty frontier that
  // probes back non-empty is itself evidence, and refusing to record it would be
  // exactly the silence the contract exists to break (ADR-ERL2-027 §4.3).
  const probeHash = single(roles, "cleanup-residue-probe");
  if (probeHash === undefined) {
    throw new Erl2Error(
      CODES.RESIDUE_PROBE_MISSING,
      "this terminal enumerated a resource frontier but retains no cleanup residue probe; without " +
        "it the post-cleanup residue is derived by the producer from its own action outcomes, so " +
        "an empty one cannot be contradicted and an unauthorized destruction cannot be seen",
    );
  }
  const probe = options.index.typed<CleanupResidueProbeV1>(probeHash, "cleanup-residue-probe/v1");
  const residue = deriveResidueProbe({
    probe,
    frontier,
    runId: options.record.run_id,
    ...(bindingHash === undefined ? {} : { substrateBindingHash: bindingHash }),
  });

  // The record's own cleanup status, against the substrate that was observed.
  // `attempted_succeeded` over a non-empty residue is a producer claim that
  // nothing checked: the status is a summary of the same evidence the probe
  // holds, so the two cannot be allowed to disagree.
  const derivedStatus =
    residue.residual.length === 0 ? "attempted_succeeded" : "attempted_failed";
  if (options.record.cleanup.status !== derivedStatus) {
    throw new Erl2Error(
      CODES.EMERGENCY_CLEANUP_INCOMPLETE,
      `this terminal records cleanup status ${options.record.cleanup.status}, but the post-cleanup ` +
        `observation leaves ${String(residue.residual.length)} resource(s) of this run's frontier ` +
        `in place; the verifier derives ${derivedStatus}`,
    );
  }

  // A frontier with no derived action has no cleanup verification to check:
  // `EmergencyCleanupVerificationV1.actions` has `minItems: 1`, so the contract
  // itself refuses to describe a cleanup that did nothing. The probe above is
  // the whole record in that case, and it is the observation that says so.
  if (frontier.derived_actions.length === 0) return;

  const resultHash = options.record.cleanup.result_hash;
  if (resultHash === undefined) {
    throw new Erl2Error(
      CODES.EMERGENCY_CLEANUP_INCOMPLETE,
      "this terminal derived cleanup actions from its frontier but cites no cleanup verification",
    );
  }
  const cleanup = options.index.typed<EmergencyCleanupVerificationV1>(
    resultHash,
    "emergency-cleanup-verification/v1",
  );
  deriveEmergencyCleanup({
    index: options.index,
    frontier,
    cleanup,
    frontierEventHashes: options.lifecycle
      .filter((event) =>
        event.produced.some(
          (p) => p.artifact_role === "environment-resource-frontier" && p.artifact_core_hash === frontierHash,
        ),
      )
      .map((event) => event.core_hash),
  });
  // What the action list says, against what the substrate showed.
  assertActionsAgreeWithResidue({ cleanup, frontier, probe });
}

/** Recomputes an artifact's core hash. Exported so callers need not import integrity. */
export function recomputedCoreHash(value: Record<string, unknown>): Hash {
  return coreHash(value);
}
