/**
 * Compose admission at the CLI surface (ERL2-OQ-005).
 *
 * The driver's own matrix lives in `composeSubstrate.test.ts`. These are the
 * refusals that have to happen *before* a driver exists at all — a lock that does
 * not qualify, a lock whose signature does not verify, a driver name that is not
 * a driver, a run trying to change drivers halfway, and a fake-driver failpoint
 * pointed at a real substrate.
 *
 * None of them needs Docker, and that is the point: each one refuses before the
 * first Docker invocation, so a host with no daemon still proves them.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SubstrateLockV1 } from "@erl2/contracts";
import { assertContract } from "@erl2/contracts";
import { developmentKey, sealSigned } from "@erl2/integrity";
import { erl2, runToAcquired, type ValidTerminalRun } from "../support/cliRun.js";
import { ownedTempDir } from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SHIPPED_LOCK = path.join(repoRoot, "environments", "otel-demo", "substrate-lock.json");

function shippedLock(): SubstrateLockV1 {
  return JSON.parse(readFileSync(SHIPPED_LOCK, "utf8")) as SubstrateLockV1;
}

function writeLock(name: string, lock: unknown): string {
  const file = path.join(ownedTempDir("erl2-compose-lock-"), name);
  writeFileSync(file, JSON.stringify(lock, null, 2));
  return file;
}

function base(run: ValidTerminalRun): readonly string[] {
  return [
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ];
}

function provision(run: ValidTerminalRun, extra: readonly string[]): ReturnType<typeof erl2> {
  return erl2([
    "provision",
    ...base(run),
    "--archetype", run.registry.archetypeHash,
    "--environment-driver", "compose",
    ...extra,
  ]);
}

test("COMPOSE-CLI-ADV: an unqualified lock refuses before any substrate is reached", () => {
  const run = runToAcquired();
  const shipped = shippedLock();
  const { sbom: _sbom, provenance: _provenance, core_hash: _hash, signature: _signature, ...rest } = shipped;
  const unqualified = assertContract<SubstrateLockV1>(
    "SubstrateLockV1",
    sealSigned(
      {
        ...rest,
        qualification_status: "unqualified_pending_erl2_oq_005" as const,
        unqualified_reason_code: "OTEL_DEMO_NOT_RE_ADMITTED",
        images: [],
        config_hashes: [],
      },
      developmentKey("challenge-governor"),
    ),
  );
  const result = provision(run, ["--substrate-lock", writeLock("unqualified.json", unqualified)]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.body.errors[0]?.code, "ENV_SUBSTRATE_LOCK_UNQUALIFIED");
});

test("COMPOSE-CLI-ADV: a lock whose signature does not verify cannot license a run", () => {
  const run = runToAcquired();
  const tampered = { ...shippedLock() };
  // Same body, a signature that is not over it. `verifySubstrateLockSignature`
  // recomputes the core hash first, so this is caught before any drift check.
  tampered.signature = { ...tampered.signature, signature_base64: `${"B".repeat(86)}==` };
  const result = provision(run, ["--substrate-lock", writeLock("tampered.json", tampered)]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.body.errors[0]?.code, "ENV_SUBSTRATE_LOCK_SIGNATURE_INVALID");
});

test("COMPOSE-CLI-ADV: a lock whose recorded core hash is not its own is refused", () => {
  const run = runToAcquired();
  const shipped = shippedLock();
  // The lock is edited after signing: an extra image appears, and the signature
  // now covers a different document than the one on disk.
  const edited = {
    ...shipped,
    images: [...shipped.images, { service_id: "frontend", platform: "linux/amd64", digest: shipped.images[0]?.digest }],
  };
  const result = provision(run, ["--substrate-lock", writeLock("edited.json", edited)]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.body.errors[0]?.code, "ENV_SUBSTRATE_LOCK_SIGNATURE_INVALID");
});

test("COMPOSE-CLI-ADV: a driver name that is not a driver is refused", () => {
  const run = runToAcquired();
  const result = erl2([
    "provision",
    ...base(run),
    "--archetype", run.registry.archetypeHash,
    "--environment-driver", "kubernetes",
  ]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.body.errors[0]?.code, "CFG_MISSING_REQUIRED");
});

test("COMPOSE-CLI-ADV: a fake-driver failpoint cannot steer the Compose driver", () => {
  const run = runToAcquired();
  const result = provision(run, ["--fake-driver-fault", "failed-restore"]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.body.errors[0]?.code, "CFG_MISSING_REQUIRED");
});

test("COMPOSE-CLI-ADV: a bound driver may not be substituted by a later command", () => {
  const run = runToAcquired();
  // The run's own record says it bound the Compose driver. A later command that
  // names the fake one is refused rather than quietly driving a different
  // substrate — which is the half of the P0-1 substitution that reaches teardown.
  const stateDir = path.join(run.runRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "substrate-locator.json"),
    `${JSON.stringify({
      run_id: run.runId,
      substrate_root: `${path.resolve(run.runRoot)}.substrate`,
      reservation_root: `${path.resolve(run.runRoot)}.reservations`,
      driver_kind: "compose",
    })}\n`,
  );
  const substituted = erl2([
    "baseline",
    ...base(run),
    "--archetype", run.registry.archetypeHash,
    "--environment-driver", "fake",
  ]);
  assert.notEqual(substituted.exitCode, 0);
  assert.equal(substituted.body.errors[0]?.code, "ENV_SUBSTRATE_LOCATOR_CONFLICT");
});

test("COMPOSE-CLI-ADV: the default driver is still the fake one", () => {
  const run = runToAcquired();
  // No `--environment-driver`, no lock, no Docker: the composition is byte-for-byte
  // what every existing run already gets, and it refuses on the phase's own
  // ordering rule rather than on anything the Compose work introduced.
  const result = erl2(["baseline", ...base(run), "--archetype", run.registry.archetypeHash]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.body.errors[0]?.code, "POLICY_CONFLICT");
});
