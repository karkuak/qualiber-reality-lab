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
  mkdirSync,
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

/*
 * 6R follow-up — the *index-skip* escape.
 *
 * `MUT-P1-1` closes the extra the artifact index can parse.  `ArtifactIndex.walk`
 * silently skips every file it cannot index — a name that is not `.json`, bytes
 * `parseStrictJson` refuses, a JSON array, or an object without a `core_hash` —
 * so those never reach `rejected_extra_hashes` and the closure verdict never sees
 * them.  Each case below was reproduced against the shipped CLI as an exit-0
 * `valid` verdict before `verifyRetainedFileAccounting` landed.
 */
const INDEX_SKIP_EXTRAS: readonly (readonly [string, string, string])[] = [
  ["MUT-6R-EXTRA-a", "rogue-no-core-hash.json", JSON.stringify({ schema_version: "rogue/v1", payload: "no core_hash" })],
  ["MUT-6R-EXTRA-b", "rogue-payload.bin", "unaccounted raw bytes"],
  ["MUT-6R-EXTRA-c", "rogue-duplicate-key.json", '{"a":1,"a":2}'],
  ["MUT-6R-EXTRA-d", "rogue-array.json", "[1,2,3]"],
  ["MUT-6R-EXTRA-e", "nested/rogue-nested.bin", "hidden one directory down"],
];

for (const [id, relative, bytes] of INDEX_SKIP_EXTRAS) {
  test(`${id}: an unindexable retained extra (${relative}) invalidates a valid closure`, () => {
    const root = freshCopy();
    const target = path.join(root, "retained", relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    const verify = verifyBundle(root);
    assert.notEqual(verify.exitCode, 0, `${relative} must invalidate the bundle`);
    assert.equal(firstError(verify.body), "GRAPH_CLOSURE_EXTRA_ARTIFACT");
  });
}

test("MUT-6R-EXTRA-f: an orphaned freeze marker is not silently accounted", () => {
  const root = freshCopy();
  writeFileSync(path.join(root, "retained", "not-an-artifact.json.frozen"), "{}");
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0, "a marker with no accounted content file is an extra");
  assert.equal(firstError(verify.body), "GRAPH_CLOSURE_EXTRA_ARTIFACT");
});

test("MUT-6R-EXTRA-g: deleting a required artifact still reports the MISSING role, not its orphan marker", () => {
  // Cause specificity (§11.12): the retained-file accounting must not mask the
  // more fundamental missing-role cause when a content file is removed and its
  // freeze marker is left behind.
  const root = freshCopy();
  rmSync(path.join(root, "retained", "generic-evaluation-index.json"));
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0);
  assert.equal(firstError(verify.body), "GRAPH_CLOSURE_UNREACHABLE_ARTIFACT");
});

test("MUT-6R-EXTRA-h: an unindexable extra also fails an INVALID record closed", () => {
  const goldenInvalid = path.join(repoRoot, "fixtures", "golden", "invalid-run-cancellation");
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-invalid-extra-"));
  cpSync(goldenInvalid, dest, { recursive: true });
  const artifactRoot = path.join(dest, "artifacts");
  writeFileSync(path.join(artifactRoot, "retained", "rogue-payload.bin"), "unaccounted raw bytes");
  const result = erl2([
    "verify-record",
    "--record", path.join(dest, "invalid-record.json"),
    "--lifecycle", path.join(dest, "lifecycle.json"),
    "--artifact-root", artifactRoot,
    "--root-config", path.join(dest, "root-config.json"),
    "--offline",
  ]);
  assert.notEqual(result.exitCode, 0, "verify-record must fail closed on an unaccounted retained file");
  assert.equal(firstError(result.body), "GRAPH_CLOSURE_EXTRA_ARTIFACT");
});

/*
 * 6R follow-up — §6.4 signed-member inventory.
 *
 * `MUT-P2-3` closed the signer inventory.  Every *other* signed member still
 * rode in on hash closure alone: a signature field is excluded from `core_hash`
 * by design, so corrupting one base64 character changes no hash anywhere and the
 * bundle verified `valid`, exit 0.  Reproduced for all five before the fix.
 *
 * The tamper is surgical — same base64 length, so `byte_length` is unchanged —
 * and the referenced-bytes digests are repaired first so the P2-2 layer cannot
 * be what refuses.  Only signature verification can catch these.
 */
const UNVERIFIED_SIGNED_MEMBERS: readonly string[] = [
  "acquisition-source-manifest.json",
  "acquisition-preregistration.json",
  "acquisition-preregistration-verification-receipt.json",
  "adapter-manifest.json",
  "generic-run-policy.json",
];

/** Repairs every declared `file_sha256` for `relative` so only the signature is wrong. */
function repairDigestsFor(root: string, relative: string): void {
  const retained = path.join(root, "retained");
  const bytes = readFileSync(path.join(retained, relative));
  const digest = hashBytes(bytes);
  for (const name of readdirSync(retained)) {
    if (!name.endsWith(".json")) continue;
    const holder = path.join(retained, name);
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(readFileSync(holder, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    let touched = false;
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const record = node as Record<string, unknown>;
      const declared = record["path"] ?? record["logical_path"];
      if (typeof declared === "string" && declared.endsWith(relative) && typeof record["file_sha256"] === "string") {
        record["file_sha256"] = digest;
        if (typeof record["byte_length"] === "number") record["byte_length"] = bytes.byteLength;
        touched = true;
      }
      for (const nested of Object.values(record)) walk(nested);
    };
    walk(value);
    if (!touched) continue;
    delete value["core_hash"];
    value["core_hash"] = coreHash(value);
    overwrite(holder, JSON.stringify(value));
  }
}

for (const member of UNVERIFIED_SIGNED_MEMBERS) {
  test(`MUT-6R-SIGNER: a corrupted signature on ${member} is refused`, () => {
    const root = freshCopy();
    const file = path.join(root, "retained", member);
    const text = readFileSync(file, "utf8");
    const match = /("signature_base64"\s*:\s*")([A-Za-z0-9+/=]+)(")/.exec(text);
    assert.ok(match, `${member} carries a signature`);
    const original = match[2] as string;
    const flipped = (original[0] === "A" ? "B" : "A") + original.slice(1);
    overwrite(file, text.replace(match[0], `${match[1] as string}${flipped}${match[3] as string}`));
    repairDigestsFor(root, member);
    const verify = verifyBundle(root);
    assert.notEqual(verify.exitCode, 0, `an unverified signature on ${member} must not pass`);
    assert.equal(firstError(verify.body), "TRUST_SIGNATURE_INVALID");
  });
}

test("MUT-6R-SIGNER: a signed contract the verifier declares no role for is refused", () => {
  // Fail-closed gate for Slice 6.5: retaining a signed contract this verifier has
  // no authorized-signer rule for must refuse, never wave through.
  const root = freshCopy();
  const body = {
    schema_version: "selection-verification-receipt/v2",
    receipt_id: "rogue-receipt",
    signature: {
      algorithm: "Ed25519",
      key_id: "erl2-dev-selector-ed25519-1",
      signature_base64: "A".repeat(86) + "==",
      signed_hash: `sha256:${"0".repeat(64)}`,
    },
  };
  const rogue = { ...body, core_hash: coreHash(body) };
  writeFileSync(path.join(root, "retained", "rogue-signed.json"), JSON.stringify(rogue));
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0, "an undeclared signed contract must be refused");
  // The retained-file/closure layer sees it as an extra; whichever fires, the
  // bundle must never verify.
  assert.ok(
    ["TRUST_SIGNATURE_INVALID", "GRAPH_CLOSURE_EXTRA_ARTIFACT"].includes(firstError(verify.body)),
    `unexpected code ${firstError(verify.body)}`,
  );
});

test("MUT-6R-SIGNER: verify-record verifies the invalid record's own signed members", () => {
  // An invalid record carries no attestation and no signer inventory, but it does
  // retain five-plus signed members.  None was signature-verified before this
  // pass: `verifyInvalidRecord` accepted `localTrust` and never built a trust
  // evaluator at all.  The run now mirrors its trust policy at preregistration
  // (as the shipped producer always did), so the verifier can authorize them
  // against its own pinned head.
  const goldenInvalid = path.join(repoRoot, "fixtures", "golden", "invalid-run-cancellation");
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-invalid-signer-"));
  cpSync(goldenInvalid, dest, { recursive: true });
  const artifactRoot = path.join(dest, "artifacts");
  const args = [
    "verify-record",
    "--record", path.join(dest, "invalid-record.json"),
    "--lifecycle", path.join(dest, "lifecycle.json"),
    "--artifact-root", artifactRoot,
    "--root-config", path.join(dest, "root-config.json"),
    "--offline",
  ];
  assert.equal(erl2(args).exitCode, 0, "the clean record verifies");

  const file = path.join(artifactRoot, "retained", "adapter-manifest.json");
  const text = readFileSync(file, "utf8");
  const match = /("signature_base64"\s*:\s*")([A-Za-z0-9+/=]+)(")/.exec(text) as RegExpExecArray;
  const original = match[2] as string;
  const flipped = (original[0] === "A" ? "B" : "A") + original.slice(1);
  overwrite(file, text.replace(match[0], `${match[1] as string}${flipped}${match[3] as string}`));
  const tampered = erl2(args);
  assert.notEqual(tampered.exitCode, 0, "an unverified signature in an invalid record must not pass");
  assert.equal(firstError(tampered.body), "TRUST_SIGNATURE_INVALID");
});

test("MUT-6R-SIGNER: removing the mirrored trust policy does not disable record signature checks", () => {
  // Deleting the mirrored policy must not silently turn signature verification
  // off; without an authorizable head the record is refused outright.
  const goldenInvalid = path.join(repoRoot, "fixtures", "golden", "invalid-run-cancellation");
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-invalid-nopolicy-"));
  cpSync(goldenInvalid, dest, { recursive: true });
  const artifactRoot = path.join(dest, "artifacts");
  rmSync(path.join(artifactRoot, "retained", "trust-policy.json"));
  rmSync(path.join(artifactRoot, "retained", "trust-policy.json.frozen"), { force: true });
  const result = erl2([
    "verify-record",
    "--record", path.join(dest, "invalid-record.json"),
    "--lifecycle", path.join(dest, "lifecycle.json"),
    "--artifact-root", artifactRoot,
    "--root-config", path.join(dest, "root-config.json"),
    "--offline",
  ]);
  assert.notEqual(result.exitCode, 0, "a record with no authorizable trust head must be refused");
  assert.equal(firstError(result.body), "TRUST_HEAD_NOT_LOCALLY_PINNED");
});

/*
 * Audit follow-up — core-hash *shadowing*.
 *
 * `signature` / `root_signature` / `wrapper_signature` are excluded from
 * `core_hash` by design, so two retained files can agree on every hashed byte
 * and carry different signatures.  `ArtifactIndex` keyed its enumeration by core
 * hash, and `Map.set` kept whichever file the per-directory `sort()` reached
 * last — a name the attacker chooses.  Forging the signature at a canonical
 * retained path and dropping a pristine byte-copy under a later-sorting name
 * therefore left the forged file accounted for as a retained file and never
 * signature-verified: `erl2 verify` and `erl2 verify-record` both reported
 * exit 0 / `valid`.
 *
 * The fix is that every *completeness* check enumerates retained **files**
 * (`index.retainedFiles()`), never one representative per hash, and that two
 * retained files may not claim the same core hash.
 */

/** Flips one base64 character of the artifact's signature, in place. */
function forgeSignature(file: string): void {
  const text = readFileSync(file, "utf8");
  const match = /("signature_base64"\s*:\s*")([A-Za-z0-9+/=]+)(")/.exec(text);
  assert.ok(match, `${file} carries a signature`);
  const original = match[2] as string;
  const flipped = (original[0] === "A" ? "B" : "A") + original.slice(1);
  overwrite(file, text.replace(match[0], `${match[1] as string}${flipped}${match[3] as string}`));
}

const SHADOWABLE: readonly string[] = [
  "adapter-manifest.json",
  "acquisition-preregistration.json",
  "generic-run-policy.json",
];

for (const member of SHADOWABLE) {
  test(`MUT-6R-SHADOW: a forged signature on ${member} is not hidden by a later-sorting byte-copy`, () => {
    const root = freshCopy();
    const retained = path.join(root, "retained");
    // The pristine copy sorts after the original, so it used to win the
    // core-hash map and be the only one verified.
    cpSync(path.join(retained, member), path.join(retained, `zz-shadow-${member}`));
    forgeSignature(path.join(retained, member));
    const verify = verifyBundle(root);
    assert.notEqual(verify.exitCode, 0, `a shadowed forged signature on ${member} must not verify`);
    assert.equal(firstError(verify.body), "TRUST_SIGNATURE_INVALID");
  });

  test(`MUT-6R-SHADOW: a byte-copy of ${member} outside retained/ does not hide a forged signature`, () => {
    // `verifyRetainedFileAccounting` walks only `retained/`, so a copy parked in
    // a sibling subtree is invisible to it — but it still used to win the
    // core-hash map.  Per-file signature verification is what closes this.
    const root = freshCopy();
    const elsewhere = path.join(root, "subject-output");
    mkdirSync(elsewhere, { recursive: true });
    cpSync(path.join(root, "retained", member), path.join(elsewhere, `zzz-shadow-${member}`));
    forgeSignature(path.join(root, "retained", member));
    const verify = verifyBundle(root);
    assert.notEqual(verify.exitCode, 0, `an out-of-tree shadow of ${member} must not verify`);
    assert.equal(firstError(verify.body), "TRUST_SIGNATURE_INVALID");
  });
}

test("MUT-6R-SHADOW: two retained files claiming the same core hash are refused", () => {
  const root = freshCopy();
  const retained = path.join(root, "retained");
  cpSync(path.join(retained, "generic-run-policy.json"), path.join(retained, "duplicate-policy.json"));
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0, "a duplicated retained artifact is an unaccounted byte-stream");
  assert.equal(firstError(verify.body), "GRAPH_CLOSURE_EXTRA_ARTIFACT");
});

test("MUT-6R-SHADOW: a duplicate carrying its own freeze marker is still refused", () => {
  const root = freshCopy();
  const retained = path.join(root, "retained");
  cpSync(path.join(retained, "journey-result.json"), path.join(retained, "journey-result-2.json"));
  cpSync(path.join(retained, "journey-result.json.frozen"), path.join(retained, "journey-result-2.json.frozen"));
  const verify = verifyBundle(root);
  assert.notEqual(verify.exitCode, 0, "a marker does not make a duplicate accounted");
  assert.equal(firstError(verify.body), "GRAPH_CLOSURE_EXTRA_ARTIFACT");
});

test("MUT-6R-SHADOW: verify-record refuses a shadowed forged signature", () => {
  const goldenInvalid = path.join(repoRoot, "fixtures", "golden", "invalid-run-cancellation");
  const dest = mkdtempSync(path.join(tmpdir(), "erl2-shadow-record-"));
  cpSync(goldenInvalid, dest, { recursive: true });
  const artifactRoot = path.join(dest, "artifacts");
  const retained = path.join(artifactRoot, "retained");
  const args = [
    "verify-record",
    "--record", path.join(dest, "invalid-record.json"),
    "--lifecycle", path.join(dest, "lifecycle.json"),
    "--artifact-root", artifactRoot,
    "--root-config", path.join(dest, "root-config.json"),
    "--offline",
  ];
  assert.equal(erl2(args).exitCode, 0, "the clean record verifies");

  // The invalid record's own mirrored trust root is the highest-value target:
  // shadowing it used to let a forged root signature verify at exit 0.
  cpSync(path.join(retained, "trust-policy.json"), path.join(retained, "zz-shadow-trust-policy.json"));
  forgeSignature(path.join(retained, "trust-policy.json"));
  const tampered = erl2(args);
  assert.notEqual(tampered.exitCode, 0, "a shadowed forged trust root must not verify");
  assert.equal(firstError(tampered.body), "GRAPH_CLOSURE_EXTRA_ARTIFACT");
});
