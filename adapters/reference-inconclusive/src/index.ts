/**
 * Reference subject: honestly inconclusive.  It abstains where the evidence is
 * genuinely insufficient, discloses every degraded source, and makes no causal
 * claim.  The evaluator must record this as inconclusive-but-valid — never a
 * subject defect and never Lab invalidity.
 *
 * A removable package: core builds, tests and verifies without it.
 */
export { REFERENCE_INCONCLUSIVE_ADAPTER } from "./adapter.js";
export const REFERENCE_INCONCLUSIVE_ADAPTER_ID = "reference-inconclusive";
export const REFERENCE_INCONCLUSIVE_BEHAVIOUR =
  "abstains explicitly where the evidence cannot support a conclusion" as const;
