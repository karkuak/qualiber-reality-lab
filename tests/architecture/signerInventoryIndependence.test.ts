/**
 * The producer and the verifier must derive the applicable signed-member set
 * **independently** (ADR-ERL2-030 §5).
 *
 * This is the structural half of the argument ADR-ERL2-024 makes about
 * `lab_validity` and ADR-ERL2-029 §1.1 makes about `complete_for_terminal_chain`:
 * a verifier that agreed with the producer because it *called* the producer would
 * be re-reading a producer field with extra steps. So the two role tables are
 * written separately and this suite asserts three things about them:
 *
 *   1. neither package imports the other's derivation;
 *   2. they nonetheless agree, schema for schema and role for role — a
 *      divergence is a real defect (the producer would inventory a member the
 *      verifier refuses, or omit one it requires) and must fail here rather than
 *      in a golden;
 *   3. the fixture scanner is a third implementation and imports neither.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCER_SIGNED_MEMBER_ROLES } from "@erl2/core";
import { declaredSignedMemberSchemas, signedMemberRuleFor } from "@erl2/public-verifier";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sourceFiles(relative: string): readonly { readonly path: string; readonly text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const child = path.join(dir, name);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!name.endsWith(".ts")) continue;
      out.push({ path: path.relative(repoRoot, child), text: readFileSync(child, "utf8") });
    }
  };
  walk(path.join(repoRoot, relative));
  return out;
}

test("SIGNER-INDEPENDENCE: the verifier never imports the producer's derivation", () => {
  for (const file of sourceFiles("packages/public-verifier/src")) {
    assert.ok(
      !file.text.includes("signerInventoryDerivation"),
      `${file.path} reaches into the producer's signer-inventory derivation; the verifier must derive ` +
        `the applicable set from retained bytes and its own role table`,
    );
    assert.ok(
      !/PRODUCER_SIGNED_MEMBER_ROLES/.test(file.text),
      `${file.path} reads the producer's role table`,
    );
  }
});

test("SIGNER-INDEPENDENCE: the producer never imports the verifier's derivation", () => {
  for (const file of sourceFiles("packages/core/src")) {
    assert.ok(
      !file.text.includes("inventoryCompleteness"),
      `${file.path} reaches into the verifier's completeness derivation`,
    );
    assert.ok(
      !file.text.includes("@erl2/public-verifier"),
      `${file.path} imports the offline verifier; @erl2/core may not depend on it`,
    );
  }
});

test("SIGNER-INDEPENDENCE: the fixture scanner is a third implementation", () => {
  const scanner = readFileSync(path.join(repoRoot, "tests", "support", "signedMemberScan.ts"), "utf8");
  // Imports, not mentions: the file's own comment explains *why* it is separate
  // from the other two derivations, and naming them there is the point.
  const imports = scanner
    .split("\n")
    .filter((line) => line.startsWith("import "))
    .join("\n");
  assert.ok(!imports.includes("@erl2/public-verifier"), "the fixture scanner imports the verifier's derivation");
  assert.ok(!imports.includes("@erl2/core"), "the fixture scanner imports the producer's derivation");
  const fixture = readFileSync(path.join(repoRoot, "tests", "support", "fakeRun.ts"), "utf8");
  assert.ok(
    fixture.includes("scanRetainedSignedMembers"),
    "the fixture must enumerate its own retained signed members rather than hand-writing an inventory",
  );
});

test("SIGNER-INDEPENDENCE: the two role tables agree, schema for schema", () => {
  const verifierSchemas = new Set(declaredSignedMemberSchemas());
  const producerSchemas = new Set(PRODUCER_SIGNED_MEMBER_ROLES.keys());

  const onlyProducer = [...producerSchemas].filter((s) => !verifierSchemas.has(s)).sort();
  const onlyVerifier = [...verifierSchemas].filter((s) => !producerSchemas.has(s)).sort();
  assert.deepEqual(
    onlyProducer,
    [],
    "the producer would inventory a signed contract the verifier refuses outright",
  );
  assert.deepEqual(
    onlyVerifier,
    [],
    "the verifier expects a signed contract the producer cannot classify, so a run retaining one " +
      "would refuse finalization instead of producing evidence",
  );

  for (const schema of [...producerSchemas].sort()) {
    assert.equal(
      PRODUCER_SIGNED_MEMBER_ROLES.get(schema),
      signedMemberRuleFor(schema)?.role,
      `${schema}: the producer and the verifier disagree about which role signs it`,
    );
  }
  // Not a floor that can silently drop: the tables cover the whole signed
  // surface of both terminal branches.
  assert.ok(producerSchemas.size >= 40, `expected the full signed-contract set, found ${producerSchemas.size}`);
});

test("SIGNER-INDEPENDENCE: exactly two contracts are exempt from lifecycle reachability", () => {
  // The exemption is the one place a completeness rule could be widened without
  // looking like a widening, so its membership is pinned by name. Both are bound
  // to the terminal by hash instead: the trust head by the verifier's own pin,
  // the terminal checkpoint by the attestation and the bundle's chain.
  const anchored = declaredSignedMemberSchemas().filter(
    (schema) => signedMemberRuleFor(schema)?.externallyAnchored === true,
  );
  assert.deepEqual(anchored.sort(), ["trust-policy-manifest/v2", "trusted-timestamp-checkpoint/v1"]);
});
