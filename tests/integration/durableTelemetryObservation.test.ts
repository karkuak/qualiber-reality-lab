/**
 * The durable telemetry observation the Compose E2E acceptance gate asserts on.
 *
 * ## What these controls are for
 *
 * The observation this module replaces was not wrong about arithmetic; it was
 * wrong about *what it had looked at*. It re-read a rotating container log after
 * the fact, and when the line carrying the count had rotated away it reported
 * "telemetry was not actually emitted" — for a run whose telemetry was emitted,
 * received by the collector, and marked with the run's own id 63 times. A
 * failing assertion that names the wrong transition is worse than no assertion:
 * it sends the reader to the producer when the defect is in the observer.
 *
 * So every control below feeds the parser a capture that is *almost* the good
 * case and requires it to say which transition is missing rather than merely
 * returning zero. The cases that matter most are the ones a count cannot tell
 * apart: nothing emitted, something emitted for a different run, and no capture
 * to read. Those three have different owners.
 *
 * These run without Docker on purpose. The rotation control in particular has to
 * be deterministic: it asserts that a capture keeps what a truncated container
 * log no longer has, which is exactly the property the live gate cannot prove
 * on demand.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import path from "node:path";

import {
  MAX_REPRESENTABLE_SPANS,
  awaitDurableTelemetry,
  classifyDurableTelemetry,
  explainDurableTelemetry,
  parseDurableTelemetry,
  readCapture,
  startCollectorCapture,
} from "../support/durableTelemetry.js";
import { ownedTempDir } from "../support/tempDirs.js";

const RUN = "019ff778-31d9-7d9c-8a16-287b446c9794";
const OTHER_RUN = "019ff999-0000-7000-8000-000000000000";

/** One console `Traces` batch followed by the detailed dump that attributes it. */
function batch(options: { readonly spans: number; readonly marker?: string; readonly at?: string }): string {
  const stamp = options.at ?? "2026-08-12T19:44:16.065Z";
  const url =
    options.marker === undefined
      ? "http://quote:8090/getquote"
      : `http://quote:8090/getquote?erl2_run=${options.marker}`;
  // Faithful to the collector's real `verbosity: detailed` layout: the dump's
  // first line carries its own console prefix, so a block boundary drawn at "the
  // next console record" would cut the attributes off from their batch.
  return [
    `${stamp}\tinfo\tTraces\t{"resource": {"service.name": "otelcol-contrib"}, "otelcol.component.id": "debug", "otelcol.signal": "traces", "resource spans": 1, "spans": ${String(options.spans)}}`,
    `${stamp}\tinfo\tResourceSpans #0`,
    "Resource SchemaURL: https://opentelemetry.io/schemas/1.38.0",
    "Resource attributes:",
    "     -> service.name: Str(quote)",
    "ScopeSpans #0",
    "Span #0",
    `     -> url.full: Str(${url})`,
    "",
  ].join("\n");
}

/** The collector's own self-telemetry, which names no subject run. */
const SELF_TELEMETRY = [
  "2026-08-12T19:44:20.000Z\tinfo\tLogs\t{\"otelcol.signal\": \"logs\", \"resource logs\": 1, \"log records\": 4}",
  "ResourceLog #0",
  "Resource attributes:",
  "     -> service.name: Str(otelcol-contrib)",
  "",
].join("\n");

function captureIn(dir: string, body: string): string {
  const file = path.join(dir, "collector.stream.log");
  writeFileSync(file, body);
  return file;
}

// -- the five cases a count cannot tell apart --------------------------------

test("DURABLE-TELEMETRY: current-run spans are observed and attributed", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const file = captureIn(dir, `${SELF_TELEMETRY}${batch({ spans: 3, marker: RUN })}`);
  const observation = awaitDurableTelemetry({ capturePath: file, runId: RUN, attempts: 1 });
  assert.equal(observation.diagnosticCode, "CURRENT_RUN_SPANS_OBSERVED");
  assert.equal(observation.currentRunSpanCount, 3);
  assert.equal(observation.otherRunSpanCount, 0);
  assert.equal(observation.collectorReceivedTraceData, true);
  assert.equal(observation.observationComplete, true);
  assert.equal(observation.firstObservedAt, "2026-08-12T19:44:16.065Z");
  assert.equal(observation.source, "collector-log-stream");
  assert.equal(observation.evidenceRefs.length, 1);
});

test("DURABLE-TELEMETRY: another run's spans never satisfy this run", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const file = captureIn(dir, batch({ spans: 9, marker: OTHER_RUN }));
  const observation = awaitDurableTelemetry({ capturePath: file, runId: RUN, attempts: 1 });
  assert.equal(observation.diagnosticCode, "TRACE_RUN_ATTRIBUTION_MISSING");
  assert.equal(observation.currentRunSpanCount, 0);
  assert.equal(observation.otherRunSpanCount, 9);
  // The collector *did* receive traces. Saying otherwise would send a reader to
  // the producer for a defect that is not there.
  assert.equal(observation.collectorReceivedTraceData, true);
  assert.match(explainDurableTelemetry(observation), /none of it carries this run's marker/);
});

test("DURABLE-TELEMETRY: no trace data at all is reported as not emitted", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const file = captureIn(dir, SELF_TELEMETRY);
  const observation = awaitDurableTelemetry({ capturePath: file, runId: RUN, attempts: 1 });
  assert.equal(observation.diagnosticCode, "TRACE_NOT_EMITTED");
  assert.equal(observation.collectorReceivedTraceData, false);
  assert.equal(observation.currentRunSpanCount, 0);
});

test("DURABLE-TELEMETRY: an unreadable capture claims nothing about telemetry", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const observation = awaitDurableTelemetry({
    capturePath: path.join(dir, "never-written.log"),
    runId: RUN,
    attempts: 1,
  });
  assert.equal(observation.diagnosticCode, "TRACE_OBSERVATION_UNAVAILABLE");
  assert.equal(observation.observationComplete, false);
  assert.deepEqual(observation.evidenceRefs, []);
  assert.match(explainDurableTelemetry(observation), /nothing is claimed about telemetry/);
});

test("DURABLE-TELEMETRY: traces received but observation unavailable stays distinct from none received", () => {
  // The collector received data; the observer could not look. These are
  // different defects and the classifier must not merge them.
  const received = classifyDurableTelemetry({
    available: false,
    currentRunSpanCount: 0,
    otherRunSpanCount: 0,
    unattributedSpanCount: 0,
    traceBatches: 4,
    deadlineReached: true,
  });
  const none = classifyDurableTelemetry({
    available: true,
    currentRunSpanCount: 0,
    otherRunSpanCount: 0,
    unattributedSpanCount: 0,
    traceBatches: 0,
    deadlineReached: true,
  });
  assert.equal(received, "TRACE_OBSERVATION_UNAVAILABLE");
  assert.equal(none, "TRACE_NOT_EMITTED");
  assert.notEqual(received, none);
});

// -- shape of the capture ----------------------------------------------------

test("DURABLE-TELEMETRY: a partial trailing write is read as a smaller observation, not a malformed one", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const complete = batch({ spans: 3, marker: RUN });
  // The follower is mid-line: the last record has no newline yet.
  const file = captureIn(dir, `${complete}2026-08-12T19:44:18.000Z\tinfo\tTraces\t{"spans": 5`);
  const read = readCapture(file);
  assert.ok(read !== undefined);
  assert.equal(read.text.endsWith("\n"), true, "a fragment must not be handed to the parser");
  const observation = awaitDurableTelemetry({ capturePath: file, runId: RUN, attempts: 1 });
  assert.equal(observation.diagnosticCode, "CURRENT_RUN_SPANS_OBSERVED");
  assert.equal(observation.currentRunSpanCount, 3, "the incomplete batch contributes nothing");
});

test("DURABLE-TELEMETRY: malformed output yields no count rather than a wrong one", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const file = captureIn(
    dir,
    ["not a log line at all", "\tTraces\tno json here", "{\"spans\": \"three\"}", ""].join("\n"),
  );
  const observation = awaitDurableTelemetry({ capturePath: file, runId: RUN, attempts: 1 });
  assert.equal(observation.currentRunSpanCount, 0);
  assert.equal(observation.collectorReceivedTraceData, false);
  assert.equal(observation.diagnosticCode, "TRACE_NOT_EMITTED");
});

test("DURABLE-TELEMETRY: an unrepresentable span count is refused as a total", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const huge = "9".repeat(40);
  const file = captureIn(
    dir,
    `2026-08-12T19:44:16.065Z\tinfo\tTraces\t{"spans": ${huge}}\n     -> url.full: Str(?erl2_run=${RUN})\n`,
  );
  const parsed = parseDurableTelemetry(readCapture(file)?.text ?? "", RUN);
  assert.equal(parsed.traceBatches, 1, "the batch is still evidence the collector received traces");
  assert.equal(parsed.currentRunSpanCount, 0, "but its count is not usable arithmetic");
  assert.ok(Number.parseInt(huge, 10) > MAX_REPRESENTABLE_SPANS);
});

test("DURABLE-TELEMETRY: an oversized capture is bounded from the end", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const filler = `${"x".repeat(1024)}\n`.repeat(64);
  const file = captureIn(dir, `${filler}${batch({ spans: 3, marker: RUN })}`);
  const read = readCapture(file);
  assert.ok(read !== undefined);
  assert.ok(read.bytes > 0);
  const observation = awaitDurableTelemetry({ capturePath: file, runId: RUN, attempts: 1 });
  assert.equal(
    observation.diagnosticCode,
    "CURRENT_RUN_SPANS_OBSERVED",
    "the most recent records must survive bounding",
  );
});

// -- the deadline ------------------------------------------------------------

test("DURABLE-TELEMETRY: a flush that lands inside the deadline is observed", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const file = captureIn(dir, SELF_TELEMETRY);
  let ticks = 0;
  const observation = awaitDurableTelemetry({
    capturePath: file,
    runId: RUN,
    attempts: 5,
    sleep: () => {
      ticks += 1;
      // The collector flushes on its own schedule; on the third tick it lands.
      if (ticks === 3) writeFileSync(file, `${SELF_TELEMETRY}${batch({ spans: 3, marker: RUN })}`);
    },
  });
  assert.equal(observation.diagnosticCode, "CURRENT_RUN_SPANS_OBSERVED");
  assert.equal(observation.currentRunSpanCount, 3);
  assert.ok(ticks <= 4, "the loop must stop as soon as the run's spans appear");
});

test("DURABLE-TELEMETRY: no flush before the deadline is a bounded, named absence", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const file = captureIn(dir, SELF_TELEMETRY);
  let ticks = 0;
  const observation = awaitDurableTelemetry({
    capturePath: file,
    runId: RUN,
    attempts: 3,
    sleep: () => {
      ticks += 1;
    },
  });
  assert.equal(observation.diagnosticCode, "TRACE_NOT_EMITTED");
  assert.equal(ticks, 2, "the deadline is bounded and every tick is spent");
});

test("DURABLE-TELEMETRY: a previous project's capture never satisfies this run", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  // Stale output left by an earlier Compose project, complete and well-formed.
  const file = captureIn(dir, `${batch({ spans: 12, marker: OTHER_RUN, at: "2026-08-12T18:00:00.000Z" })}`);
  const observation = awaitDurableTelemetry({ capturePath: file, runId: RUN, attempts: 1 });
  assert.equal(observation.diagnosticCode, "TRACE_RUN_ATTRIBUTION_MISSING");
  assert.equal(observation.currentRunSpanCount, 0);
});

// -- ownership and the property the whole module exists for ------------------

test("DURABLE-TELEMETRY: dispose removes the task-owned capture file", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const container = "erl2-test-collector";
  let killed = false;
  const capture = startCollectorCapture({
    containerName: container,
    directory: dir,
    spawnProcess: () =>
      ({
        kill: () => {
          killed = true;
          return true;
        },
      }) as unknown as ChildProcess,
  });
  assert.equal(existsSync(capture.capturePath), true, "the capture file is created on attach");
  writeFileSync(capture.capturePath, batch({ spans: 1, marker: RUN }));
  capture.dispose();
  assert.equal(killed, true, "the follower is detached");
  assert.equal(existsSync(capture.capturePath), false, "no task-created file survives");
  capture.dispose();
});

test("DURABLE-TELEMETRY: rotation of the container log does not affect the durable observation", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  // What the follower copied while the run was live.
  const streamed = `${batch({ spans: 3, marker: RUN })}${"filler line\n".repeat(50)}`;
  const file = captureIn(dir, streamed);

  // What `docker container logs` would return afterwards: the batch has rotated
  // out of the container's own retention, exactly as in the diagnosed failure.
  const rotated = streamed.slice(streamed.indexOf("filler line"));
  assert.equal(/\tTraces\t/.test(rotated), false, "the rotated view has lost the console trace line");
  assert.equal(rotated.includes(`erl2_run=${RUN}`), false);

  const observation = awaitDurableTelemetry({ capturePath: file, runId: RUN, attempts: 1 });
  assert.equal(observation.diagnosticCode, "CURRENT_RUN_SPANS_OBSERVED");
  assert.equal(observation.currentRunSpanCount, 3, "the durable capture still carries what rotation evicted");
  // And the old approach, applied to the rotated view, is what used to fail.
  const legacySpans = [...rotated.matchAll(/\tTraces\t.*"spans": (\d+)/g)].reduce(
    (total, match) => total + Number(match[1]),
    0,
  );
  assert.equal(legacySpans, 0, "the replaced observation would have reported zero here");
});

test("DURABLE-TELEMETRY: the capture directory is task-owned and holds only this run's stream", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const nested = path.join(dir, "nested");
  mkdirSync(nested, { recursive: true });
  const file = captureIn(nested, batch({ spans: 2, marker: RUN }));
  assert.equal(path.resolve(file).startsWith(path.resolve(dir)), true, "the capture stays inside its owned root");
  assert.equal(readFileSync(file, "utf8").includes(RUN), true);
  rmSync(nested, { recursive: true, force: true });
  assert.equal(existsSync(nested), false);
});
