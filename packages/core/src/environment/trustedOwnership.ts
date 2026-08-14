/**
 * Durable ownership of the trusted telemetry volume (ADR-ERL2-038 §3, package 2).
 *
 * ## The defect this exists to close
 *
 * The first package 2 candidate proved it created the trusted volume with a
 * field on the channel object:
 *
 *     private created = false;
 *
 * That is a correct proof inside one process and no proof at all across two.
 * The ERL2 CLI runs each lifecycle step in its own process — `provision`,
 * `start`, `observe`, `destroy` are four invocations, and the driver is rebuilt
 * from durable state each time — so the process that runs `destroy` constructs a
 * channel whose `created` is `false`, declines to remove anything, and leaves the
 * volume behind. Measured on a clean daemon: one `erl2-trusted-<uuid>` survived
 * every single run, and the environment's own teardown then failed on the residue
 * it had just created.
 *
 * The fix is not "remove the volume by name anyway". A name is a guess: it names
 * what a volume is *called*, not who created it, and cleanup that deletes on a
 * name alone will happily delete a volume this run refused to adopt. What is
 * needed is a proof of ownership that outlives the process that acquired it, and
 * that a different run, a stale record or a spoofed resource cannot satisfy.
 *
 * ## What the handle proves
 *
 * A capability. `provision` mints a random nonce, keeps the raw value in this
 * record — which lives beside the substrate, mode 0600, and never enters a
 * container, an image, an environment variable or the Compose graph — and puts
 * only its digest in a Docker label. Removing the volume requires re-deriving the
 * digest from the retained nonce and finding it on the resource, so:
 *
 * - a **different run** holds a different nonce and cannot match this label;
 * - a **spoofed volume** carrying the right name cannot carry the right digest,
 *   because the value it hashes from was never published;
 * - a **stale handle** whose volume is gone deletes nothing, because there is
 *   nothing to match;
 * - the **subject and the adapter** never see the raw value — they have no
 *   Docker socket either, so this is defence in depth rather than the boundary.
 *
 * The Docker-daemon administrator remains outside the threat boundary, as
 * everywhere else in this package: an administrator can read the label, forge the
 * volume and remove it directly, and no label discipline changes that.
 *
 * ## Why a file beside the substrate rather than a field in the run record
 *
 * `ComposeRunStore` is the driver's existing durable record and this store is
 * deliberately rooted in the same directory, keyed by the same base64url run id,
 * and written by the same atomic temp-then-rename. What it does not do is share
 * the *document*: the ownership intent has to be persisted in the narrow window
 * before `docker volume create` runs, and folding it into the receipts blob would
 * mean a read-modify-write of every receipt in that window. A separate document
 * makes the intent write a single atomic rename of a small file, which is what
 * the crash sequence in `trustedChannel.ts` depends on.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CODES, Erl2Error, parseStrictJson, type Hash } from "@erl2/contracts";
import { coreHash, hashBytes } from "@erl2/integrity";

/**
 * The handle's own schema identity.
 *
 * Versioned because the record is read by a process that did not write it and
 * may not be the same build. A handle whose version this build does not know is
 * refused rather than interpreted, for the same reason an unknown contract
 * version is: guessing at a resource-deletion capability is the one place a
 * tolerant reader cannot be afforded.
 */
export const TRUSTED_OWNERSHIP_SCHEMA_VERSION = "erl2.trusted-volume-ownership/v1";

/**
 * The trusted channel's own identity, bound into the handle and the labels.
 *
 * Moves when the channel's resource shape changes, so a handle written by a
 * build with a different notion of what the volume *is* does not authorize this
 * build to remove it.
 */
export const TRUSTED_CHANNEL_VERSION = "trusted-telemetry-channel/v1";

/**
 * Where the ownership record is in its lifecycle.
 *
 * Three states and the transitions between them are the whole crash-safety
 * argument:
 *
 * - `pending-create` — the intent is durable and the volume may or may not
 *   exist. A later process may reconcile it, but only against the exact name,
 *   labels and capability recorded here.
 * - `created` — the volume was created *and* read back and matched. This is the
 *   only state that asserts a resource exists.
 * - `released` — the volume was removed, and this handle is a tombstone. A
 *   repeated destroy sees it and does nothing, and it can never name a future
 *   resource because the volume name is fixed in the record.
 */
export type TrustedVolumeOwnershipPhase = "pending-create" | "created" | "released";

/**
 * The durable proof that this run created this volume.
 *
 * Every field is something a later process needs and cannot re-derive. There is
 * deliberately no timestamp: nothing here is decided by elapsed time, and the
 * repository's deterministic-output rules would make a clock in this record a
 * new source of drift for no benefit.
 */
export interface TrustedVolumeOwnership {
  readonly schema_version: typeof TRUSTED_OWNERSHIP_SCHEMA_VERSION;
  /** The run that owns it. A handle for another run authorizes nothing here. */
  readonly run_id: string;
  /** The exact volume name. Never a prefix, never a pattern. */
  readonly volume_name: string;
  /** The channel build that created it. */
  readonly channel_version: typeof TRUSTED_CHANNEL_VERSION;
  /** The `o=` option string the daemon must echo back. */
  readonly mount_options: string;
  /** Every label the volume must carry, exactly — no more and no fewer. */
  readonly labels: Readonly<Record<string, string>>;
  /**
   * The raw capability. Retained here and **only** here.
   *
   * Not in a label, not in the Compose environment, not in the inventory and not
   * in any evidence record — the artifact the run produces must not carry the
   * value that authorizes deleting the resource it came from.
   */
  readonly capability: string;
  /** `hashBytes(capability)`. This is what the label carries. */
  readonly capability_digest: Hash;
  readonly phase: TrustedVolumeOwnershipPhase;
  /** Integrity over everything above. A record that fails this is not a handle. */
  readonly core_hash: Hash;
}

/** The label keys the handle binds. Exact keys, compared exactly. */
export const TRUSTED_VOLUME_LABEL_KEYS = {
  resourceType: "com.erl2.resource_type",
  runId: "com.erl2.run_id",
  driverId: "com.erl2.driver_id",
  channelVersion: "com.erl2.trusted_channel_version",
  ownership: "com.erl2.trusted_ownership_digest",
  composeProject: "com.docker.compose.project",
} as const;

/** What the trusted volume declares itself to be. */
export const TRUSTED_VOLUME_RESOURCE_TYPE = "trusted-telemetry-volume";

/** A fresh capability. 32 bytes of CSPRNG, hex, never logged and never exported. */
export function newTrustedVolumeCapability(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString("hex");
}

/** The digest a label carries for a capability. */
export function trustedCapabilityDigest(capability: string): Hash {
  return hashBytes(Buffer.from(capability, "utf8"));
}

/**
 * The labels a volume must carry for this handle, exactly.
 *
 * Built from the handle rather than from ambient state, so the set that is
 * written at creation and the set that is checked before removal are the same
 * function of the same record. The Compose project label is included only when
 * the driver supplies one, and its presence or absence is part of the exact
 * comparison — an unexpected extra label is a mismatch, not a detail.
 */
export function trustedVolumeLabels(input: {
  readonly runId: string;
  readonly capabilityDigest: Hash;
  readonly project?: string | undefined;
}): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {
    [TRUSTED_VOLUME_LABEL_KEYS.resourceType]: TRUSTED_VOLUME_RESOURCE_TYPE,
    [TRUSTED_VOLUME_LABEL_KEYS.runId]: input.runId,
    [TRUSTED_VOLUME_LABEL_KEYS.driverId]: "compose-driver",
    [TRUSTED_VOLUME_LABEL_KEYS.channelVersion]: TRUSTED_CHANNEL_VERSION,
    [TRUSTED_VOLUME_LABEL_KEYS.ownership]: input.capabilityDigest,
  };
  if (input.project !== undefined) {
    labels[TRUSTED_VOLUME_LABEL_KEYS.composeProject] = input.project;
  }
  return labels;
}

/**
 * Whether an observed label set is exactly the one this handle requires.
 *
 * Exact set equality, not containment and never a substring test. A volume with
 * the right name and one missing label is not this run's volume, and a volume
 * carrying an extra label is a resource something else has an opinion about.
 * Both refuse.
 */
export function labelsMatch(
  expected: Readonly<Record<string, string>>,
  observed: Readonly<Record<string, string>> | undefined,
): boolean {
  if (observed === undefined) return false;
  const expectedKeys = Object.keys(expected).sort();
  const observedKeys = Object.keys(observed).sort();
  if (expectedKeys.length !== observedKeys.length) return false;
  for (const [index, key] of expectedKeys.entries()) {
    if (observedKeys[index] !== key) return false;
    if (observed[key] !== expected[key]) return false;
  }
  return true;
}

/**
 * Whether a value read off disk is a handle this build may act on.
 *
 * Shape, then version, then integrity — in that order, because a record that is
 * not the right shape cannot be hashed meaningfully. Anything that fails is not
 * a handle, and the caller's only safe response is to remove nothing.
 */
export function isTrustedVolumeOwnership(value: unknown): value is TrustedVolumeOwnership {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<TrustedVolumeOwnership> & Record<string, unknown>;
  if (record.schema_version !== TRUSTED_OWNERSHIP_SCHEMA_VERSION) return false;
  if (record.channel_version !== TRUSTED_CHANNEL_VERSION) return false;
  if (typeof record.run_id !== "string" || record.run_id.length === 0) return false;
  if (typeof record.volume_name !== "string" || record.volume_name.length === 0) return false;
  if (typeof record.mount_options !== "string") return false;
  if (typeof record.capability !== "string" || record.capability.length === 0) return false;
  if (typeof record.capability_digest !== "string") return false;
  if (typeof record.core_hash !== "string") return false;
  if (
    record.phase !== "pending-create" &&
    record.phase !== "created" &&
    record.phase !== "released"
  ) {
    return false;
  }
  const labels = record.labels;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return false;
  for (const entry of Object.values(labels as Record<string, unknown>)) {
    if (typeof entry !== "string") return false;
  }
  // The capability and its digest must agree, and the whole record must hash to
  // what it claims. A handle edited by hand — to point at another volume, or to
  // carry another run's digest — fails here rather than authorizing a removal.
  if (trustedCapabilityDigest(record.capability) !== record.capability_digest) return false;
  const { core_hash: claimed, ...core } = record as TrustedVolumeOwnership;
  return coreHash(core) === claimed;
}

/** Seals a handle body with its integrity hash. */
export function sealTrustedVolumeOwnership(
  body: Omit<TrustedVolumeOwnership, "core_hash">,
): TrustedVolumeOwnership {
  return { ...body, core_hash: coreHash(body) };
}

/**
 * The durable store a channel proves ownership through.
 *
 * Narrow on purpose: three operations, no verdicts, and no knowledge of Docker.
 * The channel decides what a handle means; this only makes one survive a process
 * exit.
 */
export interface TrustedOwnershipStore {
  /**
   * The handle, or `undefined` if this run never wrote one.
   *
   * Throws on a record that exists but cannot be read as a handle. Absence and
   * corruption are different facts: absence means nothing was claimed, and
   * corruption means something was claimed and this process cannot tell what.
   * Collapsing them would let a damaged file read as "nothing to clean up".
   */
  read(): TrustedVolumeOwnership | undefined;
  /** Atomically replaces the handle. */
  write(record: TrustedVolumeOwnership): void;
}

/**
 * A handle stored beside the substrate, atomically.
 *
 * Temp file then rename, which is atomic within a directory on every filesystem
 * this Lab supports: a reader sees either the previous handle or the new one and
 * never a partial write. That is what makes the crash windows in
 * `trustedChannel.ts` enumerable — every crash lands on one of the two states,
 * not between them.
 */
export function fileTrustedOwnershipStore(input: {
  readonly root: string;
  readonly runId: string;
}): TrustedOwnershipStore {
  const root = path.resolve(input.root);
  // The same key derivation `ComposeRunStore` uses, so a run's documents sit
  // together and a run id containing filesystem-hostile characters cannot become
  // a path.
  const file = path.join(
    root,
    `${Buffer.from(input.runId, "utf8").toString("base64url")}.trusted-volume.json`,
  );
  return {
    read(): TrustedVolumeOwnership | undefined {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Erl2Error(
          CODES.ENV_SUBSTRATE_UNREADABLE,
          "the trusted volume's ownership handle exists but could not be read",
          { owner: "lab", cause },
        );
      }
      let value: unknown;
      try {
        value = parseStrictJson(text);
      } catch (cause) {
        throw new Erl2Error(
          CODES.ENV_SUBSTRATE_UNREADABLE,
          "the trusted volume's ownership handle is not a readable document",
          { owner: "lab", cause },
        );
      }
      if (!isTrustedVolumeOwnership(value)) {
        throw new Erl2Error(
          CODES.ENV_SUBSTRATE_UNREADABLE,
          "the trusted volume's ownership handle does not have the shape of an ownership handle; " +
            "a resource this process cannot prove it owns is one it must not remove",
          { owner: "lab" },
        );
      }
      return value;
    },
    write(record: TrustedVolumeOwnership): void {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const temp = `${file}.tmp`;
      try {
        // 0600: the capability is in here, and it is the only secret this
        // package holds.
        writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        renameSync(temp, file);
      } catch (cause) {
        rmSync(temp, { force: true });
        throw new Erl2Error(
          CODES.ENV_SUBSTRATE_UNREADABLE,
          "the trusted volume's ownership handle could not be written; " +
            "a volume whose ownership is not durable would survive its own run",
          { owner: "lab", cause },
        );
      }
    },
  };
}
