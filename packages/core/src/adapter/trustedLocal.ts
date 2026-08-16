/**
 * Owner-operated trusted-local admission for `subject-adapter/v2` local
 * observation (ADR-ERL2-042).
 *
 * ## What this path is
 *
 * The operator owns the adapter, has read its source, and accepts that its
 * exact bytes will execute as a child process with their own user's
 * permissions. That acceptance is the entire authority. It is written down, it
 * is bound to the exact artifact and manifest bytes it was given for, and it is
 * retained in the run's evidence so an offline reader sees precisely what was
 * accepted and by whom.
 *
 * ## What this path is not
 *
 * It is not certification. There is no certifier, no verdict, no signature, no
 * review and no second party — so this module deliberately shares no vocabulary
 * with `verifyLocalAdapterCertificationV2`. It does not construct a receipt, it
 * cannot produce one, and a receipt cannot be substituted for a declaration:
 * the two documents have disjoint required fields and separate contracts.
 *
 * It is also not confinement. `AdapterHost` genuinely enforces the twelve
 * host-level controls the `local-process` profile reports as `enforced` —
 * a separate process, a wall-clock deadline, request/response byte ceilings, a
 * writable-output-only workspace, an environment-variable allowlist, bounded
 * diagnostics, egress adjudication at the broker seam. Those are operational
 * bounds on a cooperating adapter. They are not a kernel boundary: the adapter
 * process shares the operator's filesystem and network authority, and this
 * module says so rather than copying a control table into a claim of
 * isolation. That is why the declaration's `not_confined` is a `const true`
 * the operator must write, not a field the Lab computes.
 *
 * The one control statement retained here is the host's *actual*
 * `sandboxControlReport`, verbatim, including the thirteen controls it honestly
 * reports as `unsupported_on_this_host`.
 */

import {
  ADAPTER_LOCAL_EXECUTION_MODE,
  ADAPTER_PROTOCOL_VERSION_V2,
  CODES,
  Erl2Error,
  LOCAL_OBSERVATION_UNSUPPORTED_CLAIMS,
  assertContract,
  type Hash,
  type SandboxControlReportV2,
  type SubjectAdapterManifestV1,
  type SubjectAdapterManifestV2,
  type SubjectAdapterProtocolProfileV2,
  type TrustedLocalAdapterDeclarationV1,
  type SubjectAdapterCertificationReceiptV2,
} from "@erl2/contracts";
import { coreHash } from "@erl2/integrity";

import { sandboxControlReport } from "./sandbox.js";

/**
 * The exact sentence an owner writes to accept local execution.
 *
 * Re-exported from the contract constant rather than restated, so the value the
 * CLI compares against and the value the schema pins cannot drift.
 */
export const TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN: TrustedLocalAdapterDeclarationV1["operator_acknowledgement"]["acknowledgement_token"] =
  "I ACCEPT THAT THESE EXACT ADAPTER BYTES EXECUTE WITH MY LOCAL USER PERMISSIONS, ARE NOT SANDBOXED AND ARE NOT INDEPENDENTLY CERTIFIED, AND THAT THE RESULTS ARE DEVELOPMENT-ONLY, UNSCORED AND UNAUTHENTICATED";

/**
 * Which authority a V2 local-observation host is running under.
 *
 * A closed union with no optional members and no default. The host stores the
 * discriminant, so "which kind of authority admitted this adapter" is a fact
 * the host knows and can retain, not something a caller infers from which
 * field happened to be populated. A future genuinely certified external
 * authority is the second arm; for this package only `trusted_local_code` is
 * reachable from a public command.
 */
export type LocalAdapterAuthorityV2 =
  | {
      readonly mode: "certified_external";
      readonly receipt: SubjectAdapterCertificationReceiptV2;
    }
  | {
      readonly mode: "trusted_local_code";
      readonly declaration: TrustedLocalAdapterDeclarationV1;
    };

/** What trusted-local admission established, and nothing it did not. */
export interface TrustedLocalAdmissionV2 {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly adapterOwner: string;
  readonly manifestHash: Hash;
  readonly declarationHash: Hash;
  readonly adapterArtifactHash: Hash;
  /** The manifest's own V2 local-observation profile; no certified subset exists. */
  readonly profile: SubjectAdapterProtocolProfileV2;
  readonly trustMode: "trusted_local_code";
  readonly tier: "development";
  /** Owner-asserted. Nothing verified the assertion, and the label says so. */
  readonly authenticity: "owner_asserted_unauthenticated";
  readonly independentCertification: "absent";
  readonly confinement: "absent";
  /** The host's actual control states, verbatim, unsupported entries included. */
  readonly hostControlReport: readonly SandboxControlReportV2[];
}

export interface VerifyTrustedLocalAdapterDeclarationInput {
  readonly manifest: SubjectAdapterManifestV1 | SubjectAdapterManifestV2;
  readonly declaration: TrustedLocalAdapterDeclarationV1;
  /** Digest of the exact entry bytes, re-read by the caller at this moment. */
  readonly entryDigest: Hash;
  /** Digest of the exact manifest file bytes, when the caller read a file. */
  readonly manifestFileHash?: Hash;
}

/**
 * Admits an adapter on the operator's own declaration.
 *
 * Every check below is a binding or a ceiling. There is deliberately no check
 * that could be read as an assessment of the adapter: nothing here inspects
 * behaviour, exercises an operation, or concludes that the code is safe.
 */
export function verifyTrustedLocalAdapterDeclaration(
  input: VerifyTrustedLocalAdapterDeclarationInput,
): TrustedLocalAdmissionV2 {
  const { manifest, declaration } = input;

  // 1. V2 manifest only. A V1 manifest has no local-observation profile and
  //    must not fall back into this path.
  if (manifest.schema_version !== "subject-adapter-manifest/v2") {
    throw new Erl2Error(
      CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED,
      "trusted-local observation requires a SubjectAdapterManifestV2; a V1 manifest cannot be admitted here",
      { owner: "adapter" },
    );
  }

  // 2. A certification receipt is not a declaration. This is checked before
  //    contract validation so the refusal names the actual confusion rather
  //    than reporting a missing property.
  const presented = declaration as { readonly schema_version?: unknown };
  if (presented.schema_version !== "trusted-local-adapter-declaration/v1") {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_DECLARATION_REQUIRED,
      `trusted-local observation requires a trusted-local-adapter-declaration/v1; received ${String(presented.schema_version)}`,
      { owner: "lab" },
    );
  }

  assertContract<SubjectAdapterManifestV2>("SubjectAdapterManifestV2", manifest);
  assertContract<TrustedLocalAdapterDeclarationV1>(
    "TrustedLocalAdapterDeclarationV1",
    declaration,
  );

  // 3. Both documents must hash to what they claim.
  const manifestHash = coreHash(manifest);
  const declarationHash = coreHash(declaration);
  if (manifestHash !== manifest.core_hash) {
    throw new Erl2Error(CODES.ARTIFACT_HASH_MISMATCH, "V2 manifest core hash is stale");
  }
  if (declarationHash !== declaration.core_hash) {
    throw new Erl2Error(
      CODES.ARTIFACT_HASH_MISMATCH,
      "trusted-local declaration core hash is stale",
    );
  }

  // 4. Identity: the declaration must be about this adapter and this owner.
  if (
    declaration.adapter_id !== manifest.adapter_id ||
    declaration.adapter_owner !== manifest.owner
  ) {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_AUTHORITY_MISMATCH,
      "the trusted-local declaration does not name this adapter and its manifest owner",
      { owner: "adapter" },
    );
  }

  // 5. Exact bytes: manifest, declaration and the file on disk must agree on
  //    one artifact digest, and the declaration must name this manifest.
  if (
    declaration.adapter_artifact_hash !== manifest.adapter_artifact_hash ||
    input.entryDigest !== manifest.adapter_artifact_hash
  ) {
    throw new Erl2Error(
      CODES.ADAPTER_IDENTITY_MISMATCH,
      "the manifest, the trusted-local declaration and the executable bytes do not have one digest",
      { owner: "adapter" },
    );
  }
  if (declaration.adapter_manifest_core_hash !== manifestHash) {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_BINDING_MISMATCH,
      "the trusted-local declaration is bound to a different manifest",
      { owner: "adapter" },
    );
  }
  if (
    input.manifestFileHash !== undefined &&
    declaration.adapter_manifest_file_hash !== input.manifestFileHash
  ) {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_BINDING_MISMATCH,
      "the trusted-local declaration is bound to different manifest file bytes",
      { owner: "adapter" },
    );
  }

  // 6. The acknowledgement itself: exact token, and bound to the same bytes.
  //    The schema pins these as constants; they are re-checked here so the
  //    enforcement lives on the execution path a control can reach.
  const acknowledgement = declaration.operator_acknowledgement;
  if (acknowledgement.acknowledgement_token !== TRUSTED_LOCAL_ACKNOWLEDGEMENT_TOKEN) {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_ACKNOWLEDGEMENT_INVALID,
      "the operator acknowledgement is not the exact trusted-local acknowledgement token",
      { owner: "lab" },
    );
  }
  if (
    acknowledgement.acknowledged_artifact_hash !== declaration.adapter_artifact_hash ||
    acknowledgement.acknowledged_manifest_core_hash !== declaration.adapter_manifest_core_hash
  ) {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_ACKNOWLEDGEMENT_INVALID,
      "the operator acknowledged different artifact or manifest bytes than the declaration binds",
      { owner: "lab" },
    );
  }
  if (
    acknowledgement.adapter_code_is_not_confined !== true ||
    acknowledgement.adapter_runs_with_operator_user_permissions !== true ||
    acknowledgement.adapter_is_not_independently_certified !== true ||
    acknowledgement.results_are_development_only !== true ||
    acknowledgement.results_are_unscored !== true ||
    acknowledgement.results_are_unauthenticated !== true
  ) {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_ACKNOWLEDGEMENT_INVALID,
      "the operator acknowledgement does not accept every stated limitation",
      { owner: "lab" },
    );
  }

  // 7. Protocol, mode, trust mode and tier.
  if (
    declaration.protocol_version !== ADAPTER_PROTOCOL_VERSION_V2 ||
    declaration.subject_execution_mode !== ADAPTER_LOCAL_EXECUTION_MODE ||
    declaration.trust_mode !== "trusted_local_code" ||
    declaration.tier !== "development"
  ) {
    throw new Erl2Error(
      CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED,
      "a trusted-local declaration authorizes only development-tier subject-adapter/v2 local observation",
      { owner: "lab" },
    );
  }

  // 8. The claim ceiling, stated by the declaration itself.
  assertTrustedLocalClaimCeiling(declaration);

  // 9. The operative profile is the manifest's own V2 local-observation
  //    profile. There is no certified subset to intersect with, and inventing
  //    one would be inventing a reviewer.
  const profile = manifest.protocol_support.find(
    (candidate): candidate is SubjectAdapterProtocolProfileV2 =>
      candidate.protocol_version === ADAPTER_PROTOCOL_VERSION_V2 &&
      candidate.execution_modes.includes(ADAPTER_LOCAL_EXECUTION_MODE),
  );
  if (profile === undefined) {
    throw new Erl2Error(
      CODES.ADAPTER_EXECUTION_MODE_UNSUPPORTED,
      "the manifest declares no subject-adapter/v2 local-observation profile",
      { owner: "adapter" },
    );
  }
  if (profile.execution_modes.some((mode) => mode !== ADAPTER_LOCAL_EXECUTION_MODE)) {
    throw new Erl2Error(
      CODES.ADAPTER_LOCAL_CONTEXT_FORBIDDEN,
      "a trusted-local declaration never authorizes governed execution",
      { owner: "lab" },
    );
  }

  // 10. The host's actual control states travel with the admission. What the
  //     plan is allowed to do with them is decided where the plan is available
  //     — see `assertTrustedLocalControls`.
  const hostControlReport = sandboxControlReport("local-process");

  return {
    adapterId: manifest.adapter_id,
    adapterVersion: manifest.version,
    adapterOwner: manifest.owner,
    manifestHash,
    declarationHash,
    adapterArtifactHash: manifest.adapter_artifact_hash,
    profile,
    trustMode: "trusted_local_code",
    tier: "development",
    authenticity: "owner_asserted_unauthenticated",
    independentCertification: "absent",
    confinement: "absent",
    hostControlReport,
  };
}

/**
 * Decides which controls a trusted-local run may proceed without.
 *
 * The certification path compared a manifest's requirement against a
 * *certifier's claim* that the control was enforced. There is no certifier
 * here, so there is no claim — the requirement is compared against the host's
 * own report instead, which is both the only available check and the stronger
 * one.
 *
 * A control the host cannot enforce does not automatically stop the run,
 * because the `local-process` profile honestly reports thirteen container-only
 * controls as unsupported and refusing on all of them would make this path
 * unreachable rather than safe. It stops the run unless the *plan* named that
 * control and declared `unsupported_permitted` — the operator deciding, in
 * frozen bytes, to proceed without it. Silence is a refusal: a control the
 * manifest requires and the plan never mentions must be enforced.
 */
export function assertTrustedLocalControls(
  profile: SubjectAdapterProtocolProfileV2,
  planExpectations: readonly {
    readonly control_id: string;
    readonly required_state: "enforced" | "unsupported_permitted";
  }[],
  hostControlReport: readonly SandboxControlReportV2[],
): void {
  const expectationOf = new Map(
    planExpectations.map((expectation) => [expectation.control_id, expectation.required_state]),
  );
  const stateOf = new Map(
    hostControlReport.map((control) => [control.control_id as string, control.state]),
  );

  for (const control of profile.required_controls) {
    const enforced = stateOf.get(control) === "enforced";
    if (enforced) continue;
    if (expectationOf.get(control) === "unsupported_permitted") continue;
    throw new Erl2Error(
      CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
      `the adapter requires control ${control}, which this host reports as ` +
        `${stateOf.get(control) ?? "absent"} and the plan does not permit proceeding without`,
      { owner: "lab" },
    );
  }

  // The plan's own expectations, against the same report. A plan may require a
  // control the manifest did not, and it may not require one this host lacks.
  for (const expectation of planExpectations) {
    const state = stateOf.get(expectation.control_id);
    if (state === undefined || (expectation.required_state === "enforced" && state !== "enforced")) {
      throw new Erl2Error(
        CODES.ADAPTER_SANDBOX_CONTROL_UNSUPPORTED,
        `local observation requires unavailable control ${expectation.control_id}`,
        { owner: "lab" },
      );
    }
  }
}

/**
 * The ceiling a trusted-local declaration must state about itself.
 *
 * Separated from the binding checks because it is a different kind of refusal:
 * these are the claims a development-tier owner declaration may never make,
 * regardless of whose bytes it names.
 */
export function assertTrustedLocalClaimCeiling(
  declaration: TrustedLocalAdapterDeclarationV1,
): void {
  const claims = declaration.excluded_claims;
  const ceilingHolds =
    declaration.not_scored === true &&
    declaration.not_governor_authorized === true &&
    declaration.not_independently_certified === true &&
    declaration.not_confined === true &&
    declaration.not_production_ready === true &&
    declaration.independent_certifier === null &&
    declaration.certifier_is_adapter_owner === "not_applicable" &&
    declaration.evidence_authenticity === "owner_asserted_unauthenticated" &&
    claims.length === LOCAL_OBSERVATION_UNSUPPORTED_CLAIMS.length &&
    claims.every((claim, index) => claim === LOCAL_OBSERVATION_UNSUPPORTED_CLAIMS[index]);
  if (!ceilingHolds) {
    throw new Erl2Error(
      CODES.ADAPTER_TRUSTED_LOCAL_CLAIM_CEILING_EXCEEDED,
      "the trusted-local declaration claims more than an owner-operated development observation can support",
      { owner: "lab" },
    );
  }
  if (declaration.owner_test_evidence !== null) {
    // Retained, labelled, and believed by nobody. The only rule is that it
    // cannot describe itself as anything stronger than owner-supplied.
    if (declaration.owner_test_evidence.authenticity !== "owner_supplied_unauthenticated") {
      throw new Erl2Error(
        CODES.ADAPTER_TRUSTED_LOCAL_CLAIM_CEILING_EXCEEDED,
        "owner-supplied test evidence may not claim any authenticity beyond owner_supplied_unauthenticated",
        { owner: "lab" },
      );
    }
  }
}
