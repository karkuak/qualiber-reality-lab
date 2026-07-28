/**
 * Development-only key material and locally pinned trust configuration.
 *
 * Every key here is deterministically derived from a public label, so nothing
 * in this repository is a production secret.  Roles are separated exactly as
 * `SelectionRoleSeparationAuditV1` requires; a fixture that reuses one key
 * across two selection roles is expected to fail admission.
 */

import {
  coreHash,
  developmentCustodian,
  developmentKey,
  publicKeyToPem,
  sealSigned,
  SIGNATURE_DOMAINS,
  type CustodianKey,
  type LocalRandomnessSourceEntry,
  type LocalTrustConfiguration,
  type SigningKey,
} from "@erl2/integrity";
import { assertContract, type Hash, type TrustPolicyManifestV2 } from "@erl2/contracts";

export const VALID_FROM = "2026-01-01T00:00:00Z";
export const VALID_UNTIL = "2030-01-01T00:00:00Z";

export interface DevelopmentKeyring {
  readonly root: SigningKey;
  readonly timestampAuthority: SigningKey;
  readonly preregistrar: SigningKey;
  readonly policyAuthor: SigningKey;
  readonly challengeGovernor: SigningKey;
  readonly selector: SigningKey;
  readonly wrapperSigner: SigningKey;
  readonly sourceTrustVerifier: SigningKey;
  readonly revealAuthority: SigningKey;
  readonly evaluator: SigningKey;
  readonly finalizer: SigningKey;
  readonly adapterOwner: SigningKey;
  readonly entrySigner: SigningKey;
  /** Environment-branch roles (Slice 6.5-B/E, ADR-ERL2-021, ADR-ERL2-023). */
  readonly controller: SigningKey;
  readonly trafficSupervisor: SigningKey;
  readonly runtimeAttestor: SigningKey;
  readonly vaultAuthorizer: SigningKey;
  readonly custodianSigners: readonly SigningKey[];
  readonly custodians: readonly CustodianKey[];
}

export function developmentKeyring(): DevelopmentKeyring {
  return {
    root: developmentKey("root"),
    timestampAuthority: developmentKey("timestamp"),
    preregistrar: developmentKey("preregistrar"),
    policyAuthor: developmentKey("policy-author"),
    challengeGovernor: developmentKey("challenge-governor"),
    selector: developmentKey("selector"),
    wrapperSigner: developmentKey("lab-verifier"),
    sourceTrustVerifier: developmentKey("source-trust-verifier"),
    revealAuthority: developmentKey("reveal-authority"),
    evaluator: developmentKey("evaluator"),
    finalizer: developmentKey("finalizer"),
    adapterOwner: developmentKey("adapter-owner"),
    entrySigner: developmentKey("entry-signer"),
    controller: developmentKey("controller"),
    trafficSupervisor: developmentKey("traffic-supervisor"),
    runtimeAttestor: developmentKey("runtime-attestor"),
    vaultAuthorizer: developmentKey("vault-authorizer"),
    custodianSigners: [
      developmentKey("custodian-a"),
      developmentKey("custodian-b"),
      developmentKey("custodian-c"),
    ],
    custodians: [
      developmentCustodian("a"),
      developmentCustodian("b"),
      developmentCustodian("c"),
    ],
  };
}

type Role = TrustPolicyManifestV2["keys"][number]["signer_roles"][number];

function keyEntry(key: SigningKey, roles: readonly Role[]) {
  return {
    key_id: key.keyId,
    public_key_pem: publicKeyToPem(key.publicKey),
    signer_roles: [...roles],
    permitted_contract_types: [] as string[],
    permitted_encryption_recipient_ids: [] as string[],
    valid_from: VALID_FROM,
    valid_until: VALID_UNTIL,
    status: "active" as const,
    tiers: ["development"] as const,
  };
}

export function developmentTrustPolicy(keyring: DevelopmentKeyring): TrustPolicyManifestV2 {
  const base = {
    schema_version: "trust-policy-manifest/v2" as const,
    manifest_id: "erl2-development-trust",
    version: 1,
    issued_at: VALID_FROM,
    keys: [
      keyEntry(keyring.root, ["trust_root"]),
      keyEntry(keyring.timestampAuthority, ["timestamp_authority"]),
      keyEntry(keyring.preregistrar, ["preregistrar"]),
      keyEntry(keyring.policyAuthor, ["policy_author"]),
      keyEntry(keyring.challengeGovernor, ["challenge_governor", "environment_governor"]),
      keyEntry(keyring.selector, ["selector"]),
      keyEntry(keyring.wrapperSigner, ["lab_verifier_association_signer"]),
      keyEntry(keyring.sourceTrustVerifier, ["confidential_selection_auditor"]),
      keyEntry(keyring.revealAuthority, ["reveal_service"]),
      keyEntry(keyring.evaluator, ["evaluator"]),
      keyEntry(keyring.finalizer, ["final_attestation_signer"]),
      keyEntry(keyring.adapterOwner, ["adapter_owner"]),
      keyEntry(keyring.entrySigner, ["truth_custodian"]),
      // The environment branch's three independently signing roles. They are
      // separate keys, not aliases of the governor: the cutoff must be checkable
      // without trusting any one of them, and the exposure record must not be
      // issued by the authority whose challenge it demotes.
      keyEntry(keyring.controller, ["controller"]),
      keyEntry(keyring.trafficSupervisor, ["traffic_supervisor"]),
      keyEntry(keyring.runtimeAttestor, ["runtime_attestor"]),
      keyEntry(keyring.vaultAuthorizer, ["vault_authorizer"]),
      ...keyring.custodianSigners.map((k) => keyEntry(k, ["reveal_custodian"])),
    ],
    revocations: [] as never[],
    root_key_id: keyring.root.keyId,
  };
  return assertContract<TrustPolicyManifestV2>(
    "TrustPolicyManifestV2",
    sealSigned(base, keyring.root, SIGNATURE_DOMAINS.LEGACY_V1, "root_signature"),
  );
}

export function localTrustConfiguration(
  policy: TrustPolicyManifestV2,
  keyring: DevelopmentKeyring,
  randomnessSources: readonly LocalRandomnessSourceEntry[],
  registryHead: Hash,
): LocalTrustConfiguration {
  return {
    rootKeyIds: [keyring.root.keyId],
    currentTrustHeadHash: coreHash(policy),
    randomnessSources: [...randomnessSources],
    randomnessRegistryHeadHash: registryHead,
  };
}
