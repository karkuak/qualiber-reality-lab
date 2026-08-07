/**
 * The core-owned **container** sandbox supervisor (ERL2-OQ-008 gate 2,
 * ADR-ERL2-034).
 *
 * This module is never imported: the adapter host executes it as the direct
 * child of a synchronous `spawnSync`, exactly as it executes `sandboxLauncher`
 * for the local-process profile. It is the same shape of thing, supervising a
 * container instead of a process group, and it is deliberately just as dumb —
 * it never parses a frame, never inspects a request, and never decides anything
 * the host could decide instead. Every flag, mount, path and bound it applies
 * arrives in a host-authored spec file; it invents none of them.
 *
 * ## The deadline trap this is written against
 *
 * ADR-ERL2-017 §Evidence records a probe that reported `enforced: true` for a
 * deadline that bounded nothing. It had attached to the container and relied on
 * `spawnSync`'s timeout: that sends `SIGTERM` to the runtime CLI, the CLI
 * forwards it to PID 1, and PID 1 has no default signal handlers — so the
 * payload ignored it and the CLI sat out the container's full 600 seconds. The
 * probe had asked "did the CLI stop?" when the question was "did the container
 * stop?".
 *
 * The same trap is reachable here, so the same three defences apply:
 *
 *   - the run is launched **detached**, so nothing about this process's own
 *     signal handling is load-bearing;
 *   - the deadline `SIGKILL`s the **container**, by id, through the runtime;
 *   - real elapsed time is measured from arming the deadline to observing the
 *     container stopped, and a run that overran its own bound is reported as a
 *     control failure rather than an ordinary timeout.
 *
 * The report carries the measurement, never the conclusion alone: an offline
 * reader gets `deadline_span_ms` and can disagree with `deadline_enforced`.
 *
 * ## Identity
 *
 * The container is identified by the full 64-hex id read back from `create`,
 * before it has ever run. Not by name, which a later run could reuse, and not
 * by pid, which the kernel reuses — the `NC-PROCTREE` negative control failed
 * once on exactly that defect (fixed in `939d804`), and the fix does not
 * transfer for free just because the boundary is now a container.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Hash } from "@erl2/contracts";
import { SUPERVISOR_PREFIX, type SupervisorReport } from "./sandboxLauncher.js";

/** One bind mount the host asked for. */
export interface ContainerSupervisorMount {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly readOnly: boolean;
}

/**
 * Everything the supervisor is allowed to know, all of it host-authored.
 *
 * There is no field here the supervisor may default, infer or override. A spec
 * that does not say which image to run does not get a guess.
 */
export interface ContainerSupervisorSpec {
  readonly runtimeBinary: string;
  readonly imageReference: string;
  readonly imageDigest: Hash;
  /** Run-scoped, so `docker ps --filter name=<runId>` finds this invocation. */
  readonly containerName: string;
  readonly hardenedFlags: readonly string[];
  readonly mounts: readonly ContainerSupervisorMount[];
  readonly environment: Readonly<Record<string, string>>;
  /** Absolute path of the adapter entry **inside** the container. */
  readonly entryPath: string;
  /** Working directory inside the container; read-only by construction. */
  readonly workingDirectory: string;
  readonly deadlineMs: number;
  readonly maxResponseBytes: number;
  /** Host path of the pre-encoded request frames. */
  readonly inputPath: string;
}

/**
 * What the runtime was observed to report about the container after the run.
 *
 * Mirrors `sandbox-invocation-result/v1`'s `container_termination`, which is
 * where the host retains it.
 */
export interface ContainerTerminationObservation {
  readonly container_id: string;
  readonly image_digest: Hash;
  readonly namespace_processes_at_termination: number;
  readonly running_after_termination: boolean;
  readonly runtime_pid_after_termination: number;
  readonly removed: boolean;
  readonly residue_after_removal: boolean;
  readonly deadline_span_ms: number;
  readonly deadline_enforced: boolean;
  readonly oom_killed: boolean;
}

/** The supervisor report, extended with the container observation. */
export interface ContainerSupervisorReport extends SupervisorReport {
  readonly container_termination?: ContainerTerminationObservation;
}

/**
 * Refusal raised when the deadline did not actually bound the container.
 *
 * Not `ADAPTER_DEADLINE_EXCEEDED`: that says the adapter ran too long, which is
 * the adapter's problem. This says the profile's `wall-clock-deadline` control
 * did not hold, which is the Lab's problem and invalidates the control report.
 */
export const CONTAINER_DEADLINE_NOT_ENFORCED = "ADAPTER_SANDBOX_CONTROL_UNSUPPORTED";

/**
 * Slack between ordering the kill and observing the container stopped.
 *
 * Generous on purpose. It is not a performance budget — it is the line past
 * which "the deadline took effect" stops being a defensible reading of what was
 * measured, and 600 s of a 4 s deadline is the failure it exists to catch.
 */
const DEADLINE_ENFORCEMENT_GRACE_MS = 15_000;

/** Bound on every control-plane runtime call the supervisor makes. */
const CONTROL_CALL_TIMEOUT_MS = 20_000;

const STDERR_EXCERPT_BYTES = 4096;

interface ControlResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runContainerSupervisor(): void {
  const spec = JSON.parse(readFileSync(process.argv[2] as string, "utf8")) as ContainerSupervisorSpec;
  const started = Date.now();

  /** One bounded, shell-free control-plane call to the runtime. */
  const control = (args: readonly string[]): ControlResult => {
    const result = spawnSync(spec.runtimeBinary, [...args], {
      encoding: "utf8",
      timeout: CONTROL_CALL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      status: result.status,
      stdout: (result.stdout as string | null) ?? "",
      stderr: (result.stderr as string | null) ?? "",
    };
  };

  // Declared before the create step, not beside the stream handlers that use
  // them: `emit` closes over `stdout`, and the create-failure path below calls
  // `emit`. Declared later, that call reads a `let` in its temporal dead zone,
  // throws a `ReferenceError`, and the supervisor dies without writing its
  // report — so the one failure mode that most needs a diagnostic (a bad image,
  // an unmountable path) is the one that produces none.
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);

  // ---------------------------------------------------------------- create --
  // `create` rather than `run` so the container id exists before anything runs
  // in it. That is the identity every later observation is keyed on, and it is
  // obtained from the runtime rather than derived from a name the host chose.
  const createArgs: string[] = ["create", "--name", spec.containerName, "--interactive"];
  createArgs.push(...spec.hardenedFlags);
  createArgs.push("--workdir", spec.workingDirectory);
  for (const [name, value] of Object.entries(spec.environment)) {
    createArgs.push("--env", `${name}=${value}`);
  }
  for (const mount of spec.mounts) {
    createArgs.push("--volume", `${mount.hostPath}:${mount.containerPath}${mount.readOnly ? ":ro" : ""}`);
  }
  createArgs.push(spec.imageReference, "node", spec.entryPath);

  const created = control(createArgs);
  const containerId = /^[0-9a-f]{64}$/m.exec(created.stdout.trim())?.[0];
  if (created.status !== 0 || containerId === undefined) {
    // No container, so nothing to observe and nothing to clean up beyond a name
    // the runtime may have half-claimed.
    control(["rm", "--force", spec.containerName]);
    emit({
      outcome: "crashed",
      exit_status: null,
      termination_signal: null,
      process_tree_terminated: false,
      terminated_descendant_count: 0,
      stdout_bytes: 0,
      stderr_bytes: 0,
      wall_clock_ms: Date.now() - started,
      stderr_excerpt: `container create failed: ${`${created.stderr}${created.stdout}`.slice(0, 1800)}`,
    });
    return;
  }

  // ----------------------------------------------------------------- start --
  // Detached and attached at once: detached so this process's own group and
  // signal disposition are irrelevant to bounding the run, attached so the
  // adapter's frames flow over the CLI's stdio the way they do for a local
  // child. The CLI is a courier here; the container is what gets killed.
  const child = spawn(spec.runtimeBinary, ["start", "--attach", "--interactive", containerId], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let overflow = false;
  let timedOut = false;
  let killOrderedAt: number | undefined;
  let removedByKill = false;
  let namespaceProcessesAtTermination = 0;

  /**
   * Ends the container, observing what was running in it first.
   *
   * The order matters: `top` after the kill would list nothing whether or not
   * the kill worked, so the count is taken while the tree is still alive. That
   * count is the container analogue of `terminated_descendant_count` — the
   * processes in the pid namespace that the kill ended — and it is read from
   * the runtime rather than assumed to be one.
   *
   * `kill` can legitimately fail in two opposite situations: the container has
   * already exited, and the container has not finished starting. Only the
   * second would leave something running, so the fallback is `rm --force`,
   * which ends and forgets the container in one step whichever it was. That is
   * a *stronger* observation than "not running", and `finish` reads it as such.
   */
  const killContainer = (): void => {
    if (killOrderedAt !== undefined) return;
    killOrderedAt = Date.now();
    const top = control(["top", containerId, "-eo", "pid"]);
    if (top.status === 0) {
      namespaceProcessesAtTermination = top.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line)).length;
    }
    if (control(["kill", "--signal", "KILL", containerId]).status !== 0) {
      removedByKill = control(["rm", "--force", containerId]).status === 0;
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdout = Buffer.concat([stdout, chunk]);
    if (stdout.byteLength > spec.maxResponseBytes) {
      overflow = true;
      killContainer();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.byteLength < STDERR_EXCERPT_BYTES) {
      stderr = Buffer.concat([stderr, chunk]).subarray(0, STDERR_EXCERPT_BYTES);
    }
  });
  child.stdin.on("error", () => {
    /* the adapter may exit before reading; the exit path reports it */
  });

  // The deadline is armed once the container is startable, and it is measured
  // from here — the bound is on the container's run, not on how long the
  // runtime took to create it.
  const deadlineArmedAt = Date.now();
  const timer = setTimeout(() => {
    timedOut = true;
    killContainer();
  }, spec.deadlineMs);

  child.stdin.end(readFileSync(spec.inputPath));

  child.on("error", () => {
    clearTimeout(timer);
    finish("crashed", null, null);
  });

  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    const outcome = overflow
      ? "refused"
      : timedOut
        ? "timed_out"
        : code === 0
          ? "completed"
          : "crashed";
    finish(outcome, code, signal);
  });

  /**
   * Observes the container's final state, removes it, and reports.
   *
   * Every field of the observation is read back from the runtime after the
   * fact. Nothing is inferred from the fact that a kill was ordered: ordering a
   * kill and the container being gone are different claims, and only the second
   * is what `process_tree_terminated` means.
   */
  function finish(
    outcome: SupervisorReport["outcome"],
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    // Measured before the control-plane calls below, so runtime latency in
    // reading the state back is not billed to the deadline.
    const deadlineSpanMs = Date.now() - deadlineArmedAt;

    const inspected = control([
      "inspect",
      containerId as string,
      "--format",
      "{{.State.Running}} {{.State.Pid}} {{.State.OOMKilled}}",
    ]);
    // A container id the runtime no longer knows is not running — that is the
    // whole point of `rm --force`, and treating an unknown id as "might still
    // be running" would report a failure the observation contradicts.
    const known = inspected.status === 0;
    const [runningText, pidText, oomText] = inspected.stdout.trim().split(/\s+/);
    const running = known && runningText !== "false";
    const parsedPid = known ? Number.parseInt(pidText ?? "0", 10) : 0;
    const runtimePid = Number.isFinite(parsedPid) ? Math.max(0, parsedPid) : 0;

    const removal = known ? control(["rm", "--force", containerId as string]) : undefined;
    const residueCheck = control(["inspect", containerId as string, "--format", "{{.Id}}"]);

    // A bounded run is one that both stopped *and* stopped when it was told to.
    // A kill that took the container's whole run to take effect enforced
    // nothing, and reporting it as an ordinary timeout is precisely the
    // false attestation ADR-ERL2-017 recorded.
    const stopped = !running && runtimePid === 0;
    const deadlineEnforced =
      !timedOut || (stopped && deadlineSpanMs <= spec.deadlineMs + DEADLINE_ENFORCEMENT_GRACE_MS);

    const observation: ContainerTerminationObservation = {
      container_id: containerId as string,
      image_digest: spec.imageDigest,
      namespace_processes_at_termination: namespaceProcessesAtTermination,
      running_after_termination: running,
      runtime_pid_after_termination: runtimePid,
      removed: removal === undefined ? removedByKill : removal.status === 0,
      residue_after_removal: residueCheck.status === 0,
      deadline_span_ms: Math.max(0, Math.min(deadlineSpanMs, 3_600_000)),
      deadline_enforced: deadlineEnforced,
      oom_killed: (oomText ?? "false").trim() === "true",
    };

    const refusalCode = overflow
      ? "ADAPTER_RESPONSE_OVERSIZED"
      : deadlineEnforced
        ? undefined
        : CONTAINER_DEADLINE_NOT_ENFORCED;

    emit({
      outcome: refusalCode === undefined ? outcome : "refused",
      exit_status: code,
      termination_signal: signal,
      // The container analogue of process-tree termination: the kill was
      // ordered *and* the runtime now reports nothing running under that id.
      process_tree_terminated: killOrderedAt !== undefined && stopped,
      terminated_descendant_count: namespaceProcessesAtTermination,
      stdout_bytes: stdout.byteLength,
      stderr_bytes: stderr.byteLength,
      wall_clock_ms: Date.now() - started,
      ...(refusalCode === undefined ? {} : { refusal_code: refusalCode }),
      stderr_excerpt: stderr.toString("utf8").slice(0, 2048),
      container_termination: observation,
    });
  }

  function emit(payload: ContainerSupervisorReport): void {
    process.stdout.write(stdout.subarray(0, spec.maxResponseBytes));
    process.stderr.write(`${SUPERVISOR_PREFIX}${JSON.stringify(payload)}\n`);
    process.exitCode = 0;
  }
}

// Executed, never imported.
if (process.argv[1]?.endsWith("containerSupervisor.js") === true) runContainerSupervisor();
