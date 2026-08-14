/**
 * ERL2-C-171 and the trusted-telemetry authority boundary (ADR-ERL2-038 R2–R8).
 *
 * Three surfaces, and they are deliberately not the same three as v1's:
 *
 * 1. the **record grammar** — `parseTrustedTelemetryRecords` — which reads
 *    counts out of structures rather than out of rendered numerals, and refuses
 *    an artifact the trusted pipeline did not minimize;
 * 2. the **authority decision** — `decideTrustedTelemetryAuthority` — the one
 *    place the question "may this record authorize a new claim?" is answered,
 *    for the producer's gate and the offline verifier alike;
 * 3. the **eligibility** those two produce together, observed at
 *    `attributableTelemetryGatePassed` rather than at a helper's return value,
 *    because a policy nothing enforces is a comment.
 *
 * ## What these tests cannot claim
 *
 * No collector has written one of these artifacts. The exporter, the minimizing
 * processor and the volume are package 2; the driver and the live freeze are
 * package 3. Every byte below was built by a fixture. What is under test is the
 * contract and the authority boundary — not that the channel works, and not
 * that it exists.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODES, validateContract, type AttributableTelemetryObservationV2 } from "@erl2/contracts";
import { coreHash, hashBytes } from "@erl2/integrity";
import {
  attributableTelemetryGatePassed,
  decideTrustedTelemetryAuthority,
  parseTrustedTelemetryRecords,
  readHistoricalTelemetryObservation,
  TELEMETRY_AUTHORITY_REASONS,
  TRUSTED_TELEMETRY_MAX_BYTES,
  TRUSTED_TELEMETRY_MAX_FIELD_CHARS,
  TRUSTED_TELEMETRY_REASONS,
} from "@erl2/core";
import {
  absentV2,
  FIXTURE_OTHER_RUN_ID,
  FIXTURE_RUN_ID,
  historicalV1,
  observedV2,
  trustedRecord,
  trustedRecords,
  validAtSizeBoundary,
  validMultiRecord,
  validPositive,
  validZero,
} from "../support/trustedTelemetryFixtures.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "trusted-telemetry",
);

/** A mutable copy, for the invalid cases that are "valid except for X". */
function mutate(
  base: AttributableTelemetryObservationV2,
  edit: (draft: Record<string, unknown>) => void,
): unknown {
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  edit(draft);
  return draft;
}

/** The same, re-sealed, for cases whose point is not a stale `core_hash`. */
function resealed(
  base: AttributableTelemetryObservationV2,
  edit: (draft: Record<string, unknown>) => void,
): unknown {
  const draft = mutate(base, edit) as Record<string, unknown>;
  delete draft["core_hash"];
  return { ...draft, core_hash: coreHash(draft) };
}

// -- 1. the valid fixtures ---------------------------------------------------

test("TRUSTED-FIXTURE: the checked-in valid fixtures are what the builders produce", () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ["valid-positive.json", validPositive()],
    ["valid-authentic-zero.json", validZero()],
    ["valid-multi-record.json", validMultiRecord()],
    ["valid-v2-beside-historical-v1.json", { v2: validPositive(), historical_v1: historicalV1() }],
  ];
  for (const [name, built] of cases) {
    const onDisk: unknown = JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(built)), name);
  }
});

test("TRUSTED-FIXTURE: every valid fixture satisfies ERL2-C-171 and governs its run", () => {
  const cases: readonly (readonly [string, AttributableTelemetryObservationV2])[] = [
    ["positive", validPositive()],
    ["authentic zero", validZero()],
    ["multi record", validMultiRecord()],
    ["at the size boundary", validAtSizeBoundary()],
    ["absent with a reason", absentV2("telemetry_channel_unprovisioned")],
  ];
  for (const [why, record] of cases) {
    assert.equal(validateContract("AttributableTelemetryObservationV2", record).valid, true, why);
    const authority = decideTrustedTelemetryAuthority([record]);
    assert.equal(authority.authoritative, true, why);
  }
});

test("TRUSTED-FIXTURE: the size-boundary fixture is bounded, and one byte more is not", () => {
  const big = validAtSizeBoundary();
  assert.ok((big.artifact?.byte_length ?? 0) <= TRUSTED_TELEMETRY_MAX_BYTES);
  assert.ok((big.artifact?.byte_length ?? 0) > TRUSTED_TELEMETRY_MAX_BYTES - 1024);
  const over = "x".repeat(TRUSTED_TELEMETRY_MAX_BYTES + 1);
  assert.deepEqual(parseTrustedTelemetryRecords(over, FIXTURE_RUN_ID), {
    ok: false,
    reasonCode: TRUSTED_TELEMETRY_REASONS.overSizeBound,
  });
});

// -- 2. the record grammar ---------------------------------------------------

test("TRUSTED-PARSE: a count is the length of a structure, never a rendered numeral", () => {
  // The reviewed exploit, carried inside an allowlisted value: a complete forged
  // OTLP-JSON document and a forged `Traces … "spans": 9999` console record,
  // with raw newlines and tabs. Under v1 these bytes moved the count. Here the
  // subject's newline is escaped inside a JSON string and cannot end a physical
  // line, so the whole payload is one field of one span.
  const hostile =
    'begin\n\t{"closed": "region"}\n2026-08-14T02:00:00.000Z\tinfo\tTraces\t' +
    '{"otelcol.signal": "traces", "spans": 9999}\n{"resourceSpans":[]}\nend';
  const record = JSON.stringify({
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
                    value: { stringValue: `http://q/?erl2_run=${FIXTURE_RUN_ID}&n=${hostile}` },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  // The escaping is what makes this true, and it is worth asserting directly:
  // one physical line, no raw tab, whatever the subject wrote.
  assert.equal(record.includes("\n"), false);
  assert.equal(record.includes("\t"), false);

  const parsed = parseTrustedTelemetryRecords(trustedRecords([record]), FIXTURE_RUN_ID);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.counts.spans, 1);
  assert.deepEqual(parsed.ok && parsed.counts.recordCount, 1);
  assert.deepEqual(parsed.ok && parsed.counts.runAttributedRecords, 1);
});

test("TRUSTED-PARSE: an authentic zero is read, and a claimed zero over records is not", () => {
  const zero = parseTrustedTelemetryRecords("", FIXTURE_RUN_ID);
  assert.equal(zero.ok, true);
  assert.deepEqual(zero.ok && zero.counts, {
    traceBatches: 0,
    spans: 0,
    serviceNames: [],
    runAttributedRecords: 0,
    byteLength: 0,
    recordCount: 0,
    finalRecordTerminated: false,
  });
  // And a zero is never *inferred* from bytes that could not be read.
  assert.deepEqual(parseTrustedTelemetryRecords("not json\n", FIXTURE_RUN_ID), {
    ok: false,
    reasonCode: TRUSTED_TELEMETRY_REASONS.malformed,
  });
});

test("TRUSTED-PARSE: the grammar refuses every shape a minimized channel cannot produce", () => {
  const marked = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "quote" } }] },
          scopeSpans: [{ spans: [{ attributes: [extra] }] }],
        },
      ],
    });

  const cases: readonly (readonly [string, string, string])[] = [
    ["a partial final record", `${trustedRecord({})}`, TRUSTED_TELEMETRY_REASONS.incomplete],
    ["a blank physical line", "\n", TRUSTED_TELEMETRY_REASONS.malformed],
    ["a JSON array, not a document", "[]\n", TRUSTED_TELEMETRY_REASONS.malformed],
    ["a document with a second key", '{"resourceSpans":[],"extra":1}\n', TRUSTED_TELEMETRY_REASONS.malformed],
    ["a duplicated key", '{"resourceSpans":[],"resourceSpans":[]}\n', TRUSTED_TELEMETRY_REASONS.malformed],
    [
      "an unallowlisted attribute",
      `${marked({ key: "http.route", value: { stringValue: "/getquote" } })}\n`,
      TRUSTED_TELEMETRY_REASONS.unexpectedField,
    ],
    [
      "a sensitive attribute",
      `${marked({ key: "http.request.header.cookie", value: { stringValue: "s" } })}\n`,
      TRUSTED_TELEMETRY_REASONS.forbiddenField,
    ],
    [
      "an untruncated value",
      `${marked({
        key: "url.full",
        value: { stringValue: "x".repeat(TRUSTED_TELEMETRY_MAX_FIELD_CHARS + 1) },
      })}\n`,
      TRUSTED_TELEMETRY_REASONS.fieldOverBound,
    ],
    [
      "another run's marker",
      `${marked({
        key: "url.full",
        value: { stringValue: `http://q/?erl2_run=${FIXTURE_OTHER_RUN_ID}` },
      })}\n`,
      TRUSTED_TELEMETRY_REASONS.foreignRun,
    ],
  ];
  for (const [why, bytes, reasonCode] of cases) {
    assert.deepEqual(parseTrustedTelemetryRecords(bytes, FIXTURE_RUN_ID), { ok: false, reasonCode }, why);
  }
});

test("TRUSTED-PARSE: mixed run markers are refused rather than partially counted", () => {
  const bytes = trustedRecords([
    trustedRecord({ markers: [FIXTURE_RUN_ID] }),
    trustedRecord({ markers: [FIXTURE_OTHER_RUN_ID] }),
  ]);
  // The point is that this is not "one attributed record out of two". An
  // artifact that carries another run's records is not this run's artifact,
  // and counting the half that matches would launder the half that does not.
  assert.deepEqual(parseTrustedTelemetryRecords(bytes, FIXTURE_RUN_ID), {
    ok: false,
    reasonCode: TRUSTED_TELEMETRY_REASONS.foreignRun,
  });
});

// -- 3. the invalid inventory ------------------------------------------------

/**
 * The twenty-eight refusals ERL2-C-171 and its authority owe.
 *
 * Each row is the valid positive fixture with exactly one thing wrong, so the
 * row *is* the delta. Rows are named for the property, not the field, because
 * the property is what a later package must not regress.
 */
test("TRUSTED-INVALID: every invalid shape is refused, and none falls back to v1", () => {
  const good = validPositive();
  const goodV1 = historicalV1();
  const R = TELEMETRY_AUTHORITY_REASONS;
  const P = TRUSTED_TELEMETRY_REASONS;

  const rows: readonly (readonly [string, readonly unknown[], string])[] = [
    ["1 unknown version", [resealed(good, (d) => { d["schema_version"] = "attributable-telemetry-observation/v3"; })], R.unknownVersion],
    ["2 mixed v1/v2 fields", [mutate(good, (d) => { d["log_excerpt"] = "x"; })], R.mixedVersionFields],
    ["3 missing run binding", [resealed(good, (d) => { delete d["binding"]; })], R.v2Invalid],
    ["4 wrong run id", [resealed(good, (d) => { d["run_id"] = FIXTURE_OTHER_RUN_ID; })], R.markerNotRunId],
    ["5 mixed run markers", [coherentOver(trustedRecords([trustedRecord({ markers: [FIXTURE_RUN_ID] }), trustedRecord({ markers: [FIXTURE_OTHER_RUN_ID] })]))], P.foreignRun],
    ["6 missing channel identity", [resealed(good, (d) => { delete d["channel"]; })], R.v2Invalid],
    ["7 debug/mixed-stream origin", [resealed(good, (d) => { (d["channel"] as Record<string, unknown>)["kind"] = "collector-debug-console"; })], R.v2Invalid],
    ["8 missing digest", [resealed(good, (d) => { delete (d["artifact"] as Record<string, unknown>)["content_digest"]; })], R.v2Invalid],
    ["9 digest mismatch", [resealed(good, (d) => { (d["artifact"] as Record<string, unknown>)["content_digest"] = hashBytes(Buffer.from("other", "utf8")); })], R.incoherent],
    ["10 byte-length mismatch", [resealed(good, (d) => { (d["artifact"] as Record<string, unknown>)["byte_length"] = 7; })], R.incoherent],
    ["11 missing record count", [resealed(good, (d) => { delete (d["artifact"] as Record<string, unknown>)["record_count"]; })], R.v2Invalid],
    ["12 record-count mismatch", [resealed(good, (d) => { (d["artifact"] as Record<string, unknown>)["record_count"] = 9; })], R.incoherent],
    ["13 writing, not finalized", [resealed(good, (d) => { (d["artifact"] as Record<string, unknown>)["finalization"] = "writing"; })], R.v2Invalid],
    ["14 truncated artifact", [truncatedArtifact()], P.incomplete],
    ["15 rotation forbidden, two segments", [resealed(good, (d) => { (d["channel"] as Record<string, unknown>)["segment_count"] = 2; })], R.v2Invalid],
    ["16 oversized artifact", [resealed(good, (d) => { d["trusted_records"] = "x".repeat(TRUSTED_TELEMETRY_MAX_BYTES + 1); })], R.v2Invalid],
    ["17 oversized field", [coherentOverRaw(overlongFieldBytes())], P.fieldOverBound],
    ["18 forbidden sensitive field", [coherentOverRaw(sensitiveFieldBytes())], P.forbiddenField],
    ["19 missing attribution", [resealed(good, (d) => { d["trusted_records"] = trustedRecords([trustedRecord({ markers: [undefined] })]); reseal(d); })], R.incoherent],
    ["20 cross-run substitution", [foreignRunArtifact()], P.foreignRun],
    ["21 producer count differs from recomputed", [resealed(good, (d) => { d["spans"] = 99; })], R.incoherent],
    ["22 zero claimed over records", [resealed(good, (d) => { (d["artifact"] as Record<string, unknown>)["record_count"] = 0; })], R.incoherent],
    ["23 absent record carrying spans", [resealed(absentV2("telemetry_channel_unprovisioned"), (d) => { d["spans"] = 3; })], R.v2Invalid],
    ["24 v1 alone cannot authorize", [goodV1], R.v1NotAuthoritative],
    ["25 invalid v2 does not downgrade to a valid v1", [resealed(good, (d) => { delete d["channel"]; }), goodV1], R.v2Invalid],
    ["26 unknown record format", [resealed(good, (d) => { (d["channel"] as Record<string, unknown>)["record_format"] = "otlp-json-array"; })], R.v2Invalid],
    ["27 changed after freeze", [mutate(good, (d) => { d["observed_at"] = "2026-08-13T00:00:06Z"; })], R.freezeBroken],
    ["28 service names disagree with the bytes", [resealed(good, (d) => { d["service_names"] = ["not-quote"]; })], R.incoherent],
  ];

  assert.equal(rows.length, 28, "the inventory is twenty-eight cases");
  for (const [why, retained, reason] of rows) {
    const authority = decideTrustedTelemetryAuthority(retained);
    assert.equal(authority.authoritative, false, why);
    assert.equal(authority.authoritative === false && authority.refusal, reason, why);
    // Behavioural, not helper-shaped: the run is ineligible, not merely
    // reported as such.
    assert.equal(
      attributableTelemetryGatePassed({ declared: true, runId: FIXTURE_RUN_ID, observations: retained }),
      false,
      why,
    );
  }
});

function reseal(draft: Record<string, unknown>): void {
  const bytes = draft["trusted_records"] as string;
  const artifact = draft["artifact"] as Record<string, unknown>;
  artifact["byte_length"] = Buffer.byteLength(bytes, "utf8");
  artifact["content_digest"] = hashBytes(Buffer.from(bytes, "utf8"));
  const count = bytes.length === 0 ? 0 : bytes.slice(0, -1).split("\n").length;
  artifact["record_count"] = count;
  artifact["final_record_terminated"] = count > 0;
  draft["trace_batches"] = count;
}

/** A coherent record over arbitrary bytes, so the *bytes* are what refuses. */
function coherentOver(bytes: string): unknown {
  return observedV2({ bytes, spans: 2, serviceNames: ["quote"], runAttributedRecords: 1 });
}
function coherentOverRaw(bytes: string): unknown {
  return observedV2({ bytes, spans: 1, serviceNames: ["quote"], runAttributedRecords: 1 });
}

function truncatedArtifact(): unknown {
  const bytes = trustedRecord({});
  return observedV2({ bytes, spans: 1, serviceNames: ["quote"], runAttributedRecords: 1 });
}

function foreignRunArtifact(): unknown {
  const bytes = trustedRecords([trustedRecord({ markers: [FIXTURE_OTHER_RUN_ID] })]);
  return observedV2({ bytes, spans: 1, serviceNames: ["quote"], runAttributedRecords: 0 });
}

function overlongFieldBytes(): string {
  return trustedRecords([
    JSON.stringify({
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
                      value: { stringValue: "y".repeat(TRUSTED_TELEMETRY_MAX_FIELD_CHARS + 1) },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  ]);
}

function sensitiveFieldBytes(): string {
  return trustedRecords([
    JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "quote" } }] },
          scopeSpans: [
            {
              spans: [
                {
                  attributes: [
                    { key: "http.request.header.authorization", value: { stringValue: "Bearer x" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  ]);
}

// -- 4. the authority truth table --------------------------------------------

test("TRUSTED-AUTHORITY: the migration truth table, observed at the gate", () => {
  const v2 = validPositive();
  const v1 = historicalV1();
  const brokenV2 = resealed(v2, (d) => {
    delete d["channel"];
  });

  const rows: readonly (readonly [string, readonly unknown[], boolean])[] = [
    ["valid v2", [v2], true],
    ["missing v2, valid v1", [v1], false],
    ["invalid v2, valid v1", [brokenV2, v1], false],
    ["valid v2 plus v1", [v2, v1], true],
    ["unknown version", [resealed(v2, (d) => { d["schema_version"] = "x/v9"; })], false],
    ["mixed-version fields", [mutate(v2, (d) => { d["log_excerpt"] = "x"; })], false],
    ["nothing retained", [], false],
    ["two v2 records", [v2, v2], false],
  ];
  for (const [why, retained, eligible] of rows) {
    assert.equal(
      attributableTelemetryGatePassed({ declared: true, runId: FIXTURE_RUN_ID, observations: retained }),
      eligible,
      why,
    );
  }

  // A v1 beside a valid v2 cannot *broaden* what the v2 says: the authoritative
  // record is the v2, and the report is identical with and without the v1.
  const withV1 = decideTrustedTelemetryAuthority([v2, v1]);
  const alone = decideTrustedTelemetryAuthority([v2]);
  assert.deepEqual(withV1, alone);
});

test("TRUSTED-AUTHORITY: an undeclared run is untouched by the migration", () => {
  // The gate is vacuous where the observation was never declared obtainable,
  // exactly as it was before R8. A fake-driver run does not become invalid
  // because a channel it never used has a new contract.
  for (const observations of [[], [historicalV1()], [validPositive()]]) {
    assert.equal(
      attributableTelemetryGatePassed({ declared: false, runId: FIXTURE_RUN_ID, observations }),
      true,
    );
  }
});

test("TRUSTED-AUTHORITY: an authentic zero governs, and authorizes no positive claim", () => {
  const zero = validZero();
  const authority = decideTrustedTelemetryAuthority([zero]);
  assert.equal(authority.authoritative, true, "a genuine zero is a real observation");
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: FIXTURE_RUN_ID, observations: [zero] }),
    false,
    "and it satisfies a run that declared telemetry obtainable no better than silence",
  );
});

test("TRUSTED-AUTHORITY: an absent v2 governs its own refusal rather than being ignored", () => {
  const absent = absentV2("telemetry_channel_finalization_failed");
  const authority = decideTrustedTelemetryAuthority([absent]);
  assert.equal(authority.authoritative, true);
  assert.equal(authority.authoritative && authority.observation.reason_code, "telemetry_channel_finalization_failed");
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: FIXTURE_RUN_ID, observations: [absent] }),
    false,
  );
});

// -- 5. historical compatibility ---------------------------------------------

test("TRUSTED-HISTORY: v1 stays readable, and reading is not authorizing", () => {
  const v1 = historicalV1();
  const read = readHistoricalTelemetryObservation(v1);
  assert.notEqual(read, undefined, "a historical record must still parse");
  assert.equal(read?.schema_version, "attributable-telemetry-observation/v1");
  assert.equal(read?.spans, 3);
  assert.equal(validateContract("AttributableTelemetryObservationV1", v1).valid, true);

  // The same record, offered as authority, is refused.
  assert.equal(
    attributableTelemetryGatePassed({ declared: true, runId: FIXTURE_RUN_ID, observations: [v1] }),
    false,
  );
  // And a v1 wearing v2 fields is not readable as history either.
  assert.equal(
    readHistoricalTelemetryObservation({ ...v1, trusted_records: "x" }),
    undefined,
  );
});

test("TRUSTED-HISTORY: no v1 record is auto-upgraded and no v2 field is synthesized", () => {
  const v1 = historicalV1();
  const authority = decideTrustedTelemetryAuthority([v1]);
  assert.equal(authority.authoritative, false);
  // The refusal names the migration rule rather than a missing field, because
  // "add the field" is precisely the repair nobody may make.
  assert.equal(
    authority.authoritative === false && authority.refusal,
    TELEMETRY_AUTHORITY_REASONS.v1NotAuthoritative,
  );
  assert.equal(Object.prototype.hasOwnProperty.call(v1, "trusted_records"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(v1, "channel"), false);
});

// -- 6. the contract's own closure -------------------------------------------

test("TRUSTED-CONTRACT: an absent v2 cannot carry bytes, counts, a channel or a binding", () => {
  const absent = absentV2("telemetry_channel_unprovisioned");
  for (const key of ["channel", "binding", "collector", "artifact", "trusted_records", "spans"]) {
    const smuggled = resealed(absent, (d) => {
      d[key] = key === "spans" ? 1 : {};
    });
    assert.equal(
      validateContract("AttributableTelemetryObservationV2", smuggled).valid,
      false,
      key,
    );
  }
});

test("TRUSTED-CONTRACT: an observed v2 cannot omit its bytes, its channel or its binding", () => {
  const good = validPositive();
  for (const key of ["channel", "binding", "collector", "artifact", "trusted_records", "spans", "run_attributed_records"]) {
    const missing = resealed(good, (d) => {
      delete d[key];
    });
    assert.equal(validateContract("AttributableTelemetryObservationV2", missing).valid, false, key);
  }
  // And it may not carry a reason code, which is how "observed but excused"
  // stays unrepresentable.
  const excused = resealed(good, (d) => {
    d["reason_code"] = "telemetry_channel_unprovisioned";
  });
  assert.equal(validateContract("AttributableTelemetryObservationV2", excused).valid, false);
});

test("TRUSTED-CONTRACT: the error code a refused declared run reaches is routable", () => {
  // Not a new code: the migration reuses the terminal-classifiable code the
  // telemetry obligation already owned, so a refused run reaches an invalid
  // terminal by the route that already existed rather than a new one nobody
  // catalogued.
  assert.equal(typeof CODES.ENV_TELEMETRY_NOT_ATTRIBUTED, "string");
});
