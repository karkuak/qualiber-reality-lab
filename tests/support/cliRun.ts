/**
 * Shared CLI driver for adversarial verifier tests.
 *
 * Every helper here spawns the shipped `erl2` binary in a *fresh process* over a
 * run produced by the shipped commands — never a hand-assembled fixture — so a
 * mutation battery exercises exactly the path an external consumer runs.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash } from "@erl2/integrity";
import { buildGovernorRegistry, type GovernorRegistry } from "./governorRegistry.js";
import { developmentKeyring } from "./keys.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cli = path.join(repoRoot, "packages", "cli", "dist", "src", "bin.js");

export interface CliResult {
  readonly exitCode: number;
  readonly body: {
    ok: boolean;
    run_id?: string;
    state?: string;
    data?: Record<string, unknown>;
    errors: { code: string; message: string }[];
  };
}

export function erl2(args: readonly string[]): CliResult {
  // These harnesses drive the development fake subject port, so they opt into the
  // explicit development profile that gates the `--fake-*` scripting flags
  // (§11.8). The release surface (without this env var) refuses those flags.
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ERL2_DEVELOPMENT_FAKE_SUBJECT: "1" },
  });
  let body: CliResult["body"];
  try {
    body = JSON.parse(result.stdout) as CliResult["body"];
  } catch {
    body = { ok: false, errors: [{ code: "NON_JSON_OUTPUT", message: result.stderr.slice(0, 512) }] };
  }
  return { exitCode: result.status ?? -1, body };
}

function common(registry: GovernorRegistry, runRoot: string, runId?: string): string[] {
  return [
    "--run-root", runRoot,
    "--registry", registry.root,
    "--tier", "development",
    ...(runId === undefined ? [] : ["--run", runId]),
  ];
}

export interface ValidTerminalRun {
  readonly registry: GovernorRegistry;
  readonly runRoot: string;
  readonly runId: string;
}

/**
 * Drives a run from preregistration to a finalized *valid* pre-environment
 * terminal via the CLI, returning the run root an external verifier would read.
 */
export function runToValidTerminal(verifyStatus: "failed" | "unsupported" = "failed"): ValidTerminalRun {
  const registry = buildGovernorRegistry();
  const runRoot = mkdtempSync(path.join(tmpdir(), "erl2-mut-"));
  const prereg = erl2([
    "preregister-acquisition",
    ...common(registry, runRoot),
    "--acquisition-source", registry.sourceManifestHash,
    "--adapter", registry.adapterManifestHash,
    "--acquisition-actor-script", registry.acquisitionActorScriptHash,
    "--acquisition-actor-schema", registry.acquisitionActorSchemaHash,
    "--acquisition-step", registry.acquisitionStep.commitmentHash,
    "--package-verification-step", registry.packageVerificationStep.commitmentHash,
    "--generic-policy", registry.genericRunPolicyHash,
    "--trust-policy", registry.runTrustPolicyHash,
    "--limits", registry.limitsHash,
    "--expires", "2026-12-31T00:00:00Z",
  ]);
  assert.equal(prereg.exitCode, 0, JSON.stringify(prereg.body.errors));
  const runId = prereg.body.run_id as string;

  const plan: readonly (readonly [string, readonly string[]])[] = [
    ["acquire", ["acquire", ...common(registry, runRoot, runId)]],
    ["freeze-package", ["freeze-package", ...common(registry, runRoot, runId)]],
    [
      "verify-package",
      [
        "verify-package",
        ...common(registry, runRoot, runId),
        "--fake-verify-package", verifyStatus,
        "--subject-id", "reference-subject",
        "--subject-version", "0.1.0",
      ],
    ],
    ["freeze-output", ["freeze-output", ...common(registry, runRoot, runId), "--terminal-stage", "verify_package"]],
    ["reveal", ["reveal", ...common(registry, runRoot, runId), "--vault", registry.vaultRoot]],
    ["evaluate", ["evaluate", ...common(registry, runRoot, runId)]],
    ["finalize-generic", ["finalize-generic", ...common(registry, runRoot, runId), "--claim-scope", "T1"]],
  ];
  for (const [name, argv] of plan) {
    const result = erl2(argv);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
  }
  return { registry, runRoot, runId };
}

/**
 * Drives a run only as far as a durably-accepted, mid-flight state (after
 * `acquire`), for exercising cancellation and replay from a non-terminal run.
 */
export function runToAcquired(): ValidTerminalRun {
  const registry = buildGovernorRegistry();
  const runRoot = mkdtempSync(path.join(tmpdir(), "erl2-mid-"));
  const prereg = erl2([
    "preregister-acquisition",
    ...common(registry, runRoot),
    "--acquisition-source", registry.sourceManifestHash,
    "--adapter", registry.adapterManifestHash,
    "--acquisition-actor-script", registry.acquisitionActorScriptHash,
    "--acquisition-actor-schema", registry.acquisitionActorSchemaHash,
    "--acquisition-step", registry.acquisitionStep.commitmentHash,
    "--package-verification-step", registry.packageVerificationStep.commitmentHash,
    "--generic-policy", registry.genericRunPolicyHash,
    "--trust-policy", registry.runTrustPolicyHash,
    "--limits", registry.limitsHash,
    "--expires", "2026-12-31T00:00:00Z",
  ]);
  assert.equal(prereg.exitCode, 0, JSON.stringify(prereg.body.errors));
  const runId = prereg.body.run_id as string;
  const acq = erl2(["acquire", ...common(registry, runRoot, runId)]);
  assert.equal(acq.exitCode, 0, JSON.stringify(acq.body.errors));
  return { registry, runRoot, runId };
}

/** Runs any command against an existing run. */
export function erl2Run(run: ValidTerminalRun, args: readonly string[]): CliResult {
  return erl2([...args, ...common(run.registry, run.runRoot, run.runId)]);
}

/** Drives a run only through preregistration (durably accepted, no step run yet). */
export function runToPreregistered(): ValidTerminalRun {
  const registry = buildGovernorRegistry();
  const runRoot = mkdtempSync(path.join(tmpdir(), "erl2-prereg-"));
  const prereg = erl2([
    "preregister-acquisition",
    ...common(registry, runRoot),
    "--acquisition-source", registry.sourceManifestHash,
    "--adapter", registry.adapterManifestHash,
    "--acquisition-actor-script", registry.acquisitionActorScriptHash,
    "--acquisition-actor-schema", registry.acquisitionActorSchemaHash,
    "--acquisition-step", registry.acquisitionStep.commitmentHash,
    "--package-verification-step", registry.packageVerificationStep.commitmentHash,
    "--generic-policy", registry.genericRunPolicyHash,
    "--trust-policy", registry.runTrustPolicyHash,
    "--limits", registry.limitsHash,
    "--expires", "2026-12-31T00:00:00Z",
  ]);
  assert.equal(prereg.exitCode, 0, JSON.stringify(prereg.body.errors));
  return { registry, runRoot, runId: prereg.body.run_id as string };
}

/** Collects the run's lifecycle stream, exactly as an external verifier would. */
export function writeLifecycle(runRoot: string, file = "lifecycle.json"): string {
  const events: { sequence: number }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const child = path.join(dir, name);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!name.endsWith(".json") || name.endsWith(".frozen")) continue;
      const value = JSON.parse(readFileSync(child, "utf8")) as { schema_version?: string; sequence?: number };
      if (value.schema_version === "lab-lifecycle-event/v1") events.push(value as { sequence: number });
    }
  };
  walk(runRoot);
  events.sort((a, b) => a.sequence - b.sequence);
  const streamPath = path.join(runRoot, file);
  writeFileSync(streamPath, JSON.stringify(events));
  return streamPath;
}

/** The verifier's own locally pinned trust configuration. */
export function writeTrustConfig(runRoot: string, file = "trust-config.json"): string {
  const policy = JSON.parse(
    readFileSync(path.join(runRoot, "retained", "trust-policy.json"), "utf8"),
  ) as object;
  const configPath = path.join(runRoot, file);
  writeFileSync(
    configPath,
    JSON.stringify({
      rootKeyIds: [developmentKeyring().root.keyId],
      currentTrustHeadHash: coreHash(policy),
      randomnessSources: [],
      randomnessRegistryHeadHash: `sha256:${"0".repeat(64)}`,
    }),
  );
  return configPath;
}

/** Verifies the run's public bundle offline in a fresh process. */
export function verifyBundle(runRoot: string): CliResult {
  return erl2([
    "verify",
    "--public-bundle", path.join(runRoot, "retained", "public-bundle.json"),
    "--root-config", writeTrustConfig(runRoot),
    "--artifact-root", runRoot,
    "--lifecycle", writeLifecycle(runRoot),
    "--offline",
  ]);
}
