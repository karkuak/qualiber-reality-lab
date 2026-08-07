#!/usr/bin/env node
// Runs the real subject-isolation enforcement probe suite against a pinned
// container substrate and publishes the evidence (ERL2-OQ-008, ADR-ERL2-016).
//
// This is deliberately NOT part of `npm test`. It needs a real container
// runtime, it mutates nothing but it does create and destroy containers, and it
// takes minutes. `npm test` verifies the *retained evidence* instead, so the
// hermetic suite stays fast while qualification still depends on a real run.
//
// Usage:
//   node scripts/qualify-isolation.mjs --image <ref@sha256:...> [--out environments/isolation]
//
// The image reference MUST be digest-pinned: a tag can move, and enforcement
// observed against a moved tag says nothing about the bytes a later run uses.
// Exit codes: 0 qualified, 9 not qualified, 2 usage.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CliContainerRuntime,
  PROBE_SUITE_ID,
  SystemClock,
  buildIsolationProbeSigningManifest,
  buildIsolationQualificationReport,
  buildIsolationSubstrateLock,
  containerRuntimeConfigurationInput,
  discoverSubstrate,
  probeSuiteDigest,
  reapProbeResidue,
  runEnforcementProbes,
  runtimeConfigurationHash,
} from "@erl2/core";
import { developmentKey } from "@erl2/integrity";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return fallback;
}

const image = flag("image", process.env.ERL2_ISOLATION_IMAGE);
const binary = flag("runtime", process.env.ERL2_ISOLATION_RUNTIME ?? "docker");
const outDir = path.resolve(repoRoot, flag("out", path.join("environments", "isolation")));

if (!image) {
  console.error(
    "usage: node scripts/qualify-isolation.mjs --image <reference@sha256:...> [--runtime docker] [--out environments/isolation]",
  );
  process.exit(2);
}

// The probes must prove these are unreachable from inside a container. They are
// the deployment's real secret roots, not a guess.
const forbiddenHostPaths = [
  path.join(repoRoot, "vault"),
  path.join(repoRoot, "truth"),
  path.join(repoRoot, "judge"),
  path.join(repoRoot, "selection"),
  path.join(repoRoot, "fixtures"),
  path.join(repoRoot, "environments"),
];

const runtime = new CliContainerRuntime({ binary, runtimeId: binary });
const clock = new SystemClock();
// A stable, run-scoped identity for the probe resources. It is a UUIDv7 so the
// run-scoped-identity probe checks the same shape a real run uses.
const runId = "01890000-0000-7000-8000-0000000000aa";

// The runtime-configuration and policy-input hashes are computed by the
// qualifier from the in-effect configuration (they are not read from the runtime
// binary), then handed to discoverSubstrate so the observed state — and the lock
// derived from it — carry them as pinned fields.
// Read from the shared constant rather than restated: the probes and the
// container launcher apply the same vector, so the hash the lock pins is the
// hash of the configuration an adapter will actually run under. Restating it
// here is how a launcher could quietly diverge from the evidence.
const runtimeConfigurationHashes = [runtimeConfigurationHash(containerRuntimeConfigurationInput())];
const policyInputHashes = [runtimeConfigurationHash({ egress: "deny-by-default" })];

console.log(`== discovering substrate via ${binary} ==`);
const observed = discoverSubstrate({
  runtime,
  imageReference: image,
  runtimeConfigurationHashes,
  policyInputHashes,
});
for (const [k, v] of Object.entries(observed)) console.log(`  ${k}: ${v}`);

const lock = buildIsolationSubstrateLock({
  lockId: "erl2-container-isolation-lock",
  profile: "container",
  observed,
  probeSuiteId: PROBE_SUITE_ID,
  probeSuiteDigest: probeSuiteDigest(),
  recordedAt: clock.now(),
  signingKey: developmentKey("environment-governor"),
});

console.log(`\n== running ${PROBE_SUITE_ID} against the locked substrate ==`);
const started = Date.now();
const results = runEnforcementProbes({ runtime, lock, clock, runId, forbiddenHostPaths });
console.log(`   finished in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

for (const r of results) {
  const pass = r.enforced && r.evidence === "observed";
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${r.control_id.padEnd(42)} evidence=${r.evidence.padEnd(9)}${
      r.reason_code ? ` ${r.reason_code}` : ""
    }`,
  );
  if (!pass) console.log(`        observed: ${r.observation.observed.slice(0, 500)}`);
}

const report = buildIsolationQualificationReport({
  reportId: "erl2-container-qualification",
  profile: "container",
  lock,
  probeResults: results,
  evaluatedAt: clock.now(),
});

console.log(`\n== verdict: ${report.verdict} ==`);
if (report.verdict !== "qualified") {
  console.log(`   state:   ${report.not_qualified_state}`);
  console.log(`   missing: ${report.missing_controls.join(", ") || "(none)"}`);
  for (const reason of report.reasons.slice(0, 10)) console.log(`   reason:  ${reason}`);
}

// Publish evidence only for a qualified verdict. A not-qualified run must not
// leave a lock behind that a later `erl2 doctor` could read as progress: the
// honest state of an unqualified host is no retained lock at all.
//
// Exactly the four evidence artifacts, never the directory. This used to
// `rmSync` the whole of `outDir`, which also deleted the directory's README and
// — once ADR-ERL2-034 put it there — `runtime-image/Dockerfile`, the source of
// the very substrate being qualified. Nothing failed; the files simply went
// away, and the first run of this package deleted the README before anyone
// noticed.
for (const artifact of [
  "substrate-lock.json",
  "qualification-report.json",
  "probe-signing-manifest.json",
  "probes",
]) {
  rmSync(path.join(outDir, artifact), { recursive: true, force: true });
}
if (report.verdict === "qualified") {
  mkdirSync(path.join(outDir, "probes"), { recursive: true });
  writeFileSync(path.join(outDir, "substrate-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(
    path.join(outDir, "qualification-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  for (const r of results) {
    writeFileSync(
      path.join(outDir, "probes", `${r.control_id}.json`),
      `${JSON.stringify(r, null, 2)}\n`,
    );
  }
  // A SIGNED manifest authenticating the twenty probe results (§10.1/6R-E). The
  // development governor key is not a real qualification authority, so this
  // still reads `locally_observed_unauthenticated` under `erl2 doctor`.
  const probeManifest = buildIsolationProbeSigningManifest({
    manifestId: "erl2-container-isolation-probe-manifest",
    lock,
    probeResults: results,
    signedAt: clock.now(),
    signingKey: developmentKey("environment-governor"),
  });
  writeFileSync(
    path.join(outDir, "probe-signing-manifest.json"),
    `${JSON.stringify(probeManifest, null, 2)}\n`,
  );
  console.log(`\nevidence published to ${path.relative(repoRoot, outDir)}`);
} else {
  console.log(`\nno evidence published: ${path.relative(repoRoot, outDir)} left absent`);
}

const reaped = reapProbeResidue({ runtime, lock, clock, runId, forbiddenHostPaths: [] });
console.log(`residue reaped after the suite: ${reaped.length === 0 ? "(none)" : reaped.join(", ")}`);

process.exit(report.verdict === "qualified" ? 0 : 9);
