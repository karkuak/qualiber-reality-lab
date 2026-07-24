/**
 * The container-runtime seam used by the isolation enforcement probes
 * (ERL2-OQ-008, ADR-ERL2-016).
 *
 * The probes need to *observe* a real runtime enforcing a control, so they need
 * to execute one.  They reach it only through this narrow, closed interface —
 * never through free-form command text — for the same reason
 * `AdapterCapabilityId` is a closed enum: there is nothing to sanitise if there
 * is nothing to pass.  A caller supplies an argument vector; no shell is
 * involved on the host side, so host-side injection is unreachable by
 * construction.
 *
 * The seam also makes the *refusal* paths testable.  A fake runtime can report
 * that a control did not hold, or that the runtime is absent, and the
 * qualification procedure must then refuse — which is a property we want proven
 * without depending on a particular host's misconfiguration.
 */

import { spawnSync } from "node:child_process";
import { CODES, Erl2Error } from "@erl2/contracts";

export interface RuntimeInvocation {
  /** Argument vector passed directly to the runtime binary; never a shell string. */
  readonly args: readonly string[];
  /** Hard host-side deadline. A probe that cannot finish is inconclusive, not passing. */
  readonly timeoutMs?: number;
  /** Bound on captured output, so a hostile image cannot flood the harness. */
  readonly maxOutputBytes?: number;
}

export interface RuntimeResult {
  /** `null` when the process was killed by a signal or the deadline. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the host-side deadline, not the process, ended the run. */
  readonly timedOut: boolean;
  /** True when captured output hit `maxOutputBytes` and was cut. */
  readonly truncated: boolean;
}

export interface ContainerRuntime {
  /** Stable identifier of the runtime binary, e.g. its basename. */
  readonly runtimeId: string;
  /** Runs the runtime with an argument vector and returns its bounded result. */
  invoke(invocation: RuntimeInvocation): RuntimeResult;
  /** True when the runtime binary exists and its daemon answers. */
  available(): boolean;
}

/**
 * The only environment the runtime CLI receives, beyond `PATH`.
 *
 * These name *which daemon* to talk to and where its client configuration
 * lives. Nothing here carries a credential, and nothing here is passed into a
 * container: the probes assert separately that the operator's home directory is
 * unreachable from inside one.
 */
const RUNTIME_ENVIRONMENT_ALLOWLIST: readonly string[] = [
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "XDG_RUNTIME_DIR",
  "CONTAINER_HOST",
];

const DEFAULT_TIMEOUT_MS = 60_000;
/** Diagnostics bound; the `bounded-diagnostics` control is probed against it. */
export const DEFAULT_PROBE_OUTPUT_BYTES = 64 * 1024;

/**
 * A `ContainerRuntime` backed by a runtime CLI on this host.
 *
 * It shells out with `spawnSync` and an explicit argument vector, inherits no
 * environment beyond an explicit allowlist, and always bounds both wall clock
 * and captured bytes.
 */
export class CliContainerRuntime implements ContainerRuntime {
  readonly runtimeId: string;
  private readonly binary: string;

  constructor(options: { readonly binary: string; readonly runtimeId?: string }) {
    this.binary = options.binary;
    this.runtimeId = options.runtimeId ?? options.binary;
  }

  invoke(invocation: RuntimeInvocation): RuntimeResult {
    const maxBytes = invocation.maxOutputBytes ?? DEFAULT_PROBE_OUTPUT_BYTES;
    const result = spawnSync(this.binary, [...invocation.args], {
      timeout: invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      encoding: "buffer",
      // The harness passes an explicit allowlist rather than the operator's
      // whole environment: passing it would be the ambient authority the
      // probes exist to check for, but passing *nothing* would silently
      // retarget the CLI at whatever default endpoint it can find, so the
      // evidence would describe a different daemon than the operator's.
      env: RUNTIME_ENVIRONMENT_ALLOWLIST.reduce<Record<string, string>>((env, name) => {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
        return env;
      }, { PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin" }),
      maxBuffer: maxBytes * 4,
      // SIGTERM is not a bound. A runtime CLI attached to a container forwards
      // SIGTERM to PID 1, and PID 1 has no default signal handlers, so a
      // `sleep` running as PID 1 ignores it and the CLI waits for the container
      // to exit on its own — turning a 4-second deadline into a 10-minute one.
      // SIGKILL actually ends the harness's own process; bounding the
      // *container* is a separate, explicit step the deadline probe performs.
      killSignal: "SIGKILL",
    });
    const cut = (buffer: Buffer | null): { text: string; truncated: boolean } => {
      if (!buffer) return { text: "", truncated: false };
      if (buffer.byteLength <= maxBytes) return { text: buffer.toString("utf8"), truncated: false };
      return { text: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
    };
    const out = cut(result.stdout as Buffer | null);
    const err = cut(result.stderr as Buffer | null);
    // Only the harness's own deadline counts as a timeout. Matching on any
    // termination signal would report an ordinary `docker kill` from another
    // probe as a deadline hit.
    const timedOut =
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
      result.signal === "SIGKILL";
    return {
      exitCode: result.status,
      stdout: out.text,
      stderr: err.text,
      timedOut,
      truncated: out.truncated || err.truncated,
    };
  }

  available(): boolean {
    try {
      const probe = this.invoke({ args: ["version", "--format", "{{.Server.Version}}"], timeoutMs: 15_000 });
      return probe.exitCode === 0 && probe.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }
}

/**
 * Refuses to proceed when the runtime is not answering.
 *
 * An unavailable runtime is *inconclusive*, never passing: a probe that could
 * not run has established nothing, and ADR-ERL2-016 requires that to fail
 * qualification rather than be silently skipped.
 */
export function assertRuntimeAvailable(runtime: ContainerRuntime): void {
  if (!runtime.available()) {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `container runtime ${runtime.runtimeId} is not available on this host; isolation probes are inconclusive and the profile stays disabled_no_qualified_adapter_substrate`,
      { owner: "lab" },
    );
  }
}
