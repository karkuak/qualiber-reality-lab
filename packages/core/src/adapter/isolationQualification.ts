/**
 * Stronger-subject-isolation qualification (design v2 §21/§22, Slice 6
 * parallel safety track).
 *
 * The `local-process` profile is honest but weak: it is a same-user child
 * process, so the operator account's filesystem, sockets and credentials are
 * reachable in principle. That is acceptable for *trusted reference fixtures*
 * whose source is in this repository and reviewed. It is not acceptable for an
 * opaque private artifact or a third-party OSS package, which is what Slice 7
 * and Slice 9 need.
 *
 * This module implements the qualification *procedure*, not a claim. A profile
 * becomes enabled only when:
 *
 *   1. an immutable substrate lock pins the runtime and its digest, and
 *   2. every required control passes an **enforcement probe** that observes the
 *      control actually holding, and
 *   3. no required control is merely asserted by a manifest.
 *
 * Rule (3) is the one that matters. `qualifyIsolationProfile` ignores every
 * `declared` field a manifest offers and reads only probe observations, because
 * a manifest that says `read_only_root_filesystem: true` is a claim by the thing
 * being tested. A mocked probe therefore cannot qualify a profile: the harness
 * records `evidence: "mocked"`, and mocked evidence never counts toward
 * qualification.
 */

import { CODES, Erl2Error, type Hash } from "@erl2/contracts";

/**
 * The controls a profile must enforce before an opaque subject may run under
 * it (continuation prompt §7.1). Every one is a kernel- or hypervisor-enforced
 * property; nothing on this list can be provided by a same-user process.
 */
export const REQUIRED_ISOLATION_CONTROLS = [
  "read-only-root-filesystem",
  "numeric-non-root-user",
  "capability-drop-all",
  "no-new-privileges",
  "seccomp-default-profile",
  "cpu-limit",
  "memory-limit",
  "pid-limit",
  "wall-clock-deadline",
  "process-tree-termination",
  "network-namespace-isolation",
  "deny-by-default-egress",
  "read-only-input-mounts",
  "writable-output-only",
  "no-docker-socket",
  "no-ambient-home-directory",
  "no-vault-truth-judge-or-selection-access",
  "bounded-diagnostics",
  "run-scoped-resource-identity",
  "teardown-and-residue-inspection",
] as const;

export type IsolationControlId = (typeof REQUIRED_ISOLATION_CONTROLS)[number];

/**
 * How a control's state was established.
 *
 * `observed` is the only value that can qualify a profile. `declared` means a
 * manifest asserted it; `mocked` means a fake harness produced it; `absent`
 * means the probe could not run at all. None of the three is evidence of
 * enforcement.
 */
export type ProbeEvidence = "observed" | "declared" | "mocked" | "absent";

export interface IsolationProbeResult {
  readonly control_id: IsolationControlId;
  /** True only when the probe actually saw the control hold. */
  readonly enforced: boolean;
  readonly evidence: ProbeEvidence;
  /** What the probe did, in one line, so a reviewer can reproduce it. */
  readonly method: string;
  readonly reason_code?: string;
}

export interface SubstrateLockEvidence {
  /** Runtime identifier, e.g. a container engine or a VM monitor. */
  readonly substrate_id: string;
  /** Digest of the immutable runtime image or machine image. */
  readonly image_digest: Hash | undefined;
  /** True when the lock was reviewed and pinned, not merely observed. */
  readonly pinned: boolean;
}

export type IsolationVerdict =
  | {
      readonly outcome: "qualified";
      readonly profile: "container" | "disposable_vm";
      readonly enforcedControls: readonly IsolationControlId[];
    }
  | {
      readonly outcome: "not_qualified";
      readonly state: typeof NOT_QUALIFIED_STATE;
      readonly missingControls: readonly IsolationControlId[];
      readonly reasons: readonly string[];
    };

/** The fail-closed state a non-qualified profile keeps (design v2 §21). */
export const NOT_QUALIFIED_STATE = "disabled_no_qualified_adapter_substrate" as const;

/**
 * Decides whether a candidate profile is qualified for opaque subjects.
 *
 * Enabled status is derived here from a pinned substrate lock plus passing
 * enforcement probes. There is deliberately no input that says "enabled": a
 * manifest claiming to be enabled cannot make this function return `qualified`.
 */
export function qualifyIsolationProfile(input: {
  readonly profile: "container" | "disposable_vm";
  readonly substrate: SubstrateLockEvidence;
  readonly probes: readonly IsolationProbeResult[];
}): IsolationVerdict {
  const reasons: string[] = [];

  if (!input.substrate.pinned || input.substrate.image_digest === undefined) {
    reasons.push("SUBSTRATE_LOCK_NOT_PINNED");
  }

  const byControl = new Map(input.probes.map((p) => [p.control_id, p]));
  const missing: IsolationControlId[] = [];
  for (const control of REQUIRED_ISOLATION_CONTROLS) {
    const probe = byControl.get(control);
    if (probe === undefined) {
      missing.push(control);
      reasons.push(`PROBE_ABSENT:${control}`);
      continue;
    }
    // Only an observation qualifies. A declaration is the subject's word, and a
    // mock is the harness's own output.
    if (probe.evidence !== "observed") {
      missing.push(control);
      reasons.push(`PROBE_NOT_OBSERVED:${control}:${probe.evidence}`);
      continue;
    }
    if (!probe.enforced) {
      missing.push(control);
      reasons.push(`CONTROL_NOT_ENFORCED:${control}${probe.reason_code === undefined ? "" : `:${probe.reason_code}`}`);
    }
  }

  if (missing.length > 0 || reasons.length > 0) {
    return {
      outcome: "not_qualified",
      state: NOT_QUALIFIED_STATE,
      missingControls: missing,
      reasons,
    };
  }
  return {
    outcome: "qualified",
    profile: input.profile,
    enforcedControls: [...REQUIRED_ISOLATION_CONTROLS],
  };
}

/**
 * Refuses to run an opaque subject under an unqualified profile.
 *
 * `trusted_reference` subjects — the ones whose source is in this repository —
 * may use the `local-process` profile, because the threat model there is a bug,
 * not an adversary. An `opaque_private` or `third_party` subject may not.
 */
export function assertSubjectMayRunUnderProfile(input: {
  readonly subjectTrust: "trusted_reference" | "opaque_private" | "third_party";
  readonly profile: "local-process" | "container" | "disposable_vm";
  readonly verdict: IsolationVerdict;
}): void {
  if (input.subjectTrust === "trusted_reference" && input.profile === "local-process") return;
  if (input.verdict.outcome === "qualified" && input.verdict.profile === input.profile) return;
  throw new Erl2Error(
    CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
    `a ${input.subjectTrust} subject may not run under the ${input.profile} profile: ${
      input.verdict.outcome === "qualified"
        ? "the qualified profile does not match"
        : `${NOT_QUALIFIED_STATE} (missing ${input.verdict.missingControls.join(", ")})`
    }`,
    { owner: "lab" },
  );
}

/**
 * A probe harness that reports honestly that it proved nothing.
 *
 * It exists so the qualification procedure, its refusal paths and its reporting
 * can be tested without a container runtime — and so that running it can never
 * be mistaken for qualification, because every result it returns is marked
 * `mocked`.
 */
export function fakeEnforcementProbes(): readonly IsolationProbeResult[] {
  return REQUIRED_ISOLATION_CONTROLS.map((control_id) => ({
    control_id,
    enforced: true,
    evidence: "mocked" as const,
    method: "fake harness: no runtime was exercised",
    reason_code: "MOCKED_PROBE_IS_NOT_EVIDENCE",
  }));
}
