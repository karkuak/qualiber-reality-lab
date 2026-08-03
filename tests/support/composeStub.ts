/**
 * A stand-in Docker daemon for the Compose driver's adversarial matrix.
 *
 * ## Why it exists
 *
 * Most of what the OQ-005 matrix has to prove is about *refusal*, and a refusal
 * is exactly the case a real daemon cannot be asked to produce: there is no way
 * to make Docker hand back a container that carries this run's project label
 * under somebody else's name, or to make `docker compose up` half-succeed on
 * demand, or to make a registry claim an arm64 manifest is amd64. Those states
 * are reachable only by standing in for the substrate.
 *
 * ## What it is not
 *
 * It is not a second implementation of the driver and it never decides anything
 * the driver should decide. It answers `docker` argv from a small world model and
 * records every invocation, so a test can assert on **what the driver asked for**
 * — which is how "never discover or delete by wildcard or prefix" is proven
 * rather than asserted.
 *
 * A test that uses this stub proves the driver's *logic*. It does not prove the
 * driver works against Docker, and no test here claims that: the real-substrate
 * claim belongs to `tests/e2e/composeEnvironmentRun.test.ts`, which refuses to
 * pass when no daemon is present.
 */

import type { DockerCli, DockerInvocation, DockerResult } from "@erl2/core";

export interface StubContainer {
  labels: Record<string, string>;
  state: string;
  paused: boolean;
  health: string;
  restartCount: number;
  /** The image *id* `container inspect` reports for the bytes it runs. */
  image: string;
  networks: string[];
  hostPort?: number;
  logs: string;
}

export interface StubObject {
  labels: Record<string, string>;
}

export interface StubWorld {
  engineId: string;
  serverPlatform: string;
  containers: Map<string, StubContainer>;
  networks: Map<string, StubObject>;
  volumes: Map<string, StubObject>;
  /** Images present locally, by `repo@sha256:...`, to the platform they carry. */
  localImages: Map<string, string>;
  /** What the registry says a digest-pinned manifest describes. */
  registryImages: Map<string, string>;
  /**
   * The daemon's image store, keyed by *every* reference that resolves to an
   * entry: its own id and each `repo@digest` it publishes.
   *
   * This is what lets the driver's two-legged image check be modelled honestly.
   * `docker image inspect` accepts an id or a digest reference and answers with
   * one image, so the stub answers the same image for both and reports the
   * `RepoDigests` that image really carries — which is how a container running
   * bytes the lock does not pin becomes observable rather than assumed.
   */
  images: Map<string, StubImage>;
}

export interface StubImage {
  id: string;
  repoDigests: string[];
}

export interface StubBehaviour {
  /** Commands to fail (non-zero exit) instead of performing. */
  readonly fail?: (args: readonly string[]) => boolean;
  /** Commands to report success for while performing nothing — the lying substrate. */
  readonly drop?: (args: readonly string[]) => boolean;
  /** Runs after a `compose up`, so a test can arrange a partial provision. */
  readonly afterUp?: (world: StubWorld) => void;
}

const COLLECTOR_READY_LOG = "2026-08-03T00:00:00.000Z\tinfo\tservice@v0.157.0/service.go\tEverything is ready. Begin running and processing data.\n";

export function newStubWorld(options: { readonly platform?: string } = {}): StubWorld {
  return {
    engineId: "stub-engine-0001",
    serverPlatform: options.platform ?? "linux/arm64",
    containers: new Map(),
    networks: new Map(),
    volumes: new Map(),
    localImages: new Map(),
    registryImages: new Map(),
    images: new Map(),
  };
}

/**
 * Puts one image in the stub daemon's store, reachable by its id and by every
 * repository digest it publishes — exactly as a real daemon resolves both.
 */
export function putStubImage(world: StubWorld, id: string, repoDigests: readonly string[]): StubImage {
  const image: StubImage = { id, repoDigests: [...repoDigests] };
  world.images.set(id, image);
  for (const reference of repoDigests) world.images.set(reference, image);
  return image;
}

export class StubDockerCli implements DockerCli {
  readonly world: StubWorld;
  readonly invocations: string[][] = [];
  private readonly behaviour: StubBehaviour;
  /** The services a `compose up` materialises, and their container names. */
  private readonly plan: {
    readonly project: string;
    readonly services: readonly { readonly serviceId: string; readonly hostPort?: number }[];
  };

  constructor(
    world: StubWorld,
    plan: { readonly project: string; readonly services: readonly { readonly serviceId: string; readonly hostPort?: number }[] },
    behaviour: StubBehaviour = {},
  ) {
    this.world = world;
    this.plan = plan;
    this.behaviour = behaviour;
  }

  /** Every argv the driver has issued, joined, for selector assertions. */
  get issued(): readonly string[] {
    return this.invocations.map((args) => args.join(" "));
  }

  run(invocation: DockerInvocation): DockerResult {
    const args = [...invocation.args];
    this.invocations.push(args);
    if (this.behaviour.fail?.(args) === true) {
      return { args, status: 1, stdout: "", stderr: "stub: command failed", timedOut: false };
    }
    if (this.behaviour.drop?.(args) === true) {
      return { args, status: 0, stdout: "", stderr: "", timedOut: false };
    }
    return { args, ...this.dispatch(args, invocation.env ?? {}) };
  }

  private ok(stdout = ""): { status: number; stdout: string; stderr: string; timedOut: boolean } {
    return { status: 0, stdout, stderr: "", timedOut: false };
  }

  private no(stderr = "stub: no such object"): {
    status: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  } {
    return { status: 1, stdout: "", stderr, timedOut: false };
  }

  private dispatch(
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ): {
    status: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  } {
    const [head, second] = args;
    if (head === "version") return this.ok(`${this.world.serverPlatform}\n`);
    if (head === "info") return this.ok(`${this.world.engineId}\n`);
    if (head === "container" && second === "inspect") return this.inspectContainer(args);
    if (head === "container" && second === "logs") {
      return this.ok(this.world.containers.get(args[2] as string)?.logs ?? "");
    }
    if (head === "container" && second === "rm") {
      this.world.containers.delete(args.at(-1) as string);
      return this.ok();
    }
    if (head === "image" && second === "inspect") return this.inspectImage(args);
    if (head === "buildx") {
      const platform = this.world.registryImages.get(args[3] as string);
      return platform === undefined ? this.no() : this.ok(`${platform}\n`);
    }
    if (head === "ps") return this.list(args, this.world.containers);
    if (head === "network" && second === "ls") return this.list(args, this.world.networks);
    if (head === "volume" && second === "ls") return this.list(args, this.world.volumes);
    if (head === "network" && second === "inspect") {
      return this.world.networks.has(args[2] as string) ? this.ok(`${args[2] as string}\n`) : this.no();
    }
    if (head === "network" && second === "create") {
      this.world.networks.set(args.at(-1) as string, { labels: labelsFrom(args) });
      return this.ok();
    }
    if (head === "network" && second === "connect") {
      const container = this.world.containers.get(args[3] as string);
      if (container === undefined) return this.no();
      if (!container.networks.includes(args[2] as string)) container.networks.push(args[2] as string);
      return this.ok();
    }
    if (head === "network" && second === "disconnect") {
      const container = this.world.containers.get(args[3] as string);
      if (container === undefined) return this.no();
      container.networks = container.networks.filter((n) => n !== args[2]);
      return this.ok();
    }
    if (head === "network" && second === "rm") {
      this.world.networks.delete(args[2] as string);
      return this.ok();
    }
    if (head === "volume" && second === "rm") {
      this.world.volumes.delete(args[2] as string);
      return this.ok();
    }
    if (head === "compose") return this.compose(args, env);
    return this.no(`stub: unhandled command ${args.join(" ")}`);
  }

  private inspectContainer(args: readonly string[]): {
    status: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  } {
    const container = this.world.containers.get(args[2] as string);
    if (container === undefined) return this.no();
    return this.ok(
      `${JSON.stringify({
        State: {
          Status: container.state,
          Paused: container.paused,
          ...(container.health === "none" ? {} : { Health: { Status: container.health } }),
        },
        RestartCount: container.restartCount,
        Config: { Labels: container.labels },
        Image: container.image,
        NetworkSettings: {
          Networks: Object.fromEntries(container.networks.map((n) => [n, {}])),
          Ports:
            container.hostPort === undefined
              ? {}
              : { "8090/tcp": [{ HostPort: String(container.hostPort) }] },
        },
      })}\n`,
    );
  }

  /**
   * `docker image inspect <ref>`, answering the three formats the Lab asks for.
   *
   * The platform question is served from `localImages` — the admission path's
   * world model, keyed by pinned reference. The id and repository-digest
   * questions are served from `images`, the daemon's own store, which is keyed by
   * id *and* by every digest that resolves to it. An unknown reference is a
   * non-zero exit, exactly as Docker gives, so "cannot prove" reaches the driver
   * as a failure rather than as an empty answer.
   */
  private inspectImage(args: readonly string[]): {
    status: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  } {
    const reference = args[2] as string;
    const format = args[args.indexOf("--format") + 1] ?? "";
    if (format === "{{.Os}}/{{.Architecture}}") {
      const platform = this.world.localImages.get(reference);
      return platform === undefined ? this.no() : this.ok(`${platform}\n`);
    }
    const image = this.world.images.get(reference);
    if (image === undefined) return this.no();
    if (format === "{{.Id}}") return this.ok(`${image.id}\n`);
    if (format === "{{json .RepoDigests}}") return this.ok(`${JSON.stringify(image.repoDigests)}\n`);
    return this.no(`stub: unhandled image inspect format ${format}`);
  }

  /** `--filter label=k=v` is honoured as exact equality, which is all the driver uses. */
  private list(
    args: readonly string[],
    objects: ReadonlyMap<string, StubObject | StubContainer>,
  ): { status: number; stdout: string; stderr: string; timedOut: boolean } {
    const filterIndex = args.indexOf("--filter");
    const filter = filterIndex >= 0 ? (args[filterIndex + 1] ?? "") : "";
    const [key, value] = filter.replace(/^label=/, "").split("=");
    const labelIndex = /\.Label "([^"]+)"/.exec(args[args.indexOf("--format") + 1] ?? "");
    const rows: string[] = [];
    for (const [name, object] of objects) {
      if (key !== undefined && object.labels[key] !== value) continue;
      rows.push(`${name}\t${labelIndex ? (object.labels[labelIndex[1] as string] ?? "") : ""}`);
    }
    return this.ok(rows.length === 0 ? "" : `${rows.join("\n")}\n`);
  }

  private compose(
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ): {
    status: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  } {
    if (args.includes("pull")) return this.ok();
    if (args.includes("up")) {
      this.world.networks.set(`${this.plan.project}-net`, {
        labels: { "com.docker.compose.project": this.plan.project },
      });
      for (const service of this.plan.services) {
        const name = `${this.plan.project}-${service.serviceId}`;
        // The container runs whatever image the overlay's interpolation variable
        // pinned, resolved through the daemon's store — which is what Compose
        // does, and what makes a substituted image a state the stub can be *put
        // into* rather than one it has to be told about.
        const pinned = env[`ERL2_IMAGE_${service.serviceId.toUpperCase().replace(/-/g, "_")}`] ?? "";
        this.world.containers.set(name, {
          labels: {
            "com.erl2.run_id": this.plan.project.replace(/^erl2-/, ""),
            "com.erl2.driver_id": "compose-driver",
            "com.docker.compose.project": this.plan.project,
          },
          state: "running",
          paused: false,
          health: service.serviceId === "quote" ? "healthy" : "none",
          restartCount: 0,
          image: this.world.images.get(pinned)?.id ?? `sha256:unresolved-${service.serviceId}`,
          networks: [`${this.plan.project}-net`],
          ...(service.hostPort === undefined ? {} : { hostPort: service.hostPort }),
          logs: service.serviceId === "otel-collector" ? COLLECTOR_READY_LOG : "",
        });
      }
      this.behaviour.afterUp?.(this.world);
      return this.ok();
    }
    if (args.includes("down")) {
      for (const [name, container] of [...this.world.containers]) {
        if (container.labels["com.docker.compose.project"] === this.plan.project) {
          this.world.containers.delete(name);
        }
      }
      for (const [name, network] of [...this.world.networks]) {
        if (network.labels["com.docker.compose.project"] === this.plan.project) {
          this.world.networks.delete(name);
        }
      }
      return this.ok();
    }
    return this.ok();
  }
}

function labelsFrom(args: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--label") continue;
    const [key, value] = (args[i + 1] ?? "").split("=");
    if (key !== undefined) labels[key] = value ?? "";
  }
  return labels;
}

/** Appends a collector log line carrying real-looking trace output for a run. */
export function withTelemetry(world: StubWorld, collectorName: string, runId: string, spans: number): void {
  const container = world.containers.get(collectorName);
  if (container === undefined) return;
  container.logs +=
    `2026-08-03T00:00:01.000Z\tinfo\tTraces\t{"otelcol.signal": "traces", "resource spans": 1, "spans": ${String(spans)}}\n` +
    `     -> service.name: Str(quote)\n` +
    `     -> url.full: Str(http://127.0.0.1:18090/getquote?erl2_run=${runId})\n`;
}
