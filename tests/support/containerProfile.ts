/**
 * Shared setup for tests that need the real container profile
 * (ERL2-OQ-008 gate 2, ADR-ERL2-034).
 *
 * The ordinary gate must never require a container daemon, and a test that
 * quietly passes when it could not run is worse than no test — it reads as
 * coverage. So every container-dependent test takes one of two branches:
 *
 *   - the profile derives on this host, and the test runs for real; or
 *   - it does not, and the test says so out loud *and asserts the fail-closed
 *     behaviour instead*. A skipped branch that asserts nothing is a hole; a
 *     skipped branch that asserts the refusal is still measuring something.
 *
 * `containerProfile()` never throws. Every reason it can be unavailable — no
 * retained evidence, no daemon, a drifted substrate, an image that cannot host
 * the adapter protocol — is a normal state of some host, and the caller needs
 * the reason, not a stack trace.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import {
  CliContainerRuntime,
  containerRuntimeConfigurationInput,
  deriveContainerProfileActivation,
  discoverSubstrate,
  probeContainerLauncher,
  resolveAdapterModuleClosure,
  runtimeConfigurationHash,
  type AdapterModuleDirectory,
  type ContainerProfileActivation,
} from "@erl2/core";
import {
  assertContract,
  parseStrictJson,
  type IsolationEnforcementProbeResultV1,
  type IsolationSubstrateLockV1,
} from "@erl2/contracts";
import { repoRoot } from "./adapterFixtures.js";

/** Where a qualification run publishes its evidence. */
export const isolationEvidenceDir = path.join(repoRoot, "environments", "isolation");

export type ContainerProfileFixture =
  | {
      readonly available: true;
      readonly activation: ContainerProfileActivation;
      readonly lock: IsolationSubstrateLockV1;
      readonly probeResults: readonly IsolationEnforcementProbeResultV1[];
      readonly runtimeBinary: string;
    }
  | { readonly available: false; readonly reason: string };

let cached: ContainerProfileFixture | undefined;

/** The retained substrate lock, or `undefined` on a host that never qualified. */
export function retainedIsolationLock(): IsolationSubstrateLockV1 | undefined {
  const lockPath = path.join(isolationEvidenceDir, "substrate-lock.json");
  if (!existsSync(lockPath)) return undefined;
  return assertContract<IsolationSubstrateLockV1>(
    "IsolationSubstrateLockV1",
    parseStrictJson(readFileSync(lockPath, "utf8")),
  );
}

/** The retained probe results, in the order doctor reads them. */
export function retainedProbeResults(): readonly IsolationEnforcementProbeResultV1[] {
  const probesDir = path.join(isolationEvidenceDir, "probes");
  if (!existsSync(probesDir)) return [];
  return readdirSync(probesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) =>
      assertContract<IsolationEnforcementProbeResultV1>(
        "IsolationEnforcementProbeResultV1",
        parseStrictJson(readFileSync(path.join(probesDir, f), "utf8")),
      ),
    );
}

/**
 * Derives the container profile for this host, exactly as production does.
 *
 * Cached because the derivation starts a container to observe the launcher, and
 * a test file with a dozen cases should pay for that once.
 */
export function containerProfile(): ContainerProfileFixture {
  if (cached !== undefined) return cached;
  cached = derive();
  return cached;
}

function derive(): ContainerProfileFixture {
  const lock = retainedIsolationLock();
  if (lock === undefined) {
    return { available: false, reason: "no retained substrate lock (SUBSTRATE_LOCK_NOT_PINNED)" };
  }
  const probeResults = retainedProbeResults();
  const runtimeBinary = process.env["ERL2_ISOLATION_RUNTIME"] ?? "docker";
  const runtime = new CliContainerRuntime({ binary: runtimeBinary, runtimeId: lock.runtime_id });
  try {
    const observed = discoverSubstrate({
      runtime,
      imageReference: lock.image_reference,
      runtimeConfigurationHashes: [runtimeConfigurationHash(containerRuntimeConfigurationInput())],
      policyInputHashes: [runtimeConfigurationHash({ egress: "deny-by-default" })],
    });
    const launcher = probeContainerLauncher({
      runtime,
      runtimeBinary,
      imageReference: lock.image_reference,
    });
    const activation = deriveContainerProfileActivation({
      lock,
      observed,
      probeResults,
      launcher,
      subjectTrust: "trusted_reference",
    });
    return { available: true, activation, lock, probeResults, runtimeBinary };
  } catch (cause) {
    return {
      available: false,
      reason: cause instanceof Error ? cause.message.slice(0, 400) : "unknown derivation failure",
    };
  }
}

/**
 * Announces a skipped container branch on stderr as well as in the TAP stream.
 *
 * `t.diagnostic` alone is easy to miss in a spec reporter with three hundred
 * passing lines, and the whole point is that nobody should mistake "the daemon
 * was down" for "the container profile was tested".
 */
export function announceContainerSkip(t: TestContext, reason: string): void {
  const message = `CONTAINER PROFILE NOT EXERCISED: ${reason}`;
  t.diagnostic(message);
  process.stderr.write(`\n  !! ${message}\n     (the fail-closed refusal is asserted instead)\n`);
}

/** The adapter package root and resolved closure a container run needs. */
export function containerAdapterPackage(adapterDirectory: string): {
  readonly packageRoot: string;
  readonly moduleDirectories: readonly AdapterModuleDirectory[];
} {
  const packageRoot = path.join(repoRoot, adapterDirectory);
  return { packageRoot, moduleDirectories: resolveAdapterModuleClosure(packageRoot) };
}
