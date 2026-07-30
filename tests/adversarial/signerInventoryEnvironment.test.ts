/**
 * Signer-inventory completeness on the **environment** branch (ADR-ERL2-030).
 *
 * Separate from the pre-environment battery because an environment terminal is
 * ~2 minutes of real CLI work, and because this is where the review's finding was
 * largest: measured before this package, the environment terminal retained **66**
 * signed members, listed **61**, and asserted `complete_for_terminal_chain: true`.
 * The two it omitted were exactly the two whose authority field is not named
 * `signature` — the wrapper-signed beacon association receipt and the mirrored,
 * root-signed trust policy.
 *
 * The resealing chain is the same five steps the pre-environment battery
 * documents; only the acyclic boundary differs, because an environment bundle
 * carries a second public terminal type.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coreHash, hashBytes, sealSigned } from "@erl2/integrity";
import { erl2, runToEnvironmentTerminal, writeLifecycle, writeTrustConfig } from "../support/cliRun.js";
import { developmentKeyring } from "../support/keys.js";
import { applicableSignedMembers, scanRetainedSignedMembers } from "../support/signedMemberScan.js";

type Json = Record<string, unknown>;

const ENVIRONMENT_EXCLUSIONS = [
  "selection-verification-receipt/v2",
  "environment-final-lab-attestation/v1",
];

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, "utf8")) as Json;
}

function overwriteJson(file: string, value: unknown): { readonly sha256: string; readonly length: number } {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (existsSync(file)) chmodSync(file, 0o644);
  writeFileSync(file, bytes);
  return { sha256: hashBytes(bytes), length: bytes.byteLength };
}

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

/** The same chain the pre-environment battery rebuilds, on the environment tree. */
function resealTerminal(root: string, transform: (core: Json) => Json): void {
  const retained = path.join(root, "retained");
  const inventoryPath = path.join(retained, "signer-inventory.json");
  const attestationPath = path.join(retained, "final-attestation.json");
  const bundlePath = path.join(retained, "public-bundle.json");
  const keyring = developmentKeyring();

  const inventoryCore: Json = { ...readJson(inventoryPath) };
  delete inventoryCore["core_hash"];
  delete inventoryCore["signature"];
  const inventory = sealSigned(transform(inventoryCore), keyring.finalizer);
  const inventoryDescriptor = overwriteJson(inventoryPath, inventory);
  rewriteMarker(inventoryPath, inventoryDescriptor);

  const attestationCore: Json = { ...readJson(attestationPath) };
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


// One environment terminal, built once — it is ~2 minutes of real CLI work —
// and copied per case, exactly as the pre-environment battery does.
let environmentRun: ReturnType<typeof runToEnvironmentTerminal> | undefined;
function finalizedEnvironmentRun(): ReturnType<typeof runToEnvironmentTerminal> {
  environmentRun ??= runToEnvironmentTerminal();
  return environmentRun;
}

function freshEnvironmentCopy(): string {
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-envinvcopy-"));
  cpSync(finalizedEnvironmentRun().runRoot, dest, { recursive: true });
  return dest;
}

function verifyEnvironment(root: string): ReturnType<typeof erl2> {
  return erl2([
    "verify",
    "--public-bundle", path.join(root, "retained", "public-bundle.json"),
    "--root-config",
    writeTrustConfig(root, "trust-config.json", {
      sourceTrustPolicyHash: finalizedEnvironmentRun().registry.sourceTrustPolicyHash,
    }),
    "--artifact-root", root,
    "--lifecycle", writeLifecycle(root),
    "--offline",
  ]);
}

test("INV-ENV-BASELINE: an environment terminal lists every applicable signed member", () => {
  const root = freshEnvironmentCopy();
  const inventory = readJson(path.join(root, "retained", "signer-inventory.json"));
  const applicable = applicableSignedMembers(scanRetainedSignedMembers(root), ENVIRONMENT_EXCLUSIONS);
  assert.equal(
    (inventory["entries"] as unknown[]).length,
    applicable.length,
    "the environment inventory and the retained applicable set must be the same size",
  );
  assert.deepEqual(
    (inventory["entries"] as { artifact_core_hash: string }[]).map((e) => e.artifact_core_hash).sort(),
    applicable.map((m) => m.coreHash).sort(),
  );
  // The two the old single-field producer omitted, by name.
  const byField = new Map(applicable.map((m) => [m.schemaVersion, m.signatureField]));
  assert.equal(byField.get("external-beacon-randomness-receipt/v1"), "wrapper_signature");
  assert.equal(byField.get("trust-policy-manifest/v2"), "root_signature");
  const verify = verifyEnvironment(root);
  assert.equal(verify.exitCode, 0, JSON.stringify(verify.body.errors));
});

for (const omitted of [
  "external-beacon-randomness-receipt/v1",
  "trust-policy-manifest/v2",
  "exposure-event/v1",
] as const) {
  test(`INV-ENV-MISSING: an environment inventory that omits ${omitted} is refused`, () => {
    const root = freshEnvironmentCopy();
    resealTerminal(root, (core) => ({
      ...core,
      entries: (core["entries"] as Json[]).filter((e) => e["artifact_schema_version"] !== omitted),
    }));
    const verify = verifyEnvironment(root);
    assert.notEqual(verify.exitCode, 0, `omitting ${omitted} must be refused`);
    assert.equal(firstError(verify.body), "INVENTORY_ENTRY_MISSING");
    assert.match(verify.body.errors[0]?.message ?? "", new RegExp(omitted.replace(/\//g, "\\/")));
  });
}
