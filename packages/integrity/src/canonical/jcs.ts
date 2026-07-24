/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * This is the ONE canonicalization implementation in the workspace
 * (implementation plan §5 rule 3).  No other package may serialize a contract
 * for hashing or signing.
 *
 * Documented numeric restrictions (design v2 §16.1):
 *   - `NaN`, `Infinity` and `-Infinity` are rejected;
 *   - integers outside the IEEE-754 safe range are rejected, so a canonical
 *     form can never depend on a lossy round-trip;
 *   - `-0` canonicalizes to `0`, matching the ECMAScript number-to-string
 *     algorithm RFC 8785 mandates.
 *
 * ERL2 precondition BEYOND RFC 8785 (design v2 §16.1, "input strings are NFC
 * before validation"): RFC 8785 does **not** perform Unicode normalisation, so
 * this canonicalizer does not claim to.  Instead every string (object key or
 * value) is required to already be in NFC and a non-NFC string is *rejected*
 * (never silently normalised — normalisation would mask a hash-identity
 * mismatch).  Because this is the single serialization path for every hash,
 * signature and verification in the workspace (implementation plan §5 rule 3),
 * putting the check here means no hashing/verification entrypoint can hash a
 * non-NFC string even if it bypassed `validateContract` — closing the
 * store/marker parse gap (review §11.3).  Every already-frozen string is NFC,
 * so this rejects only new non-conforming input and changes no frozen bytes.
 */

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function canonicalString(value: string): string {
  // ERL2 precondition beyond RFC 8785: strings must already be NFC. A non-NFC
  // string is rejected fail-closed so it can never enter a hash or signature.
  // (Lone surrogates, which have no NFC form, are caught by the surrogate
  // checks in the loop below.)
  if (value.normalize("NFC") !== value) {
    throw new CanonicalizationError("string is not NFC");
  }
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charAt(i);
    const code = value.charCodeAt(i);
    const escape = ESCAPES[ch];
    if (escape !== undefined) {
      out += escape;
      continue;
    }
    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalizationError("unpaired high surrogate in string");
      }
      out += ch + value.charAt(i + 1);
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalizationError("unpaired low surrogate in string");
    }
    out += ch;
  }
  return `${out}"`;
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(`non-finite number rejected: ${String(value)}`);
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new CanonicalizationError(`integer outside the safe range rejected: ${String(value)}`);
  }
  if (Object.is(value, -0)) return "0";
  // JSON.stringify implements the ECMAScript Number::toString algorithm that
  // RFC 8785 §3.2.2.3 requires.
  return JSON.stringify(value) as string;
}

function canonicalize(value: unknown, depth: number): string {
  if (depth > 64) throw new CanonicalizationError("maximum canonicalization depth exceeded");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalNumber(value);
    case "string":
      return canonicalString(value);
    case "bigint":
      throw new CanonicalizationError("bigint is not a canonical JSON value");
    case "undefined":
      throw new CanonicalizationError("undefined is not a canonical JSON value");
    case "function":
    case "symbol":
      throw new CanonicalizationError(`${typeof value} is not a canonical JSON value`);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v, depth + 1)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  for (const key of keys) {
    if (record[key] === undefined) {
      throw new CanonicalizationError(`property ${key} is undefined; omit it instead`);
    }
  }
  // RFC 8785 §3.2.3: sort by UTF-16 code unit, which is the default
  // Array#sort ordering for strings.
  keys.sort();
  const members = keys.map((key) => `${canonicalString(key)}:${canonicalize(record[key], depth + 1)}`);
  return `{${members.join(",")}}`;
}

/** Canonical JSON text for `value`. */
export function jcs(value: unknown): string {
  return canonicalize(value, 0);
}

/** Canonical JSON bytes (UTF-8) for `value`. */
export function jcsBytes(value: unknown): Buffer {
  return Buffer.from(jcs(value), "utf8");
}
