/**
 * The producer-side evidence boundaries, at the level where a boundary is a
 * function (Step 6B, review §2 P2 producer cluster).
 *
 * Four findings said the same thing in four places: a scan or a bound was
 * *present*, and what it inspected was not what crossed the boundary. So these
 * cases are all of one shape — hand the production function the bytes that
 * actually cross, and require the verdict to come from the intended rule.
 *
 * The end-to-end half lives in `tests/e2e/environmentEvidenceBoundaries.test.ts`
 * and proves the shipped path calls these. Neither half is sufficient alone: a
 * unit test proves a helper, and a green run proves nothing was reached.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertSubjectOutputContentClean,
  assertSubjectOutputWithinDeclaredBytes,
  assertTelemetryOracleClean,
  assertNoCanaryLeak,
  redactOracleLabel,
  subjectOutputPayloadByteTotal,
  type RetainedSubjectOutputPayload,
} from "@erl2/core";
import { ArtifactStore, jcsBytes } from "@erl2/integrity";
import type { SourceSnapshotV1 } from "@erl2/contracts";

const JUDGE_CANARY = `erl2-canary-${"0123456789abcdef".repeat(2)}`;
const SECRET_CANARY = `erl2-secret-${"fedcba9876543210".repeat(2)}`;

function scratch(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `erl2-${prefix}-`));
}

function payload(pathName: string, bytes: Buffer | string): RetainedSubjectOutputPayload {
  return { path: pathName, bytes: typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes };
}

function code(fn: () => void): string {
  try {
    fn();
  } catch (cause) {
    return (cause as { code?: string }).code ?? "-";
  }
  return "-";
}

function message(fn: () => void): string {
  try {
    fn();
  } catch (cause) {
    return (cause as { message?: string }).message ?? "";
  }
  return "";
}

// -- byte accounting ---------------------------------------------------------

test("EB-BYTES: the unit is the byte, not the JavaScript character", () => {
  // The whole point of the ceiling is retention cost, which is measured in bytes.
  // "€" is one character and three bytes; a length-based count would admit a
  // payload three times the size it was allowed.
  const multibyte = "€".repeat(1000);
  assert.equal(multibyte.length, 1000, "the fixture really is shorter in characters");
  const total = subjectOutputPayloadByteTotal([payload("a", multibyte)]);
  assert.equal(total, 3000, "byte length and character length must not be confused");
});

test("EB-BYTES: two references to one path count twice", () => {
  // Deduplicating by path would let a duplicated reference report a total below
  // the bytes the run actually exposes.
  const bytes = Buffer.alloc(10);
  assert.equal(subjectOutputPayloadByteTotal([payload("p", bytes), payload("p", bytes)]), 20);
});

test("EB-BYTES: an empty payload set totals zero rather than failing", () => {
  assert.equal(subjectOutputPayloadByteTotal([]), 0);
});

test("EB-SIZE: exactly at the declared ceiling is admitted", () => {
  const bytes = Buffer.alloc(4096);
  assert.doesNotThrow(() => {
    assertSubjectOutputWithinDeclaredBytes([payload("p", bytes)], 4096);
  });
});

test("EB-SIZE: one byte over the declared ceiling is refused", () => {
  const bytes = Buffer.alloc(4097);
  assert.equal(
    code(() => {
      assertSubjectOutputWithinDeclaredBytes([payload("p", bytes)], 4096);
    }),
    "SUBJECT_OUTPUT_LIMIT_EXCEEDED",
  );
});

test("EB-SIZE: the ceiling is a total, not a per-file bound", () => {
  // Two payloads that each fit and together do not. A per-file check would admit
  // this, which is how a bounded surface becomes unbounded by splitting.
  const half = Buffer.alloc(2049);
  assert.equal(
    code(() => {
      assertSubjectOutputWithinDeclaredBytes([payload("a", half), payload("b", half)], 4096);
    }),
    "SUBJECT_OUTPUT_LIMIT_EXCEEDED",
  );
});

test("EB-SIZE: the refusal quotes two integers and no payload byte", () => {
  const text = message(() => {
    assertSubjectOutputWithinDeclaredBytes([payload("p", Buffer.from(SECRET_CANARY))], 4);
  });
  assert.ok(!text.includes(SECRET_CANARY), "an over-size refusal must not echo the payload");
  assert.match(text, /\d+ bytes against a declared ceiling of \d+/);
});

test("EB-SIZE: multibyte payloads are measured after encoding, not before", () => {
  // 1500 characters, 4500 bytes, against a 4096 ceiling. A character count says
  // this fits; it does not.
  const multibyte = payload("p", "€".repeat(1500));
  assert.equal(
    code(() => {
      assertSubjectOutputWithinDeclaredBytes([multibyte], 4096);
    }),
    "SUBJECT_OUTPUT_LIMIT_EXCEEDED",
  );
});

// -- subject-output content scanning ----------------------------------------

test("EB-CONTENT: a secret canary in retained output is a Lab-owned refusal", () => {
  const err = ((): { code?: string; owner?: string } => {
    try {
      assertSubjectOutputContentClean([payload("subject-output/steps/x.out", SECRET_CANARY)]);
    } catch (cause) {
      return cause as { code?: string; owner?: string };
    }
    return {};
  })();
  assert.equal(err.code, "SECRET_CANARY_IN_SUBJECT_OUTPUT");
  assert.equal(err.owner, "lab", "an evidence-boundary failure is never a subject finding");
});

test("EB-CONTENT: a forbidden identifier in retained output is refused", () => {
  assert.equal(
    code(() => {
      assertSubjectOutputContentClean([
        payload("subject-output/steps/x.out", "-----BEGIN RSA PRIVATE KEY-----\n"),
      ]);
    }),
    "SECRET_PLAINTEXT_IN_CONTRACT",
  );
});

test("EB-CONTENT: every declared forbidden identifier is actually refused", () => {
  // The vocabulary is shared with the adapter host's output and diagnostics
  // paths. Asserting it entry by entry is what stops this surface drifting into a
  // second, quieter list.
  for (const token of ["aws_secret_access_key", "AGE-SECRET-KEY-", "BEGIN OPENSSH PRIVATE KEY", "BEGIN PRIVATE KEY"]) {
    assert.equal(
      code(() => {
        assertSubjectOutputContentClean([payload("p", `prefix ${token} suffix`)]);
      }),
      "SECRET_PLAINTEXT_IN_CONTRACT",
      `${token} is declared forbidden and must be refused`,
    );
  }
});

test("EB-CONTENT: the judge-canary rule is deliberately not duplicated here", () => {
  // This is the ordering anchor for the decision recorded in ADR-ERL2-032 §5. The
  // `subject_output_prefill` oracle scan owns judge canaries on this surface and
  // has a load-bearing control proving it. A second gate answering the same
  // question would still refuse the run — and would therefore make that control
  // kill nothing. If this case ever starts throwing, the control has been
  // silently retired.
  assert.doesNotThrow(() => {
    assertSubjectOutputContentClean([payload("p", JUDGE_CANARY)]);
  });
});

test("EB-CONTENT: clean binary output is admitted", () => {
  // 0xFF in every position: not valid UTF-8 anywhere, and carrying nothing.
  const binary = Buffer.alloc(64 * 1024, 0xff);
  assert.doesNotThrow(() => {
    assertSubjectOutputContentClean([payload("p", binary)]);
  });
});

test("EB-CONTENT: a token embedded in otherwise invalid UTF-8 is still found", () => {
  // The binary-safety case that matters. A scanner that decoded as UTF-8 first
  // would replace the surrounding bytes with U+FFFD; if it also normalised or
  // re-encoded, a token adjacent to them can stop matching. Matching is over a
  // byte-preserving view, so it does not.
  const buried = Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x80, 0x81]),
    Buffer.from(SECRET_CANARY, "utf8"),
    Buffer.from([0xc0, 0x80, 0xff]),
  ]);
  assert.equal(
    code(() => {
      assertSubjectOutputContentClean([payload("p", buried)]);
    }),
    "SECRET_CANARY_IN_SUBJECT_OUTPUT",
  );
});

test("EB-CONTENT: clean text output is admitted", () => {
  assert.doesNotThrow(() => {
    assertSubjectOutputContentClean([payload("p", "install output\nconfigure output\n")]);
  });
});

// -- diagnostics never republish what they refused ---------------------------

test("EB-REDACT: a refusal never echoes the token it refused", () => {
  // The label is built from run data — a source id, an entry id, a step id — and
  // the leak is sometimes *in* that identifier. Before this, the message
  // reprinted the exact canary into stderr and the CLI envelope.
  const text = message(() => {
    assertNoCanaryLeak(
      [{ surface: "mounted_file", label: `visible-step:${JUDGE_CANARY}`, bytes: JUDGE_CANARY }],
      [],
    );
  });
  assert.ok(text.includes("mounted_file"), "the refusal still names the surface it fired on");
  assert.ok(!text.includes(JUDGE_CANARY), `the refusal republished the canary: ${text}`);
  assert.ok(text.includes("[redacted-canary]"));
});

test("EB-REDACT: secret canaries are redacted by the same vocabulary", () => {
  assert.equal(redactOracleLabel(`a ${SECRET_CANARY} b`), "a [redacted-secret] b");
  assert.equal(redactOracleLabel(`a ${JUDGE_CANARY} b`), "a [redacted-canary] b");
  assert.equal(redactOracleLabel("nothing to hide"), "nothing to hide");
});

// -- lab telemetry -----------------------------------------------------------

function snapshot(sourceId: string): SourceSnapshotV1 {
  const base = {
    schema_version: "source-snapshot/v1",
    run_id: "01860d8e-0000-7000-8000-000000000001",
    snapshot_id: `snapshot-${sourceId}`,
    source_id: sourceId,
    source_kind: "ecosystem-evidence-source",
    source_schema: "erl2-generic-evidence/v1",
    source_identity_hash: `sha256:${"0".repeat(64)}`,
    state: "complete",
    query_hash: `sha256:${"1".repeat(64)}`,
    window: { from: "2026-01-01T00:00:00Z", to_exclusive: "2026-01-01T00:01:00Z" },
    started_at: "2026-01-01T00:00:00Z",
    ended_at: "2026-01-01T00:01:00Z",
    pages: 1,
    records: 0,
    bytes: 0,
    dedupe_key: `${sourceId}:x`,
    ordering_id: "event-time-ascending",
    sampling: { kind: "none" },
    truncation: { truncated: false },
    health_record_hash: `sha256:${"2".repeat(64)}`,
    provenance: { producer: "erl2-capture-coordinator", producer_version: "0.1.0", transformations: [] },
  };
  return { ...base, core_hash: `sha256:${"3".repeat(64)}` } as unknown as SourceSnapshotV1;
}

test("EB-TELEMETRY: a canary anywhere in a snapshot's retained bytes refuses", () => {
  assert.equal(
    code(() => {
      assertTelemetryOracleClean([snapshot(JUDGE_CANARY)], []);
    }),
    "JOURNEY_ORACLE_CANARY_LEAKED",
  );
});

test("EB-TELEMETRY: the refusal names lab_telemetry and not the canary", () => {
  const text = message(() => {
    assertTelemetryOracleClean([snapshot(JUDGE_CANARY)], []);
  });
  assert.ok(text.includes("lab_telemetry"), `the wrong surface fired: ${text}`);
  assert.ok(!text.includes(JUDGE_CANARY), `the refusal republished the canary: ${text}`);
});

test("EB-TELEMETRY: clean telemetry passes", () => {
  assert.doesNotThrow(() => {
    assertTelemetryOracleClean([snapshot("deployment-log"), snapshot("service-metric")], []);
  });
});

// -- the mounted-file byte binding -------------------------------------------
//
// `freezeMountedFile` is a `RunWorkspace` method, so these drive the store
// primitives it is composed of directly: the scan is proven on the shipped path
// by the e2e suite, and what is proven here is the fail-closed behaviour of the
// binding it wraps them in — which no end-to-end run can reach without tampering.

test("EB-MOUNT-BIND: a published mount is verified against the bytes that were scanned", () => {
  const store = new ArtifactStore(scratch("mount"));
  const value = { entry_id: "deployment-log", state: "complete" };
  const bytes = Buffer.concat([jcsBytes(value), Buffer.from("\n", "utf8")]);
  const ref = store.freeze({
    logicalPath: "subject-visible/canonical/x.json",
    bytes,
    mediaType: "application/json",
    classification: "PUBLIC",
  });
  assert.doesNotThrow(() => {
    store.verify(ref);
  });

  // Replace the published bytes behind the reference. The binding is what turns a
  // silent substitution into a typed refusal.
  const absolute = path.join(store.root, "subject-visible", "canonical", "x.json");
  chmodSync(absolute, 0o644);
  writeFileSync(absolute, Buffer.concat([bytes, Buffer.from(JUDGE_CANARY, "utf8")]));
  assert.equal(
    code(() => {
      store.verify(ref);
    }),
    "ARTIFACT_HASH_MISMATCH",
    "a mount replaced after it was scanned must fail closed",
  );
});

test("EB-MOUNT-BIND: a mount already frozen with different bytes is refused, not overwritten", () => {
  // The resumed-run case. A second attempt recomputes clean bytes; if the file on
  // disk is not those bytes, publishing must refuse rather than expose either.
  const store = new ArtifactStore(scratch("mount"));
  const first = Buffer.from('{"a":1}\n', "utf8");
  store.freeze({
    logicalPath: "subject-visible/steps/s.json",
    bytes: first,
    mediaType: "application/json",
    classification: "PUBLIC",
  });
  assert.equal(
    code(() => {
      store.freeze({
        logicalPath: "subject-visible/steps/s.json",
        bytes: Buffer.from('{"a":2}\n', "utf8"),
        mediaType: "application/json",
        classification: "PUBLIC",
      });
    }),
    "ARTIFACT_ALREADY_FROZEN",
  );
});

test("EB-MOUNT-BIND: a mount path resolving through a symlink is refused before any read", () => {
  const store = new ArtifactStore(scratch("mount"));
  const outside = scratch("outside");
  writeFileSync(path.join(outside, "planted.json"), JUDGE_CANARY);
  const linkParent = path.join(store.root, "subject-visible");
  writeFileSync(path.join(store.root, "keep"), "");
  symlinkSync(outside, linkParent);
  assert.equal(
    code(() => {
      store.freeze({
        logicalPath: "subject-visible/planted.json",
        bytes: Buffer.from("{}\n", "utf8"),
        mediaType: "application/json",
        classification: "PUBLIC",
      });
    }),
    "PATH_SYMLINK_REJECTED",
  );
  rmSync(linkParent);
});

test("EB-MOUNT-BIND: a missing mount is an absence, never an empty read", () => {
  const store = new ArtifactStore(scratch("mount"));
  assert.equal(
    code(() => {
      store.read("subject-visible/canonical/never-written.json");
    }),
    "ARTIFACT_NOT_FOUND",
  );
});

test("EB-MOUNT-BIND: the scanned bytes are the exact published bytes", () => {
  // Canonical JSON plus one trailing newline is what `freezeJson` writes, and
  // therefore what `freezeMountedFile` must scan. If these ever diverge, the scan
  // is inspecting a serialization nothing exposes.
  const store = new ArtifactStore(scratch("mount"));
  const value = { b: 2, a: 1 };
  const ref = store.freezeJson("subject-visible/canonical/y.json", value, "PUBLIC");
  const onDisk = readFileSync(path.join(store.root, "subject-visible", "canonical", "y.json"));
  assert.deepEqual(onDisk, Buffer.concat([jcsBytes(value), Buffer.from("\n", "utf8")]));
  assert.equal(onDisk.byteLength, ref.byte_length);
});
