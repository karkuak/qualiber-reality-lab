/**
 * The evidence-fixture sandbox measurement override, and the line it must not
 * cross.
 *
 * ## Why the seam exists
 *
 * `sandbox-invocation-result/v1` is retained, integrity-bound evidence, and its
 * `wall_clock_ms` is a real measurement of a real supervised process. That is
 * correct production evidence and it is also, by construction, not byte-identical
 * between two deliberate generations of the pinned goldens — so retaining the
 * record made the adapter-platform byte-pin unholdable. The refused fixes were
 * all weakenings: drop the record, exclude the field from the core hash,
 * normalize it in production, or widen the exclusion list. What is here instead
 * is one option that is absent by default and supplied only by the evidence
 * harness through the CLI composition root's existing `ERL2_EVIDENCE_CLOCK`
 * evidence mode.
 *
 * ## The activation condition
 *
 * The first version activated on the mere presence of `ERL2_EVIDENCE_CLOCK`. The
 * independent review measured why that was wrong: `runClock` prefers the durable
 * preregistration's `registered_at`, so on an already-preregistered run the
 * variable changed no timestamp and only zeroed the retained measurement — a run
 * stamped at real wall time could retain `wall_clock_ms: 0` between two
 * timestamps two seconds apart, and still verify. The override now requires the
 * run to *durably belong* to the same evidence clock. That condition is exercised
 * below through the CLI, because the CLI composition root is where the defect
 * lived; a test that hands `AdapterHost` the option directly cannot see it.
 *
 * ## What these controls assert
 *
 * The three properties that make it a measurement override rather than a timing
 * control, each driven through the real out-of-process host:
 *
 *  1. absent — the default, and every production path — the *observed* supervisor
 *     duration is what gets retained;
 *  2. present, the retained `wall_clock_ms` is the fixture value and **nothing
 *     else about the record moves**: the same invocation is compared field by
 *     field against an un-overridden one;
 *  3. the deadline is still enforced against real time — a hostile adapter that
 *     never responds is still timed out and its process tree still killed — while
 *     the override is in force.
 *
 * The declared limit (`sandbox-invocation-manifest/v1`'s
 * `resource_limits.wall_clock_ms`) is asserted unchanged throughout: what the
 * sandbox was allowed is never what the override touches.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Erl2Error } from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";
import {
  acquisitionRequest,
  adapterManifest,
  newHost,
  referenceAdapterEntry,
  REFERENCE_CORRECT_MANIFEST,
  sabotageAdapterEntry,
} from "../support/adapterFixtures.js";
import { buildGovernorRegistry } from "../support/governorRegistry.js";
import { ownedRunRoot } from "../support/tempDirs.js";

/** The value the CLI composition root supplies in evidence mode. */
const EVIDENCE_FIXTURE_WALL_CLOCK_MS = 0;

/** The instant `scripts/generate-evidence.mjs` anchors a generated run on. */
const EVIDENCE_CLOCK = "2026-07-01T00:00:00Z";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cliBin = path.join(repoRoot, "packages", "cli", "dist", "src", "bin.js");

interface CliResult {
  readonly exitCode: number;
  readonly body: { readonly errors?: readonly { readonly code?: string }[] };
}

/**
 * The shipped binary, in its own process, with the evidence clock set or absent.
 *
 * Local rather than `support/cliRun.ts`'s `erl2`, because the variable under test
 * is exactly the one that helper does not vary — and a helper that always set it
 * would make every one of these cases agree with itself.
 */
function erl2WithClock(args: readonly string[], evidenceClock?: string): CliResult {
  const env: NodeJS.ProcessEnv = { ...process.env, ERL2_DEVELOPMENT_FAKE_SUBJECT: "1" };
  if (evidenceClock === undefined) delete env["ERL2_EVIDENCE_CLOCK"];
  else env["ERL2_EVIDENCE_CLOCK"] = evidenceClock;
  const result = spawnSync(process.execPath, [cliBin, ...args], { encoding: "utf8", env });
  let body: CliResult["body"];
  try {
    body = JSON.parse(result.stdout) as CliResult["body"];
  } catch {
    body = { errors: [{ code: "NON_JSON_OUTPUT" }] };
  }
  return { exitCode: result.status ?? -1, body };
}

function runReferenceAcquire(overrides: Record<string, unknown> = {}) {
  const { host } = newHost(
    REFERENCE_CORRECT_MANIFEST(),
    referenceAdapterEntry("reference-correct"),
    overrides,
  );
  return host.run({
    operation: "acquire",
    operationId: "op-acquire",
    request: acquisitionRequest("op-acquire"),
  });
}

test("EVIDENCE-CLOCK: without the override, the observed supervisor duration is retained", () => {
  const result = runReferenceAcquire();
  const retained = result.sandboxResult;

  assert.equal(retained.outcome, "completed");
  // A real supervised exchange spawns two processes and moves frames through
  // them. It cannot measure zero, and the default must not be the fixture value.
  assert.ok(
    retained.wall_clock_ms > 0,
    `the default must retain a real measurement, got ${String(retained.wall_clock_ms)}`,
  );
  assert.notEqual(retained.wall_clock_ms, EVIDENCE_FIXTURE_WALL_CLOCK_MS);
  // Sanity: it is a duration of this invocation, not the declared limit copied in.
  assert.ok(
    retained.wall_clock_ms < result.sandboxManifest.resource_limits.wall_clock_ms,
    "the retained duration must be the observed one, not the declared deadline",
  );
  // The retained record is self-consistent: its core hash covers the field.
  const { core_hash: coreHashField, ...body } = retained;
  assert.equal(coreHashField, coreHash(body));
});

test("EVIDENCE-CLOCK: with the evidence override, only the retained wall_clock_ms changes", () => {
  const observed = runReferenceAcquire();
  const overridden = runReferenceAcquire({
    evidenceFixtureWallClockMs: EVIDENCE_FIXTURE_WALL_CLOCK_MS,
  });

  assert.equal(overridden.sandboxResult.wall_clock_ms, EVIDENCE_FIXTURE_WALL_CLOCK_MS);
  assert.ok(observed.sandboxResult.wall_clock_ms > 0);

  // Field by field, with the two fields that are legitimately per-invocation
  // removed: `wall_clock_ms` (the override) and `core_hash` (which covers it).
  // Everything else — outcome, exit status, termination, byte accounting,
  // timestamps — must be identical, or the override reached past its remit.
  const strip = (value: Record<string, unknown>): Record<string, unknown> => {
    const { wall_clock_ms: _w, core_hash: _c, ...rest } = value;
    return rest;
  };
  assert.deepEqual(
    strip(overridden.sandboxResult as unknown as Record<string, unknown>),
    strip(observed.sandboxResult as unknown as Record<string, unknown>),
  );

  // Specifically: the real request and response byte counts are untouched. The
  // whole point of the seam is that the evidence stays true about what was
  // exchanged; only the unreproducible measurement is a fixture.
  assert.equal(overridden.sandboxResult.request_bytes, observed.sandboxResult.request_bytes);
  assert.equal(overridden.sandboxResult.response_bytes, observed.sandboxResult.response_bytes);
  assert.equal(overridden.sandboxResult.stdout_bytes, observed.sandboxResult.stdout_bytes);

  // The declared limit is not a measurement and is never overridden: the sandbox
  // manifest — deadline, controls, limits, capability ids — is byte-identical.
  assert.equal(
    overridden.sandboxManifest.resource_limits.wall_clock_ms,
    observed.sandboxManifest.resource_limits.wall_clock_ms,
  );
  assert.equal(overridden.sandboxManifest.core_hash, observed.sandboxManifest.core_hash);

  // And the overridden record is still integrity-bound over the value it carries:
  // the field is inside the core hash, exactly as in production.
  const { core_hash: overriddenHash, ...overriddenBody } = overridden.sandboxResult;
  assert.equal(overriddenHash, coreHash(overriddenBody));
  assert.notEqual(overriddenHash, observed.sandboxResult.core_hash);
});

test("EVIDENCE-CLOCK: the deadline and the process-tree kill still use real supervisor timing", () => {
  const { host, workspaceRoot } = newHost(
    adapterManifest({ adapterId: "sabotage-timeout" }),
    sabotageAdapterEntry("timeout"),
    { wallClockMs: 1500, evidenceFixtureWallClockMs: EVIDENCE_FIXTURE_WALL_CLOCK_MS },
  );

  const started = Date.now();
  let refusal: Erl2Error | undefined;
  try {
    host.run({
      operation: "acquire",
      operationId: "op-1",
      request: acquisitionRequest("op-1"),
    });
  } catch (error) {
    if (!(error instanceof Erl2Error)) throw error;
    refusal = error;
  }
  const elapsed = Date.now() - started;

  // The override said zero. Real time still governed: the adapter never
  // responded, the supervisor's 1500ms deadline fired against the wall clock,
  // and the operation is a typed deadline refusal.
  assert.equal(refusal?.code, "ADAPTER_DEADLINE_EXCEEDED");
  assert.ok(
    elapsed >= 1000,
    `the deadline must have been enforced against real time, took ${String(elapsed)}ms`,
  );
  assert.ok(elapsed < 30_000, `the deadline must still bound the wait, took ${String(elapsed)}ms`);

  // …and the kill still reached the whole tree. The adapter forked a detached
  // grandchild; a survivor would mean only the direct child died.
  const pidFile = path.join(workspaceRoot, "op-1", "output", "grandchild.pid");
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
      try {
        process.kill(pid, 0);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      } catch {
        alive = false;
      }
    }
    if (alive) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    assert.equal(alive, false, "the grandchild survived process-tree termination");
  }
});


// ---------------------------------------------------------------------------
// The CLI activation condition (review F-2).
// ---------------------------------------------------------------------------
//
// Everything above drives `AdapterHost` directly, which is the wrong altitude for
// this question: the option was always honoured correctly, and the defect was in
// *when the composition root supplies it*. These cases run the shipped binary in
// its own process, over a real out-of-process adapter, and vary only the durable
// preregistration and the environment.

/** One run's worth of CLI plumbing against a real reference adapter. */
function adapterRun(): {
  readonly runRoot: string;
  readonly runId: string;
  readonly base: readonly string[];
  readonly registry: ReturnType<typeof buildGovernorRegistry>;
} {
  const registry = buildGovernorRegistry({});
  const runRoot = ownedRunRoot("erl2-evidence-clock-");
  const runId = "00000000-0000-7000-8000-0000000000ab";
  return {
    runRoot,
    runId,
    registry,
    base: [
      "--run-root", runRoot,
      "--registry", registry.root,
      "--tier", "development",
      "--adapter-entry", referenceAdapterEntry("reference-correct"),
    ],
  };
}

function preregister(run: ReturnType<typeof adapterRun>, evidenceClock?: string): CliResult {
  return erl2WithClock(
    [
      "preregister-acquisition", ...run.base, "--run", run.runId,
      "--acquisition-source", run.registry.sourceManifestHash,
      "--adapter", run.registry.referenceCorrectAdapterHash,
      "--adapter-certification", run.registry.referenceCorrectCertificationHash,
      "--acquisition-actor-script", run.registry.acquisitionActorScriptHash,
      "--acquisition-actor-schema", run.registry.acquisitionActorSchemaHash,
      "--acquisition-step", run.registry.acquisitionStep.commitmentHash,
      "--package-verification-step", run.registry.packageVerificationStep.commitmentHash,
      "--generic-policy", run.registry.genericRunPolicyHash,
      "--trust-policy", run.registry.runTrustPolicyHash,
      "--limits", run.registry.limitsHash,
      "--expires", "2030-12-31T00:00:00Z",
    ],
    evidenceClock,
  );
}

/** The retained sandbox result for the run's `acquire`. */
function retainedAcquire(runRoot: string): { wall_clock_ms: number; started_at: string; ended_at: string } {
  return JSON.parse(
    readFileSync(
      path.join(runRoot, "retained", "adapter", "op-acquire", "sandbox-invocation-result.json"),
      "utf8",
    ),
  ) as { wall_clock_ms: number; started_at: string; ended_at: string };
}

test("EVIDENCE-CLOCK-CLI: a real preregistration keeps its real duration even when the evidence clock appears later", () => {
  // The exact defect: preregister normally, then set the variable for `acquire`
  // alone. The run's time base is the real `registered_at`, so the variable
  // changes no timestamp — and must therefore change no measurement either.
  const run = adapterRun();
  assert.equal(preregister(run).exitCode, 0);

  const prereg = JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", "acquisition-preregistration.json"), "utf8"),
  ) as { registered_at: string };
  assert.notEqual(prereg.registered_at, EVIDENCE_CLOCK, "the fixture must be stamped with real time");

  const acquired = erl2WithClock(["acquire", ...run.base, "--run", run.runId], EVIDENCE_CLOCK);
  assert.equal(acquired.exitCode, 0, JSON.stringify(acquired.body));

  const retained = retainedAcquire(run.runRoot);
  assert.ok(
    retained.wall_clock_ms > 0,
    `a real run must retain a real measurement, got ${String(retained.wall_clock_ms)}`,
  );
});

test("EVIDENCE-CLOCK-CLI: a run preregistered under the evidence clock retains the fixture value", () => {
  // The generation path, which must keep working: preregistered under the
  // evidence clock and continued under the same one.
  const run = adapterRun();
  assert.equal(preregister(run, EVIDENCE_CLOCK).exitCode, 0);

  const prereg = JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", "acquisition-preregistration.json"), "utf8"),
  ) as { registered_at: string };
  assert.equal(prereg.registered_at, EVIDENCE_CLOCK, "an evidence run is stamped with the evidence clock");

  assert.equal(erl2WithClock(["acquire", ...run.base, "--run", run.runId], EVIDENCE_CLOCK).exitCode, 0);
  assert.equal(retainedAcquire(run.runRoot).wall_clock_ms, EVIDENCE_FIXTURE_WALL_CLOCK_MS);
});

test("EVIDENCE-CLOCK-CLI: a second, different evidence clock does not activate the override", () => {
  // Preregistered under clock A, continued under clock B. The run belongs to A,
  // so B is somebody else's evidence mode and buys nothing here.
  const run = adapterRun();
  assert.equal(preregister(run, EVIDENCE_CLOCK).exitCode, 0);

  const acquired = erl2WithClock(["acquire", ...run.base, "--run", run.runId], "2026-09-09T00:00:00Z");
  assert.equal(acquired.exitCode, 0, JSON.stringify(acquired.body));
  assert.ok(
    retainedAcquire(run.runRoot).wall_clock_ms > 0,
    "a mismatched evidence clock must not zero the retained measurement",
  );
});

test("EVIDENCE-CLOCK-CLI: an absent or malformed preregistration cannot activate the override", () => {
  // Malformed: the durable record exists but establishes nothing. It is read, not
  // repaired — the workspace refuses the run on its own account moments later,
  // and in the meantime no override is supplied.
  const run = adapterRun();
  assert.equal(preregister(run, EVIDENCE_CLOCK).exitCode, 0);
  const preregPath = path.join(run.runRoot, "retained", "acquisition-preregistration.json");

  // The retained record is frozen read-only, which is itself the answer to "could
  // this happen by accident" — it takes a deliberate `chmod` to get here.
  const corruptions = [
    "{ not json",
    JSON.stringify({ registered_at: 12345 }),
    JSON.stringify({}),
    undefined /* absent entirely */,
  ];
  for (const corruption of corruptions) {
    chmodSync(preregPath, 0o600);
    if (corruption === undefined) rmSync(preregPath, { force: true });
    else writeFileSync(preregPath, corruption);

    const acquired = erl2WithClock(["acquire", ...run.base, "--run", run.runId], EVIDENCE_CLOCK);
    // A refusal is equally acceptable — what must never happen is a fixture value
    // standing in for a measurement on a run that established no evidence mode.
    if (acquired.exitCode === 0 && existsSync(path.join(run.runRoot, "retained", "adapter", "op-acquire", "sandbox-invocation-result.json"))) {
      assert.ok(
        retainedAcquire(run.runRoot).wall_clock_ms > 0,
        `a ${String(corruption).slice(0, 24)} preregistration activated the override`,
      );
    }
    if (corruption === undefined) break;
  }
});

test("EVIDENCE-CLOCK-CLI: the supervisor deadline stays real in evidence mode", () => {
  // The property that must hold in *both* modes, asserted through the CLI: a
  // hostile adapter that never responds is still timed out against real time
  // while the evidence clock is in force.
  // The timeout fixture is admitted with a certified receipt over its own real
  // bytes, so the run is legitimate right up to dispatch and the refusal that
  // follows is the *deadline* — not an admission or identity refusal standing
  // in for it (ADR-ERL2-036).
  const registry = buildGovernorRegistry({
    certifiedSabotageAdapters: [{ name: "timeout", adapterId: "sabotage-timeout" }],
  });
  const sabotage = registry.sabotageAdapterHashes["timeout"] as {
    manifestHash: string;
    certificationHash: string;
  };
  const runRoot = ownedRunRoot("erl2-evidence-clock-timeout-");
  const runId = "00000000-0000-7000-8000-0000000000ac";
  const base = [
    "--run-root", runRoot,
    "--registry", registry.root,
    "--tier", "development",
    "--adapter-entry", sabotageAdapterEntry("timeout"),
  ];
  const prereg = erl2WithClock(
    [
      "preregister-acquisition", ...base, "--run", runId,
      "--acquisition-source", registry.sourceManifestHash,
      "--adapter", sabotage.manifestHash,
      "--adapter-certification", sabotage.certificationHash,
      "--acquisition-actor-script", registry.acquisitionActorScriptHash,
      "--acquisition-actor-schema", registry.acquisitionActorSchemaHash,
      "--acquisition-step", registry.acquisitionStep.commitmentHash,
      "--package-verification-step", registry.packageVerificationStep.commitmentHash,
      "--generic-policy", registry.genericRunPolicyHash,
      "--trust-policy", registry.runTrustPolicyHash,
      "--limits", registry.limitsHash,
      "--expires", "2030-12-31T00:00:00Z",
    ],
    EVIDENCE_CLOCK,
  );
  assert.equal(prereg.exitCode, 0, JSON.stringify(prereg.body));

  const started = Date.now();
  const acquired = erl2WithClock(["acquire", ...base, "--run", runId], EVIDENCE_CLOCK);
  const elapsed = Date.now() - started;

  assert.notEqual(acquired.exitCode, 0, "an adapter that never responds must not succeed");
  assert.equal(acquired.body.errors?.[0]?.code, "ADAPTER_DEADLINE_EXCEEDED");
  assert.ok(
    elapsed >= 1_000,
    `the deadline must have been enforced against real time, took ${String(elapsed)}ms`,
  );
});
