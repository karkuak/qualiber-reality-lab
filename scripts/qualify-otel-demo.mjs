#!/usr/bin/env node
// ERL2-OQ-005: qualifies the OpenTelemetry Demo Compose substrate.
//
// This is deliberately NOT part of `npm test`. It reaches a registry, it runs
// Docker Scout, and it rewrites a signed lock. `npm test` verifies the *retained
// lock* instead, so the hermetic suite stays fast while qualification still
// depends on a real fetch.
//
// What it pins, all of it from immutable coordinates:
//
//   - the release archive, by SHA-256, fetched from the tag `3.0.0`, whose
//     embedded pax header records the source commit;
//   - every selected image, by registry digest, for BOTH linux/amd64 and
//     linux/arm64, resolved from the release-pinned tag once, here, and never
//     again at run time;
//   - the SHA-256 of all five configuration files the environment applies;
//   - an SBOM and a provenance record.
//
// Usage:
//   node scripts/qualify-otel-demo.mjs            # fetch, resolve, sign the lock
//   node scripts/qualify-otel-demo.mjs --fetch-only
//   node scripts/qualify-otel-demo.mjs --verify    # re-observe, do not rewrite
//
// Exit codes: 0 qualified/verified, 9 drift or refusal, 2 usage.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash, developmentKey, sealSigned } from "@erl2/integrity";
import { assertContract } from "@erl2/contracts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "environments", "otel-demo");
const upstreamDir = path.join(outDir, "upstream");
const qualificationDir = path.join(outDir, "qualification");

// ---------------------------------------------------------------------------
// The pinned upstream coordinates. Immutable by construction: a release tag and
// the commit that tag names. Neither `main` nor a floating tag appears anywhere.
// ---------------------------------------------------------------------------
const RELEASE_TAG = "3.0.0";
const ARCHIVE_URL = `https://codeload.github.com/open-telemetry/opentelemetry-demo/tar.gz/refs/tags/${RELEASE_TAG}`;
const ARCHIVE_FILE = path.join(upstreamDir, `opentelemetry-demo-${RELEASE_TAG}.tar.gz`);

// The qualified subset. Two services, and the image reference each is resolved
// from — a release-pinned tag, resolved exactly once, here.
const SERVICES = [
  {
    serviceId: "otel-collector",
    repository:
      "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib",
    // Upstream's own `.env` pins the collector release; the value is repeated
    // here so the qualifier fails loudly if the archive ever stops agreeing.
    tag: "0.157.0",
    // The exact line the release's own `.env` must still carry for this pin to
    // be upstream's choice rather than ours.
    envAssertion:
      "COLLECTOR_CONTRIB_IMAGE=ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib:0.157.0",
  },
  {
    serviceId: "quote",
    repository: "ghcr.io/open-telemetry/demo",
    tag: `${RELEASE_TAG}-quote`,
    // `compose.yaml` composes this reference as `${IMAGE_NAME}:${DEMO_VERSION}-quote`;
    // the release-pinned form of that is `IMAGE_VERSION`, which is what the lock
    // resolves. `DEMO_VERSION` is `latest` upstream and is never resolved here.
    envAssertion: `IMAGE_VERSION=${RELEASE_TAG}`,
  },
];

const REQUIRED_PLATFORMS = ["linux/amd64", "linux/arm64"];

const UPSTREAM_CONFIG_PATHS = ["compose.yaml", ".env", "src/otel-collector/otelcol-config.yml"];
const REPOSITORY_CONFIG_PATHS = [
  "environments/otel-demo/compose/erl2-overlay.yaml",
  "environments/otel-demo/compose/erl2-otelcol-extras.yaml",
];

const fetchOnly = process.argv.includes("--fetch-only");
const verifyOnly = process.argv.includes("--verify");

function run(binary, args, { allowFailure = false, timeout = 900_000 } = {}) {
  // argv array, no shell: the same rule the driver follows.
  const result = spawnSync(binary, args, { encoding: "utf8", shell: false, timeout, maxBuffer: 64 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) {
    console.error(`${binary} ${args.join(" ")} failed:\n${result.stderr ?? ""}`);
    process.exit(9);
  }
  return result;
}

function sha256File(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

// -- 1. the archive ---------------------------------------------------------

mkdirSync(upstreamDir, { recursive: true });
mkdirSync(qualificationDir, { recursive: true });

if (!existsSync(ARCHIVE_FILE)) {
  console.log(`== fetching ${ARCHIVE_URL}`);
  run("curl", ["--fail", "--silent", "--show-error", "--location", "--output", ARCHIVE_FILE, ARCHIVE_URL]);
}
const archiveSha256 = sha256File(ARCHIVE_FILE);
console.log(`   archive        ${ARCHIVE_FILE}`);
console.log(`   archive sha256 ${archiveSha256}`);

// The commit is read out of the archive itself, not asked of an API that could
// answer about a different tree. GitHub's source tarballs carry it in the pax
// global header as `comment=<sha>`.
const header = run("tar", ["-xzOf", ARCHIVE_FILE, "--fast-read", "pax_global_header"], { allowFailure: true });
const sourceCommit =
  /comment=([0-9a-f]{40})/.exec(header.stdout ?? "")?.[1] ??
  /comment=([0-9a-f]{40})/.exec(
    run("gzip", ["-dc", ARCHIVE_FILE], { allowFailure: true }).stdout?.slice(0, 4096) ?? "",
  )?.[1];
if (!sourceCommit) {
  console.error("the archive carries no source commit in its pax global header; refusing to record an unknown tree");
  process.exit(9);
}
console.log(`   source commit  ${sourceCommit}`);

// -- 2. the applied configuration -------------------------------------------

const workRoot = path.join(upstreamDir, `extracted-${archiveSha256.slice(7, 23)}`);
if (!existsSync(path.join(workRoot, "compose.yaml"))) {
  mkdirSync(workRoot, { recursive: true });
  run("tar", [
    "-xzf",
    ARCHIVE_FILE,
    "-C",
    workRoot,
    "--strip-components=1",
    ...UPSTREAM_CONFIG_PATHS.map((p) => `*/${p}`),
  ]);
}

const upstreamEnv = readFileSync(path.join(workRoot, ".env"), "utf8");
for (const service of SERVICES) {
  if (!upstreamEnv.includes(service.envAssertion)) {
    console.error(
      `the pinned release's .env does not carry \`${service.envAssertion}\`; the subset's image pin has drifted from upstream`,
    );
    process.exit(9);
  }
}

const configFiles = [
  ...UPSTREAM_CONFIG_PATHS.map((p) => path.join(workRoot, p)),
  ...REPOSITORY_CONFIG_PATHS.map((p) => path.join(repoRoot, p)),
];
const configHashes = configFiles.map(sha256File);
console.log("== applied configuration");
for (const [i, file] of configFiles.entries()) {
  console.log(`   ${configHashes[i]}  ${path.relative(repoRoot, file)}`);
}

if (fetchOnly) {
  console.log("\nfetch-only: archive and configuration are present; the lock was not rewritten.");
  process.exit(0);
}

// -- 3. per-platform image digests ------------------------------------------

console.log("== resolving image digests, per platform, from the release-pinned tags");
const images = [];
for (const service of SERVICES) {
  const reference = `${service.repository}:${service.tag}`;
  const raw = run("docker", ["buildx", "imagetools", "inspect", reference, "--raw"]).stdout;
  const index = JSON.parse(raw);
  for (const platform of REQUIRED_PLATFORMS) {
    const [os, architecture] = platform.split("/");
    const manifest = (index.manifests ?? []).find(
      (m) => m.platform?.os === os && m.platform?.architecture === architecture && !m.platform?.variant,
    );
    if (!manifest) {
      console.error(`${reference} publishes no ${platform} manifest; the subset cannot be qualified for it`);
      process.exit(9);
    }
    images.push({ service_id: service.serviceId, platform, digest: manifest.digest });
    console.log(`   ${service.serviceId.padEnd(16)} ${platform.padEnd(12)} ${manifest.digest}`);
  }
}

// -- 4. SBOM and provenance --------------------------------------------------
//
// syft and cosign are not installed on the qualifying host; Docker Scout is, and
// it is what produced these. That is recorded in the provenance rather than
// implied, because "an SBOM exists" and "an SBOM was produced by a tool you can
// name" are different claims.

const executing = run("docker", ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]).stdout.trim();
console.log(`== generating SBOM and provenance (executing platform ${executing})`);
const sbomDocuments = [];
for (const image of images) {
  const reference = `${image.service_id === "quote" ? SERVICES[1].repository : SERVICES[0].repository}@${image.digest}`;
  const file = path.join(qualificationDir, `sbom-${image.service_id}-${image.platform.replace("/", "-")}.spdx.json`);
  const scout = run(
    "docker",
    ["scout", "sbom", "--format", "spdx", "--platform", image.platform, reference, "-o", file],
    { allowFailure: true },
  );
  if (scout.status !== 0 || !existsSync(file)) {
    console.log(`   ${image.service_id} ${image.platform}: SBOM unavailable (${(scout.stderr ?? "").trim().slice(0, 120)})`);
    continue;
  }
  const document = JSON.parse(readFileSync(file, "utf8"));
  sbomDocuments.push({
    service_id: image.service_id,
    platform: image.platform,
    image_digest: image.digest,
    package_count: (document.packages ?? []).length,
    spdx_file: path.relative(repoRoot, file).split(path.sep).join("/"),
    spdx_file_sha256: sha256File(file),
  });
  console.log(`   ${image.service_id.padEnd(16)} ${image.platform.padEnd(12)} ${(document.packages ?? []).length} packages`);
}
if (sbomDocuments.length === 0) {
  console.error("no SBOM could be generated; a qualified lock requires one");
  process.exit(9);
}

const provenanceRecords = [];
for (const image of images) {
  const repository = image.service_id === "quote" ? SERVICES[1].repository : SERVICES[0].repository;
  const attested = run(
    "docker",
    ["buildx", "imagetools", "inspect", `${repository}@${image.digest}`, "--format", "{{json .Provenance}}"],
    { allowFailure: true },
  );
  let slsa = null;
  try {
    slsa = JSON.parse(attested.stdout || "{}");
  } catch {
    slsa = null;
  }
  provenanceRecords.push({
    service_id: image.service_id,
    platform: image.platform,
    image_digest: image.digest,
    build_attestation_present: Boolean(slsa && Object.keys(slsa).length > 0),
    build_type: slsa?.[image.platform]?.SLSA?.buildDefinition?.buildType ?? null,
  });
}

const sbomIndexFile = path.join(qualificationDir, "sbom.json");
writeFileSync(
  sbomIndexFile,
  `${JSON.stringify(
    {
      substrate_id: "opentelemetry-demo",
      release_tag: RELEASE_TAG,
      source_commit: sourceCommit,
      generated_by: "docker scout sbom --format spdx",
      documents: sbomDocuments,
    },
    null,
    2,
  )}\n`,
);

const provenanceFile = path.join(qualificationDir, "provenance.json");
writeFileSync(
  provenanceFile,
  `${JSON.stringify(
    {
      substrate_id: "opentelemetry-demo",
      release_tag: RELEASE_TAG,
      source_commit: sourceCommit,
      archive_url: ARCHIVE_URL,
      archive_sha256: archiveSha256,
      qualified_on_platform: executing,
      tooling: {
        sbom: "docker scout",
        image_resolution: "docker buildx imagetools",
        syft: "not installed on the qualifying host",
        cosign: "not installed on the qualifying host",
      },
      // The archive is fetched over TLS from GitHub's codeload endpoint and
      // hashed; it carries no detached signature this host could verify, and no
      // cosign attestation was checked. Recorded, not glossed.
      independently_authenticated: false,
      images: provenanceRecords,
    },
    null,
    2,
  )}\n`,
);

// -- 5. the lock --------------------------------------------------------------

const lockFile = path.join(outDir, "substrate-lock.json");
const body = {
  schema_version: "substrate-lock/v1",
  lock_id: "otel-demo-minimal-subset",
  substrate_id: "opentelemetry-demo",
  qualification_status: "qualified",
  source_archive: {
    release_tag: RELEASE_TAG,
    source_commit: sourceCommit,
    archive_sha256: archiveSha256,
  },
  images,
  sbom: {
    path: path.relative(repoRoot, sbomIndexFile).split(path.sep).join("/"),
    media_type: "application/json",
    byte_length: statSync(sbomIndexFile).size,
    file_sha256: sha256File(sbomIndexFile),
    classification: "PUBLIC",
  },
  provenance: {
    producer: "erl2 scripts/qualify-otel-demo.mjs (docker scout, docker buildx imagetools)",
    producer_version: "0.1.0",
    source_uri: ARCHIVE_URL,
    source_commit: sourceCommit,
    transformations: [
      "fetch release archive over TLS and record its SHA-256",
      "read the source commit from the archive pax global header",
      "resolve linux/amd64 and linux/arm64 manifest digests from the release-pinned tags",
      "hash the five applied configuration files",
      "generate SPDX SBOMs with docker scout",
      "record build attestation presence with docker buildx imagetools",
      "sign with the repository development environment governor (NOT an independent authority)",
    ],
  },
  config_hashes: [...new Set(configHashes)],
  recorded_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
};

// The environment-governor role is granted to the challenge-governor key by the
// development trust policy, and `verifySubstrateLockSignature` classifies that
// key as a *development* key rather than a pinned authority. That classification
// is the honest one and is deliberately not worked around.
const lock = assertContract("SubstrateLockV1", sealSigned(body, developmentKey("challenge-governor")));

if (verifyOnly) {
  const existing = JSON.parse(readFileSync(lockFile, "utf8"));
  const drift = [];
  if (existing.source_archive?.archive_sha256 !== archiveSha256) drift.push("archive sha256");
  if (existing.source_archive?.source_commit !== sourceCommit) drift.push("source commit");
  if (JSON.stringify(existing.images) !== JSON.stringify(images)) drift.push("image digests");
  if (JSON.stringify([...existing.config_hashes].sort()) !== JSON.stringify([...new Set(configHashes)].sort())) {
    drift.push("config hashes");
  }
  if (drift.length > 0) {
    console.error(`\nDRIFT: the retained lock disagrees with what was just observed: ${drift.join(", ")}`);
    process.exit(9);
  }
  console.log("\nverified: the retained lock matches what this host observes.");
  process.exit(0);
}

writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`\nqualified: ${path.relative(repoRoot, lockFile)}`);
console.log(`   core_hash ${lock.core_hash}`);
console.log(`   signer    ${lock.signature.key_id} (repository development key; NOT an independent authority)`);
