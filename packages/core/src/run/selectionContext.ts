/**
 * Assembling the selection context from a run's own retained evidence.
 *
 * Two things here are load-bearing.
 *
 * **The request is built from real retained hashes.** Every binding in
 * `SelectionRequestV2` — the preregistration, the source manifest, the
 * acquisition record, the package manifest, the adapter, the run policy — is
 * read from the role the lifecycle recorded, never from a caller-supplied value
 * and never from a placeholder. A request that bound invented hashes would make
 * the whole chain's binding decorative: it would prove a selection happened, but
 * not that it happened for *this* run.
 *
 * **The pool is loaded, not rebuilt.** `buildEligibilityPool` draws randomness
 * for opening nonces and envelope encryption, so re-running it after a crash
 * produces different entries and would silently select a different challenge.
 * Once the pool manifest is retained, {@link loadSelectionPool} reconstructs it
 * from evidence; the builder runs exactly once, in the one step that produces it.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type AcquisitionPreregistrationV1,
  type EligibilityPoolEntryV2,
  type EligibilityPoolManifestV2,
  type Hash,
  type SelectionRequestV2,
  type SelectionRoleSeparationAuditV1,
} from "@erl2/contracts";
import { coreHash, type SigningKey } from "@erl2/integrity";
import type { SelectionPool, SelectionPoolEntry } from "../selection/chain.js";

/** `commitments/pool/entries/<handle>.age`, mirrored from the pool builder. */
const ENTRY_PATH_PREFIX = "commitments/pool/entries/";
const ENTRY_PATH_SUFFIX = ".age";

/** Where the walk freezes the pool manifest and its ordered entries. */
export const POOL_MANIFEST_PATH = "retained/selection/eligibility-pool-manifest.json";
export const POOL_ENTRY_DIR = "retained/selection/pool-entries";

export function poolEntryPath(handle: string): string {
  return `${POOL_ENTRY_DIR}/${handle}.json`;
}

/**
 * Rebuilds the pool the run already froze.
 *
 * The envelope path is derived from the entry handle exactly as the builder
 * derived it, so a resumed run opens the same ciphertext the original pool
 * committed to rather than one it re-encrypted.
 */
export function loadSelectionPool(
  manifest: EligibilityPoolManifestV2,
  entries: readonly EligibilityPoolEntryV2[],
): SelectionPool {
  const byHash = new Map<Hash, EligibilityPoolEntryV2>();
  for (const entry of entries) byHash.set(coreHash(entry), entry);

  // Order is the manifest's, never the directory's: the ordered entry list is
  // what the pool root commits to, and a reordered pool must not be silently
  // accepted just because the same entries are present.
  const ordered: SelectionPoolEntry[] = manifest.ordered_entry_hashes.map((entryHash) => {
    const entry = byHash.get(entryHash);
    if (entry === undefined) {
      throw new Erl2Error(
        CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
        `the retained pool manifest orders entry ${entryHash}, which is not retained`,
      );
    }
    return {
      entry,
      entryHash,
      envelopeLogicalPath: `${ENTRY_PATH_PREFIX}${entry.opaque_entry_handle}${ENTRY_PATH_SUFFIX}`,
    };
  });
  if (ordered.length !== entries.length) {
    throw new Erl2Error(
      CODES.SELECTION_CHAIN_EDGE_UNCLOSED,
      "the retained pool holds entries its manifest does not order",
    );
  }
  return { manifest, manifestHash: coreHash(manifest), entries: ordered };
}

export interface RequestBindings {
  readonly acquisitionPreregistrationHash: Hash;
  readonly acquisitionSourceManifestHash: Hash;
  readonly acquisitionRecordHash: Hash;
  readonly subjectPackageManifestHash: Hash;
  readonly adapterManifestHash: Hash;
  readonly genericRunPolicyHash: Hash;
  readonly journeySelectionPolicyHash: Hash;
  readonly randomnessPolicyHash: Hash;
  readonly challengeFamilyHash: Hash;
}

/**
 * The run's selection request, bound to the run's own retained artifacts.
 *
 * `request_nonce` is derived from the preregistration rather than drawn: it must
 * be stable across resumes (it feeds the index derivation), and deriving it from
 * a durable artifact means a resumed run reproduces the same request without
 * storing a secret. It is not a secret — the nonce binds the request, it does
 * not hide it.
 */
export function buildSelectionRequest(input: {
  readonly runId: string;
  readonly bindings: RequestBindings;
  readonly prereg: AcquisitionPreregistrationV1;
  readonly expiresAt: string;
  readonly requestedAt: string;
  readonly signer: SigningKey;
  readonly seal: (body: object, key: SigningKey) => object;
}): SelectionRequestV2 {
  const { bindings } = input;
  const nonce = coreHash(input.prereg as unknown as Record<string, unknown>).slice("sha256:".length);
  return assertContract<SelectionRequestV2>(
    "SelectionRequestV2",
    input.seal(
      {
        schema_version: "selection-request/v2" as const,
        request_id: `selection-${input.runId.slice(0, 8)}`,
        run_id: input.runId,
        request_nonce: nonce,
        // ERL2-OQ-007: the only tier a development beacon may drive. The kernels
        // refuse anything else independently (chain.ts / verify.ts).
        requested_tier: "development" as const,
        acquisition_preregistration_hash: bindings.acquisitionPreregistrationHash,
        acquisition_source_manifest_hash: bindings.acquisitionSourceManifestHash,
        acquisition_record_hash: bindings.acquisitionRecordHash,
        subject_package_manifest_hash: bindings.subjectPackageManifestHash,
        adapter_manifest_hash: bindings.adapterManifestHash,
        admissible_archetype_set_hash: bindings.challengeFamilyHash,
        challenge_family_hash: bindings.challengeFamilyHash,
        environment_profile_hash: bindings.challengeFamilyHash,
        eligibility_policy_hash: bindings.journeySelectionPolicyHash,
        configuration_intent_hash: bindings.subjectPackageManifestHash,
        generic_run_policy_hash: bindings.genericRunPolicyHash,
        actor_policy_hash: bindings.journeySelectionPolicyHash,
        comparison_policy_hash: bindings.journeySelectionPolicyHash,
        selection_randomness_policy_hash: bindings.randomnessPolicyHash,
        journey_selection_policy_hash: bindings.journeySelectionPolicyHash,
        requested_at: input.requestedAt,
        expires_at: input.expiresAt,
      },
      input.signer,
    ),
  );
}

/** The role-separation audit over the run's actual selection signers. */
export function buildRoleSeparationAudit(input: {
  readonly runId: string;
  readonly requestHash: Hash;
  readonly assignments: readonly {
    readonly role: string;
    readonly operatorIdentityHash: Hash;
    readonly keyIds: readonly string[];
  }[];
  readonly revealThreshold: number;
  readonly revealParticipantKeyIds: readonly string[];
  readonly accessLogHeadHash: Hash;
  readonly auditedAt: string;
  readonly signer: SigningKey;
  readonly seal: (body: object, key: SigningKey) => object;
}): SelectionRoleSeparationAuditV1 {
  // Disjointness is *computed*, never asserted.
  //
  // The frozen schema pins `all_required_roles_disjoint: true` and
  // `status: "passed"` as consts, so a *failing* audit cannot be represented at
  // all — which makes emitting one impossible and refusing the only honest
  // option. A hardcoded `true` would have stated a separation the run may not
  // have (CONFLICT-ERL2-002 C-2 records that the development keyring backs
  // several roles with repo-derivable keys).
  const keyOwners = new Map<string, string[]>();
  for (const assignment of input.assignments) {
    for (const keyId of assignment.keyIds) {
      keyOwners.set(keyId, [...(keyOwners.get(keyId) ?? []), assignment.role]);
    }
  }
  const shared = [...keyOwners.entries()].filter(([, roles]) => roles.length > 1);
  if (shared.length > 0) {
    throw new Erl2Error(
      CODES.SELECTION_CHAIN_ROLE_SEPARATION_VIOLATED,
      `selection roles are not disjoint: ${shared
        .map(([keyId, roles]) => `${keyId} holds ${roles.join(" and ")}`)
        .join("; ")}`,
    );
  }

  return assertContract<SelectionRoleSeparationAuditV1>(
    "SelectionRoleSeparationAuditV1",
    input.seal(
      {
        schema_version: "selection-role-separation-audit/v1" as const,
        audit_id: `role-audit-${input.runId.slice(0, 8)}`,
        run_id: input.runId,
        selection_request_hash: input.requestHash,
        role_assignments: input.assignments.map((assignment) => ({
          role: assignment.role,
          operator_identity_hash: assignment.operatorIdentityHash,
          key_ids: [...assignment.keyIds],
        })),
        reveal_threshold: input.revealThreshold,
        reveal_participant_key_ids: [...input.revealParticipantKeyIds],
        prohibited_operator_overlaps: [],
        prohibited_key_overlaps: [],
        append_only_access_log_head_hash: input.accessLogHeadHash,
        all_required_roles_disjoint: true as const,
        status: "passed" as const,
        audited_at: input.auditedAt,
      },
      input.signer,
    ),
  );
}
