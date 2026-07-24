/**
 * Reference subject: plausible but unsupported.  Its claims are well formed and
 * confidently stated, and three of them overreach the evidence — a causal
 * overclaim, a fabricated citation locator and an authority the run policy does
 * not grant.  It exists so the generic evaluator's discrimination can be proven
 * rather than asserted.
 *
 * A removable package: core builds, tests and verifies without it.
 */
export { REFERENCE_MISLEADING_ADAPTER } from "./adapter.js";
export const REFERENCE_MISLEADING_ADAPTER_ID = "reference-misleading";
export const REFERENCE_MISLEADING_BEHAVIOUR =
  "states plausible conclusions the evidence does not support" as const;
