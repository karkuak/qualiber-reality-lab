/**
 * Run identity is the workspace's, not the caller's (review P1-8,
 * ADR-ERL2-024 §4.1).
 *
 * `openWorkspace(flags, runId)` took `--run` and `--run-root` as independent
 * inputs and never cross-validated them, so `erl2 <command> --run <any-uuid>
 * --run-root <another run's root>` acquired that root's lease, resolved that
 * root's evidence and appended to that root's lifecycle under a claimed identity
 * that was not the run's. The defect lives in shared, pre-existing CLI code, so
 * it applies to Slice 6.5-A and to `main` as well.
 *
 * What matters is not only that the mismatch refuses, but *when*: before the run
 * lease is taken or renewed, before any evidence is frozen, and before any
 * substrate or reservation directory is created.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { erl2, runToAcquired } from "../support/cliRun.js";
import { changed, manifest } from "../support/environmentCli.js";
import { AdmissionRegistry, RunWorkspace, FakeSubjectPort, SystemClock } from "@erl2/core";
import { developmentKey } from "@erl2/integrity";

const FOREIGN_RUN_ID = "019f1af9-b400-7444-8444-4444deadbeef";

function leaseSnapshot(runRoot: string): string | undefined {
  const file = path.join(runRoot, "state", "lease.json");
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

test("RUN-IDENTITY: a matching run id and run root operate normally", () => {
  const run = runToAcquired();
  const result = erl2([
    "freeze-package",
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ]);
  assert.equal(result.exitCode, 0, JSON.stringify(result.body.errors));
  assert.equal(result.body.run_id, run.runId);
});

test("RUN-IDENTITY: a wrong --run against another run's root is refused", () => {
  const run = runToAcquired();
  const result = erl2([
    "freeze-package",
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", FOREIGN_RUN_ID,
  ]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(
    result.body.errors[0]?.code,
    "POLICY_RUN_IDENTITY_MISMATCH",
    JSON.stringify(result.body.errors),
  );
});

test("RUN-IDENTITY: the refusal precedes the run lease and writes no evidence", () => {
  const run = runToAcquired();
  const before = manifest(run.runRoot);
  const leaseBefore = leaseSnapshot(run.runRoot);

  const result = erl2([
    "acquire",
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", FOREIGN_RUN_ID,
  ]);
  assert.equal(result.body.errors[0]?.code, "POLICY_RUN_IDENTITY_MISMATCH");

  // Nothing changed at all — including the lease, which `withRunLease` would
  // otherwise have taken and released, rewriting the file.
  assert.deepEqual(changed(before, manifest(run.runRoot)), []);
  assert.equal(leaseSnapshot(run.runRoot), leaseBefore);
});

test("RUN-IDENTITY: an environment command's refusal creates no substrate or reservation directory", () => {
  const run = runToAcquired();
  const substrate = `${path.resolve(run.runRoot)}.substrate`;
  const reservations = `${path.resolve(run.runRoot)}.reservations`;

  const result = erl2([
    "provision",
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", FOREIGN_RUN_ID,
    "--archetype", run.registry.archetypeHash,
  ]);
  assert.equal(
    result.body.errors[0]?.code,
    "POLICY_RUN_IDENTITY_MISMATCH",
    JSON.stringify(result.body.errors),
  );
  assert.equal(existsSync(substrate), false, "no substrate directory may be created");
  assert.equal(existsSync(reservations), false, "no reservation directory may be created");
});

test("RUN-IDENTITY: a direct library caller is refused on the same terms", () => {
  // The CLI is one caller. A library caller that never goes through it — the
  // shape this repository's own evidence harness uses — must be refused too, or
  // the invariant lives in the wrong layer.
  const run = runToAcquired();
  assert.throws(
    () =>
      new RunWorkspace({
        runId: FOREIGN_RUN_ID,
        runRoot: run.runRoot,
        registry: AdmissionRegistry.open(run.registry.root),
        clock: new SystemClock(),
        keyring: {
          preregistrar: developmentKey("preregistrar"),
          finalizer: developmentKey("finalizer"),
          timestampAuthority: developmentKey("timestamp"),
          evaluator: developmentKey("evaluator"),
        },
        tier: "development",
        subjectPort: new FakeSubjectPort({}),
      }),
    (error: unknown) => (error as { code?: string }).code === "POLICY_RUN_IDENTITY_MISMATCH",
  );
});

test("RUN-IDENTITY: a mutating command may not bring a run root into being", () => {
  // A typo in `--run-root` used to start a second, empty run rather than refuse.
  // Only `preregister-acquisition` may create a workspace.
  const run = runToAcquired();
  const empty = mkdtempSync(path.join(tmpdir(), "erl2-empty-root-"));
  const result = erl2([
    "acquire",
    "--run-root", empty,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(
    result.body.errors[0]?.code,
    "POLICY_RUN_IDENTITY_MISMATCH",
    JSON.stringify(result.body.errors),
  );
  assert.equal(existsSync(path.join(empty, "events")), false);
});

test("RUN-IDENTITY: repeated correct opens across fresh processes are stable", () => {
  const run = runToAcquired();
  const base = [
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ];
  for (let i = 0; i < 3; i += 1) {
    const status = erl2(["status", "--run", run.runId, "--artifact-root", run.runRoot]);
    assert.equal(status.exitCode, 0, JSON.stringify(status.body.errors));
    assert.equal(status.body.run_id, run.runId);
  }
  // And a real command still works after the repeated opens.
  assert.equal(erl2(["freeze-package", ...base]).exitCode, 0);
});

test("RUN-IDENTITY: run A's id against run B's root refuses, and B is byte-identical afterwards", () => {
  // The reported exploit verbatim: two runs the CLI actually created, rather
  // than one real run and a made-up UUID. Run A's id is a run the Lab really
  // accepted, which is the case a `!== ` check could still have got wrong by
  // validating the *shape* of the id instead of the workspace's record of it.
  const runA = runToAcquired();
  const runB = runToAcquired();
  assert.notEqual(runA.runId, runB.runId);

  const before = manifest(runB.runRoot);
  const leaseBefore = leaseSnapshot(runB.runRoot);
  const substrate = `${path.resolve(runB.runRoot)}.substrate`;
  const reservations = `${path.resolve(runB.runRoot)}.reservations`;

  const result = erl2([
    "acquire",
    "--run-root", runB.runRoot,
    "--registry", runB.registry.root,
    "--tier", "development",
    "--run", runA.runId,
  ]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(
    result.body.errors[0]?.code,
    "POLICY_RUN_IDENTITY_MISMATCH",
    JSON.stringify(result.body.errors),
  );

  // Byte-for-byte: no lease write, no snapshot change, no event append, no
  // retained artifact, no substrate or reservation directory. A refusal that
  // rewrites the lease has already touched the workspace it refused.
  assert.deepEqual(changed(before, manifest(runB.runRoot)), []);
  assert.equal(leaseSnapshot(runB.runRoot), leaseBefore);
  assert.equal(existsSync(substrate), false);
  assert.equal(existsSync(reservations), false);
  // And run A is untouched as well: the refusal is about B's workspace.
  assert.equal(
    erl2(["status", "--run", runA.runId, "--artifact-root", runA.runRoot]).exitCode,
    0,
  );
});

test("RUN-IDENTITY: a snapshot that disagrees with the hash-chained first event is refused", () => {
  // The snapshot is a derived cache and is authoritative for nothing, so it
  // decides no identity — but it must not *disagree* either. A snapshot naming
  // another run is a crossed workspace or a tampered cache, and both are
  // refusals rather than a silently preferred answer.
  const run = runToAcquired();
  const snapshotPath = path.join(run.runRoot, "state", "snapshot.json");
  assert.ok(existsSync(snapshotPath), "the run must have a derived snapshot to disagree with");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  assert.equal(snapshot["run_id"], run.runId);
  writeFileSync(snapshotPath, JSON.stringify({ ...snapshot, run_id: FOREIGN_RUN_ID }));

  const result = erl2([
    "freeze-package",
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(
    result.body.errors[0]?.code,
    "POLICY_RUN_IDENTITY_MISMATCH",
    JSON.stringify(result.body.errors),
  );
});

test("RUN-IDENTITY: a torn snapshot is tolerated; the chain stays authoritative", () => {
  // The other half of the same rule, and the reason it is not simply "refuse any
  // snapshot problem": §11.9 already requires every command to rebuild from the
  // authoritative event log when the cache cannot be read, so an unreadable
  // cache must not become an outage.
  const run = runToAcquired();
  writeFileSync(path.join(run.runRoot, "state", "snapshot.json"), "{ truncated");
  const result = erl2([
    "freeze-package",
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ]);
  assert.equal(result.exitCode, 0, JSON.stringify(result.body.errors));
});

test("RUN-IDENTITY: a partially initialized or corrupt workspace refuses rather than guessing", () => {
  const run = runToAcquired();
  const eventDir = path.join(run.runRoot, "events");
  const first = readdirSync(eventDir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".frozen"))
    .sort()[0] as string;
  const firstPath = path.join(eventDir, first);
  const original = readFileSync(firstPath, "utf8");

  for (const [label, bytes] of [
    ["unreadable", "{ not json"],
    ["identity-free", JSON.stringify({ schema_version: "lab-lifecycle-event/v1", sequence: 0 })],
    ["empty-identity", JSON.stringify({ ...JSON.parse(original), run_id: "" })],
  ] as const) {
    chmodSync(firstPath, 0o600);
    writeFileSync(firstPath, bytes);
    const result = erl2([
      "freeze-package",
      "--run-root", run.runRoot,
      "--registry", run.registry.root,
      "--tier", "development",
      "--run", run.runId,
    ]);
    assert.notEqual(result.exitCode, 0, `${label}: a workspace whose identity cannot be read must refuse`);
    // The directory name is never the answer, and neither is the flag: both name
    // this run, and the refusal happens anyway.
    assert.ok(
      result.body.errors[0]?.code.startsWith("VERIFY_") ||
        result.body.errors[0]?.code === "POLICY_RUN_IDENTITY_MISMATCH",
      `${label}: ${JSON.stringify(result.body.errors)}`,
    );
  }
  chmodSync(firstPath, 0o600);
  writeFileSync(firstPath, original);
});
