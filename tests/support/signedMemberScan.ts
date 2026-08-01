/**
 * A **fixture-owned** scan of the signed artifacts a run actually retained.
 *
 * Deliberately a third implementation, sharing nothing with the producer's
 * `deriveSignedMembers` or the verifier's `deriveExpectedSignedMembers`
 * (ADR-ERL2-030 §5). A fixture that built its inventory by calling the
 * producer's derivation would prove the producer agrees with itself; one that
 * called the verifier's would prove the verifier agrees with itself. Both are
 * the tautology this package exists to remove, one layer further out.
 *
 * What it shares is what the ADR permits: the frozen authority-field constant
 * and canonical hashing.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { AUTHORITY_SIGNATURE_FIELDS, type Hash } from "@erl2/contracts";

export interface ScannedSignedMember {
  readonly logicalPath: string;
  readonly schemaVersion: string;
  readonly coreHash: Hash;
  readonly signatureField: string;
  readonly signerKeyId: string;
  readonly signedHash: Hash;
}

/**
 * Every file beneath `<root>/retained` that carries an authority-bearing
 * signature, in `core_hash` order.
 */
export function scanRetainedSignedMembers(root: string): readonly ScannedSignedMember[] {
  const out: ScannedSignedMember[] = [];
  const walk = (absolute: string, relative: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(absolute);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const child = path.join(absolute, name);
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      if (statSync(child).isDirectory()) {
        walk(child, childRelative);
        continue;
      }
      if (!name.endsWith(".json") || name.endsWith(".frozen")) continue;
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(child, "utf8"));
      } catch {
        continue;
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const schemaVersion = record["schema_version"];
      const coreHash = record["core_hash"];
      if (typeof schemaVersion !== "string" || typeof coreHash !== "string") continue;
      for (const field of AUTHORITY_SIGNATURE_FIELDS) {
        const candidate = record[field];
        if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        const signature = candidate as { key_id?: unknown; signed_hash?: unknown };
        if (typeof signature.key_id !== "string" || typeof signature.signed_hash !== "string") continue;
        out.push({
          logicalPath: childRelative,
          schemaVersion,
          coreHash: coreHash as Hash,
          signatureField: field,
          signerKeyId: signature.key_id,
          signedHash: signature.signed_hash as Hash,
        });
      }
    }
  };
  walk(path.join(root, "retained"), "retained");
  return out.sort((a, b) => a.coreHash.localeCompare(b.coreHash));
}

/**
 * The applicable subset for a terminal variant: everything the scan found,
 * minus the public terminal types the bundle carries and the inventory itself.
 */
export function applicableSignedMembers(
  members: readonly ScannedSignedMember[],
  excludedPublicTerminalTypes: readonly string[],
): readonly ScannedSignedMember[] {
  const excluded = new Set<string>([...excludedPublicTerminalTypes, "signer-inventory/v2"]);
  return members.filter((m) => !excluded.has(m.schemaVersion));
}
