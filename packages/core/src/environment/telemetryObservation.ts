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
import { trustedTelemetryClaim } from "./telemetryAuthority.js";
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
  /**
   * Lines that are structurally a trace-summary record and whose span count is
   * not a plain, representable, non-negative integer.
   *
   * Counted rather than skipped, and refused rather than counted as zero: a
   * summary the parser cannot read is not the same fact as a summary that says
   * nothing arrived, and collapsing the two is exactly the conflation this
   * module exists to prevent.
   */
  readonly malformedSummaries: number;
  /**
   * Lines inside a record's payload that are shaped like the start of a console
   * record.
   *
   * The collector never writes one: a payload line at column zero belongs to a
   * multi-line message. A subject's log body can contain anything, though, so
   * this is how the window says *"I cannot tell where records begin here"* —
   * and a window that cannot be framed is refused rather than read (§ the
   * `windowAmbiguous` reason below).
   */
  readonly forgedBoundaries: number;
  /**
   * Trace batches whose summary line *and* at least one record naming `marker`
   * were both inside this window, the summary first.
   *
   * `runAttributedRecords` alone survives what the span count does not. The
   * collector's debug exporter writes a batch's `Traces … "spans": N` summary
   * and *then* dumps that batch's resources and attributes, and the run marker
   * rides in the dump. The container's log rotates from the head, so a loaded
   * run can leave a window holding a batch's marked records with the summary
   * that counts them already evicted. Counting the batches that kept *both*
   * halves is what makes "this window states a span count for this run" a fact
   * the window itself carries, rather than an inference from two numbers that
   * were never checked against each other.
   *
   * Preserved by excerpting, like every other count here: the excerpt keeps
   * every trace-batch summary line and every marker-bearing line in order, so
   * which batch a marked record falls under is identical in the excerpt and in
   * the full log.
   */
  readonly runAttributedBatches: number;
}

// -- the collector's console-record grammar ----------------------------------
//
// ## Why this is a grammar and not a substring match
//
// The pattern that used to stand here was
// `/\bTraces\b.*"spans":\s*(\d+)/` — unanchored, matching anywhere on any line.
// An independent review proved it forgeable against the pinned collector. The
// Lab's overlay runs a `logs` pipeline into the same `debug` exporter, so a
// subject's log record is rendered into the very stream these counts are parsed
// from, and at column zero:
//
// ```
// Body: Str(2026-08-13T21:33:32.634Z\tinfo\tTraces\t{"resource spans": 1, "spans": 9999})
// ```
//
// That line matched. Injecting one of them into a rotated window the observer
// correctly refuses turned the refusal into a retained observation carrying a
// span count of 9999 that no collector ever wrote. Before the coherent-window
// correction a forged count only inflated a field nothing read; after it, the
// same match decides whether evidence is retained at all. The parser became an
// integrity boundary, so it is written as one here: a count is read only from a
// line that is structurally a collector trace-summary *record*.
//
// ## The supported shape, stated exactly
//
// Observed from the pinned image
// (`otelcol-contrib` v0.157.0, digest `sha256:1fef9f07…`), read with
// `docker container logs` and **no** `--timestamps` flag — Docker contributes
// no prefix of its own, the collector's zap console encoder writes all of it:
//
// ```
// <RFC-3339 UTC>\t<level>\t[caller\t]<message>\t{<structured context>}
// ```
//
// A trace-batch summary is that record with `message` exactly `Traces` and a
// context naming the `traces` signal. A batch's detailed dump is
// a *separate* record whose message runs over many lines and is closed by its
// context on a line of its own, beginning with a tab.
//
// Accepted: `Z`-suffixed RFC-3339 instants with or without fractional seconds,
// `\n` and `\r\n` line endings. Not accepted, and deliberately: numeric UTC
// offsets, lower-case `z`, a space where the grammar wants a tab, or any record
// shape a future collector might introduce. Every one of those fails closed —
// an unreadable window states no count, which is the whole point.

/**
 * A console record as the collector's exporter stamps one: an RFC-3339 UTC
 * instant and a tab. Nothing else the collector writes begins this way.
 */
const CONSOLE_RECORD_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\t/;

/**
 * The line that closes a multi-line console record.
 *
 * zap writes a record's structured context as its final tab-separated field, so
 * when the message itself spans lines that field lands on a line of its own,
 * beginning with the separating tab.
 */
const RECORD_CONTEXT_LINE = /^\t\{/;

/** The zap message a trace-batch summary record carries, exactly. */
const TRACE_SUMMARY_MESSAGE = "Traces";

/**
 * The span count as the exporter writes it: a plain, unsigned, non-exponent
 * integer literal, read from the raw bytes rather than from `JSON.parse`.
 *
 * `JSON.parse` would silently accept `1e3` as 1000, `1.0` as 1, and the *last*
 * of two `"spans"` keys. None of those is something the exporter emits, so each
 * is a signal that the line was written by something else.
 */
const SUMMARY_SPANS_FIELD = /"spans":\s*(0|[1-9][0-9]*)(?=\s*[,}])/g;

/** A `service.name: Str(...)` resource-attribute line from the same exporter. */
const SERVICE_NAME_LINE = /service\.name:\s*Str\(([^)]*)\)/;

/** Number of occurrences of `marker` in `text`. The marker never spans lines. */
function occurrences(text: string, marker: string): number {
  return marker === "" ? 0 : text.split(marker).length - 1;
}

/** What one line is, once the window has been framed into records. */
export type TraceSummaryRecord =
  /** An authentic summary record, carrying the count the collector stated. */
  | { readonly kind: "summary"; readonly spans: number }
  /** Structurally a summary record, but its count is not readable as one. */
  | { readonly kind: "malformed"; readonly detail: string }
  /** Anything else — including every payload line. */
  | { readonly kind: "not_summary" };

const NOT_SUMMARY: TraceSummaryRecord = { kind: "not_summary" };

/** Drop the carriage return a CRLF window leaves on the end of every line. */
function withoutCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Whether `line` is a console record that ends on the same line it began.
 *
 * The discriminator is the structured context: a single-line record carries it
 * as its final tab-separated field, and a record whose message runs on does not
 * — that one's context arrives later, on its own line. This is what tells a
 * trace-batch *summary* from the opening line of a batch's detailed *dump*.
 */
function isCompleteRecordLine(line: string): boolean {
  const fields = withoutCarriageReturn(line).split("\t");
  const last = fields[fields.length - 1] ?? "";
  return fields.length >= 3 && last.startsWith("{") && last.endsWith("}");
}

/**
 * Read `line` as a collector trace-batch summary record, or refuse it.
 *
 * Every conjunct is a statement about structure the collector controls and a
 * subject's payload does not:
 *
 * 1. the line begins a console record — a payload line is indented, or is
 *    inside a record whose framing the caller has already established;
 * 2. the record ends on this line, so its context is present to be read;
 * 3. the zap *message* field is exactly `Traces` — not a substring of one;
 * 4. the context parses as a JSON object;
 * 5. that object names the collector's `traces` signal, which is how a trace
 *    batch's summary is told from another signal's;
 * 6. `spans` appears exactly once, as a plain non-negative integer literal;
 * 7. the value is a safe integer, so a long enough digit run is refused rather
 *    than silently becoming `Infinity`.
 *
 * A line that satisfies (1)–(3) but fails a later conjunct is `malformed`, not
 * `not_summary`: it is shaped like a record the collector writes and cannot be
 * read as one, and the window it sits in is refused rather than counted.
 */
export function parseTraceSummaryRecord(line: string): TraceSummaryRecord {
  if (!CONSOLE_RECORD_LINE.test(line)) return NOT_SUMMARY;
  const fields = withoutCarriageReturn(line).split("\t");
  if (fields.length < 4) return NOT_SUMMARY;
  // […instant, level, optional caller…, message, context]. The context is the
  // last field and the message the one before it, whatever sits between.
  const context = fields[fields.length - 1] ?? "";
  const message = fields[fields.length - 2] ?? "";
  if (message !== TRACE_SUMMARY_MESSAGE) return NOT_SUMMARY;
  // Past this point the line claims to be a trace-batch summary, so every
  // remaining refusal is `malformed`: a record shaped like one the collector
  // writes and unreadable as one is a fact about the window, not a silent zero.
  if (!isCompleteRecordLine(line)) {
    return { kind: "malformed", detail: "the record does not carry its own context" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(context);
  } catch {
    return { kind: "malformed", detail: "the record's context is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "malformed", detail: "the record's context is not a JSON object" };
  }
  const fieldsOf = parsed as Record<string, unknown>;
  // The collector's own statement of which pipeline emitted the line. The debug
  // exporter writes one summary per signal and they are otherwise identical in
  // shape, so this is what separates a trace batch's count from a `Logs` or
  // `Metrics` batch's. Deliberately the only context field required: the
  // authentication is the record framing above, and demanding more of the
  // collector's internal metadata would make a field rename silently
  // unobservable rather than merely unsupported.
  if (fieldsOf["otelcol.signal"] !== "traces") return NOT_SUMMARY;

  const literals = [...context.matchAll(SUMMARY_SPANS_FIELD)];
  if (literals.length !== 1) {
    return {
      kind: "malformed",
      detail:
        literals.length === 0
          ? "the record states no readable span count"
          : "the record states more than one span count",
    };
  }
  const spans = Number(literals[0]?.[1]);
  if (!Number.isSafeInteger(spans) || spans < 0) {
    return { kind: "malformed", detail: "the record's span count is not a representable integer" };
  }
  // The parsed value and the literal must be the same number, so a context that
  // reads one way to `JSON.parse` and another to the eye is refused.
  if (fieldsOf["spans"] !== spans) {
    return { kind: "malformed", detail: "the record's span count is stated inconsistently" };
  }
  return { kind: "summary", spans };
}

/**
 * Which lines of a window are payload, and which the collector framed itself.
 *
 * A record opens at a line matching `CONSOLE_RECORD_LINE`. If that line carries
 * its own context it is complete and the next line opens whatever comes next;
 * otherwise the record's message runs on, and every line until its context line
 * is **payload** — resource attributes, scope names, span fields, and
 * `Body: Str(…)`, which is where a subject's own text arrives.
 *
 * Two subtleties, both load-bearing:
 *
 * - **A window that begins mid-record begins in payload.** The container's log
 *   rotates from the head, so a cut window's first lines are the tail of some
 *   record's dump. Treating them as top level would let exactly the forgery
 *   this grammar exists to refuse back in through the rotation case, which is
 *   the case that matters most.
 * - **A record-shaped line inside payload is a forged boundary.** The collector
 *   never writes one; a multi-line subject log body can. The window is then not
 *   framable, and `forgedBoundaries` is how it says so.
 */
function framePayloadRegions(lines: readonly string[]): readonly boolean[] {
  const payload: boolean[] = [];
  // A window whose first non-empty line does not begin a record is a window
  // that lost its head mid-record: it opens inside a dump.
  let open = !beginsAtRecordBoundary(lines);
  for (const line of lines) {
    if (open) {
      payload.push(true);
      if (RECORD_CONTEXT_LINE.test(withoutCarriageReturn(line) + " ".slice(0, 0) || line)) {
        open = false;
      }
      continue;
    }
    payload.push(false);
    if (CONSOLE_RECORD_LINE.test(line) && !isCompleteRecordLine(line)) open = true;
  }
  return payload;
}

/** Whether the first line that carries anything begins a console record. */
function beginsAtRecordBoundary(lines: readonly string[]): boolean {
  for (const line of lines) {
    if (line.length === 0) continue;
    return CONSOLE_RECORD_LINE.test(line);
  }
  // Nothing was written at all. That is an empty window, not a cut one.
  return true;
}

/**
 * The counts a collector log supports, attributed by `marker`.
 *
 * Framed first, then counted. Trace summaries are read only from lines the
 * framing places outside any record's payload, which is what stops a subject's
 * log body from stating this run's span count. Markers and service names are
 * counted wherever they appear, because that is where the collector puts them:
 * inside a batch's dump, which is payload by construction.
 *
 * The excerpt invariant below still holds line by line, and deliberately so —
 * see `excerptCollectorTelemetry` for why framing does not have to travel with
 * the excerpt for the two to agree.
 */
export function parseCollectorTelemetry(logs: string, marker: string): CollectorTelemetryCounts {
  let traceBatches = 0;
  let spans = 0;
  const serviceNames = new Set<string>();
  let runAttributedRecords = 0;
  let runAttributedBatches = 0;
  let malformedSummaries = 0;
  let forgedBoundaries = 0;
  // The batch the scan is currently inside — the most recent summary record —
  // and whether it has already been credited with a record naming this run. A
  // marked record before the first summary belongs to no batch in this window:
  // its own summary is exactly what rotation took.
  let openBatchAttributed = true;
  const lines = logs.split("\n");
  const payload = framePayloadRegions(lines);
  for (const [at, line] of lines.entries()) {
    if (payload[at] === true) {
      // Inside a record's payload nothing may be read as a summary. A line
      // shaped like a record boundary here is something the collector cannot
      // have written, and the window says so rather than guessing.
      if (CONSOLE_RECORD_LINE.test(line)) forgedBoundaries += 1;
    } else {
      const summary = parseTraceSummaryRecord(line);
      if (summary.kind === "summary") {
        traceBatches += 1;
        spans += summary.spans;
        openBatchAttributed = false;
      } else if (summary.kind === "malformed") {
        malformedSummaries += 1;
      }
    }
    for (const match of line.matchAll(new RegExp(SERVICE_NAME_LINE, "g"))) {
      serviceNames.add(match[1] ?? "");
    }
    const marked = occurrences(line, marker);
    runAttributedRecords += marked;
    if (marked > 0 && !openBatchAttributed) {
      openBatchAttributed = true;
      runAttributedBatches += 1;
    }
  }
  return {
    traceBatches,
    spans,
    serviceNames: [...serviceNames].sort(),
    runAttributedRecords,
    malformedSummaries,
    forgedBoundaries,
    runAttributedBatches,
  };
}

/**
 * True when `line` contributes to at least one count under `marker`.
 *
 * Stateless on purpose. A line is kept if it is *capable* of being a summary
 * record, names a service, or carries the marker — the framing that decides
 * whether a capable line actually counts lives in `parseCollectorTelemetry`,
 * and does not need to be re-derivable from the excerpt because a window whose
 * framing is ambiguous never becomes an observation at all.
 */
export function contributesToTelemetryCounts(line: string, marker: string): boolean {
  return (
    parseTraceSummaryRecord(line).kind !== "not_summary" ||
    RECORD_CONTEXT_LINE.test(line) ||
    SERVICE_NAME_LINE.test(line) ||
    occurrences(line, marker) > 0
  );
}

/**
 * The subset of collector log lines the counts are derived from, in order.
 *
 * Invariant — and the property the offline verifier's recomputation stands on:
 * `parseCollectorTelemetry(excerptCollectorTelemetry(logs, marker), marker)`
 * equals `parseCollectorTelemetry(logs, marker)` for every window that becomes
 * an observation. The excerpt is also a fixed point: excerpting an excerpt
 * returns it unchanged, which is how the verifier refuses an excerpt padded
 * with lines that contribute to nothing.
 *
 * ## Why the record-context lines are kept
 *
 * They carry no count, and for that reason the excerpt did not keep them
 * before. Framing needs them. A window that lost its head begins *inside* a
 * record's payload, and what ends that opening region is its context line — so
 * an excerpt that dropped it would re-frame as though the window had begun at a
 * record boundary, and would read the first summary after it under different
 * rules than the producer did. Keeping every context line is what makes
 * `parseCollectorTelemetry` agree on the excerpt and on the window it came
 * from, which is the whole basis of the offline recomputation.
 *
 * They are collector metadata — resource identity and component ids — not
 * subject payload, so keeping them widens no privacy surface. The retention
 * bound is unchanged and still demotes an over-large excerpt to an honest
 * `absent` rather than truncating it.
 *
 * The remaining shape that could break the symmetry is a payload line that is
 * *also* record-shaped, since the excerpt loses the region that made it
 * payload. That is exactly `forgedBoundaries`, and a window carrying one is
 * refused before it can become an excerpt.
 */
export function excerptCollectorTelemetry(logs: string, marker: string): string {
  return logs
    .split("\n")
    .filter((line) => contributesToTelemetryCounts(line, marker))
    .join("\n");
}

// -- the observation window: when a count may be stated at all ---------------

/**
 * Why a readable window cannot support the span count it appears to state.
 *
 * These join `TELEMETRY_RETENTION_REASONS` on the same open `reason_code`
 * string (ERL2-C-160, ADR-ERL2-035 §3), and for the same reason: a reader of
 * the retained bytes must be able to tell *the collector received nothing* from
 * *the line carrying the count was no longer readable*, because those are
 * different facts about the run with different owners.
 */
export const TELEMETRY_WINDOW_REASONS = {
  /**
   * Records naming this run were readable and no summary line counting their
   * spans was — the signature of a log that rotated from the head while the run
   * was still emitting.
   */
  spanCountOutsideWindow: "telemetry_span_count_outside_readable_window",
  /**
   * Nothing of this run was readable and the window does not begin at a whole
   * record, so neither a positive count nor a zero is established by it.
   */
  windowTruncated: "telemetry_observation_window_truncated",
  /**
   * A line the collector frames as payload is shaped like the start of a
   * console record, so the window cannot be split into records at all.
   *
   * Only a subject's own multi-line log body can produce this, and the honest
   * answer is that this window's boundaries are unknown — not that its counts
   * are whatever a scan of it happens to total.
   */
  windowAmbiguous: "telemetry_observation_window_ambiguous",
  /**
   * A record structurally shaped as a trace-batch summary states a span count
   * that is not a plain representable integer.
   *
   * Refused rather than skipped: a summary that cannot be read is not a summary
   * that counted nothing.
   */
  summaryMalformed: "telemetry_summary_record_malformed",
} as const;

/**
 * Whether a readable window begins where the collector began a record.
 *
 * The container's `json-file` log rotates from the head, so a window that has
 * lost bytes almost always begins *inside* a batch's detailed dump — on a
 * continuation line, which no console record ever starts with. That makes this
 * a positive, structural statement about the bytes in hand: the window starts
 * at a record boundary, so no record was cut in half to produce it.
 *
 * ## Why not the collector's own start-up line
 *
 * A first attempt anchored on `Everything is ready` / `Starting GRPC server`,
 * reasoning that the collector writes those once, before it can have exported
 * anything. A live loaded run refuted it: at `verbosity: detailed` the
 * collector exports its **own** logs back through the same debug exporter, so
 * those very sentences reappear throughout the stream as `Body: Str(…)` inside
 * later dumps — nine times in one 74 kB window. A substring test for them is
 * true in a window whose head is long gone. The lesson is in the shape of the
 * check, not the string: a completeness signal must be something a payload
 * cannot contain, and a line *prefix* is, where a substring is not.
 *
 * Derived from the raw window rather than from the excerpt, because the excerpt
 * keeps only lines that contribute to a count and the collector's first record
 * usually contributes to none. It is therefore an acceptance input, not a
 * retained claim: every count in the artifact stays derivable from the excerpt.
 */
export function collectorWindowComplete(logs: string): boolean {
  return beginsAtRecordBoundary(logs.split("\n"));
}

/** What to do with one readable window: retain it, wait, or refuse it. */
export type TelemetryWindowDecision =
  | { readonly decision: "retain" }
  | { readonly decision: "settle" }
  | { readonly decision: "refuse"; readonly reasonCode: string };

/**
 * The single condition under which a collector window may be frozen as an
 * observation — the one this module exists to make explicit.
 *
 * ## What was wrong before
 *
 * The observer settled on `runAttributedRecords >= 1` and retained the span
 * count from the same read. Those two numbers survive rotation differently: the
 * marked records live in a batch's detailed dump, the count lives in the
 * summary line *above* it, and a `json-file` log evicts from the head. So the
 * loop waited for the half that survives and published the half that does not,
 * and a run whose spans were emitted, exported and marked could be retained as
 * `spans: 0`. Nothing in the loop ever waited for, or checked, the number it
 * was about to freeze.
 *
 * ## The condition
 *
 * `runAttributedBatches >= 1` — at least one trace batch whose summary line and
 * whose marked records were *both* inside this one window, the summary first.
 * It is deliberately the only acceptance test here, and it is strictly stronger
 * than the one it replaces:
 *
 * - it implies `runAttributedRecords >= 1`, so the settling the exporter's
 *   flush schedule needs is unchanged;
 * - it implies `traceBatches >= 1`, so the count is stated by a line that was
 *   actually read rather than defaulted;
 * - both halves come from one snapshot, so no count is ever paired with an
 *   attribution taken from a different read;
 * - the marker must fall *under* a batch's own summary, so another run's
 *   summary cannot supply a count for this run's records, and this run's
 *   summary cannot be attributed by another run's dump.
 *
 * ## When the budget runs out
 *
 * Waiting cannot restore an evicted line, so at exhaustion the window is
 * described rather than trusted, in the order the evidence is strongest.
 *
 * Records naming this run that no readable summary counts are themselves the
 * proof that the summary was evicted: that is the failed-gate signature, and it
 * is refused rather than retained as a zero. Otherwise nothing of this run was
 * in the window at all, and the only remaining question is whether the window
 * is whole — `collectorWindowComplete` answers it from the bytes, and a window
 * that begins mid-record establishes no count, not even a zero.
 *
 * What is left is a window that starts at a record boundary and carries nothing
 * of this run. Its counts are what its own lines say, including a zero, and the
 * gate refuses it on the attribution floor exactly as before.
 */
export function decideTelemetryObservationWindow(input: {
  readonly counts: CollectorTelemetryCounts;
  readonly windowComplete: boolean;
  readonly budgetExhausted: boolean;
}): TelemetryWindowDecision {
  // Framing first, and before any count is trusted: a window whose records
  // cannot be delimited, or that carries a summary shaped record nobody can
  // read, states nothing — including nothing about whether waiting would help.
  if (input.counts.forgedBoundaries > 0) {
    return { decision: "refuse", reasonCode: TELEMETRY_WINDOW_REASONS.windowAmbiguous };
  }
  if (input.counts.malformedSummaries > 0) {
    return { decision: "refuse", reasonCode: TELEMETRY_WINDOW_REASONS.summaryMalformed };
  }
  if (input.counts.runAttributedBatches >= 1) return { decision: "retain" };
  if (!input.budgetExhausted) return { decision: "settle" };
  if (input.counts.runAttributedRecords >= 1) {
    return { decision: "refuse", reasonCode: TELEMETRY_WINDOW_REASONS.spanCountOutsideWindow };
  }
  if (!input.windowComplete) {
    return { decision: "refuse", reasonCode: TELEMETRY_WINDOW_REASONS.windowTruncated };
  }
  return { decision: "retain" };
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
 * run-attributed **v2** observation of this run*. The gate never reads a
 * verdict — the contract stores none.
 *
 * ## What changed at ADR-ERL2-038 R8, and why the gate now usually refuses
 *
 * The version question is not asked here. It is asked once, in
 * `decideTrustedTelemetryAuthority`, which the offline verifier also calls, so
 * the two authorities cannot disagree about which format governs and no
 * package ordering opens a window where the forgeable v1 channel still
 * authorizes evidence.
 *
 * Nothing in this repository produces a v2 record yet — the collector exporter
 * and volume are package 2, the driver and live freeze package 3 — so at this
 * commit a run that declares attributable telemetry obtainable **fails this
 * gate**, with `telemetry_authority_v1_not_authoritative`. That is deliberate.
 * The `6d28d543` defect is open; a v1 record states a span count derived from a
 * stream a subject can forge byte for byte, and a Lab that kept passing the
 * gate on it would be certifying the thing ADR-ERL2-038 §8 says it cannot.
 * Runs that never declare the observation obtainable are untouched: the gate
 * is vacuous for them, exactly as before.
 */
export function attributableTelemetryGatePassed(input: {
  readonly declared: boolean;
  readonly runId: string;
  readonly observations: readonly unknown[];
}): boolean {
  if (!input.declared) return true;
  const claim = trustedTelemetryClaim(input.observations);
  if (!claim.authoritative) return false;
  const observation = claim.observation;
  return (
    observation.evidence === "observed" &&
    observation.run_id === input.runId &&
    observation.marker === input.runId &&
    (observation.run_attributed_records ?? 0) >= 1
  );
}
