/**
 * CONTRACT, VERSION-CLOSURE and closed-schema behaviour.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  assertContract,
  compileAll,
  CONTRACTS,
  parseStrictJson,
  validateContract,
} from "@erl2/contracts";

test("CONTRACT: every registered contract compiles", () => {
  compileAll();
  assert.ok(CONTRACTS.length >= 80, `expected the full contract set, found ${CONTRACTS.length}`);
});

test("CONTRACT: contract ids and names are unique", () => {
  assert.equal(new Set(CONTRACTS.map((c) => c.id)).size, CONTRACTS.length);
  assert.equal(new Set(CONTRACTS.map((c) => c.name)).size, CONTRACTS.length);
});

test("CONTRACT: unknown fields fail closed", () => {
  const valid = {
    schema_version: "acquisition-adapter-request/v1",
    protocol_version: "subject-adapter/v1",
    run_id: "01890000-0000-7000-8000-000000000000",
    operation_id: "op-acquire",
    acquisition_preregistration_hash: `sha256:${"0".repeat(64)}`,
    acquisition_source_manifest_hash: `sha256:${"1".repeat(64)}`,
    adapter_manifest_hash: `sha256:${"2".repeat(64)}`,
    visible_step: {
      artifact: {
        path: "retained/step.json",
        media_type: "application/json",
        byte_length: 10,
        file_sha256: `sha256:${"3".repeat(64)}`,
        classification: "INTERNAL",
      },
      core_hash: `sha256:${"4".repeat(64)}`,
    },
    credential_handle_ids: [],
    resource_limit_hash: `sha256:${"5".repeat(64)}`,
    deadline: "2026-07-01T00:10:00Z",
    core_hash: `sha256:${"6".repeat(64)}`,
  };
  assert.equal(validateContract("AcquisitionAdapterRequestV1", valid).valid, true);
  const withExtra = { ...valid, metadata: { anything: true } };
  assert.equal(validateContract("AcquisitionAdapterRequestV1", withExtra).valid, false);
});

test("REQUEST-ANCESTRY: an acquisition request cannot carry a later-phase ancestor", () => {
  const withPlan = {
    schema_version: "acquisition-adapter-request/v1",
    protocol_version: "subject-adapter/v1",
    run_id: "01890000-0000-7000-8000-000000000000",
    operation_id: "op-acquire",
    acquisition_preregistration_hash: `sha256:${"0".repeat(64)}`,
    acquisition_source_manifest_hash: `sha256:${"1".repeat(64)}`,
    adapter_manifest_hash: `sha256:${"2".repeat(64)}`,
    execution_plan_hash: `sha256:${"7".repeat(64)}`,
    visible_step: {
      artifact: {
        path: "retained/step.json",
        media_type: "application/json",
        byte_length: 10,
        file_sha256: `sha256:${"3".repeat(64)}`,
        classification: "INTERNAL",
      },
      core_hash: `sha256:${"4".repeat(64)}`,
    },
    credential_handle_ids: [],
    resource_limit_hash: `sha256:${"5".repeat(64)}`,
    deadline: "2026-07-01T00:10:00Z",
    core_hash: `sha256:${"6".repeat(64)}`,
  };
  assert.equal(validateContract("AcquisitionAdapterRequestV1", withPlan).valid, false);
});

test("BLIND-JOURNEY-FAMILY: a held-out request may not carry exact journey commitments", () => {
  const base = {
    schema_version: "selection-request/v2",
    request_id: "held-out-request",
    run_id: "01890000-0000-7000-8000-000000000000",
    request_nonce: "a".repeat(64),
    requested_tier: "held_out",
    acquisition_preregistration_hash: `sha256:${"0".repeat(64)}`,
    acquisition_source_manifest_hash: `sha256:${"0".repeat(64)}`,
    acquisition_record_hash: `sha256:${"0".repeat(64)}`,
    subject_package_manifest_hash: `sha256:${"0".repeat(64)}`,
    adapter_manifest_hash: `sha256:${"0".repeat(64)}`,
    admissible_archetype_set_hash: `sha256:${"0".repeat(64)}`,
    challenge_family_hash: `sha256:${"0".repeat(64)}`,
    environment_profile_hash: `sha256:${"0".repeat(64)}`,
    eligibility_policy_hash: `sha256:${"0".repeat(64)}`,
    configuration_intent_hash: `sha256:${"0".repeat(64)}`,
    generic_run_policy_hash: `sha256:${"0".repeat(64)}`,
    actor_policy_hash: `sha256:${"0".repeat(64)}`,
    comparison_policy_hash: `sha256:${"0".repeat(64)}`,
    selection_randomness_policy_hash: `sha256:${"0".repeat(64)}`,
    journey_selection_policy_hash: `sha256:${"0".repeat(64)}`,
    requested_at: "2026-07-01T00:00:00Z",
    expires_at: "2026-12-31T00:00:00Z",
    core_hash: `sha256:${"0".repeat(64)}`,
    signature: {
      algorithm: "Ed25519",
      key_id: "erl2-dev-challenge-governor-ed25519-1",
      signed_hash: `sha256:${"0".repeat(64)}`,
      signature_base64: `${"A".repeat(86)}==`,
    },
  };
  assert.equal(validateContract("SelectionRequestV2", base).valid, true);
  const leaking = {
    ...base,
    non_blind_replay_persona_script_hash: `sha256:${"1".repeat(64)}`,
    non_blind_replay_journey_hash: `sha256:${"2".repeat(64)}`,
    non_blind_replay_step_commitment_hashes: [`sha256:${"3".repeat(64)}`],
  };
  assert.equal(validateContract("SelectionRequestV2", leaking).valid, false);
});

test("EMERGENCY-ACTION-EVIDENCE: unreceipted attempts and receipted skips are rejected", () => {
  const succeeded = {
    action_id: "stop-subject",
    kind: "stop_subject",
    independently_safe: true,
    status: "succeeded",
    attempt_receipt_hash: `sha256:${"0".repeat(64)}`,
  };
  assert.equal(validateContract("EmergencyCleanupActionV1", succeeded).valid, true);

  const unreceipted = { action_id: "stop-subject", kind: "stop_subject", independently_safe: true, status: "succeeded" };
  assert.equal(validateContract("EmergencyCleanupActionV1", unreceipted).valid, false);

  const receiptedSkip = {
    action_id: "destroy",
    kind: "destroy_partial_resource",
    independently_safe: false,
    status: "skipped_unsafe",
    reason_code: "SHARED_RESOURCE",
    attempt_receipt_hash: `sha256:${"0".repeat(64)}`,
  };
  assert.equal(validateContract("EmergencyCleanupActionV1", receiptedSkip).valid, false);

  const safeSkip = {
    action_id: "destroy",
    kind: "destroy_partial_resource",
    independently_safe: true,
    status: "skipped_unsafe",
    reason_code: "SHARED_RESOURCE",
  };
  assert.equal(validateContract("EmergencyCleanupActionV1", safeSkip).valid, false);
});

test("CONTRACT: duplicate JSON keys are rejected before validation", () => {
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /duplicate JSON object key/);
  assert.deepEqual(parseStrictJson('{"a":[1,2],"b":{"a":3}}'), { a: [1, 2], b: { a: 3 } });
});

test("CONTRACT: duplicate JSON keys whose decoded names collide are rejected (§11.1)", () => {
  // Raw token spellings differ (`a\/b` vs `a/b`) but both decode to `a/b`.
  // The pre-fix scanner compared raw spellings and let this through, silently
  // collapsing to `{"a/b":2}`.
  assert.throws(() => parseStrictJson('{"a\\/b":1,"a/b":2}'), /duplicate JSON object key/);
  // Unicode escape `a` decodes to `a`.
  assert.throws(() => parseStrictJson('{"\\u0061":1,"a":2}'), /duplicate JSON object key/);
  // Surrogate pair for U+1F600 vs the literal astral character (same code units).
  assert.throws(
    () => parseStrictJson('{"\\ud83d\\ude00":1,"\u{1F600}":2}'),
    /duplicate JSON object key/,
  );
  // A collision inside a nested object is also caught.
  assert.throws(() => parseStrictJson('{"x":{"a\\/b":1,"a/b":2}}'), /duplicate JSON object key/);
  // Non-colliding decoded escapes still parse and decode faithfully.
  assert.deepEqual(parseStrictJson('{"a\\/b":1,"c":2}'), { "a/b": 1, c: 2 });
  // A malformed escape inside a key is a fail-closed refusal, not silent acceptance.
  assert.throws(() => parseStrictJson('{"a\\x":1}'), /invalid JSON string escape/);
  assert.throws(() => parseStrictJson('{"a\\u00":1}'), /invalid JSON unicode escape/);
});

test("CONTRACT: non-safe integers and non-NFC strings are rejected", () => {
  const result = validateContract("EmergencyCleanupActionV1", {
    action_id: "áction",
    kind: "stop_subject",
    independently_safe: true,
    status: "succeeded",
    attempt_receipt_hash: `sha256:${"0".repeat(64)}`,
  });
  assert.equal(result.valid, false);
});

test("CONTRACT: an unknown contract name is a fail-closed refusal", () => {
  assert.throws(() => assertContract("NotAContract", {}), /SCHEMA_UNKNOWN_CONTRACT|no registered contract/);
});
