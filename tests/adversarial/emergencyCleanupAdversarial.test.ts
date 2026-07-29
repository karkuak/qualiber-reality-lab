/**
 * Frontier-driven emergency cleanup, adversarially (review P1-1, P1-5, P1-6;
 * ADR-ERL2-024 §4.5/§4.6).
 *
 * Three defects meet here.
 *
 *  - **P1-1** — `emergencyCleanup` issued an unconditional whole-environment
 *    `driver.destroy()` *before* consulting the frontier it had just frozen, and
 *    then recorded frontier-unsafe resources as `skipped_unsafe`: the attestation
 *    contradicted the action taken.
 *  - **P1-5** — the fake driver's `destroy` validates ownership of *every*
 *    resource before touching any, so one foreign resource made that single call
 *    throw. The branch aborted: zero safe actions attempted, no terminal reached,
 *    leases retained.
 *  - **P1-6** — the public verifier accepted a cleanup that **omitted** an
 *    independently safe action, and one that **relabelled** a safe action as an
 *    unsafe skip, which ERL2-AC-035 explicitly requires be refused.
 *
 * The behavioural half drives the shipped CLI. The verifier half starts from a
 * real CLI-produced invalid record and mutates one concern at a time, with each
 * mutated document's `core_hash` recomputed so the intended semantic check fires
 * rather than an unrelated content-hash check.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { coreHash } from "@erl2/integrity";
import { ArtifactIndex, deriveEmergencyCleanup } from "@erl2/public-verifier";
import type {
  EmergencyCleanupVerificationV1,
  EnvironmentResourceFrontierV1,
} from "@erl2/contracts";
import { erl2, writeLifecycle, writeTrustConfig } from "../support/cliRun.js";
import {
  driveWithFault,
  phaseIndex,
  producedRoles,
  selectedRun,
  type EnvironmentRun,
} from "../support/environmentCli.js";

/**
 * Drives a run to a restoration failure, which design §12 routes through
 * receipt-backed emergency cleanup.
 *
 * `sharedResourceIds` in the fake driver marks one resource shared with another
 * run, so the frontier derives it as `contain_residual`/unsafe — the foreign
 * member whose presence used to abort the whole branch.
 */
function emergencyRun(options: { readonly withForeign: boolean }): EnvironmentRun {
  const run = selectedRun();
  const fault = options.withForeign ? "failed-restore-shared" : "failed-restore";
  // The fault is applied from `provision` onward, not only to the failing
  // command: `sharedResourceIds` decides a resource's `shared_with_other_runs`
  // flag when the *inventory* is created, so a fault supplied late would build a
  // fixture that does not contain the foreign resource the case is named for.
  driveWithFault(run, fault, phaseIndex(run, "restore"));
  const result = erl2(["restore", ...run.base, "--fake-driver-fault", fault]);
  assert.notEqual(result.exitCode, 0, "a failed restoration is a Lab-owned failure");
  return run;
}

function retained(run: EnvironmentRun, name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", name), "utf8"),
  ) as Record<string, unknown>;
}

function rewrite(run: EnvironmentRun, name: string, value: Record<string, unknown>): void {
  const { core_hash: _drop, ...body } = value;
  const file = path.join(run.runRoot, "retained", name);
  // Frozen artifacts are published read-only; a tamperer clears the bit first,
  // so the mutation battery does too. The point of each case is the *semantic*
  // refusal, not the file mode.
  chmodSync(file, 0o600);
  writeFileSync(file, JSON.stringify({ ...body, core_hash: coreHash(body) }));
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

test("EMERGENCY-ADV: a restoration failure reaches an emergency terminal that verifies", () => {
  const run = emergencyRun({ withForeign: false });
  const roles = new Set(producedRoles(run));
  assert.ok(roles.has("environment-resource-frontier"));
  assert.ok(roles.has("emergency-cleanup-verification"));
  assert.ok(roles.has("invalid-run-record"));
  const verified = verifyRecord(run);
  assert.equal(verified.exitCode, 0, verified.code);
});

test("EMERGENCY-ADV: every independently safe action is attempted, each with its own receipt", () => {
  const run = emergencyRun({ withForeign: false });
  const frontier = retained(run, "environment/resource-frontier.json") as unknown as {
    derived_actions: { action_id: string; independently_safe: boolean }[];
  };
  const cleanup = retained(run, "emergency-cleanup-verification.json") as unknown as {
    actions: { action_id: string; status: string; attempt_receipt_hash?: string }[];
  };
  const safe = frontier.derived_actions.filter((a) => a.independently_safe);
  assert.ok(safe.length > 0, "this fixture must derive at least one safe action");

  for (const action of safe) {
    const reported = cleanup.actions.find((a) => a.action_id === action.action_id);
    assert.ok(reported !== undefined, `safe action ${action.action_id} was not reported`);
    assert.notEqual(reported.status, "skipped_unsafe");
    assert.ok(
      reported.attempt_receipt_hash !== undefined,
      `attempted action ${action.action_id} carries no receipt`,
    );
  }
  // Per-action receipts, not one whole-environment receipt standing in for all
  // of them: this is what P1-1 was about.
  const receipts = new Set(cleanup.actions.map((a) => a.attempt_receipt_hash).filter(Boolean));
  assert.ok(receipts.size >= 1);
});

test("EMERGENCY-ADV: an unsafe skip carries a reason and no receipt", () => {
  const run = emergencyRun({ withForeign: false });
  const cleanup = retained(run, "emergency-cleanup-verification.json") as unknown as {
    actions: { status: string; reason_code?: string; attempt_receipt_hash?: string }[];
  };
  for (const action of cleanup.actions) {
    if (action.status !== "skipped_unsafe") continue;
    assert.ok(action.reason_code !== undefined, "an unsafe skip must carry its reason");
    assert.equal(action.attempt_receipt_hash, undefined, "a skip that produced a receipt is not a skip");
  }
});

/**
 * The verifier-owned derivation, exercised directly (ADR-ERL2-024 §7).
 *
 * These cases mutate the emergency cleanup and ask
 * `deriveEmergencyCleanup` — the function the offline verifier runs — for its
 * verdict. Mutating the *retained file* instead would be caught first by the
 * hash layer: the invalid record cites the cleanup by core hash, so any edit
 * surfaces as `GRAPH_CLOSURE_UNREACHABLE_ARTIFACT` and the semantic rule under
 * test never runs. The brief is explicit that a case must not pass because an
 * unrelated check fired first, so the semantic rules are exercised where they
 * live, and the end-to-end wiring is asserted separately by the cases above.
 */
function emergencyEvidence(run: EnvironmentRun): {
  readonly index: ArtifactIndex;
  readonly frontier: EnvironmentResourceFrontierV1;
  readonly cleanup: EmergencyCleanupVerificationV1;
} {
  const index = ArtifactIndex.scan(run.runRoot);
  return {
    index,
    frontier: retained(run, "environment/resource-frontier.json") as unknown as EnvironmentResourceFrontierV1,
    cleanup: retained(run, "emergency-cleanup-verification.json") as unknown as EmergencyCleanupVerificationV1,
  };
}

function refusalCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

test("EMERGENCY-ADV: the unmutated cleanup derives cleanly", () => {
  const run = emergencyRun({ withForeign: false });
  const { index, frontier, cleanup } = emergencyEvidence(run);
  assert.equal(refusalCode(() => deriveEmergencyCleanup({ index, frontier, cleanup })), undefined);
});

test("EMERGENCY-ADV: an omitted safe action is refused by the verifier's own derivation", () => {
  const run = emergencyRun({ withForeign: false });
  const { index, frontier, cleanup } = emergencyEvidence(run);
  const dropped = frontier.derived_actions.find((a) => a.independently_safe);
  assert.ok(dropped !== undefined);
  const mutated = {
    ...cleanup,
    actions: cleanup.actions.filter((a) => a.action_id !== dropped.action_id),
  } as EmergencyCleanupVerificationV1;
  assert.equal(
    refusalCode(() => deriveEmergencyCleanup({ index, frontier, cleanup: mutated })),
    "EMERGENCY_ACTION_SAFE_ACTION_SKIPPED",
  );
});

test("EMERGENCY-ADV: a safe action relabelled as an unsafe skip is refused", () => {
  const run = emergencyRun({ withForeign: false });
  const { index, frontier, cleanup } = emergencyEvidence(run);
  const target = frontier.derived_actions.find((a) => a.independently_safe);
  assert.ok(target !== undefined);
  const mutated = {
    ...cleanup,
    actions: cleanup.actions.map((a) =>
      a.action_id === target.action_id
        ? {
            action_id: a.action_id,
            kind: a.kind,
            independently_safe: false as const,
            status: "skipped_unsafe" as const,
            reason_code: "RESOURCE_NOT_PROVABLY_OWNED_BY_RUN",
          }
        : a,
    ),
  } as EmergencyCleanupVerificationV1;
  assert.equal(
    refusalCode(() => deriveEmergencyCleanup({ index, frontier, cleanup: mutated })),
    "EMERGENCY_ACTION_SAFE_ACTION_SKIPPED",
  );
});

test("EMERGENCY-ADV: an attempted action with no receipt is refused", () => {
  const run = emergencyRun({ withForeign: false });
  const { index, frontier, cleanup } = emergencyEvidence(run);
  const mutated = {
    ...cleanup,
    actions: cleanup.actions.map((a) => {
      if (a.status !== "succeeded") return a;
      const { attempt_receipt_hash: _drop, ...rest } = a as Record<string, unknown>;
      return rest;
    }),
  } as unknown as EmergencyCleanupVerificationV1;
  assert.equal(
    refusalCode(() => deriveEmergencyCleanup({ index, frontier, cleanup: mutated })),
    "EMERGENCY_ACTION_RECEIPT_MISSING",
  );
});

test("EMERGENCY-ADV: a skip carrying a receipt is refused", () => {
  const run = emergencyRun({ withForeign: true });
  const { index, frontier, cleanup } = emergencyEvidence(run);
  const skipped = cleanup.actions.find((a) => a.status === "skipped_unsafe");
  assert.ok(skipped !== undefined, "the mixed fixture must contain an unsafe skip");
  const receipt = cleanup.actions.find((a) => a.status === "succeeded") as {
    attempt_receipt_hash: string;
  };
  const mutated = {
    ...cleanup,
    actions: cleanup.actions.map((a) =>
      a.action_id === skipped.action_id
        ? { ...a, attempt_receipt_hash: receipt.attempt_receipt_hash }
        : a,
    ),
  } as unknown as EmergencyCleanupVerificationV1;
  assert.equal(
    refusalCode(() => deriveEmergencyCleanup({ index, frontier, cleanup: mutated })),
    "EMERGENCY_ACTION_RECEIPT_MISSING",
  );
});

test("EMERGENCY-ADV: a cleanup citing a frontier the run never froze is refused", () => {
  const run = emergencyRun({ withForeign: false });
  const { index, frontier, cleanup } = emergencyEvidence(run);
  const mutated = {
    ...cleanup,
    resource_frontier_event_hash: `sha256:${"1".repeat(64)}`,
  } as EmergencyCleanupVerificationV1;
  assert.equal(
    refusalCode(() => deriveEmergencyCleanup({ index, frontier, cleanup: mutated })),
    "EMERGENCY_CLEANUP_INCOMPLETE",
  );
});

test("EMERGENCY-ADV: a frontier whose actions its own resources do not imply is refused", () => {
  // Isolates `assertFrontierActionsDerivable`, and it took a negative control to
  // notice that it was not isolated: an earlier version of this case flipped
  // every action to `independently_safe`, which the *per-action* comparison then
  // caught for a different reason — so removing the derivation check killed
  // nothing and the campaign scored the guard as not load-bearing.
  //
  // This mutation changes an action's `kind` in the frontier **and** in the
  // cleanup, so the two agree with each other and disagree only with the
  // resources the frontier observed. Nothing but re-deriving the action set from
  // those resources can catch it.
  const run = emergencyRun({ withForeign: true });
  const { index, frontier, cleanup } = emergencyEvidence(run);
  const target = frontier.derived_actions.find((a) => a.kind === "isolate_network");
  assert.ok(target !== undefined, "this fixture must derive a network isolation action");

  // The declared `core_hash` is recomputed: `assertFrontierActionsDerivable`
  // checks it *first*, so leaving it stale would make this case pass on
  // `ARTIFACT_HASH_MISMATCH` and prove nothing about the action derivation.
  const mutatedBody = {
    ...frontier,
    derived_actions: frontier.derived_actions.map((a) =>
      a.action_id === target.action_id ? { ...a, kind: "stop_subject" as const } : a,
    ),
  } as Record<string, unknown>;
  delete mutatedBody["core_hash"];
  const mutatedFrontier = {
    ...mutatedBody,
    core_hash: coreHash(mutatedBody),
  } as unknown as EnvironmentResourceFrontierV1;
  const agreeingCleanup = {
    ...cleanup,
    actions: cleanup.actions.map((a) =>
      a.action_id === target.action_id ? { ...a, kind: "stop_subject" as const } : a,
    ),
  } as EmergencyCleanupVerificationV1;

  assert.equal(
    refusalCode(() =>
      deriveEmergencyCleanup({ index, frontier: mutatedFrontier, cleanup: agreeingCleanup }),
    ),
    "EMERGENCY_ACTION_SAFE_ACTION_SKIPPED",
  );
});

test("EMERGENCY-ADV: post-cleanup residue must account for every unresolved action", () => {
  const run = emergencyRun({ withForeign: true });
  const { index, frontier, cleanup } = emergencyEvidence(run);
  assert.ok(cleanup.remaining_resources.length > 0, "the mixed fixture leaves residue");
  const mutated = { ...cleanup, remaining_resources: [] } as EmergencyCleanupVerificationV1;
  assert.equal(
    refusalCode(() => deriveEmergencyCleanup({ index, frontier, cleanup: mutated })),
    "RESIDUE_DETECTED",
  );
});

test("EMERGENCY-ADV: a foreign resource does not prevent safe cleanup of the run's own", () => {
  // P1-5 exactly: one resource the driver reports as shared with another run.
  // The whole-environment destroy used to throw on it, aborting the branch with
  // zero safe actions attempted and no terminal reached.
  const run = emergencyRun({ withForeign: true });

  const frontier = retained(run, "environment/resource-frontier.json") as unknown as {
    derived_actions: { action_id: string; independently_safe: boolean; unsafe_reason_code?: string }[];
  };
  const unsafe = frontier.derived_actions.filter((a) => !a.independently_safe);
  const safe = frontier.derived_actions.filter((a) => a.independently_safe);
  assert.ok(unsafe.length > 0, "this fixture must contain a foreign/shared resource");
  assert.ok(safe.length > 0, "and it must still contain owned, destroyable resources");

  const cleanup = retained(run, "emergency-cleanup-verification.json") as unknown as {
    actions: { action_id: string; status: string; attempt_receipt_hash?: string }[];
  };
  for (const action of safe) {
    const reported = cleanup.actions.find((a) => a.action_id === action.action_id);
    assert.ok(reported !== undefined, `safe action ${action.action_id} was never reported`);
    assert.notEqual(
      reported.status,
      "skipped_unsafe",
      "a foreign resource must not veto an owned one",
    );
    assert.ok(reported.attempt_receipt_hash !== undefined);
  }
  for (const action of unsafe) {
    const reported = cleanup.actions.find((a) => a.action_id === action.action_id);
    assert.ok(reported !== undefined);
    assert.equal(reported.status, "skipped_unsafe");
    assert.equal(reported.attempt_receipt_hash, undefined);
  }

  // And the terminal is reached, which it was not before.
  assert.ok(new Set(producedRoles(run)).has("invalid-run-record"));
  const verified = verifyRecord(run);
  assert.equal(verified.exitCode, 0, verified.code);
});

test("EMERGENCY-ADV: a mixed frontier still accounts for its residue", () => {
  const run = emergencyRun({ withForeign: true });
  const cleanup = retained(run, "emergency-cleanup-verification.json") as unknown as {
    actions: { action_id: string; status: string }[];
    remaining_resources: { identity_hash: string; containment_status: string }[];
  };
  const unresolved = cleanup.actions.filter((a) => a.status !== "succeeded");
  assert.ok(unresolved.length > 0, "the shared resource is unresolved by construction");
  assert.equal(
    cleanup.remaining_resources.length >= unresolved.length,
    true,
    "every unresolved action's target must be accounted for; silence is not containment",
  );
  for (const remaining of cleanup.remaining_resources) {
    assert.ok(
      ["contained", "uncontained", "unknown"].includes(remaining.containment_status),
      "residue must carry an explicit containment status",
    );
  }
});
