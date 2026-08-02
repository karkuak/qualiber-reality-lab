/**
 * Shared CLI driver for adversarial verifier tests.
 *
 * Every helper here spawns the shipped `erl2` binary in a *fresh process* over a
 * run produced by the shipped commands — never a hand-assembled fixture — so a
 * mutation battery exercises exactly the path an external consumer runs.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash } from "@erl2/integrity";
import { DevelopmentBeaconSource } from "@erl2/core";
import type { Hash } from "@erl2/contracts";
import {
  buildGovernorRegistry,
  type BuildGovernorRegistryOptions,
  type GovernorRegistry,
} from "./governorRegistry.js";
import { developmentKeyring } from "./keys.js";
import { ownedRunRoot } from "./tempDirs.js";

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

export function erl2(
  args: readonly string[],
  options: { readonly developmentProfile?: boolean } = {},
): CliResult {
  // These harnesses drive the development fake subject port, so they opt into the
  // explicit development profile that gates the `--fake-*` scripting flags
  // (§11.8). The release surface (without this env var) refuses those flags, and
  // `developmentProfile: false` is how a test proves that.
  const env = { ...process.env };
  if (options.developmentProfile === false) delete env["ERL2_DEVELOPMENT_FAKE_SUBJECT"];
  else env["ERL2_DEVELOPMENT_FAKE_SUBJECT"] = "1";
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
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
  const runRoot = ownedRunRoot("erl2-mut-");
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
 * Drives a run all the way to a finalized **environment** terminal through the
 * shipped CLI, returning the run root an external verifier would read.
 *
 * Shared rather than copied because it is ~2 minutes of real work per call and
 * three suites now need the same terminal. Callers should build one and copy it
 * per case.
 */
export function runToEnvironmentTerminal(): ValidTerminalRun {
  const run = runToAcquired();
  const base = [
    "--run-root", run.runRoot,
    "--registry", run.registry.root,
    "--tier", "development",
    "--run", run.runId,
  ];
  const sourceTrust = path.join(run.runRoot, "source-trust.json");
  writeFileSync(
    sourceTrust,
    JSON.stringify({
      sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
      randomnessRegistryHeadHash: run.registry.sourceTrustPolicyHash,
    }),
  );
  const plan: readonly (readonly [string, readonly string[]])[] = [
    ["freeze-package", ["freeze-package", ...base]],
    [
      "verify-package",
      [
        "verify-package", ...base,
        "--fake-verify-package", "succeeded",
        "--subject-id", "s",
        "--subject-version", "0.1.0",
      ],
    ],
    [
      "preregister-challenge",
      [
        "preregister-challenge", ...base,
        "--journey-selection-policy", run.registry.journeySelectionPolicyHash,
        "--randomness-policy", run.registry.randomnessPolicyHash,
        ...run.registry.challengeCandidates.flatMap((c) => ["--challenge", c.challengeManifestHash]),
      ],
    ],
    ["select", ["select", ...base, "--source-trust-config", sourceTrust, "--expires", "2026-12-31T00:00:00Z"]],
    ["provision", ["provision", ...base, "--archetype", run.registry.archetypeHash]],
    ["baseline", ["baseline", ...base]],
    ["plan", ["plan", ...base]],
    ["install", ["install", ...base]],
    ["configure", ["configure", ...base]],
    ["authenticate", ["authenticate", ...base]],
    ["connect", ["connect", ...base]],
    ["discover", ["execute-subject", ...base]],
    ["activate", ["activate", ...base]],
    [
      "journey",
      [
        "journey", ...base,
        "--comparison-policy", run.registry.comparisonPolicyHash,
        "--cutoff-policy", run.registry.cutoffPolicyHash,
      ],
    ],
    ["observe", ["observe", ...base]],
    ["freeze-observation", ["freeze-observation", ...base]],
    ["exercise", ["execute-subject", ...base]],
    ["observe-step", ["execute-subject", ...base]],
    ["remove", ["remove", ...base]],
    ["freeze-output", ["freeze-output", ...base]],
    ["reveal", ["reveal", ...base, "--vault", run.registry.vaultRoot]],
    ["evaluate", ["evaluate", ...base]],
    ["restore", ["restore", ...base]],
    ["destroy", ["destroy", ...base]],
    ["finalize-generic", ["finalize-generic", ...base]],
  ];
  for (const [name, argv] of plan) {
    const result = erl2(argv);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
  }
  return run;
}

/**
 * Drives a run only as far as a durably-accepted, mid-flight state (after
 * `acquire`), for exercising cancellation and replay from a non-terminal run.
 */
export function runToAcquired(
  registryOptions: BuildGovernorRegistryOptions = {},
): ValidTerminalRun {
  const registry = buildGovernorRegistry(registryOptions);
  const runRoot = ownedRunRoot("erl2-mid-");
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
  const runRoot = ownedRunRoot("erl2-prereg-");
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

/**
 * The verifier's own locally pinned trust configuration.
 *
 * `randomnessSources` is empty by default because a pre-environment bundle
 * carries no selection chain and therefore no randomness to authorize. An
 * **environment** bundle does: its selection verification receipt is a mandatory
 * member, so the verifier must hold the beacon's pinned registry entry, and
 * Appendix C requires that entry to be the same authoritative state selection's
 * `--source-trust-config` resolved. Supply `sourceTrustPolicyHash` for those.
 */
export function writeTrustConfig(
  runRoot: string,
  file = "trust-config.json",
  options: { readonly sourceTrustPolicyHash?: Hash } = {},
): string {
  const policy = JSON.parse(
    readFileSync(path.join(runRoot, "retained", "trust-policy.json"), "utf8"),
  ) as object;
  const pinned =
    options.sourceTrustPolicyHash === undefined
      ? []
      : [
          new DevelopmentBeaconSource({
            // The pinned entry is the beacon's public identity and keys; it does
            // not depend on the seed, which is per-run.
            seed: "erl2-verifier-pin",
            firstRoundAt: "2026-07-01T00:00:00Z",
          }).pinnedRegistryEntry(options.sourceTrustPolicyHash),
        ];
  const configPath = path.join(runRoot, file);
  writeFileSync(
    configPath,
    JSON.stringify({
      rootKeyIds: [developmentKeyring().root.keyId],
      currentTrustHeadHash: coreHash(policy),
      randomnessSources: pinned,
      randomnessRegistryHeadHash:
        options.sourceTrustPolicyHash ?? (`sha256:${"0".repeat(64)}` as Hash),
    }),
  );
  return configPath;
}

/** Verifies the run's public bundle offline in a fresh process. */
export function verifyBundle(
  runRoot: string,
  options: { readonly sourceTrustPolicyHash?: Hash } = {},
): CliResult {
  return erl2([
    "verify",
    "--public-bundle", path.join(runRoot, "retained", "public-bundle.json"),
    "--root-config", writeTrustConfig(runRoot, "trust-config.json", options),
    "--artifact-root", runRoot,
    "--lifecycle", writeLifecycle(runRoot),
    "--offline",
  ]);
}
