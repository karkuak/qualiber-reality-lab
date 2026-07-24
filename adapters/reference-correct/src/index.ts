/**
 * Reference subject: correct behaviour.
 *
 * A removable package. Core builds, tests and verifies with this directory
 * absent; `tests/architecture/removability.test.ts` proves it.
 */
export { REFERENCE_CORRECT_ADAPTER } from "./adapter.js";
export const REFERENCE_CORRECT_ADAPTER_ID = "reference-correct";
export const REFERENCE_CORRECT_BEHAVIOUR = "reports supported facts with citations" as const;
