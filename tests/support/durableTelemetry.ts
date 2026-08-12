/**
 * Durable, run-attributed observation of what the run's collector received.
 *
 * ## The defect this replaces
 *
 * The Compose E2E test used to derive its span count by repeatedly running
 * `docker container logs <collector>` after the fact and matching the console
 * exporter's `Traces` summary line. The pinned collector container is created
 * with upstream's rotating `json-file` options (`max-size=5m`, `max-file=2`),
 * and the collector's own self-telemetry is exported back through the `debug`
 * exporter at `verbosity: detailed`, so a loaded run writes megabytes in
 * seconds. A diagnosed failure had three successful `POST /getquote` requests,
 * HTTP 200 responses, spans emitted, spans received, and `erl2_run=` present 63
 * times — and still asserted "telemetry was not actually emitted", because the
 * console line carrying the count had already rotated out of `docker logs`
 * before the polling loop read it. The first 48.9 seconds of that container's
 * output were simply gone.
 *
 * ## Why a stream rather than a re-read
 *
 * The fix is not to read the rotating log more patiently — a longer poll reads
 * the same evicted window — and not to enlarge the retention, which only moves
 * the cliff. It is to stop depending on the container's log *retention* at all:
 * `docker container logs --follow` is attached once, as soon as the collector
 * exists, and everything it emits is copied to a task-owned file as it is
 * produced. Rotation inside the container evicts nothing that has already been
 * written here, so the observation is durable by construction rather than by
 * being quick enough.
 *
 * This is deliberately the smallest reliable option. It changes no substrate:
 * no collector configuration, no Compose overlay, no mount, no image, no
 * release digest, and no product code path. `docker logs` is read-only — it
 * copies the container's existing output and changes nothing about the run —
 * so the observed environment is byte-for-byte the one the product provisions.
 *
 * ## What it refuses to collapse
 *
 * A count alone cannot tell "nothing was emitted" from "something was emitted
 * for a different run" from "we could not look". Each of those is a different
 * defect with a different owner, so the observation returns them as distinct
 * diagnostic codes and the caller asserts on the first missing transition
 * rather than on a falsy number.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** Where the observation came from, so evidence names its own source. */
export const DURABLE_TELEMETRY_SOURCE = "collector-log-stream";

/**
 * The first missing transition, named.
 *
 * Ordered by how far the run got: a later code strictly implies every earlier
 * transition succeeded.
 */
export type TelemetryDiagnosticCode =
  | "TRACE_OBSERVATION_UNAVAILABLE"
  | "TRACE_NOT_EMITTED"
  | "TRACE_RUN_ATTRIBUTION_MISSING"
  | "TRACE_OBSERVATION_TIMEOUT"
  | "CURRENT_RUN_SPANS_OBSERVED";

/** One structured observation of the run's collector. */
export interface DurableTelemetryObservation {
  readonly source: string;
  readonly currentRunSpanCount: number;
  readonly otherRunSpanCount: number;
  readonly collectorReceivedTraceData: boolean;
  readonly observationComplete: boolean;
  readonly firstObservedAt: string | undefined;
  readonly diagnosticCode: TelemetryDiagnosticCode;
  readonly evidenceRefs: readonly string[];
}

/**
 * Bounds. The capture is a test artifact, not a log sink: a runaway collector
 * must not fill the disk, and a parser must not be handed an unbounded string.
 */
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
/** A span count wider than this is a parse artifact, never a real batch. */
export const MAX_REPRESENTABLE_SPANS = 1_000_000;

/**
 * The console exporter's per-batch summary, which carries the only count the
 * collector states directly. Matched mid-line so a stream prefix cannot hide it.
 */
const TRACE_BATCH_LINE = /\tTraces\t.*?"spans": (\d+)/;
/**
 * The start of the next exported batch, of any signal, which is what ends the
 * preceding one's dump.
 *
 * Not "the next console record": at `verbosity: detailed` the dump's own first
 * line is a console record too (`…\tinfo\tResourceSpans #0`), so ending a block
 * there would discard the very attributes the run marker rides in — the batch
 * would be counted and then attributed to nobody.
 */
const SIGNAL_SUMMARY_LINE = /\t(?:Traces|Metrics|Logs|Profiles)\t\{/;
/** A run marker as the reference adapter writes it into the request URL. */
const RUN_MARKER = /erl2_run=([0-9a-fA-F-]{1,64})/g;

/** A live `docker logs --follow` copy of one container's output. */
export interface CollectorCapture {
  readonly containerName: string;
  readonly capturePath: string;
  /** Detach the follower and stop writing. Safe to call more than once. */
  stop(): void;
  /** Remove the task-owned capture file. Implies `stop()`. */
  dispose(): void;
}

/**
 * Attach to a container's output and copy it to a task-owned file.
 *
 * Attached without `--timestamps`: the collector already stamps its own console
 * records, and a second prefix would only complicate the parse. `--follow`
 * replays the log from the beginning and then streams, so attaching as soon as
 * the container exists captures the whole of it.
 */
export function startCollectorCapture(options: {
  readonly containerName: string;
  readonly directory: string;
  readonly spawnProcess?: (command: string, args: readonly string[], fd: number) => ChildProcess;
}): CollectorCapture {
  const capturePath = path.join(options.directory, `${options.containerName}.stream.log`);
  const fd = openSync(capturePath, "w");
  const args = ["container", "logs", "--follow", options.containerName];
  const child =
    options.spawnProcess === undefined
      ? spawn("docker", [...args], { stdio: ["ignore", fd, fd] })
      : options.spawnProcess("docker", args, fd);
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    child.kill("SIGTERM");
    try {
      closeSync(fd);
    } catch {
      // Already closed by the child's exit; nothing to release.
    }
  };
  return {
    containerName: options.containerName,
    capturePath,
    stop,
    dispose: () => {
      stop();
      rmSync(capturePath, { force: true });
    },
  };
}

/**
 * Read a capture safely, bounded, tolerating a writer mid-line.
 *
 * The follower appends while this reads, so the last line may be a fragment.
 * Returning whole lines only is what makes a partial write a smaller
 * observation rather than a malformed one.
 */
export function readCapture(capturePath: string): { readonly text: string; readonly bytes: number } | undefined {
  if (!existsSync(capturePath)) return undefined;
  let bytes: number;
  try {
    bytes = statSync(capturePath).size;
  } catch {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(capturePath, "utf8");
  } catch {
    return undefined;
  }
  if (raw.length > MAX_CAPTURE_BYTES) raw = raw.slice(raw.length - MAX_CAPTURE_BYTES);
  const lastBreak = raw.lastIndexOf("\n");
  return { text: lastBreak === -1 ? "" : raw.slice(0, lastBreak + 1), bytes };
}

/**
 * Attribute each trace batch to the run that caused it.
 *
 * The console exporter writes a summary line and then, at `verbosity: detailed`,
 * dumps the batch's resources and attributes underneath it. The run marker rides
 * in that dump (the reference adapter puts the run id in the request query
 * string and the auto-instrumentation records it as `url.full`), so a batch
 * belongs to this run exactly when the dump *between its summary line and the
 * next console record* names this run. Counting markers document-wide instead
 * would let one run's spans satisfy another's assertion, which is the failure
 * this attribution exists to prevent.
 */
export function parseDurableTelemetry(
  text: string,
  runId: string,
): {
  readonly currentRunSpanCount: number;
  readonly otherRunSpanCount: number;
  readonly unattributedSpanCount: number;
  readonly traceBatches: number;
  readonly firstObservedAt: string | undefined;
} {
  const lines = text.split("\n");
  let currentRunSpanCount = 0;
  let otherRunSpanCount = 0;
  let unattributedSpanCount = 0;
  let traceBatches = 0;
  let firstObservedAt: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const header = TRACE_BATCH_LINE.exec(lines[index] ?? "");
    if (header?.[1] === undefined) continue;
    const spans = Number.parseInt(header[1], 10);
    // A count that is not a finite, representable integer is a parse artifact:
    // the batch is still evidence the collector received traces, but its number
    // is not usable, so it contributes to neither run's total.
    const usable = Number.isInteger(spans) && spans >= 0 && spans <= MAX_REPRESENTABLE_SPANS;
    traceBatches += 1;
    if (firstObservedAt === undefined) {
      const stamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(lines[index] ?? "");
      firstObservedAt = stamp?.[1];
    }
    // The batch's own detailed dump: everything up to the next console record.
    const markers = new Set<string>();
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (SIGNAL_SUMMARY_LINE.test(line)) break;
      RUN_MARKER.lastIndex = 0;
      for (const match of line.matchAll(RUN_MARKER)) {
        if (match[1] !== undefined) markers.add(match[1]);
      }
    }
    if (!usable) continue;
    if (markers.has(runId)) currentRunSpanCount += spans;
    else if (markers.size > 0) otherRunSpanCount += spans;
    else unattributedSpanCount += spans;
  }

  return { currentRunSpanCount, otherRunSpanCount, unattributedSpanCount, traceBatches, firstObservedAt };
}

/** Turn parsed counts into the first missing transition. */
export function classifyDurableTelemetry(input: {
  readonly available: boolean;
  readonly currentRunSpanCount: number;
  readonly otherRunSpanCount: number;
  readonly unattributedSpanCount: number;
  readonly traceBatches: number;
  readonly deadlineReached: boolean;
}): TelemetryDiagnosticCode {
  if (!input.available) return "TRACE_OBSERVATION_UNAVAILABLE";
  if (input.currentRunSpanCount > 0) return "CURRENT_RUN_SPANS_OBSERVED";
  if (input.traceBatches === 0) return input.deadlineReached ? "TRACE_NOT_EMITTED" : "TRACE_OBSERVATION_TIMEOUT";
  // Traces did arrive; they simply are not this run's.
  return "TRACE_RUN_ATTRIBUTION_MISSING";
}

/**
 * Wait, bounded, for this run's spans to appear in the durable capture.
 *
 * Polls the local file rather than the daemon: the follower is already copying
 * the stream, so re-asking Docker would reintroduce exactly the dependency this
 * module exists to remove — and it makes each poll a file read instead of a
 * process spawn, which is what keeps the loop honest on a saturated host.
 */
export function awaitDurableTelemetry(options: {
  readonly capturePath: string;
  readonly runId: string;
  readonly attempts?: number;
  readonly sleep?: (ms: number) => void;
}): DurableTelemetryObservation {
  const attempts = options.attempts ?? 40;
  const sleep = options.sleep ?? defaultSleep;
  let last = {
    available: false,
    currentRunSpanCount: 0,
    otherRunSpanCount: 0,
    unattributedSpanCount: 0,
    traceBatches: 0,
    firstObservedAt: undefined as string | undefined,
    bytes: 0,
  };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const capture = readCapture(options.capturePath);
    if (capture !== undefined) {
      const parsed = parseDurableTelemetry(capture.text, options.runId);
      last = { available: true, ...parsed, bytes: capture.bytes };
      if (parsed.currentRunSpanCount > 0) break;
    }
    if (attempt < attempts - 1) sleep(1000);
  }

  const diagnosticCode = classifyDurableTelemetry({ ...last, deadlineReached: true });
  return {
    source: DURABLE_TELEMETRY_SOURCE,
    currentRunSpanCount: last.currentRunSpanCount,
    otherRunSpanCount: last.otherRunSpanCount,
    collectorReceivedTraceData: last.traceBatches > 0,
    observationComplete: last.available,
    firstObservedAt: last.firstObservedAt,
    diagnosticCode,
    evidenceRefs: last.available ? [`${options.capturePath} (${String(last.bytes)} bytes)`] : [],
  };
}

/** A sleep that costs one process, matching the existing suite's convention. */
function defaultSleep(ms: number): void {
  spawnSync(process.execPath, ["-e", `setTimeout(() => undefined, ${String(ms)})`]);
}

/** A human-readable account of the first missing transition, for assertions. */
export function explainDurableTelemetry(observation: DurableTelemetryObservation): string {
  const detail =
    `source=${observation.source} current=${String(observation.currentRunSpanCount)} ` +
    `other=${String(observation.otherRunSpanCount)} ` +
    `receivedTraceData=${String(observation.collectorReceivedTraceData)} ` +
    `complete=${String(observation.observationComplete)} ` +
    `refs=${observation.evidenceRefs.join(",")}`;
  switch (observation.diagnosticCode) {
    case "TRACE_OBSERVATION_UNAVAILABLE":
      return `TRACE_OBSERVATION_UNAVAILABLE: the durable collector capture could not be read, so nothing is claimed about telemetry — ${detail}`;
    case "TRACE_NOT_EMITTED":
      return `TRACE_NOT_EMITTED: the collector received no trace batch at all within the deadline — ${detail}`;
    case "TRACE_RUN_ATTRIBUTION_MISSING":
      return `TRACE_RUN_ATTRIBUTION_MISSING: the collector received trace data, but none of it carries this run's marker — ${detail}`;
    case "TRACE_OBSERVATION_TIMEOUT":
      return `TRACE_OBSERVATION_TIMEOUT: no trace batch had arrived when the bounded deadline closed — ${detail}`;
    case "CURRENT_RUN_SPANS_OBSERVED":
      return `CURRENT_RUN_SPANS_OBSERVED — ${detail}`;
  }
}
