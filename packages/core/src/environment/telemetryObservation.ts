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

import { assertContract, CODES, Erl2Error, type Classification } from "@erl2/contracts";
import { coreHash, isCanonicalizableString } from "@erl2/integrity";
import type {
  AttributableTelemetryObservationV1,
  EnvironmentArchetypeV1,
  Instant,
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

/**
 * The remaining bounds ERL2-C-160 puts on an `observed` record, restated here
 * because they must be answered *before* the record is built, not after.
 *
 * These are the schema's own numbers. Restating them is not a second contract:
 * `assertContract` still runs on the finished record and would refuse anything
 * these missed. What they buy is that the refusal happens where a reason code
 * can be attached to it, instead of as a throw nobody catalogued.
 */
const MAX_SERVICE_NAMES = 256;
const MAX_SERVICE_NAME_CHARS = 256;
const MAX_COLLECTOR_STRING_CHARS = 256;
const MAX_REPO_DIGESTS = 16;
const MAX_REPO_DIGEST_CHARS = 512;
const MAX_TELEMETRY_COUNT = 100_000_000;
const SERVICE_ID = /^[a-z][a-z0-9-]{0,63}$/;

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

// -- retention: what may be frozen, and what is demoted instead --------------

/**
 * Every reason an `observed` material is demoted to an honest `absent` record.
 *
 * Each names one precondition of freezing, and each is a *specific* code
 * rather than a shared "could not retain": a reader of the retained bytes
 * should be able to tell an excerpt past the size bound from an excerpt the
 * canonicalizer refuses, because those say different things about the run.
 *
 * `reason_code` on ERL2-C-160 is an open `string` (`minLength: 1`,
 * `maxLength: 128`), not an enum — see ADR-ERL2-035 §3. Adding values here is
 * therefore not a contract change at all, compatible or otherwise: no
 * already-written artifact's validity depends on the set, and the offline
 * verifier reports the code without enumerating it.
 */
export const TELEMETRY_RETENTION_REASONS = {
  /** The collector emitted more than the excerpt bound retains. */
  excerptOverBound: "telemetry_excerpt_exceeds_retention_bound",
  /** The excerpt carries bytes the Lab's canonicalizer refuses (NFC, surrogates). */
  excerptNotCanonicalizable: "telemetry_excerpt_not_canonicalizable",
  /** More distinct `service.name` values than the contract retains. */
  serviceNamesOverCardinality: "telemetry_service_names_exceed_cardinality_bound",
  /** A single `service.name` longer than the contract retains. */
  serviceNameOverLength: "telemetry_service_name_exceeds_length_bound",
  /** A `service.name` carrying bytes the canonicalizer refuses. */
  serviceNameNotCanonicalizable: "telemetry_service_name_not_canonicalizable",
  /** A count outside the range the contract and the canonicalizer represent. */
  countNotRepresentable: "telemetry_count_not_representable",
  /** A collector identity field outside the contract's bounds. */
  collectorIdentityOverBound: "telemetry_collector_identity_exceeds_bound",
  /** A collector identity field the canonicalizer refuses. */
  collectorIdentityNotCanonicalizable: "telemetry_collector_identity_not_canonicalizable",
} as const;

/** A string that is both within `max` characters and canonicalizable. */
function retainableString(value: string, max: number): "ok" | "over_bound" | "not_canonicalizable" {
  if (value.length === 0 || value.length > max) return "over_bound";
  return isCanonicalizableString(value) ? "ok" : "not_canonicalizable";
}

/**
 * Why this `observed` material cannot be frozen as observed, or `undefined`.
 *
 * The discipline is ADR-ERL2-033's, applied to every precondition rather than
 * to one of them. The excerpt bound already demoted to an honest `absent`
 * because *"an excerpt cut short derives counts that are not this run's"*; the
 * canonicalizer's NFC rule, the contract's string lengths, its cardinality and
 * its numeric range are preconditions of exactly the same kind, on bytes of
 * exactly the same provenance — a collector's output, which a subject writes
 * into. Answering them here means the freeze either happens or is refused with
 * a code, and never throws something the caller's terminal cannot classify.
 *
 * This is the seam `ec345d3` opened ("validate the observation before any byte
 * freezes, honoring P1-10") widened to the inputs, not a second seam beside
 * it: `coreHash` and `assertContract` still run on the finished record.
 *
 * Order is fixed and the first refusal wins, so the same material always
 * demotes with the same code.
 */
export function telemetryRetentionRefusal(material: AttributableTelemetryMaterial): string | undefined {
  if (material.evidence !== "observed") return undefined;
  const R = TELEMETRY_RETENTION_REASONS;

  if (material.excerpt.length > MAX_TELEMETRY_EXCERPT_CHARS) return R.excerptOverBound;
  if (!isCanonicalizableString(material.excerpt)) return R.excerptNotCanonicalizable;

  const names = material.counts.serviceNames;
  if (names.length > MAX_SERVICE_NAMES) return R.serviceNamesOverCardinality;
  for (const name of names) {
    // Unlike every other bounded string here, a `service.name` may legitimately
    // be empty — `Str()` parses to `""` — so only the upper bound applies.
    if (name.length > MAX_SERVICE_NAME_CHARS) return R.serviceNameOverLength;
    if (!isCanonicalizableString(name)) return R.serviceNameNotCanonicalizable;
  }

  // A count is parsed out of the collector's text, so a long enough digit run
  // reaches `Infinity` before it reaches any bound the schema states. One test
  // covers both that and the schema's range, deliberately: an integer within
  // `[0, MAX_TELEMETRY_COUNT]` is finite and safe by arithmetic, so a separate
  // `isCanonicalizableNumber` call here would be a guard nothing could kill —
  // it was written, measured as non-load-bearing by the campaign, and removed
  // (ADR-ERL2-035 §5.1).
  for (const count of [
    material.counts.traceBatches,
    material.counts.spans,
    material.counts.runAttributedRecords,
  ]) {
    if (!Number.isInteger(count) || count < 0 || count > MAX_TELEMETRY_COUNT) {
      return R.countNotRepresentable;
    }
  }

  const collector = material.collector;
  if (!SERVICE_ID.test(collector.serviceId)) return R.collectorIdentityOverBound;
  if (collector.observedImageRepoDigests.length > MAX_REPO_DIGESTS) {
    return R.collectorIdentityOverBound;
  }
  for (const [value, max] of [
    [collector.containerName, MAX_COLLECTOR_STRING_CHARS],
    [collector.imageId, MAX_COLLECTOR_STRING_CHARS],
    ...collector.observedImageRepoDigests.map(
      (digest) => [digest, MAX_REPO_DIGEST_CHARS] as const,
    ),
  ] as readonly (readonly [string, number])[]) {
    const verdict = retainableString(value, max);
    if (verdict === "over_bound") return R.collectorIdentityOverBound;
    if (verdict === "not_canonicalizable") return R.collectorIdentityNotCanonicalizable;
  }

  return undefined;
}

/** The part of the artifact store this retention needs, and no more. */
export interface TelemetryObservationStore {
  isFrozen(logicalPath: string): boolean;
  readJson(logicalPath: string): unknown;
  freezeJson(logicalPath: string, value: unknown, classification: Classification): unknown;
}

/**
 * Observes, validates and freezes the retained observation exactly once.
 *
 * Two properties live here and both are load-bearing.
 *
 * **Read what you wrote.** The freeze precedes the lifecycle event that
 * anchors it, so a crash between the two leaves a retained byte the lifecycle
 * never reached. A re-observation on resume takes a fresh `observed_at` over a
 * collector log that may have grown, so freezing again at the same logical
 * path raises `ARTIFACT_ALREADY_FROZEN` and wedges the run forever. The run
 * already observed; on resume the honest thing is to read what it wrote,
 * exactly as `retainedSubstrateBinding` does for the same class of window. The
 * excerpt rides *inside* this one artifact for the other half of the same
 * reason: two files cannot be frozen atomically, and a crash between them would
 * leave either an excerpt nothing references or a reference to absent bytes,
 * each of which the offline accounting refuses.
 *
 * **Refuse before you hash.** Everything the canonicalizer and ERL2-C-160
 * require of the *observed* branch is answered before `base` exists, so
 * collector bytes the Lab cannot canonicalize yield an `absent` record with a
 * reason code instead of an untyped throw. The excerpt is never normalized to
 * make it hashable: it is meant to be what the collector emitted, and
 * rewriting it to fit the hash would substitute a convenient artifact for an
 * observed one (ADR-ERL2-035 §2).
 */
export function retainAttributableTelemetryObservation(input: {
  readonly store: TelemetryObservationStore;
  readonly observationPath: string;
  readonly observer: AttributableTelemetryObserver;
  readonly runId: string;
  readonly observedAt: () => Instant;
}): AttributableTelemetryObservationV1 {
  try {
    return retainObservation(input);
  } catch (cause) {
    // Defence in depth, and the third of ADR-ERL2-035's decisions. This runs
    // inside `destroy` and strictly before `teardown_started`, so anything
    // thrown from here that the CLI's `destroy` catch cannot classify strands
    // the run with no terminal at all and the substrate still live — the
    // driver's own `destroy` never runs. `destroy` routes exactly one code, so
    // every failure of retention leaves through that code, carrying the
    // original one in its message rather than in a class the CLI rethrows.
    // The run then reaches an invalid terminal by receipt-backed emergency
    // cleanup: worse than a demoted observation, far better than a wedge.
    if (cause instanceof Erl2Error && cause.code === CODES.TEARDOWN_FAILED) throw cause;
    const code = cause instanceof Erl2Error ? cause.code : "UNCLASSIFIED";
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Erl2Error(
      CODES.TEARDOWN_FAILED,
      `the attributable-telemetry observation could not be retained (${code}): ${detail}`,
      { owner: "lab", cause },
    );
  }
}

function retainObservation(input: {
  readonly store: TelemetryObservationStore;
  readonly observationPath: string;
  readonly observer: AttributableTelemetryObserver;
  readonly runId: string;
  readonly observedAt: () => Instant;
}): AttributableTelemetryObservationV1 {
  if (input.store.isFrozen(input.observationPath)) {
    return assertContract<AttributableTelemetryObservationV1>(
      "AttributableTelemetryObservationV1",
      input.store.readJson(input.observationPath),
    );
  }

  const material = input.observer.observeAttributableTelemetry(input.runId);
  const observedAt = input.observedAt();
  const refusal = telemetryRetentionRefusal(material);
  const base =
    material.evidence === "observed" && refusal === undefined
      ? {
          schema_version: "attributable-telemetry-observation/v1" as const,
          run_id: input.runId,
          marker: material.marker,
          evidence: "observed" as const,
          observed_at: observedAt,
          collector: {
            service_id: material.collector.serviceId,
            container_name: material.collector.containerName,
            // Schema constants, not observations of convenience: the driver
            // refuses to read an unverified container's logs, so reaching
            // this branch at all is the proof.
            ownership_verified: true as const,
            image_id: material.collector.imageId,
            observed_image_repo_digests: material.collector.observedImageRepoDigests,
            image_matches_locked_digest: true as const,
          },
          trace_batches: material.counts.traceBatches,
          spans: material.counts.spans,
          service_names: material.counts.serviceNames,
          run_attributed_records: material.counts.runAttributedRecords,
          log_excerpt: material.excerpt,
        }
      : {
          schema_version: "attributable-telemetry-observation/v1" as const,
          run_id: input.runId,
          marker: material.marker,
          evidence: "absent" as const,
          observed_at: observedAt,
          reason_code:
            refusal ?? (material as { readonly reasonCode: string }).reasonCode,
        };
  const observation = assertContract<AttributableTelemetryObservationV1>(
    "AttributableTelemetryObservationV1",
    { ...base, core_hash: coreHash(base) },
  );
  input.store.freezeJson(input.observationPath, observation, "INTERNAL");
  return observation;
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
