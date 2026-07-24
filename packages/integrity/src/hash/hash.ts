/**
 * Domain-separated SHA-256, core hashes and tree hashes.
 *
 * Identity rules (design v2 §14):
 *   - `core_hash = SHA256(JCS(core))` where `core` excludes the contract's
 *     declared signature/hash/volatile fields;
 *   - `file_sha256` is over the exact stored bytes;
 *   - `tree_hash = SHA256(JCS(sorted ArtifactRef entries))`;
 *   - every other derived hash is `SHA256(domain || "\n" || JCS(payload))`.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ArtifactRef, Hash } from "@erl2/contracts";
import { AUTHORITY_SIGNATURE_FIELDS, signedSchemaAuthorityFields } from "@erl2/contracts";
import { jcs, jcsBytes } from "../canonical/jcs.js";
import { assertRegisteredDomain, HASH_DOMAINS, type HashDomain, type HmacDomain } from "./domains.js";

export function sha256Hex(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function toHash(hex: string): Hash {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a lowercase sha-256 hex digest: ${hex}`);
  return `sha256:${hex}`;
}

export function hashBytes(bytes: Buffer | Uint8Array): Hash {
  return toHash(sha256Hex(bytes));
}

export function hashHexOf(hash: Hash): string {
  return hash.slice("sha256:".length);
}

export function hashesEqual(a: Hash, b: Hash): boolean {
  const ab = Buffer.from(hashHexOf(a), "hex");
  const bb = Buffer.from(hashHexOf(b), "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * `core_hash` is the identity being computed and is excluded from every core by
 * definition (a value cannot hash itself).  It is not authority-bearing.
 *
 * The authority-bearing signature fields (`signature`, `root_signature`,
 * `wrapper_signature`) are *not* excluded universally — that let an unknown or
 * unlisted closed contract carry an unhashed authority field.  A signature
 * field is excluded from a core only when the record's `schema_version` legally
 * declares it (`signedSchemaAuthorityFields()`, derived from the frozen
 * schemas).  A signature field on a schema version that does not declare it is
 * refused fail-closed (review §11.2).  Frozen bytes are unaffected: every
 * legitimately signed contract already declares its field, so its exclusion is
 * unchanged.
 */
const IDENTITY_EXCLUSION = "core_hash";

/**
 * Presentation timestamps excluded from result cores (design v2 §16.3).  All
 * security timestamps stay inside the core.
 */
const VOLATILE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "pre-selection-journey-result/v1": ["recorded_at"],
  "selected-journey-result/v1": ["recorded_at"],
  "domain-result-evaluated/v1": ["recorded_at"],
  "domain-result-not-applicable/v1": ["recorded_at"],
  "pre-environment-validity-result/v1": ["evaluated_at"],
  "environment-validity-result/v1": ["evaluated_at"],
};

/** Contracts whose core excludes an array of signatures rather than one. */
const SIGNATURE_ARRAY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "threshold-reveal-receipt/v1": ["participant_signatures"],
  "customer-validated-lab-attestation/v1": ["role_signatures"],
};

/** Returns the core projection of a contract object. */
export function coreOf<T extends object>(value: T): Record<string, unknown> {
  const record = { ...(value as Record<string, unknown>) };
  const schemaVersion = typeof record["schema_version"] === "string" ? record["schema_version"] : "";
  // Identity: always excluded, never authority-bearing.
  delete record[IDENTITY_EXCLUSION];
  // Authority-bearing signature fields: excludable only for a schema version
  // that legally declares the field. A signature field present on any other
  // schema version is smuggling an unhashed authority claim and is refused.
  const declared = signedSchemaAuthorityFields().get(schemaVersion);
  for (const field of AUTHORITY_SIGNATURE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    if (declared?.has(field)) {
      delete record[field];
    } else {
      throw new Error(
        `authority-bearing field '${field}' is not declared by schema_version ` +
          `'${schemaVersion || "<none>"}'; refusing to exclude it from the core hash`,
      );
    }
  }
  for (const field of VOLATILE_FIELDS[schemaVersion] ?? []) delete record[field];
  for (const field of SIGNATURE_ARRAY_FIELDS[schemaVersion] ?? []) delete record[field];
  return record;
}

/** `core_hash` for a contract object, ignoring any `core_hash` already present. */
export function coreHash<T extends object>(value: T): Hash {
  return hashBytes(jcsBytes(coreOf(value)));
}

/** Attaches the computed `core_hash` to a contract object. */
export function seal<T extends object>(value: T): T & { core_hash: Hash } {
  return { ...value, core_hash: coreHash(value) };
}

/** Domain-separated hash over a JCS-encoded payload. */
export function domainHash(domain: HashDomain, payload: unknown): Hash {
  assertRegisteredDomain(domain);
  return hashBytes(Buffer.from(`${domain}\n${jcs(payload)}`, "utf8"));
}

/** Domain-separated hash over raw bytes. */
export function domainHashBytes(domain: HashDomain, payload: Buffer): Hash {
  assertRegisteredDomain(domain);
  return hashBytes(Buffer.concat([Buffer.from(`${domain}\n`, "utf8"), payload]));
}

/** Domain-separated HMAC-SHA-256. */
export function domainHmac(domain: HmacDomain, key: Buffer, message: Buffer): Buffer {
  assertRegisteredDomain(domain);
  return createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(`${domain}\n`, "utf8"), message]))
    .digest();
}

/** Deterministic ordering for artifact refs inside a tree hash. */
function sortRefs(entries: readonly ArtifactRef[]): ArtifactRef[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** `tree_hash = SHA256(JCS(sorted ArtifactRef entries))`. */
export function treeHash(entries: readonly ArtifactRef[]): Hash {
  const sorted = sortRefs(entries);
  const seen = new Set<string>();
  for (const entry of sorted) {
    if (seen.has(entry.path)) throw new Error(`duplicate artifact path in tree: ${entry.path}`);
    seen.add(entry.path);
  }
  return hashBytes(jcsBytes(sorted));
}

/** Convenience re-export so callers never reach for a second hash domain table. */
export { HASH_DOMAINS };
