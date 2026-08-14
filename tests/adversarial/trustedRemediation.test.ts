/**
 * The four Package 2 remediation closures, attacked.
 *
 * An independent review of the first Package 2 candidate found four
 * implementation defects in an architecture it otherwise approved. This suite is
 * the measurement that each is closed, and it is written to fail loudly if any
 * of them reopens:
 *
 *   P0-1  six subject-controlled surfaces survived minimization and verified clean
 *   P1-1  settle-budget exhaustion could become an authoritative observed zero
 *   P2-1  the copy path followed a symlink into the host's `/etc/passwd`
 *   P2-2  the parser forbade span-link attributes the collector never stripped
 *
 * Every case here drives the real grammar, the real state machine and the real
 * archive reader. The live half — the same payloads through the pinned collector
 * — is the live matrix; what this suite proves is that the *enforcement points*
 * refuse, independently of whether the processor happened to run.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  observeTrustedTelemetry,
  parseTrustedTelemetryRecords,
  readTrustedArchive,
  unsafeArchiveName,
  TrustedTelemetryChannel,
  TRUSTED_CHANNEL_REASONS,
  TRUSTED_TELEMETRY_REASONS,
  type DockerBinaryResult,
  type DockerInvocation,
  type DockerResult,
  type TrustedChannelBinding,
  type TrustedChannelZeroEligibility,
  type VerifiedTrustedCollector,
} from "@erl2/core";
import { coreHash } from "@erl2/integrity";
import { tarArchive, trustedDirectoryArchive } from "../support/tarArchive.js";

const RUN_ID = "019f9a4a-7a51-7151-9151-515151515151";
const OTHER_RUN = "019f9a4a-7a99-7999-9999-999999999999";

const COLLECTOR: VerifiedTrustedCollector = {
  serviceId: "otel-collector",
  containerName: "erl2-test-otel-collector",
  imageId: "sha256:cafe",
  observedImageRepoDigests: ["repo@sha256:1fef"],
};

const BINDING: TrustedChannelBinding = {
  environmentArchetypeHash: coreHash({ archetype: "remediation" }),
  substrateLockCoreHash: coreHash({ lock: "remediation" }),
  collectorImageDigest: `sha256:${"1f".repeat(32)}`,
  collectorConfigDigest: coreHash({ extras: "remediation" }),
};

const roots: string[] = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// -- P0-1: the recursive minimization surface ---------------------------------

/**
 * A minimized record, with one field grafted in at a chosen nesting level.
 *
 * The base is the exact shape the pinned collector emits after the corrected
 * `transform/trusted`: measured, not invented. Each case below re-introduces one
 * field the pipeline is configured to remove, which is precisely what a
 * configuration regression would look like from here.
 */
function recordWith(graft: {
  readonly resourceSpan?: Record<string, unknown>;
  readonly resource?: Record<string, unknown>;
  readonly scopeSpan?: Record<string, unknown>;
  readonly scope?: Record<string, unknown>;
  readonly span?: Record<string, unknown>;
  readonly event?: Record<string, unknown>;
  readonly link?: Record<string, unknown>;
  readonly attribute?: Record<string, unknown>;
}): string {
  const span: Record<string, unknown> = {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    kind: 2,
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000001000000000",
    attributes: [
      {
        key: "url.full",
        value: { stringValue: `http://quote:8090/q?erl2_marker=${RUN_ID}` },
        ...(graft.attribute ?? {}),
      },
    ],
    status: {},
    ...(graft.event === undefined ? {} : { events: [{ timeUnixNano: "1", ...graft.event }] }),
    ...(graft.link === undefined ? {} : { links: [{ traceId: "1af7", spanId: "c7ad", ...graft.link }] }),
    ...(graft.span ?? {}),
  };
  return `${JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "quote" } }],
          ...(graft.resource ?? {}),
        },
        scopeSpans: [
          {
            scope: { ...(graft.scope ?? {}) },
            spans: [span],
            ...(graft.scopeSpan ?? {}),
          },
        ],
        ...(graft.resourceSpan ?? {}),
      },
    ],
  })}\n`;
}

const HOSTILE = "SENTINEL-".concat("x".repeat(600));

/**
 * The hostile-field matrix the remediation brief requires.
 *
 * Every one of these was either measured surviving into a verified artifact by
 * the independent review, or is the same class of surface one nesting level
 * away. `unminimized` means "the pipeline strips this and it arrived anyway";
 * `unexpectedField` means "nobody described this key at all".
 */
const MINIMIZATION_MATRIX: readonly {
  readonly label: string;
  readonly bytes: string;
  readonly reason: string;
}[] = [
  // -- the six the review measured surviving --------------------------------
  {
    label: "scope attribute carrying a token",
    bytes: recordWith({
      scope: { attributes: [{ key: "session.token", value: { stringValue: HOSTILE } }] },
    }),
    reason: TRUSTED_TELEMETRY_REASONS.unminimized,
  },
  {
    label: "span status message carrying a host path",
    bytes: recordWith({ span: { status: { code: 2, message: `/Users/x/app.php ${HOSTILE}` } } }),
    reason: TRUSTED_TELEMETRY_REASONS.unminimized,
  },
  {
    label: "span name carrying a token",
    bytes: recordWith({ span: { name: `GET /checkout?token=${HOSTILE}` } }),
    reason: TRUSTED_TELEMETRY_REASONS.unminimized,
  },
  {
    label: "span trace state carrying a token",
    bytes: recordWith({ span: { traceState: `leak=${HOSTILE}` } }),
    reason: TRUSTED_TELEMETRY_REASONS.unminimized,
  },
  {
    label: "resource schema URL",
    bytes: recordWith({ resourceSpan: { schemaUrl: `https://s/${HOSTILE}` } }),
    reason: TRUSTED_TELEMETRY_REASONS.unminimized,
  },
  {
    label: "scope schema URL",
    bytes: recordWith({ scopeSpan: { schemaUrl: `https://s/${HOSTILE}` } }),
    reason: TRUSTED_TELEMETRY_REASONS.unminimized,
  },
  // -- scope name and version, oversized ------------------------------------
  {
    label: "scope name oversized",
    bytes: recordWith({ scope: { name: HOSTILE } }),
    reason: TRUSTED_TELEMETRY_REASONS.unminimized,
  },
  {
    label: "scope version oversized",
    bytes: recordWith({ scope: { version: HOSTILE } }),
    reason: TRUSTED_TELEMETRY_REASONS.unminimized,
  },
  // -- events and links ------------------------------------------------------
  {
    label: "event name oversized",
    bytes: recordWith({ event: { name: HOSTILE } }),
    reason: TRUSTED_TELEMETRY_REASONS.unminimized,
  },
  {
    label: "event attribute carrying a stack trace",
    bytes: recordWith({
      event: { attributes: [{ key: "exception.stacktrace", value: { stringValue: HOSTILE } }] },
    }),
    reason: TRUSTED_TELEMETRY_REASONS.unminimized,
  },
  {
    label: "link attribute carrying a token",
    bytes: recordWith({
      link: { attributes: [{ key: "session.token", value: { stringValue: HOSTILE } }] },
    }),
    reason: TRUSTED_TELEMETRY_REASONS.linkNotMinimized,
  },
  {
    label: "link trace state oversized",
    bytes: recordWith({ link: { traceState: HOSTILE } }),
    reason: TRUSTED_TELEMETRY_REASONS.linkNotMinimized,
  },
  // -- unknown keys at every nesting level ----------------------------------
  {
    label: "unknown top-level key",
    bytes: `${JSON.stringify({ resourceSpans: [], somethingElse: HOSTILE })}\n`,
    reason: TRUSTED_TELEMETRY_REASONS.malformed,
  },
  {
    label: "unknown resourceSpan key",
    bytes: recordWith({ resourceSpan: { unknownKey: HOSTILE } }),
    reason: TRUSTED_TELEMETRY_REASONS.unexpectedField,
  },
  {
    label: "unknown resource key",
    bytes: recordWith({ resource: { unknownKey: HOSTILE } }),
    reason: TRUSTED_TELEMETRY_REASONS.unexpectedField,
  },
  {
    label: "unknown scopeSpan key",
    bytes: recordWith({ scopeSpan: { unknownKey: HOSTILE } }),
    reason: TRUSTED_TELEMETRY_REASONS.unexpectedField,
  },
  {
    label: "unknown scope key",
    bytes: recordWith({ scope: { unknownKey: HOSTILE } }),
    reason: TRUSTED_TELEMETRY_REASONS.unexpectedField,
  },
  {
    label: "unknown span key",
    bytes: recordWith({ span: { unknownKey: HOSTILE } }),
    reason: TRUSTED_TELEMETRY_REASONS.unexpectedField,
  },
  {
    label: "unknown status key",
    bytes: recordWith({ span: { status: { code: 1, unknownKey: HOSTILE } } }),
    reason: TRUSTED_TELEMETRY_REASONS.unexpectedField,
  },
  {
    label: "unknown event key",
    bytes: recordWith({ event: { unknownKey: HOSTILE } }),
    reason: TRUSTED_TELEMETRY_REASONS.unexpectedField,
  },
  {
    label: "unknown link key",
    bytes: recordWith({ link: { unknownKey: HOSTILE } }),
    reason: TRUSTED_TELEMETRY_REASONS.unexpectedField,
  },
  {
    label: "unknown attribute key",
    bytes: recordWith({ attribute: { unknownKey: HOSTILE } }),
    reason: TRUSTED_TELEMETRY_REASONS.unexpectedField,
  },
  // -- several at once, so the first refusal is not the only one that works --
  {
    label: "several nested hostile fields together",
    bytes: recordWith({
      scope: { attributes: [{ key: "session.token", value: { stringValue: HOSTILE } }] },
      span: { name: HOSTILE, traceState: HOSTILE, status: { code: 2, message: HOSTILE } },
      resourceSpan: { schemaUrl: HOSTILE },
    }),
    reason: TRUSTED_TELEMETRY_REASONS.unminimized,
  },
];

test("TRUSTED-REMEDIATION: every subject-controlled surface is refused, at every nesting level", () => {
  for (const entry of MINIMIZATION_MATRIX) {
    const parsed = parseTrustedTelemetryRecords(entry.bytes, RUN_ID);
    assert.equal(parsed.ok, false, `${entry.label} was ACCEPTED into an authoritative artifact`);
    assert.equal(
      (parsed as { reasonCode: string }).reasonCode,
      entry.reason,
      `${entry.label} refused with the wrong reason`,
    );
  }
});

test("TRUSTED-REMEDIATION: the minimized shape the pinned collector emits stays readable", () => {
  // Both measured live. Refusing either would be a false refusal, which is its
  // own defect rather than a safer version of a true one.
  const sparse = recordWith({});
  const populated = recordWith({
    resource: { droppedAttributesCount: 3 },
    scope: { droppedAttributesCount: 1 },
    span: {
      parentSpanId: "a1b2c3d4e5f60718",
      flags: 1,
      droppedAttributesCount: 2,
      droppedEventsCount: 1,
      droppedLinksCount: 1,
      status: { code: 2 },
    },
    event: { droppedAttributesCount: 1 },
    link: { flags: 1, droppedAttributesCount: 1 },
  });
  for (const [label, bytes] of [
    ["sparse", sparse],
    ["fully populated", populated],
  ] as const) {
    const parsed = parseTrustedTelemetryRecords(bytes, RUN_ID);
    assert.equal(parsed.ok, true, `the ${label} minimized shape was refused`);
    assert.equal((parsed as { counts: { spans: number } }).counts.spans, 1);
    assert.equal(
      (parsed as { counts: { runAttributedRecords: number } }).counts.runAttributedRecords,
      1,
      `run attribution was lost from the ${label} shape`,
    );
  }
});

// -- P2-2: span links, minimized consistently ---------------------------------

test("TRUSTED-REMEDIATION: a link stripped to its identifiers is accepted, and counts are unmoved", () => {
  // The consistency half of P2-2. The pinned collector has no span-link OTTL
  // context, so the parser is the only enforcement point — but it must accept
  // the shape a linked span reduces to, or every linked span is refused for its
  // structure rather than for its payload.
  const linked = recordWith({ link: { flags: 1, droppedAttributesCount: 1 } });
  const parsed = parseTrustedTelemetryRecords(linked, RUN_ID);
  assert.equal(parsed.ok, true, "a minimized span link was refused");
  const counts = (parsed as { counts: { spans: number; runAttributedRecords: number } }).counts;
  assert.equal(counts.spans, 1, "a link moved the structural span count");
  assert.equal(counts.runAttributedRecords, 1, "a link moved run attribution");
});

// -- P1-1: the false authentic zero -------------------------------------------

interface ZeroStub {
  run(invocation: DockerInvocation): DockerResult;
  runBinary(invocation: DockerInvocation): DockerBinaryResult;
}

/** A channel whose trusted file gains this run's telemetry at read `arrivesAt`. */
function delayedChannel(arrivesAt: number | undefined): TrustedTelemetryChannel {
  const root = mkdtempSync(path.join(os.tmpdir(), "erl2-remediation-"));
  roots.push(root);
  let reads = 0;
  const stub: ZeroStub = {
    run: (invocation) => ({
      args: [...invocation.args],
      status: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }),
    runBinary: (invocation) => {
      reads += 1;
      const present = arrivesAt !== undefined && reads >= arrivesAt;
      return {
        args: [...invocation.args],
        status: 0,
        stdout: trustedDirectoryArchive({
          "traces.jsonl": present ? recordWith({}) : "",
        }),
        stderr: "",
        timedOut: false,
      };
    },
  };
  return new TrustedTelemetryChannel({
    runId: RUN_ID,
    docker: stub,
    freezeRoot: root,
    sleep: () => undefined,
    stabilityAttempts: 6,
  });
}

function observe(
  arrivesAt: number | undefined,
  zeroEligibility?: TrustedChannelZeroEligibility,
): { readonly evidence: string; readonly reasonCode?: string; readonly spans?: number } {
  const material = observeTrustedTelemetry({
    channel: delayedChannel(arrivesAt),
    collector: COLLECTOR,
    binding: BINDING,
    marker: RUN_ID,
    ...(zeroEligibility === undefined ? {} : { zeroEligibility }),
  });
  return material.evidence === "observed"
    ? { evidence: "observed", spans: material.spans }
    : { evidence: "absent", reasonCode: material.reasonCode };
}

const ZERO_ELIGIBLE: TrustedChannelZeroEligibility = {
  kind: "zero-eligible",
  justification: "the scenario's contract permits a run that emits no telemetry",
};

test("TRUSTED-REMEDIATION: telemetry arriving after the settle budget is never an observed zero", () => {
  // The independent review's exact reproduction. Before the correction both of
  // these produced `evidence: observed, spans: 0` — byte-identical to a genuine
  // zero and indistinguishable from it by any reader.
  for (const arrivesAt of [7, 12, 40]) {
    const result = observe(arrivesAt);
    assert.equal(
      result.evidence,
      "absent",
      `telemetry delayed to read ${String(arrivesAt)} was frozen as an authoritative zero`,
    );
    assert.equal(result.reasonCode, TRUSTED_CHANNEL_REASONS.expectedTelemetryMissing);
  }
});

test("TRUSTED-REMEDIATION: telemetry inside the budget is still observed positively", () => {
  for (const arrivesAt of [1, 2, 4]) {
    const result = observe(arrivesAt);
    assert.equal(result.evidence, "observed", `telemetry at read ${String(arrivesAt)} was lost`);
    assert.equal(result.spans, 1);
  }
});

test("TRUSTED-REMEDIATION: a zero is authoritative only when the run was declared eligible for one", () => {
  // Nothing said: the fail-closed answer, and the default.
  assert.deepEqual(observe(undefined), {
    evidence: "absent",
    reasonCode: TRUSTED_CHANNEL_REASONS.expectedTelemetryMissing,
  });
  // Said explicitly, and still fail-closed.
  assert.equal(observe(undefined, { kind: "expects-telemetry" }).evidence, "absent");
  // Declared before observation, and only then a positive claim.
  const eligible = observe(undefined, ZERO_ELIGIBLE);
  assert.equal(eligible.evidence, "observed");
  assert.equal(eligible.spans, 0);
});

test("TRUSTED-REMEDIATION: a zero-eligible run that receives foreign traffic still refuses", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "erl2-remediation-foreign-"));
  roots.push(root);
  const channel = new TrustedTelemetryChannel({
    runId: RUN_ID,
    docker: {
      run: (i) => ({ args: [...i.args], status: 0, stdout: "", stderr: "", timedOut: false }),
      runBinary: (i) => ({
        args: [...i.args],
        status: 0,
        stdout: trustedDirectoryArchive({
          "traces.jsonl": recordWith({}).replace(RUN_ID, OTHER_RUN),
        }),
        stderr: "",
        timedOut: false,
      }),
    },
    freezeRoot: root,
    sleep: () => undefined,
    stabilityAttempts: 4,
  });
  const material = observeTrustedTelemetry({
    channel,
    collector: COLLECTOR,
    binding: BINDING,
    marker: RUN_ID,
    zeroEligibility: ZERO_ELIGIBLE,
  });
  assert.equal(material.evidence, "absent");
  assert.equal(
    material.evidence === "absent" ? material.reasonCode : "",
    TRUSTED_TELEMETRY_REASONS.foreignRun,
  );
});

// -- P2-1: the non-dereferencing source inspection ----------------------------

/** A channel whose `docker cp` answers with a chosen archive, verbatim. */
function archiveChannel(archive: Buffer): TrustedTelemetryChannel {
  const root = mkdtempSync(path.join(os.tmpdir(), "erl2-remediation-archive-"));
  roots.push(root);
  return new TrustedTelemetryChannel({
    runId: RUN_ID,
    docker: {
      run: (i) => ({ args: [...i.args], status: 0, stdout: "", stderr: "", timedOut: false }),
      runBinary: (i) => ({
        args: [...i.args],
        status: 0,
        stdout: archive,
        stderr: "",
        timedOut: false,
      }),
    },
    freezeRoot: root,
    sleep: () => undefined,
    stabilityAttempts: 3,
  });
}

test("TRUSTED-REMEDIATION: a non-regular source entry is refused before anything dereferences it", () => {
  // The planted-symlink reproduction, and its neighbours. The review's original
  // exploit named a symlink `traces.jsonl` and the copy path followed it into
  // the host's `/etc/passwd`; the type now comes from the archive header, so the
  // name never reaches a filesystem at all.
  const cases: readonly { readonly label: string; readonly type: string; readonly link?: string }[] = [
    { label: "symlink to /etc/passwd", type: "2", link: "/etc/passwd" },
    { label: "relative symlink", type: "2", link: "../../etc/passwd" },
    { label: "hard link", type: "1", link: "/etc/passwd" },
    { label: "directory", type: "5" },
    { label: "FIFO", type: "6" },
    { label: "character device", type: "3" },
    { label: "block device", type: "4" },
    { label: "undefined ustar type", type: "Z" },
  ];
  for (const entry of cases) {
    const archive = tarArchive([
      { name: "trusted/", type: "5" },
      {
        name: `trusted/traces.jsonl`,
        type: entry.type,
        ...(entry.link === undefined ? {} : { linkName: entry.link }),
      },
    ]);
    const freeze = archiveChannel(archive).close(COLLECTOR);
    assert.equal(freeze.frozen, false, `${entry.label} was frozen as an artifact`);
    assert.equal(
      (freeze as { reasonCode: string }).reasonCode,
      TRUSTED_CHANNEL_REASONS.sourceEntryNotRegular,
      `${entry.label} refused with the wrong reason`,
    );
  }
});

test("TRUSTED-REMEDIATION: a regular source entry still freezes, from the bytes that were classified", () => {
  const bytes = recordWith({});
  const freeze = archiveChannel(trustedDirectoryArchive({ "traces.jsonl": bytes })).close(COLLECTOR);
  assert.equal(freeze.frozen, true);
  assert.equal(freeze.frozen === true ? freeze.bytes : "", bytes, "the frozen bytes are not the entry's");
});

test("TRUSTED-REMEDIATION: the copy path writes nothing to this host's filesystem", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "erl2-remediation-nowrite-"));
  roots.push(root);
  const channel = new TrustedTelemetryChannel({
    runId: RUN_ID,
    docker: {
      run: (i) => ({ args: [...i.args], status: 0, stdout: "", stderr: "", timedOut: false }),
      runBinary: (i) => ({
        args: [...i.args],
        status: 0,
        stdout: trustedDirectoryArchive({ "traces.jsonl": recordWith({}) }),
        stderr: "",
        timedOut: false,
      }),
    },
    freezeRoot: root,
    sleep: () => undefined,
    stabilityAttempts: 3,
  });
  assert.equal(channel.close(COLLECTOR).frozen, true);
  // No extraction means no window between classifying an entry and reading it,
  // because there is no second lookup at all.
  assert.equal(readdirSync(root).length, 0, "the freeze extracted the archive");
});

test("TRUSTED-REMEDIATION: `docker cp` is asked for the archive, never for an extraction", () => {
  const seen: string[][] = [];
  const root = mkdtempSync(path.join(os.tmpdir(), "erl2-remediation-argv-"));
  roots.push(root);
  new TrustedTelemetryChannel({
    runId: RUN_ID,
    docker: {
      run: (i) => ({ args: [...i.args], status: 0, stdout: "", stderr: "", timedOut: false }),
      runBinary: (i) => {
        seen.push([...i.args]);
        return {
          args: [...i.args],
          status: 0,
          stdout: trustedDirectoryArchive({ "traces.jsonl": recordWith({}) }),
          stderr: "",
          timedOut: false,
        };
      },
    },
    freezeRoot: root,
    sleep: () => undefined,
    stabilityAttempts: 3,
  }).close(COLLECTOR);
  assert.ok(seen.length > 0, "the freeze took no copy");
  for (const args of seen) {
    assert.deepEqual(args.slice(0, 2), ["cp", `${COLLECTOR.containerName}:/trusted`]);
    assert.equal(args[2], "-", "the copy extracted to a path instead of reading the archive");
  }
});

test("TRUSTED-REMEDIATION: traversal and absolute archive names are refused", () => {
  for (const name of ["/etc/passwd", "trusted/../../etc/passwd", "C:/windows/system32"]) {
    assert.equal(unsafeArchiveName(name), true, `${name} was treated as an ordinary entry`);
  }
  for (const name of ["trusted/traces.jsonl", "trusted/"]) {
    assert.equal(unsafeArchiveName(name), false, `${name} was refused as unsafe`);
  }
});

test("TRUSTED-REMEDIATION: the archive reader classifies without extracting, and bounds its payload", () => {
  const archive = tarArchive([
    { name: "trusted/", type: "5" },
    { name: "trusted/traces.jsonl", bytes: "{}\n" },
  ]);
  const read = readTrustedArchive(archive, 1024);
  assert.equal(read.ok, true);
  const entries = (read as { entries: readonly { name: string; type: string }[] }).entries;
  assert.deepEqual(
    entries.map((entry) => `${entry.name}:${entry.type}`),
    ["trusted/:directory", "trusted/traces.jsonl:regular-file"],
  );
  // A member larger than the caller's bound is refused rather than buffered.
  const big = tarArchive([{ name: "trusted/traces.jsonl", bytes: "x".repeat(4096) }]);
  assert.equal(readTrustedArchive(big, 1024).ok, false);
});
