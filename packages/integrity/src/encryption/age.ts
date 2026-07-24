/**
 * age v1 encryption, X25519 recipients only.
 *
 * `JourneyStepCommitmentV1.encryption` is the literal `"age-x25519"`, so the
 * judge expectation ciphertext must be a real age file — not a Lab-invented
 * container. This is an implementation of the published age v1 format against
 * audited primitives (X25519, HKDF-SHA-256, ChaCha20-Poly1305, HMAC-SHA-256);
 * no construction is invented here.
 *
 * Format:
 *
 * ```text
 * age-encryption.org/v1
 * -> X25519 <ephemeral share, b64 unpadded>
 * <wrapped file key, b64 unpadded>
 * --- <header MAC, b64 unpadded>
 * <16-byte payload nonce><STREAM ChaCha20-Poly1305 chunks>
 * ```
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createHash,
  diffieHellman,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

const FILE_KEY_BYTES = 16;
const TAG_BYTES = 16;
const CHUNK_BYTES = 65536;
const HEADER_INTRO = "age-encryption.org/v1";
const X25519_LABEL = "age-encryption.org/v1/X25519";
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export class AgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgeError";
  }
}

export interface AgeRecipient {
  readonly keyId: string;
  readonly publicKey: KeyObject;
}

export interface AgeIdentity {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

const b64 = (b: Buffer): string => b.toString("base64").replace(/=+$/, "");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64");

function rawX25519(key: KeyObject): Buffer {
  // The final 32 bytes of the SPKI DER encoding are the raw public key.
  const der = key.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32));
}

function hkdf(ikm: Buffer, salt: Buffer, info: string, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), length));
}

function aead(key: Buffer, nonce: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG_BYTES });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function unaead(key: Buffer, nonce: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) throw new AgeError("ciphertext shorter than its tag");
  const body = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** STREAM nonce: 11-byte big-endian counter followed by the last-chunk flag. */
function streamNonce(counter: number, last: boolean): Buffer {
  const nonce = Buffer.alloc(12, 0);
  nonce.writeUInt32BE(counter, 7);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

function ephemeralKeyPair(seed: Buffer): { privateKey: KeyObject; publicKey: KeyObject } {
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

/** Deterministic development age identity; never a production key. */
export function developmentAgeIdentity(label: string): AgeIdentity {
  const seed = createHash("sha256").update(`erl2-development-age:${label}`, "utf8").digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return {
    keyId: `erl2-dev-age-${label}-x25519-1`,
    privateKey,
    publicKey: createPublicKey(privateKey),
  };
}

export function ageRecipientOf(identity: AgeIdentity): AgeRecipient {
  return { keyId: identity.keyId, publicKey: identity.publicKey };
}

/**
 * Encrypts `plaintext` to one or more X25519 recipients.
 *
 * `random` is the source of the file key, the per-recipient ephemeral private
 * keys and the payload nonce.  It defaults to the CSPRNG (`randomBytes`), which
 * is what every real run uses.  A *fixture/evidence* build may inject a seeded
 * RNG so the ciphertext — and therefore the commitment hash that covers its
 * digest — is byte-reproducible (review 6R-D); this is the ONLY reason a
 * non-CSPRNG source is ever passed, and it never touches held-out selection.
 */
export function ageEncrypt(
  plaintext: Buffer,
  recipients: readonly AgeRecipient[],
  random: (n: number) => Buffer = randomBytes,
): Buffer {
  if (recipients.length === 0) throw new AgeError("at least one recipient is required");
  const fileKey = random(FILE_KEY_BYTES);

  const stanzas = recipients.map((recipient) => {
    const ephemeral = ephemeralKeyPair(random(32));
    const share = rawX25519(ephemeral.publicKey);
    const recipientRaw = rawX25519(recipient.publicKey);
    const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient.publicKey });
    const wrapKey = hkdf(shared, Buffer.concat([share, recipientRaw]), X25519_LABEL, 32);
    const wrapped = aead(wrapKey, Buffer.alloc(12, 0), fileKey);
    return `-> X25519 ${b64(share)}\n${b64(wrapped)}`;
  });

  const headerWithoutMac = `${HEADER_INTRO}\n${stanzas.join("\n")}\n---`;
  const macKey = hkdf(fileKey, Buffer.alloc(0), "header", 32);
  const mac = createHmac("sha256", macKey).update(headerWithoutMac, "utf8").digest();
  const header = `${headerWithoutMac} ${b64(mac)}\n`;

  const payloadNonce = random(16);
  const payloadKey = hkdf(fileKey, payloadNonce, "payload", 32);
  const chunks: Buffer[] = [];
  if (plaintext.length === 0) {
    chunks.push(aead(payloadKey, streamNonce(0, true), Buffer.alloc(0)));
  } else {
    const total = Math.ceil(plaintext.length / CHUNK_BYTES);
    for (let i = 0; i < total; i += 1) {
      const slice = plaintext.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      chunks.push(aead(payloadKey, streamNonce(i, i === total - 1), slice));
    }
  }

  return Buffer.concat([Buffer.from(header, "utf8"), payloadNonce, ...chunks]);
}

/** Decrypts an age file with one identity. */
export function ageDecrypt(file: Buffer, identity: AgeIdentity): Buffer {
  const separator = file.indexOf(Buffer.from("---", "utf8"));
  if (separator < 0) throw new AgeError("no age header separator");
  const macEnd = file.indexOf(0x0a, separator);
  if (macEnd < 0) throw new AgeError("truncated age header");

  const headerWithoutMac = file.subarray(0, separator + 3).toString("utf8");
  const macLine = file.subarray(separator + 3, macEnd).toString("utf8").trim();
  const lines = headerWithoutMac.split("\n");
  if (lines[0] !== HEADER_INTRO) throw new AgeError(`unexpected age intro: ${String(lines[0])}`);

  const recipientRaw = rawX25519(identity.publicKey);
  let fileKey: Buffer | undefined;
  for (let i = 1; i < lines.length - 1; i += 2) {
    const stanza = (lines[i] ?? "").split(" ");
    if (stanza[0] !== "->" || stanza[1] !== "X25519") continue;
    const share = unb64(stanza[2] ?? "");
    const wrapped = unb64(lines[i + 1] ?? "");
    const ephemeralPublic = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), share]),
      format: "der",
      type: "spki",
    });
    const shared = diffieHellman({ privateKey: identity.privateKey, publicKey: ephemeralPublic });
    const wrapKey = hkdf(shared, Buffer.concat([share, recipientRaw]), X25519_LABEL, 32);
    try {
      fileKey = unaead(wrapKey, Buffer.alloc(12, 0), wrapped);
      break;
    } catch {
      // Not our stanza; age files carry one stanza per recipient.
    }
  }
  if (!fileKey) throw new AgeError("no age stanza decrypts for this identity");

  const macKey = hkdf(fileKey, Buffer.alloc(0), "header", 32);
  const expected = createHmac("sha256", macKey).update(headerWithoutMac, "utf8").digest();
  const presented = unb64(macLine);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw new AgeError("age header MAC does not verify");
  }

  const body = file.subarray(macEnd + 1);
  const payloadNonce = body.subarray(0, 16);
  const key = hkdf(fileKey, payloadNonce, "payload", 32);
  const sealed = body.subarray(16);
  const sealedChunk = CHUNK_BYTES + TAG_BYTES;
  const out: Buffer[] = [];
  let offset = 0;
  let counter = 0;
  while (offset < sealed.length) {
    const remaining = sealed.length - offset;
    const take = Math.min(sealedChunk, remaining);
    const last = offset + take >= sealed.length;
    out.push(unaead(key, streamNonce(counter, last), sealed.subarray(offset, offset + take)));
    offset += take;
    counter += 1;
  }
  return Buffer.concat(out);
}
