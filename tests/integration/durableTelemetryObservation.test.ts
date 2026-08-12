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
  completedCapture,
} from "../support/durableTelemetry.js";
import { ownedTempDir } from "../support/tempDirs.js";

const RUN = "019ff778-31d9-7d9c-8a16-287b446c9794";
const OTHER_RUN = "019ff999-0000-7000-8000-000000000000";

/**
 * A follower we can fail on demand.
 *
 * The failure modes that matter — the command not starting, an immediate
 * non-zero exit, a stream error mid-run — are properties of the child process,
 * not of Docker, so they are injected rather than provoked. Requiring a live
 * daemon to test "the daemon refused us" would leave exactly these paths
 * untested on every machine that has no Docker.
 */
function fakeFollower(): {
  readonly child: ChildProcess;
  killed: boolean;
  fail(cause: Error): void;
  exit(code: number | null, signal?: NodeJS.Signals): void;
  streamError(cause: Error): void;
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const streamListeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const emit = (
    map: Map<string, ((...args: unknown[]) => void)[]>,
    event: string,
    ...args: unknown[]
  ): void => {
    for (const listener of map.get(event) ?? []) listener(...args);
  };
  const state = {
    child: {
      on(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return this;
      },
      stdout: {
        on(event: string, listener: (...args: unknown[]) => void) {
          streamListeners.set(event, [...(streamListeners.get(event) ?? []), listener]);
          return this;
        },
      },
      kill: () => {
        state.killed = true;
        return true;
      },
    } as unknown as ChildProcess,
    killed: false,
    fail: (cause: Error) => emit(listeners, "error", cause),
    exit: (code: number | null, signal?: NodeJS.Signals) =>
      emit(listeners, "exit", code, signal ?? null),
    streamError: (cause: Error) => emit(streamListeners, "error", cause),
  };
  return state;
}

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
  const observation = awaitDurableTelemetry({ capture: completedCapture(file), runId: RUN, attempts: 1 });
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
  const observation = awaitDurableTelemetry({ capture: completedCapture(file), runId: RUN, attempts: 1 });
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
  const observation = awaitDurableTelemetry({ capture: completedCapture(file), runId: RUN, attempts: 1 });
  assert.equal(observation.diagnosticCode, "TRACE_NOT_EMITTED");
  assert.equal(observation.collectorReceivedTraceData, false);
  assert.equal(observation.currentRunSpanCount, 0);
});

test("DURABLE-TELEMETRY: an unreadable capture claims nothing about telemetry", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const observation = awaitDurableTelemetry({
    capture: completedCapture(path.join(dir, "never-written.log")),
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
  const observation = awaitDurableTelemetry({ capture: completedCapture(file), runId: RUN, attempts: 1 });
  assert.equal(observation.diagnosticCode, "CURRENT_RUN_SPANS_OBSERVED");
  assert.equal(observation.currentRunSpanCount, 3, "the incomplete batch contributes nothing");
});

test("DURABLE-TELEMETRY: malformed output yields no count rather than a wrong one", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const file = captureIn(
    dir,
    ["not a log line at all", "\tTraces\tno json here", "{\"spans\": \"three\"}", ""].join("\n"),
  );
  const observation = awaitDurableTelemetry({ capture: completedCapture(file), runId: RUN, attempts: 1 });
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
  const observation = awaitDurableTelemetry({ capture: completedCapture(file), runId: RUN, attempts: 1 });
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
    capture: completedCapture(file),
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
    capture: completedCapture(file),
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
  const observation = awaitDurableTelemetry({ capture: completedCapture(file), runId: RUN, attempts: 1 });
  assert.equal(observation.diagnosticCode, "TRACE_RUN_ATTRIBUTION_MISSING");
  assert.equal(observation.currentRunSpanCount, 0);
});

// -- ownership and the property the whole module exists for ------------------

test("DURABLE-TELEMETRY: dispose removes the task-owned capture file", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const container = "erl2-test-collector";
  const follower = fakeFollower();
  const capture = startCollectorCapture({
    containerName: container,
    directory: dir,
    spawnProcess: () => follower.child,
  });
  assert.equal(existsSync(capture.capturePath), true, "the capture file is created on attach");
  writeFileSync(capture.capturePath, batch({ spans: 1, marker: RUN }));
  capture.dispose();
  assert.equal(follower.killed, true, "the follower is detached");
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

  const observation = awaitDurableTelemetry({ capture: completedCapture(file), runId: RUN, attempts: 1 });
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

// -- follower readiness: "we could not look" is not "nothing was emitted" ----

/**
 * The capture file is created by `openSync` before the follower is known to
 * have attached, so its existence proves only that a path was opened. An
 * observer that reads that empty file and reports `TRACE_NOT_EMITTED` states
 * that the collector received nothing, which it has not established — the same
 * false claim the durable capture exists to remove, moved from "the line
 * rotated away" to "we never attached".
 */
test("DURABLE-TELEMETRY: a follower that cannot start is unavailable, not silent", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const capture = startCollectorCapture({
    containerName: "erl2-missing-collector",
    directory: dir,
    spawnProcess: () => {
      throw new Error("spawn docker ENOENT");
    },
  });
  assert.equal(existsSync(capture.capturePath), true, "the file exists and still proves nothing");
  assert.equal(capture.readiness().usable, false);

  const observation = awaitDurableTelemetry({ capture, runId: RUN, attempts: 2, sleep: () => undefined });
  assert.equal(observation.diagnosticCode, "TRACE_OBSERVATION_UNAVAILABLE");
  assert.equal(observation.observationComplete, false);
  assert.deepEqual(observation.evidenceRefs, []);
  assert.match(explainDurableTelemetry(observation), /nothing is claimed about telemetry/);
  capture.dispose();
  assert.equal(existsSync(capture.capturePath), false);
});

test("DURABLE-TELEMETRY: a follower that exits with an error is unavailable, not silent", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const follower = fakeFollower();
  const capture = startCollectorCapture({
    containerName: "erl2-missing-collector",
    directory: dir,
    spawnProcess: () => follower.child,
  });
  // What `docker container logs --follow <missing>` actually does: it writes
  // the daemon's refusal into the very file we are about to read, then exits 1.
  writeFileSync(capture.capturePath, "Error response from daemon: No such container: erl2-missing-collector\n");
  follower.exit(1);

  const observation = awaitDurableTelemetry({ capture, runId: RUN, attempts: 2, sleep: () => undefined });
  assert.equal(observation.diagnosticCode, "TRACE_OBSERVATION_UNAVAILABLE");
  assert.equal(observation.collectorReceivedTraceData, false);
  assert.match(explainDurableTelemetry(observation), /exited early with status 1/);
  capture.dispose();
});

test("DURABLE-TELEMETRY: an attach that fails asynchronously is unavailable", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const follower = fakeFollower();
  const capture = startCollectorCapture({
    containerName: "erl2-collector",
    directory: dir,
    spawnProcess: () => follower.child,
  });
  follower.fail(new Error("connect EACCES /var/run/docker.sock"));
  const observation = awaitDurableTelemetry({ capture, runId: RUN, attempts: 2, sleep: () => undefined });
  assert.equal(observation.diagnosticCode, "TRACE_OBSERVATION_UNAVAILABLE");
  assert.match(explainDurableTelemetry(observation), /failed to attach/);
  capture.dispose();
});

test("DURABLE-TELEMETRY: a stream failure mid-run is a truncated observation, not an absence", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const follower = fakeFollower();
  const capture = startCollectorCapture({
    containerName: "erl2-collector",
    directory: dir,
    spawnProcess: () => follower.child,
  });
  // Another run's batch arrived before the stream broke. Without the readiness
  // check this reads as a complete observation of a run that emitted nothing.
  writeFileSync(capture.capturePath, batch({ spans: 4, marker: OTHER_RUN }));
  follower.streamError(new Error("EPIPE"));

  const observation = awaitDurableTelemetry({ capture, runId: RUN, attempts: 2, sleep: () => undefined });
  assert.equal(observation.diagnosticCode, "TRACE_OBSERVATION_UNAVAILABLE");
  assert.equal(observation.observationComplete, false);
  capture.dispose();
});

test("DURABLE-TELEMETRY: an attached follower that sees nothing still reports not emitted", () => {
  // The distinction has to cut both ways, or it is just a way of never failing.
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const follower = fakeFollower();
  const capture = startCollectorCapture({
    containerName: "erl2-collector",
    directory: dir,
    spawnProcess: () => follower.child,
  });
  writeFileSync(capture.capturePath, "2026-08-12T19:44:00.000Z\tinfo\tservice started\n");
  assert.equal(capture.readiness().usable, true);

  const observation = awaitDurableTelemetry({ capture, runId: RUN, attempts: 2, sleep: () => undefined });
  assert.equal(observation.diagnosticCode, "TRACE_NOT_EMITTED");
  assert.equal(observation.observationComplete, true);
  capture.dispose();
});

test("DURABLE-TELEMETRY: an attached follower that sees this run's spans succeeds", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const follower = fakeFollower();
  const capture = startCollectorCapture({
    containerName: "erl2-collector",
    directory: dir,
    spawnProcess: () => follower.child,
  });
  writeFileSync(capture.capturePath, batch({ spans: 3, marker: RUN }));

  const observation = awaitDurableTelemetry({ capture, runId: RUN, attempts: 2, sleep: () => undefined });
  assert.equal(observation.diagnosticCode, "CURRENT_RUN_SPANS_OBSERVED");
  assert.equal(observation.currentRunSpanCount, 3);
  capture.dispose();
});

test("DURABLE-TELEMETRY: a follower that ends cleanly leaves a usable capture", () => {
  // The container's log ending is not a failure: exit 0 means we saw all of it.
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const follower = fakeFollower();
  const capture = startCollectorCapture({
    containerName: "erl2-collector",
    directory: dir,
    spawnProcess: () => follower.child,
  });
  writeFileSync(capture.capturePath, batch({ spans: 2, marker: RUN }));
  follower.exit(0);
  assert.equal(capture.readiness().usable, true);

  const observation = awaitDurableTelemetry({ capture, runId: RUN, attempts: 1 });
  assert.equal(observation.diagnosticCode, "CURRENT_RUN_SPANS_OBSERVED");
  capture.dispose();
});

test("DURABLE-TELEMETRY: the follower we asked to stop is not reported as a failure", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  const follower = fakeFollower();
  const capture = startCollectorCapture({
    containerName: "erl2-collector",
    directory: dir,
    spawnProcess: () => follower.child,
  });
  writeFileSync(capture.capturePath, batch({ spans: 1, marker: RUN }));
  capture.stop();
  follower.exit(null, "SIGTERM");
  assert.equal(follower.killed, true, "the follower is always terminated");
  assert.equal(capture.readiness().usable, true, "our own SIGTERM is not an attach failure");
  capture.dispose();
  assert.equal(existsSync(capture.capturePath), false, "cleanup runs after a stop");
});

test("DURABLE-TELEMETRY: cleanup removes the capture after every failure mode", () => {
  for (const provoke of [
    (f: ReturnType<typeof fakeFollower>) => f.fail(new Error("attach failed")),
    (f: ReturnType<typeof fakeFollower>) => f.exit(1),
    (f: ReturnType<typeof fakeFollower>) => f.streamError(new Error("EPIPE")),
  ]) {
    const dir = ownedTempDir("erl2-durable-telemetry-");
    const follower = fakeFollower();
    const capture = startCollectorCapture({
      containerName: "erl2-collector",
      directory: dir,
      spawnProcess: () => follower.child,
    });
    provoke(follower);
    capture.dispose();
    assert.equal(existsSync(capture.capturePath), false);
    assert.equal(follower.killed, true);
  }
});

// -- block boundaries and cross-run isolation --------------------------------

/**
 * A batch belongs to the run named inside *its own* dump.
 *
 * The boundary that ends a dump is the next signal summary, and it has to be
 * exactly that. Drawn too narrowly — at "the next console record" — it cuts the
 * dump off from the attributes the run marker rides in, and every batch becomes
 * unattributed; that regression was found once and is pinned below. Drawn too
 * widely — or not at all — an earlier batch keeps reading forward into later
 * batches and inherits their markers, so a previous run's spans are credited to
 * this one. An independent review confirmed the second direction was unguarded:
 * a mutation that never terminated a block credited 107 spans from another run
 * to the current one and no test objected.
 */
const CROSS_RUN_CAPTURE = [
  batch({ spans: 100, marker: OTHER_RUN, at: "2026-08-12T20:00:00.000Z" }),
  batch({ spans: 7, marker: RUN, at: "2026-08-12T20:05:00.000Z" }),
].join("");

test("DURABLE-TELEMETRY: an earlier run's batch is not absorbed by a later run", () => {
  const parsed = parseDurableTelemetry(CROSS_RUN_CAPTURE, RUN);
  assert.equal(parsed.traceBatches, 2);
  assert.equal(
    parsed.currentRunSpanCount,
    7,
    "only the spans inside this run's own block may be credited to it",
  );
  assert.equal(parsed.otherRunSpanCount, 100, "the earlier batch stays attributed to the earlier run");
  assert.equal(parsed.unattributedSpanCount, 0);
});

test("DURABLE-TELEMETRY: the block boundary is load-bearing in both directions", () => {
  // Narrow direction: the dump's own first line carries a console prefix, so a
  // boundary at "the next console record" would strip the attributes away.
  const single = batch({ spans: 5, marker: RUN });
  assert.match(single, /\tinfo\tResourceSpans #0/, "the fixture reproduces the real console layout");
  assert.equal(parseDurableTelemetry(single, RUN).currentRunSpanCount, 5);

  // Wide direction: reading past the boundary reaches the later run's marker.
  const [first] = CROSS_RUN_CAPTURE.split("2026-08-12T20:05:00.000Z\tinfo\tTraces");
  assert.ok(first !== undefined && first.includes(OTHER_RUN) && !first.includes(RUN),
    "the first block names only the other run, so any credit to this run came from across the boundary");
});

test("DURABLE-TELEMETRY: this run's marker appearing later never rescues an earlier batch", () => {
  // The reverse order of the cross-run fixture: our marker is in the *first*
  // block, and an unterminated scan would push it onto the later batch too.
  const capture = [
    batch({ spans: 2, marker: RUN, at: "2026-08-12T20:00:00.000Z" }),
    batch({ spans: 40, marker: OTHER_RUN, at: "2026-08-12T20:05:00.000Z" }),
  ].join("");
  const parsed = parseDurableTelemetry(capture, RUN);
  assert.equal(parsed.currentRunSpanCount, 2);
  assert.equal(parsed.otherRunSpanCount, 40);
});

test("DURABLE-TELEMETRY: a non-trace summary ends a trace block without being counted", () => {
  // Metrics and logs summaries terminate the preceding dump; they are not
  // trace batches and contribute no spans.
  const capture = [
    batch({ spans: 6, marker: RUN, at: "2026-08-12T20:00:00.000Z" }),
    SELF_TELEMETRY,
    batch({ spans: 9, marker: OTHER_RUN, at: "2026-08-12T20:05:00.000Z" }),
  ].join("");
  const parsed = parseDurableTelemetry(capture, RUN);
  assert.equal(parsed.traceBatches, 2, "the logs summary is not a trace batch");
  assert.equal(parsed.currentRunSpanCount, 6);
  assert.equal(parsed.otherRunSpanCount, 9);
});

test("DURABLE-TELEMETRY: a summary-only terminal block is incomplete, not empty", () => {
  const dir = ownedTempDir("erl2-durable-telemetry-");
  // The stream was read between the summary line and its dump.
  const file = captureIn(
    dir,
    `${SELF_TELEMETRY}2026-08-12T20:05:00.000Z\tinfo\tTraces\t{"resource spans": 1, "spans": 3}\n`,
  );
  const observation = awaitDurableTelemetry({
    capture: completedCapture(file),
    runId: RUN,
    attempts: 1,
  });
  assert.equal(
    observation.diagnosticCode,
    "TRACE_OBSERVATION_UNAVAILABLE",
    "a batch caught mid-write must not be reported as this run emitting nothing",
  );
  assert.equal(observation.observationComplete, false);
  assert.match(explainDurableTelemetry(observation), /unterminated trace batch/);
});

test("DURABLE-TELEMETRY: a complete terminal block is not treated as truncated", () => {
  // The distinction must not simply mark every last block incomplete: the
  // ordinary case ends with a fully written dump and no summary after it.
  const parsed = parseDurableTelemetry(batch({ spans: 9, marker: OTHER_RUN }), RUN);
  assert.equal(parsed.terminalBlockTruncated, false);

  const dir = ownedTempDir("erl2-durable-telemetry-");
  const file = captureIn(dir, batch({ spans: 9, marker: OTHER_RUN }));
  const observation = awaitDurableTelemetry({
    capture: completedCapture(file),
    runId: RUN,
    attempts: 1,
  });
  assert.equal(observation.diagnosticCode, "TRACE_RUN_ATTRIBUTION_MISSING");
  assert.equal(observation.observationComplete, true);
});
