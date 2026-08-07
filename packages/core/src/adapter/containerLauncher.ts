/**
 * The host side of the container-backed launcher (ERL2-OQ-008 gate 2,
 * ADR-ERL2-034).
 *
 * `containerSupervisor.ts` is the thing that runs; this is what the host needs
 * in order to hand it a spec it can execute without deciding anything:
 *
 *   - **is a launcher available at all?** — observed, by running the adapter
 *     runtime inside the locked image and watching it answer. Gate 2 existed
 *     precisely because a substrate can be fully qualified and still be unable
 *     to host the adapter protocol: the alpine image ADR-ERL2-017 qualified has
 *     no Node runtime, so twenty observed controls sat behind a profile that
 *     could not start anything. "The daemon is up" is not the question.
 *   - **what does the adapter need mounted?** — the module closure it declares,
 *     resolved to real directories, so the container can be handed those and
 *     nothing else. Mounting the repository root would have been one line and
 *     would have put the vault, truth, judge and selection roots inside the
 *     namespace that a probe had just proven could not reach them.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { CODES, Erl2Error } from "@erl2/contracts";
import {
  CONTAINER_NUMERIC_USER,
  HARDENED_CONTAINER_RUN_FLAGS,
} from "./containerHardening.js";
import type { ContainerRuntime } from "./containerRuntime.js";

/** Whether this host can actually start an adapter inside the locked image. */
export interface ContainerLauncherAvailability {
  readonly available: boolean;
  readonly runtimeId: string;
  readonly runtimeBinary: string;
  readonly imageReference: string;
  /** What the runtime reported when asked to run the adapter runtime. */
  readonly observedRuntimeVersion?: string;
  readonly reason?: string;
}

/** Wall-clock bound for the availability observation. */
const AVAILABILITY_TIMEOUT_MS = 60_000;

/**
 * Observes whether an adapter could be started inside the locked image.
 *
 * The observation is a real hardened container executing `node --version` in
 * the locked image. Not `docker version`, not "the image exists", not a
 * declared field in a manifest: the question is whether the *adapter protocol*
 * can be hosted there, and the only honest way to answer it is to host
 * something and watch it answer back.
 *
 * A negative answer is a normal outcome, not an error. It is what this function
 * returns on a host with no daemon, and it is what keeps the profile refused.
 */
export function probeContainerLauncher(input: {
  readonly runtime: ContainerRuntime;
  readonly runtimeBinary: string;
  readonly imageReference: string;
}): ContainerLauncherAvailability {
  const base = {
    runtimeId: input.runtime.runtimeId,
    runtimeBinary: input.runtimeBinary,
    imageReference: input.imageReference,
  };
  if (!input.runtime.available()) {
    return { ...base, available: false, reason: "CONTAINER_RUNTIME_UNAVAILABLE" };
  }
  const observed = input.runtime.invoke({
    args: [
      "run",
      "--rm",
      ...HARDENED_CONTAINER_RUN_FLAGS,
      input.imageReference,
      "node",
      "--version",
    ],
    timeoutMs: AVAILABILITY_TIMEOUT_MS,
  });
  const version = observed.stdout.trim();
  if (observed.exitCode !== 0 || !/^v\d+\.\d+\.\d+/.test(version)) {
    return {
      ...base,
      available: false,
      reason: "LOCKED_IMAGE_CANNOT_HOST_THE_ADAPTER_PROTOCOL",
    };
  }
  return { ...base, available: true, observedRuntimeVersion: version };
}

/** One directory that must appear under the container's `node_modules`. */
export interface AdapterModuleDirectory {
  /** Bare specifier, e.g. `ajv` or `@erl2/contracts`. */
  readonly name: string;
  /** Real host directory, with workspace symlinks already resolved. */
  readonly hostPath: string;
}

/**
 * Resolves the module closure an adapter package declares.
 *
 * The graph walked is the **declared** dependency graph — each package's
 * `dependencies`, transitively — resolved the way the runtime resolves it, by
 * walking `node_modules` upward from the dependent. An import the adapter never
 * declared is therefore absent from the container and fails loudly there, which
 * is the fail-closed direction: the alternative is a launcher that guesses, and
 * a guess that happens to be right is indistinguishable from a guess that
 * happens to expose something.
 *
 * Workspace links are resolved with `realpath`, because a symlink into the
 * repository is not something a bind mount can follow.
 */
export function resolveAdapterModuleClosure(
  packageRoot: string,
): readonly AdapterModuleDirectory[] {
  const resolved = new Map<string, string>();
  const visit = (fromDirectory: string): void => {
    const manifestPath = path.join(fromDirectory, "package.json");
    if (!existsSync(manifestPath)) return;
    let dependencies: Record<string, string>;
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      dependencies = parsed.dependencies ?? {};
    } catch (cause) {
      throw new Erl2Error(
        CODES.ADAPTER_EXECUTION_FAULT,
        `adapter package manifest ${manifestPath} is unreadable: ${String(cause).slice(0, 200)}`,
        { owner: "lab" },
      );
    }
    for (const name of Object.keys(dependencies).sort()) {
      if (resolved.has(name)) continue;
      const directory = findPackageDirectory(fromDirectory, name);
      if (directory === undefined) {
        throw new Erl2Error(
          CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
          `the container profile cannot start this adapter: its declared dependency ${name} does not resolve from ${fromDirectory}, so the module closure cannot be mounted`,
          { owner: "lab" },
        );
      }
      resolved.set(name, directory);
      visit(directory);
    }
  };
  visit(path.resolve(packageRoot));
  return [...resolved.entries()]
    .map(([name, hostPath]) => ({ name, hostPath }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The runtime's own resolution algorithm: `node_modules`, walking upward. */
function findPackageDirectory(from: string, name: string): string | undefined {
  let directory = path.resolve(from);
  for (;;) {
    const candidate = path.join(directory, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * A run-scoped container name.
 *
 * Embeds the run id so `docker ps --filter name=<runId>` finds every container
 * an invocation created — the same `run-scoped-resource-identity` and
 * `teardown-and-residue-inspection` properties the probe suite observes. The
 * name is a *label*, never an identity: the supervisor keys every observation
 * on the container id the runtime hands back at create time.
 */
export function containerInvocationName(runId: string, invocationId: string): string {
  const safe = (value: string): string => value.replaceAll(/[^A-Za-z0-9_.-]/g, "-").slice(0, 40);
  return `erl2-adapter-${safe(invocationId)}-${safe(runId)}`;
}

/** The numeric user every adapter container runs as, for reporting. */
export const CONTAINER_ADAPTER_USER = CONTAINER_NUMERIC_USER;
