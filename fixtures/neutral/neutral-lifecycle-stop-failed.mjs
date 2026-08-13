/**
 * Starts, then reports that the stop did not happen.
 *
 * The exchange completes normally — the adapter answers, the host adjudicates
 * the envelope and freezes its evidence — and the adapter's own verdict is
 * `failed`. This is the shape the cleanup reducer must not read as a stop.
 */
import { main } from "@erl2/adapter-sdk";

await main({
  adapterId: "neutral-lifecycle-stop-failed",
  version: "1.0.0",
  supportedProtocolVersions: ["subject-adapter/v2"],
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: ["start", "stop"],
  handlers: {
    start: (context) => {
      context.diagnostic("neutral lifecycle observer started");
      return { status: "supported", result: { started: true }, resultSchemaVersion: "neutral-lifecycle/v1" };
    },
    stop: (context) => {
      context.diagnostic("neutral lifecycle observer could not stop what it started");
      return {
        status: "failed",
        error: {
          code: "ADAPTER_EXECUTION_FAULT",
          safeMessage: "the subject process did not terminate",
          owner: "adapter",
        },
      };
    },
  },
});
