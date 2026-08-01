/**
 * `evidence-window-commitment/v1` at the contract boundary (ADR-ERL2-031 §3.1).
 *
 * The arithmetic suite exercises the *producer's* refusals; this one exercises
 * the **schema's**. Both exist because they fail at different times: the schema
 * refuses a malformed retained artifact a reader was handed, the producer refuses
 * a window it was asked to commit. A change that weakened either would leave the
 * other passing.
 *
 * The `multipleOf: 1000` cases are the ones worth reading. `erl2:common#/$defs/
 * Instant` is second-precision and the producer renders instants by
 * **truncating** a millisecond ISO string, so a 900 ms warmup would render
 * `…T00:00:00Z` and the retained instant would disagree with the arithmetic that
 * produced it. Pinning the durations to whole seconds in the frozen schema is
 * what makes every derived instant representable.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assertContract, CONTRACTS, type Erl2Error } from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";

const RUN = "019f1af9-0000-7000-8000-000000000001";
const H = coreHash({ any: "artifact" });

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body = {
    schema_version: "evidence-window-commitment/v1",
    commitment_id: "window-019f1af9",
    run_id: RUN,
    cutoff_policy_hash: H,
    process_start_receipt_hash: H,
    monotonic_clock_domain_hash: H,
    comparison_policy_hash: H,
    environment_instance_hash: H,
    warmup_ms: 1_000,
    observation_ms: 5_000,
    instant_rule: "traffic_process_started_at_plus_warmup_ms_plus_observation_ms",
    milestone_relationship: "runtime_milestone_at_process_start_plus_warmup_ms",
    committed_at: "2026-07-29T00:00:00Z",
    ...overrides,
  };
  return {
    ...body,
    core_hash: coreHash(body),
    signature: {
      algorithm: "Ed25519",
      key_id: "erl2-dev-policy-author-ed25519-1",
      signed_hash: coreHash(body),
      signature_base64: `${"A".repeat(86)}==`,
    },
  };
}

const refuses = (value: unknown): string => {
  try {
    assertContract("EvidenceWindowCommitmentV1", value);
  } catch (cause) {
    return (cause as Erl2Error).code ?? "refused";
  }
  return "<accepted>";
};

test("WINDOW-CONTRACT: the registry declares the contract, uniquely", () => {
  const entry = CONTRACTS.find((c) => c.schemaVersion === "evidence-window-commitment/v1");
  assert.ok(entry !== undefined, "evidence-window-commitment/v1 is not registered");
  assert.equal(entry.id, "ERL2-C-159");
  assert.equal(entry.name, "EvidenceWindowCommitmentV1");
  assert.equal(entry.union, false);
});

test("WINDOW-CONTRACT: a well-formed commitment validates", () => {
  assertContract("EvidenceWindowCommitmentV1", base());
});

test("WINDOW-CONTRACT: every required field is required", () => {
  for (const field of [
    "run_id",
    "cutoff_policy_hash",
    "process_start_receipt_hash",
    "monotonic_clock_domain_hash",
    "comparison_policy_hash",
    "environment_instance_hash",
    "warmup_ms",
    "observation_ms",
    "instant_rule",
    "milestone_relationship",
    "committed_at",
    "signature",
  ]) {
    const value = base();
    delete value[field];
    assert.notEqual(refuses(value), "<accepted>", `${field} is not required`);
  }
});

test("WINDOW-CONTRACT: an extra field fails closed", () => {
  assert.notEqual(refuses(base({ operator_note: "why we chose this" })), "<accepted>");
});

test("WINDOW-CONTRACT: the durations are whole seconds, bounded, and integral", () => {
  // The truncation hazard, at the schema.
  assert.notEqual(refuses(base({ warmup_ms: 900 })), "<accepted>", "a 900 ms warmup must be refused");
  assert.notEqual(refuses(base({ warmup_ms: 1_500 })), "<accepted>");
  assert.notEqual(refuses(base({ observation_ms: 5_500 })), "<accepted>");
  // Fractions and negatives.
  assert.notEqual(refuses(base({ observation_ms: 1_000.5 })), "<accepted>");
  assert.notEqual(refuses(base({ warmup_ms: -1_000 })), "<accepted>");
  // Bounds, and their edges.
  assertContract("EvidenceWindowCommitmentV1", base({ warmup_ms: 0 }));
  assertContract("EvidenceWindowCommitmentV1", base({ warmup_ms: 5_400_000 }));
  assertContract("EvidenceWindowCommitmentV1", base({ observation_ms: 1_000 }));
  assert.notEqual(refuses(base({ warmup_ms: 5_401_000 })), "<accepted>");
  assert.notEqual(refuses(base({ observation_ms: 0 })), "<accepted>");
});

test("WINDOW-CONTRACT: the rule fields are pinned, so old bytes cannot be reinterpreted", () => {
  assert.notEqual(refuses(base({ instant_rule: "something_else" })), "<accepted>");
  assert.notEqual(refuses(base({ milestone_relationship: "runtime_milestone_at_process_start" })), "<accepted>");
});

test("WINDOW-CONTRACT: identity and authority fields are shape-checked", () => {
  assert.notEqual(refuses(base({ run_id: "run-1" })), "<accepted>", "run_id must be a UUIDv7");
  assert.notEqual(refuses(base({ cutoff_policy_hash: "notahash" })), "<accepted>");
  assert.notEqual(refuses(base({ committed_at: "2026-07-29T00:00:00.500Z" })), "<accepted>");
  const value = base();
  value["signature"] = { algorithm: "Ed25519", key_id: "k", signed_hash: H };
  assert.notEqual(refuses(value), "<accepted>", "an incomplete signature must be refused");
});
