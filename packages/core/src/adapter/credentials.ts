/**
 * Credential handles (design v2 §21, ERL2-SEC-001, ERL2-AC-011).
 *
 * A credential never crosses the adapter boundary as plaintext. The adapter
 * asks for a *handle* naming scopes, a target and a TTL; the broker narrows the
 * request to what its policy allows, records requested, granted and denied
 * scopes separately, and binds the grant to one run, one adapter, one operation
 * and one target. Every use is receipted, and a use outside scope, after
 * expiry, past the use cap, from another run, adapter or target is denied.
 *
 * The broker holds no secret material here at all: resolving a handle to an
 * actual credential is the deployment profile's job and happens outside this
 * process. What this module owns is the authorization decision and its
 * evidence, which is the part that must be verifiable offline.
 */

import {
  assertContract,
  CODES,
  Erl2Error,
  type CredentialHandleGrantV1,
  type CredentialHandleRequestV1,
  type CredentialUseReceiptV1,
  type Hash,
  type Instant,
} from "@erl2/contracts";
import { coreHash, domainHash, HASH_DOMAINS } from "@erl2/integrity";

/** Scopes a development deployment profile is willing to grant. */
export interface CredentialScopePolicy {
  readonly policyId: string;
  readonly grantableScopeIds: readonly string[];
  readonly maxTtlSeconds: number;
  readonly maxUses: number;
}

export const DEVELOPMENT_CREDENTIAL_POLICY: CredentialScopePolicy = {
  policyId: "development-credential-policy",
  grantableScopeIds: ["subject-registry-read", "subject-docs-read"],
  maxTtlSeconds: 300,
  maxUses: 4,
};

export function credentialTargetHash(runId: string, targetDescriptor: string): Hash {
  return domainHash(HASH_DOMAINS.RESOURCE_IDENTITY, {
    kind: "credential-target",
    run_id: runId,
    descriptor: targetDescriptor,
  });
}

interface HandleState {
  readonly grant: CredentialHandleGrantV1;
  readonly runId: string;
  readonly adapterManifestHash: Hash;
  readonly expiresAtMs: number;
  uses: number;
}

export interface IssueHandleOptions {
  readonly runId: string;
  readonly operationId: string;
  readonly adapterManifestHash: Hash;
  readonly handleRequestId: string;
  readonly credentialReferenceKind:
    | "development-keychain-reference"
    | "workload-identity-reference"
    | "short-lived-token-reference";
  readonly requestedScopeIds: readonly string[];
  readonly requestedTtlSeconds: number;
  readonly requestedMaxUses: number;
  readonly targetDescriptor: string;
  readonly purposeCode: string;
  readonly now: Instant;
}

export interface IssuedHandle {
  readonly request: CredentialHandleRequestV1;
  readonly grant: CredentialHandleGrantV1;
}

export class CredentialBroker {
  private readonly policy: CredentialScopePolicy;
  private readonly handles = new Map<string, HandleState>();
  private sequence = 0;

  constructor(policy: CredentialScopePolicy = DEVELOPMENT_CREDENTIAL_POLICY) {
    this.policy = policy;
  }

  /**
   * Records the request as the adapter made it, then issues a grant narrowed to
   * policy. An over-broad request is not an error — it is narrowed, and the
   * excess appears in `denied_scope_ids` so the over-reach stays visible.
   */
  issue(options: IssueHandleOptions): IssuedHandle {
    if (options.requestedScopeIds.length === 0) {
      throw new Erl2Error(
        CODES.SECRET_CREDENTIAL_SCOPE_EXCEEDED,
        "a credential handle request must name at least one scope",
        { owner: "adapter" },
      );
    }
    const ttl = Math.min(options.requestedTtlSeconds, this.policy.maxTtlSeconds);
    const maxUses = Math.min(options.requestedMaxUses, this.policy.maxUses);
    const boundTarget = credentialTargetHash(options.runId, options.targetDescriptor);

    const requestBase = {
      schema_version: "credential-handle-request/v1" as const,
      run_id: options.runId,
      operation_id: options.operationId,
      handle_request_id: options.handleRequestId,
      credential_reference_kind: options.credentialReferenceKind,
      requested_scope_ids: [...options.requestedScopeIds],
      requested_ttl_seconds: options.requestedTtlSeconds,
      requested_max_uses: options.requestedMaxUses,
      bound_target_hash: boundTarget,
      purpose_code: options.purposeCode,
      requested_at: options.now,
    };
    const request = assertContract<CredentialHandleRequestV1>("CredentialHandleRequestV1", {
      ...requestBase,
      core_hash: coreHash(requestBase),
    });

    const granted = options.requestedScopeIds.filter((s) =>
      this.policy.grantableScopeIds.includes(s),
    );
    const denied = options.requestedScopeIds.filter(
      (s) => !this.policy.grantableScopeIds.includes(s),
    );
    this.sequence += 1;
    const handleId = `handle-${String(this.sequence).padStart(4, "0")}`;
    const issuedAtMs = Date.parse(options.now);
    const expiresAtMs = issuedAtMs + ttl * 1000;

    const grantBase = {
      schema_version: "credential-handle-grant/v1" as const,
      run_id: options.runId,
      operation_id: options.operationId,
      handle_id: handleId,
      handle_request_hash: request.core_hash,
      adapter_manifest_hash: options.adapterManifestHash,
      requested_scope_ids: [...options.requestedScopeIds],
      granted_scope_ids: granted,
      denied_scope_ids: denied,
      ...(denied.length === 0
        ? {}
        : { denial_codes: denied.map(() => CODES.SECRET_CREDENTIAL_SCOPE_EXCEEDED) }),
      bound_target_hash: boundTarget,
      max_uses: maxUses,
      issued_at: options.now,
      expires_at: new Date(expiresAtMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    const grant = assertContract<CredentialHandleGrantV1>("CredentialHandleGrantV1", {
      ...grantBase,
      core_hash: coreHash(grantBase),
    });

    this.handles.set(handleId, {
      grant,
      runId: options.runId,
      adapterManifestHash: options.adapterManifestHash,
      expiresAtMs,
      uses: 0,
    });
    return { request, grant };
  }

  /**
   * Adjudicates one use. Every denial is receipted rather than thrown away, so
   * a replay attempt is evidence rather than a gap.
   */
  use(options: {
    readonly runId: string;
    readonly operationId: string;
    readonly adapterManifestHash: Hash;
    readonly handleId: string;
    readonly scopeId: string;
    readonly targetDescriptor: string;
    readonly now: Instant;
  }): CredentialUseReceiptV1 {
    const state = this.handles.get(options.handleId);
    if (!state) {
      throw new Erl2Error(
        CODES.SECRET_CREDENTIAL_HANDLE_UNKNOWN,
        `credential handle ${options.handleId.slice(0, 64)} was never issued`,
        { owner: "adapter" },
      );
    }
    const target = credentialTargetHash(options.runId, options.targetDescriptor);
    state.uses += 1;

    const denialCode = ((): string | undefined => {
      if (state.runId !== options.runId) return CODES.SECRET_CREDENTIAL_HANDLE_WRONG_RUN;
      if (state.adapterManifestHash !== options.adapterManifestHash) {
        return CODES.SECRET_CREDENTIAL_HANDLE_WRONG_RUN;
      }
      if (Date.parse(options.now) >= state.expiresAtMs) {
        return CODES.SECRET_CREDENTIAL_HANDLE_EXPIRED;
      }
      if (state.uses > state.grant.max_uses) return CODES.SECRET_CREDENTIAL_HANDLE_REPLAYED;
      if (!state.grant.granted_scope_ids.includes(options.scopeId)) {
        return CODES.SECRET_CREDENTIAL_SCOPE_EXCEEDED;
      }
      if (state.grant.bound_target_hash !== target) {
        return CODES.SECRET_CREDENTIAL_SCOPE_EXCEEDED;
      }
      return undefined;
    })();

    const base = {
      schema_version: "credential-use-receipt/v1" as const,
      run_id: options.runId,
      operation_id: options.operationId,
      handle_id: options.handleId,
      grant_hash: state.grant.core_hash,
      adapter_manifest_hash: options.adapterManifestHash,
      used_scope_id: options.scopeId,
      target_identity_hash: target,
      use_index: Math.min(state.uses, 64),
      decision: (denialCode === undefined ? "allowed" : "denied") as "allowed" | "denied",
      ...(denialCode === undefined ? {} : { denial_code: denialCode }),
      used_at: options.now,
    };
    return assertContract<CredentialUseReceiptV1>("CredentialUseReceiptV1", {
      ...base,
      core_hash: coreHash(base),
    });
  }

  /** Every handle this broker issued, for residue and closure reporting. */
  issuedHandleIds(): readonly string[] {
    return [...this.handles.keys()].sort();
  }
}
