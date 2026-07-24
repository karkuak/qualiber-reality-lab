/**
 * Offline-verifier mutation battery (6R-A, review P1-1 / P2-2 / P2-3 / P2-4).
 *
 * Each case takes a run produced by the shipped CLI, applies exactly one hostile
 * mutation to the retained bytes, and re-runs `erl2 verify` / `erl2 verify-record`
 * in a *fresh process*.  Every mutation must be refused with a specific,
 * verifier-owned code.  If a protection is removed, the matching case fails —
 * these are the regression anchors the review found missing.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreHash, hashBytes } from "@erl2/integrity";
import { erl2, runToValidTerminal, verifyBundle } from "../support/cliRun.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Build one valid terminal once; every mutation runs against a fresh copy.
let baseRoot: string | undefined;
function baseValidRun(): string {
  baseRoot ??= runToValidTerminal("failed").runRoot;
  return baseRoot;
}
function freshCopy(): string {
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-mutcopy-"));
  cpSync(baseValidRun(), dest, { recursive: true });
  return dest;
}

function firstError(body: { errors: { code: string; message: string }[] }): string {
  return body.errors[0]?.code ?? "-";
}

/** Frozen artifacts are read-only; make the copy writable before mutating. */
function overwrite(file: string, bytes: Buffer | string): void {
  chmodSync(file, 0o644);
  writeFileSync(file, bytes);
}

/** Recursively finds the first file whose relative path matches `re`. */
function findFile(root: string, re: RegExp): string | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const name of readdirSync(dir)) {
      const child = path.join(dir, name);
      if (statSync(child).isDirectory()) stack.push(child);
      else if (re.test(path.relative(root, child))) return child;
    }
  }
  return undefined;
}

test("MUT-BASELINE: the unmutated CLI-produced bundle verifies offline", () => {
  const root = freshCopy();
  const verify = verifyBundle(root);
  assert.equal(verify.exitCode, 0, JSON.stringify(verify.body.errors));
  assert.equal((verify.body.data as { verdict: string }).verdict, "valid");
});

test("MUT-P1-1: a self-consistent rogue extra JSON invalidates a valid closure", () => {
  const root = freshCopy();
  const body = { schema_version: "rogue-artifact/v1", run_id: "rogue", note: "unaccounted but self-consistent" };
  const rogue = { ...body, core_hash: coreHash(body) };
  writeFileSync(path.join(root, "retained", "rogue-artifact.json"), JSON.stringify(rogue));
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0, "a rogue extra must invalidate the bundle");
  assert.equal(firstError(verify.body), "GRAPH_CLOSURE_EXTRA_ARTIFACT");
});

test("MUT-P2-2: a one-byte flip of a content-addressed store payload is rejected", () => {
  const root = freshCopy();
  const bin = findFile(root, /package-store\/sha256\/[0-9a-f]{64}\.bin$/);
  assert.ok(bin, "the run retains a content-addressed package payload");
  const bytes = Buffer.from(readFileSync(bin));
  bytes[0] = bytes[0] === 0 ? 1 : (bytes[0] as number) ^ 0x01;
  overwrite(bin, bytes);
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0, "a tampered store payload must be rejected");
  assert.equal(firstError(verify.body), "ARTIFACT_HASH_MISMATCH");
});

test("MUT-P2-2b: truncating a store payload is rejected", () => {
  const root = freshCopy();
  const bin = findFile(root, /package-store\/sha256\/[0-9a-f]{64}\.bin$/) as string;
  const bytes = Buffer.from(readFileSync(bin));
  overwrite(bin, bytes.subarray(0, Math.max(0, bytes.length - 1)));
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "ARTIFACT_HASH_MISMATCH");
});

/**
 * Corrupts a signed member's signature, then repairs the bundle's ArtifactRef
 * `file_sha256` and `core_hash` so the referenced-bytes layer (P2-2) passes and
 * the *signature* verification (P2-3) is what must refuse.  Without this repair
 * the byte-digest check catches the tamper first — which is correct, but it
 * would not prove the signature is independently verified.
 */
function tamperSignedMember(root: string, memberFile: string, bundleKey: string): void {
  const file = path.join(root, "retained", memberFile);
  const member = JSON.parse(readFileSync(file, "utf8")) as { signature: { signature_base64: string } };
  // Flip one base64 character so the signature stays schema-valid (fixed 86+"=="
  // length) but no longer verifies under Ed25519.
  const original = member.signature.signature_base64;
  const flipped = (original[0] === "A" ? "B" : "A") + original.slice(1);
  member.signature.signature_base64 = flipped;
  const newBytes = Buffer.from(JSON.stringify(member));
  overwrite(file, newBytes);

  const bundleFile = path.join(root, "retained", "public-bundle.json");
  const bundle = JSON.parse(readFileSync(bundleFile, "utf8")) as Record<string, unknown> & {
    core_hash?: string;
  };
  const memberRef = bundle[bundleKey] as { artifact: { file_sha256: string; byte_length: number } };
  memberRef.artifact.file_sha256 = hashBytes(newBytes);
  memberRef.artifact.byte_length = newBytes.byteLength;
  delete bundle.core_hash;
  bundle.core_hash = coreHash(bundle);
  overwrite(bundleFile, JSON.stringify(bundle));
}

test("MUT-P2-3: an unverified signer-inventory signature is refused", () => {
  const root = freshCopy();
  tamperSignedMember(root, "signer-inventory.json", "signer_inventory");
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0, "an unverified inventory signature must not pass");
  assert.equal(firstError(verify.body), "TRUST_SIGNATURE_INVALID");
});

test("MUT-P2-3b: an unverified final-attestation signature is refused", () => {
  const root = freshCopy();
  tamperSignedMember(root, "final-attestation.json", "final_attestation");
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "TRUST_SIGNATURE_INVALID");
});

test("MUT: a one-byte flip of a retained JSON artifact is rejected", () => {
  const root = freshCopy();
  const file = path.join(root, "retained", "run-record.json");
  const text = readFileSync(file, "utf8");
  // Flip a digit inside a value so the JSON stays parseable but bytes differ.
  overwrite(file, text.replace(/"run_id":"([0-9a-f])/, (_m, c: string) => `"run_id":"${c === "a" ? "b" : "a"}`));
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "ARTIFACT_HASH_MISMATCH");
});

test("MUT: deleting a required retained artifact is rejected", () => {
  const root = freshCopy();
  rmSync(path.join(root, "retained", "generic-evaluation-index.json"));
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT");
});

test("MUT: verifyReferencedBytes refuses a descriptor path that escapes the root", async () => {
  const { ArtifactIndex, verifyReferencedBytes } = await import("@erl2/public-verifier");
  const { coreHash: ch } = await import("@erl2/integrity");
  const rootDir = mkdtempSync(path.join(tmpdir(), "erl2-escape-"));
  // Plant a secret outside the root; the descriptor tries to reach it.
  const outside = mkdtempSync(path.join(tmpdir(), "erl2-secret-"));
  writeFileSync(path.join(outside, "secret.bin"), "secret");
  const body = {
    schema_version: "descriptor-holder/v1",
    ref: {
      path: "../".repeat(8) + path.basename(outside) + "/secret.bin",
      media_type: "application/octet-stream",
      byte_length: 6,
      file_sha256: `sha256:${"0".repeat(64)}`,
      classification: "INTERNAL",
    },
  };
  writeFileSync(path.join(rootDir, "holder.json"), JSON.stringify({ ...body, core_hash: ch(body) }));
  assert.throws(
    () => verifyReferencedBytes(ArtifactIndex.scan(rootDir)),
    (e: unknown) => (e as { code?: string }).code === "PATH_ESCAPES_ROOT",
    "a traversal path must be refused",
  );
});

test("MUT-P2-4: verify-record fails closed on a rogue extra in an invalid record", () => {
  const goldenInvalid = path.join(repoRoot, "fixtures", "golden", "invalid-run-cancellation");
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-invalid-"));
  cpSync(goldenInvalid, dest, { recursive: true });
  const artifactRoot = path.join(dest, "artifacts");

  const clean = erl2([
    "verify-record",
    "--record", path.join(dest, "invalid-record.json"),
    "--lifecycle", path.join(dest, "lifecycle.json"),
    "--artifact-root", artifactRoot,
    "--root-config", path.join(dest, "root-config.json"),
    "--offline",
  ]);
  assert.equal(clean.exitCode, 0, `clean invalid record should verify: ${JSON.stringify(clean.body.errors)}`);

  const body = { schema_version: "rogue-artifact/v1", run_id: "rogue" };
  const rogue = { ...body, core_hash: coreHash(body) };
  writeFileSync(path.join(artifactRoot, "retained", "rogue-artifact.json"), JSON.stringify(rogue));
  const tampered = erl2([
    "verify-record",
    "--record", path.join(dest, "invalid-record.json"),
    "--lifecycle", path.join(dest, "lifecycle.json"),
    "--artifact-root", artifactRoot,
    "--root-config", path.join(dest, "root-config.json"),
    "--offline",
  ]);
  assert.notEqual(tampered.exitCode, 0, "verify-record must not report ok on an invalid closure");
  assert.equal(firstError(tampered.body), "GRAPH_CLOSURE_EXTRA_ARTIFACT");
});
