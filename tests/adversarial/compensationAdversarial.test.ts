/**
 * A compensation that reverted nothing (review P1-4, ADR-ERL2-026).
 *
 * ## The defect, and why it survived the first remediation
 *
 * Restoration was derived — by the producer and again by the verifier — from the
 * before/after baseline fingerprints, the residual resource set, and the cited
 * compensation receipts' own `status`. Not one of those can see a mutation: the
 * fingerprint is built from probe observations and evidence-source states
 * (resource *health*), and the inventory is resource *existence*. A driver that
 * returns `status: "succeeded"` and clears nothing therefore produced two
 * identical baselines, an unchanged inventory, a succeeded receipt, and
 * `passed: true` over a mutation that was still applied.
 *
 * ADR-ERL2-024 §4.3 recorded the expected mutation set in the durable intent —
 * but only inside an opaque `request_hash`, in run-private state that reaches no
 * contract. So "reverted nothing" and "had nothing to revert" still produced
 * byte-identical terminals, which is precisely what the finding said.
 *
 * ## How these cases are built
 *
 * The end-to-end cases drive the shipped binary with a scripted driver fault, so
 * the lie is told by the driver exactly as a real one would tell it. The
 * mutation cases operate on the object the derivation reads rather than on the
 * retained file: every one of these artifacts is cited by core hash, so editing
 * the file surfaces as `ARTIFACT_HASH_MISMATCH` and the semantic rule under test
 * never runs — the discipline ADR-ERL2-024 §7.3 requires.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ArtifactIndex,
  deriveEnvironmentSemantics,
  deriveRestorationOutcome,
} from "@erl2/public-verifier";
import { deriveRestorationProbeOutcome } from "@erl2/core";
import type {
  EnvironmentRestorationVerificationV1,
  Hash,
  LabLifecycleEventV1,
  RestorationProbeV1,
} from "@erl2/contracts";
import { erl2, verifyBundle, writeLifecycle } from "../support/cliRun.js";
import {
  drive,
  environmentPlan,
  lifecycleEvents,
  phaseIndex,
  producedRoles,
  selectedRun,
  substrateRootOf,
  type EnvironmentRun,
} from "../support/environmentCli.js";

function retained<T>(run: EnvironmentRun, relative: string): T {
  return JSON.parse(readFileSync(path.join(run.runRoot, "retained", relative), "utf8")) as T;
}

function lifecycle(run: EnvironmentRun): readonly LabLifecycleEventV1[] {
  return JSON.parse(readFileSync(writeLifecycle(run.runRoot), "utf8")) as LabLifecycleEventV1[];
}

function refusalCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function roleHashes(run: EnvironmentRun, role: string): readonly Hash[] {
  return lifecycleEvents(run)
    .flatMap((event) => event.produced ?? [])
    .filter((produced) => produced.artifact_role === role)
    .map((produced) => produced.artifact_core_hash as Hash);
}

/** Drives the whole plan with one fault applied to `restore` alone. */
function driveToRestoreWith(run: EnvironmentRun, fault: string): ReturnType<typeof erl2> {
  drive(run, phaseIndex(run, "restore"));
  const argv = environmentPlan(run)[phaseIndex(run, "restore")] as readonly [string, readonly string[]];
  return erl2([...argv[1], "--fake-driver-fault", fault]);
}

/** A finalized run, and the probe it froze. */
function finalizedRun(): EnvironmentRun {
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");
  return run;
}

// -- 1. the exploit, end to end ----------------------------------------------

test("COMPENSATION-ADV: a receipt reading `succeeded` over a mutation that is still applied is refused", () => {
  const run = selectedRun();
  const result = driveToRestoreWith(run, "no-op-restore");

  assert.notEqual(result.exitCode, 0, "a no-op compensation must not pass restoration");
  assert.equal(
    result.body.errors[0]?.code,
    "RESTORATION_NOT_INDEPENDENTLY_OBSERVED",
    JSON.stringify(result.body.errors),
  );

  // The mutation is genuinely still there — the receipt was the only thing that
  // said otherwise.
  const substrate = substrateRootOf(run);
  const file = readFileSync(
    path.join(
      substrate,
      `${Buffer.from(run.runId, "utf8").toString("base64url")}.substrate.json`,
    ),
    "utf8",
  );
  const state = JSON.parse(file) as { mutations: string[] };
  assert.ok(state.mutations.length > 0, "the mutation the compensation claimed to revert remains");

  // And no valid terminal descends from it.
  const roles = new Set(producedRoles(run));
  assert.ok(!roles.has("environment-restoration"), "no restoration verification may freeze");
  assert.ok(!roles.has("final-attestation"), "no attestation may descend from a no-op compensation");
});

test("COMPENSATION-ADV: the refused run reaches the authorized invalid terminal, and it verifies", () => {
  const run = selectedRun();
  assert.notEqual(driveToRestoreWith(run, "no-op-restore").exitCode, 0);
  // A restoration failure's one authorized route is receipt-backed emergency
  // cleanup, and the run must be able to take it rather than being stranded.
  // `cancel` exits on the cancellation class (Appendix B exit 12), not zero.
  const cancelled = erl2(["cancel", ...run.base, "--reason", "restoration_failure"]);
  assert.notEqual(cancelled.exitCode, 0, "a cancelled run exits on the cancellation class");
  assert.equal(cancelled.body.state, "invalidated");
  const data = (cancelled.body.data ?? {}) as Record<string, string>;
  assert.equal(
    data["cleanup_variant"],
    "emergency_environment",
    "a run holding a live environment takes the emergency route",
  );
  assert.equal(
    producedRoles(run).filter((role) => role === "invalid-run-record").length,
    1,
    "exactly one invalid terminal",
  );
  // And no valid attestation was ever emitted along the way.
  assert.ok(!new Set(producedRoles(run)).has("final-attestation"));
});

test("COMPENSATION-ADV: a compensation that reverts unrelated state is refused too", () => {
  // `collateral`: the environment carried a mutation this run never applied and
  // holds no receipt for, and the compensation cleared it as well. The
  // environment did not return to its baseline either, and reporting it as
  // restored would be the same false claim one target over.
  const run = selectedRun();
  let refused: ReturnType<typeof erl2> | undefined;
  for (const [name, argv] of environmentPlan(run)) {
    const result = erl2([...argv, "--fake-driver-fault", "collateral-restore"]);
    if (name === "restore") {
      refused = result;
      break;
    }
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
  }
  assert.ok(refused !== undefined);
  assert.notEqual(refused.exitCode, 0, "a collateral revert must not pass restoration");
  assert.equal(
    refused.body.errors[0]?.code,
    "RESTORATION_NOT_INDEPENDENTLY_OBSERVED",
    JSON.stringify(refused.body.errors),
  );
});

test("COMPENSATION-ADV: a genuine compensation passes, freezes its probe, and verifies offline", () => {
  const run = finalizedRun();
  const probeHashes = roleHashes(run, "restoration-probe");
  assert.equal(probeHashes.length, 1, "a valid environment terminal produces exactly one probe");

  const probe = retained<RestorationProbeV1>(run, "environment/restoration-probe.json");
  assert.equal(probe.outcome, "reverted");
  assert.equal(probe.probe_status, "observed");
  assert.equal(probe.residual_expected_mutations.length, 0);
  assert.equal(probe.collateral_reverted_mutations.length, 0);
  assert.equal(
    probe.expected_reverted_mutations.length,
    roleHashes(run, "mutation-receipt").length,
    "one expected entry per retained mutation receipt",
  );
  assert.ok(probe.observed_before.length > 0, "the run observed its mutation applied before compensating");
  assert.equal(probe.observed_after.length, 0);

  const verified = verifyBundle(run.runRoot, {
    sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
  });
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  assert.equal((verified.body.data as { verdict: string }).verdict, "valid");
});

// -- 2. the verifier reaches the same conclusion, one mutation at a time ------

test("COMPENSATION-ADV: the verifier refuses every way a probe can be about something else", () => {
  const run = finalizedRun();
  const index = ArtifactIndex.scan(run.runRoot);
  const restoration = retained<EnvironmentRestorationVerificationV1>(
    run,
    "environment-restoration-verification.json",
  );
  const probe = retained<RestorationProbeV1>(run, "environment/restoration-probe.json");
  const mutationReceiptHashes = roleHashes(run, "mutation-receipt");
  const substrateBindingHash = roleHashes(run, "substrate-binding")[0] as Hash;
  const derive = (
    override: Partial<RestorationProbeV1>,
    restorationOverride: Partial<EnvironmentRestorationVerificationV1> = {},
  ): string | undefined =>
    refusalCode(() =>
      deriveRestorationOutcome({
        index,
        restoration: { ...restoration, ...restorationOverride },
        probe: { ...probe, ...override } as RestorationProbeV1,
        mutationReceiptHashes,
        substrateBindingHash,
      }),
    );

  // The unmutated case must derive cleanly, or every result below is noise.
  assert.equal(derive({}), undefined);

  const otherRun = "01890000-0000-7000-8000-0000000000ff";
  const otherHash = `sha256:${"0".repeat(64)}` as Hash;

  assert.equal(derive({ run_id: otherRun }), "RESTORATION_PROBE_MISSING", "wrong run");
  assert.equal(
    derive({ compensation_receipt_hash: otherHash }),
    "RESTORATION_PROBE_MISSING",
    "a compensation the restoration does not cite",
  );
  assert.equal(
    derive({ compensation_operation_id: "op-something-else" }),
    "RESTORATION_PROBE_MISSING",
    "a stale receipt replayed from another operation",
  );
  assert.equal(
    derive({ environment_instance_hash: otherHash }),
    "RESTORATION_PROBE_MISSING",
    "another environment instance",
  );
  assert.equal(
    derive({ substrate_binding_hash: otherHash }),
    "RESTORATION_PROBE_MISSING",
    "another substrate binding",
  );
  assert.equal(
    derive({ expected_reverted_mutations: [] }),
    "RESTORATION_PROBE_MISSING",
    "a probe that expects nothing while a mutation receipt is retained",
  );
  assert.equal(
    derive({
      expected_reverted_mutations: probe.expected_reverted_mutations.map((entry) => ({
        ...entry,
        mutation_receipt_hash: otherHash,
      })),
    }),
    "RESTORATION_PROBE_MISSING",
    "a probe naming a mutation receipt this run never retained",
  );
  assert.equal(
    derive({
      expected_reverted_mutations: probe.expected_reverted_mutations.map((entry) => ({
        ...entry,
        target_identity_hash: otherHash,
      })),
    }),
    "RESTORATION_PROBE_MISSING",
    "a probe naming a target its own receipt does not name",
  );
  assert.equal(
    derive({
      expected_reverted_mutations: [
        ...probe.expected_reverted_mutations,
        ...probe.expected_reverted_mutations,
      ],
    }),
    "RESTORATION_PROBE_MISSING",
    "the same mutation receipt named twice",
  );

  // The observation itself.
  assert.equal(
    derive({
      observed_after: probe.expected_reverted_mutations.map((entry) => entry.mutation_id),
    }),
    "RESTORATION_NOT_INDEPENDENTLY_OBSERVED",
    "the expected mutation is still applied, and the retained outcome says otherwise",
  );
  assert.equal(
    derive({ probe_status: "unavailable" }),
    "RESTORATION_NOT_INDEPENDENTLY_OBSERVED",
    "a restoration nobody could observe",
  );
  assert.equal(
    derive({ outcome: "nothing_to_revert" }),
    "RESTORATION_NOT_INDEPENDENTLY_OBSERVED",
    "`reverted` relabelled as `nothing_to_revert`",
  );

  // The compensation receipt's own binding, through the restoration.
  assert.equal(
    derive(
      {},
      {
        compensation_receipt_hashes: [
          ...restoration.compensation_receipt_hashes,
          ...restoration.compensation_receipt_hashes,
        ],
      },
    ),
    "RESTORATION_FAILED",
    "a duplicated compensation receipt",
  );
  assert.equal(
    derive({}, { compensation_receipt_hashes: mutationReceiptHashes }),
    "RESTORATION_FAILED",
    "a mutate receipt cited as the compensation",
  );
});

test("COMPENSATION-ADV: a terminal that omits the observation entirely is refused", () => {
  // The closure role rather than the derivation: a terminal carrying a
  // restoration with no probe to qualify it is exactly the artifact P1-4
  // produced, and the whole-terminal pass must refuse it on that ground.
  const run = finalizedRun();
  const events = lifecycle(run);
  assert.ok(
    events.some((e) => e.produced.some((p) => p.artifact_role === "restoration-probe")),
    "the run must have produced a probe for its removal to mean anything",
  );
  const withoutProbe = events.map((event) => ({
    ...event,
    produced: event.produced.filter((p) => p.artifact_role !== "restoration-probe"),
  }));
  assert.equal(
    refusalCode(() =>
      deriveEnvironmentSemantics({
        index: ArtifactIndex.scan(run.runRoot),
        lifecycle: withoutProbe,
        runId: run.runId,
      }),
    ),
    "RESTORATION_PROBE_MISSING",
  );
  // And the unmutated terminal derives cleanly, so the result above is the
  // removal and not something else about this run.
  assert.equal(
    refusalCode(() =>
      deriveEnvironmentSemantics({
        index: ArtifactIndex.scan(run.runRoot),
        lifecycle: events,
        runId: run.runId,
      }),
    ),
    undefined,
  );
});

// -- 3. the outcome arithmetic, in isolation ---------------------------------

test("COMPENSATION-ADV: `reverted nothing` and `had nothing to revert` are different answers", () => {
  const entry = {
    mutationId: "m-1",
    mutationReceiptHash: `sha256:${"1".repeat(64)}` as Hash,
    targetIdentityHash: `sha256:${"2".repeat(64)}` as Hash,
  };

  // Nothing was applied and nothing was expected.
  assert.equal(
    deriveRestorationProbeOutcome({
      expected: [],
      observedBefore: [],
      observedAfter: [],
      probeStatus: "observed",
    }).outcome,
    "nothing_to_revert",
  );
  // A mutation was applied and is gone.
  assert.equal(
    deriveRestorationProbeOutcome({
      expected: [entry],
      observedBefore: ["m-1"],
      observedAfter: [],
      probeStatus: "observed",
    }).outcome,
    "reverted",
  );
  // A mutation was applied and is still there: the no-op compensation.
  const residual = deriveRestorationProbeOutcome({
    expected: [entry],
    observedBefore: ["m-1"],
    observedAfter: ["m-1"],
    probeStatus: "observed",
  });
  assert.equal(residual.outcome, "residual");
  assert.deepEqual(residual.residualExpected, ["m-1"]);
  // Something unrelated was reverted.
  const collateral = deriveRestorationProbeOutcome({
    expected: [entry],
    observedBefore: ["m-1", "operator-change"],
    observedAfter: [],
    probeStatus: "observed",
  });
  assert.equal(collateral.outcome, "collateral");
  assert.deepEqual(collateral.collateralReverted, ["operator-change"]);
  // Both at once is reported as the failure it was asked about.
  assert.equal(
    deriveRestorationProbeOutcome({
      expected: [entry],
      observedBefore: ["m-1", "operator-change"],
      observedAfter: ["m-1"],
      probeStatus: "observed",
    }).outcome,
    "residual",
  );
  // An unobservable driver fails closed whatever the sets say.
  assert.equal(
    deriveRestorationProbeOutcome({
      expected: [],
      observedBefore: [],
      observedAfter: [],
      probeStatus: "unavailable",
    }).outcome,
    "unobservable",
  );
});

test("COMPENSATION-ADV: a resumed compensation that already ran is not mistaken for a no-op", () => {
  // `observed_before` is evidence, not a precondition. A run resumed after a
  // crash adopts the completed compensation from the driver's operation log and
  // legitimately observes nothing applied before its own dispatch; requiring the
  // expected set to appear there would refuse a correctly reconciled restart.
  assert.equal(
    deriveRestorationProbeOutcome({
      expected: [
        {
          mutationId: "m-1",
          mutationReceiptHash: `sha256:${"1".repeat(64)}` as Hash,
          targetIdentityHash: `sha256:${"2".repeat(64)}` as Hash,
        },
      ],
      observedBefore: [],
      observedAfter: [],
      probeStatus: "observed",
    }).outcome,
    "reverted",
  );
});
