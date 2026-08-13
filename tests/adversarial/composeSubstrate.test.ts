/**
 * The Compose driver's adversarial matrix (ERL2-OQ-005).
 *
 * Every case here is a way the qualified substrate could be made to lie, and the
 * assertion is always the same shape: the Lab refuses, with a typed code, before
 * anything is attested. They run against the *real* `ComposeEnvironmentDriver`
 * over a stand-in daemon, because the states they need — a foreign object wearing
 * this run's project label, a registry that misreports a platform, a `compose up`
 * that half-succeeds, a compensation that returns `succeeded` and reverts nothing
 * — are not states a real Docker can be asked for.
 *
 * These prove the driver's *logic*. That the driver works against Docker is a
 * different claim, proven only by `tests/e2e/composeEnvironmentRun.test.ts`,
 * which refuses rather than skips when it cannot make it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertContract,
  type AttributableTelemetryObservationV1,
  type Hash,
  type Instant,
  type SubstrateLockV1,
} from "@erl2/contracts";
import { ArtifactStore, coreHash, developmentKey, sealSigned } from "@erl2/integrity";
import {
  assertNarrowSelector,
  assertOwnedByRun,
  ComposeEnvironmentDriver,
  composeProjectName,
  dockerAvailable,
  fileSha256,
  OTEL_DEMO_SERVICES,
  decideTelemetryObservationWindow,
  parseCollectorTelemetry,
  resourceIdentityHash,
  retainAttributableTelemetryObservation,
  SteppingClock,
  TELEMETRY_WINDOW_REASONS,
  uuidV7From,
  type DockerCli,
  type DockerInvocation,
  type DockerResult,
  type MaterializedUpstream,
  type RepositoryConfigPaths,
} from "@erl2/core";
import {
  newStubWorld,
  putStubImage,
  StubDockerCli,
  type StubBehaviour,
  withTelemetry,
  type StubContainer,
  type StubWorld,
} from "../support/composeStub.js";
import { ownedTempDir } from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ARCHETYPE: Hash = coreHash({ archetype: "compose-adversarial" });
const RUN_ID = uuidV7From(1_785_000_000_000, Buffer.alloc(10, 0x51));
const PROJECT = composeProjectName(RUN_ID);
const ARM64: Hash = `sha256:${"a".repeat(64)}`;
const AMD64: Hash = `sha256:${"b".repeat(64)}`;

/**
 * The image id the stub daemon resolves one pinned digest to.
 *
 * Deliberately *not* equal to the digest: a real daemon's `.Image` is a content
 * id, and a test whose id happened to be the digest would prove the driver
 * compares two spellings of the same string rather than that it resolves one
 * through Docker to reach the other.
 */
function imageIdFor(serviceId: string, digest: Hash): string {
  return `sha256:${coreHash({ image: serviceId, digest }).slice("sha256:".length)}`;
}

interface Fixture {
  readonly driver: ComposeEnvironmentDriver;
  readonly docker: StubDockerCli;
  readonly world: StubWorld;
  readonly lock: SubstrateLockV1;
  readonly repository: RepositoryConfigPaths;
}

/** The five applied configuration files, as real bytes a hash can be taken of. */
function configuration(root: string): { readonly upstream: MaterializedUpstream; readonly repository: RepositoryConfigPaths } {
  const upstreamRoot = path.join(root, "upstream");
  mkdirSync(path.join(upstreamRoot, "src", "otel-collector"), { recursive: true });
  const composeFile = path.join(upstreamRoot, "compose.yaml");
  const envFile = path.join(upstreamRoot, ".env");
  const collectorConfigFile = path.join(upstreamRoot, "src", "otel-collector", "otelcol-config.yml");
  writeFileSync(composeFile, "services: {}\n");
  writeFileSync(envFile, "IMAGE_VERSION=3.0.0\n");
  writeFileSync(collectorConfigFile, "receivers: {}\n");
  const overlayPath = path.join(root, "erl2-overlay.yaml");
  const extrasPath = path.join(root, "erl2-otelcol-extras.yaml");
  writeFileSync(overlayPath, "services: {}\n");
  writeFileSync(extrasPath, "exporters: {}\n");
  return {
    upstream: {
      root: upstreamRoot,
      composeFile,
      envFile,
      collectorConfigFile,
      archiveSha256: `sha256:${"c".repeat(64)}`,
    },
    repository: { overlayPath, extrasPath },
  };
}

function lockFor(
  upstream: MaterializedUpstream,
  repository: RepositoryConfigPaths,
  overrides: {
    readonly images?: SubstrateLockV1["images"];
    readonly configHashes?: readonly Hash[];
    readonly archiveSha256?: Hash;
    readonly unqualified?: boolean;
  } = {},
): SubstrateLockV1 {
  const images =
    overrides.images ??
    OTEL_DEMO_SERVICES.flatMap((service) => [
      { service_id: service.serviceId, platform: "linux/amd64" as const, digest: AMD64 },
      { service_id: service.serviceId, platform: "linux/arm64" as const, digest: ARM64 },
    ]);
  const configHashes =
    overrides.configHashes ??
    [
      fileSha256(upstream.composeFile),
      fileSha256(upstream.envFile),
      fileSha256(upstream.collectorConfigFile),
      fileSha256(repository.overlayPath),
      fileSha256(repository.extrasPath),
    ];
  const qualified = {
    schema_version: "substrate-lock/v1" as const,
    lock_id: "adversarial-lock",
    substrate_id: "opentelemetry-demo",
    qualification_status: "qualified" as const,
    source_archive: {
      release_tag: "3.0.0",
      source_commit: "0".repeat(40),
      archive_sha256: overrides.archiveSha256 ?? upstream.archiveSha256,
    },
    images: [...images],
    sbom: {
      path: "environments/otel-demo/qualification/sbom.json",
      media_type: "application/json",
      byte_length: 2,
      file_sha256: `sha256:${"d".repeat(64)}`,
      classification: "PUBLIC" as const,
    },
    provenance: { producer: "erl2-test", producer_version: "0.1.0", transformations: [] as string[] },
    config_hashes: [...new Set(configHashes)],
    recorded_at: "2026-08-03T00:00:00Z",
  };
  const body = overrides.unqualified === true
    ? {
        ...qualified,
        qualification_status: "unqualified_pending_erl2_oq_005" as const,
        unqualified_reason_code: "OTEL_DEMO_NOT_RE_ADMITTED",
      }
    : qualified;
  // Signed by the development environment governor, exactly as the shipped lock
  // is: a *tampered* signature must be refused, and a development signature must
  // never be mistaken for an independent authority.
  return assertContract<SubstrateLockV1>(
    "SubstrateLockV1",
    sealSigned(body, developmentKey("challenge-governor")),
  );
}

function fixture(
  options: {
    readonly behaviour?: StubBehaviour;
    readonly lockOverrides?: Parameters<typeof lockFor>[2];
    readonly platform?: string;
    readonly registryPlatforms?: Readonly<Record<string, string>>;
    /**
     * The observer's settle budget. One by default, because the stub has no
     * exporter to wait for; a case that is about *waiting* says so.
     */
    readonly telemetrySettleAttempts?: number;
    /** Wraps the stub daemon, so a case can change the world between reads. */
    readonly wrapDocker?: (inner: DockerCli) => DockerCli;
  } = {},
): Fixture {
  const root = ownedTempDir("erl2-compose-adv-");
  const { upstream, repository } = configuration(root);
  const lock = lockFor(upstream, repository, options.lockOverrides ?? {});
  const world = newStubWorld({ ...(options.platform === undefined ? {} : { platform: options.platform }) });
  for (const service of OTEL_DEMO_SERVICES) {
    world.localImages.set(`${service.imageRepository}@${ARM64}`, "linux/arm64");
    world.localImages.set(`${service.imageRepository}@${AMD64}`, "linux/amd64");
    world.registryImages.set(`${service.imageRepository}@${ARM64}`, "linux/arm64");
    world.registryImages.set(`${service.imageRepository}@${AMD64}`, "linux/amd64");
    // The daemon's image store, as a real one behaves: one image per pinned
    // digest, reachable by its own id and by the digest that names it.
    for (const digest of [ARM64, AMD64]) {
      putStubImage(world, imageIdFor(service.serviceId, digest), [`${service.imageRepository}@${digest}`]);
    }
  }
  for (const [reference, platform] of Object.entries(options.registryPlatforms ?? {})) {
    world.registryImages.set(reference, platform);
  }
  const docker = new StubDockerCli(
    world,
    {
      project: PROJECT,
      services: [{ serviceId: "otel-collector" }, { serviceId: "quote", hostPort: 18090 }],
    },
    options.behaviour ?? {},
  );
  const driver = new ComposeEnvironmentDriver({
    runId: RUN_ID,
    clock: new SteppingClock("2026-08-03T00:00:00Z", 1000),
    signingKey: developmentKey("challenge-governor"),
    archetypeHash: ARCHETYPE,
    lock,
    lockHash: coreHash(lock),
    substrateRoot: path.join(root, "substrate"),
    upstream,
    repositoryConfig: repository,
    docker: options.wrapDocker === undefined ? docker : options.wrapDocker(docker),
    // The stub has no exporter to wait for: the world is already arranged when
    // the observation runs, so a settle budget would only spend wall clock.
    telemetrySettleAttempts: options.telemetrySettleAttempts ?? 1,
  });
  return { driver, docker, world, lock, repository };
}

function provisioned(options: Parameters<typeof fixture>[0] = {}): Fixture {
  const f = fixture(options);
  f.driver.establishSubstrateInstance(RUN_ID);
  f.driver.provision({
    runId: RUN_ID,
    archetypeHash: ARCHETYPE,
    disorderSeedCommitment: coreHash({ seed: 1 }),
    operationId: "op-provision",
  });
  return f;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
  return "NO_REFUSAL";
}

// -- the lock itself ---------------------------------------------------------

test("COMPOSE-ADV: an unqualified lock never reaches a substrate", () => {
  const f = fixture({ lockOverrides: { unqualified: true } });
  f.driver.establishSubstrateInstance(RUN_ID);
  assert.equal(f.driver.manifest.enabled, false);
  assert.equal(f.driver.manifest.activation_gate, "ERL2-OQ-005");
  assert.equal(
    codeOf(() =>
      f.driver.provision({
        runId: RUN_ID,
        archetypeHash: ARCHETYPE,
        disorderSeedCommitment: coreHash({ seed: 1 }),
        operationId: "op-provision",
      }),
    ),
    "ENV_DRIVER_DISABLED",
  );
  assert.equal(
    f.docker.issued.some((line) => line.includes("compose")),
    false,
    "a disabled driver must not reach Compose at all",
  );
});

test("COMPOSE-ADV: a lock whose amd64 slot holds an arm64 manifest is refused", () => {
  // The registry is asked what the pinned digest *describes*, and it answers
  // arm64 for the digest the lock filed under amd64. The bijective comparison
  // then has two observations for one platform and none for the other.
  const f = fixture({
    registryPlatforms: Object.fromEntries(
      OTEL_DEMO_SERVICES.map((s) => [`${s.imageRepository}@${AMD64}`, "linux/arm64"]),
    ),
  });
  f.driver.establishSubstrateInstance(RUN_ID);
  assert.equal(
    codeOf(() =>
      f.driver.provision({
        runId: RUN_ID,
        archetypeHash: ARCHETYPE,
        disorderSeedCommitment: coreHash({ seed: 1 }),
        operationId: "op-provision",
      }),
    ),
    "ENV_SUBSTRATE_DIGEST_MISMATCH",
  );
  assert.equal(f.world.containers.size, 0, "admission must refuse before any container exists");
});

test("COMPOSE-ADV: a lock pinning an EXTRA service is refused", () => {
  const f = fixture({
    lockOverrides: {
      images: [
        ...OTEL_DEMO_SERVICES.flatMap((service) => [
          { service_id: service.serviceId, platform: "linux/amd64" as const, digest: AMD64 },
          { service_id: service.serviceId, platform: "linux/arm64" as const, digest: ARM64 },
        ]),
        { service_id: "frontend", platform: "linux/amd64" as const, digest: AMD64 },
        { service_id: "frontend", platform: "linux/arm64" as const, digest: ARM64 },
      ],
    },
  });
  f.driver.establishSubstrateInstance(RUN_ID);
  assert.equal(
    codeOf(() =>
      f.driver.provision({
        runId: RUN_ID,
        archetypeHash: ARCHETYPE,
        disorderSeedCommitment: coreHash({ seed: 1 }),
        operationId: "op-provision",
      }),
    ),
    "ENV_SUBSTRATE_PLATFORM_MISSING",
  );
});

test("COMPOSE-ADV: a lock MISSING one of the subset's images is refused", () => {
  const f = fixture({
    lockOverrides: {
      images: [
        { service_id: "quote", platform: "linux/amd64" as const, digest: AMD64 },
        { service_id: "quote", platform: "linux/arm64" as const, digest: ARM64 },
      ],
    },
  });
  f.driver.establishSubstrateInstance(RUN_ID);
  // The driver still needs a collector digest to build its own image reference,
  // so the refusal lands on the missing platform rather than on the comparison.
  assert.equal(
    codeOf(() =>
      f.driver.provision({
        runId: RUN_ID,
        archetypeHash: ARCHETYPE,
        disorderSeedCommitment: coreHash({ seed: 1 }),
        operationId: "op-provision",
      }),
    ),
    "ENV_SUBSTRATE_PLATFORM_MISSING",
  );
});

test("COMPOSE-ADV: a changed applied configuration file is refused before provisioning", () => {
  const f = fixture();
  f.driver.establishSubstrateInstance(RUN_ID);
  // The lock was signed over the overlay's bytes; the overlay is then edited.
  writeFileSync(f.repository.overlayPath, "services: { quote: { privileged: true } }\n");
  assert.equal(
    codeOf(() =>
      f.driver.provision({
        runId: RUN_ID,
        archetypeHash: ARCHETYPE,
        disorderSeedCommitment: coreHash({ seed: 1 }),
        operationId: "op-provision",
      }),
    ),
    "ENV_SUBSTRATE_DIGEST_MISMATCH",
  );
  assert.equal(f.world.containers.size, 0);
});

// -- discovery and deletion --------------------------------------------------

test("COMPOSE-ADV: every discovery is an exact run-scoped name or label value", () => {
  const f = provisioned();
  f.driver.inspect(RUN_ID);
  const filters = f.docker.issued.filter((line) => line.includes("--filter"));
  assert.ok(filters.length > 0, "the driver must actually query the substrate");
  for (const line of f.docker.issued) {
    assert.equal(/[*?]/.test(line), false, `a Docker invocation used a wildcard: ${line}`);
    assert.equal(line.includes("compose ls"), false, "ambient Compose state must never be consulted");
  }
  for (const line of filters) {
    assert.ok(
      line.includes(`com.docker.compose.project=${PROJECT}`),
      `a discovery filter is not scoped to this run's exact project: ${line}`,
    );
    assert.ok(line.includes(RUN_ID), `a discovery filter does not embed the run id: ${line}`);
  }
});

test("COMPOSE-ADV: a broad cleanup selector is refused by construction", () => {
  assert.equal(codeOf(() => { assertNarrowSelector(RUN_ID, `erl2-*`); }), "ENV_BROAD_DELETE_REJECTED");
  assert.equal(codeOf(() => { assertNarrowSelector(RUN_ID, "erl2-"); }), "ENV_BROAD_DELETE_REJECTED");
  assert.equal(codeOf(() => { assertNarrowSelector(RUN_ID, ""); }), "ENV_BROAD_DELETE_REJECTED");
  assertNarrowSelector(RUN_ID, `${PROJECT}-quote`);
});

test("COMPOSE-ADV: a foreign object wearing this run's project label stops the teardown", () => {
  const f = provisioned();
  // Internally consistent and provably not ours: it carries this run's project
  // label but another run's name, so `assertOwnedByRun` can fail for it.
  f.world.containers.set("erl2-00000000-0000-4000-8000-0000000f0e19-quote", {
    labels: {
      "com.erl2.run_id": "00000000-0000-4000-8000-0000000f0e19",
      "com.docker.compose.project": PROJECT,
    },
    state: "running",
    paused: false,
    health: "none",
    restartCount: 0,
    image: "sha256:stub",
    networks: [],
    ports: {},
    logs: "",
  });
  assert.equal(
    codeOf(() => f.driver.destroy({ runId: RUN_ID, operationId: "op-destroy" })),
    "ENV_FOREIGN_RESOURCE_REJECTED",
  );
  assert.ok(
    f.world.containers.has(`${PROJECT}-quote`),
    "a refused whole-environment destroy must not have removed anything",
  );
});

// -- the lying substrate -----------------------------------------------------

test("COMPOSE-ADV: a compensation that reverts nothing is receipted as failed", () => {
  // The substrate accepts `network disconnect` and `network rm` and performs
  // neither. A driver that trusted the exit status would receipt `succeeded`.
  const f = provisioned({
    behaviour: { drop: (args) => args[0] === "network" && (args[1] === "disconnect" || args[1] === "rm") },
  });
  const inventory = f.driver.inspect(RUN_ID);
  const project = inventory.resources.find((r) => r.kind === "project") as { resource_id: string };
  f.driver.mutate({
    runId: RUN_ID,
    targetResourceId: project.resource_id,
    mutationId: "activate-adversarial",
    operationId: "op-activate",
  });
  assert.deepEqual(f.driver.observedMutations(RUN_ID), ["activate-adversarial"]);

  const receipt = f.driver.restore({ runId: RUN_ID, operationId: "op-restore" });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.error_code, "RESTORATION_FAILED");
  // And the substrate still says so, which is what the Lab's restoration probe
  // reads rather than the receipt.
  assert.deepEqual(f.driver.observedMutations(RUN_ID), ["activate-adversarial"]);
});

test("COMPOSE-ADV: a mutation the substrate did not apply is receipted as failed", () => {
  const f = provisioned({
    behaviour: { drop: (args) => args[0] === "network" && args[1] === "connect" },
  });
  const inventory = f.driver.inspect(RUN_ID);
  const project = inventory.resources.find((r) => r.kind === "project") as { resource_id: string };
  const receipt = f.driver.mutate({
    runId: RUN_ID,
    targetResourceId: project.resource_id,
    mutationId: "activate-adversarial",
    operationId: "op-activate",
  });
  assert.equal(receipt.status, "failed");
  assert.deepEqual(f.driver.observedMutations(RUN_ID), []);
});

test("COMPOSE-ADV: a teardown Compose reports as clean is re-inspected", () => {
  // `docker compose down` returns 0 and removes nothing.
  const f = provisioned({ behaviour: { drop: (args) => args.includes("down") } });
  const result = f.driver.destroy({ runId: RUN_ID, operationId: "op-destroy" });
  assert.equal(result.receipt.status, "failed");
  assert.equal(result.receipt.error_code, "ENV_RESIDUE_DETECTED");
  assert.ok(result.residue.length > 0, "residue must be reported from re-inspection, not from the exit status");
});

// -- Compose failures --------------------------------------------------------

test("COMPOSE-ADV: a failed `compose pull` refuses before anything is created", () => {
  const f = fixture({ behaviour: { fail: (args) => args.includes("pull") } });
  f.driver.establishSubstrateInstance(RUN_ID);
  assert.equal(
    codeOf(() =>
      f.driver.provision({
        runId: RUN_ID,
        archetypeHash: ARCHETYPE,
        disorderSeedCommitment: coreHash({ seed: 1 }),
        operationId: "op-provision",
      }),
    ),
    "ENV_PROVISION_FAILED",
  );
  assert.equal(f.world.containers.size, 0);
});

test("COMPOSE-ADV: a partial provision is reported partial, with everything created", () => {
  // `compose up` brings the collector up and never starts the endpoint.
  const f = fixture({
    behaviour: {
      afterUp: (world) => {
        world.containers.delete(`${PROJECT}-quote`);
      },
    },
  });
  f.driver.establishSubstrateInstance(RUN_ID);
  const result = f.driver.provision({
    runId: RUN_ID,
    archetypeHash: ARCHETYPE,
    disorderSeedCommitment: coreHash({ seed: 1 }),
    operationId: "op-provision",
  });
  assert.equal(result.partial, true);
  assert.equal(result.receipt.status, "failed");
  assert.equal(result.receipt.error_code, "ENV_PROVISION_FAILED");
  // The half-built environment is still fully inventoried: cleanup needs to know
  // what exists, and a partial provision that reported nothing would be worse.
  const names = result.inventory.resources.map((r) => r.run_scoped_name);
  assert.ok(names.includes(`${PROJECT}-otel-collector`));
  assert.ok(names.includes(`${PROJECT}-net`));
});

// -- adoption ----------------------------------------------------------------

test("COMPOSE-ADV: a stored receipt is not adopted once the substrate contradicts it", () => {
  const f = provisioned();
  assert.notEqual(f.driver.completedOperation(RUN_ID, "op-provision"), undefined);
  // The environment is destroyed out from under the run. The durable log still
  // holds a successful provision receipt; offering it would let a later phase
  // adopt a provision whose environment no longer exists.
  f.world.containers.clear();
  f.world.networks.clear();
  assert.equal(
    f.driver.completedOperation(RUN_ID, "op-provision"),
    undefined,
    "adoption must derive from the substrate, not from the durable log alone",
  );
});

// -- an expected name is not ownership ---------------------------------------
//
// Six ways a live object can answer to one of this run's container names without
// being this run's container. In every one of them the substrate is *fully*
// provisioned first, so nothing here is a provisioning failure: the run already
// held a good graph and the object under the expected name was then replaced. The
// assertion is always the same four things — the baseline refuses, the inventory
// stops calling it ours, the stored provision receipt stops being adoptable, and
// every write to the substrate refuses.

const UNPINNED_IMAGE = `sha256:${"f".repeat(64)}`;

/** Puts the endpoint container under an image the lock does not pin. */
function substituteEndpointImage(world: StubWorld): void {
  putStubImage(world, UNPINNED_IMAGE, [`ghcr.io/not-open-telemetry/demo@sha256:${"e".repeat(64)}`]);
  (world.containers.get(`${PROJECT}-quote`) as StubContainer).image = UNPINNED_IMAGE;
}

/**
 * Asserts the four consequences of an unproven expected-name container.
 *
 * Written once because the point is that they do **not** vary with *how* the
 * object failed to be ours: an image the lock does not pin and a driver label
 * somebody else wrote are the same refusal, reached by the same gate.
 */
function assertRefusedAsNotOurs(f: Fixture, expectedViolation: string): void {
  const baseline = f.driver.probe({ runId: RUN_ID, phase: "baseline", operationId: "op-baseline" });
  const probe = baseline.probes.find((p) => p.probe_id === "probe-container-quote");
  assert.equal(probe?.passed, false, "the baseline probe must fail for a container that is not ours");
  assert.equal(probe?.failure_code, "BASELINE_PROBE_FAILED");
  assert.equal(baseline.contamination.detected, true, "an object at our name that is not ours is residue");
  assert.ok(
    baseline.contamination.finding_codes.includes("PREEXISTING_RESIDUE"),
    `residue was not reported: ${baseline.contamination.finding_codes.join(", ")}`,
  );

  // The inventory reports it — cleanup has to know it exists — but not as ours.
  const inventoried = f.driver.inspect(RUN_ID).resources.find((r) => r.run_scoped_name === `${PROJECT}-quote`);
  assert.notEqual(inventoried, undefined, "an unproven container must still be inventoried");
  assert.ok(
    inventoried?.resource_id.startsWith("unverified-"),
    `the container is still reported as owned: ${inventoried?.resource_id ?? "absent"}`,
  );
  assert.notEqual(
    inventoried?.identity_hash,
    resourceIdentityHash(RUN_ID, "container", `${PROJECT}-quote`),
    "an unproven container must not carry this run's derived resource identity",
  );

  // The stale receipt: the durable log still holds a successful provision, and a
  // restarted run must not adopt it over a substituted graph.
  assert.equal(
    f.driver.completedOperation(RUN_ID, "op-provision"),
    undefined,
    "a provision receipt must not be adopted once the graph is no longer provably ours",
  );
  // And re-dispatching is refused rather than silently building a second graph on
  // top of the one that is already there. Both halves are fail-closed: the receipt
  // is not adoptable *and* the re-dispatch does not proceed.
  assert.equal(
    codeOf(() =>
      f.driver.provision({
        runId: RUN_ID,
        archetypeHash: ARCHETYPE,
        disorderSeedCommitment: coreHash({ seed: 1 }),
        operationId: "op-provision",
      }),
    ),
    "ENV_PROVISION_FAILED",
  );

  // And every write to the substrate refuses, with the violation named.
  for (const attempt of [
    () => f.driver.destroy({ runId: RUN_ID, operationId: "op-destroy" }),
    () => f.driver.restore({ runId: RUN_ID, operationId: "op-restore" }),
    () =>
      f.driver.mutate({
        runId: RUN_ID,
        targetResourceId: `project-${RUN_ID.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()}`,
        mutationId: "activate-adversarial",
        operationId: "op-activate",
      }),
    () =>
      f.driver.destroyResource({
        runId: RUN_ID,
        resourceId: `container-otel-collector-${RUN_ID.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()}`,
        operationId: "op-destroy-one",
      }),
  ]) {
    assert.equal(codeOf(attempt), "ENV_FOREIGN_RESOURCE_REJECTED");
  }
  assert.ok(
    f.world.containers.has(`${PROJECT}-quote`) && f.world.containers.has(`${PROJECT}-otel-collector`),
    "a refused operation must not have removed anything",
  );

  // The refusal says which check failed, so an operator is not left guessing.
  let message = "";
  try {
    f.driver.destroy({ runId: RUN_ID, operationId: "op-destroy-2" });
  } catch (error) {
    message = (error as Error).message;
  }
  assert.ok(
    message.includes(expectedViolation),
    `the refusal did not name ${expectedViolation}: ${message}`,
  );
}

test("COMPOSE-ADV: an expected container name running an image the lock does not pin is refused", () => {
  const f = provisioned();
  substituteEndpointImage(f.world);
  assertRefusedAsNotOurs(f, "image_not_locked_digest");
});

test("COMPOSE-ADV: an expected container name whose image cannot be resolved at all is refused", () => {
  // The daemon knows the container and reports an image id it cannot then resolve.
  // "Docker could not prove the mapping" is not "the mapping holds".
  const f = provisioned();
  (f.world.containers.get(`${PROJECT}-quote`) as StubContainer).image = `sha256:${"9".repeat(64)}`;
  assertRefusedAsNotOurs(f, "image_not_locked_digest");
});

test("COMPOSE-ADV: an expected container carrying another run's run_id label is refused", () => {
  const f = provisioned();
  (f.world.containers.get(`${PROJECT}-quote`) as StubContainer).labels["com.erl2.run_id"] =
    "00000000-0000-4000-8000-0000000f0e19";
  assertRefusedAsNotOurs(f, "com.erl2.run_id_mismatch");
});

test("COMPOSE-ADV: an expected container carrying a foreign driver_id label is refused", () => {
  const f = provisioned();
  (f.world.containers.get(`${PROJECT}-quote`) as StubContainer).labels["com.erl2.driver_id"] =
    "kubernetes-driver";
  assertRefusedAsNotOurs(f, "com.erl2.driver_id_mismatch");
});

test("COMPOSE-ADV: an expected container carrying a foreign Compose project label is refused", () => {
  const f = provisioned();
  (f.world.containers.get(`${PROJECT}-quote`) as StubContainer).labels["com.docker.compose.project"] =
    "someone-elses-project";
  assertRefusedAsNotOurs(f, "com.docker.compose.project_mismatch");
});

test("COMPOSE-ADV: an expected container MISSING an ownership label is refused", () => {
  // A missing label is not a lenient case. `""` is not this run's driver id, so
  // "absent" and "wrong" reach the same gate.
  const f = provisioned();
  const quote = f.world.containers.get(`${PROJECT}-quote`) as StubContainer;
  delete quote.labels["com.erl2.driver_id"];
  assertRefusedAsNotOurs(f, "com.erl2.driver_id_mismatch");
});

test("COMPOSE-ADV: two unproven containers are two inventory entries, not one", () => {
  // Every container name in a project shares the same leading characters, so an
  // identifier keyed on a prefix of the name collapses both of this run's
  // containers into one entry — and an inventory with two objects under one id is
  // one an operator cannot act on. Both are substituted here so the ids have to be
  // distinct rather than merely well-formed.
  const f = provisioned();
  substituteEndpointImage(f.world);
  (f.world.containers.get(`${PROJECT}-otel-collector`) as StubContainer).labels["com.erl2.driver_id"] =
    "someone-else";

  const unverified = f.driver
    .inspect(RUN_ID)
    .resources.filter((r) => r.resource_id.startsWith("unverified-"));
  assert.equal(unverified.length, 2, "both unproven containers must be inventoried");
  assert.equal(
    new Set(unverified.map((r) => r.resource_id)).size,
    2,
    `two unproven containers collided on one resource id: ${unverified.map((r) => r.resource_id).join(", ")}`,
  );
  assert.equal(
    new Set(unverified.map((r) => r.identity_hash)).size,
    2,
    "two unproven containers collided on one identity hash",
  );
  // And neither is mistakable for an owned resource.
  for (const resource of unverified) {
    assert.equal(
      codeOf(() => {
        assertOwnedByRun(RUN_ID, resource);
      }),
      "ENV_FOREIGN_RESOURCE_REJECTED",
    );
  }
});

test("COMPOSE-ADV: the baseline observation records what Docker said, not what the lock says", () => {
  // The regression this pins: the observation used to be populated with the
  // *locked* digest, so it agreed with the lock however the container had been
  // substituted, and two provisions running different bytes fingerprinted alike.
  const clean = provisioned();
  const before = clean.driver.probe({ runId: RUN_ID, phase: "baseline", operationId: "op-a" });
  assert.equal(
    before.probes.find((p) => p.probe_id === "probe-container-quote")?.passed,
    true,
  );
  const identical = clean.driver.probe({ runId: RUN_ID, phase: "baseline", operationId: "op-b" });
  assert.equal(
    before.fingerprint_hash,
    identical.fingerprint_hash,
    "two probes of one clean environment must still fingerprint identically",
  );

  substituteEndpointImage(clean.world);
  const after = clean.driver.probe({ runId: RUN_ID, phase: "baseline", operationId: "op-c" });
  assert.notEqual(
    before.probes.find((p) => p.probe_id === "probe-container-quote")?.observation_hash,
    after.probes.find((p) => p.probe_id === "probe-container-quote")?.observation_hash,
    "the container observation did not change when the running bytes did",
  );
  assert.notEqual(
    before.fingerprint_hash,
    after.fingerprint_hash,
    "the baseline fingerprint did not change when the running bytes did",
  );
});

test("COMPOSE-ADV: an activation observed on an unproven container is not this run's mutation", () => {
  const f = provisioned();
  const inventory = f.driver.inspect(RUN_ID);
  const project = inventory.resources.find((r) => r.kind === "project") as { resource_id: string };
  f.driver.mutate({
    runId: RUN_ID,
    targetResourceId: project.resource_id,
    mutationId: "activate-adversarial",
    operationId: "op-activate",
  });
  assert.deepEqual(f.driver.observedMutations(RUN_ID), ["activate-adversarial"]);

  // The container is then replaced, attachment and all. The activation is still
  // *visible*, but not on a container Docker will confirm is ours — so it may not
  // be reported as this run's applied mutation, and the receipt may not be adopted.
  substituteEndpointImage(f.world);
  assert.deepEqual(
    f.driver.observedMutations(RUN_ID),
    [],
    "a mutation must not be attributed to a container that is not provably ours",
  );
  assert.equal(f.driver.completedOperation(RUN_ID, "op-activate"), undefined);
});

// -- the exposure the substrate actually has ---------------------------------

/**
 * The extracted upstream configuration the renderer hands to Compose directly.
 *
 * Named here so the admission check below and the renderer consult the *same*
 * paths. Checking the archive's presence instead would be a proxy for these, and a
 * wrong one: the archive can be fetched without having been extracted, and it is
 * these two files — not the tarball — that `docker compose config` opens.
 */
const UPSTREAM_ROOT = path.join(repoRoot, "environments", "otel-demo", "upstream", "extracted-1bf3ef8fbaffc049");
const UPSTREAM_ENV_FILE = path.join(UPSTREAM_ROOT, ".env");
const UPSTREAM_COMPOSE_FILE = path.join(UPSTREAM_ROOT, "compose.yaml");

/**
 * The rendered Compose configuration for the two-service subset.
 *
 * Asked of `docker compose config`, which is the merge Compose will actually
 * perform, because the overlay's source text is not the topology: `ports` merges
 * across files, so an overlay that *looks* like it publishes one loopback port can
 * render as two publications, one of them on every interface. Every run-varying
 * value is supplied exactly as the driver supplies it.
 */
function renderedComposeConfig(): Record<string, { ports?: readonly Record<string, unknown>[] }> {
  const overlay = path.join(repoRoot, "environments", "otel-demo", "compose", "erl2-overlay.yaml");
  const extras = path.join(repoRoot, "environments", "otel-demo", "compose", "erl2-otelcol-extras.yaml");
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-name", "erl2-rendered-topology",
      "--project-directory", UPSTREAM_ROOT,
      "--env-file", UPSTREAM_ENV_FILE,
      "--file", UPSTREAM_COMPOSE_FILE,
      "--file", overlay,
      "config", "--format", "json",
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        ERL2_RUN_ID: RUN_ID,
        ERL2_NETWORK_NAME: `${PROJECT}-net`,
        ERL2_CONTAINER_QUOTE: `${PROJECT}-quote`,
        ERL2_CONTAINER_OTEL_COLLECTOR: `${PROJECT}-otel-collector`,
        ERL2_IMAGE_QUOTE: `ghcr.io/open-telemetry/demo@${ARM64}`,
        ERL2_IMAGE_OTEL_COLLECTOR: `ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@${ARM64}`,
        DOCKER_SOCK: "/dev/null",
        HOST_FILESYSTEM: "/dev/null",
        OTEL_COLLECTOR_CONFIG_EXTRAS: extras,
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) throw new Error(`docker compose config failed: ${result.stderr ?? ""}`);
  return (JSON.parse(result.stdout) as { services: Record<string, { ports?: readonly Record<string, unknown>[] }> })
    .services;
}

/**
 * Why the rendered topology cannot be observed here, or `undefined` when it can.
 *
 * Every prerequisite the renderer actually consumes, checked individually so the
 * reason names the one that is missing. Gating on `dockerAvailable()` alone was
 * wrong in a way that only a fresh checkout exposes: GitHub's runners *do* have
 * Docker, so the test ran, and then `docker compose config` could not open an
 * extracted upstream file that `.gitignore` excludes from the repository. The
 * assertion was fine; its admission was not.
 *
 * Nothing here fetches or extracts anything. `npm test` is hermetic, and a suite
 * that quietly downloaded a release archive to make itself runnable would be a
 * worse problem than the one being fixed.
 */
function renderedTopologyUnavailable(): string | undefined {
  if (!dockerAvailable()) return "docker compose is not available to render the merge";
  const missing = [UPSTREAM_ENV_FILE, UPSTREAM_COMPOSE_FILE]
    .filter((file) => !existsSync(file))
    .map((file) => path.relative(repoRoot, file));
  if (missing.length > 0) {
    return (
      `the extracted upstream configuration is absent (${missing.join(", ")}); ` +
      "`environments/otel-demo/upstream/` is git-ignored, so a fresh checkout does not carry it — " +
      "run `node scripts/qualify-otel-demo.mjs --fetch-only` to materialise it"
    );
  }
  return undefined;
}

const RENDER_REASON = renderedTopologyUnavailable();
/**
 * Skip only when the topology is genuinely unobservable *and* nobody asked for it.
 *
 * The same three-state shape the live suites use: observable means the assertion
 * runs; unobservable means an explicit `RENDERED TOPOLOGY UNPROVEN` skip that
 * records the case as unproven rather than passed; and
 * `ERL2_REQUIRE_LIVE_DOCKER=1` means a caller is gating on this claim, so the test
 * is registered anyway and fails naming the prerequisite instead of vanishing.
 */
const RENDER_SKIP: { readonly skip?: string } =
  RENDER_REASON === undefined || process.env["ERL2_REQUIRE_LIVE_DOCKER"] === "1"
    ? {}
    : { skip: `RENDERED TOPOLOGY UNPROVEN: ${RENDER_REASON}` };

test("COMPOSE-ADV: the RENDERED configuration publishes one loopback port and nothing else", RENDER_SKIP, () => {
  // Reachable with a reason only under `ERL2_REQUIRE_LIVE_DOCKER=1`, which is a
  // caller saying "prove this or go red". The refusal names the prerequisite rather
  // than surfacing as whatever error Compose happens to emit.
  if (RENDER_REASON !== undefined) {
    assert.fail(`ERL2_REQUIRE_LIVE_DOCKER=1 was set but ${RENDER_REASON}`);
  }
  const services = renderedComposeConfig();

  // `quote`: exactly one entry, on 127.0.0.1, for the endpoint's container port,
  // with no fixed `published` — an ephemeral host port, so two runs cannot collide.
  const quote = services["quote"]?.ports ?? [];
  assert.equal(quote.length, 1, `quote renders ${quote.length} port entries: ${JSON.stringify(quote)}`);
  assert.equal(quote[0]?.["host_ip"], "127.0.0.1", `quote is not bound to loopback: ${JSON.stringify(quote[0])}`);
  assert.equal(quote[0]?.["target"], 8090);
  assert.equal(quote[0]?.["protocol"], "tcp");
  assert.equal(
    quote[0]?.["published"],
    undefined,
    "quote pins a fixed host port; the ephemeral binding is what keeps two runs from colliding",
  );

  // `otel-collector`: no host publication at all. Upstream published 4317 and 4318,
  // and a published OTLP receiver is an ingestion point for anything on the host.
  assert.equal(
    services["otel-collector"]?.ports,
    undefined,
    `the collector still publishes: ${JSON.stringify(services["otel-collector"]?.ports)}`,
  );

  // And no other host publication anywhere in the selected graph. The rendered
  // document covers all twenty-two upstream services, but only these two are ever
  // brought up, so only these two are the substrate's exposure.
  for (const serviceId of OTEL_DEMO_SERVICES.map((s) => s.serviceId)) {
    for (const entry of services[serviceId]?.ports ?? []) {
      assert.equal(
        entry["host_ip"],
        "127.0.0.1",
        `${serviceId} renders a non-loopback publication: ${JSON.stringify(entry)}`,
      );
    }
  }
});

test("COMPOSE-ADV: the substrate identity changes when the daemon does", () => {
  const f = provisioned();
  const bound = f.driver.substrateInstance();
  assert.notEqual(bound, undefined);
  assert.equal(bound?.kind, "compose-project");
  // The marker is unchanged; the engine underneath it is not. A run bound to the
  // first substrate must not accept the second.
  f.world.engineId = "stub-engine-0002";
  assert.notEqual(f.driver.substrateInstance()?.instanceHash, bound?.instanceHash);
});

// -- the attributable-telemetry observation (ADR-ERL2-033) -------------------
//
// The driver's own half of the obligation: what it observes, and — the part
// that has no other witness — what it records when it cannot observe. An
// `absent` branch that returned the wrong shape, or that dressed a failure as
// an observation, would be invisible to the live acceptance test, which only
// ever exercises the happy path on a host with a daemon.

test("COMPOSE-ADV: telemetry the collector received is observed with the lines its counts derive from", () => {
  const f = provisioned();
  withTelemetry(f.world, `${PROJECT}-otel-collector`, RUN_ID, 3);
  const material = f.driver.observeAttributableTelemetry(RUN_ID);
  assert.equal(material.evidence, "observed");
  if (material.evidence !== "observed") return;
  assert.equal(material.marker, RUN_ID);
  assert.equal(material.counts.spans, 3);
  assert.equal(material.counts.traceBatches, 1);
  assert.ok(material.counts.runAttributedRecords > 0);
  assert.deepEqual(material.counts.serviceNames, ["quote"]);
  assert.equal(material.collector.serviceId, "otel-collector");
  assert.equal(material.collector.containerName, `${PROJECT}-otel-collector`);
  // The excerpt is exactly the lines the counts derive from, and re-parsing it
  // reproduces them — the property the offline verifier stands on.
  assert.deepEqual(parseCollectorTelemetry(material.excerpt, RUN_ID), material.counts);
  assert.equal(material.excerpt.includes("Everything is ready"), false);
});

test("COMPOSE-ADV: a collector that is not provably this run's yields an absent observation, not a zero", () => {
  const f = provisioned();
  withTelemetry(f.world, `${PROJECT}-otel-collector`, RUN_ID, 3);
  // The exact-name container is now running substituted bytes: verified()
  // fails, so its logs may not be read at all — and the honest record of that
  // is `absent` with a reason, never an observation reporting zero.
  const collector = f.world.containers.get(`${PROJECT}-otel-collector`) as StubContainer;
  f.world.containers.set(`${PROJECT}-otel-collector`, { ...collector, image: "sha256:deadbeef" });
  const material = f.driver.observeAttributableTelemetry(RUN_ID);
  assert.equal(material.evidence, "absent");
  if (material.evidence !== "absent") return;
  assert.equal(material.reasonCode, "collector_not_verified");
  assert.equal(material.marker, RUN_ID);
});

test("COMPOSE-ADV: a collector whose logs cannot be read is absent for a different, named reason", () => {
  const f = provisioned({
    behaviour: { fail: (args) => args[0] === "container" && args[1] === "logs" },
  });
  const material = f.driver.observeAttributableTelemetry(RUN_ID);
  assert.equal(material.evidence, "absent");
  if (material.evidence !== "absent") return;
  assert.equal(
    material.reasonCode,
    "collector_logs_unreadable",
    "an unreadable log and an unverified container are different facts and must stay distinct",
  );
});

test("COMPOSE-ADV: a verified collector that received nothing this run is observed, honestly, as zero", () => {
  const f = provisioned();
  // No telemetry appended: the collector is provably this run's and its log is
  // readable, so the observation is real — and it reports nothing attributed.
  const material = f.driver.observeAttributableTelemetry(RUN_ID);
  assert.equal(material.evidence, "observed");
  if (material.evidence !== "observed") return;
  assert.equal(material.counts.runAttributedRecords, 0);
  assert.equal(material.counts.spans, 0);
});

// -- the observation window (the COMPOSE-E2E evidence-accuracy defect) -------
//
// The defect these close is not that the collector was misread. It is that the
// observer derived its two numbers from evidence with *different survival*: the
// records naming a run live in a batch's detailed dump, the span count lives in
// the summary line above it, and the container's `json-file` log rotates from
// the head. The settle loop waited for the half that survives and published the
// half that does not, so a run whose spans were emitted, exported and marked
// could freeze a retained artifact stating `spans: 0`.
//
// The gate predicate never read `spans`, so no run with no telemetry was ever
// admitted by this — and that is exactly why the cases below assert on the
// *retained artifact* rather than on a verdict. The lie was in the evidence.

/** The collector's own start-up record, which precedes anything it exports. */
const COLLECTOR_ORIGIN =
  "2026-08-03T00:00:00.000Z\tinfo\tservice@v0.157.0/service.go\tEverything is ready. Begin running and processing data.\n";

/** One complete exported batch: the summary line, then its own detailed dump. */
function batch(spans: number, marker: string | undefined): string {
  return (
    `2026-08-03T00:00:01.000Z\tinfo\tTraces\t{"otelcol.signal": "traces", "resource spans": 1, "spans": ${String(spans)}}\n` +
    "     -> service.name: Str(quote)\n" +
    (marker === undefined
      ? "     -> url.full: Str(http://127.0.0.1:18090/health)\n"
      : `     -> url.full: Str(http://127.0.0.1:18090/getquote?erl2_run=${marker})\n`)
  );
}

/** The dump half of a batch whose summary line has already rotated away. */
function orphanedDump(marker: string): string {
  return (
    "     -> service.name: Str(quote)\n" +
    `     -> url.full: Str(http://127.0.0.1:18090/getquote?erl2_run=${marker})\n`
  );
}

/** Replace the collector's whole readable window with exactly `logs`. */
function windowIs(f: Fixture, logs: string): void {
  const name = `${PROJECT}-otel-collector`;
  const container = f.world.containers.get(name) as StubContainer;
  f.world.containers.set(name, { ...container, logs });
}

const OTHER_RUN = uuidV7From(1_785_000_100_000, Buffer.alloc(10, 0x77));

/**
 * The retained artifact for one observation, through the production retention
 * path — `EnvironmentRun.destroy`'s own call, over a real `ArtifactStore`.
 *
 * The cases below read *this*, not the driver's return value: the defect was
 * that a frozen artifact stated a count nothing had established, and an
 * assertion on a helper's return would not have seen it.
 */
function retainedObservation(f: Fixture): AttributableTelemetryObservationV1 {
  return retainAttributableTelemetryObservation({
    store: new ArtifactStore(ownedTempDir("erl2-compose-adv-retain-")),
    observationPath: "retained/environment/attributable-telemetry-observation.json",
    observer: f.driver,
    runId: RUN_ID,
    observedAt: () => "2026-08-03T00:00:30Z" as Instant,
  });
}

test("COMPOSE-WINDOW: a complete same-run block retains a coherent count and attribution", () => {
  const f = provisioned();
  windowIs(f, COLLECTOR_ORIGIN + batch(7, RUN_ID) + batch(7, RUN_ID));
  const observation = retainedObservation(f);
  assert.equal(observation.evidence, "observed");
  assert.equal(observation.spans, 14);
  assert.equal(observation.trace_batches, 2);
  assert.equal(observation.run_attributed_records, 2);
  // The excerpt still derives every declared count — the property the offline
  // verifier stands on, unchanged by the new acceptance condition.
  const derived = parseCollectorTelemetry(observation.log_excerpt ?? "", RUN_ID);
  assert.equal(derived.spans, observation.spans);
  assert.equal(derived.runAttributedRecords, observation.run_attributed_records);
  assert.equal(derived.runAttributedBatches, 2);
});

test("COMPOSE-WINDOW: the failed-gate signature cannot be retained as a definitive zero", () => {
  const f = provisioned();
  // The exact signature the clean gate recorded: two records naming this run
  // are readable and the summary line counting their spans has rotated away.
  // Before the correction this froze `evidence: observed, spans: 0` beside
  // `run_attributed_records: 2` — a retained artifact stating a false count for
  // a run whose spans the collector demonstrably received.
  windowIs(f, orphanedDump(RUN_ID) + orphanedDump(RUN_ID));
  const observation = retainedObservation(f);
  assert.notEqual(
    observation.evidence,
    "observed",
    "a window whose span-count line rotated away must not freeze as an observation",
  );
  assert.equal(observation.spans, undefined, "no span count may be stated at all");
  assert.equal(observation.reason_code, TELEMETRY_WINDOW_REASONS.spanCountOutsideWindow);
  // The failed-gate pair itself: never both at once, in either direction.
  assert.equal(
    observation.spans === 0 && (observation.run_attributed_records ?? 0) > 0,
    false,
    "the retained artifact reproduced the false-zero signature",
  );
});

test("COMPOSE-WINDOW: a window that begins mid-record states no count, not even a zero", () => {
  const f = provisioned();
  // The window opens inside another batch's detailed dump — a continuation
  // line, which no console record starts with — so bytes were lost before it.
  // Nothing of this run is in it, and a zero derived from a cut window would be
  // the absence of evidence dressed as evidence of absence.
  windowIs(f, orphanedDump(OTHER_RUN));
  const observation = retainedObservation(f);
  assert.equal(observation.evidence, "absent");
  assert.equal(observation.reason_code, TELEMETRY_WINDOW_REASONS.windowTruncated);
  assert.equal(observation.spans, undefined);
});

test("COMPOSE-WINDOW: a re-exported start-up sentence does not make a cut window whole", () => {
  const f = provisioned();
  // The case a live loaded run found. At `verbosity: detailed` the collector
  // exports its own logs back through the debug exporter, so `Everything is
  // ready` reappears as a record body inside later dumps — nine times in one
  // 74 kB window. A completeness check that searched for that sentence anywhere
  // called this window whole and froze `spans: 0` beside five run-attributed
  // records: the failed-gate signature, live, after the first correction.
  windowIs(
    f,
    "Body: Str(Everything is ready. Begin running and processing data.)\n" + orphanedDump(RUN_ID),
  );
  const observation = retainedObservation(f);
  assert.notEqual(observation.evidence, "observed");
  assert.equal(observation.spans, undefined);
  assert.equal(observation.reason_code, TELEMETRY_WINDOW_REASONS.spanCountOutsideWindow);
});

test("COMPOSE-WINDOW: another run's summary does not supply a count for this run's records", () => {
  const f = provisioned();
  // This run's records are orphaned — their own summary is gone — and the only
  // summary in the window belongs to another run. Combining the two would state
  // 7 spans for a run whose span count was never read.
  windowIs(f, orphanedDump(RUN_ID) + batch(7, OTHER_RUN));
  const observation = retainedObservation(f);
  assert.equal(observation.evidence, "absent");
  assert.equal(observation.reason_code, TELEMETRY_WINDOW_REASONS.spanCountOutsideWindow);
  assert.equal(observation.spans, undefined);
});

test("COMPOSE-WINDOW: this run's summary is not attributed by another run's details", () => {
  const f = provisioned();
  // The mirror image, and it is *observed*: the window begins at a whole record
  // and carries nothing of this run, so its own lines are the answer — the
  // collector really did receive 7 spans and none of them are this run's. The
  // gate refuses on the attribution floor, which is the honest refusal rather
  // than a manufactured absence.
  windowIs(f, COLLECTOR_ORIGIN + batch(7, OTHER_RUN));
  const observation = retainedObservation(f);
  assert.equal(observation.evidence, "observed");
  assert.equal(observation.spans, 7);
  assert.equal(observation.run_attributed_records, 0);
});

test("COMPOSE-WINDOW: a complete window that genuinely received nothing states zero as a fact", () => {
  const f = provisioned();
  // Whole and empty: the window begins where the collector began a record and
  // carries no batch and no marker, so `spans: 0` is what its own lines say
  // rather than a default. This is the one place a definitive zero is retained.
  windowIs(f, COLLECTOR_ORIGIN);
  const observation = retainedObservation(f);
  assert.equal(observation.evidence, "observed");
  assert.equal(observation.spans, 0);
  assert.equal(observation.trace_batches, 0);
  assert.equal(observation.run_attributed_records, 0);
});

test("COMPOSE-WINDOW: a summary with no dump yet keeps settling instead of concluding", () => {
  // The third row of the diagnosed matrix: the batch is exported and its
  // detailed dump has not been written. The observation is not complete, and
  // the decision says so rather than combining it with anything.
  const counts = parseCollectorTelemetry(
    `2026-08-03T00:00:01.000Z\tinfo\tTraces\t{"otelcol.signal": "traces", "spans": 7}\n`,
    RUN_ID,
  );
  assert.equal(counts.spans, 7);
  assert.equal(counts.runAttributedRecords, 0);
  assert.equal(counts.runAttributedBatches, 0);
  assert.deepEqual(
    decideTelemetryObservationWindow({ counts, windowComplete: true, budgetExhausted: false }),
    { decision: "settle" },
  );
});

test("COMPOSE-WINDOW: the artifact reflects one accepted snapshot when the window moves", () => {
  // The window is incoherent on the first read and coherent on the second. The
  // retained counts must be exactly the second window's — never the first
  // window's attribution paired with the second window's count, or the reverse.
  let reads = 0;
  const f = provisioned({
    telemetrySettleAttempts: 4,
    wrapDocker: (inner) => ({
      run: (invocation: DockerInvocation): DockerResult => {
        if (invocation.args[0] === "container" && invocation.args[1] === "logs") {
          reads += 1;
          const name = `${PROJECT}-otel-collector`;
          const container = f.world.containers.get(name) as StubContainer;
          f.world.containers.set(name, {
            ...container,
            logs:
              reads === 1
                ? orphanedDump(RUN_ID)
                : orphanedDump(RUN_ID) + batch(5, RUN_ID) + batch(6, RUN_ID),
          });
        }
        return inner.run(invocation);
      },
    }),
  });
  const observation = retainedObservation(f);
  assert.ok(reads >= 2, `the observer accepted the first window after ${String(reads)} read(s)`);
  assert.equal(observation.evidence, "observed");
  assert.equal(observation.spans, 11, "the retained count is not the accepted snapshot's");
  assert.equal(observation.trace_batches, 2);
  assert.equal(observation.run_attributed_records, 3);
  const derived = parseCollectorTelemetry(observation.log_excerpt ?? "", RUN_ID);
  assert.equal(derived.spans, observation.spans);
  assert.equal(derived.runAttributedRecords, observation.run_attributed_records);
});

test("COMPOSE-WINDOW: exhausting the budget without a coherent window is incomplete, not zero", () => {
  const f = provisioned({ telemetrySettleAttempts: 3 });
  windowIs(f, orphanedDump(RUN_ID));
  const material = f.driver.observeAttributableTelemetry(RUN_ID);
  assert.equal(material.evidence, "absent");
  if (material.evidence !== "absent") return;
  assert.equal(material.reasonCode, TELEMETRY_WINDOW_REASONS.spanCountOutsideWindow);
  assert.equal(material.marker, RUN_ID);
});
