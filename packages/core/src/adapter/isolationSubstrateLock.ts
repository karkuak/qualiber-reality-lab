/**
 * The immutable isolation substrate lock and its drift check (ERL2-OQ-008,
 * ADR-ERL2-016 decision 3).
 *
 * This is deliberately a **different** contract from
 * `erl2:environment#/$defs/SubstrateLockV1`.  That lock answers ERL2-OQ-005 —
 * "is the Compose *environment* substrate admissible?" — and its
 * `qualification_status` enum names that gate by identifier.  Reusing it here
 * would mean resolving one open question implicitly resolved the other, which
 * is precisely the kind of silent coupling the open-questions register exists
 * to prevent.
 *
 * The lock pins what a later run will actually execute:
 *
 *   - runtime identity and version;
 *   - platform, architecture and kernel;
 *   - an image **digest**, never a tag;
 *   - hashes of the runtime configuration that affects enforcement;
 *   - the probe suite's own digest, so a weakened suite invalidates the lock;
 *   - the required security profile (seccomp, cgroup version, default runtime);
 *   - any policy inputs that change what the runtime enforces.
 *
 * `assertObservedMatchesIsolationLock` compares the *currently observed* state
 * to the lock before every qualified run.  Drift invalidates qualification
 * before a subject executes, because enforcement observed last week against a
 * runtime that has since been upgraded is not evidence about today's runtime.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type Hash,
  type Instant,
  type IsolationSubstrateLockV1,
} from "@erl2/contracts";
import { coreHash, sealSigned, type SigningKey } from "@erl2/integrity";
import { assertRuntimeAvailable, type ContainerRuntime } from "./containerRuntime.js";

/** Runtime facts a probe run observes, and the lock pins. */
export interface ObservedSubstrateState {
  readonly runtimeId: string;
  readonly runtimeVersion: string;
  readonly platform: string;
  readonly architecture: string;
  readonly kernelVersion: string;
  readonly imageReference: string;
  readonly imageDigest: Hash;
  readonly seccomp: string;
  readonly cgroupVersion: "1" | "2";
  readonly defaultRuntime: string;
  readonly apparmor?: string;
  readonly selinux?: string;
  /**
   * Hashes of the runtime configuration and policy inputs currently in effect.
   * These are pinned by the lock and re-observed at drift time; the lock's
   * arrays are derived from these (single source), and drift compares them
   * exactly (review §11.5 — previously the diff omitted both arrays).
   */
  readonly runtimeConfigurationHashes: readonly Hash[];
  readonly policyInputHashes: readonly Hash[];
}

const FIELD_SEPARATOR = "";

/**
 * Reads the runtime's own report of its identity, platform and security
 * profile, plus the resolved digest of the pinned image reference.
 *
 * The image reference must already be digest-pinned: resolving a *tag* here
 * would record whatever the tag pointed at during discovery, which is exactly
 * the mutable-substrate failure mode the lock exists to close.
 */
export function discoverSubstrate(options: {
  readonly runtime: ContainerRuntime;
  readonly imageReference: string;
  /**
   * The runtime configuration and policy input hashes the caller currently
   * computes from the in-effect configuration.  They are not read from the
   * runtime binary — they are the hashes the lock will pin and drift will
   * re-compare — so the caller supplies them to assemble the complete observed
   * substrate state.
   */
  readonly runtimeConfigurationHashes: readonly Hash[];
  readonly policyInputHashes: readonly Hash[];
}): ObservedSubstrateState {
  assertRuntimeAvailable(options.runtime);
  const format = [
    "{{.Server.Version}}",
    "{{.Server.Os}}",
    "{{.Server.Arch}}",
    "{{.Server.KernelVersion}}",
  ].join(FIELD_SEPARATOR);
  const version = options.runtime.invoke({ args: ["version", "--format", format] });
  if (version.exitCode !== 0) {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `could not read runtime identity from ${options.runtime.runtimeId}`,
      { owner: "lab" },
    );
  }
  const [runtimeVersion, platform, architecture, kernelVersion] = version.stdout
    .trim()
    .split(FIELD_SEPARATOR);

  const infoFormat = [
    "{{json .SecurityOptions}}",
    "{{.CgroupVersion}}",
    "{{.DefaultRuntime}}",
  ].join(FIELD_SEPARATOR);
  const info = options.runtime.invoke({ args: ["info", "--format", infoFormat] });
  if (info.exitCode !== 0) {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `could not read runtime security profile from ${options.runtime.runtimeId}`,
      { owner: "lab" },
    );
  }
  const [securityOptions, cgroupVersion, defaultRuntime] = info.stdout.trim().split(FIELD_SEPARATOR);
  const security = parseSecurityOptions(securityOptions ?? "[]");

  const digest = resolveImageDigest(options.runtime, options.imageReference);

  if (cgroupVersion !== "1" && cgroupVersion !== "2") {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `runtime reported an unrecognised cgroup version ${String(cgroupVersion)}`,
      { owner: "lab" },
    );
  }

  return {
    runtimeId: options.runtime.runtimeId,
    runtimeVersion: nonEmpty(runtimeVersion, "runtime version"),
    platform: nonEmpty(platform, "platform"),
    architecture: nonEmpty(architecture, "architecture"),
    kernelVersion: nonEmpty(kernelVersion, "kernel version"),
    imageReference: options.imageReference,
    imageDigest: digest,
    seccomp: security.seccomp,
    cgroupVersion,
    defaultRuntime: nonEmpty(defaultRuntime, "default runtime"),
    ...(security.apparmor === undefined ? {} : { apparmor: security.apparmor }),
    ...(security.selinux === undefined ? {} : { selinux: security.selinux }),
    runtimeConfigurationHashes: [...options.runtimeConfigurationHashes],
    policyInputHashes: [...options.policyInputHashes],
  };
}

function nonEmpty(value: string | undefined, what: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `runtime did not report its ${what}; an unidentified runtime cannot be pinned`,
      { owner: "lab" },
    );
  }
  return value.trim();
}

function parseSecurityOptions(json: string): {
  readonly seccomp: string;
  readonly apparmor?: string;
  readonly selinux?: string;
} {
  let entries: string[] = [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) entries = parsed.filter((e): e is string => typeof e === "string");
  } catch {
    entries = [];
  }
  const find = (name: string): string | undefined => {
    const entry = entries.find((e) => e.startsWith(`name=${name}`));
    if (entry === undefined) return undefined;
    const profile = /profile=([^,]+)/.exec(entry);
    return profile?.[1] ?? name;
  };
  const seccomp = find("seccomp");
  if (seccomp === undefined) {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      "the runtime reports no seccomp profile; a substrate without seccomp cannot satisfy the required security profile",
      { owner: "lab" },
    );
  }
  return {
    seccomp,
    ...(find("apparmor") === undefined ? {} : { apparmor: find("apparmor") as string }),
    ...(find("selinux") === undefined ? {} : { selinux: find("selinux") as string }),
  };
}

/**
 * Resolves a *digest-pinned* image reference to the digest it names.
 *
 * A reference without an `@sha256:` digest is refused outright rather than
 * resolved: resolving it would silently convert a mutable tag into a lock and
 * defeat the whole mechanism.
 */
export function resolveImageDigest(runtime: ContainerRuntime, reference: string): Hash {
  const pinned = /@(sha256:[0-9a-f]{64})$/.exec(reference);
  if (!pinned) {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `image reference ${reference} is not digest-pinned; a tag can move, so it cannot lock a substrate`,
      { owner: "lab" },
    );
  }
  const digest = pinned[1] as Hash;
  // Resolve by **content digest**, not by the `repository@digest` name.
  //
  // The name form is what a lock must not depend on, and on at least one
  // runtime it is also unreliable: `docker image inspect alpine@sha256:...`
  // and `docker image inspect alpine:3.22` both fail intermittently against a
  // containerd-backed image store while the bare digest resolves every time.
  // Falling back the other way — trusting the name when the digest fails —
  // would be the weakening; this is the strengthening.
  const byDigest = runtime.invoke({ args: ["image", "inspect", digest, "--format", "{{.Id}}"] });
  if (byDigest.exitCode === 0 && byDigest.stdout.trim().length > 0) return digest;

  const byReference = runtime.invoke({
    args: ["image", "inspect", reference, "--format", "{{.Id}}"],
  });
  if (byReference.exitCode !== 0) {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `the pinned image ${reference} is not present locally by digest ${digest}; probes must run against the exact locked bytes`,
      { owner: "lab" },
    );
  }
  return digest;
}

export interface BuildIsolationLockInput {
  readonly lockId: string;
  readonly profile: "container" | "disposable_vm";
  readonly observed: ObservedSubstrateState;
  readonly probeSuiteId: string;
  readonly probeSuiteDigest: Hash;
  readonly recordedAt: Instant;
  readonly signingKey: SigningKey;
}

/**
 * Freezes the lock from observed state.
 *
 * `pinned` is a schema constant `true` — the artifact *is* the pin, so there is
 * no representable "unpinned lock" whose presence could be mistaken for one.
 * The honest representation of "no substrate pinned" is the absence of this
 * artifact, which `qualifyIsolationProfile` already reports as
 * `SUBSTRATE_LOCK_NOT_PINNED`.
 */
export function buildIsolationSubstrateLock(
  input: BuildIsolationLockInput,
): IsolationSubstrateLockV1 {
  const body = {
    schema_version: "isolation-substrate-lock/v1" as const,
    lock_id: input.lockId,
    profile: input.profile,
    runtime_id: input.observed.runtimeId,
    runtime_version: input.observed.runtimeVersion,
    platform: input.observed.platform,
    architecture: input.observed.architecture,
    kernel_version: input.observed.kernelVersion,
    image_reference: input.observed.imageReference,
    image_digest: input.observed.imageDigest,
    runtime_configuration_hashes: [...input.observed.runtimeConfigurationHashes],
    required_security_profile: {
      seccomp: input.observed.seccomp,
      cgroup_version: input.observed.cgroupVersion,
      default_runtime: input.observed.defaultRuntime,
      ...(input.observed.apparmor === undefined ? {} : { apparmor: input.observed.apparmor }),
      ...(input.observed.selinux === undefined ? {} : { selinux: input.observed.selinux }),
    },
    probe_suite_id: input.probeSuiteId,
    probe_suite_digest: input.probeSuiteDigest,
    policy_input_hashes: [...input.observed.policyInputHashes],
    pinned: true as const,
    recorded_at: input.recordedAt,
  };
  return assertContract<IsolationSubstrateLockV1>(
    "IsolationSubstrateLockV1",
    sealSigned(body, input.signingKey),
  );
}

/** A single field whose observed value diverged from the lock. */
export interface SubstrateDrift {
  readonly field: string;
  readonly locked: string;
  readonly observed: string;
}

/**
 * Compares currently observed runtime state to the lock.
 *
 * Every pinned field is compared, including the image digest and the security
 * profile.  Any divergence is drift, and drift invalidates qualification
 * *before* the subject executes — an upgraded engine, a re-pushed image or a
 * changed seccomp profile is a different substrate, whatever the lock says.
 */
export function diffObservedAgainstIsolationLock(
  lock: IsolationSubstrateLockV1,
  observed: ObservedSubstrateState,
): readonly SubstrateDrift[] {
  const drift: SubstrateDrift[] = [];
  const compare = (field: string, locked: string, seen: string): void => {
    if (locked !== seen) drift.push({ field, locked, observed: seen });
  };
  compare("runtime_id", lock.runtime_id, observed.runtimeId);
  compare("runtime_version", lock.runtime_version, observed.runtimeVersion);
  compare("platform", lock.platform, observed.platform);
  compare("architecture", lock.architecture, observed.architecture);
  compare("kernel_version", lock.kernel_version, observed.kernelVersion);
  compare("image_reference", lock.image_reference, observed.imageReference);
  compare("image_digest", lock.image_digest, observed.imageDigest);
  compare("required_security_profile.seccomp", lock.required_security_profile.seccomp, observed.seccomp);
  compare(
    "required_security_profile.cgroup_version",
    lock.required_security_profile.cgroup_version,
    observed.cgroupVersion,
  );
  compare(
    "required_security_profile.default_runtime",
    lock.required_security_profile.default_runtime,
    observed.defaultRuntime,
  );
  compare(
    "required_security_profile.apparmor",
    lock.required_security_profile.apparmor ?? "absent",
    observed.apparmor ?? "absent",
  );
  compare(
    "required_security_profile.selinux",
    lock.required_security_profile.selinux ?? "absent",
    observed.selinux ?? "absent",
  );
  // The runtime-configuration and policy-input hash arrays are pinned fields too
  // (§11.5). Order is not semantically relevant, so each is compared as an exact
  // set: an extra or missing hash on either side is drift.
  compareHashSet("runtime_configuration_hashes", lock.runtime_configuration_hashes, observed.runtimeConfigurationHashes, drift);
  compareHashSet("policy_input_hashes", lock.policy_input_hashes, observed.policyInputHashes, drift);
  return drift;
}

/** Exact-set comparison of two hash arrays, reporting extra/missing as drift. */
function compareHashSet(
  field: string,
  locked: readonly Hash[],
  observed: readonly Hash[],
  drift: SubstrateDrift[],
): void {
  const lockedSet = new Set(locked);
  const observedSet = new Set(observed);
  for (const h of observedSet) {
    if (!lockedSet.has(h)) drift.push({ field, locked: "<absent>", observed: h });
  }
  for (const h of lockedSet) {
    if (!observedSet.has(h)) drift.push({ field, locked: h, observed: "<absent>" });
  }
}

/** Refuses a drifted substrate before any subject may execute. */
export function assertObservedMatchesIsolationLock(
  lock: IsolationSubstrateLockV1,
  observed: ObservedSubstrateState,
): void {
  const drift = diffObservedAgainstIsolationLock(lock, observed);
  if (drift.length > 0) {
    throw new Erl2Error(
      CODES.ENV_ISOLATION_SUBSTRATE_DRIFT,
      `isolation substrate drifted from its lock: ${drift
        .map((d) => `${d.field} locked=${d.locked} observed=${d.observed}`)
        .join("; ")}`,
      { owner: "lab" },
    );
  }
}

/**
 * Refuses a lock whose probe suite is not the one about to run.
 *
 * A lock that pinned a twenty-control suite cannot license a verdict produced
 * by a suite that has since dropped a control; the digest comparison makes that
 * a refusal rather than a review question.
 */
export function assertProbeSuiteMatchesLock(
  lock: IsolationSubstrateLockV1,
  suiteId: string,
  suiteDigest: Hash,
): void {
  if (lock.probe_suite_id !== suiteId || lock.probe_suite_digest !== suiteDigest) {
    throw new Erl2Error(
      CODES.ENV_ISOLATION_SUBSTRATE_DRIFT,
      `the lock pins probe suite ${lock.probe_suite_id}@${lock.probe_suite_digest}, but ${suiteId}@${suiteDigest} was run`,
      { owner: "lab" },
    );
  }
}

/** Digest of the runtime configuration inputs that affect enforcement. */
export function runtimeConfigurationHash(configuration: unknown): Hash {
  return coreHash({ isolation_runtime_configuration: configuration });
}
