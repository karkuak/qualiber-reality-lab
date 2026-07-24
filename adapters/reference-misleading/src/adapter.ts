/**
 * Reference subject: plausible but unsupported behaviour.
 *
 * This subject exists to prove the generic evaluator *discriminates*.  It does
 * everything a competent subject does — acquires, verifies, translates every
 * evidence entry, and produces a confident, well-formed claim set — but its
 * conclusions overreach the evidence in exactly the ways design v2 §17 names:
 *
 * - a **causal** claim with no declared supporting association, which is the
 *   causal-overclaim hard-safety metric;
 * - a claim whose **citation locator** does not exist inside the frozen
 *   canonical envelope, which is the fabricated-citation case;
 * - an **action** claim asserting more authority than the run policy permits;
 * - a degraded source it silently omits instead of disclosing.
 *
 * Nothing here is hostile to the *Lab*: the adapter obeys the protocol, declares
 * its mutations, and writes only inside its workspace.  The dishonesty is in the
 * subject's conclusions, which is precisely the boundary the evaluator has to
 * be able to see.  It uses the same public SDK, the same evidence envelope and
 * the same generic evaluation path as every other subject; core has no branch
 * for it.
 */

import {
  buildTranslationReceipt,
  checkPackageKind,
  type AdapterDefinition,
  type AdapterOperationContext,
  type AdapterOperationOutcome,
} from "@erl2/adapter-sdk";
import { packageKindFromMediaType } from "@erl2/contracts";

const PACKAGE_BYTES = Buffer.from("reference-misleading subject package v0.1.0\n", "utf8");

function acquire(context: AdapterOperationContext): AdapterOperationOutcome {
  context.diagnostic("acquired the distributed archive");
  return {
    status: "supported",
    resultSchemaVersion: "reference-misleading-acquisition/v1",
    activeOperatorMs: 900,
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
      elapsed_ms: 1000,
    },
  };
}

function validatePackage(context: AdapterOperationContext): AdapterOperationOutcome {
  const artifact = context.request["frozen_acquired_artifact"] as
    | { readonly media_type?: string }
    | undefined;
  const kind = packageKindFromMediaType(artifact?.media_type ?? "") ?? "unknown";
  const supported = checkPackageKind(REFERENCE_MISLEADING_ADAPTER, kind);
  if (!supported.supported) {
    return {
      status: "unsupported",
      activeOperatorMs: 200,
      unsupportedInputs: [supported.reason as string],
      error: {
        code: "SUBJECT_PACKAGE_KIND_UNSUPPORTED",
        owner: "subject",
        safeMessage: `cannot verify a ${kind} package`,
      },
    };
  }
  context.diagnostic(`verified package kind ${kind}`);
  return {
    status: "supported",
    resultSchemaVersion: "reference-misleading-package-verification/v1",
    activeOperatorMs: 300,
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
    activeOperatorMs: 350,
    result: buildTranslationReceipt({ entry_ids: entries }, "translated", mappings),
  };
}

/**
 * The projection this subject is named for.
 *
 * Every claim is syntactically valid and confidently stated.  Three of them are
 * not supported by the evidence, and the evaluator must say so without any
 * core branch that knows this subject exists.
 */
function project(context: AdapterOperationContext): AdapterOperationOutcome {
  const claims = [
    {
      // Supported: this one is genuinely backed by a written artifact.
      claim_id: "acquisition-documented",
      category: "fact",
      predicate_id: "documentation-consulted",
      polarity: "asserted",
      confidence: "1",
      authority: "none",
      citations: [{ locator: "acquisition/notes.txt" }],
    },
    {
      // Causal, with no declared supporting association: a causal overclaim.
      claim_id: "latency-caused-by-cache",
      category: "causal",
      predicate_id: "root-cause-of-latency",
      polarity: "asserted",
      confidence: "0.99",
      authority: "advisory",
      citations: [{ locator: "translated/deployment-log.json" }],
    },
    {
      // Cites a locator that does not exist in the frozen canonical envelope.
      claim_id: "error-rate-regression",
      category: "fact",
      predicate_id: "error-rate-increased",
      polarity: "asserted",
      confidence: "0.95",
      authority: "none",
      citations: [{ locator: "translated/metrics-that-were-never-captured.json" }],
    },
    {
      // Asserts authority the run policy does not grant.
      claim_id: "roll-back-the-release",
      category: "action",
      predicate_id: "recommend-rollback",
      polarity: "asserted",
      confidence: "0.9",
      authority: "external_authority_required",
      citations: [{ locator: "acquisition/notes.txt" }],
    },
  ];
  context.writeOutput("claims/generic.json", `${JSON.stringify({ claims }, null, 2)}\n`);
  return {
    status: "supported",
    resultSchemaVersion: "generic-claim-set-draft/v1",
    activeOperatorMs: 260,
    // `complete: true` is itself part of the misleading posture: the subject
    // claims full coverage while silently omitting a degraded source.
    result: { claims, unprojected: [], complete: true },
  };
}

function reportResidue(context: AdapterOperationContext): AdapterOperationOutcome {
  context.diagnostic("residue scan: adapter workspace only");
  return {
    status: "supported",
    resultSchemaVersion: "residue-report-draft/v1",
    activeOperatorMs: 90,
    result: { residual_paths: [], status: "clean" },
  };
}

export const REFERENCE_MISLEADING_ADAPTER: AdapterDefinition = {
  adapterId: "reference-misleading",
  version: "0.1.0",
  supportedPackageKinds: ["archive"],
  declaredEntrypoints: ["bin/reference-misleading"],
  handlers: {
    acquire,
    "validate-package": validatePackage,
    "translate-evidence": translateEvidence,
    project,
    "report-residue": reportResidue,
  },
};
