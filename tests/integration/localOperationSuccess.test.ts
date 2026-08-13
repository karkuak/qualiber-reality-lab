/**
 * A completed operation is not a successful operation.
 *
 * ## The defect these controls exist for
 *
 * The residue correction fixed two things, and the second was the more general.
 * `cleanupResult()` used to treat any `completed` record as an operation that
 * had succeeded — but `completed` has never meant that. It means the exchange
 * completed and its evidence froze; the adapter's own verdict lives in the
 * response envelope. A `stop` the adapter reported as `failed` therefore
 * discharged the cleanup obligation that a successful `start` had created, and
 * the observation reported `cleanup_complete` over a subject that was still
 * running.
 *
 * The fix — `succeeded()` requiring `state === "completed"` *and*
 * `response_status === "supported"` — shipped correct and unmeasured. An
 * independent review mutated `succeeded()` to ignore the adapter's verdict and
 * the entire repository test tree stayed green: 1,371 tests, 0 failures. Correct
 * and unproven is the same as unguarded, which is what the governed-port finding
 * had already established one file away.
 *
 * ## What is asserted
 *
 * Two real certified adapters run through the real `AdapterHost` subprocess over
 * the smallest lifecycle that reaches the decision: `start`, then `stop` as the
 * frozen cleanup suffix. The pair is identical except for the adapter's verdict
 * on `stop`, so every difference below is caused by that verdict and nothing
 * else. The assertions read the reduced cleanup result and the frozen evidence,
 * never `succeeded()` itself — a test that called the helper would prove only
 * that the helper computes what the helper computes.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CODES } from "@erl2/contracts";
import { LocalObservationCoordinator } from "@erl2/core";
import {
  LIFECYCLE_SHAPES,
  LOCAL_NOW,
  newLocalLifecycleHost,
} from "../support/localObservationFixtures.js";

const ENDED = "2026-08-12T18:00:03Z";

type Completed = { readonly core_hash: string; readonly request_hash: string; readonly response_envelope_hash: string };

/** Runs `start` then `stop` against one neutral adapter and reduces the result. */
function observe(kind: keyof typeof LIFECYCLE_SHAPES) {
  const fixture = newLocalLifecycleHost(kind);
  const coordinator = new LocalObservationCoordinator(fixture.plan);

  const started = coordinator.execute(fixture.host, fixture.request("start"), LOCAL_NOW, () => ENDED);
  assert.equal(started.state, "completed", "the start must complete for an obligation to exist");
  const start = started as unknown as Completed;

  const stopped = coordinator.execute(
    fixture.host,
    fixture.request("stop", {
      operation_id: "op-start",
      operation_record_hash: start.core_hash,
      request_hash: start.request_hash,
      outcome: "completed",
      response_envelope_hash: start.response_envelope_hash,
    }),
    LOCAL_NOW,
    () => ENDED,
  );

  return {
    started,
    stopped,
    cleanup: coordinator.cleanupResult(),
    result: coordinator.buildResult(LOCAL_NOW, ENDED),
  };
}

test("LOCAL-SUCCESS: an operation can complete while the adapter reports it failed", () => {
  const { started, stopped } = observe("failed");
  // Both halves of the distinction, on one record: the protocol exchange
  // reached its terminal state, and the adapter said the work did not happen.
  assert.equal(stopped.state, "completed");
  assert.equal(
    (stopped as { response_status?: string }).response_status,
    "failed",
    "the adapter's verdict must survive onto the frozen record",
  );
  // The control case: the start in the same run did succeed, so a reader cannot
  // dismiss the stop's verdict as this adapter being unable to report success.
  assert.equal((started as { response_status?: string }).response_status, "supported");
});

test("LOCAL-SUCCESS: a failed stop does not discharge the obligation a successful start created", () => {
  const { cleanup } = observe("failed");
  // Taken before the assertions below, which narrow these fields to the values
  // they just checked and would otherwise let the compiler answer the coherence
  // question that only the run should answer.
  const stopSaysDone = cleanup.stop === "completed";
  const statusSaysComplete = cleanup.status === "cleanup_complete";

  assert.equal(cleanup.stop, "failed", "a stop the adapter failed is not a stop that happened");
  assert.equal(cleanup.status, "cleanup_incomplete");
  assert.deepEqual(cleanup.reason_codes, [CODES.ADAPTER_LOCAL_CLEANUP_INCOMPLETE]);
  // The reduced result must also not contradict itself. `cleanupResult()`
  // expresses the adapter's verdict twice — once positively, to decide whether
  // an obligation was met, and once negatively, to decide whether a run that
  // happened blocks completeness. Reading the verdict in only one of them
  // yields evidence that reports the stop as done and the cleanup as unfinished
  // in the same breath, which is a state no honest observation can be in.
  assert.equal(
    stopSaysDone,
    statusSaysComplete,
    "the stop outcome and the cleanup status must tell the same story",
  );
});

test("LOCAL-SUCCESS: the same stop reported supported does discharge it", () => {
  // The positive control. Without it, "cleanup_incomplete" above would be
  // indistinguishable from a lifecycle that can never reach complete at all.
  const { stopped, cleanup } = observe("succeeded");
  assert.equal(stopped.state, "completed");
  assert.equal((stopped as { response_status?: string }).response_status, "supported");
  assert.equal(cleanup.stop, "completed");
  assert.equal(cleanup.status, "cleanup_complete");
  assert.deepEqual(cleanup.reason_codes, []);
});

test("LOCAL-SUCCESS: the two verdicts reduce to observably different evidence", () => {
  const failed = observe("failed");
  const succeeded = observe("succeeded");

  assert.notDeepEqual(failed.cleanup, succeeded.cleanup);
  assert.notEqual(
    failed.stopped.core_hash,
    succeeded.stopped.core_hash,
    "a failed and a supported stop must not share one record identity",
  );
  assert.notEqual(
    failed.result.core_hash,
    succeeded.result.core_hash,
    "the frozen observation result must carry the difference",
  );
  assert.equal(failed.result.status, "cleanup_incomplete");
  assert.equal(succeeded.result.status, "observed_complete");
});
