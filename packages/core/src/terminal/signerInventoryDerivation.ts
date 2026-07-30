/**
 * The **producer's own** derivation of a terminal chain's applicable signed
 * members (ADR-ERL2-030 §4).
 *
 * ## What this replaces
 *
 * `RunWorkspace.signerInventoryEntries` read `artifact.value["signature"]`
 * literally. Three things followed from that one line:
 *
 *   - a member whose authority field is `root_signature` — the mirrored trust
 *     policy, retained by every run — was omitted by construction, and so was
 *     the `wrapper_signature` member on the environment branch (the beacon
 *     association wrapper). Measured on a real environment terminal: 66 retained
 *     signed members, 63 applicable, **61** listed, and those were the two;
 *   - the enumeration was the whole run root keyed by core hash, so it was
 *     neither scoped to the retained subtree nor able to see two retained files
 *     agreeing on a hash and disagreeing on their authority;
 *   - `complete_for_terminal_chain: true as const` was written regardless, so
 *     the inventory's central claim was a schema constant rather than a result.
 *
 * The derivation here is the result that constant was standing in for. It walks
 * the retained subtree, resolves each artifact's authority field **from the
 * frozen schema that declares it** — never from a property name containing
 * "signature" — refuses a signed contract this producer declares no signer role
 * for, and returns the applicable set together with the evidence that it is
 * complete. `buildPreEnvironmentSignerInventory` and its environment sibling
 * then refuse to seal anything the derivation did not certify.
 *
 * ## Why the table below is not the verifier's
 *
 * ADR-ERL2-030 §5 requires the producer and the offline verifier to derive the
 * applicable set **independently**. A shared derivation would make the
 * verifier's agreement with the producer a tautology — the identical defect
 * ADR-ERL2-024 named for `lab_validity` and ADR-ERL2-029 §1.1 named for
 * `complete_for_terminal_chain`. The two tables are therefore written
 * separately: this one from each `sealSigned(…)` call site in the shipped
 * producer plus the two contracts a run *mirrors* rather than creates, the
 * verifier's from the contracts it is willing to authorize.
 * `tests/architecture/signerInventoryIndependence.test.ts` asserts both that
 * they agree and that neither package imports the other's.
 *
 * What *is* shared is exactly what §5 permits: frozen contract identities,
 * `signedSchemaAuthorityFields()` (derived from the frozen schema bundles, so
 * which field carries authority is not a second opinion), and canonical hashing.
 */

import {
  AUTHORITY_SIGNATURE_FIELDS,
  CODES,
  Erl2Error,
  signedSchemaAuthorityFields,
  type Hash,
  type Instant,
} from "@erl2/contracts";
import type { SignerInventoryEntryInput } from "./finalize.js";

/**
 * Every signed contract the shipped producer can retain in a terminal chain, and
 * the role that signs it.
 *
 * Derived from each `sealSigned(…)` call site in `@erl2/core`, plus the two
 * contracts a run *mirrors* rather than creates: the trust policy manifest
 * (signed by the trust root under `root_signature`) and the registry-supplied
 * policies, manifests and journey definitions admitted at preregistration.
 *
 * A retained artifact that carries an authority-bearing signature and whose
 * `schema_version` is absent from this table is a **refusal**, never a silent
 * omission: a signed contract the producer cannot classify must not be able to
 * ride into a terminal chain unlisted, which is precisely how the wrapper-signed
 * beacon receipt travelled for four packages.
 */
export const PRODUCER_SIGNED_MEMBER_ROLES: ReadonlyMap<string, string> = new Map([
  // -- trust and time --------------------------------------------------------
  ["trust-policy-manifest/v2", "trust_root"],
  ["trusted-timestamp-checkpoint/v1", "timestamp_authority"],
  // -- the terminal chain itself --------------------------------------------
  ["signer-inventory/v2", "final_attestation_signer"],
  ["pre-environment-final-lab-attestation/v1", "final_attestation_signer"],
  ["environment-final-lab-attestation/v1", "final_attestation_signer"],
  ["cancellation-request/v1", "final_attestation_signer"],
  // -- acquisition ----------------------------------------------------------
  ["acquisition-source-manifest/v1", "policy_author"],
  ["generic-run-policy/v1", "policy_author"],
  ["acquisition-preregistration/v1", "preregistrar"],
  ["acquisition-preregistration-verification-receipt/v1", "preregistrar"],
  ["subject-adapter-manifest/v1", "adapter_owner"],
  ["subject-package-manifest/v1", "adapter_owner"],
  // -- environment ----------------------------------------------------------
  ["environment-driver-manifest/v1", "environment_governor"],
  ["substrate-binding/v1", "environment_governor"],
  ["restoration-probe/v1", "environment_governor"],
  ["environment-archetype/v1", "environment_governor"],
  ["environment-cleanup-contract/v1", "environment_governor"],
  ["substrate-lock/v1", "environment_governor"],
  // -- selection ------------------------------------------------------------
  ["journey-definition/v1", "challenge_governor"],
  ["selection-request/v2", "challenge_governor"],
  ["selection-role-separation-audit/v1", "challenge_governor"],
  ["journey-selection-policy/v1", "policy_author"],
  ["external-beacon-randomness-policy/v1", "policy_author"],
  ["eligibility-pool-manifest/v2", "challenge_governor"],
  ["eligibility-pool-entry/v2", "truth_custodian"],
  ["external-beacon-randomness-receipt/v1", "lab_verifier_association_signer"],
  ["randomness-source-trust-verification-report/v1", "confidential_selection_auditor"],
  ["selection-commitment/v2", "selector"],
  ["selected-challenge-journey-binding/v1", "reveal_service"],
  ["selection-proof/v2", "selector"],
  ["selection-verification-receipt/v2", "confidential_selection_auditor"],
  ["challenge-manifest/v1", "challenge_governor"],
  // -- capture --------------------------------------------------------------
  ["challenge-activation-receipt/v1", "controller"],
  ["comparison-policy/v1", "policy_author"],
  ["evidence-equivalence-profile/v1", "policy_author"],
  ["cutoff-policy/v1", "policy_author"],
  ["traffic-process-start-receipt/v1", "traffic_supervisor"],
  ["runtime-milestone/v1", "runtime_attestor"],
  ["exposure-event/v1", "vault_authorizer"],
  ["journey-step-commitment/v1", "challenge_governor"],
]);

/**
 * The inventory can never carry an entry for itself.
 *
 * An entry names an artifact by `core_hash`, so an entry for the inventory would
 * change the very hash the entry names: the applicable set has no fixpoint that
 * includes it. ADR-ERL2-029 §4.1 stated the applicable set with three conditions
 * and omitted this one; ADR-ERL2-030 §3.2 closes that gap rather than treating
 * it as licence to omit anything else.
 */
export const SELF_REFERENTIAL_INVENTORY_SCHEMA = "signer-inventory/v2";

/** A retained artifact as this derivation sees it. */
export interface RetainedArtifactView {
  /** Root-relative path — diagnostics, and proof the artifact is under `retained/`. */
  readonly logicalPath: string;
  readonly coreHash: Hash;
  readonly schemaVersion: string;
  readonly value: Record<string, unknown>;
}

export interface DerivedSignedMember {
  readonly logicalPath: string;
  readonly coreHash: Hash;
  readonly schemaVersion: string;
  readonly signerRole: string;
  readonly signatureField: string;
  readonly signerKeyId: string;
  readonly signatureSha256: Hash;
}

export interface SignerInventoryDerivation {
  /** Every retained file carrying an authority-bearing signature. */
  readonly retainedSignedMembers: readonly DerivedSignedMember[];
  /** The applicable subset, in the order the inventory must list it. */
  readonly applicableMembers: readonly DerivedSignedMember[];
  /** What the acyclic boundary removed, and why. */
  readonly excludedMembers: readonly {
    readonly coreHash: Hash;
    readonly schemaVersion: string;
    readonly reason: string;
  }[];
  /**
   * Derived, never asserted: `true` exactly when every applicable member is
   * represented once and nothing else is.
   */
  readonly completeForTerminalChain: boolean;
}

/**
 * The authority-bearing signature an artifact carries, if any.
 *
 * Authority comes from the **registered contract**: the schema version must
 * legally declare the field (`signedSchemaAuthorityFields()`, derived from the
 * frozen schema bundles). A signature-shaped object on a contract that does not
 * declare it is refused rather than inventoried — a schema must not be able to
 * smuggle an unhashed authority claim into a terminal chain.
 */
function authoritySignatureOf(
  artifact: RetainedArtifactView,
): { readonly field: string; readonly keyId: string; readonly signedHash: Hash } | undefined {
  const declared = signedSchemaAuthorityFields().get(artifact.schemaVersion);
  let found: { field: string; keyId: string; signedHash: Hash } | undefined;
  for (const field of AUTHORITY_SIGNATURE_FIELDS) {
    const candidate = artifact.value[field];
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const signature = candidate as {
      key_id?: unknown;
      signed_hash?: unknown;
      algorithm?: unknown;
      signature_base64?: unknown;
    };
    if (typeof signature.key_id !== "string" || typeof signature.signed_hash !== "string") continue;
    if (declared === undefined || !declared.has(field)) {
      throw new Erl2Error(
        CODES.TRUST_SIGNATURE_INVALID,
        `retained artifact ${artifact.logicalPath} carries a ${field} for ${artifact.schemaVersion}, ` +
          `a contract that does not declare that authority field`,
      );
    }
    if (found !== undefined) {
      throw new Erl2Error(
        CODES.TRUST_SIGNATURE_INVALID,
        `retained artifact ${artifact.logicalPath} carries both a ${found.field} and a ${field}; ` +
          `a contract has exactly one authority`,
      );
    }
    if (
      signature.key_id.length === 0 ||
      signature.algorithm !== "Ed25519" ||
      typeof signature.signature_base64 !== "string" ||
      Buffer.from(signature.signature_base64, "base64").byteLength !== 64
    ) {
      throw new Erl2Error(
        CODES.TRUST_SIGNATURE_INVALID,
        `retained artifact ${artifact.logicalPath} carries a malformed ${field}`,
      );
    }
    if (signature.signed_hash !== artifact.coreHash) {
      throw new Erl2Error(
        CODES.TRUST_SIGNATURE_INVALID,
        `retained artifact ${artifact.logicalPath} carries a ${field} over a different core hash`,
      );
    }
    found = { field, keyId: signature.key_id, signedHash: signature.signed_hash as Hash };
  }
  return found;
}

/**
 * Derives the applicable signed members of a terminal chain from the retained
 * evidence, fail-closed at every step.
 *
 * `excludedPublicTerminalTypes` is the branch's own acyclic boundary — the
 * public terminal types the bundle already carries, which are sealed *after* the
 * inventory. The inventory's own schema is always excluded, for the fixpoint
 * reason in {@link SELF_REFERENTIAL_INVENTORY_SCHEMA}.
 *
 * Cryptographic authorization is deliberately **not** performed here. The
 * producer proves the set is complete and each signature binds the artifact it
 * sits on; whether a key may hold a role is re-decided by the offline verifier
 * under its own pinned trust policy, so the two never share a trust evaluation.
 */
export function deriveSignedMembers(input: {
  readonly retained: readonly RetainedArtifactView[];
  readonly excludedPublicTerminalTypes: readonly string[];
}): SignerInventoryDerivation {
  const excluded = new Set<string>([
    ...input.excludedPublicTerminalTypes,
    SELF_REFERENTIAL_INVENTORY_SCHEMA,
  ]);
  const retainedSignedMembers: DerivedSignedMember[] = [];
  const applicable: DerivedSignedMember[] = [];
  const excludedMembers: { coreHash: Hash; schemaVersion: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const artifact of input.retained) {
    const found = authoritySignatureOf(artifact);
    if (found === undefined) continue;

    const role = PRODUCER_SIGNED_MEMBER_ROLES.get(artifact.schemaVersion);
    if (role === undefined) {
      throw new Erl2Error(
        CODES.TRUST_SIGNATURE_INVALID,
        `retained artifact ${artifact.logicalPath} carries a ${found.field} for ${artifact.schemaVersion}, ` +
          `a contract this producer declares no signer role for; a terminal chain cannot inventory it`,
      );
    }
    const member: DerivedSignedMember = {
      logicalPath: artifact.logicalPath,
      coreHash: artifact.coreHash,
      schemaVersion: artifact.schemaVersion,
      signerRole: role,
      signatureField: found.field,
      signerKeyId: found.keyId,
      signatureSha256: found.signedHash,
    };
    retainedSignedMembers.push(member);

    if (excluded.has(artifact.schemaVersion)) {
      excludedMembers.push({
        coreHash: artifact.coreHash,
        schemaVersion: artifact.schemaVersion,
        reason:
          artifact.schemaVersion === SELF_REFERENTIAL_INVENTORY_SCHEMA
            ? "the inventory cannot vouch for itself"
            : "a public terminal type the bundle carries, sealed after the inventory",
      });
      continue;
    }
    if (seen.has(artifact.coreHash)) {
      throw new Erl2Error(
        CODES.INVENTORY_ENTRY_EXTRA,
        `two retained files claim core hash ${artifact.coreHash}; an inventoried member identifies ` +
          `exactly one retained file`,
      );
    }
    seen.add(artifact.coreHash);
    applicable.push(member);
  }

  // Deterministic and independent of walk order, so the inventory's bytes never
  // depend on how the retained subtree happened to be named.
  const ordered = [...applicable].sort((a, b) => a.coreHash.localeCompare(b.coreHash));
  return {
    retainedSignedMembers,
    applicableMembers: ordered,
    excludedMembers,
    // Derived from the actual set: complete exactly when every applicable member
    // reached the ordered list once, which the duplicate refusal above makes a
    // bijection, and when the terminal has at least one member to inventory.
    completeForTerminalChain: ordered.length === seen.size && ordered.length > 0,
  };
}

/**
 * Requires a set of already-built entries to still be exactly the applicable set
 * a later derivation produces.
 *
 * The inventory is sealed *before* the finalization gate, and between those two
 * points a retained signed artifact can appear — at which point an inventory that
 * was complete when it was written is not complete any more. Re-deriving is what
 * makes "the producer refuses rather than signing an incomplete inventory" a
 * statement about the *sealed bytes* rather than about a value computed earlier.
 */
export function assertInventoryCoversDerivation(
  entries: readonly SignerInventoryEntryInput[],
  derivation: SignerInventoryDerivation,
): void {
  const listed = new Set(entries.map((entry) => entry.artifactCoreHash as string));
  const missing = derivation.applicableMembers.filter((member) => !listed.has(member.coreHash));
  if (missing.length > 0 || !derivation.completeForTerminalChain) {
    throw new Erl2Error(
      CODES.INVENTORY_ENTRY_MISSING,
      `finalization refused: ${String(missing.length)} applicable signed member(s) are not covered by ` +
        `the sealed signer inventory: ${missing.map((m) => `${m.schemaVersion}@${m.coreHash}`).join(", ")}`,
    );
  }
  const applicable = new Set(derivation.applicableMembers.map((member) => member.coreHash as string));
  const extra = [...listed].filter((hash) => !applicable.has(hash));
  if (extra.length > 0) {
    throw new Erl2Error(
      CODES.INVENTORY_ENTRY_EXTRA,
      `finalization refused: the sealed signer inventory lists ${String(extra.length)} member(s) the ` +
        `retained evidence does not make applicable: ${extra.join(", ")}`,
    );
  }
}

/** Projects the derived applicable set onto the frozen inventory entry shape. */
export function signerInventoryEntriesFrom(
  derivation: SignerInventoryDerivation,
  stamp: {
    readonly securityTimestamp: Instant;
    readonly timestampLogId: string;
    readonly timestampSequence: number;
  },
): readonly SignerInventoryEntryInput[] {
  return derivation.applicableMembers.map((member) => ({
    artifactSchemaVersion: member.schemaVersion,
    artifactCoreHash: member.coreHash,
    signerKeyId: member.signerKeyId,
    signatureSha256: member.signatureSha256,
    securityTimestamp: stamp.securityTimestamp,
    timestampLogId: stamp.timestampLogId,
    timestampSequence: stamp.timestampSequence,
  }));
}
