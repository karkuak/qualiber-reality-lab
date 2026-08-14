/**
 * ERL2-C-171 fixture builders (ADR-ERL2-038 R2–R8).
 *
 * The five *valid* fixtures are checked in under `fixtures/trusted-telemetry/`
 * and asserted byte-identical to what these builders produce, so a reviewer can
 * read the artifact rather than reconstruct it from mutators, and so packages 2
 * and 3 have a fixed target to produce.
 *
 * The *invalid* cases are expressed as deltas instead. Twenty-eight
 * near-identical checked-in files would hide the one field that differs, which
 * is the only thing each case is about; a named mutator states it in one line.
 *
 * Nothing here reads a file the collector wrote, because no collector writes one
 * yet. These are the shapes the trusted channel must produce when it exists.
 */

import { coreHash, hashBytes } from "@erl2/integrity";
import type { AttributableTelemetryObservationV2 } from "@erl2/contracts";

export const FIXTURE_RUN_ID = "00000000-0000-7000-8000-000000000111";
export const FIXTURE_OTHER_RUN_ID = "00000000-0000-7000-8000-000000000222";

/** A stand-in archetype hash; the verifier tests substitute the real one. */
export const FIXTURE_ARCHETYPE_HASH =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
export const FIXTURE_SUBSTRATE_HASH =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222";
export const FIXTURE_CONFIG_DIGEST =
  "sha256:3333333333333333333333333333333333333333333333333333333333333333";
export const FIXTURE_IMAGE_DIGEST =
  "sha256:1fef9f07f04eb6775b4076ea4f817d6b7b9050e23e52941f0756ba08df798ea6";

/** One OTLP-JSON trace document, exactly as the file exporter writes one. */
export function trustedRecord(options: {
  readonly serviceName?: string | undefined;
  readonly markers?: readonly (string | undefined)[] | undefined;
}): string {
  const markers = options.markers ?? [FIXTURE_RUN_ID];
  return JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: options.serviceName ?? "quote" } },
          ],
        },
        scopeSpans: [
          {
            spans: markers.map((marker) => ({
              attributes:
                marker === undefined
                  ? []
                  : [
                      {
                        key: "url.full",
                        value: {
                          stringValue: `http://quote:8090/getquote?erl2_run=${marker}`,
                        },
                      },
                    ],
            })),
          },
        ],
      },
    ],
  });
}

/** Newline-delimited records: one physical line each, terminated. */
export function trustedRecords(records: readonly string[]): string {
  return records.length === 0 ? "" : `${records.join("\n")}\n`;
}

/**
 * A complete, coherent `observed` record over `bytes`.
 *
 * Every derived field is computed from the bytes rather than passed in, so a
 * fixture cannot drift out of coherence by accident — an incoherent fixture has
 * to be built by a mutator that says so.
 */
export function observedV2(options: {
  readonly bytes: string;
  readonly runId?: string | undefined;
  readonly marker?: string | undefined;
  readonly archetypeHash?: string | undefined;
  readonly spans: number;
  readonly serviceNames: readonly string[];
  readonly runAttributedRecords: number;
}): AttributableTelemetryObservationV2 {
  const runId = options.runId ?? FIXTURE_RUN_ID;
  const bytes = options.bytes;
  const recordCount = bytes.length === 0 ? 0 : bytes.slice(0, -1).split("\n").length;
  const base = {
    schema_version: "attributable-telemetry-observation/v2" as const,
    run_id: runId,
    marker: options.marker ?? runId,
    evidence: "observed" as const,
    observed_at: "2026-08-13T00:00:05Z",
    channel: {
      kind: "collector-file-otlp-json" as const,
      record_format: "otlp-json-ndjson" as const,
      encoding: "utf-8" as const,
      rotation: "forbidden" as const,
      segment_count: 1,
      exporter_id: "file/trusted",
    },
    binding: {
      environment_archetype_hash: options.archetypeHash ?? FIXTURE_ARCHETYPE_HASH,
      substrate_lock_core_hash: FIXTURE_SUBSTRATE_HASH,
      collector_image_digest: FIXTURE_IMAGE_DIGEST,
      collector_config_digest: FIXTURE_CONFIG_DIGEST,
    },
    collector: {
      service_id: "otel-collector",
      container_name: `erl2-${runId}-otel-collector`,
      ownership_verified: true as const,
      image_id: "sha256:cafebabe",
      observed_image_repo_digests: [FIXTURE_IMAGE_DIGEST],
      image_matches_locked_digest: true as const,
    },
    artifact: {
      byte_length: Buffer.byteLength(bytes, "utf8"),
      content_digest: hashBytes(Buffer.from(bytes, "utf8")),
      record_count: recordCount,
      finalization: "frozen" as const,
      final_record_terminated: recordCount > 0,
    },
    trace_batches: recordCount,
    spans: options.spans,
    service_names: options.serviceNames,
    run_attributed_records: options.runAttributedRecords,
    trusted_records: bytes,
  };
  return { ...base, core_hash: coreHash(base) } as AttributableTelemetryObservationV2;
}

/** An `absent` v2 record carrying exactly one reason. */
export function absentV2(reasonCode: string, runId = FIXTURE_RUN_ID): AttributableTelemetryObservationV2 {
  const base = {
    schema_version: "attributable-telemetry-observation/v2" as const,
    run_id: runId,
    marker: runId,
    evidence: "absent" as const,
    observed_at: "2026-08-13T00:00:05Z",
    reason_code: reasonCode,
  };
  return { ...base, core_hash: coreHash(base) } as AttributableTelemetryObservationV2;
}

/** Fixture 1 — a complete positive observation: one record, one marked span. */
export function validPositive(archetypeHash?: string): AttributableTelemetryObservationV2 {
  return observedV2({
    bytes: trustedRecords([trustedRecord({})]),
    archetypeHash,
    spans: 1,
    serviceNames: ["quote"],
    runAttributedRecords: 1,
  });
}

/**
 * Fixture 2 — an authentic zero.
 *
 * The channel was provisioned, finalized and empty. This is *not* `absent`:
 * "the collector received nothing" and "no trusted evidence exists" are
 * different facts, and collapsing them is the conflation ADR-ERL2-033 exists to
 * prevent. It is representable, and it authorizes no positive claim.
 */
export function validZero(archetypeHash?: string): AttributableTelemetryObservationV2 {
  return observedV2({
    bytes: "",
    archetypeHash,
    spans: 0,
    serviceNames: [],
    runAttributedRecords: 0,
  });
}

/** Fixture 3 — several bounded records, mixed services, partial attribution. */
export function validMultiRecord(archetypeHash?: string): AttributableTelemetryObservationV2 {
  const bytes = trustedRecords([
    trustedRecord({ markers: [FIXTURE_RUN_ID, FIXTURE_RUN_ID] }),
    trustedRecord({ serviceName: "otel-collector", markers: [undefined] }),
  ]);
  return observedV2({
    bytes,
    archetypeHash,
    spans: 3,
    serviceNames: ["otel-collector", "quote"],
    runAttributedRecords: 2,
  });
}

/**
 * Fixture 4 — an artifact near the retention bound.
 *
 * Built rather than checked in: a 262 144-byte file in the repository would be
 * duplication with no reader, and the property under test is that the *bound*
 * holds, not that any particular quarter-megabyte does.
 */
export function validAtSizeBoundary(archetypeHash?: string): AttributableTelemetryObservationV2 {
  const one = trustedRecord({});
  const perRecord = one.length + 1;
  const count = Math.floor(262_144 / perRecord);
  const bytes = trustedRecords(Array.from({ length: count }, () => one));
  return observedV2({
    bytes,
    archetypeHash,
    spans: count,
    serviceNames: ["quote"],
    runAttributedRecords: count,
  });
}

/** Fixture 5's historical companion: a valid v1 record for the same run. */
export function historicalV1(): Record<string, unknown> {
  const base = {
    schema_version: "attributable-telemetry-observation/v1",
    run_id: FIXTURE_RUN_ID,
    marker: FIXTURE_RUN_ID,
    evidence: "observed",
    observed_at: "2026-08-13T00:00:04Z",
    collector: {
      service_id: "otel-collector",
      container_name: `erl2-${FIXTURE_RUN_ID}-otel-collector`,
      ownership_verified: true,
      image_id: "sha256:cafebabe",
      observed_image_repo_digests: [FIXTURE_IMAGE_DIGEST],
      image_matches_locked_digest: true,
    },
    trace_batches: 1,
    spans: 3,
    service_names: ["quote"],
    run_attributed_records: 1,
    log_excerpt: [
      '2026-08-03T00:00:01.000Z\tinfo\tTraces\t{"otelcol.signal": "traces", "resource spans": 1, "spans": 3}',
      "     -> service.name: Str(quote)",
      `     -> url.full: Str(http://127.0.0.1:18090/getquote?erl2_run=${FIXTURE_RUN_ID})`,
    ].join("\n"),
  };
  return { ...base, core_hash: coreHash(base) };
}
