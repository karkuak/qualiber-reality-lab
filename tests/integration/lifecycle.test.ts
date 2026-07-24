/**
 * NOOP-LIFECYCLE state-machine and append-only persistence behaviour.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore } from "@erl2/integrity";
import {
  assertNoSubjectExecutionAfterReveal,
  assertTransitionAllowed,
  LifecycleLog,
  SteppingClock,
  TERMINAL_STATES,
  uuidV7From,
  verifyLifecycleChain,
} from "@erl2/core";

function newLog(): LifecycleLog {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-lifecycle-"));
  return new LifecycleLog({
    runId: uuidV7From(Date.parse("2026-07-01T00:00:00Z"), Buffer.alloc(10, 9)),
    store: new ArtifactStore(root),
    clock: new SteppingClock("2026-07-01T00:00:00Z", 1000),
  });
}

test("NOOP-LIFECYCLE: illegal transitions are refused by the design's table", () => {
  assertTransitionAllowed("created", "acquisition_preregistered", "acquisition_preregistered");
  assert.throws(
    () => assertTransitionAllowed("created", "case_selected", "skip"),
    /is not in the design state machine/,
  );
  assert.throws(
    () => assertTransitionAllowed("package_manifest_frozen", "eligibility_pool_manifest_frozen", "skip"),
    /is not in the design state machine/,
  );
  for (const terminal of TERMINAL_STATES) {
    if (terminal === "generic_finalized") continue;
    assert.throws(
      () => assertTransitionAllowed(terminal, "step_planned", "resurrect"),
      /no transition leaves terminal state/,
    );
  }
});

test("NOOP-LIFECYCLE: every non-terminal state can reach the invalid terminal", () => {
  assertTransitionAllowed("baseline_verified", "invalid_failure_detected", "failure");
  assertTransitionAllowed("selection_committed", "invalid_failure_detected", "failure");
  assertTransitionAllowed("teardown_started", "invalid_failure_detected", "failure");
});

test("NOOP-LIFECYCLE: same operation id with same bytes is idempotent, different bytes conflict", () => {
  const log = newLog();
  const first = log.append({
    eventType: "acquisition_preregistered",
    stateTo: "acquisition_preregistered",
    actorId: "operator",
    commandId: "preregister-acquisition",
    operationId: "op-1",
  });
  const replay = log.append({
    eventType: "acquisition_preregistered",
    stateTo: "acquisition_preregistered",
    actorId: "operator",
    commandId: "preregister-acquisition",
    operationId: "op-1",
  });
  assert.equal(replay.core_hash, first.core_hash);
  assert.equal(log.sequence, 1);
  assert.throws(
    () =>
      log.append({
        eventType: "acquisition_preregistered",
        stateTo: "acquisition_preregistered",
        actorId: "someone-else",
        commandId: "preregister-acquisition",
        operationId: "op-1",
      }),
    /already applied with different bytes/,
  );
});

test("NOOP-LIFECYCLE: the event chain verifies and rejects a fork", () => {
  const log = newLog();
  log.append({
    eventType: "acquisition_preregistered",
    stateTo: "acquisition_preregistered",
    actorId: "operator",
    commandId: "preregister-acquisition",
    operationId: "op-1",
  });
  log.append({
    eventType: "subject_acquisition_planned",
    stateTo: "step_planned",
    actorId: "operator",
    commandId: "acquire",
    operationId: "op-2",
  });
  const events = log.all();
  assert.equal(verifyLifecycleChain(events), events[1]?.core_hash);
  assert.throws(() => verifyLifecycleChain([events[1]!]), /lifecycle sequence gap|fork/);
  assert.throws(() => verifyLifecycleChain([]), /empty lifecycle stream/);
});

test("STATE-POST-REVEAL: subject execution after a reveal is forbidden", () => {
  assert.throws(
    () => assertNoSubjectExecutionAfterReveal("truth_revealed"),
    /execution is forbidden in state/,
  );
  assertNoSubjectExecutionAfterReveal("step_planned");
});

test("NOOP-LIFECYCLE: a run lease prevents a second mutator", () => {
  const log = newLog();
  log.acquireLease("holder-a");
  assert.throws(() => log.acquireLease("holder-b"), /run lease already held/);
  log.releaseLease("holder-a");
  log.acquireLease("holder-b");
});
