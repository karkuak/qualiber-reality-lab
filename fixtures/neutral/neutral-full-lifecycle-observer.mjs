/**
 * A neutral observer that answers every operation in the closed set.
 *
 * It exists so a multi-operation plan can be proved end to end without any
 * product, service, network or filesystem dependency: each handler records a
 * diagnostic, returns a structurally valid result, and does nothing else. The
 * point of the fixture is the *chain* — eleven requests, each carrying the
 * compact predecessor of the one before it — not what any single operation
 * computes.
 *
 * `report-residue` answers `clean` with no residual item because this adapter
 * genuinely leaves none: it writes only through the host's output directory and
 * holds no resource to leak. An adapter that could not tell must answer
 * `unknown`, and the reducer will not round that up.
 */
import { main } from "@erl2/adapter-sdk";

const observed = (operation, extra = {}) => (context) => {
  context.diagnostic(`neutral full-lifecycle observer handled ${operation}`);
  return {
    status: "supported",
    result: { observed: operation, ...extra },
    resultSchemaVersion: "neutral-full-lifecycle/v1",
  };
};

await main({
  adapterId: "neutral-full-lifecycle-observer",
  version: "1.0.0",
  supportedProtocolVersions: ["subject-adapter/v2"],
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: [
    "acquire",
    "validate-package",
    "install",
    "configure",
    "start",
    "interact",
    "translate-evidence",
    "collect-outputs",
    "project",
    "stop",
    "uninstall",
    "report-residue",
    "compensate",
  ],
  handlers: {
    acquire: observed("acquire", { provenance: "declared" }),
    "validate-package": observed("validate-package", { structural_status: "conforms" }),
    install: observed("install"),
    configure: observed("configure"),
    start: observed("start", { started: true }),
    interact: observed("interact"),
    "translate-evidence": observed("translate-evidence"),
    "collect-outputs": observed("collect-outputs"),
    project: observed("project", { projection_schema: "local-draft-v1" }),
    stop: observed("stop", { stopped: true }),
    uninstall: observed("uninstall"),
    compensate: observed("compensate"),
    "report-residue": (context) => {
      context.diagnostic("neutral full-lifecycle observer swept its checkpoint");
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
