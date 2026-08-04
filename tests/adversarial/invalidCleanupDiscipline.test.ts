/**
 * One cleanup discipline for every invalid environment terminal, adversarially
 * (review P1-1, P1-3, P1-5, P1-6; ADR-ERL2-027).
 *
 * ## What this covers that the emergency suite does not
 *
 * `emergencyCleanupAdversarial.test.ts` drives the **emergency** branch — a
 * restoration or teardown failure. ADR-ERL2-024 §4.5 fixed that branch and three
 * negative controls measure it. It left the other five failure phases on
 * `boundedEnvironmentCleanup`, which was, in full:
 *
 * ```ts
 * const receipt = this.driver.destroy({ runId, operationId: "op-invalid-destroy" }).receipt;
 * ```
 *
 * — issued one line after the frontier was frozen, and without reading it. Three
 * consequences, all reproduced here as behaviour rather than as inspection:
 *
 *  - a resource the frontier classified `contain_residual` was **destroyed
 *    anyway**, with no retained artifact recording that anything happened to it
 *    (review P1-1);
 *  - a **foreign** resource made that single call throw, so the run reached no
 *    terminal at all (review P1-5);
 *  - the offline verifier returned early on any non-emergency variant, so none
 *    of it was checked (review P1-6).
 *
 * ## Foreign is not shared
 *
 * The fixtures here distinguish the two, because nothing before them did.
 * `sharedResourceIds` marks a resource `shared_with_other_runs` while its
 * `run_scoped_name` still embeds *this* run — so `assertOwnedByRun` passes for it
 * and a whole-environment destroy never throws on it. Every prior case that used
 * sharing to stand in for foreignness was measuring a different property
 * (ADR-ERL2-027 §1.5). `foreignResourceKinds` seeds a resource named and hashed
 * for another run, which is the one that throws.
 *
 * ## Where the semantic mutations run
 *
 * Against the verifier-owned derivations directly, on the same reasoning
 * `emergencyCleanupAdversarial.test.ts` records: the invalid record cites every
 * artifact by core hash, so editing a retained file surfaces as
 * `GRAPH_CLOSURE_UNREACHABLE_ARTIFACT` and the rule under test never runs. The
 * end-to-end wiring is asserted separately, by the cases that verify a real
 * CLI-produced record through the shipped binary.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ArtifactIndex,
  assertActionsAgreeWithResidue,
  assertInvalidFindingAttribution,
  deriveInvalidEnvironmentSemantics,
  deriveResidueProbe,
} from "@erl2/public-verifier";
import { emergencyOperationId } from "@erl2/core";
import type {
  CleanupResidueProbeV1,
  EmergencyCleanupVerificationV1,
  EnvironmentResourceFrontierV1,
  InvalidLabRunRecordV1,
  LabLifecycleEventV1,
} from "@erl2/contracts";
import { erl2, writeLifecycle, writeTrustConfig } from "../support/cliRun.js";
import {
  driveWithFault,
  phaseIndex,
  producedRoles,
  selectedRun,
  substrateRootOf,
  type EnvironmentRun,
} from "../support/environmentCli.js";

/**
 * Drives a run to a **non-emergency** invalid terminal: a contaminated baseline.
 *
 * This is the bounded route — `invalid_environment_cleanup_started` →
 * `invalid_cleanup_terminal` — which is where the unconditional destroy lived.
 * The fault is applied from `provision` onward because `sharedResourceIds` and
 * `foreignResourceKinds` both decide the substrate's contents when the inventory
 * is created; supplied only to the failing command they would build a fixture
 * that does not contain the condition the case is named for.
 */
function boundedRun(fault: string): EnvironmentRun {
  const run = selectedRun();
  driveWithFault(run, fault, phaseIndex(run, "baseline"));
  const result = erl2(["baseline", ...run.base, "--fake-driver-fault", fault]);
  assert.notEqual(result.exitCode, 0, "a contaminated baseline is a Lab-owned failure");
  return run;
}

function retained(run: EnvironmentRun, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(run.runRoot, "retained", name), "utf8")) as Record<
    string,
    unknown
  >;
}

function frontierOf(run: EnvironmentRun): EnvironmentResourceFrontierV1 {
  return retained(run, "environment/resource-frontier.json") as unknown as EnvironmentResourceFrontierV1;
}

function probeOf(run: EnvironmentRun): CleanupResidueProbeV1 {
  return retained(run, "environment/cleanup-residue-probe.json") as unknown as CleanupResidueProbeV1;
}

function cleanupOf(run: EnvironmentRun): EmergencyCleanupVerificationV1 {
  return retained(run, "emergency-cleanup-verification.json") as unknown as EmergencyCleanupVerificationV1;
}

function recordOf(run: EnvironmentRun): InvalidLabRunRecordV1 {
  return retained(run, "invalid-run-record.json") as unknown as InvalidLabRunRecordV1;
}

/**
 * The substrate as it actually is, read from the file the driver writes.
 *
 * `FileSubstrateStore` keys one document per run, by base64url of the run id.
 * Reading it directly is the point: every other assertion in this file reads
 * something the Lab wrote about itself, and this one reads the world.
 */
function substrateState(run: EnvironmentRun): {
  resources?: { resource_id: string }[];
  operations?: Record<string, unknown>;
} {
  const file = path.join(
    substrateRootOf(run),
    `${Buffer.from(run.runId, "utf8").toString("base64url")}.substrate.json`,
  );
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as {
    resources?: { resource_id: string }[];
    operations?: Record<string, unknown>;
  };
}

function substrateResourceIds(run: EnvironmentRun): readonly string[] {
  return (substrateState(run).resources ?? []).map((r) => r.resource_id);
}

/** Every operation id the driver's own log says it completed. */
function completedOperationIds(run: EnvironmentRun): readonly string[] {
  return Object.keys(substrateState(run).operations ?? {});
}

function verifyRecord(run: EnvironmentRun): { exitCode: number; code: string | undefined } {
  const result = erl2([
    "verify-record",
    "--record", path.join(run.runRoot, "retained", "invalid-run-record.json"),
    "--lifecycle", writeLifecycle(run.runRoot),
    "--artifact-root", run.runRoot,
    "--root-config", writeTrustConfig(run.runRoot),
    "--offline",
  ]);
  return { exitCode: result.exitCode, code: result.body.errors[0]?.code };
}

function refusalCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// -- 1. P1-1: the bounded route no longer destroys what it classified unsafe --

test("BOUNDED-CLEANUP: a frontier-unsafe resource survives, and is reported as skipped", () => {
  const run = boundedRun("contaminated-baseline-shared");
  const frontier = frontierOf(run);
  const unsafe = frontier.derived_actions.filter((a) => !a.independently_safe);
  assert.equal(unsafe.length, 1, "this fixture must derive exactly one unsafe action");
  const target = unsafe[0]?.target_resource_id as string;

  // The claim and the world, checked separately. Under the previous
  // implementation the claim did not exist at all — the bounded route reported
  // no actions — and the world had lost this resource.
  assert.ok(
    substrateResourceIds(run).includes(target),
    `${target} was classified contain_residual and must still be there`,
  );
  const reported = cleanupOf(run).actions.find((a) => a.action_id === unsafe[0]?.action_id);
  assert.equal(reported?.status, "skipped_unsafe");
  assert.equal(reported?.reason_code, "RESOURCE_SHARED_WITH_ANOTHER_RUN");
  // The union's `skipped_unsafe` variant has no receipt field at all, which is
  // itself the point; read it defensively anyway, because a hand-assembled
  // document reaches the verifier by other routes than this one.
  assert.equal(
    (reported as { attempt_receipt_hash?: string } | undefined)?.attempt_receipt_hash,
    undefined,
    "a skip that produced a receipt is not a skip",
  );
});

test("BOUNDED-CLEANUP: no whole-environment destroy is dispatched on the bounded route", () => {
  const run = boundedRun("contaminated-baseline-shared");
  const operations = completedOperationIds(run);
  // The driver's own operation log, not the retained artifacts: artifact
  // accounting can hide a dispatch, an operation log records it.
  for (const aggregate of ["op-invalid-destroy", "op-emergency-destroy", "op-destroy"]) {
    assert.ok(
      !operations.includes(aggregate),
      `the bounded route dispatched the whole-environment operation ${aggregate}`,
    );
  }
  // And it did dispatch, per action, exactly the ones the frontier authorized.
  //
  // The operation id is derived rather than interpolated: `op-emergency-` plus
  // the frontier's own `<action-kind>-<resource_id>` overflowed the 64-character
  // contract identifier for ordinary Compose resources, which made the receipt
  // fail validation after the destroy had already been dispatched. The identity
  // under test is unchanged — this reads the derivation the shipped path uses
  // rather than restating it as a string.
  const safe = frontierOf(run).derived_actions.filter((a) => a.independently_safe);
  assert.ok(safe.length > 0, "this fixture must derive at least one safe action");
  for (const action of safe) {
    const operationId = emergencyOperationId(run.runId, action.action_id);
    assert.match(operationId, /^[a-z][a-z0-9-]{0,63}$/, `${operationId} is not a contract identifier`);
    assert.ok(
      operations.includes(operationId),
      `safe action ${action.action_id} was never dispatched`,
    );
  }
});

test("BOUNDED-CLEANUP: every safe action has exactly one receipt, and every skip none", () => {
  const run = boundedRun("contaminated-baseline-shared");
  const frontier = frontierOf(run);
  const cleanup = cleanupOf(run);
  assert.equal(
    cleanup.actions.length,
    frontier.derived_actions.length,
    "no resource may disappear from the accounting",
  );
  const receipts = cleanup.actions
    .map((a) => (a as { attempt_receipt_hash?: string }).attempt_receipt_hash)
    .filter((h): h is string => h !== undefined);
  assert.equal(new Set(receipts).size, receipts.length, "one action, one receipt");
  for (const action of frontier.derived_actions) {
    const reported = cleanup.actions.find((a) => a.action_id === action.action_id);
    assert.ok(reported !== undefined, `action ${action.action_id} is unaccounted for`);
    assert.equal(reported.independently_safe, action.independently_safe);
    if (action.independently_safe) {
      assert.notEqual(reported.status, "skipped_unsafe");
      assert.ok((reported as { attempt_receipt_hash?: string }).attempt_receipt_hash !== undefined);
    }
  }
});

// -- 2. P1-5: a foreign resource no longer strands the run --------------------

test("BOUNDED-CLEANUP: a foreign resource does not prevent the run reaching a terminal", () => {
  // The whole of P1-5 on this branch. `FakeEnvironmentDriver.destroy` validates
  // ownership of every live resource before touching any, so under the previous
  // implementation this run threw out of `invalidate`, froze no invalid record
  // and held its leases. Reaching a terminal at all *is* the proof.
  const run = boundedRun("contaminated-baseline-foreign");
  const roles = producedRoles(run);
  assert.equal(
    roles.filter((r) => r === "invalid-run-record").length,
    1,
    "exactly one invalid record, and exactly one",
  );
  assert.ok(roles.includes("environment-resource-frontier"));
  assert.ok(roles.includes("cleanup-residue-probe"));
  const verified = verifyRecord(run);
  assert.equal(verified.exitCode, 0, verified.code);
});

test("BOUNDED-CLEANUP: the owned resources are cleaned up around the foreign one", () => {
  const run = boundedRun("contaminated-baseline-foreign");
  const frontier = frontierOf(run);
  const foreign = frontier.derived_actions.filter(
    (a) => a.unsafe_reason_code === "RESOURCE_NOT_PROVABLY_OWNED_BY_RUN",
  );
  assert.equal(foreign.length, 1, "this fixture must observe exactly one foreign resource");
  const safe = frontier.derived_actions.filter((a) => a.independently_safe);
  assert.ok(safe.length > 0, "the run's own resources must still derive safe actions");

  const survivors = new Set(substrateResourceIds(run));
  assert.ok(
    survivors.has(foreign[0]?.target_resource_id as string),
    "another run's resource must be left exactly where it was",
  );
  const probe = probeOf(run);
  assert.equal(probe.outcome, "residual", "the foreign resource is residue, not a clean sheet");
  assert.deepEqual(
    [...probe.residual_resources],
    [foreign[0]?.target_resource_id],
    "and it is the only thing left",
  );
});

// -- 3. P1-3: the finding names the gate its own phase falsifies --------------

test("BOUNDED-CLEANUP: a baseline failure's finding names the baseline gate", () => {
  const run = boundedRun("contaminated-baseline-shared");
  const record = recordOf(run);
  assert.equal(record.failed_phase.kind, "lifecycle_phase");
  assert.equal((record.failed_phase as { phase: string }).phase, "baseline");
  const finding = ArtifactIndex.scan(run.runRoot).get(
    (record.terminal_reason as { primary_finding_hash: string }).primary_finding_hash as never,
  ).value;
  assert.deepEqual(finding["failed_gate_ids"], ["environment-baseline-clean"]);
  // Lab-owned, and not scored against the subject on any plane.
  assert.equal(finding["owner"], "lab");
  assert.equal(finding["subject_attribution_proven"], false);
  assert.deepEqual(finding["scoreable_planes"], []);
});

test("BOUNDED-CLEANUP: the cleanup consequence never replaces the original cause", () => {
  // The foreign resource makes cleanup *incomplete* — residue remains — and the
  // record must still name the baseline as what failed. A terminal that renamed
  // itself after its cleanup would lose the only statement of why the run is
  // invalid at all.
  const run = boundedRun("contaminated-baseline-foreign");
  const record = recordOf(run);
  assert.equal((record.failed_phase as { phase: string }).phase, "baseline");
  assert.equal(record.cleanup.status, "attempted_failed");
  assert.equal(record.cleanup.variant, "partial_environment");
  const finding = ArtifactIndex.scan(run.runRoot).get(
    (record.terminal_reason as { primary_finding_hash: string }).primary_finding_hash as never,
  ).value;
  assert.deepEqual(finding["failed_gate_ids"], ["environment-baseline-clean"]);
});

// -- 4. P1-6: the verifier derives all of it, and refuses each lie -------------

test("BOUNDED-CLEANUP: the unmutated bounded terminal derives cleanly", () => {
  const run = boundedRun("contaminated-baseline-shared");
  const index = ArtifactIndex.scan(run.runRoot);
  const frontier = frontierOf(run);
  const probe = probeOf(run);
  assert.equal(
    refusalCode(() => deriveResidueProbe({ probe, frontier, runId: run.runId })),
    undefined,
  );
  assert.equal(
    refusalCode(() => assertActionsAgreeWithResidue({ cleanup: cleanupOf(run), frontier, probe })),
    undefined,
  );
  assert.equal(
    refusalCode(() => assertInvalidFindingAttribution({ index, record: recordOf(run) })),
    undefined,
  );
});

test("BOUNDED-CLEANUP: a fabricated empty residue is refused as undeclared destruction", () => {
  // The producer's `remaining_resources` is derived from its own action
  // outcomes, so before the probe existed an empty one could not be
  // contradicted. Here the probe claims the substrate came back empty while the
  // frontier's unsafe member was never authorized: the difference is the lie.
  const run = boundedRun("contaminated-baseline-shared");
  const frontier = frontierOf(run);
  const mutated = { ...probeOf(run), observed_after: [], residual_resources: [] };
  assert.equal(
    refusalCode(() =>
      deriveResidueProbe({ probe: mutated as CleanupResidueProbeV1, frontier, runId: run.runId }),
    ),
    "RESIDUE_PROBE_MISSING",
    "the outcome no longer follows from the observations",
  );
  // And with the outcome repaired so the derivation is reached on its merits.
  const consistent = {
    ...mutated,
    outcome: "undeclared_destruction",
    undeclared_destroyed_resources: frontier.derived_actions
      .filter((a) => !a.independently_safe)
      .map((a) => a.target_resource_id),
  };
  assert.equal(
    refusalCode(() =>
      deriveResidueProbe({ probe: consistent as CleanupResidueProbeV1, frontier, runId: run.runId }),
    ),
    "RESIDUE_UNDECLARED_DESTRUCTION",
  );
});

test("BOUNDED-CLEANUP: a probe that authorizes what the frontier did not is refused", () => {
  const run = boundedRun("contaminated-baseline-shared");
  const frontier = frontierOf(run);
  const probe = probeOf(run);
  const mutated = {
    ...probe,
    authorized_targets: [
      ...probe.authorized_targets,
      ...frontier.derived_actions.filter((a) => !a.independently_safe).map((a) => a.target_resource_id),
    ].sort(),
  };
  assert.equal(
    refusalCode(() =>
      deriveResidueProbe({ probe: mutated as CleanupResidueProbeV1, frontier, runId: run.runId }),
    ),
    "EMERGENCY_ACTION_UNDECLARED_TARGET",
    "a probe that writes its own authorization would authorize whatever it destroyed",
  );
});

test("BOUNDED-CLEANUP: a probe whose `before` is a post-destruction inventory is refused", () => {
  // The §5 rule made mechanical: the expectation must come from the frontier
  // frozen before the first dispatch. A probe that starts from the world as it
  // was *after* the destruction sees nothing missing.
  const run = boundedRun("contaminated-baseline-shared");
  const frontier = frontierOf(run);
  const probe = probeOf(run);
  const mutated = { ...probe, observed_before: probe.observed_after };
  assert.equal(
    refusalCode(() =>
      deriveResidueProbe({ probe: mutated as CleanupResidueProbeV1, frontier, runId: run.runId }),
    ),
    "RESIDUE_PROBE_MISSING",
  );
});

test("BOUNDED-CLEANUP: a probe belonging to another run or another substrate is refused", () => {
  const run = boundedRun("contaminated-baseline-shared");
  const frontier = frontierOf(run);
  const probe = probeOf(run);
  assert.equal(
    refusalCode(() =>
      deriveResidueProbe({
        probe,
        frontier,
        runId: "019f1af9-0000-7000-8000-00000000dead",
      }),
    ),
    "RESIDUE_PROBE_MISSING",
  );
  assert.equal(
    refusalCode(() =>
      deriveResidueProbe({
        probe,
        frontier,
        runId: run.runId,
        substrateBindingHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ),
    "RESIDUE_PROBE_MISSING",
  );
});

test("BOUNDED-CLEANUP: an action claiming success over a resource that is still there is refused", () => {
  const run = boundedRun("contaminated-baseline-shared");
  const frontier = frontierOf(run);
  const probe = probeOf(run);
  const cleanup = cleanupOf(run);
  const skipped = cleanup.actions.find((a) => a.status === "skipped_unsafe");
  assert.ok(skipped !== undefined);
  // Relabel the surviving resource's action as a success. The action list is
  // then internally plausible and contradicts only the substrate.
  const mutated = {
    ...cleanup,
    actions: cleanup.actions.map((a) =>
      a.action_id === skipped.action_id
        ? { ...a, independently_safe: true, status: "succeeded", attempt_receipt_hash: probe.core_hash }
        : a,
    ),
  };
  assert.equal(
    refusalCode(() =>
      assertActionsAgreeWithResidue({
        cleanup: mutated as unknown as EmergencyCleanupVerificationV1,
        frontier,
        probe,
      }),
    ),
    "EMERGENCY_CLEANUP_INCOMPLETE",
  );
});

test("BOUNDED-CLEANUP: a residue the observation does not see is refused", () => {
  const run = boundedRun("contaminated-baseline-shared");
  const frontier = frontierOf(run);
  const cleanup = cleanupOf(run);
  const mutated = { ...cleanup, remaining_resources: [] };
  assert.equal(
    refusalCode(() =>
      assertActionsAgreeWithResidue({
        cleanup: mutated as unknown as EmergencyCleanupVerificationV1,
        frontier,
        probe: probeOf(run),
      }),
    ),
    "RESIDUE_DETECTED",
    "the observation still sees a survivor the verification does not account for",
  );
});

test("BOUNDED-CLEANUP: a finding naming another phase's gate is refused", () => {
  const run = boundedRun("contaminated-baseline-shared");
  const index = ArtifactIndex.scan(run.runRoot);
  const record = recordOf(run);
  // The defect verbatim: the branch-keyed map gave every non-emergency phase
  // `environment-baseline-clean`. Here the phase is teardown and the gate is the
  // baseline's, which is the same statement one phase over.
  const mutated = {
    ...record,
    failed_phase: { ...(record.failed_phase as object), phase: "teardown" },
  };
  assert.equal(
    refusalCode(() =>
      assertInvalidFindingAttribution({ index, record: mutated as unknown as InvalidLabRunRecordV1 }),
    ),
    "INVALID_REASON_PHASE_MISMATCH",
  );
});

test("BOUNDED-CLEANUP: a subject-attributed finding on a Lab environment failure is refused", () => {
  const run = boundedRun("contaminated-baseline-shared");
  const record = recordOf(run);
  const findingHash = (record.terminal_reason as { primary_finding_hash: string })
    .primary_finding_hash;
  const real = ArtifactIndex.scan(run.runRoot);
  // A stand-in index that answers with a subject-owned finding for the hash the
  // record cites. Editing the retained file would change its hash and the
  // closure layer would refuse first, so the semantic rule would never run.
  for (const [field, value, expected] of [
    ["owner", "subject", "INVALID_REASON_FABRICATED_FINDING"],
    ["subject_attribution_proven", true, "INVALID_REASON_FABRICATED_FINDING"],
    ["scoreable_planes", ["journey"], "INVALID_REASON_FABRICATED_FINDING"],
  ] as const) {
    const index = {
      get: (hash: string) =>
        hash === findingHash
          ? { value: { ...real.get(findingHash as never).value, [field]: value } }
          : real.get(hash as never),
    } as unknown as ArtifactIndex;
    assert.equal(
      refusalCode(() => assertInvalidFindingAttribution({ index, record })),
      expected,
      `a finding with ${field} = ${JSON.stringify(value)} must be refused`,
    );
  }
});

// -- 4a. the rules are reached, not merely correct ---------------------------

/**
 * The lifecycle as the run wrote it, which is what `verify-record` hands the
 * derivation.
 */
function lifecycleOf(run: EnvironmentRun): readonly LabLifecycleEventV1[] {
  return JSON.parse(readFileSync(writeLifecycle(run.runRoot), "utf8")) as LabLifecycleEventV1[];
}

/** The same lifecycle with one produced role removed, and nothing else changed. */
function withoutRole(
  lifecycle: readonly LabLifecycleEventV1[],
  role: string,
): readonly LabLifecycleEventV1[] {
  return lifecycle.map((event) => ({
    ...event,
    produced: event.produced.filter((p) => p.artifact_role !== role),
  }));
}

/**
 * `deriveInvalidEnvironmentSemantics` is the function `verify-record` calls.
 *
 * The cases above mutate one concern and ask the rule that owns it, which proves
 * the rules are right. It does not prove they are *reached* — and the negative
 * control found exactly that: disabling the entry point's residue requirement
 * killed nothing, because every case went around it. These two go through the
 * front door.
 *
 * The lifecycle is filtered in memory rather than on disk because it is a
 * parameter: editing the retained events would break the hash chain and the
 * refusal would come from a layer beneath the one under test.
 */
test("BOUNDED-CLEANUP: the verifier's entry point requires the residue probe", () => {
  const run = boundedRun("contaminated-baseline-shared");
  const index = ArtifactIndex.scan(run.runRoot);
  const record = recordOf(run);
  const lifecycle = lifecycleOf(run);

  assert.equal(
    refusalCode(() => deriveInvalidEnvironmentSemantics({ index, lifecycle, record })),
    undefined,
    "the unmutated terminal passes the entry point",
  );
  assert.equal(
    refusalCode(() =>
      deriveInvalidEnvironmentSemantics({
        index,
        lifecycle: withoutRole(lifecycle, "cleanup-residue-probe"),
        record,
      }),
    ),
    "RESIDUE_PROBE_MISSING",
    "a terminal that enumerated a frontier and retained no observation of what cleanup did",
  );
});

test("BOUNDED-CLEANUP: a cleanup status that disagrees with the residue is refused", () => {
  // `cleanup.status` summarises the same evidence the probe holds, so the two
  // cannot be allowed to disagree. The repository's own `invalid-run-emergency-
  // cleanup` golden read `attempted_succeeded` while a contained resource was
  // still sitting there, and nothing checked it.
  const run = boundedRun("contaminated-baseline-foreign");
  const record = recordOf(run);
  assert.equal(record.cleanup.status, "attempted_failed", "this fixture leaves residue");
  assert.equal(
    refusalCode(() =>
      deriveInvalidEnvironmentSemantics({
        index: ArtifactIndex.scan(run.runRoot),
        lifecycle: lifecycleOf(run),
        record: {
          ...record,
          cleanup: { ...record.cleanup, status: "attempted_succeeded" },
        } as unknown as InvalidLabRunRecordV1,
      }),
    ),
    "EMERGENCY_CLEANUP_INCOMPLETE",
  );
});

test("BOUNDED-CLEANUP: the verifier's entry point requires the pre-action frontier", () => {
  // The other half of the same wiring: without the frontier there is no
  // expectation to derive the action set from, so a cleanup authorizes nothing.
  const run = boundedRun("contaminated-baseline-shared");
  assert.equal(
    refusalCode(() =>
      deriveInvalidEnvironmentSemantics({
        index: ArtifactIndex.scan(run.runRoot),
        lifecycle: withoutRole(lifecycleOf(run), "environment-resource-frontier"),
        record: recordOf(run),
      }),
    ),
    "EMERGENCY_CLEANUP_INCOMPLETE",
  );
});

// -- 5. no invalid path emits an attestation or a public bundle ---------------

test("BOUNDED-CLEANUP: no attestation and no public bundle descend from a bounded terminal", () => {
  const run = boundedRun("contaminated-baseline-foreign");
  const roles = new Set(producedRoles(run));
  assert.ok(!roles.has("final-attestation"), "an invalid path must sign no attestation");
  assert.ok(!roles.has("signer-inventory"));
  assert.ok(!existsSync(path.join(run.runRoot, "retained", "public-bundle.json")));
  // And finalization is refused rather than silently skipped.
  const finalize = erl2([
    "finalize-generic", ...run.base,
  ]);
  assert.notEqual(finalize.exitCode, 0);
});
