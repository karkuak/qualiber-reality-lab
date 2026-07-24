/**
 * The capability broker (design v2 §21, ERL2-SEC-003, ERL2-AC-017).
 *
 * Privilege is a closed capability enum, never a shell. There is no
 * `exec(command)` anywhere in this package, and no capability whose payload is
 * command text, a glob, or an environment expansion.
 *
 * **ERL2-OQ-001 is unresolved.** The audited host broker that would validate a
 * privileged operation's plan hash, target root, one-time operation id,
 * before-state precondition and compensation does not exist. Therefore every
 * privileged capability is *denied*, with a stable refusal code, and the denial
 * is recorded in the grant. Nothing emulates privileged success: an adapter
 * that asks for root, host mutation, a service manager, the Docker socket, a
 * kernel module, a reboot or an unrestricted native installer is refused and
 * the refusal is a typed adapter finding, not a subject defect.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type AdapterCapabilityGrantV1,
  type AdapterCapabilityId,
  type Hash,
  type Instant,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";

/** Capabilities the unprivileged profile can grant. */
export const UNPRIVILEGED_CAPABILITIES: readonly AdapterCapabilityId[] = [
  "read-subject-visible-input",
  "read-canonical-evidence",
  "write-run-output",
  "write-adapter-workspace",
  "request-credential-handle",
  "network-egress",
];

/**
 * Capabilities that require the ERL2-OQ-001 broker. Each stays ungrantable
 * until an audited broker exists and a superseding ADR activates it.
 */
export const PRIVILEGED_CAPABILITIES: readonly AdapterCapabilityId[] = [
  "bind-loopback-port",
  "install-package-into-host",
  "write-host-configuration",
  "register-host-service",
  "host-package-manager",
  "load-kernel-module",
  "use-docker-socket",
  "elevate-to-root",
  "reboot-host",
];

export const PRIVILEGE_BROKER_STATE = "absent_pending_erl2_oq_001" as const;

export function isPrivilegedCapability(capability: string): boolean {
  return (PRIVILEGED_CAPABILITIES as readonly string[]).includes(capability);
}

/**
 * The stable refusal an adapter sees for any privileged request while
 * ERL2-OQ-001 is open.
 */
export function privilegedRefusal(capability: string): Erl2Error {
  return new Erl2Error(
    CODES.ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED,
    `capability ${capability} requires the privilege broker, which is ${PRIVILEGE_BROKER_STATE}; unprivileged subject operations only`,
    { owner: "adapter" },
  );
}

export interface CapabilityGrantOptions {
  readonly runId: string;
  readonly operationId: string;
  readonly grantId: string;
  readonly adapterManifestHash: Hash;
  readonly requested: readonly string[];
  readonly grantedAt: Instant;
}

/**
 * Adjudicates a capability request.
 *
 * An unknown capability id is refused rather than ignored: the enum is closed,
 * so an unrecognised string is an attempt to widen the surface.
 */
export function grantCapabilities(options: CapabilityGrantOptions): AdapterCapabilityGrantV1 {
  const granted: AdapterCapabilityId[] = [];
  const denied: AdapterCapabilityId[] = [];
  const denialCodes: string[] = [];

  for (const requested of options.requested) {
    if (isPrivilegedCapability(requested)) {
      denied.push(requested as AdapterCapabilityId);
      denialCodes.push(CODES.ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED);
      continue;
    }
    if (!(UNPRIVILEGED_CAPABILITIES as readonly string[]).includes(requested)) {
      throw new Erl2Error(
        CODES.ADAPTER_CAPABILITY_NOT_GRANTED,
        `capability ${requested.slice(0, 64)} is not in the closed capability enum`,
        { owner: "adapter" },
      );
    }
    granted.push(requested as AdapterCapabilityId);
  }

  const base = {
    schema_version: "adapter-capability-grant/v1" as const,
    run_id: options.runId,
    operation_id: options.operationId,
    grant_id: options.grantId,
    adapter_manifest_hash: options.adapterManifestHash,
    requested_capability_ids: [...options.requested] as AdapterCapabilityId[],
    granted_capability_ids: granted,
    denied_capability_ids: denied,
    ...(denialCodes.length === 0 ? {} : { denial_codes: denialCodes }),
    privileged_broker_state: PRIVILEGE_BROKER_STATE,
    granted_at: options.grantedAt,
  };
  return assertContract<AdapterCapabilityGrantV1>("AdapterCapabilityGrantV1", {
    ...base,
    core_hash: coreHash(base),
  });
}

/**
 * Refuses an adapter manifest that declares a privileged broker capability.
 *
 * This runs at certification and again before every invocation, so a manifest
 * that gained a privileged capability after certification cannot execute.
 */
export function assertManifestCapabilitiesUnprivileged(
  requiredBrokerCapabilities: readonly string[],
): void {
  for (const capability of requiredBrokerCapabilities) {
    if (isPrivilegedCapability(capability)) throw privilegedRefusal(capability);
    if (!(UNPRIVILEGED_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new Erl2Error(
        CODES.ADAPTER_CAPABILITY_NOT_GRANTED,
        `adapter declares capability ${capability.slice(0, 64)}, which is outside the closed enum`,
        { owner: "adapter" },
      );
    }
  }
}
