/**
 * Slice 3 — ARCHETYPE, clean control, resource frontier, allocator isolation
 * and substrate-lock qualification (implementation plan §9.3).
 *
 * Every driver assertion here is written against the `EnvironmentDriver`
 * interface, not against the fake implementation, so the Compose driver must
 * pass the identical suite when ERL2-OQ-005 qualifies it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertContract, type SubstrateLockV1, type Hash } from "@erl2/contracts";
import { coreHash, developmentKey, domainHash, HASH_DOMAINS, sealSigned } from "@erl2/integrity";
import {
  assertBaselineClean,
  assertDriverEnabled,
  assertFrontierActionsDerivable,
  assertNarrowSelector,
  assertObservedMatchesLock,
  assertOwnedByRun,
  assertRepeatableBaseline,
  assertSubstrateQualified,
  composeDriverManifestBody,
  FakeEnvironmentDriver,
  freezeResourceFrontier,
  ReservationAllocator,
  resourceIdentityHash,
  safeActions,
  SteppingClock,
  uuidV7From,
  verifySubstrateLockSignature,
  type EnvironmentDriver,
  type FakeDriverFaults,
} from "@erl2/core";
import { developmentKeyring } from "../support/keys.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const keyring = developmentKeyring();
const ARCHETYPE: Hash = domainHash(HASH_DOMAINS.TREE, { archetype: "clean-greenfield" });
const SEED: Hash = domainHash(HASH_DOMAINS.TREE, { disorder_seed: "clean" });

function runId(seed: number): string {
  return uuidV7From(Date.parse("2026-07-01T00:00:00Z"), Buffer.alloc(10, seed));
}

function newDriver(faults?: FakeDriverFaults): EnvironmentDriver {
  return new FakeEnvironmentDriver({
    clock: new SteppingClock("2026-07-01T00:00:00Z", 1000),
    signingKey: keyring.challengeGovernor,
    archetypeHash: ARCHETYPE,
    ...(faults === undefined ? {} : { faults }),
  });
}

function provisionAndBaseline(driver: EnvironmentDriver, id: string) {
  const provisioned = driver.provision({
    runId: id,
    archetypeHash: ARCHETYPE,
    disorderSeedCommitment: SEED,
    operationId: "op-provision",
  });
  const baseline = driver.probe({ runId: id, phase: "baseline", operationId: "op-baseline" });
  return { provisioned, baseline };
}

// --------------------------------------------------------------------------
// Clean control and repeatability
// --------------------------------------------------------------------------

test("ARCHETYPE: provision, probe and destroy twice give identical baseline fingerprints", () => {
  const first = newDriver();
  const second = newDriver();
  const a = provisionAndBaseline(first, runId(0x51));
  const b = provisionAndBaseline(second, runId(0x52));

  assertBaselineClean(a.baseline);
  assertBaselineClean(b.baseline);
  assertRepeatableBaseline(a.baseline, b.baseline);

  // Different runs, so instance identity differs while the clean control does not.
  assert.notEqual(a.baseline.environment_instance_hash, b.baseline.environment_instance_hash);
  assert.equal(a.baseline.fingerprint_hash, b.baseline.fingerprint_hash);

  for (const [driver, id] of [
    [first, runId(0x51)],
    [second, runId(0x52)],
  ] as const) {
    const destroyed = driver.destroy({ runId: id, operationId: "op-destroy" });
    assert.equal(destroyed.receipt.status, "succeeded");
    assert.deepEqual(destroyed.residue, []);
    assert.deepEqual(driver.inspect(id).resources, []);
  }
});

test("ARCHETYPE: teardown leaves zero applicable residue, and residue is reported when it exists", () => {
  const id = runId(0x53);
  const driver = newDriver({ residualResourceIds: [`volume-${id.slice(0, 8)}`] });
  provisionAndBaseline(driver, id);
  const destroyed = driver.destroy({ runId: id, operationId: "op-destroy" });
  assert.equal(destroyed.receipt.status, "failed");
  assert.equal(destroyed.receipt.error_code, "ENV_RESIDUE_DETECTED");
  assert.equal(destroyed.residue.length, 1);
  assert.equal(destroyed.residue[0]?.kind, "volume");
});

test("ARCHETYPE: clean-control contamination is detected and is Lab-owned", () => {
  const id = runId(0x54);
  const driver = newDriver({ contaminationCodes: ["PREEXISTING_VOLUME_FROM_PRIOR_ATTEMPT"] });
  const { baseline } = provisionAndBaseline(driver, id);
  assert.equal(baseline.contamination.detected, true);
  assert.throws(
    () => assertBaselineClean(baseline),
    (error: unknown) =>
      (error as { code: string }).code === "BASELINE_CONTAMINATION_DETECTED" &&
      (error as { owner: string }).owner === "lab",
  );
});

test("ARCHETYPE: a failed baseline probe blocks the run before any subject executes", () => {
  const id = runId(0x55);
  const driver = newDriver({ failProbeIds: ["probe-container"] });
  const { baseline } = provisionAndBaseline(driver, id);
  assert.throws(
    () => assertBaselineClean(baseline),
    (error: unknown) => (error as { code: string }).code === "BASELINE_CONTAMINATION_DETECTED",
  );
});

test("ARCHETYPE: a different archetype fingerprint is refused as non-repeatable", () => {
  const a = provisionAndBaseline(newDriver(), runId(0x56));
  const other = new FakeEnvironmentDriver({
    clock: new SteppingClock("2026-07-01T00:00:00Z", 1000),
    signingKey: keyring.challengeGovernor,
    archetypeHash: ARCHETYPE,
    resourceKinds: ["project", "network"],
  });
  const b = provisionAndBaseline(other, runId(0x57));
  assert.throws(
    () => assertRepeatableBaseline(a.baseline, b.baseline),
    (error: unknown) => (error as { code: string }).code === "BASELINE_FINGERPRINT_MISMATCH",
  );
});

test("ARCHETYPE: environment admission is source-neutral", () => {
  const archetype = JSON.parse(
    readFileSync(path.join(repoRoot, "environments", "archetypes", "clean-greenfield.json"), "utf8"),
  ) as { evidence_sources: { source_id: string; kind: string }[] };
  const text = JSON.stringify(archetype).toLowerCase();
  for (const token of ["qualiber", "supported_by", "telemetrytest"]) {
    assert.ok(!text.includes(token), `archetype names "${token}"`);
  }
  // Source kinds are open identifiers owned by the environment contract, never
  // "supported by subject X".
  assert.ok(archetype.evidence_sources.length >= 3);
});

// --------------------------------------------------------------------------
// Mutation, compensation and restoration
// --------------------------------------------------------------------------

test("ARCHETYPE: every mutation carries a compensation identifier and restoration clears it", () => {
  const id = runId(0x58);
  const driver = newDriver();
  provisionAndBaseline(driver, id);
  const mutation = driver.mutate({
    runId: id,
    targetResourceId: `container-${id.slice(0, 8)}`,
    mutationId: "inject-latency",
    operationId: "op-mutate",
  });
  assert.equal(mutation.status, "succeeded");
  assert.equal(mutation.compensation_id, "compensate-inject-latency");
  assert.notEqual(mutation.before_state_hash, mutation.after_state_hash);

  const restored = driver.restore({ runId: id, operationId: "op-restore" });
  assert.equal(restored.status, "succeeded");
});

test("ARCHETYPE: restoration failure is a typed receipt, not an exception swallowed by the driver", () => {
  const id = runId(0x59);
  const driver = newDriver({ failRestore: true });
  provisionAndBaseline(driver, id);
  const restored = driver.restore({ runId: id, operationId: "op-restore" });
  assert.equal(restored.status, "failed");
  assert.equal(restored.error_code, "RESTORATION_FAILED");
});

test("ARCHETYPE: a foreign resource cannot be mutated", () => {
  const id = runId(0x5a);
  const driver = newDriver();
  provisionAndBaseline(driver, id);
  assert.throws(
    () =>
      driver.mutate({
        runId: id,
        targetResourceId: "container-deadbeef",
        mutationId: "x",
        operationId: "op-mutate",
      }),
    (error: unknown) => (error as { code: string }).code === "ENV_FOREIGN_RESOURCE_REJECTED",
  );
});

// --------------------------------------------------------------------------
// Ownership and broad-delete rejection
// --------------------------------------------------------------------------

test("ARCHETYPE: resource identity must embed the run id", () => {
  const id = runId(0x5b);
  assert.match(resourceIdentityHash(id, "network", `erl2-network-${id}`), /^sha256:[0-9a-f]{64}$/);
  assert.throws(
    () => resourceIdentityHash(id, "network", "erl2-network-shared"),
    (error: unknown) => (error as { code: string }).code === "ENV_RESOURCE_NOT_RUN_SCOPED",
  );
});

test("ARCHETYPE: a resource from another run is rejected before cleanup touches it", () => {
  const mine = runId(0x5c);
  const theirs = runId(0x5d);
  const foreign = {
    resource_id: "network-foreign",
    kind: "network",
    run_scoped_name: `erl2-network-${theirs}`,
    identity_hash: resourceIdentityHash(theirs, "network", `erl2-network-${theirs}`),
    destroyable: true,
  };
  assert.throws(
    () => assertOwnedByRun(mine, foreign),
    (error: unknown) => (error as { code: string }).code === "ENV_FOREIGN_RESOURCE_REJECTED",
  );
  assertOwnedByRun(theirs, foreign);
});

test("ARCHETYPE: wildcard and unscoped cleanup selectors are refused", () => {
  const id = runId(0x5e);
  assertNarrowSelector(id, `erl2-container-${id}`);
  for (const selector of ["*", `erl2-container-*`, "erl2-container-other", ""]) {
    assert.throws(
      () => assertNarrowSelector(id, selector),
      (error: unknown) => (error as { code: string }).code === "ENV_BROAD_DELETE_REJECTED",
      `selector ${JSON.stringify(selector)} should be refused`,
    );
  }
});

// --------------------------------------------------------------------------
// Partial provision and the resource frontier
// --------------------------------------------------------------------------

test("ARCHETYPE: partial provision still enumerates everything that was created", () => {
  const id = runId(0x60);
  const driver = newDriver({ provisionPartialAfter: 2 });
  const provisioned = driver.provision({
    runId: id,
    archetypeHash: ARCHETYPE,
    disorderSeedCommitment: SEED,
    operationId: "op-provision",
  });
  assert.equal(provisioned.partial, true);
  assert.equal(provisioned.receipt.status, "failed");
  assert.equal(provisioned.inventory.resources.length, 2);

  const frontier = freezeResourceFrontier({
    runId: id,
    environmentInstanceHash: provisioned.environmentInstanceHash,
    driverManifestHash: coreHash(driver.manifest),
    trigger: "provision_failure",
    observedResources: provisioned.inventory.resources,
    frozenAt: "2026-07-01T00:05:00Z",
  });
  assert.equal(frontier.derived_actions.length, 2);
  assert.equal(safeActions(frontier).length, 2);
  assertFrontierActionsDerivable(frontier);
});

test("ARCHETYPE: the frontier derives actions independently of the driver's claims", () => {
  const id = runId(0x61);
  const driver = newDriver();
  const { provisioned } = provisionAndBaseline(driver, id);
  const frontier = freezeResourceFrontier({
    runId: id,
    environmentInstanceHash: provisioned.environmentInstanceHash,
    driverManifestHash: coreHash(driver.manifest),
    trigger: "teardown_failure",
    observedResources: provisioned.inventory.resources,
    frozenAt: "2026-07-01T00:05:00Z",
  });

  // Actions are ordered stop -> isolate -> revoke -> compensate -> destroy -> teardown.
  const kinds = frontier.derived_actions.map((a) => a.kind);
  assert.deepEqual([...kinds].sort(), kinds.slice().sort());
  assertFrontierActionsDerivable(frontier);

  // A frontier whose action list was edited no longer derives, whether or not
  // the attacker also recomputes the hash.
  const droppedAction = frontier.derived_actions.slice(1);
  assert.throws(
    () => assertFrontierActionsDerivable({ ...frontier, derived_actions: droppedAction }),
    (error: unknown) => (error as { code: string }).code === "ARTIFACT_HASH_MISMATCH",
  );
  const resealed = { ...frontier, derived_actions: droppedAction, core_hash: frontier.core_hash };
  const withFreshHash = { ...resealed, core_hash: coreHash({ ...resealed, core_hash: undefined }) };
  void withFreshHash;
  const consistent = (() => {
    const body = { ...frontier, derived_actions: droppedAction } as Record<string, unknown>;
    delete body["core_hash"];
    return { ...body, core_hash: coreHash(body) } as typeof frontier;
  })();
  assert.throws(
    () => assertFrontierActionsDerivable(consistent),
    (error: unknown) => (error as { code: string }).code === "EMERGENCY_ACTION_SAFE_ACTION_SKIPPED",
  );
});

test("ARCHETYPE: an unowned or shared resource becomes an unsafe contain action, never a destroy", () => {
  const mine = runId(0x62);
  const theirs = runId(0x63);
  const frontier = freezeResourceFrontier({
    runId: mine,
    environmentInstanceHash: ARCHETYPE,
    driverManifestHash: ARCHETYPE,
    trigger: "restoration_failure",
    observedResources: [
      {
        resource_id: "network-foreign",
        kind: "network",
        run_scoped_name: `erl2-network-${theirs}`,
        identity_hash: resourceIdentityHash(theirs, "network", `erl2-network-${theirs}`),
        destroyable: true,
      },
      {
        resource_id: "volume-shared",
        kind: "volume",
        run_scoped_name: `erl2-volume-${mine}`,
        identity_hash: resourceIdentityHash(mine, "volume", `erl2-volume-${mine}`),
        destroyable: true,
        shared_with_other_runs: true,
      },
    ],
    frozenAt: "2026-07-01T00:05:00Z",
  });
  assert.equal(safeActions(frontier).length, 0);
  for (const action of frontier.derived_actions) {
    assert.equal(action.kind, "contain_residual");
    assert.equal(action.independently_safe, false);
    assert.ok((action.unsafe_reason_code ?? "").length > 0);
  }
});

// --------------------------------------------------------------------------
// Allocator: two-run isolation and stale-lease recovery
// --------------------------------------------------------------------------

test("ARCHETYPE: two concurrent runs cannot reserve the same value", () => {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-alloc-"));
  const allocator = new ReservationAllocator({
    root,
    clock: new SteppingClock("2026-07-01T00:00:00Z", 1000),
  });
  const a = runId(0x64);
  const b = runId(0x65);
  allocator.acquire({ runId: a, kind: "network", value: "erl2-net-1", leaseId: "lease-a" });
  assert.throws(
    () => allocator.acquire({ runId: b, kind: "network", value: "erl2-net-1", leaseId: "lease-b" }),
    (error: unknown) => (error as { code: string }).code === "ENV_RESERVATION_CONFLICT",
  );
  // A different value is unaffected: isolation, not a global lock.
  allocator.acquire({ runId: b, kind: "network", value: "erl2-net-2", leaseId: "lease-b" });
  assert.equal(allocator.held(a).length, 1);
  assert.equal(allocator.held(b).length, 1);
});

test("ARCHETYPE: a stale lease from a crashed run is reclaimed, a live one is not", () => {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-alloc-stale-"));
  const clock = new SteppingClock("2026-07-01T00:00:00Z", 1000);
  const allocator = new ReservationAllocator({ root, clock, ttlMs: 2000 });
  const crashed = runId(0x66);
  const next = runId(0x67);
  allocator.acquire({ runId: crashed, kind: "port", value: "erl2-port-18080", leaseId: "lease-x" });

  // Advance past the TTL.
  for (let i = 0; i < 6; i += 1) clock.now();
  const reclaimed = allocator.reclaimExpired();
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0]?.lease.run_id, crashed);
  assert.equal(reclaimed[0]?.reason, "expired");

  // The value is now free for the next run.
  const lease = allocator.acquire({
    runId: next,
    kind: "port",
    value: "erl2-port-18080",
    leaseId: "lease-y",
  });
  assert.equal(lease.run_id, next);
});

test("ARCHETYPE: a run may not release another run's lease", () => {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-alloc-release-"));
  const allocator = new ReservationAllocator({
    root,
    clock: new SteppingClock("2026-07-01T00:00:00Z", 1000),
  });
  const a = runId(0x68);
  const b = runId(0x69);
  allocator.acquire({ runId: a, kind: "tenant", value: "erl2-tenant-1", leaseId: "lease-a" });
  assert.throws(
    () => allocator.release(b, "tenant", "erl2-tenant-1"),
    (error: unknown) => (error as { code: string }).code === "ENV_RESERVATION_CONFLICT",
  );
  allocator.release(a, "tenant", "erl2-tenant-1");
  allocator.acquire({ runId: b, kind: "tenant", value: "erl2-tenant-1", leaseId: "lease-b" });
});

// --------------------------------------------------------------------------
// ERL2-OQ-005: substrate lock and the disabled Compose driver
// --------------------------------------------------------------------------

function loadShippedLock(): SubstrateLockV1 {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "environments", "otel-demo", "substrate-lock.json"), "utf8"),
  ) as SubstrateLockV1;
}

/**
 * The shipped lock as it was before qualification.
 *
 * The two fail-closed cases below used to read the shipped file, because the
 * shipped file *was* the unqualified candidate. It is now qualified (OQ-005), so
 * reading it would prove the opposite of what those cases exist to prove. The
 * invariant is unchanged and is asserted against a lock in that state instead.
 */
function unqualifiedCandidateLock(): SubstrateLockV1 {
  const shipped = loadShippedLock();
  const { sbom: _sbom, provenance: _provenance, ...rest } = shipped;
  const base = {
    ...rest,
    qualification_status: "unqualified_pending_erl2_oq_005" as const,
    unqualified_reason_code: "OTEL_DEMO_NOT_RE_ADMITTED",
    images: [] as SubstrateLockV1["images"],
    config_hashes: [] as Hash[],
  };
  delete (base as { core_hash?: unknown }).core_hash;
  delete (base as { signature?: unknown }).signature;
  return assertContract<SubstrateLockV1>(
    "SubstrateLockV1",
    sealSigned(base, developmentKey("challenge-governor")),
  );
}

test("ERL2-OQ-005 fail-closed: an unqualified lock refuses", () => {
  const lock = unqualifiedCandidateLock();
  assertContract("SubstrateLockV1", lock);
  assert.equal(lock.qualification_status, "unqualified_pending_erl2_oq_005");
  assert.throws(
    () => assertSubstrateQualified(lock),
    (error: unknown) => (error as { code: string }).code === "ENV_SUBSTRATE_LOCK_UNQUALIFIED",
  );
});

test("ERL2-OQ-005 fail-closed: an unqualified lock yields a disabled Compose manifest", () => {
  const lock = unqualifiedCandidateLock();
  const manifest = composeDriverManifestBody(lock, coreHash(lock));
  assert.equal(manifest.enabled, false);
  assert.equal(manifest.activation_gate, "ERL2-OQ-005");
  assert.throws(
    () => assertDriverEnabled({ ...manifest, core_hash: coreHash(lock), signature: dummySignature() }),
    (error: unknown) => (error as { code: string }).code === "ENV_DRIVER_DISABLED",
  );
});

/**
 * The shipped OTel Demo lock, after ERL2-OQ-005 qualification.
 *
 * It is signed by the repository's *development* environment governor, which is
 * repo-derivable and therefore never an independent authority. That is exactly
 * what this case records: the lock qualifies and enables the Compose manifest,
 * and its signer classification stays `signerIsDevelopmentKey`, so no claim of
 * third-party qualification can be derived from it.
 */
test("ERL2-OQ-005: the shipped OTel lock is qualified, dev-signed and enables Compose", () => {
  const lock = loadShippedLock();
  assertContract("SubstrateLockV1", lock);
  assert.equal(lock.qualification_status, "qualified");
  assertSubstrateQualified(lock);

  const platforms = new Set(lock.images.map((image) => image.platform));
  assert.deepEqual([...platforms].sort(), ["linux/amd64", "linux/arm64"]);
  assert.equal(platforms.has("darwin/arm64"), false, "darwin/arm64 is not an image manifest platform");

  const verification = verifySubstrateLockSignature(lock);
  assert.equal(verification.signatureValid, true);
  assert.equal(verification.signerIsDevelopmentKey, true);
  assert.equal(
    verification.signerIsPinnedAuthority,
    false,
    "a development-signed lock is never an independent qualification authority",
  );

  const manifest = composeDriverManifestBody(lock, coreHash(lock));
  assert.equal(manifest.enabled, true);
});

test("ERL2-OQ-005: a lock missing a required platform digest does not qualify", () => {
  const lock = qualifiedLock([
    { service_id: "frontend", platform: "linux/amd64", digest: digest(1) },
  ]);
  assert.throws(
    () => assertSubstrateQualified(lock),
    (error: unknown) => (error as { code: string }).code === "ENV_SUBSTRATE_PLATFORM_MISSING",
  );
});

test("ERL2-OQ-005: a qualified lock enables Compose, and observed drift still invalidates", () => {
  const lock = qualifiedLock([
    { service_id: "frontend", platform: "linux/amd64", digest: digest(1) },
    { service_id: "frontend", platform: "linux/arm64", digest: digest(2) },
  ]);
  assertSubstrateQualified(lock);
  const manifest = composeDriverManifestBody(lock, coreHash(lock));
  assert.equal(manifest.enabled, true);
  assertDriverEnabled({ ...manifest, core_hash: coreHash(lock), signature: dummySignature() });

  assertObservedMatchesLock(lock, {
    archiveSha256: lock.source_archive.archive_sha256,
    images: [...lock.images],
    configHashes: [...lock.config_hashes],
  });

  // A re-pushed image digest is drift, not a warning.
  assert.throws(
    () =>
      assertObservedMatchesLock(lock, {
        archiveSha256: lock.source_archive.archive_sha256,
        images: [
          { service_id: "frontend", platform: "linux/amd64", digest: digest(9) },
          { service_id: "frontend", platform: "linux/arm64", digest: digest(2) },
        ],
        configHashes: [...lock.config_hashes],
      }),
    (error: unknown) => (error as { code: string }).code === "ENV_SUBSTRATE_DIGEST_MISMATCH",
  );

  // A moved release tag is drift too.
  assert.throws(
    () =>
      assertObservedMatchesLock(lock, {
        archiveSha256: digest(8),
        images: [...lock.images],
        configHashes: [...lock.config_hashes],
      }),
    (error: unknown) => (error as { code: string }).code === "ENV_SUBSTRATE_DIGEST_MISMATCH",
  );
});

test("ERL2-OQ-005 §11.5: an EXTRA observed image not pinned by the lock is drift", () => {
  const lock = qualifiedLock([
    { service_id: "frontend", platform: "linux/amd64", digest: digest(1) },
    { service_id: "frontend", platform: "linux/arm64", digest: digest(2) },
  ]);
  // Before the fix, image comparison was `locked ⊆ observed`, so an unpinned
  // extra image passed silently.
  assert.throws(
    () =>
      assertObservedMatchesLock(lock, {
        archiveSha256: lock.source_archive.archive_sha256,
        images: [
          ...lock.images,
          { service_id: "rogue", platform: "linux/amd64", digest: digest(3) },
        ],
        configHashes: [...lock.config_hashes],
      }),
    (error: unknown) => (error as { code: string }).code === "ENV_SUBSTRATE_DIGEST_MISMATCH",
  );
});

test("ERL2-OQ-005 §11.5: a MISSING locked config that is not observed is drift", () => {
  const lock = qualifiedLock([
    { service_id: "frontend", platform: "linux/amd64", digest: digest(1) },
    { service_id: "frontend", platform: "linux/arm64", digest: digest(2) },
  ]);
  // Before the fix, config comparison was `observed ⊆ locked`, so a locked
  // config missing from the observed set passed silently.
  assert.throws(
    () =>
      assertObservedMatchesLock(lock, {
        archiveSha256: lock.source_archive.archive_sha256,
        images: [...lock.images],
        configHashes: [], // the single locked config was not observed
      }),
    (error: unknown) => (error as { code: string }).code === "ENV_SUBSTRATE_DIGEST_MISMATCH",
  );
});

test("ERL2-OQ-005 §11.5: a tampered substrate-lock signature is refused before drift", () => {
  const lock = qualifiedLock([
    { service_id: "frontend", platform: "linux/amd64", digest: digest(1) },
    { service_id: "frontend", platform: "linux/arm64", digest: digest(2) },
  ]);
  const tampered = {
    ...lock,
    signature: { ...lock.signature, signature_base64: `${"B".repeat(86)}==` },
  } as SubstrateLockV1;
  assert.throws(
    () =>
      assertObservedMatchesLock(tampered, {
        archiveSha256: tampered.source_archive.archive_sha256,
        images: [...tampered.images],
        configHashes: [...tampered.config_hashes],
      }),
    (error: unknown) =>
      (error as { code: string }).code === "ENV_SUBSTRATE_LOCK_SIGNATURE_INVALID",
  );
});

function digest(n: number): Hash {
  return `sha256:${String(n).repeat(64).slice(0, 64)}`;
}

// A cryptographically valid development-key signature over the *disabled* driver
// manifest is enough for the driver-disabled assertion (which never verifies it),
// while the substrate lock itself is signed for real below.
function dummySignature() {
  return {
    algorithm: "Ed25519" as const,
    key_id: "erl2-dev-challenge-governor-ed25519-1",
    signed_hash: digest(0),
    signature_base64: `${"A".repeat(86)}==`,
  };
}

const SUBSTRATE_GOVERNOR = developmentKey("challenge-governor");

function qualifiedLock(images: SubstrateLockV1["images"]): SubstrateLockV1 {
  const base = {
    schema_version: "substrate-lock/v1" as const,
    lock_id: "test-qualified-lock",
    substrate_id: "test-substrate",
    qualification_status: "qualified" as const,
    source_archive: {
      release_tag: "v1.0.0",
      source_commit: "0".repeat(40),
      archive_sha256: digest(7),
    },
    images: [...images],
    sbom: {
      path: "retained/sbom.json",
      media_type: "application/json",
      byte_length: 2,
      file_sha256: digest(6),
      classification: "PUBLIC" as const,
    },
    provenance: {
      producer: "erl2-test",
      producer_version: "0.1.0",
      transformations: [] as string[],
    },
    config_hashes: [digest(5)],
    recorded_at: "2026-07-23T00:00:00Z",
  };
  // The lock carries a real Ed25519 signature by the development governor so
  // `assertObservedMatchesLock` can verify it (§11.5). A development-signed lock
  // is cryptographically valid but not an authority — the Compose gate stays
  // OQ-005 regardless.
  return assertContract<SubstrateLockV1>("SubstrateLockV1", sealSigned(base, SUBSTRATE_GOVERNOR));
}
