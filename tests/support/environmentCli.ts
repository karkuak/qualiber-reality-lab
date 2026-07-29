/**
 * Shared driver for the environment branch, through the shipped `erl2` binary.
 *
 * Every invocation is a separate OS process sharing nothing with the last but
 * the run directory, the governor registry and the substrate. That is the whole
 * point: `provision`, `restore` and `destroy` are three different processes, and
 * the failures this suite exists to catch — a substituted substrate, a
 * re-dispatched mutation, a cancellation routed to the wrong branch — are all
 * invisible to a single-process harness.
 *
 * Nothing here constructs an artifact. The assertions built on top read the
 * run's own durable trace: the lifecycle event stream and the retained tree,
 * exactly what an offline auditor would have.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { erl2, runToAcquired, type CliResult } from "./cliRun.js";
import type { GovernorRegistry } from "./governorRegistry.js";

export interface EnvironmentRun {
  readonly runRoot: string;
  readonly runId: string;
  readonly registry: GovernorRegistry;
  readonly base: readonly string[];
}

/** A run driven through the shipped CLI to `case_selected`. */
export function selectedRun(): EnvironmentRun {
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
  const prereg = erl2([
    "preregister-challenge", ...base,
    "--journey-selection-policy", run.registry.journeySelectionPolicyHash,
    "--randomness-policy", run.registry.randomnessPolicyHash,
    ...run.registry.challengeCandidates.flatMap((c) => ["--challenge", c.challengeManifestHash]),
  ]);
  assert.equal(prereg.exitCode, 0, JSON.stringify(prereg.body.errors));

  const sourceTrustConfig = path.join(run.runRoot, "source-trust.json");
  writeFileSync(
    sourceTrustConfig,
    JSON.stringify({
      sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
      randomnessRegistryHeadHash: run.registry.sourceTrustPolicyHash,
    }),
  );
  const selected = erl2([
    "select", ...base,
    "--source-trust-config", sourceTrustConfig,
    "--expires", "2026-12-31T00:00:00Z",
  ]);
  assert.equal(selected.exitCode, 0, JSON.stringify(selected.body.errors));
  assert.equal(selected.body.state, "case_selected");
  return { runRoot: run.runRoot, runId: run.runId, registry: run.registry, base };
}

/**
 * The ordered command plan for the environment path.
 *
 * Every admitted candidate commits the same ordered intents (with its own step
 * instances), so the plan is the same whichever challenge the beacon selected —
 * which is what makes a test built on it a test of the path rather than of the
 * draw.
 */
export function environmentPlan(
  run: EnvironmentRun,
): readonly (readonly [string, readonly string[]])[] {
  const env = [...run.base];
  return [
    ["provision", ["provision", ...env, "--archetype", run.registry.archetypeHash]],
    ["baseline", ["baseline", ...env]],
    ["plan", ["plan", ...env]],
    ["install", ["install", ...env]],
    ["configure", ["configure", ...env]],
    ["authenticate", ["authenticate", ...env]],
    ["connect", ["connect", ...env]],
    ["execute-subject:discover", ["execute-subject", ...env]],
    ["activate", ["activate", ...env]],
    [
      "journey",
      [
        "journey", ...env,
        "--comparison-policy", run.registry.comparisonPolicyHash,
        "--cutoff-policy", run.registry.cutoffPolicyHash,
      ],
    ],
    ["observe", ["observe", ...env]],
    ["freeze-observation", ["freeze-observation", ...env]],
    ["execute-subject:exercise", ["execute-subject", ...env]],
    ["execute-subject:observe", ["execute-subject", ...env]],
    ["remove", ["remove", ...env]],
    ["freeze-output", ["freeze-output", ...env]],
    ["reveal", ["reveal", ...env, "--vault", run.registry.vaultRoot]],
    ["evaluate", ["evaluate", ...env]],
    ["restore", ["restore", ...env]],
    ["destroy", ["destroy", ...env]],
    ["finalize-generic", ["finalize-generic", ...env]],
  ];
}

/** The index of a named phase in the plan, so a test can stop in front of it. */
export function phaseIndex(run: EnvironmentRun, command: string): number {
  const index = environmentPlan(run).findIndex(([name]) => name === command);
  assert.ok(index >= 0, `no environment phase named ${command}`);
  return index;
}

/** Runs the plan from `from` up to (not including) `upTo`, and returns the state. */
export function drive(
  run: EnvironmentRun,
  upTo = Number.POSITIVE_INFINITY,
  from = 0,
): string {
  let state: string | undefined;
  for (const [name, argv] of environmentPlan(run).slice(from, upTo)) {
    const result = erl2(argv);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
    state = result.body.state as string;
  }
  if (state !== undefined) return state;
  const status = erl2(["status", "--run", run.runId, "--artifact-root", run.runRoot]);
  assert.equal(status.exitCode, 0, JSON.stringify(status.body.errors));
  return status.body.state as string;
}

/**
 * Runs the plan with a scripted driver fault applied to **every** phase.
 *
 * Some faults are baked in at provisioning — `sharedResourceIds` decides a
 * resource's `shared_with_other_runs` flag when the inventory is created — so
 * passing the flag only to the failing command produces a fixture that does not
 * contain the condition the test is named for.
 */
export function driveWithFault(
  run: EnvironmentRun,
  fault: string,
  upTo = Number.POSITIVE_INFINITY,
  from = 0,
): string {
  let state: string | undefined;
  for (const [name, argv] of environmentPlan(run).slice(from, upTo)) {
    const result = erl2([...argv, "--fake-driver-fault", fault]);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
    state = result.body.state as string;
  }
  return state ?? "";
}

/** Runs one named phase and returns its result, without asserting success. */
export function runPhase(run: EnvironmentRun, command: string): CliResult {
  const entry = environmentPlan(run).find(([name]) => name === command);
  assert.ok(entry !== undefined, `no environment phase named ${command}`);
  return erl2(entry[1]);
}

export interface LifecycleEvent {
  readonly event_type: string;
  readonly state_to: string;
  readonly produced?: readonly { readonly artifact_role: string; readonly artifact_core_hash: string }[];
}

export function lifecycleEvents(run: EnvironmentRun): readonly LifecycleEvent[] {
  const dir = path.join(run.runRoot, "events");
  return readdirSync(dir)
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as LifecycleEvent);
}

export function producedRoles(run: EnvironmentRun): readonly string[] {
  return lifecycleEvents(run)
    .flatMap((e) => e.produced ?? [])
    .map((p) => p.artifact_role);
}

/** The run's default substrate root — where its environment actually lives. */
export function substrateRootOf(run: EnvironmentRun): string {
  return `${path.resolve(run.runRoot)}.substrate`;
}

/** Full-tree byte manifest of a directory, so a test can prove nothing was written. */
export function manifest(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const rec = (dir: string, base: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const absolute = path.join(dir, entry.name);
      const relative = base + entry.name;
      if (entry.isDirectory()) {
        out.set(`${relative}/`, "dir");
        rec(absolute, `${relative}/`);
        continue;
      }
      out.set(relative, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
    }
  };
  rec(root, "");
  return out;
}

/** Paths that differ between two manifests, ignoring the run lease and test inputs. */
export function changed(
  before: Map<string, string>,
  after: Map<string, string>,
): readonly string[] {
  const out: string[] = [];
  for (const [key, value] of after) if (before.get(key) !== value) out.push(key);
  for (const key of before.keys()) if (!after.has(key)) out.push(`-${key}`);
  return out.filter((p) => !p.includes("lease") && !/^source-trust\.json$/.test(p));
}
