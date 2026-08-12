/**
 * Slice 5 exit gate, end to end through the release CLI.
 *
 * The same `erl2` binary, the same journey commands and the same durable state
 * as Slice 4 — the only difference is `--adapter-entry`, which swaps the
 * development fake port for the real out-of-process adapter host. Both
 * reference adapters and a hostile one go through it unchanged, which is the
 * substance of "an opaque subject participates through a versioned adapter".
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGovernorRegistry, type GovernorRegistry } from "../support/governorRegistry.js";
import { referenceAdapterEntry, repoRoot, sabotageAdapterEntry } from "../support/adapterFixtures.js";
import {
  developmentKeyring,
  developmentTrustPolicy,
  localTrustConfiguration,
} from "../support/keys.js";

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

function erl2(args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  return { exitCode: result.status ?? -1, body: JSON.parse(result.stdout) as CliResult["body"] };
}

function newRunRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "erl2-adapter-journey-"));
}

/** Materialises the run's frozen event stream for the offline verifier. */
function writeLifecycle(runRoot: string): string {
  const events = readdirSync(path.join(runRoot, "events"))
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => JSON.parse(readFileSync(path.join(runRoot, "events", n), "utf8")) as unknown);
  const target = path.join(runRoot, "lifecycle.json");
  writeFileSync(target, `${JSON.stringify(events, null, 2)}\n`);
  return target;
}

/** Verifier-controlled local trust configuration, written outside the bundle. */
function writeRootConfig(runRoot: string): string {
  const keyring = developmentKeyring();
  const config = localTrustConfiguration(
    developmentTrustPolicy(keyring),
    keyring,
    [],
    `sha256:${"0".repeat(64)}`,
  );
  const target = path.join(runRoot, "root-config.json");
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  return target;
}

interface Journey {
  readonly registry: GovernorRegistry;
  readonly runRoot: string;
  readonly runId: string;
  readonly common: readonly string[];
}

type ReferenceAdapter = "reference-correct" | "reference-limited";

/**
 * Preregisters a run bound to one certified reference adapter.
 *
 * The adapter is resolved from the governor registry by core hash and driven
 * through `--adapter-entry`; nothing about the command set is adapter-specific.
 */
function startJourney(
  adapter: ReferenceAdapter,
  entryOverride?: string,
): Journey {
  const registry = buildGovernorRegistry();
  const adapterHash =
    adapter === "reference-correct"
      ? registry.referenceCorrectAdapterHash
      : registry.referenceLimitedAdapterHash;
  // A real adapter is never dispatched without its admitted certification
  // (ADR-ERL2-036); the governor registry admits the receipt beside the
  // manifest, and the run binds it here.
  const certificationHash =
    adapter === "reference-correct"
      ? registry.referenceCorrectCertificationHash
      : registry.referenceLimitedCertificationHash;
  const runRoot = newRunRoot();
  const base = [
    "--run-root", runRoot,
    "--registry", registry.root,
    "--tier", "development",
    "--adapter-entry", entryOverride ?? referenceAdapterEntry(adapter),
  ];
  const prereg = erl2([
    "preregister-acquisition",
    ...base,
    "--acquisition-source", registry.sourceManifestHash,
    "--adapter", adapterHash,
    "--adapter-certification", certificationHash,
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
  return { registry, runRoot, runId, common: [...base, "--run", runId] };
}

test("ADAPTER-CERT: acquisition through the correct reference adapter reaches a verified package", () => {
  const journey = startJourney("reference-correct");

  const acquired = erl2(["acquire", ...journey.common]);
  assert.equal(acquired.exitCode, 0, JSON.stringify(acquired.body.errors));
  assert.equal(acquired.body.data?.["status"], "completed");
  // The measurements come from the adapter's own reported evidence, not from a
  // Lab-side default.
  assert.equal(acquired.body.data?.["active_operator_ms"], 1800);
  assert.deepEqual(acquired.body.data?.["documentation_step_ids"], [
    "doc-quickstart",
    "doc-install-overview",
  ]);

  const frozen = erl2(["freeze-package", ...journey.common]);
  assert.equal(frozen.exitCode, 0, JSON.stringify(frozen.body.errors));

  const verified = erl2([
    "verify-package",
    ...journey.common,
    "--subject-id", "reference-correct",
    "--subject-version", "0.1.0",
  ]);
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  assert.equal(verified.body.data?.["status"], "completed");
  assert.equal(verified.body.state, "package_manifest_frozen");
  assert.equal(verified.body.data?.["next_authorized_state"], "challenge_preregistered");

  // ADR-ERL2-013 holds for a real adapter exactly as for the fake port.
  const early = erl2(["freeze-output", ...journey.common, "--terminal-stage", "verify_package"]);
  assert.equal(early.exitCode, 10);
  assert.equal(early.body.errors[0]?.code, "GRAPH_CLOSURE_TERMINAL_MISMATCH");

  // The host froze diagnostics for every operation, scanned and bounded, beneath
  // the subject-output payload root. They used to be published to a top-level
  // `diagnostics/` directory, which no offline accounting pass walks — so the
  // bytes were retained beside the evidence rather than inside it, and a deleted
  // or added diagnostics entry was invisible to the verifier.
  const diagnostics = path.join(journey.runRoot, "subject-output", "diagnostics");
  assert.equal(existsSync(diagnostics), true, "adapter diagnostics must be retained");
  assert.ok(readdirSync(diagnostics).length >= 2, "one diagnostics tree per operation");

  // …and each operation's host adjudication is retained beside them.
  const hostRecords = path.join(journey.runRoot, "retained", "adapter");
  assert.equal(existsSync(hostRecords), true, "adapter host records must be retained");
  assert.ok(
    readdirSync(hostRecords).length >= 2,
    "one host adjudication tree per operation",
  );
});

test("UNSUPPORTED-HONESTY: the limited reference adapter reaches a retained unsupported terminal", () => {
  const registry = buildGovernorRegistry();
  const runRoot = newRunRoot();
  const base = [
    "--run-root", runRoot,
    "--registry", registry.root,
    "--tier", "development",
    "--adapter-entry", referenceAdapterEntry("reference-limited"),
  ];
  const prereg = erl2([
    "preregister-acquisition",
    ...base,
    "--acquisition-source", registry.sourceManifestHash,
    "--adapter", registry.referenceLimitedAdapterHash,
    "--adapter-certification", registry.referenceLimitedCertificationHash,
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
  const common = [...base, "--run", prereg.body.run_id as string];

  assert.equal(erl2(["acquire", ...common]).exitCode, 0);
  assert.equal(erl2(["freeze-package", ...common]).exitCode, 0);

  const verified = erl2([
    "verify-package",
    ...common,
    "--subject-id", "reference-limited",
    "--subject-version", "0.1.0",
  ]);
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  // The subject ships as an OCI image and the Lab froze an archive. The honest
  // answer is `unsupported`, and it is retained rather than collapsed into a
  // failure or filtered out of the run.
  assert.equal(verified.body.data?.["status"], "unsupported");
  assert.equal(verified.body.data?.["subject_package_manifest_hash"], undefined);

  const output = erl2(["freeze-output", ...common, "--terminal-stage", "verify_package"]);
  assert.equal(output.exitCode, 0, JSON.stringify(output.body.errors));
  assert.equal(output.body.state, "subject_output_frozen");

  const record = JSON.parse(
    readFileSync(path.join(runRoot, "retained", "subject-package-verification-record.json"), "utf8"),
  ) as { status: string };
  assert.equal(record.status, "unsupported");
});

test("FAILURE-FIXTURES: a hostile adapter yields an adapter exit, never a subject defect", () => {
  const registry = buildGovernorRegistry();
  const runRoot = newRunRoot();
  const base = [
    "--run-root", runRoot,
    "--registry", registry.root,
    "--tier", "development",
    "--adapter-entry", sabotageAdapterEntry("crash-before-response"),
  ];
  const prereg = erl2([
    "preregister-acquisition",
    ...base,
    "--acquisition-source", registry.sourceManifestHash,
    "--adapter", registry.referenceCorrectAdapterHash,
    // Legitimately certified manifest, different bytes on disk: the host now
    // refuses this before it spawns anything (ADR-ERL2-036 §6).
    "--adapter-certification", registry.referenceCorrectCertificationHash,
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
  const common = [...base, "--run", prereg.body.run_id as string];

  const acquired = erl2(["acquire", ...common]);
  assert.notEqual(acquired.exitCode, 0);
  // Exit 6 is the adapter/subject execution domain; the *code* discriminates,
  // and it names the adapter.
  assert.equal(acquired.exitCode, 6);
  assert.ok(
    ["ADAPTER_IDENTITY_MISMATCH", "ADAPTER_PROCESS_CRASHED"].includes(
      acquired.body.errors[0]?.code as string,
    ),
    `unexpected code ${String(acquired.body.errors[0]?.code)}`,
  );
  assert.match(acquired.body.errors[0]?.code as string, /^ADAPTER_/);

  // Appendix C: the run id was durably accepted, so the run may not simply
  // error out — it freezes exactly one invalid record after bounded cleanup,
  // and the CLI returns that record's hash alongside the failure.
  assert.equal(acquired.body.state, "invalidated");
  assert.match(acquired.body.data?.["invalid_run_record_hash"] as string, /^sha256:/);
  assert.equal(acquired.body.data?.["terminal_state"], "invalidated");

  const finding = JSON.parse(
    readFileSync(path.join(runRoot, "retained", "finding-adapter-protocol-failure.json"), "utf8"),
  ) as { kind: string; owner: string; subject_attribution_proven: boolean; scoreable_planes: unknown[] };
  assert.equal(finding.kind, "adapter_failure");
  assert.equal(finding.owner, "adapter");
  assert.equal(finding.subject_attribution_proven, false);
  assert.deepEqual(finding.scoreable_planes, []);

  // And it verifies offline, in a fresh process, with no attestation anywhere.
  const verified = erl2([
    "verify-record",
    "--record", path.join(runRoot, "retained", "invalid-run-record.json"),
    "--lifecycle", writeLifecycle(runRoot),
    "--artifact-root", runRoot,
    "--root-config", writeRootConfig(runRoot),
    "--offline",
  ]);
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
  const closure = verified.body.data?.["closure"] as {
    derived_terminal_variant: string;
    verdict: string;
    rejected_extra_hashes: string[];
  };
  assert.equal(closure.derived_terminal_variant, "invalid");
  assert.equal(closure.verdict, "valid");
  assert.deepEqual(closure.rejected_extra_hashes, []);
});

test("ADAPTER-CERT: a run cannot substitute a different adapter after preregistration", () => {
  const registry = buildGovernorRegistry();
  const runRoot = newRunRoot();
  const base = [
    "--run-root", runRoot,
    "--registry", registry.root,
    "--tier", "development",
    "--adapter-entry", referenceAdapterEntry("reference-correct"),
  ];
  const prereg = erl2([
    "preregister-acquisition",
    ...base,
    "--acquisition-source", registry.sourceManifestHash,
    "--adapter", registry.referenceCorrectAdapterHash,
    // Legitimately certified manifest, different bytes on disk: the host now
    // refuses this before it spawns anything (ADR-ERL2-036 §6).
    "--adapter-certification", registry.referenceCorrectCertificationHash,
    "--acquisition-actor-script", registry.acquisitionActorScriptHash,
    "--acquisition-actor-schema", registry.acquisitionActorSchemaHash,
    "--acquisition-step", registry.acquisitionStep.commitmentHash,
    "--package-verification-step", registry.packageVerificationStep.commitmentHash,
    "--generic-policy", registry.genericRunPolicyHash,
    "--trust-policy", registry.runTrustPolicyHash,
    "--limits", registry.limitsHash,
    "--expires", "2026-12-31T00:00:00Z",
  ]);
  const runId = prereg.body.run_id as string;
  // Even with a different entry file, the manifest the run bound is the one the
  // host is constructed from, so the running adapter's identity will not match.
  const swapped = erl2([
    "acquire",
    "--run-root", runRoot,
    "--registry", registry.root,
    "--tier", "development",
    "--adapter-entry", referenceAdapterEntry("reference-limited"),
    "--run", runId,
  ]);
  assert.notEqual(swapped.exitCode, 0);
  assert.equal(swapped.body.errors[0]?.code, "ADAPTER_IDENTITY_MISMATCH");
});

test("ADAPTER-CERT: the fake-port scripting flags cannot steer a real adapter", () => {
  const registry = buildGovernorRegistry();
  const runRoot = newRunRoot();
  const result = erl2([
    "preregister-acquisition",
    "--run-root", runRoot,
    "--registry", registry.root,
    "--tier", "development",
    "--adapter-entry", referenceAdapterEntry("reference-correct"),
    "--fake-acquire", "failed",
    "--acquisition-source", registry.sourceManifestHash,
    "--adapter", registry.referenceCorrectAdapterHash,
    // Legitimately certified manifest, different bytes on disk: the host now
    // refuses this before it spawns anything (ADR-ERL2-036 §6).
    "--adapter-certification", registry.referenceCorrectCertificationHash,
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
  assert.equal(result.body.errors[0]?.code, "CFG_MISSING_REQUIRED");
});

test("JOURNEY-ORACLE-CANARY: no judge canary reaches an adapter-visible byte", () => {
  const journey = startJourney("reference-correct");
  erl2(["acquire", ...journey.common]);
  erl2(["freeze-package", ...journey.common]);
  erl2([
    "verify-package",
    ...journey.common,
    "--subject-id", "reference-correct",
    "--subject-version", "0.1.0",
  ]);

  const chunks: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const child = path.join(dir, name);
      if (statSync(child).isDirectory()) walk(child);
      else chunks.push(readFileSync(child).toString("latin1"));
    }
  };
  walk(journey.runRoot);
  walk(journey.registry.root);
  const visible = chunks.join("\n");
  assert.equal(visible.match(/erl2-canary-[0-9a-f]{32}/g), null);
  assert.equal(visible.match(/erl2-secret-[0-9a-f]{32}/g), null);
});
