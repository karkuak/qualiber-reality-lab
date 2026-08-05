/**
 * The receipt the Lab writes on the driver's behalf, when it writes two of them.
 *
 * ## The defect
 *
 * `executeFrontierDerivedCleanup` makes one bounded second attempt at any safe
 * action whose target the substrate still reports. `attemptOnce(action, pass)`
 * derived the operation id correctly —
 * `emergencyOperationId(runId, action_id, pass)` — and opened the durable intent
 * and called the driver under it. But when the dispatch *threw*, the catch path
 * called `failedActionReceipt(ctx, targetResourceId, actionId, cause)`, which
 * independently rederived
 *
 *     emergencyOperationId(ctx.runId, actionId)
 *
 * with `attempt` defaulting to 1. So a failed second attempt was dispatched and
 * journaled under the attempt-2 id while its retained receipt claimed the
 * attempt-1 id. Its `idempotency_key` was `{run, action}`, which does not
 * mention the attempt at all, so it could not distinguish them either.
 *
 * Two consequences, and the second is worse than the first:
 *
 *  1. **Incorrect audit binding.** The intent journal and the retained receipt
 *     name different operations for one dispatch. A reader reconciling them sees
 *     an attempt-2 intent with no receipt and an attempt-1 receipt with no
 *     matching dispatch.
 *  2. **A bundle that cannot verify.** Every field of the two synthetic receipts
 *     was then identical except `started_at`/`ended_at`, which come from the
 *     run's clock at second precision. Two failed attempts inside one second
 *     produced byte-identical documents, so both retained files claimed one
 *     `core_hash` — and `verifyRetainedFileAccounting` refuses exactly that: "a
 *     retained core hash must identify exactly one retained file".
 *
 * ## Why this control needs its own driver fault
 *
 * The catch path is the only place the Lab authors an emergency receipt, and no
 * shipped fault reached it. `residualResourceIds` makes the frontier classify
 * the action unsafe, so it is never dispatched; `failTeardown` makes the driver
 * *receipt* its failure, which the executor records directly; a foreign resource
 * fails ownership and is again classified unsafe.
 * `throwOnDestroyResourceIds` is the narrow addition that makes an owned,
 * destroyable, independently-safe action throw — twice — so the path is
 * reachable from a run rather than only from an argument.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { emergencyOperationId } from "@erl2/core";
import type {
  CleanupResidueProbeV1,
  EmergencyCleanupVerificationV1,
  EnvironmentOperationReceiptV1,
  EnvironmentResourceFrontierV1,
  InvalidLabRunRecordV1,
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

/** The contract's identifier shape, written out rather than referred to. */
const ID = /^[a-z][a-z0-9-]{0,63}$/;

const FAULT = "failed-restore-destroy-throws";

/**
 * A run whose restoration failed and whose `volume-*` destroy throws every time.
 *
 * The fault is applied from `provision` onward for the same reason the sibling
 * fixtures do it: the inventory that the frontier is later derived from is built
 * at provision time, so a fault supplied only to the failing command would build
 * a different environment from the one the case is named for.
 */
function throwingCleanupRun(): EnvironmentRun {
  const run = selectedRun();
  driveWithFault(run, FAULT, phaseIndex(run, "restore"));
  const restored = erl2(["restore", ...run.base, "--fake-driver-fault", FAULT]);
  assert.notEqual(restored.exitCode, 0, "a failed restoration is a Lab-owned failure");
  return run;
}

function retainedJson<T>(run: EnvironmentRun, ...segments: readonly string[]): T {
  return JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", ...segments), "utf8"),
  ) as T;
}

/** Every retained emergency receipt file, by its root-relative path. */
function emergencyReceiptFiles(run: EnvironmentRun): ReadonlyMap<string, EnvironmentOperationReceiptV1> {
  const root = path.join(run.runRoot, "retained", "environment");
  const found = new Map<string, EnvironmentOperationReceiptV1>();
  for (const name of readdirSync(root).sort()) {
    if (!name.startsWith("emergency-receipt-") || !name.endsWith(".json")) continue;
    found.set(
      `retained/environment/${name}`,
      JSON.parse(readFileSync(path.join(root, name), "utf8")) as EnvironmentOperationReceiptV1,
    );
  }
  return found;
}

/** The driver's own journal of operations it completed, read from the substrate. */
function completedOperationIds(run: EnvironmentRun): readonly string[] {
  const file = path.join(
    substrateRootOf(run),
    `${Buffer.from(run.runId, "utf8").toString("base64url")}.substrate.json`,
  );
  if (!existsSync(file)) return [];
  const state = JSON.parse(readFileSync(file, "utf8")) as {
    operations?: Record<string, unknown>;
  };
  return Object.keys(state.operations ?? {});
}

const RUN = throwingCleanupRun();

test("SECOND-ATTEMPT: the throwing action is attempted twice under two distinct ids", () => {
  const frontier = retainedJson<EnvironmentResourceFrontierV1>(
    RUN,
    "environment",
    "resource-frontier.json",
  );
  const throwing = frontier.derived_actions.find(
    (a) => a.independently_safe && a.target_resource_id === `volume-${RUN.runId.slice(0, 8)}`,
  );
  assert.ok(throwing, "the fixture must derive an independently safe action for the throwing volume");

  const first = emergencyOperationId(RUN.runId, throwing.action_id, 1);
  const second = emergencyOperationId(RUN.runId, throwing.action_id, 2);
  assert.notEqual(first, second, "the two attempts must not share an operation id");
  assert.match(first, ID);
  assert.match(second, ID);

  // Both attempts really happened, and each retained its own receipt.
  const receipts = emergencyReceiptFiles(RUN);
  const firstPath = `retained/environment/emergency-receipt-${first}.json`;
  const secondPath = `retained/environment/emergency-receipt-${second}.json`;
  assert.ok(receipts.has(firstPath), `no retained receipt at ${firstPath}`);
  assert.ok(receipts.has(secondPath), `no retained receipt at ${secondPath}`);
  assert.notEqual(firstPath, secondPath, "both attempts wrote to one path");

  // The regression itself. Under the defect the pass-2 receipt carried the
  // pass-1 operation id, so this is the assertion that fails without the fix.
  const pass1 = receipts.get(firstPath) as EnvironmentOperationReceiptV1;
  const pass2 = receipts.get(secondPath) as EnvironmentOperationReceiptV1;
  assert.equal(pass1.operation_id, first);
  assert.equal(pass2.operation_id, second, "the second attempt's receipt names the first attempt");
  assert.equal(pass1.status, "failed");
  assert.equal(pass2.status, "failed");

  // …and they are genuinely two documents, not one aliased twice. The
  // idempotency key is what distinguishes them independently of the clock: under
  // the defect it was keyed on the action alone, so two attempts inside one
  // second produced byte-identical receipts that collided on one `core_hash`.
  assert.notEqual(pass1.idempotency_key, pass2.idempotency_key);
  assert.notEqual(pass1.core_hash, pass2.core_hash, "two attempts collapsed into one artifact");
  assert.equal(new Set([...receipts.values()].map((r) => r.core_hash)).size, receipts.size);
});

test("SECOND-ATTEMPT: neither thrown dispatch is journaled as a completed operation", () => {
  const frontier = retainedJson<EnvironmentResourceFrontierV1>(
    RUN,
    "environment",
    "resource-frontier.json",
  );
  const throwing = frontier.derived_actions.find(
    (a) => a.independently_safe && a.target_resource_id === `volume-${RUN.runId.slice(0, 8)}`,
  );
  assert.ok(throwing);
  const completed = new Set(completedOperationIds(RUN));

  // The driver threw before changing anything, so it remembered no operation
  // under either id. A dispatch that threw stays ambiguous: the executor does
  // not settle its durable intent, and nothing here re-dispatches under some
  // other key to make the ledger look tidy.
  for (const pass of [1, 2] as const) {
    const operationId = emergencyOperationId(RUN.runId, throwing.action_id, pass);
    assert.equal(
      completed.has(operationId),
      false,
      `the driver journaled ${operationId} as completed although it threw`,
    );
  }
  // The actions that did not throw are journaled, so the assertion above is
  // about throwing specifically and not about an empty journal.
  const succeeded = frontier.derived_actions.filter(
    (a) => a.independently_safe && a.target_resource_id !== throwing.target_resource_id,
  );
  assert.ok(succeeded.length > 0, "the fixture must also derive actions that do not throw");
  assert.ok(
    succeeded.some((a) => completed.has(emergencyOperationId(RUN.runId, a.action_id, 1))),
    "no non-throwing action reached the driver's journal",
  );
});

test("SECOND-ATTEMPT: the cleanup terminal reports the surviving resource honestly", () => {
  const target = `volume-${RUN.runId.slice(0, 8)}`;
  const verification = retainedJson<EmergencyCleanupVerificationV1>(
    RUN,
    "emergency-cleanup-verification.json",
  );
  const frontier = retainedJson<EnvironmentResourceFrontierV1>(
    RUN,
    "environment",
    "resource-frontier.json",
  );
  const throwing = frontier.derived_actions.find(
    (a) => a.independently_safe && a.target_resource_id === target,
  );
  assert.ok(throwing);

  // Exactly one attempt entry per derived action, whichever pass produced it,
  // and the throwing one is reported failed rather than quietly retried away.
  assert.equal(verification.actions.length, frontier.derived_actions.length);
  const reported = verification.actions.find((a) => a.action_id === throwing.action_id);
  assert.equal(reported?.status, "failed", "a surviving target was reported as cleaned");
  assert.equal(
    (reported as { reason_code?: string }).reason_code,
    "ENV_SUBSTRATE_UNREADABLE",
    "the reported reason is not the driver's own refusal code",
  );
  // Its receipt is the *second* attempt's, because that is the attempt whose
  // outcome the record describes.
  assert.equal(
    (reported as { attempt_receipt_hash?: string }).attempt_receipt_hash,
    retainedJson<EnvironmentOperationReceiptV1>(
      RUN,
      "environment",
      `emergency-receipt-${emergencyOperationId(RUN.runId, throwing.action_id, 2)}.json`,
    ).core_hash,
  );

  // The residue probe is an observation of the substrate, not a summary of the
  // action outcomes: the target is still there and is named.
  const probe = retainedJson<CleanupResidueProbeV1>(RUN, "environment", "cleanup-residue-probe.json");
  assert.ok(
    probe.residual_resources.includes(target),
    `the residue probe does not name the surviving ${target}`,
  );

  const record = retainedJson<InvalidLabRunRecordV1>(RUN, "invalid-run-record.json");
  assert.equal(record.cleanup.status, "attempted_failed");
  assert.ok(
    record.cleanup.attempt_hashes.length >= verification.actions.length,
    "a two-attempt action must contribute both of its receipts to the terminal",
  );
});

test("SECOND-ATTEMPT: the invalid terminal verifies offline", () => {
  const roles = new Set(producedRoles(RUN));
  assert.ok(roles.has("environment-resource-frontier"));
  assert.ok(roles.has("emergency-cleanup-verification"));
  assert.ok(roles.has("invalid-run-record"));

  const verified = erl2([
    "verify-record",
    "--record", path.join(RUN.runRoot, "retained", "invalid-run-record.json"),
    "--lifecycle", writeLifecycle(RUN.runRoot),
    "--artifact-root", RUN.runRoot,
    "--root-config", writeTrustConfig(RUN.runRoot),
    "--offline",
  ]);
  // Under the defect the two synthetic receipts could collide on one core hash,
  // which this refuses as `GRAPH_CLOSURE_EXTRA_ARTIFACT` — so this case is a
  // control over the retained-file accounting as well as over the record.
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  const closure = (verified.body.data as { closure?: { rejected_extra_hashes?: string[] } }).closure;
  assert.deepEqual(closure?.rejected_extra_hashes ?? [], []);
});
