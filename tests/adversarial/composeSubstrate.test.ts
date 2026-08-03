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
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertContract,
  type Hash,
  type SubstrateLockV1,
} from "@erl2/contracts";
import { coreHash, developmentKey, sealSigned } from "@erl2/integrity";
import {
  assertNarrowSelector,
  ComposeEnvironmentDriver,
  composeProjectName,
  fileSha256,
  OTEL_DEMO_SERVICES,
  SteppingClock,
  uuidV7From,
  type MaterializedUpstream,
  type RepositoryConfigPaths,
} from "@erl2/core";
import { newStubWorld, StubDockerCli, type StubBehaviour, type StubWorld } from "../support/composeStub.js";
import { ownedTempDir } from "../support/tempDirs.js";

const ARCHETYPE: Hash = coreHash({ archetype: "compose-adversarial" });
const RUN_ID = uuidV7From(1_785_000_000_000, Buffer.alloc(10, 0x51));
const PROJECT = composeProjectName(RUN_ID);
const ARM64: Hash = `sha256:${"a".repeat(64)}`;
const AMD64: Hash = `sha256:${"b".repeat(64)}`;

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
