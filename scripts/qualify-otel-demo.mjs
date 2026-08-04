#!/usr/bin/env node
// ERL2-OQ-005: qualifies the OpenTelemetry Demo Compose substrate.
//
// This is deliberately NOT part of `npm test`. It reaches a registry, it runs
// Docker Scout, and in its default mode it rewrites a signed lock. `npm test`
// verifies the *retained lock* instead, so the hermetic suite stays fast while
// qualification still depends on a real fetch.
//
// What it pins, all of it from immutable coordinates:
//
//   - the release archive, by SHA-256, fetched from the tag `3.0.0`, whose
//     embedded pax header records the source commit;
//   - every selected image, by registry digest, for BOTH linux/amd64 and
//     linux/arm64, resolved from the release-pinned tag once, here, and never
//     again at run time;
//   - the SHA-256 of all five configuration files the environment applies;
//   - an SBOM for every service on every required platform, and a provenance
//     record.
//
// Usage:
//   node scripts/qualify-otel-demo.mjs                  # fetch, resolve, sign the lock
//   node scripts/qualify-otel-demo.mjs --fetch-only
//   node scripts/qualify-otel-demo.mjs --verify          # re-observe; write nothing
//   node scripts/qualify-otel-demo.mjs --relock-config   # re-sign for a changed applied config
//
// Exit codes: 0 qualified/verified, 9 drift or refusal, 2 usage.
//
// ## `--relock-config`
//
// A repository-owned configuration file is one of the five the lock hashes, so
// editing one — a Compose overlay that narrows a port binding, say — invalidates
// the lock. The full generating path would fix that, and would also re-run Docker
// Scout and rewrite four SPDX documents whose only difference is a fresh creation
// timestamp. That is regeneration noise: it makes a diff that claims the SBOM
// changed when nothing about the images did, and it puts the burden of noticing
// on the reviewer.
//
// So this mode re-signs the lock for a configuration change and nothing else. It
// is deliberately not a shortcut around qualification:
//
//   - the archive, the source commit and both platforms' image digests are
//     re-observed exactly as `--verify` observes them;
//   - the retained SBOM index, the four SPDX documents and the provenance record
//     are reused *byte for byte* — they are not rewritten, and the lock keeps its
//     recorded reference to them;
//   - the candidate lock is sealed and then run through the *complete* verifier,
//     `qualificationDrift`, over the whole retained set. It is written only if that
//     reports nothing. A drift in anything other than the configuration hashes —
//     a moved archive, a re-pushed image, an SBOM that no longer hashes to its
//     record — is a refusal, not a re-lock.
//
// So the only way this mode can succeed is if the configuration hash set is the
// single thing that moved, and the verifier says so.
//
// ## `--verify` is read-only, and that is a property, not an intention
//
// Verify used to run the same code path as generation and only *branch* at the
// end, which meant it had already overwritten four tracked SPDX documents, the
// tracked SBOM index and the tracked provenance record before deciding whether to
// rewrite the lock. A verifier that rewrites the thing it is verifying cannot
// detect that it drifted.
//
// So the two modes no longer share their writes. In verify mode:
//
//   - nothing under version control is opened for writing, at all;
//   - the archive is required to be present rather than fetched, because fetching
//     is a write;
//   - the one thing that has to be materialised — the three applied upstream
//     configuration files, so their bytes can be hashed — goes into a
//     `mkdtemp` directory that is removed in a `finally`, whatever the outcome;
//   - no fresh SBOM is generated at all. Docker Scout's SPDX output carries a
//     creation timestamp and a document namespace, so "regenerate and compare
//     bytes" is not a check that can pass. What is verified instead is the
//     retained set's *binding*: each SPDX file still hashes to what the index
//     records, the index still hashes to what the lock records, and every one of
//     them still names the image digests the registry serves right now.
//
// The comparison itself is in `scripts/lib/qualificationVerify.mjs`, so it can be
// tested without a network.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash, developmentKey, sealSigned } from "@erl2/integrity";
import { assertContract } from "@erl2/contracts";
import { verifySubstrateLockSignature } from "@erl2/core";
import { missingSbomSlots, qualificationDrift } from "./lib/qualificationVerify.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "environments", "otel-demo");
const upstreamDir = path.join(outDir, "upstream");
const qualificationDir = path.join(outDir, "qualification");

// ---------------------------------------------------------------------------
// The pinned upstream coordinates. Immutable by construction: a release tag and
// the commit that tag names. Neither `main` nor a floating tag appears anywhere.
// ---------------------------------------------------------------------------
const RELEASE_TAG = "3.0.0";
const SUBSTRATE_ID = "opentelemetry-demo";
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
const SERVICE_IDS = SERVICES.map((service) => service.serviceId);

const UPSTREAM_CONFIG_PATHS = ["compose.yaml", ".env", "src/otel-collector/otelcol-config.yml"];
const REPOSITORY_CONFIG_PATHS = [
  "environments/otel-demo/compose/erl2-overlay.yaml",
  "environments/otel-demo/compose/erl2-otelcol-extras.yaml",
];
const CONFIG_FILE_COUNT = UPSTREAM_CONFIG_PATHS.length + REPOSITORY_CONFIG_PATHS.length;

const SBOM_INDEX_RELATIVE = "environments/otel-demo/qualification/sbom.json";

const fetchOnly = process.argv.includes("--fetch-only");
const verifyOnly = process.argv.includes("--verify");
const relockConfig = process.argv.includes("--relock-config");

/** Directories this invocation created under the OS temp root, removed on the way out. */
const scratchDirs = [];

function scratch(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  scratchDirs.push(directory);
  return directory;
}

function cleanScratch() {
  for (const directory of scratchDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

function die(message) {
  console.error(message);
  cleanScratch();
  process.exit(9);
}

function run(binary, args, { allowFailure = false, timeout = 900_000 } = {}) {
  // argv array, no shell: the same rule the driver follows.
  const result = spawnSync(binary, args, { encoding: "utf8", shell: false, timeout, maxBuffer: 64 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) {
    die(`${binary} ${args.join(" ")} failed:\n${result.stderr ?? ""}`);
  }
  return result;
}

function sha256File(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function main() {
  // -- 1. the archive -------------------------------------------------------
  //
  // Verify never writes, and fetching is a write. An absent archive is therefore
  // a refusal in verify mode rather than a download, and the message says which
  // command produces it.
  // `--relock-config` writes exactly one file, the lock. Like `--verify` it does
  // not fetch and does not generate, so it takes the same path here.
  if (verifyOnly || relockConfig) {
    if (!existsSync(ARCHIVE_FILE)) {
      die(
        `the pinned archive is not present at ${path.relative(repoRoot, ARCHIVE_FILE)}; ` +
          "run `node scripts/qualify-otel-demo.mjs --fetch-only` first — neither --verify nor " +
          "--relock-config fetches, and fetching is a write",
      );
    }
  } else {
    mkdirSync(upstreamDir, { recursive: true });
    mkdirSync(qualificationDir, { recursive: true });
    if (!existsSync(ARCHIVE_FILE)) {
      console.log(`== fetching ${ARCHIVE_URL}`);
      run("curl", ["--fail", "--silent", "--show-error", "--location", "--output", ARCHIVE_FILE, ARCHIVE_URL]);
    }
  }
  const archiveSha256 = sha256File(ARCHIVE_FILE);
  console.log(`   archive        ${path.relative(repoRoot, ARCHIVE_FILE)}`);
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
    die("the archive carries no source commit in its pax global header; refusing to record an unknown tree");
  }
  console.log(`   source commit  ${sourceCommit}`);

  // -- 2. the applied configuration -----------------------------------------
  //
  // The three upstream files have to exist as bytes before they can be hashed. In
  // verify mode that unpacking is fresh comparison material, so it goes to a
  // task-owned temporary directory the `finally` above removes. In generating mode
  // it stays under the git-ignored `upstream/`, where a repeated run can reuse it.
  const workRoot =
    verifyOnly || relockConfig
      ? scratch("erl2-otel-verify-")
      : path.join(upstreamDir, `extracted-${archiveSha256.slice(7, 23)}`);
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
      die(
        `the pinned release's .env does not carry \`${service.envAssertion}\`; the subset's image pin has drifted from upstream`,
      );
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
    return;
  }

  // -- 3. per-platform image digests ----------------------------------------

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
        die(`${reference} publishes no ${platform} manifest; the subset cannot be qualified for it`);
      }
      images.push({ service_id: service.serviceId, platform, digest: manifest.digest });
      console.log(`   ${service.serviceId.padEnd(16)} ${platform.padEnd(12)} ${manifest.digest}`);
    }
  }

  const observed = { archiveSha256, sourceCommit, images, configHashes };
  if (verifyOnly && relockConfig) {
    die("--verify and --relock-config ask for opposite things; pick one");
  }
  if (verifyOnly) {
    verify(observed);
    return;
  }
  if (relockConfig) {
    relock(observed);
    return;
  }
  qualify(observed);
}

// ---------------------------------------------------------------------------
// verify: read the retained set, compare, write nothing
// ---------------------------------------------------------------------------

/**
 * Reads the retained qualification outputs off disk, hashed from their bytes.
 *
 * Shared by `--verify` and `--relock-config` so both decide against the same
 * reading of the same files. `--relock-config` reuses these verbatim rather than
 * regenerating them, which is what keeps a configuration change from producing an
 * SBOM diff.
 */
function readRetained() {
  const sbomIndexFile = path.join(repoRoot, SBOM_INDEX_RELATIVE);
  const sbomIndexPresent = existsSync(sbomIndexFile);
  const sbomIndex = sbomIndexPresent ? readJson(sbomIndexFile) : null;

  // Every SPDX document the index references, hashed and parsed from the bytes on
  // disk. `package_count` is read back out of the document rather than trusted,
  // because a retained index that agrees with a hash but not with the document's
  // own contents is exactly the drift a hash-only check misses.
  const spdx = {};
  for (const document of Array.isArray(sbomIndex?.documents) ? sbomIndex.documents : []) {
    const relative = String(document.spdx_file ?? "");
    const file = path.join(repoRoot, relative);
    if (!existsSync(file)) {
      spdx[relative] = { present: false };
      continue;
    }
    let packageCount;
    try {
      packageCount = (readJson(file).packages ?? []).length;
    } catch {
      packageCount = -1;
    }
    spdx[relative] = { present: true, sha256: sha256File(file), packageCount };
  }

  const provenanceFile = path.join(qualificationDir, "provenance.json");
  return {
    sbomIndex,
    sbomIndexByteLength: sbomIndexPresent ? statSync(sbomIndexFile).size : -1,
    sbomIndexSha256: sbomIndexPresent ? sha256File(sbomIndexFile) : "sha256:absent",
    spdx,
    provenance: existsSync(provenanceFile) ? readJson(provenanceFile) : null,
  };
}

const EXPECTED = {
  substrateId: SUBSTRATE_ID,
  releaseTag: RELEASE_TAG,
  archiveUrl: ARCHIVE_URL,
  requiredPlatforms: REQUIRED_PLATFORMS,
  serviceIds: SERVICE_IDS,
  configFileCount: CONFIG_FILE_COUNT,
  sbomIndexPath: SBOM_INDEX_RELATIVE,
};

function reportLock(lock, signature) {
  console.log("== lock");
  console.log(`   core_hash      ${lock.core_hash}`);
  console.log(`   signer         ${signature.signerKeyId}`);
  console.log(
    `   signature      ${signature.signatureValid ? "valid" : "INVALID"}` +
      ` (${signature.reason ?? "no reason recorded"})`,
  );
  console.log(
    `   classification pinned_authority=${signature.signerIsPinnedAuthority} ` +
      `development_key=${signature.signerIsDevelopmentKey}`,
  );
}

function reportRetained(retained) {
  console.log("== retained qualification");
  console.log(`   sbom index     ${SBOM_INDEX_RELATIVE}`);
  for (const [relative, file] of Object.entries(retained.spdx)) {
    console.log(`   spdx           ${file.present ? file.sha256 : "ABSENT"}  ${relative}`);
  }
  console.log(`   provenance     ${retained.provenance === null ? "ABSENT" : "present"}`);
}

function verify(observed) {
  const lockFile = path.join(outDir, "substrate-lock.json");
  if (!existsSync(lockFile)) die("there is no retained substrate lock to verify");
  const lock = readJson(lockFile);

  // The lock's own core hash is recomputed and its signature verified here rather
  // than assumed: a lock whose recorded hash is not its own, or whose signature
  // does not verify, is not a document any observation can be compared against.
  const signature = verifySubstrateLockSignature(lock);
  reportLock(lock, signature);
  const retained = readRetained();
  const drift = qualificationDrift({
    lock,
    lockCoreHash: coreHash(lock),
    signature,
    observed,
    retained,
    expected: EXPECTED,
  });
  reportRetained(retained);

  if (drift.length > 0) {
    console.error(`\nDRIFT: the retained qualification disagrees with what was just observed:`);
    for (const entry of drift) console.error(`   - ${entry}`);
    cleanScratch();
    process.exit(9);
  }
  console.log("\nverified: the retained qualification matches what this host observes.");
  console.log("   nothing under version control was written; comparison material was temporary.");
}

// ---------------------------------------------------------------------------
// relock-config: re-sign for a changed applied configuration, and nothing else
// ---------------------------------------------------------------------------

function relock(observed) {
  const lockFile = path.join(outDir, "substrate-lock.json");
  if (!existsSync(lockFile)) die("there is no retained substrate lock to re-lock");
  const previous = readJson(lockFile);

  // The lock being re-signed has to be sound first. Re-locking from a lock whose
  // own signature does not verify would launder a tampered document into a
  // correctly signed one, which is the opposite of the point.
  const previousSignature = verifySubstrateLockSignature(previous);
  if (!previousSignature.signatureValid) {
    die(
      `the retained lock's signature does not verify (${previousSignature.reason ?? "unknown"}); ` +
        "re-locking would sign over a document that is already untrustworthy",
    );
  }
  if (previous.core_hash !== coreHash(previous)) {
    die("the retained lock's recorded core hash is not its own; refusing to re-lock a hand-edited lock");
  }

  // Written in the order the generating path writes them — the order the five
  // applied files are hashed in — so a re-lock's diff is the hashes that actually
  // changed and not a reshuffle. The *decision* compares them as sets, because
  // that is how `assertObservedMatchesLock` compares them.
  const after = [...new Set(observed.configHashes)];
  const beforeSet = [...new Set(previous.config_hashes ?? [])].sort();
  const afterSet = [...after].sort();
  if (JSON.stringify(beforeSet) === JSON.stringify(afterSet)) {
    die("the applied configuration has not changed; there is nothing to re-lock");
  }

  // Everything except the configuration hashes and the recording instant is
  // carried across verbatim — including the `sbom` block, so the lock keeps
  // pointing at the retained index and the four SPDX documents that were never
  // rewritten, and including the inline `provenance` record.
  const body = {
    schema_version: previous.schema_version,
    lock_id: previous.lock_id,
    substrate_id: previous.substrate_id,
    qualification_status: previous.qualification_status,
    source_archive: { ...previous.source_archive },
    images: previous.images.map((image) => ({ ...image })),
    sbom: { ...previous.sbom },
    provenance: { ...previous.provenance, transformations: [...previous.provenance.transformations] },
    config_hashes: after,
    recorded_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
  const candidate = assertContract("SubstrateLockV1", sealSigned(body, developmentKey("challenge-governor")));
  const signature = verifySubstrateLockSignature(candidate);
  reportLock(candidate, signature);

  // And now the gate: the candidate goes through the *complete* verifier over the
  // whole retained set, against what was just observed. Nothing is written unless
  // that reports nothing — so a re-lock cannot assert qualification, it can only
  // record one the verifier already agrees with.
  const retained = readRetained();
  const drift = qualificationDrift({
    lock: candidate,
    lockCoreHash: coreHash(candidate),
    signature,
    observed,
    retained,
    expected: EXPECTED,
  });
  reportRetained(retained);
  if (drift.length > 0) {
    console.error("\nREFUSED: the re-locked candidate does not verify; more than the configuration moved:");
    for (const entry of drift) console.error(`   - ${entry}`);
    cleanScratch();
    process.exit(9);
  }

  writeFileSync(lockFile, `${JSON.stringify(candidate, null, 2)}\n`);
  console.log("\nre-locked: the applied configuration hash set changed and the lock was re-signed for it.");
  for (const hash of afterSet.filter((h) => !beforeSet.includes(h))) console.log(`   + ${hash}`);
  for (const hash of beforeSet.filter((h) => !afterSet.includes(h))) console.log(`   - ${hash}`);
  console.log("   the SBOM index, its four SPDX documents and the provenance record were not rewritten.");
  console.log(`   signer ${candidate.signature.key_id} (repository development key; NOT an independent authority)`);
}

// ---------------------------------------------------------------------------
// qualify: generate, then sign
// ---------------------------------------------------------------------------

function qualify(observed) {
  const { archiveSha256, sourceCommit, images, configHashes } = observed;

  // -- 4. SBOM and provenance ------------------------------------------------
  //
  // syft and cosign are not installed on the qualifying host; Docker Scout is, and
  // it is what produced these. That is recorded in the provenance rather than
  // implied, because "an SBOM exists" and "an SBOM was produced by a tool you can
  // name" are different claims.
  const executing = run("docker", ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]).stdout.trim();
  console.log(`== generating SBOM and provenance (executing platform ${executing})`);
  const sbomDocuments = [];
  for (const image of images) {
    const repository = repositoryOf(image.service_id);
    const reference = `${repository}@${image.digest}`;
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
    const document = readJson(file);
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
  // The complete matrix, or nothing. A lock that pins four images while its SBOM
  // describes three is a lock that overstates what was qualified, and "at least
  // one SBOM" was exactly the rule that allowed it.
  const missing = missingSbomSlots(sbomDocuments, SERVICE_IDS, REQUIRED_PLATFORMS);
  if (missing.length > 0) {
    die(
      `no SBOM could be generated for ${missing.join(", ")}; a qualified lock requires one per service per ` +
        "required platform, and a partial matrix would overstate what was qualified",
    );
  }

  const provenanceRecords = [];
  for (const image of images) {
    const repository = repositoryOf(image.service_id);
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
        substrate_id: SUBSTRATE_ID,
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
        substrate_id: SUBSTRATE_ID,
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

  // -- 5. the lock ----------------------------------------------------------

  const lockFile = path.join(outDir, "substrate-lock.json");
  const body = {
    schema_version: "substrate-lock/v1",
    lock_id: "otel-demo-minimal-subset",
    substrate_id: SUBSTRATE_ID,
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
  writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`\nqualified: ${path.relative(repoRoot, lockFile)}`);
  console.log(`   core_hash ${lock.core_hash}`);
  console.log(`   signer    ${lock.signature.key_id} (repository development key; NOT an independent authority)`);
}

function repositoryOf(serviceId) {
  return SERVICES.find((service) => service.serviceId === serviceId).repository;
}

// Last, not first: the module-scope `const`s above are in their temporal dead zone
// until their own declarations are evaluated, so a `main()` call placed before them
// reaches `EXPECTED` before it exists. Entering here means every declaration this
// script needs is already initialised.
try {
  main();
} finally {
  cleanScratch();
}
