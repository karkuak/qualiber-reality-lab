#!/usr/bin/env node
/**
 * Produces the Slice 2 CLI/verifier evidence for `fixtures/golden/`.
 *
 * Nothing here is a development shortcut in the release CLI: the harness builds
 * the runs through `@erl2/core`, then the *real* `erl2` binary verifies them
 * offline in a fresh process, exactly as an external consumer would.
 *
 * Every mode generates into a task-owned staging root and publishes nothing
 * except on `--update` (into `fixtures/golden`) or `--out <dir>` (into an empty
 * or absent named directory). See the staging block below for why the staging
 * root's path *length* is load-bearing.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doctorTranscriptFailures, doctorTranscriptSummary } from "./lib/doctorTranscriptGate.mjs";
import { createStagingRoot } from "./lib/evidenceStaging.mjs";

/**
 * A deterministic byte stream for evidence builds (6R-D): seeds the governor's
 * hiding-commitment ciphertexts and canary tokens so the CLI-driven runs'
 * commitment hashes are byte-reproducible. Each label gets its own independent
 * stream. Never used outside evidence generation.
 */
function seededRandom(label) {
  let counter = 0;
  return (n) => {
    const out = Buffer.alloc(n);
    let written = 0;
    while (written < n) {
      const block = createHash("sha256").update(`erl2-evidence-seed:${label}:${counter}`, "utf8").digest();
      counter += 1;
      const take = Math.min(block.length, n - written);
      block.copy(out, written, 0, take);
      written += take;
    }
    return out;
  };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Staging: every mode generates the same way, into the same shape of path.
// ---------------------------------------------------------------------------
//
// Deterministic evidence (P2-10, plan §19.3): routine generation NEVER mutates
// the approved goldens.  Only the explicit `--update` (evidence:update) rewrites
// `fixtures/golden`, and it does so by *publishing* an already-generated,
// already-validated staging tree.  A fixed evidence clock and fixed run ids
// anchor every run so the artifacts are reproducible (the hiding-commitment
// salts in the test governor and the real-adapter subprocess remain
// nondeterministic — see the remediation ledger).
//
// The staging root itself — one fixed repo-relative parent, one fixed prefix,
// `mkdtemp`'s fixed-length suffix — and its cleanup live in
// `scripts/lib/evidenceStaging.mjs`, where the paths' equal-length property and
// the cleanup after a throw, an early exit and an interrupt are driven by tests
// rather than asserted by reading this file.

const outFlagIndex = process.argv.indexOf("--out");
const outFlagValue = outFlagIndex >= 0 ? process.argv[outFlagIndex + 1] : undefined;
if (outFlagIndex >= 0 && (outFlagValue === undefined || outFlagValue.startsWith("--"))) {
  console.error("--out requires a directory path");
  process.exit(2);
}

/**
 * What happens to the staged tree once it is generated and validated.
 *
 *   `update`    — replace `fixtures/golden` with it (evidence:update).
 *   `verify`    — byte-compare it against `fixtures/golden`; publish nothing.
 *   `out`       — copy it into the named `--out <dir>`; publish nothing else.
 *   `throwaway` — generate, validate, report, discard. The default.
 *
 * In every mode the staging root itself is removed on the way out, success or
 * failure.
 */
const mode = process.argv.includes("--update")
  ? "update"
  : process.argv.includes("--verify")
    ? "verify"
    : outFlagValue !== undefined
      ? "out"
      : "throwaway";
const pinnedRoot = path.join(root, "fixtures", "golden");
const publishTarget =
  mode === "update" ? pinnedRoot : mode === "out" ? path.resolve(outFlagValue) : undefined;

// `--out` never overwrites a directory this script did not create: an evidence
// tree is dropped into a fresh or empty directory, or not at all.
if (mode === "out" && existsSync(publishTarget) && readdirSync(publishTarget).length > 0) {
  console.error(`--out ${publishTarget} already exists and is not empty; refusing to overwrite it`);
  process.exit(2);
}

// `stagingRoot` is what may be published; `workRoot` is where runs that must not
// be published execute. Both are this generation's alone, both are exactly
// `STAGING_ROOT_TARGET_BYTES` bytes long wherever the repository is checked out,
// and both are released together.
const { stagingRoot, workRoot } = createStagingRoot(root);

process.env.ERL2_EVIDENCE_CLOCK = "2026-07-01T00:00:00Z";
// The evidence runs drive the development fake subject port with scripted
// outcomes, so they opt into the explicit development profile that gates the
// `--fake-*` scripting flags (§11.8). The release surface refuses them.
process.env.ERL2_DEVELOPMENT_FAKE_SUBJECT = "1";

/** Deterministic UUIDv7 run ids for the CLI-driven evidence runs. */
let runIdCounter = 0;
function fixedRunId() {
  runIdCounter += 1;
  const suffix = String(runIdCounter).padStart(12, "0");
  return `00000000-0000-7000-8000-${suffix}`;
}

const { runFakeValidPreEnvironmentRun, runFakeInvalidRun, runFakeEnvironmentEmergencyCleanupRun } = await import(
  path.join(root, "tests", "dist", "support", "fakeRun.js")
);

const cli = path.join(root, "packages", "cli", "dist", "src", "bin.js");

function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  return {
    argv: ["erl2", ...args],
    exit_code: result.status,
    stdout: result.stdout ? JSON.parse(result.stdout) : null,
    stderr: result.stderr.slice(0, 2048),
  };
}

function materialize(name, run, extra = {}) {
  const dir = path.join(stagingRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(run.root, path.join(dir, "artifacts"), { recursive: true });
  writeFileSync(
    path.join(dir, "lifecycle.json"),
    `${JSON.stringify(run.lifecycle, null, 2)}\n`,
  );
  writeFileSync(
    path.join(dir, "root-config.json"),
    `${JSON.stringify(run.localTrust, null, 2)}\n`,
  );
  for (const [file, value] of Object.entries(extra)) {
    writeFileSync(path.join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
  }
  return dir;
}

const transcript = [];

// --- doctor ---------------------------------------------------------------
transcript.push(runCli(["doctor", "--profile", "local-developer"]));

// --- valid pre-environment terminal ---------------------------------------
const valid = runFakeValidPreEnvironmentRun();
const validDir = materialize("valid-pre-environment-run", valid, {
  "public-bundle.json": valid.bundle,
});
transcript.push(
  runCli([
    "status",
    "--run",
    valid.runId,
    "--artifact-root",
    path.join(validDir, "artifacts"),
  ]),
);
transcript.push(
  runCli([
    "verify",
    "--public-bundle",
    path.join(validDir, "public-bundle.json"),
    "--root-config",
    path.join(validDir, "root-config.json"),
    "--artifact-root",
    path.join(validDir, "artifacts"),
    "--lifecycle",
    path.join(validDir, "lifecycle.json"),
    "--offline",
  ]),
);
// Negative: verification without --offline is a usage refusal.
transcript.push(
  runCli([
    "verify",
    "--public-bundle",
    path.join(validDir, "public-bundle.json"),
    "--root-config",
    path.join(validDir, "root-config.json"),
    "--artifact-root",
    path.join(validDir, "artifacts"),
    "--lifecycle",
    path.join(validDir, "lifecycle.json"),
  ]),
);

// --- invalid terminals -----------------------------------------------------
for (const scenario of ["cancellation", "classified_lab_failure"]) {
  const run = runFakeInvalidRun(scenario);
  const dir = materialize(`invalid-run-${scenario.replaceAll("_", "-")}`, run, {
    "invalid-record.json": run.invalidRecord,
  });
  transcript.push(
    runCli([
      "verify-record",
      "--record",
      path.join(dir, "invalid-record.json"),
      "--lifecycle",
      path.join(dir, "lifecycle.json"),
      "--artifact-root",
      path.join(dir, "artifacts"),
      "--root-config",
      path.join(dir, "root-config.json"),
      "--offline",
    ]),
  );
}

// --- environment teardown/restoration failure -> emergency cleanup --------
{
  const run = runFakeEnvironmentEmergencyCleanupRun();
  const dir = materialize("invalid-run-emergency-cleanup", run, {
    "invalid-record.json": run.invalidRecord,
  });
  transcript.push(
    runCli([
      "verify-record",
      "--record",
      path.join(dir, "invalid-record.json"),
      "--lifecycle",
      path.join(dir, "lifecycle.json"),
      "--artifact-root",
      path.join(dir, "artifacts"),
      "--root-config",
      path.join(dir, "root-config.json"),
      "--offline",
    ]),
  );
}

// Negative: verify-record refuses a public bundle.
transcript.push(
  runCli([
    "verify-record",
    "--record",
    path.join(validDir, "public-bundle.json"),
    "--lifecycle",
    path.join(validDir, "lifecycle.json"),
    "--artifact-root",
    path.join(validDir, "artifacts"),
    "--root-config",
    path.join(validDir, "root-config.json"),
    "--offline",
  ]),
);

// --- slice 4: the CLI journey from acquisition to frozen subject output ----
{
  const { buildGovernorRegistry } = await import(
    path.join(root, "tests", "dist", "support", "governorRegistry.js")
  );
  const registry = buildGovernorRegistry({ random: seededRandom("journey") });
  const journeyDir = path.join(stagingRoot, "journey-acquisition-to-frozen-output");
  rmSync(journeyDir, { recursive: true, force: true });
  mkdirSync(journeyDir, { recursive: true });
  const runRoot = path.join(journeyDir, "run");
  mkdirSync(runRoot, { recursive: true });
  const journeyRunId = fixedRunId();
  const common = ["--run-root", runRoot, "--registry", registry.root, "--tier", "development"];

  const prereg = runCli([
    "preregister-acquisition",
    ...common,
    "--run", journeyRunId,
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
  transcript.push(prereg);
  const withRun = [...common, "--run", journeyRunId];
  transcript.push(runCli(["acquire", ...withRun]));
  transcript.push(runCli(["freeze-package", ...withRun]));
  // A *failed* package verification is the only route to a pre-environment
  // terminal (ADR-ERL2-013); a successful one continues to challenge
  // preregistration, which the negative invocation below records.
  transcript.push(
    runCli([
      "verify-package",
      ...withRun,
      "--subject-id", "fake-subject",
      "--subject-version", "0.1.0",
      "--fake-verify-package", "failed",
    ]),
  );
  transcript.push(runCli(["freeze-output", ...withRun, "--terminal-stage", "verify_package"]));

  // Negative: a successful package manifest may not finalize early.
  const successRoot = path.join(journeyDir, "verified-package-continues");
  mkdirSync(successRoot, { recursive: true });
  const successCommon = ["--run-root", successRoot, "--registry", registry.root, "--tier", "development"];
  const successRunId = fixedRunId();
  const successPrereg = runCli([
    "preregister-acquisition",
    ...successCommon,
    "--run", successRunId,
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
  transcript.push(successPrereg);
  const successRun = [...successCommon, "--run", successRunId];
  transcript.push(runCli(["acquire", ...successRun]));
  transcript.push(runCli(["freeze-package", ...successRun]));
  transcript.push(
    runCli(["verify-package", ...successRun, "--subject-id", "fake-subject", "--subject-version", "0.1.0"]),
  );
  transcript.push(runCli(["freeze-output", ...successRun, "--terminal-stage", "verify_package"]));

  // Negative: a failed acquisition freezes exactly one invalid record.
  const failedRoot = path.join(journeyDir, "failed-acquisition");
  mkdirSync(failedRoot, { recursive: true });
  const failedCommon = ["--run-root", failedRoot, "--registry", registry.root, "--tier", "development"];
  const failedRunId = fixedRunId();
  const failedPrereg = runCli([
    "preregister-acquisition",
    ...failedCommon,
    "--run", failedRunId,
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
  transcript.push(failedPrereg);
  transcript.push(
    runCli(["acquire", ...failedCommon, "--run", failedRunId, "--fake-acquire", "failed"]),
  );

  // Negative: a held-out tier is refused before anything is created.
  transcript.push(
    runCli([
      "preregister-acquisition",
      "--run-root", path.join(journeyDir, "held-out-refused"),
      "--registry", registry.root,
      "--tier", "held_out",
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
    ]),
  );
}

// --- slice 5: the adapter platform ----------------------------------------
{
  const { buildGovernorRegistry } = await import(
    path.join(root, "tests", "dist", "support", "governorRegistry.js")
  );
  const {
    referenceAdapterEntry,
    sabotageAdapterEntry,
    REFERENCE_CORRECT_MANIFEST,
    REFERENCE_LIMITED_MANIFEST,
  } = await import(path.join(root, "tests", "dist", "support", "adapterFixtures.js"));
  const { certifyAdapter, SteppingClock } = await import(
    path.join(root, "packages", "core", "dist", "src", "index.js")
  );

  const adapterDir = path.join(stagingRoot, "adapter-platform");
  rmSync(adapterDir, { recursive: true, force: true });
  mkdirSync(adapterDir, { recursive: true });

  // --- certification receipts for both reference adapters ------------------
  const receipts = {};
  for (const [id, manifest] of [
    ["reference-correct", REFERENCE_CORRECT_MANIFEST()],
    ["reference-limited", REFERENCE_LIMITED_MANIFEST()],
  ]) {
    receipts[id] = certifyAdapter({
      adapterManifest: manifest,
      adapterEntryPath: referenceAdapterEntry(id),
      clock: new SteppingClock("2026-07-01T00:00:00Z", 1000),
      certifierId: "erl2-certifier",
    });
  }
  // …and for a hostile adapter, which the same suite refuses.
  receipts["sabotage-protocol-mismatch"] = certifyAdapter({
    adapterManifest: REFERENCE_CORRECT_MANIFEST(),
    adapterEntryPath: sabotageAdapterEntry("protocol-mismatch"),
    clock: new SteppingClock("2026-07-01T00:00:00Z", 1000),
    certifierId: "erl2-certifier",
  });
  writeFileSync(
    path.join(adapterDir, "certification-receipts.json"),
    `${JSON.stringify(receipts, null, 2)}\n`,
  );

  // --- the journey, driven by each reference adapter through the real host --
  // The timeout fixture is admitted with a certified receipt over its own real
  // bytes, so the hostile run stays a *runtime* refusal — the deadline and the
  // process-tree kill — rather than collapsing into an admission refusal that
  // would prove something else (ADR-ERL2-036).
  const registry = buildGovernorRegistry({
    random: seededRandom("adapter-platform"),
    certifiedSabotageAdapters: [{ name: "timeout", adapterId: "sabotage-timeout" }],
  });
  const journeys = [
    [
      "reference-correct",
      registry.referenceCorrectAdapterHash,
      registry.referenceCorrectCertificationHash,
      "verify_package",
    ],
    [
      "reference-limited",
      registry.referenceLimitedAdapterHash,
      registry.referenceLimitedCertificationHash,
      "verify_package",
    ],
  ];
  for (const [id, adapterHash, certificationHash] of journeys) {
    const runRoot = path.join(adapterDir, id, "run");
    mkdirSync(runRoot, { recursive: true });
    const base = [
      "--run-root", runRoot,
      "--registry", registry.root,
      "--tier", "development",
      "--adapter-entry", referenceAdapterEntry(id),
    ];
    const adapterRunId = fixedRunId();
    const prereg = runCli([
      "preregister-acquisition",
      ...base,
      "--run", adapterRunId,
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
    transcript.push(prereg);
    const withRun = [...base, "--run", adapterRunId];
    transcript.push(runCli(["acquire", ...withRun]));
    transcript.push(runCli(["freeze-package", ...withRun]));
    transcript.push(
      runCli(["verify-package", ...withRun, "--subject-id", id, "--subject-version", "0.1.0"]),
    );
    // The correct adapter verifies and must continue to selection; the limited
    // one honestly reports unsupported and reaches the pre-environment terminal.
    transcript.push(runCli(["freeze-output", ...withRun, "--terminal-stage", "verify_package"]));
  }

  // --- a hostile adapter yields a typed adapter refusal ---------------------
  {
    const runRoot = path.join(adapterDir, "hostile-adapter", "run");
    mkdirSync(runRoot, { recursive: true });
    const base = [
      "--run-root", runRoot,
      "--registry", registry.root,
      "--tier", "development",
      "--adapter-entry", sabotageAdapterEntry("timeout"),
    ];
    const hostileRunId = fixedRunId();
    const prereg = runCli([
      "preregister-acquisition",
      ...base,
      "--run", hostileRunId,
      "--acquisition-source", registry.sourceManifestHash,
      "--adapter", registry.sabotageAdapterHashes["timeout"].manifestHash,
      "--adapter-certification", registry.sabotageAdapterHashes["timeout"].certificationHash,
      "--acquisition-actor-script", registry.acquisitionActorScriptHash,
      "--acquisition-actor-schema", registry.acquisitionActorSchemaHash,
      "--acquisition-step", registry.acquisitionStep.commitmentHash,
      "--package-verification-step", registry.packageVerificationStep.commitmentHash,
      "--generic-policy", registry.genericRunPolicyHash,
      "--trust-policy", registry.runTrustPolicyHash,
      "--limits", registry.limitsHash,
      "--expires", "2026-12-31T00:00:00Z",
    ]);
    transcript.push(prereg);
    transcript.push(runCli(["acquire", ...base, "--run", hostileRunId]));

    // The run id was durably accepted, so the timeout freezes exactly one
    // invalid record — and that record verifies offline in a fresh process.
    const { developmentKeyring, developmentTrustPolicy, localTrustConfiguration } = await import(
      path.join(root, "tests", "dist", "support", "keys.js")
    );
    const keyring = developmentKeyring();
    const events = readdirSync(path.join(runRoot, "events"))
      .filter((n) => n.endsWith(".json"))
      .sort()
      .map((n) => JSON.parse(readFileSync(path.join(runRoot, "events", n), "utf8")));
    writeFileSync(path.join(runRoot, "..", "lifecycle.json"), `${JSON.stringify(events, null, 2)}\n`);
    writeFileSync(
      path.join(runRoot, "..", "root-config.json"),
      `${JSON.stringify(
        localTrustConfiguration(developmentTrustPolicy(keyring), keyring, [], `sha256:${"0".repeat(64)}`),
        null,
        2,
      )}\n`,
    );
    transcript.push(
      runCli([
        "verify-record",
        "--record", path.join(runRoot, "retained", "invalid-run-record.json"),
        "--lifecycle", path.join(runRoot, "..", "lifecycle.json"),
        "--artifact-root", runRoot,
        "--root-config", path.join(runRoot, "..", "root-config.json"),
        "--offline",
      ]),
    );
  }
}

// --- slice 6: a real valid pre-environment terminal, end to end -------------
//
// Unlike the fixture runs above, every artifact here is produced by the shipped
// commands. The bundle is then verified offline in a fresh process, and a
// second run proves the refusal when the result join is skipped.
{
  const { buildGovernorRegistry } = await import(
    path.join(root, "tests", "dist", "support", "governorRegistry.js")
  );
  const { developmentKeyring } = await import(path.join(root, "tests", "dist", "support", "keys.js"));
  const { coreHash } = await import(path.join(root, "packages", "integrity", "dist", "src", "index.js"));
  const { statSync } = await import("node:fs");

  const collectLifecycle = (runRoot) => {
    const events = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir).sort()) {
        const child = path.join(dir, name);
        if (statSync(child).isDirectory()) {
          walk(child);
          continue;
        }
        if (!name.endsWith(".json") || name.endsWith(".frozen")) continue;
        const value = JSON.parse(readFileSync(child, "utf8"));
        if (value.schema_version === "lab-lifecycle-event/v1") events.push(value);
      }
    };
    walk(runRoot);
    events.sort((a, b) => a.sequence - b.sequence);
    const streamPath = path.join(runRoot, "lifecycle.json");
    writeFileSync(streamPath, `${JSON.stringify(events, null, 2)}\n`);
    return streamPath;
  };

  for (const [label, verifyStatus, skipEvaluate] of [
    ["generic-finalization-failed-verification", "failed", false],
    ["generic-finalization-unsupported-verification", "unsupported", false],
    ["generic-finalization-missing-result-join", "failed", true],
  ]) {
    const registry = buildGovernorRegistry({ random: seededRandom(`generic-finalization:${label}`) });
    // This generation's own working directory, never a shared one. It used to be
    // `<repoRoot>/.erl2-work/evidence/<label>`, deleted on entry — so two
    // concurrent generations deleted each other's execution state mid-run. The
    // work root is unique per process and constant in absolute byte length, so
    // the reproducibility the fixed path was chosen for survives the isolation.
    const runRoot = path.join(workRoot, "generic-finalization", label);
    mkdirSync(runRoot, { recursive: true });
    const base = [
      "--run-root", runRoot,
      "--registry", registry.root,
      "--tier", "development",
    ];
    const genericRunId = fixedRunId();
    const prereg = runCli([
      "preregister-acquisition", ...base,
      "--run", genericRunId,
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
    transcript.push(prereg);
    const runId = genericRunId;
    const run = [...base, "--run", runId];

    transcript.push(runCli(["acquire", ...run]));
    transcript.push(runCli(["freeze-package", ...run]));
    transcript.push(
      runCli([
        "verify-package", ...run,
        "--fake-verify-package", verifyStatus,
        "--subject-id", "reference-subject",
        "--subject-version", "0.1.0",
      ]),
    );
    transcript.push(runCli(["freeze-output", ...run, "--terminal-stage", "verify_package"]));
    transcript.push(runCli(["reveal", ...run, "--vault", registry.vaultRoot]));
    if (!skipEvaluate) transcript.push(runCli(["evaluate", ...run]));
    transcript.push(runCli(["finalize-generic", ...run, "--claim-scope", "T1"]));

    if (skipEvaluate) continue;

    const policy = JSON.parse(readFileSync(path.join(runRoot, "retained", "trust-policy.json"), "utf8"));
    const trustConfig = path.join(runRoot, "root-config.json");
    writeFileSync(
      trustConfig,
      `${JSON.stringify(
        {
          rootKeyIds: [developmentKeyring().root.keyId],
          currentTrustHeadHash: coreHash(policy),
          randomnessSources: [],
          randomnessRegistryHeadHash: `sha256:${"0".repeat(64)}`,
        },
        null,
        2,
      )}\n`,
    );
    transcript.push(
      runCli([
        "verify",
        "--public-bundle", path.join(runRoot, "retained", "public-bundle.json"),
        "--root-config", trustConfig,
        "--artifact-root", runRoot,
        "--lifecycle", collectLifecycle(runRoot),
        "--offline",
      ]),
    );
    // The same bundle is refused by verify-record: a bundle is not a record.
    transcript.push(
      runCli([
        "verify-record",
        "--record", path.join(runRoot, "retained", "public-bundle.json"),
        "--lifecycle", path.join(runRoot, "lifecycle.json"),
        "--artifact-root", runRoot,
        "--root-config", trustConfig,
        "--offline",
      ]),
    );

    const dir = path.join(stagingRoot, label);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cpSync(runRoot, path.join(dir, "artifacts"), { recursive: true });
  }
}

// --- slice 6.5: a real valid ENVIRONMENT terminal, end to end ---------------
//
// The canonical evidence for the milestone: `case_selected` through
// `generic_finalized` and then offline verification, every artifact produced by
// the shipped commands in separate processes. Nothing here is hand-assembled.
//
// ## Why this run is not byte-pinned, and what is pinned instead
//
// It cannot be. An environment run contains a selection chain, and every pool
// entry is a threshold envelope whose content key, nonce and X25519 ephemerals
// come from the CSPRNG inside `sealThresholdEnvelope`. Making *those* derivable
// is the one affordance that would let an observer reconstruct a sealed entry, so
// the trade is refused: the envelope keeps its CSPRNG and the run keeps its
// irreducible nondeterminism. `ERL2_EVIDENCE_RANDOM` seeds the pool's opening
// nonces and handles (so entry identities are stable) but deliberately stops at
// the envelope boundary.
//
// What is pinned is the part that *is* deterministic and is what a reviewer
// actually needs to see hold: the ordered lifecycle event types, the closure's
// required roles and their multiplicities, the derived terminal variant and
// stage, and the verifier's verdict. A regression that dropped a role, added an
// unaccounted artifact, reordered the walk or changed the verdict fails the pin;
// a fresh CSPRNG draw does not.
{
  const { buildGovernorRegistry } = await import(
    path.join(root, "tests", "dist", "support", "governorRegistry.js")
  );
  const { developmentKeyring } = await import(path.join(root, "tests", "dist", "support", "keys.js"));
  const { coreHash } = await import(path.join(root, "packages", "integrity", "dist", "src", "index.js"));
  const { DevelopmentBeaconSource } = await import(
    path.join(root, "packages", "core", "dist", "src", "index.js")
  );
  const { statSync } = await import("node:fs");

  process.env.ERL2_EVIDENCE_RANDOM = "erl2-evidence-selection";
  const registry = buildGovernorRegistry({ random: seededRandom("environment") });

  // The run itself is built OUTSIDE the golden tree, because its bytes cannot be
  // pinned. Only the deterministic summary below lands in `fixtures/golden`.
  //
  // In this generation's work root rather than a fresh `os.tmpdir()` directory:
  // that one was never removed by anything, so every generation since the harness
  // was written left one behind. This one is released with the staging root.
  const envDir = path.join(workRoot, "environment-run");
  mkdirSync(envDir, { recursive: true });
  const goldenEnvDir = path.join(stagingRoot, "environment-run");
  rmSync(goldenEnvDir, { recursive: true, force: true });
  mkdirSync(goldenEnvDir, { recursive: true });
  const runRoot = path.join(envDir, "run");
  mkdirSync(runRoot, { recursive: true });
  const runId = fixedRunId();
  const common = ["--run-root", runRoot, "--registry", registry.root, "--tier", "development"];
  const withRun = [...common, "--run", runId];

  // The substrate and the global allocator live *outside* the run root, because
  // the artifact index scans the whole run root and substrate state inside it
  // would be indexed as evidence. They are therefore not part of the golden.
  const substrateRoot = path.join(envDir, "substrate");
  const reservationRoot = path.join(envDir, "reservations");
  const scoped = [...withRun, "--substrate-root", substrateRoot, "--reservation-root", reservationRoot];

  const sourceTrust = path.join(envDir, "source-trust.json");
  writeFileSync(
    sourceTrust,
    `${JSON.stringify(
      {
        sourceTrustPolicyHash: registry.sourceTrustPolicyHash,
        randomnessRegistryHeadHash: registry.sourceTrustPolicyHash,
      },
      null,
      2,
    )}\n`,
  );

  const plan = [
    ["preregister-acquisition", [
      "preregister-acquisition", ...withRun,
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
    ]],
    ["acquire", ["acquire", ...withRun]],
    ["freeze-package", ["freeze-package", ...withRun]],
    ["verify-package", ["verify-package", ...withRun, "--subject-id", "fake-subject", "--subject-version", "0.1.0"]],
    ["preregister-challenge", [
      "preregister-challenge", ...withRun,
      "--journey-selection-policy", registry.journeySelectionPolicyHash,
      "--randomness-policy", registry.randomnessPolicyHash,
      ...registry.challengeCandidates.flatMap((c) => ["--challenge", c.challengeManifestHash]),
    ]],
    ["select", ["select", ...withRun, "--source-trust-config", sourceTrust, "--expires", "2026-12-31T00:00:00Z"]],
    ["provision", ["provision", ...scoped, "--archetype", registry.archetypeHash]],
    ["baseline", ["baseline", ...scoped]],
    ["plan", ["plan", ...scoped]],
    ["install", ["install", ...scoped]],
    ["configure", ["configure", ...scoped]],
    ["authenticate", ["authenticate", ...scoped]],
    ["connect", ["connect", ...scoped]],
    ["execute-subject", ["execute-subject", ...scoped]],
    ["activate", ["activate", ...scoped]],
    ["journey", [
      "journey", ...scoped,
      "--comparison-policy", registry.comparisonPolicyHash,
      "--cutoff-policy", registry.cutoffPolicyHash,
    ]],
    ["observe", ["observe", ...scoped]],
    ["freeze-observation", ["freeze-observation", ...scoped]],
    ["execute-subject", ["execute-subject", ...scoped]],
    ["execute-subject", ["execute-subject", ...scoped]],
    ["remove", ["remove", ...scoped]],
    ["freeze-output", ["freeze-output", ...scoped]],
    ["reveal", ["reveal", ...scoped, "--vault", registry.vaultRoot]],
    ["evaluate", ["evaluate", ...scoped]],
    ["restore", ["restore", ...scoped]],
    ["destroy", ["destroy", ...scoped]],
    ["finalize-generic", ["finalize-generic", ...scoped, "--claim-scope", "T1"]],
  ];
  for (const [name, argv] of plan) {
    const result = runCli(argv);
    transcript.push(result);
    if (result.exit_code !== 0) {
      throw new Error(
        `environment evidence run failed at ${name}: ${JSON.stringify(result.stdout?.errors ?? result.stderr)}`,
      );
    }
  }

  // The lifecycle stream an external verifier is handed.
  const events = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const child = path.join(dir, name);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!name.endsWith(".json") || name.endsWith(".frozen")) continue;
      const value = JSON.parse(readFileSync(child, "utf8"));
      if (value.schema_version === "lab-lifecycle-event/v1") events.push(value);
    }
  };
  walk(runRoot);
  events.sort((a, b) => a.sequence - b.sequence);
  writeFileSync(path.join(envDir, "lifecycle.json"), `${JSON.stringify(events, null, 2)}\n`);

  // The verifier's own locally pinned configuration. An environment bundle
  // carries a selection verification receipt as a mandatory member, so unlike the
  // pre-environment configs this one must pin the beacon's registry entry.
  const policy = JSON.parse(readFileSync(path.join(runRoot, "retained", "trust-policy.json"), "utf8"));
  const rootConfig = {
    rootKeyIds: [developmentKeyring().root.keyId],
    currentTrustHeadHash: coreHash(policy),
    randomnessSources: [
      new DevelopmentBeaconSource({
        seed: "erl2-evidence-pin",
        firstRoundAt: "2026-07-01T00:00:00Z",
      }).pinnedRegistryEntry(registry.sourceTrustPolicyHash),
    ],
    randomnessRegistryHeadHash: registry.sourceTrustPolicyHash,
  };
  writeFileSync(path.join(envDir, "root-config.json"), `${JSON.stringify(rootConfig, null, 2)}\n`);

  // Offline verification, in a fresh process, exactly as an external consumer
  // would run it — and the negative that proves the beacon pin is load-bearing.
  const verified = runCli([
    "verify",
    "--public-bundle", path.join(runRoot, "retained", "public-bundle.json"),
    "--root-config", path.join(envDir, "root-config.json"),
    "--artifact-root", runRoot,
    "--lifecycle", path.join(envDir, "lifecycle.json"),
    "--offline",
  ]);
  transcript.push(verified);
  const unpinned = path.join(envDir, "root-config-unpinned.json");
  writeFileSync(
    unpinned,
    `${JSON.stringify({ ...rootConfig, randomnessSources: [] }, null, 2)}\n`,
  );
  const refused = runCli([
    "verify",
    "--public-bundle", path.join(runRoot, "retained", "public-bundle.json"),
    "--root-config", unpinned,
    "--artifact-root", runRoot,
    "--lifecycle", path.join(envDir, "lifecycle.json"),
    "--offline",
  ]);
  transcript.push(refused);

  if (verified.exit_code !== 0) {
    throw new Error(`environment bundle did not verify: ${JSON.stringify(verified.stdout?.errors)}`);
  }

  // The deterministic summary: hash-free by construction, so it pins the shape of
  // the milestone rather than one CSPRNG draw of it.
  const closure = verified.stdout.data.closure;
  const roleCounts = closure.required_hashes_by_role.map((r) => ({
    role: r.role,
    count: r.ordered_hashes.length,
  }));
  const summary = {
    what: "erl2 environment terminal, produced by the shipped CLI and verified offline",
    pinned: "shape only — see the generator comment for why the bytes cannot be",
    verdict: verified.stdout.data.verdict,
    derived_terminal_variant: closure.derived_terminal_variant,
    derived_terminal_phase: closure.derived_terminal_phase,
    missing_roles: closure.missing_roles,
    rejected_extra_count: closure.rejected_extra_hashes.length,
    required_roles: roleCounts,
    lifecycle_event_types: events.map((e) => e.event_type),
    lifecycle_states: events.map((e) => e.state_to),
    produced_roles: events.flatMap((e) => (e.produced ?? []).map((x) => x.artifact_role)),
    offline_verification: {
      with_pinned_beacon: { exit_code: verified.exit_code, code: null },
      without_pinned_beacon: {
        exit_code: refused.exit_code,
        code: refused.stdout?.errors?.[0]?.code ?? null,
      },
    },
  };
  writeFileSync(
    path.join(goldenEnvDir, "closure-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  delete process.env.ERL2_EVIDENCE_RANDOM;
}

// Negative: a command from an unshipped slice refuses rather than no-ops.
transcript.push(runCli(["select", "--request", "x"]));

writeFileSync(
  path.join(stagingRoot, "cli-transcript.json"),
  `${JSON.stringify(transcript, null, 2)}\n`,
);

const failures = transcript.filter((t) => t.exit_code !== 0);
console.log(
  `wrote ${stagingRoot} (${String(transcript.length)} CLI invocations, ${String(failures.length)} expected refusals)`,
);
for (const t of transcript) {
  const code = t.stdout?.errors?.[0]?.code ?? "-";
  console.log(`  exit ${String(t.exit_code)}  ${t.argv.slice(0, 2).join(" ")}  ${code}`);
}

// ---------------------------------------------------------------------------
// The doctor transcript semantic gate (see scripts/lib/doctorTranscriptGate.mjs).
// ---------------------------------------------------------------------------
//
// `cli-transcript.json` is one of the seven files the byte-pin cannot cover, and
// an excluded file is an uncovered file — the committed transcript went on
// carrying a pre-OQ-005 doctor report with no `compose_substrate` block at all
// and nothing noticed. So it is gated semantically instead, on every generation,
// against the transcript this process just wrote. The decision lives in a pure
// module so every branch of it is driven by a test rather than only by a run.
{
  const failures = doctorTranscriptFailures(transcript);
  if (failures.length > 0) {
    console.error("\ndoctor transcript gate FAILED:");
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      "\n`cli-transcript.json` is excluded from the byte-pin, so its correctness is this\n" +
        "gate's job and nothing else's. If the doctor report legitimately changed shape,\n" +
        "update scripts/lib/doctorTranscriptGate.mjs in the same commit and say why in the review.",
    );
    process.exit(1);
  }
  console.log(`\ndoctor transcript gate OK — ${doctorTranscriptSummary(transcript)}`);
}

// ---------------------------------------------------------------------------
// evidence:verify — a deterministic byte-pin (6R-D, plan §9.1).
// ---------------------------------------------------------------------------
//
// `--verify` byte-compares the freshly, deterministically generated evidence in
// `stagingRoot` against the committed pinned goldens under `fixtures/golden`,
// WITHOUT mutating them.
//
// Exclusions are per-FILE, never per-subtree, and are LOGGED (never silently
// dropped). Generating twice into two directories and diffing shows exactly
// seven files that cannot be byte-stable; every other file — including the whole
// rest of the real out-of-process `adapter-platform/` evidence — is pinned:
//
//   - `**/request.frames` — the adapter host bakes the absolute
//     adapter-workspace path into the request frames, so these vary with the
//     staging root's bytes (its *length* is fixed by construction, which is what
//     keeps the retained `request_bytes` counts pinned).
//   - `**/grandchild.pid` — the hostile-adapter fixture writes a REAL OS pid to
//     prove the supervisor tree-kill; a pid varies per process launch.
//   - `cli-transcript.json` — records the absolute `--artifact-root`/path
//     arguments of each CLI invocation, so it is path-dependent by construction.
//     Its correctness is gated semantically instead, above.
//
// Everything else — every fake-run terminal, the journey run, the generic
// finalization runs, invalid records, bundles, lifecycle logs, root configs and
// the real adapter protocol evidence — including every retained
// `sandbox-invocation-result/v1` and every hash downstream of one — is
// byte-identical to the pin or `--verify` fails.
if (mode === "verify") {
  const pinned = pinnedRoot;
  // Per-file exclusions as EXACT root-relative paths — never a basename, never a
  // subtree. A basename rule (`request.frames`) silently unpins every same-named
  // file anywhere in the tree, now and in future; an exact path unpins one file
  // and nothing else.
  const UNPINNABLE = [
    {
      path: "adapter-platform/hostile-adapter/run/adapter-workspace/op-acquire/output/grandchild.pid",
      why: "a real OS pid from the supervisor tree-kill fixture",
    },
    {
      path: "adapter-platform/hostile-adapter/run/adapter-workspace/op-acquire/request.frames",
      why: "absolute adapter-workspace path baked into the frames",
    },
    {
      path: "adapter-platform/reference-correct/run/adapter-workspace/op-acquire/request.frames",
      why: "absolute adapter-workspace path baked into the frames",
    },
    {
      path: "adapter-platform/reference-correct/run/adapter-workspace/op-verify-package/request.frames",
      why: "absolute adapter-workspace path baked into the frames",
    },
    {
      path: "adapter-platform/reference-limited/run/adapter-workspace/op-acquire/request.frames",
      why: "absolute adapter-workspace path baked into the frames",
    },
    {
      path: "adapter-platform/reference-limited/run/adapter-workspace/op-verify-package/request.frames",
      why: "absolute adapter-workspace path baked into the frames",
    },
    { path: "cli-transcript.json", why: "absolute CLI path arguments" },
  ];

  // The exclusion manifest is itself pinned, and so is the resulting coverage.
  //
  // Without this, widening the pin was free: adding one entry named
  // `run-record.json` dropped three files out of the comparison and still
  // printed "evidence:verify OK". Exclusion growth is now a two-place edit —
  // the list and this digest — so it can never happen silently, and it shows up
  // in review as a deliberate change to a security-relevant constant. This is a
  // speed bump backed by code review, NOT a cryptographic authorization.
  const EXCLUSION_MANIFEST_DIGEST =
    "5ac4efcb2a323dcfc93640a8bc7df819dd0126d165a990278b09a9da6da75342";
  // 781 -> 787 under ADR-ERL2-027: the `invalid-run-emergency-cleanup` fixture
  // gains three retained artifacts, each pinned as content plus its `.frozen`
  // marker. `cleanup-residue-probe.json` is the new contract (ERL2-C-158);
  // `substrate-binding.json` and `environment-archetype.json` are the binding
  // ADR-ERL2-024 §10 said these goldens would gain "where they model a run that
  // provisioned", and the archetype it names — neither of which was ever added,
  // so the fixture's cleanup verdicts could be attributed to no substrate at all.
  // The exclusion manifest is unchanged; the pin grew, it did not narrow.
  //
  // 787 -> 832 as the adapter host's own adjudication became retained evidence:
  // the two reference-adapter runs each gained their per-operation response
  // envelope, sandbox invocation manifest and result, capability grant and
  // diagnostics manifest, plus the frozen subject-output and diagnostics trees —
  // each pinned as content and as its `.frozen` marker — while the old
  // `run/diagnostics/**` copies moved beneath `subject-output/` and two
  // content-addressed step-outcome names moved with their hashes. 57 files added,
  // 12 removed. Again: the exclusion manifest is unchanged and the pin grew.
  const EXPECTED_PINNED = 832;
  const EXPECTED_EXCLUDED = 7;

  const manifestDigest = createHash("sha256")
    .update(JSON.stringify(UNPINNABLE.map((u) => [u.path, u.why]).sort()), "utf8")
    .digest("hex");
  if (manifestDigest !== EXCLUSION_MANIFEST_DIGEST) {
    console.error(
      `\nevidence:verify FAILED: the exclusion manifest changed.\n` +
        `  expected digest ${EXCLUSION_MANIFEST_DIGEST}\n` +
        `  actual   digest ${manifestDigest}\n` +
        `Every exclusion removes a file from the byte-pin. If this change is intended,\n` +
        `update EXCLUSION_MANIFEST_DIGEST (and EXPECTED_PINNED/EXPECTED_EXCLUDED) in the\n` +
        `same commit and say why in the review.`,
    );
    process.exit(1);
  }

  const excluded = new Set(UNPINNABLE.map((u) => u.path));
  const norm = (rel) => rel.split(path.sep).join("/");
  const EXCLUDE = (rel) => excluded.has(norm(rel));
  const walk = (base) => {
    const out = [];
    const rec = (dir) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, name.name);
        if (name.isDirectory()) rec(abs);
        else out.push(norm(path.relative(base, abs)));
      }
    };
    rec(base);
    return out;
  };

  // A stale exclusion is as dishonest as an unjustified one: it reads as covered
  // ground while naming a file that no longer exists.
  const allPinned = new Set(walk(pinned));
  const stale = [...excluded].filter((p) => !allPinned.has(p));
  if (stale.length > 0) {
    for (const p of stale) console.error(`  STALE EXCLUSION  ${p} — no such file beneath fixtures/golden`);
    console.error(`\nevidence:verify FAILED: ${String(stale.length)} exclusion(s) match nothing; remove them.`);
    process.exit(1);
  }

  const goldenFiles = new Set(walk(pinned).filter((r) => !EXCLUDE(r)));
  const freshFiles = new Set(walk(stagingRoot).filter((r) => !EXCLUDE(r)));
  const mismatches = [];
  const missing = [];
  const extra = [];
  for (const rel of goldenFiles) {
    if (!freshFiles.has(rel)) {
      missing.push(rel);
      continue;
    }
    const a = readFileSync(path.join(pinned, rel));
    const b = readFileSync(path.join(stagingRoot, rel));
    if (!a.equals(b)) mismatches.push(rel);
  }
  for (const rel of freshFiles) if (!goldenFiles.has(rel)) extra.push(rel);
  const excludedCount = walk(pinned).filter(EXCLUDE).length;
  console.log(`\nevidence:verify — pinned ${String(goldenFiles.size)} files, excluded ${String(excludedCount)}:`);
  for (const u of UNPINNABLE) console.log(`  excluded ${u.path} — ${u.why}`);

  // Coverage is pinned too, so a file cannot quietly leave the comparison by any
  // route — a widened exclusion, a deleted golden, or a renamed subtree.
  if (goldenFiles.size !== EXPECTED_PINNED || excludedCount !== EXPECTED_EXCLUDED) {
    console.error(
      `\nevidence:verify FAILED: byte-pin coverage changed — ` +
        `pinned ${String(goldenFiles.size)} (expected ${String(EXPECTED_PINNED)}), ` +
        `excluded ${String(excludedCount)} (expected ${String(EXPECTED_EXCLUDED)}).\n` +
        `If this change is intended, update EXPECTED_PINNED/EXPECTED_EXCLUDED in the same commit.`,
    );
    process.exit(1);
  }
  if (mismatches.length || missing.length || extra.length) {
    for (const m of mismatches) console.error(`  BYTE MISMATCH  ${m}`);
    for (const m of missing) console.error(`  MISSING IN FRESH  ${m}`);
    for (const m of extra) console.error(`  UNEXPECTED IN FRESH  ${m}`);
    console.error(
      `\nevidence:verify FAILED: ${String(mismatches.length)} mismatch, ` +
        `${String(missing.length)} missing, ${String(extra.length)} unexpected`,
    );
    process.exit(1);
  }
  console.log("evidence:verify OK — deterministic evidence matches the pinned goldens byte-for-byte");

  verifyGoldenFixtures(pinned, "fixtures/golden");
}

// ---------------------------------------------------------------------------
// Publication: the staged tree, validated, then copied.
// ---------------------------------------------------------------------------
//
// Nothing above this line has written outside the staging root, and nothing below
// it generates. `--update` and `--out` validate what was staged and only then
// replace the target with it; every other mode publishes nothing at all. That is
// what makes routine generation non-mutating rather than merely careful.
if (publishTarget !== undefined) {
  verifyGoldenFixtures(stagingRoot, "the staged tree, before publishing");

  // A REPLACEMENT, not a merge: a family the generator stopped producing must
  // disappear from the goldens rather than linger as an orphan nothing regenerates.
  // The removal is visible in `git status` and, for `fixtures/golden`, the very
  // next `evidence:verify` fails its `EXPECTED_PINNED` coverage assertion.
  const before = existsSync(publishTarget) ? walkTree(publishTarget) : [];
  rmSync(publishTarget, { recursive: true, force: true });
  mkdirSync(publishTarget, { recursive: true });
  cpSync(stagingRoot, publishTarget, { recursive: true });
  const after = walkTree(publishTarget);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((r) => !beforeSet.has(r));
  const removed = before.filter((r) => !afterSet.has(r));
  console.log(
    `\npublished the staged tree to ${publishTarget} — ${String(after.length)} file(s), ` +
      `${String(added.length)} added, ${String(removed.length)} removed`,
  );
  for (const r of added) console.log(`  + ${r}`);
  for (const r of removed) console.log(`  - ${r}`);
  if (mode === "update") {
    console.log(
      "\nevidence:update wrote fixtures/golden. Review the diff, then run evidence:verify.",
    );
  }
}

/** Every file beneath `base`, as sorted root-relative `/`-separated paths. */
function walkTree(base) {
  const out = [];
  const rec = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) rec(abs);
      else out.push(path.relative(base, abs).split(path.sep).join("/"));
    }
  };
  rec(base);
  return out.sort();
}

// ---------------------------------------------------------------------------
// The golden-fixture verification gates.
// ---------------------------------------------------------------------------
//
// Run by `--verify` over the committed `fixtures/golden`, and by `--update`/`--out`
// over the STAGED tree before it is published: an evidence update never replaces
// the approved goldens with fixtures that do not themselves verify.
function verifyGoldenFixtures(pinned, label) {
  // -------------------------------------------------------------------------
  // The invalid-golden verification gate (ADR-ERL2-029 §7).
  // -------------------------------------------------------------------------
  //
  // Everything above compares *producer bytes*. It is not a gate on verification
  // at all, and the blind spot was exact: `runCli` records `exit_code` into the
  // transcript and never asserts it, and `cli-transcript.json` is the single file
  // excluded from the pin. So the three `verify-record` invocations over the three
  // invalid goldens had their real outcome recorded in the one place the pin
  // cannot see — and a verifier regression against invalid records changes no
  // producer bytes, so it left `evidence:verify` green.
  //
  // This pass obtains its own exit codes, in its own child processes, from the
  // pinned fixtures. The transcript is not consulted and nothing depends on it.
  //
  // Fixtures are ENUMERATED from the directory, never hard-coded: a new invalid
  // golden is covered the day it lands and cannot be added outside the gate. The
  // count is asserted too, so one cannot silently leave.
  /**
   * One pinned fixture, verified by the shipped binary in its own process.
   *
   * Shared by both halves of the gate so the acceptance condition cannot drift
   * between them: exit 0 *and* a `valid` verdict, read from wherever the
   * subcommand puts its verdict. Exit code alone would pass a verifier that
   * stopped forming a verdict at all.
   */
  const verifyPinnedGolden = ({ argv, verdictAt }) => {
    const run = runCli(argv);
    const verdict = verdictAt(run.stdout) ?? null;
    return {
      ok: run.exit_code === 0 && verdict === "valid",
      exit: run.exit_code,
      verdict,
      code: run.stdout?.errors?.[0]?.code ?? null,
    };
  };

  const EXPECTED_INVALID_GOLDENS = 3;
  const invalidGoldens = readdirSync(pinned)
    .filter((name) => name.startsWith("invalid-run-"))
    .filter((name) => existsSync(path.join(pinned, name, "invalid-record.json")))
    .sort();

  console.log(`\ngolden gate (${label}) — directly verifying ${String(invalidGoldens.length)} invalid golden(s):`);
  const invalidFailures = [];
  for (const name of invalidGoldens) {
    const dir = path.join(pinned, name);
    // A fresh process, the real offline verifier, the pinned fixture's own bytes.
    //
    // `verify-record` returns the independently derived closure report, so the
    // verdict read here is the *closure's* — the thing the verifier concluded —
    // not a status word the CLI chose.
    //
    // A correctly constructed invalid terminal *verifies*: the record is valid
    // evidence of an invalid run.
    const { ok, exit, verdict, code } = verifyPinnedGolden({
      argv: [
        "verify-record",
        "--record", path.join(dir, "invalid-record.json"),
        "--lifecycle", path.join(dir, "lifecycle.json"),
        "--artifact-root", path.join(dir, "artifacts"),
        "--root-config", path.join(dir, "root-config.json"),
        "--offline",
      ],
      verdictAt: (body) => body?.data?.closure?.verdict,
    });
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name} — exit ${String(exit)}, verdict ${String(verdict)}${code ? `, ${code}` : ""}`);
    if (!ok) invalidFailures.push({ name, exit, verdict, code });

    // An invalid terminal carries no attestation and no public bundle. If one is
    // present the fixture is not the thing the gate believes it is verifying.
    for (const forbidden of ["public-bundle.json", "attestation.json"]) {
      if (existsSync(path.join(dir, forbidden))) {
        invalidFailures.push({ name, exit: null, verdict: null, code: `carries ${forbidden}` });
      }
    }
  }

  if (invalidFailures.length > 0) {
    console.error(`\ngolden gate FAILED (${label}): an invalid golden did not verify.`);
    for (const f of invalidFailures) {
      console.error(`  ${f.name}: exit ${String(f.exit)}, verdict ${String(f.verdict)}, ${String(f.code)}`);
    }
    console.error(
      "\nA broken invalid fixture, or a verifier regression against invalid records, changes no\n" +
        "producer bytes — which is exactly why this gate reads verification results and not bytes.",
    );
    process.exit(1);
  }
  if (invalidGoldens.length !== EXPECTED_INVALID_GOLDENS) {
    console.error(
      `\ngolden gate FAILED (${label}): coverage moved — ${String(invalidGoldens.length)} invalid golden(s), ` +
        `expected ${String(EXPECTED_INVALID_GOLDENS)}.\n` +
        `If this change is intended, update EXPECTED_INVALID_GOLDENS in the same commit.`,
    );
    process.exit(1);
  }
  console.log(
    `golden gate OK (${label}) — all ${String(invalidGoldens.length)} invalid goldens verify at exit 0 / valid ` +
      `in a fresh process`,
  );

  // -------------------------------------------------------------------------
  // The valid-golden verification gate (review R-02).
  // -------------------------------------------------------------------------
  //
  // ADR-ERL2-029 §7's argument is not about invalidity; it is about *where the
  // result is recorded*. The generator's `erl2 verify --offline` over
  // `valid-pre-environment-run` pushes its outcome into `transcript`, and
  // `cli-transcript.json` is the one file excluded from the byte pin. So a
  // verifier regression that started rejecting historically-pinned *valid*
  // bundles — a contract tightening, a new required role, a stricter closure —
  // changed no producer bytes and left this gate green, exactly as the invalid
  // half did before it was closed.
  //
  // Same shape as the invalid half, and deliberately so: enumerate from the
  // directory, assert the count, obtain the verdict from a fresh process over
  // the pinned bytes, and consult the transcript for nothing.
  const EXPECTED_VALID_GOLDENS = 1;
  // A valid public bundle is what makes a fixture a member here — not a name
  // prefix. `**/artifacts/retained/public-bundle.json` belongs to a run's own
  // artifact tree and is not a fixture root, so enumeration is one level deep.
  const validGoldens = readdirSync(pinned, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(pinned, name, "public-bundle.json")))
    .sort();

  console.log(`\ngolden gate (${label}) — directly verifying ${String(validGoldens.length)} valid golden(s):`);
  const validFailures = [];
  for (const name of validGoldens) {
    const dir = path.join(pinned, name);
    // A fixture missing an input is malformed, not absent: without this it would
    // reach the verifier as a usage error and be indistinguishable from a real
    // rejection.
    const required = ["public-bundle.json", "root-config.json", "lifecycle.json", "artifacts"];
    const absent = required.filter((f) => !existsSync(path.join(dir, f)));
    if (absent.length > 0) {
      console.log(`  FAIL ${name} — malformed fixture, missing ${absent.join(", ")}`);
      validFailures.push({ name, exit: null, verdict: null, code: `missing ${absent.join(", ")}` });
      continue;
    }
    // `verify` reports the bundle verdict at `data.verdict`; the closure it
    // derived hangs beside it. This is the decision an external consumer gets.
    const { ok, exit, verdict, code } = verifyPinnedGolden({
      argv: [
        "verify",
        "--public-bundle", path.join(dir, "public-bundle.json"),
        "--root-config", path.join(dir, "root-config.json"),
        "--artifact-root", path.join(dir, "artifacts"),
        "--lifecycle", path.join(dir, "lifecycle.json"),
        "--offline",
      ],
      verdictAt: (body) => body?.data?.verdict,
    });
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name} — exit ${String(exit)}, verdict ${String(verdict)}${code ? `, ${code}` : ""}`);
    if (!ok) validFailures.push({ name, exit, verdict, code });
  }

  if (validFailures.length > 0) {
    console.error(`\ngolden gate FAILED (${label}): a valid golden did not verify.`);
    for (const f of validFailures) {
      console.error(`  ${f.name}: exit ${String(f.exit)}, verdict ${String(f.verdict)}, ${String(f.code)}`);
    }
    console.error(
      "\nA verifier regression against a historically valid bundle changes no producer bytes —\n" +
        "which is exactly why this gate reads verification results and not bytes.",
    );
    process.exit(1);
  }
  if (validGoldens.length !== EXPECTED_VALID_GOLDENS) {
    console.error(
      `\ngolden gate FAILED (${label}): coverage moved — ${String(validGoldens.length)} valid golden(s), ` +
        `expected ${String(EXPECTED_VALID_GOLDENS)}.\n` +
        `If this change is intended, update EXPECTED_VALID_GOLDENS in the same commit.`,
    );
    process.exit(1);
  }
  console.log(
    `golden gate OK (${label}) — all ${String(validGoldens.length)} valid goldens verify at exit 0 / valid ` +
      `in a fresh process`,
  );
}