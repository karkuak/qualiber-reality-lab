/**
 * The endpoint record and the egress grant it is turned into (ERL2-OQ-005).
 *
 * ## What is being defended
 *
 * One JSON file, written beside the substrate by `provision`, is the only thing
 * that tells a later process where this run's endpoint is. Its consumer mounts the
 * directory holding it read-only into the adapter host and builds a one-host,
 * one-port egress allowlist from its contents. That makes the file the narrowest
 * and most attractive thing in the run to forge: a record naming
 * `example.com:80` would, on its own, have widened a deny-by-default egress
 * policy to a public **host**. The port in that example is incidental — `80` is a
 * perfectly valid numeric port and is accepted on `127.0.0.1`; it is the host that
 * makes the record inadmissible.
 *
 * So the record authorizes nothing by existing. It is checked twice, and the two
 * checks are deliberately different in kind:
 *
 *   - **against this run** — every field is compared to a value derived from the
 *     run id rather than read from the file. This catches a record that describes
 *     something else, and since nothing but the driver writes it, that is a typed
 *     refusal;
 *   - **against Docker** — the exact container is re-inspected, its ownership
 *     labels must be this run's, it must be running, and it must *currently*
 *     publish the port the record names. This catches a record that has merely
 *     gone stale, which is not tampering, so it withdraws access instead of
 *     failing the command.
 *
 * The second check is why a destroyed environment, a restarted container with a
 * new ephemeral port, and a port some unrelated process picked up cannot be
 * reached through a retained file.
 *
 * The `loopbackEgressPolicy` cases are separate on purpose: the policy builder
 * validates its own arguments, so the grant is refused even by a caller that
 * never went through the reader.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertContract, type Hash, type SubstrateLockV1 } from "@erl2/contracts";
import { developmentKey, sealSigned } from "@erl2/integrity";
import {
  composeEndpointDirectory,
  composeProjectName,
  loopbackEgressPolicy,
  OTEL_DEMO_SERVICES,
  readComposeEndpoint,
  uuidV7From,
} from "@erl2/core";
import {
  loopbackBinding,
  newStubWorld,
  putStubImage,
  StubDockerCli,
  type StubContainer,
  type StubWorld,
} from "../support/composeStub.js";
import { ownedTempDir } from "../support/tempDirs.js";

const RUN_ID = uuidV7From(1_785_000_000_000, Buffer.alloc(10, 0x62));
const OTHER_RUN_ID = uuidV7From(1_785_000_000_001, Buffer.alloc(10, 0x63));
const PROJECT = composeProjectName(RUN_ID);
const ENDPOINT_CONTAINER = `${PROJECT}-quote`;
const PORT = 18_090;

/**
 * The digests the lock pins, and the ids this stub daemon resolves them to.
 *
 * The id is deliberately not the digest: a real daemon's `.Image` is a content id,
 * so a fixture whose id equalled the digest would prove the reader compares two
 * spellings of one string rather than resolving one through Docker to reach the
 * other. `linux/arm64` is the platform the stub daemon reports.
 */
const ARM64: Hash = `sha256:${"a".repeat(64)}`;
const AMD64: Hash = `sha256:${"b".repeat(64)}`;
const QUOTE_REPOSITORY = OTEL_DEMO_SERVICES.find((s) => s.serviceId === "quote")?.imageRepository as string;
const QUOTE_LOCKED_REFERENCE = `${QUOTE_REPOSITORY}@${ARM64}`;
const QUOTE_IMAGE_ID = `sha256:${"1".repeat(64)}`;
/** Bytes the lock does not pin, published under a repository it does not name. */
const FOREIGN_IMAGE_ID = `sha256:${"f".repeat(64)}`;
const FOREIGN_REFERENCE = `ghcr.io/not-open-telemetry/demo@sha256:${"e".repeat(64)}`;

function lockFixture(): SubstrateLockV1 {
  const body = {
    schema_version: "substrate-lock/v1" as const,
    lock_id: "endpoint-egress-lock",
    substrate_id: "opentelemetry-demo",
    qualification_status: "qualified" as const,
    source_archive: {
      release_tag: "3.0.0",
      source_commit: "0".repeat(40),
      archive_sha256: `sha256:${"c".repeat(64)}` as Hash,
    },
    images: OTEL_DEMO_SERVICES.flatMap((service) => [
      { service_id: service.serviceId, platform: "linux/amd64" as const, digest: AMD64 },
      { service_id: service.serviceId, platform: "linux/arm64" as const, digest: ARM64 },
    ]),
    sbom: {
      path: "environments/otel-demo/qualification/sbom.json",
      media_type: "application/json",
      byte_length: 2,
      file_sha256: `sha256:${"d".repeat(64)}` as Hash,
      classification: "PUBLIC" as const,
    },
    provenance: { producer: "erl2-test", producer_version: "0.1.0", transformations: [] as string[] },
    config_hashes: [`sha256:${"9".repeat(64)}` as Hash],
    recorded_at: "2026-08-03T00:00:00Z",
  };
  return assertContract<SubstrateLockV1>("SubstrateLockV1", sealSigned(body, developmentKey("challenge-governor")));
}

const LOCK = lockFixture();

/** The record `provision` writes over a verified graph. */
function goodRecord(): Record<string, unknown> {
  return {
    run_id: RUN_ID,
    host: "127.0.0.1",
    port: PORT,
    service_id: "quote",
    container: ENDPOINT_CONTAINER,
    substrate_id: "opentelemetry-demo",
  };
}

/** The live container `provision` would have left behind: locked image, loopback binding. */
function liveEndpoint(overrides: Partial<StubContainer> = {}): StubContainer {
  return {
    labels: {
      "com.erl2.run_id": RUN_ID,
      "com.erl2.driver_id": "compose-driver",
      "com.docker.compose.project": PROJECT,
    },
    state: "running",
    paused: false,
    health: "healthy",
    restartCount: 0,
    image: QUOTE_IMAGE_ID,
    networks: [`${PROJECT}-net`],
    ports: loopbackBinding(PORT),
    logs: "",
    ...overrides,
  };
}

interface Fixture {
  readonly substrateRoot: string;
  readonly world: StubWorld;
  readonly docker: StubDockerCli;
}

function fixture(
  options: {
    readonly record?: Record<string, unknown> | null;
    readonly container?: StubContainer | null;
    /** Omit the locked image from the daemon's store, so neither leg can resolve. */
    readonly withoutLockedImage?: boolean;
  } = {},
): Fixture {
  const substrateRoot = ownedTempDir("erl2-compose-endpoint-");
  const directory = composeEndpointDirectory(substrateRoot, RUN_ID);
  if (options.record !== null) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "endpoint.json"), `${JSON.stringify(options.record ?? goodRecord())}\n`);
  }
  const world = newStubWorld();
  if (options.withoutLockedImage !== true) {
    putStubImage(world, QUOTE_IMAGE_ID, [QUOTE_LOCKED_REFERENCE]);
  }
  // The substituted image is always in the store; what makes it a substitution is
  // that it publishes a repository digest the lock does not pin.
  putStubImage(world, FOREIGN_IMAGE_ID, [FOREIGN_REFERENCE]);
  const container = options.container === undefined ? liveEndpoint() : options.container;
  if (container !== null) world.containers.set(ENDPOINT_CONTAINER, container);
  const docker = new StubDockerCli(world, { project: PROJECT, services: [] });
  return { substrateRoot, world, docker };
}

function read(f: Fixture): ReturnType<typeof readComposeEndpoint> {
  return readComposeEndpoint(f.substrateRoot, RUN_ID, LOCK, f.docker);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
  return "NO_REFUSAL";
}

// -- the record has to be this run's endpoint --------------------------------
//
// Each of these is a forged or mistaken record, and each one is refused with a
// typed code rather than being narrowed into a grant. The refusal is the same in
// every case because the check is the same in every case: the value is compared
// against one derived here.

test("COMPOSE-EGRESS-ADV: a record naming an arbitrary public host is refused", () => {
  // The reproduced defect, exactly: only the *types* of host, port and container
  // were checked, so this record became a `http://example.com:80` allowlist.
  //
  // It is the **host** that makes this record inadmissible. `80` is a perfectly
  // valid numeric port and would be accepted on `127.0.0.1`; nothing here treats a
  // port number as suspicious, and a rule that did would be a different rule than
  // the one being tested.
  const f = fixture({ record: { ...goodRecord(), host: "example.com", port: 80 } });
  assert.equal(codeOf(() => read(f)), "ENV_SUBSTRATE_UNREADABLE");

  // Same port, admissible host: the record passes validation and is then decided
  // by live Docker, which is where it belongs.
  const loopback80 = fixture({
    record: { ...goodRecord(), port: 80 },
    container: liveEndpoint({ ports: loopbackBinding(80) }),
  });
  assert.deepEqual(read(loopback80), { host: "127.0.0.1", port: 80, container: ENDPOINT_CONTAINER });
});

test("COMPOSE-EGRESS-ADV: a record naming a non-canonical loopback spelling is refused", () => {
  // `localhost` resolves through the host's resolver, `0.0.0.0` is every
  // interface and `::1` is another address family. None is the address the subset
  // publishes on, so none may stand in for it.
  for (const host of ["localhost", "0.0.0.0", "::1", "[::1]", "127.0.0.2", "127.1"]) {
    const f = fixture({ record: { ...goodRecord(), host } });
    assert.equal(codeOf(() => read(f)), "ENV_SUBSTRATE_UNREADABLE", `host ${host} was accepted`);
  }
});

test("COMPOSE-EGRESS-ADV: a record naming a different run is refused", () => {
  const f = fixture({ record: { ...goodRecord(), run_id: OTHER_RUN_ID } });
  assert.equal(codeOf(() => read(f)), "ENV_SUBSTRATE_UNREADABLE");
});

test("COMPOSE-EGRESS-ADV: a record naming a different substrate is refused", () => {
  const f = fixture({ record: { ...goodRecord(), substrate_id: "some-other-demo" } });
  assert.equal(codeOf(() => read(f)), "ENV_SUBSTRATE_UNREADABLE");
});

test("COMPOSE-EGRESS-ADV: a record naming a different service is refused", () => {
  const f = fixture({ record: { ...goodRecord(), service_id: "otel-collector" } });
  assert.equal(codeOf(() => read(f)), "ENV_SUBSTRATE_UNREADABLE");
});

test("COMPOSE-EGRESS-ADV: a record naming a different container is refused", () => {
  // Including another run's endpoint container, which is a live object that would
  // otherwise have answered the inspection perfectly well.
  for (const container of [
    `${composeProjectName(OTHER_RUN_ID)}-quote`,
    `${PROJECT}-otel-collector`,
    "quote",
  ]) {
    const f = fixture({ record: { ...goodRecord(), container } });
    assert.equal(codeOf(() => read(f)), "ENV_SUBSTRATE_UNREADABLE", `container ${container} was accepted`);
  }
});

test("COMPOSE-EGRESS-ADV: a malformed or out-of-range port is refused", () => {
  for (const port of [0, -1, 1.5, 65_536, 70_000, Number.NaN, "18090", null, undefined]) {
    const f = fixture({ record: { ...goodRecord(), port } });
    assert.equal(
      codeOf(() => read(f)),
      "ENV_SUBSTRATE_UNREADABLE",
      `port ${JSON.stringify(port)} was accepted`,
    );
  }
});

test("COMPOSE-EGRESS-ADV: a record missing a required field is refused", () => {
  for (const field of ["run_id", "host", "port", "service_id", "container", "substrate_id"]) {
    const record = goodRecord();
    delete record[field];
    const f = fixture({ record });
    assert.equal(codeOf(() => read(f)), "ENV_SUBSTRATE_UNREADABLE", `a record without ${field} was accepted`);
  }
});

// -- and Docker has to still show it -----------------------------------------
//
// These are not forgeries. A perfectly well-formed record describes a substrate
// that has changed underneath it, and the answer is "no endpoint" — which means
// no mount and no egress allowlist — rather than a command failure.

test("COMPOSE-EGRESS-ADV: a well-formed record over a verified live container grants the endpoint", () => {
  const f = fixture();
  assert.deepEqual(read(f), { host: "127.0.0.1", port: PORT, container: ENDPOINT_CONTAINER });
});

test("COMPOSE-EGRESS-ADV: a record whose container no longer exists grants nothing", () => {
  const f = fixture({ container: null });
  assert.equal(read(f), undefined);
});

test("COMPOSE-EGRESS-ADV: a stale record surviving teardown grants nothing", () => {
  // The record is exactly what a good provision wrote. Then `destroy` ran: the
  // container is gone and the file is all that is left of it.
  const f = fixture();
  assert.notEqual(read(f), undefined);
  f.world.containers.delete(ENDPOINT_CONTAINER);
  assert.equal(read(f), undefined, "a retained JSON record must never outlive the substrate it describes");
});

test("COMPOSE-EGRESS-ADV: a live container missing or misvaluing an ownership label grants nothing", () => {
  for (const label of ["com.erl2.run_id", "com.erl2.driver_id", "com.docker.compose.project"]) {
    const wrong = liveEndpoint();
    wrong.labels[label] = "not-this-run";
    assert.equal(read(fixture({ container: wrong })), undefined, `a wrong ${label} was accepted`);

    const missing = liveEndpoint();
    delete missing.labels[label];
    assert.equal(read(fixture({ container: missing })), undefined, `a missing ${label} was accepted`);
  }
});

test("COMPOSE-EGRESS-ADV: a container that is not running grants nothing", () => {
  for (const state of ["exited", "created", "paused", "restarting", "dead"]) {
    assert.equal(read(fixture({ container: liveEndpoint({ state }) })), undefined, `state ${state} was accepted`);
  }
});

test("COMPOSE-EGRESS-ADV: a container now publishing a different port grants nothing", () => {
  // The container restarted and Docker gave it another ephemeral port. The record
  // still names the old one, and the old one is not this run's endpoint any more —
  // it may well be somebody else's.
  const f = fixture({ container: liveEndpoint({ ports: loopbackBinding(PORT + 1) }) });
  assert.equal(read(f), undefined);
});

test("COMPOSE-EGRESS-ADV: a container publishing nothing grants nothing", () => {
  assert.equal(read(fixture({ container: liveEndpoint({ ports: {} }) })), undefined);
});

// -- the exact binding -------------------------------------------------------
//
// "The recorded number appears somewhere in this container's published ports" is
// not the property that was qualified. The qualified exposure is one container
// port on one interface, and each of these is a live binding that satisfies the
// loose reading and not the exact one.

test("COMPOSE-EGRESS-ADV: the recorded port published from the WRONG container port grants nothing", () => {
  // Right host port, right interface, wrong container port. Under the loose rule
  // this authorized the subject to reach a port that is not the endpoint at all.
  for (const containerPort of ["4317/tcp", "4318/tcp", "8080/tcp", "8090/udp", "18090/tcp"]) {
    const wrong = liveEndpoint({
      ports: { [containerPort]: [{ HostIp: "127.0.0.1", HostPort: String(PORT) }] },
    });
    assert.equal(
      read(fixture({ container: wrong })),
      undefined,
      `container port ${containerPort} was accepted as the endpoint`,
    );
  }
});

test("COMPOSE-EGRESS-ADV: a binding on any interface but 127.0.0.1 grants nothing", () => {
  // `0.0.0.0` and `::` are every interface, which is reachable from the local
  // network — a different exposure than the loopback-only one that was qualified.
  // A missing `HostIp` is the shape upstream's own port entry produced, and it is
  // refused rather than assumed to be loopback.
  for (const hostIp of ["0.0.0.0", "::", "192.168.1.10", "localhost", ""]) {
    const wrong = liveEndpoint({ ports: { "8090/tcp": [{ HostIp: hostIp, HostPort: String(PORT) }] } });
    assert.equal(read(fixture({ container: wrong })), undefined, `HostIp ${JSON.stringify(hostIp)} was accepted`);
  }
  const noHostIp = liveEndpoint({ ports: { "8090/tcp": [{ HostPort: String(PORT) }] } });
  assert.equal(read(fixture({ container: noHostIp })), undefined, "a missing HostIp was accepted");
});

test("COMPOSE-EGRESS-ADV: an unrelated published binding does not stand in for the endpoint's", () => {
  // The endpoint's own container port is bound on loopback but to a *different*
  // host port; the recorded number is published, on loopback, under another
  // container port. Both halves are present and neither is the endpoint.
  const decoy = liveEndpoint({
    ports: {
      "8090/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT + 7) }],
      "4317/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT) }],
    },
  });
  assert.equal(read(fixture({ container: decoy })), undefined);
});

test("COMPOSE-EGRESS-ADV: the canonical binding — 8090/tcp on 127.0.0.1 at the recorded port — grants it", () => {
  const f = fixture({
    container: liveEndpoint({
      ports: {
        // Extra bindings on other container ports are irrelevant, not disqualifying:
        // the rule is that the endpoint's own port is bound on loopback, and it is.
        "8090/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT) }],
        "9464/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT + 3) }],
      },
    }),
  });
  assert.deepEqual(read(f), { host: "127.0.0.1", port: PORT, container: ENDPOINT_CONTAINER });
});

// -- and it has to be running the locked image -------------------------------
//
// The gap these close: the fixture above used to carry an arbitrary image id, and
// authorization was granted anyway. Name, labels, state and port were checked;
// what the container was *running* was not.

test("COMPOSE-EGRESS-ADV: the exact expected container running a substituted image grants nothing", () => {
  // Exact name, all three ownership labels correct, running, canonical loopback
  // binding — and bytes the lock does not pin.
  const substituted = liveEndpoint({ image: FOREIGN_IMAGE_ID });
  assert.equal(
    read(fixture({ container: substituted })),
    undefined,
    "an exact-name container running an unpinned image was authorized",
  );
});

test("COMPOSE-EGRESS-ADV: an unresolvable pinned image grants nothing", () => {
  // The daemon cannot resolve `repository@digest` at all, so leg one is unproven.
  // Unproven is refused, not assumed.
  assert.equal(read(fixture({ withoutLockedImage: true })), undefined);
});

test("COMPOSE-EGRESS-ADV: image id and repository digest disagreeing grants nothing", () => {
  // Leg one passes and leg two fails: the container reports the id the locked
  // reference resolves to, but that image publishes a digest the lock does not
  // name — the shape a re-tag produces. Both legs are required.
  const f = fixture({ withoutLockedImage: true });
  putStubImage(f.world, QUOTE_IMAGE_ID, [FOREIGN_REFERENCE]);
  f.world.images.set(QUOTE_LOCKED_REFERENCE, { id: QUOTE_IMAGE_ID, repoDigests: [FOREIGN_REFERENCE] });
  assert.equal(read(f), undefined);

  // And the converse: leg two passes while leg one does not, because the locked
  // reference resolves to different bytes than the container is running.
  const g = fixture();
  g.world.images.set(QUOTE_LOCKED_REFERENCE, {
    id: `sha256:${"7".repeat(64)}`,
    repoDigests: [QUOTE_LOCKED_REFERENCE],
  });
  assert.equal(read(g), undefined);
});

test("COMPOSE-EGRESS-ADV: the exact locked image and endpoint mapping succeeds", () => {
  // The positive case, stated once and completely: the container Docker reports is
  // this run's by all three labels, running, publishing 8090/tcp on 127.0.0.1 at
  // the recorded port, and running an image that resolves both ways to the digest
  // the lock pins for this platform.
  const f = fixture();
  const container = f.world.containers.get(ENDPOINT_CONTAINER) as StubContainer;
  assert.equal(container.image, QUOTE_IMAGE_ID);
  assert.deepEqual(f.world.images.get(QUOTE_LOCKED_REFERENCE)?.repoDigests, [QUOTE_LOCKED_REFERENCE]);
  assert.deepEqual(read(f), { host: "127.0.0.1", port: PORT, container: ENDPOINT_CONTAINER });
});

test("COMPOSE-EGRESS-ADV: a foreign container that took over the port grants nothing", () => {
  // The run's own container is gone and something else now answers on the port the
  // record names. Nothing about the port is consulted except through *this run's
  // own verified container*, so a reused port cannot be reached at all.
  const f = fixture({ container: null });
  f.world.containers.set("someone-elses-service", liveEndpoint({ labels: {} }));
  assert.equal(read(f), undefined);
});

test("COMPOSE-EGRESS-ADV: no record at all grants nothing, and is not an error", () => {
  const f = fixture({ record: null, container: null });
  assert.equal(read(f), undefined);
});

test("COMPOSE-EGRESS-ADV: an unreadable record is a refusal, not an absence", () => {
  const f = fixture();
  const file = path.join(composeEndpointDirectory(f.substrateRoot, RUN_ID), "endpoint.json");
  rmSync(file);
  writeFileSync(file, "{ not json\n");
  assert.notEqual(codeOf(() => read(f)), "NO_REFUSAL");
});

// -- the policy builder validates its own arguments --------------------------

test("COMPOSE-EGRESS-ADV: loopbackEgressPolicy refuses any host but 127.0.0.1", () => {
  for (const host of ["example.com", "localhost", "0.0.0.0", "::1", "127.0.0.2", "169.254.169.254", ""]) {
    assert.equal(
      codeOf(() => loopbackEgressPolicy("erl2-environment-endpoint", host, PORT)),
      "ADAPTER_EGRESS_HOST_NOT_ALLOWED",
      `host ${JSON.stringify(host)} was allowlisted`,
    );
  }
});

test("COMPOSE-EGRESS-ADV: loopbackEgressPolicy refuses a port that is not a host port", () => {
  for (const port of [0, -1, -443, 1.5, 65_536, 70_000, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      codeOf(() => loopbackEgressPolicy("erl2-environment-endpoint", "127.0.0.1", port)),
      "ADAPTER_EGRESS_PORT_NOT_ALLOWED",
      `port ${JSON.stringify(port)} was allowlisted`,
    );
  }
});

test("COMPOSE-EGRESS-ADV: the granted policy is still one scheme, one host, one port", () => {
  const policy = loopbackEgressPolicy("erl2-environment-endpoint", "127.0.0.1", PORT);
  assert.equal(policy.default_action, "deny");
  assert.deepEqual(policy.allowed_schemes, ["http"]);
  assert.deepEqual(policy.allowed_hosts, ["127.0.0.1"]);
  assert.deepEqual(policy.allowed_ports, [PORT]);
  assert.deepEqual(policy.allow_loopback_hosts, ["127.0.0.1"]);
  assert.equal(policy.max_redirects, 0);
  assert.equal(policy.revalidate_redirect_targets, true);
  assert.equal(policy.deny_link_local, true);
  assert.equal(policy.deny_metadata_service, true);
  assert.equal(policy.deny_proxy_bypass, true);
});
