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
 *   - `op-provision` — the run's containers and network exist, labelled;
 *   - `op-activate`  — the endpoint container is observed on the challenge network;
 *   - `op-restore`   — it is not, and the challenge network no longer exists;
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
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  lockedDigest,
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

/** The resource kinds this driver creates and is accountable for. */
const RESOURCE_KINDS = ["project", "network", "container", "port", "volume"] as const;

const UP_TIMEOUT_SECONDS = 240;
const DOWN_TIMEOUT_SECONDS = 30;

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
}

// -- what Docker says exists --------------------------------------------------

interface ObservedContainer {
  readonly name: string;
  readonly networks: readonly string[];
  readonly state: string;
  readonly paused: boolean;
  readonly health: string;
  readonly restartCount: number;
  readonly imageDigest: string;
  readonly runLabel: string;
  readonly projectLabel: string;
  readonly hostPort?: number;
}

interface ObservedObject {
  readonly name: string;
  readonly runLabel: string;
}

export class ComposeEnvironmentDriver implements EnvironmentDriver {
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
    const ports = raw.NetworkSettings?.Ports ?? {};
    let hostPort: number | undefined;
    for (const bindings of Object.values(ports)) {
      const first = bindings?.[0]?.HostPort;
      if (first !== undefined && first !== "") {
        hostPort = Number.parseInt(first, 10);
        break;
      }
    }
    return {
      name,
      networks: Object.keys(raw.NetworkSettings?.Networks ?? {}).sort(),
      state: raw.State?.Status ?? "unknown",
      paused: raw.State?.Paused === true,
      health: raw.State?.Health?.Status ?? "none",
      restartCount: raw.RestartCount ?? 0,
      imageDigest: raw.Image ?? "",
      runLabel: labels[ERL2_RUN_LABEL] ?? "",
      projectLabel: labels[COMPOSE_PROJECT_LABEL] ?? "",
      ...(hostPort === undefined ? {} : { hostPort }),
    };
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

  private observedResources(): readonly EnvironmentResourceV1[] {
    const resources: EnvironmentResourceV1[] = [];
    const containers = OTEL_DEMO_SERVICES.map((service) => ({
      service,
      observed: this.observeContainer(this.containerName(service)),
    }));
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
        this.resource(
          "container",
          entry.observed.name,
          `container-${entry.service.serviceId.replace(/[^a-z0-9-]/g, "-")}-${shortId(this.runId)}`,
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
    const endpoint = containers.find((entry) => entry.service.serviceId === OTEL_DEMO_ENDPOINT_SERVICE_ID);
    if (endpoint?.observed?.hostPort !== undefined) {
      resources.push(
        this.resource("port", `${this.project}-${OTEL_DEMO_ENDPOINT_SERVICE_ID}-port`, `port-${shortId(this.runId)}`),
      );
    }
    return resources;
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
      case "provision":
        return OTEL_DEMO_SERVICES.every(
          (service) => this.observeContainer(this.containerName(service)) !== undefined,
        );
      case "mutate":
        return this.challengeNetworkAttached();
      case "restore":
        return !this.challengeNetworkAttached() && this.observeNetworkPresent(this.challengeNetworkName()) === false;
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
      const observed = this.observedResources();
      return {
        receipt: completed,
        inventory: this.inventoryOf(observed),
        environmentInstanceHash: this.instanceHash(),
        partial: !this.completeGraph(observed),
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
    const observed = this.observedResources();
    const complete = up.status === 0 && this.completeGraph(observed);
    if (complete) this.writeEndpointRecord();

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

  /** Every member of the fixed service graph is present, and nothing foreign is. */
  private completeGraph(resources: readonly EnvironmentResourceV1[]): boolean {
    const names = new Set(resources.map((r) => r.run_scoped_name));
    const required = [
      this.project,
      this.networkName(),
      ...OTEL_DEMO_SERVICES.map((service) => this.containerName(service)),
      `${this.project}-${OTEL_DEMO_ENDPOINT_SERVICE_ID}-port`,
    ];
    return (
      required.every((name) => names.has(name)) &&
      resources.every((resource) => resource.run_scoped_name.includes(this.runId))
    );
  }

  /**
   * The run-local endpoint record.
   *
   * Written into its own directory so the CLI can mount exactly it, read-only,
   * into the adapter host. The published host port is ephemeral by design — the
   * upstream compose file publishes without a fixed host port, so two runs never
   * collide — which is precisely why a later process cannot guess it and has to
   * be told.
   */
  private writeEndpointRecord(): void {
    const endpoint = this.endpointService();
    const container = this.observeContainer(this.containerName(endpoint));
    if (container?.hostPort === undefined) return;
    this.store.writeEndpoint({
      run_id: this.runId,
      host: "127.0.0.1",
      port: container.hostPort,
      service_id: endpoint.serviceId,
      container: container.name,
      substrate_id: OTEL_DEMO_SUBSTRATE_ID,
    });
  }

  // -- probe ----------------------------------------------------------------

  probe(request: ProbeRequest): EnvironmentBaselineFingerprintV1 {
    assertDriverEnabled(this.manifest);
    assertOperationSupported(this.manifest, "probe");
    const probes: EnvironmentProbeResultV1[] = [];
    const observed = this.observedResources();
    const foreign = observed.filter((r) => !r.run_scoped_name.includes(this.runId));

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

    for (const service of OTEL_DEMO_SERVICES) {
      const container = this.observeContainer(this.containerName(service));
      // The observation deliberately excludes the container id, the host port and
      // every timestamp, and deliberately includes the image digest: two clean
      // provisions of this archetype must fingerprint identically, and they must
      // stop doing so if the bytes running in them change.
      const healthy =
        container !== undefined &&
        container.state === "running" &&
        !container.paused &&
        container.restartCount === 0 &&
        (container.health === "healthy" || container.health === "none");
      probes.push(
        this.probeResult(
          request,
          `probe-container-${service.serviceId}`,
          "health",
          `container-${service.serviceId}-${shortId(this.runId)}`,
          healthy,
          {
            kind: "container",
            service_id: service.serviceId,
            image_digest: lockedDigest(this.lock, service.serviceId, this.platform()),
            state: container?.state ?? "absent",
            paused: container?.paused ?? false,
            health: container?.health ?? "absent",
            restart_count: container?.restartCount ?? -1,
          },
        ),
      );
    }

    const endpoint = this.observeContainer(this.containerName(this.endpointService()));
    const published = endpoint?.hostPort !== undefined;
    probes.push(
      this.probeResult(request, "probe-port-quote", "presence", `port-${shortId(this.runId)}`, published, {
        kind: "port",
        container_port: this.endpointService().containerPort,
        published,
      }),
    );

    const collectorReady = this.observeCollectorPipeline();
    probes.push(
      this.probeResult(
        request,
        "probe-telemetry-pipeline",
        "telemetry",
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

  private evidenceSourceState(
    sourceId: string,
    probes: readonly EnvironmentProbeResultV1[],
  ): EvidenceSourceState["state"] {
    const passed = (id: string): boolean => probes.find((p) => p.probe_id === id)?.passed === true;
    switch (sourceId) {
      case "deployment-log":
        return OTEL_DEMO_SERVICES.every((s) => passed(`probe-container-${s.serviceId}`)) ? "complete" : "unavailable";
      case "service-metric":
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

  private collectorLogs(): string {
    const collector = OTEL_DEMO_SERVICES.find((s) => s.serviceId === "otel-collector") as ComposeServiceSpec;
    const result = this.docker.run({
      args: ["container", "logs", this.containerName(collector)],
      timeoutMs: 120_000,
    });
    if (result.status !== 0) return "";
    return `${result.stdout}\n${result.stderr}`;
  }

  /**
   * Telemetry the collector actually received, attributable to this run.
   *
   * Read-only, and not part of the `EnvironmentDriver` contract: it is a concrete
   * observation this concrete driver can make, exposed so a caller can prove that
   * the subject's interaction with the real endpoint really did produce
   * OpenTelemetry data and that the collector really did receive it. `marker` is
   * a string the caller arranged to appear in the emitted telemetry — the
   * reference adapter puts the run id in the request's query string, and the PHP
   * auto-instrumentation records it as `url.full`.
   */
  observeTelemetry(marker: string): {
    readonly traceBatches: number;
    readonly spans: number;
    readonly serviceNames: readonly string[];
    readonly runAttributedRecords: number;
  } {
    const logs = this.collectorLogs();
    let traceBatches = 0;
    let spans = 0;
    for (const line of logs.split("\n")) {
      const match = /\bTraces\b.*"spans":\s*(\d+)/.exec(line);
      if (match?.[1] === undefined) continue;
      traceBatches += 1;
      spans += Number.parseInt(match[1], 10);
    }
    const serviceNames = [...new Set([...logs.matchAll(/service\.name:\s*Str\(([^)]*)\)/g)].map((m) => m[1] ?? ""))];
    const runAttributedRecords = marker === "" ? 0 : logs.split(marker).length - 1;
    return { traceBatches, spans, serviceNames: serviceNames.sort(), runAttributedRecords };
  }

  // -- mutate and restore ---------------------------------------------------

  /** Whether the run's endpoint container is currently on the challenge network. */
  private challengeNetworkAttached(): boolean {
    const endpoint = this.observeContainer(this.containerName(this.endpointService()));
    return endpoint?.networks.includes(this.challengeNetworkName()) === true;
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

    const resources = this.observedResources();
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
    const before = this.observeContainer(container);
    if (before?.networks.includes(network) === true) {
      const owned = this.observedResources().find((r) => r.run_scoped_name === container);
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
    const before = this.observedResources();
    // Ownership is validated for every observed member before anything is
    // removed: a foreign object carrying this run's project label must stop the
    // whole-environment sledgehammer rather than be swept up by it.
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
    const resources = this.observedResources();
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
  };
}

function shortId(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-3).join("; ").slice(0, 240);
}

/** Reads the run-local endpoint record a later process needs to reach the substrate. */
export function readComposeEndpoint(
  substrateRoot: string,
  runId: string,
): { readonly host: string; readonly port: number; readonly container: string } | undefined {
  const file = path.join(
    path.resolve(substrateRoot),
    `${Buffer.from(runId, "utf8").toString("base64url")}.compose-endpoint`,
    "endpoint.json",
  );
  if (!existsSync(file)) return undefined;
  const value = parseStrictJson(readFileSync(file, "utf8")) as {
    host?: string;
    port?: number;
    container?: string;
  };
  if (typeof value.host !== "string" || typeof value.port !== "number" || typeof value.container !== "string") {
    throw new Erl2Error(
      CODES.ENV_SUBSTRATE_UNREADABLE,
      "the run's Compose endpoint record exists but is not an endpoint record",
      { owner: "lab" },
    );
  }
  return { host: value.host, port: value.port, container: value.container };
}

/** The directory holding the endpoint record, for a read-only adapter mount. */
export function composeEndpointDirectory(substrateRoot: string, runId: string): string {
  return path.join(
    path.resolve(substrateRoot),
    `${Buffer.from(runId, "utf8").toString("base64url")}.compose-endpoint`,
  );
}
