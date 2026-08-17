/**
 * A neutral observer that reads its host-provisioned inputs and reports what it
 * actually saw.
 *
 * It exists because "the host materialized the right bytes" and "the adapter
 * read the right bytes" are two different claims, and only the second one is
 * the thing an operator cares about. A fixture that returned a constant would
 * pass whether or not a single byte reached the mount.
 *
 * The mount id is not configured here and is not guessed. It is derived from
 * the request the same way the host derived it: `execution_context`'s
 * `resource_limits.input_root` and each `input_artifact_refs[].path`, split as
 *
 *     <input_root>/<mount_id>/<relative-file-path>
 *
 * so the convention is proved to be discoverable from the contract alone, by a
 * separate process, rather than agreed out of band between two halves of the
 * same codebase.
 *
 * It writes nothing, holds nothing, and reaches no network. `report-residue`
 * answers `clean` because it genuinely leaves none.
 */
import { createHash } from "node:crypto";
import { main } from "@erl2/adapter-sdk";

/** Splits every host-provisioned input ref the request carries into mount and file. */
function boundInputs(request) {
  const context = request["execution_context"] ?? {};
  const inputRoot = (context["resource_limits"] ?? {})["input_root"];
  const refs = context["input_artifact_refs"] ?? [];
  const out = [];
  for (const ref of refs) {
    if (ref["provenance_mode"] !== "host_provisioned") continue;
    const logical = ref["artifact"]["path"];
    const prefix = `${inputRoot}/`;
    if (!logical.startsWith(prefix)) continue;
    const segments = logical.slice(prefix.length).split("/");
    if (segments.length < 2) continue;
    out.push({
      inputId: ref["input_id"],
      mountId: segments[0],
      relativePath: segments.slice(1).join("/"),
      declaredSha256: ref["artifact"]["file_sha256"],
      declaredByteLength: ref["artifact"]["byte_length"],
    });
  }
  return out;
}

/** Reads each bound input through its mount and digests exactly what came back. */
function observeInputs(context) {
  const seen = [];
  const listed = new Map();
  for (const input of boundInputs(context.request)) {
    const bytes = context.readInput(input.mountId, input.relativePath);
    if (!listed.has(input.mountId)) {
      listed.set(input.mountId, [...context.listInput(input.mountId)]);
    }
    seen.push({
      input_id: input.inputId,
      mount_id: input.mountId,
      relative_path: input.relativePath,
      observed_sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      observed_byte_length: bytes.byteLength,
      matches_plan:
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` === input.declaredSha256 &&
        bytes.byteLength === input.declaredByteLength,
      // The first 64 bytes, as text, so a case can assert on the content
      // itself and not only on a digest that agrees with a digest.
      observed_prefix_utf8: bytes.subarray(0, 64).toString("utf8"),
    });
  }
  return {
    inputs: seen,
    mount_listings: [...listed.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([mountId, files]) => ({ mount_id: mountId, files })),
  };
}

/**
 * Reports what was read, and refuses when it is not what the plan described.
 *
 * The retained record holds hashes rather than adapter result payloads, so the
 * observation is written to the output directory where a case can read it, and
 * a mismatch is additionally reported as `failed` — which stops the run
 * reaching a clean terminal. Either signal alone would be weaker: the file
 * proves the exact bytes, the status proves the run noticed.
 */
const reading = (operation) => (context) => {
  context.diagnostic(`neutral input-reading observer handled ${operation}`);
  const observed = observeInputs(context);
  context.writeOutput("observed-inputs.json", `${JSON.stringify(observed, null, 2)}\n`);
  const mismatched = observed.inputs.filter((input) => !input.matches_plan);
  if (mismatched.length > 0) {
    context.diagnostic(`neutral input-reading observer saw ${mismatched.length} mismatched inputs`);
    return {
      status: "failed",
      error: {
        code: "ARTIFACT_HASH_MISMATCH",
        owner: "adapter",
        safeMessage: "a bound input did not match the digest the plan declared",
      },
    };
  }
  return {
    status: "supported",
    result: { observed: operation, ...observed },
    resultSchemaVersion: "neutral-input-reading/v1",
  };
};

await main({
  adapterId: "neutral-input-reading-observer",
  version: "1.0.0",
  supportedProtocolVersions: ["subject-adapter/v2"],
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: ["acquire", "translate-evidence", "report-residue"],
  handlers: {
    acquire: reading("acquire"),
    "translate-evidence": reading("translate-evidence"),
    "report-residue": (context) => {
      context.diagnostic("neutral input-reading observer swept its checkpoint");
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
