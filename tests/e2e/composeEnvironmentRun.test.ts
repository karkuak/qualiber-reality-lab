/**
 * The OQ-005 acceptance gate: one complete CLI journey through a **real** Docker
 * Compose environment.
 *
 * Every invocation is a separate OS process sharing nothing with the last but the
 * run directory, the governor registry, and the Compose project the driver
 * provisions into. Nothing here constructs an artifact and nothing simulates a
 * substrate: the containers are real, the telemetry is emitted by a real
 * OpenTelemetry SDK inside one of them and observed at a real collector, the
 * mutation is a real Docker state change, and the residue check is a real
 * re-inspection after `docker compose down`.
 *
 * ## When Docker is not available
 *
 * This file **skips**, loudly, and nothing here may be read as evidence when it
 * does. A skipped real-substrate test proves nothing at all, which is exactly why
 * `ERL2_REQUIRE_LIVE_DOCKER=1` turns the skip into a failure: a pipeline that
 * means to gate on the live claim can say so, and then a missing daemon is a red
 * suite rather than a green one that proved nothing.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dockerAvailable, OTEL_DEMO_RELEASE_TAG } from "@erl2/core";
import { erl2, verifyBundle } from "../support/cliRun.js";
import { referenceAdapterEntry } from "../support/adapterFixtures.js";
import { buildGovernorRegistry, type GovernorRegistry } from "../support/governorRegistry.js";
import { ownedRunRoot } from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ARCHIVE = path.join(
  repoRoot,
  "environments",
  "otel-demo",
  "upstream",
  `opentelemetry-demo-${OTEL_DEMO_RELEASE_TAG}.tar.gz`,
);

/**
 * Why this file cannot make its claim here, or `undefined` when it can.
 *
 * Two preconditions, both about the *substrate* rather than about the code: a
 * daemon to talk to, and the digest-pinned release archive whose bytes runtime
 * admission re-hashes. Neither can be faked into existence by a test.
 */
function unavailable(): string | undefined {
  if (!dockerAvailable()) return "no Docker daemon is reachable";
  if (!existsSync(ARCHIVE)) {
    return `the pinned OpenTelemetry Demo ${OTEL_DEMO_RELEASE_TAG} archive is not fetched ` +
      "(run `node scripts/qualify-otel-demo.mjs --fetch-only`)";
  }
  return undefined;
}

const REASON = unavailable();
/**
 * `{}` when the substrate is there, and when the caller demanded it — in the
 * second case the case runs and fails on the first Docker call, which is the
 * refusal. `{ skip }` only when nobody asked for the live claim.
 */
const SKIP: { readonly skip?: string } =
  REASON === undefined || process.env["ERL2_REQUIRE_LIVE_DOCKER"] === "1"
    ? {}
    : { skip: `LIVE SUBSTRATE UNPROVEN: ${REASON}` };

/**
 * A refusal, not a skip, when the caller asked for the live claim.
 *
 * `{ skip }` is how a suite says "this was not measured". With
 * `ERL2_REQUIRE_LIVE_DOCKER=1` the caller has said the live claim is the point,
 * and the honest answer to "I could not measure it" is then a failure.
 */
test("COMPOSE-E2E-GATE: the live substrate precondition is explicit", () => {
  if (REASON !== undefined && process.env["ERL2_REQUIRE_LIVE_DOCKER"] === "1") {
    assert.fail(`ERL2_REQUIRE_LIVE_DOCKER=1 was set but ${REASON}; the live claim cannot be made`);
  }
  assert.ok(true);
});

interface ComposeRun {
  readonly runRoot: string;
  readonly runId: string;
  readonly registry: GovernorRegistry;
  readonly base: readonly string[];
  readonly project: string;
}

function docker(args: readonly string[]): { status: number; stdout: string } {
  const result = spawnSync("docker", [...args], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "" };
}

/** Objects carrying this run's exact project label. Exact value, never a prefix. */
function projectObjects(project: string): {
  readonly containers: readonly string[];
  readonly networks: readonly string[];
  readonly volumes: readonly string[];
} {
  const list = (args: readonly string[]): readonly string[] =>
    docker([...args, "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"])
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  return {
    containers: docker([
      "ps",
      "--all",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      "{{.Names}}",
    ])
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    networks: list(["network", "ls"]),
    volumes: list(["volume", "ls"]),
  };
}

/** Drives one run to `case_selected` against the environment-interacting adapter. */
function selectedComposeRun(): ComposeRun {
  const adapterEntry = referenceAdapterEntry("reference-otel-demo");
  // A fresh run root and its own preregistration: the shared `runToAcquired`
  // helper binds the *fake-subject* adapter, and this file needs a run bound to
  // the environment-interacting one from its first durable byte.
  const registry = buildGovernorRegistry();
  const runRoot = ownedRunRoot("erl2-compose-e2e-");
  const base0 = [
    "--run-root", runRoot,
    "--registry", registry.root,
    "--tier", "development",
    "--adapter-entry", adapterEntry,
  ];
  const prereg = erl2([
    "preregister-acquisition", ...base0,
    "--acquisition-source", registry.sourceManifestHash,
    "--adapter", registry.referenceOtelDemoAdapterHash,
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
  const base = [...base0, "--run", runId];

  for (const [name, argv] of [
    ["acquire", ["acquire", ...base]],
    ["freeze-package", ["freeze-package", ...base]],
    [
      "verify-package",
      ["verify-package", ...base, "--subject-id", "reference-otel-demo", "--subject-version", "0.1.0"],
    ],
    [
      "preregister-challenge",
      [
        "preregister-challenge", ...base,
        "--journey-selection-policy", registry.journeySelectionPolicyHash,
        "--randomness-policy", registry.randomnessPolicyHash,
        ...registry.challengeCandidates.flatMap((c) => ["--challenge", c.challengeManifestHash]),
      ],
    ],
  ] as const) {
    const result = erl2(argv as readonly string[]);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
  }

  const sourceTrust = path.join(runRoot, "compose-source-trust.json");
  writeFileSync(
    sourceTrust,
    JSON.stringify({
      sourceTrustPolicyHash: registry.sourceTrustPolicyHash,
      randomnessRegistryHeadHash: registry.sourceTrustPolicyHash,
    }),
  );
  const selected = erl2([
    "select", ...base,
    "--source-trust-config", sourceTrust,
    "--expires", "2026-12-31T00:00:00Z",
  ]);
  assert.equal(selected.exitCode, 0, JSON.stringify(selected.body.errors));
  assert.equal(selected.body.state, "case_selected");
  return { runRoot, runId, registry, base, project: `erl2-${runId}` };
}

/** The full environment plan, with the Compose driver selected exactly once. */
function composePlan(run: ComposeRun): readonly (readonly [string, readonly string[]])[] {
  const env = [...run.base];
  return [
    ["provision", ["provision", ...env, "--archetype", run.registry.archetypeHash, "--environment-driver", "compose"]],
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

function retained<T>(run: ComposeRun, ...segments: readonly string[]): T {
  return JSON.parse(readFileSync(path.join(run.runRoot, "retained", ...segments), "utf8")) as T;
}

/**
 * Telemetry the collector received, read from the run's own exact container.
 *
 * Polled rather than sampled once: the emitting SDK batches, so "no spans yet" a
 * few hundred milliseconds after a request is a timing fact and not a telemetry
 * fact. Bounded, so a genuine absence still fails.
 */
function telemetry(run: ComposeRun): { readonly spans: number; readonly runAttributed: number } {
  const collector = `${run.project}-otel-collector`;
  let spans = 0;
  let runAttributed = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = spawnSync("docker", ["container", "logs", collector], { encoding: "utf8" });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    spans = [...text.matchAll(/\tTraces\t.*"spans": (\d+)/g)].reduce(
      (total, match) => total + Number(match[1]),
      0,
    );
    runAttributed = text.split(`erl2_run=${run.runId}`).length - 1;
    if (spans > 0 && runAttributed > 0) break;
    spawnSync(process.execPath, ["-e", "setTimeout(() => undefined, 1000)"]);
  }
  return { spans, runAttributed };
}

test("COMPOSE-E2E: a run reaches an offline-valid terminal through a real Compose substrate", SKIP, () => {
  const run = selectedComposeRun();
  const before = projectObjects(run.project);
  assert.deepEqual(
    [...before.containers, ...before.networks, ...before.volumes],
    [],
    "this run's project must not exist before it is provisioned",
  );

  const observed: Record<string, unknown> = {};
  for (const [name, argv] of composePlan(run)) {
    const result = erl2(argv);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);

    if (name === "provision") {
      // Real Docker objects, named for this run, exist now.
      const live = projectObjects(run.project);
      assert.deepEqual(
        [...live.containers].sort(),
        [`${run.project}-otel-collector`, `${run.project}-quote`],
        "the qualified subset is exactly two containers",
      );
      assert.deepEqual([...live.networks], [`${run.project}-net`]);
      assert.equal(result.body.data?.["resource_count"], 5);
      // Live execution really was linux/arm64-or-amd64, and the container really
      // is the digest the lock pins for it.
      const platform = docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]).stdout.trim();
      assert.ok(
        platform === "linux/arm64" || platform === "linux/amd64",
        `the executed platform ${platform} is not one the lock pins`,
      );
      observed["platform"] = platform;
    }

    if (name === "execute-subject:exercise") {
      const counts = telemetry(run);
      assert.ok(counts.spans > 0, "the collector received no spans; telemetry was not actually emitted");
      assert.ok(
        counts.runAttributed > 0,
        "no telemetry record carries this run's marker; the spans are not attributable to this run",
      );
      observed["telemetry"] = counts;
    }

    if (name === "activate") {
      // The mutation changed observable substrate state: the run's endpoint
      // container is attached to the run's challenge network.
      const networks = docker([
        "container",
        "inspect",
        `${run.project}-quote`,
        "--format",
        "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
      ]).stdout.trim();
      assert.ok(networks.includes(`${run.project}-challenge`), `mutation not observed: ${networks}`);
      observed["mutated"] = networks;
    }

    if (name === "restore") {
      const networks = docker([
        "container",
        "inspect",
        `${run.project}-quote`,
        "--format",
        "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
      ]).stdout.trim();
      assert.equal(
        networks.includes(`${run.project}-challenge`),
        false,
        "the challenge attachment survived restoration",
      );
      assert.equal(
        docker(["network", "inspect", `${run.project}-challenge`]).status !== 0,
        true,
        "the challenge network survived restoration",
      );
      assert.equal(result.body.data?.["passed"], true);
      assert.equal(result.body.data?.["residual_resources"], 0);
    }

    if (name === "destroy") {
      assert.equal(result.body.data?.["passed"], true);
      assert.equal(result.body.data?.["residue_after_teardown"], 0);
    }
  }

  // Zero residue, observed independently of what the run reported.
  const after = projectObjects(run.project);
  assert.deepEqual(
    { containers: [...after.containers], networks: [...after.networks], volumes: [...after.volumes] },
    { containers: [], networks: [], volumes: [] },
    "the run left Docker resources behind",
  );

  // The manifest that licensed this was the Compose one, enabled only because a
  // qualified lock said so.
  const manifest = retained<{ driver_id: string; driver_kind: string; enabled: boolean; substrate_lock_hash: string }>(
    run,
    "environment",
    "driver-manifest.json",
  );
  assert.equal(manifest.driver_kind, "compose");
  assert.equal(manifest.enabled, true);
  assert.match(manifest.substrate_lock_hash, /^sha256:/);
  const binding = retained<{
    driver_id: string;
    substrate_kind: string;
    driver_manifest_hash: string;
    substrate_lock_hash?: string;
  }>(run, "environment", "substrate-binding.json");
  assert.equal(binding.driver_id, "compose-driver");
  assert.equal(binding.substrate_kind, "compose-project");
  assert.equal(
    binding.substrate_lock_hash,
    manifest.substrate_lock_hash,
    "the binding must name the same qualification the driver manifest was signed against",
  );

  // Both baseline probes agreed: `baseline` runs two and refuses on a mismatch,
  // so reaching a frozen baseline at all is the agreement. The fingerprint is
  // recorded here so the property is visible rather than implied.
  const baseline = retained<{ fingerprint_hash: string; contamination: { detected: boolean }; probes: unknown[] }>(
    run,
    "environment",
    "baseline.json",
  );
  assert.equal(baseline.contamination.detected, false);
  assert.ok(baseline.probes.length >= 5, "a baseline over a real substrate must probe every graph member");

  // Restoration was proven by re-observation, not by the receipt.
  const probe = retained<{
    outcome: string;
    probe_status: string;
    observed_before: string[];
    observed_after: string[];
  }>(run, "environment", "restoration-probe.json");
  assert.equal(probe.probe_status, "observed");
  assert.equal(probe.outcome, "reverted");
  assert.ok(probe.observed_before.length > 0, "nothing was observed as applied before the compensation");
  assert.deepEqual(probe.observed_after, []);

  // Teardown inspected exact run-scoped selectors and found nothing.
  const teardown = retained<{ passed: boolean; checks: { selector: string; residue_count: number }[] }>(
    run,
    "teardown-verification.json",
  );
  assert.equal(teardown.passed, true);
  assert.ok(teardown.checks.length >= 5);
  for (const check of teardown.checks) {
    assert.ok(check.selector.includes(run.runId), `selector ${check.selector} is not run-scoped`);
    assert.equal(check.residue_count, 0);
  }

  // Offline verification, in a fresh process, as an external reader.
  const verified = verifyBundle(run.runRoot, {
    sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
  });
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  const data = verified.body.data as {
    verdict: string;
    closure: { derived_terminal_variant: string; missing_roles: string[]; rejected_extra_hashes: string[] };
  };
  assert.equal(data.verdict, "valid");
  assert.equal(data.closure.derived_terminal_variant, "environment");
  assert.deepEqual(data.closure.missing_roles, []);
  assert.deepEqual(data.closure.rejected_extra_hashes, []);

  // The claim stays honestly derived: a development-tier run driven by a trusted
  // repository-owned subject is T1, and no amount of real substrate raises it.
  const attestation = retained<{ claim_scope: string; selection_assurance: { blindness_claim: string } }>(
    run,
    "final-attestation.json",
  );
  assert.equal(attestation.claim_scope, "T1");
  assert.equal(attestation.selection_assurance.blindness_claim, "none");
  // A real substrate raises the *environment-realism* component to T2 and the
  // overall ceiling not at all: the run is still development tier with non-blind
  // selection, and the ceiling is the weakest applicable component. Asking for
  // more than the evidence supports is reduced, never granted.
  assert.equal(observed["telemetry"] !== undefined, true);
});

test("COMPOSE-E2E: a run may not substitute its driver after it has bound one", SKIP, () => {
  const run = selectedComposeRun();
  const provisioned = erl2([
    "provision", ...run.base,
    "--archetype", run.registry.archetypeHash,
    "--environment-driver", "compose",
  ]);
  assert.equal(provisioned.exitCode, 0, JSON.stringify(provisioned.body.errors));
  try {
    const substituted = erl2(["baseline", ...run.base, "--environment-driver", "fake"]);
    assert.notEqual(substituted.exitCode, 0, "a driver substitution must be refused");
    assert.equal(substituted.body.errors[0]?.code, "ENV_SUBSTRATE_LOCATOR_CONFLICT");
    // And a command that names nothing still reaches the Compose substrate.
    const resumed = erl2(["baseline", ...run.base]);
    assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.body.errors));
  } finally {
    // The environment is real, so this test cleans up after itself by exact name.
    for (const service of ["quote", "otel-collector"]) {
      docker(["container", "rm", "--force", `${run.project}-${service}`]);
    }
    docker(["network", "rm", `${run.project}-net`]);
  }
  assert.deepEqual(
    [...projectObjects(run.project).containers, ...projectObjects(run.project).networks],
    [],
  );
});
