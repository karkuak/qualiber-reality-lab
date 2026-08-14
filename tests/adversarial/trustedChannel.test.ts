/**
 * The trusted telemetry channel, attacked (ADR-ERL2-038, package 2).
 *
 * Package 1's suite proves that a record of the wrong shape cannot authorize a
 * claim. This one proves the other half: that the lifecycle which *produces*
 * records refuses to produce one from a substrate that is not in the state the
 * contract describes — a volume it did not create, a directory holding more
 * than the one expected file, bytes that are still moving, a copy that failed,
 * an artifact over the cap, and a collector Docker will not confirm.
 *
 * Every case here drives the real `TrustedTelemetryChannel` against a stub
 * Docker seam. The stub is not a simulation of the substrate's *behaviour* —
 * the live matrix does that, against the pinned collector — it is a way to hold
 * the substrate in states a live daemon cannot be asked for on demand, and to
 * make each refusal reachable by a mutation.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { validateContract, type AttributableTelemetryObservationV2 } from "@erl2/contracts";
import { tarArchive, trustedDirectoryArchive } from "../support/tarArchive.js";
import { coreHash, coreOf } from "@erl2/integrity";
import {
  attributableTelemetryGatePassed,
  buildTrustedTelemetryObservation,
  decideTrustedTelemetryAuthority,
  observeTrustedTelemetry,
  parseTrustedTelemetryRecords,
  trustedTelemetryClaimRefusal,
  trustedVolumeMountOptions,
  trustedVolumeName,
  TrustedTelemetryChannel,
  TRUSTED_CHANNEL_FILE_NAME,
  TRUSTED_CHANNEL_REASONS,
  TRUSTED_RESOURCE_KEYS,
  TRUSTED_SPAN_KEYS,
  TRUSTED_TELEMETRY_MAX_BYTES,
  TRUSTED_TELEMETRY_MAX_FIELD_CHARS,
  type DockerInvocation,
  type DockerResult,
  type DockerBinaryResult,
  type TrustedChannelBinding,
  type VerifiedTrustedCollector,
} from "@erl2/core";

const RUN_ID = "019f9a4a-7a51-7151-9151-515151515151";
const OTHER_RUN = "019f9a4a-7a99-7999-9999-999999999999";

const COLLECTOR: VerifiedTrustedCollector = {
  serviceId: "otel-collector",
  containerName: "erl2-test-otel-collector",
  imageId: "sha256:cafe",
  observedImageRepoDigests: ["repo@sha256:1fef"],
};

const BINDING: TrustedChannelBinding = {
  environmentArchetypeHash: coreHash({ archetype: "trusted-channel" }),
  substrateLockCoreHash: coreHash({ lock: "trusted-channel" }),
  collectorImageDigest: `sha256:${"1f".repeat(32)}`,
  collectorConfigDigest: coreHash({ extras: "trusted-channel" }),
};

/** One structurally framed record naming `marker`, with `spans` spans. */
function record(marker: string, spans = 1, service = "quote"): string {
  return `${JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
        scopeSpans: [
          {
            spans: Array.from({ length: spans }, () => ({
              attributes: [
                { key: "url.full", value: { stringValue: `http://quote:8090/q?erl2_marker=${marker}` } },
              ],
            })),
          },
        ],
      },
    ],
  })}\n`;
}

interface StubOptions {
  /** A verbatim archive, for entry-type cases a file map cannot express. */
  readonly archive?: Buffer;
  /** The trusted directory's contents, by file name. `undefined` means no directory. */
  readonly files?: Record<string, string | Buffer> | undefined;
  /** Successive directory states, one per `docker cp`. Models bytes still arriving. */
  readonly sequence?: readonly (Record<string, string | Buffer> | undefined)[];
  readonly existingVolumes?: readonly string[];
  readonly createFails?: boolean;
  readonly copyFails?: boolean;
  readonly removeFails?: boolean;
  readonly reportedOptions?: string;
}

interface Stub {
  run(invocation: DockerInvocation): DockerResult;
  runBinary(invocation: DockerInvocation): DockerBinaryResult;
  readonly commands: string[][];
  copies: number;
}

function stubDocker(options: StubOptions = {}): Stub {
  const volumes = new Set(options.existingVolumes ?? []);
  const stub: Stub = {
    commands: [],
    copies: 0,
    run(invocation: DockerInvocation): DockerResult {
      const args = [...invocation.args];
      stub.commands.push(args);
      const ok = (stdout = ""): DockerResult => ({ args, status: 0, stdout, stderr: "", timedOut: false });
      const no = (stderr = "stub refusal"): DockerResult => ({ args, status: 1, stdout: "", stderr, timedOut: false });

      if (args[0] === "volume" && args[1] === "inspect") {
        if (!volumes.has(args[2] as string)) return no();
        const format = args[args.indexOf("--format") + 1] ?? "";
        return ok(
          `${String(format).includes("Options") ? (options.reportedOptions ?? trustedVolumeMountOptions()) : args[2]}\n`,
        );
      }
      if (args[0] === "volume" && args[1] === "create") {
        if (options.createFails === true) return no("stub: create refused");
        volumes.add(args.at(-1) as string);
        return ok();
      }
      if (args[0] === "volume" && args[1] === "rm") {
        if (options.removeFails === true) return no("volume is in use");
        volumes.delete(args[2] as string);
        return ok();
      }
      if (args[0] === "cp") {
        // The channel reads the archive through `runBinary`; a text `cp` here
        // would mean the caller took a path that cannot classify entry types.
        return no("stub: cp must be read as an archive");
      }
      return no(`stub: unhandled ${args.join(" ")}`);
    },
    runBinary(invocation: DockerInvocation): DockerBinaryResult {
      const args = [...invocation.args];
      stub.commands.push(args);
      if (args[0] !== "cp") {
        return { args, status: 1, stdout: Buffer.alloc(0), stderr: "stub: unhandled", timedOut: false };
      }
      if (options.copyFails === true) {
        return { args, status: 1, stdout: Buffer.alloc(0), stderr: "stub: copy refused", timedOut: false };
      }
      const state =
        options.sequence === undefined
          ? options.files
          : (options.sequence[Math.min(stub.copies, options.sequence.length - 1)] ?? undefined);
      stub.copies += 1;
      // A stopped collector's tmpfs is gone, and `docker cp` of the directory
      // answers with an empty archive rather than an error — measured.
      const archive =
        options.archive ?? trustedDirectoryArchive(state ?? {});
      return { args, status: 0, stdout: archive, stderr: "", timedOut: false };
    },
  };
  return stub;
}

const roots: string[] = [];
function channelFor(options: StubOptions = {}, runId = RUN_ID): {
  readonly channel: TrustedTelemetryChannel;
  readonly docker: Stub;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "erl2-trusted-channel-"));
  roots.push(root);
  const docker = stubDocker(options);
  return {
    docker,
    channel: new TrustedTelemetryChannel({
      runId,
      docker,
      freezeRoot: root,
      project: `erl2-${runId}`,
      sleep: () => undefined,
      stabilityAttempts: 4,
    }),
  };
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// -- provisioning -------------------------------------------------------------

test("TRUSTED-CHANNEL: the volume is created with the collector's ownership and a size bound", () => {
  const { channel, docker } = channelFor();
  const provisioned = channel.provision();
  assert.equal(provisioned.provisioned, true);
  const create = docker.commands.find((args) => args[0] === "volume" && args[1] === "create");
  assert.ok(create !== undefined, "no volume was created");
  // The measured mechanism, exactly: a fresh named volume without these options
  // fails the collector closed at start-up with `permission denied`.
  assert.ok(create.includes("type=tmpfs"), `driver options omit tmpfs: ${create.join(" ")}`);
  assert.ok(create.includes("device=tmpfs"));
  assert.ok(
    create.includes(`o=${trustedVolumeMountOptions()}`),
    `ownership and size are not expressed as volume options: ${create.join(" ")}`,
  );
  assert.ok(trustedVolumeMountOptions().includes("uid=10001"));
  assert.ok(trustedVolumeMountOptions().includes("gid=10001"));
  assert.ok(trustedVolumeMountOptions().includes("mode=0700"), "the trusted file must not be world-readable");
  assert.ok(/size=\d+[kmg]/i.test(trustedVolumeMountOptions()), "a memory-backed volume must be size-bounded");
  // Run-scoped and unguessable: the name carries the run's own UUID, which is
  // what lets `assertOwnedByRun` prove ownership from the name alone.
  assert.equal(create.at(-1), trustedVolumeName(RUN_ID));
  assert.ok(trustedVolumeName(RUN_ID).includes(RUN_ID));
  assert.ok(create.includes(`com.erl2.run_id=${RUN_ID}`), "the volume carries no run label");
});

test("TRUSTED-CHANNEL: a volume of this run's name that already exists is refused, never adopted", () => {
  const { channel, docker } = channelFor({ existingVolumes: [trustedVolumeName(RUN_ID)] });
  const provisioned = channel.provision();
  assert.equal(provisioned.provisioned, false);
  assert.equal(
    (provisioned as { reasonCode: string }).reasonCode,
    TRUSTED_CHANNEL_REASONS.volumeStale,
  );
  assert.equal(
    docker.commands.some((args) => args[0] === "volume" && args[1] === "create"),
    false,
    "a stale volume must not be re-created over",
  );
  // And nothing this channel did not create may be removed by its cleanup.
  assert.deepEqual(channel.cleanup(), { attempted: false, removed: false, surviving: [] });
});

test("TRUSTED-CHANNEL: a daemon that ignored the ownership options is refused, not trusted", () => {
  const { channel } = channelFor({ reportedOptions: "size=64m" });
  const provisioned = channel.provision();
  assert.equal(provisioned.provisioned, false);
  assert.equal(
    (provisioned as { reasonCode: string }).reasonCode,
    TRUSTED_CHANNEL_REASONS.mountOptionsUnexpected,
  );
});

test("TRUSTED-CHANNEL: a volume that could not be created is a refusal with its own code", () => {
  const { channel } = channelFor({ createFails: true });
  assert.equal(
    (channel.provision() as { reasonCode: string }).reasonCode,
    TRUSTED_CHANNEL_REASONS.unprovisioned,
  );
});

// -- freezing -----------------------------------------------------------------

test("TRUSTED-CHANNEL: exactly one file is frozen, and a second is refused rather than ignored", () => {
  const bytes = record(RUN_ID, 2);
  const one = channelFor({ files: { [TRUSTED_CHANNEL_FILE_NAME]: bytes } });
  const frozen = one.channel.close(COLLECTOR);
  assert.equal(frozen.frozen, true);
  assert.deepEqual((frozen as { fileNames: readonly string[] }).fileNames, [TRUSTED_CHANNEL_FILE_NAME]);

  // A rotated segment, a second exporter's output, anything at all: the whole
  // directory is enumerated precisely so `segment_count: 1` is enforced rather
  // than merely declared.
  const two = channelFor({
    files: { [TRUSTED_CHANNEL_FILE_NAME]: bytes, [`${TRUSTED_CHANNEL_FILE_NAME}.1`]: bytes },
  });
  const refused = two.channel.close(COLLECTOR);
  assert.equal(refused.frozen, false);
  assert.equal((refused as { reasonCode: string }).reasonCode, TRUSTED_CHANNEL_REASONS.unexpectedFile);
});

test("TRUSTED-CHANNEL: a missing artifact and a failed copy stay different refusals", () => {
  // The measured crash shape. A collector killed before the freeze takes its
  // tmpfs with it, and what `docker cp` then finds is the bare mount point: the
  // copy *succeeds*, onto an empty directory. Reported live with SIGKILL as
  // `telemetry_channel_artifact_missing`, which is the honest description —
  // the channel was there and the artifact was not.
  assert.equal(
    (channelFor({ files: {} }).channel.close(COLLECTOR) as { reasonCode: string }).reasonCode,
    TRUSTED_CHANNEL_REASONS.artifactMissing,
  );
  // A copy that could not be taken at all is a different fact, and stays one:
  // "I could not look" must not be reported as "I looked and there was nothing".
  assert.equal(
    (channelFor({ copyFails: true }).channel.close(COLLECTOR) as { reasonCode: string }).reasonCode,
    TRUSTED_CHANNEL_REASONS.copyFailed,
  );
  // An archive the daemon sent but this reader cannot frame is also "I could not
  // look" — truncated headers are not an empty trusted directory.
  assert.equal(
    (
      channelFor({ archive: Buffer.from("not a tar stream at all") }).channel.close(
        COLLECTOR,
      ) as { reasonCode: string }
    ).reasonCode,
    TRUSTED_CHANNEL_REASONS.artifactMissing,
  );
});

test("TRUSTED-CHANNEL: bytes that never stop moving are refused, never half-frozen", () => {
  // Every read differs from the last, so no two consecutive copies agree and the
  // budget expires without a stable observation. A prefix of an artifact is not
  // an artifact, and freezing one would hash bytes the collector was still
  // appending to.
  const growing = [1, 2, 3, 4, 5, 6].map((n) => ({ [TRUSTED_CHANNEL_FILE_NAME]: record(RUN_ID, n) }));
  const { channel } = channelFor({ sequence: growing });
  const frozen = channel.close(COLLECTOR);
  assert.equal(frozen.frozen, false);
  assert.equal((frozen as { reasonCode: string }).reasonCode, TRUSTED_CHANNEL_REASONS.notFinalized);
});

test("TRUSTED-CHANNEL: the frozen digest is over the exact bytes, and a later write cannot reach it", () => {
  const bytes = record(RUN_ID, 3);
  const { channel } = channelFor({ files: { [TRUSTED_CHANNEL_FILE_NAME]: bytes } });
  const frozen = channel.close(COLLECTOR) as {
    frozen: true;
    bytes: string;
    byteLength: number;
    contentDigest: string;
  };
  assert.equal(frozen.bytes, bytes);
  assert.equal(frozen.byteLength, Buffer.byteLength(bytes, "utf8"));

  // The artifact is the copy. Mutating the source afterwards changes nothing the
  // record carries, because the record carries the bytes rather than a path.
  const material = observeTrustedTelemetry({
    channel,
    collector: COLLECTOR,
    binding: BINDING,
    marker: RUN_ID,
  });
  assert.equal(material.evidence, "observed");
  const observation = buildTrustedTelemetryObservation({
    runId: RUN_ID,
    observedAt: "2026-08-14T00:00:00Z",
    material,
  });
  assert.equal(observation.artifact?.content_digest, frozen.contentDigest);
  assert.equal(observation.trusted_records, bytes);
  assert.equal(decideTrustedTelemetryAuthority([observation]).authoritative, true);
});

test("TRUSTED-CHANNEL: an artifact over the retention bound fails closed and is never truncated to fit", () => {
  const filler = record(RUN_ID, 1).repeat(Math.ceil(TRUSTED_TELEMETRY_MAX_BYTES / record(RUN_ID, 1).length) + 1);
  assert.ok(Buffer.byteLength(filler, "utf8") > TRUSTED_TELEMETRY_MAX_BYTES);
  const { channel } = channelFor({ files: { [TRUSTED_CHANNEL_FILE_NAME]: filler } });
  const frozen = channel.close(COLLECTOR);
  assert.equal(frozen.frozen, false);
  assert.equal((frozen as { reasonCode: string }).reasonCode, TRUSTED_CHANNEL_REASONS.overSizeBound);
});

// -- the material and the record ----------------------------------------------

test("TRUSTED-CHANNEL: an empty artifact is an authentic observed zero, not an absence", () => {
  // Only for a run whose contract permitted zero, and only because that was
  // bound before the channel was observed. The same empty file for a run that
  // expects telemetry is a refusal — see the settle-semantics test below.
  const { channel } = channelFor({ files: { [TRUSTED_CHANNEL_FILE_NAME]: "" } });
  const material = observeTrustedTelemetry({
    channel,
    collector: COLLECTOR,
    binding: BINDING,
    marker: RUN_ID,
    zeroEligibility: { kind: "zero-eligible", justification: "scenario emits no telemetry" },
  });
  assert.equal(material.evidence, "observed");
  const observation = buildTrustedTelemetryObservation({
    runId: RUN_ID,
    observedAt: "2026-08-14T00:00:00Z",
    material,
  });
  assert.equal(observation.evidence, "observed");
  assert.equal(observation.spans, 0);
  assert.equal(observation.artifact?.record_count, 0);
  // False exactly when the artifact is empty, which is what the contract says.
  assert.equal(observation.artifact?.final_record_terminated, false);
  assert.equal(observation.reason_code, undefined, "an observed zero must not carry a reason code");
  // It governs — and it governs a refusal, because nothing attributed this run.
  assert.equal(decideTrustedTelemetryAuthority([observation]).authoritative, true);
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [observation] }),
    false,
  );
});

test("TRUSTED-CHANNEL: an unverified collector produces an absent record with a reason, never a zero", () => {
  const { channel } = channelFor({ files: { [TRUSTED_CHANNEL_FILE_NAME]: record(RUN_ID) } });
  const material = observeTrustedTelemetry({
    channel,
    collector: undefined,
    binding: BINDING,
    marker: RUN_ID,
  });
  assert.equal(material.evidence, "absent");
  const observation = buildTrustedTelemetryObservation({
    runId: RUN_ID,
    observedAt: "2026-08-14T00:00:00Z",
    material,
  });
  assert.equal(observation.evidence, "absent");
  assert.equal(observation.reason_code, TRUSTED_CHANNEL_REASONS.collectorNotVerified);
  assert.equal(observation.spans, undefined, "an absent record may not carry counts");
  assert.equal(observation.trusted_records, undefined, "an absent record may not carry bytes");
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [observation] }),
    false,
  );
});

test("TRUSTED-CHANNEL: the produced record satisfies ERL2-C-171 and its own core hash", () => {
  const { channel } = channelFor({ files: { [TRUSTED_CHANNEL_FILE_NAME]: record(RUN_ID, 4) } });
  const observation = buildTrustedTelemetryObservation({
    runId: RUN_ID,
    observedAt: "2026-08-14T00:00:00Z",
    material: observeTrustedTelemetry({ channel, collector: COLLECTOR, binding: BINDING, marker: RUN_ID }),
  });
  assert.equal(validateContract("AttributableTelemetryObservationV2", observation).valid, true);
  assert.equal(coreHash(coreOf(observation as unknown as Record<string, unknown>)), observation.core_hash);
  // The channel identity is what makes a debug-stream origin unrepresentable.
  assert.equal(observation.channel?.kind, "collector-file-otlp-json");
  assert.equal(observation.channel?.record_format, "otlp-json-ndjson");
  assert.equal(observation.channel?.rotation, "forbidden");
  assert.equal(observation.channel?.segment_count, 1);
  assert.equal(observation.artifact?.finalization, "frozen");
  // Counts are recomputed from the bytes, not reported by the collector.
  assert.equal(observation.spans, 4);
  assert.equal(observation.run_attributed_records, 4);
  assert.equal(trustedTelemetryClaimRefusal([observation]), undefined);
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [observation] }),
    true,
  );
});

test("TRUSTED-CHANNEL: another run's frozen artifact cannot satisfy this run", () => {
  const { channel } = channelFor({ files: { [TRUSTED_CHANNEL_FILE_NAME]: record(OTHER_RUN, 2) } }, OTHER_RUN);
  const foreign = buildTrustedTelemetryObservation({
    runId: OTHER_RUN,
    observedAt: "2026-08-14T00:00:00Z",
    material: observeTrustedTelemetry({ channel, collector: COLLECTOR, binding: BINDING, marker: OTHER_RUN }),
  });
  // Coherent, authoritative, and its own run's — and still refused here.
  assert.equal(decideTrustedTelemetryAuthority([foreign]).authoritative, true);
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [foreign] }),
    false,
  );
});

test("TRUSTED-CHANNEL: a foreign marker inside this run's bytes is refused rather than skipped", () => {
  const mixed = record(RUN_ID, 1) + record(OTHER_RUN, 1);
  const { channel } = channelFor({ files: { [TRUSTED_CHANNEL_FILE_NAME]: mixed } });
  const material = observeTrustedTelemetry({
    channel,
    collector: COLLECTOR,
    binding: BINDING,
    marker: RUN_ID,
  });
  assert.equal(material.evidence, "absent");
  // Skipping would still have counted the foreign record's bytes as this run's.
  assert.equal(
    (material as { reasonCode: string }).reasonCode,
    "telemetry_foreign_run_record_present",
  );
});

// -- what the subject cannot do ----------------------------------------------

test("TRUSTED-CHANNEL: a hostile payload cannot create a physical record or move a count", () => {
  // Everything the mixed console stream let a subject forge, inside one span
  // attribute: raw newlines, a `\t{` region closer, a complete forged summary
  // line declaring 9999 spans, and a whole forged OTLP-JSON document.
  const hostile =
    "begin\n\t{\"closed\":\"region\"}\n" +
    "2026-08-13T21:33:32.634Z\tinfo\tTraces\t{\"otelcol.signal\": \"traces\", \"spans\": 9999}\n" +
    `${JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [{}, {}, {}] }] }] })}\n` +
    "qué€𝄞\ttabbed\r\nend";
  const bytes = `${JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "quote" } }] },
        scopeSpans: [
          {
            spans: [
              {
                attributes: [
                  {
                    key: "url.full",
                    value: { stringValue: `http://q/?erl2_marker=${RUN_ID}&x=${hostile}` },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  })}\n`;

  const { channel } = channelFor({ files: { [TRUSTED_CHANNEL_FILE_NAME]: bytes } });
  const observation = buildTrustedTelemetryObservation({
    runId: RUN_ID,
    observedAt: "2026-08-14T00:00:00Z",
    material: observeTrustedTelemetry({ channel, collector: COLLECTOR, binding: BINDING, marker: RUN_ID }),
  });
  assert.equal(observation.evidence, "observed");
  // One physical record, one structural span. The forged 9999 is a numeral
  // inside a JSON string, and there is no reader here that believes a numeral.
  assert.equal(observation.artifact?.record_count, 1);
  assert.equal(observation.spans, 1);
  assert.equal(observation.trace_batches, 1);
  assert.equal(observation.run_attributed_records, 1);
  assert.ok(observation.trusted_records?.includes("9999"), "the forged numeral is retained as data");
  assert.equal(
    (observation.trusted_records?.match(/\n/g) ?? []).length,
    1,
    "the subject's newlines became physical record boundaries",
  );
});

test("TRUSTED-CHANNEL: a sensitive attribute in the retained bytes refuses with its own code", () => {
  for (const [key, expected] of [
    ["session.token", "telemetry_trusted_record_forbidden_field"],
    ["http.request.header.authorization", "telemetry_trusted_record_forbidden_field"],
    ["subject.note", "telemetry_trusted_record_unexpected_field"],
  ] as const) {
    const bytes = `${JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "quote" } }] },
          scopeSpans: [{ spans: [{ attributes: [{ key, value: { stringValue: "x" } }] }] }],
        },
      ],
    })}\n`;
    const parsed = parseTrustedTelemetryRecords(bytes, RUN_ID);
    assert.equal(parsed.ok, false, `${key} was accepted into the trusted artifact`);
    assert.equal((parsed as { reasonCode: string }).reasonCode, expected);
  }
});

test("TRUSTED-CHANNEL: a span event's attributes and name are both refused", () => {
  // The hole package 2 measured: `keep_keys(span.attributes, …)` does not reach
  // a span's events, and a live run retained an `exception` event carrying a
  // full stack trace with host file paths.
  const withEventAttribute = `${JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "quote" } }] },
        scopeSpans: [
          {
            spans: [
              {
                attributes: [],
                events: [
                  {
                    name: "exception",
                    attributes: [
                      { key: "exception.stacktrace", value: { stringValue: "at /var/www/app/routes.php:26" } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  })}\n`;
  const refused = parseTrustedTelemetryRecords(withEventAttribute, RUN_ID);
  assert.equal(refused.ok, false, "a stack trace survived minimization into the artifact");
  assert.equal(
    (refused as { reasonCode: string }).reasonCode,
    "telemetry_trusted_record_unminimized_field",
  );

  // A minimized event — a timestamp and nothing else — is the shape the trusted
  // pipeline now actually produces, and it must remain readable. The remediation
  // removes the event name rather than bounding it: no ERL2-C-171 count reads it,
  // and a bound would keep an instrumentation-chosen string for no reader.
  const minimized = `${JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "quote" } }] },
        scopeSpans: [{ spans: [{ attributes: [], events: [{ timeUnixNano: "1" }] }] }],
      },
    ],
  })}\n`;
  assert.equal(parseTrustedTelemetryRecords(minimized, RUN_ID).ok, true);

  // An event name is now refused outright, at any length, because the pipeline
  // is configured to remove it.
  const named = minimized.replace('"timeUnixNano":"1"', '"timeUnixNano":"1","name":"exception"');
  const namedResult = parseTrustedTelemetryRecords(named, RUN_ID);
  assert.equal(namedResult.ok, false);
  assert.equal(
    (namedResult as { reasonCode: string }).reasonCode,
    "telemetry_trusted_record_unminimized_field",
  );
});

test("TRUSTED-CHANNEL: a resource whose attributes were all minimized away stays readable", () => {
  // Measured against the pinned collector: `keep_keys` removing every resource
  // attribute makes the marshaller emit `"resource":{}` with no `attributes`
  // key. Refusing it would refuse a record the trusted channel legitimately
  // produces, and a false refusal is its own defect.
  const bytes = `${JSON.stringify({
    resourceSpans: [{ resource: {}, scopeSpans: [{ spans: [{ attributes: [] }] }] }],
  })}\n`;
  const parsed = parseTrustedTelemetryRecords(bytes, RUN_ID);
  assert.equal(parsed.ok, true);
  assert.deepEqual((parsed as { counts: { serviceNames: readonly string[] } }).counts.serviceNames, []);
  assert.equal((parsed as { counts: { spans: number } }).counts.spans, 1);
  assert.equal((parsed as { counts: { runAttributedRecords: number } }).counts.runAttributedRecords, 0);
});


test("TRUSTED-CHANNEL: an empty file that is merely stable is not yet a settled observation", () => {
  // The failure this prevents was measured on a live run: two seconds after the
  // last request the trusted file is still empty, two identical empty reads look
  // perfectly stable, and freezing there would retain an authentic observed zero
  // for a run that emitted spans. A zero is a positive claim, so the wait ends on
  // "this run's telemetry has arrived", not on "the file stopped moving".
  const arriving = [
    { [TRUSTED_CHANNEL_FILE_NAME]: "" },
    { [TRUSTED_CHANNEL_FILE_NAME]: "" },
    { [TRUSTED_CHANNEL_FILE_NAME]: record(RUN_ID, 2) },
    { [TRUSTED_CHANNEL_FILE_NAME]: record(RUN_ID, 2) },
    { [TRUSTED_CHANNEL_FILE_NAME]: record(RUN_ID, 2) },
  ];
  const { channel } = channelFor({ sequence: arriving });
  const material = observeTrustedTelemetry({
    channel,
    collector: COLLECTOR,
    binding: BINDING,
    marker: RUN_ID,
  });
  assert.equal(material.evidence, "observed");
  assert.equal(
    (material as { spans: number }).spans,
    2,
    "the freeze settled on a stable empty file and reported a zero the run did not have",
  );
  assert.equal((material as { runAttributedRecords: number }).runAttributedRecords, 2);
});

test("TRUSTED-CHANNEL: bytes that are not UTF-8 are refused rather than silently replaced", () => {
  // The channel declares `encoding: "utf-8"` as a schema constant. A lone
  // continuation byte does not survive a round trip, and decoding it anyway
  // would substitute U+FFFD for whatever the collector actually wrote — an
  // artifact whose digest covers bytes nobody produced.
  const invalid = Buffer.concat([Buffer.from('{"resourceSpans":[]}', "utf8"), Buffer.from([0xff, 0xfe]), Buffer.from("\n", "utf8")]);
  const { channel } = channelFor({ files: { [TRUSTED_CHANNEL_FILE_NAME]: invalid } });
  const frozen = channel.close(COLLECTOR);
  assert.equal(frozen.frozen, false);
  assert.equal((frozen as { reasonCode: string }).reasonCode, TRUSTED_CHANNEL_REASONS.encodingInvalid);
});

test("TRUSTED-CHANNEL: the volume name is run-scoped, so ownership is provable from the name", () => {
  assert.ok(trustedVolumeName(RUN_ID).includes(RUN_ID));
  assert.notEqual(trustedVolumeName(RUN_ID), trustedVolumeName(OTHER_RUN));
});

// -- cleanup ------------------------------------------------------------------

test("TRUSTED-CHANNEL: cleanup removes the volume it created and reports the outcome", () => {
  const { channel, docker } = channelFor();
  channel.provision();
  const cleanup = channel.cleanup();
  assert.deepEqual(cleanup, { attempted: true, removed: true, surviving: [] });
  const removal = docker.commands.filter((args) => args[0] === "volume" && args[1] === "rm");
  assert.equal(removal.length, 1);
  // Exactly this run's name, never a pattern and never a prune.
  assert.deepEqual(removal[0], ["volume", "rm", trustedVolumeName(RUN_ID)]);
});

test("TRUSTED-CHANNEL: a cleanup that failed says so, and says what survived", () => {
  const { channel } = channelFor({ removeFails: true });
  channel.provision();
  const cleanup = channel.cleanup();
  assert.equal(cleanup.attempted, true);
  assert.equal(cleanup.removed, false, "a volume that is still there must not be reported as removed");
  assert.deepEqual(cleanup.surviving, [trustedVolumeName(RUN_ID)]);
  assert.ok((cleanup.detail ?? "").includes("in use"), "the daemon's own reason is dropped");
});

test("TRUSTED-CHANNEL: cleanup does not confer evidence validity, and validity does not confer cleanup", () => {
  // A clean cleanup beside an artifact that never froze.
  const failed = channelFor({ files: undefined });
  failed.channel.provision();
  const absent = buildTrustedTelemetryObservation({
    runId: RUN_ID,
    observedAt: "2026-08-14T00:00:00Z",
    material: observeTrustedTelemetry({
      channel: failed.channel,
      collector: COLLECTOR,
      binding: BINDING,
      marker: RUN_ID,
    }),
  });
  assert.equal(failed.channel.cleanup().removed, true);
  assert.equal(absent.evidence, "absent");
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [absent] }),
    false,
    "a clean cleanup made an unfrozen artifact acceptable",
  );

  // And a valid artifact beside a cleanup that failed.
  const stuck = channelFor({ files: { [TRUSTED_CHANNEL_FILE_NAME]: record(RUN_ID, 2) }, removeFails: true });
  stuck.channel.provision();
  const valid = buildTrustedTelemetryObservation({
    runId: RUN_ID,
    observedAt: "2026-08-14T00:00:00Z",
    material: observeTrustedTelemetry({
      channel: stuck.channel,
      collector: COLLECTOR,
      binding: BINDING,
      marker: RUN_ID,
    }),
  });
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: RUN_ID, observations: [valid] }),
    true,
  );
  assert.equal(stuck.channel.cleanup().removed, false, "a valid artifact made a failed cleanup look clean");
});

test("TRUSTED-CHANNEL: the freeze copies are working material and do not outlive cleanup", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "erl2-trusted-freeze-"));
  roots.push(root);
  const docker = stubDocker({ files: { [TRUSTED_CHANNEL_FILE_NAME]: record(RUN_ID, 2) } });
  const channel = new TrustedTelemetryChannel({
    runId: RUN_ID,
    docker,
    freezeRoot: root,
    sleep: () => undefined,
    stabilityAttempts: 4,
  });
  channel.provision();
  assert.equal(channel.close(COLLECTOR).frozen, true);
  // The freeze reads `docker cp` as an archive on stdout and never extracts it,
  // so the corrected copy path materialises nothing at all — which is stronger
  // than "the copies are cleaned up", and is what removes the symlink primitive.
  assert.equal(readdirSync(root).length, 0, "the freeze wrote to the filesystem");
  channel.cleanup();
  // The evidence is the bytes retained inside the record, never a path on disk.
  assert.equal(
    readdirSync(path.dirname(root)).includes(path.basename(root)),
    false,
    "the freeze root outlived the channel",
  );
});

// -- the collector configuration is part of the trust argument ----------------

/**
 * The applied collector extras, read from the repository.
 *
 * Parsed shallowly and deliberately: this asserts the properties the trust
 * argument rests on, not the whole file. A YAML parser would be a dependency
 * added to check four things that are visible as text, and the four things are
 * exactly the ones a well-meaning edit gets wrong.
 */
function collectorExtras(): string {
  return readFileSync(
    path.join(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
      "environments",
      "otel-demo",
      "compose",
      "erl2-otelcol-extras.yaml",
    ),
    "utf8",
  );
}

/** The `service.pipelines.<name>` block's body, or `undefined`. */
function pipelineBlock(extras: string, name: string): string | undefined {
  const match = new RegExp(`\\n    ${name.replace("/", "\\/")}:\\n((?:      .*\\n)+)`).exec(extras);
  return match?.[1];
}

test("TRUSTED-CONFIG: the trusted pipeline minimizes before it exports, and the allowlist is the parser's", () => {
  const extras = collectorExtras();
  const trusted = pipelineBlock(extras, "traces/trusted");
  assert.ok(trusted !== undefined, "the trusted traces pipeline is absent from the collector extras");

  // R2. Without the transform the channel is not merely leakier — it is
  // unusable: one realistic unminimized record measured 1 000 590 bytes against
  // a 262 144 ceiling, so every realistic run would retain nothing.
  assert.ok(
    /processors:\s*\[[^\]]*transform\/trusted[^\]]*\]/.test(trusted),
    `the trusted pipeline exports without minimizing: ${trusted}`,
  );
  assert.ok(
    /exporters:\s*\[[^\]]*file\/trusted[^\]]*\]/.test(trusted),
    `the trusted pipeline does not feed the trusted exporter: ${trusted}`,
  );

  // The allowlist the processor applies must be the allowlist the parser
  // enforces. Two allowlists that drift apart give a channel that retains what
  // no reader will accept, or accepts what the channel never bounded.
  for (const key of TRUSTED_RESOURCE_KEYS) {
    assert.ok(
      extras.includes(`keep_keys(resource.attributes, ["${key}"])`),
      `the processor does not keep the resource key the parser allows: ${key}`,
    );
  }
  for (const key of TRUSTED_SPAN_KEYS) {
    assert.ok(
      extras.includes(`keep_keys(span.attributes, ["${key}"])`),
      `the processor does not keep the span key the parser allows: ${key}`,
    );
  }
  // Events carry a second attribute map that `keep_keys` on span attributes does
  // not reach. A live run retained an exception stack trace through exactly this
  // gap before the statement below existed.
  assert.ok(
    extras.includes("keep_keys(spanevent.attributes, [])"),
    "span event attributes are not stripped; a stack trace can reach the artifact",
  );
  assert.ok(
    extras.includes(`truncate_all(span.attributes, ${TRUSTED_TELEMETRY_MAX_FIELD_CHARS})`),
    "retained span values are not bounded at the length the parser enforces",
  );

  // The Package 2 remediation surfaces. Each of these was measured surviving
  // verbatim into a verified artifact by the independent review, in a field the
  // first candidate's allowlist simply did not name.
  for (const statement of [
    "keep_keys(scope.attributes, [])",
    'set(scope.name, "")',
    'set(scope.version, "")',
    'set(scope.schema_url, "")',
    'set(resource.schema_url, "")',
    'set(span.name, "")',
    'set(span.status.message, "")',
    'set(span.trace_state, "")',
    'set(spanevent.name, "")',
  ]) {
    assert.ok(
      extras.includes(statement),
      `the trusted pipeline no longer removes a subject-controlled surface: ${statement}`,
    );
  }

  // `error_mode: ignore` is how `set(span.events, [])` became a silent no-op —
  // the statement that looked like it removed the most removed nothing. Every
  // statement above is load-bearing for a privacy bound, so one that cannot be
  // applied must stop the batch rather than quietly export more.
  assert.ok(
    /transform\/trusted:\s*\n\s*error_mode: propagate/.test(extras),
    "the trusted transform swallows statement failures; a no-op minimization would pass unnoticed",
  );
});

test("TRUSTED-CONFIG: the trusted exporter shares its channel with nothing that renders subject bytes", () => {
  const extras = collectorExtras();
  const trusted = pipelineBlock(extras, "traces/trusted");
  assert.ok(trusted !== undefined);

  // R3, and the whole reason the channel is trustworthy. `debug` renders subject
  // bytes unescaped at column zero; on a shared stream a subject log body forged
  // a complete trusted record reading 9999 spans. Structural framing does not
  // survive that, so the two must not meet.
  assert.equal(
    /exporters:\s*\[[^\]]*\bdebug\b[^\]]*\]/.test(trusted),
    false,
    `debug is on the trusted pipeline: ${trusted}`,
  );

  // And nothing but traces reaches the trusted exporter. Nothing ERL2-C-171
  // derives comes from a log or a metric, and a subject *log body* is the exact
  // vector the mixed stream was forged through.
  for (const signal of ["logs", "metrics", "profiles"]) {
    const block = pipelineBlock(extras, signal);
    assert.ok(block !== undefined, `the ${signal} pipeline is absent`);
    assert.equal(
      block.includes("file/trusted"),
      false,
      `the ${signal} pipeline feeds the trusted exporter: ${block}`,
    );
  }

  // No rotation (R6): the exporter is configured with no rotation block, so it
  // writes exactly one file and `segment_count: 1` describes reality.
  assert.equal(/file\/trusted:[\s\S]{0,300}?rotation:/.test(extras), false, "the trusted exporter rotates");
});
