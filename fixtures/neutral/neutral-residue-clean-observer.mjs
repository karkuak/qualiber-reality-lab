/** Reports a final checkpoint it observed to be clean, naming no residual item. */
import { main } from "@erl2/adapter-sdk";

await main({
  adapterId: "neutral-residue-clean-observer",
  version: "1.0.0",
  supportedProtocolVersions: ["subject-adapter/v2"],
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: ["report-residue"],
  handlers: {
    "report-residue": (context) => {
      context.diagnostic("neutral residue sweep observed no remaining artifact");
      return {
        status: "supported",
        result: {
          schema_version: "local-residue-observation/v1",
          checkpoint: context.request["operation_payload"]["checkpoint"],
          status: "clean",
          residual_resources: [],
          residual_paths: [],
        },
        resultSchemaVersion: "local-residue-observation/v1",
      };
    },
  },
});
