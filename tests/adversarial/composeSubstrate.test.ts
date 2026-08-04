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
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertContract,
  type Hash,
  type SubstrateLockV1,
} from "@erl2/contracts";
import { coreHash, developmentKey, sealSigned } from "@erl2/integrity";
import {
  assertNarrowSelector,
  assertOwnedByRun,
  ComposeEnvironmentDriver,
  composeProjectName,
  dockerAvailable,
  fileSha256,
  OTEL_DEMO_SERVICES,
  resourceIdentityHash,
  SteppingClock,
  uuidV7From,
  type MaterializedUpstream,
  type RepositoryConfigPaths,
} from "@erl2/core";
import {
  newStubWorld,
  putStubImage,
  StubDockerCli,
  type StubBehaviour,
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
    docker,
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
 * The rendered Compose configuration for the two-service subset.
 *
 * Asked of `docker compose config`, which is the merge Compose will actually
 * perform, because the overlay's source text is not the topology: `ports` merges
 * across files, so an overlay that *looks* like it publishes one loopback port can
 * render as two publications, one of them on every interface. Every run-varying
 * value is supplied exactly as the driver supplies it.
 */
function renderedComposeConfig(): Record<string, { ports?: readonly Record<string, unknown>[] }> {
  const upstreamRoot = path.join(repoRoot, "environments", "otel-demo", "upstream", "extracted-1bf3ef8fbaffc049");
  const overlay = path.join(repoRoot, "environments", "otel-demo", "compose", "erl2-overlay.yaml");
  const extras = path.join(repoRoot, "environments", "otel-demo", "compose", "erl2-otelcol-extras.yaml");
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-name", "erl2-rendered-topology",
      "--project-directory", upstreamRoot,
      "--env-file", path.join(upstreamRoot, ".env"),
      "--file", path.join(upstreamRoot, "compose.yaml"),
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

const RENDER_SKIP: { readonly skip?: string } = dockerAvailable()
  ? {}
  : { skip: "RENDERED TOPOLOGY UNPROVEN: docker compose is not available to render the merge" };

test("COMPOSE-ADV: the RENDERED configuration publishes one loopback port and nothing else", RENDER_SKIP, () => {
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
