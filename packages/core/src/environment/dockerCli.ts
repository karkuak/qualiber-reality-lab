/**
 * The Docker command seam (ERL2-OQ-005).
 *
 * One class, four rules, and nothing else:
 *
 *   1. **No shell.** `spawnSync` is called with an argv array and the default
 *      `shell: false`, so no argument is ever parsed by `/bin/sh`. A run id, a
 *      project name or an image digest that contained a metacharacter would be
 *      passed to Docker as one literal argument rather than becoming a command.
 *      This is the only way Docker is invoked anywhere in the Lab.
 *   2. **A curated environment.** The child receives exactly the variables
 *      Docker needs to find its daemon and its own configuration, plus the
 *      Compose interpolation variables the caller supplies. The Lab's own
 *      environment — vault paths, judge material, development profile flags — is
 *      not inherited.
 *   3. **Bounded.** Every invocation carries a timeout and an output bound, so a
 *      wedged daemon fails the operation rather than hanging the run.
 *   4. **No interpretation.** This module decides nothing. It returns the exit
 *      status and the streams; the driver decides what they mean.
 *
 * It is deliberately not a container abstraction. There is no `Container` type,
 * no lifecycle model and no runtime-agnostic seam: the Compose driver is one
 * concrete driver against one concrete substrate, and a second implementation of
 * this interface exists only so a test can observe the exact argv the driver
 * chose.
 */

import { spawnSync } from "node:child_process";
import { CODES, Erl2Error } from "@erl2/contracts";

export interface DockerInvocation {
  readonly args: readonly string[];
  /** Compose interpolation variables. Merged over the curated base environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface DockerResult {
  readonly args: readonly string[];
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * A result whose stdout is bytes rather than text.
 *
 * `stdout` on `DockerResult` is UTF-8 decoded, which is right for every command
 * that answers in text and destructive for one that answers in a tar stream:
 * decoding replaces invalid sequences with U+FFFD, so the archive no longer
 * parses and its bytes are no longer the bytes the daemon sent.
 */
export interface DockerBinaryResult {
  readonly args: readonly string[];
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** The seam. A test substitutes it to observe argv without a daemon. */
export interface DockerCli {
  run(invocation: DockerInvocation): DockerResult;
  /**
   * The same invocation, with stdout left as bytes.
   *
   * Exists for exactly one caller: `docker cp <container>:<path> -`, which the
   * trusted channel uses to read the archive's own entry-type metadata *before*
   * anything extracts or dereferences it. Optional so an existing test stub
   * that only models text commands keeps compiling; a caller that needs bytes
   * and finds it absent fails closed rather than falling back to a decoded read.
   */
  runBinary?(invocation: DockerInvocation): DockerBinaryResult;
}

/**
 * Host variables the Docker CLI itself needs.
 *
 * `HOME` is on the list because the CLI resolves `~/.docker/config.json` from
 * it; without it Docker cannot find its context or its registry configuration.
 * Nothing else about the Lab's environment crosses into the child.
 */
const DOCKER_ENVIRONMENT_PASSTHROUGH = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
] as const;

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export class SpawnDockerCli implements DockerCli {
  private readonly binary: string;

  constructor(binary = "docker") {
    this.binary = binary;
  }

  /** The curated child environment. Nothing else about the Lab crosses over. */
  private childEnvironment(invocation: DockerInvocation): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of DOCKER_ENVIRONMENT_PASSTHROUGH) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    for (const [name, value] of Object.entries(invocation.env ?? {})) env[name] = value;
    return env;
  }

  runBinary(invocation: DockerInvocation): DockerBinaryResult {
    // No `encoding`, so stdout stays a Buffer. stderr is decoded separately
    // because it is a diagnostic, not evidence.
    const result = spawnSync(this.binary, [...invocation.args], {
      shell: false,
      env: this.childEnvironment(invocation),
      timeout: invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Erl2Error(
        CODES.ENV_PROVISION_FAILED,
        `the ${this.binary} command is not available on this host; the Compose driver cannot reach a substrate`,
        { owner: "lab", cause: result.error },
      );
    }
    return {
      args: [...invocation.args],
      status: result.status ?? -1,
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
      stderr: result.stderr === undefined ? "" : String(result.stderr),
      timedOut: result.signal === "SIGTERM" && result.status === null,
    };
  }

  run(invocation: DockerInvocation): DockerResult {
    const env = this.childEnvironment(invocation);

    const result = spawnSync(this.binary, [...invocation.args], {
      encoding: "utf8",
      // Explicit, though it is also the default: the whole point of this module
      // is that no argument is ever shell-interpreted.
      shell: false,
      env,
      timeout: invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Erl2Error(
        CODES.ENV_PROVISION_FAILED,
        `the ${this.binary} command is not available on this host; the Compose driver cannot reach a substrate`,
        { owner: "lab", cause: result.error },
      );
    }
    return {
      args: [...invocation.args],
      status: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: result.signal === "SIGTERM" && result.status === null,
    };
  }
}

/** True when a Docker daemon is reachable. Used to skip — never to pass — real-driver tests. */
export function dockerAvailable(docker: DockerCli = new SpawnDockerCli()): boolean {
  try {
    return docker.run({ args: ["version", "--format", "{{.Server.Version}}"], timeoutMs: 20_000 }).status === 0;
  } catch {
    return false;
  }
}
