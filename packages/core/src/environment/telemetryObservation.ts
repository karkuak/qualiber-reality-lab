/**
 * Attributable-telemetry arithmetic and the declaration-bound gate
 * (ADR-ERL2-033).
 *
 * `parseCollectorTelemetry` and `excerptCollectorTelemetry` are *definitions*
 * in the ADR-ERL2-024 §7.2 sense: the producer observes with them and the
 * offline verifier recomputes with them, so the two cannot drift on what a
 * count *is*. Every verdict built on top of a count lives with its owner —
 * the producer's validity gate below, the offline verifier's own telemetry
 * derivation — and neither reads the other's.
 */

import type {
  AttributableTelemetryObservationV1,
  EnvironmentArchetypeV1,
  JourneyStepOutcomeV1,
} from "@erl2/contracts";

/**
 * The retention bound on a log excerpt, matching the contract's `maxLength`.
 *
 * A collector output past it yields an honest `absent` observation with
 * `telemetry_excerpt_exceeds_retention_bound`, never a truncated excerpt: an
 * excerpt cut short derives counts that are not the run's.
 */
export const MAX_TELEMETRY_EXCERPT_CHARS = 262_144;

/** The counts derivable from a collector's own debug-exporter output. */
export interface CollectorTelemetryCounts {
  readonly traceBatches: number;
  readonly spans: number;
  readonly serviceNames: readonly string[];
  readonly runAttributedRecords: number;
}

/**
 * A collector debug-exporter trace-batch summary line. The base configuration's
 * `debug` exporter writes one per received batch, carrying the span count.
 */
const TRACE_BATCH_LINE = /\bTraces\b.*"spans":\s*(\d+)/;

/** A `service.name: Str(...)` resource-attribute line from the same exporter. */
const SERVICE_NAME_LINE = /service\.name:\s*Str\(([^)]*)\)/;

/** Number of occurrences of `marker` in `text`. The marker never spans lines. */
function occurrences(text: string, marker: string): number {
  return marker === "" ? 0 : text.split(marker).length - 1;
}

/**
 * The counts a collector log supports, attributed by `marker`.
 *
 * Every count is derived line by line, which is what makes the excerpt
 * invariant below hold: a line contributes to a count if and only if one of
 * the three patterns matches it.
 */
export function parseCollectorTelemetry(logs: string, marker: string): CollectorTelemetryCounts {
  let traceBatches = 0;
  let spans = 0;
  const serviceNames = new Set<string>();
  let runAttributedRecords = 0;
  for (const line of logs.split("\n")) {
    const batch = TRACE_BATCH_LINE.exec(line);
    if (batch?.[1] !== undefined) {
      traceBatches += 1;
      spans += Number.parseInt(batch[1], 10);
    }
    for (const match of line.matchAll(new RegExp(SERVICE_NAME_LINE, "g"))) {
      serviceNames.add(match[1] ?? "");
    }
    runAttributedRecords += occurrences(line, marker);
  }
  return {
    traceBatches,
    spans,
    serviceNames: [...serviceNames].sort(),
    runAttributedRecords,
  };
}

/** True when `line` contributes to at least one count under `marker`. */
export function contributesToTelemetryCounts(line: string, marker: string): boolean {
  return (
    TRACE_BATCH_LINE.test(line) || SERVICE_NAME_LINE.test(line) || occurrences(line, marker) > 0
  );
}

/**
 * The subset of collector log lines the counts are derived from, in order.
 *
 * Invariant — and the property the offline verifier's recomputation stands on:
 * `parseCollectorTelemetry(excerptCollectorTelemetry(logs, marker), marker)`
 * equals `parseCollectorTelemetry(logs, marker)` for every input, because a
 * line contributes to a count only if one of the three patterns matches it and
 * the excerpt keeps exactly the matching lines. The excerpt is also a fixed
 * point: excerpting an excerpt returns it unchanged, which is how the verifier
 * refuses an excerpt padded with lines that contribute to nothing.
 */
export function excerptCollectorTelemetry(logs: string, marker: string): string {
  return logs
    .split("\n")
    .filter((line) => contributesToTelemetryCounts(line, marker))
    .join("\n");
}

/** The Docker-proven identity of the container the logs were read from. */
export interface ObservedCollectorIdentity {
  readonly serviceId: string;
  readonly containerName: string;
  readonly imageId: string;
  readonly observedImageRepoDigests: readonly string[];
}

/**
 * What a driver that can observe attributable telemetry hands back for
 * retention. `observed` exists only when the collector container was
 * Docker-verified before its logs were read; everything else is an `absent`
 * with a typed reason, so a non-observation can never be dressed as one.
 */
export type AttributableTelemetryMaterial =
  | {
      readonly evidence: "observed";
      readonly marker: string;
      readonly counts: CollectorTelemetryCounts;
      /** The exact bytes the counts are derived from (see excerpt invariant). */
      readonly excerpt: string;
      readonly collector: ObservedCollectorIdentity;
    }
  | {
      readonly evidence: "absent";
      readonly marker: string;
      readonly reasonCode: string;
    };

/**
 * The driver-concrete capability seam (ADR-ERL2-033 decision 1).
 *
 * Deliberately not an `EnvironmentDriver` operation: a driver that cannot
 * observe telemetry does not implement this, and the run produces no artifact
 * for it — absence of the retained observation on such runs means *never
 * produced*, recorded in ADR-ERL2-033 §2.
 */
export interface AttributableTelemetryObserver {
  observeAttributableTelemetry(marker: string): AttributableTelemetryMaterial;
}

/** Structural capability guard; the fake driver honestly fails it. */
export function supportsAttributableTelemetry(
  driver: unknown,
): driver is AttributableTelemetryObserver {
  return (
    typeof driver === "object" &&
    driver !== null &&
    typeof (driver as AttributableTelemetryObserver).observeAttributableTelemetry === "function"
  );
}

/**
 * Whether this run declared the observation obtainable (ADR-ERL2-033
 * decision 3). Every conjunct is derivable from retained bytes alone, which is
 * what lets the offline verifier re-derive the same predicate without trusting
 * this one.
 */
export function attributableTelemetryDeclared(input: {
  readonly driverKind: string;
  readonly evidenceSources: EnvironmentArchetypeV1["evidence_sources"];
  readonly outcomes: readonly JourneyStepOutcomeV1[];
}): boolean {
  return (
    input.driverKind === "compose" &&
    input.evidenceSources.some((source) => source.kind === "metric") &&
    input.outcomes.some(
      (outcome) => outcome.intent === "exercise" && outcome.status === "succeeded",
    )
  );
}

/**
 * The producer's `attributable-telemetry-retained` gate arithmetic: passing
 * means *not declared, or declared and satisfied by exactly one observed,
 * run-attributed observation of this run*. The gate never reads a verdict —
 * the contract stores none.
 */
export function attributableTelemetryGatePassed(input: {
  readonly declared: boolean;
  readonly runId: string;
  readonly observations: readonly AttributableTelemetryObservationV1[];
}): boolean {
  if (!input.declared) return true;
  if (input.observations.length !== 1) return false;
  const observation = input.observations[0] as AttributableTelemetryObservationV1;
  return (
    observation.evidence === "observed" &&
    observation.run_id === input.runId &&
    observation.marker === input.runId &&
    (observation.run_attributed_records ?? 0) >= 1
  );
}
