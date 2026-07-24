/**
 * Reference subject: correct behaviour.
 *
 * It consumes only allowed generic evidence and produces supported, well-cited
 * generic claims. It is a *reference*, not a special case: it is a removable
 * package, it speaks only the public `subject-adapter/v1` protocol through
 * `@erl2/adapter-sdk`, and core contains no branch that knows it exists.
 *
 * What "correct" means here, precisely:
 *
 *   - it declares every mutation before performing it and names its
 *     compensation;
 *   - it reports an undeclared package kind as `unsupported`, not as a failure
 *     and never as a silent success;
 *   - it cites every claim to a path inside the evidence it was actually given;
 *   - it accounts for every canonical envelope entry exactly once;
 *   - it asks for the narrowest credential scope it needs;
 *   - it writes nothing outside its run-scoped output directory.
 */

import {
  buildTranslationReceipt,
  checkPackageKind,
  type AdapterDefinition,
  type AdapterOperationContext,
  type AdapterOperationOutcome,
} from "@erl2/adapter-sdk";
import { packageKindFromMediaType } from "@erl2/contracts";

const PACKAGE_BYTES = Buffer.from("reference-correct subject package v0.1.0\n", "utf8");

function requestedPackageKind(context: AdapterOperationContext): string {
  const artifact = context.request["frozen_acquired_artifact"] as
    | { readonly media_type?: string }
    | undefined;
  return packageKindFromMediaType(artifact?.media_type ?? "") ?? "unknown";
}

function acquire(context: AdapterOperationContext): AdapterOperationOutcome {
  context.diagnostic(`acquiring through the preregistered source for run ${context.runId}`);
  // The documentation the operator actually consulted is measured evidence, so
  // it is reported rather than inferred.
  context.writeOutput("acquisition/notes.txt", "followed quickstart, then install overview\n");
  return {
    status: "supported",
    resultSchemaVersion: "reference-correct-acquisition/v1",
    activeOperatorMs: 1800,
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
      documentation_step_ids: ["doc-quickstart", "doc-install-overview"],
      elapsed_ms: 2100,
    },
  };
}

function validatePackage(context: AdapterOperationContext): AdapterOperationOutcome {
  const kind = requestedPackageKind(context);
  const supported = checkPackageKind(REFERENCE_CORRECT_ADAPTER, kind);
  if (!supported.supported) {
    context.diagnostic(`package kind ${kind} is outside this adapter's declared kinds`);
    return {
      status: "unsupported",
      activeOperatorMs: 200,
      unsupportedInputs: [supported.reason as string],
      error: {
        code: "SUBJECT_PACKAGE_KIND_UNSUPPORTED",
        owner: "subject",
        safeMessage: `this subject is distributed as an archive; ${kind} is not a form it can verify`,
      },
    };
  }
  const declared = REFERENCE_CORRECT_ADAPTER.declaredEntrypoints;
  context.diagnostic(`verified package kind ${kind}; entrypoints ${declared.join(", ")}`);
  return {
    status: "supported",
    resultSchemaVersion: "reference-correct-package-verification/v1",
    activeOperatorMs: 400,
    result: {
      package_kind: kind,
      declared_entrypoints: declared,
      checks: [
        { check_id: "package-kind-declared", passed: true },
        { check_id: "entrypoint-present", passed: true },
      ],
    },
  };
}

function install(context: AdapterOperationContext): AdapterOperationOutcome {
  // Intent first: the mutation is declared with its compensation before the
  // adapter reports having performed it.
  context.declareMutation({
    mutation_id: "install-runtime-directory",
    mutation_class: "filesystem",
    capability_id: "write-adapter-workspace",
    target_descriptor: "adapter-workspace/reference-correct/runtime",
    before_state_descriptor: "absent",
    after_state_descriptor: "present",
    compensation_id: "remove-runtime-directory",
    compensation_capability_id: "write-adapter-workspace",
    status: "succeeded",
  });
  context.writeOutput("install/runtime.txt", "runtime directory created\n");
  return { status: "supported", activeOperatorMs: 900, resultSchemaVersion: "reference-correct-install/v1", result: { installed: true } };
}

function uninstall(context: AdapterOperationContext): AdapterOperationOutcome {
  context.declareMutation({
    mutation_id: "remove-runtime-directory-mutation",
    mutation_class: "filesystem",
    capability_id: "write-adapter-workspace",
    target_descriptor: "adapter-workspace/reference-correct/runtime",
    before_state_descriptor: "present",
    after_state_descriptor: "absent",
    compensation_id: "remove-runtime-directory-compensation",
    compensation_capability_id: "write-adapter-workspace",
    status: "succeeded",
  });
  context.declareCompensation({
    compensation_id: "remove-runtime-directory-compensation",
    mutation_id: "remove-runtime-directory-mutation",
    after_state_descriptor: "absent",
    status: "not_required",
    reason_code: "REMOVAL_IS_ITS_OWN_COMPENSATION",
  });
  return { status: "supported", activeOperatorMs: 300, resultSchemaVersion: "reference-correct-uninstall/v1", result: { removed: true } };
}

function translateEvidence(context: AdapterOperationContext): AdapterOperationOutcome {
  const entries = context.listInput("canonical-evidence");
  const entryIds = entries.map((e) => e.replace(/\.json$/, ""));
  const mappings = entryIds.map((entryId) => {
    const target = `translated/${entryId}.json`;
    const bytes = context.readInput("canonical-evidence", `${entryId}.json`);
    context.writeOutput(target, bytes);
    return { entry_id: entryId, disposition: "mapped_exact" as const, target_paths: [target] };
  });
  const receipt = buildTranslationReceipt({ entry_ids: entryIds }, "translated", mappings);
  return {
    status: "supported",
    resultSchemaVersion: "adapter-translation-receipt-draft/v1",
    activeOperatorMs: 500,
    result: receipt,
  };
}

function project(context: AdapterOperationContext): AdapterOperationOutcome {
  // Every claim cites a path this adapter actually wrote; a claim with no
  // citation is not made at all.
  const claims = [
    {
      claim_id: "acquisition-documented",
      category: "fact",
      predicate_id: "documentation-consulted",
      polarity: "asserted",
      confidence: "1",
      authority: "none",
      citations: [{ locator: "acquisition/notes.txt" }],
    },
  ];
  context.writeOutput("claims/generic.json", `${JSON.stringify({ claims }, null, 2)}\n`);
  return {
    status: "supported",
    resultSchemaVersion: "generic-claim-set-draft/v1",
    activeOperatorMs: 250,
    result: { claims, unprojected: [], complete: true },
  };
}

function reportResidue(context: AdapterOperationContext): AdapterOperationOutcome {
  context.diagnostic("residue scan: adapter workspace only, nothing outside it");
  return {
    status: "supported",
    resultSchemaVersion: "residue-report-draft/v1",
    activeOperatorMs: 100,
    result: { residual_paths: [], status: "clean" },
  };
}

function compensate(context: AdapterOperationContext): AdapterOperationOutcome {
  context.declareCompensation({
    compensation_id: "remove-runtime-directory",
    mutation_id: "install-runtime-directory",
    after_state_descriptor: "absent",
    status: "succeeded",
  });
  return { status: "supported", activeOperatorMs: 150, resultSchemaVersion: "reference-correct-compensation/v1", result: { compensated: true } };
}

export const REFERENCE_CORRECT_ADAPTER: AdapterDefinition = {
  adapterId: "reference-correct",
  version: "0.1.0",
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: ["bin/reference-correct"],
  handlers: {
    acquire,
    "validate-package": validatePackage,
    install,
    uninstall,
    "translate-evidence": translateEvidence,
    project,
    "report-residue": reportResidue,
    compensate,
  },
};
