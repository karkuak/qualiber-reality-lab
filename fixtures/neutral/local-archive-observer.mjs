import { main } from "@erl2/adapter-sdk";

await main({
  adapterId: "neutral-archive-observer",
  version: "1.0.0",
  supportedProtocolVersions: ["subject-adapter/v2"],
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: ["validate-package"],
  handlers: {
    "validate-package": (context) => {
      context.diagnostic("neutral archive structure inspected");
      context.writeOutput("structure.json", '{"shape":"archive","observation":"conforms"}\n');
      return {
        status: "supported",
        result: { shape: "archive", structural_status: "conforms" },
        resultSchemaVersion: "local-archive-structure/v1",
      };
    },
  },
});
