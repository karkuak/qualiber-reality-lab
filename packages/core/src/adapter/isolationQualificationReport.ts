/**
 * The derived isolation qualification report (ERL2-OQ-008, ADR-ERL2-016).
 *
 * `qualifyIsolationProfile` decides; this module freezes what it decided into a
 * durable, closed artifact so the verdict is auditable rather than a transient
 * boolean.  Like `MandatoryGraphClosureReportV1`, it is *verifier output*: it
 * has no field that could be set to enable a profile, and constructing one by
 * hand cannot admit a subject, because the admission check re-derives the
 * verdict from the lock and the probe results rather than reading the report.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type Hash,
  type Instant,
  type IsolationEnforcementProbeResultV1,
  type IsolationQualificationReportV1,
  type IsolationSubstrateLockV1,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";
import {
  NOT_QUALIFIED_STATE,
  REQUIRED_ISOLATION_CONTROLS,
  qualifyIsolationProfile,
  type IsolationProbeResult,
  type IsolationVerdict,
} from "./isolationQualification.js";
import {
  assertObservedMatchesIsolationLock,
  assertProbeSuiteMatchesLock,
  type ObservedSubstrateState,
} from "./isolationSubstrateLock.js";
import { PROBE_SUITE_ID, probeSuiteDigest } from "./isolationProbes.js";

/** Release identifier recorded in every report. */
export const QUALIFIER_RELEASE = "erl2-isolation-qualifier/0.1.0";

/** Projects a durable probe result onto the decision procedure's input shape. */
export function toProbeInput(
  result: IsolationEnforcementProbeResultV1,
): IsolationProbeResult {
  return {
    control_id: result.control_id,
    enforced: result.enforced,
    evidence: result.evidence,
    method: result.method,
    ...(result.reason_code === undefined ? {} : { reason_code: result.reason_code }),
  };
}

export interface BuildQualificationReportInput {
  readonly reportId: string;
  readonly profile: "container" | "disposable_vm";
  /** Absent when no substrate is pinned at all — the honest fail-closed state. */
  readonly lock: IsolationSubstrateLockV1 | undefined;
  readonly probeResults: readonly IsolationEnforcementProbeResultV1[];
  readonly evaluatedAt: Instant;
}

/**
 * Derives the verdict and freezes the report.
 *
 * The verdict is not an input.  It comes from `qualifyIsolationProfile`, which
 * reads a pinned lock and probe evidence and has no parameter meaning
 * "enabled".  A report can therefore record `not_qualified` for a substrate
 * whose manifest insists otherwise, and never the reverse.
 */
export function buildIsolationQualificationReport(
  input: BuildQualificationReportInput,
): IsolationQualificationReportV1 {
  const verdict: IsolationVerdict = qualifyIsolationProfile({
    profile: input.profile,
    substrate:
      input.lock === undefined
        ? { substrate_id: "none", image_digest: undefined, pinned: false }
        : {
            substrate_id: input.lock.runtime_id,
            image_digest: input.lock.image_digest,
            pinned: input.lock.pinned,
          },
    probes: input.probeResults.map(toProbeInput),
  });

  // Probe results must belong to the lock being qualified. A result frozen
  // against a different substrate is evidence about a different substrate.
  const reasons: string[] = verdict.outcome === "qualified" ? [] : [...verdict.reasons];
  if (input.lock !== undefined) {
    const lockHash = coreHash(input.lock);
    const foreign = input.probeResults.filter((r) => r.substrate_lock_hash !== lockHash);
    for (const result of foreign) {
      reasons.push(`PROBE_BOUND_TO_ANOTHER_SUBSTRATE:${result.control_id}`);
    }
  }

  const observed = REQUIRED_ISOLATION_CONTROLS.filter((control) =>
    input.probeResults.some(
      (r) => r.control_id === control && r.evidence === "observed" && r.enforced,
    ),
  );
  const missing = REQUIRED_ISOLATION_CONTROLS.filter((c) => !observed.includes(c));
  const qualified = verdict.outcome === "qualified" && reasons.length === 0;

  const body = {
    schema_version: "isolation-qualification-report/v1" as const,
    report_id: input.reportId,
    algorithm: "erl2-isolation-qualification/v1" as const,
    profile: input.profile,
    ...(input.lock === undefined ? {} : { substrate_lock_hash: coreHash(input.lock) }),
    required_controls: [...REQUIRED_ISOLATION_CONTROLS],
    observed_controls: observed,
    probe_result_hashes: input.probeResults.map((r) => r.core_hash),
    verdict: (qualified ? "qualified" : "not_qualified") as "qualified" | "not_qualified",
    ...(qualified ? {} : { not_qualified_state: NOT_QUALIFIED_STATE }),
    reasons: qualified ? [] : dedupe(reasons),
    missing_controls: qualified ? [] : missing,
    evaluated_at: input.evaluatedAt,
    qualifier_release: QUALIFIER_RELEASE,
  };
  return assertContract<IsolationQualificationReportV1>("IsolationQualificationReportV1", {
    ...body,
    core_hash: coreHash(body),
  });
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * The pre-execution gate: re-derives everything before a subject runs.
 *
 * Called immediately before an opaque or third-party subject would execute
 * under a qualified profile.  It re-checks, in order:
 *
 *  1. the observed substrate still matches its lock (drift);
 *  2. the probe suite that produced the evidence is the one the lock pins;
 *  3. every probe result is bound to *this* lock;
 *  4. the verdict re-derives as `qualified`.
 *
 * Step 4 re-runs the decision rather than reading the report, so a hand-written
 * report claiming `qualified` grants nothing.
 */
export function assertQualifiedForExecution(input: {
  readonly profile: "container" | "disposable_vm";
  readonly lock: IsolationSubstrateLockV1;
  readonly observed: ObservedSubstrateState;
  readonly probeResults: readonly IsolationEnforcementProbeResultV1[];
}): void {
  assertObservedMatchesIsolationLock(input.lock, input.observed);
  assertProbeSuiteMatchesLock(input.lock, PROBE_SUITE_ID, probeSuiteDigest());

  const lockHash = coreHash(input.lock);
  for (const result of input.probeResults) {
    if (result.substrate_lock_hash !== lockHash) {
      throw new Erl2Error(
        CODES.ENV_ISOLATION_SUBSTRATE_DRIFT,
        `probe evidence for ${result.control_id} was frozen against a different substrate lock`,
        { owner: "lab" },
      );
    }
  }

  const verdict = qualifyIsolationProfile({
    profile: input.profile,
    substrate: {
      substrate_id: input.lock.runtime_id,
      image_digest: input.lock.image_digest,
      pinned: input.lock.pinned,
    },
    probes: input.probeResults.map(toProbeInput),
  });
  if (verdict.outcome !== "qualified") {
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `the ${input.profile} profile is ${NOT_QUALIFIED_STATE}: ${verdict.reasons.slice(0, 6).join("; ")}`,
      { owner: "lab" },
    );
  }
}

/**
 * Confirms that qualification granted no new authority.
 *
 * Qualifying an isolation profile answers exactly one question — "is this
 * substrate strong enough to contain an adversarial subject?".  It must not
 * silently widen what a subject may *do*: ERL2-OQ-001's privilege broker is a
 * separate, still fail-closed question (ADR-ERL2-016 decision 5).  This is the
 * executable form of that separation.
 */
export function assertQualificationGrantsNoNewAuthority(grant: {
  readonly grantedCapabilities: readonly string[];
  readonly deniedCapabilities: readonly string[];
  readonly privilegedBrokerState: string;
  readonly egressDecisions: readonly { readonly allowed: boolean }[];
}): void {
  if (grant.privilegedBrokerState !== "absent_pending_erl2_oq_001") {
    throw new Erl2Error(
      CODES.ADAPTER_PRIVILEGED_OPERATION_NOT_SUPPORTED,
      "isolation qualification does not activate a privilege broker; ERL2-OQ-001 stays fail-closed",
      { owner: "lab" },
    );
  }
  if (grant.egressDecisions.some((d) => d.allowed)) {
    throw new Erl2Error(
      CODES.ADAPTER_EGRESS_DENIED,
      "isolation qualification does not open egress; the deny-by-default policy is unchanged",
      { owner: "lab" },
    );
  }
}

/** Hash of a probe-result set, so a report cites exactly the evidence it read. */
export function probeEvidenceHash(
  results: readonly IsolationEnforcementProbeResultV1[],
): Hash {
  return coreHash({ probe_results: results.map((r) => r.core_hash) });
}
