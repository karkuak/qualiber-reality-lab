/**
 * The attributable-telemetry obligation (ADR-ERL2-033).
 *
 * Three surfaces, each with its own owner and its own negative control:
 *
 * 1. the shared *definitions* — `parseCollectorTelemetry` /
 *    `excerptCollectorTelemetry` — whose excerpt invariant is what lets the
 *    offline verifier recompute every count from retained bytes;
 * 2. the producer's `attributable-telemetry-retained` gate arithmetic, which
 *    binds to declaration and refuses a declared run whose retained
 *    observation is missing, not observed, not this run's, or unattributed;
 * 3. the verifier's `deriveAttributableTelemetry`, which re-derives the
 *    declaration predicate and every count from retained bytes and reads no
 *    producer verdict — the contract stores none.
 *
 * The verifier cases are applied to synthetic retained trees, deliberately:
 * a consistent lie — counts that disagree with the excerpt while every hash
 * still binds — cannot be reached by mutating a real bundle's bytes, because
 * the hash layer refuses first. The end-to-end wiring (a fake-driver run
 * declares nothing, passes the gate, and verifies offline) is asserted against
 * a real CLI run at the bottom.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertContract,
  CODES,
  Erl2Error,
  type AttributableTelemetryObservationV1,
  type Instant,
  type LabLifecycleEventV1,
} from "@erl2/contracts";
import { ArtifactStore, coreHash, hashBytes } from "@erl2/integrity";
import {
  attributableTelemetryDeclared,
  attributableTelemetryGatePassed,
  collectorWindowComplete,
  decideTelemetryObservationWindow,
  excerptCollectorTelemetry,
  MAX_TELEMETRY_EXCERPT_CHARS,
  parseCollectorTelemetry,
  parseTraceSummaryRecord,
  retainAttributableTelemetryObservation,
  supportsAttributableTelemetry,
  TELEMETRY_RETENTION_REASONS,
  TELEMETRY_WINDOW_REASONS,
  type AttributableTelemetryMaterial,
  type CollectorTelemetryCounts,
  type ObservedCollectorIdentity,
} from "@erl2/core";
import { ArtifactIndex, deriveAttributableTelemetry } from "@erl2/public-verifier";
import { ownedTempDir } from "../support/tempDirs.js";
import { drive, selectedRun } from "../support/environmentCli.js";
import { verifyBundle } from "../support/cliRun.js";

const RUN_ID = "00000000-0000-7000-8000-000000000111";
const OTHER_RUN_ID = "00000000-0000-7000-8000-000000000222";

/** A collector log in the debug exporter's shape, with one marked record. */
function collectorLog(marker: string): string {
  // Every record carries its structured context, because every record the
  // collector writes does: a console record's last tab-separated field is that
  // context, and it is what tells a complete record from the opening line of a
  // multi-line one. A fixture without it is a shape the collector never emits.
  return [
    '2026-08-03T00:00:00.000Z\tinfo\tservice@v0.0.1/service.go\tEverything is ready.\t{"resource": {}}',
    '2026-08-03T00:00:01.000Z\tinfo\tTraces\t{"otelcol.signal": "traces", "resource spans": 1, "spans": 3}',
    "     -> service.name: Str(quote)",
    `     -> url.full: Str(http://127.0.0.1:18090/getquote?erl2_run=${marker})`,
    '2026-08-03T00:00:02.000Z\tinfo\tsome unrelated collector chatter\t{"resource": {}}',
  ].join("\n");
}

/**
 * A trace-batch summary exactly as the collector's debug exporter writes one:
 * a complete console record whose message is `Traces` and whose context names
 * the `traces` signal. Anything looser is a shape the collector never emits,
 * and since the parser authenticates the record rather than matching a
 * substring, a looser fixture would be testing something that cannot occur.
 */
function traceSummary(spans: number): string {
  return (
    `2026-08-03T00:00:01.000Z\tinfo\tTraces\t{"otelcol.signal": "traces", ` +
    `"resource spans": 1, "spans": ${String(spans)}}`
  );
}

/**
 * The context line that closes a console record whose message ran over several
 * lines — and, in a window that lost its head, the line that ends the record it
 * began inside. A rotated window always carries one: the cut takes bytes from
 * the front, never the terminator of the record it landed in.
 */
const RECORD_END = '\t{"resource": {"service.name": "otelcol-contrib"}}';

// -- 1. the definitions ------------------------------------------------------

test("ATTR-TELEM: parsing the excerpt reproduces the counts of the full log", () => {
  for (const logs of [
    collectorLog(RUN_ID),
    "",
    "no telemetry at all",
    `${collectorLog(RUN_ID)}\n${collectorLog(RUN_ID)}`,
    `prefix ${RUN_ID} suffix ${RUN_ID} twice on one line`,
    '\tTraces\t{"spans": 7}\n     -> service.name: Str(other)',
  ]) {
    const full = parseCollectorTelemetry(logs, RUN_ID);
    const excerpt = excerptCollectorTelemetry(logs, RUN_ID);
    assert.deepEqual(parseCollectorTelemetry(excerpt, RUN_ID), full);
    // The excerpt is a fixed point: excerpting it again changes nothing.
    assert.equal(excerptCollectorTelemetry(excerpt, RUN_ID), excerpt);
  }
});

test("ATTR-TELEM: excerpting preserves which batch a marked record falls under", () => {
  // The coherence condition is derived from block membership, so the excerpt
  // invariant has to cover it too: the offline verifier recomputes over the
  // excerpt, and a count whose *meaning* changed under excerpting would make
  // the producer and the verifier disagree about what they are counting.
  const orphan = `     -> url.full: Str(http://x/?erl2_run=${RUN_ID})`;
  const summary = traceSummary(7);
  for (const logs of [
    collectorLog(RUN_ID),
    // A window that lost its head: the orphaned dump, the record end that
    // closes it, and only then a summary the collector actually wrote.
    [orphan, RECORD_END, summary, "     -> service.name: Str(quote)"].join("\n"),
    [summary, "chatter", orphan].join("\n"),
    [summary, orphan, summary, orphan].join("\n"),
    [orphan, orphan].join("\n"),
    [`${summary} ${RUN_ID}`].join("\n"),
  ]) {
    const full = parseCollectorTelemetry(logs, RUN_ID);
    const excerpt = excerptCollectorTelemetry(logs, RUN_ID);
    assert.deepEqual(parseCollectorTelemetry(excerpt, RUN_ID), full);
  }
  // And the property the condition rests on: a marked record before the first
  // readable summary line belongs to no batch in this window.
  assert.equal(parseCollectorTelemetry([orphan, orphan].join("\n"), RUN_ID).runAttributedBatches, 0);
  assert.equal(parseCollectorTelemetry([orphan, orphan].join("\n"), RUN_ID).runAttributedRecords, 2);
  assert.equal(parseCollectorTelemetry([summary, orphan].join("\n"), RUN_ID).runAttributedBatches, 1);
  // Two marked lines under one summary are one attributed batch, not two.
  assert.equal(parseCollectorTelemetry([summary, orphan, orphan].join("\n"), RUN_ID).runAttributedBatches, 1);
  // And the new half of the same property: a summary the collector did not
  // frame is not a summary at all, so it opens no batch for the marker under it.
  const forged = `Body: Str(${traceSummary(7)})`;
  assert.equal(parseCollectorTelemetry([forged, orphan].join("\n"), RUN_ID).runAttributedBatches, 0);
  assert.equal(parseCollectorTelemetry([forged, orphan].join("\n"), RUN_ID).spans, 0);
});

test("ATTR-TELEM: the window decision is the single condition, and it fails closed", () => {
  const counts = (logs: string): CollectorTelemetryCounts => parseCollectorTelemetry(logs, RUN_ID);
  const orphan = `     -> url.full: Str(http://x/?erl2_run=${RUN_ID})`;
  const summary = traceSummary(7);

  // A coherent batch is accepted whatever else is true, including with budget
  // left: waiting longer cannot make an already-complete observation truer.
  for (const budgetExhausted of [false, true]) {
    for (const windowComplete of [false, true]) {
      assert.deepEqual(
        decideTelemetryObservationWindow({
          counts: counts([summary, orphan].join("\n")),
          windowComplete,
          budgetExhausted,
        }),
        { decision: "retain" },
      );
    }
  }

  // With budget left and no coherent batch, the answer is always to wait —
  // never to conclude from half a window.
  for (const logs of ["", summary, orphan, [orphan, RECORD_END, summary].join("\n")]) {
    assert.deepEqual(
      decideTelemetryObservationWindow({
        counts: counts(logs),
        windowComplete: false,
        budgetExhausted: false,
      }),
      { decision: "settle" },
    );
  }

  // At exhaustion, records no readable summary counts are themselves the proof
  // that the summary was evicted — refused whether or not the window looks whole.
  for (const windowComplete of [false, true]) {
    assert.deepEqual(
      decideTelemetryObservationWindow({ counts: counts(orphan), windowComplete, budgetExhausted: true }),
      { decision: "refuse", reasonCode: TELEMETRY_WINDOW_REASONS.spanCountOutsideWindow },
    );
  }
  // Nothing of this run, and a window that begins mid-record: no count at all.
  assert.deepEqual(
    decideTelemetryObservationWindow({
      counts: counts("     -> service.name: Str(other)"),
      windowComplete: false,
      budgetExhausted: true,
    }),
    { decision: "refuse", reasonCode: TELEMETRY_WINDOW_REASONS.windowTruncated },
  );
  // Nothing of this run, and a whole window: its own lines are the answer.
  assert.deepEqual(
    decideTelemetryObservationWindow({ counts: counts(""), windowComplete: true, budgetExhausted: true }),
    { decision: "retain" },
  );
  assert.deepEqual(
    decideTelemetryObservationWindow({ counts: counts(summary), windowComplete: true, budgetExhausted: true }),
    { decision: "retain" },
  );
  // The two reason codes are distinct facts and stay distinct.
  assert.notEqual(
    TELEMETRY_WINDOW_REASONS.spanCountOutsideWindow,
    TELEMETRY_WINDOW_REASONS.windowTruncated,
  );
});

/**
 * The hostile line an independent review captured from the pinned collector.
 *
 * It is an ordinary OTLP log record's body, rendered by `otelcol-contrib`
 * v0.157.0 at column zero. Under the unanchored pattern this replaced it was a
 * trace-batch summary, and one of them turned a correctly refused rotated
 * window into a retained observation carrying `spans: 9999`.
 */
const REVIEWED_EXPLOIT =
  'Body: Str(2026-08-13T21:33:32.634Z\tinfo\tTraces\t{"resource spans": 1, "spans": 9999})';

test("ATTR-PARSE: only a whole console record the collector framed states a span count", () => {
  // Authentic, and read exactly.
  assert.deepEqual(parseTraceSummaryRecord(traceSummary(7)), { kind: "summary", spans: 7 });
  // A genuine zero is a fact the window states, not an absence.
  assert.deepEqual(parseTraceSummaryRecord(traceSummary(0)), { kind: "summary", spans: 0 });
  for (const spans of [1, 42, 100_000_000]) {
    assert.deepEqual(parseTraceSummaryRecord(traceSummary(spans)), { kind: "summary", spans });
  }
  // CRLF is the same record.
  assert.deepEqual(parseTraceSummaryRecord(`${traceSummary(7)}\r`), { kind: "summary", spans: 7 });

  // Payload — whatever it contains, and wherever on the line it sits.
  for (const line of [
    REVIEWED_EXPLOIT,
    `     -> ${REVIEWED_EXPLOIT}`,
    `     -> Body: Str(${traceSummary(5)})`,
    "Body: Str(Everything is ready. Begin running and processing data.)",
    ` ${traceSummary(7)}`,
    `\t${traceSummary(7)}`,
    // Another signal's summary is not a trace batch's.
    '2026-08-03T00:00:01.000Z\tinfo\tLogs\t{"otelcol.signal": "logs", "spans": 9999}',
    '2026-08-03T00:00:01.000Z\tinfo\tMetrics\t{"otelcol.signal": "metrics", "spans": 9999}',
    // A record the collector wrote, but not a summary.
    '2026-08-03T00:00:01.000Z\tinfo\tResourceSpans #0',
  ]) {
    assert.equal(parseTraceSummaryRecord(line).kind, "not_summary", line.slice(0, 60));
  }
});

test("ATTR-PARSE: a record shaped like a summary and unreadable as one is malformed, never a zero", () => {
  const claim = (context: string): string =>
    `2026-08-03T00:00:01.000Z\tinfo\tTraces\t${context}`;
  for (const [why, context] of [
    ["truncated context", '{"otelcol.signal": "traces", "spans"'],
    ["duplicated count", '{"otelcol.signal": "traces", "spans": 1, "spans": 9999}'],
    ["negative count", '{"otelcol.signal": "traces", "spans": -1}'],
    ["fractional count", '{"otelcol.signal": "traces", "spans": 1.5}'],
    ["exponent count", '{"otelcol.signal": "traces", "spans": 1e3}'],
    ["leading-zero count", '{"otelcol.signal": "traces", "spans": 007}'],
    ["absent count", '{"otelcol.signal": "traces", "resource spans": 1}'],
    ["past MAX_SAFE_INTEGER", `{"otelcol.signal": "traces", "spans": ${"9".repeat(400)}}`],
  ] as readonly (readonly [string, string])[]) {
    assert.equal(parseTraceSummaryRecord(claim(context)).kind, "malformed", why);
  }
  // A whole authentic record with hostile text appended is not the record.
  assert.equal(
    parseTraceSummaryRecord(`${traceSummary(7)} and then Traces "spans": 9999`).kind,
    "malformed",
  );
  // And a malformed summary refuses the window rather than totalling to zero.
  const counts = parseCollectorTelemetry(claim('{"otelcol.signal": "traces", "spans": -1}'), RUN_ID);
  assert.equal(counts.spans, 0);
  assert.equal(counts.malformedSummaries, 1);
  assert.deepEqual(
    decideTelemetryObservationWindow({ counts, windowComplete: true, budgetExhausted: true }),
    { decision: "refuse", reasonCode: TELEMETRY_WINDOW_REASONS.summaryMalformed },
  );
});

test("ATTR-PARSE: a payload line shaped like a record boundary makes the window ambiguous", () => {
  // A subject's multi-line log body: its continuation lands at column zero, and
  // can therefore carry a whole copied authentic summary. The collector never
  // writes a record boundary inside a record, so the window says it cannot be
  // framed rather than reading the copy.
  const window = [
    "2026-08-03T00:00:01.000Z\tinfo\tResourceLog #0",
    "Body: Str(panic: boom",
    traceSummary(9999),
    ")",
    RECORD_END,
  ].join("\n");
  const counts = parseCollectorTelemetry(window, RUN_ID);
  assert.equal(counts.forgedBoundaries, 1);
  assert.equal(counts.spans, 0, "a copied summary inside payload states nothing");
  assert.equal(counts.traceBatches, 0);
  assert.deepEqual(
    decideTelemetryObservationWindow({ counts, windowComplete: true, budgetExhausted: true }),
    { decision: "refuse", reasonCode: TELEMETRY_WINDOW_REASONS.windowAmbiguous },
  );

  // A window cut mid-record opens *in* payload, so the same copy cannot be read
  // there either — which is the case rotation actually produces.
  const cut = ["     -> service.name: Str(quote)", traceSummary(9999), RECORD_END].join("\n");
  assert.equal(parseCollectorTelemetry(cut, RUN_ID).spans, 0);
  assert.equal(parseCollectorTelemetry(cut, RUN_ID).forgedBoundaries, 1);
});

test("ATTR-PARSE: the reviewed exploit cannot restore a count to a rotated window", () => {
  const orphan = `     -> url.full: Str(http://x/?erl2_run=${RUN_ID})`;
  // The window the correction refuses: this run's records, no summary counting
  // them. Adding the reviewed hostile body must change nothing about it.
  const rotated = [orphan, RECORD_END, orphan].join("\n");
  const attacked = [orphan, RECORD_END, REVIEWED_EXPLOIT, orphan].join("\n");
  const decide = (logs: string): unknown =>
    decideTelemetryObservationWindow({
      counts: parseCollectorTelemetry(logs, RUN_ID),
      windowComplete: collectorWindowComplete(logs),
      budgetExhausted: true,
    });
  const refusal = {
    decision: "refuse",
    reasonCode: TELEMETRY_WINDOW_REASONS.spanCountOutsideWindow,
  };
  assert.deepEqual(decide(rotated), refusal);
  assert.deepEqual(decide(attacked), refusal, "the hostile body changed the outcome");
  assert.equal(parseCollectorTelemetry(attacked, RUN_ID).spans, 0);
  assert.equal(parseCollectorTelemetry(attacked, RUN_ID).runAttributedBatches, 0);
  // And a legitimate window is still observed, so the refusal is not blanket.
  assert.deepEqual(decide([traceSummary(7), orphan].join("\n")), { decision: "retain" });
});

test("ATTR-TELEM: window completeness is a line prefix, because a payload can contain anything", () => {
  const record = "2026-08-03T00:00:01.000Z\tinfo\tservice.go\tStarting GRPC server";
  const dump = "     -> service.name: Str(quote)";
  assert.equal(collectorWindowComplete(`${record}\n${dump}\n`), true);
  assert.equal(collectorWindowComplete(`${dump}\n${record}\n`), false);
  assert.equal(collectorWindowComplete("ResourceSpans #0\n"), false);
  // An empty window is an empty window, not a cut one.
  assert.equal(collectorWindowComplete(""), true);
  assert.equal(collectorWindowComplete("\n\n"), true);

  // The case a live loaded run found, and the reason the check is a prefix
  // rather than a substring: at `verbosity: detailed` the collector exports its
  // own logs back through the debug exporter, so its start-up sentences reappear
  // as record bodies inside later dumps. A window whose head is long gone still
  // contains them, and a substring test would call it whole.
  const reExported = [
    "Body: Str(Everything is ready. Begin running and processing data.)",
    "     -> service.name: Str(otelcol-contrib)",
    record,
  ].join("\n");
  assert.equal(reExported.includes("Everything is ready"), true);
  assert.equal(
    collectorWindowComplete(reExported),
    false,
    "a re-exported start-up sentence was mistaken for the collector's own start",
  );
});

test("ATTR-TELEM: two markers on one line count as two run-attributed records", () => {
  const counts = parseCollectorTelemetry(`a ${RUN_ID} b ${RUN_ID} c`, RUN_ID);
  assert.equal(counts.runAttributedRecords, 2);
  assert.equal(parseCollectorTelemetry(collectorLog(RUN_ID), "").runAttributedRecords, 0);
});

test("ATTR-TELEM: service names are deduplicated and sorted", () => {
  const logs = "service.name: Str(zeta)\nservice.name: Str(alpha)\nservice.name: Str(zeta)";
  assert.deepEqual(parseCollectorTelemetry(logs, RUN_ID).serviceNames, ["alpha", "zeta"]);
});

// -- 2. the contract ---------------------------------------------------------

function observedRecord(
  mutate?: (base: Record<string, unknown>) => void,
): AttributableTelemetryObservationV1 {
  const excerpt = excerptCollectorTelemetry(collectorLog(RUN_ID), RUN_ID);
  const counts = parseCollectorTelemetry(excerpt, RUN_ID);
  const base: Record<string, unknown> = {
    schema_version: "attributable-telemetry-observation/v1",
    run_id: RUN_ID,
    marker: RUN_ID,
    evidence: "observed",
    observed_at: "2026-08-03T00:00:05Z",
    collector: {
      service_id: "otel-collector",
      container_name: `erl2-${RUN_ID}-otel-collector`,
      ownership_verified: true,
      image_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      observed_image_repo_digests: ["example/collector@sha256:bbbb"],
      image_matches_locked_digest: true,
    },
    trace_batches: counts.traceBatches,
    spans: counts.spans,
    service_names: counts.serviceNames,
    run_attributed_records: counts.runAttributedRecords,
    log_excerpt: excerpt,
  };
  mutate?.(base);
  return { ...base, core_hash: coreHash(base) } as AttributableTelemetryObservationV1;
}

test("ATTR-TELEM-CONTRACT: a valid observed record and a valid absent record both validate", () => {
  assertContract("AttributableTelemetryObservationV1", observedRecord());
  const absentBase = {
    schema_version: "attributable-telemetry-observation/v1",
    run_id: RUN_ID,
    marker: RUN_ID,
    evidence: "absent",
    observed_at: "2026-08-03T00:00:05Z",
    reason_code: "collector_not_verified",
  };
  assertContract("AttributableTelemetryObservationV1", {
    ...absentBase,
    core_hash: coreHash(absentBase),
  });
});

test("ATTR-TELEM-CONTRACT: an absent record cannot carry a count, an excerpt or a collector", () => {
  for (const smuggled of [
    { run_attributed_records: 1 },
    { trace_batches: 1 },
    { spans: 1 },
    { service_names: ["quote"] },
    { log_excerpt: "some collector line" },
  ]) {
    const base = {
      schema_version: "attributable-telemetry-observation/v1",
      run_id: RUN_ID,
      marker: RUN_ID,
      evidence: "absent",
      observed_at: "2026-08-03T00:00:05Z",
      reason_code: "collector_not_verified",
      ...smuggled,
    };
    assert.throws(
      () => assertContract("AttributableTelemetryObservationV1", { ...base, core_hash: coreHash(base) }),
      (error: { code?: string }) => error.code === CODES.SCHEMA_VALIDATION_FAILED,
    );
  }
});

test("ATTR-TELEM-CONTRACT: an observed record without its excerpt, or over an unverified collector, is unrepresentable", () => {
  for (const mutate of [
    (base: Record<string, unknown>): void => {
      delete base["log_excerpt"];
    },
    (base: Record<string, unknown>): void => {
      base["reason_code"] = "also_a_reason";
    },
    (base: Record<string, unknown>): void => {
      (base["collector"] as Record<string, unknown>)["ownership_verified"] = false;
    },
    (base: Record<string, unknown>): void => {
      (base["collector"] as Record<string, unknown>)["image_matches_locked_digest"] = false;
    },
  ]) {
    assert.throws(
      () => assertContract("AttributableTelemetryObservationV1", observedRecord(mutate)),
      (error: { code?: string }) => error.code === CODES.SCHEMA_VALIDATION_FAILED,
    );
  }
});

// -- 3. the producer gate ----------------------------------------------------

const DECLARING = {
  driverKind: "compose",
  evidenceSources: [{ source_id: "service-metric", kind: "metric", required: true }],
  outcomes: [{ intent: "exercise", status: "succeeded", run_id: RUN_ID }],
} as unknown as Parameters<typeof attributableTelemetryDeclared>[0];

test("ATTR-TELEM: the declaration predicate needs the driver, the source and the exercising step together", () => {
  assert.equal(attributableTelemetryDeclared(DECLARING), true);
  assert.equal(attributableTelemetryDeclared({ ...DECLARING, driverKind: "fake" }), false);
  assert.equal(
    attributableTelemetryDeclared({
      ...DECLARING,
      evidenceSources: [{ source_id: "deployment-log", kind: "deployment", required: true }],
    } as unknown as Parameters<typeof attributableTelemetryDeclared>[0]),
    false,
  );
  assert.equal(
    attributableTelemetryDeclared({
      ...DECLARING,
      outcomes: [{ intent: "exercise", status: "failed", run_id: RUN_ID }],
    } as unknown as Parameters<typeof attributableTelemetryDeclared>[0]),
    false,
  );
});

test("ATTR-TELEM: an undeclared run passes the gate with no observation at all", () => {
  assert.equal(
    attributableTelemetryGatePassed({ declared: false, runId: RUN_ID, observations: [] }),
    true,
  );
});

test("ATTR-TELEM: a declared run with no observation fails the gate", () => {
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [] }),
    false,
  );
});

test("ATTR-TELEM: a declared run with an absent observation fails the gate", () => {
  const absentBase = {
    schema_version: "attributable-telemetry-observation/v1",
    run_id: RUN_ID,
    marker: RUN_ID,
    evidence: "absent",
    observed_at: "2026-08-03T00:00:05Z",
    reason_code: "collector_not_verified",
  };
  const absent = { ...absentBase, core_hash: coreHash(absentBase) } as AttributableTelemetryObservationV1;
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [absent] }),
    false,
  );
});

test("ATTR-TELEM: a declared run with zero run-attributed records fails the gate", () => {
  const zero = observedRecord((base) => {
    base["run_attributed_records"] = 0;
  });
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [zero] }),
    false,
  );
});

test("ATTR-TELEM: another run's observation, a foreign marker, or a second observation fails the gate", () => {
  const good = observedRecord();
  const foreignRun = observedRecord((base) => {
    base["run_id"] = OTHER_RUN_ID;
  });
  const foreignMarker = observedRecord((base) => {
    base["marker"] = OTHER_RUN_ID;
  });
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [foreignRun] }),
    false,
  );
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [foreignMarker] }),
    false,
  );
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [good, good] }),
    false,
  );
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [good] }),
    true,
  );
});

test("ATTR-TELEM: the fake driver does not offer the capability", () => {
  assert.equal(supportsAttributableTelemetry({}), false);
  assert.equal(supportsAttributableTelemetry(undefined), false);
  assert.equal(
    supportsAttributableTelemetry({ observeAttributableTelemetry: (): void => undefined }),
    true,
  );
});

// -- 4. the verifier derivation, over synthetic retained trees ---------------

interface SyntheticTree {
  readonly index: ArtifactIndex;
  readonly lifecycle: readonly LabLifecycleEventV1[];
}

interface SyntheticOptions {
  readonly driverKind?: string;
  readonly sourceKind?: string;
  readonly exerciseStatus?: string;
  readonly observation?: AttributableTelemetryObservationV1 | "none";
  /** A second observation produced under the same role, to test cardinality. */
  readonly secondObservation?: AttributableTelemetryObservationV1;
  readonly producedBy?: string;
  /** Extra driver manifests / archetypes produced, to test preconditions. */
  readonly duplicateManifest?: boolean;
  readonly duplicateArchetype?: boolean;
}

/** Writes a minimal retained tree the derivation can scan, and its lifecycle. */
function syntheticTree(options: SyntheticOptions = {}): SyntheticTree {
  const root = ownedTempDir("erl2-attr-telem-");
  const retained = path.join(root, "retained", "environment");
  mkdirSync(retained, { recursive: true });

  const write = (name: string, value: { readonly core_hash: string }): void => {
    writeFileSync(path.join(retained, name), `${JSON.stringify(value)}\n`);
  };

  const manifestBase = {
    schema_version: "environment-driver-manifest/v1",
    driver_id: "compose-driver",
    driver_kind: options.driverKind ?? "compose",
  };
  const manifest = { ...manifestBase, core_hash: coreHash(manifestBase) };
  write("driver-manifest.json", manifest);

  const archetypeBase = {
    schema_version: "environment-archetype/v1",
    evidence_sources: [
      { source_id: "service-metric", kind: options.sourceKind ?? "metric", required: true },
    ],
  };
  const archetype = { ...archetypeBase, core_hash: coreHash(archetypeBase) };
  write("archetype.json", archetype);

  const outcomeBase = {
    schema_version: "journey-step-outcome/v1",
    run_id: RUN_ID,
    intent: "exercise",
    status: options.exerciseStatus ?? "succeeded",
  };
  const outcome = { ...outcomeBase, core_hash: coreHash(outcomeBase) };
  write("step-outcome-exercise.json", outcome);

  const observation = options.observation === "none" ? undefined : options.observation ?? observedRecord();
  if (observation !== undefined) write("attributable-telemetry-observation.json", observation);
  if (options.secondObservation !== undefined) {
    write("attributable-telemetry-observation-2.json", options.secondObservation);
  }

  const event = (eventType: string, produced: readonly Record<string, string>[]): LabLifecycleEventV1 =>
    ({ event_type: eventType, produced }) as unknown as LabLifecycleEventV1;
  const lifecycle: LabLifecycleEventV1[] = [
    event("environment_provisioned", [
      {
        artifact_role: "environment-driver-manifest",
        artifact_core_hash: manifest.core_hash,
        artifact_schema_version: "environment-driver-manifest/v1",
      },
      ...(options.duplicateManifest === true
        ? [
            {
              artifact_role: "environment-driver-manifest",
              artifact_core_hash: manifest.core_hash,
              artifact_schema_version: "environment-driver-manifest/v1",
            },
          ]
        : []),
      {
        artifact_role: "environment-archetype",
        artifact_core_hash: archetype.core_hash,
        artifact_schema_version: "environment-archetype/v1",
      },
      ...(options.duplicateArchetype === true
        ? [
            {
              artifact_role: "environment-archetype",
              artifact_core_hash: archetype.core_hash,
              artifact_schema_version: "environment-archetype/v1",
            },
          ]
        : []),
    ]),
    event("subject_exercise_outcome_frozen", [
      {
        artifact_role: "journey-step-outcome",
        artifact_core_hash: outcome.core_hash,
        artifact_schema_version: "journey-step-outcome/v1",
      },
    ]),
    ...(observation === undefined
      ? []
      : [
          event(options.producedBy ?? "teardown_started", [
            {
              artifact_role: "attributable-telemetry-observation",
              artifact_core_hash: observation.core_hash,
              artifact_schema_version: "attributable-telemetry-observation/v1",
            },
            ...(options.secondObservation === undefined
              ? []
              : [
                  {
                    artifact_role: "attributable-telemetry-observation",
                    artifact_core_hash: options.secondObservation.core_hash,
                    artifact_schema_version: "attributable-telemetry-observation/v1",
                  },
                ]),
          ]),
        ]),
  ];

  return { index: ArtifactIndex.scan(root), lifecycle };
}

function refusalCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

test("ATTR-TELEM-VERIFY: a consistent declared observation derives observed and attributed", () => {
  const tree = syntheticTree();
  const report = deriveAttributableTelemetry({ ...tree, runId: RUN_ID });
  assert.deepEqual(report, { declared: true, observed: true, runAttributedRecords: 1 });
});

test("ATTR-TELEM-VERIFY: a declared run that retains no observation is refused", () => {
  const tree = syntheticTree({ observation: "none" });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_OBSERVATION_MISSING,
  );
});

test("ATTR-TELEM-VERIFY: an undeclared run with no observation derives nothing and refuses nothing", () => {
  for (const tree of [
    syntheticTree({ driverKind: "fake", observation: "none" }),
    syntheticTree({ sourceKind: "deployment", observation: "none" }),
    syntheticTree({ exerciseStatus: "failed", observation: "none" }),
  ]) {
    const report = deriveAttributableTelemetry({ ...tree, runId: RUN_ID });
    assert.deepEqual(report, { declared: false, observed: false, runAttributedRecords: 0 });
  }
});

test("ATTR-TELEM-VERIFY: an absent observation where declared is refused", () => {
  const absentBase = {
    schema_version: "attributable-telemetry-observation/v1",
    run_id: RUN_ID,
    marker: RUN_ID,
    evidence: "absent",
    observed_at: "2026-08-03T00:00:05Z",
    reason_code: "collector_not_verified",
  };
  const tree = syntheticTree({
    observation: { ...absentBase, core_hash: coreHash(absentBase) } as AttributableTelemetryObservationV1,
  });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_NOT_ATTRIBUTED,
  );
});

test("ATTR-TELEM-VERIFY: a declared observation with zero run-attributed records is refused", () => {
  const unmarked = excerptCollectorTelemetry(collectorLog(OTHER_RUN_ID), RUN_ID);
  const counts = parseCollectorTelemetry(unmarked, RUN_ID);
  const observation = observedRecord((base) => {
    base["trace_batches"] = counts.traceBatches;
    base["spans"] = counts.spans;
    base["service_names"] = counts.serviceNames;
    base["run_attributed_records"] = counts.runAttributedRecords;
    base["log_excerpt"] = unmarked;
  });
  assert.equal(counts.runAttributedRecords, 0);
  const tree = syntheticTree({ observation });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_NOT_ATTRIBUTED,
  );
});

test("ATTR-TELEM-VERIFY: counts that contradict the retained excerpt are refused", () => {
  const inflated = observedRecord((base) => {
    base["run_attributed_records"] = 5;
  });
  const tree = syntheticTree({ observation: inflated });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );
});

/**
 * The literal artifact the failed clean gate recorded: records naming this run,
 * and a span count of zero that no readable summary ever stated.
 *
 * The producer cannot mint one any more. These cases are about the *other*
 * authority: an artifact is durable evidence, and the offline verifier must
 * refuse an incoherent one on the retained bytes alone, without asking the
 * producer whether it was careful.
 */
function preFixArtifact(): AttributableTelemetryObservationV1 {
  const orphan = `     -> url.full: Str(http://x/?erl2_run=${RUN_ID})`;
  const excerpt = [orphan, orphan].join("\n");
  const counts = parseCollectorTelemetry(excerpt, RUN_ID);
  assert.equal(counts.runAttributedRecords, 2, "the fixture must carry attribution");
  assert.equal(counts.runAttributedBatches, 0, "and no batch that counted it");
  return observedRecord((base) => {
    base["log_excerpt"] = excerpt;
    base["trace_batches"] = counts.traceBatches;
    base["spans"] = counts.spans;
    base["service_names"] = counts.serviceNames;
    base["run_attributed_records"] = counts.runAttributedRecords;
  });
}

test("ATTR-TELEM-VERIFY: the literal pre-correction artifact is refused on its own bytes", () => {
  const observation = preFixArtifact();
  // Every producer-supplied counter agrees with the excerpt — this artifact is
  // self-consistent, which is exactly why cross-checking counters was not
  // enough. What refuses it is the *relationship* the verifier now re-derives.
  assert.equal(observation.spans, 0);
  assert.equal(observation.run_attributed_records, 2);
  const tree = syntheticTree({ observation });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );
});

test("ATTR-TELEM-VERIFY: a forged summary in the excerpt is refused, not counted", () => {
  // The reviewed exploit, retained. Under the pattern this replaced, the
  // verifier would have re-derived 9999 from these same bytes and agreed with a
  // producer that had also been fooled — two authorities, one shared mistake.
  const orphan = `     -> url.full: Str(http://x/?erl2_run=${RUN_ID})`;
  const excerpt = [orphan, REVIEWED_EXPLOIT, orphan].join("\n");
  const counts = parseCollectorTelemetry(excerpt, RUN_ID);
  assert.equal(counts.spans, 0, "the forged line states nothing");
  const observation = observedRecord((base) => {
    base["log_excerpt"] = excerpt;
    base["trace_batches"] = counts.traceBatches;
    base["spans"] = counts.spans;
    base["service_names"] = counts.serviceNames;
    base["run_attributed_records"] = counts.runAttributedRecords;
  });
  const tree = syntheticTree({ observation });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );
});

test("ATTR-TELEM-VERIFY: an excerpt whose framing is ambiguous or unreadable is refused", () => {
  const cases: readonly (readonly [string, string])[] = [
    // A record boundary inside payload: the excerpt cannot be framed.
    [
      "forged boundary",
      ["2026-08-03T00:00:01.000Z\tinfo\tResourceLog #0", traceSummary(7), RECORD_END].join("\n"),
    ],
    // A summary record nobody can read is not a summary that counted nothing.
    [
      "malformed summary",
      '2026-08-03T00:00:01.000Z\tinfo\tTraces\t{"otelcol.signal": "traces", "spans": -1}',
    ],
  ];
  for (const [why, excerpt] of cases) {
    const counts = parseCollectorTelemetry(excerpt, RUN_ID);
    const observation = observedRecord((base) => {
      base["log_excerpt"] = excerpt;
      base["trace_batches"] = counts.traceBatches;
      base["spans"] = counts.spans;
      base["service_names"] = counts.serviceNames;
      base["run_attributed_records"] = counts.runAttributedRecords;
    });
    const tree = syntheticTree({ observation });
    assert.equal(
      refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
      CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
      why,
    );
  }
});

test("ATTR-TELEM-VERIFY: an honest complete zero still verifies, because zero is not incoherence", () => {
  // A whole window that genuinely received nothing states zero with no
  // attribution at all. The coherence floor is about *attribution* without a
  // counting batch, so it must leave this untouched.
  const excerpt = "";
  const counts = parseCollectorTelemetry(excerpt, RUN_ID);
  assert.equal(counts.runAttributedRecords, 0);
  const observation = observedRecord((base) => {
    base["log_excerpt"] = excerpt;
    base["trace_batches"] = counts.traceBatches;
    base["spans"] = counts.spans;
    base["service_names"] = counts.serviceNames;
    base["run_attributed_records"] = counts.runAttributedRecords;
  });
  // Undeclared, because a *declared* run with no attribution is refused by the
  // floor that already existed. What is under test here is that the new
  // coherence refusal does not fire on an honest zero.
  const tree = syntheticTree({ observation, exerciseStatus: "failed" });
  const report = deriveAttributableTelemetry({ ...tree, runId: RUN_ID });
  assert.equal(report.declared, false);
  assert.equal(report.observed, true);
  assert.equal(report.runAttributedRecords, 0);
});

test("ATTR-TELEM-VERIFY: an excerpt padded with non-contributing lines is refused", () => {
  const excerpt = excerptCollectorTelemetry(collectorLog(RUN_ID), RUN_ID);
  const observation = observedRecord((base) => {
    base["log_excerpt"] = `${excerpt}\nan idle line that contributes to no count`;
  });
  const tree = syntheticTree({ observation });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );
});

test("ATTR-TELEM-VERIFY: another run's observation, a foreign marker, or a wrong producing event is refused", () => {
  const foreignRun = observedRecord((base) => {
    base["run_id"] = OTHER_RUN_ID;
  });
  assert.equal(
    refusalCode(() =>
      deriveAttributableTelemetry({ ...syntheticTree({ observation: foreignRun }), runId: RUN_ID }),
    ),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );

  const foreignMarker = observedRecord((base) => {
    base["marker"] = OTHER_RUN_ID;
  });
  assert.equal(
    refusalCode(() =>
      deriveAttributableTelemetry({
        ...syntheticTree({ observation: foreignMarker }),
        runId: RUN_ID,
      }),
    ),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );

  assert.equal(
    refusalCode(() =>
      deriveAttributableTelemetry({
        ...syntheticTree({ producedBy: "environment_restored" }),
        runId: RUN_ID,
      }),
    ),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );
});

test("ATTR-TELEM-VERIFY: a second retained observation is refused rather than silently ignored", () => {
  const second = observedRecord((base) => {
    base["run_attributed_records"] = 99;
    base["observed_at"] = "2026-08-03T00:00:09Z";
  });
  const tree = syntheticTree({ secondObservation: second });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );
});

test("ATTR-TELEM-VERIFY: an ambiguous driver manifest or archetype is refused before anything is derived", () => {
  for (const options of [{ duplicateManifest: true }, { duplicateArchetype: true }]) {
    assert.equal(
      refusalCode(() =>
        deriveAttributableTelemetry({ ...syntheticTree(options), runId: RUN_ID }),
      ),
      CODES.ENV_SUBSTRATE_BINDING_MISMATCH,
    );
  }
});

test("ATTR-TELEM-VERIFY: an observed record whose excerpt the index never validated is still refused", () => {
  // ArtifactIndex.typed checks the schema_version string and the recomputed
  // core hash and nothing else, so a record the contract would refuse still
  // reaches the derivation. The defensive branch is not dead code.
  const noExcerpt = observedRecord((base) => {
    delete base["log_excerpt"];
  });
  const tree = syntheticTree({ observation: noExcerpt });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_OBSERVATION_MISMATCH,
  );
});

// -- 4b. the retention path: what freezes, and what is demoted instead -------

/**
 * `retainAttributableTelemetryObservation` is the production retention path —
 * the same function `EnvironmentRun.destroy` calls before `teardown_started`,
 * over a real `ArtifactStore` and a stand-in observer.
 *
 * It is driven here rather than through a run because the properties that
 * matter are reachable with no substrate at all, and the reason EQ-L-004
 * survived a green suite and three green CI runs is that nothing without a
 * Docker daemon had ever executed this code. Two of those properties:
 *
 * 1. **re-entry reads what it wrote.** Deleting that branch reintroduces the
 *    `ARTIFACT_ALREADY_FROZEN` wedge `d803e66` closed — the condition the
 *    telemetry ledger names as why the original defect went unnoticed.
 * 2. **collector bytes the Lab cannot freeze demote, never throw.** One
 *    decomposed accent on one retained line used to leave `destroy` through an
 *    untyped `CanonicalizationError`, before any lifecycle event, with the
 *    containers still live.
 */

/** A collector's material, `observed` and retainable unless a case says otherwise. */
function material(
  overrides: {
    readonly counts?: Partial<CollectorTelemetryCounts>;
    readonly excerpt?: string;
    readonly collector?: Partial<ObservedCollectorIdentity>;
    readonly marker?: string;
  } = {},
): AttributableTelemetryMaterial {
  const excerpt = overrides.excerpt ?? excerptCollectorTelemetry(collectorLog(RUN_ID), RUN_ID);
  return {
    evidence: "observed",
    marker: overrides.marker ?? RUN_ID,
    excerpt,
    counts: { ...parseCollectorTelemetry(excerpt, RUN_ID), ...overrides.counts },
    collector: {
      serviceId: "otel-collector",
      containerName: `erl2-${RUN_ID}-otel-collector`,
      imageId: `sha256:${"a".repeat(64)}`,
      observedImageRepoDigests: [`example/collector@sha256:${"b".repeat(64)}`],
      ...overrides.collector,
    },
  };
}

const OBSERVATION_PATH = "retained/environment/attributable-telemetry-observation.json";

/**
 * Retains `materials[0]`, then `materials[1]`, … against one store, exactly as
 * a run and its resumed successor would — with the clock moving between calls,
 * which is what makes a second observation's bytes differ from the first's.
 */
function retainAll(
  materials: readonly AttributableTelemetryMaterial[],
): readonly AttributableTelemetryObservationV1[] {
  const store = new ArtifactStore(ownedTempDir("erl2-attr-retain-"));
  let tick = 0;
  return materials.map((current) =>
    retainAttributableTelemetryObservation({
      store,
      observationPath: OBSERVATION_PATH,
      observer: { observeAttributableTelemetry: () => current },
      runId: RUN_ID,
      observedAt: () => `2026-08-03T00:00:${String(10 + tick++).padStart(2, "0")}Z` as Instant,
    }),
  );
}

/** The single retained record for one material. */
function retain(current: AttributableTelemetryMaterial): AttributableTelemetryObservationV1 {
  return retainAll([current])[0] as AttributableTelemetryObservationV1;
}

/** The record a demoting case must produce: absent, with exactly this reason. */
function assertDemoted(current: AttributableTelemetryMaterial, reasonCode: string): void {
  const observation = retain(current);
  assert.equal(observation.evidence, "absent", "retainable bytes were expected to demote");
  assert.equal(observation.reason_code, reasonCode);
  // The demotion is only honest if the run can still reach a terminal on it:
  // the gate refuses it where declared, and the record itself is frozen.
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [observation] }),
    false,
    "a demoted observation must fail the gate of a run that declared one",
  );
}

test("ATTR-TELEM-RETAIN: ordinary collector material freezes as observed and passes the gate", () => {
  const observation = retain(material());
  assert.equal(observation.evidence, "observed");
  assert.equal(observation.log_excerpt, excerptCollectorTelemetry(collectorLog(RUN_ID), RUN_ID));
  assert.equal(observation.run_attributed_records, 1);
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [observation] }),
    true,
  );
});

test("ATTR-TELEM-RETAIN: a re-entered retention reads what it wrote instead of observing again", () => {
  // The crash window `d803e66` closed: the freeze precedes the lifecycle event
  // that anchors it, so a resumed `destroy` finds the artifact already frozen.
  // Re-observing would take a fresh `observed_at` over a collector log that has
  // moved on, and freezing those bytes at the same path is
  // `ARTIFACT_ALREADY_FROZEN` — a wedge no retry can clear.
  const moved = material({
    excerpt: excerptCollectorTelemetry(
      `${collectorLog(RUN_ID)}\n\tTraces\t{"spans": 11}`,
      RUN_ID,
    ),
  });
  const [first, second] = retainAll([material(), moved]);
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(second.core_hash, first.core_hash, "a resumed retention re-froze different bytes");
  assert.equal(second.observed_at, first.observed_at);
  assert.equal(second.spans, first.spans);
});

test("ATTR-TELEM-RETAIN: an excerpt past the retention bound demotes rather than truncating", () => {
  // An excerpt cut short derives counts that are not this run's.
  const line = `\t${RUN_ID}\t`;
  assertDemoted(
    material({ excerpt: `${line}\n`.repeat(Math.ceil(MAX_TELEMETRY_EXCERPT_CHARS / line.length)) }),
    TELEMETRY_RETENTION_REASONS.excerptOverBound,
  );
});

test("ATTR-TELEM-RETAIN: an excerpt the canonicalizer refuses demotes rather than throwing", () => {
  // EQ-L-004, in one character. macOS stores filenames decomposed, so a subject
  // serving a URL derived from an accented filename emits NFD with no adversary
  // anywhere — and the marker rides on that very line, which is why the excerpt
  // retains it. Every `service_names` value here is plain ASCII.
  const decomposed = [
    '2026-08-03T00:00:01.000Z\tinfo\tTraces\t{"spans": 3}',
    "     -> service.name: Str(quote)",
    `     -> url.full: Str(http://127.0.0.1:8090/café?erl2_run=${RUN_ID})`,
  ].join("\n");
  const excerpt = excerptCollectorTelemetry(decomposed, RUN_ID);
  assert.notEqual(excerpt.normalize("NFC"), excerpt, "the case must actually be non-NFC");
  assert.deepEqual(parseCollectorTelemetry(excerpt, RUN_ID).serviceNames, ["quote"]);

  const observation = retain(material({ excerpt }));
  assert.equal(observation.evidence, "absent");
  assert.equal(observation.reason_code, TELEMETRY_RETENTION_REASONS.excerptNotCanonicalizable);
  // Never normalized into hashability: the excerpt is meant to be what the
  // collector emitted, and no retained field carries a rewritten copy of it.
  assert.equal(observation.log_excerpt, undefined);
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [observation] }),
    false,
  );
});

test("ATTR-TELEM-RETAIN: more distinct service names than the contract retains demotes", () => {
  assertDemoted(
    material({ counts: { serviceNames: Array.from({ length: 257 }, (_, i) => `svc-${i}`).sort() } }),
    TELEMETRY_RETENTION_REASONS.serviceNamesOverCardinality,
  );
});

test("ATTR-TELEM-RETAIN: a service name past the contract's length bound demotes", () => {
  assertDemoted(
    material({ counts: { serviceNames: ["s".repeat(257)] } }),
    TELEMETRY_RETENTION_REASONS.serviceNameOverLength,
  );
});

test("ATTR-TELEM-RETAIN: a service name the canonicalizer refuses demotes", () => {
  // `OTEL_SERVICE_NAME` is the subject's to choose, and a decomposed accent in
  // it reaches the canonicalizer with no excerpt involved at all. An empty
  // name is retainable — `Str()` parses to `""` — and must not demote.
  assertDemoted(
    material({ counts: { serviceNames: ["café"] } }),
    TELEMETRY_RETENTION_REASONS.serviceNameNotCanonicalizable,
  );
  assert.equal(retain(material({ counts: { serviceNames: [""] } })).evidence, "observed");
});

test("ATTR-TELEM-RETAIN: a digit run too long to represent never becomes a count", () => {
  // This used to reach `Infinity`: the count was matched as a digit run and
  // handed to `Number.parseInt`, so the *retention* bound was the first thing
  // that noticed. The parser notices now, which is a stronger place for it —
  // an unreadable count is refused before it is ever summed into a total.
  const overflowing = `2026-08-03T00:00:01.000Z\tinfo\tTraces\t{"otelcol.signal": "traces", "spans": ${"9".repeat(400)}}`;
  assert.equal(parseTraceSummaryRecord(overflowing).kind, "malformed");

  const counts = parseCollectorTelemetry(overflowing, RUN_ID);
  assert.equal(counts.spans, 0);
  assert.equal(Number.isFinite(counts.spans), true);
  assert.equal(counts.malformedSummaries, 1);
  // And it is refused rather than retained as the zero it now totals to.
  assert.deepEqual(
    decideTelemetryObservationWindow({ counts, windowComplete: true, budgetExhausted: true }),
    { decision: "refuse", reasonCode: TELEMETRY_WINDOW_REASONS.summaryMalformed },
  );
});

test("ATTR-TELEM-RETAIN: a count outside the contract's range demotes", () => {
  assertDemoted(
    material({ counts: { spans: 100_000_001 } }),
    TELEMETRY_RETENTION_REASONS.countNotRepresentable,
  );
});

test("ATTR-TELEM-RETAIN: a collector service id the contract refuses demotes", () => {
  assertDemoted(
    material({ collector: { serviceId: "Otel_Collector" } }),
    TELEMETRY_RETENTION_REASONS.collectorIdentityOverBound,
  );
});

test("ATTR-TELEM-RETAIN: more observed repo digests than the contract retains demotes", () => {
  assertDemoted(
    material({
      collector: {
        observedImageRepoDigests: Array.from({ length: 17 }, (_, i) => `example/c${i}@sha256:${"b".repeat(64)}`),
      },
    }),
    TELEMETRY_RETENTION_REASONS.collectorIdentityOverBound,
  );
});

test("ATTR-TELEM-RETAIN: a collector identity string past its bound demotes", () => {
  assertDemoted(
    material({ collector: { containerName: "c".repeat(257) } }),
    TELEMETRY_RETENTION_REASONS.collectorIdentityOverBound,
  );
});

test("ATTR-TELEM-RETAIN: a collector identity string the canonicalizer refuses demotes", () => {
  assertDemoted(
    material({ collector: { containerName: "erl2-café-otel-collector" } }),
    TELEMETRY_RETENTION_REASONS.collectorIdentityNotCanonicalizable,
  );
});

test("ATTR-TELEM-RETAIN: a driver's own absent material is retained with the driver's reason", () => {
  const observation = retain({
    evidence: "absent",
    marker: RUN_ID,
    reasonCode: "collector_not_verified",
  });
  assert.equal(observation.evidence, "absent");
  assert.equal(observation.reason_code, "collector_not_verified");
});

test("ATTR-TELEM-RETAIN: a retention failure nothing anticipated still leaves as a routable teardown failure", () => {
  // The invariant EQ-L-004 broke: `destroy` routes exactly `TEARDOWN_FAILED`
  // (`environmentCommands.ts`), and this call runs before `teardown_started`.
  // Anything that leaves here in another class is rethrown by the CLI, so the
  // run reaches no terminal and the substrate is never destroyed. The marker
  // rides both branches, so an unretainable one is a failure no demotion can
  // absorb — and it must still arrive as a code the caller can classify.
  for (const cause of [
    (): AttributableTelemetryMaterial => material({ marker: "café" }),
    (): AttributableTelemetryMaterial => {
      throw new TypeError("the driver read something that was not there");
    },
  ]) {
    const store = new ArtifactStore(ownedTempDir("erl2-attr-retain-"));
    assert.throws(
      () =>
        retainAttributableTelemetryObservation({
          store,
          observationPath: OBSERVATION_PATH,
          observer: { observeAttributableTelemetry: cause },
          runId: RUN_ID,
          observedAt: () => "2026-08-03T00:00:10Z" as Instant,
        }),
      (error: unknown) =>
        error instanceof Erl2Error &&
        error.code === CODES.TEARDOWN_FAILED &&
        error.owner === "lab",
    );
  }
});

test("ATTR-TELEM-RETAIN: a demoted observation is refused offline, not quietly accepted", () => {
  // Invalid-with-cleanup is the correct outcome, and the offline verifier must
  // reach it independently: a demotion the producer records and the verifier
  // shrugs at would be a pass engineered out of a refusal.
  const observation = retain(material({ counts: { serviceNames: ["café"] } }));
  const tree = syntheticTree({ observation });
  assert.equal(
    refusalCode(() => deriveAttributableTelemetry({ ...tree, runId: RUN_ID })),
    CODES.ENV_TELEMETRY_NOT_ATTRIBUTED,
  );
});

// -- 5. end to end: the fake-driver path is untouched ------------------------

test("ATTR-TELEM-E2E: a fake-driver run declares nothing, retains nothing, and still verifies offline", () => {
  const run = selectedRun();
  assert.equal(drive(run), "generic_finalized");

  // No observation was produced, and the validity gate is present and passing.
  const validity = JSON.parse(
    readFileSync(path.join(run.runRoot, "retained", "validity-result.json"), "utf8"),
  ) as {
    readonly gate_results: readonly { readonly gate_id: string; readonly passed: boolean }[];
  };
  const gate = validity.gate_results.find((g) => g.gate_id === "attributable-telemetry-retained");
  assert.ok(gate, "the attributable-telemetry-retained gate is evaluated on every environment terminal");
  assert.equal(gate?.passed, true);
  assert.equal(
    existsSync(
      path.join(run.runRoot, "retained", "environment", "attributable-telemetry-observation.json"),
    ),
    false,
    "a fake-driver run must not retain a telemetry observation",
  );

  const verified = verifyBundle(run.runRoot, {
    sourceTrustPolicyHash: run.registry.sourceTrustPolicyHash,
  });
  assert.equal(verified.exitCode, 0, JSON.stringify(verified.body.errors));
});
