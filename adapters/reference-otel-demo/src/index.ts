/**
 * Reference subject: interacts with the real environment endpoint.
 *
 * A removable package. Core builds, tests and verifies with this directory
 * absent; `tests/architecture/removability.test.ts` proves it.
 */
export { REFERENCE_OTEL_DEMO_ADAPTER } from "./adapter.js";
export const REFERENCE_OTEL_DEMO_ADAPTER_ID = "reference-otel-demo";
export const REFERENCE_OTEL_DEMO_BEHAVIOUR = "exercises one real environment endpoint" as const;
