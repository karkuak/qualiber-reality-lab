/**
 * The semantic gate over the excluded CLI transcript.
 *
 * ## What was broken
 *
 * `cli-transcript.json` records the absolute path arguments of every invocation,
 * so it is one of the seven files `evidence:verify` cannot byte-pin. An excluded
 * file is an uncovered file, and this one proved it: the committed transcript
 * predated ERL2-OQ-005 and still carried a `doctor` report with no
 * `compose_substrate` block at all. Nothing failed, because the only gate over
 * that file was a byte comparison that never ran.
 *
 * ## What these controls assert
 *
 * The replacement gate does not compare bytes; it parses the generated transcript
 * and asserts the current doctor structure and the OQ-005 substrate boundary. Its
 * decision lives in `scripts/lib/doctorTranscriptGate.mjs` as a pure function, so
 * every branch is driven here rather than only by a full evidence generation.
 *
 * Each case starts from a transcript that passes clean and breaks exactly one
 * thing, because a check that only fires when several things are wrong at once is
 * not a check. The stale shape the gate was written for — a doctor report with no
 * `compose_substrate` — is one of them.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const { doctorTranscriptFailures, doctorTranscriptSummary } = (await import(
  pathToFileURL(path.join(repoRoot, "scripts", "lib", "doctorTranscriptGate.mjs")).href
)) as {
  doctorTranscriptFailures: (transcript: unknown) => string[];
  doctorTranscriptSummary: (transcript: unknown) => string;
};

type Json = Record<string, unknown>;

/** The current `erl2 doctor` report, as the harness records it. */
function currentDoctorEntry(overrides: { data?: Json; compose?: Json; exit?: number } = {}): Json {
  const compose: Json = {
    substrate_lock: "qualified_development_signed",
    driver: "enabled_by_development_signed_lock",
    lock_hash: `sha256:${"a".repeat(64)}`,
    signer_key_id: "erl2-dev-challenge-governor-ed25519-1",
    signer_classification: "development_key",
    release_tag: "3.0.0",
    source_commit: "1".repeat(40),
    platforms: ["linux/amd64", "linux/arm64"],
    services: ["otel-collector", "quote"],
    independently_qualified: false,
    ...(overrides.compose ?? {}),
  };
  return {
    argv: ["erl2", "doctor", "--profile", "local-developer"],
    exit_code: overrides.exit ?? 0,
    stdout: {
      data: {
        subject_isolation: { qualification: "qualified" },
        compose_substrate: compose,
        profile: "local-developer",
        node_version: "v22.0.0",
        registered_contracts: 200,
        adapter_protocol_version: "subject-adapter/v1",
        adapter_sandbox_profile: "local-process",
        compose_environment_driver: compose["driver"],
        otel_demo_substrate_lock: compose["substrate_lock"],
        ...(overrides.data ?? {}),
      },
    },
    stderr: "",
  };
}

function transcriptWith(doctorEntry: Json | undefined): unknown[] {
  const others = [
    { argv: ["erl2", "status", "--run", "x"], exit_code: 0, stdout: { data: {} }, stderr: "" },
    { argv: ["erl2", "verify", "--offline"], exit_code: 0, stdout: { data: {} }, stderr: "" },
  ];
  return doctorEntry === undefined ? others : [doctorEntry, ...others];
}

test("DOCTOR-GATE: the current doctor transcript passes", () => {
  const transcript = transcriptWith(currentDoctorEntry());
  assert.deepEqual(doctorTranscriptFailures(transcript), []);
  assert.match(doctorTranscriptSummary(transcript), /qualified_development_signed/);
  assert.match(doctorTranscriptSummary(transcript), /independently_qualified=false/);
});

test("DOCTOR-GATE: the stale pre-OQ-005 shape — a doctor report with no compose_substrate — is refused", () => {
  const entry = currentDoctorEntry();
  const data = (entry["stdout"] as Json)["data"] as Json;
  delete data["compose_substrate"];
  delete data["compose_environment_driver"];
  delete data["otel_demo_substrate_lock"];
  // The pre-OQ-005 report said this, and only this, about the substrate.
  data["compose_environment_driver"] = "disabled_pending_erl2_oq_005";

  const failures = doctorTranscriptFailures(transcriptWith(entry));
  assert.ok(failures.length > 0, "the stale shape must be refused");
  assert.ok(
    failures.some((f) => f.includes("compose_substrate")),
    `the refusal must name compose_substrate: ${failures.join("; ")}`,
  );
});

test("DOCTOR-GATE: a doctor report missing a promised section is refused", () => {
  for (const key of [
    "subject_isolation",
    "profile",
    "node_version",
    "registered_contracts",
    "adapter_protocol_version",
    "adapter_sandbox_profile",
  ]) {
    const entry = currentDoctorEntry();
    delete ((entry["stdout"] as Json)["data"] as Json)[key];
    const failures = doctorTranscriptFailures(transcriptWith(entry));
    assert.ok(
      failures.some((f) => f.includes(key)),
      `dropping ${key} must be refused, got: ${failures.join("; ")}`,
    );
  }
});

test("DOCTOR-GATE: a substrate verdict that overstates the OQ-005 boundary is refused", () => {
  // Each of these is the kind of claim that must never appear silently: an
  // independent qualification the Lab does not have, a pinned-authority signer it
  // is not signed by, and a driver enabled on a stronger footing than the lock.
  const overstatements: Json[] = [
    { independently_qualified: true },
    { signer_classification: "pinned_authority" },
    { substrate_lock: "qualified_authenticated" },
    { driver: "enabled_by_qualified_lock" },
  ];
  for (const compose of overstatements) {
    const entry = currentDoctorEntry({ compose });
    const failures = doctorTranscriptFailures(transcriptWith(entry));
    assert.ok(
      failures.length > 0,
      `${JSON.stringify(compose)} must be refused until the substrate really is qualified`,
    );
  }
});

test("DOCTOR-GATE: a derived block that disagrees with the flat keys is refused", () => {
  const entry = currentDoctorEntry();
  const data = (entry["stdout"] as Json)["data"] as Json;
  // The flat keys exist for older readers and are the same verdict, never a
  // second constant. A disagreement means one of them is remembered, not derived.
  data["compose_environment_driver"] = "disabled_pending_erl2_oq_005";
  const failures = doctorTranscriptFailures(transcriptWith(entry));
  assert.ok(
    failures.some((f) => f.includes("compose_environment_driver")),
    `the disagreement must be named: ${failures.join("; ")}`,
  );
});

test("DOCTOR-GATE: a restated rather than derived substrate block is refused", () => {
  // The hardcoded shape carried a verdict and nothing that could only come from
  // reading the lock. Losing the derived fields is losing the evidence that the
  // verdict was derived at all.
  for (const key of ["lock_hash", "services", "platforms"]) {
    const entry = currentDoctorEntry();
    const compose = ((entry["stdout"] as Json)["data"] as Json)["compose_substrate"] as Json;
    delete compose[key];
    const failures = doctorTranscriptFailures(transcriptWith(entry));
    assert.ok(
      failures.some((f) => f.includes(key)),
      `dropping ${key} must be refused, got: ${failures.join("; ")}`,
    );
  }
});

test("DOCTOR-GATE: a missing, failed or duplicated doctor invocation is refused", () => {
  assert.ok(
    doctorTranscriptFailures(transcriptWith(undefined)).some((f) => f.includes("found 0")),
    "a transcript with no doctor invocation must be refused",
  );

  const failed = currentDoctorEntry({ exit: 3 });
  assert.ok(
    doctorTranscriptFailures(transcriptWith(failed)).some((f) => f.includes("doctor exited 3")),
    "a doctor invocation that failed must be refused",
  );

  const doubled = [currentDoctorEntry(), currentDoctorEntry(), ...transcriptWith(undefined)];
  assert.ok(
    doctorTranscriptFailures(doubled).some((f) => f.includes("found 2")),
    "two doctor invocations must be refused",
  );

  assert.deepEqual(doctorTranscriptFailures({} as unknown), [
    "the transcript is not an array of CLI invocations",
  ]);
});
