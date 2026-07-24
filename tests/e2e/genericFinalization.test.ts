/**
 * Slice 6 exit gate: a real run reaches a *valid* pre-environment terminal
 * through the CLI, across process boundaries, and its public bundle verifies
 * offline in a fresh process.
 *
 * Every artifact here is produced by the shipped commands — no fixture builds a
 * result, a validity verdict, an attestation or a bundle by hand. The offline
 * verification at the end runs the neutral verifier over the run root, with the
 * trust head taken only from a locally pinned configuration file.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash } from "@erl2/integrity";
import { buildGovernorRegistry, type GovernorRegistry } from "../support/governorRegistry.js";
import { developmentKeyring } from "../support/keys.js";

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

function erl2(args: readonly string[]): CliResult {
  // Drives the development fake subject port; opts into the explicit development
  // profile that gates the `--fake-*` scripting flags (§11.8).
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ERL2_DEVELOPMENT_FAKE_SUBJECT: "1" },
  });
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

/**
 * Drives a run from preregistration to a frozen, evaluated, finalized valid
 * pre-environment terminal. `verifyStatus` chooses which retained early
 * terminal the run reaches.
 */
function runToValidTerminal(verifyStatus: "failed" | "unsupported"): {
  readonly registry: GovernorRegistry;
  readonly runRoot: string;
  readonly runId: string;
  readonly steps: Readonly<Record<string, CliResult>>;
} {
  const registry = buildGovernorRegistry();
  const runRoot = mkdtempSync(path.join(tmpdir(), "erl2-slice6-"));
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

  const steps: Record<string, CliResult> = { prereg };
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
    [
      "freeze-output",
      ["freeze-output", ...common(registry, runRoot, runId), "--terminal-stage", "verify_package"],
    ],
    ["reveal", ["reveal", ...common(registry, runRoot, runId), "--vault", registry.vaultRoot]],
    ["evaluate", ["evaluate", ...common(registry, runRoot, runId)]],
    [
      "finalize-generic",
      ["finalize-generic", ...common(registry, runRoot, runId), "--claim-scope", "T1"],
    ],
  ];
  for (const [name, argv] of plan) {
    const result = erl2(argv);
    assert.equal(result.exitCode, 0, `${name}: ${JSON.stringify(result.body.errors)}`);
    steps[name] = result;
  }
  return { registry, runRoot, runId, steps };
}

/** Collects the run's lifecycle stream, exactly as an external verifier would. */
function writeLifecycle(runRoot: string): string {
  const events: { sequence: number }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const child = path.join(dir, name);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!name.endsWith(".json") || name.endsWith(".frozen")) continue;
      const value = JSON.parse(readFileSync(child, "utf8")) as {
        schema_version?: string;
        sequence?: number;
      };
      if (value.schema_version === "lab-lifecycle-event/v1") {
        events.push(value as { sequence: number });
      }
    }
  };
  walk(runRoot);
  events.sort((a, b) => a.sequence - b.sequence);
  const streamPath = path.join(runRoot, "lifecycle.json");
  writeFileSync(streamPath, JSON.stringify(events));
  return streamPath;
}

/** The verifier's own locally pinned trust configuration. */
function writeTrustConfig(runRoot: string): string {
  const policy = JSON.parse(
    readFileSync(path.join(runRoot, "retained", "trust-policy.json"), "utf8"),
  ) as object;
  const configPath = path.join(runRoot, "trust-config.json");
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

test("GENERIC-FINALIZATION: a failed package verification reaches a valid terminal whose bundle verifies offline", () => {
  const { runRoot, steps } = runToValidTerminal("failed");

  // The journey plane evaluated; the domain plane is not applicable with the
  // exact reason the terminal derives. No functional score was invented.
  const evaluate = steps["evaluate"]?.body.data as Record<string, unknown>;
  assert.equal(evaluate["journey_status"], "evaluated");
  assert.equal(evaluate["domain_status"], "not_applicable");
  assert.equal(evaluate["domain_not_applicable_reason"], "pre_environment_terminal");
  assert.equal(evaluate["domain_variant"], "not_applicable");

  // Journey metrics were measured deterministically, and none of them is a
  // combined scalar.
  const metrics = evaluate["metric_results"] as { metric_id: string; status: string }[];
  assert.ok(metrics.length >= 8, "the journey plane measures more than one metric");
  assert.ok(
    metrics.some((m) => m.metric_id === "step-failure-count" && m.status === "measured"),
    "the failed step is counted",
  );
  assert.ok(
    metrics.every((m) => m.metric_id !== "overall-score" && m.metric_id !== "total"),
    "no metric aggregates the planes into one number",
  );

  const finalize = steps["finalize-generic"]?.body.data as Record<string, unknown>;
  assert.equal(finalize["validity_status"], "valid");
  assert.equal(finalize["terminal_stage"], "verify_package");
  assert.equal(finalize["claim_scope"], "T1");

  // Offline verification in a fresh process, trust head from local pins only.
  const verify = erl2([
    "verify",
    "--public-bundle", path.join(runRoot, "retained", "public-bundle.json"),
    "--root-config", writeTrustConfig(runRoot),
    "--artifact-root", runRoot,
    "--lifecycle", writeLifecycle(runRoot),
    "--offline",
  ]);
  assert.equal(verify.exitCode, 0, JSON.stringify(verify.body.errors));
  const data = verify.body.data as Record<string, unknown>;
  assert.equal(data["verdict"], "valid");
  const closure = data["closure"] as { missing_roles: string[]; rejected_extra_hashes: string[] };
  assert.deepEqual(closure.missing_roles, [], "the derived closure is complete");
  assert.deepEqual(
    closure.rejected_extra_hashes,
    [],
    "every retained artifact is accounted for by the run record",
  );
});

test("UNSUPPORTED-RETENTION: an unsupported verification finalizes as valid and stays unsupported", () => {
  const { runRoot, steps } = runToValidTerminal("unsupported");
  const finalize = steps["finalize-generic"]?.body.data as Record<string, unknown>;
  assert.equal(finalize["validity_status"], "valid", "unsupported is never Lab invalidity");

  // The retained finding is a subject *unsupported* result, and it scores on no
  // plane: unsupported is retained, not a defect (ERL2-FR-005, ERL2-AC-005).
  const findings = readdirSync(path.join(runRoot, "retained")).filter(
    (n) => n.startsWith("finding-") && n.endsWith(".json"),
  );
  assert.equal(findings.length, 1, "exactly one finding was retained");
  const finding = JSON.parse(
    readFileSync(path.join(runRoot, "retained", findings[0] as string), "utf8"),
  ) as { kind: string; owner: string; category: string; scoreable_planes: string[] };
  assert.equal(finding.kind, "subject_finding");
  assert.equal(finding.owner, "subject");
  assert.equal(finding.category, "subject_unsupported");
  assert.deepEqual(finding.scoreable_planes, []);

  const verify = erl2([
    "verify",
    "--public-bundle", path.join(runRoot, "retained", "public-bundle.json"),
    "--root-config", writeTrustConfig(runRoot),
    "--artifact-root", runRoot,
    "--lifecycle", writeLifecycle(runRoot),
    "--offline",
  ]);
  assert.equal(verify.exitCode, 0, JSON.stringify(verify.body.errors));
  assert.equal((verify.body.data as Record<string, unknown>)["verdict"], "valid");
});

test("RESULT-JOIN: cleanup cannot start before the journey and domain results join", () => {
  const registry = buildGovernorRegistry();
  const runRoot = mkdtempSync(path.join(tmpdir(), "erl2-slice6-nojoin-"));
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
  const runId = prereg.body.run_id as string;
  for (const argv of [
    ["acquire", ...common(registry, runRoot, runId)],
    ["freeze-package", ...common(registry, runRoot, runId)],
    [
      "verify-package",
      ...common(registry, runRoot, runId),
      "--fake-verify-package", "failed",
      "--subject-id", "reference-subject",
      "--subject-version", "0.1.0",
    ],
    ["freeze-output", ...common(registry, runRoot, runId), "--terminal-stage", "verify_package"],
  ]) {
    assert.equal(erl2(argv).exitCode, 0);
  }

  // Finalization is attempted with no `evaluate` in between: the join does not
  // exist, so the sole cleanup-entry guard is missing.
  const finalize = erl2([
    "finalize-generic",
    ...common(registry, runRoot, runId),
    "--claim-scope", "T1",
  ]);
  assert.notEqual(finalize.exitCode, 0, "finalization without a result join must refuse");
  assert.equal(
    finalize.body.errors[0]?.code,
    "GRAPH_CLOSURE_MISSING_ROLE",
    JSON.stringify(finalize.body.errors),
  );
});

test("REVEAL-ORDER: no judge expectation opens before the subject output freezes", () => {
  const registry = buildGovernorRegistry();
  const runRoot = mkdtempSync(path.join(tmpdir(), "erl2-slice6-reveal-"));
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
  const runId = prereg.body.run_id as string;
  assert.equal(erl2(["acquire", ...common(registry, runRoot, runId)]).exitCode, 0);

  const early = erl2(["reveal", ...common(registry, runRoot, runId), "--vault", registry.vaultRoot]);
  assert.notEqual(early.exitCode, 0);
  assert.equal(early.body.errors[0]?.code, "REVEAL_BEFORE_OUTPUT_FREEZE");
});
