/**
 * Sandbox profiles and the honest control report (design v2 §21,
 * implementation plan §11.1).
 *
 * The rule this module exists to obey: **do not claim a control that is not
 * actually enforced here.** A same-user child process is a real process
 * boundary, and the host really does terminate its process tree, cap its
 * frames, control its environment and adjudicate every capability, credential
 * and egress it declares. It does *not* get a read-only root filesystem, a
 * dropped capability set, a seccomp profile, a PID/memory/CPU cgroup, a network
 * namespace, or a mount table it cannot escape — those need a container
 * runtime.
 *
 * So the profile reports two different kinds of thing under two different
 * names:
 *
 *   - *adjudicated* controls, which the host decides and receipts (capability
 *     denial, egress policy, mount tamper detection). These are enforced.
 *   - *prevented* controls, which the kernel would have to enforce. On the
 *     process profile these are `unsupported_on_this_host` with a reason, and
 *     the certification receipt copies that list verbatim so no downstream
 *     claim can quietly upgrade it.
 *
 * The `container` profile is where the second group can become `enforced`, and
 * the condition is severe: each entry flips only because an enforcement probe
 * *observed* that control holding on the digest-pinned substrate the launcher
 * is about to use, under the same flag vector the launcher applies
 * (`containerHardening.ts`). Nothing here is switched on by a flag, an option
 * or a manifest field — see `deriveContainerProfileActivation`.
 */

import {
  CODES,
  Erl2Error,
  type Hash,
  type IsolationEnforcementProbeResultV1,
  type IsolationSubstrateLockV1,
  type SandboxControlId,
  type SandboxInvocationManifestV1,
  type SandboxInvocationManifestV2,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";
import type { ContainerLauncherAvailability } from "./containerLauncher.js";
import { REQUIRED_ISOLATION_CONTROLS } from "./isolationQualification.js";
import { assertQualifiedForExecution } from "./isolationQualificationReport.js";
import type { ObservedSubstrateState } from "./isolationSubstrateLock.js";

export type SandboxProfileId = "local-process" | "container";

/** Subject trust classes, as ADR-ERL2-016 defines them. */
export type SubjectTrust = "trusted_reference" | "opaque_private" | "third_party";

export interface SandboxControlReport {
  readonly control_id: SandboxControlId;
  readonly state: "enforced" | "unsupported_on_this_host";
  readonly reason_code?: string;
}

/** Controls the local-process host genuinely enforces. */
const PROCESS_ENFORCED: readonly SandboxControlId[] = [
  "separate-process",
  "process-tree-termination",
  "wall-clock-deadline",
  "bounded-request-bytes",
  "bounded-response-bytes",
  "writable-output-only",
  "environment-variable-allowlist",
  "bounded-diagnostics",
  "input-mount-tamper-detection",
  "egress-policy-adjudication",
  "docker-socket-capability-denied",
  "privileged-capability-denied",
];

/** Controls that need a container runtime, with the reason each is absent. */
const PROCESS_UNSUPPORTED: readonly (readonly [SandboxControlId, string])[] = [
  ["read-only-input-mounts", "NO_CONTAINER_RUNTIME_MOUNT_ENFORCEMENT"],
  ["no-ambient-home-directory", "PROCESS_PROFILE_SHARES_USER_FILESYSTEM"],
  ["no-docker-socket", "PROCESS_PROFILE_SHARES_HOST_SOCKETS"],
  ["deny-by-default-egress", "PROCESS_PROFILE_CANNOT_BLOCK_SOCKETS"],
  ["numeric-non-root-user", "NO_CONTAINER_RUNTIME_USER_MAPPING"],
  ["read-only-root-filesystem", "NO_CONTAINER_RUNTIME"],
  ["capability-drop-all", "NO_CONTAINER_RUNTIME"],
  ["no-new-privileges", "NO_CONTAINER_RUNTIME"],
  ["seccomp-default-profile", "NO_CONTAINER_RUNTIME"],
  ["pid-limit", "NO_CONTAINER_RUNTIME"],
  ["memory-limit", "NO_CONTAINER_RUNTIME"],
  ["cpu-limit", "NO_CONTAINER_RUNTIME"],
  ["network-namespace-isolation", "NO_CONTAINER_RUNTIME"],
];

/**
 * The container profile's state **when nothing has been derived for this host**.
 *
 * The reason has now changed twice, and being exact about it is the whole
 * discipline. ADR-ERL2-016 said `disabled_no_qualified_adapter_substrate`, which
 * stopped being true when a substrate qualified. ADR-ERL2-017 said
 * `disabled_no_container_adapter_launcher_pending_erl2_oq_008`, which stops
 * being true here: `containerSupervisor.ts` is a launcher, and it can start an
 * adapter inside a qualified substrate.
 *
 * What is still true is that neither of those facts is a property of *this
 * process*. A launcher existing in the source tree says nothing about whether a
 * runtime is answering, whether the locked image is present, or whether the
 * twenty controls were observed on the host that is about to execute something.
 * So the profile is refused until those are derived from evidence, by
 * `deriveContainerProfileActivation`, on the host that will run the adapter.
 *
 * A refusal that cites a reason which has become untrue is the first step
 * toward the refusal being removed as obsolete — that is ADR-ERL2-017's own
 * argument, and it applies to its own state string.
 */
export const CONTAINER_PROFILE_STATE =
  "disabled_until_container_substrate_qualification_derived_on_this_host" as const;

/** The state a profile reaches only by derivation, never by declaration. */
export const CONTAINER_PROFILE_ENABLED_STATE =
  "enabled_container_substrate_qualified_and_launcher_available" as const;

/**
 * The thirteen controls the `local-process` profile honestly cannot enforce,
 * each paired with the isolation control whose probe would have to observe it.
 *
 * The two enums use the same names, and the pairing is asserted rather than
 * assumed: if `SandboxControlId` gained a kernel-prevented member that no probe
 * covers, `assertControlProofsAreProbed` fails at module load rather than
 * letting the container profile report a control nothing measured.
 */
const CONTAINER_CONTROL_PROOFS: readonly SandboxControlId[] = PROCESS_UNSUPPORTED.map(
  ([control_id]) => control_id,
);

(function assertControlProofsAreProbed(): void {
  const probed = new Set<string>(REQUIRED_ISOLATION_CONTROLS);
  const unproven = CONTAINER_CONTROL_PROOFS.filter((c) => !probed.has(c));
  if (unproven.length > 0) {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `the container profile would report ${unproven.join(", ")} with no enforcement probe behind it`,
      { owner: "lab" },
    );
  }
})();

/**
 * Permission to use the container profile on this host.
 *
 * It carries **evidence, not conclusions**, and that is the whole design. An
 * earlier shape stored `observedControls`, `imageDigest` and `substrateLockHash`
 * as fields; because this is a structural type, anyone could write the object
 * literal and the profile would open. Every derived value is now computed from
 * the lock and the probe results on each use, so hand-writing an activation
 * means supplying a real signed lock and twenty real probe results bound to it
 * — which is the evidence, not a claim about it. Same argument as
 * `IsolationQualificationReportV1`: the admission check re-derives rather than
 * reads, so a hand-written verdict grants nothing.
 *
 * `state` is therefore a label, not the permission. `assertSandboxProfileEnabled`
 * re-runs every gate on every call.
 */
export interface ContainerProfileActivation {
  readonly state: typeof CONTAINER_PROFILE_ENABLED_STATE;
  readonly lock: IsolationSubstrateLockV1;
  readonly observed: ObservedSubstrateState;
  readonly probeResults: readonly IsolationEnforcementProbeResultV1[];
  readonly launcher: ContainerLauncherAvailability;
  readonly subjectTrust: SubjectTrust;
}

/** The core hash of the lock whose evidence licenses this activation. */
export function containerSubstrateLockHash(activation: ContainerProfileActivation): Hash {
  return coreHash(activation.lock);
}

/**
 * The kernel-prevented controls this activation's probe results observed.
 *
 * Computed from the probe bytes on every call, per control. `assertQualified`
 * below has already refused anything short of twenty observed controls, so this
 * cannot legitimately come up short — which is exactly why it is computed
 * rather than stored: if it ever does, the report says so instead of claiming a
 * control on the strength of an aggregate verdict.
 */
export function containerObservedControls(
  activation: ContainerProfileActivation,
): readonly SandboxControlId[] {
  const byControl = new Map(
    activation.probeResults.map((result) => [result.control_id as string, result]),
  );
  return CONTAINER_CONTROL_PROOFS.filter((control) => {
    const probe = byControl.get(control);
    return probe !== undefined && probe.evidence === "observed" && probe.enforced;
  });
}

/**
 * The four gates, in order, all refusals rather than warnings.
 *
 *  1. **Substrate.** `assertQualifiedForExecution` re-compares the observed
 *     runtime against the lock (`ENV_ISOLATION_SUBSTRATE_DRIFT`), re-checks the
 *     probe suite digest, re-binds every probe result to this lock, and
 *     re-derives the verdict rather than reading a stored one.
 *  2. **Launcher.** Observed by starting the adapter runtime inside the locked
 *     image. Gate 2 is a separate question from gate 1 and stays one.
 *  3. **Subject trust.** ADR-ERL2-016 §5 gates the profile on trust, and
 *     ADR-ERL2-017 re-affirmed it. ERL2-OQ-008 is still open, so an
 *     `opaque_private` or `third_party` subject is refused *even here* — a
 *     qualified substrate with a working launcher is still not authenticated
 *     evidence, and authentication is the gate those subjects wait on.
 */
function assertQualified(input: {
  readonly lock: IsolationSubstrateLockV1;
  readonly observed: ObservedSubstrateState;
  readonly probeResults: readonly IsolationEnforcementProbeResultV1[];
  readonly launcher: ContainerLauncherAvailability;
  readonly subjectTrust: SubjectTrust;
}): void {
  assertQualifiedForExecution({
    profile: "container",
    lock: input.lock,
    observed: input.observed,
    probeResults: input.probeResults,
  });

  if (!input.launcher.available) {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `sandbox profile container is ${CONTAINER_PROFILE_STATE}: the substrate qualifies but no adapter could be started inside it (${input.launcher.reason ?? "launcher unavailable"}). It cannot be silently downgraded to local-process.`,
      { owner: "lab" },
    );
  }

  if (input.subjectTrust !== "trusted_reference") {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `a ${input.subjectTrust} subject may not run under the container profile: ERL2-OQ-008 is open_substrate_qualified_launcher_available_authentication_missing, and the retained qualification evidence is locally_observed_unauthenticated. Only a trusted_reference subject may use this profile.`,
      { owner: "lab" },
    );
  }
}

/** Derives whether the container profile may be used, from evidence only. */
export function deriveContainerProfileActivation(input: {
  readonly lock: IsolationSubstrateLockV1;
  readonly observed: ObservedSubstrateState;
  readonly probeResults: readonly IsolationEnforcementProbeResultV1[];
  readonly launcher: ContainerLauncherAvailability;
  readonly subjectTrust: SubjectTrust;
}): ContainerProfileActivation {
  assertQualified(input);
  return {
    state: CONTAINER_PROFILE_ENABLED_STATE,
    lock: input.lock,
    observed: input.observed,
    probeResults: [...input.probeResults],
    launcher: input.launcher,
    subjectTrust: input.subjectTrust,
  };
}

export function assertSandboxProfileEnabled(
  profile: SandboxProfileId,
  activation?: ContainerProfileActivation,
): void {
  if (profile === "local-process") return;
  if (activation === undefined || activation.state !== CONTAINER_PROFILE_ENABLED_STATE) {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `sandbox profile ${profile} is ${CONTAINER_PROFILE_STATE}: no qualification was derived for this host, so nothing has established that the substrate enforces anything or that an adapter could be started inside it. It cannot be silently downgraded to local-process.`,
    );
  }
  // Re-run every gate over the evidence the activation carries, rather than
  // trusting the label it arrived with. This is what makes the type safe to be
  // structural: a fabricated activation must carry a signed lock, a matching
  // observed substrate and twenty probe results bound to that lock, and if it
  // does, it is not fabricated.
  assertQualified(activation);
}

/**
 * The control report for a profile, ordered so its bytes are deterministic.
 *
 * The `container` report is not a second hard-coded table. It is the same
 * ordering with the thirteen kernel-prevented entries flipped to `enforced`
 * *for exactly those controls the activation observed on this lock* — so a
 * substrate that qualified on nineteen controls could not produce a report
 * claiming twenty, and a profile with no activation produces no report at all.
 */
export function sandboxControlReport(
  profile: SandboxProfileId,
  activation?: ContainerProfileActivation,
): readonly SandboxControlReport[] {
  assertSandboxProfileEnabled(profile, activation);
  const enforcedByContainer = new Set<string>(
    activation === undefined ? [] : containerObservedControls(activation),
  );
  return [
    ...PROCESS_ENFORCED.map((control_id) => ({ control_id, state: "enforced" as const })),
    ...PROCESS_UNSUPPORTED.map(([control_id, reason_code]) =>
      enforcedByContainer.has(control_id)
        ? { control_id, state: "enforced" as const }
        : {
            control_id,
            state: "unsupported_on_this_host" as const,
            reason_code: activation === undefined ? reason_code : "CONTROL_NOT_OBSERVED_ON_LOCKED_SUBSTRATE",
          },
    ),
  ];
}

export function enforcedControls(
  profile: SandboxProfileId,
  activation?: ContainerProfileActivation,
): readonly SandboxControlId[] {
  return sandboxControlReport(profile, activation)
    .filter((c) => c.state === "enforced")
    .map((c) => c.control_id);
}

export function unsupportedControls(
  profile: SandboxProfileId,
  activation?: ContainerProfileActivation,
): readonly SandboxControlId[] {
  return sandboxControlReport(profile, activation)
    .filter((c) => c.state !== "enforced")
    .map((c) => c.control_id);
}

/**
 * Environment variables an adapter process may receive.
 *
 * Deny by default: the child gets exactly these names and nothing else — no
 * `HOME`, no `USER`, no `SSH_AUTH_SOCK`, no `DOCKER_HOST`, no proxy variables,
 * no cloud credential variables, and none of the caller's own environment.
 */
export const ALLOWED_ENVIRONMENT_VARIABLE_NAMES = [
  "ERL2_ADAPTER_PROTOCOL_VERSION",
  "ERL2_RUN_ID",
  "ERL2_OPERATION_ID",
  "LANG",
  "TZ",
] as const;

/** Exact child environment for subject-adapter/v2 local observation. */
export const LOCAL_OBSERVATION_ENVIRONMENT_VARIABLE_NAMES = [
  "ERL2_ADAPTER_PROTOCOL_VERSION",
  "ERL2_EXECUTION_ID",
  "ERL2_EXECUTION_MODE",
  "ERL2_OPERATION_ID",
] as const;

/** Names whose presence in a proposed environment is an immediate refusal. */
const DENIED_ENVIRONMENT_SUBSTRINGS = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "CREDENTIAL",
  "KEY",
  "SESSION",
  "COOKIE",
  "AUTH",
  "DOCKER",
  "PROXY",
  "HOME",
  "AWS_",
  "GCP_",
  "AZURE_",
];

export function assertEnvironmentAllowlisted(
  env: Readonly<Record<string, string>>,
  allowedNames: readonly string[] = ALLOWED_ENVIRONMENT_VARIABLE_NAMES,
): void {
  for (const name of Object.keys(env)) {
    if (!allowedNames.includes(name)) {
      throw new Erl2Error(
        CODES.ADAPTER_ENVIRONMENT_VARIABLE_DENIED,
        `environment variable ${name} is not on the adapter allowlist`,
      );
    }
    for (const denied of DENIED_ENVIRONMENT_SUBSTRINGS) {
      if (name.toUpperCase().includes(denied)) {
        throw new Erl2Error(
          CODES.ADAPTER_ENVIRONMENT_VARIABLE_DENIED,
          `environment variable ${name} matches the denied pattern ${denied}`,
        );
      }
    }
  }
}

/**
 * Root paths an adapter mount may never resolve into, whatever the host was
 * asked for. These are checked as absolute prefixes after resolution, so a
 * symlink or `..` that lands on one is caught.
 */
const FORBIDDEN_MOUNT_PREFIXES = [
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/var/run/docker",
  "/etc/shadow",
  "/etc/sudoers",
  "/root",
  "/proc/1",
  "/sys/fs/cgroup",
  "/dev/kmem",
  "/dev/mem",
];

/** Path segments that mark a Lab authority an adapter may never mount. */
const FORBIDDEN_MOUNT_SEGMENTS = [
  "vault",
  "truth",
  "judge",
  "expectation",
  "selection",
  "held-out",
  "eligibility-pool",
  "custodian",
  "keyring",
  ".ssh",
  ".aws",
  ".docker",
  ".gnupg",
];

/**
 * Refuses a mount that reaches host infrastructure, a user's home directory, or
 * any Lab authority the adapter plane must never see (ERL2-SEC-001).
 */
export function assertMountPermitted(absolutePath: string, homeDirectory: string | undefined): void {
  const normalized = absolutePath.replaceAll("\\", "/");
  for (const prefix of FORBIDDEN_MOUNT_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      throw new Erl2Error(
        CODES.ADAPTER_MOUNT_FORBIDDEN,
        `mount ${absolutePath} reaches forbidden host path ${prefix}`,
      );
    }
  }
  const lower = normalized.toLowerCase();
  for (const segment of FORBIDDEN_MOUNT_SEGMENTS) {
    if (lower.split("/").includes(segment)) {
      throw new Erl2Error(
        CODES.ADAPTER_MOUNT_FORBIDDEN,
        `mount ${absolutePath} reaches the forbidden path segment ${segment}`,
      );
    }
  }
  if (homeDirectory !== undefined && homeDirectory.length > 1) {
    const home = homeDirectory.replaceAll("\\", "/").replace(/\/+$/, "");
    // The run root itself may legitimately live under a developer's home; only
    // a mount of the home directory *itself* is ambient access.
    if (normalized === home) {
      throw new Erl2Error(
        CODES.ADAPTER_MOUNT_FORBIDDEN,
        "an adapter may not mount the ambient home directory",
      );
    }
  }
}

/** Asserts the manifest reports the profile's controls exactly, in order. */
export function assertControlReportMatchesProfile(
  manifest: SandboxInvocationManifestV1 | SandboxInvocationManifestV2,
  profile: SandboxProfileId,
  activation?: ContainerProfileActivation,
): void {
  if (
    profile === "container" &&
    (activation === undefined ||
      manifest.isolation_substrate_lock_hash !== containerSubstrateLockHash(activation))
  ) {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      "a container-profile sandbox manifest must name the substrate lock whose observed evidence licenses its control report",
    );
  }
  const expected = sandboxControlReport(profile, activation);
  const actual = manifest.enforced_controls;
  if (actual.length !== expected.length) {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `sandbox manifest reports ${String(actual.length)} controls; the ${profile} profile has ${String(expected.length)}`,
    );
  }
  for (const [index, control] of expected.entries()) {
    const found = actual[index];
    if (found?.control_id !== control.control_id || found.state !== control.state) {
      throw new Erl2Error(
        CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
        `sandbox manifest misreports control ${control.control_id}`,
      );
    }
  }
}
