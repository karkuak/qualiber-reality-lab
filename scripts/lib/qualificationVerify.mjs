// The qualification comparison, as pure functions (ERL2-OQ-005).
//
// Split out of `scripts/qualify-otel-demo.mjs` for one reason: the comparison is
// the part worth testing, and the script around it cannot be tested — it fetches a
// release archive, reaches a registry and runs Docker Scout. Everything here takes
// already-read values and returns a list of drifts, so `tests/adversarial/
// qualificationVerify.test.ts` can drive every branch with no network at all.
//
// Nothing here reads a file, runs a process or decides an exit code. It compares.

/** Bijective key for one image slot. */
function imageKey(image) {
  return `${image.service_id} ${image.platform}`;
}

function sortedSet(values) {
  return [...new Set(values)].sort();
}

/**
 * Compares two image matrices exactly and bijectively.
 *
 * Bijective for the same reason `assertObservedMatchesLock` is: an *extra*
 * observed image is drift, not a bonus. Duplicate slots are drift too — a matrix
 * that pins one service/platform twice has two answers to a question that must
 * have one.
 */
function imageMatrixDrift(label, expected, observed, requiredServiceIds, requiredPlatforms) {
  const drift = [];
  const expectedByKey = new Map();
  for (const image of expected) {
    if (expectedByKey.has(imageKey(image))) drift.push(`${label}: duplicate slot ${imageKey(image)}`);
    expectedByKey.set(imageKey(image), image.digest);
  }
  const observedByKey = new Map();
  for (const image of observed) {
    if (observedByKey.has(imageKey(image))) drift.push(`${label}: duplicate observed slot ${imageKey(image)}`);
    observedByKey.set(imageKey(image), image.digest);
  }
  // The complete matrix is required, named explicitly rather than inferred from
  // whatever happened to be present: a lock missing a platform must be drift, not
  // a smaller matrix that agrees with itself.
  for (const serviceId of requiredServiceIds) {
    for (const platform of requiredPlatforms) {
      const key = `${serviceId} ${platform}`;
      if (!expectedByKey.has(key)) drift.push(`${label}: no retained image for ${key}`);
      if (!observedByKey.has(key)) drift.push(`${label}: no observed image for ${key}`);
    }
  }
  for (const [key, digest] of expectedByKey) {
    if (!observedByKey.has(key)) {
      drift.push(`${label}: ${key} is retained but was not observed`);
      continue;
    }
    if (observedByKey.get(key) !== digest) drift.push(`${label}: ${key} digest`);
  }
  for (const key of observedByKey.keys()) {
    if (!expectedByKey.has(key)) drift.push(`${label}: ${key} was observed but is not retained`);
  }
  return drift;
}

/**
 * Every disagreement between the retained qualification and what this host just
 * observed.
 *
 * An empty array is the only success. The checks fall into three groups:
 *
 *   - **the retained lock is internally sound** — its recorded `core_hash` is its
 *     own, its signature verifies, and it still says `qualified`. A lock that does
 *     not hold together cannot be compared against anything;
 *   - **the retained inputs are still what upstream serves** — archive digest,
 *     source commit, release tag, the exact image matrix, the exact configuration
 *     hash set;
 *   - **the retained outputs still bind to those inputs** — the SBOM index hashes
 *     to what the lock records and has the complete four-document matrix, each
 *     SPDX document hashes to what the index records and holds the package count
 *     it claims, and the provenance record names the same archive, commit and
 *     images.
 *
 * The third group is what makes this more than a digest check: it is possible for
 * every input to still be live while the retained SBOM describes a different
 * image, and that is drift the lock's own hash cannot catch.
 */
export function qualificationDrift(input) {
  const drift = [];
  const { lock, lockCoreHash, signature, observed, retained, expected } = input;

  // -- 1. the lock holds together -------------------------------------------
  if (lock.core_hash !== lockCoreHash) drift.push("lock core hash is not the lock's own");
  if (!signature.signatureValid) drift.push(`lock signature (${signature.reason ?? "unknown"})`);
  if (lock.qualification_status !== "qualified") {
    drift.push(`lock qualification status is ${lock.qualification_status}`);
  }
  if (lock.substrate_id !== expected.substrateId) drift.push("lock substrate id");

  // -- 2. the inputs -----------------------------------------------------------
  if (lock.source_archive?.archive_sha256 !== observed.archiveSha256) drift.push("archive sha256");
  if (lock.source_archive?.source_commit !== observed.sourceCommit) drift.push("source commit");
  if (lock.source_archive?.release_tag !== expected.releaseTag) drift.push("release tag");
  drift.push(
    ...imageMatrixDrift(
      "image matrix",
      lock.images ?? [],
      observed.images,
      expected.serviceIds,
      expected.requiredPlatforms,
    ),
  );
  const retainedConfigs = sortedSet(lock.config_hashes ?? []);
  const observedConfigs = sortedSet(observed.configHashes);
  if (observedConfigs.length !== expected.configFileCount) {
    drift.push(`observed ${observedConfigs.length} distinct config hashes, expected ${expected.configFileCount}`);
  }
  if (JSON.stringify(retainedConfigs) !== JSON.stringify(observedConfigs)) drift.push("config hashes");

  // -- 3. the retained outputs, and their binding to the inputs ---------------
  if (lock.sbom?.path !== expected.sbomIndexPath) drift.push("lock sbom path");
  if (lock.sbom?.byte_length !== retained.sbomIndexByteLength) drift.push("lock sbom byte length");
  if (lock.sbom?.file_sha256 !== retained.sbomIndexSha256) drift.push("lock sbom file sha256");

  const index = retained.sbomIndex;
  if (index === undefined || index === null) {
    drift.push("the retained SBOM index is missing");
  } else {
    if (index.substrate_id !== expected.substrateId) drift.push("sbom index substrate id");
    if (index.release_tag !== expected.releaseTag) drift.push("sbom index release tag");
    if (index.source_commit !== observed.sourceCommit) drift.push("sbom index source commit");
    const documents = Array.isArray(index.documents) ? index.documents : [];
    const wanted = expected.serviceIds.length * expected.requiredPlatforms.length;
    if (documents.length !== wanted) {
      drift.push(`the retained SBOM index has ${documents.length} documents, expected ${wanted}`);
    }
    drift.push(
      ...imageMatrixDrift(
        "sbom document matrix",
        documents.map((document) => ({
          service_id: document.service_id,
          platform: document.platform,
          digest: document.image_digest,
        })),
        observed.images,
        expected.serviceIds,
        expected.requiredPlatforms,
      ),
    );
    for (const document of documents) {
      const slot = `${document.service_id} ${document.platform}`;
      const file = retained.spdx?.[document.spdx_file];
      if (file === undefined || file.present !== true) {
        drift.push(`sbom document ${slot}: ${String(document.spdx_file)} is not present`);
        continue;
      }
      if (file.sha256 !== document.spdx_file_sha256) drift.push(`sbom document ${slot}: spdx file sha256`);
      if (file.packageCount !== document.package_count) drift.push(`sbom document ${slot}: package count`);
    }
  }

  const provenance = retained.provenance;
  if (provenance === undefined || provenance === null) {
    drift.push("the retained provenance record is missing");
  } else {
    if (provenance.substrate_id !== expected.substrateId) drift.push("provenance substrate id");
    if (provenance.release_tag !== expected.releaseTag) drift.push("provenance release tag");
    if (provenance.source_commit !== observed.sourceCommit) drift.push("provenance source commit");
    if (provenance.archive_sha256 !== observed.archiveSha256) drift.push("provenance archive sha256");
    if (provenance.archive_url !== expected.archiveUrl) drift.push("provenance archive url");
    // Retained as `false`, and it must stay retained as `false`: this is the
    // limitation the claim boundary is written against, and a verify that let it
    // flip to `true` unobserved would erase it.
    if (provenance.independently_authenticated !== false) {
      drift.push("provenance independently_authenticated is no longer false");
    }
    drift.push(
      ...imageMatrixDrift(
        "provenance image matrix",
        (Array.isArray(provenance.images) ? provenance.images : []).map((image) => ({
          service_id: image.service_id,
          platform: image.platform,
          digest: image.image_digest,
        })),
        observed.images,
        expected.serviceIds,
        expected.requiredPlatforms,
      ),
    );
  }

  // The lock carries its own inline provenance record. `SubstrateLockV1` has no
  // field for a hash of `provenance.json`, so the two are bound by content on the
  // fields they share rather than cryptographically — a limitation this verifier
  // enforces the strongest available form of, and which the environment README
  // records as a limitation rather than glossing.
  if (lock.provenance?.source_commit !== observed.sourceCommit) drift.push("lock provenance source commit");
  if (lock.provenance?.source_uri !== expected.archiveUrl) drift.push("lock provenance source uri");

  return drift;
}

/**
 * The SBOM matrix a qualification must produce, and what is missing from it.
 *
 * Used by the generating path, where a partial result is the real hazard: Docker
 * Scout failing for one platform used to be a logged line and a lock that pinned
 * four images while describing three. A qualification either covers the whole
 * matrix or it is not one.
 */
export function missingSbomSlots(documents, serviceIds, platforms) {
  const present = new Set(documents.map((document) => `${document.service_id} ${document.platform}`));
  const missing = [];
  for (const serviceId of serviceIds) {
    for (const platform of platforms) {
      if (!present.has(`${serviceId} ${platform}`)) missing.push(`${serviceId} ${platform}`);
    }
  }
  return missing;
}
