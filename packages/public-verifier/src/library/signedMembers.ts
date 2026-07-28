/**
 * Independent verification of **every** signed artifact in a verification
 * closure (design §16.3, remediation §6.4).
 *
 * The offline verifier used to check Ed25519 on the final attestation, the
 * signer inventory, the trust policy root and the timestamp checkpoints — and
 * nothing else.  Every other signed member rode in on hash closure alone.
 * Reproduced against the shipped CLI on the `valid-pre-environment-run` bundle:
 * corrupting one base64 character of the signature on
 *
 *   - `acquisition-source-manifest/v1`
 *   - `acquisition-preregistration/v1`
 *   - `acquisition-preregistration-verification-receipt/v1`
 *   - `subject-adapter-manifest/v1`
 *   - `generic-run-policy/v1`
 *
 * left `erl2 verify … --offline` reporting exit 0 / `valid`.  A signature field
 * is excluded from `core_hash` by design (it is authority, not identity), so the
 * hash chain cannot catch this: only verifying the signature can.  All five are
 * named by the run's own signer inventory as `complete_for_terminal_chain`.
 *
 * The table below is **verifier-owned**: the expected signer role for a contract
 * is the verifier's policy, never the producer's claim, so a bundle that signs
 * the adapter manifest with the preregistrar's key is refused even though both
 * keys are pinned.  Any retained artifact that carries a signature field but has
 * no declared role is refused outright — a signed contract the verifier does not
 * know how to authorize must never be waved through (the fail-closed posture the
 * environment and selection branches inherit when Slice 6.5 lands).
 */

import { CODES, Erl2Error } from "@erl2/contracts";
import { SIGNATURE_DOMAINS, type SignatureDomain, type SignerRole, type TrustEvaluator } from "@erl2/integrity";
import type { ArtifactIndex, IndexedArtifact } from "./artifactIndex.js";

/** The authority-bearing signature fields; all are excluded from `core_hash`. */
const SIGNATURE_FIELDS = ["signature", "root_signature", "wrapper_signature"] as const;

interface SignedMemberRule {
  /** The role the pinned trust policy must grant the signing key. */
  readonly role: SignerRole;
  /**
   * The domain the signature is separated under.  Most contracts are sealed
   * under `ERL2`; the trust-policy root and the timestamp checkpoints predate it
   * and are sealed under `LEGACY_V1`.  Verifying under the wrong domain fails
   * closed, so the domain is part of the verifier's declared expectation
   * (remediation §6.4).
   */
  readonly domain?: SignatureDomain;
  /**
   * The artifact's own security instant, used for revocation evaluation when the
   * signer inventory does not carry one for it.
   */
  readonly securityTimestampField?: string;
}

/**
 * Every signed contract that may be retained in a shipped verification closure.
 * Extending this table is how a new signed contract becomes verifiable; until it
 * is listed, retaining one is a refusal.
 */
const SIGNED_MEMBER_RULES = new Map<string, SignedMemberRule>([
  [
    "trust-policy-manifest/v2",
    { role: "trust_root", domain: SIGNATURE_DOMAINS.LEGACY_V1, securityTimestampField: "issued_at" },
  ],
  [
    "trusted-timestamp-checkpoint/v1",
    {
      role: "timestamp_authority",
      domain: SIGNATURE_DOMAINS.LEGACY_V1,
      securityTimestampField: "checkpointed_at",
    },
  ],
  ["signer-inventory/v2", { role: "final_attestation_signer", securityTimestampField: "inventoried_at" }],
  [
    "pre-environment-final-lab-attestation/v1",
    { role: "final_attestation_signer", securityTimestampField: "finalized_at" },
  ],
  [
    "environment-final-lab-attestation/v1",
    { role: "final_attestation_signer", securityTimestampField: "finalized_at" },
  ],
  ["cancellation-request/v1", { role: "final_attestation_signer", securityTimestampField: "requested_at" }],
  ["acquisition-source-manifest/v1", { role: "policy_author" }],
  ["generic-run-policy/v1", { role: "policy_author" }],
  ["acquisition-preregistration/v1", { role: "preregistrar", securityTimestampField: "registered_at" }],
  [
    "acquisition-preregistration-verification-receipt/v1",
    { role: "preregistrar", securityTimestampField: "verified_at" },
  ],
  ["subject-adapter-manifest/v1", { role: "adapter_owner" }],
  ["subject-package-manifest/v1", { role: "adapter_owner" }],
  // Environment-branch members.  They already appear in an *invalid* record that
  // failed after provisioning (the emergency-cleanup terminal), so their roles
  // are declared now rather than left to fail closed on a shipped path.
  ["environment-driver-manifest/v1", { role: "environment_governor" }],
  ["environment-archetype/v1", { role: "environment_governor" }],
  ["environment-cleanup-contract/v1", { role: "environment_governor" }],
  ["substrate-lock/v1", { role: "environment_governor", securityTimestampField: "recorded_at" }],
  ["journey-definition/v1", { role: "challenge_governor" }],
  // -- V2 selection chain (ADR-ERL2-020 §2, CONFLICT-ERL2-002) ---------------
  //
  // Derived from each `sealSigned(...)` call site in the shipped producer, not
  // from a fixture. Two rows are `policy_author` rather than the governor: a
  // policy the challenge governor both authored and selected under would
  // collapse the separation the role audit asserts (§2a).
  //
  // These rows land in the same change as the `verifySelectionChain` invocation.
  // Encoding them alone would authorize a signed selection artifact on its
  // signature while its chain position went unverified — strictly weaker than
  // the fail-closed refusal they replace (ADR-ERL2-019 §2).
  ["selection-request/v2", { role: "challenge_governor", securityTimestampField: "requested_at" }],
  [
    "selection-role-separation-audit/v1",
    { role: "challenge_governor", securityTimestampField: "audited_at" },
  ],
  ["journey-selection-policy/v1", { role: "policy_author" }],
  ["external-beacon-randomness-policy/v1", { role: "policy_author" }],
  ["eligibility-pool-manifest/v2", { role: "challenge_governor", securityTimestampField: "created_at" }],
  ["eligibility-pool-entry/v2", { role: "truth_custodian" }],
  [
    // The Lab/verifier association wrapper is sealed under its own domain, so a
    // beacon signature can never be replayed as an association signature.
    "external-beacon-randomness-receipt/v1",
    {
      role: "lab_verifier_association_signer",
      domain: SIGNATURE_DOMAINS.BEACON_ASSOCIATION,
      securityTimestampField: "wrapped_at",
    },
  ],
  [
    "randomness-source-trust-verification-report/v1",
    { role: "confidential_selection_auditor", securityTimestampField: "verified_at" },
  ],
  ["selection-commitment/v2", { role: "selector", securityTimestampField: "committed_at" }],
  [
    "selected-challenge-journey-binding/v1",
    { role: "reveal_service", securityTimestampField: "opened_at" },
  ],
  ["selection-proof/v2", { role: "selector", securityTimestampField: "proved_at" }],
  [
    // ADR-ERL2-020 §3: the auditor's, never the evaluator's. The evaluation
    // authority must not attest that the selection it will be judged against
    // was correctly verified.
    "selection-verification-receipt/v2",
    { role: "confidential_selection_auditor", securityTimestampField: "verified_at" },
  ],
  ["challenge-manifest/v1", { role: "challenge_governor" }],
  // -- V2 environment branch (ADR-ERL2-021) ---------------------------------
  //
  // Derived from each `sealSigned(...)` call site in the shipped environment
  // producer, on the same fail-closed terms as the selection rows: a signed
  // environment contract absent from this table stays refused.
  //
  // The cutoff is derived from three *separately* signed artifacts by design
  // (§13), so they take three different roles. Collapsing them onto one signer
  // would make "wall, monotonic, supervisor and runtime-attestor bounds must
  // agree" a statement about one operator's own bookkeeping.
  [
    // ADR-ERL2-023: the controller's own attestation that it activated the
    // selected challenge. Not `environment_governor`: the governor provisions the
    // environment, the controller decides a challenge goes live in it, and design
    // §12 names them as separate receipts.
    "challenge-activation-receipt/v1",
    { role: "controller", securityTimestampField: "activated_at" },
  ],
  ["comparison-policy/v1", { role: "policy_author" }],
  ["evidence-equivalence-profile/v1", { role: "policy_author" }],
  ["cutoff-policy/v1", { role: "policy_author", securityTimestampField: "valid_from" }],
  [
    "traffic-process-start-receipt/v1",
    { role: "traffic_supervisor", securityTimestampField: "process_started_at" },
  ],
  ["runtime-milestone/v1", { role: "runtime_attestor", securityTimestampField: "occurred_at" }],
  [
    // Not the challenge governor: an exposure event demotes the governor's own
    // challenge, and an authority that can silently record its own demotion is
    // the one thing the exposure ledger exists to prevent.
    "exposure-event/v1",
    { role: "vault_authorizer", securityTimestampField: "occurred_at" },
  ],
  ["journey-step-commitment/v1", { role: "challenge_governor", securityTimestampField: "committed_at" }],
]);

/** The signature object an artifact carries, if any, with the field it came from. */
function signatureOf(
  artifact: IndexedArtifact,
): { readonly field: string; readonly signature: { key_id: string; signed_hash: string } } | undefined {
  for (const field of SIGNATURE_FIELDS) {
    const candidate = artifact.value[field];
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      const signature = candidate as { key_id?: unknown; signed_hash?: unknown };
      if (typeof signature.key_id === "string" && typeof signature.signed_hash === "string") {
        return { field, signature: signature as { key_id: string; signed_hash: string } };
      }
    }
  }
  return undefined;
}

/** A signer-inventory entry, as the verifier reads it (never as authority). */
interface InventoryEntry {
  readonly artifact_core_hash: string;
  readonly artifact_schema_version: string;
  readonly security_timestamp: string;
  readonly signer_key_id: string;
}

export interface SignedMemberOptions {
  readonly index: ArtifactIndex;
  readonly trust: TrustEvaluator;
  /** The terminal's own instant, used when neither the inventory nor the artifact carries one. */
  readonly asOf: string;
  /** The run's signer inventory entries, when the closure retains an inventory. */
  readonly inventoryEntries?: readonly InventoryEntry[];
}

export interface SignedMemberReport {
  readonly membersVerified: number;
  readonly schemaVersions: readonly string[];
}

/**
 * Verifies the signature of every retained signed artifact, and cross-checks the
 * signer inventory against what is actually retained.  Throws a typed refusal on
 * the first failure.
 */
export function verifySignedMembers(options: SignedMemberOptions): SignedMemberReport {
  const { index, trust } = options;
  const entriesByHash = new Map<string, InventoryEntry>();
  for (const entry of options.inventoryEntries ?? []) {
    entriesByHash.set(entry.artifact_core_hash, entry);
  }

  const verified: string[] = [];
  // Every retained *file*, not one representative per core hash.  A signature
  // field is excluded from `core_hash` by design, so two retained files can
  // agree on every hashed byte and disagree on their signatures; enumerating by
  // hash silently verified one of them and let the other ride in unchecked
  // (audit finding: forged signature at the canonical path + a pristine
  // byte-copy under a later-sorting name verified at exit 0 / `valid`).
  for (const artifact of index.retainedFiles()) {
    const found = signatureOf(artifact);
    if (found === undefined) continue;

    const rule = SIGNED_MEMBER_RULES.get(artifact.schemaVersion);
    if (rule === undefined) {
      throw new Erl2Error(
        CODES.TRUST_SIGNATURE_INVALID,
        `retained artifact ${artifact.logicalPath} carries a ${found.field} for ${artifact.schemaVersion}, ` +
          `a contract this verifier declares no authorized signer role for`,
      );
    }

    const entry = entriesByHash.get(artifact.coreHash);
    if (entry !== undefined) {
      // The inventory is evidence, never authority: what it claims about a
      // member must match the member actually retained.
      if (entry.artifact_schema_version !== artifact.schemaVersion) {
        throw new Erl2Error(
          CODES.INVENTORY_ENTRY_MISMATCH,
          `signer inventory declares ${entry.artifact_schema_version} for an artifact that is ${artifact.schemaVersion}`,
        );
      }
      if (entry.signer_key_id !== found.signature.key_id) {
        throw new Erl2Error(
          CODES.INVENTORY_ENTRY_MISMATCH,
          `signer inventory declares signer ${entry.signer_key_id} for ${artifact.logicalPath}, ` +
            `which is signed by ${found.signature.key_id}`,
        );
      }
    }

    const own = rule.securityTimestampField === undefined ? undefined : artifact.value[rule.securityTimestampField];
    const securityTimestamp =
      entry?.security_timestamp ?? (typeof own === "string" ? own : options.asOf);

    // Recomputes the core hash, enforces the signed_hash binding, checks the key
    // is granted this role by the *pinned* policy, verifies the Ed25519 bytes
    // under the signing domain, and evaluates revocation at the security instant.
    trust.verifyRoleSignature({
      value: artifact.value,
      signature: artifact.value[found.field] as Parameters<TrustEvaluator["verifyRoleSignature"]>[0]["signature"],
      role: rule.role,
      schemaVersion: artifact.schemaVersion,
      securityTimestamp,
      ...(rule.domain === undefined ? {} : { domain: rule.domain }),
    });
    verified.push(artifact.schemaVersion);
  }

  // Every inventory entry must name an artifact that is actually retained: an
  // inventory that attests a signer for an absent member is not `complete`.
  for (const entry of options.inventoryEntries ?? []) {
    if (index.tryGet(entry.artifact_core_hash as never) === undefined) {
      throw new Erl2Error(
        CODES.INVENTORY_ENTRY_MISSING,
        `signer inventory names ${entry.artifact_schema_version} at ${entry.artifact_core_hash}, which is not retained`,
      );
    }
  }

  return { membersVerified: verified.length, schemaVersions: [...new Set(verified)].sort() };
}
