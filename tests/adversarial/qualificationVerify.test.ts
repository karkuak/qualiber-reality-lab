/**
 * The qualification verifier's comparison (ERL2-OQ-005).
 *
 * `scripts/qualify-otel-demo.mjs --verify` cannot be tested here — it needs a
 * release archive, a registry and Docker Scout. Its *decision* can be, and that is
 * the part that was wrong: the old verifier compared four things (archive digest,
 * source commit, image list, config hashes) and rewrote six tracked files on the
 * way to comparing them.
 *
 * So the comparison lives in `scripts/lib/qualificationVerify.mjs` as pure
 * functions over already-read values, and these cases drive every branch with no
 * network at all. Each one starts from a retained set that verifies clean and
 * breaks exactly one thing, because a check that only fires when several things are
 * wrong at once is not a check.
 *
 * The read-only property itself is not provable from here; it is proven by hashing
 * the tracked tree either side of a real `--verify`, which the corrective
 * package's validation sequence does.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const { qualificationDrift, missingSbomSlots } = (await import(
  pathToFileURL(path.join(repoRoot, "scripts", "lib", "qualificationVerify.mjs")).href
)) as {
  qualificationDrift: (input: unknown) => readonly string[];
  missingSbomSlots: (
    documents: readonly { service_id: string; platform: string }[],
    serviceIds: readonly string[],
    platforms: readonly string[],
  ) => readonly string[];
};

const SERVICE_IDS = ["otel-collector", "quote"];
const PLATFORMS = ["linux/amd64", "linux/arm64"];
const ARCHIVE = `sha256:${"1".repeat(64)}`;
const COMMIT = "a".repeat(40);
const ARCHIVE_URL = "https://codeload.github.com/open-telemetry/opentelemetry-demo/tar.gz/refs/tags/3.0.0";
const SBOM_INDEX_PATH = "environments/otel-demo/qualification/sbom.json";

function digestFor(serviceId: string, platform: string): string {
  return `sha256:${Buffer.from(`${serviceId}|${platform}`)
    .toString("hex")
    .padEnd(64, "0")
    .slice(0, 64)}`;
}

const IMAGES = SERVICE_IDS.flatMap((service_id) =>
  PLATFORMS.map((platform) => ({ service_id, platform, digest: digestFor(service_id, platform) })),
);

const CONFIG_HASHES = [1, 2, 3, 4, 5].map((n) => `sha256:${String(n).repeat(64)}`);

function spdxPath(serviceId: string, platform: string): string {
  return `environments/otel-demo/qualification/sbom-${serviceId}-${platform.replace("/", "-")}.spdx.json`;
}

function spdxSha(serviceId: string, platform: string): string {
  return `sha256:${Buffer.from(`spdx|${serviceId}|${platform}`).toString("hex").padEnd(64, "7").slice(0, 64)}`;
}

/** The retained set as it stands when everything agrees. */
function clean(): Record<string, unknown> {
  const documents = IMAGES.map((image) => ({
    service_id: image.service_id,
    platform: image.platform,
    image_digest: image.digest,
    package_count: 11,
    spdx_file: spdxPath(image.service_id, image.platform),
    spdx_file_sha256: spdxSha(image.service_id, image.platform),
  }));
  return {
    lock: {
      schema_version: "substrate-lock/v1",
      substrate_id: "opentelemetry-demo",
      qualification_status: "qualified",
      source_archive: { release_tag: "3.0.0", source_commit: COMMIT, archive_sha256: ARCHIVE },
      images: IMAGES.map((image) => ({ ...image })),
      sbom: {
        path: SBOM_INDEX_PATH,
        media_type: "application/json",
        byte_length: 1812,
        file_sha256: `sha256:${"c".repeat(64)}`,
        classification: "PUBLIC",
      },
      provenance: { source_uri: ARCHIVE_URL, source_commit: COMMIT },
      config_hashes: [...CONFIG_HASHES],
      core_hash: `sha256:${"d".repeat(64)}`,
    },
    lockCoreHash: `sha256:${"d".repeat(64)}`,
    signature: { signatureValid: true, signerKeyId: "erl2-dev-challenge-governor-ed25519-1", signerIsDevelopmentKey: true, signerIsPinnedAuthority: false },
    observed: {
      archiveSha256: ARCHIVE,
      sourceCommit: COMMIT,
      images: IMAGES.map((image) => ({ ...image })),
      configHashes: [...CONFIG_HASHES],
    },
    retained: {
      sbomIndex: {
        substrate_id: "opentelemetry-demo",
        release_tag: "3.0.0",
        source_commit: COMMIT,
        generated_by: "docker scout sbom --format spdx",
        documents,
      },
      sbomIndexByteLength: 1812,
      sbomIndexSha256: `sha256:${"c".repeat(64)}`,
      spdx: Object.fromEntries(
        IMAGES.map((image) => [
          spdxPath(image.service_id, image.platform),
          { present: true, sha256: spdxSha(image.service_id, image.platform), packageCount: 11 },
        ]),
      ),
      provenance: {
        substrate_id: "opentelemetry-demo",
        release_tag: "3.0.0",
        source_commit: COMMIT,
        archive_url: ARCHIVE_URL,
        archive_sha256: ARCHIVE,
        independently_authenticated: false,
        images: IMAGES.map((image) => ({
          service_id: image.service_id,
          platform: image.platform,
          image_digest: image.digest,
        })),
      },
    },
    expected: {
      substrateId: "opentelemetry-demo",
      releaseTag: "3.0.0",
      archiveUrl: ARCHIVE_URL,
      requiredPlatforms: PLATFORMS,
      serviceIds: SERVICE_IDS,
      configFileCount: 5,
      sbomIndexPath: SBOM_INDEX_PATH,
    },
  };
}

/** Breaks exactly one thing and returns the drift the verifier reports. */
function driftAfter(mutate: (input: Record<string, any>) => void): readonly string[] {
  const input = clean();
  mutate(input);
  return qualificationDrift(input);
}

function assertDrifts(mutate: (input: Record<string, any>) => void, expected: string): void {
  const drift = driftAfter(mutate);
  assert.ok(drift.length > 0, "the verifier reported no drift");
  assert.ok(
    drift.some((entry) => entry.includes(expected)),
    `drift did not mention ${expected}: ${drift.join(" | ")}`,
  );
}

test("QUALIFY-VERIFY: a retained set that agrees with the observation reports no drift", () => {
  assert.deepEqual(qualificationDrift(clean()), []);
});

// -- the lock has to hold together -------------------------------------------

test("QUALIFY-VERIFY: a lock whose recorded core hash is not its own is drift", () => {
  assertDrifts((input) => {
    input["lockCoreHash"] = `sha256:${"0".repeat(64)}`;
  }, "core hash");
});

test("QUALIFY-VERIFY: a lock whose signature does not verify is drift", () => {
  assertDrifts((input) => {
    input["signature"] = { signatureValid: false, reason: "SUBSTRATE_LOCK_SIGNATURE_INVALID" };
  }, "signature");
});

test("QUALIFY-VERIFY: a lock that no longer says qualified is drift", () => {
  assertDrifts((input) => {
    input["lock"].qualification_status = "unqualified_pending_erl2_oq_005";
  }, "qualification status");
});

// -- the inputs ---------------------------------------------------------------

test("QUALIFY-VERIFY: a moved archive is drift", () => {
  assertDrifts((input) => {
    input["observed"].archiveSha256 = `sha256:${"9".repeat(64)}`;
  }, "archive sha256");
});

test("QUALIFY-VERIFY: a different source commit is drift", () => {
  assertDrifts((input) => {
    input["observed"].sourceCommit = "b".repeat(40);
  }, "source commit");
});

test("QUALIFY-VERIFY: a re-pushed image digest is drift", () => {
  assertDrifts((input) => {
    input["observed"].images[0].digest = `sha256:${"8".repeat(64)}`;
  }, "image matrix");
});

test("QUALIFY-VERIFY: a lock missing one platform is drift", () => {
  assertDrifts((input) => {
    input["lock"].images = input["lock"].images.filter((i: { platform: string }) => i.platform !== "linux/amd64");
  }, "no retained image for");
});

test("QUALIFY-VERIFY: an observed image the lock does not pin is drift", () => {
  assertDrifts((input) => {
    input["observed"].images.push({ service_id: "frontend", platform: "linux/amd64", digest: ARCHIVE });
  }, "is not retained");
});

test("QUALIFY-VERIFY: a duplicated image slot is drift", () => {
  assertDrifts((input) => {
    input["lock"].images.push({ ...input["lock"].images[0] });
  }, "duplicate slot");
});

test("QUALIFY-VERIFY: a changed configuration hash is drift", () => {
  assertDrifts((input) => {
    input["observed"].configHashes[4] = `sha256:${"7".repeat(64)}`;
  }, "config hashes");
});

test("QUALIFY-VERIFY: fewer than the five applied configuration files is drift", () => {
  assertDrifts((input) => {
    input["observed"].configHashes = input["observed"].configHashes.slice(0, 4);
    input["lock"].config_hashes = input["lock"].config_hashes.slice(0, 4);
  }, "distinct config hashes");
});

// -- the retained outputs, and their binding ---------------------------------

test("QUALIFY-VERIFY: an SBOM index whose bytes no longer hash to the lock's record is drift", () => {
  assertDrifts((input) => {
    input["retained"].sbomIndexSha256 = `sha256:${"6".repeat(64)}`;
  }, "lock sbom file sha256");
});

test("QUALIFY-VERIFY: an SBOM index whose size no longer matches the lock's record is drift", () => {
  assertDrifts((input) => {
    input["retained"].sbomIndexByteLength = 1813;
  }, "lock sbom byte length");
});

test("QUALIFY-VERIFY: a missing SBOM index is drift", () => {
  assertDrifts((input) => {
    input["retained"].sbomIndex = null;
  }, "SBOM index is missing");
});

test("QUALIFY-VERIFY: an SBOM index describing three of the four slots is drift", () => {
  // The reproduced defect's other half: `docker scout` failing for one platform
  // used to be a logged line, so the lock pinned four images and the SBOM
  // described three.
  const drift = driftAfter((input) => {
    input["retained"].sbomIndex.documents = input["retained"].sbomIndex.documents.slice(0, 3);
  });
  assert.ok(drift.some((entry) => entry.includes("3 documents, expected 4")), drift.join(" | "));
  assert.ok(drift.some((entry) => entry.includes("sbom document matrix")), drift.join(" | "));
});

test("QUALIFY-VERIFY: an SPDX document that is not on disk is drift", () => {
  assertDrifts((input) => {
    input["retained"].spdx[spdxPath("quote", "linux/arm64")] = { present: false };
  }, "is not present");
});

test("QUALIFY-VERIFY: an SPDX document whose bytes changed is drift", () => {
  assertDrifts((input) => {
    input["retained"].spdx[spdxPath("quote", "linux/arm64")].sha256 = `sha256:${"5".repeat(64)}`;
  }, "spdx file sha256");
});

test("QUALIFY-VERIFY: an SPDX document that does not hold the package count claimed for it is drift", () => {
  // The hash can agree while the index's summary of the document does not, so the
  // count is read back out of the document rather than trusted.
  assertDrifts((input) => {
    input["retained"].spdx[spdxPath("quote", "linux/arm64")].packageCount = 10;
  }, "package count");
});

test("QUALIFY-VERIFY: an SBOM document naming an image digest the registry no longer serves is drift", () => {
  assertDrifts((input) => {
    input["retained"].sbomIndex.documents[0].image_digest = `sha256:${"4".repeat(64)}`;
  }, "sbom document matrix");
});

test("QUALIFY-VERIFY: an SBOM index bound to a different source commit is drift", () => {
  assertDrifts((input) => {
    input["retained"].sbomIndex.source_commit = "c".repeat(40);
  }, "sbom index source commit");
});

test("QUALIFY-VERIFY: a missing provenance record is drift", () => {
  assertDrifts((input) => {
    input["retained"].provenance = null;
  }, "provenance record is missing");
});

test("QUALIFY-VERIFY: a provenance record bound to a different archive is drift", () => {
  assertDrifts((input) => {
    input["retained"].provenance.archive_sha256 = `sha256:${"3".repeat(64)}`;
  }, "provenance archive sha256");
});

test("QUALIFY-VERIFY: a provenance record naming a different archive URL is drift", () => {
  assertDrifts((input) => {
    input["retained"].provenance.archive_url = "https://example.com/demo.tar.gz";
  }, "provenance archive url");
});

test("QUALIFY-VERIFY: provenance claiming independent authentication is drift", () => {
  // This is the limitation the whole claim boundary is written against. A verify
  // that let it flip to `true` unobserved would quietly erase it.
  assertDrifts((input) => {
    input["retained"].provenance.independently_authenticated = true;
  }, "independently_authenticated");
});

test("QUALIFY-VERIFY: a provenance image matrix that disagrees with the registry is drift", () => {
  assertDrifts((input) => {
    input["retained"].provenance.images = input["retained"].provenance.images.slice(0, 2);
  }, "provenance image matrix");
});

test("QUALIFY-VERIFY: a lock whose inline provenance names another source is drift", () => {
  assertDrifts((input) => {
    input["lock"].provenance.source_uri = "https://example.com/demo.tar.gz";
  }, "lock provenance source uri");
});

// -- the generating path's completeness rule ---------------------------------

test("QUALIFY-VERIFY: missingSbomSlots names every uncovered service/platform", () => {
  assert.deepEqual(missingSbomSlots(IMAGES, SERVICE_IDS, PLATFORMS), []);
  assert.deepEqual(
    missingSbomSlots(
      IMAGES.filter((image) => image.platform !== "linux/amd64"),
      SERVICE_IDS,
      PLATFORMS,
    ),
    ["otel-collector linux/amd64", "quote linux/amd64"],
  );
  assert.deepEqual(missingSbomSlots([], SERVICE_IDS, PLATFORMS), [
    "otel-collector linux/amd64",
    "otel-collector linux/arm64",
    "quote linux/amd64",
    "quote linux/arm64",
  ]);
});
