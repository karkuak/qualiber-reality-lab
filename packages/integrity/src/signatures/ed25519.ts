/**
 * Ed25519 signing and verification over domain-separated core hashes.
 *
 * A signature always covers `${domain}\n${core_hash}` in ASCII, and the core
 * excludes the signature field itself, so no contract can contain a signature
 * over its own signature.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { CODES, Erl2Error, type Hash, type Signature } from "@erl2/contracts";
import { coreHash } from "../hash/hash.js";
import { assertRegisteredDomain, SIGNATURE_DOMAINS, type SignatureDomain } from "../hash/domains.js";

export interface SigningKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export function signedMessage(domain: SignatureDomain, hash: Hash): Buffer {
  assertRegisteredDomain(domain);
  return Buffer.from(`${domain}\n${hash}`, "ascii");
}

export function signCoreHash(key: SigningKey, domain: SignatureDomain, hash: Hash): Signature {
  return {
    algorithm: "Ed25519",
    key_id: key.keyId,
    signed_hash: hash,
    signature_base64: sign(null, signedMessage(domain, hash), key.privateKey).toString("base64"),
  };
}

/** Seals a contract object (computing its core hash) and signs it. */
export function sealSigned<T extends object>(
  value: T,
  key: SigningKey,
  domain: SignatureDomain = SIGNATURE_DOMAINS.ERL2,
  signatureField: "signature" | "root_signature" | "wrapper_signature" = "signature",
): T & { core_hash: Hash } {
  const hash = coreHash(value);
  const signature = signCoreHash(key, domain, hash);
  return { ...value, core_hash: hash, [signatureField]: signature } as T & { core_hash: Hash };
}

export function verifySignature(
  publicKey: KeyObject,
  domain: SignatureDomain,
  signature: Signature,
): boolean {
  if (signature.algorithm !== "Ed25519") return false;
  let raw: Buffer;
  try {
    raw = Buffer.from(signature.signature_base64, "base64");
  } catch {
    return false;
  }
  if (raw.byteLength !== 64) return false;
  return verify(null, signedMessage(domain, signature.signed_hash), publicKey, raw);
}

/**
 * Verifies that `signature` is a valid Ed25519 signature by `publicKey` over
 * the object's independently recomputed core hash.
 */
export function verifySealed<T extends object>(
  value: T,
  publicKey: KeyObject,
  signature: Signature,
  domain: SignatureDomain = SIGNATURE_DOMAINS.ERL2,
): void {
  const recomputed = coreHash(value);
  const declared = (value as Record<string, unknown>)["core_hash"];
  if (declared !== recomputed) {
    throw new Erl2Error(CODES.ARTIFACT_HASH_MISMATCH, "declared core_hash does not match canonical bytes");
  }
  if (signature.signed_hash !== recomputed) {
    throw new Erl2Error(CODES.TRUST_SIGNATURE_INVALID, "signature covers a different core hash");
  }
  if (!verifySignature(publicKey, domain, signature)) {
    throw new Erl2Error(CODES.TRUST_SIGNATURE_INVALID, `invalid signature by ${signature.key_id}`);
  }
}

/**
 * Signs under an EXTERNAL party's own signing domain.
 *
 * Used only to model a third-party beacon's native proof.  It refuses any ERL2
 * domain, which is the executable half of the beacon/wrapper signing-scope
 * separation (ERL2-FR-038): a foreign signature can never be replayed as a Lab
 * signature, and a Lab signature can never be presented as a beacon proof.
 */
export function signForeignDomain(key: SigningKey, foreignDomain: string, hash: Hash): Signature {
  if ((Object.values(SIGNATURE_DOMAINS) as string[]).includes(foreignDomain)) {
    throw new Erl2Error(
      CODES.BEACON_WRAPPER_SCOPE_CONFUSED,
      `${foreignDomain} is an ERL2 signing domain and may not be used as a foreign domain`,
    );
  }
  return {
    algorithm: "Ed25519",
    key_id: key.keyId,
    signed_hash: hash,
    signature_base64: sign(
      null,
      Buffer.from(`${foreignDomain}\n${hash}`, "ascii"),
      key.privateKey,
    ).toString("base64"),
  };
}

export function publicKeyToPem(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

export function publicKeyFromPem(pem: string): KeyObject {
  return createPublicKey(pem);
}

/**
 * Deterministic development key material.  These keys exist so fixtures and
 * tests are reproducible; they are never production trust anchors and the
 * repository must not contain any other private key.
 */
export function developmentKey(label: string): SigningKey {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(label)) {
    throw new Error(`invalid development key label: ${label}`);
  }
  const seed = createHash("sha256").update(`erl2-development-key:${label}`, "utf8").digest();
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return {
    keyId: `erl2-dev-${label}-ed25519-1`,
    privateKey,
    publicKey: createPublicKey(privateKey),
  };
}
