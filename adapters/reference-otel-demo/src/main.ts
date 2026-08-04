/**
 * Executable entry point for the environment-interacting reference adapter.
 *
 * The host spawns exactly this file. It contains no logic of its own: the
 * behaviour lives in `adapter.ts`, so the same definition can be exercised
 * in-process by a test and out-of-process by the real host without two code
 * paths that could disagree.
 */

import { main } from "@erl2/adapter-sdk";
import { REFERENCE_OTEL_DEMO_ADAPTER } from "./adapter.js";

await main(REFERENCE_OTEL_DEMO_ADAPTER);
