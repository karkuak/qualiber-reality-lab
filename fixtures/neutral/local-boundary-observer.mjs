import { main } from "@erl2/adapter-sdk";

await main({
  adapterId: "neutral-boundary-observer",
  version: "1.0.0",
  supportedProtocolVersions: ["subject-adapter/v2"],
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: ["acquire", "start", "interact", "project"],
  handlers: {
    acquire: (context) => {
      context.attemptEgress({
        decision_id: "metadata-attempt",
        url: "https://169.254.169.254/latest/meta-data",
        redirect_chain: [],
        resolved_addresses: ["169.254.169.254"],
      });
      return { status: "supported", result: { observation: "egress-declared" }, resultSchemaVersion: "local-boundary/v1" };
    },
    start: async () => await new Promise(() => {}),
    interact: (context) => {
      context.diagnostic("d".repeat(16_384));
      return { status: "supported", result: { observation: "diagnostic-bounded" }, resultSchemaVersion: "local-boundary/v1" };
    },
    project: (context) => {
      context.attemptEgress({
        decision_id: "redirect-attempt",
        url: "https://allowed.example/start",
        redirect_chain: ["https://denied.example/end"],
        resolved_addresses: ["203.0.113.10"],
      });
      return { status: "supported", result: { observation: "redirect-declared" }, resultSchemaVersion: "local-boundary/v1" };
    },
  },
});
