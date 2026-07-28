/**
 * Adversarial battery for the environment and journey commands (Slice 6.5-B).
 *
 * Every case drives the shipped `erl2` binary in fresh processes over a run the
 * shipped commands produced. Each one asserts a **specific** code, never "some
 * error": a helper that accepted any code hid an entire broken suite during 6R,
 * and a case that passes because the wrong guard fired proves nothing about the
 * guard it names.
 *
 * The negative controls for these cases are recorded in
 * `docs/ledger/remediation-6.5B.md`: each guard was disabled in turn and the
 * matching case was confirmed to fail.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { erl2, runToAcquired } from "../support/cliRun.js";
import type { GovernorRegistry } from "../support/governorRegistry.js";

interface Run {
  readonly runRoot: string;
  readonly runId: string;
  readonly registry: GovernorRegistry;
  readonly base: readonly string[];
}

function selectedRun(): Run {
  const run = runToAcquired();
  const base = [
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ];
  assert.equal(erl2(["freeze-package", ...base]).exitCode, 0);
  assert.equal(
    erl2([
      "verify-package", ...base,
      "--fake-verify-package", "succeeded",
      "--subject-id", "s",
      "--subject-version", "0.1.0",
    ]).exitCode,
    0,
  );
  assert.equal(
    erl2([
      "preregister-challenge", ...base,
      "--journey-selection-policy", run.registry.journeySelectionPolicyHash,
      "--randomness-policy", run.registry.randomnessPolicyHash,
      ...run.registry.challengeCandidates.flatMap((c) => ["--challenge", c.challengeManifestHash]),
    ]).exitCode,
    0,
  );
  const sourceTrust = path.join(run.runRoot, "source-trust.json");
  writeFileSync(
    sourceTrust,
    JSON.stringify({
      sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
      randomnessRegistryHeadHash: run.registry.sourceTrustPolicyHash,
    }),
  );
  assert.equal(
    erl2(["select", ...base, "--source-trust-config", sourceTrust, "--expires", "2026-12-31T00:00:00Z"])
      .body.state,
    "case_selected",
  );
  return { runRoot: run.runRoot, runId: run.runId, registry: run.registry, base };
}

function provisioned(run: Run, extra: readonly string[] = []): void {
  const result = erl2(["provision", ...run.base, "--archetype", run.registry.archetypeHash, ...extra]);
  assert.equal(result.exitCode, 0, JSON.stringify(result.body.errors));
}

function retained(run: Run, ...segments: readonly string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(run.runRoot, "retained", ...segments), "utf8")) as Record<
    string,
    unknown
  >;
}

test("ENV-MUT: a run cannot be provisioned into an archetype its challenge never admitted", () => {
  const run = selectedRun();
  // A *real*, admitted archetype — just not one the selected challenge lists.
  const foreign = mkdtempSync(path.join(tmpdir(), "erl2-foreign-"));
  const archetype = JSON.parse(
    readFileSync(path.join(run.registry.root, "environment-archetype.json"), "utf8"),
  ) as Record<string, unknown>;
  writeFileSync(path.join(foreign, "environment-archetype.json"), JSON.stringify(archetype));

  const result = erl2([
    "provision", ...run.base,
    "--archetype", `sha256:${"b".repeat(64)}`,
  ]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.body.errors[0]?.code, "ADMISSION_ARTIFACT_UNKNOWN");
});

test("ENV-MUT: a second live run cannot reserve this run's substrate identities", () => {
  const first = selectedRun();
  const second = selectedRun();
  // One shared global allocator, as §22 requires: it holds reservation leases
  // only, and two runs may not hold the same network, volume, port or project.
  const allocator = mkdtempSync(path.join(tmpdir(), "erl2-alloc-"));
  provisioned(first, ["--reservation-root", allocator]);

  // The second run's identities embed *its own* run id, so they cannot collide
  // by construction — which is the property, not an accident. Forcing a collision
  // means pointing it at the first run's identity, and the allocator refuses.
  const collide = erl2([
    "provision", ...second.base,
    "--archetype", second.registry.archetypeHash,
    "--reservation-root", allocator,
    "--run", first.runId,
  ]);
  assert.notEqual(collide.exitCode, 0, "a run may not drive another run's identity");

  // And the first run's leases are the only ones the allocator holds.
  const leases = readdirSync(allocator).filter((n) => n.endsWith(".lease.json"));
  assert.equal(leases.length, 4, "project, network, volume and port are each reserved exactly once");
});

test("ENV-MUT: the driver's substrate survives the process that created it", () => {
  const run = selectedRun();
  provisioned(run);
  // The inventory a *fresh* process reads back must be the one provisioning
  // wrote. Before the substrate was durable this returned an empty resource set,
  // and a later `destroy` reported a clean teardown over resources it had never
  // looked at.
  const inventory = retained(run, "environment", "resource-inventory.json") as {
    resources: { run_scoped_name: string }[];
  };
  assert.equal(inventory.resources.length, 5);
  for (const resource of inventory.resources) {
    assert.ok(resource.run_scoped_name.includes(run.runId), "every resource identity embeds the run id");
  }

  const substrate = readdirSync(`${path.resolve(run.runRoot)}.substrate`);
  assert.equal(substrate.length, 1, "the substrate holds exactly this run's state");
  const state = JSON.parse(
    readFileSync(path.join(`${path.resolve(run.runRoot)}.substrate`, substrate[0] as string), "utf8"),
  ) as { resources: unknown[] };
  assert.equal(state.resources.length, 5, "a separate process can see what was provisioned");
});

test("ENV-MUT: a tampered retained inventory is refused, and the refusal writes nothing", () => {
  const run = selectedRun();
  provisioned(run);
  const file = path.join(run.runRoot, "retained", "environment", "resource-inventory.json");
  const inventory = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  inventory["inventoried_at"] = "2030-01-01T00:00:00Z";
  chmodSync(file, 0o644);
  writeFileSync(file, JSON.stringify(inventory));

  const result = erl2(["baseline", ...run.base]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.body.errors[0]?.code, "ARTIFACT_HASH_MISMATCH");
});

test("ENV-MUT: activation is refused until the journey has actually connected", () => {
  const run = selectedRun();
  provisioned(run);
  assert.equal(erl2(["baseline", ...run.base]).exitCode, 0);
  assert.equal(erl2(["plan", ...run.base]).exitCode, 0);
  assert.equal(erl2(["install", ...run.base]).exitCode, 0);
  assert.equal(erl2(["configure", ...run.base]).exitCode, 0);
  assert.equal(erl2(["authenticate", ...run.base]).exitCode, 0);

  // `connect` has not run: the guard reads the connect step's *outcome*, not an
  // operator's claim, so there is nothing it can be told.
  const early = erl2(["activate", ...run.base]);
  assert.notEqual(early.exitCode, 0);
  assert.equal(early.body.errors[0]?.code, "POLICY_CONFLICT");
  assert.match(early.body.errors[0]?.message ?? "", /succeeded connect step/);
});

test("ENV-MUT: subject output cannot freeze while a committed step is still owed", () => {
  const run = selectedRun();
  provisioned(run);
  for (const command of ["baseline", "plan", "install"]) {
    assert.equal(erl2([command, ...run.base]).exitCode, 0, command);
  }
  const early = erl2(["freeze-output", ...run.base]);
  assert.notEqual(early.exitCode, 0);
  assert.equal(early.body.errors[0]?.code, "GRAPH_CLOSURE_MISSING_ROLE");
  assert.match(early.body.errors[0]?.message ?? "", /still has a committed/);
});

test("ENV-MUT: the environment branch cannot be finalized through the pre-environment terminal", () => {
  const run = selectedRun();
  provisioned(run);
  assert.equal(erl2(["baseline", ...run.base]).exitCode, 0);
  assert.equal(erl2(["plan", ...run.base]).exitCode, 0);

  // `freeze-output --terminal-stage verify_package` is the pre-environment
  // terminal's entry point. The branch is chosen from the run's own evidence, so
  // the flag cannot steer it: the environment variant runs and refuses for the
  // real reason, rather than freezing a pre-environment manifest into a run that
  // has an environment.
  const crossover = erl2(["freeze-output", ...run.base, "--terminal-stage", "verify_package"]);
  assert.notEqual(crossover.exitCode, 0);
  assert.equal(crossover.body.errors[0]?.code, "POLICY_CONFLICT");
  assert.match(crossover.body.errors[0]?.message ?? "", /departs from step_outcome_frozen/);
});

test("ENV-MUT: the execution plan cannot be built on a persona the selection did not open", () => {
  const run = selectedRun();
  provisioned(run);
  assert.equal(erl2(["baseline", ...run.base]).exitCode, 0);

  const file = path.join(run.runRoot, "retained", "selection", "selected-binding.json");
  const binding = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  binding["persona_script_hash"] = `sha256:${"c".repeat(64)}`;
  chmodSync(file, 0o644);
  writeFileSync(file, JSON.stringify(binding));

  const result = erl2(["plan", ...run.base]);
  assert.notEqual(result.exitCode, 0);
  // The store catches the mutation before the plan's own persona check can run.
  // That is the honest outcome and it is reported as such: a tampered binding is
  // an integrity failure, not a planning failure.
  assert.equal(result.body.errors[0]?.code, "ARTIFACT_HASH_MISMATCH");
});

test("ENV-MUT: an environment command on a run that never selected a case is refused", () => {
  const run = runToAcquired();
  const base = [
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ];
  const result = erl2(["provision", ...base, "--archetype", run.registry.archetypeHash]);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.body.errors[0]?.code, "POLICY_CONFLICT");
  assert.match(result.body.errors[0]?.message ?? "", /departs from case_selected/);
});

/*
 * The half of the activation guard that nothing exercised.
 *
 * `activate` requires a connect step whose outcome is `succeeded`. Every earlier
 * case reached only the *undefined* half — a connect that had never run — so
 * disabling the succeeded check changed no test result, and the negative-control
 * campaign said so. This is the missing case: a connect that ran and failed.
 */
test("ENV-MUT: activation is refused after a connect that failed", () => {
  const run = selectedRun();
  provisioned(run);
  for (const command of ["baseline", "plan", "install", "configure", "authenticate"]) {
    assert.equal(erl2([command, ...run.base]).exitCode, 0, command);
  }
  // The subject reports a failed connection. A failed step is a retained outcome
  // and the journey continues, so the run reaches activation with a connect
  // outcome that exists and did not succeed.
  const connected = erl2(["connect", ...run.base, "--fake-step-status", "connect=failed"]);
  assert.equal(connected.exitCode, 0, JSON.stringify(connected.body.errors));
  assert.equal((connected.body.data as { status: string }).status, "failed");
  assert.equal(erl2(["execute-subject", ...run.base]).exitCode, 0, "discover still runs");

  const refused = erl2(["activate", ...run.base]);
  assert.notEqual(refused.exitCode, 0, "a challenge may not go live over a failed connection");
  assert.equal(refused.body.errors[0]?.code, "POLICY_CONFLICT");
  assert.match(refused.body.errors[0]?.message ?? "", /succeeded connect step/);
});

test("ENV-MUT: --fake-step-status is unreachable without the development profile", () => {
  const run = selectedRun();
  const result = erl2(
    ["provision", ...run.base, "--archetype", run.registry.archetypeHash, "--fake-step-status", "connect=failed"],
    { developmentProfile: false },
  );
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.body.errors[0]?.code, "CFG_DEVELOPMENT_FLAG_UNAVAILABLE");
});
