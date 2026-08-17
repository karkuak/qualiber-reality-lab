/**
 * TASK-LOCAL substrate driver harness — evidence-retention task 2026-08-16.
 *
 * This script is NOT production code and must never be promoted into either
 * repository. It exists only because the public governed provisioning command
 * requires registry and acquired-run state unrelated to an owner-trusted local
 * observation. It constructs the EXISTING, UNMODIFIED ComposeEnvironmentDriver
 * from @erl2/core and calls its existing `provision` / `inspect` / `destroy`
 * operations. It adds no capability the driver does not already have.
 *
 * Usage:
 *   node task-local-substrate.mjs provision <substrateRoot> <runIdFile> <outDir>
 *   node task-local-substrate.mjs destroy   <substrateRoot> <runIdFile> <outDir>
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assertContract } from "@erl2/contracts";
import { coreHash, developmentKey } from "@erl2/integrity";
import {
  ComposeEnvironmentDriver,
  composeProjectName,
  dockerAvailable,
  materializeUpstream,
  OTEL_DEMO_RELEASE_TAG,
  SpawnDockerCli,
  SteppingClock,
  uuidV7From,
  trustedVolumeName,
} from "@erl2/core";

const LAB = "/Users/karthik/Developer/qualiber-reality-lab-tlo";
const LOCK_FILE = path.join(LAB, "environments", "otel-demo", "substrate-lock.json");
const OVERLAY = path.join(LAB, "environments", "otel-demo", "compose", "erl2-overlay.yaml");
const EXTRAS = path.join(LAB, "environments", "otel-demo", "compose", "erl2-otelcol-extras.yaml");
const ARCHIVE = path.join(
  LAB,
  "environments",
  "otel-demo",
  "upstream",
  `opentelemetry-demo-${OTEL_DEMO_RELEASE_TAG}.tar.gz`,
);

const ARCHETYPE = coreHash({ archetype: "qualiber-trusted-local-product-run-20260816" });

const [, , mode, substrateRoot, runIdFile, outDir] = process.argv;
if (!mode || !substrateRoot || !runIdFile || !outDir) {
  console.error("usage: task-local-substrate.mjs <provision|destroy> <substrateRoot> <runIdFile> <outDir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

if (!dockerAvailable()) {
  console.error("REFUSED: no Docker daemon is reachable");
  process.exit(3);
}
if (!existsSync(ARCHIVE)) {
  console.error("REFUSED: the pinned OpenTelemetry Demo archive is not present");
  process.exit(3);
}

// The run id is minted once, on provision, and re-read on destroy so both
// processes address the same objects by exact name.
let runId;
if (mode === "provision") {
  // Deterministic and task-scoped; no ambient randomness.
  runId = uuidV7From(1_787_000_000_000, Buffer.from("qlb20260816", "utf8").subarray(0, 10));
  writeFileSync(runIdFile, runId, "utf8");
} else {
  runId = readFileSync(runIdFile, "utf8").trim();
}
const project = composeProjectName(runId);

const lock = assertContract("SubstrateLockV1", JSON.parse(readFileSync(LOCK_FILE, "utf8")));
mkdirSync(substrateRoot, { recursive: true });

const driver = new ComposeEnvironmentDriver({
  runId,
  clock: new SteppingClock("2026-08-16T00:00:00Z", 1000),
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

const write = (name, value) =>
  writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");

const docker = (args) => spawnSync("docker", args, { encoding: "utf8" });

if (mode === "provision") {
  const request = {
    runId,
    archetypeHash: ARCHETYPE,
    disorderSeedCommitment: coreHash({ seed: "qualiber-trusted-local-product-run-20260816" }),
    operationId: "op-provision",
  };
  write("provision-request.json", {
    ...request,
    note: "the exact ProvisionRequest handed to the unmodified ComposeEnvironmentDriver",
    project,
    substrate_lock_file: LOCK_FILE,
    overlay: OVERLAY,
    extras: EXTRAS,
    archive: ARCHIVE,
  });

  driver.establishSubstrateInstance(runId);
  const provisioned = driver.provision(request);
  write("provision-result.json", provisioned);
  write("substrate-instance.json", driver.substrateInstance());

  // Independent, plain-docker discovery of the published loopback port.
  const portOut = docker(["port", `${project}-quote`, "8090/tcp"]).stdout.trim();
  const line = portOut.split("\n").find((l) => l.startsWith("127.0.0.1:"));
  if (!line) {
    console.error(`REFUSED: no loopback publication for ${project}-quote: ${portOut}`);
    process.exit(4);
  }
  const publishedPort = Number(line.split(":")[1]);

  const platform = docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]).stdout.trim();
  const images = {};
  for (const [serviceId, repository] of [
    ["quote", "ghcr.io/open-telemetry/demo"],
    [
      "otel-collector",
      "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib",
    ],
  ]) {
    const locked = lock.images.find((i) => i.service_id === serviceId && i.platform === platform);
    const reference = `${repository}@${locked.digest}`;
    images[serviceId] = {
      platform,
      locked_digest: locked.digest,
      reference,
      locked_image_id: docker(["image", "inspect", reference, "--format", "{{.Id}}"]).stdout.trim(),
      container_image_id: docker([
        "container",
        "inspect",
        `${project}-${serviceId}`,
        "--format",
        "{{.Image}}",
      ]).stdout.trim(),
      repo_digests: JSON.parse(
        docker(["image", "inspect", reference, "--format", "{{json .RepoDigests}}"]).stdout.trim(),
      ),
    };
    images[serviceId].running_bytes_match_lock =
      images[serviceId].locked_image_id === images[serviceId].container_image_id &&
      images[serviceId].repo_digests.includes(reference);
  }
  write("resolved-image-digests.json", { daemon_platform: platform, images });

  write("run-scoped-resources.json", {
    run_id: runId,
    project,
    trusted_volume: trustedVolumeName(runId),
    resources: provisioned.inventory.resources,
  });

  const quoteInspect = JSON.parse(
    docker(["container", "inspect", `${project}-quote`, "--format", "{{json .}}"]).stdout.trim(),
  );
  write("quote-container-identity.json", {
    name: `${project}-quote`,
    id: quoteInspect.Id,
    image: quoteInspect.Image,
    state: quoteInspect.State?.Status,
    labels: quoteInspect.Config?.Labels,
    network_ports: quoteInspect.NetworkSettings?.Ports,
  });

  const endpoint = { host: "127.0.0.1", port: publishedPort, container: `${project}-quote` };
  write("published-endpoint.json", endpoint);
  console.log(JSON.stringify({ runId, project, ...endpoint }));
} else {
  const destroyed = driver.destroy({ runId, operationId: "op-destroy" });
  write("destroy-result.json", destroyed);
  write("post-destroy-inventory.json", driver.inspect(runId));
  console.log(
    JSON.stringify({
      runId,
      project,
      status: destroyed.receipt.status,
      residue: destroyed.residue,
    }),
  );
}
