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
import { ownedRunRoot, ownedTempDir } from "../support/tempDirs.js";
import {
  awaitDurableTelemetry,
  explainDurableTelemetry,
  startCollectorCapture,
  type CollectorCapture,
  type DurableTelemetryObservation,
} from "../support/durableTelemetry.js";

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
    "--adapter-certification", registry.referenceOtelDemoCertificationHash,
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
 * Telemetry the collector received, read from a durable copy of its output.
 *
 * This used to re-read `docker container logs` after the fact. The pinned
 * collector rotates its `json-file` log (`max-size=5m`, `max-file=2`) and
 * exports its own self-telemetry back through the detailed `debug` exporter, so
 * a loaded run writes past the retention window in seconds: a diagnosed failure
 * had three HTTP 200 `/getquote` responses, spans emitted, spans received and 63
 * run-marked records, and still reported "telemetry was not actually emitted"
 * because the console line carrying the count had already rotated away. The
 * follower attached at `provision` copies the stream as it is produced, so
 * rotation inside the container cannot evict what was already observed.
 */
function telemetry(capture: CollectorCapture, run: ComposeRun): DurableTelemetryObservation {
  return awaitDurableTelemetry({ capture, runId: run.runId });
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
  // Attached the moment the collector exists and detached in `finally`, so the
  // durable copy spans the whole run and leaves nothing behind either way.
  let capture: CollectorCapture | undefined;
  try {
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
      // Six, not five: the project, the network, both containers, the published
      // port — and, since package 2, the run's trusted telemetry volume, which
      // the driver owns and therefore inventories and reaps.
      //
      // `157cf04` admitted the volume into the live *driver contract* test and
      // did not reach this one, so this expectation stayed at the pre-package-2
      // inventory and this suite has been failing here since. Found by running
      // the broad suite during the package 2 remediation, and reproduced at
      // `8485b8a` itself to confirm it is not a remediation regression.
      assert.equal(result.body.data?.["resource_count"], 6);
      // Live execution really was linux/arm64-or-amd64, and the container really
      // is the digest the lock pins for it.
      const platform = docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]).stdout.trim();
      assert.ok(
        platform === "linux/arm64" || platform === "linux/amd64",
        `the executed platform ${platform} is not one the lock pins`,
      );
      observed["platform"] = platform;
      capture = startCollectorCapture({
        containerName: `${run.project}-otel-collector`,
        directory: ownedTempDir("erl2-collector-capture-"),
      });
    }

    if (name === "execute-subject:exercise") {
      assert.ok(capture !== undefined, "the collector capture was never attached");
      const telemetryObservation = telemetry(capture, run);
      // One assertion, on the first missing transition. The previous pair could
      // report "telemetry was not actually emitted" for a run whose telemetry was
      // emitted, received and run-marked — the message named a conclusion the
      // evidence did not support. `diagnosticCode` names what actually failed.
      assert.equal(
        telemetryObservation.diagnosticCode,
        "CURRENT_RUN_SPANS_OBSERVED",
        explainDurableTelemetry(telemetryObservation),
      );
      assert.ok(
        telemetryObservation.currentRunSpanCount > 0,
        explainDurableTelemetry(telemetryObservation),
      );
      observed["telemetry"] = telemetryObservation;
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

  // The attributable-telemetry observation is *retained*, not merely observed
  // live (ADR-ERL2-033): frozen before teardown began, marked with this run's
  // id, and carrying the exact log lines its counts derive from. The counts
  // are re-derived here from the retained excerpt with the test's own
  // arithmetic, independently of the driver's.
  const observation = retained<{
    evidence: string;
    run_id: string;
    marker: string;
    run_attributed_records: number;
    spans: number;
    trace_batches: number;
    service_names: string[];
    collector: { service_id: string; container_name: string; ownership_verified: boolean };
    log_excerpt: string;
  }>(run, "environment", "attributable-telemetry-observation.json");
  assert.equal(observation.evidence, "observed", "the collector observation was not made");
  assert.equal(observation.run_id, run.runId);
  assert.equal(observation.marker, run.runId, "the marker must be the run id itself");
  assert.ok(
    observation.run_attributed_records > 0,
    "the retained observation carries no record naming this run's marker",
  );
  assert.ok(observation.spans > 0);
  assert.equal(observation.collector.service_id, "otel-collector");
  assert.equal(observation.collector.ownership_verified, true);
  assert.ok(observation.collector.container_name.includes("otel-collector"));
  const excerptText = observation.log_excerpt;
  assert.equal(
    excerptText.split(`erl2_run=${run.runId}`).length - 1 > 0,
    true,
    "the retained excerpt does not carry the run marker",
  );
  assert.equal(
    excerptText.split(run.runId).length - 1,
    observation.run_attributed_records,
    "the declared run-attributed count must equal the count re-derived from the retained excerpt",
  );
  const excerptSpans = [...excerptText.matchAll(/\bTraces\b.*"spans":\s*(\d+)/g)].reduce(
    (total, match) => total + Number(match[1]),
    0,
  );
  assert.equal(excerptSpans, observation.spans, "the declared span count must be derivable from the excerpt");

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
  } finally {
    capture?.dispose();
  }
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
    //
    // Including the trusted volume, which `provision` creates and which nothing
    // here ever asks the channel to remove: this case never runs `destroy`, so
    // the lifecycle that owns the volume never reaches its teardown. That is a
    // gap in this test rather than in the channel — but it left one
    // `erl2-trusted-<run>` behind on every execution, and a suite that leaks a
    // volume cannot be evidence that the lifecycle does not.
    for (const service of ["quote", "otel-collector"]) {
      docker(["container", "rm", "--force", `${run.project}-${service}`]);
    }
    docker(["network", "rm", `${run.project}-net`]);
    docker(["volume", "rm", "--force", `erl2-trusted-${run.runId}`]);
  }
  const after = projectObjects(run.project);
  assert.deepEqual([...after.containers, ...after.networks, ...after.volumes], []);
});
