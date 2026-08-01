/**
 * Durable run-lease behaviour (6R-B §7.2, review P1-2).
 *
 * The lease is what makes a concurrent or replayed command safe: a second
 * mutator is refused (Lab-owned), a stale lease is recoverable under a bounded
 * TTL, a foreign owner cannot release an active lease, and a completed command
 * leaves no lease behind.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunLease } from "@erl2/core";
import { erl2Run, runToAcquired } from "../support/cliRun.js";

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "erl2-lease-"));
}

test("RUN-LEASE: a live lease held by another owner is a Lab-owned conflict", () => {
  const root = tempRoot();
  const held = RunLease.acquire(root, "owner-a", "acquire", 1_000);
  assert.throws(
    () => RunLease.acquire(root, "owner-b", "freeze-package", 1_500),
    (e: unknown) => (e as { code?: string; owner?: string }).code === "POLICY_RUN_LEASE_HELD",
    "a second live mutator must be refused",
  );
  held.release();
  // Once released, another owner may take it.
  const next = RunLease.acquire(root, "owner-b", "freeze-package", 2_000);
  next.release();
});

test("RUN-LEASE: a stale lease is recoverable under the bounded TTL", () => {
  const root = tempRoot();
  RunLease.acquire(root, "owner-a", "acquire", 1_000, 100); // expires at 1_100.
  // A later command past the expiry steals it instead of wedging forever.
  const recovered = RunLease.acquire(root, "owner-b", "freeze-package", 5_000);
  assert.ok(recovered, "an expired lease must be recoverable");
  recovered.release();
});

test("RUN-LEASE: reacquiring one's own lease is idempotent and release is owner-checked", () => {
  const root = tempRoot();
  const leasePath = path.join(root, "state", "lease.json");
  const a = RunLease.acquire(root, "owner-a", "acquire", 1_000);
  // Reacquiring under the same owner does not throw (a resumed same-process run).
  RunLease.acquire(root, "owner-a", "acquire", 1_100);
  assert.ok(existsSync(leasePath));
  // If the lease on disk now belongs to someone else (a bounded-TTL takeover),
  // owner-a's release must NOT remove the foreign lease.
  writeFileSync(
    leasePath,
    JSON.stringify({ owner: "owner-b", command: "x", acquired_at_ms: 9_000, expires_at_ms: 9_999_999, pid: 1 }),
  );
  a.release();
  assert.ok(existsSync(leasePath), "a foreign owner's active lease is never released");
});

test("RUN-LEASE: a completed CLI command leaves no lease behind", () => {
  const run = runToAcquired();
  // `acquire` already ran and released; the lease file must be gone.
  assert.ok(!existsSync(path.join(run.runRoot, "state", "lease.json")), "no lease leaks after a command");
});

test("RUN-LEASE: a mutating command is refused while a live foreign lease is present", () => {
  const run = runToAcquired();
  const leasePath = path.join(run.runRoot, "state", "lease.json");
  mkdirSync(path.dirname(leasePath), { recursive: true });
  const now = Date.now();
  // The pid is **this test process**, which is genuinely alive and is not the
  // `erl2` process the lease is being held against — so the fixture contains the
  // condition the test is named for.
  //
  // It used to be `pid: 99999`, a pid nothing was running under. That passed only
  // because the lease was honoured on its TTL alone, so the case proved "a lease
  // inside its TTL is honoured" and said nothing about a *live* holder. Once
  // owner-liveness reclamation landed (ADR-ERL2-028 §9) the distinction became
  // load-bearing, and a dead pid is exactly what must now be reclaimed.
  writeFileSync(
    leasePath,
    JSON.stringify({ owner: "other-process", command: "acquire", acquired_at_ms: now, expires_at_ms: now + 100_000, pid: process.pid }),
  );
  const refused = erl2Run(run, ["freeze-package"]);
  assert.notEqual(refused.exitCode, 0, "a command must not mutate a leased run");
  assert.equal(refused.body.errors[0]?.code, "POLICY_RUN_LEASE_HELD");

  // Once the foreign lease is stale, the command proceeds.
  writeFileSync(
    leasePath,
    JSON.stringify({ owner: "other-process", command: "acquire", acquired_at_ms: now - 400_000, expires_at_ms: now - 100_000, pid: process.pid }),
  );
  const proceeds = erl2Run(run, ["freeze-package"]);
  assert.equal(proceeds.exitCode, 0, `a stale lease must be recovered: ${JSON.stringify(proceeds.body.errors)}`);
});

test("RUN-LEASE: a lease whose holder is gone is reclaimed without waiting out the TTL", () => {
  const run = runToAcquired();
  const leasePath = path.join(run.runRoot, "state", "lease.json");
  mkdirSync(path.dirname(leasePath), { recursive: true });
  const now = Date.now();
  // A lease well inside its TTL, held by a pid that is not running: the shape a
  // `SIGKILL`ed command leaves behind. Recovery must not have to wait five
  // minutes, because the process that has to reconcile the interrupted operation
  // is the very next one.
  writeFileSync(
    leasePath,
    JSON.stringify({
      owner: "pid-99999",
      command: "install",
      acquired_at_ms: now,
      expires_at_ms: now + 290_000,
      pid: 99999,
    }),
  );
  const proceeds = erl2Run(run, ["freeze-package"]);
  assert.equal(
    proceeds.exitCode,
    0,
    `a dead holder's lease must be reclaimable: ${JSON.stringify(proceeds.body.errors)}`,
  );
});

test("RUN-LEASE: a lease with no usable pid is still honoured on its TTL", () => {
  const run = runToAcquired();
  const leasePath = path.join(run.runRoot, "state", "lease.json");
  mkdirSync(path.dirname(leasePath), { recursive: true });
  const now = Date.now();
  // An older lease record with no pid field must not become reclaimable merely
  // for being old: absence of the field is not evidence the holder is gone.
  writeFileSync(
    leasePath,
    JSON.stringify({
      owner: "other-process",
      command: "acquire",
      acquired_at_ms: now,
      expires_at_ms: now + 100_000,
    }),
  );
  const refused = erl2Run(run, ["freeze-package"]);
  assert.equal(refused.body.errors[0]?.code, "POLICY_RUN_LEASE_HELD");
});
