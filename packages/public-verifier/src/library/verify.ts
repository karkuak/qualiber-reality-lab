/**
 * Offline verification of a `PublicVerificationBundleV2` and of an
 * `InvalidLabRunRecordV1` (ERL2-FR-011/027).
 *
 * Both entry points work with the network disabled.  Trust roots and the
 * current head come only from verifier-controlled local configuration; the
 * bundle's own policy, inventory and checkpoints are evidence to validate.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type EnvironmentFinalLabAttestationV1,
  type EnvironmentPublicVerificationBundleV2,
  type EnvironmentSignerInventoryV2,
  type Hash,
  type InvalidLabRunRecordV1,
  type LabLifecycleEventV1,
  type MandatoryGraphClosureReportV1,
  type PreEnvironmentFinalLabAttestationV1,
  type PreEnvironmentPublicVerificationBundleV2,
  type PreEnvironmentSignerInventoryV2,
  type TrustedTimestampCheckpointV1,
  type TrustPolicyManifestV2,
} from "@erl2/contracts";
import { verifySelectionChain } from "@erl2/core";
import {
  coreHash,
  TrustEvaluator,
  verifyCheckpointChain,
  type LocalTrustConfiguration,
} from "@erl2/integrity";
import { ArtifactIndex } from "./artifactIndex.js";
import { assertClaimScopeWithinCeiling, deriveClaimCeiling } from "./claimScope.js";
import { derivePreEnvironmentClosure, deriveInvalidClosure } from "./closure.js";
import { deriveEnvironmentClosure, deriveTerminalVariant } from "./environmentClosure.js";
import {
  deriveEnvironmentSemantics,
  deriveInvalidEnvironmentSemantics,
} from "./environmentDerivation.js";
import { verifyReferencedBytes } from "./referencedBytes.js";
import { verifyRetainedFileAccounting } from "./retainedFiles.js";
import { verifySignedMembers } from "./signedMembers.js";
import { assertNoSelectionArtifacts, deriveSelectionEvidence } from "./selectionEvidence.js";

/**
 * Cross-checks an attestation binding hash against the retained artifact the
 * verifier-derived closure (or a recomputed bundle member) selected.  A
 * self-consistent bundle whose attestation names a *different* retained artifact
 * is refused, not trusted (P2-3, design §16.3).
 */
function assertBinding(declared: Hash, derived: Hash | undefined, label: string): void {
  if (derived === undefined || declared !== derived) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      `attestation ${label} binding does not match the retained artifact the closure derived`,
    );
  }
}

/** Digest of this verifier release, recorded in every closure report. */
export const VERIFIER_RELEASE_HASH: Hash =
  "sha256:0000000000000000000000000000000000000000000000000000000000000001";

export interface VerifyBundleOptions {
  readonly bundle: unknown;
  readonly artifactRoot: string;
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly localTrust: LocalTrustConfiguration;
  readonly verifiedAt: string;
  /** Verification never uses the network; `false` is a usage error. */
  readonly offline: true;
}

export interface BundleVerificationResult {
  readonly verdict: "valid" | "invalid";
  readonly closure: MandatoryGraphClosureReportV1;
  readonly attestationHash: Hash;
  readonly trustHeadHash: Hash;
  readonly validWhenSigned: boolean;
  readonly currentlyTrusted: boolean;
}

/**
 * Verifies a `PublicVerificationBundleV2` of either terminal variant.
 *
 * The variant is *derived* from the retained terminal run record before the
 * bundle's own `terminal_variant` is believed, so a bundle that declares the
 * wrong branch is a typed crossover refusal rather than a closure that checks
 * the wrong role set (design v2 §16.3, ERL2-AC-023).
 */
export function verifyPublicBundle(options: VerifyBundleOptions): BundleVerificationResult {
  if (options.offline !== true) {
    throw new Erl2Error(CODES.VERIFY_OFFLINE_REQUIRED, "public verification runs offline only");
  }
  const declaredVariant = (options.bundle as { terminal_variant?: unknown } | null)?.terminal_variant;
  if (declaredVariant !== "pre_environment" && declaredVariant !== "environment") {
    throw new Erl2Error(
      CODES.BUNDLE_VARIANT_MISMATCH,
      `a public bundle must declare terminal_variant pre_environment or environment, got ${String(declaredVariant)}`,
    );
  }
  const derivedVariant = deriveTerminalVariant(ArtifactIndex.scan(options.artifactRoot));
  if (derivedVariant !== declaredVariant) {
    throw new Erl2Error(
      CODES.BUNDLE_VARIANT_MISMATCH,
      `bundle declares terminal_variant ${declaredVariant}, but the retained run record derives ${derivedVariant}`,
    );
  }
  return declaredVariant === "environment"
    ? verifyEnvironmentBundle(options)
    : verifyPreEnvironmentBundle(options);
}

function verifyPreEnvironmentBundle(options: VerifyBundleOptions): BundleVerificationResult {
  const bundle = assertContract<PreEnvironmentPublicVerificationBundleV2>(
    "PreEnvironmentPublicVerificationBundleV2",
    options.bundle,
  );
  if (bundle.verification_trust_head_source !== "local_root_pinned_configuration") {
    throw new Erl2Error(
      CODES.TRUST_HEAD_SELF_ANCHORED,
      "bundle attempts to name its own trust head source",
    );
  }
  if (bundle.execution_artifacts.length !== 0) {
    throw new Erl2Error(CODES.BUNDLE_MEMBER_EXTRA, "public bundle carries an execution body");
  }

  const index = ArtifactIndex.scan(options.artifactRoot);

  // Every referenced raw payload is rehashed from disk before any verdict is
  // formed (P2-2, ERL2-AC-013).
  verifyReferencedBytes(index);

  // Trust policy: presented as a bundle member, authorized only by local pins.
  const policy = index.typed<TrustPolicyManifestV2>(
    bundle.run_trust_policy.artifact_core_hash,
    "trust-policy-manifest/v2",
  );
  const trust = new TrustEvaluator(policy, options.localTrust);
  const trustHeadHash = coreHash(policy);

  // Timestamp chain.
  const chain: TrustedTimestampCheckpointV1[] = bundle.acquisition_timestamp_checkpoint_chain.map((m) =>
    index.typed<TrustedTimestampCheckpointV1>(m.artifact_core_hash, "trusted-timestamp-checkpoint/v1"),
  );
  verifyCheckpointChain(chain, trust);

  // Final attestation.
  const attestation = index.typed<PreEnvironmentFinalLabAttestationV1>(
    bundle.final_attestation.artifact_core_hash,
    "pre-environment-final-lab-attestation/v1",
  );
  assertContract("PreEnvironmentFinalLabAttestationV1", attestation);
  const verdictAtSigning = trust.verifyRoleSignature({
    value: attestation,
    signature: attestation.signature,
    role: "final_attestation_signer",
    schemaVersion: attestation.schema_version,
    securityTimestamp: attestation.finalized_at,
  });
  if (attestation.run_trust_policy_hash !== trustHeadHash) {
    throw new Erl2Error(
      CODES.TRUST_HEAD_NOT_LOCALLY_PINNED,
      "attestation references a trust policy other than the pinned head",
    );
  }
  if (attestation.lab_validity !== "valid") {
    throw new Erl2Error(CODES.BUNDLE_VARIANT_MISMATCH, "a public bundle cannot carry an invalid verdict");
  }
  if (!["T1", "T2", "T3"].includes(attestation.claim_scope)) {
    throw new Erl2Error(CODES.BUNDLE_VARIANT_MISMATCH, "base attestations may only claim T1-T3");
  }

  // Signer inventory: recomputed, never trusted.
  const inventory = index.typed<PreEnvironmentSignerInventoryV2>(
    bundle.signer_inventory.artifact_core_hash,
    "signer-inventory/v2",
  );
  assertContract("PreEnvironmentSignerInventoryV2", inventory);
  // The inventory is itself a signed member; its Ed25519 signature must verify
  // under an authorized role, not merely have a correct core_hash (P2-3).
  trust.verifyRoleSignature({
    value: inventory,
    signature: inventory.signature,
    role: "final_attestation_signer",
    schemaVersion: inventory.schema_version,
    securityTimestamp: inventory.inventoried_at,
  });
  if (inventory.terminal_variant !== "pre_environment") {
    throw new Erl2Error(CODES.BUNDLE_VARIANT_MISMATCH, "signer inventory variant does not match the bundle");
  }
  if (inventory.excluded_public_terminal_types.includes(attestation.schema_version) === false) {
    throw new Erl2Error(
      CODES.INVENTORY_ENTRY_EXTRA,
      "signer inventory must exclude the public terminal attestation type",
    );
  }
  for (const entry of inventory.entries) {
    if (entry.artifact_schema_version === attestation.schema_version) {
      throw new Erl2Error(
        CODES.INVENTORY_ENTRY_EXTRA,
        "signer inventory includes the excluded public terminal type",
      );
    }
    index.get(entry.artifact_core_hash);
    trust.evaluate(entry.signer_key_id, entry.security_timestamp);
  }

  // Independently derived mandatory closure.
  const closure = derivePreEnvironmentClosure({
    lifecycle: options.lifecycle,
    index,
    verifierReleaseHash: VERIFIER_RELEASE_HASH,
    verifiedAt: options.verifiedAt,
    verifiedTrustHeadHash: trustHeadHash,
  });
  if (closure.verdict !== "valid") {
    return {
      verdict: "invalid",
      closure,
      attestationHash: coreHash(attestation),
      trustHeadHash,
      validWhenSigned: verdictAtSigning.validWhenSigned,
      currentlyTrusted: verdictAtSigning.currentlyTrusted,
    };
  }
  // Supplement the closure's `rejected_extra_hashes` rule with the files the
  // artifact index could not parse at all (a non-JSON payload, a strict-JSON
  // refusal, a JSON array, an object with no `core_hash`).  Those are equally
  // unaccounted retained bytes (ERL2-FR-020 / ERL2-AC-023, design §14 step 6-7).
  // Derived *after* the closure so a genuinely missing mandatory role keeps its
  // own, more fundamental cause rather than surfacing as its orphaned marker.
  // §6.4 — every *other* signed member is verified too.  The attestation, the
  // inventory, the trust root and the checkpoints were already checked above;
  // this closes the five that rode in on hash closure alone (the acquisition
  // source manifest, preregistration, its receipt, the adapter manifest and the
  // generic run policy), cross-checks the inventory's claims against what is
  // actually retained, and refuses any retained signed contract the verifier
  // declares no authorized signer role for.
  verifySignedMembers({
    index,
    trust,
    asOf: attestation.finalized_at,
    inventoryEntries: inventory.entries,
  });
  verifyRetainedFileAccounting(index);
  // A pre-environment terminal has no selection, so retaining any selection
  // contract is a branch crossover rather than a partial chain.
  //
  // Defense in depth, and honestly so: the closure's rejected-extra rule already
  // refuses such an artifact first, because no pre-environment role can ever
  // derive one. Verified by removing this line — the CLI still refuses. It is
  // kept because the refusal it *replaces* is now gone: until the selection
  // rows were declared (ADR-ERL2-020 §2), a stray selection member was caught as
  // an undeclared signed contract. Declaring the roles removed that gate, and a
  // named check for the crossover is cheaper than relying on a general rule to
  // keep covering a specific hazard.
  assertNoSelectionArtifacts(index);
  if (attestation.run_record_hash !== requiredHash(closure, "run-record")) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "attestation does not attest the derived terminal run record",
    );
  }
  // Every remaining attestation binding is cross-checked against the retained
  // artifact the derived closure selected — a self-consistent bundle whose
  // attestation points at a different retained artifact is refused (P2-3).
  const checkpointHead = chain[chain.length - 1];
  assertBinding(attestation.signer_inventory_hash, coreHash(inventory), "signer inventory");
  assertBinding(
    attestation.signer_inventory_hash,
    bundle.signer_inventory.artifact_core_hash,
    "signer inventory bundle member",
  );
  assertBinding(
    attestation.acquisition_preregistration_verification_receipt_hash,
    bundle.acquisition_preregistration_verification_receipt.artifact_core_hash,
    "acquisition preregistration receipt",
  );
  if (checkpointHead !== undefined) {
    assertBinding(attestation.timestamp_checkpoint_hash, coreHash(checkpointHead), "timestamp checkpoint");
  }
  assertBinding(
    attestation.acquisition_source_manifest_hash,
    requiredHash(closure, "acquisition-source-manifest"),
    "acquisition source manifest",
  );
  assertBinding(
    attestation.acquisition_record_hash,
    requiredHash(closure, "acquisition-record"),
    "acquisition record",
  );
  assertBinding(
    attestation.generic_evaluation_index_hash,
    requiredHash(closure, "generic-evaluation-index"),
    "generic evaluation index",
  );
  assertBinding(
    attestation.cleanup.verification_hash,
    requiredHash(closure, "pre-environment-cleanup"),
    "cleanup verification",
  );
  // Adapter identity and generic run policy must be retained artifacts; a
  // dangling binding is a missing-artifact refusal.
  index.get(attestation.adapter_hash);
  index.get(attestation.generic_run_policy_hash);

  // -- ADR-ERL2-025: how strongly this run may be spoken about ---------------
  //
  // Derived here from retained bytes alone, independently of whatever the
  // producer chose. `claim_scope` used to be `flags["claim-scope"] ?? "T1"` on
  // one side and `["T1","T2","T3"].includes(...)` on the other, so an operator
  // could sign T3 over a run that measured nothing (review P2).
  assertClaimScopeWithinCeiling({
    claimScope: attestation.claim_scope,
    report: deriveClaimCeiling({
      index,
      lifecycle: options.lifecycle,
      terminalVariant: "pre_environment",
    }),
    who: "this attestation",
  });

  return {
    verdict: "valid",
    closure,
    attestationHash: coreHash(attestation),
    trustHeadHash,
    validWhenSigned: verdictAtSigning.validWhenSigned,
    currentlyTrusted: verdictAtSigning.currentlyTrusted,
  };
}

/**
 * Offline verification of an environment terminal.
 *
 * Structurally the same seven checks as the pre-environment path — trust
 * policy, timestamp chain, attestation signature, validity, claim scope,
 * recomputed signer inventory, independently derived closure — plus the two the
 * environment branch adds:
 *
 *   - the bundle's `selection_verification_receipt` must be the receipt the
 *     attestation attests, so a reader can check that the challenge answered is
 *     the one the protocol selected; and
 *   - the attestation's cleanup pair must name the restoration and teardown the
 *     derived closure reached, so a valid terminal cannot be signed over a
 *     different run's cleanup.
 */
function verifyEnvironmentBundle(options: VerifyBundleOptions): BundleVerificationResult {
  const bundle = assertContract<EnvironmentPublicVerificationBundleV2>(
    "EnvironmentPublicVerificationBundleV2",
    options.bundle,
  );
  if (bundle.verification_trust_head_source !== "local_root_pinned_configuration") {
    throw new Erl2Error(
      CODES.TRUST_HEAD_SELF_ANCHORED,
      "bundle attempts to name its own trust head source",
    );
  }
  if (bundle.execution_artifacts.length !== 0) {
    throw new Erl2Error(CODES.BUNDLE_MEMBER_EXTRA, "public bundle carries an execution body");
  }

  const index = ArtifactIndex.scan(options.artifactRoot);
  verifyReferencedBytes(index);

  const policy = index.typed<TrustPolicyManifestV2>(
    bundle.run_trust_policy.artifact_core_hash,
    "trust-policy-manifest/v2",
  );
  const trust = new TrustEvaluator(policy, options.localTrust);
  const trustHeadHash = coreHash(policy);

  const chain: TrustedTimestampCheckpointV1[] =
    bundle.selected_run_timestamp_checkpoint_chain.map((m) =>
      index.typed<TrustedTimestampCheckpointV1>(
        m.artifact_core_hash,
        "trusted-timestamp-checkpoint/v1",
      ),
    );
  verifyCheckpointChain(chain, trust);

  const attestation = index.typed<EnvironmentFinalLabAttestationV1>(
    bundle.final_attestation.artifact_core_hash,
    "environment-final-lab-attestation/v1",
  );
  assertContract("EnvironmentFinalLabAttestationV1", attestation);
  const verdictAtSigning = trust.verifyRoleSignature({
    value: attestation,
    signature: attestation.signature,
    role: "final_attestation_signer",
    schemaVersion: attestation.schema_version,
    securityTimestamp: attestation.finalized_at,
  });
  if (attestation.run_trust_policy_hash !== trustHeadHash) {
    throw new Erl2Error(
      CODES.TRUST_HEAD_NOT_LOCALLY_PINNED,
      "attestation references a trust policy other than the pinned head",
    );
  }
  // `attestation.lab_validity` is a *schema constant* — the producer writes
  // `lab_validity: "valid" as const` — so reading it here proves nothing about
  // the run. It is checked only to catch a malformed document; the verdict that
  // matters is re-derived from the retained validity result below, together with
  // restoration, teardown and the substrate binding (ADR-ERL2-024 §4.6).
  if (attestation.lab_validity !== "valid") {
    throw new Erl2Error(
      CODES.BUNDLE_VARIANT_MISMATCH,
      "a public bundle cannot carry an invalid verdict",
    );
  }
  if (!["T1", "T2", "T3"].includes(attestation.claim_scope)) {
    throw new Erl2Error(CODES.BUNDLE_VARIANT_MISMATCH, "base attestations may only claim T1-T3");
  }
  if (attestation.run_id !== bundle.run_id) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "the bundle and the attestation name different runs",
    );
  }
  // The selection receipt is a bundle member *and* an attestation member; a
  // mismatch would let a bundle present a different challenge's receipt.
  if (
    attestation.selection_receipt_hash !==
    bundle.selection_verification_receipt.artifact_core_hash
  ) {
    throw new Erl2Error(
      CODES.BUNDLE_MEMBER_MISMATCH,
      "the bundle presents a selection verification receipt the attestation does not attest",
    );
  }
  index.get(attestation.exposure_event_hash);

  const inventory = index.typed<EnvironmentSignerInventoryV2>(
    bundle.signer_inventory.artifact_core_hash,
    "signer-inventory/v2",
  );
  assertContract("EnvironmentSignerInventoryV2", inventory);
  trust.verifyRoleSignature({
    value: inventory,
    signature: inventory.signature,
    role: "final_attestation_signer",
    schemaVersion: inventory.schema_version,
    securityTimestamp: inventory.inventoried_at,
  });
  if (inventory.terminal_variant !== "environment") {
    throw new Erl2Error(
      CODES.BUNDLE_VARIANT_MISMATCH,
      "signer inventory variant does not match the bundle",
    );
  }
  if (!inventory.excluded_public_terminal_types.includes(attestation.schema_version)) {
    throw new Erl2Error(
      CODES.INVENTORY_ENTRY_EXTRA,
      "signer inventory must exclude the public terminal attestation type",
    );
  }
  const excluded = new Set<string>(inventory.excluded_public_terminal_types);
  for (const entry of inventory.entries) {
    if (excluded.has(entry.artifact_schema_version)) {
      throw new Erl2Error(
        CODES.INVENTORY_ENTRY_EXTRA,
        `signer inventory includes the excluded public terminal type ${entry.artifact_schema_version}`,
      );
    }
    index.get(entry.artifact_core_hash);
    trust.evaluate(entry.signer_key_id, entry.security_timestamp);
  }

  const closure = deriveEnvironmentClosure({
    lifecycle: options.lifecycle,
    index,
    verifierReleaseHash: VERIFIER_RELEASE_HASH,
    verifiedAt: options.verifiedAt,
    verifiedTrustHeadHash: trustHeadHash,
  });
  if (closure.verdict !== "valid") {
    return {
      verdict: "invalid",
      closure,
      attestationHash: coreHash(attestation),
      trustHeadHash,
      validWhenSigned: verdictAtSigning.validWhenSigned,
      currentlyTrusted: verdictAtSigning.currentlyTrusted,
    };
  }
  // Supplement the closure's `rejected_extra_hashes` rule with the files the
  // artifact index could not parse at all (a non-JSON payload, a strict-JSON
  // refusal, a JSON array, an object with no `core_hash`).  Those are equally
  // unaccounted retained bytes (ERL2-FR-020 / ERL2-AC-023, design §14 step 6-7).
  // Derived *after* the closure so a genuinely missing mandatory role keeps its
  // own, more fundamental cause rather than surfacing as its orphaned marker.
  // §6.4 — every *other* signed member is verified too.  The attestation, the
  // inventory, the trust root and the checkpoints were already checked above;
  // this closes the five that rode in on hash closure alone (the acquisition
  // source manifest, preregistration, its receipt, the adapter manifest and the
  // generic run policy), cross-checks the inventory's claims against what is
  // actually retained, and refuses any retained signed contract the verifier
  // declares no authorized signer role for.
  verifySignedMembers({
    index,
    trust,
    asOf: attestation.finalized_at,
    inventoryEntries: inventory.entries,
  });
  verifyRetainedFileAccounting(index);
  if (attestation.run_record_hash !== requiredHash(closure, "run-record")) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "attestation does not attest the derived terminal run record",
    );
  }
  if (attestation.cleanup.restoration_hash !== requiredHash(closure, "environment-restoration")) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "attestation attests a restoration the derived closure did not reach",
    );
  }
  if (attestation.cleanup.teardown_hash !== requiredHash(closure, "teardown-verification")) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "attestation attests a teardown the derived closure did not reach",
    );
  }
  if (
    attestation.selection_receipt_hash !== requiredHash(closure, "selection-verification-receipt")
  ) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "attestation attests a selection receipt the derived closure did not reach",
    );
  }

  // -- the attestation bindings the environment path was missing -------------
  //
  // The pre-environment path cross-checks nine of these; the environment path
  // checked three, so a self-consistent bundle whose attestation named a
  // *different* retained artifact was believed for the other six (review P1-11).
  // The signer-inventory binding is the sharpest of them: without it, an
  // attestation could attest an inventory the bundle does not carry.
  const environmentCheckpointHead = chain[chain.length - 1];
  assertBinding(attestation.signer_inventory_hash, coreHash(inventory), "signer inventory");
  assertBinding(
    attestation.signer_inventory_hash,
    bundle.signer_inventory.artifact_core_hash,
    "signer inventory bundle member",
  );
  assertBinding(
    attestation.acquisition_preregistration_verification_receipt_hash,
    bundle.acquisition_preregistration_verification_receipt.artifact_core_hash,
    "acquisition preregistration receipt",
  );
  if (environmentCheckpointHead !== undefined) {
    assertBinding(
      attestation.timestamp_checkpoint_hash,
      coreHash(environmentCheckpointHead),
      "timestamp checkpoint",
    );
  }
  assertBinding(
    attestation.acquisition_source_manifest_hash,
    requiredHash(closure, "acquisition-source-manifest"),
    "acquisition source manifest",
  );
  assertBinding(
    attestation.acquisition_record_hash,
    requiredHash(closure, "acquisition-record"),
    "acquisition record",
  );
  assertBinding(
    attestation.subject_package_manifest_hash,
    requiredHash(closure, "subject-package-manifest"),
    "subject package manifest",
  );
  assertBinding(
    attestation.generic_evaluation_index_hash,
    requiredHash(closure, "generic-evaluation-index"),
    "generic evaluation index",
  );
  // Adapter identity and generic run policy must be retained artifacts; a
  // dangling binding is a missing-artifact refusal.
  index.get(attestation.adapter_hash);
  index.get(attestation.generic_run_policy_hash);

  // -- §4.6: the semantic derivation the verifier owns -----------------------
  //
  // Run last, so a genuinely missing role keeps its own, more fundamental cause
  // rather than surfacing as a derived-verdict mismatch. This is where
  // `lab_validity`, `EnvironmentValidityResultV1.status`, restoration `passed`,
  // teardown `passed` and the emergency safe/unsafe classification stop being
  // believed and start being recomputed.
  deriveEnvironmentSemantics({
    index,
    lifecycle: options.lifecycle,
    runId: attestation.run_id,
  });

  // -- ADR-ERL2-025: how strongly this run may be spoken about ---------------
  //
  // The environment branch carries the evidence that matters most here — the
  // driver's own kind, the tier the challenge was drawn at, the selection
  // assurance and whether the domain plane was evaluated at all — and every one
  // of them was ignored while `--claim-scope` decided the answer.
  assertClaimScopeWithinCeiling({
    claimScope: attestation.claim_scope,
    report: deriveClaimCeiling({
      index,
      lifecycle: options.lifecycle,
      terminalVariant: "environment",
      selectionAssurance: attestation.selection_assurance,
    }),
    who: "this attestation",
  });

  // -- §8.5: the selection chain, verified offline ---------------------------
  //
  // The evidence is assembled by the verifier from retained bytes, never from a
  // producer-supplied member list, and the chain is then re-derived from scratch
  // — pool root, source/request binding, derived index, rejection count. This is
  // the third independent derivation of the same selection: the producer's, the
  // auditor's (ADR-ERL2-020 §7), and this one.
  const selectionEvidence = deriveSelectionEvidence(index, options.lifecycle);
  const selection = verifySelectionChain(selectionEvidence, trust);

  // The *verified* entry decides what this run answered — not any field the
  // producer wrote. A bundle whose binding names a different entry than the
  // chain derives is refused here rather than believed.
  if (selection.selectedEntryHash !== selectionEvidence.binding.pool_entry_hash) {
    throw new Erl2Error(
      CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
      `the verified selection derives entry ${selection.selectedEntryHash}, but the retained ` +
        `binding names ${selectionEvidence.binding.pool_entry_hash}`,
    );
  }
  // And the receipt the attestation attests must be the one the chain verified.
  if (coreHash(selectionEvidence.receipt) !== attestation.selection_receipt_hash) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_TERMINAL_MISMATCH,
      "the verified selection receipt is not the one the attestation attests",
    );
  }

  return {
    verdict: "valid",
    closure,
    attestationHash: coreHash(attestation),
    trustHeadHash,
    validWhenSigned: verdictAtSigning.validWhenSigned,
    currentlyTrusted: verdictAtSigning.currentlyTrusted,
  };
}

function requiredHash(closure: MandatoryGraphClosureReportV1, role: string): Hash | undefined {
  return closure.required_hashes_by_role.find((r) => r.role === role)?.ordered_hashes[0];
}

export interface VerifyRecordOptions {
  readonly record: unknown;
  readonly artifactRoot: string;
  readonly lifecycle: readonly LabLifecycleEventV1[];
  readonly localTrust: LocalTrustConfiguration;
  readonly verifiedAt: string;
  readonly offline: true;
}

/**
 * `erl2 verify-record`.  Accepts exactly an invalid run record; a valid record,
 * an attestation or any bundle is refused.
 */
export function verifyInvalidRecord(options: VerifyRecordOptions): MandatoryGraphClosureReportV1 {
  if (options.offline !== true) {
    throw new Erl2Error(CODES.VERIFY_OFFLINE_REQUIRED, "record verification runs offline only");
  }
  const candidate = options.record as Record<string, unknown>;
  const schemaVersion = candidate["schema_version"];
  if (schemaVersion === "public-verification-bundle/v2") {
    throw new Erl2Error(
      CODES.VERIFY_RECORD_ATTESTATION_PRESENT,
      "verify-record does not accept a public verification bundle",
    );
  }
  if (schemaVersion !== "invalid-lab-run-record/v1") {
    throw new Erl2Error(
      CODES.VERIFY_RECORD_EXPECTED_INVALID_RECORD,
      `verify-record expects invalid-lab-run-record/v1, got ${String(schemaVersion)}`,
    );
  }
  const record = assertContract<InvalidLabRunRecordV1>("InvalidLabRunRecordV1", options.record);
  const index = ArtifactIndex.scan(options.artifactRoot);
  verifyReferencedBytes(index);
  const indexed = index.tryGet(coreHash(record));
  if (!indexed) {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_UNREACHABLE_ARTIFACT,
      "the supplied invalid record is not retained beneath the artifact root",
    );
  }
  const closure = deriveInvalidClosure({
    lifecycle: options.lifecycle,
    index,
    verifierReleaseHash: VERIFIER_RELEASE_HASH,
    verifiedAt: options.verifiedAt,
  });
  // Fail closed: an invalid-record closure whose verdict is not `valid` (an
  // unaccounted retained extra, a crossover) must not be reported as ok (P2-4,
  // ERL2-AC-031).  The only invalid cause for this derivation is a rejected
  // extra, so preserve that specific cause rather than a generic closure code.
  if (closure.verdict !== "valid") {
    throw new Erl2Error(
      CODES.GRAPH_CLOSURE_EXTRA_ARTIFACT,
      `verify-record refuses an invalid closure: ${String(closure.rejected_extra_hashes.length)} unaccounted retained artifact(s)`,
    );
  }
  // Supplement the closure's `rejected_extra_hashes` rule with the files the
  // artifact index could not parse at all (a non-JSON payload, a strict-JSON
  // refusal, a JSON array, an object with no `core_hash`).  Those are equally
  // unaccounted retained bytes (ERL2-FR-020 / ERL2-AC-023, design §14 step 6-7).
  // Derived *after* the closure so a genuinely missing mandatory role keeps its
  // own, more fundamental cause rather than surfacing as its orphaned marker.
  verifyRetainedFileAccounting(index);

  // §6.4 on the invalid branch.  An invalid record carries no attestation and no
  // signer inventory, but it does retain signed members (the acquisition source
  // manifest, preregistration, its receipt, the adapter manifest, the generic run
  // policy and — on a cancellation — the signed cancellation request).  None of
  // them was signature-verified before this pass.  The run mirrors its trust
  // policy at preregistration; it is authorized here only against the verifier's
  // own locally pinned head, never accepted on its own say-so.
  const mirrored = index.ofSchema("trust-policy-manifest/v2");
  if (mirrored.length !== 1) {
    throw new Erl2Error(
      CODES.TRUST_HEAD_NOT_LOCALLY_PINNED,
      `an invalid record must retain exactly one mirrored trust policy to authorize its signed members; found ${String(mirrored.length)}`,
    );
  }
  const mirroredPolicy = index.typed<TrustPolicyManifestV2>(
    (mirrored[0] as { coreHash: Hash }).coreHash,
    "trust-policy-manifest/v2",
  );
  const recordTrust = new TrustEvaluator(mirroredPolicy, options.localTrust);
  verifySignedMembers({ index, trust: recordTrust, asOf: record.invalidated_at });

  // ADR-ERL2-024 §4.6 on the invalid branch. An invalid record carries no
  // attestation, so its cleanup claims are the *only* statement that a failed
  // run cleaned up — which is exactly why they must be re-derived rather than
  // read. A cancellation that claimed `not_required` over a live environment
  // verified at exit 0 before this pass existed (review P1-2).
  deriveInvalidEnvironmentSemantics({ index, lifecycle: options.lifecycle, record });
  return closure;
}
