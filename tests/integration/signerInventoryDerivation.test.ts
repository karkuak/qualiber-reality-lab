/**
 * The producer's signer-inventory derivation, exercised as a pure function
 * (ADR-ERL2-030 §4).
 *
 * These are the cases the old `artifact.value["signature"]` loop could not have
 * passed, and the fail-closed refusals that make "the producer derives
 * completeness" a property rather than a comment. Nothing here builds a run: the
 * derivation takes a retained set and returns a set, so it can be interrogated
 * directly, and the CLI battery in
 * `tests/adversarial/signerInventoryCompleteness.test.ts` then proves the same
 * rules hold end to end.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { Erl2Error, type Hash } from "@erl2/contracts";
import { developmentKey } from "@erl2/integrity";
import {
  assertInventoryCoversDerivation,
  buildPreEnvironmentSignerInventory,
  deriveSignedMembers,
  signerInventoryEntriesFrom,
  type RetainedArtifactView,
} from "@erl2/core";

const PRE_ENVIRONMENT_EXCLUSIONS = ["pre-environment-final-lab-attestation/v1"];
const ENVIRONMENT_EXCLUSIONS = [
  "selection-verification-receipt/v2",
  "environment-final-lab-attestation/v1",
];

/** A syntactically valid Ed25519 signature envelope — 64 raw bytes, base64. */
function signatureOver(hash: Hash, keyId: string, seed = 7): Record<string, unknown> {
  return {
    algorithm: "Ed25519",
    key_id: keyId,
    signed_hash: hash,
    signature_base64: Buffer.alloc(64, seed).toString("base64"),
  };
}

function hashOf(label: string): Hash {
  return `sha256:${createHash("sha256").update(label, "utf8").digest("hex")}` as Hash;
}

function member(
  schemaVersion: string,
  label: string,
  options: {
    readonly field?: "signature" | "root_signature" | "wrapper_signature";
    readonly keyId?: string;
    readonly extra?: Record<string, unknown>;
    readonly signedHash?: Hash;
  } = {},
): RetainedArtifactView {
  const coreHash = hashOf(label);
  const field = options.field ?? "signature";
  return {
    logicalPath: `retained/${label}.json`,
    coreHash,
    schemaVersion,
    value: {
      schema_version: schemaVersion,
      core_hash: coreHash,
      [field]: signatureOver(options.signedHash ?? coreHash, options.keyId ?? "erl2-dev-policy-author-ed25519-1"),
      ...options.extra,
    },
  };
}

function throwsCode(fn: () => unknown, code: string, what: string): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof Erl2Error, `${what}: expected a typed refusal, got ${String(error)}`);
      assert.equal(error.code, code, `${what}: ${error.message}`);
      return true;
    },
    what,
  );
}

// -- 1. every authority field, not just the one named `signature` -------------

test("SIGNER-DERIVE: an ordinary `signature` member is enumerated", () => {
  const derived = deriveSignedMembers({
    retained: [member("generic-run-policy/v1", "policy")],
    excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
  });
  assert.equal(derived.applicableMembers.length, 1);
  assert.equal(derived.applicableMembers[0]?.schemaVersion, "generic-run-policy/v1");
  assert.equal(derived.applicableMembers[0]?.signatureField, "signature");
  assert.equal(derived.applicableMembers[0]?.signerRole, "policy_author");
  assert.equal(derived.completeForTerminalChain, true);
});

test("SIGNER-DERIVE: a `root_signature` member is enumerated — the omission every run had", () => {
  // The mirrored trust policy is retained by *every* run and was missing from
  // every inventory the Lab has ever produced, because the producer read one
  // field name.
  const derived = deriveSignedMembers({
    retained: [
      member("trust-policy-manifest/v2", "trust-policy", {
        field: "root_signature",
        keyId: "erl2-dev-root-ed25519-1",
      }),
    ],
    excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
  });
  assert.equal(derived.applicableMembers.length, 1);
  assert.equal(derived.applicableMembers[0]?.signatureField, "root_signature");
  assert.equal(derived.applicableMembers[0]?.signerRole, "trust_root");
});

test("SIGNER-DERIVE: a `wrapper_signature` member is enumerated — the review's finding", () => {
  const derived = deriveSignedMembers({
    retained: [
      member("external-beacon-randomness-receipt/v1", "beacon-receipt", {
        field: "wrapper_signature",
        keyId: "erl2-dev-wrapper-signer-ed25519-1",
      }),
    ],
    excludedPublicTerminalTypes: ENVIRONMENT_EXCLUSIONS,
  });
  assert.equal(derived.applicableMembers.length, 1);
  assert.equal(derived.applicableMembers[0]?.signatureField, "wrapper_signature");
  assert.equal(derived.applicableMembers[0]?.signerRole, "lab_verifier_association_signer");
});

test("SIGNER-DERIVE: an unsigned retained artifact is not a member", () => {
  const derived = deriveSignedMembers({
    retained: [
      {
        logicalPath: "retained/run-record.json",
        coreHash: hashOf("run-record"),
        schemaVersion: "pre-environment-lab-run-record/v1",
        value: { schema_version: "pre-environment-lab-run-record/v1", core_hash: hashOf("run-record") },
      },
      member("generic-run-policy/v1", "policy"),
    ],
    excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
  });
  assert.equal(derived.retainedSignedMembers.length, 1);
  assert.equal(derived.applicableMembers.length, 1);
});

// -- 2. the acyclic boundary --------------------------------------------------

test("SIGNER-DERIVE: the public terminal types and the inventory itself are excluded, with reasons", () => {
  const derived = deriveSignedMembers({
    retained: [
      member("generic-run-policy/v1", "policy"),
      member("pre-environment-final-lab-attestation/v1", "attestation", {
        keyId: "erl2-dev-finalizer-ed25519-1",
      }),
      member("signer-inventory/v2", "inventory", { keyId: "erl2-dev-finalizer-ed25519-1" }),
    ],
    excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
  });
  assert.equal(derived.retainedSignedMembers.length, 3);
  assert.deepEqual(derived.applicableMembers.map((m) => m.schemaVersion), ["generic-run-policy/v1"]);
  assert.deepEqual(
    [...derived.excludedMembers].map((m) => m.schemaVersion).sort(),
    ["pre-environment-final-lab-attestation/v1", "signer-inventory/v2"],
  );
  const self = derived.excludedMembers.find((m) => m.schemaVersion === "signer-inventory/v2");
  assert.match(self?.reason ?? "", /cannot vouch for itself/);
});

test("SIGNER-DERIVE: the environment branch excludes two public terminal types", () => {
  const derived = deriveSignedMembers({
    retained: [
      member("selection-verification-receipt/v2", "receipt", {
        keyId: "erl2-dev-source-trust-verifier-ed25519-1",
      }),
      member("environment-final-lab-attestation/v1", "attestation", {
        keyId: "erl2-dev-finalizer-ed25519-1",
      }),
      member("exposure-event/v1", "exposure", { keyId: "erl2-dev-vault-authorizer-ed25519-1" }),
    ],
    excludedPublicTerminalTypes: ENVIRONMENT_EXCLUSIONS,
  });
  assert.deepEqual(derived.applicableMembers.map((m) => m.schemaVersion), ["exposure-event/v1"]);
  assert.equal(derived.excludedMembers.length, 2);
});

// -- 3. fail-closed ------------------------------------------------------------

test("SIGNER-DERIVE: a signed contract with no declared producer role refuses", () => {
  // `evaluation-pack-manifest/v1` declares a `signature` in the frozen schemas
  // and is not a terminal-chain member. Retaining one must stop finalization
  // rather than leave it out of an inventory that claims to be complete.
  throwsCode(
    () =>
      deriveSignedMembers({
        retained: [member("evaluation-pack-manifest/v1", "pack", { keyId: "erl2-dev-policy-author-ed25519-1" })],
        excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
      }),
    "TRUST_SIGNATURE_INVALID",
    "an undeclared signed contract",
  );
});

test("SIGNER-DERIVE: an authority field the contract does not declare refuses", () => {
  // Authority comes from the registered contract, never from a property name:
  // `generic-run-policy/v1` declares `signature` and nothing else, so a
  // `root_signature` on it is an unhashed authority claim.
  throwsCode(
    () =>
      deriveSignedMembers({
        retained: [member("generic-run-policy/v1", "policy", { field: "root_signature" })],
        excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
      }),
    "TRUST_SIGNATURE_INVALID",
    "an undeclared authority field",
  );
});

test("SIGNER-DERIVE: two authority fields on one artifact refuse", () => {
  const artifact = member("trust-policy-manifest/v2", "trust-policy", {
    field: "root_signature",
    keyId: "erl2-dev-root-ed25519-1",
  });
  const doubled: RetainedArtifactView = {
    ...artifact,
    value: { ...artifact.value, signature: signatureOver(artifact.coreHash, "erl2-dev-finalizer-ed25519-1") },
  };
  throwsCode(
    () =>
      deriveSignedMembers({
        retained: [doubled],
        excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
      }),
    "TRUST_SIGNATURE_INVALID",
    "two authority fields",
  );
});

test("SIGNER-DERIVE: a signature over a different core hash refuses", () => {
  throwsCode(
    () =>
      deriveSignedMembers({
        retained: [member("generic-run-policy/v1", "policy", { signedHash: hashOf("something-else") })],
        excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
      }),
    "TRUST_SIGNATURE_INVALID",
    "a signature bound to other bytes",
  );
});

test("SIGNER-DERIVE: a malformed signature envelope refuses", () => {
  const artifact = member("generic-run-policy/v1", "policy");
  for (const [what, mutation] of [
    ["a non-Ed25519 algorithm", { algorithm: "RSA" }],
    ["an empty key id", { key_id: "" }],
    ["a short signature", { signature_base64: Buffer.alloc(32, 1).toString("base64") }],
  ] as const) {
    throwsCode(
      () =>
        deriveSignedMembers({
          retained: [
            {
              ...artifact,
              value: {
                ...artifact.value,
                signature: { ...(artifact.value["signature"] as object), ...mutation },
              },
            },
          ],
          excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
        }),
      "TRUST_SIGNATURE_INVALID",
      what,
    );
  }
});

test("SIGNER-DERIVE: two retained files claiming one core hash refuse", () => {
  const first = member("generic-run-policy/v1", "policy");
  const shadow: RetainedArtifactView = { ...first, logicalPath: "retained/zz-policy-copy.json" };
  throwsCode(
    () =>
      deriveSignedMembers({
        retained: [first, shadow],
        excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
      }),
    "INVENTORY_ENTRY_EXTRA",
    "a retained core-hash collision",
  );
});

// -- 4. determinism and projection -------------------------------------------

test("SIGNER-DERIVE: the applicable set is ordered by core hash, not by walk order", () => {
  const a = member("generic-run-policy/v1", "aaa");
  const b = member("acquisition-source-manifest/v1", "bbb");
  const c = member("challenge-manifest/v1", "ccc", { keyId: "erl2-dev-challenge-governor-ed25519-1" });
  const forward = deriveSignedMembers({
    retained: [a, b, c],
    excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
  });
  const reversed = deriveSignedMembers({
    retained: [c, b, a],
    excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
  });
  assert.deepEqual(
    forward.applicableMembers.map((m) => m.coreHash),
    reversed.applicableMembers.map((m) => m.coreHash),
    "the inventory's bytes must not depend on how the retained subtree was named",
  );
  assert.deepEqual(
    [...forward.applicableMembers].map((m) => m.coreHash),
    [...forward.applicableMembers].map((m) => m.coreHash).sort(),
  );
});

test("SIGNER-DERIVE: an empty applicable set is not complete", () => {
  // A terminal that retains only its own attestation and inventory has nothing
  // to be complete *about*; the builders refuse rather than sealing an empty
  // inventory that asserts `complete_for_terminal_chain: true`.
  const derived = deriveSignedMembers({
    retained: [
      member("pre-environment-final-lab-attestation/v1", "attestation", {
        keyId: "erl2-dev-finalizer-ed25519-1",
      }),
    ],
    excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
  });
  assert.equal(derived.applicableMembers.length, 0);
  assert.equal(derived.completeForTerminalChain, false);
});

test("SIGNER-DERIVE: the projection carries the signer and the signed hash the artifact actually has", () => {
  const derived = deriveSignedMembers({
    retained: [member("generic-run-policy/v1", "policy", { keyId: "erl2-dev-policy-author-ed25519-1" })],
    excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
  });
  const entries = signerInventoryEntriesFrom(derived, {
    securityTimestamp: "2026-07-01T00:00:05Z",
    timestampLogId: "erl2-development-log",
    timestampSequence: 0,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.artifactSchemaVersion, "generic-run-policy/v1");
  assert.equal(entries[0]?.artifactCoreHash, hashOf("policy"));
  assert.equal(entries[0]?.signerKeyId, "erl2-dev-policy-author-ed25519-1");
  assert.equal(entries[0]?.signatureSha256, hashOf("policy"));
  assert.equal(entries[0]?.timestampLogId, "erl2-development-log");
});

// -- 5. the finalization gate --------------------------------------------------

test("SIGNER-DERIVE: the builder refuses an inventory the derivation could not certify", () => {
  // `complete_for_terminal_chain` is `const: true` in the frozen schema, so an
  // incomplete inventory is not representable and the only honest move is to
  // refuse to seal one — before any signature exists.
  const derived = deriveSignedMembers({
    retained: [member("generic-run-policy/v1", "policy")],
    excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
  });
  const entries = signerInventoryEntriesFrom(derived, {
    securityTimestamp: "2026-07-01T00:00:05Z",
    timestampLogId: "erl2-development-log",
    timestampSequence: 0,
  });
  const build = (completeForTerminalChain: boolean): unknown =>
    buildPreEnvironmentSignerInventory({
      inventoryId: "inv-derive",
      runId: "01890000-0000-7000-8000-000000000001",
      acquisitionPreregistrationHash: hashOf("prereg"),
      entries,
      completeForTerminalChain,
      inventoriedAt: "2026-07-01T00:00:06Z",
      signingKey: developmentKey("finalizer"),
    });
  const sealed = build(true) as { complete_for_terminal_chain: boolean };
  assert.equal(sealed.complete_for_terminal_chain, true);
  throwsCode(() => build(false), "INVENTORY_ENTRY_MISSING", "an uncertified inventory");

  throwsCode(
    () =>
      buildPreEnvironmentSignerInventory({
        inventoryId: "inv-derive",
        runId: "01890000-0000-7000-8000-000000000001",
        acquisitionPreregistrationHash: hashOf("prereg"),
        entries: [],
        completeForTerminalChain: true,
        inventoriedAt: "2026-07-01T00:00:06Z",
        signingKey: developmentKey("finalizer"),
      }),
    "INVENTORY_ENTRY_MISSING",
    "an empty pre-environment inventory",
  );
});

test("SIGNER-DERIVE: a signed member that appears after the inventory is sealed is refused", () => {
  // The inventory is sealed *before* the finalization gate, so completeness has
  // to be re-established against the tree as it stands afterwards. Without this,
  // "complete" is a statement about a value computed earlier rather than about
  // the bytes that were signed.
  const before = deriveSignedMembers({
    retained: [member("generic-run-policy/v1", "policy")],
    excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
  });
  const entries = signerInventoryEntriesFrom(before, {
    securityTimestamp: "2026-07-01T00:00:05Z",
    timestampLogId: "erl2-development-log",
    timestampSequence: 0,
  });
  assertInventoryCoversDerivation(entries, before);

  const after = deriveSignedMembers({
    retained: [
      member("generic-run-policy/v1", "policy"),
      member("comparison-policy/v1", "late-arrival"),
    ],
    excludedPublicTerminalTypes: PRE_ENVIRONMENT_EXCLUSIONS,
  });
  throwsCode(
    () => assertInventoryCoversDerivation(entries, after),
    "INVENTORY_ENTRY_MISSING",
    "a signed artifact retained after the inventory was sealed",
  );

  // …and the other direction: a sealed entry the retained evidence no longer
  // makes applicable.
  throwsCode(
    () => assertInventoryCoversDerivation(entries, {
      ...before,
      applicableMembers: [],
      completeForTerminalChain: true,
    }),
    "INVENTORY_ENTRY_EXTRA",
    "a sealed entry with nothing applicable behind it",
  );
});
