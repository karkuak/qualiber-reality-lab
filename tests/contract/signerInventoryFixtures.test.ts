/**
 * The regression named for the failure class it belongs to:
 * **a fixture claims a condition it does not contain**.
 *
 * `tests/support/fakeRun.ts` hand-wrote a *one-entry* signer inventory over a run
 * that retains seven applicable signed members, and asserted
 * `complete_for_terminal_chain: true` over it. That is the fourth instance of the
 * class ADR-ERL2-028's handoff §6 names, and it is why a completeness gate could
 * not simply be switched on: the gate would have failed the goldens, which is a
 * rule refusing the fixtures rather than a defect being caught.
 *
 * So this suite measures the shipped goldens rather than trusting them, on the
 * numbers the previous package recorded as open:
 *
 * | golden | retained signed | applicable | listed before | listed now |
 * |---|---|---|---|---|
 * | `valid-pre-environment-run` (fixture-built) | 9 | 7 | **1** | 7 |
 * | `generic-finalization-failed-verification` (CLI) | 9 | 7 | **6** | 7 |
 * | `generic-finalization-unsupported-verification` (CLI) | 9 | 7 | **6** | 7 |
 *
 * The enumeration is the fixture scanner's, deliberately neither the producer's
 * derivation nor the verifier's (ADR-ERL2-030 §5) — a golden checked with the
 * producer's own derivation would prove only that the producer agrees with
 * itself.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applicableSignedMembers, scanRetainedSignedMembers } from "../support/signedMemberScan.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const goldenRoot = path.join(repoRoot, "fixtures", "golden");

/**
 * The two contracts that legitimately have no lifecycle `produced` role: the
 * trust root predates the run, and the terminal checkpoint anchors the run
 * record during finalization. Everything else in an inventory must be reached.
 */
const EXTERNALLY_ANCHORED = new Set(["trust-policy-manifest/v2", "trusted-timestamp-checkpoint/v1"]);

interface Golden {
  readonly name: string;
  readonly artifacts: string;
  readonly lifecycle: readonly { produced?: readonly { artifact_core_hash: string }[] }[];
}

function loadGolden(name: string): Golden {
  const dir = path.join(goldenRoot, name);
  const artifacts = path.join(dir, "artifacts");
  const lifecyclePath = existsSync(path.join(dir, "lifecycle.json"))
    ? path.join(dir, "lifecycle.json")
    : path.join(artifacts, "lifecycle.json");
  return {
    name,
    artifacts,
    lifecycle: JSON.parse(readFileSync(lifecyclePath, "utf8")) as Golden["lifecycle"],
  };
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

const VALID_PRE_ENVIRONMENT_GOLDENS = [
  "valid-pre-environment-run",
  "generic-finalization-failed-verification",
  "generic-finalization-unsupported-verification",
] as const;

for (const name of VALID_PRE_ENVIRONMENT_GOLDENS) {
  test(`SIGNER-FIXTURE: ${name} contains every applicable signed member it claims`, () => {
    const golden = loadGolden(name);
    const inventory = readJson(path.join(golden.artifacts, "retained", "signer-inventory.json")) as {
      entries: { artifact_core_hash: string; artifact_schema_version: string; signer_key_id: string; signature_sha256: string }[];
      excluded_public_terminal_types: string[];
      complete_for_terminal_chain: boolean;
      run_id: string;
    };

    const signed = scanRetainedSignedMembers(golden.artifacts);
    const applicable = applicableSignedMembers(signed, inventory.excluded_public_terminal_types);

    // The measured numbers from the ledger, pinned so a regression that quietly
    // shrinks an inventory shows up as a count and not only as a diff.
    assert.equal(signed.length, 9, `${name}: retained signed members`);
    assert.equal(applicable.length, 7, `${name}: applicable signed members`);
    assert.equal(inventory.entries.length, 7, `${name}: inventory entries`);
    assert.equal(inventory.complete_for_terminal_chain, true);

    // Bijective, by artifact identity — not by count, which one substitution
    // would satisfy.
    assert.deepEqual(
      inventory.entries.map((e) => e.artifact_core_hash).sort(),
      applicable.map((m) => m.coreHash).sort(),
      `${name}: the inventory and the retained applicable set are not the same set`,
    );

    // …and every entry must agree with the artifact it names.
    const byHash = new Map(applicable.map((m) => [m.coreHash as string, m]));
    for (const entry of inventory.entries) {
      const found = byHash.get(entry.artifact_core_hash);
      assert.ok(found, `${name}: entry ${entry.artifact_core_hash} names nothing retained`);
      assert.equal(entry.artifact_schema_version, found.schemaVersion);
      assert.equal(entry.signer_key_id, found.signerKeyId);
      assert.equal(entry.signature_sha256, found.signedHash);
    }

    // Both authority fields other than `signature` are present: this is the
    // review's finding, measured on the shipped bytes.
    const fields = new Set(applicable.map((m) => m.signatureField));
    assert.ok(fields.has("signature"), `${name}: no ordinary signed member`);
    assert.ok(
      fields.has("root_signature"),
      `${name}: the mirrored trust policy is signed under root_signature and must be inventoried`,
    );
  });

  test(`SIGNER-FIXTURE: ${name} reaches every inventoried member it is required to`, () => {
    const golden = loadGolden(name);
    const inventory = readJson(path.join(golden.artifacts, "retained", "signer-inventory.json")) as {
      entries: { artifact_core_hash: string; artifact_schema_version: string }[];
    };
    const reached = new Set<string>();
    for (const event of golden.lifecycle) {
      for (const produced of event.produced ?? []) reached.add(produced.artifact_core_hash);
    }
    const unreached = inventory.entries.filter(
      (entry) => !reached.has(entry.artifact_core_hash) && !EXTERNALLY_ANCHORED.has(entry.artifact_schema_version),
    );
    assert.deepEqual(
      unreached.map((e) => e.artifact_schema_version),
      [],
      `${name}: an inventoried member no lifecycle event produced is the snapshot-only shape the ` +
        `closure refuses everywhere else`,
    );
    // The exemption is not vacuous on these fixtures: both anchored contracts
    // really are retained and really are unreached, so the flag is load-bearing
    // rather than a precaution.
    const anchored = inventory.entries.filter((e) => EXTERNALLY_ANCHORED.has(e.artifact_schema_version));
    assert.equal(anchored.length, 2, `${name}: both externally anchored contracts must be inventoried`);
    for (const entry of anchored) {
      assert.equal(reached.has(entry.artifact_core_hash), false, `${name}: ${entry.artifact_schema_version}`);
    }
  });

  test(`SIGNER-FIXTURE: ${name} binds its inventory into the attestation and the bundle`, () => {
    const golden = loadGolden(name);
    const retained = path.join(golden.artifacts, "retained");
    const inventory = readJson(path.join(retained, "signer-inventory.json"));
    const attestation = readJson(path.join(retained, "final-attestation.json"));
    const bundle = readJson(path.join(retained, "public-bundle.json"));

    assert.equal(
      attestation["signer_inventory_hash"],
      inventory["core_hash"],
      `${name}: the attestation does not cite the retained inventory`,
    );
    const bundleMember = bundle["signer_inventory"] as { artifact_core_hash: string; artifact: { file_sha256: string; byte_length: number } };
    assert.equal(bundleMember.artifact_core_hash, inventory["core_hash"]);
    assert.equal(
      (bundle["final_attestation"] as { artifact_core_hash: string }).artifact_core_hash,
      attestation["core_hash"],
      `${name}: the bundle does not carry the attestation that cites the inventory`,
    );
    // The bundle's member descriptor must describe the retained bytes, so
    // replacing the inventory cannot be hidden by leaving the reference alone.
    const bytes = readFileSync(path.join(retained, "signer-inventory.json"));
    assert.equal(bundleMember.artifact.byte_length, bytes.byteLength);
  });
}

test("SIGNER-FIXTURE: no invalid golden retains a signer inventory", () => {
  // A signer inventory attests a terminal *chain*; an invalid record has none.
  // Enumerated from the directory so a new invalid golden is covered the day it
  // lands, on the same terms as the `evidence:verify` gate.
  const invalid = readdirSync(goldenRoot).filter((n) => n.startsWith("invalid-run-")).sort();
  assert.equal(invalid.length, 3, "the invalid-golden set moved; update this assertion deliberately");
  for (const name of invalid) {
    const scanned = scanRetainedSignedMembers(path.join(goldenRoot, name, "artifacts"));
    assert.deepEqual(
      scanned.filter((m) => m.schemaVersion === "signer-inventory/v2"),
      [],
      `${name} retains a signer inventory`,
    );
    assert.equal(
      existsSync(path.join(goldenRoot, name, "artifacts", "retained", "final-attestation.json")),
      false,
      `${name} retains a final attestation`,
    );
  }
});

test("SIGNER-FIXTURE: the fixture builder no longer hand-writes an inventory", () => {
  // The specific regression. `fakeRun.ts` used to construct `entries: [ … ]` with
  // a single literal object and assert completeness beside it; if that ever comes
  // back, the enumeration above would keep passing only until the fixture's
  // retained set changed, which is exactly how it survived four packages.
  const source = readFileSync(path.join(repoRoot, "tests", "support", "fakeRun.ts"), "utf8");
  const inventoryBlock = source.slice(source.indexOf("const inventoryBase"), source.indexOf("const attestationBase"));
  assert.ok(inventoryBlock.length > 0, "the fixture no longer builds a signer inventory at all");
  assert.ok(
    inventoryBlock.includes("applicable.map"),
    "the fixture's inventory entries must be projected from what it actually retained",
  );
  assert.ok(
    !/artifact_schema_version:\s*"/.test(inventoryBlock),
    "the fixture hand-writes a signer-inventory entry again",
  );
});
