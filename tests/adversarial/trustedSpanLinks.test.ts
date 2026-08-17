/**
 * Span links are an unsupported capability of this MVP, and the refusal is
 * complete (ADR-ERL2-038 §3, package 2 closure).
 *
 * The pinned collector `otelcol-contrib` v0.157.0 exposes no span-link OTTL
 * context: `spanlink`, `link`, `links` and `span_link` are all unknown contexts,
 * `set(span.links, [])` fails at runtime against `ptrace.SpanLinkSlice`, indexed
 * link paths are refused, and the `redaction` processor does not traverse links.
 * There is therefore no mechanism by which the trusted pipeline can remove link
 * attributes or link trace state before export, and an artifact carrying links
 * cannot be minimized to the bound the channel's privacy claim rests on.
 *
 * The decision is to refuse rather than to move the image pin, and this file is
 * what makes that decision load-bearing rather than documentary. Three
 * properties, in order of how easily each could be lost:
 *
 * 1. **Nothing linked is evaluable.** Not the linked span, not its neighbours,
 *    not a reduced count over the survivors.
 * 2. **Nothing unlinked is harmed.** An artifact with no links, and one carrying
 *    the exporter's canonical empty-link representation, both stay valid — a
 *    capability refusal that refused everything would be a denial of service
 *    wearing a safety argument.
 * 3. **Nothing routes around it.** No caller declaration, no fallback to the
 *    retired C-160 authority, no substitute from the debug stream.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  attributableTelemetryGatePassed,
  buildTrustedTelemetryObservation,
  decideTrustedTelemetryAuthority,
  fileTrustedOwnershipStore,
  observeTrustedTelemetry,
  parseTrustedTelemetryRecords,
  TrustedTelemetryChannel,
  TRUSTED_TELEMETRY_REASONS,
  type DockerBinaryResult,
  type DockerInvocation,
  type DockerResult,
  type TrustedChannelBinding,
  type VerifiedTrustedCollector,
} from "@erl2/core";
import { trustedDirectoryArchive } from "../support/tarArchive.js";

const RUN_ID = "01a001f5-48a0-7d19-9c2e-fa3545079b9f";

const COLLECTOR: VerifiedTrustedCollector = {
  serviceId: "otel-collector",
  containerName: `erl2-${RUN_ID}-otel-collector`,
  imageId: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  observedImageRepoDigests: [
    "otel/opentelemetry-collector-contrib@sha256:2222222222222222222222222222222222222222222222222222222222222222",
  ],
};

const BINDING: TrustedChannelBinding = {
  environmentArchetypeHash: `sha256:${"3".repeat(64)}`,
  substrateLockCoreHash: `sha256:${"4".repeat(64)}`,
  collectorImageDigest:
    "otel/opentelemetry-collector-contrib@sha256:2222222222222222222222222222222222222222222222222222222222222222",
  collectorConfigDigest: `sha256:${"5".repeat(64)}`,
};

const roots: string[] = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** One marker-bearing span, with whatever link shape a case needs. */
function span(links: unknown, marker = RUN_ID): Record<string, unknown> {
  return {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    kind: 2,
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000001000000000",
    attributes: [
      { key: "url.full", value: { stringValue: `http://quote:8090/q?erl2_marker=${marker}` } },
    ],
    status: {},
    ...(links === undefined ? {} : { links }),
  };
}

/** A trusted artifact holding exactly these spans, as the exporter would write it. */
function artifact(spans: readonly Record<string, unknown>[]): string {
  return `${JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "quote" } }] },
        scopeSpans: [{ scope: {}, spans: [...spans] }],
      },
    ],
  })}\n`;
}

/** A link carrying subject-controlled payload the pin cannot strip. */
const HOSTILE_LINK = {
  traceId: "1af7651916cd43dd8448eb211c80319c",
  spanId: "c7ad6b7169203331",
  attributes: [
    { key: "session.token", value: { stringValue: `SECRET-${"x".repeat(600)}` } },
  ],
  traceState: `leak=${"y".repeat(600)}`,
};

/** A link reduced to nothing but identifiers — still a link, and still refused. */
const BARE_LINK = { traceId: "1af7651916cd43dd8448eb211c80319c", spanId: "c7ad6b7169203331" };

// -- 1. the accepted shapes ---------------------------------------------------

test("TRUSTED-LINKS: an artifact with no links is unaffected and stays authoritative", () => {
  const parsed = parseTrustedTelemetryRecords(artifact([span(undefined)]), RUN_ID);
  assert.equal(parsed.ok, true, "an unlinked artifact was refused");
  const counts = (parsed as { counts: { spans: number; runAttributedRecords: number } }).counts;
  assert.equal(counts.spans, 1);
  assert.equal(counts.runAttributedRecords, 1, "run attribution was lost from an unlinked artifact");
});

test("TRUSTED-LINKS: the exporter's canonical empty-link representation is accepted", () => {
  // `"links": []` is what the marshaller emits when a span's link slice exists
  // and is empty. Refusing it would refuse a span that has no links, which is
  // the availability failure this whole disposition is trying not to become.
  const parsed = parseTrustedTelemetryRecords(artifact([span([])]), RUN_ID);
  assert.equal(parsed.ok, true, "an empty links array was refused");
  assert.equal((parsed as { counts: { spans: number } }).counts.spans, 1);
});

// -- 2. every nonempty link refuses, with its own reason -----------------------

test("TRUSTED-LINKS: any nonempty link refuses the artifact with the capability reason", () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ["a link reduced to identifiers", [BARE_LINK]],
    ["a link carrying attributes and trace state", [HOSTILE_LINK]],
    ["two links", [BARE_LINK, HOSTILE_LINK]],
    ["a link carrying a key nobody described", [{ ...BARE_LINK, somethingNew: "x" }]],
  ];
  for (const [label, links] of cases) {
    const parsed = parseTrustedTelemetryRecords(artifact([span(links)]), RUN_ID);
    assert.equal(parsed.ok, false, `${label} was accepted`);
    assert.equal(
      (parsed as { reasonCode: string }).reasonCode,
      TRUSTED_TELEMETRY_REASONS.spanLinksUnsupported,
      `${label} refused with the wrong reason`,
    );
  }
});

test("TRUSTED-LINKS: the reason is not any of the neighbours it could be mistaken for", () => {
  const parsed = parseTrustedTelemetryRecords(artifact([span([HOSTILE_LINK])]), RUN_ID);
  const reason = (parsed as { reasonCode: string }).reasonCode;
  // Each of these would send a reader somewhere useless: to the collector's
  // output framing, to an incident response, to a cross-run investigation, or to
  // the conclusion that the subject emitted nothing.
  for (const wrong of [
    TRUSTED_TELEMETRY_REASONS.malformed,
    TRUSTED_TELEMETRY_REASONS.unexpectedField,
    TRUSTED_TELEMETRY_REASONS.unminimized,
    TRUSTED_TELEMETRY_REASONS.forbiddenField,
    TRUSTED_TELEMETRY_REASONS.fieldOverBound,
    TRUSTED_TELEMETRY_REASONS.foreignRun,
    TRUSTED_TELEMETRY_REASONS.incomplete,
  ]) {
    assert.notEqual(reason, wrong, `an unsupported span link was reported as ${wrong}`);
  }
  assert.equal(reason, TRUSTED_TELEMETRY_REASONS.spanLinksUnsupported);
});

test("TRUSTED-LINKS: a hostile link is refused before its payload is ever classified", () => {
  // The link carries a forbidden key *and* an over-bound value, either of which
  // would refuse on its own with a different code. The capability limit wins
  // because the artifact was never evaluable — reporting the payload would
  // suggest that fixing the payload would make it usable, and it would not.
  const parsed = parseTrustedTelemetryRecords(artifact([span([HOSTILE_LINK])]), RUN_ID);
  assert.equal(
    (parsed as { reasonCode: string }).reasonCode,
    TRUSTED_TELEMETRY_REASONS.spanLinksUnsupported,
  );
});

// -- 3. no partial credit -----------------------------------------------------

test("TRUSTED-LINKS: a mixed artifact contributes nothing, not a reduced count", () => {
  // Three unlinked spans and one linked one. A grammar that dropped the linked
  // span and counted the rest would be reporting a number it chose rather than
  // the length of the structure the collector wrote — which is exactly the
  // property that separates this channel from the parser it replaced.
  const mixed = artifact([span(undefined), span(undefined), span([HOSTILE_LINK]), span(undefined)]);
  const parsed = parseTrustedTelemetryRecords(mixed, RUN_ID);
  assert.equal(parsed.ok, false, "a mixed linked/unlinked artifact was accepted");
  assert.equal(
    (parsed as { reasonCode: string }).reasonCode,
    TRUSTED_TELEMETRY_REASONS.spanLinksUnsupported,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed, "counts"),
    false,
    "a refused artifact carried counts a caller could read",
  );
});

test("TRUSTED-LINKS: the linked span's position in the artifact does not change the verdict", () => {
  for (const [label, spans] of [
    ["first", [span([BARE_LINK]), span(undefined)]],
    ["last", [span(undefined), span([BARE_LINK])]],
    ["only", [span([BARE_LINK])]],
  ] as const) {
    const parsed = parseTrustedTelemetryRecords(artifact(spans), RUN_ID);
    assert.equal(parsed.ok, false, `a linked span ${label} in the artifact was accepted`);
    assert.equal(
      (parsed as { reasonCode: string }).reasonCode,
      TRUSTED_TELEMETRY_REASONS.spanLinksUnsupported,
    );
  }
});

test("TRUSTED-LINKS: a second record cannot rescue an artifact whose first record links", () => {
  const bytes = `${artifact([span([BARE_LINK])]).trimEnd()}\n${artifact([span(undefined)]).trimEnd()}\n`;
  const parsed = parseTrustedTelemetryRecords(bytes, RUN_ID);
  assert.equal(parsed.ok, false, "a linked record was tolerated beside an unlinked one");
  assert.equal(
    (parsed as { reasonCode: string }).reasonCode,
    TRUSTED_TELEMETRY_REASONS.spanLinksUnsupported,
  );
});

// -- 4. the whole lifecycle, and the gate -------------------------------------

interface Stub {
  run(invocation: DockerInvocation): DockerResult;
  runBinary(invocation: DockerInvocation): DockerBinaryResult;
}

/** A channel whose collector has already written `bytes` to the trusted volume. */
function channelOver(bytes: string): TrustedTelemetryChannel {
  const root = mkdtempSync(path.join(os.tmpdir(), "erl2-span-links-"));
  roots.push(root);
  const stub: Stub = {
    run: (invocation) => ({
      args: [...invocation.args],
      status: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }),
    runBinary: (invocation) => ({
      args: [...invocation.args],
      status: 0,
      stdout: trustedDirectoryArchive({ "traces.jsonl": bytes }),
      stderr: "",
      timedOut: false,
    }),
  };
  return new TrustedTelemetryChannel({
    runId: RUN_ID,
    docker: stub,
    freezeRoot: root,
    ownership: fileTrustedOwnershipStore({ root, runId: RUN_ID }),
    sleep: () => undefined,
    stabilityAttempts: 4,
  });
}

test("TRUSTED-LINKS: a linked artifact produces an absence with the capability reason, never a count", () => {
  const material = observeTrustedTelemetry({
    channel: channelOver(artifact([span([HOSTILE_LINK])])),
    collector: COLLECTOR,
    binding: BINDING,
    marker: RUN_ID,
  });
  assert.equal(material.evidence, "absent", "a linked artifact produced observed material");
  assert.equal(
    (material as { reasonCode: string }).reasonCode,
    TRUSTED_TELEMETRY_REASONS.spanLinksUnsupported,
  );
  // Not an authentic zero, which is the one misreading with a downstream
  // consequence: a zero is a positive claim a reader is entitled to act on.
  assert.notEqual(material.evidence, "observed");
});

test("TRUSTED-LINKS: the sealed record refuses the gate and retains no link bytes", () => {
  const material = observeTrustedTelemetry({
    channel: channelOver(artifact([span([HOSTILE_LINK])])),
    collector: COLLECTOR,
    binding: BINDING,
    marker: RUN_ID,
  });
  const record = buildTrustedTelemetryObservation({
    runId: RUN_ID,
    observedAt: "2026-08-14T00:00:00Z",
    material,
  });
  assert.equal(record.evidence, "absent");
  assert.equal(record.reason_code, TRUSTED_TELEMETRY_REASONS.spanLinksUnsupported);
  // The link's payload is nowhere in the record. An `absent` record has no
  // `trusted_records` field at all, so the refusal is also what keeps the
  // unstrippable bytes out of the evidence.
  assert.equal(
    JSON.stringify(record).includes("SECRET-"),
    false,
    "link payload survived into the sealed record",
  );
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [record] }),
    false,
    "a linked artifact passed the telemetry gate",
  );
});

test("TRUSTED-LINKS: the retired v1 authority cannot stand in for the refused artifact", () => {
  // C-160 as a fallback is the failure mode that would make the refusal
  // cosmetic: a run whose v2 record is an absence must not become attributable
  // because a v1 record happens to be lying around beside it.
  const material = observeTrustedTelemetry({
    channel: channelOver(artifact([span([BARE_LINK])])),
    collector: COLLECTOR,
    binding: BINDING,
    marker: RUN_ID,
  });
  const refused = buildTrustedTelemetryObservation({
    runId: RUN_ID,
    observedAt: "2026-08-14T00:00:00Z",
    material,
  });
  const v1 = {
    schema_version: "attributable-telemetry-observation/v1",
    run_id: RUN_ID,
    marker: RUN_ID,
    evidence: "observed",
    observed_at: "2026-08-14T00:00:00Z",
    trace_batches: 1,
    spans: 1,
    service_names: ["quote"],
    run_attributed_records: 1,
    log_excerpt: "Traces ... spans: 1",
  };
  for (const [label, observations] of [
    ["v1 alone", [v1]],
    ["v1 beside the refusal", [refused, v1]],
    ["v1 before the refusal", [v1, refused]],
  ] as const) {
    assert.equal(
      attributableTelemetryGatePassed({
        declared: true,
        runId: RUN_ID,
        observations: observations as never,
      }),
      false,
      `${label} authorized a claim the span-link refusal denied`,
    );
  }
  assert.equal(decideTrustedTelemetryAuthority([v1] as never).authoritative, false);
});

test("TRUSTED-LINKS: no caller input can declare a linked artifact safe", () => {
  // The refusal is a property of the collector image the bytes were exported
  // through, not of the run observing them, so there is no true declaration a
  // caller could make. `zeroEligibility` is the one caller-supplied input the
  // observation takes, and it moves nothing here — including in the direction
  // that would turn a refusal into a zero.
  const material = observeTrustedTelemetry({
    channel: channelOver(artifact([span([HOSTILE_LINK])])),
    collector: COLLECTOR,
    binding: BINDING,
    marker: RUN_ID,
    zeroEligibility: { kind: "zero-eligible", justification: "the scenario may emit nothing" },
  });
  assert.equal(material.evidence, "absent");
  assert.equal(
    (material as { reasonCode: string }).reasonCode,
    TRUSTED_TELEMETRY_REASONS.spanLinksUnsupported,
    "a zero-eligibility declaration changed how a linked artifact was classified",
  );
});

test("TRUSTED-LINKS: an unlinked run is still fully observable after all of this", () => {
  // The counterweight. A refusal that also refused the supported case would be
  // indistinguishable from a broken channel, and every assertion above would be
  // satisfied by a parser that simply always said no.
  const material = observeTrustedTelemetry({
    channel: channelOver(artifact([span(undefined), span([])])),
    collector: COLLECTOR,
    binding: BINDING,
    marker: RUN_ID,
  });
  assert.equal(material.evidence, "observed", "an unlinked artifact was refused");
  assert.equal((material as { spans: number }).spans, 2);
  assert.equal((material as { runAttributedRecords: number }).runAttributedRecords, 2);
  const record = buildTrustedTelemetryObservation({
    runId: RUN_ID,
    observedAt: "2026-08-14T00:00:00Z",
    material,
  });
  assert.equal(record.evidence, "observed");
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [record] }),
    true,
    "a legitimate unlinked run was denied by the span-link disposition",
  );
});
