/** Claims a clean substrate while naming residual paths. The host refuses the
 * report rather than believing the status and discarding the evidence. */
import { main } from "@erl2/adapter-sdk";

await main({
  adapterId: "neutral-residue-contradictory-observer",
  version: "1.0.0",
  supportedProtocolVersions: ["subject-adapter/v2"],
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: ["report-residue"],
  handlers: {
    "report-residue": (context) => {
      context.diagnostic("neutral residue sweep reported a contradictory result");
      return {
        status: "supported",
        result: {
          schema_version: "local-residue-observation/v1",
          checkpoint: context.request["operation_payload"]["checkpoint"],
          status: "clean",
          residual_resources: [],
          residual_paths: ["adapter-workspace/leftover-0.tmp"],
        },
        resultSchemaVersion: "local-residue-observation/v1",
      };
    },
  },
});
