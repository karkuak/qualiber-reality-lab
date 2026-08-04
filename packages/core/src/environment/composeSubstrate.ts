/**
 * The qualified OpenTelemetry Demo subset, and its runtime re-admission
 * (ERL2-OQ-005).
 *
 * ## What the subset is, and why it is this small
 *
 * Two services out of the upstream demo's twenty-two: `quote` and
 * `otel-collector`. That is the smallest selection from the *official* modular
 * `compose.yaml` that still exercises the whole environment journey —
 *
 *   - `quote` is a real application with a reachable HTTP endpoint and real
 *     OpenTelemetry auto-instrumentation. It declares exactly one dependency,
 *     `otel-collector`, so selecting it selects nothing else;
 *   - `otel-collector` receives that telemetry over OTLP and exports it through
 *     the base configuration's `debug` exporter, which makes the collector path
 *     *observable* from the collector's own stdout rather than inferred;
 *   - a Compose pause of the run's own `quote` container is a deterministic,
 *     exactly-scoped mutation whose inverse is an unpause, and both are visible
 *     in container state;
 *   - `docker compose down` removes both containers and the network, leaving a
 *     project whose emptiness can be re-inspected by exact label.
 *
 * Nothing here is a container platform. The service graph is a constant, the
 * mutation is one named operation on one named container, and there is no
 * mechanism for describing a different environment.
 *
 * ## Two repository-owned configuration files
 *
 * The upstream `compose.yaml` is used unmodified. Two files are layered on top,
 * both owned by this repository and both hashed into the substrate lock:
 *
 *   - `erl2-overlay.yaml` replaces the upstream fixed `container_name`s and the
 *     fixed network name with run-scoped ones, pins both images to the digest
 *     the lock records for the executing platform, and adds the run's labels.
 *     Every run-varying value arrives through a Compose interpolation variable,
 *     so the file itself is static and its hash is stable across runs.
 *   - `erl2-otelcol-extras.yaml` uses upstream's own documented extras seam to
 *     reduce the collector's pipelines to the OTLP receivers and the debug
 *     exporter. The base configuration's other receivers — `docker_stats`,
 *     `host_metrics`, `postgresql`, `redis`, `nginx`, `prometheus/ad` — describe
 *     services this subset does not run, and a collector component that is not
 *     referenced by a pipeline is never instantiated. Dropping them is what
 *     makes the Docker socket and host filesystem mounts upstream declares inert;
 *     both are additionally bound to `/dev/null`, so the collector reaches
 *     neither. No container in the subset is privileged and none is granted a
 *     capability.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  CODES,
  Erl2Error,
  type Hash,
  type SubstrateLockV1,
} from "@erl2/contracts";
import type { DockerCli } from "./dockerCli.js";
import { SpawnDockerCli } from "./dockerCli.js";
import type { ObservedSubstrate, Platform } from "./substrateLock.js";

/** The substrate this module qualifies. Matches `SubstrateLockV1.substrate_id`. */
export const OTEL_DEMO_SUBSTRATE_ID = "opentelemetry-demo";

/** The upstream release this subset is pinned to. Never a branch, never a floating tag. */
export const OTEL_DEMO_RELEASE_TAG = "3.0.0";

export interface ComposeServiceSpec {
  /** The upstream Compose service name, and the lock's `service_id`. */
  readonly serviceId: string;
  /** The registry repository, without any tag. A tag is never resolved at runtime. */
  readonly imageRepository: string;
  /** The Compose interpolation variable the overlay reads the pinned digest from. */
  readonly imageVariable: string;
  /** The Compose interpolation variable the overlay reads the container name from. */
  readonly containerVariable: string;
  /** The container port the subset publishes, when this service is the endpoint. */
  readonly containerPort?: number;
}

/**
 * The service graph, in provisioning order.
 *
 * A constant, not configuration. Adding a service here is a change to the
 * qualified subset and therefore a change to the lock.
 */
export const OTEL_DEMO_SERVICES: readonly ComposeServiceSpec[] = [
  {
    serviceId: "otel-collector",
    imageRepository:
      "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib",
    imageVariable: "ERL2_IMAGE_OTEL_COLLECTOR",
    containerVariable: "ERL2_CONTAINER_OTEL_COLLECTOR",
  },
  {
    serviceId: "quote",
    imageRepository: "ghcr.io/open-telemetry/demo",
    imageVariable: "ERL2_IMAGE_QUOTE",
    containerVariable: "ERL2_CONTAINER_QUOTE",
    containerPort: 8090,
  },
];

/** The service whose endpoint the subject reaches, and whose container is the mutation target. */
export const OTEL_DEMO_ENDPOINT_SERVICE_ID = "quote";

/** The path the endpoint service answers. Used only by the reference adapter. */
export const OTEL_DEMO_ENDPOINT_PATH = "/getquote";

/** Files inside the pinned archive that the environment actually applies. */
export const UPSTREAM_APPLIED_CONFIG_PATHS = [
  "compose.yaml",
  ".env",
  "src/otel-collector/otelcol-config.yml",
] as const;

/** The two repository-owned files layered over the upstream configuration. */
export interface RepositoryConfigPaths {
  readonly overlayPath: string;
  readonly extrasPath: string;
}

export function fileSha256(file: string): Hash {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (cause) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_UNREADABLE,
      `an applied substrate configuration file could not be read: ${path.basename(file)}`,
      { owner: "lab", cause },
    );
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * The image platform this host actually executes.
 *
 * Asked of the daemon, not of `process.platform`: Docker Desktop on an arm64 Mac
 * runs a Linux VM, so the host is `darwin` and the images are `linux/arm64`.
 * Confusing the two is exactly the error the OQ-005 platform correction fixes.
 */
export function observeExecutingPlatform(docker: DockerCli = new SpawnDockerCli()): Platform {
  const result = docker.run({
    args: ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"],
    timeoutMs: 30_000,
  });
  if (result.status !== 0) {
    throw new Erl2Error(
      CODES.ENV_PROVISION_FAILED,
      "the Docker daemon did not report its image platform; the Compose driver cannot admit a substrate it cannot identify",
      { owner: "lab" },
    );
  }
  const observed = result.stdout.trim();
  if (observed !== "linux/amd64" && observed !== "linux/arm64") {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_PLATFORM_MISSING,
      `this daemon executes ${observed} images; the qualified OTel Demo subset pins linux/amd64 and linux/arm64 only`,
      { owner: "lab" },
    );
  }
  return observed;
}

/** The pinned digest for one service on one platform, read from the lock and never from a tag. */
export function lockedDigest(lock: SubstrateLockV1, serviceId: string, platform: Platform): Hash {
  const entry = lock.images.find((image) => image.service_id === serviceId && image.platform === platform);
  if (entry === undefined) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_PLATFORM_MISSING,
      `the substrate lock pins no ${platform} image for ${serviceId}`,
      { owner: "lab" },
    );
  }
  return entry.digest;
}

/** `repository@sha256:...`. The only image reference form this driver ever emits. */
export function pinnedImageReference(
  lock: SubstrateLockV1,
  service: ComposeServiceSpec,
  platform: Platform,
): string {
  return `${service.imageRepository}@${lockedDigest(lock, service.serviceId, platform)}`;
}

export interface MaterializedUpstream {
  /** The Compose project directory: the three applied upstream files, and nothing else. */
  readonly root: string;
  readonly composeFile: string;
  readonly envFile: string;
  readonly collectorConfigFile: string;
  readonly archiveSha256: Hash;
}

/**
 * Unpacks exactly the applied configuration out of the digest-pinned archive.
 *
 * Three files, named individually. The rest of the release — every Dockerfile,
 * every service source tree — is never written to disk, because the subset never
 * builds anything: images come from the registry by digest and `--no-build`
 * makes a fallback build a failure rather than a silent substitution.
 *
 * The archive is hashed *before* it is opened, so a substituted archive is
 * refused rather than unpacked.
 */
export function materializeUpstream(options: {
  readonly archivePath: string;
  readonly expectedArchiveSha256: Hash;
  readonly workRoot: string;
  readonly docker?: DockerCli;
  readonly extract?: (archive: string, into: string, members: readonly string[]) => void;
}): MaterializedUpstream {
  if (!existsSync(options.archivePath)) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_UNREADABLE,
      `the pinned OpenTelemetry Demo ${OTEL_DEMO_RELEASE_TAG} archive is not present; fetch it with ` +
        "`node scripts/qualify-otel-demo.mjs --fetch-only` before provisioning a Compose environment",
      { owner: "lab" },
    );
  }
  const observed = fileSha256(options.archivePath);
  if (observed !== options.expectedArchiveSha256) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_DIGEST_MISMATCH,
      "the fetched OpenTelemetry Demo archive does not hash to the digest the substrate lock pins; " +
        "a moved release archive invalidates the run before provisioning",
      { owner: "lab" },
    );
  }
  const root = path.join(path.resolve(options.workRoot), `upstream-${observed.slice("sha256:".length, "sha256:".length + 16)}`);
  const composeFile = path.join(root, "compose.yaml");
  const envFile = path.join(root, ".env");
  const collectorConfigFile = path.join(root, "src", "otel-collector", "otelcol-config.yml");
  if (!existsSync(composeFile) || !existsSync(envFile) || !existsSync(collectorConfigFile)) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const extract = options.extract ?? tarExtract;
    extract(path.resolve(options.archivePath), root, [
      ...UPSTREAM_APPLIED_CONFIG_PATHS,
    ]);
  }
  return { root, composeFile, envFile, collectorConfigFile, archiveSha256: observed };
}

/** `tar` with an argv array and no shell, for the same reason `docker` is. */
function tarExtract(archive: string, into: string, members: readonly string[]): void {
  const cli = new SpawnDockerCli("tar");
  const result = cli.run({
    args: [
      "-xzf",
      archive,
      "-C",
      into,
      "--strip-components=1",
      ...members.map((member) => `*/${member}`),
    ],
    timeoutMs: 120_000,
  });
  if (result.status !== 0) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_UNREADABLE,
      "the pinned OpenTelemetry Demo archive could not be unpacked",
      { owner: "lab" },
    );
  }
}

/**
 * Re-observes what this host is actually about to run, for
 * `assertObservedMatchesLock`.
 *
 * Three observations, none of which consults a tag:
 *
 *   - the **archive**, hashed from the bytes on disk;
 *   - the **configuration**, hashed from the five files that are actually
 *     applied — the three unpacked upstream ones and the two repository-owned
 *     overlays;
 *   - the **images**, per platform. For the platform this daemon executes, the
 *     digest is read back out of the local image store *after* the pull, so the
 *     observation is of bytes that exist here. For the other required platform,
 *     the registry is asked what the pinned digest describes, and the platform it
 *     answers with is what gets recorded — so a lock whose `linux/amd64` slot
 *     holds an arm64 manifest is observed as arm64 and refused by the bijective
 *     comparison, rather than being taken at its word.
 */
export function observeComposeSubstrate(options: {
  readonly lock: SubstrateLockV1;
  readonly upstream: MaterializedUpstream;
  readonly repositoryConfig: RepositoryConfigPaths;
  readonly executingPlatform: Platform;
  readonly requiredPlatforms: readonly Platform[];
  readonly docker: DockerCli;
}): ObservedSubstrate {
  const configHashes = [
    fileSha256(options.upstream.composeFile),
    fileSha256(options.upstream.envFile),
    fileSha256(options.upstream.collectorConfigFile),
    fileSha256(options.repositoryConfig.overlayPath),
    fileSha256(options.repositoryConfig.extrasPath),
  ];
  const images: { service_id: string; platform: Platform; digest: Hash }[] = [];
  for (const service of OTEL_DEMO_SERVICES) {
    for (const platform of options.requiredPlatforms) {
      const pinned = lockedDigest(options.lock, service.serviceId, platform);
      const reference = `${service.imageRepository}@${pinned}`;
      images.push({
        service_id: service.serviceId,
        platform:
          platform === options.executingPlatform
            ? observeLocalImagePlatform(options.docker, reference)
            : observeRegistryImagePlatform(options.docker, reference),
        digest: pinned,
      });
    }
  }
  return { archiveSha256: options.upstream.archiveSha256, images, configHashes };
}

/** The platform of an image that is present in this daemon's local store, by digest. */
function observeLocalImagePlatform(docker: DockerCli, reference: string): Platform {
  const result = docker.run({
    args: ["image", "inspect", reference, "--format", "{{.Os}}/{{.Architecture}}"],
    timeoutMs: 60_000,
  });
  if (result.status !== 0) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_DIGEST_MISMATCH,
      "an image the substrate lock pins for this platform is not present after the pull; " +
        "the run cannot attest against bytes it does not hold",
      { owner: "lab" },
    );
  }
  return asPlatform(result.stdout.trim());
}

/** The platform the registry says a digest-pinned manifest describes. No tag, no download. */
function observeRegistryImagePlatform(docker: DockerCli, reference: string): Platform {
  const result = docker.run({
    args: [
      "buildx",
      "imagetools",
      "inspect",
      reference,
      "--format",
      "{{.Image.OS}}/{{.Image.Architecture}}",
    ],
    timeoutMs: 120_000,
  });
  if (result.status !== 0) {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_DIGEST_MISMATCH,
      "a digest the substrate lock pins for a non-executing platform could not be resolved in the registry",
      { owner: "lab" },
    );
  }
  return asPlatform(result.stdout.trim());
}

/**
 * A platform string the lock's enum can hold.
 *
 * An observation outside the enum is not coerced: it is reported as the
 * mismatch it is, because "I do not recognise this platform" and "this is the
 * platform you pinned" are the two answers this function exists to keep apart.
 */
function asPlatform(observed: string): Platform {
  if (observed === "linux/amd64" || observed === "linux/arm64" || observed === "darwin/arm64") {
    return observed;
  }
  throw new Erl2Error(
    CODES.ENV_SUBSTRATE_PLATFORM_MISSING,
    `an image the lock pins reports platform ${observed}, which no substrate lock platform names`,
    { owner: "lab" },
  );
}
