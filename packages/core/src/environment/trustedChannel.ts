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

import { rmSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  CODES,
  Erl2Error,
  assertContract,
  parseStrictJson,
  type AttributableTelemetryObservationV2,
  type Hash,
  type Instant,
} from "@erl2/contracts";
import { coreHash, hashBytes } from "@erl2/integrity";
import type { DockerCli } from "./dockerCli.js";
import { readTrustedArchive, unsafeArchiveName } from "./trustedArchive.js";
import {
  labelsMatch,
  newTrustedVolumeCapability,
  sealTrustedVolumeOwnership,
  trustedCapabilityDigest,
  trustedVolumeLabels,
  TRUSTED_CHANNEL_VERSION,
  TRUSTED_OWNERSHIP_SCHEMA_VERSION,
  TRUSTED_VOLUME_LABEL_KEYS,
  type TrustedOwnershipStore,
  type TrustedVolumeOwnership,
} from "./trustedOwnership.js";
import {
  parseTrustedTelemetryRecords,
  utf8ByteLength,
  TRUSTED_TELEMETRY_MAX_BYTES,
  type TrustedTelemetryCounts,
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
  /**
   * The volume exists but does not carry exactly the labels this run's handle
   * requires.
   *
   * Separate from `mountOptionsUnexpected` because the two say different things:
   * the options are how the volume behaves, and the labels are who it belongs
   * to. A resource whose ownership labels do not match is never removed and
   * never adopted — it is refused, and it survives.
   */
  labelsUnexpected: "telemetry_channel_volume_labels_unexpected",
  /**
   * This run already holds a live ownership handle.
   *
   * A second provision over a live claim would mint a second capability and
   * orphan the first, so the resource the run already created would become
   * unremovable. Refused rather than overwritten.
   */
  ownershipConflict: "telemetry_channel_ownership_conflict",
  /**
   * A pending ownership intent could not be safely reconciled.
   *
   * The recorded name resolves to a resource whose labels or capability digest
   * are not this handle's, so it is not the volume the intent describes and this
   * process has no proof it may touch it. Fail closed: the intent stays, the
   * resource stays, and an operator gets a name rather than a guess.
   */
  reconciliationRefused: "telemetry_channel_ownership_reconciliation_refused",
  /** The collector is not a container Docker proves is this run's. */
  collectorNotVerified: "collector_not_verified",
  /** The trusted directory could not be copied out of the collector. */
  copyFailed: "telemetry_channel_copy_failed",
  /**
   * The trusted directory holds an entry that is not a regular file.
   *
   * A symlink, a directory, a FIFO, a socket, a device or an archive type ustar
   * does not define. An independent review planted a symlink named
   * `traces.jsonl` and the previous copy path followed it into the host's
   * `/etc/passwd`; the type is now read from the archive's own header before
   * anything can dereference it.
   */
  sourceEntryNotRegular: "telemetry_channel_source_entry_not_regular",
  /** The expected artifact is not in the copied directory. */
  artifactMissing: "telemetry_channel_artifact_missing",
  /** More than the one expected file: rotation, a segment, or something unaccounted for. */
  unexpectedFile: "telemetry_channel_unexpected_file",
  /** Two consecutive reads disagreed: the exporter is still writing. */
  notFinalized: "telemetry_channel_not_finalized",
  /**
   * The settle budget expired with a stable artifact that never carried this
   * run's telemetry.
   *
   * The artifact is real and its bytes did stop moving — what is missing is any
   * reason to believe more was not coming. An independent review reproduced the
   * defect this replaces: telemetry arriving after the budget produced an
   * `observed` record asserting zero spans, byte-identical to a genuine zero and
   * indistinguishable from it by any reader. Elapsed time is not evidence, so
   * this is `absent` with a cause rather than a count.
   */
  settleTimeout: "telemetry_channel_settle_timeout",
  /**
   * The budget expired on an empty artifact for a run that was never declared
   * eligible to observe zero.
   *
   * Separate from `settleTimeout` because the remedy differs: this run either
   * emitted nothing it should have, or the channel never saw it. Either way the
   * one thing it is not is a proven zero.
   */
  expectedTelemetryMissing: "telemetry_channel_expected_telemetry_missing",
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

/**
 * What ended the settle wait.
 *
 * The distinction the first Package 2 candidate did not carry, and the reason a
 * timed-out zero could wear a genuine zero's face. `attribution` means the wait
 * ended because this run's telemetry demonstrably arrived; `budget` means it
 * ended because the clock ran out, which proves nothing about what was still in
 * flight. Only the first is grounds for a positive claim about counts.
 */
export type TrustedChannelSettleCause = "attribution" | "budget";

/**
 * Whether this run is contractually permitted to observe zero telemetry.
 *
 * Bound **before** observation, by the caller that knows the scenario's
 * contract, and deliberately not inferable from the bytes: an empty file looks
 * identical whether zero was expected or the exporter was slow. It is a typed
 * input rather than a boolean so that a later reader can see *why* zero was
 * permitted, and so that "nobody said" is the default rather than a falsy
 * value someone forgot to set.
 *
 * This is the one seam package 3 must supply. Package 2 defines it and defaults
 * to `expects-telemetry`, so a caller that says nothing gets the fail-closed
 * answer rather than a convenient one.
 */
export type TrustedChannelZeroEligibility =
  | {
      /** The run's contract requires attributable telemetry. Zero is a failure, never a fact. */
      readonly kind: "expects-telemetry";
    }
  | {
      /**
       * The run's contract permits zero, and said so before the channel was
       * observed. `justification` is retained in the diagnostic rather than the
       * artifact — ERL2-C-171 has no field for it — so the reason a zero was
       * allowed survives in the log even though the record cannot carry it.
       */
      readonly kind: "zero-eligible";
      readonly justification: string;
    };

/** The default, and the fail-closed one: nothing said means telemetry is expected. */
export const EXPECTS_TELEMETRY: TrustedChannelZeroEligibility = { kind: "expects-telemetry" };

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
      /** Why the wait ended. Never inferred from the bytes; see the type. */
      readonly settledBy: TrustedChannelSettleCause;
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
   * Where ownership of the volume is proved from.
   *
   * Required, and deliberately not defaulted: a channel without a durable store
   * is exactly the channel whose `created` flag evaporated between `provision`
   * and `destroy`. Making it an argument means every construction site has to
   * answer the question "which process will prove this?", and there is no
   * convenient in-memory fallback for one to fall into.
   */
  readonly ownership: TrustedOwnershipStore;
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
  private readonly ownership: TrustedOwnershipStore;

  constructor(options: TrustedChannelOptions) {
    this.runId = options.runId;
    this.volumeName = trustedVolumeName(options.runId);
    this.docker = options.docker;
    this.freezeRoot = options.freezeRoot;
    this.project = options.project;
    this.ownership = options.ownership;
    this.sleep = options.sleep ?? blockingSleep;
    this.stabilityAttempts = options.stabilityAttempts ?? DEFAULT_STABILITY_ATTEMPTS;
  }

  /**
   * Whether this run holds a live claim on the volume.
   *
   * Read from the durable handle, never from this object's memory. That is the
   * whole correction: the process that answers this question is usually not the
   * process that created the resource, and a field on an instance cannot survive
   * the exit of the process that set it.
   */
  get ownsVolume(): boolean {
    const handle = this.readOwnership();
    return handle !== undefined && handle.phase !== "released";
  }

  /**
   * The handle, or `undefined` if there is nothing readable to act on.
   *
   * A corrupt or foreign handle is `undefined` *here* and refused by every
   * caller, rather than throwing out of a getter: the callers below each have a
   * fail-closed answer for "no provable ownership", and they are better places
   * to decide than an exception thrown through a lifecycle step.
   */
  private readOwnership(): TrustedVolumeOwnership | undefined {
    let handle: TrustedVolumeOwnership | undefined;
    try {
      handle = this.ownership.read();
    } catch {
      // Unreadable is not absent. The caller treats it as "cannot prove
      // ownership", which removes nothing — see `cleanup`.
      return undefined;
    }
    if (handle === undefined) return undefined;
    // A handle for another run authorizes nothing here, however well-formed it
    // is. This is the check that makes a copied or misplaced record inert.
    if (handle.run_id !== this.runId) return undefined;
    if (handle.volume_name !== this.volumeName) return undefined;
    return handle;
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
    // 0. A live claim is never overwritten.
    //
    // Minting a second capability over a resource the first one owns would
    // orphan it: the handle that could remove it would be gone, and the volume
    // would outlive every process that could prove the right to delete it. That
    // is the defect this whole module closes, arriving by a different door.
    const prior = this.readOwnership();
    if (prior !== undefined && prior.phase === "created") {
      return { provisioned: false, reasonCode: TRUSTED_CHANNEL_REASONS.ownershipConflict };
    }
    if (prior !== undefined && prior.phase === "pending-create") {
      // A crash landed between the intent and the confirmation. Whatever the
      // previous process managed to create is reconciled here — against the
      // exact name, labels and capability that intent recorded, and against
      // nothing else.
      if (!this.reconcilePending(prior)) {
        return { provisioned: false, reasonCode: TRUSTED_CHANNEL_REASONS.reconciliationRefused };
      }
    }

    // 1. A name already taken is refused, never adopted, and never removed.
    if (this.volumeExists()) {
      return { provisioned: false, reasonCode: TRUSTED_CHANNEL_REASONS.volumeStale };
    }

    // 2. The intent is durable *before* the resource exists.
    //
    // This ordering is the crash-safety property. A process that dies after this
    // write and before `volume create` leaves a handle naming a volume that does
    // not exist — recoverable, and harmless. A process that died after creating
    // the volume and before recording anything would leave the opposite: a
    // resource nobody can prove they own, which is unrecoverable without
    // guessing. The window is one atomic rename wide, and it is on the safe side
    // of the resource.
    const capability = newTrustedVolumeCapability();
    const capabilityDigest = trustedCapabilityDigest(capability);
    const intent = sealTrustedVolumeOwnership({
      schema_version: TRUSTED_OWNERSHIP_SCHEMA_VERSION,
      run_id: this.runId,
      volume_name: this.volumeName,
      channel_version: TRUSTED_CHANNEL_VERSION,
      mount_options: trustedVolumeMountOptions(),
      labels: trustedVolumeLabels({
        runId: this.runId,
        capabilityDigest,
        project: this.project,
      }),
      capability,
      capability_digest: capabilityDigest,
      phase: "pending-create",
    });
    this.ownership.write(intent);

    // 3. Create it, carrying the digest rather than the capability. A label is
    //    readable by anything that can list volumes; the value it hashes from is
    //    not, which is what makes possession of the handle mean something.
    const labelArgs: string[] = [];
    for (const [key, value] of Object.entries(intent.labels)) {
      labelArgs.push("--label", `${key}=${value}`);
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
        ...labelArgs,
        this.volumeName,
      ],
      timeoutMs: 60_000,
    });
    if (created.status !== 0) {
      // The intent stays. Either nothing was created, or something was and a
      // later reconciliation will find it by exact match and remove it.
      return { provisioned: false, reasonCode: TRUSTED_CHANNEL_REASONS.unprovisioned };
    }

    // 4. Read the resource back rather than trusting the create.
    //
    // A daemon that silently ignored an option would otherwise hand the
    // collector a root-owned volume and the failure would surface as an
    // unexplained start-up crash instead of a named refusal — and a daemon that
    // dropped a label would leave a volume this run could no longer prove it
    // owns.
    const observed = this.observedMountOptions();
    if (observed !== trustedVolumeMountOptions()) {
      return {
        provisioned: false,
        reasonCode: TRUSTED_CHANNEL_REASONS.mountOptionsUnexpected,
      };
    }
    if (!labelsMatch(intent.labels, this.observedLabels())) {
      return { provisioned: false, reasonCode: TRUSTED_CHANNEL_REASONS.labelsUnexpected };
    }

    // 5. Only now is ownership asserted. Before this line the handle promises
    //    nothing about a resource existing; after it, cleanup is entitled to act.
    this.ownership.write(sealTrustedVolumeOwnership({ ...withoutHash(intent), phase: "created" }));
    return {
      provisioned: true,
      volumeName: this.volumeName,
      mountOptions: observed,
    };
  }

  /**
   * Resolves a pending intent left by a process that did not finish.
   *
   * The only place this module removes a resource it did not watch being
   * created, and it is deliberately the narrowest possible act: the volume must
   * exist under the *exact* recorded name, carry the *exact* recorded labels,
   * and carry the digest of the capability in the *same* handle. A resource that
   * fails any of those is not the one the intent describes — it may be a
   * stranger's, or a spoof planted under a predicted name — and this returns
   * `false` rather than deleting it.
   *
   * Returns whether provisioning may proceed.
   */
  private reconcilePending(intent: TrustedVolumeOwnership): boolean {
    if (!this.volumeExists()) return true;
    if (!this.resourceProvenOwned(intent)) return false;
    const removed = this.docker.run({
      args: ["volume", "rm", intent.volume_name],
      timeoutMs: 60_000,
    });
    if (removed.status === 0) return true;
    return !this.volumeExists();
  }

  /**
   * Whether the volume Docker currently reports is provably this handle's.
   *
   * Two independent questions, deliberately answered by two statements rather
   * than one:
   *
   * **Is it the right kind of resource, belonging to this run?** — the observed
   * label set must equal the handle's exactly. Set equality, so a missing label
   * and an extra label both refuse; and never a substring test, because
   * `com.erl2.run_id` matching *within* a longer value would let a run id that
   * is a prefix of another satisfy it.
   *
   * **Does this process hold the capability that created it?** — the ownership
   * label must equal the digest re-derived from the handle's raw capability.
   * Re-derived, not read from the handle's own `capability_digest` field: a
   * record that carries a digest it cannot produce proves nothing, and this way
   * possession of the *value* is what the check consumes.
   *
   * Called immediately before every removal, so the answer cannot go stale
   * between an inspection and an action. A volume that is replaced in the
   * remaining window would have to be replaced by one carrying a digest of a
   * capability that has never left this file.
   */
  private resourceProvenOwned(handle: TrustedVolumeOwnership): boolean {
    const observed = this.observedLabels();
    if (!labelsMatch(handle.labels, observed)) return false;
    if (observed?.[TRUSTED_VOLUME_LABEL_KEYS.ownership] !== trustedCapabilityDigest(handle.capability)) {
      return false;
    }
    return true;
  }

  /** Every label the daemon reports for this volume, or `undefined` if there is none. */
  private observedLabels(): Readonly<Record<string, string>> | undefined {
    const result = this.docker.run({
      args: ["volume", "inspect", this.volumeName, "--format", "{{json .Labels}}"],
      timeoutMs: 60_000,
    });
    if (result.status !== 0) return undefined;
    let value: unknown;
    try {
      value = parseStrictJson(result.stdout.trim());
    } catch {
      return undefined;
    }
    // A volume with no labels at all reports `null`, which is a label set this
    // handle can never match rather than an error.
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const labels: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry !== "string") return undefined;
      labels[key] = entry;
    }
    return labels;
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
          return this.finalize(read.bytes, read.fileNames, "attribution");
        }
      }
      previous = read.bytes;
      previousNames = read.fileNames;
      this.sleep(TRUSTED_CHANNEL_FLUSH_INTERVAL_MS);
    }

    // The budget is spent, and this branch is now honest about what that means.
    //
    // Those exact bytes were read twice and did not move, so they are still a
    // frozen artifact and the caller may still want them — but they carry
    // `settledBy: "budget"`, and the producer above refuses to build a positive
    // count claim from that. The previous candidate returned this indistinguishable
    // from an attributed freeze, and an independent review reproduced the
    // consequence: telemetry arriving after the budget was sealed as
    // `evidence: observed, spans: 0`, byte-identical to a genuine zero.
    //
    // The comment that used to sit here said asserting "the collector received
    // nothing" when it did is intolerable, and then the next line did exactly
    // that. The distinction is carried in the type now rather than in a comment.
    if (lastStable !== undefined) {
      return this.finalize(lastStable.bytes, lastStable.fileNames, "budget");
    }
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
  private finalize(
    bytes: Buffer,
    fileNames: readonly string[],
    settledBy: TrustedChannelSettleCause,
  ): TrustedChannelFreeze {
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
      settledBy,
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
    // `-` makes `docker cp` write the archive to stdout instead of extracting
    // it. Nothing touches this host's filesystem on this path at all, so the
    // `label` no longer names a directory — it names the read, for diagnostics.
    void label;
    if (this.docker.runBinary === undefined) {
      // A CLI that cannot answer in bytes cannot be type-checked, and the
      // fallback would be exactly the dereferencing read this replaced.
      return { ok: false, reasonCode: TRUSTED_CHANNEL_REASONS.copyFailed };
    }
    const copied = this.docker.runBinary({
      args: ["cp", `${collector.containerName}:${TRUSTED_CHANNEL_MOUNT_PATH}`, "-"],
      timeoutMs: 120_000,
    });
    if (copied.status !== 0) {
      return { ok: false, reasonCode: TRUSTED_CHANNEL_REASONS.copyFailed };
    }
    // The archive is bounded well above the contract ceiling: an artifact over
    // that ceiling must be refused as `overSizeBound` with its real length, not
    // lost here as an unreadable archive.
    const archive = readTrustedArchive(copied.stdout, TRUSTED_TELEMETRY_MAX_BYTES * 4);
    if (!archive.ok) {
      return { ok: false, reasonCode: TRUSTED_CHANNEL_REASONS.copyFailed };
    }

    // `docker cp` of a directory includes the directory itself as the first
    // entry. That one is expected; everything below it is the trusted
    // directory's actual contents.
    const contents = archive.entries.filter(
      (entry) => entry.name.replace(/\/+$/, "") !== "trusted",
    );
    const fileNames = contents
      .map((entry) => entry.name.replace(/^trusted\//, "").replace(/\/+$/, ""))
      .sort();

    if (contents.some((entry) => unsafeArchiveName(entry.name))) {
      return { ok: false, reasonCode: TRUSTED_CHANNEL_REASONS.sourceEntryNotRegular };
    }
    if (fileNames.length === 0 || !fileNames.includes(TRUSTED_CHANNEL_FILE_NAME)) {
      return { ok: false, reasonCode: TRUSTED_CHANNEL_REASONS.artifactMissing };
    }
    if (fileNames.length !== 1) {
      return { ok: false, reasonCode: TRUSTED_CHANNEL_REASONS.unexpectedFile };
    }
    const entry = contents[0];
    // The type check, and the whole point of reading the archive: it happens
    // here, on the header, before any byte of the payload is used and without
    // anything ever resolving the name.
    if (entry === undefined || entry.type !== "regular-file" || entry.bytes === undefined) {
      return { ok: false, reasonCode: TRUSTED_CHANNEL_REASONS.sourceEntryNotRegular };
    }
    // The bytes come from the entry that was just classified. There is no second
    // lookup to disagree with the first.
    return { ok: true, bytes: Buffer.from(entry.bytes), fileNames };
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
    // The handle is read before anything is deleted. The freeze root is
    // caller-supplied working material and the ownership store is caller-supplied
    // durable state, and this module is not in a position to prove they are not
    // the same directory — so it reads the proof it needs first and removes
    // afterwards, rather than depending on a separation it cannot check.
    const handle = this.readOwnership();
    rmSync(this.freezeRoot, { recursive: true, force: true });
    // Nothing was ever claimed, or what is on disk is not a handle this process
    // can read as one. Both mean the same thing to this function — there is no
    // proof of ownership — and the response to no proof is to remove nothing.
    // The distinction between them is preserved for the operator in `detail`.
    if (handle === undefined) {
      const detail = this.unprovableOwnershipDetail();
      return {
        attempted: false,
        removed: false,
        surviving: [],
        ...(detail === undefined ? {} : { detail }),
      };
    }
    // A tombstone. Destroy is idempotent because this is a fact about a
    // resource that was already removed, and it names a fixed volume, so a
    // repeated destroy can never reach forward to something created later.
    if (handle.phase === "released") {
      return { attempted: false, removed: false, surviving: [] };
    }
    // The resource is already gone — a prior removal whose tombstone write did
    // not land, or a daemon that lost it. Honest outcome: there is nothing
    // surviving, and the handle is retired so the next destroy is a no-op.
    if (!this.volumeExists()) return this.releaseHandle(handle);
    // The proof, taken immediately before the removal rather than at any earlier
    // point in the lifecycle.
    if (!this.resourceProvenOwned(handle)) {
      return {
        attempted: true,
        removed: false,
        surviving: [this.volumeName],
        detail:
          "a volume of this run's name exists but does not carry this run's ownership labels " +
          "and capability digest; it is not this channel's to remove",
      };
    }
    const removed = this.docker.run({
      args: ["volume", "rm", this.volumeName],
      timeoutMs: 60_000,
    });
    // A volume that is gone anyway is removed, however it went. A volume that is
    // still there is reported as surviving, with the daemon's own words — and
    // the handle is *kept*, in the phase it was in, so the next attempt still
    // holds the capability. Tombstoning a failed removal would strand the
    // resource exactly as the in-memory flag did.
    if (removed.status === 0 || !this.volumeExists()) return this.releaseHandle(handle);
    return {
      attempted: true,
      removed: false,
      surviving: [this.volumeName],
      detail: removed.stderr.trim().slice(0, 512),
    };
  }

  /**
   * Retires the handle and reports the removal.
   *
   * The single tombstone site, deliberately: every path that concludes the
   * resource is gone goes through here, so "removed" and "the claim is retired"
   * cannot come apart. A second destroy then finds a `released` handle and does
   * nothing — and because the handle names one fixed volume, it can never reach
   * a resource created later under the same name.
   */
  private releaseHandle(handle: TrustedVolumeOwnership): TrustedChannelCleanup {
    this.ownership.write(sealTrustedVolumeOwnership({ ...withoutHash(handle), phase: "released" }));
    return { attempted: true, removed: true, surviving: [] };
  }

  /**
   * Why ownership could not be proved, for an operator who has to act on it.
   *
   * "Never claimed" and "claimed, and this process cannot read the claim" lead
   * to different next steps, so they are different sentences — but neither is a
   * licence to delete anything, which is why they share a return shape.
   */
  private unprovableOwnershipDetail(): string | undefined {
    let raw: TrustedVolumeOwnership | undefined;
    try {
      raw = this.ownership.read();
    } catch {
      return (
        "the trusted volume's ownership handle could not be read; " +
        "no resource was removed, because a resource this process cannot prove it owns is not its to remove"
      );
    }
    if (raw === undefined) return undefined;
    return (
      "the trusted volume's ownership handle names another run or another volume; " +
      "no resource was removed"
    );
  }
}

/** A handle body without its integrity hash, ready to be re-sealed after a phase change. */
function withoutHash(handle: TrustedVolumeOwnership): Omit<TrustedVolumeOwnership, "core_hash"> {
  const { core_hash: _ignored, ...body } = handle;
  return body;
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
  /**
   * Whether this run may observe zero, bound before the channel is read.
   *
   * Defaults to `EXPECTS_TELEMETRY`, so a caller that supplies nothing gets the
   * fail-closed answer. It is read only *after* the freeze, but it must have
   * been decided before — a flag set in response to an empty artifact is the
   * caller convenience this exists to prevent, and package 3 is where it gets
   * bound to the scenario's own contract.
   */
  readonly zeroEligibility?: TrustedChannelZeroEligibility;
}): TrustedTelemetryMaterial {
  const { channel, collector, binding, marker } = input;
  const zeroEligibility = input.zeroEligibility ?? EXPECTS_TELEMETRY;
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
  // entitled to win. Checked before any verdict below, so no branch can build a
  // claim on bytes the two readers describe differently.
  if (
    counts.byteLength !== freeze.byteLength ||
    counts.recordCount !== freeze.recordCount ||
    counts.finalRecordTerminated !== freeze.finalRecordTerminated
  ) {
    return { evidence: "absent", marker, reasonCode: TRUSTED_CHANNEL_REASONS.notFinalized };
  }

  // The zero decision, and the only place it is made.
  //
  // A freeze that ended on `budget` proves the bytes stopped moving and nothing
  // else. If this run's telemetry is in those bytes the wait would have ended on
  // `attribution`, so reaching here with `budget` means it is not — and the
  // question becomes whether *this run was allowed to observe zero*, which is a
  // fact about its contract rather than about the file.
  //
  // Neither branch below can reach the `observed` constructor unless a positive
  // fact justifies it: either attribution (the telemetry arrived) or a
  // zero-eligibility bound before observation (the contract permits none).
  // Elapsed time, byte stability and an absence of spans justify nothing on
  // their own, which is exactly what the reproduced defect assumed they did.
  if (freeze.settledBy === "budget") {
    if (counts.runAttributedRecords > 0) {
      // Unreachable through `close`'s own predicate, and deliberately not
      // trusted to be: if attribution is present the artifact is positive
      // regardless of which branch produced it, and falling through to a zero
      // here would be the same defect wearing the opposite sign.
      return observedMaterial(collector, binding, marker, freeze, counts);
    }
    if (zeroEligibility.kind === "zero-eligible") {
      // A positively justified zero: the contract said before observation that
      // this run may legitimately emit nothing, and the artifact is empty and
      // finalized. That is the authentic observed zero ADR-ERL2-033 protects,
      // and it stays a different fact from `absent`.
      if (counts.recordCount === 0) {
        return observedMaterial(collector, binding, marker, freeze, counts);
      }
      // Zero was permitted; what arrived is neither zero nor this run's. The
      // artifact is not empty, so "the collector received nothing" is false, and
      // the run's own telemetry never appeared.
      return { evidence: "absent", marker, reasonCode: TRUSTED_CHANNEL_REASONS.settleTimeout };
    }
    return {
      evidence: "absent",
      marker,
      reasonCode:
        counts.recordCount === 0
          ? TRUSTED_CHANNEL_REASONS.expectedTelemetryMissing
          : TRUSTED_CHANNEL_REASONS.settleTimeout,
    };
  }
  return observedMaterial(collector, binding, marker, freeze, counts);
}

/**
 * The one construction site for `observed` material.
 *
 * A single constructor so every path that claims counts is visible in one
 * place: the settle branches above decide *whether* a positive claim is
 * justified, and this decides nothing at all. Splitting the two is what stops a
 * future branch from quietly acquiring the ability to assert a zero.
 */
function observedMaterial(
  collector: VerifiedTrustedCollector,
  binding: TrustedChannelBinding,
  marker: string,
  freeze: Extract<TrustedChannelFreeze, { frozen: true }>,
  counts: TrustedTelemetryCounts,
): TrustedTelemetryMaterial {
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
