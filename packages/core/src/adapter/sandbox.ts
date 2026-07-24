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
 * runtime, and there is no qualified adapter container substrate.
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
 */

import {
  CODES,
  Erl2Error,
  type SandboxControlId,
  type SandboxInvocationManifestV1,
} from "@erl2/contracts";

export type SandboxProfileId = "local-process" | "container";

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
 * The container profile is declared and **disabled**, and it is important to be
 * exact about *why*, because the reason changed once a substrate qualified.
 *
 * There are two independent gates, and they are not the same question:
 *
 *  1. *Does a substrate enforce the twenty required controls?* That is
 *     ERL2-OQ-008's `NOT_QUALIFIED_STATE`, derived by `qualifyIsolationProfile`
 *     from a pinned lock plus observed probe evidence. It is answerable — and
 *     on a host with a qualified lock it answers `qualified`.
 *  2. *Can the Lab put an adapter inside that substrate?* That needs a
 *     container-backed sandbox launcher. `sandboxLauncher.ts` supervises a
 *     local child process; it has no container backend, so there is no code
 *     path that could execute an adapter under this profile at all.
 *
 * Gate 2 is what this constant reports. Collapsing the two would let a
 * qualified substrate read as a usable profile, which is the overclaim the
 * whole track exists to prevent: an enforcement guarantee nothing is running
 * behind protects nothing.
 */
export const CONTAINER_PROFILE_STATE =
  "disabled_no_container_adapter_launcher_pending_erl2_oq_008" as const;

export function assertSandboxProfileEnabled(profile: SandboxProfileId): void {
  if (profile !== "local-process") {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `sandbox profile ${profile} is ${CONTAINER_PROFILE_STATE}: qualifying a substrate proves it would contain an adapter, but the Lab has no launcher that can start one inside it. It cannot be silently downgraded to local-process.`,
    );
  }
}

/** The control report for a profile, ordered so its bytes are deterministic. */
export function sandboxControlReport(profile: SandboxProfileId): readonly SandboxControlReport[] {
  assertSandboxProfileEnabled(profile);
  return [
    ...PROCESS_ENFORCED.map((control_id) => ({ control_id, state: "enforced" as const })),
    ...PROCESS_UNSUPPORTED.map(([control_id, reason_code]) => ({
      control_id,
      state: "unsupported_on_this_host" as const,
      reason_code,
    })),
  ];
}

export function enforcedControls(profile: SandboxProfileId): readonly SandboxControlId[] {
  return sandboxControlReport(profile)
    .filter((c) => c.state === "enforced")
    .map((c) => c.control_id);
}

export function unsupportedControls(profile: SandboxProfileId): readonly SandboxControlId[] {
  return sandboxControlReport(profile)
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

export function assertEnvironmentAllowlisted(env: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(env)) {
    if (!(ALLOWED_ENVIRONMENT_VARIABLE_NAMES as readonly string[]).includes(name)) {
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
  manifest: SandboxInvocationManifestV1,
  profile: SandboxProfileId,
): void {
  const expected = sandboxControlReport(profile);
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
