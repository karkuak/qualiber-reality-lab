/**
 * Reference subject: truthfully limited.  It reports `subject_unsupported`
 * rather than inventing an answer, which is the behaviour ERL2-AC-005 requires
 * to remain an admitted, retained result.
 *
 * A removable package: core builds, tests and verifies without it.
 */
export { REFERENCE_LIMITED_ADAPTER } from "./adapter.js";
export const REFERENCE_LIMITED_ADAPTER_ID = "reference-limited";
export const REFERENCE_LIMITED_BEHAVIOUR = "declares unsupported inputs truthfully" as const;
