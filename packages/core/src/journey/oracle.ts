/**
 * Oracle canary enforcement (design v2 §10, implementation plan §10.3).
 *
 * Every `JudgeJourneyExpectationV1` carries a unique canary. The Lab scans
 * every surface an adapter or subject can observe:
 *
 *   - adapter request bytes
 *   - mounted files
 *   - environment variables
 *   - process arguments
 *   - diagnostics
 *   - subject output prefill
 *   - network egress
 *   - Lab telemetry
 *
 * A canary found outside the judge/vault boundary invalidates the run **before**
 * any subject attribution. It is never downgraded to a warning, and it is never
 * attributed to the subject.
 */

import { Erl2Error } from "@erl2/contracts";

/** Every surface the design requires be scanned across the *full* run. */
export const ORACLE_SCAN_SURFACES = [
  "adapter_request",
  "mounted_file",
  "environment_variable",
  "process_argument",
  "diagnostics",
  "subject_output_prefill",
  "network_egress",
  "lab_telemetry",
] as const;

export type OracleScanSurface = (typeof ORACLE_SCAN_SURFACES)[number];

/**
 * The surfaces actually canary-scanned on a *shipped* path.
 *
 * Honest scope (review P2-11, §8.6). Slice 6.5-C added three, and only three,
 * because only three now exist as real surfaces a run produces:
 *
 *   - `adapter_request` — every request before dispatch, and the execution plan
 *     before it is retained (`assertRequestOracleClean`);
 *   - `lab_telemetry` — every source snapshot before the observation bundle is
 *     retained (`freezeObservation`);
 *   - `mounted_file` — every canonical evidence entry the adapter can mount,
 *     before the envelope is retained;
 *   - `subject_output_prefill` — the whole subject output manifest and its step
 *     outcomes, before the output freezes.
 *
 * The rest stay pending and stay named. `environment_variable` and
 * `process_argument` are set by the Slice 5 adapter host, not by the environment
 * walk; `diagnostics` needs a subject that emits them, and the development fake
 * port emits none; `network_egress` needs a run that egresses, and no shipped
 * path does. Wiring a scan to a surface no run produces would be a scan of
 * nothing, reported as coverage — which is the exact dishonesty this split
 * exists to prevent.
 */
export const LIVE_ORACLE_SCAN_SURFACES: readonly OracleScanSurface[] = [
  "adapter_request",
  "lab_telemetry",
  "mounted_file",
  "subject_output_prefill",
];

/**
 * Surfaces whose live scan connection is still pending.
 *
 * They are not scanned, and this list is why the coverage claim can be checked
 * rather than believed.
 */
export const PENDING_ORACLE_SCAN_SURFACES: readonly OracleScanSurface[] = ORACLE_SCAN_SURFACES.filter(
  (s) => !LIVE_ORACLE_SCAN_SURFACES.includes(s),
);

const CANARY_PATTERN = /erl2-canary-[0-9a-f]{32}/g;

export interface OracleScanTarget {
  readonly surface: OracleScanSurface;
  readonly label: string;
  readonly bytes: Buffer | string;
}

export interface OracleScanFinding {
  readonly surface: OracleScanSurface;
  readonly label: string;
  readonly canaryId: string;
}

/**
 * Scans one surface. Returns findings rather than throwing so a caller can
 * report every leak at once; `assertNoCanaryLeak` is the fail-closed wrapper.
 */
export function scanForCanaries(
  targets: readonly OracleScanTarget[],
  knownCanaryIds: readonly string[],
): readonly OracleScanFinding[] {
  const known = new Set(knownCanaryIds);
  const findings: OracleScanFinding[] = [];
  for (const target of targets) {
    const text =
      typeof target.bytes === "string" ? target.bytes : target.bytes.toString("latin1");
    for (const match of text.matchAll(CANARY_PATTERN)) {
      const canaryId = match[0];
      // Any well-formed canary is a leak. Matching a *known* one is worse, but
      // an unknown one still means expectation-shaped data escaped.
      findings.push({ surface: target.surface, label: target.label, canaryId });
      void known;
    }
  }
  return findings;
}

/**
 * Fail-closed scan. The refusal is Lab-owned: a leaked oracle invalidates the
 * run and forbids any subject finding derived from it.
 */
export function assertNoCanaryLeak(
  targets: readonly OracleScanTarget[],
  knownCanaryIds: readonly string[],
): void {
  const findings = scanForCanaries(targets, knownCanaryIds);
  if (findings.length === 0) return;
  const first = findings[0] as OracleScanFinding;
  throw new Erl2Error(
    "JOURNEY_ORACLE_CANARY_LEAKED",
    `judge canary reached ${first.surface} (${first.label}); ${String(findings.length)} leak(s) total`,
    { owner: "lab" },
  );
}

/**
 * Structural guard on adapter-visible request contracts: no expectation-shaped
 * field may exist at all, whatever its value.
 *
 * The closed schemas already make these impossible, so this is the executable
 * proof rather than the enforcement.
 */
const FORBIDDEN_ORACLE_FIELDS = [
  "expected_observations",
  "permitted_failure_categories",
  "attribution_requirements",
  "truth_scope",
  "oracle_canary_id",
  "judge_expectation_core_hash",
  "judge_expectation_plaintext_file_sha256",
  "truth_commitment_hash",
  "success_criteria",
  "expected_result",
] as const;

export function assertNoOracleFields(what: string, value: unknown): void {
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}/${String(i)}`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if ((FORBIDDEN_ORACLE_FIELDS as readonly string[]).includes(key)) {
        throw new Erl2Error(
          "JOURNEY_ORACLE_FIELD_PRESENT",
          `${what} carries judge-expectation field ${key} at ${path}/${key}`,
          { owner: "lab" },
        );
      }
      walk(child, `${path}/${key}`);
    }
  };
  walk(value, "");
}
