/**
 * Reference subject: truthfully limited behaviour.
 *
 * This adapter's whole point is that being unable to do something is reported
 * honestly and stays in the evidence. ERL2-FR-005 and ERL2-AC-005 require that
 * an unsupported input remains an admitted, retained result — the case is not
 * filtered out, the challenge is not removed, and nothing is invented to fill
 * the gap.
 *
 * Concretely this subject is distributed as an OCI image, so when the Lab hands
 * it a frozen *archive* it reports `unsupported` with the exact reason rather
 * than pretending to verify it. Where it does produce claims, it produces only
 * the ones its supported evidence justifies, and it explicitly lists what it
 * could not project.
 */

import {
  buildTranslationReceipt,
  checkPackageKind,
  type AdapterDefinition,
  type AdapterOperationContext,
  type AdapterOperationOutcome,
} from "@erl2/adapter-sdk";
import { packageKindFromMediaType } from "@erl2/contracts";

const PACKAGE_BYTES = Buffer.from("reference-limited subject package v0.1.0\n", "utf8");

function acquire(context: AdapterOperationContext): AdapterOperationOutcome {
  context.diagnostic("acquired the distributed artifact; no authentication was required");
  return {
    status: "supported",
    resultSchemaVersion: "reference-limited-acquisition/v1",
    activeOperatorMs: 1200,
    result: {
      package_base64: PACKAGE_BYTES.toString("base64"),
      attempts: [
        {
          attempt_id: "attempt-1",
          status: "completed",
          bytes: PACKAGE_BYTES.byteLength,
          redirect_count: 0,
          error_codes: [],
        },
      ],
      authentication_prompt_count: 0,
      documentation_step_ids: ["doc-readme"],
      elapsed_ms: 1400,
    },
  };
}

function validatePackage(context: AdapterOperationContext): AdapterOperationOutcome {
  const artifact = context.request["frozen_acquired_artifact"] as
    | { readonly media_type?: string }
    | undefined;
  const kind = packageKindFromMediaType(artifact?.media_type ?? "") ?? "unknown";
  const supported = checkPackageKind(REFERENCE_LIMITED_ADAPTER, kind);
  if (supported.supported) {
    context.diagnostic(`verified package kind ${kind}`);
    return {
      status: "supported",
      resultSchemaVersion: "reference-limited-package-verification/v1",
      activeOperatorMs: 350,
      result: { package_kind: kind, checks: [{ check_id: "package-kind-declared", passed: true }] },
    };
  }
  // The honest answer. It is retained, and the Lab keeps the case.
  context.diagnostic(`cannot verify package kind ${kind}; this subject ships as an oci image`);
  return {
    status: "unsupported",
    activeOperatorMs: 300,
    unsupportedInputs: [supported.reason as string, "verification:provenance-attestation"],
    error: {
      code: "SUBJECT_PACKAGE_KIND_UNSUPPORTED",
      owner: "subject",
      safeMessage: `this subject is distributed as an oci image and cannot verify a ${kind} package`,
    },
  };
}

function translateEvidence(context: AdapterOperationContext): AdapterOperationOutcome {
  const entries = context.listInput("canonical-evidence").map((e) => e.replace(/\.json$/, ""));
  // Half the evidence classes are outside what this subject models. They are
  // mapped `unsupported` with a reason — never omitted, never deleted.
  const mappings = entries.map((entryId, index) => {
    if (index % 2 === 1) {
      return {
        entry_id: entryId,
        disposition: "unsupported" as const,
        target_paths: [] as string[],
        loss_reason_code: "EVIDENCE_CLASS_NOT_MODELLED",
      };
    }
    const target = `translated/${entryId}.json`;
    context.writeOutput(target, context.readInput("canonical-evidence", `${entryId}.json`));
    return { entry_id: entryId, disposition: "mapped_lossy" as const, target_paths: [target], loss_reason_code: "FIELD_SUBSET_ONLY" };
  });
  return {
    status: "supported",
    resultSchemaVersion: "adapter-translation-receipt-draft/v1",
    activeOperatorMs: 400,
    result: buildTranslationReceipt({ entry_ids: entries }, "translated", mappings),
  };
}

function project(context: AdapterOperationContext): AdapterOperationOutcome {
  context.writeOutput("claims/generic.json", `${JSON.stringify({ claims: [] }, null, 2)}\n`);
  return {
    status: "supported",
    resultSchemaVersion: "generic-claim-set-draft/v1",
    activeOperatorMs: 200,
    result: {
      claims: [],
      // What could not be projected is named, so an empty claim set cannot be
      // mistaken for "nothing to report".
      unprojected: [
        { path: "translated/", reason_code: "EVIDENCE_CLASS_NOT_MODELLED" },
      ],
      complete: false,
    },
  };
}

function reportResidue(context: AdapterOperationContext): AdapterOperationOutcome {
  context.diagnostic("residue scan: no runtime was installed, so nothing was left behind");
  return {
    status: "supported",
    resultSchemaVersion: "residue-report-draft/v1",
    activeOperatorMs: 80,
    result: { residual_paths: [], status: "clean" },
  };
}

export const REFERENCE_LIMITED_ADAPTER: AdapterDefinition = {
  adapterId: "reference-limited",
  version: "0.1.0",
  supportedPackageKinds: ["oci"],
  declaredEntrypoints: ["bin/reference-limited"],
  handlers: {
    acquire,
    "validate-package": validatePackage,
    "translate-evidence": translateEvidence,
    project,
    "report-residue": reportResidue,
  },
};
