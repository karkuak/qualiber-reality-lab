/** Reports a final checkpoint with fifty remaining artifacts. */
import { main } from "@erl2/adapter-sdk";

const paths = Array.from({ length: 50 }, (_, index) => `adapter-workspace/leftover-${String(index)}.tmp`);

await main({
  adapterId: "neutral-residue-detected-observer",
  version: "1.0.0",
  supportedProtocolVersions: ["subject-adapter/v2"],
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: ["report-residue"],
  handlers: {
    "report-residue": (context) => {
      context.diagnostic("neutral residue sweep observed remaining artifacts");
      return {
        status: "supported",
        result: {
          schema_version: "local-residue-observation/v1",
          checkpoint: context.request["operation_payload"]["checkpoint"],
          status: "residue_detected",
          residual_resources: [],
          residual_paths: paths,
        },
        resultSchemaVersion: "local-residue-observation/v1",
      };
    },
  },
});
