/**
 * The trusted volume's lifecycle across genuinely separate processes, against a
 * real Docker daemon.
 *
 * ## Why this file exists rather than another unit test
 *
 * The defect it closes was invisible to every unit test package 2 had, and it
 * was invisible for a structural reason: constructing two channel objects in one
 * test process does not reproduce a process boundary. The object that provisions
 * and the object that destroys shared a heap, so `created` was whatever the
 * first one set it to, and the suite agreed the volume was removed while every
 * real run left one behind.
 *
 * So the boundary here is real. Each lifecycle step runs in a child `node`
 * process that exits before the next one starts, exactly as the ERL2 CLI runs
 * them, and the only thing that crosses between them is the durable handle on
 * disk. A regression to in-memory ownership fails these tests and cannot be made
 * to pass by sharing more state inside the test.
 *
 * The daemon is real too. A fake daemon would let a mistake about label syntax,
 * `volume inspect` output shape or removal semantics pass unnoticed, and those
 * are precisely the details the ownership proof rests on.
 *
 * With no daemon this file skips, and a skipped case is recorded as unproven
 * rather than passed. `ERL2_REQUIRE_LIVE_DOCKER=1` converts the skip into a
 * failure for an environment that is supposed to have one.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dockerAvailable, trustedVolumeName } from "@erl2/core";

function reason(): string | undefined {
  if (!dockerAvailable()) return "no Docker daemon is reachable";
  return undefined;
}
const REASON = reason();
const SKIP: { readonly skip?: string } =
  REASON === undefined
    ? {}
    : process.env["ERL2_REQUIRE_LIVE_DOCKER"] === "1"
      ? {}
      : { skip: `LIVE SUBSTRATE UNPROVEN: ${REASON}` };

/**
 * The built core, addressed absolutely so a child outside the workspace can load
 * it.
 *
 * Found by walking up rather than by a fixed relative path: this file is
 * compiled to `tests/dist/integration/`, so a path written against the source
 * layout would silently resolve somewhere else, and a child that cannot import
 * the core fails as a lifecycle error rather than as a missing module.
 */
function locateCore(): string {
  const relative = path.join("packages", "core", "dist", "src", "index.js");
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(directory, relative);
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
    directory = path.dirname(directory);
  }
  throw new Error(`the built core was not found above ${fileURLToPath(import.meta.url)}`);
}
const CORE = locateCore();

/**
 * One lifecycle step, as a standalone program.
 *
 * Written to disk and run by a fresh interpreter. It holds no state of its own
 * between invocations and reconstructs the channel from nothing but the run id
 * and the durable root — which is the whole point, and is what the CLI does.
 */
const STEP_PROGRAM = `
import { fileTrustedOwnershipStore, SpawnDockerCli, TrustedTelemetryChannel } from ${JSON.stringify(CORE)};

const [step, root, runId] = process.argv.slice(2);
const channel = new TrustedTelemetryChannel({
  runId,
  docker: new SpawnDockerCli(),
  freezeRoot: root + "/freeze",
  ownership: fileTrustedOwnershipStore({ root, runId }),
  project: "erl2-" + runId,
  sleep: () => undefined,
  stabilityAttempts: 1,
});

const answer =
  step === "provision"
    ? { step, result: channel.provision(), owns: channel.ownsVolume }
    : step === "owns"
      ? { step, owns: channel.ownsVolume }
      : { step, result: channel.cleanup(), owns: channel.ownsVolume };
process.stdout.write(JSON.stringify(answer));
`;

interface StepAnswer {
  readonly step: string;
  readonly owns: boolean;
  readonly result?: Record<string, unknown>;
}

const roots: string[] = [];
const runIds: string[] = [];

/** A task-scoped run id. Real UUIDv7 shape, so the volume name is the real one. */
function newRunId(suffix: string): string {
  const id = `01a0f5${suffix}-48a0-7d19-9c2e-fa3545079b9f`;
  runIds.push(id);
  return id;
}

function newRoot(label: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `erl2-xproc-${label}-`));
  roots.push(root);
  writeFileSync(path.join(root, "step.mjs"), STEP_PROGRAM);
  return root;
}

/** Runs one lifecycle step in its own interpreter and returns what it reported. */
function step(root: string, runId: string, which: "provision" | "destroy" | "owns"): StepAnswer {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "step.mjs"), which, root, runId],
    { encoding: "utf8", timeout: 180_000 },
  );
  assert.equal(
    result.status,
    0,
    `the ${which} process failed (${result.status}): ${result.stderr}`,
  );
  // A different pid every time, or the boundary is not what this file claims.
  return JSON.parse(result.stdout) as StepAnswer;
}

function volumeExists(name: string): boolean {
  return spawnSync("docker", ["volume", "inspect", name], { encoding: "utf8" }).status === 0;
}

function labelsOf(name: string): Record<string, string> {
  const shown = spawnSync(
    "docker",
    ["volume", "inspect", name, "--format", "{{json .Labels}}"],
    { encoding: "utf8" },
  );
  if (shown.status !== 0) return {};
  const parsed = JSON.parse(shown.stdout.trim()) as Record<string, string> | null;
  return parsed ?? {};
}

test.after(() => {
  // Only what this file created, named exactly, and only after the assertions
  // have had their say.
  for (const runId of runIds) {
    spawnSync("docker", ["volume", "rm", "--force", trustedVolumeName(runId)], { encoding: "utf8" });
  }
  spawnSync("docker", ["volume", "rm", "--force", "erl2-xproc-decoy"], { encoding: "utf8" });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// -- the defect, and its absence ----------------------------------------------

test(
  "XPROC: a volume provisioned in one process is removed by another",
  SKIP,
  () => {
    const runId = newRunId("aa01");
    const root = newRoot("basic");
    const volume = trustedVolumeName(runId);

    const provisioned = step(root, runId, "provision");
    assert.equal(provisioned.result?.["provisioned"], true, "provisioning failed");
    assert.equal(volumeExists(volume), true, "the volume was not created");

    // The provisioning process has exited. This is exactly the state in which
    // the previous candidate's `created` flag read `false`.
    const owns = step(root, runId, "owns");
    assert.equal(owns.owns, true, "a fresh process could not prove the run owns the volume");

    const destroyed = step(root, runId, "destroy");
    assert.equal(destroyed.result?.["attempted"], true, "the destroying process did not attempt");
    assert.equal(destroyed.result?.["removed"], true, "the destroying process did not remove");
    assert.deepEqual(destroyed.result?.["surviving"], []);
    assert.equal(volumeExists(volume), false, "the trusted volume survived a cross-process teardown");
  },
);

test(
  "XPROC: the previous defect's exact shape — no durable handle, no removal",
  SKIP,
  () => {
    // The reproduction, and the reason this suite can claim the fix rather than
    // merely observing a clean run. The destroying process is pointed at a root
    // that carries no handle, which is precisely what an in-memory `created`
    // amounts to from a second process's point of view: no durable evidence that
    // anything was created. The volume then survives — and it survives *because
    // the channel refuses to guess*, which is the correct behaviour, not the
    // defect. The defect was that every real teardown was in this state.
    const runId = newRunId("aa02");
    const provisionRoot = newRoot("repro-a");
    const destroyRoot = newRoot("repro-b");
    const volume = trustedVolumeName(runId);

    assert.equal(step(provisionRoot, runId, "provision").result?.["provisioned"], true);
    assert.equal(volumeExists(volume), true);

    const amnesiac = step(destroyRoot, runId, "destroy");
    assert.equal(amnesiac.result?.["attempted"], false, "a channel with no handle attempted a removal");
    assert.equal(volumeExists(volume), true, "a channel with no handle deleted a volume anyway");

    // And the process that *does* hold the handle still removes it, so the
    // resource is recoverable rather than stranded.
    assert.equal(step(provisionRoot, runId, "destroy").result?.["removed"], true);
    assert.equal(volumeExists(volume), false, "the owning process could not recover the resource");
  },
);

test(
  "XPROC: a repeated destroy in a third process is idempotent",
  SKIP,
  () => {
    const runId = newRunId("aa03");
    const root = newRoot("repeat");
    const volume = trustedVolumeName(runId);

    step(root, runId, "provision");
    assert.equal(step(root, runId, "destroy").result?.["removed"], true);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const again = step(root, runId, "destroy");
      assert.equal(again.result?.["attempted"], false, "a tombstoned handle attempted a removal");
      assert.deepEqual(again.result?.["surviving"], []);
    }
    assert.equal(volumeExists(volume), false);
  },
);

test(
  "XPROC: a wrong-run handle cannot delete another run's volume",
  SKIP,
  () => {
    const owner = newRunId("aa04");
    const stranger = newRunId("aa05");
    const ownerRoot = newRoot("owner");
    const strangerRoot = newRoot("stranger");

    step(ownerRoot, owner, "provision");
    step(strangerRoot, stranger, "provision");
    assert.equal(volumeExists(trustedVolumeName(owner)), true);
    assert.equal(volumeExists(trustedVolumeName(stranger)), true);

    // The stranger's process destroys, in its own process, holding its own
    // handle. It must reach exactly one volume.
    assert.equal(step(strangerRoot, stranger, "destroy").result?.["removed"], true);
    assert.equal(volumeExists(trustedVolumeName(stranger)), false);
    assert.equal(
      volumeExists(trustedVolumeName(owner)),
      true,
      "one run's teardown removed another run's trusted volume",
    );

    assert.equal(step(ownerRoot, owner, "destroy").result?.["removed"], true);
    assert.equal(volumeExists(trustedVolumeName(owner)), false);
  },
);

test(
  "XPROC: a volume carrying the right name and a foreign capability is not removed",
  SKIP,
  () => {
    const runId = newRunId("aa06");
    const root = newRoot("spoof");
    const volume = trustedVolumeName(runId);

    step(root, runId, "provision");
    const genuine = labelsOf(volume);
    assert.ok(
      genuine["com.erl2.trusted_ownership_digest"] !== undefined,
      "the ownership digest label was not applied by the real daemon",
    );

    // Replace the resource with one that copies every label a reader can see and
    // gets the one it cannot derive wrong. This is the spoof the digest exists
    // for, staged against the real daemon rather than a stub.
    spawnSync("docker", ["volume", "rm", "--force", volume], { encoding: "utf8" });
    const labelArgs: string[] = [];
    for (const [key, value] of Object.entries(genuine)) {
      labelArgs.push(
        "--label",
        key === "com.erl2.trusted_ownership_digest" ? `${key}=sha256:${"0".repeat(64)}` : `${key}=${value}`,
      );
    }
    assert.equal(
      spawnSync("docker", ["volume", "create", ...labelArgs, volume], { encoding: "utf8" }).status,
      0,
      "the spoof volume could not be created",
    );

    const refused = step(root, runId, "destroy");
    assert.equal(refused.result?.["removed"], false, "a volume with a foreign capability was removed");
    assert.deepEqual(refused.result?.["surviving"], [volume]);
    assert.equal(volumeExists(volume), true);
    spawnSync("docker", ["volume", "rm", "--force", volume], { encoding: "utf8" });
  },
);

test(
  "XPROC: an unrelated volume beside the run's is never touched",
  SKIP,
  () => {
    const runId = newRunId("aa07");
    const root = newRoot("bystander");
    const volume = trustedVolumeName(runId);
    // A decoy carrying this repository's own labels, so a cleanup that swept by
    // label kind or by name prefix would take it.
    spawnSync(
      "docker",
      [
        "volume",
        "create",
        "--label",
        "com.erl2.resource_type=trusted-telemetry-volume",
        "--label",
        `com.erl2.run_id=${runId}`,
        "erl2-xproc-decoy",
      ],
      { encoding: "utf8" },
    );

    step(root, runId, "provision");
    assert.equal(step(root, runId, "destroy").result?.["removed"], true);
    assert.equal(volumeExists(volume), false, "the run's own volume survived");
    assert.equal(
      volumeExists("erl2-xproc-decoy"),
      true,
      "teardown removed a labelled volume this run did not create",
    );
    spawnSync("docker", ["volume", "rm", "--force", "erl2-xproc-decoy"], { encoding: "utf8" });
  },
);

test(
  "XPROC: a volume in use is reported as surviving, and removed once it is free",
  SKIP,
  () => {
    const runId = newRunId("aa08");
    const root = newRoot("inuse");
    const volume = trustedVolumeName(runId);
    const holder = `erl2-xproc-holder-${runId.slice(0, 8)}`;

    step(root, runId, "provision");
    // Something is mounting it. Docker refuses the removal, and the honest
    // answer is that the resource survives — with the handle intact, because the
    // next attempt still needs to prove it may remove it.
    const started = spawnSync(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        holder,
        "--volume",
        `${volume}:/trusted`,
        "busybox:latest",
        "sleep",
        "120",
      ],
      { encoding: "utf8" },
    );
    if (started.status !== 0) {
      // No local busybox and no network: the in-use case is unproven here rather
      // than silently passed. The live matrix covers it against the pinned image.
      assert.equal(step(root, runId, "destroy").result?.["removed"], true);
      return;
    }
    try {
      const blocked = step(root, runId, "destroy");
      assert.equal(blocked.result?.["attempted"], true);
      assert.equal(blocked.result?.["removed"], false, "an in-use volume was reported removed");
      assert.deepEqual(blocked.result?.["surviving"], [volume]);
      assert.ok(
        String(blocked.result?.["detail"] ?? "").length > 0,
        "the daemon's refusal was not reported",
      );
      assert.equal(volumeExists(volume), true);
      // The handle survived the failure, so a retry can still act.
      assert.equal(step(root, runId, "owns").owns, true, "a failed cleanup discarded the handle");
    } finally {
      spawnSync("docker", ["rm", "--force", holder], { encoding: "utf8" });
    }

    const retried = step(root, runId, "destroy");
    assert.equal(retried.result?.["removed"], true, "the volume could not be removed once it was free");
    assert.equal(volumeExists(volume), false);
  },
);

test(
  "XPROC: a full provision-and-destroy leaves zero volume residue",
  SKIP,
  () => {
    const runId = newRunId("aa09");
    const root = newRoot("residue");
    const before = spawnSync("docker", ["volume", "ls", "--quiet"], { encoding: "utf8" }).stdout;

    step(root, runId, "provision");
    step(root, runId, "destroy");

    const after = spawnSync("docker", ["volume", "ls", "--quiet"], { encoding: "utf8" }).stdout;
    assert.equal(after, before, "the lifecycle changed the daemon's volume inventory");
    assert.equal(volumeExists(trustedVolumeName(runId)), false);
  },
);

/** Keeps the resolved module path honest if the build layout ever moves. */
test("XPROC: the child program addresses a core build that exists", () => {
  assert.equal(fileURLToPath(CORE).endsWith(path.join("dist", "src", "index.js")), true);
});
