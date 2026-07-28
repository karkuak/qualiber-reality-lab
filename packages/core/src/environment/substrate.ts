/**
 * Durable substrate state for a driver whose substrate is not a real one.
 *
 * A Compose or Kubernetes driver rediscovers what it provisioned by asking the
 * substrate. The fake driver has no substrate to ask, so until now it held its
 * resources, instance identity and applied mutations in a `Map` on the instance
 * — which is correct for an in-process contract suite and wrong for the CLI,
 * where `provision`, `restore` and `destroy` are three separate processes. A
 * `destroy` in a fresh process saw an empty resource set and reported a clean
 * teardown over resources it had never looked at.
 *
 * This is that substrate, as a file. It is deliberately **not** an ERL2
 * contract: it carries no `schema_version` and no `core_hash`, so neither the
 * artifact index nor the offline verifier can mistake substrate state for
 * evidence. It lives under its own root, outside the run root, for the same
 * reason a Compose project lives outside the run root: the environment is the
 * thing being observed, never part of the observation.
 *
 * Only the driver reads or writes it. Nothing in the lifecycle, the finalizer or
 * the verifier knows this file exists.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseStrictJson, type EnvironmentResourceV1, type Hash } from "@erl2/contracts";

/** Everything a driver must remember about one run's environment. */
export interface SubstrateState {
  readonly resources: readonly EnvironmentResourceV1[];
  readonly instanceHash?: Hash;
  readonly mutations: readonly string[];
}

/** The seam a driver uses to remember its substrate across processes. */
export interface SubstrateStore {
  load(runId: string): SubstrateState | undefined;
  save(runId: string, state: SubstrateState): void;
}

/** A substrate that lives only in this process; the pre-6.5-B behaviour. */
export class MemorySubstrateStore implements SubstrateStore {
  private readonly states = new Map<string, SubstrateState>();

  load(runId: string): SubstrateState | undefined {
    return this.states.get(runId);
  }

  save(runId: string, state: SubstrateState): void {
    this.states.set(runId, state);
  }
}

/**
 * A substrate that survives process death, published with the same
 * temp-then-rename discipline the artifact store uses so a crash mid-write
 * leaves the previous state rather than a truncated one.
 */
export class FileSubstrateStore implements SubstrateStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private file(runId: string): string {
    // The run id is a UUID, but it arrives from a flag, so it is encoded rather
    // than interpolated: a substrate path can never escape its own root.
    return path.join(this.root, `${Buffer.from(runId, "utf8").toString("base64url")}.substrate.json`);
  }

  load(runId: string): SubstrateState | undefined {
    let text: string;
    try {
      text = readFileSync(this.file(runId), "utf8");
    } catch {
      return undefined;
    }
    const value = parseStrictJson(text) as Partial<SubstrateState>;
    return {
      resources: Array.isArray(value.resources) ? value.resources : [],
      ...(typeof value.instanceHash === "string" ? { instanceHash: value.instanceHash } : {}),
      mutations: Array.isArray(value.mutations) ? value.mutations : [],
    };
  }

  save(runId: string, state: SubstrateState): void {
    const absolute = this.file(runId);
    const temp = `${absolute}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temp, absolute);
  }
}
