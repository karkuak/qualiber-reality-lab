/**
 * `@erl2/adapter-sdk` — the subject-adapter protocol surface.
 *
 * This package may depend on `@erl2/contracts` only.  It must never reach
 * truth, judge expectations, selection openings, Lab validity, generic metric
 * thresholds, the finalizer, or an arbitrary shell.  `FORBIDDEN_SDK_SURFACE`
 * below is the executable statement of that boundary and
 * `tests/architecture/adapterSurface.test.ts` enforces it against the real
 * export list and import graph.
 */

export {
  assertRequestAncestry,
  assertOperationMatchesPhase,
  assertExecutionPlan,
  assertNoOracleCanary,
  assertNoOracleFields,
  assertLocalObservationRequestV2,
  phaseOfRequest,
  ORACLE_CANARY_PATTERN,
  SECRET_CANARY_PATTERN,
  FORBIDDEN_REQUEST_FIELDS,
  PHASE_REQUEST_SCHEMA,
  type AdapterRequestV1,
  type AdapterRequest,
  type AdapterRequestPhase,
} from "./ancestry.js";

export {
  runAdapter,
  main,
  checkPackageKind,
  type AdapterDefinition,
  type AdapterHandler,
  type AdapterOperationContext,
  type AdapterOperationOutcome,
  type RunAdapterStreams,
} from "./sdk.js";

export {
  buildTranslationReceipt,
  type CanonicalEnvelopeView,
  type TranslationDisposition,
  type TranslationMappingDraft,
  type TranslationReceiptDraft,
} from "./translation.js";

/**
 * Capabilities the SDK deliberately does not offer.
 *
 * Each entry names an authority that belongs to core, the judge or the
 * evaluator. The architecture test asserts that no exported symbol matches any
 * of these, so adding one is a visible, reviewable act rather than a quiet
 * convenience.
 */
export const FORBIDDEN_SDK_SURFACE = [
  "selectChallenge",
  "challengePool",
  "poolHandle",
  "eligibilityPool",
  "revealTruth",
  "readTruth",
  "judgeExpectation",
  "successPredicate",
  "writeCanonicalEvidence",
  "mutateCanonicalEvidence",
  "setValidity",
  "assertValidity",
  "setThreshold",
  "setMetricThreshold",
  "exec",
  "spawn",
  "shell",
  "runCommand",
  "finalize",
  "attest",
  "signAttestation",
  "publishBundle",
  "executeAfterReveal",
] as const;

/** Node built-ins the adapter SDK may never import (ERL2-SEC-001). */
export const FORBIDDEN_SDK_IMPORTS = [
  "node:child_process",
  "node:cluster",
  "node:dgram",
  "node:dns",
  "node:http",
  "node:http2",
  "node:https",
  "node:net",
  "node:repl",
  "node:tls",
  "node:vm",
  "node:worker_threads",
] as const;
