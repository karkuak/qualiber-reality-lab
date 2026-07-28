#!/usr/bin/env node
/**
 * Produces the Slice 2 CLI/verifier evidence into `fixtures/golden/`.
 *
 * Nothing here is a development shortcut in the release CLI: the harness builds
 * the runs through `@erl2/core`, then the *real* `erl2` binary verifies them
 * offline in a fresh process, exactly as an external consumer would.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// Deterministic evidence (P2-10, plan §19.3): routine generation writes into a
// throwaway directory and NEVER mutates the approved goldens.  Only the explicit
// `--update` (evidence:update) rewrites `fixtures/golden`; `--out <dir>` targets
// a named directory.  A fixed evidence clock and fixed run ids anchor every run
// so the run artifacts are reproducible (the hiding-commitment salts in the test
// governor and the real-adapter subprocess remain nondeterministic — see the
// remediation ledger).
const outFlagIndex = process.argv.indexOf("--out");
let goldenRoot;
if (process.argv.includes("--update")) {
  goldenRoot = path.join(root, "fixtures", "golden");
} else if (outFlagIndex >= 0 && process.argv[outFlagIndex + 1]) {
  goldenRoot = path.resolve(process.argv[outFlagIndex + 1]);
} else {
  goldenRoot = mkdtempSync(path.join(tmpdir(), "erl2-evidence-out-"));
}
mkdirSync(goldenRoot, { recursive: true });
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
  const dir = path.join(goldenRoot, name);
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
  const journeyDir = path.join(goldenRoot, "journey-acquisition-to-frozen-output");
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

  const adapterDir = path.join(goldenRoot, "adapter-platform");
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
  const registry = buildGovernorRegistry({ random: seededRandom("adapter-platform") });
  const journeys = [
    ["reference-correct", registry.referenceCorrectAdapterHash, "verify_package"],
    ["reference-limited", registry.referenceLimitedAdapterHash, "verify_package"],
  ];
  for (const [id, adapterHash] of journeys) {
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
      "--adapter", registry.referenceCorrectAdapterHash,
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
    // A fixed, cleaned working directory (never a random tmpdir) so the run's
    // absolute paths are reproducible; `.erl2-work` is removed by `npm run clean`.
    const runRoot = path.join(root, ".erl2-work", "evidence", label);
    rmSync(runRoot, { recursive: true, force: true });
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

    const dir = path.join(goldenRoot, label);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cpSync(runRoot, path.join(dir, "artifacts"), { recursive: true });
  }
}

// Negative: a command from an unshipped slice refuses rather than no-ops.
transcript.push(runCli(["select", "--request", "x"]));

writeFileSync(
  path.join(goldenRoot, "cli-transcript.json"),
  `${JSON.stringify(transcript, null, 2)}\n`,
);

const failures = transcript.filter((t) => t.exit_code !== 0);
console.log(
  `wrote ${goldenRoot} (${String(transcript.length)} CLI invocations, ${String(failures.length)} expected refusals)`,
);
for (const t of transcript) {
  const code = t.stdout?.errors?.[0]?.code ?? "-";
  console.log(`  exit ${String(t.exit_code)}  ${t.argv.slice(0, 2).join(" ")}  ${code}`);
}

// ---------------------------------------------------------------------------
// evidence:verify — a deterministic byte-pin (6R-D, plan §9.1).
// ---------------------------------------------------------------------------
//
// `--verify` byte-compares the freshly, deterministically generated evidence in
// `goldenRoot` against the committed pinned goldens under `fixtures/golden`,
// WITHOUT mutating them.
//
// Exclusions are per-FILE, never per-subtree, and are LOGGED (never silently
// dropped). Generating twice into two directories and diffing shows exactly
// seven files that cannot be byte-stable; every other file — including the whole
// rest of the real out-of-process `adapter-platform/` evidence — is pinned:
//
//   - `**/request.frames` — the adapter host bakes the absolute
//     adapter-workspace path into the request frames, so these vary with the
//     checkout location.
//   - `**/grandchild.pid` — the hostile-adapter fixture writes a REAL OS pid to
//     prove the supervisor tree-kill; a pid varies per process launch.
//   - `cli-transcript.json` — records the absolute `--artifact-root`/path
//     arguments of each CLI invocation, so it is path-dependent by construction.
//
// Everything else — every fake-run terminal, the journey run, the generic
// finalization runs, invalid records, bundles, lifecycle logs, root configs and
// the real adapter protocol evidence — is byte-identical to the pin or
// `--verify` fails.
if (process.argv.includes("--verify")) {
  const pinned = path.join(root, "fixtures", "golden");
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
  const EXPECTED_PINNED = 780;
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
  const freshFiles = new Set(walk(goldenRoot).filter((r) => !EXCLUDE(r)));
  const mismatches = [];
  const missing = [];
  const extra = [];
  for (const rel of goldenFiles) {
    if (!freshFiles.has(rel)) {
      missing.push(rel);
      continue;
    }
    const a = readFileSync(path.join(pinned, rel));
    const b = readFileSync(path.join(goldenRoot, rel));
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
}
