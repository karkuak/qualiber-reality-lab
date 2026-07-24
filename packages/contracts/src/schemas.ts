import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.resolve(here, "..", "..", "schemas");

/** Absolute paths of the authored schema bundles, sorted for determinism. */
export function schemaBundlePaths(): readonly string[] {
  return readdirSync(schemaDir)
    .filter((f) => f.endsWith(".schema.json"))
    .sort()
    .map((f) => path.join(schemaDir, f));
}

/**
 * Authority-bearing top-level signature fields.  A contract that carries one of
 * these outside the hashed core is asserting authority the `core_hash` does not
 * cover, so exclusion from the core must be *earned* by a schema that legally
 * declares the field — never applied universally (design v2 §16.3; review
 * §11.2).  `core_hash` itself is the identity being computed, not an authority
 * field, so it is excluded separately and universally.
 */
export const AUTHORITY_SIGNATURE_FIELDS = [
  "signature",
  "root_signature",
  "wrapper_signature",
] as const;

let signedFieldsCache: ReadonlyMap<string, ReadonlySet<string>> | undefined;

/**
 * Derives, directly from the frozen schema bundles, the map of `schema_version`
 * → the set of {@link AUTHORITY_SIGNATURE_FIELDS} that version legally declares
 * as a top-level property.  This is the single source of truth for which
 * contracts may exclude an authority-bearing signature field from their core:
 * an unknown or unlisted closed contract cannot smuggle an unhashed
 * authority-bearing field, because it does not appear here.  Derived (not
 * hand-maintained) so the allowlist can never silently drift from the schemas.
 */
export function signedSchemaAuthorityFields(): ReadonlyMap<string, ReadonlySet<string>> {
  if (signedFieldsCache) return signedFieldsCache;
  const map = new Map<string, Set<string>>();
  for (const p of schemaBundlePaths()) {
    const bundle = JSON.parse(readFileSync(p, "utf8")) as {
      $defs?: Record<string, { properties?: Record<string, { const?: unknown }> }>;
    };
    for (const def of Object.values(bundle.$defs ?? {})) {
      const props = def?.properties;
      if (!props) continue;
      const sv = props["schema_version"]?.const;
      if (typeof sv !== "string") continue;
      for (const field of AUTHORITY_SIGNATURE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(props, field)) {
          const set = map.get(sv) ?? new Set<string>();
          set.add(field);
          map.set(sv, set);
        }
      }
    }
  }
  signedFieldsCache = map;
  return map;
}
