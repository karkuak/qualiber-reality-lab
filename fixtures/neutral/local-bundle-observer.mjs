import { main } from "@erl2/adapter-sdk";

await main({
  adapterId: "neutral-bundle-observer",
  version: "1.0.0",
  supportedProtocolVersions: ["subject-adapter/v2"],
  supportedPackageKinds: ["bundle"],
  declaredEntrypoints: ["project"],
  handlers: {
    project: (context) => {
      context.diagnostic("neutral bundle projection retained as an untrusted draft");
      context.writeOutput("projection.json", '{"shape":"bundle","role":"local-draft"}\n');
      return {
        status: "supported",
        result: { shape: "bundle", role: "local-draft" },
        resultSchemaVersion: "local-bundle-projection/v1",
      };
    },
  },
});
