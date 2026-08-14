/**
 * The trusted telemetry channel: provision, close, freeze, cleanup
 * (ADR-ERL2-038 §3 and corrections R1–R6) — package 2.
 *
 * Package 1 defined what a trusted artifact *is* (ERL2-C-171) and who may
 * authorize a claim from one. It deliberately produced none: it opens no file,
 * runs no container and knows nothing about Docker. This module is the other
 * half — the bounded live producer that makes bytes of that shape exist — and
 * it is the first code in the repository that can.
 *
 * ## What this is not
 *
 * It is not wired into `environmentRun`. The producer's validity composition
 * still reads retained observations as ERL2-C-160 and would throw on a v2
 * record, and correcting that is package 3's declared scope. Everything here is
 * reachable through a bounded API a caller supplies a verified collector to, so
 * package 3 connects it without this module learning anything about runs.
 *
 * ## The three properties the lifecycle exists to establish
 *
 * **Only the collector writes.** The bytes live on a named volume mounted into
 * the collector container and into nothing else. The subject's container
 * declares no mount for it, the adapter never sees it, no Docker socket is
 * exposed, and no host path is bound. A subject cannot write, replace, truncate
 * or symlink a file it has no path to.
 *
 * **Nothing is authoritative before it is frozen.** A copy taken while the
 * exporter is still appending is a prefix of an artifact, not an artifact. The
 * lifecycle establishes an observation cutoff first, proves the bytes have
 * stopped moving, and only then copies, hashes and parses — and the bytes that
 * are hashed are the exact bytes that are retained and verified.
 *
 * **Cleanup and evidence are separate facts.** Removing the volume says nothing
 * about whether the artifact was valid, and a valid artifact says nothing about
 * whether the volume was removed. Both are reported, neither is inferred from
 * the other, and a cleanup failure is reported honestly rather than swallowed.
 *
 * ## The measurement that shapes the freeze order
 *
 * ADR-ERL2-038 R5 describes finalization as flush, close, then read. Measured
 * against this exact substrate, a literal reading of that order destroys the
 * evidence: the volume is tmpfs-backed, so the kernel unmounts it when the last
 * container using it stops, and `docker cp` from the stopped collector answers
 *
 *     Error response from daemon: Could not find the file
 *     /trusted/traces.jsonl in container <name>
 *
 * The bytes are gone, not stale. So the copy is taken from the **running**
 * collector after the observation cutoff, and the container is stopped
 * afterwards. `close()` therefore does not mean "the process exited" — it means
 * "the trusted exporter has stopped appending", which is established by
 * quiescing the run's telemetry, waiting out at least one exporter flush
 * interval, and reading twice until two consecutive copies are byte-identical.
 *
 * That is a weaker liveness property than a process exit and it is stated as
 * such rather than dressed up. What it is not is an integrity weakness: a
 * record that lands after the cutoff is simply not in the bytes, so the error
 * can only ever *understate* a count. The artifact's completeness is
 * established structurally from the bytes themselves — every physical line
 * parses and the sequence ends on a record boundary — and never from a belief
 * about what the collector was doing at the time.
 */

import { readFileSync, readdirSync, rmSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  CODES,
  Erl2Error,
  assertContract,
  type AttributableTelemetryObservationV2,
  type Hash,
  type Instant,
} from "@erl2/contracts";
import { coreHash, hashBytes } from "@erl2/integrity";
import type { DockerCli } from "./dockerCli.js";
import {
  parseTrustedTelemetryRecords,
  utf8ByteLength,
  TRUSTED_TELEMETRY_MAX_BYTES,
} from "./trustedTelemetry.js";

// -- channel identity ---------------------------------------------------------

/** Where the collector container sees the trusted volume. Absent from the image. */
export const TRUSTED_CHANNEL_MOUNT_PATH = "/trusted";

/** The single run-scoped artifact. No rotation, one segment (R6). */
export const TRUSTED_CHANNEL_FILE_NAME = "traces.jsonl";

/** The exporter that writes it, as ERL2-C-171 records it. */
export const TRUSTED_CHANNEL_EXPORTER_ID = "file/trusted";

/** The channel constants ERL2-C-171 pins. Restated so a control can mutate them. */
export const TRUSTED_CHANNEL_KIND = "collector-file-otlp-json";
export const TRUSTED_CHANNEL_RECORD_FORMAT = "otlp-json-ndjson";
export const TRUSTED_CHANNEL_ENCODING = "utf-8";

/**
 * The collector's uid/gid.
 *
 * Numeric, and matching the image's declared user. The image is entirely
 * root-owned, carries no shell and no directory owned by 10001, so a volume
 * without these options fails closed at start-up — measured:
 * `open /trusted/traces.jsonl: permission denied`, exit 1.
 */
export const TRUSTED_VOLUME_UID = 10001;
export const TRUSTED_VOLUME_GID = 10001;

/** Owner-only. Nothing else in the container has a reason to read it. */
export const TRUSTED_VOLUME_MODE = "0700";

/**
 * The tmpfs size cap (R4).
 *
 * Memory-backed storage turns "disk exhaustion" into "host memory exhaustion",
 * which is worse, so the bound is explicit. It is comfortably above the
 * 262 144-byte contract ceiling because the failure it prevents is unbounded
 * growth, not a large valid artifact — and because the two bounds fail in
 * different directions: hitting the contract cap refuses a whole artifact,
 * while hitting the tmpfs cap leaves a torn final write. Measured on a
 * deliberately tiny volume, exhaustion produces exactly that — a file not
 * ending on a record boundary, refused as `telemetry_trusted_record_incomplete`.
 */
export const TRUSTED_VOLUME_SIZE = "64m";

/**
 * How long the exporter may hold a batch before it reaches the file.
 *
 * Must equal `flush_interval` in `erl2-otelcol-extras.yaml`. It is what makes
 * the freeze cutoff a bounded wait rather than a guess.
 */
export const TRUSTED_CHANNEL_FLUSH_INTERVAL_MS = 1_000;

/** The `o=` option string Docker is given, and the one `volume inspect` must echo back. */
export function trustedVolumeMountOptions(): string {
  return `uid=${TRUSTED_VOLUME_UID},gid=${TRUSTED_VOLUME_GID},mode=${TRUSTED_VOLUME_MODE},size=${TRUSTED_VOLUME_SIZE}`;
}

/**
 * The run-scoped volume name.
 *
 * Embeds the run's UUID exactly as the network and both container names do, so
 * two runs never collide, `assertOwnedByRun` can prove ownership from the name,
 * and no third party can guess it. A guesser would need daemon access anyway,
 * which is already game over.
 */
export function trustedVolumeName(runId: string): string {
  return `erl2-trusted-${runId}`;
}

// -- refusals -----------------------------------------------------------------

/**
 * Why the channel could not produce an authoritative artifact.
 *
 * Every one of these becomes an ERL2-C-171 `absent` record carrying the code,
 * never a zero: "the channel produced nothing readable" and "the collector
 * received nothing" are different facts, and collapsing them is the conflation
 * ADR-ERL2-033 exists to prevent.
 */
export const TRUSTED_CHANNEL_REASONS = {
  /** A volume of this run's name already exists. Refused, never adopted. */
  volumeStale: "telemetry_channel_volume_stale",
  /** The volume could not be created. */
  unprovisioned: "telemetry_channel_unprovisioned",
  /** The volume exists but its driver options are not the ones that were asked for. */
  mountOptionsUnexpected: "telemetry_channel_mount_options_unexpected",
  /** The collector is not a container Docker proves is this run's. */
  collectorNotVerified: "collector_not_verified",
  /** The trusted directory could not be copied out of the collector. */
  copyFailed: "telemetry_channel_copy_failed",
  /** The expected artifact is not in the copied directory. */
  artifactMissing: "telemetry_channel_artifact_missing",
  /** More than the one expected file: rotation, a segment, or something unaccounted for. */
  unexpectedFile: "telemetry_channel_unexpected_file",
  /** Two consecutive reads disagreed: the exporter is still writing. */
  notFinalized: "telemetry_channel_not_finalized",
  /** The bytes are not valid UTF-8, which the channel's encoding constant asserts they are. */
  encodingInvalid: "telemetry_channel_encoding_invalid",
  /** The artifact is larger than ERL2-C-171 retains. Never truncated to fit. */
  overSizeBound: "telemetry_trusted_artifact_exceeds_size_bound",
} as const;

// -- what the lifecycle is handed ---------------------------------------------

/** The collector container the bytes are read out of, as Docker proved it. */
export interface VerifiedTrustedCollector {
  readonly serviceId: string;
  readonly containerName: string;
  readonly imageId: string;
  readonly observedImageRepoDigests: readonly string[];
}

/** The identities that make another run's artifact unusable here (R4). */
export interface TrustedChannelBinding {
  readonly environmentArchetypeHash: Hash;
  readonly substrateLockCoreHash: Hash;
  readonly collectorImageDigest: string;
  readonly collectorConfigDigest: Hash;
}

/** A provisioned channel, or why none was. */
export type TrustedChannelProvision =
  | {
      readonly provisioned: true;
      readonly volumeName: string;
      readonly mountOptions: string;
    }
  | { readonly provisioned: false; readonly reasonCode: string };

/** The frozen artifact, or why nothing was frozen. */
export type TrustedChannelFreeze =
  | {
      readonly frozen: true;
      /** The exact bytes, as UTF-8 text. These are the bytes that are hashed and retained. */
      readonly bytes: string;
      readonly byteLength: number;
      readonly contentDigest: Hash;
      readonly recordCount: number;
      readonly finalRecordTerminated: boolean;
      /** Every file the trusted directory held. Exactly one, or this is not a freeze. */
      readonly fileNames: readonly string[];
    }
  | { readonly frozen: false; readonly reasonCode: string };

/** Removal is reported, never inferred, and never confers evidence validity. */
export interface TrustedChannelCleanup {
  readonly attempted: boolean;
  readonly removed: boolean;
  /** Resources still present after cleanup. Empty for a clean channel. */
  readonly surviving: readonly string[];
  readonly detail?: string;
}

/** The material a C-171 record is built from — observed, or absent with a reason. */
export type TrustedTelemetryMaterial =
  | {
      readonly evidence: "observed";
      readonly marker: string;
      readonly collector: VerifiedTrustedCollector;
      readonly binding: TrustedChannelBinding;
      readonly freeze: Extract<TrustedChannelFreeze, { frozen: true }>;
      readonly traceBatches: number;
      readonly spans: number;
      readonly serviceNames: readonly string[];
      readonly runAttributedRecords: number;
    }
  | { readonly evidence: "absent"; readonly marker: string; readonly reasonCode: string };

export interface TrustedChannelOptions {
  readonly runId: string;
  readonly docker: DockerCli;
  /**
   * A task-scoped directory the freeze copies into.
   *
   * Outside the collector, outside the substrate, and removed by `cleanup`. Two
   * copies land in two subdirectories of it, because the stability proof is a
   * comparison of two independent reads rather than of one read against itself.
   */
  readonly freezeRoot: string;
  /** Compose project label, so the volume joins the existing labelled discovery. */
  readonly project?: string;
  /** Bounded, and injectable so a test does not sleep. */
  readonly sleep?: (ms: number) => void;
  /** How many times two reads may disagree before the channel is refused. */
  readonly stabilityAttempts?: number;
}

/**
 * How many one-second reads the freeze may take before it settles for what it
 * has. Matches the v1 observation's settle budget: the subject's own exporter
 * batches on a schedule the Lab does not control, so a real run needs room.
 */
const DEFAULT_STABILITY_ATTEMPTS = 20;

/** Synchronous by design, like every other driver wait in this package. */
function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The channel's lifecycle.
 *
 * Deliberately not a driver: it holds no substrate identity, reads no
 * archetype and knows nothing about runs beyond the id that scopes its names.
 * Everything it needs about *this* run's collector arrives as an argument, so
 * package 3 supplies a verified container and gets an artifact, and this module
 * never grows a second reason to exist.
 */
export class TrustedTelemetryChannel {
  readonly runId: string;
  readonly volumeName: string;

  private readonly docker: DockerCli;
  private readonly freezeRoot: string;
  private readonly project: string | undefined;
  private readonly sleep: (ms: number) => void;
  private readonly stabilityAttempts: number;
  private created = false;

  constructor(options: TrustedChannelOptions) {
    this.runId = options.runId;
    this.volumeName = trustedVolumeName(options.runId);
    this.docker = options.docker;
    this.freezeRoot = options.freezeRoot;
    this.project = options.project;
    this.sleep = options.sleep ?? blockingSleep;
    this.stabilityAttempts = options.stabilityAttempts ?? DEFAULT_STABILITY_ATTEMPTS;
  }

  /** Whether this channel created the volume. Cleanup removes nothing it did not create. */
  get ownsVolume(): boolean {
    return this.created;
  }

  // -- 1. provision ---------------------------------------------------------

  /**
   * Creates the run's trusted volume, refusing a name that is already taken.
   *
   * The refusal is the point. Compose would *adopt* an existing volume, and an
   * adopted volume is one that may already hold another run's bytes — which is
   * why the overlay declares this one `external` and creation happens here.
   * A pre-existing name is a refusal with its own code, never a reuse and never
   * a silent `rm` of something this run did not create.
   *
   * "Begins empty" is established by construction rather than by inspection:
   * the volume is created fresh in this call, and a freshly created
   * local-driver tmpfs volume has an empty backing directory. There is no way
   * to read it from the host before a container mounts it without introducing
   * exactly the helper container R1 removed. The property is re-established
   * downstream where it is cheap and load-bearing: the freeze enumerates the
   * directory and refuses anything other than the one expected file, so bytes
   * this channel did not account for are caught before they can be read.
   */
  provision(): TrustedChannelProvision {
    if (this.volumeExists()) {
      return { provisioned: false, reasonCode: TRUSTED_CHANNEL_REASONS.volumeStale };
    }
    const labels: string[] = [
      "--label",
      `com.erl2.run_id=${this.runId}`,
      "--label",
      "com.erl2.driver_id=compose-driver",
    ];
    if (this.project !== undefined) {
      labels.push("--label", `com.docker.compose.project=${this.project}`);
    }
    const created = this.docker.run({
      args: [
        "volume",
        "create",
        "--driver",
        "local",
        "--opt",
        "type=tmpfs",
        "--opt",
        "device=tmpfs",
        "--opt",
        `o=${trustedVolumeMountOptions()}`,
        ...labels,
        this.volumeName,
      ],
      timeoutMs: 60_000,
    });
    if (created.status !== 0) {
      return { provisioned: false, reasonCode: TRUSTED_CHANNEL_REASONS.unprovisioned };
    }
    this.created = true;

    // Read the options back rather than trusting the create succeeded with
    // them. A daemon that silently ignored an option would otherwise hand the
    // collector a root-owned volume and the failure would surface as an
    // unexplained start-up crash instead of a named refusal.
    const observed = this.observedMountOptions();
    if (observed !== trustedVolumeMountOptions()) {
      return {
        provisioned: false,
        reasonCode: TRUSTED_CHANNEL_REASONS.mountOptionsUnexpected,
      };
    }
    return {
      provisioned: true,
      volumeName: this.volumeName,
      mountOptions: observed,
    };
  }

  /** Whether a volume of this run's name is present. Exact name, never a pattern. */
  private volumeExists(): boolean {
    return (
      this.docker.run({
        args: ["volume", "inspect", this.volumeName, "--format", "{{.Name}}"],
        timeoutMs: 60_000,
      }).status === 0
    );
  }

  /** The `o=` string the daemon reports for this volume, or `""`. */
  observedMountOptions(): string {
    const result = this.docker.run({
      args: ["volume", "inspect", this.volumeName, "--format", "{{index .Options \"o\"}}"],
      timeoutMs: 60_000,
    });
    return result.status === 0 ? result.stdout.trim() : "";
  }

  // -- 2. close: prove the exporter has stopped appending -------------------

  /**
   * Waits out the exporter's flush interval and reads until two consecutive
   * copies agree.
   *
   * This is the observation cutoff, and it is what "the collector no longer
   * writes" means on a channel whose bytes do not survive the collector's exit.
   * The caller is responsible for quiescing the run's telemetry first — this
   * establishes only that whatever was emitted before the cutoff has reached
   * the file and that the file has stopped moving.
   *
   * Bounded: `stabilityAttempts` reads, then a refusal. Correctness does not
   * rest on the wait being long enough, because a record arriving after the
   * cutoff is absent from the bytes rather than half-present in them — the
   * error is an undercount, and the structural completeness check is what
   * catches a genuinely torn write.
   */
  close(
    collector: VerifiedTrustedCollector,
    isSettled: (bytes: string) => boolean = () => true,
  ): TrustedChannelFreeze {
    this.sleep(TRUSTED_CHANNEL_FLUSH_INTERVAL_MS * 2);
    let previous: Buffer | undefined;
    let previousNames: readonly string[] = [];
    let lastStable: { readonly bytes: Buffer; readonly fileNames: readonly string[] } | undefined;

    for (let attempt = 1; attempt <= this.stabilityAttempts; attempt += 1) {
      const read = this.copyTrustedDirectory(collector, `read-${attempt}`);
      if (!read.ok) return { frozen: false, reasonCode: read.reasonCode };
      const stable =
        previous !== undefined &&
        previous.equals(read.bytes) &&
        previousNames.length === read.fileNames.length &&
        previousNames.every((name, index) => name === read.fileNames[index]);
      if (stable) {
        lastStable = { bytes: read.bytes, fileNames: read.fileNames };
        if (isSettled(read.bytes.toString("utf8"))) {
          return this.finalize(read.bytes, read.fileNames);
        }
      }
      previous = read.bytes;
      previousNames = read.fileNames;
      this.sleep(TRUSTED_CHANNEL_FLUSH_INTERVAL_MS);
    }

    // The budget is spent. A stable artifact that never satisfied `isSettled` is
    // still a frozen artifact: those exact bytes were read twice and did not
    // move, which is everything the freeze claims about them. What it is *not*
    // is a claim that nothing more was coming — and that distinction is why the
    // predicate exists rather than a bare stability check.
    //
    // The failure this budget prevents is specific and was measured: reading two
    // seconds after the last request finds an empty file, two identical empty
    // reads look perfectly stable, and the channel would freeze an authentic
    // observed zero for a run that emitted spans. An undercount is a tolerable
    // error here; asserting "the collector received nothing" when it did is not,
    // because a genuine zero is a positive claim the contract lets a reader act
    // on.
    if (lastStable !== undefined) return this.finalize(lastStable.bytes, lastStable.fileNames);
    return { frozen: false, reasonCode: TRUSTED_CHANNEL_REASONS.notFinalized };
  }

  // -- 3. freeze ------------------------------------------------------------

  /**
   * Turns stable bytes into the frozen artifact.
   *
   * The order matters and is fixed: the encoding is established before the
   * length, the length before the digest, and the digest over the exact bytes
   * that will be retained. There is no path here that normalizes, pads or
   * truncates — an artifact over the contract's ceiling is refused whole,
   * because a truncated artifact is a different observation wearing this one's
   * digest.
   */
  private finalize(bytes: Buffer, fileNames: readonly string[]): TrustedChannelFreeze {
    // The channel declares `encoding: "utf-8"` as a schema constant. Bytes that
    // do not survive a UTF-8 round trip are not what that constant says they
    // are, and retaining them as a string would silently substitute U+FFFD for
    // whatever the collector actually wrote.
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      return { frozen: false, reasonCode: TRUSTED_CHANNEL_REASONS.encodingInvalid };
    }
    const byteLength = utf8ByteLength(text);
    if (byteLength > TRUSTED_TELEMETRY_MAX_BYTES) {
      return { frozen: false, reasonCode: TRUSTED_CHANNEL_REASONS.overSizeBound };
    }
    // An empty artifact is an authentic observed zero: provisioned, finalized,
    // and the collector exported nothing. `final_record_terminated` is false
    // exactly there, which is what the contract's own comment requires, and it
    // stays a different fact from `absent`.
    //
    // A non-empty artifact that does not end on a boundary carries a partial
    // final record. Its count is stated honestly here — the trailing fragment
    // is a record the writer started — and the parser refuses it as
    // `telemetry_trusted_record_incomplete` rather than counting it.
    const terminated = text.length > 0 && text.endsWith("\n");
    const recordCount =
      text.length === 0 ? 0 : terminated ? text.slice(0, -1).split("\n").length : text.split("\n").length;
    return {
      frozen: true,
      bytes: text,
      byteLength,
      contentDigest: hashBytes(Buffer.from(text, "utf8")),
      recordCount,
      finalRecordTerminated: terminated,
      fileNames,
    };
  }

  /**
   * Copies the whole trusted directory out of the running collector.
   *
   * The *directory*, not the file, and that is the rotation check: a second
   * output file, a rotated segment, or anything else the channel did not
   * account for lands here and is refused by name. Copying only the expected
   * path would make an extra file invisible, which is precisely the property
   * ERL2-C-171's `segment_count: 1` can declare but not enforce.
   */
  private copyTrustedDirectory(
    collector: VerifiedTrustedCollector,
    label: string,
  ):
    | { readonly ok: true; readonly bytes: Buffer; readonly fileNames: readonly string[] }
    | { readonly ok: false; readonly reasonCode: string } {
    const into = path.join(this.freezeRoot, label);
    rmSync(into, { recursive: true, force: true });
    mkdirSync(into, { recursive: true, mode: 0o700 });
    const copied = this.docker.run({
      args: [
        "cp",
        `${collector.containerName}:${TRUSTED_CHANNEL_MOUNT_PATH}`,
        path.join(into, "trusted"),
      ],
      timeoutMs: 120_000,
    });
    if (copied.status !== 0) {
      return { ok: false, reasonCode: TRUSTED_CHANNEL_REASONS.copyFailed };
    }
    const directory = path.join(into, "trusted");
    let fileNames: readonly string[];
    try {
      fileNames = readdirSync(directory).sort();
    } catch {
      return { ok: false, reasonCode: TRUSTED_CHANNEL_REASONS.copyFailed };
    }
    if (fileNames.length === 0 || !fileNames.includes(TRUSTED_CHANNEL_FILE_NAME)) {
      return { ok: false, reasonCode: TRUSTED_CHANNEL_REASONS.artifactMissing };
    }
    if (fileNames.length !== 1) {
      return { ok: false, reasonCode: TRUSTED_CHANNEL_REASONS.unexpectedFile };
    }
    try {
      return {
        ok: true,
        bytes: readFileSync(path.join(directory, TRUSTED_CHANNEL_FILE_NAME)),
        fileNames,
      };
    } catch {
      return { ok: false, reasonCode: TRUSTED_CHANNEL_REASONS.copyFailed };
    }
  }

  // -- 4. cleanup -----------------------------------------------------------

  /**
   * Removes the volume this channel created, and the copies it took.
   *
   * Removes **only** what it created: a channel whose `provision` refused a
   * pre-existing name removes nothing, because that volume is not this run's to
   * delete. The outcome is returned rather than thrown, and it is returned
   * separately from anything about the artifact — cleanup success is not
   * evidence validity and evidence validity is not cleanup success.
   */
  cleanup(): TrustedChannelCleanup {
    rmSync(this.freezeRoot, { recursive: true, force: true });
    if (!this.created) {
      return { attempted: false, removed: false, surviving: [] };
    }
    const removed = this.docker.run({
      args: ["volume", "rm", this.volumeName],
      timeoutMs: 60_000,
    });
    if (removed.status === 0) {
      this.created = false;
      return { attempted: true, removed: true, surviving: [] };
    }
    // A volume that is gone anyway is removed, however it went. A volume that
    // is still there is reported as surviving, with the daemon's own words.
    if (!this.volumeExists()) {
      this.created = false;
      return { attempted: true, removed: true, surviving: [] };
    }
    return {
      attempted: true,
      removed: false,
      surviving: [this.volumeName],
      detail: removed.stderr.trim().slice(0, 512),
    };
  }
}

// -- 5. producing the ERL2-C-171 material -------------------------------------

/**
 * Observes the trusted channel and returns the material an artifact is built
 * from.
 *
 * Every count here is recomputed from the frozen bytes by the same parser the
 * offline verifier uses. Nothing is carried over from the collector's own
 * reporting, because a producer and a verifier that both *read* a count agree
 * about nothing — which is how a forged `spans: 9999` verified clean at
 * `6d28d543`.
 */
export function observeTrustedTelemetry(input: {
  readonly channel: TrustedTelemetryChannel;
  readonly collector: VerifiedTrustedCollector | undefined;
  readonly binding: TrustedChannelBinding;
  readonly marker: string;
}): TrustedTelemetryMaterial {
  const { channel, collector, binding, marker } = input;
  if (collector === undefined) {
    return {
      evidence: "absent",
      marker,
      reasonCode: TRUSTED_CHANNEL_REASONS.collectorNotVerified,
    };
  }
  // Settled means "this run's telemetry has reached the file", not merely "the
  // file stopped moving". An empty file is stable the instant it is created, so
  // stability alone would freeze a zero for a run whose spans were still in the
  // subject's exporter — asserting a genuine zero that is simply false. The
  // predicate is the same recomputation the artifact is built from, so the thing
  // that ends the wait is the thing that is later verified.
  const freeze = channel.close(collector, (bytes) => {
    const settling = parseTrustedTelemetryRecords(bytes, marker);
    return settling.ok && settling.counts.runAttributedRecords >= 1;
  });
  if (!freeze.frozen) {
    return { evidence: "absent", marker, reasonCode: freeze.reasonCode };
  }
  const parsed = parseTrustedTelemetryRecords(freeze.bytes, marker);
  if (!parsed.ok) {
    return { evidence: "absent", marker, reasonCode: parsed.reasonCode };
  }
  const counts = parsed.counts;
  // The parser and the freeze must agree about the shape of the same bytes. They
  // are computed independently — one by splitting, one by parsing — so a
  // disagreement means one of them is wrong about the artifact, and neither is
  // entitled to win.
  if (
    counts.byteLength !== freeze.byteLength ||
    counts.recordCount !== freeze.recordCount ||
    counts.finalRecordTerminated !== freeze.finalRecordTerminated
  ) {
    return {
      evidence: "absent",
      marker,
      reasonCode: TRUSTED_CHANNEL_REASONS.notFinalized,
    };
  }
  return {
    evidence: "observed",
    marker,
    collector,
    binding,
    freeze,
    traceBatches: counts.traceBatches,
    spans: counts.spans,
    serviceNames: counts.serviceNames,
    runAttributedRecords: counts.runAttributedRecords,
  };
}

/**
 * Seals the material into an ERL2-C-171 record.
 *
 * `assertContract` is the gate: a record this function builds and the schema
 * refuses never reaches a caller, so a producer bug surfaces here rather than
 * as an artifact that fails validation somewhere downstream with less context.
 * Package 1's contract is used exactly as it stands — no field is synthesized,
 * no identity is invented, and nothing here decides whether the artifact
 * authorizes anything. That decision belongs to
 * `decideTrustedTelemetryAuthority`, which this module never calls.
 */
export function buildTrustedTelemetryObservation(input: {
  readonly runId: string;
  readonly observedAt: Instant;
  readonly material: TrustedTelemetryMaterial;
}): AttributableTelemetryObservationV2 {
  const { runId, observedAt, material } = input;
  const base =
    material.evidence === "observed"
      ? {
          schema_version: "attributable-telemetry-observation/v2" as const,
          run_id: runId,
          marker: material.marker,
          evidence: "observed" as const,
          observed_at: observedAt,
          channel: {
            kind: TRUSTED_CHANNEL_KIND,
            record_format: TRUSTED_CHANNEL_RECORD_FORMAT,
            encoding: TRUSTED_CHANNEL_ENCODING,
            rotation: "forbidden" as const,
            segment_count: 1,
            exporter_id: TRUSTED_CHANNEL_EXPORTER_ID,
          },
          binding: {
            environment_archetype_hash: material.binding.environmentArchetypeHash,
            substrate_lock_core_hash: material.binding.substrateLockCoreHash,
            collector_image_digest: material.binding.collectorImageDigest,
            collector_config_digest: material.binding.collectorConfigDigest,
          },
          collector: {
            service_id: material.collector.serviceId,
            container_name: material.collector.containerName,
            // Schema constants, not observations of convenience: this branch is
            // reachable only over a container Docker proved is this run's,
            // running the locked image. Reaching it is the proof.
            ownership_verified: true as const,
            image_id: material.collector.imageId,
            observed_image_repo_digests: [...material.collector.observedImageRepoDigests].sort(),
            image_matches_locked_digest: true as const,
          },
          artifact: {
            byte_length: material.freeze.byteLength,
            content_digest: material.freeze.contentDigest,
            record_count: material.freeze.recordCount,
            finalization: "frozen" as const,
            final_record_terminated: material.freeze.finalRecordTerminated,
          },
          trace_batches: material.traceBatches,
          spans: material.spans,
          service_names: material.serviceNames,
          run_attributed_records: material.runAttributedRecords,
          trusted_records: material.freeze.bytes,
        }
      : {
          schema_version: "attributable-telemetry-observation/v2" as const,
          run_id: runId,
          marker: material.marker,
          evidence: "absent" as const,
          observed_at: observedAt,
          reason_code: material.reasonCode,
        };
  try {
    return assertContract<AttributableTelemetryObservationV2>(
      "AttributableTelemetryObservationV2",
      { ...base, core_hash: coreHash(base) },
    );
  } catch (cause) {
    throw new Erl2Error(
      CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
      "the trusted telemetry channel produced a record that does not satisfy ERL2-C-171; " +
        "an artifact the contract refuses is not evidence of anything",
      { owner: "lab", cause },
    );
  }
}

/** The freeze root a channel should be given, under a caller-owned temporary root. */
export function trustedFreezeRoot(temporaryRoot: string, runId: string): string {
  const root = path.join(temporaryRoot, `erl2-trusted-freeze-${runId}`);
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
