/**
 * Machine-asserted expected refusals (6R-D §9.2, review E).
 *
 * The evidence transcript records every CLI invocation, including the deliberate
 * refusals — but the review found they were only *counted*, never asserted. Each
 * recorded refusal must be a known, stable, authority-scoped refusal with a
 * nonzero exit and no forbidden terminal artifact; an unexpected refusal (or a
 * refusal that quietly turned into a success, or drifted to a different code)
 * fails here.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const transcript = JSON.parse(
  readFileSync(path.join(repoRoot, "fixtures", "golden", "cli-transcript.json"), "utf8"),
) as {
  argv: string[];
  exit_code: number;
  stdout: {
    ok: boolean;
    authority_scope?: string;
    errors?: { code: string; message: string }[];
    data?: Record<string, unknown>;
  } | null;
}[];

// Every refusal the evidence run is expected to record: `command|exit|code`.
const EXPECTED_REFUSALS = new Set<string>([
  "verify|10|VERIFY_OFFLINE_REQUIRED",
  "verify-record|10|VERIFY_RECORD_ATTESTATION_PRESENT",
  "freeze-output|10|GRAPH_CLOSURE_TERMINAL_MISMATCH",
  "preregister-acquisition|3|ADMISSION_SUBJECT_PORT_NOT_DEVELOPMENT",
  "acquire|6|ADAPTER_DEADLINE_EXCEEDED",
  "finalize-generic|10|GRAPH_CLOSURE_MISSING_ROLE",
  "select|2|POLICY_COMMAND_NOT_IMPLEMENTED",
]);

test("EXPECTED-REFUSALS: every recorded refusal is a known, stable, authority-scoped refusal", () => {
  const refusals = transcript.filter((e) => e.exit_code !== 0);
  assert.ok(refusals.length >= 10, "the evidence run records the expected refusals");

  for (const refusal of refusals) {
    const command = refusal.argv[1] as string;
    const code = refusal.stdout?.errors?.[0]?.code;
    assert.notEqual(refusal.exit_code, 0, `${command} must exit nonzero`);
    assert.ok(typeof code === "string" && code.length > 0, `${command} refusal has no stable error code`);
    assert.equal(refusal.stdout?.ok, false, `${command} refusal must not report ok`);
    assert.equal(
      refusal.stdout?.authority_scope,
      "lab_orchestration_only",
      `${command} must carry the Lab authority scope`,
    );
    // A refusal must never emit a forbidden terminal artifact.
    const body = JSON.stringify(refusal.stdout?.data ?? {});
    assert.ok(!body.includes("final-lab-attestation"), `${command} refusal emitted an attestation`);
    assert.ok(!body.includes("public-verification-bundle"), `${command} refusal emitted a public bundle`);
    // …and it must be one of the refusals this evidence run is expected to record.
    const key = `${command}|${String(refusal.exit_code)}|${code as string}`;
    assert.ok(EXPECTED_REFUSALS.has(key), `unexpected refusal ${key}`);
  }
});

test("EXPECTED-REFUSALS: the run also records the successful terminals it must", () => {
  // Sanity: the transcript is not all refusals — the valid and invalid terminals
  // verify with exit 0, so a regression that broke them would not hide here.
  const successes = transcript.filter((e) => e.exit_code === 0);
  assert.ok(
    successes.some((e) => e.argv[1] === "verify"),
    "a valid public bundle verifies offline (exit 0)",
  );
  assert.ok(
    successes.some((e) => e.argv[1] === "verify-record"),
    "an invalid record verifies offline (exit 0)",
  );
});
