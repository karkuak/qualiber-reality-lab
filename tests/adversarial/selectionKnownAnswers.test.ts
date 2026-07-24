/**
 * Selection known-answer vectors (6R-C, review P2-8, design v2 §15, ADR-ERL2-011).
 *
 * The producer (`runSelectionChain`) and the verifier (`verifySelectionChain`)
 * share the SAME derivation helpers, so a spec-vs-implementation formula error —
 * a wrong HMAC domain, endianness, or rejection limit — would compute the same
 * wrong value on both sides and pass every "producer == verifier" test.  The
 * only existing derivation test asserted determinism and range, not correctness.
 *
 * This file pins genuinely independent known-answer vectors:
 *
 *   - the expected values are frozen literals (NOT computed at test time by the
 *     production helpers), so a future formula change breaks the test; and
 *   - they are additionally recomputed here by a from-scratch reference that
 *     uses only `node:crypto` and a hand-written JCS — it never imports the
 *     production `derive.ts` or the `@erl2/integrity` domain-hash helpers — so a
 *     *current* formula error surfaces as a three-way disagreement between
 *     production, the reference, and the frozen literal.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash, createHmac } from "node:crypto";
import {
  deriveSelectedIndex,
  hidingCommitment,
  poolRootHash,
  sourceRequestBindingHash,
} from "@erl2/core";

// --- independent reference (raw crypto + hand-written JCS) ------------------

/** RFC 8785 subset: sort keys by code unit, JSON.stringify scalars. */
function refJcs(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(refJcs).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${refJcs(record[k])}`)
    .join(",")}}`;
}

/** `sha256:hex(SHA256(domain "\n" JCS(payload)))` — matches `domainHash`. */
function refDomainHash(domain: string, payload: unknown): string {
  return `sha256:${createHash("sha256").update(Buffer.from(`${domain}\n${refJcs(payload)}`, "utf8")).digest("hex")}`;
}

/** Independent rejection-sampling replay (design §15, ADR-ERL2-011). */
function refSelectedIndex(
  output: Buffer,
  nonce: string,
  poolRoot: string,
  n: number,
): { index: number; rejectionCount: number } {
  const seed = createHmac("sha256", output)
    .update(Buffer.concat([Buffer.from("ERL2-SELECT-V2\n", "utf8"), Buffer.from(nonce + poolRoot, "utf8")]))
    .digest();
  const limit = Math.floor(0x100000000 / n) * n;
  let rejectionCount = 0;
  for (let counter = 0; counter < 1_000_000; counter += 1) {
    const message = Buffer.alloc(4);
    message.writeUInt32BE(counter, 0);
    const block = createHmac("sha256", seed)
      .update(Buffer.concat([Buffer.from("ERL2-SELECT-INDEX-V2\n", "utf8"), message]))
      .digest();
    for (let offset = 0; offset + 4 <= block.length; offset += 4) {
      const candidate = block.readUInt32BE(offset);
      if (candidate < limit) return { index: candidate % n, rejectionCount };
      rejectionCount += 1;
    }
  }
  throw new Error("did not converge");
}

const H = (byte: string) => `sha256:${byte.repeat(64).slice(0, 64)}` as `sha256:${string}`;

// --- fixed inputs ----------------------------------------------------------

const POOL_INPUT = {
  selection_request_hash: H("11"),
  journey_selection_policy_hash: H("22"),
  selection_randomness_policy_hash: H("33"),
  randomness_source_id: "erl2-development-beacon",
  randomness_source_trust_policy_hash: H("44"),
  selection_role_separation_audit_hash: H("55"),
  ordered_entry_hashes: [H("a1"), H("a2"), H("a3"), H("a4"), H("a5")],
  selector_visible_profile_core_hash: H("66"),
} as const;

const HIDING_INPUT = {
  challenge_manifest_hash: H("c1"),
  persona_script_hash: H("c2"),
  journey_hash: H("c3"),
  ordered_step_commitment_hashes: [H("d1"), H("d2")],
  exposure_epoch: 7,
  opening_nonce_base64: "bm9uY2U=",
} as const;

// --- frozen known-answer vectors (independently computed, then frozen) ------

const KAT = {
  poolRoot: "sha256:08d2fb0ac9ebf10c740c5c978f709551a98ed0cac66dc7db75e10bac9c0195b5",
  hiding: "sha256:a06cfa2fc89c52bed83d961e7764459d4d9dcf96bf186b256e823fae04614cb1",
  sourceBinding: "sha256:b39a8d9efa4bab44ec098a9a4b9d2f87a49af51ed78a8603474e65c7287510f1",
  select5: { index: 4, rejectionCount: 0 },
  select2: { index: 1, rejectionCount: 0 },
  select7: { index: 2, rejectionCount: 0 },
} as const;

test("SELECTION-KAT: the ordered pool root matches its frozen vector and an independent recomputation", () => {
  const reference = refDomainHash("ERL2-POOL-ROOT-V2", POOL_INPUT);
  assert.equal(reference, KAT.poolRoot, "independent reference drifted from the frozen vector");
  assert.equal(poolRootHash(POOL_INPUT), KAT.poolRoot, "production pool root differs from the KAT");
});

test("SELECTION-KAT: the hiding commitment matches its frozen vector and an independent recomputation", () => {
  const reference = refDomainHash("ERL2-POOL-ACTOR-JOURNEY-V1", HIDING_INPUT);
  assert.equal(reference, KAT.hiding);
  assert.equal(hidingCommitment(HIDING_INPUT), KAT.hiding, "production hiding commitment differs from the KAT");
});

test("SELECTION-KAT: the source/request binding matches its frozen vector and an independent recomputation", () => {
  const bindingInput = {
    selection_request_hash: H("11"),
    selection_randomness_policy_hash: H("33"),
    source_id: "erl2-development-beacon",
    source_trust_policy_hash: H("44"),
    pool_root_hash: KAT.poolRoot as `sha256:${string}`,
    pool_manifest_timestamp_checkpoint_hash: H("77"),
  };
  const reference = refDomainHash("ERL2-RANDOMNESS-REQUEST-V1", bindingInput);
  assert.equal(reference, KAT.sourceBinding);
  assert.equal(sourceRequestBindingHash(bindingInput), KAT.sourceBinding, "production binding differs from the KAT");
});

test("SELECTION-KAT: the selected index (and rejection count) matches frozen vectors and an independent replay", () => {
  const output = Buffer.alloc(64, 0x01);
  const nonce = "n".repeat(64);

  for (const [n, expected] of [
    [5, KAT.select5],
    [2, KAT.select2],
  ] as const) {
    const reference = refSelectedIndex(output, nonce, KAT.poolRoot, n);
    assert.deepEqual(reference, expected, `independent replay drifted for n=${String(n)}`);
    const produced = deriveSelectedIndex(output, nonce, KAT.poolRoot as `sha256:${string}`, n);
    assert.deepEqual(
      { index: produced.index, rejectionCount: produced.rejectionCount },
      expected,
      `production selection differs from the KAT for n=${String(n)}`,
    );
    assert.ok(produced.index >= 0 && produced.index < n, "selected index out of range");
  }

  // A second seed / pool root, to catch a formula error the first inputs miss.
  const output2 = Buffer.alloc(64, 0x02);
  const reference7 = refSelectedIndex(output2, "m".repeat(64), H("bb"), 7);
  assert.deepEqual(reference7, KAT.select7);
  const produced7 = deriveSelectedIndex(output2, "m".repeat(64), H("bb"), 7);
  assert.deepEqual({ index: produced7.index, rejectionCount: produced7.rejectionCount }, KAT.select7);
});

test("SELECTION-KAT: the rejection-sampling limit is the largest multiple of n below 2^32", () => {
  // The uniformity property (ADR-ERL2-011): any 32-bit candidate at or above
  // `floor(2^32/n)*n` is rejected.  A wrong limit would bias selection; here the
  // independent replay's rejection accounting must match production's for every
  // vector, and the limit formula is asserted directly.
  for (const n of [2, 3, 5, 6, 7, 100, 4096]) {
    const limit = Math.floor(0x100000000 / n) * n;
    assert.equal(limit % n, 0, "the limit must be a multiple of n");
    assert.ok(0x100000000 - limit < n, "the reject window must be smaller than n (no wasted uniformity)");
  }
});
