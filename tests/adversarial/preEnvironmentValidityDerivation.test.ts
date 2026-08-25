/**
 * RL-D-028 — the retained pre-environment validity verdict, read instead of derived.
 *
 * ## The boundary this file measures
 *
 * The environment branch stopped believing its producer some time ago:
 * `deriveValidityOutcome` recomputes `status` from `gate_results` and refuses a
 * result that disagrees with its own gates. The pre-environment branch never
 * did. It reads the *signed constant* `attestation.lab_validity` and never opens
 * the retained `pre-environment-validity-result/v1` at all — so the gates that
 * decide whether the run was valid are, on this branch, evidence nobody checks.
 *
 * The attacker here is not an arbitrary reader: every case below is **fully
 * re-signed** with the repository's development finalizer key, because that is
 * the honest threat model. This is the compromised-or-careless *producer*, and
 * the point of an offline verifier is that holding the key must not be the same
 * thing as being believed. The producer-side invariant is weak in the same way —
 * `assertValidityAdmitsGenericIndex` checks `status` and never recomputes it —
 * so nothing upstream catches this either.
 *
 * ## Why the cascade is built the long way
 *
 * A doctored validity result changes its own core hash, which unbinds the run
 * record, which unbinds the attestation's `run_record_hash`, which is signed.
 * Each case therefore rebuilds the whole chain and re-signs the terminal, so the
 * bundle the verifier sees is **cryptographically impeccable**: every hash
 * recomputed, every signature valid under an authorized role, the signed freeze
 * head still satisfied. Cases C1 and C2 exist to prove that is true — they break
 * one link each and show the hash and signature refusals still fire *first*, so
 * a green result here can never be a crypto check wearing a semantic name.
 *
 * The shipped goldens are copied, never written to.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { coreHash, hashBytes } from "@erl2/integrity";
import { deriveValidityOutcome, verifierRequiredGateIds } from "@erl2/public-verifier";
import {
  copyPreEnvironmentGolden,
  gatesOf,
  readJson,
  reseal,
  resignCascade,
  verifyOffline,
  writeJson,
  type GateRow,
  type GoldenCopy as Copy,
  type Json,
} from "../support/preEnvironmentCascade.js";

/**
 * The re-signing cascade this file used to carry inline now lives in
 * `tests/support/preEnvironmentCascade.ts`, because RL-D-031 needs the same
 * machinery and two copies of it would drift. The BASELINE case below is what
 * proves the shared cascade is still faithful for this suite: an identity
 * doctor must land back on the shipped terminal.
 */
const copyGolden = (): Copy => copyPreEnvironmentGolden("erl2-d028-");
const gates = gatesOf;


// -- baseline ----------------------------------------------------------------

test("D028-BASELINE: the honest pre-environment golden verifies offline", () => {
  const outcome = verifyOffline(copyGolden());
  assert.equal(outcome.exitCode, 0, `${outcome.code}: ${outcome.message}`);
  assert.equal(outcome.verdict, "valid");
});

test("D028-BASELINE: the cascade itself preserves a valid bundle", () => {
  // Without this, every case below could be passing because the cascade breaks
  // something incidental rather than because of the contradiction under test.
  const c = copyGolden();
  const before = readJson(path.join(c.artifacts, "retained", "final-attestation.json"))["core_hash"];
  const { attestationHash } = resignCascade(c, (v) => v);
  // An identity doctor must land back on the shipped terminal: that is what
  // makes the cascade a faithful rebuild rather than a rewrite.
  assert.equal(attestationHash, before, "a faithful cascade must reproduce the shipped terminal");
  const outcome = verifyOffline(c);
  assert.equal(outcome.exitCode, 0, `a faithful re-sign must still verify: ${outcome.code}: ${outcome.message}`);
  assert.equal(outcome.verdict, "valid");
});

// -- attacks -----------------------------------------------------------------

test("D028-A1: a fully re-signed bundle whose retained result declares status invalid is refused", () => {
  const c = copyGolden();
  resignCascade(c, (v) => ({
    ...v,
    status: "invalid",
    gate_results: gates(v).map((g, i) => (i === 0 ? { ...g, passed: false } : g)),
  }));
  const outcome = verifyOffline(c);
  assert.notEqual(
    outcome.exitCode,
    0,
    `a bundle attesting a run its own gates invalidate must be refused; verdict ${outcome.verdict}`,
  );
  assert.ok(
    ["EVALUATOR_VALIDITY_GATE_FAILED", "BUNDLE_VARIANT_MISMATCH"].includes(outcome.code),
    `the refusal must be the semantic derivation: ${outcome.code}: ${outcome.message}`,
  );
});

test("D028-A2: a fully re-signed bundle claiming status valid over a failed gate is refused", () => {
  const c = copyGolden();
  // The exact contradiction the environment branch already refuses and this one
  // accepted: the result's own gate says the run failed, and its `status` says
  // otherwise. Nothing else in the bundle disagrees.
  resignCascade(c, (v) => ({
    ...v,
    status: "valid",
    gate_results: gates(v).map((g, i) => (i === 0 ? { ...g, passed: false } : g)),
  }));
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, `a status/gate contradiction must be refused; verdict ${outcome.verdict}`);
  assert.equal(
    outcome.code,
    "EVALUATOR_VALIDITY_GATE_FAILED",
    `the refusal must be the derived-status mismatch: ${outcome.message}`,
  );
});

test("D028-A3: a missing retained validity result is refused", () => {
  const c = copyGolden();
  rmSync(path.join(c.artifacts, "retained", "validity-result.json"));
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a bundle with no validity result must be refused");
  assert.equal(outcome.code, "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT", outcome.message);
});

test("D028-A4: a second retained validity result is refused", () => {
  const c = copyGolden();
  const source = readJson(path.join(c.artifacts, "retained", "validity-result.json"));
  const { core_hash: _drop, ...body } = source;
  reseal(path.join(c.artifacts, "retained", "validity-result-second.json"), {
    ...body,
    evaluated_at: "2026-07-01T00:00:25Z",
  });
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "exactly one validity result may be admitted");
  assert.equal(outcome.code, "GRAPH_CLOSURE_EXTRA_ARTIFACT", outcome.message);
});

test("D028-A5: a malformed retained validity result is refused", () => {
  const c = copyGolden();
  // Still declares `pre-environment-validity-result/v1`; no longer satisfies it.
  resignCascade(c, (v) => {
    const { gate_results: _drop, ...rest } = v;
    return { ...rest, status: "valid" };
  });
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a malformed validity result must be refused");
  assert.ok(
    ["GRAPH_CLOSURE_RETAINED_CONTRACT_INVALID", "SCHEMA_VALIDATION_FAILED"].includes(outcome.code),
    `the refusal must be contract validation: ${outcome.code}: ${outcome.message}`,
  );
});

test("D028-A6: invalidity findings cited by an all-passing validity result are refused", () => {
  const c = copyGolden();
  // The finding resolves -- it is the golden's own retained finding -- so this
  // is not a dangling-reference refusal. A result whose every gate passed has
  // nothing to explain, and citing an invalidity for it is a contradiction.
  const finding = readJson(
    path.join(c.artifacts, "retained", "subject-package-verification-finding.json"),
  )["core_hash"] as string;
  resignCascade(c, (v) => ({ ...v, status: "valid", invalidity_finding_hashes: [finding] }));
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a valid result citing invalidity findings must be refused");
  assert.equal(outcome.code, "EVALUATOR_VALIDITY_GATE_FAILED", outcome.message);
});

// -- ordering controls -------------------------------------------------------

test("D028-C1: a stale artifact hash is refused before any semantic interpretation", () => {
  const c = copyGolden();
  const validityPath = path.join(c.artifacts, "retained", "validity-result.json");
  const validity = readJson(validityPath);
  // Doctored and left *unresealed*: the declared core hash no longer matches.
  writeJson(validityPath, {
    ...validity,
    gate_results: gates(validity).map((g, i) => (i === 0 ? { ...g, passed: false } : g)),
  });
  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a stale hash must be refused");
  assert.equal(
    outcome.code,
    "ARTIFACT_HASH_MISMATCH",
    `hash checks must precede semantic derivation: ${outcome.message}`,
  );
});

test("D028-C2: an invalid terminal signature is refused before any semantic interpretation", () => {
  const c = copyGolden();
  const retained = path.join(c.artifacts, "retained");
  const attestationPath = path.join(retained, "final-attestation.json");
  const original = readFileSync(attestationPath, "utf8");
  const signature = (readJson(attestationPath)["signature"] as Json)["signature_base64"] as string;
  // Byte-for-byte the same length, and the bundle's payload descriptor is
  // re-pointed at the forged bytes, so the referenced-bytes pass cannot be what
  // refuses. `signature` is excluded from the core hash by design, so the
  // attestation's identity -- and every binding to it -- is untouched: the only
  // thing wrong with this bundle is that the signature does not verify.
  const forged = Buffer.alloc(64, 7).toString("base64");
  assert.equal(forged.length, signature.length, "the forged signature must preserve byte length");
  chmodSync(attestationPath, 0o644);
  writeFileSync(attestationPath, original.replace(signature, forged));

  const bytes = readFileSync(attestationPath);
  assert.equal(bytes.byteLength, Buffer.byteLength(original), "byte length must be unchanged");
  const forgedAttestation = readJson(attestationPath);
  for (const bundlePath of [path.join(c.dir, "public-bundle.json"), path.join(retained, "public-bundle.json")]) {
    const bundle = readJson(bundlePath);
    const member = bundle["final_attestation"] as Json;
    const artifact = member["artifact"] as Json;
    const { core_hash: _bh, ...rest } = bundle;
    const body: Json = {
      ...rest,
      final_attestation: { ...member, artifact: { ...artifact, file_sha256: hashBytes(bytes) } },
    };
    writeJson(bundlePath, { ...body, core_hash: coreHash(body) });
  }
  assert.equal(
    forgedAttestation["core_hash"],
    readJson(path.join(c.dir, "public-bundle.json"))["final_attestation"] &&
      ((readJson(path.join(c.dir, "public-bundle.json"))["final_attestation"] as Json)[
        "artifact_core_hash"
      ] as string),
    "the forged attestation must keep the identity every binding already points at",
  );

  const outcome = verifyOffline(c);
  assert.notEqual(outcome.exitCode, 0, "a forged signature must be refused");
  assert.equal(
    outcome.code,
    "TRUST_SIGNATURE_INVALID",
    `signature checks must precede semantic derivation: ${outcome.message}`,
  );
});

// -- parity ------------------------------------------------------------------

test("D028-PARITY: the environment branch refuses the analogous contradiction, and still does", () => {
  // The pre-environment fix exists to reach parity with this. Asserting the
  // environment behaviour in the same file means a future edit cannot quietly
  // close one branch and reopen the other.
  //
  // The fixture is built so that exactly one control can answer. The failed gate
  // is **corroborated** by a retained invalidity finding that names it, so the
  // "a failed gate no finding explains" clause -- which raises the same
  // `EVALUATOR_VALIDITY_GATE_FAILED` code -- cannot fire and stand in for the
  // status/gate comparison under test. What is left is the declared/derived
  // contradiction alone: the result declares `valid` while its own corroborated
  // rows derive `invalid`.
  //
  // The distinction is load-bearing and is measured, not assumed. Disabling the
  // declared-versus-derived comparison in `deriveValidityOutcome` does not leave
  // this test green: the derivation runs on to the public-bundle clause and
  // refuses with `BUNDLE_VARIANT_MISMATCH` instead, which this assertion does not
  // accept. The corroborating finding is what makes that true.
  const failedGateId = "cleanup-verified";
  const findingHash = `sha256:${"11".repeat(32)}`;
  // RL-D-031 landed, so the set is now the complete one this branch owes --
  // built from the shipped catalogue rather than hand-listed, and with the two
  // applicability-governed gates supplied to match the `outcomes: []` context
  // below (no exercising step outcome, no retained telemetry observation).
  //
  // Two rows would still refuse, but as `GRAPH_CLOSURE_MISSING_ROLE` -- and a
  // completeness refusal standing in for the declared-versus-derived comparison
  // is exactly the substitution this test exists to prevent.
  const gateSet = verifierRequiredGateIds("environment", "development_fake_port").map((gate_id: string) => ({
    gate_id,
    passed: gate_id !== failedGateId,
    evidence_refs: [] as string[],
  }));
  const validity = {
    schema_version: "environment-validity-result/v1",
    status: "valid",
    gate_results: gateSet,
    invalidity_finding_hashes: [findingHash],
  } as unknown as Parameters<typeof deriveValidityOutcome>[0]["validity"];

  // The retained finding the failed gate is corroborated by. Resolved through the
  // same `index.get` the derivation uses, so the corroboration clause sees a real
  // answer rather than an empty stub.
  const index = {
    get: (hash: string) => {
      assert.equal(hash, findingHash, "the derivation must resolve the cited finding");
      return { value: { failed_gate_ids: [failedGateId] } };
    },
  } as unknown as Parameters<typeof deriveValidityOutcome>[0]["index"];

  assert.throws(
    () =>
      deriveValidityOutcome({
        index,
        validity,
        requireValid: true,
        outcomes: [],
        telemetryObservationRetained: false,
        subjectExecutionMode: "development_fake_port",
        attributableTelemetryApplicable: false,
      }),
    (error: unknown) => (error as { code?: string }).code === "EVALUATOR_VALIDITY_GATE_FAILED",
    "the environment derivation must refuse a status/gate contradiction",
  );
});
