/** Starts, then stops and says the stop happened. The success side of the pair. */
import { main } from "@erl2/adapter-sdk";

await main({
  adapterId: "neutral-lifecycle-stop-succeeded",
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
      context.diagnostic("neutral lifecycle observer stopped");
      return { status: "supported", result: { stopped: true }, resultSchemaVersion: "neutral-lifecycle/v1" };
    },
  },
});
