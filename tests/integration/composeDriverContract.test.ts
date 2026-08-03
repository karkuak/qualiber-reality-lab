/**
 * The `EnvironmentDriver` contract, against the **real** Compose driver
 * (ERL2-OQ-005).
 *
 * `tests/integration/environment.test.ts` proves the contract against the fake
 * driver, which is the whole substrate it describes and therefore cannot be
 * wrong about it. This file proves the same properties against a driver that has
 * to ask Docker — where "read-only" means a probe really left the containers
 * alone, "run-scoped" means Docker really named the objects that way, and "zero
 * residue" means Docker really has nothing left.
 *
 * It provisions one real project and destroys it in a `finally`, by exact name,
 * whatever the outcome.
 *
 * ## Skips are not proof
 *
 * With no daemon this file skips, and a skipped case is recorded as unproven
 * rather than passed. `ERL2_REQUIRE_LIVE_DOCKER=1` converts the skip into a
 * failure for a caller that means to gate on the live claim.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertContract, type SubstrateLockV1 } from "@erl2/contracts";
import { coreHash, developmentKey } from "@erl2/integrity";
import {
  assertOwnedByRun,
  ComposeEnvironmentDriver,
  composeProjectName,
  dockerAvailable,
  materializeUpstream,
  OTEL_DEMO_RELEASE_TAG,
  resourceIdentityHash,
  SpawnDockerCli,
  SteppingClock,
  uuidV7From,
} from "@erl2/core";
import { ownedTempDir } from "../support/tempDirs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LOCK_FILE = path.join(repoRoot, "environments", "otel-demo", "substrate-lock.json");
const OVERLAY = path.join(repoRoot, "environments", "otel-demo", "compose", "erl2-overlay.yaml");
const EXTRAS = path.join(repoRoot, "environments", "otel-demo", "compose", "erl2-otelcol-extras.yaml");
const ARCHIVE = path.join(
  repoRoot,
  "environments",
  "otel-demo",
  "upstream",
  `opentelemetry-demo-${OTEL_DEMO_RELEASE_TAG}.tar.gz`,
);

function unavailable(): string | undefined {
  if (!dockerAvailable()) return "no Docker daemon is reachable";
  if (!existsSync(ARCHIVE)) return "the pinned OpenTelemetry Demo archive is not fetched";
  return undefined;
}

const REASON = unavailable();
const SKIP: { readonly skip?: string } =
  REASON === undefined || process.env["ERL2_REQUIRE_LIVE_DOCKER"] === "1"
    ? {}
    : { skip: `LIVE SUBSTRATE UNPROVEN: ${REASON}` };

test("COMPOSE-CONTRACT-GATE: an unproven live substrate is recorded, never assumed", () => {
  if (REASON !== undefined && process.env["ERL2_REQUIRE_LIVE_DOCKER"] === "1") {
    assert.fail(`ERL2_REQUIRE_LIVE_DOCKER=1 was set but ${REASON}`);
  }
  assert.ok(true);
});

const ARCHETYPE = coreHash({ archetype: "compose-contract" });

function newDriver(runId: string): ComposeEnvironmentDriver {
  const lock = assertContract<SubstrateLockV1>(
    "SubstrateLockV1",
    JSON.parse(readFileSync(LOCK_FILE, "utf8")),
  );
  const substrateRoot = ownedTempDir("erl2-compose-contract-");
  return new ComposeEnvironmentDriver({
    runId,
    clock: new SteppingClock("2026-08-03T00:00:00Z", 1000),
    signingKey: developmentKey("challenge-governor"),
    archetypeHash: ARCHETYPE,
    lock,
    lockHash: coreHash(lock),
    substrateRoot,
    upstream: materializeUpstream({
      archivePath: ARCHIVE,
      expectedArchiveSha256: lock.source_archive.archive_sha256,
      workRoot: substrateRoot,
    }),
    repositoryConfig: { overlayPath: OVERLAY, extrasPath: EXTRAS },
  });
}

/** Removes this run's project by exact name, whatever the test did. */
function reap(project: string): void {
  for (const suffix of ["quote", "otel-collector"]) {
    spawnSync("docker", ["container", "rm", "--force", `${project}-${suffix}`], { encoding: "utf8" });
  }
  for (const suffix of ["challenge", "net"]) {
    spawnSync("docker", ["network", "rm", `${project}-${suffix}`], { encoding: "utf8" });
  }
}

function live(seed: number): { readonly driver: ComposeEnvironmentDriver; readonly runId: string; readonly project: string } {
  const runId = uuidV7From(1_785_000_000_000 + seed, Buffer.alloc(10, seed));
  return { driver: newDriver(runId), runId, project: composeProjectName(runId) };
}

test("COMPOSE-CONTRACT: provision, probe, mutate, restore, destroy against a real daemon", SKIP, () => {
  const { driver, runId, project } = live(0x21);
  try {
    // -- establishSubstrateInstance / substrateInstance ----------------------
    assert.equal(driver.substrateInstance(), undefined, "an unestablished substrate carries no identity");
    const instance = driver.establishSubstrateInstance(runId);
    assert.equal(instance.kind, "compose-project");
    assert.deepEqual(
      driver.establishSubstrateInstance(runId),
      instance,
      "establishing twice must not mint a second identity",
    );
    assert.deepEqual(driver.substrateInstance(), instance);

    // -- provision -----------------------------------------------------------
    const provisioned = driver.provision({
      runId,
      archetypeHash: ARCHETYPE,
      disorderSeedCommitment: coreHash({ seed: "contract" }),
      operationId: "op-provision",
    });
    assert.equal(provisioned.partial, false, "the qualified subset must come up whole");
    assert.equal(provisioned.receipt.status, "succeeded");
    assert.equal(provisioned.inventory.resources.length, 5);
    for (const resource of provisioned.inventory.resources) {
      // Every identity derives from a name Docker really gave the object, and
      // every name embeds this run.
      assertOwnedByRun(runId, resource);
      assert.equal(
        resource.identity_hash,
        resourceIdentityHash(runId, resource.kind, resource.run_scoped_name),
      );
      assert.ok(resource.run_scoped_name.includes(runId));
    }
    assert.deepEqual(
      provisioned.inventory.resources.map((r) => r.kind).sort(),
      ["container", "container", "network", "port", "project"],
    );

    // -- completedOperation, gated on the substrate --------------------------
    assert.equal(
      driver.completedOperation(runId, "op-provision")?.core_hash,
      provisioned.receipt.core_hash,
    );
    assert.equal(driver.completedOperation(runId, "op-never-dispatched"), undefined);

    // -- probe is read-only, and repeatable ----------------------------------
    const inventoryBefore = driver.inspect(runId).resources.map((r) => r.identity_hash);
    const first = driver.probe({ runId, phase: "baseline", operationId: "op-a" });
    const second = driver.probe({ runId, phase: "baseline", operationId: "op-b" });
    assert.equal(first.contamination.detected, false);
    assert.equal(
      first.fingerprint_hash,
      second.fingerprint_hash,
      "two probes of one clean environment must fingerprint identically",
    );
    assert.deepEqual(
      driver.inspect(runId).resources.map((r) => r.identity_hash),
      inventoryBefore,
      "a probe changed the substrate",
    );
    // The fingerprint excludes run identity and time by construction, and
    // includes the *observed* image identity by design.
    assert.ok(first.probes.every((p) => p.passed));
    assert.ok(first.evidence_source_states.every((s) => s.state === "complete"));

    // -- the image observation, against this actual daemon --------------------
    //
    // Every container probe passing already means the two-legged image check
    // succeeded here, because a container whose running bytes cannot be resolved
    // to the locked digest fails its probe. But "the check passed" is worth
    // nothing if the check is vacuous against a real Docker, so the same mapping
    // is re-derived independently, with plain `docker` calls, and compared to the
    // lock. This is what proves the observation is real rather than tautological
    // on Docker Desktop's image store.
    const lock = assertContract<SubstrateLockV1>(
      "SubstrateLockV1",
      JSON.parse(readFileSync(LOCK_FILE, "utf8")),
    );
    const platform = spawnSync("docker", ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], {
      encoding: "utf8",
    }).stdout.trim();
    for (const [serviceId, repository] of [
      ["quote", "ghcr.io/open-telemetry/demo"],
      [
        "otel-collector",
        "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib",
      ],
    ] as const) {
      const locked = lock.images.find((i) => i.service_id === serviceId && i.platform === platform);
      assert.notEqual(locked, undefined, `the lock pins no ${platform} image for ${serviceId}`);
      const reference = `${repository}@${locked?.digest ?? ""}`;

      const containerImageId = spawnSync(
        "docker",
        ["container", "inspect", `${project}-${serviceId}`, "--format", "{{.Image}}"],
        { encoding: "utf8" },
      ).stdout.trim();
      assert.ok(containerImageId.startsWith("sha256:"), `no image id for ${serviceId}: ${containerImageId}`);

      // Leg one: the digest the lock pins resolves, in this daemon's own store, to
      // the id the running container reports.
      const lockedImageId = spawnSync("docker", ["image", "inspect", reference, "--format", "{{.Id}}"], {
        encoding: "utf8",
      }).stdout.trim();
      assert.equal(
        containerImageId,
        lockedImageId,
        `${serviceId} is not running the image the lock pins for ${platform}`,
      );

      // Leg two: the image the container is running publishes that exact
      // repository digest, asked of the running bytes rather than of the lock.
      const repoDigests = JSON.parse(
        spawnSync("docker", ["image", "inspect", containerImageId, "--format", "{{json .RepoDigests}}"], {
          encoding: "utf8",
        }).stdout.trim(),
      ) as string[];
      assert.ok(
        repoDigests.includes(reference),
        `${serviceId}'s running image does not publish ${reference}: ${repoDigests.join(", ")}`,
      );
    }

    // And the probe recorded that observation rather than the lock's expectation:
    // the observation hash must change when the running bytes do, which it cannot
    // if the probe reported a digest it read out of the lock.
    const quoteProbe = first.probes.find((p) => p.probe_id === "probe-container-quote");
    const collectorProbe = first.probes.find((p) => p.probe_id === "probe-container-otel-collector");
    assert.notEqual(
      quoteProbe?.observation_hash,
      collectorProbe?.observation_hash,
      "two services running different images must not share a container observation",
    );

    // -- mutate --------------------------------------------------------------
    assert.deepEqual(driver.observedMutations(runId), []);
    const projectResource = provisioned.inventory.resources.find((r) => r.kind === "project");
    const mutation = driver.mutate({
      runId,
      targetResourceId: (projectResource as { resource_id: string }).resource_id,
      mutationId: "activate-contract",
      operationId: "op-activate",
    });
    assert.equal(mutation.status, "succeeded");
    assert.equal(mutation.compensation_id, "compensate-activate-contract");
    assert.deepEqual(driver.observedMutations(runId), ["activate-contract"]);
    // The receipt names the exact container it touched, not the whole project.
    const endpoint = provisioned.inventory.resources.find((r) =>
      r.run_scoped_name.endsWith("-quote"),
    );
    assert.equal(mutation.target_identity_hash, (endpoint as { identity_hash: string }).identity_hash);

    // -- restore, proven by re-observation ------------------------------------
    const restored = driver.restore({ runId, operationId: "op-restore" });
    assert.equal(restored.status, "succeeded");
    assert.deepEqual(driver.observedMutations(runId), [], "restoration must be observable, not asserted");
    const afterRestore = driver.probe({ runId, phase: "baseline", operationId: "op-c" });
    assert.equal(
      afterRestore.fingerprint_hash,
      first.fingerprint_hash,
      "a restored environment must measure as its baseline again",
    );

    // -- destroy, with residue re-inspected -----------------------------------
    const destroyed = driver.destroy({ runId, operationId: "op-destroy" });
    assert.equal(destroyed.receipt.status, "succeeded");
    assert.deepEqual(destroyed.residue, []);
    assert.deepEqual(driver.inspect(runId).resources, [], "the substrate still holds this run's objects");
    // And Docker itself agrees, asked independently by exact label value.
    const remaining = spawnSync(
      "docker",
      ["ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"],
      { encoding: "utf8" },
    ).stdout.trim();
    assert.equal(remaining, "");
  } finally {
    reap(project);
  }
});

test("COMPOSE-CONTRACT: destroyResource removes exactly one owned object", SKIP, () => {
  const { driver, runId, project } = live(0x22);
  try {
    driver.establishSubstrateInstance(runId);
    const provisioned = driver.provision({
      runId,
      archetypeHash: ARCHETYPE,
      disorderSeedCommitment: coreHash({ seed: "contract-one" }),
      operationId: "op-provision",
    });
    const collector = provisioned.inventory.resources.find((r) =>
      r.run_scoped_name.endsWith("-otel-collector"),
    ) as { resource_id: string; identity_hash: string };
    const receipt = driver.destroyResource({
      runId,
      resourceId: collector.resource_id,
      operationId: "op-destroy-one",
    });
    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.target_identity_hash, collector.identity_hash);
    const remaining = driver.inspect(runId).resources.map((r) => r.run_scoped_name);
    assert.equal(remaining.includes(`${project}-otel-collector`), false);
    assert.equal(remaining.includes(`${project}-quote`), true, "only the named object may be removed");
  } finally {
    reap(project);
  }
});

test("COMPOSE-CONTRACT: a driver bound to one run refuses to inspect another", SKIP, () => {
  const { driver, runId, project } = live(0x23);
  try {
    driver.establishSubstrateInstance(runId);
    const other = uuidV7From(1_785_000_000_099, Buffer.alloc(10, 0x24));
    assert.throws(
      () => driver.inspect(other),
      (error: unknown) => (error as { code: string }).code === "ENV_FOREIGN_RESOURCE_REJECTED",
    );
  } finally {
    reap(project);
  }
});
