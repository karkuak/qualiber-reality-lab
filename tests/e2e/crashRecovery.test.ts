/**
 * Crash / replay matrix (6R-B §7.8, ADR-ERL2-018).
 *
 * Each case simulates a crash at a specific durability boundary by manipulating
 * the on-disk run state, then runs the next command and asserts the exit-gate
 * invariants: no duplicated external execution, no permanent wedging, no
 * uncatalogued crash — recovery from the authoritative sources or a typed,
 * safe refusal.  (Replay idempotency, concurrent-replay serialization and
 * post-reveal refusal are covered in replay.test.ts / runLease.test.ts /
 * postRevealExecution.test.ts; this file covers the freeze, snapshot and
 * ordering boundaries.)
 *
 * Boundaries whose full auto-resume needs byte-deterministic record timestamps
 * (a crash strictly between a record freeze and its lifecycle event) are called
 * out in ADR-ERL2-018 as the remaining 6R-B work and are not asserted as
 * recovered here.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore } from "@erl2/integrity";
import { erl2, erl2Run, runToAcquired, runToPreregistered } from "../support/cliRun.js";

function freezeInput(bytes: Buffer) {
  return { logicalPath: "raw/blob.bin", bytes, mediaType: "application/octet-stream", classification: "INTERNAL" as const };
}

test("CRASH-FREEZE: a markerless artifact (crash between link and marker) re-freezes to completion", () => {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-freeze-"));
  const store = new ArtifactStore(root);
  const ref = store.freeze(freezeInput(Buffer.from("hello world")));
  const marker = path.join(root, "raw", "blob.bin.frozen");
  const content = path.join(root, "raw", "blob.bin");
  // Simulate the crash: the content is linked but the marker never got written.
  chmodSync(marker, 0o600);
  unlinkSync(marker);
  assert.ok(existsSync(content) && !existsSync(marker), "markerless content present");

  // Re-freezing identical bytes completes the freeze (marker restored).
  const again = new ArtifactStore(root).freeze(freezeInput(Buffer.from("hello world")));
  assert.equal(again.file_sha256, ref.file_sha256);
  assert.ok(existsSync(marker), "the marker is restored on recovery");

  // Re-freezing different bytes at the same path is a typed conflict, not a wedge.
  assert.throws(
    () => new ArtifactStore(root).freeze(freezeInput(Buffer.from("different"))),
    (e: unknown) => (e as { code?: string }).code === "ARTIFACT_ALREADY_FROZEN",
  );
});

test("CRASH-FREEZE: a corrupt/partial marker re-freezes to completion when the bytes match", () => {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-freeze2-"));
  new ArtifactStore(root).freeze(freezeInput(Buffer.from("payload")));
  const marker = path.join(root, "raw", "blob.bin.frozen");
  chmodSync(marker, 0o600);
  writeFileSync(marker, "{ this is not valid json", { mode: 0o600 }); // partial marker.

  const again = new ArtifactStore(root).freeze(freezeInput(Buffer.from("payload")));
  assert.ok(again.file_sha256.startsWith("sha256:"));
  // The marker is now valid JSON again.
  const restored = JSON.parse(readFileSync(marker, "utf8")) as { file_sha256: string };
  assert.equal(restored.file_sha256, again.file_sha256);
});

test("CRASH-SNAPSHOT: a torn derived snapshot does not crash status; state is rebuilt from events", () => {
  const run = runToAcquired();
  const snapshotPath = path.join(run.runRoot, "state", "snapshot.json");
  chmodSync(snapshotPath, 0o600);
  writeFileSync(snapshotPath, "{ torn snapshot ", { mode: 0o600 });

  const status = erl2(["status", "--run", run.runId, "--artifact-root", run.runRoot]);
  assert.equal(status.exitCode, 0, `status must recover from a torn snapshot: ${JSON.stringify(status.body.errors)}`);
  assert.equal(status.body.run_id, run.runId);
  assert.ok(typeof status.body.state === "string" && status.body.state.length > 0);
});

test("CRASH-SNAPSHOT: a missing snapshot does not crash status", () => {
  const run = runToAcquired();
  rmSync(path.join(run.runRoot, "state", "snapshot.json"), { force: true });
  const status = erl2(["status", "--run", run.runId, "--artifact-root", run.runRoot]);
  assert.equal(status.exitCode, 0, JSON.stringify(status.body.errors));
  assert.equal(status.body.run_id, run.runId);
});

test("CRASH-SNAPSHOT: a torn snapshot does not block a mutating command (events are authoritative)", () => {
  const run = runToAcquired();
  const snapshotPath = path.join(run.runRoot, "state", "snapshot.json");
  chmodSync(snapshotPath, 0o600);
  writeFileSync(snapshotPath, "garbage", { mode: 0o600 });
  const freeze = erl2Run(run, ["freeze-package"]);
  assert.equal(freeze.exitCode, 0, `a mutating command rebuilds from events: ${JSON.stringify(freeze.body.errors)}`);
});

test("CRASH-ORDER: an out-of-order command is a typed refusal, not a wedge", () => {
  const run = runToPreregistered();
  // verify-package before acquire: refused with a typed code, zero external effect.
  const early = erl2Run(run, ["verify-package", "--subject-id", "x", "--subject-version", "0.1.0"]);
  assert.notEqual(early.exitCode, 0, "an out-of-order step must be refused");
  assert.ok(
    !readFileSync(path.join(run.runRoot, "state", "snapshot.json"), "utf8").includes("invalidated"),
    "the run is not wedged or invalidated by an out-of-order refusal",
  );
  // The run is unharmed and proceeds normally.
  assert.equal(erl2Run(run, ["acquire"]).exitCode, 0, "the run continues after an out-of-order refusal");
});

test("CRASH-ORDER: an out-of-order run can still always reach a terminal via cancel", () => {
  const run = runToPreregistered();
  erl2Run(run, ["verify-package", "--subject-id", "x", "--subject-version", "0.1.0"]); // refused, no-op
  // Even a run stuck by operator error is never permanently wedged: cancel
  // reaches the mandatory terminal.
  const cancelled = erl2Run(run, ["cancel", "--reason", "operator_gaveup"]);
  assert.equal(cancelled.exitCode, 12, `cancel must always reach a terminal: ${JSON.stringify(cancelled.body.errors)}`);
});
