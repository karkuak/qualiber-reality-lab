/**
 * The deadline actually bounds a container, and the termination is observed
 * (ERL2-OQ-008 gate 2, ADR-ERL2-017 §Evidence, ADR-ERL2-034).
 *
 * ADR-ERL2-017 records a probe that reported `enforced: true` for a deadline
 * that bounded nothing: it killed the runtime CLI, the CLI forwarded SIGTERM to
 * PID 1, PID 1 had no handler, and the container ran its full 600 seconds. The
 * launcher is reachable by the identical mistake, and the subject it supervises
 * is a Node process that ignores SIGTERM exactly as `sleep` did.
 *
 * So the test is not "does a refusal come back". A refusal comes back either
 * way — after four seconds or after ten minutes. The test is on the
 * **measurement**: the container must be dead, its whole pid namespace with it,
 * and the elapsed time must be a small multiple of the bound the run asked for.
 *
 * The subject is `fixtures/sabotage/adapters/timeout.mjs`, which answers
 * nothing and forks a detached grandchild first, so the process-tree question
 * is a real one rather than a formality.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AdapterHost,
  CONTAINER_APP_ROOT,
  CONTAINER_DIAGNOSTICS_ROOT,
  CONTAINER_OUTPUT_ROOT,
  HARDENED_CONTAINER_RUN_FLAGS,
  SteppingClock,
  assertSandboxProfileEnabled,
  runtimeCliEnvironment,
  type ContainerSupervisorReport,
  type ContainerSupervisorSpec,
} from "@erl2/core";
import { Erl2Error } from "@erl2/contracts";
import { ArtifactStore } from "@erl2/integrity";
import {
  acquisitionRequest,
  adapterManifest,
  repoRoot,
  sabotageAdapterEntry,
} from "../support/adapterFixtures.js";
import { announceContainerSkip, containerProfile } from "../support/containerProfile.js";

const AT = "2026-08-06T00:00:00Z";
/** The run id the shared request fixtures embed; the host must match it. */
const RUN_ID = "01890000-0000-7000-8000-00000000000d";
const DEADLINE_MS = 4_000;
/**
 * The line past which the deadline did not bound the run.
 *
 * Generous — container teardown is several bounded control-plane calls — and
 * still two orders of magnitude below the 600 s the ADR-ERL2-017 defect took.
 */
const BOUND_MS = DEADLINE_MS + 30_000;

const supervisorPath = path.join(
  repoRoot,
  "packages",
  "core",
  "dist",
  "src",
  "adapter",
  "containerSupervisor.js",
);

test("CONTAINER-DEADLINE: a subject that ignores every signal is bounded by its deadline", (t) => {
  const profile = containerProfile();
  if (!profile.available) {
    announceContainerSkip(t, profile.reason);
    assert.throws(
      () => assertSandboxProfileEnabled("container"),
      (error: unknown) => error instanceof Erl2Error,
    );
    return;
  }

  const host = new AdapterHost({
    runId: RUN_ID,
    adapterManifest: adapterManifest({ adapterId: "sabotage-timeout", operations: ["acquire"] }),
    adapterEntryPath: sabotageAdapterEntry("timeout"),
    workspaceRoot: mkdtempSync(path.join(tmpdir(), "erl2-deadline-")),
    store: new ArtifactStore(mkdtempSync(path.join(tmpdir(), "erl2-deadline-store-"))),
    clock: new SteppingClock(AT, 1000),
    wallClockMs: DEADLINE_MS,
    profile: "container",
    containerActivation: profile.activation,
    containerAdapterPackage: {
      packageRoot: path.join(repoRoot, "fixtures", "sabotage", "adapters"),
      moduleDirectories: [],
    },
  });

  const startedAt = Date.now();
  assert.throws(
    () =>
      host.run({
        operation: "acquire",
        operationId: "deadline-1",
        request: acquisitionRequest("deadline-1"),
      }),
    (error: unknown) =>
      error instanceof Erl2Error && error.code === "ADAPTER_DEADLINE_EXCEEDED",
    "a container that never answers must be refused as a deadline breach",
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(
    elapsedMs <= BOUND_MS,
    `the deadline did not bound the run: ${String(elapsedMs)}ms elapsed against a ${String(DEADLINE_MS)}ms deadline. This is the ADR-ERL2-017 defect.`,
  );
});

test("CONTAINER-DEADLINE: termination is observed — the whole pid namespace, keyed on container id", (t) => {
  const profile = containerProfile();
  if (!profile.available) {
    announceContainerSkip(t, profile.reason);
    return;
  }

  // The supervisor is driven directly here, because the observation is what is
  // under test and the host raises a refusal that discards it. The spec is the
  // same shape the host writes.
  const root = mkdtempSync(path.join(tmpdir(), "erl2-supervisor-"));
  const outputDir = path.join(root, "output");
  const diagnosticsDir = path.join(root, "diagnostics");
  mkdirSync(outputDir);
  mkdirSync(diagnosticsDir);
  chmodSync(outputDir, 0o777);
  chmodSync(diagnosticsDir, 0o777);
  const inputPath = path.join(root, "request.frames");
  writeFileSync(inputPath, Buffer.alloc(0));

  const spec: ContainerSupervisorSpec = {
    runtimeBinary: profile.runtimeBinary,
    imageReference: profile.activation.lock.image_reference,
    imageDigest: profile.activation.lock.image_digest,
    containerName: `erl2-deadline-observation-${RUN_ID}`,
    hardenedFlags: [...HARDENED_CONTAINER_RUN_FLAGS],
    mounts: [
      {
        hostPath: path.join(repoRoot, "fixtures", "sabotage", "adapters"),
        containerPath: CONTAINER_APP_ROOT,
        readOnly: true,
      },
      { hostPath: outputDir, containerPath: CONTAINER_OUTPUT_ROOT, readOnly: false },
      { hostPath: diagnosticsDir, containerPath: CONTAINER_DIAGNOSTICS_ROOT, readOnly: false },
    ],
    environment: { ERL2_RUN_ID: RUN_ID },
    entryPath: `${CONTAINER_APP_ROOT}/timeout.mjs`,
    workingDirectory: CONTAINER_APP_ROOT,
    deadlineMs: DEADLINE_MS,
    maxResponseBytes: 1024 * 1024,
    inputPath,
  };
  const specPath = path.join(root, "container-spec.json");
  writeFileSync(specPath, JSON.stringify(spec));

  const spawned = spawnSync(process.execPath, [supervisorPath, specPath], {
    encoding: "utf8",
    env: runtimeCliEnvironment(),
    timeout: BOUND_MS + 60_000,
    killSignal: "SIGKILL",
  });
  const marker = "ERL2-SUPERVISOR ";
  const index = spawned.stderr.lastIndexOf(marker);
  assert.ok(index >= 0, `the supervisor reported nothing: ${spawned.stderr.slice(0, 800)}`);
  const report = JSON.parse(
    spawned.stderr.slice(index + marker.length).split("\n")[0] as string,
  ) as ContainerSupervisorReport;

  assert.equal(report.outcome, "timed_out");
  const observation = report.container_termination;
  assert.ok(observation !== undefined, "a container run must retain its termination observation");

  // Identity is the full container id, read from the runtime at create time.
  // Not a name, which a later run could reuse, and not a bare pid, which is the
  // defect NC-PROCTREE caught in the local supervisor (fixed in 939d804).
  assert.match(observation.container_id, /^[0-9a-f]{64}$/);
  assert.equal(observation.image_digest, profile.activation.lock.image_digest);

  // The tree, not just the entry point: `timeout.mjs` forks a detached
  // grandchild before hanging, and both were in the namespace when the kill
  // was ordered.
  assert.ok(
    observation.namespace_processes_at_termination >= 2,
    `expected the adapter and its grandchild in the namespace, saw ${String(observation.namespace_processes_at_termination)}`,
  );
  assert.equal(report.terminated_descendant_count, observation.namespace_processes_at_termination);

  // Termination is observed, not assumed from having ordered a kill.
  assert.equal(observation.running_after_termination, false);
  assert.equal(observation.runtime_pid_after_termination, 0);
  assert.equal(report.process_tree_terminated, true);

  // The measurement, and the verdict derived from it. Both are retained, so a
  // reader can disagree with the second by reading the first.
  assert.equal(observation.deadline_enforced, true);
  assert.ok(
    observation.deadline_span_ms <= BOUND_MS,
    `the deadline took ${String(observation.deadline_span_ms)}ms to take effect against a ${String(DEADLINE_MS)}ms bound`,
  );
  assert.ok(observation.deadline_span_ms >= DEADLINE_MS - 500, "the kill fired before its deadline");

  // Teardown left nothing behind, checked against the runtime rather than
  // against what teardown reported.
  assert.equal(observation.removed, true);
  assert.equal(observation.residue_after_removal, false);
  const residue = spawnSync(
    profile.runtimeBinary,
    ["ps", "-a", "--format", "{{.Names}}", "--filter", `name=${RUN_ID}`],
    { encoding: "utf8" },
  );
  assert.equal((residue.stdout ?? "").trim(), "", "a bounded run must leave no container behind");
});
