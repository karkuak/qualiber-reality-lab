/**
 * `@erl2/contracts` — the closed contract surface of the External Reality Lab.
 *
 * This package owns schemas, generated types, runtime validators and the stable
 * refusal-code catalogue.  It depends on nothing else in the workspace, which is
 * what makes the dependency direction `contracts <- integrity <- core` provable.
 */

export * from "../generated/types.js";
export * from "./registry.js";
export * from "./validate.js";
export * from "./errors.js";
export * from "./protocol.js";
export {
  schemaBundlePaths,
  signedSchemaAuthorityFields,
  AUTHORITY_SIGNATURE_FIELDS,
} from "./schemas.js";
export {
  RESERVED_GENERIC_METRIC_IDS,
  RESERVED_GENERIC_METRIC_ID_SET,
} from "./genericMetrics.js";
