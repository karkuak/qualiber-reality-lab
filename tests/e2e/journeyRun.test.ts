/**
 * Slice 4 exit gate: acquisition reaches frozen subject output through the CLI,
 * ordering is enforced, the run survives a process boundary, and no judge
 * canary reaches subject-visible state.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash } from "@erl2/integrity";
import { buildGovernorRegistry, type GovernorRegistry } from "../support/governorRegistry.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cli = path.join(repoRoot, "packages", "cli", "dist", "src", "bin.js");

interface CliResult {
  readonly exitCode: number;
  readonly body: {
    ok: boolean;
    run_id?: string;
    state?: string;
    data?: Record<string, unknown>;
    errors: { code: string; message: string }[];
  };
}

function erl2(args: readonly string[], extraEnv: Record<string, string> = {}): CliResult {
  // This harness drives the development fake subject port, so it opts into the
  // explicit development profile that gates the `--fake-*` scripting flags
  // (§11.8). A test can pass an empty extraEnv override to exercise the release
  // surface (which refuses those flags).
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ERL2_DEVELOPMENT_FAKE_SUBJECT: "1", ...extraEnv },
  });
  return { exitCode: result.status ?? -1, body: JSON.parse(result.stdout) as CliResult["body"] };
}

/** Spawns the release surface with the development fake-subject profile disabled. */
function erl2Release(args: readonly string[]): CliResult {
  const env = { ...process.env };
  delete env["ERL2_DEVELOPMENT_FAKE_SUBJECT"];
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
  return { exitCode: result.status ?? -1, body: JSON.parse(result.stdout) as CliResult["body"] };
}

function common(registry: GovernorRegistry, runRoot: string, runId?: string): string[] {
  return [
    "--run-root", runRoot,
    "--registry", registry.root,
    "--tier", "development",
    ...(runId === undefined ? [] : ["--run", runId]),
  ];
}

function preregister(registry: GovernorRegistry, runRoot: string): CliResult {
  return erl2([
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
}

function newRunRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "erl2-journey-"));
}

/** Finds the first file named `name` anywhere under `dir`. */
function findFile(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir)) {
    const child = path.join(dir, entry);
    if (statSync(child).isDirectory()) {
      const found = findFile(child, name);
      if (found) return found;
    } else if (entry === name) {
      return child;
    }
  }
  return undefined;
}

function readJsonFile(dir: string, name: string): Record<string, unknown> {
  const p = findFile(dir, name);
  assert.ok(p, `expected to find ${name} under ${dir}`);
  return JSON.parse(readFileSync(p as string, "utf8")) as Record<string, unknown>;
}

/** Every byte a subject could reach: the run root plus the admission registry. */
function subjectVisibleText(runRoot: string, registryRoot: string): string {
  const chunks: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const child = path.join(dir, name);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      chunks.push(readFileSync(child).toString("latin1"));
    }
  };
  walk(runRoot);
  walk(registryRoot);
  return chunks.join("\n");
}

test("JOURNEY-CAPTURE: a successful package verification continues to challenge preregistration", () => {
  const registry = buildGovernorRegistry();
  const runRoot = newRunRoot();

  const prereg = preregister(registry, runRoot);
  assert.equal(prereg.exitCode, 0, JSON.stringify(prereg.body.errors));
  assert.equal(prereg.body.state, "acquisition_preregistered");
  assert.equal(prereg.body.data?.["selected_case_identity"], "absent");
  const runId = prereg.body.run_id as string;

  const acquired = erl2(["acquire", ...common(registry, runRoot, runId)]);
  assert.equal(acquired.exitCode, 0, JSON.stringify(acquired.body.errors));
  assert.equal(acquired.body.data?.["status"], "completed");
  // Acquisition is measured, not merely performed.
  assert.ok((acquired.body.data?.["active_operator_ms"] as number) > 0);
  assert.ok((acquired.body.data?.["elapsed_ms"] as number) > 0);
  assert.ok((acquired.body.data?.["documentation_step_ids"] as string[]).length > 0);

  const frozen = erl2(["freeze-package", ...common(registry, runRoot, runId)]);
  assert.equal(frozen.exitCode, 0, JSON.stringify(frozen.body.errors));
  assert.match(frozen.body.data?.["frozen_package_path"] as string, /package-store\/sha256\//);

  const verified = erl2([
    "verify-package",
    ...common(registry, runRoot, runId),
    "--subject-id", "fake-subject",
    "--subject-version", "0.1.0",
  ]);
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  assert.equal(verified.body.data?.["status"], "completed");
  assert.match(verified.body.data?.["subject_package_manifest_hash"] as string, /^sha256:/);
  assert.equal(verified.body.state, "package_manifest_frozen");
  assert.equal(verified.body.data?.["next_authorized_state"], "challenge_preregistered");

  // §11.6: the manifest's configuration-schema and capability-declaration hashes
  // are DERIVED from the actual admitted adapter manifest, not hardcoded to a
  // fixed `fake-subject/v1` literal. Recompute the derivation independently from
  // the frozen adapter manifest and assert the manifest matches it — and does
  // NOT carry the old hardcoded literal.
  const manifest = readJsonFile(runRoot, "subject-package-manifest.json");
  const adapter = readJsonFile(runRoot, "adapter-manifest.json");
  const expectedConfigHash = coreHash({
    configuration_schema: {
      adapter_id: adapter["adapter_id"],
      protocol_version: adapter["protocol_version"],
      projection_schema: adapter["projection_schema"],
    },
  });
  const expectedCapabilityHash = coreHash({
    capability_declaration: {
      adapter_id: adapter["adapter_id"],
      adapter_version: adapter["version"],
      supported_package_kinds: adapter["supported_package_kinds"],
      operations: adapter["operations"],
      required_broker_capabilities: adapter["required_broker_capabilities"],
      network_allowlist_ids: adapter["network_allowlist_ids"],
    },
  });
  assert.equal(manifest["configuration_schema_hash"], expectedConfigHash);
  assert.equal(manifest["capability_declaration_hash"], expectedCapabilityHash);
  const legacyFakeConfig = coreHash({ configuration_schema: "fake-subject/v1" });
  const legacyFakeCapability = coreHash({ capability_declaration: "fake-subject/v1" });
  assert.notEqual(manifest["configuration_schema_hash"], legacyFakeConfig);
  assert.notEqual(manifest["capability_declaration_hash"], legacyFakeCapability);

  // ADR-ERL2-013: a successful package manifest may not finalize through the
  // pre-environment branch. There is exactly one authorized continuation.
  const output = erl2([
    "freeze-output",
    ...common(registry, runRoot, runId),
    "--terminal-stage", "verify_package",
  ]);
  assert.notEqual(output.exitCode, 0);
  assert.equal(output.body.errors[0]?.code, "GRAPH_CLOSURE_TERMINAL_MISMATCH");

  const status = erl2(["status", "--run", runId, "--artifact-root", runRoot]);
  assert.equal(status.exitCode, 0);
  assert.equal(status.body.state, "package_manifest_frozen");
});

test("EARLY-TERMINAL-CLOSURE: a failed package verification reaches frozen subject output", () => {
  const registry = buildGovernorRegistry();
  const runRoot = newRunRoot();
  const prereg = preregister(registry, runRoot);
  const runId = prereg.body.run_id as string;

  erl2(["acquire", ...common(registry, runRoot, runId)]);
  erl2(["freeze-package", ...common(registry, runRoot, runId)]);
  const verified = erl2([
    "verify-package",
    ...common(registry, runRoot, runId),
    "--subject-id", "fake-subject",
    "--subject-version", "0.1.0",
    "--fake-verify-package", "failed",
  ]);
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  assert.equal(verified.body.data?.["status"], "failed");
  assert.equal(verified.body.data?.["subject_package_manifest_hash"], undefined);
  // The generic terminal step-outcome route, not a package-manifest edge.
  assert.equal(verified.body.state, "step_outcome_frozen");

  const output = erl2([
    "freeze-output",
    ...common(registry, runRoot, runId),
    "--terminal-stage", "verify_package",
  ]);
  assert.equal(output.exitCode, 0, JSON.stringify(output.body.errors));
  assert.equal(output.body.state, "subject_output_frozen");
  assert.equal(output.body.data?.["terminal_stage"], "verify_package");
  // The ordered step closure is derived from lifecycle events, not asserted.
  assert.equal((output.body.data?.["step_outcome_hashes"] as string[]).length, 2);

  const manifest = JSON.parse(
    readFileSync(path.join(runRoot, "retained", "subject-output-manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(Object.hasOwn(manifest, "subject_package_manifest_hash"), false);
});

test("EARLY-TERMINAL-CLOSURE: an unsupported package verification also reaches the terminal", () => {
  const registry = buildGovernorRegistry();
  const runRoot = newRunRoot();
  const prereg = preregister(registry, runRoot);
  const runId = prereg.body.run_id as string;

  erl2(["acquire", ...common(registry, runRoot, runId)]);
  erl2(["freeze-package", ...common(registry, runRoot, runId)]);
  const verified = erl2([
    "verify-package",
    ...common(registry, runRoot, runId),
    "--subject-id", "fake-subject",
    "--subject-version", "0.1.0",
    "--fake-verify-package", "unsupported",
  ]);
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  assert.equal(verified.body.data?.["status"], "unsupported");

  const output = erl2([
    "freeze-output",
    ...common(registry, runRoot, runId),
    "--terminal-stage", "verify_package",
  ]);
  assert.equal(output.exitCode, 0, JSON.stringify(output.body.errors));
  assert.equal(output.body.state, "subject_output_frozen");
});

test("JOURNEY-ORACLE-CANARY: no judge canary reaches any subject-visible byte", () => {
  const registry = buildGovernorRegistry();
  const runRoot = newRunRoot();
  const prereg = preregister(registry, runRoot);
  const runId = prereg.body.run_id as string;
  erl2(["acquire", ...common(registry, runRoot, runId)]);
  erl2(["freeze-package", ...common(registry, runRoot, runId)]);
  erl2([
    "verify-package",
    ...common(registry, runRoot, runId),
    "--subject-id", "fake-subject",
    "--subject-version", "0.1.0",
    "--fake-verify-package", "failed",
  ]);
  const output = erl2([
    "freeze-output",
    ...common(registry, runRoot, runId),
    "--terminal-stage", "verify_package",
  ]);
  assert.equal(output.exitCode, 0, JSON.stringify(output.body.errors));

  const visible = subjectVisibleText(runRoot, registry.root);
  assert.ok(registry.canaryIds.length >= 14, "fixture should commit a canary per step");
  for (const canary of registry.canaryIds) {
    assert.ok(!visible.includes(canary), `canary ${canary} reached subject-visible state`);
  }
  // And no well-formed canary of any kind, known or not.
  assert.equal(visible.match(/erl2-canary-[0-9a-f]{32}/g), null);
});

test("REQUEST-ANCESTRY: the ordered journey refuses a skipped stage", () => {
  const registry = buildGovernorRegistry();
  const runRoot = newRunRoot();
  const prereg = preregister(registry, runRoot);
  const runId = prereg.body.run_id as string;

  // Freezing the package before acquiring it has no acquisition record to bind.
  const early = erl2(["freeze-package", ...common(registry, runRoot, runId)]);
  assert.notEqual(early.exitCode, 0);
  assert.equal(early.body.errors[0]?.code, "GRAPH_CLOSURE_MISSING_ROLE");

  // Verifying the package before acquisition likewise fails closed.
  const earlyVerify = erl2([
    "verify-package",
    ...common(registry, runRoot, runId),
    "--subject-id", "fake-subject",
    "--subject-version", "0.1.0",
  ]);
  assert.notEqual(earlyVerify.exitCode, 0);
  assert.equal(earlyVerify.body.errors[0]?.code, "GRAPH_CLOSURE_MISSING_ROLE");
});

test("CRASH-MATRIX: the run resumes across process boundaries from its frozen events", () => {
  const registry = buildGovernorRegistry();
  const runRoot = newRunRoot();
  const prereg = preregister(registry, runRoot);
  const runId = prereg.body.run_id as string;

  // Each command below is a separate OS process; nothing is held in memory.
  erl2(["acquire", ...common(registry, runRoot, runId)]);
  const midway = erl2(["status", "--run", runId, "--artifact-root", runRoot]);
  assert.equal(midway.body.state, "step_outcome_frozen");

  erl2(["freeze-package", ...common(registry, runRoot, runId)]);
  erl2([
    "verify-package",
    ...common(registry, runRoot, runId),
    "--subject-id", "fake-subject",
    "--subject-version", "0.1.0",
    "--fake-verify-package", "failed",
  ]);
  const resumed = erl2([
    "freeze-output",
    ...common(registry, runRoot, runId),
    "--terminal-stage", "verify_package",
  ]);
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.body.errors));
  assert.equal((resumed.body.data?.["step_outcome_hashes"] as string[]).length, 2);
});

test("ERL2-OQ-007 fail-closed: a held-out or blind tier is refused at the CLI", () => {
  const registry = buildGovernorRegistry();
  const runRoot = newRunRoot();
  for (const tier of ["held_out", "blind"]) {
    const result = erl2([
      "preregister-acquisition",
      "--run-root", runRoot,
      "--registry", registry.root,
      "--tier", tier,
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
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.body.errors[0]?.code, "ADMISSION_SUBJECT_PORT_NOT_DEVELOPMENT");
  }
});

test("ADMISSION: an unadmitted artifact hash is refused", () => {
  const registry = buildGovernorRegistry();
  const runRoot = newRunRoot();
  const result = erl2([
    "preregister-acquisition",
    ...common(registry, runRoot),
    "--acquisition-source", `sha256:${"f".repeat(64)}`,
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
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.body.errors[0]?.code, "ADMISSION_ARTIFACT_UNKNOWN");
});

test("EARLY-TERMINAL-CLOSURE: a failed acquisition freezes one invalid record that verifies offline", async () => {
  const { verifyInvalidRecord } = await import("@erl2/public-verifier");
  const { developmentKeyring } = await import("../support/keys.js");
  const { developmentTrustPolicy, localTrustConfiguration } = await import("../support/keys.js");
  const registry = buildGovernorRegistry();
  const runRoot = newRunRoot();

  const prereg = preregister(registry, runRoot);
  const runId = prereg.body.run_id as string;
  const failed = erl2(["acquire", ...common(registry, runRoot, runId), "--fake-acquire", "failed"]);

  assert.equal(failed.exitCode, 0, JSON.stringify(failed.body.errors));
  assert.equal(failed.body.data?.["status"], "failed");
  // The CLI never returns a terminal state without its record hash.
  assert.match(failed.body.data?.["invalid_run_record_hash"] as string, /^sha256:/);
  assert.equal(failed.body.data?.["terminal_state"], "invalidated");
  assert.equal(failed.body.data?.["cleanup_variant"], "pre_environment");
  assert.equal(failed.body.state, "invalidated");

  const record = JSON.parse(
    readFileSync(path.join(runRoot, "retained", "invalid-run-record.json"), "utf8"),
  ) as unknown;
  const lifecycle = readdirSync(path.join(runRoot, "events"))
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => JSON.parse(readFileSync(path.join(runRoot, "events", n), "utf8")) as never);

  const keyring = developmentKeyring();
  const closure = verifyInvalidRecord({
    record,
    artifactRoot: runRoot,
    lifecycle,
    localTrust: localTrustConfiguration(
      developmentTrustPolicy(keyring),
      keyring,
      [],
      `sha256:${"0".repeat(64)}`,
    ),
    verifiedAt: "2026-07-02T00:00:00Z",
    offline: true,
  });
  assert.equal(closure.derived_terminal_variant, "invalid");
  assert.equal(closure.verdict, "valid");
  assert.deepEqual(closure.rejected_extra_hashes, []);

  // No attestation and no bundle may exist anywhere beneath the run root.
  const visible = subjectVisibleText(runRoot, registry.root);
  assert.ok(!visible.includes("final-lab-attestation"));
  assert.ok(!visible.includes("public-verification-bundle"));
});

test("§11.8: the release surface refuses the fake-subject scripting flags", () => {
  const registry = buildGovernorRegistry();
  const runRoot = newRunRoot();
  const prereg = preregister(registry, runRoot);
  const runId = prereg.body.run_id as string;

  // Without the explicit development profile (ERL2_DEVELOPMENT_FAKE_SUBJECT=1),
  // the fake-subject scripting flags are not reachable: the CLI refuses them
  // with a stable code rather than scripting the fake port.
  const refusedAcquire = erl2Release([
    "acquire",
    ...common(registry, runRoot, runId),
    "--fake-acquire", "failed",
  ]);
  assert.notEqual(refusedAcquire.exitCode, 0);
  assert.equal(refusedAcquire.body.errors[0]?.code, "CFG_DEVELOPMENT_FLAG_UNAVAILABLE");

  const refusedVerify = erl2Release([
    "verify-package",
    ...common(registry, runRoot, runId),
    "--subject-id", "fake-subject",
    "--subject-version", "0.1.0",
    "--fake-verify-package", "succeeded",
  ]);
  assert.notEqual(refusedVerify.exitCode, 0);
  assert.equal(refusedVerify.body.errors[0]?.code, "CFG_DEVELOPMENT_FLAG_UNAVAILABLE");
});
