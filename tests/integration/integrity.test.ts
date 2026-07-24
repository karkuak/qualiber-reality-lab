/**
 * CANON, PATH, TAMPER and the artifact freeze protocol.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ArtifactStore,
  CanonicalizationError,
  ageEncrypt,
  ageDecrypt,
  ageRecipientOf,
  coreHash,
  developmentAgeIdentity,
  domainHash,
  HASH_DOMAINS,
  hashBytes,
  jcs,
  registeredDomains,
  resolveConfined,
  treeHash,
  isRegisteredDomain,
} from "@erl2/integrity";

test("CANON: RFC 8785 key ordering, escaping and number rules", () => {
  assert.equal(jcs({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(jcs({ "ä": 1, a: 2 }), '{"a":2,"ä":1}');
  assert.equal(jcs([1, -0, 0.5]), "[1,0,0.5]");
  // Design v2 §16.1 is stricter than RFC 8785 alone: an integral value outside
  // the IEEE-754 safe range is refused rather than canonicalised.
  assert.throws(() => jcs(1e21), CanonicalizationError);
  assert.equal(jcs("line\nbreak\t\"q\""), '"line\\nbreak\\t\\"q\\""');
  assert.throws(() => jcs(Number.NaN), CanonicalizationError);
  assert.throws(() => jcs(Number.POSITIVE_INFINITY), CanonicalizationError);
  assert.throws(() => jcs(2 ** 60), CanonicalizationError);
  assert.throws(() => jcs({ a: undefined }), CanonicalizationError);
  assert.throws(() => jcs("\uD800"), CanonicalizationError);
});

test("CANON: core hashes exclude signatures and declared volatile fields", () => {
  const base = {
    schema_version: "pre-selection-journey-result/v1",
    run_id: "01890000-0000-7000-8000-000000000000",
    recorded_at: "2026-07-01T00:00:00Z",
    value: 1,
  };
  const later = { ...base, recorded_at: "2026-08-01T00:00:00Z" };
  assert.equal(coreHash(base), coreHash(later));

  // A schema version that legally declares `signature` (acquisition-source
  // -manifest/v1) excludes it from its core — the frozen-byte behaviour.
  const signed = { schema_version: "acquisition-source-manifest/v1", value: 1 };
  assert.equal(
    coreHash(signed),
    coreHash({
      ...signed,
      signature: { algorithm: "Ed25519", key_id: "k", signed_hash: "h", signature_base64: "s" },
    }),
  );
});

test("CANON: an unknown closed contract cannot smuggle an unhashed authority field (§11.2)", () => {
  // `x/v1` is not a registered signed schema. Before the fix, the universal
  // exclusion silently dropped `signature` from *every* contract's core, so an
  // unknown contract could carry an authority-bearing signature that the
  // core_hash never covered. It must now be refused fail-closed.
  const smuggled = {
    schema_version: "x/v1",
    value: 1,
    signature: { algorithm: "Ed25519", key_id: "k", signed_hash: "h", signature_base64: "s" },
  };
  assert.throws(
    () => coreHash(smuggled),
    /authority-bearing field 'signature' is not declared by schema_version 'x\/v1'/,
  );
  // The same smuggling refusal applies when the schema version is absent.
  assert.throws(
    () => coreHash({ value: 1, root_signature: { algorithm: "Ed25519" } }),
    /authority-bearing field 'root_signature' is not declared/,
  );
  // Without the authority field, the unknown contract hashes normally (its
  // other fields are all inside the core), so this is a targeted refusal, not a
  // blanket rejection of unknown shapes.
  assert.ok(coreHash({ schema_version: "x/v1", value: 1 }).startsWith("sha256:"));
});

test("CANON: the single JCS path rejects non-NFC strings in keys and values (§11.3)", () => {
  // U+00C5 (Å, NFC) vs U+0041 U+030A (A + combining ring, NFD) are canonically
  // equivalent but distinct code-unit sequences. RFC 8785 does not normalise,
  // so a non-NFC string must be refused at the hash boundary — otherwise a
  // marker/store parse path that skipped validateContract could hash it.
  const nfd = "Å";
  assert.notEqual(nfd.normalize("NFC"), nfd);
  assert.throws(() => jcs(nfd), /not NFC/);
  assert.throws(() => jcs({ label: nfd }), /not NFC/);
  assert.throws(() => jcs({ [nfd]: 1 }), /not NFC/); // non-NFC object key
  assert.throws(() => coreHash({ schema_version: "x/v1", note: nfd }), /not NFC/);
  // The NFC form of the same character hashes fine.
  assert.ok(jcs({ label: "Å" }).length > 0);
});

test("DETERMINISM 6R-D: ageEncrypt is reproducible under an injected seed but random by default", () => {
  const recipient = ageRecipientOf(developmentAgeIdentity("judge"));
  const plaintext = Buffer.from("a judge expectation");
  const seeded = (label: string) => {
    let n = 0;
    return (count: number) => {
      const out = Buffer.alloc(count);
      let w = 0;
      while (w < count) {
        const block = createHash("sha256").update(`${label}:${n}`, "utf8").digest();
        n += 1;
        const take = Math.min(block.length, count - w);
        block.copy(out, w, 0, take);
        w += take;
      }
      return out;
    };
  };
  const a = ageEncrypt(plaintext, [recipient], seeded("s"));
  const b = ageEncrypt(plaintext, [recipient], seeded("s"));
  assert.ok(a.equals(b), "same seed → byte-identical ciphertext (the evidence byte-pin depends on this)");
  // The default CSPRNG path is NOT reproducible (real runs stay secure).
  const c = ageEncrypt(plaintext, [recipient]);
  const d = ageEncrypt(plaintext, [recipient]);
  assert.ok(!c.equals(d), "default random path is not reproducible");
  // The seeded ciphertext still decrypts correctly.
  assert.ok(ageDecrypt(a, developmentAgeIdentity("judge")).equals(plaintext));
});

test("CANON: the separation-domain registry is closed", () => {
  assert.ok(registeredDomains().length >= 15);
  assert.equal(isRegisteredDomain("ERL2-POOL-ROOT-V2"), true);
  assert.equal(isRegisteredDomain("SOME-OTHER-DOMAIN"), false);
  assert.throws(() => domainHash("SOME-OTHER-DOMAIN" as never, {}), /unregistered separation domain/);
});

test("CANON: tree hashes are order-independent and reject duplicate paths", () => {
  const a = {
    path: "a.json",
    media_type: "application/json",
    byte_length: 1,
    file_sha256: `sha256:${"0".repeat(64)}` as const,
    classification: "PUBLIC" as const,
  };
  const b = { ...a, path: "b.json" };
  assert.equal(treeHash([a, b]), treeHash([b, a]));
  assert.throws(() => treeHash([a, a]), /duplicate artifact path/);
});

test("PATH: traversal, absolute paths, symlinks and specials are refused", () => {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-path-"));
  mkdirSync(path.join(root, "sub"), { recursive: true });
  writeFileSync(path.join(root, "sub", "ok.json"), "{}\n");
  symlinkSync(path.join(root, "sub", "ok.json"), path.join(root, "link.json"));

  assert.ok(resolveConfined(root, "sub/ok.json").endsWith("/sub/ok.json"));
  assert.throws(() => resolveConfined(root, "../escape.json"), /PATH_ESCAPES_ROOT|forbidden path component/);
  assert.throws(() => resolveConfined(root, "/absolute.json"), /root-relative/);
  assert.throws(() => resolveConfined(root, "sub/../../escape.json"), /forbidden path component|escapes/);
  assert.throws(() => resolveConfined(root, "link.json"), /symlink rejected/);
  assert.throws(() => resolveConfined(root, "a\\b.json"), /backslash/);
  assert.throws(() => resolveConfined(root, "C:/x.json"), /drive letter|forbidden/);
});

test("ARTIFACT: freeze is idempotent for identical bytes and refuses different bytes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-store-"));
  const store = new ArtifactStore(root);
  const first = store.freezeJson("retained/thing.json", { a: 1 });
  const again = store.freezeJson("retained/thing.json", { a: 1 });
  assert.deepEqual(first, again);
  assert.equal(store.isFrozen("retained/thing.json"), true);
  assert.throws(() => store.freezeJson("retained/thing.json", { a: 2 }), /ARTIFACT_ALREADY_FROZEN|frozen with different bytes/);
  store.verify(first);
});

test("TAMPER: a mutated stored artifact fails reference verification", () => {
  const root = mkdtempSync(path.join(tmpdir(), "erl2-tamper-"));
  const store = new ArtifactStore(root);
  const ref = store.freezeJson("retained/thing.json", { a: 1 });
  const absolute = path.join(root, "retained", "thing.json");
  chmodSync(absolute, 0o600);
  writeFileSync(absolute, '{"a":2}\n');
  assert.throws(() => store.verify(ref), /ARTIFACT_HASH_MISMATCH|digest changed|byte length changed/);
});

test("CANON: hashes are lowercase sha-256 with the documented prefix", () => {
  const digest = hashBytes(Buffer.from("erl2", "utf8"));
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(domainHash(HASH_DOMAINS.TREE, { a: 1 }), domainHash(HASH_DOMAINS.TREE, { a: 1 }));
  assert.notEqual(domainHash(HASH_DOMAINS.TREE, { a: 1 }), domainHash(HASH_DOMAINS.POOL_ROOT, { a: 1 }));
});
