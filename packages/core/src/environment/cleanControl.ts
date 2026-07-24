/**
 * Clean control and the baseline fingerprint (implementation plan §9.1 S3.6).
 *
 * The fingerprint is derived from the ordered probe observations and evidence
 * source states **only**. It deliberately excludes run id, instance identity
 * and timestamps, so two clean provisions of the same archetype produce the
 * same fingerprint — which is what makes "reaches a stable baseline twice" a
 * byte-level check rather than a judgement call.
 *
 * Contamination is a Lab-owned verdict. A contaminated baseline is
 * `lab_invalid`; it is never attributed to a subject.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type EnvironmentBaselineFingerprintV1,
  type EnvironmentProbeResultV1,
  type Hash,
  type SourceState,
} from "@erl2/contracts";
import { coreHash, domainHash, HASH_DOMAINS } from "@erl2/integrity";

export interface EvidenceSourceState {
  readonly source_id: string;
  readonly state: SourceState;
}

/**
 * Derives the fingerprint from probe observations and source states.
 *
 * Probes are sorted by id so a driver cannot change the fingerprint by
 * reordering its own output.
 */
export function baselineFingerprintHash(
  probes: readonly EnvironmentProbeResultV1[],
  sources: readonly EvidenceSourceState[],
): Hash {
  const orderedProbes = [...probes]
    .sort((a, b) => (a.probe_id < b.probe_id ? -1 : a.probe_id > b.probe_id ? 1 : 0))
    .map((p) => ({
      probe_id: p.probe_id,
      phase: p.phase,
      kind: p.kind,
      target_resource_id: p.target_resource_id,
      passed: p.passed,
      observation_hash: p.observation_hash,
    }));
  const orderedSources = [...sources].sort((a, b) =>
    a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0,
  );
  return domainHash(HASH_DOMAINS.BASELINE_FINGERPRINT, {
    probes: orderedProbes,
    evidence_source_states: orderedSources,
  });
}

export interface BuildBaselineOptions {
  readonly runId: string;
  readonly environmentInstanceHash: Hash;
  readonly archetypeHash: Hash;
  readonly driverManifestHash: Hash;
  readonly probes: readonly EnvironmentProbeResultV1[];
  readonly evidenceSourceStates: readonly EvidenceSourceState[];
  readonly observedAt: string;
  /**
   * Residue or foreign state observed before the run began. Any entry is
   * contamination: a clean archetype must start from empty isolated state.
   */
  readonly preexistingResidueCodes?: readonly string[];
}

export function buildBaselineFingerprint(
  options: BuildBaselineOptions,
): EnvironmentBaselineFingerprintV1 {
  const failedRequiredProbes = options.probes.filter((p) => !p.passed).map((p) => p.probe_id);
  const findingCodes = [
    ...(options.preexistingResidueCodes ?? []),
    ...failedRequiredProbes.map((id) => `BASELINE_PROBE_FAILED:${id}`),
  ];
  const base = {
    schema_version: "environment-baseline-fingerprint/v1" as const,
    run_id: options.runId,
    environment_instance_hash: options.environmentInstanceHash,
    archetype_hash: options.archetypeHash,
    driver_manifest_hash: options.driverManifestHash,
    probes: [...options.probes],
    evidence_source_states: [...options.evidenceSourceStates],
    fingerprint_hash: baselineFingerprintHash(options.probes, options.evidenceSourceStates),
    contamination: {
      detected: findingCodes.length > 0,
      finding_codes: findingCodes,
    },
    observed_at: options.observedAt,
  };
  return assertContract<EnvironmentBaselineFingerprintV1>(
    "EnvironmentBaselineFingerprintV1",
    { ...base, core_hash: coreHash(base) },
  );
}

/**
 * A contaminated baseline stops the run before any subject executes.
 * The failure is Lab-owned; no subject finding may be derived from it.
 */
export function assertBaselineClean(baseline: EnvironmentBaselineFingerprintV1): void {
  if (baseline.contamination.detected) {
    throw new Erl2Error(
      CODES.BASELINE_CONTAMINATION_DETECTED,
      `baseline contaminated: ${baseline.contamination.finding_codes.slice(0, 4).join(", ")}`,
      { owner: "lab" },
    );
  }
  const failed = baseline.probes.filter((p) => !p.passed);
  if (failed.length > 0) {
    throw new Erl2Error(
      CODES.BASELINE_PROBE_FAILED,
      `baseline probe ${failed[0]?.probe_id ?? "unknown"} failed`,
      { owner: "lab" },
    );
  }
}

/**
 * Two clean provisions of the same archetype must produce identical
 * fingerprints (implementation plan §9.3).
 */
export function assertRepeatableBaseline(
  first: EnvironmentBaselineFingerprintV1,
  second: EnvironmentBaselineFingerprintV1,
): void {
  if (first.archetype_hash !== second.archetype_hash) {
    throw new Erl2Error(
      CODES.BASELINE_FINGERPRINT_MISMATCH,
      "baselines are from different archetypes and cannot be compared",
    );
  }
  if (first.fingerprint_hash !== second.fingerprint_hash) {
    throw new Erl2Error(
      CODES.BASELINE_FINGERPRINT_MISMATCH,
      "two clean provisions produced different baseline fingerprints",
      { owner: "lab" },
    );
  }
}
