/**
 * Signer-inventory completeness, driven through the shipped CLI (ADR-ERL2-030).
 *
 * ## Why these mutations re-sign the chain
 *
 * A raw byte edit to `retained/signer-inventory.json` is refused by the
 * derivation layer — the stored `core_hash` stops matching its canonical bytes —
 * long before any inventory rule runs, so it proves nothing about completeness.
 * `tests/adversarial/offlineVerifierMutations.test.ts` already covers raw tamper
 * and stays separate from this file for exactly that reason.
 *
 * Every case here therefore performs a *semantic* mutation and then rebuilds the
 * chain the way a dishonest producer would have to:
 *
 *     signed-member set → signer inventory → inventory core hash
 *       → final attestation → attestation core hash
 *       → public bundle (+ its member descriptors) → the terminal lifecycle event
 *
 * so the bundle is internally self-consistent, every signature verifies, every
 * declared byte length and digest matches, and the *only* thing wrong with it is
 * the relationship under test. That is what makes the asserted error code
 * evidence: it cannot be produced by a broken hash, an invalidated signature, a
 * schema violation or a missing file.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash, hashBytes, sealSigned } from "@erl2/integrity";
import { erl2, runToValidTerminal, verifyBundle } from "../support/cliRun.js";
import { developmentKeyring } from "../support/keys.js";
import { applicableSignedMembers, scanRetainedSignedMembers } from "../support/signedMemberScan.js";

type Json = Record<string, unknown>;

// One honest terminal, built once; every mutation runs against a fresh copy.
let baseRoot: string | undefined;
function baseValidRun(): string {
  baseRoot ??= runToValidTerminal("failed").runRoot;
  return baseRoot;
}
function freshCopy(): string {
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-invcopy-"));
  cpSync(baseValidRun(), dest, { recursive: true });
  return dest;
}

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, "utf8")) as Json;
}

/** Frozen artifacts are read-only; a mutation copy has to be writable. */
function overwriteJson(file: string, value: unknown): { readonly sha256: string; readonly length: number } {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (existsSync(file)) chmodSync(file, 0o644);
  writeFileSync(file, bytes);
  return { sha256: hashBytes(bytes), length: bytes.byteLength };
}

/** Rewrites the freeze marker beside a content file it no longer describes. */
function rewriteMarker(file: string, descriptor: { sha256: string; length: number }): void {
  const marker = readJson(`${file}.frozen`);
  chmodSync(`${file}.frozen`, 0o644);
  writeFileSync(
    `${file}.frozen`,
    `${JSON.stringify({ ...marker, byte_length: descriptor.length, file_sha256: descriptor.sha256 })}\n`,
  );
}

function firstError(body: { errors: { code: string; message: string }[] }): string {
  return body.errors[0]?.code ?? "-";
}

/**
 * Applies a transform to the inventory's *core* and rebuilds every artifact that
 * commits to it, exactly as the producer would have.
 *
 * `extraRetained` lets a case plant an additional signed artifact under
 * `retained/` before the inventory is derived from it — the shape a producer
 * that added a signed member after inventorying would leave behind.
 */
function resealTerminal(
  root: string,
  transform: (core: Json, context: { readonly root: string }) => Json,
): void {
  const retained = path.join(root, "retained");
  const inventoryPath = path.join(retained, "signer-inventory.json");
  const attestationPath = path.join(retained, "final-attestation.json");
  const bundlePath = path.join(retained, "public-bundle.json");
  const keyring = developmentKeyring();

  const previousInventory = readJson(inventoryPath);
  const previousAttestation = readJson(attestationPath);
  const inventoryCore: Json = { ...previousInventory };
  delete inventoryCore["core_hash"];
  delete inventoryCore["signature"];
  const inventory = sealSigned(transform(inventoryCore, { root }), keyring.finalizer);
  const inventoryDescriptor = overwriteJson(inventoryPath, inventory);
  rewriteMarker(inventoryPath, inventoryDescriptor);

  const attestationCore: Json = { ...previousAttestation };
  delete attestationCore["core_hash"];
  delete attestationCore["signature"];
  attestationCore["signer_inventory_hash"] = inventory.core_hash;
  const attestation = sealSigned(attestationCore, keyring.finalizer);
  const attestationDescriptor = overwriteJson(attestationPath, attestation);
  rewriteMarker(attestationPath, attestationDescriptor);

  const bundle = readJson(bundlePath);
  const rebind = (member: unknown, hash: unknown, descriptor: { sha256: string; length: number }): Json => {
    const m = member as { artifact: Json; artifact_core_hash: unknown };
    return {
      ...m,
      artifact: { ...m.artifact, byte_length: descriptor.length, file_sha256: descriptor.sha256 },
      artifact_core_hash: hash,
    };
  };
  const bundleCore: Json = {
    ...bundle,
    signer_inventory: rebind(bundle["signer_inventory"], inventory.core_hash, inventoryDescriptor),
    final_attestation: rebind(bundle["final_attestation"], attestation.core_hash, attestationDescriptor),
  };
  delete bundleCore["core_hash"];
  const bundleDescriptor = overwriteJson(bundlePath, { ...bundleCore, core_hash: coreHash(bundleCore) });
  rewriteMarker(bundlePath, bundleDescriptor);

  // The terminal lifecycle event names what finalization produced. Leaving it
  // behind would make every case fail as an unresolvable closure role instead of
  // for the relationship under test.
  const events = path.join(root, "events");
  const eventFiles = readdirSync(events)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const eventPath = path.join(events, eventFiles[eventFiles.length - 1] as string);
  const event = readJson(eventPath);
  const produced = (event["produced"] as { artifact_role: string }[]).map((p) =>
    p.artifact_role === "signer-inventory"
      ? { ...p, artifact_core_hash: inventory.core_hash }
      : p.artifact_role === "final-attestation"
        ? { ...p, artifact_core_hash: attestation.core_hash }
        : p,
  );
  const eventCore: Json = { ...event, produced };
  delete eventCore["core_hash"];
  const eventDescriptor = overwriteJson(eventPath, { ...eventCore, core_hash: coreHash(eventCore) });
  rewriteMarker(eventPath, eventDescriptor);
}

/** The applicable members of a run, by the fixture scanner's own enumeration. */
function applicableOf(root: string): ReturnType<typeof applicableSignedMembers> {
  return applicableSignedMembers(scanRetainedSignedMembers(root), [
    "pre-environment-final-lab-attestation/v1",
  ]);
}

function entriesOf(core: Json): Json[] {
  return [...(core["entries"] as Json[])];
}

// ---------------------------------------------------------------------------
// 0. the baseline, and the shape of the harness itself
// ---------------------------------------------------------------------------

test("INV-BASELINE: an honest CLI terminal lists every applicable signed member", () => {
  const root = freshCopy();
  const inventory = readJson(path.join(root, "retained", "signer-inventory.json"));
  const applicable = applicableOf(root);
  assert.equal(applicable.length, 7, "the pre-environment terminal retains seven applicable signed members");
  assert.deepEqual(
    (inventory["entries"] as { artifact_core_hash: string }[]).map((e) => e.artifact_core_hash).sort(),
    applicable.map((m) => m.coreHash).sort(),
  );
  const verify = verifyBundle(root);
  assert.equal(verify.exitCode, 0, JSON.stringify(verify.body.errors));
});

test("INV-HARNESS: re-sealing the chain unchanged still verifies", () => {
  // Without this, every refusal below could be an artefact of the re-signing
  // rather than of the mutation: a harness that always breaks the bundle proves
  // nothing about the rule it claims to exercise.
  const root = freshCopy();
  resealTerminal(root, (core) => core);
  const verify = verifyBundle(root);
  assert.equal(verify.exitCode, 0, JSON.stringify(verify.body.errors));
});

// ---------------------------------------------------------------------------
// 1. missing members
// ---------------------------------------------------------------------------

for (const omitted of [
  "generic-run-policy/v1",
  "trust-policy-manifest/v2",
  "trusted-timestamp-checkpoint/v1",
  "acquisition-preregistration/v1",
] as const) {
  test(`INV-MISSING: an inventory that omits ${omitted} is refused`, () => {
    const root = freshCopy();
    resealTerminal(root, (core) => ({
      ...core,
      entries: entriesOf(core).filter((e) => e["artifact_schema_version"] !== omitted),
    }));
    const verify = verifyBundle(root);
    assert.notEqual(verify.exitCode, 0, `omitting ${omitted} must be refused`);
    assert.equal(firstError(verify.body), "INVENTORY_ENTRY_MISSING");
    assert.match(verify.body.errors[0]?.message ?? "", new RegExp(omitted.replace(/\//g, "\\/")));
  });
}

test("INV-MISSING: a false completeness claim is not a separate rule — it is never read", () => {
  // `complete_for_terminal_chain` is `const: true` in the frozen schema, so the
  // only representable claim is completeness. An inventory that omits a member
  // therefore *always* claims to be complete, and is refused by the derivation
  // rather than by disagreeing with a boolean.
  const root = freshCopy();
  resealTerminal(root, (core) => ({ ...core, entries: entriesOf(core).slice(0, 1) }));
  const inventory = readJson(path.join(root, "retained", "signer-inventory.json"));
  assert.equal(inventory["complete_for_terminal_chain"], true, "the field cannot express anything else");
  assert.equal((inventory["entries"] as unknown[]).length, 1);
  const verify = verifyBundle(root);
  assert.equal(firstError(verify.body), "INVENTORY_ENTRY_MISSING");
  assert.match(verify.body.errors[0]?.message ?? "", /omits 6 of 7/);
});

test("INV-MISSING: a manipulated completeness flag is not representable at all", () => {
  const root = freshCopy();
  resealTerminal(root, (core) => ({ ...core, complete_for_terminal_chain: false }));
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "SCHEMA_VALIDATION_FAILED");
});

// ---------------------------------------------------------------------------
// 2. incorrect members
// ---------------------------------------------------------------------------

test("INV-WRONG: an entry naming a retained artifact that is not an applicable member is refused", () => {
  const root = freshCopy();
  const runRecord = readJson(path.join(root, "retained", "run-record.json"));
  resealTerminal(root, (core) => {
    const entries = entriesOf(core);
    return {
      ...core,
      entries: [
        ...entries.slice(1),
        { ...(entries[0] as Json), artifact_core_hash: runRecord["core_hash"] },
      ],
    };
  });
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "INVENTORY_ENTRY_EXTRA");
});

test("INV-WRONG: an entry whose schema contradicts the artifact is refused", () => {
  const root = freshCopy();
  resealTerminal(root, (core) => {
    const entries = entriesOf(core);
    const target = entries.findIndex((e) => e["artifact_schema_version"] === "generic-run-policy/v1");
    entries[target] = { ...(entries[target] as Json), artifact_schema_version: "comparison-policy/v1" };
    return { ...core, entries };
  });
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "INVENTORY_ENTRY_MISMATCH");
});

test("INV-WRONG: an entry whose key contradicts the artifact is refused", () => {
  const root = freshCopy();
  const keyring = developmentKeyring();
  resealTerminal(root, (core) => {
    const entries = entriesOf(core);
    const target = entries.findIndex((e) => e["artifact_schema_version"] === "generic-run-policy/v1");
    entries[target] = { ...(entries[target] as Json), signer_key_id: keyring.preregistrar.keyId };
    return { ...core, entries };
  });
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "INVENTORY_ENTRY_MISMATCH");
});

test("INV-WRONG: an entry whose signature hash contradicts the artifact is refused", () => {
  const root = freshCopy();
  resealTerminal(root, (core) => {
    const entries = entriesOf(core);
    const target = entries.findIndex((e) => e["artifact_schema_version"] === "generic-run-policy/v1");
    const other = entries.find((e) => e["artifact_schema_version"] === "acquisition-preregistration/v1");
    entries[target] = {
      ...(entries[target] as Json),
      signature_sha256: (other as Json)["artifact_core_hash"],
    };
    return { ...core, entries };
  });
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "INVENTORY_ENTRY_MISMATCH");
});

test("INV-WRONG: the correct key under an unauthorized role is refused", () => {
  // The policy author's contract re-signed by the preregistrar — a key the
  // pinned policy knows, holding a role it does not grant for this contract.
  const root = freshCopy();
  const keyring = developmentKeyring();
  const policyPath = path.join(root, "retained", "generic-run-policy.json");
  const policy = readJson(policyPath);
  const core: Json = { ...policy };
  delete core["core_hash"];
  delete core["signature"];
  const resigned = sealSigned(core, keyring.preregistrar);
  const descriptor = overwriteJson(policyPath, resigned);
  rewriteMarker(policyPath, descriptor);
  resealTerminal(root, (inventoryCore) => {
    const entries = entriesOf(inventoryCore);
    const target = entries.findIndex((e) => e["artifact_schema_version"] === "generic-run-policy/v1");
    entries[target] = { ...(entries[target] as Json), signer_key_id: keyring.preregistrar.keyId };
    return { ...inventoryCore, entries };
  });
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "TRUST_KEY_NOT_AUTHORIZED_FOR_ROLE");
});

test("INV-WRONG: a signed member from another run is refused", () => {
  // A *supporting* signed schema, so the closure's rejected-extra rule cannot be
  // what refuses it: a second timestamp checkpoint is legal shape, and only its
  // run binding gives it away.
  const root = freshCopy();
  const foreign = runToValidTerminal("failed").runRoot;
  const foreignCheckpoint = readJson(path.join(foreign, "retained", "timestamp-checkpoint.json"));
  const planted = path.join(root, "retained", "zz-foreign-checkpoint.json");
  const descriptor = overwriteJson(planted, foreignCheckpoint);
  writeFileSync(
    `${planted}.frozen`,
    `${JSON.stringify({
      byte_length: descriptor.length,
      classification: "INTERNAL",
      file_sha256: descriptor.sha256,
      logical_path: "retained/zz-foreign-checkpoint.json",
      media_type: "application/json",
    })}\n`,
  );
  resealTerminal(root, (core) => core);
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "GRAPH_CLOSURE_TERMINAL_MISMATCH");
  assert.match(verify.body.errors[0]?.message ?? "", /belong to another run/);
});

test("INV-WRONG: a lifecycle-unreachable signed member is refused", () => {
  // A second preregistration verification receipt of this run: a supporting
  // schema (so closure lets it stand), correctly signed, run-bound — and
  // produced by no lifecycle event.
  const root = freshCopy();
  const keyring = developmentKeyring();
  const receipt = readJson(path.join(root, "retained", "acquisition-preregistration-verification-receipt.json"));
  const core: Json = { ...receipt };
  delete core["core_hash"];
  delete core["signature"];
  core["receipt_id"] = `${String(core["receipt_id"])}-shadow`;
  const shadow = sealSigned(core, keyring.preregistrar);
  const planted = path.join(root, "retained", "zz-shadow-receipt.json");
  const descriptor = overwriteJson(planted, shadow);
  writeFileSync(
    `${planted}.frozen`,
    `${JSON.stringify({
      byte_length: descriptor.length,
      classification: "INTERNAL",
      file_sha256: descriptor.sha256,
      logical_path: "retained/zz-shadow-receipt.json",
      media_type: "application/json",
    })}\n`,
  );
  resealTerminal(root, (inventoryCore) => inventoryCore);
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT");
  assert.match(verify.body.errors[0]?.message ?? "", /never reached by the lifecycle/);
});

test("INV-WRONG: a member created after the inventory cutoff cannot be listed", () => {
  // The attestation is sealed *after* the inventory and binds its hash, so an
  // inventory covering it could not exist. The producer refuses to build one and
  // the verifier refuses to read one.
  const root = freshCopy();
  const attestation = readJson(path.join(root, "retained", "final-attestation.json"));
  resealTerminal(root, (core) => ({
    ...core,
    entries: [
      ...entriesOf(core),
      {
        ...(entriesOf(core)[0] as Json),
        artifact_schema_version: "pre-environment-final-lab-attestation/v1",
        artifact_core_hash: attestation["core_hash"],
        signature_sha256: attestation["core_hash"],
        signer_key_id: developmentKeyring().finalizer.keyId,
      },
    ],
  }));
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "INVENTORY_ENTRY_EXTRA");
});

// ---------------------------------------------------------------------------
// 3. set integrity
// ---------------------------------------------------------------------------

test("INV-SET: a duplicated entry is refused", () => {
  const root = freshCopy();
  resealTerminal(root, (core) => {
    const entries = entriesOf(core);
    return { ...core, entries: [...entries, entries[0] as Json] };
  });
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "INVENTORY_ENTRY_EXTRA");
  assert.match(verify.body.errors[0]?.message ?? "", /more than once/);
});

test("INV-SET: an inventory naming another run is refused even when every hash resolves", () => {
  const root = freshCopy();
  const foreign = runToValidTerminal("failed");
  resealTerminal(root, (core) => ({ ...core, run_id: foreign.runId }));
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "GRAPH_CLOSURE_TERMINAL_MISMATCH");
  assert.match(verify.body.errors[0]?.message ?? "", /signer inventory names run/);
});

test("INV-SET: the right count with one member substituted is refused", () => {
  // Count-only bookkeeping would pass this: seven entries in, seven entries out.
  const root = freshCopy();
  const runRecord = readJson(path.join(root, "retained", "run-record.json"));
  resealTerminal(root, (core) => {
    const entries = entriesOf(core);
    entries[3] = { ...(entries[3] as Json), artifact_core_hash: runRecord["core_hash"] };
    return { ...core, entries };
  });
  const inventory = readJson(path.join(root, "retained", "signer-inventory.json"));
  assert.equal((inventory["entries"] as unknown[]).length, 7, "the count is unchanged");
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "INVENTORY_ENTRY_EXTRA");
});

test("INV-SET: the verifier declares its own exclusions rather than reading the inventory's", () => {
  // The excluded list is schema-fixed per variant, so widening it is a schema
  // violation — and the verifier compares against its own list regardless, so a
  // contract change alone could not turn an exclusion into a licence.
  const root = freshCopy();
  resealTerminal(root, (core) => ({
    ...core,
    excluded_public_terminal_types: ["pre-environment-final-lab-attestation/v1", "generic-run-policy/v1"],
  }));
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "SCHEMA_VALIDATION_FAILED");
});

test("INV-SET: entry order is not normative", () => {
  // Stated rather than assumed. The producer sorts by core hash so its output is
  // byte-reproducible; the verifier compares sets, so a reordered inventory that
  // is otherwise correct verifies. A future ordering rule would have to be an
  // accepted decision, not an accident of this test.
  const root = freshCopy();
  resealTerminal(root, (core) => ({ ...core, entries: entriesOf(core).reverse() }));
  const verify = verifyBundle(root);
  assert.equal(verify.exitCode, 0, JSON.stringify(verify.body.errors));
});

// ---------------------------------------------------------------------------
// 4. the invalid branch
// ---------------------------------------------------------------------------

test("INV-INVALID: an invalid record that retains a signer inventory is refused", () => {
  // A signer inventory attests a terminal *chain*, and an invalid record has
  // none. The closure would refuse it as well — it is not one of the invalid
  // branch's supporting schemas — but as an anonymous unaccounted extra; the
  // named cause is what a reader can act on, and the invalid branch has no
  // terminal variant from which to derive an applicable set.
  const root = freshCopy();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const goldenRoot = path.join(repoRoot, "fixtures", "golden", "invalid-run-cancellation");
  const staged = mkdtempSync(path.join(tmpdir(), "erl2-inv-golden-"));
  cpSync(goldenRoot, staged, { recursive: true });
  const inventory = readJson(path.join(root, "retained", "signer-inventory.json"));
  const planted = path.join(staged, "artifacts", "retained", "signer-inventory.json");
  const descriptor = overwriteJson(planted, inventory);
  writeFileSync(
    `${planted}.frozen`,
    `${JSON.stringify({
      byte_length: descriptor.length,
      classification: "INTERNAL",
      file_sha256: descriptor.sha256,
      logical_path: "retained/signer-inventory.json",
      media_type: "application/json",
    })}\n`,
  );
  const verify = erl2([
    "verify-record",
    "--record", path.join(staged, "invalid-record.json"),
    "--lifecycle", path.join(staged, "lifecycle.json"),
    "--artifact-root", path.join(staged, "artifacts"),
    "--root-config", path.join(staged, "root-config.json"),
    "--offline",
  ]);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "INVENTORY_ENTRY_EXTRA");
});
