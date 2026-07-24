/**
 * Reference subject: honestly inconclusive behaviour.
 *
 * This subject reaches the end of the journey and says, correctly, that it
 * cannot conclude.  It is the control that separates "wrong" from "silent":
 *
 * - it projects **explicit unknown claims** that match genuine truth gaps,
 *   rather than guessing, which is what the correct-abstention metric measures;
 * - it **discloses** every degraded or unavailable evidence source instead of
 *   reasoning around it, which the degradation-honesty hard-safety metric
 *   requires;
 * - it makes **no causal claim at all**, so the causal-overclaim metric is zero
 *   over an empty denominator rather than a guess;
 * - it marks its claim set `complete: false` and names what it could not
 *   project.
 *
 * The evaluator must record this as inconclusive-but-valid, never as a subject
 * defect and never as Lab invalidity.  Like every reference subject it runs on
 * the public adapter protocol; core has no branch for it.
 */

import {
  buildTranslationReceipt,
  checkPackageKind,
  type AdapterDefinition,
  type AdapterOperationContext,
  type AdapterOperationOutcome,
} from "@erl2/adapter-sdk";
import { packageKindFromMediaType } from "@erl2/contracts";

const PACKAGE_BYTES = Buffer.from("reference-inconclusive subject package v0.1.0\n", "utf8");

function acquire(context: AdapterOperationContext): AdapterOperationOutcome {
  context.diagnostic("acquired the distributed archive");
  return {
    status: "supported",
    resultSchemaVersion: "reference-inconclusive-acquisition/v1",
    activeOperatorMs: 1000,
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
      documentation_step_ids: ["doc-readme", "doc-troubleshooting"],
      elapsed_ms: 1300,
    },
  };
}

function validatePackage(context: AdapterOperationContext): AdapterOperationOutcome {
  const artifact = context.request["frozen_acquired_artifact"] as
    | { readonly media_type?: string }
    | undefined;
  const kind = packageKindFromMediaType(artifact?.media_type ?? "") ?? "unknown";
  const supported = checkPackageKind(REFERENCE_INCONCLUSIVE_ADAPTER, kind);
  if (!supported.supported) {
    return {
      status: "unsupported",
      activeOperatorMs: 220,
      unsupportedInputs: [supported.reason as string],
      error: {
        code: "SUBJECT_PACKAGE_KIND_UNSUPPORTED",
        owner: "subject",
        safeMessage: `cannot verify a ${kind} package`,
      },
    };
  }
  return {
    status: "supported",
    resultSchemaVersion: "reference-inconclusive-package-verification/v1",
    activeOperatorMs: 320,
    result: { package_kind: kind, checks: [{ check_id: "package-kind-declared", passed: true }] },
  };
}

function translateEvidence(context: AdapterOperationContext): AdapterOperationOutcome {
  const entries = context.listInput("canonical-evidence").map((e) => e.replace(/\.json$/, ""));
  const mappings = entries.map((entryId) => {
    const target = `translated/${entryId}.json`;
    context.writeOutput(target, context.readInput("canonical-evidence", `${entryId}.json`));
    return { entry_id: entryId, disposition: "mapped_exact" as const, target_paths: [target] };
  });
  return {
    status: "supported",
    resultSchemaVersion: "adapter-translation-receipt-draft/v1",
    activeOperatorMs: 380,
    result: buildTranslationReceipt({ entry_ids: entries }, "translated", mappings),
  };
}

function project(context: AdapterOperationContext): AdapterOperationOutcome {
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
    {
      // The honest core of this subject: it says it does not know, and it says
      // so about a gap that genuinely exists.
      claim_id: "root-cause-unknown",
      category: "unknown",
      predicate_id: "root-cause-of-latency",
      polarity: "unknown",
      confidence: "0",
      authority: "none",
      citations: [{ locator: "translated/deployment-log.json" }],
    },
    {
      claim_id: "error-rate-unknown",
      category: "unknown",
      predicate_id: "error-rate-increased",
      polarity: "unknown",
      confidence: "0",
      authority: "none",
      citations: [{ locator: "translated/deployment-log.json" }],
    },
  ];
  context.writeOutput("claims/generic.json", `${JSON.stringify({ claims }, null, 2)}\n`);
  return {
    status: "supported",
    resultSchemaVersion: "generic-claim-set-draft/v1",
    activeOperatorMs: 240,
    result: {
      claims,
      unprojected: [
        { path: "translated/", reason_code: "INSUFFICIENT_EVIDENCE_FOR_A_CONCLUSION" },
      ],
      complete: false,
    },
  };
}

function reportResidue(context: AdapterOperationContext): AdapterOperationOutcome {
  context.diagnostic("residue scan: adapter workspace only");
  return {
    status: "supported",
    resultSchemaVersion: "residue-report-draft/v1",
    activeOperatorMs: 85,
    result: { residual_paths: [], status: "clean" },
  };
}

export const REFERENCE_INCONCLUSIVE_ADAPTER: AdapterDefinition = {
  adapterId: "reference-inconclusive",
  version: "0.1.0",
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: ["bin/reference-inconclusive"],
  handlers: {
    acquire,
    "validate-package": validatePackage,
    "translate-evidence": translateEvidence,
    project,
    "report-residue": reportResidue,
  },
};
