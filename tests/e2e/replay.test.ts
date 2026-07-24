/**
 * Idempotent replay + failure ownership (6R-B, review P1-2 / §7.3 / §7.5).
 *
 * The review's wedge: `acquire`, wait across a wall-clock second, `acquire`
 * again → the port re-ran, the record's fresh timestamps changed its bytes, the
 * re-freeze raised `ARTIFACT_ALREADY_FROZEN` (a Lab-owned conflict), which was
 * laundered into a fabricated *adapter* finding, leaving a healthy run wedged
 * with no terminal record.
 *
 * After the fix a replayed step returns its durable record without re-invoking
 * the port (so timing is irrelevant), never invalidates a healthy run, and never
 * fabricates an adapter finding.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { erl2Run, runToAcquired, runToValidTerminal } from "../support/cliRun.js";

function retainedNames(runRoot: string): string[] {
  return readdirSync(path.join(runRoot, "retained"));
}

test("REPLAY: replaying acquire on a healthy run is an idempotent no-op", () => {
  const run = runToAcquired();
  const durable = JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", "subject-acquisition-record.json"), "utf8"),
  ) as { core_hash: string };

  // Replay acquire in a fresh process. The guard returns the durable record
  // without re-invoking the port, so the result is byte-identical regardless of
  // the wall clock — the exact defect the review reproduced across a second.
  const replay = erl2Run(run, ["acquire"]);
  assert.equal(replay.exitCode, 0, `a replayed acquire must be a clean no-op: ${JSON.stringify(replay.body.errors)}`);
  assert.equal(
    (replay.body.data as { acquisition_record_hash: string }).acquisition_record_hash,
    durable.core_hash,
    "the replay returns the same durable record, byte-identical",
  );

  // No wedge, no fabricated ownership: a healthy run is not invalidated and no
  // Lab conflict is laundered into an adapter finding.
  const retained = retainedNames(run.runRoot);
  assert.ok(!retained.includes("invalid-run-record.json"), "a replay must not invalidate a healthy run");
  assert.ok(
    !retained.some((n) => n.startsWith("finding-adapter")),
    "a replay must not fabricate an adapter finding",
  );

  // The run is still healthy and continues normally.
  const freeze = erl2Run(run, ["freeze-package"]);
  assert.equal(freeze.exitCode, 0, `the run must continue after a replay: ${JSON.stringify(freeze.body.errors)}`);
});

test("POST-REVEAL: a stray subject command on a finalized run adds no external evidence (P2-5)", () => {
  const run = runToValidTerminal("failed"); // reaches generic_finalized
  const before = retainedNames(run.runRoot).sort();

  // A stray acquire / verify-package on a finalized run must not execute the
  // port or freeze a fabricated finding into the finalized run root.
  const strayAcquire = erl2Run(run, ["acquire"]);
  const strayVerify = erl2Run(run, ["verify-package", "--subject-id", "x", "--subject-version", "0.1.0"]);

  const after = retainedNames(run.runRoot).sort();
  assert.deepEqual(after, before, "no new retained evidence is produced by a stray subject command");
  // Whether refused (forbidden state) or an idempotent no-op, the run is never
  // mutated and no adapter finding is fabricated.
  for (const stray of [strayAcquire, strayVerify]) {
    assert.ok(
      !retainedNames(run.runRoot).some((n) => n.startsWith("finding-adapter")),
      "no fabricated adapter finding",
    );
    assert.ok(stray.exitCode === 0 || stray.body.errors[0]?.code === "STATE_POST_REVEAL_EXECUTION_FORBIDDEN");
  }
});

test("REPLAY: a crash between the record freeze and its outcome event auto-resumes (deterministic timestamps)", () => {
  const run = runToAcquired();
  const recordPath = path.join(run.runRoot, "retained", "subject-acquisition-record.json");
  const before = readFileSync(recordPath); // the durably frozen record.

  // Simulate a crash strictly between the acquisition-record freeze and its
  // lifecycle outcome event: drop the last (outcome) event so the record is
  // frozen but no event recorded it.
  const eventsDir = path.join(run.runRoot, "events");
  const events = readdirSync(eventsDir).filter((n) => n.endsWith(".json") && !n.endsWith(".frozen")).sort();
  const lastEvent = events[events.length - 1] as string;
  for (const name of [lastEvent, `${lastEvent}.frozen`]) {
    const p = path.join(eventsDir, name);
    chmodSync(p, 0o600);
    unlinkSync(p);
  }

  // Replaying acquire rebuilds byte-identical artifacts (timestamps are anchored
  // on the durable preregistration time), so the re-freeze is idempotent and the
  // missing outcome event is appended — the run resumes rather than wedging on
  // an ARTIFACT_ALREADY_FROZEN conflict.
  const replay = erl2Run(run, ["acquire"]);
  assert.equal(replay.exitCode, 0, `the run must auto-resume: ${JSON.stringify(replay.body.errors)}`);
  assert.ok(readFileSync(recordPath).equals(before), "the record is byte-identical after the resumed replay");

  // No fabricated adapter finding, and the run continues normally.
  const retained = retainedNames(run.runRoot);
  assert.ok(!retained.includes("invalid-run-record.json"), "no wedge");
  assert.ok(!retained.some((n) => n.startsWith("finding-adapter")), "no fabricated adapter finding");
  assert.equal(erl2Run(run, ["freeze-package"]).exitCode, 0, "the resumed run continues");
});

test("REPLAY: a second replay after continuing is still idempotent", () => {
  const run = runToAcquired();
  assert.equal(erl2Run(run, ["freeze-package"]).exitCode, 0);
  // Replaying an earlier step after the run has moved on is still a no-op that
  // returns the durable record, not a conflict.
  const replayAcquire = erl2Run(run, ["acquire"]);
  assert.equal(replayAcquire.exitCode, 0, JSON.stringify(replayAcquire.body.errors));
  // freeze-package again is likewise idempotent.
  const replayFreeze = erl2Run(run, ["freeze-package"]);
  assert.equal(replayFreeze.exitCode, 0, JSON.stringify(replayFreeze.body.errors));
});
