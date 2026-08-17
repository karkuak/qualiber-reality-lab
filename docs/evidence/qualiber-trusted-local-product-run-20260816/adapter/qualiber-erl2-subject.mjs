#!/usr/bin/env node

// src/main.ts
import { main } from "@erl2/adapter-sdk";

// src/adapter.ts
import { createHash as createHash2 } from "node:crypto";

// src/journey.ts
import { fileURLToPath } from "node:url";

// node_modules/@qualgraph/collector/dist/collector/adapter.js
import { createHash, randomUUID } from "node:crypto";

// node_modules/@qualgraph/collector/dist/collector/config.js
var DEFAULT_WEIGHTS = {
  injectedTestId: 0.6,
  browserContext: 0.2,
  withinWindow: 0.15,
  workerIndex: 0.1,
  graceWindow: 0.05,
  pageSession: 0.05
};
var DEFAULT_THRESHOLDS = {
  high: 0.8,
  medium: 0.45,
  low: 0.15
};
function defaultConfig(overrides = {}) {
  return {
    collectorVersion: "playwright_collector_0.1",
    endpoints: [
      {
        name: "default_track",
        urlPatterns: ["**/v1/track", "**/collect"],
        methods: ["POST"],
        bodyType: "json",
        eventNamePath: "event",
        propertiesPath: "properties"
      }
    ],
    graceWindowMs: 2e3,
    backgroundEventNames: /* @__PURE__ */ new Set(["page_heartbeat", "debug_log"]),
    weights: DEFAULT_WEIGHTS,
    thresholds: DEFAULT_THRESHOLDS,
    ...overrides
  };
}

// node_modules/@qualgraph/collector/dist/util/ordering.js
function sortCanonicalEvents(events) {
  return [...events].sort(compareCanonicalEvents);
}
function compareCanonicalEvents(a, b) {
  if (a.relTs !== b.relTs)
    return a.relTs - b.relTs;
  if (a.collectorSeq !== b.collectorSeq)
    return a.collectorSeq - b.collectorSeq;
  const an = a.networkRequestId ?? "";
  const bn = b.networkRequestId ?? "";
  if (an !== bn)
    return an < bn ? -1 : 1;
  if (a.eventId !== b.eventId)
    return a.eventId < b.eventId ? -1 : 1;
  return 0;
}

// node_modules/@qualgraph/collector/dist/collector/associator.js
function associate(event, ctx, config) {
  const w = config.weights;
  const signals = {};
  const reasons = [];
  const positiveSignals = [];
  const negativeSignals = [];
  let raw = 0;
  const addPositive = (name, fired, weight, reason) => {
    signals[name] = fired;
    if (fired) {
      raw += weight;
      reasons.push(reason);
      positiveSignals.push(name);
    }
  };
  const addNegative = (name, fired, weight, reason) => {
    if (fired) {
      raw -= weight;
      reasons.push(reason);
      negativeSignals.push(name);
    }
  };
  const hasTestId = event.testId !== void 0;
  const testIdMatch = hasTestId && event.testId === ctx.testId;
  const browserMatch = event.browserContextId === ctx.browserContextId;
  const workerMatch = event.workerIndex === ctx.workerIndex;
  addPositive("injected_test_id", testIdMatch, w.injectedTestId, "test_id matched");
  if (!hasTestId)
    reasons.push("test_id header missing");
  addPositive("browser_context", browserMatch, w.browserContext, "browser context matched");
  const withinWindow = ctx.hasWindow && event.relTs >= 0 && event.relTs <= ctx.journeyEndRelTs;
  addPositive("within_window", withinWindow, w.withinWindow, "within test window");
  addPositive("worker_index", workerMatch, w.workerIndex, "worker index matched");
  const withinGrace = ctx.hasWindow && event.relTs > ctx.journeyEndRelTs && event.relTs <= ctx.journeyEndRelTs + ctx.graceWindowMs;
  addPositive("within_grace_window", withinGrace, w.graceWindow, "within grace window");
  addPositive("page_session", event.pageSessionId !== void 0 && event.pageSessionId === ctx.pageSessionId, w.pageSession, "page/session matched");
  addNegative("context_contradiction", testIdMatch && !browserMatch, w.browserContext, "test_id matched but browser context mismatched");
  addNegative("worker_contradiction", testIdMatch && !workerMatch, w.workerIndex, "test_id matched but worker index mismatched");
  const contradictionDetected = negativeSignals.length > 0;
  const score = Number(Math.max(0, Math.min(1, raw)).toFixed(4));
  let confidence = bucket(score, ctx, config);
  if (contradictionDetected && confidence === "high")
    confidence = "medium";
  const associationBlockingEligible = confidence === "high" || confidence === "medium";
  return {
    rawScore: Number(raw.toFixed(4)),
    score,
    confidence,
    reasons,
    signals,
    associationBlockingEligible,
    winningLayer: pickLayer(signals),
    positiveSignals,
    negativeSignals,
    contradictionDetected
  };
}
function pickLayer(signals) {
  if (signals.injected_test_id)
    return 1;
  if (signals.browser_context || signals.worker_index)
    return 3;
  if (signals.within_window || signals.within_grace_window)
    return 4;
  return 5;
}
function bucket(score, ctx, config) {
  if (!ctx.hasWindow && score < config.thresholds.high)
    return "unknown";
  const t = config.thresholds;
  if (score >= t.high)
    return "high";
  if (score >= t.medium)
    return "medium";
  if (score >= t.low)
    return "low";
  return "unknown";
}

// node_modules/@qualgraph/collector/dist/collector/classifier.js
var DISPLAY_PRIORITY = [
  "unknown",
  "late",
  "orphaned",
  "background",
  "associated",
  "probably_associated"
];
var EXCLUDING_FLAGS = ["late", "background", "orphaned", "unknown"];
function classify(event, assoc, ctx, config) {
  const flags = /* @__PURE__ */ new Set();
  if (assoc.confidence === "high")
    flags.add("associated");
  else if (assoc.confidence === "medium")
    flags.add("probably_associated");
  else if (assoc.confidence === "unknown")
    flags.add("unknown");
  if (config.backgroundEventNames.has(event.sourceEventName)) {
    flags.add("background");
  }
  if (assoc.signals.within_grace_window)
    flags.add("late");
  const eligibleConfidence = assoc.confidence === "high" || assoc.confidence === "medium";
  const afterGraceWindow = ctx.hasWindow && event.relTs > ctx.journeyEndRelTs + ctx.graceWindowMs;
  if (afterGraceWindow && eligibleConfidence)
    flags.add("late");
  const insideWindow = assoc.signals.within_window === true;
  if (insideWindow && assoc.confidence === "low" && !flags.has("background") && !flags.has("late")) {
    flags.add("orphaned");
  }
  const hasExcludingFlag = EXCLUDING_FLAGS.some((f) => flags.has(f));
  const primary = eligibleConfidence && !hasExcludingFlag ? "validation_eligible" : "excluded";
  const flagList = orderFlags(flags);
  const eventClass = DISPLAY_PRIORITY.find((f) => flags.has(f)) ?? flagList[0] ?? "unknown";
  return { primary, flags: flagList, eventClass };
}
function orderFlags(flags) {
  return DISPLAY_PRIORITY.filter((f) => flags.has(f));
}

// node_modules/@qualgraph/collector/dist/contract/aliases.js
function resolveCanonical(idx, sourceName) {
  return idx.get(sourceName) ?? sourceName;
}

// node_modules/@qualgraph/collector/dist/redaction/rules.js
var DEFAULT_MAX_DEPTH = 64;
var DEFAULT_MAX_NODES = 5e4;
var DEFAULT_KEY_SUBSTRINGS = [
  "email",
  "phone",
  "name",
  // also catches "username", "fullname"
  "address",
  "card",
  "cardnumber",
  "pan",
  "cvv",
  "ssn",
  "authtoken",
  "token",
  "session",
  "cookie",
  "password",
  "secret",
  "apikey",
  "api_key"
];
var VALUE_PATTERNS = [
  { name: "email", re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b(?!:)/i },
  { name: "bearer", re: /\bBearer\s+[\w-]+\.[\w-]+/i },
  { name: "jwt", re: /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/ },
  // header.payload.sig
  { name: "long_digits", re: /\b\d[\d ]{11,}\b/ },
  // 12+ digit runs (card/SSN-like)
  // ── CR-7 additions (review F4 pattern gaps) ──────────────────────────────
  // URL basic-auth userinfo: scheme://user:pass@host. Requires the `:pass@`
  // shape, so `http://host:8080/path` (no `@`) and `git@github.com:org/repo`
  // (no `://`) do NOT match.
  { name: "url_userinfo", re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
  // Credentials in a query string: a sensitively-named param with a value.
  // Anchored to the exact param name between a `?`/`&` and the `=`, so compound
  // names are NOT matched (`?sort_key=…`, `?keyword=…` — the param is not `key`).
  {
    name: "url_credential_param",
    re: /[?&](?:access_token|refresh_token|api[_-]?key|client_secret|token|secret|password|passwd|pwd|auth|key)=[^&\s#"'<>]+/i
  },
  // IPv4 (octet-bounded). Loopback (127.0.0.0/8) and 0.0.0.0 are excluded —
  // ubiquitous in configs/docs, no PII. A 3-part semver (`1.2.3`) never matches
  // (needs 4 octets); a 4-part dotted-decimal is treated as IP-shaped and
  // redacted (documented conservative trade-off). IPv6 is deferred: its many
  // valid textual forms (`::1`, embedded IPv4, zone ids) make a low-FP single
  // pattern non-trivial and no current connector surfaces bare IPv6.
  {
    name: "ipv4",
    re: /\b(?!127\.|0\.0\.0\.0\b)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/
  },
  // Phone numbers in NANP 3-3-4 shape, requiring separators between the groups
  // (optional `(area)` parens, optional `+CC` prefix). The mandatory separators
  // are the false-positive guard: a bare 10-digit run collides with ids/
  // timestamps and is intentionally NOT matched. Broader international formats
  // are deferred (they need per-region rules).
  { name: "phone_nanp", re: /(?:\+\d{1,3}[-.\s]?)?(?:\(\d{3}\)|\b\d{3})[-.\s]\d{3}[-.\s]\d{4}\b/ }
];
function keyIsSensitive(key, config) {
  const k = key.toLowerCase();
  const subs = [...DEFAULT_KEY_SUBSTRINGS, ...(config.extraKeys ?? []).map((s) => s.toLowerCase())];
  return subs.some((sub) => k.includes(sub));
}
function valueIsSensitive(value, config) {
  if (config.disableValuePatterns)
    return false;
  if (VALUE_PATTERNS.some((p) => p.re.test(value)))
    return true;
  return (config.extraValuePatterns ?? []).some((p) => p.re.test(value));
}

// node_modules/@qualgraph/collector/dist/redaction/engine.js
var REDACTED = "[redacted]";
var TRUNCATED = "[redacted:truncated]";
var REDACTED_KEY_PREFIX = "[redacted_key:";
function redact(obj, config = {}) {
  const ctx = {
    config,
    fields: [],
    truncated: false,
    nodes: 0,
    maxDepth: config.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxNodes: config.maxNodes ?? DEFAULT_MAX_NODES
  };
  const out = walk(obj, "", 0, ctx);
  ctx.fields.sort();
  return { redacted: out, redactedFields: ctx.fields, truncated: ctx.truncated };
}
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}
function walk(value, path3, depth, ctx) {
  if (depth > ctx.maxDepth || ctx.nodes > ctx.maxNodes) {
    ctx.truncated = true;
    return TRUNCATED;
  }
  if (Array.isArray(value)) {
    ctx.nodes += value.length;
    return value.map((v, i) => {
      const childPath = `${path3}[${i}]`;
      if (typeof v === "string" && valueIsSensitive(v, ctx.config)) {
        ctx.fields.push(childPath);
        return REDACTED;
      }
      return walk(v, childPath, depth + 1, ctx);
    });
  }
  if (value instanceof Map || value instanceof Set) {
    ctx.truncated = true;
    return TRUNCATED;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    ctx.nodes += entries.length;
    const out = {};
    const keysToReplace = entries.map(([k]) => k).filter((k) => valueIsSensitive(k, ctx.config) || k.startsWith(REDACTED_KEY_PREFIX)).sort();
    const keyReplacement = new Map(keysToReplace.map((key, i) => [key, `${REDACTED_KEY_PREFIX}${i}]`]));
    for (const [k, v] of entries) {
      const replacementKey = keyReplacement.get(k);
      const keyRedacted = replacementKey !== void 0;
      const outKey = replacementKey ?? k;
      const childPath = path3 ? `${path3}.${outKey}` : outKey;
      if (keyRedacted)
        ctx.fields.push(childPath);
      if (keyIsSensitive(k, ctx.config) || typeof v === "string" && valueIsSensitive(v, ctx.config)) {
        setOwn(out, outKey, REDACTED);
        if (!keyRedacted)
          ctx.fields.push(childPath);
      } else {
        setOwn(out, outKey, walk(v, childPath, depth + 1, ctx));
      }
    }
    return out;
  }
  return value;
}

// node_modules/@qualgraph/collector/dist/collector/normalizer.js
function normalize(raw, assoc, cls, ciRunId, config, normalizationTs, options = {}) {
  const canonicalEventName = options.aliasIndex ? resolveCanonical(options.aliasIndex, raw.sourceEventName) : raw.sourceEventName;
  const properties = options.redaction ? redact(raw.properties, options.redaction).redacted : raw.properties;
  const event = {
    schemaVersion: "canonical_telemetry_event_v0.1",
    eventId: raw.rawId,
    collectorSeq: raw.collectorSeq,
    sourceEventName: raw.sourceEventName,
    canonicalEventName,
    source: config.collectorVersion,
    ciRunId,
    timestamp: new Date(raw.captureTs).toISOString(),
    relTs: raw.relTs,
    environment: "ci",
    platform: "web",
    properties,
    context: { browser: "chromium", collectorVersion: config.collectorVersion },
    associationConfidence: assoc.confidence,
    associationScore: assoc.score,
    associationReasons: assoc.reasons,
    associationSignals: assoc.signals,
    associationBlockingEligible: assoc.associationBlockingEligible,
    primary: cls.primary,
    flags: cls.flags,
    eventClass: cls.eventClass,
    lineage: {
      collectorVersion: config.collectorVersion,
      rawPayloadHash: raw.rawPayloadHash,
      sourceEndpoint: raw.url,
      captureTs: raw.captureTs,
      normalizationTs,
      browserContextId: raw.browserContextId
    }
  };
  if (raw.journeyId !== void 0)
    event.journeyId = raw.journeyId;
  if (raw.testId !== void 0)
    event.testId = raw.testId;
  if (raw.networkRequestId !== void 0) {
    event.networkRequestId = raw.networkRequestId;
  }
  return event;
}

// node_modules/@qualgraph/collector/dist/collector/pipeline.js
var ERROR_DEGRADED_THRESHOLD = 5;
var ORPHAN_RATE_DEGRADED = 0.5;
function buildCapture(rawEvents, markers, ctx, config, meta, options = {}) {
  const events = rawEvents.map((raw) => {
    const assoc = associate(raw, ctx, config);
    const cls = classify(raw, assoc, ctx, config);
    return normalize(raw, assoc, cls, meta.ciRunId, config, meta.normalizationTs, options);
  });
  const sorted = sortCanonicalEvents(events);
  const summary = summarize(sorted, meta);
  return {
    schemaVersion: "test_run_capture_v0.1",
    testRunId: ctx.testRunId,
    testId: ctx.testId,
    journeyId: ctx.journeyId,
    ciRunId: meta.ciRunId,
    events: sorted,
    markers,
    summary
  };
}
function summarize(events, meta) {
  const count = (pred) => events.filter(pred).length;
  const eventsCaptured = events.length;
  const eventsValidationEligible = count((e) => e.primary === "validation_eligible");
  const eventsBackground = count((e) => e.flags.includes("background"));
  const eventsLate = count((e) => e.flags.includes("late"));
  const eventsOrphaned = count((e) => e.flags.includes("orphaned"));
  const eventsUnknown = count((e) => e.flags.includes("unknown"));
  const health = deriveHealth({
    eventsCaptured,
    eventsOrphaned,
    interceptionErrors: meta.interceptionErrors,
    unsupported: meta.unsupportedBodyTypesObserved.length,
    captureStarted: meta.captureStarted,
    captureEndedCleanly: meta.captureEndedCleanly
  });
  return {
    schemaVersion: "collector_run_summary_v0.1",
    health,
    eventsCaptured,
    eventsValidationEligible,
    eventsBackground,
    eventsLate,
    eventsOrphaned,
    eventsUnknown,
    interceptionErrors: meta.interceptionErrors,
    unsupportedBodyTypesObserved: meta.unsupportedBodyTypesObserved,
    captureStarted: meta.captureStarted,
    captureEndedCleanly: meta.captureEndedCleanly
  };
}
function deriveHealth(s) {
  if (!s.captureStarted)
    return "failed";
  if (s.eventsCaptured === 0)
    return "degraded";
  const orphanRate = s.eventsOrphaned / s.eventsCaptured;
  if (s.interceptionErrors > ERROR_DEGRADED_THRESHOLD || !s.captureEndedCleanly || orphanRate >= ORPHAN_RATE_DEGRADED) {
    return "degraded";
  }
  if (s.unsupported > 0 || s.interceptionErrors > 0)
    return "partial";
  return "healthy";
}

// node_modules/@qualgraph/collector/dist/collector/adapter.js
function getByPath(obj, path3) {
  return path3.split(".").reduce((acc, key) => acc && typeof acc === "object" ? acc[key] : void 0, obj);
}
function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex");
}
function endpointMatches(url, method, config) {
  for (const ep of config.endpoints) {
    if (!ep.methods.includes(method))
      continue;
    const hit = ep.urlPatterns.some((p) => typeof p === "string" ? globMatch(p, url) : p.test(url));
    if (hit)
      return { matched: true, bodyType: ep.bodyType };
  }
  return { matched: false };
}
function globMatch(pattern, url) {
  const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/(?<!\.)\*/g, "[^/]*") + "$");
  return re.test(url) || url.includes(pattern.replace(/\*/g, ""));
}
function toRawEventFromParts(input, args) {
  const ep = args.config.endpoints.find((e) => e.urlPatterns.some((p) => typeof p === "string" ? globMatch(p, input.url) : p.test(input.url)));
  if (!ep)
    return null;
  let body;
  try {
    body = input.postData ? JSON.parse(input.postData) : {};
  } catch {
    return null;
  }
  const sourceEventName = String(getByPath(body, ep.eventNamePath) ?? "");
  if (!sourceEventName)
    return null;
  const props = getByPath(body, ep.propertiesPath);
  const properties = props && typeof props === "object" ? props : {};
  const raw = {
    schemaVersion: "raw_telemetry_event_v0.1",
    rawId: randomUUID(),
    collectorSeq: args.collectorSeq,
    networkRequestId: `${args.collectorSeq}`,
    sourceEventName,
    rawPayload: body,
    rawPayloadHash: stableHash(body),
    captureTs: args.captureTs,
    relTs: args.captureTs - args.journeyStartTs,
    url: input.url,
    method: input.method,
    browserContextId: args.browserContextId,
    workerIndex: args.workerIndex,
    properties
  };
  if (args.pageSessionId !== void 0)
    raw.pageSessionId = args.pageSessionId;
  if (args.testRunId !== void 0)
    raw.testRunId = args.testRunId;
  if (args.testId !== void 0)
    raw.testId = args.testId;
  if (args.journeyId !== void 0)
    raw.journeyId = args.journeyId;
  return raw;
}
var CaptureAccumulator = class {
  opts;
  config;
  now;
  raw = [];
  markers = [];
  unsupported = /* @__PURE__ */ new Set();
  interceptionErrors = 0;
  seq = 0;
  journeyStartTs;
  journeyEndRelTs = Number.POSITIVE_INFINITY;
  journeyId = "unknown";
  started = false;
  endedCleanly = false;
  constructor(opts) {
    this.opts = opts;
    this.config = opts.config ?? defaultConfig();
    this.now = opts.now ?? Date.now;
    this.journeyStartTs = this.now();
  }
  startJourney(journeyId) {
    this.journeyId = journeyId;
    this.journeyStartTs = this.now();
    this.started = true;
    this.markers.push({ kind: "start", ts: this.journeyStartTs, relTs: 0 });
  }
  markStep(stepId) {
    const ts = this.now();
    this.markers.push({ kind: "step", stepId, ts, relTs: ts - this.journeyStartTs });
  }
  endJourney() {
    const ts = this.now();
    this.journeyEndRelTs = ts - this.journeyStartTs;
    this.endedCleanly = true;
    this.markers.push({ kind: "end", ts, relTs: this.journeyEndRelTs });
  }
  /** Feed one captured request. Unmatched endpoints are ignored; unparsable bodies degrade. */
  onRawRequest(input) {
    try {
      const m = endpointMatches(input.url, input.method, this.config);
      if (!m.matched)
        return;
      const captureTs = input.captureTs ?? this.now();
      const event = toRawEventFromParts(input, {
        config: this.config,
        journeyStartTs: this.journeyStartTs,
        captureTs,
        collectorSeq: this.seq++,
        browserContextId: this.opts.browserContextId,
        workerIndex: this.opts.workerIndex,
        testRunId: this.opts.testRunId,
        testId: this.opts.testId,
        journeyId: this.journeyId,
        ...this.opts.pageSessionId !== void 0 && { pageSessionId: this.opts.pageSessionId }
      });
      if (event)
        this.raw.push(event);
      else
        this.unsupported.add("non_json_or_beacon");
    } catch {
      this.interceptionErrors++;
    }
  }
  /** Record a capture gap the adapter knows it cannot observe (health degrades, never silence). */
  recordInterceptionError() {
    this.interceptionErrors++;
  }
  /** Per-spec / per-retry isolation (Cypress §6.2): the capture reflects the final attempt. */
  reset() {
    this.raw = [];
    this.markers = [];
    this.unsupported = /* @__PURE__ */ new Set();
    this.interceptionErrors = 0;
    this.seq = 0;
    this.journeyStartTs = this.now();
    this.journeyEndRelTs = Number.POSITIVE_INFINITY;
    this.journeyId = "unknown";
    this.started = false;
    this.endedCleanly = false;
  }
  getCapture() {
    const ctx = {
      testId: this.opts.testId,
      journeyId: this.journeyId,
      testRunId: this.opts.testRunId,
      browserContextId: this.opts.browserContextId,
      workerIndex: this.opts.workerIndex,
      ...this.opts.pageSessionId !== void 0 && { pageSessionId: this.opts.pageSessionId },
      journeyStartTs: this.journeyStartTs,
      journeyEndRelTs: this.journeyEndRelTs,
      graceWindowMs: this.config.graceWindowMs,
      hasWindow: this.started
    };
    const meta = {
      ciRunId: this.opts.ciRunId ?? process.env.CI_RUN_ID ?? "local",
      captureStarted: this.started,
      captureEndedCleanly: this.endedCleanly,
      interceptionErrors: this.interceptionErrors,
      unsupportedBodyTypesObserved: [...this.unsupported],
      normalizationTs: this.now()
    };
    return buildCapture(this.raw, this.markers, ctx, this.config, meta, { redaction: {} });
  }
};

// src/journey.ts
var ENDPOINT_PATH = "/getquote";
var JOURNEY_ID = "erl2_quote_journey";
var TEST_ID = "adapters/erl2-subject::erl2_quote_journey";
var QUOTE_STEPS = [
  { step: 1, event: "quote_requested_one", numberOfItems: 1 },
  { step: 2, event: "quote_requested_three", numberOfItems: 3 },
  { step: 3, event: "quote_requested_zero", numberOfItems: 0 }
];
function stepBody(step) {
  return JSON.stringify({
    numberOfItems: step.numberOfItems,
    event: step.event,
    properties: { numberOfItems: step.numberOfItems }
  });
}
function stepUrl(host, port, runId, step) {
  return `http://${host}:${String(port)}${ENDPOINT_PATH}?erl2_run=${encodeURIComponent(runId)}&erl2_step=${String(step.step)}`;
}
function quoteCollectorConfig() {
  return defaultConfig({
    collectorVersion: "erl2_subject_collector_0.1",
    endpoints: [
      {
        name: "erl2_otel_demo_quote",
        urlPatterns: ["**/getquote*"],
        methods: ["POST"],
        bodyType: "json",
        eventNamePath: "event",
        propertiesPath: "properties"
      }
    ]
  });
}
function contractPath() {
  return fileURLToPath(new URL("../contracts/erl2-quote-journey.contract.json", import.meta.url));
}

// src/pipeline.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var JourneyRecorder = class {
  accumulator;
  constructor(runId) {
    this.accumulator = new CaptureAccumulator({
      browserContextId: `erl2-run-${runId}`,
      workerIndex: 0,
      testRunId: runId,
      testId: TEST_ID,
      ciRunId: runId,
      config: quoteCollectorConfig()
    });
  }
  begin() {
    this.accumulator.startJourney(JOURNEY_ID);
  }
  /**
   * Hands the collector one request, as issued.
   *
   * `postData` is the caller's own serialized body — the identical string it
   * passed to `fetch`. This method never serializes anything itself, because a
   * second `JSON.stringify` would be a second set of bytes that merely happens
   * to look like the first.
   */
  record(step, url, postData) {
    this.accumulator.markStep(`step-${String(step.step)}`);
    this.accumulator.onRawRequest({ url, method: "POST", postData });
  }
  end() {
    this.accumulator.endJourney();
    return this.accumulator.getCapture();
  }
};
var REPORTED_STATUSES = ["clean", "rule_violation_detected", "inconclusive"];
var EXPECTED_REPORTED_ARTIFACTS = [
  "run-result.json",
  "report.json",
  "report.md",
  "evidence-pack.json",
  "validation-evidence-pack.json"
];
function locateProductCli() {
  const adapterRoot = fileURLToPath2(new URL("..", import.meta.url));
  const productRoot = path.resolve(adapterRoot, "..", "..");
  const manifest = JSON.parse(readFileSync(path.join(productRoot, "package.json"), "utf8"));
  const bin = manifest.bin?.["telemetrytest"];
  if (bin === void 0) {
    throw new Error("the product package.json declares no telemetrytest bin");
  }
  return path.join(productRoot, bin);
}
function runProductValidation(capture, options = {}) {
  const cli = options.cliPath ?? locateProductCli();
  const contract = options.contractPath ?? contractPath();
  const scratch = mkdtempSync(path.join(tmpdir(), "qualiber-erl2-validate-"));
  try {
    const capturePath = path.join(scratch, "capture.json");
    const outDir = path.join(scratch, "out");
    writeFileSync(capturePath, `${JSON.stringify(capture, null, 2)}
`);
    mkdirSync(outDir, { recursive: true });
    const spawned = spawnSync(
      process.execPath,
      [cli, "validate", "--contract", contract, "--capture", capturePath, "--out", outDir],
      { timeout: options.timeoutMs ?? 12e4, encoding: "buffer" }
    );
    const artifacts = /* @__PURE__ */ new Map();
    let names = [];
    try {
      names = readdirSync(outDir);
    } catch {
      names = [];
    }
    for (const name of names.sort()) {
      artifacts.set(name, readFileSync(path.join(outDir, name)));
    }
    const exitCode = spawned.status;
    if (spawned.error !== void 0 || exitCode === null) {
      return {
        kind: "refused",
        reason: `the telemetrytest CLI did not run: ${spawned.error?.message ?? "terminated without an exit code"}`,
        exitCode,
        artifacts
      };
    }
    const runResultBytes = artifacts.get("run-result.json");
    if (runResultBytes === void 0) {
      return {
        kind: "refused",
        reason: exitCode === 4 ? "the CLI exited 4 (write failure, EV-1): --out could not take a single artifact" : `the CLI exited ${String(exitCode)} but wrote no run-result.json`,
        exitCode,
        artifacts
      };
    }
    let runStatus;
    try {
      const parsed = JSON.parse(runResultBytes.toString("utf8"));
      if (typeof parsed.runStatus !== "string") throw new Error("runStatus missing");
      runStatus = parsed.runStatus;
    } catch {
      return {
        kind: "refused",
        reason: `the CLI exited ${String(exitCode)} but run-result.json carries no readable runStatus`,
        exitCode,
        artifacts
      };
    }
    if (!REPORTED_STATUSES.includes(runStatus)) {
      return {
        kind: "refused",
        reason: `the tool refused to evaluate this run: runStatus ${runStatus}`,
        exitCode,
        runStatus,
        artifacts
      };
    }
    const missing = EXPECTED_REPORTED_ARTIFACTS.filter((name) => !artifacts.has(name));
    if (missing.length > 0) {
      return {
        kind: "refused",
        reason: `the CLI reported ${runStatus} but its output is incomplete: missing ${missing.join(", ")}`,
        exitCode,
        runStatus,
        artifacts
      };
    }
    return { kind: "reported", exitCode, runStatus, artifacts };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// src/v2.ts
import { readdirSync as readdirSync2 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import path2 from "node:path";
var PROTOCOL_V2 = "subject-adapter/v2";
var LOCAL_OBSERVATION = "local_observation";
var SCRATCH_PREFIX = "qualiber-erl2-validate-";
var frozenMode;
var frozenProtocol;
function refusal(code, safeMessage) {
  return {
    status: "unsupported",
    activeOperatorMs: 0,
    unsupportedInputs: [`execution mode ${String(frozenMode ?? "(unfrozen)")}`],
    error: { code, owner: "adapter", safeMessage }
  };
}
function assertLocalObservation(context) {
  const mode = context.executionMode;
  const protocol = context.protocolVersion;
  if (frozenMode === void 0) {
    frozenMode = mode;
    frozenProtocol = protocol;
  } else if (frozenMode !== mode || frozenProtocol !== protocol) {
    return refusal(
      "SUBJECT_EXECUTION_MODE_CHANGED",
      `this process froze ${String(frozenProtocol)}/${String(frozenMode)} at construction and cannot serve ${protocol}/${mode}`
    );
  }
  if (mode !== LOCAL_OBSERVATION) {
    return refusal(
      "SUBJECT_GOVERNED_EXECUTION_REFUSED",
      "this artifact is certified for subject-adapter/v2 local observation only; governed execution is not a mode it offers"
    );
  }
  if (protocol !== PROTOCOL_V2) {
    return refusal(
      "SUBJECT_PROTOCOL_VERSION_UNSUPPORTED",
      `local observation requires ${PROTOCOL_V2}; ${protocol} is not a protocol this artifact serves`
    );
  }
  return void 0;
}
function operationPayload(context) {
  const nested = context.request["operation_payload"];
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    return nested;
  }
  return context.request;
}
function observeResidue(checkpoint) {
  let leftovers;
  try {
    leftovers = readdirSync2(tmpdir2()).filter((name) => name.startsWith(SCRATCH_PREFIX)).sort().slice(0, 256).map((name) => path2.join(tmpdir2(), name));
  } catch {
    return {
      schema_version: "local-residue-observation/v1",
      checkpoint,
      status: "unknown",
      residual_resources: [],
      residual_paths: []
    };
  }
  return {
    schema_version: "local-residue-observation/v1",
    checkpoint,
    // Driven by what the scan found, never by having reached this operation.
    status: leftovers.length === 0 ? "clean" : "residue_detected",
    residual_resources: [],
    residual_paths: leftovers
  };
}

// src/adapter.ts
var ADAPTER_ID = "qualiber-erl2-subject";
var ADAPTER_VERSION = "0.2.0";
var SUPPORTED_PACKAGE_KINDS = ["archive"];
var PACKAGE_BYTES = Buffer.from("qualiber-erl2-subject package v0.1.0\n", "utf8");
var REQUEST_TIMEOUT_MS = 1e4;
var OUTPUT_ROOT = "qualiber";
function endpoint(context) {
  let bytes;
  try {
    bytes = context.readInput("environment-endpoint", "endpoint.json");
  } catch {
    return void 0;
  }
  const value = JSON.parse(bytes.toString("utf8"));
  if (typeof value.host !== "string" || typeof value.port !== "number") return void 0;
  return { host: value.host, port: value.port };
}
function endpointAbsent() {
  return {
    status: "unsupported",
    activeOperatorMs: 100,
    unsupportedInputs: ["environment-endpoint"],
    error: {
      code: "SUBJECT_ENVIRONMENT_ENDPOINT_ABSENT",
      owner: "subject",
      safeMessage: "no environment endpoint was made available to this subject"
    }
  };
}
function sha256(bytes) {
  const hash = createHash2("sha256");
  if (typeof bytes === "string") hash.update(bytes, "utf8");
  else hash.update(bytes);
  return `sha256:${hash.digest("hex")}`;
}
function acquire(context) {
  context.writeOutput("acquisition/notes.txt", "followed the package quickstart\n");
  return {
    status: "supported",
    resultSchemaVersion: "qualiber-erl2-subject-acquisition/v1",
    activeOperatorMs: 900,
    result: {
      package_base64: PACKAGE_BYTES.toString("base64"),
      attempts: [
        {
          attempt_id: "attempt-1",
          status: "completed",
          bytes: PACKAGE_BYTES.byteLength,
          redirect_count: 0,
          error_codes: []
        }
      ],
      authentication_prompt_count: 0,
      documentation_step_ids: ["doc-quickstart"],
      elapsed_ms: 1e3
    }
  };
}
var PACKAGE_MEDIA_TYPE_PREFIX = "application/vnd.erl2.package.";
function packageKind(mediaType) {
  return mediaType.startsWith(PACKAGE_MEDIA_TYPE_PREFIX) ? mediaType.slice(PACKAGE_MEDIA_TYPE_PREFIX.length) : void 0;
}
function validatePackage(context) {
  const payload = operationPayload(context);
  const declaredKind = payload["package_kind"];
  const artifact = context.request["frozen_acquired_artifact"];
  const mediaType = artifact?.media_type ?? "";
  const kind = typeof declaredKind === "string" ? declaredKind : packageKind(mediaType);
  if (kind === void 0 || !SUPPORTED_PACKAGE_KINDS.includes(kind)) {
    return {
      status: "unsupported",
      activeOperatorMs: 120,
      unsupportedInputs: [`media type ${mediaType || "(absent)"}`],
      error: {
        code: "SUBJECT_PACKAGE_KIND_UNSUPPORTED",
        owner: "subject",
        safeMessage: `this subject is distributed as an archive; ${kind ?? "unknown"} is not a form it can verify`
      }
    };
  }
  return {
    status: "supported",
    resultSchemaVersion: "qualiber-erl2-subject-package-verification/v1",
    activeOperatorMs: 250,
    result: {
      package_kind: kind,
      declared_entrypoints: [...QUALIBER_ERL2_ADAPTER.declaredEntrypoints],
      checks: [{ check_id: "package-kind-declared", passed: true }]
    }
  };
}
function install(context) {
  context.writeOutput("install/runtime.txt", "qualiber pipeline runtime prepared\n");
  return {
    status: "supported",
    resultSchemaVersion: "qualiber-erl2-subject-install/v1",
    activeOperatorMs: 400,
    result: { installed: true }
  };
}
function configure(context) {
  const target = endpoint(context);
  if (target === void 0) return endpointAbsent();
  context.writeOutput("configure/endpoint.txt", `${target.host}:${String(target.port)}
`);
  return {
    status: "supported",
    resultSchemaVersion: "qualiber-erl2-subject-configure/v1",
    activeOperatorMs: 180,
    result: { endpoint_configured: true, journey_steps: QUOTE_STEPS.length }
  };
}
async function interact(context) {
  const target = endpoint(context);
  if (target === void 0) return endpointAbsent();
  const started = Date.now();
  const recorder = new JourneyRecorder(context.runId);
  recorder.begin();
  const http = [];
  for (const step of QUOTE_STEPS) {
    const url = stepUrl(target.host, target.port, context.runId, step);
    const payload = stepBody(step);
    context.attemptEgress({
      decision_id: `egress-${context.operationId}-step-${String(step.step)}`,
      url,
      redirect_chain: [],
      resolved_addresses: [target.host]
    });
    recorder.record(step, url, payload);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const stepStarted = Date.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: controller.signal,
        redirect: "error"
      });
      const text = (await response.text()).slice(0, 128);
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
      http.push({
        step: step.step,
        event: step.event,
        url_path_and_query: url.slice(url.indexOf("/getquote")),
        http_status: response.status,
        response_value: value,
        elapsed_ms: Date.now() - stepStarted
      });
    } catch (cause) {
      return {
        status: "failed",
        activeOperatorMs: Date.now() - started,
        error: {
          code: "SUBJECT_ENVIRONMENT_ENDPOINT_UNREACHABLE",
          owner: "subject",
          safeMessage: `step ${String(step.step)} could not reach the environment endpoint: ${cause instanceof Error ? cause.message.slice(0, 100) : "unknown"}`
        }
      };
    } finally {
      clearTimeout(timer);
    }
  }
  const capture = recorder.end();
  const captureJson = `${JSON.stringify(capture, null, 2)}
`;
  const run = runProductValidation(capture);
  const written = /* @__PURE__ */ new Map();
  written.set(`${OUTPUT_ROOT}/capture.json`, captureJson);
  for (const [name, bytes] of run.artifacts) {
    written.set(`${OUTPUT_ROOT}/product-out/${name}`, bytes);
  }
  for (const [name, bytes] of written) {
    context.writeOutput(name, bytes);
  }
  const summary = {
    schema_version: "qualiber-erl2-subject-run-summary/v2",
    run_id: context.runId,
    journey_id: capture.journeyId,
    http_observations: http,
    product_cli: {
      command: "telemetrytest validate --contract <committed contract> --capture <this run's capture> --out <run-scoped dir>",
      exit_code: run.exitCode,
      // Quoted from the product's own run-result.json. The exit code is NOT a
      // verdict: observe/advisory findings exit 0 by design (ADR-002).
      run_status: run.kind === "reported" ? run.runStatus : run.runStatus ?? null,
      completed: run.kind === "reported",
      ...run.kind === "refused" ? { refusal_reason: run.reason } : {}
    },
    // The subject's role, stated in the artifact itself: it reports what the
    // product emitted and computes no pass condition. Scenario judgement is the
    // evaluator's, against oracles this repository never sees.
    subject_role: "This subject reports what the product emitted and asserts nothing about whether that constitutes a pass. The product's own artifacts are under product-out/.",
    artifact_hashes: Object.fromEntries(
      [...written.entries()].map(([name, bytes]) => [name, sha256(bytes)])
    ),
    // Stated in the artifact itself, so a reader of the frozen output cannot
    // acquire the wrong impression from the substrate's name.
    telemetry_source: "Qualiber consumed the analytics JSON of the three requests this subject issued. It did not consume OTLP, and it did not read the collector."
  };
  context.writeOutput(`${OUTPUT_ROOT}/run-summary.json`, `${JSON.stringify(summary, null, 2)}
`);
  context.diagnostic(
    `qualiber: ${String(http.length)} requests issued, telemetrytest exit ${String(run.exitCode)}, ${run.kind === "reported" ? `runStatus ${run.runStatus}` : `refused (${run.reason.slice(0, 80)})`}, ${String(run.artifacts.size)} product artifacts retained`
  );
  if (run.kind === "refused") {
    return {
      status: "failed",
      activeOperatorMs: Date.now() - started,
      error: {
        code: "SUBJECT_PRODUCT_CLI_REFUSED",
        owner: "subject",
        safeMessage: run.reason.slice(0, 200)
      }
    };
  }
  return {
    status: "supported",
    resultSchemaVersion: "qualiber-erl2-subject-interaction/v2",
    activeOperatorMs: Date.now() - started,
    result: {
      requests_issued: http.length,
      product_exit_code: run.exitCode,
      product_run_status: run.runStatus,
      product_artifact_count: run.artifacts.size,
      elapsed_ms: Date.now() - started
    }
  };
}
function uninstall(context) {
  context.diagnostic("removal: this subject holds nothing outside its own run-scoped output directory");
  return {
    status: "supported",
    resultSchemaVersion: "qualiber-erl2-subject-uninstall/v1",
    activeOperatorMs: 150,
    result: { removed: true }
  };
}
function translateEvidence(context) {
  const entries = context.listInput("canonical-evidence");
  const mappings = entries.map((entry) => entry.replace(/\.json$/, "")).map((entryId) => {
    const target = `translated/${entryId}.json`;
    context.writeOutput(target, context.readInput("canonical-evidence", `${entryId}.json`));
    return { entry_id: entryId, disposition: "mapped_exact", target_paths: [target] };
  });
  return {
    status: "supported",
    resultSchemaVersion: "adapter-translation-receipt-draft/v1",
    activeOperatorMs: 250,
    result: {
      schema_version: "adapter-translation-receipt-draft/v1",
      target_root: "translated",
      mappings,
      unmapped_entry_ids: [],
      complete: true
    }
  };
}
function project(context) {
  const claim = (claimId, predicateId, citations) => ({
    claim_id: claimId,
    category: "fact",
    predicate_id: predicateId,
    polarity: "asserted",
    confidence: "1",
    authority: "none",
    citations: citations.map((locator) => ({ locator }))
  });
  const claims = [
    claim("environment-endpoint-answered-three-requests", "endpoint-responded", [
      `${OUTPUT_ROOT}/run-summary.json`
    ]),
    claim("analytics-events-captured-from-request-bodies", "events-captured", [
      `${OUTPUT_ROOT}/capture.json`
    ]),
    claim("product-validation-artifacts-emitted", "product-artifacts-retained", [
      `${OUTPUT_ROOT}/product-out/report.md`,
      `${OUTPUT_ROOT}/product-out/validation-evidence-pack.json`,
      `${OUTPUT_ROOT}/product-out/evidence-pack.json`
    ])
  ];
  context.writeOutput("claims/generic.json", `${JSON.stringify({ claims }, null, 2)}
`);
  return {
    status: "supported",
    resultSchemaVersion: "generic-claim-set-draft/v1",
    activeOperatorMs: 180,
    result: { claims, unprojected: [], complete: true }
  };
}
function reportResidue(context) {
  const requested = operationPayload(context)["checkpoint"];
  const checkpoint = requested === "baseline" || requested === "post_operation" ? requested : "final";
  const observation = observeResidue(checkpoint);
  context.diagnostic(
    `residue scan at ${checkpoint}: ${observation.status}, ${String(observation.residual_paths.length)} path(s) named`
  );
  return {
    status: "supported",
    resultSchemaVersion: "local-residue-observation/v1",
    activeOperatorMs: 100,
    result: observation
  };
}
function compensate(context) {
  context.diagnostic("compensation: this subject declared no mutation, so there is nothing to reverse");
  return {
    status: "supported",
    resultSchemaVersion: "qualiber-erl2-subject-compensation/v1",
    activeOperatorMs: 120,
    result: { compensated: true }
  };
}
function gated(handler) {
  return (context) => assertLocalObservation(context) ?? handler(context);
}
var QUALIBER_ERL2_ADAPTER = {
  adapterId: ADAPTER_ID,
  version: ADAPTER_VERSION,
  // The single lever that tells the host this artifact can be selected for
  // local observation. Governed v2 is refused by the SDK before dispatch, and
  // governed v1 is refused by `gated` before any product interaction.
  supportedProtocolVersions: [PROTOCOL_V2],
  supportedPackageKinds: [...SUPPORTED_PACKAGE_KINDS],
  declaredEntrypoints: ["bin/qualiber-erl2-subject"],
  handlers: {
    acquire: gated(acquire),
    "validate-package": gated(validatePackage),
    install: gated(install),
    configure: gated(configure),
    interact: gated(interact),
    uninstall: gated(uninstall),
    "translate-evidence": gated(translateEvidence),
    project: gated(project),
    "report-residue": gated(reportResidue),
    compensate: gated(compensate)
  }
};
var QUALIBER_ERL2_ADAPTER_OPERATIONS = Object.keys(QUALIBER_ERL2_ADAPTER.handlers);

// src/main.ts
await main(QUALIBER_ERL2_ADAPTER);
