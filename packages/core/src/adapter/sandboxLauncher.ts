/**
 * The core-owned **local-process** sandbox supervisor.
 *
 * Its *runtime* is never imported — the adapter host executes it as the direct
 * child of a synchronous `spawnSync`, and the guard at the bottom of this file
 * is what keeps that true. The host and `containerSupervisor.ts` do read
 * `SUPERVISOR_PREFIX` and `SupervisorReport` from here, because both supervisors
 * speak the same one-line report protocol and there must be exactly one
 * definition of it.
 *
 * It launches the adapter
 * **detached, in its own process group**. That indirection is what makes
 * process-*tree* termination real — killing the negative pid reaches every
 * descendant the adapter forked, so a subject that spawns a helper cannot
 * outlive its deadline.
 *
 * The supervisor is deliberately tiny and has no Lab authority. It:
 *
 *   - forwards the host's frames to the adapter's stdin verbatim;
 *   - copies the adapter's stdout to its own stdout verbatim, capping it;
 *   - captures and truncates the adapter's stderr;
 *   - kills the process group on deadline or response overflow;
 *   - emits exactly one `ERL2-SUPERVISOR <json>` line on stderr describing the
 *     outcome.
 *
 * It never parses a frame, never inspects a request, and never decides
 * anything the host could decide instead.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export interface SupervisorReport {
  readonly outcome: "completed" | "timed_out" | "crashed" | "refused";
  readonly exit_status: number | null;
  readonly termination_signal: string | null;
  readonly process_tree_terminated: boolean;
  readonly terminated_descendant_count: number;
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
  readonly wall_clock_ms: number;
  readonly refusal_code?: string;
  readonly stderr_excerpt: string;
}

export const SUPERVISOR_PREFIX = "ERL2-SUPERVISOR ";

const STDERR_EXCERPT_BYTES = 4096;

function runSupervisor(): void {
  const entryPath = process.argv[2] as string;
  const deadlineMs = Number.parseInt(process.argv[3] as string, 10);
  const maxResponseBytes = Number.parseInt(process.argv[4] as string, 10);
  const inputPath = process.argv[5] as string;

  const started = Date.now();
  const child = spawn(process.execPath, [entryPath], {
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group: the deadline kill reaches the whole tree.
    detached: process.platform !== "win32",
    env: process.env,
    cwd: process.cwd(),
  });

  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let overflow = false;
  let timedOut = false;
  let treeTerminated = false;
  let descendants = 0;

  const killTree = (): void => {
    treeTerminated = true;
    try {
      if (process.platform === "win32" || child.pid === undefined) {
        if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
      descendants = 1;
    } catch {
      try {
        if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
        descendants = 1;
      } catch {
        descendants = 0;
      }
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdout = Buffer.concat([stdout, chunk]);
    if (stdout.byteLength > maxResponseBytes) {
      overflow = true;
      killTree();
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

  const timer = setTimeout(() => {
    timedOut = true;
    killTree();
  }, deadlineMs);

  child.stdin.end(readFileSync(inputPath));

  child.on("error", () => {
    clearTimeout(timer);
    report("crashed", null, null);
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
    report(outcome, code, signal);
  });

  function report(
    outcome: SupervisorReport["outcome"],
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const payload: SupervisorReport = {
      outcome,
      exit_status: code,
      termination_signal: signal,
      process_tree_terminated: treeTerminated,
      terminated_descendant_count: descendants,
      stdout_bytes: stdout.byteLength,
      stderr_bytes: stderr.byteLength,
      wall_clock_ms: Date.now() - started,
      ...(overflow ? { refusal_code: "ADAPTER_RESPONSE_OVERSIZED" } : {}),
      stderr_excerpt: stderr.toString("utf8").slice(0, 2048),
    };
    process.stdout.write(stdout.subarray(0, maxResponseBytes));
    process.stderr.write(`${SUPERVISOR_PREFIX}${JSON.stringify(payload)}\n`);
    process.exitCode = 0;
  }
}

// Executed, never imported.
if (process.argv[1]?.endsWith("sandboxLauncher.js") === true) runSupervisor();
