/**
 * `threshold-x25519-envelope/v1` — custody for blind selected-entry payloads.
 *
 * Construction (ADR-ERL2-003/011).  No new cryptographic primitive is invented;
 * the envelope composes audited, standard pieces:
 *
 *   1. the plaintext is ISO 7816-4 padded to one pool-common fixed size, so
 *      every selector-visible ciphertext has identical length
 *      (ERL2-FR-030/AC-034);
 *   2. it is sealed with ChaCha20-Poly1305 under a fresh 32-byte content key,
 *      with the entry handle bound as associated data;
 *   3. the content key is split with Shamir secret sharing over GF(2^8) into
 *      `n` shares with threshold `t`;
 *   4. each share is sealed to one custodian's X25519 public key using
 *      ephemeral-static X25519 + HKDF-SHA-256 + ChaCha20-Poly1305.
 *
 * The selector holds no decryption share, so it cannot open any entry.  Opening
 * requires `t` custodians and produces one receipt per released share.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createHash,
  diffieHellman,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { CODES, Erl2Error } from "@erl2/contracts";
import { HASH_DOMAINS } from "../hash/domains.js";

const CONTENT_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

// ---------------------------------------------------------------------------
// GF(2^8) arithmetic for Shamir secret sharing (AES field, 0x11b).
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x ^= (x << 1) ^ ((x & 0x80) !== 0 ? 0x11b : 0);
    x &= 0xff;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255] as number;
}

function gmul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] as number) + (LOG[b] as number)] as number;
}

function gdiv(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero in GF(2^8)");
  if (a === 0) return 0;
  return EXP[((LOG[a] as number) - (LOG[b] as number) + 255) % 255] as number;
}

export interface ShamirShare {
  /** Evaluation point, 1..255; never 0, which is the secret itself. */
  readonly x: number;
  readonly y: Buffer;
}

export function shamirSplit(secret: Buffer, threshold: number, shares: number): ShamirShare[] {
  if (threshold < 2) throw new Error("threshold must be at least 2");
  if (shares < threshold) throw new Error("share count must be at least the threshold");
  if (shares > 255) throw new Error("at most 255 shares are supported");
  const out: ShamirShare[] = [];
  const coefficients: Buffer[] = [];
  for (let d = 1; d < threshold; d += 1) coefficients.push(randomBytes(secret.length));
  for (let x = 1; x <= shares; x += 1) {
    const y = Buffer.alloc(secret.length);
    for (let byte = 0; byte < secret.length; byte += 1) {
      let acc = secret[byte] as number;
      let power = 1;
      for (let d = 1; d < threshold; d += 1) {
        power = gmul(power, x);
        acc ^= gmul((coefficients[d - 1] as Buffer)[byte] as number, power);
      }
      y[byte] = acc;
    }
    out.push({ x, y });
  }
  return out;
}

export function shamirCombine(shares: readonly ShamirShare[]): Buffer {
  if (shares.length < 2) throw new Error("at least two shares are required");
  const length = (shares[0] as ShamirShare).y.length;
  const xs = shares.map((s) => s.x);
  if (new Set(xs).size !== xs.length) throw new Error("duplicate share index");
  const secret = Buffer.alloc(length);
  for (let byte = 0; byte < length; byte += 1) {
    let acc = 0;
    for (const [i, share] of shares.entries()) {
      let numerator = 1;
      let denominator = 1;
      for (const [j, other] of shares.entries()) {
        if (i === j) continue;
        numerator = gmul(numerator, other.x);
        denominator = gmul(denominator, share.x ^ other.x);
      }
      acc ^= gmul(share.y[byte] as number, gdiv(numerator, denominator));
    }
    secret[byte] = acc;
  }
  return secret;
}

// ---------------------------------------------------------------------------
// ISO 7816-4 padding to a fixed size.
// ---------------------------------------------------------------------------

export function padToFixed(plaintext: Buffer, fixedSize: number): Buffer {
  if (plaintext.length + 1 > fixedSize) {
    throw new Erl2Error(
      CODES.POOL_METADATA_PADDING_INVALID,
      `plaintext of ${String(plaintext.length)} bytes exceeds the fixed padded size ${String(fixedSize)}`,
    );
  }
  const out = Buffer.alloc(fixedSize, 0x00);
  plaintext.copy(out, 0);
  out[plaintext.length] = 0x80;
  return out;
}

export function unpadFixed(padded: Buffer): Buffer {
  for (let i = padded.length - 1; i >= 0; i -= 1) {
    const b = padded[i] as number;
    if (b === 0x80) return padded.subarray(0, i);
    if (b !== 0x00) break;
  }
  throw new Erl2Error(CODES.POOL_METADATA_PADDING_INVALID, "malformed ISO 7816-4 padding");
}

// ---------------------------------------------------------------------------
// Envelope.
// ---------------------------------------------------------------------------

export interface CustodianKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export interface WrappedShare {
  readonly custodian_key_id: string;
  readonly share_index: number;
  readonly ephemeral_public_key_base64: string;
  readonly nonce_base64: string;
  readonly ciphertext_base64: string;
}

export interface ThresholdEnvelopeV1 {
  readonly envelope_version: "threshold-x25519-envelope/v1";
  readonly aead: "chacha20-poly1305";
  readonly padding: "iso7816-4-to-fixed-size";
  readonly padded_plaintext_byte_length: number;
  readonly threshold: number;
  readonly nonce_base64: string;
  readonly ciphertext_base64: string;
  readonly tag_base64: string;
  readonly wrapped_shares: readonly WrappedShare[];
}

function shareKdf(shared: Buffer, custodianKeyId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.from(HASH_DOMAINS.THRESHOLD_SHARE_KDF, "utf8"),
      Buffer.from(custodianKeyId, "utf8"),
      CONTENT_KEY_BYTES,
    ),
  );
}

function aad(associatedHandle: string): Buffer {
  return Buffer.from(`${HASH_DOMAINS.THRESHOLD_ENVELOPE_AAD}\n${associatedHandle}`, "utf8");
}

export function sealThresholdEnvelope(options: {
  readonly plaintext: Buffer;
  readonly paddedSize: number;
  readonly threshold: number;
  readonly custodians: readonly { readonly keyId: string; readonly publicKey: KeyObject }[];
  readonly associatedHandle: string;
}): ThresholdEnvelopeV1 {
  const { plaintext, paddedSize, threshold, custodians, associatedHandle } = options;
  if (custodians.length < threshold) {
    throw new Erl2Error(
      CODES.NON_COLLUSION_THRESHOLD_INSUFFICIENT,
      "fewer custodians than the configured reveal threshold",
    );
  }
  const padded = padToFixed(plaintext, paddedSize);
  const contentKey = randomBytes(CONTENT_KEY_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("chacha20-poly1305", contentKey, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(associatedHandle), { plaintextLength: padded.length });
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  const tag = cipher.getAuthTag();

  const shares = shamirSplit(contentKey, threshold, custodians.length);
  const wrapped: WrappedShare[] = custodians.map((custodian, index) => {
    const share = shares[index] as ShamirShare;
    const ephemeral = generateX25519Ephemeral();
    const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: custodian.publicKey });
    const key = shareKdf(shared, custodian.keyId);
    const shareNonce = randomBytes(NONCE_BYTES);
    const shareCipher = createCipheriv("chacha20-poly1305", key, shareNonce, { authTagLength: TAG_BYTES });
    shareCipher.setAAD(aad(`${associatedHandle}|${custodian.keyId}`), { plaintextLength: share.y.length + 1 });
    const body = Buffer.concat([Buffer.from([share.x]), share.y]);
    const out = Buffer.concat([shareCipher.update(body), shareCipher.final(), shareCipher.getAuthTag()]);
    return {
      custodian_key_id: custodian.keyId,
      share_index: share.x,
      ephemeral_public_key_base64: ephemeral.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
      nonce_base64: shareNonce.toString("base64"),
      ciphertext_base64: out.toString("base64"),
    };
  });

  return {
    envelope_version: "threshold-x25519-envelope/v1",
    aead: "chacha20-poly1305",
    padding: "iso7816-4-to-fixed-size",
    padded_plaintext_byte_length: paddedSize,
    threshold,
    nonce_base64: nonce.toString("base64"),
    ciphertext_base64: ciphertext.toString("base64"),
    tag_base64: tag.toString("base64"),
    wrapped_shares: wrapped,
  };
}

export interface ReleasedShare {
  readonly custodianKeyId: string;
  readonly share: ShamirShare;
}

/** One custodian releases its decryption share. */
export function releaseShare(
  envelope: ThresholdEnvelopeV1,
  custodian: CustodianKey,
  associatedHandle: string,
): ReleasedShare {
  const wrapped = envelope.wrapped_shares.find((w) => w.custodian_key_id === custodian.keyId);
  if (!wrapped) {
    throw new Erl2Error(
      CODES.NON_COLLUSION_THRESHOLD_INSUFFICIENT,
      `custodian ${custodian.keyId} holds no share of this envelope`,
    );
  }
  const ephemeralPublic = createPublicKey({
    key: Buffer.from(wrapped.ephemeral_public_key_base64, "base64"),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({ privateKey: custodian.privateKey, publicKey: ephemeralPublic });
  const key = shareKdf(shared, custodian.keyId);
  const raw = Buffer.from(wrapped.ciphertext_base64, "base64");
  const body = raw.subarray(0, raw.length - TAG_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const decipher = createDecipheriv(
    "chacha20-poly1305",
    key,
    Buffer.from(wrapped.nonce_base64, "base64"),
    { authTagLength: TAG_BYTES },
  );
  decipher.setAAD(aad(`${associatedHandle}|${custodian.keyId}`), { plaintextLength: body.length });
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  return {
    custodianKeyId: custodian.keyId,
    share: { x: plain[0] as number, y: Buffer.from(plain.subarray(1)) },
  };
}

/** Opens the envelope once at least `threshold` shares have been released. */
export function openThresholdEnvelope(
  envelope: ThresholdEnvelopeV1,
  released: readonly ReleasedShare[],
  associatedHandle: string,
): Buffer {
  if (released.length < envelope.threshold) {
    throw new Erl2Error(
      CODES.NON_COLLUSION_THRESHOLD_INSUFFICIENT,
      `${String(released.length)} shares released, threshold is ${String(envelope.threshold)}`,
    );
  }
  const contentKey = shamirCombine(released.slice(0, envelope.threshold).map((r) => r.share));
  const decipher = createDecipheriv(
    "chacha20-poly1305",
    contentKey,
    Buffer.from(envelope.nonce_base64, "base64"),
    { authTagLength: TAG_BYTES },
  );
  const ciphertext = Buffer.from(envelope.ciphertext_base64, "base64");
  decipher.setAAD(aad(associatedHandle), { plaintextLength: ciphertext.length });
  decipher.setAuthTag(Buffer.from(envelope.tag_base64, "base64"));
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return unpadFixed(padded);
}

// ---------------------------------------------------------------------------
// X25519 key material.
// ---------------------------------------------------------------------------

const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

function x25519FromSeed(seed: Buffer): { privateKey: KeyObject; publicKey: KeyObject } {
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

function generateX25519Ephemeral(): { privateKey: KeyObject; publicKey: KeyObject } {
  return x25519FromSeed(randomBytes(32));
}

/**
 * Explicit-format validator for the threshold envelope (review §11.13).
 *
 * The envelope is a **raw AEAD/crypto container** — ChaCha20-Poly1305 ciphertext,
 * ISO 7816-4 padding, GF(2^8) Shamir shares and X25519-wrapped share keys — not
 * an ERL2 *contract*: it carries no `core_hash` or `signature`, its integrity is
 * the AEAD tags, and putting it through `assertContract` would imply
 * contract identity semantics it does not have.  JSON Schema is therefore
 * genuinely inapplicable to its *meaning*.  What matters is that its byte layout
 * is validated fail-closed and in ONE place before any decryption touches it, so
 * this is the single, exhaustively-tested explicit-format parser.  It rejects
 * unknown top-level or per-share fields, non-conforming constants, non-base64
 * blobs, and out-of-range numeric fields, so a malformed envelope fails here
 * rather than deep inside a cipher.
 */
const ENVELOPE_TOP_KEYS = new Set([
  "envelope_version",
  "aead",
  "padding",
  "padded_plaintext_byte_length",
  "threshold",
  "nonce_base64",
  "ciphertext_base64",
  "tag_base64",
  "wrapped_shares",
]);
const WRAPPED_SHARE_KEYS = new Set([
  "custodian_key_id",
  "share_index",
  "ephemeral_public_key_base64",
  "nonce_base64",
  "ciphertext_base64",
]);

function isBase64(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0;
}

function reject(message: string): never {
  throw new Erl2Error(CODES.POOL_METADATA_PADDING_INVALID, `malformed threshold envelope: ${message}`);
}

export function parseEnvelope(bytes: Buffer): ThresholdEnvelopeV1 {
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) reject("not an object");
    value = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Erl2Error) throw error;
    reject("not JSON");
  }
  for (const key of Object.keys(value)) {
    if (!ENVELOPE_TOP_KEYS.has(key)) reject(`unknown field ${key}`);
  }
  if (value["envelope_version"] !== "threshold-x25519-envelope/v1") reject("bad envelope_version");
  if (value["aead"] !== "chacha20-poly1305") reject("bad aead");
  if (value["padding"] !== "iso7816-4-to-fixed-size") reject("bad padding");
  const paddedLen = value["padded_plaintext_byte_length"];
  if (!Number.isSafeInteger(paddedLen) || (paddedLen as number) <= 0) reject("bad padded_plaintext_byte_length");
  const threshold = value["threshold"];
  if (!Number.isSafeInteger(threshold) || (threshold as number) < 2) reject("bad threshold");
  if (!isBase64(value["nonce_base64"])) reject("bad nonce_base64");
  if (!isBase64(value["ciphertext_base64"])) reject("bad ciphertext_base64");
  if (!isBase64(value["tag_base64"])) reject("bad tag_base64");
  const shares = value["wrapped_shares"];
  if (!Array.isArray(shares) || shares.length < (threshold as number)) reject("too few wrapped_shares");
  const seenIndex = new Set<number>();
  const seenCustodian = new Set<string>();
  for (const share of shares) {
    if (share === null || typeof share !== "object" || Array.isArray(share)) reject("share is not an object");
    const s = share as Record<string, unknown>;
    for (const key of Object.keys(s)) {
      if (!WRAPPED_SHARE_KEYS.has(key)) reject(`unknown share field ${key}`);
    }
    if (typeof s["custodian_key_id"] !== "string" || (s["custodian_key_id"] as string).length === 0) {
      reject("bad custodian_key_id");
    }
    const idx = s["share_index"];
    if (!Number.isSafeInteger(idx) || (idx as number) < 1 || (idx as number) > 255) reject("bad share_index");
    if (!isBase64(s["ephemeral_public_key_base64"])) reject("bad ephemeral_public_key_base64");
    if (!isBase64(s["nonce_base64"])) reject("bad share nonce_base64");
    if (!isBase64(s["ciphertext_base64"])) reject("bad share ciphertext_base64");
    if (seenIndex.has(idx as number)) reject("duplicate share_index");
    if (seenCustodian.has(s["custodian_key_id"] as string)) reject("duplicate custodian_key_id");
    seenIndex.add(idx as number);
    seenCustodian.add(s["custodian_key_id"] as string);
  }
  return value as unknown as ThresholdEnvelopeV1;
}

/** Deterministic development custodian; never a production key. */
export function developmentCustodian(label: string): CustodianKey {
  const seed = createHash("sha256").update(`erl2-development-custodian:${label}`, "utf8").digest();
  const { privateKey, publicKey } = x25519FromSeed(seed);
  return { keyId: `erl2-dev-custodian-${label}-x25519-1`, privateKey, publicKey };
}
