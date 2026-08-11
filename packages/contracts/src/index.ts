/**
 * `@erl2/contracts` — the closed contract surface of the External Reality Lab.
 *
 * This package owns schemas, generated types, runtime validators and the stable
 * refusal-code catalogue.  It depends on nothing else in the workspace, which is
 * what makes the dependency direction `contracts <- integrity <- core` provable.
 */

export * from "../generated/types.js";

import type { AcquisitionPreregistrationV1 } from "../generated/types.js";

/**
 * The subject seam a run is permanently bound to at preregistration
 * (ADR-ERL2-036).
 *
 * Derived from the contract rather than restated, so the enum and the schema
 * cannot drift apart: adding a mode to the schema is the only way to add one
 * here.
 */
export type SubjectExecutionMode = AcquisitionPreregistrationV1["subject_execution_mode"];

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
