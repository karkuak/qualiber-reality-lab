/**
 * A neutral observer whose middle operation ends without answering.
 *
 * It exists to prove what a run does when an operation genuinely fails rather
 * than merely reporting an unsupported result: the record stays `failed`, the
 * main sequence stops there, the frozen cleanup suffix still runs, and the
 * command exits nonzero with the record retained.
 *
 * The exit is deliberate and neutral — no product, no network, no side effect
 * outside the host's own workspace.
 */
import { main } from "@erl2/adapter-sdk";

await main({
  adapterId: "neutral-fault-observer",
  version: "1.0.0",
  supportedProtocolVersions: ["subject-adapter/v2"],
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: ["acquire", "translate-evidence", "report-residue"],
  handlers: {
    acquire: (context) => {
      context.diagnostic("neutral fault observer acquired");
      return {
        status: "supported",
        result: { observed: "acquire" },
        resultSchemaVersion: "neutral-fault/v1",
      };
    },
    "translate-evidence": () => {
      // Ends the process without writing a response frame.
      process.exit(3);
    },
    "report-residue": (context) => {
      context.diagnostic("neutral fault observer swept its checkpoint");
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
