/**
 * The trusted-telemetry record grammar (ADR-ERL2-038 §3, corrections R2–R6).
 *
 * ## Why this replaces a text parser rather than narrowing one
 *
 * Two remediations narrowed `parseCollectorTelemetry` and an independent review
 * forged each one. The third measurement stopped narrowing and tested the
 * assumption underneath: whether *any* token in the collector's mixed console
 * stream is collector-exclusive. None is. The debug exporter is line-oriented
 * and does not escape, so every subject byte reaches that stream at column
 * zero with its newlines intact, and a subject can emit any sequence of lines
 * the collector can emit. ADR-ERL2-038 §2 therefore closed that parser to
 * further extension as a security boundary.
 *
 * What this module reads instead is newline-delimited OTLP JSON written by the
 * collector's own `file` exporter, where the record boundary is **structural**:
 * a subject's newline is escaped to `\n` inside a JSON string and cannot end a
 * physical line. That is not a more specific pattern — it is a distinction
 * subject bytes cannot express, which is the property ADR-ERL2-038 §4 requires
 * ("independence must be established at the inputs, not at the arithmetic").
 *
 * ## What is deliberately *not* here
 *
 * The channel that produces these bytes does not exist yet. The collector
 * exporter, the minimizing processor and the tmpfs-backed named volume are
 * package 2; the driver lifecycle and the live freeze are package 3. This
 * module reads bytes it is handed. It opens no file, runs no container and
 * knows nothing about Docker, so nothing here depends on unimplemented
 * substrate behaviour.
 *
 * ## Why the parser enforces minimization
 *
 * R2 exists because one realistic *unminimized* record measured 1 001 415
 * bytes against a 262 144 retention ceiling: without pre-export field
 * minimization the channel is unusable on realistic input. The allowlist below
 * is therefore not a convenience — a record carrying a key nobody allowed is a
 * record the trusted pipeline did not minimize, and reading it would retain
 * subject bytes the privacy bound never accounted for. The verifier refuses it
 * rather than trusting that package 2 configured the processor correctly.
 */

import { parseStrictJson } from "@erl2/contracts";

/**
 * The retention bound on the trusted artifact, matching ERL2-C-171's
 * `maxLength` and its `artifact.byte_length` maximum.
 *
 * Measured in **UTF-8 bytes**, not UTF-16 code units: `byte_length` is a
 * statement about the bytes the collector wrote, and a multi-byte character
 * would otherwise let a record past the bound the schema states.
 */
export const TRUSTED_TELEMETRY_MAX_BYTES = 262_144;

/** The record-count bound, matching `artifact.record_count`'s maximum. */
export const TRUSTED_TELEMETRY_MAX_RECORDS = 4096;

/**
 * The per-value bound the trusted pipeline's `truncate_all` applies before
 * export (R2), restated here because the verifier must refuse a record that
 * was *not* truncated rather than assume the processor ran.
 */
export const TRUSTED_TELEMETRY_MAX_FIELD_CHARS = 512;

/** Resource attribute keys the trusted pipeline is allowed to export. */
export const TRUSTED_RESOURCE_KEYS: readonly string[] = ["service.name"];

/**
 * Span attribute keys the trusted pipeline is allowed to export.
 *
 * `url.full` is the marker-bearing field: the reference adapter puts the run id
 * in the request's query string and the auto-instrumentation records it here.
 * It is the one place a transformed subject-derived value may still appear in
 * the trusted artifact, JSON-escaped and bounded by
 * `TRUSTED_TELEMETRY_MAX_FIELD_CHARS`. Saying "subject bytes are absent" would
 * be false; saying exactly where they may remain is the honest bound.
 */
export const TRUSTED_SPAN_KEYS: readonly string[] = ["url.full"];

/**
 * Keys that are refused with their own code rather than the generic
 * allowlist code.
 *
 * Every one of these is already outside the allowlist, so this changes no
 * verdict — it changes the *reason*, and a reason a reader cannot act on is
 * worth as little here as it is anywhere else. A retained artifact carrying a
 * session cookie is a privacy incident, not a schema slip, and the code says so.
 */
const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = [
  "cookie",
  "authorization",
  "token",
  "secret",
  "password",
  "credential",
  "api-key",
  "api_key",
];

/** A UUIDv7 anywhere inside a value — the shape every ERL2 run id has. */
const RUN_ID_SHAPED =
  /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;

/** Reason codes this grammar can refuse with. */
export const TRUSTED_TELEMETRY_REASONS = {
  /** The retained bytes are larger than the contract retains. */
  overSizeBound: "telemetry_trusted_artifact_exceeds_size_bound",
  /** More physical records than the contract retains. */
  overRecordBound: "telemetry_trusted_artifact_exceeds_record_bound",
  /** Non-empty bytes that do not end on a record boundary: a partial write. */
  incomplete: "telemetry_trusted_record_incomplete",
  /** A physical line that is not one OTLP-JSON trace document. */
  malformed: "telemetry_trusted_record_malformed",
  /** A key outside the minimization allowlist: the pipeline did not minimize. */
  unexpectedField: "telemetry_trusted_record_unexpected_field",
  /** An allowlist violation that is also sensitive. */
  forbiddenField: "telemetry_trusted_record_forbidden_field",
  /** A value longer than the pre-export truncation bound. */
  fieldOverBound: "telemetry_trusted_record_field_exceeds_bound",
  /** A record naming a run that is not this one. */
  foreignRun: "telemetry_foreign_run_record_present",
  /**
   * A field the trusted pipeline is configured to remove arrived carrying
   * content.
   *
   * Distinct from `unexpectedField` on purpose. An unknown key is a record
   * shape nobody described; this is a key the specification below explicitly
   * removes — a scope attribute, a span name, a status message, a trace state,
   * a schema URL — arriving anyway. That means the minimizing processor did not
   * run, ran with the wrong configuration, or ran against a collector whose
   * output shape changed. Reading it would retain exactly the subject-controlled
   * bytes the privacy bound exists to exclude.
   */
  unminimized: "telemetry_trusted_record_unminimized_field",
  /**
   * A span link arrived carrying attributes or a trace state.
   *
   * Its own code because its cause is its own: `otelcol-contrib` v0.157.0 has
   * no span-link OTTL context, so unlike every other surface here the collector
   * cannot strip these before export. The refusal keeps subject-controlled
   * bytes out of the artifact; what it cannot do is minimize a legitimately
   * linked span, which is a stated limitation of the pinned image rather than a
   * property of this grammar.
   */
  linkNotMinimized: "telemetry_trusted_record_link_not_minimized",
} as const;

// -- the minimized record specification ---------------------------------------

/**
 * The exact shape of a minimized trusted record, at every nesting level.
 *
 * This is the single reviewed specification the two enforcement points are
 * derived from: `erl2-otelcol-extras.yaml` removes these fields before export,
 * and this grammar refuses a record that carries them anyway. The two are
 * deliberately separate — a configuration regression must be caught rather than
 * trusted — but they describe one shape, and the collector-configuration
 * controls and the parser controls both fail if they drift apart.
 *
 * Every list below was measured against the pinned collector
 * (`otelcol-contrib` v0.157.0, arm64) on two payloads: a maximal hostile record
 * with every field populated, and a minimal sparse span with no status, no
 * events, no links and no scope version. Both shapes are accepted; anything
 * outside them is not.
 *
 * `ALLOWED` is what may appear. `REMOVED` maps a key the pipeline strips to the
 * reason its presence is refused — a named cause rather than the generic
 * unknown-key code, because "the processor did not run" and "this record has a
 * shape nobody described" are different failures with different remedies.
 *
 * Absent is the normal case for most of these: the proto3 JSON marshaller omits
 * a field set to its zero value, which is why `set(span.name, "")` makes the
 * key disappear rather than appear empty. A key present but *empty* is
 * tolerated anyway, so a marshaller that materialises zero values does not
 * refuse a record that carries no content.
 */
const SHAPE = {
  resourceSpan: {
    allowed: ["resource", "scopeSpans"],
    removed: { schemaUrl: TRUSTED_TELEMETRY_REASONS.unminimized },
  },
  resource: {
    allowed: ["attributes", "droppedAttributesCount"],
    removed: {},
  },
  scopeSpan: {
    allowed: ["scope", "spans"],
    removed: { schemaUrl: TRUSTED_TELEMETRY_REASONS.unminimized },
  },
  scope: {
    allowed: ["droppedAttributesCount"],
    removed: {
      name: TRUSTED_TELEMETRY_REASONS.unminimized,
      version: TRUSTED_TELEMETRY_REASONS.unminimized,
      attributes: TRUSTED_TELEMETRY_REASONS.unminimized,
    },
  },
  span: {
    allowed: [
      "traceId",
      "spanId",
      "parentSpanId",
      "flags",
      "kind",
      "startTimeUnixNano",
      "endTimeUnixNano",
      "attributes",
      "droppedAttributesCount",
      "events",
      "droppedEventsCount",
      "links",
      "droppedLinksCount",
      "status",
    ],
    removed: {
      name: TRUSTED_TELEMETRY_REASONS.unminimized,
      traceState: TRUSTED_TELEMETRY_REASONS.unminimized,
    },
  },
  status: {
    allowed: ["code"],
    removed: { message: TRUSTED_TELEMETRY_REASONS.unminimized },
  },
  event: {
    allowed: ["timeUnixNano", "droppedAttributesCount"],
    removed: {
      name: TRUSTED_TELEMETRY_REASONS.unminimized,
      attributes: TRUSTED_TELEMETRY_REASONS.unminimized,
    },
  },
  link: {
    allowed: ["traceId", "spanId", "flags", "droppedAttributesCount"],
    // The pinned collector cannot strip these (no span-link OTTL context), so
    // unlike every other entry here the refusal is the only enforcement point.
    removed: {
      attributes: TRUSTED_TELEMETRY_REASONS.linkNotMinimized,
      traceState: TRUSTED_TELEMETRY_REASONS.linkNotMinimized,
    },
  },
  attribute: {
    allowed: ["key", "value"],
    removed: {},
  },
} as const satisfies Record<
  string,
  { readonly allowed: readonly string[]; readonly removed: Readonly<Record<string, string>> }
>;

/** Whether a value carries nothing — an emptied field is not an unminimized one. */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

/**
 * Refuses any key on this object that the specification does not permit.
 *
 * The whole point of the recursion: an unknown key at *any* depth is a refusal,
 * not something to skip. The first Package 2 grammar checked four attribute
 * maps and ignored every other key at every level, so six subject-controlled
 * surfaces reached the artifact and verified clean. Ignoring an unknown nested
 * key is how that happens, so nothing here ignores one.
 *
 * Forward compatibility is deliberately not "tolerate keys we do not know".
 * A collector that starts emitting a new field is a change to the retained
 * bytes, and the artifact's privacy bound is a claim about exactly those bytes.
 * The fail-closed refusal is the signal to review the new field and version the
 * specification — not something to route around with implicit key tolerance.
 */
function shapeRefusal(
  value: Record<string, unknown>,
  spec: { readonly allowed: readonly string[]; readonly removed: Readonly<Record<string, string>> },
): string | undefined {
  for (const key of Object.keys(value)) {
    if (spec.allowed.includes(key)) continue;
    const removedReason = spec.removed[key];
    if (removedReason !== undefined) {
      if (isEmpty(value[key])) continue;
      return removedReason;
    }
    return TRUSTED_TELEMETRY_REASONS.unexpectedField;
  }
  return undefined;
}

/** An object, or `undefined` if this is not one. Arrays are not objects here. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}


/** Counts recomputed structurally from the retained bytes. */
export interface TrustedTelemetryCounts {
  /** Physical OTLP-JSON documents — one collector export each. */
  readonly traceBatches: number;
  /** Summed `resourceSpans[].scopeSpans[].spans[]` lengths, never a numeral. */
  readonly spans: number;
  /** Sorted unique `service.name` resource values. */
  readonly serviceNames: readonly string[];
  /** Spans carrying this run's marker in an allowlisted value. */
  readonly runAttributedRecords: number;
  /** UTF-8 length of the retained bytes. */
  readonly byteLength: number;
  /** Physical record count. */
  readonly recordCount: number;
  /**
   * Whether the bytes end on a record boundary.
   *
   * False exactly when the artifact is empty. A non-empty artifact that does
   * not terminate is a partial write and never reaches this type — it is
   * refused as `incomplete`, because a truncated final document would
   * contribute counts that are not the run's.
   */
  readonly finalRecordTerminated: boolean;
}

/** Either the recomputed counts, or the first reason they could not be read. */
export type TrustedTelemetryParse =
  | { readonly ok: true; readonly counts: TrustedTelemetryCounts }
  | { readonly ok: false; readonly reasonCode: string };

const refuse = (reasonCode: string): TrustedTelemetryParse => ({ ok: false, reasonCode });

/** UTF-8 byte length, which is what the contract's byte bound measures. */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function attributeRefusal(
  attributes: readonly unknown[],
  allowed: readonly string[],
): string | undefined {
  for (const entry of attributes) {
    const attribute = asObject(entry);
    if (attribute === undefined) return TRUSTED_TELEMETRY_REASONS.malformed;
    // An attribute is `{key, value}` and nothing else. A third key here would be
    // an unchecked string riding inside a map the allowlist believes it bounds.
    const shape = shapeRefusal(attribute, SHAPE.attribute);
    if (shape !== undefined) return shape;
    const key = attribute["key"];
    if (typeof key !== "string") return TRUSTED_TELEMETRY_REASONS.malformed;
    const lowered = key.toLowerCase();
    if (FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment))) {
      return TRUSTED_TELEMETRY_REASONS.forbiddenField;
    }
    if (!allowed.includes(key)) return TRUSTED_TELEMETRY_REASONS.unexpectedField;
    const value = attribute["value"];
    if (typeof value !== "object" || value === null) return TRUSTED_TELEMETRY_REASONS.malformed;
    const stringValue = (value as Record<string, unknown>)["stringValue"];
    if (typeof stringValue !== "string") return TRUSTED_TELEMETRY_REASONS.malformed;
    if (stringValue.length > TRUSTED_TELEMETRY_MAX_FIELD_CHARS) {
      return TRUSTED_TELEMETRY_REASONS.fieldOverBound;
    }
  }
  return undefined;
}

/**
 * Refuses a span's events or links whose shape is not the minimized one.
 *
 * Both collections are now pure structure: an event keeps its timestamp and a
 * link keeps its identifiers, and neither keeps a name, an attribute map or a
 * trace state. Absent children are absent, not malformed — a span with no
 * events omits the key entirely, which is the overwhelmingly common shape.
 *
 * `spec` decides which reason a stripped field refuses with, which is what
 * separates "the processor did not run" (events, where it can) from "this
 * collector version cannot strip it" (links, where it cannot).
 */
function childRefusal(
  children: unknown,
  spec: { readonly allowed: readonly string[]; readonly removed: Readonly<Record<string, string>> },
): string | undefined {
  if (children === undefined) return undefined;
  if (!Array.isArray(children)) return TRUSTED_TELEMETRY_REASONS.malformed;
  for (const entry of children) {
    const child = asObject(entry);
    if (child === undefined) return TRUSTED_TELEMETRY_REASONS.malformed;
    const refusal = shapeRefusal(child, spec);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

function stringValuesOf(attributes: readonly unknown[], key: string): readonly string[] {
  const found: string[] = [];
  for (const entry of attributes) {
    const attribute = entry as Record<string, unknown>;
    if (attribute["key"] !== key) continue;
    const value = (attribute["value"] as Record<string, unknown> | undefined)?.["stringValue"];
    if (typeof value === "string") found.push(value);
  }
  return found;
}

/** Every allowlisted string value on a span, for marker scanning. */
function spanValues(attributes: readonly unknown[]): readonly string[] {
  const found: string[] = [];
  for (const entry of attributes) {
    const value = (entry as Record<string, unknown>)["value"] as
      | Record<string, unknown>
      | undefined;
    const stringValue = value?.["stringValue"];
    if (typeof stringValue === "string") found.push(stringValue);
  }
  return found;
}

/**
 * Recomputes every count from the retained trusted bytes.
 *
 * Shared by the producer and the offline verifier on purpose, and this time
 * the sharing is sound: ADR-ERL2-024 §7.2 permits a shared *definition* where
 * its inputs are outside subject control, and ADR-ERL2-038 §4 records why the
 * v1 sharing was not — producer and verifier re-derived the attacker's own
 * framing and agreed with it. Here the framing is the JSON document boundary,
 * which a subject cannot write, so the shared definition transmits no framing
 * defect. Every *verdict* built on these counts still lives with its owner.
 *
 * The first refusal wins and the order is fixed, so the same bytes always
 * refuse with the same code.
 */
export function parseTrustedTelemetryRecords(
  bytes: string,
  marker: string,
): TrustedTelemetryParse {
  const byteLength = utf8ByteLength(bytes);
  if (byteLength > TRUSTED_TELEMETRY_MAX_BYTES) {
    return refuse(TRUSTED_TELEMETRY_REASONS.overSizeBound);
  }

  // An empty artifact is an authentic zero, not a failure: the channel was
  // provisioned and finalized and the collector exported nothing. That is a
  // different fact from `absent`, and collapsing the two is the conflation
  // ADR-ERL2-033 exists to prevent.
  if (bytes.length === 0) {
    return {
      ok: true,
      counts: {
        traceBatches: 0,
        spans: 0,
        serviceNames: [],
        runAttributedRecords: 0,
        byteLength: 0,
        recordCount: 0,
        finalRecordTerminated: false,
      },
    };
  }

  if (!bytes.endsWith("\n")) return refuse(TRUSTED_TELEMETRY_REASONS.incomplete);

  const lines = bytes.slice(0, -1).split("\n");
  if (lines.length > TRUSTED_TELEMETRY_MAX_RECORDS) {
    return refuse(TRUSTED_TELEMETRY_REASONS.overRecordBound);
  }

  let spans = 0;
  let runAttributedRecords = 0;
  const serviceNames = new Set<string>();

  for (const line of lines) {
    // A blank physical line is not a document. Reading it as "nothing to
    // count" would let a writer pad the artifact with boundaries that carry
    // no record, which is the shape of every framing attack this replaces.
    if (line.length === 0) return refuse(TRUSTED_TELEMETRY_REASONS.malformed);

    let document: unknown;
    try {
      // Strict: duplicate keys are refused rather than last-wins, so two
      // `resourceSpans` keys cannot present one count to the producer and a
      // different one to a reader with another JSON implementation.
      document = parseStrictJson(line);
    } catch {
      return refuse(TRUSTED_TELEMETRY_REASONS.malformed);
    }
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      return refuse(TRUSTED_TELEMETRY_REASONS.malformed);
    }
    const keys = Object.keys(document as Record<string, unknown>);
    if (keys.length !== 1 || keys[0] !== "resourceSpans") {
      return refuse(TRUSTED_TELEMETRY_REASONS.malformed);
    }
    const resourceSpans = (document as Record<string, unknown>)["resourceSpans"];
    if (!Array.isArray(resourceSpans)) return refuse(TRUSTED_TELEMETRY_REASONS.malformed);

    for (const resourceEntry of resourceSpans) {
      const resourceSpan = asObject(resourceEntry);
      if (resourceSpan === undefined) return refuse(TRUSTED_TELEMETRY_REASONS.malformed);
      const resourceSpanRefusal = shapeRefusal(resourceSpan, SHAPE.resourceSpan);
      if (resourceSpanRefusal !== undefined) return refuse(resourceSpanRefusal);
      const resource = asObject(resourceSpan["resource"]);
      if (resource === undefined) return refuse(TRUSTED_TELEMETRY_REASONS.malformed);
      const resourceRefusalShape = shapeRefusal(resource, SHAPE.resource);
      if (resourceRefusalShape !== undefined) return refuse(resourceRefusalShape);
      // Absent is empty, exactly as it already is for span attributes below.
      //
      // Package 1 required the key and package 2 measured why it cannot: when
      // the trusted pipeline's `keep_keys` removes every resource attribute —
      // which is what happens to a resource carrying no `service.name` — the
      // collector's OTLP-JSON marshaller emits `"resource":{}` with no
      // `attributes` key at all. Requiring the key refused a record the trusted
      // channel legitimately produces, and refusing a valid artifact is a
      // different defect from accepting an invalid one, not a safer version of
      // it.
      //
      // No security property moves. An absent attribute array carries no key to
      // check against the allowlist, no value to bound, and no marker to
      // attribute — so this resource contributes zero service names and zero
      // attributed spans, which is what an attribute-less resource is.
      const resourceAttributes = resource["attributes"] ?? [];
      if (!Array.isArray(resourceAttributes)) return refuse(TRUSTED_TELEMETRY_REASONS.malformed);
      const resourceRefusal = attributeRefusal(resourceAttributes, TRUSTED_RESOURCE_KEYS);
      if (resourceRefusal !== undefined) return refuse(resourceRefusal);
      for (const name of stringValuesOf(resourceAttributes, "service.name")) {
        serviceNames.add(name);
      }

      const scopeSpans = resourceSpan["scopeSpans"];
      if (!Array.isArray(scopeSpans)) return refuse(TRUSTED_TELEMETRY_REASONS.malformed);
      for (const scopeEntry of scopeSpans) {
        const scopeSpan = asObject(scopeEntry);
        if (scopeSpan === undefined) return refuse(TRUSTED_TELEMETRY_REASONS.malformed);
        const scopeSpanRefusal = shapeRefusal(scopeSpan, SHAPE.scopeSpan);
        if (scopeSpanRefusal !== undefined) return refuse(scopeSpanRefusal);
        // The instrumentation scope is now pure structure. Its attribute map was
        // the third one the first grammar never looked at, and it retained a
        // 1 200-character `session.token` through a forbidden-key check that
        // never reached it.
        if (scopeSpan["scope"] !== undefined) {
          const scope = asObject(scopeSpan["scope"]);
          if (scope === undefined) return refuse(TRUSTED_TELEMETRY_REASONS.malformed);
          const scopeRefusal = shapeRefusal(scope, SHAPE.scope);
          if (scopeRefusal !== undefined) return refuse(scopeRefusal);
        }
        const scopeSpanList = scopeSpan["spans"];
        if (!Array.isArray(scopeSpanList)) return refuse(TRUSTED_TELEMETRY_REASONS.malformed);

        for (const spanEntry of scopeSpanList) {
          const spanShape = asObject(spanEntry);
          if (spanShape === undefined) return refuse(TRUSTED_TELEMETRY_REASONS.malformed);
          const spanShapeRefusal = shapeRefusal(spanShape, SHAPE.span);
          if (spanShapeRefusal !== undefined) return refuse(spanShapeRefusal);
          // The count is the length of a structure, never a rendered number.
          // This is the whole difference from v1: there is no numeral in these
          // bytes that a subject could write and a reader could believe.
          spans += 1;

          const span = spanShape;
          const spanAttributes = span["attributes"] ?? [];
          if (!Array.isArray(spanAttributes)) return refuse(TRUSTED_TELEMETRY_REASONS.malformed);
          const spanRefusal = attributeRefusal(spanAttributes, TRUSTED_SPAN_KEYS);
          if (spanRefusal !== undefined) return refuse(spanRefusal);

          // The span's status: a code is structure, a message is an exception
          // string. The review retained a host file path here, which is the same
          // payload as the span-event stack trace in the field next door.
          if (span["status"] !== undefined) {
            const status = asObject(span["status"]);
            if (status === undefined) return refuse(TRUSTED_TELEMETRY_REASONS.malformed);
            const statusRefusal = shapeRefusal(status, SHAPE.status);
            if (statusRefusal !== undefined) return refuse(statusRefusal);
          }

          // Events and links are now pure structure — a timestamp and a pair of
          // identifiers. Nothing ERL2-C-171 derives comes from either, so nothing
          // is lost by refusing every name, attribute map and trace state on
          // them; and refusing here rather than only configuring the processor is
          // the same discipline the span allowlist already follows.
          const eventRefusal = childRefusal(span["events"], SHAPE.event);
          if (eventRefusal !== undefined) return refuse(eventRefusal);
          const linkRefusal = childRefusal(span["links"], SHAPE.link);
          if (linkRefusal !== undefined) return refuse(linkRefusal);

          let attributed = false;
          for (const value of spanValues(spanAttributes)) {
            // R4: a record naming another run is refused, not skipped. Skipping
            // would let an artifact lifted from a second run sit inside this
            // run's envelope contributing its bytes to this run's digest while
            // contributing nothing a reader was told about.
            for (const found of value.match(RUN_ID_SHAPED) ?? []) {
              if (found !== marker) return refuse(TRUSTED_TELEMETRY_REASONS.foreignRun);
            }
            if (value.includes(marker)) attributed = true;
          }
          if (attributed) runAttributedRecords += 1;
        }
      }
    }
  }

  return {
    ok: true,
    counts: {
      traceBatches: lines.length,
      spans,
      serviceNames: [...serviceNames].sort(),
      runAttributedRecords,
      byteLength,
      recordCount: lines.length,
      finalRecordTerminated: true,
    },
  };
}
