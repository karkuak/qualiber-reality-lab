/**
 * The Compose environment driver (design v2 §8, ERL2-OQ-005).
 *
 * One concrete `EnvironmentDriver` over one concrete substrate: Docker Compose
 * running the qualified two-service OpenTelemetry Demo subset described in
 * `composeSubstrate.ts`. It is not a container platform and there is no
 * abstraction above `EnvironmentDriver` — the service graph is a constant, the
 * mutation is one named operation on one named container, and every Docker call
 * goes through `dockerCli.ts` as an argv array with no shell.
 *
 * ## Everything it reports, it observed
 *
 * The fake driver may answer from its own memory of what it did, because it *is*
 * the substrate. This driver is not, so it never does. `inspect` asks Docker what
 * exists, `probe` asks Docker what state those objects are in, `observedMutations`
 * asks Docker whether the activation is still applied, and the residue check after
 * teardown asks Docker again rather than believing `docker compose down`'s exit
 * status. A receipt records the before and after of an observation, not of an
 * intention.
 *
 * ## Adoption is gated on the substrate, not on the log
 *
 * `completedOperation` is what lets a restarted run *adopt* a prior dispatch
 * instead of repeating it (ADR-ERL2-024 §4.3), and adopting the wrong thing is
 * worse than failing closed. The receipt bytes have to be durable — they are
 * signed into the run's evidence, so they cannot be re-derived with fresh
 * timestamps — but the *decision* to adopt is never taken from the durable log
 * alone. Each operation declares what its effect looks like in Docker, and a
 * stored receipt is offered only while the substrate still shows that effect:
 *
 *   - `op-provision` — the run's whole verified graph is observed: both containers
 *     proven this run's by label and proven to be running the locked images, plus
 *     the network and the published port;
 *   - `op-activate`  — the *verified* endpoint container is observed on the
 *     challenge network;
 *   - `op-restore`   — it is verified, it is not attached, and the challenge
 *     network no longer exists;
 *   - `op-destroy`   — nothing carrying the run's exact project label exists.
 *
 * A log that claims an operation the substrate contradicts answers `undefined`,
 * which fails closed into re-dispatch or refusal. This is the difference between
 * "durable" and "substrate-observable", and it is the whole reason the in-memory
 * map was wrong in the first place.
 *
 * ## Nothing broad is ever discovered or deleted
 *
 * Every lookup is by an exact object name that embeds the run id, or by an exact
 * label *value* that embeds it (`com.erl2.run_id=<uuid>`,
 * `com.docker.compose.project=erl2-<uuid>`). There is no prefix match, no glob,
 * no `docker compose ls`, and no path that consults ambient Compose state. The
 * whole-environment teardown is `docker compose down` scoped to this run's own
 * project name; the per-resource path deletes exactly one named object after
 * `assertOwnedByRun` and `assertNarrowSelector` have both passed for it.
 *
 * ## An expected name is not ownership
 *
 * Reaching a container by the name this run would have given it proves only that
 * *something* answers to that name. Before any expected-name container is treated
 * as this run's, Docker has to prove two independent things about the live object
 * (`observeExpectedContainers`):
 *
 *   - **whose it is** — all three ownership labels carry this run's exact values:
 *     `com.erl2.run_id=<this run>`, `com.erl2.driver_id=compose-driver`,
 *     `com.docker.compose.project=<this run's project>`. A missing label is a
 *     mismatch, because `""` is not the expected value;
 *   - **what it is running** — the container's own image, resolved through the
 *     daemon, publishes the exact repository digest the lock pins for that
 *     service on the executing platform, *and* the daemon resolves that pinned
 *     reference to the same image id the container reports. Both legs are read
 *     back out of live Docker state; neither is the lock's own expected digest
 *     copied into an observation, which would have agreed with the lock by
 *     construction. When Docker cannot answer either leg, the verdict is "not
 *     proven", never "assumed".
 *
 * A container that fails either check is still *reported* — cleanup has to know
 * it exists — but under an identity that deliberately does not derive from
 * `resourceIdentityHash`, so `assertOwnedByRun` refuses it on every destructive
 * path. It also fails its baseline probe, counts as preexisting residue, and
 * withholds the endpoint record; and because provision adoption is gated on the
 * same verified graph, a receipt cannot carry a substituted container forward.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertContract,
  CODES,
  Erl2Error,
  parseStrictJson,
  type EnvironmentBaselineFingerprintV1,
  type EnvironmentDriverManifestV1,
  type EnvironmentOperationReceiptV1,
  type EnvironmentProbeResultV1,
  type EnvironmentResourceInventoryV1,
  type EnvironmentResourceV1,
  type Hash,
  type SubstrateLockV1,
} from "@erl2/contracts";
import { coreHash, domainHash, HASH_DOMAINS, sealSigned, type SigningKey } from "@erl2/integrity";
import type { Clock } from "../runtime/seams.js";
import { buildBaselineFingerprint, type EvidenceSourceState } from "./cleanControl.js";
import {
  observeExecutingPlatform,
  OTEL_DEMO_ENDPOINT_SERVICE_ID,
  OTEL_DEMO_SERVICES,
  OTEL_DEMO_SUBSTRATE_ID,
  observeComposeSubstrate,
  pinnedImageReference,
  type ComposeServiceSpec,
  type MaterializedUpstream,
  type RepositoryConfigPaths,
} from "./composeSubstrate.js";
import { SpawnDockerCli, type DockerCli } from "./dockerCli.js";
import {
  excerptCollectorTelemetry,
  parseCollectorTelemetry,
  type AttributableTelemetryMaterial,
  type AttributableTelemetryObserver,
} from "./telemetryObservation.js";
import {
  assertDriverEnabled,
  assertNarrowSelector,
  assertOperationSupported,
  assertOwnedByRun,
  resourceIdentityHash,
  type DestroyRequest,
  type DestroyResourceRequest,
  type DestroyResult,
  type EnvironmentDriver,
  type MutateRequest,
  type ProbeRequest,
  type ProvisionRequest,
  type ProvisionResult,
  type RestoreRequest,
} from "./driver.js";
import { assertObservedMatchesLock, composeDriverManifestBody, REQUIRED_PLATFORMS, type Platform } from "./substrateLock.js";
import type { SubstrateInstance } from "./substrate.js";

/** Labels this driver puts on every object it creates. Exact values, never patterns. */
export const ERL2_RUN_LABEL = "com.erl2.run_id";
export const ERL2_DRIVER_LABEL = "com.erl2.driver_id";
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

export const COMPOSE_DRIVER_ID = "compose-driver";
export const COMPOSE_SUBSTRATE_KIND = "compose-project";

/**
 * The only host the endpoint record may name, and the only one the egress policy
 * will accept.
 *
 * Written here and re-required at every read, so the two ends of the record agree
 * on one exact literal rather than on "something loopback-ish".
 */
export const LOOPBACK_HOST = "127.0.0.1";

/** The resource kinds this driver creates and is accountable for. */
const RESOURCE_KINDS = ["project", "network", "container", "port", "volume"] as const;

const UP_TIMEOUT_SECONDS = 240;
const DOWN_TIMEOUT_SECONDS = 30;

/**
 * How long `observeAttributableTelemetry` waits for the collector's exporter to
 * flush before recording whatever is there. Bounded: a run whose telemetry
 * never arrives spends at most attempts × delay here and then retains the
 * honest zero the validity gate refuses.
 */
const TELEMETRY_SETTLE_ATTEMPTS = 20;
const TELEMETRY_SETTLE_DELAY_MS = 1_000;

export interface ComposeDriverOptions {
  readonly runId: string;
  readonly clock: Clock;
  readonly signingKey: SigningKey;
  readonly archetypeHash: Hash;
  /** A lock this caller has already qualified and signature-verified. */
  readonly lock: SubstrateLockV1;
  readonly lockHash: Hash;
  /** The run-local durable root for the identity marker, the operation log and the endpoint record. */
  readonly substrateRoot: string;
  readonly upstream: MaterializedUpstream;
  readonly repositoryConfig: RepositoryConfigPaths;
  readonly evidenceSourceIds?: readonly string[];
  readonly docker?: DockerCli;
}

// -- durable, substrate-anchored run state -----------------------------------

interface AppliedMutation {
  readonly mutation_id: string;
  readonly container: string;
  readonly target_identity_hash: Hash;
}

interface ComposeRunState {
  readonly version: 1;
  readonly run_id: string;
  readonly project: string;
  readonly mutations: readonly AppliedMutation[];
  readonly operations: Readonly<Record<string, EnvironmentOperationReceiptV1>>;
}

interface IdentityMarker {
  readonly kind: string;
  readonly engine_id: string;
  readonly project: string;
  readonly established_by_run: string;
}

/**
 * The driver's durable record, beside the substrate it describes.
 *
 * It holds two things and no verdicts: the receipts of operations already
 * completed, and which mutation id was applied to which container. Both are
 * *bytes that cannot be re-derived* — a receipt carries timestamps that are
 * signed into evidence, and a mutation id names a challenge. Everything that can
 * be observed is observed instead, and the reader above gates every use of this
 * file on that observation.
 */
class ComposeRunStore {
  private readonly root: string;
  private readonly runId: string;
  private readonly project: string;

  constructor(root: string, runId: string, project: string) {
    this.root = path.resolve(root);
    this.runId = runId;
    this.project = project;
  }

  private file(): string {
    return path.join(this.root, `${Buffer.from(this.runId, "utf8").toString("base64url")}.compose.json`);
  }

  private markerFile(): string {
    return path.join(this.root, `${Buffer.from(this.runId, "utf8").toString("base64url")}.compose-instance.json`);
  }

  /** The read-only directory the adapter host mounts to reach the endpoint. */
  endpointDirectory(): string {
    return path.join(this.root, `${Buffer.from(this.runId, "utf8").toString("base64url")}.compose-endpoint`);
  }

  private read(file: string, what: string): unknown | undefined {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (cause) {
      // Only absence means "never written". Everything else is a fault, for the
      // same reason it is in `substrate.ts`: an unreadable substrate is not an
      // empty one, and a teardown over an unreadable one is not a clean teardown.
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Erl2Error(CODES.ENV_SUBSTRATE_UNREADABLE, `${what} exists but could not be read`, {
        owner: "lab",
        cause,
      });
    }
    try {
      return parseStrictJson(text);
    } catch (cause) {
      throw new Erl2Error(CODES.ENV_SUBSTRATE_UNREADABLE, `${what} is not a readable document`, {
        owner: "lab",
        cause,
      });
    }
  }

  private write(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch (cause) {
      throw new Erl2Error(
        CODES.ENV_SUBSTRATE_UNREADABLE,
        "the Compose driver's durable record could not be written",
        { owner: "lab", cause },
      );
    }
  }

  state(): ComposeRunState {
    const value = this.read(this.file(), "the Compose driver's run record");
    if (value === undefined) {
      return { version: 1, run_id: this.runId, project: this.project, mutations: [], operations: {} };
    }
    const record = value as Partial<ComposeRunState>;
    if (
      record.version !== 1 ||
      record.run_id !== this.runId ||
      !Array.isArray(record.mutations) ||
      typeof record.operations !== "object" ||
      record.operations === null ||
      Array.isArray(record.operations)
    ) {
      throw new Erl2Error(
        CODES.ENV_SUBSTRATE_UNREADABLE,
        "the Compose driver's run record does not have the shape of a run record",
        { owner: "lab" },
      );
    }
    return {
      version: 1,
      run_id: this.runId,
      project: this.project,
      mutations: record.mutations,
      operations: record.operations,
    };
  }

  put(patch: Partial<Pick<ComposeRunState, "mutations" | "operations">>): void {
    this.write(this.file(), { ...this.state(), ...patch });
  }

  marker(): IdentityMarker | undefined {
    const value = this.read(this.markerFile(), "the Compose substrate's identity marker");
    if (value === undefined) return undefined;
    const record = value as Partial<IdentityMarker>;
    if (
      typeof record.kind !== "string" ||
      typeof record.engine_id !== "string" ||
      typeof record.project !== "string" ||
      typeof record.established_by_run !== "string"
    ) {
      throw new Erl2Error(
        CODES.ENV_SUBSTRATE_UNREADABLE,
        "the Compose substrate's identity marker is malformed; its identity cannot be established",
        { owner: "lab" },
      );
    }
    return record as IdentityMarker;
  }

  writeMarker(marker: IdentityMarker): void {
    this.write(this.markerFile(), marker);
  }

  writeEndpoint(record: unknown): void {
    this.write(path.join(this.endpointDirectory(), "endpoint.json"), record);
  }

  /** Deletes the endpoint record. Absent is success: the point is that it is gone. */
  removeEndpoint(): void {
    rmSync(path.join(this.endpointDirectory(), "endpoint.json"), { force: true });
  }
}

// -- what Docker says exists --------------------------------------------------

interface ObservedContainer {
  readonly name: string;
  readonly networks: readonly string[];
  readonly state: string;
  readonly paused: boolean;
  readonly health: string;
  readonly restartCount: number;
  /**
   * The image *id* Docker reports for the bytes this container runs — `.Image`,
   * which is a content id and not a repository digest. The mapping from it to a
   * locked digest is what `observeImageIdentity` has to establish.
   */
  readonly imageId: string;
  readonly runLabel: string;
  readonly driverLabel: string;
  readonly projectLabel: string;
  /** Every host binding Docker reports, kept whole rather than reduced to one port. */
  readonly bindings: readonly ObservedPortBinding[];
}

/**
 * One host binding Docker reports for a container.
 *
 * `containerPort` keeps Docker's own spelling (`"8090/tcp"`) and `hostIp` is
 * retained rather than discarded, because "some port is published" and "*this*
 * container port is published on loopback" are the two answers that have to stay
 * apart: the first was what the driver used to compute, and it is satisfied by a
 * binding on a different container port, or on `0.0.0.0`.
 */
interface ObservedPortBinding {
  readonly containerPort: string;
  readonly hostIp: string;
  readonly hostPort: number;
}

/**
 * The container port the subset's endpoint answers on, in Docker's own spelling.
 *
 * Authorization is bound to this exact key. Accepting the recorded host port under
 * whatever container port happened to be published would let a second published
 * port — upstream's, a future overlay's, or one Docker assigned to something
 * else — stand in for the endpoint.
 */
export const OTEL_DEMO_ENDPOINT_CONTAINER_PORT = "8090/tcp";

function observedBindings(
  ports: Record<string, { HostIp?: string; HostPort?: string }[] | null> | undefined,
): readonly ObservedPortBinding[] {
  const bindings: ObservedPortBinding[] = [];
  for (const [containerPort, list] of Object.entries(ports ?? {})) {
    for (const binding of list ?? []) {
      const hostPort = Number.parseInt(binding.HostPort ?? "", 10);
      if (!isValidHostPort(hostPort)) continue;
      bindings.push({ containerPort, hostIp: binding.HostIp ?? "", hostPort });
    }
  }
  return bindings;
}

/**
 * The loopback host port bound for one exact container port, or `undefined`.
 *
 * Three requirements, all of them exact: the container port key matches, the host
 * IP is the one canonical loopback literal, and the host port is a real port.
 * `0.0.0.0` and `::` are refused rather than treated as "includes loopback" — a
 * binding on every interface is reachable from the local network, which is a
 * different exposure than the one the substrate is qualified for. A missing
 * `HostIp` reads as `""`, which is not the literal, so absent and wrong are one
 * refusal.
 */
function loopbackHostPort(
  bindings: readonly ObservedPortBinding[],
  containerPort: string,
): number | undefined {
  const match = bindings.find(
    (binding) => binding.containerPort === containerPort && binding.hostIp === LOOPBACK_HOST,
  );
  return match?.hostPort;
}

/** Docker's own resolution of a `repository@digest` reference to an image id, or `""`. */
function dockerImageId(docker: DockerCli, reference: string): string {
  const result = docker.run({
    args: ["image", "inspect", reference, "--format", "{{.Id}}"],
    timeoutMs: 60_000,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

/** The repository digests Docker publishes for an image id. */
function dockerRepoDigests(docker: DockerCli, imageId: string): readonly string[] {
  const result = docker.run({
    args: ["image", "inspect", imageId, "--format", "{{json .RepoDigests}}"],
    timeoutMs: 60_000,
  });
  if (result.status !== 0) return [];
  let parsed: unknown;
  try {
    parsed = parseStrictJson(result.stdout.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Memoized image resolutions, shared by everything that asks the same daemon.
 *
 * Sound because both directions are content-addressed: the id a digest reference
 * resolves to, and the digests an id publishes, cannot change for a fixed input
 * without the input naming different bytes.
 */
export interface ImageResolutionMemo {
  readonly ids: Map<string, string>;
  readonly digests: Map<string, readonly string[]>;
}

export function newImageResolutionMemo(): ImageResolutionMemo {
  return { ids: new Map(), digests: new Map() };
}

/**
 * **The** two-legged running-image rule. One implementation, every caller.
 *
 * Both legs are derived from live Docker state and both are required:
 *
 *   1. the daemon resolves the pinned `repository@digest` to the same image id the
 *      container reports it is running;
 *   2. the image that id names publishes that exact pinned repository digest.
 *
 * Two legs rather than one because either alone is satisfiable by something else:
 * a re-tagged image can publish the right digest under different bytes, and a
 * matching content id can sit under a foreign repository. A daemon that cannot
 * answer either leg leaves `matchesLockedDigest` false — the mapping is unproven,
 * and unproven is refused, never assumed.
 *
 * Only successful lookups are memoized, so a transient daemon failure stays
 * retryable rather than becoming a permanent "not proven".
 */
export function observeRunningImage(options: {
  readonly docker: DockerCli;
  readonly lockedReference: string;
  readonly containerImageId: string;
  readonly memo?: ImageResolutionMemo;
}): ObservedImageIdentity {
  const { docker, lockedReference, containerImageId, memo } = options;
  let lockedImageId = memo?.ids.get(lockedReference);
  if (lockedImageId === undefined) {
    lockedImageId = dockerImageId(docker, lockedReference);
    if (lockedImageId !== "") memo?.ids.set(lockedReference, lockedImageId);
  }
  let observedRepoDigests: readonly string[] = [];
  if (containerImageId !== "") {
    const cached = memo?.digests.get(containerImageId);
    if (cached !== undefined) {
      observedRepoDigests = cached;
    } else {
      observedRepoDigests = dockerRepoDigests(docker, containerImageId);
      if (observedRepoDigests.length > 0) memo?.digests.set(containerImageId, observedRepoDigests);
    }
  }
  return {
    lockedReference,
    containerImageId,
    observedRepoDigests,
    lockedImageId,
    matchesLockedDigest:
      containerImageId !== "" &&
      lockedImageId !== "" &&
      containerImageId === lockedImageId &&
      observedRepoDigests.includes(lockedReference),
  };
}

interface ObservedObject {
  readonly name: string;
  readonly runLabel: string;
}

/**
 * What Docker says about the image a container is actually running, and whether
 * that resolves to the digest the qualified lock pins.
 *
 * Every field except `lockedReference` is read back out of the daemon. The
 * verdict needs both legs to agree, so neither a re-tagged image that happens to
 * publish the right digest nor a matching content id under a foreign repository
 * passes on its own.
 */
interface ObservedImageIdentity {
  /** `repository@digest` from the lock — the only expected value here, and never the verdict. */
  readonly lockedReference: string;
  /** `.Image` of the live container. */
  readonly containerImageId: string;
  /** `.RepoDigests` of the image that id names, asked of the daemon. */
  readonly observedRepoDigests: readonly string[];
  /** The id the daemon resolves `lockedReference` to in its own store. */
  readonly lockedImageId: string;
  readonly matchesLockedDigest: boolean;
}

/**
 * One expected container, and the verdict on whether Docker proves it is this
 * run's and running the locked bytes.
 *
 * `violations` empty is the *only* state in which the container may be treated as
 * owned. Everything else — absent, mislabelled, or running an image the lock does
 * not pin — is a reason it may not be.
 */
interface VerifiedContainer {
  readonly service: ComposeServiceSpec;
  readonly name: string;
  readonly observed: ObservedContainer | undefined;
  readonly image: ObservedImageIdentity | undefined;
  readonly violations: readonly string[];
}

/** Violation reasons. Stable strings: they are hashed into the baseline observation. */
const VIOLATION_ABSENT = "container_absent";
const VIOLATION_RUN_LABEL = `${ERL2_RUN_LABEL}_mismatch`;
const VIOLATION_DRIVER_LABEL = `${ERL2_DRIVER_LABEL}_mismatch`;
const VIOLATION_PROJECT_LABEL = `${COMPOSE_PROJECT_LABEL}_mismatch`;
const VIOLATION_IMAGE = "image_not_locked_digest";

export class ComposeEnvironmentDriver implements EnvironmentDriver, AttributableTelemetryObserver {
  readonly manifest: EnvironmentDriverManifestV1;
  readonly project: string;

  private readonly runId: string;
  private readonly clock: Clock;
  private readonly lock: SubstrateLockV1;
  private readonly upstream: MaterializedUpstream;
  private readonly repositoryConfig: RepositoryConfigPaths;
  private readonly docker: DockerCli;
  private readonly store: ComposeRunStore;
  private readonly archetypeHash: Hash;
  private readonly sourceIds: readonly string[];
  private platformCache: Platform | undefined;
  /** Image resolutions already asked of this daemon. See `newImageResolutionMemo`. */
  private readonly imageMemo = newImageResolutionMemo();

  constructor(options: ComposeDriverOptions) {
    this.runId = options.runId;
    this.clock = options.clock;
    this.lock = options.lock;
    this.upstream = options.upstream;
    this.repositoryConfig = options.repositoryConfig;
    this.docker = options.docker ?? new SpawnDockerCli();
    this.archetypeHash = options.archetypeHash;
    this.sourceIds = options.evidenceSourceIds ?? ["deployment-log", "service-metric", "change-record"];
    this.project = composeProjectName(options.runId);
    this.store = new ComposeRunStore(options.substrateRoot, options.runId, this.project);
    this.manifest = assertContract<EnvironmentDriverManifestV1>(
      "EnvironmentDriverManifestV1",
      sealSigned(
        {
          ...composeDriverManifestBody(options.lock, options.lockHash),
          resource_kinds: [...RESOURCE_KINDS],
        },
        options.signingKey,
      ),
    );
  }

  /** The directory the CLI mounts read-only into the adapter host. */
  endpointDirectory(): string {
    return this.store.endpointDirectory();
  }

  // -- naming ---------------------------------------------------------------

  private networkName(): string {
    return `${this.project}-net`;
  }

  /**
   * The network the challenge activation attaches the endpoint container to.
   *
   * Why a second network rather than, say, pausing the container: the activation
   * mutation must be *observable* and *reversible* without breaking the
   * environment the journey then runs in. A pause is both observable and
   * reversible, and it also makes every later journey step time out — so the
   * mutation would be indistinguishable from a fault injection, and the run's own
   * subject steps would fail for a reason that has nothing to do with the
   * subject. Attaching one extra network changes container state that Docker
   * reports exactly, leaves the published endpoint answering, and comes off again
   * with a disconnect and a remove.
   */
  private challengeNetworkName(): string {
    return `${this.project}-challenge`;
  }

  private containerName(service: ComposeServiceSpec): string {
    return `${this.project}-${service.serviceId}`;
  }

  private endpointService(): ComposeServiceSpec {
    return OTEL_DEMO_SERVICES.find(
      (service) => service.serviceId === OTEL_DEMO_ENDPOINT_SERVICE_ID,
    ) as ComposeServiceSpec;
  }

  // -- Docker invocation ----------------------------------------------------

  private platform(): Platform {
    this.platformCache ??= observeExecutingPlatform(this.docker);
    return this.platformCache;
  }

  /**
   * The Compose interpolation environment.
   *
   * Every run-varying value is here rather than in the overlay file, which is
   * what keeps the overlay static and therefore hashable into the lock. The two
   * upstream mount variables are bound to `/dev/null`: the collector's pipelines
   * no longer reference the receivers that would have read them, and a mount that
   * cannot reach the host is better than one that merely is not read.
   */
  private composeEnvironment(): Record<string, string> {
    const platform = this.platform();
    const env: Record<string, string> = {
      ERL2_RUN_ID: this.runId,
      ERL2_NETWORK_NAME: this.networkName(),
      DOCKER_SOCK: "/dev/null",
      HOST_FILESYSTEM: "/dev/null",
      OTEL_COLLECTOR_CONFIG_EXTRAS: path.resolve(this.repositoryConfig.extrasPath),
    };
    for (const service of OTEL_DEMO_SERVICES) {
      env[service.containerVariable] = this.containerName(service);
      env[service.imageVariable] = pinnedImageReference(this.lock, service, platform);
    }
    return env;
  }

  private compose(args: readonly string[], timeoutMs = 300_000): { status: number; stdout: string; stderr: string } {
    return this.docker.run({
      args: [
        "compose",
        "--project-name",
        this.project,
        "--project-directory",
        this.upstream.root,
        "--env-file",
        this.upstream.envFile,
        "--file",
        this.upstream.composeFile,
        "--file",
        path.resolve(this.repositoryConfig.overlayPath),
        ...args,
      ],
      env: this.composeEnvironment(),
      timeoutMs,
    });
  }

  // -- observation ----------------------------------------------------------

  private observeContainer(name: string): ObservedContainer | undefined {
    const result = this.docker.run({
      args: ["container", "inspect", name, "--format", "{{json .}}"],
      timeoutMs: 60_000,
    });
    if (result.status !== 0) return undefined;
    const raw = parseStrictJson(result.stdout.trim()) as {
      State?: { Status?: string; Paused?: boolean; Restarting?: boolean; Health?: { Status?: string } };
      RestartCount?: number;
      Config?: { Labels?: Record<string, string> };
      Image?: string;
      NetworkSettings?: {
        Ports?: Record<string, { HostPort?: string }[] | null>;
        Networks?: Record<string, unknown>;
      };
    };
    const labels = raw.Config?.Labels ?? {};
    return {
      name,
      networks: Object.keys(raw.NetworkSettings?.Networks ?? {}).sort(),
      state: raw.State?.Status ?? "unknown",
      paused: raw.State?.Paused === true,
      health: raw.State?.Health?.Status ?? "none",
      restartCount: raw.RestartCount ?? 0,
      imageId: raw.Image ?? "",
      runLabel: labels[ERL2_RUN_LABEL] ?? "",
      driverLabel: labels[ERL2_DRIVER_LABEL] ?? "",
      projectLabel: labels[COMPOSE_PROJECT_LABEL] ?? "",
      bindings: observedBindings(raw.NetworkSettings?.Ports),
    };
  }

  // -- is this container ours, and is it running the locked bytes? -------------

  /**
   * Whether the bytes this container runs are the bytes the lock pins.
   *
   * Thin on purpose: the rule itself is `observeRunningImage`, which the endpoint
   * reader calls too. There is one two-legged rule in this module and both callers
   * reach it here, so the two cannot drift into subtly different notions of "runs
   * the locked image".
   */
  private observeImageIdentity(
    service: ComposeServiceSpec,
    container: ObservedContainer,
  ): ObservedImageIdentity {
    return observeRunningImage({
      docker: this.docker,
      lockedReference: pinnedImageReference(this.lock, service, this.platform()),
      containerImageId: container.imageId,
      memo: this.imageMemo,
    });
  }

  /** Every expected container, with the verdict on whether it may be treated as ours. */
  private observeExpectedContainers(): readonly VerifiedContainer[] {
    return OTEL_DEMO_SERVICES.map((service) => {
      const name = this.containerName(service);
      const observed = this.observeContainer(name);
      if (observed === undefined) {
        return { service, name, observed: undefined, image: undefined, violations: [VIOLATION_ABSENT] };
      }
      const image = this.observeImageIdentity(service, observed);
      const violations: string[] = [];
      // Exact equality on every ownership label. A label the object does not carry
      // reads as `""`, which is not this run's value, so "missing" and "wrong" are
      // the same refusal rather than a gap.
      if (observed.runLabel !== this.runId) violations.push(VIOLATION_RUN_LABEL);
      if (observed.driverLabel !== COMPOSE_DRIVER_ID) violations.push(VIOLATION_DRIVER_LABEL);
      if (observed.projectLabel !== this.project) violations.push(VIOLATION_PROJECT_LABEL);
      if (!image.matchesLockedDigest) violations.push(VIOLATION_IMAGE);
      return { service, name, observed, image, violations };
    });
  }

  /** The endpoint service's entry, verdict included. */
  private endpointEntry(): VerifiedContainer {
    const endpoint = this.endpointService();
    return this.observeExpectedContainers().find(
      (entry) => entry.service.serviceId === endpoint.serviceId,
    ) as VerifiedContainer;
  }

  /** True only when Docker proves the entry is this run's, running the locked image. */
  private static verified(entry: VerifiedContainer | undefined): boolean {
    return entry !== undefined && entry.observed !== undefined && entry.violations.length === 0;
  }

  /**
   * The loopback host port this entry publishes for its own container port.
   *
   * The only host port this driver ever reports. A service with no declared
   * container port publishes nothing by design, and a binding on another container
   * port or another interface is not this service's endpoint.
   */
  private endpointHostPort(entry: VerifiedContainer | undefined): number | undefined {
    const containerPort = entry?.service.containerPort;
    if (entry?.observed === undefined || containerPort === undefined) return undefined;
    return loopbackHostPort(entry.observed.bindings, `${containerPort}/tcp`);
  }

  /**
   * Refuses before any destructive or activating action when a live object at one
   * of this run's expected names is not provably this run's.
   *
   * An absent container is not a violation here — there is simply nothing to act
   * on, and the operations below say so in their own terms. What is refused is a
   * *present* object the run would otherwise have treated as its own.
   */
  private assertVerifiedOwnership(containers: readonly VerifiedContainer[]): void {
    const unproven = containers.filter(
      (entry) => entry.observed !== undefined && entry.violations.length > 0,
    );
    if (unproven.length === 0) return;
    throw new Erl2Error(
      CODES.ENV_FOREIGN_RESOURCE_REJECTED,
      `Docker does not prove ${unproven
        .map((entry) => `${entry.name} (${[...entry.violations].sort().join(", ")})`)
        .join("; ")} belongs to run ${this.runId} and runs the locked image; ` +
        "an expected container name is not ownership",
      { owner: "lab" },
    );
  }

  /**
   * Objects carrying this run's exact project label.
   *
   * The filter is an exact `label=key=value` equality on a value that embeds the
   * run's own UUID. It is not a prefix, not a pattern, and it cannot widen: a
   * different run's project label is a different string.
   */
  private observeLabelled(kind: "container" | "network" | "volume"): readonly ObservedObject[] {
    const base =
      kind === "container"
        ? ["ps", "--all", "--no-trunc"]
        : kind === "network"
          ? ["network", "ls", "--no-trunc"]
          : ["volume", "ls"];
    const result = this.docker.run({
      args: [
        ...base,
        "--filter",
        `label=${COMPOSE_PROJECT_LABEL}=${this.project}`,
        "--format",
        `{{.${kind === "container" ? "Names" : "Name"}}}\t{{.Label "${ERL2_RUN_LABEL}"}}`,
      ],
      timeoutMs: 60_000,
    });
    if (result.status !== 0) {
      throw new Erl2Error(
        CODES.ENV_SUBSTRATE_UNREADABLE,
        `the Docker daemon could not be asked which ${kind}s belong to this run's project`,
        { owner: "lab" },
      );
    }
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name = "", runLabel = ""] = line.split("\t");
        return { name, runLabel };
      });
  }

  private resource(kind: string, runScopedName: string, resourceId: string): EnvironmentResourceV1 {
    return {
      resource_id: resourceId,
      kind,
      run_scoped_name: runScopedName,
      identity_hash: resourceIdentityHash(this.runId, kind, runScopedName),
      destroyable: true,
    };
  }

  /**
   * An object that carries this run's project label but is not one of this run's
   * resources.
   *
   * Its identity is derived from the run id it *claims*, so it is internally
   * consistent and provably not ours — which is what makes `assertOwnedByRun`
   * able to fail for it rather than silently accepting it into a destroy.
   */
  private foreignResource(kind: string, name: string, claimedRunId: string): EnvironmentResourceV1 {
    return {
      resource_id: `foreign-${kind}-${shortId(name)}`,
      kind,
      run_scoped_name: name,
      identity_hash: domainHash(HASH_DOMAINS.RESOURCE_IDENTITY, {
        run_id: claimedRunId,
        kind,
        run_scoped_name: name,
      }),
      destroyable: true,
    };
  }

  /**
   * A live object at one of this run's expected names that Docker does not prove
   * is this run's.
   *
   * Reported rather than hidden: cleanup has to know it is there, and a
   * substituted container that vanished from the inventory would be residue
   * nobody accounted for. Its identity deliberately does **not** derive from
   * `resourceIdentityHash`, so `assertOwnedByRun` refuses it on every destructive
   * path even if some future caller reaches it without going through
   * `assertVerifiedOwnership` first.
   *
   * `slug` discriminates it from this run's *other* expected objects. It is the
   * service id rather than a prefix of the container name, because every container
   * name in a project shares the same leading characters — two unverified
   * containers keyed on that prefix would collide on one `resource_id`, and an
   * inventory with two entries under one id is one an operator cannot act on.
   */
  private unverifiedResource(
    kind: string,
    name: string,
    slug: string,
    violations: readonly string[],
  ): EnvironmentResourceV1 {
    return {
      resource_id: `unverified-${kind}-${slug.replace(/[^a-z0-9-]/g, "-")}-${shortId(this.runId)}`,
      kind,
      run_scoped_name: name,
      identity_hash: domainHash(HASH_DOMAINS.RESOURCE_IDENTITY, {
        run_id: this.runId,
        kind,
        run_scoped_name: name,
        unverified_ownership: [...violations].sort(),
      }),
      destroyable: true,
    };
  }

  /**
   * Everything this run's project holds right now, and the per-container
   * ownership verdicts the rest of the driver gates on.
   *
   * Returned together because they come from one sweep of the substrate: a caller
   * that had to ask twice would be deciding against two different moments.
   */
  private observeGraph(): {
    readonly resources: readonly EnvironmentResourceV1[];
    readonly containers: readonly VerifiedContainer[];
  } {
    const resources: EnvironmentResourceV1[] = [];
    const containers = this.observeExpectedContainers();
    const networks = this.observeLabelled("network");
    const volumes = this.observeLabelled("volume");
    const labelledContainers = this.observeLabelled("container");

    const anything =
      containers.some((entry) => entry.observed !== undefined) ||
      networks.length > 0 ||
      volumes.length > 0 ||
      labelledContainers.length > 0;
    if (anything) resources.push(this.resource("project", this.project, `project-${shortId(this.runId)}`));

    for (const network of networks) {
      const ownedId =
        network.name === this.networkName()
          ? `network-${shortId(this.runId)}`
          : network.name === this.challengeNetworkName()
            ? `challenge-network-${shortId(this.runId)}`
            : undefined;
      resources.push(
        ownedId === undefined
          ? this.foreignResource("network", network.name, network.runLabel)
          : this.resource("network", network.name, ownedId),
      );
    }
    for (const entry of containers) {
      if (entry.observed === undefined) continue;
      resources.push(
        entry.violations.length === 0
          ? this.resource(
              "container",
              entry.observed.name,
              `container-${entry.service.serviceId.replace(/[^a-z0-9-]/g, "-")}-${shortId(this.runId)}`,
            )
          : this.unverifiedResource(
              "container",
              entry.observed.name,
              entry.service.serviceId,
              entry.violations,
            ),
      );
    }
    const expectedContainerNames = new Set(OTEL_DEMO_SERVICES.map((s) => this.containerName(s)));
    for (const container of labelledContainers) {
      if (expectedContainerNames.has(container.name)) continue;
      resources.push(this.foreignResource("container", container.name, container.runLabel));
    }
    for (const volume of volumes) {
      resources.push(this.foreignResource("volume", volume.name, volume.runLabel));
    }
    // The published port belongs to this run only if the container publishing it
    // does, and only if it is the endpoint's own container port on loopback. A port
    // reached through an unverified container is not this run's port.
    const endpoint = containers.find((entry) => entry.service.serviceId === OTEL_DEMO_ENDPOINT_SERVICE_ID);
    if (ComposeEnvironmentDriver.verified(endpoint) && this.endpointHostPort(endpoint) !== undefined) {
      resources.push(
        this.resource("port", `${this.project}-${OTEL_DEMO_ENDPOINT_SERVICE_ID}-port`, `port-${shortId(this.runId)}`),
      );
    }
    return { resources, containers };
  }

  private observedResources(): readonly EnvironmentResourceV1[] {
    return this.observeGraph().resources;
  }

  private inventoryOf(resources: readonly EnvironmentResourceV1[]): EnvironmentResourceInventoryV1 {
    const base = {
      schema_version: "environment-resource-inventory/v1" as const,
      run_id: this.runId,
      environment_instance_hash: this.instanceHash(),
      driver_manifest_hash: coreHash(this.manifest),
      resources: [...resources],
      inventoried_at: this.clock.now(),
    };
    return assertContract<EnvironmentResourceInventoryV1>("EnvironmentResourceInventoryV1", {
      ...base,
      core_hash: coreHash(base),
    });
  }

  private instanceHash(): Hash {
    const marker = this.store.marker();
    if (marker === undefined) return this.archetypeHash;
    return substrateInstanceHash(this.engineId(), marker.project, marker.established_by_run);
  }

  private engineId(): string {
    const result = this.docker.run({ args: ["info", "--format", "{{.ID}}"], timeoutMs: 60_000 });
    if (result.status !== 0 || result.stdout.trim() === "") {
      throw new Erl2Error(
        CODES.ENV_SUBSTRATE_UNREADABLE,
        "the Docker daemon did not report its own identity; a substrate that cannot be identified cannot be bound",
        { owner: "lab" },
      );
    }
    return result.stdout.trim();
  }

  // -- the substrate's identity ---------------------------------------------

  substrateInstance(): SubstrateInstance | undefined {
    const marker = this.store.marker();
    if (marker === undefined) return undefined;
    // Re-derived from the daemon this command actually reached, never read back
    // from the marker: a marker copied beside a different engine must produce a
    // different identity, or the binding check would accept the substitution.
    return {
      kind: marker.kind,
      instanceHash: substrateInstanceHash(this.engineId(), marker.project, marker.established_by_run),
    };
  }

  establishSubstrateInstance(runId: string): SubstrateInstance {
    const existing = this.substrateInstance();
    if (existing !== undefined) return existing;
    const engineId = this.engineId();
    this.store.writeMarker({
      kind: COMPOSE_SUBSTRATE_KIND,
      engine_id: engineId,
      project: this.project,
      established_by_run: runId,
    });
    return {
      kind: COMPOSE_SUBSTRATE_KIND,
      instanceHash: substrateInstanceHash(engineId, this.project, runId),
    };
  }

  // -- the operation log, gated on the substrate ----------------------------

  completedOperation(runId: string, operationId: string): EnvironmentOperationReceiptV1 | undefined {
    if (runId !== this.runId) return undefined;
    const stored = this.store.state().operations[operationId];
    if (stored === undefined) return undefined;
    return this.effectStillObserved(stored) ? stored : undefined;
  }

  /** Whether the substrate still shows what the stored receipt says happened. */
  private effectStillObserved(receipt: EnvironmentOperationReceiptV1): boolean {
    // A failed operation left no effect to re-observe; its receipt is the record
    // that the attempt happened, and re-dispatching a known failure would only
    // produce a second one.
    if (receipt.status === "failed") return true;
    switch (receipt.operation) {
      case "provision": {
        // The same verified graph a fresh provision has to reach. Container
        // presence alone would let a restarted run adopt a provision whose
        // containers had since been substituted for foreign ones.
        const graph = this.observeGraph();
        return this.completeGraph(graph.resources, graph.containers);
      }
      case "mutate":
        return this.challengeNetworkAttached();
      case "restore": {
        // Verified first: "the activation is gone" is not a restoration if the
        // container it was applied to is no longer provably this run's.
        const endpoint = this.endpointEntry();
        return (
          ComposeEnvironmentDriver.verified(endpoint) &&
          endpoint.observed?.networks.includes(this.challengeNetworkName()) !== true &&
          this.observeNetworkPresent(this.challengeNetworkName()) === false
        );
      }
      case "destroy":
        return this.observedResources().length === 0;
      default:
        return false;
    }
  }

  private remember(receipt: EnvironmentOperationReceiptV1): EnvironmentOperationReceiptV1 {
    this.store.put({ operations: { ...this.store.state().operations, [receipt.operation_id]: receipt } });
    return receipt;
  }

  private receipt(options: {
    readonly operation: EnvironmentOperationReceiptV1["operation"];
    readonly operationId: string;
    readonly targetIdentityHash: Hash;
    readonly before: unknown;
    readonly after: unknown;
    readonly status: "succeeded" | "failed";
    readonly errorCode?: string;
    readonly compensationId?: string;
    readonly startedAt?: string;
  }): EnvironmentOperationReceiptV1 {
    const base = {
      schema_version: "environment-operation-receipt/v1" as const,
      run_id: this.runId,
      operation: options.operation,
      operation_id: options.operationId,
      idempotency_key: coreHash({ run: this.runId, op: options.operationId }).slice("sha256:".length),
      driver_manifest_hash: coreHash(this.manifest),
      target_identity_hash: options.targetIdentityHash,
      before_state_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, options.before),
      after_state_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, options.after),
      ...(options.compensationId === undefined ? {} : { compensation_id: options.compensationId }),
      status: options.status,
      ...(options.errorCode === undefined ? {} : { error_code: options.errorCode }),
      started_at: options.startedAt ?? this.clock.now(),
      ended_at: this.clock.now(),
    };
    return assertContract<EnvironmentOperationReceiptV1>("EnvironmentOperationReceiptV1", {
      ...base,
      core_hash: coreHash(base),
    });
  }

  // -- provision ------------------------------------------------------------

  provision(request: ProvisionRequest): ProvisionResult {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "provision");
    const completed = this.completedOperation(request.runId, request.operationId);
    if (completed !== undefined) {
      const graph = this.observeGraph();
      return {
        receipt: completed,
        inventory: this.inventoryOf(graph.resources),
        environmentInstanceHash: this.instanceHash(),
        partial: !this.completeGraph(graph.resources, graph.containers),
      };
    }
    if (this.observedResources().length > 0) {
      throw new Erl2Error(
        CODES.ENV_PROVISION_FAILED,
        `the Compose project for run ${request.runId} already has objects; a run may not provision twice`,
        { owner: "lab" },
      );
    }
    const startedAt = this.clock.now();

    // Images first, and nothing is created yet. `pull` names services explicitly
    // and resolves the digests the overlay pins, so no tag is consulted.
    const pulled = this.compose(["pull", ...OTEL_DEMO_SERVICES.map((s) => s.serviceId)], 900_000);
    if (pulled.status !== 0) {
      throw new Erl2Error(
        CODES.ENV_PROVISION_FAILED,
        `the qualified images could not be pulled by digest: ${tail(pulled.stderr)}`,
        { owner: "lab" },
      );
    }

    // Runtime admission. What is about to run is re-observed and compared against
    // the lock *before* the first object exists, so drift invalidates the run
    // rather than producing an attesting run over unknown bytes.
    assertObservedMatchesLock(
      this.lock,
      observeComposeSubstrate({
        lock: this.lock,
        upstream: this.upstream,
        repositoryConfig: this.repositoryConfig,
        executingPlatform: this.platform(),
        requiredPlatforms: REQUIRED_PLATFORMS,
        docker: this.docker,
      }),
    );

    const up = this.compose(
      [
        "up",
        "--detach",
        "--no-build",
        "--wait",
        "--wait-timeout",
        String(UP_TIMEOUT_SECONDS),
        OTEL_DEMO_ENDPOINT_SERVICE_ID,
      ],
      (UP_TIMEOUT_SECONDS + 60) * 1000,
    );
    const graph = this.observeGraph();
    const observed = graph.resources;
    const complete = up.status === 0 && this.completeGraph(observed, graph.containers);
    // The endpoint record is what a later process turns into a mount and an
    // egress allowlist, so it is written only over a graph Docker proved.
    if (complete) this.writeEndpointRecord(graph.containers);

    return {
      receipt: this.remember(
        this.receipt({
          operation: "provision",
          operationId: request.operationId,
          targetIdentityHash: this.instanceHash(),
          before: { resources: [] },
          after: { resources: observed.map((r) => r.identity_hash) },
          status: complete ? "succeeded" : "failed",
          startedAt,
          ...(complete ? {} : { errorCode: CODES.ENV_PROVISION_FAILED }),
        }),
      ),
      inventory: this.inventoryOf(observed),
      environmentInstanceHash: this.instanceHash(),
      partial: !complete,
    };
  }

  /**
   * Every member of the fixed service graph is present and *verified*, and
   * nothing foreign is.
   *
   * The container clause is the ownership verdict, not the name lookup: a
   * substituted or mislabelled container answers to the expected name, so a graph
   * judged on names alone would call it complete.
   */
  private completeGraph(
    resources: readonly EnvironmentResourceV1[],
    containers: readonly VerifiedContainer[],
  ): boolean {
    const names = new Set(resources.map((r) => r.run_scoped_name));
    const required = [
      this.project,
      this.networkName(),
      ...OTEL_DEMO_SERVICES.map((service) => this.containerName(service)),
      `${this.project}-${OTEL_DEMO_ENDPOINT_SERVICE_ID}-port`,
    ];
    return (
      required.every((name) => names.has(name)) &&
      resources.every((resource) => resource.run_scoped_name.includes(this.runId)) &&
      containers.every((entry) => ComposeEnvironmentDriver.verified(entry))
    );
  }

  /**
   * The run-local endpoint record.
   *
   * Written into its own directory so the CLI can mount exactly it, read-only,
   * into the adapter host. The published host port is ephemeral by design — the
   * overlay pins `host_ip` but deliberately omits `published`, so two runs never
   * collide — which is precisely why a later process cannot guess it and has to
   * be told.
   *
   * It is a *hint*, never an authorization. `readComposeEndpoint` validates every
   * field of it and then re-observes Docker before anything is mounted or
   * allowlisted, so this record going stale withdraws access rather than
   * preserving it.
   */
  private writeEndpointRecord(containers: readonly VerifiedContainer[]): void {
    const endpoint = containers.find(
      (entry) => entry.service.serviceId === OTEL_DEMO_ENDPOINT_SERVICE_ID,
    );
    if (!ComposeEnvironmentDriver.verified(endpoint)) return;
    const container = endpoint?.observed;
    const port = this.endpointHostPort(endpoint);
    if (container === undefined || port === undefined) return;
    this.store.writeEndpoint({
      run_id: this.runId,
      host: LOOPBACK_HOST,
      port,
      service_id: OTEL_DEMO_ENDPOINT_SERVICE_ID,
      container: container.name,
      substrate_id: OTEL_DEMO_SUBSTRATE_ID,
    });
  }

  // -- probe ----------------------------------------------------------------

  probe(request: ProbeRequest): EnvironmentBaselineFingerprintV1 {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "probe");
    const probes: EnvironmentProbeResultV1[] = [];
    const graph = this.observeGraph();
    const observed = graph.resources;
    // Residue is anything in this run's project the run does not own: a foreign
    // object under a foreign name, and equally a live object under one of *our*
    // names that Docker will not confirm is ours.
    const foreign = observed.filter(
      (r) => !r.run_scoped_name.includes(this.runId) || r.resource_id.startsWith("unverified-"),
    );

    const project = observed.some((r) => r.kind === "project");
    probes.push(
      this.probeResult(request, "probe-project", "presence", `project-${shortId(this.runId)}`, project, {
        kind: "project",
        present: project,
      }),
    );
    const network = observed.some((r) => r.kind === "network" && r.run_scoped_name === this.networkName());
    probes.push(
      this.probeResult(request, "probe-network", "presence", `network-${shortId(this.runId)}`, network, {
        kind: "network",
        present: network,
      }),
    );

    for (const entry of graph.containers) {
      const container = entry.observed;
      // The observation deliberately excludes the container id, the host port and
      // every timestamp, and deliberately includes the *observed* image identity:
      // two clean provisions of this archetype must fingerprint identically, and
      // they must stop doing so if the bytes running in them change.
      //
      // What it records is what Docker said — the running image's id, the
      // repository digests that image publishes, and the verdict derived from
      // them. It deliberately does not record the digest the lock pins, because a
      // probe that reported its own expectation would agree with the lock however
      // the container was substituted.
      const healthy =
        container !== undefined &&
        container.state === "running" &&
        !container.paused &&
        container.restartCount === 0 &&
        (container.health === "healthy" || container.health === "none");
      probes.push(
        this.probeResult(
          request,
          `probe-container-${entry.service.serviceId}`,
          "health",
          `container-${entry.service.serviceId}-${shortId(this.runId)}`,
          healthy && entry.violations.length === 0,
          {
            kind: "container",
            service_id: entry.service.serviceId,
            image_id: entry.image?.containerImageId ?? "absent",
            observed_image_repo_digests: [...(entry.image?.observedRepoDigests ?? [])].sort(),
            image_matches_locked_digest: entry.image?.matchesLockedDigest ?? false,
            ownership_verified: entry.violations.length === 0,
            ownership_violations: [...entry.violations].sort(),
            state: container?.state ?? "absent",
            paused: container?.paused ?? false,
            health: container?.health ?? "absent",
            restart_count: container?.restartCount ?? -1,
          },
        ),
      );
    }

    const endpointEntry = graph.containers.find(
      (entry) => entry.service.serviceId === OTEL_DEMO_ENDPOINT_SERVICE_ID,
    );
    // Published *on loopback, for the endpoint's own container port*. The probe
    // deliberately records the interface it required rather than the ephemeral host
    // port, which varies per run and would break fingerprint agreement.
    const published =
      ComposeEnvironmentDriver.verified(endpointEntry) && this.endpointHostPort(endpointEntry) !== undefined;
    probes.push(
      this.probeResult(request, "probe-port-quote", "presence", `port-${shortId(this.runId)}`, published, {
        kind: "port",
        container_port: this.endpointService().containerPort,
        host_ip: LOOPBACK_HOST,
        published,
      }),
    );

    // Named for what it observes and nothing more. The collector logging that its
    // OTLP pipelines came up is *pipeline readiness*; it is not a telemetry record,
    // and calling this probe `telemetry` invited exactly that conflation.
    const collectorReady = this.observeCollectorPipeline();
    probes.push(
      this.probeResult(
        request,
        "probe-telemetry-pipeline",
        "telemetry-pipeline-readiness",
        `container-otel-collector-${shortId(this.runId)}`,
        collectorReady,
        { kind: "telemetry-pipeline", signal: "traces", exporter: "debug", started: collectorReady },
      ),
    );

    const evidenceSourceStates: EvidenceSourceState[] = this.sourceIds.map((source_id) => ({
      source_id,
      state: this.evidenceSourceState(source_id, probes),
    }));

    return buildBaselineFingerprint({
      runId: this.runId,
      environmentInstanceHash: this.instanceHash(),
      archetypeHash: this.archetypeHash,
      driverManifestHash: coreHash(this.manifest),
      probes,
      evidenceSourceStates,
      observedAt: this.clock.now(),
      // A Docker object carrying this run's project label that this run does not
      // own is residue somebody else left, and a clean archetype does not start
      // from one.
      ...(foreign.length === 0 ? {} : { preexistingResidueCodes: ["PREEXISTING_RESIDUE"] }),
    });
  }

  private probeResult(
    request: ProbeRequest,
    probeId: string,
    kind: string,
    targetResourceId: string,
    passed: boolean,
    observation: unknown,
  ): EnvironmentProbeResultV1 {
    return {
      probe_id: probeId,
      phase: request.phase,
      kind,
      target_resource_id: targetResourceId,
      passed,
      observation_hash: domainHash(HASH_DOMAINS.DRIVER_STATE, observation),
      ...(passed ? {} : { failure_code: CODES.BASELINE_PROBE_FAILED }),
    };
  }

  /**
   * Whether the archetype's declared evidence sources could be served at all.
   *
   * ## What `complete` means here, and what it does not
   *
   * `SourceState` answers "was this source reachable when the cutoff was
   * realized", and the snapshot the run then freezes records `records: 0` for
   * every source in this archetype. So `complete` means *the source was served and
   * returned nothing*, and no retained artifact in an offline bundle attests that
   * any deployment log line, service metric or change record was received.
   *
   * That distinction is load-bearing for `service-metric` in particular, and it is
   * why the mapping below is deliberately annotated rather than left to read as
   * more than it is: what is observed is the collector reporting that its OTLP
   * pipelines started. Pipeline readiness is **not** the receipt of a service
   * metric, and this mapping never changed meaning: `complete` still says only
   * that the metric path was reachable, and every snapshot still freezes
   * `records: 0`.
   *
   * Telemetry the collector really received — spans, with this run's own marker
   * on them — is now **separately retained** as the attributable-telemetry
   * observation (ADR-ERL2-033): `observeAttributableTelemetry` is captured into
   * the run's evidence before teardown begins, the `attributable-telemetry-retained`
   * validity gate refuses the terminal where the observation was declared
   * obtainable and is missing or unattributed, and the offline verifier
   * re-derives its counts from the retained log excerpt. That observation
   * post-dates the realized cutoff, so it backs no claim inside the evidence
   * window this source state describes — the two statements stay apart on
   * purpose.
   */
  private evidenceSourceState(
    sourceId: string,
    probes: readonly EnvironmentProbeResultV1[],
  ): EvidenceSourceState["state"] {
    const passed = (id: string): boolean => probes.find((p) => p.probe_id === id)?.passed === true;
    switch (sourceId) {
      case "deployment-log":
        return OTEL_DEMO_SERVICES.every((s) => passed(`probe-container-${s.serviceId}`)) ? "complete" : "unavailable";
      case "service-metric":
        // Reachability of the metric path, evidenced by the collector's pipelines
        // having started. Not a metric, and not a claim that one arrived.
        return passed("probe-telemetry-pipeline") ? "complete" : "unavailable";
      case "change-record":
        // The driver's own durable operation record is readable. `state()` throws
        // rather than returning an empty record when it is not, so reaching the
        // return at all is the observation.
        return this.store.state().version === 1 ? "complete" : "unavailable";
      default:
        return "unavailable";
    }
  }

  /**
   * Whether the collector's OTLP pipelines came up.
   *
   * Read from the collector's own stdout on the run's exact container, which is
   * where the base configuration's `debug` exporter also writes. `docker logs` is
   * read-only: it copies the container's existing log file and changes nothing.
   */
  private observeCollectorPipeline(): boolean {
    const logs = this.collectorLogs();
    return logs.includes("Everything is ready") || logs.includes("Starting GRPC server");
  }

  /**
   * The run's collector's own output, with the failure mode kept distinct.
   *
   * Verified before it is read, and for the same reason every other expected-name
   * lookup is: logs read out of a container that is not provably this run's would
   * be attributed to this run anyway. Every consumer makes a claim about this
   * run — the pipeline-readiness probe, `observeTelemetry` and the retained
   * attributable-telemetry observation — so none may read from a container
   * Docker has not confirmed. The retained observation additionally needs to
   * say *why* nothing was read, so unverified and unreadable stay separate
   * instead of both collapsing to an empty string.
   */
  private collectorLogsObserved():
    | { readonly status: "ok"; readonly logs: string; readonly collector: VerifiedContainer }
    | { readonly status: "unverified" }
    | { readonly status: "unreadable" } {
    const collector = this.observeExpectedContainers().find(
      (entry) => entry.service.serviceId === "otel-collector",
    );
    if (collector === undefined || !ComposeEnvironmentDriver.verified(collector)) {
      return { status: "unverified" };
    }
    const result = this.docker.run({
      args: ["container", "logs", collector.name],
      timeoutMs: 120_000,
    });
    if (result.status !== 0) return { status: "unreadable" };
    return { status: "ok", logs: `${result.stdout}\n${result.stderr}`, collector };
  }

  /** The collector's output, or nothing — for consumers that only count. */
  private collectorLogs(): string {
    const observed = this.collectorLogsObserved();
    return observed.status === "ok" ? observed.logs : "";
  }

  /**
   * Telemetry the collector actually received, attributable to this run.
   *
   * Read-only, and not part of the `EnvironmentDriver` contract: it is a concrete
   * observation this concrete driver can make. `marker` is a string the caller
   * arranged to appear in the emitted telemetry — the reference adapter puts the
   * run id in the request's query string, and the PHP auto-instrumentation
   * records it as `url.full`. The arithmetic is the shared definition in
   * `telemetryObservation.ts`, which is also what the offline verifier recomputes
   * over the retained log excerpt (ADR-ERL2-033).
   *
   * The retained form of this observation is `observeAttributableTelemetry`
   * below; this counting view stays for callers that only need numbers.
   */
  observeTelemetry(marker: string): {
    readonly traceBatches: number;
    readonly spans: number;
    readonly serviceNames: readonly string[];
    readonly runAttributedRecords: number;
  } {
    return parseCollectorTelemetry(this.collectorLogs(), marker);
  }

  /**
   * The retained attributable-telemetry observation (ADR-ERL2-033 decisions
   * 1–2): the counts, the exact log lines they are derived from, and the
   * Docker-proven identity of the container they were read out of. `observed`
   * exists only over a verified collector; anything else is an `absent` with a
   * typed reason, so a non-observation cannot be dressed as one.
   *
   * The collector's exporter flushes on its own schedule, so while zero
   * run-marked records are visible this retries briefly and then records
   * honestly whatever it last saw. Waiting longer can only *add* records to an
   * append-only log, never remove one, so the retry biases nothing.
   */
  observeAttributableTelemetry(marker: string): AttributableTelemetryMaterial {
    for (let attempt = 1; ; attempt += 1) {
      const observed = this.collectorLogsObserved();
      if (observed.status !== "ok") {
        return {
          evidence: "absent",
          marker,
          reasonCode:
            observed.status === "unverified" ? "collector_not_verified" : "collector_logs_unreadable",
        };
      }
      const counts = parseCollectorTelemetry(observed.logs, marker);
      if (counts.runAttributedRecords >= 1 || attempt >= TELEMETRY_SETTLE_ATTEMPTS) {
        const image = observed.collector.image;
        return {
          evidence: "observed",
          marker,
          counts,
          excerpt: excerptCollectorTelemetry(observed.logs, marker),
          collector: {
            serviceId: observed.collector.service.serviceId,
            containerName: observed.collector.name,
            imageId: image?.containerImageId ?? "",
            observedImageRepoDigests: [...(image?.observedRepoDigests ?? [])].sort(),
          },
        };
      }
      // Synchronous by design, like every other driver wait: the caller is the
      // one durable transition that must finish before teardown may begin.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TELEMETRY_SETTLE_DELAY_MS);
    }
  }

  // -- mutate and restore ---------------------------------------------------

  /**
   * Whether the run's endpoint container is currently on the challenge network.
   *
   * Verified first: an activation observed on a container Docker will not confirm
   * is this run's is not this run's activation, and reporting it as one would let
   * a substituted container satisfy the restoration claim.
   */
  private challengeNetworkAttached(): boolean {
    const endpoint = this.endpointEntry();
    if (!ComposeEnvironmentDriver.verified(endpoint)) return false;
    return endpoint.observed?.networks.includes(this.challengeNetworkName()) === true;
  }

  /** Whether a network of this exact name exists. Exact lookup, never a pattern. */
  private observeNetworkPresent(name: string): boolean {
    return (
      this.docker.run({
        args: ["network", "inspect", name, "--format", "{{.Name}}"],
        timeoutMs: 60_000,
      }).status === 0
    );
  }

  /**
   * What the substrate says is applied right now.
   *
   * Derived from container attachment, never from the durable record: the record
   * only supplies the *name* of an activation the substrate independently
   * confirms is still there. An attachment the record does not account for is
   * reported under its own identifier rather than omitted, so a compensation
   * cannot be judged against a mutation set that quietly excludes it.
   */
  observedMutations(runId: string): readonly string[] {
    if (runId !== this.runId) return [];
    if (!this.challengeNetworkAttached()) return [];
    const container = this.containerName(this.endpointService());
    const recorded = this.store.state().mutations.filter((mutation) => mutation.container === container);
    if (recorded.length === 0) return [`unrecorded-activation:${container}`];
    return [...recorded.map((mutation) => mutation.mutation_id)].sort();
  }

  mutate(request: MutateRequest): EnvironmentOperationReceiptV1 {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "mutate");
    const already = this.completedOperation(request.runId, request.operationId);
    if (already !== undefined) return already;

    const graph = this.observeGraph();
    // Before anything is attached: no expected-name container may be present
    // without Docker proving it is this run's, running the locked image.
    this.assertVerifiedOwnership(graph.containers);
    const resources = graph.resources;
    const requested = resources.find((r) => r.resource_id === request.targetResourceId);
    if (requested === undefined) {
      throw new Erl2Error(
        CODES.ENV_FOREIGN_RESOURCE_REJECTED,
        `resource ${request.targetResourceId} is not part of run ${request.runId}`,
      );
    }
    assertOwnedByRun(request.runId, requested);
    // The run names the environment it wants activated; this driver's one
    // mutation is exactly scoped to the endpoint container inside it, and the
    // receipt says so rather than claiming the whole project changed.
    const endpoint = this.endpointService();
    const target = resources.find((r) => r.run_scoped_name === this.containerName(endpoint));
    if (target === undefined) {
      throw new Erl2Error(
        CODES.ENV_PROVISION_FAILED,
        "the run's endpoint container is not present; there is nothing to activate the challenge in",
        { owner: "lab" },
      );
    }
    assertOwnedByRun(request.runId, target);
    assertNarrowSelector(request.runId, target.run_scoped_name);

    const startedAt = this.clock.now();
    const before = this.observeContainer(target.run_scoped_name);
    const network = this.challengeNetworkName();
    assertNarrowSelector(request.runId, network);
    if (!this.observeNetworkPresent(network)) {
      this.docker.run({
        args: [
          "network",
          "create",
          "--label",
          `${ERL2_RUN_LABEL}=${this.runId}`,
          "--label",
          `${ERL2_DRIVER_LABEL}=${COMPOSE_DRIVER_ID}`,
          "--label",
          `${COMPOSE_PROJECT_LABEL}=${this.project}`,
          network,
        ],
        timeoutMs: 60_000,
      });
    }
    this.docker.run({
      args: ["network", "connect", network, target.run_scoped_name],
      timeoutMs: 60_000,
    });
    // The commands' exit statuses are not the verdict; the container's
    // attachments are.
    const after = this.observeContainer(target.run_scoped_name);
    const applied = after?.networks.includes(network) === true;
    if (applied) {
      this.store.put({
        mutations: [
          ...this.store.state().mutations.filter((m) => m.mutation_id !== request.mutationId),
          {
            mutation_id: request.mutationId,
            container: target.run_scoped_name,
            target_identity_hash: target.identity_hash,
          },
        ],
      });
    }
    return this.remember(
      this.receipt({
        operation: "mutate",
        operationId: request.operationId,
        targetIdentityHash: target.identity_hash,
        before: observedState(before),
        after: observedState(after),
        status: applied ? "succeeded" : "failed",
        startedAt,
        ...(applied
          ? { compensationId: `compensate-${request.mutationId}` }
          : { errorCode: CODES.ENV_PROVISION_FAILED }),
      }),
    );
  }

  restore(request: RestoreRequest): EnvironmentOperationReceiptV1 {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "restore");
    const already = this.completedOperation(request.runId, request.operationId);
    if (already !== undefined) return already;

    const startedAt = this.clock.now();
    const container = this.containerName(this.endpointService());
    const network = this.challengeNetworkName();
    const graph = this.observeGraph();
    // A compensation is a write to the substrate, so it is subject to the same
    // rule as the activation was: an expected name is not ownership.
    this.assertVerifiedOwnership(graph.containers);
    const before = graph.containers.find((entry) => entry.name === container)?.observed;
    if (before?.networks.includes(network) === true) {
      const owned = graph.resources.find((r) => r.run_scoped_name === container);
      if (owned !== undefined) {
        assertOwnedByRun(request.runId, owned);
        assertNarrowSelector(request.runId, owned.run_scoped_name);
        this.docker.run({ args: ["network", "disconnect", network, container], timeoutMs: 60_000 });
      }
    }
    if (this.observeNetworkPresent(network)) {
      assertNarrowSelector(request.runId, network);
      this.docker.run({ args: ["network", "rm", network], timeoutMs: 60_000 });
    }
    // Re-observed, not assumed: the receipt's `after` is what Docker says now.
    const after = this.observeContainer(container);
    const reverted = after?.networks.includes(network) !== true && !this.observeNetworkPresent(network);
    if (reverted) this.store.put({ mutations: [] });
    return this.remember(
      this.receipt({
        operation: "restore",
        operationId: request.operationId,
        targetIdentityHash: this.instanceHash(),
        before: observedState(before),
        after: observedState(after),
        status: reverted ? "succeeded" : "failed",
        startedAt,
        ...(reverted ? {} : { errorCode: CODES.RESTORATION_FAILED }),
      }),
    );
  }

  // -- teardown -------------------------------------------------------------

  destroy(request: DestroyRequest): DestroyResult {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "destroy");
    const graph = this.observeGraph();
    const before = graph.resources;
    // Ownership is validated for every observed member before anything is
    // removed: a foreign object carrying this run's project label — or a live
    // object under one of this run's own names that Docker will not confirm is
    // this run's — must stop the whole-environment sledgehammer rather than be
    // swept up by it.
    this.assertVerifiedOwnership(graph.containers);
    for (const resource of before) {
      assertOwnedByRun(request.runId, resource);
      assertNarrowSelector(request.runId, resource.run_scoped_name);
    }
    const already = this.completedOperation(request.runId, request.operationId);
    if (already !== undefined) return { receipt: already, residue: this.observedResources() };

    const startedAt = this.clock.now();
    const down = this.compose(
      ["down", "--volumes", "--remove-orphans", "--timeout", String(DOWN_TIMEOUT_SECONDS)],
      (DOWN_TIMEOUT_SECONDS + 120) * 1000,
    );
    // Compose reporting success is not the verdict. The substrate is inspected
    // again, and what it still holds is the residue.
    const residue = this.observedResources();
    const clean = residue.length === 0;
    // The endpoint record describes a substrate that no longer exists, so it goes
    // with it. This is hygiene, not a control: `readComposeEndpoint` re-observes
    // Docker on every read, so a record that survived a crashed teardown still
    // authorizes nothing.
    if (clean) this.store.removeEndpoint();
    return {
      receipt: this.remember(
        this.receipt({
          operation: "destroy",
          operationId: request.operationId,
          targetIdentityHash: this.instanceHash(),
          before: { resources: before.map((r) => r.identity_hash) },
          after: { resources: residue.map((r) => r.identity_hash) },
          status: clean ? "succeeded" : "failed",
          startedAt,
          ...(clean
            ? {}
            : { errorCode: down.status === 0 ? CODES.ENV_RESIDUE_DETECTED : CODES.TEARDOWN_FAILED }),
        }),
      ),
      residue,
    };
  }

  /**
   * Removes exactly one owned object.
   *
   * Named individually, after both ownership and selector narrowness have passed
   * for that one object. This is what lets emergency cleanup attempt each
   * independently safe action on its own instead of swinging a whole-environment
   * destroy over a frontier that contains something it may not touch.
   */
  destroyResource(request: DestroyResourceRequest): EnvironmentOperationReceiptV1 {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "destroy");
    const already = this.completedOperation(request.runId, request.operationId);
    if (already !== undefined) return already;
    const graph = this.observeGraph();
    // Single-object removal is narrower than the sledgehammer but it is still a
    // deletion, and it may not be aimed at an object Docker does not confirm is
    // this run's.
    this.assertVerifiedOwnership(graph.containers);
    const resources = graph.resources;
    const target = resources.find((r) => r.resource_id === request.resourceId);
    if (target === undefined) {
      throw new Erl2Error(
        CODES.ENV_FOREIGN_RESOURCE_REJECTED,
        `resource ${request.resourceId} is not part of run ${request.runId}`,
      );
    }
    assertOwnedByRun(request.runId, target);
    assertNarrowSelector(request.runId, target.run_scoped_name);

    const startedAt = this.clock.now();
    const args =
      target.kind === "container"
        ? ["container", "rm", "--force", target.run_scoped_name]
        : target.kind === "network"
          ? ["network", "rm", target.run_scoped_name]
          : target.kind === "volume"
            ? ["volume", "rm", target.run_scoped_name]
            : undefined;
    if (args === undefined) {
      // `project` and `port` are not Docker objects: a project is the label its
      // members carry and a published port is a property of a container. Removing
      // them individually is not a thing the substrate supports, and saying so is
      // better than reporting a deletion that did not happen.
      return this.remember(
        this.receipt({
          operation: "destroy",
          operationId: request.operationId,
          targetIdentityHash: target.identity_hash,
          before: { resources: resources.map((r) => r.identity_hash) },
          after: { resources: resources.map((r) => r.identity_hash) },
          status: "failed",
          startedAt,
          errorCode: CODES.ENV_RESIDUE_DETECTED,
        }),
      );
    }
    this.docker.run({ args, timeoutMs: 120_000 });
    const remaining = this.observedResources();
    const gone = !remaining.some((r) => r.identity_hash === target.identity_hash);
    return this.remember(
      this.receipt({
        operation: "destroy",
        operationId: request.operationId,
        targetIdentityHash: target.identity_hash,
        before: { resources: resources.map((r) => r.identity_hash) },
        after: { resources: remaining.map((r) => r.identity_hash) },
        status: gone ? "succeeded" : "failed",
        startedAt,
        ...(gone ? {} : { errorCode: CODES.ENV_RESIDUE_DETECTED }),
      }),
    );
  }

  inspect(runId: string): EnvironmentResourceInventoryV1 {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "inspect");
    if (runId !== this.runId) {
      throw new Erl2Error(
        CODES.ENV_FOREIGN_RESOURCE_REJECTED,
        `this driver is bound to run ${this.runId} and cannot inspect run ${runId}`,
      );
    }
    return this.inventoryOf(this.observedResources());
  }
}

/** The Compose project name for a run. Exact, run-scoped, and never a prefix match. */
export function composeProjectName(runId: string): string {
  return `erl2-${runId}`;
}

/**
 * The substrate's identity.
 *
 * Derived, never random, so evidence stays byte-reproducible; and derived from
 * the *daemon* as well as the project, so the same marker beside a different
 * Docker engine is a different substrate. A raw path would not have been an
 * identity at all.
 */
export function substrateInstanceHash(engineId: string, project: string, establishedByRun: string): Hash {
  return domainHash(HASH_DOMAINS.DRIVER_STATE, {
    substrate_kind: COMPOSE_SUBSTRATE_KIND,
    locator: `${engineId}|${project}`,
    established_by_run: establishedByRun,
  });
}

function observedState(container: ObservedContainer | undefined): unknown {
  if (container === undefined) return { present: false };
  return {
    present: true,
    name: container.name,
    state: container.state,
    paused: container.paused,
    health: container.health,
    restart_count: container.restartCount,
    networks: [...container.networks],
    // The receipt's before/after therefore change if the bytes did, so a
    // substitution mid-operation is visible in the signed record rather than
    // only in the probe that came before it.
    image_id: container.imageId,
  };
}

function shortId(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-3).join("; ").slice(0, 240);
}

/** A host port a container may actually publish. */
export function isValidHostPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535;
}

export interface ComposeEndpoint {
  readonly host: string;
  readonly port: number;
  readonly container: string;
}

/**
 * The endpoint a later process may reach — validated against this run, then
 * re-observed against Docker.
 *
 * ## Why a retained record cannot authorize anything
 *
 * This record's only consumer turns it into a read-only mount and a one-host,
 * one-port egress allowlist for the subject. A JSON file is not evidence that a
 * substrate exists: it survives teardown, it survives a crash, it can be edited,
 * and the ephemeral host port it names can be handed to an unrelated process the
 * moment this run's container stops. So it is treated as a *hint about where to
 * look*, and the authorization comes from looking.
 *
 * Two gates, in this order:
 *
 *  1. **The record is this run's, exactly.** Every field is compared against a
 *    value derived here rather than read from the file: the run id, the substrate
 *    id, the endpoint service id, the container name this run's project would
 *    give that service, the one permitted loopback host, and a port that is a
 *    real port. A record that fails any of these describes something other than
 *    this run's endpoint, and since nothing but this driver writes it, that is a
 *    typed refusal rather than an absence.
 *
 *  2. **Docker still shows it.** The exact container is inspected by name, and all
 *    four of these must hold in live state:
 *      - its three ownership labels carry this run's exact values;
 *      - it is running;
 *      - it is running the image the lock pins for the endpoint service on the
 *        platform this daemon executes — the same two-legged rule the driver uses
 *        (`observeRunningImage`), not a second notion of it;
 *      - it publishes the record's port on **`8090/tcp` bound to `127.0.0.1`**,
 *        exactly. Not "some published port equals the recorded number": a binding
 *        on another container port, or on `0.0.0.0`, is a different exposure than
 *        the one that was qualified.
 *    Failing this is not tampering — a destroyed environment fails it, and so does
 *    a restarted container that Docker gave a different ephemeral port — so it
 *    yields `undefined`: no endpoint, therefore no mount and no egress
 *    allowlist. Access is withdrawn, not inherited.
 *
 * Together these are what make "the record is stale", "another process took the
 * port" and "the container was swapped for one running other bytes" unable to
 * grant reachability: the port is only ever accepted because *this run's own
 * container, running the locked image, is publishing it on loopback right now*.
 *
 * The lock is a parameter rather than a file read here because the caller has
 * already admitted it — signature verified and qualification asserted — and
 * re-reading it would be a second, unadmitted copy.
 */
export function readComposeEndpoint(
  substrateRoot: string,
  runId: string,
  lock: SubstrateLockV1,
  docker: DockerCli = new SpawnDockerCli(),
): ComposeEndpoint | undefined {
  const file = path.join(composeEndpointDirectory(substrateRoot, runId), "endpoint.json");
  if (!existsSync(file)) return undefined;
  const value = parseStrictJson(readFileSync(file, "utf8")) as Record<string, unknown>;
  // Explicitly typed so TypeScript treats a call to it as terminating control
  // flow, which is what lets the checks below read as the guards they are.
  const refuse: (why: string) => never = (why) => {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_UNREADABLE,
      `the run's Compose endpoint record is not this run's endpoint: ${why}`,
      { owner: "lab" },
    );
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse("it is not a record");
  }

  const expectedContainer = `${composeProjectName(runId)}-${OTEL_DEMO_ENDPOINT_SERVICE_ID}`;
  if (value["run_id"] !== runId) refuse("it names a different run");
  if (value["substrate_id"] !== OTEL_DEMO_SUBSTRATE_ID) refuse("it names a different substrate");
  if (value["service_id"] !== OTEL_DEMO_ENDPOINT_SERVICE_ID) refuse("it names a different service");
  if (value["container"] !== expectedContainer) refuse("it names a different container");
  // One exact literal, not a loopback family. `localhost` resolves through the
  // host's resolver, `0.0.0.0` is every interface, and `::1` is a different
  // address family — none of them is the address the subset publishes on.
  if (value["host"] !== LOOPBACK_HOST) refuse(`its host is not ${LOOPBACK_HOST}`);
  const port: unknown = value["port"];
  if (!isValidHostPort(port)) refuse("its port is not a host port");

  // -- and now the substrate itself ------------------------------------------
  const inspected = docker.run({
    args: ["container", "inspect", expectedContainer, "--format", "{{json .}}"],
    timeoutMs: 60_000,
  });
  if (inspected.status !== 0) return undefined;
  let raw: {
    State?: { Status?: string; Running?: boolean };
    Config?: { Labels?: Record<string, string> };
    Image?: string;
    NetworkSettings?: { Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> };
  };
  try {
    raw = parseStrictJson(inspected.stdout.trim()) as typeof raw;
  } catch {
    return undefined;
  }
  const labels = raw.Config?.Labels ?? {};
  if (labels[ERL2_RUN_LABEL] !== runId) return undefined;
  if (labels[ERL2_DRIVER_LABEL] !== COMPOSE_DRIVER_ID) return undefined;
  if (labels[COMPOSE_PROJECT_LABEL] !== composeProjectName(runId)) return undefined;
  if (raw.State?.Status !== "running") return undefined;

  // The locked image, by the driver's own rule. The platform is asked of the
  // daemon; a daemon that cannot say which images it executes cannot prove the
  // mapping, so that is `undefined` rather than a throw — no endpoint, fail closed.
  let endpointService: ComposeServiceSpec;
  let lockedReference: string;
  try {
    endpointService = OTEL_DEMO_SERVICES.find(
      (service) => service.serviceId === OTEL_DEMO_ENDPOINT_SERVICE_ID,
    ) as ComposeServiceSpec;
    lockedReference = pinnedImageReference(lock, endpointService, observeExecutingPlatform(docker));
  } catch {
    return undefined;
  }
  const image = observeRunningImage({
    docker,
    lockedReference,
    containerImageId: raw.Image ?? "",
  });
  if (!image.matchesLockedDigest) return undefined;

  // The exact binding: this container port, this interface, this host port.
  if (loopbackHostPort(observedBindings(raw.NetworkSettings?.Ports), OTEL_DEMO_ENDPOINT_CONTAINER_PORT) !== port) {
    return undefined;
  }

  return { host: LOOPBACK_HOST, port, container: expectedContainer };
}

/** The directory holding the endpoint record, for a read-only adapter mount. */
export function composeEndpointDirectory(substrateRoot: string, runId: string): string {
  return path.join(
    path.resolve(substrateRoot),
    `${Buffer.from(runId, "utf8").toString("base64url")}.compose-endpoint`,
  );
}
