/**
 * Durable ownership of the trusted telemetry volume.
 *
 * The defect these tests exist for was not subtle and not theoretical: the first
 * package 2 candidate proved it had created the volume with a boolean field on
 * the channel object, the CLI runs each lifecycle step in its own process, and
 * so the `destroy` process asked a freshly constructed object whether it had
 * created anything, was told no, and left the volume behind — on every run, on a
 * clean daemon, measurably.
 *
 * What replaces it has to satisfy two demands that pull in opposite directions.
 * It must remove the volume *without* the process that created it, and it must
 * refuse to remove anything it cannot prove is that volume. A cleanup that
 * deletes by name satisfies the first and fails the second; the in-memory flag
 * satisfied the second and failed the first. The handle is the thing that
 * satisfies both, and these tests are mostly about the second demand, because
 * the first is easy and the second is where a fix like this goes wrong.
 *
 * Process boundaries are exercised for real in `trustedCrossProcess.test.ts`.
 * These are the unit-level properties: what a handle is, what it refuses, and
 * what each crash window leaves behind.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fileTrustedOwnershipStore,
  isTrustedVolumeOwnership,
  labelsMatch,
  newTrustedVolumeCapability,
  sealTrustedVolumeOwnership,
  trustedCapabilityDigest,
  trustedVolumeLabels,
  trustedVolumeName,
  TrustedTelemetryChannel,
  TRUSTED_CHANNEL_REASONS,
  TRUSTED_CHANNEL_VERSION,
  TRUSTED_OWNERSHIP_SCHEMA_VERSION,
  TRUSTED_VOLUME_LABEL_KEYS,
  TRUSTED_VOLUME_RESOURCE_TYPE,
  type DockerBinaryResult,
  type DockerInvocation,
  type DockerResult,
  type TrustedVolumeOwnership,
} from "@erl2/core";

const RUN_ID = "01a001f5-48a0-7d19-9c2e-fa3545079b9f";
const OTHER_RUN = "01a001f5-48a0-7d19-9c2e-fa3545079999";
const VOLUME = trustedVolumeName(RUN_ID);

const roots: string[] = [];
function newRoot(label: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `erl2-ownership-${label}-`));
  roots.push(root);
  return root;
}
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// -- a daemon that remembers, so the sequence can be interrogated -------------

interface FakeVolume {
  readonly labels: Record<string, string>;
  readonly options: string;
}

/**
 * A Docker stand-in that behaves like the daemon for the four commands the
 * channel issues, and records every one of them.
 *
 * Deliberately stateful: the properties under test are about what happens across
 * a create, a crash and a remove, and a stub that answers each call in isolation
 * could not distinguish "the volume is gone" from "the volume was never there".
 */
class FakeDaemon {
  readonly volumes = new Map<string, FakeVolume>();
  readonly commands: string[][] = [];
  /** Set to make `volume rm` fail, as an in-use volume does. */
  removeFailure: string | undefined;

  run = (invocation: DockerInvocation): DockerResult => {
    const args = [...invocation.args];
    this.commands.push(args);
    const reply = (status: number, stdout = ""): DockerResult => ({
      args,
      status,
      stdout,
      stderr: status === 0 ? "" : (this.removeFailure ?? "Error: no such volume"),
      timedOut: false,
    });
    if (args[0] !== "volume") return reply(1);
    if (args[1] === "create") {
      const name = args[args.length - 1] as string;
      const labels: Record<string, string> = {};
      for (const [index, value] of args.entries()) {
        if (value !== "--label") continue;
        const entry = args[index + 1] as string;
        const split = entry.indexOf("=");
        labels[entry.slice(0, split)] = entry.slice(split + 1);
      }
      const option = args.find((value) => value.startsWith("o=")) ?? "";
      this.volumes.set(name, { labels, options: option.slice(2) });
      return reply(0, name);
    }
    if (args[1] === "inspect") {
      const name = args[2] as string;
      const volume = this.volumes.get(name);
      if (volume === undefined) return reply(1);
      const format = args[args.length - 1];
      if (format === "{{json .Labels}}") return reply(0, JSON.stringify(volume.labels));
      if (format === '{{index .Options "o"}}') return reply(0, volume.options);
      return reply(0, name);
    }
    if (args[1] === "rm") {
      const name = args[2] as string;
      if (!this.volumes.has(name)) return reply(1);
      if (this.removeFailure !== undefined) return reply(1);
      this.volumes.delete(name);
      return reply(0);
    }
    return reply(1);
  };

  runBinary = (invocation: DockerInvocation): DockerBinaryResult => ({
    args: [...invocation.args],
    status: 1,
    stdout: Buffer.alloc(0),
    stderr: "",
    timedOut: false,
  });
}

/**
 * A channel over a given daemon and a given durable root.
 *
 * `root` is the parameter that matters: two channels sharing a root are what a
 * second process looks like from inside one test, and two channels *not* sharing
 * one are what the old defect looked like.
 */
function channel(daemon: FakeDaemon, root: string, runId = RUN_ID): TrustedTelemetryChannel {
  return new TrustedTelemetryChannel({
    runId,
    docker: daemon,
    freezeRoot: path.join(root, "freeze"),
    ownership: fileTrustedOwnershipStore({ root, runId }),
    project: `erl2-${runId}`,
    sleep: () => undefined,
    stabilityAttempts: 2,
  });
}

function handleFile(root: string): string {
  return path.join(root, `${Buffer.from(RUN_ID, "utf8").toString("base64url")}.trusted-volume.json`);
}

function readHandle(root: string): TrustedVolumeOwnership {
  const value = fileTrustedOwnershipStore({ root, runId: RUN_ID }).read();
  assert.ok(value !== undefined, "no ownership handle was written");
  return value;
}

// -- 1. the handle itself -----------------------------------------------------

test("TRUSTED-OWNERSHIP: provisioning writes a durable, run-bound, sealed handle", () => {
  const root = newRoot("shape");
  const daemon = new FakeDaemon();
  assert.equal(channel(daemon, root).provision().provisioned, true);

  const handle = readHandle(root);
  assert.equal(handle.schema_version, TRUSTED_OWNERSHIP_SCHEMA_VERSION);
  assert.equal(handle.channel_version, TRUSTED_CHANNEL_VERSION);
  assert.equal(handle.run_id, RUN_ID);
  assert.equal(handle.volume_name, VOLUME);
  assert.equal(handle.phase, "created");
  // The capability is a secret with a published digest, and the two agree.
  assert.equal(trustedCapabilityDigest(handle.capability), handle.capability_digest);
  assert.equal(isTrustedVolumeOwnership(handle), true, "the sealed handle does not verify");
});

test("TRUSTED-OWNERSHIP: the raw capability is in the handle and nowhere else", () => {
  const root = newRoot("secret");
  const daemon = new FakeDaemon();
  channel(daemon, root).provision();
  const capability = readHandle(root).capability;

  // Not in any command line — so not in a process listing, and not in anything
  // that shells out to Docker with these arguments.
  for (const command of daemon.commands) {
    assert.equal(
      command.join(" ").includes(capability),
      false,
      `the raw capability appeared in a Docker command: ${command.join(" ")}`,
    );
  }
  // Not on the resource. The label carries the digest, which is what a reader
  // needs to check ownership and not enough to claim it.
  const volume = daemon.volumes.get(VOLUME);
  assert.ok(volume !== undefined);
  assert.equal(
    JSON.stringify(volume.labels).includes(capability),
    false,
    "the raw capability was published as a Docker label",
  );
  assert.equal(
    volume.labels[TRUSTED_VOLUME_LABEL_KEYS.ownership],
    trustedCapabilityDigest(capability),
  );
});

test("TRUSTED-OWNERSHIP: the volume carries exactly the labels the handle requires", () => {
  const root = newRoot("labels");
  const daemon = new FakeDaemon();
  channel(daemon, root).provision();
  const handle = readHandle(root);
  const volume = daemon.volumes.get(VOLUME);
  assert.ok(volume !== undefined);
  assert.equal(labelsMatch(handle.labels, volume.labels), true);
  assert.equal(volume.labels[TRUSTED_VOLUME_LABEL_KEYS.resourceType], TRUSTED_VOLUME_RESOURCE_TYPE);
  assert.equal(volume.labels[TRUSTED_VOLUME_LABEL_KEYS.runId], RUN_ID);
  assert.equal(volume.labels[TRUSTED_VOLUME_LABEL_KEYS.channelVersion], TRUSTED_CHANNEL_VERSION);
});

test("TRUSTED-OWNERSHIP: label comparison is key-set equality, not containment", () => {
  const expected = trustedVolumeLabels({
    runId: RUN_ID,
    capabilityDigest: trustedCapabilityDigest("c"),
    project: "erl2-p",
  });
  assert.equal(labelsMatch(expected, { ...expected }), true);
  assert.equal(labelsMatch(expected, undefined), false, "an unlabelled volume matched");
  // A superset is not a match: an extra label is something else's opinion about
  // a resource this run believes it owns alone.
  assert.equal(labelsMatch(expected, { ...expected, extra: "x" }), false, "a superset matched");
  const { [TRUSTED_VOLUME_LABEL_KEYS.driverId]: _dropped, ...missing } = expected;
  assert.equal(labelsMatch(expected, missing), false, "a subset matched");
  assert.equal(
    labelsMatch(expected, { ...expected, [TRUSTED_VOLUME_LABEL_KEYS.runId]: `${RUN_ID}x` }),
    false,
    "a run id that merely contains the expected one matched",
  );
  // The ownership digest's *key* is required and its *value* is not this
  // function's business — it is the capability proof, checked separately so the
  // two questions can fail, and be measured, independently.
  assert.equal(
    labelsMatch(expected, { ...expected, [TRUSTED_VOLUME_LABEL_KEYS.ownership]: "sha256:whatever" }),
    true,
    "the label comparison absorbed the capability check",
  );
  const { [TRUSTED_VOLUME_LABEL_KEYS.ownership]: _gone, ...withoutOwnership } = expected;
  assert.equal(
    labelsMatch(expected, withoutOwnership),
    false,
    "a volume carrying no ownership label at all matched",
  );
});

// -- 2. what a handle refuses -------------------------------------------------

test("TRUSTED-OWNERSHIP: a tampered handle is not a handle", () => {
  const root = newRoot("tamper");
  const daemon = new FakeDaemon();
  channel(daemon, root).provision();
  const handle = readHandle(root);

  // Every one of these is a plausible edit by something trying to point a
  // capability at a resource it was not minted for.
  const forgeries: readonly (readonly [string, Record<string, unknown>])[] = [
    ["another run", { ...handle, run_id: OTHER_RUN }],
    ["another volume", { ...handle, volume_name: "erl2-trusted-somewhere-else" }],
    ["a different capability", { ...handle, capability: newTrustedVolumeCapability() }],
    ["a digest that does not match its capability", { ...handle, capability_digest: `sha256:${"0".repeat(64)}` }],
    ["relabelled", { ...handle, labels: { ...handle.labels, [TRUSTED_VOLUME_LABEL_KEYS.runId]: OTHER_RUN } }],
    ["a phase it never reached", { ...handle, phase: "created", core_hash: `sha256:${"0".repeat(64)}` }],
    ["an unknown schema version", { ...handle, schema_version: "erl2.trusted-volume-ownership/v99" }],
    ["an unknown channel version", { ...handle, channel_version: "trusted-telemetry-channel/v99" }],
  ];
  for (const [label, forged] of forgeries) {
    assert.equal(
      isTrustedVolumeOwnership(forged),
      false,
      `a handle ${label} verified as genuine`,
    );
  }
  // And re-sealing a forgery does not help, because the run id is checked
  // against *this* run before the hash is ever consulted.
  const resealed = sealTrustedVolumeOwnership({
    ...handle,
    run_id: OTHER_RUN,
    core_hash: undefined,
  } as never);
  assert.equal(isTrustedVolumeOwnership(resealed), true, "the resealed forgery is well-formed");
  writeFileSync(handleFile(root), `${JSON.stringify(resealed)}\n`);
  const cleanup = channel(daemon, root).cleanup();
  assert.equal(cleanup.attempted, false, "a resealed foreign handle was acted on");
  assert.equal(daemon.volumes.has(VOLUME), true, "a resealed foreign handle deleted a volume");
});

test("TRUSTED-OWNERSHIP: a corrupt handle removes nothing and says so", () => {
  const root = newRoot("corrupt");
  const daemon = new FakeDaemon();
  channel(daemon, root).provision();
  writeFileSync(handleFile(root), "{ this is not a handle");

  const cleanup = channel(daemon, root).cleanup();
  assert.equal(cleanup.attempted, false, "cleanup acted on an unreadable handle");
  assert.equal(cleanup.removed, false);
  assert.equal(daemon.volumes.has(VOLUME), true, "an unreadable handle led to a deletion");
  assert.ok(
    (cleanup.detail ?? "").includes("could not be read"),
    "a corrupt handle produced no actionable detail",
  );
});

test("TRUSTED-OWNERSHIP: no handle means no deletion, however the volume looks", () => {
  const root = newRoot("nohandle");
  const daemon = new FakeDaemon();
  // A volume with this run's exact name and this run's exact labels, created by
  // something else. Without a handle there is no capability to check it against,
  // and a name is not a proof.
  daemon.volumes.set(VOLUME, {
    labels: trustedVolumeLabels({
      runId: RUN_ID,
      capabilityDigest: trustedCapabilityDigest("a capability this run never held"),
      project: `erl2-${RUN_ID}`,
    }) as Record<string, string>,
    options: "",
  });
  const cleanup = channel(daemon, new FakeDaemon() && root).cleanup();
  assert.equal(cleanup.attempted, false);
  assert.equal(daemon.volumes.has(VOLUME), true, "cleanup deleted a volume it never created");
});

test("TRUSTED-OWNERSHIP: a volume with the right name and wrong labels survives", () => {
  const root = newRoot("wronglabels");
  const daemon = new FakeDaemon();
  channel(daemon, root).provision();
  const handle = readHandle(root);
  // The volume is replaced under this run's nose by one that is not this run's.
  //
  // It carries the *correct* capability digest, so this fixture isolates the
  // label check: if the only thing wrong is which run the labels name, the
  // capability proof cannot be what refuses it. A fixture that got both wrong
  // would pass whichever guard survived a mutation, which is how a redundant
  // check reads as a measured one.
  daemon.volumes.set(VOLUME, {
    labels: { ...handle.labels, [TRUSTED_VOLUME_LABEL_KEYS.runId]: OTHER_RUN },
    options: "",
  });

  const cleanup = channel(daemon, root).cleanup();
  assert.equal(cleanup.removed, false, "a mislabelled volume was removed");
  assert.deepEqual([...cleanup.surviving], [VOLUME]);
  assert.equal(daemon.volumes.has(VOLUME), true);
  // The handle survives too — the operator needs it, and the resource may yet be
  // the run's after a transient daemon fault.
  assert.equal(readHandle(root).phase, "created");
});

test("TRUSTED-OWNERSHIP: a volume with the right labels and the wrong capability survives", () => {
  const root = newRoot("wrongnonce");
  const daemon = new FakeDaemon();
  channel(daemon, root).provision();
  const handle = readHandle(root);
  // Every label right except the one that cannot be guessed. This is the spoof
  // the digest exists to defeat: an attacker who can read labels can reproduce
  // all of them but this one, because the value it hashes from never left the
  // handle file. The label *set* is therefore correct, which isolates the
  // capability check — nothing about which run this claims to belong to is
  // wrong, so the label comparison has nothing to object to.
  daemon.volumes.set(VOLUME, {
    labels: {
      ...handle.labels,
      [TRUSTED_VOLUME_LABEL_KEYS.ownership]: trustedCapabilityDigest(newTrustedVolumeCapability()),
    },
    options: "",
  });

  const cleanup = channel(daemon, root).cleanup();
  assert.equal(cleanup.removed, false, "a volume carrying a foreign capability digest was removed");
  assert.deepEqual([...cleanup.surviving], [VOLUME]);
  assert.equal(daemon.volumes.has(VOLUME), true);
});

test("TRUSTED-OWNERSHIP: a pre-existing volume is refused and never adopted or removed", () => {
  const root = newRoot("stale");
  const daemon = new FakeDaemon();
  daemon.volumes.set(VOLUME, { labels: { someone: "else" }, options: "" });

  const provision = channel(daemon, root).provision();
  assert.equal(provision.provisioned, false);
  assert.equal(
    (provision as { reasonCode: string }).reasonCode,
    TRUSTED_CHANNEL_REASONS.volumeStale,
  );
  assert.equal(daemon.volumes.has(VOLUME), true, "a refused pre-existing volume was removed");
  // And the run that refused it removes nothing at teardown either.
  assert.equal(channel(daemon, root).cleanup().removed, false);
  assert.equal(daemon.volumes.has(VOLUME), true);
});

// -- 3. the crash windows -----------------------------------------------------

test("TRUSTED-OWNERSHIP: a crash before the intent leaves nothing to clean up", () => {
  const root = newRoot("crash-pre-intent");
  const daemon = new FakeDaemon();
  // Nothing ran at all. The next process finds no handle and no volume.
  assert.equal(readdirSync(root).length, 0);
  const cleanup = channel(daemon, root).cleanup();
  assert.equal(cleanup.attempted, false);
  assert.equal(cleanup.removed, false);
  assert.deepEqual([...cleanup.surviving], []);
});

test("TRUSTED-OWNERSHIP: a crash after the intent and before the volume is recoverable", () => {
  const root = newRoot("crash-post-intent");
  const daemon = new FakeDaemon();
  // The intent is durable, the daemon refused the create, and the process died.
  // This is the window the ordering was chosen to make safe.
  const failing = new FakeDaemon();
  failing.run = (invocation) => {
    const args = [...invocation.args];
    failing.commands.push(args);
    if (args[1] === "create") {
      return { args, status: 1, stdout: "", stderr: "daemon said no", timedOut: false };
    }
    return { args, status: 1, stdout: "", stderr: "", timedOut: false };
  };
  const first = channel(failing, root).provision();
  assert.equal(first.provisioned, false);
  assert.equal(
    (first as { reasonCode: string }).reasonCode,
    TRUSTED_CHANNEL_REASONS.unprovisioned,
  );
  assert.equal(readHandle(root).phase, "pending-create", "the intent did not survive");

  // A later process reconciles: there is no volume, so there is nothing to
  // remove, and provisioning proceeds cleanly.
  const second = channel(daemon, root).provision();
  assert.equal(second.provisioned, true, "a pending intent with no volume blocked recovery");
  assert.equal(readHandle(root).phase, "created");
  assert.equal(daemon.volumes.has(VOLUME), true);
});

test("TRUSTED-OWNERSHIP: a crash after the volume and before confirmation reconciles the exact resource", () => {
  const root = newRoot("crash-post-create");
  const daemon = new FakeDaemon();
  // Simulate dying between `volume create` and the phase write: the volume
  // exists, carrying the pending intent's own labels and digest.
  const capability = newTrustedVolumeCapability();
  const digest = trustedCapabilityDigest(capability);
  const labels = trustedVolumeLabels({ runId: RUN_ID, capabilityDigest: digest, project: `erl2-${RUN_ID}` });
  fileTrustedOwnershipStore({ root, runId: RUN_ID }).write(
    sealTrustedVolumeOwnership({
      schema_version: TRUSTED_OWNERSHIP_SCHEMA_VERSION,
      run_id: RUN_ID,
      volume_name: VOLUME,
      channel_version: TRUSTED_CHANNEL_VERSION,
      mount_options: "uid=10001,gid=10001,mode=0700,size=64m",
      labels,
      capability,
      capability_digest: digest,
      phase: "pending-create",
    }),
  );
  daemon.volumes.set(VOLUME, { labels: labels as Record<string, string>, options: "" });
  // An unrelated volume sits beside it, so a reconciliation that swept by prefix
  // or by label kind would be visible here.
  daemon.volumes.set("erl2-trusted-someone-elses", { labels: { ...labels }, options: "" });

  const recovered = channel(daemon, root).provision();
  assert.equal(recovered.provisioned, true, "the create-before-confirmation window was unrecoverable");
  assert.equal(readHandle(root).phase, "created");
  assert.equal(
    daemon.volumes.has("erl2-trusted-someone-elses"),
    true,
    "reconciliation removed a resource the intent did not name",
  );
});

test("TRUSTED-OWNERSHIP: reconciliation refuses a mismatched resource rather than deleting it", () => {
  const root = newRoot("reconcile-refuse");
  const daemon = new FakeDaemon();
  const capability = newTrustedVolumeCapability();
  const digest = trustedCapabilityDigest(capability);
  fileTrustedOwnershipStore({ root, runId: RUN_ID }).write(
    sealTrustedVolumeOwnership({
      schema_version: TRUSTED_OWNERSHIP_SCHEMA_VERSION,
      run_id: RUN_ID,
      volume_name: VOLUME,
      channel_version: TRUSTED_CHANNEL_VERSION,
      mount_options: "uid=10001,gid=10001,mode=0700,size=64m",
      labels: trustedVolumeLabels({ runId: RUN_ID, capabilityDigest: digest, project: `erl2-${RUN_ID}` }),
      capability,
      capability_digest: digest,
      phase: "pending-create",
    }),
  );
  // A volume under the intended name that the intent does not describe. It may
  // be a stranger's; it may be a spoof planted under a predictable name. Either
  // way this process has no proof, so it deletes nothing.
  daemon.volumes.set(VOLUME, { labels: { "com.erl2.run_id": OTHER_RUN }, options: "" });

  const provision = channel(daemon, root).provision();
  assert.equal(provision.provisioned, false);
  assert.equal(
    (provision as { reasonCode: string }).reasonCode,
    TRUSTED_CHANNEL_REASONS.reconciliationRefused,
  );
  assert.equal(daemon.volumes.has(VOLUME), true, "reconciliation deleted a mismatched resource");
});

test("TRUSTED-OWNERSHIP: a live claim is never overwritten by a second provision", () => {
  const root = newRoot("conflict");
  const daemon = new FakeDaemon();
  assert.equal(channel(daemon, root).provision().provisioned, true);
  const first = readHandle(root).capability;

  const second = channel(daemon, root).provision();
  assert.equal(second.provisioned, false, "a second provision minted a second capability");
  assert.equal(
    (second as { reasonCode: string }).reasonCode,
    TRUSTED_CHANNEL_REASONS.ownershipConflict,
  );
  // The original capability is intact, so the resource is still removable.
  assert.equal(readHandle(root).capability, first);
  assert.equal(channel(daemon, root).cleanup().removed, true);
});

// -- 4. removal, idempotence and honest failure -------------------------------

test("TRUSTED-OWNERSHIP: a successful removal tombstones the handle", () => {
  const root = newRoot("tombstone");
  const daemon = new FakeDaemon();
  channel(daemon, root).provision();

  const cleanup = channel(daemon, root).cleanup();
  assert.equal(cleanup.removed, true);
  assert.deepEqual([...cleanup.surviving], []);
  assert.equal(daemon.volumes.size, 0, "the volume survived a successful cleanup");
  assert.equal(readHandle(root).phase, "released");
});

test("TRUSTED-OWNERSHIP: repeated destroy is idempotent and cannot reach a later resource", () => {
  const root = newRoot("repeat");
  const daemon = new FakeDaemon();
  channel(daemon, root).provision();
  assert.equal(channel(daemon, root).cleanup().removed, true);

  // Something else later creates a volume under the same name. A tombstone that
  // named a *pattern* rather than a resource would delete it; this one cannot,
  // because it also no longer holds a live claim.
  daemon.volumes.set(VOLUME, { labels: { someone: "else" }, options: "" });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const again = channel(daemon, root).cleanup();
    assert.equal(again.attempted, false, "a tombstoned handle attempted a removal");
    assert.equal(again.removed, false);
    assert.deepEqual([...again.surviving], []);
  }
  assert.equal(daemon.volumes.has(VOLUME), true, "a repeated destroy removed a later resource");
});

test("TRUSTED-OWNERSHIP: a removal that succeeded without a tombstone is recovered honestly", () => {
  const root = newRoot("lost-tombstone");
  const daemon = new FakeDaemon();
  channel(daemon, root).provision();
  // The volume went away and the tombstone write did not land — a crash between
  // the two. The handle still claims `created`, and the resource is gone.
  daemon.volumes.delete(VOLUME);

  const cleanup = channel(daemon, root).cleanup();
  assert.equal(cleanup.attempted, true);
  assert.equal(cleanup.removed, true, "an already-absent volume was reported as surviving");
  assert.deepEqual([...cleanup.surviving], []);
  assert.equal(readHandle(root).phase, "released");
});

test("TRUSTED-OWNERSHIP: a failed removal keeps the handle and reports the daemon's words", () => {
  const root = newRoot("inuse");
  const daemon = new FakeDaemon();
  channel(daemon, root).provision();
  daemon.removeFailure = `Error response from daemon: remove ${VOLUME}: volume is in use - [abc123]`;

  const failed = channel(daemon, root).cleanup();
  assert.equal(failed.removed, false);
  assert.deepEqual([...failed.surviving], [VOLUME]);
  assert.ok((failed.detail ?? "").includes("volume is in use"), "the daemon's reason was lost");
  // The capability survives, which is the whole point: a later attempt can still
  // prove the right to remove it.
  assert.equal(readHandle(root).phase, "created");

  daemon.removeFailure = undefined;
  const retried = channel(daemon, root).cleanup();
  assert.equal(retried.removed, true, "a later attempt could not recover the resource");
  assert.equal(daemon.volumes.size, 0);
  assert.equal(readHandle(root).phase, "released");
});

test("TRUSTED-OWNERSHIP: ownership is read from the handle, never from this object's memory", () => {
  const root = newRoot("memory");
  const daemon = new FakeDaemon();
  const provisioning = channel(daemon, root);
  assert.equal(provisioning.ownsVolume, false, "a channel claimed ownership before provisioning");
  provisioning.provision();
  assert.equal(provisioning.ownsVolume, true);

  // A channel constructed from nothing but the durable root — the state a fresh
  // process is in — knows what the first one did.
  const fresh = channel(daemon, root);
  assert.equal(fresh.ownsVolume, true, "a fresh channel could not read the run's ownership");
  fresh.cleanup();
  assert.equal(channel(daemon, root).ownsVolume, false, "a tombstone still read as ownership");
});

test("TRUSTED-OWNERSHIP: the handle is written atomically and leaves no partial file", () => {
  const root = newRoot("atomic");
  const daemon = new FakeDaemon();
  channel(daemon, root).provision();
  channel(daemon, root).cleanup();
  // Temp files are renamed into place, never left beside the handle for another
  // process to read as one.
  const stray = readdirSync(root).filter((entry) => entry.endsWith(".tmp"));
  assert.deepEqual(stray, [], `a partial handle was left behind: ${stray.join(", ")}`);
  // And what is on disk is exactly one complete document.
  const text = readFileSync(handleFile(root), "utf8");
  assert.equal(text.endsWith("\n"), true);
  assert.equal(isTrustedVolumeOwnership(JSON.parse(text)), true);
});
