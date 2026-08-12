/** Supports the operation but cannot determine residue. "I could not tell" is
 * a real answer, and it must never be rounded to clean. */
import { main } from "@erl2/adapter-sdk";

await main({
  adapterId: "neutral-residue-unknown-observer",
  version: "1.0.0",
  supportedProtocolVersions: ["subject-adapter/v2"],
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: ["report-residue"],
  handlers: {
    "report-residue": (context) => {
      context.diagnostic("neutral residue sweep could not determine the substrate state");
      return {
        status: "supported",
        result: {
          schema_version: "local-residue-observation/v1",
          checkpoint: context.request["operation_payload"]["checkpoint"],
          status: "unknown",
          residual_resources: [],
          residual_paths: [],
        },
        resultSchemaVersion: "local-residue-observation/v1",
      };
    },
  },
});
